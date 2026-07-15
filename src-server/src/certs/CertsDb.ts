import fs from "node:fs";
import path from "node:path";
import { Logger } from "../logger.js";
import { Schema } from "../constants.js";
import type { SqliteCtor, SqliteDb } from "../db.js";
import { CertsValidate, type CertificateCandidate, type PkiParamsCandidate, type SanCandidate } from "./CertsValidate.js";

/* =============================================================================
   PERSISTANCE DU MODULE CERTIFICATS — base SQLite DÉDIÉE (`certs.db`, à côté
   de registry.db), possédée par `certs/` (amovible, pattern vm/ et notify/) :
   jamais une table de registry.db, le cœur n'importe RIEN d'ici.

   ZÉRO-CONNAISSANCE (cadrage 2026-07-14) : cette base ne contient AUCUN
   secret exploitable par le serveur — les clés privées arrivent DÉJÀ
   chiffrées par la clé maître de l'utilisateur (`key_enc`, AES-GCM côté
   navigateur), le serveur ne stocke que des MÉTADONNÉES lisibles (sujets,
   échéances, empreintes — nécessaires au suivi d'expiration) et des blobs
   opaques. PAS de SecretBox ici : il n'y a rien à chiffrer côté serveur.

   VRAIES TABLES (contrainte transverse) — schéma EXACT du cadrage §3 :
   - pki_documents     : paramètres de dérivation de la clé maître PAR document
                         (sel, itérations, keycheck chiffré côté client) ;
   - certificates      : métadonnées + public_pem (public par nature) +
                         key_enc (blob chiffré client) — PK (doc_id, id),
                         FK composite parent (émetteur) ;
   - certificate_sans  : SAN en table ordonnée (jamais de JSON en DB).

   INVARIANT Q5 : `key_enc` ne sort JAMAIS en liste — uniquement au GET
   unitaire (l'export côté client déchiffre localement). Garanti ici par des
   DTO distincts (CertificateListItem sans key_enc / CertificateDetail avec).
   ============================================================================= */

/** Nom de la base dédiée au module, DANS le dossier injecté (à côté de registry.db). */
export const CERTS_DB_FILE = "certs.db";

/** Élément de LISTE (GET /certs) — SANS key_enc (invariant Q5) ; `has_key` signale
    qu'une clé privée chiffrée est détenue (l'UI propose les exports qui l'exigent). */
export interface CertificateListItem {
  id: string;
  kind: string;
  parent_id: string | null;
  label: string;
  subject: string;
  serial: string | null;
  not_before: string | null;
  not_after: string | null;
  fingerprint: string | null;
  key_algo: string;
  public_pem: string | null;
  has_key: boolean;
  revoked_at: string | null;
  created_date: string;
  updated_date: string;
  sans: SanCandidate[];
}

/** Détail unitaire (GET /certs/:id) — key_enc INCLUS (décision Q5 : au GET unitaire seulement). */
export interface CertificateDetail extends CertificateListItem {
  key_enc: string | null;
}

/** Paramètres PKI d'un document tels que renvoyés au client (dérivation + keycheck). */
export interface PkiParams extends PkiParamsCandidate {
  doc_id: string;
}

/** Élément de la LISTE PAGINÉE (GET /certs?…) — un CertificateListItem (donc SANS key_enc, invariant Q5)
    augmenté de `root_id` : la RACINE de l'arbre du certificat (NULL au premier niveau). Nécessaire à la
    navigation de la recherche (cadrage §4) — cliquer un dérivé ouvre la vue de SA racine. */
export interface CertificatePageItem extends CertificateListItem {
  root_id: string | null;
}

/** Élément de la liste des RACINES (GET /certs/roots) — premier niveau + agrégats du sous-arbre :
    `children_total` (descendants), `children_alert` (descendants non révoqués à échéance ≤ 30 j — expirés
    inclus), `next_expiry` (échéance non révoquée la plus proche de l'arbre, racine comprise ; null si aucune). */
export interface CertificateRootItem extends CertificateListItem {
  children_total: number;
  children_alert: number;
  next_expiry: string | null;
}

