/* =============================================================================
   TargetFilterDisplay — résolution PURE de l'AFFICHAGE d'une dimension « à
   RECHERCHE » (filtre CIBLE unifié des listings) : que dit le BADGE du
   déclencheur fermé, et quel PLACEHOLDER porte le champ du panneau. Aucun DOM,
   aucune i18n — le rendu (ui/FilterBar) traduit les INTENTIONS rendues ici,
   ce qui laisse la règle testable en isolation (principes n°2/n°7).

   Refonte 2026-08-03 (maquette design-system/briefs/filtre-cible-porteur-maquette
   §2/§10) : la dimension « à recherche » se présente comme un déclencheur FERMÉ
   (`.multi-trigger` + `.count-badge`), au même langage que les MultiSelect. Le
   badge suit la sélection :
     - AUCUNE cible → « (Tous) » (parité MultiSelect vide) ;
     - UNE cible    → le NOM de l'entité, résolu à CHAQUE rendu — jamais
       persisté : un renommage suit tout seul, une entité disparue retombe sur
       son identifiant (même règle de repli que les chips de core/FilterChips :
       jamais un badge vide pour un filtre pourtant actif) ;
     - DEUX et plus → le COMPTEUR (multi OR, v2) — la logique le sait DÉJÀ :
       seule la borne v1 (1 cible) empêche ce cas d'advenir dans l'UI.
   ============================================================================= */

/** Intention d'affichage du BADGE du déclencheur. Le rendu traduit `all` (« Tous » localisé),
    affiche `name.label` tel quel, ou formate `count.count` — la règle du CHOIX vit ici. */
export type TargetFilterBadge =
  | { kind: "all" }
  | { kind: "name"; label: string }
  | { kind: "count"; count: number };

/** Intention de PLACEHOLDER du champ du panneau : celui de la DIMENSION (rien de posé),
    « Remplacer par… » (mono : choisir remplace) ou « Ajouter… » (multi : choisir cumule). */
export type TargetFilterPlaceholder = "dimension" | "replace" | "add";

export class TargetFilterDisplay {
  /** Badge du déclencheur pour la sélection courante. `labelOf` résout le nom d'une valeur
      (null / "" = entité disparue → repli sur l'identifiant, parité chips). */
  static badge(
    selected: ReadonlyArray<string>,
    labelOf: (valueId: string) => string | null | undefined,
  ): TargetFilterBadge {
    if (selected.length === 0) return { kind: "all" };
    if (selected.length === 1) {
      const valueId = selected[0];
      return { kind: "name", label: labelOf(valueId) || valueId };
    }
    return { kind: "count", count: selected.length };
  }

  /** Placeholder du champ : la DIMENSION parle tant que rien n'est posé ; une cible posée bascule
      sur « remplacer » (mono — la borne `maxTargets` vaut 1 en v1) ou « ajouter » (multi OR : lever
      la borne suffit, le placeholder bascule tout seul — maquette §4). */
  static placeholder(selectedCount: number, maxTargets: number): TargetFilterPlaceholder {
    if (selectedCount === 0) return "dimension";
    return maxTargets <= 1 ? "replace" : "add";
  }
}
