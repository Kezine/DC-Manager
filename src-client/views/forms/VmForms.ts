import type { Store } from "../../store";
import { Icons } from "../../ui/Icons";
import { FormControls } from "../../ui/FormControls";
import { ChipsInput, ChipItem } from "../../ui/ChipsInput";
import { FieldFacet } from "../../core/FieldFacet";
import { Notify } from "../../ui/Notify";
import { Html } from "../../core/Html";
import { VmNetMapping } from "../../core/VmNetMapping";
import type { VmNetPair } from "../../core/VmNetMapping";
import { VmSyncClient, VmSyncError } from "./VmSyncClient";
import type { VmProviderStatus } from "./VmSyncClient";
import type { FormHost } from "./shared";
import { I18n } from "../../i18n/I18n";

/** UI de la table de mapping « (bridge, vlan_tag) → réseau logique » des vNIC (feature VM AMOVIBLE).

    Classe DÉDIÉE et AUTONOME (hors chaîne d'héritage `Forms`) : la retirer = supprimer ce fichier + le
    branchement `extraActions` de l'onglet VMs, sans cicatrice dans les autres formulaires (exigence
    transverse « feature amovible » du cadrage). Toute la logique de résolution/normalisation vit dans le
    module PUR `VmNetMapping` (testable en isolation) ; ici, uniquement le DOM et l'accès à la méta du store
    (lecture tolérante + `persistMeta`, EXACTEMENT le mécanisme de `meta.graphFrames`). */
export class VmForms {
  /** État d'une LIGNE d'édition : chaînes brutes des `<input>` (le `tag` reste une chaîne — « » = sans tag).
      La conversion en entrées valides (bridge/tag entier|null/network_id) est faite par
      `VmNetMapping.normalize` au moment de l'enregistrement, pas ligne par ligne. */
  private static rowState(bridge: string, tag: string, networkId: string): { bridge: string; tag: string; network_id: string } {
    return { bridge, tag, network_id: networkId };
  }

