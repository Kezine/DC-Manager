import { DataAdapter } from "./DataAdapter";
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

  private async _req(base: string, method: string, path: string, body?: any, { allow404 = false }: { allow404?: boolean } = {}): Promise<any> {
    const isWrite = method !== "GET";
    const res = await fetch(base + path, {
      // X-Base-Rev : révision sur laquelle s'appuie cette écriture → le serveur la compare aux entités visées (verrou optimiste).
      method, headers: { ...this.headers, "X-Client-Id": this.clientId, ...(isWrite ? this.protocol.writeHeaders() : {}) },
      credentials: "include",   // SSO : on transmet les cookies de session (l'app NE gère PAS l'auth — le SSO valide)
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Interprétation (X-Doc-Rev, 409, 400 structuré, 404 toléré, 204, JSON) : déléguée au protocole pur.
    return this.protocol.interpret({ status: res.status, ok: res.ok, header: (n) => res.headers.get(n), text: () => res.text() }, method, path, { allow404 });
  }
  private _send(method: string, path: string, body?: any, opts?: { allow404?: boolean }): Promise<any> { return this._req(this.dataBase, method, path, body, opts); }
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
     renvoie un snapshot VIDE — le vrai chargement suit `setDocument()` (cf. restBootstrap). */
  async load(): Promise<Snapshot> {
    if (!this.docId) return { meta: {} };
    const snap: Snapshot = { meta: {} };
    // pageSize très grand → la collection ENTIÈRE (le document complet) en une page.
    await Promise.all(COLLECTIONS.map(async (c) => { snap[c] = this.rows(await this._send("GET", "/" + c + "?pageSize=" + PAGE_SIZE_ALL)); }));
    try { snap.meta = (await this._send("GET", "/meta")) || {}; } catch (_) { snap.meta = {}; }
    return snap;
  }
  async loadMeta(): Promise<Record<string, any>> { return this.docId ? ((await this._send("GET", "/meta")) || {}) : {}; }

  /* ---- lectures granulaires ---- */
  async list(collection: string, { page = 1, pageSize = PAGE_SIZE_DEFAULT, query = "", where = null }: ListOptions = {}): Promise<ListResult> {
    const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (query && query.trim()) qs.set("q", query.trim());
    if (where) Object.keys(where).forEach((f) => qs.set(f, where[f] === null || where[f] === undefined ? "null" : String(where[f])));
    const res = await this._send("GET", "/" + collection + "?" + qs.toString());
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
     entité (non atomique). Le serveur applique deletes → updates → creates → meta en tout-ou-rien. */
  async transact(tx: Transaction): Promise<null> {
    await this._send("POST", "/transact", {
      creates: tx.creates || [], updates: tx.updates || [], deletes: tx.deletes || [],
      ...(tx.meta ? { meta: tx.meta } : {}),
    });
    return null;
  }
  async saveMeta(meta: Record<string, any>): Promise<unknown> { return this._send("PUT", "/meta", meta); }
  async replaceAll(state: Snapshot): Promise<unknown> { return this._send("PUT", "/snapshot", state); }

  /* Utilisateur courant — proxifié au SSO par le backend. Renvoie l'objet user, ou null si non connecté / erreur.
     L'app ne gère PAS l'auth : c'est le SSO qui valide. */
  async me(): Promise<any | null> {
    try { return await this._root("GET", "/me", undefined, { allow404: true }); }
    catch (_) { return null; }
  }
}
