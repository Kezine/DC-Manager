/* ============================================================================
   CASCADE DE SUPPRESSION — code PARTAGÉ front ⇄ back (intégrité référentielle en SUPPRESSION).

   Quand une entité est supprimée, certaines entités liées doivent l'être aussi (delete) et
   d'autres voir leur FK nettoyée (detach). Sans ça, supprimer naïvement (ex. `DELETE /racks/x`)
   laisserait des FK pendantes. Cette logique vit ICI pour être appliquée des DEUX côtés :
     - mode FICHIER : le `Store` l'applique avant d'écrire (cf. Store.remove) ;
     - mode API : le serveur l'applique sur `DELETE` (le serveur devient autorité).

   Capacités INJECTÉES (mêmes que la validation V5b/V6) :
     - `find(collection, field, value)` → enregistrements dont `field` vaut `value` (index/where) ;
     - `fetch(collection, id)` → un enregistrement (pour lire un champ, ex. le nom).
   Contrainte `shared/` : fichier AUTO-SUFFISANT (types de capacités déclarés inline).

   AJOUTER UNE RELATION = AJOUTER UNE ENTRÉE dans `SPEC` (déclaratif), ou un `custom` pour les
   cas non réductibles à une FK simple (multi-réseaux, lanes de breakout, routes de waypoints).
   ============================================================================ */

/** Capacité de recherche par champ (= `RecordFinder` de la validation). */
type Find = (collection: string, field: string, value: string) => Array<Record<string, any>>;
/** Capacité de lecture d'une entité (= `EntityFetcher` de la validation). */
type Fetch = (collection: string, id: string) => Record<string, any> | null;

/** Entité à SUPPRIMER (effet de cascade). */
export interface CascadeDelete { c: string; id: string; }
/** Champ à NETTOYER sur une entité conservée (FK détachée). */
export interface CascadeDetach { c: string; id: string; key: string; value: any; }
/** Plan complet d'une suppression : suppressions enfants + détachements de FK. */
export interface CascadePlan { deletes: CascadeDelete[]; detaches: CascadeDetach[]; }

interface CascadeRule {
  delete?: { coll: string; fk: string }[];
  detach?: { coll: string; fk: string; set?: Record<string, any> }[];
  custom?: (find: Find, fetch: Fetch, id: string, deletes: CascadeDelete[], detaches: CascadeDetach[]) => void;
}

