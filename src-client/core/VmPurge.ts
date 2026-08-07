/* ============================================================================
   PURGE DE MASSE DES VMs — logique PURE (aucun DOM, aucun réseau, aucun store).

   POURQUOI CE MODULE EXISTE. Une bascule d'identité de réconciliation (le nom de
   cluster préfixe l'`ext_id` — cf. docs/vm-proxmox.md « Dépannage — VMs en DOUBLE »)
   peut laisser DES DIZAINES de VMs orphelines d'un coup ; et supprimer un provider
   FIGE ses VMs, qui ne deviennent JAMAIS orphelines puisque plus aucune passe ne
   couvre leur `provider_id`. Dans les deux cas la purge fiche par fiche (bouton
   « Supprimer cette VM orpheline… » de `DetailForms.vmDetail`) est inutilisable :
   il faut un geste de MASSE, et donc une règle explicite de ce qui est proposé.

   Ce module ne fait QUE cette règle : construire les GROUPES proposables, décider
   ce qu'est une VM « ENRICHIE » et dériver les comptes du récapitulatif. Il ne
   supprime rien, n'ouvre aucune modale et ne connaît ni `Store` ni `VmSyncClient` :
   la liste des providers CONFIGURÉS et le comptage des adresses IP rattachées lui
   sont INJECTÉS (principe n°2). Le DOM vit dans `views/forms/VmPurgeForm`, la
   suppression dans `Store.removeMany`.

   DEUX GROUPES (arbitrage utilisateur V1, cf. cadrage 2026-08-07) :
     1. `orphans`      — les VMs `orphan: true` d'un provider, groupées par `provider_id` ;
     2. `goneProvider` — TOUTES les VMs d'un `provider_id` présent dans le document mais
        ABSENT de la configuration serveur (orphelines ou non) : ce sont précisément les
        VMs « figées sans pastille », que rien d'autre ne permet de retrouver.

   MODE FICHIER (principe n°15) : il n'y a PAS de serveur, donc pas de liste de
   providers configurés → `configuredProviderIds` vaut `null`. On ne peut alors PAS
   distinguer « provider configuré » de « provider disparu » ; les deux groupes
   FUSIONNENT en un seul par `provider_id`, restreint aux ORPHELINES — proposer
   « toutes les VMs d'un provider » sans savoir s'il a disparu ratisserait un
   inventaire parfaitement vivant. Les groupes portent `providerConfigKnown: false`
   pour que l'UI le DISE au lieu de laisser croire à une certitude qu'elle n'a pas.

   ENRICHIES (arbitrage utilisateur V2) : une VM porteuse d'un travail LOCAL que la
   purge détruirait sans retour (notes, description, appartenance à un groupe, ou au
   moins une adresse IP rattachée) est listée NOMINATIVEMENT et DÉCOCHÉE par défaut.
   Le critère est déclaré par FAMILLE (`VmEnrichmentFamily`) : chacune se teste
   séparément, et l'UI peut dire POURQUOI une VM est retenue.
   ============================================================================ */

/** Famille d'enrichissement LOCAL qui « retient » une VM (une seule suffit).
    Ordre STABLE (celui de `FAMILY_ORDER`) : c'est aussi l'ordre d'affichage. */
export type VmEnrichmentFamily = "notes" | "description" | "groups" | "ips";

/** Nature d'un groupe proposable. */
export type VmPurgeGroupKind = "orphans" | "goneProvider";

/** Une VM telle que la purge la LIT — lecture volontairement TOLÉRANTE (champs optionnels) :
    ce module est alimenté par le cache du store, mais aussi par des fixtures de test. */
export interface VmPurgeVm {
  id: string;
  name?: string;
  provider_id?: string;
  orphan?: boolean;
  /** Enrichissement local : note libre. */
  notes?: string;
  /** Enrichissement local : description (champ LOCAL de la spec `vms`, distinct de `description_src`,
      qui vient du provider et n'est donc PAS un travail de l'utilisateur). */
  description?: string;
  group_id?: string | null;
  group_ids?: string[];
}

/** Capacités INJECTÉES (le module ne connaît pas le store). */
export interface VmPurgeReaders {
  /** Nombre d'adresses IP RATTACHÉES à cette VM (`ipAddresses.vm_id`) — `Store.ipAddressesOfVm().length`
      côté application. C'est un enrichissement : l'utilisateur a rapproché l'IPAM à la main. */
  attachedIpCount(vmId: string): number;
}

/** Une VM proposée dans un groupe. */
export interface VmPurgeEntry {
  id: string;
  /** Nom d'affichage (jamais vide : repli sur l'id — une ligne anonyme serait inutilisable). */
  name: string;
  /** Familles d'enrichissement constatées (vide = VM « nue »). */
  families: VmEnrichmentFamily[];
  /** Raccourci de `families.length > 0` — l'unité de décision de l'UI (cochée / décochée par défaut). */
  enriched: boolean;
}

