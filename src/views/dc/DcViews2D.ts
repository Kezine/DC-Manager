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
import { Format } from "../../core/Format";
import { Text } from "../../core/Text";
import { Waypoint } from "../../models/Waypoint";
import { CableStatuses } from "../../domain/CableStatuses";
import { RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_EAR_MM, U_MM, SIDE_U_STEP, BRUSH_PADDING_MM } from "../../domain/constants";
import { DC_DOT_PX, WP_HIT_PX, CABLE_PORT_STUB_MM, CABLE_SPLINE_K, CAM_PRESETS, DC_SCOPE_ICONS } from "./shared";
import type { Vec3, Drawable, DatacenterHost } from "./shared";
import { DcScene3D } from "./DcScene3D";

export class DcViews2D extends DcScene3D {


  /* ============================ VUE DESSUS (2D) ============================ */
  renderTop(dc: any): void {
    this.persistView();
    const gRoot = this.newScene(dc);
    const W = dc.width_mm, D = dc.depth_mm, cell = dc.cell_mm;
    // vue 2D TOURNÉE pour que la RÉFÉRENCE globale (liseré) soit toujours EN BAS : angle = orientation salle + 180°
    // (0→180, 90→270, 180→0, 270→90) + miroir horizontal → vraie vue « du dessus » (cohérente avec la 3D).
    this.floorXf = { angle: (Normalize.rackOrientation(dc.floor_orientation) + 180) % 360, cx: W / 2, cy: D / 2, flip: true };
    if (this.scale == null) this.recenter();   // échelle établie AVANT de bâtir → marqueurs (pastilles/waypoints) à la bonne taille dès le 1er rendu
    const room = Dom.svg("rect", { class: "dc-room", x: 0, y: 0, width: W, height: D });
    room.addEventListener("contextmenu", (e: any) => { const w = this.clientToWorld(e.clientX, e.clientY); this.ctxMenu(e, this.floorCtx(dc, w)); });   // clic droit sol → créer un waypoint
    gRoot.appendChild(room);
    gRoot.appendChild(this.gridNode(W, D, cell, dc.blocked_cells, (cx0, cy0, cx1, cy1) => this.toggleCellsRange("datacenters", dc.id, cx0, cy0, cx1, cy1)));
    if (this.showOrientMarks) { const th = Math.max(40, Math.min(W, D) * 0.012); gRoot.appendChild(Dom.svg("rect", { class: "dc-floor-room-front", x: 0, y: 0, width: W, height: th })); }   // liseré FRONT
    if (this.showDoorSwing) this.racks(dc.id).forEach((r) => { if (!this.hidden3dRacks.has(r.id)) { const sw = this.doorSwingNode(r); if (sw) gRoot.appendChild(sw); } });   // débattement des portes (sous les baies)
    this.racks(dc.id).forEach((r) => { if (!this.hidden3dRacks.has(r.id)) gRoot.appendChild(this.rackNode(r)); });
    this.store.freeEquipsOfDc(dc.id).forEach((e: any) => { if (e.dc_x != null && e.dc_y != null) gRoot.appendChild(this.equipNode(e)); });
    this.drawCables2D(gRoot, dc);   // filtré par cableShown (showAllCables / selCables) à l'intérieur
    if (this.showWaypoints) this.store.waypointsOfDc(dc.id).forEach((wp: any) => { if (this.store.waypointIsPlaced(wp)) gRoot.appendChild(this.waypointNode2D(wp, dc)); });
    this.drawMeasure2D(gRoot);   // outil de mesure (avant finishScene/uprightTexts → labels redressés)
    this.finishScene();
    this.uprightTexts();   // texte à l'endroit malgré la rotation/miroir de la vue
  }


  /* ============================ VUE ÉTAGE (plan bâtiment 2D) ============================ */
  /** Plan 2D d'un étage (bâtiment × niveau) : grille + salles (déplaçables, cliquables) + OOB. */
  renderFloor(ft: { location: string; floor: string }): void {
    this.persistView();
    const loc = ft.location || "", fl = String(ft.floor || ""), cfg = this.floor.config(loc, fl);
    const W = cfg.width_mm, D = cfg.depth_mm, cell = cfg.cell_mm;
    const gRoot = this.newScene(null);
    this.floorXf = { angle: 180, cx: W / 2, cy: D / 2, flip: true };   // bord de réf. EN BAS + miroir → vue « du dessus » réelle
    if (this.scale == null) this.recenter();   // échelle établie AVANT de bâtir (marqueurs à la bonne taille dès le 1er rendu)
    const bg = Dom.svg("rect", { class: "dc-room", x: 0, y: 0, width: W, height: D });
    bg.addEventListener("contextmenu", (e: any) => { const w = this.clientToWorld(e.clientX, e.clientY); this.ctxMenu(e, this.floorPlaneCtx(loc, fl, w)); });   // clic droit sol → créer salle / OOB / éditer plan
    gRoot.appendChild(bg);
    gRoot.appendChild(this.gridNode(W, D, cell, cfg.blocked_cells, (cx0, cy0, cx1, cy1) => this.toggleFloorCellsRange(loc, fl, cx0, cy0, cx1, cy1)));
    if (this.showOrientMarks) gRoot.appendChild(Dom.svg("line", { class: "dc-orient-ref-edge", x1: 0, y1: 0, x2: W, y2: 0 }));   // bord de référence (y=0)
    const curId = this.dcId;
    this.store.dcsOfFloor(loc, fl).forEach((d: any) => gRoot.appendChild(this.floorRoomNode(d, curId, cfg)));
    // câbles inter-DC de l'étage (port → exits/OOB → port, en coords plan) — filtrés par cableShown (panneau « Câbles inter-DC »)
    const rDot = DC_DOT_PX * this.markerScale / (this.scale || 1);
    this.interDcRoutesFloor(loc, fl, cfg).forEach((rc) => { if (this.cableShown(rc)) this.drawCable2D(gRoot, { cable: rc.cable, pts: rc.pts, linePts: rc.pts }, rDot); });
    // exits des salles de l'étage = points de connexion des câbles inter-DC
    if (this.showWaypoints) this.store.dcsOfFloor(loc, fl).forEach((d: any) => this.store.waypointsOfDc(d.id).forEach((wp: any) => { if (wp.wp_type === "exit" && this.store.waypointIsPlaced(wp)) gRoot.appendChild(this.floorExitNode(d, wp, cfg)); }));
    if (this.showWaypoints) this.store.oobWaypoints().filter((w: any) => (w.location || "") === loc && String(w.floor || "") === fl).forEach((wp: any) => gRoot.appendChild(this.floorOobNode(wp, cfg)));
    this.store.floorEquipments().filter((e: any) => (e.location || "") === loc && String(e.floor || "") === fl).forEach((eq: any) => gRoot.appendChild(this.floorEquipNode2D(eq, cfg)));
    if (this.showFloorAnchor) gRoot.appendChild(this.floorAnchorNode(cfg, loc, fl));   // marqueur d'ancrage déplaçable (discret)
    this.drawMeasure2D(gRoot);   // outil de mesure (avant finishScene/uprightTexts → labels redressés)
    this.renderFloorRail(ft);   // rail de navigation rapide entre étages (à gauche du plan)
    this.finishScene();
    this.uprightTexts();   // texte à l'endroit malgré la rotation/miroir de la vue
  }

