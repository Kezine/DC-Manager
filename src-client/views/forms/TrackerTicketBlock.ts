import { I18n } from "../../i18n/I18n";
import { Html } from "../../core/Html";
import { Format } from "../../core/Format";
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { FormControls } from "../../ui/FormControls";
import { Icons } from "../../ui/Icons";
import { TrackerStatus } from "../../core/TrackerStatus";
import { TrackerReplication, type TrackerReplicationState, type TrackerPushState } from "../../core/TrackerReplication";
import { TrackerSyncError } from "./TrackerSyncClient";
import type { TrackerSyncClient, TrackerProviderSummary } from "./TrackerSyncClient";

/* =============================================================================
   BLOC « TICKET » de la fiche de DÉTAIL d'une intervention — feature AMOVIBLE
   (mode API, non-viewer). La retirer = supprimer ce fichier + son appel dans
   `InterventionsAdminView.detailBody`, sans cicatrice ailleurs.

   POURQUOI UN FICHIER À PART (principe n°2) : `InterventionsAdminView` est déjà
   une grosse vue. Le pont a son propre cycle (deux actions distantes, un état de
   poussée, un sélecteur de provider, une confirmation d'adoption) : l'y empiler
   la ferait grossir d'autant, alors que ce bloc ne partage RIEN avec le listing
   ni les formulaires. La vue n'en garde qu'un branchement fin — un conteneur et
   un rappel de rafraîchissement.

   CE QU'IL MONTRE, ET SEULEMENT SI C'EST PERTINENT :
   - intervention RÉPLIQUÉE → lien vers le ticket, pastille de statut (libellé
     BRUT du tracker, jamais traduit), assigné, dernier retour d'état, puis
     l'état de POUSSÉE : à jour (discret) / en attente / en échec (message du
     tracker INTACT + « Mettre à jour le ticket ») ;
   - intervention NON répliquée → l'action qui l'amorce, et LAQUELLE dépend de la
     référence déjà saisie sur l'intervention (cf. ci-dessous).

   ── LES DEUX ACTIONS D'AMORÇAGE, ET POURQUOI ELLES S'EXCLUENT ────────────────
   Sans référence : « Répliquer » CRÉE un ticket. Avec une référence déjà saisie
   à la main, créer produirait un DOUBLON silencieux du ticket que l'utilisateur
   désignait — on propose donc l'ADOPTION de ce ticket-là, et rien d'autre. Elle
   passe par une CONFIRMATION explicite, parce que ce ticket peut venir d'une
   AUTRE source du projet partagé et que le contenu DC Manager écrasera son
   résumé et sa description à la prochaine poussée (risque n°6 du cadrage). Une
   confirmation qui n'énonce pas ce qu'elle fait perdre ne protège personne.

   ── AGNOSTICISME DE MARQUE ──────────────────────────────────────────────────
   Aucun libellé, aucune clé et aucun champ ne nomme un tracker : l'état vient
   des colonnes `tracker_*` et la référence lisible arrive DÉJÀ PROJETÉE par la
   vue (`TrackerTicketView`), qui est seule à connaître le champ hérité qui la
   porte. Un test relit ces sources pour le vérifier.

   TOLÉRANCE : le pont est OPTIONNEL côté serveur. Une action qui échoue affiche
   le message du serveur (transmis tel quel — il nomme le champ ou le provider en
   cause) et ne casse jamais la fiche, qui reste consultable.
   ============================================================================= */

/** PROJECTION d'une intervention pour ce bloc — la vue la construit, ce fichier ne connaît donc ni
    le modèle des interventions ni le champ HÉRITÉ qui porte la référence lisible du ticket. */
export interface TrackerTicketView {
  /** Identifiant de l'intervention (routes `replicate`/`push`). */
  id: string;
  /** Référence LISIBLE du ticket telle qu'elle est portée par l'intervention ("" si aucune). C'est
      sa PRÉSENCE qui bascule l'amorçage de « créer » vers « adopter » (cf. l'en-tête). */
  reference: string;
  /** URL à ouvrir, DÉJÀ arbitrée par l'appelant (`TrackerReplication.ticketUrl`) — null si aucune. */
  url: string | null;
  /** Colonnes `tracker_*` de l'intervention. */
  state: TrackerReplicationState;
}

/** Ce dont le bloc a besoin de son hôte — injecté (la vue reste maître du rafraîchissement). */
export interface TrackerTicketHost {
  /** Client REST du pont (routes `replicate`/`push`). */
  client: TrackerSyncClient;
  /** Providers configurés sur le document. Sert UNIQUEMENT à proposer un choix quand il y en a
      PLUSIEURS ; vide = on n'en sait rien (pont indisponible, chargement échoué) et on laisse le
      serveur trancher — il refuse avec un message qui NOMME les providers s'il y a ambiguïté. */
  providers: readonly TrackerProviderSummary[];
  /** Appelé après TOUTE action réussie : l'hôte relit l'intervention et repeint (le bloc ne se
      rafraîchit jamais tout seul — c'est la vue qui sait d'où vient sa fraîcheur). */
  onChanged: () => void;
}

