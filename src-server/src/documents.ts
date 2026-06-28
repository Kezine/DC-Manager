import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { Repository, type SqliteCtor, type SqliteDb } from "./db.js";
import { Logger } from "./logger.js";

export interface DocMeta { id: string; name: string; created_date: string; updated_date: string; rev?: number; locked?: boolean }

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
    try { this.registry.exec("ALTER TABLE documents ADD COLUMN rev INTEGER NOT NULL DEFAULT 0"); } catch { /* colonne déjà présente */ }      // migration
    // `locked` : document VERROUILLÉ → protégé d'une suppression conventionnelle (cf. setLocked / Api.deleteDoc). 0 = libre.
    try { this.registry.exec("ALTER TABLE documents ADD COLUMN locked INTEGER NOT NULL DEFAULT 0"); } catch { /* colonne déjà présente */ }   // migration
    this.log.info("registre ouvert", path.join(dir, "registry.db"));
  }

  /** Coercition de la ligne registre → DocMeta (l'entier SQLite `locked` 0/1 devient booléen). */
  private toMeta(row: any): DocMeta { return { ...row, locked: !!row.locked }; }

  list(): DocMeta[] {
    return (this.registry.prepare("SELECT id, name, created_date, updated_date, rev, locked FROM documents ORDER BY updated_date DESC").all() as any[]).map((r) => this.toMeta(r));
  }
  get(id: string): DocMeta | null {
    const row = this.registry.prepare("SELECT id, name, created_date, updated_date, rev, locked FROM documents WHERE id = ?").get(id);
    return row ? this.toMeta(row) : null;
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
    return this.get(id) || meta;   // relit la ligne → inclut `locked` (false), cohérent avec list()/get()
  }
  rename(id: string, name: string): DocMeta | null {
    if (!this.get(id)) return null;
    this.registry.prepare("UPDATE documents SET name = @name, updated_date = @t WHERE id = @id")
      .run({ id, name: (name || "").trim() || "Sans titre", t: new Date().toISOString() });
    this.log.info("document renommé", id, "«" + ((name || "").trim() || "Sans titre") + "»");
    return this.get(id);
  }
  /** Verrouille / déverrouille un document (protection anti-suppression accidentelle). Ne touche PAS `updated_date`
      (action d'administration, pas une édition de contenu → l'ordre de la liste reste stable). */
  setLocked(id: string, locked: boolean): DocMeta | null {
    if (!this.get(id)) return null;
    this.registry.prepare("UPDATE documents SET locked = ? WHERE id = ?").run(locked ? 1 : 0, id);
    this.log.info(locked ? "document verrouillé" : "document déverrouillé", id);
    return this.get(id);
  }
  /** Mécanisme brut de suppression. Le refus d'un document VERROUILLÉ est appliqué à la couche API
      (`Api.deleteDoc` → 423) pour distinguer « verrouillé » de « inconnu » ; cf. setLocked. */
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
