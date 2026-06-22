import { Entity, Props } from "./Entity";
import { RackItemKinds } from "../domain/RackItemKinds";

/** Pseudo-équipement monté en rack (Blanking Plate / Tray / KeepBlank). */
export class RackItem extends Entity {
  /** FK → racks (la baie hôte). */
  rack_id: string | null;
  /** U de bas. null = non placé. */
  u: number | null;
  /** Hauteur en U. */
  u_height: number;
  /** Face occupée : "front" | "rear". */
  side: string;
  /** Toujours "none" (pseudo-équipement no-depth : n'occupe que son côté). */
  depth: string;
  /** Type : "blank" (Blanking Plate) | "tray" | "keepblank". */
  kind: string;
  /** Libellé libre (sinon = libellé du type). */
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
