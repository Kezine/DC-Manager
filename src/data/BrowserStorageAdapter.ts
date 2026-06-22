import { DataAdapter } from "./DataAdapter";
import { FieldIndex } from "./FieldIndex";
import { PAGE_SIZE_DEFAULT, HISTORY_MAX, INDEX_SPEC } from "./config";
import { RawRecord, Snapshot, Transaction, Where, ListOptions, ListResult } from "./types";
import { EntityRegistry } from "../models";
import { Text } from "../core/Text";

const COLLECTIONS = EntityRegistry.COLLECTIONS;

export interface BrowserStorageOptions {
  key?: string;
  persistent?: boolean;
  /** Notifie l'UI qu'un pas d'undo « modèle » a été enregistré (timeline unifiée).
      Remplace l'ancien global `noteUndoable` par une injection découplée. */
  onUndoable?: (kind: string) => void;
}

/* Implémentation locale : persistance dans le storage du navigateur
   (sessionStorage par défaut, localStorage si persistant). Snapshot en CACHE
   MÉMOIRE + index primaire Map(id → record) + index secondaires (FieldIndex,
   INDEX_SPEC) maintenus INCRÉMENTALEMENT → lectures sans scan ni re-désérialisation.
   transact() applique tout le lot en UNE écriture. UNDO/REDO : pile bornée de
   snapshots (1 transaction = 1 pas ; saveMeta ne crée pas de pas). */
export class BrowserStorageAdapter extends DataAdapter {
  key: string;
  store: Storage;
  persistent: boolean;
  onUndoable?: (kind: string) => void;
  private _history: Snapshot[];
  private _hidx: number;
  private _cache: Snapshot | null | undefined;
  private _index: Record<string, Map<string, RawRecord>>;
  private _fk: Record<string, FieldIndex>;

  constructor({ key = "netmap.store", persistent = false, onUndoable }: BrowserStorageOptions = {}) {
    super();
    this.key = key;
    this.store = persistent ? window.localStorage : window.sessionStorage;
    this.persistent = persistent;
    this.onUndoable = onUndoable;
    this._history = [];
    this._hidx = -1;
    this._cache = undefined;   // undefined = jamais chargé, null = storage vide
    this._index = {};
    this._fk = {};
  }

  get label(): string { return this.persistent ? "navigateur (local)" : "navigateur (session)"; }

  private _read(): Snapshot | null {
    try { const raw = this.store.getItem(this.key); return raw ? JSON.parse(raw) : null; }
    catch (e) { console.warn("lecture storage a échoué", e); return null; }
  }
  private _write(snap: Snapshot): void { this.store.setItem(this.key, JSON.stringify(snap)); }
  private _blank(): Snapshot {
    const s: Snapshot = { meta: { docName: "", theme: "dark" } };
    COLLECTIONS.forEach((c) => { s[c] = []; });
    return s;
  }

  /* ---- cache + index (reconstruction complète : load/replaceAll/undo/redo) ---- */
  private _setCache(snap: Snapshot | null): void {
    this._cache = snap;
    this._index = {}; this._fk = {};
    COLLECTIONS.forEach((c) => {
      const m = new Map<string, RawRecord>();
      const fk = new FieldIndex(INDEX_SPEC[c] || []);
      (((snap && snap[c]) || []) as RawRecord[]).forEach((r) => { if (r && r.id) { m.set(r.id, r); fk.add(r); } });
      this._index[c] = m; this._fk[c] = fk;
    });
  }
  private _ensureCache(): void { if (this._cache === undefined) this._setCache(this._read()); }

  /* Maintenance INCRÉMENTALE des index après une transaction. */
  private _indexApplyTx(tx: Transaction): void {
    if (!tx) return;
    (tx.deletes || []).forEach((d) => {
      const m = this._index[d.collection]; if (!m) return;
      const old = m.get(d.id);
      if (old) { this._fk[d.collection].remove(old); m.delete(d.id); }
    });
    (tx.updates || []).forEach((u) => {
      const m = this._index[u.collection]; if (!m) return;
      const old = m.get(u.id);
      if (old) this._fk[u.collection].remove(old);
      this._fk[u.collection].add(u.record);
      m.set(u.id, u.record);
    });
    (tx.creates || []).forEach((cr) => {
      const m = this._index[cr.collection]; if (!m) return;
      this._fk[cr.collection].add(cr.record);
      m.set(cr.record.id, cr.record);
    });
  }

  async load(): Promise<Snapshot | null> { const snap = this._read(); this._setCache(snap); return snap; }
  async loadMeta(): Promise<Record<string, any> | null> { this._ensureCache(); return this._cache ? (this._cache.meta || null) : null; }

  /* ---- lectures granulaires (servies par le cache + les index, sans scan) ---- */
  async getOne(collection: string, id: string): Promise<RawRecord | null> {
    this._ensureCache();
    const m = this._index[collection];
    return (m && m.get(id)) || null;
  }
  async getMany(collection: string, ids: string[]): Promise<RawRecord[]> {
    this._ensureCache();
    const m = this._index[collection]; if (!m) return [];
    return (ids || []).map((id) => m.get(id)).filter(Boolean) as RawRecord[];
  }
  async findBy(collection: string, field: string, value: any): Promise<RawRecord[]> {
    this._ensureCache();
    const m = this._index[collection]; if (!m) return [];
    const fk = this._fk[collection];
    if (fk && fk.has(field)) return fk.ids(field, value).map((id) => m.get(id)).filter(Boolean) as RawRecord[];
    return (((this._cache && this._cache[collection]) || []) as RawRecord[]).filter((r) => FieldIndex.valueMatches(r[field], value));
  }
  async count(collection: string, where: Where = null): Promise<number> {
    this._ensureCache();
    if (!where || !Object.keys(where).length) return (((this._cache && this._cache[collection]) || []) as RawRecord[]).length;
    return (await this._whereRows(collection, where)).length;
  }

