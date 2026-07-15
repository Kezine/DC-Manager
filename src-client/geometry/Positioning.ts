/* =============================================================================
   AIDE AU POSITIONNEMENT — cœur géométrique PUR (sans DOM, sans store, sans vue).

   But : placer un rectangle (un rack au sol) par rapport aux MURS d'un cadre (la
   salle) et/ou aux COINS d'autres rectangles (les autres racks), via des cotes
   PERPENDICULAIRES aux côtés. Tout est aligné aux axes : un rack a une orientation
   0/90/180/270, donc son emprise au sol est un rectangle axis-aligned (cf.
   RackGeometry.halfExtents) — les cotes sont donc naturellement horizontales (axe X)
   ou verticales (axe Y), toujours ⟂ aux côtés.

   Ce module est VOLONTAIREMENT générique (rectangles + cadre), pas spécifique aux
   racks : la vue Plan de salle l'alimente avec les racks d'une salle ; la vue Plan
   d'étage pourra le réutiliser tel quel avec les SALLES posées sur un étage (même
   primitive : des rectangles dans un cadre). Le liant spécifique (entité ↔ Rect,
   écriture de la position) vit dans la couche vue.

   Repère : monde 2D en mm, x = horizontal (largeur), y = vertical (profondeur, croît
   vers le BAS comme à l'écran). Origine du cadre au coin haut-gauche → [0,0]→[w,h].

   C'est une AIDE : on calcule une nouvelle position et on l'écrit UNE fois ; aucune
   relation (coin ↔ référence) n'est mémorisée — pas de contraintes paramétriques.
   ============================================================================= */

/** Point monde (mm). */
export interface Pt { x: number; y: number; }

/** Rectangle aligné aux axes : CENTRE + demi-extents (déjà permutés selon l'orientation). */
export interface Rect { cx: number; cy: number; hx: number; hy: number; }

/** Cadre conteneur (salle / étage) : rectangle [0,0]→[w,h]. Ses 4 bords sont les « murs ». */
export interface Frame { w: number; h: number; }

/** Les 4 coins, nommés dans le repère écran (T = haut, B = bas, L = gauche, R = droite). */
export type CornerId = "TL" | "TR" | "BR" | "BL";
/** Les 4 murs du cadre. */
export type WallId = "left" | "right" | "top" | "bottom";
/** Axe d'une cote : perpendiculaire au côté coté (x = cote horizontale ⟂ mur vertical, etc.). */
export type Axis = "x" | "y";

export const CORNER_IDS: CornerId[] = ["TL", "TR", "BR", "BL"];
export const WALL_IDS: WallId[] = ["left", "right", "top", "bottom"];

/** Référence d'une cote : soit un mur du cadre, soit la coordonnée d'un coin d'un AUTRE rectangle (ancre). */
export type Ref =
  | { kind: "wall"; wall: WallId }
  | { kind: "corner"; rectId: string; corner: CornerId };

/** Cote calculée (pour l'affichage) : segment ⟂ du coin actif jusqu'au référent, sur un axe, + longueur. */
export interface Cote { axis: Axis; value: number; from: Pt; to: Pt }

/** Résultat d'un accrochage (snap) de centre : centre ajusté + lignes accrochées par axe (null si aucune). */
export interface SnapResult { cx: number; cy: number; snapX: number | null; snapY: number | null }

export class Positioning {
  /** Seuil d'accrochage par défaut, en PIXELS écran (converti en mm via le scale courant côté vue). */
  static readonly SNAP_PX = 9;

  /* ---- coins & murs ---- */

  /** Les 4 coins (monde). TL = (cx−hx, cy−hy) … (v croît vers le bas → T = y min). */
  static corners(r: Rect): Record<CornerId, Pt> {
    return {
      TL: { x: r.cx - r.hx, y: r.cy - r.hy },
      TR: { x: r.cx + r.hx, y: r.cy - r.hy },
      BR: { x: r.cx + r.hx, y: r.cy + r.hy },
      BL: { x: r.cx - r.hx, y: r.cy + r.hy },
    };
  }
  static corner(r: Rect, c: CornerId): Pt { return Positioning.corners(r)[c]; }

  /** Signe de l'offset d'un coin par rapport au centre (sx sur x, sy sur y) : R/B = +1, L/T = −1. */
  static cornerSign(c: CornerId): { sx: number; sy: number } {
    return { sx: (c === "TR" || c === "BR") ? 1 : -1, sy: (c === "BL" || c === "BR") ? 1 : -1 };
  }

  /** Ligne d'un mur sur SON axe : left→{x,0}, right→{x,w}, top→{y,0}, bottom→{y,h}. */
  static wallLine(frame: Frame, wall: WallId): { axis: Axis; value: number } {
    switch (wall) {
      case "left": return { axis: "x", value: 0 };
      case "right": return { axis: "x", value: frame.w };
      case "top": return { axis: "y", value: 0 };
      case "bottom": return { axis: "y", value: frame.h };
    }
  }
  /** Axe d'une référence (mur vertical/horizontal ; un coin sert les DEUX axes). */
  static refAxis(ref: Ref, frame: Frame): Axis | "both" {
    return ref.kind === "wall" ? Positioning.wallLine(frame, ref.wall).axis : "both";
  }

  /* ---- valeurs & distances ---- */

