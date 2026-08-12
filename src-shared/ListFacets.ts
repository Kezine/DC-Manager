/* ============================================================================
   FACETTES DE LISTING — valeurs DISTINCTES d'une colonne. Code PARTAGÉ front ⇄
   back (TS PUR), jumeau de `ListOrder` et pour exactement la même raison.

   POURQUOI CE MODULE (garde G8 du chantier lazy-load, vague 3 — arbitrage
   utilisateur n°4, cf. docs/hydratation.md). Les filtres d'énumération d'un
   listing (« Type », « SSID ») construisent leurs options en balayant
   `store.all(collection)`. Sur une collection chargée PARESSEUSEMENT, ce
   balayage ne voit que les pages déjà parcourues : la facette ne propose alors
   que les valeurs VUES. Pour une petite collection c'est un écart acceptable
   (vague 1, contacts) ; pour une collection VOLUMINEUSE alimentée par une
   synchro, ça n'a plus de sens — la vérité est un `SELECT DISTINCT` serveur.

   Ce module porte les DEUX faces de ce contrat, d'où son emplacement partagé
   (principe n°3) :

   - la LISTE BLANCHE des colonnes facettables, DÉRIVÉE de la spec déclarative
     (`DataValidation.COLLECTION_SPECS`) — jamais écrite à la main. Le CLIENT la
     consulte (un `ListColumn.filter.field` fautif doit DÉGRADER vers les options
     locales, pas provoquer un 400 en boucle) ; le SERVEUR valide contre la MÊME
     liste (route → 400, dépôt → throw). Une seule source, aucune divergence ;
   - le `SELECT DISTINCT` lui-même (chaîne SQL, exécutée par le dépôt) — le
     serveur n'interpole JAMAIS un nom de colonne venu du client sans passer
     ici : la liste blanche EST la barrière anti-injection, et `distinctSql`
     REFUSE (throw) tout nom hors liste plutôt que de l'ignorer en silence.

   ── Ce qui est FACETTABLE, et pourquoi ────────────────────────────────────
   Les seules colonnes de spec de type `string`. Une facette est une ÉNUMÉRATION
   de valeurs proposées à la sélection : elle n'a de sens que si le nombre de
   valeurs distinctes est petit devant le nombre de lignes. Sont donc EXCLUS —
   et c'est un choix SÉMANTIQUE, pas seulement une précaution :
   - `number` (une taille en octets a autant de valeurs que de lignes) ;
   - `boolean` (deux cases à cocher « vrai »/« faux » n'apprennent rien qu'une
     colonne triable ne dise déjà) ;
   - `string[]` / `json` (colonnes TEXT JSON : le DISTINCT porterait sur le
     JSON SÉRIALISÉ, pas sur les éléments — une facette d'appartenance demande
     un `json_each`, à instruire le jour où un listing en aura besoin) ;
   - les 4 colonnes d'AUDIT (`created_date`… : une valeur par ligne) ainsi que
     `id`, `search` et `updated_rev` — jamais des critères d'énumération.
   ⚠ La liste facettable est donc un SOUS-ENSEMBLE STRICT de la liste triable
   de `ListOrder` (même source : la spec). Un test verrouille cette inclusion.

   ── Sémantique du DISTINCT (alignée sur les options LOCALES) ───────────────
   Les options locales d'un filtre sont bâties dans un `Set<string>` alimenté
   par la valeur d'affichage, en SAUTANT les vides (`if (v) s.add(v)`), et la
   correspondance du filtre est une ÉGALITÉ EXACTE de chaîne
   (`set.has(String(v))`, cf. `ListView._applyColumnFilters`). Le SQL calque :
   - `DISTINCT` sur la collation BINAIRE de la colonne, donc SENSIBLE À LA
     CASSE. 🚨 Surtout pas `COLLATE NOCASE` ici : replier « WIRELESS » et
     « wireless » en UNE option produirait un identifiant qui ne correspondrait
     qu'à la moitié des lignes — le filtre paraîtrait cassé ;
   - NULL et chaîne VIDE EXCLUS (parité du `if (v)` local : « pas de valeur »
     n'est pas une option — `ListView` la traduit en sentinelle `__none__`,
     qu'aucune option ne porte) ;
   - `ORDER BY 1` : les valeurs remontent dans un ordre DÉTERMINÉ (sans quoi le
     plafond ci-dessous tronquerait au hasard). Le TRI D'AFFICHAGE, lui, reste
     l'affaire du client, qui applique la MÊME règle qu'en mode local.

   PLAFOND `VALUES_CAP` : un DISTINCT sur une colonne quasi unique (une MAC…)
   rendrait des dizaines de milliers de valeurs pour un menu déroulant. Cap
   ASSUMÉ, du même esprit que `SEARCH_ALL_LIMIT` — le dépassement est SIGNALÉ
   (`truncated`) plutôt que silencieux.

   Module PUR (aucun DOM, aucun Node) : il ne produit que des chaînes et des
   listes. ⚠ Imports internes partagés : extension `.js` IMPÉRATIVE (NodeNext
   l'exige côté serveur — cf. CLAUDE.md § « Code partagé front/back »).
   ============================================================================ */

