/* =============================================================================
   OptionSearch — règles PURES d'un sélecteur d'entité À RECHERCHE (aucun DOM,
   aucun store) : ce qu'on affiche pour une saisie, ce qui reste caché, quel
   libellé porte la valeur courante, et quelle valeur SURVIT à un repeuplement.

   POURQUOI un module dédié (principes n°2/n°7) : `EntityPicker` (le contrôle)
   et `SearchPop` (le popover) sont du DOM, donc intestables dans le harnais
   Node. Or c'est ICI que vit tout ce que la bascule `<select>` → recherche
   pouvait casser — l'ordre des options, leur troncature, la parité des règles
   de valeur. Le mettre à part, c'est pouvoir le VERROUILLER.

   ⚠ CE MODULE NE PRODUIT AUCUNE OPTION : il ne fait que les FILTRER. La règle
   métier (quels équipements/ports proposer, dans quel ordre, avec quel libellé,
   lesquels sont `disabled`) reste chez l'appelant — `CableForms.eqOpts` /
   `portOpts` / `patchEndpointOpts`, inchangés par la bascule. C'est la
   condition de la parité : on remplace le CONTRÔLE, pas la RÈGLE.

   ⚠ ON NE RE-TRIE JAMAIS — divergence ASSUMÉE avec `core/TargetSearch`, qui,
   lui, classe « préfixe d'abord puis alphabétique ». Ici l'ordre d'ENTRÉE porte
   déjà des décisions métier (les ports OCCUPÉS sont rejetés en fin de liste,
   puis alphabétique ; les types de câble sont groupés par famille) : reclasser
   les résultats les détruirait silencieusement. Un sélecteur à recherche filtre
   une liste ORDONNÉE — il n'en refait pas l'ordre.
   ============================================================================= */

/** Une option sélectionnable. Forme structurellement compatible avec
    `ui/FormControls.SelectOption` (même trio `value`/`label`/`disabled`) SANS en dépendre : on
    ne tire pas le type d'une primitive DOM dans un module pur — même recette que
    `core/CertsSearch.CertSearchItem`. Le champ `group` de `SelectOption` est ignoré ici (il ne
    sert qu'au regroupement en `<optgroup>`, propre au `<select>` natif). */
export interface PickableOption {
  value: string;
  label: string;
  /** Visible mais NON sélectionnable (parité `<option disabled>`) — ex. un port déjà occupé,
      affiché avec le nom du câble qui l'occupe pour que l'utilisateur sache POURQUOI. */
  disabled?: boolean;
}

export interface OptionSearchOptions {
  /** Normalisation appliquée à LA REQUÊTE ET AUX LIBELLÉS (le client passe `Schema.normSearch` :
      casse et accents ignorés, MÊME normalisation que la recherche serveur). Injectée pour que ce
      module ne dépende de rien. */
  normalize: (value: unknown) => string;
  /** Nombre MAX de résultats rendus d'un coup — défaut `DEFAULT_LIMIT`. */
  limit?: number;
}

/** Résultat d'un filtrage : ce qu'on affiche, et COMBIEN on a tu. `hidden` n'est pas décoratif —
    taire des résultats sans le dire ferait croire qu'une entité n'existe pas. */
export interface OptionSearchOutcome {
  shown: PickableOption[];
  hidden: number;
}

export class OptionSearch {
  /** Valeur conventionnelle de « aucune sélection » — celle du `<option>` de tête des formulaires
      (« — Choisir l'équipement — », « Aucun port compatible »…). Ce n'est PAS une entité : elle
      n'apparaît jamais dans les résultats, elle sert de LIBELLÉ à l'état vide. */
  static readonly EMPTY_VALUE = "";

  /** Plafond de rendu par défaut. C'est une borne de COÛT D'AFFICHAGE (nombre de nœuds DOM du
      popover), pas une préférence de pertinence : d'où un nombre confortable, très au-dessus des
      10 suggestions de `FieldFacet.MAX_RESULTS_DEFAULT` — un sélecteur d'entité remplace un
      `<select>` qui montrait TOUT, on ne veut pas transformer le parcours en devinette. Le reste
      est annoncé (`hidden`) plutôt que tu. */
  static readonly DEFAULT_LIMIT = 50;

