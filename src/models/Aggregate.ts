import { Entity, Props } from "./Entity";

/** Agrégat de ports (LACP / port-channel) sur un équipement. */
export class Aggregate extends Entity {
  equipment_id: string | null;
  name: string;

  constructor(p: Props = {}) {
    super(p);
    this.equipment_id = p.equipment_id || null;
    this.name = p.name || "";
  }
}
