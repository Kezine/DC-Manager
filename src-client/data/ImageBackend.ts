import type { ImageRec } from "./ImageStore";

/* =============================================================================
   BACKEND de persistance des images de façade — normalise l'accès aux blobs
   derrière une interface, pour que `ImageStore` (miroir + undo + bundle .nmfb)
   soit AGNOSTIQUE du mode :
     - mode FICHIER  → IndexedDB (base dédiée) ; le compagnon .nmfb reste géré
       par ImageStore.serializeBundle/loadBundle (artefact fichier).
     - mode API      → endpoints blob REST (`/images`) ; pas de .nmfb.
   ============================================================================= */
export interface ImageBackend {
  /** Hydrate la totalité (boot / session). En REST, `blob` peut être null et `url` pointe le serveur. */
  getAll(): Promise<ImageRec[]>;
  /** Lit un enregistrement complet (blob inclus) — pour capturer l'état avant modif (undo). */
  getRaw(id: string): Promise<ImageRec | null>;
  /** Crée/remplace un enregistrement (id fourni par le client). */
  put(rec: ImageRec): Promise<void>;
  /** Supprime un enregistrement. */
  del(id: string): Promise<void>;
  /** Vide tout (réouverture de document / nouveau document). */
  clear(): Promise<void>;
}

/* ---------- IndexedDB (mode fichier) — comportement historique d'ImageStore ---------- */
const DB_NAME = "dc-manager-images";
const STORE = "images";

export class IdbImageBackend implements ImageBackend {
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("no-idb")); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("idb-open-failed"));
    });
  }
  async put(rec: ImageRec): Promise<void> { const db = await this.open(); await new Promise<void>((res, rej) => { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).put(rec); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); db.close(); }
  async del(id: string): Promise<void> { const db = await this.open(); await new Promise<void>((res, rej) => { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).delete(id); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); db.close(); }
  async getRaw(id: string): Promise<ImageRec | null> { const db = await this.open(); const rec = await new Promise<ImageRec | null>((res, rej) => { const tx = db.transaction(STORE, "readonly"); const r = tx.objectStore(STORE).get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); }); db.close(); return rec; }
  async getAll(): Promise<ImageRec[]> { const db = await this.open(); const recs = await new Promise<ImageRec[]>((res, rej) => { const tx = db.transaction(STORE, "readonly"); const r = tx.objectStore(STORE).getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); db.close(); return recs; }
  async clear(): Promise<void> { const db = await this.open(); await new Promise<void>((res, rej) => { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).clear(); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); db.close(); }
}

/* ---------- REST (mode API) — endpoints blob ; cookies SSO transmis ----------
   Contrat :
     GET    /images              → [{ id, name, u_height, face, description, type, bytes }]
     GET    /images/{id}/blob    → binaire
     PUT    /images/{id}         → multipart { meta: JSON, blob: file } (crée/remplace)
     DELETE /images/{id}
   Le miroir UI utilise directement l'URL serveur `/images/{id}/blob` (même origine →
   cookies envoyés par le navigateur) : pas de pré-téléchargement des blobs au boot. */
export class RestImageBackend implements ImageBackend {
  constructor(private baseUrl: string) { this.baseUrl = baseUrl.replace(/\/+$/, ""); }
  /** Recale la base (scope document : /api/documents/{docId}) quand on ouvre un document. */
  setBaseUrl(url: string): void { this.baseUrl = url.replace(/\/+$/, ""); }
  private blobUrl(id: string): string { return this.baseUrl + "/images/" + encodeURIComponent(id) + "/blob"; }

  async getAll(): Promise<ImageRec[]> {
    const res = await fetch(this.baseUrl + "/images", { credentials: "include" });
    if (!res.ok) throw new Error("HTTP " + res.status + " sur GET /images");
    const list = (await res.json()) || [];
    // métadonnées seules : blob null, url = endpoint serveur (chargé à l'affichage par le navigateur).
    // `rev` = révision du BINAIRE (jeton de cache-busting ?v= — cf. Repository.putImage / faceImageUrl).
    return (list as any[]).map((m) => ({ id: m.id, name: m.name || "", u_height: m.u_height || 1, face: m.face || "front", with_ears: m.with_ears !== false, description: m.description || "", type: m.type || "", blob: null, bytes: m.bytes || 0, rev: m.rev, url: this.blobUrl(m.id) }));
  }
  async getRaw(id: string): Promise<ImageRec | null> {
    const meta = await fetch(this.baseUrl + "/images/" + encodeURIComponent(id), { credentials: "include" });
    if (meta.status === 404) return null;
    if (!meta.ok) throw new Error("HTTP " + meta.status + " sur GET /images/" + id);
    const m = await meta.json();
    const br = await fetch(this.blobUrl(id), { credentials: "include" });
    const blob = br.ok ? await br.blob() : null;
    return { id: m.id, name: m.name || "", u_height: m.u_height || 1, face: m.face || "front", with_ears: m.with_ears !== false, description: m.description || "", type: m.type || (blob && blob.type) || "", blob, bytes: m.bytes || (blob ? blob.size : 0), rev: m.rev, url: this.blobUrl(id) };
  }
  async put(rec: ImageRec): Promise<void> {
    const fd = new FormData();
    fd.append("meta", JSON.stringify({ id: rec.id, name: rec.name || "", u_height: rec.u_height || 1, face: rec.face, with_ears: rec.with_ears !== false, description: rec.description || "", type: rec.type || (rec.blob && rec.blob.type) || "" }));
    if (rec.blob) fd.append("blob", rec.blob, rec.name || rec.id);
    const res = await fetch(this.baseUrl + "/images/" + encodeURIComponent(rec.id), { method: "PUT", credentials: "include", body: fd });
    if (!res.ok) throw new Error("HTTP " + res.status + " sur PUT /images/" + rec.id);
  }
  async del(id: string): Promise<void> {
    const res = await fetch(this.baseUrl + "/images/" + encodeURIComponent(id), { method: "DELETE", credentials: "include" });
    if (!res.ok && res.status !== 404) throw new Error("HTTP " + res.status + " sur DELETE /images/" + id);
  }
  async clear(): Promise<void> {
    // pas d'effacement global serveur (destructif) : on supprime les images connues une à une.
    const all = await this.getAll().catch(() => [] as ImageRec[]);
    for (const r of all) { try { await this.del(r.id); } catch (_) { /* best-effort */ } }
  }
}
