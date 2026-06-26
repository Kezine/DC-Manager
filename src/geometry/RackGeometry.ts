import {
  RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_MOUNT_MARGIN_DEFAULT,
  U_MM, SIDE_U_STEP, SIDE_POST_INSET, WALL_COL_MIN,
} from "../domain/constants";
import { Normalize } from "../core/Normalize";

/** Demi-extents au sol d'une baie. */
export interface HalfExtents { hx: number; hy: number; }
/** Repère d'une marge murale. */
export interface WallGeo { d: number; hd: number; dep: number; yFace: number; sgnInto: number; cols: number; colW: number; }

/* =============================================================================
   Géométrie de baie PURE (objets simples ; pas de store). Regroupe les helpers
   dimensionnels (marges, cage, hauteur) et la géométrie des emplacements
   side-mount / wall-mount. Les résolutions qui interrogent le store (occupants,
   emplacements libres, ports 3D) vivent dans geometry/RackScene.
   ============================================================================= */
export class RackGeometry {
  /* ---- dimensions de base ---- */

  /** Marge latérale (montants ↔ paroi, mm) ; repli sur mount_margin_mm. */
  static lMargin(rack: any): number {
    const v = (rack.lmargin_mm != null) ? rack.lmargin_mm : ((rack.mount_margin_mm != null) ? rack.mount_margin_mm : RACK_MOUNT_MARGIN_DEFAULT);
    return Math.max(0, v | 0);
  }
  /** Marge de montage du rendu = marge latérale bornée à < moitié de la largeur. */
  static mountMargin(rack: any): number {
    const w = rack.width_mm || RACK_WIDTH_DEFAULT;
    return Math.max(0, Math.min(RackGeometry.lMargin(rack), w / 2 - 20));
  }
  /** Marge verticale HAUTE (mm). */
  static vMarginTop(rack: any): number {
    const v = (rack.vmargin_mm != null) ? rack.vmargin_mm : ((rack.mount_margin_mm != null) ? rack.mount_margin_mm : RACK_MOUNT_MARGIN_DEFAULT);
    return Math.max(0, v | 0);
  }
  /** Marge verticale BASSE (mm) ; repli sur la haute. */
  static vMarginBottom(rack: any): number {
    return (rack.vmargin_bottom_mm != null && rack.vmargin_bottom_mm !== "") ? Math.max(0, rack.vmargin_bottom_mm | 0) : RackGeometry.vMarginTop(rack);
  }
  /** Compat : ancien nom = marge haute. */
  static vMargin(rack: any): number { return RackGeometry.vMarginTop(rack); }
  /** z (mm) de la base du 1er U. */
  static uBaseZ(rack: any): number { return RackGeometry.vMarginBottom(rack); }
  /** Hauteur mini dérivée (mm). */
  static minHeight(rack: any): number { return (rack.u_count || 42) * U_MM + RackGeometry.vMarginTop(rack) + RackGeometry.vMarginBottom(rack); }
  /** Hauteur physique effective (extérieur ≥ mini). */
  static physHeight(rack: any): number { const min = RackGeometry.minHeight(rack); return (rack.height_mm != null && rack.height_mm > min) ? rack.height_mm : min; }
  /** Largeur mini = zone 19″ + 2 marges latérales (mm). */
  static minWidth(rack: any): number { return RACK_MOUNT_WIDTH + 2 * RackGeometry.lMargin(rack); }
  /** Profondeur de cage (montants av↔ar, mm) ; null = profondeur extérieure. */
  static cageDepth(rack: any): number { return (rack.cage_depth_mm != null && rack.cage_depth_mm > 0) ? Math.max(1, rack.cage_depth_mm | 0) : (rack.depth || RACK_DEPTH_DEFAULT); }
  /** Profondeur mini = cage. */
  static minDepth(rack: any): number { return RackGeometry.cageDepth(rack); }
  /** Marge AVANT (façade → montants avant, mm), bornée pour que la cage tienne. */
  static frontMargin(rack: any): number {
    const d = rack.depth || RACK_DEPTH_DEFAULT, cage = Math.min(d, RackGeometry.cageDepth(rack));
    const fm = (rack.front_margin_mm != null && rack.front_margin_mm !== "") ? Math.max(0, rack.front_margin_mm | 0) : 0;
    return Math.min(fm, Math.max(0, d - cage));
  }
  /** Porte d'une face (avant/arrière). */
  static door(rack: any, face: string): any { return (face === "rear") ? rack.door_rear : rack.door_front; }
  /** Profondeur utile supplémentaire apportée par la cavité d'une porte creuse (0 sinon). */
  static doorExtraDepth(rack: any, face: string): number { const d = RackGeometry.door(rack, face); return (d && d.enabled && d.hollow) ? Math.max(0, d.hollow_mm | 0) : 0; }
  /** Vrai si la baie porte au moins une porte (avant ou arrière) activée. */
  static hasDoor(rack: any): boolean { const f = RackGeometry.door(rack, "front"), r = RackGeometry.door(rack, "rear"); return !!((f && f.enabled) || (r && r.enabled)); }
  /** Profondeur PHYSIQUE disponible pour un montage ancré au plan AVANT (montants en U / brosse) : du plan de
      montage avant jusqu'à la face arrière (`profondeur − marge avant`) + cavités des portes av/ar. Marge de
      sécurité NON retranchée (cf. RACK_DEPTH_SAFETY_MM côté formulaire). */
  static frontMountAvailDepth(rack: any): number {
    const d = rack.depth || RACK_DEPTH_DEFAULT;
    return d - RackGeometry.frontMargin(rack) + RackGeometry.doorExtraDepth(rack, "front") + RackGeometry.doorExtraDepth(rack, "rear");
  }

