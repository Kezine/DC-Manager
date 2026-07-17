import { Html } from "../core/Html";
import { Format } from "../core/Format";
import { Markdown } from "../core/Markdown";
import { I18n } from "../i18n/I18n";
import { InterventionsFormat, type BadgeClass } from "../core/InterventionsFormat";
import { FormControls, type SelectOption } from "../ui/FormControls";
import { MultiSelect, type MultiItem } from "../ui/MultiSelect";
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

   LISTING PAGINÉ SERVEUR : filtres (recherche + Type/Statut/Priorité en MultiSelect),
   tris par en-tête et pagination portés par la REQUÊTE (jamais de slice client) ;
   l'UI reprend les classes CSS des ListView (.list-toolbar/.pagination/.sortable).
   L'état de listing vit en MÉMOIRE d'instance (rechargé après chaque écriture).
   ============================================================================= */

/** Source des cibles liables (équipements/VMs/spares) — interface hôte INJECTÉE (la vue ne connaît pas le
    Store). `labelOf` résout le libellé d'un lien existant (null = cible disparue → « introuvable » côté UI,
    orphelin toléré) ; `search` alimente la SÉLECTION unifiée (SearchPop) de l'éditeur de liens ;
    `openTargetDetail` ouvre la fiche de la cible avec retour-auto (aller-retour). */
export interface InterventionTargetSource {
  /** Libellé d'une cible précise, ou null si elle n'existe plus dans le document (orphelin). */
  labelOf(kind: string, id: string): string | null;
  /** Recherche UNIFIÉE sur TOUTES les familles liables (équipements + VMs + spares CONFONDUS) : renvoie des
      candidats {kind,id,label} déjà TRIÉS par pertinence (préfixe avant inclusion) et BORNÉS. `excluded` =
      clés « kind:id » des cibles déjà liées, écartées des résultats (dédup). Insensible casse/accents. */
  search(query: string, excluded?: ReadonlySet<string>): Array<{ kind: string; id: string; label: string }>;
  /** Ouvre la FICHE DE DÉTAIL existante d'une cible (equipment/vm/spare). `onClosed` est rappelé à la
      FERMETURE de cette fiche (quelle qu'en soit la cause) → retour-auto à la modale de détail de
      l'intervention (l'app n'a qu'un overlay de modale, sans empilement). */
  openTargetDetail(kind: string, id: string, onClosed: () => void): void;
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
}

export class InterventionsAdminView {
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

  constructor(
    private readonly container: HTMLElement,
    /** null = mode fichier/viewer (service sans objet) → message d'indisponibilité. */
    private readonly client: InterventionsClient | null,
    /** Hôte de modale de l'app — les formulaires s'ouvrent dans LA modale standard (principe n°11). */
    private readonly host: FormHost,
    /** Source des cibles liables (Store injecté par main.ts — la vue ne touche jamais le Store). */
    private readonly targets: InterventionTargetSource,
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
  }

  /** Charge la PAGE COURANTE depuis le serveur. La page effective est relue de la réponse (le serveur
      CLAMPE si la page demandée n'existe plus après une écriture/un filtre). */
  private async loadPage(): Promise<void> {
    const res = await this.client!.listPage(InterventionsAdminView.listParams(this.state));
    this.items = res.interventions;
    this.pageMeta = { total: res.total, page: res.page, pages: res.pages, pageSize: res.pageSize };
    this.state.page = res.page;
  }

  /** Re-render COMPLET (toolbar de filtres comprise) — après (re)chargement / réinitialisation des filtres. */
  private async rerender(): Promise<void> {
    await this.guarded(async () => { await this.loadPage(); this.render(); });
  }

  /** Recharge la page courante et repeint UNIQUEMENT le corps — la toolbar (recherche + filtres) reste en
      place. Sert aussi APRÈS une écriture (la page courante est rechargée, clamp serveur si elle a disparu). */
  private async refreshBody(): Promise<void> {
    await this.guarded(async () => { await this.loadPage(); this.paintBody(); });
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
    this.container.appendChild(this.buildToolbar());
    this.container.appendChild(this.buildFilterToolbar());
    this.bodyEl = document.createElement("div");
    this.container.appendChild(this.bodyEl);
    this.paintBody();
  }

