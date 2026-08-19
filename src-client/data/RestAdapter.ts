import { DataAdapter } from "./DataAdapter";
import type { LoadOptions } from "./DataAdapter";
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_ALL } from "./config";
import { RawRecord, Snapshot, Transaction, ListOptions, ListResult } from "./types";
import { EntityRegistry } from "../models";
import { RestProtocol } from "./RestProtocol";

const COLLECTIONS = EntityRegistry.COLLECTIONS;

export interface RestOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
}

/** Métadonnées d'un document (workspace) côté serveur. */
export interface DocMeta { id: string; name: string; created_date?: string; updated_date?: string; locked?: boolean }

/* Implémentation REST MULTI-DOCUMENTS : l'API sert les ÉLÉMENTS d'UN document.
   - registre des documents (non scopé) : `/me`, `/documents…` via `apiRoot` ;
   - données (scopées par document) : `/documents/{docId}/…` via `dataBase`.
   `setDocument(id)` bascule le scope de données. transact() = 1 POST atomique.
   L'UNDO/REDO n'est PAS géré côté client (le serveur fait autorité). */
export class RestAdapter extends DataAdapter {
  apiRoot: string;                       // racine API (auth + registre des documents)
  dataBase: string;                      // base des données du document courant (= apiRoot tant qu'aucun doc)
  headers: Record<string, string>;
  docId: string | null = null;
  /** Cœur PUR du protocole (X-Doc-Rev, 409, 400 structuré) — extrait pour être testable sans réseau. */
  readonly protocol = new RestProtocol();
  // id de session (par onglet) : tague nos écritures (X-Client-Id) → on ignore NOS propres événements SSE.
  readonly clientId: string = (typeof crypto !== "undefined" && (crypto as any).randomUUID) ? (crypto as any).randomUUID() : ("c-" + Math.random().toString(36).slice(2) + Date.now().toString(36));

  /* Révision connue + callbacks : DÉLÉGUÉS au protocole (les sites existants — main.ts — restent inchangés). */
  get docRev(): number { return this.protocol.docRev; }
  set docRev(v: number) { this.protocol.docRev = v; }
  get onConflict(): RestProtocol["onConflict"] { return this.protocol.onConflict; }
  set onConflict(fn: RestProtocol["onConflict"]) { this.protocol.onConflict = fn; }
  get onValidationError(): RestProtocol["onValidationError"] { return this.protocol.onValidationError; }
  set onValidationError(fn: RestProtocol["onValidationError"]) { this.protocol.onValidationError = fn; }
  get onAuthExpired(): RestProtocol["onAuthExpired"] { return this.protocol.onAuthExpired; }
  set onAuthExpired(fn: RestProtocol["onAuthExpired"]) { this.protocol.onAuthExpired = fn; }
  get onForbidden(): RestProtocol["onForbidden"] { return this.protocol.onForbidden; }
  set onForbidden(fn: RestProtocol["onForbidden"]) { this.protocol.onForbidden = fn; }

  /** URL du flux SSE du document courant (ou "" si aucun document). */
  get eventsUrl(): string { return this.docId ? (this.apiRoot + "/documents/" + encodeURIComponent(this.docId) + "/events") : ""; }

  constructor({ baseUrl = "api", headers = {} }: RestOptions = {}) {   // défaut RELATIF (résolu contre <base>) → compatible sous-dossier / reverse-proxy
    super();
    this.apiRoot = baseUrl.replace(/\/+$/, "");
    this.dataBase = this.apiRoot;
    this.headers = Object.assign({ "Content-Type": "application/json" }, headers);
  }

  get label(): string { return "REST (" + this.apiRoot + (this.docId ? " · " + this.docId.slice(0, 10) : "") + ")"; }

  /** Définit le document courant : lectures/écritures de données scopées sous /documents/{docId}. */
  setDocument(docId: string | null): void {
    this.docId = docId || null;
    this.dataBase = this.docId ? (this.apiRoot + "/documents/" + encodeURIComponent(this.docId)) : this.apiRoot;
  }

