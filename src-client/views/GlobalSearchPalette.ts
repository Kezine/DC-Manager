/* =============================================================================
   GlobalSearchPalette — la MODALE DÉDIÉE de recherche globale (Ctrl+K).

   Composant À PART ENTIÈRE (maquette POC validée le 2026-07-30) — et non un
   `SearchPop` dans la modale standard : la recherche N'EST PAS un formulaire,
   c'est une surface de navigation. Elle possède donc son propre overlay
   (`.gs-overlay`, jamais la classe `.modal-overlay` : la garde clavier du
   bootstrap et la modale de l'app raisonnent sur ce sélecteur), sa zone de
   résultats défilante, ses filtres de PORTÉE, son état d'accueil (récents +
   préfixes) et son pied de raccourcis.

   CE QU'ELLE FAIT :
   - portées cliquables (pastilles à COMPTES) + PRÉFIXES saisissables
     (« eq:sw-01 » filtre les équipements et cherche « sw-01 ») + Tab pour
     cycler ;
   - groupes par famille JAMAIS entrelacés, ordonnés par pertinence, fragment
     trouvé SURLIGNÉ (<mark>) dans le titre / la sous-ligne / le chemin ;
   - ↑/↓ + Entrée, survol = sélection, clic fond = fermeture, Échap ;
   - accueil : CONSULTÉS RÉCEMMENT (localStorage, par navigateur — même
     politique que la préférence « haute densité » des façades) + pastilles
     d'astuce des préfixes ;
   - ouvrir un résultat = FERMER la palette puis `Forms.detail` (le point
     d'entrée unique des fiches) — la fiche s'ouvre dans la modale STANDARD,
     les deux overlays ne coexistent jamais.

   Elle porte AUSSI la portée « ACTIONS » (préfixe « > », maquette) : des
   COMMANDES injectées par le bootstrap (créer un équipement, basculer le thème…)
   fondues au même corpus — même score, mêmes groupes, mêmes comptes ; seule
   l'ACTIVATION diverge (une action s'EXÉCUTE, elle ne s'ouvre pas). Famille
   synthétique `__actions`, HORS de l'invariant corpus ≡ fiches (entités seules).

   CE QU'ELLE NE FAIT PAS, à dessein :
   - le geste PRIMAIRE d'un résultat d'entité reste la FICHE — « Localiser » est
     un bouton secondaire gardé par les prédicats, la vue Datacenter garde sa
     propre recherche ;
   - pas de portées Certificats / Interventions (maquette) en v1 : données API
     paginées hors du Store — chantier à part, la structure les accueillera.

   Le CORPUS est un SNAPSHOT pris à l'ouverture (volumes réels : des centaines) ;
   une écriture concurrente pendant que la palette est ouverte n'est pas
   reflétée — assumé, elle vit quelques secondes.
   ============================================================================= */
import type { Store } from "../store";
import { GlobalSearch, type GlobalSearchItem } from "../core/GlobalSearch";
import { GlobalSearchSources } from "./GlobalSearchSources";
import { Schema } from "../../src-shared/Schema";
import { Forms, type FormHost } from "./Forms";
import { Html } from "../core/Html";
import { Icons } from "../ui/Icons";
import { OverlayA11y } from "../ui/OverlayA11y";
import { I18n } from "../i18n/I18n";

/** Entrée de l'historique « consultés récemment » (localStorage). */
interface RecentEntry { kind: string; id: string; }

/** Une ACTION de la palette (portée « Actions », préfixe « > ») : un libellé cherchable + un effet.
    Injectées par le bootstrap — la palette ne connaît AUCUNE action, comme elle ne connaît pas la 3D. */
export interface SearchAction {
  id: string;
  label: string;
  /** Sous-ligne descriptive (facultative), cherchable au palier 30 comme celle des entités. */
  sub?: string;
  /** Termes annexes (synonymes : « thème », « dark »…). */
  terms?: readonly unknown[];
  run: () => void;
}