/** Options de listing paginé (routes GET /certs et /certs/roots). Toutes optionnelles → défauts (validation
    SOUPLE côté route : valeur inconnue ignorée). `now` est INJECTABLE pour rendre les statuts d'échéance
    (expired/expiring) et les agrégats déterministes en test (défaut : l'horloge réelle). */
export interface CertsListOpts {
  page?: number;
  pageSize?: number;
  query?: string;
  kinds?: string[];
  status?: "active" | "revoked" | "expired" | "expiring";
  /** Restreint au SOUS-ARBRE STRICT de cette racine (elle-même EXCLUE) — sans objet pour /roots. */
  root?: string;
  /** `parent` = tri par émetteur puis libellé ; `children_total`/`next_expiry` réservés à /roots. */
  sort?: "label" | "kind" | "not_after" | "created_date" | "parent" | "children_total" | "next_expiry";
  dir?: "asc" | "desc";
  /** Id d'un élément à CIBLER : s'il matche les filtres, la réponse porte la page qui le contient (le
      paramètre `page` est alors ignoré) ; sinon comportement normal (page demandée). */
  focus?: string;
  now?: Date;
}

/** Réponse d'une page de certificats (forme ListResult : enveloppe de pagination + tableau `certificates`). */
export interface CertificatePage {
  certificates: CertificatePageItem[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
}

/** Réponse d'une page de racines (même enveloppe, items porteurs des agrégats). */
export interface CertificateRootsPage {
  certificates: CertificateRootItem[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
}

export class CertsDb {
  private readonly db: SqliteDb;

  /** @param dir  Dossier de la base (le MÊME que registry.db — injecté, jamais dérivé ici).
      @param Database  Constructeur SQLite INJECTÉ (better-sqlite3 en prod, réel en test).
      @param log  Journalisation (métadonnées uniquement — il n'y a aucun secret à protéger ici,
                  mais les blobs ne sont jamais loggués : bruit inutile). */
  constructor(
    dir: string,
    Database: SqliteCtor,
    private readonly log: Logger = new Logger("error"),
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, CERTS_DB_FILE));
    // FK ON à CHAQUE connexion (OFF par défaut dans SQLite) — la FK composite parent et le
    // ON DELETE CASCADE des SAN en dépendent. Réglages de parité DocumentStore/NotifyDb.
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.createSchema();
    this.log.info("certs: base ouverte", path.join(dir, CERTS_DB_FILE));
  }

  close(): void { this.db.close(); }

  /* --------------------------------------------------------------------------
     Schéma + migrations idempotentes (pattern NotifyDb.ensureColumn)
     -------------------------------------------------------------------------- */

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pki_documents (
        doc_id        TEXT PRIMARY KEY,
        kdf_version   TEXT NOT NULL,
        kdf_salt      TEXT NOT NULL,
        kdf_iters     INTEGER NOT NULL,
        keycheck_enc  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS certificates (
        id            TEXT NOT NULL,
        doc_id        TEXT NOT NULL,
        kind          TEXT NOT NULL,
        parent_id     TEXT,
        label         TEXT NOT NULL,
        subject       TEXT NOT NULL,
        serial        TEXT,
        not_before    TEXT,
        not_after     TEXT,
        fingerprint   TEXT,
        key_algo      TEXT NOT NULL,
        public_pem    TEXT,
        key_enc       TEXT,
        revoked_at    TEXT,
        created_date  TEXT NOT NULL,
        updated_date  TEXT NOT NULL,
        search        TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (doc_id, id),
        FOREIGN KEY (doc_id, parent_id) REFERENCES certificates(doc_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_certificates_expiry ON certificates(not_after);
      CREATE TABLE IF NOT EXISTS certificate_sans (
        doc_id   TEXT NOT NULL,
        cert_id  TEXT NOT NULL,
        position INTEGER NOT NULL,
        san_type TEXT NOT NULL,
        value    TEXT NOT NULL,
        PRIMARY KEY (doc_id, cert_id, position),
        FOREIGN KEY (doc_id, cert_id) REFERENCES certificates(doc_id, id) ON DELETE CASCADE
      );
    `);
    // MIGRATION idempotente (pattern NotifyDb.ensureColumn) : la colonne `search` dénormalisée peut
    // manquer sur une certs.db créée AVANT le listing paginé — ensureColumn ne fait rien sur une base
    // fraîche (la colonne est déjà dans le CREATE ci-dessus) et l'AJOUTE aux bases antérieures.
    this.ensureColumn("certificates", "search", "TEXT NOT NULL DEFAULT ''");
    // Index APRÈS la migration : sur une base ancienne, la colonne `search` n'existe qu'une fois
    // ensureColumn passé (créer l'index avant échouerait). idx_search sert le filtre `query`
    // (search LIKE), idx_parent la remontée d'arbre (CTE sur (doc_id, parent_id)).
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_certificates_search ON certificates(doc_id, search);
      CREATE INDEX IF NOT EXISTS idx_certificates_parent ON certificates(doc_id, parent_id);
    `);
    this.backfillSearch();
  }

  /** ALTER TABLE ADD COLUMN idempotent : n'ajoute la colonne que si elle manque (table_info). */
  private ensureColumn(table: string, column: string, ddl: string): void {
    const columns = this.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r: any) => r.name);
    if (!columns.includes(column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      this.log.info("certs: migration — colonne ajoutée", table + "." + column);
    }
  }

