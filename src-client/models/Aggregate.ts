import { Entity, Props } from "./Entity";

/** Agrégat de ports (LACP / port-channel) sur un équipement. */
export class Aggregate extends Entity {
  /** FK → equipments (l'équipement porteur). */
  equipment_id: string | null;
  /** Nom de l'agrégat (ex. "Po1"). */
  name: string;

  constructor(p: Props = {}) {
    super(p);
    this.equipment_id = p.equipment_id || null;
    this.name = p.name || "";
  }
}
