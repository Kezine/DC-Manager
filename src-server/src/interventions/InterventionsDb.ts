import fs from "node:fs";
import path from "node:path";
import { Logger } from "../logger.js";
import { Schema } from "../constants.js";
import type { SqliteCtor, SqliteDb } from "../db.js";
import {
  InterventionsValidate, INTERVENTION_STATUSES, INTERVENTION_PRIORITIES,
  type InterventionCandidate,
} from "./InterventionsValidate.js";

/* =============================================================================
   PERSISTANCE DU MODULE INTERVENTIONS — base SQLite DÉDIÉE (`interventions.db`,
   à côté de registry.db), possédée par `interventions/` (amovible, pattern vm/,
   notify/ et certs/) : jamais une table de registry.db, le cœur n'importe RIEN d'ici.

   DEUX TABLES :
   - interventions      : l'objet (incident | intervention), métadonnées + audit
                          posé PAR LE SERVEUR + `search` dénormalisée — PK (doc_id, id) ;
   - intervention_links : cibles liées (équipement/VM/spare) en table ORDONNÉE
                          (jamais de JSON en DB) — PK (doc_id, intervention_id, position),
                          FK ON DELETE CASCADE (supprimer un objet purge ses liens).

   ⚠ AUCUNE FK vers les cibles : elles vivent dans les `.db` des DOCUMENTS (bases
   SÉPARÉES) — le lien est un simple couple (kind, id), les orphelins sont TOLÉRÉS
   (c'est le client qui affichera « introuvable »).
   ============================================================================= */

/** Nom de la base dédiée au module, DANS le dossier injecté (à côté de registry.db). */
export const INTERVENTIONS_DB_FILE = "interventions.db";

/** Lien vers une cible (couple opaque — aucune FK ; l'ordre du tableau fait foi). */
export interface InterventionLink {
  target_kind: string;
  target_id: string;
}

/** Objet complet (liste ET détail portent la MÊME forme : aucun champ secret à masquer,
    contrairement à certs et son key_enc). Les liens (petits) sont TOUJOURS inclus. */
export interface InterventionRecord {
  id: string;
  kind: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  created_by: string;
  created_date: string;
  updated_by: string;
  updated_date: string;
  planned_start: string | null;
  planned_end: string | null;
  jira_ref: string | null;
  closed_date: string | null;
  links: InterventionLink[];
}

/** Options de listing paginé. Toutes optionnelles → défauts (validation SOUPLE côté route :
    une valeur inconnue est IGNORÉE, jamais de 400). Les filtres kind/status/priority sont RÉPÉTABLES. */
export interface InterventionsListOpts {
  page?: number;
  pageSize?: number;
  query?: string;
  kinds?: string[];
  statuses?: string[];
  priorities?: string[];
  sort?: "title" | "status" | "priority" | "planned_start" | "created_date" | "updated_date";
  dir?: "asc" | "desc";
}

/** Réponse d'une page (forme ListResult : enveloppe de pagination + tableau `interventions`). */
export interface InterventionsPage {
  interventions: InterventionRecord[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
}

/** Ligne minimale lue par le veilleur de rappels (métadonnées de la fenêtre planifiée). */
export interface InterventionReminderRow {
  doc_id: string;
  id: string;
  title: string;
  kind: string;
  status: string;
  planned_start: string;
  planned_end: string | null;
}

export class InterventionsDb {
  private readonly db: SqliteDb;

