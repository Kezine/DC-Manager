/* Client HTTP des endpoints de synchro des CLIENTS WIFI (feature AMOVIBLE, mode API uniquement).

   Vit à CÔTÉ de `WifiForms`/`WifiProvidersForm` (retirer la feature = supprimer ces
   trois fichiers + le branchement de l'onglet Wifi, sans cicatrice ailleurs).

   Pourquoi un client DÉDIÉ plutôt que passer par `RestAdapter._req` ? Le pipeline
   d'écriture générique de l'adaptateur (verrou optimiste X-Base-Rev, suivi X-Doc-Rev,
   409/400 structurés, invalidation) est TAILLÉ pour /transact ; les routes du module
   wifi sont hors de ce contrat (elles n'ont ni rev ni verrou — la synchro qui écrit
   émet sa propre révision + son événement SSE côté serveur). On REJOUE donc le strict
   minimum du pipeline — MÊME base d'URL scopée au document, MÊMES en-têtes/auth, MÊMES
   cookies SSO — via une petite dépendance injectée (`WifiRestContext`) que `RestAdapter`
   satisfait structurellement (aucun import du cœur ici → module testable et découplé).

   AGNOSTIQUE DE MARQUE (décision D9) : aucun DTO ci-dessous ne nomme un constructeur.
   Les réglages propres à une marque voyagent dans `options` (objet libre validé côté
   serveur par la branche `kind`) — ajouter une marque ne touche donc PAS ce fichier. */
import { SessionExpiry } from "../../core/SessionExpiry";   // signale un 401 (session SSO expirée) → retour au login (idempotent)

/** Compteurs d'une passe de synchro (miroir de `WifiSyncCounts`, serveur). `disconnected` et non
    `orphaned` : c'est le vocabulaire métier de la décision D2 (la mécanique reste l'orphelinat). */
export interface WifiSyncCounts { created: number; updated: number; disconnected: number; unchanged: number }

/** État de synchro d'UN provider — miroir CLIENT de `WifiProviderStatus`
    (src-server/src/wifi/WifiSyncService.ts). Duplication ASSUMÉE (principe n°3) : c'est la
    FORME d'une réponse réseau, pas une règle métier partageable ; la garder ici évite de faire
    dépendre le cœur front d'un type serveur et préserve l'amovibilité de la feature.
    Toute évolution du type serveur doit être répercutée ici (et réciproquement). */
export interface WifiProviderStatus {
  provider_id: string;
  kind: string;
  /** Période de synchro automatique en secondes (0 = manuelle). */
  interval_sec: number;
  /** Dernière TENTATIVE (ISO) ; null = jamais synchronisé depuis le démarrage du serveur. */
  last_attempt: string | null;
  /** Dernière synchro RÉUSSIE (ISO) ; conservée même si une tentative ultérieure échoue. */
  last_success: string | null;
  ok: boolean;
  /** Résumé lisible (compteurs) en succès, ou message d'erreur en échec. */
  message: string;
  counts: WifiSyncCounts | null;
}

/* ---------------------------------------------------------------------------
   DTOs de GESTION des providers (CRUD + test) — MIROIRS des formes RENVOYÉES et
   ACCEPTÉES par les routes du module wifi serveur (WifiModule / WifiProviderConfigDb).
   Duplication ASSUMÉE, exactement comme WifiProviderStatus.
   --------------------------------------------------------------------------- */

/** Réglages PROPRES à une marque — objet libre de scalaires, validé côté SERVEUR par la branche
    `kind` (`WifiProviderConfigValidate.KIND_OPTION_SPECS`). C'est ce qui permet d'ajouter une
    marque sans toucher au transport ni au schéma de la base (critère d'acceptation de D9). */
export type WifiProviderOptions = Record<string, string | number | boolean>;

/** Provider tel que RENVOYÉ par `GET /wifi/providers` (liste) et `PUT /wifi/providers/:id`
    (champ `provider`) — miroir de `WifiProviderListItem`. JAMAIS le jeton : `has_token` n'en
    signale que la PRÉSENCE (l'API ne relit jamais un jeton — invariant d'écriture seule). */
export interface WifiProviderSummary {
  id: string;
  kind: string;
  url: string;
  /** Empreinte TLS épinglée — PUBLIQUE (ce n'est pas un secret), donc renvoyée en lecture. */
  fingerprint: string | null;
  /** CA de la console (PEM) — PUBLIQUE, renvoyée en lecture, contrairement au jeton. */
  ca_pem: string | null;
  interval_sec: number;
  timeout_sec: number;
  options: WifiProviderOptions;
  /** Toujours true (colonne token_enc NOT NULL) → l'UI affiche « jeton défini, inchangé si vide ». */
  has_token: true;
  created_date: string;
  updated_date: string;
}

/** Résultat d'un test de connexion (miroir de `WifiProviderInfo`) — AUCUN secret. */
export interface WifiProviderInfo {
  ok: boolean;
  kind: string;
  version: string | null;
  /** L'API attendue par l'adaptateur répond (et, pour UniFi, le site est résolu). */
  supported: boolean;
  message: string;
}