  /** BACKFILL one-shot de la colonne `search` : recalcule les lignes restées à '' alors qu'elles portent
      un label (typiquement celles écrites AVANT l'ajout de la colonne). Idempotent — une base déjà à jour
      n'a rien à recalculer (toutes ses lignes ont un `search` non vide), une ligne au label vide reste à ''. */
  private backfillSearch(): void {
    const rows = this.db.prepare("SELECT id, doc_id, label, subject, serial FROM certificates WHERE search = '' AND label <> ''").all() as any[];
    if (rows.length === 0) return;
    const sansStmt = this.db.prepare("SELECT value FROM certificate_sans WHERE doc_id = ? AND cert_id = ? ORDER BY position");
    const update = this.db.prepare("UPDATE certificates SET search = ? WHERE doc_id = ? AND id = ?");
    const run = this.db.transaction(() => {
      for (const row of rows) {
        const sanValues = (sansStmt.all(row.doc_id, row.id) as any[]).map((s) => s.value as string);
        update.run(CertsDb.searchText(row.label, row.subject, row.serial, sanValues), row.doc_id, row.id);
      }
    });
    run();
    this.log.info("certs: migration — colonne search recalculée", rows.length + " ligne(s)");
  }

  /* --------------------------------------------------------------------------
     Paramètres PKI (clé maître — le serveur ne fait que STOCKER, jamais dériver)
     -------------------------------------------------------------------------- */

  pkiParams(docId: string): PkiParams | null {
    const row = this.db.prepare("SELECT * FROM pki_documents WHERE doc_id = ?").get(docId) as any;
    return row ? { doc_id: row.doc_id, kdf_version: row.kdf_version, kdf_salt: row.kdf_salt, kdf_iters: row.kdf_iters, keycheck_enc: row.keycheck_enc } : null;
  }

  /** Initialise la PKI d'un document (première ouverture côté client : sel + keycheck).
      REFUSE l'écrasement (false) : ré-initialiser changerait la clé maître et rendrait
      indéchiffrables toutes les clés déjà stockées — geste irréversible interdit en v1. */
  initPki(docId: string, candidate: Record<string, unknown>): boolean {
    const parsed = CertsValidate.parsePkiParams(candidate);
    if (this.pkiParams(docId)) return false;
    this.db.prepare(`
      INSERT INTO pki_documents (doc_id, kdf_version, kdf_salt, kdf_iters, keycheck_enc)
      VALUES (@doc_id, @kdf_version, @kdf_salt, @kdf_iters, @keycheck_enc)
    `).run({ doc_id: docId, ...parsed });
    this.log.info("certs: PKI initialisée", docId, parsed.kdf_version + ", " + parsed.kdf_iters + " itérations");
    return true;
  }

  /* --------------------------------------------------------------------------
     Certificats (CRUD métadonnées + blobs opaques)
     -------------------------------------------------------------------------- */