  /** @param dir  Dossier de la base (le MÊME que registry.db — injecté, jamais dérivé ici).
      @param Database  Constructeur SQLite INJECTÉ (better-sqlite3 en prod, réel en test).
      @param log  Journalisation. */
  constructor(
    dir: string,
    Database: SqliteCtor,
    private readonly log: Logger = new Logger("error"),
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, INTERVENTIONS_DB_FILE));
    // FK ON à CHAQUE connexion (OFF par défaut dans SQLite) — le ON DELETE CASCADE des liens en
    // dépend. Réglages de parité DocumentStore/NotifyDb/CertsDb.
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.createSchema();
    this.log.info("interventions: base ouverte", path.join(dir, INTERVENTIONS_DB_FILE));
  }

  close(): void { this.db.close(); }

  /* --------------------------------------------------------------------------
     Schéma + migrations idempotentes (pattern CertsDb/NotifyDb.ensureColumn)
     -------------------------------------------------------------------------- */

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS interventions (
        doc_id        TEXT NOT NULL,
        id            TEXT NOT NULL,
        kind          TEXT NOT NULL,
        title         TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL,
        priority      TEXT NOT NULL,
        created_by    TEXT NOT NULL,
        created_date  TEXT NOT NULL,
        updated_by    TEXT NOT NULL,
        updated_date  TEXT NOT NULL,
        planned_start TEXT,
        planned_end   TEXT,
        jira_ref      TEXT,
        closed_date   TEXT,
        search        TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (doc_id, id)
      );
      CREATE TABLE IF NOT EXISTS intervention_links (
        doc_id          TEXT NOT NULL,
        intervention_id TEXT NOT NULL,
        position        INTEGER NOT NULL,
        target_kind     TEXT NOT NULL,
        target_id       TEXT NOT NULL,
        PRIMARY KEY (doc_id, intervention_id, position),
        FOREIGN KEY (doc_id, intervention_id) REFERENCES interventions(doc_id, id) ON DELETE CASCADE
      );
    `);
    // MIGRATIONS idempotentes PRÊTES POUR L'AVENIR (pattern CertsDb) : sur une base fraîche elles
    // ne font rien (colonnes déjà dans le CREATE) ; sur une base antérieure elles ajouteraient la
    // colonne manquante. Les index viennent APRÈS (sur une base ancienne, la colonne doit exister
    // avant d'être indexée).
    this.ensureColumn("interventions", "closed_date", "TEXT");
    this.ensureColumn("interventions", "jira_ref", "TEXT");
    this.ensureColumn("interventions", "search", "TEXT NOT NULL DEFAULT ''");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_interventions_search ON interventions(doc_id, search);
      CREATE INDEX IF NOT EXISTS idx_interventions_status ON interventions(doc_id, status);
      CREATE INDEX IF NOT EXISTS idx_interventions_planned_start ON interventions(planned_start);
    `);
  }

  /** ALTER TABLE ADD COLUMN idempotent : n'ajoute la colonne que si elle manque (table_info). */
  private ensureColumn(table: string, column: string, ddl: string): void {
    const columns = this.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r: any) => r.name);
    if (!columns.includes(column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      this.log.info("interventions: migration — colonne ajoutée", table + "." + column);
    }
  }

  /* --------------------------------------------------------------------------
     CRUD
     -------------------------------------------------------------------------- */

  /** Détail unitaire (liens inclus) ou null si inconnu. */
  getOne(docId: string, id: string): InterventionRecord | null {
    const row = this.db.prepare("SELECT * FROM interventions WHERE doc_id = ? AND id = ?").get(docId, id) as any;
    if (!row) return null;
    return this.toRecord(row, this.linksOf(docId, id));
  }

  /** Crée/remplace un objet (transactionnel : ligne + liens ré-écrits ensemble).

      AUDIT posé PAR LE SERVEUR (jamais par le client) : à la CRÉATION, created_by/created_date
      ET updated_by/updated_date ; à la MISE À JOUR, created_* CONSERVÉS et seuls updated_*
      rafraîchis. `writer` = nom de l'utilisateur authentifié (résolu côté route).

      `closed_date` : posé automatiquement À L'ENTRÉE en 'closed' (conservé tant qu'on y reste),
      effacé dès qu'on en sort. `search` recalculée à CHAQUE save (normSearch partagé avec le cœur). */
  save(docId: string, id: string, candidate: Record<string, unknown>, writer: string): InterventionRecord {
    const parsed: InterventionCandidate = InterventionsValidate.parse(id, candidate);
    const nowIso = new Date().toISOString();
    const writerName = typeof writer === "string" && writer.trim() !== "" ? writer.trim() : "?";
    const existing = this.db.prepare("SELECT created_by, created_date, status, closed_date FROM interventions WHERE doc_id = ? AND id = ?").get(docId, parsed.id) as any;

    // closed_date : posé à l'ENTRÉE en 'closed' (si on n'y était pas déjà), effacé si on en sort.
    let closedDate: string | null = null;
    if (parsed.status === "closed") {
      closedDate = existing && existing.status === "closed" && existing.closed_date ? existing.closed_date : nowIso;
    }
    const search = InterventionsDb.searchText(parsed.title, parsed.description, parsed.jira_ref);

    const write = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO interventions (doc_id, id, kind, title, description, status, priority, created_by, created_date, updated_by, updated_date, planned_start, planned_end, jira_ref, closed_date, search)
        VALUES (@doc_id, @id, @kind, @title, @description, @status, @priority, @created_by, @created_date, @updated_by, @updated_date, @planned_start, @planned_end, @jira_ref, @closed_date, @search)
        ON CONFLICT(doc_id, id) DO UPDATE SET kind=@kind, title=@title, description=@description, status=@status, priority=@priority,
          updated_by=@updated_by, updated_date=@updated_date, planned_start=@planned_start, planned_end=@planned_end,
          jira_ref=@jira_ref, closed_date=@closed_date, search=@search
      `).run({
        doc_id: docId, id: parsed.id, kind: parsed.kind, title: parsed.title, description: parsed.description,
        status: parsed.status, priority: parsed.priority,
        created_by: existing ? existing.created_by : writerName,
        created_date: existing ? existing.created_date : nowIso,
        updated_by: writerName, updated_date: nowIso,
        planned_start: parsed.planned_start, planned_end: parsed.planned_end,
        jira_ref: parsed.jira_ref, closed_date: closedDate, search,
      });
      // Liens : remplacement COMPLET (l'ordre du tableau fait foi — position = index).
      this.db.prepare("DELETE FROM intervention_links WHERE doc_id = ? AND intervention_id = ?").run(docId, parsed.id);
      const insertLink = this.db.prepare("INSERT INTO intervention_links (doc_id, intervention_id, position, target_kind, target_id) VALUES (?, ?, ?, ?, ?)");
      parsed.links.forEach((link, position) => insertLink.run(docId, parsed.id, position, link.target_kind, link.target_id));
    });
    write();
    this.log.info("interventions: objet enregistré", docId, parsed.id, parsed.kind + "/" + parsed.status);
    return this.getOne(docId, parsed.id)!;
  }

  /** Supprime un objet (ses liens partent en CASCADE). Renvoie false si inconnu (404 côté route). */
  remove(docId: string, id: string): boolean {
    const row = this.db.prepare("SELECT id FROM interventions WHERE doc_id = ? AND id = ?").get(docId, id) as any;
    if (!row) return false;
    const purge = this.db.transaction(() => {
      this.db.prepare("DELETE FROM interventions WHERE doc_id = ? AND id = ?").run(docId, id);
    });
    purge();
    this.log.info("interventions: objet supprimé", docId, id);
    return true;
  }

  /* --------------------------------------------------------------------------
     Listing PAGINÉ (SQL pur, LIMIT/OFFSET — jamais de chargement complet)
     -------------------------------------------------------------------------- */

  /** Liste PAGINÉE et PLATE d'un document : filtres query/kinds/statuses/priorities, tris, recherche,
      le tout en SQL. Chaque item porte ses liens (petits, chargés pour LA seule page renvoyée). */
  listPage(docId: string, opts: InterventionsListOpts = {}): InterventionsPage {
    const ps = InterventionsDb.clampPageSize(opts.pageSize);
    const dirSql = opts.dir === "desc" ? "DESC" : "ASC";
    const orderBy = InterventionsDb.orderBy(opts.sort, dirSql);

    const f = this.filterClause(opts);
    const params: Record<string, unknown> = { doc_id: docId, ...f.params };
    const where = "doc_id = @doc_id" + f.sql;

    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM interventions WHERE " + where).get(params) as any).n as number;
    const pages = Math.max(1, Math.ceil(total / ps));
    const page = Math.min(Math.max(1, opts.page == null ? 1 : (opts.page | 0)), pages);
    const offset = (page - 1) * ps;

    const rows = this.db.prepare(
      "SELECT * FROM interventions WHERE " + where + " ORDER BY " + orderBy + " LIMIT @limit OFFSET @offset",
    ).all({ ...params, limit: ps, offset }) as any[];

    const interventions = rows.map((row) => this.toRecord(row, this.linksOf(docId, row.id)));
    return { interventions, total, page, pages, pageSize: ps };
  }

  /* --------------------------------------------------------------------------
     Comptes d'interventions OUVERTES par cible (badges de fiche)
     -------------------------------------------------------------------------- */

  /** Nombre d'interventions OUVERTES (status ∉ {closed, cancelled}) liées à chacune des cibles demandées.
      Renvoie une map `"<kind>:<id>" → n` couvrant TOUTES les cibles valides demandées (0 si aucune liée).
      Validation SOUPLE : cibles malformées ignorées, dédupliquées, plafonnées à 100 (anti-abus). Une même
      intervention liée deux fois à la même cible n'est comptée qu'UNE fois (COUNT DISTINCT). */
  countOpenForTargets(docId: string, targets: Array<{ kind: string; id: string }>): Record<string, number> {
    const result: Record<string, number> = {};
    const seen = new Set<string>();
    const clean: Array<{ kind: string; id: string }> = [];
    for (const t of targets) {
      const kind = t && typeof t.kind === "string" ? t.kind.trim() : "";
      const id = t && typeof t.id === "string" ? t.id.trim() : "";
      if (kind === "" || id === "") continue;               // cible malformée → ignorée (souple)
      const key = kind + ":" + id;
      if (seen.has(key)) continue;                          // déduplication
      seen.add(key);
      clean.push({ kind, id });
      if (clean.length >= 100) break;                       // plafond anti-abus
    }
    for (const t of clean) result[t.kind + ":" + t.id] = 0; // défaut 0 pour toute cible valide demandée
    if (clean.length === 0) return result;

    // OR de couples (kind, id) — robuste et lisible (≤ 100 clauses). JOIN links → interventions ouvertes ;
    // COUNT DISTINCT sur l'id d'intervention (doc_id fixé par le WHERE) pour ne pas compter deux fois un
    // même objet lié plusieurs fois à la même cible.
    const pairSql = clean.map(() => "(l.target_kind = ? AND l.target_id = ?)").join(" OR ");
    const params: string[] = [docId];
    for (const t of clean) { params.push(t.kind, t.id); }
    const rows = this.db.prepare(
      "SELECT l.target_kind AS k, l.target_id AS t, COUNT(DISTINCT i.id) AS n " +
      "FROM intervention_links l JOIN interventions i ON i.doc_id = l.doc_id AND i.id = l.intervention_id " +
      "WHERE l.doc_id = ? AND i.status NOT IN ('closed', 'cancelled') AND (" + pairSql + ") " +
      "GROUP BY l.target_kind, l.target_id",
    ).all(...params) as any[];
    for (const row of rows) result[row.k + ":" + row.t] = (row.n | 0);
    return result;
  }

  /* --------------------------------------------------------------------------
     Source du veilleur de rappels (fenêtres planifiées encore à démarrer)
     -------------------------------------------------------------------------- */

  /** Interventions à SURVEILLER (rappels) : fenêtre planifiée posée ET pas encore démarrées
      (status 'declared' ou 'planned'). Dès 'in_progress'/'closed'/'cancelled', l'objet sort de
      cette liste → le veilleur clôt son rappel. Triées par échéance de démarrage. */
  listReminderCandidates(): InterventionReminderRow[] {
    return this.db.prepare(
      "SELECT doc_id, id, title, kind, status, planned_start, planned_end FROM interventions WHERE planned_start IS NOT NULL AND status IN ('declared', 'planned') ORDER BY planned_start",
    ).all() as any[];
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  private linksOf(docId: string, id: string): InterventionLink[] {
    return (this.db.prepare("SELECT target_kind, target_id FROM intervention_links WHERE doc_id = ? AND intervention_id = ? ORDER BY position").all(docId, id) as any[])
      .map((l) => ({ target_kind: l.target_kind, target_id: l.target_id }));
  }

  private toRecord(row: any, links: InterventionLink[]): InterventionRecord {
    return {
      id: row.id, kind: row.kind, title: row.title, description: row.description,
      status: row.status, priority: row.priority,
      created_by: row.created_by, created_date: row.created_date,
      updated_by: row.updated_by, updated_date: row.updated_date,
      planned_start: row.planned_start, planned_end: row.planned_end,
      jira_ref: row.jira_ref, closed_date: row.closed_date, links,
    };
  }

  /** Texte de recherche dénormalisé (colonne `search`) : title + description + jira_ref, normalisés
      par la MÊME règle PARTAGÉE que le cœur (Schema.normSearch — minuscules + sans accents), pour que
      le client filtre avec exactement la même normalisation. */
  private static searchText(title: string, description: string, jiraRef: string | null): string {
    return Schema.normSearch([title, description, jiraRef || ""].join(" "));
  }

  /** pageSize borné : défaut 25 (Schema.PAGE_SIZE_DEFAULT), plancher 1, plafond 200. */
  private static clampPageSize(pageSize: number | undefined): number {
    const raw = pageSize == null ? Schema.PAGE_SIZE_DEFAULT : (pageSize | 0);
    return Math.min(Math.max(1, raw), 200);
  }

  /** Clause ORDER BY. STABLE : `id` en dernier critère (départage les égalités → pagination
      déterministe). `status` et `priority` sont triés par RANG SÉMANTIQUE (cycle de vie / ordre de
      traitement), pas alphabétiquement — l'ordre lexical de leurs slugs n'aurait aucun sens. Défaut :
      les plus récemment MODIFIÉS en tête (le travail « chaud » d'abord). Sort inconnu → défaut. */
  private static orderBy(sort: string | undefined, dirSql: string): string {
    switch (sort) {
      case "title":         return `title COLLATE NOCASE ${dirSql}, id ASC`;
      case "status":        return InterventionsDb.rankCase("status", INTERVENTION_STATUSES) + ` ${dirSql}, id ASC`;
      case "priority":      return InterventionsDb.rankCase("priority", INTERVENTION_PRIORITIES) + ` ${dirSql}, id ASC`;
      case "planned_start": return `(planned_start IS NULL) ASC, planned_start ${dirSql}, id ASC`;
      case "created_date":  return `created_date ${dirSql}, id ASC`;
      case "updated_date":  return `updated_date ${dirSql}, id ASC`;
      default:              return `updated_date DESC, id ASC`;
    }
  }

  /** Construit un `CASE col WHEN 'slug' THEN <rang> …` du rang d'un slug dans son ordre canonique.
      Les valeurs interpolées sont nos PROPRES constantes d'énumération (jamais une entrée client) —
      aucune injection possible. Un slug hors liste retombe en dernier (order.length). */
  private static rankCase(column: string, order: readonly string[]): string {
    return "(CASE " + column + " " + order.map((v, i) => "WHEN '" + v + "' THEN " + i).join(" ") + " ELSE " + order.length + " END)";
  }

  /** Fragment WHERE des filtres (query/kinds/statuses/priorities) + paramètres NOMMÉS. Construit
      CONDITIONNELLEMENT : better-sqlite3 refuse un paramètre lié absent de la requête — on ne lie donc
      un paramètre QUE si sa clause est présente (pattern CertsDb.filterClause). */
  private filterClause(opts: InterventionsListOpts): { sql: string; params: Record<string, unknown> } {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    const query = typeof opts.query === "string" ? opts.query.trim() : "";
    if (query !== "") { clauses.push("search LIKE @query"); params.query = "%" + Schema.normSearch(query) + "%"; }
    InterventionsDb.inClause("kind", opts.kinds, clauses, params);
    InterventionsDb.inClause("status", opts.statuses, clauses, params);
    InterventionsDb.inClause("priority", opts.priorities, clauses, params);
    return { sql: clauses.length ? " AND " + clauses.join(" AND ") : "", params };
  }

  /** Ajoute un filtre `col IN (…)` répétable si des valeurs (non vides) sont fournies. */
  private static inClause(column: string, values: string[] | undefined, clauses: string[], params: Record<string, unknown>): void {
    const list = (values || []).filter((v): v is string => typeof v === "string" && v !== "");
    if (!list.length) return;
    clauses.push(column + " IN (" + list.map((_, i) => "@" + column + i).join(", ") + ")");
    list.forEach((v, i) => { params[column + i] = v; });
  }
}
