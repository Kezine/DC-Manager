import { MultiSelect, type MultiItem } from "./MultiSelect";
import { FormControls } from "./FormControls";
import { SearchPop, type SearchPopResult } from "./SearchPop";
import { Icons } from "./Icons";
import { Html } from "../core/Html";
import { I18n } from "../i18n/I18n";
import { FilterChips, type ChipDimension, type FilterChip } from "../core/FilterChips";

/* =============================================================================
   FilterBar — barre de FILTRES unifiée des listings (revue design lot C). Vocabulaire
   COMMUN aux trois listings (ListView générique, Interventions, Certificats) :

     • les filtres ACTIFS s'affichent en CHIPS supprimables (« Type : Switch × »),
       un chip par VALEUR sélectionnée (modèle pur `FilterChips`) ;
     • un bouton « + Filtre » ouvre le CHOIX de dimension → le panneau `MultiSelect`
       EXISTANT de la dimension (principe n°14 : on RÉUTILISE le composant maison,
       on n'en réinvente pas un) ; une dimension à sélection UNIQUE (ex. l'état des
       certificats, que le serveur n'accepte qu'en un exemplaire) tombe sur un
       `<select>` maison ; une dimension « à RECHERCHE » (filtre CIBLE unifié du
       lot 3 : « les câbles de SW-Coeur ») tombe, elle, sur un `SearchPop` — la
       liste des entités est longue, croissante et à libellés composés, donc jamais
       un `<select>` (même règle que `FormControls.entityPicker`) ;
     • un bouton « Réinitialiser », masqué quand aucun filtre n'est actif, que la vue
       positionne À DROITE de sa barre.

   DISCIPLINE DE RE-RENDU : les vues repeignent leur CORPS seul quand un filtre change
   (le champ de recherche garde son focus, un panneau ouvert n'est pas refermé). La
   FilterBar suit la même règle : un changement de VALEUR ne reconstruit QUE les chips
   (`syncChips`) + délègue le rechargement du corps à `onChange` ; elle ne se
   reconstruit entièrement que sur retrait de chip / réinitialisation (actions ponctuelles,
   menu généralement fermé), où le menu est refait pour refléter l'état (cases décochées).

   Les Sets `selected` des dimensions sont MUTÉS EN PLACE (comme le veut `MultiSelect`) :
   la vue les lit ensuite pour bâtir sa requête. Une dimension `single` garde 0 ou 1 valeur.
   ============================================================================= */

/** Contrôle d'une dimension « à RECHERCHE » : la valeur n'est pas choisie dans une liste fixe mais
    CHERCHÉE (entités du modèle). Tout est INJECTÉ par la vue — la barre ignore d'où viennent les
    candidats (Store local, serveur…) et ce que la valeur signifie. MONO-VALEUR en v1 : choisir
    remplace (forme volontairement extensible — le Set et les chips supportent déjà le multiple). */
export interface FilterBarSearchDimension {
  /** Repli du champ de recherche. */
  placeholder: string;
  /** Candidats d'une saisie — déjà triés/bornés par la vue. Peut être synchrone (corpus local). */
  fetch: (query: string) => Promise<SearchPopResult[]> | SearchPopResult[];
  /** Libellé d'AFFICHAGE d'une valeur choisie (chip), résolu à CHAQUE rendu — jamais persisté :
      l'entité peut avoir été renommée, ou supprimée (rendre null → la chip retombe sur l'identifiant). */
  labelOf: (valueId: string) => string | null;
  /** Caractères minimaux avant de chercher — défaut 1 (le corpus est local, une lettre suffit). */
  minChars?: number;
  /** Anti-rebond du SearchPop (ms) — absent = défaut du composant. Les dimensions serveur-pilotées
      (recherche de CANDIDATS d'entités en mode API) posent `EntityCandidateSource.DEBOUNCE_MS` pour
      réagir au MÊME tempo que la palette et les listings. */
  debounceMs?: number;
}

/** Dimension présentée par la barre : valeurs possibles + Set sélectionné (muté en place).
    `single` → sélection UNIQUE (choisir une valeur remplace la précédente).
    `search` → dimension « à RECHERCHE » (cf. `FilterBarSearchDimension`) : `options` reste vide, les
    valeurs sont LIBRES et les chips lisent leur libellé via `search.labelOf`. */
export interface FilterBarDimension {
  key: string;
  label: string;
  options: MultiItem[];
  selected: Set<string>;
  single?: boolean;
  search?: FilterBarSearchDimension;
}