  /** Modale « Réseaux virtuels » : édite la table de mapping persistée dans `store.meta`. */
  static netMapping(store: Store, host: FormHost, onSaved?: () => void): void {
    // Réseaux logiques triés par nom — le sélecteur de chaque ligne y pioche. (La collection `networks`
    // est libellée « Réseaux logiques » dans l'app : data ET power ; on n'exclut donc rien a priori.)
    const networks = store.all("networks").slice().sort((a: any, b: any) => (a.label || "").localeCompare(b.label || ""));
    const netColor = (id: string): string | null => { const n: any = id && store.get("networks", id); return n ? (n.color || null) : null; };
    const netOptions = [{ value: "", label: I18n.t("vm.netMap.notConnected") }].concat(
      networks.map((n: any) => ({ value: n.id, label: n.label || I18n.t("lists.ph.network") })));

    // ÉTAT LOCAL = source de vérité des lignes (les `<input>` y réécrivent en direct via `oninput`) :
    // reconstruire la table (ajout / suppression) ne perd donc jamais une saisie en cours.
    const rows = VmNetMapping.read(store.meta).map((e) =>
      VmForms.rowState(e.bridge, e.vlan_tag === null ? "" : String(e.vlan_tag), e.network_id));

    const root = document.createElement("div");
    const intro = document.createElement("div"); intro.className = "form-hint";
    intro.textContent = I18n.t("vm.netMap.intro");
    root.appendChild(intro);

    const tableWrap = document.createElement("div");
    const unmappedWrap = document.createElement("div"); unmappedWrap.style.marginTop = "10px";

    // Entrées ACTUELLES (lignes normalisées) — recalculées pour la section « non mappés » à chaque changement.
    const currentEntries = () => VmNetMapping.normalize(rows.map((r) => ({ bridge: r.bridge, vlan_tag: r.tag, network_id: r.network_id })));

    const renderUnmapped = (): void => {
      unmappedWrap.innerHTML = "";
      const pairs: VmNetPair[] = VmNetMapping.unmappedPairs(currentEntries(), store.all("vms"));
      const title = document.createElement("div"); title.className = "section-divider";
      title.textContent = I18n.t("vm.netMap.unmappedTitle", { count: pairs.length });
      unmappedWrap.appendChild(title);
      if (!pairs.length) {
        const none = document.createElement("div"); none.className = "form-hint";
        none.textContent = I18n.t("vm.netMap.allMapped");
        unmappedWrap.appendChild(none);
        return;
      }
      const list = document.createElement("div"); list.style.cssText = "display:flex;flex-wrap:wrap;gap:6px";
      pairs.forEach((p) => {
        const chip = document.createElement("button"); chip.type = "button"; chip.className = "btn btn-ghost btn-sm";
        chip.title = I18n.t("vm.netMap.chipAddTitle");
        chip.innerHTML = "+ " + Html.escape(p.bridge) + (p.vlan_tag === null ? " · <em>" + Html.escape(I18n.t("vm.netMap.noTag")) + "</em>" : " · " + Html.escape(I18n.t("vm.netMap.tag", { tag: p.vlan_tag })));
        chip.onclick = () => addRow(p.bridge, p.vlan_tag === null ? "" : String(p.vlan_tag), "", true);
        list.appendChild(chip);
      });
      unmappedWrap.appendChild(list);
    };

    const renderTable = (): void => {
      tableWrap.innerHTML = "";
      if (!rows.length) {
        const empty = document.createElement("div"); empty.className = "form-hint"; empty.style.fontStyle = "italic";
        empty.textContent = I18n.t("vm.netMap.tableEmpty");
        tableWrap.appendChild(empty);
      }
      rows.forEach((row, i) => {
        const line = document.createElement("div"); line.className = "form-row"; line.style.alignItems = "flex-end";

        const bridgeI = FormControls.text(row.bridge, I18n.t("vm.netMap.bridgePlaceholder"));
        bridgeI.oninput = () => { row.bridge = bridgeI.value; };
        bridgeI.onchange = () => renderUnmapped();

        const tagI = FormControls.number(row.tag, { min: 0, step: 1, placeholder: I18n.t("vm.netMap.noTag") });
        tagI.oninput = () => { row.tag = tagI.value; };
        tagI.onchange = () => renderUnmapped();

        // Sélecteur de réseau + pastille de couleur (reflète le réseau choisi, rafraîchie au changement).
        const netSel = FormControls.select(netOptions, row.network_id); netSel.style.flex = "1 1 auto";
        const dot = document.createElement("span"); dot.className = "swatch-dot";
        const paintDot = () => { const c = netColor(netSel.value); dot.style.background = c || "transparent"; dot.style.visibility = c ? "visible" : "hidden"; };
        paintDot();
        netSel.onchange = () => { row.network_id = netSel.value; paintDot(); };
        const netCell = document.createElement("div"); netCell.style.cssText = "display:flex;align-items:center;gap:6px";
        netCell.append(dot, netSel);

        const del = document.createElement("button"); del.type = "button"; del.className = "btn btn-ghost btn-sm";
        del.innerHTML = Icons.CLOSE; del.title = I18n.t("vm.netMap.rowDelete");
        del.onclick = () => { rows.splice(i, 1); renderTable(); renderUnmapped(); };
        const delWrap = document.createElement("div"); delWrap.className = "form-field"; delWrap.style.flex = "0 0 auto";
        const spacer = document.createElement("label"); spacer.innerHTML = "&nbsp;";   // aligne le bouton sur le bas des champs
        delWrap.append(spacer, del);

        line.append(
          FormControls.fieldRow(I18n.t("vm.netMap.colBridge"), bridgeI),
          FormControls.fieldRow(I18n.t("vm.netMap.colTag"), tagI),
          FormControls.fieldRow(I18n.t("vm.netMap.colNetwork"), netCell),
          delWrap,
        );
        tableWrap.appendChild(line);
      });
    };

    const addRow = (bridge = "", tag = "", networkId = "", focusNet = false): void => {
      rows.push(VmForms.rowState(bridge, tag, networkId));
      renderTable(); renderUnmapped();
      if (focusNet) { const sels = tableWrap.querySelectorAll("select"); (sels[sels.length - 1] as HTMLSelectElement | undefined)?.focus(); }
    };

    root.appendChild(tableWrap);
    const addBtn = document.createElement("button"); addBtn.type = "button"; addBtn.className = "btn btn-ghost btn-sm";
    addBtn.textContent = I18n.t("vm.netMap.addRow"); addBtn.style.marginTop = "8px"; addBtn.onclick = () => addRow();
    root.appendChild(addBtn);
    if (!networks.length) {
      const warn = document.createElement("div"); warn.className = "form-hint"; warn.style.color = "var(--warn)"; warn.style.marginTop = "6px";
      warn.textContent = I18n.t("vm.netMap.noNetworksWarn");
      root.appendChild(warn);
    }
    root.appendChild(unmappedWrap);
    renderTable(); renderUnmapped();

    host.openModal({
      title: I18n.t("vm.netMap.title"),
      subtitle: I18n.t("vm.netMap.subtitle"),
      body: root,
      wide: true,
      onSave: async () => {
        const normalized = VmNetMapping.normalize(rows.map((r) => ({ bridge: r.bridge, vlan_tag: r.tag, network_id: r.network_id })));
        store.meta[VmNetMapping.META_KEY] = normalized;   // même chemin que meta.graphFrames…
        await store.persistMeta();                        // …persistance (fichier ET API) + SSE méta pour les autres clients
        host.setDirty?.(true);
        Notify.toast(I18n.t("vm.netMap.saved"));
        onSaved?.();
        return true;
      },
    });
  }

