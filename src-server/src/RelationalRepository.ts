/* ============================================================================
   REPOSITORY RELATIONNEL — implémentation COLONNES du contrat `RepositoryContract`.

   Implémente `RepositoryContract` (db.ts) sur le schéma relationnel GÉNÉRÉ par
   `src-shared/RelationalSchema` (migration DB — cadrage
   `.notes/toDos/migration-db-relationnelle-cadrage-2026-07-31.md`). C'est le
   SEUL chemin de production : `DocumentStore.repo()` l'ouvre (après migration
   des fichiers legacy par `LegacyMigration`) et `api.ts`/`documents.ts` la
   consomment par le TYPE de contrat `RepositoryContract`. Le `implements`
   ci-dessous fait du COMPILATEUR le garde de conformité de la surface.

   Historique : le modèle blob JSON (`Repository`, ex-db.ts) a précédé cette
   implémentation. Sa parité de COMPORTEMENT a été PROUVÉE corpus contre corpus
   (lot L3) AVANT son retrait (lot L5). Le « contrat des colonnes strictes »
   décrit ci-dessous se lit donc comme les décisions PROPRES à ce schéma, non
   plus comme un « diff » d'un modèle disparu — les mentions du blob qui
   subsistent renvoient à cet historique (détail dans git / docs/persistance.md).

   ── Le CONTRAT des colonnes strictes ───────────────────────────────────────
   • ÉCRITURE : seules les colonnes DÉRIVÉES de la spec (`COLLECTION_SPECS`,
     ordre du DDL) + `id` + les 4 colonnes d'audit sont persistées. Toute clé
     INCONNUE du record (hors spec, hors audit, hors id) est SILENCIEUSEMENT
     IGNORÉE : la spec est COMPLÈTE depuis la régularisation D3a (`1f41504`,
     verrou `test-spec-completude.js`), donc aucun champ légitime ne peut être
     perdu — les seuls disparus sont les legacy `equipments.face_image` /
     `face_image_rear` (toujours null dans les corpus), et c'est VOULU : leur
     purge est actée pour la migration L4.
   • LECTURE : le record est reconstruit sous sa forme NORMALISÉE — CHAQUE
     champ de la spec est présent, RE-TYPÉ d'après elle (INTEGER 0/1 → booléen,
     TEXT JSON → tableau/objet via JSON.parse, NULL SQL → null). `id` et les
     4 champs d'audit ne sont inclus QUE s'ils sont non-NULL (parité blob : un
     record écrit en mode fichier n'a jamais eu de `created_by` — on ne fait
     pas apparaître des clés null qui n'existaient pas). `search` et
     `updated_rev` sont des colonnes OPÉRATIONNELLES : jamais dans le record.
   • FILTRES (`whereClause`) : même sémantique que le blob (égalité TEXTUELLE,
     sentinelle "null", appartenance aux champs tableaux via `json_each` — la
     colonne est du TEXT JSON, `json_each` marche dessus, et rend 0 ligne sur
     une colonne NULL, mesuré). DEUX décisions propres aux colonnes strictes :
     - un champ de filtre INCONNU de la spec → AUCUNE ligne (`1=0`). Le blob
       renvoyait 0 ligne pour une valeur (json_extract NULL ≠ val) mais TOUTES
       les lignes pour la sentinelle "null" (IS NULL vrai partout) — un
       comportement ACCIDENTEL dont aucun émetteur réel ne dépend (mesure L0
       §3.3 : les filtres réellement émis portent sur les champs d'INDEX_SPEC).
     - l'égalité ne CASTe que les colonnes NON-TEXT : le blob comparait
       `CAST(json_extract(…) AS TEXT) = ?` partout ; sur une colonne TEXT,
       `"col" = ?` (l'argument arrive déjà en string HTTP) est la MÊME
       comparaison texte-à-texte SANS le CAST — et c'est la condition du gain :
       `CAST("col" AS TEXT)` est une EXPRESSION, le planificateur n'utilise
       alors JAMAIS l'index (mesuré : SCAN au lieu de SEARCH…USING INDEX, la
       raison d'être du chantier s'évaporerait). Les colonnes NUMERIC/INTEGER
       (nombres, booléens — aucune n'est indexée) GARDENT le CAST pour la
       parité stricte : un booléen se filtre "1"/"0" comme dans le blob, et
       "42.0" ne matche pas un 42 (comparaison de textes, pas de nombres).

   La preuve du gain d'index est instrumentée par `explainFindBy` (EXPLAIN
   QUERY PLAN du SQL EXACT de `findBy`) — seule méthode publique AJOUTÉE au
   contrat (diagnostic, consommée par les tests et le bilan L4).

   Les tables `meta` (1 ligne JSON) et `images` (blobs) sont HORS migration
   (cadrage §1) : DDL et mécanique repris à l'IDENTIQUE de `db.ts`.
   ============================================================================ */

