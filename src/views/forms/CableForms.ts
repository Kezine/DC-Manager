import type { Store } from "../../store";
import type { ImageStore } from "../../data/ImageStore";
import type { ModalOptions } from "../../ui/Modal";
import { FormControls } from "../../ui/FormControls";
import { LiveValidation } from "./LiveValidation";
import { ColorPalette } from "../../ui/ColorPalette";
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { Html } from "../../core/Html";
import { Text } from "../../core/Text";
import { Color } from "../../core/Color";
import { Format } from "../../core/Format";
import { FloorLayout } from "../../geometry/FloorLayout";
import { Ip } from "../../core/Ip";
import { GroupTypes } from "../../domain/GroupTypes";
import { CableStatuses } from "../../domain/CableStatuses";
import { SpareTypes } from "../../domain/SpareTypes";
import { SpareStatuses } from "../../domain/SpareStatuses";
import { Waypoint } from "../../models/Waypoint";
import { EquipmentTypes } from "../../registries/EquipmentTypes";
import { Depths } from "../../registries/Depths";
import { PortRoles } from "../../registries/PortRoles";
import { PortTypes } from "../../registries/PortTypes";
import { EquipFaces } from "../../registries/EquipFaces";
import { Id } from "../../core/Id";
import { RackGeometry } from "../../geometry/RackGeometry";
import { RackScene } from "../../geometry/RackScene";
import { RackItemKinds } from "../../domain/RackItemKinds";
import { Normalize } from "../../core/Normalize";
import {
  POWER_SOURCES, EQUIPMENT_TYPE_DEFAULT, LOCATIONS, FLOORS, RACK_SIDES, RACK_FACES, RACK_DEPTHS,
  RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_MOUNT_MARGIN_DEFAULT, U_MM, SIDE_U_STEP,
  BREAKOUT_SPANS, CABLE_STATUS_DRAFT, CABLE_STATUS_DEFAULT_NEW,
  EQUIP_FACE_IDS, EQUIP_FACE_IMG_FIELD, EQUIP_FREE_DEFAULT_MM,
  WAYPOINT_TYPES, OOB_HEIGHT_DEFAULT, WAYPOINT_Z_DEFAULT, CONDUIT_W_DEFAULT, CONDUIT_H_DEFAULT, BRUSH_PADDING_MM,
  FLOOR_WIDTH_DEFAULT, FLOOR_DEPTH_DEFAULT, FLOOR_CELL_DEFAULT,
  SPARE_DISK_TYPES, SPARE_CAP_UNITS, SPARE_HDD_INTERFACES, SPARE_HDD_FORMATS, SPARE_HDD_RPM,
  SPARE_TX_FORMS, SPARE_TX_SPEEDS, SPARE_TX_MEDIA,
} from "../../domain/constants";
import { row2, divider, locOptions, floorOptions, setOptions, ipNetOptions, eqOptions, WAYPOINT_KIND_LABELS } from "./shared";
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
    root.appendChild(row2(FormControls.fieldRow("Équipement A", selEqA), FormControls.fieldRow("Port A", selPortA)));
    const selEqB = FormControls.select(eqOpts(null, eqB, null), eqB);
    const selPortB = FormControls.select(portOpts(eqB, initPortB || null, null), initPortB);
    root.appendChild(row2(FormControls.fieldRow("Équipement B", selEqB), FormControls.fieldRow("Port B", selPortB)));

    const selType = FormControls.select([{ value: "", label: "— type de câble —" }], cable ? (cable.cable_type_id || "") : "");
    root.appendChild(FormControls.fieldRow("Type de câble", selType, "Déduit du port choisi ; seuls les types COMPATIBLES sont proposés."));

    // ---- faisceau (trunk) : associer = faire un BRIN (type/route/longueur HÉRITÉS) ----
    const bundles = store.all("cableBundles").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    const bundleSel = FormControls.select([{ value: "", label: "— aucun (câble autonome) —" }].concat(bundles.map((b: any) => { const occ = store.bundleOccupancy(b.id); const ct: any = b.cable_type_id ? store.get("cableTypes", b.cable_type_id) : null; return { value: b.id, label: (b.name || "(trunk)") + " · " + (ct ? ct.name : "type ?") + " · " + occ.used + "/" + b.fiber_count }; })), cable ? (cable.bundle_id || "") : (opts.bundleId || ""));
    const bundleField = FormControls.fieldRow("Faisceau (trunk)", bundleSel, "Associer = en faire un BRIN : TYPE imposé par le trunk, route et longueur partagées.");
    if (!bundles.length) bundleField.style.display = "none";
    root.appendChild(bundleField);
    const bundleHint = document.createElement("div"); bundleHint.className = "form-hint"; root.appendChild(bundleHint);

    const lenI = FormControls.number((cable && cable.length_m != null) ? cable.length_m : "", { min: 0, step: 0.1, placeholder: "ex. 3" });
    root.appendChild(FormControls.fieldRow("Longueur (m)", lenI, "Longueur physique — optionnelle."));

    // ---- réseaux multiples + principal ----
    const netState = { ids: new Set<string>(store.cableNetworkIds(cable)), primary: cable ? (cable.network_id || null) : null as string | null };
    const netBoxes = document.createElement("div"); netBoxes.style.cssText = "display:flex;flex-wrap:wrap;gap:6px 14px;margin:2px 0;";
    const primSel = FormControls.select([{ value: "", label: "— aucun —" }], "");
    const primField = FormControls.fieldRow("Réseau principal", primSel, "Pilote la COULEUR du câble (≥ 2 réseaux).");
    const selectedBundle = () => bundleSel.value ? store.get("cableBundles", bundleSel.value) : null;
    const formTypeId = () => { const b: any = selectedBundle(); return b ? (b.cable_type_id || null) : (selType.value || null); };
    const cableKind = () => { const id2 = formTypeId(); const t: any = id2 ? store.get("cableTypes", id2) : null; return t ? (t.kind === "power" ? "power" : "data") : null; };
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
      const r = store.cableRoute({ from_port_id: selPortA.value || null, to_port_id: selPortB.value || null, waypoint_ids: wpState.ids, bundle_id: bundleSel.value || null });
      if (!wpState.ids.length && !bundleSel.value) {
        wpRouteHint.textContent = r.valid ? "Aucun point de passage — le câble reste dans sa salle." : "⚠ " + r.errors[0] + " — pour relier deux salles : ⏏ exit → (◎ pin d'étage…) → ⏏ exit.";
        if (!r.valid) wpRouteHint.classList.add("err");
        return;
      }
      const sum = store.cableRouteSummary(r);
      if (r.valid) wpRouteHint.textContent = "Route : " + sum + " ✓";
      else { wpRouteHint.textContent = "Route : " + (sum ? sum + " — " : "") + "⚠ " + r.errors[0]; wpRouteHint.classList.add("err"); }
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
          const bad = store.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: [...wpState.ids, wp.id] }).errors.find((e: string) =>
            e.includes("au milieu d'un tronçon hors salle") || e.includes("ré-entrée dans la salle quittée")
            || e.includes("dans une autre salle que le segment courant") || e.includes("la sortie doit être un exit de la salle courante"));
          if (bad) { cb.checked = false; Notify.toast("Un exit est TERMINAL pour sa salle — le câble doit sortir avant tout autre waypoint de salle.", "err"); return; }
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
    const routeRooms = () => { const r = store.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: wpState.ids, bundle_id: bundleSel.value || null }); if (!r.valid) return null; if (!r.hasExits) return { intra: true, rooms: [] as string[] }; return { intra: false, rooms: [r.startDc, r.endDc].filter(Boolean) as string[] }; };
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
      const r = store.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: bundleSel.value ? [] : wpState.ids, bundle_id: bundleSel.value || null });
      if (!r.valid || !r.hasExits || !r.startDc || !r.endDc || r.startDc === r.endDc) return [fromP, toP];
      const roomOf = (pid: string | null) => { if (!pid) return null; const p: any = store.get("ports", pid); return p ? store.equipmentDcId(p.equipment_id) : null; };
      const rf = roomOf(fromP), rt = roomOf(toP);
      const fromWrong = rf && rf === r.endDc && rf !== r.startDc;
      const toWrong = rt && rt === r.startDc && rt !== r.endDc;
      return (fromWrong || toWrong) ? [toP, fromP] : [fromP, toP];
    };
    const rebuildTypeSelect = () => {
      const bnd: any = selectedBundle();
      if (bnd) { const ct: any = bnd.cable_type_id ? store.get("cableTypes", bnd.cable_type_id) : null; setOptions(selType, [{ value: bnd.cable_type_id || "", label: ct ? (ct.name + " · " + ct.family) : "(type du faisceau ?)" }], bnd.cable_type_id || ""); selType.disabled = true; selType.style.opacity = "0.7"; return; }
      selType.disabled = false; selType.style.opacity = "";
      const fam = typeFilterFamily();
      const kindTarget = store.portKind(store.get("ports", selPortA.value)) || store.portKind(store.get("ports", selPortB.value)) || null;
      const cur = selType.value;
      let list = store.all("cableTypes").slice();
      if (fam) list = list.filter((ct: any) => ct.family === fam);
      else if (kindTarget) list = list.filter((ct: any) => (ct.kind === "power" ? "power" : "data") === kindTarget);
      list.sort((a: any, b: any) => a.name.localeCompare(b.name));
      if (cur && !list.some((ct: any) => ct.id === cur)) { const c: any = store.get("cableTypes", cur); if (c) list.push(c); }
      let next = cur;
      if (fam) { const cc: any = cur ? store.get("cableTypes", cur) : null; if (!cc || cc.family !== fam) { const f = list.find((ct: any) => ct.family === fam); next = f ? f.id : ""; } }
      setOptions(selType, [{ value: "", label: "— type de câble —" }].concat(list.map((ct: any) => ({ value: ct.id, label: ct.name + " · " + ct.family }))), next);
    };
    const refresh = () => {
      rebuildTypeSelect();
      setOptions(selEqA, eqOpts(constraintFor("A"), selEqA.value, dcConstraintFor("A")), selEqA.value);
      setOptions(selEqB, eqOpts(constraintFor("B"), selEqB.value, dcConstraintFor("B")), selEqB.value);
      const pa = selPortA.value, pb = selPortB.value;
      setOptions(selPortA, portOpts(selEqA.value, pa, constraintFor("A")), pa);
      setOptions(selPortB, portOpts(selEqB.value, pb, constraintFor("B")), pb);
    };
    const syncBundleUI = () => {
      const bnd: any = selectedBundle();
      if (bnd) {
        wpField.style.display = "none"; wpRouteHint.style.display = "none"; wpOrderField.style.display = "none";
        lenI.disabled = true; lenI.style.opacity = "0.7"; lenI.value = (bnd.length_m != null) ? bnd.length_m : ""; lenI.placeholder = "(longueur du faisceau)";
        const occ = store.bundleOccupancy(bnd.id); const free = occ.free + ((cable && cable.bundle_id === bnd.id) ? 1 : 0);
        bundleHint.innerHTML = "Brin du faisceau <b>« " + Html.escape(bnd.name || "(trunk)") + " »</b> — type, route et longueur HÉRITÉS. Occupation " + occ.used + "/" + bnd.fiber_count + (free <= 0 ? " · <span style=\"color:var(--err)\">COMPLET</span>" : "") + ".";
      } else {
        wpField.style.display = ""; wpRouteHint.style.display = ""; syncWpOrder();
        lenI.disabled = false; lenI.style.opacity = ""; lenI.placeholder = "ex. 3"; bundleHint.textContent = "";
      }
    };
    const curDraft = () => ({ from_port_id: selPortA.value || null, to_port_id: selPortB.value || null, cable_type_id: selType.value || null, waypoint_ids: wpState.ids, bundle_id: bundleSel.value || null });
    const updateHint = (max: string) => {
      hint.classList.remove("warn", "err");
      const a = selPortA.value, b = selPortB.value, fa = familyOf(a), fb = familyOf(b);
      if (a && b && a === b) { hint.textContent = "Un câble ne peut pas relier un port à lui-même."; hint.classList.add("err"); return; }
      if (a && b && fa && fb && fa !== fb) { hint.textContent = "Familles différentes (« " + fa + " » vs « " + fb + " ») — incompatible : le câble restera un BROUILLON."; hint.classList.add("warn"); return; }
      const r = store.cableRoute(curDraft());
      if (!r.valid) { hint.textContent = "Route invalide (" + r.errors[0] + ") → enregistré en « Brouillon »."; hint.classList.add("warn"); return; }
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

    bundleSel.onchange = () => { syncBundleUI(); refresh(); syncRoute(); syncStatus(true); renderNets(); };
    selEqA.onchange = () => { setOptions(selPortA, portOpts(selEqA.value, null, constraintFor("A"))); refresh(); syncRoute(); syncStatus(false); renderNets(); };
    selEqB.onchange = () => { setOptions(selPortB, portOpts(selEqB.value, null, constraintFor("B"))); refresh(); syncRoute(); syncStatus(false); renderNets(); };
    selPortA.onchange = () => { refresh(); syncRoute(); syncStatus(true); renderNets(); };
    selPortB.onchange = () => { refresh(); syncRoute(); syncStatus(true); renderNets(); };
    selType.onchange = () => { refresh(); syncRoute(); syncStatus(true); renderNets(); };

    refresh(); syncBundleUI(); renderNets(); syncPrimary(); syncRoute(); syncStatus(false);

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
        const bnd: any = selectedBundle();
        const ctId = bnd ? (bnd.cable_type_id || null) : (selType.value || null);
        const wpIds = bnd ? [] : wpState.ids.slice();
        const lenV0 = parseFloat(String(lenI.value));
        const lenOut = bnd ? null : ((isFinite(lenV0) && lenV0 >= 0) ? lenV0 : null);
        let strandNo: number | null = null;
        if (bnd) {
          const occ = store.bundleOccupancy(bnd.id);
          const reuse = !!(cable && cable.bundle_id === bnd.id && cable.strand_no != null);
          if (!reuse && occ.free <= 0) { Notify.toast("Faisceau « " + (bnd.name || "trunk") + " » COMPLET (" + occ.used + "/" + bnd.fiber_count + ")", "err"); return false; }
          strandNo = reuse ? cable.strand_no : occ.nextStrand;
        }
        // self-loop (invariant cable partagé) : surligné directement sur le port B au lieu d'un toast.
        if (cableLive.check({ from_port_id: fromP, to_port_id: toP, status: statusSel.value || "planifie" }).some((e) => e.code === "invariant")) return false;
        if (fromP && store.cableOnPort(fromP, cable ? cable.id : null)) { Notify.toast("Le port A est déjà relié (1 câble par port)", "err"); return false; }
        if (toP && store.cableOnPort(toP, cable ? cable.id : null)) { Notify.toast("Le port B est déjà relié (1 câble par port)", "err"); return false; }
        [fromP, toP] = orientEnds(fromP, toP);
        // EXIT TERMINAL & cohérence de route : refuse d'enregistrer une route de waypoints incohérente.
        if (wpIds.length) {
          const bad = store.cableRoute({ from_port_id: fromP, to_port_id: toP, waypoint_ids: wpIds, bundle_id: bnd ? bnd.id : null }).errors.find((e: string) =>
            e.includes("au milieu d'un tronçon hors salle") || e.includes("ré-entrée dans la salle quittée")
            || e.includes("dans une autre salle que le segment courant") || e.includes("la sortie doit être un exit de la salle courante")
            || e.includes("doit être ENTRE deux exits") || e.includes("exit non appairé"));
          if (bad) { Notify.toast("Route invalide : " + bad, "err"); return false; }
        }
        const max = store.cableMaxStatus({ from_port_id: fromP, to_port_id: toP, cable_type_id: ctId, waypoint_ids: wpIds, bundle_id: bnd ? bnd.id : null });
        let status = statusSel.value;
        if (!CableStatuses.isStatus(status) || !store.cableStatusFits(status, max)) status = (max === CABLE_STATUS_DRAFT) ? CABLE_STATUS_DRAFT : CABLE_STATUS_DEFAULT_NEW;
        else if (status === CABLE_STATUS_DRAFT && max !== CABLE_STATUS_DRAFT) status = CABLE_STATUS_DEFAULT_NEW;
        const ck = ctId ? (((store.get("cableTypes", ctId) || {}).kind === "power") ? "power" : "data") : null;
        const network_ids = [...netState.ids].filter((nid) => { if (ck == null) return true; const n: any = store.get("networks", nid); return !n || ((n.kind === "power" ? "power" : "data") === ck); });
        let primary = netState.primary; if (primary && !network_ids.includes(primary)) primary = null; if (!primary && network_ids.length) primary = network_ids[0];
        const payload = { name, cable_type_id: ctId, from_port_id: fromP, to_port_id: toP, network_ids, network_id: primary, waypoint_ids: wpIds, length_m: lenOut, bundle_id: bnd ? bnd.id : null, strand_no: strandNo, status, description: descI.value.trim() };
        if (cable) await store.update("cables", cable.id, payload); else await store.create("cables", payload);
        host.setDirty?.(true); Notify.toast(cable ? "Câble mis à jour" : (bnd ? "Brin créé (faisceau « " + (bnd.name || "trunk") + " »)" : (max !== CABLE_STATUS_DRAFT ? "Câble créé" : "Brouillon créé"))); onSaved?.(); return true;
      },
    });
    setTimeout(() => (cable ? nameI : selEqA).focus(), 30);
  }

  /** Faisceau / trunk : créé À L'AVANCE (nom + type + nb de brins). Le type VERROUILLE le type des
      brins ; route + longueur PARTAGÉES par les brins. */
  static cableBundle(store: Store, host: FormHost, id: string | null, onSaved?: () => void): void {
    const bnd: any = id ? store.get("cableBundles", id) : null;
    const root = document.createElement("div");
    const nameI = FormControls.text(bnd ? bnd.name : "", "ex. Trunk 12F OM4 SalleA↔SalleB");
    root.appendChild(FormControls.fieldRow("Nom du faisceau", nameI, "Label porté sur le tracé (les brins l'affichent)."));
    const typeOpts = [{ value: "", label: "— type de câble —" }].concat(store.all("cableTypes").slice().sort((a: any, b: any) => a.name.localeCompare(b.name)).map((ct: any) => ({ value: ct.id, label: ct.name + " · " + ct.family })));
    const typeI = FormControls.select(typeOpts, bnd ? (bnd.cable_type_id || "") : "");
    const fcI = FormControls.number(bnd ? bnd.fiber_count : 12, { min: 1, step: 1 });
    const lenI = FormControls.number((bnd && bnd.length_m != null) ? bnd.length_m : "", { min: 0, step: 0.1, placeholder: "ex. 25" });
    root.appendChild(row2(FormControls.fieldRow("Type (verrouille les brins)", typeI, "Impose le type des câbles associés."), FormControls.fieldRow("Nombre de brins", fcI, "Capacité (plafond)."), FormControls.fieldRow("Longueur (m)", lenI, "Partagée par les brins.")));

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
          const bad = store.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: [...wpState.ids, wp.id] }).errors.find((e: string) =>
            e.includes("au milieu d'un tronçon hors salle") || e.includes("ré-entrée dans la salle quittée")
            || e.includes("dans une autre salle que le segment courant") || e.includes("la sortie doit être un exit de la salle courante"));
          if (bad) { cb.checked = false; Notify.toast("Un exit est TERMINAL pour sa salle — le câble doit sortir.", "err"); return; }
          if (!wpState.ids.includes(wp.id)) wpState.ids.push(wp.id);
        } else wpState.ids = wpState.ids.filter((x: string) => x !== wp.id);
        renderOrder();
      };
      const tx = document.createElement("span"); tx.textContent = wpLab(wp); lab.append(cb, tx); wpBoxes.appendChild(lab);
    });
    root.appendChild(FormControls.fieldRow("Route (partagée par les brins)", wpBoxes, "Exits (par paires) + pins d'étage. Cochés = ajoutés en fin de trajet."));
    root.appendChild(FormControls.fieldRow("Ordre du trajet", orderBox)); renderOrder();
    const descI = FormControls.textArea(bnd ? bnd.description : "");
    root.appendChild(FormControls.fieldRow("Description", descI));
    if (bnd) { const oc = store.bundleOccupancy(bnd.id); const info = document.createElement("div"); info.className = "form-hint"; info.textContent = oc.used + " brin(s) câblé(s) sur " + oc.capacity + ". Réduire le nb de brins sous " + oc.used + " est refusé."; root.appendChild(info); }

    host.openModal({
      title: bnd ? "Modifier le faisceau" : "Nouveau faisceau",
      subtitle: bnd ? Html.escape(bnd.name || "") : "Trunk multi-fibres",
      body: root, wide: true,
      onSave: async () => {
        const name = nameI.value.trim(); if (!name) { Notify.toast("Le nom est obligatoire", "err"); return false; }
        const fc = Math.max(1, parseInt(fcI.value, 10) || 12);
        if (bnd) { const oc = store.bundleOccupancy(bnd.id); if (fc < oc.used) { Notify.toast("Nombre de brins (" + fc + ") inférieur aux " + oc.used + " brins déjà câblés", "err"); return false; } }
        const lenV = parseFloat(String(lenI.value));
        const payload = { name, cable_type_id: typeI.value || null, fiber_count: fc, waypoint_ids: wpState.ids.slice(), length_m: (isFinite(lenV) && lenV >= 0) ? lenV : null, description: descI.value.trim() };
        let bid: string;
        if (bnd) { await store.update("cableBundles", bnd.id, payload); bid = bnd.id; } else { const c: any = await store.create("cableBundles", payload); bid = c.id; }
        // les brins STOCKENT le type du trunk → resynchroniser quand le type change
        const ops = store.strandsOfBundle(bid).filter((s: any) => s.cable_type_id !== payload.cable_type_id).map((s: any) => ({ collection: "cables", id: s.id, patch: { cable_type_id: payload.cable_type_id } }));
        if (ops.length) await store.updateBatch(ops);
        host.setDirty?.(true); Notify.toast(bnd ? "Faisceau mis à jour" : "Faisceau créé"); onSaved?.(); return true;
      },
    });
    setTimeout(() => nameI.focus(), 30);
  }

  /** Baie (rack) — identité · localisation · cage · dims · side-mount · portes (avant/arrière) ·
      capots (emplacements waypoint toit/sol, sauvegarde immédiate sur un rack existant). */
}