export class TrackerTicketBlock {
  /** Ajoute le bloc à `root`. Ne rend RIEN d'autre que ce qui a du sens pour l'état courant. */
  static attach(root: HTMLElement, host: TrackerTicketHost, ticket: TrackerTicketView): void {
    const divider = document.createElement("div");
    divider.className = "section-divider";
    divider.textContent = I18n.t("tracker.ticket.section");
    root.appendChild(divider);

    if (TrackerReplication.isReplicated(ticket.state)) TrackerTicketBlock.renderReplicated(root, host, ticket);
    else TrackerTicketBlock.renderNotReplicated(root, host, ticket);
  }

  /* --------------------------------------------------------------------------
     Intervention RÉPLIQUÉE : le ticket, son traitement, l'état de la poussée
     -------------------------------------------------------------------------- */

  private static renderReplicated(root: HTMLElement, host: TrackerTicketHost, ticket: TrackerTicketView): void {
    const state = ticket.state;

    // -- Ligne 1 : lien vers le ticket (icône + libellé) + pastille de statut. Le lien passe par
    //    `Html.externalLink` (liste blanche de schémas + rel=noopener) : l'URL vient d'un TIERS. --
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:2px 0 8px";
    const icon = document.createElement("span");
    icon.className = "gi"; icon.setAttribute("aria-hidden", "true"); icon.innerHTML = Icons.TICKET;
    head.appendChild(icon);

    const label = ticket.reference || TrackerTicketBlock.text(state.tracker_ext_id);
    const link = document.createElement("span");
    link.style.cssText = "font-family:var(--mono);font-size:12px";
    link.innerHTML = ticket.url ? Html.externalLink(ticket.url, label) : Html.escape(label);
    head.appendChild(link);

    const pill = document.createElement("span");
    // L'infobulle n'est posée QUE sur la fiche (le listing n'a pas la place) : elle explique ce
    // qu'« introuvable » veut dire et que rien n'est perdu localement.
    pill.innerHTML = TrackerStatus.statusPill(TrackerTicketBlock.ticketStatus(state), I18n.t("tracker.ticket.notFoundTitle"));
    head.appendChild(pill);
    root.appendChild(head);

    // -- Traitement côté tracker (lecture SEULE — DC Manager n'assigne pas). --
    root.appendChild(TrackerTicketBlock.field(I18n.t("tracker.ticket.assignee"),
      TrackerTicketBlock.text(state.tracker_assignee) || I18n.t("tracker.ticket.unassigned"),
      TrackerTicketBlock.text(state.tracker_assignee) === ""));

    const lastSync = TrackerTicketBlock.text(state.tracker_last_sync);
    root.appendChild(TrackerTicketBlock.field(I18n.t("tracker.ticket.lastSync"),
      lastSync ? Format.dateTime(lastSync) : I18n.t("tracker.ticket.never"), lastSync === ""));

    // -- État de POUSSÉE : le régime normal (« à jour ») reste DISCRET, l'échec porte son message
    //    et son bouton de reprise. Un `pending` se résorbe seul à la passe suivante — on le dit,
    //    sans proposer d'action : la proposer inviterait à marteler le tracker pour rien. --
    const pushState = TrackerReplication.pushState(state);
    const pushRow = document.createElement("div");
    pushRow.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap";
    const badge = document.createElement("span");
    badge.innerHTML = TrackerTicketBlock.badge(I18n.t(TrackerReplication.pushStateLabelKey(pushState)), pushState);
    pushRow.appendChild(badge);

    const pushError = TrackerReplication.pushError(state);
    if (TrackerReplication.hasPushError(state)) {
      pushRow.appendChild(TrackerTicketBlock.action(I18n.t("tracker.ticket.update"), async (btn) => {
        btn.disabled = true;
        try {
          const outcome = await host.client.push(ticket.id);
          Notify.toast(outcome.message || I18n.t("tracker.ticket.updated"), "ok");
          host.onChanged();
        } catch (e) {
          btn.disabled = false;
          TrackerTicketBlock.reportError(e);
        }
      }, "btn-primary"));
    }
    root.appendChild(TrackerTicketBlock.fieldRow(I18n.t("tracker.ticket.push.label"), pushRow));

    if (pushError !== "") {
      // Message du TRACKER, transmis intact : c'est lui qui nomme le champ refusé ou le droit
      // manquant. Le reformuler détruirait la seule information exploitable.
      const err = document.createElement("div");
      err.className = "form-hint err"; err.style.whiteSpace = "pre-line"; err.textContent = pushError;
      root.appendChild(err);
    }
  }

  /* --------------------------------------------------------------------------
     Intervention NON répliquée : amorcer (créer) ou adopter (lier)
     -------------------------------------------------------------------------- */

