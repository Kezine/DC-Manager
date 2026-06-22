import { Entity, Props } from "./Entity";

/** Plage d'adresses réservée à un serveur DHCP — IPAM. */
export class DhcpRange extends Entity {
  network_id: string | null;
  start_ip: string;
  end_ip: string;
  server_id: string | null;

  constructor(p: Props = {}) {
    super(p);
    this.network_id = p.network_id || null;
    this.start_ip = p.start_ip || "";
    this.end_ip = p.end_ip || "";
    this.server_id = p.server_id || null;
  }
}
