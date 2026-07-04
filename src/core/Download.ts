/** Téléchargement de fichiers côté navigateur : ancre temporaire + ObjectURL révoquée après coup.
    Centralise la mécanique blob → <a download> → click (auparavant dupliquée dans main.ts) ainsi que
    l'assainissement des noms de fichiers (caractères interdits sous Windows). */
export class Download {
  /** Déclenche le téléchargement d'un Blob déjà construit (export binaire : bundle d'images .nmfb…). */
  static blob(filename: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    // Révocation DIFFÉRÉE : révoquer immédiatement peut annuler le téléchargement en cours sur certains navigateurs.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  /** Déclenche le téléchargement d'un contenu texte sous `filename` (JSON, HTML…). */
  static text(filename: string, content: string, mime: string): void {
    Download.blob(filename, new Blob([content], { type: mime }));
  }
  /** Nom de fichier SÛR : remplace les caractères interdits (Windows : \ / : * ? " < > |) par « _ ». */
  static safeName(name: string): string {
    return String(name || "").replace(/[\\/:*?"<>|]+/g, "_");
  }
}
