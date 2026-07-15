import { Entity, Props } from "./Entity";

/** Sous-réseau IPv4 (CIDR) — IPAM. */
export class IpNetwork extends Entity {
  /** Nom lisible (ex. "LAN Prod"). */
  label: string;
  /** Sous-réseau IPv4 « a.b.c.d/n ». */
  cidr: string;
  /** Passerelle par défaut (IPv4, DANS le sous-réseau). null = aucune. */
  gateway: string | null;
  /** Serveurs DNS (IPv4 ordonnés). Peuvent être HORS du sous-réseau (résolveurs externes). */
  dns_servers: string[];
  /** Serveur DHCP de CE réseau (FK → equipments). null = non désigné. Parité avec dhcpRanges.server_id. */
  dhcp_server_id: string | null;

  constructor(p: Props = {}) {
    super(p);
    this.label = p.label || "";
    this.cidr = p.cidr || "";
    this.gateway = (p.gateway && String(p.gateway).trim()) || null;
    this.dns_servers = Array.isArray(p.dns_servers) ? p.dns_servers.filter((x: any) => typeof x === "string" && x.trim()).map((x: string) => x.trim()) : [];
    this.dhcp_server_id = p.dhcp_server_id || null;
  }
}
