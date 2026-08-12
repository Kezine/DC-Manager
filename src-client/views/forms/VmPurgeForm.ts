import type { Store } from "../../store";
import { FormControls } from "../../ui/FormControls";
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { VmPurge } from "../../core/VmPurge";
import type { VmPurgeGroup, VmPurgeEntry, VmEnrichmentFamily, VmPurgeReaders, VmPurgeSelection, VmPurgeCascadePlan } from "../../core/VmPurge";
import { VmSyncError } from "./VmSyncClient";
import type { VmSyncClient } from "./VmSyncClient";
import type { FormHost } from "./shared";
import { I18n } from "../../i18n/I18n";

/* =============================================================================
   MODALE « PURGER DES VMs… » — feature VM AMOVIBLE, modes FICHIER **ET** API, non-viewer.

   Classe DÉDIÉE et AUTONOME (hors chaîne d'héritage `Forms`, à CÔTÉ de VmForms /
   VmProvidersForm) : la retirer = supprimer ce fichier + l'action « Purger… » de
   l'en-tête de l'onglet VMs et de la carte provider de la vue Clusters (main.ts),
   sans cicatrice ailleurs.

   Elle n'arbitre RIEN : la règle (quels groupes, quelles VMs « enrichies », quels
   comptes) vit dans le module PUR `core/VmPurge`, testé en isolation ; la
   suppression est celle du Store (`removeMany` → UNE transaction, UNE révision, UN
   événement SSE, UNE entrée d'undo) ; les comptes du récapitulatif viennent du PLAN
   de cascade réel (`Store.cascadePreviewAsync`), jamais d'une estimation refaite ici.

   CORPUS PARTIEL (chantier lazy-load, cf. docs/hydratation.md § Vague 2) — DEUX
   dépendances de cette modale portent sur `applications`, chargée PARESSEUSEMENT en
   mode API, et elles se traitent différemment parce qu'elles ne posent pas la même
   question :
   - « cette VM héberge-t-elle une application ? » (critère d'ENRICHISSEMENT, par
     VM et avant toute sélection) : aucun plan de cascade ne répond à ça. La modale
     HYDRATE donc la collection à l'ouverture — patron des surfaces qui ont besoin de
     la liste complète. Sans ça, des VMs enrichies seraient proposées comme « nues »
     et purgées avec leur rattachement, sans que rien ne le signale ;
   - « que va emporter la purge ? » (PLAN) : `cascadePreviewAsync`, qui interroge le
     serveur tant que le corpus n'est pas complet (garde G5). D'où un récapitulatif
     ASYNCHRONE, mémoïsé par sélection et protégé par un jeton d'obsolescence : une
     case cochée puis décochée ne redemande rien, et une réponse devancée ne peint pas.
   Mode fichier : les deux sont des no-op par construction (tout y est hydraté).

   MODE FICHIER (principe n°15) : aucun `VmSyncClient` → la liste des providers
   configurés est INCONNUE, les groupes fusionnent en « orphelines par provider_id »
   et un bandeau le dit. Le geste reste ENTIÈREMENT disponible sans serveur : un
   document exporté avec ses orphelines se purge en local.

   MODE API dégradé : si `GET /vm/providers` échoue (503 clé absente, panne réseau),
   on ne DEVINE pas la configuration — on retombe sur le comportement « liste
   inconnue » (orphelines seules) et on affiche la raison. Proposer « toutes les VMs
   d'un provider » sur une liste qu'on n'a pas pu lire ratisserait un inventaire vivant.
   ============================================================================= */

export class VmPurgeForm {
  /** Corps re-rendu en place (chargement → contenu). */
  private panel!: HTMLElement;
  /** Bouton « Enregistrer » de la modale, re-libellé « Purger N VMs » et teinté DANGER (cf. `onReady`). */
  private saveButton: HTMLButtonElement | null = null;
  /** Groupes proposables (calculés une fois à l'ouverture, sur l'instantané du store). */
  private groups: VmPurgeGroup[] = [];
  /** Clés des groupes COCHÉS. */
  private readonly selectedKeys = new Set<string>();
  /** Les ENRICHIES sont-elles incluses ? (arbitrage V2 : NON par défaut.) */
  private includeEnriched = false;
  /** Bloc « X VMs supprimées, dont Y enrichies ; Z adresses IP détachées », rafraîchi à chaque changement. */
  private recapEl: HTMLElement | null = null;
  /** Sous-listes nominatives d'enrichies, par clé de groupe — masquées tant que le groupe n'est pas coché. */
  private readonly enrichedBlocks = new Map<string, HTMLElement>();
  /** PLANS de cascade déjà obtenus, par signature de sélection (ids triés) : cocher puis décocher un
      groupe ne redemande rien. Le contenu du document ne bouge pas pendant que la modale est ouverte
      (la purge la ferme), donc un plan reste valable pour toute sa durée de vie. */
  private readonly planCache = new Map<string, VmPurgeCascadePlan>();
  /** Jeton d'OBSOLESCENCE des demandes de plan : seule la dernière peint (deux clics rapides ne
      laissent pas la réponse la plus lente écraser la plus récente — patron du pager de listing). */
  private planToken = 0;

