import https from "node:https";
import type { PeerCertificate } from "node:tls";

/* =============================================================================
   CLIENT HTTPS UNIFI — brique d'accès réseau du module `wifi/` (amovible),
   partie SPÉCIFIQUE À LA MARQUE (préfixe `Unifi*`, cf. décision D9).

   Auth par CLÉ D'API STATIQUE en en-tête `X-API-KEY` (API d'INTÉGRATION
   officielle, versionnée `/v1/`) — aucune session, aucun cookie, contrairement
   à l'API privée que ciblent les librairies communautaires (décision utilisateur :
   c'est le mauvais contrat, il casse à chaque mise à jour du contrôleur).

   ── POURQUOI `node:https` ET NON `fetch` (décision D5, adaptation documentée) ──
   L'esprit de la décision utilisateur — client MAISON, ~50 lignes, ZÉRO
   dépendance, API officielle — est conservé ; seul le VÉHICULE change. Les
   consoles UniFi auto-hébergées sont massivement en certificat AUTO-SIGNÉ, et le
   `fetch` de Node n'offre AUCUN moyen, sans dépendance, de fournir une CA ou un
   épinglage PAR REQUÊTE. `node:https` le permet, et le module VM a déjà le patron
   éprouvé en production.

   ── HIÉRARCHIE DE CONFIANCE (cf. `trustOptions`, statique et pure) ────────────
   1. `fingerprint` FOURNIE → ÉPINGLAGE : la validation CA est remplacée par la
      comparaison STRICTE de l'empreinte SHA-256 présentée (mismatch = échec du
      handshake). Le plus spécifique, donc prioritaire.
   2. sinon `ca_pem` FOURNIE → validation TLS par CETTE CA (`rejectUnauthorized`
      + option `ca`). ⚠ Le nom d'hôte de l'URL doit alors correspondre au CN/SAN
      du certificat (sinon ERR_TLS_CERT_ALTNAME_INVALID — expliqué plus bas).
   3. sinon → validation TLS STANDARD par les CA système.
   JAMAIS de « accepter tout ».

   ⚠ DUPLICATION ASSUMÉE ET SIGNALÉE DES DEUX CÔTÉS (principe n°3) : `trustOptions`
   et le catalogue d'erreurs réseau sont le JUMEAU de ceux de `vm/PveHttp.ts`.
   Les factoriser dans un module serveur commun coûterait l'AMOVIBILITÉ des deux
   features (chacune doit pouvoir être supprimée en retirant SON dossier et une
   ligne de bootstrap — c'est l'exigence structurante des deux chantiers). Le prix
   payé est ~40 lignes recopiées, connues et commentées ; le prix évité est un
   fichier commun que la suppression d'un module laisserait orphelin. ➜ Toute
   correction de sécurité ici doit être répercutée dans `vm/PveHttp.ts`, et
   réciproquement.

   SÉCURITÉ (invariants de ce fichier) :
   - jamais de désactivation aveugle de la validation TLS ;
   - la clé d'API n'apparaît JAMAIS dans un message d'erreur ni un log
     (un certificat CA, lui, est PUBLIC — pas un secret).
   ============================================================================= */

/** Erreur d'accès à l'API UniFi. `retryable` distingue une défaillance de JOIGNABILITÉ
    (réseau, délai, TLS) d'une erreur APPLICATIVE (la console a RÉPONDU : auth refusée,
    statut HTTP, corps non-JSON). Il n'y a PAS de bascule d'endpoint côté wifi (une console
    unique — décision D3), mais l'information reste utile au diagnostic et au message. */
