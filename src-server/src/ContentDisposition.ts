/* ============================================================================
   CONTENT-DISPOSITION — composition PURE de l'en-tête de téléchargement.

   Le download d'une pièce jointe est servi `Content-Disposition: attachment`
   TOUJOURS (décision D6 du cadrage 2026-08-10) : jamais inline — un document
   affiché par l'origine de l'app serait un vecteur de XSS stocké (le `nosniff`
   global reste, défense en profondeur). Le nom proposé au navigateur est le
   `file_name` D'ORIGINE de la pièce — une donnée UTILISATEUR, donc à ASSAINIR :
   un CR/LF injecterait un en-tête HTTP, un guillemet casserait la quoted-string,
   et les non-ASCII ne survivent pas au paramètre `filename` historique.

   Forme émise (RFC 6266) — les DEUX paramètres, pour couvrir tous les agents :
     attachment; filename="<repli ASCII>"; filename*=UTF-8''<percent-encodé>
   - `filename` : repli ASCII pur (vieux agents) — non-ASCII remplacés par `_`,
     guillemets/antislash neutralisés ;
   - `filename*` (RFC 5987) : le nom COMPLET, UTF-8 percent-encodé — les agents
     modernes le préfèrent et restaurent les accents.

   Classe PURE (aucune I/O, aucun Express) — testée dans
   Tests/modules/test-attachments.js (guillemets, CRLF, non-ASCII).
   ============================================================================ */

export class ContentDisposition {
  /** Valeur COMPLÈTE de l'en-tête pour un téléchargement forcé du fichier `fileName`. */
  static attachment(fileName: string): string {
    const clean = ContentDisposition.stripControls(fileName);
    return 'attachment; filename="' + ContentDisposition.asciiFallback(clean) + "\"; filename*=UTF-8''" + ContentDisposition.rfc5987Encode(clean);
  }

  /** Retire CR/LF et TOUT caractère de contrôle (C0 + DEL) — la SEULE classe qui permettrait une
      injection d'en-tête HTTP — puis trime ; vide → « fichier » (un download sans nom est illisible).
      Plage écrite en SÉQUENCES D'ÉCHAPPEMENT (`\u0000`–`\u001f`, `\u007f`) : un caractère de contrôle
      tapé en clair dans un littéral serait invisible à la relecture (même piège que `Cascade.KEY_SEP`). */
  static stripControls(name: string): string {
    const clean = String(name == null ? "" : name).replace(/[\u0000-\u001f\u007f]/g, "").trim();
    return clean || "fichier";
  }

  /** Repli ASCII du paramètre `filename` (quoted-string) : non-ASCII → `_` ; `"` → `'` et `\` → `_`
      (plutôt que l'échappement quoted-pair, que des agents réels lisent mal — le nom FIDÈLE est de
      toute façon porté par `filename*`). La classe `[^ -~]` = tout ce qui SORT de l'ASCII
      imprimable (espace à tilde), contrôles déjà retirés par `stripControls`. */
  static asciiFallback(name: string): string {
    return ContentDisposition.stripControls(name)
      .replace(/"/g, "'")
      .replace(/\\/g, "_")
      .replace(/[^ -~]/g, "_");
  }

  /** Percent-encodage RFC 5987 (paramètre `filename*`) : UTF-8 via encodeURIComponent, PLUS les quatre
      caractères qu'encodeURIComponent laisse passer mais que la grammaire `attr-char` EXCLUT
      (`*`, `'`, `(`, `)`). Sans ce complément, un nom contenant `'` ou `*` produirait un paramètre
      étendu malformé que certains agents rejettent en bloc. */
  static rfc5987Encode(name: string): string {
    return encodeURIComponent(ContentDisposition.stripControls(name))
      .replace(/[*'()]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
  }
}
