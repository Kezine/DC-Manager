import { Entity, Props } from "./Entity";
import { Normalize } from "../core/Normalize";
import { CableStatuses } from "../domain/CableStatuses";

/** Câble entre deux ports. Peut porter plusieurs réseaux, des waypoints
    ordonnés, et être un brin d'un faisceau (bundle). */
export class Cable extends Entity {
  name: string;
  cable_type_id: string | null;
  from_port_id: string | null;
  to_port_id: string | null;
  network_ids: string[];
  network_id: string | null;
  waypoint_ids: string[];
  length_m: number | null;
  status: string;
  bundle_id: string | null;
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
