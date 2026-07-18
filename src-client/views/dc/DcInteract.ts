import { Dom } from "../../ui/Dom";
import { FormControls } from "../../ui/FormControls";
import { Dialog } from "../../ui/Dialog";
import { Notify } from "../../ui/Notify";
import { ContextMenu } from "../../ui/ContextMenu";
import type { CtxSection } from "../../ui/ContextMenu";
import { Html } from "../../core/Html";
import { Normalize } from "../../core/Normalize";
import { RackGeometry } from "../../geometry/RackGeometry";
import { FreeEquipGeometry } from "../../geometry/FreeEquipGeometry";
import { FloorLayout } from "../../geometry/FloorLayout";
import { GridGeometry } from "../../geometry/GridGeometry";
import type { Frame } from "../../geometry/Positioning";
import type { PosEntry, PosScene } from "./PositioningTool";
import { Depths } from "../../registries/Depths";
import { EquipmentTypes } from "../../registries/EquipmentTypes";
import { RackItemKinds } from "../../domain/RackItemKinds";
import { Format } from "../../core/Format";
import { Waypoint } from "../../models/Waypoint";
import { CableStatuses } from "../../domain/CableStatuses";
import { PlacementLock } from "../../domain/PlacementLock";
import { RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, U_MM, TRAY_SHEET_RESERVE_MM } from "../../domain/constants";
import { I18n } from "../../i18n/I18n";
import type { Vec3 } from "./shared";
import { DcPanels } from "./DcPanels";

export abstract class DcInteract extends DcPanels {

  protected showCote(text: string, clientX: number, clientY: number): void {
    if (!this.coteEl) { this.coteEl = document.createElement("div"); this.coteEl.className = "dc-cote"; this.stage.appendChild(this.coteEl); }
    this.coteEl.textContent = text; this.coteEl.style.display = "block";
    const r = this.stage.getBoundingClientRect(), z = this.uiZoom();   // /z : repère local zoomé du stage (cf. uiZoom)
    this.coteEl.style.left = ((clientX - r.left + 14) / z) + "px"; this.coteEl.style.top = ((clientY - r.top + 14) / z) + "px";
  }

  protected hideCote(): void { if (this.coteEl) this.coteEl.style.display = "none"; }


  /* ---- tooltips enrichis de scène (réplique de _showTip/_moveTip/_hideTip + builders HTML) ---- */
  protected showTip(html: string, ev: MouseEvent): void {
    // html VIDE = plus rien à décrire (ex. entité supprimée entre le rendu et le survol) : ne pas afficher une
    // bulle vide — parité avec le chemin WebGL (DcBase.webglTip) qui garde déjà `if (!html)`.
    if (!html) { this.hideTip(); return; }
    if (!this.ttEl || !this.ttEl.isConnected) { this.ttEl = document.createElement("div"); this.ttEl.className = "dc-tooltip"; this.stage.appendChild(this.ttEl); }
    this.ttEl.innerHTML = html; this.ttEl.style.display = "block"; this.moveTip(ev);
  }

