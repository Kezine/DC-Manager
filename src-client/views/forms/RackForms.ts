import type { Store } from "../../store";
import { Icons } from "../../ui/Icons";
import { FormControls } from "../../ui/FormControls";
import type { SelectOption } from "../../ui/FormControls";   // type des options des sélecteurs (helper `freeEquipOptions`)
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { Html } from "../../core/Html";
import { Markdown } from "../../core/Markdown";   // rendu MARKDOWN des champs texte libre des FICHES (défauts sûrs, cf. core/Markdown)
import { Format } from "../../core/Format";
import { AuditLine } from "./AuditLine";   // ligne « Créé/Modifié par {auteur} le {date} » (annuaire, mode API)
import { LiveValidation } from "./LiveValidation";
import { Waypoint } from "../../models/Waypoint";
import { EquipmentTypes } from "../../registries/EquipmentTypes";
import { RackGeometry } from "../../geometry/RackGeometry";
import { RackScene } from "../../geometry/RackScene";
import { RackResize } from "../../geometry/RackResize";
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
import { FormSave } from "./FormSave";   // écriture + garde-fou « ne jamais annoncer un succès refusé »
import { TargetSearch } from "../../core/TargetSearch";   // convention composite « <kind>:<id> » du picker d'hôte des applications
import { FilePicker } from "../../ui/FilePicker";   // sélecteur de fichier RÉUTILISABLE (principe n°14) — création d'une pièce jointe
import type { FilePickerElement } from "../../ui/FilePicker";
import { Schema } from "../../../src-shared/Schema";   // liste blanche MIME PARTAGÉE des pièces jointes (le serveur applique la même)
import { Id } from "../../core/Id";   // id opaque client (mode API : passé au POST multipart — anti path-traversal, cf. AttachmentFiles.isSafeId)
import { ATTACHMENT_MAX_BYTES } from "../../domain/constants";   // plafond de taille (miroir du plafond multer serveur)
import type { FormHost } from "./shared";
import { CableForms } from "./CableForms";
import { EquipmentForms } from "./EquipmentForms";   // fiche équipement (nom cliquable dans le contenu de baie)
import { EntityViz } from "../EntityViz";
import { LabelPrintDialog } from "../../ui/LabelPrintDialog";   // impression d'étiquettes QR (lot E — mode API seulement, prédicat `available`)
import { LabelSubjects } from "../../core/LabelSubjects";       // matière d'une étiquette depuis un enregistrement

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
        // REDIMENSIONNEMENT du nombre de U : on n'évacue QUE les occupants qui ne tiennent plus dans la
        // nouvelle cage (AGRANDIR ne déplace donc plus rien, et ce qui tient reste en place). La règle est
        // partagée avec le rendu via `RackResize` — cf. son en-tête pour l'asymétrie de traitement :
        //   • équipement dépassant  → « Non placé » (il existe hors baie, ses listings y donnent accès) ;
        //   • PSEUDO-occupant dépassant → SUPPRIMÉ. Il n'a aucune existence hors baie NI aucun listing (seuls
        //     points d'accès : vue 3D / édition 2D de baie) ; le laisser sans U en ferait un fantôme
        //     inatteignable. La cascade `rackItems` détache au passage les équipements posés sur une étagère
        //     supprimée, qui redeviennent « Non placé » (donc de nouveau accessibles).
        // Les pseudo-occupants étaient auparavant IGNORÉS ici : ils restaient au-delà du dernier U et se
        // dessinaient hors baie — et une baie n'en contenant QUE (sans aucun équipement) échappait même à la
        // confirmation, l'ancien garde-fou testant le seul nombre d'équipements.
        if (rk && g.u !== rk.u_count) {
          const fo = RackResize.fallout(new RackScene(store).uSpans(rk.id), g.u);
          if (fo.equipmentIds.length || fo.itemIds.length) {
            const ok = await Dialog.confirm({
              title: I18n.t("rack.rack.resizeTitle"),
              message: I18n.t("rack.rack.resizeMsg", { eq: fo.equipmentIds.length, items: fo.itemIds.length, u: g.u }),
              confirmLabel: I18n.t("rack.rack.resizeConfirm"), danger: true,
            });
            if (!ok) return false;
            await store.updateBatch([{ collection: "racks", id: rk.id, patch: payload }].concat(
              fo.equipmentIds.map((id: string) => ({ collection: "equipments", id, patch: { placement_mode: "manual", rack_id: null, rack_u: null } }))));
            // Suppressions APRÈS le lot d'écriture : chacune porte sa propre cascade (détachement des invités
            // d'étagère), ce que `updateBatch` ne sait pas exprimer → `remove` un par un.
            for (const id of fo.itemIds) await store.remove("rackItems", id);
            host.setDirty?.(true); Notify.toast(I18n.t("rack.rack.resized")); onSaved?.(); return true;
          }
        }
        if (!await FormSave.record(store, "racks", rk && rk.id, payload)) return false;   // REFUSÉ par le Store (toast rouge nommant la règle) : ne rien annoncer, garder la saisie
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
    // Description LIBRE (multiligne) : rendue en MARKDOWN dans un conteneur dédié `.md-body` (défauts micromark sûrs, cf. core/Markdown).
    add(I18n.t("lists.col.description"), rk.description ? `<div class="md-body">${Markdown.render(rk.description)}</div>` : "—");
    add(I18n.t("rack.common.created"), Html.escape(Format.dateTime(rk.created_date)));
    add(I18n.t("rack.common.updated"), Html.escape(Format.dateTime(rk.updated_date)));
    root.appendChild(grid);

    // équipements montés dans la baie (triés par U)
    const eqs = store.equipmentsOfRack(rk.id).slice().sort((a: any, b: any) => (a.rack_u || 0) - (b.rack_u || 0));
    const dE = document.createElement("div"); dE.className = "section-divider"; dE.textContent = I18n.t("rack.rackDetail.equipsSection", { count: eqs.length }); root.appendChild(dE);
    if (eqs.length) {
      const tw = document.createElement("div"); tw.className = "table-wrap";
      // Bouton « Localiser » par ligne, sous le prédicat PARTAGÉ `store.equipmentLocatable` (`core/Locatable`).
      // ⚠ Aucun posé d'ÉTAGE ne peut figurer dans ce tableau (il liste le contenu d'une BAIE) : la migration
      // n'y change donc STRICTEMENT RIEN. Elle est faite pour que la règle reste écrite au même endroit —
      // c'est la divergence entre copies d'un même prédicat qui a produit le défaut que ce lot corrige.
      const rows = eqs.map((e: any) => {
        const uPos = (e.placement_mode === "rack" && e.rack_u != null)
          ? ("U" + e.rack_u + ((e.u_height || 1) > 1 ? "–U" + (e.rack_u + (e.u_height || 1) - 1) : ""))
          : (e.placement_mode === "side" ? I18n.t("rack.rackDetail.uSide") : e.placement_mode === "wall" ? I18n.t("rack.rackDetail.uWall") : "—");
        return `<tr><td class="cell-name">${Html.escape(e.name || I18n.t("lists.ph.equipment"))}</td><td><span class="pill">${Html.escape(EquipmentTypes.label(e.type))}</span></td><td style="font-family:var(--mono)">${Html.escape(uPos)}</td><td class="cell-actions">${host.locate && store.equipmentLocatable(e) ? `<button class="btn btn-ghost btn-sm icon-action" data-eq-loc="${e.id}" title="${I18n.t("lists.chrome.rowLocate")}" aria-label="${I18n.t("lists.chrome.rowLocate")}">${Icons.LOCATE}</button>` : ""}<button class="btn btn-ghost btn-sm icon-action" data-eq-view="${e.id}" title="${I18n.t("lists.chrome.rowView")}" aria-label="${I18n.t("lists.chrome.rowView")}">${Icons.INFO}</button></td></tr>`;
      }).join("");
      tw.innerHTML = `<table><thead><tr><th>${I18n.t("lists.col.equipment")}</th><th>${I18n.t("lists.col.type")}</th><th>${I18n.t("rack.rackDetail.colU")}</th><th style="text-align:right;">${I18n.t("lists.chrome.actions")}</th></tr></thead><tbody>${rows}</tbody></table>`;
      root.appendChild(tw);
      tw.querySelectorAll("[data-eq-view]").forEach((b) => { (b as HTMLElement).onclick = () => this.equipmentDetail(store, host, (b as HTMLElement).dataset.eqView!, onChanged); });
      tw.querySelectorAll("[data-eq-loc]").forEach((b) => { (b as HTMLElement).onclick = () => host.locate?.("equipment", (b as HTMLElement).dataset.eqLoc!, () => this.rackDetail(store, host, rk.id, onChanged)); });
    } else { const e = document.createElement("div"); e.className = "form-hint"; e.textContent = I18n.t("rack.rackDetail.empty"); root.appendChild(e); }

    AuditLine.attach(root, rk, host.userDirectory);   // « Créé/Modifié par » (mode API)

    // actions : Localiser en 3D + Gérer le contenu + Modifier — dans le PIED FIXE (footerActions), plus au
    // bas du corps défilant. « Localiser » seulement si la baie est POSÉE dans une salle (même prédicat que
    // locateRack) — sinon toast d'erreur.
    const footerActions: HTMLElement[] = [];
    if (host.locate && rk.datacenter_id) { const locBtn = document.createElement("button"); locBtn.type = "button"; locBtn.className = "btn btn-ghost"; locBtn.innerHTML = `<span class="gi">${Icons.LOCATE}</span>${I18n.t("lists.chrome.rowLocate")}`; locBtn.onclick = () => host.locate!("rack", rk.id, () => this.rackDetail(store, host, rk.id, onChanged)); footerActions.push(locBtn); }
    // ÉTIQUETTES (lot E étiquettes QR — mode API seulement, prédicat injecté LabelPrintDialog.available) :
    // DEUX gestes distincts, comme la maquette — l'étiquette DE la baie (gabarit « Baie » en tête de baie)
    // et la planche DU CONTENU (une étiquette par équipement monté, dans l'ordre des U DÉCROISSANTS :
    // l'ordre dans lequel on les colle en descendant la baie). La planche n'apparaît que s'il y a du contenu.
    if (LabelPrintDialog.available()) {
      const rackLblBtn = document.createElement("button"); rackLblBtn.type = "button"; rackLblBtn.className = "btn btn-ghost";
      rackLblBtn.innerHTML = `<span class="gi">${Icons.PRINT}</span>${I18n.t("labels.entry.rack")}`;
      rackLblBtn.onclick = () => LabelPrintDialog.open({ kind: "rack", subjects: [LabelSubjects.rack(store, rk)], source: rk.name || "" });
      footerActions.push(rackLblBtn);
      if (eqs.length) {
        const sheetBtn = document.createElement("button"); sheetBtn.type = "button"; sheetBtn.className = "btn btn-ghost";
        sheetBtn.innerHTML = `<span class="gi">${Icons.PRINT}</span>${I18n.t("labels.entry.rackSheet", { n: eqs.length })}`;
        sheetBtn.onclick = () => LabelPrintDialog.open({
          kind: "equipment",
          subjects: eqs.slice().sort((a: any, b: any) => (b.rack_u || 0) - (a.rack_u || 0)).map((e: any) => LabelSubjects.equipment(store, e)),
          source: I18n.t("labels.entry.rackSheetSource", { rack: rk.name || "" }),
        });
        footerActions.push(sheetBtn);
      }
    }
    if (this.canEditCollection("racks")) {   // viewer / droit de mise à jour absent : pas d'édition (contenu ni fiche)
      const contentBtn = document.createElement("button"); contentBtn.type = "button"; contentBtn.className = "btn btn-ghost"; contentBtn.textContent = I18n.t("rack.rackDetail.contentBtn");
      contentBtn.title = I18n.t("rack.rackDetail.contentTitle");
      contentBtn.onclick = () => this.rackContent(store, host, rk.id, onChanged);
      footerActions.push(contentBtn);
      const editBtn = document.createElement("button"); editBtn.type = "button"; editBtn.className = "btn btn-primary"; editBtn.textContent = I18n.t("lists.chrome.rowEdit");
      editBtn.onclick = () => this.rack(store, host, rk.id, onChanged);
      footerActions.push(editBtn);
    }

    // `onResume` : la fiche se RECONSTRUIT quand elle revient au premier plan (formulaire d'édition, modale
    // « contenu » ou fiche d'équipement dépilés) — elle lit l'objet `rk` capturé à l'ouverture, donc figé.
    host.openModal({
      title: I18n.t("rack.rackDetail.title"), subtitle: Html.escape(rk.name || ""), body: root, footerActions, hideFooter: true, wide: true,
      stackKey: "detail:racks/" + rk.id,
      onResume: () => this.rackDetail(store, host, rk.id, onChanged),
    });
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
        const downs = store.equipmentContainer(mid) ? store.cableDowngradeOps([mid]) : [];   // clé généralisée (cf. DcInteract, même garde)
        if (!await FormSave.batch(store, [{ collection: "equipments", id: mid, patch: { placement_mode: "manual", rack_id: null, rack_u: null } }].concat(downs as any))) return;   // refusé par le Store (toast rouge) : ne rien annoncer
        Notify.toast(I18n.t("rack.rackContent.equipRemoved") + (downs.length ? I18n.t("rack.rackContent.cablesReplanned") : ""));
      } else if (kind === "brush") {
        if (!store.get("waypoints", mid)) return;
        if (!await FormSave.record(store, "waypoints", mid, { rack_id: null })) return; // refusé par le Store (toast rouge) : ne rien annoncer, garder la saisie
        Notify.toast(I18n.t("rack.rackContent.brushRemoved"));
      } else { await store.remove("rackItems", mid); Notify.toast(I18n.t("rack.rackContent.itemRemoved")); }
      host.setDirty?.(true); render();
    };
    const done = () => { host.setDirty?.(true); render(); onChanged?.(); };
    // nom d'équipement CLIQUABLE → sa fiche, EMPILÉE par-dessus : cette modale reste vivante dessous et se
    // reconstruit au retour (son `onResume`). On transmet donc l'`onChanged` du contexte (rafraîchir la vue
    // d'origine), et non une ré-ouverture du contenu de baie — qui EMPILERAIT un doublon.
    const openEq = (eqId: string) => EquipmentForms.equipmentDetail(store, host, eqId, onChanged);
    const clickableName = (e: any): HTMLElement => {
      const s = document.createElement("span");
      s.textContent = e.name || I18n.t("lists.ph.noName");
      s.style.cssText = "cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;";
      s.setAttribute("role", "button"); s.tabIndex = 0; s.title = I18n.t("detail.viz.openEquip");
      s.onclick = () => openEq(e.id);
      s.onkeydown = (ev: KeyboardEvent) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openEq(e.id); } };
      return s;
    };
    const gridApi = this.rackFrontGrid(store, rack, {
      onSlotClick: (u, face) => this.assignSlot(store, host, rack.id, u, face, 1, done),
      onRemove: (kind, mid) => { removeMount(kind, mid); },
      onEquipInfo: openEq,   // clic sur le nom d'un occupant U → sa fiche
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
        const lab = document.createElement("span"); lab.className = "grow"; lab.appendChild(clickableName(e)); lab.appendChild(document.createTextNode(" · " + (e.u_height || 1) + "U " + this.mountDepthLabel(e)));
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
          lab.appendChild(clickableName(e)); lab.appendChild(document.createTextNode(" · " + I18n.t("rack.rackContent.marginLabel", { lr: e.side_lr === "right" ? I18n.t("rack.common.rightLower") : I18n.t("rack.common.leftLower") }) + " · U" + (e.side_u | 0) + (hU > 1 ? "–U" + ((e.side_u | 0) + hU - 1) : "") + (rack.sides === "dual" ? " · " + this.faceLabel(face) : "")));
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
      // montage libre : aucun filtre, aucun suffixe/blocage propre — decorate vide, option de tête « Choisir ».
      const eqI = FormControls.entityPicker(this.freeEquipOptions(eqFree, () => ({}), I18n.t("rack.common.choose")), "");
      body.appendChild(FormControls.fieldRow(I18n.t("rack.common.equipField"), eqI, I18n.t("rack.rackContent.freeEquipHint")));
      const res = await Dialog.custom({ title: I18n.t("rack.rackContent.freeDialogTitle"), confirmLabel: I18n.t("rack.rackContent.assign"), build: (r: HTMLElement) => { r.appendChild(body); return { validate: () => eqI.value ? true as const : I18n.t("rack.common.chooseEquip"), collect: () => eqI.value }; } });
      if (!res) return;
      if (!await FormSave.record(store, "equipments", res, { placement_mode: "rack", rack_id: rack.id, rack_u: null, rack_side: "front" })) return; // refusé par le Store (toast rouge) : ne rien annoncer, garder la saisie
      Notify.toast(I18n.t("rack.rackContent.freeAssigned")); done();
    };

    render();
    // `onResume` : la modale « contenu » se reconstruit quand elle revient au premier plan (une fiche
    // d'équipement, ou le formulaire d'édition ouvert depuis elle, vient d'être dépilé) — le montage a pu
    // changer entre-temps. Son `render()` interne, lui, couvre les mutations faites SUR PLACE.
    host.openModal({
      title: I18n.t("rack.rackContent.title", { name: Html.escape(rack.name || I18n.t("rack.common.rackWord")) }),
      subtitle: I18n.t("rack.rackContent.subtitle"), body: root, hideFooter: true, wide: true,
      // Clé DISTINCTE de la fiche baie (`detail:racks/`) : la modale « contenu » et la fiche d'identité
      // de la même baie sont deux niveaux différents, aucun ne doit dédupliquer l'autre.
      stackKey: "rack-content:" + id,
      onResume: () => this.rackContent(store, host, id, onChanged),
    });
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
    // COORDONNÉES GPS (optionnelles) — le placement des bâtiments dans le monde 3D en dérive (doctrine
    // §6.9). Elles sont ici, dans le FORMULAIRE, parce que le principe n°10 l'exige : aucun attribut,
    // placement compris, ne doit dépendre d'une vue 2D/3D pour être saisi. Le pas `any` autorise la
    // précision décimale usuelle d'un relevé GPS ; vide ⇒ null (le repli 5 km s'applique alors).
    const latI = FormControls.number(s && s.lat != null ? s.lat : "", { min: -90, max: 90, step: "any", placeholder: I18n.t("rack.site.latPlaceholder") });
    const lonI = FormControls.number(s && s.lon != null ? s.lon : "", { min: -180, max: 180, step: "any", placeholder: I18n.t("rack.site.lonPlaceholder") });
    root.appendChild(FormControls.fieldRow(I18n.t("rack.site.lat"), latI, I18n.t("rack.site.gpsHint")));
    root.appendChild(FormControls.fieldRow(I18n.t("rack.site.lon"), lonI));
    // TAILLE DÉCLARÉE du bâtiment (optionnelle) — elle fait l'emprise du bâtiment en 3D et devient une
    // CONTRAINTE : aucun plan d'étage ne peut en déborder (doctrine §6.8). Ici pour la même raison que le
    // GPS ci-dessus : le principe n°10 veut que tout attribut, placement compris, soit saisissable au
    // FORMULAIRE. Vide ⇒ null (l'emprise redevient alors celle du plus grand plan d'étage).
    const wI = FormControls.number(s && s.width_mm != null ? s.width_mm : "", { min: 1, step: 100, placeholder: I18n.t("rack.site.widthPlaceholder") });
    const dI = FormControls.number(s && s.depth_mm != null ? s.depth_mm : "", { min: 1, step: 100, placeholder: I18n.t("rack.site.depthPlaceholder") });
    root.appendChild(FormControls.fieldRow(I18n.t("rack.common.widthMm"), wI, I18n.t("rack.site.sizeHint")));
    root.appendChild(FormControls.fieldRow(I18n.t("rack.common.depthMm"), dI));
    const descI = FormControls.textArea(s ? s.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.description"), descI));
    const live = new LiveValidation("sites", { name: nameI, lat: latI, lon: lonI, width_mm: wI, depth_mm: dI });
    live.clearOnInput();
    host.openModal({
      title: s ? I18n.t("rack.site.titleEdit") : I18n.t("rack.site.titleNew"),
      subtitle: s ? Html.escape(s.name) : "",
      body: root,
      onSave: async () => {
        const num = (i: HTMLInputElement) => { const raw = i.value.trim(); return raw === "" ? null : Number(raw); };
        const payload = { name: nameI.value.trim(), address: addrI.value.trim(), lat: num(latI), lon: num(lonI), width_mm: num(wI), depth_mm: num(dI), description: descI.value.trim() };
        if (live.check(payload).length) return false;   // nom requis, bornes lat/lon, couples complets GPS + taille (surlignés)
        if (!await FormSave.record(store, "sites", s && s.id, payload)) return false;   // REFUSÉ par le Store (toast rouge nommant la règle) : ne rien annoncer, garder la saisie
        host.setDirty?.(true); Notify.toast(s ? I18n.t("rack.site.updated") : I18n.t("rack.site.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** CONTACT — destinataire des NOTIFICATIONS (email/sms), tenu PAR DOCUMENT : nom (requis) · organisation ·
      poste · e-mail · téléphone · notes. Validation TOLÉRANTE (cf. spec `contacts` : e-mail/téléphone
      contrôlés « en douceur », jamais bloquants sur une saisie raisonnable). Placé ici, aux côtés du
      formulaire `site` (autre entité « plate » simple) : le FORMULAIRE ne bouge pas ; seul son ONGLET a
      migré sous le groupe « Paramètres » (S6). */
  static contact(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const c: any = id ? store.get("contacts", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(c ? c.name : "", I18n.t("rack.contact.namePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.name"), nameI));
    const organizationI = FormControls.text(c ? c.organization : "", I18n.t("rack.contact.organizationPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.organization"), organizationI));
    const positionI = FormControls.text(c ? c.position : "", I18n.t("rack.contact.positionPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.position"), positionI));
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
        const payload = { name: nameI.value.trim(), organization: organizationI.value.trim(), position: positionI.value.trim(), email: emailI.value.trim(), phone: phoneI.value.trim(), notes: notesI.value.trim() };
        if (live.check(payload).length) return false;   // nom requis + e-mail/téléphone invalides (surlignés)
        if (!await FormSave.record(store, "contacts", c && c.id, payload)) return false;   // REFUSÉ par le Store (toast rouge nommant la règle) : ne rien annoncer, garder la saisie
        host.setDirty?.(true); Notify.toast(c ? I18n.t("rack.contact.updated") : I18n.t("rack.contact.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** APPLICATION — hébergée sur l'infrastructure : nom (requis) · hôte (équipement OU VM) · URL ·
      description. Placé ici, aux côtés des formulaires `site`/`contact` (autres entités « plates »
      simples). Le champ HÔTE est UN SEUL `entityPicker` MULTI-FAMILLES (principe n°14) : options =
      équipements PUIS VMs concaténés, values RE-PRÉFIXÉES à la convention composite EXISTANTE
      « <kind>:<id> » (`TargetSearch.key`/`parse` — le même encodage que les liens d'intervention et le
      filtre cible des listings, jamais un 2ᵉ). L'exclusivité equipment_id/vm_id est ainsi garantie PAR
      CONSTRUCTION (un seul picker) — PAS deux `<select>` exclusifs (patron désormais suivi aussi par le
      picker PORTEUR d'`IpamForms.ipAddress`, dette du principe n°14 résorbée). */
  static application(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const app: any = id ? store.get("applications", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(app ? app.name : "", I18n.t("rack.application.namePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.name"), nameI));
    // Options du picker d'hôte : les MÊMES listes métier que partout (FormUi.eqOptions/vmOptions, tri par
    // nom), re-préfixées famille par famille — libellé « Équipement · SRV37 » / « VM · gitlab » pour que
    // deux homonymes de familles différentes restent discernables dans un picker UNIQUE. L'option « aucun »
    // de tête reste UNE seule (les deux vides sont un état permis : app pas encore rattachée).
    const hostOptions = [{ value: "", label: I18n.t("forms.opt.none") }]
      .concat(FormUi.eqOptions(store, "").slice(1).map((o) => ({ value: TargetSearch.key("equipment", o.value), label: I18n.t("rack.application.familyEquipment") + " · " + o.label })))
      .concat(FormUi.vmOptions(store, "").slice(1).map((o) => ({ value: TargetSearch.key("vm", o.value), label: I18n.t("rack.application.familyVm") + " · " + o.label })));
    const initialHost = app && app.equipment_id ? TargetSearch.key("equipment", app.equipment_id)
      : app && app.vm_id ? TargetSearch.key("vm", app.vm_id) : "";
    const hostI = FormControls.entityPicker(hostOptions, initialHost);
    root.appendChild(FormControls.fieldRow(I18n.t("rack.application.hostField"), hostI, I18n.t("rack.application.hostHint")));
    const urlI = FormControls.text(app ? app.url : "", "https://…");
    root.appendChild(FormControls.fieldRow(I18n.t("rack.application.urlField"), urlI, I18n.t("rack.application.urlHint")));
    const descI = FormControls.textArea(app ? app.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.description"), descI));
    // Même validation PARTAGÉE que le Store/serveur : nom requis + format `url` (http/https). L'invariant
    // d'exclusivité equipment_id/vm_id est rattaché à `vm_id` par la spec → surligné sur le picker d'hôte
    // (inatteignable ici par construction, mais le câblage reste complet si la spec évolue).
    const live = new LiveValidation("applications", { name: nameI, url: urlI, vm_id: hostI });
    live.clearOnInput();
    host.openModal({
      title: app ? I18n.t("rack.application.titleEdit") : I18n.t("rack.application.titleNew"),
      subtitle: app ? Html.escape(app.name) : "",
      body: root,
      onSave: async () => {
        // Décomposition de la valeur composite du picker vers les DEUX FK : l'une reçoit l'id, l'autre
        // est explicitement remise à null (une édition qui change de famille doit VIDER l'ancienne FK).
        const parsedHost = hostI.value ? TargetSearch.parse(hostI.value) : null;
        const payload = {
          name: nameI.value.trim(), url: urlI.value.trim(), description: descI.value.trim(),
          equipment_id: parsedHost && parsedHost.kind === "equipment" ? parsedHost.id : null,
          vm_id: parsedHost && parsedHost.kind === "vm" ? parsedHost.id : null,
        };
        if (live.check(payload).length) return false;   // nom requis + URL http/https (surlignés)
        if (!await FormSave.record(store, "applications", app && app.id, payload)) return false;   // REFUSÉ par le Store (toast rouge nommant la règle) : ne rien annoncer, garder la saisie
        host.setDirty?.(true); Notify.toast(app ? I18n.t("rack.application.updated") : I18n.t("rack.application.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** PIÈCE JOINTE — fichier arbitraire attaché à un équipement OU un sous-équipement (convention de prêt,
      bon de commande, garantie, scan…). Les MÉTADONNÉES sont une collection ordinaire du document ; le
      BINAIRE vit HORS document (disque serveur en mode API, IndexedDB + compagnon `.nmfa` en mode fichier —
      cf. `data/AttachmentStore`, docs/attachments.md). Décalqué de `Forms.application` : un SEUL `entityPicker`
      MULTI-FAMILLES pour la cible (équipement / sous-équipement), values à la convention composite
      « <kind>:<id> » (`TargetSearch.key`/`parse`) → exclusivité `equipment_id`/`sub_equipment_id` garantie
      PAR CONSTRUCTION (un seul picker).

      Le FICHIER : OBLIGATOIRE à la création (`FilePicker`, liste blanche + plafond 50 Mo vérifiés au front) ;
      en ÉDITION, le binaire n'est PAS remplaçable en v1 (D10) — le picker cède la place à une ligne
      informative nom + taille (remplacer = supprimer puis recréer, limite documentée). L'édition ne touche
      donc QUE les métadonnées.

      DEUX MODES à la création (le mode fichier est natif, principe n°15) :
        - mode API : POST multipart via le backend REST (le serveur crée fichier + enregistrement
          ATOMIQUEMENT — rev/changeset/SSE), jamais un `FormSave.record` séparé ;
        - mode fichier : `FormSave.record` PUIS `putBlob` (dans cet ordre) — un échec de `putBlob` RETIRE
          l'enregistrement (pas de métadonnées sans binaire en local).
      Dépendances INJECTÉES par le host (`attachmentStore`, `restMode`) — pas d'import global. */
  static attachment(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const att: any = id ? store.get("attachments", id) : null;
    const attachmentStore = host.attachmentStore || null;
    const root = document.createElement("div");
    const nameI = FormControls.text(att ? att.name : "", I18n.t("attachment.form.namePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.name"), nameI));

    // FICHIER : création = FilePicker (obligatoire) ; édition = ligne INFORMATIVE (binaire non remplaçable v1).
    let picker: FilePickerElement | null = null;
    if (!att) {
      // Repli extension → MIME : `File.type` d'un `.md` est souvent VIDE (Windows/Firefox), et un `.csv` arrive
      // parfois avec un type d'éditeur. Le picker résout par l'extension AVANT de valider (cf. D-B2/FilePicker),
      // et EXPOSE le MIME résolu via `.mime` (consommé plus bas pour le meta, à la place de `file.type`).
      picker = FilePicker.build({
        accept: Schema.ATTACHMENT_MIME_TYPES, maxBytes: ATTACHMENT_MAX_BYTES, isValidMime: (t) => Schema.isAttachmentMime(t),
        extensionMime: { ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain", ".csv": "text/csv" },
      });
      root.appendChild(FormControls.fieldRow(I18n.t("attachment.form.file"), picker, I18n.t("attachment.form.fileHint")));
    } else {
      const info = document.createElement("div");
      info.className = "form-static";   // valeur en lecture seule, style de champ statique
      info.style.cssText = "padding:8px 0;color:var(--fg)";
      info.innerHTML = `${Html.escape(att.file_name || "?")} <span style="color:var(--fg-dimmer)">· ${Html.escape(Format.bytes(att.size))} · ${Html.escape(att.mime || "")}</span>`;
      root.appendChild(FormControls.fieldRow(I18n.t("attachment.form.file"), info, I18n.t("attachment.form.editLocked")));
    }

    // CIBLE : équipement OU sous-équipement, familles CONFONDUES dans UN picker (principe n°14). Options
    // équipements PUIS sous-équipements (mêmes moules : `FormUi.eqOptions`, et le même moule appliqué aux
    // sous-équipements), values RE-PRÉFIXÉES à la convention composite « <kind>:<id> ». Un sous-équipement
    // porte le nom de son MAÎTRE entre parenthèses (deux drives homonymes de librairies différentes restent
    // discernables dans un picker unique).
    const subEqOptions = store.all("subEquipments").slice()
      .sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""))
      .map((se: any) => {
        const master: any = se.equipment_id ? store.get("equipments", se.equipment_id) : null;
        const label = (se.name || I18n.t("subEquipment.fallback")) + (master ? ` (${master.name || I18n.t("lists.ph.equipment")})` : "");
        return { value: TargetSearch.key("sub_equipment", se.id), label: I18n.t("attachment.form.familySubEquipment") + " · " + label };
      });
    const targetOptions = [{ value: "", label: I18n.t("forms.opt.none") }]
      .concat(FormUi.eqOptions(store, "").slice(1).map((o) => ({ value: TargetSearch.key("equipment", o.value), label: I18n.t("attachment.form.familyEquipment") + " · " + o.label })))
      .concat(subEqOptions);
    const initialTarget = att && att.equipment_id ? TargetSearch.key("equipment", att.equipment_id)
      : att && att.sub_equipment_id ? TargetSearch.key("sub_equipment", att.sub_equipment_id) : "";
    const targetI = FormControls.entityPicker(targetOptions, initialTarget);
    root.appendChild(FormControls.fieldRow(I18n.t("attachment.form.target"), targetI, I18n.t("attachment.form.targetHint")));

    const descI = FormControls.textArea(att ? att.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("lists.col.description"), descI));

    // Validation PARTAGÉE (mêmes règles que le Store/serveur) : nom requis, MIME dans la liste blanche,
    // exclusivité equipment_id/sub_equipment_id (invariant rattaché à `sub_equipment_id` par la spec →
    // surligné sur le picker de cible, inatteignable ici par construction mais le câblage reste complet).
    const live = new LiveValidation("attachments", { name: nameI, sub_equipment_id: targetI }, (c, i) => store.get(c, i) || null);
    live.clearOnInput();

    host.openModal({
      title: att ? I18n.t("attachment.form.titleEdit") : I18n.t("attachment.form.titleNew"),
      subtitle: att ? Html.escape(att.name || "") : "",
      body: root,
      onSave: async () => {
        // Décomposition de la valeur composite du picker vers les DEUX FK : l'une reçoit l'id, l'autre est
        // remise à null (changer de famille en édition doit VIDER l'ancienne FK).
        const parsed = targetI.value ? TargetSearch.parse(targetI.value) : null;
        const equipment_id = parsed && parsed.kind === "equipment" ? parsed.id : null;
        const sub_equipment_id = parsed && parsed.kind === "sub_equipment" ? parsed.id : null;

        if (att) {
          // ÉDITION : métadonnées SEULEMENT (le binaire n'est pas remplaçable v1) — les deux modes.
          const payload = { name: nameI.value.trim(), description: descI.value.trim(), equipment_id, sub_equipment_id };
          // On revalide sur l'état COMPLET (les champs binaires inchangés viennent de l'enregistrement).
          if (live.check({ ...payload, file_name: att.file_name, mime: att.mime, size: att.size }).length) return false;
          if (!await FormSave.record(store, "attachments", att.id, payload)) return false;   // REFUSÉ (toast rouge du Store) : ne rien annoncer
          host.setDirty?.(true); Notify.toast(I18n.t("attachment.form.updated")); onSaved?.(); return true;
        }

        // CRÉATION : le fichier est OBLIGATOIRE.
        const file = picker && picker.file;
        if (!file) { Notify.toast(I18n.t("attachment.form.fileRequired"), "err"); return false; }
        // `file_name` vient du File choisi ; `mime` = le MIME RÉSOLU par le picker (repli extension → jamais
        // `file.type` brut, vide pour un `.md`) ; `size` est écrasé par le serveur en mode API.
        const meta = { name: nameI.value.trim(), description: descI.value.trim(), file_name: file.name, mime: (picker && picker.mime) || file.type, size: file.size, equipment_id, sub_equipment_id };
        if (live.check(meta).length) return false;   // nom requis + MIME liste blanche (surlignés)

        if (host.restMode) {
          // Mode API : le POST multipart crée fichier + enregistrement ATOMIQUEMENT côté serveur (rev++,
          // changeset, SSE, verrou). PAS de `FormSave.record` séparé (double écriture). L'id opaque est
          // généré ici (base36 → sûr pour `AttachmentFiles.isSafeId`), passé au backend.
          if (!attachmentStore) { Notify.toast(I18n.t("attachment.form.noStore"), "err"); return false; }
          try {
            await attachmentStore.putBlob(Id.uid(), file, meta);
          } catch (e: any) {
            // Le backend REMONTE le message du serveur (400 MIME/validation, 409…) — le montrer tel quel.
            Notify.toast((e && e.message) ? String(e.message) : I18n.t("attachment.form.uploadFailed"), "err");
            return false;
          }
          host.setDirty?.(true); Notify.toast(I18n.t("attachment.form.created")); onSaved?.(); return true;
        }

        // Mode fichier : enregistrement D'ABORD (métadonnées dans le document), binaire ENSUITE. Un échec de
        // `putBlob` RETIRE l'enregistrement — jamais de métadonnées sans binaire en local (cohérence D5/undo).
        if (!attachmentStore) { Notify.toast(I18n.t("attachment.form.noStore"), "err"); return false; }
        const rec = await FormSave.record(store, "attachments", null, meta);
        if (!rec) return false;   // REFUSÉ par le Store (toast rouge) : ne rien annoncer
        try {
          await attachmentStore.putBlob(rec.id, file, rec.toJSON ? rec.toJSON() : rec);
        } catch (_e) {
          await store.remove("attachments", rec.id);   // rollback : pas de métadonnées orphelines de binaire
          Notify.toast(I18n.t("attachment.form.blobFailed"), "err");
          return false;
        }
        host.setDirty?.(true); Notify.toast(I18n.t("attachment.form.created")); onSaved?.(); return true;
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
    // Hauteurs OPTIONNELLES (vide = non définie) : plafond de la salle (usage futur) + hauteur sous plancher technique.
    const hI = FormControls.number(dc && dc.height_mm != null ? dc.height_mm : "", { min: 1, step: 100, placeholder: I18n.t("rack.datacenter.heightPlaceholder") });
    const ufI = FormControls.number(dc && dc.underfloor_mm != null ? dc.underfloor_mm : "", { min: 1, step: 50, placeholder: I18n.t("rack.datacenter.underfloorPlaceholder") });
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("rack.datacenter.heightField"), hI, I18n.t("rack.datacenter.heightHint")), FormControls.fieldRow(I18n.t("rack.datacenter.underfloorField"), ufI, I18n.t("rack.datacenter.underfloorHint"))));
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
        // Hauteurs NULLABLES : entier ≥ 1 si saisi, sinon null (vide = non défini).
        const height_mm = (hI.value !== "") ? Math.max(1, parseInt(hI.value, 10) || 1) : null;
        const underfloor_mm = (ufI.value !== "") ? Math.max(1, parseInt(ufI.value, 10) || 1) : null;
        const payload = {
          name,
          width_mm: Math.max(1, parseInt(wI.value, 10) || 6000), depth_mm: Math.max(1, parseInt(dI.value, 10) || 4000), cell_mm: Math.max(1, parseInt(cI.value, 10) || 600),
          height_mm, underfloor_mm,
          location: locI.value || "", floor: floorI.value, room: roomI.value.trim(),
        };
        if (live.check(payload).length) return false;   // nom requis (surligné)
        if (!await FormSave.record(store, "datacenters", dc && dc.id, payload)) return false;   // REFUSÉ par le Store (toast rouge nommant la règle) : ne rien annoncer, garder la saisie
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
        if (!await FormSave.record(store, "datacenters", dcId, { doors: (dc.doors || []).map((d: any) => (d.id === doorId ? { ...d, ...patch } : d)) })) return false; // refusé par le Store (toast rouge) : ne rien annoncer, garder la saisie
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
    // dispo physique (depth − marge avant + cavités). Une brosse est ancrée au plan de montage AVANT, d'où `"front"`.
    const brushAvail = brushRack ? RackGeometry.mountAvailDepth(brushRack, "front") : Infinity;
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
          const sides = ["front"];   // brosse = face AVANT seule (parité RackOccupancy.sides / RackScene.occupants) ; l'arrière est protégé par la profondeur (V6d-brosse)
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
        if (!await FormSave.record(store, "waypoints", wp.id, payload)) return false; // refusé par le Store (toast rouge) : ne rien annoncer, garder la saisie
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
        if (!await FormSave.record(store, "floors", ex && ex.id, payload)) return false;   // REFUSÉ par le Store (toast rouge nommant la règle) : ne rien annoncer, garder la saisie
        host.setDirty?.(true); Notify.toast(pick ? I18n.t("rack.floor.created") : I18n.t("rack.floor.planSaved"));
        if (pick) opts.onPicked?.(L, F);
        return true;
      },
    });
  }

  /** Options d'un sélecteur d'équipement LIBRE à assigner — FACTEUR COMMUN des cinq dialogues de baie
      (montage libre, emplacement U, étagère, latéral, mural). Ce qui NE VARIE PAS et vit donc ici : la
      BASE du libellé (`nom` ou « sans nom »), la forme `{ value: id, label, disabled }` et le motif
      « option de tête + équipements ». Ce qui VARIE reste chez l'appelant, injecté — on factorise le
      CONTRÔLE, jamais la RÈGLE (principes n°3 et n°14) :
      - `eqFree` est la liste DÉJÀ construite/triée dehors : son FILTRE diffère par emplacement
        (aucun ; `dim_mode !== "free"` + `u_height === span` pour l'U ; `dim_mode === "free"` pour
        l'étagère) et la liste est RÉUTILISÉE au point d'appel (gardes « aucun équipement », valeur par
        défaut du dialogue étagère) — la construire ici la rendrait inaccessible à ces usages ;
      - `decorate` fournit, par équipement, le SUFFIXE de libellé (hauteur U + profondeur, dimensions
        libres, largeur, motif de blocage) et l'état `disabled` (placement bloqué, trop large) — ce sont
        les seules vraies différences entre les cinq selects ;
      - `head` est le libellé de l'option de tête (valeur ""), ou `null` quand le dialogue n'en veut PAS
        et présélectionne le 1er équipement (étagère). */
  private static freeEquipOptions(eqFree: any[], decorate: (e: any) => { suffix?: string; disabled?: boolean }, head: string | null): SelectOption[] {
    const opts: SelectOption[] = eqFree.map((e: any) => {
      const d = decorate(e);
      return { value: e.id, label: (e.name || I18n.t("lists.ph.noName")) + (d.suffix || ""), disabled: !!d.disabled };
    });
    return head != null ? [{ value: "", label: head }, ...opts] : opts;
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
    // emplacement U : suffixe hauteur U + profondeur de montage, blocage de placement (⚠ raison) → disabled.
    const eqI = FormControls.entityPicker(this.freeEquipOptions(eqFree, (e: any) => {
      const why = blockedWhy(e.id);
      return { suffix: " · " + (e.u_height || 1) + "U " + this.mountDepthLabel(e) + (why ? " — ⚠ " + why : ""), disabled: !!why };
    }, noEqLabel), "");
    const eqHint = span > 1 ? I18n.t("rack.assign.eqHintSpan", { n: span }) : I18n.t("rack.assign.eqHint");
    const eqRow = FormControls.fieldRow(I18n.t("rack.common.equipField"), eqI, eqHint); body.appendChild(eqRow);
    const labelI = FormControls.text("", I18n.t("rack.assign.labelPlaceholder")); const labelRow = FormControls.fieldRow(I18n.t("rack.common.label"), labelI); body.appendChild(labelRow);
    const pheightI = FormControls.number(String(span), { min: 1, step: 1 });
    const prow = FormControls.fieldRow(I18n.t("rack.common.heightU"), pheightI); body.appendChild(prow);
    // une PORTE borne la profondeur dispo (depth − marge avant + cavités − marge de sécurité) ; sans porte, libre.
    const brushHasDoor = RackGeometry.hasDoor(rack);
    const brushAvail = RackGeometry.mountAvailDepth(rack, "front");   // brosse = ancrage au plan de montage AVANT
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
    const brushSides = () => ["front"];   // brosse = face AVANT seule (parité RackOccupancy.sides / RackScene.occupants) ; l'arrière est protégé par la profondeur (V6d-brosse)
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
              for (const g of guests) if (!await FormSave.record(store, "equipments", g.id, { placement_mode: "manual", tray_item_id: null, tray_x: null, tray_y: null })) return false; // refusé par le Store (toast rouge) : ne rien annoncer, garder la saisie
              Notify.toast(I18n.t("rack.item.detached", { count: guests.length }));
            }
          }
        }
        if (!await FormSave.record(store, "rackItems", it.id, payload)) return false; // refusé par le Store (toast rouge) : ne rien annoncer, garder la saisie
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
    // étagère : suffixe dimensions libres (l×L×h) ; PAS d'option de tête (head=null) — le 1er équipement est présélectionné.
    const eqI = FormControls.entityPicker(this.freeEquipOptions(eqFree, (e: any) => ({ suffix: " · " + (e.free_w_mm || "?") + " × " + (e.free_l_mm || "?") + " × " + (e.free_h_mm || "?") + " mm" }), null), eqFree[0].id);
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
    // latéral : suffixe largeur libre + « trop large » si dépasse la colonne, disabled si blocage OU trop large.
    const eqI = FormControls.entityPicker(this.freeEquipOptions(eqFree, (e: any) => {
      const why = blockedWhy(e.id), wide = tooWide(e);
      return { suffix: (e.free_w_mm != null ? I18n.t("rack.side.mmWide", { w: e.free_w_mm }) : "") + (wide ? I18n.t("rack.side.tooWide") : "") + (why ? " — ⚠ " + why : ""), disabled: !!why || wide };
    }, eqFree.length ? I18n.t("rack.common.choose") : I18n.t("rack.assign.noFreeEquip")), "");
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
      if (!await FormSave.record(store, "waypoints", null, { name: res.name || "PIN", kind: "point", wp_type: "datacenter", datacenter_id: rack.datacenter_id, rack_id: rack.id, side_face: face, side_lr: lr, side_col: col, side_u: uTop })) return;   // refusé par le Store (toast rouge) : ne rien annoncer
      Notify.toast(I18n.t("rack.side.pinPlaced")); host.setDirty?.(true); onDone?.(); return;
    }
    const e = store.get("equipments", res.eid); if (!e) return;
    const free_w_mm = (e.free_w_mm != null) ? Math.min(e.free_w_mm, Math.round(colW)) : Math.round(Math.min(colW, 50));
    const free_h_mm = (e.free_h_mm != null) ? e.free_h_mm : (e.u_height ? e.u_height * U_MM : SIDE_U_STEP * U_MM);
    const free_l_mm = (e.free_l_mm != null) ? e.free_l_mm : Math.min(RackGeometry.cageDepth(rack), 300);
    if (!await FormSave.record(store, "equipments", res.eid, { placement_mode: "side", dim_mode: "free", rack_id: rack.id, rack_u: null, rack_side: "front", side_face: face, side_lr: lr, side_col: col, side_u: uTop, side_snap: snap, free_w_mm, free_h_mm, free_l_mm })) return;   // refusé par le Store (toast rouge) : ne rien annoncer
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
    // mural : pas de suffixe dimensionnel propre, seul le motif de blocage (⚠ raison) apparaît et rend disabled.
    const eqI = FormControls.entityPicker(this.freeEquipOptions(eqFree, (e: any) => {
      const why = blockedWhy(e.id);
      return { suffix: (why ? " — ⚠ " + why : ""), disabled: !!why };
    }, eqFree.length ? I18n.t("rack.common.choose") : I18n.t("rack.assign.noFreeEquip")), "");
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
    if (!await FormSave.record(store, "waypoints", null, { name: res.name || "PIN", kind: "point", wp_type: "datacenter", datacenter_id: rack.datacenter_id, rack_id: rack.id, cap_face: face, cap_cx: cx, cap_cy: cy })) return;   // refusé par le Store (toast rouge) : ne rien annoncer
    Notify.toast(I18n.t("rack.cap.pinPlaced")); host.setDirty?.(true); onDone?.();
  }
}
