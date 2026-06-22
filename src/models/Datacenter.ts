import { Entity, Props } from "./Entity";
import { Normalize } from "../core/Normalize";
import { DC_WIDTH_DEFAULT, DC_DEPTH_DEFAULT, DC_CELL_DEFAULT } from "../domain/constants";

/** Salle datacenter : grille au sol + dimensions ; pioche dans le pool de racks. */
export class Datacenter extends Entity {
  name: string;
  width_mm: number;
  depth_mm: number;
  cell_mm: number;
  location: string;
  floor: string;
  room: string;
  floor_x: number | null;
  floor_y: number | null;
  floor_orientation: number;
  blocked_cells: string[];

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.width_mm = p.width_mm ? Math.max(1, p.width_mm | 0) : DC_WIDTH_DEFAULT;
    this.depth_mm = p.depth_mm ? Math.max(1, p.depth_mm | 0) : DC_DEPTH_DEFAULT;
    this.cell_mm = p.cell_mm ? Math.max(1, p.cell_mm | 0) : DC_CELL_DEFAULT;
    this.location = p.location || "";
    this.floor = p.floor || "";
    this.room = p.room || "";
    this.floor_x = (p.floor_x != null) ? +p.floor_x : null;
    this.floor_y = (p.floor_y != null) ? +p.floor_y : null;
    this.floor_orientation = Normalize.rackOrientation(p.floor_orientation);
    this.blocked_cells = Normalize.cellList(p.blocked_cells);
  }
}