  private async _req(base: string, method: string, path: string, body?: any, { allow404 = false, signal }: { allow404?: boolean; signal?: AbortSignal } = {}): Promise<any> {
    const isWrite = method !== "GET";
    const res = await fetch(base + path, {
      // X-Base-Rev : révision sur laquelle s'appuie cette écriture → le serveur la compare aux entités visées (verrou optimiste).
      method, headers: { ...this.headers, "X-Client-Id": this.clientId, ...(isWrite ? this.protocol.writeHeaders() : {}) },
      credentials: "include",   // SSO : on transmet les cookies de session (l'app NE gère PAS l'auth — le SSO valide)
      body: body === undefined ? undefined : JSON.stringify(body),
      // Annulation par l'appelant (recherche transverse debouncée : la frappe suivante ABANDONNE la
      // requête en vol) — fetch rejette alors avec AbortError, que l'appelant distingue d'un échec réel.
      signal,
    });
    // Interprétation (X-Doc-Rev, 409, 400 structuré, 404 toléré, 204, JSON) : déléguée au protocole pur.
    return this.protocol.interpret({ status: res.status, ok: res.ok, header: (n) => res.headers.get(n), text: () => res.text() }, method, path, { allow404 });
  }
  private _send(method: string, path: string, body?: any, opts?: { allow404?: boolean; signal?: AbortSignal }): Promise<any> { return this._req(this.dataBase, method, path, body, opts); }
  private _root(method: string, path: string, body?: any, opts?: { allow404?: boolean }): Promise<any> { return this._req(this.apiRoot, method, path, body, opts); }

  /* ---- registre des DOCUMENTS (non scopé) ---- */
  async listDocuments(): Promise<DocMeta[]> { return (await this._root("GET", "/documents")) || []; }
  async createDocument(name: string): Promise<DocMeta> { return this._root("POST", "/documents", { name }); }
  async renameDocument(id: string, name: string): Promise<DocMeta | null> { return this._root("PUT", "/documents/" + encodeURIComponent(id), { name }, { allow404: true }); }
  /** Verrouille / déverrouille un document (protection anti-suppression accidentelle ; cf. serveur `Api.deleteDoc` → 423). */
  async setDocumentLocked(id: string, locked: boolean): Promise<DocMeta | null> { return this._root("PUT", "/documents/" + encodeURIComponent(id), { locked }, { allow404: true }); }
  async deleteDocument(id: string): Promise<void> { await this._root("DELETE", "/documents/" + encodeURIComponent(id)); }

  /* ---- réglages globaux (doc par défaut…) ---- */
  /** Document par DÉFAUT (réglage serveur global) — ouvert au boot quand le navigateur n'a aucun « dernier doc
      ouvert » mémorisé. `defaultDocId` est null si non défini ou si le document a été supprimé. */
  async getDefaultDocId(): Promise<string | null> { const s = await this._root("GET", "/settings"); return (s && typeof s.defaultDocId === "string") ? s.defaultDocId : null; }
  /** Définit (ou efface si null) le document par défaut global. */
  async setDefaultDocId(id: string | null): Promise<string | null> { const s = await this._root("PUT", "/settings", { defaultDocId: id }); return (s && typeof s.defaultDocId === "string") ? s.defaultDocId : null; }

  /** Le serveur renvoie les listes paginées `{ rows, total, … }` ; le boot/getMany/findBy veulent le TABLEAU. */
  private rows(res: any): RawRecord[] { return Array.isArray(res) ? res : (res && Array.isArray(res.rows) ? res.rows : []); }

