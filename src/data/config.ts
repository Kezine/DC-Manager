/* Constantes de la couche données (données pures). */

/** Taille de page par défaut des listes. */
export const PAGE_SIZE_DEFAULT = 25;

/** Profondeur max de la pile undo/redo (snapshots). */
export const HISTORY_MAX = 50;

/** Sentinel « valeur vide » des index secondaires. */
export const IDX_NULL = "∅";

/* INDEX SECONDAIRES — champs d'égalité indexés par collection. Spec PARTAGÉ :
   - l'adapter local indexe les ENREGISTREMENTS persistés (findBy/list sans scan) ;
   - le Store indexera les ENTITÉS hydratées (helpers métier en O(1)).
   Un champ tableau (ex. cables.network_ids) est indexé élément par élément ;
   les valeurs vides tombent sous IDX_NULL → findBy(coll, champ, null) répond
   « éléments non rattachés » sans parcourir la collection. */
export const INDEX_SPEC: Record<string, string[]> = {
  equipments: ["group_id", "rack_id", "dc_id", "face_image_id", "face_image_rear_id", "face_image_top_id", "face_image_bottom_id", "face_image_left_id", "face_image_right_id"],
  ports:       ["equipment_id", "parent_port_id", "port_type_id", "aggregate_id"],
  cables:      ["from_port_id", "to_port_id", "cable_type_id", "network_id", "network_ids", "waypoint_ids", "bundle_id"],
  cableBundles: ["cable_type_id", "waypoint_ids"],
  aggregates:  ["equipment_id"],
  racks:       ["datacenter_id"],
  rackItems:   ["rack_id"],
  waypoints:   ["datacenter_id"],
  floors:      ["location"],
  ipAddresses: ["network_id", "equipment_id", "address"],
  dhcpRanges:  ["network_id", "server_id"],
  networks:    ["ip_network_id"],
};
