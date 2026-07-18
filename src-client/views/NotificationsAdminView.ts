import type { Store } from "../store";
import { Icons } from "../ui/Icons";
import { Html } from "../core/Html";
import { Format } from "../core/Format";
import { NotifyFormat, DEFAULT_REMIND_HOURS, EVENT_TYPE_SUGGESTIONS } from "../core/NotifyFormat";
import { FormControls } from "../ui/FormControls";
import { Notify } from "../ui/Notify";
import { Dialog } from "../ui/Dialog";
import type { FormHost } from "./forms/shared";
import { I18n } from "../i18n/I18n";
import { NotifyError } from "./forms/NotifyClient";
import type {
  NotifyClient, NotifierInstanceItem, NotifierInstanceInput, SubscriptionItem, SubscriptionInput,
  NotifyStateItem, NotifyLogPage, EventSetting, NotifyTestResult,
} from "./forms/NotifyClient";

/* =============================================================================
   NotificationsAdminView — page d'administration « Notifications », sous-page du
   groupe « Paramètres » (kind:"secondary", parent:"parametres"). Administre le
   module serveur `notify/` (S3) : canaux, abonnements, rappels, alertes actives,
   historique et remises d'essai.

   Classe DÉDIÉE et AUTONOME (feature notifications AMOVIBLE, pattern VmClustersView) :
   la retirer = supprimer ce fichier + NotifyClient + le branchement de main.ts, sans
   cicatrice ailleurs. Elle NE dérive PAS de la chaîne `Forms` : elle réplique les
   quelques primitives DOM qu'elle utilise (pill/table/grille) avec les MÊMES classes
   CSS que les fiches, pour rester détachable. Les FORMULAIRES (canal, abonnement,
   rappel) s'ouvrent dans la MODALE de l'app (FormHost injecté — même UX que les
   autres créations/éditions : Forms.contact, VmProvidersForm), la page ne montre
   que les listes.

   MODE : le service est SANS OBJET hors mode API (pas de serveur à interroger). En mode
   fichier/viewer, `client` est null → la page affiche un message « nécessite le mode
   API/serveur » au lieu d'appeler le réseau (parité VmClustersView, masquée en fichier).

   RAFRAÎCHISSEMENT : boutons manuels (« Actualiser » global + pagination de l'historique) —
   pas de SSE pour cette page en v1. L'état vit côté serveur ; on tire à la demande.

   SÉCURITÉ : le JETON d'un canal n'apparaît JAMAIS après saisie (écriture seule, placeholder
   « inchangé si vide » en édition) ; 503 (clé DCMANAGER_SECRETS_KEY absente) → bandeau actionnable
   au lieu des contrôles (pattern VmProvidersForm.renderDisabled).
   ============================================================================= */

/** Onglet interne actif de la page (segmenté). L'ordre suit le cadrage (§ Contenu de la page). */
type AdminSection = "canaux" | "abonnements" | "rappels" | "alertes" | "historique";

export class NotificationsAdminView {
  /** Garde anti-rechargements concurrents (double-clic, navigation). */
  private loading = false;
  /** Onglet interne courant — préservé à travers les rebuilds (show()/refreshActive). */
  private active: AdminSection = "canaux";
  /** Décalage de pagination de l'historique (pas = LIMIT). */
  private logOffset = 0;

  /** Corps re-rendu en place selon l'onglet interne (listes ; les formulaires vivent en modale). */
  private content!: HTMLElement;
  /** Zone PERSISTANTE des résultats d'un test (survit aux changements d'onglet interne). */
  private resultBar!: HTMLElement;
  /** Boutons de la barre segmentée (pour refléter l'onglet actif). */
  private tabButtons = new Map<AdminSection, HTMLButtonElement>();

  /** Taille de page de l'historique (cadrage §5). */
  private static readonly LOG_LIMIT = 50;

  constructor(
    private readonly store: Store,
    private readonly container: HTMLElement,
    /** null = mode fichier/viewer (service sans objet) → message d'indisponibilité. */
    private readonly client: NotifyClient | null,
    /** Hôte de modale de l'app — les formulaires s'ouvrent dans LA modale standard (même UX que Forms.*). */
    private readonly host: FormHost,
  ) {}

  /** Activation de la sous-page (onShow) : (re)construit l'ossature puis charge l'onglet courant. */
  show(): void {
    if (!this.client) { this.renderNeedsApi(); return; }
    this.renderShell();
    this.selectSection(this.active);
  }

  /* --------------------------------------------------------------------------
     Ossature : barre segmentée + actions globales + zone de résultats + contenu
     -------------------------------------------------------------------------- */

  private renderShell(): void {
    this.container.innerHTML = "";
    this.tabButtons.clear();

    // -- Barre d'outils : onglets internes (gauche) + actions globales (droite). --
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-bottom:6px";

    // Onglets internes = CHOIX 1 parmi N (exclusif) → contrôle segmenté .rm-toggle (un seul
    // conteneur bordé, segment actif teinté), pas une rangée de boutons d'action. Cf. RouteMiniGraph.
    const seg = document.createElement("div"); seg.className = "rm-toggle";
    const tabs: Array<[AdminSection, string]> = [
      ["canaux", I18n.t("notify.admin.tabCanaux")], ["abonnements", I18n.t("notify.admin.tabAbonnements")], ["rappels", I18n.t("notify.admin.tabRappels")],
      ["alertes", I18n.t("notify.admin.tabAlertes")], ["historique", I18n.t("notify.admin.tabHistorique")],
    ];
    tabs.forEach(([key, label]) => {
      const b = document.createElement("button"); b.type = "button";   // nu : le style vient de .rm-toggle button
      b.textContent = label; b.onclick = () => this.selectSection(key);
      this.tabButtons.set(key, b); seg.appendChild(b);
    });

    const actions = document.createElement("div"); actions.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
    const refresh = document.createElement("button"); refresh.type = "button"; refresh.className = "btn btn-ghost btn-sm";
    refresh.textContent = I18n.t("notify.admin.refresh"); refresh.title = I18n.t("notify.admin.refreshTitle");
    refresh.onclick = () => this.loadActive();
    const testBtn = document.createElement("button"); testBtn.type = "button"; testBtn.className = "btn btn-primary btn-sm";
    testBtn.textContent = I18n.t("notify.admin.sendTest");
    testBtn.title = I18n.t("notify.admin.sendTestTitle");
    testBtn.onclick = () => void this.runRoutedTest(testBtn);
    actions.append(refresh, testBtn);

    bar.append(seg, actions);
    this.container.appendChild(bar);

    // -- Zone de résultats de test (persistante) + zone de contenu (par onglet). --
    this.resultBar = document.createElement("div"); this.resultBar.style.marginTop = "4px";
    this.content = document.createElement("div"); this.content.style.marginTop = "6px";
    this.container.append(this.resultBar, this.content);
  }