  /* ---- au sol ---- */

  /** Demi-extents au sol selon l'orientation (90/270 permutent largeur/profondeur). */
  static halfExtents(rack: any): HalfExtents {
    const w = rack.width_mm || RACK_WIDTH_DEFAULT, d = rack.depth || RACK_DEPTH_DEFAULT;
    const o = Normalize.rackOrientation(rack.orientation);
    return (o === 90 || o === 270) ? { hx: d / 2, hy: w / 2 } : { hx: w / 2, hy: d / 2 };
  }

  /* ---- montants (occupation) ---- */

  /** Un montage verrouille-t-il tout le U / les deux faces ? */
  static mountLocksU(m: any): boolean { return (m.depth === "full") || (m.locks_u === true); }
  /** Faces occupées par un montage selon le type de baie (simple/double). */
  static mountSides(mount: any, rack: any): string[] {
    if (!rack || rack.sides !== "dual") return ["front"];
    if (mount.isItem) return [mount.side === "rear" ? "rear" : "front"];
    return RackGeometry.mountLocksU(mount) ? ["front", "rear"] : [mount.side === "rear" ? "rear" : "front"];
  }
  /** Un bloc [startU, startU+height) tient-il et est-il libre sur les faces données ? */
  static canPlace(rack: any, startU: number, height: number, sides: string[], occ: Map<string, any>): boolean {
    if (!rack || startU == null) return false;
    if (startU < 1 || (startU + height - 1) > rack.u_count) return false;
    for (let i = 0; i < height; i++) { const u = startU + i; for (const s of sides) { if (occ.has(u + ":" + s)) return false; } }
    return true;
  }

  /* ---- side-mount (marge latérale) ---- */

  /** Marge latérale réelle par côté (mm) = (largeur − entraxe 19″)/2. */
  static sideMarginMm(rack: any): number { return Math.max(0, ((rack.width_mm || RACK_WIDTH_DEFAULT) - RACK_MOUNT_WIDTH) / 2); }
  /** Nombre de colonnes de side-mount (2 si la marge dépasse 2U, sinon 1). */
  static sideColumns(rack: any): number { return RackGeometry.sideMarginMm(rack) > 2 * U_MM ? 2 : 1; }
  /** Largeur d'une colonne de side-mount (mm). */
  static sideColWidthMm(rack: any): number { return RackGeometry.sideMarginMm(rack) / RackGeometry.sideColumns(rack); }
  /** Side-mount possible sur cette face ? (marge ≥ 1U + flag autorisé). */
  static sideEnabled(rack: any, face: string): boolean {
    return RackGeometry.sideMarginMm(rack) >= U_MM && (face === "rear" ? rack.allow_side_rear === true : rack.allow_side_front === true);
  }
  /** Hauteur (en U) occupée par un équipement side-monté (≥ 1). */
  static sideEquipHeightU(eq: any): number { return Math.max(1, Math.ceil((eq.free_h_mm || U_MM) / U_MM)); }
  /** L'équipement tient-il dans une colonne de marge ? */
  static sideEquipFits(rack: any, eq: any): boolean { return (eq.free_w_mm || 0) <= RackGeometry.sideColWidthMm(rack) + 0.5; }

