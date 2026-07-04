import type { Store } from "../../store";
import type { ImageStore } from "../../data/ImageStore";
import { FormControls } from "../../ui/FormControls";
import { LiveValidation } from "./LiveValidation";
import { ColorPalette } from "../../ui/ColorPalette";
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { Html } from "../../core/Html";
import { Color } from "../../core/Color";
import { Format } from "../../core/Format";
import { GroupTypes } from "../../domain/GroupTypes";
import { SpareTypes } from "../../domain/SpareTypes";
import { SpareStatuses } from "../../domain/SpareStatuses";
import { EquipmentTypes } from "../../registries/EquipmentTypes";
import { Depths } from "../../registries/Depths";
import { PortRoles } from "../../registries/PortRoles";
import { EquipFaces } from "../../registries/EquipFaces";
import { Id } from "../../core/Id";
import { Normalize } from "../../core/Normalize";
import {
  EQUIPMENT_TYPE_DEFAULT,
  EQUIP_FACE_IDS, EQUIP_FACE_IMG_FIELD,
  SPARE_DISK_TYPES, SPARE_CAP_UNITS, SPARE_HDD_INTERFACES, SPARE_HDD_FORMATS, SPARE_HDD_RPM,
  SPARE_TX_FORMS, SPARE_TX_SPEEDS, SPARE_TX_MEDIA
} from "../../domain/constants";
import { FormUi, ORIENT_OPTS } from "./shared";
import type { FormHost } from "./shared";
import { FormBase } from "./FormBase";
import { FaceEditor } from "./FaceEditor";

export class EquipmentForms extends FormBase {
  /** Fiche DÉTAIL d'un équipement (lecture) + bouton « Modifier » → formulaire d'édition. */
  static equipmentDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const eq: any = store.get("equipments", id);
    if (!eq) { Notify.toast("Équipement introuvable", "err"); return; }
    const root = document.createElement("div");
    const grid = document.createElement("div"); grid.className = "detail-grid";
    const add = (label: string, html: string) => { grid.appendChild(this.dt(label)); grid.appendChild(this.dd(html)); };
    add("Nom", Html.escape(eq.name || "(sans nom)"));
    add("Type", `<span class="pill">${Html.escape(EquipmentTypes.label(eq.type))}</span>` + (eq.inventory_only ? ` <span class="pill" style="color:var(--fg-dim)">inventaire seul</span>` : ""));
    add("Marque", eq.brand ? Html.escape(eq.brand) : "—");
    add("Modèle", eq.model ? Html.escape(eq.model) : "—");
    add("N° de série", eq.serial ? Html.escape(eq.serial) : "—");
    const grp: any = eq.group_id ? store.get("groups", eq.group_id) : null;
    add("Groupe", grp ? `<span class="pill colored-pill" ${Color.pillStyle(grp.color)}>${Html.escape(grp.label)}</span>` : "—");
    if (eq.type === "pdu") add("Capacité PDU", eq.pdu_max_a != null ? `<span class="pill">${eq.pdu_max_a} A</span>` : "—");
    if (eq.purchase_date || eq.po_ref) add("Achat", [eq.purchase_date ? Html.escape(eq.purchase_date) : null, eq.po_ref ? "BC " + Html.escape(eq.po_ref) : null].filter(Boolean).join(" · ") || "—");
    if (eq.warranty_end) add("Fin de garantie", Html.escape(eq.warranty_end));
    if (eq.assigned_to || eq.assigned_date) add("Attribué à", [eq.assigned_to ? Html.escape(eq.assigned_to) : null, eq.assigned_date ? "le " + Html.escape(eq.assigned_date) : null].filter(Boolean).join(" · ") || "—");
    const dimHtml = eq.dim_mode === "free"
      ? `<span class="pill">Libre</span> ${eq.free_l_mm != null ? eq.free_l_mm : "?"} × ${eq.free_w_mm != null ? eq.free_w_mm : "?"} × ${eq.free_h_mm != null ? eq.free_h_mm : "?"} mm <span style="color:var(--fg-dimmer)">(L × l × h)</span>`
      : `<span class="pill">U</span> ${eq.u_height || 1} U · ${Html.escape(this.mountDepthLabel(eq))}${eq.locks_u ? " · U verrouillé" : ""}`;
    add("Dimensions", dimHtml);
    let placeHtml: string;
    if (eq.placement_mode === "rack") {
      const rk: any = eq.rack_id ? store.get("racks", eq.rack_id) : null;
      if (!eq.rack_id) placeHtml = `<span class="pill">Non placé</span>`;
      else if (rk) { const pos = eq.rack_u ? ("U" + eq.rack_u + ((eq.u_height || 1) > 1 ? "–U" + (eq.rack_u + (eq.u_height || 1) - 1) : "")) : "position libre"; placeHtml = `<span class="pill">Rack</span> ${Html.escape(rk.name || "(sans nom)")} · ${pos} · ${Html.escape(this.mountDepthLabel(eq))}`; }
      else placeHtml = `<span class="pill">Rack</span> <span style="color:var(--err)">rack introuvable</span>`;
    } else if (eq.dim_mode === "free" && eq.dc_id) { const dc: any = store.get("datacenters", eq.dc_id); placeHtml = `<span class="pill">Salle</span> ${Html.escape(dc ? (dc.name || "(sans nom)") : "(datacenter introuvable)")}`; }
    else placeHtml = `<span class="pill">Manuel</span>`;
    add("Emplacement", placeHtml);
    const locBits = this.equipLocationBits(store, eq);
    add("Lieu", locBits.length ? `<span class="loc-pill">${Html.escape(locBits.join(" · "))}</span>` : `<span style="color:var(--fg-dimmer)">— non renseigné —</span>`);
    add("Description", eq.description ? Html.escape(eq.description) : "—");
    add("Créé", Html.escape(Format.dateTime(eq.created_date)));
    add("Modifié", Html.escape(Format.dateTime(eq.updated_date)));
    root.appendChild(grid);

    // façade : bouton éditer + aperçus des faces avec contenu
    const dF = document.createElement("div"); dF.className = "section-divider"; dF.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px";
    const dFlabel = document.createElement("span"); dFlabel.textContent = "Façade"; dF.appendChild(dFlabel);
    if (!this.isViewer()) {   // viewer (lecture seule) : pas d'édition de façade
      const editFaceBtn = document.createElement("button"); editFaceBtn.type = "button"; editFaceBtn.className = "btn btn-ghost btn-sm"; editFaceBtn.textContent = "Éditer la façade";
      editFaceBtn.onclick = () => FaceEditor.open(store, host, eq.id, { onApply: undefined });
      dF.appendChild(editFaceBtn);
    }
    root.appendChild(dF);
    const faces = eq.dim_mode === "free" ? EQUIP_FACE_IDS.slice() : ["front", "rear"];
    const previews = faces.map((f) => ({ f, pv: this.facePreview(store, eq, f) })).filter((x) => x.pv);
    if (previews.length) previews.forEach(({ f, pv }) => { const cap = document.createElement("div"); cap.className = "form-hint"; cap.style.margin = "2px 0 4px"; cap.textContent = "Face " + EquipFaces.label(f).toLowerCase(); root.appendChild(cap); root.appendChild(pv!); });
    else { const fh = document.createElement("div"); fh.className = "form-hint"; fh.textContent = "Aucune façade définie. « Éditer la façade » pour importer une image et y placer les ports."; root.appendChild(fh); }

