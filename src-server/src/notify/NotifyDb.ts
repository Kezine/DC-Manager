import fs from "node:fs";
import path from "node:path";
import { Logger } from "../logger.js";
import type { SqliteCtor, SqliteDb } from "../db.js";
import { AuditStamp } from "../AuditStamp.js";   // « auteur présent » partagé (id canonique de created_by/updated_by)
import { SecretBox } from "../SecretBox.js";
import type { NotifyJournalEntry, NotifyState, NotifyStateStore } from "./NotifyEngine.js";
import { DEFAULT_REMIND_INTERVAL_SEC } from "./NotifyEngine.js";
import { NotifyValidate, type NotifierInstanceCandidate, type SubscriptionCandidate } from "./NotifyValidate.js";

/* =============================================================================
   PERSISTANCE DU MODULE NOTIFICATIONS — base SQLite DÉDIÉE au module
   (`notify.db`, à côté de registry.db), possédée par `notify/` : jamais une
   table de registry.db (le cœur ne connaît RIEN de notify/ — pattern vm/).
   Supprimer la feature = supprimer le module + ce fichier.

   VRAIES TABLES (contrainte transverse du cadrage — jamais de blob JSON) :
   - notifier_instances : canaux configurés (console, webhook) — le jeton
     d'appel est CHIFFRÉ au repos (`token_enc`, SecretBox partagé) ;
   - subscriptions      : routage par TYPE d'événement (décision utilisateur) —
     FK ON DELETE CASCADE vers l'instance ;
   - notification_states: anti-spam/rappels (le NotifyStateStore du moteur) —
     étendue de `title`/`body` par rapport au cadrage : le TIMER de rappels
     doit reconstruire le message SANS le producteur (redémarrage, passes
     espacées) ;
   - notification_log   : historique consultable, purgé PAR ANCIENNETÉ —
     étendu de `phase` (alerte | rappel | retablissement) pour l'affichage ;
   - notify_event_settings : intervalle de rappel PAR TYPE (décision Q2 —
     réglable dans la page admin ; absent = défaut 12 h). 5ᵉ table ajoutée au
     cadrage : le réglage par type doit survivre au redémarrage.

   MIGRATIONS : CREATE TABLE IF NOT EXISTS + ALTER ADD COLUMN IDEMPOTENTS
   (`ensureColumn` inspecte table_info) — une notify.db d'une version
   antérieure gagne les nouvelles colonnes sans intervention.

   SÉCURITÉ (invariants ABSOLUS, pattern ProviderConfigDb) : aucun jeton
   (clair ou chiffré) ni la clé n'apparaît dans un log, une erreur ou une
   réponse de LECTURE — `listInstances` renvoie `has_token` seulement ; un
   jeton n'est déchiffré que pour CONSTRUIRE un notifier (usage serveur).
   ============================================================================= */

/** Nom de la base dédiée au module, DANS le dossier injecté (à côté de registry.db). */
export const NOTIFY_DB_FILE = "notify.db";

/** Élément de la liste des instances (GET /notify/instances) — SANS jeton (invariant de
    lecture) : `has_token` signale qu'un jeton est stocké (l'UI affiche « jeton défini » et
    propose « inchangé si vide » à l'édition). Miroir DTO côté client (page admin). */
export interface NotifierInstanceItem {
  id: string;
  kind: string;
  label: string;
  url: string | null;
  has_token: boolean;
  enabled: boolean;
  /** Webhook : POST SIMPLIFIÉ { to, text } (cf. WebhookFormat) — sans objet pour console (défaut false). */
  simple: boolean;
  /** Webhook simplifié : plafond de longueur du texte compact (bornes [20, 5000], défaut 300). */
  simple_max_chars: number;
  /** Webhook NON simplifié : corps mis en forme HTML si true, texte brut sinon (défaut false). */
  html: boolean;
  created_date: string;
  updated_date: string;
}

/** Abonnement tel que listé (GET /notify/subscriptions) — aucune donnée sensible. */
export interface SubscriptionItem {
  id: string;
  doc_id: string | null;
  event_type: string;
  contact_id: string;
  channel: string;
  notifier_id: string;
  enabled: boolean;
}

/** Page d'historique (GET /notify/log) — pagination par curseur simple (LIMIT/OFFSET :
    volumes faibles, purge par ancienneté). */
export interface NotifyLogPage {
  entries: Array<{
    id: number; sent_at: string; key: string; event_type: string;
    contact_id: string | null; channel: string | null; notifier_id: string | null;
    phase: string | null; ok: boolean; detail: string | null;
  }>;
  total: number;
}

