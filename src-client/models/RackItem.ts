import { Entity, Props } from "./Entity";
import { RackItemKinds } from "../domain/RackItemKinds";

/** Pseudo-équipement monté en rack (Blanking Plate / Tray / KeepBlank). */
export class RackItem extends Entity {
  /** FK → racks (la baie hôte). */
  rack_id: string | null;
  /** U de bas. null = non placé. */
  u: number | null;
  /** Hauteur en U. Pour un TRAY : hauteur totale RÉSERVÉE (structure + espace utile au-dessus du plateau). */
  u_height: number;
  /** Face occupée : "front" | "rear". */
  side: string;
  /** Toujours "none" (pseudo-équipement no-depth : n'occupe que son côté). */
  depth: string;
  /** Type : "blank" (Blanking Plate) | "tray" | "keepblank". */
  kind: string;
  /** Libellé libre (sinon = libellé du type). */
  label: string;
  /* ---- configuration TRAY (étagère — sans effet pour les autres kinds) ---- */
  /** Variante : "dual" (posée avant + arrière, pleine cage) | "cantilever" (porte-à-faux à renforts triangulaires). */
  tray_type: string;
  /** Hauteur (U) de la STRUCTURE elle-même — le plateau est en HAUT, accroches/renforts dessous. Défaut 1. */
  tray_u: number;
  /** Porte-à-faux : LONGUEUR du plateau (mm). null = défaut (TRAY_DEPTH_DEFAULT_MM) ; ignorée en "dual". */
  depth_mm: number | null;

  constructor(p: Props = {}) {
    super(p);
    this.rack_id = p.rack_id || null;
    this.u = (p.u != null) ? (p.u | 0) : null;
    this.u_height = p.u_height ? Math.max(1, p.u_height | 0) : 1;
    this.side = (p.side === "rear") ? "rear" : "front";
    this.depth = "none";
    this.kind = RackItemKinds.has(p.kind) ? p.kind : "blank";
    this.label = p.label || "";
    this.tray_type = (p.tray_type === "cantilever") ? "cantilever" : "dual";
    this.tray_u = p.tray_u ? Math.max(1, p.tray_u | 0) : 1;
    this.depth_mm = (p.depth_mm != null && p.depth_mm !== "") ? Math.max(1, +p.depth_mm | 0) : null;
  }
}