  /** Liste d'un document — MÉTADONNÉES + SAN, JAMAIS key_enc (invariant Q5). Chargement COMPLET (sans
      pagination) : conservé pour la rétro-compatibilité de la route GET /certs sans paramètre. */
  listFor(docId: string): CertificateListItem[] {
    const rows = this.db.prepare("SELECT * FROM certificates WHERE doc_id = ? ORDER BY label").all(docId) as any[];
    const sansStmt = this.db.prepare("SELECT san_type, value FROM certificate_sans WHERE doc_id = ? AND cert_id = ? ORDER BY position");
    return rows.map((row) => this.toListItem(row, sansStmt.all(docId, row.id) as any[]));
  }

  /* --------------------------------------------------------------------------
     Listing PAGINÉ (SQL pur, LIMIT/OFFSET — jamais de chargement complet)
     -------------------------------------------------------------------------- */

  /** Liste PAGINÉE et PLATE d'un document (cadrage §3) : filtres (query/kinds/status/root), tris,
      recherche, portée SOUS-ARBRE et paramètre focus, le tout en SQL. Chaque item porte `root_id`
      (racine de son arbre). JAMAIS key_enc (le mapper l'omet — invariant Q5) ; SAN chargés pour LA
      seule page renvoyée. */
  listPage(docId: string, opts: CertsListOpts = {}): CertificatePage {
    const { now, nowPlus30 } = CertsDb.clock(opts.now);
    const ps = CertsDb.clampPageSize(opts.pageSize);
    const dirSql = opts.dir === "desc" ? "DESC" : "ASC";
    const orderBy = CertsDb.orderBy(opts.sort, dirSql);

    const f = this.filterClause(opts, now, nowPlus30);
    const params: Record<string, unknown> = { doc_id: docId, ...f.params };

    // Portée SOUS-ARBRE STRICT (racine EXCLUE) via CTE récursive sur (doc_id, parent_id) : on part des
    // ENFANTS directs de la racine, jamais de la racine elle-même.
    let subtreeCte = "";
    let rootWhere = "";
    const root = CertsDb.trimmed(opts.root);
    if (root) {
      subtreeCte = `subtree(id) AS (
        SELECT id FROM certificates WHERE doc_id = @doc_id AND parent_id = @root
        UNION ALL
        SELECT c.id FROM certificates c JOIN subtree s ON c.parent_id = s.id WHERE c.doc_id = @doc_id
      )`;
      rootWhere = " AND c.id IN (SELECT id FROM subtree)";
      params.root = root;
    }
    const where = "c.doc_id = @doc_id" + f.sql + rootWhere;
    const withSubtree = subtreeCte ? "WITH RECURSIVE " + subtreeCte + " " : "";

    const total = (this.db.prepare(withSubtree + "SELECT COUNT(*) AS n FROM certificates c WHERE " + where).get(params) as any).n as number;
    const pages = Math.max(1, Math.ceil(total / ps));
    let page = Math.min(Math.max(1, opts.page == null ? 1 : (opts.page | 0)), pages);

    // FOCUS : rang de l'élément sous le MÊME ORDER BY/WHERE (ROW_NUMBER — départage stable par id) →
    // page qui le contient. S'il ne matche pas les filtres, la sous-requête ne le trouve pas et l'on
    // garde la page demandée (cadrage §4).
    const focus = CertsDb.trimmed(opts.focus);
    if (focus) {
      const hit = this.db.prepare(
        withSubtree + "SELECT rn FROM (SELECT c.id AS id, ROW_NUMBER() OVER (ORDER BY " + orderBy + ") AS rn FROM certificates c WHERE " + where + ") WHERE id = @focus",
      ).get({ ...params, focus }) as any;
      if (hit) page = Math.min(Math.max(1, Math.floor((hit.rn - 1) / ps) + 1), pages);
    }
    const offset = (page - 1) * ps;

    // root_id calculé DANS la CTE d'ascendance (propagation top-down COALESCE(root de l'ancêtre, id de
    // l'ancêtre) : NULL au premier niveau). `SELECT c.*` inclut key_enc mais le mapper toListItem ne le
    // recopie PAS dans le DTO (invariant Q5, comme listFor).
    const ancestryCte = `ancestry(id, root_id) AS (
      SELECT id, NULL FROM certificates WHERE doc_id = @doc_id AND parent_id IS NULL
      UNION ALL
      SELECT c.id, COALESCE(a.root_id, a.id) FROM certificates c JOIN ancestry a ON c.parent_id = a.id WHERE c.doc_id = @doc_id
    )`;
    const withParts = [ancestryCte, subtreeCte].filter((s) => s !== "").join(", ");
    const rows = this.db.prepare(
      "WITH RECURSIVE " + withParts + " SELECT c.*, a.root_id FROM certificates c LEFT JOIN ancestry a ON a.id = c.id WHERE " + where + " ORDER BY " + orderBy + " LIMIT @limit OFFSET @offset",
    ).all({ ...params, limit: ps, offset }) as any[];

    const sansStmt = this.db.prepare("SELECT san_type, value FROM certificate_sans WHERE doc_id = ? AND cert_id = ? ORDER BY position");
    const certificates = rows.map((row) => ({
      ...this.toListItem(row, sansStmt.all(docId, row.id) as any[]),
      root_id: (row.root_id ?? null) as string | null,
    }));
    return { certificates, total, page, pages, pageSize: ps };
  }