  /** Boîte LOCALE (repère baie) d'un équipement side-monté. */
  static sideEquipBoxLocal(rack: any, e: any): any {
    const M = RackGeometry.sideMarginMm(rack), cols = RackGeometry.sideColumns(rack);
    const usable = Math.max(1, M - SIDE_POST_INSET), colW = usable / cols;
    const col = (e.side_col === 1 && cols > 1) ? 1 : 0;
    const lr = (e.side_lr === "right") ? "right" : "left";
    const w = Math.min(Math.max(1, e.free_w_mm || colW), colW);
    const inner0 = RACK_MOUNT_WIDTH / 2 + SIDE_POST_INSET;
    const colInner = inner0 + col * colW, colOuter = colInner + colW;
    let x0r, x1r;
    if (e.side_snap === "wall") { x1r = colOuter; x0r = colOuter - w; } else { x0r = colInner; x1r = colInner + w; }
    const xs = (lr === "right") ? [x0r, x1r] : [-x1r, -x0r];
    const heightU = RackGeometry.sideEquipHeightU(e);
    const z0 = RackGeometry.uBaseZ(rack) + (Math.max(1, e.side_u | 0) - 1) * U_MM;
    const z1 = z0 + Math.max(U_MM, e.free_h_mm || heightU * U_MM);
    const d = rack.depth || RACK_DEPTH_DEFAULT, hd = d / 2, cage = Math.min(d, RackGeometry.cageDepth(rack));
    const fm = RackGeometry.frontMargin(rack), fp = -hd + fm, rp = -hd + fm + cage;
    const len = Math.min(Math.max(20, e.free_l_mm || cage), cage - 8);
    const front = (e.side_face !== "rear");
    let y0, y1;
    if (front) { y0 = fp + 4; y1 = fp + 4 + len; } else { y1 = rp - 4; y0 = rp - 4 - len; }
    return { x0: xs[0], x1: xs[1], y0, y1, z0, z1, front, col, lr, heightU };
  }

  /** Boîte locale plate d'un emplacement latéral LIBRE (colonne pleine × bande de U). */
  static sideSlotBoxLocal(rack: any, face: string, lr: string, col: number, uTop: number, heightU: number): any {
    const M = RackGeometry.sideMarginMm(rack), cols = RackGeometry.sideColumns(rack);
    const usable = Math.max(1, M - SIDE_POST_INSET), colW = usable / cols;
    const inner0 = RACK_MOUNT_WIDTH / 2 + SIDE_POST_INSET, colInner = inner0 + col * colW, colOuter = colInner + colW;
    const xs = (lr === "right") ? [colInner, colOuter] : [-colOuter, -colInner];
    const z0 = RackGeometry.uBaseZ(rack) + (Math.max(1, uTop | 0) - 1) * U_MM + 1, z1 = z0 + Math.max(1, heightU || SIDE_U_STEP) * U_MM - 2;
    const d = rack.depth || RACK_DEPTH_DEFAULT, hd = d / 2;
    const fm = RackGeometry.frontMargin(rack), cage = Math.min(d, RackGeometry.cageDepth(rack));
    const yPlane = (face === "rear") ? (-hd + fm + cage - 2) : (-hd + fm + 2);
    return { x0: xs[0], x1: xs[1], z0, z1, yPlane, front: face !== "rear" };
  }

  /* ---- wall-mount (paroi, marge avant/arrière) ---- */

