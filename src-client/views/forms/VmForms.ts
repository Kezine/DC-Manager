import type { Store } from "../../store";
import { Icons } from "../../ui/Icons";
import { IconButton } from "../../ui/IconButton";
import { FormControls } from "../../ui/FormControls";
import { ChipsInput, ChipItem } from "../../ui/ChipsInput";
import { FieldFacet } from "../../core/FieldFacet";
import { GroupTypes } from "../../domain/GroupTypes";
import { Notify } from "../../ui/Notify";
import { Html } from "../../core/Html";
import { VmNetMapping } from "../../core/VmNetMapping";
import type { VmNetPair } from "../../core/VmNetMapping";
import { VmSyncClient, VmSyncError } from "./VmSyncClient";
import type { VmProviderStatus } from "./VmSyncClient";
import { FormUi } from "./shared";
import type { FormHost } from "./shared";
import { VmSync } from "../../../src-shared/VmSync";
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

    // GROUPES : primaire (single) + secondaires (multi, recherche + pastilles) — bloc FACTORISÉ, PARTAGÉ avec
    // le formulaire manuel `manual` (principe n°3 : une SEULE définition, pas de recopie). Le comportement est
    // identique à celui qu'`edit` portait en ligne (parité EquipmentForms, invariant « primaire ∈ group_ids »).
    const groups = VmForms.appendGroupBlock(store, host, root, vm);

    // Notes : SEUL champ texte LOCAL conservé (la description locale a été retirée — les notes suffisent).
    const notesI = FormControls.textArea(vm.notes || "");
    root.appendChild(FormControls.fieldRow(I18n.t("vm.edit.notes"), notesI, I18n.t("vm.edit.notesHint")));

    host.openModal({
      title: I18n.t("vm.edit.title"),
      subtitle: Html.escape(vm.name || ""),
      body: root, wide: true,
      onSave: async () => {
        // PAYLOAD = notes + groupes SEULEMENT ; les champs source ET l'hôte dérivé ne figurent pas → non écrasés
        // (fusion par store.update : un champ absent du patch reste intact).
        const payload = {
          ...groups.collect(),   // { group_id, group_ids } — primaire en tête, invariant respecté par construction
          notes: notesI.value.trim(),
        };
        const ok = await store.update("vms", id, payload);
        if (!ok) { Notify.toast(I18n.t("vm.edit.saveRefused"), "err"); return false; }   // validation partagée → modale conservée
        host.setDirty?.(true); Notify.toast(I18n.t("vm.edit.saved")); onSaved?.(); return true;
      },
    });
    setTimeout(() => groups.primary.focus(), 30);   // 1er champ éditable restant (l'hôte hébergeur n'est plus dans le formulaire)
  }

  /** Bloc GROUPES (primaire + secondaires) d'un formulaire de VM, FACTORISÉ entre `edit` (enrichissements d'une
      VM synchronisée) et `manual` (VM saisie à la main) — principe n°3 : la logique était recopiée à l'identique.
      Appende DEUX rangées à `root` : le select du groupe PRIMAIRE puis le `ChipsInput` des groupes SECONDAIRES
      (recherche + pastilles, création à la volée, exclusion mutuelle primaire/secondaire). PARITÉ STRICTE avec
      `EquipmentForms.equipment` : mêmes options triées, même invariant « primaire ∈ group_ids » garanti par la
      construction du payload (le primaire est toujours en tête de `group_ids`).
      Rend `primary` (le select, pour le focus initial) et `collect()` (l'état → { group_id, group_ids }).
      `vm` peut être `null` (création manuelle) : aucune valeur initiale. */
  private static appendGroupBlock(store: Store, host: FormHost, root: HTMLElement, vm: any): { primary: HTMLSelectElement; collect: () => { group_id: string | null; group_ids: string[] } } {
    const initialPrimary: string = (vm && vm.group_id) || "";
    const groupsSorted = (): any[] => store.all("groups").slice().sort((a: any, b: any) => (a.label || "").localeCompare(b.label || ""));
    const grpOpts = [{ value: "", label: I18n.t("forms.opt.none") }].concat(groupsSorted().map((g: any) => ({ value: g.id, label: g.label || I18n.t("lists.ph.noLabel") })));
    const groupI = FormControls.select(grpOpts, initialPrimary);
    root.appendChild(FormControls.fieldRow(I18n.t("vm.edit.groupPrimary"), groupI, I18n.t("vm.edit.groupPrimaryHint")));
    const initSecondary: string[] = (Array.isArray(vm && vm.group_ids) ? vm.group_ids : []).filter((gid: string) => gid !== (initialPrimary || null));
    const groupItems = (): ChipItem[] => groupsSorted().filter((g: any) => g.id !== groupI.value).map((g: any) => ({ id: g.id, label: g.label || I18n.t("lists.ph.noLabel"), color: g.color }));
    const secondaryGroups = ChipsInput.build({
      items: groupItems, value: initSecondary, placeholder: I18n.t("vm.edit.groupSecondaryPlaceholder"),
      getLimit: () => host.autocompleteLimit ? host.autocompleteLimit() : FieldFacet.MAX_RESULTS_DEFAULT,
      allowCreate: true,
      // Création de groupe À LA VOLÉE (Entrée) — PARITÉ STRICTE avec EquipmentForms (principe n°3, même collection
      // `groups`). Groupe créé IMMÉDIATEMENT dans le store (survit à l'annulation de ce formulaire) ; toast partagé.
      onCreate: async (label: string) => {
        const created: any = await store.create("groups", { label: label.trim(), type: GroupTypes.DEFAULT, color: null, description: "" });
        if (!created || !created.id) return null;
        host.setDirty?.(true); Notify.toast(I18n.t("equipment.group.created"));
        return created.id;
      },
    });
    root.appendChild(FormControls.fieldRow(I18n.t("vm.edit.groupSecondary"), secondaryGroups.element, I18n.t("vm.edit.groupSecondaryHint")));
    // choisir le primaire le retire des secondaires (un groupe ne peut être primaire ET secondaire).
    groupI.addEventListener("change", () => { secondaryGroups.setValue(secondaryGroups.getValue().filter((gid) => gid !== groupI.value)); secondaryGroups.refresh(); });
    return {
      primary: groupI,
      collect: () => {
        const primaryGroup = groupI.value || null;
        const secondary = secondaryGroups.getValue().filter((gid) => gid && gid !== primaryGroup);
        // group_ids = primaire + secondaires (dédupliqués), primaire en tête → invariant « primaire ∈ group_ids » respecté.
        const groupIds = [...new Set([...(primaryGroup ? [primaryGroup] : []), ...secondary])];
        return { group_id: primaryGroup, group_ids: groupIds };
      },
    };
  }

  /** Formulaire de création (`id` null) ET d'édition d'une VM MANUELLE — c.-à-d. une VM à `provider_id: ""`
      (FORME B du cadrage 2026-08-15 : PAS de « provider Manuel »). Ouvert dans la modale standard (principe n°11),
      depuis le bouton « + VM » de l'onglet et depuis le pied de fiche d'une VM manuelle.

      POURQUOI un formulaire DISTINCT d'`edit`. Pour une VM SYNCHRONISÉE, les champs source (nom, type, statut,
      hôte, vNIC…) sont écrasés à chaque passe : les éditer serait un mensonge à durée de vie d'une synchro, d'où
      `edit` qui n'expose QUE les enrichissements locaux. Pour une VM MANUELLE il n'y a AUCUNE synchro : la frontière
      source/locaux s'efface, la SOURCE est l'utilisateur — tous les champs sont donc saisis ici, y compris l'hôte
      hébergeur (le commentaire « champ dérivé, non éditable » d'`edit` ne vaut que parce qu'une synchro re-résout
      `host_node` ; sans synchro, la SAISIE est le seul chemin).

      Les protections contre la synchro/purge sont STRUCTURELLES et n'ont RIEN à coder ici (cadrage §2, verrouillées
      par test) : `provider_id` vide rend la VM INVISIBLE à `VmSyncService` (scope `findBy("vms","provider_id",id)`),
      et jamais `orphan` → absente de tout groupe de `VmPurge`. */
  static manual(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const vm: any = id ? store.get("vms", id) : null;
    if (id && !vm) { Notify.toast(I18n.t("vm.edit.notFound"), "err"); return; }
    const root = document.createElement("div");

    // -- IDENTITÉ (saisie : la source, c'est l'utilisateur) --
    const nameI = FormControls.text(vm ? (vm.name || "") : "", I18n.t("vm.form.namePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.name"), nameI));

    // vm_type / status : saisie LIBRE + suggestions (datalist). La spec `vms` est TOLÉRANTE (aucun enum) — on ne
    // fabrique donc PAS d'énumération fermée, on se contente de suggérer les valeurs usuelles (patron datalist,
    // cf. NotificationsAdminView / spare). Un statut inconnu passe la même tolérance que les statuts Proxmox.
    const typeI = FormControls.text(vm ? (vm.vm_type || "") : "", I18n.t("vm.form.typePlaceholder"));
    root.appendChild(FormControls.attachDatalist(typeI, "vm-manual-type", ["qemu", "lxc"]));
    const statusI = FormControls.text(vm ? (vm.status || "") : "", I18n.t("vm.form.statusPlaceholder"));
    root.appendChild(FormControls.attachDatalist(statusI, "vm-manual-status", ["running", "stopped"]));
    root.appendChild(FormUi.row2(
      FormControls.fieldRow(I18n.t("lists.col.type"), typeI, I18n.t("vm.form.typeHint")),
      FormControls.fieldRow(I18n.t("lists.col.status"), statusI, I18n.t("vm.form.statusHint")),
    ));

    // Hôte hébergeur = ENTITÉ à liste longue → sélecteur à recherche (principe n°14), MÊME règle d'options que le
    // picker d'équipement de la fiche spare (`FormUi.eqOptions` : « — » en tête + équipements triés par nom). ⚠ Pour
    // une manuelle ce champ est SAISI (pas dérivé) — aucune synchro ne le re-résout, la saisie fait foi.
    const hostI = FormControls.entityPicker(FormUi.eqOptions(store, I18n.t("vm.form.hostNone")), vm ? (vm.host_equipment_id || "") : "");
    root.appendChild(FormControls.fieldRow(I18n.t("detail.vm.hostSection"), hostI, I18n.t("vm.form.hostHint")));

    // GROUPES : bloc factorisé, PARTAGÉ avec `edit` (aucune recopie).
    const groups = VmForms.appendGroupBlock(store, host, root, vm);

    // RESSOURCES : information utile d'un inventaire manuel (cadrage §3 — techniquement des « champs source »,
    // mais pour une manuelle la source = l'utilisateur). Nullables (vide = non renseigné), bornées ≥ 0 par la spec.
    const cpuI = FormControls.number(vm ? vm.cpu : "", { min: 0, step: 1, placeholder: I18n.t("vm.form.cpuPlaceholder") });
    const ramI = FormControls.number(vm ? vm.ram_mb : "", { min: 0, step: 1, placeholder: I18n.t("vm.form.ramPlaceholder") });
    const diskI = FormControls.number(vm ? vm.disk_gb : "", { min: 0, step: 1, placeholder: I18n.t("vm.form.diskPlaceholder") });
    root.appendChild(FormUi.row2(
      FormControls.fieldRow(I18n.t("detail.vm.vcpu"), cpuI),
      FormControls.fieldRow(I18n.t("vm.form.ramMb"), ramI),
      FormControls.fieldRow(I18n.t("vm.form.diskGb"), diskI),
    ));

    // vNIC : éditeur de rangées dynamiques. ÉTAT LOCAL = source de vérité des lignes (les `<input>` y réécrivent
    // en direct via `oninput`) — reconstruire la table (ajout/retrait) ne perd jamais une saisie en cours, MÊME
    // patron que la modale « Réseaux virtuels » (netMapping) plus haut. Les IPs sont saisies en une chaîne
    // séparée par des virgules ; au save chaque rangée passe par `VmSync.normalizeNic` (source de vérité du pivot).
    root.appendChild(FormUi.divider(I18n.t("vm.form.nicsSection")));
    const nicRows: { name: string; mac: string; bridge: string; tag: string; ips: string }[] =
      (Array.isArray(vm && vm.nics) ? vm.nics : []).map((n: any) => ({
        name: n.name || "", mac: n.mac || "", bridge: n.bridge || "",
        tag: n.vlan_tag == null ? "" : String(n.vlan_tag),
        ips: Array.isArray(n.ips) ? n.ips.join(", ") : "",
      }));
    const nicsWrap = document.createElement("div");
    const renderNics = (): void => {
      nicsWrap.innerHTML = "";
      if (!nicRows.length) {
        const empty = document.createElement("div"); empty.className = "form-hint"; empty.style.fontStyle = "italic";
        empty.textContent = I18n.t("vm.form.nicsEmpty");
        nicsWrap.appendChild(empty);
      }
      nicRows.forEach((row, i) => {
        const line = document.createElement("div"); line.className = "form-row"; line.style.alignItems = "flex-end";
        const nameF = FormControls.text(row.name, I18n.t("vm.form.nicNamePlaceholder")); nameF.oninput = () => { row.name = nameF.value; };
        const macF = FormControls.text(row.mac, I18n.t("vm.form.nicMacPlaceholder")); macF.oninput = () => { row.mac = macF.value; };
        const bridgeF = FormControls.text(row.bridge, I18n.t("vm.netMap.bridgePlaceholder")); bridgeF.oninput = () => { row.bridge = bridgeF.value; };
        const tagF = FormControls.number(row.tag, { min: 0, step: 1, placeholder: I18n.t("vm.netMap.noTag") }); tagF.oninput = () => { row.tag = tagF.value; };
        const ipsF = FormControls.text(row.ips, I18n.t("vm.form.nicIpsPlaceholder")); ipsF.oninput = () => { row.ips = ipsF.value; };
        // Retrait de la rangée par bouton-ICÔNE (principe n°14, teinte danger) — aligné sur le bas des champs.
        const del = IconButton.build({ icon: Icons.DELETE, label: I18n.t("vm.form.nicRemove"), danger: true, onClick: () => { nicRows.splice(i, 1); renderNics(); } });
        const delWrap = document.createElement("div"); delWrap.className = "form-field"; delWrap.style.flex = "0 0 auto";
        const spacer = document.createElement("label"); spacer.innerHTML = "&nbsp;";   // aligne le bouton sur le bas des champs
        delWrap.append(spacer, del);
        line.append(
          FormControls.fieldRow(I18n.t("lists.col.name"), nameF),
          FormControls.fieldRow(I18n.t("detail.vm.colMac"), macF),
          FormControls.fieldRow(I18n.t("detail.vm.colBridge"), bridgeF),
          FormControls.fieldRow(I18n.t("vm.netMap.colTag"), tagF),
          FormControls.fieldRow(I18n.t("vm.form.nicIps"), ipsF),
          delWrap,
        );
        nicsWrap.appendChild(line);
      });
    };
    renderNics();
    root.appendChild(nicsWrap);
    const addNic = IconButton.build({ icon: Icons.PLUS, label: I18n.t("vm.form.nicAdd"), onClick: () => { nicRows.push({ name: "", mac: "", bridge: "", tag: "", ips: "" }); renderNics(); } });
    addNic.style.marginTop = "8px";
    root.appendChild(addNic);

    // Notes (enrichissement local, comme `edit`).
    const notesI = FormControls.textArea(vm ? (vm.notes || "") : "");
    root.appendChild(FormControls.fieldRow(I18n.t("vm.edit.notes"), notesI, I18n.t("vm.edit.notesHint")));

    host.openModal({
      title: id ? I18n.t("vm.form.titleEdit") : I18n.t("vm.form.titleNew"),
      subtitle: id ? Html.escape(vm.name || "") : I18n.t("vm.form.subtitle"),
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim();
        if (!name) { Notify.toast(I18n.t("vm.form.nameRequired"), "err"); return false; }   // garde d'UI (parité des autres formulaires)
        // vNIC : chaque rangée normalisée par la source de vérité du pivot (VmSync.normalizeNic) — les IPs, saisies
        // en une chaîne, sont éclatées sur la virgule puis trimées ; l'invariant partagé « IPv4 des vNIC » (validation)
        // refusera un save invalide (toast saveRefused conservé, parité `edit`).
        const nics = nicRows.map((r) => VmSync.normalizeNic({
          name: r.name, mac: r.mac, bridge: r.bridge, vlan_tag: r.tag,
          ips: r.ips.split(",").map((s) => s.trim()).filter(Boolean),
        }));
        const editable = {
          name,
          vm_type: typeI.value.trim(),
          status: statusI.value.trim(),
          host_equipment_id: hostI.value || null,
          ...groups.collect(),   // { group_id, group_ids }
          cpu: cpuI.value !== "" ? +cpuI.value : null,
          ram_mb: ramI.value !== "" ? +ramI.value : null,
          disk_gb: diskI.value !== "" ? +diskI.value : null,
          nics,
          notes: notesI.value.trim(),
        };
        // CRÉATION : `provider_id: ""` marque la VM comme MANUELLE (forme B). Les champs de SYNCHRO restants
        // (ext_id/orphan/last_sync/description_src/host_node/tags_src) sont laissés à leurs DÉFAUTS de spec —
        // vides et sans sens pour une manuelle, on ne les pose pas explicitement.
        // ÉDITION : `store.update` fusionne le patch complet des champs éditables (provider_id reste "").
        let ok: any;
        if (id) ok = await store.update("vms", id, editable);
        else ok = await store.create("vms", { ...editable, provider_id: "" });
        if (!ok) { Notify.toast(I18n.t("vm.edit.saveRefused"), "err"); return false; }   // validation partagée (dont IPv4 des vNIC) → modale conservée
        host.setDirty?.(true); Notify.toast(I18n.t(id ? "vm.edit.saved" : "vm.form.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
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