  /* Candidats d'un `where` : restreint via le 1er champ indexé, puis affine. */
  private async _whereRows(collection: string, where: Record<string, any>): Promise<RawRecord[]> {
    const fields = Object.keys(where);
    const fk = this._fk[collection];
    const idxField = fields.find((f) => fk && fk.has(f));
    let rows: RawRecord[];
    if (idxField) rows = await this.findBy(collection, idxField, where[idxField]);
    else rows = (((this._cache && this._cache[collection]) || []) as RawRecord[]).slice();
    const rest = fields.filter((f) => f !== idxField);
    return rest.length ? rows.filter((r) => rest.every((f) => FieldIndex.valueMatches(r[f], where[f]))) : rows;
  }

  async list(collection: string, { page = 1, pageSize = PAGE_SIZE_DEFAULT, query = "", where = null }: ListOptions = {}): Promise<ListResult> {
    this._ensureCache();
    let rows = (where && Object.keys(where).length)
      ? await this._whereRows(collection, where)
      : (((this._cache && this._cache[collection]) || []) as RawRecord[]).slice();
    if (query && query.trim()) {
      const q = Text.normSearch(query);
      rows = rows.filter((r) => Object.values(r).some((v) => Text.normSearch(v).includes(q)));
    }
    rows.sort((a, b) => String(a.created_date).localeCompare(String(b.created_date)));
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const p = Math.min(Math.max(1, page), pages);
    return { rows: rows.slice((p - 1) * pageSize, p * pageSize), total, page: p, pages, pageSize };
  }

  /* Construit un nouveau snapshot à partir de `before` SANS le muter. */
  private _applyTx(before: Snapshot, tx: Transaction): Snapshot {
    const snap: Snapshot = { meta: (tx && tx.meta) ? tx.meta : before.meta };
    COLLECTIONS.forEach((c) => { snap[c] = Array.isArray(before[c]) ? before[c].slice() : []; });
    if (tx && tx.deletes && tx.deletes.length) {
      const byColl: Record<string, Set<string>> = {};
      tx.deletes.forEach((d) => { (byColl[d.collection] = byColl[d.collection] || new Set()).add(d.id); });
      Object.keys(byColl).forEach((c) => { if (snap[c]) snap[c] = snap[c].filter((o: RawRecord) => !byColl[c].has(o.id)); });
    }
    ((tx && tx.updates) || []).forEach((u) => {
      const arr = snap[u.collection] || (snap[u.collection] = []);
      const i = arr.findIndex((o: RawRecord) => o && o.id === u.id);
      if (i >= 0) arr[i] = u.record; else arr.push(u.record);
    });
    ((tx && tx.creates) || []).forEach((cr) => {
      const arr = snap[cr.collection] || (snap[cr.collection] = []);
      arr.push(cr.record);
    });
    return snap;
  }

  private _pushHistory(snap: Snapshot): void {
    this._history = this._history.slice(0, this._hidx + 1);   // coupe la branche redo
    this._history.push(snap);
    if (this._history.length > HISTORY_MAX) this._history.shift();
    this._hidx = this._history.length - 1;
    this.onUndoable?.("model");   // timeline d'undo unifiée
  }

  async transact(tx: Transaction): Promise<Snapshot> {
    this._ensureCache();
    const before = this._cache || this._blank();
    const hasOps = !!(tx && ((tx.creates && tx.creates.length) || (tx.updates && tx.updates.length) || (tx.deletes && tx.deletes.length)));
    if (this._history.length === 0) { this._history = [before]; this._hidx = 0; }
    const after = this._applyTx(before, tx);
    this._write(after);
    this._cache = after;
    this._indexApplyTx(tx);
    if (hasOps) this._pushHistory(after);
    return after;
  }

  async saveMeta(meta: Record<string, any>): Promise<void> {
    this._ensureCache();
    const s = this._cache || this._blank();
    s.meta = meta;
    this._cache = s;
    this._write(s);
    if (this._hidx >= 0 && this._history[this._hidx]) this._history[this._hidx].meta = meta;
  }

  async replaceAll(state: Snapshot): Promise<void> {
    this._write(state);
    this._setCache(state);
    this._history = [state];
    this._hidx = 0;
  }

  canUndo(): boolean { return this._hidx > 0; }
  canRedo(): boolean { return this._hidx >= 0 && this._hidx < this._history.length - 1; }
  async undo(): Promise<Snapshot | null> {
    if (!this.canUndo()) return null;
    this._hidx--;
    const snap = this._history[this._hidx];
    this._write(snap);
    this._setCache(snap);
    return snap;
  }
  async redo(): Promise<Snapshot | null> {
    if (!this.canRedo()) return null;
    this._hidx++;
    const snap = this._history[this._hidx];
    this._write(snap);
    this._setCache(snap);
    return snap;
  }
  async clearStorage(): Promise<void> { this.store.removeItem(this.key); this._history = []; this._hidx = -1; this._setCache(null); }
}
