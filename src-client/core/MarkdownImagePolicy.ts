/* =============================================================================
   MarkdownImagePolicy — CLASSIFICATION d'une URL d'image de markdown rendu.

   Module PUR (aucun DOM) : un fichier `.md` arbitraire affiché dans le viewer
   peut porter des `![](…)` qui déclencheraient des requêtes SORTANTES (pixel
   espion, fuite d'IP/référent) — micromark ne bride pas les `<img>`. Cette
   classe décide, par URL, la POLITIQUE de rendu (cadrage D-B3) ; la manipulation
   du DOM (remplacer/laisser l'`<img>`) vit, elle, dans `AttachmentUi` — ici, rien
   que la décision, donc testable.

   TROIS classes :
     - `local` : `blob:` / `data:` — contenu LOCAL par construction, aucune requête
       vers un tiers → rendu d'office ;
     - `same-origin` : l'URL résolue pointe la MÊME origine que l'app → aucune fuite
       vers un tiers (la requête va au serveur qui sert déjà l'app), rendu d'office.
       Les URLs RELATIVES en font partie : on résout contre `baseUri` (=
       `document.baseURI` côté appelant) pour respecter le `<base href>` du mode
       reverse-proxy sous-dossier ;
     - `external` : tout le reste (autre origine, schéma exotique, URL inanalysable)
       → NEUTRALISÉ par défaut (remplacé par un lien cliquable), réactivable pour
       l'ouverture courante via un bouton du viewer.
   ============================================================================= */

/** Classe de provenance d'une URL d'image (cf. politique D-B3). */
export type MarkdownImageOrigin = "local" | "same-origin" | "external";

export class MarkdownImagePolicy {
  /** Classe l'URL `src` d'une image, résolue au besoin contre `baseUri` (base du document courant). */
  static classify(src: unknown, baseUri: unknown): MarkdownImageOrigin {
    const raw = String(src == null ? "" : src).trim();
    // URL vide (`![]()` → `<img src="">`) : aucune requête tierce → traitée comme locale (rien à neutraliser).
    if (raw === "") return "local";
    const lower = raw.toLowerCase();
    if (lower.startsWith("data:") || lower.startsWith("blob:")) return "local";

    // Base du document : sert à résoudre les URLs RELATIVES et à comparer l'origine. Inanalysable → pas de base.
    let base: URL | null = null;
    try { base = new URL(String(baseUri == null ? "" : baseUri)); } catch { base = null; }

    let resolved: URL;
    try { resolved = base ? new URL(raw, base) : new URL(raw); }
    catch { return "external"; }   // ni absolue, ni résoluble → prudence : neutralisée

    const proto = resolved.protocol.toLowerCase();
    if (proto === "data:" || proto === "blob:") return "local";
    // Schémas exotiques (`javascript:`, `vbscript:`…) : jamais rendus comme image → neutralisés.
    if (proto !== "http:" && proto !== "https:") return "external";
    // Même origine que l'app (origine OPAQUE « null » exclue — jamais assimilée à un same-origin de confiance).
    if (base && resolved.origin === base.origin && base.origin !== "null") return "same-origin";
    return "external";
  }
}
