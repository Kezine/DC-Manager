import { Entity, Props } from "./Entity";
import type { Records } from "../../src-shared/DataValidation";

/** Plage d'adresses réservée à un serveur DHCP — IPAM. */
export class DhcpRange extends Entity implements Records.DhcpRange {
  /** FK → ipNetworks (le sous-réseau). */
  network_id: string | null;
  /** Première adresse de la plage (incluse). */
  start_ip: string;
  /** Dernière adresse de la plage (incluse). */
  end_ip: string;
  /** FK → equipments : le serveur DHCP. null = non désigné. */
  server_id: string | null;

  constructor(p: Props = {}) {
    super(p);
    this.network_id = p.network_id || null;
    this.start_ip = p.start_ip || "";
    this.end_ip = p.end_ip || "";
    this.server_id = p.server_id || null;
  }
}
