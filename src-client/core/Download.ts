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
  /** Déclenche le téléchargement d'un contenu TEXTE ou BINAIRE indifféremment — point
      d'entrée pour un artefact `{ content: string | Uint8Array }` (ex. exports PKI :
      PEM texte, PKCS#12 binaire) sans que l'appelant ait à distinguer les deux cas. */
  static data(filename: string, content: string | Uint8Array, mime: string): void {
    if (typeof content === "string") Download.text(filename, content, mime);
    else Download.blob(filename, new Blob([content as BlobPart], { type: mime }));
  }
  /** Nom de fichier SÛR : remplace les caractères interdits (Windows : \ / : * ? " < > |) par « _ ». */
  static safeName(name: string): string {
    return String(name || "").replace(/[\\/:*?"<>|]+/g, "_");
  }
}