  /* Boot : hydratation par collection (en parallèle). SANS document scopé (au boot, avant le choix d'un document),
     renvoie un snapshot VIDE — le vrai chargement suit `setDocument()` (cf. restBootstrap).
     `skipCollections` (chantier LAZY-LOAD, cf. docs/hydratation.md) : ces collections ne sont PAS tirées —
     c'est ICI que se paie (ou plutôt que ne se paie plus) le coût du boot. Leur clé reste ABSENTE du
     snapshot, ce que `Store._hydrate` traite comme un tableau vide ; c'est le Store, et lui seul, qui sait
     que « vide » signifie ici « pas encore chargée » (il les re-déclare `none` juste après). */
  async load({ skipCollections = [] }: LoadOptions = {}): Promise<Snapshot> {
    if (!this.docId) return { meta: {} };
    const snap: Snapshot = { meta: {} };
    const fetched = COLLECTIONS.filter((c) => skipCollections.indexOf(c) === -1);
    // pageSize très grand → la collection ENTIÈRE (le document complet) en une page.
    await Promise.all(fetched.map(async (c) => { snap[c] = this.rows(await this._send("GET", "/" + c + "?pageSize=" + PAGE_SIZE_ALL)); }));
    try { snap.meta = (await this._send("GET", "/meta")) || {}; } catch (_) { snap.meta = {}; }
    return snap;
  }
  async loadMeta(): Promise<Record<string, any>> { return this.docId ? ((await this._send("GET", "/meta")) || {}) : {}; }

  /* ---- lectures granulaires ---- */
  async list(collection: string, { page = 1, pageSize = PAGE_SIZE_DEFAULT, query = "", where = null, sort = null, dir = null, signal }: ListOptions = {}): Promise<ListResult> {
    // PARITÉ DE GARDE avec load/loadMeta/maintenance/replaceAll : SANS document scopé, `dataBase`
    // retombe sur `apiRoot` et l'URL viserait une route qui n'existe que scopée (404 en pleine face).
    // Le cas est RÉEL depuis le lazy-load : le `store.init()` docless du boot déclare ses collections
    // lazy, et la réconciliation des catalogues les fait aussitôt hydrater (cf. Store.init) — sans
    // cette garde, chaque démarrage en mode API échouerait avant même le choix du document.
    if (!this.docId) return { rows: [], total: 0, page: 1, pages: 1, pageSize };
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (query && query.trim()) qs.set("q", query.trim());
    // TRI SERVEUR (pagination ordonnée complète) : `dir` ne part qu'AVEC `sort` — seul, il n'ordonne rien
    // (le serveur validerait puis l'ignorerait ; ne pas l'envoyer dit la même chose plus simplement).
    if (sort) { qs.set("sort", sort); qs.set("dir", dir === "desc" ? "desc" : "asc"); }
    if (where) Object.keys(where).forEach((f) => qs.set(f, where[f] === null || where[f] === undefined ? "null" : String(where[f])));
    // `signal` : listings serveur-pilotés — la frappe suivante ABANDONNE la requête en vol (cf. searchAll).
    const res = await this._send("GET", "/" + collection + "?" + qs.toString(), undefined, { signal });
    if (Array.isArray(res)) {
      const total = res.length, pages = Math.max(1, Math.ceil(total / pageSize));
      const p = Math.min(Math.max(1, page), pages);
      return { rows: res.slice((p - 1) * pageSize, p * pageSize), total, page: p, pages, pageSize };
    }
    const rows = (res && res.rows) || [];
    const total = (res && typeof res.total === "number") ? res.total : rows.length;
    const pages = (res && res.pages) || Math.max(1, Math.ceil(total / pageSize));
    return { rows, total, page: (res && res.page) || page, pages, pageSize };
  }
  async getOne(collection: string, id: string): Promise<RawRecord | null> {
    return this._send("GET", "/" + collection + "/" + encodeURIComponent(id), undefined, { allow404: true });
  }
  async getMany(collection: string, ids: string[]): Promise<RawRecord[]> {
    if (!ids || !ids.length) return [];
    return this.rows(await this._send("GET", "/" + collection + "?ids=" + ids.map(encodeURIComponent).join(",")));
  }
  async findBy(collection: string, field: string, value: any): Promise<RawRecord[]> {
    const v = (value === null || value === undefined) ? "null" : String(value);
    return this.rows(await this._send("GET", "/" + collection + "?pageSize=" + PAGE_SIZE_ALL + "&" + encodeURIComponent(field) + "=" + encodeURIComponent(v)));
  }
  /** Recherche GLOBALE transverse du document courant (`GET …/search` — palette Ctrl+K, cf.
      docs/recherche.md) : UN aller-retour → records par collection, plafonnés PAR collection côté
      serveur (`truncated` liste celles qui l'ont été — cap assumé v1). `collections` restreint le
      périmètre (la palette envoie ses familles à fiche) ; `signal` annule la requête quand la saisie
      a avancé (AbortController — fetch rejette en AbortError). */
  async searchAll(query: string, { collections = null, signal }: { collections?: string[] | null; signal?: AbortSignal } = {}): Promise<{ results: Record<string, RawRecord[]>; truncated: string[] }> {
    const qs = new URLSearchParams({ q: query });
    if (collections && collections.length) qs.set("collections", collections.join(","));
    const res = await this._send("GET", "/search?" + qs.toString(), undefined, { signal });
    return { results: (res && res.results) || {}, truncated: (res && res.truncated) || [] };
  }