export class NotifyDb implements NotifyStateStore {
  /** Ancienneté (jours) au-delà de laquelle l'historique est purgé. */
  static readonly LOG_MAX_AGE_DAYS = 90;

  private readonly db: SqliteDb;

  /** @param dir  Dossier de la base (le MÊME que registry.db — injecté, jamais dérivé ici).
      @param Database  Constructeur SQLite INJECTÉ (better-sqlite3 en prod, réel en test).
      @param box  Coffre PARTAGÉ de chiffrement des jetons (module inactif sans clé — cf. NotifyModule).
      @param log  Journalisation (résumés SANS secret). */
  constructor(
    dir: string,
    Database: SqliteCtor,
    private readonly box: SecretBox,
    private readonly log: Logger = new Logger("error"),
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, NOTIFY_DB_FILE));
    // FK ON à CHAQUE connexion (OFF par défaut dans SQLite) — sinon le ON DELETE CASCADE des
    // abonnements ne s'appliquerait pas. Réglages de parité avec DocumentStore/ProviderConfigDb.
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.createSchema();
    this.log.info("notify: base ouverte", path.join(dir, NOTIFY_DB_FILE));
  }

  close(): void { this.db.close(); }

  /* --------------------------------------------------------------------------
     Schéma + migrations idempotentes
     -------------------------------------------------------------------------- */

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifier_instances (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        url TEXT,
        token_enc TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        simple_mode INTEGER NOT NULL DEFAULT 0,
        simple_max_chars INTEGER NOT NULL DEFAULT 300,
        html INTEGER NOT NULL DEFAULT 0,
        created_date TEXT NOT NULL,
        updated_date TEXT NOT NULL,
        created_by TEXT,
        updated_by TEXT
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        doc_id TEXT,
        event_type TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        notifier_id TEXT NOT NULL REFERENCES notifier_instances(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        updated_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_subscriptions_event ON subscriptions(event_type);
      CREATE TABLE IF NOT EXISTS notification_states (
        key TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        doc_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        first_seen TEXT NOT NULL,
        last_sent TEXT,
        next_remind_at TEXT,
        remind_interval_sec INTEGER NOT NULL,
        resolved_at TEXT,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_states_resolved ON notification_states(resolved_at);
      CREATE TABLE IF NOT EXISTS notification_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sent_at TEXT NOT NULL,
        key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        contact_id TEXT,
        channel TEXT,
        notifier_id TEXT,
        phase TEXT,
        ok INTEGER NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_log_sent_at ON notification_log(sent_at);
      CREATE TABLE IF NOT EXISTS notify_event_settings (
        event_type TEXT PRIMARY KEY,
        remind_interval_sec INTEGER NOT NULL
      );
    `);
    // MIGRATIONS ALTER idempotentes — pour une notify.db créée AVANT ces colonnes (elles sont
    // déjà dans les CREATE ci-dessus : ces appels ne font rien sur une base fraîche, et
    // documentent le pattern pour les évolutions futures du schéma).
    this.ensureColumn("notification_states", "title", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("notification_states", "body", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("notification_log", "phase", "TEXT");
    // Modes d'envoi du webhook (2026-07-15) : une notify.db antérieure gagne ces colonnes avec des
    // défauts qui REPRODUISENT le payload d'avant (mode complet, texte brut) — rétro-compatibilité.
    this.ensureColumn("notifier_instances", "simple_mode", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("notifier_instances", "simple_max_chars", "INTEGER NOT NULL DEFAULT 300");
    this.ensureColumn("notifier_instances", "html", "INTEGER NOT NULL DEFAULT 0");
    // AUDIT « qui a créé / modifié » (lot audit utilisateur) sur les objets de CONFIGURATION (canaux +
    // abonnements — PAS les états/journaux, produits par les veilleurs sans auteur humain). Colonnes nullable
    // ajoutées idempotemment : une notify.db antérieure les gagne sans valeur (legacy = NULL).
    this.ensureColumn("notifier_instances", "created_by", "TEXT");
    this.ensureColumn("notifier_instances", "updated_by", "TEXT");
    this.ensureColumn("subscriptions", "created_by", "TEXT");
    this.ensureColumn("subscriptions", "updated_by", "TEXT");
  }

  /** ALTER TABLE ADD COLUMN idempotent : n'ajoute la colonne que si elle manque (table_info). */
  private ensureColumn(table: string, column: string, ddl: string): void {
    const columns = this.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r: any) => r.name);
    if (!columns.includes(column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      this.log.info("notify: migration — colonne ajoutée", table + "." + column);
    }
  }

  /* --------------------------------------------------------------------------
     Instances de canaux (CRUD — jamais de jeton en lecture)
     -------------------------------------------------------------------------- */

  listInstances(): NotifierInstanceItem[] {
    return this.db.prepare("SELECT id, kind, label, url, token_enc IS NOT NULL AS has_token, enabled, simple_mode, simple_max_chars, html, created_date, updated_date FROM notifier_instances ORDER BY label").all()
      .map((r: any) => ({ id: r.id, kind: r.kind, label: r.label, url: r.url, has_token: !!r.has_token, enabled: !!r.enabled, simple: !!r.simple_mode, simple_max_chars: r.simple_max_chars, html: !!r.html, created_date: r.created_date, updated_date: r.updated_date }));
  }

  /** Crée/remplace une instance. `tokenPlain` : null = CONSERVER le jeton existant (édition sans
      ressaisie) ; chaîne vide interdite par l'appelant (les routes passent null). Le jeton est
      chiffré ICI (il n'existe en clair qu'en mémoire, le temps de cet appel).
      AUDIT posé PAR LE SERVEUR : `authorId` = id canonique de l'auteur (RequestAuthor.identity, résolu côté
      route) → `updated_by` à chaque écriture, `created_by` à la création puis préservé par l'upsert. */
  saveInstance(candidate: Record<string, unknown>, id: string, tokenPlain: string | null, authorId: string = ""): NotifierInstanceItem {
    const parsed: NotifierInstanceCandidate = NotifyValidate.parseInstance(id, candidate);
    const nowIso = new Date().toISOString();
    const author = AuditStamp.author(authorId);   // id non vide, sinon null
    const existing = this.db.prepare("SELECT token_enc, created_date FROM notifier_instances WHERE id = ?").get(parsed.id) as any;
    const tokenEnc = tokenPlain !== null ? this.box.encrypt(tokenPlain)
      : (existing ? existing.token_enc : null); // pas de nouveau jeton : conserver l'existant (ou aucun)
    this.db.prepare(`
      INSERT INTO notifier_instances (id, kind, label, url, token_enc, enabled, simple_mode, simple_max_chars, html, created_date, updated_date, created_by, updated_by)
      VALUES (@id, @kind, @label, @url, @token_enc, @enabled, @simple_mode, @simple_max_chars, @html, @created_date, @updated_date, @created_by, @updated_by)
      ON CONFLICT(id) DO UPDATE SET kind=@kind, label=@label, url=@url, token_enc=@token_enc, enabled=@enabled,
        simple_mode=@simple_mode, simple_max_chars=@simple_max_chars, html=@html, updated_date=@updated_date, updated_by=@updated_by
    `).run({
      id: parsed.id, kind: parsed.kind, label: parsed.label, url: parsed.url,
      token_enc: tokenEnc, enabled: parsed.enabled ? 1 : 0,
      simple_mode: parsed.simple ? 1 : 0, simple_max_chars: parsed.simple_max_chars, html: parsed.html ? 1 : 0,
      created_date: existing ? existing.created_date : nowIso, updated_date: nowIso,
      // created_by posé à la CRÉATION uniquement (hors DO UPDATE SET → immuable) ; updated_by à chaque écriture.
      created_by: author, updated_by: author,
    });
    this.log.info("notify: instance enregistrée", parsed.id, parsed.kind);
    return this.listInstances().find((i) => i.id === parsed.id)!;
  }

  /** Supprime une instance — ses abonnements suivent (FK ON DELETE CASCADE). */
  removeInstance(id: string): boolean {
    const changes = this.db.prepare("DELETE FROM notifier_instances WHERE id = ?").run(id).changes || 0;
    if (changes > 0) this.log.info("notify: instance supprimée", id);
    return changes > 0;
  }

  /** Ligne brute d'une instance ACTIVE + jeton DÉCHIFFRÉ (usage serveur : construction d'un
      notifier). Jette si le déchiffrement échoue (clé changée) — l'appelant journalise SANS le
      contenu et exclut l'instance de la remise. */
  instanceForSend(id: string): { id: string; kind: string; label: string; url: string | null; token: string | null; simple: boolean; simple_max_chars: number; html: boolean } | null {
    const row = this.db.prepare("SELECT id, kind, label, url, token_enc, simple_mode, simple_max_chars, html FROM notifier_instances WHERE id = ? AND enabled = 1").get(id) as any;
    if (!row) return null;
    return {
      id: row.id, kind: row.kind, label: row.label, url: row.url,
      token: row.token_enc ? this.box.decrypt(row.token_enc) : null,
      simple: !!row.simple_mode, simple_max_chars: row.simple_max_chars, html: !!row.html,
    };
  }

  /* --------------------------------------------------------------------------
     Abonnements (routage par type d'événement)
     -------------------------------------------------------------------------- */

  /** Liste les abonnements — tous, ou ceux visibles d'un document (les siens + les globaux). */
  listSubscriptions(docId?: string): SubscriptionItem[] {
    const rows = docId === undefined
      ? this.db.prepare("SELECT * FROM subscriptions ORDER BY event_type, id").all()
      : this.db.prepare("SELECT * FROM subscriptions WHERE doc_id IS NULL OR doc_id = ? ORDER BY event_type, id").all(docId);
    return rows.map((r: any) => ({ id: r.id, doc_id: r.doc_id, event_type: r.event_type, contact_id: r.contact_id, channel: r.channel, notifier_id: r.notifier_id, enabled: !!r.enabled }));
  }

  /** Crée/remplace un abonnement. La FK vérifie l'instance ; le contact est une référence
      SOUPLE (collection d'un document — garde-fou à l'affichage, cf. cadrage §2).
      AUDIT posé PAR LE SERVEUR : `authorId` = id canonique de l'auteur (RequestAuthor.identity) →
      `updated_by` à chaque écriture, `created_by` à la création puis préservé par l'upsert. */
  saveSubscription(candidate: Record<string, unknown>, id: string, authorId: string = ""): SubscriptionItem {
    const parsed: SubscriptionCandidate = NotifyValidate.parseSubscription(id, candidate);
    const author = AuditStamp.author(authorId);   // id non vide, sinon null
    this.db.prepare(`
      INSERT INTO subscriptions (id, doc_id, event_type, contact_id, channel, notifier_id, enabled, created_by, updated_by)
      VALUES (@id, @doc_id, @event_type, @contact_id, @channel, @notifier_id, @enabled, @created_by, @updated_by)
      ON CONFLICT(id) DO UPDATE SET doc_id=@doc_id, event_type=@event_type, contact_id=@contact_id, channel=@channel, notifier_id=@notifier_id, enabled=@enabled, updated_by=@updated_by
    `).run({ ...parsed, enabled: parsed.enabled ? 1 : 0, created_by: author, updated_by: author });
    this.log.info("notify: abonnement enregistré", parsed.id, parsed.event_type + " → " + parsed.channel);
    return this.listSubscriptions().find((s) => s.id === parsed.id)!;
  }

  removeSubscription(id: string): boolean {
    const changes = this.db.prepare("DELETE FROM subscriptions WHERE id = ?").run(id).changes || 0;
    if (changes > 0) this.log.info("notify: abonnement supprimé", id);
    return changes > 0;
  }

  /** Abonnements ACTIFS applicables à (event_type, doc) — l'entrée du routage :
      type exact OU joker "*" ; abonnements GLOBAUX (doc_id NULL) + ceux du document. */
  subscriptionsFor(eventType: string, docId: string | null): SubscriptionItem[] {
    const rows = this.db.prepare(`
      SELECT * FROM subscriptions
      WHERE enabled = 1 AND (event_type = @event_type OR event_type = '*')
        AND (doc_id IS NULL OR doc_id = @doc_id)
      ORDER BY id
    `).all({ event_type: eventType, doc_id: docId });
    return rows.map((r: any) => ({ id: r.id, doc_id: r.doc_id, event_type: r.event_type, contact_id: r.contact_id, channel: r.channel, notifier_id: r.notifier_id, enabled: !!r.enabled }));
  }

  /* --------------------------------------------------------------------------
     NotifyStateStore (le moteur ne connaît que ce contrat)
     -------------------------------------------------------------------------- */

  get(key: string): NotifyState | null {
    const row = this.db.prepare("SELECT * FROM notification_states WHERE key = ?").get(key) as any;
    return row ? NotifyDb.rowToState(row) : null;
  }

  set(state: NotifyState): void {
    this.db.prepare(`
      INSERT INTO notification_states (key, event_type, severity, doc_id, title, body, first_seen, last_sent, next_remind_at, remind_interval_sec, resolved_at, last_error)
      VALUES (@key, @event_type, @severity, @doc_id, @title, @body, @first_seen, @last_sent, @next_remind_at, @remind_interval_sec, @resolved_at, @last_error)
      ON CONFLICT(key) DO UPDATE SET event_type=@event_type, severity=@severity, doc_id=@doc_id, title=@title, body=@body,
        first_seen=@first_seen, last_sent=@last_sent, next_remind_at=@next_remind_at,
        remind_interval_sec=@remind_interval_sec, resolved_at=@resolved_at, last_error=@last_error
    `).run(state as unknown as Record<string, unknown>);
  }

  listActive(): NotifyState[] {
    return this.db.prepare("SELECT * FROM notification_states WHERE resolved_at IS NULL ORDER BY first_seen").all().map(NotifyDb.rowToState);
  }

  private static rowToState(row: any): NotifyState {
    return {
      key: row.key, event_type: row.event_type, severity: row.severity, doc_id: row.doc_id,
      title: row.title, body: row.body, first_seen: row.first_seen, last_sent: row.last_sent,
      next_remind_at: row.next_remind_at, remind_interval_sec: row.remind_interval_sec,
      resolved_at: row.resolved_at, last_error: row.last_error,
    };
  }

  /* --------------------------------------------------------------------------
     Historique (journal des remises) + réglages par type
     -------------------------------------------------------------------------- */

  appendLog(entry: NotifyJournalEntry): void {
    this.db.prepare(`
      INSERT INTO notification_log (sent_at, key, event_type, contact_id, channel, notifier_id, phase, ok, detail)
      VALUES (@sent_at, @key, @event_type, @contact_id, @channel, @notifier_id, @phase, @ok, @detail)
    `).run({ ...entry, ok: entry.ok ? 1 : 0 });
  }

  /** Historique PAGINÉ, du plus récent au plus ancien ; filtre optionnel par document. */
  listLog(opts: { limit?: number; offset?: number; docId?: string } = {}): NotifyLogPage {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    // Le log ne porte pas doc_id (la clé le contient déjà) : filtre par états connus du doc.
    // Paramètres nommés construits CONDITIONNELLEMENT — better-sqlite3 refuse une clé
    // de binding inconnue de la requête (et toute valeur undefined).
    const where = opts.docId ? "WHERE key IN (SELECT key FROM notification_states WHERE doc_id = @docId)" : "";
    const filter: Record<string, unknown> = opts.docId ? { docId: opts.docId } : {};
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM notification_log ${where}`).get(filter) as any).n as number;
    const entries = this.db.prepare(`SELECT * FROM notification_log ${where} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...filter, limit, offset })
      .map((r: any) => ({ ...r, ok: !!r.ok }));
    return { entries, total };
  }

  /** Purge l'historique par ANCIENNETÉ (cadrage §1) — appelée au démarrage puis par le timer. */
  purgeLog(maxAgeDays: number = NotifyDb.LOG_MAX_AGE_DAYS): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 3600 * 1000).toISOString();
    const purged = this.db.prepare("DELETE FROM notification_log WHERE sent_at < ?").run(cutoff).changes || 0;
    if (purged > 0) this.log.info("notify: historique purgé", purged + " entrée(s) de plus de " + maxAgeDays + " j");
    return purged;
  }

  /** Intervalle de rappel d'un TYPE (réglage admin, décision Q2) — défaut 12 h si non réglé.
      Relu par le moteur À CHAQUE échéance (réglage à chaud, aucun redémarrage). */
  remindIntervalSecFor(eventType: string): number {
    const row = this.db.prepare("SELECT remind_interval_sec FROM notify_event_settings WHERE event_type = ?").get(eventType) as any;
    return row ? row.remind_interval_sec : DEFAULT_REMIND_INTERVAL_SEC;
  }

  listEventSettings(): Array<{ event_type: string; remind_interval_sec: number }> {
    return this.db.prepare("SELECT event_type, remind_interval_sec FROM notify_event_settings ORDER BY event_type").all() as any[];
  }

  saveEventSetting(candidate: Record<string, unknown>): { event_type: string; remind_interval_sec: number } {
    const parsed = NotifyValidate.parseRemindInterval(candidate);
    this.db.prepare(`
      INSERT INTO notify_event_settings (event_type, remind_interval_sec) VALUES (@event_type, @remind_interval_sec)
      ON CONFLICT(event_type) DO UPDATE SET remind_interval_sec=@remind_interval_sec
    `).run(parsed);
    return parsed;
  }

  removeEventSetting(eventType: string): boolean {
    return (this.db.prepare("DELETE FROM notify_event_settings WHERE event_type = ?").run(eventType).changes || 0) > 0;
  }
}
