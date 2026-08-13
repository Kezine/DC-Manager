import type { Store } from "../store";
import { Html } from "../core/Html";
import { Text } from "../core/Text";
import { Sort } from "../core/Sort";
import { TargetSearch } from "../core/TargetSearch";
import { RecordSearchIndex } from "../core/RecordSearchIndex";
import { ListRowEngine, type ListRowRequest, type ListRowServerSort, type ListRowSource, type ListRowTarget } from "../core/ListRowEngine";
import { ListServerSort } from "../core/ListServerSort";
import { StoreListRowSource, type RemoteListReader } from "../core/StoreListRowSource";
import { CollectionFacetCache } from "../core/CollectionFacetCache";
import { EntityCandidateSource } from "../core/EntityCandidates";
import { FormControls } from "../ui/FormControls";
import { FilterBar, type FilterBarDimension } from "../ui/FilterBar";
import type { SearchPopResult } from "../ui/SearchPop";
import { Icons } from "../ui/Icons";
import { IconButton } from "../ui/IconButton";
import { RowMenu } from "../ui/RowMenu";
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_OPTIONS } from "../data/config";
import { I18n } from "../i18n/I18n";
import type { ListTargetFilter } from "./ListTargets";

export interface FilterOption { id: string; label: string; color?: string | null; }
export interface ListColumn {
  head: string;
  render: (o: any) => string;
  cls?: string;
  sort?: (o: any) => any;       // présent ⇒ colonne triable
  sortKey?: string;
  /** Champ SERVEUR du critère de tri (OPT-IN — pagination ORDONNÉE complète, lot 1b lazy-load) : nom
      d'un champ scalaire du modèle, à déclarer quand l'accesseur `sort` lit CE champ (jamais déduit :
      beaucoup d'accesseurs sont dérivés — occupation, chemin — sans colonne SQL en face). En régime
      pagé, le critère ordonne alors le CORPUS entier via l'ORDER BY serveur ; sans `sortField`, repli
      assumé = tri de la page reçue (cf. `core/ListServerSort` et docs/hydratation.md § « Vague 1 »).
      Sans effet hors régime pagé (collections hydratées, mode fichier : tri client local, inchangé). */
  sortField?: string;
  /** Filtre d'ÉNUMÉRATION de la colonne. `options()` construit les valeurs proposées (typiquement un
      balayage du cache) et `valueOf` extrait, d'une ligne, la valeur à comparer.
      `field` (OPT-IN — garde G8, vague 3 du lazy-load) : nom du champ SCALAIRE du modèle que lit
      `valueOf`, à déclarer quand c'est le cas. En régime pagé (collection chargée paresseusement en
      mode API), les options viennent alors d'un `SELECT DISTINCT` SERVEUR — sans quoi elles ne
      proposeraient que les valeurs des pages parcourues. Jamais déduit : beaucoup de `valueOf` sont
      dérivés (un nom d'équipement RÉSOLU par jointure cliente) et n'ont aucune colonne en face ; sans
      `field`, repli assumé = options du cache (cf. docs/hydratation.md § « Vague 1 », G8). Sans effet
      hors régime pagé (collections hydratées, mode fichier : options locales exactes, inchangées). */
  filter?: { label?: string; options: () => FilterOption[]; valueOf: (o: any) => any; field?: string };
  /** Colonne ESSENTIELLE : seule conservée en mode « Compact » (cf. ListView). À défaut de toute colonne
      essentielle pour une collection, le mode compact retombe sur les 3 premières colonnes. */
  essential?: boolean;
}
export interface ListActions {
  view?: boolean; edit?: boolean; clone?: boolean; del?: boolean; locate?: boolean; download?: boolean; manage?: boolean;
  /** « Afficher » (viewer intégré) : action du MENU de ligne, placée AVANT « Télécharger » (cadrage B, D-B4).
      Réservée aux pièces jointes visualisables → raffinée PAR LIGNE via `canShow` (cf. `AttachmentViewKind`).
      Déléguée à `onAction("show", id)` comme `download` (le viewer vit hors du Store — cf. TabOpts.onShow). */
  show?: boolean;
  /** Raffinement PAR LIGNE de `locate` : le bouton « Localiser en 3D » n'est proposé que si ce prédicat accepte
      l'enregistrement (ex. équipement : localisable seulement s'il est rattaché à une salle — un équipement
      d'inventaire pur, posé sur plan d'étage ou dans une baie non placée n'aurait qu'un toast d'erreur). Absent
      → `locate` vaut pour toutes les lignes (comportement historique). */
  canLocate?: (id: string) => boolean;
  /** Raffinement PAR LIGNE de `show` : « Afficher » n'apparaît que si ce prédicat accepte l'enregistrement
      (type visualisable). Absent → `show` vaut pour toutes les lignes. */
  canShow?: (id: string) => boolean;
}
export interface ListOptions {
  collection: string;
  columns: ListColumn[];
  /** Champs cherchés — RÉSERVÉ aux sources CUSTOM (`items`, hors collections du document). Les listings
      adossés au Store n'en ont plus : leur recherche passe par le moteur PARTAGÉ (`core/RecordSearch`,
      la MÊME assiette que la colonne `search` du serveur). Une source custom, elle, n'a aucune spec
      partagée — et la bibliothèque d'images porte une data URL entière (`FaceImage.data`) qui n'a rien
      à faire dans un texte cherchable : le relevé explicite reste la bonne réponse pour elle. */
  searchFields?: (o: any) => any[];
  emptyText?: string;
  defaultSort?: { key: string; dir: "asc" | "desc" };
  items?: () => any[];          // source CUSTOM (hors store)
  /** Dimension CIBLE « à recherche » de ce listing (filtre par entité : « les câbles de SW-Coeur ») —
      absente = pas de filtre par cible. Ignorée sur une source CUSTOM (aucune entité du modèle). */
  targetFilter?: ListTargetFilter;
  /** Lecteur SERVEUR (mode API seulement, injecté par le bootstrap) : présent, la recherche et les
      filtres serveur-mappables interrogent le serveur ; absent = mode FICHIER, jamais de réseau. */
  remoteList?: RemoteListReader | null;
  actions?: ListActions;
  onAction?: (act: string, id: string) => void;
  /** Ouvre la fiche d'une AUTRE entité référencée DANS une cellule (élément `data-open-col`/`data-open-id`), ex.
      le nom d'équipement dans la liaison d'un câble. Indépendant des actions de ligne (`onAction`, liées à la ligne). */
  onOpenEntity?: (collection: string, id: string) => void;
  onCreate?: () => void;        // présent ⇒ bouton « + Nouveau »
  createLabel?: string;
  stateKey?: string;
}