  /* ---- écritures unitaires (appels directs, sans passer par le lot) ---- */
  async createOne(collection: string, record: RawRecord): Promise<RawRecord> {
    return (await this._send("POST", "/" + collection, record)) || record;
  }
  async updateOne(collection: string, id: string, record: RawRecord): Promise<RawRecord> {
    return (await this._send("PUT", "/" + collection + "/" + encodeURIComponent(id), record)) || record;
  }
  async deleteOne(collection: string, id: string): Promise<void> {
    await this._send("DELETE", "/" + collection + "/" + encodeURIComponent(id));
  }

  /* Lot APPLIQUÉ ATOMIQUEMENT côté serveur (1 transaction SQLite) — remplace l'ancienne boucle d'appels par
     entité (non atomique). Le serveur applique deletes → updates → creates → meta en tout-ou-rien.
     RETOUR : le compte rendu du serveur, dont la cascade RÉSIDUELLE qu'il a fusionnée au lot
     (`{ residual: { deletes, updates } }`) — le Store en purge son cache (garde M4, cf.
     docs/hydratation.md). Serveur d'avant la vague 2 (204 sans corps) → `null`, et M4 est un no-op. */
  async transact(tx: Transaction): Promise<unknown> {
    return this._send("POST", "/transact", {
      creates: tx.creates || [], updates: tx.updates || [], deletes: tx.deletes || [],
      ...(tx.meta ? { meta: tx.meta } : {}),
    });
  }

