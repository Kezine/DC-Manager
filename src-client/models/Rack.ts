import { Entity, Props } from "./Entity";
import type { Records } from "../../src-shared/DataValidation";
import { Normalize, RackDoor } from "../core/Normalize";
import { RACK_WIDTH_DEFAULT, RACK_MOUNT_MARGIN_DEFAULT, RACK_DEPTH_DEFAULT } from "../domain/constants";

/** Baie (rack) : géométrie physique + emplacement dans un datacenter. */
export class Rack extends Entity implements Records.Rack {
  /** Nom (les racks sont triés par nom ; l'`order` legacy est ignoré). */
  name: string;
  /** Lieu / bâtiment (slug ∈ LOCATIONS). */
  location: string;
  /** Étage. */
  floor: string;
  /** Local / salle. */
  room: string;
  /** Hauteur utile en U. */
  u_count: number;
  /** Largeur EXTÉRIEURE (mm). */
  width_mm: number;
  /** Marge de montage unique (mm) — repli rétro-compat pour lmargin/vmargin. */
  mount_margin_mm: number;
  /** Profondeur EXTÉRIEURE (mm) — champ libre (presets = RACK_DEPTHS). */
  depth: number;
  /** Face : "single" | "dual" (double face). */
  sides: string;
  /** Autorise le side-mount en façade. */
  allow_side_front: boolean;
  /** Autorise le side-mount à l'arrière. */
  allow_side_rear: boolean;
  /** Marge latérale (montants ↔ parois, mm). Repli sur mount_margin_mm. */
  lmargin_mm: number;
  /** Marge verticale HAUTE (mm). */
  vmargin_mm: number;
  /** Marge verticale BASSE (mm). null = identique à la haute. */
  vmargin_bottom_mm: number | null;
  /** Profondeur de la cage de montage (montants av↔ar, mm). null = profondeur extérieure. */
  cage_depth_mm: number | null;
  /** Distance FAÇADE → montants AVANT (mm). 0 = montants au ras de la façade. */
  front_margin_mm: number;
  /** Hauteur extérieure (mm). null = hauteur mini dérivée. */
  height_mm: number | null;
  /** FK → datacenters. null = dans le pool (non placé). */
  datacenter_id: string | null;
  /** Position au sol — CENTRE du rack X (mm). */
  dc_x: number | null;
  /** Position au sol — CENTRE du rack Y (mm). */
  dc_y: number | null;
  /** Sens de la face avant (0/90/180/270). */
  orientation: number;
  /** Rangée (libellé libre) — sert aux layers / au groupement. */
  row: string;
  /** La baie a des CAPOTS (habillage toit/fond). false = châssis OUVERT (open-frame) : NI portes, NI
      emplacements waypoint sur le TOIT (le SOL reste perçable — passage par le faux-plancher). Attribut
      PHYSIQUE de la baie (pas un réglage d'affichage). Défaut : avec capots. */
  has_caps: boolean;
  /** Porte AVANT en saillie (épaisseur, charnière, pleine/creuse). */
  door_front: RackDoor;
  /** Porte ARRIÈRE en saillie. */
  door_rear: RackDoor;
  /** Cellules waypoint autorisées sur le TOIT (clés "cx,cy", grille au pas 1U). */
  roof_cells: string[];
  /** Cellules waypoint autorisées sur le SOL (dessous). */
  floor_cells: string[];
  /** Positionnement VERROUILLÉ : empêche déplacement / rotation / retrait de la salle DEPUIS LES VUES 2D/3D
      (drag, menus, panneau) — cf. PlacementLock. Le formulaire reste l'échappatoire (principe n°10). Défaut : libre. */
  locked: boolean;

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.location = p.location || "";
    this.floor = p.floor || "";
    this.room = p.room || "";
    this.u_count = p.u_count ? Math.max(1, p.u_count | 0) : 42;
    this.width_mm = p.width_mm ? Math.max(1, p.width_mm | 0) : RACK_WIDTH_DEFAULT;
    this.mount_margin_mm = (p.mount_margin_mm != null) ? Math.max(0, p.mount_margin_mm | 0) : RACK_MOUNT_MARGIN_DEFAULT;
    this.depth = (p.depth != null) ? Math.max(1, p.depth | 0) : RACK_DEPTH_DEFAULT;
    this.sides = (p.sides === "dual") ? "dual" : "single";
    this.allow_side_front = p.allow_side_front === true;
    this.allow_side_rear = p.allow_side_rear === true;
    this.lmargin_mm = (p.lmargin_mm != null) ? Math.max(0, p.lmargin_mm | 0) : this.mount_margin_mm;
    this.vmargin_mm = (p.vmargin_mm != null) ? Math.max(0, p.vmargin_mm | 0) : this.mount_margin_mm;
    this.vmargin_bottom_mm = (p.vmargin_bottom_mm != null && p.vmargin_bottom_mm !== "") ? Math.max(0, p.vmargin_bottom_mm | 0) : null;
    this.cage_depth_mm = (p.cage_depth_mm != null) ? Math.max(1, p.cage_depth_mm | 0) : null;
    this.front_margin_mm = (p.front_margin_mm != null && p.front_margin_mm !== "") ? Math.max(0, p.front_margin_mm | 0) : 0;
    this.height_mm = (p.height_mm != null) ? Math.max(1, p.height_mm | 0) : null;
    this.datacenter_id = p.datacenter_id || null;
    this.dc_x = (p.dc_x != null) ? +p.dc_x : null;
    this.dc_y = (p.dc_y != null) ? +p.dc_y : null;
    this.orientation = Normalize.rackOrientation(p.orientation);
    this.row = p.row || "";
    this.has_caps = p.has_caps !== false;   // défaut : AVEC capots (documents existants inchangés)
    this.door_front = Normalize.rackDoor(p.door_front);
    this.door_rear = Normalize.rackDoor(p.door_rear);
    this.roof_cells = Normalize.cellList(p.roof_cells);
    this.floor_cells = Normalize.cellList(p.floor_cells);
    this.locked = p.locked === true;
  }
}