  /** Facteur de zoom CSS effectif de l'interface (`#app { zoom: var(--ui-scale) }`, réglage « Taille du texte »).
      `clientX`/`getBoundingClientRect()` sont en px ÉCRAN (post-zoom) ; les overlays positionnés DANS le stage le
      sont dans son repère LOCAL (zoomé) → il faut diviser par ce facteur, sinon décalage proportionnel au zoom. */
  protected uiZoom(): number { const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")); return (z && z > 0) ? z : 1; }

  protected moveTip(ev: MouseEvent): void {
    if (!this.ttEl) return;
    const host = this.stage.getBoundingClientRect(), z = this.uiZoom();
    const tt = this.ttEl.getBoundingClientRect();   // taille VISUELLE (déjà zoomée) → cohérente avec host
    let vx = (ev.clientX - host.left) + 14, vy = (ev.clientY - host.top) + 14;   // décalage VISUEL dans le stage
    if (vx + tt.width > host.width) vx = (ev.clientX - host.left) - tt.width - 14;
    if (vy + tt.height > host.height) vy = host.height - tt.height - 6;
    this.ttEl.style.left = Math.max(4, vx / z) + "px"; this.ttEl.style.top = Math.max(4, vy / z) + "px";   // → repère local
  }

  protected hideTip(): void { if (this.ttEl) this.ttEl.style.display = "none"; }

  /** Attache un tooltip enrichi (HTML construit à la volée) à un nœud de scène. */
  protected wireTip(node: SVGElement, htmlFn: () => string): void {
    node.addEventListener("mouseenter", (e: any) => this.showTip(htmlFn(), e));
    node.addEventListener("mousemove", (e: any) => this.moveTip(e));
    node.addEventListener("mouseleave", () => this.hideTip());
  }

  protected tipRow(html: string): string { return `<div class="tt-row">${html}</div>`; }

  protected tipSwatch(color: string): string { return `<span class="tt-sw" style="background:${Html.escape(color || "#888")}"></span>`; }

  /** Tooltip d'une baie (dimensions, U, orientation, occupation). */
  protected rackTipHtml(r: any): string {
    const w = r.width_mm || RACK_WIDTH_DEFAULT, d = r.depth || RACK_DEPTH_DEFAULT, uMax = r.u_count || 42;
    const occs = this.scene.occupantsElev(r.id);
    const eqCount = occs.filter((o: any) => o.kind === "eq").length, itemCount = occs.filter((o: any) => o.kind === "item").length;
    const usedU = new Set<string>(); this.scene.occupants(r.id).forEach((_v: any, k: string) => usedU.add(k.split(":")[0]));
    const rows = [
      this.tipRow(`<b>${w} × ${d} mm</b> · ${uMax} U · ${r.sides === "dual" ? I18n.t("dc.interact.doubleFace") : I18n.t("dc.interact.singleFace")}`),
      this.tipRow(Html.escape(I18n.t("dc.interact.orientation", { deg: Normalize.rackOrientation(r.orientation) })) + `${r.row ? Html.escape(I18n.t("dc.interact.rowSuffix", { row: r.row })) : ""}`),
      this.tipRow(`<b>${eqCount}</b> ${I18n.t("dc.interact.equipWord", { count: eqCount })}${itemCount ? " · " + I18n.t("dc.interact.itemCount", { count: itemCount }) : ""} · ${I18n.t("dc.interact.uOccupied", { used: usedU.size, max: uMax })}`),
      this.tipRow(`<span style="color:var(--accent)">${I18n.t("dc.interact.clickEditRack")}</span>`),
    ];
    return `<div class="tt-title">${Html.escape(r.name || I18n.t("lists.ph.rack"))}</div>` + rows.join("");
  }

  /** Tooltip d'un équipement (type, marque/modèle, série, baie, groupe, nb de ports). */
  protected equipmentTipHtml(eqId: string): string {
    const e: any = this.store.get("equipments", eqId); if (!e) return "";
    const rk: any = e.rack_id ? this.store.get("racks", e.rack_id) : null;
    const nPorts = this.store.portsOf(e.id).length;
    const rows = [this.tipRow(`<b>${Html.escape(EquipmentTypes.label(e.type))}</b>${e.brand || e.model ? " · " + Html.escape([e.brand, e.model].filter(Boolean).join(" ")) : ""}`)];
    if (e.serial) rows.push(this.tipRow(`${Html.escape(I18n.t("dc.interact.serialPrefix"))}<b>${Html.escape(e.serial)}</b>`));
    if (e.rack_u != null) { const uh = Math.max(1, e.u_height | 0 || 1); rows.push(this.tipRow(`U${e.rack_u}${uh > 1 ? "–U" + (e.rack_u + uh - 1) : ""} · ${Html.escape(Depths.label(e.depth || "full"))}`)); }
    if (rk) rows.push(this.tipRow(`${Html.escape(I18n.t("dc.interact.rackPrefix"))}<b>${Html.escape(rk.name || I18n.t("lists.ph.rack"))}</b>${rk.row ? " · " + Html.escape(rk.row) : ""}`));
    // groupes : primaire (couleur héritée) + secondaires — un swatch par groupe membre.
    this.store.equipmentGroupIds(e).forEach((gid: string) => { const g: any = this.store.get("groups", gid); if (g) rows.push(this.tipRow(`${this.tipSwatch(g.color)}${Html.escape(g.label || "")}`)); });
    rows.push(this.tipRow(`${I18n.t("dc.interact.portCount", { count: nPorts })}`));
    return `<div class="tt-title">${Html.escape(e.name || I18n.t("lists.ph.equipment"))}</div>` + rows.join("");
  }

  /** Tooltip d'un port (équipement : port + état de câblage). */
  protected portTipHtml(port: any, cab: any): string {
    const eq: any = this.store.get("equipments", port.equipment_id);
    const head = (eq ? (eq.name || I18n.t("lists.ph.equipment")) + " : " : "") + (port.name || I18n.t("dc.common.port"));
    return `<div class="tt-title">${Html.escape(head)}</div>`
      + (cab ? this.tipRow(`${Html.escape(I18n.t("dc.interact.cablePrefix"))}<b>${Html.escape(this.cableLabelShort(cab))}</b>${Html.escape(I18n.t("dc.interact.clickEditCableSuffix"))}`)
             : `<div class="tt-row" style="color:var(--accent)">${I18n.t("dc.interact.portFree")}</div>`);
  }

  /** Tooltip d'un câble (type, longueur, réseaux, extrémités, points de passage, état). */
  protected cableTipHtml(c: any): string {
    const ct: any = c.cable_type_id ? this.store.get("cableTypes", c.cable_type_id) : null;
    const rows: string[] = [];
    if (ct) rows.push(this.tipRow(`${Html.escape(I18n.t("dc.interact.typePrefix"))}<b>${Html.escape(ct.name || "")}</b>`));
    if (c.length_m != null) rows.push(this.tipRow(`${Html.escape(I18n.t("dc.interact.lengthPrefix"))}<b>${c.length_m} m</b>`));
    const netIds = this.store.cableNetworkIds(c);   // réseaux DÉDUITS (des ports terminaux)
    const primaryNid = this.store.cablePrimaryNetworkId(c);   // principal STABLE (pilote la couleur)
    netIds.forEach((nid: string) => { const n: any = this.store.get("networks", nid); if (!n) return; const star = (nid === primaryNid && netIds.length > 1) ? " ★" : ""; rows.push(this.tipRow(`${this.tipSwatch(n.color)}${Html.escape(n.label || n.name || I18n.t("lists.ph.network"))}${star}`)); });
    rows.push(this.tipRow(`${Html.escape(I18n.t("dc.interact.endAPrefix"))}<b>${Html.escape(this.portShort(c.from_port_id))}</b>`));
    rows.push(this.tipRow(`${Html.escape(I18n.t("dc.interact.endBPrefix"))}<b>${Html.escape(this.portShort(c.to_port_id))}</b>`));
    const wps = (this.store.effectiveWaypointIds(c) || []).map((id: string) => this.store.get("waypoints", id)).filter(Boolean);
    if (wps.length) rows.push(this.tipRow(`${Html.escape(I18n.t("dc.interact.viaPrefix"))}${wps.map((w: any) => Html.escape(Waypoint.glyph(w) + " " + (w.name || I18n.t("dc.common.waypoint")))).join(" → ")}`));
    if (c.status) rows.push(this.tipRow(`${Html.escape(I18n.t("dc.interact.statePrefix"))}${Html.escape(CableStatuses.label(c.status))}`));
    return `<div class="tt-title">${Html.escape(this.cableLabelShort(c))}</div>` + rows.join("");
  }

  /** Tooltip d'un FAISCEAU (trunk) : type, occupation des fibres, extrémités (patchs), route, longueur. */
  protected bundleTipHtml(bundle: any): string {
    const rows: string[] = [];
    const ct: any = bundle.cable_type_id ? this.store.get("cableTypes", bundle.cable_type_id) : null;
    if (ct) rows.push(this.tipRow(`${Html.escape(I18n.t("dc.interact.typePrefix"))}<b>${Html.escape(ct.name || "")}</b>`));
    const occ = this.store.bundleOccupancy(bundle.id);
    rows.push(this.tipRow(`${Html.escape(I18n.t("dc.interact.fibersPrefix"))}<b>${occ.used}/${occ.capacity}</b>${Html.escape(I18n.t("dc.interact.fibersPicked"))}`));
    const endLabel = (eqId: string | null) => {
      const eq: any = eqId ? this.store.get("equipments", eqId) : null;
      if (!eq) return I18n.t("dc.interact.notPlaced");
      const dc = this.store.equipmentDcId(eq);
      return (eq.name || I18n.t("dc.interact.patchPh")) + (dc ? " · " + this.store.dcName(dc) : I18n.t("dc.interact.notPlacedShort"));
    };
    rows.push(this.tipRow(`${Html.escape(I18n.t("dc.interact.endAPrefix"))}<b>${Html.escape(endLabel(bundle.endpoint_a_equipment_id))}</b>`));
    rows.push(this.tipRow(`${Html.escape(I18n.t("dc.interact.endBPrefix"))}<b>${Html.escape(endLabel(bundle.endpoint_b_equipment_id))}</b>`));
    if (bundle.length_m != null) rows.push(this.tipRow(`${Html.escape(I18n.t("dc.interact.lengthPrefix"))}<b>${bundle.length_m} m</b>`));
    const wps = (bundle.waypoint_ids || []).map((id: string) => this.store.get("waypoints", id)).filter(Boolean);
    if (wps.length) rows.push(this.tipRow(`${Html.escape(I18n.t("dc.interact.viaPrefix"))}${wps.map((w: any) => Html.escape(Waypoint.glyph(w) + " " + (w.name || I18n.t("dc.common.waypoint")))).join(" → ")}`));
    return `<div class="tt-title">${Html.escape(bundle.name || I18n.t("lists.ph.bundle"))}</div>` + rows.join("");
  }

  /** Tooltip d'un waypoint (type, forme/étage, hauteur, nb de câbles affectés). */
  protected wpTipHtml(wp: any): string {
    const n = this.store.cablesOfWaypoint(wp.id).length, floorLvl = Waypoint.isFloorLevel(wp);
    const kindLbl = Waypoint.typeOf(wp) === "exit" ? I18n.t("dc.interact.wpExit") : floorLvl ? I18n.t("dc.interact.wpFloorPin") : (wp.kind === "segment" ? I18n.t("dc.interact.wpPath") : wp.kind === "brush" ? I18n.t("dc.interact.wpBrush") : I18n.t("dc.interact.wpRoomPin"));
    const where = floorLvl ? Html.escape(Waypoint.floorLabel(wp)) : Html.escape(I18n.t("dc.interact.heightMm", { mm: wp.dc_z || 0 }));
    return `<div class="tt-title">${Waypoint.glyph(wp)} ${Html.escape(wp.name || I18n.t("dc.common.waypoint"))}</div>`
      + this.tipRow(`<b>${Html.escape(kindLbl)}</b>`)
      + this.tipRow(where)
      + this.tipRow(`${Html.escape(I18n.t("dc.interact.cablesAssigned", { count: n }))}`)
      + `<div class="tt-row" style="color:var(--accent)">${I18n.t("dc.interact.clickActions")}</div>`;
  }


  /** Glisser-déposer COMMUN (baie / équipement libre) en vue Dessus : aimantation à la maille (ou libre si
      `freePlace`), bornée à la salle, refus des cases inaccessibles, cote live. Les seules différences entre baie
      et équipement — extents, orientation, collection cible et logique de sélection (classes SVG) — sont fournies
      par `opts` ; le reste (drag, snap, clamp, garde, persistance) est mutualisé ici. */
  protected dragPlaced(e: MouseEvent, ent: any, opts: { ext: { hx: number; hy: number }; orient: number; collection: string; select: (grp: SVGElement) => void }): void {
    if (e.button !== 0) return;
    if (PlacementLock.isLocked(ent)) {   // positionnement VERROUILLÉ : sélection seule, aucun déplacement (le formulaire reste l'échappatoire)
      e.preventDefault(); e.stopPropagation();
      const dcSel = this.current(); if (dcSel) { opts.select(e.currentTarget as SVGElement); this.renderSide(dcSel); }
      return;
    }
    if (this.posTool.activeHere()) { this.posTool.dragEntity(e, ent.id); return; }   // mode positionnement : glisser aimanté + sélection mover
    e.preventDefault(); e.stopPropagation();
    const dc = this.current(); if (!dc) return;
    const grp = e.currentTarget as SVGElement;
    opts.select(grp);   // sélection spécifique (baie : par data-rack ; équipement : classe sur le nœud)
    this.renderSide(dc);
    const ext = opts.ext, o = opts.orient;
    const w0 = this.clientToWorld(e.clientX, e.clientY);
    const cx0 = (ent.dc_x != null) ? ent.dc_x : w0.x, cy0 = (ent.dc_y != null) ? ent.dc_y : w0.y, off = { x: w0.x - cx0, y: w0.y - cy0 };
    const clampC = (c: { x: number; y: number }) => ({ x: Math.min(Math.max(c.x, ext.hx), dc.width_mm - ext.hx), y: Math.min(Math.max(c.y, ext.hy), dc.depth_mm - ext.hy) });
    let cur = { x: cx0, y: cy0 }, moved = false;
    const move = (ev: MouseEvent) => {
      const w = this.clientToWorld(ev.clientX, ev.clientY), nx = w.x - off.x, ny = w.y - off.y;
      if (!moved && Math.abs(nx - cx0) + Math.abs(ny - cy0) < (8 / (this.scale || 1))) return;
      moved = true; grp.classList.add("dragging");
      cur = clampC({ x: nx, y: ny });
      grp.setAttribute("transform", `translate(${cur.x} ${cur.y}) rotate(${o})`);
      this.showCote(Format.meters(cur.x) + " × " + Format.meters(cur.y), ev.clientX, ev.clientY);
    };
    const up = async () => {
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
      grp.classList.remove("dragging"); this.hideCote();
      if (!moved) return;   // simple clic = sélection
      const c = this.freePlace ? clampC(cur) : clampC({ x: this.snap(cur.x, dc.cell_mm), y: this.snap(cur.y, dc.cell_mm) });
      if (GridGeometry.spanHitsBlocked(dc.blocked_cells, c.x - ext.hx, c.y - ext.hy, c.x + ext.hx, c.y + ext.hy, dc.cell_mm)) { Notify.toast(I18n.t("dc.common.blockedCell"), "err"); this.render(); return; }
      await this.store.update(opts.collection, ent.id, { dc_x: c.x, dc_y: c.y }); this.host.setDirty?.(true);
    };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  }

  /** Glisser-déposer une baie (vue Dessus). */
  protected onRackPointerDown(e: MouseEvent, r: any): void {
    this.dragPlaced(e, r, {
      ext: this.rackHalfExtents(r), orient: Normalize.rackOrientation(r.orientation), collection: "racks",
      select: () => {
        this.selRackId = r.id; this.selEquipId = null; this.selWaypointId = null;
        if (this.svg) { this.svg.querySelectorAll(".dc-equip,.dc-wp").forEach((n) => n.classList.remove("sel")); this.svg.querySelectorAll(".dc-rack").forEach((n) => n.classList.toggle("sel", n.getAttribute("data-rack") === r.id)); }
      },
    });
  }

  /** Glisser-déposer un équipement LIBRE (vue Dessus). */
  protected onEquipPointerDown(ev: MouseEvent, eq: any): void {
    this.dragPlaced(ev, eq, {
      ext: FreeEquipGeometry.halfExtents(eq), orient: Normalize.rackOrientation(eq.dc_orientation), collection: "equipments",
      select: (grp) => {
        this.selRackId = null; this.selEquipId = eq.id; this.selWaypointId = null;
        if (this.svg) { this.svg.querySelectorAll(".dc-rack,.dc-equip,.dc-wp").forEach((n) => n.classList.remove("sel")); grp.classList.add("sel"); }
      },
    });
  }


  /** Port dessiné À PLAT dans le plan de la face (quad projeté, taille réelle du connecteur). */
  protected portFlat(center: Vec3, rack: any, sz: { w: number; h: number }, on: boolean, color: string | null, proj: (p: Vec3) => { h: number; v: number; depth: number }): SVGElement {
    const o = Normalize.rackOrientation(rack.orientation) * Math.PI / 180, co = Math.cos(o), so = Math.sin(o);
    const u = { x: co, y: so, z: 0 }, v = { x: 0, y: 0, z: 1 }, hwd = sz.w / 2, hht = sz.h / 2;
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => proj({ x: center.x + su * hwd * u.x + sv * hht * v.x, y: center.y + su * hwd * u.y + sv * hht * v.y, z: center.z + su * hwd * u.z + sv * hht * v.z }));
    const poly = Dom.svg("polygon", { class: "dc-port" + (on ? " on" : ""), points: pts.map((p) => p.h + "," + p.v).join(" ") });
    if (color) { (poly as any).style.fill = color; (poly as any).style.stroke = color; }
    return poly;
  }


