/* =============================================================================
   SOUS-ÉQUIPEMENTS — fiche de DÉTAIL + formulaire d'ÉDITION.

   Un sous-équipement est le contenu LOGIQUE d'un équipement maître (drive d'une librairie
   à bandes, carte d'un châssis) : il n'a ni placement, ni dimension, ni port, ni type — sa
   sémantique vit dans son NOM, et son existence physique est celle de son maître.

   POSITION DANS L'ARCHITECTURE (principe n°2) : cette classe étend `FormBase` pour ses
   statiques protégées mais reste HORS de la chaîne d'héritage
   `FormBase ← Equipment ← Cable ← Rack ← Ipam ← Detail` — exactement comme `FaceEditor`.
   `DetailForms`/`EquipmentForms` sont déjà des monolithes ; on n'y empile pas une entité de
   plus, on l'appelle par son nom.

   ⚠ IMPORT CROISÉ ASSUMÉ avec `EquipmentForms` (pour rebondir vers la fiche du maître) :
   c'est le même montage que `FaceEditor` ⇄ `EquipmentForms`, et il tient parce que l'usage
   est DIFFÉRÉ (dans des callbacks), jamais à l'initialisation du module.

   ⚠ Pas d'onglet de listing (décision D2) : on n'atteint un sous-équipement que par son
   maître ou par une recherche. La FICHE est donc le point d'entrée — et c'est elle qui rend
   la collection ouvrable par `openTargetDetail` (liens d'intervention, à venir).
   ============================================================================= */
import type { Store } from "../../store";
import { Icons } from "../../ui/Icons";
import { Html } from "../../core/Html";
import { Color } from "../../core/Color";
import { Format } from "../../core/Format";
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { FormControls } from "../../ui/FormControls";
import { ChipsInput, ChipItem } from "../../ui/ChipsInput";
import { FieldFacet } from "../../core/FieldFacet";
import { LiveValidation } from "./LiveValidation";
import { GroupTypes } from "../../domain/GroupTypes";
import { EquipmentTypes } from "../../registries/EquipmentTypes";
import { I18n } from "../../i18n/I18n";
import { AuditLine } from "./AuditLine";
import { InterventionFicheRow } from "./InterventionFicheRow";   // intégration « fiches » de la feature interventions (AMOVIBLE)
import { FormSave } from "./FormSave";   // écriture + garde-fou « ne jamais annoncer un succès refusé »
import { FormBase } from "./FormBase";
import { EquipmentForms } from "./EquipmentForms";   // rebond vers la fiche du MAÎTRE (usage différé, cf. en-tête)
import type { FormHost } from "./shared";

export class SubEquipmentForms extends FormBase {
  /** Libellé d'affichage d'un sous-équipement (le nom, ou un repli). Centralisé : plusieurs vues le rendent. */
  static label(subEquipment: any): string {
    return (subEquipment && subEquipment.name) ? subEquipment.name : I18n.t("subEquipment.fallback");
  }

  /** Résumé technique d'une ligne (marque · modèle · s/n), vide si rien — évite trois colonnes quasi vides. */
  private static techSummary(se: any): string {
    return [se.brand, se.model, se.serial].map((v: string) => (v || "").trim()).filter(Boolean).join(" · ");
  }

  /** Fiche DÉTAIL (lecture) + bouton « Modifier ». */
  static detail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const se: any = store.get("subEquipments", id);
    if (!se) { Notify.toast(I18n.t("subEquipment.notFound"), "err"); return; }
    const master: any = se.equipment_id ? store.get("equipments", se.equipment_id) : null;
    const root = document.createElement("div");

