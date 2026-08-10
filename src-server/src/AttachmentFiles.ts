/* ============================================================================
   FICHIERS des PIÈCES JOINTES — stockage disque HORS base (mode API).

   Les binaires des pièces jointes (collection `attachments`) ne vivent PAS dans
   la base SQLite du document (décision D4 du cadrage 2026-08-10) : better-sqlite3
   est SYNCHRONE — lire/écrire un blob de plusieurs dizaines de Mo dans la base
   gèlerait le thread Node pour TOUS les clients. Sur disque, l'upload (multer
   diskStorage) et le download (fs.createReadStream) sont STREAMÉS, asynchrones,
   et la base `.db` reste petite (VACUUM/backup/WAL inchangés).

   Arborescence : `<DOCS_DIR>/attachments/<docId>/<attachmentId>`
   — un dossier par document, l'ID OPAQUE de la pièce est le nom de fichier.

   ── Anti path-traversal PAR CONSTRUCTION (D4) ────────────────────────────────
   AUCUNE entrée utilisateur n'entre jamais dans un chemin : le nom de fichier
   D'ORIGINE (`file_name`) ne vit QUE dans les métadonnées (et dans l'en-tête
   Content-Disposition, assaini par `ContentDisposition`). Les seuls segments de
   chemin sont le docId (issu du REGISTRE, jamais d'une saisie) et l'id de pièce
   (généré, ou fourni par le client mais VALIDÉ par `isSafeId` — alphanumérique
   + `._-`, jamais de séparateur, jamais de point en tête). La validation est
   rejouée à CHAQUE composition de chemin (défense en profondeur : même un
   appelant qui oublierait sa garde 400 ne peut pas sortir du dossier).

   ── Écriture DISCIPLINÉE (D5) ────────────────────────────────────────────────
   Fichier d'abord (multer écrit un `.tmp-…` dans le dossier CIBLE, puis
   `promote` = rename ATOMIQUE — même volume, donc pas de copie), enregistrement
   de collection ensuite. Un crash entre les deux laisse au pire un fichier
   ORPHELIN, rattrapé par `purgeOrphans` (maintenance) — jamais un enregistrement
   sans binaire. AUCUN unlink en ligne à la suppression d'un enregistrement :
   la purge des binaires est le travail EXCLUSIF de la maintenance (l'undo d'une
   suppression retrouve ainsi un binaire intact). Cf. docs/attachments.md.

   La logique PURE (validation d'id, noms temporaires) est en statique — testable
   sans I/O ; les méthodes d'instance portent les I/O (Tests/modules/
   test-attachments.js les couvre sur un dossier temporaire réel).
   ============================================================================ */
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

export class AttachmentFiles {
  /** Préfixe des fichiers TEMPORAIRES d'upload (multer écrit sous ce nom, `promote` renomme).
      Commence par un point → jamais confondu avec un id de pièce (isSafeId l'interdit en tête),
      et balayé par la maintenance s'il survit à un crash. */
  private static readonly TEMP_PREFIX = ".tmp-";

  /** Racine des dossiers de pièces jointes : `<DOCS_DIR>/attachments/`. */
  private readonly root: string;

  constructor(docsDir: string) {
    this.root = path.join(docsDir, "attachments");
  }

  /* ---- logique PURE (aucune I/O) ---- */

  /** Un id est-il SÛR comme nom de fichier ? Alphanumériques + `._-`, 1 à 128 caractères, et JAMAIS de
      point en tête (réserve les noms cachés/temporaires, et exclut `.`/`..` par construction). Le jeu de
      caractères EXCLUT tout séparateur de chemin (`/`, `\`) et tout caractère de contrôle : un id validé
      ne peut composer qu'un nom de fichier SIMPLE, jamais une traversée. */
  static isSafeId(id: unknown): boolean {
    return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
  }

  /** Nom de fichier TEMPORAIRE frais (upload en cours). Le contenu est aléatoire (UUID) : deux uploads
      concurrents dans le même dossier ne se marchent jamais dessus. */
  static tempName(): string {
    return AttachmentFiles.TEMP_PREFIX + randomUUID();
  }

  /** Cette entrée de dossier est-elle un TEMPORAIRE (upload interrompu) ? — critère de la purge. */
  static isTempName(name: string): boolean {
    return name.startsWith(AttachmentFiles.TEMP_PREFIX);
  }

