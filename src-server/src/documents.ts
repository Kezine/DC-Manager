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
    // RÉGLAGES GLOBAUX (clé/valeur), INDÉPENDANTS d'un document : ex. `defaultDocId` = document ouvert au boot d'un
    // NOUVEAU client (aucun « dernier doc ouvert » mémorisé côté navigateur). Partagé entre tous les clients.
    this.registry.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
    this.log.info("registre ouvert", path.join(dir, "registry.db"));
  }

  /* -- réglages globaux (clé/valeur) -- */
  /** Lit un réglage global (null si absent). */
  getSetting(key: string): string | null { const r = this.registry.prepare("SELECT value FROM settings WHERE key = ?").get(key); return r ? (r.value as string) : null; }
  /** Écrit (ou efface si `value === null`) un réglage global. */
  setSetting(key: string, value: string | null): void {
    if (value === null) this.registry.prepare("DELETE FROM settings WHERE key = ?").run(key);
    else this.registry.prepare("INSERT INTO settings (key, value) VALUES (@k, @v) ON CONFLICT(key) DO UPDATE SET value = @v").run({ k: key, v: value });
  }
  /** Document par DÉFAUT (ouvert au boot quand le client n'a aucun « dernier doc ouvert »). Renvoie null si non
      défini OU si le document a depuis été supprimé (réglage périmé ignoré → le boot retombe sur le plus récent). */
  getDefaultDocId(): string | null { const id = this.getSetting("defaultDocId"); return id && this.get(id) ? id : null; }
  /** Définit (ou efface si null) le document par défaut. L'id inconnu est refusé (renvoie false). */
  setDefaultDocId(id: string | null): boolean {
    if (id !== null && !this.get(id)) return false;
    this.setSetting("defaultDocId", id);
    this.log.info(id ? "document par défaut défini" : "document par défaut effacé", id || "");
    return true;
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
    // FERMER le handle SQLite AVANT de supprimer les fichiers : sous Windows, `rmSync` sur un fichier encore
    // ouvert échoue (EBUSY/EPERM) — le contenu du document « supprimé » resterait sur disque, avec fuite de
    // descripteur. Un échec de suppression est LOGUÉ (et non avalé) : la ligne registre disparaît quand même,
    // le fichier orphelin est alors du déchet inerte signalé, pas une fuite silencieuse.
    const repo = this.repos.get(id);
    if (repo) { try { repo.close(); } catch { /* handle déjà fermé */ } this.repos.delete(id); }
    for (const ext of ["", "-wal", "-shm"]) {
      try { fs.rmSync(path.join(this.dir, id + ".db" + ext), { force: true }); }
      catch (e: any) { this.log.warn("fichier non supprimé", id + ".db" + ext, e && e.message); }
    }
    this.registry.prepare("DELETE FROM documents WHERE id = ?").run(id);
    if (this.getSetting("defaultDocId") === id) this.setSetting("defaultDocId", null);   // le doc par défaut vient d'être supprimé → on efface le réglage périmé
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