/** Famille SYNTHÉTIQUE des actions. ⚠ PAS une collection : elle vit HORS de `GlobalSearchSources`
    (dont l'invariant corpus ≡ fiches ouvrables ne concerne que les ENTITÉS) — une action ne
    s'« ouvre » pas, elle S'EXÉCUTE. D'où le préfixe « __ » : impossible à confondre avec une collection. */
const ACTIONS_KIND = "__actions";

export class GlobalSearchPalette {
  /** Clé localStorage des consultations récentes — préférence PAR NAVIGATEUR, comme
      `dcmanager.facePreviewDense` (jamais dans le document : ce n'est pas une donnée du modèle). */
  private static readonly RECENTS_KEY = "dcmanager.gsearchRecents";
  private static readonly RECENTS_MAX = 5;

  private overlay: HTMLElement | null = null;
  private input!: HTMLInputElement;
  private clearBtn!: HTMLButtonElement;
  private scopesEl!: HTMLElement;
  private resultsEl!: HTMLElement;
  private countEl!: HTMLElement;

  private corpus: GlobalSearchItem[] = [];
  private scope = "all";
  private sel = 0;
  /** Résultats À PLAT dans l'ordre affiché (les groupes ne sont qu'un habillage) — cible de ↑/↓/Entrée. */
  private rows: GlobalSearchItem[] = [];
  private restoreFocus: HTMLElement | null = null;
  /** Écouteur clavier DOCUMENT, posé à l'ouverture et retiré à la fermeture (jamais résident). */
  private readonly onKeydown = (e: KeyboardEvent): void => this.handleKey(e);

  /** `onLocate` (facultatif) : « Localiser en 3D » un résultat — câblé par le bootstrap sur le même
      flux que les listes (switch vue Datacenter + `dcView.locate` + action de retour). Absent = les
      boutons Localiser ne sont pas rendus (mode visualiseur sans 3D, tests headless).
      `actions` (facultatif) : les commandes de la portée « Actions » (préfixe « > ») — injectées,
      la palette n'en connaît aucune. Absent/vide = ni portée ni pastille Actions. */
  constructor(private readonly store: Store, private readonly host: FormHost,
    private readonly onLocate?: (kind: "equipment" | "rack" | "cable", id: string) => void,
    private readonly actions: readonly SearchAction[] = []) {}

  /** Portée d'une famille, actions comprises — le seul endroit où la famille synthétique se mappe. */
  private static scopeOfKind(kind: string): string {
    return kind === ACTIONS_KIND ? "actions" : GlobalSearchSources.scopeOf(kind);
  }

  isOpen(): boolean { return !!this.overlay && this.overlay.classList.contains("open"); }
  toggle(): void { this.isOpen() ? this.close() : this.open(); }

  open(): void {
    if (!this.overlay) this.buildDom();
    // snapshot des ENTITÉS + les ACTIONS injectées, fondues au même corpus : le score, les groupes et
    // les comptes les traitent comme n'importe quelle famille — seule l'ACTIVATION diverge (run, pas fiche).
    this.corpus = [
      ...GlobalSearchSources.build(this.store),
      ...this.actions.map((a) => ({ kind: ACTIONS_KIND, id: a.id, label: a.label, sub: a.sub, terms: a.terms || [] })),
    ];
    this.scope = "all"; this.sel = 0; this.input.value = "";
    this.restoreFocus = (document.activeElement as HTMLElement) || null;
    this.overlay!.classList.add("open");
    OverlayA11y.lockScroll();
    document.addEventListener("keydown", this.onKeydown, true);
    this.render();
    setTimeout(() => this.input.focus(), 20);
  }

  close(): void {
    if (!this.isOpen()) return;
    this.overlay!.classList.remove("open");
    OverlayA11y.unlockScroll();
    document.removeEventListener("keydown", this.onKeydown, true);
    this.corpus = [];   // libère le snapshot (la palette peut rester montée longtemps)
    if (this.restoreFocus && this.restoreFocus.isConnected) this.restoreFocus.focus();
    this.restoreFocus = null;
  }

  /* ---- montage (une seule fois — l'overlay persiste caché, comme la modale de l'app) ---- */

