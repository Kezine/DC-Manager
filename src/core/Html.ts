const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };

/** Échappement HTML (texte → contenu sûr). */
export class Html {
  static escape(s: unknown): string {
    if (s === null || s === undefined) return "";
    return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  }
}
