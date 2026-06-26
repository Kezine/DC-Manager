import { Entity, Props } from "./Entity";
import { Normalize } from "../core/Normalize";
import { FLOOR_WIDTH_DEFAULT, FLOOR_DEPTH_DEFAULT, FLOOR_CELL_DEFAULT } from "../domain/constants";

/** Étage : plan du bâtiment (location) à un niveau (floor) où l'on pose
    les salles et les OOB. Clé logique (location, floor). */
export class Floor extends Entity {
  /** Bâtiment (slug ∈ LOCATIONS) — 1re partie de la clé logique. */
  location: string;
  /** Niveau (∈ FLOORS) — 2e partie de la clé logique. */
  floor: string;
  /** Largeur du plan X (mm). */
  width_mm: number;
  /** Profondeur du plan Y (mm). */
  depth_mm: number;
  /** Maille du plan (mm). */
  cell_mm: number;
  /** Cases inaccessibles de la grille (clés "cx,cy"). */
  blocked_cells: string[];
  /** Décalage X du plan dans la pile 3D (mm) — n'affecte pas la vue 2D. */
  anchor_x: number;
  /** Décalage Y du plan dans la pile 3D (mm). */
  anchor_y: number;
  /** Hauteur de l'étage (mm) dans la pile 3D : conditionne le placement vertical (Z cumulatif).
      0 = auto (hauteur du contenu = baies). */
  height_mm: number;

  constructor(p: Props = {}) {
    super(p);
    this.location = p.location || "";
    this.floor = p.floor != null ? String(p.floor) : "";
    this.width_mm = p.width_mm ? Math.max(1, p.width_mm | 0) : FLOOR_WIDTH_DEFAULT;
    this.depth_mm = p.depth_mm ? Math.max(1, p.depth_mm | 0) : FLOOR_DEPTH_DEFAULT;
    this.cell_mm = p.cell_mm ? Math.max(1, p.cell_mm | 0) : FLOOR_CELL_DEFAULT;
    this.blocked_cells = Normalize.cellList(p.blocked_cells);
    this.anchor_x = (p.anchor_x != null) ? +p.anchor_x : 0;
    this.anchor_y = (p.anchor_y != null) ? +p.anchor_y : 0;
    this.height_mm = (p.height_mm != null) ? Math.max(0, p.height_mm | 0) : 0;   // 0 = auto (hauteur du contenu)
    this.description = p.description || "";
  }
}
