import type { Store } from "../../store";
import { FormControls } from "../../ui/FormControls";
import { Notify } from "../../ui/Notify";
import { Icons } from "../../ui/Icons";
import { IconButton } from "../../ui/IconButton";
import { SearchPop, type SearchPopResult } from "../../ui/SearchPop";
import { Html } from "../../core/Html";
import { EntityCandidateSource } from "../../core/EntityCandidates";   // DEBOUNCE_MS : même tempo que la palette et les listings
import { Issue } from "../../models/Issue";
import { IssueTargets } from "../../../src-shared/IssueTargets";
import { IssueSyncError } from "./IssueSyncClient";
import type { IssueSyncClient, IssueProviderStatus, IssueProviderSummary } from "./IssueSyncClient";
import type { IssueTargetSource } from "../IssueTargetSource";
import type { FormHost } from "./shared";
import { I18n } from "../../i18n/I18n";

/* =============================================================================
   FORMULAIRES DE LA FEATURE « TICKETS » (AMOVIBLE) — édition des champs LOCAUX
   et des CIBLES, synchronisation, et la porte d'entrée « Suivre un ticket ».

   Classe DÉDIÉE et AUTONOME (hors chaîne d'héritage `Forms`, à côté de
   `IssueProvidersForm`) : la retirer = supprimer ce fichier + le branchement
   `extraActions` de l'onglet Tickets + l'entrée `issues` de `DetailForms`, sans
   cicatrice dans les autres formulaires (exigence transverse « feature amovible »).

   ── CE QUI MARCHE EN MODE FICHIER, ET POURQUOI (décision D9) ──────────────────
   `edit` ne dépend d'AUCUN client réseau : `description`, `notes` et surtout
   `targets` sont des données DU DOCUMENT, pas du tracker. Elles restent donc
   éditables sans serveur, après export. Seules `sync` et `follow` exigent le mode
   API (jeton chiffré au repos, appels sortants) — elles sont alors simplement
   ABSENTES de l'UI, jamais grisées.

   AGNOSTIQUE DE MARQUE : rien ici ne nomme un tracker — ni les libellés, ni les
   messages. La marque ne vit que dans l'adaptateur serveur.
   ============================================================================= */
export class IssueForms {
  /** Formulaire d'ÉDITION d'un ticket — n'expose QUE ce qui appartient au document : les
      enrichissements LOCAUX (`description`, `notes`) et le rattachement MANUEL (`targets`).
      Les champs SOURCE (clé, titre, statut, type, priorité, assigné…) viennent de la synchro et
      seraient écrasés à la passe suivante, ce qui est PIRE qu'un champ absent — ils ne sont donc
      pas éditables (frontière `src-shared/IssueSync`, exactement comme les VMs et le wifi).

      À l'enregistrement, le payload ne contient QUE ces trois champs : `store.update` FUSIONNE le
      patch dans l'existant, donc les champs source restent INTACTS. */
  static edit(store: Store, host: FormHost, id: string, onSaved?: () => void): void {
    const issue: any = store.get("issues", id);
    if (!issue) { Notify.toast(I18n.t("issues.edit.notFound"), "err"); return; }
    const root = document.createElement("div");

    // Bandeau explicite : SEULS le rattachement et les enrichissements locaux sont modifiables ici.
    const note = document.createElement("div"); note.className = "form-hint";
    note.textContent = I18n.t("issues.edit.localOnly");
    root.appendChild(note);

    const descriptionInput = FormControls.textArea(issue.description || "");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.description"), descriptionInput, I18n.t("issues.edit.descriptionHint")));
    const notesInput = FormControls.textArea(issue.notes || "");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.notes"), notesInput, I18n.t("issues.edit.notesHint")));

    // COPIE de travail : l'éditeur mute ce tableau en place, l'enregistrement le pose tel quel.
    // Copier (et non muter `issue.targets`) garde l'annulation VRAIMENT annulante.
    const targets: string[] = Array.isArray(issue.targets) ? issue.targets.slice() : [];
    root.appendChild(IssueForms.buildTargetsEditor(targets, host.issueTargets || null));

    host.openModal({
      title: I18n.t("issues.edit.title"),
      subtitle: Html.escape(Issue.displayName(issue)),
      body: root, wide: true,
      onSave: async () => {
        const ok = await store.update("issues", id, {
          description: descriptionInput.value.trim(),
          notes: notesInput.value.trim(),
          targets,
        });
        if (!ok) { Notify.toast(I18n.t("issues.edit.saveRefused"), "err"); return false; }   // validation partagée → modale conservée
        host.setDirty?.(true); Notify.toast(I18n.t("issues.edit.saved")); onSaved?.(); return true;
      },
    });
    setTimeout(() => descriptionInput.focus(), 30);
  }

