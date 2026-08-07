/* Client HTTP des endpoints du module TICKETS (feature AMOVIBLE, mode API uniquement).

   Vit à CÔTÉ de `IssueForms`/`IssueProvidersForm` (retirer la feature = supprimer ces
   trois fichiers + le branchement de l'onglet Tickets, sans cicatrice ailleurs).

   Pourquoi un client DÉDIÉ plutôt que passer par `RestAdapter._req` ? Le pipeline
   d'écriture générique de l'adaptateur (verrou optimiste X-Base-Rev, suivi X-Doc-Rev,
   409/400 structurés, invalidation) est TAILLÉ pour /transact ; les routes du module
   `issues` sont hors de ce contrat (elles n'ont ni rev ni verrou — la synchro et le
   « suivi » qui écrivent émettent leur propre révision + leur événement SSE côté
   serveur). On REJOUE donc le strict minimum du pipeline — MÊME base d'URL scopée au
   document, MÊMES en-têtes/auth, MÊMES cookies SSO — via une petite dépendance injectée
   (`IssueRestContext`) que `RestAdapter` satisfait structurellement (aucun import du
   cœur ici → module testable et découplé). Montage IDENTIQUE à `WifiSyncClient`.

   ⚠ TOUTES les routes sont SCOPÉES PAR DOCUMENT (`<dataBase>/issues/…`) : les tickets
   suivis, comme les providers qui les résolvent, appartiennent à UN document.

   AGNOSTIQUE DE MARQUE : aucun DTO ci-dessous ne nomme un tracker. Les réglages propres
   à une marque voyagent dans `options` (objet libre validé côté serveur par la branche
   `kind`) — ajouter une marque ne touche donc PAS ce fichier. */
import { SessionExpiry } from "../../core/SessionExpiry";   // signale un 401 (session SSO expirée) → retour au login (idempotent)

/** Compteurs d'une passe de synchro — miroir CLIENT de `IssueSyncCounts` (serveur).
    ⚠ Le vocabulaire porte l'ASSIETTE INVERSÉE du chantier : pas de `created` (une passe ne crée
    JAMAIS d'enregistrement — seuls « Suivre » et « Ouvrir un ticket » en produisent), mais
    `tracked`/`queried`/`skipped`, parce que c'est le DOCUMENT qui énumère et que la passe est
    PLAFONNÉE. `missing` = tickets passés « introuvables » (et non « supprimés »). */
export interface IssueSyncCounts {
  /** Tickets SUIVIS par le document pour ce provider (l'assiette complète). */
  tracked: number;
  /** Identifiants réellement DEMANDÉS au tracker à cette passe (≤ `tracked` si le plafond a joué). */
  queried: number;
  updated: number;
  /** Tickets passés « INTROUVABLES » à cette passe (supprimés, projet archivé, permission perdue). */
  missing: number;
  unchanged: number;
  /** Tickets REPORTÉS au prochain passage à cause du plafond — 0 en régime normal. */
  skipped: number;
}

/** État de synchro d'UN provider — miroir CLIENT de `IssueProviderStatus`
    (src-server/src/issues/IssueSyncService.ts). Duplication ASSUMÉE (principe n°3) : c'est la
    FORME d'une réponse réseau, pas une règle métier partageable ; la garder ici évite de faire
    dépendre le cœur front d'un type serveur et préserve l'amovibilité de la feature.
    Toute évolution du type serveur doit être répercutée ici (et réciproquement). */
export interface IssueProviderStatus {
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
  counts: IssueSyncCounts | null;
}

/* ---------------------------------------------------------------------------
   DTOs de GESTION des providers (CRUD + test) — MIROIRS des formes RENVOYÉES et
   ACCEPTÉES par les routes du module `issues` serveur (IssueModule /
   IssueProviderConfigDb). Duplication ASSUMÉE, exactement comme IssueProviderStatus.
   --------------------------------------------------------------------------- */

/** Réglages PROPRES à une marque — objet libre de scalaires, validé côté SERVEUR par la branche
    `kind` (`IssueProviderConfigValidate.KIND_OPTION_SPECS`). C'est ce qui permet d'ajouter une
    marque sans toucher au transport ni au schéma de la base. */
export type IssueProviderOptions = Record<string, string | number | boolean>;

