import { Entity, Props } from "./Entity";
import {
  WAYPOINT_Z_DEFAULT,
  CONDUIT_W_DEFAULT,
  CONDUIT_H_DEFAULT,
  OOB_HEIGHT_DEFAULT,
} from "../domain/constants";

/** Point de passage de câbles. Trois formes (kind : point | segment | brush)
    et trois types (wp_type : datacenter | exit | oob). */
export class Waypoint extends Entity {
  name: string;
  kind: string;
  rack_id: string | null;
  rack_u: number;
  u_height: number;
  depth_mm: number;
  side_face: string | null;
  side_lr: string | null;
  side_col: number | null;
  side_u: number | null;
  cap_face: string | null;
  cap_cx: number | null;
  cap_cy: number | null;
  wp_type: string;
  datacenter_id: string | null;
  dc_x: number | null;
  dc_y: number | null;
  dc_x2: number | null;
  dc_y2: number | null;
  dc_z: number;
  width_mm: number;
  height_mm: number;
  radius: number;
  spread: boolean;
  floor: string;
  location: string;
  floor_x: number | null;
  floor_y: number | null;

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.kind = (p.kind === "segment") ? "segment" : (p.kind === "brush") ? "brush" : "point";
    this.rack_id = p.rack_id || null;
    this.rack_u = (p.rack_u != null) ? Math.max(1, p.rack_u | 0) : 1;
    this.u_height = (p.u_height != null) ? Math.max(1, p.u_height | 0) : 1;
    this.depth_mm = (p.depth_mm != null) ? Math.max(1, +p.depth_mm) : 100;
    this.side_face = (p.side_face === "rear") ? "rear" : (p.side_face === "front" ? "front" : null);
    this.side_lr = (p.side_lr === "left" || p.side_lr === "right") ? p.side_lr : null;
    this.side_col = (p.side_col === 1) ? 1 : (p.side_col === 0 ? 0 : null);
    this.side_u = (p.side_u != null) ? Math.max(1, p.side_u | 0) : null;
    this.cap_face = (p.cap_face === "roof" || p.cap_face === "floor") ? p.cap_face : null;
    this.cap_cx = (p.cap_cx != null) ? (p.cap_cx | 0) : null;
    this.cap_cy = (p.cap_cy != null) ? (p.cap_cy | 0) : null;
    this.wp_type = (p.wp_type === "exit" || p.wp_type === "oob") ? p.wp_type : "datacenter";
    this.datacenter_id = p.datacenter_id || null;
    this.dc_x = (p.dc_x != null) ? +p.dc_x : null;
    this.dc_y = (p.dc_y != null) ? +p.dc_y : null;
    this.dc_x2 = (p.dc_x2 != null) ? +p.dc_x2 : null;
    this.dc_y2 = (p.dc_y2 != null) ? +p.dc_y2 : null;
    this.dc_z = (p.dc_z != null) ? +p.dc_z : WAYPOINT_Z_DEFAULT;
    this.width_mm = (p.width_mm != null) ? Math.max(0, +p.width_mm) : CONDUIT_W_DEFAULT;
    this.height_mm = (p.height_mm != null) ? Math.max(0, +p.height_mm) : CONDUIT_H_DEFAULT;
    this.radius = (p.radius != null) ? Math.max(0, +p.radius) : 0;
    this.spread = p.spread === true;
    this.floor = p.floor != null ? String(p.floor) : "";
    this.location = p.location || "";
    this.floor_x = (p.floor_x != null) ? +p.floor_x : null;
    this.floor_y = (p.floor_y != null) ? +p.floor_y : null;
    if (this.wp_type === "oob") {
      this.datacenter_id = null; this.dc_x = null; this.dc_y = null;
      this.dc_x2 = null; this.dc_y2 = null; this.kind = "point";
      this.dc_z = (p.dc_z != null) ? Math.max(0, +p.dc_z) : OOB_HEIGHT_DEFAULT;
    } else {
      this.floor_x = null; this.floor_y = null;
    }
  }
}
