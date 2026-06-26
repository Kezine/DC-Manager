/* Schéma PARTAGÉ avec le client (à garder en phase avec src/models/EntityRegistry.ts,
   src/data/config.ts, src/core/Text.ts). Classe utilitaire (membres statiques). */
export class Schema {
  // Collections du modèle (= EntityRegistry.COLLECTIONS, même ordre).
  static readonly COLLECTIONS: readonly string[] = [
    "equipments", "ports", "aggregates", "cables", "networks", "groups", "racks",
    "rackItems", "portTypes", "cableTypes", "cableBundles", "datacenters",
    "waypoints", "floors", "ipNetworks", "ipAddresses", "dhcpRanges", "spares", "sites",
  ];
  // Champs TABLEAU indexés (where = appartenance) — cf. INDEX_SPEC côté client.
  static readonly ARRAY_FIELDS: ReadonlySet<string> = new Set(["network_ids", "waypoint_ids"]);
  static readonly PAGE_SIZE_DEFAULT = 25;

  private static readonly COLLECTION_SET = new Set(Schema.COLLECTIONS);
  static isCollection(c: string): boolean { return Schema.COLLECTION_SET.has(c); }
  static isArrayField(f: string): boolean { return Schema.ARRAY_FIELDS.has(f); }

  /** Normalisation de recherche — parité STRICTE avec Text.normSearch (client). */
  static normSearch(s: unknown): string {
    return String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  }
}
