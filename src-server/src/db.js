import { COLLECTIONS, ARRAY_FIELDS, isCollection, normSearch, PAGE_SIZE_DEFAULT } from "./constants.js";

/** Ouvre/initialise la base : une table par collection (id, data JSON, search, created_date) + meta + images.
    `Database` est INJECTÉ (better-sqlite3 en prod ; un shim compatible pour les tests) → driver découplé. */
export function openDb(file, Database) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  for (const c of COLLECTIONS) {
    db.exec(`CREATE TABLE IF NOT EXISTS "${c}" (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      search TEXT NOT NULL DEFAULT '',
      created_date TEXT
    )`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, meta TEXT NOT NULL, blob BLOB, bytes INTEGER NOT NULL DEFAULT 0)`);
  return db;
}

/** Texte de recherche normalisé d'un enregistrement (parité Text.normSearch sur toutes les valeurs). */
function searchText(rec) {
  return Object.values(rec || {})
    .map((v) => (Array.isArray(v) ? v.map(normSearch).join(" ") : normSearch(v)))
    .join(" ");
}

/* ---- écritures (utilisées par CRUD unitaire ET /transact) ---- */
export function upsertRecord(db, collection, record) {
  if (!isCollection(collection)) throw new Error("collection inconnue: " + collection);
  if (!record || !record.id) throw new Error("record sans id");
  db.prepare(`INSERT INTO "${collection}" (id, data, search, created_date) VALUES (@id, @data, @search, @created)
              ON CONFLICT(id) DO UPDATE SET data = @data, search = @search, created_date = @created`)
    .run({ id: record.id, data: JSON.stringify(record), search: searchText(record), created: record.created_date || null });
}
export function deleteRecord(db, collection, id) {
  if (!isCollection(collection)) throw new Error("collection inconnue: " + collection);
  db.prepare(`DELETE FROM "${collection}" WHERE id = ?`).run(id);
}

/* ---- lectures ---- */
export function getOne(db, collection, id) {
  if (!isCollection(collection)) return null;
  const row = db.prepare(`SELECT data FROM "${collection}" WHERE id = ?`).get(id);
  return row ? JSON.parse(row.data) : null;
}
export function getMany(db, collection, ids) {
  if (!isCollection(collection) || !ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  return db.prepare(`SELECT data FROM "${collection}" WHERE id IN (${ph})`).all(...ids).map((r) => JSON.parse(r.data));
}

/** Construit la clause WHERE d'un filtre `where` (égalité ; "null" = non rattaché ; champs tableaux = appartenance). */
function whereClause(where) {
  const sql = [], args = [];
  for (const [field, raw] of Object.entries(where || {})) {
    const val = Array.isArray(raw) ? raw[0] : raw;
    const path = "'$." + field.replace(/'/g, "") + "'";
    if (ARRAY_FIELDS.has(field)) {
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

/** Liste paginée : { rows, total, page, pages, pageSize }. q = recherche plein-texte ; tri created_date. */
export function listRecords(db, collection, { page = 1, pageSize = PAGE_SIZE_DEFAULT, query = "", where = null, ids = null } = {}) {
  if (!isCollection(collection)) return { rows: [], total: 0, page: 1, pages: 1, pageSize };
  if (ids && ids.length) return { rows: getMany(db, collection, ids), total: ids.length, page: 1, pages: 1, pageSize };
  let clause = "WHERE 1=1", args = [];
  if (query && query.trim()) { clause += " AND search LIKE ?"; args.push("%" + normSearch(query.trim()) + "%"); }
  const w = whereClause(where); clause += w.sql; args.push(...w.args);
  const total = db.prepare(`SELECT COUNT(*) n FROM "${collection}" ${clause}`).get(...args).n;
  const ps = Math.max(1, pageSize | 0), pages = Math.max(1, Math.ceil(total / ps)), p = Math.min(Math.max(1, page | 0), pages);
  const rows = db.prepare(`SELECT data FROM "${collection}" ${clause} ORDER BY created_date ASC, id ASC LIMIT ? OFFSET ?`)
    .all(...args, ps, (p - 1) * ps).map((r) => JSON.parse(r.data));
  return { rows, total, page: p, pages, pageSize: ps };
}

/* ---- meta ---- */
export function getMeta(db) { const row = db.prepare(`SELECT data FROM meta WHERE id = 1`).get(); return row ? JSON.parse(row.data) : {}; }
export function setMeta(db, meta) { db.prepare(`INSERT INTO meta (id, data) VALUES (1, @d) ON CONFLICT(id) DO UPDATE SET data = @d`).run({ d: JSON.stringify(meta || {}) }); }

/* ---- transaction atomique (POST /transact) ---- */
export function applyTransaction(db, { creates = [], updates = [], deletes = [], meta } = {}) {
  const run = db.transaction(() => {
    for (const d of deletes) deleteRecord(db, d.collection, d.id);
    for (const u of updates) upsertRecord(db, u.collection, u.record);
    for (const c of creates) upsertRecord(db, c.collection, c.record);
    if (meta) setMeta(db, meta);
  });
  run();
}

/* ---- snapshot (PUT /snapshot : import dans un workspace) ---- */
export function replaceSnapshot(db, snapshot) {
  const run = db.transaction(() => {
    for (const c of COLLECTIONS) {
      db.prepare(`DELETE FROM "${c}"`).run();
      for (const rec of (snapshot[c] || [])) upsertRecord(db, c, rec);
    }
    if (snapshot.meta) setMeta(db, snapshot.meta);
  });
  run();
}
