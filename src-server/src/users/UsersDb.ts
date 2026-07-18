import fs from "node:fs";
import path from "node:path";
import { Logger } from "../logger.js";
import type { SqliteCtor, SqliteDb } from "../db.js";
import type { ResolvedUser } from "./UserResolver.js";

/* =============================================================================
   SNAPSHOT DE L'ANNUAIRE — base SQLite DÉDIÉE `users.db` (à côté de registry.db,
   même dossier data injecté, même driver better-sqlite3 injecté que DocumentStore).

   RÔLE : « dernier profil vu » PERSISTANT. Le resolver v1 (AuthCacheUserResolver)
   tient son état en MÉMOIRE, mais ce cache s'évapore au redémarrage — tous les
   auteurs historiques résoudraient alors en dummy jusqu'à leur reconnexion. Le
   snapshot évite cet effet : il est RÉHYDRATÉ au boot (loadAll) et mis à jour
   (upsert) à chaque capture de profil.

   UNE table typée `users_seen` (jamais de blob JSON — contrainte transverse du
   projet) : la clé canonique + les champs affichables + l'horodatage du dernier
   rafraîchissement. Le pattern MIGRATION idempotent (`ensureColumn`, inspection de
   pragma_table_info) est en place pour les évolutions futures du schéma, comme dans
   NotifyDb/InterventionsDb/CertsDb.

   Supprimer l'annuaire = retirer son câblage d'index.ts + le dossier users/ + ce
   fichier users.db (aucune autre base n'y référence — snapshot autonome).
   ============================================================================= */

/** Nom de la base dédiée à l'annuaire, DANS le dossier injecté (à côté de registry.db). */
export const USERS_DB_FILE = "users.db";

export class UsersDb {
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
    this.db = new Database(path.join(dir, USERS_DB_FILE));
    // Réglages de parité DocumentStore/NotifyDb/InterventionsDb (WAL + timeout anti-BUSY + synchronous NORMAL).
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.createSchema();
    this.log.info("users: snapshot ouvert", path.join(dir, USERS_DB_FILE));
  }

  close(): void { this.db.close(); }

  /* --------------------------------------------------------------------------
     Schéma + migrations idempotentes (pattern NotifyDb/InterventionsDb.ensureColumn)
     -------------------------------------------------------------------------- */

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users_seen (
        id           TEXT PRIMARY KEY,
        login        TEXT NOT NULL DEFAULT '',
        domain       TEXT NOT NULL DEFAULT '',
        firstname    TEXT NOT NULL DEFAULT '',
        lastname     TEXT NOT NULL DEFAULT '',
        email        TEXT NOT NULL DEFAULT '',
        phone        TEXT NOT NULL DEFAULT '',
        updated_date TEXT NOT NULL
      );
    `);
    // MIGRATIONS PRÊTES POUR L'AVENIR : sur une base fraîche elles ne font rien (colonnes déjà
    // dans le CREATE) ; sur une users.db antérieure elles ajouteraient la colonne manquante.
    this.ensureColumn("users_seen", "phone", "TEXT NOT NULL DEFAULT ''");
  }

  /** ALTER TABLE ADD COLUMN idempotent : n'ajoute la colonne que si elle manque (table_info). */
  private ensureColumn(table: string, column: string, ddl: string): void {
    const columns = this.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((r: any) => r.name);
    if (!columns.includes(column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
      this.log.info("users: migration — colonne ajoutée", table + "." + column);
    }
  }

  /* --------------------------------------------------------------------------
     Réhydratation + upsert « dernier profil vu »
     -------------------------------------------------------------------------- */

  /** Tous les profils connus — lus AU BOOT pour réamorcer le cache mémoire du resolver. */
  loadAll(): ResolvedUser[] {
    return (this.db.prepare("SELECT id, login, domain, firstname, lastname, email, phone FROM users_seen").all() as any[])
      .map((r) => ({ id: r.id, login: r.login, domain: r.domain, firstname: r.firstname, lastname: r.lastname, email: r.email, phone: r.phone }));
  }

  /** Écrit/rafraîchit le « dernier profil vu » d'un id. `updated_date` estampille l'instant de
      capture (le resolver ne rappelle cette méthode que si le profil a CHANGÉ ou après un délai —
      il n'écrit donc PAS à chaque requête). */
  upsert(user: ResolvedUser): void {
    this.db.prepare(`
      INSERT INTO users_seen (id, login, domain, firstname, lastname, email, phone, updated_date)
      VALUES (@id, @login, @domain, @firstname, @lastname, @email, @phone, @updated_date)
      ON CONFLICT(id) DO UPDATE SET login=@login, domain=@domain, firstname=@firstname, lastname=@lastname,
        email=@email, phone=@phone, updated_date=@updated_date
    `).run({ ...user, updated_date: new Date().toISOString() });
  }
}