    // Le MAÎTRE en premier : c'est lui qui donne son existence au sous-équipement, la fiche doit le dire
    // d'entrée. Un maître introuvable est signalé en ROUGE plutôt que masqué — la validation l'interdit
    // (`equipment_id` requis + FK), donc si ça arrive c'est un état à voir, pas à taire.
    const masterCell = master
      ? `<span class="pill">${Html.escape(EquipmentTypes.label(master.type))}</span> ${Html.escape(master.name || I18n.t("lists.ph.equipment"))}`
        + ` <button class="btn btn-ghost btn-sm icon-action" data-master-view="${Html.escape(master.id)}" title="${I18n.t("subEquipment.openMaster")}" aria-label="${I18n.t("subEquipment.openMaster")}">${Icons.INFO}</button>`
      : `<span style="color:var(--err)">${I18n.t("subEquipment.masterMissing")}</span>`;
    const groups: any[] = store.groupIdsOf(se).map((gid: string) => store.get("groups", gid)).filter(Boolean);
    const groupCell = groups.length
      ? groups.map((g: any) => `<span class="pill colored-pill" ${Color.pillStyle(g.color)} title="${g.id === se.group_id ? I18n.t("detail.common.groupPrimary") : I18n.t("detail.common.groupSecondary")}">${Html.escape(g.label || I18n.t("lists.ph.group"))}</span>`).join(" ")
      : "—";
    const pairs: Array<[string, string]> = [
      [I18n.t("lists.col.name"), Html.escape(this.label(se))],
      [I18n.t("subEquipment.master"), masterCell],
    ];
    if (se.slot) pairs.push([I18n.t("subEquipment.slot"), Html.escape(se.slot)]);
    const tech = this.techSummary(se);
    if (tech) pairs.push([I18n.t("subEquipment.hardware"), Html.escape(tech)]);
    pairs.push([groups.length > 1 ? I18n.t("detail.common.groups") : I18n.t("lists.col.group"), groupCell]);
    pairs.push([I18n.t("lists.col.description"), se.description ? Html.escape(se.description) : "—"]);
    pairs.push([I18n.t("detail.common.created"), Html.escape(Format.dateTime(se.created_date))]);
    pairs.push([I18n.t("detail.common.updated"), Html.escape(Format.dateTime(se.updated_date))]);
    root.appendChild(this.grid(pairs));

    // PORTS DU MAÎTRE qui desservent ce sous-équipement — le MIROIR de `ports.sub_equipment_id`, et la vue de
    // contrôle de la saisie. ⚠ Le libellé insiste : ce sont les ports DU MAÎTRE. Un sous-équipement n'a pas de
    // port propre (contrainte C3) ; les afficher ici sans le dire ferait croire le contraire.
    // ⚠ LECTURE SEULE, délibérément : l'assignation se fait DEPUIS LE PORT (formulaire d'équipement), un seul
    // chemin d'écriture pour un seul champ — deux chemins, c'est deux occasions de diverger.
    const servingPorts = store.portsOfSubEquipment(se.id);
    this.sect(root, I18n.t("subEquipment.portsSection", { count: servingPorts.length }));
    this.tbl(root, [I18n.t("equipment.detail.colPort"), I18n.t("lists.col.type"), I18n.t("subEquipment.portCable")], servingPorts.map((p: any) => {
      const pt: any = p.port_type_id ? store.get("portTypes", p.port_type_id) : null;
      const cab: any = store.cableOnPort(p.id);
      return [Html.escape(p.name || I18n.t("equipment.common.portParen")),
        pt ? Html.escape(pt.name) : '<span style="color:var(--fg-dimmer)">—</span>',
        cab ? Html.escape(cab.name || I18n.t("lists.ph.cable")) : '<span style="color:var(--fg-dimmer)">—</span>'];
    }), I18n.t("subEquipment.portsEmpty"));

    // Rappel EXPLICITE de ce qu'un sous-équipement n'est pas. Sans cette ligne, une fiche sans emplacement ni
    // ports se lit comme une fiche INCOMPLÈTE ; c'est au contraire sa définition.
    const note = document.createElement("div"); note.className = "form-hint"; note.style.marginTop = "10px";
    note.textContent = I18n.t("subEquipment.natureHint");
    root.appendChild(note);

