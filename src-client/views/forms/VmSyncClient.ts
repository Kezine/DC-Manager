/* Client HTTP des endpoints de synchro VM (feature AMOVIBLE, mode API uniquement).

   Vit à CÔTÉ de `VmForms` (retirer la feature = supprimer ces deux fichiers + le
   branchement `extraActions` de l'onglet VMs, sans cicatrice ailleurs).

   Pourquoi un client DÉDIÉ plutôt que passer par `RestAdapter._req` ? Le pipeline
   d'écriture générique de l'adaptateur (verrou optimiste X-Base-Rev, suivi X-Doc-Rev,
   409/400 structurés, invalidation) est TAILLÉ pour /transact ; les routes du module VM
   sont hors de ce contrat (elles n'ont ni rev ni verrou — la synchro qui écrit émet sa
   propre révision + son événement SSE côté serveur). On REJOUE donc le strict minimum du
   pipeline — MÊME base d'URL scopée au document, MÊMES en-têtes/auth, MÊMES cookies SSO —
   via une petite dépendance injectée (`VmRestContext`) que `RestAdapter` satisfait
   structurellement (aucun import du cœur ici → module testable et découplé). */

/** Compteurs d'une passe de synchro (miroir de `VmSyncCounts`, serveur). */
export interface VmSyncCounts { created: number; updated: number; orphaned: number; unchanged: number }

/** UN nœud du cluster (miroir de `VmClusterNode`, src-server/src/vm/VmProvider.ts) —
    métriques nullables : le provider peut ne pas les remonter. */
export interface VmClusterNode {
  name: string;
  online: boolean;
  /** Fraction d'usage CPU 0..1 (telle que remontée par Proxmox). */
  cpu_used: number | null;
  cpu_total: number | null;
  mem_used_mb: number | null;
  mem_total_mb: number | null;
  uptime_sec: number | null;
  /** Lien profond de l'UI de management de CE nœud (généré par le provider). null = absent. */
  management_url: string | null;
}

/** État du CLUSTER synchronisé (miroir de `VmClusterInfo`, serveur) — matière du
    sous-onglet « Clusters » (cadrage 2026-07-13). */
export interface VmClusterInfo {
  name: string;
  /** Version PVE (ex. "8.4.1") ; null = indisponible. */
  version: string | null;
  /** Version dans la gamme supportée par l'adaptateur. */
  supported: boolean;
  /** Quorum : true/false, null = inconnu (nœud isolé sans cluster). */
  quorate: boolean | null;
  nodes: VmClusterNode[];
  /** URL de l'outil de management du CLUSTER (Proxmox Datacenter Manager), recopiée de la config
      côté serveur — matière du bouton « Management » d'en-tête. null = non renseignée. */
  management_url: string | null;
}

/** État de synchro d'UN provider — miroir CLIENT de `VmProviderStatus`
    (src-server/src/vm/VmSyncService.ts). Duplication ASSUMÉE (principe n°3) : c'est la
    FORME d'une réponse réseau, pas une règle métier partageable ; la garder ici évite de
    faire dépendre le cœur front d'un type serveur et préserve l'amovibilité de la feature.
    Toute évolution du type serveur doit être répercutée ici (et réciproquement). */
export interface VmProviderStatus {
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
  counts: VmSyncCounts | null;
  /** Dernier état CONNU du cluster (conservé à travers les échecs, comme last_success) ;
      null = jamais synchronisé depuis le démarrage du serveur. */
  cluster: VmClusterInfo | null;
}

/* ---------------------------------------------------------------------------
   DTOs de GESTION des providers (CRUD + test) — MIROIRS des formes RENVOYÉES et
   ACCEPTÉES par les routes du module VM serveur (VmModule.ts / ProviderConfigDb.ts).
   Duplication ASSUMÉE (principe n°3), exactement comme VmProviderStatus : c'est la
   FORME d'une réponse/requête réseau, pas une règle métier partageable — la garder
   ICI évite de faire dépendre le cœur front d'un type serveur et préserve
   l'amovibilité de la feature. Toute évolution de ces routes se répercute ici.
   --------------------------------------------------------------------------- */

/** UN point d'accès du pool (miroir de `ProviderEndpoint`, VmProvider.ts) — l'empreinte TLS est
    PAR NŒUD (chaque nœud porte son propre certificat). null = validation CA système (pas d'épinglage). */