export class UnifiHttpError extends Error {
  constructor(message: string, readonly retryable: boolean, cause?: unknown) {
    super(message);
    this.name = "UnifiHttpError";
    // Cause CONSERVÉE (pile d'origine comprise) : indispensable au diagnostic des erreurs
    // internes de Node dont le `message` seul ne dit rien. Posée à la main plutôt que via
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

export class UnifiHttp {
  /** Plafond de taille (octets) d'UNE réponse HTTP acceptée. Sans borne, une console hostile
      ou détraquée pourrait streamer une réponse gigantesque et gonfler indéfiniment la mémoire
      du serveur. 32 Mio = très largement au-dessus d'une page de clients réelle (quelques
      centaines de Kio) — le dépassement signale une anomalie, pas un cas nominal. C'est aussi
      pourquoi la PAGINATION existe : on ne demande jamais « tout d'un coup ». */
  static readonly MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

  /** Nom de l'en-tête d'authentification de l'API d'intégration UniFi (clé statique). */
  static readonly AUTH_HEADER = "X-API-KEY";

  constructor(
    private readonly baseUrl: string,          // ex. "https://unifi.example.lan"
    private readonly apiKey: string,           // clé d'API statique (JAMAIS journalisée)
    private readonly fingerprint: string | null,
    private readonly timeoutMs = 15_000,
    private readonly caPem: string | null = null,
    // Agent HTTPS INJECTÉ (keep-alive), optionnel EN DERNIER : null (défaut) = « socket dédiée
    // par requête ». L'adaptateur en crée un pour la DURÉE D'UNE PASSE et le détruit ensuite
    // (`dispose`) : une passe paginée enchaîne N requêtes vers le MÊME hôte, sans quoi chacune
    // repaierait un handshake TLS complet. Jamais de pool global partagé entre providers.
    private readonly agent: https.Agent | null = null,
  ) {}

  /** Empreinte normalisée pour comparaison : hex minuscule sans séparateurs (les UI affichent
      « AA:BB:… », Node fournit `fingerprint256` au même format). */
  private static normFp(fp: string): string { return fp.replace(/[^0-9a-fA-F]/g, "").toLowerCase(); }

  /** Fragment d'options TLS de `https.request` traduisant la HIÉRARCHIE DE CONFIANCE (cf. en-tête).
      Statique et PURE → testable sans réseau.

      ⚠ Les clés `checkServerIdentity`/`ca` ne sont posées QUE dans leur branche : un `undefined`
      EXPLICITE de `checkServerIdentity` écraserait le défaut de Node dans son spread d'options
      (`{ checkServerIdentity: tls.checkServerIdentity, ...options }`) et ferait échouer la
      validation interne de `tls.connect` — ERR_INTERNAL_ASSERTION opaque en Node 20,
      ERR_INVALID_ARG_TYPE en 24 (bug constaté en PRODUCTION sur le module VM le 2026-07-13,
      reproduit hors ligne sur les deux versions). D'où un fragment dont la clé est ABSENTE hors
      épinglage, plutôt que posée à `undefined`. NE PAS « simplifier » ce détail. */
  static trustOptions(pinnedFp: string | null, caPem: string | null): {
    rejectUnauthorized: boolean;
    ca?: string;
    checkServerIdentity?: (host: string, cert: PeerCertificate) => Error | undefined;
  } {
    // 1. ÉPINGLAGE (le plus spécifique) : l'empreinte prime sur tout — y compris une CA fournie.
    const pinned = pinnedFp ? UnifiHttp.normFp(pinnedFp) : null;
    if (pinned) {
      return {
        rejectUnauthorized: false,
        checkServerIdentity: (_host: string, cert: PeerCertificate) => {
          const got = UnifiHttp.normFp(cert.fingerprint256 || "");
          return got === pinned ? undefined
            : new Error("Empreinte TLS inattendue (" + (cert.fingerprint256 || "?") + ") — épinglage refusé");
        },
      };
    }
    // 2. CA fournie : valide la chaîne CONTRE cette CA (le nom d'hôte doit couvrir la console).
    if (caPem) return { rejectUnauthorized: true, ca: caPem };
    // 3. CA système.
    return { rejectUnauthorized: true };
  }

  /** Explications ACTIONNABLES des codes d'erreur réseau/TLS les plus fréquents : le `message`
      brut de Node (« unable to verify the first certificate »…) est technique et anglophone —
      l'UTILISATEUR du statut de synchro doit comprendre QUOI FAIRE. Le message technique
      d'origine est conservé à la suite (diagnostic), la cible est toujours citée. */
  private static readonly ERROR_EXPLANATIONS: { [code: string]: string } = {
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "certificat TLS non reconnu (certificat auto-signé de la console ?) — épinglez son empreinte SHA-256 dans le formulaire Providers, ou collez la CA de la console",
    DEPTH_ZERO_SELF_SIGNED_CERT: "certificat TLS auto-signé — épinglez l'empreinte SHA-256 de la console (champ « Empreinte », formulaire Providers)",
    SELF_SIGNED_CERT_IN_CHAIN: "chaîne TLS auto-signée — épinglez l'empreinte SHA-256 de la console, ou collez sa CA",
    CERT_HAS_EXPIRED: "certificat TLS EXPIRÉ sur la console — renouvelez-le, ou épinglez la nouvelle empreinte",
    ERR_TLS_CERT_ALTNAME_INVALID: "le certificat de la console ne couvre pas ce nom d'hôte — utilisez le nom porté par le certificat, ou épinglez l'empreinte",
    ECONNREFUSED: "connexion refusée par l'hôte (console arrêtée ? port fermé ?)",
    EHOSTUNREACH: "hôte injoignable (routage / pare-feu)",
    ENETUNREACH: "réseau injoignable depuis le serveur DC Manager",
    ENOTFOUND: "nom d'hôte introuvable (résolution DNS)",
    EAI_AGAIN: "résolution DNS en échec temporaire",
    ETIMEDOUT: "délai de connexion dépassé (pare-feu silencieux ?)",
    ECONNRESET: "connexion coupée par l'hôte distant",
  };

  /** Enveloppe une erreur réseau/TLS en `UnifiHttpError` EXPLICITE : explication en français si
      le code est connu, message technique d'origine conservé, cible citée, cause transportée.
      Statique et pure → testable sans réseau. */
  static explainNetworkError(e: unknown, target: string): UnifiHttpError {
    const code = (e as { code?: unknown } | null | undefined)?.code;
    const raw = e instanceof Error ? e.message : String(e);
    const friendly = typeof code === "string" && UnifiHttp.ERROR_EXPLANATIONS[code] ? UnifiHttp.ERROR_EXPLANATIONS[code] + " — " : "";
    return new UnifiHttpError("UniFi : " + friendly + raw + " (sur " + target + ")", true, e);
  }

  /** Libère les sockets keep-alive EN FIN DE PASSE. Idempotente ; NO-OP sans agent injecté. */
  dispose(): void {
    this.agent?.destroy();
  }

  /** GET JSON authentifié (`path` absolu, ex. "/proxy/network/integration/v1/sites").
      Résout le corps JSON parsé ; rejette une `UnifiHttpError` (message SANS la clé d'API).
      Le chemin peut porter une query string (pagination) — il est passé tel quel à `URL`. */
  getJson(path: string): Promise<any> {
    const url = new URL(path, this.baseUrl);
    // CIBLE citée dans chaque message d'erreur (origin + chemin, JAMAIS la query ni un secret) :
    // permet de vérifier dans les logs QUELLE ressource on a réellement tentée.
    const target = url.origin + url.pathname;

    const requestOptions: https.RequestOptions = {
      method: "GET",
      headers: { [UnifiHttp.AUTH_HEADER]: this.apiKey, Accept: "application/json" },
      timeout: this.timeoutMs,
      agent: this.agent ?? false,
      // Modèle de confiance TLS extrait en statique pure (épinglage > CA fournie > CA système) : le
      // spread N'INTRODUIT `checkServerIdentity`/`ca` QUE dans leur branche (cf. trustOptions).
      ...UnifiHttp.trustOptions(this.fingerprint, this.caPem),
    };

    return new Promise((resolve, reject) => {
      let req: ReturnType<typeof https.request>;
      try {
        req = https.request(url, requestOptions, (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          // `capped` : garde-fou d'idempotence. `req.destroy(err)` provoque un `error` (→ un seul
          // reject) ; mais plusieurs `data` peuvent encore arriver dans le même tick avant que la
          // destruction ne prenne effet — on ne veut alors ni ré-appeler destroy, ni accumuler.
          let capped = false;
          res.on("data", (c) => {
            if (capped) return;
            received += c.length;
            if (received > UnifiHttp.MAX_RESPONSE_BYTES) {
              capped = true;
              req.destroy(new UnifiHttpError("UniFi : réponse trop volumineuse (> " + (UnifiHttp.MAX_RESPONSE_BYTES / (1024 * 1024)) + " Mio) sur " + target + " — réduisez la taille de page", false));
              return;
            }
            chunks.push(c);
          });
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode || 0;
            // La console a RÉPONDU → l'erreur est applicative (clé, droits, route), pas une panne.
            if (status === 401 || status === 403) { reject(new UnifiHttpError("UniFi : authentification refusée (" + status + ") sur " + url.origin + " — vérifiez la clé d'API (en-tête " + UnifiHttp.AUTH_HEADER + ") et ses droits", false)); return; }
            if (status === 404) { reject(new UnifiHttpError("UniFi : ressource introuvable (404) sur " + target + " — l'API d'intégration est-elle activée sur cette console, et le site correct ?", false)); return; }
            if (status < 200 || status >= 300) { reject(new UnifiHttpError("UniFi : HTTP " + status + " sur " + target, false)); return; }
            try { resolve(JSON.parse(body)); }
            catch { reject(new UnifiHttpError("UniFi : réponse non-JSON sur " + target + " — une page de connexion HTML ? (l'API d'intégration attend une clé " + UnifiHttp.AUTH_HEADER + ")", false)); }
          });
        });
      } catch (e) {
        // Throw SYNCHRONE de https.request (URL/options invalides) : sans ce catch, l'erreur brute
        // (sans cible ni préfixe) fuiterait telle quelle hors du client.
        reject(new UnifiHttpError("UniFi : création de la requête impossible sur " + target + " — " + (e instanceof Error ? e.message : String(e)), true, e));
        return;
      }
      req.on("timeout", () => { req.destroy(new UnifiHttpError("UniFi : délai dépassé (" + this.timeoutMs + " ms) sur " + target, true)); });
      req.on("error", (e) => reject(e instanceof UnifiHttpError ? e : UnifiHttp.explainNetworkError(e, target)));
      req.end();
    });
  }
}