  /** Câbles inter-DC dont les DEUX bouts résolvent dans des salles de CET étage, en coordonnées PLAN :
      port A → exits/OOB de la route → port B (réplique 2D de interDcRoutes via roomLocalToPlan / oobFloorPos). */
  protected interDcRoutesFloor(loc: string, fl: string, cfg: any): Array<{ cable: any; pts: Vec3[] }> {
    const onFloor = new Map<string, any>();
    this.store.dcsOfFloor(loc, fl).forEach((d: any) => onFloor.set(d.id, d));
    const planOf = (dc: any, p: Vec3) => FloorLayout.roomLocalToPlan(dc, this.floor.roomPos(dc, cfg), p);
    const out: Array<{ cable: any; pts: Vec3[] }> = [];
    this.store.all("cables").forEach((c: any) => {
      const r = this.store.cableRoute(c);
      if (!r.valid || !r.hasExits || !r.dcA || !r.dcB) return;
      const da = onFloor.get(r.dcA), db = onFloor.get(r.dcB);
      if (!da || !db) return;   // au moins un bout hors de cet étage → non tracé ici
      const a = this.resolver.resolvePort3D(c.from_port_id, r.dcA), b = this.resolver.resolvePort3D(c.to_port_id, r.dcB);
      if (!a || !b) return;
      const pts: Vec3[] = [planOf(da, { x: a.x, y: a.y, z: 0 })];
      (r.steps || []).forEach((s: any) => {
        if (s.type === "floor") { const fp = FloorLayout.oobFloorPos(s.wp, cfg); pts.push({ x: fp.x, y: fp.y, z: 0 }); }
        else { const room = onFloor.get(s.wp.datacenter_id); if (room) { const al = this.resolver.waypointAnchor(s.wp); pts.push(planOf(room, { x: al.x, y: al.y, z: 0 })); } }
      });
      pts.push(planOf(db, { x: b.x, y: b.y, z: 0 }));
      out.push({ cable: c, pts });
    });
    return out;
  }

  /** Exit d'une salle posé sur le plan d'étage (coords PLAN) — point de connexion des câbles inter-DC. */
  protected floorExitNode(dc: any, wp: any, cfg: any): SVGElement {
    const al = this.resolver.waypointAnchor(wp);
    const p = FloorLayout.roomLocalToPlan(dc, this.floor.roomPos(dc, cfg), { x: al.x, y: al.y, z: 0 });
    const s = Math.max(120, cfg.cell_mm * 0.3) * this.markerScale;
    const g = Dom.svg("g", { class: "dc-wp wp-exit", "data-wp": wp.id });
    const dia = Dom.svg("polygon", { class: "dc-wp-body", points: `${p.x},${p.y - s} ${p.x + s},${p.y} ${p.x},${p.y + s} ${p.x - s},${p.y}`, "data-wp": wp.id });
    const lab = Dom.svg("text", { class: "dc-wp-label", x: p.x, y: p.y - s * 1.4, "text-anchor": "middle", "font-size": cfg.cell_mm * 0.35 }); lab.textContent = (Waypoint.glyph(wp) + " " + (wp.name || "exit")).trim();
    this.wireWp(dia, wp);
    g.append(dia, lab); return g;
  }

  /** Marqueur de POINT D'ANCRAGE (vue Étage 2D) — règle graphiquement `floors.anchor_x/anchor_y` (décalage du
      plan dans la pile 3D multi-salles). Discret (croix pointillée + ⚓), déplaçable, masquable (showFloorAnchor). */

  protected floorAnchorNode(cfg: any, loc: string, fl: string): SVGElement {
    const ax = cfg.anchor_x || 0, ay = cfg.anchor_y || 0, s = cfg.cell_mm * 0.5;
    const g = Dom.svg("g", { class: "dc-floor-anchor", "data-anchor": "1", transform: `translate(${ax} ${ay})` });
    g.appendChild(Dom.svg("circle", { class: "dc-floor-anchor-mark", cx: 0, cy: 0, r: s }));
    g.appendChild(Dom.svg("line", { class: "dc-floor-anchor-mark", x1: -s * 1.5, y1: 0, x2: s * 1.5, y2: 0 }));
    g.appendChild(Dom.svg("line", { class: "dc-floor-anchor-mark", x1: 0, y1: -s * 1.5, x2: 0, y2: s * 1.5 }));
    g.appendChild(Dom.svg("circle", { class: "dc-floor-anchor-dot", cx: 0, cy: 0, r: s * 0.2 }));
    const label = Dom.svg("text", { class: "dc-floor-anchor-label", x: s * 1.7, y: -s * 1.5, "font-size": cfg.cell_mm * 0.4 });
    label.textContent = "⚓ ancrage"; g.appendChild(label);
    const tip = Dom.svg("title"); tip.textContent = "⚓ Point d'ancrage de l'étage — décale ce plan dans la pile 3D (" + Format.meters(ax) + " ; " + Format.meters(ay) + ") · glissez pour régler"; g.appendChild(tip);
    g.addEventListener("mousedown", (e: any) => this.onFloorAnchorPointerDown(e, cfg, loc, fl));
    return g;
  }