import { Schema } from "./constants.js";
import { RelationalSchema } from "../../src-shared/RelationalSchema.js";
import { COLLECTION_SPECS, type FieldSpec } from "../../src-shared/DataValidation.js";
import type {
  RepositoryContract, SqliteCtor, SqliteDb, SqliteStatement,
  Rec, Snapshot, Tx, ListOpts, ListResult, ImageMeta,
} from "./db.js";

/** Accès aux données sur schéma RELATIONNEL : une table par collection à colonnes typées dérivées de la
    spec (+ meta + images). Implémente `RepositoryContract` — cf. l'en-tête pour les décisions du schéma. */
export class RelationalRepository implements RepositoryContract {
  /** Colonnes d'AUDIT, dans l'ordre du DDL. ⚠ Duplication ASSUMÉE de `RelationalSchema.AUDIT_COLUMNS`
      (privée là-bas — ce lot ne retouche pas src-shared/, figé par L1) : toute divergence casserait
      immédiatement l'upsert (colonnes introuvables), le couple est donc verrouillé par les tests. */
  private static readonly AUDIT_COLUMNS: readonly string[] = ["created_by", "updated_by", "created_date", "updated_date"];

  /** Requêtes d'upsert PRÉPARÉES, une par collection (dérivées de la spec au premier upsert puis mises en
      cache : le chemin d'écriture chaud — /transact, snapshot — ne re-prépare jamais un INSERT à ~60 colonnes). */
  private readonly upsertStatements = new Map<string, SqliteStatement>();

  private constructor(private readonly db: SqliteDb) {}

  /** Ouvre/initialise la base. `Database` est INJECTÉ (better-sqlite3 en prod, réel aussi en test — le shim
      des tests blob ne parle pas ce SQL). Le schéma vient INTÉGRALEMENT de `RelationalSchema.allDdl()` :
      cette classe ne fabrique AUCUN DDL de collection elle-même (meta/images exceptées, hors migration). */
  static open(file: string, Database: SqliteCtor): RelationalRepository {
    const db = new Database(file);
    // Mêmes réglages d'exploitation que le blob (audit 2026-07) : WAL + anti-SQLITE_BUSY + NORMAL (sûr en WAL).
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
    for (const ddl of RelationalSchema.allDdl()) db.exec(ddl);
    // Tables HORS migration (cadrage §1) — DDL repris à l'IDENTIQUE de db.ts.
    db.exec(`CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, meta TEXT NOT NULL, blob BLOB, bytes INTEGER NOT NULL DEFAULT 0)`);
    return new RelationalRepository(db);
  }

  /** Enveloppe un handle DÉJÀ OUVERT — SANS pragma ni DDL (l'appelant les gère). Point d'entrée de la
      MIGRATION legacy (`LegacyMigration`, lot L4) : l'upsert relationnel (sérialisation par type de spec,
      colonne `search`, `updated_rev`) doit s'exécuter DANS la transaction de migration, sur le MÊME handle
      que les RENAME/DDL — le dupliquer là-bas ferait diverger deux mappings de colonnes en silence. */
  static onOpenHandle(db: SqliteDb): RelationalRepository {
    return new RelationalRepository(db);
  }

  /** Ferme le handle SQLite (même mécanique que le blob : INDISPENSABLE avant suppression du fichier —
      Windows EBUSY — + maintenance best-effort `optimize` / checkpoint TRUNCATE à la fermeture). */
  close(): void {
    try { this.db.pragma("optimize"); this.db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* base déjà fermée / driver réduit */ }
    this.db.close();
  }

  /* ---- (dé)sérialisation par type de spec ---- */

