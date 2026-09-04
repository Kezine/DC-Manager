/* ============================================================================
   LABELEXPORTPLAN — ce qu'EXPORTER LES ÉTIQUETTES EN IMAGES veut dire, en PUR
   (décision Q11.13). Documentation : docs/qr-scan.md § « Étiquettes imprimables ».

   POURQUOI UN MODULE PUR : l'export en images pose trois questions qui n'ont
   rien à voir avec le DOM et tout à voir avec de l'arithmétique — comment
   NOMMER les fichiers, combien de PIXELS fait une étiquette à une résolution
   donnée, et à combien de pixels par MODULE dessiner le QR. Écrites dans
   `ui/LabelImageExport`, elles seraient invérifiables ; ici elles sont testées
   en isolation (Tests/modules/test-labels.js — le domaine des étiquettes tient
   en UN fichier de test, dont ce module est une pièce) et l'UI ne fait plus
   qu'appliquer.

   🚨 LE QR N'EST JAMAIS MIS À L'ÉCHELLE (diagnostic Q11.14). Une image
   d'étiquette obtenue en rasterisant le SVG du QR hériterait exactement du
   défaut qu'on vient de corriger : des modules de 5,76 px que le rasteur rend
   tantôt sur 5, tantôt sur 6 pixels. On dessine donc le QR DEPUIS SA MATRICE, à
   un nombre ENTIER `k` de pixels par module — d'où `qrPixels`, qui rend `k` et
   la cote en mm que ce `k` représente. La boîte du QR dans l'image vaut alors
   `k × totalModules` pixels EXACTEMENT, et ses modules sont carrés PAR
   CONSTRUCTION, sans dépendre d'aucun moteur de rendu.

   UNITÉS : les cotes d'étiquette sont en MILLIMÈTRES (comme tout le moteur
   d'impression), les sorties en PIXELS. Le pont est le dpi choisi dans l'étage
   Tirage — la même valeur qui quantifie la cote du QR à l'impression, donc la
   même géométrie des deux côtés.
   ============================================================================ */

import { LabelLayout } from "./LabelLayout";

/** Matrice servie par `GET …/qr/:collection/:id?format=matrix` (cf. src-server/QrSvg) :
    le côté en modules, la quiet zone, et une chaîne de `0`/`1` par rangée SANS elle. */
export interface LabelQrMatrix {
  size: number;
  margin: number;
  rows: string[];
}

export class LabelExportPlan {
  /** Extension des images produites. PNG et pas JPEG : un QR est du trait pur à fort
      contraste — la compression avec pertes y fabrique exactement le halo qui fait rater
      un scan, et le gain de poids sur une image en noir et blanc est nul. */
  static readonly EXT = "png";

  /** Nom de fichier d'UNE étiquette. `base` vient de `ImageExport.fileBase` (déjà assaini).
      Le numéro est cadré sur la largeur du total (`etiquette-007.png` quand il y en a 150) :
      sans cela, un dossier de 150 fichiers se trie `1, 10, 100, 11…` dans tous les
      explorateurs, et l'ordre de la planche — qui EST l'ordre de pose — est perdu. */
  static fileName(base: string, index: number, total: number): string {
    const width = String(Math.max(1, total)).length;
    return `${base}-${String(index + 1).padStart(width, "0")}.${LabelExportPlan.EXT}`;
  }

  /** Nom de fichier d'une PAGE de planche (option « la planche entière en une image »). */
  static sheetFileName(base: string, page: number, pages: number): string {
    const width = String(Math.max(1, pages)).length;
    return `${base}-planche-${String(page + 1).padStart(width, "0")}.${LabelExportPlan.EXT}`;
  }

  /** Nom de l'archive quand il y a plus d'une image (le navigateur ne sait pas déposer
      150 fichiers d'un coup, et personne ne veut 150 confirmations de téléchargement). */
  static zipName(base: string): string { return `${base}-etiquettes.zip`; }

  /** Millimètres → PIXELS DE SORTIE à une résolution donnée. Arrondi au plus proche, plancher à
      1 : une image de 0 pixel de côté n'est pas une image, c'est une erreur de canvas. */
  static pixels(mm: number, dpi: number): number {
    if (!Number.isFinite(mm) || !Number.isFinite(dpi) || mm <= 0 || dpi <= 0) return 1;
    return Math.max(1, Math.round(mm / 25.4 * dpi));
  }