/** CORPS envoyé à `PUT /wifi/providers/:id` (enregistrement) et `POST /wifi/providers/test`.
    Le `token` transite EN CLAIR UNIQUEMENT à l'ENVOI et UNIQUEMENT s'il est (re)saisi : absent =
    « conserver le jeton stocké côté serveur » (édition « inchangé si vide ») ; requis à la
    création. Il n'est JAMAIS relu ni renvoyé par l'API. */
export interface WifiProviderInput {
  id: string;
  kind: string;
  url: string;
  token?: string;
  fingerprint?: string | null;
  ca_pem?: string | null;
  interval_sec: number;
  timeout_sec: number;
  options: WifiProviderOptions;
}

/** Erreur d'un appel wifi porteuse du CODE HTTP et du `detail` serveur (503 config invalide,
    400 issues de validation), pour que l'UI affiche un message précis. */
export class WifiSyncError extends Error {
  constructor(message: string, readonly status: number, readonly detail: string | null) {
    super(message);
    this.name = "WifiSyncError";
  }
}

/** Le strict minimum dont le client a besoin de l'adaptateur REST — `RestAdapter` l'expose déjà
    en public. Interface (et non import de la classe) : découplage + testabilité par stub. */
export interface WifiRestContext {
  /** Base des données du document COURANT : `apiRoot + /documents/{docId}` (ou apiRoot si aucun doc). */
  readonly dataBase: string;
  /** Document courant (null = aucun) — garde : pas d'appel wifi hors d'un document ouvert. */
  readonly docId: string | null;
  /** En-têtes de base (Content-Type + éventuelle auth injectée). */
  readonly headers: Record<string, string>;
  /** Id de session par onglet — même en-tête `X-Client-Id` que les autres appels de l'adaptateur. */
  readonly clientId: string;
}

export class WifiSyncClient {
  constructor(private readonly ctx: WifiRestContext) {}

  /** Synchronise TOUS les providers du document courant → un statut par provider. */
  async sync(): Promise<WifiProviderStatus[]> {
    const json = await this.call("POST", "/wifi/sync");
    return (json && Array.isArray(json.providers)) ? (json.providers as WifiProviderStatus[]) : [];
  }

  /** État courant de tous les providers configurés pour le document (sans déclencher de synchro). */
  async status(): Promise<WifiProviderStatus[]> {
    const json = await this.call("GET", "/wifi/status");
    return (json && Array.isArray(json.providers)) ? (json.providers as WifiProviderStatus[]) : [];
  }

  /* ---- GESTION des providers (CRUD + test) — le jeton n'est JAMAIS relu (écriture seule) ---- */

  /** Liste des providers du document courant (SANS jeton — `has_token` en signale la présence). */
  async providers(): Promise<WifiProviderSummary[]> {
    const json = await this.call("GET", "/wifi/providers");
    return (json && Array.isArray(json.providers)) ? (json.providers as WifiProviderSummary[]) : [];
  }

  /** Crée ou met à jour un provider (PUT idempotent par `id`). Une config invalide remonte en
      `WifiSyncError` 400 (issues agrégées dans `detail`). */
  async saveProvider(id: string, input: WifiProviderInput): Promise<WifiProviderSummary> {
    const json = await this.call("PUT", "/wifi/providers/" + encodeURIComponent(id), input);
    return json.provider as WifiProviderSummary;
  }

  /** Supprime un provider. 404 si l'id n'existe pas (→ WifiSyncError). */
  async deleteProvider(id: string): Promise<void> {
    await this.call("DELETE", "/wifi/providers/" + encodeURIComponent(id));
  }

  /** Teste une config CANDIDATE sans l'enregistrer. En édition, un jeton vide fait reprendre au
      serveur le jeton stocké (déchiffré côté serveur, jamais renvoyé) — d'où l'`id` dans le corps. */
  async testProvider(input: WifiProviderInput): Promise<WifiProviderInfo> {
    const json = await this.call("POST", "/wifi/providers/test", input);
    return json.info as WifiProviderInfo;
  }

  /** Appel BAS NIVEAU : rejoue le pipeline de l'adaptateur (base scopée + en-têtes + cookies SSO).
      Traduit les réponses non-OK en `WifiSyncError` (code HTTP + `detail`) ; une panne réseau
      remonte l'erreur brute de `fetch` (interceptée en amont pour un message générique). */
  private async call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<any> {
    // Garde : `dataBase` sans document viserait la racine API (route inexistante) — on le signale.
    if (!this.ctx.docId) throw new WifiSyncError("aucun document ouvert", 0, null);
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
      // agrégés en `detail` (une ligne par issue) pour rester dans la forme code+detail.
      const detail = (json && typeof json.detail === "string") ? json.detail
        : (json && Array.isArray(json.issues)) ? (json.issues as unknown[]).map(String).join("\n")
        : null;
      throw new WifiSyncError(message, res.status, detail);
    }
    return json;
  }
}
