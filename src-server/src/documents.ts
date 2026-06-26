import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Repository, type SqliteCtor, type SqliteDb } from "./db.js";

export interface DocMeta { id: string; name: string; created_date: string; updated_date: string }

/** Multi-DOCUMENTS : un registre (registry.db) + un fichier SQLite (Repository) PAR document.
    Chaque document est un workspace isolé. Driver injecté (better-sqlite3 / shim de test). */
export class DocumentStore {
  private readonly registry: SqliteDb;
  private readonly repos = new Map<string, Repository>();

  constructor(private readonly dir: string, private readonly Database: SqliteCtor) {
    fs.mkdirSync(dir, { recursive: true });
    this.registry = new Database(path.join(dir, "registry.db"));
    this.registry.pragma("journal_mode = WAL");
    this.registry.exec(`CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_date TEXT, updated_date TEXT)`);
  }

  list(): DocMeta[] {
    return this.registry.prepare("SELECT id, name, created_date, updated_date FROM documents ORDER BY updated_date DESC").all() as DocMeta[];
  }
  get(id: string): DocMeta | null {
    return (this.registry.prepare("SELECT id, name, created_date, updated_date FROM documents WHERE id = ?").get(id) as DocMeta) || null;
  }
  create(name: string): DocMeta {
    const id = "doc-" + randomUUID(), t = new Date().toISOString();
    const meta: DocMeta = { id, name: (name || "").trim() || "Sans titre", created_date: t, updated_date: t };
    this.registry.prepare("INSERT INTO documents (id, name, created_date, updated_date) VALUES (@id, @name, @created_date, @updated_date)").run(meta);
    this.repo(id);   // matérialise le fichier du document
    return meta;
  }
  rename(id: string, name: string): DocMeta | null {
    if (!this.get(id)) return null;
    this.registry.prepare("UPDATE documents SET name = @name, updated_date = @t WHERE id = @id")
      .run({ id, name: (name || "").trim() || "Sans titre", t: new Date().toISOString() });
    return this.get(id);
  }
  /** Met à jour updated_date (appelé sur écriture dans le document). */
  touch(id: string): void {
    this.registry.prepare("UPDATE documents SET updated_date = @t WHERE id = @id").run({ id, t: new Date().toISOString() });
  }
  delete(id: string): boolean {
    if (!this.get(id)) return false;
    this.repos.delete(id);
    for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(path.join(this.dir, id + ".db" + ext), { force: true }); } catch { /* noop */ } }
    this.registry.prepare("DELETE FROM documents WHERE id = ?").run(id);
    return true;
  }
  /** Repository du document (ouvert à la demande, mis en cache), ou null si le document n'existe pas. */
  repo(id: string): Repository | null {
    if (!this.get(id)) return null;
    let r = this.repos.get(id);
    if (!r) { r = Repository.open(path.join(this.dir, id + ".db"), this.Database); this.repos.set(id, r); }
    return r;
  }
}