export interface VmProviderEndpoint {
  url: string;
  fingerprint: string | null;
}

/** Provider tel que RENVOYÉ par `GET /vm/providers` (liste) et `PUT /vm/providers/:id` (champ
    `provider`) — miroir de `ProviderListItem` (ProviderConfigDb.ts). JAMAIS le jeton : `has_token`
    n'en signale que la PRÉSENCE (l'API ne relit jamais un jeton — invariant d'écriture seule). */
export interface VmProviderSummary {
  id: string;
  kind: string;
  endpoints: VmProviderEndpoint[];
  include_lxc: boolean;
  interval_sec: number;
  timeout_sec: number;
  /** CA du cluster (PEM) — PUBLIC (pas un secret), donc RENVOYÉE en lecture (contrairement au jeton).
      null = pas de CA cluster. Niveau 2 de la hiérarchie de confiance (l'empreinte par nœud prime). */
  ca_pem: string | null;
  /** URL de management du cluster (Proxmox Datacenter Manager) — PUBLIC, renvoyée en lecture.
      Ouvre le bouton « Management » de la carte cluster. null = non renseignée. */
  management_url: string | null;
  /** Toujours true (colonne token_enc NOT NULL) → l'UI affiche « jeton défini, inchangé si vide ». */
  has_token: true;
  created_date: string;
  updated_date: string;
}

/** Résultat d'un test de connexion (miroir de `ProviderInfo`, VmProvider.ts) — AUCUN secret :
    joignabilité/auth (`ok`), version remontée + gamme supportée, message lisible. */
export interface VmProviderInfo {
  ok: boolean;
  kind: string;
  version: string | null;
  supported: boolean;
  message: string;
}

/** CORPS envoyé à `PUT /vm/providers/:id` (enregistrement) et `POST /vm/providers/test` (test).
    L'UI n'émet QUE la forme POOL (`urls`, empreinte par nœud) — jamais le raccourci mono-nœud
    `url`/`fingerprint` du fichier legacy. Le `token` transite EN CLAIR UNIQUEMENT à l'ENVOI et
    UNIQUEMENT s'il est (re)saisi : absent = « conserver le jeton stocké côté serveur » (édition
    « inchangé si vide ») ; requis à la création. Il n'est JAMAIS relu ni renvoyé par l'API. */
export interface VmProviderInput {
  id: string;
  kind: string;
  urls: VmProviderEndpoint[];
  token?: string;
  include_lxc: boolean;
  interval_sec: number;
  timeout_sec: number;
  /** CA du cluster (PEM) collée telle quelle — vide/null = pas de CA cluster. PUBLIC (pas un secret) :
      transite en clair sans réserve. Niveau 2 de la hiérarchie de confiance (l'empreinte par nœud prime). */
  ca_pem?: string | null;
  /** URL de management du cluster (Proxmox Datacenter Manager) collée telle quelle — vide/null = absente.
      PUBLIC (pas un secret) : transite en clair. Non déductible de l'API, d'où sa saisie en config. */
  management_url?: string | null;
}

/** Erreur d'un appel VM porteuse du CODE HTTP et du `detail` serveur (503 config invalide),
    pour que l'UI affiche un toast précis (404 document inconnu, 503 + détail, etc.). */
export class VmSyncError extends Error {
  constructor(message: string, readonly status: number, readonly detail: string | null) {
    super(message);
    this.name = "VmSyncError";
  }
}

/** Le strict minimum dont le client a besoin de l'adaptateur REST — `RestAdapter` l'expose
    déjà en public (`dataBase` déjà scopée sous /documents/{docId}, `headers`, `clientId`,
    `docId`). Interface (et non import de la classe) : découplage + testabilité par stub. */
export interface VmRestContext {
  /** Base des données du document COURANT : `apiRoot + /documents/{docId}` (ou apiRoot si aucun doc). */
  readonly dataBase: string;
  /** Document courant (null = aucun) — garde : pas d'appel VM hors d'un document ouvert. */
  readonly docId: string | null;
  /** En-têtes de base (Content-Type + éventuelle auth injectée). */
  readonly headers: Record<string, string>;
  /** Id de session par onglet — même en-tête `X-Client-Id` que les autres appels de l'adaptateur. */
  readonly clientId: string;
}

