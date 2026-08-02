/* =============================================================================
   RecordSearchIndex — index MÉMOÏSÉ des textes cherchables d'un listing.

   POURQUOI (mesure, pas supposition — arbitrage A6 du lot 3). Le texte cherchable
   d'un enregistrement (`RecordSearch.textOf`) coûte cher : il sérialise TOUTES
   les valeurs propres et suit les liens/enfants de la spec partagée. Mesuré sur
   un corpus synthétique d'équipements rackés (baie + 2 groupes + sous-équipement
   + catalogue + compositions), Node 24 :

     | corpus  | une passe COMPLÈTE | 10 filtres sur l'index |
     |---------|--------------------|------------------------|
     | 2 000   | ~23 ms             | ~8 ms  (0,8 ms/frappe) |
     | 10 000  | ~106 ms            | ~35 ms (3,5 ms/frappe) |

   Recalculer à CHAQUE frappe coûterait donc ~106 ms par caractère à 10 000
   équipements — visible, sous un anti-rebond de 180 ms. Mémoïser rend la frappe
   ~30× moins chère ; le prix est payé UNE fois par session de recherche.

   INVALIDATION — deux déclencheurs, volontairement GROSSIERS (le texte d'un
   enregistrement dépend d'AUTRES enregistrements : renommer une baie change le
   texte de tous ses équipements ; aucune invalidation fine n'est fiable ici) :
     1. le consommateur appelle `invalidate()` à chaque rendu qui n'est PAS une
        simple frappe (tri, filtre, page, re-rendu externe après écriture) —
        c'est le chemin par lequel toute mutation revient à l'écran ;
     2. le Store le notifie (`Store.onChange`) — filet pour les écritures qui ne
        repassent pas par le listing courant (SSE, autre onglet).
   Un index périmé se paierait en résultats faux : dans le doute on jette.
   ============================================================================= */
import { Schema } from "../../src-shared/Schema";
import type { EntityFetcher, ChildFinder } from "../../src-shared/DataValidation";
import { RecordSearch } from "./RecordSearch";

export class RecordSearchIndex {
  /** Séparateur de clé composite (collection + id) : caractère de CONTRÔLE, jamais dans un id métier —
      même convention que `FilterChips.SEP`. */
  private static readonly SEP = String.fromCharCode(31);

  private readonly cache = new Map<string, string>();

  /** Lecteurs INJECTÉS (le Store en implémentation cliente : `get`/`findByField`) — mêmes contrats que
      la validation partagée, donc mêmes lecteurs que le serveur passe à sa colonne `search`. */
  constructor(private readonly fetch: EntityFetcher, private readonly find: ChildFinder) {}

  /** Texte cherchable d'UN enregistrement, mémoïsé par (collection, id). Un enregistrement SANS id
      (jamais en pratique — le Store en pose toujours un) est calculé sans être mis en cache : une clé
      indéterminée ferait collision. */
  textOf(collection: string, record: any): string {
    const id = record && record.id ? String(record.id) : "";
    if (!id) return RecordSearch.textOf(collection, record, this.fetch, this.find);
    const key = collection + RecordSearchIndex.SEP + id;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const text = RecordSearch.textOf(collection, record, this.fetch, this.find);
    this.cache.set(key, text);
    return text;
  }

  /** Filtre des lignes sur une requête utilisateur. Requête vide ou BLANCHE → les lignes TELLES QUELLES :
      un listing sans recherche ne paie pas l'index. Sinon, inclusion du fragment normalisé dans le texte
      — l'équivalent EXACT du `LIKE '%…%'` que le serveur applique à sa colonne `search`.
      ⚠ Le ROGNAGE avant normalisation n'est pas cosmétique : c'est ce que fait
      `RelationalRepository.list` (`query.trim()` puis `Schema.normSearch`), et `normSearch` ne rogne
      PAS (elle ne fait que minuscules + accents). Sans lui, une saisie « ␣␣ » cherchait littéralement
      deux espaces côté client et ne filtrait rien côté serveur — les deux modes auraient divergé sur le
      cas le plus banal qui soit. */
  filter(collection: string, rows: readonly any[], query: string): any[] {
    const needle = Schema.normSearch(String(query || "").trim());
    if (!needle) return rows.slice();
    return rows.filter((row) => this.textOf(collection, row).includes(needle));
  }

  /** Jette l'index (cf. en-tête : invalidation grossière et assumée). */
  invalidate(): void { this.cache.clear(); }

  /** Nombre d'entrées mémoïsées — sert aux tests (la mémoïsation est un COMPORTEMENT, pas un détail). */
  get size(): number { return this.cache.size; }
}
