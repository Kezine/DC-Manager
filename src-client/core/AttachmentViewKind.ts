/* =============================================================================
   AttachmentViewKind — CHOIX DU RENDU d'une pièce jointe dans le viewer intégré.

   Module PUR (aucun DOM, aucun réseau) : à partir du couple (mime, file_name)
   d'un enregistrement `attachments`, décide COMMENT l'afficher — image, texte,
   markdown, PDF — ou `null` quand la pièce n'est pas VISUALISABLE (ODT/DOCX/
   XLSX/ODS…, qui restent en téléchargement seul). Le viewer (`AttachmentUi.view`)
   et le listing (bouton « Afficher » conditionnel) consomment le MÊME verdict,
   d'où l'extraction ici : une seule règle, testable en isolation.

   PRIORITÉ (cadrage D-B2) : le MIME d'abord, l'EXTENSION du `file_name` en repli.
   Le repli n'est pas cosmétique — `File.type` est instable pour le markdown (un
   `.md` arrive souvent en `text/plain`, parfois vide). Deux cas concrets à ne pas
   confondre : un `.md` historique stocké en `text/plain` DOIT rendre en markdown
   (l'extension raffine la distinction texte ⇄ markdown au sein de la famille
   `text/*`) ; un `.csv` reste du TEXTE (rendu brut, pas de rendu tabulaire v1).
   ============================================================================= */

/** Nature de rendu retenue pour une pièce jointe (`null` = non visualisable → pas de bouton « Afficher »). */
export type AttachmentViewKindValue = "image" | "text" | "markdown" | "pdf";

export class AttachmentViewKind {
  /** MIME normalisé : minuscules, paramètres (`; charset=…`) retirés, espaces coupés. */
  private static normMime(mime: unknown): string {
    return String(mime == null ? "" : mime).toLowerCase().split(";")[0].trim();
  }

  /** Extension du nom de fichier, en minuscules et AVEC le point (« notes.MD » → « .md ») ; « » si aucune. */
  private static ext(fileName: unknown): string {
    const name = String(fileName == null ? "" : fileName);
    const dot = name.lastIndexOf(".");
    if (dot < 0 || dot === name.length - 1) return "";
    return name.slice(dot).toLowerCase();
  }

  /** Nature de rendu du couple (mime, file_name), ou `null` si la pièce n'est pas visualisable en v1. */
  static kindOf(mime: unknown, fileName: unknown): AttachmentViewKindValue | null {
    const m = AttachmentViewKind.normMime(mime);
    const ext = AttachmentViewKind.ext(fileName);

    // 1) MIME reconnu : il fait AUTORITÉ (le repli extension ne sert qu'aux MIME vides/non classants).
    if (m === "application/pdf") return "pdf";
    if (m === "image/png" || m === "image/jpeg" || m === "image/webp") return "image";
    if (m === "text/markdown") return "markdown";
    if (m === "text/plain" || m === "text/csv") {
      // Famille text/* : l'EXTENSION tranche markdown ⇄ texte (un .md en text/plain rend en markdown).
      return (ext === ".md" || ext === ".markdown") ? "markdown" : "text";
    }

    // 2) MIME ABSENT (vide) : repli par extension. Un MIME PRÉSENT mais non classant (office : ODT/DOCX/
    //    XLSX/ODS) tombe volontairement à `null` — ces types ne se visualisent pas, ils se téléchargent.
    if (m === "") {
      if (ext === ".pdf") return "pdf";
      if (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp") return "image";
      if (ext === ".md" || ext === ".markdown") return "markdown";
      if (ext === ".txt" || ext === ".csv") return "text";
    }

    return null;   // ODT/ODS/DOCX/XLSX et tout inconnu → non visualisable
  }
}