    // Intégration « fiches » : badge d'interventions ouvertes + « Déclarer une intervention » (no-op hors
    // mode API) — même rangée que les fiches équipement/VM/spare. Remplacer un drive en panne est LE motif
    // d'intervention type sur ce genre de matériel : la 4ᵉ famille se déclare ici, pas seulement dans l'enum.
    InterventionFicheRow.attach(root, host.interventionHooks, { kind: "sub_equipment", id: se.id, label: se.name || "" }, () => host.closeModal?.());

    AuditLine.attach(root, se, host.userDirectory);   // « Créé/Modifié par » (mode API)
    const footerActions = this.footer(() => this.form(store, host, se.equipment_id, se.id, onChanged));
    const tw = root;
    tw.querySelectorAll("[data-master-view]").forEach((el) => {
      (el as HTMLElement).onclick = () => EquipmentForms.equipmentDetail(store, host, (el as HTMLElement).dataset.masterView!, onChanged);
    });
    host.openModal({
      title: I18n.t("subEquipment.detailTitle"), subtitle: Html.escape(this.label(se)), body: root, footerActions, hideFooter: true, wide: true,
      stackKey: "detail:subEquipments/" + id,
      onResume: () => this.detail(store, host, id, onChanged),   // retour au premier plan (édition dépilée) → fiche reconstruite depuis le store
    });
  }

  /** Formulaire de création / d'édition, en MODALE (principe n°11).
      `equipmentId` = le maître ; il est IMPOSÉ (jamais choisi dans le formulaire) parce qu'on ne crée un
      sous-équipement que DEPUIS son maître — c'est ce qui rend le champ `required` naturel côté saisie. */
  static form(store: Store, host: FormHost, equipmentId: string, id: string | null, onSaved?: () => void): void {
    const se: any = id ? store.get("subEquipments", id) : null;
    const master: any = store.get("equipments", equipmentId);
    if (!master) { Notify.toast(I18n.t("subEquipment.masterMissing"), "err"); return; }
    const root = document.createElement("div");

    // Le MAÎTRE est rappelé en lecture seule : il n'est pas modifiable ici (on ne déménage pas un
    // sous-équipement par ce formulaire), mais le cacher rendrait la modale ambiguë quand elle est empilée.
    const masterLine = document.createElement("div"); masterLine.className = "form-hint";
    masterLine.textContent = I18n.t("subEquipment.masterFixed", { name: master.name || I18n.t("lists.ph.equipment") });
    root.appendChild(masterLine);

    const nameI = FormControls.text(se ? se.name : "", I18n.t("subEquipment.namePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.name"), nameI, I18n.t("subEquipment.nameHint")));
    const slotI = FormControls.text(se ? se.slot : "", I18n.t("subEquipment.slotPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("subEquipment.slot"), slotI, I18n.t("subEquipment.slotHint")));
    const brandI = FormControls.text(se ? se.brand : "", I18n.t("subEquipment.brandPlaceholder"));
    const modelI = FormControls.text(se ? se.model : "", I18n.t("subEquipment.modelPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("equipment.field.brand"), brandI));
    root.appendChild(FormControls.fieldRow(I18n.t("equipment.field.model"), modelI));
    const serialI = FormControls.text(se ? se.serial : "", I18n.t("subEquipment.serialPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("equipment.field.serial"), serialI));

    // GROUPES : primaire (single) + secondaires (multi) — MÊME dispositif que le formulaire d'équipement.
    // ⚠ `<select>` pour le primaire : c'est une liste d'ENTITÉS mais courte et déjà traitée ainsi côté
    // équipement ; changer de contrôle ici et pas là créerait une incohérence (principe n°14).
    const groupsSorted = (): any[] => store.all("groups").slice().sort((a: any, b: any) => (a.label || "").localeCompare(b.label || ""));
    const grpOpts = [{ value: "", label: I18n.t("forms.opt.none") }].concat(groupsSorted().map((g: any) => ({ value: g.id, label: g.label || I18n.t("lists.ph.noLabel") })));
    const groupI = FormControls.select(grpOpts, se && se.group_id ? se.group_id : "");
    root.appendChild(FormControls.fieldRow(I18n.t("equipment.equip.primaryGroup"), groupI));
    const initSecondary = se ? store.groupIdsOf(se).filter((gid: string) => gid !== (se.group_id || null)) : [];
    const groupItems = (): ChipItem[] => groupsSorted().filter((g: any) => g.id !== groupI.value).map((g: any) => ({ id: g.id, label: g.label || I18n.t("lists.ph.noLabel"), color: g.color }));
    const secondaryGroups = ChipsInput.build({
      items: groupItems, value: initSecondary, placeholder: I18n.t("equipment.equip.addSecondary"),
      getLimit: () => host.autocompleteLimit ? host.autocompleteLimit() : FieldFacet.MAX_RESULTS_DEFAULT,
      allowCreate: true,
      // Entrée sur une saisie qui ne matche aucun groupe → CRÉE le groupe et l'ajoute en pastille. MÊME
      // contrat que le formulaire d'équipement : `onCreate` rend l'ID (pas l'objet), et le groupe créé
      // SURVIT à l'annulation de cette modale — comportement assumé, identique des deux côtés.
      onCreate: async (label: string) => {
        const created: any = await store.create("groups", { label: label.trim(), type: GroupTypes.DEFAULT, color: null, description: "" });
        if (!created || !created.id) return null;
        host.setDirty?.(true); Notify.toast(I18n.t("equipment.group.created"));
        return created.id;
      },
    });
    root.appendChild(FormControls.fieldRow(I18n.t("equipment.equip.secondaryGroups"), secondaryGroups.element));
    groupI.onchange = () => secondaryGroups.refresh();

    const descI = FormControls.textArea(se ? se.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.description"), descI));

    const live = new LiveValidation("subEquipments", { name: nameI });
    live.clearOnInput();

    host.openModal({
      title: se ? I18n.t("subEquipment.titleEdit") : I18n.t("subEquipment.titleNew"),
      subtitle: Html.escape(master.name || ""),
      body: root,
      onSave: async () => {
        const primaryGroup = groupI.value || null;
        const secondary = secondaryGroups.getValue().filter((gid) => gid && gid !== primaryGroup);
        // Le primaire est TOUJOURS membre de group_ids, en tête (invariant partagé T1d) — même calcul que
        // le formulaire d'équipement, pour que les deux écrivent des enregistrements de forme identique.
        const groupIds = [...new Set([...(primaryGroup ? [primaryGroup] : []), ...secondary])];
        const payload = {
          name: nameI.value.trim(), equipment_id: equipmentId,
          slot: slotI.value.trim(), brand: brandI.value.trim(), model: modelI.value.trim(), serial: serialI.value.trim(),
          group_id: primaryGroup, group_ids: groupIds, description: descI.value.trim(),
        };
        if (live.check(payload).length) return false;   // nom requis (surligné)
        if (!await FormSave.record(store, "subEquipments", se && se.id, payload)) return false;   // refusé par le Store : garder la saisie
        host.setDirty?.(true); Notify.toast(se ? I18n.t("subEquipment.updated") : I18n.t("subEquipment.created"));
        onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** Section « Sous-équipements » d'une fiche (maître ou groupe) : tableau + bouton de création facultatif.
      Mutualisée parce qu'elle est rendue à DEUX endroits, avec les mêmes colonnes et le même rebond.

      ⚠ Cette section ne sait RIEN de la fiche qui l'héberge, et n'a plus à le savoir : depuis que `Modal`
      est une PILE, ouvrir une fiche ou un formulaire de sous-équipement EMPILE, et le retour (Enregistrer /
      Annuler / ←) redonne la fiche hôte, reconstruite par son propre `onResume`. L'ancien rappel `reopen`,
      que chaque hôte devait fournir pour se faire rouvrir, a donc disparu. Seule la SUPPRESSION en ligne
      demande encore un geste explicite (`host.refreshModal`) : elle ne dépile rien. */
  static attachSection(store: Store, host: FormHost, root: HTMLElement, rows: any[], opts: { addTo?: string } = {}): void {
    const title = document.createElement("div"); title.className = "section-divider";
    title.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px";
    const label = document.createElement("span"); label.textContent = I18n.t("subEquipment.section", { count: rows.length });
    title.appendChild(label);
    if (opts.addTo && !this.isViewer()) {
      const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-ghost btn-sm";
      add.textContent = I18n.t("subEquipment.add");
      add.onclick = () => this.form(store, host, opts.addTo!, null);
      title.appendChild(add);
    }
    root.appendChild(title);
    // Modifier/Supprimer masqués en mode visualiseur — MÊME garde que le bouton d'en-tête « + Ajouter » ci-dessus
    // (principe n°10 : la fiche reste consultable, mais aucune écriture n'est offerte). Le bouton fiche, lui,
    // reste toujours affiché : c'est le seul moyen d'ATTEINDRE un sous-équipement (décision D2, pas d'onglet dédié).
    const viewer = this.isViewer();
    const tw = this.tbl(root, [I18n.t("lists.col.name"), I18n.t("subEquipment.slot"), I18n.t("lists.col.characteristics"), ""], rows.map((se: any) => {
      const view = `<button class="btn btn-ghost btn-sm icon-action" data-se-view="${Html.escape(se.id)}" title="${I18n.t("lists.chrome.rowView")}" aria-label="${I18n.t("lists.chrome.rowView")}">${Icons.INFO}</button>`;
      const edit = viewer ? "" : `<button class="btn btn-ghost btn-sm icon-action" data-se-edit="${Html.escape(se.id)}" title="${I18n.t("lists.chrome.rowEdit")}" aria-label="${I18n.t("lists.chrome.rowEdit")}">${Icons.EDIT}</button>`;
      const del = viewer ? "" : `<button class="btn btn-sm icon-action btn-danger" data-se-del="${Html.escape(se.id)}" title="${I18n.t("lists.chrome.rowDelete")}" aria-label="${I18n.t("lists.chrome.rowDelete")}">${Icons.DELETE}</button>`;
      const tech = this.techSummary(se);
      return [Html.escape(this.label(se)), se.slot ? Html.escape(se.slot) : '<span style="color:var(--fg-dimmer)">—</span>',
        tech ? Html.escape(tech) : '<span style="color:var(--fg-dimmer)">—</span>', `<span class="cell-actions">${view}${edit}${del}</span>`];
    }), I18n.t("subEquipment.sectionEmpty"));
    tw?.querySelectorAll("[data-se-view]").forEach((el) => {
      (el as HTMLElement).onclick = () => this.detail(store, host, (el as HTMLElement).dataset.seView!);
    });
    tw?.querySelectorAll("[data-se-edit]").forEach((el) => {
      (el as HTMLElement).onclick = () => {
        const se: any = store.get("subEquipments", (el as HTMLElement).dataset.seEdit!);
        if (se) this.form(store, host, se.equipment_id, se.id);
      };
    });
    tw?.querySelectorAll("[data-se-del]").forEach((el) => {
      (el as HTMLElement).onclick = async () => {
        const se: any = store.get("subEquipments", (el as HTMLElement).dataset.seDel!);
        if (!se) return;
        const ok = await Dialog.confirm({
          title: I18n.t("subEquipment.deleteConfirmTitle"),
          message: I18n.t("subEquipment.deleteConfirmMsg", { name: this.label(se) }),
          confirmLabel: I18n.t("ui.action.delete"), danger: true,
        });
        if (!ok) return;
        // La cascade PARTAGÉE (src-shared/Cascade.ts, règle `subEquipments`) DÉTACHE les ports du maître
        // assignés à ce sous-équipement — elle ne les supprime pas. Le dialogue de confirmation le rappelle
        // explicitement pour éviter de faire croire à une perte de câblage.
        await store.remove("subEquipments", se.id);
        host.setDirty?.(true); Notify.toast(I18n.t("subEquipment.deleted"));
        // La suppression a lieu DANS la fiche hôte : rien n'est dépilé, donc rien ne déclenche son
        // `onResume`. On lui redemande de se reconstruire EN PLACE pour que la ligne disparaisse.
        host.refreshModal?.();
      };
    });
  }
}
