/* ============================================================================
   SCHÉMA DES COLLECTIONS — code PARTAGÉ front ⇄ back (TS pur, source de vérité UNIQUE).

   Remplace la double définition historique : `src/models/EntityRegistry.ts` (front) et
   `src-server/src/constants.ts` (back) qui devaient être « gardées en phase » à la main.
   Désormais la LISTE canonique des collections, les champs tableau, la normalisation de
   recherche et la taille de page vivent ICI, et les deux côtés s'y réfèrent.

   Portée `shared/` : TS PUR (ni DOM ni Node), compilé des DEUX côtés — front (résolution
   *bundler*) et serveur (NodeNext). Ce fichier n'importe rien : c'est un CONSTAT, plus une
   contrainte. L'auto-suffisance de `src-shared/` est LEVÉE (cf. `CLAUDE.md` § « Code partagé
   front/back ») — un import relatif vers un autre fichier partagé est AUTORISÉ, à une
   condition IMPÉRATIVE : écrire le spécificateur avec l'extension `.js`
   (`import { X } from "./Foo.js"` pour un fichier `Foo.ts`). NodeNext l'EXIGE côté serveur ;
   l'omettre compile côté front puis CASSE le build serveur.
   ⚠ Donc : ne JAMAIS dupliquer ici une règle qui vit déjà dans un autre fichier partagé au
   motif de « rester auto-suffisant » — c'est exactement la dette que les lots de
   déduplication (`TrayGeometry`, `RackDepthPolicy`) ont eu à résorber.
   ============================================================================ */

/** Schéma des données (membres statiques) — l'API serveur et la couche données front en dépendent. */
export class Schema {
  /** Collections du modèle, dans l'ordre canonique (= clés de `EntityRegistry.CLASSES`, vérifié par test d'invariant). */
  static readonly COLLECTIONS: readonly string[] = [
    "equipments", "ports", "aggregates", "subEquipments", "cables", "networks", "groups", "racks",
    "rackItems", "portTypes", "cableTypes", "cableBundles", "datacenters",
    "waypoints", "floors", "ipNetworks", "ipAddresses", "dhcpRanges", "spares", "sites", "vms", "wifiClients", "contacts",
  ];

  /** Champs de type TABLEAU (un filtre `where` y teste l'APPARTENANCE, pas l'égalité). `tags_src` = étiquettes
      Proxmox d'une VM (scalaires filtrables) ; `nics` (tableau d'OBJETS) n'y a PAS sa place (mécanisme scalaire). */
  static readonly ARRAY_FIELDS: ReadonlySet<string> = new Set(["network_ids", "waypoint_ids", "group_ids", "dns_servers", "tags_src"]);

  /** Champs d'ÉQUIPEMENT référençant une image de façade (bibliothèque HORS modèle). Source UNIQUE front ⇄ back :
      le serveur s'en sert pour la PURGE des images orphelines (maintenance) ; le front garde sa carte face → champ
      (EQUIP_FACE_IMG_FIELD — test anti-divergence). */
  static readonly EQUIPMENT_FACE_IMAGE_FIELDS: readonly string[] = [
    "face_image_id", "face_image_rear_id", "face_image_top_id", "face_image_bottom_id", "face_image_left_id", "face_image_right_id",
  ];

  /** Taille de page par défaut des listes paginées. */
  static readonly PAGE_SIZE_DEFAULT = 25;

  /** Taille de page « TOUT » : le client charge le DOCUMENT COMPLET (snapshot, listes de FK) en une page.
      DÉCISION (audit P5) : pas de plafond serveur — l'outil est mono-document par requête, derrière SSO,
      et le chargement complet est le mode de fonctionnement NORMAL du front (pas un abus à limiter). */
  static readonly PAGE_SIZE_ALL = 1_000_000_000;

  /** Types MIME d'images acceptés (façades d'équipements/baies) — liste UNIQUE front ⇄ serveur.
      Le front filtre à la sélection de fichier ; le serveur REJETTE tout autre type à l'upload, car le blob
      est resservi avec son Content-Type stocké (un `text/html` ou `image/svg+xml` scripté deviendrait un
      XSS stocké servi par l'origine de l'app). */
  static readonly IMAGE_MIME_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp"];
  static isImageMime(type: unknown): boolean { return Schema.IMAGE_MIME_TYPES.includes(String(type || "")); }

  private static readonly COLLECTION_SET = new Set(Schema.COLLECTIONS);
  static isCollection(collection: string): boolean { return Schema.COLLECTION_SET.has(collection); }
  static isArrayField(field: string): boolean { return Schema.ARRAY_FIELDS.has(field); }

  /** Normalisation de recherche : minuscules + suppression des accents (NFD puis retrait des diacritiques
      U+0300–U+036F). Doit être IDENTIQUE des deux côtés (le serveur indexe, le client filtre) — d'où le partage. */
  static normSearch(value: unknown): string {
    return String(value == null ? "" : value).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  }
}