  /** Coordonnée monde de la référence sur l'axe demandé (null si la référence ne porte pas cet axe). */
  static refValue(ref: Ref, axis: Axis, frame: Frame, rects: Record<string, Rect>): number | null {
    if (ref.kind === "wall") {
      const wl = Positioning.wallLine(frame, ref.wall);
      return wl.axis === axis ? wl.value : null;
    }
    const r = rects[ref.rectId]; if (!r) return null;
    const p = Positioning.corner(r, ref.corner);
    return axis === "x" ? p.x : p.y;
  }

  /** Distance PERPENDICULAIRE (absolue, mm) du coin au référent sur l'axe — null si non applicable. */
  static distance(corner: Pt, ref: Ref, axis: Axis, frame: Frame, rects: Record<string, Rect>): number | null {
    const v = Positioning.refValue(ref, axis, frame, rects); if (v == null) return null;
    return Math.abs((axis === "x" ? corner.x : corner.y) - v);
  }

  /** Cote d'affichage (segment ⟂) du `corner` jusqu'à la référence sur `axis` — null si non applicable.
      Le segment est porté par l'axe : sur x, il va de (refX, corner.y) à (corner.x, corner.y) ; sur y, de
      (corner.x, refY) à (corner.x, corner.y) → toujours ⟂ au côté coté. */
  static cote(corner: Pt, ref: Ref, axis: Axis, frame: Frame, rects: Record<string, Rect>): Cote | null {
    const v = Positioning.refValue(ref, axis, frame, rects); if (v == null) return null;
    const from: Pt = axis === "x" ? { x: v, y: corner.y } : { x: corner.x, y: v };
    return { axis, value: Math.abs((axis === "x" ? corner.x : corner.y) - v), from, to: { x: corner.x, y: corner.y } };
  }

  /* ---- placement (déplacement du rectangle) ---- */

  /** Nouveau CENTRE (sur `axis`) du rectangle `mover` pour que son coin `cornerId` soit à `value` mm de la
      référence — du MÊME CÔTÉ qu'actuellement (le signe est conservé : pas de saut au travers de la référence).
      Renvoie null si la référence ne porte pas cet axe. La coordonnée de l'autre axe n'est pas touchée. */
  static placeAxis(mover: Rect, cornerId: CornerId, axis: Axis, ref: Ref, value: number, frame: Frame, rects: Record<string, Rect>): number | null {
    const refV = Positioning.refValue(ref, axis, frame, rects); if (refV == null) return null;
    const sign = Positioning.cornerSign(cornerId);
    const cur = Positioning.corner(mover, cornerId);
    const curCoord = axis === "x" ? cur.x : cur.y;
    const side = (curCoord >= refV) ? 1 : -1;                 // côté actuel conservé
    const targetCorner = refV + side * Math.abs(value);       // position cible du coin sur cet axe
    const half = axis === "x" ? mover.hx : mover.hy;          // offset coin↔centre
    const off = (axis === "x" ? sign.sx : sign.sy) * half;
    return targetCorner - off;                                // centre = coin cible − offset
  }

  /* ---- accrochage (snap) au glisser ---- */

  /** Lignes d'accrochage sur un axe : les 2 murs du cadre + les bords (coins) de tous les autres rectangles. */
  static snapLines(axis: Axis, frame: Frame, rects: Rect[], excludeIdx: number): number[] {
    const out: number[] = axis === "x" ? [0, frame.w] : [0, frame.h];
    rects.forEach((r, i) => {
      if (i === excludeIdx) return;
      if (axis === "x") out.push(r.cx - r.hx, r.cx + r.hx);
      else out.push(r.cy - r.hy, r.cy + r.hy);
    });
    return out;
  }

  /** Accroche le CENTRE candidat : pour chaque axe, on tente d'aligner l'un des deux bords du mover (centre ± demi)
      sur la ligne la plus proche dans la tolérance `tol` (mm). Renvoie le centre ajusté + la ligne accrochée/axe. */
  static snapCenter(mover: Rect, candCx: number, candCy: number, frame: Frame, rects: Rect[], excludeIdx: number, tol: number): SnapResult {
    const fit = (center: number, half: number, lines: number[]): { delta: number; line: number } | null => {
      let best: { delta: number; line: number } | null = null, bestD = tol;
      for (const edge of [center - half, center + half]) {
        // Tolérance INCLUSIVE (`d <= tol`) mais on ne remplace que si STRICTEMENT plus proche (`d < bestD`) : à
        // distance égale, la PREMIÈRE ligne rencontrée gagne → accrochage déterministe (priorité par l'ordre des
        // lignes : murs du cadre d'abord, puis bords des rects dans l'ordre ; cf. snapLines).
        for (const L of lines) { const d = Math.abs(edge - L); if (d <= tol && (best === null || d < bestD)) { bestD = d; best = { delta: L - edge, line: L }; } }
      }
      return best;
    };
    const ax = fit(candCx, mover.hx, Positioning.snapLines("x", frame, rects, excludeIdx));
    const ay = fit(candCy, mover.hy, Positioning.snapLines("y", frame, rects, excludeIdx));
    return { cx: candCx + (ax ? ax.delta : 0), cy: candCy + (ay ? ay.delta : 0), snapX: ax ? ax.line : null, snapY: ay ? ay.line : null };
  }
}
