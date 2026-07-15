/* Client HTTP du module serveur `notify/` (feature AMOVIBLE, mode API uniquement) — matière de la
   page d'administration « Notifications » (NotificationsAdminView).

   Vit à CÔTÉ de la vue admin (retirer la feature = supprimer ces deux fichiers + le branchement de
   main.ts, sans cicatrice ailleurs). Pattern IDENTIQUE à VmSyncClient (client REST dédié, DTOs
   miroirs commentés), à UNE différence de scope PRÈS :

   ⚠ Les routes notify sont GLOBALES (`<apiRoot>/notify/…`), PAS scopées par document (contrairement
   aux routes VM montées sous `/documents/{docId}`). On tape donc `apiRoot` (racine API) et NON
   `dataBase`. Le document courant n'intervient que comme PARAMÈTRE (`?docId`, `doc_id` du corps) —
   d'où l'absence de la garde « aucun document ouvert » de VmSyncClient : ces routes répondent hors
   de tout document.

   DTOs = MIROIRS des formes renvoyées / acceptées par NotifyModule.ts (src-server/src/notify/).
   Duplication ASSUMÉE (principe n°3) : c'est la FORME d'une réponse réseau, pas une règle métier
   partageable — la garder ici évite de faire dépendre le cœur front d'un type serveur et préserve
   l'amovibilité. Toute évolution des routes/DTO serveur se répercute ICI (et réciproquement).

   INVARIANT DE SÉCURITÉ : aucune réponse ne porte de jeton — `has_token` en signale seulement la
   présence ; le jeton ne part EN CLAIR qu'à l'ENVOI (champ `token`) et seulement s'il est (re)saisi. */

/** Canal configuré tel que LISTÉ (GET /notify/instances) — miroir de `NotifierInstanceItem`
    (NotifyDb.ts). SANS jeton : `has_token` signale seulement qu'un jeton est stocké (l'UI affiche
    « jeton défini » et propose « inchangé si vide » à l'édition). */
export interface NotifierInstanceItem {
  id: string;
  /** "console" | "webhook" (cf. NOTIFIER_KINDS serveur). */
  kind: string;
  label: string;
  /** Endpoint du webhook ; null pour un canal console. */
  url: string | null;
  has_token: boolean;
  enabled: boolean;
  /** Webhook : envoi SIMPLIFIÉ { to, text } (deux clés) au lieu du payload complet. */
  simple: boolean;
  /** Webhook simplifié : longueur max. du texte compact (bornes serveur [20, 5000], défaut 300). */
  simple_max_chars: number;
  /** Webhook NON simplifié : corps mis en forme HTML si true, texte brut sinon. */
  html: boolean;
  created_date: string;
  updated_date: string;
}

/** CORPS envoyé à PUT /notify/instances/:id. Le `token` transite EN CLAIR UNIQUEMENT s'il est
    (re)saisi (écriture seule) : absent/vide = « conserver le jeton stocké côté serveur ». */
export interface NotifierInstanceInput {
  kind: string;
  label: string;
  /** Requis pour un webhook, sans objet pour console (validé côté serveur). */
  url?: string | null;
  token?: string;
  enabled: boolean;
  /** Webhook : envoi simplifié { to, text } (défaut false côté serveur ; sans objet pour console). */
  simple?: boolean;
  /** Webhook simplifié : longueur max. du texte (défaut 300, bornes serveur [20, 5000]). */
  simple_max_chars?: number;
  /** Webhook NON simplifié : corps au format HTML (défaut false). */
  html?: boolean;
}

/** Abonnement tel que LISTÉ (GET /notify/subscriptions) — miroir de `SubscriptionItem` (NotifyDb.ts).
    `doc_id` null = abonnement GLOBAL (tous documents) ; `event_type` "*" = tous les types. */
export interface SubscriptionItem {
  id: string;
  doc_id: string | null;
  event_type: string;
  /** Référence SOUPLE vers la collection contacts d'un document (résolue à l'affichage — garde-fou). */
  contact_id: string;
  /** "email" | "sms" (cf. SUBSCRIPTION_CHANNELS serveur). */
  channel: string;
  notifier_id: string;
  enabled: boolean;
}

/** CORPS envoyé à PUT /notify/subscriptions/:id (miroir des champs acceptés par NotifyValidate). */
export interface SubscriptionInput {
  /** null = abonnement global (tous documents). */
  doc_id: string | null;
  event_type: string;
  contact_id: string;
  channel: string;
  notifier_id: string;
  enabled: boolean;
}

