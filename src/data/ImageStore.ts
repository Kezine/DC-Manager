import { Id } from "../core/Id";
import { ImageBackend, IdbImageBackend } from "./ImageBackend";

/* =============================================================================
   STOCKAGE DES IMAGES DE FAÇADE — DISSOCIÉ DU MODÈLE (réplique OO du `imageStore`).
   - IndexedDB (base `dc-manager-images`, store « images ») = stockage VIVANT, Blob binaire
     (hors undo modèle, hors cache de session).
   - Miroir mémoire SYNCHRONE (id → métadonnées + objectURL) pour la lecture par l'UI.
   - Pile d'undo/redo DISTINCTE (opérations inverses ; `onUndoable` alimente la timeline unifiée).
   - Fichier compagnon binaire `.nmfb` (entête « NMFB » + manifeste JSON + blobs concaténés).
   Le modèle ne conserve que des RÉFÉRENCES (equipment.face_image_*_id).
   ============================================================================= */

const HISTORY_MAX = 50;

/** Enregistrement brut : métadonnées + Blob binaire. `url`/`bytes` (optionnels) servent au mode REST,
    où le blob n'est pas chargé en mémoire (le miroir pointe l'URL serveur, `bytes` vient du manifeste). */
export interface ImageRec { id: string; name: string; u_height: number; face: string; description: string; type: string; blob: Blob | null; url?: string; bytes?: number; }
/** Vue miroir (UI) : métadonnées + objectURL synchrone. */
export interface ImageMirror { id: string; name: string; u_height: number; face: string; description: string; type: string; url: string | null; bytes: number; }
/** Image legacy inline (data URL) — import/export de repli. */
export interface LegacyImage { id: string; name: string; u_height: number; face: string; description: string; data: string; }

interface UndoEntry { undo: () => Promise<void>; redo: () => Promise<void>; }

export class ImageStore {
  private mirror = new Map<string, ImageMirror>();
  private _undo: UndoEntry[] = [];
  private _redo: UndoEntry[] = [];
  private _ready = false;
  /** Clé d'appariement du bundle actuellement en base (manifest.key) — persistée par le bootstrap. */
  lastLoadedKey: string | null = null;
  private backend: ImageBackend;

  constructor(private opts: { onDirty?: () => void; onUndoable?: (kind: string) => void; backend?: ImageBackend } = {}) {
    this.backend = opts.backend || new IdbImageBackend();   // défaut = IndexedDB (mode fichier)
  }

