import { Entity, Props } from "./Entity";
import { RackItemKinds } from "../domain/RackItemKinds";

/** Pseudo-équipement monté en rack (Blanking Plate / Tray / KeepBlank). */
export class RackItem extends Entity {
  rack_id: string | null;
  u: number | null;
  u_height: number;
  side: string;
  depth: string;
  kind: string;
  label: string;

  constructor(p: Props = {}) {
    super(p);
    this.rack_id = p.rack_id || null;
    this.u = (p.u != null) ? (p.u | 0) : null;
    this.u_height = p.u_height ? Math.max(1, p.u_height | 0) : 1;
    this.side = (p.side === "rear") ? "rear" : "front";
    this.depth = "none";
    this.kind = RackItemKinds.has(p.kind) ? p.kind : "blank";
    this.label = p.label || "";
  }
}
