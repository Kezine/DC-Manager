/* Client HTTP du PONT « interventions ⇄ tracker distant » (feature AMOVIBLE, mode API uniquement).

   Vit à CÔTÉ de `TrackerProvidersForm`/`TrackerTicketBlock` (retirer la feature = supprimer ces
   fichiers + les branchements de la vue Interventions, sans cicatrice ailleurs).

   Pourquoi un client DÉDIÉ plutôt que passer par `RestAdapter._req` ? Le pipeline d'écriture
   générique de l'adaptateur (verrou optimiste X-Base-Rev, suivi X-Doc-Rev, 409/400 structurés,
   invalidation) est TAILLÉ pour /transact ; les routes du module `tracker` sont hors de ce contrat
   (elles n'ont ni rev ni verrou — la synchro et les actions manuelles qui écrivent émettent leur
   propre révision + leur événement SSE côté serveur). On REJOUE donc le strict minimum du pipeline
   — MÊME base d'URL scopée au document, MÊMES en-têtes/auth, MÊMES cookies SSO — via une petite
   dépendance injectée (`TrackerRestContext`) que `RestAdapter` satisfait structurellement (aucun
   import du cœur ici → module testable et découplé). Montage IDENTIQUE à `WifiSyncClient`.

   ⚠ TOUTES les routes sont SCOPÉES PAR DOCUMENT (`<dataBase>/tracker/…`) : les providers de
   réplication, comme les interventions qu'ils répliquent, appartiennent à UN document.

   AGNOSTIQUE DE MARQUE : aucun DTO ci-dessous ne nomme un tracker. Les réglages propres à une
   marque voyagent dans `options` (objet libre validé côté serveur par la branche `kind`) —
   ajouter une marque ne touche donc PAS ce fichier. */
import { SessionExpiry } from "../../core/SessionExpiry";   // signale un 401 (session SSO expirée) → retour au login (idempotent)

/** Compteurs d'une passe de synchro — miroir CLIENT de `TrackerSyncCounts` (serveur).
    ⚠ Le vocabulaire porte les DEUX MOITIÉS du pont, séparément : les `push_*` disent où en est
    l'envoi du contenu DC Manager, les autres le retour d'état lu chez le tracker. Une poussée en
    échec et un retour d'état parfait ne doivent pas se compenser dans un résumé. */
export interface TrackerSyncCounts {
  /** Poussées DUES trouvées (pending + error) pour ce provider. */
  push_due: number;
  /** Poussées RÉUSSIES à cette passe. */
  pushed: number;
  /** Poussées en ÉCHEC à cette passe (état `error` persisté, rejoué à la suivante). */
  push_failed: number;
  /** Poussées REPORTÉES par le plafond de passe — 0 en régime normal. */
  push_skipped: number;
  /** Interventions RÉPLIQUÉES pour ce provider (l'assiette du retour d'état). */
  tracked: number;
  /** Identifiants réellement DEMANDÉS au tracker (≤ `tracked` si le plafond a joué). */
  queried: number;
  updated: number;
  /** Tickets INTROUVABLES à cette passe (supprimés, projet archivé, permission perdue). */
  missing: number;
  unchanged: number;
  /** Interventions répliquées REPORTÉES au prochain passage par le plafond — 0 en régime normal. */
  skipped: number;
}

/** État de synchro d'UN provider — miroir CLIENT de `TrackerProviderStatus`
    (src-server/src/tracker/TrackerSyncService.ts). Duplication ASSUMÉE (principe n°3) : c'est la
    FORME d'une réponse réseau, pas une règle métier partageable ; la garder ici évite de faire
    dépendre le cœur front d'un type serveur et préserve l'amovibilité de la feature.
    Toute évolution du type serveur doit être répercutée ici (et réciproquement). */
export interface TrackerProviderStatus {
  provider_id: string;
  kind: string;
  /** Période de synchro automatique en secondes (0 = manuelle). */
  interval_sec: number;
  /** Dernière TENTATIVE (ISO) ; null = jamais synchronisé depuis le démarrage du serveur. */
  last_attempt: string | null;
  /** Dernière synchro RÉUSSIE (ISO) ; conservée même si une tentative ultérieure échoue. */
  last_success: string | null;
  ok: boolean;
  /** Résumé lisible (compteurs) en succès, ou message d'erreur en échec. JAMAIS le jeton. */
  message: string;
  counts: TrackerSyncCounts | null;
}