  /** Barre d'outils du haut : recherche (gauche) + créations & actualisation (droite). NON reconstruite sur
      refreshBody → le champ de recherche garde son focus pendant la frappe. */
  private buildToolbar(): HTMLElement {
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px";

    // Champ de recherche NORMALISÉ (même markup/thème que la recherche des listings — classe `.search-input`,
    // type search) ; le comportement (anti-rebond + requête serveur) reste propre à cette page paginée.
    const search = document.createElement("input");
    search.type = "search"; search.className = "search-input"; search.placeholder = I18n.t("interventions.search.placeholder");
    search.value = this.state.query; search.style.cssText = "min-width:240px;flex:0 1 320px";
    search.oninput = () => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.state.query = search.value.trim(); this.state.page = 1; void this.refreshBody();
      }, 250);
    };
    const left = document.createElement("div"); left.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap";
    left.appendChild(search);

    const right = document.createElement("div"); right.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";
    right.append(
      this.actionButton(I18n.t("interventions.action.addIncident"), "", () => this.interventionModal(null, "incident"), "btn-primary"),
      this.actionButton(I18n.t("interventions.action.addIntervention"), "", () => this.interventionModal(null, "intervention"), "btn-primary"),
      this.actionButton(I18n.t("interventions.action.refresh"), "", () => void this.reload()),
    );

    bar.append(left, right);
    return bar;
  }

  /** Toolbar de filtres (CSS ListView) : « Type »/« Statut »/« Priorité » en MultiSelect (répétables) + réinit. */
  private buildFilterToolbar(): HTMLElement {
    const st = this.state;
    const bar = document.createElement("div"); bar.className = "list-toolbar";
    const fg = document.createElement("div"); fg.className = "lt-filters";
    const fl = document.createElement("span"); fl.className = "lt-flabel"; fl.textContent = I18n.t("interventions.filter.label");
    fg.appendChild(fl);

    fg.appendChild(MultiSelect.build(I18n.t("interventions.filter.type"), InterventionsAdminView.slugItems(InterventionsFormat.KIND_SLUGS, (s) => InterventionsFormat.kindLabelKey(s)), st.kinds, () => { st.page = 1; void this.refreshBody(); }));
    fg.appendChild(MultiSelect.build(I18n.t("interventions.filter.status"), InterventionsAdminView.slugItems(InterventionsFormat.STATUS_SLUGS, (s) => InterventionsFormat.statusLabelKey(s)), st.statuses, () => { st.page = 1; void this.refreshBody(); }));
    fg.appendChild(MultiSelect.build(I18n.t("interventions.filter.priority"), InterventionsAdminView.slugItems(InterventionsFormat.PRIORITY_SLUGS, (s) => InterventionsFormat.priorityLabelKey(s)), st.priorities, () => { st.page = 1; void this.refreshBody(); }));

    const reset = document.createElement("button"); reset.type = "button"; reset.className = "lt-reset btn btn-ghost btn-sm";
    reset.textContent = I18n.t("interventions.filter.reset");
    reset.onclick = () => { st.kinds.clear(); st.statuses.clear(); st.priorities.clear(); st.page = 1; void this.rerender(); };
    fg.appendChild(reset);

    bar.appendChild(fg);
    return bar;
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
      this.plainTh(I18n.t("interventions.col.links")),
      this.plainTh(I18n.t("interventions.col.jira")),
      this.plainTh(I18n.t("interventions.col.createdBy")),
      this.plainTh(I18n.t("interventions.col.actions")),
    );
    thead.appendChild(tr);
    const tbody = document.createElement("tbody");
    if (!this.items.length) tbody.appendChild(this.emptyRow(9));
    else for (const item of this.items) tbody.appendChild(this.buildRow(item));
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

    const createdBy = document.createElement("td"); createdBy.textContent = item.created_by || "—";
    createdBy.title = item.created_date ? Format.dateTime(item.created_date) : "";
    tr.appendChild(createdBy);

    tr.appendChild(this.actionsCell(item));
    return tr;
  }

  /** Cellule « Liens » : compte + énumération en title (chaque lien = famille · libellé, « introuvable » si
      la cible a disparu — orphelin toléré). */
  private linksCell(item: InterventionRecord): HTMLElement {
    const td = document.createElement("td");
    if (!item.links.length) { td.innerHTML = InterventionsAdminView.MUTED; return td; }
    td.textContent = String(item.links.length);
    td.title = item.links.map((l) => {
      const label = this.targets.labelOf(l.target_kind, l.target_id);
      return I18n.t(InterventionsFormat.targetKindLabelKey(l.target_kind)) + " · " + (label !== null ? label : I18n.t("interventions.target.unknown"));
    }).join("\n");
    return td;
  }

  /** Cellule « Jira » : réutilise le contenu inline (lien/texte/« — ») dans un `<td>`. */
  private jiraCell(item: InterventionRecord): HTMLElement {
    const td = document.createElement("td"); td.appendChild(this.jiraInline(item)); return td;
  }

  /** Contenu Jira RÉUTILISABLE (listing + modale de détail) : lien cliquable si une URL est fabricable
      (base + clé, ou clé déjà URL) ; sinon texte brut mono (base non configurée) ; « — » si aucune référence. */
  private jiraInline(item: InterventionRecord): HTMLElement {
    const ref = item.jira_ref;
    if (!ref) { const s = document.createElement("span"); s.innerHTML = InterventionsAdminView.MUTED; return s; }
    const url = InterventionsFormat.jiraUrl(this.jiraBase, ref);
    if (url) {
      const a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = ref;
      a.style.cssText = "font-family:var(--mono);font-size:12px";
      return a;
    }
    const span = document.createElement("span"); span.style.cssText = "font-family:var(--mono);font-size:12px"; span.textContent = ref;
    return span;
  }

  /** Actions par ligne, en boutons-ICÔNE (principe n°14) : Détails · Modifier · Démarrer (declared/planned →
      in_progress) · Clore (in_progress → closed) · Supprimer (danger). Les transitions rapides relisent le
      corps complet (GET) puis PUT le status changé (le serveur re-estampille updated_*). */
  private actionsCell(item: InterventionRecord): HTMLElement {
    const td = document.createElement("td"); td.style.cssText = "display:flex;gap:4px;flex-wrap:wrap";
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
      await this.refreshBody();
    } catch (e) { this.actionError(e); }
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
      await this.refreshBody();
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
          await this.refreshBody();
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
      fetch: (query) => {
        const excluded = new Set(links.map((l) => l.target_kind + ":" + l.target_id));
        const results = this.targets.search(query, excluded);
        return Promise.resolve(results.map((r): SearchPopResult => ({
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
     Modale de DÉTAIL (consultation) + aller-retour vers les fiches liées
     -------------------------------------------------------------------------- */

  /** Modale de CONSULTATION d'une intervention (hideFooter) : badges (nature/priorité/statut), fenêtre
      planifiée, référence Jira, description rendue en MARKDOWN, audit, et la liste des objets liés (icône de
      famille + libellé + badge ; orphelin « introuvable » grisé, NON cliquable). Un CLIC sur un objet lié
      existant ouvre sa fiche de détail PUIS revient ICI à la fermeture (aller-retour — overlay unique). Le
      bouton « Modifier » bascule vers la modale d'ÉDITION (openModal remplace le contenu, fermer-puis-ouvrir).
      L'`item` du listing porte déjà TOUS les champs (liste et détail partagent la même forme serveur) — aucune
      relecture réseau nécessaire. */
  private detailModal(item: InterventionRecord): void {
    const root = document.createElement("div");

    const badges = document.createElement("div"); badges.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px";
    badges.innerHTML = this.badge(I18n.t(InterventionsFormat.kindLabelKey(item.kind)), "neutral")
      + this.badge(I18n.t(InterventionsFormat.priorityLabelKey(item.priority)), InterventionsFormat.priorityClass(item.priority))
      + this.badge(I18n.t(InterventionsFormat.statusLabelKey(item.status)), InterventionsFormat.statusClass(item.status));
    root.appendChild(badges);

    const win = InterventionsFormat.formatWindow(item.planned_start, item.planned_end);
    root.appendChild(this.detailField(I18n.t("interventions.col.window"), this.textValue(win || "—", !win)));
    root.appendChild(this.detailField(I18n.t("interventions.col.jira"), this.jiraInline(item)));

    // Description : MARKDOWN (micromark, défauts sûrs → sortie injectable en innerHTML — cf. core/Markdown).
    const desc = document.createElement("div");
    if (item.description && item.description.trim() !== "") { desc.className = "md-body"; desc.innerHTML = Markdown.render(item.description); }
    else { desc.className = "form-hint"; desc.style.fontStyle = "italic"; desc.textContent = I18n.t("interventions.detail.noDescription"); }
    root.appendChild(this.detailField(I18n.t("interventions.modal.description"), desc));

    root.appendChild(this.detailField(I18n.t("interventions.modal.links"), this.detailLinksList(item)));
    root.appendChild(this.detailField(I18n.t("interventions.col.createdBy"), this.textValue(this.auditText(item.created_by, item.created_date))));
    root.appendChild(this.detailField(I18n.t("interventions.detail.updatedBy"), this.textValue(this.auditText(item.updated_by, item.updated_date))));

    // « Modifier » : bascule vers la modale d'ÉDITION. openModal étant un overlay UNIQUE, l'ouvrir REMPLACE ce
    // détail (fermer-puis-ouvrir implicite) ; inutile de fermer d'abord.
    const actions = document.createElement("div"); actions.style.cssText = "margin-top:16px;display:flex;justify-content:flex-end;gap:8px";
    actions.appendChild(this.actionButton(I18n.t("interventions.rowAction.edit"), "", () => this.interventionModal(item, item.kind), "btn-primary"));
    root.appendChild(actions);

    this.host.openModal({ title: I18n.t("interventions.detail.title"), subtitle: Html.escape(item.title), body: root, hideFooter: true, wide: true });
  }

  /** Liste ÉLÉGANTE des objets liés (modale de détail) : icône de famille + libellé + badge de famille. Une
      cible existante est CLIQUABLE (ouvre sa fiche, retour-auto ici à la fermeture — aller-retour) ; une cible
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
        // Aller-retour mémorisé : ouvre la fiche de la cible ; à SA fermeture, on rouvre CE détail.
        link.onclick = (e) => { e.preventDefault(); this.targets.openTargetDetail(l.target_kind, l.target_id, () => this.detailModal(item)); };
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

  /** Ligne d'audit « auteur · date » (auteur seul si la date manque ; « — » si rien). */
  private auditText(who: string, dateIso: string): string {
    const author = who || "—";
    return dateIso ? author + " · " + Format.dateTime(dateIso) : author;
  }

  /* --------------------------------------------------------------------------
     Cellules & pagination
     -------------------------------------------------------------------------- */

  private plainTh(text: string): HTMLElement {
    const th = document.createElement("th"); th.textContent = text; return th;
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

  /** Icône de FAMILLE d'une cible liable (equipment/vm/spare) — repère visuel de la liste des objets liés. */
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
    return { page: 1, pageSize: PAGE_SIZE_DEFAULT, sort: "updated_date", dir: "desc", query: "", kinds: new Set(), statuses: new Set(), priorities: new Set() };
  }

  /** Paramètres de listing (query string) dérivés d'un état. Filtres vides = omis. */
  private static listParams(st: ListingState): InterventionsListParams {
    return {
      page: st.page, pageSize: st.pageSize, sort: st.sort, dir: st.dir,
      query: st.query || undefined,
      kinds: st.kinds.size ? [...st.kinds] : undefined,
      statuses: st.statuses.size ? [...st.statuses] : undefined,
      priorities: st.priorities.size ? [...st.priorities] : undefined,
    };
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