export class VmSyncClient {
  constructor(private readonly ctx: VmRestContext) {}

  /** Synchronise TOUS les providers du document courant → un statut par provider. */
  async sync(): Promise<VmProviderStatus[]> {
    const json = await this.call("POST", "/vm/sync");
    return (json && Array.isArray(json.providers)) ? (json.providers as VmProviderStatus[]) : [];
  }

  /** État courant de tous les providers configurés pour le document (sans déclencher de synchro). */
  async status(): Promise<VmProviderStatus[]> {
    const json = await this.call("GET", "/vm/status");
    return (json && Array.isArray(json.providers)) ? (json.providers as VmProviderStatus[]) : [];
  }

  /* ---- GESTION des providers (CRUD + test) — le jeton n'est JAMAIS relu (écriture seule) ---- */

  /** Liste des providers du document courant (SANS jeton — `has_token` en signale la présence). */
  async providers(): Promise<VmProviderSummary[]> {
    const json = await this.call("GET", "/vm/providers");
    return (json && Array.isArray(json.providers)) ? (json.providers as VmProviderSummary[]) : [];
  }

  /** Crée ou met à jour un provider (PUT idempotent par `id`). Le corps porte le jeton EN CLAIR
      UNIQUEMENT s'il est (re)saisi (`input.token`) ; absent = conserver le jeton stocké. Renvoie le
      provider enregistré (SANS jeton). Une config invalide remonte en `VmSyncError` 400 (issues → detail). */
  async saveProvider(id: string, input: VmProviderInput): Promise<VmProviderSummary> {
    const json = await this.call("PUT", "/vm/providers/" + encodeURIComponent(id), input);
    return json.provider as VmProviderSummary;
  }

  /** Supprime un provider (cascade des endpoints côté serveur). 404 si l'id n'existe pas (→ VmSyncError). */
  async deleteProvider(id: string): Promise<void> {
    await this.call("DELETE", "/vm/providers/" + encodeURIComponent(id));
  }

  /** Teste une config CANDIDATE sans l'enregistrer. En édition, un jeton vide fait reprendre au
      serveur le jeton stocké (déchiffré côté serveur, jamais renvoyé) — d'où l'`id` dans le corps. */
  async testProvider(input: VmProviderInput): Promise<VmProviderInfo> {
    const json = await this.call("POST", "/vm/providers/test", input);
    return json.info as VmProviderInfo;
  }

  /** Appel BAS NIVEAU : rejoue le pipeline de l'adaptateur (base scopée + en-têtes + cookies SSO).
      Traduit les réponses non-OK en `VmSyncError` (avec code HTTP + `detail`) ; une panne réseau
      remonte l'erreur brute de `fetch` (interceptée en amont pour un toast d'erreur générique).
      Le corps (écritures PUT/POST) est sérialisé en JSON — l'en-tête `Content-Type: application/json`
      vient déjà de `ctx.headers` (RestAdapter), comme les écritures /transact. */
  private async call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<any> {
    // Garde : `dataBase` sans document viserait la racine API (route inexistante) — on le signale explicitement.
    if (!this.ctx.docId) throw new VmSyncError("aucun document ouvert", 0, null);
    const res = await fetch(this.ctx.dataBase + path, {
      method,
      headers: { ...this.ctx.headers, "X-Client-Id": this.ctx.clientId },
      credentials: "include",   // SSO : cookies de session transmis, comme RestAdapter (l'app ne gère pas l'auth)
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // Corps JSON tolérant : succès `{ providers | provider | info | ok }`, erreur `{ error, detail? | issues? }`
    // — un corps vide/illisible ne doit pas masquer le code HTTP.
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (!res.ok) {
      const message = (json && typeof json.error === "string") ? json.error : ("HTTP " + res.status);
      // 503 config → `detail` (chaîne) ; 400 validation → `issues` (messages FRANÇAIS du serveur) agrégés
      // en `detail` (une ligne par issue) pour rester dans la forme code+detail de VmSyncError.
      const detail = (json && typeof json.detail === "string") ? json.detail
        : (json && Array.isArray(json.issues)) ? (json.issues as unknown[]).map(String).join("\n")
        : null;
      throw new VmSyncError(message, res.status, detail);
    }
    return json;
  }
}
