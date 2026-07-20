import type { Store } from "../../store";
import { Icons } from "../../ui/Icons";
import { PortEditorControls, type PortDraft } from "./PortEditorControls";
import { ImageStore } from "../../data/ImageStore";
import { FormControls } from "../../ui/FormControls";
import { ChipsInput, ChipItem } from "../../ui/ChipsInput";
import { Autocomplete } from "../../ui/Autocomplete";
import { FieldFacet } from "../../core/FieldFacet";
import { LiveValidation } from "./LiveValidation";
import { ColorPalette } from "../../ui/ColorPalette";
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { Html } from "../../core/Html";
import { Color } from "../../core/Color";
import { Format } from "../../core/Format";
import { AuditLine } from "./AuditLine";   // ligne « Créé/Modifié par {auteur} le {date} » (annuaire, mode API)
import { GroupTypes } from "../../domain/GroupTypes";
import { SpareTypes } from "../../domain/SpareTypes";
import { SpareStatuses } from "../../domain/SpareStatuses";
import { EquipmentTypes } from "../../registries/EquipmentTypes";
import { Depths } from "../../registries/Depths";
import { I18n } from "../../i18n/I18n";   // lot B2a : options des tables de libellés (labelKey → I18n.t)
import { RackGeometry } from "../../geometry/RackGeometry";
import { PortRoles } from "../../registries/PortRoles";
import { EquipFaces } from "../../registries/EquipFaces";
import { Id } from "../../core/Id";
import { Normalize } from "../../core/Normalize";
import {
  EQUIPMENT_TYPE_DEFAULT,
  EQUIP_FACE_IDS, EQUIP_FACE_IMG_FIELD,
  DEPTH_PRESETS_MM, EQUIP_DEPTH_DEFAULT_MM, RACK_DEPTH_DEFAULT,
  SPARE_DISK_TYPES, SPARE_CAP_UNITS, SPARE_HDD_INTERFACES, SPARE_HDD_FORMATS, SPARE_HDD_RPM,
  SPARE_TX_FORMS, SPARE_TX_SPEEDS, SPARE_TX_MEDIA
} from "../../domain/constants";
import { FormUi, ORIENT_OPTS } from "./shared";
import type { FormHost } from "./shared";
import { FormBase } from "./FormBase";
import { FaceEditor } from "./FaceEditor";
import { PerspectiveEditor } from "../../ui/PerspectiveEditor";
import { StitchEditor } from "../../ui/StitchEditor";
import { Download } from "../../core/Download";
import { InterventionFicheRow } from "./InterventionFicheRow";   // intégration « fiches » de la feature interventions (AMOVIBLE)
import { CertFicheRow } from "./CertFicheRow";   // intégration « fiches » du rapprochement certificat ↔ cible (AMOVIBLE)

export class EquipmentForms extends FormBase {
  /** Fiche DÉTAIL d'un équipement (lecture) + bouton « Modifier » → formulaire d'édition. */
  static equipmentDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const eq: any = store.get("equipments", id);
    if (!eq) { Notify.toast(I18n.t("equipment.notFound"), "err"); return; }
    const root = document.createElement("div");
    const grid = document.createElement("div"); grid.className = "detail-grid";
    const add = (label: string, html: string) => { grid.appendChild(this.dt(label)); grid.appendChild(this.dd(html)); };
    add(I18n.t("lists.col.name"), Html.escape(eq.name || I18n.t("lists.ph.noName")));
    add(I18n.t("lists.col.type"), `<span class="pill">${Html.escape(EquipmentTypes.label(eq.type))}</span>` + (eq.inventory_only ? ` <span class="pill" style="color:var(--fg-dim)">${I18n.t("equipment.detail.invOnlyPill")}</span>` : ""));
    add(I18n.t("equipment.field.brand"), eq.brand ? Html.escape(eq.brand) : "—");
    add(I18n.t("equipment.field.model"), eq.model ? Html.escape(eq.model) : "—");
    add(I18n.t("equipment.field.serial"), eq.serial ? Html.escape(eq.serial) : "—");
    const primaryGrp: any = eq.group_id ? store.get("groups", eq.group_id) : null;
    const secondaryGrps: any[] = store.equipmentGroupIds(eq).filter((gid: string) => gid !== (eq.group_id || null)).map((gid: string) => store.get("groups", gid)).filter(Boolean);
    const grpPills = [
      primaryGrp ? `<span class="pill colored-pill" ${Color.pillStyle(primaryGrp.color)} title="${I18n.t("equipment.detail.groupPrimary")}">${Html.escape(primaryGrp.label)}</span>` : null,
      ...secondaryGrps.map((g: any) => `<span class="pill colored-pill" ${Color.pillStyle(g.color)} title="${I18n.t("equipment.detail.groupSecondary")}">${Html.escape(g.label)}</span>`),
    ].filter(Boolean);
    add(grpPills.length > 1 ? I18n.t("equipment.detail.groups") : I18n.t("lists.col.group"), grpPills.length ? grpPills.join(" ") : "—");
    if (eq.type === "pdu" || eq.type === "tableau") add(I18n.t("equipment.detail.maxCapacity"), eq.pdu_max_a != null ? `<span class="pill">${eq.pdu_max_a} A</span>` : "—");
    if (eq.type !== "tableau" && (eq.power_nominal_w != null || eq.power_max_w != null)) add(I18n.t("equipment.detail.consumption"), [eq.power_nominal_w != null ? I18n.t("equipment.detail.wNom", { w: eq.power_nominal_w }) : null, eq.power_max_w != null ? I18n.t("equipment.detail.wMax", { w: eq.power_max_w }) : null].filter(Boolean).join(" · ") || "—");
    if (eq.purchase_date || eq.po_ref) add(I18n.t("lists.col.purchase"), [eq.purchase_date ? Html.escape(eq.purchase_date) : null, eq.po_ref ? I18n.t("equipment.detail.poRef", { ref: Html.escape(eq.po_ref) }) : null].filter(Boolean).join(" · ") || "—");
    if (eq.warranty_end) add(I18n.t("equipment.field.warrantyEnd"), Html.escape(eq.warranty_end));
    if (eq.assigned_to || eq.assigned_date) add(I18n.t("equipment.field.assignedTo"), [eq.assigned_to ? Html.escape(eq.assigned_to) : null, eq.assigned_date ? I18n.t("equipment.detail.onDate", { date: Html.escape(eq.assigned_date) }) : null].filter(Boolean).join(" · ") || "—");
    const dimHtml = eq.dim_mode === "free"
      ? `<span class="pill">${I18n.t("equipment.detail.dimFree")}</span> ${eq.free_l_mm != null ? eq.free_l_mm : "?"} × ${eq.free_w_mm != null ? eq.free_w_mm : "?"} × ${eq.free_h_mm != null ? eq.free_h_mm : "?"} mm <span style="color:var(--fg-dimmer)">${I18n.t("equipment.detail.lwh")}</span>`
      : `<span class="pill">U</span> ${eq.u_height || 1} U · ${Html.escape(this.mountDepthLabel(eq))}${eq.locks_u ? I18n.t("equipment.detail.uLocked") : ""}${eq.u_width_mm != null ? I18n.t("equipment.detail.widthAlign", { w: eq.u_width_mm, align: eq.u_align === "left" ? I18n.t("equipment.detail.alignLeft") : eq.u_align === "right" ? I18n.t("equipment.detail.alignRight") : I18n.t("equipment.detail.alignCenter") }) : ""}`;
    add(I18n.t("lists.col.dimensions"), dimHtml);
    let placeHtml: string;
    if (eq.placement_mode === "rack") {
      const rk: any = eq.rack_id ? store.get("racks", eq.rack_id) : null;
      if (!eq.rack_id) placeHtml = `<span class="pill">${I18n.t("equipment.detail.unplaced")}</span>`;
      else if (rk) { const pos = eq.rack_u ? ("U" + eq.rack_u + ((eq.u_height || 1) > 1 ? "–U" + (eq.rack_u + (eq.u_height || 1) - 1) : "")) : I18n.t("equipment.detail.freePos"); placeHtml = `<span class="pill">${I18n.t("equipment.detail.rackPill")}</span> ${Html.escape(rk.name || I18n.t("lists.ph.noName"))} · ${pos} · ${Html.escape(this.mountDepthLabel(eq))}`; }
      else placeHtml = `<span class="pill">${I18n.t("equipment.detail.rackPill")}</span> <span style="color:var(--err)">${I18n.t("equipment.detail.rackNotFound")}</span>`;
    } else if (eq.dim_mode === "free" && eq.dc_id) { const dc: any = store.get("datacenters", eq.dc_id); placeHtml = `<span class="pill">${I18n.t("equipment.detail.roomPill")}</span> ${Html.escape(dc ? (dc.name || I18n.t("lists.ph.noName")) : I18n.t("equipment.detail.dcNotFound"))}`; }
    else placeHtml = `<span class="pill">${I18n.t("equipment.detail.manualPill")}</span>`;
    add(I18n.t("lists.col.location"), placeHtml);
    const locBits = this.equipLocationBits(store, eq);
    add(I18n.t("equipment.common.place"), locBits.length ? `<span class="loc-pill">${Html.escape(locBits.join(" · "))}</span>` : `<span style="color:var(--fg-dimmer)">${I18n.t("equipment.detail.notSet")}</span>`);
    add(I18n.t("lists.col.description"), eq.description ? Html.escape(eq.description) : "—");
    add(I18n.t("equipment.common.created"), Html.escape(Format.dateTime(eq.created_date)));
    add(I18n.t("equipment.common.updated"), Html.escape(Format.dateTime(eq.updated_date)));
    root.appendChild(grid);

    // Intégration « fiches » : badge d'interventions ouvertes + « Déclarer une intervention » (no-op hors mode API).
    InterventionFicheRow.attach(root, host.interventionHooks, { kind: "equipment", id: eq.id, label: eq.name || "" }, () => host.closeModal?.());
    // Intégration « fiches » : certificats TLS rapprochés (calculé, no-op hors mode API).
    CertFicheRow.attach(root, host.certHooks, { kind: "equipment", id: eq.id }, () => host.closeModal?.());

    // façade : bouton éditer + toggle « haute densité » + aperçus des faces avec contenu
    const dF = document.createElement("div"); dF.className = "section-divider"; dF.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px";
    const dFlabel = document.createElement("span"); dFlabel.textContent = I18n.t("equipment.detail.faceplate"); dF.appendChild(dFlabel);
    const dFbtns = document.createElement("span"); dFbtns.style.cssText = "display:inline-flex;gap:8px;"; dF.appendChild(dFbtns);
    // MODE HAUTE DENSITÉ (coexiste avec le rendu classique) : pastilles seules + chips sous la face, survol
    // croisé pastille ↔ chip avec bulle déportée (cf. FormBase.facePreviewDense). Préférence PAR NAVIGATEUR.
    const DENSE_KEY = "dcmanager.facePreviewDense";
    let dense = false; try { dense = window.localStorage.getItem(DENSE_KEY) === "1"; } catch (_) { /* défaut */ }
    const denseBtn = document.createElement("button"); denseBtn.type = "button";
    denseBtn.title = I18n.t("equipment.detail.denseTitle");
    dFbtns.appendChild(denseBtn);
    if (!this.isViewer()) {   // viewer (lecture seule) : pas d'édition de façade
      const editFaceBtn = document.createElement("button"); editFaceBtn.type = "button"; editFaceBtn.className = "btn btn-ghost btn-sm"; editFaceBtn.textContent = I18n.t("equipment.detail.editFace");
      editFaceBtn.onclick = () => FaceEditor.open(store, host, eq.id, { onApply: undefined });
      dFbtns.appendChild(editFaceBtn);
    }
    root.appendChild(dF);
    const faces = eq.dim_mode === "free" ? EQUIP_FACE_IDS.slice() : ["front", "rear"];
    const previewsBox = document.createElement("div"); root.appendChild(previewsBox);
    const renderPreviews = () => {
      denseBtn.className = "btn btn-sm " + (dense ? "btn-primary" : "btn-ghost");
      denseBtn.textContent = I18n.t("equipment.detail.dense");
      previewsBox.innerHTML = "";
      const previews = faces.map((f) => ({ f, pv: this.facePreview(store, eq, f, dense) })).filter((x) => x.pv);
      if (previews.length) previews.forEach(({ f, pv }) => { const cap = document.createElement("div"); cap.className = "form-hint"; cap.style.margin = "2px 0 4px"; cap.textContent = I18n.t("equipment.detail.faceLabel", { face: EquipFaces.label(f).toLowerCase() }); previewsBox.appendChild(cap); previewsBox.appendChild(pv!); });
      else { const fh = document.createElement("div"); fh.className = "form-hint"; fh.textContent = I18n.t("equipment.detail.noFace"); previewsBox.appendChild(fh); }
    };
    denseBtn.onclick = () => { dense = !dense; try { window.localStorage.setItem(DENSE_KEY, dense ? "1" : "0"); } catch (_) { /* quota → ignoré */ } renderPreviews(); };
    renderPreviews();

