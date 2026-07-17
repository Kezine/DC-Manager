import type { Store } from "../../store";
import { Icons } from "../../ui/Icons";
import { FormControls } from "../../ui/FormControls";
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { Html } from "../../core/Html";
import { Format } from "../../core/Format";
import { LiveValidation } from "./LiveValidation";
import { Waypoint } from "../../models/Waypoint";
import { EquipmentTypes } from "../../registries/EquipmentTypes";
import { RackGeometry } from "../../geometry/RackGeometry";
import { RackScene } from "../../geometry/RackScene";
import { RackItemKinds } from "../../domain/RackItemKinds";
import { Normalize } from "../../core/Normalize";
import { I18n } from "../../i18n/I18n";   // lot B2a : options des tables de libellés (labelKey → I18n.t)
import {
  FLOORS, RACK_SIDES, RACK_FACES, RACK_DEPTHS,
  RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_MOUNT_MARGIN_DEFAULT, U_MM, SIDE_U_STEP,
  RACK_DEPTH_SAFETY_MM, TRAY_TYPES, TRAY_DEPTH_DEFAULT_MM,
  FLOOR_WIDTH_DEFAULT, FLOOR_DEPTH_DEFAULT, FLOOR_CELL_DEFAULT
} from "../../domain/constants";
import { FormUi, ORIENT_OPTS } from "./shared";
import type { FormHost } from "./shared";
import { CableForms } from "./CableForms";
import { EntityViz } from "../EntityViz";

