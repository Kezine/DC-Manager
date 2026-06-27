import { Schema } from "./constants.js";

/* ---- contrat minimal d'un driver SQLite (satisfait par better-sqlite3 ET par un shim de test) ---- */
export interface SqliteStatement { run(...args: any[]): { changes?: number }; get(...args: any[]): any; all(...args: any[]): any[]; }
export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(source: string): unknown;
  transaction<A extends any[]>(fn: (...a: A) => void): (...a: A) => void;
}
export type SqliteCtor = new (file: string) => SqliteDb;

export type Rec = Record<string, any>;
export interface Snapshot { meta?: Rec; [collection: string]: any }
export interface Tx {
  creates?: { collection: string; record: Rec }[];
  updates?: { collection: string; record: Rec }[];
  deletes?: { collection: string; id: string }[];
  meta?: Rec;
}
export interface ListOpts { page?: number; pageSize?: number; query?: string; where?: Rec | null; ids?: string[] | null }
export interface ListResult { rows: Rec[]; total: number; page: number; pages: number; pageSize: number }
export interface ImageMeta { id: string; name?: string; u_height?: number; face?: string; description?: string; type?: string; bytes?: number }

/** Accès aux données : une table par collection (id, data JSON, search, created_date) + meta + images.
    Toute la logique SQL vit ici ; l'API n'en dépend que par cette classe. */
export class Repository {
  private constructor(private readonly db: SqliteDb) {}