  private constructor(
    private readonly store: Store,
    /** Provider à PRÉ-SÉLECTIONNER (raccourci de la carte provider) — null = aucune présélection. */
    private readonly preselectProviderId: string | null,
    /** Rappelé après une purge réussie (rafraîchit le listing / la vue d'origine). */
    private readonly onDone: (() => void) | undefined,
  ) {}

  /** Ouvre la modale. `client` = null en mode FICHIER (aucun serveur à interroger).
      `providerId` pré-coche le groupe des ORPHELINES de ce provider — JAMAIS un groupe
      « provider disparu » (arbitrage V1 : ce groupe ratisse TOUTES les VMs du provider,
      il ne doit jamais être coché sans un geste explicite). */
  static open(store: Store, host: FormHost, client: VmSyncClient | null, opts: { providerId?: string | null; onDone?: () => void } = {}): void {
    const form = new VmPurgeForm(store, opts.providerId || null, opts.onDone);
    const root = document.createElement("div");
    form.panel = document.createElement("div");
    root.appendChild(form.panel);
    form.message(I18n.t("vm.purge.loading"));
    host.openModal({
      title: I18n.t("vm.purge.title"),
      subtitle: I18n.t("vm.purge.subtitle"),
      body: root, wide: true,
      saveLabel: I18n.t("vm.purge.purgeIdle"),
      onReady: ({ saveButton }) => {
        // Action DESTRUCTRICE → teinte danger (le bouton primaire de la modale devient rouge), et
        // libellé PARLANT (« Purger 12 VMs ») recalculé à chaque changement de sélection.
        form.saveButton = saveButton;
        saveButton.classList.remove("btn-primary");
        saveButton.classList.add("btn-danger");
        form.refresh();
      },
      onSave: () => form.purge(),
    });
    void form.load(client);
  }

  /* --------------------------------------------------------------------------
     CHARGEMENT
     -------------------------------------------------------------------------- */

  /** Résout la liste des providers CONFIGURÉS (mode API), construit les groupes puis rend.
      Toute indisponibilité (mode fichier, 503, réseau) mène au même repli assumé : liste INCONNUE. */
  private async load(client: VmSyncClient | null): Promise<void> {
    let configuredProviderIds: string[] | null = null;
    let degradedReason: string | null = null;
    // Les DEUX I/O de l'ouverture, menées EN PARALLÈLE (indépendantes) : la liste des providers
    // configurés, et l'hydratation d'`applications` — dont le critère d'enrichissement a besoin PAR VM
    // (cf. l'en-tête). L'hydratation est un no-op en mode fichier et sur une collection déjà complète.
    // Son échec est AVALÉ : la purge doit rester possible, quitte à ne pas savoir retenir une VM sur ce
    // critère-là ; les autres familles (notes, description, groupes, IP) restent, elles, exactes.
    const hydrated = this.store.hydrate(["applications"]).catch(() => []);
    if (client) {
      try {
        configuredProviderIds = (await client.providers()).map((p) => p.id);
      } catch (e) {
        degradedReason = VmPurgeForm.errText(e);
      }
    }
    await hydrated;
    const readers: VmPurgeReaders = {
      // Adresses IP RATTACHÉES (ipAddresses.vm_id) — le lecteur du store, injecté (le module pur ne le connaît pas).
      attachedIpCount: (vmId: string) => this.store.ipAddressesOfVm(vmId).length,
      // Applications HÉBERGÉES (applications.vm_id) — même source que la section « Applications » de la
      // fiche VM : ce que la fiche montre est exactement ce que la purge protège.
      hostedApplicationCount: (vmId: string) => this.store.applicationsOfVm(vmId).length,
    };
    this.groups = VmPurge.groups(this.store.all("vms"), configuredProviderIds, readers);
    // PRÉ-SÉLECTION du raccourci « Purger… » d'une carte provider : uniquement le groupe des ORPHELINES.
    if (this.preselectProviderId) {
      const target = this.groups.find((g) => g.kind === "orphans" && g.providerId === this.preselectProviderId);
      if (target) this.selectedKeys.add(target.key);
    }
    this.render(configuredProviderIds !== null, degradedReason);
  }

