/* =============================================================================
   ImageStitch — géométrie PURE de l'ASSEMBLAGE de deux photos de façade
   REDRESSÉES (cf. `docs/redressement-perspective.md`, modèle « redresser puis
   aligner »). Une façade est PLANE : deux photos redressées par homographie ne
   diffèrent que d'une translation + échelle → l'assemblage se réduit à un
   placement (dx,dy,échelle) puis une jonction : COUPE FRANCHE (1re photo
   prioritaire, défaut) ou FONDU linéaire dans le recouvrement (toggle).

   Conventions : `A` est l'image de RÉFÉRENCE posée à l'origine ; `B` est posée
   à (dx,dy) dans le repère de A (entiers ; dx/dy peuvent être négatifs). L'axe
   d'assemblage `axis` vaut "h" (côte à côte) ou "v" (empilées) — le fondu
   progresse le long de cet axe, le recadrage auto coupe l'autre axe à
   l'INTERSECTION des deux images (bandes d'alpha 0 dues au désalignement fin).

   AUCUN accès DOM (tableaux bruts `RawImage`) → testable en Node
   (Tests/modules/test-geometry.js). L'écran interactif vit dans `ui/StitchEditor`.
   ============================================================================= */
import type { RawImage } from "./Homography";

export type StitchAxis = "h" | "v";