/** Un groupe proposable, avec ses compteurs. */
export interface VmPurgeGroup {
  /** Clé STABLE d'identité (nature + provider) — c'est elle que l'UI coche/décoche. */
  key: string;
  kind: VmPurgeGroupKind;
  /** `provider_id` du groupe ("" = VMs sans provider connu). */
  providerId: string;
  /** false = liste des providers configurés INCONNUE (mode fichier) : l'UI ne doit pas
      annoncer « provider configuré », seulement « orphelines de ce provider_id ». */
  providerConfigKnown: boolean;
  /** VMs du groupe, triées par nom (puis id) — ordre d'affichage. */
  entries: VmPurgeEntry[];
  /** Nombre de VMs enrichies du groupe (décochées par défaut). */
  enrichedCount: number;
  /** Nombre de VMs « nues » du groupe (celles que le groupe coché supprime). */
  plainCount: number;
}

/** Sélection résolue (ids à supprimer), séparant les enrichies pour le récapitulatif. */
export interface VmPurgeSelection {
  /** TOUS les ids retenus (enrichies incluses si l'option l'exige). */
  ids: string[];
  /** Sous-ensemble ENRICHI de `ids` (jamais peuplé si l'inclusion est refusée). */
  enrichedIds: string[];
}

/** Comptes EXACTS du récapitulatif — les IP viennent du PLAN de cascade, jamais d'une estimation. */
export interface VmPurgeSummary {
  vms: number;
  enriched: number;
  detachedIps: number;
}

/** Forme MINIMALE du plan de cascade lue ici (structurelle : `CascadePlan` de `src-shared/Cascade`
    la satisfait). Typer structurellement évite de faire dépendre ce module du code partagé pour
    trois champs, et permet de le tester sans fabriquer un plan complet. */
export interface VmPurgeCascadePlan {
  detaches: ReadonlyArray<{ c: string; id: string; key: string }>;
}

export class VmPurge {
  /** Familles d'enrichissement LOCAL constatées sur une VM, dans l'ordre canonique
      (`VM_ENRICHMENT_FAMILIES`, en bas de fichier — l'UI affiche les raisons dans cet ordre).
      Chaque famille est indépendante — une seule suffit à rendre la VM « enrichie ».
      ⚠ `description_src` (texte venu du provider) n'en fait PAS partie : ce n'est pas du travail
      utilisateur, et le compter retiendrait la quasi-totalité d'un inventaire Proxmox. */
  static enrichmentFamilies(vm: VmPurgeVm, readers: VmPurgeReaders): VmEnrichmentFamily[] {
    const out: VmEnrichmentFamily[] = [];
    if (VmPurge.filled(vm.notes)) out.push("notes");
    if (VmPurge.filled(vm.description)) out.push("description");
    // GROUPES : le primaire OU la liste (un document legacy peut ne porter que `group_id`, la
    // migration ne semant `group_ids` qu'à la relecture du modèle — on lit donc les deux).
    const groupIds = Array.isArray(vm.group_ids) ? vm.group_ids.filter((g) => typeof g === "string" && g !== "") : [];
    if ((typeof vm.group_id === "string" && vm.group_id !== "") || groupIds.length > 0) out.push("groups");
    if (readers.attachedIpCount(vm.id) > 0) out.push("ips");
    return out;
  }

  /** Cette VM porte-t-elle un enrichissement LOCAL que la purge détruirait sans retour ? */
  static isEnriched(vm: VmPurgeVm, readers: VmPurgeReaders): boolean {
    return VmPurge.enrichmentFamilies(vm, readers).length > 0;
  }

  /** Construit les GROUPES proposables (groupes vides omis), dans l'ordre d'affichage :
      d'abord les orphelines (par `provider_id` croissant), puis les providers DISPARUS.

      `configuredProviderIds` : ids des providers configurés côté serveur (mode API) — `null` =
      liste INCONNUE (mode fichier) : voir l'en-tête, seules les orphelines sont proposées.

      ⚠ Une VM sans `provider_id` (chaîne vide) n'est JAMAIS rangée en « provider disparu » : il n'y
      a pas de provider à avoir disparu. Si elle est orpheline, elle rejoint un groupe `orphans` de
      provider "" — l'UI le libelle « provider inconnu ». */
  static groups(vms: ReadonlyArray<VmPurgeVm>, configuredProviderIds: ReadonlyArray<string> | null, readers: VmPurgeReaders): VmPurgeGroup[] {
    const configured = configuredProviderIds ? new Set(configuredProviderIds) : null;
    const byProvider = new Map<string, VmPurgeVm[]>();
    for (const vm of vms || []) {
      if (!vm || !vm.id) continue;
      const providerId = typeof vm.provider_id === "string" ? vm.provider_id : "";
      const bucket = byProvider.get(providerId);
      if (bucket) bucket.push(vm); else byProvider.set(providerId, [vm]);
    }
    const orphanGroups: VmPurgeGroup[] = [];
    const goneGroups: VmPurgeGroup[] = [];
    for (const providerId of [...byProvider.keys()].sort()) {
      const bucket = byProvider.get(providerId)!;
      const gone = !!configured && providerId !== "" && !configured.has(providerId);
      // Provider DISPARU → TOUTES ses VMs (le cas « figé sans pastille ») ; sinon → ses ORPHELINES seules.
      const kept = gone ? bucket : bucket.filter((vm) => vm.orphan === true);
      if (!kept.length) continue;
      const group = VmPurge.buildGroup(gone ? "goneProvider" : "orphans", providerId, configured !== null, kept, readers);
      (gone ? goneGroups : orphanGroups).push(group);
    }
    return [...orphanGroups, ...goneGroups];
  }