export class Cascade {
  /** Câbles branchés sur un port (extrémité `from` OU `to`), dédupliqués. */
  private static cablesOnPort(find: Find, portId: string): Array<Record<string, any>> {
    const seen = new Set<string>(); const out: Array<Record<string, any>> = [];
    for (const c of [...find("cables", "from_port_id", portId), ...find("cables", "to_port_id", portId)]) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
    return out;
  }
  /** Câbles portant un réseau (principal OU dans `network_ids`), dédupliqués. */
  private static cablesOnNetwork(find: Find, networkId: string): Array<Record<string, any>> {
    const seen = new Set<string>(); const out: Array<Record<string, any>> = [];
    for (const c of [...find("cables", "network_id", networkId), ...find("cables", "network_ids", networkId)]) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); }
    return out;
  }

  /** Retire un ENSEMBLE de waypoints des ROUTES (`waypoint_ids`) des câbles ET faisceaux qui les référencent.
      UN SEUL détachement par câble/faisceau touché, retirant TOUS les ids d'un coup : plusieurs détachements
      sur le même `waypoint_ids` s'ÉCRASERAIENT (Store comme serveur fusionnent par clé — le dernier gagne, chacun
      étant calculé sur la route ORIGINALE) et ne retireraient qu'un seul waypoint. On déduplique donc par câble. */
  private static pruneWaypointsFromRoutes(find: Find, ids: Set<string>, detaches: CascadeDetach[]): void {
    const cables = new Map<string, Record<string, any>>();
    const bundles = new Map<string, Record<string, any>>();
    for (const id of ids) {
      for (const c of find("cables", "waypoint_ids", id)) cables.set(c.id, c);
      for (const b of find("cableBundles", "waypoint_ids", id)) bundles.set(b.id, b);
    }
    for (const c of cables.values()) detaches.push({ c: "cables", id: c.id, key: "waypoint_ids", value: (c.waypoint_ids || []).filter((x: string) => !ids.has(x)) });
    for (const b of bundles.values()) detaches.push({ c: "cableBundles", id: b.id, key: "waypoint_ids", value: (b.waypoint_ids || []).filter((x: string) => !ids.has(x)) });
  }

  /** Règles de cascade par collection supprimée. */
  private static readonly SPEC: Record<string, CascadeRule> = {
    equipments: {
      delete: [{ coll: "ports", fk: "equipment_id" }, { coll: "aggregates", fk: "equipment_id" }],
      detach: [{ coll: "ipAddresses", fk: "equipment_id" }, { coll: "dhcpRanges", fk: "server_id" }],
      custom: (find, fetch, id, deletes, detaches) => {
        const seen = new Set<string>();
        find("ports", "equipment_id", id).forEach((p) => Cascade.cablesOnPort(find, p.id).forEach((c) => { if (!seen.has(c.id)) { seen.add(c.id); deletes.push({ c: "cables", id: c.id }); } }));
        const eq = fetch("equipments", id);
        const name = (eq && eq.name) ? eq.name : "(équipement supprimé)";   // spares : on préserve l'attribution en texte libre
        find("spares", "assigned_equipment_id", id).forEach((sp) => {
          detaches.push({ c: "spares", id: sp.id, key: "assigned_free", value: sp.assigned_free || name });
          detaches.push({ c: "spares", id: sp.id, key: "assigned_equipment_id", value: null });
        });
      },
    },
    ports: {
      custom: (find, _fetch, id, deletes) => {
        Cascade.cablesOnPort(find, id).forEach((c) => deletes.push({ c: "cables", id: c.id }));
        find("ports", "parent_port_id", id).forEach((lane) => {   // lanes de breakout + leurs câbles
          Cascade.cablesOnPort(find, lane.id).forEach((c) => deletes.push({ c: "cables", id: c.id }));
          deletes.push({ c: "ports", id: lane.id });
        });
      },
    },
    aggregates: { detach: [{ coll: "ports", fk: "aggregate_id" }] },
    networks: {
      custom: (find, _fetch, id, _deletes, detaches) => {   // multi-réseaux : retire l'id de network_ids et repointe le principal
        Cascade.cablesOnNetwork(find, id).forEach((c) => {
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
      detach: [{ coll: "equipments", fk: "rack_id", set: { rack_id: null, placement_mode: "manual" } }],
      // Les BROSSES (waypoints kind:"brush") sont MONTÉES dans la baie (`rack_id` obligatoire — invariant T1
      // « une brosse doit être montée dans une baie »). Supprimer la baie DOIT donc les supprimer AUSSI : sinon
      // `rack_id` pend (V2 ref_missing) et l'invariant interdit de simplement le nullifier → document invalide.
      // On nettoie en plus les routes de câbles/faisceaux qui traversaient ces brosses (`waypoint_ids`).
      custom: (find, _fetch, id, deletes, detaches) => {
        const mounted = find("waypoints", "rack_id", id);   // seules les brosses portent `rack_id`
        if (!mounted.length) return;
        for (const w of mounted) deletes.push({ c: "waypoints", id: w.id });
        Cascade.pruneWaypointsFromRoutes(find, new Set(mounted.map((w) => w.id)), detaches);
      },
    },
    portTypes: { detach: [{ coll: "ports", fk: "port_type_id" }] },
    cableTypes: { detach: [{ coll: "cables", fk: "cable_type_id" }, { coll: "cableBundles", fk: "cable_type_id" }] },
    cableBundles: { detach: [{ coll: "cables", fk: "bundle_id", set: { bundle_id: null, strand_no: null } }] },
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
      // retire l'id des routes (waypoint_ids) des câbles ET faisceaux (helper partagé avec la cascade `racks`).
      custom: (find, _fetch, id, _deletes, detaches) => Cascade.pruneWaypointsFromRoutes(find, new Set([id]), detaches),
    },
  };

  /** Calcule le plan de cascade pour supprimer `id` de `collection`. PUR : toutes les résolutions inverses
      passent par `find`/`fetch`. NON récursif — les cas transitifs sont traités explicitement dans les `custom`
      (comportement historique préservé). */
  static plan(collection: string, id: string, find: Find, fetch: Fetch): CascadePlan {
    const deletes: CascadeDelete[] = [];
    const detaches: CascadeDetach[] = [];
    const rule = Cascade.SPEC[collection];
    if (rule) {
      (rule.delete || []).forEach((r) => find(r.coll, r.fk, id).forEach((o) => deletes.push({ c: r.coll, id: o.id })));
      (rule.detach || []).forEach((r) => {
        const set = r.set || { [r.fk]: null };
        find(r.coll, r.fk, id).forEach((o) => Object.keys(set).forEach((k) => detaches.push({ c: r.coll, id: o.id, key: k, value: set[k] })));
      });
      if (rule.custom) rule.custom(find, fetch, id, deletes, detaches);
    }
    return { deletes, detaches };
  }
}