  /* --------------------------------------------------------------------------
     RENDU
     -------------------------------------------------------------------------- */

  /** Rendu complet : introduction, bandeau de repli éventuel, groupes cochables, option
      « inclure les enrichies », récapitulatif. Construit UNE fois — les changements de sélection
      ne repassent que par `refresh()` (sinon chaque clic recréerait les contrôles et volerait le focus). */
  private render(providerConfigKnown: boolean, degradedReason: string | null): void {
    this.panel.innerHTML = "";
    this.enrichedBlocks.clear();
    this.recapEl = null;

    const intro = document.createElement("div"); intro.className = "form-hint";
    intro.textContent = I18n.t("vm.purge.intro");
    this.panel.appendChild(intro);

    // Liste des providers INCONNUE : le dire explicitement (mode fichier = normal ; API = dégradé, avec la cause).
    if (!providerConfigKnown) {
      const note = document.createElement("div"); note.className = "form-hint"; note.style.color = "var(--warn)"; note.style.marginTop = "6px";
      note.textContent = degradedReason
        ? I18n.t("vm.purge.providersUnavailable", { detail: degradedReason })
        : I18n.t("vm.purge.introFile");
      this.panel.appendChild(note);
    }

    if (!this.groups.length) {
      const none = document.createElement("div"); none.className = "form-hint"; none.style.fontStyle = "italic"; none.style.marginTop = "10px";
      none.textContent = I18n.t("vm.purge.nothing");
      this.panel.appendChild(none);
      this.refresh();
      return;
    }

    this.groups.forEach((group) => this.panel.appendChild(this.groupBlock(group)));

    // Inclusion des ENRICHIES : une SEULE case globale (arbitrage V2), proposée dès qu'au moins un
    // groupe en contient. Décochée par défaut — c'est tout le sens de l'arbitrage : l'utilisateur
    // recopie ses enrichissements AVANT, la purge ne les emporte jamais par surprise.
    const enrichedTotal = this.groups.reduce((n, g) => n + g.enrichedCount, 0);
    if (enrichedTotal > 0) {
      const wrap = document.createElement("div"); wrap.style.marginTop = "14px";
      const toggle = FormControls.toggle(I18n.t("vm.purge.includeEnriched", { count: enrichedTotal }), this.includeEnriched, (v) => {
        this.includeEnriched = v;
        this.refresh();
      }, { title: I18n.t("vm.purge.includeEnrichedTitle") });
      const hint = document.createElement("div"); hint.className = "form-hint"; hint.style.marginTop = "4px";
      hint.textContent = I18n.t("vm.purge.includeEnrichedHint");
      wrap.append(toggle, hint);
      this.panel.appendChild(wrap);
    }

    const divider = document.createElement("div"); divider.className = "section-divider";
    divider.textContent = I18n.t("vm.purge.recapSection");
    this.panel.appendChild(divider);
    this.recapEl = document.createElement("div"); this.recapEl.className = "form-hint";
    this.panel.appendChild(this.recapEl);

    this.refresh();
  }

  /** Un groupe : bascule cochable (libellé + compteur) + sous-liste NOMINATIVE de ses enrichies. */
  private groupBlock(group: VmPurgeGroup): HTMLElement {
    const block = document.createElement("div"); block.style.marginTop = "12px";
    const toggle = FormControls.toggle(VmPurgeForm.groupLabel(group), this.selectedKeys.has(group.key), (v) => {
      if (v) this.selectedKeys.add(group.key); else this.selectedKeys.delete(group.key);
      this.refresh();
    }, { block: true, title: VmPurgeForm.groupTitle(group) });
    block.appendChild(toggle);

    if (group.enrichedCount > 0) {
      const enriched = document.createElement("div"); enriched.className = "form-hint"; enriched.style.marginTop = "6px"; enriched.style.paddingLeft = "12px";
      const head = document.createElement("div");
      head.textContent = I18n.t("vm.purge.enrichedTitle", { count: group.enrichedCount });
      enriched.appendChild(head);
      const list = document.createElement("ul"); list.style.margin = "4px 0 0"; list.style.paddingLeft = "18px";
      group.entries.filter((e) => e.enriched).forEach((entry) => {
        const li = document.createElement("li");
        // textContent partout : un nom de VM vient du provider (donnée non fiable) — aucun HTML injecté.
        li.textContent = entry.name + " — " + VmPurgeForm.familiesText(entry);
        list.appendChild(li);
      });
      enriched.appendChild(list);
      block.appendChild(enriched);
      this.enrichedBlocks.set(group.key, enriched);
    }
    return block;
  }