/* ---------------------------------------------------------------------------
   DTOs de GESTION des providers (CRUD + test) — MIROIRS des formes RENVOYÉES et
   ACCEPTÉES par les routes du module `tracker` serveur (TrackerModule /
   TrackerProviderConfigDb). Duplication ASSUMÉE, exactement comme TrackerProviderStatus.
   --------------------------------------------------------------------------- */

/** Réglages PROPRES à une marque — objet libre de scalaires, validé côté SERVEUR par la branche
    `kind` (`TrackerProviderConfigValidate.KIND_OPTION_SPECS`). C'est ce qui permet d'ajouter une
    marque sans toucher au transport ni au schéma de la base. */
export type TrackerProviderOptions = Record<string, string | number | boolean>;

/** Provider tel que RENVOYÉ par `GET …/tracker/providers` (liste) et `PUT …/tracker/providers/:id`
    (champ `provider`) — miroir de `TrackerProviderListItem`. JAMAIS le jeton : `has_token` n'en
    signale que la PRÉSENCE (l'API ne relit jamais un jeton — invariant d'écriture seule).
    ⚠ PAS de `fingerprint` ni de `ca_pem`, contrairement aux providers VM/wifi : un tracker SaaS
    a un certificat public, ce matériel de confiance TLS n'a aucun emploi ici (cf. le contrat
    serveur `TrackerProviderConfig`, qui documente l'écart). */
export interface TrackerProviderSummary {
  id: string;
  kind: string;
  url: string;
  /** Compte de service — moitié PUBLIQUE de l'identification, donc RELUE et réaffichée à
      l'édition. C'est toute la différence avec le jeton, qui ne ressort jamais. */
  account: string;
  interval_sec: number;
  timeout_sec: number;
  options: TrackerProviderOptions;
  /** Toujours true (colonne token_enc NOT NULL) → l'UI affiche « jeton défini, inchangé si vide ». */
  has_token: true;
  created_date: string;
  updated_date: string;
}

/** Résultat d'un test de connexion (miroir de `TrackerProviderInfo`) — AUCUN secret. */
export interface TrackerProviderInfo {
  ok: boolean;
  kind: string;
  version: string | null;
  /** L'API attendue par l'adaptateur répond bien. Hors gamme = avertissement, jamais un blocage. */
  supported: boolean;
  message: string;
}

/** CORPS envoyé à `PUT …/tracker/providers/:id` (enregistrement) et `POST …/tracker/providers/test`.
    Le `token` transite EN CLAIR UNIQUEMENT à l'ENVOI et UNIQUEMENT s'il est (re)saisi : absent =
    « conserver le jeton stocké côté serveur » (édition « inchangé si vide ») ; requis à la
    création. Il n'est JAMAIS relu ni renvoyé par l'API. `account`, lui, part à chaque écriture :
    ce n'est pas un secret. */
export interface TrackerProviderInput {
  id: string;
  kind: string;
  url: string;
  token?: string;
  account: string;
  interval_sec: number;
  timeout_sec: number;
  options: TrackerProviderOptions;
}

/** Résultat d'une ACTION MANUELLE sur une intervention (« Répliquer », « Lier », « Mettre à jour le
    ticket ») — miroir de la réponse de SUCCÈS de `TrackerActionResult`.
    ⚠ Un REFUS ne passe PAS par ici : le serveur répond 400 (demande incomplète — provider ambigu,
    aucune référence à lier), 404 (intervention inconnue), 409 (DÉJÀ répliquée) ou 422 (le TRACKER a
    refusé — son message est transmis MOT POUR MOT). Tous deviennent un `TrackerSyncError`, qui
    porte la clé du ticket quand il y en a une (cf. `TrackerSyncError.key`). */
export interface TrackerActionOutcome {
  /** Provider chez qui l'action a eu lieu. */
  provider_id: string | null;
  /** Identifiant INTERNE du ticket (créé, lié ou déjà connu). */
  ext_id: string | null;
  /** Clé LISIBLE du ticket (« INFRA-123 »). */
  key: string | null;
  /** Message lisible du serveur (déjà actionnable) — jamais le jeton. */
  message: string;
}

/** CORPS envoyé à `POST …/tracker/replicate/:interventionId`. */
export interface TrackerReplicateInput {
  /** Provider de destination. FACULTATIF : implicite quand le document n'a qu'UN provider, REQUIS
      au-delà (le serveur refuse alors avec un message qui NOMME les providers configurés — il ne
      devine jamais, répliquer produisant un effet irréversible chez un tiers). */
  provider_id?: string;
  /** true = ADOPTER le ticket déjà désigné par la référence de l'intervention au lieu d'en créer un
      nouveau. 🚨 Geste à CONFIRMER côté UI : le contenu DC Manager écrasera le résumé et la
      description du ticket à la prochaine poussée, or ce ticket peut venir d'une AUTRE source. */
  link?: boolean;
}