    // ports
    const ports = store.portsOf(eq.id);
    const dP = document.createElement("div"); dP.className = "section-divider"; dP.textContent = "Ports (" + ports.length + ")"; root.appendChild(dP);
    if (ports.length) {
      const tw = document.createElement("div"); tw.className = "table-wrap";
      const rows = ports.map((p: any) => {
        const pt: any = store.get("portTypes", p.port_type_id), ag: any = p.aggregate_id ? store.get("aggregates", p.aggregate_id) : null;
        let bk = "";
        if (store.isBreakoutParent(p)) bk = ` <span class="pill">trunk ×${store.breakoutLanes(p.id).length}</span>`;
        else if (p.parent_port_id) { const par: any = store.get("ports", p.parent_port_id); bk = ` <span class="pill">lane ${p.lane || "?"} · ${Html.escape(par ? (par.name || "trunk") : "trunk")}</span>`; }
        return `<tr><td class="cell-name">${Html.escape(p.name || "(port)")}${bk}</td><td>${pt ? Html.escape(pt.name) + ' <span style="color:var(--fg-dimmer)">· ' + Html.escape(pt.family) + "</span>" : '<span style="color:var(--err)">type ?</span>'}</td><td><span class="pill role-${p.role === "mgmt" ? "mgmt" : (p.role === "power" ? "power" : "data")}">${Html.escape(PortRoles.label(p.role))}</span></td><td>${ag ? Html.escape(ag.name || "(agrégat)") : '<span style="color:var(--fg-dimmer)">—</span>'}</td><td class="cell-actions">${host.locate ? `<button class="row-btn" data-port-locate="${p.id}" title="Localiser le port en 3D">📍</button>` : ""}</td></tr>`;
      }).join("");
      tw.innerHTML = `<table><thead><tr><th>Port</th><th>Type</th><th>Rôle</th><th>Agrégat</th><th style="text-align:right;">3D</th></tr></thead><tbody>${rows}</tbody></table>`;
      root.appendChild(tw);
      tw.querySelectorAll("[data-port-locate]").forEach((b) => { (b as HTMLElement).onclick = () => host.locate?.("port", (b as HTMLElement).dataset.portLocate!, () => this.equipmentDetail(store, host, eq.id, onChanged)); });
    } else { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = "Aucun port."; root.appendChild(e); }

    // câbles connectés
    const cables = store.cablesOfPorts(ports.map((p: any) => p.id));
    const dC = document.createElement("div"); dC.className = "section-divider"; dC.textContent = "Câbles connectés (" + cables.length + ")"; root.appendChild(dC);
    if (cables.length) {
      const tw = document.createElement("div"); tw.className = "table-wrap";
      const endHtml = (c: any) => { const pa: any = store.get("ports", c.from_port_id), pb: any = store.get("ports", c.to_port_id); const ea: any = pa ? store.get("equipments", pa.equipment_id) : null, eb: any = pb ? store.get("equipments", pb.equipment_id) : null; const fmt = (e: any, p: any) => e ? `${Html.escape(e.name || "?")} <span style="color:var(--fg-dimmer)">:</span> ${Html.escape(p ? (p.name || "?") : "?")}` : `<span style="color:var(--err)">port ?</span>`; return `${fmt(ea, pa)} <span style="color:var(--accent)">↔</span> ${fmt(eb, pb)}`; };
      const rows = cables.map((c: any) => { const ct: any = store.get("cableTypes", c.cable_type_id), net: any = c.network_id ? store.get("networks", c.network_id) : null; return `<tr><td class="cell-name">${Html.escape(c.name || "(câble)")}</td><td>${ct ? Html.escape(ct.name) : '<span style="color:var(--err)">type ?</span>'}</td><td>${endHtml(c)}</td><td>${net ? `<span class="pill colored-pill" ${Color.pillStyle(net.color)}>${Html.escape(net.label)}</span>` : '<span style="color:var(--fg-dimmer)">—</span>'}</td></tr>`; }).join("");
      tw.innerHTML = `<table><thead><tr><th>Câble</th><th>Type</th><th>Liaison</th><th>Réseau</th></tr></thead><tbody>${rows}</tbody></table>`;
      root.appendChild(tw);
    } else { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = "Aucun câble connecté."; root.appendChild(e); }

    // spares (pièces de rechange) affectés à cet équipement
    const spares = store.sparesOfEquipment(eq.id);
    if (spares.length) {
      const dS = document.createElement("div"); dS.className = "section-divider"; dS.textContent = "Spares affectés (" + spares.length + ")"; root.appendChild(dS);
      const tw = document.createElement("div"); tw.className = "table-wrap";
      const rows = spares.map((s: any) => `<tr><td class="cell-name">${Html.escape(s.displayName())}</td><td><span class="pill">${SpareTypes.icon(s.type)} ${Html.escape(SpareTypes.label(s.type))}</span></td><td>${s.techSummary() ? Html.escape(s.techSummary()) : '<span style="color:var(--fg-dimmer)">—</span>'}</td><td>${s.serial ? Html.escape(s.serial) : '<span style="color:var(--fg-dimmer)">—</span>'}</td></tr>`).join("");
      tw.innerHTML = `<table><thead><tr><th>Désignation</th><th>Type</th><th>Caractéristiques</th><th>N° série</th></tr></thead><tbody>${rows}</tbody></table>`;
      root.appendChild(tw);
    }

    // Modifier → formulaire d'édition (remplace la fiche par la modale d'édition)
    const actions = document.createElement("div"); actions.style.cssText = "margin-top:16px;display:flex;justify-content:flex-end;gap:8px";
    if (host.locate) { const locBtn = document.createElement("button"); locBtn.type = "button"; locBtn.className = "btn btn-ghost"; locBtn.textContent = "📍 Localiser en 3D"; locBtn.onclick = () => host.locate!("equipment", eq.id, () => this.equipmentDetail(store, host, eq.id, onChanged)); actions.appendChild(locBtn); }
    if (!this.isViewer()) {   // viewer : pas de bouton « Modifier »
      const editBtn = document.createElement("button"); editBtn.type = "button"; editBtn.className = "btn btn-primary"; editBtn.textContent = "Modifier";
      editBtn.onclick = () => this.equipment(store, host, eq.id, onChanged);
      actions.appendChild(editBtn);
    }
    root.appendChild(actions);

