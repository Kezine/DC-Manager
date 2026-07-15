import { Schema } from "./constants.js";

/* ---- contrat minimal d'un driver SQLite (satisfait par better-sqlite3 ET par un shim de test) ---- */
export interface SqliteStatement { run(...args: any[]): { changes?: number }; get(...args: any[]): any; all(...args: any[]): any[]; }
export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(source: string): unknown;
  transaction<A extends any[]>(fn: (...a: A) => void): (...a: A) => void;
  close(): void;
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
export interface ImageMeta { id: string; name?: string; u_height?: number; face?: string; with_ears?: boolean; description?: string; type?: string; bytes?: number }

/** Accès aux données : une table par collection (id, data JSON, search, created_date) + meta + images.
    Toute la logique SQL vit ici ; l'API n'en dépend que par cette classe. */
export class Repository {
  private constructor(private readonly db: SqliteDb) {}

  /** Ouvre/initialise la base. `Database` est INJECTÉ (better-sqlite3 en prod, shim en test) → driver découplé. */
  static open(file: string, Database: SqliteCtor): Repository {
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    // Maintenance (audit 2026-07) : timeout anti-SQLITE_BUSY (écriture concurrente / checkpoint / outil externe
    // sur la même base) + `synchronous = NORMAL` (sûr en WAL — perte bornée à la dernière transaction sur coupure
    // de courant, jamais de corruption ; compromis perf ASSUMÉ).
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
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

  /** Ferme le handle SQLite. INDISPENSABLE avant de supprimer le fichier du document : sous Windows,
      supprimer un fichier encore ouvert échoue (EBUSY/EPERM) — cf. `DocumentStore.delete`.
      MAINTENANCE au passage (best-effort) : `PRAGMA optimize` (rafraîchit les statistiques du planificateur —
      recommandation SQLite standard à la fermeture) + `wal_checkpoint(TRUNCATE)` (rapatrie le -wal dans le .db
      et le tronque — sinon un -wal volumineux peut subsister entre deux sessions). */
  close(): void {
    try { this.db.pragma("optimize"); this.db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* base déjà fermée / driver réduit */ }
    this.db.close();
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

  /** Recherche LEAN par champ, pour les `find` de la validation (dépendance inverse V5b + portée V6). Renvoie TOUTES
      les lignes correspondantes, SANS `COUNT(*)`, SANS `ORDER BY`, SANS pagination — le finder n'en a rien à faire :
      il itère l'ensemble. Divise par 2 le nombre de requêtes par `find` (vs `list()` qui fait COUNT + SELECT) et
      supprime un tri inutile → allège le chemin CHAUD (un save de port déclenche plusieurs `find` V6/dependents).
      Model-agnostique : survit tel quel à une future refonte relationnelle (cf. docs/persistance.md). */
  findBy(collection: string, field: string, value: string): Rec[] {
    if (!Schema.isCollection(collection)) return [];
    const w = this.whereClause({ [field]: value });
    return this.db.prepare(`SELECT data FROM "${collection}" WHERE 1=1${w.sql}`).all(...w.args).map((r) => JSON.parse(r.data));
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

  /* ---- maintenance ---- */
  /** IDS d'images RÉFÉRENCÉS par les équipements (champs face_image_* — liste partagée Schema). */
  private referencedImageIds(): Set<string> {
    const out = new Set<string>();
    for (const row of this.db.prepare(`SELECT data FROM "equipments"`).all()) {
      const rec = JSON.parse(row.data);
      for (const f of Schema.EQUIPMENT_FACE_IMAGE_FIELDS) { const v = rec[f]; if (typeof v === "string" && v) out.add(v); }
    }
    return out;
  }

  /** MAINTENANCE (audit 2026-07, constats F/J/K) : PURGE les images ORPHELINES (référencées par AUCUN équipement)
      puis COMPACTE la base — `wal_checkpoint(TRUNCATE)` (rapatrie/tronque le -wal), `PRAGMA optimize` (stats du
      planificateur) et `VACUUM` (rend les pages libres au système de fichiers : remplacements répétés de blobs,
      imports snapshot…). Renvoie le nombre d'images purgées. Opération ADMIN, déclenchée à la demande. */
  maintenance(): { purgedImages: number } {
    const referenced = this.referencedImageIds();
    const orphans = this.db.prepare("SELECT id FROM images").all().map((r) => r.id as string).filter((id) => !referenced.has(id));
    const del = this.db.prepare("DELETE FROM images WHERE id = ?");
    this.db.transaction(() => { for (const id of orphans) del.run(id); })();
    try { this.db.pragma("wal_checkpoint(TRUNCATE)"); this.db.pragma("optimize"); } catch { /* driver réduit */ }
    this.db.exec("VACUUM");   // hors transaction (SQLite l'interdit en transaction)
    return { purgedImages: orphans.length };
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
    const cur = this.db.prepare("SELECT meta, blob, bytes FROM images WHERE id = ?").get(id);
    const curMeta: Rec = cur ? JSON.parse(cur.meta) : {};
    const b = blob || (cur ? cur.blob : null);
    const bytes = blob ? blob.length : (cur ? cur.bytes : 0);
    // RÉVISION du BINAIRE (jeton de cache-busting client `?v=`) : incrémentée UNIQUEMENT quand un NOUVEAU blob
    // arrive — l'ancien jeton (la taille en octets) ne voyait pas un remplacement par un fichier de MÊME taille
    // (URL inchangée → texture/cache navigateur périmés). Une édition de méta seule ne bump pas.
    const rev = blob ? (((curMeta.rev as number) | 0) + 1) : ((curMeta.rev as number) | 0);
    this.db.prepare(`INSERT INTO images (id, meta, blob, bytes) VALUES (@id, @meta, @blob, @bytes)
                     ON CONFLICT(id) DO UPDATE SET meta = @meta, blob = @blob, bytes = @bytes`)
      .run({ id, meta: JSON.stringify({ ...meta, id, rev }), blob: b, bytes });
  }
  deleteImage(id: string): void { this.db.prepare("DELETE FROM images WHERE id = ?").run(id); }
}
