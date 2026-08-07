import { Html } from "../core/Html";
import { Format } from "../core/Format";
import { Markdown } from "../core/Markdown";
import { I18n } from "../i18n/I18n";
import { InterventionsFormat, type BadgeClass } from "../core/InterventionsFormat";
import { TargetSearch } from "../core/TargetSearch";
import { EntityCandidateSource } from "../core/EntityCandidates";
import { FormControls, type SelectOption } from "../ui/FormControls";
import { type MultiItem } from "../ui/MultiSelect";
import { FilterBar } from "../ui/FilterBar";
import { CardTable } from "../ui/CardTable";
import { SearchPop, type SearchPopResult } from "../ui/SearchPop";
import { Icons } from "../ui/Icons";
import { IconButton } from "../ui/IconButton";
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_OPTIONS } from "../data/config";
import { Notify } from "../ui/Notify";
import { Dialog } from "../ui/Dialog";
import type { FormHost } from "./forms/shared";
import { InterventionsError } from "./forms/InterventionsClient";
import type {
  InterventionsClient, InterventionRecord, InterventionInput, InterventionLink, InterventionsListParams,
} from "./forms/InterventionsClient";
import { TrackerStatus } from "../core/TrackerStatus";
import { TrackerReplication } from "../core/TrackerReplication";
import { TrackerProvidersForm } from "./forms/TrackerProvidersForm";
import { TrackerTicketBlock } from "./forms/TrackerTicketBlock";
import { TrackerSyncError } from "./forms/TrackerSyncClient";
import type { TrackerSyncClient, TrackerProviderSummary } from "./forms/TrackerSyncClient";

/* =============================================================================
   InterventionsAdminView — page « Interventions » (ONGLET PRINCIPAL, décision de
   cadrage). Administre le module serveur `interventions/` : incidents &
   interventions liés aux équipements/VMs/spares, avec cycle de vie, priorité,
   fenêtre planifiée, référence Jira et éditeur de liens.

   Classe DÉDIÉE et AUTONOME (feature AMOVIBLE, pattern CertsAdminView/
   NotificationsAdminView) : la retirer = supprimer ce fichier + InterventionsClient
   + InterventionsFormat + le branchement de main.ts, sans cicatrice ailleurs. Elle
   NE dérive PAS de la chaîne `Forms` ; les FORMULAIRES s'ouvrent dans la MODALE de
   l'app (FormHost injecté, principe n°11).

   PREMIÈRE PAGE ENTIÈREMENT LOCALISÉE : TOUTES les chaînes d'UI passent par I18n.t
   (l'infra i18n est déjà en place). La logique PURE (clés i18n, jiraUrl, fenêtre)
   vit dans InterventionsFormat (i18n-agnostique, testée) ; la vue localise au point
   d'affichage.

   MODE : le service est SANS OBJET hors mode API. En mode fichier/viewer, `client`
   est null → message « mode API requis » (parité CertsAdminView/NotificationsAdminView).
   Aucun document ouvert → message dédié (les interventions sont propres au document).

   DÉCOUPLAGE DES CIBLES (principe n°2) : la vue ne touche JAMAIS le Store. Les
   équipements/VMs/spares liables viennent d'une interface hôte INJECTÉE
   (InterventionTargetSource), implémentée dans main.ts sur le Store.

   LISTING PAGINÉ SERVEUR : filtres (recherche + Type/Statut/Priorité), tris par en-tête et pagination portés
   par la REQUÊTE (jamais de slice client) ; l'UI reprend la barre de contrôles unifiée des listings (recherche
   en tête + filtres en CHIPS via `ui/FilterBar`, classes `.list-chrome`/`.pagination`/`.sortable`).
   L'état de listing vit en MÉMOIRE d'instance (rechargé après chaque écriture).

   PONT « TRACKER » (feature AMOVIBLE dans l'amovible) : quand `tracker` est injecté, les incidents et
   interventions peuvent être RÉPLIQUÉS dans un tracker distant, dont le TRAITEMENT (statut, assigné)
   est relu en lecture seule. La vue n'en porte que des BRANCHEMENTS FINS (principe n°2) — deux actions
   d'en-tête, une pastille au listing, un conteneur dans la fiche : la logique PURE vit dans
   `core/TrackerStatus` (état du ticket) et `core/TrackerReplication` (état de réplication), l'UI du
   bloc dans `forms/TrackerTicketBlock`, le transport dans `forms/TrackerSyncClient`. `tracker` null
   (mode fichier/viewer, ou pont non câblé) ⇒ tout cela disparaît sans une condition de plus ailleurs.
   ============================================================================= */

/** Source des cibles liables (équipements/VMs/spares) — interface hôte INJECTÉE (la vue ne connaît pas le
    Store). `labelOf` résout le libellé d'un lien existant (null = cible disparue → « introuvable » côté UI,
    orphelin toléré) ; `search` alimente la SÉLECTION unifiée (SearchPop) de l'éditeur de liens ;
    `openTargetDetail` ouvre la fiche de la cible PAR-DESSUS le détail d'intervention (pile de modales). */
export interface InterventionTargetSource {
  /** Libellé d'une cible précise, ou null si elle n'existe plus dans le document (orphelin). */
  labelOf(kind: string, id: string): string | null;
  /** Recherche UNIFIÉE sur TOUTES les familles liables (équipements + VMs + spares CONFONDUS) : renvoie des
      candidats {kind,id,label} déjà TRIÉS par pertinence (préfixe avant inclusion) et BORNÉS. `excluded` =
      clés « kind:id » des cibles déjà liées, écartées des résultats (dédup). Insensible casse/accents.
      ASYNCHRONE (norme n°15) : mode API → candidats SERVEUR (au-delà du corpus chargé) ; mode fichier →
      candidats LOCAUX (promesse résolue). Cf. `core/EntityCandidateSource`. */
  search(query: string, excluded?: ReadonlySet<string>): Promise<Array<{ kind: string; id: string; label: string }>>;
  /** Ouvre la FICHE DE DÉTAIL existante d'une cible (equipment/vm/spare). Elle s'EMPILE sur le détail
      d'intervention, qui reste vivant dessous : le retour est structurel (Annuler / ← / Retour arrière
      dépilent), plus besoin d'un rappel de fermeture pour le rejouer. */
  openTargetDetail(kind: string, id: string): void;
}

/** État d'un listing (mémoire d'instance — PAS de sessionStorage : les volumes vivent côté serveur, l'état
    doit rester cohérent après chaque écriture). Filtres RÉPÉTABLES (MultiSelect) → Set par dimension. */
interface ListingState {
  page: number;
  pageSize: number;
  sort: string;
  dir: "asc" | "desc";
  query: string;
  kinds: Set<string>;
  statuses: Set<string>;
  priorities: Set<string>;
  /** Filtre par CIBLE liée (équipement/VM/spare/sous-équipement) — clés « kind:id » (`core/TargetSearch`),
      MONO-valeur en v1. DEUX points d'entrée pour le MÊME état depuis le lot 3 : la navigation depuis une
      fiche (« Afficher plus » → `openListFor`) et la dimension « à RECHERCHE » de la barre de filtres.
      Vide = aucun filtre de cible. */
  targets: Set<string>;
}

export class InterventionsAdminView {
  /** Signal ÉMIS après une écriture (création / transition rapide / suppression) : la vue prévient l'hôte que le
      NOMBRE d'interventions OUVERTES a pu changer, pour rafraîchir le badge de l'onglet — tenu HORS de cette vue
      (compteur caché maintenu en async dans main.ts, car la donnée est paginée serveur et le count() du shell est
      synchrone). Optionnel (null tant que main.ts ne l'a pas câblé). N'est PAS déclenché par la simple navigation
      (recherche/tri/filtre/pagination) : le total d'ouvertes n'y change pas. */
  onCountsChanged?: () => void;

  /** Garde anti-rechargements concurrents. */
  private loading = false;
  /** État du listing. */
  private state: ListingState = InterventionsAdminView.defaultState();
  /** Items de la page courante. */
  private items: InterventionRecord[] = [];
  /** Métadonnées de pagination (null tant qu'aucune page chargée). */
  private pageMeta: { total: number; page: number; pages: number; pageSize: number } | null = null;
  /** Corps (table + pagination) — repeint SEUL sur tri/pagination/filtre/recherche (toolbar préservée →
      le champ de recherche garde son focus, un panneau MultiSelect ouvert n'est pas refermé). */
  private bodyEl: HTMLElement | null = null;
  /** Base d'URL Jira (GET /meta) — chargée UNE fois au premier rendu ; null = pas de lien (texte brut). */
  private jiraBase: string | null = null;
  private metaLoaded = false;
  /** Anti-rebond de la recherche (~250 ms). */
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Barre de filtres unifiée (chips + « + Filtre » + Réinitialiser) — bâtie au rendu complet, PRÉSERVÉE sur
      refreshBody (un changement de filtre ne repeint que ses chips + le corps). */
  private filterBar: FilterBar | null = null;
  /** Providers de réplication configurés — chargés UNE fois (comme `jiraBase`) et seulement pour savoir
      s'il faut DEMANDER lequel viser (≥ 2). Un échec est avalé : liste vide = « on ne sait pas », et le
      serveur tranchera (il refuse avec un message qui nomme les providers en cas d'ambiguïté). */
  private trackerProviders: TrackerProviderSummary[] = [];
  private trackerProvidersLoaded = false;