    // ports
    const ports = store.portsOf(eq.id);
    const dP = document.createElement("div"); dP.className = "section-divider"; dP.textContent = I18n.t("equipment.detail.portsSection", { count: ports.length }); root.appendChild(dP);
    if (ports.length) {
      const tw = document.createElement("div"); tw.className = "table-wrap";
      const rows = ports.map((p: any) => {
        const pt: any = store.get("portTypes", p.port_type_id), ag: any = p.aggregate_id ? store.get("aggregates", p.aggregate_id) : null;
        let bk = "";
        if (store.isBreakoutParent(p)) bk = ` <span class="pill">${I18n.t("equipment.detail.trunkPill", { n: store.breakoutLanes(p.id).length })}</span>`;
        else if (p.parent_port_id) { const par: any = store.get("ports", p.parent_port_id); bk = ` <span class="pill">${I18n.t("equipment.detail.lanePill", { lane: p.lane || "?", trunk: Html.escape(par ? (par.name || I18n.t("equipment.detail.trunkWord")) : I18n.t("equipment.detail.trunkWord")) })}</span>`; }
        return `<tr><td class="cell-name">${Html.escape(p.name || I18n.t("equipment.common.portParen"))}${bk}</td><td>${pt ? Html.escape(pt.name) + ' <span style="color:var(--fg-dimmer)">· ' + Html.escape(pt.family) + "</span>" : `<span style="color:var(--err)">${I18n.t("equipment.detail.typeUnknown")}</span>`}</td><td><span class="pill role-${p.role === "mgmt" ? "mgmt" : (p.role === "power" ? "power" : "data")}">${Html.escape(PortRoles.label(p.role))}</span></td><td>${ag ? Html.escape(ag.name || I18n.t("equipment.detail.aggFallback")) : '<span style="color:var(--fg-dimmer)">—</span>'}</td><td class="cell-actions">${host.locate && store.portDcId(p.id) ? `<button class="btn btn-ghost btn-sm icon-action" data-port-locate="${p.id}" title="${I18n.t("equipment.detail.locatePort")}" aria-label="${I18n.t("equipment.detail.locatePort")}">${Icons.LOCATE}</button>` : ""}</td></tr>`;
      }).join("");
      tw.innerHTML = `<table><thead><tr><th>${I18n.t("equipment.detail.colPort")}</th><th>${I18n.t("lists.col.type")}</th><th>${I18n.t("equipment.detail.colRole")}</th><th>${I18n.t("equipment.detail.colAgg")}</th><th style="text-align:right;">${I18n.t("equipment.detail.col3d")}</th></tr></thead><tbody>${rows}</tbody></table>`;
      root.appendChild(tw);
      tw.querySelectorAll("[data-port-locate]").forEach((b) => { (b as HTMLElement).onclick = () => host.locate?.("port", (b as HTMLElement).dataset.portLocate!, () => this.equipmentDetail(store, host, eq.id, onChanged)); });
    } else { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = I18n.t("equipment.detail.noPorts"); root.appendChild(e); }

    // câbles connectés
    const cables = store.cablesOfPorts(ports.map((p: any) => p.id));
    const dC = document.createElement("div"); dC.className = "section-divider"; dC.textContent = I18n.t("equipment.detail.cablesSection", { count: cables.length }); root.appendChild(dC);
    if (cables.length) {
      const tw = document.createElement("div"); tw.className = "table-wrap";
      const endHtml = (c: any) => { const pa: any = store.get("ports", c.from_port_id), pb: any = store.get("ports", c.to_port_id); const ea: any = pa ? store.get("equipments", pa.equipment_id) : null, eb: any = pb ? store.get("equipments", pb.equipment_id) : null; const fmt = (e: any, p: any) => e ? `${Html.escape(e.name || "?")} <span style="color:var(--fg-dimmer)">:</span> ${Html.escape(p ? (p.name || "?") : "?")}` : `<span style="color:var(--err)">${I18n.t("equipment.detail.portUnknown")}</span>`; return `${fmt(ea, pa)} <span style="color:var(--accent)">↔</span> ${fmt(eb, pb)}`; };
      const rows = cables.map((c: any) => { const ct: any = store.get("cableTypes", c.cable_type_id); const nid = store.cablePrimaryNetworkId(c); const net: any = nid ? store.get("networks", nid) : null; return `<tr><td class="cell-name">${Html.escape(c.name || I18n.t("lists.ph.cable"))}</td><td>${ct ? Html.escape(ct.name) : `<span style="color:var(--err)">${I18n.t("equipment.detail.typeUnknown")}</span>`}</td><td>${endHtml(c)}</td><td>${net ? `<span class="pill colored-pill" ${Color.pillStyle(net.color)}>${Html.escape(net.label)}</span>` : '<span style="color:var(--fg-dimmer)">—</span>'}</td></tr>`; }).join("");
      tw.innerHTML = `<table><thead><tr><th>${I18n.t("equipment.detail.colCable")}</th><th>${I18n.t("lists.col.type")}</th><th>${I18n.t("lists.col.link")}</th><th>${I18n.t("lists.col.network")}</th></tr></thead><tbody>${rows}</tbody></table>`;
      root.appendChild(tw);
    } else { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = I18n.t("equipment.detail.noCables"); root.appendChild(e); }

    // spares (pièces de rechange) affectés à cet équipement
    const spares = store.sparesOfEquipment(eq.id);
    if (spares.length) {
      const dS = document.createElement("div"); dS.className = "section-divider"; dS.textContent = I18n.t("equipment.detail.sparesSection", { count: spares.length }); root.appendChild(dS);
      const tw = document.createElement("div"); tw.className = "table-wrap";
      const rows = spares.map((s: any) => `<tr><td class="cell-name">${Html.escape(s.displayName())}</td><td><span class="pill">${SpareTypes.svg(s.type)}${Html.escape(SpareTypes.label(s.type))}</span></td><td>${s.techSummary() ? Html.escape(s.techSummary()) : '<span style="color:var(--fg-dimmer)">—</span>'}</td><td>${s.serial ? Html.escape(s.serial) : '<span style="color:var(--fg-dimmer)">—</span>'}</td></tr>`).join("");
      tw.innerHTML = `<table><thead><tr><th>${I18n.t("lists.col.designation")}</th><th>${I18n.t("lists.col.type")}</th><th>${I18n.t("lists.col.characteristics")}</th><th>${I18n.t("equipment.detail.colSerial")}</th></tr></thead><tbody>${rows}</tbody></table>`;
      root.appendChild(tw);
    }

    AuditLine.attach(root, eq, host.userDirectory);   // « Créé/Modifié par » (mode API)

    // Modifier → formulaire d'édition (remplace la fiche par la modale d'édition)
    const actions = document.createElement("div"); actions.style.cssText = "margin-top:16px;display:flex;justify-content:flex-end;gap:8px";
    // « Localiser en 3D » seulement si l'équipement est RATTACHÉ à une salle (même prédicat que locateEquipment :
    // `store.equipmentDcId`) — un équipement d'inventaire pur, posé sur plan d'étage ou dans une baie non placée
    // n'aurait qu'un toast d'erreur (parité avec le listing, cf. ListActions.canLocate).
    if (host.locate && store.equipmentDcId(eq.id)) { const locBtn = document.createElement("button"); locBtn.type = "button"; locBtn.className = "btn btn-ghost"; locBtn.innerHTML = `<span class="gi">${Icons.LOCATE}</span>${I18n.t("lists.chrome.rowLocate")}`; locBtn.onclick = () => host.locate!("equipment", eq.id, () => this.equipmentDetail(store, host, eq.id, onChanged)); actions.appendChild(locBtn); }
    if (!this.isViewer()) {   // viewer : pas de bouton « Modifier »
      const editBtn = document.createElement("button"); editBtn.type = "button"; editBtn.className = "btn btn-primary"; editBtn.textContent = I18n.t("lists.chrome.rowEdit");
      editBtn.onclick = () => this.equipment(store, host, eq.id, onChanged);
      actions.appendChild(editBtn);
    }
    root.appendChild(actions);

