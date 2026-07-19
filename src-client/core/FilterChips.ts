/* =============================================================================
   FilterChips — modèle PUR des filtres actifs d'un listing (aucun DOM, aucun état
   global). Transforme l'état de sélection (par dimension → valeurs cochées) en une
   liste ORDONNÉE de « chips » supprimables, un chip par VALEUR sélectionnée.

   Extrait pour être testable en isolation (principes n°2/n°7) : la barre de
   contrôles (ui/FilterBar) se contente de RENDRE le résultat et de câbler le
   retrait ; toute la logique « quels chips, dans quel ordre, avec quelle clé »
   vit ICI. Réutilisé par les trois listings (ListView générique, Interventions,
   Certificats), qui n'ont ainsi qu'UN modèle commun de filtres actifs.
   ============================================================================= */

/** Une DIMENSION filtrable : sa clé technique, son libellé humain et ses valeurs possibles
    (id → libellé). L'ordre des `options` FIXE l'ordre des chips au sein de la dimension. */
export interface ChipDimension {
  key: string;
  label: string;
  options: ReadonlyArray<{ id: string; label: string }>;
}

/** Un chip = une VALEUR sélectionnée d'une dimension, prêt à afficher et à retirer.
    `key` est un identifiant STABLE et unique (aria-label, déduplication du rendu). */
export interface FilterChip {
  dimKey: string;
  dimLabel: string;
  valueId: string;
  valueLabel: string;
  key: string;
}

export class FilterChips {
  /** Séparateur interne des clés : un caractère de CONTRÔLE (unit separator U+001F), jamais présent
      dans un identifiant ou un libellé métier → la clé composite reste sans collision ni ambiguïté. */
  static readonly SEP = String.fromCharCode(31);

  /** Clé stable d'un chip (dimension + valeur) — sert d'identité au rendu et à l'aria-label. */
  static keyOf(dimKey: string, valueId: string): string {
    return dimKey + FilterChips.SEP + valueId;
  }

  /** Construit la liste ORDONNÉE des chips à partir des dimensions et d'un accès à l'état sélectionné
      (`selected(dimKey)` renvoie l'ensemble des ids cochés de la dimension). Ordre déterministe :
      dimensions dans l'ordre reçu, puis valeurs dans l'ordre des OPTIONS de la dimension. Une valeur
      cochée qui ne figure PLUS dans les options (option disparue) est IGNORÉE — aucun chip fantôme. */
  static build(
    dims: ReadonlyArray<ChipDimension>,
    selected: (dimKey: string) => ReadonlySet<string> | undefined,
  ): FilterChip[] {
    const chips: FilterChip[] = [];
    for (const dim of dims) {
      const set = selected(dim.key);
      if (!set || set.size === 0) continue;
      for (const opt of dim.options) {
        if (!set.has(opt.id)) continue;   // itère les OPTIONS (ordre stable) et non le Set (ordre d'insertion)
        chips.push({
          dimKey: dim.key,
          dimLabel: dim.label,
          valueId: opt.id,
          valueLabel: opt.label,
          key: FilterChips.keyOf(dim.key, opt.id),
        });
      }
    }
    return chips;
  }

  /** Nombre total de valeurs sélectionnées (toutes dimensions) = nombre de chips. Sert notamment à
      décider l'affichage du bouton « Réinitialiser » (masqué quand aucun filtre n'est actif). */
  static count(
    dims: ReadonlyArray<ChipDimension>,
    selected: (dimKey: string) => ReadonlySet<string> | undefined,
  ): number {
    let n = 0;
    for (const dim of dims) {
      const set = selected(dim.key);
      if (!set || set.size === 0) continue;
      for (const opt of dim.options) if (set.has(opt.id)) n++;
    }
    return n;
  }
}