  /** Rafraîchit ce qui DÉPEND de la sélection : visibilité des sous-listes d'enrichies, récapitulatif
      (comptes dérivés du PLAN de cascade — désormais ASYNCHRONE, cf. l'en-tête), libellé et état du
      bouton de purge. La sélection, elle, est connue TOUT DE SUITE : le bouton est donc réglé sans
      attendre, et seul le nombre d'adresses IP détachées (qui vient du plan) est différé. */
  private refresh(): void {
    this.enrichedBlocks.forEach((el, key) => { el.style.display = this.selectedKeys.has(key) ? "" : "none"; });
    const selection = VmPurge.select(this.groups, this.selectedKeys, this.includeEnriched);
    this.paintSaveButton(selection);
    const token = ++this.planToken;
    void this.planFor(selection, token)
      .then((plan) => { if (token === this.planToken) this.paintRecap(selection, plan); })
      // ÉCHEC RÉEL de l'aperçu (réseau, 5xx) : on le DIT — sans quoi le récapitulatif resterait
      // indéfiniment sur « analyse en cours ». On n'affiche JAMAIS un plan de repli local à la place :
      // il sous-estimerait en silence sur corpus partiel, ce que la garde G5 existe pour empêcher. La
      // purge elle-même reste refusée tant que ses effets ne sont pas annonçables (cf. `purge`).
      .catch((e) => {
        if (token !== this.planToken || !this.recapEl) return;   // sélection devancée : la plus récente peindra
        this.recapEl.textContent = I18n.t("vm.purge.previewUnavailable", { detail: VmPurgeForm.errText(e) });
      });
  }

  /** Plan de cascade de cette sélection, MÉMOÏSÉ (aucune peinture) : le point d'accès unique au plan,
      partagé par le récapitulatif et par la confirmation finale — laquelle ne redemande donc rien quand
      la sélection n'a pas bougé. Clé = les ids TRIÉS (l'ordre de cochage ne fait pas un autre plan). */
  private async fetchPlan(selection: VmPurgeSelection): Promise<VmPurgeCascadePlan> {
    const key = selection.ids.slice().sort().join(",");
    const known = this.planCache.get(key);
    if (known) return known;
    const plan = await this.store.cascadePreviewAsync("vms", selection.ids);
    this.planCache.set(key, plan);
    return plan;
  }

  /** Plan pour le RÉCAPITULATIF : peint « en attente » tant que le plan n'est pas connu. Le JETON est
      posé par l'appelant (`refresh`), qui s'en sert aussi pour filtrer les échecs devancés — une seule
      autorité d'obsolescence, sinon les deux points de contrôle divergeraient. */
  private planFor(selection: VmPurgeSelection, token: number): Promise<VmPurgeCascadePlan> {
    const key = selection.ids.slice().sort().join(",");
    if (!this.planCache.has(key) && token === this.planToken) this.paintRecap(selection, null);   // jamais un compte d'IP provisoire en attendant le vrai
    return this.fetchPlan(selection);
  }

  /** Récapitulatif « X VMs supprimées, dont Y enrichies ; Z adresses IP détachées ». `plan` null =
      le plan est en vol : on annonce l'attente plutôt qu'un compte provisoire (qui se lirait comme définitif). */
  private paintRecap(selection: VmPurgeSelection, plan: VmPurgeCascadePlan | null): void {
    if (!this.recapEl) return;
    if (!selection.ids.length) { this.recapEl.textContent = I18n.t("vm.purge.recapNone"); return; }
    if (!plan) { this.recapEl.textContent = I18n.t("vm.purge.loading"); return; }
    const summary = VmPurge.summary(selection, plan);
    this.recapEl.textContent = I18n.t("vm.purge.recap", { vms: summary.vms, enriched: summary.enriched, ips: summary.detachedIps });
  }

