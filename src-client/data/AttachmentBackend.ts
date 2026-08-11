import { SessionExpiry } from "../core/SessionExpiry";   // signale un 401 (session SSO expirée) → retour au login (idempotent)

/* =============================================================================
   BACKEND de persistance des BINAIRES de pièces jointes — normalise l'accès aux
   blobs derrière une interface (patron exact d'`ImageBackend`), pour que
   `AttachmentStore` (façade + bundle .nmfa) soit AGNOSTIQUE du mode :
     - mode FICHIER  → IndexedDB (base dédiée `dc-manager-attachments`) ; le
       compagnon .nmfa est géré par AttachmentStore (artefact fichier) ;
     - mode API      → endpoints du serveur (`POST /attachments` multipart,
       `GET /attachments/{id}/blob`) ; pas de .nmfa.
   ⚠ Différence VOULUE avec les images : les MÉTADONNÉES ne passent pas par ce
   backend — elles vivent dans la collection `attachments` du DOCUMENT (Store du
   modèle : undo, verrou optimiste, recherche, cascade — décision D1). Le backend
   ne connaît que le couple id → binaire.
   ============================================================================= */
export interface AttachmentBackend {
  /** Ids des binaires PRÉSENTS localement (mode fichier : contenu d'IndexedDB). En REST, liste vide :
      les binaires vivent au serveur, leur inventaire est le travail de la MAINTENANCE serveur (D5). */
  listIds(): Promise<string[]>;
  /** Lit un binaire (null s'il est absent/inaccessible). En REST : téléchargement du blob serveur. */
  getBlob(id: string): Promise<Blob | null>;
  /** Crée/remplace un binaire. `meta` = l'ENREGISTREMENT de la collection : en REST, le POST multipart
      crée AUSSI l'enregistrement (création ATOMIQUE côté serveur — fichier puis insertion, cf. D5) ;
      en IndexedDB, seuls l'id et le type MIME en sont retenus (l'enregistrement passe par le Store). */
  put(id: string, blob: Blob, meta: Record<string, any>): Promise<void>;
  /** Supprime un binaire LOCAL. ⚠ Réservé à la purge/au remplacement : la suppression d'un
      ENREGISTREMENT ne supprime jamais le binaire (D5 — l'undo doit le retrouver). En REST : no-op
      (aucune route d'unlink n'existe, la purge est le travail de la maintenance serveur). */
  del(id: string): Promise<void>;
  /** Vide tout (changement de document). En REST : no-op (les binaires appartiennent au document serveur). */
  clear(): Promise<void>;
  /** URL de TÉLÉCHARGEMENT servie par le serveur (REST — même origine, cookies transmis, l'en-tête
      `Content-Disposition: attachment` force le download), ou null (fichier : passer par `getBlob`). */
  downloadUrl(id: string): string | null;
}

/* ---------- IndexedDB (mode fichier) — mécanique identique à IdbImageBackend ---------- */
const DB_NAME = "dc-manager-attachments";
const STORE = "attachments";

/** Enregistrement IndexedDB : le binaire + le type MIME (pour re-typer le Blob à la relecture). */
interface IdbAttachmentRec { id: string; blob: Blob; type: string }

export class IdbAttachmentBackend implements AttachmentBackend {
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("no-idb")); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("idb-open-failed"));
    });
  }
  async put(id: string, blob: Blob, meta: Record<string, any>): Promise<void> {
    const rec: IdbAttachmentRec = { id, blob, type: String(meta.mime || blob.type || "") };
    const db = await this.open();
    await new Promise<void>((res, rej) => { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).put(rec); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
    db.close();
  }
  async del(id: string): Promise<void> { const db = await this.open(); await new Promise<void>((res, rej) => { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).delete(id); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); db.close(); }
  async getBlob(id: string): Promise<Blob | null> {
    const db = await this.open();
    const rec = await new Promise<IdbAttachmentRec | null>((res, rej) => { const tx = db.transaction(STORE, "readonly"); const r = tx.objectStore(STORE).get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); });
    db.close();
    return rec ? rec.blob : null;
  }
  async listIds(): Promise<string[]> {
    const db = await this.open();
    const ids = await new Promise<string[]>((res, rej) => { const tx = db.transaction(STORE, "readonly"); const r = tx.objectStore(STORE).getAllKeys(); r.onsuccess = () => res((r.result || []).map(String)); r.onerror = () => rej(r.error); });
    db.close();
    return ids;
  }
  async clear(): Promise<void> { const db = await this.open(); await new Promise<void>((res, rej) => { const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).clear(); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); db.close(); }
  downloadUrl(): string | null { return null; }   // mode fichier : pas d'URL serveur — le download passe par getBlob
}

/* ---------- REST (mode API) — endpoints serveur ; cookies SSO transmis ----------
   Contrat (cf. src-server/src/api.ts) :
     POST /attachments               → multipart { meta: JSON, blob: file } — crée le FICHIER puis
                                       l'ENREGISTREMENT (201 = record estampillé ; le serveur pose `size`)
     GET  /attachments/{id}/blob     → binaire STREAMÉ, Content-Disposition: attachment (D6)
   Le reste (listing/lecture/édition/suppression des MÉTADONNÉES) passe par les routes GÉNÉRIQUES de
   collection — donc par le Store/RestAdapter, jamais par ce backend. */
export class RestAttachmentBackend implements AttachmentBackend {
  constructor(private baseUrl: string) { this.baseUrl = baseUrl.replace(/\/+$/, ""); }
  /** Recale la base (scope document : /api/documents/{docId}) quand on ouvre un document. */
  setBaseUrl(url: string): void { this.baseUrl = url.replace(/\/+$/, ""); }
  private blobUrl(id: string): string { return this.baseUrl + "/attachments/" + encodeURIComponent(id) + "/blob"; }

  async put(id: string, blob: Blob, meta: Record<string, any>): Promise<void> {
    const fd = new FormData();
    fd.append("meta", JSON.stringify({ ...meta, id }));
    fd.append("blob", blob, String(meta.file_name || id));
    const res = await fetch(this.baseUrl + "/attachments", { method: "POST", credentials: "include", body: fd });
    if (res.status === 401) SessionExpiry.report(401);   // session expirée → retour au login (idempotent) ; le throw reste
    if (!res.ok) {
      // Le serveur détaille son refus (400 MIME/validation, 409 id existant…) — remonter son message
      // plutôt qu'un « HTTP 400 » muet : c'est lui qui fait autorité sur la création.
      let detail = ""; try { detail = ((await res.json()) || {}).error || ""; } catch { /* corps non-JSON */ }
      throw new Error("HTTP " + res.status + " sur POST /attachments" + (detail ? " : " + detail : ""));
    }
  }
  async getBlob(id: string): Promise<Blob | null> {
    const res = await fetch(this.blobUrl(id), { credentials: "include" });
    if (res.status === 401) SessionExpiry.report(401);
    return res.ok ? await res.blob() : null;
  }
  async listIds(): Promise<string[]> { return []; }   // inventaire des binaires = maintenance SERVEUR (cf. interface)
  async del(): Promise<void> { /* no-op : aucun unlink en ligne côté serveur (D5) */ }
  async clear(): Promise<void> { /* no-op : les binaires appartiennent au document serveur */ }
  downloadUrl(id: string): string | null { return this.blobUrl(id); }
}
