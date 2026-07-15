import { Entity, Props } from "./Entity";
import { Normalize } from "../core/Normalize";
import { CableStatuses } from "../domain/CableStatuses";

/** Câble entre deux ports. Peut porter plusieurs réseaux et des waypoints ordonnés.
    NB : les brins d'un FAISCEAU ne sont pas des câbles — ils sont piochés par les
    PORTS de patch (Port.bundle_id/strand_a/strand_b) ; l'ancien « câble-brin »
    (bundle_id/strand_no ici) a été retiré. */
export class Cable extends Entity {
  /** Nom libre (optionnel). */
  name: string;
  /** FK → cableTypes. */
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

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.cable_type_id = p.cable_type_id || null;
    this.from_port_id = p.from_port_id || null;
    this.to_port_id = p.to_port_id || null;
    const nr = Normalize.networkRefs(p);   // dédup + principal ⊆ ids (mutualisé avec Port — cf. Normalize.networkRefs)
    this.network_ids = nr.network_ids;
    this.network_id = nr.network_id;
    const wids = Array.isArray(p.waypoint_ids) ? p.waypoint_ids.filter(Boolean) : [];
    this.waypoint_ids = Normalize.uniqIds(wids);
    const L = parseFloat(p.length_m);
    this.length_m = (isFinite(L) && L >= 0) ? L : null;
    this.status = CableStatuses.isStatus(p.status) ? p.status : CableStatuses.DEFAULT_LEGACY;
  }
}
