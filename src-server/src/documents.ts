import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Repository, type SqliteCtor, type SqliteDb } from "./db.js";
import { Logger } from "./logger.js";

export interface DocMeta { id: string; name: string; created_date: string; updated_date: string; rev?: number }

/** Multi-DOCUMENTS : un registre (registry.db) + un fichier SQLite (Repository) PAR document.
    Chaque document est un workspace isolé. Driver injecté (better-sqlite3 / shim de test). */
export class DocumentStore {
  private readonly registry: SqliteDb;
  private readonly repos = new Map<string, Repository>();

  constructor(private readonly dir: string, private readonly Database: SqliteCtor, private readonly log: Logger = new Logger("error")) {
    fs.mkdirSync(dir, { recursive: true });
    this.registry = new Database(path.join(dir, "registry.db"));
    this.registry.pragma("journal_mode = WAL");
    this.registry.exec(`CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_date TEXT, updated_date TEXT, rev INTEGER NOT NULL DEFAULT 0)`);
    try { this.registry.exec("ALTER TABLE documents ADD COLUMN rev INTEGER NOT NULL DEFAULT 0"); } catch { /* colonne déjà présente */ }   // migration
    this.log.info("registre ouvert", path.join(dir, "registry.db"));
  }

  list(): DocMeta[] {
    return this.registry.prepare("SELECT id, name, created_date, updated_date, rev FROM documents ORDER BY updated_date DESC").all() as DocMeta[];
  }
  get(id: string): DocMeta | null {
    return (this.registry.prepare("SELECT id, name, created_date, updated_date, rev FROM documents WHERE id = ?").get(id) as DocMeta) || null;
  }
  /** Révision courante du document (compteur incrémenté à chaque écriture). */
  getRev(id: string): number { const r = this.registry.prepare("SELECT rev FROM documents WHERE id = ?").get(id); return r ? (r.rev as number) : 0; }
  /** Écriture survenue : incrémente rev + updated_date, renvoie la nouvelle rev. */
  markChanged(id: string): number {
    const next = this.getRev(id) + 1;
    this.registry.prepare("UPDATE documents SET rev = @rev, updated_date = @t WHERE id = @id").run({ id, rev: next, t: new Date().toISOString() });
    return next;
  }
  create(name: string): DocMeta {
    const id = "doc-" + randomUUID(), t = new Date().toISOString();
    const meta: DocMeta = { id, name: (name || "").trim() || "Sans titre", created_date: t, updated_date: t };
    this.registry.prepare("INSERT INTO documents (id, name, created_date, updated_date) VALUES (@id, @name, @created_date, @updated_date)").run(meta);
    this.repo(id);   // matérialise le fichier du document
    this.log.info("document créé", meta.id, "«" + meta.name + "»");
    return meta;
  }
  rename(id: string, name: string): DocMeta | null {
    if (!this.get(id)) return null;
    this.registry.prepare("UPDATE documents SET name = @name, updated_date = @t WHERE id = @id")
      .run({ id, name: (name || "").trim() || "Sans titre", t: new Date().toISOString() });
    this.log.info("document renommé", id, "«" + ((name || "").trim() || "Sans titre") + "»");
    return this.get(id);
  }
  delete(id: string): boolean {
    if (!this.get(id)) return false;
    this.repos.delete(id);
    for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(path.join(this.dir, id + ".db" + ext), { force: true }); } catch { /* noop */ } }
    this.registry.prepare("DELETE FROM documents WHERE id = ?").run(id);
    this.log.info("document supprimé", id);
    return true;
  }
  /** Repository du document (ouvert à la demande, mis en cache), ou null si le document n'existe pas. */
  repo(id: string): Repository | null {
    if (!this.get(id)) return null;
    let r = this.repos.get(id);
    if (!r) { r = Repository.open(path.join(this.dir, id + ".db"), this.Database); this.repos.set(id, r); this.log.debug("dépôt ouvert", id); }
    return r;
  }
}
