import { Entity, Props } from "./Entity";
import { EQUIP_FACE_IDS } from "../domain/constants";

/** Port d'un équipement (peut être un trunk éclaté en lanes — breakout). */
export class Port extends Entity {
  equipment_id: string | null;
  name: string;
  port_type_id: string | null;
  role: string;
  aggregate_id: string | null;
  parent_port_id: string | null;
  lane: number | null;
  face_x: number | null;
  face_y: number | null;
  face_side: string;

  constructor(p: Props = {}) {
    super(p);
    this.equipment_id = p.equipment_id || null;
    this.name = p.name || "";
    this.port_type_id = p.port_type_id || null;
    this.role = p.role || "data";
    this.aggregate_id = p.aggregate_id || null;
    this.parent_port_id = p.parent_port_id || null;
    this.lane = (p.lane != null) ? (p.lane | 0) : null;
    this.face_x = (p.face_x != null) ? p.face_x : null;
    this.face_y = (p.face_y != null) ? p.face_y : null;
    this.face_side = EQUIP_FACE_IDS.includes(p.face_side) ? p.face_side : "front";
  }
}
