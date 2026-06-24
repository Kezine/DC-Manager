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

  /** Recalcule le SEUL aperçu de route (suivi de souris) sans reconstruire la scène — préserve les cibles cliquables. */
  protected refreshRoutePreview3D(): void {
    const g = this.gRoot, c = this._camC; if (!g) return;
    g.querySelectorAll(".dc-route-preview").forEach((n) => n.remove());   // retire l'ancien tracé
    const dc = this.current();
    if (this.view !== "3d" || !dc || !this.routeBuild || !c) return;
    const proj = (p: Vec3) => this.project3DCam(p, c);
    const drawables: Drawable[] = [];
    this.drawRoutePreview3D(dc, proj, drawables);
    drawables.forEach((d) => g.appendChild(d.node));   // ajouté en dernier dans gRoot = au-dessus (et pointer-events:none)
  }

  protected showCote(text: string, clientX: number, clientY: number): void {
    if (!this.coteEl) { this.coteEl = document.createElement("div"); this.coteEl.className = "dc-cote"; this.stage.appendChild(this.coteEl); }
    this.coteEl.textContent = text; this.coteEl.style.display = "block";
    const r = this.stage.getBoundingClientRect();
    this.coteEl.style.left = (clientX - r.left + 14) + "px"; this.coteEl.style.top = (clientY - r.top + 14) + "px";
  }

  protected hideCote(): void { if (this.coteEl) this.coteEl.style.display = "none"; }


  /* ---- tooltips enrichis de scène (réplique de _showTip/_moveTip/_hideTip + builders HTML) ---- */
  protected showTip(html: string, ev: MouseEvent): void {
    if (!this.ttEl || !this.ttEl.isConnected) { this.ttEl = document.createElement("div"); this.ttEl.className = "dc-tooltip"; this.stage.appendChild(this.ttEl); }
    this.ttEl.innerHTML = html; this.ttEl.style.display = "block"; this.moveTip(ev);
  }

  protected moveTip(ev: MouseEvent): void {
    if (!this.ttEl) return;
    const host = this.stage.getBoundingClientRect();
    let x = ev.clientX - host.left + 14, y = ev.clientY - host.top + 14;
    const tw = this.ttEl.offsetWidth, th = this.ttEl.offsetHeight;
    if (x + tw > host.width) x = ev.clientX - host.left - tw - 14;
    if (y + th > host.height) y = host.height - th - 6;
    this.ttEl.style.left = Math.max(4, x) + "px"; this.ttEl.style.top = Math.max(4, y) + "px";
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
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      grp.classList.remove("dragging"); this.hideCote();
      if (!moved) return;   // simple clic = sélection
      const c = this.freePlace ? clampC(cur) : clampC({ x: this.snap(cur.x, dc.cell_mm), y: this.snap(cur.y, dc.cell_mm) });
      if (GridGeometry.spanHitsBlocked(dc.blocked_cells, c.x - ext.hx, c.y - ext.hy, c.x + ext.hx, c.y + ext.hy, dc.cell_mm)) { Notify.toast("Case inaccessible — placement refusé", "err"); this.render(); return; }
      await this.store.update("racks", r.id, { dc_x: c.x, dc_y: c.y }); this.host.setDirty?.(true);
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }

  protected onEquipPointerDown(ev: MouseEvent, eq: any): void {
    if (ev.button !== 0) return;
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
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      grp.classList.remove("dragging"); this.hideCote();
      if (!moved) return;
      const c = this.freePlace ? clampC(cur) : clampC({ x: this.snap(cur.x, dc.cell_mm), y: this.snap(cur.y, dc.cell_mm) });
      if (GridGeometry.spanHitsBlocked(dc.blocked_cells, c.x - ext.hx, c.y - ext.hy, c.x + ext.hx, c.y + ext.hy, dc.cell_mm)) { Notify.toast("Case inaccessible — placement refusé", "err"); this.render(); return; }
      await this.store.update("equipments", eq.id, { dc_x: c.x, dc_y: c.y }); this.host.setDirty?.(true);
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
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
    this.wireClick(poly, () => { this.hideTip(); this.selRackId = r.id; if (this.host.openRackForm) this.host.openRackForm(r.id); else this.render(); });
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
  /** Ouvre un menu contextuel (sauf si un glisser d'orbite vient d'avoir lieu). */
  protected ctxMenu(e: MouseEvent, sections: CtxSection[]): void {
    e.preventDefault(); e.stopPropagation();
    if (this._navMoved) { this._navMoved = false; return; }
    if (sections.length) ContextMenu.show(e.clientX, e.clientY, sections);
  }

  /** Actions de SÉLECTION de câbles (afficher / isoler / masquer) — manipule selCables, pas « Tout afficher ». */
  protected cableSelItems(ids: string[], noun: string): Array<{ label: string; action: () => void }> {
    const u = [...new Set((ids || []).filter(Boolean))]; const n = u.length; if (!n) return [];
    const suf = n > 1 ? " (" + n + ")" : "";
    return [
      { label: "Afficher " + noun + suf, action: () => { u.forEach((id) => this.selCables.add(id)); this.render(); } },
      { label: "Isoler " + noun + suf, action: () => { this.selCables = new Set(u); this.render(); } },
      { label: "Masquer " + noun + suf, action: () => { u.forEach((id) => this.selCables.delete(id)); this.render(); } },
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
    const secs: CtxSection[] = [{ head: e.name || "(équipement)", items: [
      { label: "Détails…", action: () => this.host.openEquipmentDetail?.(eqId) },
      { label: "Modifier…", action: () => this.host.openEquipmentDetail?.(eqId) },
      { label: "Créer un câble…", action: () => this.host.openCableForm?.(null, { fromEqId: eqId }) },
      { label: placed ? "Retirer du datacenter" : "Renvoyer en « Non placé »", danger: true, action: removeAction },
    ] }];
    const csi = this.cableSelItems(this.store.cablesOfEquipment(eqId).map((c: any) => c.id), "les câbles de l'équipement");
    if (csi.length) secs.push({ items: csi });
    return secs;
  }

  protected rackCtx(rack: any): CtxSection[] {
    const hidden = this.hidden3dRacks.has(rack.id), faded = this.fadedRacks.has(rack.id);
    const secs: CtxSection[] = [{ head: rack.name || "(baie)", items: [
      { label: "Modifier…", action: () => this.host.openRackForm?.(rack.id) },
      { label: "Isoler la baie", action: () => this.isolateRack(rack.id) },
      { label: hidden ? "Afficher la baie" : "Masquer la baie", action: () => { if (hidden) this.hidden3dRacks.delete(rack.id); else this.hidden3dRacks.add(rack.id); this.render(); } },
      { label: faded ? "Ne plus estomper" : "Estomper la baie", action: () => { if (faded) this.fadedRacks.delete(rack.id); else this.fadedRacks.add(rack.id); this.render(); } },
      { label: "Retirer du datacenter", danger: true, action: async () => {
          if (!this.store.get("racks", rack.id)) return;
          const eqIds = this.store.equipmentsOfRack(rack.id).filter((e: any) => e.placement_mode === "rack" && e.rack_u != null).map((e: any) => e.id);
          const ops: Array<{ collection: string; id: string; patch: Record<string, any> }> = [{ collection: "racks", id: rack.id, patch: { datacenter_id: null, dc_x: null, dc_y: null } }];
          if (rack.datacenter_id) ops.push(...this.store.cableDowngradeOps(eqIds));
          await this.store.updateBatch(ops); this.setDirty(); Notify.toast("Baie retirée — replacée dans le pool");
        } },
    ] }];
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
    ] }];
  }

  /* ---- menus contextuels du PLAN D'ÉTAGE (sol / salle / équipement) ---- */
  /** Menu du SOL du plan d'étage : créer une salle / un OOB (au point aimanté ½ maille) / éditer le plan. */
  protected floorPlaneCtx(loc: string, fl: string, w: { x: number; y: number }): CtxSection[] {
    const cfg = this.floor.config(loc, fl), half = (cfg.cell_mm || 1000) / 2;
    const x = Math.round(w.x / half) * half, y = Math.round(w.y / half) * half;
    return [{ head: "Plan d'étage — " + FloorLayout.locationLabel(loc) + " · ét. " + (fl || "0"), items: [
      { label: "+ Ajouter une salle…", action: () => this.host.openDatacenterForm?.("") },
      { label: "◎ Ajouter un pin d'étage ici", action: async () => { const wp: any = await this.store.create("waypoints", { name: "PIN-" + (this.store.oobWaypoints().length + 1), kind: "point", location: loc, floor: fl, floor_x: x, floor_y: y }); this.selWaypointId = wp.id; this.setDirty(); Notify.toast("Pin d'étage créé — glissez-le, éditez sa hauteur (clic droit)"); } },
      { label: "Éditer le plan d'étage…", action: () => this.editFloor(loc, fl, false) },
    ] }];
  }

  /** Menu de la DALLE d'étage en 3D multi-salles (clic droit) : éditer le plan · ajouter une salle · vue Étage 2D. */
  protected floorPlane3DCtx(loc: string, fl: string): CtxSection[] {
    fl = String(fl || "");
    return [{ head: "Étage — " + (FloorLayout.locationLabel(loc) || "(bâtiment ?)") + " · ét. " + (fl || "0"), items: [
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
    const items: Array<{ label: string; danger?: boolean; action: () => void }> = [
      { label: "Modifier…", action: () => this.host.openEquipmentDetail?.(eq.id) },
      { label: "Fiche / détails…", action: () => this.host.openEquipmentDetail?.(eq.id) },
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
  routeArm(): void { this.routeBuild = { fromPortId: null, wpIds: [], armed: true }; Notify.toast("Routage : cliquez le PORT de départ", "ok"); this.render(); }

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
  /** Points MONDE de l'aperçu de route dans la salle `dcId` (port de départ → waypoints de la salle ;
      conduits dépliés en points d'entrée/sortie). Mono-salle (repère salle = monde). */

  protected routePreviewWorldPts(dcId: string): Vec3[] {
    const rb = this.routeBuild; if (!rb) return [];
    const nodes: Array<{ w?: any; p: Vec3 }> = [];
    if (rb.fromPortId) { const a = this.resolver.resolvePort3D(rb.fromPortId, dcId); if (a) nodes.push({ p: { x: a.x, y: a.y, z: a.z } }); }
    rb.wpIds.forEach((id) => { const w: any = this.store.get("waypoints", id); if (w && this.store.waypointIsPlaced(w) && w.datacenter_id === dcId) nodes.push({ w, p: this.resolver.waypointAnchor(w) }); });
    if (rb.mouse) nodes.push({ p: rb.mouse });   // extrémité jusqu'au curseur
    const pts: Vec3[] = [];
    nodes.forEach((nd, i) => {
      if (nd.w && this.isConduitWp(nd.w)) { const prev = i > 0 ? nodes[i - 1].p : nd.p, next = i < nodes.length - 1 ? nodes[i + 1].p : nd.p; this.resolver.waypointPassPoints(nd.w, prev, next, null).forEach((p: Vec3) => pts.push(p)); }
      else pts.push(nd.p);
    });
    return pts;
  }

  /** Aperçu de la route en cours (tracé pointillé + pastilles), au-dessus de tout. */
  protected drawRoutePreview3D(dc: any, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[]): void {
    if (!this.routeBuild || !dc) return;
    const P = this.routePreviewWorldPts(dc.id).map(proj);
    if (P.length < 2) return;
    const g = Dom.svg("g", { class: "dc-route-preview", style: "pointer-events:none" });   // le câble qui suit la souris ne doit JAMAIS capter le clic
    g.appendChild(Dom.svg("path", { class: "dc-route-line", d: this.splinePath(P) }));
    const rDot = (DC_DOT_PX + 2) * this.markerScale / (this.scale || 1);
    P.forEach((p) => g.appendChild(Dom.svg("circle", { class: "dc-route-dot", cx: p.h, cy: p.v, r: rDot })));
    drawables.push({ depth: -3e4, node: g });
  }

}