  /** Étiquette (nom + icône optionnelle) posée À PLAT sur la face — matrice affine déduite de la projection. */
  protected flatLabel(center: Vec3, cx: number, cy: number, content: string, fontMM: number, iconInner: string, proj: (p: Vec3) => { h: number; v: number; depth: number }): SVGElement {
    const B = 1000;
    const pO = proj(center);
    const pX = proj({ x: center.x + cx * B, y: center.y + cy * B, z: center.z });   // +x local = largeur
    const pY = proj({ x: center.x, y: center.y, z: center.z - B });                 // +y local = vers le bas (−z)
    const a = (pX.h - pO.h) / B, b = (pX.v - pO.v) / B, c = (pY.h - pO.h) / B, d = (pY.v - pO.v) / B;
    const g = Dom.svg("g", { transform: `matrix(${a} ${b} ${c} ${d} ${pO.h} ${pO.v})` });
    const iconFrag = iconInner ? Dom.parseSvgIcon(iconInner) : null;
    if (iconFrag) {
      const iconMM = fontMM * 1.15, gapMM = fontMM * 0.35, approxText = content.length * fontMM * 0.58, total = iconMM + gapMM + approxText, x0 = -total / 2, s = iconMM / 24;
      const ig = Dom.svg("g", { class: "dc-eq3d-icon", transform: `translate(${x0},${-iconMM / 2}) scale(${s})` });
      ig.appendChild(iconFrag); g.appendChild(ig);
      const t = Dom.svg("text", { class: "dc-eq3d-name", x: x0 + iconMM + gapMM + approxText / 2, y: 0, "text-anchor": "middle", "dominant-baseline": "central", "font-size": fontMM });
      t.textContent = content; g.appendChild(t);
    } else {
      const t = Dom.svg("text", { class: "dc-eq3d-name", x: 0, y: 0, "text-anchor": "middle", "dominant-baseline": "central", "font-size": fontMM });
      t.textContent = content; g.appendChild(t);
    }
    return g;
  }


  /** Clic « franc » (pas un glissé de navigation) sur un nœud SVG. */
  protected wireClick(node: SVGElement, fn: (e: MouseEvent) => void): void {
    let downX = 0, downY = 0;
    node.addEventListener("mousedown", (e: any) => { downX = e.clientX; downY = e.clientY; });
    node.addEventListener("click", (e: any) => { if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return; e.stopPropagation(); fn(e); });
  }

  /** Ctrl+clic sur un emplacement U libre → construit/ajuste une sélection CONTIGUË (même baie, même face).
      1er Ctrl+clic = ancre ; les suivants étendent (refus si un U intermédiaire est occupé) ou rétractent.
      Un clic SIMPLE dans la sélection ouvre l'assignation pré-remplie (hauteur = nb d'U). Réplique du monolithe. */

  protected toggleSlotSel(rackId: string, u: number, side: string): void {
    const s = this.slotSel;
    if (!s || s.rackId !== rackId || s.side !== side) {
      this.slotSel = { rackId, side, lo: u, hi: u };
    } else if (u >= s.lo && u <= s.hi) {
      if (s.lo === s.hi) this.slotSel = null;
      else if (u === s.hi) s.hi--;
      else this.slotSel = { rackId, side, lo: u, hi: s.hi };
    } else {
      const nlo = Math.min(s.lo, u), nhi = Math.max(s.hi, u), occ = this.scene.occupants(rackId);
      for (let k = nlo; k <= nhi; k++) { if (occ.has(k + ":" + side)) { Notify.toast(I18n.t("dc.interact.selInterrupted"), "err"); return; } }
      this.slotSel = { rackId, side, lo: nlo, hi: nhi };
    }
    this.render();
  }


  protected wireRack(poly: SVGElement, r: any): void {
    this.wireTip(poly, () => this.rackTipHtml(r));
    this.wireClick(poly, () => { this.hideTip(); this.selRackId = r.id; const open = this.host.openRackDetail || this.host.openRackForm; if (open) open(r.id); else this.render(); });
    poly.addEventListener("contextmenu", (e: any) => { this.hideTip(); this.ctxMenu(e, this.rackCtx(r)); });
  }

  protected wireOccupant(node: SVGElement, eqId: string): void {
    node.setAttribute("data-occ", "eq:" + eqId);
    // survol : met en évidence TOUTES les faces du même équipement (.hover) + tooltip enrichi.
    const setHover = (on: boolean) => { if (this.svg) this.svg.querySelectorAll('[data-occ="eq:' + eqId + '"]').forEach((n) => n.classList.toggle("hover", on)); };
    node.addEventListener("mouseenter", (e: any) => { setHover(true); this.showTip(this.equipmentTipHtml(eqId), e); });
    node.addEventListener("mousemove", (e: any) => this.moveTip(e));
    node.addEventListener("mouseleave", () => { setHover(false); this.hideTip(); });
    this.wireClick(node, () => { this.hideTip(); this.host.openEquipmentDetail?.(eqId); });
    node.addEventListener("contextmenu", (e: any) => { this.hideTip(); this.ctxMenu(e, this.equipmentCtx(eqId)); });
  }
  /** Pseudo-élément (rackItem : blank / tray / keepblank) en 3D : survol (mise en évidence de toutes ses faces),
      tooltip enrichi, clic / clic droit → menu (retirer). Pendant des occupants pour les éléments non-équipement. */
  protected wireItem(node: SVGElement, item: any): void {
    if (!item || !item.id) return;
    node.setAttribute("data-occ", "item:" + item.id);
    const setHover = (on: boolean) => { if (this.svg) this.svg.querySelectorAll('[data-occ="item:' + item.id + '"]').forEach((n) => n.classList.toggle("hover", on)); };
    node.addEventListener("mouseenter", (e: any) => { setHover(true); this.showTip(this.itemTipHtml(item), e); });
    node.addEventListener("mousemove", (e: any) => this.moveTip(e));
    node.addEventListener("mouseleave", () => { setHover(false); this.hideTip(); });
    this.wireClick(node, (e: any) => { this.hideTip(); this.ctxMenu(e, this.itemCtx(item)); });
    node.addEventListener("contextmenu", (e: any) => { e.preventDefault(); this.hideTip(); this.ctxMenu(e, this.itemCtx(item)); });
  }
  /** Tooltip enrichi d'un pseudo-élément (tray : variante + longueur + structure/réservation). */
  protected itemTipHtml(item: any): string {
    const kind = RackItemKinds.label(item.kind), uh = Math.max(1, (item.u_height | 0) || 1);
    const name = (item.label && item.label.trim()) ? item.label : kind;
    const rows = [
      this.tipRow(`<b>${Html.escape(kind)}</b>${item.depth === "none" && item.kind !== "tray" ? Html.escape(I18n.t("dc.interact.noDepth")) : ""}`),
      this.tipRow(`U${item.u}${uh > 1 ? "–U" + (item.u + uh - 1) : ""}${item.side === "rear" ? Html.escape(I18n.t("dc.interact.sideRear")) : (item.side === "front" ? Html.escape(I18n.t("dc.interact.sideFront")) : "")}`),
    ];
    if (item.kind === "tray") {
      const cant = item.tray_type === "cantilever", tu = Math.max(1, (item.tray_u | 0) || 1);
      rows.push(this.tipRow(Html.escape((cant ? I18n.t("dc.interact.cantilever") + (item.depth_mm ? I18n.t("dc.interact.trayShelf", { mm: item.depth_mm }) : "") : I18n.t("dc.interact.fullCage"))
        + I18n.t("dc.interact.trayStructure", { u: tu }) + I18n.t("dc.interact.trayUseful", { mm: Math.round(uh * U_MM - TRAY_SHEET_RESERVE_MM) }))));
    }
    rows.push(this.tipRow(`<span style="color:var(--accent)">${I18n.t("dc.interact.clickRightActions")}</span>`));
    return `<div class="tt-title">${Html.escape(name)}</div>` + rows.join("");
  }
  /** Menu d'un pseudo-élément (rackItem) : modifier, poser un équipement (tray) ou retirer. */
  protected itemCtx(item: any): CtxSection[] {
    const name = (item.label && item.label.trim()) ? item.label : RackItemKinds.label(item.kind);
    const items: Array<{ label: string; danger?: boolean; action: () => void }> = [
      { label: I18n.t("dc.common.editEllipsis"), action: () => this.host.openRackItemForm?.(item.id) },
    ];
    if (item.kind === "tray") items.push({ label: I18n.t("dc.interact.placeEquip"), action: () => this.host.assignTraySlot?.(item.id, () => { this.setDirty(); this.reflow(); }) });
    items.push({ label: I18n.t("dc.common.remove"), danger: true, action: async () => { if (this.store.get("rackItems", item.id)) { await this.store.remove("rackItems", item.id); this.setDirty(); Notify.toast(I18n.t("dc.interact.itemRemoved")); } } });
    return [{ head: name, items }];
  }

  /** Clic (route-aware) + clic droit (menu) + tooltip enrichi d'un nœud de waypoint/brosse/OOB. */
  protected wireWp(node: SVGElement, wp: any): void {
    this.wireTip(node, () => this.wpTipHtml(wp));
    this.wireClick(node, () => { this.hideTip(); this.onWaypointClick(wp); });
    node.addEventListener("contextmenu", (e: any) => { this.hideTip(); this.ctxMenu(e, this.waypointCtx(wp)); });
  }
  /** Câble un connecteur de port : surbrillance au survol (`.dc-port.hover`) + clic (routage interactif si
      actif : démarre/termine la route ; sinon édite/crée le câble). */

