/* Spec DÉCLARATIF de la cascade de suppression (intégrité référentielle),
   interprété par Store._cascadePlan. Pour la collection supprimée :
     delete : [{coll, fk}]        → SUPPRIME les `coll` dont coll[fk] === id
     detach : [{coll, fk, set?}]  → pour les `coll` dont coll[fk] === id, applique
                                    `set` (défaut {[fk]: null} ; plusieurs clés possibles)
     custom : (store, id, deletes, detaches) → cas non réductibles à un FK simple
   Toutes les résolutions inverses passent par les index secondaires (store._byFk).
   AJOUTER UNE RELATION = AJOUTER UNE ENTRÉE ici (plus de if/else à éditer). */

export interface CascadeDelete { c: string; id: string; }
export interface CascadeDetach { c: string; id: string; key: string; value: any; }

/** API minimale du Store dont dépendent les résolutions `custom` (évite un import
    circulaire de la classe Store ; couplage structurel seulement). */
export interface CascadeStoreApi {
  _byFk(collection: string, field: string, value: any): any[];
  get(collection: string, id: string): any;
  cablesOfPort(portId: string): any[];
  cablesOfNetwork(networkId: string): any[];
  cablesOfWaypoint(waypointId: string): any[];
}

export interface CascadeRule {
  delete?: { coll: string; fk: string }[];
  detach?: { coll: string; fk: string; set?: Record<string, any> }[];
  custom?: (store: CascadeStoreApi, id: string, deletes: CascadeDelete[], detaches: CascadeDetach[]) => void;
}

export const CASCADE_SPEC: Record<string, CascadeRule> = {
  equipments: {
    delete: [{ coll: "ports", fk: "equipment_id" }, { coll: "aggregates", fk: "equipment_id" }],
    // détache les attributions IP (l'IP reste au registre) et le rôle de serveur DHCP
    detach: [{ coll: "ipAddresses", fk: "equipment_id" }, { coll: "dhcpRanges", fk: "server_id" }],
    // câbles branchés sur les ports supprimés (dédup si les 2 bouts sont sur l'équipement)
    custom: (s, id, deletes, detaches) => {
      const seen = new Set<string>();
      s._byFk("ports", "equipment_id", id).forEach((p) => s.cablesOfPort(p.id).forEach((c) => { if (!seen.has(c.id)) { seen.add(c.id); deletes.push({ c: "cables", id: c.id }); } }));
      // spares attribués à cet équipement → on PRÉSERVE l'info en la basculant en attribution libre (le nom de l'équipement)
      const eq = s.get("equipments", id);
      const nm = (eq && eq.name) ? eq.name : "(équipement supprimé)";
      s._byFk("spares", "assigned_equipment_id", id).forEach((sp) => {
        detaches.push({ c: "spares", id: sp.id, key: "assigned_free", value: sp.assigned_free || nm });
        detaches.push({ c: "spares", id: sp.id, key: "assigned_equipment_id", value: null });
      });
    },
  },
  ports: {
    // câble du port + lanes de breakout (parent_port_id) avec leurs câbles
    custom: (s, id, deletes) => {
      s.cablesOfPort(id).forEach((c) => deletes.push({ c: "cables", id: c.id }));
      s._byFk("ports", "parent_port_id", id).forEach((lane) => {
        s.cablesOfPort(lane.id).forEach((c) => deletes.push({ c: "cables", id: c.id }));
        deletes.push({ c: "ports", id: lane.id });
      });
    },
  },
  aggregates: { detach: [{ coll: "ports", fk: "aggregate_id" }] },
  networks: {
    // multi-réseaux : retire l'id de network_ids et repointe le réseau principal
    custom: (s, id, _deletes, detaches) => {
      s.cablesOfNetwork(id).forEach((c) => {
        const ids = Array.isArray(c.network_ids) ? c.network_ids : (c.network_id ? [c.network_id] : []);
        if (!ids.includes(id)) return;
        const nids = ids.filter((x: string) => x !== id);
        detaches.push({ c: "cables", id: c.id, key: "network_ids", value: nids });
        const prim = (c.network_id === id) ? (nids.length ? nids[0] : null) : c.network_id;
        detaches.push({ c: "cables", id: c.id, key: "network_id", value: prim });
      });
    },
  },
  groups: { detach: [{ coll: "equipments", fk: "group_id" }] },
  racks: {
    delete: [{ coll: "rackItems", fk: "rack_id" }],
    // équipements placés dans la baie → retour en mode manuel, non placés
    detach: [{ coll: "equipments", fk: "rack_id", set: { rack_id: null, placement_mode: "manual" } }],
  },
  portTypes: { detach: [{ coll: "ports", fk: "port_type_id" }] },
  cableTypes: { detach: [{ coll: "cables", fk: "cable_type_id" }, { coll: "cableBundles", fk: "cable_type_id" }] },
  cableBundles: {
    // les brins redeviennent des câbles autonomes
    detach: [{ coll: "cables", fk: "bundle_id", set: { bundle_id: null, strand_no: null } }],
  },
  datacenters: {
    detach: [
      { coll: "racks", fk: "datacenter_id", set: { datacenter_id: null, dc_x: null, dc_y: null } },
      { coll: "equipments", fk: "dc_id", set: { dc_id: null, dc_x: null, dc_y: null, dc_z: 0 } },
      { coll: "waypoints", fk: "datacenter_id", set: { datacenter_id: null, dc_x: null, dc_y: null, dc_x2: null, dc_y2: null } },
    ],
  },
  ipNetworks: {
    delete: [{ coll: "ipAddresses", fk: "network_id" }, { coll: "dhcpRanges", fk: "network_id" }],
    detach: [{ coll: "networks", fk: "ip_network_id" }],
  },
  waypoints: {
    // retire l'id des routes (waypoint_ids) des câbles ET des faisceaux
    custom: (s, id, _deletes, detaches) => {
      s.cablesOfWaypoint(id).forEach((c) => detaches.push({ c: "cables", id: c.id, key: "waypoint_ids", value: (c.waypoint_ids || []).filter((x: string) => x !== id) }));
      s._byFk("cableBundles", "waypoint_ids", id).forEach((b) => detaches.push({ c: "cableBundles", id: b.id, key: "waypoint_ids", value: (b.waypoint_ids || []).filter((x: string) => x !== id) }));
    },
  },
};