  /** Libellé de l'état « aucune sélection » = celui de la PREMIÈRE option de valeur vide. Rend ""
      si la liste n'en porte pas (l'appelant affichera alors son propre repli). */
  static placeholderLabel(options: readonly PickableOption[]): string {
    const placeholder = options.find((option) => option.value === OptionSearch.EMPTY_VALUE);
    return placeholder ? placeholder.label : "";
  }

  /** Libellé de la valeur COURANTE, ou `null` si elle ne désigne rien de sélectionné : valeur vide
      (le libellé de l'état vide se demande à `placeholderLabel`, jamais ici) ou valeur absente de
      la liste. */
  static labelOf(options: readonly PickableOption[], value: string | null | undefined): string | null {
    if (value == null || value === OptionSearch.EMPTY_VALUE) return null;
    const found = options.find((option) => option.value === value);
    return found ? found.label : null;
  }

  /** Valeur RETENUE après un (re)peuplement — parité STRICTE avec `<select>` repeuplé par
      `FormControls.fillSelect` :
      - `value` non fournie (`undefined`/`null`) → la valeur de la PREMIÈRE option, comme un
        `<select>` qui sélectionne son premier `<option>` faute d'instruction (en pratique le
        placeholder, donc "") ; liste vide → "" ;
      - `value` présente dans la liste → elle est conservée, **même `disabled`** : poser une valeur
        par programme sur une option désactivée fonctionne aussi sur un `<select>` (seul
        l'UTILISATEUR ne peut pas la choisir) ;
      - `value` ABSENTE de la liste → "", exactement comme `select.value = "inconnu"` qui laisse
        `selectedIndex` à -1 et rend "". C'est ce qui fait que `keepId` (l'élément déjà choisi,
        maintenu dans la liste même hors filtre) protège la saisie : sans lui la valeur tomberait. */
  static resolveValue(options: readonly PickableOption[], value: string | null | undefined): string {
    if (value == null) return options.length ? options[0].value : OptionSearch.EMPTY_VALUE;
    if (options.some((option) => option.value === value)) return value;
    return OptionSearch.EMPTY_VALUE;
  }

  /** Les options RÉELLEMENT proposables (hors option de tête). Sert à décider si un champ de
      recherche a lieu d'être : une liste réduite au seul placeholder (« Choisir un équipement
      d'abord », « Aucun port compatible ») n'offre rien à chercher. Les options `disabled` y
      comptent : elles ont vocation à être VUES (elles expliquent pourquoi elles sont hors jeu). */
  static selectableCount(options: readonly PickableOption[]): number {
    return options.reduce((total, option) => total + (option.value === OptionSearch.EMPTY_VALUE ? 0 : 1), 0);
  }

  /** Filtre les options pour une saisie, dans l'ORDRE D'ENTRÉE, et borne le rendu :
      - l'option de tête (valeur vide) est TOUJOURS écartée — c'est un état, pas une entité ;
      - requête vide (après trim/normalisation) → TOUTES les options, bornées : le contrôle doit
        pouvoir se PARCOURIR sans taper, ce qu'un `<select>` permettait ;
      - sinon, on garde celles dont le libellé NORMALISÉ contient la requête normalisée ;
      - les options `disabled` sont CONSERVÉES (parité `<option disabled>` : visibles, non
        sélectionnables) — les masquer ferait disparaître l'information « déjà occupé par X » ;
      - `hidden` compte les correspondances écartées par le plafond, jamais celles écartées par
        le filtre. */
  static filter(options: readonly PickableOption[], query: string, opts: OptionSearchOptions): OptionSearchOutcome {
    const normalize = opts.normalize;
    const needle = normalize(String(query == null ? "" : query).trim());
    const matched: PickableOption[] = [];
    for (const option of options) {
      if (option.value === OptionSearch.EMPTY_VALUE) continue;
      if (needle !== "" && !normalize(option.label).includes(needle)) continue;
      matched.push(option);
    }
    const limit = Math.max(0, Math.floor(opts.limit != null ? opts.limit : OptionSearch.DEFAULT_LIMIT));
    return { shown: matched.slice(0, limit), hidden: Math.max(0, matched.length - limit) };
  }
}