  protected onFloorAnchorPointerDown(e: MouseEvent, cfg: any, loc: string, fl: string): void {
    if (e.button !== 0) return; e.preventDefault(); e.stopPropagation();
    const grp = e.currentTarget as SVGElement; grp.classList.add("dragging");
    const W = cfg.width_mm, D = cfg.depth_mm, cell = cfg.cell_mm;
    const start = { x: cfg.anchor_x || 0, y: cfg.anchor_y || 0 }, w0 = this.clientToWorld(e.clientX, e.clientY);
    const off = { x: w0.x - start.x, y: w0.y - start.y };
    const clamp = (p: { x: number; y: number }) => ({ x: Math.min(Math.max(p.x, 0), W), y: Math.min(Math.max(p.y, 0), D) });
    let cur = { x: start.x, y: start.y }, moved = false;
    const move = (ev: MouseEvent) => {
      const wld = this.clientToWorld(ev.clientX, ev.clientY); const nx = wld.x - off.x, ny = wld.y - off.y;
      if (!moved && Math.abs(nx - start.x) + Math.abs(ny - start.y) < (8 / (this.scale || 1))) return;
      moved = true;
      cur = clamp({ x: nx, y: ny }); grp.setAttribute("transform", `translate(${cur.x} ${cur.y})`);
      this.showCote(Format.meters(cur.x) + " ; " + Format.meters(cur.y), ev.clientX, ev.clientY);
    };
    const up = async () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      grp.classList.remove("dragging"); this.hideCote();
      if (!moved) return;
      const c = clamp({ x: this.freePlace ? cur.x : this.snapEdge(cur.x, cell), y: this.freePlace ? cur.y : this.snapEdge(cur.y, cell) });
      const f = await this.ensureFloor(loc, fl);   // l'ancrage se stocke sur l'entité floors (créée au besoin)
      await this.store.update("floors", f.id, { anchor_x: Math.round(c.x), anchor_y: Math.round(c.y) }); this.host.setDirty?.(true); this.render();
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }

  /** Rail flottant (à gauche du plan) listant tous les étages connus — navigation rapide entre étages. */
  protected renderFloorRail(ft: { location: string; floor: string }): void {
    if (!this.floorRail) { const r = document.createElement("div"); r.className = "dc-floor-rail"; this.floorRail = r; this.stage.appendChild(r); }
    const rail = this.floorRail; rail.innerHTML = "";
    const keys = this.floor.allFloorKeys().filter((k: any) => this.siteAccessible(k.location));   // sites accessibles seulement
    if (!keys.length) { rail.style.display = "none"; return; }
    rail.style.display = "";
    const loc = ft.location || "", fl = String(ft.floor || "");
    const title = document.createElement("div"); title.className = "dc-floor-rail-title"; title.textContent = "Étages"; rail.appendChild(title);
    const byB = new Map<string, Array<{ location: string; floor: string }>>();
    keys.forEach((k) => { const b = k.location || ""; if (!byB.has(b)) byB.set(b, []); byB.get(b)!.push(k); });
    const multiB = byB.size > 1;
    [...byB.keys()].forEach((b) => {
      if (multiB) { const h = document.createElement("div"); h.className = "dc-floor-rail-bldg"; h.textContent = this.store.siteLabel(b) || "(bât. ?)"; h.title = this.store.siteLabel(b) || ""; rail.appendChild(h); }
      byB.get(b)!.slice().sort((a, c) => FloorLayout.floorNum(c.floor) - FloorLayout.floorNum(a.floor)).forEach((k) => {
        const isCur = (k.location || "") === loc && String(k.floor || "") === fl;
        const btn = document.createElement("button");
        btn.className = "btn btn-sm dc-floor-rail-btn " + (isCur ? "btn-primary" : "btn-ghost");
        btn.textContent = "ét. " + (String(k.floor) || "0");
        btn.title = (this.store.siteLabel(k.location) || "(bât. ?)") + " · étage " + (String(k.floor) || "0");
        if (isCur) btn.setAttribute("aria-current", "true");
        btn.onclick = () => { if (!isCur) { this.floorTarget = { location: k.location, floor: String(k.floor) }; this.scale = null; this.render(); } };
        rail.appendChild(btn);
      });
    });
  }

  /** Un équipement posé sur le plan d'étage : empreinte orientée + libellé. Cliquable / déplaçable. */
  protected floorEquipNode2D(eq: any, cfg: any): SVGElement {
    const pos = FloorLayout.floorEquipPos(eq, cfg), b = FreeEquipGeometry.box(eq), o = Normalize.rackOrientation(eq.dc_orientation), s = Math.min(b.w, b.d);
    const g = Dom.svg("g", { class: "dc-floor-equip" + (this.selFloorEquip === eq.id ? " sel" : ""), "data-equip": eq.id, transform: `translate(${pos.x} ${pos.y}) rotate(${o})` });
    g.appendChild(Dom.svg("rect", { class: "dc-floor-equip-body", x: -b.w / 2, y: -b.d / 2, width: b.w, height: b.d, rx: Math.min(b.w, b.d) * 0.06 }));
    const fs = Math.max(40, s * 0.22), yLab = -b.d / 2 - fs * 0.55;
    const label = Dom.svg("text", { class: "dc-floor-equip-label", x: 0, y: yLab, "text-anchor": "middle", "font-size": fs, transform: `rotate(${(360 - o) % 360} 0 ${yLab})` });
    label.textContent = (eq.name || "équipement") + (FloorLayout.floorEquipLocalized(eq) ? "" : " (auto)"); g.appendChild(label);
    g.addEventListener("mousedown", (e: any) => this.onFloorEquipPointerDown(e, eq, cfg));
    g.addEventListener("contextmenu", (e: any) => this.ctxMenu(e, this.floorEquipCtx(eq)));
    return g;
  }

