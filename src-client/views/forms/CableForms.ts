import type { Store } from "../../store";
import { FormControls } from "../../ui/FormControls";
import { LiveValidation } from "./LiveValidation";
import { ColorPalette } from "../../ui/ColorPalette";
import { Notify } from "../../ui/Notify";
import { Html } from "../../core/Html";
import { CableStatuses } from "../../domain/CableStatuses";
import { Waypoint } from "../../models/Waypoint";
import { PortRoles } from "../../registries/PortRoles";
import { I18n } from "../../i18n/I18n";
import {
  POWER_SOURCES,
  CABLE_STATUS_DRAFT, CABLE_STATUS_DEFAULT_NEW
} from "../../domain/constants";
import { FormUi } from "./shared";
import type { FormHost } from "./shared";
import { EquipmentForms } from "./EquipmentForms";

export class CableForms extends EquipmentForms {

  /** Réseau logique (data/power). */
  static network(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const net: any = id ? store.get("networks", id) : null;
    const root = document.createElement("div");
    const labelI = FormControls.text(net ? net.label : "", I18n.t("cable.net.labelPlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("cable.net.label"), labelI));
    let color: string | null = net ? net.color : null;
    root.appendChild(FormControls.fieldRow(I18n.t("cable.net.color"), ColorPalette.build(color, (c) => { color = c; }), I18n.t("cable.net.colorHint")));
    const kindSel = FormControls.select([{ value: "data", label: I18n.t("cable.net.optData") }, { value: "power", label: I18n.t("cable.net.optPower") }], net ? (net.kind === "power" ? "power" : "data") : "data");
    root.appendChild(FormControls.fieldRow(I18n.t("cable.net.type"), kindSel, I18n.t("cable.net.typeHint")));

    const voltI = FormControls.number((net && net.voltage != null) ? net.voltage : "", { min: 0, step: 1, placeholder: I18n.t("cable.net.voltPlaceholder") });
    const ampI = FormControls.number((net && net.max_amp != null) ? net.max_amp : "", { min: 0, step: 1, placeholder: I18n.t("cable.net.ampPlaceholder") });
    const srcSel = FormControls.select([{ value: "", label: I18n.t("cable.net.sourceNone") }].concat(POWER_SOURCES.map((s) => ({ value: s.id, label: I18n.t(s.labelKey) }))), net ? (net.power_source || "") : "");
    const powerBox = document.createElement("div");
    const rowP = document.createElement("div"); rowP.className = "form-row";
    rowP.appendChild(FormControls.fieldRow(I18n.t("cable.net.voltage"), voltI)); rowP.appendChild(FormControls.fieldRow(I18n.t("cable.net.ampMax"), ampI));
    powerBox.appendChild(rowP);
    powerBox.appendChild(FormControls.fieldRow(I18n.t("cable.net.supply"), srcSel, I18n.t("cable.net.supplyHint")));
    root.appendChild(powerBox);

    const ipOpts = [{ value: "", label: I18n.t("cable.net.ipNone") }].concat(
      store.all("ipNetworks").slice().sort((a: any, b: any) => (a.label || a.cidr || "").localeCompare(b.label || b.cidr || "")).map((n: any) => ({ value: n.id, label: n.label || n.cidr || I18n.t("cable.net.ipFallback") })));
    const ipSel = FormControls.select(ipOpts, net ? (net.ip_network_id || "") : "");
    const ipField = FormControls.fieldRow(I18n.t("cable.net.ipField"), ipSel, I18n.t("cable.net.ipHint"));
    root.appendChild(ipField);

    const syncKind = () => { const power = kindSel.value === "power"; powerBox.style.display = power ? "" : "none"; ipField.style.display = power ? "none" : ""; };
    kindSel.addEventListener("change", syncKind); syncKind();
    const descI = FormControls.textArea(net ? net.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("cable.common.description"), descI));
    const live = new LiveValidation("networks", { label: labelI, kind: kindSel, power_source: srcSel, ip_network_id: ipSel }, (c, i) => store.get(c, i) || null);
    live.clearOnInput();

    host.openModal({
      title: net ? I18n.t("cable.net.titleEdit") : I18n.t("cable.net.titleNew"),
      subtitle: net ? Html.escape(net.label) : "",
      body: root,
      onSave: async () => {
        const power = kindSel.value === "power";
        const payload = {
          label: labelI.value.trim(), color: color || null, kind: power ? "power" : "data",
          ip_network_id: power ? null : (ipSel.value || null),
          voltage: power && voltI.value !== "" ? Math.max(0, parseInt(voltI.value, 10) || 0) : null,
          max_amp: power && ampI.value !== "" ? Math.max(0, parseInt(ampI.value, 10) || 0) : null,
          power_source: power ? (srcSel.value || null) : null,
          description: descI.value.trim(),
        };
        if (live.check(payload).length) return false;   // label requis (surligné)
        if (net) await store.update("networks", net.id, payload); else await store.create("networks", payload);
        host.setDirty?.(true); Notify.toast(net ? I18n.t("cable.net.updated") : I18n.t("cable.net.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => labelI.focus(), 30);
  }
  static cable(store: Store, host: FormHost, id: string | null, onSaved?: () => void, opts: any = {}): void {
    const cable: any = id ? store.get("cables", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(cable ? cable.name : "", I18n.t("cable.cable.namePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("cable.cable.nameField"), nameI));

    // ---- options d'équipement (contrainte famille + salle) / de port (famille + occupation) ----
    const eqOpts = (fam: string | null, keepEqId: string | null, dcConstraint: any) => {
      let eqs = store.all("equipments").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
      if (fam) eqs = eqs.filter((e: any) => e.id === keepEqId || store.portsOf(e.id).some((p: any) => !store.isBreakoutParent(p) && store.portFamily(p) === fam));
      const allowed = dcConstraint ? (Array.isArray(dcConstraint.dcIds) ? dcConstraint.dcIds.filter(Boolean) : (dcConstraint.dcId ? [dcConstraint.dcId] : null)) : null;
      if (dcConstraint && (allowed || dcConstraint.onlyUnplaced)) {
        eqs = eqs.filter((e: any) => {
          if (e.id === keepEqId) return true;
          const dc = store.equipmentDcId(e);
          if (dcConstraint.onlyUnplaced) return !dc;
          return !dc || !allowed || allowed.includes(dc);
        });
      }
      return [{ value: "", label: I18n.t("cable.cable.pickEquip") }].concat(eqs.map((e: any) => { const dc = store.equipmentDcId(e); return { value: e.id, label: (e.name || I18n.t("lists.ph.noName")) + (dc ? " · " + store.dcName(dc) : "") }; }));
    };
    const portOpts = (eqId: string, selectedPortId: string | null, fam: string | null) => {
      if (!eqId) return [{ value: "", label: I18n.t("cable.cable.pickEquipFirst") }];
      let ports = store.portsOf(eqId).filter((p: any) => !store.isBreakoutParent(p));
      if (fam) ports = ports.filter((p: any) => store.portFamily(p) === fam || p.id === selectedPortId);
      if (!ports.length) return [{ value: "", label: fam ? I18n.t("cable.cable.noCompatPort") : I18n.t("cable.cable.noPortOnEquip") }];
      ports = ports.slice().sort((a: any, b: any) => ((store.cableOnPort(a.id, cable ? cable.id : null) ? 1 : 0) - (store.cableOnPort(b.id, cable ? cable.id : null) ? 1 : 0)) || (a.name || "").localeCompare(b.name || ""));
      return [{ value: "", label: I18n.t("cable.cable.pickPort") }].concat(ports.map((p: any) => {
        const pt: any = store.get("portTypes", p.port_type_id);
        let label = (p.name || I18n.t("cable.cable.port")) + " · " + (pt ? pt.family : I18n.t("cable.cable.unknownType")) + " · " + PortRoles.label(p.role);
        if (p.parent_port_id) { const par: any = store.get("ports", p.parent_port_id); label += I18n.t("cable.cable.laneOf") + (par ? (par.name || I18n.t("cable.cable.trunk")) : I18n.t("cable.cable.trunk")); }
        const occ = store.cableOnPort(p.id, cable ? cable.id : null);
        if (occ) { const otherId = occ.from_port_id === p.id ? occ.to_port_id : occ.from_port_id; const other: any = store.get("ports", otherId); const otherEq: any = other ? store.get("equipments", other.equipment_id) : null; label += I18n.t("cable.cable.occupied") + (other ? ((otherEq ? otherEq.name : "?") + " : " + (other.name || I18n.t("cable.cable.port"))) : "?"); return { value: p.id, label, disabled: true }; }
        return { value: p.id, label };
      }));
    };

    // ---- état initial (édition / pré-remplissage depuis un port — routage 3D) ----
    let eqA = "", eqB = "", preA: string | null = null, preB: string | null = null;
    if (cable) {
      const pa: any = store.get("ports", cable.from_port_id), pb: any = store.get("ports", cable.to_port_id);
      if (pa) eqA = pa.equipment_id; if (pb) eqB = pb.equipment_id;
      // affectation d'un BROUILLON-candidat depuis un port libre → préremplit le bout vide dont la salle imposée accepte le port
      if (opts.assignPortId) {
        const pp: any = store.get("ports", opts.assignPortId);
        if (pp) {
          const missA = !cable.from_port_id, missB = !cable.to_port_id, dcP = store.equipmentDcId(pp.equipment_id);
          const fits = (side: "A" | "B") => { const k = store.cableSideConstraint(cable, side); return k.onlyUnplaced ? !dcP : (!k.dcId || !dcP || k.dcId === dcP); };
          let side: "A" | "B" | null = null;
          if (missA && missB) side = fits("A") ? "A" : (fits("B") ? "B" : "A");
          else if (missA) side = "A"; else if (missB) side = "B";
          if (side === "A") { eqA = pp.equipment_id; preA = opts.assignPortId; }
          else if (side === "B") { eqB = pp.equipment_id; preB = opts.assignPortId; }
        }
      }
    } else if (opts.fromPortId) { const pp: any = store.get("ports", opts.fromPortId); if (pp) { eqA = pp.equipment_id; preA = opts.fromPortId; } }
    else if (opts.fromEqId) { eqA = opts.fromEqId; }
    if (!cable && opts.toPortId) { const pq: any = store.get("ports", opts.toPortId); if (pq) { eqB = pq.equipment_id; preB = opts.toPortId; } }
    const initPortA = cable ? (cable.from_port_id || preA || "") : (preA || "");
    const initPortB = cable ? (cable.to_port_id || preB || "") : (preB || "");

    const selEqA = FormControls.select(eqOpts(null, eqA, null), eqA);
    const selPortA = FormControls.select(portOpts(eqA, initPortA || null, null), initPortA);
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("cable.cable.equipA"), selEqA), FormControls.fieldRow(I18n.t("cable.cable.portA"), selPortA)));
    const selEqB = FormControls.select(eqOpts(null, eqB, null), eqB);
    const selPortB = FormControls.select(portOpts(eqB, initPortB || null, null), initPortB);
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("cable.cable.equipB"), selEqB), FormControls.fieldRow(I18n.t("cable.cable.portB"), selPortB)));

    const selType = FormControls.select([{ value: "", label: I18n.t("cable.common.pickCableType") }], cable ? (cable.cable_type_id || "") : "");
    root.appendChild(FormControls.fieldRow(I18n.t("cable.cable.typeField"), selType, I18n.t("cable.cable.typeHint")));

    const lenI = FormControls.number((cable && cable.length_m != null) ? cable.length_m : "", { min: 0, step: 0.1, placeholder: I18n.t("cable.cable.lenPlaceholder") });
    root.appendChild(FormControls.fieldRow(I18n.t("cable.cable.lenField"), lenI, I18n.t("cable.cable.lenHint")));

    // ---- réseau : DÉDUIT des ports terminaux (le câble ne porte plus de réseau ; source UNIQUE = les ports) ----
    // Lecture seule : on affiche le(s) réseau(x) qui transitent par ce câble, calculés depuis ses 2 ports (et
    // propagés le long du chemin : patchs, brassages). Pour l'assigner : sur le port d'un équipement terminal.
    const netInfo = document.createElement("div"); netInfo.className = "form-hint";
    const renderNets = () => {
      const { ids, primary } = store.deducedNetwork([selPortA.value || null, selPortB.value || null]);
      if (!ids.length) { netInfo.textContent = I18n.t("cable.cable.netNone"); return; }
      const nameOf = (nid: string) => { const n: any = store.get("networks", nid); return n ? (n.label || I18n.t("cable.cable.netFallback")) : nid; };
      // P6 : la couleur suit le PRINCIPAL déterministe (deducedNetwork.primary), PAS « le 1er » de la liste. On nomme
      // le principal réel quand il y a ambiguïté (>1 réseau) — le hint « le 1er pilote la couleur » était périmé/faux.
      const suffix = (ids.length > 1 && primary) ? I18n.t("cable.cable.netPrimary", { name: nameOf(primary) }) : "";
      netInfo.textContent = I18n.t("cable.cable.netDeduced", { list: ids.map(nameOf).join(", "), suffix });
    };
    root.appendChild(FormControls.fieldRow(I18n.t("cable.cable.netField"), netInfo, I18n.t("cable.cable.netFieldHint")));

    // ---- points de passage : waypoints ORDONNÉS A→B (grammaire exit/OOB) ----
    const wpState = { ids: cable ? (cable.waypoint_ids || []).slice() : ((opts.waypointIds || []).slice()) };
    const WP_CAT_ORDER = ["point", "floor", "segment", "brush", "exit"];
    const WP_CAT_LABEL: Record<string, string> = { point: I18n.t("cable.cable.wpCatPoint"), floor: I18n.t("cable.cable.wpCatFloor"), segment: I18n.t("cable.cable.wpCatSegment"), brush: I18n.t("cable.cable.wpCatBrush"), exit: I18n.t("cable.cable.wpCatExit") };
    const wpCatKey = (wp: any) => Waypoint.typeOf(wp) === "exit" ? "exit" : Waypoint.isFloorLevel(wp) ? "floor" : (wp.kind === "segment" ? "segment" : wp.kind === "brush" ? "brush" : "point");
    const wpLabel = (wp: any) => Waypoint.glyph(wp) + " " + (wp.name || I18n.t("cable.common.waypoint")) + " · " + (Waypoint.isFloorLevel(wp) ? Waypoint.floorLabel(wp) : (store.waypointIsPlaced(wp) ? store.dcName(wp.datacenter_id) : I18n.t("cable.common.notPlaced")));
    const wpAll = store.all("waypoints")
      .filter((wp: any) => Waypoint.isFloorLevel(wp) || store.waypointIsPlaced(wp) || wpState.ids.includes(wp.id))
      .sort((a: any, b: any) => { const ta = Waypoint.isFloorLevel(a) ? 1 : 0, tb = Waypoint.isFloorLevel(b) ? 1 : 0; if (ta !== tb) return ta - tb; const da = ta ? Waypoint.floorLabel(a) : store.dcName(a.datacenter_id); const db = tb ? Waypoint.floorLabel(b) : store.dcName(b.datacenter_id); return da.localeCompare(db) || (a.name || "").localeCompare(b.name || ""); });
    const wpRouteHint = document.createElement("div"); wpRouteHint.className = "form-hint";
    const wpBoxes = document.createElement("div"); wpBoxes.style.cssText = "display:flex;flex-direction:column;gap:6px;margin:2px 0;";
    const wpOrderBox = document.createElement("div"); wpOrderBox.style.cssText = "display:flex;flex-direction:column;gap:4px;margin:2px 0;";
    const wpField = FormControls.fieldRow(I18n.t("cable.cable.wpField"), wpBoxes, I18n.t("cable.cable.wpHint"));
    const wpOrderField = FormControls.fieldRow(I18n.t("cable.cable.orderField"), wpOrderBox, I18n.t("cable.cable.orderHint"));

    const syncRoute = () => {
      wpRouteHint.classList.remove("err");
      const r = store.cableRoute({ from_port_id: selPortA.value || null, to_port_id: selPortB.value || null, waypoint_ids: wpState.ids });
      if (!wpState.ids.length) {
        wpRouteHint.textContent = r.valid ? I18n.t("cable.cable.routeNoWp") : I18n.t("cable.cable.routeErrPrefix", { message: r.errors[0].message });
        if (!r.valid) wpRouteHint.classList.add("err");
        return;
      }
      const sum = store.cableRouteSummary(r);
      if (r.valid) wpRouteHint.textContent = I18n.t("cable.cable.routeOk", { summary: sum });
      else { wpRouteHint.textContent = I18n.t("cable.cable.routeErr", { summary: (sum ? sum + " — " : ""), message: r.errors[0].message }); wpRouteHint.classList.add("err"); }
    };
    const syncWpOrder = () => {
      wpOrderBox.innerHTML = "";
      wpOrderField.style.display = wpState.ids.length < 2 ? "none" : "";
      if (wpState.ids.length < 2) return;
      wpState.ids.forEach((wid: string, i: number) => {
        const wp: any = store.get("waypoints", wid); if (!wp) return;
        const row = document.createElement("div"); row.style.cssText = "display:flex;align-items:center;gap:6px;font-size:12px;";
        const num = document.createElement("span"); num.className = "pill"; num.textContent = String(i + 1);
        const tx = document.createElement("span"); tx.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"; tx.textContent = wpLabel(wp);
        const mk = (sym: string, d: number, title: string) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost btn-sm"; b.textContent = sym; b.title = title; b.disabled = (d < 0 && i === 0) || (d > 0 && i === wpState.ids.length - 1); b.onclick = () => { const j = i + d; wpState.ids.splice(i, 1); wpState.ids.splice(j, 0, wid); syncWpOrder(); syncRoute(); refresh(); syncStatus(true); }; return b; };
        row.append(num, tx, mk("↑", -1, I18n.t("cable.cable.moveEarlier")), mk("↓", +1, I18n.t("cable.cable.moveLater")));
        wpOrderBox.appendChild(row);
      });
    };
    const mkWpCheckbox = (wp: any) => {
      const lab = document.createElement("label"); lab.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = wpState.ids.includes(wp.id);
      cb.onchange = () => {
        if (cb.checked) {
          // EXIT TERMINAL : refuse d'ajouter un waypoint de salle après l'exit de cette salle (le câble doit sortir).
          if (store.routeHasRoomBreak({ from_port_id: null, to_port_id: null, waypoint_ids: [...wpState.ids, wp.id] })) { cb.checked = false; Notify.toast(I18n.t("cable.cable.exitTerminalRoom"), "err"); return; }
          if (!wpState.ids.includes(wp.id)) wpState.ids.push(wp.id);
        } else wpState.ids = wpState.ids.filter((x: string) => x !== wp.id);
        syncWpOrder(); syncRoute(); refresh(); syncStatus(true);
      };
      const tx = document.createElement("span"); tx.textContent = wpLabel(wp); lab.append(cb, tx); return lab;
    };
    if (!wpAll.length) { const h = document.createElement("span"); h.className = "form-hint"; h.textContent = I18n.t("cable.cable.noWpUsable"); wpBoxes.appendChild(h); }
    else {
      const byCat: Record<string, any[]> = {}; wpAll.forEach((wp: any) => { const k = wpCatKey(wp); (byCat[k] = byCat[k] || []).push(wp); });
      WP_CAT_ORDER.forEach((k) => {
        const list = byCat[k]; if (!list || !list.length) return;
        const grp = document.createElement("div");
        const hd = document.createElement("div"); hd.className = "form-hint"; hd.style.cssText = "font-weight:600;color:var(--fg);margin:2px 0 1px;"; hd.textContent = WP_CAT_LABEL[k] + " (" + list.length + ")";
        grp.appendChild(hd);
        const row = document.createElement("div"); row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px 14px;";
        list.forEach((wp: any) => row.appendChild(mkWpCheckbox(wp)));
        grp.appendChild(row); wpBoxes.appendChild(grp);
      });
    }
    root.appendChild(wpField); root.appendChild(wpRouteHint); root.appendChild(wpOrderField);

    const statusSel = FormControls.select(CableStatuses.ALL.map((s) => ({ value: s.id, label: I18n.t(s.labelKey) })), cable ? cable.status : CABLE_STATUS_DEFAULT_NEW);
    root.appendChild(FormControls.fieldRow(I18n.t("cable.cable.statusField"), statusSel, I18n.t("cable.cable.statusHint")));
    const descI = FormControls.textArea(cable ? cable.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("cable.common.description"), descI));
    const hint = document.createElement("div"); hint.className = "form-hint"; root.appendChild(hint);

    // ---- contraintes (famille + salle) & cohérence ----
    const familyOf = (portId: string) => store.portFamily(store.get("ports", portId));
    const cableTypeFamily = (ctId: string) => { const ct: any = ctId ? store.get("cableTypes", ctId) : null; return ct ? ct.family : null; };
    const constraintFor = (end: "A" | "B") => { const other = end === "A" ? selPortB.value : selPortA.value; return familyOf(other) || cableTypeFamily(selType.value) || null; };
    const typeFilterFamily = () => familyOf(selPortA.value) || familyOf(selPortB.value) || null;
    const endDcOf = (end: "A" | "B") => { const pid = end === "A" ? selPortA.value : selPortB.value; if (pid) { const p: any = store.get("ports", pid); if (p) return store.equipmentDcId(p.equipment_id); } const eid = end === "A" ? selEqA.value : selEqB.value; return eid ? store.equipmentDcId(eid) : null; };
    const routeRooms = () => { const r = store.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: wpState.ids }); if (!r.valid) return null; if (!r.hasExits) return { intra: true, rooms: [] as string[] }; return { intra: false, rooms: [r.startDc, r.endDc].filter(Boolean) as string[] }; };
    const dcConstraintFor = (end: "A" | "B") => {
      const rr = routeRooms();
      if (!rr) return { dcIds: [] as string[], onlyUnplaced: true };
      const otherRoom = endDcOf(end === "A" ? "B" : "A");
      if (rr.intra) return otherRoom ? { dcIds: [otherRoom], onlyUnplaced: false } : { dcIds: null as any, onlyUnplaced: false };
      let allowed = [...new Set(rr.rooms)];
      if (allowed.length > 1 && otherRoom && allowed.includes(otherRoom)) allowed = allowed.filter((d) => d !== otherRoom);
      return { dcIds: allowed, onlyUnplaced: false };
    };
    const orientEnds = (fromP: string | null, toP: string | null): [string | null, string | null] => {
      const r = store.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: wpState.ids });
      if (!r.valid || !r.hasExits || !r.startDc || !r.endDc || r.startDc === r.endDc) return [fromP, toP];
      const roomOf = (pid: string | null) => { if (!pid) return null; const p: any = store.get("ports", pid); return p ? store.equipmentDcId(p.equipment_id) : null; };
      const rf = roomOf(fromP), rt = roomOf(toP);
      const fromWrong = rf && rf === r.endDc && rf !== r.startDc;
      const toWrong = rt && rt === r.startDc && rt !== r.endDc;
      return (fromWrong || toWrong) ? [toP, fromP] : [fromP, toP];
    };
    const rebuildTypeSelect = () => {
      const fam = typeFilterFamily();
      const kindTarget = store.portKind(store.get("ports", selPortA.value)) || store.portKind(store.get("ports", selPortB.value)) || null;
      const cur = selType.value;
      let list = store.all("cableTypes").slice();
      if (fam) list = list.filter((ct: any) => ct.family === fam);
      else if (kindTarget) list = list.filter((ct: any) => (ct.kind === "power" ? "power" : "data") === kindTarget);
      // tri par FAMILLE puis nom → les <optgroup> (par famille) apparaissent groupés et ordonnés.
      list.sort((a: any, b: any) => (a.family || "").localeCompare(b.family || "") || a.name.localeCompare(b.name));
      if (cur && !list.some((ct: any) => ct.id === cur)) { const c: any = store.get("cableTypes", cur); if (c) list.push(c); }
      let next = cur;
      if (fam) { const cc: any = cur ? store.get("cableTypes", cur) : null; if (!cc || cc.family !== fam) { const f = list.find((ct: any) => ct.family === fam); next = f ? f.id : ""; } }
      // famille portée par l'<optgroup> (regroupement visuel) → le libellé garde juste le nom (+ média si présent).
      FormUi.setOptions(selType, [{ value: "", label: I18n.t("cable.common.pickCableType") }].concat(list.map((ct: any) => ({ value: ct.id, label: ct.name + (ct.medium ? " · " + ct.medium : ""), group: ct.family || I18n.t("cable.common.noFamily") }))), next);
    };
    const refresh = () => {
      rebuildTypeSelect();
      FormUi.setOptions(selEqA, eqOpts(constraintFor("A"), selEqA.value, dcConstraintFor("A")), selEqA.value);
      FormUi.setOptions(selEqB, eqOpts(constraintFor("B"), selEqB.value, dcConstraintFor("B")), selEqB.value);
      const pa = selPortA.value, pb = selPortB.value;
      FormUi.setOptions(selPortA, portOpts(selEqA.value, pa, constraintFor("A")), pa);
      FormUi.setOptions(selPortB, portOpts(selEqB.value, pb, constraintFor("B")), pb);
    };
    const curDraft = () => ({ from_port_id: selPortA.value || null, to_port_id: selPortB.value || null, cable_type_id: selType.value || null, waypoint_ids: wpState.ids });
    const updateHint = (max: string) => {
      hint.classList.remove("warn", "err");
      const a = selPortA.value, b = selPortB.value, fa = familyOf(a), fb = familyOf(b);
      if (a && b && a === b) { hint.textContent = I18n.t("cable.cable.selfLoop"); hint.classList.add("err"); return; }
      if (a && b && fa && fb && fa !== fb) { hint.textContent = I18n.t("cable.cable.famDiffer", { a: fa, b: fb }); hint.classList.add("warn"); return; }
      const r = store.cableRoute(curDraft());
      if (!r.valid) { hint.textContent = I18n.t("cable.cable.routeInvalidDraft", { message: r.errors[0].message }); hint.classList.add("warn"); return; }
      if (max === CABLE_STATUS_DRAFT) { hint.textContent = I18n.t("cable.cable.incompleteDraft"); hint.classList.add("warn"); return; }
      if (max === "planifie") { hint.textContent = I18n.t("cable.cable.unplacedPlanned"); return; }
      hint.textContent = I18n.t("cable.cable.complete", { family: (fa || "?") });
    };
    const syncStatus = (userChange: boolean) => {
      const max = store.cableMaxStatus(curDraft());
      Array.from(statusSel.options).forEach((op) => { op.disabled = !store.cableStatusFits(op.value, max); });
      if (!store.cableStatusFits(statusSel.value, max)) statusSel.value = (max === CABLE_STATUS_DRAFT) ? CABLE_STATUS_DRAFT : CABLE_STATUS_DEFAULT_NEW;
      else if (userChange && statusSel.value === CABLE_STATUS_DRAFT && max !== CABLE_STATUS_DRAFT) statusSel.value = CABLE_STATUS_DEFAULT_NEW;
      updateHint(max);
    };

    selEqA.onchange = () => { FormUi.setOptions(selPortA, portOpts(selEqA.value, null, constraintFor("A"))); refresh(); syncRoute(); syncStatus(false); renderNets(); };
    selEqB.onchange = () => { FormUi.setOptions(selPortB, portOpts(selEqB.value, null, constraintFor("B"))); refresh(); syncRoute(); syncStatus(false); renderNets(); };
    selPortA.onchange = () => { refresh(); syncRoute(); syncStatus(true); renderNets(); };
    selPortB.onchange = () => { refresh(); syncRoute(); syncStatus(true); renderNets(); };
    selType.onchange = () => { refresh(); syncRoute(); syncStatus(true); renderNets(); };

    refresh(); syncWpOrder(); renderNets(); syncRoute(); syncStatus(false);

    // validation live (invariant câble partagé : un port ne se relie pas à lui-même) — surligne le port B.
    const cableLive = new LiveValidation("cables", { from_port_id: selPortA, to_port_id: selPortB, status: statusSel });
    cableLive.clearOnInput();

    host.openModal({
      title: cable ? I18n.t("cable.cable.titleEdit") : I18n.t("cable.cable.titleNew"),
      subtitle: cable ? Html.escape(cable.name || "") : I18n.t("cable.cable.subtitleNew"),
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim();
        if (!name) { Notify.toast(I18n.t("cable.common.nameRequired"), "err"); return false; }
        let fromP = selPortA.value || null, toP = selPortB.value || null;
        const ctId = selType.value || null;
        const wpIds = wpState.ids.slice();
        const lenV0 = parseFloat(String(lenI.value));
        const lenOut = (isFinite(lenV0) && lenV0 >= 0) ? lenV0 : null;
        // self-loop (invariant cable partagé) : surligné directement sur le port B au lieu d'un toast.
        if (cableLive.check({ from_port_id: fromP, to_port_id: toP, status: statusSel.value || "planifie" }).some((e) => e.code === "invariant")) return false;
        if (fromP && store.cableOnPort(fromP, cable ? cable.id : null)) { Notify.toast(I18n.t("cable.cable.portABusy"), "err"); return false; }
        if (toP && store.cableOnPort(toP, cable ? cable.id : null)) { Notify.toast(I18n.t("cable.cable.portBBusy"), "err"); return false; }
        // T9 : un câble d'alimentation relie source↔sink. Deux prises de MÊME sens (source↔source, sink↔sink) sont
        // refusées par le Store (crossEntity T9, HORS live-check faute de `fetch`) → on pré-vérifie ici pour un message
        // clair. Sans ça, le refus reviendrait en `null` au save et serait avalé (défaut #3 / N4). Miroir de
        // DataValidation cables/T9 (source de vérité côté serveur+import).
        if (fromP && toP) {
          const pa: any = store.get("ports", fromP), pb: any = store.get("ports", toP);
          const dirA = pa ? pa.direction : "", dirB = pb ? pb.direction : "";
          if ((dirA === "source" || dirA === "sink") && dirA === dirB) { Notify.toast(I18n.t("cable.cable.powerDir"), "err"); return false; }
        }
        [fromP, toP] = orientEnds(fromP, toP);
        // EXIT TERMINAL & cohérence de route : refuse d'enregistrer une route de waypoints incohérente.
        if (wpIds.length) {
          const bad = store.routeStructuralError({ from_port_id: fromP, to_port_id: toP, waypoint_ids: wpIds });
          if (bad) { Notify.toast(I18n.t("cable.cable.routeInvalid", { message: bad.message }), "err"); return false; }
        }
        const max = store.cableMaxStatus({ from_port_id: fromP, to_port_id: toP, cable_type_id: ctId, waypoint_ids: wpIds });
        let status = statusSel.value;
        if (!CableStatuses.isStatus(status) || !store.cableStatusFits(status, max)) status = (max === CABLE_STATUS_DRAFT) ? CABLE_STATUS_DRAFT : CABLE_STATUS_DEFAULT_NEW;
        else if (status === CABLE_STATUS_DRAFT && max !== CABLE_STATUS_DRAFT) status = CABLE_STATUS_DEFAULT_NEW;
        // réseau NON écrit ici : il est déduit des ports terminaux (source unique). Champs réseau du câble dormants.
        const payload = { name, cable_type_id: ctId, from_port_id: fromP, to_port_id: toP, waypoint_ids: wpIds, length_m: lenOut, status, description: descI.value.trim() };
        // Store.update/create renvoient null si la validation refuse (pas de throw). On GARDE ce retour (N4) : sinon un
        // refus réel (ex. T9 non pré-vérifiable en live) fermerait la modale sur un « Câble mis à jour » mensonger,
        // saisie perdue — exactement le défaut #3.
        if (cable) {
          const saved = await store.update("cables", cable.id, payload);
          if (!saved) { Notify.toast(I18n.t("cable.cable.saveFailed"), "err"); return false; }
        } else {
          const created: any = await store.create("cables", payload);
          if (!created) { Notify.toast(I18n.t("cable.cable.saveFailed"), "err"); return false; }
          if (created.id) opts.onCreated?.(created.id);   // ex. routage : rend le câble tout juste créé visible
        }
        host.setDirty?.(true); Notify.toast(cable ? I18n.t("cable.cable.updated") : (max !== CABLE_STATUS_DRAFT ? I18n.t("cable.cable.created") : I18n.t("cable.cable.draftCreated"))); onSaved?.(); return true;
      },
    });
    setTimeout(() => (cable ? nameI : selEqA).focus(), 30);
  }

  /** Faisceau / trunk : créé À L'AVANCE (nom + type + nb de brins) entre 2 PATCHS. Ses fibres sont piochées
      par les PORTS des patchs d'extrémité ; sa route + sa longueur portent le tracé 2D/3D. */
  static cableBundle(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const bnd: any = id ? store.get("cableBundles", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(bnd ? bnd.name : "", I18n.t("cable.bundle.namePlaceholder"));
    root.appendChild(FormControls.fieldRow(I18n.t("cable.bundle.nameField"), nameI, I18n.t("cable.bundle.nameHint")));
    // 2 EXTRÉMITÉS = PATCH PANELS uniquement (règle partagée T11) : le trunk se rattache à 2 patchs et forme un
    // POOL de brins, piochés ensuite par les ports de ces équipements (cf. formulaire Équipement d'un patch).
    // Le tracé du faisceau peut exister dès que ces 2 extrémités sont posées, même si aucun port ne pioche encore.
    // Un même patch ne porte pas les 2 bouts (T10) → chaque select EXCLUT la sélection de l'autre et se rebâtit
    // quand l'autre change. Une extrémité STOCKÉE non patch (donnée d'avant la règle) reste visible dans SON
    // select (signalée « NON patch ») : la validation partagée refusera l'enregistrement tant qu'elle y est.
    const initEpA = bnd ? (bnd.endpoint_a_equipment_id || "") : "";
    const initEpB = bnd ? (bnd.endpoint_b_equipment_id || "") : "";
    const patchEndpointOpts = (excludeId: string, keepId: string) =>
      [{ value: "", label: I18n.t("cable.bundle.endpointNone") }].concat(
        store.all("equipments")
          .filter((e: any) => (e.type === "patch_panel" || (keepId && e.id === keepId)) && e.id !== excludeId)
          .sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""))
          .map((e: any) => { const dc = store.equipmentDcId(e); return { value: e.id, label: (e.name || I18n.t("cable.bundle.equipment")) + (dc ? " · " + store.dcName(dc) : "") + (e.type === "patch_panel" ? "" : I18n.t("cable.bundle.notPatch")) }; }));
    const epaI = FormControls.select(patchEndpointOpts(initEpB, initEpA), initEpA);
    const epbI = FormControls.select(patchEndpointOpts(initEpA, initEpB), initEpB);
    const refreshEndpointOpts = () => {
      FormUi.setOptions(epaI, patchEndpointOpts(epbI.value, initEpA), epaI.value);
      FormUi.setOptions(epbI, patchEndpointOpts(epaI.value, initEpB), epbI.value);
    };
    epaI.onchange = refreshEndpointOpts; epbI.onchange = refreshEndpointOpts;
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("cable.bundle.endpointAField"), epaI, I18n.t("cable.bundle.endpointAHint")), FormControls.fieldRow(I18n.t("cable.bundle.endpointBField"), epbI, I18n.t("cable.bundle.endpointBHint"))));
    // types de câble GROUPÉS par famille (<optgroup>) : tri famille→nom, la famille passe dans le groupe.
    const typeOpts = [{ value: "", label: I18n.t("cable.common.pickCableType") }].concat(store.all("cableTypes").slice().sort((a: any, b: any) => (a.family || "").localeCompare(b.family || "") || a.name.localeCompare(b.name)).map((ct: any) => ({ value: ct.id, label: ct.name + (ct.medium ? " · " + ct.medium : ""), group: ct.family || I18n.t("cable.common.noFamily") })));
    const typeI = FormControls.select(typeOpts, bnd ? (bnd.cable_type_id || "") : "");
    const fcI = FormControls.number(bnd ? bnd.fiber_count : 12, { min: 1, step: 1 });
    const lenI = FormControls.number((bnd && bnd.length_m != null) ? bnd.length_m : "", { min: 0, step: 0.1, placeholder: I18n.t("cable.bundle.lenPlaceholder") });
    root.appendChild(FormUi.row2(FormControls.fieldRow(I18n.t("cable.bundle.fiberField"), typeI, I18n.t("cable.bundle.fiberHint")), FormControls.fieldRow(I18n.t("cable.bundle.strandField"), fcI, I18n.t("cable.bundle.strandHint")), FormControls.fieldRow(I18n.t("cable.bundle.lenField"), lenI, I18n.t("cable.bundle.lenHint"))));

    // route PARTAGÉE (ordonnée) — picker compact (exits/OOB)
    const wpState = { ids: bnd ? (bnd.waypoint_ids || []).slice() : [] as string[] };
    const wpAll = store.all("waypoints").filter((wp: any) => Waypoint.isFloorLevel(wp) || store.waypointIsPlaced(wp) || wpState.ids.includes(wp.id))
      .sort((a: any, b: any) => ((Waypoint.isFloorLevel(a) ? 1 : 0) - (Waypoint.isFloorLevel(b) ? 1 : 0)) || (a.name || "").localeCompare(b.name || ""));
    const wpBoxes = document.createElement("div"); wpBoxes.style.cssText = "display:flex;flex-wrap:wrap;gap:6px 14px;margin:2px 0;";
    const orderBox = document.createElement("div");
    const wpLab = (wp: any) => Waypoint.glyph(wp) + " " + (wp.name || I18n.t("cable.common.waypoint")) + " · " + (Waypoint.isFloorLevel(wp) ? Waypoint.floorLabel(wp) : (store.waypointIsPlaced(wp) ? store.dcName(wp.datacenter_id) : I18n.t("cable.common.notPlaced")));
    const renderOrder = () => {
      orderBox.innerHTML = "";
      wpState.ids.forEach((wid: string, i: number) => {
        const wp: any = store.get("waypoints", wid); if (!wp) return;
        const r = document.createElement("div"); r.style.cssText = "display:flex;align-items:center;gap:6px;margin:2px 0;font-size:12px;";
        const n = document.createElement("span"); n.className = "pill"; n.textContent = String(i + 1); const tx = document.createElement("span"); tx.className = "grow"; tx.textContent = wpLab(wp);
        const mk = (s: string, d: number) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost btn-sm"; b.textContent = s; b.disabled = (d < 0 && i === 0) || (d > 0 && i === wpState.ids.length - 1); b.onclick = () => { const j = i + d; wpState.ids.splice(i, 1); wpState.ids.splice(j, 0, wid); renderOrder(); }; return b; };
        r.append(n, tx, mk("↑", -1), mk("↓", 1)); orderBox.appendChild(r);
      });
    };
    if (!wpAll.length) { const h = document.createElement("span"); h.className = "form-hint"; h.textContent = I18n.t("cable.bundle.noWpUsable"); wpBoxes.appendChild(h); }
    else wpAll.forEach((wp: any) => {
      const lab = document.createElement("label"); lab.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = wpState.ids.includes(wp.id);
      cb.onchange = () => {
        if (cb.checked) {   // EXIT TERMINAL : refuse un waypoint de salle après l'exit de cette salle
          if (store.routeHasRoomBreak({ from_port_id: null, to_port_id: null, waypoint_ids: [...wpState.ids, wp.id] })) { cb.checked = false; Notify.toast(I18n.t("cable.bundle.exitTerminal"), "err"); return; }
          if (!wpState.ids.includes(wp.id)) wpState.ids.push(wp.id);
        } else wpState.ids = wpState.ids.filter((x: string) => x !== wp.id);
        renderOrder();
      };
      const tx = document.createElement("span"); tx.textContent = wpLab(wp); lab.append(cb, tx); wpBoxes.appendChild(lab);
    });
    root.appendChild(FormControls.fieldRow(I18n.t("cable.bundle.routeField"), wpBoxes, I18n.t("cable.bundle.routeHint")));
    root.appendChild(FormControls.fieldRow(I18n.t("cable.bundle.orderField"), orderBox)); renderOrder();
    const descI = FormControls.textArea(bnd ? bnd.description : "");
    root.appendChild(FormControls.fieldRow(I18n.t("cable.common.description"), descI));
    if (bnd) { const oc = store.bundleOccupancy(bnd.id); const maxStrand = store.maxUsedStrandOfBundle(bnd.id); const info = document.createElement("div"); info.className = "form-hint"; const suffix = maxStrand ? I18n.t("cable.bundle.occupancyReduce", { max: maxStrand }) : I18n.t("cable.bundle.occupancyEnd"); info.textContent = I18n.t("cable.bundle.occupancy", { used: oc.used, capacity: oc.capacity, suffix }); root.appendChild(info); }

    // validation live PARTAGÉE (T10 : A ≠ B · T11 : extrémité = patch panel) — surligne le champ fautif au save.
    // Le `fetch` adossé au Store active la règle cross-entité T11 (lecture du type de l'équipement pointé).
    const bundleLive = new LiveValidation("cableBundles", { endpoint_a_equipment_id: epaI, endpoint_b_equipment_id: epbI }, (coll, entityId) => store.get(coll, entityId) || null);
    bundleLive.clearOnInput();

    host.openModal({
      title: bnd ? I18n.t("cable.bundle.titleEdit") : I18n.t("cable.bundle.titleNew"),
      subtitle: bnd ? Html.escape(bnd.name || "") : I18n.t("cable.bundle.subtitleNew"),
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim(); if (!name) { Notify.toast(I18n.t("cable.common.nameRequired"), "err"); return false; }
        const fc = Math.max(1, parseInt(fcI.value, 10) || 12);
        // Refuser la réduction sous le NUMÉRO MAX de brin pioché (pas le simple compte : un port peut piocher le
        // brin 24 seul → used=1 mais on ne peut pas réduire à 12 sans laisser un brin hors plage).
        if (bnd) { const maxStrand = store.maxUsedStrandOfBundle(bnd.id); if (fc < maxStrand) { Notify.toast(I18n.t("cable.bundle.strandBelow", { fc, max: maxStrand }), "err"); return false; } }
        const lenV = parseFloat(String(lenI.value));
        const payload = { name, cable_type_id: typeI.value || null, fiber_count: fc, waypoint_ids: wpState.ids.slice(), length_m: (isFinite(lenV) && lenV >= 0) ? lenV : null, endpoint_a_equipment_id: epaI.value || null, endpoint_b_equipment_id: epbI.value || null, description: descI.value.trim() };
        // T10/T11 (extrémités) surlignés PAR CHAMP avant d'écrire — même validation que le Store/serveur.
        if (bundleLive.check(payload).length) return false;
        // Store.create/update renvoient null si la validation refuse (pas de throw) : on GARDE ce retour (N4,
        // parité formulaire câble) — sinon la modale se fermerait sur un « Faisceau créé » mensonger, saisie perdue.
        if (bnd) {
          const saved = await store.update("cableBundles", bnd.id, payload);
          if (!saved) { Notify.toast(I18n.t("cable.bundle.saveFailed"), "err"); return false; }
        } else {
          const created: any = await store.create("cableBundles", payload);
          if (!created) { Notify.toast(I18n.t("cable.bundle.saveFailed"), "err"); return false; }
        }
        host.setDirty?.(true); Notify.toast(bnd ? I18n.t("cable.bundle.updated") : I18n.t("cable.bundle.created")); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** Baie (rack) — identité · localisation · cage · dims · side-mount · portes (avant/arrière) ·
      capots (emplacements waypoint toit/sol, tamponnés et appliqués à l.enregistrement). */
}
