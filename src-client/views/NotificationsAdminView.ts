import type { Store } from "../store";
import { Icons } from "../ui/Icons";
import { Html } from "../core/Html";
import { Format } from "../core/Format";
import { NotifyFormat, DEFAULT_REMIND_HOURS, EVENT_TYPE_SUGGESTIONS } from "../core/NotifyFormat";
import { FormControls } from "../ui/FormControls";
import { Notify } from "../ui/Notify";
import { Dialog } from "../ui/Dialog";
import type { FormHost } from "./forms/shared";
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
      ["canaux", "Canaux"], ["abonnements", "Abonnements"], ["rappels", "Rappels"],
      ["alertes", "Alertes actives"], ["historique", "Historique"],
    ];
    tabs.forEach(([key, label]) => {
      const b = document.createElement("button"); b.type = "button";   // nu : le style vient de .rm-toggle button
      b.textContent = label; b.onclick = () => this.selectSection(key);
      this.tabButtons.set(key, b); seg.appendChild(b);
    });

    const actions = document.createElement("div"); actions.style.cssText = "display:flex;flex-wrap:wrap;gap:8px";
    const refresh = document.createElement("button"); refresh.type = "button"; refresh.className = "btn btn-ghost btn-sm";
    refresh.textContent = "Actualiser"; refresh.title = "Recharger l'onglet courant";
    refresh.onclick = () => this.loadActive();
    const testBtn = document.createElement("button"); testBtn.type = "button"; testBtn.className = "btn btn-primary btn-sm";
    testBtn.textContent = "Envoyer une notification de test";
    testBtn.title = "Déroule les abonnements « test »/« * » du document courant et remet un message d'essai";
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
    this.message("Chargement des canaux…");
    await this.guarded(async () => {
      const instances = await this.client!.listInstances();
      this.renderCanauxList(instances);
    });
  }

  private renderCanauxList(instances: NotifierInstanceItem[]): void {
    this.content.innerHTML = "";
    this.appendIntro("Canaux d'envoi configurés (console de diagnostic, webhook HTTP). Les jetons d'authentification sont chiffrés côté serveur et ne sont jamais réaffichés.");

    if (!instances.length) {
      this.appendNote("Aucun canal configuré. Ajoutez-en un pour recevoir des notifications (un webhook vers votre passerelle e-mail/SMS, ou la console de diagnostic du serveur).");
    } else {
      const rows = instances.map((i) => [
        Html.escape(i.label),
        Html.escape(i.kind),
        i.url ? `<span style="font-family:var(--mono)">${Html.escape(i.url)}</span>` : NotificationsAdminView.MUTED,
        i.has_token ? "Oui" : NotificationsAdminView.MUTED,
        i.enabled ? this.pill("actif", "ok") : this.pill("inactif", "dim"),
        `<button class="btn btn-ghost btn-sm" data-edit="${Html.escape(i.id)}">Modifier</button>`
          + ` <button class="btn btn-ghost btn-sm" data-test="${Html.escape(i.id)}">Tester</button>`
          + ` <button class="btn btn-ghost btn-sm" data-del="${Html.escape(i.id)}">Supprimer</button>`,
      ]);
      const tw = this.table(["Canal", "Type", "Endpoint", "Jeton", "État", ""], rows);
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
    add.textContent = "+ Ajouter un canal"; add.onclick = () => this.canalModal(null);
    this.content.appendChild(add);
  }

  /** Création/édition d'un canal — dans la MODALE de l'app (même UX que les autres formulaires).
      La suppression reste une action de LISTE (bouton « Supprimer » de la ligne). */
  private canalModal(existing: NotifierInstanceItem | null): void {
    const editing = existing !== null;
    const root = document.createElement("div");

    const kindSel = FormControls.select([{ value: "console", label: "Console (diagnostic serveur)" }, { value: "webhook", label: "Webhook (HTTP POST JSON)" }], existing ? existing.kind : "webhook");
    root.appendChild(FormControls.fieldRow("Type de canal", kindSel, "Console : écrit dans les logs du serveur (test/diagnostic). Webhook : POST JSON vers votre passerelle (e-mail/SMS…)."));

    const labelInput = FormControls.text(existing ? existing.label : "", "ex. Passerelle e-mail");
    root.appendChild(FormControls.fieldRow("Libellé", labelInput, "Nom lisible du canal (affiché dans les listes)."));

    const urlInput = FormControls.text(existing && existing.url ? existing.url : "", "https://webhook.exemple.lan/notify");
    const urlRow = FormControls.fieldRow("Endpoint (URL du webhook)", urlInput, "URL appelée en HTTP POST (JSON). http(s) accepté (services internes).");
    root.appendChild(urlRow);

    // Jeton : champ password JAMAIS pré-rempli. En édition, vide = conserver le jeton stocké.
    const tokenInput = FormControls.text("", editing ? "inchangé si vide" : "jeton d'authentification (optionnel)");
    tokenInput.type = "password"; tokenInput.autocomplete = "new-password"; // empêche l'autofill du navigateur
    const tokenRow = FormControls.fieldRow("Jeton d'authentification", tokenInput,
      editing ? "Laissez vide pour conserver le jeton actuel. Le jeton n'est jamais réaffiché."
        : "Envoyé en en-tête d'authentification du webhook. Optionnel (selon votre passerelle).");
    root.appendChild(tokenRow);

    // -- Modes d'ENVOI propres au webhook (masqués pour console). Le mode simplifié n'émet que
    //    { to, text } (passerelles SMS basiques) ; sinon payload complet, corps texte ou HTML. --
    const simpleToggle = FormControls.toggle("Envoi simplifié ({to, text})", existing ? existing.simple : false, () => syncWebhookOptions());
    const simpleField = document.createElement("div"); simpleField.className = "form-field";
    const simpleLabel = document.createElement("label"); simpleLabel.textContent = "Format d'envoi";
    const simpleHint = document.createElement("div"); simpleHint.className = "form-hint";
    simpleHint.textContent = "Payload minimal { to, text } (deux clés), pour les passerelles SMS simples. Sinon payload complet { to, subject, body, severity, event_type, format }.";
    simpleField.append(simpleLabel, simpleToggle, simpleHint);
    root.appendChild(simpleField);

    const maxCharsInput = FormControls.number(existing ? existing.simple_max_chars : 300, { min: 20, max: 5000, step: 1, placeholder: "300" });
    const maxCharsRow = FormControls.fieldRow("Longueur max. du texte (caractères)", maxCharsInput, "Le texte compact est tronqué à cette longueur (ellipse « … » comprise). Entre 20 et 5000 ; défaut 300 (taille d'un SMS).");
    root.appendChild(maxCharsRow);

    const htmlToggle = FormControls.toggle("Corps au format HTML", existing ? existing.html : false, () => { /* état lu à l'envoi */ });
    const htmlField = document.createElement("div"); htmlField.className = "form-field";
    const htmlLabel = document.createElement("label"); htmlLabel.textContent = "Mise en forme du corps";
    const htmlHint = document.createElement("div"); htmlHint.className = "form-hint";
    htmlHint.textContent = "Corps mis en forme en HTML (paragraphes, retours à la ligne). Sinon texte brut (les retours à la ligne sont le seul formatage).";
    htmlField.append(htmlLabel, htmlToggle, htmlHint);
    root.appendChild(htmlField);

    const enabledToggle = FormControls.toggle("Canal actif", existing ? existing.enabled : true, () => { /* état lu à l'envoi */ });
    const enabledField = document.createElement("div"); enabledField.className = "form-field";
    const enabledLabel = document.createElement("label"); enabledLabel.textContent = "État"; enabledField.append(enabledLabel, enabledToggle);
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
      title: editing ? "Modifier le canal" : "Nouveau canal",
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
        if (input.label === "") { this.showError(errBox, new NotifyError("Libellé requis", 0, null)); return false; }
        try {
          await this.client!.saveInstance(editing ? existing!.id : NotificationsAdminView.newId(), input);
          Notify.toast(editing ? "Canal mis à jour" : "Canal créé", "ok");
          await this.loadCanaux();
          return true;
        } catch (e) { this.showError(errBox, e); return false; }   // modale OUVERTE tant que non enregistré
      },
    });
    setTimeout(() => labelInput.focus(), 30);
  }

  /** Test DIRECT d'un canal : demande une adresse puis POST /notify/test { instance_id, address }. */
  private async testDirect(instance: NotifierInstanceItem): Promise<void> {
    const address = await Dialog.prompt("Adresse de test pour « " + instance.label + " » (e-mail ou numéro selon la passerelle)", "");
    if (address === null || address.trim() === "") return;
    try {
      const res = await this.client!.testDirect(instance.id, address.trim());
      this.showTestResults(res, "Test direct — " + instance.label);
    } catch (e) { this.showTestError(e); }
  }

  private async deleteCanal(instance: NotifierInstanceItem): Promise<void> {
    const ok = await Dialog.confirm({
      title: "Supprimer ce canal ?",
      message: "Supprimer le canal « " + instance.label + " » ? Les ABONNEMENTS qui l'utilisent seront supprimés EN CASCADE (les alertes concernées ne seront plus routées vers ce canal).",
      confirmLabel: "Supprimer", danger: true,
    });
    if (!ok) return;
    try {
      await this.client!.deleteInstance(instance.id);
      Notify.toast("Canal supprimé", "ok");
      await this.loadCanaux();
    } catch (e) { this.showTestError(e); }
  }

  /* --------------------------------------------------------------------------
     2) ABONNEMENTS (routage par type d'événement)
     -------------------------------------------------------------------------- */

  private async loadAbonnements(): Promise<void> {
    this.message("Chargement des abonnements…");
    await this.guarded(async () => {
      // Les instances servent au sélecteur de canal ET à la résolution du libellé de canal en table.
      const [subs, instances] = await Promise.all([this.client!.listSubscriptions(), this.client!.listInstances()]);
      this.renderAbonnementsList(subs, instances);
    });
  }

  private renderAbonnementsList(subs: SubscriptionItem[], instances: NotifierInstanceItem[]): void {
    this.content.innerHTML = "";
    this.appendIntro("Abonnements de routage : chaque abonnement dirige un TYPE d'événement (pour un document ou pour tous) vers un contact, via un canal. Le contact est résolu dans le carnet du document courant.");
    const contacts = this.store.all("contacts") as Array<{ id: string; name?: string }>;

    if (!subs.length) {
      this.appendNote("Aucun abonnement. Ajoutez-en un pour qu'une alerte d'un type donné soit remise à un contact.");
    } else {
      const rows = subs.map((s) => [
        `<span style="font-family:var(--mono)">${Html.escape(s.event_type)}</span>`,
        Html.escape(this.scopeLabel(s.doc_id)),
        Html.escape(NotifyFormat.contactLabel(contacts, s.contact_id)),
        Html.escape(s.channel),
        Html.escape(NotificationsAdminView.instanceLabel(instances, s.notifier_id)),
        s.enabled ? this.pill("actif", "ok") : this.pill("inactif", "dim"),
        `<button class="btn btn-ghost btn-sm" data-edit="${Html.escape(s.id)}">Modifier</button>`
          + ` <button class="btn btn-ghost btn-sm" data-del="${Html.escape(s.id)}">Supprimer</button>`,
      ]);
      const tw = this.table(["Type", "Portée", "Contact", "Canal", "Instance", "État", ""], rows);
      tw.querySelectorAll("[data-edit]").forEach((el) => (el as HTMLElement).onclick = () => {
        const sub = subs.find((s) => s.id === (el as HTMLElement).dataset.edit); if (sub) this.abonnementModal(sub, instances);
      });
      tw.querySelectorAll("[data-del]").forEach((el) => (el as HTMLElement).onclick = () => {
        const sub = subs.find((s) => s.id === (el as HTMLElement).dataset.del); if (sub) void this.deleteAbonnement(sub);
      });
    }

    const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-primary btn-sm"; add.style.marginTop = "12px";
    add.textContent = "+ Ajouter un abonnement"; add.onclick = () => this.abonnementModal(null, instances);
    this.content.appendChild(add);
  }

  /** Création/édition d'un abonnement — dans la MODALE de l'app. Suppression = action de liste. */
  private abonnementModal(existing: SubscriptionItem | null, instances: NotifierInstanceItem[]): void {
    const editing = existing !== null;
    const root = document.createElement("div");

    // event_type : saisie libre + suggestions (datalist). « * » = tous les types.
    const eventInput = FormControls.text(existing ? existing.event_type : "", "ex. vm-sync-failure (ou « * » pour tous)");
    const listId = "notify-event-types";
    root.appendChild(FormControls.attachDatalist(eventInput, listId, EVENT_TYPE_SUGGESTIONS.slice()));
    root.appendChild(FormControls.fieldRow("Type d'événement", eventInput, "Type STABLE de l'événement (« vm-sync-failure », « cert-expiry », « test »…). « * » couvre tous les types."));

    // Portée : document courant OU global (tous documents). Sans document ouvert, seul le global est proposé.
    const docId = this.client!.docId;
    const scopeOpts = docId ? [{ value: "doc", label: "Ce document" }, { value: "global", label: "Tous les documents (global)" }] : [{ value: "global", label: "Tous les documents (global)" }];
    const defaultScope = editing ? (existing!.doc_id ? "doc" : "global") : (docId ? "doc" : "global");
    const scopeSel = FormControls.select(scopeOpts, defaultScope);
    root.appendChild(FormControls.fieldRow("Portée", scopeSel, docId ? "« Ce document » : n'écoute que les événements de ce document. « Global » : tous les documents." : "Aucun document ouvert : abonnement global uniquement."));

    // Contact : carnet du DOCUMENT COURANT (référence souple contact_id).
    const contacts = this.store.all("contacts") as Array<{ id: string; name?: string }>;
    const contactOpts = [{ value: "", label: "— choisir un contact —" }].concat(
      contacts.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")).map((c) => ({ value: c.id, label: c.name || "(sans nom)" })));
    const contactSel = FormControls.select(contactOpts, existing ? existing.contact_id : "");
    // Un contact d'un AUTRE document (édition d'un abonnement global) n'est pas dans la liste : on l'ajoute pour ne pas le perdre.
    if (existing && existing.contact_id && !contacts.some((c) => c.id === existing.contact_id)) {
      const opt = document.createElement("option"); opt.value = existing.contact_id; opt.textContent = "(contact hors de ce document)"; contactSel.appendChild(opt); contactSel.value = existing.contact_id;
    }
    root.appendChild(FormControls.fieldRow("Contact", contactSel, "Destinataire, pris dans le carnet du document courant (onglet Paramètres → Contacts)."));
    if (!contacts.length) this.appendNote("Aucun contact dans ce document — créez-en un (Paramètres → Contacts) pour l'abonner.", root);

    const channelSel = FormControls.select([{ value: "email", label: "E-mail" }, { value: "sms", label: "SMS" }], existing ? existing.channel : "email");
    root.appendChild(FormControls.fieldRow("Canal (adresse du contact)", channelSel, "E-mail → adresse e-mail du contact ; SMS → numéro de téléphone du contact."));

    const notifierOpts = [{ value: "", label: "— choisir un canal —" }].concat(instances.map((i) => ({ value: i.id, label: i.label + (i.enabled ? "" : " (inactif)") })));
    const notifierSel = FormControls.select(notifierOpts, existing ? existing.notifier_id : "");
    root.appendChild(FormControls.fieldRow("Instance de canal", notifierSel, "Le canal (onglet Canaux) par lequel remettre la notification."));
    if (!instances.length) this.appendNote("Aucun canal configuré — créez-en un (onglet Canaux) avant d'abonner.", root);

    const enabledToggle = FormControls.toggle("Abonnement actif", existing ? existing.enabled : true, () => { /* état lu à l'envoi */ });
    const enabledField = document.createElement("div"); enabledField.className = "form-field";
    const enabledLabel = document.createElement("label"); enabledLabel.textContent = "État"; enabledField.append(enabledLabel, enabledToggle);
    root.appendChild(enabledField);

    const errBox = this.errBox();
    root.appendChild(errBox);

    this.host.openModal({
      title: editing ? "Modifier l'abonnement" : "Nouvel abonnement",
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
        if (input.event_type === "") { this.showError(errBox, new NotifyError("Type d'événement requis", 0, null)); return false; }
        if (input.contact_id === "") { this.showError(errBox, new NotifyError("Contact requis", 0, null)); return false; }
        if (input.notifier_id === "") { this.showError(errBox, new NotifyError("Instance de canal requise", 0, null)); return false; }
        try {
          await this.client!.saveSubscription(editing ? existing!.id : NotificationsAdminView.newId(), input);
          Notify.toast(editing ? "Abonnement mis à jour" : "Abonnement créé", "ok");
          await this.loadAbonnements();
          return true;
        } catch (e) { this.showError(errBox, e); return false; }   // modale OUVERTE tant que non enregistré
      },
    });
    setTimeout(() => eventInput.focus(), 30);
  }

  private async deleteAbonnement(sub: SubscriptionItem): Promise<void> {
    const ok = await Dialog.confirm({ title: "Supprimer cet abonnement ?", message: "Supprimer l'abonnement « " + sub.event_type + " » ? Les alertes de ce type ne seront plus routées via cet abonnement.", confirmLabel: "Supprimer", danger: true });
    if (!ok) return;
    try { await this.client!.deleteSubscription(sub.id); Notify.toast("Abonnement supprimé", "ok"); await this.loadAbonnements(); }
    catch (e) { this.showTestError(e); }
  }

  /* --------------------------------------------------------------------------
     3) RAPPELS (intervalle de rappel PAR TYPE — décision Q2)
     -------------------------------------------------------------------------- */

  private async loadRappels(): Promise<void> {
    this.message("Chargement des rappels…");
    await this.guarded(async () => {
      const settings = await this.client!.listSettings();
      this.renderRappelsList(settings);
    });
  }

  private renderRappelsList(settings: EventSetting[]): void {
    this.content.innerHTML = "";
    this.appendIntro("Intervalle de RAPPEL par type d'événement : une alerte non résolue est re-notifiée à cet intervalle. Défaut appliqué à tout type non réglé ci-dessous : " + DEFAULT_REMIND_HOURS + " h.");

    if (!settings.length) {
      this.appendNote("Aucun réglage : tous les types utilisent le défaut (" + DEFAULT_REMIND_HOURS + " h). Ajoutez un réglage pour raccourcir/allonger le rappel d'un type précis.");
    } else {
      const rows = settings.map((s) => [
        `<span style="font-family:var(--mono)">${Html.escape(s.event_type)}</span>`,
        Html.escape(NotifyFormat.intervalLabel(s.remind_interval_sec)),
        `<button class="btn btn-ghost btn-sm" data-edit="${Html.escape(s.event_type)}">Modifier</button>`
          + ` <button class="btn btn-ghost btn-sm" data-del="${Html.escape(s.event_type)}">Réinitialiser</button>`,
      ]);
      const tw = this.table(["Type d'événement", "Intervalle de rappel", ""], rows);
      tw.querySelectorAll("[data-edit]").forEach((el) => (el as HTMLElement).onclick = () => {
        const set = settings.find((s) => s.event_type === (el as HTMLElement).dataset.edit); if (set) this.rappelModal(set);
      });
      tw.querySelectorAll("[data-del]").forEach((el) => (el as HTMLElement).onclick = () => {
        const set = settings.find((s) => s.event_type === (el as HTMLElement).dataset.del); if (set) void this.deleteRappel(set);
      });
    }

    const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-primary btn-sm"; add.style.marginTop = "12px";
    add.textContent = "+ Ajouter un réglage"; add.onclick = () => this.rappelModal(null);
    this.content.appendChild(add);
  }

  /** Création/édition d'un réglage de rappel — dans la MODALE de l'app. Réinitialisation = action de liste. */
  private rappelModal(existing: EventSetting | null): void {
    const editing = existing !== null;
    const root = document.createElement("div");

    const eventInput = FormControls.text(existing ? existing.event_type : "", "ex. cert-expiry");
    if (editing) { eventInput.readOnly = true; eventInput.style.opacity = "0.7"; }
    else { const listId = "notify-event-types-rappel"; root.appendChild(FormControls.attachDatalist(eventInput, listId, EVENT_TYPE_SUGGESTIONS.slice())); }
    root.appendChild(FormControls.fieldRow("Type d'événement", eventInput, editing ? "Immuable (clé du réglage)." : "Type dont on personnalise l'intervalle de rappel."));

    const hoursDefault = editing ? NotifyFormat.secToHours(existing!.remind_interval_sec) : DEFAULT_REMIND_HOURS;
    const hoursInput = FormControls.number(hoursDefault, { min: 0.02, step: 0.5, placeholder: String(DEFAULT_REMIND_HOURS) });
    root.appendChild(FormControls.fieldRow("Intervalle de rappel (heures)", hoursInput, "En heures. Minimum 1 minute (≈ 0,02 h) — en dessous, le rappel redeviendrait du spam."));

    const errBox = this.errBox();
    root.appendChild(errBox);

    this.host.openModal({
      title: editing ? ("Rappel — « " + existing!.event_type + " »") : "Nouveau réglage de rappel",
      body: root,
      onSave: async () => {
        errBox.style.display = "none";
        const eventType = eventInput.value.trim();
        if (eventType === "") { this.showError(errBox, new NotifyError("Type d'événement requis", 0, null)); return false; }
        const sec = NotifyFormat.hoursToSec(Number(hoursInput.value));
        if (!NotifyFormat.isValidRemindSec(sec)) { this.showError(errBox, new NotifyError("Intervalle trop court (minimum 1 minute)", 0, null)); return false; }
        try {
          await this.client!.saveSetting({ event_type: eventType, remind_interval_sec: sec });
          Notify.toast("Rappel réglé", "ok");
          await this.loadRappels();
          return true;
        } catch (e) { this.showError(errBox, e); return false; }   // modale OUVERTE tant que non enregistré
      },
    });
    setTimeout(() => { if (!editing) eventInput.focus(); else hoursInput.focus(); }, 30);
  }

  private async deleteRappel(setting: EventSetting): Promise<void> {
    const ok = await Dialog.confirm({ title: "Réinitialiser ce rappel ?", message: "Le type « " + setting.event_type + " » reviendra au rappel par défaut (" + DEFAULT_REMIND_HOURS + " h). Continuer ?", confirmLabel: "Réinitialiser" });
    if (!ok) return;
    try { await this.client!.deleteSetting(setting.event_type); Notify.toast("Rappel réinitialisé (défaut " + DEFAULT_REMIND_HOURS + " h)", "ok"); await this.loadRappels(); }
    catch (e) { this.showTestError(e); }
  }

  /* --------------------------------------------------------------------------
     4) ALERTES ACTIVES (états — lecture seule, pas de resolve manuel en v1)
     -------------------------------------------------------------------------- */

  private async loadAlertes(): Promise<void> {
    this.message("Chargement des alertes actives…");
    await this.guarded(async () => {
      const states = await this.client!.listStates();
      this.renderAlertes(states);
    });
  }

  private renderAlertes(states: NotifyStateItem[]): void {
    this.content.innerHTML = "";
    this.appendIntro("Alertes ACTUELLEMENT ouvertes (non résolues) suivies par le moteur anti-spam. Lecture seule : la résolution est pilotée par les producteurs (une alerte se ferme quand le problème est rétabli).");

    if (!states.length) { this.appendNote("Aucune alerte active. Tout va bien."); return; }
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
    this.table(["Gravité", "Type", "Titre", "Portée", "1re détection", "Dernier envoi", "Prochain rappel", "Dernière erreur"], rows);
  }

  /* --------------------------------------------------------------------------
     5) HISTORIQUE (journal des remises — paginé)
     -------------------------------------------------------------------------- */

  private async loadHistorique(): Promise<void> {
    this.message("Chargement de l'historique…");
    await this.guarded(async () => {
      const page = await this.client!.listLog({ limit: NotificationsAdminView.LOG_LIMIT, offset: this.logOffset });
      this.renderHistorique(page);
    });
  }

  private renderHistorique(page: NotifyLogPage): void {
    this.content.innerHTML = "";
    this.appendIntro("Journal des remises tentées (une ligne par destinataire). Purgé automatiquement au-delà de 90 jours côté serveur.");
    const contacts = this.store.all("contacts") as Array<{ id: string; name?: string }>;

    if (!page.entries.length && this.logOffset === 0) { this.appendNote("Aucune remise enregistrée pour l'instant."); return; }
    const rows = page.entries.map((e) => [
      Html.escape(Format.dateTime(e.sent_at)),
      Html.escape(e.phase || "—"),
      `<span style="font-family:var(--mono)">${Html.escape(e.event_type)}</span>`,
      Html.escape(NotifyFormat.contactLabel(contacts, e.contact_id)),
      Html.escape(e.channel || "—"),
      e.ok ? this.pill("OK", "ok") : this.pill("échec", "err"),
      e.detail ? `<span style="color:var(--err)">${Html.escape(e.detail)}</span>` : NotificationsAdminView.MUTED,
    ]);
    this.table(["Date", "Phase", "Type", "Contact", "Canal", "Résultat", "Détail"], rows);

    // -- Pagination (précédent / suivant) : bornée par le total renvoyé par le serveur. --
    const nav = document.createElement("div"); nav.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:12px";
    const from = page.total === 0 ? 0 : this.logOffset + 1;
    const to = Math.min(this.logOffset + page.entries.length, page.total);
    const prev = document.createElement("button"); prev.type = "button"; prev.className = "btn btn-ghost btn-sm"; prev.textContent = "← Précédent";
    prev.disabled = this.logOffset <= 0;
    prev.onclick = () => { this.logOffset = Math.max(0, this.logOffset - NotificationsAdminView.LOG_LIMIT); void this.loadHistorique(); };
    const next = document.createElement("button"); next.type = "button"; next.className = "btn btn-ghost btn-sm"; next.textContent = "Suivant →";
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
    btn.disabled = true; const prev = btn.textContent; btn.textContent = "Envoi en cours…";
    try {
      const res = await this.client.testRouted(this.client.docId);
      this.showTestResults(res, "Test routé (document courant)");
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
    const close = document.createElement("button"); close.type = "button"; close.className = "btn btn-ghost btn-sm"; close.innerHTML = Icons.CLOSE; close.title = "Masquer";
    close.onclick = () => { this.resultBar.innerHTML = ""; };
    head.append(t, close); box.appendChild(head);

    if (!res.results.length) {
      const hint = document.createElement("div"); hint.className = "form-hint"; hint.style.marginTop = "6px";
      hint.textContent = res.hint || "Aucun destinataire routé.";
      box.appendChild(hint);
    } else {
      const rows = res.results.map((r) => [
        r.ok ? this.pill("remis", "ok") : this.pill("échec", "err"),
        Html.escape(r.address || "—"),
        r.detail ? `<span style="color:var(--err)">${Html.escape(r.detail)}</span>` : NotificationsAdminView.MUTED,
      ]);
      box.appendChild(this.buildTable(["Résultat", "Adresse", "Détail"], rows));
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
      this.message("Chargement impossible — " + NotificationsAdminView.errText(e), true);
    } finally { this.loading = false; }
  }

  /** 503 : service indisponible côté serveur (clé DCMANAGER_SECRETS_KEY absente, ou module en erreur) →
      on montre le détail actionnable AU LIEU des contrôles (rien à administrer sans le service). */
  private renderDisabled(err: NotifyError): void {
    this.content.innerHTML = "";
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid var(--warn);border-radius:6px;padding:14px;background:var(--bg-2)";
    const title = document.createElement("div"); title.style.cssText = "font-weight:600;color:var(--warn);margin-bottom:6px";
    title.textContent = err.message || "Service de notifications indisponible";
    const detail = document.createElement("div"); detail.className = "form-hint"; detail.style.whiteSpace = "pre-line";
    detail.textContent = err.detail || "Le service de notifications est désactivé côté serveur. Définissez la clé de chiffrement des secrets (DCMANAGER_SECRETS_KEY) dans l'environnement du serveur pour l'activer.";
    box.append(title, detail); this.content.appendChild(box);
  }

  /** Mode fichier/viewer : le service n'a pas d'objet (pas de serveur) → message clair, aucun appel réseau. */
  private renderNeedsApi(): void {
    this.container.innerHTML = "";
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid var(--line);border-radius:6px;padding:16px;background:var(--bg-2)";
    const title = document.createElement("div"); title.style.cssText = "font-weight:600;color:var(--fg);margin-bottom:6px";
    title.textContent = "Administration des notifications — mode API requis";
    const detail = document.createElement("div"); detail.className = "form-hint";
    detail.textContent = "Le service de notifications (canaux, abonnements, rappels, alertes) est fourni par le serveur. Il n'est disponible qu'en mode API. Basculez la source de données sur « API » dans les Réglages pour l'administrer.";
    box.append(title, detail); this.container.appendChild(box);
  }

  /* --------------------------------------------------------------------------
     Résolutions / libellés
     -------------------------------------------------------------------------- */

  /** Portée d'un abonnement / d'un état : null → « tous » ; document courant → « ce document » ;
      autre document → forme compacte de l'id (l'admin voit toutes les portées, sans induire en erreur). */
  private scopeLabel(docId: string | null): string {
    if (!docId) return "tous les documents";
    if (this.client && docId === this.client.docId) return "ce document";
    return "autre document (" + docId.slice(0, 8) + ")";
  }

  /** Libellé d'un canal depuis la liste des instances — garde-fou si l'instance a disparu. */
  private static instanceLabel(instances: NotifierInstanceItem[], notifierId: string): string {
    const found = instances.find((i) => i.id === notifierId);
    return found ? found.label : "(canal introuvable)";
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
    if (severity === "error") return this.pill("erreur", "err");
    if (severity === "warning") return this.pill("avertissement", "warn");
    return this.pill(severity || "info", "neutral");
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