  /* ---- composition de chemins (pure, mais VALIDANTE — lève sur id malformé) ---- */

  /** Dossier des pièces d'UN document. Le docId vient du REGISTRE (jamais d'une saisie libre), mais la
      garde est rejouée quand même : défense en profondeur, un chemin ne se compose qu'avec des ids sûrs. */
  dirFor(docId: string): string {
    if (!AttachmentFiles.isSafeId(docId)) throw new Error("identifiant de document invalide : " + String(docId));
    return path.join(this.root, docId);
  }

  /** Chemin du binaire d'UNE pièce. Les DEUX segments sont validés (cf. en-tête, anti-traversal). */
  pathFor(docId: string, attachmentId: string): string {
    if (!AttachmentFiles.isSafeId(attachmentId)) throw new Error("identifiant de pièce jointe invalide : " + String(attachmentId));
    return path.join(this.dirFor(docId), attachmentId);
  }

  /* ---- I/O ---- */

  /** Crée (si besoin) et renvoie le dossier du document — destination du diskStorage multer. */
  ensureDir(docId: string): string {
    const dir = this.dirFor(docId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** PROMEUT un fichier temporaire (écrit par multer dans le dossier du document) vers son nom définitif
      (= l'id de la pièce). `rename` sur le MÊME volume → atomique : le fichier définitif est complet ou
      absent, jamais tronqué. */
  promote(tempPath: string, docId: string, attachmentId: string): void {
    fs.renameSync(tempPath, this.pathFor(docId, attachmentId));
  }

  /** Taille du binaire (octets), ou null s'il n'existe pas — le 404 du download passe par ici. */
  statOf(docId: string, attachmentId: string): { size: number } | null {
    try { const s = fs.statSync(this.pathFor(docId, attachmentId)); return s.isFile() ? { size: s.size } : null; }
    catch { return null; }
  }

  /** Flux de LECTURE du binaire (download STREAMÉ — jamais le fichier entier en mémoire). */
  readStream(docId: string, attachmentId: string): fs.ReadStream {
    return fs.createReadStream(this.pathFor(docId, attachmentId));
  }

  /** Supprime UN binaire, best-effort (rattrapage d'un échec d'insertion APRÈS promote — le seul unlink
      « en ligne » légitime : l'enregistrement n'a jamais existé, D5 ne protège rien ici). */
  remove(docId: string, attachmentId: string): void {
    try { fs.unlinkSync(this.pathFor(docId, attachmentId)); } catch { /* déjà absent — rien à faire */ }
  }

  /** Ids des binaires PRÉSENTS sur disque (les temporaires d'upload sont exclus). */
  listIds(docId: string): string[] {
    try { return fs.readdirSync(this.dirFor(docId)).filter((name) => !AttachmentFiles.isTempName(name)); }
    catch { return []; }   // dossier absent = document sans pièce jointe
  }

  /** PURGE des binaires ORPHELINS d'un document (maintenance, D5) : supprime tout fichier dont le nom
      n'est PAS dans `referencedIds` (= les ids de la COLLECTION `attachments`), plus les temporaires
      d'upload abandonnés. Renvoie le compte et les octets récupérés (rapport de maintenance). */
  purgeOrphans(docId: string, referencedIds: ReadonlySet<string>): { purged: number; bytes: number } {
    let purged = 0, bytes = 0;
    for (const name of this.rawEntries(docId)) {
      if (!AttachmentFiles.isTempName(name) && referencedIds.has(name)) continue;
      const file = path.join(this.dirFor(docId), name);
      try { bytes += fs.statSync(file).size; fs.unlinkSync(file); purged++; }
      catch { /* fichier disparu entre-temps — rien à compter */ }
    }
    return { purged, bytes };
  }

  /** Supprime le dossier COMPLET d'un document (suppression du document — le binaire suit ses données). */
  removeDocumentDir(docId: string): void {
    fs.rmSync(this.dirFor(docId), { recursive: true, force: true });
  }

  /** Entrées BRUTES du dossier (temporaires compris) — la purge décide elle-même de leur sort. */
  private rawEntries(docId: string): string[] {
    try { return fs.readdirSync(this.dirFor(docId)); }
    catch { return []; }
  }
}
