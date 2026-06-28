import type { Store } from "../store";
import { Html } from "../core/Html";
import { Text } from "../core/Text";
import { Sort } from "../core/Sort";
import { MultiSelect } from "../ui/MultiSelect";
import { RowMenu } from "../ui/RowMenu";
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_OPTIONS } from "../data/config";

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
export interface ListActions { view?: boolean; edit?: boolean; clone?: boolean; del?: boolean; locate?: boolean; }
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
  private _toolbarEl!: HTMLElement;
  private _bodyEl!: HTMLElement;

  constructor(store: Store, container: HTMLElement, opts: ListOptions) {
    this.store = store;
    this.container = container;
    this.collection = opts.collection;
    this.columns = opts.columns;
    this.items = opts.items || null;
    this.searchFields = opts.searchFields;
    this.emptyText = opts.emptyText || "Aucun élément.";
    this.actions = opts.actions || { view: true, edit: true, clone: true, del: true };
    this.onAction = opts.onAction;
    this.onCreate = opts.onCreate;
    this.createLabel = opts.createLabel || "+ Nouveau";
    this.sortKey = (opts.defaultSort && opts.defaultSort.key) || "__created__";
    this.sortDir = (opts.defaultSort && opts.defaultSort.dir) || "asc";
    this._stateKey = "netmap.list:" + (opts.stateKey || opts.collection || "list");
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
    opts.push({ key: "__created__", label: "Date de création" });
    opts.push({ key: "__updated__", label: "Date de modification" });
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

  private _ensureScaffold(): void {
    if (this._scaffold && this.container.querySelector(".list-body")) return;
    this.container.innerHTML = `<div class="list-search" style="display:flex;gap:8px;align-items:center;padding:6px 8px"><input type="search" class="search-input" placeholder="Rechercher…" style="flex:1 1 auto"></div><div class="list-toolbar"></div><div class="list-body"></div>`;
    this._searchEl = this.container.querySelector(".list-search input") as HTMLInputElement;
    if (this.onCreate) {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-primary btn-sm"; b.textContent = this.createLabel;
      b.onclick = () => this.onCreate!();
      (this.container.querySelector(".list-search") as HTMLElement).appendChild(b);
    }
    this._toolbarEl = this.container.querySelector(".list-toolbar") as HTMLElement;
    this._bodyEl = this.container.querySelector(".list-body") as HTMLElement;
    this._searchEl.value = this.query;
    let t: any;
    this._searchEl.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { this.query = this._searchEl.value; this.page = 1; this.render(); }, 180); });
    this._scaffold = true; this._toolbarSig = null;
  }

  private _ensureToolbar(): void {
    const filterCols = this.columns.filter((c) => c.filter);
    const sig = filterCols.map((c) => (c.filter!.options() || []).map((o) => o.id).join(",")).join("|");
    if (this._toolbarSig === sig && this._toolbarEl.children.length) return;
    this._toolbarSig = sig;
    this._toolbarEl.innerHTML = "";
    const sg = document.createElement("div"); sg.className = "lt-group";
    const lbl = document.createElement("label"); lbl.textContent = "Trier";
    const sortSel = document.createElement("select"); sortSel.className = "sort-key app-select";
    this._sortOptions().forEach((o) => { const op = document.createElement("option"); op.value = o.key; op.textContent = o.label; sortSel.appendChild(op); });
    sortSel.value = this.sortKey;
    sortSel.onchange = () => { this.sortKey = sortSel.value; this.page = 1; this.render(); };
    const dirBtn = document.createElement("button"); dirBtn.type = "button"; dirBtn.className = "sort-dir-btn btn btn-ghost btn-sm";
    const setDir = () => { dirBtn.textContent = this.sortDir === "desc" ? "▼ Décroissant" : "▲ Croissant"; };
    setDir();
    dirBtn.onclick = () => { this.sortDir = this.sortDir === "desc" ? "asc" : "desc"; setDir(); this.page = 1; this.render(); };
    sg.appendChild(lbl); sg.appendChild(sortSel); sg.appendChild(dirBtn);
    // bascule COMPACT (colonnes essentielles seulement). Persiste son état ; persiste à travers les re-rendus du body.
    const compactBtn = document.createElement("button"); compactBtn.type = "button"; compactBtn.className = "lt-compact btn btn-ghost btn-sm";
    const setC = () => { compactBtn.textContent = "Compact"; compactBtn.classList.toggle("active", this._compact); compactBtn.title = this._compact ? "Afficher toutes les colonnes" : "N'afficher que les colonnes essentielles"; };
    setC();
    compactBtn.onclick = () => { this._compact = !this._compact; setC(); this.page = 1; this.render(); };
    sg.appendChild(compactBtn);
    this._toolbarEl.appendChild(sg);
    if (filterCols.length) {
      const fg = document.createElement("div"); fg.className = "lt-filters";
      const fl = document.createElement("span"); fl.className = "lt-flabel"; fl.textContent = "Filtrer"; fg.appendChild(fl);
      filterCols.forEach((c) => {
        const key = this._colKey(c);
        if (!this.filterState[key]) this.filterState[key] = new Set();
        const set = this.filterState[key];
        const items = c.filter!.options() || [];
        const valid = new Set(items.map((i) => i.id));
        [...set].forEach((id) => { if (!valid.has(id)) set.delete(id); });
        fg.appendChild(MultiSelect.build(c.filter!.label || c.head, items, set, () => { this.page = 1; this.render(); }));
      });
      const reset = document.createElement("button"); reset.type = "button"; reset.className = "lt-reset btn btn-ghost btn-sm"; reset.textContent = "Réinit. filtres";
      reset.onclick = () => { Object.values(this.filterState).forEach((s) => s.clear()); this._toolbarSig = null; this.page = 1; this.render(); };
      fg.appendChild(reset);
      this._toolbarEl.appendChild(fg);
    }
  }

  /** Actions de ligne RÉDUITES à 3 boutons : Détails (ⓘ) · Modifier (✎) · « plus d'actions » (⋮ → menu overflow
      regroupant les actions secondaires : localiser, cloner, supprimer). Le ⋮ n'apparaît que s'il y a au moins une
      action secondaire active. Inspiré du listing des dépenses de l'app Compta. */
  private _rowActions(id: string): string {
    const a = this.actions;
    const btn = (act: string, title: string, txt: string) => `<button class="row-btn" data-act="${act}" title="${title}">${txt}</button>`;
    let html = `<span data-id="${id}">`;
    if (a.view) html += btn("view", "Détails", "ⓘ");
    if (a.edit) html += btn("edit", "Modifier", "✎");
    if (a.locate || a.clone || a.del) html += `<button class="row-btn row-overflow" data-act="__more__" title="Plus d'actions" aria-haspopup="menu" aria-expanded="false">⋮</button>`;
    return html + "</span>";
  }

  /** Ouvre le menu « plus d'actions » (overflow) d'une ligne : actions secondaires actives, déléguées à onAction. */
  private _openRowMenu(trigger: HTMLElement, id: string): void {
    const a = this.actions;
    const items: { label: string; icon?: string; danger?: boolean; onClick: () => void }[] = [];
    if (a.locate) items.push({ label: "Localiser en 3D", icon: "📍", onClick: () => this.onAction && this.onAction("locate", id) });
    if (a.clone) items.push({ label: "Cloner", icon: "⧉", onClick: () => this.onAction && this.onAction("clone", id) });
    if (a.del) items.push({ label: "Supprimer", icon: "×", danger: true, onClick: () => this.onAction && this.onAction("del", id) });
    RowMenu.open(trigger, items);
  }

  private _paintBody(rows: any[], total: number, pages: number, page: number): void {
    this._bodyEl.classList.toggle("compact", this._compact);   // cellules plus denses en mode compact (CSS)
    const cols = this._visibleColumns();   // mode compact : sous-ensemble essentiel
    const head = cols.map((c) => {
      if (!c.sort) return `<th>${Html.escape(c.head)}</th>`;
      const key = this._colKey(c); const active = this.sortKey === key;
      const ind = active ? `<span class="sort-ind"> ${this.sortDir === "desc" ? "▼" : "▲"}</span>` : "";
      return `<th class="sortable" data-sortkey="${key}">${Html.escape(c.head)}${ind}</th>`;
    }).join("") + `<th>Actions</th>`;
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
        <div>${total} élément${total > 1 ? "s" : ""} · page ${page}/${pages}</div>
        <div class="pagination-controls">
          <button class="page-btn" data-pg="first" ${page <= 1 ? "disabled" : ""}>«</button>
          <button class="page-btn" data-pg="prev" ${page <= 1 ? "disabled" : ""}>‹</button>
          <span style="padding:0 6px;">${page} / ${pages}</span>
          <button class="page-btn" data-pg="next" ${page >= pages ? "disabled" : ""}>›</button>
          <button class="page-btn" data-pg="last" ${page >= pages ? "disabled" : ""}>»</button>
          <select class="page-size app-select">${PAGE_SIZE_OPTIONS.map((n) => `<option value="${n}" ${n === this.pageSize ? "selected" : ""}>${n}/page</option>`).join("")}</select>
        </div>
      </div>`;
    this._bodyEl.querySelectorAll("th.sortable").forEach((th) => {
      (th as HTMLElement).onclick = () => {
        const k = (th as any).dataset.sortkey;
        if (this.sortKey === k) this.sortDir = this.sortDir === "desc" ? "asc" : "desc";
        else { this.sortKey = k; this.sortDir = "asc"; }
        const sk = this._toolbarEl.querySelector(".sort-key") as HTMLSelectElement; if (sk) sk.value = this.sortKey;
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
    // délégation des actions de ligne → onAction(act, id)
    this._bodyEl.querySelectorAll(".row-btn").forEach((b) => {
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
