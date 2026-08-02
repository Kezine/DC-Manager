/* Constantes de la couche données (données pures). */
import { Schema } from "../../src-shared/Schema";

/** Taille de page par défaut des listes. RÉ-EXPORTÉE du schéma PARTAGÉ (source unique front ⇄ back). */
export const PAGE_SIZE_DEFAULT = Schema.PAGE_SIZE_DEFAULT;

/** Taille de page « TOUT » (document complet en une page). RÉ-EXPORTÉE du schéma PARTAGÉ. */
export const PAGE_SIZE_ALL = Schema.PAGE_SIZE_ALL;

/** Tailles de page proposées dans les listes. */
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

/** Profondeur max de la pile undo/redo (snapshots). */
export const HISTORY_MAX = 50;

/** Sentinel « valeur vide » des index secondaires. */
export const IDX_NULL = "∅";

/* INDEX SECONDAIRES — champs d'égalité indexés par collection. La liste vit désormais dans le module
   PARTAGÉ `src-shared/RelationalSchema` (SOURCE UNIQUE front ⇄ back : le générateur de DDL relationnel en
   dérive les CREATE INDEX serveur, le client la RÉ-EXPORTE ici). Même pattern que `Schema` / `RackConstants`.
   Consommée côté client par `FieldIndex` : l'adapter local indexe les enregistrements persistés (findBy/list
   sans scan) et le Store indexe les entités hydratées (helpers métier en O(1)) ; un champ NON listé retombe
   en scan (`Store._byFk`), jamais en erreur. Un champ tableau (ex. cables.network_ids) est indexé élément par
   élément ; les valeurs vides tombent sous IDX_NULL → findBy(coll, champ, null) répond « éléments non
   rattachés » sans parcourir la collection.
   ⚠ Contenu révisé à la remontée (mesure L0 §3.4) : + equipments.name / cables.name (scans d'unicité V6g/V6h,
   accélérés aussi côté client en mode fichier) ; − les 6 face_image_*_id et cableBundles.cable_type_id (index
   morts, jamais interrogés). Import SANS extension (résolution bundler du front). */
export { INDEX_SPEC } from "../../src-shared/RelationalSchema";