  /** Bascule d'onglet interne : surligne le bouton actif puis (re)charge son contenu. */
  private selectSection(section: AdminSection): void {
    this.active = section;
    // Entrer dans l'onglet Historique repart de la page la plus récente ; « Actualiser » (loadActive direct)
    // et la pagination préservent l'offset — d'où la remise à zéro ICI seulement (bascule d'onglet).
    if (section === "historique") this.logOffset = 0;
    this.tabButtons.forEach((btn, key) => {
      const on = key === section;
      btn.classList.toggle("on", on);   // segment actif du contrôle segmenté (.rm-toggle button.on)
    });
    this.loadActive();
  }

  /** (Re)charge le contenu de l'onglet interne courant. Ré-entrance gardée. */
  private loadActive(): void {
    if (this.loading || !this.client) return;
    switch (this.active) {
      case "canaux": void this.loadCanaux(); break;
      case "abonnements": void this.loadAbonnements(); break;
      case "rappels": void this.loadRappels(); break;
      case "alertes": void this.loadAlertes(); break;
      case "historique": void this.loadHistorique(); break;
    }
  }

  /* --------------------------------------------------------------------------
     1) CANAUX (instances) — CRUD, jeton en écriture seule
     -------------------------------------------------------------------------- */

  private async loadCanaux(): Promise<void> {
    this.message(I18n.t("notify.canaux.loading"));
    await this.guarded(async () => {
      const instances = await this.client!.listInstances();
      this.renderCanauxList(instances);
    });
  }

  private renderCanauxList(instances: NotifierInstanceItem[]): void {
    this.content.innerHTML = "";
    this.appendIntro(I18n.t("notify.canaux.intro"));

    if (!instances.length) {
      this.appendNote(I18n.t("notify.canaux.empty"));
    } else {
      const rows = instances.map((i) => [
        Html.escape(i.label),
        Html.escape(i.kind),
        i.url ? `<span style="font-family:var(--mono)">${Html.escape(i.url)}</span>` : NotificationsAdminView.MUTED,
        i.has_token ? Html.escape(I18n.t("notify.admin.yes")) : NotificationsAdminView.MUTED,
        i.enabled ? this.pill(I18n.t("notify.admin.active"), "ok") : this.pill(I18n.t("notify.admin.inactive"), "dim"),
        `<button class="btn btn-ghost btn-sm" data-edit="${Html.escape(i.id)}">${Html.escape(I18n.t("lists.chrome.rowEdit"))}</button>`
          + ` <button class="btn btn-ghost btn-sm" data-test="${Html.escape(i.id)}">${Html.escape(I18n.t("notify.canaux.test"))}</button>`
          + ` <button class="btn btn-ghost btn-sm" data-del="${Html.escape(i.id)}">${Html.escape(I18n.t("ui.action.delete"))}</button>`,
      ]);
      const tw = this.table([I18n.t("notify.canaux.colChannel"), I18n.t("lists.col.type"), I18n.t("notify.canaux.colEndpoint"), I18n.t("notify.canaux.colToken"), I18n.t("notify.admin.colState"), ""], rows);
      tw.querySelectorAll("[data-edit]").forEach((el) => (el as HTMLElement).onclick = () => {
        const inst = instances.find((i) => i.id === (el as HTMLElement).dataset.edit); if (inst) this.canalModal(inst);
      });
      tw.querySelectorAll("[data-test]").forEach((el) => (el as HTMLElement).onclick = () => {
        const inst = instances.find((i) => i.id === (el as HTMLElement).dataset.test); if (inst) void this.testDirect(inst);
      });
      tw.querySelectorAll("[data-del]").forEach((el) => (el as HTMLElement).onclick = () => {
        const inst = instances.find((i) => i.id === (el as HTMLElement).dataset.del); if (inst) void this.deleteCanal(inst);
      });
    }

    const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-primary btn-sm"; add.style.marginTop = "12px";
    add.textContent = I18n.t("notify.canaux.add"); add.onclick = () => this.canalModal(null);
    this.content.appendChild(add);
  }

