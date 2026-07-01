import type { Store } from "../../store";
import { Dom } from "../../ui/Dom";
import { FormControls } from "../../ui/FormControls";
import { Dialog } from "../../ui/Dialog";
import { Notify } from "../../ui/Notify";
import { ContextMenu } from "../../ui/ContextMenu";
import type { CtxSection } from "../../ui/ContextMenu";
import { ImageExport } from "../../ui/ImageExport";
import type { ExportOptions } from "../../ui/ImageExport";
import { Html } from "../../core/Html";
import { Normalize } from "../../core/Normalize";
import { RackGeometry } from "../../geometry/RackGeometry";
import { RackScene } from "../../geometry/RackScene";
import { FreeEquipGeometry } from "../../geometry/FreeEquipGeometry";
import { Resolver3D } from "../../geometry/Resolver3D";
import { FloorLayout } from "../../geometry/FloorLayout";
import type { MultiLayout, RoomPlacement } from "../../geometry/FloorLayout";
import { Box } from "../../geometry/Box";
import { Painter } from "../../geometry/Painter";
import { GridGeometry } from "../../geometry/GridGeometry";
import type { Frame } from "../../geometry/Positioning";
import type { PosEntry, PosScene } from "./PositioningTool";
import { Depths } from "../../registries/Depths";
import { EquipmentTypes } from "../../registries/EquipmentTypes";
import { RackItemKinds } from "../../domain/RackItemKinds";
import { Format } from "../../core/Format";
import { Text } from "../../core/Text";
import { Waypoint } from "../../models/Waypoint";
import { CableStatuses } from "../../domain/CableStatuses";
import { RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_EAR_MM, U_MM, SIDE_U_STEP, BRUSH_PADDING_MM } from "../../domain/constants";
import { DC_DOT_PX, WP_HIT_PX, CABLE_PORT_STUB_MM, CABLE_SPLINE_K, CAM_PRESETS, DC_SCOPE_ICONS } from "./shared";
import type { Vec3, Drawable, DatacenterHost } from "./shared";
import { DcPanels } from "./DcPanels";

export class DcInteract extends DcPanels {

  /** Met en évidence (`.route-pick`) les waypoints DÉJÀ choisis dans la route en cours, sur tous les nœuds `[data-wp]`. */
  protected markRouteWaypoints(): void {
    if (!this.svg) return;
    const ids = new Set(this.routeBuild ? this.routeBuild.wpIds : []);
    this.svg.querySelectorAll("[data-wp]").forEach((n) => n.classList.toggle("route-pick", ids.has(n.getAttribute("data-wp") || "")));
  }

  protected showCote(text: string, clientX: number, clientY: number): void {
    if (!this.coteEl) { this.coteEl = document.createElement("div"); this.coteEl.className = "dc-cote"; this.stage.appendChild(this.coteEl); }
    this.coteEl.textContent = text; this.coteEl.style.display = "block";
    const r = this.stage.getBoundingClientRect(), z = this.uiZoom();   // /z : repère local zoomé du stage (cf. uiZoom)
    this.coteEl.style.left = ((clientX - r.left + 14) / z) + "px"; this.coteEl.style.top = ((clientY - r.top + 14) / z) + "px";
  }

  protected hideCote(): void { if (this.coteEl) this.coteEl.style.display = "none"; }