    host.openModal({ title: "Détail de l'équipement", subtitle: Html.escape(eq.name || ""), body: root, hideFooter: true, wide: true });
  }

  /** Éditeur de capot (toit/sol) : grille SVG au pas 1U, multi-sélection au glisser. Les cellules
      (roof_cells/floor_cells) sont éditées dans un TAMPON et appliquées au clic sur « Enregistrer »
      du formulaire de baie (cf. FormBase.capEditor). Une cellule portant un pin (◆) ne peut être
      retirée. Réservé à un rack EXISTANT. */

  /** Image de façade (bibliothèque IndexedDB hors modèle) : import/remplacement + métadonnées (U, face). */
  static faceImage(images: ImageStore, store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const fi: any = id ? images.get(id) : null;
    let imgBlob: Blob | null = null, previewUrl: string | null = fi ? fi.url : null, tempUrl: string | null = null;
    const root = document.createElement("div");
    const previewWrap = document.createElement("div"); previewWrap.className = "fi-form-preview";
    const previewImg = document.createElement("img");
    const previewEmpty = document.createElement("div"); previewEmpty.className = "fi-form-empty"; previewEmpty.textContent = "Aucune image importée";
    previewWrap.append(previewImg, previewEmpty);
    const importBtn = document.createElement("button"); importBtn.type = "button"; importBtn.className = "btn btn-ghost btn-sm";
    const nameI = FormControls.text(fi ? fi.name : "", "ex. Switch 48p — avant");
    const syncPreview = () => {
      if (previewUrl) { previewImg.src = previewUrl; previewImg.style.display = ""; previewEmpty.style.display = "none"; }
      else { previewImg.removeAttribute("src"); previewImg.style.display = "none"; previewEmpty.style.display = ""; }
      importBtn.textContent = previewUrl ? "Remplacer le fichier…" : "Importer une image…";
    };
    importBtn.onclick = async () => {
      const f = this.validImageFile(await this.promptImageFile()); if (!f) return;
      imgBlob = f;
      if (tempUrl) URL.revokeObjectURL(tempUrl);
      tempUrl = URL.createObjectURL(f); previewUrl = tempUrl;
      if (!nameI.value.trim() && f.name) nameI.value = f.name.replace(/\.[^.]+$/, "");
      syncPreview();
    };
    root.appendChild(FormControls.fieldRow("Image", previewWrap, "JPEG / PNG / WebP. Stockée une seule fois et partagée par référence."));
    const importRow = document.createElement("div"); importRow.style.marginBottom = "10px"; importRow.appendChild(importBtn); root.appendChild(importRow);
    root.appendChild(FormControls.fieldRow("Nom", nameI));
    // FACE d'abord : elle conditionne l'affichage du U (aucun pour « autre ») ET des oreilles (avant/arrière seulement).
    const faceI = FormControls.select([{ value: "front", label: "Avant" }, { value: "rear", label: "Arrière" }, { value: "autre", label: "Autre (faces annexes)" }], fi ? fi.face : "front");
    root.appendChild(FormControls.fieldRow("Face", faceI, "« Avant »/« Arrière » : proposées sur la face correspondante (filtre U). « Autre » : faces annexes des équipements en dimensionnement libre, sans U ni oreilles."));
    const uI = FormControls.number(fi ? (fi.u_height || 1) : 1, { min: 1, step: 1 });
    const uRow = FormControls.fieldRow("Hauteur (U)", uI, "Éligibilité : l'image n'est proposée que sur les équipements de ce nombre de U.");
    root.appendChild(uRow);
    // Oreilles 19″ : pertinent UNIQUEMENT pour la face AVANT (l'arrière n'a jamais d'oreilles). Défaut = avec.
    const earsI = FormControls.select([{ value: "ears", label: "Face avec oreilles (19″)" }, { value: "face", label: "Face seule (corps)" }], (fi && fi.with_ears === false) ? "face" : "ears");
    const earRow = FormControls.fieldRow("Rendu", earsI, "« Avec oreilles » : l'image couvre le corps + les oreilles de montage (largeur panneau 19″). « Face seule » : le corps seul (largeur U). Le placement des ports reste sur le corps dans les deux cas.");
    root.appendChild(earRow);
    const descI = FormControls.textArea(fi ? fi.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));
    // « Autre » → ni U ni oreilles. Oreilles : AVANT uniquement (l'arrière n'en a jamais).
    const syncFaceDeps = () => { uRow.style.display = (faceI.value === "autre") ? "none" : ""; earRow.style.display = (faceI.value === "front") ? "" : "none"; };
    faceI.onchange = syncFaceDeps; syncFaceDeps();
    if (fi) { const uses = store.faceImageUsageCount(fi.id); const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Utilisée par " + uses + " équipement" + (uses > 1 ? "s" : "") + ". Modifier U/face n'affecte que les futurs choix ; les références existantes restent."; root.appendChild(h); }
    syncPreview();
    host.openModal({
      title: fi ? "Modifier l'image de façade" : "Nouvelle image de façade",
      subtitle: fi ? Html.escape(fi.name || "") : "Importez une image et définissez sa hauteur (U) et sa face.",
      body: root,
      onSave: async () => {
        if (!fi && !imgBlob) { Notify.toast("Importez d'abord une image.", "err"); return false; }
        const face = (faceI.value === "rear") ? "rear" : (faceI.value === "autre" ? "autre" : "front");
        const meta = { name: nameI.value.trim(), u_height: (face === "autre") ? 1 : Math.max(1, parseInt(uI.value, 10) || 1), face, with_ears: (face === "front") && (earsI.value !== "face"), description: descI.value.trim() };
        if (fi) {
          if (imgBlob) { const n = store.faceImageUsageCount(fi.id); if (n > 1) { const ok = await Dialog.confirm({ title: "Remplacer le fichier", message: "Cette image est utilisée par " + n + " équipements. Le nouveau fichier les mettra tous à jour.", confirmLabel: "Remplacer" }); if (!ok) return false; } }
          await images.update(fi.id, imgBlob ? Object.assign({}, meta, { blob: imgBlob, type: imgBlob.type }) : meta);
        } else { await images.add(Object.assign({}, meta, { blob: imgBlob, type: (imgBlob as Blob).type })); }
        if (tempUrl) URL.revokeObjectURL(tempUrl);
        host.setDirty?.(true); Notify.toast(fi ? "Image mise à jour" : "Image ajoutée"); onSaved?.(); return true;
      },
    });
    setTimeout(() => { if (!fi) importBtn.focus(); else nameI.focus(); }, 30);
  }

  /** Groupe d'équipements (stack/system/general). */
  static group(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const grp: any = id ? store.get("groups", id) : null;
    const root = document.createElement("div");
    const labelI = FormControls.text(grp ? grp.label : "", "ex. Cœur de réseau, Salle A…");
    root.appendChild(FormControls.fieldRow("Label", labelI));
    const typeI = FormControls.select(GroupTypes.ALL.map((t) => ({ value: t.id, label: t.label })), grp ? (grp.type || GroupTypes.DEFAULT) : GroupTypes.DEFAULT);
    root.appendChild(FormControls.fieldRow("Type", typeI, "Stack · System (ex. SAN) · General."));
    let color: string | null = grp ? grp.color : null;
    root.appendChild(FormControls.fieldRow("Couleur", ColorPalette.build(color, (c) => { color = c; }), "Identifie le groupe dans les listes et la topologie."));
    const descI = FormControls.textArea(grp ? grp.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));
    const live = new LiveValidation("groups", { label: labelI, type: typeI });
    live.clearOnInput();

    host.openModal({
      title: grp ? "Modifier le groupe" : "Nouveau groupe",
      subtitle: grp ? Html.escape(grp.label) : "",
      body: root,
      onSave: async () => {
        const payload = { label: labelI.value.trim(), type: typeI.value || GroupTypes.DEFAULT, color: color || null, description: descI.value.trim() };
        if (live.check(payload).length) return false;   // label requis (surligné)
        if (grp) await store.update("groups", grp.id, payload); else await store.create("groups", payload);
        host.setDirty?.(true); Notify.toast(grp ? "Groupe mis à jour" : "Groupe créé"); onSaved?.(); return true;
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
    const typeI = FormControls.select(SpareTypes.ALL.map((t) => ({ value: t.id, label: t.icon + " " + t.label })), sp ? sp.type : SpareTypes.DEFAULT);
    const nameI = FormControls.text(sp ? sp.name : "", "désignation (sinon dérivée du modèle)");
    root.appendChild(FormUi.row2(FormControls.fieldRow("Type", typeI), FormControls.fieldRow("Désignation", nameI)));
    const brandI = FormControls.text(sp ? sp.brand : "", "ex. Seagate, Cisco, Intel…");
    const pnI = FormControls.text(sp ? sp.model_pn : "", "modèle / part-number");
    root.appendChild(FormUi.row2(FormControls.fieldRow("Marque", brandI), FormControls.fieldRow("Modèle / PN", pnI)));
    const serialI = FormControls.text(sp ? sp.serial : "", "n° de série (unitaire)");
    root.appendChild(FormControls.fieldRow("Numéro de série", serialI));

    // -- bloc DISQUE (HDD/SSD) --
    const diskBlock = document.createElement("div");
    diskBlock.appendChild(FormUi.divider("Caractéristiques disque"));
    const capValI = FormControls.number(sp ? sp.capacity_value : "", { min: 0, step: 1, placeholder: "capacité" });
    const capUnitI = FormControls.select(SPARE_CAP_UNITS.map((u) => ({ value: u, label: u === "GB" ? "Go" : "To" })), sp ? sp.capacity_unit : "GB");
    const ifaceI = FormControls.text(sp ? sp.interface : "", "SATA / SAS / NVMe…");
    root.appendChild(FormControls.attachDatalist(ifaceI, "sp-iface", SPARE_HDD_INTERFACES));
    const fmtI = FormControls.text(sp ? sp.form_factor : "", '3.5" / 2.5" / M.2…');
    root.appendChild(FormControls.attachDatalist(fmtI, "sp-fmt", SPARE_HDD_FORMATS));
    diskBlock.appendChild(FormUi.row2(FormControls.fieldRow("Capacité", capValI), FormControls.fieldRow("Unité", capUnitI), FormControls.fieldRow("Interface", ifaceI), FormControls.fieldRow("Format", fmtI)));
    const rpmI = FormControls.select([{ value: "", label: "—" }].concat(SPARE_HDD_RPM.map((r) => ({ value: String(r), label: r + " rpm" }))), sp && sp.rpm != null ? String(sp.rpm) : "");
    const rpmRow = FormControls.fieldRow("RPM", rpmI, "Vitesse de rotation (HDD uniquement).");
    diskBlock.appendChild(rpmRow);
    root.appendChild(diskBlock);

    // -- bloc TRANSCEIVER --
    const txBlock = document.createElement("div");
    txBlock.appendChild(FormUi.divider("Caractéristiques transceiver"));
    const txFormI = FormControls.select([{ value: "", label: "—" }].concat(SPARE_TX_FORMS.map((f) => ({ value: f, label: f }))), sp ? sp.tx_form : "");
    const txSpeedI = FormControls.select([{ value: "", label: "—" }].concat(SPARE_TX_SPEEDS.map((s) => ({ value: s, label: s }))), sp ? sp.tx_speed : "");
    const txMediaI = FormControls.text(sp ? sp.tx_media : "", "LC / RJ45 / DAC / AOC…");
    root.appendChild(FormControls.attachDatalist(txMediaI, "sp-txmedia", SPARE_TX_MEDIA));
    txBlock.appendChild(FormUi.row2(FormControls.fieldRow("Form factor", txFormI), FormControls.fieldRow("Débit", txSpeedI), FormControls.fieldRow("Média / connecteur", txMediaI)));
    const txReachI = FormControls.text(sp ? sp.tx_reach : "", "ex. SR · LR · 1310nm · 10km");
    txBlock.appendChild(FormControls.fieldRow("Portée / longueur d'onde", txReachI));
    root.appendChild(txBlock);

    // -- bloc AUTRE --
    const otherBlock = document.createElement("div");
    otherBlock.appendChild(FormUi.divider("Caractéristiques"));
    const specsI = FormControls.textArea(sp ? sp.specs : "");
    otherBlock.appendChild(FormControls.fieldRow("Spécifications", specsI, "Caractéristiques en texte libre."));
    root.appendChild(otherBlock);

    // -- statut + attribution --
    root.appendChild(FormUi.divider("Statut"));
    const statusI = FormControls.select(SpareStatuses.ALL.map((s) => ({ value: s.id, label: s.label })), sp ? sp.status : SpareStatuses.DEFAULT);
    root.appendChild(FormControls.fieldRow("Statut", statusI));
    const assignBlock = document.createElement("div");
    const eqOpts = [{ value: "", label: "— libre / non précisé —" }].concat(
      store.all("equipments").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((e: any) => ({ value: e.id, label: e.name || "(équipement)" })),
    );
    const eqI = FormControls.select(eqOpts, sp ? (sp.assigned_equipment_id || "") : "");
    const freeI = FormControls.text(sp ? sp.assigned_free : "", "utilisateur / équipement hors gestion");
    assignBlock.appendChild(FormUi.row2(FormControls.fieldRow("Équipement affecté", eqI, "Ou laissez « libre » et renseignez le champ ci-contre."), FormControls.fieldRow("Attribution libre", freeI)));
    const assignDateI: any = FormControls.date(sp ? sp.assigned_date : "");
    assignBlock.appendChild(FormControls.fieldRow("Date d'attribution", assignDateI));
    root.appendChild(assignBlock);

    // -- administratif --
    root.appendChild(FormUi.divider("Administratif"));
    const purchaseI: any = FormControls.date(sp ? sp.purchase_date : "");
    const poI = FormControls.text(sp ? sp.po_ref : "", "réf. bon de commande");
    root.appendChild(FormUi.row2(FormControls.fieldRow("Date d'achat", purchaseI), FormControls.fieldRow("Bon de commande", poI)));
    const storageI = FormControls.text(sp ? sp.storage_location : "", "ex. Armoire B · étagère 3 · bac 12");
    root.appendChild(FormControls.fieldRow("Emplacement de stockage", storageI));
    const commentI = FormControls.textArea(sp ? sp.comment : "");
    root.appendChild(FormControls.fieldRow("Commentaire", commentI));

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
      title: sp ? "Modifier la pièce" : "Nouvelle pièce (spare)",
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
        host.setDirty?.(true); Notify.toast(sp ? "Pièce mise à jour" : "Pièce créée"); onSaved?.(); return true;
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
    const draftPorts: any[] = eq ? store.portsOf(eq.id).map((p: any) => ({
      id: p.id, name: p.name, port_type_id: p.port_type_id, role: p.role, aggregate_id: p.aggregate_id, description: p.description,
      parent_port_id: p.parent_port_id || null, lane: (p.lane != null) ? p.lane : null, face_x: p.face_x, face_y: p.face_y, face_side: p.face_side,
    })) : [];
    // brouillon des images de façade (référence par face) — l'éditeur de façade les reporte ici.
    const faceFids: Record<string, string | null> = {};
    EQUIP_FACE_IDS.forEach((f) => { faceFids[f] = eq ? (eq[EQUIP_FACE_IMG_FIELD[f]] || null) : null; });
    const root = document.createElement("div");

    // -- identité --
    const nameI = FormControls.text(eq ? eq.name : "", "ex. sw-core-01");
    const curType = eq ? (eq.type || EQUIPMENT_TYPE_DEFAULT) : EQUIPMENT_TYPE_DEFAULT;
    let typeOpts = EquipmentTypes.ALL.map((t) => ({ value: t.id, label: t.label }));
    if (curType && !EquipmentTypes.ALL.some((t) => t.id === curType)) typeOpts = [{ value: curType, label: curType + " (hors liste)" }, ...typeOpts];
    const typeI = FormControls.select(typeOpts, curType);
    root.appendChild(FormUi.row2(FormControls.fieldRow("Nom", nameI), FormControls.fieldRow("Type", typeI)));

    const invI = FormControls.toggle("Inventaire seul", eq ? !!eq.inventory_only : false, () => sync(), { block: true, title: "Répertorié uniquement : ni placement, ni câblage, ni ports." });
    root.appendChild(invI);
    const brandI = FormControls.text(eq ? eq.brand : "", "ex. Cisco, Dell…");
    const modelI = FormControls.text(eq ? eq.model : "", "ex. Catalyst 2960…");
    root.appendChild(FormUi.row2(FormControls.fieldRow("Marque", brandI), FormControls.fieldRow("Modèle", modelI)));
    const serialI = FormControls.text(eq ? eq.serial : "", "n° de série");
    root.appendChild(FormControls.fieldRow("Numéro de série", serialI));

    // -- administratif --
    root.appendChild(FormUi.divider("Administratif"));
    const purchaseI = FormControls.date(eq ? eq.purchase_date : "");
    const warrantyI = FormControls.date(eq ? eq.warranty_end : "");
    const poI = FormControls.text(eq ? eq.po_ref : "", "réf. bon de commande");
    root.appendChild(FormUi.row2(FormControls.fieldRow("Date d'achat", purchaseI), FormControls.fieldRow("Fin de garantie", warrantyI), FormControls.fieldRow("Bon de commande", poI)));
    const assignDateI = FormControls.date(eq ? eq.assigned_date : "");
    const assignToI = FormControls.text(eq ? eq.assigned_to : "", "nom de la personne");
    root.appendChild(FormUi.row2(FormControls.fieldRow("Date d'attribution", assignDateI), FormControls.fieldRow("Attribué à", assignToI)));
    const pduI = FormControls.number((eq && eq.pdu_max_a != null) ? eq.pdu_max_a : "", { min: 0, step: 1, placeholder: "ampères" });
    const pduRow = FormControls.fieldRow("Capacité max PDU (A)", pduI, "Pour les bandeaux d'alimentation.");
    root.appendChild(pduRow);

    const grpOpts = [{ value: "", label: "— aucun —" }].concat(store.all("groups").slice().sort((a: any, b: any) => (a.label || "").localeCompare(b.label || "")).map((g: any) => ({ value: g.id, label: g.label || "(sans label)" })));
    const groupI = FormControls.select(grpOpts, eq && eq.group_id ? eq.group_id : "");
    root.appendChild(FormControls.fieldRow("Groupe", groupI, "Gérés dans l'onglet Groupes."));
    const descI = FormControls.textArea(eq ? eq.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    // -- dimensions + placement (sections « avancées », masquées en inventaire) --
    const adv = document.createElement("div");
    adv.appendChild(FormUi.divider("Dimensions"));
    const dimI = FormControls.select([{ value: "u", label: "En U (rack)" }, { value: "free", label: "Libre (L × l × h en mm)" }], eq ? (eq.dim_mode === "free" ? "free" : "u") : "u");
    adv.appendChild(FormControls.fieldRow("Dimensionnement", dimI));
    // U
    const uBox = document.createElement("div");
    const uHI = FormControls.number(eq ? eq.u_height : 1, { min: 1, step: 1 });
    const depthI = FormControls.select(Depths.ALL.map((d) => ({ value: d.id, label: d.label })), eq && ["full", "half", "quarter"].includes(eq.depth) ? eq.depth : "full");
    uBox.appendChild(FormUi.row2(FormControls.fieldRow("Hauteur (U)", uHI), FormControls.fieldRow("Profondeur", depthI)));
    adv.appendChild(uBox);
    // libre
    const freeBox = document.createElement("div");
    const flI = FormControls.number((eq && eq.free_l_mm != null) ? eq.free_l_mm : "", { min: 0, step: 1, placeholder: "longueur" });
    const fwI = FormControls.number((eq && eq.free_w_mm != null) ? eq.free_w_mm : "", { min: 0, step: 1, placeholder: "largeur" });
    const fhI = FormControls.number((eq && eq.free_h_mm != null) ? eq.free_h_mm : "", { min: 0, step: 1, placeholder: "hauteur" });
    freeBox.appendChild(FormUi.row2(FormControls.fieldRow("Longueur (mm)", flI), FormControls.fieldRow("Largeur (mm)", fwI), FormControls.fieldRow("Hauteur (mm)", fhI)));
    adv.appendChild(freeBox);

    // placement en MODE LIBRE — principe n°10 : TOUT placement offert par les vues 2D/3D (poser au sol d'une
    // salle, monter en LATÉRAL ou en PAROI de baie, poser sur un PLAN D'ÉTAGE) a son équivalent FORMULAIRE.
    // Un sélecteur de MODE expose les champs propres à chaque placement ; à l'enregistrement, le mode choisi
    // pilote `placement_mode` et remet à zéro les champs des autres modes (les placements sont exclusifs).
    const rackChoices = store.all("racks").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((r: any) => ({ value: r.id, label: r.name || "(baie)" }));
    const salleBox = document.createElement("div");
    salleBox.appendChild(FormUi.divider("Placement (dimensionnement libre)"));
    const initPlaceMode = eq ? (["side", "wall", "floor"].includes(eq.placement_mode) ? eq.placement_mode : (eq.dc_id ? "sol" : "")) : "";
    const placeModeI = FormControls.select([
      { value: "", label: "— non placé —" },
      { value: "sol", label: "Au sol d'une salle" },
      { value: "side", label: "Latéral (marge de baie)" },
      { value: "wall", label: "Paroi de baie (mural)" },
      { value: "floor", label: "Sur un plan d'étage" },
    ], initPlaceMode);
    salleBox.appendChild(FormControls.fieldRow("Mode de placement", placeModeI, "Équivalent formulaire des placements des vues 2D/3D — tout est éditable sans les vues."));

    // — au sol d'une salle (placement_mode « manual » + dc_id) : centre X/Y + hauteur Z + orientation —
    const solBox = document.createElement("div");
    const dcEqOpts = [{ value: "", label: "— salle ? —" }].concat(store.all("datacenters").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((d: any) => ({ value: d.id, label: d.name || "(salle)" })));
    const dcSelE = FormControls.select(dcEqOpts, eq && eq.dc_id ? eq.dc_id : "");
    solBox.appendChild(FormControls.fieldRow("Salle (datacenter)", dcSelE, "Pose l'équipement au SOL de la salle. Position vide = centre."));
    const exI = FormControls.number((eq && eq.dc_x != null) ? eq.dc_x : "", { min: 0, step: 10, placeholder: "centre X (mm)" });
    const eyI = FormControls.number((eq && eq.dc_y != null) ? eq.dc_y : "", { min: 0, step: 10, placeholder: "centre Y (mm)" });
    const ezI = FormControls.number((eq && eq.dc_z != null) ? eq.dc_z : 0, { step: 10, placeholder: "0" });   // hauteur Z : négatif autorisé (pas de min)
    const eoI = FormControls.select(ORIENT_OPTS, String(Normalize.rackOrientation(eq ? eq.dc_orientation : 0)));
    const sallePos = FormUi.row2(FormControls.fieldRow("Position X (mm)", exI), FormControls.fieldRow("Position Y (mm)", eyI), FormControls.fieldRow("Hauteur Z (mm)", ezI), FormControls.fieldRow("Orientation", eoI));
    solBox.appendChild(sallePos);
    salleBox.appendChild(solBox);

    // — latéral (placement_mode « side ») : marge av/ar d'une baie, côté G/D, accroche, colonne, U du bord HAUT —
    const sideBox = document.createElement("div");
    const sideRackI = FormControls.select([{ value: "", label: "— baie ? —" }].concat(rackChoices), eq && eq.placement_mode === "side" && eq.rack_id ? eq.rack_id : "");
    const sideFaceI = FormControls.select([{ value: "front", label: "Marge avant" }, { value: "rear", label: "Marge arrière" }], eq && eq.side_face === "rear" ? "rear" : "front");
    const sideLrI = FormControls.select([{ value: "left", label: "Gauche" }, { value: "right", label: "Droite" }], eq && eq.side_lr === "right" ? "right" : "left");
    const sideSnapI = FormControls.select([{ value: "post", label: "Montant (rack)" }, { value: "wall", label: "Paroi" }], eq && eq.side_snap === "wall" ? "wall" : "post");
    const sideColI = FormControls.select([{ value: "0", label: "Colonne 1" }, { value: "1", label: "Colonne 2" }], String(eq && eq.side_col === 1 ? 1 : 0));
    const sideUI = FormControls.number((eq && eq.side_u != null) ? eq.side_u : 1, { min: 1, step: 1, placeholder: "U (bord haut)" });
    sideBox.appendChild(FormUi.row2(FormControls.fieldRow("Baie", sideRackI), FormControls.fieldRow("Marge", sideFaceI), FormControls.fieldRow("Côté", sideLrI)));
    sideBox.appendChild(FormUi.row2(FormControls.fieldRow("Accroche", sideSnapI), FormControls.fieldRow("Colonne", sideColI), FormControls.fieldRow("Position U (haut)", sideUI)));
    salleBox.appendChild(sideBox);

    // — paroi de baie (placement_mode « wall ») : paroi G/D, marge av/ar, colonne, U de base, orientation de face —
    const wallBox = document.createElement("div");
    const wallRackI = FormControls.select([{ value: "", label: "— baie ? —" }].concat(rackChoices), eq && eq.placement_mode === "wall" && eq.rack_id ? eq.rack_id : "");
    const wallLrI = FormControls.select([{ value: "left", label: "Paroi gauche" }, { value: "right", label: "Paroi droite" }], eq && eq.wall_lr === "right" ? "right" : "left");
    const wallMarginI = FormControls.select([{ value: "front", label: "Marge avant" }, { value: "rear", label: "Marge arrière" }], eq && eq.wall_margin === "rear" ? "rear" : "front");
    const wallColI = FormControls.number((eq && eq.wall_col != null) ? eq.wall_col : 0, { min: 0, step: 1, placeholder: "0" });
    const wallUI = FormControls.number((eq && eq.wall_u != null) ? eq.wall_u : 1, { min: 1, step: 1, placeholder: "U (base)" });
    const wallOrientI = FormControls.select([{ value: "center", label: "Vers le centre (⊥ paroi)" }, { value: "facade", label: "Vers la façade de la marge" }], eq && eq.wall_orient === "facade" ? "facade" : "center");
    wallBox.appendChild(FormUi.row2(FormControls.fieldRow("Baie", wallRackI), FormControls.fieldRow("Paroi", wallLrI), FormControls.fieldRow("Marge", wallMarginI)));
    wallBox.appendChild(FormUi.row2(FormControls.fieldRow("Colonne", wallColI), FormControls.fieldRow("Position U (base)", wallUI), FormControls.fieldRow("Face orientée", wallOrientI)));
    salleBox.appendChild(wallBox);

    // — plan d'étage (placement_mode « floor ») : bâtiment + étage, centre X/Y (vide = à localiser), orientation —
    const floorBox = document.createElement("div");
    const fLocI = FormControls.select(FormUi.locOptions(store), eq && eq.placement_mode === "floor" ? (eq.location || "") : "");
    const fFloorI = FormControls.select(FormUi.floorOptions(eq ? String(eq.floor ?? "") : ""), eq && eq.placement_mode === "floor" ? String(eq.floor ?? "") : "");
    floorBox.appendChild(FormUi.row2(FormControls.fieldRow("Bâtiment (lieu)", fLocI), FormControls.fieldRow("Étage", fFloorI)));
    const fxI = FormControls.number((eq && eq.floor_x != null) ? eq.floor_x : "", { min: 0, step: 10, placeholder: "centre X (mm)" });
    const fyI = FormControls.number((eq && eq.floor_y != null) ? eq.floor_y : "", { min: 0, step: 10, placeholder: "centre Y (mm)" });
    const fOrI = FormControls.select(ORIENT_OPTS, String(Normalize.rackOrientation(eq ? eq.dc_orientation : 0)));
    floorBox.appendChild(FormUi.row2(FormControls.fieldRow("Position X (mm)", fxI), FormControls.fieldRow("Position Y (mm)", fyI), FormControls.fieldRow("Orientation", fOrI)));
    salleBox.appendChild(floorBox);

    const placeFreeHint = document.createElement("div"); placeFreeHint.className = "form-hint"; salleBox.appendChild(placeFreeHint);
    const PLACE_HINTS: Record<string, string> = {
      "": "Non placé. Choisissez un mode pour poser l'équipement (équivalent des placements en vue 2D/3D).",
      sol: "Hauteur Z = décalage vertical (mm) ; négatif = sous le faux-plancher. Position vide = centre de la salle.",
      side: "Monté dans la marge latérale de la baie ; Position U = bord HAUT de l'équipement. La baie doit offrir des emplacements latéraux.",
      wall: "Fixé sur la paroi gauche/droite de la baie, dans sa marge avant ou arrière ; Position U = base de l'équipement.",
      floor: "Posé sur le plan d'étage du bâtiment. Position vide = à localiser en glissant sur le plan (vue Étage).",
    };
    const syncSalle = () => {
      const m = placeModeI.value;
      solBox.style.display = m === "sol" ? "" : "none";
      sideBox.style.display = m === "side" ? "" : "none";
      wallBox.style.display = m === "wall" ? "" : "none";
      floorBox.style.display = m === "floor" ? "" : "none";
      if (m === "sol") sallePos.style.display = dcSelE.value ? "" : "none";
      placeFreeHint.textContent = (m === "sol" && !dcSelE.value) ? "Choisissez la salle où poser l'équipement au sol." : PLACE_HINTS[m] || "";
    };
    placeModeI.onchange = syncSalle; dcSelE.onchange = syncSalle; syncSalle();
    adv.appendChild(salleBox);

    // placement rack (mode U seulement, dans ce cœur)
    const placeBox = document.createElement("div");
    placeBox.appendChild(FormUi.divider("Placement (rack)"));
    const rackOpts = [{ value: "", label: "— non placé —" }].concat(store.all("racks").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((r: any) => ({ value: r.id, label: r.name || "(baie)" })));
    const rackI = FormControls.select(rackOpts, eq && eq.placement_mode === "rack" && eq.rack_id ? eq.rack_id : "");
    const rackUI = FormControls.number((eq && eq.rack_u != null) ? eq.rack_u : "", { min: 1, step: 1, placeholder: "U de bas (vide = libre)" });
    placeBox.appendChild(FormUi.row2(FormControls.fieldRow("Baie", rackI), FormControls.fieldRow("Position (U)", rackUI)));
    const placeHint = document.createElement("div"); placeHint.className = "form-hint";
    placeHint.textContent = "Placements latéral / paroi / plan d'étage : disponibles en dimensionnement « Libre » (ces montages utilisent les dimensions en mm).";
    placeBox.appendChild(placeHint);
    adv.appendChild(placeBox);

    // -- agrégats (LAG / bond) --
    adv.appendChild(FormUi.divider("Agrégats (LAG / bond)"));
    const aggList = document.createElement("div"); aggList.className = "chip-list"; adv.appendChild(aggList);
    const addAggBtn = document.createElement("button"); addAggBtn.type = "button"; addAggBtn.className = "btn btn-ghost btn-sm"; addAggBtn.textContent = "+ Agrégat"; addAggBtn.style.marginTop = "8px"; adv.appendChild(addAggBtn);

    // -- ports (+ breakout : trunk éclaté en N lanes ; + façade : pose des ports sur les faces) --
    const portDiv = document.createElement("div"); portDiv.className = "section-divider"; portDiv.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;";
    const portDivLabel = document.createElement("span"); portDivLabel.textContent = "Ports"; portDiv.appendChild(portDivLabel);
    if (eq) {   // sous-éditeur empilé opérant sur le brouillon (ports en cours d'ajout présents)
      const faceBtn = document.createElement("button"); faceBtn.type = "button"; faceBtn.className = "btn btn-ghost btn-sm"; faceBtn.textContent = "Façade…";
      faceBtn.title = "Disposer les ports sur la façade (y compris ceux que vous venez d'ajouter)";
      faceBtn.onclick = () => FaceEditor.open(store, host, eq.id, {
        ports: draftPorts, fids: faceFids,
        onApply: ({ fids, place }: any) => {
          EQUIP_FACE_IDS.forEach((f) => { if (f in fids) faceFids[f] = fids[f]; });
          draftPorts.forEach((p) => { if (p.parent_port_id) return; const pos = place[p.id]; if (pos) { p.face_x = pos.x; p.face_y = pos.y; p.face_side = pos.side; } else { p.face_x = null; p.face_y = null; } });
          host.setDirty?.(true); Notify.toast("Façade appliquée — enregistrez l'équipement pour conserver");
        },
      });
      portDiv.appendChild(faceBtn);
    }
    adv.appendChild(portDiv);
    const portList = document.createElement("div"); portList.className = "chip-list"; adv.appendChild(portList);
    const portBtns = document.createElement("div"); portBtns.style.cssText = "display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;";
    const addPortBtn = document.createElement("button"); addPortBtn.type = "button"; addPortBtn.className = "btn btn-ghost btn-sm"; addPortBtn.textContent = "+ Port";
    const addBreakoutBtn = document.createElement("button"); addBreakoutBtn.type = "button"; addBreakoutBtn.className = "btn btn-ghost btn-sm"; addBreakoutBtn.textContent = "+ Breakout";
    addBreakoutBtn.title = "Port trunk (ex. QSFP+) éclaté en N lanes (ex. 4× SFP+)";
    portBtns.append(addPortBtn, addBreakoutBtn); adv.appendChild(portBtns);

    const isDraftTrunk = (p: any) => draftPorts.some((c) => c.parent_port_id === p.id);
    const ptKind = (t: any) => (t && t.kind === "power") ? "power" : "data";
    const ptOptions = (selected: string | null, role: string) => {
      const kind = PortRoles.kind(role);
      const list = store.all("portTypes").filter((t: any) => ptKind(t) === kind).sort((a: any, b: any) => a.name.localeCompare(b.name));
      const opts = [{ value: "", label: "— type ? —" }].concat(list.map((t: any) => ({ value: t.id, label: t.name + " · " + t.family })));
      if (selected && !list.some((t: any) => t.id === selected)) { const cur: any = store.get("portTypes", selected); if (cur) opts.push({ value: cur.id, label: cur.name + " · " + cur.family + " (hors rôle)" }); }
      return FormControls.select(opts, selected || "");
    };
    const aggOptionsFor = (p: any) => FormControls.select([{ value: "", label: "— aucun —" }].concat(draftAggs.map((a) => ({ value: a.id, label: a.name || "(agrégat)" }))), p.aggregate_id || "");
    const bump = (s: string) => { s = String(s || ""); const m = s.match(/^(.*?)(\d+)(\D*)$/); return m ? m[1] + String(parseInt(m[2], 10) + 1).padStart(m[2].length, "0") + m[3] : (s ? s + "2" : ""); };

    const renderAggs = () => {
      aggList.innerHTML = "";
      if (!draftAggs.length) { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = "Aucun agrégat."; aggList.appendChild(e); }
      draftAggs.forEach((a, idx) => {
        const r = document.createElement("div"); r.className = "chip-row";
        const nm = document.createElement("input"); nm.className = "sub-input grow"; nm.value = a.name; nm.placeholder = "nom (ex. bond0)"; nm.oninput = () => { a.name = nm.value; };
        const rm = document.createElement("button"); rm.type = "button"; rm.className = "btn btn-danger btn-sm"; rm.textContent = "×";
        rm.onclick = () => { const removed = draftAggs.splice(idx, 1)[0]; draftPorts.forEach((p) => { if (p.aggregate_id === removed.id) p.aggregate_id = null; }); renderAggs(); renderPorts(); };
        r.appendChild(nm); r.appendChild(rm); aggList.appendChild(r);
      });
    };
    const portRow = (p: any, kind: string) => {
      const locked = kind === "trunk" || kind === "lane";
      const r = document.createElement("div"); r.className = "chip-row";
      if (kind === "lane") r.style.cssText = "margin-left:18px;border-left:2px solid var(--line-2);padding-left:8px;";
      const nm = document.createElement("input"); nm.className = "sub-input grow"; nm.value = p.name; nm.placeholder = kind === "trunk" ? "trunk" : (kind === "lane" ? "lane" : "ex. Eth1/1"); nm.oninput = () => { p.name = nm.value; };
      r.appendChild(nm);
      if (locked) {
        const rPill = document.createElement("span"); rPill.className = "pill"; rPill.textContent = PortRoles.label(p.role);
        const tt: any = p.port_type_id ? store.get("portTypes", p.port_type_id) : null;
        const tPill = document.createElement("span"); tPill.className = "pill"; tPill.textContent = tt ? tt.name : "type ?";
        r.appendChild(rPill); r.appendChild(tPill);
      } else {
        const rl = FormControls.select(PortRoles.ALL.map((x) => ({ value: x.id, label: x.label })), p.role || "data"); rl.className = "sub-input app-select";
        const pt = ptOptions(p.port_type_id, p.role); pt.className = "sub-input app-select";
        rl.onchange = () => { p.role = rl.value; const cur: any = p.port_type_id ? store.get("portTypes", p.port_type_id) : null; if (cur && ptKind(cur) !== PortRoles.kind(p.role)) p.port_type_id = null; if (PortRoles.kind(p.role) === "power") p.aggregate_id = null; renderPorts(); };
        pt.onchange = () => { p.port_type_id = pt.value || null; renderPorts(); };
        r.appendChild(rl); r.appendChild(pt);
      }
      if (kind === "trunk") {
        const tag = document.createElement("span"); tag.className = "pill"; tag.textContent = "breakout ×" + draftPorts.filter((c) => c.parent_port_id === p.id).length;
        const rm = document.createElement("button"); rm.type = "button"; rm.className = "btn btn-danger btn-sm"; rm.textContent = "×"; rm.title = "Supprimer le breakout";
        rm.onclick = () => { const ids = new Set([p.id, ...draftPorts.filter((c) => c.parent_port_id === p.id).map((c) => c.id)]); for (let i = draftPorts.length - 1; i >= 0; i--) if (ids.has(draftPorts[i].id)) draftPorts.splice(i, 1); renderPorts(); };
        r.appendChild(tag); r.appendChild(rm);
      } else if (kind === "lane") {
        const tag = document.createElement("span"); tag.className = "pill"; tag.textContent = "lane " + (p.lane || "?"); r.appendChild(tag);
      } else {
        if (PortRoles.kind(p.role) !== "power") { const ag = aggOptionsFor(p); ag.className = "sub-input app-select"; ag.onchange = () => { p.aggregate_id = ag.value || null; }; r.appendChild(ag); }
        const dup = document.createElement("button"); dup.type = "button"; dup.className = "btn btn-ghost btn-sm"; dup.textContent = "⎘"; dup.title = "Dupliquer";
        dup.onclick = () => { const i = draftPorts.indexOf(p); draftPorts.splice(i + 1, 0, Object.assign({}, p, { id: Id.uid(), name: bump(p.name), face_x: null, face_y: null })); renderPorts(); };
        const rm = document.createElement("button"); rm.type = "button"; rm.className = "btn btn-danger btn-sm"; rm.textContent = "×";
        rm.onclick = () => { const i = draftPorts.indexOf(p); if (i >= 0) draftPorts.splice(i, 1); renderPorts(); };
        r.appendChild(dup); r.appendChild(rm);
      }
      return r;
    };
    const renderPorts = () => {
      portList.innerHTML = "";
      if (!draftPorts.length) { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = "Aucun port."; portList.appendChild(e); }
      draftPorts.filter((p) => !p.parent_port_id).forEach((p) => {
        if (isDraftTrunk(p)) { portList.appendChild(portRow(p, "trunk")); draftPorts.filter((c) => c.parent_port_id === p.id).sort((a, b) => (a.lane || 0) - (b.lane || 0)).forEach((l) => portList.appendChild(portRow(l, "lane"))); }
        else portList.appendChild(portRow(p, "normal"));
      });
    };
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
      pduRow.style.display = (typeI.value === "pdu") ? "" : "none";
    };
    dimI.addEventListener("change", sync); typeI.addEventListener("change", sync); sync();

    // validation live (mêmes règles que le Store/serveur) : surligne le(s) champ(s) fautif(s) à l'enregistrement.
    const live = new LiveValidation("equipments", { name: nameI, type: typeI, u_height: uHI, group_id: groupI, rack_id: rackI, pdu_max_a: pduI }, (c, i) => store.get(c, i) || null);
    live.clearOnInput();

    host.openModal({
      title: eq ? "Modifier l'équipement" : "Nouvel équipement",
      subtitle: eq ? Html.escape(eq.name || "") : "Équipement, ses ports et agrégats",
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim();
        const inv = (invI as any).checked, free = dimI.value === "free";
        const payload: any = {
          name, type: typeI.value, brand: brandI.value.trim(), model: modelI.value.trim(), serial: serialI.value.trim(),
          inventory_only: inv, group_id: groupI.value || null, description: descI.value.trim(),
          purchase_date: (purchaseI as any).value || "", warranty_end: (warrantyI as any).value || "", po_ref: poI.value.trim(),
          assigned_date: (assignDateI as any).value || "", assigned_to: assignToI.value.trim(),
          pdu_max_a: pduI.value !== "" ? Math.max(0, parseInt(pduI.value, 10) || 0) : null,
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
          if ((pm === "side" && !sideRackI.value) || (pm === "wall" && !wallRackI.value)) { Notify.toast("Choisissez la baie du montage " + (pm === "side" ? "latéral" : "en paroi"), "err"); return false; }
          if (pm === "floor" && !fLocI.value) { Notify.toast("Choisissez le bâtiment du plan d'étage", "err"); return false; }
          payload.dc_id = null; payload.dc_x = null; payload.dc_y = null;
          payload.rack_id = null; payload.rack_u = null;
          payload.floor_x = null; payload.floor_y = null;
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
          }
        } else {
          payload.u_height = Math.max(1, parseInt(uHI.value, 10) || 1);
          payload.depth = depthI.value;
          payload.placement_mode = "rack";
          payload.rack_id = rackI.value || null;
          payload.rack_u = rackUI.value !== "" ? Math.max(1, parseInt(rackUI.value, 10) || 1) : null;
        }
        if (live.check(payload).length) return false;   // validation live : champ(s) surligné(s), enregistrement bloqué
        let eqId: string;
        if (eq) {
          await store.update("equipments", eq.id, payload); eqId = eq.id;
          // le (dé)placement peut invalider des routes de câbles — même casse contrôlée que les actions
          // des vues 2D/3D (assignSideSlot/assignWallSlot…) ; no-op si les routes restent valides.
          await store.applyCableBreaks(eqId);
        }
        else { const created: any = await store.create("equipments", payload); eqId = created.id; }

        // -- réconciliation agrégats --
        const draftAggIds = new Set(draftAggs.map((a) => a.id));
        for (const a of draftAggs) {
          const ex: any = store.get("aggregates", a.id);
          if (ex && ex.equipment_id === eqId) await store.update("aggregates", a.id, { name: (a.name || "").trim(), description: (a.description || "").trim() });
          else await store.create("aggregates", { id: a.id, equipment_id: eqId, name: (a.name || "").trim(), description: (a.description || "").trim() });
        }
        for (const a of store.aggregatesOf(eqId)) if (!draftAggIds.has(a.id)) await store.remove("aggregates", a.id);

        // -- réconciliation ports --
        const draftPortIds = new Set(draftPorts.map((p) => p.id));
        for (const p of draftPorts) {
          const agg = p.aggregate_id && draftAggIds.has(p.aggregate_id) ? p.aggregate_id : null;
          const patch: any = { equipment_id: eqId, name: (p.name || "").trim(), port_type_id: p.port_type_id || null, role: p.role || "data", aggregate_id: agg, description: (p.description || "").trim(), parent_port_id: p.parent_port_id || null, lane: (p.lane != null) ? p.lane : null, face_x: (p.face_x != null) ? p.face_x : null, face_y: (p.face_y != null) ? p.face_y : null, face_side: p.face_side };
          const ex: any = store.get("ports", p.id);
          if (ex) await store.update("ports", p.id, patch); else await store.create("ports", Object.assign({ id: p.id }, patch));
        }
        // retirer les lanes AVANT leur trunk (un trunk supprimé cascade ses lanes)
        const toRemove = store.portsOf(eqId).filter((p: any) => !draftPortIds.has(p.id));
        for (const p of toRemove) if (p.parent_port_id) await store.remove("ports", p.id);
        for (const p of toRemove) if (!p.parent_port_id && store.get("ports", p.id)) await store.remove("ports", p.id);

        host.setDirty?.(true); Notify.toast(eq ? "Équipement mis à jour" : "Équipement créé"); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** Câble — extrémités (contraintes famille + salle) · type compatible · FAISCEAU (brin → type/route/
      longueur hérités) · réseaux · POINTS DE PASSAGE (waypoints ordonnés, grammaire exit/OOB) · statut.
      `opts` : pré-remplissage (fromPortId/toPortId/fromEqId/bundleId/waypointIds) pour le routage 3D. */
}