  protected wirePortNode(node: SVGElement, port: any, cab: any): void {
    (node as any).style.pointerEvents = "auto";   // neutralise `.dc-port { pointer-events: none }` → port survolable/cliquable
    (node as any).style.cursor = "pointer";
    node.addEventListener("mouseenter", (e: any) => { node.classList.add("hover"); this.showTip(this.portTipHtml(port, cab), e); });
    node.addEventListener("mousemove", (e: any) => this.moveTip(e));
    node.addEventListener("mouseleave", () => { node.classList.remove("hover"); this.hideTip(); });
    this.wireClick(node, () => {
      this.hideTip();
      const rb = this.routeTool.state;
      if (rb) {   // routage : port de départ, puis port terminal
        if (!rb.fromPortId) this.routeTool.start(port.id);
        else if (port.id !== rb.fromPortId) this.routeTool.finish(port.id);
        return;
      }
      if (cab) this.host.openCableForm?.(cab.id); else this.connectPort(port);
    });
    node.addEventListener("contextmenu", (e: any) => { this.hideTip(); this.ctxMenu(e, this.portCtx(port, cab)); });
  }

  /** Clic d'un port LIBRE : propose les brouillons-candidats (un bout manquant, compatibles) ou un nouveau câble. */
  protected async connectPort(port: any): Promise<void> {
    const cands = this.store.cableDraftCandidatesForPort(port.id);
    if (!cands.length) { this.host.openCableForm?.(null, { fromPortId: port.id }); return; }
    const sel = FormControls.select([{ value: "", label: I18n.t("dc.interact.newCable") }].concat(cands.map((c: any) => {
      const ct: any = c.cable_type_id ? this.store.get("cableTypes", c.cable_type_id) : null, sum = this.store.cableRouteSummary(this.store.cableRoute(c));
      return { value: c.id, label: (c.name || I18n.t("dc.interact.draftPh")) + (ct ? " · " + ct.name : "") + (sum ? " · " + sum : "") };
    })), "");
    const body = document.createElement("div");
    const hint = document.createElement("div"); hint.className = "form-hint"; hint.textContent = I18n.t("dc.interact.draftHint");
    body.append(hint, FormControls.fieldRow(I18n.t("dc.interact.cableField"), sel, I18n.t("dc.interact.cableFieldHint")));
    const res = await Dialog.custom({ title: I18n.t("dc.interact.connectPortTitle"), confirmLabel: I18n.t("dc.interact.continue"), build: (r: HTMLElement) => { r.appendChild(body); return { validate: () => true as const, collect: () => ({ cableId: sel.value }) }; } });
    if (!res) return;
    if (!res.cableId) this.host.openCableForm?.(null, { fromPortId: port.id });
    else this.host.openCableForm?.(res.cableId, { assignPortId: port.id });
  }


  /* ---- menus contextuels (clic droit) ---- */
  /** Ouvre un menu contextuel (vues 2D ; en 3D-WebGL le moteur gère son propre anti-orbite via `_navMovedR`). */
  protected ctxMenu(e: MouseEvent, sections: CtxSection[]): void {
    e.preventDefault(); e.stopPropagation();
    if (sections.length) ContextMenu.show(e.clientX, e.clientY, sections);
  }

  /** Actions de SÉLECTION de câbles (afficher / isoler / masquer) — manipule selCables, pas « Tout afficher ». */
  protected cableSelItems(ids: string[], noun: string): Array<{ label: string; action: () => void }> {
    const u = [...new Set((ids || []).filter(Boolean))]; const n = u.length; if (!n) return [];
    const suf = n > 1 ? " (" + n + ")" : "";
    return [
      { label: I18n.t("dc.interact.show", { noun, suf }), action: () => { u.forEach((id) => this.selCables.add(id)); this.rerenderView(); } },
      { label: I18n.t("dc.interact.isolate", { noun, suf }), action: () => { this.selCables = new Set(u); this.rerenderView(); } },
      { label: I18n.t("dc.interact.hide", { noun, suf }), action: () => { u.forEach((id) => this.selCables.delete(id)); this.rerenderView(); } },
    ];
  }

  protected portCtx(port: any, cab: any): CtxSection[] {
    const items: Array<{ label: string; danger?: boolean; action: () => void }> = [cab
      ? { label: I18n.t("dc.interact.editCableEllipsis"), action: () => this.host.openCableForm?.(cab.id) }
      : { label: I18n.t("dc.interact.createAssignCable"), action: () => this.connectPort(port) }];
    if (this.routeTool.state) { if (this.routeTool.state.fromPortId && port.id !== this.routeTool.state.fromPortId) items.push({ label: I18n.t("dc.interact.finishRouteHere"), action: () => this.routeTool.finish(port.id) }); }
    else if (!cab) items.push({ label: I18n.t("dc.interact.startRouteHere"), action: () => this.routeTool.start(port.id) });
    const secs: CtxSection[] = [{ head: port.name || I18n.t("dc.common.port"), items }];
    const csi = this.cableSelItems(this.store.cablesOfPorts([port.id]).map((c: any) => c.id), I18n.t("dc.interact.nounPortCable"));
    if (csi.length) secs.push({ items: csi });
    return secs;
  }

  /** Menu d'un équipement (occupant U / side / wall / libre) : détails · modifier · câble · retirer. */
  protected equipmentCtx(eqId: string): CtxSection[] {
    const e: any = this.store.get("equipments", eqId); if (!e) return [];
    const onTray = e.placement_mode === "tray" && !!e.tray_item_id;
    const placed = !!(e.dc_id || e.rack_id || onTray);
    const locked = PlacementLock.isLocked(e);
    const removeAction = async () => {
      if (!this.store.get("equipments", eqId)) return;
      const ops: Array<{ collection: string; id: string; patch: Record<string, any> }> = onTray
        ? [{ collection: "equipments", id: eqId, patch: { placement_mode: "manual", tray_item_id: null, tray_x: null, tray_y: null } }]   // descend de l'étagère → non placé
        : e.dim_mode === "free"
          ? [{ collection: "equipments", id: eqId, patch: { dc_id: null, dc_x: null, dc_y: null, dc_z: 0 } }]
          : [{ collection: "equipments", id: eqId, patch: { placement_mode: "rack", dim_mode: "u", rack_id: null, rack_u: null } }];
      if (placed) ops.push(...this.store.cableDowngradeOps([eqId]));
      await this.store.updateBatch(ops); this.setDirty();
      Notify.toast((onTray ? I18n.t("dc.interact.equipOffShelf") : I18n.t("dc.interact.equipRemovedDc")) + (ops.length > 1 ? I18n.t("dc.interact.cablesPlannedSuffix") : ""));
    };
    const rotate = (deg: number) => async () => { const o: any = this.store.get("equipments", eqId); if (!o) return; await this.store.update("equipments", eqId, { dc_orientation: Normalize.rackOrientation((o.dc_orientation || 0) + deg) }); this.setDirty(); };
    const items: Array<{ label: string; danger?: boolean; disabled?: boolean; title?: string; action: () => void }> = [
      { label: I18n.t("dc.interact.detailsEllipsis"), action: () => this.host.openEquipmentDetail?.(eqId) },
      { label: I18n.t("dc.common.editEllipsis"), action: () => this.host.openEquipmentForm?.(eqId) },   // modale d'ÉDITION (pas la fiche d'info)
      PlacementLock.ctxItem(this.store, "equipments", eqId, () => this.render()),
    ];
    // rotation au sol : pertinente pour un équipement LIBRE (boîtier orienté). En U, l'orientation suit la baie.
    if (e.dim_mode === "free") items.push(
      { label: I18n.t("dc.common.rotate90g"), disabled: locked, title: locked ? PlacementLock.BLOCKED_HINT : undefined, action: rotate(90) },
      { label: I18n.t("dc.common.rotate180g"), disabled: locked, title: locked ? PlacementLock.BLOCKED_HINT : undefined, action: rotate(180) });
    // masquage 3D/2D par ÉQUIPEMENT / TYPE / GROUPE (équipements libres) — piloté aussi depuis le panneau « Équipements libres ».
    if (e.dim_mode === "free") {
      const dcIds = this.displayedDcIds(this.current());
      const setHidden = (ids: string[], hide: boolean) => { ids.forEach((id) => { if (hide) this.hidden3dEquips.add(id); else this.hidden3dEquips.delete(id); }); this.reflow(); this.renderSide(this.current()); };
      const matching = (pred: (x: any) => boolean) => this.store.all("equipments").filter((x: any) => x.dim_mode === "free" && x.dc_x != null && dcIds.includes(x.dc_id) && pred(x)).map((x: any) => x.id);
      items.push({ label: this.hidden3dEquips.has(eqId) ? I18n.t("dc.interact.showThisEquip") : I18n.t("dc.interact.hideThisEquip"), action: () => setHidden([eqId], !this.hidden3dEquips.has(eqId)) });
      items.push({ label: I18n.t("dc.interact.hideType", { type: EquipmentTypes.label(e.type) }), action: () => setHidden(matching((x) => x.type === e.type), true) });
      // un item de masquage par groupe MEMBRE (primaire + secondaires) ; l'appartenance teste group_ids.
      this.store.equipmentGroupIds(e).forEach((gid: string) => { const g: any = this.store.get("groups", gid); items.push({ label: I18n.t("dc.interact.hideGroup", { group: (g && g.label) || "?" }), action: () => setHidden(matching((x) => this.store.equipmentGroupIds(x).includes(gid)), true) }); });
    }
    items.push(
      { label: I18n.t("dc.interact.createCable"), action: () => this.host.openCableForm?.(null, { fromEqId: eqId }) },
      { label: onTray ? I18n.t("dc.interact.descendShelf") : (placed ? I18n.t("dc.interact.removeFromDc") : I18n.t("dc.interact.returnUnplaced")), danger: true, disabled: locked, title: locked ? PlacementLock.BLOCKED_HINT : undefined, action: removeAction },
    );
    const secs: CtxSection[] = [{ head: e.name || I18n.t("lists.ph.equipment"), items }];
    const csi = this.cableSelItems(this.store.cablesOfEquipment(eqId).map((c: any) => c.id), I18n.t("dc.interact.nounEquipCables"));
    if (csi.length) secs.push({ items: csi });
    return secs;
  }

  /* ---- PORTES de salle : CRUD + menu = DoorTool (cf. DoorTool.ts). Le rendu 2D / drag / posScene / carte
         restent (transitoirement) dans la chaîne de vues et appellent `this.doorTool`. ---- */

  /** Menu contextuel du PERSONNAGE d'échelle (repère de vue) : pivoter · masquer. Aucune mutation du document. */
  protected figureCtx(): CtxSection[] {
    return [{ head: I18n.t("dc.interact.figureHead"), items: [
      { label: I18n.t("dc.common.rotate90g"), action: () => { if (this.figure) { this.figure.orient = Normalize.rackOrientation((this.figure.orient || 0) + 90); this.persistView(); this.reflow(); } } },
      { label: I18n.t("dc.interact.hideFigure"), danger: true, action: () => { this.showFigure = false; this.persistView(); this.buildToolbar(); this.render(); } },
    ] }];
  }