/** Erreur d'un appel `tracker` porteuse du CODE HTTP et du `detail` serveur (503 config invalide,
    400 issues de validation, 409 déjà répliquée, 422 refus du tracker), pour que l'UI affiche un
    message précis. */
export class TrackerSyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: string | null,
    /** 🚨 Clé LISIBLE d'un ticket dont l'existence est ÉTABLIE chez le tracker alors que l'action a
        échoué — typiquement un ticket CRÉÉ dont l'état local n'a pas pu être écrit. Portée jusqu'ici
        parce que c'est la SEULE chose qui rende la situation rattrapable (l'utilisateur reprend le
        ticket par la LIAISON avec cette clé). Le serveur ne supprime JAMAIS le ticket distant pour
        compenser. null partout ailleurs. */
    readonly key: string | null = null,
  ) {
    super(message);
    this.name = "TrackerSyncError";
  }

  /** Texte LISIBLE d'une erreur quelconque du pont : message + `detail` sur une seconde ligne quand
      il y en a un (503 « définir la clé… », 400 issues de validation agrégées). UNE seule
      implémentation (principe n°3) — la modale des providers, le bloc « Ticket » et la vue
      Interventions affichent tous les trois ces erreurs, et trois formulations divergeraient. */
  static text(e: unknown): string {
    if (e instanceof TrackerSyncError) return e.message + (e.detail ? "\n" + e.detail : "");
    return e instanceof Error ? e.message : String(e);
  }
}

/** Le strict minimum dont le client a besoin de l'adaptateur REST — `RestAdapter` l'expose déjà
    en public. Interface (et non import de la classe) : découplage + testabilité par stub. */
export interface TrackerRestContext {
  /** Base des données du document COURANT : `apiRoot + /documents/{docId}` (ou apiRoot si aucun doc). */
  readonly dataBase: string;
  /** Document courant (null = aucun) — garde : pas d'appel `tracker` hors d'un document ouvert. */
  readonly docId: string | null;
  /** En-têtes de base (Content-Type + éventuelle auth injectée). */
  readonly headers: Record<string, string>;
  /** Id de session par onglet — même en-tête `X-Client-Id` que les autres appels de l'adaptateur. */
  readonly clientId: string;
}

export class TrackerSyncClient {
  constructor(private readonly ctx: TrackerRestContext) {}

  /** Document courant (null = aucun) — la vue s'en sert avant d'appeler le réseau. Lu à la volée
      (le document change au fil de la navigation). */
  get docId(): string | null { return this.ctx.docId; }

  /** Passe de synchro COMPLÈTE sur tous les providers du document : poussées DUES d'abord, retour
      d'état ensuite → un statut par provider. */
  async sync(): Promise<TrackerProviderStatus[]> {
    const json = await this.call("POST", "/tracker/sync");
    return (json && Array.isArray(json.providers)) ? (json.providers as TrackerProviderStatus[]) : [];
  }

  /** État courant de tous les providers configurés pour le document (sans déclencher de passe). */
  async status(): Promise<TrackerProviderStatus[]> {
    const json = await this.call("GET", "/tracker/status");
    return (json && Array.isArray(json.providers)) ? (json.providers as TrackerProviderStatus[]) : [];
  }

  /* ---- ACTIONS MANUELLES sur UNE intervention (décisions E2 et E4 du cadrage) ---- */

  /** « RÉPLIQUER » une intervention qui ne l'est pas encore : crée le ticket chez le tracker, ou
      ADOPTE (`link: true`) celui que désigne déjà la référence de l'intervention.
      Refus typiques, tous en `TrackerSyncError` : 409 (déjà répliquée — c'est « Mettre à jour le
      ticket » qu'il faut), 400 (plusieurs providers et aucun désigné, ou liaison sans référence),
      422 (le tracker refuse : type inconnu du projet, champ requis manquant… son message est
      transmis tel quel). */
  async replicate(interventionId: string, input: TrackerReplicateInput = {}): Promise<TrackerActionOutcome> {
    const json = await this.call("POST", "/tracker/replicate/" + encodeURIComponent(interventionId), input);
    return TrackerSyncClient.outcome(json);
  }

