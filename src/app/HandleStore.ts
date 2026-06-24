/* =============================================================================
   Persistance du HANDLE de fichier (File System Access API) en IndexedDB.
   Les FileSystemFileHandle ne survivent pas à un reload de page : seul le HANDLE
   sérialisé en IndexedDB persiste — mais sa réutilisation exige un GESTE
   utilisateur (re-demande de permission). On mémorise donc le dernier fichier
   ouvert/enregistré pour proposer « Rouvrir … » sur l'écran d'accueil après un
   refresh, ce qui permet de raccrocher au handle (et de relancer l'auto-save).
   Tout est best-effort : si IndexedDB est indisponible, on dégrade silencieusement.
   ============================================================================= */
const DB_NAME = "netmap-fs";
const STORE = "handles";
const LAST_KEY = "lastFile";
const FACES_KEY = "facesFile";   // handle du fichier compagnon d'images (.nmfb) du dernier document

export interface HandleRec { handle: any; name: string; }

export class HandleStore {
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) { reject(new Error("no-idb")); return; }
      const req = indexedDB.open(DB_NAME);   // sans version : ouvre l'existant ou crée en v1
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("idb-open-failed"));
    });
  }

  /** Dernier fichier mémorisé { handle, name }, ou null. */
  async getLast(): Promise<HandleRec | null> {
    try {
      const db = await this.open();
      if (!db.objectStoreNames.contains(STORE)) { db.close(); return null; }
      const rec = await new Promise<any>((res, rej) => {
        const tx = db.transaction(STORE, "readonly"); const r = tx.objectStore(STORE).get(LAST_KEY);
        r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
      });
      db.close();
      return rec && rec.handle ? rec : null;
    } catch (_) { return null; }
  }

  /** Mémorise le dernier fichier (best-effort). */
  async putLast(handle: any, name: string): Promise<void> {
    if (!handle) return;
    try {
      const db = await this.open();
      await new Promise<void>((res, rej) => {
        const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).put({ handle, name: name || handle.name || "" }, LAST_KEY);
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
      db.close();
    } catch (_) { /* noop */ }
  }

  /** Oublie le dernier fichier (ex. introuvable). */
  async clearLast(): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((res, rej) => {
        const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).delete(LAST_KEY);
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
      db.close();
    } catch (_) { /* noop */ }
  }

  /** Dernier fichier COMPAGNON d'images (.nmfb) mémorisé { handle, name }, ou null. */
  async getFaces(): Promise<HandleRec | null> {
    try {
      const db = await this.open();
      if (!db.objectStoreNames.contains(STORE)) { db.close(); return null; }
      const rec = await new Promise<any>((res, rej) => {
        const tx = db.transaction(STORE, "readonly"); const r = tx.objectStore(STORE).get(FACES_KEY);
        r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
      });
      db.close();
      return rec && rec.handle ? rec : null;
    } catch (_) { return null; }
  }

  /** Mémorise le fichier compagnon d'images (best-effort). */
  async putFaces(handle: any, name: string): Promise<void> {
    if (!handle) return;
    try {
      const db = await this.open();
      await new Promise<void>((res, rej) => {
        const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).put({ handle, name: name || handle.name || "" }, FACES_KEY);
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
      db.close();
    } catch (_) { /* noop */ }
  }

  /** Permission de LECTURE d'un handle : true (accordée) · false (refusée) · null (indéterminée).
      `interactive` (geste utilisateur) autorise la re-demande. */
  static async ensureReadPermission(handle: any, interactive: boolean): Promise<boolean | null> {
    if (!handle) return false;
    const opts: any = { mode: "read" };
    try {
      if (typeof handle.queryPermission === "function") { const st = await handle.queryPermission(opts); if (st === "granted") return true; }
      if (interactive && typeof handle.requestPermission === "function") { return (await handle.requestPermission(opts)) === "granted"; }
      return null;
    } catch (_) { return null; }
  }
}
