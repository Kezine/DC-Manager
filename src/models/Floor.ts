import { Entity, Props } from "./Entity";
import { Normalize } from "../core/Normalize";
import { FLOOR_WIDTH_DEFAULT, FLOOR_DEPTH_DEFAULT, FLOOR_CELL_DEFAULT } from "../domain/constants";

/** Étage : plan du bâtiment (location) à un niveau (floor) où l'on pose
    les salles et les OOB. Clé logique (location, floor). */
export class Floor extends Entity {
  location: string;
  floor: string;
  width_mm: number;
  depth_mm: number;
  cell_mm: number;
  blocked_cells: string[];
  anchor_x: number;
  anchor_y: number;

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
    this.description = p.description || "";
  }
}