  /* ---- tooltips enrichis de scène (réplique de _showTip/_moveTip/_hideTip + builders HTML) ---- */
  protected showTip(html: string, ev: MouseEvent): void {
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
      this.tipRow(`<b>${w} × ${d} mm</b> · ${uMax} U · ${r.sides === "dual" ? "double face" : "simple face"}`),
      this.tipRow(`Orientation ${Normalize.rackOrientation(r.orientation)}°${r.row ? " · rangée " + Html.escape(r.row) : ""}`),
      this.tipRow(`<b>${eqCount}</b> équipement${eqCount > 1 ? "s" : ""}${itemCount ? " · " + itemCount + " élément" + (itemCount > 1 ? "s" : "") : ""} · ${usedU.size}/${uMax} U occupés`),
      this.tipRow(`<span style="color:var(--accent)">Cliquer pour éditer la baie</span>`),
    ];
    return `<div class="tt-title">${Html.escape(r.name || "(baie)")}</div>` + rows.join("");
  }

  /** Tooltip d'un équipement (type, marque/modèle, série, baie, groupe, nb de ports). */
  protected equipmentTipHtml(eqId: string): string {
    const e: any = this.store.get("equipments", eqId); if (!e) return "";
    const g: any = e.group_id ? this.store.get("groups", e.group_id) : null;
    const rk: any = e.rack_id ? this.store.get("racks", e.rack_id) : null;
    const nPorts = this.store.portsOf(e.id).length;
    const rows = [this.tipRow(`<b>${Html.escape(EquipmentTypes.label(e.type))}</b>${e.brand || e.model ? " · " + Html.escape([e.brand, e.model].filter(Boolean).join(" ")) : ""}`)];
    if (e.serial) rows.push(this.tipRow(`N/S : <b>${Html.escape(e.serial)}</b>`));
    if (e.rack_u != null) { const uh = Math.max(1, e.u_height | 0 || 1); rows.push(this.tipRow(`U${e.rack_u}${uh > 1 ? "–U" + (e.rack_u + uh - 1) : ""} · ${Html.escape(Depths.label(e.depth || "full"))}`)); }
    if (rk) rows.push(this.tipRow(`Baie : <b>${Html.escape(rk.name || "(baie)")}</b>${rk.row ? " · " + Html.escape(rk.row) : ""}`));
    if (g) rows.push(this.tipRow(`${this.tipSwatch(g.color)}${Html.escape(g.name || "")}`));
    rows.push(this.tipRow(`${nPorts} port${nPorts > 1 ? "s" : ""}`));
    return `<div class="tt-title">${Html.escape(e.name || "(équipement)")}</div>` + rows.join("");
  }

  /** Tooltip d'un port (équipement : port + état de câblage). */
  protected portTipHtml(port: any, cab: any): string {
    const eq: any = this.store.get("equipments", port.equipment_id);
    const head = (eq ? (eq.name || "(équip.)") + " : " : "") + (port.name || "(port)");
    return `<div class="tt-title">${Html.escape(head)}</div>`
      + (cab ? this.tipRow(`Câble : <b>${Html.escape(this.cableLabelShort(cab))}</b> — cliquer pour l'éditer`)
             : `<div class="tt-row" style="color:var(--accent)">Port libre — cliquer pour créer ou affecter un câble</div>`);
  }

  /** Tooltip d'un câble (type, faisceau, longueur, réseaux, extrémités, points de passage, état). */
  protected cableTipHtml(c: any): string {
    const ct: any = c.cable_type_id ? this.store.get("cableTypes", c.cable_type_id) : null;
    const bn: any = this.store.cableBundleOf(c);
    const rows: string[] = [];
    if (ct) rows.push(this.tipRow(`Type : <b>${Html.escape(ct.name || "")}</b>`));
    if (bn) rows.push(this.tipRow(`Faisceau : <b>${Html.escape(bn.name || "(trunk)")}</b>${c.strand_no != null ? " · brin " + c.strand_no + "/" + bn.fiber_count : ""}`));
    const len = (c.length_m != null) ? c.length_m : (bn && bn.length_m != null ? bn.length_m : null);
    if (len != null) rows.push(this.tipRow(`Longueur : <b>${len} m</b>${bn ? " (faisceau)" : ""}`));
    this.store.cableNetworkIds(c).forEach((nid: string) => { const n: any = this.store.get("networks", nid); if (!n) return; const star = (nid === c.network_id && this.store.cableNetworkIds(c).length > 1) ? " ★" : ""; rows.push(this.tipRow(`${this.tipSwatch(n.color)}${Html.escape(n.label || n.name || "(réseau)")}${star}`)); });
    rows.push(this.tipRow(`A : <b>${Html.escape(this.portShort(c.from_port_id))}</b>`));
    rows.push(this.tipRow(`B : <b>${Html.escape(this.portShort(c.to_port_id))}</b>`));
    const wps = (this.store.effectiveWaypointIds(c) || []).map((id: string) => this.store.get("waypoints", id)).filter(Boolean);
    if (wps.length) rows.push(this.tipRow(`Via : ${wps.map((w: any) => Html.escape(Waypoint.glyph(w) + " " + (w.name || "(waypoint)"))).join(" → ")}`));
    if (c.status) rows.push(this.tipRow(`État : ${Html.escape(CableStatuses.label(c.status))}`));
    return `<div class="tt-title">${Html.escape(this.cableLabelShort(c))}</div>` + rows.join("");
  }

  /** Tooltip d'un waypoint (type, forme/étage, hauteur, nb de câbles affectés). */
  protected wpTipHtml(wp: any): string {
    const n = this.store.cablesOfWaypoint(wp.id).length, floorLvl = Waypoint.isFloorLevel(wp);
    const kindLbl = Waypoint.typeOf(wp) === "exit" ? "Exit (sortie de salle)" : floorLvl ? "Pin d'étage" : (wp.kind === "segment" ? "Chemin de câbles" : wp.kind === "brush" ? "Brosse de brassage" : "Pin de salle");
    const where = floorLvl ? Html.escape(Waypoint.floorLabel(wp)) : "hauteur " + (wp.dc_z || 0) + " mm";
    return `<div class="tt-title">${Waypoint.glyph(wp)} ${Html.escape(wp.name || "(waypoint)")}</div>`
      + this.tipRow(`<b>${Html.escape(kindLbl)}</b>`)
      + this.tipRow(where)
      + this.tipRow(`${n} câble${n > 1 ? "s" : ""} affecté${n > 1 ? "s" : ""}`)
      + `<div class="tt-row" style="color:var(--accent)">Clic : modifier · clic droit : actions</div>`;
  }


  /** Glisser-déposer une baie (vue Dessus) : aimantation à la maille, bornée à la salle. */
  protected onRackPointerDown(e: MouseEvent, r: any): void {
    if (e.button !== 0) return;
    if (this.posTool.activeHere()) { this.posTool.dragEntity(e, r.id); return; }   // mode positionnement : glisser aimanté + sélection mover
    e.preventDefault(); e.stopPropagation();
    const dc = this.current(); if (!dc) return;
    this.selRackId = r.id; this.selEquipId = null; this.selWaypointId = null;
    if (this.svg) { this.svg.querySelectorAll(".dc-equip,.dc-wp").forEach((n) => n.classList.remove("sel")); this.svg.querySelectorAll(".dc-rack").forEach((n) => n.classList.toggle("sel", n.getAttribute("data-rack") === r.id)); }
    this.renderSide(dc);
    const grp = e.currentTarget as SVGElement;
    const ext = this.rackHalfExtents(r), o = Normalize.rackOrientation(r.orientation);
    const w0 = this.clientToWorld(e.clientX, e.clientY);
    const cx0 = (r.dc_x != null) ? r.dc_x : w0.x, cy0 = (r.dc_y != null) ? r.dc_y : w0.y, off = { x: w0.x - cx0, y: w0.y - cy0 };
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
      if (GridGeometry.spanHitsBlocked(dc.blocked_cells, c.x - ext.hx, c.y - ext.hy, c.x + ext.hx, c.y + ext.hy, dc.cell_mm)) { Notify.toast("Case inaccessible — placement refusé", "err"); this.render(); return; }
      await this.store.update("racks", r.id, { dc_x: c.x, dc_y: c.y }); this.host.setDirty?.(true);
    };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  }

  protected onEquipPointerDown(ev: MouseEvent, eq: any): void {
    if (ev.button !== 0) return;
    if (this.posTool.activeHere()) { this.posTool.dragEntity(ev, eq.id); return; }   // mode positionnement
    ev.preventDefault(); ev.stopPropagation();
    const dc = this.current(); if (!dc) return;
    this.selRackId = null; this.selEquipId = eq.id; this.selWaypointId = null;
    const grp = ev.currentTarget as SVGElement;
    if (this.svg) { this.svg.querySelectorAll(".dc-rack,.dc-equip,.dc-wp").forEach((n) => n.classList.remove("sel")); grp.classList.add("sel"); }
    this.renderSide(dc);
    const ext = FreeEquipGeometry.halfExtents(eq), o = Normalize.rackOrientation(eq.dc_orientation);
    const w0 = this.clientToWorld(ev.clientX, ev.clientY);
    const cx0 = (eq.dc_x != null) ? eq.dc_x : w0.x, cy0 = (eq.dc_y != null) ? eq.dc_y : w0.y, off = { x: w0.x - cx0, y: w0.y - cy0 };
    const clampC = (c: { x: number; y: number }) => ({ x: Math.min(Math.max(c.x, ext.hx), dc.width_mm - ext.hx), y: Math.min(Math.max(c.y, ext.hy), dc.depth_mm - ext.hy) });
    let cur = { x: cx0, y: cy0 }, moved = false;
    const move = (e2: MouseEvent) => {
      const w = this.clientToWorld(e2.clientX, e2.clientY), nx = w.x - off.x, ny = w.y - off.y;
      if (!moved && Math.abs(nx - cx0) + Math.abs(ny - cy0) < (8 / (this.scale || 1))) return;
      moved = true; grp.classList.add("dragging");
      cur = clampC({ x: nx, y: ny });
      grp.setAttribute("transform", `translate(${cur.x} ${cur.y}) rotate(${o})`);
      this.showCote(Format.meters(cur.x) + " × " + Format.meters(cur.y), e2.clientX, e2.clientY);
    };
    const up = async () => {
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
      grp.classList.remove("dragging"); this.hideCote();
      if (!moved) return;
      const c = this.freePlace ? clampC(cur) : clampC({ x: this.snap(cur.x, dc.cell_mm), y: this.snap(cur.y, dc.cell_mm) });
      if (GridGeometry.spanHitsBlocked(dc.blocked_cells, c.x - ext.hx, c.y - ext.hy, c.x + ext.hx, c.y + ext.hy, dc.cell_mm)) { Notify.toast("Case inaccessible — placement refusé", "err"); this.render(); return; }
      await this.store.update("equipments", eq.id, { dc_x: c.x, dc_y: c.y }); this.host.setDirty?.(true);
    };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
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
      for (let k = nlo; k <= nhi; k++) { if (occ.has(k + ":" + side)) { Notify.toast("Sélection interrompue par un emplacement occupé", "err"); return; } }
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
  /** Tooltip enrichi d'un pseudo-élément. */
  protected itemTipHtml(item: any): string {
    const kind = RackItemKinds.label(item.kind), uh = Math.max(1, (item.u_height | 0) || 1);
    const name = (item.label && item.label.trim()) ? item.label : kind;
    const rows = [
      this.tipRow(`<b>${Html.escape(kind)}</b>${item.depth === "none" ? " · sans profondeur" : ""}`),
      this.tipRow(`U${item.u}${uh > 1 ? "–U" + (item.u + uh - 1) : ""}${item.side === "rear" ? " · arrière" : (item.side === "front" ? " · avant" : "")}`),
      this.tipRow(`<span style="color:var(--accent)">Clic / clic droit : actions</span>`),
    ];
    return `<div class="tt-title">${Html.escape(name)}</div>` + rows.join("");
  }
  /** Menu d'un pseudo-élément (rackItem) : le retirer de la baie. */
  protected itemCtx(item: any): CtxSection[] {
    const name = (item.label && item.label.trim()) ? item.label : RackItemKinds.label(item.kind);
    return [{ head: name, items: [
      { label: "Retirer", danger: true, action: async () => { if (this.store.get("rackItems", item.id)) { await this.store.remove("rackItems", item.id); this.setDirty(); Notify.toast("Élément retiré"); } } },
    ] }];
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
      if (this.routeBuild) {   // routage : port de départ, puis port terminal
        if (!this.routeBuild.fromPortId) this.routeStart(port.id);
        else if (port.id !== this.routeBuild.fromPortId) this.routeFinish(port.id);
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
    const sel = FormControls.select([{ value: "", label: "➕ Nouveau câble" }].concat(cands.map((c: any) => {
      const ct: any = c.cable_type_id ? this.store.get("cableTypes", c.cable_type_id) : null, sum = this.store.cableRouteSummary(this.store.cableRoute(c));
      return { value: c.id, label: (c.name || "(brouillon)") + (ct ? " · " + ct.name : "") + (sum ? " · " + sum : "") };
    })), "");
    const body = document.createElement("div");
    const hint = document.createElement("div"); hint.className = "form-hint"; hint.textContent = "Des brouillons de câble attendent un port. Affecter ce port à l'un d'eux, ou créer un nouveau câble.";
    body.append(hint, FormControls.fieldRow("Câble", sel, "Le formulaire s'ouvre ensuite, port prérempli — vérifiez puis enregistrez."));
    const res = await Dialog.custom({ title: "Brancher le port", confirmLabel: "Continuer", build: (r: HTMLElement) => { r.appendChild(body); return { validate: () => true as const, collect: () => ({ cableId: sel.value }) }; } });
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
      { label: "Afficher " + noun + suf, action: () => { u.forEach((id) => this.selCables.add(id)); this.rerenderView(); } },
      { label: "Isoler " + noun + suf, action: () => { this.selCables = new Set(u); this.rerenderView(); } },
      { label: "Masquer " + noun + suf, action: () => { u.forEach((id) => this.selCables.delete(id)); this.rerenderView(); } },
    ];
  }

  protected portCtx(port: any, cab: any): CtxSection[] {
    const items: Array<{ label: string; danger?: boolean; action: () => void }> = [cab
      ? { label: "Éditer le câble…", action: () => this.host.openCableForm?.(cab.id) }
      : { label: "Créer / affecter un câble…", action: () => this.connectPort(port) }];
    if (this.routeBuild) { if (this.routeBuild.fromPortId && port.id !== this.routeBuild.fromPortId) items.push({ label: "Terminer la route ici", action: () => this.routeFinish(port.id) }); }
    else if (!cab) items.push({ label: "Démarrer une route ici", action: () => this.routeStart(port.id) });
    const secs: CtxSection[] = [{ head: port.name || "(port)", items }];
    const csi = this.cableSelItems(this.store.cablesOfPorts([port.id]).map((c: any) => c.id), "le câble du port");
    if (csi.length) secs.push({ items: csi });
    return secs;
  }

  /** Menu d'un équipement (occupant U / side / wall / libre) : détails · modifier · câble · retirer. */
  protected equipmentCtx(eqId: string): CtxSection[] {
    const e: any = this.store.get("equipments", eqId); if (!e) return [];
    const placed = !!(e.dc_id || e.rack_id);
    const removeAction = async () => {
      if (!this.store.get("equipments", eqId)) return;
      const ops: Array<{ collection: string; id: string; patch: Record<string, any> }> = e.dim_mode === "free"
        ? [{ collection: "equipments", id: eqId, patch: { dc_id: null, dc_x: null, dc_y: null, dc_z: 0 } }]
        : [{ collection: "equipments", id: eqId, patch: { placement_mode: "rack", dim_mode: "u", rack_id: null, rack_u: null } }];
      if (placed) ops.push(...this.store.cableDowngradeOps([eqId]));
      await this.store.updateBatch(ops); this.setDirty();
      Notify.toast("Équipement retiré du datacenter" + (ops.length > 1 ? " — câble(s) en « Planifié »" : ""));
    };
    const rotate = (deg: number) => async () => { const o: any = this.store.get("equipments", eqId); if (!o) return; await this.store.update("equipments", eqId, { dc_orientation: Normalize.rackOrientation((o.dc_orientation || 0) + deg) }); this.setDirty(); };
    const items: Array<{ label: string; danger?: boolean; action: () => void }> = [
      { label: "Détails…", action: () => this.host.openEquipmentDetail?.(eqId) },
      { label: "Modifier…", action: () => this.host.openEquipmentForm?.(eqId) },   // modale d'ÉDITION (pas la fiche d'info)
    ];
    // rotation au sol : pertinente pour un équipement LIBRE (boîtier orienté). En U, l'orientation suit la baie.
    if (e.dim_mode === "free") items.push({ label: "↻ Pivoter 90°", action: rotate(90) }, { label: "⟲ Pivoter 180°", action: rotate(180) });
    // masquage 3D/2D par ÉQUIPEMENT / TYPE / GROUPE (équipements libres) — piloté aussi depuis le panneau « Équipements libres ».
    if (e.dim_mode === "free") {
      const dcIds = this.displayedDcIds(this.current());
      const setHidden = (ids: string[], hide: boolean) => { ids.forEach((id) => { if (hide) this.hidden3dEquips.add(id); else this.hidden3dEquips.delete(id); }); this.reflow(); this.renderSide(this.current()); };
      const matching = (pred: (x: any) => boolean) => this.store.all("equipments").filter((x: any) => x.dim_mode === "free" && x.dc_x != null && dcIds.includes(x.dc_id) && pred(x)).map((x: any) => x.id);
      items.push({ label: this.hidden3dEquips.has(eqId) ? "Afficher cet équipement" : "Masquer cet équipement", action: () => setHidden([eqId], !this.hidden3dEquips.has(eqId)) });
      items.push({ label: "Masquer le type « " + EquipmentTypes.label(e.type) + " »", action: () => setHidden(matching((x) => x.type === e.type), true) });
      if (e.group_id) { const g: any = this.store.get("groups", e.group_id); items.push({ label: "Masquer le groupe « " + ((g && g.label) || "?") + " »", action: () => setHidden(matching((x) => x.group_id === e.group_id), true) }); }
    }
    items.push(
      { label: "Créer un câble…", action: () => this.host.openCableForm?.(null, { fromEqId: eqId }) },
      { label: placed ? "Retirer du datacenter" : "Renvoyer en « Non placé »", danger: true, action: removeAction },
    );
    const secs: CtxSection[] = [{ head: e.name || "(équipement)", items }];
    const csi = this.cableSelItems(this.store.cablesOfEquipment(eqId).map((c: any) => c.id), "les câbles de l'équipement");
    if (csi.length) secs.push({ items: csi });
    return secs;
  }

  /** Menu contextuel du PERSONNAGE d'échelle (repère de vue) : pivoter · masquer. Aucune mutation du document. */
  protected figureCtx(): CtxSection[] {
    return [{ head: "🧍 Personnage (échelle)", items: [
      { label: "↻ Pivoter 90°", action: () => { if (this.figure) { this.figure.orient = Normalize.rackOrientation((this.figure.orient || 0) + 90); this.persistView(); this.reflow(); } } },
      { label: "Masquer le personnage", danger: true, action: () => { this.showFigure = false; this.persistView(); this.buildToolbar(); this.render(); } },
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
    const need = () => Notify.toast("Aucune salle ici — activez/placez une salle d'abord", "err");
    return { head: "Vue", items: [
      { label: cur("3d") + "Vue 3D", action: () => (dc ? this.activateView("3d", dc) : need()) },
      { label: cur("top") + "Plan de salle", action: () => (dc ? this.activateView("top", dc) : need()) },
      { label: cur("floor") + "Plan d'étage", action: () => { this.floorTarget = { location: loc, floor: fl }; this.view = "floor"; this.selRackId = null; this.camTarget = null; this.scale = null; this.buildToolbar(); this.render(); } },
    ] };
  }
  protected viewSwitchSection(dc: any): CtxSection { return this.viewSwitchSectionAt(dc, dc.location || "", String(dc.floor || "")); }
  /** Menu d'une SALLE en 3D multi-salles (clic droit sur son sol) : activer ce DC · isoler · modifier + bascule de vue. */
  protected roomCtx(dc: any): CtxSection[] {
    const items: Array<{ label: string; danger?: boolean; action: () => void }> = [];
    if (this.multiDc) {   // activer / isoler / quitter le multi-DC n'ont de sens qu'en mode Multi-DC
      items.push({ label: "Activer ce DC", action: () => this.activateDc(dc.id, false) });   // devient la salle active (affichage inchangé)
      // Isoler : RESTE en Multi-DC mais n'affiche QUE ce DC (visibleDcIds = {ce DC}) — distinct du mode simple.
      items.push({ label: "Isoler ce DC (afficher seul)", action: () => { this.dcId = dc.id; this.selRackId = null; this.visibleDcIds = new Set([dc.id]); this.camTarget = null; this.scale = null; this.buildToolbar(); this.render(); } });
      items.push({ label: "Passer en mode simple DC", action: () => this.activateDc(dc.id, true) });   // quitte le Multi-DC, sur ce DC
    }
    // afficher toutes les baies — seulement si au moins une baie de CE DC est masquée
    const dcRacks = this.store.racksOfDc(dc.id);
    if (dcRacks.some((r: any) => this.hidden3dRacks.has(r.id))) {
      items.push({ label: "Afficher toutes les baies", action: () => { dcRacks.forEach((r: any) => this.hidden3dRacks.delete(r.id)); this.render(); } });
    }
    items.push({ label: "Modifier la salle…", action: () => this.host.openDatacenterForm?.(dc.id) });
    return [
      { head: dc.name || "(salle)", items },
      this.viewSwitchSection(dc),
    ];
  }
  protected rackCtx(rack: any): CtxSection[] {
    const hidden = this.hidden3dRacks.has(rack.id);
    const items: any[] = [
      { label: "Modifier…", action: () => this.host.openRackForm?.(rack.id) },
      { label: "Isoler la baie", action: () => this.isolateRack(rack.id) },
      { label: hidden ? "Afficher la baie" : "Masquer la baie", action: () => { if (hidden) this.hidden3dRacks.delete(rack.id); else this.hidden3dRacks.add(rack.id); this.render(); } },
    ];
    // masquage des portes : bascule GLOBALE (toutes les portes) = même état que le toggle « Portes des baies » du panneau (3D)
    if (RackGeometry.hasDoor(rack) && this.view === "3d") items.push({ label: this.showDoors ? "Masquer les portes (toutes)" : "Afficher les portes (toutes)", action: () => { this.showDoors = !this.showDoors; this.rerenderView(); } });
    const secs: CtxSection[] = [{ head: rack.name || "(baie)", items: items.concat([
      { label: "Retirer du datacenter", danger: true, action: async () => {
          if (!this.store.get("racks", rack.id)) return;
          const eqIds = this.store.equipmentsOfRack(rack.id).filter((e: any) => e.placement_mode === "rack" && e.rack_u != null).map((e: any) => e.id);
          const ops: Array<{ collection: string; id: string; patch: Record<string, any> }> = [{ collection: "racks", id: rack.id, patch: { datacenter_id: null, dc_x: null, dc_y: null } }];
          if (rack.datacenter_id) ops.push(...this.store.cableDowngradeOps(eqIds));
          await this.store.updateBatch(ops); this.setDirty(); Notify.toast("Baie retirée — replacée dans le pool");
        } },
    ]) }];
    const rackCableIds = this.store.equipmentsOfRack(rack.id).flatMap((e: any) => this.store.cablesOfEquipment(e.id).map((c: any) => c.id));
    const csi = this.cableSelItems(rackCableIds, "les câbles de la baie");
    if (csi.length) secs.push({ items: csi });
    return secs;
  }

  protected waypointCtx(wp: any): CtxSection[] {
    const nCab = this.store.cablesOfWaypoint(wp.id).length;
    const items: Array<{ label: string; danger?: boolean; action: () => void }> = [];
    if (this.routeBuild && this.routeBuild.fromPortId) items.push({ label: "Ajouter à la route", action: () => this.routeAddWp(wp.id) });
    items.push({ label: "Modifier…", action: () => this.host.openWaypointForm?.(wp.id) });
    items.push({ label: "Retirer de la salle", danger: true, action: async () => { if (!this.store.get("waypoints", wp.id)) return; await this.store.update("waypoints", wp.id, { datacenter_id: null, dc_x: null, dc_y: null, dc_x2: null, dc_y2: null }); this.setDirty(); } });
    items.push({ label: "Supprimer", danger: true, action: async () => {
        const ok = await Dialog.confirm({ title: "Supprimer le waypoint", danger: true, message: `Supprimer « ${wp.name || "(waypoint)"} » ?` + (nCab ? ` Les ${nCab} câble(s) qui le traversent seront détachés.` : "") });
        if (!ok || !this.store.get("waypoints", wp.id)) return;
        await this.store.remove("waypoints", wp.id); this.setDirty(); Notify.toast("Waypoint supprimé");
      } });
    const secs: CtxSection[] = [{ head: Waypoint.glyph(wp) + " " + (wp.name || "(waypoint)"), items }];
    const csi = this.cableSelItems(this.store.cablesOfWaypoint(wp.id).map((c: any) => c.id), wp.kind === "brush" ? "les câbles de la brosse" : "les câbles passant ici");
    if (csi.length) secs.push({ items: csi });
    return secs;
  }

  protected cableCtx(cable: any): CtxSection[] {
    let detach: { label: string; patch: Record<string, any>; msg: string } | null = null;
    if (cable.status === "cable" || cable.status === "a-remplacer") detach = { label: "Détacher (→ Planifié)", patch: { status: "planifie" }, msg: "Câble détaché — « Planifié »" };
    else if (cable.status === "planifie") detach = { label: "Détacher (→ Brouillon)", patch: { status: "brouillon", from_port_id: null, to_port_id: null, waypoint_ids: [] }, msg: "Câble détaché — assignation retirée" };
    const items: Array<{ label: string; danger?: boolean; action: () => void }> = [{ label: "Modifier le câble…", action: () => this.host.openCableForm?.(cable.id) }];
    if (detach) items.push({ label: detach.label, action: async () => { if (!this.store.get("cables", cable.id)) return; await this.store.update("cables", cable.id, detach!.patch); this.setDirty(); Notify.toast(detach!.msg); } });
    items.push({ label: "Supprimer le câble", danger: true, action: async () => { const ok = await Dialog.confirm({ title: "Supprimer ?", message: `Supprimer « ${cable.name || "ce câble"} » ?`, confirmLabel: "Supprimer", danger: true }); if (!ok || !this.store.get("cables", cable.id)) return; await this.store.remove("cables", cable.id); this.setDirty(); Notify.toast("Câble supprimé"); } });
    return [{ head: cable.name || "(câble)", items }, { items: this.cableSelItems([cable.id], "ce câble") }];
  }

  /** Menu du SOL (vue Dessus) : créer un waypoint (pin / chemin / exit) au point cliqué (aimanté ½ maille). */
  protected floorCtx(dc: any, w: { x: number; y: number }): CtxSection[] {
    const snapHalf = (v: number) => Math.round(v / (dc.cell_mm / 2)) * (dc.cell_mm / 2);
    const x = snapHalf(w.x), y = snapHalf(w.y);
    const baseName = () => "WP-" + (this.store.all("waypoints").length + 1);
    const sel = async (wp: any) => { this.selWaypointId = wp.id; this.setDirty(); };
    return [{ head: "Waypoint — point de passage de câbles", items: [
      { label: "◆ Ajouter un pin ici", action: async () => { sel(await this.store.create("waypoints", { name: baseName(), kind: "point", datacenter_id: dc.id, dc_x: x, dc_y: y })); Notify.toast("Pin créé — glissez-le pour l'ajuster"); } },
      { label: "▬ Ajouter un chemin de câbles ici", action: async () => { const h = dc.cell_mm; sel(await this.store.create("waypoints", { name: baseName(), kind: "segment", datacenter_id: dc.id, dc_x: Math.max(0, x - h), dc_y: y, dc_x2: Math.min(dc.width_mm, x + h), dc_y2: y })); Notify.toast("Chemin de câbles créé — glissez ses extrémités"); } },
      { label: "⏏ Ajouter un exit (sortie de salle) ici", action: async () => { const nx = this.store.all("waypoints").filter((w2: any) => Waypoint.typeOf(w2) === "exit").length + 1; sel(await this.store.create("waypoints", { name: "EXIT-" + nx, wp_type: "exit", kind: "point", datacenter_id: dc.id, dc_x: x, dc_y: y })); Notify.toast("Exit créé — un câble sort par une PAIRE d'exits"); } },
    ] }, this.viewSwitchSection(dc)];
  }

  /* ---- menus contextuels du PLAN D'ÉTAGE (sol / salle / équipement) ---- */
  /** Menu du SOL du plan d'étage : créer une salle / un OOB (au point aimanté ½ maille) / éditer le plan. */
  protected floorPlaneCtx(loc: string, fl: string, w: { x: number; y: number }): CtxSection[] {
    const cfg = this.floor.config(loc, fl), half = (cfg.cell_mm || 1000) / 2;
    const x = Math.round(w.x / half) * half, y = Math.round(w.y / half) * half;
    return [{ head: "Plan d'étage — " + this.store.siteLabel(loc) + " · ét. " + (fl || "0"), items: [
      { label: "+ Ajouter une salle…", action: () => this.host.openDatacenterForm?.("") },
      { label: "◎ Ajouter un pin d'étage ici", action: async () => { const wp: any = await this.store.create("waypoints", { name: "PIN-" + (this.store.oobWaypoints().length + 1), kind: "point", location: loc, floor: fl, floor_x: x, floor_y: y }); this.selWaypointId = wp.id; this.setDirty(); Notify.toast("Pin d'étage créé — glissez-le, éditez sa hauteur (clic droit)"); } },
      { label: "Éditer le plan d'étage…", action: () => this.editFloor(loc, fl, false) },
    ] }, this.viewSwitchSectionAt(this.store.dcsOfFloor(loc, fl)[0] || null, loc, fl)];
  }

  /** Menu de la DALLE d'étage en 3D multi-salles (clic droit) : éditer le plan · ajouter une salle · vue Étage 2D. */
  protected floorPlane3DCtx(loc: string, fl: string): CtxSection[] {
    fl = String(fl || "");
    return [{ head: "Étage — " + (this.store.siteLabel(loc) || "(bâtiment ?)") + " · ét. " + (fl || "0"), items: [
      { label: "Éditer le plan d'étage…", action: () => this.editFloor(loc, fl, false) },
      { label: "+ Ajouter une salle (DC) à cet étage…", action: () => this.host.openDatacenterForm?.("") },
      { label: "Vue Étage (2D)", action: () => { this.floorTarget = { location: loc, floor: fl }; this.view = "floor"; this.scale = null; this.buildToolbar(); this.render(); } },
    ] }];
  }

  /** Menu d'une salle dans le plan d'étage : pivoter / ouvrir (plan de salle) / modifier / position auto. */
  protected floorRoomCtx(d: any): CtxSection[] {
    return [{ head: d.name || "(salle)", items: [
      { label: "↻ Pivoter 90°", action: async () => { await this.store.update("datacenters", d.id, { floor_orientation: Normalize.rackOrientation((d.floor_orientation || 0) + 90) }); this.selRoomId = d.id; this.setDirty(); } },
      { label: "Ouvrir la salle (Plan de salle)", action: () => { this.dcId = d.id; this.view = "top"; this.scale = null; this.buildToolbar(); this.render(); } },
      { label: "Modifier la salle…", action: () => this.host.openDatacenterForm?.(d.id) },
      { label: "Position auto (retirer le placement)", danger: true, action: async () => { await this.store.update("datacenters", d.id, { floor_x: null, floor_y: null }); this.setDirty(); } },
    ] }];
  }

  /** Menu d'un équipement posé sur le plan d'étage : modifier / fiche / délocaliser / retirer de l'étage. */
  protected floorEquipCtx(eq: any): CtxSection[] {
    const rotate = (deg: number) => async () => { const o: any = this.store.get("equipments", eq.id); if (!o) return; await this.store.update("equipments", eq.id, { dc_orientation: Normalize.rackOrientation((o.dc_orientation || 0) + deg) }); this.selFloorEquip = eq.id; this.setDirty(); };
    const items: Array<{ label: string; danger?: boolean; action: () => void }> = [
      { label: "Modifier…", action: () => this.host.openEquipmentForm?.(eq.id) },   // modale d'ÉDITION
      { label: "Fiche / détails…", action: () => this.host.openEquipmentDetail?.(eq.id) },
      { label: "↻ Pivoter 90°", action: rotate(90) },
      { label: "⟲ Pivoter 180°", action: rotate(180) },
    ];
    if (FloorLayout.floorEquipLocalized(eq)) items.push({ label: "Délocaliser (centre du plan)", danger: true, action: async () => { await this.store.update("equipments", eq.id, { floor_x: null, floor_y: null }); this.selFloorEquip = null; this.setDirty(); } });
    items.push({ label: "Retirer de l'étage (→ non placé)", danger: true, action: async () => {
      const downs = this.store.equipmentDcId(eq.id) ? this.store.cableDowngradeOps([eq.id]) : [];
      await this.store.updateBatch(([{ collection: "equipments", id: eq.id, patch: { placement_mode: "manual", floor_x: null, floor_y: null } }] as any[]).concat(downs as any));
      this.selFloorEquip = null; this.setDirty(); Notify.toast("Équipement retiré de l'étage");
    } });
    return [{ head: "▣ " + (eq.name || "équipement"), items }];
  }


  /** Clic sur un waypoint/brosse/OOB de la scène : ajout à la route en cours (si démarrée) sinon édition. */
  protected onWaypointClick(wp: any): void {
    if (this.routeBuild && this.routeBuild.fromPortId) { this.routeAddWp(wp.id); return; }
    this.host.openWaypointForm?.(wp.id);
  }

  /* ---- routage interactif (création d'une route de câble au clic) ---- */
  routeArm(): void { this.routeBuild = { fromPortId: null, wpIds: [], armed: true }; this.posTool.disarm(); Notify.toast("Routage : cliquez le PORT de départ", "ok"); this.render(); }

  protected routeStart(portId: string): void { this.routeBuild = { fromPortId: portId, wpIds: [] }; Notify.toast("Route démarrée — cliquez des waypoints/brosses puis un PORT terminal"); this.render(); }

  protected routeAddWp(wpId: string): void {
    if (!this.routeBuild) return;
    if (this.routeBuild.wpIds.includes(wpId)) { Notify.toast("Ce point de passage est déjà dans la route", "err"); return; }   // pas deux fois le même
    // EXIT TERMINAL : un exit FERME sa salle au niveau de la route → interdit d'ajouter ensuite un waypoint de cette
    // salle (le câble DOIT sortir). On éprouve la route prospective et on rejette les violations de cohérence salle.
    const probe = { from_port_id: this.routeBuild.fromPortId, to_port_id: null, waypoint_ids: [...this.routeBuild.wpIds, wpId] };
    const bad = this.store.cableRoute(probe).errors.find((e) =>
      e.includes("au milieu d'un tronçon hors salle") || e.includes("ré-entrée dans la salle quittée")
      || e.includes("dans une autre salle que le segment courant") || e.includes("la sortie doit être un exit de la salle courante"));
    if (bad) { Notify.toast("Un exit est TERMINAL pour sa salle — le câble doit sortir avant tout autre waypoint de salle.", "err"); return; }
    this.routeBuild.wpIds.push(wpId); this.render();
  }

  protected routeBack(): void { const rb = this.routeBuild; if (!rb) return; if (rb.wpIds.length) rb.wpIds.pop(); else if (rb.fromPortId) { rb.fromPortId = null; rb.armed = true; } this.render(); }

  routeCancel(): void { this.routeBuild = null; this.render(); }

  protected routeFinish(endPortId: string): void {
    const rb = this.routeBuild; if (!rb || !rb.fromPortId) return;
    if (endPortId === rb.fromPortId) { Notify.toast("Le port terminal doit différer du port de départ", "err"); return; }
    const fromPortId = rb.fromPortId, wpIds = rb.wpIds.slice();
    this.routeBuild = null; this.render();
    this.host.openCableForm?.(null, { fromPortId, toPortId: endPortId, waypointIds: wpIds });   // dialogue de câblage prérempli
  }

  /** Libellé court d'un port (équipement : port). */
  protected portShort(portId: string): string { const p: any = this.store.get("ports", portId); if (!p) return "(port ?)"; const e: any = this.store.get("equipments", p.equipment_id); return (e ? (e.name || "(équip.)") + " : " : "") + (p.name || "(port)"); }

  /** Un waypoint « conduit » (brosse / chemin de câbles posé) : le câble le TRAVERSE par ses extrémités. */
  protected isConduitWp(w: any): boolean { return !!w && (w.kind === "brush" || (w.kind === "segment" && w.dc_x2 != null && w.dc_y2 != null)); }

  /** Carte « Route en cours » (panneau latéral) : étapes + retour + annuler. */
  protected routeCard(): HTMLElement {
    const rb = this.routeBuild!, box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "🧵 Route en cours"; box.appendChild(t);
    const list = document.createElement("div"); list.style.cssText = "font-size:12px;margin:4px 0;display:flex;flex-direction:column;gap:3px";
    const step = (html: string, n?: number) => { const d = document.createElement("div"); d.innerHTML = (n != null ? '<span class="pill">' + n + "</span> " : "") + html; return d; };
    if (rb.fromPortId) list.appendChild(step("Départ : <b>" + Html.escape(this.portShort(rb.fromPortId)) + "</b>", 1));
    else list.appendChild(step('<span style="color:var(--accent)">Cliquez le PORT de départ…</span>'));
    rb.wpIds.forEach((id, i) => { const w: any = this.store.get("waypoints", id); list.appendChild(step(w ? Html.escape(Waypoint.glyph(w) + " " + (w.name || "(waypoint)")) : "(waypoint ?)", i + 2)); });
    box.appendChild(list);
    const hint = document.createElement("div"); hint.className = "form-hint";
    hint.textContent = rb.fromPortId ? "Cliquez des waypoints/brosses (changez de salle/étage si besoin), puis un PORT terminal pour finir." : "Cliquez un port libre pour démarrer la route.";
    box.appendChild(hint);
    const acts = document.createElement("div"); acts.className = "dc-card-acts";
    const bBack = this.btn("↩ Retour", () => this.routeBack()); (bBack as any).disabled = !rb.fromPortId && !rb.wpIds.length;
    const bCancel = this.btn("✕ Annuler", () => this.routeCancel()); bCancel.classList.add("btn-danger");
    acts.append(bBack, bCancel); box.appendChild(acts);
    return box;
  }


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
        if (this.hidden3dRacks.has(r.id)) return;
        const ext = this.rackHalfExtents(r), o = Normalize.rackOrientation(r.orientation);
        rects.push({ id: r.id, name: r.name || "(baie)", orient: o, anchor: "center", rect: { cx: (r.dc_x != null ? r.dc_x : ext.hx), cy: (r.dc_y != null ? r.dc_y : ext.hy), hx: ext.hx, hy: ext.hy },
          commit: async (cx, cy) => {
            const c = clamp(cx, cy, ext.hx, ext.hy, frame);
            if (GridGeometry.spanHitsBlocked(dc.blocked_cells, c.x - ext.hx, c.y - ext.hy, c.x + ext.hx, c.y + ext.hy, dc.cell_mm)) { Notify.toast("Case inaccessible — placement refusé", "err"); return; }
            await this.store.update("racks", r.id, { dc_x: Math.round(c.x), dc_y: Math.round(c.y) }); this.host.setDirty?.(true);
          } });
      });
      this.store.freeEquipsOfDc(dc.id).forEach((eq: any) => {
        if (eq.dc_x == null || eq.dc_y == null) return;   // seulement les équipements PLACÉS au sol
        const ext = FreeEquipGeometry.halfExtents(eq), o = Normalize.rackOrientation(eq.dc_orientation);
        rects.push({ id: eq.id, name: eq.name || "(équipement)", orient: o, anchor: "center", rect: { cx: eq.dc_x, cy: eq.dc_y, hx: ext.hx, hy: ext.hy },
          commit: async (cx, cy) => {
            const c = clamp(cx, cy, ext.hx, ext.hy, frame);
            if (GridGeometry.spanHitsBlocked(dc.blocked_cells, c.x - ext.hx, c.y - ext.hy, c.x + ext.hx, c.y + ext.hy, dc.cell_mm)) { Notify.toast("Case inaccessible — placement refusé", "err"); return; }
            await this.store.update("equipments", eq.id, { dc_x: Math.round(c.x), dc_y: Math.round(c.y) }); this.host.setDirty?.(true);
          } });
      });
      return { frame, rects };
    }
    if (this.view === "floor") {
      const ft = this.floorTargetResolve(); if (!ft) return null;
      const loc = ft.location || "", fl = String(ft.floor || ""), cfg = this.floor.config(loc, fl);
      const frame: Frame = { w: cfg.width_mm, h: cfg.depth_mm };
      const rects: PosEntry[] = [];
      this.store.dcsOfFloor(loc, fl).forEach((d: any) => {
        const fp = FloorLayout.roomFootprint(d), pos = this.floor.roomPos(d, cfg), hx = fp.w / 2, hy = fp.h / 2;
        rects.push({ id: d.id, name: (d.name || "(salle)") + (d.room ? " · " + d.room : ""), orient: 0, anchor: "topleft", rect: { cx: pos.x + hx, cy: pos.y + hy, hx, hy },
          commit: async (cx, cy) => {
            const c = clamp(cx, cy, hx, hy, frame);
            await this.store.update("datacenters", d.id, { floor_x: Math.round(c.x - hx), floor_y: Math.round(c.y - hy) }); this.host.setDirty?.(true);
          } });
      });
      this.store.floorEquipments().filter((e: any) => (e.location || "") === loc && String(e.floor || "") === fl).forEach((eq: any) => {
        const ext = FreeEquipGeometry.halfExtents(eq), o = Normalize.rackOrientation(eq.dc_orientation), pos = FloorLayout.floorEquipPos(eq, cfg);
        rects.push({ id: eq.id, name: eq.name || "(équipement)", orient: o, anchor: "center", rect: { cx: pos.x, cy: pos.y, hx: ext.hx, hy: ext.hy },
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
  posCtxKey(): string { return this.measureCtxKey(); }                                   // même portée que la mesure (salle / étage)
  posIs2D(): boolean { return this.view === "top" || this.view === "floor"; }
  posViewKind(): "top" | "floor" | "3d" { return this.view; }
  posScale(): number { return this.scale || 1; }
  posGRoot(): SVGGElement | null { return this.gRoot; }
  posClearOtherTools(): void { this.measure = null; this.routeBuild = null; }             // exclusivité : un seul outil de clic à la fois


  /* ============================ OUTIL DE MESURE multipoint (éphémère) ============================
     Clic = poser un point ; glisser = navigation (non inhibée — cf. classe `.dc-measuring` posée par newScene).
     2D (Dessus/Étage) : point au niveau du SOL (z=0) via clientToWorld. 3D : RAYCAST sur les surfaces de la scène
     (sol, baies, équipements) — l'intersection la plus proche donne le point ; à défaut, projection sur le plan du
     sol z=0. Les points vivent dans le repère du CONTEXTE courant (salle mono / monde multi / plan d'étage). */

  /** (Ré)arme l'outil de mesure dans le contexte de vue courant (exclusif du routage). */
  measureArm(): void {
    this.routeBuild = null; this.posTool.disarm();   // un seul mode de clic à la fois
    this._measHi = null;
    this.measure = { active: true, ctx: this.measureCtxKey(), pts: [], cursor: null, done: [] };
    Notify.toast("Mesure : cliquez pour poser des points · glissez pour naviguer · ÉCHAP pour effacer", "ok");
    this.buildToolbar(); this.render();
  }
  measureCancel(): void { this.measure = null; this._measHi = null; this.hideCote(); this.buildToolbar(); this.render(); }
  protected measureUndo(): void { if (this.measure && this.measure.pts.length) { this.measure.pts.pop(); this.measure.cursor = null; this.render(); } }
  /** Termine la mesure en cours (≥ 2 points) : elle reste affichée (session), une nouvelle peut démarrer. */
  protected measureCommit(): void { const m = this.measure; if (m && m.pts.length >= 2) { m.done.push(m.pts.slice()); m.pts = []; m.cursor = null; this._measHi = null; this.hideCote(); this.render(); } }
  /** Annule la mesure EN COURS (points non validés) en conservant les mesures terminées. Action de « ÉCHAP ». */
  protected measureCancelCurrent(): void { if (this.measure && (this.measure.pts.length || this.measure.cursor)) { this.measure.pts = []; this.measure.cursor = null; this.hideCote(); this.render(); } }
  /** Efface TOUTES les mesures (en cours + terminées). Bouton « Tout effacer ». */
  protected measureClearAll(): void { if (this.measure) { this.measure.pts = []; this.measure.cursor = null; this.measure.done = []; this._measHi = null; this.hideCote(); this.render(); } }

  /** Clé du contexte spatial courant : la mesure n'est tracée que là où elle a été prise (repères compatibles).
      NB : la 3D mono et le Plan de salle d'UNE MÊME salle partagent le repère → une mesure y est visible des deux. */
  protected measureCtxKey(): string {
    if (this.view === "floor") { const ft = this.floorTargetResolve(); return ft ? "floor:" + ft.location + "/" + ft.floor : "floor:?"; }
    if (this.view === "3d" && this.multiDc) return "multi";
    const dc = this.current(); return "room:" + (dc ? dc.id : "?");
  }
  /** La mesure en cours appartient-elle au contexte affiché ? (sinon : panneau informatif, pas de tracé/pose). */
  protected measureActiveHere(): boolean { return !!(this.measure && this.measure.active && this.measure.ctx === this.measureCtxKey()); }

  protected measureLen(a: Vec3, b: Vec3): number { return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)); }
  protected measureTotal(pts: Vec3[]): number { let s = 0; for (let i = 1; i < pts.length; i++) s += this.measureLen(pts[i - 1], pts[i]); return s; }

  /** Pose un point au clic (si le contexte correspond). */
  protected measurePlaceAt(clientX: number, clientY: number): void {
    if (!this.measureActiveHere()) { Notify.toast("Mesure prise dans un autre contexte — revenez-y ou effacez-la", "err"); return; }
    const p = this.measurePick(clientX, clientY);
    if (!p) { Notify.toast("Vue trop rasante : inclinez la caméra pour poser un point au sol", "err"); return; }
    this.measure!.pts.push(p); this.measure!.cursor = null; this.hideCote();
    this.render();
  }

  /** Point MONDE d'un clic en vue 2D (Dessus / Étage) : au niveau du SOL (z=0). En 3D, le raycast est fait par le
      moteur WebGL (cf. onWebglMeasurePlace / DcThreeScene.toolRaycast). */
  protected measurePick(clientX: number, clientY: number): Vec3 | null {
    if (!this.svg || this.scale == null) return null;
    if (this.view === "top" || this.view === "floor") { const w = this.clientToWorld(clientX, clientY); return { x: w.x, y: w.y, z: 0 }; }
    return null;
  }

  /** Tracé 2D (Dessus/Étage) des mesures : validées (étiquette nom+total, surbrillance) + en cours (par segment). */
  protected drawMeasure2D(gRoot: SVGGElement): void {
    if (this.view === "3d" || !this.measureActiveHere()) return;
    const m = this.measure!; if (!m.pts.length && !m.done.length) return;
    const g = Dom.svg("g", { class: "dc-measure" }), fMM = 13 / (this.scale || 1);
    const rDot = (DC_DOT_PX + 1) * this.markerScale / (this.scale || 1);
    const label = (text: string, x: number, y: number, cls: string) => { const t = Dom.svg("text", { class: cls, x, y, "text-anchor": "middle", "font-size": fMM }); t.textContent = text; g.appendChild(t); };
    const poly = (pts: Vec3[], hot: boolean, segLabels: boolean) => {
      if (!pts.length) return;
      const lineCls = "dc-measure-line" + (hot ? " hi" : "");
      if (pts.length >= 2) {
        g.appendChild(Dom.svg("polyline", { class: lineCls, points: pts.map((p) => p.x + "," + p.y).join(" ") }));
        if (segLabels) for (let i = 1; i < pts.length; i++) label(Format.meters(this.measureLen(pts[i - 1], pts[i])), (pts[i - 1].x + pts[i].x) / 2, (pts[i - 1].y + pts[i].y) / 2, "dc-measure-label");
      }
      pts.forEach((p) => g.appendChild(Dom.svg("circle", { class: "dc-measure-dot" + (hot ? " hi" : ""), cx: p.x, cy: p.y, r: rDot })));
    };
    m.done.forEach((pts, i) => {   // mesures validées : étiquette nom+total + surbrillance au survol
      poly(pts, i === this._measHi, false);
      const c = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y, z: 0 }), { x: 0, y: 0, z: 0 });
      label("Mesure " + (i + 1) + " · " + Format.meters(this.measureTotal(pts)), c.x / pts.length, c.y / pts.length, "dc-measure-label name");
    });
    poly(m.pts, false, true);   // mesure en cours : étiquettes par segment
    gRoot.appendChild(g);
  }

  /** Met en évidence (ou non) la mesure terminée d'index `i` — appelé au survol du listing. Rafraîchit le SEUL overlay. */
  protected measureSetHi(i: number | null): void {
    this._measHi = i;
    if (this.view === "3d") { if (this._three && this.measure) this._three.setMeasureOverlay(this.measure.pts, this.measure.cursor, this.measure.done, i); }
    else this.refreshMeasure2D();
  }
  /** Re-trace le SEUL overlay de mesure 2D (sans reconstruire la scène) — pour la surbrillance au survol. */
  protected refreshMeasure2D(): void {
    const g = this.gRoot; if (!g) return;
    g.querySelectorAll(".dc-measure").forEach((n) => n.remove());
    this.drawMeasure2D(g);
    if (this.floorXf) g.querySelectorAll(".dc-measure text").forEach((t) => this.applyUprightText(t));   // textes à l'endroit malgré la rotation 2D
  }

  /** APERÇU 2D du segment en cours (dernier point posé → curseur), sans reconstruire la scène. En 3D, l'aperçu est
      géré par le moteur WebGL (overlay Three.js). Trait pointillé + pastille ; longueur live via la cote flottante. */
  protected refreshMeasurePreview(): void {
    const g = this.gRoot; if (!g) return;
    g.querySelectorAll(".dc-measure-preview").forEach((n) => n.remove());
    const m = this.measure;
    if (this.view === "3d" || !this.measureActiveHere() || !m || !m.cursor || !m.pts.length) return;
    const last = m.pts[m.pts.length - 1], cur = m.cursor;
    const grp = Dom.svg("g", { class: "dc-measure-preview", style: "pointer-events:none" });
    grp.appendChild(Dom.svg("line", { class: "dc-measure-line preview", x1: last.x, y1: last.y, x2: cur.x, y2: cur.y }));
    const rDot = (DC_DOT_PX + 1) * this.markerScale / (this.scale || 1);
    grp.appendChild(Dom.svg("circle", { class: "dc-measure-dot", cx: cur.x, cy: cur.y, r: rDot }));
    g.appendChild(grp);
  }

  /** Carte « Mesure » (panneau latéral) : liste des segments + longueur totale + actions. */
  protected measureCard(): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "📏 Mesure"; box.appendChild(t);
    const m = this.measure!, here = this.measureActiveHere();
    const list = document.createElement("div"); list.style.cssText = "font-size:12px;margin:4px 0;display:flex;flex-direction:column;gap:3px";
    // LISTE des mesures : terminées (conservées en session) + celle en cours, avec longueur + nombre de points.
    const measures = m.done.map((p, i) => ({ name: "Mesure " + (i + 1), pts: p, idx: i as number | null })).concat(m.pts.length ? [{ name: "En cours", pts: m.pts, idx: null }] : []);
    if (!measures.length) {
      const d = document.createElement("div"); d.innerHTML = '<span style="color:var(--accent)">Cliquez pour poser le premier point…</span>'; list.appendChild(d);
    } else {
      measures.forEach((meas) => {
        const np = meas.pts.length, d = document.createElement("div");
        d.innerHTML = '<b>' + Html.escape(meas.name) + '</b> : <b style="color:var(--accent)">' + Html.escape(Format.meters(this.measureTotal(meas.pts))) + '</b> <span style="color:var(--fg-dim)">· ' + np + ' point' + (np > 1 ? 's' : '') + '</span>';
        if (meas.idx != null && here) {   // mesure VALIDÉE → survol = mise en évidence dans la vue
          const idx = meas.idx; d.style.cursor = "pointer";
          d.addEventListener("mouseenter", () => this.measureSetHi(idx));
          d.addEventListener("mouseleave", () => this.measureSetHi(null));
        }
        list.appendChild(d);
      });
    }
    box.appendChild(list);
    if (measures.length) {   // LONGUEUR TOTALE (toutes mesures)
      const grand = m.done.reduce((s, p) => s + this.measureTotal(p), 0) + this.measureTotal(m.pts);
      const tot = document.createElement("div"); tot.style.cssText = "margin:6px 0;font-size:13px;border-top:1px solid var(--line);padding-top:6px";
      tot.innerHTML = 'Longueur totale : <b style="color:var(--accent)">' + Html.escape(Format.meters(grand)) + '</b>';
      box.appendChild(tot);
    }
    const hint = document.createElement("div"); hint.className = "form-hint";
    hint.textContent = here ? "Cliquez pour poser des points · ENTRÉE valide la mesure · ÉCHAP annule la mesure en cours."
      : "Mesure prise dans un autre contexte de vue. Revenez-y pour l'éditer, ou effacez-la.";
    box.appendChild(hint);
    const acts = document.createElement("div"); acts.className = "dc-card-acts";
    const bUndo = this.btn("↩ Annuler point", () => this.measureUndo()); (bUndo as any).disabled = !m.pts.length || !here;
    const bNew = this.btn("✓ Valider (Entrée)", () => this.measureCommit()); (bNew as any).disabled = m.pts.length < 2 || !here;
    const bClear = this.btn("🗑 Tout effacer", () => this.measureClearAll()); (bClear as any).disabled = !m.pts.length && !m.done.length;
    const bClose = this.btn("✕ Fermer", () => this.measureCancel()); bClose.classList.add("btn-danger");
    acts.append(bUndo, bNew, bClear, bClose); box.appendChild(acts);
    return box;
  }


  /* ============================ PONT OUTILS ↔ moteur WebGL (mesure / routage 3D) ============================
     En 3D-WebGL il n'y a pas de <svg> : le moteur Three.js intercepte clics/survols et remonte les points monde
     (raycast natif) à la vue, qui tient l'état (measure / routeBuild) + le panneau, puis repousse l'overlay. */

  /** (Ré)applique au moteur WebGL le mode outil + l'overlay courant (appelé après chaque (re)rendu 3D-WebGL). */
  protected syncWebglTool(): void {
    const t = this._three; if (!t) return;
    if (this.measure && this.measure.active && this.measureActiveHere()) { t.setToolMode("measure"); t.setMeasureOverlay(this.measure.pts, this.measure.cursor, this.measure.done, this._measHi); }
    else if (this.routeBuild) { t.setToolMode("route"); t.setRouteOverlay(this.webglRouteWorldPts(), this.routeBuild.mouse || null); }
    else t.setToolMode("none");
  }

  /** Clic mesure (moteur) → pose un point + met à jour panneau et overlay (sans reconstruire la scène). */
  protected onWebglMeasurePlace(w: Vec3): void {
    if (!this.measure || !this.measure.active || !this.measureActiveHere()) return;
    this.measure.pts.push({ x: w.x, y: w.y, z: w.z }); this.measure.cursor = null; this.hideCote();
    this.renderSide(this.current());
    if (this._three) this._three.setMeasureOverlay(this.measure.pts, null, this.measure.done, this._measHi);
  }

  /** Survol mesure (moteur) → aperçu du segment courant + cote flottante (longueur live). */
  protected onWebglMeasureHover(w: Vec3 | null, clientX: number, clientY: number): void {
    if (!this.measure || !this.measure.active || !this.measureActiveHere() || !this.measure.pts.length) { this.hideCote(); return; }
    this.measure.cursor = w;
    if (this._three) this._three.setMeasureOverlay(this.measure.pts, w, this.measure.done, this._measHi);
    const last = this.measure.pts[this.measure.pts.length - 1];
    if (w) this.showCote(Format.meters(this.measureLen(last, w)), clientX, clientY); else this.hideCote();
  }

  /** Clic route (moteur) → port de départ / waypoint / port terminal (même machine d'état qu'en SVG). */
  protected onWebglRoutePick(desc: any): void {
    const rb = this.routeBuild; if (!rb || !desc) return;
    if (desc.type === "port") { if (!rb.fromPortId) this.routeStart(desc.id); else if (desc.id !== rb.fromPortId) this.routeFinish(desc.id); }
    else if (desc.type === "wp") { if (rb.fromPortId) this.routeAddWp(desc.id); }
  }

  /** Survol route (moteur) → aperçu (rubber-band) jusqu'au curseur. */
  protected onWebglRouteHover(w: Vec3 | null): void {
    const rb = this.routeBuild; if (!rb || !rb.fromPortId) return;
    rb.mouse = w;
    if (this._three) this._three.setRouteOverlay(this.webglRouteWorldPts(), w);
  }

  /** Points MONDE de la route en cours (port de départ + waypoints de la salle active) pour l'aperçu WebGL.
      Mono-salle (repère salle = monde) ; en multi, seuls les waypoints de la salle active sont prévisualisés. */
  protected webglRouteWorldPts(): Vec3[] {
    const rb = this.routeBuild, dc = this.current(); if (!rb || !dc) return [];
    const pts: Vec3[] = [];
    if (rb.fromPortId) { const a = this.resolver.resolvePort3D(rb.fromPortId, dc.id); if (a) pts.push({ x: a.x, y: a.y, z: a.z }); }
    rb.wpIds.forEach((id) => { const w: any = this.store.get("waypoints", id); if (w && this.store.waypointIsPlaced(w) && w.datacenter_id === dc.id) { const an = this.resolver.waypointAnchor(w); pts.push({ x: an.x, y: an.y, z: an.z }); } });
    return pts;
  }


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

  protected portDcId(portId: string): string | null { const p: any = this.store.get("ports", portId); return p ? this.store.equipmentDcId(p.equipment_id) : null; }

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
    if (kind === "equipment") { const e: any = this.store.get("equipments", id); return e ? (e.name || "(équipement)") : ""; }
    if (kind === "rack") { const r: any = this.store.get("racks", id); return r ? (r.name || "(baie)") : ""; }
    if (kind === "room") { const d: any = this.store.get("datacenters", id); return d ? (d.name || "(salle)") : ""; }
    if (kind === "cable") { const c: any = this.store.get("cables", id); return c ? this.cableLabelShort(c) : ""; }
    if (kind === "port") { const p: any = this.store.get("ports", id); const e: any = p ? this.store.get("equipments", p.equipment_id) : null; return p ? ((e && e.name ? e.name + " · " : "") + (p.name || "(port)")) : ""; }
    if (kind === "waypoint") { const w: any = this.store.get("waypoints", id); return w ? (Waypoint.glyph(w) + " " + (w.name || "(waypoint)")) : ""; }
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
    if (!dcId) { Notify.toast("Équipement non placé dans une salle", "err"); return; }
    const face = this.aimAtEquip(e, dcId);
    // en baie : emprise = hauteur de la baie isolée (on la voit entière) ; sinon ~1,6 m autour du boîtier.
    const rk: any = (this.selRackId) ? this.store.get("racks", this.selRackId) : null;
    const extent = rk ? Math.max(RackGeometry.physHeight(rk), 1600) : 1600;
    this.focus3DAt(dcId, this.equipCenter(e, dcId) || { x: 0, y: 0, z: 0 }, extent, face);
  }

  locateRack(rackId: string): void {
    const rk: any = this.store.get("racks", rackId); if (!rk) return;
    const dcId = rk.datacenter_id;
    if (!dcId) { Notify.toast("Baie non placée dans une salle", "err"); return; }
    this.selRackId = rackId; this.focusEqId = null;
    const H = RackGeometry.physHeight(rk);
    this.focus3DAt(dcId, { x: (rk.dc_x != null) ? rk.dc_x : 0, y: (rk.dc_y != null) ? rk.dc_y : 0, z: H / 2 }, H, this.frontAzimuth(rk.orientation));
  }

  locateCable(cableId: string): void {
    const c: any = this.store.get("cables", cableId); if (!c) return;
    const dcId = this.portDcId(c.from_port_id) || this.portDcId(c.to_port_id);
    if (!dcId) { Notify.toast("Câble non raccordé dans une salle", "err"); return; }
    const a = this.resolver.resolvePort3D(c.from_port_id, dcId) || this.resolver.resolvePort3D(c.to_port_id, dcId);
    if (!a) { Notify.toast("Extrémité du câble introuvable dans cette salle", "err"); return; }
    this.selCables.add(cableId); this.showAllCables = true; this.focusEqId = null;
    this.focus3DAt(dcId, { x: a.x, y: a.y, z: a.z }, 2500);
  }

  locateWaypoint(wpId: string): void {
    const wp: any = this.store.get("waypoints", wpId); if (!wp) return;
    const dcId = wp.datacenter_id;
    if (!dcId || !this.store.waypointIsPlaced(wp)) { Notify.toast("Waypoint non posé dans une salle", "err"); return; }
    this.focusEqId = null; this.selRackId = null; this.selWaypointId = wpId;
    const a = this.resolver.waypointAnchor(wp);
    this.focus3DAt(dcId, { x: a.x, y: a.y, z: a.z }, 1200);
  }

  locatePort(portId: string): void {
    const p: any = this.store.get("ports", portId); if (!p) return;
    const dcId = this.store.equipmentDcId(p.equipment_id);
    if (!dcId) { Notify.toast("Port : équipement non placé dans une salle", "err"); return; }
    const pt = this.resolver.resolvePort3D(portId, dcId);
    if (!pt) { Notify.toast("Port introuvable en 3D (façade non posée ?)", "err"); return; }
    const e: any = this.store.get("equipments", p.equipment_id);
    // surbrillance de l'équipement ET du PORT + isolement de sa baie + orientation « en face » ; cadrage serré.
    const face = e ? this.aimAtEquip(e, dcId) : null;
    this.focusPortId = portId;   // le port lui-même est mis en évidence (même ambre que l'équipement)
    this.focus3DAt(dcId, { x: pt.x, y: pt.y, z: pt.z }, 700, face);
  }

}
