import type { Store } from "../store";
import { Html } from "../core/Html";
import { Text } from "../core/Text";
import { Sort } from "../core/Sort";
import { FormControls } from "../ui/FormControls";
import { FilterBar, type FilterBarDimension } from "../ui/FilterBar";
import { Icons } from "../ui/Icons";
import { IconButton } from "../ui/IconButton";
import { RowMenu } from "../ui/RowMenu";
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_OPTIONS } from "../data/config";
import { I18n } from "../i18n/I18n";

export interface FilterOption { id: string; label: string; color?: string | null; }
export interface ListColumn {
  head: string;
  render: (o: any) => string;
  cls?: string;
  sort?: (o: any) => any;       // présent ⇒ colonne triable
  sortKey?: string;
  filter?: { label?: string; options: () => FilterOption[]; valueOf: (o: any) => any };
  /** Colonne ESSENTIELLE : seule conservée en mode « Compact » (cf. ListView). À défaut de toute colonne
      essentielle pour une collection, le mode compact retombe sur les 3 premières colonnes. */
  essential?: boolean;
}
export interface ListActions {
  view?: boolean; edit?: boolean; clone?: boolean; del?: boolean; locate?: boolean; download?: boolean; manage?: boolean;
  /** Raffinement PAR LIGNE de `locate` : le bouton « Localiser en 3D » n'est proposé que si ce prédicat accepte
      l'enregistrement (ex. équipement : localisable seulement s'il est rattaché à une salle — un équipement
      d'inventaire pur, posé sur plan d'étage ou dans une baie non placée n'aurait qu'un toast d'erreur). Absent
      → `locate` vaut pour toutes les lignes (comportement historique). */
  canLocate?: (id: string) => boolean;
}
export interface ListOptions {
  collection: string;
  columns: ListColumn[];
  searchFields?: (o: any) => any[];
  emptyText?: string;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  items?: () => any[];          // source CUSTOM (hors store)
  actions?: ListActions;
  onAction?: (act: string, id: string) => void;
  onCreate?: () => void;        // présent ⇒ bouton « + Nouveau »
  createLabel?: string;
  stateKey?: string;
}

/* =============================================================================
   ListView — table générique : tri (colonnes + dates), filtres multi-sélection,
   recherche, pagination. État (tri/filtres/recherche) PERSISTÉ en session.
   Réplique OO de la classe ListController du monolithe ; paramétrée par colonnes.
   ============================================================================= */
export class ListView {
  private store: Store;
  private container: HTMLElement;
  private collection: string;
  private columns: ListColumn[];
  private items: (() => any[]) | null;
  private searchFields?: (o: any) => any[];
  private emptyText: string;
  private actions: ListActions;
  private onAction?: (act: string, id: string) => void;
  private onCreate?: () => void;
  private createLabel: string;

  private query = "";
  private page = 1;
  private pageSize = PAGE_SIZE_DEFAULT;
  private sortKey: string;
  private sortDir: "asc" | "desc";
  private filterState: Record<string, Set<string>> = {};
  private _compact = false;       // mode compact : n'affiche que les colonnes essentielles (auto sur petit écran)
  private _stateKey: string;
  private _scaffold = false;
  private _toolbarSig: string | null = null;
  private _searchEl!: HTMLInputElement;
  private _filtersHostEl!: HTMLElement;   // hôte du groupe « + Filtre » + chips (rempli selon les colonnes filtrables)
  private _resetHostEl!: HTMLElement;      // hôte du bouton « Réinitialiser » (cluster de droite)
  private _filterBar: FilterBar | null = null;
  private _bodyEl!: HTMLElement;

  constructor(store: Store, container: HTMLElement, opts: ListOptions) {
    this.store = store;
    this.container = container;
    this.collection = opts.collection;
    this.columns = opts.columns;
    this.items = opts.items || null;
    this.searchFields = opts.searchFields;
    this.emptyText = opts.emptyText || I18n.t("lists.chrome.empty");
    this.actions = opts.actions || { view: true, edit: true, clone: true, del: true };
    this.onAction = opts.onAction;
    this.onCreate = opts.onCreate;
    this.createLabel = opts.createLabel || I18n.t("lists.chrome.create");
    this.sortKey = (opts.defaultSort && opts.defaultSort.key) || "__created__";
    this.sortDir = (opts.defaultSort && opts.defaultSort.dir) || "asc";
    this._stateKey = "dcmanager.list:" + (opts.stateKey || opts.collection || "list");
    // défaut COMPACT sur petit écran (mobile/tablette) ; surchargé par le choix utilisateur persisté (_loadState).
    this._compact = (typeof window !== "undefined" && window.innerWidth < 760);
    this._loadState();
  }