  /** Identifiant SQL entre guillemets doubles — même robustesse que le générateur (un champ de spec peut
      coïncider avec un mot-clé SQL : `row` de racks). N'est JAMAIS appliqué à un nom hors spec/listes fixes. */
  private static quote(identifier: string): string { return '"' + identifier + '"'; }

  /** Valeur JS → valeur de COLONNE, d'après le type de la spec : `boolean`→0/1, `string[]`/`json`→texte
      JSON, `string`/`number`→tels quels, `undefined`/`null`→NULL SQL. */
  private static toColumn(spec: FieldSpec, value: unknown): unknown {
    if (value === undefined || value === null) return null;
    switch (spec.type) {
      case "boolean":  return value ? 1 : 0;
      case "string[]":
      case "json":     return JSON.stringify(value);
      default:         return value;   // string · number : le driver et l'affinité font le reste
    }
  }

  /** Valeur de COLONNE → valeur JS re-typée d'après la spec (miroir de `toColumn`). Un booléen relu 1
      redevient `true` (un 0/1 brut casserait la validation client et les `===` — piège du cadrage §6). */
  private static fromColumn(spec: FieldSpec, raw: unknown): unknown {
    if (raw === null || raw === undefined) return null;
    switch (spec.type) {
      case "boolean":  return !!raw;
      case "string[]":
      case "json":     return JSON.parse(String(raw));
      default:         return raw;   // NUMERIC : better-sqlite3 rend des NOMBRES JS (entier exact — prouvé par test)
    }
  }

  /** Reconstruit le record NORMALISÉ depuis une ligne : chaque champ de la spec présent (re-typé, NULL→null),
      `id` + audit inclus SEULEMENT si non-NULL, `search`/`updated_rev` JAMAIS (cf. contrat en tête). */
  private rebuild(collection: string, row: Rec): Rec {
    const fields = COLLECTION_SPECS[collection].fields;
    const record: Rec = {};
    if (row.id != null) record.id = row.id;
    for (const [field, spec] of Object.entries(fields)) record[field] = RelationalRepository.fromColumn(spec, row[field]);
    for (const audit of RelationalRepository.AUDIT_COLUMNS) { if (row[audit] != null) record[audit] = row[audit]; }
    return record;
  }

  /** Texte de recherche normalisé alimentant la colonne `search` (recherche LIKE) : `Object.values` du
      record ENTRANT (clés inconnues incluses — elles participent au plein-texte), `Schema.normSearch`
      partout, tableaux joints par espace. Recalculé à CHAQUE upsert (le `search` n'est jamais relu dans le
      record). */
  private searchText(rec: Rec): string {
    return Object.values(rec || {})
      .map((v) => (Array.isArray(v) ? v.map((x) => Schema.normSearch(x)).join(" ") : Schema.normSearch(v)))
      .join(" ");
  }

  /* ---- écritures (CRUD unitaire ET /transact) ---- */

  /** INSERT … ON CONFLICT(id) DO UPDATE préparé pour `collection`, DÉRIVÉ de la spec (colonnes dans l'ordre
      du DDL : id, champs de spec, audit, search, updated_rev), préparé UNE fois puis mis en cache. */
  private upsertStatementFor(collection: string): SqliteStatement {
    const cached = this.upsertStatements.get(collection);
    if (cached) return cached;
    const columns = ["id", ...Object.keys(COLLECTION_SPECS[collection].fields), ...RelationalRepository.AUDIT_COLUMNS, "search", "updated_rev"]
      .map((c) => RelationalRepository.quote(c));
    const sql = `INSERT INTO ${RelationalRepository.quote(collection)} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
                 ON CONFLICT(id) DO UPDATE SET ${columns.slice(1).map((c) => c + " = excluded." + c).join(", ")}`;
    const statement = this.db.prepare(sql);
    this.upsertStatements.set(collection, statement);
    return statement;
  }