  /** Active une salle (devient la salle courante) ; `isolate` repasse en mode SALLE UNIQUE (multiDc off). */
  protected activateDc(dcId: string, isolate: boolean): void {
    this.dcId = dcId; this.selRackId = null; this.camTarget = null; this.scale = null;
    if (isolate) this.multiDc = false;
    this.buildToolbar(); this.render();
  }
  /** Bascule de MODE DE VUE pour une salle : 3D / Plan de salle (top) → active le DC ; Plan d'étage → cible son étage. */
  protected activateView(view: "3d" | "top" | "floor", dc: any): void {
    this.view = view;
    if (view === "floor") this.floorTarget = { location: dc.location || "", floor: String(dc.floor || "") };
    else this.dcId = dc.id;
    this.selRackId = null; this.camTarget = null; this.scale = null;
    this.buildToolbar(); this.render();
  }
  /** Section « Vue » (3D · Plan de salle · Plan d'étage) — réplique du sélecteur de la toolbar, en menu contextuel.
      `dc` peut être null (plan d'étage sans salle) : 3D / Plan de salle sont alors inertes (toast), Plan d'étage cible loc/fl. */
  protected viewSwitchSectionAt(dc: any | null, loc: string, fl: string): CtxSection {
    const cur = (v: string) => (this.view === v ? "✓ " : "");
    const need = () => Notify.toast(I18n.t("dc.interact.noRoomHere"), "err");
    return { head: I18n.t("dc.interact.viewHead"), items: [
      { label: cur("3d") + I18n.t("dc.interact.view3d"), action: () => (dc ? this.activateView("3d", dc) : need()) },
      { label: cur("top") + I18n.t("dc.common.roomPlan"), action: () => (dc ? this.activateView("top", dc) : need()) },
      { label: cur("floor") + I18n.t("dc.common.floorPlan"), action: () => { this.floorTarget = { location: loc, floor: fl }; this.view = "floor"; this.selRackId = null; this.camTarget = null; this.scale = null; this.buildToolbar(); this.render(); } },
    ] };
  }
  protected viewSwitchSection(dc: any): CtxSection { return this.viewSwitchSectionAt(dc, dc.location || "", String(dc.floor || "")); }
  /** Menu d'une SALLE en 3D multi-salles (clic droit sur son sol) : activer ce DC · isoler · modifier + bascule de vue. */
  protected roomCtx(dc: any): CtxSection[] {
    const items: Array<{ label: string; danger?: boolean; action: () => void }> = [];
    if (this.multiDc) {   // activer / isoler / quitter le multi-DC n'ont de sens qu'en mode Multi-DC
      items.push({ label: I18n.t("dc.interact.activateDc"), action: () => this.activateDc(dc.id, false) });   // devient la salle active (affichage inchangé)
      // Isoler : RESTE en Multi-DC mais n'affiche QUE ce DC (visibleDcIds = {ce DC}) — distinct du mode simple.
      items.push({ label: I18n.t("dc.interact.isolateDc"), action: () => { this.dcId = dc.id; this.selRackId = null; this.visibleDcIds = new Set([dc.id]); this.camTarget = null; this.scale = null; this.buildToolbar(); this.render(); } });
      items.push({ label: I18n.t("dc.interact.simpleDcMode"), action: () => this.activateDc(dc.id, true) });   // quitte le Multi-DC, sur ce DC
    }
    // afficher toutes les baies — seulement si au moins une baie de CE DC est masquée
    const dcRacks = this.store.racksOfDc(dc.id);
    if (dcRacks.some((r: any) => this.hidden3dRacks.has(r.id))) {
      items.push({ label: I18n.t("dc.interact.showAllRacks"), action: () => { dcRacks.forEach((r: any) => this.hidden3dRacks.delete(r.id)); this.render(); } });
    }
    items.push({ label: I18n.t("dc.common.editRoomEllipsis"), action: () => this.host.openDatacenterForm?.(dc.id) });
    return [
      { head: dc.name || I18n.t("lists.ph.room"), items },
      this.viewSwitchSection(dc),
    ];
  }
  protected rackCtx(rack: any): CtxSection[] {
    const hidden = this.hidden3dRacks.has(rack.id);
    const locked = PlacementLock.isLocked(rack);
    const items: any[] = [
      { label: I18n.t("dc.common.editEllipsis"), action: () => this.host.openRackForm?.(rack.id) },
      PlacementLock.ctxItem(this.store, "racks", rack.id, () => this.render()),
      { label: I18n.t("dc.interact.isolateRack"), action: () => this.isolateRack(rack.id) },
      { label: hidden ? I18n.t("dc.interact.showRack") : I18n.t("dc.interact.hideRack"), action: () => { if (hidden) this.hidden3dRacks.delete(rack.id); else this.hidden3dRacks.add(rack.id); this.render(); } },
    ];
    // capots & portes : bascules GLOBALES (toutes les baies) = même état que les toggles « Capots / parois des baies »
    // et « Portes des baies » du panneau (3D). Proposées seulement en vue 3D et si la baie porte l'élément concerné
    // (elle a des capots / une porte) — sans quoi la bascule serait sans effet visible sur la baie cliquée.
    if (this.view === "3d") {
      if (rack.has_caps !== false) items.push({ label: this.showRackSides ? I18n.t("dc.interact.hideCaps") : I18n.t("dc.interact.showCaps"), action: () => { this.showRackSides = !this.showRackSides; this.rerenderView(); } });
      if (RackGeometry.hasDoor(rack)) items.push({ label: this.showDoors ? I18n.t("dc.interact.hideDoors") : I18n.t("dc.interact.showDoors"), action: () => { this.showDoors = !this.showDoors; this.rerenderView(); } });
    }
    const secs: CtxSection[] = [{ head: rack.name || I18n.t("lists.ph.rack"), items: items.concat([
      { label: I18n.t("dc.interact.removeFromDc"), danger: true, disabled: locked, title: locked ? PlacementLock.BLOCKED_HINT : undefined, action: async () => {
          if (!this.store.get("racks", rack.id)) return;
          const eqIds = this.store.equipmentsOfRack(rack.id).filter((e: any) => e.placement_mode === "rack" && e.rack_u != null).map((e: any) => e.id);
          const ops: Array<{ collection: string; id: string; patch: Record<string, any> }> = [{ collection: "racks", id: rack.id, patch: { datacenter_id: null, dc_x: null, dc_y: null } }];
          if (rack.datacenter_id) ops.push(...this.store.cableDowngradeOps(eqIds));
          await this.store.updateBatch(ops); this.setDirty(); Notify.toast(I18n.t("dc.interact.rackRemovedPool"));
        } },
    ]) }];
    const rackCableIds = this.store.equipmentsOfRack(rack.id).flatMap((e: any) => this.store.cablesOfEquipment(e.id).map((c: any) => c.id));
    const csi = this.cableSelItems(rackCableIds, I18n.t("dc.interact.nounRackCables"));
    if (csi.length) secs.push({ items: csi });
    return secs;
  }

  protected waypointCtx(wp: any): CtxSection[] {
    const nCab = this.store.cablesOfWaypoint(wp.id).length;
    const locked = PlacementLock.isLocked(wp);
    const items: Array<{ label: string; danger?: boolean; disabled?: boolean; title?: string; action: () => void }> = [];
    if (this.routeTool.state && this.routeTool.state.fromPortId) items.push({ label: I18n.t("dc.interact.addToRoute"), action: () => this.routeTool.addWp(wp.id) });
    items.push({ label: I18n.t("dc.common.editEllipsis"), action: () => this.host.openWaypointForm?.(wp.id) });
    items.push(PlacementLock.ctxItem(this.store, "waypoints", wp.id, () => this.render()));
    items.push({ label: I18n.t("dc.interact.removeFromRoom"), danger: true, disabled: locked, title: locked ? PlacementLock.BLOCKED_HINT : undefined, action: async () => { if (!this.store.get("waypoints", wp.id)) return; await this.store.update("waypoints", wp.id, { datacenter_id: null, dc_x: null, dc_y: null, dc_x2: null, dc_y2: null }); this.setDirty(); } });
    items.push({ label: I18n.t("ui.action.delete"), danger: true, action: async () => {
        const ok = await Dialog.confirm({ title: I18n.t("dc.common.delWpTitle"), danger: true, message: I18n.t("dc.common.deleteNamedQ", { name: wp.name || I18n.t("dc.common.waypoint") }) + (nCab ? I18n.t("dc.interact.delWpCables", { n: nCab }) : "") });
        if (!ok || !this.store.get("waypoints", wp.id)) return;
        await this.store.remove("waypoints", wp.id); this.setDirty(); Notify.toast(I18n.t("dc.common.wpDeleted"));
      } });
    const secs: CtxSection[] = [{ head: Waypoint.glyph(wp) + " " + (wp.name || I18n.t("dc.common.waypoint")), items }];
    const csi = this.cableSelItems(this.store.cablesOfWaypoint(wp.id).map((c: any) => c.id), wp.kind === "brush" ? I18n.t("dc.interact.nounBrushCables") : I18n.t("dc.interact.nounPassingCables"));
    if (csi.length) secs.push({ items: csi });
    return secs;
  }

  protected cableCtx(cable: any): CtxSection[] {
    let detach: { label: string; patch: Record<string, any>; msg: string } | null = null;
    if (cable.status === "cable" || cable.status === "a-remplacer") detach = { label: I18n.t("dc.interact.detachPlanned"), patch: { status: "planifie" }, msg: I18n.t("dc.interact.detachedPlannedMsg") };
    else if (cable.status === "planifie") detach = { label: I18n.t("dc.interact.detachDraft"), patch: { status: "brouillon", from_port_id: null, to_port_id: null, waypoint_ids: [] }, msg: I18n.t("dc.interact.detachedDraftMsg") };
    const items: Array<{ label: string; danger?: boolean; action: () => void }> = [{ label: I18n.t("dc.interact.editCableEllipsis"), action: () => this.host.openCableForm?.(cable.id) }];
    if (detach) items.push({ label: detach.label, action: async () => { if (!this.store.get("cables", cable.id)) return; await this.store.update("cables", cable.id, detach!.patch); this.setDirty(); Notify.toast(detach!.msg); } });
    items.push({ label: I18n.t("dc.interact.deleteCable"), danger: true, action: async () => { const ok = await Dialog.confirm({ title: I18n.t("dc.common.deleteQ"), message: I18n.t("dc.common.deleteNamedQ", { name: cable.name || I18n.t("dc.interact.thisCablePh") }), confirmLabel: I18n.t("ui.action.delete"), danger: true }); if (!ok || !this.store.get("cables", cable.id)) return; await this.store.remove("cables", cable.id); this.setDirty(); Notify.toast(I18n.t("dc.interact.cableDeleted")); } });
    return [{ head: cable.name || I18n.t("lists.ph.cable"), items }, { items: this.cableSelItems([cable.id], I18n.t("dc.interact.nounThisCable")) }];
  }