  /* ---- helpers data-url (migration legacy + export de repli) ---- */
  static dataUrlToBlob(dataUrl: string): Blob | null {
    const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl || "");
    if (!m) return null;
    const mime = m[1] || "application/octet-stream";
    if (m[2]) { const bin = atob(m[3]); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new Blob([u8], { type: mime }); }
    return new Blob([decodeURIComponent(m[3])], { type: mime });
  }
  static blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  }

  /** Face valide : front (défaut) · rear · autre (faces annexes des équipements libres). */
  private static face(f: any): string { return (f === "rear" || f === "autre") ? f : "front"; }
  private norm(rec: any): ImageRec {
    return { id: rec.id, name: rec.name || "", u_height: Math.max(1, rec.u_height | 0 || 1), face: ImageStore.face(rec.face), description: rec.description || "", type: rec.type || (rec.blob && rec.blob.type) || "", blob: rec.blob || null };
  }
  private mirrorPut(rec: ImageRec): void {
    const old = this.mirror.get(rec.id); if (old && old.url && old.url.startsWith("blob:")) URL.revokeObjectURL(old.url);
    // blob en mémoire → objectURL (fichier / image fraîchement ajoutée) ; sinon URL serveur (REST).
    const url = rec.blob ? URL.createObjectURL(rec.blob) : (rec.url || null);
    this.mirror.set(rec.id, { id: rec.id, name: rec.name || "", u_height: rec.u_height || 1, face: ImageStore.face(rec.face), description: rec.description || "", type: rec.type || "", url, bytes: rec.blob ? rec.blob.size : (rec.bytes || 0) });
  }
  private mirrorDel(id: string): void { const old = this.mirror.get(id); if (old && old.url && old.url.startsWith("blob:")) URL.revokeObjectURL(old.url); this.mirror.delete(id); }

  /* ---- persistance déléguée au BACKEND (IndexedDB en fichier · endpoints blob en REST) ---- */
  private put(rec: ImageRec): Promise<void> { return this.backend.put(rec); }
  private del(id: string): Promise<void> { return this.backend.del(id); }
  private getRaw(id: string): Promise<ImageRec | null> { return this.backend.getRaw(id); }
  private getAll(): Promise<ImageRec[]> { return this.backend.getAll(); }
  private clear(): Promise<void> { return this.backend.clear(); }

  /** Peuple le miroir depuis le backend (boot / session restaurée). Idempotent. */
  async ready(): Promise<void> { if (this._ready) return; this._ready = true; try { (await this.getAll()).forEach((r) => this.mirrorPut(r)); } catch (e) { console.warn("ImageStore.ready", e); } }

  /** Recharge entièrement le miroir depuis le backend courant (ex. changement de document en mode REST). */
  async reloadFromBackend(): Promise<void> {
    this.mirror.forEach((v) => { if (v.url && v.url.startsWith("blob:")) URL.revokeObjectURL(v.url); });
    this.mirror.clear(); this._undo = []; this._redo = []; this._ready = true;
    try { (await this.getAll()).forEach((r) => this.mirrorPut(r)); } catch (e) { console.warn("ImageStore.reloadFromBackend", e); }
  }

  /* ---- LECTURE (synchrone, via miroir) ---- */
  list(): ImageMirror[] { return Array.from(this.mirror.values()).sort((a, b) => (a.name || "").localeCompare(b.name || "")); }
  get(id: string | null): ImageMirror | null { return id ? (this.mirror.get(id) || null) : null; }
  has(id: string | null): boolean { return !!id && this.mirror.has(id); }
  count(): number { return this.mirror.size; }

  /* ---- ÉCRITURE (async ; pile d'undo DISTINCTE) ---- */
  async add(props: Partial<ImageRec>): Promise<ImageMirror | null> {
    const rec = this.norm(Object.assign({ id: Id.uid() }, props)); if (!rec.blob) return null;
    await this.put(rec); this.mirrorPut(rec);
    this.pushUndo({ undo: () => this.applyDel(rec.id), redo: () => this.applyPut(rec) }); this.markDirty();
    return this.get(rec.id);
  }
  async update(id: string, patch: Partial<ImageRec>): Promise<ImageMirror | null> {
    const cur = await this.getRaw(id); if (!cur) return null;
    const before = Object.assign({}, cur), next = this.norm(Object.assign({}, cur, patch, { id }));
    await this.put(next); this.mirrorPut(next);
    this.pushUndo({ undo: () => this.applyPut(before), redo: () => this.applyPut(next) }); this.markDirty();
    return this.get(id);
  }
  async remove(id: string): Promise<boolean> {
    const cur = await this.getRaw(id); if (!cur) return false;
    await this.del(id); this.mirrorDel(id);
    this.pushUndo({ undo: () => this.applyPut(cur), redo: () => this.applyDel(id) }); this.markDirty();
    return true;
  }
  private async applyPut(rec: ImageRec): Promise<void> { await this.put(rec); this.mirrorPut(rec); }
  private async applyDel(id: string): Promise<void> { await this.del(id); this.mirrorDel(id); }

  /* ---- pile d'undo DISTINCTE ---- */
  private pushUndo(e: UndoEntry): void { this._undo.push(e); if (this._undo.length > HISTORY_MAX) this._undo.shift(); this._redo = []; try { this.opts.onUndoable?.("image"); } catch (_) { /* noop */ } }
  canUndo(): boolean { return this._undo.length > 0; }
  canRedo(): boolean { return this._redo.length > 0; }
  async undo(): Promise<boolean> { const e = this._undo.pop(); if (!e) return false; await e.undo(); this._redo.push(e); this.markDirty(); return true; }
  async redo(): Promise<boolean> { const e = this._redo.pop(); if (!e) return false; await e.redo(); this._undo.push(e); this.markDirty(); return true; }

  private markDirty(): void { try { this.opts.onDirty?.(); } catch (_) { /* noop */ } }

  /* ---- remplacement complet (ouverture de document) ---- */
  async replaceAll(recs: Partial<ImageRec>[]): Promise<void> {
    await this.clear();
    this.mirror.forEach((v) => { if (v.url) URL.revokeObjectURL(v.url); }); this.mirror.clear();
    for (const r of (recs || [])) { const rec = this.norm(r); if (rec.blob) { await this.put(rec); this.mirrorPut(rec); } }
    this._undo = []; this._redo = [];
  }
  async clearAll(): Promise<void> { await this.replaceAll([]); this.setLoadedKey(null); }
  /** N'élague QUE les images hors `ids` (réouverture en conservant celles déjà présentes). */
  async keepOnly(ids: Iterable<string>): Promise<number> {
    const keep = new Set(ids || []); const del = [...this.mirror.keys()].filter((id) => !keep.has(id));
    for (const id of del) { try { await this.del(id); } catch (_) { /* noop */ } this.mirrorDel(id); }
    return this.mirror.size;
  }

  /* ---- legacy (faceImages inline data-URL d'un .json ≤ v51) ---- */
  async replaceAllFromLegacy(arr: LegacyImage[]): Promise<number> {
    const recs: Partial<ImageRec>[] = [];
    (arr || []).forEach((fi) => { const blob = fi.data ? ImageStore.dataUrlToBlob(fi.data) : null; if (blob) recs.push({ id: fi.id, name: fi.name || "", u_height: fi.u_height || 1, face: fi.face, description: fi.description || "", type: blob.type, blob }); });
    await this.replaceAll(recs); return recs.length;
  }
  /** VISUALISEUR : peuple SEULEMENT le miroir (objectURL) depuis des images legacy, sans IndexedDB. */
  loadMirrorFromLegacy(arr: LegacyImage[]): number {
    this.mirror.forEach((v) => { if (v.url) URL.revokeObjectURL(v.url); }); this.mirror.clear();
    let n = 0;
    (arr || []).forEach((fi) => { const blob = fi.data ? ImageStore.dataUrlToBlob(fi.data) : null; if (blob) { this.mirrorPut(this.norm({ id: fi.id, name: fi.name, u_height: fi.u_height, face: fi.face, blob })); n++; } });
    return n;
  }
  /** Sauvegarde de repli (download) : images inline en data URL. */
  async toLegacyArray(): Promise<LegacyImage[]> {
    const all = await this.getAll(), out: LegacyImage[] = [];
    for (const r of all) out.push({ id: r.id, name: r.name || "", u_height: r.u_height || 1, face: ImageStore.face(r.face), description: r.description || "", data: r.blob ? await ImageStore.blobToDataUrl(r.blob) : "" });
    return out;
  }

  /* ---- FICHIER COMPAGNON binaire .nmfb (entête NMFB + manifeste JSON + blobs concaténés) ---- */
  setLoadedKey(k: string | null): void {
    this.lastLoadedKey = k || null;
    try { if (this.lastLoadedKey) localStorage.setItem("dcmanager.facesLoadedKey", this.lastLoadedKey); else localStorage.removeItem("dcmanager.facesLoadedKey"); } catch (_) { /* noop */ }
  }
  restoreLoadedKey(): void { try { this.lastLoadedKey = localStorage.getItem("dcmanager.facesLoadedKey") || null; } catch (_) { this.lastLoadedKey = null; } }
  /** Construit le Blob `.nmfb` à partir d'enregistrements + clé (pur ; testable). */
  static buildBundle(recs: ImageRec[], key: string | null): Blob {
    const manifest = { v: 1, key: key || null, images: recs.map((r) => ({ id: r.id, name: r.name || "", u_height: r.u_height || 1, face: ImageStore.face(r.face), description: r.description || "", type: r.type || (r.blob && r.blob.type) || "", bytes: r.blob ? r.blob.size : 0 })) };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const head = new Uint8Array(9); head.set([0x4E, 0x4D, 0x46, 0x42], 0); head[4] = 1;
    new DataView(head.buffer).setUint32(5, manifestBytes.length, true);
    const parts: BlobPart[] = [head, manifestBytes]; recs.forEach((r) => { if (r.blob) parts.push(r.blob); });
    return new Blob(parts, { type: "application/octet-stream" });
  }
  /** Parse un `.nmfb` (ArrayBuffer) → { key, recs } (pur ; testable). Lève si signature invalide. */
  static parseBundle(buf: ArrayBuffer): { key: string | null; recs: ImageRec[] } {
    const dv = new DataView(buf);
    if (buf.byteLength < 9 || dv.getUint8(0) !== 0x4E || dv.getUint8(1) !== 0x4D || dv.getUint8(2) !== 0x46 || dv.getUint8(3) !== 0x42) throw new Error("Fichier de faces invalide (signature NMFB)");
    const mlen = dv.getUint32(5, true);
    const manifest = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 9, mlen)));
    let off = 9 + mlen; const recs: ImageRec[] = [];
    (manifest.images || []).forEach((im: any) => { const n = im.bytes || 0; const blob = new Blob([buf.slice(off, off + n)], { type: im.type || "application/octet-stream" }); off += n; recs.push({ id: im.id, name: im.name || "", u_height: im.u_height || 1, face: im.face, description: im.description || "", type: im.type || "", blob }); });
    return { key: manifest.key || null, recs };
  }
  /** Récupère TOUS les enregistrements avec leur blob HYDRATÉ. En mode REST, `getAll()` ne ramène que les
      métadonnées (blob null, `url` = endpoint serveur) → on télécharge ici les binaires manquants pour pouvoir
      les sérialiser. En mode fichier, les blobs sont déjà présents (IndexedDB) → aucun téléchargement. */
  private async getAllWithBlobs(): Promise<ImageRec[]> {
    const recs = await this.getAll();
    for (const r of recs) {
      if (!r.blob && r.url) {
        try { const res = await fetch(r.url, { credentials: "include" }); if (res.ok) { r.blob = await res.blob(); if (!r.type) r.type = r.blob.type; } }
        catch (_) { /* binaire illisible → l'image sera absente du bundle (manifeste cohérent : bytes = 0) */ }
      }
    }
    return recs;
  }
  /** Sérialise la bibliothèque en bundle `.nmfb` (blobs hydratés, donc valable AUSSI en mode REST). Sert le
      compagnon (mode fichier) ET l'export EXPLICITE de la bibliothèque (portage manuel, tous modes). */
  async serializeBundle(key: string | null): Promise<Blob> { return ImageStore.buildBundle(await this.getAllWithBlobs(), key); }
  async loadBundle(source: ArrayBuffer | Blob): Promise<number> {
    const buf = (source instanceof ArrayBuffer) ? source : await source.arrayBuffer();
    const { key, recs } = ImageStore.parseBundle(buf);
    this.setLoadedKey(key);
    await this.replaceAll(recs);
    return recs.length;
  }
  /** IMPORT EXPLICITE (portage manuel, tous modes) : REMPLACE toute la bibliothèque par le contenu du bundle, en
      CONSERVANT les ids des images. Découplé du compagnon : ne touche PAS la clé d'appariement (lastLoadedKey) du
      document courant. Conséquence assumée : les références d'équipement (face_image_*_id) vers des images ABSENTES
      du bundle deviennent orphelines → l'appelant doit avertir que les faces concernées sont à RÉ-ASSIGNER.
      Marque l'état « modifié » (en mode fichier, le compagnon sera réécrit à la prochaine sauvegarde). */
  async importBundle(source: ArrayBuffer | Blob): Promise<number> {
    const buf = (source instanceof ArrayBuffer) ? source : await source.arrayBuffer();
    const { recs } = ImageStore.parseBundle(buf);   // lève si signature NMFB invalide
    await this.replaceAll(recs);
    this.markDirty();
    return recs.length;
  }
}