export class RackForms extends CableForms {
  static rack(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const rk: any = id ? store.get("racks", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(rk ? rk.name : "", I18n.t("rack.rack.namePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.name"), nameI));

    // placement dans une SALLE (datacenter) → visible en vue 3D ; sinon « pool / hors salle ».
    const dcOpts = [{ value: "", label: I18n.t("rack.rack.poolNone") }].concat(store.all("datacenters").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((d: any) => ({ value: d.id, label: d.name || I18n.t("lists.ph.room") })));
    const dcSel = FormControls.select(dcOpts, rk && rk.datacenter_id ? rk.datacenter_id : "");
    root.appendChild(FormControls.fieldRow(I18n.t("rack.common.dcField"), dcSel, I18n.t("rack.rack.dcHint")));
    const dcxI = FormControls.number((rk && rk.dc_x != null) ? rk.dc_x : "", { min: 0, step: 10, placeholder: I18n.t("rack.common.centerX") });
    const dcyI = FormControls.number((rk && rk.dc_y != null) ? rk.dc_y : "", { min: 0, step: 10, placeholder: I18n.t("rack.common.centerY") });
    const orientI = FormControls.select(ORIENT_OPTS, String(Normalize.rackOrientation(rk ? rk.orientation : 0)));
    const posRow = FormUi.row2(FormControls.fieldRow(I18n.t("rack.common.posX"), dcxI), FormControls.fieldRow(I18n.t("rack.common.posY"), dcyI), FormControls.fieldRow(I18n.t("rack.rack.orientFront"), orientI));
    root.appendChild(posRow);
    // lieu/étage/local : manuels hors salle, hérités (verrouillés) si placé dans une salle.
    const locI = FormControls.select(FormUi.locOptions(store), rk ? rk.location : "");
    const floorI = FormControls.select(FormUi.floorOptions(rk ? rk.floor : ""), rk ? rk.floor : "");
    const roomI = FormControls.text(rk ? rk.room : "", I18n.t("rack.common.roomPlaceholder"));
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("rack.common.place"), locI), FormControls.fieldRow(I18n.t("lists.col.floor"), floorI), FormControls.fieldRow(I18n.t("lists.col.room"), roomI)));
    const dcHint = document.createElement("div"); dcHint.className = "form-hint"; root.appendChild(dcHint);
    const syncDc = () => {
      const d: any = dcSel.value ? store.get("datacenters", dcSel.value) : null;
      posRow.style.display = d ? "" : "none";
      [locI, floorI, roomI].forEach((el: any) => { el.disabled = !!d; el.style.opacity = d ? "0.7" : ""; });
      if (d) { locI.value = d.location || ""; FormUi.setOptions(floorI, FormUi.floorOptions(d.floor || ""), d.floor || ""); roomI.value = d.room || ""; }
      dcHint.innerHTML = d ? I18n.t("rack.rack.dcInherited", { name: Html.escape(d.name || I18n.t("lists.ph.room")), w: (d.width_mm / 1000).toFixed(1), d: (d.depth_mm / 1000).toFixed(1) }) : "";
    };
    dcSel.onchange = syncDc; syncDc();

    // Verrou de positionnement : empêche déplacer / pivoter / retirer la baie de la salle DEPUIS LES VUES 2D/3D
    // (cf. PlacementLock). Ce formulaire reste l'échappatoire (principe n°10) : placement modifiable même verrouillé.
    const lockedI = FormControls.toggle(I18n.t("rack.common.lockPos"), rk ? !!rk.locked : false, () => {}, { block: true, icon: Icons.LOCK, title: I18n.t("rack.rack.lockTitle") });
    root.appendChild(lockedI);

    // cage
    root.appendChild(FormUi.divider(I18n.t("rack.rack.cageDims")));
    const uI = FormControls.number(rk ? rk.u_count : 42, { min: 1 });
    const vmI = FormControls.number(rk ? RackGeometry.vMarginTop(rk) : RACK_MOUNT_MARGIN_DEFAULT, { min: 0 });
    const vmBotI = FormControls.number(rk && rk.vmargin_bottom_mm != null ? rk.vmargin_bottom_mm : "", { min: 0, placeholder: I18n.t("rack.rack.vmBotPlaceholder") });
    const cageI = FormControls.number(rk ? RackGeometry.cageDepth(rk) : RACK_DEPTH_DEFAULT, { min: 1 });
    const fmI = FormControls.number(rk ? RackGeometry.frontMargin(rk) : 0, { min: 0, placeholder: "0" });
    const lmI = FormControls.number(rk ? RackGeometry.lMargin(rk) : RACK_MOUNT_MARGIN_DEFAULT, { min: 0 });
    const sidesI = FormControls.select(RACK_SIDES.map((s) => ({ value: s.id, label: I18n.t(s.labelKey) })), rk ? rk.sides : "single");
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("rack.rack.heightU"), uI), FormControls.fieldRow(I18n.t("rack.rack.vMargin"), vmI), FormControls.fieldRow(I18n.t("rack.rack.vMarginBottom"), vmBotI)));
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("rack.rack.cageDepth"), cageI), FormControls.fieldRow(I18n.t("rack.rack.frontMargin"), fmI), FormControls.fieldRow(I18n.t("rack.rack.sideMargin"), lmI), FormControls.fieldRow(I18n.t("lists.col.faces"), sidesI)));

    // dimensions extérieures
    root.appendChild(FormUi.divider(I18n.t("rack.rack.extDims")));
    const widthI = FormControls.number(rk ? rk.width_mm : RACK_WIDTH_DEFAULT, { min: 1 });
    const heightI = FormControls.number(rk && rk.height_mm != null ? rk.height_mm : "", { min: 1, placeholder: I18n.t("rack.rack.heightMinPlaceholder") });
    const depthI = FormControls.number(rk ? rk.depth : RACK_DEPTH_DEFAULT, { min: 1 });
    FormControls.attachDatalist(depthI, "dl-rack-depth", RACK_DEPTHS.map(String));
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("rack.common.widthMm"), widthI), FormControls.fieldRow(I18n.t("rack.common.heightMm"), heightI), FormControls.fieldRow(I18n.t("rack.common.depthMm"), depthI)));
    const geoHint = document.createElement("div"); geoHint.className = "form-hint"; root.appendChild(geoHint);

    // side-mount — gouverne les emplacements de la MARGE **et** ceux contre les PAROIS (unifiés : cf. RackGeometry.wallEnabled)
    root.appendChild(FormUi.divider(I18n.t("rack.rack.sideMount")));
    const sideFrontI = FormControls.toggle(I18n.t("rack.rack.sideMountFront"), rk ? !!rk.allow_side_front : false, () => {}, { block: true });
    const sideRearI = FormControls.toggle(I18n.t("rack.rack.sideMountRear"), rk ? !!rk.allow_side_rear : false, () => {}, { block: true });
    root.appendChild(FormUi.row2(sideFrontI, sideRearI));

    // -- capots (habillage toit/fond) : attribut PHYSIQUE de la baie. Sans capots (châssis ouvert) : NI portes,
    //    NI emplacements waypoint sur le TOIT (le sol reste perçable) — invariants partagés T3/T3b + V6f. --
    const capsI = FormControls.toggle(I18n.t("rack.rack.caps"), rk ? rk.has_caps !== false : true, () => syncCaps(), { block: true, title: I18n.t("rack.rack.capsTitle") });
    root.appendChild(capsI);
    const capsHint = document.createElement("div"); capsHint.className = "form-hint";
    capsHint.textContent = I18n.t("rack.rack.capsHint");
    root.appendChild(capsHint);

    // -- portes (avant/arrière) en saillie : épaisseur, charnière, pleine/creuse --
    const doorsDivider = FormUi.divider(I18n.t("rack.rack.doorsDivider"));
    root.appendChild(doorsDivider);
    const doorInputs: Record<string, any> = {};
    const syncDoors = () => RACK_FACES.forEach((f) => {
      const di = doorInputs[f.id]; if (!di) return;
      di.ctrls.style.display = di.enI.checked ? "" : "none";
      di.hmRow.style.display = (di.enI.checked && di.hollowI.checked) ? "" : "none";
      di.hingeRow.style.display = di.leavesI.value === "2" ? "none" : "";   // double battant : charnière sans effet
    });
    const doorsWrap = document.createElement("div"); doorsWrap.style.cssText = "display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start;";
    RACK_FACES.forEach((face) => {
      const cur = Normalize.rackDoor(rk ? (face.id === "rear" ? rk.door_rear : rk.door_front) : null);
      const col = document.createElement("div"); col.style.cssText = "flex:1;min-width:230px;border:1px solid var(--line-2);border-radius:8px;padding:10px;";
      const enI = FormControls.toggle(I18n.t("rack.rack.doorToggle", { face: I18n.t(face.labelKey).toLowerCase() }), !!cur.enabled, () => syncDoors(), { block: true });
      col.appendChild(enI);
      const ctrls = document.createElement("div"); ctrls.style.marginTop = "8px"; col.appendChild(ctrls);
      const thI = FormControls.number(cur.thickness_mm, { min: 1, placeholder: "40" }); ctrls.appendChild(FormControls.fieldRow(I18n.t("rack.rack.thickness"), thI));
      const leavesI = FormControls.select([{ value: "1", label: I18n.t("rack.common.leaf1") }, { value: "2", label: I18n.t("rack.common.leaf2") }], String(cur.leaves || 1));
      leavesI.addEventListener("change", () => syncDoors());
      ctrls.appendChild(FormControls.fieldRow(I18n.t("rack.common.leaves"), leavesI));
      const hingeI = FormControls.select([{ value: "left", label: I18n.t("rack.rack.hingeLeft") }, { value: "right", label: I18n.t("rack.rack.hingeRight") }], cur.hinge);
      const hingeRow = FormControls.fieldRow(I18n.t("rack.rack.hinge"), hingeI);
      ctrls.appendChild(hingeRow);
      const hollowI = FormControls.toggle(I18n.t("rack.rack.hollow"), !!cur.hollow, () => syncDoors(), { block: true }); ctrls.appendChild(hollowI);
      const hmI = FormControls.number(cur.hollow_mm, { min: 0, placeholder: "0" });
      const hmRow = FormControls.fieldRow(I18n.t("rack.rack.hollowMm"), hmI, I18n.t("rack.rack.hollowHint"));
      ctrls.appendChild(hmRow);
      doorsWrap.appendChild(col);
      doorInputs[face.id] = { enI, thI, leavesI, hingeI, hollowI, hmI, ctrls, hmRow, hingeRow };
    });
    root.appendChild(doorsWrap); syncDoors();

    // -- capots : emplacements waypoint (toit/sol), grilles multi-sélection, TAMPON local --
    // (réservé à un rack EXISTANT : la grille dépend des dimensions enregistrées)
    // Les cellules sont éditées LOCALEMENT et appliquées au clic sur « Enregistrer », comme tous les autres
    // champs — l'ancienne sauvegarde immédiate écrivait DEUX fois (au changement de capot + au bouton).
    const capBuf: Record<string, string[]> = { roof: rk ? [...RackGeometry.capCells(rk, "roof")] : [], floor: rk ? [...RackGeometry.capCells(rk, "floor")] : [] };
    let roofCapCol: HTMLElement | null = null;   // colonne du capot TOIT — masquée quand la baie est « sans capots »
    if (rk) {
      root.appendChild(FormUi.divider(I18n.t("rack.rack.capsSection")));
      const capHint = document.createElement("div"); capHint.className = "form-hint"; capHint.style.textAlign = "center";
      capHint.textContent = I18n.t("rack.rack.capHint");
      root.appendChild(capHint);
      const capRow = document.createElement("div"); capRow.style.cssText = "display:flex;gap:22px;flex-wrap:wrap;justify-content:center;align-items:flex-start;margin-top:8px;";
      [{ face: "roof", label: I18n.t("rack.rack.capRoof") }, { face: "floor", label: I18n.t("rack.rack.capFloor") }].forEach((cf) => {
        const col = document.createElement("div"); col.style.textAlign = "center";
        const t = document.createElement("div"); t.className = "form-hint"; t.style.cssText = "font-weight:600;color:var(--fg);margin-bottom:4px;"; t.textContent = cf.label;
        col.appendChild(t); col.appendChild(this.capEditor(store, rk, cf.face, { get: () => capBuf[cf.face], set: (v) => { capBuf[cf.face] = v; } }).el);
        capRow.appendChild(col);
        if (cf.face === "roof") roofCapCol = col;
      });
      root.appendChild(capRow);
    }
    // Sans capots → sections PORTES et capot TOIT masquées (le sol reste éditable) ; hint de conversion visible.
    const syncCaps = () => {
      const caps = (capsI as any).checked !== false;
      doorsDivider.style.display = caps ? "" : "none";
      doorsWrap.style.display = caps ? "" : "none";
      if (roofCapCol) roofCapCol.style.display = caps ? "" : "none";
      capsHint.style.display = caps ? "none" : "";
    };
    syncCaps();

    const descI = FormControls.textArea(rk ? rk.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.description"), descI));

    const _n = (i: HTMLInputElement, d: number) => { const v = parseInt(i.value, 10); return isFinite(v) ? v : d; };
    const geo = () => {
      const u = Math.max(1, _n(uI, 42)), vt = Math.max(0, _n(vmI, 0)), vb = (vmBotI.value !== "") ? Math.max(0, _n(vmBotI, 0)) : Math.max(0, _n(vmI, 0));
      const lm = Math.max(0, _n(lmI, 0)), cage = Math.max(1, _n(cageI, RACK_DEPTH_DEFAULT)), fm = Math.max(0, _n(fmI, 0));
      return { u, vt, vb, lm, cage, fm, minH: u * U_MM + vt + vb, minW: RACK_MOUNT_WIDTH + 2 * lm, minD: cage + fm };
    };
    const refreshGeo = () => {
      const g = geo();
      geoHint.textContent = I18n.t("rack.rack.geoHint", { w: Math.round(g.minW), h: Math.round(g.minH), d: g.minD });
      const margin = Math.max(0, (_n(widthI, RACK_WIDTH_DEFAULT) - RACK_MOUNT_WIDTH) / 2);
      (sideFrontI as any).disabled = margin < U_MM; (sideRearI as any).disabled = margin < U_MM;
    };
    [uI, vmI, vmBotI, cageI, fmI, lmI, widthI, heightI, depthI].forEach((i) => i.addEventListener("input", refreshGeo));
    refreshGeo();

    // validation live (mêmes règles que le Store/serveur) : surligne le(s) champ(s) fautif(s) à l'enregistrement.
    const live = new LiveValidation("racks", { name: nameI, u_count: uI, width_mm: widthI, depth: depthI, sides: sidesI, datacenter_id: dcSel, dc_x: dcxI, dc_y: dcyI }, (c, i) => store.get(c, i) || null);
    live.clearOnInput();

    host.openModal({
      title: rk ? I18n.t("rack.rack.titleEdit") : I18n.t("rack.rack.titleNew"),
      subtitle: rk ? Html.escape(rk.name || "") : "",
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim();
        const g = geo();
        const minW = Math.round(g.minW), minH = Math.round(g.minH), minD = g.minD;
        let width_mm = Math.max(1, _n(widthI, RACK_WIDTH_DEFAULT)); if (width_mm < minW) width_mm = minW;
        let depth = Math.max(1, _n(depthI, RACK_DEPTH_DEFAULT)); if (depth < minD) depth = minD;
        let height_mm: number | null = (heightI.value !== "") ? Math.max(1, _n(heightI, minH)) : null;
        if (height_mm != null && height_mm < minH) height_mm = minH;
        const sideOk = (width_mm - RACK_MOUNT_WIDTH) / 2 >= U_MM;
        const hasCaps = (capsI as any).checked !== false;
        // garde-fou explicite (parité avec la règle partagée V6f) : passer « sans capots » exige qu'aucun
        // waypoint ne soit encore posé sur le TOIT — sinon le pin perdrait son support.
        if (!hasCaps && rk && store.findByField("waypoints", "rack_id", rk.id).some((w: any) => w.cap_face === "roof")) {
          Notify.toast(I18n.t("rack.rack.removeRoofWps"), "err");
          return false;
        }
        // placement salle : centre par défaut si position vide ; lieu/étage/local hérités de la salle.
        const placeDc: any = dcSel.value ? store.get("datacenters", dcSel.value) : null;
        const datacenter_id = placeDc ? placeDc.id : null;
        const dc_x = placeDc ? (dcxI.value !== "" ? Math.max(0, parseInt(dcxI.value, 10) || 0) : Math.round(placeDc.width_mm / 2)) : null;
        const dc_y = placeDc ? (dcyI.value !== "" ? Math.max(0, parseInt(dcyI.value, 10) || 0) : Math.round(placeDc.depth_mm / 2)) : null;
        const payload: any = {
          name,
          datacenter_id, dc_x, dc_y, orientation: Normalize.rackOrientation(parseInt(orientI.value, 10) || 0),
          location: placeDc ? (placeDc.location || "") : (locI.value || ""), floor: placeDc ? (placeDc.floor || "") : floorI.value, room: placeDc ? (placeDc.room || "") : roomI.value.trim(),
          u_count: g.u, width_mm, depth, sides: sidesI.value === "dual" ? "dual" : "single",
          lmargin_mm: g.lm, vmargin_mm: g.vt, vmargin_bottom_mm: (vmBotI.value !== "") ? g.vb : null,
          cage_depth_mm: g.cage, front_margin_mm: g.fm, height_mm, mount_margin_mm: g.lm,
          allow_side_front: sideOk && (sideFrontI as any).checked, allow_side_rear: sideOk && (sideRearI as any).checked,
          has_caps: hasCaps, locked: (lockedI as any).checked,
          // SANS CAPOTS : la configuration des portes est SUPPRIMÉE (remise aux défauts, désactivée) — pas
          // seulement masquée. Invariant partagé T3 (une baie sans capots ne peut pas avoir de portes).
          door_front: !hasCaps ? Normalize.rackDoor(null) : { enabled: (doorInputs.front.enI as any).checked, thickness_mm: Math.max(1, parseInt(doorInputs.front.thI.value, 10) || 40), hinge: doorInputs.front.hingeI.value === "right" ? "right" : "left", leaves: doorInputs.front.leavesI.value === "2" ? 2 : 1, hollow: (doorInputs.front.hollowI as any).checked, hollow_mm: Math.max(0, parseInt(doorInputs.front.hmI.value, 10) || 0) },
          door_rear: !hasCaps ? Normalize.rackDoor(null) : { enabled: (doorInputs.rear.enI as any).checked, thickness_mm: Math.max(1, parseInt(doorInputs.rear.thI.value, 10) || 40), hinge: doorInputs.rear.hingeI.value === "right" ? "right" : "left", leaves: doorInputs.rear.leavesI.value === "2" ? 2 : 1, hollow: (doorInputs.rear.hollowI as any).checked, hollow_mm: Math.max(0, parseInt(doorInputs.rear.hmI.value, 10) || 0) },
          description: descI.value.trim(),
        };
        // Cellules de capot ÉDITÉES DANS LE TAMPON (rack existant seulement — pas d'éditeur sur une baie neuve) :
        // appliquées ICI, en une seule écriture avec le reste du formulaire. Sans capots : TOIT vidé (invariant
        // T3b) — le SOL est conservé (perçable par un waypoint via le faux-plancher).
        if (rk) { payload.roof_cells = hasCaps ? capBuf.roof : []; payload.floor_cells = capBuf.floor; }
        if (live.check(payload).length) return false;   // validation live : champ(s) surligné(s), enregistrement bloqué
        // redimensionnement d'une baie occupée (nombre de U) → déplace ses équipements
        if (rk && g.u !== rk.u_count) {
          const occ = store.equipmentsOfRack(rk.id);
          if (occ.length) {
            const ok = await Dialog.confirm({ title: I18n.t("rack.rack.resizeTitle"), message: I18n.t("rack.rack.resizeMsg", { count: occ.length }), confirmLabel: I18n.t("rack.rack.resizeConfirm"), danger: true });
            if (!ok) return false;
            await store.updateBatch([{ collection: "racks", id: rk.id, patch: payload }].concat(occ.map((e: any) => ({ collection: "equipments", id: e.id, patch: { placement_mode: "manual", rack_id: null, rack_u: null } }))));
            host.setDirty?.(true); Notify.toast(I18n.t("rack.rack.resized")); onSaved?.(); return true;
          }
        }
        if (rk) await store.update("racks", rk.id, payload); else await store.create("racks", payload);
        host.setDirty?.(true); Notify.toast(rk ? I18n.t("rack.rack.updated") : I18n.t("rack.rack.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** FICHE D'INFO d'une BAIE (lecture seule, riche) — en miroir de equipmentDetail : identité, emplacement,
      dimensions, portes, occupation (U libres/contigus), liste des équipements montés, puis « Localiser » /
      « Modifier ». Remplace l'ancien listing de champs générique. */
  static rackDetail(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const rk: any = store.get("racks", id);
    if (!rk) { Notify.toast(I18n.t("rack.nf.rack"), "err"); return; }
    const scene = new RackScene(store);
    const root = document.createElement("div");
    const grid = document.createElement("div"); grid.className = "detail-grid";
    const add = (label: string, html: string) => { grid.appendChild(this.dt(label)); grid.appendChild(this.dd(html)); };

    add(I18n.t("lists.col.name"), Html.escape(rk.name || I18n.t("lists.ph.noName")));
    const dc: any = rk.datacenter_id ? store.get("datacenters", rk.datacenter_id) : null;
    add(I18n.t("lists.col.location"), EntityViz.rackLocation(store, rk));   // même fil d'Ariane (icônes Bât. › Étage › Salle) que les listings
    if (dc && (rk.dc_x != null || rk.dc_y != null)) add(I18n.t("rack.rackDetail.posInRoom"), I18n.t("rack.rackDetail.posValue", { x: rk.dc_x != null ? rk.dc_x : "?", y: rk.dc_y != null ? rk.dc_y : "?", deg: Normalize.rackOrientation(rk.orientation) }));
    add(I18n.t("lists.col.size"), `<span class="pill">${rk.u_count} U</span> · ${rk.sides === "dual" ? I18n.t("domain.rackSide.dual") : I18n.t("domain.rackSide.single")}${rk.has_caps === false ? ` · <span class="pill">${I18n.t("rack.rackDetail.openFrame")}</span>` : ""}`);
    add(I18n.t("lists.col.dimensions"), `${rk.width_mm || RACK_WIDTH_DEFAULT} × ${RackGeometry.physHeight(rk)} × ${rk.depth || RACK_DEPTH_DEFAULT} mm <span style="color:var(--fg-dimmer)">${I18n.t("rack.rackDetail.lhp")}</span> · ${I18n.t("rack.rackDetail.cageVal", { cage: RackGeometry.cageDepth(rk) })}`);
    const doors: string[] = [];
    if (rk.door_front && rk.door_front.enabled) doors.push(I18n.t("rack.rackDetail.doorFront") + (rk.door_front.leaves === 2 ? I18n.t("rack.rackDetail.twoLeaves") : ""));
    if (rk.door_rear && rk.door_rear.enabled) doors.push(I18n.t("rack.rackDetail.doorRear") + (rk.door_rear.leaves === 2 ? I18n.t("rack.rackDetail.twoLeaves") : ""));
    add(I18n.t("rack.rackDetail.doors"), doors.length ? doors.map((d) => `<span class="pill">${d}</span>`).join(" ") : `<span style="color:var(--fg-dimmer)">${I18n.t("rack.rackDetail.noneF")}</span>`);
    const free = scene.freeUInfo(rk.id);
    add(I18n.t("rack.rackDetail.occupation"), `<span class="pill">${I18n.t("rack.rackDetail.occCount", { n: scene.occupancyCount(rk.id) })}</span> · <span class="pill">${I18n.t("rack.rackDetail.uFree", { n: free.free })}</span> · <span class="pill">${I18n.t("rack.rackDetail.uContig", { n: free.contig })}</span> <span style="color:var(--fg-dimmer)">${I18n.t("rack.rackDetail.uTotal", { total: free.total })}</span>`);
    add(I18n.t("lists.col.description"), rk.description ? Html.escape(rk.description) : "—");
    add(I18n.t("rack.common.created"), Html.escape(Format.dateTime(rk.created_date)));
    add(I18n.t("rack.common.updated"), Html.escape(Format.dateTime(rk.updated_date)));
    root.appendChild(grid);

    // équipements montés dans la baie (triés par U)
    const eqs = store.equipmentsOfRack(rk.id).slice().sort((a: any, b: any) => (a.rack_u || 0) - (b.rack_u || 0));
    const dE = document.createElement("div"); dE.className = "section-divider"; dE.textContent = I18n.t("rack.rackDetail.equipsSection", { count: eqs.length }); root.appendChild(dE);
    if (eqs.length) {
      const tw = document.createElement("div"); tw.className = "table-wrap";
      const rows = eqs.map((e: any) => {
        const uPos = (e.placement_mode === "rack" && e.rack_u != null)
          ? ("U" + e.rack_u + ((e.u_height || 1) > 1 ? "–U" + (e.rack_u + (e.u_height || 1) - 1) : ""))
          : (e.placement_mode === "side" ? I18n.t("rack.rackDetail.uSide") : e.placement_mode === "wall" ? I18n.t("rack.rackDetail.uWall") : "—");
        return `<tr><td class="cell-name">${Html.escape(e.name || I18n.t("lists.ph.equipment"))}</td><td><span class="pill">${Html.escape(EquipmentTypes.label(e.type))}</span></td><td style="font-family:var(--mono)">${Html.escape(uPos)}</td><td class="cell-actions">${host.locate ? `<button class="btn btn-ghost btn-sm icon-action" data-eq-loc="${e.id}" title="${I18n.t("lists.chrome.rowLocate")}" aria-label="${I18n.t("lists.chrome.rowLocate")}">${Icons.LOCATE}</button>` : ""}<button class="btn btn-ghost btn-sm icon-action" data-eq-view="${e.id}" title="${I18n.t("lists.chrome.rowView")}" aria-label="${I18n.t("lists.chrome.rowView")}">${Icons.INFO}</button></td></tr>`;
      }).join("");
      tw.innerHTML = `<table><thead><tr><th>${I18n.t("lists.col.equipment")}</th><th>${I18n.t("lists.col.type")}</th><th>${I18n.t("rack.rackDetail.colU")}</th><th style="text-align:right;">${I18n.t("lists.chrome.actions")}</th></tr></thead><tbody>${rows}</tbody></table>`;
      root.appendChild(tw);
      tw.querySelectorAll("[data-eq-view]").forEach((b) => { (b as HTMLElement).onclick = () => this.equipmentDetail(store, host, (b as HTMLElement).dataset.eqView!, onChanged); });
      tw.querySelectorAll("[data-eq-loc]").forEach((b) => { (b as HTMLElement).onclick = () => host.locate?.("equipment", (b as HTMLElement).dataset.eqLoc!, () => this.rackDetail(store, host, rk.id, onChanged)); });
    } else { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = I18n.t("rack.rackDetail.empty"); root.appendChild(e); }

    // actions : Localiser en 3D + Gérer le contenu + Modifier
    const actions = document.createElement("div"); actions.style.cssText = "margin-top:16px;display:flex;justify-content:flex-end;gap:8px";
    if (host.locate) { const locBtn = document.createElement("button"); locBtn.type = "button"; locBtn.className = "btn btn-ghost"; locBtn.innerHTML = `<span class="gi">${Icons.LOCATE}</span>${I18n.t("lists.chrome.rowLocate")}`; locBtn.onclick = () => host.locate!("rack", rk.id, () => this.rackDetail(store, host, rk.id, onChanged)); actions.appendChild(locBtn); }
    if (!this.isViewer()) {   // viewer : pas d'édition
      const contentBtn = document.createElement("button"); contentBtn.type = "button"; contentBtn.className = "btn btn-ghost"; contentBtn.textContent = I18n.t("rack.rackDetail.contentBtn");
      contentBtn.title = I18n.t("rack.rackDetail.contentTitle");
      contentBtn.onclick = () => this.rackContent(store, host, rk.id, onChanged);
      actions.appendChild(contentBtn);
      const editBtn = document.createElement("button"); editBtn.type = "button"; editBtn.className = "btn btn-primary"; editBtn.textContent = I18n.t("lists.chrome.rowEdit");
      editBtn.onclick = () => this.rack(store, host, rk.id, onChanged);
      actions.appendChild(editBtn);
    }
    root.appendChild(actions);

    host.openModal({ title: I18n.t("rack.rackDetail.title"), subtitle: Html.escape(rk.name || ""), body: root, hideFooter: true, wide: true });
  }

  /** MODALE « CONTENU » d'une baie (réplique modulaire de `openRackContent` du monolithe v170) : éditeur
      INTERACTIF du montage — élévation U cliquable (monter/retirer), montage LIBRE (sans U : PDU vertical…) et
      montage LATÉRAL (marges). Simple ORCHESTRATION de briques héritées : la grille `FormBase.rackFrontGrid`, les
      dialogues `assignSlot`/`assignSideSlot`, les grilles de marge `FormBase.sideGrid`, l'occupation
      `RackScene.occupants`/`sideOccupants`. Reste ICI, avec sa jumelle `rackDetail` (qui l'ouvre) — paire cohérente
      de modales de baie, non réutilisée ailleurs ; c'est le CONSTRUCTEUR DE GRILLE réutilisable qui a été sorti
      dans FormBase (à côté de `sideGrid`/`capPickGrid`). */
  static rackContent(store: Store, host: FormHost, id: string, onChanged?: () => void): void {
    const rack: any = store.get("racks", id);
    if (!rack) { Notify.toast(I18n.t("rack.nf.rack"), "err"); return; }
    const scene = new RackScene(store);
    const root = document.createElement("div");
    const head = document.createElement("div"); head.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;";
    const sub = document.createElement("div"); sub.className = "form-hint";
    sub.textContent = I18n.t("rack.rackContent.sub", { u: rack.u_count, depth: rack.depth || RACK_DEPTH_DEFAULT, faces: rack.sides === "dual" ? I18n.t("rack.common.dualLower") : I18n.t("rack.common.singleLower") });
    const freeBtn = document.createElement("button"); freeBtn.type = "button"; freeBtn.className = "btn btn-ghost btn-sm"; freeBtn.textContent = I18n.t("rack.rackContent.freeBtn");
    head.append(sub, freeBtn); root.appendChild(head);

    // (re)rendu complet des listes annexes (montage libre + latéral) après chaque mutation.
    let render = () => {};
    const removeMount = async (kind: string, mid: string) => {
      if (kind === "equipment") {
        if (!store.get("equipments", mid)) return;
        const downs = store.equipmentDcId(mid) ? store.cableDowngradeOps([mid]) : [];
        await store.updateBatch([{ collection: "equipments", id: mid, patch: { placement_mode: "manual", rack_id: null, rack_u: null } }].concat(downs as any));
        Notify.toast(I18n.t("rack.rackContent.equipRemoved") + (downs.length ? I18n.t("rack.rackContent.cablesReplanned") : ""));
      } else if (kind === "brush") {
        if (!store.get("waypoints", mid)) return;
        await store.update("waypoints", mid, { rack_id: null });
        Notify.toast(I18n.t("rack.rackContent.brushRemoved"));
      } else { await store.remove("rackItems", mid); Notify.toast(I18n.t("rack.rackContent.itemRemoved")); }
      host.setDirty?.(true); render();
    };
    const done = () => { host.setDirty?.(true); render(); onChanged?.(); };
    const gridApi = this.rackFrontGrid(store, rack, {
      onSlotClick: (u, face) => this.assignSlot(store, host, rack.id, u, face, 1, done),
      onRemove: (kind, mid) => { removeMount(kind, mid); },
    });
    root.appendChild(gridApi.el);

    // ---- montage LIBRE (rattaché au rack, sans position U) ----
    const divFree = document.createElement("div"); divFree.className = "section-divider"; divFree.textContent = I18n.t("rack.rackContent.freeSection"); root.appendChild(divFree);
    const freeList = document.createElement("div"); freeList.className = "chip-list"; root.appendChild(freeList);

    // ---- montage LATÉRAL (marges) : une grille par face activée ----
    const sideFaces = ["front", "rear"].filter((f) => RackGeometry.sideEnabled(rack, f));
    const sideGridApis: Array<{ refresh: () => void }> = [];
    let sideList: HTMLElement | null = null;
    if (sideFaces.length) {
      const divSide = document.createElement("div"); divSide.className = "section-divider"; divSide.textContent = I18n.t("rack.rackContent.sideSection"); root.appendChild(divSide);
      const sideHint = document.createElement("div"); sideHint.className = "form-hint";
      sideHint.textContent = I18n.t("rack.rackContent.sideHint", { n: SIDE_U_STEP });
      root.appendChild(sideHint);
      sideFaces.forEach((face) => {
        if (sideFaces.length > 1) { const fl = document.createElement("div"); fl.className = "form-hint"; fl.style.cssText = "margin-top:8px;font-weight:600;color:var(--fg);"; fl.textContent = this.faceLabel(face); root.appendChild(fl); }
        const host2 = document.createElement("div"); root.appendChild(host2);
        const api = this.sideGrid(store, scene, rack, { face, heightU: SIDE_U_STEP, width: 0, onPick: (lr: string, col: number, u: number) => this.assignSideSlot(store, host, rack.id, face, lr, col, u, done) });
        host2.appendChild(api.el); sideGridApis.push(api);
      });
      sideList = document.createElement("div"); sideList.className = "chip-list"; sideList.style.marginTop = "8px"; root.appendChild(sideList);
    }

    render = () => {
      gridApi.refresh();
      // montage libre = équipements rackés SUR ce rack mais sans U (rack_u null)
      freeList.innerHTML = "";
      const frees = store.equipmentsOfRack(rack.id).filter((e: any) => e.placement_mode === "rack" && e.rack_id === rack.id && e.rack_u == null);
      if (!frees.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = I18n.t("rack.rackContent.freeEmpty"); freeList.appendChild(h); }
      frees.forEach((e: any) => {
        const row = document.createElement("div"); row.className = "chip-row";
        const lab = document.createElement("span"); lab.className = "grow"; lab.textContent = (e.name || I18n.t("lists.ph.noName")) + " · " + (e.u_height || 1) + "U " + this.mountDepthLabel(e);
        const rm = document.createElement("button"); rm.type = "button"; rm.className = "btn btn-danger btn-sm"; rm.textContent = "×"; rm.title = I18n.t("forms.rack.remove"); rm.onclick = () => removeMount("equipment", e.id);
        row.append(lab, rm); freeList.appendChild(row);
      });
      // montage latéral : rafraîchir les grilles + lister les occupants de marge (retirables)
      sideGridApis.forEach((api) => api.refresh());
      if (sideList) {
        sideList.innerHTML = "";
        const occ = scene.sideOccupants(rack.id, null, null).sort((a: any, b: any) => (a.side_u | 0) - (b.side_u | 0));
        if (!occ.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = I18n.t("rack.rackContent.sideEmpty"); sideList.appendChild(h); }
        occ.forEach((e: any) => {
          const hU = RackGeometry.sideEquipHeightU(e), face = (e.side_face === "rear") ? "rear" : "front";
          const row = document.createElement("div"); row.className = "chip-row";
          const lab = document.createElement("span"); lab.className = "grow";
          lab.textContent = (e.name || I18n.t("lists.ph.noName")) + " · " + I18n.t("rack.rackContent.marginLabel", { lr: e.side_lr === "right" ? I18n.t("rack.common.rightLower") : I18n.t("rack.common.leftLower") }) + " · U" + (e.side_u | 0) + (hU > 1 ? "–U" + ((e.side_u | 0) + hU - 1) : "") + (rack.sides === "dual" ? " · " + this.faceLabel(face) : "");
          const rm = document.createElement("button"); rm.type = "button"; rm.className = "btn btn-danger btn-sm"; rm.textContent = "×"; rm.title = I18n.t("forms.rack.remove"); rm.onclick = () => removeMount("equipment", e.id);
          row.append(lab, rm); sideList!.appendChild(row);
        });
      }
    };

    // affecter un équipement au rack SANS position U (PDU vertical, équipement volant…)
    freeBtn.onclick = async () => {
      const eqFree = store.unrackedEquipments().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
      if (!eqFree.length) { Notify.toast(I18n.t("rack.rackContent.noFreeEquip"), "err"); return; }
      const body = document.createElement("div");
      const eqI = FormControls.select([{ value: "", label: I18n.t("rack.common.choose") }].concat(eqFree.map((e: any) => ({ value: e.id, label: e.name || I18n.t("lists.ph.noName") }))), "");
      body.appendChild(FormControls.fieldRow(I18n.t("rack.common.equipField"), eqI, I18n.t("rack.rackContent.freeEquipHint")));
      const res = await Dialog.custom({ title: I18n.t("rack.rackContent.freeDialogTitle"), confirmLabel: I18n.t("rack.rackContent.assign"), build: (r: HTMLElement) => { r.appendChild(body); return { validate: () => eqI.value ? true as const : I18n.t("rack.common.chooseEquip"), collect: () => eqI.value }; } });
      if (!res) return;
      await store.update("equipments", res, { placement_mode: "rack", rack_id: rack.id, rack_u: null, rack_side: "front" });
      Notify.toast(I18n.t("rack.rackContent.freeAssigned")); done();
    };

    render();
    host.openModal({ title: I18n.t("rack.rackContent.title", { name: Html.escape(rack.name || I18n.t("rack.common.rackWord")) }), subtitle: I18n.t("rack.rackContent.subtitle"), body: root, hideFooter: true, wide: true });
  }

  /** SITE (bâtiment) — niveau racine de la hiérarchie physique : nom · adresse · description.
      La SUPPRESSION (décommissionnement) se fait depuis le panneau latéral (carte Site), via store.removeSite. */
  static site(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const s: any = id ? store.get("sites", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(s ? s.name : "", I18n.t("rack.site.namePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.name"), nameI));
    const addrI = FormControls.text(s ? s.address : "", I18n.t("rack.site.addrPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.address"), addrI));
    const descI = FormControls.textArea(s ? s.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.description"), descI));
    const live = new LiveValidation("sites", { name: nameI });
    live.clearOnInput();
    host.openModal({
      title: s ? I18n.t("rack.site.titleEdit") : I18n.t("rack.site.titleNew"),
      subtitle: s ? Html.escape(s.name) : "",
      body: root,
      onSave: async () => {
        const payload = { name: nameI.value.trim(), address: addrI.value.trim(), description: descI.value.trim() };
        if (live.check(payload).length) return false;   // nom requis (surligné)
        if (s) await store.update("sites", s.id, payload); else await store.create("sites", payload);
        host.setDirty?.(true); Notify.toast(s ? I18n.t("rack.site.updated") : I18n.t("rack.site.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** CONTACT — destinataire des NOTIFICATIONS (email/sms), tenu PAR DOCUMENT : nom (requis) · e-mail ·
      téléphone · notes. Validation TOLÉRANTE (cf. spec `contacts` : e-mail/téléphone contrôlés « en douceur »,
      jamais bloquants sur une saisie raisonnable). Placé ici, aux côtés du formulaire `site` (autre entité
      « plate » simple) : le FORMULAIRE ne bouge pas ; seul son ONGLET a migré sous le groupe « Paramètres » (S6). */
  static contact(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const c: any = id ? store.get("contacts", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(c ? c.name : "", I18n.t("rack.contact.namePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.name"), nameI));
    const emailI = FormControls.text(c ? c.email : "", I18n.t("rack.contact.emailPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.email"), emailI, I18n.t("rack.contact.emailHint")));
    const phoneI = FormControls.text(c ? c.phone : "", I18n.t("rack.contact.phonePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.phone"), phoneI, I18n.t("rack.contact.phoneHint")));
    const notesI = FormControls.textArea(c ? c.notes : "");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.notes"), notesI));
    // Surligne les 3 champs porteurs de règles (nom requis + e-mail/téléphone tolérants) — même validation
    // PARTAGÉE que le Store/serveur, donc ce qui est surligné ici est exactement ce que l'autorité refuse.
    const live = new LiveValidation("contacts", { name: nameI, email: emailI, phone: phoneI });
    live.clearOnInput();
    host.openModal({
      title: c ? I18n.t("rack.contact.titleEdit") : I18n.t("rack.contact.titleNew"),
      subtitle: c ? Html.escape(c.name) : "",
      body: root,
      onSave: async () => {
        const payload = { name: nameI.value.trim(), email: emailI.value.trim(), phone: phoneI.value.trim(), notes: notesI.value.trim() };
        if (live.check(payload).length) return false;   // nom requis + e-mail/téléphone invalides (surlignés)
        if (c) await store.update("contacts", c.id, payload); else await store.create("contacts", payload);
        host.setDirty?.(true); Notify.toast(c ? I18n.t("rack.contact.updated") : I18n.t("rack.contact.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** Réseau IP (sous-réseau CIDR). */
  /** Salle (datacenter) — grille au sol : nom · dimensions (mm) · maille · localisation. */
  static datacenter(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const dc: any = id ? store.get("datacenters", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(dc ? dc.name : "", I18n.t("rack.datacenter.namePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.name"), nameI));
    root.appendChild(FormUi.divider(I18n.t("rack.datacenter.dims")));
    const wI = FormControls.number(dc ? dc.width_mm : 6000, { min: 1, step: 100, placeholder: I18n.t("rack.datacenter.widthPlaceholder") });
    const dI = FormControls.number(dc ? dc.depth_mm : 4000, { min: 1, step: 100, placeholder: I18n.t("rack.datacenter.depthPlaceholder") });
    const cI = FormControls.number(dc ? dc.cell_mm : 600, { min: 1, step: 50, placeholder: I18n.t("rack.datacenter.meshPlaceholder") });
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("rack.common.widthMm"), wI), FormControls.fieldRow(I18n.t("rack.common.depthMm"), dI), FormControls.fieldRow(I18n.t("rack.datacenter.meshField"), cI)));
    root.appendChild(FormUi.divider(I18n.t("rack.datacenter.location")));
    const locI = FormControls.select(FormUi.locOptions(store), dc ? dc.location : "");
    const floorI = FormControls.select(FormUi.floorOptions(dc ? dc.floor : ""), dc ? dc.floor : "");
    const roomI = FormControls.text(dc ? dc.room : "", I18n.t("rack.common.roomPlaceholder"));
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("rack.common.place"), locI), FormControls.fieldRow(I18n.t("lists.col.floor"), floorI), FormControls.fieldRow(I18n.t("lists.col.room"), roomI)));
    const live = new LiveValidation("datacenters", { name: nameI });
    live.clearOnInput();

    host.openModal({
      title: dc ? I18n.t("rack.datacenter.titleEdit") : I18n.t("rack.datacenter.titleNew"),
      subtitle: dc ? Html.escape(dc.name || "") : I18n.t("rack.datacenter.subtitleNew"),
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim();
        const payload = {
          name,
          width_mm: Math.max(1, parseInt(wI.value, 10) || 6000), depth_mm: Math.max(1, parseInt(dI.value, 10) || 4000), cell_mm: Math.max(1, parseInt(cI.value, 10) || 600),
          location: locI.value || "", floor: floorI.value, room: roomI.value.trim(),
        };
        if (live.check(payload).length) return false;   // nom requis (surligné)
        if (dc) await store.update("datacenters", dc.id, payload); else await store.create("datacenters", payload);
        host.setDirty?.(true); Notify.toast(dc ? I18n.t("rack.datacenter.updated") : I18n.t("rack.datacenter.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** Édition d'une PORTE de salle (value-object stocké sur le datacenter). Mur, position, largeur/hauteur, listel
      (→ passage libre = largeur max d'équipement), côté charnière et sens d'ouverture. */
  static door(store: Store, host: FormHost, dcId: string, doorId: string, onSaved?: () => void): void {
    const dc: any = store.get("datacenters", dcId); if (!dc) { Notify.toast(I18n.t("rack.nf.datacenter"), "err"); return; }
    const door: any = (dc.doors || []).find((d: any) => d.id === doorId); if (!door) { Notify.toast(I18n.t("rack.nf.door"), "err"); return; }
    const root = document.createElement("div");
    const wallI = FormControls.select([{ value: "top", label: I18n.t("rack.door.wallTop") }, { value: "bottom", label: I18n.t("rack.door.wallBottom") }, { value: "left", label: I18n.t("rack.door.wallLeft") }, { value: "right", label: I18n.t("rack.door.wallRight") }], door.wall);
    const offI = FormControls.number(door.offset, { min: 0, step: 10, placeholder: I18n.t("rack.door.offsetPlaceholder") });
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("rack.door.wall"), wallI), FormControls.fieldRow(I18n.t("rack.door.posOnWall"), offI)));
    const wI = FormControls.number(door.width_mm, { min: 100, step: 10 });
    const hI = FormControls.number(door.height_mm, { min: 100, step: 10 });
    const fI = FormControls.number(door.frame_mm, { min: 0, step: 5 });
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("rack.door.openWidth"), wI), FormControls.fieldRow(I18n.t("rack.common.heightMm"), hI), FormControls.fieldRow(I18n.t("rack.door.frameThick"), fI)));
    const leavesI = FormControls.select([{ value: "1", label: I18n.t("rack.common.leaf1") }, { value: "2", label: I18n.t("rack.common.leaf2") }], String(door.leaves || 1));
    const hinI = FormControls.select([{ value: "left", label: I18n.t("rack.common.left") }, { value: "right", label: I18n.t("rack.common.right") }], door.hinge);
    const opI = FormControls.select([{ value: "interior", label: I18n.t("rack.door.openInterior") }, { value: "exterior", label: I18n.t("rack.door.openExterior") }], door.opening);
    const hinRow = FormControls.fieldRow(I18n.t("rack.door.hingeSide"), hinI);
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("rack.common.leaves"), leavesI), hinRow, FormControls.fieldRow(I18n.t("rack.door.openDir"), opI)));
    const hint = document.createElement("div"); hint.className = "form-hint"; root.appendChild(hint);
    const sync = () => {
      const w = Math.max(100, parseInt(wI.value, 10) || 900), f = Math.max(0, parseInt(fI.value, 10) || 0);
      const dbl = leavesI.value === "2";
      hinRow.style.display = dbl ? "none" : "";   // double battant : charnières aux DEUX extrémités → champ sans effet
      hint.innerHTML = I18n.t("rack.door.freePassage", { mm: Math.max(0, w - 2 * f), note: dbl ? I18n.t("rack.door.dblNote") : I18n.t("rack.door.hingeNote") });
    };
    wI.oninput = sync; fI.oninput = sync; leavesI.addEventListener("change", sync); sync();
    host.openModal({
      title: I18n.t("rack.door.title"), subtitle: Html.escape(dc.name || ""), body: root, wide: true,
      onSave: async () => {
        const patch = { wall: wallI.value, offset: Math.max(0, parseInt(offI.value, 10) || 0), width_mm: Math.max(100, parseInt(wI.value, 10) || 900), height_mm: Math.max(100, parseInt(hI.value, 10) || 2100), frame_mm: Math.max(0, parseInt(fI.value, 10) || 0), hinge: hinI.value === "right" ? "right" : "left", leaves: leavesI.value === "2" ? 2 : 1, opening: opI.value === "exterior" ? "exterior" : "interior" };
        await store.update("datacenters", dcId, { doors: (dc.doors || []).map((d: any) => (d.id === doorId ? { ...d, ...patch } : d)) });
        host.setDirty?.(true); Notify.toast(I18n.t("rack.door.updated")); onSaved?.(); return true;
      },
    });
  }

  /** Édition d'un waypoint. CONTRAINTE : seuls le NOM, le positionnement LOCAL (hauteur + grille capot/marge) et la
      description restent modifiables. Le type, la forme, la salle/baie et les sections sont FIXÉS à la création
      (création via panneaux / menus contextuels). Fusion OOB→pin : pin de salle vs pin d'étage selon le placement. */
  static waypoint(store: Store, host: FormHost, id: string | null, _opts: any = {}): void {
    const scene = new RackScene(store);
    const wp: any = id ? store.get("waypoints", id) : null;
    if (!wp) { Notify.toast(I18n.t("rack.nf.waypoint"), "err"); return; }
    const floorLvl = Waypoint.isFloorLevel(wp), isExit = Waypoint.typeOf(wp) === "exit";
    const isCapPin = wp.kind === "point" && wp.rack_id && wp.cap_face;
    const isSidePin = wp.kind === "point" && wp.rack_id && wp.side_lr != null;
    const isBrush = wp.kind === "brush", isSeg = wp.kind === "segment";
    const kindLbl = isExit ? I18n.t("rack.waypoint.kindExit") : floorLvl ? I18n.t("rack.waypoint.kindFloorPin") : isBrush ? I18n.t("rack.waypoint.kindBrush")
      : isSeg ? I18n.t("rack.waypoint.kindTray") : isCapPin ? I18n.t("rack.waypoint.kindCapPin") : isSidePin ? I18n.t("rack.waypoint.kindSidePin") : I18n.t("rack.waypoint.kindRoomPin");
    const root = document.createElement("div");
    const nameI = FormControls.text(wp.name || "", I18n.t("rack.waypoint.namePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.name"), nameI));
    // récapitulatif VERROUILLÉ (type + emplacement, non modifiables)
    const where = floorLvl ? (store.siteLabel(wp.location) + " · " + Waypoint.floorLabel(wp))
      : wp.rack_id ? I18n.t("rack.waypoint.inRack", { name: (store.get("racks", wp.rack_id) || {}).name || "?" })
      : wp.datacenter_id ? I18n.t("rack.waypoint.inRoom", { name: store.dcName(wp.datacenter_id) }) : I18n.t("rack.waypoint.pool");
    const lock = document.createElement("div"); lock.className = "form-hint";
    const editable = isBrush ? I18n.t("rack.waypoint.editableBrush") : I18n.t("rack.waypoint.editableOther");
    lock.innerHTML = I18n.t("rack.waypoint.lockInfo", { kind: Html.escape(kindLbl), where: Html.escape(where), editable });
    root.appendChild(lock);
    // BROSSE : profondeur (traversée par les câbles) + hauteur (U) modifiables ; l'emplacement U de départ reste fixé.
    // Une PORTE (avant/arrière) borne la profondeur dispo (cage + cavités de porte) ; sans porte, profondeur libre.
    let bdepthI: HTMLInputElement | null = null, bheightI: HTMLInputElement | null = null;
    const brushRack: any = isBrush ? store.get("racks", wp.rack_id) : null;
    const brushHasDoor = !!(brushRack && RackGeometry.hasDoor(brushRack));
    const brushAvail = brushRack ? RackGeometry.frontMountAvailDepth(brushRack) : Infinity;   // dispo physique (depth − marge avant + cavités)
    const brushMaxDepth = brushHasDoor ? Math.max(1, brushAvail - RACK_DEPTH_SAFETY_MM) : Infinity;   // − marge de sécurité (app-wide)
    if (isBrush) {
      bdepthI = FormControls.number(wp.depth_mm != null ? wp.depth_mm : 100, brushHasDoor ? { min: 1, step: 10, max: Math.round(brushMaxDepth) } : { min: 1, step: 10 });
      root.appendChild(FormControls.fieldRow(I18n.t("rack.common.depthMm"), bdepthI, brushHasDoor ? I18n.t("rack.waypoint.depthDoorHint", { max: Math.round(brushMaxDepth), avail: Math.round(brushAvail), safety: RACK_DEPTH_SAFETY_MM }) : I18n.t("rack.waypoint.depthFreeHint")));
      bheightI = FormControls.number(Math.max(1, wp.u_height | 0), { min: 1, step: 1 });
      root.appendChild(FormControls.fieldRow(I18n.t("rack.common.heightU"), bheightI, I18n.t("rack.waypoint.heightHint", { u: Math.max(1, wp.rack_u | 0) })));
    }
    // HAUTEUR (dc_z) — pin flottant / chemin / pin d'étage uniquement (cap/marge/brosse : hauteur dérivée du slot).
    let zI: HTMLInputElement | null = null;
    if (!isCapPin && !isSidePin && !isBrush) {
      zI = FormControls.number(wp.dc_z != null ? wp.dc_z : 0, { step: 50 });
      root.appendChild(FormControls.fieldRow(I18n.t("rack.common.heightMm"), zI, floorLvl ? I18n.t("rack.waypoint.zFloorHint") : I18n.t("rack.waypoint.zHint")));
    }
    // GRILLE de capot (pin de capot) : déplacer dans une autre cellule autorisée du même capot.
    let capChosen: any = isCapPin ? { cx: wp.cap_cx | 0, cy: wp.cap_cy | 0 } : null;
    if (isCapPin) {
      const rk: any = store.get("racks", wp.rack_id);
      if (rk) { root.appendChild(FormUi.divider(I18n.t("rack.waypoint.capSection", { face: wp.cap_face === "floor" ? I18n.t("rack.common.floorLower") : I18n.t("rack.common.roofLower") })));
        root.appendChild(this.capPickGrid(store, rk, wp.cap_face, { exceptId: wp.id, selected: capChosen, onPick: (cx: number, cy: number) => { capChosen = { cx, cy }; } }).el); }
    }
    // GRILLE de marge (pin latéral) : déplacer dans un autre slot de la même marge.
    let pinChosen: any = isSidePin ? { lr: (wp.side_lr === "right" ? "right" : "left"), col: (wp.side_col === 1 ? 1 : 0), u: Math.max(1, wp.side_u | 0) } : null;
    if (isSidePin) {
      const rk: any = store.get("racks", wp.rack_id);
      if (rk) { root.appendChild(FormUi.divider(I18n.t("rack.waypoint.marginSection", { face: this.faceLabel(wp.side_face === "rear" ? "rear" : "front") })));
        root.appendChild(this.sideGrid(store, scene, rk, { face: wp.side_face === "rear" ? "rear" : "front", heightU: SIDE_U_STEP, width: 0, exceptEqId: wp.id, selected: pinChosen, onPick: (lr: string, col: number, u: number) => { pinChosen = { lr, col, u }; } }).el); }
    }
    const descI = FormControls.textArea(wp.description || "");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.description"), descI));
    // Verrou de positionnement : empêche déplacer / retirer le waypoint DEPUIS LES VUES 2D/3D (cf. PlacementLock).
    // Ce formulaire reste l'échappatoire (principe n°10).
    const lockedI = FormControls.toggle(I18n.t("rack.common.lockPos"), !!wp.locked, () => {}, { block: true, icon: Icons.LOCK, title: I18n.t("rack.waypoint.lockTitle") });
    root.appendChild(lockedI);
    host.openModal({
      title: I18n.t("rack.waypoint.title"), subtitle: Html.escape(wp.name || ""), body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim();
        if (!name) { Notify.toast(I18n.t("rack.common.nameRequired"), "err"); return false; }
        const payload: any = { name, description: descI.value.trim(), locked: (lockedI as any).checked };
        if (zI) payload.dc_z = floorLvl ? Math.max(0, parseInt(zI.value, 10) || 0) : (parseInt(zI.value, 10) || 0);
        if (isBrush) {
          const rk: any = store.get("racks", wp.rack_id);
          const uh = Math.max(1, parseInt(bheightI!.value, 10) || 1);
          const sides = (rk && rk.sides === "dual") ? ["front", "rear"] : ["front"];
          if (rk && !RackGeometry.canPlace(rk, Math.max(1, wp.rack_u | 0), uh, sides, scene.occupants(wp.rack_id, { exceptBrushId: wp.id }))) { Notify.toast(I18n.t("rack.waypoint.heightNoFit"), "err"); return false; }
          const depth = Math.max(1, parseInt(bdepthI!.value, 10) || 100);
          if (brushHasDoor && depth > brushMaxDepth) { Notify.toast(I18n.t("rack.waypoint.depthOverDoor", { max: Math.round(brushMaxDepth), avail: Math.round(brushAvail), safety: RACK_DEPTH_SAFETY_MM }), "err"); return false; }
          payload.depth_mm = depth; payload.u_height = uh;
        }
        if (isCapPin && capChosen) {
          if (scene.capSlotOccupied(wp.rack_id, wp.cap_face, capChosen.cx, capChosen.cy, wp.id)) { Notify.toast(I18n.t("rack.waypoint.slotTaken"), "err"); return false; }
          payload.cap_cx = capChosen.cx; payload.cap_cy = capChosen.cy;
        }
        if (isSidePin && pinChosen) {
          const face = wp.side_face === "rear" ? "rear" : "front";
          if (!scene.sideSlotFree(wp.rack_id, face, pinChosen.lr, pinChosen.col, pinChosen.u, SIDE_U_STEP, wp.id)) { Notify.toast(I18n.t("rack.common.slotOccupied"), "err"); return false; }
          payload.side_lr = pinChosen.lr; payload.side_col = pinChosen.col; payload.side_u = pinChosen.u;
        }
        await store.update("waypoints", wp.id, payload);
        host.setDirty?.(true); Notify.toast(I18n.t("rack.waypoint.updated")); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }


  /** Grille de sélection d'un emplacement de MARGE LATÉRALE (réplique `sideGrid`) : table U×colonnes,
      cellules libres cliquables (onPick), occupées teintées. */
  static floor(store: Store, host: FormHost, location: string, floor: string, opts: any = {}): void {
    opts = opts || {};
    const pick = !!opts.pick;
    const fl = String(floor != null ? floor : "");
    const existing: any = store.floorFor(location, fl);
    const f: any = existing || { width_mm: FLOOR_WIDTH_DEFAULT, depth_mm: FLOOR_DEPTH_DEFAULT, cell_mm: FLOOR_CELL_DEFAULT, anchor_x: 0, anchor_y: 0, description: "" };
    const root = document.createElement("div");
    let locSel: HTMLSelectElement | null = null, flSel: HTMLSelectElement | null = null, pickStatus: HTMLElement | null = null;
    // un étage « existe » s'il a un plan, une salle, ou un OOB
    const floorExists = (L: string, F: string) => !!store.floorFor(L, F) || store.dcsOfFloor(L, F).length > 0
      || store.oobWaypoints().some((w: any) => (w.location || "") === (L || "") && String(w.floor || "") === String(F || ""));
    if (pick) {
      locSel = FormControls.select(FormUi.locOptions(store), location || "");
      flSel = FormControls.select([], "");   // peuplé dynamiquement (étages NON existants du bâtiment choisi)
      root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("lists.col.building"), locSel, I18n.t("rack.floor.buildingHint")), FormControls.fieldRow(I18n.t("lists.col.floor"), flSel)));
      pickStatus = document.createElement("div"); pickStatus.className = "form-hint"; root.appendChild(pickStatus);
      const rebuildFloors = () => {
        const L = locSel!.value || "", keep = flSel!.value;
        const avail = FLOORS.filter((fv) => !floorExists(L, fv));
        flSel!.innerHTML = "";
        if (!avail.length) {
          const o = document.createElement("option"); o.value = ""; o.textContent = I18n.t("rack.floor.allExist"); flSel!.appendChild(o);
          pickStatus!.innerHTML = I18n.t("rack.floor.allExistHint");
        } else {
          avail.forEach((fv) => { const o = document.createElement("option"); o.value = fv; o.textContent = I18n.t("lists.ph.floorLabel", { n: fv }); flSel!.appendChild(o); });
          if (avail.includes(keep)) flSel!.value = keep; else if (avail.includes(fl)) flSel!.value = fl;
          pickStatus!.innerHTML = I18n.t("rack.floor.newFloorHint");
        }
      };
      locSel.addEventListener("change", rebuildFloors); rebuildFloors();
    } else {
      const head = document.createElement("div"); head.className = "form-hint";
      head.textContent = I18n.t("rack.floor.planHead", { floor: fl || "0", site: store.siteLabel(location) || "—" });
      root.appendChild(head);
    }
    const wI = FormControls.number(f.width_mm, { min: 1, step: 500 });
    const dI = FormControls.number(f.depth_mm, { min: 1, step: 500 });
    const cI = FormControls.number(f.cell_mm, { min: 1, step: 100 });
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("rack.common.widthMm"), wI), FormControls.fieldRow(I18n.t("rack.common.depthMm"), dI), FormControls.fieldRow(I18n.t("rack.datacenter.meshField"), cI, I18n.t("rack.floor.meshHint"))));
    const axI = FormControls.number(f.anchor_x || 0, { step: 100 });
    const ayI = FormControls.number(f.anchor_y || 0, { step: 100 });
    const hI = FormControls.number(f.height_mm || 0, { min: 0, step: 100 });
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("rack.floor.anchorX"), axI, I18n.t("rack.floor.anchorXHint")), FormControls.fieldRow(I18n.t("rack.floor.anchorY"), ayI), FormControls.fieldRow(I18n.t("rack.common.heightMm"), hI, I18n.t("rack.floor.heightHint"))));
    const descI = FormControls.textArea(f.description || "");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.description"), descI));
    host.openModal({
      title: pick ? I18n.t("rack.floor.titleNew") : (existing ? I18n.t("rack.floor.titleEdit") : I18n.t("rack.floor.titleNewPlan")),
      subtitle: pick ? "" : I18n.t("rack.floor.subtitle", { site: store.siteLabel(location) || "", floor: fl || "0" }),
      body: root, wide: true,
      onSave: async () => {
        const L = pick ? (locSel!.value || "") : (location || ""), F = pick ? String(flSel!.value || "").trim() : fl;
        if (pick && !L) { Notify.toast(I18n.t("rack.floor.chooseBuilding"), "err"); return false; }
        if (pick && !F) { Notify.toast(I18n.t("rack.floor.noFloorToCreate"), "err"); return false; }
        if (pick && floorExists(L, F)) { Notify.toast(I18n.t("rack.floor.floorExists")); opts.onPicked?.(L, F); return true; }
        const ex: any = store.floorFor(L, F);
        const payload = { location: L, floor: F, width_mm: Math.max(1, parseInt(wI.value, 10) || FLOOR_WIDTH_DEFAULT), depth_mm: Math.max(1, parseInt(dI.value, 10) || FLOOR_DEPTH_DEFAULT), cell_mm: Math.max(1, parseInt(cI.value, 10) || FLOOR_CELL_DEFAULT), anchor_x: parseInt(axI.value, 10) || 0, anchor_y: parseInt(ayI.value, 10) || 0, height_mm: Math.max(0, parseInt(hI.value, 10) || 0), description: descI.value.trim() };
        if (ex) await store.update("floors", ex.id, payload); else await store.create("floors", payload);
        host.setDirty?.(true); Notify.toast(pick ? I18n.t("rack.floor.created") : I18n.t("rack.floor.planSaved"));
        if (pick) opts.onPicked?.(L, F);
        return true;
      },
    });
  }

  /** Assigner un emplacement U libre : équipement non placé, pseudo-élément, ou brosse de brassage. */
  static async assignSlot(store: Store, host: FormHost, rackId: string, u: number, side: string, height: number, onDone?: () => void): Promise<void> {
    const rack = store.get("racks", rackId); if (!rack) { Notify.toast(I18n.t("rack.nf.rack"), "err"); return; }
    side = (rack.sides === "dual" && side === "rear") ? "rear" : "front";
    const span = Math.max(1, parseInt(String(height), 10) || 1);
    const scene = new RackScene(store);
    const body = document.createElement("div");
    const posHint = document.createElement("div"); posHint.className = "form-hint";
    posHint.textContent = I18n.t("rack.assign.posPrefix") + "U" + u + (span > 1 ? "–U" + (u + span - 1) + I18n.t("rack.assign.uSpan", { n: span }) : "") + (rack.sides === "dual" ? " · " + this.faceLabel(side) : "") + " — " + (rack.name || I18n.t("rack.common.rackAlt"));
    body.appendChild(posHint);
    // emplacement U → équipements montables en U UNIQUEMENT (les boîtiers à dimensionnement libre `dim_mode:"free"`
    // ne se rackent pas ; ils restent réservés aux montages latéraux/muraux et au placement libre en salle).
    const eqFree = store.unrackedEquipments().filter((e: any) => e.dim_mode !== "free" && (span === 1 || (e.u_height || 1) === span)).sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    const noEqLabel = eqFree.length ? I18n.t("rack.common.choose") : (span > 1 ? I18n.t("rack.assign.noEqSpan", { n: span }) : I18n.t("rack.assign.noFreeEquip"));
    const kindOpts = [{ value: "equipment", label: I18n.t("rack.assign.equipmentOpt") }].concat(RackItemKinds.ALL.map((k) => ({ value: k.id, label: I18n.t(k.labelKey) })));
    if (rack.datacenter_id) kindOpts.push({ value: "brush", label: I18n.t("rack.assign.brushOpt") });
    const kindI = FormControls.select(kindOpts, "equipment");
    body.appendChild(FormControls.fieldRow(I18n.t("rack.assign.element"), kindI));
    const targetDc = rack.datacenter_id || null;
    const blockedWhy = (eid: string) => targetDc ? store.equipmentPlacementBlockedReason(eid, targetDc) : null;
    const eqI = FormControls.select([{ value: "", label: noEqLabel }].concat(eqFree.map((e: any) => {
      const why = blockedWhy(e.id);
      return { value: e.id, label: (e.name || I18n.t("lists.ph.noName")) + " · " + (e.u_height || 1) + "U " + this.mountDepthLabel(e) + (why ? " — ⚠ " + why : ""), disabled: !!why };
    })), "");
    const eqHint = span > 1 ? I18n.t("rack.assign.eqHintSpan", { n: span }) : I18n.t("rack.assign.eqHint");
    const eqRow = FormControls.fieldRow(I18n.t("rack.common.equipField"), eqI, eqHint); body.appendChild(eqRow);
    const labelI = FormControls.text("", I18n.t("rack.assign.labelPlaceholder")); const labelRow = FormControls.fieldRow(I18n.t("rack.common.label"), labelI); body.appendChild(labelRow);
    const pheightI = FormControls.number(String(span), { min: 1, step: 1 });
    const prow = FormControls.fieldRow(I18n.t("rack.common.heightU"), pheightI); body.appendChild(prow);
    // une PORTE borne la profondeur dispo (depth − marge avant + cavités − marge de sécurité) ; sans porte, libre.
    const brushHasDoor = RackGeometry.hasDoor(rack);
    const brushAvail = RackGeometry.frontMountAvailDepth(rack);
    const brushMaxDepth = brushHasDoor ? Math.max(1, brushAvail - RACK_DEPTH_SAFETY_MM) : Infinity;
    const bdepthI = FormControls.number("100", brushHasDoor ? { min: 1, step: 10, max: Math.round(brushMaxDepth) } : { min: 1, step: 10 });
    const bdepthRow = FormControls.fieldRow(I18n.t("rack.assign.brushDepth"), bdepthI, brushHasDoor ? I18n.t("rack.waypoint.depthDoorHint", { max: Math.round(brushMaxDepth), avail: Math.round(brushAvail), safety: RACK_DEPTH_SAFETY_MM }) : I18n.t("rack.waypoint.depthFreeHint")); body.appendChild(bdepthRow);
    // configuration TRAY (étagère) : variante, longueur du plateau (porte-à-faux seulement), hauteur de structure.
    // La « Hauteur (U) » commune (pheightI) devient la hauteur totale RÉSERVÉE (structure + espace utile au-dessus).
    const trayAvail = RackGeometry.mountAvailDepth(rack, side) - (RackGeometry.hasDoor(rack) ? RACK_DEPTH_SAFETY_MM : 0);
    const trayTypeI = FormControls.select(TRAY_TYPES.map((t) => ({ value: t.id, label: I18n.t(t.labelKey) })), "dual");
    const trayTypeRow = FormControls.fieldRow(I18n.t("rack.assign.trayVariant"), trayTypeI, I18n.t("rack.assign.trayVariantHint")); body.appendChild(trayTypeRow);
    const trayLenI = FormControls.number(String(Math.min(TRAY_DEPTH_DEFAULT_MM, Math.max(50, Math.round(trayAvail)))), { min: 50, step: 10, max: Math.max(50, Math.round(trayAvail)) });
    const trayLenRow = FormControls.fieldRow(I18n.t("rack.assign.plankLength"), trayLenI, I18n.t("rack.assign.plankHint", { avail: Math.round(trayAvail), door: RackGeometry.hasDoor(rack) ? I18n.t("rack.assign.doorSafety") : "" })); body.appendChild(trayLenRow);
    const trayUI = FormControls.number("1", { min: 1, step: 1 });
    const trayURow = FormControls.fieldRow(I18n.t("rack.assign.trayHeight"), trayUI, I18n.t("rack.assign.trayHeightHint")); body.appendChild(trayURow);
    const isEq = () => kindI.value === "equipment";
    const isBrush = () => kindI.value === "brush";
    const isTray = () => kindI.value === "tray";
    const selEq = () => store.get("equipments", eqI.value);
    const effMount = () => { const eq = selEq(); return isEq() ? { depth: (eq ? eq.depth : "full"), depth_mm: (eq ? eq.depth_mm : null), side, locks_u: (eq ? RackGeometry.mountLocksU(eq) : false) } : { side, isItem: true }; };
    const effHeight = () => { const eq = selEq(); return isEq() ? (eq ? Math.max(1, eq.u_height || 1) : 1) : Math.max(1, parseInt(pheightI.value, 10) || 1); };
    const brushSides = () => (rack.sides === "dual") ? ["front", "rear"] : ["front"];
    const syncVis = () => {
      const e = isEq(), b = isBrush(), t = isTray();
      eqRow.style.display = e ? "" : "none"; labelRow.style.display = e ? "none" : ""; prow.style.display = e ? "none" : ""; bdepthRow.style.display = b ? "" : "none";
      trayTypeRow.style.display = t ? "" : "none";
      trayLenRow.style.display = (t && trayTypeI.value === "cantilever") ? "" : "none";
      trayURow.style.display = t ? "" : "none";
    };
    kindI.onchange = syncVis; trayTypeI.onchange = syncVis; syncVis();
    const res = await Dialog.custom({
      title: I18n.t("rack.assign.dialogTitle", { u, span: span > 1 ? "–U" + (u + span - 1) : "" }), confirmLabel: I18n.t("rack.assign.assignBtn"),
      build: (r) => { r.appendChild(body); return {
        validate: () => {
          if (isBrush()) {
            if (!rack.datacenter_id) return I18n.t("rack.assign.brushNeedsRoom");
            if (!RackGeometry.canPlace(rack, u, effHeight(), brushSides(), scene.occupants(rack.id))) return I18n.t("rack.assign.noFit");
            if (brushHasDoor && Math.max(1, parseInt(bdepthI.value, 10) || 100) > brushMaxDepth) return I18n.t("rack.assign.depthOverDoor", { max: Math.round(brushMaxDepth), avail: Math.round(brushAvail), safety: RACK_DEPTH_SAFETY_MM });
            return true;
          }
          if (isEq() && !eqI.value) return I18n.t("rack.common.chooseEquip");
          if (isEq()) { const why = blockedWhy(eqI.value); if (why) return I18n.t("rack.assign.placeImpossible", { why }); }
          if (isTray()) {   // étagère : structure ≤ réservation, plateau ≤ profondeur disponible
            const tu = Math.max(1, parseInt(trayUI.value, 10) || 1);
            if (tu > effHeight()) return I18n.t("rack.assign.trayHeightOver", { tu, h: effHeight() });
            if (trayTypeI.value === "cantilever" && Math.max(1, parseInt(trayLenI.value, 10) || 0) > trayAvail) return I18n.t("rack.assign.plankOver", { avail: Math.round(trayAvail) });
          }
          if (!RackGeometry.canPlace(rack, u, effHeight(), RackGeometry.mountSides(effMount(), rack), scene.occupants(rack.id))) return I18n.t("rack.assign.noFit");
          return true;
        },
        collect: () => ({ kind: kindI.value, equipment_id: eqI.value || null, label: labelI.value.trim(), height: effHeight(), depth_mm: Math.max(1, parseInt(bdepthI.value, 10) || 100), tray_type: trayTypeI.value, tray_u: Math.max(1, parseInt(trayUI.value, 10) || 1), tray_len: Math.max(50, parseInt(trayLenI.value, 10) || TRAY_DEPTH_DEFAULT_MM) }),
      }; },
    });
    if (!res) return;
    if (res.kind === "equipment") { await store.update("equipments", res.equipment_id, { placement_mode: "rack", rack_id: rack.id, rack_u: u, rack_side: side }); Notify.toast(I18n.t("rack.assign.equipAssigned")); }
    else if (res.kind === "brush") {
      await store.create("waypoints", { name: res.label || I18n.t("rack.assign.brushName", { n: store.all("waypoints").length + 1 }), wp_type: "datacenter", kind: "brush",
        datacenter_id: rack.datacenter_id, rack_id: rack.id, rack_u: u, u_height: res.height, depth_mm: res.depth_mm, floor: "",
        dc_x: null, dc_y: null, dc_x2: null, dc_y2: null });
      Notify.toast(I18n.t("rack.assign.brushCreated"));
    } else { await store.create("rackItems", { rack_id: rack.id, u, u_height: res.height, side, kind: res.kind, label: res.label, tray_type: res.tray_type, tray_u: res.kind === "tray" ? res.tray_u : 1, depth_mm: (res.kind === "tray" && res.tray_type === "cantilever") ? res.tray_len : null }); Notify.toast(I18n.t("rack.assign.itemMounted")); }
    host.setDirty?.(true); onDone?.();
  }

  /** ÉDITION d'un pseudo-élément de baie (rackItem) : libellé, position/hauteur, et configuration TRAY
      (étagère : variante, longueur du plateau, hauteur de structure). Principe n°10 : tout ce que le
      dialogue d'assignation configure est rééditable ici au formulaire. */
  static rackItem(store: Store, host: FormHost, id: string, onSaved?: () => void): void {
    const it: any = store.get("rackItems", id);
    if (!it) { Notify.toast(I18n.t("rack.nf.item"), "err"); return; }
    const rack: any = it.rack_id ? store.get("racks", it.rack_id) : null;
    const scene = new RackScene(store);
    const isTray = it.kind === "tray";
    const root = document.createElement("div");
    const labelI = FormControls.text(it.label || "", RackItemKinds.label(it.kind));
    root.appendChild(FormControls.fieldRow(I18n.t("rack.common.label"), labelI));
    const uI = FormControls.number(it.u != null ? it.u : 1, { min: 1, step: 1 });
    const hI = FormControls.number(it.u_height || 1, { min: 1, step: 1 });
    const sideI = FormControls.select([{ value: "front", label: I18n.t("domain.rackFace.front") }, { value: "rear", label: I18n.t("domain.rackFace.rear") }], it.side === "rear" ? "rear" : "front");
    const rows = [FormControls.fieldRow(I18n.t("rack.item.uBottom"), uI), FormControls.fieldRow(isTray ? I18n.t("rack.item.reservedHeightU") : I18n.t("rack.common.heightU"), hI, isTray ? I18n.t("rack.item.reservedHint") : undefined)];
    if (rack && rack.sides === "dual") rows.push(FormControls.fieldRow(I18n.t("lists.col.face"), sideI));
    root.appendChild(FormUi.row2(...rows));
    // configuration TRAY (mêmes règles que le dialogue d'assignation)
    let trayTypeI: HTMLSelectElement | null = null, trayLenI: any = null, trayUI: any = null, trayLenRow: HTMLElement | null = null;
    const trayAvail = () => rack ? (RackGeometry.mountAvailDepth(rack, sideI.value) - (RackGeometry.hasDoor(rack) ? RACK_DEPTH_SAFETY_MM : 0)) : Infinity;
    if (isTray) {
      trayTypeI = FormControls.select(TRAY_TYPES.map((t) => ({ value: t.id, label: I18n.t(t.labelKey) })), it.tray_type === "cantilever" ? "cantilever" : "dual");
      root.appendChild(FormControls.fieldRow(I18n.t("rack.assign.trayVariant"), trayTypeI, I18n.t("rack.item.trayVariantHint")));
      trayLenI = FormControls.number(it.depth_mm != null ? it.depth_mm : TRAY_DEPTH_DEFAULT_MM, { min: 50, step: 10 });
      trayLenRow = FormControls.fieldRow(I18n.t("rack.assign.plankLength"), trayLenI, I18n.t("rack.item.plankHint"));
      root.appendChild(trayLenRow);
      trayUI = FormControls.number(it.tray_u || 1, { min: 1, step: 1 });
      root.appendChild(FormControls.fieldRow(I18n.t("rack.assign.trayHeight"), trayUI, I18n.t("rack.item.trayHeightHint")));
      const syncLen = () => { trayLenRow!.style.display = trayTypeI!.value === "cantilever" ? "" : "none"; };
      trayTypeI.addEventListener("change", syncLen); syncLen();
    }
    host.openModal({
      title: I18n.t("rack.item.title", { kind: RackItemKinds.label(it.kind) }), subtitle: it.label ? Html.escape(it.label) : "",
      body: root,
      onSave: async () => {
        const u = Math.max(1, parseInt(uI.value, 10) || 1), uh = Math.max(1, parseInt(hI.value, 10) || 1);
        const side = sideI.value === "rear" ? "rear" : "front";
        if (rack && !RackGeometry.canPlace(rack, u, uh, RackGeometry.mountSides({ side, isItem: true }, rack), scene.occupants(rack.id, { exceptItemId: it.id }))) { Notify.toast(I18n.t("rack.item.noFit"), "err"); return false; }
        const payload: any = { label: labelI.value.trim(), u, u_height: uh, side };
        if (isTray && trayTypeI && trayUI) {
          const tu = Math.max(1, parseInt(trayUI.value, 10) || 1);
          if (tu > uh) { Notify.toast(I18n.t("rack.item.trayHeightOver", { tu, h: uh }), "err"); return false; }
          payload.tray_type = trayTypeI.value; payload.tray_u = tu;
          if (trayTypeI.value === "cantilever") {
            const L = Math.max(50, parseInt(trayLenI.value, 10) || TRAY_DEPTH_DEFAULT_MM);
            if (L > trayAvail()) { Notify.toast(I18n.t("rack.item.plankOver", { avail: Math.round(trayAvail()) }), "err"); return false; }
            payload.depth_mm = L;
          } else payload.depth_mm = null;   // « dual » : pleine cage, longueur dérivée
          // BLOCAGE : le redimensionnement ne doit pas invalider les équipements DÉJÀ posés (ils ne sont
          // jamais déplacés/supprimés silencieusement). Sinon on PROPOSE de vider l'étagère (tout détacher).
          const guests = store.equipmentsOnTray(it.id);
          if (rack && guests.length) {
            const cand = Object.assign({}, it.toJSON(), payload);
            let badWhy: string | null = null;
            const bad = guests.find((g: any) => { badWhy = RackGeometry.trayEquipFitsWhy(rack, cand, g, guests.filter((o: any) => o.id !== g.id)); return !!badWhy; });
            if (bad) {
              const ok = await Dialog.confirm({
                title: I18n.t("rack.item.blockedTitle"),
                message: I18n.t("rack.item.blockedMsg", { name: bad.name || I18n.t("rack.common.equipWord"), why: badWhy, count: guests.length }),
                confirmLabel: I18n.t("rack.item.emptyAndApply"), danger: true,
              });
              if (!ok) return false;
              for (const g of guests) await store.update("equipments", g.id, { placement_mode: "manual", tray_item_id: null, tray_x: null, tray_y: null });
              Notify.toast(I18n.t("rack.item.detached", { count: guests.length }));
            }
          }
        }
        await store.update("rackItems", it.id, payload);
        host.setDirty?.(true); Notify.toast(I18n.t("rack.item.updated")); onSaved?.(); return true;
      },
    });
    setTimeout(() => labelI.focus(), 30);
  }

  /** POSER un équipement LIBRE sur une étagère (tray) : liste des équipements libres non placés,
      orientation, AUTO-POSITION (balayage grille — cf. RackGeometry.trayFindSpot) et contrôle
      d'espace (empreinte/hauteur/chevauchement — la validation partagée re-vérifie à l'écriture). */
  static async assignTraySlot(store: Store, host: FormHost, trayItemId: string, onDone?: () => void): Promise<void> {
    const tray: any = store.get("rackItems", trayItemId);
    if (!tray || tray.kind !== "tray") { Notify.toast(I18n.t("rack.tray.notFound"), "err"); return; }
    const rack: any = tray.rack_id ? store.get("racks", tray.rack_id) : null;
    if (!rack) { Notify.toast(I18n.t("rack.tray.noRack"), "err"); return; }
    const box = RackGeometry.trayBoxLocal(rack, tray);
    const plankW = Math.round(box.x1 - box.x0), plankL = Math.round(Math.abs(box.y1 - box.y0)), availH = Math.round(box.z1 - box.z0);
    if (availH < 1) { Notify.toast(I18n.t("rack.tray.noSpace"), "err"); return; }
    const eqFree = store.unrackedEquipments().filter((e: any) => e.dim_mode === "free").sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    if (!eqFree.length) { Notify.toast(I18n.t("rack.tray.noFreeEquip"), "err"); return; }
    const body = document.createElement("div");
    const posHint = document.createElement("div"); posHint.className = "form-hint";
    posHint.textContent = I18n.t("rack.tray.posHint", { w: plankW, l: plankL, h: availH, rack: rack.name || I18n.t("rack.common.rackWord"), u: tray.u });
    body.appendChild(posHint);
    const eqI = FormControls.select(eqFree.map((e: any) => ({ value: e.id, label: (e.name || I18n.t("lists.ph.noName")) + " · " + (e.free_w_mm || "?") + " × " + (e.free_l_mm || "?") + " × " + (e.free_h_mm || "?") + " mm" })), eqFree[0].id);
    body.appendChild(FormControls.fieldRow(I18n.t("rack.common.equipField"), eqI, I18n.t("rack.tray.eqHint")));
    const orientI = FormControls.select(ORIENT_OPTS, "0");
    body.appendChild(FormControls.fieldRow(I18n.t("rack.common.orientation"), orientI, I18n.t("rack.tray.orientHint")));
    const others = store.equipmentsOnTray(trayItemId);
    const candidate = () => { const e: any = store.get("equipments", eqI.value); return e ? Object.assign({}, e.toJSON(), { dc_orientation: parseInt(orientI.value, 10) || 0 }) : null; };
    const res = await Dialog.custom({
      title: I18n.t("rack.tray.dialogTitle", { suffix: tray.label ? " — " + tray.label : "" }), confirmLabel: I18n.t("rack.tray.place"),
      build: (r) => { r.appendChild(body); return {
        validate: () => {
          const cand = candidate(); if (!cand) return I18n.t("rack.common.chooseEquip");
          const why = RackGeometry.trayEquipFitsWhy(rack, tray, Object.assign({}, cand, { tray_x: 0, tray_y: 0 }), []);
          if (why) return I18n.t("rack.tray.impossible", { why });
          // le REFLOW peut faire de la place là où le seul findSpot échouerait → accepté si l'un OU l'autre tient.
          const all = others.map((o: any) => o.toJSON()).concat([cand]);
          if (!RackGeometry.trayArrange(rack, tray, all) && !RackGeometry.trayFindSpot(rack, tray, cand, others)) return I18n.t("rack.tray.noRoomOrient");
          return true;
        },
        collect: () => ({ eqId: eqI.value, orient: parseInt(orientI.value, 10) || 0 }),
      }; },
    });
    if (!res) return;
    const eq: any = store.get("equipments", res.eqId); if (!eq) return;
    const orient = Normalize.rackOrientation(res.orient);
    const place = { placement_mode: "tray", tray_item_id: trayItemId, dc_orientation: orient, dc_id: null, dc_x: null, dc_y: null, rack_id: null, rack_u: null, floor_x: null, floor_y: null };
    // REFLOW AUTOMATIQUE à chaque ajout : on réarrange TOUS les équipements de l'étagère (existants + nouveau)
    // côte à côte, à espaces égaux (RackGeometry.trayArrange). Ordre = de gauche à droite (tray_x courant), le
    // nouveau ajouté à la fin. Tout est écrit en UN lot (updateBatch, validation consciente du lot → pas de faux
    // chevauchement pendant le repositionnement). Repli : si ça ne tient pas sur une rangée, on place le seul
    // nouvel item via trayFindSpot (sans déplacer les autres).
    const ordered = others.slice().sort((a: any, bb: any) => (a.tray_x || 0) - (bb.tray_x || 0));
    const arrangeEqs = ordered.map((o: any) => o.toJSON()).concat([Object.assign({}, eq.toJSON(), { dc_orientation: orient })]);
    const layout = RackGeometry.trayArrange(rack, tray, arrangeEqs);
    let ok = 0;
    if (layout) {
      const ops = ordered.map((o: any, i: number) => ({ collection: "equipments", id: o.id, patch: { tray_x: Math.round(layout[i].x), tray_y: Math.round(layout[i].y) } }));
      const mine = layout[layout.length - 1];
      ops.push({ collection: "equipments", id: res.eqId, patch: Object.assign({ tray_x: Math.round(mine.x), tray_y: Math.round(mine.y) }, place) });
      ok = await store.updateBatch(ops);
    } else {
      const spot = RackGeometry.trayFindSpot(rack, tray, Object.assign({}, eq.toJSON(), { dc_orientation: orient }), others);
      if (!spot) { Notify.toast(I18n.t("rack.tray.noRoom"), "err"); return; }
      ok = (await store.update("equipments", res.eqId, Object.assign({ tray_x: Math.round(spot.x), tray_y: Math.round(spot.y) }, place))) ? 1 : 0;
    }
    if (!ok) { Notify.toast(I18n.t("rack.tray.placeRefused"), "err"); return; }
    await store.applyCableBreaks(res.eqId);   // le (dé)placement peut invalider des routes — même garde que les autres montages
    host.setDirty?.(true); Notify.toast(I18n.t("rack.tray.placed")); onDone?.();
  }

  /** Monter dans un emplacement LATÉRAL libre : équipement non placé OU pin (point de passage). */
  static async assignSideSlot(store: Store, host: FormHost, rackId: string, face: string, lr: string, col: number, uTop: number, onDone?: () => void): Promise<void> {
    const rack = store.get("racks", rackId); if (!rack) { Notify.toast(I18n.t("rack.nf.rack"), "err"); return; }
    if (!RackGeometry.sideEnabled(rack, face)) { Notify.toast(I18n.t("rack.side.notAllowed"), "err"); return; }
    const scene = new RackScene(store);
    const colW = RackGeometry.sideColWidthMm(rack);
    const effFreeH = (e: any) => (e.free_h_mm != null) ? e.free_h_mm : (e.u_height ? e.u_height * U_MM : SIDE_U_STEP * U_MM);
    const effHeightU = (e: any) => Math.max(1, Math.ceil(effFreeH(e) / U_MM));
    const body = document.createElement("div");
    const posHint = document.createElement("div"); posHint.className = "form-hint";
    posHint.textContent = I18n.t("rack.side.posHint", { margin: lr === "left" ? I18n.t("rack.common.leftLower") : I18n.t("rack.common.rightLower"), col: RackGeometry.sideColumns(rack) > 1 ? I18n.t("rack.side.colFrag", { n: col + 1 }) : "", u: uTop, face: rack.sides === "dual" ? " · " + this.faceLabel(face) : "", colw: Math.round(colW) });
    body.appendChild(posHint);
    const targetDc = rack.datacenter_id || null;
    const blockedWhy = (eid: string) => targetDc ? store.equipmentPlacementBlockedReason(eid, targetDc) : null;
    const eqFree = store.unrackedEquipments().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    const tooWide = (e: any) => (e.free_w_mm != null) && e.free_w_mm > colW + 0.5;
    const kindI = FormControls.select([{ value: "equipment", label: I18n.t("rack.common.equipField") }, { value: "pin", label: I18n.t("rack.side.pinOpt") }], "equipment");
    body.appendChild(FormControls.fieldRow(I18n.t("rack.assign.element"), kindI));
    const eqI = FormControls.select([{ value: "", label: eqFree.length ? I18n.t("rack.common.choose") : I18n.t("rack.assign.noFreeEquip") }].concat(eqFree.map((e: any) => {
      const why = blockedWhy(e.id), wide = tooWide(e);
      return { value: e.id, label: (e.name || I18n.t("lists.ph.noName")) + (e.free_w_mm != null ? I18n.t("rack.side.mmWide", { w: e.free_w_mm }) : "") + (wide ? I18n.t("rack.side.tooWide") : "") + (why ? " — ⚠ " + why : ""), disabled: !!why || wide };
    })), "");
    const eqRow = FormControls.fieldRow(I18n.t("rack.common.equipField"), eqI, I18n.t("rack.side.eqHint")); body.appendChild(eqRow);
    let snap = "post";
    const snapT = FormControls.toggle(I18n.t("rack.side.snapToggle"), false, (v) => { snap = v ? "wall" : "post"; }, { block: true });
    body.appendChild(snapT);
    const pinNameI = FormControls.text(I18n.t("rack.side.pinName", { n: store.all("waypoints").length + 1 }), I18n.t("rack.side.pinPlaceholder"));
    const pinRow = FormControls.fieldRow(I18n.t("rack.side.pinNameField"), pinNameI, I18n.t("rack.side.pinHint")); body.appendChild(pinRow);
    const isPin = () => kindI.value === "pin";
    const syncKind = () => { const pin = isPin(); eqRow.style.display = pin ? "none" : ""; snapT.style.display = pin ? "none" : ""; pinRow.style.display = pin ? "" : "none"; };
    kindI.onchange = syncKind; syncKind();
    const res = await Dialog.custom({
      title: I18n.t("rack.side.dialogTitle", { u: uTop }), confirmLabel: I18n.t("rack.side.mount"),
      build: (r) => { r.appendChild(body); return {
        validate: () => {
          if (isPin()) return scene.sideSlotFree(rack.id, face, lr, col, uTop, SIDE_U_STEP, null) ? true : I18n.t("rack.common.slotOccupiedDot");
          if (!eqI.value) return I18n.t("rack.common.chooseEquip");
          const why = blockedWhy(eqI.value); if (why) return I18n.t("rack.assign.placeImpossible", { why });
          const e = store.get("equipments", eqI.value); if (!e) return I18n.t("rack.common.equipNotFound");
          if (uTop + effHeightU(e) - 1 > (rack.u_count || 42)) return I18n.t("rack.side.overTop");
          if (!scene.sideSlotFree(rack.id, face, lr, col, uTop, effHeightU(e), e.id)) return I18n.t("rack.side.slotOrAboveOccupied");
          return true;
        },
        collect: () => isPin() ? { kind: "pin", name: pinNameI.value.trim() } : { kind: "equipment", eid: eqI.value },
      }; },
    });
    if (!res) return;
    if (res.kind === "pin") {
      await store.create("waypoints", { name: res.name || "PIN", kind: "point", wp_type: "datacenter", datacenter_id: rack.datacenter_id, rack_id: rack.id, side_face: face, side_lr: lr, side_col: col, side_u: uTop });
      Notify.toast(I18n.t("rack.side.pinPlaced")); host.setDirty?.(true); onDone?.(); return;
    }
    const e = store.get("equipments", res.eid); if (!e) return;
    const free_w_mm = (e.free_w_mm != null) ? Math.min(e.free_w_mm, Math.round(colW)) : Math.round(Math.min(colW, 50));
    const free_h_mm = (e.free_h_mm != null) ? e.free_h_mm : (e.u_height ? e.u_height * U_MM : SIDE_U_STEP * U_MM);
    const free_l_mm = (e.free_l_mm != null) ? e.free_l_mm : Math.min(RackGeometry.cageDepth(rack), 300);
    await store.update("equipments", res.eid, { placement_mode: "side", dim_mode: "free", rack_id: rack.id, rack_u: null, rack_side: "front", side_face: face, side_lr: lr, side_col: col, side_u: uTop, side_snap: snap, free_w_mm, free_h_mm, free_l_mm });
    Notify.toast(I18n.t("rack.side.equipMounted")); host.setDirty?.(true); await store.applyCableBreaks(res.eid); onDone?.();
  }

  /** Monter un équipement dans un emplacement MURAL libre (paroi, face vers le centre ou la façade). */
  static async assignWallSlot(store: Store, host: FormHost, rackId: string, wall: string, margin: string, col: number, uTop: number, onDone?: () => void): Promise<void> {
    const rack = store.get("racks", rackId); if (!rack) { Notify.toast(I18n.t("rack.nf.rack"), "err"); return; }
    if (!RackGeometry.wallEnabled(rack, margin)) { Notify.toast(I18n.t("rack.wall.notAvailable"), "err"); return; }
    const scene = new RackScene(store);
    const g = RackGeometry.wallGeo(rack, margin);
    const effHeightU = (e: any) => Math.max(1, Math.ceil(((e.free_h_mm != null) ? e.free_h_mm : (e.u_height ? e.u_height * U_MM : SIDE_U_STEP * U_MM)) / U_MM));
    const body = document.createElement("div");
    const posHint = document.createElement("div"); posHint.className = "form-hint";
    posHint.textContent = I18n.t("rack.wall.posHint", { wall: wall === "left" ? I18n.t("rack.common.leftLower") : I18n.t("rack.common.rightLower"), margin: margin === "rear" ? I18n.t("rack.common.rearLower") : I18n.t("rack.common.frontLower"), col: g.cols > 1 ? I18n.t("rack.side.colFrag", { n: col + 1 }) : "", u: uTop, dep: Math.round(g.dep) });
    body.appendChild(posHint);
    const targetDc = rack.datacenter_id || null;
    const blockedWhy = (eid: string) => targetDc ? store.equipmentPlacementBlockedReason(eid, targetDc) : null;
    const eqFree = store.unrackedEquipments().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    const eqI = FormControls.select([{ value: "", label: eqFree.length ? I18n.t("rack.common.choose") : I18n.t("rack.assign.noFreeEquip") }].concat(eqFree.map((e: any) => {
      const why = blockedWhy(e.id);
      return { value: e.id, label: (e.name || I18n.t("lists.ph.noName")) + (why ? " — ⚠ " + why : ""), disabled: !!why };
    })), "");
    body.appendChild(FormControls.fieldRow(I18n.t("rack.common.equipField"), eqI, I18n.t("rack.wall.eqHint")));
    const orientI = FormControls.select([{ value: "center", label: I18n.t("rack.wall.orientCenter") }, { value: "facade", label: I18n.t("rack.wall.orientFacade") }], "center");
    body.appendChild(FormControls.fieldRow(I18n.t("rack.wall.orientField"), orientI));
    const res = await Dialog.custom({
      title: I18n.t("rack.wall.dialogTitle", { u: uTop }), confirmLabel: I18n.t("rack.side.mount"),
      build: (r) => { r.appendChild(body); return {
        validate: () => {
          if (!eqI.value) return I18n.t("rack.common.chooseEquip");
          const why = blockedWhy(eqI.value); if (why) return I18n.t("rack.assign.placeImpossible", { why });
          const e = store.get("equipments", eqI.value); if (!e) return I18n.t("rack.common.equipNotFound");
          if (uTop + effHeightU(e) - 1 > (rack.u_count || 42)) return I18n.t("rack.side.overTop");
          if (!scene.wallSlotFree(rack.id, wall, margin, col, uTop, effHeightU(e), e.id)) return I18n.t("rack.side.slotOrAboveOccupied");
          return true;
        },
        collect: () => ({ eid: eqI.value, orient: orientI.value === "facade" ? "facade" : "center" }),
      }; },
    });
    if (!res) return;
    const e = store.get("equipments", res.eid); if (!e) return;
    const free_w_mm = (e.free_w_mm != null) ? e.free_w_mm : Math.round(Math.min(g.colW, 80));
    const free_h_mm = (e.free_h_mm != null) ? e.free_h_mm : (e.u_height ? e.u_height * U_MM : SIDE_U_STEP * U_MM);
    const free_l_mm = (e.free_l_mm != null) ? e.free_l_mm : Math.min(Math.round(g.dep), 150);
    await store.update("equipments", res.eid, { placement_mode: "wall", dim_mode: "free", rack_id: rack.id, rack_u: null, rack_side: "front",
      wall_lr: wall, wall_margin: margin, wall_col: col, wall_u: uTop, wall_orient: res.orient, free_w_mm, free_h_mm, free_l_mm });
    Notify.toast(I18n.t("rack.wall.equipMounted")); host.setDirty?.(true); await store.applyCableBreaks(res.eid); onDone?.();
  }

  /** Poser un Waypoint Pin dans un trou de capot libre (toit/sol), verrouillé au centre de la cellule. */
  static async assignCapSlot(store: Store, host: FormHost, rackId: string, face: string, cx: number, cy: number, onDone?: () => void): Promise<void> {
    const rack = store.get("racks", rackId); if (!rack) { Notify.toast(I18n.t("rack.nf.rack"), "err"); return; }
    if (!rack.datacenter_id) { Notify.toast(I18n.t("rack.cap.needRoom"), "err"); return; }
    const scene = new RackScene(store);
    if (scene.capSlotOccupied(rackId, face, cx, cy, null)) { Notify.toast(I18n.t("rack.common.slotOccupiedDot"), "err"); return; }
    const faceLbl = (face === "floor") ? I18n.t("rack.common.floorLower") : I18n.t("rack.common.roofLower");
    const body = document.createElement("div");
    const posHint = document.createElement("div"); posHint.className = "form-hint";
    posHint.textContent = I18n.t("rack.cap.posHint", { face: faceLbl, cx, cy });
    body.appendChild(posHint);
    const pinNameI = FormControls.text(I18n.t("rack.side.pinName", { n: store.all("waypoints").length + 1 }), I18n.t("rack.cap.pinPlaceholder", { face: faceLbl }));
    body.appendChild(FormControls.fieldRow(I18n.t("rack.side.pinNameField"), pinNameI, I18n.t("rack.cap.pinHint")));
    const res = await Dialog.custom({
      title: I18n.t("rack.cap.dialogTitle", { face: faceLbl }), confirmLabel: I18n.t("rack.tray.place"),
      build: (r) => { r.appendChild(body); return {
        validate: () => scene.capSlotOccupied(rack.id, face, cx, cy, null) ? I18n.t("rack.common.slotOccupiedDot") : true,
        collect: () => ({ name: pinNameI.value.trim() }),
      }; },
    });
    if (!res) return;
    await store.create("waypoints", { name: res.name || "PIN", kind: "point", wp_type: "datacenter", datacenter_id: rack.datacenter_id, rack_id: rack.id, cap_face: face, cap_cx: cx, cap_cy: cy });
    Notify.toast(I18n.t("rack.cap.pinPlaced")); host.setDirty?.(true); onDone?.();
  }
}
