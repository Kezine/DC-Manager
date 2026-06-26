/* Constantes PARTAGÉES avec le client (à garder en phase avec
   src/models/EntityRegistry.ts, src/data/config.ts, src/core/Text.ts). */

// Collections du modèle (= EntityRegistry.COLLECTIONS, même ordre).
export const COLLECTIONS: string[] = [
  "equipments", "ports", "aggregates", "cables", "networks", "groups", "racks",
  "rackItems", "portTypes", "cableTypes", "cableBundles", "datacenters",
  "waypoints", "floors", "ipNetworks", "ipAddresses", "dhcpRanges", "spares", "sites",
];
const COLLECTION_SET = new Set(COLLECTIONS);
export const isCollection = (c: string): boolean => COLLECTION_SET.has(c);

// Champs TABLEAU indexés (where = appartenance) — cf. INDEX_SPEC côté client.
export const ARRAY_FIELDS = new Set<string>(["network_ids", "waypoint_ids"]);

export const PAGE_SIZE_DEFAULT = 25;

/** Normalisation de recherche — parité STRICTE avec Text.normSearch (client). */
export function normSearch(s: unknown): string {
  return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