  private buildDom(): void {
    const overlay = document.createElement("div");
    overlay.className = "gs-overlay";
    overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", I18n.t("search.title"));
    // clic sur le FOND = fermeture (mousedown : un drag qui finit hors du panneau ne ferme pas).
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) this.close(); });

    const box = document.createElement("div"); box.className = "gsearch";

    // -- rangée de saisie : loupe · champ · ✕ · Échap --
    const inputRow = document.createElement("div"); inputRow.className = "gs-input-row";
    const lens = document.createElement("span"); lens.className = "gs-lens"; lens.setAttribute("aria-hidden", "true"); lens.innerHTML = Icons.SEARCH;
    this.input = document.createElement("input");
    this.input.type = "text"; this.input.id = OverlayA11y.nextId("gsearch");
    this.input.autocomplete = "off"; this.input.spellcheck = false;
    this.input.className = "gs-input";
    this.input.placeholder = I18n.t("search.placeholder");
    this.input.setAttribute("role", "combobox"); this.input.setAttribute("aria-expanded", "true");
    this.input.addEventListener("input", () => { this.sel = 0; this.render(); });
    this.clearBtn = document.createElement("button");
    this.clearBtn.type = "button"; this.clearBtn.className = "gs-clear"; this.clearBtn.innerHTML = Icons.CLOSE;
    this.clearBtn.title = I18n.t("ui.search.clear"); this.clearBtn.setAttribute("aria-label", I18n.t("ui.search.clear"));
    this.clearBtn.onclick = () => { this.input.value = ""; this.scope = "all"; this.sel = 0; this.render(); this.input.focus(); };
    const esc = document.createElement("span"); esc.className = "gs-kbd"; esc.textContent = I18n.t("search.kbd.esc");
    inputRow.append(lens, this.input, this.clearBtn, esc);

    // -- portées + résultats + pied --
    this.scopesEl = document.createElement("div"); this.scopesEl.className = "gs-scopes"; this.scopesEl.setAttribute("role", "tablist");
    this.scopesEl.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("[data-scope]") as HTMLElement | null;
      if (!btn) return;
      this.scope = btn.dataset.scope!; this.sel = 0; this.render(); this.input.focus();
    });
    this.resultsEl = document.createElement("div"); this.resultsEl.className = "gs-results";
    this.resultsEl.id = this.input.id + "-list"; this.resultsEl.setAttribute("role", "listbox");
    this.input.setAttribute("aria-controls", this.resultsEl.id);
    // survol = sélection (parité maquette) ; clic = activation. Délégué : la liste est re-rendue à chaque frappe.
    this.resultsEl.addEventListener("mousemove", (e) => {
      const row = (e.target as HTMLElement).closest(".gs-res[data-i]") as HTMLElement | null;
      if (!row) return;
      const at = +row.dataset.i!;
      if (at !== this.sel) { this.sel = at; this.paintSelection(); }
    });
    this.resultsEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      // « Localiser » AVANT la rangée : le bouton est DANS la rangée, le test de rangée l'avalerait.
      const locate = target.closest(".gs-locate[data-i]") as HTMLElement | null;
      if (locate && this.onLocate) {
        const item = this.rows[+locate.dataset.i!];
        if (item && item.locate) { this.recordRecent({ kind: item.kind, id: item.id }); this.close(); this.onLocate(item.locate.kind, item.locate.id); }
        return;
      }
      const row = target.closest(".gs-res[data-i]") as HTMLElement | null;
      if (row) { this.activate(this.rows[+row.dataset.i!]); return; }
      const tip = target.closest(".gs-tip[data-prefix]") as HTMLElement | null;
      if (tip) { this.input.value = tip.dataset.prefix!; this.sel = 0; this.render(); this.input.focus(); return; }
      const recent = target.closest(".gs-res[data-recent]") as HTMLElement | null;
      if (recent) { const found = this.corpus.find((x) => x.kind + ":" + x.id === recent.dataset.recent); if (found) this.activate(found); }
    });

    const foot = document.createElement("div"); foot.className = "gs-foot";
    const hint = (kbd: string, label: string) => `<span class="gs-f"><span class="gs-kbd">${Html.escape(kbd)}</span> ${Html.escape(label)}</span>`;
    this.countEl = document.createElement("span"); this.countEl.className = "gs-f";
    foot.innerHTML = hint("↑ ↓", I18n.t("search.kbd.navigate")) + hint("↵", I18n.t("search.kbd.open")) + hint("Tab", I18n.t("search.kbd.nextScope")) + `<span class="gs-spacer"></span>`;
    foot.appendChild(this.countEl);

    box.append(inputRow, this.scopesEl, this.resultsEl, foot);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    this.overlay = overlay;
  }

  /* ---- clavier (écouteur document, actif palette ouverte seulement) ---- */

  private handleKey(e: KeyboardEvent): void {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); this.close(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); this.move(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); this.move(-1); return; }
    if (e.key === "Enter") { if (this.rows[this.sel]) { e.preventDefault(); this.activate(this.rows[this.sel]); } return; }
    if (e.key === "Tab") {
      // Tab CYCLE les portées (maquette) — il ne quitte pas la palette : le seul autre focus utile est
      // le champ lui-même, et Maj+Tab remonte le cycle.
      e.preventDefault();
      const ids = ["all", ...GlobalSearchSources.SCOPES.map((s) => s.id), ...(this.actions.length ? ["actions"] : [])];
      const at = ids.indexOf(this.scope);
      this.scope = ids[(at + (e.shiftKey ? -1 : 1) + ids.length) % ids.length];
      this.sel = 0; this.render();
    }
  }

  private move(delta: number): void {
    if (!this.rows.length) return;
    this.sel = (this.sel + delta + this.rows.length) % this.rows.length;
    this.paintSelection();
  }

  /* ---- rendu ---- */

  private render(): void {
    const raw = this.input.value.trim();
    // Préfixe de portée saisi (« eq:sw-01 ») : il ACTIVE la portée et disparaît de la requête.
    // « > » (maquette) s'ajoute aux préfixes des portées d'entités — seulement si des actions existent.
    const prefixes = this.actions.length ? { ...GlobalSearchSources.prefixes(), ">": "actions" } : GlobalSearchSources.prefixes();
    const parsed = GlobalSearch.parsePrefix(raw, prefixes);
    if (parsed.scope) this.scope = parsed.scope;
    const query = parsed.query;
    this.clearBtn.classList.toggle("show", raw.length > 0);

    this.renderScopes(query);

    // État d'ACCUEIL : ni requête ni portée — récents + astuces, jamais « tout le corpus ».
    if (!Schema.normSearch(query) && this.scope === "all") {
      this.rows = [];
      this.resultsEl.innerHTML = this.welcomeHtml();
      this.countEl.textContent = "";
      return;
    }

    const groups = GlobalSearch.rank(this.corpus, query, { normalize: Schema.normSearch, kindOrder: [...GlobalSearchSources.FAMILY_ORDER, ACTIONS_KIND] })
      .filter((g) => this.scope === "all" || GlobalSearchPalette.scopeOfKind(g.kind) === this.scope);
    this.rows = groups.flatMap((g) => g.items);
    if (this.sel >= this.rows.length) this.sel = 0;

    if (!this.rows.length) {
      this.resultsEl.innerHTML = `<div class="gs-empty">${Icons.SEARCH}
        <div class="gs-empty-t">${I18n.t("search.emptyTitle", { query: Html.escape(query || "—") })}</div>
        <div class="gs-empty-s">${Html.escape(I18n.t("search.emptyText"))}</div></div>`;
      this.countEl.textContent = I18n.t("search.countNone");
      return;
    }

    let html = ""; let at = 0;
    for (const group of groups) {
      html += `<div class="gs-group">${Html.escape(I18n.t("search.family." + group.kind))}</div>`;
      for (const item of group.items) { html += this.rowHtml(item, at, query); at++; }
    }
    this.resultsEl.innerHTML = html;
    this.countEl.textContent = I18n.t(this.rows.length > 1 ? "search.countMany" : "search.countOne", { n: this.rows.length });
    this.paintSelection();
  }

  /** Une rangée de résultat — titre/sous-ligne/chemin SURLIGNÉS, icône de la portée de sa famille,
      pastille d'état, bouton « Localiser » si la cible est localisable ET le câblage fourni.
      ⚠ `<div role="option">`, PAS un `<button>` : la rangée CONTIENT désormais un bouton (Localiser),
      et un bouton dans un bouton est du HTML invalide (le navigateur éjecte l'intérieur). Le clavier
      ne perd rien : ↑/↓/Entrée vivent sur le CHAMP (pattern listbox), jamais sur les rangées. */
  private rowHtml(item: GlobalSearchItem, index: number, query: string): string {
    const scopeId = GlobalSearchPalette.scopeOfKind(item.kind);
    const icon = item.kind === ACTIONS_KIND ? Icons.COMMAND : (GlobalSearchSources.SCOPES.find((s) => s.id === scopeId)?.icon || Icons.SEARCH);
    const subBits = [this.highlight(item.sub || "", query), this.highlight(item.path || "", query)].filter(Boolean);
    const pill = item.pill ? `<span class="gs-pill${item.pill.tone ? " " + item.pill.tone : ""}">${Html.escape(item.pill.text)}</span>` : "";
    const locate = (item.locate && this.onLocate)
      ? `<button type="button" class="gs-locate" data-i="${index}" title="${Html.escape(I18n.t("lists.chrome.rowLocate"))}" aria-label="${Html.escape(I18n.t("lists.chrome.rowLocate"))}">${Icons.LOCATE}</button>`
      : "";
    return `<div class="gs-res" data-i="${index}" data-gscope="${Html.escape(scopeId)}" role="option" aria-selected="false">
      <span class="gs-res-ic">${icon}</span>
      <span class="gs-res-main">
        <span class="gs-res-t">${this.highlight(item.label, query)}</span>
        ${subBits.length ? `<span class="gs-res-s">${subBits.join(`<span class="gs-sep">·</span>`)}</span>` : ""}
      </span>
      <span class="gs-res-meta">${pill}${locate}<span class="gs-res-enter gs-kbd">↵</span></span>
    </div>`;
  }

  /** Texte ÉCHAPPÉ avec le fragment trouvé en <mark> ("" si texte vide). L'échappement se fait par
      SEGMENT, autour du marqueur — jamais après coup (un <mark> injecté serait ré-échappé). */
  private highlight(text: string, query: string): string {
    if (!text) return "";
    const match = GlobalSearch.matchRange(text, query, Schema.normSearch);
    if (!match) return Html.escape(text);
    return Html.escape(text.slice(0, match.start)) + "<mark>" + Html.escape(text.slice(match.start, match.end)) + "</mark>" + Html.escape(text.slice(match.end));
  }

  /** Pastilles de portée : « Tout » + une par portée, avec le COMPTE de ce qu'elle offrirait. */
  private renderScopes(query: string): void {
    const byKind = GlobalSearch.countByKind(this.corpus, query, Schema.normSearch);
    const countOf = (scope: SearchScopeLike): number => scope.kinds.reduce((n, k) => n + (byKind[k] || 0), 0);
    const total = Object.values(byKind).reduce((a, b) => a + b, 0);
    const pill = (id: string, icon: string, label: string, n: number): string =>
      `<button type="button" class="gs-scope${this.scope === id ? " active" : ""}" data-scope="${id}" role="tab" aria-selected="${this.scope === id}">${icon}${Html.escape(label)}<span class="gs-n">${n}</span></button>`;
    this.scopesEl.innerHTML = pill("all", "", I18n.t("search.scope.all"), total)
      + GlobalSearchSources.SCOPES.map((s) => pill(s.id, s.icon, I18n.t("search.scope." + s.id), countOf(s))).join("")
      + (this.actions.length ? pill("actions", Icons.COMMAND, I18n.t("search.scope.actions"), byKind[ACTIONS_KIND] || 0) : "");
  }

  /** Accueil : consultés récemment (résolus contre le corpus — les disparus sont écartés) + préfixes. */
  private welcomeHtml(): string {
    const recents = this.readRecents()
      .map((r) => this.corpus.find((x) => x.kind === r.kind && x.id === r.id))
      .filter((x): x is GlobalSearchItem => !!x);
    let html = "";
    if (recents.length) {
      html += `<div class="gs-group">${Html.escape(I18n.t("search.recents"))}</div>`;
      html += recents.map((item) => {
        const scopeId = GlobalSearchSources.scopeOf(item.kind);
        const icon = GlobalSearchSources.SCOPES.find((s) => s.id === scopeId)?.icon || Icons.SEARCH;
        return `<button type="button" class="gs-res" data-recent="${Html.escape(item.kind + ":" + item.id)}" data-gscope="${Html.escape(scopeId)}">
          <span class="gs-res-ic">${icon}</span>
          <span class="gs-res-main"><span class="gs-res-t">${Html.escape(item.label)}</span>${item.sub || item.path ? `<span class="gs-res-s">${Html.escape([item.sub, item.path].filter(Boolean).join(" · "))}</span>` : ""}</span>
        </button>`;
      }).join("");
    }
    html += `<div class="gs-empty gs-welcome"><div class="gs-empty-s">${Html.escape(I18n.t("search.welcome"))}</div>
      <div class="gs-tips">${GlobalSearchSources.SCOPES.map((s) =>
        `<button type="button" class="gs-tip" data-prefix="${Html.escape(s.prefix)}"><b>${Html.escape(s.prefix)}</b> ${Html.escape(I18n.t("search.scope." + s.id))}</button>`).join("")}${this.actions.length
        ? `<button type="button" class="gs-tip" data-prefix="&gt;"><b>&gt;</b> ${Html.escape(I18n.t("search.scope.actions"))}</button>` : ""}
      </div></div>`;
    return html;
  }

  /** Re-peint la SÉLECTION seule (survol/flèches) — sans reconstruire la liste. */
  private paintSelection(): void {
    const rows = this.resultsEl.querySelectorAll(".gs-res[data-i]");
    rows.forEach((el) => {
      const on = +(el as HTMLElement).dataset.i! === this.sel;
      el.classList.toggle("sel", on);
      el.setAttribute("aria-selected", String(on));
    });
    const active = this.resultsEl.querySelector(".gs-res.sel");
    if (active) (active as any).scrollIntoView?.({ block: "nearest" });
  }

  /* ---- activation + récents ---- */

  private activate(item: GlobalSearchItem | undefined): void {
    if (!item) return;
    if (item.kind === ACTIONS_KIND) {
      // Une action S'EXÉCUTE — pas de fiche, et pas de « récents » (on ne CONSULTE pas une action ;
      // l'y mettre ferait en plus échouer sa résolution au prochain accueil si les actions changent).
      const action = this.actions.find((a) => a.id === item.id);
      this.close();
      action?.run();
      return;
    }
    this.recordRecent({ kind: item.kind, id: item.id });
    this.close();
    // `detail` rend false pour une collection sans fiche — IMPOSSIBLE ici par construction
    // (invariant familles ≡ DETAIL_COLLECTIONS, testé), donc pas de repli à écrire.
    Forms.detail(this.store, this.host, item.kind, item.id);
  }

  private readRecents(): RecentEntry[] {
    try {
      const raw = window.localStorage.getItem(GlobalSearchPalette.RECENTS_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.kind === "string" && typeof r.id === "string") : [];
    } catch (_) { return []; }
  }

  private recordRecent(entry: RecentEntry): void {
    const next = [entry, ...this.readRecents().filter((r) => !(r.kind === entry.kind && r.id === entry.id))]
      .slice(0, GlobalSearchPalette.RECENTS_MAX);
    try { window.localStorage.setItem(GlobalSearchPalette.RECENTS_KEY, JSON.stringify(next)); } catch (_) { /* quota → ignoré */ }
  }
}

/** Forme minimale d'une portée pour le compte (évite d'exporter le type interne). */
interface SearchScopeLike { kinds: readonly string[]; }