  /** Profondeur de marge (mm) le long de laquelle on monte en paroi. */
  static marginDepth(rack: any, margin: string): number {
    const d = rack.depth || RACK_DEPTH_DEFAULT, cage = Math.min(d, RackGeometry.cageDepth(rack)), fm = RackGeometry.frontMargin(rack);
    return (margin === "rear") ? Math.max(0, d - fm - cage) : fm;
  }
  /** Wall-mount possible sur cette marge ? (profondeur ≥ 1U). */
  static wallEnabled(rack: any, margin: string): boolean { return RackGeometry.marginDepth(rack, margin) >= U_MM; }
  /** Repère de la marge : face extérieure, sens vers les montants, colonnes. */
  static wallGeo(rack: any, margin: string): WallGeo {
    const d = rack.depth || RACK_DEPTH_DEFAULT, hd = d / 2, dep = RackGeometry.marginDepth(rack, margin);
    const yFace = (margin === "rear") ? hd : -hd, sgnInto = (margin === "rear") ? -1 : 1;
    const cols = Math.max(1, Math.floor(dep / WALL_COL_MIN)), colW = dep / cols;
    return { d, hd, dep, yFace, sgnInto, cols, colW };
  }
  /** Boîte locale plate d'un emplacement mural LIBRE (colonne × bande de U). */
  static wallSlotBoxLocal(rack: any, wall: string, margin: string, col: number, uTop: number, heightU: number): any {
    const g = RackGeometry.wallGeo(rack, margin), hw = (rack.width_mm || RACK_WIDTH_DEFAULT) / 2;
    const xPlane = (wall === "right") ? hw : -hw;
    const ya = g.yFace + g.sgnInto * (col * g.colW), yb = g.yFace + g.sgnInto * ((col + 1) * g.colW);
    const z0 = RackGeometry.uBaseZ(rack) + (Math.max(1, uTop | 0) - 1) * U_MM + 1, z1 = z0 + Math.max(1, heightU || SIDE_U_STEP) * U_MM - 2;
    return { xPlane, y0: Math.min(ya, yb), y1: Math.max(ya, yb), z0, z1, wall, margin };
  }
  /** Boîte locale 3D d'un équipement monté en paroi + normale sortante `n` de sa face. */
  static wallEquipBoxLocal(rack: any, e: any): any {
    const wall = (e.wall_lr === "right") ? "right" : "left", margin = (e.wall_margin === "rear") ? "rear" : "front";
    const orient = (e.wall_orient === "facade") ? "facade" : "center";
    const g = RackGeometry.wallGeo(rack, margin), hw = (rack.width_mm || RACK_WIDTH_DEFAULT) / 2;
    const xWall = (wall === "right") ? hw : -hw, into = (wall === "right") ? -1 : 1;
    const col = Math.max(0, e.wall_col | 0), uTop = Math.max(1, e.wall_u | 0);
    const colYa = g.yFace + g.sgnInto * (col * g.colW);
    const z0 = RackGeometry.uBaseZ(rack) + (uTop - 1) * U_MM, z1 = z0 + Math.max(U_MM, e.free_h_mm || RackGeometry.sideEquipHeightU(e) * U_MM);
    const W = Math.max(20, e.free_w_mm || g.colW), L = Math.max(20, e.free_l_mm || 100);
    let x0, x1, y0, y1, n;
    if (orient === "center") {
      const dx = Math.min(L, hw);
      x0 = (into > 0) ? xWall : xWall - dx; x1 = (into > 0) ? xWall + dx : xWall;
      const wy = Math.min(W, g.colW), yb = colYa + g.sgnInto * wy;
      y0 = Math.min(colYa, yb); y1 = Math.max(colYa, yb);
      n = { x: into, y: 0 };
    } else {
      const wx = Math.min(W, hw);
      x0 = (into > 0) ? xWall : xWall - wx; x1 = (into > 0) ? xWall + wx : xWall;
      const dy = Math.min(L, g.dep), yb = g.yFace + g.sgnInto * dy;
      y0 = Math.min(g.yFace, yb); y1 = Math.max(g.yFace, yb);
      n = { x: 0, y: -g.sgnInto };
    }
    return { x0, x1, y0, y1, z0, z1, n, orient, wall, margin };
  }

  /* ---- capots (toit/sol) ---- */

  /** Grille au pas 1U du capot (largeur × profondeur), CENTRÉE : la largeur/profondeur n'étant pas un multiple
      exact de 1U, le reste est réparti en marge ÉGALE de chaque côté (`mx`/`my`) → trous symétriques. La marge
      n'est pas perçable (hors grille) mais reste couverte par la plaque. `mx`/`my` < 0 si 1U > dimension (rare). */
  static capGrid(rack: any): any {
    const w = rack.width_mm || RACK_WIDTH_DEFAULT, d = rack.depth || RACK_DEPTH_DEFAULT;
    const nx = Math.max(1, Math.round(w / U_MM)), ny = Math.max(1, Math.round(d / U_MM));
    return { w, d, nx, ny, cell: U_MM, mx: (w - nx * U_MM) / 2, my: (d - ny * U_MM) / 2 };
  }
  /** Cellules autorisées d'un capot ("roof" | "floor"). */
  static capCells(rack: any, face: string): string[] { const v = (face === "floor") ? rack.floor_cells : rack.roof_cells; return Array.isArray(v) ? v : []; }
  /** Centre LOCAL (repère baie) d'une cellule (cx,cy) du capot (grille centrée). */
  static capCellLocalCenter(rack: any, cx: number, cy: number): { lx: number; ly: number } {
    const g = RackGeometry.capGrid(rack);
    return { lx: -g.w / 2 + g.mx + ((cx | 0) + 0.5) * g.cell, ly: -g.d / 2 + g.my + ((cy | 0) + 0.5) * g.cell };
  }
}