  /** Liste PAGINÉE des RACINES (premier niveau, parent_id NULL) avec AGRÉGATS de sous-arbre (cadrage §3).
      Choix de perf : UNE requête ENSEMBLISTE (CTE d'arbre qui étiquette chaque nœud par sa racine, puis
      GROUP BY), et non une sous-requête corrélée par ligne — les agrégats de tous les arbres du document
      sont calculés d'un coup, joints ensuite aux racines filtrées/paginées. */
  listRoots(docId: string, opts: CertsListOpts = {}): CertificateRootsPage {
    const { now, nowPlus30 } = CertsDb.clock(opts.now);
    const ps = CertsDb.clampPageSize(opts.pageSize);
    const dirSql = opts.dir === "desc" ? "DESC" : "ASC";
    const orderBy = CertsDb.rootsOrderBy(opts.sort, dirSql);

    const f = this.filterClause(opts, now, nowPlus30);
    const where = "c.doc_id = @doc_id AND c.parent_id IS NULL" + f.sql;

    // total = nombre de RACINES filtrées (les agrégats ne changent pas le compte) → COUNT léger, sans CTE.
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM certificates c WHERE " + where).get({ doc_id: docId, ...f.params }) as any).n as number;
    const pages = Math.max(1, Math.ceil(total / ps));
    let page = Math.min(Math.max(1, opts.page == null ? 1 : (opts.page | 0)), pages);

    // `tree` : chaque nœud de chaque arbre, étiqueté par la racine dont il descend (is_root distingue la
    // racine de ses descendants). `agg` réduit par racine — children_alert inclut les EXPIRÉS (≤ now+30 j),
    // next_expiry couvre la racine ET ses descendants non révoqués (MIN ignore les NULL).
    const treeCte = `tree(root, id, revoked_at, not_after, is_root) AS (
      SELECT id, id, revoked_at, not_after, 1 FROM certificates WHERE doc_id = @doc_id AND parent_id IS NULL
      UNION ALL
      SELECT t.root, c.id, c.revoked_at, c.not_after, 0 FROM certificates c JOIN tree t ON c.parent_id = t.id WHERE c.doc_id = @doc_id
    )`;
    const aggCte = `agg(root, children_total, children_alert, next_expiry) AS (
      SELECT root,
        SUM(CASE WHEN is_root = 0 THEN 1 ELSE 0 END),
        SUM(CASE WHEN is_root = 0 AND revoked_at IS NULL AND not_after IS NOT NULL AND not_after <= @nowPlus30 THEN 1 ELSE 0 END),
        MIN(CASE WHEN revoked_at IS NULL THEN not_after END)
      FROM tree GROUP BY root
    )`;
    const withRec = "WITH RECURSIVE " + treeCte + ", " + aggCte + " ";
    // nowPlus30 est TOUJOURS lié (agg l'utilise) ; f.params peut le rebinder (status expiring) — même valeur.
    const aggParams: Record<string, unknown> = { doc_id: docId, nowPlus30, ...f.params };

    const focus = CertsDb.trimmed(opts.focus);
    if (focus) {
      const hit = this.db.prepare(
        withRec + "SELECT rn FROM (SELECT c.id AS id, ROW_NUMBER() OVER (ORDER BY " + orderBy + ") AS rn FROM certificates c JOIN agg ON agg.root = c.id WHERE " + where + ") WHERE id = @focus",
      ).get({ ...aggParams, focus }) as any;
      if (hit) page = Math.min(Math.max(1, Math.floor((hit.rn - 1) / ps) + 1), pages);
    }
    const offset = (page - 1) * ps;

    const rows = this.db.prepare(
      withRec + "SELECT c.*, agg.children_total, agg.children_alert, agg.next_expiry FROM certificates c JOIN agg ON agg.root = c.id WHERE " + where + " ORDER BY " + orderBy + " LIMIT @limit OFFSET @offset",
    ).all({ ...aggParams, limit: ps, offset }) as any[];

    const sansStmt = this.db.prepare("SELECT san_type, value FROM certificate_sans WHERE doc_id = ? AND cert_id = ? ORDER BY position");
    const certificates = rows.map((row) => ({
      ...this.toListItem(row, sansStmt.all(docId, row.id) as any[]),
      children_total: row.children_total | 0,
      children_alert: row.children_alert | 0,
      next_expiry: (row.next_expiry ?? null) as string | null,
    }));
    return { certificates, total, page, pages, pageSize: ps };
  }

