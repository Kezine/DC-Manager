import type { Store } from "../../store";
import { FormControls } from "../../ui/FormControls";
import { LiveValidation } from "./LiveValidation";
import { ColorPalette } from "../../ui/ColorPalette";
import { Notify } from "../../ui/Notify";
import { Html } from "../../core/Html";
import { CableStatuses } from "../../domain/CableStatuses";
import { Waypoint } from "../../models/Waypoint";
import { PortRoles } from "../../registries/PortRoles";
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
    const live = new LiveValidation("networks", { label: labelI, kind: kindSel, power_source: srcSel, ip_network_id: ipSel }, (c, i) => store.get(c, i) || null);
    live.clearOnInput();

    host.openModal({
      title: net ? "Modifier le réseau" : "Nouveau réseau",
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
        host.setDirty?.(true); Notify.toast(net ? "Réseau mis à jour" : "Réseau créé"); onSaved?.(); return true;
      },
    });
    setTimeout(() => labelI.focus(), 30);
  }
  static cable(store: Store, host: FormHost, id: string | null, onSaved?: () => void, opts: any = {}): void {
    const cable: any = id ? store.get("cables", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(cable ? cable.name : "", "ex. patch-A12");
    root.appendChild(FormControls.fieldRow("Nom du câble", nameI));

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
      return [{ value: "", label: "— équipement —" }].concat(eqs.map((e: any) => { const dc = store.equipmentDcId(e); return { value: e.id, label: (e.name || "(sans nom)") + (dc ? " · " + store.dcName(dc) : "") }; }));
    };
    const portOpts = (eqId: string, selectedPortId: string | null, fam: string | null) => {
      if (!eqId) return [{ value: "", label: "— choisir un équipement —" }];
      let ports = store.portsOf(eqId).filter((p: any) => !store.isBreakoutParent(p));
      if (fam) ports = ports.filter((p: any) => store.portFamily(p) === fam || p.id === selectedPortId);
      if (!ports.length) return [{ value: "", label: fam ? "(aucun port compatible)" : "(aucun port sur cet équipement)" }];
      ports = ports.slice().sort((a: any, b: any) => ((store.cableOnPort(a.id, cable ? cable.id : null) ? 1 : 0) - (store.cableOnPort(b.id, cable ? cable.id : null) ? 1 : 0)) || (a.name || "").localeCompare(b.name || ""));
      return [{ value: "", label: "— port —" }].concat(ports.map((p: any) => {
        const pt: any = store.get("portTypes", p.port_type_id);
        let label = (p.name || "(port)") + " · " + (pt ? pt.family : "type ?") + " · " + PortRoles.label(p.role);
        if (p.parent_port_id) { const par: any = store.get("ports", p.parent_port_id); label += " · lane de " + (par ? (par.name || "trunk") : "trunk"); }
        const occ = store.cableOnPort(p.id, cable ? cable.id : null);
        if (occ) { const otherId = occ.from_port_id === p.id ? occ.to_port_id : occ.from_port_id; const other: any = store.get("ports", otherId); const otherEq: any = other ? store.get("equipments", other.equipment_id) : null; label += "  — occupé ↔ " + (other ? ((otherEq ? otherEq.name : "?") + " : " + (other.name || "(port)")) : "?"); return { value: p.id, label, disabled: true }; }
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
    root.appendChild(FormUi.row2(FormControls.fieldRow("Équipement A", selEqA), FormControls.fieldRow("Port A", selPortA)));
    const selEqB = FormControls.select(eqOpts(null, eqB, null), eqB);
    const selPortB = FormControls.select(portOpts(eqB, initPortB || null, null), initPortB);
    root.appendChild(FormUi.row2(FormControls.fieldRow("Équipement B", selEqB), FormControls.fieldRow("Port B", selPortB)));

    const selType = FormControls.select([{ value: "", label: "— type de câble —" }], cable ? (cable.cable_type_id || "") : "");
    root.appendChild(FormControls.fieldRow("Type de câble", selType, "Déduit du port choisi ; seuls les types COMPATIBLES sont proposés."));

    const lenI = FormControls.number((cable && cable.length_m != null) ? cable.length_m : "", { min: 0, step: 0.1, placeholder: "ex. 3" });
    root.appendChild(FormControls.fieldRow("Longueur (m)", lenI, "Longueur physique — optionnelle."));

    // ---- réseau : DÉDUIT des ports terminaux (le câble ne porte plus de réseau ; source UNIQUE = les ports) ----
    // Lecture seule : on affiche le(s) réseau(x) qui transitent par ce câble, calculés depuis ses 2 ports (et
    // propagés le long du chemin : patchs, brassages). Pour l'assigner : sur le port d'un équipement terminal.
    const netInfo = document.createElement("div"); netInfo.className = "form-hint";
    const renderNets = () => {
      const { ids, primary } = store.deducedNetwork([selPortA.value || null, selPortB.value || null]);
      if (!ids.length) { netInfo.textContent = "Réseau déduit : aucun — assignez un réseau sur un port d'équipement terminal du chemin."; return; }
      const nameOf = (nid: string) => { const n: any = store.get("networks", nid); return n ? (n.label || "(réseau)") : nid; };
      // P6 : la couleur suit le PRINCIPAL déterministe (deducedNetwork.primary), PAS « le 1er » de la liste. On nomme
      // le principal réel quand il y a ambiguïté (>1 réseau) — le hint « le 1er pilote la couleur » était périmé/faux.
      const suffix = (ids.length > 1 && primary) ? " — principal (couleur) : " + nameOf(primary) : "";
      netInfo.textContent = "Réseau déduit : " + ids.map(nameOf).join(", ") + suffix;
    };
    root.appendChild(FormControls.fieldRow("Réseau", netInfo, "Déduit des ports terminaux (source unique). S'assigne sur les ports, pas sur le câble."));

    // ---- points de passage : waypoints ORDONNÉS A→B (grammaire exit/OOB) ----
    const wpState = { ids: cable ? (cable.waypoint_ids || []).slice() : ((opts.waypointIds || []).slice()) };
    const WP_CAT_ORDER = ["point", "floor", "segment", "brush", "exit"];
    const WP_CAT_LABEL: Record<string, string> = { point: "◆ Pins de salle", floor: "◎ Pins d'étage", segment: "▬ Chemins de câbles", brush: "▦ Brosses de brassage", exit: "⏏ Exits" };
    const wpCatKey = (wp: any) => Waypoint.typeOf(wp) === "exit" ? "exit" : Waypoint.isFloorLevel(wp) ? "floor" : (wp.kind === "segment" ? "segment" : wp.kind === "brush" ? "brush" : "point");
    const wpLabel = (wp: any) => Waypoint.glyph(wp) + " " + (wp.name || "(waypoint)") + " · " + (Waypoint.isFloorLevel(wp) ? Waypoint.floorLabel(wp) : (store.waypointIsPlaced(wp) ? store.dcName(wp.datacenter_id) : "non posé"));
    const wpAll = store.all("waypoints")
      .filter((wp: any) => Waypoint.isFloorLevel(wp) || store.waypointIsPlaced(wp) || wpState.ids.includes(wp.id))
      .sort((a: any, b: any) => { const ta = Waypoint.isFloorLevel(a) ? 1 : 0, tb = Waypoint.isFloorLevel(b) ? 1 : 0; if (ta !== tb) return ta - tb; const da = ta ? Waypoint.floorLabel(a) : store.dcName(a.datacenter_id); const db = tb ? Waypoint.floorLabel(b) : store.dcName(b.datacenter_id); return da.localeCompare(db) || (a.name || "").localeCompare(b.name || ""); });
    const wpRouteHint = document.createElement("div"); wpRouteHint.className = "form-hint";
    const wpBoxes = document.createElement("div"); wpBoxes.style.cssText = "display:flex;flex-direction:column;gap:6px;margin:2px 0;";
    const wpOrderBox = document.createElement("div"); wpOrderBox.style.cssText = "display:flex;flex-direction:column;gap:4px;margin:2px 0;";
    const wpField = FormControls.fieldRow("Points de passage", wpBoxes, "Cochés = ajoutés en fin de trajet. ◆ pin de salle · ▬ chemin · ▦ brosse · ⏏ exit (par paires entre salles) · ◎ pin d'étage (hors salles).");
    const wpOrderField = FormControls.fieldRow("Ordre du trajet (A → B)", wpOrderBox, "Réordonnez les points de passage le long du câble.");

    const syncRoute = () => {
      wpRouteHint.classList.remove("err");
      const r = store.cableRoute({ from_port_id: selPortA.value || null, to_port_id: selPortB.value || null, waypoint_ids: wpState.ids });
      if (!wpState.ids.length) {
        wpRouteHint.textContent = r.valid ? "Aucun point de passage — le câble reste dans sa salle." : "⚠ " + r.errors[0].message + " — pour relier deux salles : ⏏ exit → (◎ pin d'étage…) → ⏏ exit.";
        if (!r.valid) wpRouteHint.classList.add("err");
        return;
      }
      const sum = store.cableRouteSummary(r);
      if (r.valid) wpRouteHint.textContent = "Route : " + sum + " ✓";
      else { wpRouteHint.textContent = "Route : " + (sum ? sum + " — " : "") + "⚠ " + r.errors[0].message; wpRouteHint.classList.add("err"); }
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
        row.append(num, tx, mk("↑", -1, "Plus tôt sur le trajet"), mk("↓", +1, "Plus tard sur le trajet"));
        wpOrderBox.appendChild(row);
      });
    };
    const mkWpCheckbox = (wp: any) => {
      const lab = document.createElement("label"); lab.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = wpState.ids.includes(wp.id);
      cb.onchange = () => {
        if (cb.checked) {
          // EXIT TERMINAL : refuse d'ajouter un waypoint de salle après l'exit de cette salle (le câble doit sortir).
          if (store.routeHasRoomBreak({ from_port_id: null, to_port_id: null, waypoint_ids: [...wpState.ids, wp.id] })) { cb.checked = false; Notify.toast("Un exit est TERMINAL pour sa salle — le câble doit sortir avant tout autre waypoint de salle.", "err"); return; }
          if (!wpState.ids.includes(wp.id)) wpState.ids.push(wp.id);
        } else wpState.ids = wpState.ids.filter((x: string) => x !== wp.id);
        syncWpOrder(); syncRoute(); refresh(); syncStatus(true);
      };
      const tx = document.createElement("span"); tx.textContent = wpLabel(wp); lab.append(cb, tx); return lab;
    };
    if (!wpAll.length) { const h = document.createElement("span"); h.className = "form-hint"; h.textContent = "Aucun waypoint utilisable (vue Datacenter ; un waypoint de salle doit être POSÉ)."; wpBoxes.appendChild(h); }
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

    const statusSel = FormControls.select(CableStatuses.ALL.map((s) => ({ value: s.id, label: s.label })), cable ? cable.status : CABLE_STATUS_DEFAULT_NEW);
    root.appendChild(FormControls.fieldRow("Statut", statusSel, "« Brouillon » tant que l'assignation est incomplète OU la route invalide ; « Câblé » exige les 2 bouts posés."));
    const descI = FormControls.textArea(cable ? cable.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));
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
      FormUi.setOptions(selType, [{ value: "", label: "— type de câble —" }].concat(list.map((ct: any) => ({ value: ct.id, label: ct.name + (ct.medium ? " · " + ct.medium : ""), group: ct.family || "(sans famille)" }))), next);
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
      if (a && b && a === b) { hint.textContent = "Un câble ne peut pas relier un port à lui-même."; hint.classList.add("err"); return; }
      if (a && b && fa && fb && fa !== fb) { hint.textContent = "Familles différentes (« " + fa + " » vs « " + fb + " ») — incompatible : le câble restera un BROUILLON."; hint.classList.add("warn"); return; }
      const r = store.cableRoute(curDraft());
      if (!r.valid) { hint.textContent = "Route invalide (" + r.errors[0].message + ") → enregistré en « Brouillon »."; hint.classList.add("warn"); return; }
      if (max === CABLE_STATUS_DRAFT) { hint.textContent = "Assignation incomplète → « Brouillon ». Renseignez les 2 ports + un type compatible pour le planifier."; hint.classList.add("warn"); return; }
      if (max === "planifie") { hint.textContent = "Équipement(s) non placé(s) → statut maximal « Planifié » ; « Câblé » attendra la pose des deux bouts."; return; }
      hint.textContent = "Assignation complète (« " + (fa || "?") + " ») et route cohérente. Vous pouvez définir le statut.";
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
      title: cable ? "Modifier le câble" : "Nouveau câble",
      subtitle: cable ? Html.escape(cable.name || "") : "Relier deux ports",
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim();
        if (!name) { Notify.toast("Le nom est obligatoire", "err"); return false; }
        let fromP = selPortA.value || null, toP = selPortB.value || null;
        const ctId = selType.value || null;
        const wpIds = wpState.ids.slice();
        const lenV0 = parseFloat(String(lenI.value));
        const lenOut = (isFinite(lenV0) && lenV0 >= 0) ? lenV0 : null;
        // self-loop (invariant cable partagé) : surligné directement sur le port B au lieu d'un toast.
        if (cableLive.check({ from_port_id: fromP, to_port_id: toP, status: statusSel.value || "planifie" }).some((e) => e.code === "invariant")) return false;
        if (fromP && store.cableOnPort(fromP, cable ? cable.id : null)) { Notify.toast("Le port A est déjà relié (1 câble par port)", "err"); return false; }
        if (toP && store.cableOnPort(toP, cable ? cable.id : null)) { Notify.toast("Le port B est déjà relié (1 câble par port)", "err"); return false; }
        // T9 : un câble d'alimentation relie source↔sink. Deux prises de MÊME sens (source↔source, sink↔sink) sont
        // refusées par le Store (crossEntity T9, HORS live-check faute de `fetch`) → on pré-vérifie ici pour un message
        // clair. Sans ça, le refus reviendrait en `null` au save et serait avalé (défaut #3 / N4). Miroir de
        // DataValidation cables/T9 (source de vérité côté serveur+import).
        if (fromP && toP) {
          const pa: any = store.get("ports", fromP), pb: any = store.get("ports", toP);
          const dirA = pa ? pa.direction : "", dirB = pb ? pb.direction : "";
          if ((dirA === "source" || dirA === "sink") && dirA === dirB) { Notify.toast("Un câble d'alimentation relie une source à un sink (pas deux prises de même sens).", "err"); return false; }
        }
        [fromP, toP] = orientEnds(fromP, toP);
        // EXIT TERMINAL & cohérence de route : refuse d'enregistrer une route de waypoints incohérente.
        if (wpIds.length) {
          const bad = store.routeStructuralError({ from_port_id: fromP, to_port_id: toP, waypoint_ids: wpIds });
          if (bad) { Notify.toast("Route invalide : " + bad.message, "err"); return false; }
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
          if (!saved) { Notify.toast("Le câble n'a pas pu être enregistré (voir les erreurs).", "err"); return false; }
        } else {
          const created: any = await store.create("cables", payload);
          if (!created) { Notify.toast("Le câble n'a pas pu être enregistré (voir les erreurs).", "err"); return false; }
          if (created.id) opts.onCreated?.(created.id);   // ex. routage : rend le câble tout juste créé visible
        }
        host.setDirty?.(true); Notify.toast(cable ? "Câble mis à jour" : (max !== CABLE_STATUS_DRAFT ? "Câble créé" : "Brouillon créé")); onSaved?.(); return true;
      },
    });
    setTimeout(() => (cable ? nameI : selEqA).focus(), 30);
  }

  /** Faisceau / trunk : créé À L'AVANCE (nom + type + nb de brins) entre 2 PATCHS. Ses fibres sont piochées
      par les PORTS des patchs d'extrémité ; sa route + sa longueur portent le tracé 2D/3D. */
  static cableBundle(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const bnd: any = id ? store.get("cableBundles", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(bnd ? bnd.name : "", "ex. Trunk 12F OM4 SalleA↔SalleB");
    root.appendChild(FormControls.fieldRow("Nom du faisceau", nameI, "Label porté sur le tracé (les brins l'affichent)."));
    // 2 EXTRÉMITÉS = PATCH PANELS uniquement (règle partagée T11) : le trunk se rattache à 2 patchs et forme un
    // POOL de brins, piochés ensuite par les ports de ces équipements (cf. formulaire Équipement d'un patch).
    // Le tracé du faisceau peut exister dès que ces 2 extrémités sont posées, même si aucun port ne pioche encore.
    // Un même patch ne porte pas les 2 bouts (T10) → chaque select EXCLUT la sélection de l'autre et se rebâtit
    // quand l'autre change. Une extrémité STOCKÉE non patch (donnée d'avant la règle) reste visible dans SON
    // select (signalée « NON patch ») : la validation partagée refusera l'enregistrement tant qu'elle y est.
    const initEpA = bnd ? (bnd.endpoint_a_equipment_id || "") : "";
    const initEpB = bnd ? (bnd.endpoint_b_equipment_id || "") : "";
    const patchEndpointOpts = (excludeId: string, keepId: string) =>
      [{ value: "", label: "— extrémité (patch) —" }].concat(
        store.all("equipments")
          .filter((e: any) => (e.type === "patch_panel" || (keepId && e.id === keepId)) && e.id !== excludeId)
          .sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""))
          .map((e: any) => { const dc = store.equipmentDcId(e); return { value: e.id, label: (e.name || "(équipement)") + (dc ? " · " + store.dcName(dc) : "") + (e.type === "patch_panel" ? "" : " · NON patch !") }; }));
    const epaI = FormControls.select(patchEndpointOpts(initEpB, initEpA), initEpA);
    const epbI = FormControls.select(patchEndpointOpts(initEpA, initEpB), initEpB);
    const refreshEndpointOpts = () => {
      FormUi.setOptions(epaI, patchEndpointOpts(epbI.value, initEpA), epaI.value);
      FormUi.setOptions(epbI, patchEndpointOpts(epaI.value, initEpB), epbI.value);
    };
    epaI.onchange = refreshEndpointOpts; epbI.onchange = refreshEndpointOpts;
    root.appendChild(FormUi.row2(FormControls.fieldRow("Extrémité A (patch)", epaI, "Patch panel où le trunk est terminé."), FormControls.fieldRow("Extrémité B (patch)", epbI, "L'autre patch panel.")));
    // types de câble GROUPÉS par famille (<optgroup>) : tri famille→nom, la famille passe dans le groupe.
    const typeOpts = [{ value: "", label: "— type de câble —" }].concat(store.all("cableTypes").slice().sort((a: any, b: any) => (a.family || "").localeCompare(b.family || "") || a.name.localeCompare(b.name)).map((ct: any) => ({ value: ct.id, label: ct.name + (ct.medium ? " · " + ct.medium : ""), group: ct.family || "(sans famille)" })));
    const typeI = FormControls.select(typeOpts, bnd ? (bnd.cable_type_id || "") : "");
    const fcI = FormControls.number(bnd ? bnd.fiber_count : 12, { min: 1, step: 1 });
    const lenI = FormControls.number((bnd && bnd.length_m != null) ? bnd.length_m : "", { min: 0, step: 0.1, placeholder: "ex. 25" });
    root.appendChild(FormUi.row2(FormControls.fieldRow("Type de fibre", typeI, "Type de câble du trunk (indicatif)."), FormControls.fieldRow("Nombre de brins", fcI, "Capacité (plafond)."), FormControls.fieldRow("Longueur (m)", lenI, "Longueur du trunk.")));

    // route PARTAGÉE (ordonnée) — picker compact (exits/OOB)
    const wpState = { ids: bnd ? (bnd.waypoint_ids || []).slice() : [] as string[] };
    const wpAll = store.all("waypoints").filter((wp: any) => Waypoint.isFloorLevel(wp) || store.waypointIsPlaced(wp) || wpState.ids.includes(wp.id))
      .sort((a: any, b: any) => ((Waypoint.isFloorLevel(a) ? 1 : 0) - (Waypoint.isFloorLevel(b) ? 1 : 0)) || (a.name || "").localeCompare(b.name || ""));
    const wpBoxes = document.createElement("div"); wpBoxes.style.cssText = "display:flex;flex-wrap:wrap;gap:6px 14px;margin:2px 0;";
    const orderBox = document.createElement("div");
    const wpLab = (wp: any) => Waypoint.glyph(wp) + " " + (wp.name || "(waypoint)") + " · " + (Waypoint.isFloorLevel(wp) ? Waypoint.floorLabel(wp) : (store.waypointIsPlaced(wp) ? store.dcName(wp.datacenter_id) : "non posé"));
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
    if (!wpAll.length) { const h = document.createElement("span"); h.className = "form-hint"; h.textContent = "Aucun waypoint utilisable (créez des exits / pins d'étage en vue Datacenter)."; wpBoxes.appendChild(h); }
    else wpAll.forEach((wp: any) => {
      const lab = document.createElement("label"); lab.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = wpState.ids.includes(wp.id);
      cb.onchange = () => {
        if (cb.checked) {   // EXIT TERMINAL : refuse un waypoint de salle après l'exit de cette salle
          if (store.routeHasRoomBreak({ from_port_id: null, to_port_id: null, waypoint_ids: [...wpState.ids, wp.id] })) { cb.checked = false; Notify.toast("Un exit est TERMINAL pour sa salle — le câble doit sortir.", "err"); return; }
          if (!wpState.ids.includes(wp.id)) wpState.ids.push(wp.id);
        } else wpState.ids = wpState.ids.filter((x: string) => x !== wp.id);
        renderOrder();
      };
      const tx = document.createElement("span"); tx.textContent = wpLab(wp); lab.append(cb, tx); wpBoxes.appendChild(lab);
    });
    root.appendChild(FormControls.fieldRow("Route du trunk", wpBoxes, "Exits (par paires) + pins d'étage. Cochés = ajoutés en fin de trajet — porte le tracé 2D/3D."));
    root.appendChild(FormControls.fieldRow("Ordre du trajet", orderBox)); renderOrder();
    const descI = FormControls.textArea(bnd ? bnd.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));
    if (bnd) { const oc = store.bundleOccupancy(bnd.id); const maxStrand = store.maxUsedStrandOfBundle(bnd.id); const info = document.createElement("div"); info.className = "form-hint"; info.textContent = oc.used + " brin(s) pioché(s) (ports de patch) sur " + oc.capacity + (maxStrand ? ". Réduire le nb de brins sous le n° max pioché (" + maxStrand + ") est refusé." : "."); root.appendChild(info); }

    // validation live PARTAGÉE (T10 : A ≠ B · T11 : extrémité = patch panel) — surligne le champ fautif au save.
    // Le `fetch` adossé au Store active la règle cross-entité T11 (lecture du type de l'équipement pointé).
    const bundleLive = new LiveValidation("cableBundles", { endpoint_a_equipment_id: epaI, endpoint_b_equipment_id: epbI }, (coll, entityId) => store.get(coll, entityId) || null);
    bundleLive.clearOnInput();

    host.openModal({
      title: bnd ? "Modifier le faisceau" : "Nouveau faisceau",
      subtitle: bnd ? Html.escape(bnd.name || "") : "Trunk multi-fibres",
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim(); if (!name) { Notify.toast("Le nom est obligatoire", "err"); return false; }
        const fc = Math.max(1, parseInt(fcI.value, 10) || 12);
        // Refuser la réduction sous le NUMÉRO MAX de brin pioché (pas le simple compte : un port peut piocher le
        // brin 24 seul → used=1 mais on ne peut pas réduire à 12 sans laisser un brin hors plage).
        if (bnd) { const maxStrand = store.maxUsedStrandOfBundle(bnd.id); if (fc < maxStrand) { Notify.toast("Nombre de brins (" + fc + ") inférieur au n° de brin le plus élevé pioché (" + maxStrand + ")", "err"); return false; } }
        const lenV = parseFloat(String(lenI.value));
        const payload = { name, cable_type_id: typeI.value || null, fiber_count: fc, waypoint_ids: wpState.ids.slice(), length_m: (isFinite(lenV) && lenV >= 0) ? lenV : null, endpoint_a_equipment_id: epaI.value || null, endpoint_b_equipment_id: epbI.value || null, description: descI.value.trim() };
        // T10/T11 (extrémités) surlignés PAR CHAMP avant d'écrire — même validation que le Store/serveur.
        if (bundleLive.check(payload).length) return false;
        // Store.create/update renvoient null si la validation refuse (pas de throw) : on GARDE ce retour (N4,
        // parité formulaire câble) — sinon la modale se fermerait sur un « Faisceau créé » mensonger, saisie perdue.
        if (bnd) {
          const saved = await store.update("cableBundles", bnd.id, payload);
          if (!saved) { Notify.toast("Le faisceau n'a pas pu être enregistré (voir les erreurs).", "err"); return false; }
        } else {
          const created: any = await store.create("cableBundles", payload);
          if (!created) { Notify.toast("Le faisceau n'a pas pu être enregistré (voir les erreurs).", "err"); return false; }
        }
        host.setDirty?.(true); Notify.toast(bnd ? "Faisceau mis à jour" : "Faisceau créé"); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** Baie (rack) — identité · localisation · cage · dims · side-mount · portes (avant/arrière) ·
      capots (emplacements waypoint toit/sol, tamponnés et appliqués à l.enregistrement). */
}
