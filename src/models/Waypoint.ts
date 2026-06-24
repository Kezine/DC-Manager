import { Entity, Props } from "./Entity";
import {
  WAYPOINT_Z_DEFAULT,
  CONDUIT_W_DEFAULT,
  CONDUIT_H_DEFAULT,
  OOB_HEIGHT_DEFAULT,
} from "../domain/constants";

/** Point de passage de câbles. Trois formes (kind : point | segment | brush)
    et trois types (wp_type : datacenter | exit | oob). */
export class Waypoint extends Entity {
  /** Nom libre. */
  name: string;
  /** Forme : "point" (pin) | "segment" (rail/chemin de câbles) | "brush" (brosse, contrainte à un rack). */
  kind: string;
  /** Brush / pin de marge/capot : baie hôte (FK → racks). */
  rack_id: string | null;
  /** Brush : U de départ (bas). */
  rack_u: number;
  /** Brush : hauteur en U. */
  u_height: number;
  /** Brush : profondeur de passage (mm). */
  depth_mm: number;
  /** Pin monté en marge latérale : face av/ar. null = pas un pin de marge. */
  side_face: string | null;
  /** Pin de marge : côté "left" | "right". null = pin libre. */
  side_lr: string | null;
  /** Pin de marge : colonne (0 | 1). */
  side_col: number | null;
  /** Pin de marge : U. */
  side_u: number | null;
  /** Pin monté sur un CAPOT : "roof" | "floor". null = pas un pin de capot. */
  cap_face: string | null;
  /** Pin de capot : index de cellule X. */
  cap_cx: number | null;
  /** Pin de capot : index de cellule Y. */
  cap_cy: number | null;
  /** Type : "datacenter" (interne salle) | "exit" (sortie/entrée, par paires) | "oob" (hors salles, gaine bâtiment). */
  wp_type: string;
  /** FK → datacenters. null = pool (non posé). Toujours null pour un OOB. */
  datacenter_id: string | null;
  /** Pin : position X (mm) ; segment : 1re extrémité X. */
  dc_x: number | null;
  /** Pin : position Y (mm) ; segment : 1re extrémité Y. */
  dc_y: number | null;
  /** Segment : 2e extrémité X (mm). null pour un pin. */
  dc_x2: number | null;
  /** Segment : 2e extrémité Y (mm). */
  dc_y2: number | null;
  /** Hauteur (mm) — NÉGATIF autorisé (sous-plancher) ; pour un OOB = sa hauteur (≥ 0). */
  dc_z: number;
  /** Segment : largeur de section du conduit (mm). */
  width_mm: number;
  /** Segment : hauteur de section du conduit (mm). */
  height_mm: number;
  /** Pin : rayon de répartition des câbles (mm). */
  radius: number;
  /** Pin : répartition activée ? */
  spread: boolean;
  /** OOB : étage ("" = 0). */
  floor: string;
  /** OOB : bâtiment (slug ∈ LOCATIONS) — rattache l'OOB à un plan d'étage. */
  location: string;
  /** OOB localisé : position X sur le plan d'étage (mm). null = centré. */
  floor_x: number | null;
  /** OOB localisé : position Y sur le plan d'étage (mm). */
  floor_y: number | null;

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.kind = (p.kind === "segment") ? "segment" : (p.kind === "brush") ? "brush" : "point";
    this.rack_id = p.rack_id || null;
    this.rack_u = (p.rack_u != null) ? Math.max(1, p.rack_u | 0) : 1;
    this.u_height = (p.u_height != null) ? Math.max(1, p.u_height | 0) : 1;
    this.depth_mm = (p.depth_mm != null) ? Math.max(1, +p.depth_mm) : 100;
    this.side_face = (p.side_face === "rear") ? "rear" : (p.side_face === "front" ? "front" : null);
    this.side_lr = (p.side_lr === "left" || p.side_lr === "right") ? p.side_lr : null;
    this.side_col = (p.side_col === 1) ? 1 : (p.side_col === 0 ? 0 : null);
    this.side_u = (p.side_u != null) ? Math.max(1, p.side_u | 0) : null;
    this.cap_face = (p.cap_face === "roof" || p.cap_face === "floor") ? p.cap_face : null;
    this.cap_cx = (p.cap_cx != null) ? (p.cap_cx | 0) : null;
    this.cap_cy = (p.cap_cy != null) ? (p.cap_cy | 0) : null;
    // FUSION OOB→PIN : le type « oob » est SUPPRIMÉ. Un ex-OOB devient un pin d'ÉTAGE (hors salle, rattaché à un
    // bâtiment/étage). Migration : `wp_type:"oob"` (anciennes données) → `"datacenter"` + placement d'étage conservé.
    const wasOob = p.wp_type === "oob";
    this.wp_type = (p.wp_type === "exit") ? "exit" : "datacenter";
    this.datacenter_id = p.datacenter_id || null;
    this.dc_x = (p.dc_x != null) ? +p.dc_x : null;
    this.dc_y = (p.dc_y != null) ? +p.dc_y : null;
    this.dc_x2 = (p.dc_x2 != null) ? +p.dc_x2 : null;
    this.dc_y2 = (p.dc_y2 != null) ? +p.dc_y2 : null;
    this.dc_z = (p.dc_z != null) ? +p.dc_z : WAYPOINT_Z_DEFAULT;
    this.width_mm = (p.width_mm != null) ? Math.max(0, +p.width_mm) : CONDUIT_W_DEFAULT;
    this.height_mm = (p.height_mm != null) ? Math.max(0, +p.height_mm) : CONDUIT_H_DEFAULT;
    this.radius = (p.radius != null) ? Math.max(0, +p.radius) : 0;
    this.spread = p.spread === true;
    this.floor = p.floor != null ? String(p.floor) : "";
    this.location = p.location || "";
    this.floor_x = (p.floor_x != null) ? +p.floor_x : null;
    this.floor_y = (p.floor_y != null) ? +p.floor_y : null;
    // PIN D'ÉTAGE (ex-OOB) : pin (forme « point ») hors salle, rattaché à un bâtiment/étage. Détecté par l'absence
    // de salle + la présence d'un placement d'étage (location/floor/floor_x) ; ou par la migration `wasOob`.
    const floorLevel = this.wp_type !== "exit" && !this.datacenter_id
      && (wasOob || (this.kind === "point" && (this.location !== "" || (this.floor !== "" ) || this.floor_x != null)));
    if (floorLevel) {
      this.kind = "point"; this.datacenter_id = null;
      this.dc_x = null; this.dc_y = null; this.dc_x2 = null; this.dc_y2 = null;
      this.dc_z = (p.dc_z != null) ? Math.max(0, +p.dc_z) : OOB_HEIGHT_DEFAULT;
    } else {
      this.floor_x = null; this.floor_y = null;
    }
  }

  /** Type normalisé d'un waypoint ("datacenter" | "exit"). Le type « oob » est FUSIONNÉ dans pin (cf. `isFloorLevel`). */
  static typeOf(wp: any): string { return (wp && wp.wp_type === "exit") ? "exit" : "datacenter"; }

  /** Un PIN D'ÉTAGE (ex-OOB) : pin hors salle rattaché à un bâtiment/étage (jamais posé dans une salle). */
  static isFloorLevel(wp: any): boolean {
    return !!wp && wp.kind === "point" && wp.wp_type !== "exit" && !wp.datacenter_id
      && (!!wp.location || (wp.floor != null && String(wp.floor) !== "") || wp.floor_x != null);
  }

  /** Glyphe d'affichage selon type/forme (⏏ exit · ◎ pin d'étage · ▦ brosse · ▬ chemin · ◆ pin de salle). */
  static glyph(wp: any): string {
    if (Waypoint.typeOf(wp) === "exit") return "⏏";
    if (Waypoint.isFloorLevel(wp)) return "◎";
    if (wp.kind === "brush") return "▦";
    return wp.kind === "segment" ? "▬" : "◆";
  }

  /** Libellé d'étage d'un pin d'étage ("ét. N", étage vide/libre → niveau 0). */
  static floorLabel(wp: any): string { const n = parseFloat(wp && wp.floor); return "ét. " + (isFinite(n) ? n : 0); }
}