  /** Libellé + état du bouton de purge — dérivés de la SEULE sélection (aucun plan requis) : le bouton
      ne doit pas rester désactivé le temps d'un aller-retour. */
  private paintSaveButton(selection: VmPurgeSelection): void {
    if (!this.saveButton) return;
    this.saveButton.textContent = selection.ids.length ? I18n.t("vm.purge.purge", { count: selection.ids.length }) : I18n.t("vm.purge.purgeIdle");
    this.saveButton.disabled = selection.ids.length === 0;
  }

  /* --------------------------------------------------------------------------
     ACTION
     -------------------------------------------------------------------------- */

  /** Confirme puis PURGE. Renvoie `false` pour garder la modale ouverte (rien à purger, annulation). */
  private async purge(): Promise<boolean> {
    const selection = VmPurge.select(this.groups, this.selectedKeys, this.includeEnriched);
    if (!selection.ids.length) { Notify.toast(I18n.t("vm.purge.recapNone"), "err"); this.refresh(); return false; }
    // Plan de cascade RÉEL pour la confirmation : servi par le MÊME mémo que le récapitulatif (aucun
    // aller-retour de plus dans le cas nominal — la sélection n'a pas bougé depuis son affichage).
    const summary = VmPurge.summary(selection, await this.fetchPlan(selection));
    // Confirmation FINALE (geste destructeur de masse) : le message reprend les comptes EXACTS.
    const ok = await Dialog.confirm({
      title: I18n.t("vm.purge.confirmTitle", { count: summary.vms }),
      message: I18n.t("vm.purge.confirmMessage", { vms: summary.vms, enriched: summary.enriched, ips: summary.detachedIps }),
      confirmLabel: I18n.t("vm.purge.confirmLabel"), danger: true,
    });
    if (!ok) { this.refresh(); return false; }   // le `finally` de la modale réactive le bouton : on lui rend son état
    // UNE transaction pour tout le lot (cf. Store.removeMany) → UNE révision, UN SSE, UN pas d'undo :
    // un « Annuler » restitue l'intégralité de la purge, adresses IP rattachées comprises.
    const purged = await this.store.removeMany("vms", selection.ids);
    Notify.toast(I18n.t("vm.purge.done", { count: purged }));
    this.onDone?.();
    return true;
  }

  /* -------------------------------------------------------------------------- */

  /** Libellé d'un groupe : nature + provider + compteur. Le groupe « provider disparu » dit
      explicitement que ses VMs sont FIGÉES (plus couvertes par aucune synchro) — c'est ce qui
      justifie qu'il propose TOUTES les VMs du provider, orphelines ou non. */
  private static groupLabel(group: VmPurgeGroup): string {
    const provider = group.providerId || I18n.t("vm.purge.providerNone");
    const count = group.entries.length;
    if (group.kind === "goneProvider") return I18n.t("vm.purge.groupGone", { provider, count });
    return group.providerConfigKnown
      ? I18n.t("vm.purge.groupOrphans", { provider, count })
      : I18n.t("vm.purge.groupOrphansUnknown", { provider, count });
  }

  /** Info-bulle d'un groupe : ce qu'il emporte réellement (nues / enrichies). */
  private static groupTitle(group: VmPurgeGroup): string {
    return I18n.t("vm.purge.groupTitle", { plain: group.plainCount, enriched: group.enrichedCount });
  }

  /** Raisons (familles d'enrichissement) d'une VM retenue, en toutes lettres et localisées. */
  private static familiesText(entry: VmPurgeEntry): string {
    const label: Record<VmEnrichmentFamily, string> = {
      notes: I18n.t("vm.purge.familyNotes"),
      description: I18n.t("vm.purge.familyDescription"),
      groups: I18n.t("vm.purge.familyGroups"),
      ips: I18n.t("vm.purge.familyIps"),
      applications: I18n.t("vm.purge.familyApplications"),
    };
    return entry.families.map((f) => label[f]).join(", ");
  }

  /** Message lisible dans le panneau (chargement / erreur). */
  private message(text: string): void {
    this.panel.innerHTML = "";
    const n = document.createElement("div"); n.className = "form-hint"; n.textContent = text;
    this.panel.appendChild(n);
  }

  /** Message d'erreur lisible : `VmSyncError` porte le code HTTP + `detail` serveur ; sinon message brut. */
  private static errText(e: unknown): string {
    if (e instanceof VmSyncError) return e.message + (e.detail ? " — " + e.detail : "");
    return e instanceof Error ? e.message : String(e);
  }
}