/** Provider tel que RENVOYÉ par `GET …/issues/providers` (liste) et `PUT …/issues/providers/:id`
    (champ `provider`) — miroir de `IssueProviderListItem`. JAMAIS le jeton : `has_token` n'en
    signale que la PRÉSENCE (l'API ne relit jamais un jeton — invariant d'écriture seule).
    ⚠ PAS de `fingerprint` ni de `ca_pem`, contrairement aux providers VM/wifi : un tracker SaaS
    a un certificat public, ce matériel de confiance TLS n'a aucun emploi ici (cf. le contrat
    serveur `IssueProviderConfig`, qui documente l'écart). */
export interface IssueProviderSummary {
  id: string;
  kind: string;
  url: string;
  /** Compte de service — moitié PUBLIQUE de l'identification, donc RELUE et réaffichée à
      l'édition. C'est toute la différence avec le jeton, qui ne ressort jamais. */
  account: string;
  interval_sec: number;
  timeout_sec: number;
  options: IssueProviderOptions;
  /** Toujours true (colonne token_enc NOT NULL) → l'UI affiche « jeton défini, inchangé si vide ». */
  has_token: true;
  created_date: string;
  updated_date: string;
}

/** Résultat d'un test de connexion (miroir de `IssueProviderInfo`) — AUCUN secret. */
export interface IssueProviderInfo {
  ok: boolean;
  kind: string;
  version: string | null;
  /** L'API attendue par l'adaptateur répond bien. Hors gamme = avertissement, jamais un blocage. */
  supported: boolean;
  message: string;
}

/** CORPS envoyé à `PUT …/issues/providers/:id` (enregistrement) et `POST …/issues/providers/test`.
    Le `token` transite EN CLAIR UNIQUEMENT à l'ENVOI et UNIQUEMENT s'il est (re)saisi : absent =
    « conserver le jeton stocké côté serveur » (édition « inchangé si vide ») ; requis à la
    création. Il n'est JAMAIS relu ni renvoyé par l'API. `account`, lui, part à chaque écriture :
    ce n'est pas un secret. */
export interface IssueProviderInput {
  id: string;
  kind: string;
  url: string;
  token?: string;
  account: string;
  interval_sec: number;
  timeout_sec: number;
  options: IssueProviderOptions;
}

/** Résultat de `POST …/issues/follow` (« Suivre un ticket ») — miroir de la réponse de succès.
    ⚠ Un REFUS ne passe PAS par ici : le serveur répond 422 avec un message actionnable, traduit en
    `IssueSyncError` par le transport (la modale l'affiche et RESTE ouverte pour correction). */
export interface IssueFollowResult {
  /** Enregistrement `issues` du document, créé OU rafraîchi, tel qu'il est persisté. */
  issue: Record<string, any> | null;
  /** Le ticket était DÉJÀ suivi : rien n'a été créé, il a seulement été rafraîchi. L'UI doit le
      DIRE — annoncer une création ferait chercher une ligne nouvelle qui n'existe pas. */
  already: boolean;
  /** Provider ayant RECONNU la référence (null si aucun). */
  provider_id: string | null;
  /** Message lisible du serveur (déjà actionnable) — jamais le jeton. */
  message: string;
}

/** Erreur d'un appel `issues` porteuse du CODE HTTP et du `detail` serveur (503 config invalide,
    400 issues de validation, 422 référence inexploitable), pour que l'UI affiche un message précis. */
export class IssueSyncError extends Error {
  constructor(message: string, readonly status: number, readonly detail: string | null) {
    super(message);
    this.name = "IssueSyncError";
  }
}

/** Le strict minimum dont le client a besoin de l'adaptateur REST — `RestAdapter` l'expose déjà
    en public. Interface (et non import de la classe) : découplage + testabilité par stub. */
export interface IssueRestContext {
  /** Base des données du document COURANT : `apiRoot + /documents/{docId}` (ou apiRoot si aucun doc). */
  readonly dataBase: string;
  /** Document courant (null = aucun) — garde : pas d'appel `issues` hors d'un document ouvert. */
  readonly docId: string | null;
  /** En-têtes de base (Content-Type + éventuelle auth injectée). */
  readonly headers: Record<string, string>;
  /** Id de session par onglet — même en-tête `X-Client-Id` que les autres appels de l'adaptateur. */
  readonly clientId: string;
}

export class IssueSyncClient {
  constructor(private readonly ctx: IssueRestContext) {}

  /** Synchronise TOUS les providers du document courant → un statut par provider. */
  async sync(): Promise<IssueProviderStatus[]> {
    const json = await this.call("POST", "/issues/sync");
    return (json && Array.isArray(json.providers)) ? (json.providers as IssueProviderStatus[]) : [];
  }

