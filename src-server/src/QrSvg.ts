/* ============================================================================
   QRSVG — ÉMISSION du SVG d'un QR à MODULES CARRÉS, depuis la matrice.

   Extrait de la route `GET …/qr/:collection/:id` (cf. api.ts) pour être TESTABLE
   en isolation (principe n°2) : aucune dépendance à Express ni au dépôt — on
   entre une matrice de modules, on sort une chaîne SVG.

   🚨 POURQUOI CE MODULE EXISTE (diagnostic Q11.14 du 2026-09-03, retour terrain
   « la taille la plus petite du QR produit un QR illisible — chaque ligne du QR
   est altérée et ne produit plus des pixels carrés ») :

   La librairie `qrcode` ne dessine PAS des carrés. Elle dessine un TRAIT
   HORIZONTAL par rangée de modules (`M4 4.5h7…`, `stroke-width` 1), d'où des
   coordonnées en DEMI-module. Avec `shape-rendering="crispEdges"` — que le
   correctif du 2026-08-25 a imposé pour empêcher l'anti-aliasing d'amincir les
   rangées jusqu'à les faire disparaître — chaque rangée est collée à la grille
   de sortie INDÉPENDAMMENT. Au gabarit S (0,39 mm par module, soit ~3,1 px sur
   une thermique 203 dpi), les rangées alternent donc 3 et 4 px de haut, les
   centres en `.5` font se chevaucher ou s'écarter deux rangées voisines, et le
   long d'une rangée les segments `h7` s'arrondissent à leur tour. Le symptôme
   décrit est la conséquence exacte de cette géométrie.

   La correction est structurelle : **un module n'est un carré qu'à un nombre
   ENTIER de pixels de sortie, et seulement si on le dessine comme un carré.**
   On émet donc NOTRE SVG — un carré unitaire par module sombre, à coordonnées
   ENTIÈRES, réunis dans un seul `<path>` — plutôt que le tracé au trait de la
   librairie. Les arêtes sont alors PARTAGÉES entre modules voisins et le
   snapping de `crispEdges` devient COHÉRENT sur les deux axes. Le second volet
   (quantifier la COTE du QR à un nombre entier de pixels par module pour une
   résolution d'impression donnée) vit côté client, dans `LabelLayout`.

   QUIET ZONE : 4 modules, INCHANGÉE (défaut de la librairie, exigence de la
   spec QR). Elle est DANS le SVG, comme avant — `core/LabelQrSvg` la détecte en
   lisant le plus petit `x` des commandes `M` du chemin SOMBRE (nos `M`
   commencent donc à 4) et ignore les chemins dont le `fill` commence par `#f`
   (notre fond blanc `#ffffff`). La détection rend 4 sans changement.

   La MÊME matrice sert le format `matrix` de la route (JSON consommé par
   l'export en images, qui rasterise le QR à k pixels par module) : `rows` est la
   source unique des deux sorties, et `svg` ne fait que la peindre.
   ============================================================================ */

/** Matrice de modules telle que la rend `QRCode.create(...).modules` : un côté
    en modules et un tableau plat de `size × size` valeurs 0/1 (1 = sombre). */
export interface QrModuleMatrix {
  size: number;
  data: ArrayLike<number>;
}

export class QrSvg {
  /** Quiet zone (modules) — exigence de la spec QR, défaut de la librairie, INCHANGÉE.
      Elle est comprise dans le viewBox : le côté total vaut `size + 2 × QUIET_ZONE`. */
  static readonly QUIET_ZONE_MODULES = 4;

  /** Matrice → RANGÉES de `0`/`1`, une chaîne par rangée, SANS la quiet zone.
      Forme PIVOT : elle est servie telle quelle par `?format=matrix` et peinte par `svg()`.
      Une matrice incohérente (côté ≤ 0, données trop courtes) rend un tableau vide plutôt
      que d'inventer des modules — l'appelant décidera (ici : une erreur 500 explicite). */
  static rows(matrix: QrModuleMatrix | null | undefined): string[] {
    const size = matrix && Number.isInteger(matrix.size) ? matrix.size : 0;
    const data = matrix ? matrix.data : null;
    if (size <= 0 || !data || data.length < size * size) return [];
    const out: string[] = [];
    for (let y = 0; y < size; y++) {
      let row = "";
      for (let x = 0; x < size; x++) row += data[y * size + x] ? "1" : "0";
      out.push(row);
    }
    return out;
  }

  /** Côté TOTAL du SVG en modules (quiet zone comprise) — la cote que
      `core/LabelQrSvg.parseViewBox` lira, et le `totalModules` de la
      quantification client (`core/LabelLayout.quantizeQrMm`). */
  static totalModules(rows: readonly string[]): number {
    return rows.length + 2 * QrSvg.QUIET_ZONE_MODULES;
  }

  /** Chemin des modules SOMBRES : un carré unitaire par module, coordonnées ENTIÈRES,
      décalées de la quiet zone. `M x y h1 v1 h-1 z` — l'espace entre x et y est REQUIS
      (c'est ce que la détection de marge de `core/LabelQrSvg` sait lire). */
  static darkPath(rows: readonly string[]): string {
    const q = QrSvg.QUIET_ZONE_MODULES;
    let d = "";
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      for (let x = 0; x < row.length; x++) {
        if (row[x] === "1") d += `M${x + q} ${y + q}h1v1h-1z`;
      }
    }
    return d;
  }

  /** SVG complet à modules CARRÉS : fond blanc plein cadre, puis UN chemin noir.
      `pxSize` (optionnel) pose `width`/`height` en pixels pour l'usage direct de la
      route ; le chemin d'impression les écrase de toute façon par une cote en mm
      (`core/LabelQrSvg.scaleToMm`). `shape-rendering="crispEdges"` est posé ici comme
      il l'était par la librairie — sans lui, l'anti-aliasing ronge les modules. */
  static svg(rows: readonly string[], pxSize?: number): string {
    const total = QrSvg.totalModules(rows);
    const dim = pxSize && pxSize > 0 ? ` width="${Math.round(pxSize)}" height="${Math.round(pxSize)}"` : "";
    return `<svg xmlns="http://www.w3.org/2000/svg"${dim} viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
      + `<path fill="#ffffff" d="M0 0h${total}v${total}H0z"/>`
      + `<path fill="#000000" d="${QrSvg.darkPath(rows)}"/>`
      + `</svg>`;
  }

  /** Charge utile du format `matrix` : ce que l'export en images consomme pour
      rasteriser le QR à k pixels par module, sans jamais mettre un SVG à l'échelle. */
  static matrixPayload(rows: readonly string[]): { size: number; margin: number; rows: string[] } {
    return { size: rows.length, margin: QrSvg.QUIET_ZONE_MODULES, rows: [...rows] };
  }
}