  /** Menu contextuel d'un FAISCEAU (trunk) : éditer · supprimer + sélection (Afficher/Isoler/Masquer) du trunk
      et de ses brins — mêmes actions de visibilité que les câbles (selCables partage les ids). */
  protected bundleCtx(bundle: any): CtxSection[] {
    const items: Array<{ label: string; danger?: boolean; action: () => void }> = [
      { label: I18n.t("dc.interact.editBundleEllipsis"), action: () => this.host.openCableBundleForm?.(bundle.id) },
      { label: I18n.t("dc.interact.deleteBundle"), danger: true, action: async () => {
          const nStrand = this.store.portsOfBundle(bundle.id).length;
          const ok = await Dialog.confirm({ title: I18n.t("dc.common.deleteQ"), message: I18n.t("dc.common.deleteNamedQ", { name: bundle.name || I18n.t("dc.interact.thisBundlePh") }) + (nStrand ? I18n.t("dc.interact.delBundleStrands", { n: nStrand }) : ""), confirmLabel: I18n.t("ui.action.delete"), danger: true });
          if (!ok || !this.store.get("cableBundles", bundle.id)) return;
          await this.store.remove("cableBundles", bundle.id); this.setDirty(); Notify.toast(I18n.t("dc.interact.bundleDeleted"));
        } },
    ];
    return [{ head: "" + (bundle.name || I18n.t("lists.ph.bundle")), items }, { items: this.cableSelItems([bundle.id], I18n.t("dc.interact.nounThisBundle")) }];
  }

  /** Menu du SOL (vue Dessus) : créer un waypoint (pin / chemin / exit) au point cliqué (aimanté ½ maille). */
  protected floorCtx(dc: any, w: { x: number; y: number }): CtxSection[] {
    const snapHalf = (v: number) => Math.round(v / (dc.cell_mm / 2)) * (dc.cell_mm / 2);
    const x = snapHalf(w.x), y = snapHalf(w.y);
    const baseName = () => "WP-" + (this.store.all("waypoints").length + 1);
    const sel = async (wp: any) => { this.selWaypointId = wp.id; this.setDirty(); };
    return [{ head: I18n.t("dc.interact.wpMenuHead"), items: [
      { label: I18n.t("dc.interact.addPinHere"), action: async () => { sel(await this.store.create("waypoints", { name: baseName(), kind: "point", datacenter_id: dc.id, dc_x: x, dc_y: y })); Notify.toast(I18n.t("dc.interact.pinCreatedDrag")); } },
      { label: I18n.t("dc.interact.addPathHere"), action: async () => { const h = dc.cell_mm; sel(await this.store.create("waypoints", { name: baseName(), kind: "segment", datacenter_id: dc.id, dc_x: Math.max(0, x - h), dc_y: y, dc_x2: Math.min(dc.width_mm, x + h), dc_y2: y })); Notify.toast(I18n.t("dc.interact.pathCreatedDrag")); } },
      { label: I18n.t("dc.interact.addExitHere"), action: async () => { const nx = this.store.all("waypoints").filter((w2: any) => Waypoint.typeOf(w2) === "exit").length + 1; sel(await this.store.create("waypoints", { name: "EXIT-" + nx, wp_type: "exit", kind: "point", datacenter_id: dc.id, dc_x: x, dc_y: y })); Notify.toast(I18n.t("dc.interact.exitCreatedPair")); } },
    ] }, this.viewSwitchSection(dc)];
  }

  /* ---- menus contextuels du PLAN D'ÉTAGE (sol / salle / équipement) ---- */
  /** Menu du SOL du plan d'étage : créer une salle / un OOB (au point aimanté ½ maille) / éditer le plan. */
  protected floorPlaneCtx(loc: string, fl: string, w: { x: number; y: number }): CtxSection[] {
    const cfg = this.floor.config(loc, fl), half = (cfg.cell_mm || 1000) / 2;
    const x = Math.round(w.x / half) * half, y = Math.round(w.y / half) * half;
    return [{ head: I18n.t("dc.interact.floorPlaneHead", { bldg: this.store.siteLabel(loc), n: fl || "0" }), items: [
      { label: I18n.t("dc.interact.addRoomEllipsis"), action: () => this.host.openDatacenterForm?.("") },
      { label: I18n.t("dc.interact.addFloorPinHere"), action: async () => { const wp: any = await this.store.create("waypoints", { name: "PIN-" + (this.store.oobWaypoints().length + 1), kind: "point", location: loc, floor: fl, floor_x: x, floor_y: y }); this.selWaypointId = wp.id; this.setDirty(); Notify.toast(I18n.t("dc.interact.floorPinCreatedDrag")); } },
      { label: I18n.t("dc.common.editFloorPlanEllipsis"), action: () => this.editFloor(loc, fl, false) },
    ] }, this.viewSwitchSectionAt(this.store.dcsOfFloor(loc, fl)[0] || null, loc, fl)];
  }

  /** Menu de la DALLE d'étage en 3D multi-salles (clic droit) : éditer le plan · ajouter une salle · vue Étage 2D. */
  protected floorPlane3DCtx(loc: string, fl: string): CtxSection[] {
    fl = String(fl || "");
    return [{ head: I18n.t("dc.interact.floorHead", { bldg: this.store.siteLabel(loc) || I18n.t("dc.interact.buildingUnknown"), n: fl || "0" }), items: [
      { label: I18n.t("dc.common.editFloorPlanEllipsis"), action: () => this.editFloor(loc, fl, false) },
      { label: I18n.t("dc.interact.addRoomToFloor"), action: () => this.host.openDatacenterForm?.("") },
      { label: I18n.t("dc.interact.floorView2d"), action: () => { this.floorTarget = { location: loc, floor: fl }; this.view = "floor"; this.scale = null; this.buildToolbar(); this.render(); } },
    ] }];
  }

  /** Menu d'une salle dans le plan d'étage : pivoter / ouvrir (plan de salle) / modifier / position auto. */
  protected floorRoomCtx(d: any): CtxSection[] {
    return [{ head: d.name || I18n.t("lists.ph.room"), items: [
      { label: I18n.t("dc.common.rotate90g"), action: async () => { await this.store.update("datacenters", d.id, { floor_orientation: Normalize.rackOrientation((d.floor_orientation || 0) + 90) }); this.selRoomId = d.id; this.setDirty(); } },
      { label: I18n.t("dc.interact.openRoom"), action: () => { this.dcId = d.id; this.view = "top"; this.scale = null; this.buildToolbar(); this.render(); } },
      { label: I18n.t("dc.common.editRoomEllipsis"), action: () => this.host.openDatacenterForm?.(d.id) },
      { label: I18n.t("dc.interact.autoPosition"), danger: true, action: async () => { await this.store.update("datacenters", d.id, { floor_x: null, floor_y: null }); this.setDirty(); } },
    ] }];
  }

  /** Menu d'un équipement posé sur le plan d'étage : modifier / fiche / délocaliser / retirer de l'étage. */
  protected floorEquipCtx(eq: any): CtxSection[] {
    const locked = PlacementLock.isLocked(eq);
    const rotate = (deg: number) => async () => { const o: any = this.store.get("equipments", eq.id); if (!o) return; await this.store.update("equipments", eq.id, { dc_orientation: Normalize.rackOrientation((o.dc_orientation || 0) + deg) }); this.selFloorEquip = eq.id; this.setDirty(); };
    const items: Array<{ label: string; danger?: boolean; disabled?: boolean; title?: string; action: () => void }> = [
      { label: I18n.t("dc.common.editEllipsis"), action: () => this.host.openEquipmentForm?.(eq.id) },   // modale d'ÉDITION
      { label: I18n.t("dc.interact.sheetDetails"), action: () => this.host.openEquipmentDetail?.(eq.id) },
      PlacementLock.ctxItem(this.store, "equipments", eq.id, () => this.render()),
      { label: I18n.t("dc.common.rotate90g"), disabled: locked, title: locked ? PlacementLock.BLOCKED_HINT : undefined, action: rotate(90) },
      { label: I18n.t("dc.common.rotate180g"), disabled: locked, title: locked ? PlacementLock.BLOCKED_HINT : undefined, action: rotate(180) },
    ];
    if (FloorLayout.floorEquipLocalized(eq)) items.push({ label: I18n.t("dc.interact.delocate"), danger: true, disabled: locked, title: locked ? PlacementLock.BLOCKED_HINT : undefined, action: async () => { await this.store.update("equipments", eq.id, { floor_x: null, floor_y: null }); this.selFloorEquip = null; this.setDirty(); } });
    items.push({ label: I18n.t("dc.interact.removeFromFloor"), danger: true, disabled: locked, title: locked ? PlacementLock.BLOCKED_HINT : undefined, action: async () => {
      const downs = this.store.equipmentDcId(eq.id) ? this.store.cableDowngradeOps([eq.id]) : [];
      await this.store.updateBatch(([{ collection: "equipments", id: eq.id, patch: { placement_mode: "manual", floor_x: null, floor_y: null } }] as any[]).concat(downs as any));
      this.selFloorEquip = null; this.setDirty(); Notify.toast(I18n.t("dc.interact.equipRemovedFloor"));
    } });
    return [{ head: "▣ " + (eq.name || I18n.t("lists.ph.equipment")), items }];
  }


  /** Clic sur un waypoint/brosse/OOB de la scène : ajout à la route en cours (si démarrée) sinon édition. */
  protected onWaypointClick(wp: any): void {
    if (this.routeTool.state && this.routeTool.state.fromPortId) { this.routeTool.addWp(wp.id); return; }
    this.host.openWaypointForm?.(wp.id);
  }

