import { Entity, Props } from "./Entity";

/** Attribution IP statique (adresse unique globalement) — IPAM. */
export class IpAddress extends Entity {
  network_id: string | null;
  address: string;
  equipment_id: string | null;
  hostname: string;

  constructor(p: Props = {}) {
    super(p);
    this.network_id = p.network_id || null;
    this.address = p.address || "";
    this.equipment_id = p.equipment_id || null;
    this.hostname = p.hostname || "";
  }
}
