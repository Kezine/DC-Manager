import { Entity, Props } from "./Entity";
import type { Records } from "../../src-shared/DataValidation";

/** Attribution IP statique (adresse unique globalement) — IPAM. */
export class IpAddress extends Entity implements Records.IpAddress {
  /** FK → ipNetworks (le sous-réseau). */
  network_id: string | null;
  /** Adresse IPv4 « a.b.c.d » — UNIQUE globalement. */
  address: string;
  /** FK → equipments. null = non rattachée. */
  equipment_id: string | null;
  /** FK → vms : VM à laquelle l'IP est rattachée. null = non rattachée. MUTUELLEMENT EXCLUSIF avec `equipment_id`
      (une adresse vise un équipement OU une VM, jamais les deux — invariant de la spec ipAddresses). */
  vm_id: string | null;
  /** Nom d'hôte auquel l'IP résout. */
  hostname: string;

  constructor(p: Props = {}) {
    super(p);
    this.network_id = p.network_id || null;
    this.address = p.address || "";
    this.equipment_id = p.equipment_id || null;
    // parité avec equipment_id : FK LOCALE nullable, défaut null (rapprochement IPAM informatif — cf. cadrage décision 4).
    this.vm_id = p.vm_id || null;
    this.hostname = p.hostname || "";
  }
}