  /** Y a-t-il QUELQUE CHOSE à purger ? Prédicat BON MARCHÉ (aucun comptage d'IP, aucun tri) destiné à
      la VISIBILITÉ du bouton « Purger… », réévaluée à chaque rafraîchissement de l'en-tête d'onglet.
      Équivaut STRICTEMENT à `groups(...).length > 0` (invariant testé) — les deux règles doivent
      rester d'accord, sinon le bouton apparaît sur une modale vide (ou l'inverse). */
  static hasPurgeable(vms: ReadonlyArray<VmPurgeVm>, configuredProviderIds: ReadonlyArray<string> | null): boolean {
    const configured = configuredProviderIds ? new Set(configuredProviderIds) : null;
    for (const vm of vms || []) {
      if (!vm || !vm.id) continue;
      if (vm.orphan === true) return true;
      const providerId = typeof vm.provider_id === "string" ? vm.provider_id : "";
      if (configured && providerId !== "" && !configured.has(providerId)) return true;
    }
    return false;
  }

  /** Résout la sélection : les groupes COCHÉS, moins les enrichies tant qu'elles ne sont pas
      explicitement incluses. Dédoublonne par id (défensif : un id ne peut appartenir qu'à un groupe
      par construction, mais la sélection est pilotée par l'UI). */
  static select(groups: ReadonlyArray<VmPurgeGroup>, selectedKeys: ReadonlySet<string>, includeEnriched: boolean): VmPurgeSelection {
    const ids: string[] = [];
    const enrichedIds: string[] = [];
    const seen = new Set<string>();
    for (const group of groups || []) {
      if (!selectedKeys.has(group.key)) continue;
      for (const entry of group.entries) {
        if (entry.enriched && !includeEnriched) continue;
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        ids.push(entry.id);
        if (entry.enriched) enrichedIds.push(entry.id);
      }
    }
    return { ids, enrichedIds };
  }

  /** Nombre d'adresses IP que la purge DÉTACHERA — lu sur le PLAN DE CASCADE, jamais estimé.
      On compte les `ipAddresses` DISTINCTES touchées par un détachement : la règle `vms` de
      `Cascade.SPEC` ne fait que remettre `vm_id` à null (l'adresse SURVIT, elle redevient « non
      attribuée »), mais compter la collection plutôt que la clé reste juste si une règle future
      détachait un second champ de la même adresse. */
  static detachedIpCount(plan: VmPurgeCascadePlan | null | undefined): number {
    const ids = new Set<string>();
    for (const detach of (plan && plan.detaches) || []) if (detach && detach.c === "ipAddresses") ids.add(detach.id);
    return ids.size;
  }

  /** Comptes EXACTS du récapitulatif (« X VMs supprimées, dont Y enrichies ; Z adresses IP détachées »). */
  static summary(selection: VmPurgeSelection, plan: VmPurgeCascadePlan | null | undefined): VmPurgeSummary {
    return { vms: selection.ids.length, enriched: selection.enrichedIds.length, detachedIps: VmPurge.detachedIpCount(plan) };
  }

  /* -------------------------------------------------------------------------- */

  /** Une chaîne non vide une fois trimée (un champ rempli d'espaces n'est PAS un enrichissement). */
  private static filled(value: unknown): boolean {
    return typeof value === "string" && value.trim() !== "";
  }

  /** Assemble un groupe : entrées triées par nom (repli sur l'id) + compteurs dérivés. */
  private static buildGroup(kind: VmPurgeGroupKind, providerId: string, providerConfigKnown: boolean, vms: ReadonlyArray<VmPurgeVm>, readers: VmPurgeReaders): VmPurgeGroup {
    const entries: VmPurgeEntry[] = vms.map((vm) => {
      const families = VmPurge.enrichmentFamilies(vm, readers);
      return { id: vm.id, name: VmPurge.filled(vm.name) ? vm.name!.trim() : vm.id, families, enriched: families.length > 0 };
    });
    // Tri par nom puis id : deux VMs homonymes (le cas EXACT du dédoublement d'identité) restent
    // dans un ordre stable d'un rendu à l'autre, sinon la liste « danse » entre deux ouvertures.
    entries.sort((a, b) => (a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
    const enrichedCount = entries.reduce((n, e) => n + (e.enriched ? 1 : 0), 0);
    return {
      key: kind + ":" + providerId,
      kind, providerId, providerConfigKnown, entries,
      enrichedCount, plainCount: entries.length - enrichedCount,
    };
  }
}

/** Ordre canonique des familles, exposé pour l'UI et les tests (donnée → simple export, principe n°2). */
export const VM_ENRICHMENT_FAMILIES: VmEnrichmentFamily[] = ["notes", "description", "groups", "ips"];