  constructor(
    private readonly container: HTMLElement,
    /** null = mode fichier/viewer (service sans objet) → message d'indisponibilité. */
    private readonly client: InterventionsClient | null,
    /** Hôte de modale de l'app — les formulaires s'ouvrent dans LA modale standard (principe n°11). */
    private readonly host: FormHost,
    /** Source des cibles liables (Store injecté par main.ts — la vue ne touche jamais le Store). */
    private readonly targets: InterventionTargetSource,
    /** Client du PONT de réplication — null = pont non branché (mode fichier/viewer) : aucune action
        d'en-tête, aucun bloc « Ticket », aucune pastille. La feature est amovible SANS toucher la vue. */
    private readonly tracker: TrackerSyncClient | null = null,
  ) {}

  /** Activation de l'onglet (onShow) : messages d'indisponibilité, sinon (re)charge la page courante. */
  show(): void {
    if (!this.client) { this.renderNeedsApi(); return; }
    if (!this.client.docId) { this.renderNoDoc(); return; }
    void this.reload();
  }

  /* --------------------------------------------------------------------------
     Chargement réseau
     -------------------------------------------------------------------------- */

  private async reload(): Promise<void> {
    await this.guarded(async () => {
      await this.ensureMeta();
      await this.loadPage();
      this.render();
    });
  }

  /** Charge la base Jira UNE seule fois (métadonnées du module). Une erreur est avalée (jiraBase reste
      null → références en texte brut) : si le module est réellement coupé (503), loadPage le révélera. */
  private async ensureMeta(): Promise<void> {
    if (this.metaLoaded) return;
    try { this.jiraBase = (await this.client!.meta()).jira_base_url; } catch (_) { this.jiraBase = null; }
    this.metaLoaded = true;
    await this.ensureTrackerProviders();
  }

  /** Charge la liste des providers de réplication UNE seule fois, en même temps que les métadonnées.
      TOUTE erreur est avalée — y compris le 503 « pont désactivé » : le pont est un SUPPLÉMENT, son
      indisponibilité ne doit ni casser le listing ni masquer les interventions. La conséquence d'une
      liste vide est bénigne (aucun sélecteur de provider proposé, le serveur tranche). */
  private async ensureTrackerProviders(): Promise<void> {
    if (!this.tracker || this.trackerProvidersLoaded) return;
    this.trackerProvidersLoaded = true;
    try { this.trackerProviders = await this.tracker.providers(); } catch (_) { this.trackerProviders = []; }
  }

  /** Charge la PAGE COURANTE depuis le serveur. La page effective est relue de la réponse (le serveur
      CLAMPE si la page demandée n'existe plus après une écriture/un filtre). */
  private async loadPage(): Promise<void> {
    const res = await this.client!.listPage(InterventionsAdminView.listParams(this.state));
    this.items = res.interventions;
    this.pageMeta = { total: res.total, page: res.page, pages: res.pages, pageSize: res.pageSize };
    this.state.page = res.page;
    this.ensureAuthors();   // résout les auteurs (created_by/updated_by = IDS) de la page → repeint quand prêts
  }

  /** Annuaire utilisateurs injecté (mode API) — résout les IDS d'auteur en « Prénom Nom »/login. null en
      mode fichier (mais le service interventions y est déjà indisponible). */
  private get directory() { return this.host.userDirectory || null; }

  /** Libellé affichable d'un auteur : depuis le cache de l'annuaire (id brut en repli → le LEGACY « nom en
      clair » s'affiche tel quel) ; « — » si aucun auteur. */
  private authorDisplay(by: string): string {
    const id = (by || "").trim();
    if (!id) return "—";
    return this.directory ? this.directory.display(id) : id;
  }

  /** Résout (async, coalescé) les auteurs de la page courante puis REPEINT le corps quand ils arrivent —
      la colonne « Créé par » reste SYNCHRONE (cache), rafraîchie une fois le lot résolu. Non bloquant. */
  private ensureAuthors(): void {
    const dir = this.directory; if (!dir) return;
    const ids: string[] = [];
    for (const it of this.items) { if (it.created_by) ids.push(it.created_by); if (it.updated_by) ids.push(it.updated_by); }
    if (!ids.length) return;
    void dir.ensure(ids).then(() => { if (this.bodyEl) this.paintBody(); }).catch(() => { /* auteurs non critiques */ });
  }

  /** Recharge la page courante et repeint UNIQUEMENT le corps — la toolbar (recherche + filtres) reste en
      place. Sert aussi APRÈS une écriture (la page courante est rechargée, clamp serveur si elle a disparu). */
  private async refreshBody(): Promise<void> {
    await this.guarded(async () => { await this.loadPage(); this.paintBody(); });
  }

  /** Après une ÉCRITURE (création / transition rapide / suppression) : recharge la page courante (comme
      refreshBody) PUIS signale que le compteur d'ouvertes a pu changer (badge d'onglet). Les rechargements de
      simple navigation passent, eux, par refreshBody() SANS ce signal. */
  private async afterWrite(): Promise<void> {
    await this.refreshBody();
    this.onCountsChanged?.();
  }