/* =============================================================================
   ListView — table générique : tri (colonnes + dates), filtres multi-sélection,
   recherche, pagination. État (tri/filtres/recherche) PERSISTÉ en session.
   Réplique OO de la classe ListController du monolithe ; paramétrée par colonnes.

   D'OÙ VIENNENT LES LIGNES (lot 3 « recherche partagée ») : plus du `store.all()`
   direct, mais d'un MOTEUR à source injectée (`core/ListRowEngine`) —
     • la RECHERCHE passe par le moteur PARTAGÉ (`core/RecordSearch`, mémoïsé par
       `core/RecordSearchIndex`) : l'assiette cherchée est EXACTEMENT celle de la
       colonne `search` du serveur, donc les deux modes répondent la même chose
       par construction (et non plus le relevé ad hoc des `searchFields`, plus
       pauvre et divergent) ;
     • en mode API, une requête ACTIVE (recherche saisie ou cible serveur-mappable)
       est servie par le SERVEUR, avec anti-rebond + annulation + repli local ;
       sans requête active, le cache hydraté suffit et rien ne part sur le réseau ;
     • en mode FICHIER, aucun réseau n'existe : le moteur reste local (n°15).
   Le TRI et la PAGINATION restent CLIENT (limite v1 documentée : le jeu serveur
   est plafonné, cf. `StoreListRowSource.REMOTE_LIMIT`).

   EXCEPTION — PAGER SERVEUR RÉEL (garde G4 du chantier lazy-load, cf.
   docs/hydratation.md) : quand la collection n'est PAS hydratée (chargement
   PARESSEUX en mode API), il n'y a rien à paginer en mémoire. Le moteur sert
   alors des PAGES SERVEUR (`page()`), avec le TOTAL réel (`COUNT(*)`) et une
   navigation qui va chercher CHAQUE page. Ce que la vue en fait de moins :
   aucune arithmétique de pagination (les compteurs viennent du serveur). Le
   TRI y est SERVEUR depuis la PAGINATION ORDONNÉE COMPLÈTE (lot 1b) : le
   critère actif est mappé en champ du modèle (`core/ListServerSort` — critères
   de date intrinsèques + colonnes déclarant leur `sortField`) et l'ORDER BY
   ordonne le CORPUS entier ; la vue affiche alors la page DANS L'ORDRE REÇU
   (la retrier localement contredirait la découpe aux frontières de pages).
   Critère NON mappable (colonne sans `sortField`) : repli assumé du pilote —
   tri client de la page reçue, découpe à l'ordre serveur par défaut. Les
   filtres de colonne, eux, restent appliqués à la PAGE reçue (limite
   documentée). Changer de critère/direction repart page 1, comme tout
   changement de tri (`this.page = 1` aux trois points d'entrée du tri). Les
   listings des collections hydratées ne changent PAS d'un pixel : `page()` y
   rend `null`.
   ============================================================================= */
export class ListView {
  /** Clé de la dimension CIBLE dans l'état de filtres. Préfixe « __ » : impossible à confondre avec
      une clé de colonne (`sortKey` ou « col<i> »), y compris dans l'état persisté en session. */
  private static readonly TARGET_DIM_KEY = "__target__";

