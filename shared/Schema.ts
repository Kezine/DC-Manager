/* ============================================================================
   SCHÉMA DES COLLECTIONS — code PARTAGÉ front ⇄ back (TS pur, source de vérité UNIQUE).

   Remplace la double définition historique : `src/models/EntityRegistry.ts` (front) et
   `src-server/src/constants.ts` (back) qui devaient être « gardées en phase » à la main.
   Désormais la LISTE canonique des collections, les champs tableau, la normalisation de
   recherche et la taille de page vivent ICI, et les deux côtés s'y réfèrent.

   Contrainte `shared/` : fichier AUTO-SUFFISANT (aucun import relatif) pour compiler à la
   fois sous le front (résolution bundler) et le serveur (NodeNext, extensions `.js`).
   ============================================================================ */

/** Schéma des données (membres statiques) — l'API serveur et la couche données front en dépendent. */
export class Schema {
  /** Collections du modèle, dans l'ordre canonique (= clés de `EntityRegistry.CLASSES`, vérifié par test d'invariant). */
  static readonly COLLECTIONS: readonly string[] = [
    "equipments", "ports", "aggregates", "cables", "networks", "groups", "racks",
    "rackItems", "portTypes", "cableTypes", "cableBundles", "datacenters",
    "waypoints", "floors", "ipNetworks", "ipAddresses", "dhcpRanges", "spares", "sites",
  ];

  /** Champs de type TABLEAU (un filtre `where` y teste l'APPARTENANCE, pas l'égalité). */
  static readonly ARRAY_FIELDS: ReadonlySet<string> = new Set(["network_ids", "waypoint_ids"]);

  /** Taille de page par défaut des listes paginées. */
  static readonly PAGE_SIZE_DEFAULT = 25;

  private static readonly COLLECTION_SET = new Set(Schema.COLLECTIONS);
  static isCollection(collection: string): boolean { return Schema.COLLECTION_SET.has(collection); }
  static isArrayField(field: string): boolean { return Schema.ARRAY_FIELDS.has(field); }

  /** Normalisation de recherche : minuscules + suppression des accents (NFD puis retrait des diacritiques
      U+0300–U+036F). Doit être IDENTIQUE des deux côtés (le serveur indexe, le client filtre) — d'où le partage. */
  static normSearch(value: unknown): string {
    return String(value == null ? "" : value).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  }
}