  /** Formulaire d'ÉDITION d'une VM — n'expose QUE les enrichissements LOCAUX réellement éditables : notes +
      groupes (frontière source/locaux, cf. src-shared/VmSync). L'HÔTE hébergeur (`host_equipment_id`) est un
      champ DÉRIVÉ, re-résolu à chaque synchro depuis `host_node` (cf. docs/vm-proxmox.md « Champ dérivé ») → non
      éditable ici ; la description LOCALE a été retirée (les `notes` suffisent). Les champs SOURCE (nom, type,
      statut, hôte source, vNIC, IPs, tags…) sont alimentés par la synchro et ne sont JAMAIS éditables ici.
      Vit dans cette classe DÉDIÉE (feature amovible) ; ouvert depuis la fiche `DetailForms.vmDetail`.
      À l'enregistrement, le payload ne contient QUE notes + groupes : `store.update` FUSIONNE le patch dans
      l'existant (cf. Store.update → `_applyPatch`), donc les champs source ET dérivés restent INTACTS. */
  static edit(store: Store, host: FormHost, id: string, onSaved?: () => void): void {
    const vm: any = store.get("vms", id);
    if (!vm) { Notify.toast(I18n.t("vm.edit.notFound"), "err"); return; }
    const root = document.createElement("div");

    // Bandeau explicite : SEULS les enrichissements locaux sont modifiables ici (l'hôte est dérivé par la synchro).
    const note = document.createElement("div"); note.className = "form-hint";
    note.textContent = I18n.t("vm.edit.localOnly");
    root.appendChild(note);

    // GROUPES : primaire (single) + secondaires (multi, recherche + pastilles) — PARITÉ STRICTE avec le
    // formulaire d'équipement (EquipmentForms.equipment) : mêmes options triées, même ChipsInput, même
    // invariant « primaire ∈ group_ids » garanti par construction du payload (groupIds inclut toujours le primaire).
    const groupsSorted = (): any[] => store.all("groups").slice().sort((a: any, b: any) => (a.label || "").localeCompare(b.label || ""));
    const grpOpts = [{ value: "", label: I18n.t("forms.opt.none") }].concat(groupsSorted().map((g: any) => ({ value: g.id, label: g.label || I18n.t("lists.ph.noLabel") })));
    const groupI = FormControls.select(grpOpts, vm.group_id || "");
    root.appendChild(FormControls.fieldRow(I18n.t("vm.edit.groupPrimary"), groupI, I18n.t("vm.edit.groupPrimaryHint")));
    const initSecondary: string[] = (Array.isArray(vm.group_ids) ? vm.group_ids : []).filter((gid: string) => gid !== (vm.group_id || null));
    const groupItems = (): ChipItem[] => groupsSorted().filter((g: any) => g.id !== groupI.value).map((g: any) => ({ id: g.id, label: g.label || I18n.t("lists.ph.noLabel"), color: g.color }));
    const secondaryGroups = ChipsInput.build({
      items: groupItems, value: initSecondary, placeholder: I18n.t("vm.edit.groupSecondaryPlaceholder"),
      getLimit: () => host.autocompleteLimit ? host.autocompleteLimit() : FieldFacet.MAX_RESULTS_DEFAULT,
    });
    root.appendChild(FormControls.fieldRow(I18n.t("vm.edit.groupSecondary"), secondaryGroups.element, I18n.t("vm.edit.groupSecondaryHint")));
    // choisir le primaire le retire des secondaires (un groupe ne peut être primaire ET secondaire).
    groupI.addEventListener("change", () => { secondaryGroups.setValue(secondaryGroups.getValue().filter((gid) => gid !== groupI.value)); secondaryGroups.refresh(); });

    // Notes : SEUL champ texte LOCAL conservé (la description locale a été retirée — les notes suffisent).
    const notesI = FormControls.textArea(vm.notes || "");
    root.appendChild(FormControls.fieldRow(I18n.t("vm.edit.notes"), notesI, I18n.t("vm.edit.notesHint")));

    host.openModal({
      title: I18n.t("vm.edit.title"),
      subtitle: Html.escape(vm.name || ""),
      body: root, wide: true,
      onSave: async () => {
        const primaryGroup = groupI.value || null;
        const secondary = secondaryGroups.getValue().filter((gid) => gid && gid !== primaryGroup);
        // group_ids = primaire + secondaires (dédupliqués), primaire en tête → invariant « primaire ∈ group_ids » respecté.
        const groupIds = [...new Set([...(primaryGroup ? [primaryGroup] : []), ...secondary])];
        // PAYLOAD = notes + groupes SEULEMENT ; les champs source ET l'hôte dérivé ne figurent pas → non écrasés
        // (fusion par store.update : un champ absent du patch reste intact).
        const payload = {
          group_id: primaryGroup, group_ids: groupIds,
          notes: notesI.value.trim(),
        };
        const ok = await store.update("vms", id, payload);
        if (!ok) { Notify.toast(I18n.t("vm.edit.saveRefused"), "err"); return false; }   // validation partagée → modale conservée
        host.setDirty?.(true); Notify.toast(I18n.t("vm.edit.saved")); onSaved?.(); return true;
      },
    });
    setTimeout(() => groupI.focus(), 30);   // 1er champ éditable restant (l'hôte hébergeur n'est plus dans le formulaire)
  }

