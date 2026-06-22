import { Entity, Props } from "./Entity";
import { Normalize } from "../core/Normalize";
import { DC_WIDTH_DEFAULT, DC_DEPTH_DEFAULT, DC_CELL_DEFAULT } from "../domain/constants";

/** Salle datacenter : grille au sol + dimensions ; pioche dans le pool de racks. */
export class Datacenter extends Entity {
  /** Nom de la salle. */
  name: string;
  /** Largeur salle X (mm). */
  width_mm: number;
  /** Profondeur salle Y (mm). */
  depth_mm: number;
  /** Maille de grille / dalle (mm). */
  cell_mm: number;
  /** Lieu / bâtiment (slug ∈ LOCATIONS) — hérité par les équipements LIBRES posés ici. */
  location: string;
  /** Étage. */
  floor: string;
  /** Salle / local. */
  room: string;
  /** Coin haut-gauche de l'emprise sur le PLAN D'ÉTAGE X (mm). null = auto. */
  floor_x: number | null;
  /** Coin haut-gauche de l'emprise sur le PLAN D'ÉTAGE Y (mm). */
  floor_y: number | null;
  /** Orientation de la salle sur le plan d'étage (0/90/180/270). */
  floor_orientation: number;
  /** Cases INACCESSIBLES de la grille de racks (clés "cx,cy"). */
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
