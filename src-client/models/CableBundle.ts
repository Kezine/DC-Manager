import { Entity, Props } from "./Entity";
import type { Records } from "../../src-shared/DataValidation";
import { Normalize } from "../core/Normalize";

/** Faisceau / trunk (câble multi-fibres) entre 2 patchs. Porte la route et la
    longueur du tracé ; ses fibres sont piochées par les PORTS des patchs
    d'extrémité (cf. Port.bundle_id / strand_a / strand_b). */
export class CableBundle extends Entity implements Records.CableBundle {
  /** Nom du faisceau (utile sur ~99 % du tracé). */
  name: string;
  /** TYPE de fibre du trunk (FK → cableTypes) — indicatif. */
  cable_type_id: string | null;
  /** Capacité = nombre de brins. */
  fiber_count: number;
  /** ROUTE du trunk (waypoints ordonnés) — porte le tracé 2D/3D. */
  waypoint_ids: string[];
  /** Longueur du trunk (mètres). null = non renseignée. */
  length_m: number | null;
  /** EXTRÉMITÉ A : équipement (typiquement un patch) où le trunk est terminé. null = non rattaché.
      Le faisceau se rattache à 2 patchs (pas à des câbles) et forme un POOL de brins ; ses brins sont
      affectés aux PORTS de ces 2 équipements (cf. Port.bundle_id / strand_a / strand_b). */
  endpoint_a_equipment_id: string | null;
  /** EXTRÉMITÉ B : l'autre équipement de terminaison. null = non rattaché. */
  endpoint_b_equipment_id: string | null;

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.cable_type_id = p.cable_type_id || null;
    this.fiber_count = p.fiber_count ? Math.max(1, p.fiber_count | 0) : 12;
    const wids = Array.isArray(p.waypoint_ids) ? p.waypoint_ids.filter(Boolean) : [];
    this.waypoint_ids = Normalize.uniqIds(wids);
    const L = parseFloat(p.length_m);
    this.length_m = (isFinite(L) && L >= 0) ? L : null;
    this.endpoint_a_equipment_id = p.endpoint_a_equipment_id || null;
    this.endpoint_b_equipment_id = p.endpoint_b_equipment_id || null;
    this.description = p.description || "";
  }
}