  /* ---- routage interactif = RouteTool (état + machine d'état + panneau + pont WebGL — cf. RouteTool.ts).
         Déclenché par les clics ports/waypoints (this.routeTool.start/finish/addWp) ; armé par la barre d'outils. ---- */

  /** Libellé court d'un port (équipement : port) — PARTAGÉ avec les tooltips de câble et le panneau de route. */
  protected portShort(portId: string): string { const p: any = this.store.get("ports", portId); if (!p) return I18n.t("dc.interact.portUnknown"); const e: any = this.store.get("equipments", p.equipment_id); return (e ? (e.name || I18n.t("lists.ph.equipment")) + " : " : "") + (p.name || I18n.t("dc.common.port")); }


  /* ===================== OUTIL DE POSITIONNEMENT — adaptation de VUE =====================
     L'outil lui-même (état, overlay, cotes, panneau, glisser aimanté) vit dans `PositioningTool` (module dédié,
     piloté par l'interface `PositioningHost`). Ici, la vue Datacenter n'en fournit que l'ADAPTATION : `posScene()`
     déclare les entités déplaçables de la vue courante (UNIQUE point spécifique), plus quelques services (échelle,
     gRoot, contexte…). Disponible dans LES DEUX vues 2D : Plan de salle (baies + équipements libres) et Plan d'étage
     (salles + équipements d'étage). L'instance `this.posTool` est créée dans DcBase. */

  /** Scène de positionnement courante : le CADRE + les ENTITÉS déplaçables (avec leur écriture propre). UNIQUE point
      d'adaptation de l'outil — chaque vue 2D y déclare ses entités déplaçables :
      • Plan de SALLE (top)  : baies (centre dc_x/dc_y) + équipements libres de la salle (centre dc_x/dc_y).
      • Plan d'ÉTAGE (floor) : salles (coin haut-gauche floor_x/floor_y, emprise orientée) + équipements d'étage (centre floor_x/floor_y).
      Bornage à la salle + garde « case inaccessible » (baies/équipements en salle) sont portés par chaque `commit`. */
  posScene(): PosScene | null {
    const clamp = (cx: number, cy: number, hx: number, hy: number, frame: Frame) => ({ x: Math.min(Math.max(cx, hx), frame.w - hx), y: Math.min(Math.max(cy, hy), frame.h - hy) });
    if (this.view === "top") {
      const dc = this.current(); if (!dc) return null;
      const frame: Frame = { w: dc.width_mm, h: dc.depth_mm };
      const rects: PosEntry[] = [];
      this.racks(dc.id).forEach((r: any) => {
        if (this.hidden3dRacks.has(r.id) || PlacementLock.isLocked(r)) return;   // verrouillé : non déplaçable par l'outil de positionnement
        const ext = this.rackHalfExtents(r), o = Normalize.rackOrientation(r.orientation);
        rects.push({ id: r.id, name: r.name || I18n.t("lists.ph.rack"), orient: o, anchor: "center", rect: { cx: (r.dc_x != null ? r.dc_x : ext.hx), cy: (r.dc_y != null ? r.dc_y : ext.hy), hx: ext.hx, hy: ext.hy },
          commit: async (cx, cy) => {
            const c = clamp(cx, cy, ext.hx, ext.hy, frame);
            if (GridGeometry.spanHitsBlocked(dc.blocked_cells, c.x - ext.hx, c.y - ext.hy, c.x + ext.hx, c.y + ext.hy, dc.cell_mm)) { Notify.toast(I18n.t("dc.common.blockedCell"), "err"); return; }
            await this.store.update("racks", r.id, { dc_x: Math.round(c.x), dc_y: Math.round(c.y) }); this.host.setDirty?.(true);
          } });
      });
      this.store.freeEquipsOfDc(dc.id).forEach((eq: any) => {
        if (eq.dc_x == null || eq.dc_y == null || PlacementLock.isLocked(eq)) return;   // seulement les équipements PLACÉS au sol et NON verrouillés
        const ext = FreeEquipGeometry.halfExtents(eq), o = Normalize.rackOrientation(eq.dc_orientation);
        rects.push({ id: eq.id, name: eq.name || I18n.t("lists.ph.equipment"), orient: o, anchor: "center", rect: { cx: eq.dc_x, cy: eq.dc_y, hx: ext.hx, hy: ext.hy },
          commit: async (cx, cy) => {
            const c = clamp(cx, cy, ext.hx, ext.hy, frame);
            if (GridGeometry.spanHitsBlocked(dc.blocked_cells, c.x - ext.hx, c.y - ext.hy, c.x + ext.hx, c.y + ext.hy, dc.cell_mm)) { Notify.toast(I18n.t("dc.common.blockedCell"), "err"); return; }
            await this.store.update("equipments", eq.id, { dc_x: Math.round(c.x), dc_y: Math.round(c.y) }); this.host.setDirty?.(true);
          } });
      });
      // PORTES : entités déplaçables contraintes à leur mur (adaptation portée par DoorTool.posEntries).
      rects.push(...this.doorTool.posEntries(dc));
      return { frame, rects };
    }
    if (this.view === "floor") {
      const ft = this.floorTargetResolve(); if (!ft) return null;
      const loc = ft.location || "", fl = String(ft.floor || ""), cfg = this.floor.config(loc, fl);
      const frame: Frame = { w: cfg.width_mm, h: cfg.depth_mm };
      const rects: PosEntry[] = [];
      this.store.dcsOfFloor(loc, fl).forEach((d: any) => {
        const fp = FloorLayout.roomFootprint(d), pos = this.floor.roomPos(d, cfg), hx = fp.w / 2, hy = fp.h / 2;
        rects.push({ id: d.id, name: (d.name || I18n.t("lists.ph.room")) + (d.room ? " · " + d.room : ""), orient: 0, anchor: "topleft", rect: { cx: pos.x + hx, cy: pos.y + hy, hx, hy },
          commit: async (cx, cy) => {
            const c = clamp(cx, cy, hx, hy, frame);
            await this.store.update("datacenters", d.id, { floor_x: Math.round(c.x - hx), floor_y: Math.round(c.y - hy) }); this.host.setDirty?.(true);
          } });
      });
      this.store.floorEquipments().filter((e: any) => (e.location || "") === loc && String(e.floor || "") === fl).forEach((eq: any) => {
        if (PlacementLock.isLocked(eq)) return;   // verrouillé : non déplaçable par l'outil de positionnement
        const ext = FreeEquipGeometry.halfExtents(eq), o = Normalize.rackOrientation(eq.dc_orientation), pos = FloorLayout.floorEquipPos(eq, cfg);
        rects.push({ id: eq.id, name: eq.name || I18n.t("lists.ph.equipment"), orient: o, anchor: "center", rect: { cx: pos.x, cy: pos.y, hx: ext.hx, hy: ext.hy },
          commit: async (cx, cy) => {
            const c = clamp(cx, cy, ext.hx, ext.hy, frame);
            await this.store.update("equipments", eq.id, { floor_x: Math.round(c.x), floor_y: Math.round(c.y), location: loc, floor: fl }); this.host.setDirty?.(true);
          } });
      });
      return { frame, rects };
    }
    return null;
  }
  /* -- autres services fournis à PositioningTool (cf. PositioningHost) -- */
  posCtxKey(): string { return this.measureTool.ctxKey(); }                              // même portée que la mesure (salle / étage)
  posIs2D(): boolean { return this.view === "top" || this.view === "floor"; }
  posViewKind(): "top" | "floor" | "3d" { return this.view; }
  posScale(): number { return this.scale || 1; }
  posGRoot(): SVGGElement | null { return this.gRoot; }
  posClearOtherTools(): void { this.measureTool.state = null; this.routeTool.state = null; }   // exclusivité : un seul outil de clic à la fois




  /* ============================ PONT OUTILS ↔ moteur WebGL (mesure / routage 3D) ============================
     En 3D-WebGL il n'y a pas de <svg> : le moteur Three.js intercepte clics/survols et remonte les points monde
     (raycast natif) aux OUTILS (measureTool.state / routeTool.state) + le panneau, puis repousse l'overlay. */

  /** (Ré)applique au moteur WebGL le mode outil + l'overlay courant (appelé après chaque (re)rendu 3D-WebGL).
      DISPATCHER des outils de clic 3D : mesure (délégué à MeasureTool) OU routage, sinon aucun. */
  protected syncWebglTool(): void {
    const t = this._three; if (!t) return;
    if (this.measureTool.activeHere()) this.measureTool.syncWebgl();   // mode « measure » + overlay (cf. MeasureTool)
    else if (this.routeTool.active) this.routeTool.syncWebgl();        // mode « route » + overlay (cf. RouteTool)
    else t.setToolMode("none");
  }
  /* Clic / survol MESURE = MeasureTool.onWebglPlace/onWebglHover ; ROUTE = RouteTool.onWebglPick/onWebglHover (câblés dans DcBase). */


  /* ============================ « LOCALISER » : focus 3D sur un objet (depuis un listing / une fiche) ============================ */

  /** Pousse la cible « Localiser » au moteur WebGL (appelé après chaque (re)rendu 3D). La surbrillance de
      l'équipement localisé est réappliquée à chaque rendu (suit `focusEqId`) ; le cadrage caméra n'est joué qu'une fois. */
  protected applyFocus3D(): void {
    if (!this._three) return;
    this._three.setFocusEquip(this.focusEqId, this.focusPortId);
    if (this._focusTarget) { this._three.focusOn(this._focusTarget.p, this._focusTarget.extent, this._focusTarget.face); this._focusTarget = null; }
  }

  /** Centre monde (mm) d'un équipement dans la salle `dcId` (repère salle = monde en mode simple DC), ou null. */
  protected equipCenter(e: any, dcId: string): Vec3 | null {
    if (e.dim_mode === "free") { if (e.dc_id !== dcId || e.dc_x == null || e.dc_y == null) return null; const b = FreeEquipGeometry.box(e); return { x: e.dc_x, y: e.dc_y, z: b.z + b.h / 2 }; }
    if (e.placement_mode === "rack" && e.rack_id && e.rack_u != null) {
      const rk: any = this.store.get("racks", e.rack_id); if (!rk || rk.datacenter_id !== dcId) return null;
      return { x: (rk.dc_x != null) ? rk.dc_x : 0, y: (rk.dc_y != null) ? rk.dc_y : 0, z: RackGeometry.uBaseZ(rk) + ((e.rack_u - 1) + Math.max(1, e.u_height | 0 || 1) / 2) * U_MM };
    }
    if ((e.placement_mode === "side" || e.placement_mode === "wall") && e.rack_id) {
      const rk: any = this.store.get("racks", e.rack_id); if (!rk || rk.datacenter_id !== dcId) return null;
      return { x: (rk.dc_x != null) ? rk.dc_x : 0, y: (rk.dc_y != null) ? rk.dc_y : 0, z: RackGeometry.physHeight(rk) / 2 };
    }
    return null;
  }