/** Alerte ACTIVE (GET /notify/states) — miroir de `NotifyState` (NotifyEngine.ts), sans `resolved_at`
    (la route ne renvoie que les états non résolus). Horodatages ISO 8601. */
export interface NotifyStateItem {
  key: string;
  event_type: string;
  /** "info" | "warning" | "error". */
  severity: string;
  doc_id: string | null;
  title: string;
  body: string;
  first_seen: string;
  last_sent: string | null;
  next_remind_at: string | null;
  remind_interval_sec: number;
  /** Dernier échec d'envoi (message SANS secret) — null si la dernière passe a réussi. */
  last_error: string | null;
}

/** Une entrée d'historique (GET /notify/log) — miroir des lignes de `NotifyLogPage` (NotifyDb.ts). */
export interface NotifyLogEntry {
  id: number;
  sent_at: string;
  key: string;
  event_type: string;
  contact_id: string | null;
  channel: string | null;
  notifier_id: string | null;
  /** "alerte" | "rappel" | "retablissement" (cf. NotifyJournalEntry). */
  phase: string | null;
  ok: boolean;
  detail: string | null;
}

/** Page d'historique paginée (GET /notify/log) — miroir de `NotifyLogPage`. */
export interface NotifyLogPage {
  entries: NotifyLogEntry[];
  total: number;
}

/** Réglage d'intervalle de rappel PAR TYPE (GET/PUT /notify/settings) — secondes (≥ 60). */
export interface EventSetting {
  event_type: string;
  remind_interval_sec: number;
}

/** Résultat d'un envoi de test (POST /notify/test) : une ligne par destinataire tenté, plus un `hint`
    serveur quand AUCUN destinataire n'a été routé (mode routé sans abonnement « test »/« * »). */
export interface NotifyTestResult {
  results: Array<{ notifier_id: string; address: string; ok: boolean; detail: string | null }>;
  hint?: string;
}

/** Erreur d'un appel notify porteuse du CODE HTTP et du `detail` serveur (503 clé absente, 400 config
    invalide → `issues` agrégées) — pour un message d'UI précis. Jumelle de VmSyncError (même contrat). */
export class NotifyError extends Error {
  constructor(message: string, readonly status: number, readonly detail: string | null) {
    super(message);
    this.name = "NotifyError";
  }
}

/** Strict minimum dont le client a besoin de l'adaptateur REST. `RestAdapter` l'expose déjà en public
    (`apiRoot`, `docId`, `headers`, `clientId`). Interface (et non import de la classe) : découplage +
    testabilité par stub. NOTE : on prend `apiRoot` (racine API) car les routes notify sont GLOBALES,
    contrairement à VmRestContext qui prend `dataBase` (scopé sous /documents/{docId}). */
export interface NotifyRestContext {
  /** Racine de l'API (les routes notify sont montées à ce niveau : `<apiRoot>/notify/…`). */
  readonly apiRoot: string;
  /** Document courant (null = aucun) — utilisé comme PARAMÈTRE de portée, jamais comme préfixe d'URL. */
  readonly docId: string | null;
  /** En-têtes de base (Content-Type + éventuelle auth injectée). */
  readonly headers: Record<string, string>;
  /** Id de session par onglet — même en-tête `X-Client-Id` que les autres appels de l'adaptateur. */
  readonly clientId: string;
}

export class NotifyClient {
  constructor(private readonly ctx: NotifyRestContext) {}

  /** Document courant (null = aucun) — la vue s'en sert pour la portée « ce document » des abonnements
      et le routage du test. Lu à la volée (le document change au fil de la navigation). */
  get docId(): string | null { return this.ctx.docId; }

  /* ---- Canaux (instances) — jeton en écriture seule ---- */

  async listInstances(): Promise<NotifierInstanceItem[]> {
    const json = await this.call("GET", "/notify/instances");
    return (json && Array.isArray(json.instances)) ? (json.instances as NotifierInstanceItem[]) : [];
  }

  /** Crée/met à jour un canal (PUT idempotent par `id`). Le `token` ne part que s'il est (re)saisi. */
  async saveInstance(id: string, input: NotifierInstanceInput): Promise<NotifierInstanceItem> {
    const json = await this.call("PUT", "/notify/instances/" + encodeURIComponent(id), input);
    return json.instance as NotifierInstanceItem;
  }

  /** Supprime un canal (ses abonnements suivent en cascade côté serveur). 404 → NotifyError. */
  async deleteInstance(id: string): Promise<void> {
    await this.call("DELETE", "/notify/instances/" + encodeURIComponent(id));
  }

