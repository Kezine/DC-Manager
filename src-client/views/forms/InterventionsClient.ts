/* Client HTTP du module serveur `interventions/` (incidents & interventions, mode API uniquement) —
   matière de la page d'administration « Interventions » (InterventionsAdminView).

   Vit à CÔTÉ de la vue admin (retirer la feature = supprimer ces fichiers + le branchement de main.ts,
   sans cicatrice ailleurs). Pattern IDENTIQUE à CertsClient/VmSyncClient (client REST dédié, DTOs
   miroirs commentés) : les routes interventions sont SCOPÉES PAR DOCUMENT
   (`<dataBase>/interventions/…`, montées sous `/documents/{docId}` côté serveur), on tape donc
   `dataBase` (comme CertsClient) et NON `apiRoot` (contrairement à NotifyClient, dont les routes sont
   globales). D'où aussi la garde « aucun document ouvert » : sans document courant, il n'y a pas
   d'interventions à interroger.

   DTOs = MIROIRS des formes renvoyées / acceptées par InterventionsDb.ts / InterventionsValidate.ts
   (src-server). Duplication ASSUMÉE (principe n°3) : c'est la FORME d'une réponse réseau, pas une règle
   métier partageable — la garder ici évite de faire dépendre le cœur front d'un type serveur et préserve
   l'amovibilité. Toute évolution des routes/DTO serveur se répercute ICI (et réciproquement). */

/** Lien vers une cible du document (couple opaque — aucune FK côté serveur, orphelins tolérés).
    Miroir de `InterventionLink` (InterventionsDb.ts). */
export interface InterventionLink {
  /** "equipment" | "vm" | "spare" (cf. INTERVENTION_TARGET_KINDS serveur). */
  target_kind: string;
  target_id: string;
}

/** Objet complet (liste ET détail partagent la MÊME forme côté serveur : aucun champ secret à masquer).
    Miroir de `InterventionRecord` (InterventionsDb.ts). L'AUDIT (created_by/date, updated_by/date,
    closed_date) est posé PAR LE SERVEUR — jamais renvoyé par le client à l'écriture (cf. InterventionInput). */
export interface InterventionRecord {
  id: string;
  /** "incident" | "intervention" (cf. INTERVENTION_KINDS serveur). */
  kind: string;
  title: string;
  /** Markdown (rendu côté client plus tard). */
  description: string;
  /** "declared" | "planned" | "in_progress" | "closed" | "cancelled" (cf. INTERVENTION_STATUSES). */
  status: string;
  /** "low" | "normal" | "high" | "critical" (cf. INTERVENTION_PRIORITIES) — ordre de traitement. */
  priority: string;
  created_by: string;
  created_date: string;
  updated_by: string;
  updated_date: string;
  planned_start: string | null;
  planned_end: string | null;
  jira_ref: string | null;
  closed_date: string | null;
  links: InterventionLink[];
}

/** Enveloppe d'une page de listing (forme ListResult du cœur : pagination + tableau `interventions`).
    Miroir de `InterventionsPage` (InterventionsDb.ts). */
export interface InterventionsPage {
  interventions: InterventionRecord[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
}

/** Paramètres du listing paginé (query string de GET /interventions). Tous optionnels → défauts appliqués
    côté serveur. `kinds`/`statuses`/`priorities` deviennent PLUSIEURS paramètres RÉPÉTÉS (jamais « kind=a,b »).
    Miroir SOUPLE de `InterventionsListOpts` (InterventionsDb.ts). */
export interface InterventionsListParams {
  page?: number;
  pageSize?: number;
  query?: string;
  kinds?: string[];
  statuses?: string[];
  priorities?: string[];
  sort?: string;
  dir?: "asc" | "desc";
}

/** CORPS envoyé à PUT /interventions/:id (miroir des champs ACCEPTÉS par InterventionsValidate). Les champs
    d'AUDIT ne figurent PAS : le serveur les pose (un client qui les enverrait est ignoré). */
export interface InterventionInput {
  kind: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  planned_start: string | null;
  planned_end: string | null;
  jira_ref: string | null;
  links: InterventionLink[];
}

/** Réponse de GET /interventions/meta : base d'URL Jira (variable d'env serveur JIRA_BASE_URL ; null si
    non configurée). Sert à fabriquer un lien vers un ticket depuis une clé — aucun appel Jira. */
export interface InterventionsMeta {
  jira_base_url: string | null;
}

/** Erreur d'un appel interventions porteuse du CODE HTTP et du `detail` serveur (503 module en erreur,
    400 validation → `issues` agrégées), pour un message d'UI précis. Jumelle de CertsError/NotifyError. */
export class InterventionsError extends Error {
  constructor(message: string, readonly status: number, readonly detail: string | null) {
    super(message);
    this.name = "InterventionsError";
  }
}

/** Strict minimum dont le client a besoin de l'adaptateur REST — `RestAdapter` l'expose déjà en public
    (`dataBase` scopée sous /documents/{docId}, `docId`, `headers`, `clientId`). Interface (et non import de
    la classe) : découplage + testabilité par stub. Identique à CertsRestContext (routes scopées document). */
export interface InterventionsRestContext {
  /** Base des données du document COURANT : `apiRoot + /documents/{docId}` (ou apiRoot si aucun doc). */
  readonly dataBase: string;
  /** Document courant (null = aucun) — garde : pas d'appel interventions hors d'un document ouvert. */
  readonly docId: string | null;
  /** En-têtes de base (Content-Type + éventuelle auth injectée). */
  readonly headers: Record<string, string>;
  /** Id de session par onglet — même en-tête `X-Client-Id` que les autres appels de l'adaptateur. */
  readonly clientId: string;
}

export class InterventionsClient {
  constructor(private readonly ctx: InterventionsRestContext) {}