  /* ============================================================================
     SYNCHRONISATION (mode API uniquement) — bouton « Synchroniser » + « Statut de
     synchro… » de la barre d'outils de l'onglet VMs. Câblés depuis main.ts derrière
     la garde REST_MODE (masqués en mode fichier). Le RECHARGEMENT de la collection
     `vms` n'est PAS géré ici : après une synchro qui écrit, le serveur émet son
     événement SSE (origin « vm-sync ») → tous les clients rechargent en granulaire.
     ============================================================================ */

  /** Lance une synchro de TOUS les providers du document et notifie le résultat PAR provider.
      `btn` = le bouton de la barre d'outils : désactivé + libellé « Synchronisation… » le temps
      de l'appel (retour à l'état initial en `finally`, même en cas d'erreur). `onDone` (optionnel)
      est appelé après une passe ABOUTIE (≥ 1 provider) — le sous-onglet Clusters s'en sert pour se
      rafraîchir, l'état du cluster vivant en mémoire serveur (sans push SSE). */
  static async sync(client: VmSyncClient, btn: HTMLButtonElement, onDone?: () => void): Promise<void> {
    const originalLabel = btn.textContent || I18n.t("vm.sync.syncLabel");
    btn.disabled = true;
    btn.textContent = I18n.t("vm.sync.syncing");
    try {
      const providers = await client.sync();
      if (!providers.length) {
        Notify.toast(I18n.t("vm.common.noProvider"));
        return;
      }
      // Un toast PAR provider : succès = résumé des compteurs (message serveur) ; échec = message d'erreur.
      providers.forEach((p) => Notify.toast(VmForms.providerLine(p) + " : " + p.message, p.ok ? "ok" : "err"));
      onDone?.();   // état de synchro/cluster mis à jour côté serveur → laisser l'appelant retirer (sous-onglet Clusters)
    } catch (e) {
      // 404 (document inconnu), 503 (config providers invalide + detail), panne réseau → toast d'erreur détaillé.
      Notify.toast(I18n.t("vm.sync.syncImpossible", { detail: VmForms.errText(e) }), "err");
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  /* -------------------------------------------------------------------------- */

  /** Ligne d'identité d'un provider pour un toast : « id (kind) ». */
  private static providerLine(p: VmProviderStatus): string {
    return p.provider_id + " (" + p.kind + ")";
  }

  /** Message d'erreur lisible d'un appel VM : `VmSyncError` porte code HTTP + `detail` serveur
      (503 config invalide) ; toute autre erreur (panne réseau…) remonte son `message` brut. */
  private static errText(e: unknown): string {
    if (e instanceof VmSyncError) return e.message + (e.detail ? " — " + e.detail : "");
    return e instanceof Error ? e.message : String(e);
  }
}
