import { Entity, Props } from "./Entity";
import { Normalize } from "../core/Normalize";

/** Faisceau / trunk (câble multi-fibres). Porte la route et la longueur
    partagées, héritées par ses brins (cf. Cable.bundle_id / strand_no). */
export class CableBundle extends Entity {
  /** Nom du faisceau (utile sur ~99 % du tracé). */
  name: string;
  /** TYPE du trunk (FK → cableTypes) — VERROUILLE le type de ses brins. */
  cable_type_id: string | null;
  /** Capacité = nombre de brins. */
  fiber_count: number;
  /** ROUTE partagée (waypoints ordonnés) — héritée par les brins. */
  waypoint_ids: string[];
  /** Longueur partagée (mètres). null = non renseignée. */
  length_m: number | null;

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.cable_type_id = p.cable_type_id || null;
    this.fiber_count = p.fiber_count ? Math.max(1, p.fiber_count | 0) : 12;
    const wids = Array.isArray(p.waypoint_ids) ? p.waypoint_ids.filter(Boolean) : [];
    this.waypoint_ids = Normalize.uniqIds(wids);
    const L = parseFloat(p.length_m);
    this.length_m = (isFinite(L) && L >= 0) ? L : null;
    this.description = p.description || "";
  }
}