  /** Document courant (null = aucun) — la vue s'en sert pour afficher « aucun document ouvert »
      avant d'appeler le réseau. Lu à la volée (le document change au fil de la navigation). */
  get docId(): string | null { return this.ctx.docId; }

  /** Liste PAGINÉE (GET /interventions?…) — filtres/tris/pagination calculés côté SERVEUR (jamais de slice
      client). Chaque item porte ses liens. */
  async listPage(params: InterventionsListParams = {}): Promise<InterventionsPage> {
    const json = await this.call("GET", "/interventions" + InterventionsClient.buildQuery(params));
    return {
      interventions: (json && Array.isArray(json.interventions)) ? (json.interventions as InterventionRecord[]) : [],
      total: Number(json && json.total) || 0,
      page: Number(json && json.page) || 1,
      pages: Number(json && json.pages) || 1,
      pageSize: Number(json && json.pageSize) || params.pageSize || 0,
    };
  }

  /** Métadonnées du module (base d'URL Jira). Chargée UNE fois par la vue (au premier rendu). */
  async meta(): Promise<InterventionsMeta> {
    const json = await this.call("GET", "/interventions/meta");
    return { jira_base_url: (json && typeof json.jira_base_url === "string") ? json.jira_base_url : null };
  }

  /** Comptes d'interventions OUVERTES par cible (badges de fiche) — `target` répétable « <kind>:<id> ».
      Renvoie une map `"<kind>:<id>" → n` (0 pour une cible sans intervention ouverte). */
  async counts(targets: Array<{ kind: string; id: string }>): Promise<Record<string, number>> {
    const sp = new URLSearchParams();
    for (const t of targets) if (t && t.kind && t.id) sp.append("target", t.kind + ":" + t.id);
    const qs = sp.toString();
    const json = await this.call("GET", "/interventions/counts" + (qs ? "?" + qs : ""));
    return (json && json.counts && typeof json.counts === "object") ? (json.counts as Record<string, number>) : {};
  }

  /** Détail unitaire (liens inclus). 404 → InterventionsError(status 404). */
  async getOne(id: string): Promise<InterventionRecord> {
    const json = await this.call("GET", "/interventions/" + encodeURIComponent(id));
    return json.intervention as InterventionRecord;
  }

  /** Crée/met à jour un objet (PUT idempotent par `id`). Le serveur (re)pose l'audit. */
  async save(id: string, input: InterventionInput): Promise<InterventionRecord> {
    const json = await this.call("PUT", "/interventions/" + encodeURIComponent(id), input);
    return json.intervention as InterventionRecord;
  }

  /** Supprime un objet (ses liens partent en cascade côté serveur). 404 si inconnu. */
  async remove(id: string): Promise<void> {
    await this.call("DELETE", "/interventions/" + encodeURIComponent(id));
  }

  /** Construit la QUERY STRING d'un listing (LOGIQUE PURE, testable). Les scalaires passent par
      URLSearchParams (encodage correct) ; `kinds`/`statuses`/`priorities` deviennent PLUSIEURS paramètres
      RÉPÉTÉS (`kind=a&kind=b`, JAMAIS « kind=a,b » — contrat serveur). Renvoie « ?… » ou "" si vide. */
  static buildQuery(params: InterventionsListParams): string {
    const sp = new URLSearchParams();
    if (params.page != null) sp.set("page", String(params.page));
    if (params.pageSize != null) sp.set("pageSize", String(params.pageSize));
    if (typeof params.query === "string" && params.query !== "") sp.set("query", params.query);
    if (params.sort) sp.set("sort", params.sort);
    if (params.dir) sp.set("dir", params.dir);
    for (const kind of params.kinds || []) if (kind) sp.append("kind", kind);           // répétable
    for (const status of params.statuses || []) if (status) sp.append("status", status); // répétable
    for (const priority of params.priorities || []) if (priority) sp.append("priority", priority); // répétable
    const qs = sp.toString();
    return qs ? "?" + qs : "";
  }

  /* -------------------------------------------------------------------------- */

  /** Appel BAS NIVEAU : rejoue le pipeline de l'adaptateur (base scopée au document + en-têtes + cookies
      SSO). Traduit les réponses non-OK en `InterventionsError` (code HTTP + `detail`) ; 400 → `issues`
      agrégées en `detail`, 503 → `detail` actionnable. Une panne réseau remonte l'erreur brute de `fetch`. */
  private async call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<any> {
    // Garde : `dataBase` sans document viserait la racine API (route inexistante) — on le signale.
    if (!this.ctx.docId) throw new InterventionsError("aucun document ouvert", 0, null);
    const res = await fetch(this.ctx.dataBase + path, {
      method,
      headers: { ...this.ctx.headers, "X-Client-Id": this.ctx.clientId },
      credentials: "include",   // SSO : cookies de session transmis, comme RestAdapter (l'app ne gère pas l'auth)
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    // Corps JSON tolérant : un corps vide/illisible ne doit pas masquer le code HTTP.
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (!res.ok) {
      const message = (json && typeof json.error === "string") ? json.error : ("HTTP " + res.status);
      const detail = (json && typeof json.detail === "string") ? json.detail
        : (json && Array.isArray(json.issues)) ? (json.issues as unknown[]).map(String).join("\n")
        : null;
      throw new InterventionsError(message, res.status, detail);
    }
    return json;
  }
}
