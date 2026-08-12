/* ============================================================================
   TRI SERVEUR DES LISTES PAGINÉES — code PARTAGÉ front ⇄ back (TS PUR).

   La « pagination ordonnée complète » (lot 1b du chantier lazy-load, arbitrage
   utilisateur du 2026-08-12, cadrage § 5.6) : en régime pagé, le critère de tri
   d'un listing ordonne le CORPUS ENTIER via un `ORDER BY` serveur — plus
   seulement la page reçue. Ce module porte les DEUX faces de ce contrat, et
   c'est la raison d'être de son emplacement partagé (principe n°3) :

   - la LISTE BLANCHE des colonnes triables, DÉRIVÉE de la spec déclarative
     (`DataValidation.COLLECTION_SPECS`) — jamais écrite à la main, comme le
     schéma relationnel lui-même (cf. RelationalSchema). Le CLIENT la consulte
     pour décider ce qu'il envoie (un critère non triable serveur → repli
     documenté, cf. `core/ListServerSort`) ; le SERVEUR valide contre la MÊME
     liste (route paginée → 400, dépôt → erreur). Une seule source, aucune
     divergence possible ;
   - le fragment `ORDER BY` lui-même (chaîne SQL, exécutée par le dépôt) — le
     serveur n'interpole JAMAIS un nom de colonne venu du client sans passer
     ici : la liste blanche EST la barrière anti-injection, et `orderBySql`
     REFUSE (throw) tout nom hors liste plutôt que de l'ignorer en silence.

   ── Ce qui est triable, et pourquoi ────────────────────────────────────────
   Les colonnes SCALAIRES du schéma : champs de spec `string`/`number`/`boolean`
   + les 4 colonnes d'audit (`created_by`/`updated_by`/`created_date`/
   `updated_date` — les critères « Date de création / de modification » des
   listings s'y mappent directement). EXCLUS :
   - `string[]` et `json` (colonnes TEXT JSON : un ORDER BY lexicographique sur
     du JSON sérialisé n'a aucun sens pour un humain) ;
   - `search` et `updated_rev` (colonnes OPÉRATIONNELLES, jamais montrées) ;
   - `id` : clé OPAQUE, déjà le bris d'égalité SYSTÉMATIQUE — l'offrir comme
     critère premier reviendrait à trier « au hasard stable ».

   ── Sémantique du tri (rapprochée du tri CLIENT, écarts documentés) ────────
   Le tri client (`core/Sort.compare` + `ListView._sortRows`) fait un
   `localeCompare("fr", { numeric: true, sensitivity: "base" })` avec vides
   (null/"") rejetés à l'extrémité « plus grand » (derniers en ASC, premiers en
   DESC — le multiplicateur de direction s'applique aussi au garde des vides).
   Côté SQL, on s'en rapproche au plus près :
   - vides pareils : garde `(col IS NULL OR col = '') <dir>` en tête d'ORDER BY
     (SQLite mettrait sinon les NULL à l'extrémité « plus petit » — l'inverse) ;
     sans danger sur une colonne numérique : `42 = ''` est faux (l'affinité ne
     convertit pas un texte non numérique, INTEGER < TEXT) ;
   - casse : `COLLATE NOCASE` sur les colonnes TEXT (un humain attend
     « albert » entre « Alice » et « Bruno », pas après « Zoé ») ;
   - ÉCART RÉSIDUEL ASSUMÉ : NOCASE ne replie ni les ACCENTS (« Éric » trie
     après « z ») ni la casse non-ASCII, et il n'y a pas d'ordre numérique
     « naturel » (« item10 » < « item2 »). Lever ça demanderait une collation
     ICU absente du SQLite embarqué — hors de proportion avec l'enjeu.
   - bris d'égalité `id ASC` TOUJOURS ajouté : sans ordre TOTAL déterministe,
     deux lignes égales au critère peuvent permuter entre deux requêtes et la
     découpe en pages DUPLIQUE ou OMET des lignes aux frontières.

   Ce module est PUR (aucun DOM, aucun Node) : il ne fait que produire des
   chaînes et des listes. ⚠ Imports internes partagés : extension `.js`
   IMPÉRATIVE (NodeNext l'exige côté serveur — cf. CLAUDE.md § « Code partagé
   front/back »).
   ============================================================================ */