  /** Détail unitaire — key_enc INCLUS (Q5 : le client le déchiffre localement pour exporter). */
  getOne(docId: string, id: string): CertificateDetail | null {
    const row = this.db.prepare("SELECT * FROM certificates WHERE doc_id = ? AND id = ?").get(docId, id) as any;
    if (!row) return null;
    const sans = this.db.prepare("SELECT san_type, value FROM certificate_sans WHERE doc_id = ? AND cert_id = ? ORDER BY position").all(docId, id) as any[];
    return { ...this.toListItem(row, sans), key_enc: row.key_enc };
  }

  /** Certificats à échéance (métadonnées pour le suivi d'expiration — C7) : tous documents,
      non révoqués, porteurs d'une date not_after. */
  listExpiring(): Array<{ doc_id: string; id: string; label: string; kind: string; not_after: string }> {
    return this.db.prepare(
      "SELECT doc_id, id, label, kind, not_after FROM certificates WHERE not_after IS NOT NULL AND revoked_at IS NULL ORDER BY not_after",
    ).all() as any[];
  }

  /** Crée/remplace un certificat (transactionnel : ligne + SAN ré-écrits ensemble).
      `key_enc` ABSENT du candidat = CONSERVÉ tel quel (mise à jour de métadonnées —
      la liste ne renvoyant jamais key_enc, le client ne peut pas le rejouer). */
  save(docId: string, id: string, candidate: Record<string, unknown>): CertificateDetail {
    const parsed: CertificateCandidate = CertsValidate.parseCertificate(id, candidate);
    const nowIso = new Date().toISOString();
    const existing = this.db.prepare("SELECT key_enc, created_date FROM certificates WHERE doc_id = ? AND id = ?").get(docId, parsed.id) as any;
    const keyEnc = parsed.key_enc === undefined ? (existing ? existing.key_enc : null) : parsed.key_enc;
    // Colonne `search` recalculée à CHAQUE save (label + subject + serial + valeurs de SAN, normalisés
    // par la règle PARTAGÉE Schema.normSearch) : le filtre `query` du listing devient un LIKE indexable.
    const search = CertsDb.searchText(parsed.label, parsed.subject, parsed.serial, parsed.sans.map((s) => s.value));
    const write = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO certificates (id, doc_id, kind, parent_id, label, subject, serial, not_before, not_after, fingerprint, key_algo, public_pem, key_enc, revoked_at, created_date, updated_date, search)
        VALUES (@id, @doc_id, @kind, @parent_id, @label, @subject, @serial, @not_before, @not_after, @fingerprint, @key_algo, @public_pem, @key_enc, @revoked_at, @created_date, @updated_date, @search)
        ON CONFLICT(doc_id, id) DO UPDATE SET kind=@kind, parent_id=@parent_id, label=@label, subject=@subject, serial=@serial,
          not_before=@not_before, not_after=@not_after, fingerprint=@fingerprint, key_algo=@key_algo,
          public_pem=@public_pem, key_enc=@key_enc, revoked_at=@revoked_at, updated_date=@updated_date, search=@search
      `).run({
        id: parsed.id, doc_id: docId, kind: parsed.kind, parent_id: parsed.parent_id, label: parsed.label,
        subject: parsed.subject, serial: parsed.serial, not_before: parsed.not_before, not_after: parsed.not_after,
        fingerprint: parsed.fingerprint, key_algo: parsed.key_algo, public_pem: parsed.public_pem,
        key_enc: keyEnc, revoked_at: parsed.revoked_at,
        created_date: existing ? existing.created_date : nowIso, updated_date: nowIso, search,
      });
      // SAN : remplacement COMPLET (l'ordre du tableau fait foi — position = index).
      this.db.prepare("DELETE FROM certificate_sans WHERE doc_id = ? AND cert_id = ?").run(docId, parsed.id);
      const insertSan = this.db.prepare("INSERT INTO certificate_sans (doc_id, cert_id, position, san_type, value) VALUES (?, ?, ?, ?, ?)");
      parsed.sans.forEach((san, position) => insertSan.run(docId, parsed.id, position, san.san_type, san.value));
    });
    write();
    this.log.info("certs: certificat enregistré", docId, parsed.id, parsed.kind);
    return this.getOne(docId, parsed.id)!;
  }

  /** Ids des DÉRIVÉS directs d'un certificat (garde-fou de suppression). */
  childrenOf(docId: string, id: string): string[] {
    return (this.db.prepare("SELECT id FROM certificates WHERE doc_id = ? AND parent_id = ?").all(docId, id) as any[]).map((r) => r.id);
  }

  /** Supprime un certificat. REFUSE ("children") si des dérivés existent — supprimer un
      émetteur orphelinerait sa descendance (garde-fou du cadrage §4) ; "missing" si inconnu. */
  remove(docId: string, id: string): "ok" | "missing" | "children" {
    if (!this.db.prepare("SELECT 1 FROM certificates WHERE doc_id = ? AND id = ?").get(docId, id)) return "missing";
    if (this.childrenOf(docId, id).length > 0) return "children";
    const purge = this.db.transaction(() => {
      // Les SAN partent par CASCADE ; la ligne ensuite.
      this.db.prepare("DELETE FROM certificates WHERE doc_id = ? AND id = ?").run(docId, id);
    });
    purge();
    this.log.info("certs: certificat supprimé", docId, id);
    return "ok";
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  private toListItem(row: any, sans: any[]): CertificateListItem {
    return {
      id: row.id, kind: row.kind, parent_id: row.parent_id, label: row.label, subject: row.subject,
      serial: row.serial, not_before: row.not_before, not_after: row.not_after, fingerprint: row.fingerprint,
      key_algo: row.key_algo, public_pem: row.public_pem, has_key: row.key_enc !== null,
      revoked_at: row.revoked_at, created_date: row.created_date, updated_date: row.updated_date,
      sans: sans.map((s) => ({ san_type: s.san_type, value: s.value })),
    };
  }

  /** Texte de recherche dénormalisé (colonne `search`) : label + subject + serial + valeurs de SAN,
      normalisés par la MÊME règle PARTAGÉE que le cœur (Schema.normSearch — minuscules + sans accents),
      pour que le client filtre avec exactement la même normalisation (cadrage §6). */
  private static searchText(label: string, subject: string, serial: string | null, sanValues: string[]): string {
    return Schema.normSearch([label, subject, serial || "", ...sanValues].join(" "));
  }

  /** Chaîne non vide (trimmée) ou null — normalise les paramètres optionnels avant usage SQL. */
  private static trimmed(value: string | undefined): string | null {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  }

  /** Horloge de listing : `now` (défaut horloge réelle) + `now + 30 j`, en ISO. Injectable en test pour
      des statuts d'échéance et des agrégats déterministes. Les not_after sont comparés en ISO 8601 UTC —
      la comparaison lexicographique y est chronologiquement exacte (parité idx_certificates_expiry). */
  private static clock(now?: Date): { now: string; nowPlus30: string } {
    const base = now instanceof Date ? now : new Date();
    return { now: base.toISOString(), nowPlus30: new Date(base.getTime() + 30 * 86400000).toISOString() };
  }

  /** pageSize borné : défaut 25, plancher 1, plafond 200 (cadrage §3). */
  private static clampPageSize(pageSize: number | undefined): number {
    const raw = pageSize == null ? Schema.PAGE_SIZE_DEFAULT : (pageSize | 0);
    return Math.min(Math.max(1, raw), 200);
  }

  /** Clause ORDER BY d'une page de certificats. STABLE : `c.id` en dernier critère (départage les égalités
      → pagination déterministe, focus fiable). not_after NULL en DERNIER dans les DEUX sens (une échéance
      absente n'a pas à remonter en tête d'un tri décroissant). Sort inconnu → label (défaut). */
  private static orderBy(sort: string | undefined, dirSql: string): string {
    switch (sort) {
      case "kind":         return `c.kind ${dirSql}, c.id ASC`;
      case "not_after":    return `(c.not_after IS NULL) ASC, c.not_after ${dirSql}, c.id ASC`;
      case "created_date": return `c.created_date ${dirSql}, c.id ASC`;
      case "parent":       return `c.parent_id ${dirSql}, c.label ${dirSql}, c.id ASC`;
      default:             return `c.label ${dirSql}, c.id ASC`;
    }
  }

  /** ORDER BY d'une page de RACINES : ajoute les tris d'agrégats (children_total, next_expiry) aux tris
      communs ; départage par label puis id pour rester stable. */
  private static rootsOrderBy(sort: string | undefined, dirSql: string): string {
    switch (sort) {
      case "children_total": return `agg.children_total ${dirSql}, c.label ASC, c.id ASC`;
      case "next_expiry":    return `(agg.next_expiry IS NULL) ASC, agg.next_expiry ${dirSql}, c.label ASC, c.id ASC`;
      default:               return CertsDb.orderBy(sort, dirSql);
    }
  }

  /** Fragment WHERE COMMUN aux deux listings (filtres query/kinds/status portant sur la ligne `c`) + les
      paramètres NOMMÉS correspondants. Construit CONDITIONNELLEMENT : better-sqlite3 refuse un paramètre
      lié qui n'apparaît pas dans la requête — on ne lie donc `query`/`kindN`/`now`/`nowPlus30` QUE si la
      clause qui les emploie est présente. */
  private filterClause(opts: CertsListOpts, now: string, nowPlus30: string): { sql: string; params: Record<string, unknown> } {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    const query = typeof opts.query === "string" ? opts.query.trim() : "";
    if (query !== "") { clauses.push("c.search LIKE @query"); params.query = "%" + Schema.normSearch(query) + "%"; }
    const kinds = (opts.kinds || []).filter((k): k is string => typeof k === "string" && k !== "");
    if (kinds.length) {
      clauses.push("c.kind IN (" + kinds.map((_, i) => "@kind" + i).join(", ") + ")");
      kinds.forEach((k, i) => { params["kind" + i] = k; });
    }
    switch (opts.status) {
      case "active":   clauses.push("c.revoked_at IS NULL"); break;
      case "revoked":  clauses.push("c.revoked_at IS NOT NULL"); break;
      case "expired":  clauses.push("c.revoked_at IS NULL AND c.not_after IS NOT NULL AND c.not_after < @now"); params.now = now; break;
      case "expiring": clauses.push("c.revoked_at IS NULL AND c.not_after IS NOT NULL AND c.not_after >= @now AND c.not_after <= @nowPlus30"); params.now = now; params.nowPlus30 = nowPlus30; break;
    }
    return { sql: clauses.length ? " AND " + clauses.join(" AND ") : "", params };
  }
}
