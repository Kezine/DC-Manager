import { BinaryBundle } from "./BinaryBundle";
import type { AttachmentBackend } from "./AttachmentBackend";
import { IdbAttachmentBackend } from "./AttachmentBackend";

/* =============================================================================
   STOCKAGE DES BINAIRES DE PIÈCES JOINTES — façade FINE au-dessus du backend.

   Volontairement PLUS MINCE qu'`ImageStore`, et c'est un choix d'architecture
   (cadrage 2026-08-10 §5), pas une économie :
     - PAS de pile d'undo dédiée : les MÉTADONNÉES vivent dans la collection
       `attachments` du DOCUMENT (Store du modèle → undo modèle, verrou, SSE),
       et D5 garantit que le BINAIRE survit à une suppression (aucun unlink en
       ligne — seule la maintenance purge) : l'undo modèle retrouve donc un
       binaire intact, rien à rejouer ici ;
     - PAS de miroir mémoire id → objectURL : rien n'AFFICHE un binaire de pièce
       jointe (pas d'aperçu en v1, D10) — le download passe par `downloadUrl`
       (REST) ou `getBlob` (fichier), à la demande.

   Reste ici : l'accès aux blobs (backend injecté — IndexedDB en mode fichier,
   endpoints REST en mode API), la purge locale (`keepOnly`, maintenance mode
   fichier) et le fichier COMPAGNON `.nmfa` (signature « NMFA », MÊME enveloppe
   que le `.nmfb` d'images via le module COMMUN `BinaryBundle` — D7). Le
   manifeste `.nmfa` ne porte que le NÉCESSAIRE au binaire ({id, type, bytes}
   + clé d'appariement) : les métadonnées riches (nom, cible, description…)
   vivent dans le `.json` du document, une seule source de vérité.
   ============================================================================= */

/** Entrée du manifeste `.nmfa` : le strict nécessaire pour retrouver/re-typer un binaire. */
export interface AttachmentBundleEntry { id: string; type: string; blob: Blob }

export class AttachmentStore {
  /** Clé d'appariement du bundle actuellement en base (manifest.key) — persistée (patron ImageStore). */
  lastLoadedKey: string | null = null;
  private readonly backend: AttachmentBackend;

  constructor(opts: { backend?: AttachmentBackend } = {}) {
    this.backend = opts.backend || new IdbAttachmentBackend();   // défaut = IndexedDB (mode fichier)
  }

  /* ---- accès aux binaires (délégué au backend — cf. AttachmentBackend) ---- */
  /** Dépose le binaire d'une pièce. `meta` = l'enregistrement de la collection (en REST, le POST
      multipart crée AUSSI l'enregistrement — l'appelant ne doit alors PAS le recréer via le Store). */
  putBlob(id: string, blob: Blob, meta: Record<string, any>): Promise<void> { return this.backend.put(id, blob, meta); }
  getBlob(id: string): Promise<Blob | null> { return this.backend.getBlob(id); }
  /** URL de download serveur (REST) ou null (fichier — passer par getBlob). */
  downloadUrl(id: string): string | null { return this.backend.downloadUrl(id); }
  /** Ids des binaires PRÉSENTS localement (mode fichier ; vide en REST — cf. AttachmentBackend.listIds).
      Sert au compagnon (« manque-t-il des binaires ? ») et à la purge locale. */
  listLocalIds(): Promise<string[]> { return this.backend.listIds(); }
  /** Suppression DIRECTE d'un binaire local. ⚠ N'est PAS appelée à la suppression d'un enregistrement
      (D5 : l'undo doit retrouver le binaire) — réservée aux remplacements explicites. */
  delete(id: string): Promise<void> { return this.backend.del(id); }
  /** Vide tout (nouveau document / changement de document) + oublie la clé d'appariement. */
  async clearAll(): Promise<void> { await this.backend.clear(); this.setLoadedKey(null); }