export class ImageStitch {
  /** Rééchantillonnage BILINÉAIRE (RGBA, alpha compris) vers outW×outH — sert à normaliser la
      dimension partagée de B (hauteur en "h", largeur en "v") + le réglage fin d'échelle. */
  static resizeBilinear(src: RawImage, outW: number, outH: number): RawImage {
    const sd = src.data, sw = src.width, sh = src.height;
    const o = new Uint8ClampedArray(outW * outH * 4);
    for (let y = 0; y < outH; y++) {
      // centre du pixel de sortie → coordonnée source (clampée au bord : pas de débordement d'index).
      // Les VOISINS (x1,y1) sont eux aussi clampés — sinon une dimension source de 1 px lirait hors
      // bornes (undefined × poids 0 = NaN → pixel noirci par le clamp du tableau).
      const sy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / outH - 0.5));
      const y0 = Math.max(0, Math.min(sh - 1, sy | 0)), y1 = Math.min(sh - 1, y0 + 1), fy = sy - y0;
      for (let x = 0; x < outW; x++) {
        const sx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / outW - 0.5));
        const x0 = Math.max(0, Math.min(sw - 1, sx | 0)), x1 = Math.min(sw - 1, x0 + 1), fx = sx - x0;
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        const oi = (y * outW + x) * 4;
        for (let c = 0; c < 4; c++) o[oi + c] = sd[i00 + c] * w00 + sd[i10 + c] * w10 + sd[i01 + c] * w01 + sd[i11 + c] * w11;
      }
    }
    return { data: o, width: outW, height: outH };
  }

  /** GAIN de luminance à appliquer aux RGB de B pour égaler A dans le RECOUVREMENT (compense
      l'auto-exposition qui varie entre les deux clichés → couture visible sinon). Moyennes
      calculées sur les pixels où les DEUX alphas sont opaques ; borné [0,5 ; 2] ; 1 si pas de
      recouvrement exploitable. */
  static gainForB(A: RawImage, B: RawImage, dx: number, dy: number): number {
    const x0 = Math.max(0, dx), x1 = Math.min(A.width, dx + B.width);
    const y0 = Math.max(0, dy), y1 = Math.min(A.height, dy + B.height);
    if (x1 - x0 < 2 || y1 - y0 < 2) return 1;
    // sous-échantillonnage : ≤ ~20 000 échantillons (le gain est une moyenne, inutile de tout lire)
    const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 20000)));
    const lum = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let sumA = 0, sumB = 0, n = 0;
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      const ia = (y * A.width + x) * 4, ib = ((y - dy) * B.width + (x - dx)) * 4;
      if (A.data[ia + 3] === 0 || B.data[ib + 3] === 0) continue;
      sumA += lum(A.data, ia); sumB += lum(B.data, ib); n++;
    }
    if (!n || sumB <= 0) return 1;
    return Math.max(0.5, Math.min(2, sumA / sumB));
  }

  /** COMPOSITE A ∪ B le long de `axis`. Deux modes de JONCTION (`seam`) :
      - "cut" (défaut) : COUPE FRANCHE — A (1re photo) PRIORITAIRE partout où elle est opaque ;
        B n'apparaît qu'au-delà (croppée à la jonction). Aucun mélange de pixels.
      - "feather" : FONDU LINÉAIRE dans le recouvrement (poids de B : 0 côté A → 1 côté B).
      Les RGB de B sont multipliés par `gainB` (compensation d'exposition — cruciale en coupe
      franche, l'écart se voit net à la jonction). Zones mono-image → recopie ; aucune → transparent.
      Renvoie l'image UNION + l'offset (ox,oy) de son origine dans le repère de A (pour recadrer). */
  static blend(A: RawImage, B: RawImage, dx: number, dy: number, axis: StitchAxis, gainB = 1, seam: "cut" | "feather" = "cut"): { img: RawImage; ox: number; oy: number } {
    const ox = Math.min(0, dx), oy = Math.min(0, dy);
    const W = Math.max(A.width, dx + B.width) - ox, H = Math.max(A.height, dy + B.height) - oy;
    // intervalle de recouvrement le long de l'axe (repère de A) — le fondu progresse dessus
    const oS = axis === "h" ? Math.max(0, dx) : Math.max(0, dy);
    const oE = axis === "h" ? Math.min(A.width, dx + B.width) : Math.min(A.height, dy + B.height);
    const span = Math.max(1, oE - oS);
    const o = new Uint8ClampedArray(W * H * 4);
    for (let cy = 0; cy < H; cy++) {
      const y = cy + oy;   // repère de A
      for (let cx = 0; cx < W; cx++) {
        const x = cx + ox;
        const ia = (x >= 0 && y >= 0 && x < A.width && y < A.height) ? (y * A.width + x) * 4 : -1;
        const bx = x - dx, by = y - dy;
        const ib = (bx >= 0 && by >= 0 && bx < B.width && by < B.height) ? (by * B.width + bx) * 4 : -1;
        const hasA = ia >= 0 && A.data[ia + 3] > 0, hasB = ib >= 0 && B.data[ib + 3] > 0;
        const oi = (cy * W + cx) * 4;
        if (hasA && hasB && seam === "feather") {
          const t = Math.min(1, Math.max(0, ((axis === "h" ? x : y) - oS) / span));   // 0 = plein A → 1 = plein B
          for (let c = 0; c < 3; c++) o[oi + c] = A.data[ia + c] * (1 - t) + Math.min(255, B.data[ib + c] * gainB) * t;
          o[oi + 3] = 255;
        } else if (hasA) { o[oi] = A.data[ia]; o[oi + 1] = A.data[ia + 1]; o[oi + 2] = A.data[ia + 2]; o[oi + 3] = 255; }   // coupe franche : A prioritaire
        else if (hasB) { for (let c = 0; c < 3; c++) o[oi + c] = Math.min(255, B.data[ib + c] * gainB); o[oi + 3] = 255; }
        // sinon : transparent (0,0,0,0 par défaut)
      }
    }
    return { img: { data: o, width: W, height: H }, ox, oy };
  }

  /** Rect de RECADRAGE AUTO (repère de A) : UNION le long de l'axe d'assemblage, INTERSECTION en
      travers (élimine les fines bandes transparentes dues au désalignement fin). Intersection
      vide (cas pathologique) → repli sur l'union complète. Seules les DIMENSIONS sont lues
      (utilisable pour l'aperçu sans matérialiser l'image redimensionnée). */
  static autoCropRect(A: { width: number; height: number }, B: { width: number; height: number }, dx: number, dy: number, axis: StitchAxis): { x: number; y: number; w: number; h: number } {
    const ux0 = Math.min(0, dx), ux1 = Math.max(A.width, dx + B.width);
    const uy0 = Math.min(0, dy), uy1 = Math.max(A.height, dy + B.height);
    const ix0 = Math.max(0, dx), ix1 = Math.min(A.width, dx + B.width);
    const iy0 = Math.max(0, dy), iy1 = Math.min(A.height, dy + B.height);
    if (axis === "h") {
      if (iy1 - iy0 >= 2) return { x: ux0, y: iy0, w: ux1 - ux0, h: iy1 - iy0 };
    } else {
      if (ix1 - ix0 >= 2) return { x: ix0, y: uy0, w: ix1 - ix0, h: uy1 - uy0 };
    }
    return { x: ux0, y: uy0, w: ux1 - ux0, h: uy1 - uy0 };
  }

  /** Découpe un rect (coords locales de `img`, clampé aux bornes). */
  static crop(img: RawImage, x: number, y: number, w: number, h: number): RawImage {
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
    const cw = Math.max(1, Math.min(img.width - x0, w | 0)), ch = Math.max(1, Math.min(img.height - y0, h | 0));
    const o = new Uint8ClampedArray(cw * ch * 4);
    for (let row = 0; row < ch; row++) {
      const src = ((y0 + row) * img.width + x0) * 4;
      o.set(img.data.subarray(src, src + cw * 4), row * cw * 4);
    }
    return { data: o, width: cw, height: ch };
  }

  /** AFFINAGE de l'alignement : cherche le (dx,dy) minimisant la différence moyenne de luminance
      (SAD) dans le recouvrement, sur ±radius px autour de la position manuelle. Sous-échantillonné
      (≤ ~10 000 échantillons/candidat) — l'alignement grossier reste à l'utilisateur. */
  static refine(A: RawImage, B: RawImage, dx: number, dy: number, radius = 10): { dx: number; dy: number } {
    const lum = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    let best = { dx, dy }, bestScore = Infinity;
    for (let ddy = -radius; ddy <= radius; ddy++) for (let ddx = -radius; ddx <= radius; ddx++) {
      const tx = dx + ddx, ty = dy + ddy;
      const x0 = Math.max(0, tx), x1 = Math.min(A.width, tx + B.width);
      const y0 = Math.max(0, ty), y1 = Math.min(A.height, ty + B.height);
      if (x1 - x0 < 4 || y1 - y0 < 4) continue;
      const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 10000)));
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
        const ia = (y * A.width + x) * 4, ib = ((y - ty) * B.width + (x - tx)) * 4;
        if (A.data[ia + 3] === 0 || B.data[ib + 3] === 0) continue;
        sum += Math.abs(lum(A.data, ia) - lum(B.data, ib)); n++;
      }
      if (n < 16) continue;
      const score = sum / n;
      if (score < bestScore) { bestScore = score; best = { dx: tx, dy: ty }; }
    }
    return best;
  }
}
