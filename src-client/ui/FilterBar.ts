import { MultiSelect, type MultiItem } from "./MultiSelect";
import { FormControls } from "./FormControls";
import { SearchPop, type SearchPopResult, type SearchPopHostState } from "./SearchPop";
import { Icons } from "./Icons";
import { Html } from "../core/Html";
import { I18n } from "../i18n/I18n";
import { FilterChips, type ChipDimension, type FilterChip } from "../core/FilterChips";
import { TargetFilterDisplay } from "../core/TargetFilterDisplay";
import { EntityCandidates } from "../core/EntityCandidates";

/* =============================================================================
   FilterBar — barre de FILTRES unifiée des listings (revue design lot C). Vocabulaire
   COMMUN aux trois listings (ListView générique, Interventions, Certificats) :

     • les filtres ACTIFS s'affichent en CHIPS supprimables (« Type : Switch × »),
       un chip par VALEUR sélectionnée (modèle pur `FilterChips`) ;
     • un bouton « + Filtre » ouvre le CHOIX de dimension → le panneau `MultiSelect`
       EXISTANT de la dimension (principe n°14 : on RÉUTILISE le composant maison,
       on n'en réinvente pas un) ; une dimension à sélection UNIQUE (ex. l'état des
       certificats, que le serveur n'accepte qu'en un exemplaire) tombe sur un
       `<select>` maison ; une dimension « à RECHERCHE » (filtre CIBLE unifié :
       « les câbles de SW-Coeur ») est un DÉCLENCHEUR FERMÉ comme les autres
       (`.multi-trigger` + badge (Tous)/nom/compteur) qui ouvre un PANNEAU-PORTAIL
       à champ de recherche (`SearchPop` HÉBERGÉ — refonte 2026-08-03, maquette
       design-system/briefs/filtre-cible-porteur-maquette, cf. `buildSearch`) — la
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
  /** Libellé d'AFFICHAGE d'une valeur choisie (chip, badge du déclencheur, rangée « valeur
      courante » du panneau), résolu à CHAQUE rendu — jamais persisté : l'entité peut avoir été
      renommée, ou supprimée (rendre null → repli sur l'identifiant). */
  labelOf: (valueId: string) => string | null;
  /** Badge de FAMILLE d'une valeur choisie (rangée « valeur courante » du panneau — même pastille
      `.dc-search-tag` que les résultats). Absent ou "" → aucune pastille (famille unique : elle
      n'apprendrait rien, parité `ListTargets.cableEquipment`). */
  tagOf?: (valueId: string) => string;
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
  /** Rafraîchisseurs des BADGES des déclencheurs « à recherche » — invoqués par `syncChips` (le
      badge reflète la sélection au même rythme que les chips), reconstruits par `buildMenu`. */
  private readonly searchTriggerRefreshers: Array<() => void> = [];

  /** Fermeture des menus « + Filtre » au clic extérieur — un SEUL écouteur global (comme MultiSelect),
      pour éviter d'accumuler des écouteurs au fil des reconstructions de barres. */
  private static wired = false;

  /** BORNE de cibles d'une dimension « à recherche » — 1 en v1 (mono : choisir REMPLACE). Le
      panneau, l'état (`Set`), les chips et le badge savent DÉJÀ compter au-delà (maquette §4) :
      passer au multi (OR) = lever cette borne — le placeholder bascule alors sur « Ajouter… » et
      le ✕ d'une valeur devient un retrait unitaire, sans autre changement. */
  private static readonly SEARCH_MAX_TARGETS = 1;

  /** PANNEAU « à recherche » ouvert — UN à la fois, toutes barres confondues (même politique que
      les menus). Statique : le panneau vit sur `<body>`, hors de l'arbre de la barre. */
  private static searchPanel: { trigger: HTMLElement; close: (focusTrigger: boolean) => void } | null = null;

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
    // Un clic sur une AUTRE dimension du menu (MultiSelect, select unique) ferme le panneau « à
    // recherche » — en CAPTURE : les déclencheurs MultiSelect stoppent la propagation (bulle), la
    // capture passe AVANT eux. Le déclencheur du panneau (`.tf-pop`) gère lui-même son toggle.
    this.menuEl.addEventListener("click", (e) => {
      if (!(e.target instanceof Element) || !e.target.closest(".tf-pop")) FilterBar.closeSearchPanel(false);
    }, true);
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
    FilterBar.closeSearchPanel(false);   // le panneau est ANCRÉ à un déclencheur qu'on va repeindre
    this.menuEl.replaceChildren();
    this.singleSelects.clear();
    this.searchTriggerRefreshers.length = 0;
    for (const dim of this.dims) {
      if (dim.search) this.menuEl.appendChild(this.buildSearch(dim));
      else if (dim.single) this.menuEl.appendChild(this.buildSingle(dim));
      else this.menuEl.appendChild(MultiSelect.build(dim.label, dim.options, dim.selected, () => this.valueChanged()));
    }
  }

  /** Dimension « à RECHERCHE » (refonte 2026-08-03, maquette briefs/filtre-cible-porteur-maquette) :
      un déclencheur FERMÉ comme les autres dimensions — `.multi-trigger` + `.count-badge`, badge =
      (Tous) / NOM de la cible / compteur, résolu par le module PUR `core/TargetFilterDisplay` (testé).
      L'ouverture ne déroule pas une liste cochable mais le PANNEAU à champ de recherche
      (`openSearchPanel`). Avant la refonte, la dimension était un champ NU (`.lc-single` + SearchPop
      compact) dont le popover débordait du menu (380 px vs 200 px) — deux langages visuels dans le
      même menu ; le déclencheur fermé n'en laisse qu'un. */
  private buildSearch(dim: FilterBarDimension): HTMLElement {
    const wrap = document.createElement("div"); wrap.className = "tf-pop";
    const trigger = document.createElement("button");
    trigger.type = "button"; trigger.className = "multi-trigger";
    trigger.setAttribute("aria-haspopup", "dialog");   // le panneau est un dialog, pas un listbox
    trigger.setAttribute("aria-expanded", "false");
    const refreshTrigger = () => {
      trigger.innerHTML = Html.escape(dim.label)
        + ' <span class="count-badge">' + Html.escape(this.searchBadge(dim)) + "</span>";
    };
    refreshTrigger();
    this.searchTriggerRefreshers.push(refreshTrigger);
    trigger.onclick = (e) => {
      e.stopPropagation();
      // Toggle : re-cliquer le déclencheur d'un panneau ouvert le ferme (focus rendu au bouton).
      if (FilterBar.searchPanel && FilterBar.searchPanel.trigger === trigger) { FilterBar.closeSearchPanel(true); return; }
      this.openSearchPanel(dim, trigger, refreshTrigger);
    };
    wrap.appendChild(trigger);
    return wrap;
  }

  /** Texte du badge du déclencheur « à recherche » : la RÈGLE (Tous / nom / compteur, repli sur
      l'identifiant) vit dans le module pur `TargetFilterDisplay` — ici, seulement l'i18n. */
  private searchBadge(dim: FilterBarDimension): string {
    const badge = TargetFilterDisplay.badge([...dim.selected], (valueId) => dim.search!.labelOf(valueId));
    if (badge.kind === "name") return badge.label;
    if (badge.kind === "count") return String(badge.count);
    return I18n.t("ui.multiselect.all");
  }

  /** Ouvre le PANNEAU d'une dimension « à recherche » (maquette filtre-cible §3/§5/§6) : coque
      `.tf-panel` de 320 px portée sur `<body>` (`.dc-pop-portal`, piste A — le menu « + Filtre »
      garde ses 200 px, le panneau déborde volontairement et proprement) et ANCRÉE au déclencheur
      par la règle partagée `SearchPop.portalPlace` (retournement haut/bas, recadrage viewport).
      Contenu : section « valeur courante » (effaçable SANS fermer), champ + liste (SearchPop en
      mode HÉBERGÉ — anti-rebond/StaleGate/clavier/ARIA restent dans le composant, principe n°14),
      états d'habillage (invite, squelette, vide) et pied (aides clavier, plafond).
      CHOISIR pose le filtre (mono v1 : remplace) et ferme panneau + menu — le geste est terminé,
      comme avec l'ancien champ du menu. Échap ferme le panneau SEUL et rend le focus au
      déclencheur ; le clic extérieur ferme panneau ET menu (écouteur global `ensureWired`). */
  private openSearchPanel(dim: FilterBarDimension, trigger: HTMLButtonElement, refreshTrigger: () => void): void {
    FilterBar.closeSearchPanel(false);
    document.querySelectorAll(".multi-panel.open").forEach((p) => p.classList.remove("open"));   // un seul panneau ouvert
    const source = dim.search!;

    const panel = document.createElement("div");
    panel.className = "tf-panel open dc-pop-portal";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", I18n.t("lists.chrome.targetPanelLabel", { dim: dim.label }));
    panel.addEventListener("click", (e) => e.stopPropagation());   // un clic DANS le panneau ne ferme ni lui ni le menu

    // -- Squelette du panneau : valeur courante · champ · liste/squelette/invite · pied --
    const currentSec = document.createElement("div"); currentSec.className = "tf-sec";
    const fieldSec = document.createElement("div"); fieldSec.className = "tf-sec";
    const field = document.createElement("div"); field.className = "tf-field";
    const lens = document.createElement("span"); lens.className = "tf-lens";
    lens.setAttribute("aria-hidden", "true"); lens.innerHTML = Icons.SEARCH;
    field.appendChild(lens);   // l'input est INSÉRÉ à sa suite par le SearchPop hébergé
    fieldSec.appendChild(field);
    const list = document.createElement("div"); list.className = "tf-list";
    const skeleton = document.createElement("div"); skeleton.className = "tf-list";
    for (let i = 0; i < 3; i++) {
      const row = document.createElement("div"); row.className = "tf-skel";
      row.innerHTML = '<i class="t"></i><i class="n"></i>';
      skeleton.appendChild(row);
    }
    const empty = document.createElement("div"); empty.className = "tf-empty";
    const foot = document.createElement("div"); foot.className = "tf-foot";
    const capped = document.createElement("span");
    const keys = document.createElement("span");
    keys.innerHTML = '<span class="tf-kbd">↑↓</span> ' + Html.escape(I18n.t("lists.chrome.targetKeyBrowse"))
      + ' <span class="tf-kbd">↵</span> ' + Html.escape(I18n.t("lists.chrome.targetKeyPick"))
      + ' <span class="tf-kbd">' + Html.escape(I18n.t("lists.chrome.targetKeyEsc")) + "</span> "
      + Html.escape(I18n.t("lists.chrome.targetKeyClose"));
    foot.append(capped, keys);
    panel.append(currentSec, fieldSec, list, skeleton, empty, foot);
    document.body.appendChild(panel);
    trigger.setAttribute("aria-expanded", "true");

    const reposition = () => SearchPop.portalPlace(trigger, panel);

    /** Placeholder du champ : dimension / « Remplacer par… » / « Ajouter… » — règle pure. */
    const placeholderText = () => {
      const kind = TargetFilterDisplay.placeholder(dim.selected.size, FilterBar.SEARCH_MAX_TARGETS);
      return kind === "replace" ? I18n.t("lists.chrome.targetReplace")
        : kind === "add" ? I18n.t("lists.chrome.targetAdd")
        : source.placeholder;
    };

    /** Habillage des ÉTATS (le SearchPop hébergé annonce, le panneau peint — maquette §6). */
    const paintState = (state: SearchPopHostState, query: string, count: number) => {
      // Chargement : des résultats DÉJÀ affichés restent visibles (« ne blanchit jamais », parité
      // listings/palette) — le squelette ne se montre que sur une liste encore vide.
      const showList = state === "results" || (state === "loading" && list.childElementCount > 0);
      list.style.display = showList ? "" : "none";
      skeleton.style.display = state === "loading" && !showList ? "" : "none";
      empty.style.display = state === "idle" || state === "empty" ? "" : "none";
      if (state === "empty") empty.textContent = I18n.t("lists.chrome.targetNoResult", { q: query });
      else if (state === "idle") empty.textContent = I18n.t("lists.chrome.targetIdle");
      foot.style.display = state === "results" ? "" : "none";
      // Plafond ATTEINT (candidats bornés partout par EntityCandidates.SEARCH_LIMIT) : « affinez ».
      const isCapped = state === "results" && count >= EntityCandidates.SEARCH_LIMIT;
      capped.style.display = isCapped ? "" : "none";
      if (isCapped) capped.textContent = I18n.t("lists.chrome.targetCapped", { count });
      reposition();   // la hauteur du panneau suit son contenu → on re-ancre à chaque état
    };

    const searchPop = new SearchPop({
      placeholder: placeholderText(),
      minChars: source.minChars != null ? source.minChars : 1,
      ...(source.debounceMs != null ? { debounceMs: source.debounceMs } : {}),
      // Décoration « déjà pris » (maquette §4) : un candidat DÉJÀ sélectionné reste visible mais
      // non cliquable — dès le mono, la cible COURANTE s'annonce au lieu de « réussir » pour rien.
      fetch: (query) => Promise.resolve(source.fetch(query)).then((results) => results.map((r) =>
        dim.selected.has(r.id) ? { ...r, disabled: true, itemClass: "is-on", tail: I18n.t("lists.chrome.targetTaken") } : r)),
      onPick: (result) => {
        dim.selected.clear();               // MONO v1 (SEARCH_MAX_TARGETS = 1) : la nouvelle cible REMPLACE
        dim.selected.add(result.id);
        FilterBar.closeAllMenus();          // le geste est terminé — le menu masquerait la chip apparue
        this.valueChanged();
      },
      host: { field, list, onState: paintState },
    });

    /** Rangées de la VALEUR COURANTE (« on voit ce qu'on remplace », esprit EntityPicker) : badge
        de famille + nom + ✕. Le ✕ VIDE le filtre SANS fermer le panneau (décision maquette §3) —
        on reste là pour chercher la suivante. */
    const paintCurrent = () => {
      currentSec.replaceChildren();
      const ids = [...dim.selected];
      if (!ids.length) { currentSec.style.display = "none"; return; }
      currentSec.style.display = "";
      const heading = document.createElement("div"); heading.className = "tf-lb";
      heading.textContent = I18n.t("lists.chrome.targetSelected", { count: ids.length });
      currentSec.appendChild(heading);
      for (const valueId of ids) {
        const row = document.createElement("div"); row.className = "tf-cur";
        const family = source.tagOf ? source.tagOf(valueId) : "";
        if (family) {
          const tag = document.createElement("span"); tag.className = "dc-search-tag"; tag.textContent = family;
          row.appendChild(tag);
        }
        const label = source.labelOf(valueId) || valueId;   // même repli que les chips : jamais une rangée vide
        const name = document.createElement("span"); name.className = "tf-cur-nm";
        name.textContent = label; name.title = label;
        const remove = document.createElement("button");
        remove.type = "button"; remove.className = "tf-cur-x";
        remove.setAttribute("aria-label", I18n.t("lists.chrome.targetRemove", { value: label }));
        remove.innerHTML = Icons.CLOSE;
        remove.onclick = () => {
          dim.selected.delete(valueId);
          paintCurrent();
          searchPop.setPlaceholder(placeholderText());
          searchPop.refresh();          // les items affichés portent une décoration « déjà pris » caduque
          this.valueChanged();          // chips + badge (syncChips invoque les rafraîchisseurs) + corps
          reposition();
          searchPop.focus();
        };
        row.append(name, remove);
        currentSec.appendChild(row);
      }
    };
    paintCurrent();
    paintState("idle", "", 0);

    // Échap N'IMPORTE OÙ dans le panneau : ferme le panneau SEUL, focus rendu au déclencheur
    // (accessibilité maquette §10) — le menu reste ouvert, on peut choisir une autre dimension.
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.stopPropagation(); FilterBar.closeSearchPanel(true); }
    });

    // SUIVI scroll/resize (capture : les défilements INTERNES comptent) — même politique que le
    // popover portail du SearchPop. Déclencheur disparu (repeint) → fermeture, jamais d'orphelin.
    const follow = () => { if (!trigger.isConnected) { FilterBar.closeSearchPanel(false); return; } reposition(); };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);

    FilterBar.searchPanel = {
      trigger,
      close: (focusTrigger: boolean) => {
        window.removeEventListener("scroll", follow, true);
        window.removeEventListener("resize", follow);
        panel.remove();
        trigger.setAttribute("aria-expanded", "false");
        if (focusTrigger) trigger.focus();
      },
    };
    reposition();
    searchPop.focus();
  }

  /** Ferme le panneau « à recherche » ouvert (s'il y en a un). `focusTrigger` : Échap et le re-clic
      du déclencheur RENDENT le focus au bouton ; un clic extérieur non (le focus va où l'on clique). */
  private static closeSearchPanel(focusTrigger: boolean): void {
    const open = FilterBar.searchPanel;
    if (!open) return;
    FilterBar.searchPanel = null;   // AVANT close() : un close réentrant (closeAllMenus) ne boucle pas
    open.close(focusTrigger);
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
    // Badges des déclencheurs « à recherche » : ils REFLÈTENT la sélection (Tous / nom / compteur)
    // au même rythme que les chips — sans reconstruire le menu (un panneau ouvert reste intact).
    for (const refresh of this.searchTriggerRefreshers) refresh();
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
    // Le panneau « à recherche » vit sur <body>, ANCRÉ à un déclencheur du menu : il suit le sort
    // des menus (clic extérieur, bascule du bouton « + Filtre ») — une seule mécanique de fermeture.
    FilterBar.closeSearchPanel(false);
    document.querySelectorAll(".lc-addfilter-menu.open").forEach((m) => {
      m.classList.remove("open");
      const btn = m.parentElement?.querySelector(".lc-addfilter-btn");
      btn?.setAttribute("aria-expanded", "false");
    });
  }
}