  /** Ouvre/initialise la base. `Database` est INJECTÉ (better-sqlite3 en prod, shim en test) → driver découplé. */
  static open(file: string, Database: SqliteCtor): Repository {
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    for (const c of Schema.COLLECTIONS) {
      db.exec(`CREATE TABLE IF NOT EXISTS "${c}" (
        id TEXT PRIMARY KEY, data TEXT NOT NULL, search TEXT NOT NULL DEFAULT '', created_date TEXT, updated_rev INTEGER NOT NULL DEFAULT 0
      )`);
      // migration : `updated_rev` = révision du document au dernier écrit de CETTE ligne (verrou optimiste par entité).
      try { db.exec(`ALTER TABLE "${c}" ADD COLUMN updated_rev INTEGER NOT NULL DEFAULT 0`); } catch { /* colonne déjà présente */ }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, meta TEXT NOT NULL, blob BLOB, bytes INTEGER NOT NULL DEFAULT 0)`);
    return new Repository(db);
  }

  /** Texte de recherche normalisé (parité Schema.normSearch sur toutes les valeurs). */
  private searchText(rec: Rec): string {
    return Object.values(rec || {})
      .map((v) => (Array.isArray(v) ? v.map((x) => Schema.normSearch(x)).join(" ") : Schema.normSearch(v)))
      .join(" ");
  }

  /* ---- écritures (CRUD unitaire ET /transact) ---- */
  /** `rev` = révision du document portée par cette écriture → estampillée sur la ligne (`updated_rev`) pour le
      verrou optimiste par entité (cf. `conflicts`). 0 = écriture non versionnée (import/seed). */
  upsert(collection: string, record: Rec, rev = 0): void {
    if (!Schema.isCollection(collection)) throw new Error("collection inconnue: " + collection);
    if (!record || !record.id) throw new Error("record sans id");
    this.db.prepare(`INSERT INTO "${collection}" (id, data, search, created_date, updated_rev) VALUES (@id, @data, @search, @created, @rev)
                     ON CONFLICT(id) DO UPDATE SET data = @data, search = @search, created_date = @created, updated_rev = @rev`)
      .run({ id: record.id, data: JSON.stringify(record), search: this.searchText(record), created: record.created_date || null, rev });
  }
  delete(collection: string, id: string): void {
    if (!Schema.isCollection(collection)) throw new Error("collection inconnue: " + collection);
    this.db.prepare(`DELETE FROM "${collection}" WHERE id = ?`).run(id);
  }

  /** VERROU OPTIMISTE (par entité) : parmi `targets`, renvoie celles MODIFIÉES après `baseRev`
      (`updated_rev > baseRev`) — c.-à-d. qu'un autre client a écrit dessus depuis le snapshot du client courant.
      Liste vide = aucune collision → l'écriture peut s'appliquer. Les entités absentes (création / déjà supprimée)
      ne comptent pas comme conflit (résurrection sur update-after-delete = limite connue, hors périmètre). */
  conflicts(targets: Array<{ collection: string; id: string }>, baseRev: number): Array<{ collection: string; id: string; rev: number }> {
    const out: Array<{ collection: string; id: string; rev: number }> = [];
    for (const t of targets) {
      if (!Schema.isCollection(t.collection) || !t.id) continue;
      const row = this.db.prepare(`SELECT updated_rev FROM "${t.collection}" WHERE id = ?`).get(t.id);
      if (row && (row.updated_rev as number) > baseRev) out.push({ collection: t.collection, id: t.id, rev: row.updated_rev as number });
    }
    return out;
  }

  /* ---- lectures ---- */
  getOne(collection: string, id: string): Rec | null {
    if (!Schema.isCollection(collection)) return null;
    const row = this.db.prepare(`SELECT data FROM "${collection}" WHERE id = ?`).get(id);
    return row ? JSON.parse(row.data) : null;
  }
  getMany(collection: string, ids: string[]): Rec[] {
    if (!Schema.isCollection(collection) || !ids.length) return [];
    const ph = ids.map(() => "?").join(",");
    return this.db.prepare(`SELECT data FROM "${collection}" WHERE id IN (${ph})`).all(...ids).map((r) => JSON.parse(r.data));
  }

  /** Clause WHERE d'un filtre `where` (égalité ; "null" = non rattaché ; champs tableaux = appartenance). */
  private whereClause(where: Rec | null): { sql: string; args: any[] } {
    const sql: string[] = [], args: any[] = [];
    for (const [field, raw] of Object.entries(where || {})) {
      const val = Array.isArray(raw) ? raw[0] : raw;
      const path = "'$." + field.replace(/'/g, "") + "'";
      if (Schema.isArrayField(field)) {
        if (val === "null") sql.push(`(json_extract(data, ${path}) IS NULL OR json_array_length(json_extract(data, ${path})) = 0)`);
        else { sql.push(`EXISTS (SELECT 1 FROM json_each(data, ${path}) WHERE CAST(value AS TEXT) = ?)`); args.push(String(val)); }
      } else if (val === "null") {
        sql.push(`json_extract(data, ${path}) IS NULL`);
      } else {
        sql.push(`CAST(json_extract(data, ${path}) AS TEXT) = ?`); args.push(String(val));
      }
    }
    return { sql: sql.length ? " AND " + sql.join(" AND ") : "", args };
  }

  /** Liste paginée : { rows, total, page, pages, pageSize }. q = plein-texte ; tri created_date. */
  list(collection: string, { page = 1, pageSize = Schema.PAGE_SIZE_DEFAULT, query = "", where = null, ids = null }: ListOpts = {}): ListResult {
    if (!Schema.isCollection(collection)) return { rows: [], total: 0, page: 1, pages: 1, pageSize };
    if (ids && ids.length) return { rows: this.getMany(collection, ids), total: ids.length, page: 1, pages: 1, pageSize };
    let clause = "WHERE 1=1"; const args: any[] = [];
    if (query && query.trim()) { clause += " AND search LIKE ?"; args.push("%" + Schema.normSearch(query.trim()) + "%"); }
    const w = this.whereClause(where); clause += w.sql; args.push(...w.args);
    const total = this.db.prepare(`SELECT COUNT(*) n FROM "${collection}" ${clause}`).get(...args).n as number;
    const ps = Math.max(1, pageSize | 0), pages = Math.max(1, Math.ceil(total / ps)), p = Math.min(Math.max(1, page | 0), pages);
    const rows = this.db.prepare(`SELECT data FROM "${collection}" ${clause} ORDER BY created_date ASC, id ASC LIMIT ? OFFSET ?`)
      .all(...args, ps, (p - 1) * ps).map((r) => JSON.parse(r.data));
    return { rows, total, page: p, pages, pageSize: ps };
  }

  /* ---- meta ---- */
  getMeta(): Rec { const row = this.db.prepare(`SELECT data FROM meta WHERE id = 1`).get(); return row ? JSON.parse(row.data) : {}; }
  setMeta(meta: Rec): void { this.db.prepare(`INSERT INTO meta (id, data) VALUES (1, @d) ON CONFLICT(id) DO UPDATE SET data = @d`).run({ d: JSON.stringify(meta || {}) }); }

  /* ---- lot atomique (POST /transact) ---- */
  transact({ creates = [], updates = [], deletes = [], meta }: Tx = {}, rev = 0): void {
    this.db.transaction(() => {
      for (const d of deletes) this.delete(d.collection, d.id);
      for (const u of updates) this.upsert(u.collection, u.record, rev);
      for (const c of creates) this.upsert(c.collection, c.record, rev);
      if (meta) this.setMeta(meta);
    })();
  }

  /* ---- import complet (PUT /snapshot) ---- */
  replaceSnapshot(snapshot: Snapshot, rev = 0): void {
    this.db.transaction(() => {
      for (const c of Schema.COLLECTIONS) {
        this.db.prepare(`DELETE FROM "${c}"`).run();
        for (const rec of (snapshot[c] || [])) this.upsert(c, rec, rev);
      }
      if (snapshot.meta) this.setMeta(snapshot.meta);
    })();
  }

  /* ---- images (blobs) ---- */
  listImages(): ImageMeta[] {
    return this.db.prepare("SELECT id, meta, bytes FROM images").all().map((x) => ({ ...JSON.parse(x.meta), id: x.id, bytes: x.bytes }));
  }
  getImageMeta(id: string): ImageMeta | null {
    const x = this.db.prepare("SELECT id, meta, bytes FROM images WHERE id = ?").get(id);
    return x ? { ...JSON.parse(x.meta), id: x.id, bytes: x.bytes } : null;
  }
  getImageBlob(id: string): { type: string; blob: Buffer } | null {
    const x = this.db.prepare("SELECT meta, blob FROM images WHERE id = ?").get(id);
    if (!x || !x.blob) return null;
    return { type: (JSON.parse(x.meta).type as string) || "application/octet-stream", blob: Buffer.from(x.blob) };
  }
  putImage(id: string, meta: Rec, blob: Buffer | null): void {
    const cur = this.db.prepare("SELECT blob, bytes FROM images WHERE id = ?").get(id);
    const b = blob || (cur ? cur.blob : null);
    const bytes = blob ? blob.length : (cur ? cur.bytes : 0);
    this.db.prepare(`INSERT INTO images (id, meta, blob, bytes) VALUES (@id, @meta, @blob, @bytes)
                     ON CONFLICT(id) DO UPDATE SET meta = @meta, blob = @blob, bytes = @bytes`)
      .run({ id, meta: JSON.stringify({ ...meta, id }), blob: b, bytes });
  }
  deleteImage(id: string): void { this.db.prepare("DELETE FROM images WHERE id = ?").run(id); }
}