  /** `rev` = révision du document portée par cette écriture → estampillée sur `updated_rev` (verrou
      optimiste par entité, cf. `conflicts`). 0 = écriture non versionnée (import/seed) — comme le blob.
      Les 4 champs d'audit viennent DU RECORD (posés par AuditStamp côté api) ; absents → NULL. Toute clé
      hors spec/audit/id est IGNORÉE (contrat des colonnes strictes, cf. en-tête). */
  upsert(collection: string, record: Rec, rev = 0): void {
    if (!Schema.isCollection(collection)) throw new Error("collection inconnue: " + collection);
    if (!record || !record.id) throw new Error("record sans id");
    const fields = COLLECTION_SPECS[collection].fields;
    const values: unknown[] = [record.id];
    for (const [field, spec] of Object.entries(fields)) values.push(RelationalRepository.toColumn(spec, record[field]));
    for (const audit of RelationalRepository.AUDIT_COLUMNS) values.push(record[audit] == null ? null : record[audit]);
    values.push(this.searchText(record));   // recalculée à CHAQUE upsert (parité blob)
    values.push(rev);
    this.upsertStatementFor(collection).run(...values);
  }

  delete(collection: string, id: string): void {
    if (!Schema.isCollection(collection)) throw new Error("collection inconnue: " + collection);
    this.db.prepare(`DELETE FROM ${RelationalRepository.quote(collection)} WHERE id = ?`).run(id);
  }

  /** VERROU OPTIMISTE (par entité) — mécanique et sémantique IDENTIQUES au blob : parmi `targets`, renvoie
      celles écrites APRÈS `baseRev` ; absentes (création / déjà supprimée) = pas de conflit. */
  conflicts(targets: Array<{ collection: string; id: string }>, baseRev: number): Array<{ collection: string; id: string; rev: number }> {
    const out: Array<{ collection: string; id: string; rev: number }> = [];
    for (const t of targets) {
      if (!Schema.isCollection(t.collection) || !t.id) continue;
      const row = this.db.prepare(`SELECT updated_rev FROM ${RelationalRepository.quote(t.collection)} WHERE id = ?`).get(t.id);
      if (row && (row.updated_rev as number) > baseRev) out.push({ collection: t.collection, id: t.id, rev: row.updated_rev as number });
    }
    return out;
  }

  /* ---- lectures ---- */

  getOne(collection: string, id: string): Rec | null {
    if (!Schema.isCollection(collection)) return null;
    const row = this.db.prepare(`SELECT * FROM ${RelationalRepository.quote(collection)} WHERE id = ?`).get(id);
    return row ? this.rebuild(collection, row) : null;
  }

