import { Entity, Props } from "./Entity";
import { Normalize } from "../core/Normalize";
import { CableStatuses } from "../domain/CableStatuses";

/** Câble entre deux ports. Peut porter plusieurs réseaux, des waypoints
    ordonnés, et être un brin d'un faisceau (bundle). */
export class Cable extends Entity {
  /** Nom libre (optionnel). */
  name: string;
  /** FK → cableTypes. Verrouillé au type du faisceau si le câble est un brin. */
  cable_type_id: string | null;
  /** FK → ports : extrémité A. */
  from_port_id: string | null;
  /** FK → ports : extrémité B. */
  to_port_id: string | null;
  /** TOUS les réseaux portés (ex. plusieurs VLAN). `network_id` ⊆ `network_ids`. */
  network_ids: string[];
  /** Réseau PRINCIPAL (miroir de `network_ids`) — pilote la couleur partout. null = aucun. */
  network_id: string | null;
  /** Waypoints traversés, ORDONNÉS le long du trajet A→B. */
  waypoint_ids: string[];
  /** Longueur physique (mètres). null = non renseignée. */
  length_m: number | null;
  /** Statut du cycle de vie (slug ∈ CABLE_STATUSES) : brouillon → planifié → câblé → … */
  status: string;
  /** FK → cableBundles : si rattaché à un trunk, le câble est un BRIN (type/route/longueur hérités). null = autonome. */
  bundle_id: string | null;
  /** N° de fibre/brin dans le faisceau. null = non-brin. */
  strand_no: number | null;

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.cable_type_id = p.cable_type_id || null;
    this.from_port_id = p.from_port_id || null;
    this.to_port_id = p.to_port_id || null;
    let nids = Array.isArray(p.network_ids) ? p.network_ids.filter(Boolean) : (p.network_id ? [p.network_id] : []);
    nids = Normalize.uniqIds(nids);
    this.network_ids = nids;
    let primary = p.network_id || null;
    if (primary && !nids.includes(primary)) primary = null;
    if (!primary && nids.length) primary = nids[0];
    this.network_id = primary;
    const wids = Array.isArray(p.waypoint_ids) ? p.waypoint_ids.filter(Boolean) : [];
    this.waypoint_ids = Normalize.uniqIds(wids);
    const L = parseFloat(p.length_m);
    this.length_m = (isFinite(L) && L >= 0) ? L : null;
    this.status = CableStatuses.isStatus(p.status) ? p.status : CableStatuses.DEFAULT_LEGACY;
    this.bundle_id = p.bundle_id || null;
    this.strand_no = (p.strand_no != null) ? Math.max(1, p.strand_no | 0) : null;
  }
}