  private static renderNotReplicated(root: HTMLElement, host: TrackerTicketHost, ticket: TrackerTicketView): void {
    const adopting = ticket.reference !== "";

    const hint = document.createElement("div");
    hint.className = "form-hint";
    hint.textContent = adopting
      ? I18n.t("tracker.ticket.linkHint", { reference: ticket.reference })
      : I18n.t("tracker.ticket.replicateHint");
    root.appendChild(hint);

    // Sélecteur de provider : UNIQUEMENT quand le document en a plusieurs. Avec un seul, le
    // demander serait une question dont l'utilisateur n'a pas la réponse — le serveur l'applique
    // implicitement. Avec zéro provider CONNU (liste non chargée), on n'envoie rien : le serveur
    // refusera avec un message qui dit quoi faire.
    let providerSel: HTMLSelectElement | null = null;
    if (host.providers.length > 1) {
      providerSel = FormControls.select(host.providers.map((p) => ({ value: p.id, label: p.id })), host.providers[0].id);
      root.appendChild(FormControls.fieldRow(I18n.t("tracker.ticket.providerField"), providerSel, I18n.t("tracker.ticket.providerHint")));
    }

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-top:8px";
    actions.appendChild(TrackerTicketBlock.action(
      adopting ? I18n.t("tracker.ticket.link") : I18n.t("tracker.ticket.replicate"),
      async (btn) => {
        // ADOPTION : confirmation EXPLICITE (le contenu DC Manager écrasera le ticket — cf. en-tête).
        if (adopting) {
          const ok = await Dialog.confirm({
            title: I18n.t("tracker.ticket.linkConfirmTitle"),
            message: I18n.t("tracker.ticket.linkConfirmMessage", { reference: ticket.reference }),
            confirmLabel: I18n.t("tracker.ticket.linkConfirm"),
          });
          if (!ok) return;
        }
        btn.disabled = true;
        try {
          const outcome = await host.client.replicate(ticket.id, {
            ...(providerSel ? { provider_id: providerSel.value } : {}),
            ...(adopting ? { link: true } : {}),
          });
          Notify.toast(outcome.message || I18n.t("tracker.ticket.replicated"), "ok");
          host.onChanged();
        } catch (e) {
          btn.disabled = false;
          TrackerTicketBlock.reportError(e);
        }
      }, "btn-primary"));
    root.appendChild(actions);
  }

  /* --------------------------------------------------------------------------
     Primitives locales (mêmes classes CSS que les fiches)
     -------------------------------------------------------------------------- */

  /** Statut du ticket vu par `TrackerStatus` — PROJECTION des colonnes `tracker_*` sur la forme
      générique du module (qui ne connaît, lui, que « un ticket »). */
  private static ticketStatus(state: TrackerReplicationState) {
    return { status: state.tracker_status, status_category: state.tracker_status_category };
  }

  /** Échec d'une action : 503 = pont indisponible (clé de chiffrement absente, config en erreur) →
      on montre le `detail` actionnable ; sinon le message du serveur. 🚨 Quand une clé de ticket
      accompagne l'échec, elle est AFFICHÉE : un ticket a bel et bien été créé chez le tracker, et
      c'est la seule information qui rende la situation rattrapable (adoption avec cette clé). */
  private static reportError(e: unknown): void {
    if (e instanceof TrackerSyncError && e.key) {
      Notify.toast(I18n.t("tracker.ticket.createdOrphan", { key: e.key, detail: e.message }), "err");
      return;
    }
    Notify.toast(TrackerSyncError.text(e), "err");
  }

  /** Rangée « libellé + valeur texte » (lecture seule, estompée si `muted`). */
  private static field(label: string, value: string, muted = false): HTMLElement {
    const div = document.createElement("div"); div.textContent = value;
    if (muted) div.style.color = "var(--fg-dimmer)";
    return TrackerTicketBlock.fieldRow(label, div);
  }

  /** Rangée « libellé + contenu libre » (même facture que `detailField` de la vue). */
  private static fieldRow(label: string, value: HTMLElement): HTMLElement {
    const f = document.createElement("div"); f.className = "form-field";
    const l = document.createElement("label"); l.textContent = label;
    f.append(l, value);
    return f;
  }

  /** Bouton d'action PRIMAIRE du bloc (texte, pas d'icône : ce sont des actions explicites, pas des
      actions de ligne — principe n°14). Le rappel reçoit le bouton pour le désarmer pendant l'appel. */
  private static action(label: string, run: (btn: HTMLButtonElement) => Promise<void>, cls = "btn-ghost"): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn " + cls + " btn-sm"; b.textContent = label;
    b.onclick = () => { void run(b); };
    return b;
  }

  /** Pastille sémantique de l'état de poussée (mêmes couleurs que les badges de la vue). */
  private static badge(text: string, pushState: TrackerPushState): string {
    const kind = TrackerReplication.pushStateClass(pushState);
    const style = kind === "err" ? ` style="border-color:var(--err);color:var(--err)"`
      : kind === "warn" ? ` style="border-color:var(--warn);color:var(--warn)"`
      : kind === "dim" ? ` style="border-color:var(--fg-dimmer);color:var(--fg-dim)"`
      : "";
    return `<span class="pill"${style}>${Html.escape(text)}</span>`;
  }

  /** Chaîne ROGNÉE d'une valeur tolérante ("" si absente). */
  private static text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }
}