  // ⚠ Le Store n'est PLUS un champ : depuis le lot 3, la vue ne lit jamais les collections elle-même —
  // elle passe par le moteur de lignes, dont la SOURCE est injectée (`core/StoreListRowSource`). Le
  // constructeur ne s'en sert donc que pour CÂBLER ce moteur, l'index de recherche et l'invalidation.
  private container: HTMLElement;
  private collection: string;
  private columns: ListColumn[];
  private items: (() => any[]) | null;
  private searchFields?: (o: any) => any[];
  private targetFilter: ListTargetFilter | null;
  /** Index MÉMOÏSÉ des textes cherchables (mode fichier ET affichage local du mode API). */
  private readonly searchIndex: RecordSearchIndex;
  /** Moteur de lignes (source injectée : cache local / serveur) — absent sur une source CUSTOM. */
  private readonly rowEngine: ListRowEngine | null;
  /** La SOURCE du listing, gardée à part du moteur : les LIGNES passent par le moteur (anti-rebond,
      annulation, pagination), les OPTIONS de facette (G8) s'adressent directement à la source — elles
      n'ont ni requête, ni vol, ni page. Absente sur une source CUSTOM (aucune collection derrière). */
  private readonly rowSource: ListRowSource | null;
  private emptyText: string;
  private actions: ListActions;
  private onAction?: (act: string, id: string) => void;
  private onOpenEntity?: (collection: string, id: string) => void;
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
  private _sortSelEl!: HTMLSelectElement;   // sélecteur de CRITÈRE de tri EN BARRE (état partagé avec les en-têtes)
  private _sortDirEl!: HTMLButtonElement;   // bouton de SENS dédié (▲/▼) — bascule asc/desc
  private _filtersHostEl!: HTMLElement;   // hôte du bouton « + Filtre » (DEVANT la recherche — revue 2026-07-30)
  private _chipsHostEl!: HTMLElement;     // hôte de la RANGÉE de chips (à la ligne, fin de barre, display:contents)
  private _resetHostEl!: HTMLElement;      // hôte du bouton « Réinitialiser » (cluster de droite)
  private _filterBar: FilterBar | null = null;
  private _bodyEl!: HTMLElement;