import { COLLECTION_SPECS, FieldSpec } from "./DataValidation.js";
import { RelationalSchema } from "./RelationalSchema.js";

/** FACETTES des listes (méthodes statiques — cf. CLAUDE.md) : liste blanche partagée + SELECT DISTINCT. */
export class ListFacets {
  /** Plafond de valeurs distinctes rendues par un relevé (cf. l'en-tête). Au-delà, la réponse est
      marquée `truncated` : une facette qui le heurte n'est pas une facette, c'est une colonne libre. */
  static readonly VALUES_CAP = 500;

  /** Cache de la dérivation par collection (la spec est figée au chargement — la dérivation aussi).
      `isFacetable` est consulté à chaque rendu d'un listing pagé : autant ne dériver qu'une fois. */
  private static facetableCache: Map<string, Set<string>> = new Map();

  /** Les colonnes FACETTABLES d'une collection, dans l'ordre du schéma (champs de spec `string` —
      cf. l'en-tête pour les exclusions et leur motif). Collection inconnue → liste vide (défensif :
      le nom peut venir d'une route). */
  static facetableColumns(collection: string): string[] {
    const spec = COLLECTION_SPECS[collection];
    if (!spec) return [];
    const out: string[] = [];
    for (const field of Object.keys(spec.fields)) {
      if ((spec.fields[field] as FieldSpec).type === "string") out.push(field);
    }
    return out;
  }

  /** `column` est-elle facettable pour `collection` ? LA question que posent le client (avant de
      demander) et le serveur (avant d'interpoler) — même liste, même réponse (principe n°3). */
  static isFacetable(collection: string, column: string): boolean {
    let set = ListFacets.facetableCache.get(collection);
    if (!set) { set = new Set(ListFacets.facetableColumns(collection)); ListFacets.facetableCache.set(collection, set); }
    return set.has(column);
  }

  /** Le `SELECT DISTINCT …` d'un relevé de facette (`RelationalRepository.facetValues`), avec un
      paramètre `?` pour la LIMITE (l'appelant lie `VALUES_CAP + 1` : la ligne excédentaire dit
      « tronqué » sans payer un `COUNT(*)`, même ruse que `searchAll`).
      REFUSE (throw, message en français) une colonne hors liste blanche : c'est la barrière
      anti-injection — un appelant interne qui relaierait une valeur non validée échoue BRUYAMMENT,
      jamais en silence (la route, elle, pré-valide et répond 400). */
  static distinctSql(collection: string, column: string): string {
    if (!ListFacets.isFacetable(collection, column)) throw new Error("colonne de facette invalide : " + collection + "." + column);
    const table = RelationalSchema.quote(collection);
    const col = RelationalSchema.quote(column);
    // Vides EXCLUS et ordre DÉTERMINÉ : cf. « Sémantique du DISTINCT » en tête de fichier.
    return `SELECT DISTINCT ${col} AS value FROM ${table} WHERE ${col} IS NOT NULL AND ${col} <> '' ORDER BY 1 LIMIT ?`;
  }
}