  protected portDcId(portId: string | null): string | null { const p: any = this.store.get("ports", portId); return p ? this.store.equipmentDcId(p.equipment_id) : null; }

  /** Bascule en 3D sur la salle `dcId` (mode simple DC) et programme le focus caméra sur `p` (emprise `extent` mm).
      `face` (optionnel) oriente la caméra face au front de l'objet ; sinon l'angle courant est conservé. */
  protected focus3DAt(dcId: string, p: Vec3, extent: number, face?: { az: number; el: number } | null): void {
    this.view = "3d"; this.multiDc = false; this.dcId = dcId;
    this._focusTarget = { p, extent, face: face || null };
    this.buildToolbar(); this.render();
  }

  /** Angle caméra « en face » d'une face, tournée de `orientationDeg`. Face avant = −Y local (normale monde
      (sin o, −cos o)) ; `rear` vise la face ARRIÈRE (+Y local). Caméra de ce côté, légèrement en surplomb (~20°). */
  protected frontAzimuth(orientationDeg: number, rear = false): { az: number; el: number } {
    const o = Normalize.rackOrientation(orientationDeg) * Math.PI / 180, s = rear ? -1 : 1;
    return { az: Math.atan2(-s * Math.cos(o), s * Math.sin(o)), el: Math.PI / 9 };
  }

  /** Prépare le focus sur un équipement : surbrillance (focusEqId) + isolement de la baie s'il est en baie.
      Retourne l'angle « en face de L'ÉQUIPEMENT » (et non de la baie) : un équipement monté à l'arrière (rack_side
      « rear ») se regarde depuis l'arrière de la baie ; un boîtier libre depuis sa propre orientation. */
  protected aimAtEquip(e: any, dcId: string): { az: number; el: number } {
    this.focusEqId = e.id;
    const inRack = (e.placement_mode === "rack" || e.placement_mode === "side" || e.placement_mode === "wall") && e.rack_id;
    if (inRack) {
      const rk: any = this.store.get("racks", e.rack_id);
      this.selRackId = e.rack_id;
      // isoler la baie : ne montrer que celle-ci dans la salle (les autres baies sont masquées)
      this.hidden3dRacks = new Set(this.store.racksOfDc(dcId).map((r: any) => r.id)); this.hidden3dRacks.delete(e.rack_id);
      const rear = (e.placement_mode === "rack" && e.rack_side === "rear");   // monté à l'arrière → face arrière de la baie
      return this.frontAzimuth(rk ? rk.orientation : 0, rear);
    }
    this.selRackId = null;
    return this.frontAzimuth(e.dc_orientation);
  }

  /** Action du bouton « Retour » (contrôles 3D) : rouvre la modale / revient à l'onglet d'origine. null = masqué. */
  setReturnAction(fn: (() => void) | null): void { this._returnAction = fn || null; this.updateBackBtn(); }
  protected updateBackBtn(): void {
    if (!this.controlsEl) return;
    const show = !!this._returnAction;
    const btn = this.controlsEl.querySelector('[data-act="back"]') as HTMLElement | null;
    const sep = this.controlsEl.querySelector('[data-back-sep]') as HTMLElement | null;
    if (btn) btn.style.display = show ? "" : "none";
    if (sep) sep.style.display = show ? "" : "none";
  }
  protected goBack(): void { const fn = this._returnAction; this._returnAction = null; this.updateBackBtn(); if (fn) fn(); }

  /** « Localiser » : affiche la vue 3D centrée sur l'objet (équipement / baie / câble / port / salle). API publique
      (shell + champ de recherche). Peuple le champ de recherche avec le libellé de l'objet (cohérence boutons « pin »). */
  locate(kind: "equipment" | "rack" | "cable" | "port" | "room" | "waypoint", id: string): void {
    const label = this.locateLabel(kind, id); if (label) this.searchTerm = label;
    this.focusPortId = null;   // réinitialisé ; seul locatePort le repositionne

    if (kind === "equipment") this.locateEquipment(id);
    else if (kind === "rack") this.locateRack(id);
    else if (kind === "cable") this.locateCable(id);
    else if (kind === "port") this.locatePort(id);
    else if (kind === "room") this.locateRoom(id);
    else if (kind === "waypoint") this.locateWaypoint(id);
  }

  /** Libellé d'affichage d'un objet localisable (pour peupler le champ de recherche). */
  protected locateLabel(kind: string, id: string): string {
    if (kind === "equipment") { const e: any = this.store.get("equipments", id); return e ? (e.name || I18n.t("lists.ph.equipment")) : ""; }
    if (kind === "rack") { const r: any = this.store.get("racks", id); return r ? (r.name || I18n.t("lists.ph.rack")) : ""; }
    if (kind === "room") { const d: any = this.store.get("datacenters", id); return d ? (d.name || I18n.t("lists.ph.room")) : ""; }
    if (kind === "cable") { const c: any = this.store.get("cables", id); return c ? this.cableLabelShort(c) : ""; }
    if (kind === "port") { const p: any = this.store.get("ports", id); const e: any = p ? this.store.get("equipments", p.equipment_id) : null; return p ? ((e && e.name ? e.name + " · " : "") + (p.name || I18n.t("dc.common.port"))) : ""; }
    if (kind === "waypoint") { const w: any = this.store.get("waypoints", id); return w ? (Waypoint.glyph(w) + " " + (w.name || I18n.t("dc.common.waypoint"))) : ""; }
    return "";
  }

  /** Localise une SALLE : bascule en 3D mode simple DC sur cette salle, sans isolement de baie ni cible précise. */
  locateRoom(dcId: string): void {
    const d: any = this.store.get("datacenters", dcId); if (!d) return;
    this.view = "3d"; this.multiDc = false; this.dcId = dcId;
    this.selRackId = null; this.focusEqId = null; this.hidden3dRacks = new Set();
    this.camTarget = null; this.scale = null;
    this.buildToolbar(); this.render();
  }

  /** Bouton « ✕ » du champ de recherche : efface toute mise en évidence (surbrillance, sélection, isolement de baie). */
  clearHighlight(): void {
    this.searchTerm = ""; this.focusEqId = null; this.selRackId = null;
    this.selCables = new Set(); this.hidden3dRacks = new Set();
    this.buildToolbar(); this.render();
  }

  locateEquipment(eqId: string): void {
    const e: any = this.store.get("equipments", eqId); if (!e) return;
    const dcId = this.store.equipmentDcId(eqId);
    if (!dcId) { Notify.toast(I18n.t("dc.interact.equipNotInRoom"), "err"); return; }
    const face = this.aimAtEquip(e, dcId);
    // en baie : emprise = hauteur de la baie isolée (on la voit entière) ; sinon ~1,6 m autour du boîtier.
    const rk: any = (this.selRackId) ? this.store.get("racks", this.selRackId) : null;
    const extent = rk ? Math.max(RackGeometry.physHeight(rk), 1600) : 1600;
    this.focus3DAt(dcId, this.equipCenter(e, dcId) || { x: 0, y: 0, z: 0 }, extent, face);
  }

  locateRack(rackId: string): void {
    const rk: any = this.store.get("racks", rackId); if (!rk) return;
    const dcId = rk.datacenter_id;
    if (!dcId) { Notify.toast(I18n.t("dc.interact.rackNotInRoom"), "err"); return; }
    this.selRackId = rackId; this.focusEqId = null;
    const H = RackGeometry.physHeight(rk);
    this.focus3DAt(dcId, { x: (rk.dc_x != null) ? rk.dc_x : 0, y: (rk.dc_y != null) ? rk.dc_y : 0, z: H / 2 }, H, this.frontAzimuth(rk.orientation));
  }

  locateCable(cableId: string): void {
    const c: any = this.store.get("cables", cableId); if (!c) return;
    const dcId = this.portDcId(c.from_port_id) || this.portDcId(c.to_port_id);
    if (!dcId) { Notify.toast(I18n.t("dc.interact.cableNotInRoom"), "err"); return; }
    const a = this.resolver.resolvePort3D(c.from_port_id, dcId) || this.resolver.resolvePort3D(c.to_port_id, dcId);
    if (!a) { Notify.toast(I18n.t("dc.interact.cableEndNotFound"), "err"); return; }
    this.selCables.add(cableId); this.showAllCables = true; this.focusEqId = null;
    this.focus3DAt(dcId, { x: a.x, y: a.y, z: a.z }, 2500);
  }

  locateWaypoint(wpId: string): void {
    const wp: any = this.store.get("waypoints", wpId); if (!wp) return;
    const dcId = wp.datacenter_id;
    if (!dcId || !this.store.waypointIsPlaced(wp)) { Notify.toast(I18n.t("dc.interact.wpNotInRoom"), "err"); return; }
    this.focusEqId = null; this.selRackId = null; this.selWaypointId = wpId;
    const a = this.resolver.waypointAnchor(wp);
    this.focus3DAt(dcId, { x: a.x, y: a.y, z: a.z }, 1200);
  }

  locatePort(portId: string): void {
    const p: any = this.store.get("ports", portId); if (!p) return;
    const dcId = this.store.equipmentDcId(p.equipment_id);
    if (!dcId) { Notify.toast(I18n.t("dc.interact.portEquipNotInRoom"), "err"); return; }
    const pt = this.resolver.resolvePort3D(portId, dcId);
    if (!pt) { Notify.toast(I18n.t("dc.interact.portNotFound3d"), "err"); return; }
    const e: any = this.store.get("equipments", p.equipment_id);
    // surbrillance de l'équipement ET du PORT + isolement de sa baie + orientation « en face » ; cadrage serré.
    const face = e ? this.aimAtEquip(e, dcId) : null;
    this.focusPortId = portId;   // le port lui-même est mis en évidence (même ambre que l'équipement)
    this.focus3DAt(dcId, { x: pt.x, y: pt.y, z: pt.z }, 700, face);
  }

}