  /* ============================================================================
     ÉDITEUR DE CIBLES (décision D5) — zéro primitive nouvelle (principe n°14)
     ============================================================================ */

  /** Éditeur des CIBLES d'un ticket : SÉLECTION unifiée via `SearchPop` (la recherche traverse
      équipements, VMs, spares et sous-équipements CONFONDUS, le CLIC lie l'élément) + la liste des
      cibles liées, chacune avec son icône de famille et son bouton-ICÔNE de retrait (principe n°14).
      `targets` est muté EN PLACE (clés « famille:id » composées par le module PARTAGÉ).

      ⚠ Contrairement à l'éditeur de liens des interventions, on n'a PAS à gérer un lien « introuvable » :
      les cibles d'un ticket vivent dans le MÊME document, et la cascade partagée retire la clé quand
      l'objet est supprimé. Un document IMPORTÉ peut malgré tout en porter un (écrit par une autre
      porte) : il est alors GRISÉ, jamais une erreur — et retirable, ce qui est la seule chose utile.

      `source` null (aucune source injectée) est un cas DÉFENSIF, pas un mode : `main.ts` en fournit
      une dans les DEUX modes de données. On rend alors la liste en lecture, sans champ de recherche —
      plutôt qu'un champ qui ne trouverait jamais rien. */
  private static buildTargetsEditor(targets: string[], source: IssueTargetSource | null): HTMLElement {
    const field = document.createElement("div"); field.className = "form-field";
    const label = document.createElement("label"); label.textContent = I18n.t("issues.targets.label");
    const hint = document.createElement("div"); hint.className = "form-hint"; hint.textContent = I18n.t("issues.targets.hint");
    field.append(label, hint);

    const listEl = document.createElement("div"); listEl.style.marginTop = "8px";
    const renderTargets = (): void => {
      listEl.innerHTML = "";
      if (!targets.length) {
        const empty = document.createElement("div"); empty.className = "form-hint"; empty.style.fontStyle = "italic";
        empty.textContent = I18n.t("issues.targets.empty"); listEl.appendChild(empty); return;
      }
      targets.forEach((key, index) => {
        const row = document.createElement("div"); row.style.cssText = "display:flex;align-items:center;gap:8px;padding:2px 0";
        const ref = IssueTargets.parse(key);
        const resolved = (ref && source) ? source.labelOf(ref.kind, ref.id) : null;
        const icon = document.createElement("span"); icon.className = "gi"; icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = IssueForms.familyIcon(ref ? ref.kind : "");
        const text = document.createElement("span");
        const family = (ref && source) ? source.tagOf(ref.kind) : "";
        // Repli sur la CLÉ BRUTE quand rien ne se résout : une donnée qu'on ne comprend pas doit rester
        // VISIBLE (et retirable), jamais disparaître de l'écran sans laisser de trace.
        text.textContent = (family ? family + " · " : "") + (resolved !== null ? resolved : key);
        if (resolved === null) text.style.color = "var(--fg-dimmer)";   // cible non résolue (document importé) → grisée
        const del = IconButton.build({ icon: Icons.CLOSE, label: I18n.t("issues.targets.remove"), onClick: () => { targets.splice(index, 1); renderTargets(); } });
        del.style.marginLeft = "auto";
        row.append(icon, text, del); listEl.appendChild(row);
      });
    };
    renderTargets();

    if (source) {
      const pop = new SearchPop({
        placeholder: I18n.t("issues.targets.searchPlaceholder"),
        minChars: 1,
        debounceMs: EntityCandidateSource.DEBOUNCE_MS,   // même tempo que la palette / les listings serveur-pilotés
        // PORTAIL : le champ vit dans le corps DÉFILANT d'une modale, qui ROGNE — un popover en
        // position absolue y serait coupé par l'overflow (cf. l'en-tête de SearchPop).
        portal: true,
        fetch: (query) => {
          // La dédup est calculée à CHAQUE frappe sur l'état COURANT de `targets` : les cibles déjà
          // liées ne peuvent pas être reproposées (et donc pas doublonner).
          const excluded = new Set(targets);
          return source.search(query, excluded).then((results) => results.map((r): SearchPopResult => ({
            id: IssueTargets.key(r.kind, r.id), label: r.label, tag: source.tagOf(r.kind) || undefined, data: r,
          })));
        },
        onPick: (result) => {
          const key = result.id;
          // Ceinture : un doublon résiduel (course entre deux frappes) est ignoré avec un toast discret.
          if (targets.indexOf(key) >= 0) { Notify.toast(I18n.t("issues.targets.exists"), "info"); return; }
          targets.push(key);
          renderTargets();
        },
      });
      const searchWrap = document.createElement("div"); searchWrap.style.marginTop = "6px"; searchWrap.appendChild(pop.element);
      field.appendChild(searchWrap);
    }

    field.appendChild(listEl);
    return field;
  }