  /** Création/édition d'un canal — dans la MODALE de l'app (même UX que les autres formulaires).
      La suppression reste une action de LISTE (bouton « Supprimer » de la ligne). */
  private canalModal(existing: NotifierInstanceItem | null): void {
    const editing = existing !== null;
    const root = document.createElement("div");

    const kindSel = FormControls.select([{ value: "console", label: I18n.t("notify.canaux.kindConsole") }, { value: "webhook", label: I18n.t("notify.canaux.kindWebhook") }], existing ? existing.kind : "webhook");
    root.appendChild(FormControls.fieldRow(I18n.t("notify.canaux.typeField"), kindSel, I18n.t("notify.canaux.typeHint")));

    const labelInput = FormControls.text(existing ? existing.label : "", I18n.t("notify.canaux.labelPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("notify.canaux.labelField"), labelInput, I18n.t("notify.canaux.labelHint")));

    const urlInput = FormControls.text(existing && existing.url ? existing.url : "", "https://webhook.exemple.lan/notify");
    const urlRow = FormControls.fieldRow(I18n.t("notify.canaux.endpointField"), urlInput, I18n.t("notify.canaux.endpointHint"));
    root.appendChild(urlRow);

    // Jeton : champ password JAMAIS pré-rempli. En édition, vide = conserver le jeton stocké.
    const tokenInput = FormControls.text("", editing ? I18n.t("notify.canaux.tokenPlaceholderEdit") : I18n.t("notify.canaux.tokenPlaceholderNew"));
    tokenInput.type = "password"; tokenInput.autocomplete = "new-password"; // empêche l'autofill du navigateur
    const tokenRow = FormControls.fieldRow(I18n.t("notify.canaux.tokenField"), tokenInput,
      editing ? I18n.t("notify.canaux.tokenHintEdit") : I18n.t("notify.canaux.tokenHintNew"));
    root.appendChild(tokenRow);

    // -- Modes d'ENVOI propres au webhook (masqués pour console). Le mode simplifié n'émet que
    //    { to, text } (passerelles SMS basiques) ; sinon payload complet, corps texte ou HTML. --
    const simpleToggle = FormControls.toggle(I18n.t("notify.canaux.simpleToggle"), existing ? existing.simple : false, () => syncWebhookOptions());
    const simpleField = document.createElement("div"); simpleField.className = "form-field";
    const simpleLabel = document.createElement("label"); simpleLabel.textContent = I18n.t("notify.canaux.formatLabel");
    const simpleHint = document.createElement("div"); simpleHint.className = "form-hint";
    simpleHint.textContent = I18n.t("notify.canaux.simpleHint");
    simpleField.append(simpleLabel, simpleToggle, simpleHint);
    root.appendChild(simpleField);

    const maxCharsInput = FormControls.number(existing ? existing.simple_max_chars : 300, { min: 20, max: 5000, step: 1, placeholder: "300" });
    const maxCharsRow = FormControls.fieldRow(I18n.t("notify.canaux.maxCharsField"), maxCharsInput, I18n.t("notify.canaux.maxCharsHint"));
    root.appendChild(maxCharsRow);

    const htmlToggle = FormControls.toggle(I18n.t("notify.canaux.htmlToggle"), existing ? existing.html : false, () => { /* état lu à l'envoi */ });
    const htmlField = document.createElement("div"); htmlField.className = "form-field";
    const htmlLabel = document.createElement("label"); htmlLabel.textContent = I18n.t("notify.canaux.htmlLabel");
    const htmlHint = document.createElement("div"); htmlHint.className = "form-hint";
    htmlHint.textContent = I18n.t("notify.canaux.htmlHint");
    htmlField.append(htmlLabel, htmlToggle, htmlHint);
    root.appendChild(htmlField);

    const enabledToggle = FormControls.toggle(I18n.t("notify.canaux.enabledToggle"), existing ? existing.enabled : true, () => { /* état lu à l'envoi */ });
    const enabledField = document.createElement("div"); enabledField.className = "form-field";
    const enabledLabel = document.createElement("label"); enabledLabel.textContent = I18n.t("notify.canaux.stateLabel"); enabledField.append(enabledLabel, enabledToggle);
    root.appendChild(enabledField);

    // Les champs endpoint/jeton n'ont de sens que pour un webhook (console = aucune configuration) ;
    // la longueur max. ne concerne que l'envoi simplifié, le HTML que l'envoi complet (exclusifs).
    const syncWebhookOptions = (): void => {
      const webhook = kindSel.value === "webhook";
      const simple = (simpleToggle as any).checked;
      simpleField.style.display = webhook ? "" : "none";
      maxCharsRow.style.display = (webhook && simple) ? "" : "none";
      htmlField.style.display = (webhook && !simple) ? "" : "none";
    };
    const syncKind = (): void => {
      const webhook = kindSel.value === "webhook";
      urlRow.style.display = webhook ? "" : "none"; tokenRow.style.display = webhook ? "" : "none";
      syncWebhookOptions();
    };
    kindSel.onchange = syncKind; syncKind();

    const errBox = this.errBox();
    root.appendChild(errBox);

    this.host.openModal({
      title: editing ? I18n.t("notify.canaux.modalEdit") : I18n.t("notify.canaux.modalNew"),
      subtitle: editing ? Html.escape(existing!.label) : "",
      body: root,
      onSave: async () => {
        errBox.style.display = "none";
        const kind = kindSel.value;
        const input: NotifierInstanceInput = { kind, label: labelInput.value.trim(), enabled: (enabledToggle as any).checked };
        input.url = kind === "webhook" ? (urlInput.value.trim() || null) : null;
        if (kind === "webhook") {
          // Réglages d'envoi ENVOYÉS pour un webhook (le serveur revalide les bornes et normalise
          // ce qui est sans objet). simple_max_chars : nombre repris tel quel, défaut si non saisi.
          input.simple = (simpleToggle as any).checked;
          const max = parseInt(maxCharsInput.value, 10);
          input.simple_max_chars = Number.isFinite(max) ? max : 300;
          input.html = (htmlToggle as any).checked;
        }
        const token = tokenInput.value; // n'est envoyé que s'il est (re)saisi (écriture seule)
        if (token.trim() !== "") input.token = token;
        if (input.label === "") { this.showError(errBox, new NotifyError(I18n.t("notify.canaux.labelRequired"), 0, null)); return false; }
        try {
          await this.client!.saveInstance(editing ? existing!.id : NotificationsAdminView.newId(), input);
          Notify.toast(editing ? I18n.t("notify.canaux.savedUpdated") : I18n.t("notify.canaux.savedCreated"), "ok");
          await this.loadCanaux();
          return true;
        } catch (e) { this.showError(errBox, e); return false; }   // modale OUVERTE tant que non enregistré
      },
    });
    setTimeout(() => labelInput.focus(), 30);
  }

  /** Test DIRECT d'un canal : demande une adresse puis POST /notify/test { instance_id, address }. */
  private async testDirect(instance: NotifierInstanceItem): Promise<void> {
    const address = await Dialog.prompt(I18n.t("notify.canaux.testAddressPrompt", { label: instance.label }), "");
    if (address === null || address.trim() === "") return;
    try {
      const res = await this.client!.testDirect(instance.id, address.trim());
      this.showTestResults(res, I18n.t("notify.canaux.testTitle", { label: instance.label }));
    } catch (e) { this.showTestError(e); }
  }

  private async deleteCanal(instance: NotifierInstanceItem): Promise<void> {
    const ok = await Dialog.confirm({
      title: I18n.t("notify.canaux.deleteTitle"),
      message: I18n.t("notify.canaux.deleteMessage", { label: instance.label }),
      confirmLabel: I18n.t("ui.action.delete"), danger: true,
    });
    if (!ok) return;
    try {
      await this.client!.deleteInstance(instance.id);
      Notify.toast(I18n.t("notify.canaux.deleted"), "ok");
      await this.loadCanaux();
    } catch (e) { this.showTestError(e); }
  }

  /* --------------------------------------------------------------------------
     2) ABONNEMENTS (routage par type d'événement)
     -------------------------------------------------------------------------- */

  private async loadAbonnements(): Promise<void> {
    this.message(I18n.t("notify.abonnements.loading"));
    await this.guarded(async () => {
      // Les instances servent au sélecteur de canal ET à la résolution du libellé de canal en table.
      const [subs, instances] = await Promise.all([this.client!.listSubscriptions(), this.client!.listInstances()]);
      this.renderAbonnementsList(subs, instances);
    });
  }

  private renderAbonnementsList(subs: SubscriptionItem[], instances: NotifierInstanceItem[]): void {
    this.content.innerHTML = "";
    this.appendIntro(I18n.t("notify.abonnements.intro"));
    const contacts = this.store.all("contacts") as Array<{ id: string; name?: string }>;

    if (!subs.length) {
      this.appendNote(I18n.t("notify.abonnements.empty"));
    } else {
      const rows = subs.map((s) => [
        `<span style="font-family:var(--mono)">${Html.escape(s.event_type)}</span>`,
        Html.escape(this.scopeLabel(s.doc_id)),
        Html.escape(NotifyFormat.contactLabel(contacts, s.contact_id)),
        Html.escape(s.channel),
        Html.escape(NotificationsAdminView.instanceLabel(instances, s.notifier_id)),
        s.enabled ? this.pill(I18n.t("notify.admin.active"), "ok") : this.pill(I18n.t("notify.admin.inactive"), "dim"),
        `<button class="btn btn-ghost btn-sm" data-edit="${Html.escape(s.id)}">${Html.escape(I18n.t("lists.chrome.rowEdit"))}</button>`
          + ` <button class="btn btn-ghost btn-sm" data-del="${Html.escape(s.id)}">${Html.escape(I18n.t("ui.action.delete"))}</button>`,
      ]);
      const tw = this.table([I18n.t("notify.admin.eventType"), I18n.t("notify.admin.colScope"), I18n.t("notify.admin.colContact"), I18n.t("notify.admin.colChannel"), I18n.t("notify.abonnements.colInstance"), I18n.t("notify.admin.colState"), ""], rows);
      tw.querySelectorAll("[data-edit]").forEach((el) => (el as HTMLElement).onclick = () => {
        const sub = subs.find((s) => s.id === (el as HTMLElement).dataset.edit); if (sub) this.abonnementModal(sub, instances);
      });
      tw.querySelectorAll("[data-del]").forEach((el) => (el as HTMLElement).onclick = () => {
        const sub = subs.find((s) => s.id === (el as HTMLElement).dataset.del); if (sub) void this.deleteAbonnement(sub);
      });
    }

    const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-primary btn-sm"; add.style.marginTop = "12px";
    add.textContent = I18n.t("notify.abonnements.add"); add.onclick = () => this.abonnementModal(null, instances);
    this.content.appendChild(add);
  }

  /** Création/édition d'un abonnement — dans la MODALE de l'app. Suppression = action de liste. */
  private abonnementModal(existing: SubscriptionItem | null, instances: NotifierInstanceItem[]): void {
    const editing = existing !== null;
    const root = document.createElement("div");

    // event_type : saisie libre + suggestions (datalist). « * » = tous les types.
    const eventInput = FormControls.text(existing ? existing.event_type : "", I18n.t("notify.abonnements.eventPlaceholder"));
    const listId = "notify-event-types";
    root.appendChild(FormControls.attachDatalist(eventInput, listId, EVENT_TYPE_SUGGESTIONS.slice()));
    root.appendChild(FormControls.fieldRow(I18n.t("notify.admin.eventType"), eventInput, I18n.t("notify.abonnements.eventHint")));

    // Portée : document courant OU global (tous documents). Sans document ouvert, seul le global est proposé.
    const docId = this.client!.docId;
    const scopeOpts = docId ? [{ value: "doc", label: I18n.t("notify.abonnements.scopeDoc") }, { value: "global", label: I18n.t("notify.abonnements.scopeGlobal") }] : [{ value: "global", label: I18n.t("notify.abonnements.scopeGlobal") }];
    const defaultScope = editing ? (existing!.doc_id ? "doc" : "global") : (docId ? "doc" : "global");
    const scopeSel = FormControls.select(scopeOpts, defaultScope);
    root.appendChild(FormControls.fieldRow(I18n.t("notify.abonnements.scopeField"), scopeSel, docId ? I18n.t("notify.abonnements.scopeHintDoc") : I18n.t("notify.abonnements.scopeHintNoDoc")));

    // Contact : carnet du DOCUMENT COURANT (référence souple contact_id).
    const contacts = this.store.all("contacts") as Array<{ id: string; name?: string }>;
    const contactOpts = [{ value: "", label: I18n.t("notify.abonnements.contactChoose") }].concat(
      contacts.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")).map((c) => ({ value: c.id, label: c.name || I18n.t("lists.ph.noName") })));
    const contactSel = FormControls.select(contactOpts, existing ? existing.contact_id : "");
    // Un contact d'un AUTRE document (édition d'un abonnement global) n'est pas dans la liste : on l'ajoute pour ne pas le perdre.
    if (existing && existing.contact_id && !contacts.some((c) => c.id === existing.contact_id)) {
      const opt = document.createElement("option"); opt.value = existing.contact_id; opt.textContent = I18n.t("notify.abonnements.contactOther"); contactSel.appendChild(opt); contactSel.value = existing.contact_id;
    }
    root.appendChild(FormControls.fieldRow(I18n.t("notify.admin.colContact"), contactSel, I18n.t("notify.abonnements.contactHint")));
    if (!contacts.length) this.appendNote(I18n.t("notify.abonnements.noContact"), root);

    const channelSel = FormControls.select([{ value: "email", label: I18n.t("notify.abonnements.chanEmail") }, { value: "sms", label: I18n.t("notify.abonnements.chanSms") }], existing ? existing.channel : "email");
    root.appendChild(FormControls.fieldRow(I18n.t("notify.abonnements.channelField"), channelSel, I18n.t("notify.abonnements.channelHint")));

    const notifierOpts = [{ value: "", label: I18n.t("notify.abonnements.notifierChoose") }].concat(instances.map((i) => ({ value: i.id, label: i.enabled ? i.label : I18n.t("notify.abonnements.channelInactive", { label: i.label }) })));
    const notifierSel = FormControls.select(notifierOpts, existing ? existing.notifier_id : "");
    root.appendChild(FormControls.fieldRow(I18n.t("notify.abonnements.notifierField"), notifierSel, I18n.t("notify.abonnements.notifierHint")));
    if (!instances.length) this.appendNote(I18n.t("notify.abonnements.noChannel"), root);

    const enabledToggle = FormControls.toggle(I18n.t("notify.abonnements.enabledToggle"), existing ? existing.enabled : true, () => { /* état lu à l'envoi */ });
    const enabledField = document.createElement("div"); enabledField.className = "form-field";
    const enabledLabel = document.createElement("label"); enabledLabel.textContent = I18n.t("notify.abonnements.stateLabel"); enabledField.append(enabledLabel, enabledToggle);
    root.appendChild(enabledField);

    const errBox = this.errBox();
    root.appendChild(errBox);

    this.host.openModal({
      title: editing ? I18n.t("notify.abonnements.modalEdit") : I18n.t("notify.abonnements.modalNew"),
      subtitle: editing ? Html.escape(existing!.event_type) : "",
      body: root,
      onSave: async () => {
        errBox.style.display = "none";
        const input: SubscriptionInput = {
          doc_id: scopeSel.value === "doc" ? docId : null,
          event_type: eventInput.value.trim(),
          contact_id: contactSel.value,
          channel: channelSel.value,
          notifier_id: notifierSel.value,
          enabled: (enabledToggle as any).checked,
        };
        // Garde-fous d'UI (le serveur revalide et renvoie les griefs 400 le cas échéant).
        if (input.event_type === "") { this.showError(errBox, new NotifyError(I18n.t("notify.abonnements.eventRequired"), 0, null)); return false; }
        if (input.contact_id === "") { this.showError(errBox, new NotifyError(I18n.t("notify.abonnements.contactRequired"), 0, null)); return false; }
        if (input.notifier_id === "") { this.showError(errBox, new NotifyError(I18n.t("notify.abonnements.notifierRequired"), 0, null)); return false; }
        try {
          await this.client!.saveSubscription(editing ? existing!.id : NotificationsAdminView.newId(), input);
          Notify.toast(editing ? I18n.t("notify.abonnements.savedUpdated") : I18n.t("notify.abonnements.savedCreated"), "ok");
          await this.loadAbonnements();
          return true;
        } catch (e) { this.showError(errBox, e); return false; }   // modale OUVERTE tant que non enregistré
      },
    });
    setTimeout(() => eventInput.focus(), 30);
  }

  private async deleteAbonnement(sub: SubscriptionItem): Promise<void> {
    const ok = await Dialog.confirm({ title: I18n.t("notify.abonnements.deleteTitle"), message: I18n.t("notify.abonnements.deleteMessage", { type: sub.event_type }), confirmLabel: I18n.t("ui.action.delete"), danger: true });
    if (!ok) return;
    try { await this.client!.deleteSubscription(sub.id); Notify.toast(I18n.t("notify.abonnements.deleted"), "ok"); await this.loadAbonnements(); }
    catch (e) { this.showTestError(e); }
  }

  /* --------------------------------------------------------------------------
     3) RAPPELS (intervalle de rappel PAR TYPE — décision Q2)
     -------------------------------------------------------------------------- */

  private async loadRappels(): Promise<void> {
    this.message(I18n.t("notify.rappels.loading"));
    await this.guarded(async () => {
      const settings = await this.client!.listSettings();
      this.renderRappelsList(settings);
    });
  }

  private renderRappelsList(settings: EventSetting[]): void {
    this.content.innerHTML = "";
    this.appendIntro(I18n.t("notify.rappels.intro", { hours: DEFAULT_REMIND_HOURS }));

    if (!settings.length) {
      this.appendNote(I18n.t("notify.rappels.empty", { hours: DEFAULT_REMIND_HOURS }));
    } else {
      const rows = settings.map((s) => [
        `<span style="font-family:var(--mono)">${Html.escape(s.event_type)}</span>`,
        Html.escape(NotifyFormat.intervalLabel(s.remind_interval_sec)),
        `<button class="btn btn-ghost btn-sm" data-edit="${Html.escape(s.event_type)}">${Html.escape(I18n.t("lists.chrome.rowEdit"))}</button>`
          + ` <button class="btn btn-ghost btn-sm" data-del="${Html.escape(s.event_type)}">${Html.escape(I18n.t("notify.rappels.reset"))}</button>`,
      ]);
      const tw = this.table([I18n.t("notify.admin.eventType"), I18n.t("notify.rappels.colInterval"), ""], rows);
      tw.querySelectorAll("[data-edit]").forEach((el) => (el as HTMLElement).onclick = () => {
        const set = settings.find((s) => s.event_type === (el as HTMLElement).dataset.edit); if (set) this.rappelModal(set);
      });
      tw.querySelectorAll("[data-del]").forEach((el) => (el as HTMLElement).onclick = () => {
        const set = settings.find((s) => s.event_type === (el as HTMLElement).dataset.del); if (set) void this.deleteRappel(set);
      });
    }

    const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-primary btn-sm"; add.style.marginTop = "12px";
    add.textContent = I18n.t("notify.rappels.add"); add.onclick = () => this.rappelModal(null);
    this.content.appendChild(add);
  }

  /** Création/édition d'un réglage de rappel — dans la MODALE de l'app. Réinitialisation = action de liste. */
  private rappelModal(existing: EventSetting | null): void {
    const editing = existing !== null;
    const root = document.createElement("div");

    const eventInput = FormControls.text(existing ? existing.event_type : "", I18n.t("notify.rappels.eventPlaceholder"));
    if (editing) { eventInput.readOnly = true; eventInput.style.opacity = "0.7"; }
    else { const listId = "notify-event-types-rappel"; root.appendChild(FormControls.attachDatalist(eventInput, listId, EVENT_TYPE_SUGGESTIONS.slice())); }
    root.appendChild(FormControls.fieldRow(I18n.t("notify.admin.eventType"), eventInput, editing ? I18n.t("notify.rappels.eventHintEdit") : I18n.t("notify.rappels.eventHintNew")));

    const hoursDefault = editing ? NotifyFormat.secToHours(existing!.remind_interval_sec) : DEFAULT_REMIND_HOURS;
    const hoursInput = FormControls.number(hoursDefault, { min: 0.02, step: 0.5, placeholder: String(DEFAULT_REMIND_HOURS) });
    root.appendChild(FormControls.fieldRow(I18n.t("notify.rappels.hoursField"), hoursInput, I18n.t("notify.rappels.hoursHint")));

    const errBox = this.errBox();
    root.appendChild(errBox);

    this.host.openModal({
      title: editing ? I18n.t("notify.rappels.modalEdit", { type: existing!.event_type }) : I18n.t("notify.rappels.modalNew"),
      body: root,
      onSave: async () => {
        errBox.style.display = "none";
        const eventType = eventInput.value.trim();
        if (eventType === "") { this.showError(errBox, new NotifyError(I18n.t("notify.rappels.eventRequired"), 0, null)); return false; }
        const sec = NotifyFormat.hoursToSec(Number(hoursInput.value));
        if (!NotifyFormat.isValidRemindSec(sec)) { this.showError(errBox, new NotifyError(I18n.t("notify.rappels.tooShort"), 0, null)); return false; }
        try {
          await this.client!.saveSetting({ event_type: eventType, remind_interval_sec: sec });
          Notify.toast(I18n.t("notify.rappels.saved"), "ok");
          await this.loadRappels();
          return true;
        } catch (e) { this.showError(errBox, e); return false; }   // modale OUVERTE tant que non enregistré
      },
    });
    setTimeout(() => { if (!editing) eventInput.focus(); else hoursInput.focus(); }, 30);
  }

  private async deleteRappel(setting: EventSetting): Promise<void> {
    const ok = await Dialog.confirm({ title: I18n.t("notify.rappels.deleteTitle"), message: I18n.t("notify.rappels.deleteMessage", { type: setting.event_type, hours: DEFAULT_REMIND_HOURS }), confirmLabel: I18n.t("notify.rappels.reset") });
    if (!ok) return;
    try { await this.client!.deleteSetting(setting.event_type); Notify.toast(I18n.t("notify.rappels.deleted", { hours: DEFAULT_REMIND_HOURS }), "ok"); await this.loadRappels(); }
    catch (e) { this.showTestError(e); }
  }

  /* --------------------------------------------------------------------------
     4) ALERTES ACTIVES (états — lecture seule, pas de resolve manuel en v1)
     -------------------------------------------------------------------------- */

  private async loadAlertes(): Promise<void> {
    this.message(I18n.t("notify.alertes.loading"));
    await this.guarded(async () => {
      const states = await this.client!.listStates();
      this.renderAlertes(states);
    });
  }

  private renderAlertes(states: NotifyStateItem[]): void {
    this.content.innerHTML = "";
    this.appendIntro(I18n.t("notify.alertes.intro"));

    if (!states.length) { this.appendNote(I18n.t("notify.alertes.empty")); return; }
    const rows = states.map((s) => [
      this.severityPill(s.severity),
      `<span style="font-family:var(--mono)">${Html.escape(s.event_type)}</span>`,
      Html.escape(s.title || "—"),
      Html.escape(this.scopeLabel(s.doc_id)),
      Html.escape(Format.dateTime(s.first_seen)),
      Html.escape(s.last_sent ? Format.dateTime(s.last_sent) : "—"),
      Html.escape(s.next_remind_at ? Format.dateTime(s.next_remind_at) : "—"),
      s.last_error ? `<span style="color:var(--err)">${Html.escape(s.last_error)}</span>` : NotificationsAdminView.MUTED,
    ]);
    this.table([I18n.t("notify.alertes.colSeverity"), I18n.t("lists.col.type"), I18n.t("notify.alertes.colTitle"), I18n.t("notify.admin.colScope"), I18n.t("notify.alertes.colFirstSeen"), I18n.t("notify.alertes.colLastSent"), I18n.t("notify.alertes.colNextRemind"), I18n.t("notify.alertes.colLastError")], rows);
  }

  /* --------------------------------------------------------------------------
     5) HISTORIQUE (journal des remises — paginé)
     -------------------------------------------------------------------------- */

  private async loadHistorique(): Promise<void> {
    this.message(I18n.t("notify.historique.loading"));
    await this.guarded(async () => {
      const page = await this.client!.listLog({ limit: NotificationsAdminView.LOG_LIMIT, offset: this.logOffset });
      this.renderHistorique(page);
    });
  }

  private renderHistorique(page: NotifyLogPage): void {
    this.content.innerHTML = "";
    this.appendIntro(I18n.t("notify.historique.intro"));
    const contacts = this.store.all("contacts") as Array<{ id: string; name?: string }>;

    if (!page.entries.length && this.logOffset === 0) { this.appendNote(I18n.t("notify.historique.empty")); return; }
    const rows = page.entries.map((e) => [
      Html.escape(Format.dateTime(e.sent_at)),
      Html.escape(e.phase || "—"),
      `<span style="font-family:var(--mono)">${Html.escape(e.event_type)}</span>`,
      Html.escape(NotifyFormat.contactLabel(contacts, e.contact_id)),
      Html.escape(e.channel || "—"),
      e.ok ? this.pill(I18n.t("notify.historique.resultOk"), "ok") : this.pill(I18n.t("notify.historique.resultFail"), "err"),
      e.detail ? `<span style="color:var(--err)">${Html.escape(e.detail)}</span>` : NotificationsAdminView.MUTED,
    ]);
    this.table([I18n.t("notify.historique.colDate"), I18n.t("notify.historique.colPhase"), I18n.t("lists.col.type"), I18n.t("notify.admin.colContact"), I18n.t("notify.admin.colChannel"), I18n.t("notify.admin.colResult"), I18n.t("notify.admin.colDetail")], rows);

    // -- Pagination (précédent / suivant) : bornée par le total renvoyé par le serveur. --
    const nav = document.createElement("div"); nav.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:12px";
    const from = page.total === 0 ? 0 : this.logOffset + 1;
    const to = Math.min(this.logOffset + page.entries.length, page.total);
    const prev = document.createElement("button"); prev.type = "button"; prev.className = "btn btn-ghost btn-sm"; prev.textContent = I18n.t("notify.admin.prev");
    prev.disabled = this.logOffset <= 0;
    prev.onclick = () => { this.logOffset = Math.max(0, this.logOffset - NotificationsAdminView.LOG_LIMIT); void this.loadHistorique(); };
    const next = document.createElement("button"); next.type = "button"; next.className = "btn btn-ghost btn-sm"; next.textContent = I18n.t("notify.admin.next");
    next.disabled = this.logOffset + page.entries.length >= page.total;
    next.onclick = () => { this.logOffset += NotificationsAdminView.LOG_LIMIT; void this.loadHistorique(); };
    const info = document.createElement("span"); info.className = "form-hint"; info.textContent = from + "–" + to + " / " + page.total;
    nav.append(prev, next, info);
    this.content.appendChild(nav);
  }

  /* --------------------------------------------------------------------------
     6) TEST ROUTÉ (bouton global) + affichage des résultats
     -------------------------------------------------------------------------- */

  private async runRoutedTest(btn: HTMLButtonElement): Promise<void> {
    if (!this.client) return;
    btn.disabled = true; const prev = btn.textContent; btn.textContent = I18n.t("notify.test.sending");
    try {
      const res = await this.client.testRouted(this.client.docId);
      this.showTestResults(res, I18n.t("notify.test.routedTitle"));
    } catch (e) { this.showTestError(e); }
    finally { btn.disabled = false; btn.textContent = prev; }
  }

  /** Rend les résultats d'un test dans la zone persistante : une ligne par destinataire + `hint` éventuel. */
  private showTestResults(res: NotifyTestResult, title: string): void {
    this.resultBar.innerHTML = "";
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid var(--line);border-radius:6px;padding:12px;background:var(--bg-2)";
    const head = document.createElement("div"); head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px";
    const t = document.createElement("div"); t.style.cssText = "font-weight:600;color:var(--fg)"; t.textContent = title;
    const close = document.createElement("button"); close.type = "button"; close.className = "btn btn-ghost btn-sm"; close.innerHTML = Icons.CLOSE; close.title = I18n.t("notify.test.hide");
    close.onclick = () => { this.resultBar.innerHTML = ""; };
    head.append(t, close); box.appendChild(head);

    if (!res.results.length) {
      const hint = document.createElement("div"); hint.className = "form-hint"; hint.style.marginTop = "6px";
      hint.textContent = res.hint || I18n.t("notify.test.noRecipient");
      box.appendChild(hint);
    } else {
      const rows = res.results.map((r) => [
        r.ok ? this.pill(I18n.t("notify.test.delivered"), "ok") : this.pill(I18n.t("notify.test.failed"), "err"),
        Html.escape(r.address || "—"),
        r.detail ? `<span style="color:var(--err)">${Html.escape(r.detail)}</span>` : NotificationsAdminView.MUTED,
      ]);
      box.appendChild(this.buildTable([I18n.t("notify.admin.colResult"), I18n.t("notify.test.colAddress"), I18n.t("notify.admin.colDetail")], rows));
    }
    this.resultBar.appendChild(box);
  }

  /** Erreur d'un test / d'une action ponctuelle → toast (pas de zone d'erreur de formulaire ici). */
  private showTestError(e: unknown): void {
    if (e instanceof NotifyError && e.status === 503) { this.renderDisabled(e); return; }
    Notify.toast(NotificationsAdminView.errText(e), "err");
  }

  /* --------------------------------------------------------------------------
     Garde 503 + messages d'indisponibilité
     -------------------------------------------------------------------------- */

  /** Exécute un chargement en traduisant 503 (clé absente / module en erreur) en BANDEAU actionnable
      (pattern VmProvidersForm.renderDisabled) et toute autre erreur en message plein contenu. */
  private async guarded(load: () => Promise<void>): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try { await load(); }
    catch (e) {
      if (e instanceof NotifyError && e.status === 503) { this.renderDisabled(e); return; }
      this.message(I18n.t("notify.admin.loadError", { detail: NotificationsAdminView.errText(e) }), true);
    } finally { this.loading = false; }
  }

  /** 503 : service indisponible côté serveur (clé DCMANAGER_SECRETS_KEY absente, ou module en erreur) →
      on montre le détail actionnable AU LIEU des contrôles (rien à administrer sans le service). */
  private renderDisabled(err: NotifyError): void {
    this.content.innerHTML = "";
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid var(--warn);border-radius:6px;padding:14px;background:var(--bg-2)";
    const title = document.createElement("div"); title.style.cssText = "font-weight:600;color:var(--warn);margin-bottom:6px";
    title.textContent = err.message || I18n.t("notify.admin.disabledTitle");
    const detail = document.createElement("div"); detail.className = "form-hint"; detail.style.whiteSpace = "pre-line";
    detail.textContent = err.detail || I18n.t("notify.admin.disabled");
    box.append(title, detail); this.content.appendChild(box);
  }

  /** Mode fichier/viewer : le service n'a pas d'objet (pas de serveur) → message clair, aucun appel réseau. */
  private renderNeedsApi(): void {
    this.container.innerHTML = "";
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid var(--line);border-radius:6px;padding:16px;background:var(--bg-2)";
    const title = document.createElement("div"); title.style.cssText = "font-weight:600;color:var(--fg);margin-bottom:6px";
    title.textContent = I18n.t("notify.admin.needsApiTitle");
    const detail = document.createElement("div"); detail.className = "form-hint";
    detail.textContent = I18n.t("notify.admin.needsApi");
    box.append(title, detail); this.container.appendChild(box);
  }

  /* --------------------------------------------------------------------------
     Résolutions / libellés
     -------------------------------------------------------------------------- */

  /** Portée d'un abonnement / d'un état : null → « tous » ; document courant → « ce document » ;
      autre document → forme compacte de l'id (l'admin voit toutes les portées, sans induire en erreur). */
  private scopeLabel(docId: string | null): string {
    if (!docId) return I18n.t("notify.admin.scopeAll");
    if (this.client && docId === this.client.docId) return I18n.t("notify.admin.scopeThis");
    return I18n.t("notify.admin.scopeOther", { id: docId.slice(0, 8) });
  }

  /** Libellé d'un canal depuis la liste des instances — garde-fou si l'instance a disparu. */
  private static instanceLabel(instances: NotifierInstanceItem[], notifierId: string): string {
    const found = instances.find((i) => i.id === notifierId);
    return found ? found.label : I18n.t("notify.admin.channelNotFound");
  }

  /* --------------------------------------------------------------------------
     Primitives DOM (répliquées pour rester AUTONOME — mêmes classes CSS que les fiches)
     -------------------------------------------------------------------------- */

  private static readonly MUTED = `<span style="color:var(--fg-dimmer)">—</span>`;

  /** Identifiant neuf pour une création (PUT idempotent par id côté serveur). */
  private static newId(): string {
    try { if (typeof crypto !== "undefined" && (crypto as any).randomUUID) return (crypto as any).randomUUID(); } catch (_) { /* fallback ci-dessous */ }
    return "n-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  /** Pastille sémantique (mêmes couleurs que VmClustersView/VmForms). */
  private pill(text: string, kind: "ok" | "err" | "warn" | "dim" | "neutral"): string {
    const style = kind === "ok" ? ` style="border-color:var(--ok);color:var(--ok)"`
      : kind === "err" ? ` style="border-color:var(--err);color:var(--err)"`
      : kind === "warn" ? ` style="border-color:var(--warn);color:var(--warn)"`
      : kind === "dim" ? ` style="border-color:var(--fg-dimmer);color:var(--fg-dim)"`
      : "";
    return `<span class="pill"${style}>${Html.escape(text)}</span>`;
  }

  /** Pastille de gravité (error → rouge, warning → orange, info → neutre). */
  private severityPill(severity: string): string {
    if (severity === "error") return this.pill(I18n.t("notify.admin.sevError"), "err");
    if (severity === "warning") return this.pill(I18n.t("notify.admin.sevWarning"), "warn");
    return this.pill(severity || I18n.t("notify.admin.sevInfo"), "neutral");
  }

  /** Table compacte injectée DANS le contenu (cellules = HTML déjà échappé). Renvoie le conteneur (liaison d'événements). */
  private table(headers: string[], rows: string[][]): HTMLElement {
    const tw = this.buildTable(headers, rows);
    this.content.appendChild(tw);
    return tw;
  }

  /** Construit une table compacte (sans l'insérer) — mutualisée entre le contenu et la zone de résultats. */
  private buildTable(headers: string[], rows: string[][]): HTMLElement {
    const tw = document.createElement("div"); tw.className = "table-wrap"; tw.style.marginTop = "10px";
    const head = headers.map((h) => `<th>${Html.escape(h)}</th>`).join("");
    const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
    tw.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    return tw;
  }

  /** Intro de section (form-hint). */
  private appendIntro(text: string): void {
    const n = document.createElement("div"); n.className = "form-hint"; n.textContent = text; this.content.appendChild(n);
  }

  /** Note libre (form-hint, italique) — dans le contenu de l'onglet, ou dans un corps de modale (`parent`). */
  private appendNote(text: string, parent: HTMLElement = this.content): void {
    const n = document.createElement("div"); n.className = "form-hint"; n.style.cssText = "margin-top:10px;font-style:italic"; n.textContent = text; parent.appendChild(n);
  }

  /** Zone d'erreur de formulaire (messages français du serveur), masquée par défaut. */
  private errBox(): HTMLElement {
    const e = document.createElement("div"); e.className = "form-hint err"; e.style.cssText = "margin-top:10px;white-space:pre-line;display:none";
    return e;
  }

  /** Affiche une erreur dans la zone d'erreur d'un formulaire. 503 (service coupé) : plus rien à
      éditer — on FERME la modale et on affiche le bandeau actionnable à la place du contenu. */
  private showError(errBox: HTMLElement, e: unknown): void {
    if (e instanceof NotifyError && e.status === 503) { this.host.closeModal?.(); this.renderDisabled(e); return; }
    errBox.style.display = "block"; errBox.textContent = NotificationsAdminView.errText(e);
  }

  /** Message plein contenu (chargement / erreur) — remplace le contenu de l'onglet. */
  private message(text: string, isError = false): void {
    this.content.innerHTML = "";
    const n = document.createElement("div"); n.className = isError ? "form-hint err" : "form-hint"; n.textContent = text; this.content.appendChild(n);
  }

  /** Message d'erreur lisible : `NotifyError` porte code HTTP + `detail` (issues 400 / config 503). */
  private static errText(e: unknown): string {
    if (e instanceof NotifyError) return e.message + (e.detail ? "\n" + e.detail : "");
    return e instanceof Error ? e.message : String(e);
  }
}
