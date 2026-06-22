import { Entity, Props } from "./Entity";
import { EQUIP_FACE_IDS } from "../domain/constants";

/** Port d'un équipement (peut être un trunk éclaté en lanes — breakout). */
export class Port extends Entity {
  /** FK → equipments (l'équipement porteur). */
  equipment_id: string | null;
  /** Nom du port (ex. "Gi1/0/1"). */
  name: string;
  /** FK → portTypes (famille + connecteur). */
  port_type_id: string | null;
  /** Rôle : "data" | "power" | … */
  role: string;
  /** FK → aggregates. null = pas dans un agrégat. */
  aggregate_id: string | null;
  /** BREAKOUT : FK → ports (le trunk parent). null = port normal/trunk. */
  parent_port_id: string | null;
  /** Index de lane (1..N) si breakout. null = non-lane. */
  lane: number | null;
  /** Position X normalisée (0..1) sur la façade. null = non placé. */
  face_x: number | null;
  /** Position Y normalisée (0..1) sur la façade. */
  face_y: number | null;
  /** Face de l'équipement (front/rear + top/bottom/left/right pour le libre). */
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
