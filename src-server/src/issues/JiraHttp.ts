/* =============================================================================
   CLIENT HTTP JIRA CLOUD — brique d'accès réseau du module `issues/` (amovible),
   partie SPÉCIFIQUE À LA MARQUE (préfixe `Jira*`).

   Auth BASIC sur l'API REST officielle : en-tête
   `Authorization: Basic base64(<compte>:<jeton d'API>)`, où `<compte>` est
   l'adresse e-mail du compte Atlassian. Aucune session, aucun cookie.

   ── POURQUOI `fetch` INJECTÉ ET NON `node:https` + `trustOptions` ─────────────
   ÉCART DÉLIBÉRÉ avec `vm/PveHttp` et `wifi/UnifiHttp`. Le montage `node:https`
   n'existe là-bas que pour une raison précise : les consoles Proxmox/UniFi
   auto-hébergées sont massivement en certificat AUTO-SIGNÉ, et le `fetch` de Node
   n'offre aucun moyen — sans dépendance — de fournir une CA ou d'épingler une
   empreinte PAR REQUÊTE. Jira Cloud est un service PUBLIC à certificat VALIDE :
   il n'y a rien à épingler, rien à faire confiance à la main. On reprend donc le
   patron `notify/WebhookNotifier` : `fetch` INJECTÉ (stub en test, zéro réseau) +
   `AbortSignal.timeout`. Moins de code, et un précédent déjà en production.
   ⚠ Corollaire : ce client ne SAIT PAS gérer un certificat privé. Un tracker
   AUTO-HÉBERGÉ (Jira Data Center et son auth `Bearer <PAT>`) entrera comme un
   adaptateur DISTINCT, qui reprendra `trustOptions` chez lui.

   ── DÉBIT (429) ──────────────────────────────────────────────────────────────
   Jira Cloud limite le débit et répond 429 avec un en-tête `Retry-After`. On
   respecte l'attente demandée, BORNÉE des deux côtés (cf. les constantes), sur un
   petit nombre de tentatives, puis on abandonne PROPREMENT la requête — la passe
   échoue et sera rejouée au prochain réveil. On ne martèle JAMAIS : réessayer en
   boucle sur un service qui vient de nous dire « trop vite » aggrave précisément
   ce qu'il signale, et peut faire blacklister le compte de service.

   SÉCURITÉ (invariants de ce fichier) :
   - le jeton (et l'en-tête d'autorisation qui le porte) n'apparaît JAMAIS dans un
     message d'erreur, un log ou une exception ;
   - les messages citent la CIBLE (origine + chemin), jamais la query string ni le
     corps d'une requête.
   ============================================================================= */

/** Erreur d'accès à l'API Jira. `retryable` distingue une défaillance de JOIGNABILITÉ (réseau,
    délai, débit) d'une erreur APPLICATIVE (le tracker a RÉPONDU : auth refusée, chemin inconnu,
    refus de création). `status` porte le code HTTP quand il y en a un — l'adaptateur en a besoin
    pour distinguer un 404 « ce ticket n'existe pas » (qui rend `null`) d'une vraie panne. */
export class JiraHttpError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status: number | null = null, cause?: unknown) {
    super(message);
    this.name = "JiraHttpError";
    // Cause CONSERVÉE (pile d'origine comprise) : indispensable au diagnostic des erreurs internes
    // de Node dont le `message` seul ne dit rien. Posée à la main plutôt que via
    // `new Error(msg, { cause })` — indépendant du lib target TS.
    if (cause !== undefined) (this as any).cause = cause;
  }

  /** Pile COMPLÈTE pour les logs : la nôtre + celle de la cause d'origine si présente. */
  fullStack(): string {
    const own = this.stack || this.message;
    const cause = (this as any).cause;
    return cause instanceof Error && cause.stack ? own + "\n  cause : " + cause.stack : own;
  }
}

/** Fonction d'attente injectable (tests : attente INSTANTANÉE et mesurable). */
export type SleepFn = (ms: number) => Promise<void>;