  /** Glisser un équipement d'étage (localise floor_x/floor_y + rattache bâtiment/étage) ; clic = sélection. */
  protected onFloorEquipPointerDown(e: MouseEvent, eq: any, cfg: any): void {
    if (e.button !== 0) return; e.preventDefault(); e.stopPropagation();
    const ft = this.floorTargetResolve() || { location: "", floor: "" }, loc = ft.location || "", fl = String(ft.floor || "");
    const W = cfg.width_mm, D = cfg.depth_mm, cell = cfg.cell_mm, o = Normalize.rackOrientation(eq.dc_orientation);
    const grp = e.currentTarget as SVGElement;
    const start = FloorLayout.floorEquipPos(eq, cfg), w0 = this.clientToWorld(e.clientX, e.clientY), off = { x: w0.x - start.x, y: w0.y - start.y };
    const clampP = (p: { x: number; y: number }) => ({ x: Math.min(Math.max(p.x, 0), W), y: Math.min(Math.max(p.y, 0), D) });
    let cur = { x: start.x, y: start.y }, moved = false;
    const move = (ev: MouseEvent) => {
      const w = this.clientToWorld(ev.clientX, ev.clientY), nx = w.x - off.x, ny = w.y - off.y;
      if (!moved && Math.abs(nx - start.x) + Math.abs(ny - start.y) < (8 / (this.scale || 1))) return;
      moved = true; grp.classList.add("dragging");
      cur = clampP({ x: nx, y: ny }); grp.setAttribute("transform", `translate(${cur.x} ${cur.y}) rotate(${o})`);
      this.showCote(Format.meters(cur.x) + " ; " + Format.meters(cur.y), ev.clientX, ev.clientY);
    };
    const up = async () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      grp.classList.remove("dragging"); this.hideCote();
      if (!moved) { this.selFloorEquip = eq.id; this.render(); return; }
      const c = this.freePlace ? clampP(cur) : clampP({ x: this.snapEdge(cur.x, cell), y: this.snapEdge(cur.y, cell) });
      await this.store.update("equipments", eq.id, { floor_x: Math.round(c.x), floor_y: Math.round(c.y), location: loc, floor: fl }); this.host.setDirty?.(true);
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }

  /** Une salle sur le plan d'étage : emprise (rect orienté + liseré front) + libellé. Cliquable / déplaçable. */
  protected floorRoomNode(d: any, curId: string | null, cfg: any): SVGElement {
    const pos = this.floor.roomPos(d, cfg), w = d.width_mm, h = d.depth_mm, o = Normalize.rackOrientation(d.floor_orientation), fp = FloorLayout.roomFootprint(d);
    const g = Dom.svg("g", { class: "dc-floor-room" + (d.id === curId ? " cur" : "") + (this.selRoomId === d.id ? " sel" : ""), "data-room": d.id, transform: `translate(${pos.x} ${pos.y})` });
    const inner = Dom.svg("g", { transform: `translate(${fp.w / 2} ${fp.h / 2}) rotate(${o}) translate(${-w / 2} ${-h / 2})` });
    inner.appendChild(Dom.svg("rect", { class: "dc-floor-room-body", x: 0, y: 0, width: w, height: h }));
    if (this.showOrientMarks) inner.appendChild(Dom.svg("rect", { class: "dc-floor-room-front", x: 0, y: 0, width: w, height: Math.max(40, h * 0.022) }));
    g.appendChild(inner);
    const label = Dom.svg("text", { class: "dc-floor-room-label", x: fp.w / 2, y: fp.h / 2, "text-anchor": "middle", "dominant-baseline": "central", "font-size": Math.max(200, Math.min(fp.w, fp.h) * 0.12) });
    label.textContent = (d.name || "(salle)") + (d.room ? " · " + d.room : ""); g.appendChild(label);
    g.addEventListener("mousedown", (e: any) => this.onFloorRoomPointerDown(e, d, cfg));
    g.addEventListener("contextmenu", (e: any) => this.ctxMenu(e, this.floorRoomCtx(d)));
    return g;
  }
  /** Un OOB posé sur le plan d'étage : losange + libellé, cliquable → form waypoint. */
  /** OOB sur le plan d'étage — DÉPLAÇABLE dans le plan (affine floor_x/floor_y, snap au bord de maille ; le
      rattachement bâtiment/étage NE change PAS, l'OOB reste sur l'étage affiché). */

  protected floorOobNode(wp: any, cfg: any): SVGElement {
    const pos = FloorLayout.oobFloorPos(wp, cfg), loc = FloorLayout.oobLocalized(wp), s = cfg.cell_mm * 0.4;
    const g = Dom.svg("g", { class: "dc-floor-oob" + (this.selWaypointId === wp.id ? " sel" : ""), "data-oob": wp.id, "data-wp": wp.id, transform: `translate(${pos.x} ${pos.y})` });
    g.appendChild(Dom.svg("circle", { class: "dc-floor-oob-body", cx: 0, cy: 0, r: s }));
    const label = Dom.svg("text", { class: "dc-floor-oob-label", x: 0, y: -s * 1.5, "text-anchor": "middle", "font-size": cfg.cell_mm * 0.42 });
    label.textContent = "◎ " + (wp.name || "OOB") + " · " + Format.meters(FloorLayout.oobHeight(wp)) + (loc ? "" : " (auto)");
    g.appendChild(label);
    this.wireTip(g, () => this.wpTipHtml(wp));
    g.addEventListener("mousedown", (e: any) => this.onFloorOobPointerDown(e, wp, cfg));
    g.addEventListener("contextmenu", (e: any) => { e.preventDefault(); e.stopPropagation(); this.hideTip(); this.ctxMenu(e, this.waypointCtx(wp)); });
    return g;
  }

  protected onFloorOobPointerDown(e: MouseEvent, wp: any, cfg: any): void {
    if (e.button !== 0) return; e.preventDefault(); e.stopPropagation();
    this.selWaypointId = wp.id; this.selRoomId = null; this.selFloorEquip = null;
    if (this.svg) this.svg.querySelectorAll(".dc-floor-room,.dc-floor-oob,.dc-floor-equip").forEach((n) => n.classList.remove("sel"));
    const grp = e.currentTarget as SVGElement; grp.classList.add("sel");
    const ft = this.floorTargetResolve() || { location: "", floor: "" }, loc = ft.location || "", fl = String(ft.floor || "");   // reste sur l'étage AFFICHÉ
    const W = cfg.width_mm, D = cfg.depth_mm, cell = cfg.cell_mm;
    const start = FloorLayout.oobFloorPos(wp, cfg), w0 = this.clientToWorld(e.clientX, e.clientY);
    const off = { x: w0.x - start.x, y: w0.y - start.y };
    const clamp = (p: { x: number; y: number }) => ({ x: Math.min(Math.max(p.x, 0), W), y: Math.min(Math.max(p.y, 0), D) });
    let cur = { x: start.x, y: start.y }, moved = false;
    const move = (ev: MouseEvent) => {
      const wld = this.clientToWorld(ev.clientX, ev.clientY); const nx = wld.x - off.x, ny = wld.y - off.y;
      if (!moved && Math.abs(nx - start.x) + Math.abs(ny - start.y) < (8 / (this.scale || 1))) return;
      moved = true; grp.classList.add("dragging"); this.hideTip();
      cur = clamp({ x: nx, y: ny }); grp.setAttribute("transform", `translate(${cur.x} ${cur.y})`);
      this.showCote(Format.meters(cur.x) + " ; " + Format.meters(cur.y), ev.clientX, ev.clientY);
    };
    const up = async () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      grp.classList.remove("dragging"); this.hideCote();
      if (!moved) { this.render(); return; }   // simple clic = sélection
      const c = clamp({ x: this.freePlace ? cur.x : this.snapEdge(cur.x, cell), y: this.freePlace ? cur.y : this.snapEdge(cur.y, cell) });
      await this.store.update("waypoints", wp.id, { floor_x: c.x, floor_y: c.y, location: loc, floor: fl }); this.host.setDirty?.(true);   // localise (étage inchangé)
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }

  protected snapEdge(v: number, cell: number): number { return Math.round(v / cell) * cell; }
  /** Glisser une salle sur le plan d'étage (set floor_x/floor_y, aimanté à la maille, borné au plan) ;
      simple clic = sélection + activation de la salle. */

  protected onFloorRoomPointerDown(e: MouseEvent, d: any, cfg: any): void {
    if (e.button !== 0) return; e.preventDefault(); e.stopPropagation();
    const W = cfg.width_mm, D = cfg.depth_mm, cell = cfg.cell_mm, fp = FloorLayout.roomFootprint(d);
    const grp = e.currentTarget as SVGElement;
    const start = this.floor.roomPos(d, cfg), w0 = this.clientToWorld(e.clientX, e.clientY);
    const off = { x: w0.x - start.x, y: w0.y - start.y };
    const clampP = (p: { x: number; y: number }) => ({ x: Math.min(Math.max(p.x, 0), Math.max(0, W - fp.w)), y: Math.min(Math.max(p.y, 0), Math.max(0, D - fp.h)) });
    let cur = { x: start.x, y: start.y }, moved = false;
    const move = (ev: MouseEvent) => {
      const w = this.clientToWorld(ev.clientX, ev.clientY), nx = w.x - off.x, ny = w.y - off.y;
      if (!moved && Math.abs(nx - start.x) + Math.abs(ny - start.y) < (8 / (this.scale || 1))) return;
      moved = true; grp.classList.add("dragging");
      cur = clampP({ x: nx, y: ny }); grp.setAttribute("transform", `translate(${cur.x} ${cur.y})`);
      this.showCote(Format.meters(cur.x) + " ; " + Format.meters(cur.y), ev.clientX, ev.clientY);
    };
    const up = async () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      grp.classList.remove("dragging"); this.hideCote();
      if (!moved) { this.selRoomId = d.id; this.dcId = d.id; this.render(); return; }   // simple clic = sélection + activation
      const c = this.freePlace ? clampP(cur) : clampP({ x: this.snapEdge(cur.x, cell), y: this.snapEdge(cur.y, cell) });
      await this.store.update("datacenters", d.id, { floor_x: Math.round(c.x), floor_y: Math.round(c.y) }); this.host.setDirty?.(true);
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }
  /** Grille + cases INACCESSIBLES (hachurées). En mode `blockEdit`, un overlay capte un GLISSÉ de sélection
      (rectangle) → `onRange(cx0,cy0,cx1,cy1)` sur les cases couvertes (clic simple = 1 case). Aperçu en direct. */