  /* ---- Abonnements (routage par type) ---- */

  /** Liste les abonnements — tous (`docId` omis) ou ceux visibles d'un document (les siens + globaux). */
  async listSubscriptions(docId?: string | null): Promise<SubscriptionItem[]> {
    const json = await this.call("GET", "/notify/subscriptions" + NotifyClient.docQuery(docId));
    return (json && Array.isArray(json.subscriptions)) ? (json.subscriptions as SubscriptionItem[]) : [];
  }

  async saveSubscription(id: string, input: SubscriptionInput): Promise<SubscriptionItem> {
    const json = await this.call("PUT", "/notify/subscriptions/" + encodeURIComponent(id), input);
    return json.subscription as SubscriptionItem;
  }

  async deleteSubscription(id: string): Promise<void> {
    await this.call("DELETE", "/notify/subscriptions/" + encodeURIComponent(id));
  }

  /* ---- États actifs + historique (lecture seule) ---- */

  async listStates(docId?: string | null): Promise<NotifyStateItem[]> {
    const json = await this.call("GET", "/notify/states" + NotifyClient.docQuery(docId));
    return (json && Array.isArray(json.states)) ? (json.states as NotifyStateItem[]) : [];
  }

  /** Historique paginé (du plus récent au plus ancien). `limit`/`offset` = pagination par curseur simple. */
  async listLog(opts: { limit?: number; offset?: number; docId?: string | null } = {}): Promise<NotifyLogPage> {
    const qs = new URLSearchParams();
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.offset !== undefined) qs.set("offset", String(opts.offset));
    if (opts.docId) qs.set("docId", opts.docId);
    const suffix = qs.toString() ? ("?" + qs.toString()) : "";
    const json = await this.call("GET", "/notify/log" + suffix);
    return {
      entries: (json && Array.isArray(json.entries)) ? (json.entries as NotifyLogEntry[]) : [],
      total: (json && typeof json.total === "number") ? json.total : 0,
    };
  }

  /* ---- Réglages (intervalle de rappel par type) ---- */

  async listSettings(): Promise<EventSetting[]> {
    const json = await this.call("GET", "/notify/settings");
    return (json && Array.isArray(json.settings)) ? (json.settings as EventSetting[]) : [];
  }

  /** Règle l'intervalle d'un type (secondes ≥ 60). Renvoie le réglage enregistré. */
  async saveSetting(input: EventSetting): Promise<EventSetting> {
    const json = await this.call("PUT", "/notify/settings", input);
    return json.setting as EventSetting;
  }

  /** Supprime le réglage d'un type → retour au défaut serveur (12 h). 404 si aucun réglage. */
  async deleteSetting(eventType: string): Promise<void> {
    await this.call("DELETE", "/notify/settings/" + encodeURIComponent(eventType));
  }

  /* ---- Tests d'envoi ---- */

  /** Test ROUTÉ (déroule les abonnements « test »/« * » du document) : `{ doc_id }`. `hint` renvoyé si
      aucun destinataire n'est routé. */
  async testRouted(docId: string | null): Promise<NotifyTestResult> {
    return this.call("POST", "/notify/test", { doc_id: docId }) as Promise<NotifyTestResult>;
  }

  /** Test DIRECT d'UN canal vers UNE adresse saisie (sans abonnement préalable). */
  async testDirect(instanceId: string, address: string, channel?: string): Promise<NotifyTestResult> {
    return this.call("POST", "/notify/test", { instance_id: instanceId, address, ...(channel ? { channel } : {}) }) as Promise<NotifyTestResult>;
  }

  /* -------------------------------------------------------------------------- */

  /** `?docId=…` uniquement si un document est fourni (chaîne non vide) — sinon rien (toutes portées). */
  private static docQuery(docId?: string | null): string {
    return docId ? ("?docId=" + encodeURIComponent(docId)) : "";
  }

  /** Appel BAS NIVEAU : `apiRoot + path`, en-têtes/auth + cookies SSO (comme RestAdapter). Traduit les
      réponses non-OK en `NotifyError` (code HTTP + `detail`) ; 503 (clé absente) → `detail` actionnable,
      400 (config invalide) → `issues` agrégées en `detail`. Une panne réseau remonte l'erreur brute de
      `fetch` (interceptée en amont pour un toast générique). */
  private async call(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<any> {
    const res = await fetch(this.ctx.apiRoot + path, {
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
      throw new NotifyError(message, res.status, detail);
    }
    return json;
  }
}