export class FilterBar {
  /** Bouton « + Filtre » (+ son menu popover) — inséré par la vue AVANT la recherche (revue
      2026-07-30 : le bouton ouvre un choix de critères, il précède la zone qu'il qualifie). */
  readonly addElement: HTMLElement;
  /** Rangée des CHIPS actifs — pleine largeur, À LA LIGNE sous la barre (`.lc-chips-row`,
      `flex-basis: 100%` dans le `.list-chrome` en wrap ; masquée à vide via `:empty`). Avant la
      revue, chips et bouton partageaient un conteneur inséré APRÈS la recherche : les chips
      s'inséraient AU MILIEU de la barre et poussaient tout le reste. */
  readonly chipsElement: HTMLElement;
  /** Bouton « Réinitialiser » — la vue le positionne À DROITE de sa barre ; visibilité gérée ici. */
  readonly resetElement: HTMLButtonElement;

  private readonly dims: FilterBarDimension[];
  private readonly onChange: () => void;
  private readonly menuEl: HTMLElement;
  private readonly addBtn: HTMLButtonElement;
  private readonly chipsEl: HTMLElement;
  /** `<select>` des dimensions à sélection unique (resynchronisés quand un chip est retiré). */
  private readonly singleSelects = new Map<string, HTMLSelectElement>();

  /** Fermeture des menus « + Filtre » au clic extérieur — un SEUL écouteur global (comme MultiSelect),
      pour éviter d'accumuler des écouteurs au fil des reconstructions de barres. */
  private static wired = false;

  constructor(dimensions: FilterBarDimension[], onChange: () => void) {
    this.dims = dimensions;
    this.onChange = onChange;
    FilterBar.ensureWired();

    // -- Bouton « + Filtre » + menu de choix de dimension (popover) --
    const pop = document.createElement("div"); pop.className = "lc-addfilter";
    this.addBtn = document.createElement("button");
    this.addBtn.type = "button"; this.addBtn.className = "lc-addfilter-btn";
    this.addBtn.setAttribute("aria-haspopup", "menu");
    this.addBtn.setAttribute("aria-expanded", "false");
    this.addBtn.innerHTML = `<span class="lc-addfilter-ic" aria-hidden="true">${Icons.PLUS}</span>${Html.escape(I18n.t("lists.chrome.addFilter"))}`;
    this.addBtn.title = I18n.t("lists.chrome.addFilterTitle");
    this.menuEl = document.createElement("div"); this.menuEl.className = "lc-addfilter-menu";
    this.menuEl.addEventListener("click", (e) => e.stopPropagation());   // un clic DANS le menu ne le referme pas
    this.addBtn.onclick = (e) => { e.stopPropagation(); this.toggleMenu(); };
    pop.append(this.addBtn, this.menuEl);

    // -- Chips actifs (rangée pleine largeur, cf. chipsElement) --
    this.chipsEl = document.createElement("div"); this.chipsEl.className = "lc-chips lc-chips-row";

    // -- Réinitialiser (positionné à droite par la vue) --
    this.resetElement = document.createElement("button");
    this.resetElement.type = "button"; this.resetElement.className = "lc-reset btn btn-ghost btn-sm";
    this.resetElement.textContent = I18n.t("lists.chrome.filterReset");
    this.resetElement.onclick = () => this.resetAll();

    this.addElement = pop;
    this.chipsElement = this.chipsEl;
    this.buildMenu();
    this.syncChips();
  }

  /* ---- Menu « + Filtre » : un contrôle par dimension (MultiSelect ou select unique) ---- */

  private buildMenu(): void {
    this.menuEl.replaceChildren();
    this.singleSelects.clear();
    for (const dim of this.dims) {
      if (dim.search) this.menuEl.appendChild(this.buildSearch(dim));
      else if (dim.single) this.menuEl.appendChild(this.buildSingle(dim));
      else this.menuEl.appendChild(MultiSelect.build(dim.label, dim.options, dim.selected, () => this.valueChanged()));
    }
  }

  /** Dimension « à RECHERCHE » : libellé + `SearchPop` (principe n°14). Le CLIC sur un résultat POSE
      le filtre — mono-valeur en v1 (on remplace) — et REFERME le menu : le geste est terminé, le laisser
      ouvert masquerait la chip qui vient d'apparaître. Rendu COMPACT du SearchPop (pas `grow`) : dans
      ce menu en colonne, un champ extensible prendrait sa base flex en HAUTEUR. */
  private buildSearch(dim: FilterBarDimension): HTMLElement {
    // Même enveloppe visuelle que la dimension à sélection unique (`.lc-single` : libellé + contrôle sur
    // une rangée) — aucune CSS nouvelle : le SearchPop compact porte déjà son propre style.
    const wrap = document.createElement("div"); wrap.className = "lc-single";
    const lab = document.createElement("span"); lab.className = "lc-single-lb"; lab.textContent = dim.label;
    const source = dim.search!;
    const pop = new SearchPop({
      placeholder: source.placeholder,
      minChars: source.minChars != null ? source.minChars : 1,
      ...(source.debounceMs != null ? { debounceMs: source.debounceMs } : {}),
      fetch: (query) => Promise.resolve(source.fetch(query)),
      onPick: (result) => {
        dim.selected.clear();               // MONO-valeur v1 : la nouvelle cible remplace la précédente
        dim.selected.add(result.id);
        FilterBar.closeAllMenus();
        this.valueChanged();
      },
    });
    wrap.append(lab, pop.element);
    return wrap;
  }

