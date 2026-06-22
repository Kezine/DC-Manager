import type { Store } from "../store";
import type { ModalOptions } from "../ui/Modal";
import { FormControls } from "../ui/FormControls";
import { ColorPalette } from "../ui/ColorPalette";
import { Notify } from "../ui/Notify";
import { Dialog } from "../ui/Dialog";
import { Html } from "../core/Html";
import { Ip } from "../core/Ip";
import { GroupTypes } from "../domain/GroupTypes";
import { CableStatuses } from "../domain/CableStatuses";
import { EquipmentTypes } from "../registries/EquipmentTypes";
import { Depths } from "../registries/Depths";
import { PortRoles } from "../registries/PortRoles";
import { Id } from "../core/Id";
import { RackGeometry } from "../geometry/RackGeometry";
import {
  POWER_SOURCES, EQUIPMENT_TYPE_DEFAULT, LOCATIONS, FLOORS, RACK_SIDES, RACK_DEPTHS,
  RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_MOUNT_MARGIN_DEFAULT, U_MM,
} from "../domain/constants";

const locOptions = (sel: string) => [{ value: "", label: "— aucun —" }].concat(LOCATIONS.map((l) => ({ value: l.id, label: l.label })));
const floorOptions = (sel: string) => { const s = String(sel == null ? "" : sel); const o = [{ value: "", label: "— étage —" }].concat(FLOORS.map((f) => ({ value: f, label: "Étage " + f }))); if (s && !FLOORS.includes(s)) o.push({ value: s, label: s + " (hors liste)" }); return o; };

const divider = (txt: string) => { const d = document.createElement("div"); d.className = "section-divider"; d.textContent = txt; return d; };
const row2 = (...fields: HTMLElement[]) => { const r = document.createElement("div"); r.className = "form-row"; fields.forEach((f) => r.appendChild(f)); return r; };
/** Remplace les options d'un <select> existant (préserve l'élément + ses handlers). */
const setOptions = (sel: HTMLSelectElement, opts: { value: string; label: string; disabled?: boolean }[], value?: string) => {
  sel.innerHTML = "";
  opts.forEach((o) => { const op = document.createElement("option"); op.value = o.value; op.textContent = o.label; if (o.disabled) op.disabled = true; sel.appendChild(op); });
  if (value != null) sel.value = value;
};

const ipNetOptions = (store: Store) => store.all("ipNetworks").slice()
  .sort((a: any, b: any) => (a.label || a.cidr || "").localeCompare(b.label || b.cidr || ""))
  .map((n: any) => ({ value: n.id, label: Ip.short(n) }));
const eqOptions = (store: Store, none: string) => [{ value: "", label: none }].concat(
  store.all("equipments").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((e: any) => ({ value: e.id, label: e.name || "(équipement)" })));

/** Services applicatifs des formulaires (câblés par le shell). */
export interface FormHost {
  openModal(opts: ModalOptions): void;
  setDirty?(v: boolean): void;
}

/* =============================================================================
   Formulaires d'édition (création + modification) montés dans la modale partagée.
   Réplique OO des fonctions open*Form du monolithe. `onSaved` rafraîchit l'appelant.
   ============================================================================= */