export class JiraHttp {
  /** Plafond de taille (octets) d'UNE réponse HTTP acceptée. Sans borne, un service détraqué (ou
      un intermédiaire hostile) pourrait streamer une réponse gigantesque et gonfler indéfiniment
      la mémoire du serveur. 32 Mio = très largement au-dessus d'une page de 100 tickets (quelques
      centaines de Kio) — le dépassement signale une anomalie, pas un cas nominal. C'est aussi
      pourquoi la PAGINATION existe : on ne demande jamais « tout d'un coup ». */
  static readonly MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

  /** Nombre maximal de NOUVELLES tentatives après un 429. Volontairement petit : au-delà, ce n'est
      plus un pic passager mais un quota — l'abandon propre et le message actionnable valent mieux
      qu'une passe qui s'éternise en tenant le verrou anti-chevauchement du service. */
  static readonly MAX_RETRIES_ON_THROTTLE = 3;

  /** Attente appliquée quand un 429 arrive SANS `Retry-After` exploitable. */
  static readonly DEFAULT_RETRY_WAIT_MS = 5_000;

  /** Plafond de l'attente honorée sur un `Retry-After`. Un service peut demander plusieurs minutes ;
      les tenir bloquerait la passe (et son verrou) bien au-delà de ce qui est raisonnable. Au-delà
      du plafond on ABANDONNE la passe plutôt que d'attendre : le prochain réveil réessaiera. */
  static readonly MAX_RETRY_WAIT_MS = 60_000;

