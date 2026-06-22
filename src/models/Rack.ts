import { Entity, Props } from "./Entity";
import { Normalize, RackDoor } from "../core/Normalize";
import { RACK_WIDTH_DEFAULT, RACK_MOUNT_MARGIN_DEFAULT, RACK_DEPTH_DEFAULT } from "../domain/constants";

/** Baie (rack) : géométrie physique + emplacement dans un datacenter. */
export class Rack extends Entity {
  name: string;
  location: string;
  floor: string;
  room: string;
  u_count: number;
  width_mm: number;
  mount_margin_mm: number;
  depth: number;
  sides: string;
  allow_side_front: boolean;
  allow_side_rear: boolean;
  lmargin_mm: number;
  vmargin_mm: number;
  vmargin_bottom_mm: number | null;
  cage_depth_mm: number | null;
  front_margin_mm: number;
  height_mm: number | null;
  datacenter_id: string | null;
  dc_x: number | null;
  dc_y: number | null;
  orientation: number;
  row: string;
  door_front: RackDoor;
  door_rear: RackDoor;
  roof_cells: string[];
  floor_cells: string[];

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
    this.door_front = Normalize.rackDoor(p.door_front);
    this.door_rear = Normalize.rackDoor(p.door_rear);
    this.roof_cells = Normalize.cellList(p.roof_cells);
    this.floor_cells = Normalize.cellList(p.floor_cells);
  }
}
