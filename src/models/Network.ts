import { Entity, Props } from "./Entity";

/** Réseau logique (couleur de câble). Data (VLAN) ou Power (circuit). */
export class Network extends Entity {
  label: string;
  color: string | null;
  kind: string;
  voltage: number | null;
  max_amp: number | null;
  power_source: string | null;
  ip_network_id: string | null;

  constructor(p: Props = {}) {
    super(p);
    this.label = p.label || "";
    this.color = p.color || null;
    this.kind = (p.kind === "power") ? "power" : "data";
    this.voltage = (p.voltage != null && p.voltage !== "") ? Math.max(0, +p.voltage || 0) : null;
    this.max_amp = (p.max_amp != null && p.max_amp !== "") ? Math.max(0, +p.max_amp || 0) : null;
    this.power_source = ["ups", "ups_gen", "grid"].includes(p.power_source) ? p.power_source : null;
    this.ip_network_id = (this.kind === "power") ? null : (p.ip_network_id || null);
  }
}
