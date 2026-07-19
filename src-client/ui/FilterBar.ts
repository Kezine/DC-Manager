import { MultiSelect, type MultiItem } from "./MultiSelect";
import { FormControls } from "./FormControls";
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
       `<select>` maison ;
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

/** Dimension présentée par la barre : valeurs possibles + Set sélectionné (muté en place).
    `single` → sélection UNIQUE (choisir une valeur remplace la précédente). */
export interface FilterBarDimension {
  key: string;
  label: string;
  options: MultiItem[];
  selected: Set<string>;
  single?: boolean;
}

export class FilterBar {
  /** Groupe « + Filtre » + chips actifs, inséré par la vue APRÈS la recherche. */
  readonly filtersElement: HTMLElement;
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

    this.filtersElement = document.createElement("div");
    this.filtersElement.className = "lc-filters";

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

    // -- Chips actifs --
    this.chipsEl = document.createElement("div"); this.chipsEl.className = "lc-chips";

    // -- Réinitialiser (positionné à droite par la vue) --
    this.resetElement = document.createElement("button");
    this.resetElement.type = "button"; this.resetElement.className = "lc-reset btn btn-ghost btn-sm";
    this.resetElement.textContent = I18n.t("lists.chrome.filterReset");
    this.resetElement.onclick = () => this.resetAll();

    this.filtersElement.append(pop, this.chipsEl);
    this.buildMenu();
    this.syncChips();
  }

  /* ---- Menu « + Filtre » : un contrôle par dimension (MultiSelect ou select unique) ---- */

  private buildMenu(): void {
    this.menuEl.replaceChildren();
    this.singleSelects.clear();
    for (const dim of this.dims) {
      if (dim.single) this.menuEl.appendChild(this.buildSingle(dim));
      else this.menuEl.appendChild(MultiSelect.build(dim.label, dim.options, dim.selected, () => this.valueChanged()));
    }
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
    const chips = FilterChips.build(chipDims, (k) => this.dimByKey(k)?.selected);
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
    return this.dims.map((d) => ({ key: d.key, label: d.label, options: d.options }));
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