import { COLLECTION_SPECS, FieldSpec } from "./DataValidation.js";
import { RelationalSchema } from "./RelationalSchema.js";

/** Directions de tri admises par la route paginée (`dir`). */
export type ListOrderDirection = "asc" | "desc";

/** TRI des listes paginées (méthodes statiques — cf. CLAUDE.md) : liste blanche partagée + ORDER BY. */
export class ListOrder {
  /** Cache de la dérivation par collection (la spec est figée au chargement — la dérivation aussi).
      `isSortable` est consulté à chaque rendu d'un listing pagé : autant ne dériver qu'une fois. */
  private static sortableCache: Map<string, Set<string>> = new Map();

  /** Les colonnes TRIABLES d'une collection, dans l'ordre du schéma (champs de spec scalaires puis
      audit — cf. l'en-tête pour les exclusions). Collection inconnue → liste vide (défensif : le nom
      peut venir d'une route). */
  static sortableColumns(collection: string): string[] {
    const spec = COLLECTION_SPECS[collection];
    if (!spec) return [];
    const out: string[] = [];
    for (const field of Object.keys(spec.fields)) {
      const type = (spec.fields[field] as FieldSpec).type;
      if (type === "string" || type === "number" || type === "boolean") out.push(field);
    }
    out.push(...RelationalSchema.AUDIT_COLUMNS);
    return out;
  }

  /** `column` est-elle triable pour `collection` ? LA question que posent le client (avant d'envoyer)
      et le serveur (avant d'interpoler) — même liste, même réponse (principe n°3). */
  static isSortable(collection: string, column: string): boolean {
    let set = ListOrder.sortableCache.get(collection);
    if (!set) { set = new Set(ListOrder.sortableColumns(collection)); ListOrder.sortableCache.set(collection, set); }
    return set.has(column);
  }

  /** `value` est-elle une direction de tri admise ? (garde de type — la route relaie une string HTTP). */
  static isDirection(value: string): value is ListOrderDirection {
    return value === "asc" || value === "desc";
  }

  /** Le fragment `ORDER BY …` de la liste paginée (`RelationalRepository.list`).
      - SANS `sort` : `created_date ASC, id ASC` VERBATIM — le comportement HISTORIQUE, celui de tous
        les appelants existants (boot, findAll, parité blob) : il ne bouge pas d'un caractère.
      - AVEC `sort` : garde des vides + colonne (COLLATE NOCASE si TEXT) + bris d'égalité `id ASC`,
        cf. la sémantique complète en tête de fichier.
      REFUSE (throw, message en français) une colonne hors liste blanche ou une direction inconnue :
      c'est la barrière anti-injection — un appelant interne qui relaierait une valeur non validée
      échoue BRUYAMMENT, jamais en silence (la route, elle, pré-valide et répond 400). */
  static orderBySql(collection: string, sort: string | null = null, dir: string = "asc"): string {
    const id = RelationalSchema.quote("id");
    if (sort === null || sort === undefined) return `ORDER BY ${RelationalSchema.quote("created_date")} ASC, ${id} ASC`;
    if (!ListOrder.isSortable(collection, sort)) throw new Error("colonne de tri invalide : " + collection + "." + sort);
    if (!ListOrder.isDirection(dir)) throw new Error("direction de tri invalide : " + dir);
    const direction = dir.toUpperCase();
    const column = RelationalSchema.quote(sort);
    // Affinité depuis la MÊME source que le DDL (RelationalSchema.sqlType) : audit = TEXT, sinon la spec.
    const fieldSpec = COLLECTION_SPECS[collection].fields[sort] as FieldSpec | undefined;
    const isText = !fieldSpec || RelationalSchema.sqlType(fieldSpec.type) === "TEXT";
    const collate = isText ? " COLLATE NOCASE" : "";
    return `ORDER BY (${column} IS NULL OR ${column} = '') ${direction}, ${column}${collate} ${direction}, ${id} ASC`;
  }
}