  /** APERÇU de cascade calculé par le SERVEUR (garde G5) : le plan complet d'une suppression d'un ou
      plusieurs enregistrements d'UNE collection, sur le corpus SERVEUR — donc juste même quand le
      cache client est partiel. LECTURE PURE : la route ne consomme aucune révision et ne publie aucun
      SSE (elle est POST par sa CHARGE — une liste d'ids —, pas par son effet). Sans document scopé :
      `null` (parité de garde avec load/list/maintenance). */
  async cascadePreview(collection: string, ids: readonly string[]): Promise<{ deletes: Array<{ c: string; id: string }>; detaches: Array<{ c: string; id: string; key: string; value: any }> } | null> {
    if (!this.docId) return null;
    const res = await this._send("POST", "/cascade-preview", { collection, ids: [...ids] });
    if (!res) return null;   // 409/400 routés par le protocole (corps null) → repli sur le plan local
    return { deletes: Array.isArray(res.deletes) ? res.deletes : [], detaches: Array.isArray(res.detaches) ? res.detaches : [] };
  }
  /** FACETTE d'une colonne calculée par le SERVEUR (garde G8) : `GET …/facets/<collection>?field=<champ>`
      → les valeurs DISTINCTES non vides, plafonnées (`ListFacets.VALUES_CAP`). LECTURE PURE (un GET :
      ni révision, ni SSE). Le drapeau `truncated` de la réponse n'est PAS remonté à l'appelant : l'UI
      n'affiche que des valeurs, et une facette qui heurte le plafond n'en est pas une — le diagnostic
      se lit côté serveur. Sans document scopé : `null` (parité de garde avec load/list/maintenance),
      donc repli sur le calcul local. */
  async facetValues(collection: string, field: string): Promise<string[] | null> {
    if (!this.docId) return null;
    const res = await this._send("GET", "/facets/" + collection + "?field=" + encodeURIComponent(field));
    return (res && Array.isArray(res.values)) ? res.values.map((v: any) => String(v)) : null;
  }
  /** SVG d'ÉTIQUETTE QR d'une fiche : `GET …/qr/<collection>/<id>?format=svg` (lot E — impression
      d'étiquettes, cf. docs/qr-scan.md). LECTURE PURE, mais la réponse est du SVG BRUT (image/svg+xml),
      pas du JSON : le protocole (`interpret`) ne s'applique pas — fetch dédié, mêmes cookies de session
      (`credentials: include`). Rejette avec le message SERVEUR quand il est actionnable (503 explicite
      « définir PUBLIC_BASE_URL », 404 fiche disparue…) : la modale d'impression l'affiche tel quel. */
  async qrSvg(collection: string, id: string): Promise<string> {
    if (!this.docId) throw new Error("aucun document ouvert");
    const res = await fetch(this.dataBase + "/qr/" + encodeURIComponent(collection) + "/" + encodeURIComponent(id) + "?format=svg", {
      credentials: "include",
      headers: { "X-Client-Id": this.clientId },
    });
    if (!res.ok) {
      let message = "";
      try { message = String(((await res.json()) || {}).error || ""); } catch { /* corps non-JSON : statut seul */ }
      throw new Error(message || ("HTTP " + res.status));
    }
    return res.text();
  }
  async saveMeta(meta: Record<string, any>): Promise<unknown> { return this._send("PUT", "/meta", meta); }
  /** MAINTENANCE du document courant (admin) : purge serveur des images ORPHELINES et des BINAIRES de
      pièces jointes orphelins (D5 — seul endroit où un binaire est supprimé) + compactage (VACUUM).
      Renvoie le bilan — les compteurs de pièces jointes sont OPTIONNELS (serveur antérieur au chantier
      pièces jointes : champs absents, le client n'affiche alors rien de plus). Null si aucun document ouvert. */
  async maintenance(): Promise<{ purgedImages: number; purgedAttachments?: number; purgedAttachmentBytes?: number; bytesBefore: number; bytesAfter: number } | null> {
    if (!this.docId) return null;
    return this._send("POST", "/maintenance");
  }
  /* SANS document scopé (au boot REST, avant tout `setDocument()`) → no-op, comme `load()`/`loadMeta()`/
     `maintenance()` : parité de garde. Sans elle, `Store.init()` hydrate depuis un `load()` docless
     (`{ meta: {} }`), `syncCatalogs()` peuple les catalogues sur un store VIDE, et `_persistAll()`
     déclenche CE `replaceAll` — donc un `PUT /snapshot` sur `dataBase` qui retombe sur `apiRoot`
     (aucun document dans l'URL) → 404 serveur (la route n'existe que scopée
     `/documents/:docId/snapshot`), constaté en production à CHAQUE chargement de l'app. Le chargement
     RÉEL du document (`RestDocuments.setDocument()` puis `store.init()`) persiste, lui, correctement
     une fois le scope posé — cette garde évite seulement le tir docless, et le risque latent de
     pousser un snapshot quasi vide si une route docless existait un jour. */
  async replaceAll(state: Snapshot): Promise<unknown> {
    if (!this.docId) return null;
    return this._send("PUT", "/snapshot", state);
  }

  /* Utilisateur courant — proxifié au SSO par le backend. Renvoie l'objet user, ou null si non connecté / erreur.
     L'app ne gère PAS l'auth : c'est le SSO qui valide. */
  async me(): Promise<any | null> {
    try { return await this._root("GET", "/me", undefined, { allow404: true }); }
    catch (_) { return null; }
  }

  /* Résolution BATCH d'ids d'utilisateurs → profils affichables (annuaire — endpoint CORE non scopé
     `GET /users/resolve?id=…&id=…`, cf. docs/user-resolver.md). Alimente `UserDirectory` (satisfait son
     contrat `UserResolverClient`). Renvoie le tableau `users` (vide si aucun id / erreur avalée en amont). */
  async resolveUsers(ids: string[]): Promise<any[]> {
    if (!ids || !ids.length) return [];
    const qs = ids.map((id) => "id=" + encodeURIComponent(id)).join("&");
    const res = await this._root("GET", "/users/resolve?" + qs);
    return (res && Array.isArray(res.users)) ? res.users : [];
  }
}
