import { Entity, Props } from "./Entity";

/** Sous-réseau IPv4 (CIDR) — IPAM. */
export class IpNetwork extends Entity {
  /** Nom lisible (ex. "LAN Prod"). */
  label: string;
  /** Sous-réseau IPv4 « a.b.c.d/n ». */
  cidr: string;

  constructor(p: Props = {}) {
    super(p);
    this.label = p.label || "";
    this.cidr = p.cidr || "";
  }
}
