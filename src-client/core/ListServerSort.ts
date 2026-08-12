/* =============================================================================
   ListServerSort — « quel champ SERVEUR porte le critère de tri de la vue ? »

   Le maillon CLIENT de la pagination ORDONNÉE complète (lot 1b lazy-load, cf.
   docs/hydratation.md § « Vague 1 ») : en régime pagé, le critère de tri actif
   d'un `ListView` doit se traduire en un CHAMP DU MODÈLE pour que l'ORDER BY
   serveur ordonne le corpus entier. Cette traduction est extraite ici en module
   PUR (testable headless — principe n°7) plutôt qu'enfouie dans la vue.

   La table de correspondance :
   - les critères INTRINSÈQUES de toute liste (`__created__` / `__updated__`)
     → colonnes d'audit `created_date` / `updated_date` — TOUJOURS mappables ;
   - une colonne déclarée avec `sortField` (opt-in, `ListConfigs`) → ce champ.
     Les accesseurs `sort` des colonnes restent des fonctions ARBITRAIRES
     (souvent dérivées : occupation d'une baie, chemin d'un équipement) — seul
     un accesseur qui lit UN champ scalaire du modèle peut déclarer son
     `sortField`, et c'est une déclaration explicite, jamais une déduction ;
   - tout le reste → `null` : REPLI ASSUMÉ du pilote (la page reçue est triée
     côté client, la découpe suit l'ordre serveur par défaut — documenté).

   Le champ candidat est VALIDÉ contre la liste blanche PARTAGÉE
   (`src-shared/ListOrder` — la même que le serveur, principe n°3) : un
   `sortField` mal déclaré DÉGRADE vers le repli au lieu de provoquer un 400 en
   boucle sur chaque page. La direction, elle, suit l'état de la vue telle
   quelle (le clic d'en-tête / le bouton de sens, comme aujourd'hui).
   ============================================================================= */
import { ListOrder } from "../../src-shared/ListOrder";
import type { ListRowServerSort } from "./ListRowEngine";

/** Ce que le mapping a besoin de savoir d'une colonne : sa clé de tri (celle de l'état de la vue,
    `ListView._colKey`) et son éventuel champ serveur déclaré. */
export interface ServerSortColumn { key: string; sortField?: string; }

export class ListServerSort {
  /** Champ SERVEUR du critère de tri `sortKey`, ou `null` si le critère n'est pas mappable (repli
      « trier la page reçue »). Cf. la table de correspondance en tête de fichier. */
  static fieldOf(collection: string, sortKey: string, columns: readonly ServerSortColumn[]): string | null {
    let field: string | null = null;
    if (sortKey === "__created__") field = "created_date";
    else if (sortKey === "__updated__") field = "updated_date";
    else {
      const column = columns.find((c) => c.key === sortKey);
      field = (column && column.sortField) || null;
    }
    // Garde-fou par la MÊME liste blanche que le serveur : ne jamais envoyer un champ qu'il refuserait.
    if (!field || !ListOrder.isSortable(collection, field)) return null;
    return field;
  }

  /** Le tri serveur COMPLET (champ + direction) pour l'état de tri d'une vue, ou `null` (repli). */
  static of(collection: string, sortKey: string, sortDir: "asc" | "desc", columns: readonly ServerSortColumn[]): ListRowServerSort | null {
    const field = ListServerSort.fieldOf(collection, sortKey, columns);
    return field ? { field, dir: sortDir } : null;
  }
}