  /** @param baseUrl  URL de base de l'instance (ex. « https://exemple.atlassian.net »).
      @param account  Identifiant du compte de service (moitié PUBLIQUE de l'identification).
      @param token    Jeton d'API (JAMAIS journalisé, jamais cité dans une erreur).
      @param timeoutMs  Délai maximal d'UNE tentative.
      @param fetchImpl  `fetch` injecté (stub en test — aucun réseau).
      @param sleep    Attente injectée (tests : instantanée et mesurable). */
  constructor(
    private readonly baseUrl: string,
    private readonly account: string,
    private readonly token: string,
    private readonly timeoutMs = 20_000,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: SleepFn = (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
  ) {}

  /* --------------------------------------------------------------------------
     Parties PURES (testables sans réseau)
     -------------------------------------------------------------------------- */

  /** En-tête d'autorisation Basic : `Basic base64(compte:jeton)`. Pure et statique → testable.
      ⚠ Le résultat EST un secret : il ne doit jamais être journalisé ni recopié dans une erreur. */
  static authHeader(account: string, token: string): string {
    return "Basic " + Buffer.from(String(account) + ":" + String(token), "utf8").toString("base64");
  }

  /** Traduit un en-tête `Retry-After` en millisecondes d'attente, ou `null` s'il est absent/illisible
      (l'appelant retombe alors sur `DEFAULT_RETRY_WAIT_MS`). Les DEUX formes de la RFC sont
      acceptées : un nombre de SECONDES (« 30 ») ou une DATE HTTP (« Wed, 21 Oct 2026 07:28:00 GMT »).
      Une date PASSÉE rend 0 (réessayer tout de suite est ce que le serveur demande). Pure → testable.
      @param nowMs  horloge INJECTÉE (une fonction pure ne lit pas `Date.now()`). */
  static retryAfterMs(header: string | null | undefined, nowMs: number): number | null {
    const raw = typeof header === "string" ? header.trim() : "";
    if (raw === "") return null;
    if (/^\d+$/.test(raw)) return Number(raw) * 1000;
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return null;
    return Math.max(0, at - nowMs);
  }

  /** Extrait le message d'erreur PORTÉ PAR LE TRACKER dans le corps d'une réponse 4xx.
      🚨 C'est la brique qui rend une CRÉATION refusée exploitable : Jira répond
      `{ errorMessages: [...], errors: { customfield_10010: "Le champ X est requis" } }`, et c'est
      CE texte-là qui dit à l'utilisateur quoi faire. L'envelopper dans un « échec de création »
      générique le rendrait inutilisable — le risque n°4 du cadrage.
      TOLÉRANT : corps vide, non-JSON ou de forme inattendue → "" (l'appelant se rabat sur le
      statut). Pure et statique → testable par fixtures. Vit ICI et non dans `JiraParse` parce que
      c'est le contrat d'ERREUR HTTP, pas le décodage d'un ticket : ce client construit tous ses
      messages lui-même, comme `UnifiHttp`. */
  static errorDetail(body: string): string {
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { return ""; }
    if (!parsed || typeof parsed !== "object") return "";
    const parts: string[] = [];
    if (Array.isArray(parsed.errorMessages)) {
      for (const message of parsed.errorMessages) if (typeof message === "string" && message.trim() !== "") parts.push(message.trim());
    }
    if (parsed.errors && typeof parsed.errors === "object" && !Array.isArray(parsed.errors)) {
      // Les erreurs PAR CHAMP nomment le champ fautif : on conserve le couple, c'est lui qui est
      // actionnable (« customfield_10010 : Le champ X est requis »).
      for (const [field, message] of Object.entries(parsed.errors as Record<string, unknown>)) {
        if (typeof message === "string" && message.trim() !== "") parts.push(field + " : " + message.trim());
      }
    }
    // Certaines routes rendent un simple `{ message: "…" }`.
    if (parts.length === 0 && typeof parsed.message === "string" && parsed.message.trim() !== "") parts.push(parsed.message.trim());
    return parts.join(" ; ");
  }

  /** Explications ACTIONNABLES des codes d'erreur réseau les plus fréquents : le `message` brut de
      Node (« fetch failed ») ne dit RIEN à l'utilisateur du statut de synchro. Le message technique
      d'origine est conservé à la suite (diagnostic), la cible est toujours citée. */
  private static readonly ERROR_EXPLANATIONS: { [code: string]: string } = {
    ECONNREFUSED: "connexion refusée par l'hôte (mauvaise URL d'instance ?)",
    EHOSTUNREACH: "hôte injoignable (routage / pare-feu)",
    ENETUNREACH: "réseau injoignable depuis le serveur DC Manager",
    ENOTFOUND: "nom d'hôte introuvable (résolution DNS) — vérifiez l'URL de l'instance",
    EAI_AGAIN: "résolution DNS en échec temporaire",
    ETIMEDOUT: "délai de connexion dépassé (pare-feu silencieux ? proxy sortant manquant ?)",
    ECONNRESET: "connexion coupée par l'hôte distant",
    CERT_HAS_EXPIRED: "certificat TLS EXPIRÉ côté tracker",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "certificat TLS non reconnu — ce module n'accepte que des certificats validés par les CA système (un tracker auto-hébergé exige un adaptateur dédié)",
    DEPTH_ZERO_SELF_SIGNED_CERT: "certificat TLS auto-signé — ce module n'accepte que des certificats validés par les CA système (un tracker auto-hébergé exige un adaptateur dédié)",
  };

  /** Enveloppe une erreur réseau en `JiraHttpError` EXPLICITE. ⚠ Le `fetch` de Node emballe l'erreur
      réelle dans un `TypeError` générique et met le VRAI code dans `cause` : sans ce déballage, tous
      les incidents réseau se ressembleraient (« fetch failed »). Statique et pure → testable. */
  static explainNetworkError(e: unknown, target: string): JiraHttpError {
    const direct = (e as { code?: unknown } | null | undefined)?.code;
    const nested = ((e as { cause?: { code?: unknown } } | null | undefined)?.cause)?.code;
    const code = typeof direct === "string" ? direct : typeof nested === "string" ? nested : null;
    const rawSelf = e instanceof Error ? e.message : String(e);
    const rawCause = (e as { cause?: unknown } | null | undefined)?.cause;
    const raw = rawCause instanceof Error && rawCause.message && rawCause.message !== rawSelf
      ? rawSelf + " (" + rawCause.message + ")"
      : rawSelf;
    const friendly = code && JiraHttp.ERROR_EXPLANATIONS[code] ? JiraHttp.ERROR_EXPLANATIONS[code] + " — " : "";
    return new JiraHttpError("Tracker : " + friendly + raw + " (sur " + target + ")", true, null, e);
  }

  /* --------------------------------------------------------------------------
     Surface RÉSEAU
     -------------------------------------------------------------------------- */

  /** GET JSON authentifié (`path` absolu, query string comprise). Résout le corps JSON parsé ;
      rejette une `JiraHttpError` (message SANS le jeton). */
  getJson(path: string): Promise<any> {
    return this.request("GET", path, undefined);
  }

  /** POST JSON authentifié. `body` est sérialisé en JSON ; il n'est JAMAIS repris dans un message
      d'erreur (il peut porter du contenu utilisateur, et la cible suffit au diagnostic). */
  postJson(path: string, body: unknown): Promise<any> {
    return this.request("POST", path, body);
  }

  /** Boucle de requête : tentative → gestion du 429 (attente bornée) → contrôle de statut →
      lecture PLAFONNÉE du corps → JSON. Une seule méthode pour les deux verbes : le traitement des
      erreurs et du débit est identique, le dupliquer le ferait diverger. */
  private async request(method: "GET" | "POST", path: string, body: unknown): Promise<any> {
    const url = new URL(path, this.baseUrl);
    // CIBLE citée dans chaque message d'erreur (origine + chemin, JAMAIS la query ni un secret) :
    // permet de vérifier dans les logs QUELLE ressource on a réellement tentée.
    const target = url.origin + url.pathname;

    for (let attempt = 0; ; attempt++) {
      const response = await this.send(method, url, body, target);
      const status = (response as { status?: number }).status || 0;

      // 429 : le tracker demande explicitement de ralentir. On honore `Retry-After` (borné), on
      // libère la réponse, et on abandonne proprement au-delà du petit nombre de tentatives.
      if (status === 429) {
        JiraHttp.discard(response);
        const asked = JiraHttp.retryAfterMs(JiraHttp.headerOf(response, "retry-after"), Date.now());
        const wait = asked === null ? JiraHttp.DEFAULT_RETRY_WAIT_MS : asked;
        if (attempt >= JiraHttp.MAX_RETRIES_ON_THROTTLE || wait > JiraHttp.MAX_RETRY_WAIT_MS) {
          throw new JiraHttpError(
            "Tracker : débit limité (429) sur " + target + " — abandon après " + (attempt + 1)
            + " tentative(s)" + (asked !== null ? ", attente demandée " + Math.round(asked / 1000) + " s" : "")
            + " ; la passe reprendra au prochain réveil (espacez la synchro)", true, 429);
        }
        await this.sleep(wait);
        continue;
      }

      // Statuts d'ÉCHEC : le tracker a RÉPONDU → erreur APPLICATIVE, jamais une panne réseau.
      if (status === 401 || status === 403) {
        JiraHttp.discard(response);
        throw new JiraHttpError("Tracker : authentification refusée (" + status + ") sur " + url.origin
          + " — vérifiez le compte de service et son jeton d'API, ainsi que ses droits sur le projet", false, status);
      }
      const text = await this.readBodyCapped(response, target);
      if (status === 404) {
        throw new JiraHttpError("Tracker : ressource introuvable (404) sur " + target
          + JiraHttp.detailSuffix(text) + " — chemin d'API inattendu, ou objet inexistant/inaccessible", false, 404);
      }
      if (status < 200 || status >= 300) {
        throw new JiraHttpError("Tracker : HTTP " + status + " sur " + target + JiraHttp.detailSuffix(text), false, status);
      }
      // 204/205 (ou corps vide) : rien à décoder, et ce n'est pas une anomalie.
      if (text.trim() === "") return null;
      try { return JSON.parse(text); }
      catch {
        throw new JiraHttpError("Tracker : réponse non-JSON sur " + target
          + " — une page d'authentification HTML ? (l'API REST attend un en-tête Authorization Basic)", false, status);
      }
    }
  }

  /** UNE tentative réseau. Traduit tout échec de transport en `JiraHttpError` explicite (délai,
      DNS, refus…) : au-delà, l'appelant ne voit plus que des statuts HTTP. */
  private async send(method: "GET" | "POST", url: URL, body: unknown, target: string): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: JiraHttp.authHeader(this.account, this.token),
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    try {
      return await this.fetchImpl(url.toString(), init);
    } catch (e) {
      // `AbortSignal.timeout` rejette avec un DOMException nommé « TimeoutError » ; un abandon
      // explicite donnerait « AbortError ». Les deux méritent un message de DÉLAI, pas de réseau.
      const name = (e as { name?: unknown } | null | undefined)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new JiraHttpError("Tracker : délai dépassé (" + this.timeoutMs + " ms) sur " + target, true, null, e);
      }
      throw JiraHttp.explainNetworkError(e, target);
    }
  }

  /** Lit le corps d'une réponse en PLAFONNANT le volume accumulé (cf. `MAX_RESPONSE_BYTES`).
      Deux chemins, et le repli n'est pas de la coquetterie : le `fetch` réel expose un FLUX
      (`response.body`), qu'on peut interrompre DÈS le dépassement — c'est la seule façon de ne pas
      accumuler ce qu'on refuse ; un stub de test (ou un polyfill) n'expose souvent que `text()`, et
      on borne alors après coup, ce qui protège encore l'appelant sans prétendre protéger la mémoire. */
  private async readBodyCapped(response: Response, target: string): Promise<string> {
    // Court-circuit quand la taille est ANNONCÉE : inutile de lire un octet d'une réponse qu'on
    // refusera de toute façon.
    const declared = Number(JiraHttp.headerOf(response, "content-length"));
    if (Number.isFinite(declared) && declared > JiraHttp.MAX_RESPONSE_BYTES) {
      JiraHttp.discard(response);
      throw JiraHttp.tooLarge(target);
    }
    const stream = (response as { body?: unknown }).body as { getReader?: () => any } | null | undefined;
    if (stream && typeof stream.getReader === "function") {
      const reader = stream.getReader();
      const decoder = new TextDecoder("utf-8");
      let text = "";
      let received = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value: Uint8Array | undefined = chunk.value;
        if (!value) continue;
        received += value.byteLength;
        if (received > JiraHttp.MAX_RESPONSE_BYTES) {
          try { await reader.cancel(); } catch { /* flux déjà clos */ }
          throw JiraHttp.tooLarge(target);
        }
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    }
    const text = await response.text();
    if (text.length > JiraHttp.MAX_RESPONSE_BYTES) throw JiraHttp.tooLarge(target);
    return text;
  }

  /** Erreur « réponse trop volumineuse » — UN seul point d'écriture (deux chemins de lecture). */
  private static tooLarge(target: string): JiraHttpError {
    return new JiraHttpError("Tracker : réponse trop volumineuse (> "
      + (JiraHttp.MAX_RESPONSE_BYTES / (1024 * 1024)) + " Mio) sur " + target
      + " — réduisez la taille de page", false, null);
  }

  /** Lecture TOLÉRANTE d'un en-tête : un stub de test peut ne pas exposer `headers` du tout. */
  private static headerOf(response: Response, name: string): string | null {
    const headers = (response as { headers?: { get?: (n: string) => string | null } }).headers;
    return headers && typeof headers.get === "function" ? headers.get(name) : null;
  }

  /** Libère une réponse dont le corps ne sera PAS lu (429, 401/403) : sans ça, la socket reste
      retenue par un flux jamais consommé. Best-effort et silencieux — un stub n'a rien à annuler.
      ⚠ La promesse rendue par `cancel()` est explicitement NEUTRALISÉE (`catch` vide) et non
      simplement ignorée : une promesse rejetée sans gestionnaire fait tomber le PROCESSUS Node
      entier (unhandled rejection). Renoncer à libérer une socket ne doit pas tuer le serveur. */
  private static discard(response: Response): void {
    try {
      const stream = (response as { body?: { cancel?: () => unknown } }).body;
      if (!stream || typeof stream.cancel !== "function") return;
      const pending = stream.cancel() as { catch?: (fn: () => void) => unknown } | undefined;
      if (pending && typeof pending.catch === "function") pending.catch(() => { /* rien à faire */ });
    } catch { /* rien à libérer */ }
  }

  /** Suffixe « — <message du tracker> » quand la réponse en porte un, "" sinon (cf. `errorDetail`). */
  private static detailSuffix(body: string): string {
    const detail = JiraHttp.errorDetail(body);
    return detail === "" ? "" : " — " + detail;
  }
}