    host.openModal({ title: I18n.t("equipment.detail.title"), subtitle: Html.escape(eq.name || ""), body: root, hideFooter: true, wide: true });
  }

  /** Éditeur de capot (toit/sol) : grille SVG au pas 1U, multi-sélection au glisser. Les cellules
      (roof_cells/floor_cells) sont éditées dans un TAMPON et appliquées au clic sur « Enregistrer »
      du formulaire de baie (cf. FormBase.capEditor). Une cellule portant un pin (◆) ne peut être
      retirée. Réservé à un rack EXISTANT. */

  /** Image de façade (bibliothèque IndexedDB hors modèle) : import/remplacement + métadonnées (U, face).
      `preset` (création seulement) prérempli face / U / oreilles depuis le contexte appelant (ex. l'éditeur
      de façade). `onSaved` reçoit l'id de l'image créée/mise à jour (pour la sélectionner en retour). */
  static faceImage(images: ImageStore, store: Store, host: FormHost, id: string | null, onSaved?: (savedId?: string) => void, preset?: { face?: string; u_height?: number; with_ears?: boolean }, asDialog = false): void {
    const fi: any = id ? images.get(id) : null;
    let imgBlob: Blob | null = null, previewUrl: string | null = fi ? fi.url : null, tempUrl: string | null = null;
    const root = document.createElement("div");
    const previewWrap = document.createElement("div"); previewWrap.className = "fi-form-preview";
    const previewImg = document.createElement("img");
    const previewEmpty = document.createElement("div"); previewEmpty.className = "fi-form-empty"; previewEmpty.textContent = I18n.t("equipment.faceImage.noImage");
    previewWrap.append(previewImg, previewEmpty);
    const importBtn = document.createElement("button"); importBtn.type = "button"; importBtn.className = "btn btn-ghost btn-sm";
    const fixBtn = document.createElement("button"); fixBtn.type = "button"; fixBtn.className = "btn btn-ghost btn-sm"; fixBtn.textContent = I18n.t("equipment.faceImage.straighten"); fixBtn.title = I18n.t("equipment.faceImage.straightenTitle");
    const stitchBtn = document.createElement("button"); stitchBtn.type = "button"; stitchBtn.className = "btn btn-ghost btn-sm"; stitchBtn.textContent = I18n.t("equipment.faceImage.stitch"); stitchBtn.title = I18n.t("equipment.faceImage.stitchTitle");
    const dlBtn = document.createElement("button"); dlBtn.type = "button"; dlBtn.className = "btn btn-ghost btn-sm"; dlBtn.textContent = I18n.t("lists.chrome.rowDownload"); dlBtn.title = I18n.t("equipment.faceImage.downloadTitle");
    const nameI = FormControls.text(fi ? fi.name : "", I18n.t("equipment.faceImage.namePlaceholder"));
    const syncPreview = () => {
      if (previewUrl) { previewImg.src = previewUrl; previewImg.style.display = ""; previewEmpty.style.display = "none"; }
      else { previewImg.removeAttribute("src"); previewImg.style.display = "none"; previewEmpty.style.display = ""; }
      importBtn.textContent = previewUrl ? I18n.t("equipment.faceImage.replaceFile") : I18n.t("equipment.faceImage.importImage");
      fixBtn.disabled = !previewUrl; dlBtn.disabled = !previewUrl;   // actifs dès qu'une image est présente (importée OU existante)
    };
    // Blob courant : le fichier fraîchement importé/redressé, sinon le fichier existant (rechargé depuis son URL).
    const currentBlob = async (): Promise<Blob | null> => {
      if (imgBlob) return imgBlob;
      if (fi && fi.url) { try { return await (await fetch(fi.url)).blob(); } catch (_) { return null; } }
      return null;
    };
    importBtn.onclick = async () => {
      const f = this.validImageFile(await this.promptImageFile()); if (!f) return;
      imgBlob = f;
      if (tempUrl) URL.revokeObjectURL(tempUrl);
      tempUrl = URL.createObjectURL(f); previewUrl = tempUrl;
      if (!nameI.value.trim() && f.name) nameI.value = f.name.replace(/\.[^.]+$/, "");
      syncPreview();
    };
    // Redressement À LA DEMANDE (image importée OU existante) : ratio pré-réglé depuis les champs Face/U/Oreilles
    // courants du formulaire ; le résultat remplace le blob en attente (écrit au store à l'enregistrement seulement).
    fixBtn.onclick = async () => {
      const blob = await currentBlob(); if (!blob) { Notify.toast(I18n.t("equipment.faceImage.imgInaccessible"), "err"); return; }
      const face = (faceI.value === "rear") ? "rear" : (faceI.value === "autre" ? "autre" : "front");
      const u = Math.max(1, parseInt(uI.value, 10) || 1), withEars = (face === "front") && (earsI.value !== "face");
      const fixed = await PerspectiveEditor.open(blob, { faceRatio: this.faceImageRatio(face, u, withEars), faceRatioLabel: this.faceImageRatioLabel(face, u, withEars) });
      if (!fixed) return;
      imgBlob = fixed;
      if (tempUrl) URL.revokeObjectURL(tempUrl);
      tempUrl = URL.createObjectURL(fixed); previewUrl = tempUrl;
      syncPreview();
    };
    dlBtn.onclick = async () => {
      const blob = await currentBlob(); if (!blob) { Notify.toast(I18n.t("equipment.faceImage.imgInaccessible"), "err"); return; }
      Download.blob(ImageStore.downloadName(nameI.value.trim() || (fi ? fi.name : "") || "image", blob.type), blob);
    };
    // ASSEMBLAGE de 2 photos (façade trop large/haute pour un cliché) : redresser chacune puis fusionner —
    // cf. docs/redressement-perspective.md. Comme le redressement, le résultat remplace le blob en attente.
    stitchBtn.onclick = async () => {
      // Les DEUX photos dans UN SEUL dialogue (Ctrl+clic) — deux prompts enchaînés seraient bloqués
      // par le navigateur (activation utilisateur consommée par le premier, cf. promptImageFiles).
      const files = (await this.promptImageFiles()).map((f) => this.validImageFile(f)).filter((f): f is File => !!f);
      if (!files.length) return;   // annulé
      if (files.length !== 2) { Notify.toast(I18n.t("equipment.faceImage.select2"), "err"); return; }
      const [f1, f2] = files;   // ordre de sélection = 1re (gauche/haut), 2de (droite/bas) — interchangeable au glisser
      const face = (faceI.value === "rear") ? "rear" : (faceI.value === "autre" ? "autre" : "front");
      const u = Math.max(1, parseInt(uI.value, 10) || 1), withEars = (face === "front") && (earsI.value !== "face");
      const merged = await StitchEditor.open(f1, f2, { faceRatio: this.faceImageRatio(face, u, withEars), faceRatioLabel: this.faceImageRatioLabel(face, u, withEars) });
      if (!merged) return;
      imgBlob = merged;
      if (tempUrl) URL.revokeObjectURL(tempUrl);
      tempUrl = URL.createObjectURL(merged); previewUrl = tempUrl;
      if (!nameI.value.trim() && f1.name) nameI.value = f1.name.replace(/\.[^.]+$/, "");
      syncPreview();
    };
    const importRow = document.createElement("div"); importRow.style.cssText = "margin-bottom:10px;display:flex;gap:8px;flex-wrap:wrap;"; importRow.append(importBtn, fixBtn, stitchBtn, dlBtn);
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.name"), nameI));
    // FACE d'abord : elle conditionne l'affichage du U (aucun pour « autre ») ET des oreilles (avant/arrière seulement).
    const faceI = FormControls.select([{ value: "front", label: I18n.t("domain.equipFace.front") }, { value: "rear", label: I18n.t("domain.equipFace.rear") }, { value: "autre", label: I18n.t("equipment.faceImage.faceOther") }], fi ? fi.face : ((preset && preset.face) || "front"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.face"), faceI, I18n.t("equipment.faceImage.faceHint")));
    const uI = FormControls.number(fi ? (fi.u_height || 1) : ((preset && preset.u_height) || 1), { min: 1, step: 1 });
    const uRow = FormControls.fieldRow(I18n.t("equipment.common.heightU"), uI, I18n.t("equipment.faceImage.uHint"));
    root.appendChild(uRow);
    // Oreilles 19″ : pertinent UNIQUEMENT pour la face AVANT (l'arrière n'a jamais d'oreilles). Défaut = avec.
    const earsI = FormControls.select([{ value: "ears", label: I18n.t("equipment.faceImage.earsWith") }, { value: "face", label: I18n.t("equipment.faceImage.earsFace") }], (fi ? fi.with_ears === false : (preset && preset.with_ears === false)) ? "face" : "ears");
    const earRow = FormControls.fieldRow(I18n.t("equipment.faceImage.render"), earsI, I18n.t("equipment.faceImage.renderHint"));
    root.appendChild(earRow);
    const descI = FormControls.textArea(fi ? fi.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.description"), descI));
    // « Autre » → ni U ni oreilles. Oreilles : AVANT uniquement (l'arrière n'en a jamais).
    const syncFaceDeps = () => { uRow.style.display = (faceI.value === "autre") ? "none" : ""; earRow.style.display = (faceI.value === "front") ? "" : "none"; };
    faceI.onchange = syncFaceDeps; syncFaceDeps();
    if (fi) { const uses = store.faceImageUsageCount(fi.id); const h = document.createElement("div"); h.className = "form-hint"; h.textContent = I18n.t("equipment.faceImage.usedBy", { count: uses, plural: uses > 1 ? "s" : "" }); root.appendChild(h); }
    // IMAGE + ACTIONS EN FIN de formulaire : Face / U / Oreilles pilotent le préréglage « Façade » du
    // redressement et de l'assemblage — on renseigne les champs D'ABORD, puis on agit sur l'image.
    root.appendChild(FormControls.fieldRow(I18n.t("equipment.faceImage.image"), previewWrap, I18n.t("equipment.faceImage.imageHint")));
    root.appendChild(importRow);
    syncPreview();
    const title = fi ? I18n.t("equipment.faceImage.titleEdit") : I18n.t("equipment.faceImage.titleNew");
    const subtitle = fi ? Html.escape(fi.name || "") : I18n.t("equipment.faceImage.subtitleNew");
    // Sauvegarde partagée (Modale OU Dialogue) : renvoie true si l'écriture a eu lieu (sinon false = bloqué/annulé).
    const doSave = async (): Promise<boolean> => {
      if (!fi && !imgBlob) { Notify.toast(I18n.t("equipment.faceImage.importFirst"), "err"); return false; }
      const face = (faceI.value === "rear") ? "rear" : (faceI.value === "autre" ? "autre" : "front");
      const meta = { name: nameI.value.trim(), u_height: (face === "autre") ? 1 : Math.max(1, parseInt(uI.value, 10) || 1), face, with_ears: (face === "front") && (earsI.value !== "face"), description: descI.value.trim() };
      let savedId: string | undefined = fi ? fi.id : undefined;
      if (fi) {
        if (imgBlob) { const n = store.faceImageUsageCount(fi.id); if (n > 1) { const ok = await Dialog.confirm({ title: I18n.t("equipment.faceImage.replaceTitle"), message: I18n.t("equipment.faceImage.replaceMsg", { count: n }), confirmLabel: I18n.t("equipment.faceImage.replace") }); if (!ok) return false; } }
        await images.update(fi.id, imgBlob ? Object.assign({}, meta, { blob: imgBlob, type: imgBlob.type }) : meta);
      } else { const added: any = await images.add(Object.assign({}, meta, { blob: imgBlob, type: (imgBlob as Blob).type })); savedId = added ? added.id : undefined; }
      if (tempUrl) URL.revokeObjectURL(tempUrl);
      host.setDirty?.(true); Notify.toast(fi ? I18n.t("equipment.faceImage.updated") : I18n.t("equipment.faceImage.added")); onSaved?.(savedId); return true;
    };
    if (asDialog) {
      // Hébergement DIALOGUE (empilable) : requis quand on ouvre CE formulaire par-dessus l'éditeur de façade,
      // lui-même un Dialog — la Modale unique (singleton) est occupée par le formulaire d'équipement.
      Dialog.custom({
        title, message: subtitle, wide: true, confirmLabel: fi ? I18n.t("ui.action.save") : I18n.t("equipment.faceImage.add"),
        build: (h: HTMLElement) => {
          h.appendChild(root);
          // validate BLOQUE la confirmation tant qu'aucune image (message d'erreur = string ; true = OK).
          return { validate: () => (!fi && !imgBlob) ? I18n.t("equipment.faceImage.importFirst") : true, collect: () => true };
        },
      }).then(async (ok: any) => {
        if (ok) { await doSave(); return; }
        if (tempUrl) URL.revokeObjectURL(tempUrl);   // édition ANNULÉE → l'objectURL de prévisualisation ne doit pas fuir
      });
    } else {
      host.openModal({ title, subtitle, body: root, onSave: doSave, onCancel: () => { if (tempUrl) URL.revokeObjectURL(tempUrl); } });
    }
    setTimeout(() => { if (!fi) importBtn.focus(); else nameI.focus(); }, 30);
  }

  /** Groupe d'équipements (stack/system/general). */
  static group(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const grp: any = id ? store.get("groups", id) : null;
    const root = document.createElement("div");
    const labelI = FormControls.text(grp ? grp.label : "", I18n.t("equipment.group.labelPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.label"), labelI));
    const typeI = FormControls.select(GroupTypes.ALL.map((t) => ({ value: t.id, label: I18n.t(t.labelKey) })), grp ? (grp.type || GroupTypes.DEFAULT) : GroupTypes.DEFAULT);
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.type"), typeI, I18n.t("equipment.group.typeHint")));
    let color: string | null = grp ? grp.color : null;
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.color"), ColorPalette.build(color, (c) => { color = c; }), I18n.t("equipment.group.colorHint")));
    const descI = FormControls.textArea(grp ? grp.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.description"), descI));
    const live = new LiveValidation("groups", { label: labelI, type: typeI });
    live.clearOnInput();

    host.openModal({
      title: grp ? I18n.t("equipment.group.titleEdit") : I18n.t("equipment.group.titleNew"),
      subtitle: grp ? Html.escape(grp.label) : "",
      body: root,
      onSave: async () => {
        const payload = { label: labelI.value.trim(), type: typeI.value || GroupTypes.DEFAULT, color: color || null, description: descI.value.trim() };
        if (live.check(payload).length) return false;   // label requis (surligné)
        if (grp) await store.update("groups", grp.id, payload); else await store.create("groups", payload);
        host.setDirty?.(true); Notify.toast(grp ? I18n.t("equipment.group.updated") : I18n.t("equipment.group.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => labelI.focus(), 30);
  }

  /** Spare (pièce de rechange) — formulaire DYNAMIQUE : champs communs + bloc spécifique au type
      (HDD/SSD · transceiver · autre) + attribution conditionnelle (statut « attribué » → équipement OU texte libre). */
  static spare(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const sp: any = id ? store.get("spares", id) : null;
    const root = document.createElement("div");
    const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };

    // -- type + identité --
    const typeI = FormControls.select(SpareTypes.ALL.map((t) => ({ value: t.id, label: I18n.t(t.labelKey) })), sp ? sp.type : SpareTypes.DEFAULT);   // <option> = texte seul (pas de SVG) : libellé nu
    const nameI = FormControls.text(sp ? sp.name : "", I18n.t("equipment.spare.namePlaceholder"));
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("lists.col.type"), typeI), FormControls.fieldRow(I18n.t("lists.col.designation"), nameI)));
    const brandI = FormControls.text(sp ? sp.brand : "", I18n.t("equipment.spare.brandPlaceholder"));
    const pnI = FormControls.text(sp ? sp.model_pn : "", I18n.t("equipment.spare.pnPlaceholder"));
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.field.brand"), brandI), FormControls.fieldRow(I18n.t("equipment.spare.modelPn"), pnI)));
    const serialI = FormControls.text(sp ? sp.serial : "", I18n.t("equipment.spare.serialPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("equipment.field.serialNum"), serialI));

    // -- bloc DISQUE (HDD/SSD) --
    const diskBlock = document.createElement("div");
    diskBlock.appendChild(FormUi.divider(I18n.t("equipment.spare.diskChars")));
    const capValI = FormControls.number(sp ? sp.capacity_value : "", { min: 0, step: 1, placeholder: I18n.t("equipment.spare.capacityPlaceholder") });
    const capUnitI = FormControls.select(SPARE_CAP_UNITS.map((u) => ({ value: u, label: u === "GB" ? I18n.t("equipment.spare.unitGo") : I18n.t("equipment.spare.unitTo") })), sp ? sp.capacity_unit : "GB");
    const ifaceI = FormControls.text(sp ? sp.interface : "", I18n.t("equipment.spare.ifacePlaceholder"));
    root.appendChild(FormControls.attachDatalist(ifaceI, "sp-iface", SPARE_HDD_INTERFACES));
    const fmtI = FormControls.text(sp ? sp.form_factor : "", I18n.t("equipment.spare.fmtPlaceholder"));
    root.appendChild(FormControls.attachDatalist(fmtI, "sp-fmt", SPARE_HDD_FORMATS));
    diskBlock.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.spare.capacity"), capValI), FormControls.fieldRow(I18n.t("equipment.spare.unit"), capUnitI), FormControls.fieldRow(I18n.t("equipment.spare.interface"), ifaceI), FormControls.fieldRow(I18n.t("equipment.spare.format"), fmtI)));
    const rpmI = FormControls.select([{ value: "", label: "—" }].concat(SPARE_HDD_RPM.map((r) => ({ value: String(r), label: I18n.t("equipment.spare.rpmOpt", { r }) }))), sp && sp.rpm != null ? String(sp.rpm) : "");
    const rpmRow = FormControls.fieldRow(I18n.t("equipment.spare.rpm"), rpmI, I18n.t("equipment.spare.rpmHint"));
    diskBlock.appendChild(rpmRow);
    root.appendChild(diskBlock);

    // -- bloc TRANSCEIVER --
    const txBlock = document.createElement("div");
    txBlock.appendChild(FormUi.divider(I18n.t("equipment.spare.txChars")));
    const txFormI = FormControls.select([{ value: "", label: "—" }].concat(SPARE_TX_FORMS.map((f) => ({ value: f, label: f }))), sp ? sp.tx_form : "");
    const txSpeedI = FormControls.select([{ value: "", label: "—" }].concat(SPARE_TX_SPEEDS.map((s) => ({ value: s, label: s }))), sp ? sp.tx_speed : "");
    const txMediaI = FormControls.text(sp ? sp.tx_media : "", I18n.t("equipment.spare.txMediaPlaceholder"));
    root.appendChild(FormControls.attachDatalist(txMediaI, "sp-txmedia", SPARE_TX_MEDIA));
    txBlock.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.spare.formFactor"), txFormI), FormControls.fieldRow(I18n.t("lists.col.speed"), txSpeedI), FormControls.fieldRow(I18n.t("equipment.spare.mediaConnector"), txMediaI)));
    const txReachI = FormControls.text(sp ? sp.tx_reach : "", I18n.t("equipment.spare.txReachPlaceholder"));
    txBlock.appendChild(FormControls.fieldRow(I18n.t("equipment.spare.reachWavelength"), txReachI));
    root.appendChild(txBlock);

    // -- bloc AUTRE --
    const otherBlock = document.createElement("div");
    otherBlock.appendChild(FormUi.divider(I18n.t("equipment.spare.chars")));
    const specsI = FormControls.textArea(sp ? sp.specs : "");
    otherBlock.appendChild(FormControls.fieldRow(I18n.t("equipment.spare.specs"), specsI, I18n.t("equipment.spare.specsHint")));
    root.appendChild(otherBlock);

    // -- statut + attribution --
    root.appendChild(FormUi.divider(I18n.t("equipment.spare.status")));
    const statusI = FormControls.select(SpareStatuses.ALL.map((s) => ({ value: s.id, label: I18n.t(s.labelKey) })), sp ? sp.status : SpareStatuses.DEFAULT);
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.status"), statusI));
    const assignBlock = document.createElement("div");
    const eqOpts = [{ value: "", label: I18n.t("equipment.spare.freeUnspecified") }].concat(
      store.all("equipments").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((e: any) => ({ value: e.id, label: e.name || I18n.t("forms.ph.equipment") })),
    );
    const eqI = FormControls.select(eqOpts, sp ? (sp.assigned_equipment_id || "") : "");
    const freeI = FormControls.text(sp ? sp.assigned_free : "", I18n.t("equipment.spare.freePlaceholder"));
    assignBlock.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.spare.assignedEquip"), eqI, I18n.t("equipment.spare.assignedHint")), FormControls.fieldRow(I18n.t("equipment.spare.freeAssign"), freeI)));
    const assignDateI: any = FormControls.date(sp ? sp.assigned_date : "");
    assignBlock.appendChild(FormControls.fieldRow(I18n.t("equipment.field.assignDate"), assignDateI));
    root.appendChild(assignBlock);

    // -- administratif --
    root.appendChild(FormUi.divider(I18n.t("equipment.field.admin")));
    const purchaseI: any = FormControls.date(sp ? sp.purchase_date : "");
    const poI = FormControls.text(sp ? sp.po_ref : "", I18n.t("equipment.field.poPlaceholder"));
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.field.purchaseDate"), purchaseI), FormControls.fieldRow(I18n.t("equipment.field.poRef"), poI)));
    const storageI = FormControls.text(sp ? sp.storage_location : "", I18n.t("equipment.spare.storagePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("equipment.spare.storageLocation"), storageI));
    const commentI = FormControls.textArea(sp ? sp.comment : "");
    root.appendChild(FormControls.fieldRow(I18n.t("equipment.spare.comment"), commentI));

    // -- visibilité dynamique --
    const syncType = () => {
      const t = typeI.value;
      const disk = SPARE_DISK_TYPES.includes(t);
      diskBlock.style.display = disk ? "" : "none";
      txBlock.style.display = (t === "transceiver") ? "" : "none";
      otherBlock.style.display = (t === "other") ? "" : "none";
      rpmRow.style.display = (t === "hdd") ? "" : "none";   // RPM = HDD seulement
    };
    const syncStatus = () => {
      const assigned = statusI.value === "assigned";
      assignBlock.style.display = assigned ? "" : "none";
      if (assigned && !assignDateI.value) assignDateI.value = today();   // pose la date d'attribution par défaut
    };
    typeI.onchange = syncType; statusI.onchange = syncStatus;
    eqI.onchange = () => { if (eqI.value) freeI.value = ""; };   // un équipement choisi → vide l'attribution libre
    syncType(); syncStatus();

    host.openModal({
      title: sp ? I18n.t("equipment.spare.titleEdit") : I18n.t("equipment.spare.titleNew"),
      subtitle: sp ? Html.escape(sp.displayName ? sp.displayName() : (sp.name || "")) : "",
      body: root,
      onSave: async () => {
        const type = typeI.value || SpareTypes.DEFAULT;
        const status = statusI.value || SpareStatuses.DEFAULT;
        const eqId = eqI.value || null;
        const payload: any = {
          type, name: nameI.value.trim(), brand: brandI.value.trim(), model_pn: pnI.value.trim(), serial: serialI.value.trim(),
          status,
          assigned_equipment_id: status === "assigned" ? eqId : null,
          assigned_free: status === "assigned" && !eqId ? freeI.value.trim() : "",
          assigned_date: status === "assigned" ? assignDateI.value : "",
          purchase_date: purchaseI.value, po_ref: poI.value.trim(), storage_location: storageI.value.trim(), comment: commentI.value.trim(),
          // disque
          capacity_value: SPARE_DISK_TYPES.includes(type) && capValI.value !== "" ? +capValI.value : null,
          capacity_unit: capUnitI.value || "GB",
          interface: SPARE_DISK_TYPES.includes(type) ? ifaceI.value.trim() : "",
          form_factor: SPARE_DISK_TYPES.includes(type) ? fmtI.value.trim() : "",
          rpm: type === "hdd" && rpmI.value ? +rpmI.value : null,
          // transceiver
          tx_form: type === "transceiver" ? txFormI.value : "",
          tx_speed: type === "transceiver" ? txSpeedI.value : "",
          tx_media: type === "transceiver" ? txMediaI.value.trim() : "",
          tx_reach: type === "transceiver" ? txReachI.value.trim() : "",
          // autre
          specs: type === "other" ? specsI.value.trim() : "",
        };
        if (sp) await store.update("spares", sp.id, payload); else await store.create("spares", payload);
        host.setDirty?.(true); Notify.toast(sp ? I18n.t("equipment.spare.updated") : I18n.t("equipment.spare.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** Équipement — formulaire CŒUR (identité · admin · groupe · dimensions · placement rack ·
      ports/agrégats · breakout trunk→lanes · éditeur de façade : pose des ports sur les faces).
      DIFFÉRÉ : placement latéral/paroi/étage et la BIBLIOTHÈQUE d'images de façade (IndexedDB) —
      les références d'image existantes sont préservées/détachables. */
  static equipment(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const eq: any = id ? store.get("equipments", id) : null;
    // brouillons (ids réels → FK ports↔agrégats tiennent avant l'enregistrement)
    const draftAggs: any[] = eq ? store.aggregatesOf(eq.id).map((a: any) => ({ id: a.id, name: a.name, description: a.description })) : [];
    const draftPorts: PortDraft[] = eq ? store.portsOf(eq.id).map((p: any) => ({
      id: p.id, name: p.name, port_type_id: p.port_type_id, role: p.role, aggregate_id: p.aggregate_id, description: p.description,
      parent_port_id: p.parent_port_id || null, lane: (p.lane != null) ? p.lane : null, face_x: p.face_x, face_y: p.face_y, face_side: p.face_side,
      // terminaison de faisceau (patch) : faisceau + brins physiques piochés
      bundle_id: p.bundle_id || null, strand_a: (p.strand_a != null) ? p.strand_a : null, strand_b: (p.strand_b != null) ? p.strand_b : null,
      // réseau asserté (port terminal ; source unique) — vide = joker
      network_id: p.network_id || null, network_ids: Array.isArray(p.network_ids) ? p.network_ids.slice() : [],
      // power : sens de l'énergie + calibre (A) + phase (départ)
      direction: p.direction || "", power_max_a: (p.power_max_a != null) ? p.power_max_a : null, phase: p.phase || "",
    })) : [];
    // brouillon des images de façade (référence par face) — l'éditeur de façade les reporte ici.
    const faceFids: Record<string, string | null> = {};
    EQUIP_FACE_IDS.forEach((f) => { faceFids[f] = eq ? (eq[EQUIP_FACE_IMG_FIELD[f]] || null) : null; });
    const root = document.createElement("div");

    // -- identité --
    const nameI = FormControls.text(eq ? eq.name : "", I18n.t("equipment.equip.namePlaceholder"));
    const curType = eq ? (eq.type || EQUIPMENT_TYPE_DEFAULT) : EQUIPMENT_TYPE_DEFAULT;
    let typeOpts = EquipmentTypes.ALL.map((t) => ({ value: t.id, label: I18n.t(t.labelKey) }));
    if (curType && !EquipmentTypes.ALL.some((t) => t.id === curType)) typeOpts = [{ value: curType, label: I18n.t("equipment.equip.outOfList", { type: curType }) }, ...typeOpts];
    const typeI = FormControls.select(typeOpts, curType);
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("lists.col.name"), nameI), FormControls.fieldRow(I18n.t("lists.col.type"), typeI)));

    const invI = FormControls.toggle(I18n.t("equipment.equip.invOnly"), eq ? !!eq.inventory_only : false, () => sync(), { block: true, title: I18n.t("equipment.equip.invOnlyTitle") });
    root.appendChild(invI);
    const brandI = FormControls.text(eq ? eq.brand : "", I18n.t("equipment.equip.brandPlaceholder"));
    const modelI = FormControls.text(eq ? eq.model : "", I18n.t("equipment.equip.modelPlaceholder"));
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.field.brand"), brandI), FormControls.fieldRow(I18n.t("equipment.field.model"), modelI)));
    const serialI = FormControls.text(eq ? eq.serial : "", I18n.t("equipment.equip.serialPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("equipment.field.serialNum"), serialI));

    // -- administratif --
    root.appendChild(FormUi.divider(I18n.t("equipment.field.admin")));
    const purchaseI = FormControls.date(eq ? eq.purchase_date : "");
    const warrantyI = FormControls.date(eq ? eq.warranty_end : "");
    const poI = FormControls.text(eq ? eq.po_ref : "", I18n.t("equipment.field.poPlaceholder"));
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.field.purchaseDate"), purchaseI), FormControls.fieldRow(I18n.t("equipment.field.warrantyEnd"), warrantyI), FormControls.fieldRow(I18n.t("equipment.field.poRef"), poI)));
    const assignDateI = FormControls.date(eq ? eq.assigned_date : "");
    const assignToI = FormControls.text(eq ? eq.assigned_to : "", I18n.t("equipment.equip.assignToPlaceholder"));
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.field.assignDate"), assignDateI), FormControls.fieldRow(I18n.t("equipment.field.assignedTo"), assignToI)));
    const pduI = FormControls.number((eq && eq.pdu_max_a != null) ? eq.pdu_max_a : "", { min: 0, step: 1, placeholder: I18n.t("equipment.equip.amperesPlaceholder") });
    const pduRow = FormControls.fieldRow(I18n.t("equipment.equip.maxCapacityA"), pduI, I18n.t("equipment.equip.pduHint"));
    root.appendChild(pduRow);
    // CONSOMMATION (W) d'un équipement consommateur — répartie sur ses ports power (sink). Courant déduit.
    const pNomI = FormControls.number((eq && eq.power_nominal_w != null) ? eq.power_nominal_w : "", { min: 0, step: 1, placeholder: I18n.t("equipment.equip.wattsPlaceholder") });
    const pMaxI = FormControls.number((eq && eq.power_max_w != null) ? eq.power_max_w : "", { min: 0, step: 1, placeholder: I18n.t("equipment.equip.wattsPlaceholder") });
    const consoRow = FormUi.row2(FormControls.fieldRow(I18n.t("equipment.equip.consoNominal"), pNomI, I18n.t("equipment.equip.consoNomHint")), FormControls.fieldRow(I18n.t("equipment.equip.consoMax"), pMaxI, I18n.t("equipment.equip.consoMaxHint")));
    root.appendChild(consoRow);

    // GROUPES : primaire (single, pilote la COULEUR héritée) + secondaires (multi, recherche + pastilles).
    const groupsSorted = (): any[] => store.all("groups").slice().sort((a: any, b: any) => (a.label || "").localeCompare(b.label || ""));
    const grpOpts = [{ value: "", label: I18n.t("forms.opt.none") }].concat(groupsSorted().map((g: any) => ({ value: g.id, label: g.label || I18n.t("lists.ph.noLabel") })));
    const groupI = FormControls.select(grpOpts, eq && eq.group_id ? eq.group_id : "");
    root.appendChild(FormControls.fieldRow(I18n.t("equipment.equip.primaryGroup"), groupI, I18n.t("equipment.equip.primaryGroupHint")));
    // secondaires = tous les groupes de l'équipement SAUF le primaire ; suggestions = groupes ≠ primaire courant.
    const initSecondary = eq ? store.equipmentGroupIds(eq).filter((gid: string) => gid !== (eq.group_id || null)) : [];
    const groupItems = (): ChipItem[] => groupsSorted().filter((g: any) => g.id !== groupI.value).map((g: any) => ({ id: g.id, label: g.label || I18n.t("lists.ph.noLabel"), color: g.color }));
    const secondaryGroups = ChipsInput.build({
      items: groupItems, value: initSecondary, placeholder: I18n.t("equipment.equip.addSecondary"),
      getLimit: () => host.autocompleteLimit ? host.autocompleteLimit() : FieldFacet.MAX_RESULTS_DEFAULT,
    });
    root.appendChild(FormControls.fieldRow(I18n.t("equipment.equip.secondaryGroups"), secondaryGroups.element, I18n.t("equipment.equip.secondaryHint")));
    // choisir le primaire le retire des secondaires (un groupe ne peut être primaire ET secondaire).
    groupI.addEventListener("change", () => { secondaryGroups.setValue(secondaryGroups.getValue().filter((gid) => gid !== groupI.value)); secondaryGroups.refresh(); });
    const descI = FormControls.textArea(eq ? eq.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.description"), descI));

    // -- dimensions + placement (sections « avancées », masquées en inventaire) --
    const adv = document.createElement("div");
    adv.appendChild(FormUi.divider(I18n.t("equipment.equip.dimensions")));
    const dimI = FormControls.select([{ value: "u", label: I18n.t("equipment.equip.dimU") }, { value: "free", label: I18n.t("equipment.equip.dimFree") }], eq ? (eq.dim_mode === "free" ? "free" : "u") : "u");
    adv.appendChild(FormControls.fieldRow(I18n.t("equipment.equip.sizing"), dimI));
    // U — PROFONDEUR en MM (l'enum full/half/quarter est retiré : valeurs STANDARDS + « Personnalisée… »
    // en saisie libre → depth_mm). L'occupation des faces est DÉCOUPLÉE : toggle locks_u explicite.
    const uBox = document.createElement("div");
    const uHI = FormControls.number(eq ? eq.u_height : 1, { min: 1, step: 1 });
    const curDepthMm: number = eq ? (eq.depth_mm != null ? eq.depth_mm : Depths.legacyToMm(eq.depth, RACK_DEPTH_DEFAULT)) : EQUIP_DEPTH_DEFAULT_MM;
    const depthSelI = FormControls.select(
      DEPTH_PRESETS_MM.map((v) => ({ value: String(v), label: I18n.t("equipment.equip.mmOpt", { v }) })).concat([{ value: "custom", label: I18n.t("equipment.equip.custom") }]),
      DEPTH_PRESETS_MM.includes(curDepthMm) ? String(curDepthMm) : "custom");
    const depthMmI = FormControls.number(curDepthMm, { min: 1, step: 10 });
    const depthWrap = document.createElement("div"); depthWrap.style.cssText = "display:flex;gap:6px;"; depthWrap.append(depthSelI, depthMmI);
    const syncDepth = () => { depthMmI.style.display = depthSelI.value === "custom" ? "" : "none"; if (depthSelI.value !== "custom") depthMmI.value = depthSelI.value; };
    depthSelI.addEventListener("change", syncDepth); syncDepth();
    // occupe les 2 faces (verrouille le U) — défaut COCHÉ (comportement « full » historique, sûr) ;
    // décocher permet deux équipements DOS À DOS au même U d'une baie double (la validation partagée
    // contrôle alors la somme des profondeurs — cf. shared/DataValidation V6d).
    const locksI = FormControls.toggle(I18n.t("equipment.equip.locksBoth"), eq ? RackGeometry.mountLocksU(eq) : true, () => { /* lu à l'enregistrement */ });
    const faceOffI = FormControls.number(eq && eq.face_offset_mm ? eq.face_offset_mm : 0, { min: 0, step: 5 });
    uBox.appendChild(FormUi.row2(
      FormControls.fieldRow(I18n.t("equipment.common.heightU"), uHI),
      FormControls.fieldRow(I18n.t("equipment.equip.depthMm"), depthWrap, I18n.t("equipment.equip.depthHint")),
      FormControls.fieldRow(I18n.t("equipment.equip.occupation"), locksI, I18n.t("equipment.equip.locksHint")),
      FormControls.fieldRow(I18n.t("equipment.equip.faceOffset"), faceOffI, I18n.t("equipment.equip.faceOffsetHint"))));
    // LARGEUR RÉELLE du boîtier (petit switch…) : vide = pleine largeur 19″ ; sinon < corps utile, avec un
    // ALIGNEMENT (vu de face). Les oreilles s'étendent alors des rails jusqu'au boîtier (3D + éditeur de façade).
    const uWI = FormControls.number((eq && eq.u_width_mm != null) ? eq.u_width_mm : "", { min: 1, step: 5, placeholder: I18n.t("equipment.equip.fullWidthPlaceholder") });
    const uAlignI = FormControls.select([{ value: "left", label: I18n.t("equipment.equip.alignLeft") }, { value: "center", label: I18n.t("equipment.equip.alignCenter") }, { value: "right", label: I18n.t("equipment.equip.alignRight") }], eq && (eq.u_align === "left" || eq.u_align === "right") ? eq.u_align : "center");
    const uAlignRow = FormControls.fieldRow(I18n.t("equipment.equip.alignment"), uAlignI, I18n.t("equipment.equip.alignHint"));
    uBox.appendChild(FormUi.row2(
      FormControls.fieldRow(I18n.t("equipment.equip.bodyWidth"), uWI, I18n.t("equipment.equip.bodyWidthHint", { max: RackGeometry.mountBodyWidth() })),
      uAlignRow));
    const syncUW = () => { uAlignRow.style.display = uWI.value !== "" ? "" : "none"; };
    uWI.addEventListener("input", syncUW); syncUW();
    adv.appendChild(uBox);
    // libre
    const freeBox = document.createElement("div");
    const flI = FormControls.number((eq && eq.free_l_mm != null) ? eq.free_l_mm : "", { min: 0, step: 1, placeholder: I18n.t("equipment.equip.lengthPlaceholder") });
    const fwI = FormControls.number((eq && eq.free_w_mm != null) ? eq.free_w_mm : "", { min: 0, step: 1, placeholder: I18n.t("equipment.equip.widthPlaceholder") });
    const fhI = FormControls.number((eq && eq.free_h_mm != null) ? eq.free_h_mm : "", { min: 0, step: 1, placeholder: I18n.t("equipment.equip.heightPlaceholder") });
    freeBox.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.equip.lengthMm"), flI), FormControls.fieldRow(I18n.t("equipment.common.widthMm"), fwI), FormControls.fieldRow(I18n.t("equipment.common.heightMm"), fhI)));
    adv.appendChild(freeBox);

    // placement en MODE LIBRE — principe n°10 : TOUT placement offert par les vues 2D/3D (poser au sol d'une
    // salle, monter en LATÉRAL ou en PAROI de baie, poser sur un PLAN D'ÉTAGE) a son équivalent FORMULAIRE.
    // Un sélecteur de MODE expose les champs propres à chaque placement ; à l'enregistrement, le mode choisi
    // pilote `placement_mode` et remet à zéro les champs des autres modes (les placements sont exclusifs).
    const rackChoices = store.all("racks").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((r: any) => ({ value: r.id, label: r.name || "(baie)" }));
    const salleBox = document.createElement("div");
    salleBox.appendChild(FormUi.divider(I18n.t("equipment.equip.placementFree")));
    const initPlaceMode = eq ? (["side", "wall", "floor", "tray"].includes(eq.placement_mode) ? eq.placement_mode : (eq.dc_id ? "sol" : "")) : "";
    const placeModeI = FormControls.select([
      { value: "", label: I18n.t("equipment.equip.placeNone") },
      { value: "sol", label: I18n.t("equipment.equip.placeFloor2") },
      { value: "side", label: I18n.t("equipment.equip.placeSide") },
      { value: "wall", label: I18n.t("equipment.equip.placeWall") },
      { value: "floor", label: I18n.t("equipment.equip.placeFloorPlan") },
      { value: "tray", label: I18n.t("equipment.equip.placeTray") },
    ], initPlaceMode);
    salleBox.appendChild(FormControls.fieldRow(I18n.t("equipment.equip.placeMode"), placeModeI, I18n.t("equipment.equip.placeModeHint")));

    // — au sol d'une salle (placement_mode « manual » + dc_id) : centre X/Y + hauteur Z + orientation —
    const solBox = document.createElement("div");
    const dcEqOpts = [{ value: "", label: I18n.t("equipment.equip.roomQ") }].concat(store.all("datacenters").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((d: any) => ({ value: d.id, label: d.name || I18n.t("lists.ph.room") })));
    const dcSelE = FormControls.select(dcEqOpts, eq && eq.dc_id ? eq.dc_id : "");
    solBox.appendChild(FormControls.fieldRow(I18n.t("equipment.common.dcField"), dcSelE, I18n.t("equipment.equip.solHint")));
    const exI = FormControls.number((eq && eq.dc_x != null) ? eq.dc_x : "", { min: 0, step: 10, placeholder: I18n.t("equipment.common.centerX") });
    const eyI = FormControls.number((eq && eq.dc_y != null) ? eq.dc_y : "", { min: 0, step: 10, placeholder: I18n.t("equipment.common.centerY") });
    const ezI = FormControls.number((eq && eq.dc_z != null) ? eq.dc_z : 0, { step: 10, placeholder: "0" });   // hauteur Z : négatif autorisé (pas de min)
    const eoI = FormControls.select(ORIENT_OPTS, String(Normalize.rackOrientation(eq ? eq.dc_orientation : 0)));
    const sallePos = FormUi.row2(FormControls.fieldRow(I18n.t("equipment.common.posX"), exI), FormControls.fieldRow(I18n.t("equipment.common.posY"), eyI), FormControls.fieldRow(I18n.t("equipment.equip.heightZ"), ezI), FormControls.fieldRow(I18n.t("equipment.common.orientation"), eoI));
    solBox.appendChild(sallePos);
    salleBox.appendChild(solBox);

    // — latéral (placement_mode « side ») : marge av/ar d'une baie, côté G/D, accroche, colonne, U du bord HAUT —
    const sideBox = document.createElement("div");
    const sideRackI = FormControls.select([{ value: "", label: I18n.t("equipment.equip.rackQ") }].concat(rackChoices), eq && eq.placement_mode === "side" && eq.rack_id ? eq.rack_id : "");
    const sideFaceI = FormControls.select([{ value: "front", label: I18n.t("equipment.equip.marginFront") }, { value: "rear", label: I18n.t("equipment.equip.marginRear") }], eq && eq.side_face === "rear" ? "rear" : "front");
    const sideLrI = FormControls.select([{ value: "left", label: I18n.t("equipment.common.left") }, { value: "right", label: I18n.t("equipment.common.right") }], eq && eq.side_lr === "right" ? "right" : "left");
    const sideSnapI = FormControls.select([{ value: "post", label: I18n.t("equipment.equip.snapPost") }, { value: "wall", label: I18n.t("equipment.equip.snapWall") }], eq && eq.side_snap === "wall" ? "wall" : "post");
    const sideColI = FormControls.select([{ value: "0", label: I18n.t("equipment.equip.col1") }, { value: "1", label: I18n.t("equipment.equip.col2") }], String(eq && eq.side_col === 1 ? 1 : 0));
    const sideUI = FormControls.number((eq && eq.side_u != null) ? eq.side_u : 1, { min: 1, step: 1, placeholder: I18n.t("equipment.equip.uTopPlaceholder") });
    sideBox.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.common.rackField"), sideRackI), FormControls.fieldRow(I18n.t("equipment.equip.margin"), sideFaceI), FormControls.fieldRow(I18n.t("equipment.equip.side"), sideLrI)));
    sideBox.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.equip.snap"), sideSnapI), FormControls.fieldRow(I18n.t("equipment.equip.column"), sideColI), FormControls.fieldRow(I18n.t("equipment.equip.posUTop"), sideUI)));
    salleBox.appendChild(sideBox);

    // — paroi de baie (placement_mode « wall ») : paroi G/D, marge av/ar, colonne, U de base, orientation de face —
    const wallBox = document.createElement("div");
    const wallRackI = FormControls.select([{ value: "", label: I18n.t("equipment.equip.rackQ") }].concat(rackChoices), eq && eq.placement_mode === "wall" && eq.rack_id ? eq.rack_id : "");
    const wallLrI = FormControls.select([{ value: "left", label: I18n.t("equipment.equip.wallLeft") }, { value: "right", label: I18n.t("equipment.equip.wallRight") }], eq && eq.wall_lr === "right" ? "right" : "left");
    const wallMarginI = FormControls.select([{ value: "front", label: I18n.t("equipment.equip.marginFront") }, { value: "rear", label: I18n.t("equipment.equip.marginRear") }], eq && eq.wall_margin === "rear" ? "rear" : "front");
    const wallColI = FormControls.number((eq && eq.wall_col != null) ? eq.wall_col : 0, { min: 0, step: 1, placeholder: "0" });
    const wallUI = FormControls.number((eq && eq.wall_u != null) ? eq.wall_u : 1, { min: 1, step: 1, placeholder: I18n.t("equipment.equip.uBasePlaceholder") });
    const wallOrientI = FormControls.select([{ value: "center", label: I18n.t("equipment.equip.orientCenter2") }, { value: "facade", label: I18n.t("equipment.equip.orientFacade2") }], eq && eq.wall_orient === "facade" ? "facade" : "center");
    wallBox.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.common.rackField"), wallRackI), FormControls.fieldRow(I18n.t("equipment.equip.wall"), wallLrI), FormControls.fieldRow(I18n.t("equipment.equip.margin"), wallMarginI)));
    wallBox.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.equip.column"), wallColI), FormControls.fieldRow(I18n.t("equipment.equip.posUBase"), wallUI), FormControls.fieldRow(I18n.t("equipment.equip.faceOriented"), wallOrientI)));
    salleBox.appendChild(wallBox);

    // — posé sur une ÉTAGÈRE (placement_mode « tray ») : étagère hôte + position sur le plateau + orientation —
    const trayBox = document.createElement("div");
    const trayChoices = store.all("rackItems")
      .filter((it: any) => it.kind === "tray" && it.rack_id && it.u != null)
      .map((it: any) => { const rk: any = store.get("racks", it.rack_id); return { value: it.id, label: ((rk && rk.name) || I18n.t("lists.ph.rack")) + " · U" + it.u + (it.label ? " · " + it.label : "") }; })
      .sort((a: any, b: any) => a.label.localeCompare(b.label));
    const traySelI = FormControls.select([{ value: "", label: I18n.t("equipment.equip.trayQ") }].concat(trayChoices), eq && eq.placement_mode === "tray" && eq.tray_item_id ? eq.tray_item_id : "");
    const txI = FormControls.number((eq && eq.tray_x != null) ? eq.tray_x : "", { min: 0, step: 10, placeholder: I18n.t("equipment.equip.autoPlaceholder") });
    const tyI = FormControls.number((eq && eq.tray_y != null) ? eq.tray_y : "", { min: 0, step: 10, placeholder: I18n.t("equipment.equip.autoPlaceholder") });
    const tOrI = FormControls.select(ORIENT_OPTS, String(Normalize.rackOrientation(eq ? eq.dc_orientation : 0)));
    trayBox.appendChild(FormControls.fieldRow(I18n.t("equipment.equip.tray"), traySelI, I18n.t("equipment.equip.trayHint")));
    trayBox.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.common.posX"), txI), FormControls.fieldRow(I18n.t("equipment.equip.depthY"), tyI), FormControls.fieldRow(I18n.t("equipment.common.orientation"), tOrI)));
    salleBox.appendChild(trayBox);

    // — plan d'étage (placement_mode « floor ») : bâtiment + étage, centre X/Y (vide = à localiser), orientation —
    const floorBox = document.createElement("div");
    const fLocI = FormControls.select(FormUi.locOptions(store), eq && eq.placement_mode === "floor" ? (eq.location || "") : "");
    const fFloorI = FormControls.select(FormUi.floorOptions(eq ? String(eq.floor ?? "") : ""), eq && eq.placement_mode === "floor" ? String(eq.floor ?? "") : "");
    floorBox.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.equip.buildingLoc"), fLocI), FormControls.fieldRow(I18n.t("lists.col.floor"), fFloorI)));
    const fxI = FormControls.number((eq && eq.floor_x != null) ? eq.floor_x : "", { min: 0, step: 10, placeholder: I18n.t("equipment.common.centerX") });
    const fyI = FormControls.number((eq && eq.floor_y != null) ? eq.floor_y : "", { min: 0, step: 10, placeholder: I18n.t("equipment.common.centerY") });
    const fOrI = FormControls.select(ORIENT_OPTS, String(Normalize.rackOrientation(eq ? eq.dc_orientation : 0)));
    floorBox.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.common.posX"), fxI), FormControls.fieldRow(I18n.t("equipment.common.posY"), fyI), FormControls.fieldRow(I18n.t("equipment.common.orientation"), fOrI)));
    salleBox.appendChild(floorBox);

    const placeFreeHint = document.createElement("div"); placeFreeHint.className = "form-hint"; salleBox.appendChild(placeFreeHint);
    const PLACE_HINTS: Record<string, string> = {
      "": I18n.t("equipment.equip.hintNone"),
      sol: I18n.t("equipment.equip.hintSol"),
      side: I18n.t("equipment.equip.hintSide"),
      wall: I18n.t("equipment.equip.hintWall"),
      floor: I18n.t("equipment.equip.hintFloor"),
      tray: I18n.t("equipment.equip.hintTray"),
    };
    const syncSalle = () => {
      const m = placeModeI.value;
      solBox.style.display = m === "sol" ? "" : "none";
      sideBox.style.display = m === "side" ? "" : "none";
      wallBox.style.display = m === "wall" ? "" : "none";
      floorBox.style.display = m === "floor" ? "" : "none";
      trayBox.style.display = m === "tray" ? "" : "none";
      if (m === "sol") sallePos.style.display = dcSelE.value ? "" : "none";
      placeFreeHint.textContent = (m === "sol" && !dcSelE.value) ? I18n.t("equipment.equip.chooseSol") : PLACE_HINTS[m] || "";
    };
    placeModeI.onchange = syncSalle; dcSelE.onchange = syncSalle; syncSalle();
    adv.appendChild(salleBox);

    // placement rack (mode U seulement, dans ce cœur)
    const placeBox = document.createElement("div");
    placeBox.appendChild(FormUi.divider(I18n.t("equipment.equip.placementRack")));
    const rackOpts = [{ value: "", label: I18n.t("equipment.equip.placeNone") }].concat(store.all("racks").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((r: any) => ({ value: r.id, label: r.name || I18n.t("lists.ph.rack") })));
    const rackI = FormControls.select(rackOpts, eq && eq.placement_mode === "rack" && eq.rack_id ? eq.rack_id : "");
    const rackUI = FormControls.number((eq && eq.rack_u != null) ? eq.rack_u : "", { min: 1, step: 1, placeholder: I18n.t("equipment.equip.rackUPlaceholder") });
    placeBox.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("equipment.common.rackField"), rackI), FormControls.fieldRow(I18n.t("equipment.equip.posU"), rackUI)));
    const placeHint = document.createElement("div"); placeHint.className = "form-hint";
    placeHint.textContent = I18n.t("equipment.equip.rackPlaceHint");
    placeBox.appendChild(placeHint);
    adv.appendChild(placeBox);

    // Verrou de positionnement : empêche déplacer / pivoter / retirer l'équipement DEPUIS LES VUES 2D/3D (cf.
    // PlacementLock). Ce formulaire reste l'échappatoire (principe n°10) : placement modifiable même verrouillé.
    const lockedI = FormControls.toggle(I18n.t("equipment.common.lockPos"), !!(eq && eq.locked), () => {}, { block: true, icon: Icons.LOCK, title: I18n.t("equipment.equip.lockTitle") });
    adv.appendChild(lockedI);

    // -- agrégats (LAG / bond) --
    adv.appendChild(FormUi.divider(I18n.t("equipment.equip.aggregates")));
    const aggList = document.createElement("div"); aggList.className = "chip-list"; adv.appendChild(aggList);
    const addAggBtn = document.createElement("button"); addAggBtn.type = "button"; addAggBtn.className = "btn btn-ghost btn-sm"; addAggBtn.textContent = I18n.t("equipment.equip.addAgg"); addAggBtn.style.marginTop = "8px"; adv.appendChild(addAggBtn);

    // -- ports (+ breakout : trunk éclaté en N lanes ; + façade : pose des ports sur les faces) --
    const portDiv = document.createElement("div"); portDiv.className = "section-divider"; portDiv.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;";
    const portDivLabel = document.createElement("span"); portDivLabel.textContent = I18n.t("equipment.equip.ports"); portDiv.appendChild(portDivLabel);
    if (eq) {   // sous-éditeur empilé opérant sur le brouillon (ports en cours d'ajout présents)
      const faceBtn = document.createElement("button"); faceBtn.type = "button"; faceBtn.className = "btn btn-ghost btn-sm"; faceBtn.textContent = I18n.t("equipment.equip.faceBtn");
      faceBtn.title = I18n.t("equipment.equip.faceBtnTitle");
      faceBtn.onclick = () => FaceEditor.open(store, host, eq.id, {
        ports: draftPorts, fids: faceFids,
        onApply: ({ fids, place }: any) => {
          EQUIP_FACE_IDS.forEach((f) => { if (f in fids) faceFids[f] = fids[f]; });
          draftPorts.forEach((p) => { if (p.parent_port_id) return; const pos = place[p.id]; if (pos) { p.face_x = pos.x; p.face_y = pos.y; p.face_side = pos.side; } else { p.face_x = null; p.face_y = null; } });
          host.setDirty?.(true); Notify.toast(I18n.t("equipment.equip.faceApplied"));
        },
      });
      portDiv.appendChild(faceBtn);
    }
    adv.appendChild(portDiv);
    const portList = document.createElement("div"); portList.className = "chip-list"; adv.appendChild(portList);
    const portBtns = document.createElement("div"); portBtns.style.cssText = "display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;";
    const addPortBtn = document.createElement("button"); addPortBtn.type = "button"; addPortBtn.className = "btn btn-ghost btn-sm"; addPortBtn.textContent = I18n.t("equipment.equip.addPort");
    const addBreakoutBtn = document.createElement("button"); addBreakoutBtn.type = "button"; addBreakoutBtn.className = "btn btn-ghost btn-sm"; addBreakoutBtn.textContent = I18n.t("equipment.equip.addBreakout");
    addBreakoutBtn.title = I18n.t("equipment.equip.breakoutTitle");
    portBtns.append(addPortBtn, addBreakoutBtn); adv.appendChild(portBtns);
    // PATCH : résumé d'occupation des faisceaux terminés par cet équipement (brins utilisés / capacité).
    const patchInfo = document.createElement("div"); patchInfo.className = "form-hint"; patchInfo.style.marginTop = "6px"; adv.appendChild(patchInfo);
    // POWER : charge par départ/phase (tableau/PDU) + avertissements de fiabilité (SPOF, PSU non câblée…).
    const powerInfo = document.createElement("div"); powerInfo.style.marginTop = "6px"; adv.appendChild(powerInfo);

    const isDraftTrunk = (p: any) => draftPorts.some((c) => c.parent_port_id === p.id);
    const ptKind = (t: any) => (t && t.kind === "power") ? "power" : "data";
    const ptOptions = (selected: string | null, role: string) => {
      const kind = PortRoles.kind(role);
      // tri FAMILLE→nom → les <optgroup> (par famille) apparaissent groupés et ordonnés ; le libellé garde le nom.
      const list = store.all("portTypes").filter((t: any) => ptKind(t) === kind).sort((a: any, b: any) => (a.family || "").localeCompare(b.family || "") || a.name.localeCompare(b.name));
      const opts: any[] = [{ value: "", label: I18n.t("equipment.equip.typeQ") }].concat(list.map((t: any) => ({ value: t.id, label: t.name, group: t.family || I18n.t("equipment.equip.noFamily") })));
      if (selected && !list.some((t: any) => t.id === selected)) { const cur: any = store.get("portTypes", selected); if (cur) opts.push({ value: cur.id, label: I18n.t("equipment.equip.outOfRole", { name: cur.name }), group: cur.family || I18n.t("equipment.equip.noFamily") }); }
      return FormControls.select(opts, selected || "");
    };
    const aggOptionsFor = (p: any) => FormControls.select([{ value: "", label: I18n.t("forms.opt.none") }].concat(draftAggs.map((a) => ({ value: a.id, label: a.name || I18n.t("equipment.equip.aggFallback") }))), p.aggregate_id || "");
    const bump = (s: string) => { s = String(s || ""); const m = s.match(/^(.*?)(\d+)(\D*)$/); return m ? m[1] + String(parseInt(m[2], 10) + 1).padStart(m[2].length, "0") + m[3] : (s ? s + "2" : ""); };

    // -- PATCH : affectation de brins par port. Sur un patch, chaque port « pioche » 1 (simplex) ou 2 (duplex Tx/Rx)
    //    brins physiques dans le POOL d'un faisceau que ce patch termine (endpoint_a/b). Le 2e brin n'apparaît que
    //    si le connecteur est duplex (PortType.duplex). Remplace la combo d'agrégat (sans objet sur un patch).
    // Sous-UI d'édition d'un port (brins de patch / réseau terminal / power) + panneaux de synthèse : la logique
    // vit dans PortEditorControls (module dédié piloté par une interface HÔTE — CLAUDE.md n°2). Ici on ne garde
    // que de fins branchements (mêmes call-sites) + l'adaptation au contexte du formulaire (typeI, renderPorts).
    const portControls = new PortEditorControls({ store, equipment: eq, currentType: () => typeI.value, rerenderPorts: () => renderPorts() });
    const isPatch = () => portControls.isPatch();
    const patchStrandControls = (p: any) => portControls.patchStrandControls(p);
    const terminalNetworkControl = (p: any) => portControls.terminalNetworkControl(p);
    const powerPortControls = (p: any) => portControls.powerPortControls(p);

    const renderAggs = () => {
      aggList.innerHTML = "";
      if (!draftAggs.length) { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = I18n.t("equipment.equip.noAggs"); aggList.appendChild(e); }
      draftAggs.forEach((a, idx) => {
        const r = document.createElement("div"); r.className = "chip-row";
        const nm = document.createElement("input"); nm.className = "sub-input grow"; nm.value = a.name; nm.placeholder = I18n.t("equipment.equip.aggNamePlaceholder"); nm.oninput = () => { a.name = nm.value; };
        const rm = document.createElement("button"); rm.type = "button"; rm.className = "btn btn-danger btn-sm"; rm.textContent = "×";
        rm.onclick = () => { const removed = draftAggs.splice(idx, 1)[0]; draftPorts.forEach((p) => { if (p.aggregate_id === removed.id) p.aggregate_id = null; }); renderAggs(); renderPorts(); };
        r.appendChild(nm); r.appendChild(rm); aggList.appendChild(r);
      });
    };
    const portRow = (p: any, kind: string) => {
      const locked = kind === "trunk" || kind === "lane";
      const r = document.createElement("div"); r.className = "chip-row";
      if (kind === "lane") r.style.cssText = "margin-left:18px;border-left:2px solid var(--line-2);padding-left:8px;";
      const nm = document.createElement("input"); nm.className = "sub-input grow"; nm.value = p.name; nm.placeholder = kind === "trunk" ? I18n.t("equipment.equip.trunkPh") : (kind === "lane" ? I18n.t("equipment.equip.lanePh") : I18n.t("equipment.equip.portPh")); nm.oninput = () => { p.name = nm.value; };
      r.appendChild(nm);
      if (locked) {
        const rPill = document.createElement("span"); rPill.className = "pill"; rPill.textContent = PortRoles.label(p.role);
        const tt: any = p.port_type_id ? store.get("portTypes", p.port_type_id) : null;
        const tPill = document.createElement("span"); tPill.className = "pill"; tPill.textContent = tt ? tt.name : I18n.t("equipment.detail.typeUnknown");
        r.appendChild(rPill); r.appendChild(tPill);
      } else {
        const rl = FormControls.select(PortRoles.ALL.map((x) => ({ value: x.id, label: I18n.t(x.labelKey) })), p.role || "data"); rl.className = "sub-input app-select";
        const pt = ptOptions(p.port_type_id, p.role); pt.className = "sub-input app-select";
        rl.onchange = () => { p.role = rl.value; const cur: any = p.port_type_id ? store.get("portTypes", p.port_type_id) : null; if (cur && ptKind(cur) !== PortRoles.kind(p.role)) p.port_type_id = null; if (PortRoles.kind(p.role) === "power") p.aggregate_id = null; renderPorts(); };
        pt.onchange = () => { p.port_type_id = pt.value || null; renderPorts(); };
        r.appendChild(rl); r.appendChild(pt);
      }
      if (kind === "trunk") {
        const tag = document.createElement("span"); tag.className = "pill"; tag.textContent = I18n.t("equipment.equip.breakoutTag", { n: draftPorts.filter((c) => c.parent_port_id === p.id).length });
        const rm = document.createElement("button"); rm.type = "button"; rm.className = "btn btn-danger btn-sm"; rm.textContent = "×"; rm.title = I18n.t("equipment.equip.removeBreakout");
        rm.onclick = () => { const ids = new Set([p.id, ...draftPorts.filter((c) => c.parent_port_id === p.id).map((c) => c.id)]); for (let i = draftPorts.length - 1; i >= 0; i--) if (ids.has(draftPorts[i].id)) draftPorts.splice(i, 1); renderPorts(); };
        r.appendChild(tag); r.appendChild(rm);
      } else if (kind === "lane") {
        const tag = document.createElement("span"); tag.className = "pill"; tag.textContent = I18n.t("equipment.equip.laneTag", { lane: p.lane || "?" }); r.appendChild(tag);
      } else {
        // PATCH : affectation de brins (le patch déduit son réseau — pas d'agrégat ni de réseau saisi ici).
        // TERMINAL : combo d'agrégat (hors power) + sélecteur de réseau asserté (source unique).
        if (isPatch()) { r.appendChild(patchStrandControls(p)); }
        else {
          if (PortRoles.kind(p.role) === "power") { r.appendChild(powerPortControls(p)); }   // sens/calibre/phase
          else { const ag = aggOptionsFor(p); ag.className = "sub-input app-select"; ag.onchange = () => { p.aggregate_id = ag.value || null; }; r.appendChild(ag); }
          r.appendChild(terminalNetworkControl(p));
        }
        const dup = document.createElement("button"); dup.type = "button"; dup.className = "btn btn-ghost btn-sm"; dup.textContent = "⎘"; dup.title = I18n.t("equipment.equip.duplicate");
        // le doublon ne réutilise PAS les mêmes brins physiques (un brin = une fibre unique) : brins remis à zéro.
        dup.onclick = () => { const i = draftPorts.indexOf(p); draftPorts.splice(i + 1, 0, Object.assign({}, p, { id: Id.uid(), name: bump(p.name), face_x: null, face_y: null, strand_a: null, strand_b: null })); renderPorts(); };
        const rm = document.createElement("button"); rm.type = "button"; rm.className = "btn btn-danger btn-sm"; rm.textContent = "×";
        rm.onclick = () => { const i = draftPorts.indexOf(p); if (i >= 0) draftPorts.splice(i, 1); renderPorts(); };
        r.appendChild(dup); r.appendChild(rm);
      }
      return r;
    };
    const renderPorts = () => {
      portList.innerHTML = "";
      if (!draftPorts.length) { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = I18n.t("equipment.detail.noPorts"); portList.appendChild(e); }
      draftPorts.filter((p) => !p.parent_port_id).forEach((p) => {
        if (isDraftTrunk(p)) { portList.appendChild(portRow(p, "trunk")); draftPorts.filter((c) => c.parent_port_id === p.id).sort((a, b) => (a.lane || 0) - (b.lane || 0)).forEach((l) => portList.appendChild(portRow(l, "lane"))); }
        else portList.appendChild(portRow(p, "normal"));
      });
      renderPatchInfo();
      renderPowerInfo();
    };
    // Panneaux de synthèse (occupation patch / charge+warnings power) : rendus par le module dans leur élément.
    const renderPatchInfo = () => portControls.renderPatchInfo(patchInfo);
    const renderPowerInfo = () => portControls.renderPowerInfo(powerInfo);
    addAggBtn.onclick = () => { draftAggs.push({ id: Id.uid(), name: "", description: "" }); renderAggs(); renderPorts(); };
    addPortBtn.onclick = () => { const firstPt: any = store.all("portTypes").find((t: any) => ptKind(t) !== "power") || store.all("portTypes")[0]; draftPorts.push({ id: Id.uid(), name: "", port_type_id: firstPt ? firstPt.id : null, role: "data", aggregate_id: null, description: "" }); renderPorts(); };
    addBreakoutBtn.onclick = () => this.configureBreakout(store).then((cfg) => {
      if (!cfg) return;
      host.setDirty?.(true);
      const trunkId = Id.uid();
      draftPorts.push({ id: trunkId, name: cfg.name, port_type_id: cfg.trunkTypeId || null, role: "data", aggregate_id: null, description: "", parent_port_id: null, lane: null });
      for (let i = 1; i <= cfg.count; i++) draftPorts.push({ id: Id.uid(), name: cfg.name + "/" + i, port_type_id: cfg.laneTypeId || null, role: "data", aggregate_id: null, description: "", parent_port_id: trunkId, lane: i });
      renderPorts();
    });
    renderAggs(); renderPorts();

    root.appendChild(adv);

    const sync = () => {
      const inv = (invI as any).checked, u = dimI.value === "u";
      adv.style.display = inv ? "none" : "";
      uBox.style.display = u ? "" : "none";
      freeBox.style.display = u ? "none" : "";
      placeBox.style.display = u ? "" : "none";   // placement rack du cœur = mode U
      salleBox.style.display = u ? "none" : "";    // placement en salle (au sol) = mode Libre
      if (!u) syncSalle();
      pduRow.style.display = (typeI.value === "pdu" || typeI.value === "tableau") ? "" : "none";
      consoRow.style.display = (typeI.value === "tableau") ? "none" : "";   // un tableau fournit, il ne consomme pas
    };
    dimI.addEventListener("change", sync); typeI.addEventListener("change", sync);
    // changer de type (→/depuis patch_panel) bascule l'affichage brins ↔ agrégat des ports. Passer À « patch »
    // RETIRE le réseau des ports (un patch ne porte rien, il déduit — cf. validation T7) : on le fait VISIBLEMENT
    // ici (toast), pas silencieusement au save, pour que l'utilisateur voie la conséquence de son changement.
    // P2a : le retrait est RÉVERSIBLE — on stashe les réseaux retirés et on les restaure si l'utilisateur re-choisit
    // un type terminal (re-sélectionner l'ancien type NE doit PAS perdre les assertions ; seul le save les scelle).
    const stashedNets = new Map<string, { network_id: any; network_ids: any[] }>();
    typeI.addEventListener("change", () => {
      if (typeI.value === "patch_panel") {
        const withNet = draftPorts.filter((p) => p.network_id || (Array.isArray(p.network_ids) && p.network_ids.length));
        if (withNet.length) {
          withNet.forEach((p) => {
            stashedNets.set(p.id, { network_id: p.network_id, network_ids: Array.isArray(p.network_ids) ? p.network_ids.slice() : [] });
            p.network_id = null; p.network_ids = [];
          });
          Notify.toast(I18n.t("equipment.equip.patchNetRemoved", { count: withNet.length }));
        }
      } else if (stashedNets.size) {
        // retour à un type TERMINAL : restaure les réseaux stashés — sauf les ports disparus ou ré-assignés entre-temps.
        let restored = 0;
        stashedNets.forEach((v, id) => {
          const p = draftPorts.find((d) => d.id === id);
          if (p && !p.network_id && !(Array.isArray(p.network_ids) && p.network_ids.length)) { p.network_id = v.network_id; p.network_ids = v.network_ids; restored++; }
        });
        stashedNets.clear();
        if (restored) Notify.toast(I18n.t("equipment.equip.patchNetRestored", { count: restored }));
      }
      renderPorts();
    });
    sync();

    // validation live (mêmes règles que le Store/serveur) : surligne le(s) champ(s) fautif(s) à l'enregistrement.
    const live = new LiveValidation("equipments", { name: nameI, type: typeI, u_height: uHI, u_width_mm: uWI, depth_mm: depthMmI, group_id: groupI, rack_id: rackI, pdu_max_a: pduI, tray_item_id: traySelI, tray_x: txI, tray_y: tyI, free_h_mm: fhI }, (c, i) => store.get(c, i) || null);
    live.clearOnInput();

    // N1 : en CRÉATION, si un port est refusé (saveError plus bas), on garde la modale ouverte — MAIS l'équipement +
    // agrégats + ports valides sont DÉJÀ persistés. Sans mémoire de l'id créé, un re-save recréerait un 2e équipement
    // (agrégats à id dupliqué, ports orphelins re-parentés, TypeError si le 2e create est refusé). On mémorise l'id
    // créé HORS onSave (survit aux re-saves de la même modale) → au retry, on UPDATE au lieu de recréer.
    let createdId: string | null = null;

    host.openModal({
      title: eq ? I18n.t("equipment.equip.titleEdit") : I18n.t("equipment.equip.titleNew"),
      subtitle: eq ? Html.escape(eq.name || "") : I18n.t("equipment.equip.subtitleNew"),
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim();
        const inv = (invI as any).checked, free = dimI.value === "free";
        // GROUPES : group_id = primaire ; group_ids = primaire + secondaires (dédupliqués), le primaire en tête.
        const primaryGroup = groupI.value || null;
        const secondary = secondaryGroups.getValue().filter((gid) => gid && gid !== primaryGroup);
        const groupIds = [...new Set([...(primaryGroup ? [primaryGroup] : []), ...secondary])];
        const payload: any = {
          name, type: typeI.value, brand: brandI.value.trim(), model: modelI.value.trim(), serial: serialI.value.trim(),
          inventory_only: inv, locked: (lockedI as any).checked, group_id: primaryGroup, group_ids: groupIds, description: descI.value.trim(),
          purchase_date: (purchaseI as any).value || "", warranty_end: (warrantyI as any).value || "", po_ref: poI.value.trim(),
          assigned_date: (assignDateI as any).value || "", assigned_to: assignToI.value.trim(),
          pdu_max_a: pduI.value !== "" ? Math.max(0, parseInt(pduI.value, 10) || 0) : null,
          power_nominal_w: pNomI.value !== "" ? Math.max(0, parseInt(pNomI.value, 10) || 0) : null,
          power_max_w: pMaxI.value !== "" ? Math.max(0, parseInt(pMaxI.value, 10) || 0) : null,
          dim_mode: free ? "free" : "u",
        };
        // images de façade (référence par face) — appliquées via l'éditeur de façade, persistées ici.
        EQUIP_FACE_IDS.forEach((f) => { payload[EQUIP_FACE_IMG_FIELD[f]] = faceFids[f] || null; });
        if (free) {
          payload.free_l_mm = flI.value !== "" ? Math.max(0, parseInt(flI.value, 10) || 0) : null;
          payload.free_w_mm = fwI.value !== "" ? Math.max(0, parseInt(fwI.value, 10) || 0) : null;
          payload.free_h_mm = fhI.value !== "" ? Math.max(0, parseInt(fhI.value, 10) || 0) : null;
          // placement (principe n°10) : le MODE choisi pilote les champs persistés ; les champs des AUTRES
          // modes sont remis à zéro — les placements sont exclusifs (comme les actions des vues 2D/3D).
          const pm = placeModeI.value;
          const placeDcE: any = (pm === "sol" && dcSelE.value) ? store.get("datacenters", dcSelE.value) : null;
          // garde-fou explicite : latéral/paroi exigent une baie (invariant partagé) — le sélecteur de baie
          // n'est pas couvert par la validation live (champ propre au mode), on le signale ici.
          if ((pm === "side" && !sideRackI.value) || (pm === "wall" && !wallRackI.value)) { Notify.toast(I18n.t("equipment.equip.chooseRackMount", { mount: pm === "side" ? I18n.t("equipment.equip.mountSide") : I18n.t("equipment.equip.mountWall") }), "err"); return false; }
          if (pm === "floor" && !fLocI.value) { Notify.toast(I18n.t("equipment.equip.chooseBuilding"), "err"); return false; }
          if (pm === "tray" && !traySelI.value) { Notify.toast(I18n.t("equipment.equip.chooseTray"), "err"); return false; }
          payload.dc_id = null; payload.dc_x = null; payload.dc_y = null;
          payload.rack_id = null; payload.rack_u = null;
          payload.floor_x = null; payload.floor_y = null;
          payload.tray_item_id = null; payload.tray_x = null; payload.tray_y = null;
          payload.placement_mode = "manual";
          if (placeDcE) {   // au sol d'une salle (mode « manual » + dc_id)
            payload.dc_id = placeDcE.id;
            payload.dc_x = exI.value !== "" ? Math.max(0, parseInt(exI.value, 10) || 0) : Math.round(placeDcE.width_mm / 2);
            payload.dc_y = eyI.value !== "" ? Math.max(0, parseInt(eyI.value, 10) || 0) : Math.round(placeDcE.depth_mm / 2);
            payload.dc_z = ezI.value !== "" ? (parseInt(ezI.value, 10) || 0) : 0;   // négatif autorisé
            payload.dc_orientation = Normalize.rackOrientation(parseInt(eoI.value, 10) || 0);
          } else if (pm === "side") {
            payload.placement_mode = "side"; payload.rack_id = sideRackI.value;
            payload.side_face = sideFaceI.value; payload.side_lr = sideLrI.value; payload.side_snap = sideSnapI.value;
            payload.side_col = parseInt(sideColI.value, 10) || 0;
            payload.side_u = Math.max(1, parseInt(sideUI.value, 10) || 1);
          } else if (pm === "wall") {
            payload.placement_mode = "wall"; payload.rack_id = wallRackI.value;
            payload.wall_lr = wallLrI.value; payload.wall_margin = wallMarginI.value;
            payload.wall_col = wallColI.value !== "" ? Math.max(0, parseInt(wallColI.value, 10) || 0) : 0;
            payload.wall_u = Math.max(1, parseInt(wallUI.value, 10) || 1);
            payload.wall_orient = wallOrientI.value === "facade" ? "facade" : "center";
          } else if (pm === "floor") {
            payload.placement_mode = "floor";
            payload.location = fLocI.value; payload.floor = fFloorI.value;
            payload.floor_x = fxI.value !== "" ? Math.max(0, parseInt(fxI.value, 10) || 0) : null;
            payload.floor_y = fyI.value !== "" ? Math.max(0, parseInt(fyI.value, 10) || 0) : null;
            payload.dc_orientation = Normalize.rackOrientation(parseInt(fOrI.value, 10) || 0);
          } else if (pm === "tray") {
            // POSÉ SUR UNE ÉTAGÈRE : X/Y vides → AUTO-POSITION (premier emplacement libre du plateau).
            // La validation partagée (T2d/V6e) re-contrôle empreinte/hauteur/chevauchement à l'écriture.
            payload.placement_mode = "tray"; payload.tray_item_id = traySelI.value;
            payload.dc_orientation = Normalize.rackOrientation(parseInt(tOrI.value, 10) || 0);
            if (txI.value !== "" && tyI.value !== "") {
              payload.tray_x = Math.max(0, parseInt(txI.value, 10) || 0);
              payload.tray_y = Math.max(0, parseInt(tyI.value, 10) || 0);
            } else {
              const trayIt: any = store.get("rackItems", traySelI.value);
              const trayRack: any = trayIt && trayIt.rack_id ? store.get("racks", trayIt.rack_id) : null;
              if (!trayRack) { Notify.toast(I18n.t("equipment.equip.trayNoRack"), "err"); return false; }
              const cand = Object.assign({}, eq ? eq.toJSON() : {}, payload);
              const spot = RackGeometry.trayFindSpot(trayRack, trayIt, cand, store.equipmentsOnTray(trayIt.id).filter((o: any) => !eq || o.id !== eq.id));
              if (!spot) { Notify.toast(I18n.t("equipment.equip.nothingFitsTray"), "err"); return false; }
              payload.tray_x = Math.round(spot.x); payload.tray_y = Math.round(spot.y);
            }
          }
        } else {
          payload.u_height = Math.max(1, parseInt(uHI.value, 10) || 1);
          // largeur RÉELLE du boîtier (vide = pleine largeur) + alignement (pertinent si rétréci seulement).
          payload.u_width_mm = uWI.value !== "" ? Math.max(1, parseInt(uWI.value, 10) || 1) : null;
          payload.u_align = (uAlignI.value === "left" || uAlignI.value === "right") ? uAlignI.value : "center";
          // profondeur en MM + occupation explicite — l'enum legacy `depth` n'est plus JAMAIS écrit.
          payload.depth_mm = Math.max(1, parseInt(depthMmI.value, 10) || EQUIP_DEPTH_DEFAULT_MM);
          payload.locks_u = (locksI as any).checked === true;
          payload.face_offset_mm = Math.max(0, parseInt(faceOffI.value, 10) || 0);
          payload.placement_mode = "rack";
          payload.rack_id = rackI.value || null;
          payload.rack_u = rackUI.value !== "" ? Math.max(1, parseInt(rackUI.value, 10) || 1) : null;
          payload.tray_item_id = null; payload.tray_x = null; payload.tray_y = null;   // placements exclusifs
        }
        if (live.check(payload).length) return false;   // validation live : champ(s) surligné(s), enregistrement bloqué
        let eqId: string;
        // édition d'un équipement existant OU re-save d'une création DÉJÀ persistée (N1 : createdId) → UPDATE, jamais
        // un 2e create. La LiveValidation équipement n'a pas de `find` (portée non pré-vérifiée : collision de U…) :
        // un refus store RÉEL reste possible avec live.check vert → on GARDE le retour null (P3) au lieu de continuer.
        const existingId = eq ? eq.id : createdId;
        // P4a : le dependent equipments→ports (T7) refuse de passer un équipement à « patch » tant que ses ports
        // PERSISTÉS assertent un réseau. Le formulaire a vidé les DRAFTS (toast au change) mais les persistés ne le
        // sont qu'à la réconciliation, APRÈS l'équipement → on les vide ICI, avant l'update, pour un save cohérent
        // (le vidage réseau ne peut pas échouer : il ne fait que relâcher des contraintes).
        if (existingId && payload.type === "patch_panel") {
          for (const p of store.portsOf(existingId)) {
            if (p.network_id || (Array.isArray(p.network_ids) && p.network_ids.length)) await store.update("ports", p.id, { network_id: null, network_ids: [] });
          }
        }
        if (existingId) {
          const savedEq = await store.update("equipments", existingId, payload);
          if (!savedEq) { Notify.toast(I18n.t("equipment.equip.saveFailed"), "err"); return false; }
          eqId = existingId;
          // le (dé)placement peut invalider des routes de câbles — même casse contrôlée que les actions
          // des vues 2D/3D (assignSideSlot/assignWallSlot…) ; no-op si les routes restent valides.
          await store.applyCableBreaks(eqId);
        }
        else {
          const created: any = await store.create("equipments", payload);
          if (!created) { Notify.toast(I18n.t("equipment.equip.createFailed"), "err"); return false; }   // refus (ex. collision de U) : pas de TypeError sur created.id
          eqId = created.id; createdId = eqId;   // mémorisé : un re-save après échec de port UPDATE au lieu de recréer (N1)
        }

        // Store.create/update renvoient null si la validation refuse (pas de throw) : on NE doit NI annoncer un succès
        // NI fermer la modale si un agrégat OU un port a été rejeté (P3 : les agrégats étaient auparavant non gardés).
        let saveError = false;

        // -- réconciliation agrégats --
        const draftAggIds = new Set(draftAggs.map((a) => a.id));
        for (const a of draftAggs) {
          const ex: any = store.get("aggregates", a.id);
          const savedAgg = (ex && ex.equipment_id === eqId)
            ? await store.update("aggregates", a.id, { name: (a.name || "").trim(), description: (a.description || "").trim() })
            : await store.create("aggregates", { id: a.id, equipment_id: eqId, name: (a.name || "").trim(), description: (a.description || "").trim() });
          if (!savedAgg) saveError = true;
        }
        for (const a of store.aggregatesOf(eqId)) if (!draftAggIds.has(a.id)) await store.remove("aggregates", a.id);

        // -- réconciliation ports --
        const draftPortIds = new Set(draftPorts.map((p) => p.id));
        for (const p of draftPorts) {
          const agg = p.aggregate_id && draftAggIds.has(p.aggregate_id) ? p.aggregate_id : null;
          // affectation de brins : seulement si un faisceau est désigné (sinon on n'écrit pas de brins pendants).
          const bundleId = p.bundle_id || null;
          const strandA = bundleId && p.strand_a != null ? p.strand_a : null;
          const strandB = bundleId && strandA != null && p.strand_b != null ? p.strand_b : null;
          // réseau : asserté sur les ports d'un équipement TERMINAL uniquement. Un patch déduit → réseau vidé.
          const isPatchEq = typeI.value === "patch_panel";
          const netPrimary = isPatchEq ? null : (p.network_id || null);
          const netIds = netPrimary ? ((Array.isArray(p.network_ids) && p.network_ids.length) ? p.network_ids.slice() : [netPrimary]) : [];
          // power : sens/calibre/phase seulement sur un port power ; sinon neutralisés.
          const isPowerPort = PortRoles.kind(p.role) === "power";
          const direction = isPowerPort ? (p.direction || "") : "";
          const powerMaxA = isPowerPort && p.power_max_a != null ? p.power_max_a : null;
          const phase = (isPowerPort && direction === "source") ? (p.phase || "") : "";
          const patch: any = { equipment_id: eqId, name: (p.name || "").trim(), port_type_id: p.port_type_id || null, role: p.role || "data", aggregate_id: agg, description: (p.description || "").trim(), parent_port_id: p.parent_port_id || null, lane: (p.lane != null) ? p.lane : null, face_x: (p.face_x != null) ? p.face_x : null, face_y: (p.face_y != null) ? p.face_y : null, face_side: p.face_side, bundle_id: bundleId, strand_a: strandA, strand_b: strandB, network_id: netPrimary, network_ids: netIds, direction, power_max_a: powerMaxA, phase };
          const ex: any = store.get("ports", p.id);
          const saved = ex ? await store.update("ports", p.id, patch) : await store.create("ports", Object.assign({ id: p.id }, patch));
          if (!saved) saveError = true;   // validation refusée (ex. brin en double, Tx=Rx) → échec signalé plus bas
        }
        // retirer les lanes AVANT leur trunk (un trunk supprimé cascade ses lanes)
        const toRemove = store.portsOf(eqId).filter((p: any) => !draftPortIds.has(p.id));
        for (const p of toRemove) if (p.parent_port_id) await store.remove("ports", p.id);
        for (const p of toRemove) if (!p.parent_port_id && store.get("ports", p.id)) await store.remove("ports", p.id);

        host.setDirty?.(true);
        if (saveError) { Notify.toast(I18n.t("equipment.equip.someSaveFailed"), "err"); return false; }
        Notify.toast(eq ? I18n.t("equipment.equip.updated") : I18n.t("equipment.equip.created")); onSaved?.(); return true;
      },
    });
    // AUTOCOMPLÉTION FACETTÉE (Nom · Marque · Modèle · Personne attribuée) : valeurs distinctes existantes,
    // plafonnées (réglable dans l'app, max absolu 100). Modèle facetté par la Marque déjà saisie (« dans leur
    // contexte »). Attachée APRÈS ouverture de la modale (les inputs sont alors dans le DOM).
    const acLimit = () => host.autocompleteLimit ? host.autocompleteLimit() : FieldFacet.MAX_RESULTS_DEFAULT;
    const attachFacet = (input: HTMLInputElement, field: string, context?: () => Record<string, string>) => {
      Autocomplete.attach(input,
        () => FieldFacet.suggest(store.all("equipments"), field, { context: context ? context() : undefined, limit: FieldFacet.MAX_RESULTS_ABS, excludeId: eq ? eq.id : null }).map((v) => ({ id: v, label: v })),
        (item) => { input.value = item.label; },
        { getLimit: acLimit, clearInputOnPick: false });
    };
    setTimeout(() => {
      attachFacet(nameI, "name");
      attachFacet(brandI, "brand");
      attachFacet(modelI, "model", (): Record<string, string> => { const b = brandI.value.trim(); return b ? { brand: b } : {}; });
      attachFacet(assignToI, "assigned_to");
      nameI.focus();
      // P2b : un équipement DÉJÀ patch à l'OUVERTURE (données legacy / API pré-T7) dont des ports portent encore un
      // réseau ne déclenche AUCUN change → le save les viderait EN SILENCE. On l'annonce à l'ouverture (nettoyage
      // prévu au save). NB : ne pas vider ici (le brouillon reste réversible tant que l'utilisateur n'enregistre pas).
      if (eq && typeI.value === "patch_panel") {
        const withNet = draftPorts.filter((p) => p.network_id || (Array.isArray(p.network_ids) && p.network_ids.length));
        if (withNet.length) Notify.toast(I18n.t("equipment.equip.patchNetWillRemove", { count: withNet.length }), "err");
      }
    }, 30);
  }

  /** Câble — extrémités (contraintes famille + salle) · type compatible · réseaux (déduits) · POINTS DE
      PASSAGE (waypoints ordonnés, grammaire exit/OOB) · statut.
      `opts` : pré-remplissage (fromPortId/toPortId/fromEqId/waypointIds) pour le routage 3D. */
}