  getMany(collection: string, ids: string[]): Rec[] {
    if (!Schema.isCollection(collection) || !ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db.prepare(`SELECT * FROM ${RelationalRepository.quote(collection)} WHERE id IN (${placeholders})`)
      .all(...ids).map((row) => this.rebuild(collection, row));
  }

  /** Clause WHERE d'un filtre `where` SUR COLONNES — parité de sémantique avec le blob (égalité textuelle ;
      "null" = non rattaché ; champs de `Schema.ARRAY_FIELDS` = appartenance), aux deux décisions près
      documentées en tête (champ inconnu → `1=0` ; CAST réservé aux colonnes non-TEXT pour préserver
      l'index). Champ CONNU = spec + `id` + audit (tous colonnes) — `hasOwnProperty` et non un accès
      direct : un nom hérité (« constructor ») ne doit pas passer pour un champ de spec. */
  private whereClause(collection: string, where: Rec | null): { sql: string; args: any[] } {
    const fields = COLLECTION_SPECS[collection].fields;
    const sql: string[] = [], args: any[] = [];
    for (const [field, raw] of Object.entries(where || {})) {
      const val = Array.isArray(raw) ? raw[0] : raw;
      const spec = Object.prototype.hasOwnProperty.call(fields, field) ? fields[field] : undefined;
      if (!spec && field !== "id" && !RelationalRepository.AUDIT_COLUMNS.includes(field)) {
        // Champ INCONNU des colonnes strictes → aucune ligne (décision documentée en tête — le « match
        // tout » accidentel du blob sur la sentinelle "null" n'avait aucun émetteur réel, mesure L0 §3.3).
        sql.push("1=0");
        continue;
      }
      const column = RelationalRepository.quote(field);
      if (Schema.isArrayField(field)) {
        // Colonne TEXT JSON : json_each marche dessus (0 ligne si NULL — mesuré), comme sur le blob.
        if (val === "null") sql.push(`(${column} IS NULL OR json_array_length(${column}) = 0)`);
        else { sql.push(`EXISTS (SELECT 1 FROM json_each(${column}) WHERE CAST(value AS TEXT) = ?)`); args.push(String(val)); }
      } else if (val === "null") {
        sql.push(`${column} IS NULL`);
      } else if (!spec || spec.type === "string") {
        // Colonne TEXT (spec string, id, audit) : égalité DIRECTE = même comparaison texte-à-texte que le
        // CAST du blob (l'argument HTTP est déjà une string), et la SEULE forme que l'index sait servir.
        sql.push(`${column} = ?`); args.push(String(val));
      } else {
        // Colonne NUMERIC/INTEGER (number, boolean) ou TEXT JSON (json) : CAST conservé — parité STRICTE
        // du blob (booléen filtré "1"/"0", "42.0" ≠ 42) ; aucune de ces colonnes n'est indexée.
        sql.push(`CAST(${column} AS TEXT) = ?`); args.push(String(val));
      }
    }
    return { sql: sql.length ? " AND " + sql.join(" AND ") : "", args };
  }

  /** Liste paginée : { rows, total, page, pages, pageSize } — COUNT + LIKE sur `search` + whereClause +
      tri `created_date ASC, id ASC` + pagination, et court-circuit `ids` → getMany : parité stricte blob. */
  list(collection: string, { page = 1, pageSize = Schema.PAGE_SIZE_DEFAULT, query = "", where = null, ids = null }: ListOpts = {}): ListResult {
    if (!Schema.isCollection(collection)) return { rows: [], total: 0, page: 1, pages: 1, pageSize };
    if (ids && ids.length) return { rows: this.getMany(collection, ids), total: ids.length, page: 1, pages: 1, pageSize };
    let clause = "WHERE 1=1"; const args: any[] = [];
    if (query && query.trim()) { clause += " AND search LIKE ?"; args.push("%" + Schema.normSearch(query.trim()) + "%"); }
    const w = this.whereClause(collection, where); clause += w.sql; args.push(...w.args);
    const total = this.db.prepare(`SELECT COUNT(*) n FROM ${RelationalRepository.quote(collection)} ${clause}`).get(...args).n as number;
    const ps = Math.max(1, pageSize | 0), pages = Math.max(1, Math.ceil(total / ps)), p = Math.min(Math.max(1, page | 0), pages);
    const rows = this.db.prepare(`SELECT * FROM ${RelationalRepository.quote(collection)} ${clause} ORDER BY created_date ASC, id ASC LIMIT ? OFFSET ?`)
      .all(...args, ps, (p - 1) * ps).map((row) => this.rebuild(collection, row));
    return { rows, total, page: p, pages, pageSize: ps };
  }

  /** SQL de `findBy` — factorisé pour qu'`explainFindBy` prouve le plan du SQL EXACT exécuté (pas d'une
      reconstruction du test qui pourrait diverger en silence). */
  private findBySql(collection: string, whereSql: string): string {
    return `SELECT * FROM ${RelationalRepository.quote(collection)} WHERE 1=1${whereSql}`;
  }

  /** Recherche LEAN par champ (les `find` de la validation V5b/V6) : toutes les lignes, SANS COUNT/ORDER/
      pagination — le chemin CHAUD que la migration indexe (cf. INDEX_SPEC ; preuve : `explainFindBy`). */
  findBy(collection: string, field: string, value: string): Rec[] {
    if (!Schema.isCollection(collection)) return [];
    const w = this.whereClause(collection, { [field]: value });
    return this.db.prepare(this.findBySql(collection, w.sql)).all(...w.args).map((row) => this.rebuild(collection, row));
  }

  /** DIAGNOSTIC (seule méthode publique HORS `RepositoryContract`) : lignes `detail` de l'EXPLAIN QUERY PLAN
      du SQL EXACT de `findBy` — la PREUVE mesurable du gain d'index (`SEARCH … USING INDEX idx_…`), consommée
      par les tests de la migration DB. */
  explainFindBy(collection: string, field: string, value: string): string[] {
    if (!Schema.isCollection(collection)) return [];
    const w = this.whereClause(collection, { [field]: value });
    return this.db.prepare("EXPLAIN QUERY PLAN " + this.findBySql(collection, w.sql)).all(...w.args).map((row) => String(row.detail));
  }

  /* ---- meta (table HORS migration — mécanique identique au blob) ---- */
  getMeta(): Rec { const row = this.db.prepare(`SELECT data FROM meta WHERE id = 1`).get(); return row ? JSON.parse(row.data) : {}; }
  setMeta(meta: Rec): void { this.db.prepare(`INSERT INTO meta (id, data) VALUES (1, @d) ON CONFLICT(id) DO UPDATE SET data = @d`).run({ d: JSON.stringify(meta || {}) }); }

  /* ---- lot atomique (POST /transact) — ordre deletes → updates → creates → meta, UNE transaction ---- */
  transact({ creates = [], updates = [], deletes = [], meta }: Tx = {}, rev = 0): void {
    this.db.transaction(() => {
      for (const d of deletes) this.delete(d.collection, d.id);
      for (const u of updates) this.upsert(u.collection, u.record, rev);
      for (const c of creates) this.upsert(c.collection, c.record, rev);
      if (meta) this.setMeta(meta);
    })();
  }

  /* ---- import complet (PUT /snapshot) : DELETE all + réinsert, audit restauré VERBATIM (Q7) ---- */
  replaceSnapshot(snapshot: Snapshot, rev = 0): void {
    this.db.transaction(() => {
      for (const c of Schema.COLLECTIONS) {
        this.db.prepare(`DELETE FROM ${RelationalRepository.quote(c)}`).run();
        for (const rec of (snapshot[c] || [])) this.upsert(c, rec, rev);
      }
      if (snapshot.meta) this.setMeta(snapshot.meta);
    })();
  }

  /* ---- maintenance ---- */

  /** IDS d'images RÉFÉRENCÉS par les équipements. ⚠ Réécrite SUR LES COLONNES `face_image_*_id`
      (le blob relisait tout le JSON `data`) — la liste des champs reste la source partagée
      `Schema.EQUIPMENT_FACE_IMAGE_FIELDS`, tous déclarés dans la spec donc tous colonnes. */
  private referencedImageIds(): Set<string> {
    const out = new Set<string>();
    const columns = Schema.EQUIPMENT_FACE_IMAGE_FIELDS.map((f) => RelationalRepository.quote(f)).join(", ");
    for (const row of this.db.prepare(`SELECT ${columns} FROM "equipments"`).all()) {
      for (const f of Schema.EQUIPMENT_FACE_IMAGE_FIELDS) { const v = row[f]; if (typeof v === "string" && v) out.add(v); }
    }
    return out;
  }

  /** MAINTENANCE — même contrat que le blob : purge des images ORPHELINES puis compactage
      (checkpoint TRUNCATE + optimize + VACUUM hors transaction, SQLite l'interdit en transaction). */
  maintenance(): { purgedImages: number } {
    const referenced = this.referencedImageIds();
    const orphans = this.db.prepare("SELECT id FROM images").all().map((r) => r.id as string).filter((id) => !referenced.has(id));
    const del = this.db.prepare("DELETE FROM images WHERE id = ?");
    this.db.transaction(() => { for (const id of orphans) del.run(id); })();
    try { this.db.pragma("wal_checkpoint(TRUNCATE)"); this.db.pragma("optimize"); } catch { /* driver réduit */ }
    this.db.exec("VACUUM");
    return { purgedImages: orphans.length };
  }

  /* ---- images (blobs — table HORS migration, mécanique identique au blob, rev de cache-busting incluse) ---- */
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
    // RÉVISION du BINAIRE (jeton de cache-busting client `?v=`) : incrémentée UNIQUEMENT sur nouveau blob
    // (cf. db.ts — même invariant : une édition de méta seule ne bump pas).
    const rev = blob ? (((curMeta.rev as number) | 0) + 1) : ((curMeta.rev as number) | 0);
    this.db.prepare(`INSERT INTO images (id, meta, blob, bytes) VALUES (@id, @meta, @blob, @bytes)
                     ON CONFLICT(id) DO UPDATE SET meta = @meta, blob = @blob, bytes = @bytes`)
      .run({ id, meta: JSON.stringify({ ...meta, id, rev }), blob: b, bytes });
  }
  deleteImage(id: string): void { this.db.prepare("DELETE FROM images WHERE id = ?").run(id); }
}