  /** Colonnes AFFICHÉES : toutes en mode normal ; en compact, les colonnes `essential` (repli : 3 premières). */
  private _visibleColumns(): ListColumn[] {
    if (!this._compact) return this.columns;
    const essential = this.columns.filter((c) => c.essential);
    return essential.length ? essential : this.columns.slice(0, 3);
  }

  private _loadState(): void {
    try {
      const raw = sessionStorage.getItem(this._stateKey); if (!raw) return;
      const s = JSON.parse(raw) || {};
      if (s.sortKey && this._sortOptions().some((o) => o.key === s.sortKey)) this.sortKey = s.sortKey;
      if (s.sortDir === "asc" || s.sortDir === "desc") this.sortDir = s.sortDir;
      if (typeof s.query === "string") this.query = s.query;
      if (typeof s.compact === "boolean") this._compact = s.compact;   // choix utilisateur prioritaire sur le défaut écran
      this.filterState = {};
      if (s.filters && typeof s.filters === "object") {
        Object.keys(s.filters).forEach((k) => { const arr = s.filters[k]; if (Array.isArray(arr) && arr.length) this.filterState[k] = new Set(arr.map(String)); });
      }
    } catch (_) { /* défauts */ }
  }
  private _saveState(): void {
    try {
      const filters: Record<string, string[]> = {};
      Object.keys(this.filterState).forEach((k) => { const set = this.filterState[k]; if (set && set.size) filters[k] = [...set]; });
      sessionStorage.setItem(this._stateKey, JSON.stringify({ sortKey: this.sortKey, sortDir: this.sortDir, query: this.query, filters, compact: this._compact }));
    } catch (_) { /* non bloquant */ }
  }

  private _colKey(c: ListColumn): string { return c.sortKey || ("col" + this.columns.indexOf(c)); }
  private _sortOptions(): { key: string; label: string }[] {
    const opts = this.columns.filter((c) => c.sort).map((c) => ({ key: this._colKey(c), label: c.head }));
    opts.push({ key: "__created__", label: I18n.t("lists.chrome.sortCreated") });
    opts.push({ key: "__updated__", label: I18n.t("lists.chrome.sortUpdated") });
    return opts;
  }
  private _sortRows(all: any[]): any[] {
    let valOf: (o: any) => any;
    if (this.sortKey === "__created__") valOf = (o) => o.created_date;
    else if (this.sortKey === "__updated__") valOf = (o) => o.updated_date;
    else { const c = this.columns.find((x) => x.sort && this._colKey(x) === this.sortKey); valOf = c ? c.sort! : (o) => o.created_date; }
    const dir = this.sortDir === "desc" ? -1 : 1;
    return all.map((o, i) => [o, i] as [any, number]).sort((a, b) => { const r = Sort.compare(valOf(a[0]), valOf(b[0])); return r !== 0 ? r * dir : (a[1] - b[1]); }).map((p) => p[0]);
  }

  render(): void {
    let all = this.items ? this.items() : this.store.all(this.collection);
    if (this.searchFields && this.query.trim()) {
      const q = Text.normSearch(this.query);
      all = all.filter((o) => this.searchFields!(o).some((v) => Text.normSearch(v).includes(q)));
    }
    this.columns.filter((c) => c.filter).forEach((c) => {
      const set = this.filterState[this._colKey(c)];
      if (!set || !set.size) return;
      all = all.filter((o) => {
        const v = c.filter!.valueOf(o);
        if (Array.isArray(v)) { const arr = v.length ? v : ["__none__"]; return arr.some((x) => set.has(String(x))); }
        return set.has(String(v == null || v === "" ? "__none__" : v));
      });
    });
    all = this._sortRows(all);
    const total = all.length, pages = Math.max(1, Math.ceil(total / this.pageSize));
    const page = Math.min(this.page, pages); this.page = page;
    const rows = all.slice((page - 1) * this.pageSize, page * this.pageSize);
    this._ensureScaffold();
    this._ensureToolbar();
    this._paintBody(rows, total, pages, page);
    this._saveState();
  }