  constructor(store: Store, container: HTMLElement, opts: ListOptions) {
    this.container = container;
    this.collection = opts.collection;
    this.columns = opts.columns;
    this.items = opts.items || null;
    this.searchFields = opts.searchFields;
    // Source CUSTOM (`items`) : aucune entité du modèle derrière les lignes → ni cible, ni moteur.
    this.targetFilter = (!this.items && opts.targetFilter) ? opts.targetFilter : null;
    this.searchIndex = new RecordSearchIndex(
      (collection, id) => store.get(collection, id),
      (collection, field, value) => store.findByField(collection, field, value),
    );
    this.rowSource = this.items ? null : new StoreListRowSource(store, this.searchIndex, this.targetFilter, opts.remoteList || null);
    this.rowEngine = this.rowSource ? new ListRowEngine(
      this.rowSource,
      () => this.render({ typing: true }),   // réponse serveur : on repeint SANS jeter l'index (rien n'a muté)
    ) : null;
    // Filet d'invalidation : une écriture qui ne repasse pas par ce listing (SSE, autre onglet) rendrait
    // l'index périmé — et un index périmé, c'est une recherche qui ment (cf. RecordSearchIndex).
    // Même filet pour la PAGE serveur en main (G4) : une création ou une suppression déplace les lignes
    // ET change le total — garder la page reçue, ce serait afficher un état que le serveur n'a plus.
    store.onChange(() => { this.searchIndex.invalidate(); this.rowEngine?.forgetPage(); });
    this.emptyText = opts.emptyText || I18n.t("lists.chrome.empty");
    this.actions = opts.actions || { view: true, edit: true, clone: true, del: true };
    this.onAction = opts.onAction;
    this.onOpenEntity = opts.onOpenEntity;
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

  /** Recale le TRI EN BARRE (select de critère + bouton de sens) sur l'état de tri UNIQUE. Appelé à chaque
      rendu : quel que soit l'ORIGINE du changement (select, bouton de sens, ou clic d'en-tête qui repasse par
      render()), les deux contrôles reflètent this.sortKey/this.sortDir → synchronisation bidirectionnelle. */
  private _syncSortControls(): void {
    if (this._sortSelEl) this._sortSelEl.value = this.sortKey;
    if (this._sortDirEl) {
      const asc = this.sortDir !== "desc";
      this._sortDirEl.textContent = asc ? "▲" : "▼";   // même langage visuel que l'indicateur d'en-tête (.sort-ind)
      const label = I18n.t(asc ? "lists.chrome.dirAsc" : "lists.chrome.dirDesc");
      this._sortDirEl.setAttribute("aria-label", label);
      this._sortDirEl.title = label;
    }
  }

  /** CIBLE filtrée (dimension « à recherche »), ou null. La valeur persistée est une clé « kind:id »
      qu'on ne présume jamais saine (état de session d'une version antérieure, entité disparue). */
  private _targetValue(): ListRowTarget | null {
    if (!this.targetFilter) return null;
    const set = this.filterState[ListView.TARGET_DIM_KEY];
    if (!set || !set.size) return null;
    return TargetSearch.parse([...set][0]);
  }

  /** POSE la dimension CIBLE sur une valeur donnée, DEPUIS L'EXTÉRIEUR — c'est ce qu'exige un
      « Afficher plus » de rangée de fiche (« montre-moi les X de CET équipement »), qui arrive par
      `shell.switchView(...)` puis appelle ici.
      Pourquoi une méthode et non une mutation de l'état par l'appelant : `filterState` est privé, et
      surtout la barre de filtres tient une RÉFÉRENCE sur le `Set` de chaque dimension — on le MUTE
      donc en place (jamais de remplacement d'objet, qui laisserait la chip branchée sur l'ancien) et
      on lui redemande de repeindre ses chips, qu'un simple `render()` ne touche pas (il ne reconstruit
      la barre que si l'ensemble des OPTIONS a changé).
      MONO-VALEUR : la dimension cible l'est par construction — on remplace, on n'ajoute pas.
      No-op si ce listing ne déclare aucune dimension cible. */
  focusTarget(kind: string, id: string): void {
    if (!this.targetFilter) return;
    let set = this.filterState[ListView.TARGET_DIM_KEY];
    if (!set) { set = new Set(); this.filterState[ListView.TARGET_DIM_KEY] = set; }
    set.clear();
    set.add(TargetSearch.key(kind, id));
    this.page = 1;
    this.render();                  // bâtit le squelette et la barre si le listing n'a jamais été peint
    this._filterBar?.syncChips();   // la chip retirable : la barre ne voit pas une mutation externe
  }

  /** Oublie la PAGE serveur en main (régime pagé, G4) : le prochain rendu la redemandera. Point d'entrée
      de l'HÔTE pour le cas que le listing ne peut pas voir tout seul — un événement SSE portant sur une
      collection chargée PARESSEUSEMENT (G3 saute son rechargement, donc `store.onChange` ne part PAS et
      le filet de l'abonnement ci-dessus ne joue pas), alors que la page reçue est bel et bien périmée.
      Ce n'est PAS un contournement de G3 : on ne re-tire pas la collection, on redemande UNE page — ce
      que le pager fait de toute façon à chaque navigation. No-op hors régime pagé.
      Cf. docs/hydratation.md § « Vague 2 ». */
  forgetServerPage(): void { this.rowEngine?.forgetPage(); }

  /** Repeint après l'ARRIVÉE de valeurs de facette serveur (G8) : la barre de filtres se reconstruit
      d'elle-même, sa signature d'options ayant changé (`_ensureToolbar`). `typing: true` — rien n'a
      muté dans le document, l'index de recherche mémoïsé survit (même sémantique qu'une réponse de
      recherche serveur). Point d'entrée de l'HÔTE, câblé sur `Store.onFacetResolved` (main.ts), comme
      `forgetServerPage` l'est sur `onLazyReloadDeferred`. */
  refreshFacetOptions(): void { this.render({ typing: true }); }

  /** Options d'un filtre de COLONNE pour l'état courant — LE point où G8 bascule.
      - régime SERVEUR (collection lazy + `field` déclaré + source qui le propose) : les valeurs
        distinctes du CORPUS, UNIES aux valeurs SÉLECTIONNÉES. Cette union n'est pas cosmétique : les
        valeurs arrivent en asynchrone, et `_ensureToolbar` PURGE de l'état tout ce qui n'est pas une
        option — sans elle, un filtre restauré de la session serait effacé au premier rendu, en
        silence, avant même la réponse du serveur (cf. `CollectionFacetCache.withSelected`) ;
      - sinon : les options déclarées par la colonne, mot pour mot (les 20+ listings hydratés et le
        mode fichier ne changent pas d'un pixel).
      Le LIBELLÉ d'une valeur serveur EST sa valeur : une facette distincte porte des chaînes brutes
      (SSID, type de raccordement), comme le fait déjà le calcul local qu'elle remplace. */
  private _filterOptions(column: ListColumn): FilterOption[] {
    const filter = column.filter!;
    const field = filter.field;
    const serverValues = (field && this.rowSource?.facetOptions) ? this.rowSource.facetOptions(this.collection, field) : null;
    if (!serverValues) return filter.options() || [];
    const selected = this.filterState[this._colKey(column)];
    return CollectionFacetCache.withSelected(serverValues, selected || []).map((value) => ({ id: value, label: value }));
  }

  /** Lignes BRUTES du listing (avant filtres de colonne, tri et pagination).
      - source CUSTOM (`items`, hors collections du document) : chemin HISTORIQUE inchangé — relevé
        `searchFields` explicite, jamais le moteur partagé (cf. `ListOptions.searchFields`) ;
      - collection du document : le MOTEUR décide local ⇄ serveur (cf. l'en-tête de la classe). */
  private _collectRows(): any[] {
    if (!this.rowEngine) {
      let rows = this.items ? this.items() : [];
      if (this.searchFields && this.query.trim()) {
        const q = Text.normSearch(this.query);
        rows = rows.filter((o) => this.searchFields!(o).some((v) => Text.normSearch(v).includes(q)));
      }
      return rows;
    }
    return this.rowEngine.rows(this._rowRequest());
  }

  /** La requête du moteur pour l'état courant du listing (saisie + cible filtrée). */
  private _rowRequest(): ListRowRequest {
    return { collection: this.collection, query: this.query, target: this._targetValue() };
  }

  /** TRI SERVEUR du critère ACTIF (pagination ordonnée complète — régime pagé seulement), ou null
      (critère non mappable → repli « trier la page reçue »). La traduction sortKey → champ du modèle
      est le module pur `core/ListServerSort` (critères de date intrinsèques + `sortField` déclarés),
      validée contre la liste blanche PARTAGÉE — la même que le serveur. Sans moteur (source custom),
      aucun régime pagé : null d'office. */
  private _serverSort(): ListRowServerSort | null {
    if (!this.rowEngine) return null;
    return ListServerSort.of(this.collection, this.sortKey, this.sortDir,
      this.columns.map((c) => ({ key: this._colKey(c), sortField: c.sortField })));
  }

  /** Applique les filtres de COLONNE actifs à un jeu de lignes. Extrait de `render()` : les deux
      régimes (local et pagé serveur) doivent filtrer de la MÊME façon — un filtre qui se comporterait
      autrement selon la provenance des lignes serait un piège. */
  private _applyColumnFilters(rows: any[]): any[] {
    let out = rows;
    this.columns.filter((c) => c.filter).forEach((c) => {
      const set = this.filterState[this._colKey(c)];
      if (!set || !set.size) return;
      out = out.filter((o) => {
        const v = c.filter!.valueOf(o);
        if (Array.isArray(v)) { const arr = v.length ? v : ["__none__"]; return arr.some((x) => set.has(String(x))); }
        return set.has(String(v == null || v === "" ? "__none__" : v));
      });
    });
    return out;
  }

  /** Repeint le listing. `typing` = ce rendu ne vient QUE d'une frappe (ou de l'arrivée d'une réponse
      serveur) : rien n'a muté dans le document, l'index de recherche mémoïsé est donc CONSERVÉ — c'est
      lui qui rend la frappe ~30× moins chère (mesure en tête de `RecordSearchIndex`). Tout autre appel
      (tri, filtre, page, re-rendu externe après écriture) le jette : dans le doute, on recalcule. */
  render(options?: { typing?: boolean }): void {
    if (!options || !options.typing) this.searchIndex.invalidate();
    // G4 — la collection est-elle servie PAGE PAR PAGE par le serveur ? La SOURCE tranche (état
    // d'hydratation + requête au repos) ; `null` = régime historique, intégralement préservé.
    // `serverSort` (pagination ORDONNÉE complète) : le critère de tri ACTIF mappé en champ serveur —
    // il fait partie de la signature de page, donc changer de tri EST une nouvelle demande serveur.
    const serverSort = this._serverSort();
    const serverPage = this.rowEngine
      ? this.rowEngine.page(this._rowRequest(), { page: this.page, pageSize: this.pageSize, sort: serverSort })
      : null;
    let rows: any[], total: number, pages: number, page: number;
    if (serverPage) {
      // Les compteurs viennent du SERVEUR (total = COUNT(*)) : aucune arithmétique cliente, et le pager
      // affiche la page RÉELLEMENT en main — jamais « page 2 » avec le contenu de la page 1.
      // Tri MAPPÉ serveur → la page s'affiche DANS L'ORDRE REÇU : c'est l'ORDER BY qui a découpé le
      // corpus, la retrier localement (collation ≠) contredirait les frontières de pages. Critère NON
      // mappable → repli du pilote : tri client de la page reçue (documenté, docs/hydratation.md).
      const filtered = this._applyColumnFilters(serverPage.rows);
      rows = serverSort ? filtered : this._sortRows(filtered);
      total = serverPage.total; pages = serverPage.pages; page = serverPage.page;
      // 🚨 `this.page` reste la page DEMANDÉE — on n'y recopie JAMAIS la page en main. Le moteur rend
      // par contrat la DERNIÈRE page reçue pendant que la demandée est en vol : recopier son numéro
      // re-demandait l'ANCIENNE page à l'arrivée de la nouvelle → ping-pong infini page 2 ⇄ page 1
      // (bug mesuré sur le listing wifi, 2026-08-13 — seule collection assez grosse pour paginer).
      // La variable locale `page`, elle, reste la page AFFICHÉE (jamais « page 2 » avec le contenu de
      // la page 1). On borne seulement la demande aux pages EXISTANTES : un corpus qui rétrécit
      // (suppression, synchro) ne doit pas laisser une demande au-delà de la dernière page — le
      // serveur borne sa réponse pareil, donc les deux états convergent en un rendu.
      this.page = Math.min(this.page, pages);
    } else {
      const all = this._sortRows(this._applyColumnFilters(this._collectRows()));
      total = all.length; pages = Math.max(1, Math.ceil(total / this.pageSize));
      page = Math.min(this.page, pages); this.page = page;
      rows = all.slice((page - 1) * this.pageSize, page * this.pageSize);
    }
    this._ensureScaffold();
    this._ensureToolbar();
    // « Chargement… » plutôt que l'état vide tant qu'aucune page serveur n'est arrivée : un listing vide
    // et un listing qui n'a pas encore répondu ne disent PAS la même chose à l'utilisateur.
    this._paintBody(rows, total, pages, page,
      (this.rowEngine && this.rowEngine.pageLoading) ? I18n.t("lists.chrome.loading") : this.emptyText);
    this._syncSortControls();   // reflète l'état de tri UNIQUE (this.sortKey/sortDir) sur le select + bouton de sens en barre
    this._saveState();
  }

  /** Bâtit UNE FOIS la barre de contrôles unifiée (revue design lot C) : recherche EN TÊTE (extensible,
      loupe intégrée), puis le TRI en barre (select compact + bouton de sens), l'hôte des filtres (« + Filtre »
      + chips), puis le cluster de DROITE (compact, création, « Réinitialiser »). Le tri vit AUSSI sur les
      EN-TÊTES de colonnes (`th.sortable`), synchronisés au select via l'état de tri UNIQUE (cf.
      `_syncSortControls`). Ce squelette n'est bâti qu'une fois : le champ de recherche garde ainsi son
      focus/anti-rebond à travers les re-rendus (seuls le corps et les chips sont repeints ensuite). */
  private _ensureScaffold(): void {
    if (this._scaffold && this.container.querySelector(".list-body")) return;
    this.container.innerHTML = "";
    const chrome = document.createElement("div"); chrome.className = "list-chrome";

    // « + Filtre » DEVANT la recherche (revue 2026-07-30 — le bouton ouvre un choix de critères, il
    // précède la zone qu'il qualifie) ; les CHIPS actifs, eux, vivent sur LEUR PROPRE RANGÉE en fin de
    // barre (cf. _chipsHostEl) — avant, bouton et chips partageaient un conteneur inséré après le tri,
    // et chaque chip ajouté poussait le cluster de droite.
    this._filtersHostEl = document.createElement("div"); this._filtersHostEl.className = "lc-filters-host";
    chrome.appendChild(this._filtersHostEl);

    // Recherche ensuite, extensible : loupe intégrée + champ normalisé, à la hauteur unifiée.
    const search = document.createElement("div"); search.className = "lc-search";
    const icon = document.createElement("span"); icon.className = "lc-search-ic"; icon.setAttribute("aria-hidden", "true"); icon.innerHTML = Icons.SEARCH;
    this._searchEl = document.createElement("input"); this._searchEl.type = "search"; this._searchEl.className = "search-input";
    this._searchEl.placeholder = I18n.t("lists.chrome.searchPlaceholder");
    this._searchEl.setAttribute("aria-label", I18n.t("lists.chrome.searchPlaceholder"));
    search.append(icon, this._searchEl);
    chrome.appendChild(search);

    // TRI EN BARRE (revue design — règle « ≥ 4 critères ⇒ select compact + bouton de SENS dédié ») : réintroduit
    // APRÈS le lot C, qui l'avait retiré et rendait ainsi inatteignables les tris « Date de création / de
    // modification » (critères SANS colonne d'en-tête cliquable). Placé APRÈS la recherche et AVANT « + Filtre ».
    // L'état de tri reste UNIQUE (this.sortKey/this.sortDir), partagé avec les en-têtes triables : le select et le
    // bouton ne le RÉFLÉCHISSENT pas en double — `_syncSortControls()` les recale à chaque rendu, et un clic
    // d'en-tête repasse par render() → synchronisation bidirectionnelle sans duplication d'état.
    const sortGroup = document.createElement("div"); sortGroup.className = "lc-sort";
    const sortLbl = document.createElement("span"); sortLbl.className = "lc-sort-lb"; sortLbl.textContent = I18n.t("lists.chrome.sort");
    this._sortSelEl = document.createElement("select"); this._sortSelEl.className = "lc-sort-key app-select";
    this._sortSelEl.setAttribute("aria-label", I18n.t("lists.chrome.sort"));
    this._sortOptions().forEach((o) => { const op = document.createElement("option"); op.value = o.key; op.textContent = o.label; this._sortSelEl.appendChild(op); });
    this._sortSelEl.onchange = () => { this.sortKey = this._sortSelEl.value; this.page = 1; this.render(); };
    this._sortDirEl = document.createElement("button"); this._sortDirEl.type = "button"; this._sortDirEl.className = "lc-sort-dir";
    this._sortDirEl.onclick = () => { this.sortDir = this.sortDir === "desc" ? "asc" : "desc"; this.page = 1; this.render(); };
    sortGroup.append(sortLbl, this._sortSelEl, this._sortDirEl);
    chrome.appendChild(sortGroup);

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
    // Hôte de la RANGÉE DE CHIPS, DERNIER enfant du chrome (flex en wrap) : `display: contents` — l'hôte
    // est transparent pour le layout, c'est la rangée elle-même (`.lc-chips-row`, flex-basis 100 %) qui
    // passe à la ligne, et `:empty` la masque sans laisser de gouttière quand aucun filtre n'est actif.
    this._chipsHostEl = document.createElement("div"); this._chipsHostEl.className = "lc-chips-host";
    chrome.appendChild(this._chipsHostEl);
    this.container.appendChild(chrome);

    this._bodyEl = document.createElement("div"); this._bodyEl.className = "list-body";
    this.container.appendChild(this._bodyEl);

    this._searchEl.value = this.query;
    let t: any;
    // `typing: true` — une frappe ne mute rien : l'index de recherche mémoïsé survit (cf. render()).
    this._searchEl.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { this.query = this._searchEl.value; this.page = 1; this.render({ typing: true }); }, 180); });
    this._scaffold = true; this._toolbarSig = null; this._filterBar = null;
  }

  /** (Re)construit la FilterBar (« + Filtre » + chips + Réinitialiser) quand l'ensemble des OPTIONS filtrables
      change (signature) — jamais à chaque frappe/tri/page : un changement de VALEUR de filtre ne repeint que
      les chips (FilterBar) + le corps, laissant un panneau ouvert intact. Aucune colonne filtrable → hôtes vidés. */
  private _ensureToolbar(): void {
    const filterCols = this.columns.filter((c) => c.filter);
    // Signature bâtie sur `_filterOptions` (et non sur `options()` brut) : c'est ce qui fait qu'une
    // facette SERVEUR arrivée en cours de route (G8) reconstruit bien la barre — sa signature change.
    const optionsByColumn = new Map<ListColumn, FilterOption[]>(filterCols.map((c) => [c, this._filterOptions(c)]));
    const sig = filterCols.map((c) => optionsByColumn.get(c)!.map((o) => o.id).join(",")).join("|");
    if (this._toolbarSig === sig && this._filterBar) return;
    this._toolbarSig = sig;
    if (!filterCols.length && !this.targetFilter) { this._filtersHostEl.replaceChildren(); this._chipsHostEl.replaceChildren(); this._resetHostEl.replaceChildren(); this._filterBar = null; return; }
    const dims: FilterBarDimension[] = filterCols.map((c) => {
      const key = this._colKey(c);
      if (!this.filterState[key]) this.filterState[key] = new Set();
      const set = this.filterState[key];
      const items = optionsByColumn.get(c)!;
      const valid = new Set(items.map((i) => i.id));
      [...set].forEach((id) => { if (!valid.has(id)) set.delete(id); });   // purge des valeurs disparues (parité historique)
      return { key, label: c.filter!.label || c.head, options: items.slice(), selected: set };
    });
    const targetDim = this._targetDimension();
    if (targetDim) dims.push(targetDim);   // la CIBLE en dernier : les critères d'énumération restent en tête du menu
    this._filterBar = new FilterBar(dims, () => { this.page = 1; this.render(); });
    this._filtersHostEl.replaceChildren(this._filterBar.addElement);
    this._chipsHostEl.replaceChildren(this._filterBar.chipsElement);
    this._resetHostEl.replaceChildren(this._filterBar.resetElement);
  }

  /** Dimension CIBLE « à recherche » de la barre de filtres (null si ce listing n'en déclare pas).
      Contrairement aux dimensions d'énumération, ses valeurs sont LIBRES : aucune purge « option
      disparue » ne s'y applique — une cible supprimée garde sa chip, dont le libellé retombe sur
      « (supprimé) », pour que l'utilisateur VOIE le filtre qui vide sa liste et puisse le retirer. */
  private _targetDimension(): FilterBarDimension | null {
    const filter = this.targetFilter;
    if (!filter) return null;
    if (!this.filterState[ListView.TARGET_DIM_KEY]) this.filterState[ListView.TARGET_DIM_KEY] = new Set();
    return {
      key: ListView.TARGET_DIM_KEY,
      label: filter.label,
      options: [],
      selected: this.filterState[ListView.TARGET_DIM_KEY],
      search: {
        placeholder: filter.placeholder,
        // La recherche est ASYNCHRONE (serveur-pilotée en mode API, locale en mode fichier) : on habille
        // les candidats À L'ARRIVÉE. Le SearchPop de la barre porte l'anti-rebond + le StaleGate.
        fetch: (query) => filter.search(query).then((items) => items.map((item): SearchPopResult => ({
          id: TargetSearch.key(item.kind, item.id), label: item.label, tag: filter.tagOf(item.kind) || undefined,
        }))),
        debounceMs: EntityCandidateSource.DEBOUNCE_MS,   // même tempo que la palette / les listings serveur-pilotés
        labelOf: (valueId) => {
          const target = TargetSearch.parse(valueId);
          const label = target ? filter.labelOf(target.kind, target.id) : null;
          return label !== null ? label : I18n.t("lists.filter.targetMissing");
        },
        // Badge de FAMILLE de la valeur posée (rangée « valeur courante » du panneau) — même
        // résolution que le `tag` des candidats ; "" pour une famille unique (aucune pastille).
        tagOf: (valueId) => {
          const target = TargetSearch.parse(valueId);
          return target ? filter.tagOf(target.kind) : "";
        },
      },
    };
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
    if (this._rowCanShow(id) || this._rowCanLocate(id) || a.clone || a.del || a.download) {
      const moreLbl = I18n.t("lists.chrome.rowMore");
      html += `<button type="button" class="btn btn-ghost btn-sm icon-action row-overflow" data-act="__more__" title="${moreLbl}" aria-label="${moreLbl}" aria-haspopup="menu" aria-expanded="false">${Icons.MORE}</button>`;
    }
    return html + "</span>";
  }

  /** `locate` effectif pour UNE ligne : action activée ET prédicat par ligne (s'il existe) satisfait. */
  private _rowCanLocate(id: string): boolean {
    return !!this.actions.locate && (!this.actions.canLocate || this.actions.canLocate(id));
  }

  /** `show` (« Afficher », viewer) effectif pour UNE ligne : action activée ET prédicat par ligne satisfait. */
  private _rowCanShow(id: string): boolean {
    return !!this.actions.show && (!this.actions.canShow || this.actions.canShow(id));
  }

  /** Ouvre le menu « plus d'actions » (overflow) d'une ligne : actions secondaires actives, déléguées à onAction. */
  private _openRowMenu(trigger: HTMLElement, id: string): void {
    const a = this.actions;
    const items: { label: string; icon?: string; danger?: boolean; onClick: () => void }[] = [];
    // Icônes du registre PARTAGÉ : les emoji d'origine (📍 ⬇ ⧉) étaient des bitmaps COULEUR — ils
    // pixellisaient au zoom et ignoraient `currentColor`, donc la teinte « danger » du survol.
    if (this._rowCanLocate(id)) items.push({ label: I18n.t("lists.chrome.rowLocate"), icon: Icons.LOCATE, onClick: () => this.onAction && this.onAction("locate", id) });
    // « Afficher » (viewer) AVANT « Télécharger » (cadrage B, D-B4) : consulter d'abord, télécharger ensuite.
    if (this._rowCanShow(id)) items.push({ label: I18n.t("lists.chrome.rowShow"), icon: Icons.EYE, onClick: () => this.onAction && this.onAction("show", id) });
    if (a.download) items.push({ label: I18n.t("lists.chrome.rowDownload"), icon: Icons.EXPORT, onClick: () => this.onAction && this.onAction("download", id) });
    if (a.clone) items.push({ label: I18n.t("lists.chrome.rowClone"), icon: Icons.CLONE, onClick: () => this.onAction && this.onAction("clone", id) });
    if (a.del) items.push({ label: I18n.t("ui.action.delete"), icon: Icons.DELETE, danger: true, onClick: () => this.onAction && this.onAction("del", id) });
    RowMenu.open(trigger, items);
  }

  private _paintBody(rows: any[], total: number, pages: number, page: number, emptyText: string): void {
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
      bodyHtml = `<tr class="empty-row"><td colspan="${cols.length + 1}">${Html.escape(emptyText)}</td></tr>`;
    } else {
      bodyHtml = rows.map((o) => {
        // `data-label` = en-tête de la colonne : sert au repli en CARTES sous 560px (revue design lot D2) — le
        // CSS l'affiche via `td::before { content: attr(data-label) }`, zéro duplication de markup. La cellule
        // d'ACTIONS n'en reçoit pas (rangée de boutons, jamais préfixée d'un libellé).
        const cells = cols.map((c) => `<td class="${c.cls || ""}" data-label="${Html.escape(c.head)}">${c.render(o)}</td>`).join("");
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
        // Base de navigation = la page DEMANDÉE (`this.page`), pas la page AFFICHÉE (`page`) : en régime
        // pagé serveur, l'affichée peut être l'ANCIENNE page le temps du vol — naviguer depuis elle
        // ramènerait vers des pages déjà dépassées. En régime local les deux sont égales (clamp du
        // render), le comportement historique ne change pas d'un clic.
        if (act === "first") this.page = 1; else if (act === "prev") this.page = Math.max(1, this.page - 1);
        else if (act === "next") this.page = Math.min(pages, this.page + 1); else if (act === "last") this.page = pages;
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
    // Délégation des RÉFÉRENCES d'entité cliquables dans les cellules (`data-open-col`/`data-open-id`) — ex. le nom
    // d'équipement dans la liaison d'un câble → ouvre SA fiche via onOpenEntity, sans déclencher l'action de ligne.
    this._bodyEl.querySelectorAll("[data-open-id]").forEach((el) => {
      const open = (ev: Event) => { ev.stopPropagation(); const t = el as HTMLElement; const col = t.dataset.openCol, id = t.dataset.openId; if (col && id && this.onOpenEntity) this.onOpenEntity(col, id); };
      (el as HTMLElement).onclick = open;
      (el as HTMLElement).onkeydown = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(e); } };
    });
  }
}