  protected gridNode(W: number, D: number, cell: number, blocked?: string[], onRange?: (cx0: number, cy0: number, cx1: number, cy1: number) => void): SVGElement {
    const g = Dom.svg("g", { class: "dc-grid" });
    for (let x = 0; x <= W + 0.5; x += cell) g.appendChild(Dom.svg("line", { class: "dc-grid-line", x1: x, y1: 0, x2: x, y2: D }));
    for (let y = 0; y <= D + 0.5; y += cell) g.appendChild(Dom.svg("line", { class: "dc-grid-line", x1: 0, y1: y, x2: W, y2: y }));
    (blocked || []).forEach((key) => {
      const p = key.split(","), cx = +p[0], cy = +p[1]; if (!isFinite(cx) || !isFinite(cy)) return;
      const rx = cx * cell, ry = cy * cell; if (rx < 0 || ry < 0 || rx >= W || ry >= D) return;
      g.appendChild(Dom.svg("rect", { class: "dc-cell-blocked", x: rx, y: ry, width: cell, height: cell }));
    });
    if (this.blockEdit && onRange) {
      const ov = Dom.svg("rect", { class: "dc-cell-edit", x: 0, y: 0, width: W, height: D });
      const clampCell = (v: number, max: number) => Math.min(Math.max(v, 0), max - 1);
      ov.addEventListener("mousedown", (e: any) => {
        if (e.button !== 0) return; e.preventDefault(); e.stopPropagation();
        const s = this.clientToWorld(e.clientX, e.clientY), nx = Math.ceil(W / cell), ny = Math.ceil(D / cell);
        const c0 = { cx: clampCell(Math.floor(s.x / cell), nx), cy: clampCell(Math.floor(s.y / cell), ny) };
        const prev = Dom.svg("rect", { class: "dc-cell-sel-preview" }); if (this.gRoot) this.gRoot.appendChild(prev);
        const draw = (c1: { cx: number; cy: number }) => { const x0 = Math.min(c0.cx, c1.cx) * cell, y0 = Math.min(c0.cy, c1.cy) * cell; prev.setAttribute("x", String(x0)); prev.setAttribute("y", String(y0)); prev.setAttribute("width", String((Math.abs(c1.cx - c0.cx) + 1) * cell)); prev.setAttribute("height", String((Math.abs(c1.cy - c0.cy) + 1) * cell)); };
        let c1 = c0; draw(c0);
        const move = (ev: MouseEvent) => { const w = this.clientToWorld(ev.clientX, ev.clientY); c1 = { cx: clampCell(Math.floor(w.x / cell), nx), cy: clampCell(Math.floor(w.y / cell), ny) }; draw(c1); };
        const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); prev.remove(); onRange(c0.cx, c0.cy, c1.cx, c1.cy); };
        document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
      });
      g.appendChild(ov);
    }
    return g;
  }

  /** (Dé)marque un rectangle de cases inaccessibles sur une entité (datacenter / floor). Mode déduit de la 1re case. */
  protected async toggleCellsRange(coll: string, id: string, cx0: number, cy0: number, cx1: number, cy1: number): Promise<void> {
    const obj: any = this.store.get(coll, id); if (!obj) return;
    const set = new Set<string>(Array.isArray(obj.blocked_cells) ? obj.blocked_cells : []);
    const block = !set.has(cx0 + "," + cy0);
    for (let cx = Math.min(cx0, cx1); cx <= Math.max(cx0, cx1); cx++) for (let cy = Math.min(cy0, cy1); cy <= Math.max(cy0, cy1); cy++) { const k = cx + "," + cy; if (block) set.add(k); else set.delete(k); }
    await this.store.update(coll, id, { blocked_cells: [...set] }); this.setDirty(); this.render();
  }

  /** Entité `floors` de (loc, étage), créée au besoin (les cases inaccessibles d'étage s'y stockent). */
  protected async ensureFloor(loc: string, fl: string): Promise<any> { let f: any = this.store.floorFor(loc, fl); if (!f) f = await this.store.create("floors", { location: loc, floor: String(fl) }); return f; }

  protected async toggleFloorCellsRange(loc: string, fl: string, cx0: number, cy0: number, cx1: number, cy1: number): Promise<void> { const f = await this.ensureFloor(loc, fl); await this.toggleCellsRange("floors", f.id, cx0, cy0, cx1, cy1); }

  /** Débattement (rayon d'ouverture) des portes d'une baie, en vue DESSUS : secteur quart-de-disque par porte
      (pivot = charnière décalée de l'épaisseur, rayon = largeur du vantail, 90° vers l'extérieur). Couleurs des
      emplacements libres (accent). Repère LOCAL de la baie (translate+rotate). null si aucune porte. */
  protected doorSwingNode(r: any): SVGElement | null {
    const w = r.width_mm || RACK_WIDTH_DEFAULT, d = r.depth || RACK_DEPTH_DEFAULT;
    const cx = (r.dc_x != null) ? r.dc_x : w / 2, cy = (r.dc_y != null) ? r.dc_y : d / 2, o = Normalize.rackOrientation(r.orientation);
    const grp = Dom.svg("g", { transform: `translate(${cx} ${cy}) rotate(${o})`, "pointer-events": "none" });
    let any = false;
    (["front", "rear"] as const).forEach((face) => {
      const dr = RackGeometry.door(r, face); if (!dr || !dr.enabled) return;
      any = true;
      const rear = face === "rear", clr = Math.max(6, dr.thickness_mm | 0), R = Math.max(1, w - clr);
      const sgn = rear ? 1 : -1;                                  // face/ouverture vers l'extérieur (avant −Y · arrière +Y)
      const left = (dr.hinge !== "right") !== rear;               // gauche vue de la FACE de la porte
      const dirX = left ? 1 : -1, beta = Math.sign(sgn / dirX) * Math.PI / 2;
      const hx = left ? (-w / 2 + clr) : (w / 2 - clr), hy = sgn * (d / 2);   // pivot = charnière décalée, au plan de face
      const seg = [`M ${hx.toFixed(1)} ${hy.toFixed(1)}`];
      const N = 16;
      for (let i = 0; i <= N; i++) { const a = beta * (i / N); seg.push(`L ${(hx + dirX * R * Math.cos(a)).toFixed(1)} ${(hy + dirX * R * Math.sin(a)).toFixed(1)}`); }
      seg.push("Z");
      grp.appendChild(Dom.svg("path", { d: seg.join(" "), style: "fill:var(--accent);fill-opacity:0.14;stroke:var(--accent);stroke-opacity:0.55;stroke-width:1.5;vector-effect:non-scaling-stroke" }));
    });
    return any ? grp : null;
  }

  protected rackNode(r: any): SVGElement {
    const w = r.width_mm || RACK_WIDTH_DEFAULT, d = r.depth || RACK_DEPTH_DEFAULT;
    const cx = (r.dc_x != null) ? r.dc_x : w / 2, cy = (r.dc_y != null) ? r.dc_y : d / 2, o = Normalize.rackOrientation(r.orientation);
    const grp = Dom.svg("g", { class: "dc-rack" + (this.selRackId === r.id ? " sel" : ""), transform: `translate(${cx} ${cy}) rotate(${o})`, "data-rack": r.id });
    grp.appendChild(Dom.svg("rect", { class: "dc-rack-body", x: -w / 2, y: -d / 2, width: w, height: d }));
    grp.appendChild(Dom.svg("rect", { class: "dc-rack-face", x: -w / 2, y: -d / 2, width: w, height: Math.max(20, d * 0.12) }));
    const t = Dom.svg("text", { class: "dc-rack-label", x: 0, y: 0, "text-anchor": "middle", "dominant-baseline": "central", transform: `rotate(${-o})`, "font-size": Math.max(40, Math.min(w, d) * 0.14) });
    t.textContent = r.name || "(baie)"; grp.appendChild(t);
    grp.addEventListener("mousedown", (e: any) => this.onRackPointerDown(e, r));
    grp.addEventListener("contextmenu", (e: any) => this.ctxMenu(e, this.rackCtx(r)));
    return grp;
  }

  protected equipNode(e: any): SVGElement {
    const b = FreeEquipGeometry.box(e), o = Normalize.rackOrientation(e.dc_orientation);
    const cx = (e.dc_x != null) ? e.dc_x : b.w / 2, cy = (e.dc_y != null) ? e.dc_y : b.d / 2;
    const grp = Dom.svg("g", { class: "dc-equip" + (this.selEquipId === e.id ? " sel" : ""), transform: `translate(${cx} ${cy}) rotate(${o})`, "data-equip": e.id });
    grp.appendChild(Dom.svg("rect", { class: "dc-equip-body", x: -b.w / 2, y: -b.d / 2, width: b.w, height: b.d, rx: Math.min(b.w, b.d) * 0.04 }));
    const t = Dom.svg("text", { class: "dc-equip-label", x: 0, y: 0, "text-anchor": "middle", "dominant-baseline": "central", transform: `rotate(${-o})`, "font-size": Math.max(40, Math.min(b.w, b.d) * 0.16) });
    t.textContent = e.name || "(équipement)"; grp.appendChild(t);
    grp.addEventListener("mousedown", (ev: any) => this.onEquipPointerDown(ev, e));
    grp.addEventListener("contextmenu", (ev: any) => this.ctxMenu(ev, this.equipmentCtx(e.id)));
    return grp;
  }
  /** Waypoint en vue DESSUS. Pin/rail LIBRES = déplaçables dans la salle (affine dc_x/dc_y, snap demi-maille,
      le rattachement salle/datacenter NE change PAS) ; brosse / pin latéral / pin de capot = STATIQUES (zone =
      le slot de la baie, posés par assignation, édités par form). Réplique de `waypointNode` du monolithe. */

  protected waypointNode2D(wp: any, dc: any): SVGElement {
    const sel = this.selWaypointId === wp.id;
    const s = Math.max(70, (dc.cell_mm || 600) * 0.18);   // demi-taille du losange / rayon poignée (mm monde)
    const fontSize = Math.max(40, (dc.cell_mm || 600) * 0.2);
    // ANCRÉ à une baie (brosse / pin latéral / pin de capot) → marqueur STATIQUE (la position suit le slot)
    if (wp.kind === "brush" || (wp.kind === "point" && wp.rack_id && (wp.side_lr != null || wp.cap_face))) {
      const g = Dom.svg("g", { class: "dc-wp wp-" + (wp.kind === "brush" ? "brush" : (wp.cap_face ? "cappin" : "sidepin")) + (sel ? " sel" : ""), "data-wp": wp.id });
      const a = this.resolver.waypointAnchor(wp); if (a.x == null) return g;
      const dia = Dom.svg("polygon", { class: "dc-wp-body", points: `${a.x},${a.y - s} ${a.x + s},${a.y} ${a.x},${a.y + s} ${a.x - s},${a.y}`, "data-wp": wp.id });
      const lab = Dom.svg("text", { class: "dc-wp-label", x: a.x, y: a.y - s * 1.4, "text-anchor": "middle", "font-size": fontSize }); lab.textContent = Waypoint.glyph(wp) + " " + (wp.name || "");
      this.wireWp(dia, wp); g.append(dia, lab);
      return g;
    }
    // LIBRE (pin ou rail de salle) → déplaçable dans la salle
    const g = Dom.svg("g", { class: "dc-wp wp-" + Waypoint.typeOf(wp) + (sel ? " sel" : ""), "data-wp": wp.id });
    const isSeg = wp.kind === "segment" && wp.dc_x2 != null;
    const hitR = WP_HIT_PX * this.markerScale / (this.scale || 1);   // zone de clic ~constante à l'écran
    const cur: any = { x1: wp.dc_x, y1: wp.dc_y, x2: wp.dc_x2, y2: wp.dc_y2 };
    let rail: any, h1: any, h2: any, dia: any, label: any, hitDot: any, hitLine: any, hit1: any, hit2: any;
    const sync = () => {   // répercute `cur` sur les nœuds SVG (drag en direct)
      if (isSeg) {
        rail.setAttribute("x1", cur.x1); rail.setAttribute("y1", cur.y1); rail.setAttribute("x2", cur.x2); rail.setAttribute("y2", cur.y2);
        hitLine.setAttribute("x1", cur.x1); hitLine.setAttribute("y1", cur.y1); hitLine.setAttribute("x2", cur.x2); hitLine.setAttribute("y2", cur.y2);
        h1.setAttribute("cx", cur.x1); h1.setAttribute("cy", cur.y1); h2.setAttribute("cx", cur.x2); h2.setAttribute("cy", cur.y2);
        hit1.setAttribute("cx", cur.x1); hit1.setAttribute("cy", cur.y1); hit2.setAttribute("cx", cur.x2); hit2.setAttribute("cy", cur.y2);
        label.setAttribute("x", (cur.x1 + cur.x2) / 2); label.setAttribute("y", (cur.y1 + cur.y2) / 2 - s * 1.2);
      } else {
        dia.setAttribute("points", `${cur.x1},${cur.y1 - s} ${cur.x1 + s},${cur.y1} ${cur.x1},${cur.y1 + s} ${cur.x1 - s},${cur.y1}`);
        hitDot.setAttribute("cx", cur.x1); hitDot.setAttribute("cy", cur.y1);
        label.setAttribute("x", cur.x1); label.setAttribute("y", cur.y1 - s * 1.4);
      }
    };
    const startDrag = (ev: MouseEvent, which: string) => {
      if (ev.button !== 0) return; ev.preventDefault(); ev.stopPropagation();
      this.selRackId = null; this.selEquipId = null; this.selWaypointId = wp.id;
      if (this.svg) { this.svg.querySelectorAll(".dc-rack,.dc-equip").forEach((n) => n.classList.remove("sel")); this.svg.querySelectorAll(".dc-wp").forEach((n) => n.classList.toggle("sel", n.getAttribute("data-wp") === wp.id)); }
      this.renderSide(dc);
      const w0 = this.clientToWorld(ev.clientX, ev.clientY);
      const start = { x1: cur.x1, y1: cur.y1, x2: cur.x2, y2: cur.y2 };
      const half = (dc.cell_mm || 600) / 2, snap = (v: number) => this.freePlace ? v : Math.round(v / half) * half;
      let moved = false;
      const move = (e2: MouseEvent) => {
        const w = this.clientToWorld(e2.clientX, e2.clientY); const dx = w.x - w0.x, dy = w.y - w0.y;
        if (!moved && Math.abs(dx) + Math.abs(dy) < (8 / (this.scale || 1))) return;
        moved = true; g.classList.add("dragging"); this.hideTip();
        if (which === "body") {
          if (isSeg) { cur.x1 = start.x1 + dx; cur.y1 = start.y1 + dy; cur.x2 = start.x2 + dx; cur.y2 = start.y2 + dy; }   // translation rigide (longueur préservée)
          else { cur.x1 = start.x1 + dx; cur.y1 = start.y1 + dy; }
        } else if (which === "p1") { cur.x1 = start.x1 + dx; cur.y1 = start.y1 + dy; }
        else { cur.x2 = start.x2 + dx; cur.y2 = start.y2 + dy; }
        sync();
        // pendant le glisser, uprightTexts() n'est PAS rejoué → on recale le contre-miroir/rotation du label sur sa
        // nouvelle ancre (au rendu plein, c'est uprightTexts() qui s'en charge — l'appeler ici aussi le doublerait).
        this.applyUprightText(label);
      };
      const up = async () => {
        document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
        g.classList.remove("dragging");
        if (!moved) { this.render(); return; }   // simple clic = sélection seule
        if (which === "body" && isSeg) { const dx = snap(cur.x1 - start.x1), dy = snap(cur.y1 - start.y1); cur.x1 = start.x1 + dx; cur.y1 = start.y1 + dy; cur.x2 = start.x2 + dx; cur.y2 = start.y2 + dy; }   // aimante le delta → longueur préservée
        else if (which === "p2") { cur.x2 = snap(cur.x2); cur.y2 = snap(cur.y2); }
        else { cur.x1 = snap(cur.x1); cur.y1 = snap(cur.y1); }
        const payload = isSeg ? { dc_x: cur.x1, dc_y: cur.y1, dc_x2: cur.x2, dc_y2: cur.y2 } : { dc_x: cur.x1, dc_y: cur.y1 };
        await this.store.update("waypoints", wp.id, payload); this.host.setDirty?.(true);   // datacenter_id INCHANGÉ → reste dans la salle
      };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    };
    const wireTop = (node: SVGElement) => { this.wireTip(node, () => this.wpTipHtml(wp)); node.addEventListener("contextmenu", (e: any) => { e.preventDefault(); e.stopPropagation(); this.hideTip(); this.ctxMenu(e, this.waypointCtx(wp)); }); };
    if (isSeg) {
      rail = Dom.svg("line", { class: "dc-wp-rail" });
      h1 = Dom.svg("circle", { class: "dc-wp-handle", r: s * 0.55 }); h2 = Dom.svg("circle", { class: "dc-wp-handle", r: s * 0.55 });
      hitLine = Dom.svg("line", { class: "dc-wp-hit-line" }); hit1 = Dom.svg("circle", { class: "dc-wp-hit", r: hitR }); hit2 = Dom.svg("circle", { class: "dc-wp-hit", r: hitR });
      label = Dom.svg("text", { class: "dc-wp-label", "text-anchor": "middle", "font-size": fontSize }); label.textContent = Waypoint.glyph(wp) + " " + (wp.name || "");
      g.append(rail, h1, h2, label, hitLine, hit1, hit2);
      ([[hitLine, "body"], [hit1, "p1"], [hit2, "p2"]] as Array<[SVGElement, string]>).forEach(([n, which]) => { n.addEventListener("mousedown", (e: any) => startDrag(e, which)); wireTop(n); });
    } else {
      dia = Dom.svg("polygon", { class: "dc-wp-body" }); hitDot = Dom.svg("circle", { class: "dc-wp-hit", r: hitR });
      label = Dom.svg("text", { class: "dc-wp-label", "text-anchor": "middle", "font-size": fontSize }); label.textContent = Waypoint.glyph(wp) + " " + (wp.name || "");
      g.append(dia, label, hitDot);
      hitDot.addEventListener("mousedown", (e: any) => startDrag(e, "body")); wireTop(hitDot);
    }
    sync();
    return g;
  }

  protected drawCables2D(gRoot: SVGElement, dc: any): void {
    const rDot = DC_DOT_PX * this.markerScale / (this.scale || 1);
    this.resolvedCables(dc.id).forEach((rc) => { if (this.cableShown(rc)) this.drawCable2D(gRoot, rc, rDot); });
    // câbles SORTANTS (un seul bout ici) : tracés jusqu'à l'exit de la salle
    this.outgoingCableStubs(dc.id).forEach((st) => { if (this.cableShown(st)) this.drawCable2D(gRoot, st, rDot); });
  }

  /** Trace UN câble en vue Dessus (spline x,y + pastilles d'extrémité), depuis `{ cable, pts }`. */
  protected drawCable2D(gRoot: SVGElement, rc: { cable: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }, rDot: number): void {
    const line2 = rc.linePts.map((p) => ({ h: p.x, v: p.y }));   // tracé (avec amorces)
    const ends = rc.pts.map((p) => ({ h: p.x, v: p.y }));        // pastilles sur points ORIGINAUX
    const col = this.cableColor(rc.cable), d = this.cablePath(line2, rc.straight, rc.stubAt);
    const g = Dom.svg("g", { class: "dc-cable-g" });
    const line = Dom.svg("path", { class: "dc-cable status-" + (rc.cable.status || "cable") + (this.cableHit(rc.cable) ? " hit" : "") + (this.selCables.has(rc.cable.id) ? " sel" : ""), d, "data-cable": rc.cable.id }); if (col) (line as any).style.stroke = col;
    const hit = Dom.svg("path", { class: "dc-cable-hit", d, "data-cable": rc.cable.id });
    this.wireTip(hit, () => this.cableTipHtml(rc.cable));
    this.wireClick(hit, () => { this.hideTip(); this.host.openCableForm?.(rc.cable.id); }); hit.addEventListener("contextmenu", (e: any) => { this.hideTip(); this.ctxMenu(e, this.cableCtx(rc.cable)); });
    g.append(line, hit); gRoot.appendChild(g);
    [ends[0], ends[ends.length - 1]].forEach((p) => { const dot = Dom.svg("circle", { class: "dc-cable-end", cx: p.h, cy: p.v, r: rDot }); if (col) (dot as any).style.fill = col; gRoot.appendChild(dot); });
  }

  /** Écran → monde (vue Dessus, transform translate+scale sans rotation). */
  protected clientToWorld(cx: number, cy: number): { x: number; y: number } {
    if (!this.svg || this.scale == null) return { x: 0, y: 0 };
    const r = this.svg.getBoundingClientRect();
    let x = (cx - r.left - this.tx) / this.scale, y = (cy - r.top - this.ty) / this.scale;
    if (this.floorXf) {   // vue 2D tournée → inverse la rotation (écran→monde) ; + miroir horizontal
      const f = this.floorXf, rad = -f.angle * Math.PI / 180, co = Math.cos(rad), si = Math.sin(rad);
      const dx = x - f.cx, dy = y - f.cy;
      let wx = f.cx + dx * co - dy * si; const wy = f.cy + dx * si + dy * co;
      if (f.flip) wx = 2 * f.cx - wx;   // inverse le miroir (après la rotation, comme dans le transform)
      return { x: wx, y: wy };
    }
    return { x, y };
  }

  protected snap(v: number, cell: number): number { return (Math.round(v / cell - 0.5) + 0.5) * cell; }

  protected rackHalfExtents(r: any): { hx: number; hy: number } {
    const w = r.width_mm || RACK_WIDTH_DEFAULT, d = r.depth || RACK_DEPTH_DEFAULT, o = Normalize.rackOrientation(r.orientation);
    return (o === 90 || o === 270) ? { hx: d / 2, hy: w / 2 } : { hx: w / 2, hy: d / 2 };
  }

}