  /** Bâtit UNE FOIS la barre de contrôles unifiée (revue design lot C) : recherche EN TÊTE (extensible,
      loupe intégrée), hôte des filtres (« + Filtre » + chips), puis le cluster de DROITE (compact, création,
      « Réinitialiser »). Le TRI n'est PAS en barre — il vit sur les EN-TÊTES de colonnes (`th.sortable`). Ce
      squelette n'est bâti qu'une fois : le champ de recherche garde ainsi son focus/anti-rebond à travers les
      re-rendus (seuls le corps et les chips sont repeints ensuite). */
  private _ensureScaffold(): void {
    if (this._scaffold && this.container.querySelector(".list-body")) return;
    this.container.innerHTML = "";
    const chrome = document.createElement("div"); chrome.className = "list-chrome";

    // Recherche EN PREMIER (action n°1), extensible : loupe intégrée + champ normalisé, à la hauteur unifiée.
    const search = document.createElement("div"); search.className = "lc-search";
    const icon = document.createElement("span"); icon.className = "lc-search-ic"; icon.setAttribute("aria-hidden", "true"); icon.innerHTML = Icons.SEARCH;
    this._searchEl = document.createElement("input"); this._searchEl.type = "search"; this._searchEl.className = "search-input";
    this._searchEl.placeholder = I18n.t("lists.chrome.searchPlaceholder");
    this._searchEl.setAttribute("aria-label", I18n.t("lists.chrome.searchPlaceholder"));
    search.append(icon, this._searchEl);
    chrome.appendChild(search);

    // Hôte des filtres (« + Filtre » + chips actifs) — (re)peuplé par _ensureToolbar selon les colonnes filtrables.
    this._filtersHostEl = document.createElement("div"); this._filtersHostEl.className = "lc-filters-host";
    chrome.appendChild(this._filtersHostEl);

    // Cluster de DROITE (poussé par CSS) : bascule Compact, bouton de création, puis « Réinitialiser » (le plus à droite).
    const right = document.createElement("div"); right.className = "lc-right";
    // bascule COMPACT : bascule booléenne → .toggle-pill (pilule + témoin + teinte) via la factory. La factory
    // met à jour son propre état visuel au clic ; l'état persiste à travers les re-rendus (this._compact).
    const compactBtn = FormControls.toggle(I18n.t("lists.chrome.compact"), this._compact, (v) => { this._compact = v; this.page = 1; this.render(); }, { title: I18n.t("lists.chrome.compactTitle") });
    compactBtn.classList.add("lc-compact");
    right.appendChild(compactBtn);
    if (this.onCreate) {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-primary btn-sm lc-create"; b.textContent = this.createLabel;
      b.onclick = () => this.onCreate!();
      right.appendChild(b);
    }
    this._resetHostEl = document.createElement("div"); this._resetHostEl.className = "lc-reset-host";
    right.appendChild(this._resetHostEl);
    chrome.appendChild(right);
    this.container.appendChild(chrome);

    this._bodyEl = document.createElement("div"); this._bodyEl.className = "list-body";
    this.container.appendChild(this._bodyEl);

    this._searchEl.value = this.query;
    let t: any;
    this._searchEl.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { this.query = this._searchEl.value; this.page = 1; this.render(); }, 180); });
    this._scaffold = true; this._toolbarSig = null; this._filterBar = null;
  }

  /** (Re)construit la FilterBar (« + Filtre » + chips + Réinitialiser) quand l'ensemble des OPTIONS filtrables
      change (signature) — jamais à chaque frappe/tri/page : un changement de VALEUR de filtre ne repeint que
      les chips (FilterBar) + le corps, laissant un panneau ouvert intact. Aucune colonne filtrable → hôtes vidés. */
  private _ensureToolbar(): void {
    const filterCols = this.columns.filter((c) => c.filter);
    const sig = filterCols.map((c) => (c.filter!.options() || []).map((o) => o.id).join(",")).join("|");
    if (this._toolbarSig === sig && this._filterBar) return;
    this._toolbarSig = sig;
    if (!filterCols.length) { this._filtersHostEl.replaceChildren(); this._resetHostEl.replaceChildren(); this._filterBar = null; return; }
    const dims: FilterBarDimension[] = filterCols.map((c) => {
      const key = this._colKey(c);
      if (!this.filterState[key]) this.filterState[key] = new Set();
      const set = this.filterState[key];
      const items = c.filter!.options() || [];
      const valid = new Set(items.map((i) => i.id));
      [...set].forEach((id) => { if (!valid.has(id)) set.delete(id); });   // purge des valeurs disparues (parité historique)
      return { key, label: c.filter!.label || c.head, options: items.slice(), selected: set };
    });
    this._filterBar = new FilterBar(dims, () => { this.page = 1; this.render(); });
    this._filtersHostEl.replaceChildren(this._filterBar.filtersElement);
    this._resetHostEl.replaceChildren(this._filterBar.resetElement);
  }

  /** Actions de ligne RÉDUITES à 3 boutons : Détails · Modifier · « plus d'actions » (menu overflow
      regroupant les actions secondaires : localiser, cloner, supprimer). L'overflow n'apparaît que s'il y a au
      moins une action secondaire active. Inspiré du listing des dépenses de l'app Compta.

      Icônes SVG du registre PARTAGÉ (`ui/Icons`) et bouton du constructeur PARTAGÉ (`ui/IconButton`) : mêmes
      dessins et même style que la page Certificats. Les glyphes de police d'origine (ⓘ ✎ ▦ ⋮) dépendaient de
      la police installée et ne s'alignaient pas sur la grille des traits. */
  private _rowActions(id: string): string {
    const a = this.actions;
    let html = `<span data-id="${id}">`;
    if (a.view) html += IconButton.html({ icon: Icons.INFO, label: I18n.t("lists.chrome.rowView"), act: "view" });
    if (a.manage) html += IconButton.html({ icon: Icons.RACK_CONTENT, label: I18n.t("lists.chrome.rowManage"), act: "manage" });   // éditeur de contenu de baie (inline, à côté de Détails)
    if (a.edit) html += IconButton.html({ icon: Icons.EDIT, label: I18n.t("lists.chrome.rowEdit"), act: "edit" });
    if (this._rowCanLocate(id) || a.clone || a.del || a.download) {
      const moreLbl = I18n.t("lists.chrome.rowMore");
      html += `<button type="button" class="btn btn-ghost btn-sm icon-action row-overflow" data-act="__more__" title="${moreLbl}" aria-label="${moreLbl}" aria-haspopup="menu" aria-expanded="false">${Icons.MORE}</button>`;
    }
    return html + "</span>";
  }

  /** `locate` effectif pour UNE ligne : action activée ET prédicat par ligne (s'il existe) satisfait. */
  private _rowCanLocate(id: string): boolean {
    return !!this.actions.locate && (!this.actions.canLocate || this.actions.canLocate(id));
  }

  /** Ouvre le menu « plus d'actions » (overflow) d'une ligne : actions secondaires actives, déléguées à onAction. */
  private _openRowMenu(trigger: HTMLElement, id: string): void {
    const a = this.actions;
    const items: { label: string; icon?: string; danger?: boolean; onClick: () => void }[] = [];
    // Icônes du registre PARTAGÉ : les emoji d'origine (📍 ⬇ ⧉) étaient des bitmaps COULEUR — ils
    // pixellisaient au zoom et ignoraient `currentColor`, donc la teinte « danger » du survol.
    if (this._rowCanLocate(id)) items.push({ label: I18n.t("lists.chrome.rowLocate"), icon: Icons.LOCATE, onClick: () => this.onAction && this.onAction("locate", id) });
    if (a.download) items.push({ label: I18n.t("lists.chrome.rowDownload"), icon: Icons.EXPORT, onClick: () => this.onAction && this.onAction("download", id) });
    if (a.clone) items.push({ label: I18n.t("lists.chrome.rowClone"), icon: Icons.CLONE, onClick: () => this.onAction && this.onAction("clone", id) });
    if (a.del) items.push({ label: I18n.t("ui.action.delete"), icon: Icons.DELETE, danger: true, onClick: () => this.onAction && this.onAction("del", id) });
    RowMenu.open(trigger, items);
  }

  private _paintBody(rows: any[], total: number, pages: number, page: number): void {
    this._bodyEl.classList.toggle("compact", this._compact);   // cellules plus denses en mode compact (CSS)
    const cols = this._visibleColumns();   // mode compact : sous-ensemble essentiel
    const head = cols.map((c) => {
      // L'en-tête porte la classe d'alignement de SA colonne (`cls`) : une colonne numérique (`cell-num`)
      // ancre ainsi son libellé ET son indicateur de tri au bord DROIT, aligné avec les valeurs de la colonne.
      if (!c.sort) return `<th class="${c.cls || ""}">${Html.escape(c.head)}</th>`;
      const key = this._colKey(c); const active = this.sortKey === key;
      const ind = active ? `<span class="sort-ind"> ${this.sortDir === "desc" ? "▼" : "▲"}</span>` : "";
      return `<th class="sortable${c.cls ? " " + c.cls : ""}" data-sortkey="${key}">${Html.escape(c.head)}${ind}</th>`;
    }).join("") + `<th class="cell-actions">${I18n.t("lists.chrome.actions")}</th>`;
    let bodyHtml: string;
    if (rows.length === 0) {
      bodyHtml = `<tr class="empty-row"><td colspan="${cols.length + 1}">${Html.escape(this.emptyText)}</td></tr>`;
    } else {
      bodyHtml = rows.map((o) => {
        const cells = cols.map((c) => `<td class="${c.cls || ""}">${c.render(o)}</td>`).join("");
        return `<tr>${cells}<td class="cell-actions">${this._rowActions(o.id)}</td></tr>`;
      }).join("");
    }
    this._bodyEl.innerHTML = `
      <div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${bodyHtml}</tbody></table></div>
      <div class="pagination">
        <div>${I18n.t("lists.chrome.count", { count: total, page, pages })}</div>
        <div class="pagination-controls">
          <button class="page-btn" data-pg="first" ${page <= 1 ? "disabled" : ""}>«</button>
          <button class="page-btn" data-pg="prev" ${page <= 1 ? "disabled" : ""}>‹</button>
          <span style="padding:0 6px;">${page} / ${pages}</span>
          <button class="page-btn" data-pg="next" ${page >= pages ? "disabled" : ""}>›</button>
          <button class="page-btn" data-pg="last" ${page >= pages ? "disabled" : ""}>»</button>
          <select class="page-size app-select">${PAGE_SIZE_OPTIONS.map((n) => `<option value="${n}" ${n === this.pageSize ? "selected" : ""}>${I18n.t("lists.chrome.pageSize", { n })}</option>`).join("")}</select>
        </div>
      </div>`;
    this._bodyEl.querySelectorAll("th.sortable").forEach((th) => {
      (th as HTMLElement).onclick = () => {
        const k = (th as any).dataset.sortkey;
        if (this.sortKey === k) this.sortDir = this.sortDir === "desc" ? "asc" : "desc";
        else { this.sortKey = k; this.sortDir = "asc"; }
        this.page = 1; this.render();
      };
    });
    this._bodyEl.querySelectorAll(".page-btn").forEach((b) => {
      (b as HTMLElement).onclick = () => {
        const act = (b as any).dataset.pg;
        if (act === "first") this.page = 1; else if (act === "prev") this.page = Math.max(1, page - 1);
        else if (act === "next") this.page = Math.min(pages, page + 1); else if (act === "last") this.page = pages;
        this.render();
      };
    });
    const sel = this._bodyEl.querySelector(".page-size") as HTMLSelectElement;
    if (sel) sel.onchange = () => { this.pageSize = parseInt(sel.value, 10); this.page = 1; this.render(); };
    // Délégation des actions de ligne → onAction(act, id). On cible `[data-act]`, PAS une classe de
    // style : l'attribut EST le contrat de la délégation (il porte l'action), la classe n'est qu'une
    // apparence. Cibler `.row-btn` couplait le câblage au style — le changer rendait les boutons inertes.
    this._bodyEl.querySelectorAll("[data-act]").forEach((b) => {
      (b as HTMLElement).onclick = (ev) => {
        const span = (b as HTMLElement).closest("[data-id]") as HTMLElement | null;
        const id = span ? (span as any).dataset.id : null;
        const act = (b as any).dataset.act;
        if (!id || !act) return;
        if (act === "__more__") { ev.stopPropagation(); this._openRowMenu(b as HTMLElement, id); return; }   // ouvre le menu overflow
        if (this.onAction) this.onAction(act, id);
      };
    });
  }
}
