/* =============================================================================
   GlobalSearch — classement PUR de la recherche GLOBALE (palette Ctrl+K).

   POURQUOI un module dédié (principes n°2/n°7) : la PERTINENCE, le PLAFOND PAR
   FAMILLE (avec troncature ANNONCÉE) et l'ORDRE d'affichage des familles forment
   une logique testable headless, indépendante du Store (qui fournit le corpus —
   cf. `views/GlobalSearchSources`) et de la vue (qui fournit la requête et rend
   les résultats). La NORMALISATION est INJECTÉE : l'appelant passe
   `Schema.normSearch` (insensibilité casse/accents, partagée front ⇄ serveur).

   PARENTÉ : même position architecturale que `TargetSearch` (sélection des cibles
   d'intervention). Il ne le RÉUTILISE pas, et c'est un choix : TargetSearch ne
   matche que sur le LIBELLÉ, alors que la recherche globale matche aussi sur des
   TERMES annexes (n° de série, description, IP… — les `searchFields` des
   listings) qui ne s'affichent pas. Tordre TargetSearch pour ça lui aurait fait
   porter deux contrats ; les deux modules restent petits et francs.

   PERTINENCE, par famille (du plus fort au plus faible) :
     1. le LIBELLÉ commence par la requête (préfixe) ;
     2. le libellé la CONTIENT ;
     3. seuls des TERMES ANNEXES la contiennent (l'objet matche mais son libellé
        ne le montre pas — le survol/la fiche diront pourquoi).
   À pertinence égale : tri alphabétique du libellé normalisé (déterministe,
   indépendant de l'ordre d'entrée). Les familles sortent dans l'ORDRE CANONIQUE
   injecté (`familyOrder`) — jamais dans l'ordre d'arrivée du corpus.
   ============================================================================= */

/** Un élément du corpus : famille (= collection), identifiant, libellé AFFICHÉ, termes annexes. */
export interface GlobalSearchItem {
  kind: string;
  id: string;
  label: string;
  /** Termes de recherche NON affichés (n° de série, description, adresse…). Valeurs brutes :
      la normalisation et le filtrage des null/vides sont l'affaire de ce module. */
  terms: readonly unknown[];
}

/** Options du classement (tout injecté). */
export interface GlobalSearchOptions {
  /** Normalisation appliquée à LA REQUÊTE, aux LIBELLÉS et aux TERMES (ex. `Schema.normSearch`). */
  normalize: (value: unknown) => string;
  /** Ordre CANONIQUE d'affichage des familles. Une famille absente de cette liste sort APRÈS, par
      ordre alphabétique — défensif : le corpus ne doit pas pouvoir casser l'affichage. */
  familyOrder: readonly string[];
  /** Nombre maximal de résultats PAR FAMILLE — défaut 5. Le surplus est COMPTÉ (`hidden`), jamais
      tronqué en silence (règle « pas de plafond muet »). */
  perFamilyCap?: number;
}

/** Résultats d'UNE famille : les retenus (plafonnés) + le nombre de masqués. */
export interface GlobalSearchFamilyResult {
  kind: string;
  items: GlobalSearchItem[];
  /** Résultats au-delà du plafond — la vue les ANNONCE (« + N autres »), elle ne les tait pas. */
  hidden: number;
}

export class GlobalSearch {
  /** Filtre, classe, plafonne PAR FAMILLE et ordonne les familles. Requête vide (après
      normalisation) → AUCUN résultat : on n'inonde pas la palette à l'ouverture. */
  static rank(items: readonly GlobalSearchItem[], query: string, opts: GlobalSearchOptions): GlobalSearchFamilyResult[] {
    const normalize = opts.normalize;
    const needle = normalize(query);
    if (needle === "") return [];
    const cap = Math.max(1, opts.perFamilyCap != null ? opts.perFamilyCap : 5);

    // Trois paniers par famille — matérialise les niveaux de pertinence sans comparateur composite.
    type Bucket = { item: GlobalSearchItem; norm: string };
    const byFamily = new Map<string, { prefix: Bucket[]; contains: Bucket[]; termsOnly: Bucket[] }>();
    for (const item of items) {
      const normLabel = normalize(item.label);
      const at = normLabel.indexOf(needle);
      let tier: "prefix" | "contains" | "termsOnly" | null = at === 0 ? "prefix" : at > 0 ? "contains" : null;
      if (tier === null) {
        // Le libellé ne matche pas : les termes annexes, peut-être. `some` court-circuite — on ne
        // normalise pas tout le corpus, seulement jusqu'au premier terme qui matche.
        const hit = item.terms.some((term) => term != null && normalize(term).includes(needle));
        if (!hit) continue;
        tier = "termsOnly";
      }
      let family = byFamily.get(item.kind);
      if (!family) { family = { prefix: [], contains: [], termsOnly: [] }; byFamily.set(item.kind, family); }
      family[tier].push({ item, norm: normLabel });
    }

    // Ordre des familles : le canonique d'abord, puis les inconnues (défensif) en alphabétique.
    const known = opts.familyOrder.filter((kind) => byFamily.has(kind));
    const unknown = [...byFamily.keys()].filter((kind) => !opts.familyOrder.includes(kind)).sort();
    const byLabel = (a: Bucket, b: Bucket): number => (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0);

    return [...known, ...unknown].map((kind) => {
      const family = byFamily.get(kind)!;
      family.prefix.sort(byLabel); family.contains.sort(byLabel); family.termsOnly.sort(byLabel);
      const ranked = [...family.prefix, ...family.contains, ...family.termsOnly];
      return {
        kind,
        items: ranked.slice(0, cap).map((entry) => entry.item),
        hidden: Math.max(0, ranked.length - cap),
      };
    });
  }
}
