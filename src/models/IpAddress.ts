import { Entity, Props } from "./Entity";

/** Attribution IP statique (adresse unique globalement) — IPAM. */
export class IpAddress extends Entity {
  /** FK → ipNetworks (le sous-réseau). */
  network_id: string | null;
  /** Adresse IPv4 « a.b.c.d » — UNIQUE globalement. */
  address: string;
  /** FK → equipments. null = non rattachée. */
  equipment_id: string | null;
  /** Nom d'hôte auquel l'IP résout. */
  hostname: string;

  constructor(p: Props = {}) {
    super(p);
    this.network_id = p.network_id || null;
    this.address = p.address || "";
    this.equipment_id = p.equipment_id || null;
    this.hostname = p.hostname || "";
  }
}
