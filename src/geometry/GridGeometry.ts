/** Grille de plan d'étage / salle (cases carrées de `cell` mm). Helpers PURS. */
export class GridGeometry {
  /** Clé stable d'une cellule. */
  static cellKey(cx: number, cy: number): string { return cx + "," + cy; }

  /** Cellule (cx,cy) contenant le point monde (x,y). */
  static cellOf(x: number, y: number, cell: number): { cx: number; cy: number } {
    return { cx: Math.floor(x / cell), cy: Math.floor(y / cell) };
  }

  /** La cellule (cx,cy) est-elle dans la liste des cases bloquées ? */
  static isCellBlocked(blocked: string[] | null | undefined, cx: number, cy: number): boolean {
    return Array.isArray(blocked) && blocked.includes(GridGeometry.cellKey(cx, cy));
  }

  /** Une emprise [x0..x1]×[y0..y1] (mm) chevauche-t-elle une case bloquée ? */
  static spanHitsBlocked(blocked: string[] | null | undefined, x0: number, y0: number, x1: number, y1: number, cell: number): boolean {
    if (!blocked || !blocked.length) return false;
    const c0 = GridGeometry.cellOf(x0 + 1, y0 + 1, cell), c1 = GridGeometry.cellOf(x1 - 1, y1 - 1, cell);
    for (let cx = c0.cx; cx <= c1.cx; cx++) for (let cy = c0.cy; cy <= c1.cy; cy++) if (GridGeometry.isCellBlocked(blocked, cx, cy)) return true;
    return false;
  }
}
