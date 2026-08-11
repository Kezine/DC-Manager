/* =============================================================================
   Persistance du HANDLE de fichier (File System Access API) en IndexedDB.
   Les FileSystemFileHandle ne survivent pas à un reload de page : seul le HANDLE
   sérialisé en IndexedDB persiste — mais sa réutilisation exige un GESTE
   utilisateur (re-demande de permission). On mémorise donc le dernier fichier
   ouvert/enregistré pour proposer « Rouvrir … » sur l'écran d'accueil après un
   refresh, ce qui permet de raccrocher au handle (et de relancer l'auto-save).
   Tout est best-effort : si IndexedDB est indisponible, on dégrade silencieusement.

   Quatre emplacements, même mécanique (lecture/écriture factorisées `read`/
   `write`/`remove` — l'arrivée du compagnon de pièces jointes aurait fait une
   4e copie du même code, principe n°3) :
     - lastFile        : dernier .json ouvert (bouton « Rouvrir ») ;
     - facesFile       : compagnon d'images .nmfb du dernier document ;
     - attachmentsFile : compagnon de pièces jointes .nmfa du dernier document ;
     - lastDir         : dossier du mode « accès dossier » (+ nom du .json).
   ============================================================================= */
const DB_NAME = "dc-manager-fs";
const STORE = "handles";
const LAST_KEY = "lastFile";
const FACES_KEY = "facesFile";               // handle du fichier compagnon d'images (.nmfb) du dernier document
const ATTACHMENTS_KEY = "attachmentsFile";   // handle du fichier compagnon de pièces jointes (.nmfa) du dernier document
const DIR_KEY = "lastDir";                   // handle du DOSSIER (mode « accès dossier ») + nom du .json courant à l'intérieur

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

  /** Lit l'enregistrement { handle, name } d'un emplacement, ou null (absent / IndexedDB indisponible). */
  private async read(key: string): Promise<HandleRec | null> {
    try {
      const db = await this.open();
      if (!db.objectStoreNames.contains(STORE)) { db.close(); return null; }
      const rec = await new Promise<any>((res, rej) => {
        const tx = db.transaction(STORE, "readonly"); const r = tx.objectStore(STORE).get(key);
        r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
      });
      db.close();
      return rec && rec.handle ? rec : null;
    } catch (_) { return null; }
  }

  /** Mémorise { handle, name } dans un emplacement (best-effort). */
  private async write(key: string, handle: any, name: string): Promise<void> {
    if (!handle) return;
    try {
      const db = await this.open();
      await new Promise<void>((res, rej) => {
        const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).put({ handle, name: name || "" }, key);
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
      db.close();
    } catch (_) { /* noop */ }
  }

  /** Oublie un emplacement (ex. fichier introuvable), best-effort. */
  private async remove(key: string): Promise<void> {
    try {
      const db = await this.open();
      await new Promise<void>((res, rej) => {
        const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
      db.close();
    } catch (_) { /* noop */ }
  }

  /** Dernier fichier mémorisé { handle, name }, ou null. */
  getLast(): Promise<HandleRec | null> { return this.read(LAST_KEY); }
  /** Mémorise le dernier fichier (best-effort). Le nom retombe sur celui du handle si absent. */
  putLast(handle: any, name: string): Promise<void> { return this.write(LAST_KEY, handle, name || (handle && handle.name) || ""); }
  /** Oublie le dernier fichier (ex. introuvable). */
  clearLast(): Promise<void> { return this.remove(LAST_KEY); }

  /** Dernier fichier COMPAGNON d'images (.nmfb) mémorisé { handle, name }, ou null. */
  getFaces(): Promise<HandleRec | null> { return this.read(FACES_KEY); }
  /** Mémorise le fichier compagnon d'images (best-effort). */
  putFaces(handle: any, name: string): Promise<void> { return this.write(FACES_KEY, handle, name || (handle && handle.name) || ""); }

  /** Dernier fichier COMPAGNON de pièces jointes (.nmfa) mémorisé { handle, name }, ou null. */
  getAttachments(): Promise<HandleRec | null> { return this.read(ATTACHMENTS_KEY); }
  /** Mémorise le fichier compagnon de pièces jointes (best-effort). */
  putAttachments(handle: any, name: string): Promise<void> { return this.write(ATTACHMENTS_KEY, handle, name || (handle && handle.name) || ""); }

  /** Dernier DOSSIER mémorisé (mode « accès dossier ») { handle, name } — `name` = le .json ouvert dedans, ou null. */
  getDir(): Promise<HandleRec | null> { return this.read(DIR_KEY); }
  /** Mémorise le dossier courant + le nom du .json ouvert dedans (best-effort). */
  putDir(handle: any, name: string): Promise<void> { return this.write(DIR_KEY, handle, name); }
  /** Oublie le dossier mémorisé (ex. .json introuvable dedans). */
  clearDir(): Promise<void> { return this.remove(DIR_KEY); }

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