  /** PURGE locale (maintenance mode fichier, D5) : ne garde QUE les binaires dont l'id est dans `ids`
      (= les ids de la collection `attachments` du document). Renvoie le nombre de binaires supprimés.
      En REST, `listIds()` est vide → no-op (la purge est le travail de la maintenance SERVEUR). */
  async keepOnly(ids: Iterable<string>): Promise<number> {
    const keep = new Set(ids || []);
    const orphans = (await this.backend.listIds()).filter((id) => !keep.has(id));
    for (const id of orphans) { try { await this.backend.del(id); } catch { /* best-effort */ } }
    return orphans.length;
  }

  /* ---- clé d'appariement document ⇄ compagnon (patron exact d'ImageStore.setLoadedKey) ---- */
  setLoadedKey(key: string | null): void {
    this.lastLoadedKey = key || null;
    try { if (this.lastLoadedKey) localStorage.setItem("dcmanager.attachmentsLoadedKey", this.lastLoadedKey); else localStorage.removeItem("dcmanager.attachmentsLoadedKey"); } catch { /* noop */ }
  }
  restoreLoadedKey(): void { try { this.lastLoadedKey = localStorage.getItem("dcmanager.attachmentsLoadedKey") || null; } catch { this.lastLoadedKey = null; } }

  /* ---- FICHIER COMPAGNON binaire .nmfa (enveloppe COMMUNE BinaryBundle, signature « NMFA ») ---- */
  /** Construit le Blob `.nmfa` à partir d'entrées id/type/blob + clé (pur ; testable). */
  static buildBundle(entries: readonly AttachmentBundleEntry[], key: string | null): Blob {
    const manifest = { v: 1, key: key || null, attachments: entries.map((e) => ({ id: e.id, type: e.type || e.blob.type || "", bytes: e.blob.size })) };
    return BinaryBundle.build("NMFA", manifest, entries.map((e) => e.blob));
  }
  /** Parse un `.nmfa` (ArrayBuffer) → { key, entries } (pur ; testable). Lève si signature invalide. */
  static parseBundle(buf: ArrayBuffer): { key: string | null; entries: AttachmentBundleEntry[] } {
    const { manifest, dataOffset } = BinaryBundle.parse(buf, "NMFA", "Fichier de pièces jointes invalide (signature NMFA)");
    let off = dataOffset; const entries: AttachmentBundleEntry[] = [];
    (manifest.attachments || []).forEach((entry: any) => {
      const n = entry.bytes || 0;
      entries.push({ id: entry.id, type: entry.type || "", blob: new Blob([buf.slice(off, off + n)], { type: entry.type || "application/octet-stream" }) });
      off += n;
    });
    return { key: manifest.key || null, entries };
  }

  /** Sérialise les binaires des pièces `records` (id + mime — les enregistrements du Store) en bundle
      `.nmfa`. Un binaire ILLISIBLE est absent du bundle (manifeste cohérent : l'entrée est omise) —
      même tolérance que le compagnon d'images. Valable AUSSI en mode REST (les blobs sont téléchargés
      par `getBlob`) : sert le compagnon (mode fichier) et un futur export explicite. */
  async serializeBundle(records: ReadonlyArray<{ id: string; mime?: string }>, key: string | null): Promise<Blob> {
    const entries: AttachmentBundleEntry[] = [];
    for (const record of records) {
      const blob = await this.getBlob(record.id).catch(() => null);
      if (blob) entries.push({ id: record.id, type: record.mime || blob.type || "", blob });
    }
    return AttachmentStore.buildBundle(entries, key);
  }
  /** Charge un `.nmfa` : REMPLACE les binaires locaux par son contenu et retient sa clé d'appariement.
      Renvoie le nombre de binaires chargés. */
  async loadBundle(source: ArrayBuffer | Blob): Promise<number> {
    const buf = (source instanceof ArrayBuffer) ? source : await source.arrayBuffer();
    const { key, entries } = AttachmentStore.parseBundle(buf);
    await this.backend.clear();
    for (const entry of entries) await this.backend.put(entry.id, entry.blob, { mime: entry.type });
    this.setLoadedKey(key);
    return entries.length;
  }
}