  /** Icône de FAMILLE d'une cible — repère visuel de la liste des objets liés. `sub_equipment`
      réutilise DÉLIBÉRÉMENT l'icône d'équipement (un sous-équipement est le contenu logique d'un
      équipement, et le badge de famille fait déjà la distinction) ; EQUIPMENT est aussi le repli
      des slugs inconnus. MÊME arbitrage que l'éditeur de liens d'intervention — recopié plutôt
      qu'importé, parce que les deux modules doivent rester amovibles séparément (décision D10). */
  static familyIcon(kind: string): string {
    return kind === "vm" ? Icons.VM : kind === "spare" ? Icons.SPARE : Icons.EQUIPMENT;
  }

  /* ============================================================================
     SYNCHRONISATION (mode API uniquement) — bouton « Synchroniser » de la barre
     d'outils de l'onglet Tickets, câblé depuis main.ts derrière la garde REST_MODE
     (masqué en mode fichier). Le RECHARGEMENT de la collection `issues` n'est PAS
     géré ici : après une passe qui écrit, le serveur émet son événement SSE →
     tous les clients rechargent en granulaire.
     ============================================================================ */

  /** Lance une synchro de TOUS les providers du document et notifie le résultat PAR provider.
      `btn` = le bouton de la barre d'outils : désactivé + libellé « Synchronisation… » le temps
      de l'appel (retour à l'état initial en `finally`, même en cas d'erreur). */
  static async sync(client: IssueSyncClient, btn: HTMLButtonElement): Promise<void> {
    const originalLabel = btn.textContent || I18n.t("issues.sync.syncLabel");
    btn.disabled = true;
    btn.textContent = I18n.t("issues.sync.syncing");
    try {
      const providers = await client.sync();
      if (!providers.length) {
        Notify.toast(I18n.t("issues.common.noProvider"));
        return;
      }
      // Un toast PAR provider : succès = résumé des compteurs (message serveur) ; échec = erreur.
      providers.forEach((p) => Notify.toast(IssueForms.providerLine(p) + " : " + p.message, p.ok ? "ok" : "err"));
    } catch (e) {
      // 404 (document inconnu), 503 (feature désactivée + detail), panne réseau → toast détaillé.
      Notify.toast(I18n.t("issues.sync.syncImpossible", { detail: IssueForms.errText(e) }), "err");
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  /* ============================================================================
     « SUIVRE UN TICKET » — la PORTE D'ENTRÉE de l'assiette (décision D4)
     ============================================================================ */

  /** Modale « Suivre un ticket » : un seul champ (la clé lisible OU l'URL collée) et Enregistrer.
      C'est volontairement le formulaire le plus pauvre de l'app, parce que c'est le SERVEUR qui
      résout : l'utilisateur n'a ni provider à choisir (le premier qui reconnaît la référence gagne),
      ni identifiant interne à connaître.

      Les trois issues, et pourquoi elles ne se ressemblent pas :
      - SUCCÈS → toast + rafraîchissement (le ticket est DÉJÀ à jour : le serveur l'a résolu avant
        de l'écrire) ;
      - DÉJÀ SUIVI → le serveur a rafraîchi sans créer de doublon. On le DIT (toast « info ») plutôt
        que d'annoncer une création : sinon l'utilisateur cherche une ligne nouvelle qui n'existe pas ;
      - REFUS (422, référence inconnue ou inaccessible) → le message actionnable du serveur s'affiche
        DANS la modale, qui RESTE OUVERTE pour correction. Refermer en avalant l'erreur obligerait à
        tout ressaisir sans savoir ce qui n'allait pas. */
  static follow(host: FormHost, client: IssueSyncClient, onFollowed?: () => void): void {
    const root = document.createElement("div");
    const note = document.createElement("div"); note.className = "form-hint";
    note.textContent = I18n.t("issues.follow.intro");
    root.appendChild(note);

    const refInput = FormControls.text("", I18n.t("issues.follow.placeholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("issues.follow.field"), refInput, I18n.t("issues.follow.hint")));

    const errBox = document.createElement("div"); errBox.className = "form-hint err";
    errBox.style.cssText = "margin-top:10px;white-space:pre-line;display:none";
    root.appendChild(errBox);

    host.openModal({
      title: I18n.t("issues.follow.title"),
      body: root, saveLabel: I18n.t("issues.follow.submit"),
      onSave: async () => {
        errBox.style.display = "none";
        const reference = refInput.value.trim();
        // Garde LOCALE : inutile d'aller demander au serveur ce qu'on sait déjà (et le message reste
        // le même que celui qu'il rendrait). La modale reste ouverte, le champ garde le focus.
        if (!reference) { IssueForms.showError(errBox, I18n.t("issues.follow.required")); refInput.focus(); return false; }
        try {
          const result = await client.follow(reference);
          Notify.toast(result.already ? I18n.t("issues.follow.already") : I18n.t("issues.follow.added"), result.already ? "info" : "ok");
          onFollowed?.();
          return true;
        } catch (e) {
          // 422 = référence inexploitable (ticket inexistant, hors permissions, provider en panne) :
          // le message du serveur EST l'information actionnable → on l'affiche tel quel, sans enveloppe.
          IssueForms.showError(errBox, IssueForms.errText(e));
          refInput.focus();
          return false;   // modale CONSERVÉE : la saisie reste corrigeable
        }
      },
    });
    setTimeout(() => refInput.focus(), 30);
  }

  /* ============================================================================
     « OUVRIR UN TICKET » — la PORTE D'ENTRÉE n°2 de l'assiette (décision D7)
     ============================================================================ */

  /** Modale de CRÉATION d'un ticket chez le tracker. Modale standard de l'app (principe n°11),
      ouverte depuis l'en-tête de l'onglet Tickets (bouton primaire « + Ouvrir un ticket ») ET depuis
      la rangée « Tickets » des fiches — d'où `prefill`, qui porte le titre suggéré et la cible
      pré-liée. Mode API et hors viewer uniquement (la création parle au tracker).

      CE QUE LE FORMULAIRE NE DEMANDE PAS, ET POURQUOI : ni le PROJET, ni le TYPE de ticket. Ce sont
      des OPTIONS du provider, réglées une fois par l'opérateur — les demander à chaque création
      obligerait l'utilisateur à connaître la configuration du tracker, et permettrait de viser un
      autre projet que celui qui a été autorisé. Ils sont donc simplement RAPPELÉS, en clair.

      LES TROIS ISSUES, ET POURQUOI ELLES NE SE RESSEMBLENT PAS :
      - SUCCÈS → toast + `onCreated` (l'appelant rafraîchit ce qui doit l'être) ;
      - REFUS DU TRACKER (422) → son message s'affiche TEL QUEL dans la modale, qui RESTE OUVERTE :
        il nomme le champ manquant (« le champ Équipe est requis »), donc il est corrigeable ;
      - 🚨 ÉCHEC PARTIEL (le ticket EXISTE chez le tracker, l'écriture locale a échoué) → message
        DÉDIÉ portant la CLÉ créée, et la modale se VERROUILLE : ré-enregistrer créerait un SECOND
        ticket chez le tracker, ce qui est exactement le contraire de ce qu'il faut faire. La seule
        suite utile est « Suivre un ticket » avec cette clé, et le message le dit. */
  static create(
    host: FormHost,
    client: IssueSyncClient,
    prefill?: { summary?: string; targets?: string[]; context?: string },
    onCreated?: (issueId: string) => void,
  ): void {
    const root = document.createElement("div");
    const note = document.createElement("div"); note.className = "form-hint";
    note.textContent = I18n.t("issues.create.intro");
    root.appendChild(note);

    const summaryInput = FormControls.text(prefill?.summary || "", I18n.t("issues.create.summaryPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("issues.create.summaryField"), summaryInput, I18n.t("issues.create.summaryHint")));
    const descriptionInput = FormControls.textArea("");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.description"), descriptionInput, I18n.t("issues.create.descriptionHint")));

    // PROVIDER + rappel de DESTINATION : hôtes vides, remplis quand la liste arrive. Le `<select>`
    // n'est rendu QUE s'il y a plusieurs providers — un choix unique n'est pas un choix, et c'est
    // exactement la règle qu'applique le serveur (implicite à un, requis au-delà).
    const providerHost = document.createElement("div");
    root.appendChild(providerHost);
    const destination = document.createElement("div"); destination.className = "form-hint"; destination.style.marginTop = "4px";
    root.appendChild(destination);
    // Provider RETENU : "" = « laisse le serveur décider » (cas du provider unique). Muté par le
    // <select> quand il existe.
    let providerId = "";
    let providers: IssueProviderSummary[] = [];
    const paintDestination = (): void => {
      const chosen = providers.find((p) => p.id === providerId) || (providers.length === 1 ? providers[0] : null);
      if (!chosen) { destination.textContent = providers.length ? I18n.t("issues.create.destinationUnknown") : ""; return; }
      const project = typeof chosen.options?.project_key === "string" ? chosen.options.project_key.trim() : "";
      const type = typeof chosen.options?.issue_type === "string" ? chosen.options.issue_type.trim() : "";
      // Projet non configuré : le serveur refusera (message actionnable de l'adaptateur). On le DIT
      // AVANT la tentative — découvrir la chose après avoir rédigé un ticket est inutilement pénible.
      destination.textContent = project
        ? I18n.t("issues.create.destination", { provider: chosen.id, project, type: type || "—" })
        : I18n.t("issues.create.noProject", { provider: chosen.id });
      destination.style.color = project ? "" : "var(--warn)";
    };
    client.providers().then((list) => {
      providers = list;
      if (list.length > 1) {
        const select = FormControls.select(list.map((p) => ({ value: p.id, label: p.id })), list[0].id);
        providerId = list[0].id;
        select.onchange = () => { providerId = select.value; paintDestination(); };
        providerHost.appendChild(FormControls.fieldRow(I18n.t("issues.create.providerField"), select, I18n.t("issues.create.providerHint")));
      }
      paintDestination();
    }).catch(() => {
      // Liste indisponible (503, réseau) : on n'empêche RIEN — le serveur tranchera et son refus est
      // actionnable. Seul le rappel de destination manque, ce qui est un confort, pas une condition.
      destination.textContent = I18n.t("issues.create.destinationUnknown");
    });

    // CIBLES : le MÊME éditeur que la fiche (SearchPop unifié, principe n°14). Copie de travail —
    // la modale peut être annulée, et le tableau du prefill appartient à l'appelant.
    const targets: string[] = Array.isArray(prefill?.targets) ? prefill!.targets!.slice() : [];
    root.appendChild(IssueForms.buildTargetsEditor(targets, host.issueTargets || null));

    const errBox = document.createElement("div"); errBox.className = "form-hint err";
    errBox.style.cssText = "margin-top:10px;white-space:pre-line;display:none";
    root.appendChild(errBox);

    // VERROU d'après échec PARTIEL (cf. l'en-tête) : une fois le ticket créé chez le tracker, plus
    // aucun enregistrement ne doit partir depuis cette modale.
    let partialKey: string | null = null;

    host.openModal({
      title: I18n.t("issues.create.title"),
      subtitle: prefill?.context ? Html.escape(prefill.context) : undefined,
      body: root, wide: true, saveLabel: I18n.t("issues.create.submit"),
      onSave: async () => {
        if (partialKey !== null) {
          // Ré-enregistrer créerait un SECOND ticket chez le tracker : on refuse, en rappelant la clé.
          IssueForms.showError(errBox, I18n.t("issues.create.alreadyCreated", { key: partialKey }));
          return false;
        }
        errBox.style.display = "none";
        const summary = summaryInput.value.trim();
        // Garde LOCALE : inutile de demander au serveur ce qu'on sait déjà (et son message serait le
        // même). La modale reste ouverte, le champ garde le focus.
        if (!summary) { IssueForms.showError(errBox, I18n.t("issues.create.summaryRequired")); summaryInput.focus(); return false; }
        try {
          const result = await client.createIssue({
            provider_id: providerId || undefined,
            summary,
            description: descriptionInput.value.trim(),
            targets,
          });
          Notify.toast(result.message || I18n.t("issues.create.created"), "ok");
          onCreated?.(result.issue && typeof result.issue.id === "string" ? result.issue.id : "");
          return true;
        } catch (e) {
          if (e instanceof IssueSyncError && e.createdKey) {
            // 🚨 ÉCHEC PARTIEL : le ticket EXISTE. Message DÉDIÉ portant la clé + verrou.
            partialKey = e.createdKey;
            IssueForms.showError(errBox, I18n.t("issues.create.partial", { key: e.createdKey, detail: e.message }));
            return false;
          }
          // 400 (demande incomplète) ou 422 (refus du tracker) : le message du serveur EST
          // l'information actionnable → affiché tel quel, sans enveloppe, modale CONSERVÉE.
          IssueForms.showError(errBox, IssueForms.errText(e));
          return false;
        }
      },
    });
    setTimeout(() => summaryInput.focus(), 30);
  }

  /* -------------------------------------------------------------------------- */

  /** Affiche un message d'erreur dans la zone dédiée d'une modale (texte, jamais du HTML). */
  private static showError(box: HTMLElement, text: string): void {
    box.style.display = "block";
    box.textContent = text;
  }

  /** Ligne d'identité d'un provider pour un toast : « id (kind) ». */
  private static providerLine(p: IssueProviderStatus): string {
    return p.provider_id + " (" + p.kind + ")";
  }

  /** Message d'erreur lisible : `IssueSyncError` porte code HTTP + `detail` serveur ; toute autre
      erreur (panne réseau…) remonte son `message` brut. */
  private static errText(e: unknown): string {
    if (e instanceof IssueSyncError) return e.message + (e.detail ? " — " + e.detail : "");
    return e instanceof Error ? e.message : String(e);
  }
}