  /** Dimension à sélection UNIQUE : libellé + `<select>` (« Tous » = aucun filtre). Choisir remplace la
      valeur ; « Tous » vide le Set. */
  private buildSingle(dim: FilterBarDimension): HTMLElement {
    const wrap = document.createElement("label"); wrap.className = "lc-single";
    const lab = document.createElement("span"); lab.className = "lc-single-lb"; lab.textContent = dim.label;
    const sel = FormControls.select(
      [{ value: "", label: I18n.t("lists.chrome.filterAny") }, ...dim.options.map((o) => ({ value: o.id, label: o.label }))],
      [...dim.selected][0] || "",
    );
    sel.onchange = () => {
      dim.selected.clear();
      if (sel.value) dim.selected.add(sel.value);
      this.valueChanged();
    };
    this.singleSelects.set(dim.key, sel);
    wrap.append(lab, sel);
    return wrap;
  }

  private toggleMenu(): void {
    const willOpen = !this.menuEl.classList.contains("open");
    FilterBar.closeAllMenus();
    document.querySelectorAll(".multi-panel.open").forEach((p) => p.classList.remove("open"));
    this.menuEl.classList.toggle("open", willOpen);
    this.addBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
  }

  /* ---- Chips actifs ---- */

  /** Reconstruit les chips + la visibilité de « Réinitialiser » depuis l'état COURANT, et resynchronise
      les `<select>` uniques. Sûr pendant un menu ouvert / un changement de valeur (ne touche pas au menu). */
  syncChips(): void {
    const chipDims = this.chipDimensions();
    const chips = FilterChips.build(
      chipDims,
      (k) => this.dimByKey(k)?.selected,
      // Libellé d'une valeur LIBRE (dimension à recherche) : résolu ICI, à chaque rendu — cf. FilterChips.build.
      (k, valueId) => this.dimByKey(k)?.search?.labelOf(valueId),
    );
    this.chipsEl.replaceChildren(...chips.map((c) => this.chipEl(c)));
    this.resetElement.style.display = chips.length ? "" : "none";
    for (const [key, sel] of this.singleSelects) sel.value = [...(this.dimByKey(key)?.selected || [])][0] || "";
  }

  private chipEl(chip: FilterChip): HTMLElement {
    const el = document.createElement("span"); el.className = "filter-chip";
    const label = document.createElement("span"); label.className = "filter-chip-lb";
    label.textContent = I18n.t("lists.chrome.filterChip", { dim: chip.dimLabel, value: chip.valueLabel });
    const x = document.createElement("button"); x.type = "button"; x.className = "filter-chip-x";
    x.setAttribute("aria-label", I18n.t("lists.chrome.removeFilter", { dim: chip.dimLabel, value: chip.valueLabel }));
    x.innerHTML = Icons.CLOSE;
    x.onclick = (e) => { e.stopPropagation(); this.removeValue(chip.dimKey, chip.valueId); };
    el.append(label, x);
    return el;
  }

  /* ---- Mutations ---- */

  /** Changement de VALEUR via un contrôle du menu (MultiSelect/select) : le contrôle a déjà reflété son
      état → on ne refait QUE les chips, puis on délègue le rechargement du corps. */
  private valueChanged(): void {
    this.syncChips();
    this.onChange();
  }

  /** Retrait d'un chip : ôte la valeur puis RECONSTRUIT le menu (pour décocher la case correspondante) —
      action ponctuelle, menu généralement fermé. */
  private removeValue(dimKey: string, valueId: string): void {
    const dim = this.dimByKey(dimKey);
    if (!dim) return;
    dim.selected.delete(valueId);
    this.buildMenu();
    this.syncChips();
    this.onChange();
  }

  /** Réinitialise TOUTES les dimensions (vide les Sets), reconstruit le menu (cases décochées) et recharge. */
  private resetAll(): void {
    for (const dim of this.dims) dim.selected.clear();
    this.buildMenu();
    this.syncChips();
    this.onChange();
  }

  /* ---- Helpers ---- */

  private dimByKey(key: string): FilterBarDimension | undefined {
    return this.dims.find((d) => d.key === key);
  }

  private chipDimensions(): ChipDimension[] {
    return this.dims.map((d) => ({ key: d.key, label: d.label, options: d.options, search: !!d.search }));
  }

  private static ensureWired(): void {
    if (FilterBar.wired) return;
    document.addEventListener("click", () => FilterBar.closeAllMenus());
    FilterBar.wired = true;
  }

  private static closeAllMenus(): void {
    document.querySelectorAll(".lc-addfilter-menu.open").forEach((m) => {
      m.classList.remove("open");
      const btn = m.parentElement?.querySelector(".lc-addfilter-btn");
      btn?.setAttribute("aria-expanded", "false");
    });
  }
}
