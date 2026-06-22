import { DataAdapter } from "./DataAdapter";
import { PAGE_SIZE_DEFAULT } from "./config";
import { RawRecord, Snapshot, Transaction, Where, ListOptions, ListResult } from "./types";
import { EntityRegistry } from "../models";

const COLLECTIONS = EntityRegistry.COLLECTIONS;

export interface RestOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
}

/* Implémentation REST. NON utilisée par défaut mais COMPLÈTE : l'API sert les
   ÉLÉMENTS, jamais le modèle entier. transact() traduit le lot en appels HTTP par
   entité (aucune re-sérialisation globale). L'UNDO/REDO n'est PAS géré côté client
   (le serveur fait autorité).
   Endpoints :
     GET /{collection}?page=&pageSize=&q=&ids=&{champ}={valeur}
     GET /{collection}/{id} · POST /{collection} · PUT/DELETE /{collection}/{id}
     GET/PUT /meta · PUT /snapshot (bulk import)
   Convention `where` : valeur null sérialisée en `{champ}=null` (« non rattaché »). */
export class RestAdapter extends DataAdapter {
  baseUrl: string;
  headers: Record<string, string>;

  constructor({ baseUrl = "/api", headers = {} }: RestOptions = {}) {
    super();
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.headers = Object.assign({ "Content-Type": "application/json" }, headers);
  }

  get label(): string { return "REST (" + this.baseUrl + ")"; }

  private async _send(method: string, path: string, body?: any, { allow404 = false }: { allow404?: boolean } = {}): Promise<any> {
    const res = await fetch(this.baseUrl + path, {
      method, headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404 && allow404) return null;
    if (!res.ok) throw new Error("HTTP " + res.status + " sur " + method + " " + path);
    if (res.status === 204) return null;
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }

  /* Boot : hydratation par collection (en parallèle). */
  async load(): Promise<Snapshot> {
    const snap: Snapshot = { meta: {} };
    await Promise.all(COLLECTIONS.map(async (c) => { snap[c] = (await this._send("GET", "/" + c)) || []; }));
    try { snap.meta = (await this._send("GET", "/meta")) || {}; } catch (_) { snap.meta = {}; }
    return snap;
  }
  async loadMeta(): Promise<Record<string, any>> { return (await this._send("GET", "/meta")) || {}; }

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
    return (await this._send("GET", "/" + collection + "?ids=" + ids.map(encodeURIComponent).join(","))) || [];
  }
  async findBy(collection: string, field: string, value: any): Promise<RawRecord[]> {
    const v = (value === null || value === undefined) ? "null" : String(value);
    return (await this._send("GET", "/" + collection + "?" + encodeURIComponent(field) + "=" + encodeURIComponent(v))) || [];
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

  async transact(tx: Transaction): Promise<null> {
    for (const d of (tx.deletes || [])) await this._send("DELETE", "/" + d.collection + "/" + encodeURIComponent(d.id));
    for (const u of (tx.updates || [])) await this._send("PUT", "/" + u.collection + "/" + encodeURIComponent(u.id), u.record);
    for (const c of (tx.creates || [])) await this._send("POST", "/" + c.collection, c.record);
    if (tx.meta) await this._send("PUT", "/meta", tx.meta);
    return null;
  }
  async saveMeta(meta: Record<string, any>): Promise<unknown> { return this._send("PUT", "/meta", meta); }
  async replaceAll(state: Snapshot): Promise<unknown> { return this._send("PUT", "/snapshot", state); }
}