  /** État courant de tous les providers configurés pour le document (sans déclencher de synchro). */
  async status(): Promise<IssueProviderStatus[]> {
    const json = await this.call("GET", "/issues/status");
    return (json && Array.isArray(json.providers)) ? (json.providers as IssueProviderStatus[]) : [];
  }

  /** « SUIVRE UN TICKET » — la porte d'entrée de l'assiette. `reference` est ce que l'utilisateur a
      sous la main : la CLÉ lisible (« INFRA-123 ») ou l'URL collée depuis son navigateur. Le serveur
      résout, persiste l'identifiant INTERNE et rend la fiche. Une référence inexploitable remonte en
      `IssueSyncError` 422, SANS rien créer : l'appelant affiche le message et laisse corriger. */
  async follow(reference: string): Promise<IssueFollowResult> {
    const json = await this.call("POST", "/issues/follow", { reference });
    return {
      issue: (json && json.issue) || null,
      already: !!(json && json.already),
      provider_id: (json && typeof json.provider_id === "string") ? json.provider_id : null,
      message: (json && typeof json.message === "string") ? json.message : "",
    };
  }

  /* ---- GESTION des providers (CRUD + test) — le jeton n'est JAMAIS relu (écriture seule) ---- */

  /** Liste des providers du document courant (SANS jeton — `has_token` en signale la présence). */
  async providers(): Promise<IssueProviderSummary[]> {
    const json = await this.call("GET", "/issues/providers");
    return (json && Array.isArray(json.providers)) ? (json.providers as IssueProviderSummary[]) : [];
  }

  /** Crée ou met à jour un provider (PUT idempotent par `id`). Une config invalide remonte en
      `IssueSyncError` 400 (issues agrégées dans `detail`). */
  async saveProvider(id: string, input: IssueProviderInput): Promise<IssueProviderSummary> {
    const json = await this.call("PUT", "/issues/providers/" + encodeURIComponent(id), input);
    return json.provider as IssueProviderSummary;
  }

  /** Supprime un provider. 404 si l'id n'existe pas (→ IssueSyncError). */
  async deleteProvider(id: string): Promise<void> {
    await this.call("DELETE", "/issues/providers/" + encodeURIComponent(id));
  }

  /** Teste une config CANDIDATE sans l'enregistrer. En édition, un jeton vide fait reprendre au
      serveur le jeton stocké (déchiffré côté serveur, jamais renvoyé) — d'où l'`id` dans le corps. */
  async testProvider(input: IssueProviderInput): Promise<IssueProviderInfo> {
    const json = await this.call("POST", "/issues/providers/test", input);
    return json.info as IssueProviderInfo;
  }

  /** Appel BAS NIVEAU : rejoue le pipeline de l'adaptateur (base scopée + en-têtes + cookies SSO).
      Traduit les réponses non-OK en `IssueSyncError` (code HTTP + `detail`) ; une panne réseau
      remonte l'erreur brute de `fetch` (interceptée en amont pour un message générique). */
  private async call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<any> {
    // Garde : `dataBase` sans document viserait la racine API (route inexistante) — on le signale.
    if (!this.ctx.docId) throw new IssueSyncError("aucun document ouvert", 0, null);
    const res = await fetch(this.ctx.dataBase + path, {
      method,
      headers: { ...this.ctx.headers, "X-Client-Id": this.ctx.clientId },
      credentials: "include",   // SSO : cookies de session transmis, comme RestAdapter
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // Corps JSON tolérant : succès `{ providers | provider | info | issue }`, erreur
    // `{ error, detail? | issues? }` — un corps vide/illisible ne doit pas masquer le code HTTP.
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (!res.ok) {
      if (res.status === 401) SessionExpiry.report(401);   // session expirée → retour au login (idempotent)
      const message = (json && typeof json.error === "string") ? json.error : ("HTTP " + res.status);
      // 503 config → `detail` (chaîne) ; 400 validation → `issues` (messages FRANÇAIS du serveur)
      // agrégés en `detail` (une ligne par issue) pour rester dans la forme code+detail. Le 422 de
      // `follow`, lui, porte TOUT dans `error` : son message EST l'information actionnable.
      const detail = (json && typeof json.detail === "string") ? json.detail
        : (json && Array.isArray(json.issues)) ? (json.issues as unknown[]).map(String).join("\n")
        : null;
      throw new IssueSyncError(message, res.status, detail);
    }
    return json;
  }
}