  /** « METTRE À JOUR LE TICKET » — repousse le contenu DC Manager d'une intervention DÉJÀ répliquée.
      C'est la récupération MANUELLE d'un échec de poussée (décision E4) : l'état `error` est stable
      et rejoué à chaque passe périodique, ce bouton n'attend pas la prochaine. */
  async push(interventionId: string): Promise<TrackerActionOutcome> {
    const json = await this.call("POST", "/tracker/push/" + encodeURIComponent(interventionId));
    return TrackerSyncClient.outcome(json);
  }

  /* ---- GESTION des providers (CRUD + test) — le jeton n'est JAMAIS relu (écriture seule) ---- */

  /** Liste des providers du document courant (SANS jeton — `has_token` en signale la présence). */
  async providers(): Promise<TrackerProviderSummary[]> {
    const json = await this.call("GET", "/tracker/providers");
    return (json && Array.isArray(json.providers)) ? (json.providers as TrackerProviderSummary[]) : [];
  }

  /** Crée ou met à jour un provider (PUT idempotent par `id`). Une config invalide remonte en
      `TrackerSyncError` 400 (issues agrégées dans `detail`). */
  async saveProvider(id: string, input: TrackerProviderInput): Promise<TrackerProviderSummary> {
    const json = await this.call("PUT", "/tracker/providers/" + encodeURIComponent(id), input);
    return json.provider as TrackerProviderSummary;
  }

  /** Supprime un provider. 404 si l'id n'existe pas (→ TrackerSyncError). */
  async deleteProvider(id: string): Promise<void> {
    await this.call("DELETE", "/tracker/providers/" + encodeURIComponent(id));
  }

  /** Teste une config CANDIDATE sans l'enregistrer. En édition, un jeton vide fait reprendre au
      serveur le jeton stocké (déchiffré côté serveur, jamais renvoyé) — d'où l'`id` dans le corps. */
  async testProvider(input: TrackerProviderInput): Promise<TrackerProviderInfo> {
    const json = await this.call("POST", "/tracker/providers/test", input);
    return json.info as TrackerProviderInfo;
  }

  /** Lecture TOLÉRANTE de la réponse d'une action manuelle (champs absents = null / ""). */
  private static outcome(json: any): TrackerActionOutcome {
    return {
      provider_id: (json && typeof json.provider_id === "string") ? json.provider_id : null,
      ext_id: (json && typeof json.ext_id === "string") ? json.ext_id : null,
      key: (json && typeof json.key === "string") ? json.key : null,
      message: (json && typeof json.message === "string") ? json.message : "",
    };
  }

  /** Appel BAS NIVEAU : rejoue le pipeline de l'adaptateur (base scopée + en-têtes + cookies SSO).
      Traduit les réponses non-OK en `TrackerSyncError` (code HTTP + `detail`) ; une panne réseau
      remonte l'erreur brute de `fetch` (interceptée en amont pour un message générique). */
  private async call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<any> {
    // Garde : `dataBase` sans document viserait la racine API (route inexistante) — on le signale.
    if (!this.ctx.docId) throw new TrackerSyncError("aucun document ouvert", 0, null);
    const res = await fetch(this.ctx.dataBase + path, {
      method,
      headers: { ...this.ctx.headers, "X-Client-Id": this.ctx.clientId },
      credentials: "include",   // SSO : cookies de session transmis, comme RestAdapter
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // Corps JSON tolérant : succès `{ providers | provider | info | ok }`, erreur
    // `{ error, detail? | issues? }` — un corps vide/illisible ne doit pas masquer le code HTTP.
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (!res.ok) {
      if (res.status === 401) SessionExpiry.report(401);   // session expirée → retour au login (idempotent)
      const message = (json && typeof json.error === "string") ? json.error : ("HTTP " + res.status);
      // 503 config → `detail` (chaîne) ; 400 validation → `issues` (messages FRANÇAIS du serveur)
      // agrégés en `detail` (une ligne par issue) pour rester dans la forme code+detail. Les refus
      // d'action (409/422), eux, portent TOUT dans `error` : leur message EST l'information.
      const detail = (json && typeof json.detail === "string") ? json.detail
        : (json && Array.isArray(json.issues)) ? (json.issues as unknown[]).map(String).join("\n")
        : null;
      // `key` : la route des actions manuelles la rend MÊME en échec quand un ticket existe bel et
      // bien chez le tracker. Relevée ICI plutôt que dans `replicate`/`push` parce que c'est le seul
      // endroit qui voie le CORPS d'erreur — et l'appelant en a besoin pour un message rattrapable.
      const key = (json && typeof json.key === "string" && json.key !== "") ? json.key : null;
      throw new TrackerSyncError(message, res.status, detail, key);
    }
    return json;
  }
}