export class Forms {
  /** Réseau logique (data/power). */
  static network(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const net: any = id ? store.get("networks", id) : null;
    const root = document.createElement("div");
    const labelI = FormControls.text(net ? net.label : "", "ex. VLAN-Prod, Stockage…");
    root.appendChild(FormControls.fieldRow("Label", labelI));
    let color: string | null = net ? net.color : null;
    root.appendChild(FormControls.fieldRow("Couleur", ColorPalette.build(color, (c) => { color = c; }), "Colore les liens dans la topologie."));
    const kindSel = FormControls.select([{ value: "data", label: "Data" }, { value: "power", label: "Power (alimentation)" }], net ? (net.kind === "power" ? "power" : "data") : "data");
    root.appendChild(FormControls.fieldRow("Type", kindSel, "Data = réseau logique (VLAN…) · Power = circuit d'alimentation."));

    const voltI = FormControls.number((net && net.voltage != null) ? net.voltage : "", { min: 0, step: 1, placeholder: "ex. 230" });
    const ampI = FormControls.number((net && net.max_amp != null) ? net.max_amp : "", { min: 0, step: 1, placeholder: "ex. 16" });
    const srcSel = FormControls.select([{ value: "", label: "— non précisé —" }].concat(POWER_SOURCES.map((s) => ({ value: s.id, label: s.label }))), net ? (net.power_source || "") : "");
    const powerBox = document.createElement("div");
    const rowP = document.createElement("div"); rowP.className = "form-row";
    rowP.appendChild(FormControls.fieldRow("Tension (V)", voltI)); rowP.appendChild(FormControls.fieldRow("Capacité max (A)", ampI));
    powerBox.appendChild(rowP);
    powerBox.appendChild(FormControls.fieldRow("Alimentation", srcSel, "UPS, UPS + groupe, ou réseau seul."));
    root.appendChild(powerBox);

    const ipOpts = [{ value: "", label: "— aucun (réseau purement logique) —" }].concat(
      store.all("ipNetworks").slice().sort((a: any, b: any) => (a.label || a.cidr || "").localeCompare(b.label || b.cidr || "")).map((n: any) => ({ value: n.id, label: n.label || n.cidr || "(réseau IP)" })));
    const ipSel = FormControls.select(ipOpts, net ? (net.ip_network_id || "") : "");
    const ipField = FormControls.fieldRow("Réseau IP (réel)", ipSel, "Associe ce réseau logique à un sous-réseau de l'IPAM.");
    root.appendChild(ipField);

    const syncKind = () => { const power = kindSel.value === "power"; powerBox.style.display = power ? "" : "none"; ipField.style.display = power ? "none" : ""; };
    kindSel.addEventListener("change", syncKind); syncKind();
    const descI = FormControls.textArea(net ? net.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    host.openModal({
      title: net ? "Modifier le réseau" : "Nouveau réseau",
      subtitle: net ? Html.escape(net.label) : "",
      body: root,
      onSave: async () => {
        const label = labelI.value.trim();
        if (!label) { Notify.toast("Le label est obligatoire", "err"); return false; }
        const power = kindSel.value === "power";
        const payload = {
          label, color: color || null, kind: power ? "power" : "data",
          ip_network_id: power ? null : (ipSel.value || null),
          voltage: power && voltI.value !== "" ? Math.max(0, parseInt(voltI.value, 10) || 0) : null,
          max_amp: power && ampI.value !== "" ? Math.max(0, parseInt(ampI.value, 10) || 0) : null,
          power_source: power ? (srcSel.value || null) : null,
          description: descI.value.trim(),
        };
        if (net) await store.update("networks", net.id, payload); else await store.create("networks", payload);
        host.setDirty?.(true); Notify.toast(net ? "Réseau mis à jour" : "Réseau créé"); onSaved?.(); return true;
      },
    });
    setTimeout(() => labelI.focus(), 30);
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

    host.openModal({
      title: grp ? "Modifier le groupe" : "Nouveau groupe",
      subtitle: grp ? Html.escape(grp.label) : "",
      body: root,
      onSave: async () => {
        const label = labelI.value.trim();
        if (!label) { Notify.toast("Le label est obligatoire", "err"); return false; }
        const payload = { label, type: typeI.value || GroupTypes.DEFAULT, color: color || null, description: descI.value.trim() };
        if (grp) await store.update("groups", grp.id, payload); else await store.create("groups", payload);
        host.setDirty?.(true); Notify.toast(grp ? "Groupe mis à jour" : "Groupe créé"); onSaved?.(); return true;
      },
    });
    setTimeout(() => labelI.focus(), 30);
  }

  /** Équipement — formulaire CŒUR (identité · admin · groupe · dimensions · placement rack).
      DIFFÉRÉ (incréments suivants) : éditeur de ports/agrégats, breakout, placement
      latéral/paroi/étage, images de façade. Ces champs sont PRÉSERVÉS à l'édition
      (store.update applique un patch ; les clés non incluses ne sont pas touchées). */
  static equipment(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const eq: any = id ? store.get("equipments", id) : null;
    // brouillons (ids réels → FK ports↔agrégats tiennent avant l'enregistrement)
    const draftAggs: any[] = eq ? store.aggregatesOf(eq.id).map((a: any) => ({ id: a.id, name: a.name, description: a.description })) : [];
    const draftPorts: any[] = eq ? store.portsOf(eq.id).map((p: any) => ({
      id: p.id, name: p.name, port_type_id: p.port_type_id, role: p.role, aggregate_id: p.aggregate_id, description: p.description,
      parent_port_id: p.parent_port_id || null, lane: (p.lane != null) ? p.lane : null, face_x: p.face_x, face_y: p.face_y, face_side: p.face_side,
    })) : [];
    const root = document.createElement("div");

    // -- identité --
    const nameI = FormControls.text(eq ? eq.name : "", "ex. sw-core-01");
    const curType = eq ? (eq.type || EQUIPMENT_TYPE_DEFAULT) : EQUIPMENT_TYPE_DEFAULT;
    let typeOpts = EquipmentTypes.ALL.map((t) => ({ value: t.id, label: t.label }));
    if (curType && !EquipmentTypes.ALL.some((t) => t.id === curType)) typeOpts = [{ value: curType, label: curType + " (hors liste)" }, ...typeOpts];
    const typeI = FormControls.select(typeOpts, curType);
    root.appendChild(row2(FormControls.fieldRow("Nom", nameI), FormControls.fieldRow("Type", typeI)));

    const invI = FormControls.toggle("Inventaire seul", eq ? !!eq.inventory_only : false, () => sync(), { block: true, title: "Répertorié uniquement : ni placement, ni câblage, ni ports." });
    root.appendChild(invI);
    const brandI = FormControls.text(eq ? eq.brand : "", "ex. Cisco, Dell…");
    const modelI = FormControls.text(eq ? eq.model : "", "ex. Catalyst 2960…");
    root.appendChild(row2(FormControls.fieldRow("Marque", brandI), FormControls.fieldRow("Modèle", modelI)));
    const serialI = FormControls.text(eq ? eq.serial : "", "n° de série");
    root.appendChild(FormControls.fieldRow("Numéro de série", serialI));

    // -- administratif --
    root.appendChild(divider("Administratif"));
    const purchaseI = FormControls.date(eq ? eq.purchase_date : "");
    const warrantyI = FormControls.date(eq ? eq.warranty_end : "");
    const poI = FormControls.text(eq ? eq.po_ref : "", "réf. bon de commande");
    root.appendChild(row2(FormControls.fieldRow("Date d'achat", purchaseI), FormControls.fieldRow("Fin de garantie", warrantyI), FormControls.fieldRow("Bon de commande", poI)));
    const assignDateI = FormControls.date(eq ? eq.assigned_date : "");
    const assignToI = FormControls.text(eq ? eq.assigned_to : "", "nom de la personne");
    root.appendChild(row2(FormControls.fieldRow("Date d'attribution", assignDateI), FormControls.fieldRow("Attribué à", assignToI)));
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
    adv.appendChild(divider("Dimensions"));
    const dimI = FormControls.select([{ value: "u", label: "En U (rack)" }, { value: "free", label: "Libre (L × l × h en mm)" }], eq ? (eq.dim_mode === "free" ? "free" : "u") : "u");
    adv.appendChild(FormControls.fieldRow("Dimensionnement", dimI));
    // U
    const uBox = document.createElement("div");
    const uHI = FormControls.number(eq ? eq.u_height : 1, { min: 1, step: 1 });
    const depthI = FormControls.select(Depths.ALL.map((d) => ({ value: d.id, label: d.label })), eq && ["full", "half", "quarter"].includes(eq.depth) ? eq.depth : "full");
    uBox.appendChild(row2(FormControls.fieldRow("Hauteur (U)", uHI), FormControls.fieldRow("Profondeur", depthI)));
    adv.appendChild(uBox);
    // libre
    const freeBox = document.createElement("div");
    const flI = FormControls.number((eq && eq.free_l_mm != null) ? eq.free_l_mm : "", { min: 0, step: 1, placeholder: "longueur" });
    const fwI = FormControls.number((eq && eq.free_w_mm != null) ? eq.free_w_mm : "", { min: 0, step: 1, placeholder: "largeur" });
    const fhI = FormControls.number((eq && eq.free_h_mm != null) ? eq.free_h_mm : "", { min: 0, step: 1, placeholder: "hauteur" });
    freeBox.appendChild(row2(FormControls.fieldRow("Longueur (mm)", flI), FormControls.fieldRow("Largeur (mm)", fwI), FormControls.fieldRow("Hauteur (mm)", fhI)));
    adv.appendChild(freeBox);

    // placement rack (mode U seulement, dans ce cœur)
    const placeBox = document.createElement("div");
    placeBox.appendChild(divider("Placement (rack)"));
    const rackOpts = [{ value: "", label: "— non placé —" }].concat(store.all("racks").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((r: any) => ({ value: r.id, label: r.name || "(baie)" })));
    const rackI = FormControls.select(rackOpts, eq && eq.placement_mode === "rack" && eq.rack_id ? eq.rack_id : "");
    const rackUI = FormControls.number((eq && eq.rack_u != null) ? eq.rack_u : "", { min: 1, step: 1, placeholder: "U de bas (vide = libre)" });
    placeBox.appendChild(row2(FormControls.fieldRow("Baie", rackI), FormControls.fieldRow("Position (U)", rackUI)));
    const placeHint = document.createElement("div"); placeHint.className = "form-hint";
    placeHint.textContent = "Placement latéral / paroi / sur étage : à venir (préservé pour les équipements existants).";
    placeBox.appendChild(placeHint);
    adv.appendChild(placeBox);

    // -- agrégats (LAG / bond) --
    adv.appendChild(divider("Agrégats (LAG / bond)"));
    const aggList = document.createElement("div"); aggList.className = "chip-list"; adv.appendChild(aggList);
    const addAggBtn = document.createElement("button"); addAggBtn.type = "button"; addAggBtn.className = "btn btn-ghost btn-sm"; addAggBtn.textContent = "+ Agrégat"; addAggBtn.style.marginTop = "8px"; adv.appendChild(addAggBtn);

    // -- ports (breakout existant rendu en lecture seule ; + Breakout / Façade à venir) --
    adv.appendChild(divider("Ports"));
    const portList = document.createElement("div"); portList.className = "chip-list"; adv.appendChild(portList);
    const addPortBtn = document.createElement("button"); addPortBtn.type = "button"; addPortBtn.className = "btn btn-ghost btn-sm"; addPortBtn.textContent = "+ Port"; addPortBtn.style.marginTop = "8px"; adv.appendChild(addPortBtn);

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
    renderAggs(); renderPorts();

    root.appendChild(adv);

    const sync = () => {
      const inv = (invI as any).checked, u = dimI.value === "u";
      adv.style.display = inv ? "none" : "";
      uBox.style.display = u ? "" : "none";
      freeBox.style.display = u ? "none" : "";
      placeBox.style.display = u ? "" : "none";   // placement rack du cœur = mode U
      pduRow.style.display = (typeI.value === "pdu") ? "" : "none";
    };
    dimI.addEventListener("change", sync); typeI.addEventListener("change", sync); sync();

    host.openModal({
      title: eq ? "Modifier l'équipement" : "Nouvel équipement",
      subtitle: eq ? Html.escape(eq.name || "") : "Équipement, ses ports et agrégats",
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim();
        if (!name) { Notify.toast("Le nom est obligatoire", "err"); return false; }
        const inv = (invI as any).checked, free = dimI.value === "free";
        const payload: any = {
          name, type: typeI.value, brand: brandI.value.trim(), model: modelI.value.trim(), serial: serialI.value.trim(),
          inventory_only: inv, group_id: groupI.value || null, description: descI.value.trim(),
          purchase_date: (purchaseI as any).value || "", warranty_end: (warrantyI as any).value || "", po_ref: poI.value.trim(),
          assigned_date: (assignDateI as any).value || "", assigned_to: assignToI.value.trim(),
          pdu_max_a: pduI.value !== "" ? Math.max(0, parseInt(pduI.value, 10) || 0) : null,
          dim_mode: free ? "free" : "u",
        };
        if (free) {
          payload.free_l_mm = flI.value !== "" ? Math.max(0, parseInt(flI.value, 10) || 0) : null;
          payload.free_w_mm = fwI.value !== "" ? Math.max(0, parseInt(fwI.value, 10) || 0) : null;
          payload.free_h_mm = fhI.value !== "" ? Math.max(0, parseInt(fhI.value, 10) || 0) : null;
          // préserve un placement étage/latéral/paroi existant ; sinon « manuel »
          if (!eq || !["floor", "side", "wall"].includes(eq.placement_mode)) payload.placement_mode = "manual";
        } else {
          payload.u_height = Math.max(1, parseInt(uHI.value, 10) || 1);
          payload.depth = depthI.value;
          payload.placement_mode = "rack";
          payload.rack_id = rackI.value || null;
          payload.rack_u = rackUI.value !== "" ? Math.max(1, parseInt(rackUI.value, 10) || 1) : null;
        }
        let eqId: string;
        if (eq) { await store.update("equipments", eq.id, payload); eqId = eq.id; }
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

  /** Câble — formulaire CŒUR (extrémités · type compatible · réseaux · longueur · statut).
      DIFFÉRÉ : faisceaux/trunks et points de passage (waypoints) — préservés à l'édition. */
  static cable(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const cable: any = id ? store.get("cables", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(cable ? cable.name : "", "ex. patch-A12");
    root.appendChild(FormControls.fieldRow("Nom du câble", nameI));

    const eqOpts = () => [{ value: "", label: "— équipement —" }].concat(store.all("equipments").filter((e: any) => !e.inventory_only).slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).map((e: any) => ({ value: e.id, label: e.name || "(équipement)" })));
    const portOpts = (eqId: string, selectedId: string | null) => {
      const opts: { value: string; label: string; disabled?: boolean }[] = [{ value: "", label: "— port —" }];
      if (eqId) store.portsOf(eqId).filter((p: any) => !store.isBreakoutParent(p)).sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")).forEach((p: any) => {
        const occ = store.cableOnPort(p.id, cable ? cable.id : null);
        opts.push({ value: p.id, label: (p.name || "(port)") + (occ ? " · occupé" : ""), disabled: !!occ && p.id !== selectedId });
      });
      return opts;
    };

    const pa: any = cable && store.get("ports", cable.from_port_id);
    const pb: any = cable && store.get("ports", cable.to_port_id);
    const selEqA = FormControls.select(eqOpts(), pa ? pa.equipment_id : "");
    const selPortA = FormControls.select(portOpts(pa ? pa.equipment_id : "", cable ? cable.from_port_id : null), cable ? (cable.from_port_id || "") : "");
    root.appendChild(row2(FormControls.fieldRow("Équipement A", selEqA), FormControls.fieldRow("Port A", selPortA)));
    const selEqB = FormControls.select(eqOpts(), pb ? pb.equipment_id : "");
    const selPortB = FormControls.select(portOpts(pb ? pb.equipment_id : "", cable ? cable.to_port_id : null), cable ? (cable.to_port_id || "") : "");
    root.appendChild(row2(FormControls.fieldRow("Équipement B", selEqB), FormControls.fieldRow("Port B", selPortB)));

    const selType = FormControls.select([{ value: "", label: "— type de câble —" }], cable ? (cable.cable_type_id || "") : "");
    root.appendChild(FormControls.fieldRow("Type de câble", selType, "Seuls les types compatibles avec les ports sont proposés."));
    const lenI = FormControls.number((cable && cable.length_m != null) ? cable.length_m : "", { min: 0, step: 0.1, placeholder: "ex. 3" });
    root.appendChild(FormControls.fieldRow("Longueur (m)", lenI, "Optionnelle."));

    // réseaux multiples + principal
    const netState = { ids: new Set<string>(cable ? ((Array.isArray(cable.network_ids) && cable.network_ids.length) ? cable.network_ids : (cable.network_id ? [cable.network_id] : [])) : []), primary: cable ? (cable.network_id || null) : null as string | null };
    const netBoxes = document.createElement("div"); netBoxes.style.cssText = "display:flex;flex-wrap:wrap;gap:6px 14px;margin:2px 0;";
    const primSel = FormControls.select([{ value: "", label: "— aucun —" }], "");
    const primField = FormControls.fieldRow("Réseau principal", primSel, "Pilote la COULEUR du câble (≥ 2 réseaux).");
    const cableKind = () => { const t: any = selType.value ? store.get("cableTypes", selType.value) : null; return t ? (t.kind === "power" ? "power" : "data") : null; };
    const syncPrimary = () => {
      if (netState.primary && !netState.ids.has(netState.primary)) netState.primary = null;
      if (!netState.primary && netState.ids.size) netState.primary = [...netState.ids][0];
      setOptions(primSel, [{ value: "", label: "— aucun —" }].concat([...netState.ids].map((nid) => { const n: any = store.get("networks", nid); return { value: nid, label: n ? (n.label || "(réseau)") : nid }; })), netState.primary || "");
      primField.style.display = netState.ids.size > 1 ? "" : "none";
    };
    const renderNets = () => {
      const ck = cableKind();
      if (ck != null) [...netState.ids].forEach((nid) => { const n: any = store.get("networks", nid); if (n && (n.kind === "power" ? "power" : "data") !== ck) netState.ids.delete(nid); });
      netBoxes.innerHTML = "";
      const all = store.all("networks").slice().sort((a: any, b: any) => (a.label || "").localeCompare(b.label || ""));
      const shown = all.filter((n: any) => ck == null || (n.kind === "power" ? "power" : "data") === ck);
      if (!all.length) { const h = document.createElement("span"); h.className = "form-hint"; h.textContent = "Aucun réseau (onglet Réseaux)."; netBoxes.appendChild(h); }
      else if (!shown.length) { const h = document.createElement("span"); h.className = "form-hint"; h.textContent = "Aucun réseau « " + (ck === "power" ? "Power" : "Data") + " »."; netBoxes.appendChild(h); }
      else shown.forEach((n: any) => {
        const lab = document.createElement("label"); lab.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;";
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = netState.ids.has(n.id);
        cb.onchange = () => { if (cb.checked) netState.ids.add(n.id); else netState.ids.delete(n.id); syncPrimary(); };
        const sw = document.createElement("span"); sw.className = "swatch-dot"; if (n.color) sw.style.background = n.color;
        const tx = document.createElement("span"); tx.textContent = (n.kind === "power" ? "⚡ " : "") + (n.label || "(réseau)");
        lab.append(cb, sw, tx); netBoxes.appendChild(lab);
      });
      syncPrimary();
    };
    primSel.onchange = () => { netState.primary = primSel.value || null; };
    root.appendChild(FormControls.fieldRow("Réseaux", netBoxes, "Réseaux du même type que le câble. Cochez-en un ou plusieurs."));
    root.appendChild(primField);

    const statusSel = FormControls.select(CableStatuses.ALL.filter((s) => s.id !== "brouillon").map((s) => ({ value: s.id, label: s.label })), cable && cable.status !== "brouillon" ? cable.status : "planifie");
    root.appendChild(FormControls.fieldRow("Statut", statusSel, "Brouillon imposé tant que l'assignation est incomplète."));

    const renderType = () => {
      const fa = store.portFamily(store.get("ports", selPortA.value)); const fb = store.portFamily(store.get("ports", selPortB.value));
      let list = store.all("cableTypes").slice().sort((a: any, b: any) => a.name.localeCompare(b.name));
      if (fa && fb && fa === fb) list = list.filter((t: any) => t.family === fa);
      setOptions(selType, [{ value: "", label: "— type de câble —" }].concat(list.map((t: any) => ({ value: t.id, label: t.name + " · " + t.family }))), selType.value);
      renderNets();
    };
    selEqA.onchange = () => { setOptions(selPortA, portOpts(selEqA.value, null)); renderType(); };
    selEqB.onchange = () => { setOptions(selPortB, portOpts(selEqB.value, null)); renderType(); };
    selPortA.onchange = renderType; selPortB.onchange = renderType;
    renderType();

    host.openModal({
      title: cable ? "Modifier le câble" : "Nouveau câble",
      subtitle: cable ? Html.escape(cable.name || "") : "",
      body: root, wide: true,
      onSave: async () => {
        const from = selPortA.value || null, to = selPortB.value || null, type = selType.value || null;
        if (from && to && from === to) { Notify.toast("Les deux extrémités doivent être différentes.", "err"); return false; }
        const complete = !!(from && to && type && from !== to);
        if (complete) {
          const compat = store.cableCompatible(type!, from!, to!);
          if (!compat.ok) { Notify.toast(compat.reason || "Câble incompatible.", "err"); return false; }
        }
        const ids = [...netState.ids];
        let primary = netState.primary; if (primary && !ids.includes(primary)) primary = null; if (!primary && ids.length) primary = ids[0];
        const len = parseFloat(String(lenI.value));
        const payload = {
          name: nameI.value.trim(), cable_type_id: type, from_port_id: from, to_port_id: to,
          network_ids: ids, network_id: primary,
          length_m: (isFinite(len) && len >= 0) ? len : null,
          status: complete ? (statusSel.value || "planifie") : "brouillon",
        };
        if (cable) await store.update("cables", cable.id, payload); else await store.create("cables", payload);
        host.setDirty?.(true); Notify.toast(cable ? "Câble mis à jour" : "Câble créé"); onSaved?.(); return true;
      },
    });
    setTimeout(() => (cable ? nameI : selEqA).focus(), 30);
  }

  /** Baie (rack) — formulaire CŒUR (identité · localisation · cage · dims · side-mount).
      DIFFÉRÉ : portes et éditeur de capots (préservés à l'édition). */
  static rack(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const rk: any = id ? store.get("racks", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(rk ? rk.name : "", "ex. Baie A1");
    root.appendChild(FormControls.fieldRow("Nom", nameI));

    // emplacement asservi au DC si la baie y est placée
    const rackDc: any = (rk && rk.datacenter_id) ? store.get("datacenters", rk.datacenter_id) : null;
    const locI = FormControls.select(locOptions(""), rackDc ? (rackDc.location || "") : (rk ? rk.location : ""));
    const floorI = FormControls.select(floorOptions(rackDc ? (rackDc.floor || "") : (rk ? rk.floor : "")), rackDc ? (rackDc.floor || "") : (rk ? rk.floor : ""));
    const roomI = FormControls.text(rackDc ? (rackDc.room || "") : (rk ? rk.room : ""), "local");
    if (rackDc) [locI, floorI, roomI].forEach((el: any) => { el.disabled = true; el.style.opacity = "0.7"; });
    root.appendChild(row2(FormControls.fieldRow("Lieu", locI), FormControls.fieldRow("Étage", floorI), FormControls.fieldRow("Local", roomI)));
    if (rackDc) { const h = document.createElement("div"); h.className = "form-hint"; h.innerHTML = "⛓ Emplacement asservi au datacenter « " + Html.escape(rackDc.name || "(salle)") + " ». Retirez la baie de la salle pour l'éditer."; root.appendChild(h); }

    // cage
    root.appendChild(divider("Dimensions de la cage"));
    const uI = FormControls.number(rk ? rk.u_count : 42, { min: 1 });
    const vmI = FormControls.number(rk ? RackGeometry.vMarginTop(rk) : RACK_MOUNT_MARGIN_DEFAULT, { min: 0 });
    const vmBotI = FormControls.number(rk && rk.vmargin_bottom_mm != null ? rk.vmargin_bottom_mm : "", { min: 0, placeholder: "= marge haute" });
    const cageI = FormControls.number(rk ? RackGeometry.cageDepth(rk) : RACK_DEPTH_DEFAULT, { min: 1 });
    const fmI = FormControls.number(rk ? RackGeometry.frontMargin(rk) : 0, { min: 0, placeholder: "0" });
    const lmI = FormControls.number(rk ? RackGeometry.lMargin(rk) : RACK_MOUNT_MARGIN_DEFAULT, { min: 0 });
    const sidesI = FormControls.select(RACK_SIDES.map((s) => ({ value: s.id, label: s.label })), rk ? rk.sides : "single");
    root.appendChild(row2(FormControls.fieldRow("Hauteur (U)", uI), FormControls.fieldRow("Marge verticale (mm)", vmI), FormControls.fieldRow("Marge basse (mm)", vmBotI)));
    root.appendChild(row2(FormControls.fieldRow("Profondeur cage (mm)", cageI), FormControls.fieldRow("Marge avant (mm)", fmI), FormControls.fieldRow("Marge latérale (mm)", lmI), FormControls.fieldRow("Faces", sidesI)));

    // dimensions extérieures
    root.appendChild(divider("Dimensions extérieures"));
    const widthI = FormControls.number(rk ? rk.width_mm : RACK_WIDTH_DEFAULT, { min: 1 });
    const heightI = FormControls.number(rk && rk.height_mm != null ? rk.height_mm : "", { min: 1, placeholder: "= hauteur mini" });
    const depthI = FormControls.number(rk ? rk.depth : RACK_DEPTH_DEFAULT, { min: 1 });
    FormControls.attachDatalist(depthI, "dl-rack-depth", RACK_DEPTHS.map(String));
    root.appendChild(row2(FormControls.fieldRow("Largeur (mm)", widthI), FormControls.fieldRow("Hauteur (mm)", heightI), FormControls.fieldRow("Profondeur (mm)", depthI)));
    const geoHint = document.createElement("div"); geoHint.className = "form-hint"; root.appendChild(geoHint);

    // side-mount
    root.appendChild(divider("Montage latéral (marge)"));
    const sideFrontI = FormControls.toggle("Side-mount avant", rk ? !!rk.allow_side_front : false, () => {}, { block: true });
    const sideRearI = FormControls.toggle("Side-mount arrière", rk ? !!rk.allow_side_rear : false, () => {}, { block: true });
    root.appendChild(row2(sideFrontI, sideRearI));
    const descI = FormControls.textArea(rk ? rk.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    const _n = (i: HTMLInputElement, d: number) => { const v = parseInt(i.value, 10); return isFinite(v) ? v : d; };
    const geo = () => {
      const u = Math.max(1, _n(uI, 42)), vt = Math.max(0, _n(vmI, 0)), vb = (vmBotI.value !== "") ? Math.max(0, _n(vmBotI, 0)) : Math.max(0, _n(vmI, 0));
      const lm = Math.max(0, _n(lmI, 0)), cage = Math.max(1, _n(cageI, RACK_DEPTH_DEFAULT)), fm = Math.max(0, _n(fmI, 0));
      return { u, vt, vb, lm, cage, fm, minH: u * U_MM + vt + vb, minW: RACK_MOUNT_WIDTH + 2 * lm, minD: cage + fm };
    };
    const refreshGeo = () => {
      const g = geo();
      geoHint.textContent = "Mini : largeur ≥ " + Math.round(g.minW) + " · hauteur ≥ " + Math.round(g.minH) + " · profondeur ≥ " + g.minD + " mm (ajustées à l'enregistrement).";
      const margin = Math.max(0, (_n(widthI, RACK_WIDTH_DEFAULT) - RACK_MOUNT_WIDTH) / 2);
      (sideFrontI as any).disabled = margin < U_MM; (sideRearI as any).disabled = margin < U_MM;
    };
    [uI, vmI, vmBotI, cageI, fmI, lmI, widthI, heightI, depthI].forEach((i) => i.addEventListener("input", refreshGeo));
    refreshGeo();

    host.openModal({
      title: rk ? "Modifier la baie" : "Nouvelle baie",
      subtitle: rk ? Html.escape(rk.name || "") : "",
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim();
        if (!name) { Notify.toast("Le nom est obligatoire", "err"); return false; }
        const g = geo();
        const minW = Math.round(g.minW), minH = Math.round(g.minH), minD = g.minD;
        let width_mm = Math.max(1, _n(widthI, RACK_WIDTH_DEFAULT)); if (width_mm < minW) width_mm = minW;
        let depth = Math.max(1, _n(depthI, RACK_DEPTH_DEFAULT)); if (depth < minD) depth = minD;
        let height_mm: number | null = (heightI.value !== "") ? Math.max(1, _n(heightI, minH)) : null;
        if (height_mm != null && height_mm < minH) height_mm = minH;
        const sideOk = (width_mm - RACK_MOUNT_WIDTH) / 2 >= U_MM;
        const payload: any = {
          name,
          location: rackDc ? (rk.location || "") : (locI.value || ""), floor: rackDc ? (rk.floor || "") : floorI.value, room: rackDc ? (rk.room || "") : roomI.value.trim(),
          u_count: g.u, width_mm, depth, sides: sidesI.value === "dual" ? "dual" : "single",
          lmargin_mm: g.lm, vmargin_mm: g.vt, vmargin_bottom_mm: (vmBotI.value !== "") ? g.vb : null,
          cage_depth_mm: g.cage, front_margin_mm: g.fm, height_mm, mount_margin_mm: g.lm,
          allow_side_front: sideOk && (sideFrontI as any).checked, allow_side_rear: sideOk && (sideRearI as any).checked,
          description: descI.value.trim(),
        };
        // redimensionnement d'une baie occupée (nombre de U) → déplace ses équipements
        if (rk && g.u !== rk.u_count) {
          const occ = store.equipmentsOfRack(rk.id);
          if (occ.length) {
            const ok = await Dialog.confirm({ title: "Redimensionner la baie ?", message: "Cette baie contient " + occ.length + " équipement(s). Changer le nombre de U les passera tous en « Non placé ». Continuer ?", confirmLabel: "Redimensionner", danger: true });
            if (!ok) return false;
            await store.updateBatch([{ collection: "racks", id: rk.id, patch: payload }].concat(occ.map((e: any) => ({ collection: "equipments", id: e.id, patch: { placement_mode: "manual", rack_id: null, rack_u: null } }))));
            host.setDirty?.(true); Notify.toast("Baie redimensionnée"); onSaved?.(); return true;
          }
        }
        if (rk) await store.update("racks", rk.id, payload); else await store.create("racks", payload);
        host.setDirty?.(true); Notify.toast(rk ? "Baie mise à jour" : "Baie créée"); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** Réseau IP (sous-réseau CIDR). */
  static ipNetwork(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const net: any = id ? store.get("ipNetworks", id) : null;
    const root = document.createElement("div");
    const labelI = FormControls.text(net ? net.label : "", "ex. LAN Prod, DMZ…");
    root.appendChild(FormControls.fieldRow("Label", labelI));
    const cidrI = FormControls.text(net ? net.cidr : "", "ex. 10.0.0.0/24");
    const hint = document.createElement("div"); hint.className = "form-hint";
    const refresh = () => {
      const c = Ip.parseCidr(cidrI.value);
      if (!cidrI.value.trim()) { hint.textContent = "Sous-réseau IPv4 « adresse/préfixe »."; hint.style.color = ""; return; }
      if (!c) { hint.textContent = "⚠ CIDR IPv4 invalide."; hint.style.color = "var(--err)"; return; }
      hint.style.color = "";
      hint.innerHTML = `Réseau <strong>${c.networkStr}</strong> · diffusion <strong>${c.broadcastStr}</strong> · ${c.hostCount} hôte(s)`;
    };
    cidrI.addEventListener("input", refresh); refresh();
    root.appendChild(FormControls.fieldRow("CIDR", cidrI)); root.appendChild(hint);
    const descI = FormControls.textArea(net ? net.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    host.openModal({
      title: net ? "Modifier le réseau IP" : "Nouveau réseau IP",
      subtitle: net ? Html.escape(Ip.short(net)) : "",
      body: root,
      onSave: async () => {
        const label = labelI.value.trim();
        const c = Ip.parseCidr(cidrI.value);
        if (!label) { Notify.toast("Le label est obligatoire", "err"); return false; }
        if (!c) { Notify.toast("CIDR IPv4 invalide (ex. 10.0.0.0/24)", "err"); return false; }
        const cidr = c.networkStr + "/" + c.prefix;
        if (net) {
          const bad = store.ipAddressesOfNetwork(net.id).find((a: any) => !Ip.inCidr(Ip.toInt(a.address), c));
          if (bad) { Notify.toast(`L'adresse ${bad.address} ne serait plus dans ${cidr}.`, "err"); return false; }
          const badR = store.dhcpRangesOfNetwork(net.id).find((r: any) => !Ip.inCidr(Ip.toInt(r.start_ip), c) || !Ip.inCidr(Ip.toInt(r.end_ip), c));
          if (badR) { Notify.toast(`La plage DHCP ${badR.start_ip}→${badR.end_ip} ne serait plus dans ${cidr}.`, "err"); return false; }
        }
        const payload = { label, cidr, description: descI.value.trim() };
        if (net) await store.update("ipNetworks", net.id, payload); else await store.create("ipNetworks", payload);
        host.setDirty?.(true); Notify.toast(net ? "Réseau IP mis à jour" : "Réseau IP créé"); onSaved?.(); return true;
      },
    });
    setTimeout(() => labelI.focus(), 30);
  }

  /** Adresse IP statique. */
  static ipAddress(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const addr: any = id ? store.get("ipAddresses", id) : null;
    if (!addr && !store.all("ipNetworks").length) { Notify.toast("Créez d'abord un réseau IP.", "err"); return; }
    const root = document.createElement("div");
    const netSel = FormControls.select(ipNetOptions(store), addr ? addr.network_id : "");
    root.appendChild(FormControls.fieldRow("Réseau IP", netSel));
    const ipWrap = document.createElement("div"); ipWrap.style.display = "flex"; ipWrap.style.gap = "8px";
    const ipI = FormControls.text(addr ? addr.address : "", "ex. 10.0.0.10"); ipI.style.flex = "1"; ipI.style.fontFamily = "var(--mono)";
    const freeBtn = document.createElement("button"); freeBtn.type = "button"; freeBtn.className = "btn btn-ghost btn-sm"; freeBtn.textContent = "Proposer libre";
    freeBtn.onclick = () => { const f = Ip.nextFree(store, netSel.value); if (f) ipI.value = f; else Notify.toast("Aucune adresse libre.", "err"); };
    ipWrap.appendChild(ipI); ipWrap.appendChild(freeBtn);
    const hint = document.createElement("div"); hint.className = "form-hint";
    const refresh = () => { const c = Ip.cidrOf(store.get("ipNetworks", netSel.value)); hint.innerHTML = c ? `Plage assignable : <strong>${Ip.toStr(c.firstHost)}</strong> → <strong>${Ip.toStr(c.lastHost)}</strong>` : "Choisissez un réseau au CIDR valide."; };
    netSel.addEventListener("change", refresh); refresh();
    root.appendChild(FormControls.fieldRow("Adresse IP", ipWrap)); root.appendChild(hint);
    const hostI = FormControls.text(addr ? addr.hostname : "", "ex. srv-web-01.lan"); hostI.style.fontFamily = "var(--mono)";
    root.appendChild(FormControls.fieldRow("Hostname", hostI, "Facultatif."));
    const eqSel = FormControls.select(eqOptions(store, "— aucun —"), addr ? (addr.equipment_id || "") : "");
    root.appendChild(FormControls.fieldRow("Équipement", eqSel, "Facultatif."));
    const descI = FormControls.textArea(addr ? addr.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    host.openModal({
      title: addr ? "Modifier l'adresse IP" : "Nouvelle adresse IP",
      subtitle: addr ? Html.escape(addr.address) : "",
      body: root,
      onSave: async () => {
        const networkId = netSel.value;
        const net = store.get("ipNetworks", networkId); const c = Ip.cidrOf(net);
        if (!net) { Notify.toast("Choisissez un réseau IP.", "err"); return false; }
        if (!c) { Notify.toast("Le réseau choisi a un CIDR invalide.", "err"); return false; }
        const address = ipI.value.trim();
        const ipInt = Ip.toInt(address);
        if (ipInt == null) { Notify.toast("Adresse IPv4 invalide.", "err"); return false; }
        if (!Ip.inCidr(ipInt, c)) { Notify.toast(`${address} n'appartient pas à ${net.cidr}.`, "err"); return false; }
        const dup = store.ipAddressByValue(address);
        if (dup && (!addr || dup.id !== addr.id)) { Notify.toast(`L'adresse ${address} est déjà attribuée.`, "err"); return false; }
        const conflict = Ip.dhcpRangeContaining(store, networkId, ipInt);
        if (conflict) { Notify.toast(`${address} est dans la plage DHCP ${conflict.start_ip}→${conflict.end_ip}.`, "err"); return false; }
        const payload = { network_id: networkId, address, hostname: hostI.value.trim(), equipment_id: eqSel.value || null, description: descI.value.trim() };
        if (addr) await store.update("ipAddresses", addr.id, payload); else await store.create("ipAddresses", payload);
        host.setDirty?.(true); Notify.toast(addr ? "Adresse mise à jour" : "Adresse attribuée"); onSaved?.(); return true;
      },
    });
    setTimeout(() => { if (!addr) netSel.focus(); else ipI.focus(); }, 30);
  }

  /** Plage DHCP réservée. */
  static dhcpRange(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const rng: any = id ? store.get("dhcpRanges", id) : null;
    if (!rng && !store.all("ipNetworks").length) { Notify.toast("Créez d'abord un réseau IP.", "err"); return; }
    const root = document.createElement("div");
    const netSel = FormControls.select(ipNetOptions(store), rng ? rng.network_id : "");
    root.appendChild(FormControls.fieldRow("Réseau IP", netSel));
    const startI = FormControls.text(rng ? rng.start_ip : "", "ex. 10.0.0.100"); startI.style.fontFamily = "var(--mono)";
    const endI = FormControls.text(rng ? rng.end_ip : "", "ex. 10.0.0.200"); endI.style.fontFamily = "var(--mono)";
    const hint = document.createElement("div"); hint.className = "form-hint";
    const refresh = () => { const c = Ip.cidrOf(store.get("ipNetworks", netSel.value)); hint.innerHTML = c ? `Bornes dans : <strong>${c.networkStr}</strong> → <strong>${c.broadcastStr}</strong>` : "Choisissez un réseau au CIDR valide."; };
    netSel.addEventListener("change", refresh); refresh();
    root.appendChild(FormControls.fieldRow("Début de plage", startI));
    root.appendChild(FormControls.fieldRow("Fin de plage", endI)); root.appendChild(hint);
    const srvSel = FormControls.select(eqOptions(store, "— non désigné —"), rng ? (rng.server_id || "") : "");
    root.appendChild(FormControls.fieldRow("Serveur DHCP", srvSel, "Facultatif."));
    const descI = FormControls.textArea(rng ? rng.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));

    host.openModal({
      title: rng ? "Modifier la plage DHCP" : "Nouvelle plage DHCP",
      subtitle: rng ? Html.escape(rng.start_ip + " → " + rng.end_ip) : "",
      body: root,
      onSave: async () => {
        const networkId = netSel.value;
        const net = store.get("ipNetworks", networkId); const c = Ip.cidrOf(net);
        if (!net) { Notify.toast("Choisissez un réseau IP.", "err"); return false; }
        if (!c) { Notify.toast("Le réseau choisi a un CIDR invalide.", "err"); return false; }
        const s = Ip.toInt(startI.value.trim()), e = Ip.toInt(endI.value.trim());
        if (s == null) { Notify.toast("Adresse de début invalide.", "err"); return false; }
        if (e == null) { Notify.toast("Adresse de fin invalide.", "err"); return false; }
        if (e < s) { Notify.toast("La fin de plage doit être ≥ au début.", "err"); return false; }
        if (!Ip.inCidr(s, c) || !Ip.inCidr(e, c)) { Notify.toast(`Les bornes doivent appartenir à ${net.cidr}.`, "err"); return false; }
        const overlap = store.dhcpRangesOfNetwork(networkId).find((r: any) => {
          if (rng && r.id === rng.id) return false;
          const rs = Ip.toInt(r.start_ip), re = Ip.toInt(r.end_ip);
          return rs != null && re != null && s <= re && rs <= e;
        });
        if (overlap) { Notify.toast(`Chevauche la plage ${overlap.start_ip}→${overlap.end_ip}.`, "err"); return false; }
        const staticHit = store.ipAddressesOfNetwork(networkId).find((a: any) => { const n = Ip.toInt(a.address); return n != null && n >= s && n <= e; });
        if (staticHit) { Notify.toast(`L'IP statique ${staticHit.address} est dans cette plage.`, "err"); return false; }
        const payload = { network_id: networkId, start_ip: Ip.toStr(s), end_ip: Ip.toStr(e), server_id: srvSel.value || null, description: descI.value.trim() };
        if (rng) await store.update("dhcpRanges", rng.id, payload); else await store.create("dhcpRanges", payload);
        host.setDirty?.(true); Notify.toast(rng ? "Plage DHCP mise à jour" : "Plage DHCP réservée"); onSaved?.(); return true;
      },
    });
    setTimeout(() => { if (!rng) netSel.focus(); else startI.focus(); }, 30);
  }
}
