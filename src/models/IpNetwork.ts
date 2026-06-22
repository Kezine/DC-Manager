import { Entity, Props } from "./Entity";

/** Sous-réseau IPv4 (CIDR) — IPAM. */
export class IpNetwork extends Entity {
  label: string;
  cidr: string;

  constructor(p: Props = {}) {
    super(p);
    this.label = p.label || "";
    this.cidr = p.cidr || "";
  }
}