  /** Exécute un chargement en traduisant 503 (module serveur en erreur) en BANDEAU actionnable, et toute
      autre erreur en message plein contenu. Ré-entrance gardée. */
  private async guarded(load: () => Promise<void>): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try { await load(); }
    catch (e) {
      if (e instanceof InterventionsError && e.status === 503) { this.renderDisabled(e); return; }
      this.renderMessage(I18n.t("interventions.msg.loadError") + " — " + InterventionsAdminView.errText(e), true);
    } finally { this.loading = false; }
  }

  /* --------------------------------------------------------------------------
     Rendu principal
     -------------------------------------------------------------------------- */

  private render(): void {
    if (!this.client) return;
    this.container.innerHTML = "";
    this.container.appendChild(this.buildChrome());
    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "list-body";   // mêmes règles CSS que les listings ListView (défaut à gauche, numériques via cell-num)
    this.container.appendChild(this.bodyEl);
    this.paintBody();
  }

  /** Barre de contrôles UNIFIÉE (revue design lot C) : recherche EN TÊTE (extensible, loupe intégrée), filtres
      « Type/Statut/Priorité » en CHIPS + « + Filtre » (FilterBar partagée), puis le cluster de DROITE (créations
      + actualisation, « Réinitialiser » le plus à droite). NON reconstruite sur refreshBody → le champ de
      recherche garde son focus pendant la frappe et un panneau de filtre ouvert n'est pas refermé. */
  private buildChrome(): HTMLElement {
    const st = this.state;
    const bar = document.createElement("div"); bar.className = "list-chrome";

    // Filtres Type/Statut/Priorité (répétables) — construits AVANT la barre : le bouton « + Filtre »
    // se place DEVANT la recherche, et les chips actifs sur LEUR RANGÉE en fin de barre (revue
    // 2026-07-30, même disposition que ListView).
    this.filterBar = new FilterBar([
      { key: "kinds", label: I18n.t("interventions.filter.type"), options: InterventionsAdminView.slugItems(InterventionsFormat.KIND_SLUGS, (s) => InterventionsFormat.kindLabelKey(s)), selected: st.kinds },
      { key: "statuses", label: I18n.t("interventions.filter.status"), options: InterventionsAdminView.slugItems(InterventionsFormat.STATUS_SLUGS, (s) => InterventionsFormat.statusLabelKey(s)), selected: st.statuses },
      { key: "priorities", label: I18n.t("interventions.filter.priority"), options: InterventionsAdminView.slugItems(InterventionsFormat.PRIORITY_SLUGS, (s) => InterventionsFormat.priorityLabelKey(s)), selected: st.priorities },
      this.targetDimension(st),   // CIBLE liée : dimension « à RECHERCHE » (lot 3) — même état que la navigation
    ], () => { st.page = 1; void this.refreshBody(); });
    bar.appendChild(this.filterBar.addElement);

    // Recherche NORMALISÉE (classe `.search-input`, loupe intégrée) ; l'anti-rebond + la requête serveur restent
    // propres à cette page paginée.
    const search = document.createElement("div"); search.className = "lc-search";
    const icon = document.createElement("span"); icon.className = "lc-search-ic"; icon.setAttribute("aria-hidden", "true"); icon.innerHTML = Icons.SEARCH;
    const input = document.createElement("input"); input.type = "search"; input.className = "search-input";
    input.placeholder = I18n.t("interventions.search.placeholder"); input.setAttribute("aria-label", I18n.t("interventions.search.placeholder"));
    input.value = st.query;
    input.oninput = () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => { st.query = input.value.trim(); st.page = 1; void this.refreshBody(); }, 250);
    };
    search.append(icon, input);
    bar.appendChild(search);

    const right = document.createElement("div"); right.className = "lc-right";
    right.append(
      this.actionButton(I18n.t("interventions.action.addIncident"), "", () => this.interventionModal(null, "incident"), "btn-primary"),
      this.actionButton(I18n.t("interventions.action.addIntervention"), "", () => this.interventionModal(null, "intervention"), "btn-primary"),
      this.actionButton(I18n.t("interventions.action.refresh"), "", () => void this.reload()),
    );
    // Actions du PONT (mode API + non-viewer, garanti par la NULLITÉ de `tracker` — le client n'est
    // construit qu'en mode API, lui-même exclu du viewer) : configuration des trackers de destination
    // et passe de synchro manuelle. Absentes sinon, sans condition supplémentaire à écrire ici.
    if (this.tracker) {
      right.append(
        this.actionButton(I18n.t("tracker.action.providers"), I18n.t("tracker.action.providersTitle"),
          () => TrackerProvidersForm.open(this.host, this.tracker!, () => { this.trackerProvidersLoaded = false; void this.ensureTrackerProviders(); })),
        this.actionButton(I18n.t("tracker.action.sync"), I18n.t("tracker.action.syncTitle"), () => void this.trackerSync()),
      );
    }
    right.appendChild(this.filterBar.resetElement);
    bar.appendChild(right);
    bar.appendChild(this.filterBar.chipsElement);   // rangée des chips (dimensions ET cible), À LA LIGNE
    return bar;
  }

  /** Dimension « à RECHERCHE » du filtre par CIBLE liée (lot 3) — le SearchPop y réutilise la MÊME source
      injectée que l'éditeur de liens (`this.targets.search`), donc la même pertinence et le même badge de
      famille. ABSORPTION : la chip posée par navigation (« Afficher plus » depuis une fiche) et celle
      posée à la main ici sont désormais LA MÊME — un seul état, un seul rendu, un seul ✕ (auparavant la
      chip de cible avait sa rangée, sa primitive et son code de retrait à part). Le libellé est résolu à
      chaque rendu (`labelOf`) : une cible supprimée devient « introuvable » sans effacer le filtre. */
  private targetDimension(st: ListingState) {
    return {
      key: "target",
      label: I18n.t("interventions.filter.targetLabel"),
      options: [],
      selected: st.targets,
      search: {
        placeholder: I18n.t("interventions.filter.targetPlaceholder"),
        // ASYNCHRONE (serveur-pilotée en mode API, locale en mode fichier) : on habille À L'ARRIVÉE.
        fetch: (query: string): Promise<SearchPopResult[]> => this.targets.search(query).then((rs) => rs.map((r) => ({
          id: TargetSearch.key(r.kind, r.id), label: r.label,
          tag: I18n.t(InterventionsFormat.targetKindLabelKey(r.kind)),
        }))),
        debounceMs: EntityCandidateSource.DEBOUNCE_MS,   // même tempo que la palette / les listings serveur-pilotés
        labelOf: (valueId: string) => {
          const target = TargetSearch.parse(valueId);
          const label = target ? this.targets.labelOf(target.kind, target.id) : null;
          return label !== null ? label : I18n.t("interventions.target.unknown");
        },
        // Badge de FAMILLE de la valeur posée (rangée « valeur courante » du panneau) — même
        // résolution que le `tag` des candidats ci-dessus.
        tagOf: (valueId: string) => {
          const target = TargetSearch.parse(valueId);
          return target ? I18n.t(InterventionsFormat.targetKindLabelKey(target.kind)) : "";
        },
      },
    };
  }

  /** Ouvre la vue FILTRÉE sur une cible (appelée par l'intégration « fiches » après navigation vers cet
      onglet, bouton « Afficher plus »). Pose le filtre — la MÊME valeur que la dimension « à recherche »
      de la barre poserait —, revient page 1, puis (re)charge : `reload()` reconstruit la barre, donc la chip.
      ⚠ Ordre d'arrivée par navigation (cf. `openCreateFor`) : main.ts appelle `switchView` PUIS cette
      méthode ; `switchView` a pu lancer un `show()` → `reload()` concurrent. Si ce dernier est encore en vol,
      `reload()` ici est bloqué par la garde — mais l'état de cible est déjà posé AVANT que le `reload()` en
      vol n'atteigne `loadPage`/`render`, il le prend donc en compte : le filtre est appliqué et la chip
      dessinée dans les deux cas. */
  openListFor(kind: string, id: string): void {
    if (!this.client) return;
    this.state.targets.clear();   // MONO-cible v1 : la navigation REMPLACE la cible courante
    this.state.targets.add(TargetSearch.key(kind, id));
    this.state.page = 1;
    void this.reload();
  }

  /** Peint le CORPS (table + pagination) dans `bodyEl`. */
  private paintBody(): void {
    if (!this.bodyEl) return;
    this.bodyEl.replaceChildren(this.buildTable(), this.buildPagination());
  }

  /* --------------------------------------------------------------------------
     Table
     -------------------------------------------------------------------------- */

  private buildTable(): HTMLElement {
    const st = this.state;
    const tw = document.createElement("div"); tw.className = "table-wrap";
    const table = document.createElement("table");
    const thead = document.createElement("thead"); const tr = document.createElement("tr");
    tr.append(
      this.sortableTh(I18n.t("interventions.col.title"), "title", st),
      this.plainTh(I18n.t("interventions.col.type")),
      this.sortableTh(I18n.t("interventions.col.priority"), "priority", st),
      this.sortableTh(I18n.t("interventions.col.status"), "status", st),
      this.sortableTh(I18n.t("interventions.col.window"), "planned_start", st),
      this.plainTh(I18n.t("interventions.col.links"), "cell-num"),
      this.plainTh(I18n.t("interventions.col.jira")),
      this.plainTh(I18n.t("interventions.col.createdBy")),
      this.plainTh(I18n.t("interventions.col.actions"), "cell-actions"),
    );
    thead.appendChild(tr);
    const labels = CardTable.columnLabels(tr);   // repli en cartes (< 560px) : libellés lus depuis l'en-tête
    const tbody = document.createElement("tbody");
    if (!this.items.length) tbody.appendChild(this.emptyRow(9));
    else for (const item of this.items) { const row = this.buildRow(item); CardTable.labelCells(row, labels); tbody.appendChild(row); }
    table.append(thead, tbody);
    tw.appendChild(table);
    return tw;
  }

  private buildRow(item: InterventionRecord): HTMLElement {
    const tr = document.createElement("tr");

    const title = document.createElement("td");
    // Le TITRE ouvre la modale de DÉTAIL (consultation) — même geste que l'action « Détails » de la ligne.
    const span = document.createElement("span"); span.textContent = item.title;
    span.style.cssText = "cursor:pointer;color:var(--accent)"; span.title = I18n.t("interventions.rowAction.details");
    span.onclick = () => this.detailModal(item);
    title.appendChild(span);
    tr.appendChild(title);

    tr.appendChild(this.htmlCell(this.badge(I18n.t(InterventionsFormat.kindLabelKey(item.kind)), "neutral")));
    tr.appendChild(this.htmlCell(this.badge(I18n.t(InterventionsFormat.priorityLabelKey(item.priority)), InterventionsFormat.priorityClass(item.priority))));
    tr.appendChild(this.htmlCell(this.badge(I18n.t(InterventionsFormat.statusLabelKey(item.status)), InterventionsFormat.statusClass(item.status))));

    const window = document.createElement("td"); window.style.cssText = "font-family:var(--mono);font-size:12px";
    const win = InterventionsFormat.formatWindow(item.planned_start, item.planned_end);
    if (win) window.textContent = win; else window.innerHTML = InterventionsAdminView.MUTED;
    tr.appendChild(window);

    tr.appendChild(this.linksCell(item));
    tr.appendChild(this.jiraCell(item));

    const createdBy = document.createElement("td"); createdBy.textContent = this.authorDisplay(item.created_by);   // ID canonique → nom (legacy = nom en clair, affiché tel quel)
    createdBy.title = item.created_date ? Format.dateTime(item.created_date) : "";
    tr.appendChild(createdBy);

    tr.appendChild(this.actionsCell(item));
    return tr;
  }

  /** Cellule « Liens » : compte + énumération en title (chaque lien = famille · libellé, « introuvable » si
      la cible a disparu — orphelin toléré). */
  private linksCell(item: InterventionRecord): HTMLElement {
    const td = document.createElement("td"); td.className = "cell-num";   // compteur de liens → colonne numérique (droite, tabulaire)
    if (!item.links.length) { td.innerHTML = InterventionsAdminView.MUTED; return td; }
    td.textContent = String(item.links.length);
    td.title = item.links.map((l) => {
      const label = this.targets.labelOf(l.target_kind, l.target_id);
      return I18n.t(InterventionsFormat.targetKindLabelKey(l.target_kind)) + " · " + (label !== null ? label : I18n.t("interventions.target.unknown"));
    }).join("\n");
    return td;
  }

  /** Cellule « Jira » du listing : la référence (lien/texte/« — ») ENRICHIE de l'état de réplication
      quand le pont a fait son œuvre — pastille de catégorie du ticket, et un indicateur DISCRET si la
      dernière poussée a échoué (le détail actionnable vit sur la fiche ; ici, une infobulle suffit).
      Une intervention non répliquée garde EXACTEMENT le rendu d'avant le pont : la colonne ne devient
      pas plus bavarde pour ceux qui n'utilisent pas la réplication. */
  private jiraCell(item: InterventionRecord): HTMLElement {
    const td = document.createElement("td");
    const wrap = document.createElement("span");
    wrap.style.cssText = "display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap";
    wrap.appendChild(this.jiraInline(item));

    if (TrackerReplication.isReplicated(item)) {
      const pill = document.createElement("span");
      // Pas d'infobulle sur la pastille : colonne étroite, pastille répétée à chaque ligne.
      pill.innerHTML = TrackerStatus.statusPill({ status: item.tracker_status, status_category: item.tracker_status_category });
      wrap.appendChild(pill);
    }
    if (TrackerReplication.hasPushError(item)) {
      const flag = document.createElement("span");
      flag.className = "gi"; flag.style.color = "var(--err)"; flag.innerHTML = Icons.WARNING;
      flag.title = I18n.t("tracker.list.pushErrorTitle", { detail: TrackerReplication.pushError(item) });
      // Repère visuel ET lisible : l'infobulle porte le message du tracker, mais un lecteur d'écran
      // ne lit pas un `title` d'élément décoratif — d'où le rôle explicite.
      flag.setAttribute("role", "img");
      flag.setAttribute("aria-label", flag.title);
      wrap.appendChild(flag);
    }
    td.appendChild(wrap);
    return td;
  }

  /** Contenu Jira RÉUTILISABLE (listing + modale de détail) : lien cliquable si une URL est fabricable
      (lien PERSISTÉ par le pont, sinon base + clé, ou clé déjà URL) ; sinon texte brut mono (base non
      configurée) ; « — » si aucune référence.
      ⚠ Le lien passe par `Html.externalLink` (liste blanche de schémas + rel=noopener) : depuis le pont,
      l'URL peut venir d'un TIERS — c'est le tracker qui l'a composée, pas nous. */
  private jiraInline(item: InterventionRecord): HTMLElement {
    const ref = item.jira_ref;
    const url = TrackerReplication.ticketUrl(item.tracker_url, InterventionsFormat.jiraUrl(this.jiraBase, ref));
    // Libellé : la référence lisible ; à défaut (répliquée mais clé pas encore relue), l'id distant.
    const label = (ref || "").trim() || (TrackerReplication.isReplicated(item) ? String(item.tracker_ext_id) : "");
    const span = document.createElement("span");
    if (!label) { span.innerHTML = InterventionsAdminView.MUTED; return span; }
    span.style.cssText = "font-family:var(--mono);font-size:12px";
    span.innerHTML = url ? Html.externalLink(url, label) : Html.escape(label);
    return span;
  }

  /** Actions par ligne, en boutons-ICÔNE (principe n°14) : Détails · Modifier · Démarrer (declared/planned →
      in_progress) · Clore (in_progress → closed) · Supprimer (danger). Les transitions rapides relisent le
      corps complet (GET) puis PUT le status changé (le serveur re-estampille updated_*). */
  private actionsCell(item: InterventionRecord): HTMLElement {
    // display:flex ignore text-align → justify-content:flex-end pour aligner les actions à DROITE (parité
    // .cell-actions des listings ; revue design lot B). Classe `cell-actions` : identifie la cellule d'actions
    // pour le repli en cartes (< 560px) — CardTable ne la préfixe pas d'un libellé (rangée de boutons).
    const td = document.createElement("td"); td.className = "cell-actions"; td.style.cssText = "display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end";
    td.appendChild(this.iconAction(Icons.INFO, I18n.t("interventions.rowAction.details"), () => this.detailModal(item)));
    td.appendChild(this.iconAction(Icons.EDIT, I18n.t("interventions.rowAction.edit"), () => this.interventionModal(item, item.kind)));
    if (item.status === "declared" || item.status === "planned") {
      td.appendChild(this.iconAction(Icons.PLAY, I18n.t("interventions.rowAction.start"), () => void this.quickTransition(item, "in_progress")));
    }
    if (item.status === "in_progress") {
      td.appendChild(this.iconAction(Icons.CHECK, I18n.t("interventions.rowAction.close"), () => void this.quickTransition(item, "closed")));
    }
    td.appendChild(this.iconAction(Icons.DELETE, I18n.t("interventions.rowAction.delete"), () => void this.remove(item), true));
    return td;
  }

  /* --------------------------------------------------------------------------
     Actions (transitions rapides, suppression)
     -------------------------------------------------------------------------- */

  private async quickTransition(item: InterventionRecord, newStatus: string): Promise<void> {
    if (!this.client || this.loading) return;
    try {
      // GET unitaire puis PUT du corps COMPLET : on repart de l'état serveur à jour (évite d'écraser une
      // édition concurrente avec des données de liste périmées) ; seul le status change.
      const full = await this.client.getOne(item.id);
      const input = InterventionsAdminView.toInput(full);
      input.status = newStatus;
      await this.client.save(item.id, input);
      Notify.toast(I18n.t(newStatus === "in_progress" ? "interventions.toast.started" : "interventions.toast.closed"), "ok");
      await this.afterWrite();
    } catch (e) { this.actionError(e); }
  }

  /** Passe de synchro MANUELLE du pont : envoie les mises à jour dues puis relit l'état des tickets.
      Elle peut écrire des colonnes `tracker_*` sur n'importe quelle intervention du document → on
      recharge la page courante à l'arrivée (pastilles et indicateurs d'échec suivent). Le compteur
      d'ouvertes, lui, ne bouge pas (le statut DC Manager n'est jamais touché) : pas d'`afterWrite`.
      Un provider en échec ne fait pas échouer l'appel — le serveur rend un STATUT par provider, dont
      on remonte le premier message d'erreur : c'est lui qui dit quoi corriger. */
  private async trackerSync(): Promise<void> {
    if (!this.tracker) return;
    Notify.toast(I18n.t("tracker.action.syncing"), "info");
    try {
      const providers = await this.tracker.sync();
      const failed = providers.filter((p) => !p.ok);
      if (failed.length) Notify.toast(I18n.t("tracker.action.syncFailed", { detail: failed[0].message || failed[0].provider_id }), "err");
      else Notify.toast(I18n.t("tracker.action.syncDone"), "ok");
      await this.refreshBody();
    } catch (e) {
      // 503 (pont désactivé côté serveur) inclus : un toast, jamais le bandeau — les interventions,
      // elles, restent parfaitement utilisables sans pont.
      Notify.toast(I18n.t("tracker.action.syncFailed", { detail: TrackerSyncError.text(e) }), "err");
    }
  }

  private async remove(item: InterventionRecord): Promise<void> {
    if (!this.client) return;
    const ok = await Dialog.confirm({
      title: I18n.t("interventions.confirm.deleteTitle"),
      message: I18n.t("interventions.confirm.deleteMessage", { title: item.title }),
      confirmLabel: I18n.t("interventions.confirm.deleteConfirm"), danger: true,
    });
    if (!ok) return;
    try {
      await this.client.remove(item.id);
      Notify.toast(I18n.t("interventions.toast.deleted"), "ok");
      await this.afterWrite();
    } catch (e) { this.actionError(e); }
  }

  /* --------------------------------------------------------------------------
     Modale de création / édition (principe n°11) + éditeur de liens
     -------------------------------------------------------------------------- */

  /** Ouvre la modale de CRÉATION pré-liée à une cible (appelée par l'intégration « fiches » après navigation
      vers cet onglet). Nature « intervention » par défaut ; le lien vers la cible est pré-ajouté. No-op si le
      client est absent (ne devrait pas arriver : les hooks de fiche sont null hors mode API). */
  openCreateFor(targetKind: string, targetId: string, targetLabel?: string): void {
    if (!this.client) return;
    this.interventionModal(null, "intervention", [{ target_kind: targetKind, target_id: targetId }], targetLabel);
  }

  private interventionModal(existing: InterventionRecord | null, kind: string, presetLinks: InterventionLink[] = [], subtitleContext?: string): void {
    const editing = existing !== null;
    const root = document.createElement("div");

    // kind : FIGÉ (création via bouton dédié, édition immuable) → affiché en lecture seule.
    const kindLabel = document.createElement("span"); kindLabel.textContent = I18n.t(InterventionsFormat.kindLabelKey(kind));
    root.appendChild(FormControls.fieldRow(I18n.t("interventions.modal.kind"), kindLabel));

    const titleInput = FormControls.text(existing ? existing.title : "", I18n.t("interventions.modal.titlePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("interventions.modal.title"), titleInput));

    const descInput = FormControls.textArea(existing ? existing.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("interventions.modal.description"), descInput, I18n.t("interventions.modal.descriptionHint")));

    const prioritySel = FormControls.select(InterventionsAdminView.slugOptions(InterventionsFormat.PRIORITY_SLUGS, (s) => InterventionsFormat.priorityLabelKey(s)), existing ? existing.priority : "normal");
    root.appendChild(FormControls.fieldRow(I18n.t("interventions.modal.priority"), prioritySel));

    // status : ÉDITION seulement (création → défaut selon la nature : intervention planifiée « planned »,
    // incident « declared »). La transition rapide reste offerte par les boutons de ligne.
    let statusSel: HTMLSelectElement | null = null;
    if (editing) {
      statusSel = FormControls.select(InterventionsAdminView.slugOptions(InterventionsFormat.STATUS_SLUGS, (s) => InterventionsFormat.statusLabelKey(s)), existing!.status);
      root.appendChild(FormControls.fieldRow(I18n.t("interventions.modal.status"), statusSel));
    }
    const createStatus = kind === "intervention" ? "planned" : "declared";

    // Fenêtre planifiée : contrôle de DATE-HEURE maison (FormControls.date, mode « date-time » — principe
    // n°14, jamais un <input datetime-local> brut). `.value` proxifié = valeur d'un datetime-local
    // (« AAAA-MM-JJTHH:MM ») ; la conversion locale ⇄ ISO (UTC) reste identique (isoToInput/inputToIso).
    const startInput: any = FormControls.date(InterventionsAdminView.isoToInput(existing ? existing.planned_start : null), { mode: "date-time" });
    root.appendChild(FormControls.fieldRow(I18n.t("interventions.modal.plannedStart"), startInput, I18n.t("interventions.modal.plannedHint")));
    const endInput: any = FormControls.date(InterventionsAdminView.isoToInput(existing ? existing.planned_end : null), { mode: "date-time" });
    root.appendChild(FormControls.fieldRow(I18n.t("interventions.modal.plannedEnd"), endInput));

    const jiraInput = FormControls.text(existing && existing.jira_ref ? existing.jira_ref : "", I18n.t("interventions.modal.jiraRefPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("interventions.modal.jiraRef"), jiraInput, I18n.t("interventions.modal.jiraHint")));

    // -- Éditeur de LIENS : famille + cible + Ajouter, liste ordonnée avec retrait. En création, les liens
    //    PRÉ-ADDÉS (déclaration depuis une fiche) initialisent la liste. --
    const links: InterventionLink[] = (existing ? existing.links : presetLinks).map((l) => ({ target_kind: l.target_kind, target_id: l.target_id }));
    root.appendChild(this.buildLinksEditor(links));

    const errBox = this.errBox();
    root.appendChild(errBox);

    this.host.openModal({
      title: editing ? I18n.t("interventions.modal.editTitle")
        : I18n.t(kind === "incident" ? "interventions.modal.createIncidentTitle" : "interventions.modal.createInterventionTitle"),
      subtitle: editing ? Html.escape(existing!.title) : (subtitleContext ? Html.escape(subtitleContext) : ""),
      body: root,
      onSave: async () => {
        errBox.style.display = "none";
        const title = titleInput.value.trim();
        if (title === "") { this.showError(errBox, I18n.t("interventions.error.titleRequired")); return false; }
        const input: InterventionInput = {
          kind,
          title,
          description: descInput.value,
          status: statusSel ? statusSel.value : createStatus,
          priority: prioritySel.value,
          planned_start: InterventionsAdminView.inputToIso(startInput.value),
          planned_end: InterventionsAdminView.inputToIso(endInput.value),
          jira_ref: jiraInput.value.trim() || null,
          links: links.slice(),
        };
        try {
          await this.client!.save(editing ? existing!.id : InterventionsAdminView.newId(), input);
          Notify.toast(I18n.t(editing ? "interventions.toast.updated" : "interventions.toast.created"), "ok");
          await this.afterWrite();
          return true;
        } catch (e) { this.showError(errBox, e); return false; }   // modale OUVERTE tant que non enregistré
      },
    });
    setTimeout(() => titleInput.focus(), 30);
  }

  /** Éditeur de liens : SÉLECTION unifiée via SearchPop (recherche sur équipements + VMs + spares CONFONDUS,
      le CLIC lie l'élément) + la liste ordonnée avec retrait par bouton-ICÔNE (principe n°14). `links` est
      mutée en place (l'ordre = position ; le serveur remplace intégralement à l'enregistrement). */
  private buildLinksEditor(links: InterventionLink[]): HTMLElement {
    const field = document.createElement("div"); field.className = "form-field";
    const label = document.createElement("label"); label.textContent = I18n.t("interventions.modal.links");
    const hint = document.createElement("div"); hint.className = "form-hint"; hint.textContent = I18n.t("interventions.modal.linksHint");
    field.append(label, hint);

    const listEl = document.createElement("div"); listEl.style.marginTop = "8px";
    const renderLinks = (): void => {
      listEl.innerHTML = "";
      if (!links.length) {
        const empty = document.createElement("div"); empty.className = "form-hint"; empty.style.fontStyle = "italic";
        empty.textContent = I18n.t("interventions.modal.linksEmpty"); listEl.appendChild(empty); return;
      }
      links.forEach((l, index) => {
        const row = document.createElement("div"); row.style.cssText = "display:flex;align-items:center;gap:8px;padding:2px 0";
        const resolved = this.targets.labelOf(l.target_kind, l.target_id);
        const icon = document.createElement("span"); icon.className = "gi"; icon.setAttribute("aria-hidden", "true"); icon.innerHTML = InterventionsAdminView.familyIcon(l.target_kind);
        const text = document.createElement("span");
        text.textContent = I18n.t(InterventionsFormat.targetKindLabelKey(l.target_kind)) + " · " + (resolved !== null ? resolved : I18n.t("interventions.target.unknown"));
        if (resolved === null) text.style.color = "var(--fg-dimmer)";   // cible disparue (orphelin) → grisée
        const del = this.iconAction(Icons.CLOSE, I18n.t("interventions.modal.linksRemove"), () => { links.splice(index, 1); renderLinks(); });
        del.style.marginLeft = "auto";
        row.append(icon, text, del); listEl.appendChild(row);
      });
    };
    renderLinks();

    // SÉLECTION unifiée (SearchPop) : la recherche traverse TOUTES les familles à la fois ; chaque résultat
    // porte son badge de famille (`tag`) ; le CLIC lie l'élément. Les cibles DÉJÀ liées sont exclues des
    // résultats (dédup calculée à chaque frappe sur l'état COURANT de `links`), un doublon résiduel étant
    // ignoré avec un toast discret. La source (recherche sur le Store) est injectée via `this.targets`.
    const pop = new SearchPop({
      placeholder: I18n.t("interventions.modal.linksSearchPlaceholder"),
      minChars: 1,
      debounceMs: EntityCandidateSource.DEBOUNCE_MS,   // même tempo que la palette / les listings serveur-pilotés
      fetch: (query) => {
        // La dédup est calculée à CHAQUE frappe sur l'état COURANT de `links`, puis les candidats
        // (serveur en mode API, locaux en mode fichier) sont habillés à l'arrivée.
        const excluded = new Set(links.map((l) => l.target_kind + ":" + l.target_id));
        return this.targets.search(query, excluded).then((results) => results.map((r): SearchPopResult => ({
          id: r.kind + ":" + r.id, label: r.label,
          tag: I18n.t(InterventionsFormat.targetKindLabelKey(r.kind)), data: r,
        })));
      },
      onPick: (result) => {
        const t = result.data as { kind: string; id: string; label: string };
        if (links.some((l) => l.target_kind === t.kind && l.target_id === t.id)) { Notify.toast(I18n.t("interventions.toast.linkExists"), "info"); return; }
        links.push({ target_kind: t.kind, target_id: t.id });
        renderLinks();
      },
    });
    const searchWrap = document.createElement("div"); searchWrap.style.marginTop = "6px"; searchWrap.appendChild(pop.element);

    field.append(searchWrap, listEl);
    return field;
  }

  /* --------------------------------------------------------------------------
     Modale de DÉTAIL (consultation) + fiches liées EMPILÉES par-dessus
     -------------------------------------------------------------------------- */

  /** Ouvre la modale de DÉTAIL d'une intervention DEPUIS L'EXTÉRIEUR de la vue (recherche globale) —
      l'appelant fournit l'enregistrement qu'il a déjà chargé (le listing de la palette). Indépendant de
      l'état de la page : `detailModal` ne lit que l'enregistrement reçu et les hooks injectés. */
  openDetail(item: InterventionRecord): void { this.detailModal(item); }

  /** Ouvre la modale de DÉTAIL d'une intervention PAR SON ID (mini-listing « Interventions » des fiches,
      hook `openDetail` du contrat) : elle s'EMPILE sur la modale courante — aucun changement de vue, le
      retour est structurel (pile de modales). L'enregistrement est RELU du serveur (l'appelant n'a que
      l'id) ; introuvable (supprimée entre-temps) → toast, rien ne s'ouvre.
      ⚠ TOUJOURS un toast en erreur, jamais le bandeau d'`actionError` : cette entrée est appelée depuis
      une fiche, la vue n'est pas forcément affichée — un bandeau 503 peint dans un conteneur CACHÉ ne
      serait vu de personne. */
  openDetailById(id: string): void {
    if (!this.client) return;
    void (async () => {
      try {
        await this.ensureMeta();   // base Jira : le détail rend son lien même si la page n'a jamais été affichée
        this.detailModalById(await this.client!.getOne(id));
      } catch (e) {
        if (e instanceof InterventionsError && e.status === 404) Notify.toast(I18n.t("interventions.toast.notFound"), "info");
        else Notify.toast(InterventionsAdminView.errText(e), "err");
      }
    })();
  }

  /** Modale de CONSULTATION ouverte DEPUIS LE LISTING. L'`item` de la page porte déjà TOUS les champs
      (liste et détail partagent la même forme serveur) — aucune relecture réseau nécessaire ici : la
      fraîcheur au retour d'une édition vient de `this.items`, que `afterWrite` vient de recharger
      (repli sur l'objet capturé si l'item a quitté la page courante). L'entrée PAR ID des fiches, où
      `this.items` peut être vide/périmé, passe par `detailModalById` (refetch). */
  private detailModal(item: InterventionRecord): void {
    this.host.openModal({
      title: I18n.t("interventions.detail.title"), subtitle: Html.escape(item.title), body: this.detailBody(item),
      footerActions: this.editFooterActions(() => item), hideFooter: true, wide: true,
      stackKey: "intervention:" + item.id,
      // Retour au premier plan → fiche RECONSTRUITE. On repart de l'enregistrement RECHARGÉ (`afterWrite`
      // rafraîchit `items` après toute écriture) plutôt que de l'objet capturé, qui serait resté d'avant
      // l'édition ; repli sur l'objet capturé si l'item n'est plus dans la page courante.
      onResume: () => this.detailModal(this.items.find((it) => it.id === item.id) || item),
    });
  }

  /** Modale de CONSULTATION ouverte PAR ID (depuis une fiche — la vue n'est pas active). Même corps que
      `detailModal`, mais la FRAÎCHEUR au retour d'une édition vient d'un REFETCH par id : ici `this.items`
      (la page du LISTING) peut être vide ou refléter d'autres filtres — le repli de `detailModal` sur
      l'objet capturé montrerait les valeurs d'AVANT l'édition.
      MÉCANIQUE (l'`onResume` de la pile est SYNCHRONE, le refetch ne l'est pas) : le corps vit dans un
      CONTENEUR STABLE (`shell`). Au retour au premier plan, l'`onResume` ré-ouvre SYNCHRONEMENT le niveau
      avec les données déjà en main (remplacement — l'affichage ne saute pas), puis le refetch REMPLACE le
      CONTENU du conteneur quand la vérité serveur arrive. On ne rappelle JAMAIS `openModal` depuis le
      rappel asynchrone : la dédup `stackKey` y jetterait les niveaux empilés entre-temps PAR-DESSUS (une
      saisie en cours, une fiche visitée). Seule exception, INDIRECTE : si le TITRE a changé (il vit dans
      le SOUS-TITRE du niveau, pas dans le corps), on demande à la modale de rejouer l'`onResume` du niveau
      COURANT (`refreshModal`) — si c'est le nôtre, il se ré-ouvre avec le titre frais puis re-vérifie
      (convergent : la re-vérification ne trouve plus d'écart) ; si l'utilisateur a déjà empilé autre chose,
      le sommet se reconstruit sans dommage et NOTRE sous-titre se corrigera à son propre retour au premier
      plan (l'`onResume` rejoue à chaque résurgence). */
  private detailModalById(initial: InterventionRecord): void {
    let current = initial;
    const shell = document.createElement("div");
    shell.appendChild(this.detailBody(current));
    const refetch = async (): Promise<void> => {
      try {
        const fresh = await this.client!.getOne(current.id);
        if (JSON.stringify(fresh) === JSON.stringify(current)) return;   // point fixe : rien de neuf, rien à repeindre
        const titleChanged = fresh.title !== current.title;
        current = fresh;
        shell.replaceChildren(this.detailBody(fresh));
        if (titleChanged) this.host.refreshModal?.();   // sous-titre du NIVEAU (cf. doc ci-dessus)
      } catch (e) {
        if (e instanceof InterventionsError && e.status === 404) {
          // Supprimée pendant l'édition/la consultation : plus rien à montrer — toast + retrait du niveau.
          Notify.toast(I18n.t("interventions.toast.notFound"), "info");
          this.host.closeModal?.();
        }
        // Autre erreur (réseau…) : on conserve le contenu déjà affiché — le détail reste consultable.
      }
    };
    const openLevel = (): void => {
      this.host.openModal({
        title: I18n.t("interventions.detail.title"), subtitle: Html.escape(current.title), body: shell,
        // Le bouton lit `current` au CLIC (getter) → toujours la version refetchée, jamais l'objet initial.
        footerActions: this.editFooterActions(() => current), hideFooter: true, wide: true,
        stackKey: "intervention:" + current.id,
        onResume: () => { openLevel(); void refetch(); },   // synchrone : données en main ; asynchrone : vérité serveur
      });
    };
    openLevel();
  }

  /** Corps de la fiche de détail — PARTAGÉ par les deux ouvertures (`detailModal` depuis le listing,
      `detailModalById` depuis une fiche). CONTENEUR STABLE dont le contenu se REPEINT en place quand une
      action du bloc « Ticket » a changé l'intervention côté serveur : c'est le corps ENTIER qui est
      refait, et pas seulement le bloc, parce qu'une réplication écrit AUSSI la référence du ticket —
      rafraîchir le bloc seul laisserait la rangée « Jira » juste au-dessus afficher « — » alors que la
      clé vient d'être créée. On ne rappelle JAMAIS `openModal` pour autant : sa dédup par `stackKey`
      jetterait les niveaux empilés entre-temps (piège documenté sur `detailModalById`). */
  private detailBody(item: InterventionRecord): HTMLElement {
    const shell = document.createElement("div");
    const repaint = (rec: InterventionRecord): void => { shell.replaceChildren(this.detailContent(rec, repaint)); };
    repaint(item);
    return shell;
  }

  /** Contenu de la fiche de détail : badges (nature/priorité/statut), fenêtre planifiée, référence Jira,
      bloc « Ticket » du pont, description rendue en MARKDOWN, la liste des objets liés (icône de famille +
      libellé + badge ; orphelin « introuvable » grisé, NON cliquable — un CLIC sur un objet lié existant
      EMPILE sa fiche par-dessus) et l'audit. Le bouton « Modifier » ne fait PLUS partie de ce corps
      défilant : il vit dans le PIED FIXE de la modale (footerActions, cf. `editFooterActions`).
      Reconstruit à neuf à chaque (ré)ouverture ET à chaque repeint — jamais muté. */
  private detailContent(item: InterventionRecord, repaint: (rec: InterventionRecord) => void): HTMLElement {
    const root = document.createElement("div");

    const badges = document.createElement("div"); badges.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px";
    badges.innerHTML = this.badge(I18n.t(InterventionsFormat.kindLabelKey(item.kind)), "neutral")
      + this.badge(I18n.t(InterventionsFormat.priorityLabelKey(item.priority)), InterventionsFormat.priorityClass(item.priority))
      + this.badge(I18n.t(InterventionsFormat.statusLabelKey(item.status)), InterventionsFormat.statusClass(item.status));
    root.appendChild(badges);

    const win = InterventionsFormat.formatWindow(item.planned_start, item.planned_end);
    root.appendChild(this.detailField(I18n.t("interventions.col.window"), this.textValue(win || "—", !win)));
    root.appendChild(this.detailField(I18n.t("interventions.col.jira"), this.jiraInline(item)));
    this.attachTrackerBlock(root, item, repaint);   // bloc « Ticket » (pont AMOVIBLE) — rien si le pont est absent

    // Description : MARKDOWN (micromark, défauts sûrs → sortie injectable en innerHTML — cf. core/Markdown).
    const desc = document.createElement("div");
    if (item.description && item.description.trim() !== "") { desc.className = "md-body"; desc.innerHTML = Markdown.render(item.description); }
    else { desc.className = "form-hint"; desc.style.fontStyle = "italic"; desc.textContent = I18n.t("interventions.detail.noDescription"); }
    root.appendChild(this.detailField(I18n.t("interventions.modal.description"), desc));

    root.appendChild(this.detailField(I18n.t("interventions.modal.links"), this.detailLinksList(item)));
    // Audit : created_by/updated_by = IDS canoniques → résolus par l'annuaire. Rendu SYNCHRONE (cache, id brut
    // en repli) puis re-peint quand le lot d'ids manquants arrive (ensure coalescé). Legacy = nom en clair tel quel.
    const createdEl = this.textValue(this.auditText(item.created_by, item.created_date));
    const updatedEl = this.textValue(this.auditText(item.updated_by, item.updated_date));
    root.appendChild(this.detailField(I18n.t("interventions.col.createdBy"), createdEl));
    root.appendChild(this.detailField(I18n.t("interventions.detail.updatedBy"), updatedEl));
    const dir = this.directory;
    if (dir) {
      const ids = [item.created_by, item.updated_by].filter((x) => x);
      if (ids.length) void dir.ensure(ids).then(() => {
        createdEl.textContent = this.auditText(item.created_by, item.created_date);
        updatedEl.textContent = this.auditText(item.updated_by, item.updated_date);
      }).catch(() => { /* auteurs non critiques */ });
    }

    return root;
  }

  /** BRANCHEMENT du bloc « Ticket » dans la fiche de détail (principe n°2 : la vue ne fait que poser le
      bloc, lui projeter l'intervention et lui dire comment demander un rafraîchissement — tout le reste
      vit dans `TrackerTicketBlock`). No-op si le pont n'est pas branché : la fiche est alors STRICTEMENT
      celle d'avant le chantier.
      La PROJECTION est ce qui garde le bloc agnostique de marque : c'est ICI, et nulle part chez lui,
      qu'on lit le champ HÉRITÉ de référence et qu'on arbitre l'URL à ouvrir. */
  private attachTrackerBlock(root: HTMLElement, item: InterventionRecord, repaint: (rec: InterventionRecord) => void): void {
    if (!this.tracker) return;
    TrackerTicketBlock.attach(root, {
      client: this.tracker,
      providers: this.trackerProviders,
      onChanged: () => void this.refreshTicket(item.id, repaint),
    }, {
      id: item.id,
      reference: (item.jira_ref || "").trim(),
      url: TrackerReplication.ticketUrl(item.tracker_url, InterventionsFormat.jiraUrl(this.jiraBase, item.jira_ref)),
      state: item,
    });
  }

  /** Relit une intervention par son id et repeint le corps de la fiche avec la vérité serveur, puis
      rafraîchit le listing s'il est à l'écran (pastille, indicateur d'échec) — la fiche peut avoir été
      ouverte depuis un objet, la vue n'étant alors même pas affichée. Une erreur de relecture est avalée :
      la fiche garde son contenu (périmé mais lisible) plutôt que de se vider — l'action, elle, a déjà été
      confirmée par son propre message. */
  private async refreshTicket(id: string, repaint: (rec: InterventionRecord) => void): Promise<void> {
    try { repaint(await this.client!.getOne(id)); } catch (_) { /* la fiche reste telle quelle */ }
    if (this.bodyEl) await this.refreshBody();
  }

  /** Bouton « Modifier » du PIED de la fiche (footerActions) — hors du corps DÉFILANT `detailBody`, donc
      toujours visible. Il EMPILE la modale d'ÉDITION par-dessus ce détail, qui reste vivant dessous ;
      Enregistrer ou Annuler dépile et redonne ce détail (reconstruit par l'`onResume` du niveau, donc à
      jour). Le record est lu par un GETTER au moment du clic : l'ouverture PAR ID (`detailModalById`)
      remplace son enregistrement au refetch, et le bouton, construit une fois, doit alors éditer la version
      COURANTE — pas l'objet initial, périmé. */
  private editFooterActions(getItem: () => InterventionRecord): HTMLElement[] {
    return [this.actionButton(I18n.t("interventions.rowAction.edit"), "", () => { const it = getItem(); this.interventionModal(it, it.kind); }, "btn-primary")];
  }

  /** Liste ÉLÉGANTE des objets liés (modale de détail) : icône de famille + libellé + badge de famille. Une
      cible existante est CLIQUABLE (sa fiche s'EMPILE ; ce détail reparaît au dépilement) ; une cible
      disparue s'affiche « introuvable » grisée et NON cliquable (orphelin toléré). */
  private detailLinksList(item: InterventionRecord): HTMLElement {
    const wrap = document.createElement("div");
    if (!item.links.length) {
      wrap.className = "form-hint"; wrap.style.fontStyle = "italic"; wrap.textContent = I18n.t("interventions.modal.linksEmpty");
      return wrap;
    }
    wrap.style.cssText = "display:flex;flex-direction:column;gap:4px";
    for (const l of item.links) {
      const resolved = this.targets.labelOf(l.target_kind, l.target_id);
      const row = document.createElement("div"); row.style.cssText = "display:flex;align-items:center;gap:8px";
      const icon = document.createElement("span"); icon.className = "gi"; icon.setAttribute("aria-hidden", "true"); icon.innerHTML = InterventionsAdminView.familyIcon(l.target_kind);
      const text = document.createElement("span");
      if (resolved !== null) {
        const link = document.createElement("a"); link.href = "#"; link.textContent = resolved; link.style.cursor = "pointer";
        // La fiche de la cible s'EMPILE : ce détail reste vivant dessous et se rafraîchit tout seul au
        // retour (cf. l'`onResume` de `detailModal`).
        link.onclick = (e) => { e.preventDefault(); this.targets.openTargetDetail(l.target_kind, l.target_id); };
        text.appendChild(link);
      } else {
        text.textContent = I18n.t("interventions.target.unknown"); text.style.color = "var(--fg-dimmer)";
      }
      const fam = document.createElement("span"); fam.innerHTML = this.badge(I18n.t(InterventionsFormat.targetKindLabelKey(l.target_kind)), "neutral");
      row.append(icon, text, fam);
      wrap.appendChild(row);
    }
    return wrap;
  }

  /** Rangée « libellé + valeur » d'une modale de CONSULTATION (lecture seule, sans champ éditable). */
  private detailField(label: string, value: HTMLElement): HTMLElement {
    const f = document.createElement("div"); f.className = "form-field";
    const l = document.createElement("label"); l.textContent = label;
    f.append(l, value);
    return f;
  }

  /** Valeur texte simple (estompée si `muted`) d'une modale de consultation. */
  private textValue(text: string, muted = false): HTMLElement {
    const div = document.createElement("div"); div.textContent = text;
    if (muted) div.style.color = "var(--fg-dimmer)";
    return div;
  }

  /** Ligne d'audit « auteur · date » (auteur seul si la date manque ; « — » si rien). L'auteur est résolu
      via l'annuaire (id canonique → nom ; legacy = nom en clair tel quel). */
  private auditText(who: string, dateIso: string): string {
    const author = this.authorDisplay(who);
    return dateIso ? author + " · " + Format.dateTime(dateIso) : author;
  }

  /* --------------------------------------------------------------------------
     Cellules & pagination
     -------------------------------------------------------------------------- */

  /** En-tête NON triable ; `cls` porte l'alignement de la colonne (ex. « cell-num » à droite, « cell-actions »). */
  private plainTh(text: string, cls = ""): HTMLElement {
    const th = document.createElement("th"); if (cls) th.className = cls; th.textContent = text; return th;
  }

  /** En-tête TRIABLE (CSS ListView : .sortable + .sort-ind ▲/▼). Clic : bascule le sens si déjà actif, sinon
      trie ASC ; retour page 1 puis repeint le corps (rechargement serveur). */
  private sortableTh(text: string, sortKey: string, st: ListingState): HTMLElement {
    const th = document.createElement("th"); th.className = "sortable"; th.textContent = text;
    if (st.sort === sortKey) {
      const ind = document.createElement("span"); ind.className = "sort-ind"; ind.textContent = " " + (st.dir === "desc" ? "▼" : "▲");
      th.appendChild(ind);
    }
    th.onclick = () => {
      if (st.sort === sortKey) st.dir = st.dir === "desc" ? "asc" : "desc";
      else { st.sort = sortKey; st.dir = "asc"; }
      st.page = 1;
      void this.refreshBody();
    };
    return th;
  }

  private emptyRow(colspan: number): HTMLElement {
    const tr = document.createElement("tr"); tr.className = "empty-row";
    const td = document.createElement("td"); td.colSpan = colspan; td.textContent = I18n.t("interventions.msg.empty");
    tr.appendChild(td);
    return tr;
  }

  /** Bloc pagination standard (.pagination) : « N élément(s) · page x/y » + first/prev/next/last + « N/page ».
      TOUTE navigation recharge la page côté SERVEUR (jamais de slice client). */
  private buildPagination(): HTMLElement {
    const st = this.state;
    const meta = this.pageMeta || { total: 0, page: 1, pages: 1, pageSize: st.pageSize };
    const wrap = document.createElement("div"); wrap.className = "pagination";
    const info = document.createElement("div");
    info.textContent = I18n.t("interventions.pager.count", { n: meta.total }) + " · " + I18n.t("interventions.pager.page", { page: meta.page, pages: meta.pages });
    const controls = document.createElement("div"); controls.className = "pagination-controls";
    const nav = (label: string, disabled: boolean, to: number): HTMLButtonElement => {
      const b = document.createElement("button"); b.type = "button"; b.className = "page-btn"; b.textContent = label; b.disabled = disabled;
      b.onclick = () => { st.page = to; void this.refreshBody(); };
      return b;
    };
    controls.appendChild(nav("«", meta.page <= 1, 1));
    controls.appendChild(nav("‹", meta.page <= 1, Math.max(1, meta.page - 1)));
    const pos = document.createElement("span"); pos.style.cssText = "padding:0 6px"; pos.textContent = meta.page + " / " + meta.pages;
    controls.appendChild(pos);
    controls.appendChild(nav("›", meta.page >= meta.pages, Math.min(meta.pages, meta.page + 1)));
    controls.appendChild(nav("»", meta.page >= meta.pages, meta.pages));
    const sel = document.createElement("select"); sel.className = "page-size app-select";
    for (const n of PAGE_SIZE_OPTIONS) { const o = document.createElement("option"); o.value = String(n); o.textContent = I18n.t("interventions.pager.perPage", { n }); if (n === st.pageSize) o.selected = true; sel.appendChild(o); }
    sel.onchange = () => { st.pageSize = parseInt(sel.value, 10); st.page = 1; void this.refreshBody(); };
    controls.appendChild(sel);
    wrap.append(info, controls);
    return wrap;
  }

  /* --------------------------------------------------------------------------
     Messages d'indisponibilité
     -------------------------------------------------------------------------- */

  private renderNeedsApi(): void {
    this.renderBanner("var(--line)", I18n.t("interventions.msg.needsApiTitle"), I18n.t("interventions.msg.needsApi"));
  }

  private renderNoDoc(): void {
    this.renderBanner("var(--line)", I18n.t("interventions.msg.noDocTitle"), I18n.t("interventions.msg.noDoc"));
  }

  private renderDisabled(err: InterventionsError): void {
    this.renderBanner("var(--warn)", err.message || I18n.t("interventions.msg.disabledTitle"), err.detail || I18n.t("interventions.msg.disabled"));
  }

  private renderBanner(borderColor: string, titleText: string, detailText: string): void {
    this.container.innerHTML = "";
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid " + borderColor + ";border-radius:6px;padding:16px;background:var(--bg-2)";
    const title = document.createElement("div"); title.style.cssText = "font-weight:600;color:var(--fg);margin-bottom:6px"; title.textContent = titleText;
    const detail = document.createElement("div"); detail.className = "form-hint"; detail.style.whiteSpace = "pre-line"; detail.textContent = detailText;
    box.append(title, detail); this.container.appendChild(box);
  }

  private renderMessage(text: string, isError = false): void {
    this.container.innerHTML = "";
    const n = document.createElement("div"); n.className = isError ? "form-hint err" : "form-hint"; n.textContent = text;
    this.container.appendChild(n);
  }

  /** Erreur d'une action ponctuelle → 503 : bandeau ; sinon toast. */
  private actionError(e: unknown): void {
    if (e instanceof InterventionsError && e.status === 503) { this.renderDisabled(e); return; }
    Notify.toast(InterventionsAdminView.errText(e), "err");
  }

  /** Affiche une erreur dans la zone d'erreur d'un formulaire. 503 (module coupé) : plus rien à éditer —
      on FERME la modale et on affiche le bandeau à la place du contenu. */
  private showError(errBox: HTMLElement, e: unknown): void {
    if (e instanceof InterventionsError && e.status === 503) { this.host.closeModal?.(); this.renderDisabled(e); return; }
    errBox.style.display = "block";
    errBox.textContent = typeof e === "string" ? e : InterventionsAdminView.errText(e);
  }

  /* --------------------------------------------------------------------------
     Primitives DOM + helpers statiques
     -------------------------------------------------------------------------- */

  private static readonly MUTED = `<span style="color:var(--fg-dimmer)">—</span>`;

  private actionButton(label: string, title: string, onClick: () => void, cls = "btn-ghost"): HTMLButtonElement {
    const b = document.createElement("button"); b.type = "button"; b.className = "btn " + cls + " btn-sm";
    b.textContent = label; if (title) b.title = title; b.onclick = onClick;
    return b;
  }

  /** Bouton d'action ICÔNE — délègue au constructeur PARTAGÉ (ui/IconButton) : aria-label + title obligatoires
      (i18n), un seul style d'a11y pour toute l'app. `danger` teinte le survol en rouge (suppression). */
  private iconAction(icon: string, label: string, onClick: () => void, danger = false): HTMLButtonElement {
    return IconButton.build({ icon, label, danger, onClick });
  }

  /** Icône de FAMILLE d'une cible liable — repère visuel de la liste des objets liés.
      `sub_equipment` réutilise DÉLIBÉRÉMENT l'icône d'équipement : un sous-équipement est le contenu
      logique d'un équipement, pas une famille visuelle de plus — et le libellé (colonne famille) fait
      déjà la distinction. Le défaut EQUIPMENT reste le repli des slugs inconnus. */
  private static familyIcon(kind: string): string {
    return kind === "vm" ? Icons.VM : kind === "spare" ? Icons.SPARE : Icons.EQUIPMENT;
  }

  /** Pastille sémantique (mêmes couleurs que NotificationsAdminView/CertsAdminView). */
  private badge(text: string, kind: BadgeClass): string {
    const style = kind === "ok" ? ` style="border-color:var(--ok);color:var(--ok)"`
      : kind === "err" ? ` style="border-color:var(--err);color:var(--err)"`
      : kind === "warn" ? ` style="border-color:var(--warn);color:var(--warn)"`
      : kind === "dim" ? ` style="border-color:var(--fg-dimmer);color:var(--fg-dim)"`
      : "";
    return `<span class="pill"${style}>${Html.escape(text)}</span>`;
  }

  private htmlCell(html: string): HTMLTableCellElement {
    const td = document.createElement("td"); td.innerHTML = html; return td;
  }

  private errBox(): HTMLElement {
    const e = document.createElement("div"); e.className = "form-hint err"; e.style.cssText = "margin-top:10px;white-space:pre-line;display:none";
    return e;
  }

  /** État de listing NEUF : page 1, taille par défaut, tri par date de modification décroissante (parité
      serveur), aucun filtre ni recherche. */
  private static defaultState(): ListingState {
    return { page: 1, pageSize: PAGE_SIZE_DEFAULT, sort: "updated_date", dir: "desc", query: "", kinds: new Set(), statuses: new Set(), priorities: new Set(), targets: new Set() };
  }

  /** Paramètres de listing (query string) dérivés d'un état. Filtres vides = omis. */
  private static listParams(st: ListingState): InterventionsListParams {
    return {
      page: st.page, pageSize: st.pageSize, sort: st.sort, dir: st.dir,
      query: st.query || undefined,
      kinds: st.kinds.size ? [...st.kinds] : undefined,
      statuses: st.statuses.size ? [...st.statuses] : undefined,
      priorities: st.priorities.size ? [...st.priorities] : undefined,
      targets: InterventionsAdminView.targetPairs(st.targets),
    };
  }

  /** Couples {kind,id} du filtre de CIBLE (le serveur les attend décodés) — `undefined` si aucun filtre.
      Une clé illisible est ÉCARTÉE plutôt qu'envoyée : la valeur d'une dimension « à recherche » est libre,
      donc jamais présumée saine (état d'une version antérieure, saisie exotique). */
  private static targetPairs(keys: ReadonlySet<string>): Array<{ kind: string; id: string }> | undefined {
    const pairs = [...keys].map((key) => TargetSearch.parse(key)).filter((t): t is { kind: string; id: string } => t !== null);
    return pairs.length ? pairs : undefined;
  }

  /** Corps PUT complet depuis un enregistrement (SANS les champs d'audit — le serveur les pose). */
  private static toInput(rec: InterventionRecord): InterventionInput {
    return {
      kind: rec.kind, title: rec.title, description: rec.description, status: rec.status, priority: rec.priority,
      planned_start: rec.planned_start, planned_end: rec.planned_end, jira_ref: rec.jira_ref,
      links: rec.links.map((l) => ({ target_kind: l.target_kind, target_id: l.target_id })),
    };
  }

  /** Items de MultiSelect à partir de slugs + une fonction de clé i18n (libellés localisés au point d'appel). */
  private static slugItems(slugs: readonly string[], keyOf: (slug: string) => string): MultiItem[] {
    return slugs.map((s) => ({ id: s, label: I18n.t(keyOf(s)) }));
  }

  /** Options de <select> à partir de slugs + une fonction de clé i18n. */
  private static slugOptions(slugs: readonly string[], keyOf: (slug: string) => string): SelectOption[] {
    return slugs.map((s) => ({ value: s, label: I18n.t(keyOf(s)) }));
  }

  /** ISO 8601 → valeur d'un <input datetime-local> (« YYYY-MM-DDTHH:MM », portion UTC tronquée) ; "" si absent.
      Les instants sont manipulés en UTC (cohérence avec le stockage serveur et le veilleur). */
  private static isoToInput(iso: string | null | undefined): string {
    return typeof iso === "string" && iso.trim() !== "" ? iso.slice(0, 16) : "";
  }

  /** Valeur d'un <input datetime-local> → ISO 8601 (interprétée en UTC) ; null si vide/illisible. */
  private static inputToIso(val: string): string | null {
    const v = (val || "").trim();
    if (v === "") return null;
    const base = v.length === 16 ? v + ":00" : v;   // ajoute les secondes si l'input ne les fournit pas
    const d = new Date(base + "Z");                  // « Z » : interprété en UTC
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  /** Identifiant neuf pour une création (PUT idempotent par id côté serveur). */
  private static newId(): string {
    try { if (typeof crypto !== "undefined" && (crypto as any).randomUUID) return (crypto as any).randomUUID(); } catch (_) { /* repli ci-dessous */ }
    return "i-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  private static errText(e: unknown): string {
    if (e instanceof InterventionsError) return e.message + (e.detail ? "\n" + e.detail : "");
    return e instanceof Error ? e.message : String(e);
  }
}