  /** Résolution NOMINALE du CSS : 1 pouce = 96 pixels CSS, par définition de la spec. Ce n'est ni
      un réglage ni une supposition sur l'écran — c'est la constante qui fait qu'un `50mm` en CSS
      vaut toujours exactement 188,98 pixels CSS. */
  static readonly CSS_DPI = 96;

  /** Millimètres → PIXELS CSS.
      🚨 POURQUOI CETTE SECONDE CONVERSION EXISTE, alors que `pixels()` fait déjà mm → px : les deux
      ne parlent pas du même pixel, et les confondre casse silencieusement l'export.
      L'étiquette est du HTML dont les cotes sont en MILLIMÈTRES ; enveloppée dans un
      `<foreignObject>`, elle se met en page dans le système d'unités du SVG, où le millimètre vaut
      96/25,4 unités — pas `dpi`/25,4. Si le viewBox était dimensionné en pixels de SORTIE (591 pour
      50 mm à 300 dpi), l'étiquette n'occuperait que 189 de ces 591 unités, soit **32 % de l'image**,
      cadrée en haut à gauche. Le viewBox se pose donc en pixels CSS, et ce sont les attributs
      `width`/`height` du SVG qui portent la cote de SORTIE : le facteur `dpi/96` entre les deux est
      exactement le sur-échantillonnage voulu, appliqué par le rasteriseur sur le VECTEUR (et non
      sur une bitmap déjà rendue, qui elle serait floue). */
  static cssPixels(mm: number): number {
    if (!Number.isFinite(mm) || mm <= 0) return 1;
    return Math.max(1, mm / 25.4 * LabelExportPlan.CSS_DPI);
  }

  /** Le QR d'une image : combien de pixels par module, quelle cote en mm cela représente,
      et donc combien de pixels fait sa boîte. Délègue la quantification à
      `LabelLayout.quantizeQrMm` — MÊME règle que l'impression, une seule fois écrite :
      l'image exportée et le papier montrent donc rigoureusement le même code à la même cote.
      `totalModules` inclut la quiet zone (elle est dessinée avec le reste). */
  static qrPixels(totalModules: number, dpi: number, maxMm: number): { mm: number; pxPerModule: number; px: number } {
    const q = LabelLayout.quantizeQrMm(totalModules, dpi, maxMm);
    const pxPerModule = Math.max(1, q.pxPerModule);
    return { mm: q.mm, pxPerModule, px: pxPerModule * Math.max(1, Math.round(totalModules)) };
  }

  /** Côté TOTAL d'une matrice servie, quiet zone comprise — l'unique endroit où cette
      addition est écrite côté client (son pendant serveur est `QrSvg.totalModules`). */
  static totalModulesOf(matrix: LabelQrMatrix | null | undefined): number {
    if (!matrix || !Number.isFinite(matrix.size) || matrix.size <= 0) return 0;
    const margin = Number.isFinite(matrix.margin) ? matrix.margin : 0;
    return matrix.size + 2 * margin;
  }

  /** Enveloppe SVG à `<foreignObject>` autour d'un XHTML DÉJÀ SÉRIALISÉ — pur (chaîne → chaîne).
      Le `xhtml` est censé provenir d'un `XMLSerializer` (donc XML bien formé, namespace XHTML
      posé) : ce module ne le reparse pas, il ne fait que le CADRER dans un SVG rasterisable.

      🚨 DEUX SYSTÈMES D'UNITÉS, ET IL FAUT LES DEUX (cf. `cssPixels`) :
        · le **viewBox** est en pixels CSS — c'est là-dedans que le HTML en millimètres se met en
          page (dans un `foreignObject`, un `mm` vaut 96/25,4 unités, pas `dpi`/25,4) ;
        · les attributs **`width`/`height`** portent la cote de SORTIE en pixels — le rasteriseur
          dessine le VECTEUR directement à la résolution voulue, sans agrandir une bitmap floue.
      Extrait de `LabelImageExport.rasterize` pour être VÉRIFIABLE headless : l'équilibre des
      balises et la présence des cotes se testent ici, hors DOM. */
  static wrapForRaster(xhtml: string, vbW: number, vbH: number, outW: number, outH: number): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${+vbW.toFixed(3)} ${+vbH.toFixed(3)}">`
      + `<foreignObject width="100%" height="100%">`
      + xhtml
      + `</foreignObject></svg>`;
  }
}
