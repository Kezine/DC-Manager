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
import { DcCamera } from "./DcCamera";

export class DcScene3D extends DcCamera {

  renderThreeD(dc: any): void {
    this.persistView();   // capture l'état complet de la vue (débouncé)
    this.floorXf = null;   // pas de rotation de vue en 3D (réservée aux vues 2D Dessus/Étage)
    // disposition multi-salles (étages empilés / bâtiments côte à côte) — sinon mono-salle (null)
    this._multi = this.multiDc ? this.floor.multiLayout(this.current(), { visibleDcIds: this.visibleDcIds }) : null;
    this._farCull = this.cullDistanceM > 0 && this.camViewWidthM(dc) > this.cullDistanceM;   // culling de distance (perf)
    const gRoot = this.newScene(dc);
    if (this.scale == null) this.recenter();   // établit l'échelle AVANT de bâtir → marqueurs écran-constants (ports/waypoints) à la bonne taille dès le 1er rendu
    const c = this.camCenter(dc); this._camC = c;   // mémorisé pour l'aperçu de route → souris
    const proj = (p: Vec3) => this.project3DCam(p, c);
    const drawables: Drawable[] = [];
    if (this._multi) {
      const m = this._multi, topIdx = Math.max(0, m.levels.length - 1);
      // biais de profondeur PAR ÉTAGE : niveau bas → derrière (depth plus grande). Appliqué à TOUT élément
      // propre à un étage (contenu de salle, sols, OOB) → un sol haut occulte le contenu d'un étage bas.
      const lvlBias = (lvl: number) => { const i = m.levels.indexOf(lvl); return (topIdx - (i >= 0 ? i : 0)) * m.levelStep; };
      // routes inter-salles + câbles d'équipement d'étage tracés GLOBALEMENT → les salles ne les redessinent pas
      const inter = this.interDcRoutes(m);
      const skip = new Set(inter.map((x) => x.cable.id));
      this.store.all("cables").forEach((c: any) => { if (this.isFloorPort(c.from_port_id) || this.isFloorPort(c.to_port_id)) skip.add(c.id); });
      // chaque salle est rendue dans son repère LOCAL (roomToWorld), décalée au niveau de son étage
      m.rooms.forEach((room: RoomPlacement) => {
        const projRoom = (p: Vec3) => proj(FloorLayout.roomToWorld(room, p));
        const rd: Drawable[] = [];
        this.room3D(room.dc, projRoom, rd, skip);
        const b = lvlBias(room.level);
        rd.forEach((d) => { d.depth += b; drawables.push(d); });
      });
      this.floorPlanes3D(m, proj, drawables, lvlBias);   // grilles de plan d'étage (par bâtiment × étage)
      this.floorOobs3D(m, proj, drawables, lvlBias);     // OOB posés sur leur étage (même sans salle/câble)
      this.floorEquip3D(m, proj, drawables, lvlBias);    // équipements posés sur un étage (AP / switch volant)
      this.floorEquipCables3D(m, proj, drawables);       // câbles touchant un équipement d'étage
      this.interDc3D(inter, proj, drawables);            // câbles inter-salles (transversaux, profondeur naturelle)
      this.multiDecor3D(m, proj, drawables);             // étiquettes étage/bâtiment + séparateurs
    } else {
      this.room3D(dc, proj, drawables);
    }
    this.drawRoutePreview3D(dc, proj, drawables);   // aperçu de la route en cours (au-dessus de tout)
    if (this.showPivot) {   // marqueur du centre de rotation (se projette en 0,0)
      const s = ((dc && dc.cell_mm) || 600) * 0.32, g = Dom.svg("g", { class: "dc-cam-pivot" });
      g.appendChild(Dom.svg("line", { x1: -s, y1: 0, x2: s, y2: 0 }));
      g.appendChild(Dom.svg("line", { x1: 0, y1: -s, x2: 0, y2: s }));
      g.appendChild(Dom.svg("circle", { cx: 0, cy: 0, r: s * 0.5 }));
      drawables.push({ depth: -1e9, node: g });
    }
    drawables.sort((a, b) => b.depth - a.depth).forEach((d) => gRoot.appendChild(d.node));   // peintre : loin d'abord
    this.finishScene();
  }

  protected room3D(dc: any, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[], skipCables?: Set<string>): void {
    const W = dc.width_mm, D = dc.depth_mm;
    const pts = [[0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0]].map(([x, y, z]) => proj({ x, y, z }));
    drawables.push({ depth: 1e9, node: Dom.svg("polygon", { class: "dc-floor3d", points: pts.map((p) => p.h + "," + p.v).join(" ") }) });
    // liseré sur le FRONT de la salle (bord local y=0)
    if (this.showOrientMarks) { const a = pts[0], b = pts[1]; drawables.push({ depth: 1e9 - 0.5, node: Dom.svg("line", { class: "dc-orient-front", x1: a.h, y1: a.v, x2: b.h, y2: b.v }) }); }
    this.racks(dc.id).forEach((r) => { if (!this.hidden3dRacks.has(r.id)) drawables.push(this.rackBox3D(r, proj)); });
    // équipements en dimensionnement LIBRE posés dans la salle (à plat + décalage vertical)
    this.store.freeEquipsOfDc(dc.id).forEach((e: any) => { if (e.dc_x != null && e.dc_y != null) drawables.push(this.equipBox3D(e, proj)); });
    // waypoints (pins/rails) de la salle — la brosse est dessinée par sa baie (sous-phase ultérieure)
    this.store.waypointsOfDc(dc.id).forEach((wp: any) => {
      if (!this.store.waypointIsPlaced(wp) || wp.kind === "brush") return;
      const seg = wp.kind === "segment";
      if (seg ? (this.showWaypoints || this.showConduits) : this.showWaypoints) drawables.push(this.waypoint3D(wp, proj));   // chemin : tray (conduits) OU marqueurs ; pin : marqueurs
    });
    // câbles INTRA-salle (les deux bouts résolus ici) — au-dessus des équipements
    this.resolvedCables(dc.id).forEach((rc) => { if (this.cableShown(rc)) this.emitCable3D(rc, proj, drawables); });
    // câbles SORTANTS (un seul bout ici) : tracés jusqu'à l'exit de la salle (« s'arrêtent au mur »).
    // En multi-salles, les câbles tracés GLOBALEMENT comme routes inter-DC sont sautés (pas de double tracé).
    this.outgoingCableStubs(dc.id).forEach((st) => { if (skipCables && skipCables.has(st.cable.id)) return; if (this.cableShown(st) && !this.hidden3dRacks.has(st.portRackId as any)) this.emitCable3D(st, proj, drawables); });
  }


  /* ---- routes inter-salles (multi-salles) : câble dcA≠dcB tracé GLOBALEMENT d'une salle à l'autre ---- */

  /** Points de passage MONDE d'une route (waypoints de salle résolus dans leur salle + OOB au monde). */
  protected buildWorldVia(steps: any[], roomById: Map<string, RoomPlacement>, m: MultiLayout, aw: Vec3, bw: Vec3, cableId: string): Array<{ p: Vec3; wp: any; oob?: boolean }> {
    const items = (steps || []).map((s: any) => {
      if (s.type === "floor") return { wp: s.wp, oob: true, p: this.floor.oobWorld(m, s.wp) } as any;
      const room = roomById.get(s.wp.datacenter_id);
      return room ? { wp: s.wp, room } as any : null;
    }).filter(Boolean) as any[];
    const anch = items.map((it) => it.oob ? it.p : FloorLayout.roomToWorld(it.room, this.resolver.waypointAnchor(it.wp)));
    const prevA = (i: number) => { for (let j = i - 1; j >= 0; j--) if (anch[j]) return anch[j]; return aw; };
    const nextA = (i: number) => { for (let j = i + 1; j < items.length; j++) if (anch[j]) return anch[j]; return bw; };
    const via: Array<{ p: Vec3; wp: any; oob?: boolean }> = [];
    items.forEach((it, i) => {
      if (it.oob) { via.push({ p: it.p, wp: it.wp, oob: true }); return; }
      const lprev = FloorLayout.roomToLocal(it.room, prevA(i)), lnext = FloorLayout.roomToLocal(it.room, nextA(i));
      const off = this.resolver.conduitOffsetFor(it.wp, cableId, lprev, lnext);
      this.resolver.waypointPassPoints(it.wp, lprev, lnext, off).forEach((p: Vec3) => via.push({ p: FloorLayout.roomToWorld(it.room, p), wp: it.wp }));
    });
    return via;
  }
  /** Câbles inter-salles : route valide avec exits, 2 bouts résolus dans des salles AFFICHÉES.
      → { cable, a, b, pts } (pts en MONDE : port A → waypoints → port B, salles masquées sautées). */

  protected interDcRoutes(m: MultiLayout): Array<{ cable: any; a: any; b: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
    const roomById = new Map<string, RoomPlacement>(m.rooms.map((r) => [r.dc.id, r]));
    const out: Array<{ cable: any; a: any; b: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> = [];
    this.store.all("cables").forEach((c: any) => {
      const r = this.store.cableRoute(c);
      if (!r.valid || !r.hasExits || !r.dcA || !r.dcB) return;
      const ra = roomById.get(r.dcA), rb = roomById.get(r.dcB);
      if (!ra || !rb) return;
      const a = this.resolver.resolvePort3D(c.from_port_id, r.dcA), b = this.resolver.resolvePort3D(c.to_port_id, r.dcB);
      if (!a || !b) return;
      const aw: any = FloorLayout.roomToWorld(ra, a as Vec3), bw: any = FloorLayout.roomToWorld(rb, b as Vec3);
      aw.n = this.worldEndNormal(ra, a); bw.n = this.worldEndNormal(rb, b);   // normales tournées en monde (sortie ⊥)
      const via = this.buildWorldVia(r.steps, roomById, m, aw, bw, c.id);
      const sp = this.cableLine(aw, bw, via);
      out.push({ cable: c, a, b, pts: sp.pts, linePts: sp.linePts, straight: sp.straight, stubAt: sp.stubAt });
    });
    return out;
  }

  protected interDc3D(inter: Array<{ cable: any; a: any; b: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }>, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[]): void {
    inter.forEach((rc) => {
      if (!this.cableShown(rc)) return;
      if (this.hidden3dRacks.has(rc.a.rackId) || this.hidden3dRacks.has(rc.b.rackId)) return;
      this.emitCable3D({ cable: rc.cable, pts: rc.pts, linePts: rc.linePts, straight: rc.straight, stubAt: rc.stubAt }, proj, drawables);
    });
  }


  /* ---- décor multi-salles (plans d'étage · OOB · étiquettes étage/bâtiment) ---- */

  /** Plans de grille d'étage en 3D (un par étage affiché de chaque bâtiment) + cases inaccessibles. */
  protected floorPlanes3D(m: MultiLayout, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[], lvlBias: (lv: number) => number): void {
    m.floorPlanes.forEach((fp) => {
      const W = fp.cfg.width_mm, D = fp.cfg.depth_mm, cell = fp.cfg.cell_mm, ox = fp.off.x, oy = fp.off.y, z = fp.off.z;
      const C = [[0, 0], [W, 0], [W, D], [0, D]].map(([x, y]) => proj({ x: ox + x, y: oy + y, z }));
      const base = C.reduce((s, p) => s + p.depth, 0) / 4 + Math.max(W, D) + lvlBias(FloorLayout.floorNum(fp.floor));
      const plane = Dom.svg("polygon", { class: "dc-floorplane3d" + (this.showFloorGrid ? "" : " no-grid"), points: C.map((p) => p.h + "," + p.v).join(" ") });
      const tip = Dom.svg("title"); tip.textContent = "Étage — " + (FloorLayout.locationLabel(fp.loc) || "(bâtiment ?)") + " · ét. " + (fp.floor || "0"); plane.appendChild(tip);
      plane.addEventListener("contextmenu", (e: any) => { this.hideTip(); this.ctxMenu(e, this.floorPlane3DCtx(fp.loc || "", String(fp.floor || ""))); });   // clic droit dalle 3D → activer salle / éditer étage
      drawables.push({ depth: base + 6, node: plane });
      if (this.showFloorGrid) {
        const g = Dom.svg("g", { class: "dc-floorplane3d-grid" }); (g as any).style.pointerEvents = "none";
        const step = Math.max(cell, Math.max(W, D) / 40);   // limite le nombre de lignes (perf)
        for (let x = 0; x <= W + 0.5; x += step) { const a = proj({ x: ox + x, y: oy, z }), bb = proj({ x: ox + x, y: oy + D, z }); g.appendChild(Dom.svg("line", { x1: a.h, y1: a.v, x2: bb.h, y2: bb.v })); }
        for (let y = 0; y <= D + 0.5; y += step) { const a = proj({ x: ox, y: oy + y, z }), bb = proj({ x: ox + W, y: oy + y, z }); g.appendChild(Dom.svg("line", { x1: a.h, y1: a.v, x2: bb.h, y2: bb.v })); }
        drawables.push({ depth: base + 5, node: g });
      }
      if (this.showOrientMarks) { const a = proj({ x: ox, y: oy, z }), bb = proj({ x: ox + W, y: oy, z }); drawables.push({ depth: base + 4.5, node: Dom.svg("line", { class: "dc-orient-ref-edge", x1: a.h, y1: a.v, x2: bb.h, y2: bb.v }) }); }
      (fp.cfg.blocked_cells || []).forEach((key) => {
        const pp = key.split(","), cx = +pp[0], cy = +pp[1]; if (!isFinite(cx) || !isFinite(cy)) return;
        const rx = cx * cell, ry = cy * cell; if (rx < 0 || ry < 0 || rx >= W || ry >= D) return;
        const cc = [[rx, ry], [rx + cell, ry], [rx + cell, ry + cell], [rx, ry + cell]].map(([x, y]) => proj({ x: ox + x, y: oy + y, z }));
        drawables.push({ depth: base + 4, node: Dom.svg("polygon", { class: "dc-cell-blocked", points: cc.map((p) => p.h + "," + p.v).join(" ") }) });
      });
    });
  }


  /** OOB posés sur leur étage : anneau ◎ (taille écran constante) + mât pointillé vers le sol. Cliquable. */
  protected floorOobs3D(m: MultiLayout, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[], lvlBias: (lv: number) => number): void {
    if (!this.showWaypoints) return;
    const shown = new Set(m.floorPlanes.map((fp) => (fp.loc || "") + "" + String(fp.floor || "")));
    this.store.oobWaypoints().forEach((wp: any) => {
      const loc = wp.location || "", fl = String(wp.floor || "");
      if (!shown.has(loc + "" + fl)) return;
      const w = this.floor.oobWorld(m, wp);
      const p = proj(w), bse = proj({ x: w.x, y: w.y, z: FloorLayout.levelZ(m, FloorLayout.floorNum(fl)) });
      const g = Dom.svg("g", { class: "dc-wp3d wp-oob" });
      g.appendChild(Dom.svg("line", { class: "dc-wp-mast", x1: bse.h, y1: bse.v, x2: p.h, y2: p.v }));
      const ring = Dom.svg("circle", { class: "dc-wp3d-oob", cx: p.h, cy: p.v, r: (DC_DOT_PX + 5) * this.markerScale / (this.scale || 1), "data-wp": wp.id });
      const hit = Dom.svg("circle", { class: "dc-wp-hit", cx: p.h, cy: p.v, r: 14 / (this.scale || 1), "data-wp": wp.id });
      const tt = Dom.svg("title"); tt.textContent = (Waypoint.glyph(wp) + " " + (wp.name || "(OOB)")).trim(); hit.appendChild(tt);
      this.wireWp(hit, wp);
      g.append(ring, hit);
      drawables.push({ depth: p.depth - 2e4 + lvlBias(FloorLayout.floorNum(fl)), node: g });
    });
  }


  /** Étiquettes d'étage (à gauche) + nom de bâtiment (vertical) + séparateurs entre bâtiments. */
  protected multiDecor3D(m: MultiLayout, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[]): void {
    const fontL = Math.max(160, m.gap * 0.22), charW = 0.6 * fontL;
    let floorAnchorH: number | null = null, maxChars = 0, vSum = 0, vN = 0;
    m.levels.forEach((lv, i) => {
      const z = i * (m.stackH + m.gap), p = proj({ x: -m.gap * 0.6, y: 0, z }), txt = "Étage " + lv;
      const t = Dom.svg("text", { class: "dc-level-label", x: p.h, y: p.v, "text-anchor": "end", "font-size": fontL }); t.textContent = txt;
      drawables.push({ depth: p.depth + 1, node: t });
      floorAnchorH = (floorAnchorH == null) ? p.h : Math.min(floorAnchorH, p.h);
      maxChars = Math.max(maxChars, txt.length); vSum += p.v; vN++;
    });
    const floorLeftEdge = (floorAnchorH != null) ? floorAnchorH - maxChars * charW : null, floorMidV = vN ? vSum / vN : 0;
    m.buildings.forEach((b, i) => {
      let aH: number, aV: number, dep: number;
      if (i === 0 && floorLeftEdge != null) { aH = floorLeftEdge - fontL * 1.2; aV = floorMidV; dep = proj({ x: -m.gap * 0.6, y: 0, z: m.topZ / 2 }).depth; }
      else { const pc = proj({ x: b.x0 - m.gap * 0.95, y: 0, z: m.topZ / 2 }); aH = pc.h; aV = pc.v; dep = pc.depth; }
      const t = Dom.svg("text", { class: "dc-bldg-label", x: aH, y: aV, "text-anchor": "middle", "font-size": fontL * 1.3, transform: "rotate(-90 " + aH + " " + aV + ")" });
      t.textContent = FloorLayout.locationLabel(b.loc); drawables.push({ depth: dep, node: t });
      if (i > 0) {
        const xs = b.x0 - m.gap, C = [proj({ x: xs, y: 0, z: 0 }), proj({ x: xs, y: m.maxD, z: 0 }), proj({ x: xs, y: m.maxD, z: m.topZ }), proj({ x: xs, y: 0, z: m.topZ })];
        drawables.push({ depth: C.reduce((s, p) => s + p.depth, 0) / 4, node: Dom.svg("polygon", { class: "dc-bldg-sep", points: C.map((p) => p.h + "," + p.v).join(" ") }) });
      }
    });
  }
  /** Équipements posés sur un ÉTAGE (placement « floor ») en 3D : boîte d'équipement libre au point monde de
      leur étage (+ mât pointillé si surélevé), au niveau Z de l'étage (biais peintre). */

  protected floorEquip3D(m: MultiLayout, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[], lvlBias: (lv: number) => number): void {
    const shown = new Set(m.floorPlanes.map((fp) => (fp.loc || "") + "" + String(fp.floor || "")));
    this.store.floorEquipments().forEach((eq: any) => {
      const loc = eq.location || "", fl = String(eq.floor || "");
      if (!shown.has(loc + "" + fl)) return;
      const lb = lvlBias(FloorLayout.floorNum(fl));
      const w = this.floor.equipFloorWorld(m, eq);
      if (eq.dc_z) {   // mât pointillé vers le sol de l'étage si surélevé
        const base = proj({ x: w.x, y: w.y, z: FloorLayout.levelZ(m, FloorLayout.floorNum(fl)) }), top = proj(w);
        const mast = Dom.svg("g"); mast.appendChild(Dom.svg("line", { class: "dc-wp-mast", x1: base.h, y1: base.v, x2: top.h, y2: top.v }));
        drawables.push({ depth: top.depth + 5 + lb, node: mast });
      }
      const box = this.freeEquipBoxAt(eq, w.x, w.y, w.z, proj, { sel: this.selFloorEquip === eq.id });
      drawables.push({ depth: box.depth + lb, node: box.node });
    });
  }

  /** Un port appartient-il à un équipement posé sur un étage ? */
  protected isFloorPort(pid: string): boolean { const p: any = pid ? this.store.get("ports", pid) : null; const e: any = p ? this.store.get("equipments", p.equipment_id) : null; return !!(e && e.placement_mode === "floor"); }

  /** Résout un bout de câble en point MONDE pour la 3D multi : équipement d'étage (boîte au monde) OU port en salle. */
  protected resolveFloorCableEnd(m: MultiLayout, roomById: Map<string, RoomPlacement>, shown: Set<string>, pid: string): any {
    const p: any = pid ? this.store.get("ports", pid) : null; if (!p) return null;
    const geo: any = p.parent_port_id ? (this.store.get("ports", p.parent_port_id) || p) : p;   // breakout : géométrie du trunk
    const eq: any = this.store.get("equipments", p.equipment_id); if (!eq) return null;
    if (eq.placement_mode === "floor") {
      const loc = eq.location || "", fl = String(eq.floor || ""); if (!shown.has(loc + "" + fl)) return null;
      const w = this.floor.equipFloorWorld(m, eq), pt = FreeEquipGeometry.portWorldC(eq, geo, w.x, w.y, w.z);
      return { x: pt.x, y: pt.y, z: pt.z, rackId: null, n: FreeEquipGeometry.portNormal(eq, geo) };   // normale déjà en monde (sortie ⊥)
    }
    const dcId = this.store.equipmentDcId(eq.id), room = dcId ? roomById.get(dcId) : null; if (!room) return null;
    const res = this.resolver.resolvePort3D(pid, dcId); if (!res) return null;
    const w = FloorLayout.roomToWorld(room, res as Vec3);
    return { x: w.x, y: w.y, z: w.z, rackId: (res as any).rackId, n: this.worldEndNormal(room, res) };   // normale tournée en monde
  }

  /** Câbles touchant un équipement d'étage (≥ 1 bout « floor ») : tracés GLOBALEMENT en repère monde. */
  protected floorEquipCables3D(m: MultiLayout, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[]): void {
    const roomById = new Map<string, RoomPlacement>(m.rooms.map((r) => [r.dc.id, r]));
    const shown = new Set(m.floorPlanes.map((fp) => (fp.loc || "") + "" + String(fp.floor || "")));
    this.store.all("cables").forEach((c: any) => {
      if (!this.isFloorPort(c.from_port_id) && !this.isFloorPort(c.to_port_id)) return;
      const a = this.resolveFloorCableEnd(m, roomById, shown, c.from_port_id), b = this.resolveFloorCableEnd(m, roomById, shown, c.to_port_id);
      if (!a || !b) return;
      const r = this.store.cableRoute(c);
      const via = this.buildWorldVia(r.valid ? r.steps : [], roomById, m, a, b, c.id);
      const sp = this.cableLine(a, b, via); const rc = { cable: c, pts: sp.pts, linePts: sp.linePts, straight: sp.straight, stubAt: sp.stubAt };
      if (!this.cableShown(rc)) return;
      if (this.hidden3dRacks.has(a.rackId) || this.hidden3dRacks.has(b.rackId)) return;
      this.emitCable3D(rc, proj, drawables);
    });
  }
  /** Baie en boîte 3D : enveloppe (6 faces, classées near/far) + occupants U + montants 19″
      + emplacements libres, ordonnés par un tri PEINTRE topologique (occlusion correcte). */

  protected rackBox3D(r: any, proj: (p: Vec3) => { h: number; v: number; depth: number }): Drawable {
    const w = r.width_mm || RACK_WIDTH_DEFAULT, d = r.depth || RACK_DEPTH_DEFAULT, H = RackGeometry.physHeight(r);
    const o = Normalize.rackOrientation(r.orientation) * Math.PI / 180, co = Math.cos(o), so = Math.sin(o);
    const cx = (r.dc_x != null) ? r.dc_x : w / 2, cy = (r.dc_y != null) ? r.dc_y : d / 2, hw = w / 2, hd = d / 2;
    const toW = (lx: number, ly: number, lz: number): Vec3 => ({ x: cx + lx * co - ly * so, y: cy + lx * so + ly * co, z: lz });
    const C = [toW(-hw, -hd, 0), toW(hw, -hd, 0), toW(hw, hd, 0), toW(-hw, hd, 0), toW(-hw, -hd, H), toW(hw, -hd, H), toW(hw, hd, H), toW(-hw, hd, H)].map(proj);
    const faces = [
      { idx: [0, 1, 2, 3], kind: "bottom" }, { idx: [4, 5, 6, 7], kind: "top" },
      { idx: [0, 1, 5, 4], kind: "front" }, { idx: [3, 2, 6, 7], kind: "back" },
      { idx: [0, 3, 7, 4], kind: "left" }, { idx: [1, 2, 6, 5], kind: "right" },
    ];
    const sel = this.selRackId === r.id;
    const g = Dom.svg("g", { class: "dc-rack3d-group" });
    if (this.fadedRacks.has(r.id)) g.setAttribute("opacity", "0.1");   // baie + contenu estompés (voir au travers)
    const center = proj(toW(0, 0, H / 2));
    const L: number[][] = [[-hw, -hd, 0], [hw, -hd, 0], [hw, hd, 0], [-hw, hd, 0], [-hw, -hd, H], [hw, -hd, H], [hw, hd, H], [-hw, hd, H]];
    const NRM: Record<string, number[]> = { bottom: [0, 0, -1], top: [0, 0, 1], front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0] };
    const SOLID: Record<string, number> = { top: 1, left: 1, right: 1 };   // seules ces faces opaques peuvent occulter (« proches »)
    const EPS = Math.max(w, d, H) * 0.02 + 5;
    const faceNear = (lc: number[], n: number[]) => proj(toW(lc[0] + n[0] * EPS, lc[1] + n[1] * EPS, lc[2] + n[2] * EPS)).depth < proj(toW(lc[0], lc[1], lc[2])).depth;
    const wallNodes: Array<{ depth: number; near: boolean; node: SVGElement }> = [];
    const gCap = RackGeometry.capGrid(r);
    faces.forEach((f) => {
      if (!this.showRackSides && (f.kind === "left" || f.kind === "right" || f.kind === "top")) return;
      const fpts = f.idx.map((i) => C[i]);
      const cd = fpts.reduce((s, p) => s + p.depth, 0) / 4;
      // CAPOTS toit/sol : cellules autorisées PERCÉES comme des TROUS (path evenodd) au lieu d'un polygone plein.
      const capF = (f.kind === "top") ? "roof" : (f.kind === "bottom") ? "floor" : null;
      const capHoles = capF ? RackGeometry.capCells(r, capF).map((k) => { const q = k.split(","); return { cx: +q[0], cy: +q[1] }; })
        .filter((c) => isFinite(c.cx) && isFinite(c.cy) && c.cx >= 0 && c.cy >= 0 && c.cx < gCap.nx && c.cy < gCap.ny) : [];
      let poly: SVGElement, faceNode: SVGElement;
      if (capF && capHoles.length) {
        const zc = (f.kind === "top") ? H : 0;
        const ringD = (P: Array<{ h: number; v: number }>) => "M" + P.map((p) => p.h + " " + p.v).join(" L") + " Z";
        let dStr = ringD(fpts);
        const rims: SVGElement[] = [];
        capHoles.forEach((c) => {
          const lx0 = -w / 2 + c.cx * gCap.cell, lx1 = lx0 + gCap.cell, ly0 = -d / 2 + c.cy * gCap.cell, ly1 = ly0 + gCap.cell;
          const HP = [toW(lx0, ly0, zc), toW(lx1, ly0, zc), toW(lx1, ly1, zc), toW(lx0, ly1, zc)].map(proj);
          dStr += " " + ringD(HP);   // découpe evenodd (trou réel, traversant)
          const rim = Dom.svg("polygon", { class: "dc-cap-hole", points: HP.map((p) => p.h + "," + p.v).join(" ") });   // contour visible du trou
          (rim as any).style.pointerEvents = "none"; rims.push(rim);
        });
        poly = Dom.svg("path", { class: "dc-rack3d face-" + f.kind + (sel ? " sel" : ""), "fill-rule": "evenodd", d: dStr, "data-rack": r.id });
        const grp = Dom.svg("g"); grp.appendChild(poly); rims.forEach((o) => grp.appendChild(o));   // capot + contours des trous
        faceNode = grp;
      } else {
        poly = Dom.svg("polygon", { class: "dc-rack3d face-" + f.kind + (sel ? " sel" : ""), points: fpts.map((p) => p.h + "," + p.v).join(" "), "data-rack": r.id });
        faceNode = poly;
      }
      this.wireRack(poly, r);
      const lc = f.idx.reduce((acc, i) => [acc[0] + L[i][0], acc[1] + L[i][1], acc[2] + L[i][2]], [0, 0, 0]).map((v) => v / 4);
      const near = SOLID[f.kind] ? faceNear(lc, NRM[f.kind]) : false;
      wallNodes.push({ depth: cd, near, node: faceNode });
    });
    // plinthe accent (repère d'avant), au plan local y=−hd (toujours « lointaine »)
    {
      const bandH = Math.min(H * 0.03, U_MM * 0.5);
      const B = [toW(-hw, -hd, 0), toW(hw, -hd, 0), toW(hw, -hd, bandH), toW(-hw, -hd, bandH)].map(proj);
      const band = Dom.svg("polygon", { class: "dc-rack3d-front", points: B.map((p) => p.h + "," + p.v).join(" ") });
      const t = Dom.svg("title"); t.textContent = "Avant"; band.appendChild(t);
      wallNodes.push({ depth: B.reduce((s, p) => s + p.depth, 0) / 4 - 3, near: false, node: band });
    }
    // PORTES en saillie (avant/arrière) : panneaux translucides + charnière ; peintes near/far comme les parois.
    if (this.showDoors) {
      const drawDoor = (face: string) => {
        const dr = RackGeometry.door(r, face); if (!dr || !dr.enabled) return;
        const T = Math.max(1, dr.thickness_mm | 0);
        const yInner = (face === "rear") ? hd : -hd, yOuter = (face === "rear") ? (hd + T) : (-hd - T);
        const nDoor = (face === "rear") ? [0, 1, 0] : [0, -1, 0];
        const doorNear = faceNear([0, yInner, H / 2], nDoor);
        const D8 = [toW(-hw, yInner, 0), toW(hw, yInner, 0), toW(hw, yOuter, 0), toW(-hw, yOuter, 0), toW(-hw, yInner, H), toW(hw, yInner, H), toW(hw, yOuter, H), toW(-hw, yOuter, H)].map(proj);
        const tip = "Porte " + (face === "rear" ? "arrière" : "avant") + " · " + T + " mm · " + (dr.hollow ? "creuse" : "pleine") + " · charnière " + (dr.hinge === "right" ? "droite" : "gauche");
        Box.faces(D8).forEach((f: any) => { const poly = Dom.svg("polygon", { class: "dc-rack-door" + (dr.hollow ? " hollow" : ""), points: f.pts.map((p: any) => p.h + "," + p.v).join(" ") }); const tt = Dom.svg("title"); tt.textContent = tip; poly.appendChild(tt); wallNodes.push({ depth: f.cd, near: doorNear, node: poly }); });
        const hx = (dr.hinge === "right") ? hw : -hw;
        const e0 = proj(toW(hx, yOuter, 0)), e1 = proj(toW(hx, yOuter, H));
        wallNodes.push({ depth: Math.min(e0.depth, e1.depth) - 5, near: doorNear, node: Dom.svg("line", { class: "dc-rack-door-hinge", x1: e0.h, y1: e0.v, x2: e1.h, y2: e1.v }) });
      };
      drawDoor("front"); drawDoor("rear");
    }
    const eqNodes = this.rackInterior3D(r, toW, proj, faceNear, NRM);
    const byDepth = (a: { depth: number }, b: { depth: number }) => b.depth - a.depth;
    wallNodes.filter((o2) => !o2.near).sort(byDepth).forEach((o2) => g.appendChild(o2.node));
    eqNodes.sort(byDepth).forEach((o2) => g.appendChild(o2.node));
    wallNodes.filter((o2) => o2.near).sort(byDepth).forEach((o2) => g.appendChild(o2.node));
    const topC = proj(toW(0, 0, H));
    const lab = Dom.svg("text", { class: "dc-rack3d-label", x: topC.h, y: topC.v - 6, "text-anchor": "middle", "font-size": Math.max(35, Math.min(w, d) * 0.15) });
    lab.textContent = r.name || ""; g.appendChild(lab);
    return { depth: center.depth, node: g };
  }


  /** Intérieur d'une baie : occupants U (av/ar) · montants 19″ · emplacements libres, triés peintre. */
  protected rackInterior3D(r: any, toW: (lx: number, ly: number, lz: number) => Vec3, proj: (p: Vec3) => { h: number; v: number; depth: number }, faceNear: (lc: number[], n: number[]) => boolean, NRM: Record<string, number[]>): Drawable[] {
    const w = r.width_mm || RACK_WIDTH_DEFAULT, d = r.depth || RACK_DEPTH_DEFAULT, H = RackGeometry.physHeight(r);
    const o = Normalize.rackOrientation(r.orientation) * Math.PI / 180, co = Math.cos(o), so = Math.sin(o);
    const gap = 2, bodyHW = RACK_MOUNT_WIDTH / 2 - RACK_EAR_MM, bz = RackGeometry.uBaseZ(r), VG = 0.5, hd = d / 2;
    const fmY = RackGeometry.frontMargin(r), cageY = Math.min(d, RackGeometry.cageDepth(r)), fpY = -hd + fmY, rpY = -hd + fmY + cageY;
    const frontExtra = RackGeometry.doorExtraDepth(r, "front"), rearExtra = RackGeometry.doorExtraDepth(r, "rear");
    const d0 = proj(toW(0, 0, 0)).depth;
    const gX = proj(toW(1, 0, 0)).depth - d0, gY = proj(toW(0, 1, 0)).depth - d0, gZ = proj(toW(0, 0, 1)).depth - d0;
    const grad: [number, number, number] = [gX, gY, gZ];
    interface Unit { kind: string; lo: [number, number, number]; hi: [number, number, number]; [k: string]: any; }
    const units: Unit[] = [];
    // occupants U (équipements + pseudo-items)
    this.scene.occupantsElev(r.id).forEach((oc) => {
      const front = oc.side !== "rear";
      if (front ? this.hideFrontEq : this.hideRearEq) return;
      const span = Depths.mountSpanMm(oc, cageY + (front ? frontExtra : rearExtra));
      let y0: number, y1: number;
      if (front) { y0 = fpY + gap; y1 = fpY + Math.max(gap + 4, span); } else { y0 = rpY - Math.max(gap + 4, span); y1 = rpY - gap; }
      const x0 = -bodyHW, x1 = bodyHW;
      const z0 = bz + (oc.u - 1) * U_MM + VG, z1 = bz + (oc.u - 1 + oc.h) * U_MM - VG;
      units.push({ kind: "occ", oc, front, x0, x1, y0, y1, z0, z1, lo: [x0, y0, z0], hi: [x1, y1, z1] });
    });
    // emplacements U libres (seulement la face REGARDÉE)
    const frontVisible = faceNear([0, -hd, H / 2], NRM.front);
    if (this.showPlaceholders && !this._farCull) {
      const occ = this.scene.occupants(r.id);
      const sidesL = r.sides === "dual" ? ["front", "rear"] : ["front"];
      const uMax = r.u_count || 42, x0e = -bodyHW, x1e = bodyHW;
      sidesL.forEach((side) => {
        if ((side === "front") !== frontVisible) return;
        const fyPlane = side === "rear" ? (rpY - gap) : (fpY + gap);
        for (let u = 1; u <= uMax; u++) {
          if (occ.has(u + ":" + side)) continue;
          const z0 = bz + (u - 1) * U_MM + 1, z1 = bz + u * U_MM - 1;
          units.push({ kind: "ph", u, side, fyPlane, x0e, x1e, z0, z1, lo: [x0e, fyPlane - 1, z0], hi: [x1e, fyPlane + 1, z1] });
        }
      });
    }
    // montants 19″ (rails) : barres verticales à l'entraxe ±RACK_MOUNT_WIDTH/2
    {
      const postX = RACK_MOUNT_WIDTH / 2, pw = Math.min(RACK_EAR_MM * 0.8, 8);
      const pz0 = RackGeometry.uBaseZ(r), pz1 = pz0 + (r.u_count || 42) * U_MM;
      const planes = (r.sides === "dual") ? [fpY, rpY] : [fpY];
      planes.forEach((ly) => { [postX, -postX].forEach((px) => { units.push({ kind: "post", px, ly, pw, pz0, pz1, lo: [px - pw, ly - 2, pz0], hi: [px + pw, ly + 2, pz1] }); }); });
    }
    // équipements montés en MARGE LATÉRALE (side) et en PAROI (wall) : boîtes pleines (dims libres).
    this.scene.sideOccupants(r.id, null, null).forEach((e: any) => {
      const front = e.side_face !== "rear";
      if (front ? this.hideFrontEq : this.hideRearEq) return;
      const b = RackGeometry.sideEquipBoxLocal(r, e);
      const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
      units.push({ kind: "side", e, front, x0, x1, y0, y1, z0: b.z0, z1: b.z1, lo: [x0, y0, b.z0], hi: [x1, y1, b.z1] });
    });
    this.scene.wallOccupants(r.id, null, null).forEach((e: any) => {
      const front = e.wall_margin !== "rear";
      if (front ? this.hideFrontEq : this.hideRearEq) return;
      const b = RackGeometry.wallEquipBoxLocal(r, e);
      const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
      units.push({ kind: "wall", e, front, x0, x1, y0, y1, z0: b.z0, z1: b.z1, lo: [x0, y0, b.z0], hi: [x1, y1, b.z1] });
    });
    // emplacements LATÉRAUX libres (boîtes plates au plan de la face regardée) → cibles d'assignation
    if (this.showPlaceholders && !this._farCull) {
      this.scene.sideFreeSlots(r).forEach((s) => {
        const front = s.face !== "rear";
        if (front !== frontVisible || (front ? this.hideFrontEq : this.hideRearEq)) return;
        const b = RackGeometry.sideSlotBoxLocal(r, s.face, s.lr, s.col, s.uTop, SIDE_U_STEP);
        const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1);
        units.push({ kind: "sidefree", s, front, x0, x1, yPlane: b.yPlane, z0: b.z0, z1: b.z1, lo: [x0, b.yPlane - 1, b.z0], hi: [x1, b.yPlane + 1, b.z1] });
      });
      // emplacements MURAUX libres (plaques au plan de la paroi)
      this.scene.wallFreeSlots(r).forEach((s) => {
        if ((s.margin === "front") !== frontVisible) return;
        const b = RackGeometry.wallSlotBoxLocal(r, s.wall, s.margin, s.col, s.uTop, SIDE_U_STEP);
        units.push({ kind: "wallfree", s, xPlane: b.xPlane, y0: b.y0, y1: b.y1, z0: b.z0, z1: b.z1, lo: [b.xPlane - 1, b.y0, b.z0], hi: [b.xPlane + 1, b.y1, b.z1] });
      });
      // TROUS DE CAPOT libres (toit/sol) : plaques horizontales (pin uniquement). Le toit n'est proposé
      // que si les capots sont affichés (sinon pas de trou visible) ; le sol l'est toujours.
      const gCap = RackGeometry.capGrid(r), hw = w / 2;
      [{ face: "roof", zc: H, show: this.showRackSides }, { face: "floor", zc: 0, show: true }].forEach((cp) => {
        if (!cp.show) return;
        this.scene.capFreeSlots(r, cp.face).forEach((s) => {
          const lx0 = -hw + s.cx * gCap.cell, lx1 = lx0 + gCap.cell, ly0 = -hd + s.cy * gCap.cell, ly1 = ly0 + gCap.cell;
          units.push({ kind: "capfree", s: { face: cp.face, cx: s.cx, cy: s.cy }, x0: lx0, x1: lx1, y0: ly0, y1: ly1, zc: cp.zc, lo: [lx0, ly0, cp.zc - 1], hi: [lx1, ly1, cp.zc + 1] });
        });
      });
    }
    // BROSSES de brassage ancrées à CETTE baie : boîte locale (corps × U × profondeur), ajoutée au flux trié
    // → occlusion correcte vs équipements/montants/parois ; rendu coque/tunnel dans la boucle d'émission.
    if (this.showWaypoints || this.showConduits) {   // coque = conduits ; marqueurs d'extrémités = marqueurs (gardés à l'émission)
      this.store.all("waypoints").forEach((wp: any) => {
        if (wp.kind !== "brush" || wp.rack_id !== r.id) return;
        const u0 = Math.max(1, wp.rack_u | 0), uh = Math.max(1, wp.u_height | 0);
        const bdepth = Math.min(Math.max(1, wp.depth_mm || 100), cageY);
        const bz0 = bz + (u0 - 1) * U_MM, bz1 = bz + (u0 - 1 + uh) * U_MM, by0 = fpY + 2, by1 = fpY + 2 + bdepth;
        units.push({ kind: "brush", wp, x0: -bodyHW, x1: bodyHW, y0: by0, y1: by1, z0: bz0, z1: bz1, lo: [-bodyHW, by0, bz0], hi: [bodyHW, by1, bz1] });
      });
    }
    this.painterTopoSort(units, grad, toW, proj);
    // émission : profondeur synthétique décroissante (BASE−seq) → le tri global conserve l'ordre.
    const eqNodes: Drawable[] = []; let seq = 0; const BASE = 1e7;
    units.forEach((unit) => {
      if (unit.kind === "post") {
        const { px, ly, pw, pz0, pz1 } = unit;
        const P = [toW(px - pw, ly, pz0), toW(px + pw, ly, pz0), toW(px + pw, ly, pz1), toW(px - pw, ly, pz1)].map(proj);
        const post = Dom.svg("polygon", { class: "dc-rack-post", points: P.map((p) => p.h + "," + p.v).join(" ") });
        const pt = Dom.svg("title"); pt.textContent = "Montant 19″"; post.appendChild(pt);
        eqNodes.push({ depth: BASE - seq, node: post }); seq++;
      } else if (unit.kind === "occ") {
        const oc = unit.oc, { front, x0, x1, y0, y1, z0, z1 } = unit;
        const cls = "dc-eq3d " + (oc.kind === "item" ? "item" : (front ? "front" : "rear")) + (oc.kind === "eq" && this.eqHit(oc.id) ? " hit" : "") + (oc.kind === "eq" && oc.id === this.focusEqId ? " focus-pulse" : "");
        const E = [toW(x0, y0, z0), toW(x1, y0, z0), toW(x1, y1, z0), toW(x0, y1, z0), toW(x0, y0, z1), toW(x1, y0, z1), toW(x1, y1, z1), toW(x0, y1, z1)].map(proj);
        const title = (oc.label || (oc.kind === "item" ? "(élément)" : "(équipement)")) + " · U" + oc.u + (oc.h > 1 ? "–U" + (oc.u + oc.h - 1) : "") + (front ? " · avant" : " · arrière");
        const occFill = oc.kind === "eq" ? this.eqFill(oc.id) : null;
        // images de façade : la face y0 = AVANT de l'équipement s'il est monté en façade (front), sinon ARRIÈRE.
        const imgEq = (this.showFaceImages && oc.kind === "eq") ? oc.id : null;
        const faceHref = (plane: string): string | null => { if (!imgEq) return null; const eqSide = (plane === "y0") ? (front ? "front" : "rear") : (front ? "rear" : "front"); return this.host.faceImageUrl?.(imgEq, eqSide) || null; };
        Box.faces(E, [{ o: 0.55 }, { o: 1 }, { o: 0.92, plane: "y0" }, { o: 0.78, plane: "y1" }, { o: 0.72 }, { o: 0.72 }]).forEach((f: any) => {
          const poly = Dom.svg("polygon", { class: cls, "fill-opacity": f.o, points: f.pts.map((p: any) => p.h + "," + p.v).join(" ") });
          if (occFill) (poly as any).style.fill = occFill;
          const tt = Dom.svg("title"); tt.textContent = title; poly.appendChild(tt);
          if (oc.kind === "eq") this.wireOccupant(poly, oc.id);
          eqNodes.push({ depth: BASE - seq, node: poly }); seq++;
          const href = f.plane ? faceHref(f.plane) : null;
          if (href) {
            const yf = (f.plane === "y0") ? y0 : y1;
            // face arrière (y1) vue de derrière → miroir horizontal (coïncide avec les ports mirrorés).
            const node = (f.plane === "y1")
              ? this.faceImageNode(toW(x1, yf, z1), toW(x0, yf, z1), toW(x1, yf, z0), href, proj)
              : this.faceImageNode(toW(x0, yf, z1), toW(x1, yf, z1), toW(x0, yf, z0), href, proj);
            eqNodes.push({ depth: BASE - seq, node }); seq++;
          }
        });
        // ports À PLAT sur la face (taille réelle du connecteur), colorés si câblés ; clic → câble.
        if (this.showPorts && !this._farCull && oc.kind === "eq") {
          this.store.portsOf(oc.id).forEach((p: any) => {
            if (p.face_x == null || p.face_y == null) return;
            const pt = this.resolver.resolvePort3D(p.id, r.datacenter_id); if (!pt) return;
            const cab = this.store.cableOnPort(p.id), col = cab ? this.cableColor(cab) : null;
            const csz = this.store.portConnectorSize(p);
            const node = this.portFlat({ x: pt.x, y: pt.y, z: pt.z }, r, { w: csz.w * this.markerScale, h: csz.h * this.markerScale }, !!cab, col, proj);
            this.wirePortNode(node, p, cab);   // survol (.hover) + clic (routage interactif ou édition de câble)
            eqNodes.push({ depth: BASE - seq, node }); seq++;
          });
        }
        // étiquette (nom + icône) À PLAT sur la face tournée vers la caméra
        if (this.showEqNames && oc.label) {
          const zc = (z0 + z1) / 2, fN = { x: so, y: -co }, epsL = Math.max(w, d) * 0.05 + 5;
          const cF = toW(0, y0, zc), cR = toW(0, y1, zc);
          const frontFaces = proj({ x: cF.x + fN.x * epsL, y: cF.y + fN.y * epsL, z: cF.z }).depth < proj(cF).depth;
          const ctr = frontFaces ? cF : cR;
          let wxs = co, wys = so; const pO = proj(ctr), pW = proj({ x: ctr.x + wxs * epsL, y: ctr.y + wys * epsL, z: ctr.z });
          if (pW.h < pO.h) { wxs = -wxs; wys = -wys; }   // évite le texte en miroir
          const fontMM = Math.max(16, Math.min(U_MM * 0.6 * oc.h, (x1 - x0) * 1.4 / Math.max(6, oc.label.length)));
          const icon = oc.kind === "eq" ? EquipmentTypes.icon((this.store.get("equipments", oc.id) || {}).type || "") : "";
          eqNodes.push({ depth: BASE - seq, node: this.flatLabel(ctr, wxs, wys, oc.label, fontMM, icon, proj) }); seq++;
        }
      } else if (unit.kind === "side" || unit.kind === "wall") {
        const e = unit.e, { front, x0, x1, y0, y1, z0, z1 } = unit;
        const cls = "dc-eq3d " + (front ? "front" : "rear") + " side" + (this.eqHit(e.id) ? " hit" : "") + (e.id === this.focusEqId ? " focus-pulse" : "");
        const E = [toW(x0, y0, z0), toW(x1, y0, z0), toW(x1, y1, z0), toW(x0, y1, z0), toW(x0, y0, z1), toW(x1, y0, z1), toW(x1, y1, z1), toW(x0, y1, z1)].map(proj);
        const title = (e.name || "(équipement)") + (unit.kind === "side" ? " · latéral" : " · paroi");
        const sideFill = this.eqFill(e.id);
        Box.faces(E, [{ o: 0.55 }, { o: 1 }, { o: 0.92 }, { o: 0.78 }, { o: 0.82 }, { o: 0.82 }]).forEach((f: any) => {
          const poly = Dom.svg("polygon", { class: cls, "fill-opacity": f.o, points: f.pts.map((p: any) => p.h + "," + p.v).join(" ") });
          if (sideFill) (poly as any).style.fill = sideFill;
          const tt = Dom.svg("title"); tt.textContent = title; poly.appendChild(tt);
          this.wireOccupant(poly, e.id);
          eqNodes.push({ depth: BASE - seq, node: poly }); seq++;
        });
        if (this.showEqNames && e.name) {
          const zc = (z0 + z1) / 2, ctr = toW((x0 + x1) / 2, (y0 + y1) / 2, zc);
          let wxs = co, wys = so; const pO = proj(ctr), pW = proj({ x: ctr.x + wxs * 30, y: ctr.y + wys * 30, z: ctr.z });
          if (pW.h < pO.h) { wxs = -wxs; wys = -wys; }
          const fontMM = Math.max(14, Math.min(U_MM * 0.6, (z1 - z0) * 1.2 / Math.max(4, e.name.length)));
          eqNodes.push({ depth: BASE - seq, node: this.flatLabel(ctr, wxs, wys, e.name, fontMM, EquipmentTypes.icon(e.type || ""), proj) }); seq++;
        }
      } else if (unit.kind === "sidefree") {   // emplacement LATÉRAL libre → monter équipement / pin
        const s = unit.s, { x0, x1, yPlane, z0, z1 } = unit;
        const E2 = [toW(x0, yPlane, z0), toW(x1, yPlane, z0), toW(x1, yPlane, z1), toW(x0, yPlane, z1)].map(proj);
        const poly = Dom.svg("polygon", { class: "dc-empty3d side", points: E2.map((p) => p.h + "," + p.v).join(" "), "data-rack": r.id });
        const tip = Dom.svg("title"); tip.textContent = "Emplacement latéral libre — marge " + (s.lr === "left" ? "gauche" : "droite") + " · U" + s.uTop + (r.sides === "dual" ? " · " + (s.face === "rear" ? "arrière" : "avant") : "") + " — clic : monter"; poly.appendChild(tip);
        this.wireClick(poly, () => this.host.assignSideSlot?.(r.id, s.face, s.lr, s.col, s.uTop, () => this.render()));
        eqNodes.push({ depth: BASE - seq, node: poly }); seq++;
      } else if (unit.kind === "wallfree") {   // emplacement MURAL libre → monter équipement en paroi
        const s = unit.s, { xPlane, y0, y1, z0, z1 } = unit;
        const E2 = [toW(xPlane, y0, z0), toW(xPlane, y1, z0), toW(xPlane, y1, z1), toW(xPlane, y0, z1)].map(proj);
        const poly = Dom.svg("polygon", { class: "dc-empty3d side", points: E2.map((p) => p.h + "," + p.v).join(" "), "data-rack": r.id });
        const tip = Dom.svg("title"); tip.textContent = "Emplacement mural libre — paroi " + (s.wall === "left" ? "gauche" : "droite") + " · marge " + (s.margin === "rear" ? "arrière" : "avant") + " · U" + s.uTop + " — clic : monter"; poly.appendChild(tip);
        this.wireClick(poly, () => this.host.assignWallSlot?.(r.id, s.wall, s.margin, s.col, s.uTop, () => this.render()));
        eqNodes.push({ depth: BASE - seq, node: poly }); seq++;
      } else if (unit.kind === "brush") {   // BROSSE : coque creuse (marge av→ar) + tunnel ajouré (faces triées)
        const wp = unit.wp, { x0, x1, y0, y1, z0, z1 } = unit;
        const pad = BRUSH_PADDING_MM, xc = (x0 + x1) / 2, zc = (z0 + z1) / 2, hwO = (x1 - x0) / 2;
        const uhw = Math.max(0, hwO - pad), uhh = Math.max(0, (z1 - z0) / 2 - pad);
        const ringL = (ly: number, half: number, zlo: number, zhi: number) => [toW(xc - half, ly, zlo), toW(xc + half, ly, zlo), toW(xc + half, ly, zhi), toW(xc - half, ly, zhi)].map(proj);
        const F = ringL(y0, hwO, z0, z1), Fi = ringL(y0, uhw, zc - uhh, zc + uhh);
        const B = ringL(y1, hwO, z0, z1), Bi = ringL(y1, uhw, zc - uhh, zc + uhh);
        const ringD = (P: Array<{ h: number; v: number }>) => "M" + P.map((p) => p.h + " " + p.v).join(" L") + " Z";
        const EDG = [[0, 1], [1, 2], [2, 3], [3, 0]];
        const cd = (pts: Array<{ depth: number }>) => pts.reduce((s, p) => s + p.depth, 0) / pts.length;
        const mkFace = (tag: string, props: Record<string, any>): SVGElement => { const n = Dom.svg(tag, Object.assign({ class: "dc-eq3d item", "data-wp": wp.id }, props)); this.wireWp(n, wp); return n; };
        if (this.showConduits) {   // COQUE de la brosse (passe-câble) — togglable
          const cqFaces: Array<{ node: SVGElement; d: number }> = [];
          cqFaces.push({ node: mkFace("path", { "fill-rule": "evenodd", d: ringD(F) + " " + ringD(Fi) }), d: cd(F) });
          cqFaces.push({ node: mkFace("path", { "fill-rule": "evenodd", d: ringD(B) + " " + ringD(Bi) }), d: cd(B) });
          EDG.forEach(([i, j]) => {
            const outer = [F[i], F[j], B[j], B[i]], inner = [Fi[i], Fi[j], Bi[j], Bi[i]];
            cqFaces.push({ node: mkFace("polygon", { points: outer.map((p) => p.h + "," + p.v).join(" ") }), d: cd(outer) });
            cqFaces.push({ node: mkFace("polygon", { points: inner.map((p) => p.h + "," + p.v).join(" ") }), d: cd(inner) });
          });
          cqFaces.sort((a, b) => b.d - a.d).forEach((f) => { eqNodes.push({ depth: BASE - seq, node: f.node }); seq++; });
          const eg = Dom.svg("g"); (eg as any).style.pointerEvents = "none";   // arêtes (fil de fer), non interactives
          const bedge = (a: { h: number; v: number }, b: { h: number; v: number }) => eg.appendChild(Dom.svg("line", { class: "dc-brush-edge", x1: a.h, y1: a.v, x2: b.h, y2: b.v }));
          EDG.forEach(([i, j]) => { bedge(F[i], F[j]); bedge(B[i], B[j]); bedge(Fi[i], Fi[j]); bedge(Bi[i], Bi[j]); });
          [0, 1, 2, 3].forEach((i) => { bedge(F[i], B[i]); bedge(Fi[i], Bi[i]); });
          eqNodes.push({ depth: BASE - seq, node: eg }); seq++;
        }
        if (this.showWaypoints) {   // MARQUEURS aux deux extrémités (avant/arrière) — losanges persistants, cliquables
          const mr = (DC_DOT_PX + 4) * this.markerScale / (this.scale || 1);
          [proj(toW(xc, y0, zc)), proj(toW(xc, y1, zc))].forEach((p) => {
            const dia = Dom.svg("polygon", { class: "dc-wp3d-body", points: `${p.h},${p.v - mr} ${p.h + mr},${p.v} ${p.h},${p.v + mr} ${p.h - mr},${p.v}`, "data-wp": wp.id });
            this.wireWp(dia, wp); eqNodes.push({ depth: BASE - seq, node: dia }); seq++;
          });
        }
      } else if (unit.kind === "capfree") {   // trou de capot libre (toit/sol) → poser un pin
        const s = unit.s, { x0, x1, y0, y1, zc } = unit;
        const E2 = [toW(x0, y0, zc), toW(x1, y0, zc), toW(x1, y1, zc), toW(x0, y1, zc)].map(proj);
        const poly = Dom.svg("polygon", { class: "dc-empty3d cap", points: E2.map((p) => p.h + "," + p.v).join(" "), "data-rack": r.id });
        const tip = Dom.svg("title"); tip.textContent = "Emplacement Waypoint libre (" + (s.face === "floor" ? "sol" : "toit") + ") — cellule (" + s.cx + ", " + s.cy + ") — clic : poser un pin"; poly.appendChild(tip);
        this.wireClick(poly, () => this.host.assignCapSlot?.(r.id, s.face, s.cx, s.cy, () => this.render()));
        eqNodes.push({ depth: BASE - seq, node: poly }); seq++;
      } else {   // ph : emplacement U libre (voile + bordure pointillée) → assigner un équipement (clic = 1 U, Ctrl+clic = plage)
        const { x0e, x1e, fyPlane, z0, z1, u, side } = unit;
        const E2 = [toW(x0e, fyPlane, z0), toW(x1e, fyPlane, z0), toW(x1e, fyPlane, z1), toW(x0e, fyPlane, z1)].map(proj);
        const sel = this.slotSel;
        const inSel = !!sel && sel.rackId === r.id && sel.side === side && u >= sel.lo && u <= sel.hi;
        const selN = inSel && sel ? (sel.hi - sel.lo + 1) : 0;
        const poly = Dom.svg("polygon", { class: "dc-empty3d" + (inSel ? " sel" : ""), points: E2.map((p) => p.h + "," + p.v).join(" "), "data-rack": r.id, "data-u": u, "data-side": side });
        const faceL = r.sides === "dual" ? " · " + (side === "rear" ? "arrière" : "avant") : "";
        const tip = Dom.svg("title");
        tip.textContent = inSel && sel
          ? "Sélection — " + selN + " U (U" + sel.lo + (sel.hi > sel.lo ? "–U" + sel.hi : "") + faceL + ") — clic : assigner · Ctrl+clic : ajuster"
          : "Emplacement libre — U" + u + faceL + " — clic : assigner · Ctrl+clic : sélection multiple";
        poly.appendChild(tip);
        this.wireClick(poly, (e) => {
          if (e.ctrlKey || e.metaKey) { this.toggleSlotSel(r.id, u, side); return; }   // (dé)sélection multiple
          const s = this.slotSel;
          if (s && s.rackId === r.id && s.side === side && u >= s.lo && u <= s.hi) {     // clic dans la sélection → assigner la plage
            const lo = s.lo, h = s.hi - s.lo + 1; this.slotSel = null; this.host.assignSlot?.(r.id, lo, side, h, () => this.render());
          } else {
            if (this.slotSel) this.slotSel = null;   // clic ailleurs → repart à zéro
            this.host.assignSlot?.(r.id, u, side, 1, () => this.render());
          }
        });
        eqNodes.push({ depth: BASE - seq, node: poly }); seq++;
      }
    });
    return eqNodes;
  }

  /** Tri PEINTRE topologique (Kahn) sur les paires qui se CHEVAUCHENT à l'écran ; cycle cassé par centroïde.
      `painterFarFirst` est correct PAR PAIRE (non transitif) → jamais un sort global. Modifie `units` en place. */

  protected painterTopoSort(units: any[], grad: [number, number, number], toW: (lx: number, ly: number, lz: number) => Vec3, proj: (p: Vec3) => { h: number; v: number; depth: number }): void {
    const nU = units.length; if (nU < 2) return;
    const cdU = (u: any) => (u.lo[0] + u.hi[0]) / 2 * grad[0] + (u.lo[1] + u.hi[1]) / 2 * grad[1] + (u.lo[2] + u.hi[2]) / 2 * grad[2];
    const bbU = units.map((u) => {
      let h0 = 1e18, h1 = -1e18, v0 = 1e18, v1 = -1e18;
      for (const X of [u.lo[0], u.hi[0]]) for (const Y of [u.lo[1], u.hi[1]]) for (const Z of [u.lo[2], u.hi[2]]) { const q = proj(toW(X, Y, Z)); if (q.h < h0) h0 = q.h; if (q.h > h1) h1 = q.h; if (q.v < v0) v0 = q.v; if (q.v > v1) v1 = q.v; }
      return [h0, h1, v0, v1];
    });
    const ovl = (a: number, b: number) => !(bbU[b][0] > bbU[a][1] || bbU[b][1] < bbU[a][0] || bbU[b][2] > bbU[a][3] || bbU[b][3] < bbU[a][2]);
    const preds: Array<Set<number>> = Array.from({ length: nU }, () => new Set<number>());
    for (let i = 0; i < nU; i++) for (let j = i + 1; j < nU; j++) { if (!ovl(i, j)) continue; const f = Painter.farFirst(units[i], units[j], grad); if (f < 0) preds[j].add(i); else if (f > 0) preds[i].add(j); }
    const cnt = preds.map((s) => s.size), rem = new Set(units.map((_, i) => i)), ord: any[] = [];
    while (rem.size) {
      let cands = [...rem].filter((i) => cnt[i] === 0); if (!cands.length) cands = [...rem];
      cands.sort((a, b) => cdU(units[b]) - cdU(units[a])); const pick = cands[0];
      ord.push(units[pick]); rem.delete(pick);
      for (const j of rem) if (preds[j].delete(pick)) cnt[j]--;
    }
    units.length = 0; for (const u of ord) units.push(u);
  }


  /** Boîte 3D d'un équipement en dimensionnement LIBRE posé dans la salle (6 faces + nom). */
  protected equipBox3D(e: any, proj: (p: Vec3) => { h: number; v: number; depth: number }): Drawable {
    const bx = FreeEquipGeometry.box(e);
    return this.freeEquipBoxAt(e, (e.dc_x != null) ? e.dc_x : bx.w / 2, (e.dc_y != null) ? e.dc_y : bx.d / 2, bx.z, proj);
  }

  /** Image de façade plaquée : unité 1×1 étirée sur 3 coins MONDE (TL, TR, BL) via une matrice affine. */
  protected faceImageNode(TL: Vec3, TR: Vec3, BL: Vec3, href: string, proj: (p: Vec3) => { h: number; v: number; depth: number }): SVGElement {
    const pTL = proj(TL), pTR = proj(TR), pBL = proj(BL);
    const a = pTR.h - pTL.h, b = pTR.v - pTL.v, c = pBL.h - pTL.h, d = pBL.v - pTL.v;
    const g = Dom.svg("g", { class: "dc-face-img", transform: `matrix(${a} ${b} ${c} ${d} ${pTL.h} ${pTL.v})` });
    const im = Dom.svg("image", { x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: "none" });
    im.setAttribute("href", href); im.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", href);
    g.appendChild(im); return g;
  }
  /** Boîte 3D d'un équipement libre à un centre (cx,cy) et une base Z donnés (réutilisée par la pose en
      salle ET sur un étage). `sel` ajoute la classe de sélection ; clic → fiche équipement. */

  protected freeEquipBoxAt(e: any, cx: number, cy: number, baseZ: number, proj: (p: Vec3) => { h: number; v: number; depth: number }, opts: { sel?: boolean } = {}): Drawable {
    const bx = FreeEquipGeometry.box(e), hw = bx.w / 2, hd = bx.d / 2, z0 = baseZ, z1 = baseZ + bx.h;
    const o = Normalize.rackOrientation(e.dc_orientation) * Math.PI / 180, co = Math.cos(o), so = Math.sin(o);
    const toW = (lx: number, ly: number, lz: number): Vec3 => ({ x: cx + lx * co - ly * so, y: cy + lx * so + ly * co, z: lz });
    const C = [toW(-hw, -hd, z0), toW(hw, -hd, z0), toW(hw, hd, z0), toW(-hw, hd, z0), toW(-hw, -hd, z1), toW(hw, -hd, z1), toW(hw, hd, z1), toW(-hw, hd, z1)].map(proj);
    const g = Dom.svg("g", { class: "dc-equip3d-group" + (opts.sel ? " sel" : "") });
    const title = (e.name || "(équipement)") + " · " + bx.w + "×" + bx.d + "×" + bx.h + " mm";
    const fill = this.eqFill(e.id);
    const showImg = this.showFaceImages;
    const faceCornerW = (face: string, fx: number, fy: number): Vec3 => { const l = FreeEquipGeometry.faceLocal(e, face, fx, fy, z0); return toW(l.lx, l.ly, l.lz); };
    // 6 faces dans l'ordre canonique de Box.faces (bottom/top/front/rear/left/right)
    Box.faces(C, [{ o: 0.55, plane: "bottom" }, { o: 1, plane: "top" }, { o: 0.92, plane: "front" }, { o: 0.78, plane: "rear" }, { o: 0.72, plane: "left" }, { o: 0.72, plane: "right" }]).forEach((f: any) => {
      const poly = Dom.svg("polygon", { class: "dc-eq3d front" + (this.eqHit(e.id) ? " hit" : ""), "fill-opacity": f.o, points: f.pts.map((p: any) => p.h + "," + p.v).join(" ") });
      if (fill) (poly as any).style.fill = fill;
      const tt = Dom.svg("title"); tt.textContent = title; poly.appendChild(tt);
      this.wireOccupant(poly, e.id);
      g.appendChild(poly);   // déjà triées loin→proche par Box.faces
      const href = showImg ? (this.host.faceImageUrl?.(e.id, f.plane) || null) : null;   // image plaquée (6 faces : front/rear + annexes « autre »)
      if (href) g.appendChild(this.faceImageNode(faceCornerW(f.plane, 0, 0), faceCornerW(f.plane, 1, 0), faceCornerW(f.plane, 0, 1), href, proj));
    });
    return { depth: proj(toW(0, 0, (z0 + z1) / 2)).depth, node: g };
  }

  /* ---- câbles (intra-salle) & waypoints ---- */

  /** Câbles dont LES DEUX bouts sont résolus dans `dcId` : endpoints + points de passage (offsets conduit). */
  /** Construit le tracé d'un câble depuis ses bouts (`a`/`b`, avec `.n` éventuel) et ses points de passage `viaW`
      (portant leur waypoint source). Renvoie :
      - `pts` : points ORIGINAUX [a, …via, b] → pastilles/extrémités (JAMAIS sur une amorce de stub) ;
      - `linePts` : points du TRACÉ (avec amorces ⊥) ;
      - `straight` : indices de segments tracés DROITS (corps de conduit + amorces ⊥) ;
      - `stubAt` : indices des points d'AMORCE → tangente G1 imposée (= sens de leur segment droit adjacent).
      Règles : corps de conduit (2 points consécutifs du même segment/brush) TOUJOURS droit ; si `cablePortNormal`,
      amorce ⊥ de 20 mm à chaque PORT (le long de `.n`) ET à chaque entrée/sortie de conduit (le long de l'axe),
      bornée à 45 % de la distance au voisin. MÉCANIQUE UNIQUE ports + conduits (même code, continuité G1). */

  protected cableLine(a: any, b: any, viaW: Array<{ wp?: any; p: Vec3 }>): { pts: Vec3[]; linePts: Vec3[]; straight: Set<number>; stubAt: Set<number> } {
    const on = this.cablePortNormal, STUB = CABLE_PORT_STUB_MM;
    const dist = (p: Vec3, q: Vec3) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    const pts: Vec3[] = [a as Vec3].concat(viaW.map((v) => v.p), [b as Vec3]);   // points ORIGINAUX (pastilles)
    const linePts: Vec3[] = []; const straight = new Set<number>(); const stubAt = new Set<number>();
    const push = (p: Vec3, straightSeg: boolean, isStub: boolean) => { if (straightSeg && linePts.length) straight.add(linePts.length - 1); if (isStub) stubAt.add(linePts.length); linePts.push(p); };
    // amorce de 20 mm le long de la direction `dir` (normale de port OU axe de conduit), bornée à 45 % de la distance à `toward`
    const stubAlong = (pt: Vec3, dir: any, toward: Vec3 | null): Vec3 | null => {
      if (!on || !pt || !dir || !toward) return null;
      const u = Math.hypot(dir.x, dir.y, dir.z) || 1, L = Math.min(STUB, dist(pt, toward) * 0.45); if (L < 0.5) return null;
      return { x: pt.x + dir.x / u * L, y: pt.y + dir.y / u * L, z: pt.z + dir.z / u * L };
    };
    const sa = stubAlong(a, a && a.n, viaW.length ? viaW[0].p : b), sb = stubAlong(b, b && b.n, viaW.length ? viaW[viaW.length - 1].p : a);
    push(a, false, false);
    if (sa) push(sa, true, true);   // a→sa DROIT ; sa = amorce (G1, tangente = normale du port)
    let i = 0;
    while (i < viaW.length) {
      const w = viaW[i].wp;
      const isConduit = i + 1 < viaW.length && w && viaW[i + 1].wp && viaW[i + 1].wp.id === w.id && (w.kind === "segment" || w.kind === "brush");
      if (isConduit) {
        const e0 = viaW[i].p, e1 = viaW[i + 1].p;
        const pred = linePts[linePts.length - 1], succ = (i + 2 < viaW.length) ? viaW[i + 2].p : b;
        const sIn = stubAlong(e0, { x: e0.x - e1.x, y: e0.y - e1.y, z: e0.z - e1.z }, pred);    // amorce d'entrée (axe sortant à e0)
        if (sIn) push(sIn, false, true);   // pred→amorce = COURBE ; amorce = G1 (tangente = axe du conduit)
        push(e0, !!sIn, false);            // amorce→e0 DROIT (sinon entrée libre)
        push(e1, true, false);             // corps de conduit DROIT (toujours)
        const sOut = stubAlong(e1, { x: e1.x - e0.x, y: e1.y - e0.y, z: e1.z - e0.z }, succ);   // amorce de sortie (axe sortant à e1)
        if (sOut) push(sOut, true, true);  // e1→amorce DROIT ; amorce = G1 → la COURBE suivante part dans l'axe
        i += 2;
      } else { push(viaW[i].p, false, false); i += 1; }
    }
    if (sb) { push(sb, false, true); push(b, true, false); }   // courbe→sb (G1) ; sb→b DROIT
    else push(b, false, false);
    return { pts, linePts, straight, stubAt };
  }
  /** Normale d'un bout résolu (repère LOCAL salle) tournée dans le repère MONDE de sa salle.
      W est affine → R·n = W(p+n) − W(p). Renvoie null si le bout n'a pas de normale. */

  protected worldEndNormal(room: RoomPlacement, res: any): Vec3 | null {
    if (!res || !res.n) return null;
    const w0 = FloorLayout.roomToWorld(room, res as Vec3);
    const w1 = FloorLayout.roomToWorld(room, { x: res.x + res.n.x, y: res.y + res.n.y, z: res.z + res.n.z });
    return { x: w1.x - w0.x, y: w1.y - w0.y, z: w1.z - w0.z };
  }

  protected resolvedCables(dcId: string): Array<{ cable: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
    const out: Array<{ cable: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> = [];
    this.store.all("cables").forEach((c: any) => {
      const a = this.resolver.resolvePort3D(c.from_port_id, dcId), b = this.resolver.resolvePort3D(c.to_port_id, dcId);
      if (!a || !b) return;   // intra-salle : les deux bouts ici
      const wps = this.store.cableWaypointsIn(c, dcId);
      const anchors = wps.map((w: any) => this.resolver.waypointAnchor(w));
      const viaW: Array<{ wp: any; p: Vec3 }> = [];
      wps.forEach((w: any, i: number) => {
        const prev = i === 0 ? a : anchors[i - 1], next = i === wps.length - 1 ? b : anchors[i + 1];
        const off = this.resolver.conduitOffsetFor(w, c.id, prev, next);   // répartition dans la section du conduit
        this.resolver.waypointPassPoints(w, prev, next, off).forEach((p: Vec3) => viaW.push({ wp: w, p }));
      });
      const sp = this.cableLine(a, b, viaW);
      out.push({ cable: c, pts: sp.pts, linePts: sp.linePts, straight: sp.straight, stubAt: sp.stubAt });
    });
    return out;
  }

  /** Câbles dont UN SEUL bout est résolu dans `dcId` et qui sortent par un exit : tracés du port LOCAL
      jusqu'à l'exit de CETTE salle (le câble « s'arrête au mur »). Vue MONO-salle (3D + Dessus). pts en monde.
      → { cable, portId, port, portRackId, pts } (pts dans l'ordre du tracé). */

  outgoingCableStubs(dcId: string): Array<{ cable: any; portId: string; port: Vec3; portRackId: string | null; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
    const out: Array<{ cable: any; portId: string; port: Vec3; portRackId: string | null; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> = [];
    this.store.all("cables").forEach((c: any) => {
      const a = this.resolver.resolvePort3D(c.from_port_id, dcId), b = this.resolver.resolvePort3D(c.to_port_id, dcId);
      if ((a && b) || (!a && !b)) return;   // exactement UN bout dans cette salle
      const r = this.store.cableRoute(c);
      if (!r.valid || !r.hasExits) return;   // câble réellement routé hors de la salle
      const portAtStart = !!a;               // from_port (A) ici → route vers l'avant
      const portRes = (a || b) as Vec3, portId = portAtStart ? c.from_port_id : c.to_port_id;
      // waypoints de CETTE salle adjacents au port local, jusqu'à l'exit de sortie INCLUS
      const inRoom: any[] = [];
      if (portAtStart) {
        for (const s of r.steps) {
          if (s.type === "floor" || s.wp.datacenter_id !== dcId) break;
          inRoom.push(s.wp);
          if (s.type === "exit") break;   // exit de sortie atteint → on s'arrête au mur
        }
      } else {
        for (let i = r.steps.length - 1; i >= 0; i--) {
          const s = r.steps[i];
          if (s.type === "floor" || s.wp.datacenter_id !== dcId) break;
          inRoom.unshift(s.wp);
          if (s.type === "exit") break;   // exit d'entrée → mur
        }
      }
      if (!inRoom.length || Waypoint.typeOf(inRoom[portAtStart ? inRoom.length - 1 : 0]) !== "exit") return;   // pas d'exit trouvé
      const anchors = inRoom.map((w) => this.resolver.waypointAnchor(w));
      const viaW: Array<{ wp: any; p: Vec3 }> = [];
      inRoom.forEach((w, i) => {
        const prev = (i === 0) ? (portAtStart ? portRes : anchors[i]) : anchors[i - 1];
        const next = (i === inRoom.length - 1) ? (portAtStart ? anchors[i] : portRes) : anchors[i + 1];
        const off = this.resolver.conduitOffsetFor(w, c.id, prev, next);   // répartition dans la section du conduit
        this.resolver.waypointPassPoints(w, prev, next, off).forEach((p: Vec3) => viaW.push({ wp: w, p }));
      });
      // seul le bout PORT reçoit l'amorce ⊥ ; l'extrémité exit/mur (sans normale) sert de bout `a`/`b` sans amorce.
      const sp = !viaW.length ? { pts: [portRes as Vec3], linePts: [portRes as Vec3], straight: new Set<number>(), stubAt: new Set<number>() }
        : portAtStart ? this.cableLine(portRes, viaW[viaW.length - 1].p, viaW.slice(0, -1))
        : this.cableLine(viaW[0].p, portRes, viaW.slice(1));
      out.push({ cable: c, portId, port: portRes, portRackId: (portRes as any).rackId ?? null, pts: sp.pts, linePts: sp.linePts, straight: sp.straight, stubAt: sp.stubAt });
    });
    return out;
  }

  /** Couleur d'un câble = celle de son réseau PRINCIPAL (null sinon). */
  protected cableColor(c: any): string | null { const n: any = c && c.network_id ? this.store.get("networks", c.network_id) : null; return (n && n.color) ? n.color : null; }


  /* ---- recherche / focus / visibilité câbles ---- */
  protected matchSearch(text: any): boolean { const q = this.searchTerm.trim(); return !!q && Text.normSearch(text).includes(Text.normSearch(q)); }

  protected eqHit(eqId: string): boolean { if (eqId === this.focusEqId) return true; const e: any = this.store.get("equipments", eqId); return !!e && (this.matchSearch(e.name) || this.matchSearch(EquipmentTypes.label(e.type))); }

  protected cableHit(c: any): boolean { return this.matchSearch(c.name); }

  /** Couleur de remplissage d'un équipement selon le mode (face = défaut CSS · groupe · type). */
  protected eqFill(eqId: string): string | null {
    if (this.colorMode === "face") return null;
    const e: any = this.store.get("equipments", eqId); if (!e) return null;
    if (this.colorMode === "group") { const g: any = e.group_id ? this.store.get("groups", e.group_id) : null; return (g && g.color) ? g.color : null; }
    return EquipmentTypes.color(e.type) || null;
  }

  protected cableShown(rc: { cable: any }): boolean { return this.showAllCables || this.selCables.has(rc.cable.id); }

  /** Centre monde (mm) d'un équipement de la salle `dcId`, ou null. */
  protected equipCenter(e: any, dcId: string): Vec3 | null {
    if (e.dim_mode === "free") { if (e.dc_id !== dcId || e.dc_x == null || e.dc_y == null) return null; const b = FreeEquipGeometry.box(e); return { x: e.dc_x, y: e.dc_y, z: b.z + b.h / 2 }; }
    if (e.placement_mode === "rack" && e.rack_id && e.rack_u != null) {
      const rk: any = this.store.get("racks", e.rack_id); if (!rk || rk.datacenter_id !== dcId) return null;
      const cx = (rk.dc_x != null) ? rk.dc_x : 0, cy = (rk.dc_y != null) ? rk.dc_y : 0;
      return { x: cx, y: cy, z: RackGeometry.uBaseZ(rk) + ((e.rack_u - 1) + Math.max(1, e.u_height | 0 || 1) / 2) * U_MM };
    }
    if ((e.placement_mode === "side" || e.placement_mode === "wall") && e.rack_id) {
      const rk: any = this.store.get("racks", e.rack_id); if (!rk || rk.datacenter_id !== dcId) return null;
      return { x: (rk.dc_x != null) ? rk.dc_x : 0, y: (rk.dc_y != null) ? rk.dc_y : 0, z: RackGeometry.physHeight(rk) / 2 };
    }
    return null;
  }

  /** Cible un équipement : surlignage (focus-pulse) + caméra recentrée dessus (3D) + rendu. */
  protected focusEquipment(eqId: string): void {
    const dc = this.current(); if (!dc) return;
    const e: any = this.store.get("equipments", eqId); if (!e) return;
    this.focusEqId = eqId; this.selRackId = e.rack_id || null;
    const ctr = this.equipCenter(e, dc.id);
    if (ctr && this.view === "3d") { this.camTarget = ctr; if (this.scale == null) this.scale = null; }
    this.render();
  }
  /** Spline Catmull-Rom (tension CABLE_SPLINE_K) sur des points écran ; droite si 2 points. `straight` = indices de
      segments à tracer DROITS (corps de conduit) au lieu d'une courbe. */

  protected splinePath(pts: Array<{ h: number; v: number }>, straight?: Set<number>): string {
    if (!pts || pts.length < 2) return "";
    const M = "M" + pts[0].h + "," + pts[0].v;
    if (pts.length === 2) return M + " L" + pts[1].h + "," + pts[1].v;
    const k = this.cableSplineK, seg: string[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i], p2 = pts[i + 1];
      if (straight && straight.has(i)) { seg.push("L" + p2.h + "," + p2.v); continue; }   // corps de conduit droit
      const p0 = pts[Math.max(0, i - 1)], p3 = pts[Math.min(pts.length - 1, i + 2)];
      seg.push("C" + (p1.h + (p2.h - p0.h) * k) + "," + (p1.v + (p2.v - p0.v) * k) + " " + (p2.h - (p3.h - p1.h) * k) + "," + (p2.v - (p3.v - p1.v) * k) + " " + p2.h + "," + p2.v);
    }
    return M + " " + seg.join(" ");
  }
  /** Tracé d'un câble (mécanique UNIQUE ports + conduits) : segments de `straight` tracés DROITS (`L`) ; aux points
      d'`stubAt` (amorces ⊥), la courbe adjacente reçoit une TANGENTE IMPOSÉE = sens de leur segment droit (continuité
      G1 : la courbe part/arrive dans l'axe puis s'incurve, aucun « kink » → la sortie reste perpendiculaire). Les
      autres points : Catmull-Rom (arrondi `cableSplineK`). `stubAt`/`straight` indexent `P`. */

  protected cablePath(P: Array<{ h: number; v: number }>, straight?: Set<number>, stubAt?: Set<number>): string {
    if (!P || P.length < 2) return "";
    const M = "M" + P[0].h + "," + P[0].v;
    if (P.length === 2) return M + " L" + P[1].h + "," + P[1].v;
    const n = P.length, k = this.cableSplineK, hk = k * 2.5;
    const dist = (p: any, q: any) => Math.hypot(q.h - p.h, q.v - p.v);
    const unit = (p: any, q: any) => { const dh = q.h - p.h, dv = q.v - p.v, L = Math.hypot(dh, dv) || 1; return { h: dh / L, v: dv / L }; };
    // tangente imposée à un point d'amorce = sens de SON segment droit adjacent (G1 avec le segment droit)
    const stubDir = (i: number): { h: number; v: number } | null => {
      if (!stubAt || !stubAt.has(i)) return null;
      if (straight && straight.has(i)) return unit(P[i], P[i + 1]);          // segment droit APRÈS i
      if (i > 0 && straight && straight.has(i - 1)) return unit(P[i - 1], P[i]); // segment droit AVANT i
      return null;
    };
    const tanAt = (i: number, segLen: number): { h: number; v: number } => {
      const d = stubDir(i);
      if (d) return { h: d.h * segLen * hk, v: d.v * segLen * hk };   // amorce : tangente alignée sur l'axe
      const p0 = P[Math.max(0, i - 1)], p1 = P[Math.min(n - 1, i + 1)];
      return { h: (p1.h - p0.h) * k, v: (p1.v - p0.v) * k };          // intérieur : Catmull-Rom
    };
    let d = M;
    for (let i = 0; i < n - 1; i++) {
      if (straight && straight.has(i)) { d += " L" + P[i + 1].h + "," + P[i + 1].v; continue; }   // segment droit
      const segLen = dist(P[i], P[i + 1]), m0 = tanAt(i, segLen), m1 = tanAt(i + 1, segLen);
      d += " C" + (P[i].h + m0.h) + "," + (P[i].v + m0.v) + " " + (P[i + 1].h - m1.h) + "," + (P[i + 1].v - m1.v) + " " + P[i + 1].h + "," + P[i + 1].v;
    }
    return d;
  }

  protected emitCable3D(rc: { cable: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[]): void {
    const PL = rc.linePts.map(proj);   // points du TRACÉ (avec amorces)
    const col = this.cableColor(rc.cable);
    const depth = PL.reduce((s, p) => s + p.depth, 0) / PL.length - 1e4;   // les câbles passent AU-DESSUS des équipements
    const g = Dom.svg("g", { class: "dc-cable-g" });
    const d = this.cablePath(PL, rc.straight, rc.stubAt);
    const line = Dom.svg("path", { class: "dc-cable status-" + (rc.cable.status || "cable") + (this.cableHit(rc.cable) ? " hit" : "") + (this.selCables.has(rc.cable.id) ? " sel" : ""), d, "data-cable": rc.cable.id }); if (col) (line as any).style.stroke = col;
    const hit = Dom.svg("path", { class: "dc-cable-hit", d, "data-cable": rc.cable.id });
    this.wireTip(hit, () => this.cableTipHtml(rc.cable));
    this.wireClick(hit, () => { this.hideTip(); this.host.openCableForm?.(rc.cable.id); }); hit.addEventListener("contextmenu", (e: any) => { this.hideTip(); this.ctxMenu(e, this.cableCtx(rc.cable)); });
    g.append(line, hit);
    drawables.push({ depth, node: g });
    if (this.cableIsPower(rc.cable) && this.showPowerBolts()) this.powerBoltsAlong(rc.linePts, proj, drawables);
    const rDot = DC_DOT_PX * this.markerScale / (this.scale || 1);
    // pastille UNIQUEMENT aux EXTRÉMITÉS (port d'équipement / patch) — pas sur les waypoints intermédiaires
    // (brosse, chemin de câbles) qui portent déjà leur propre marqueur.
    const ends = (rc.pts.length > 1) ? [rc.pts[0], rc.pts[rc.pts.length - 1]] : rc.pts;
    ends.map(proj).forEach((p) => { const dot = Dom.svg("circle", { class: "dc-cable-end", cx: p.h, cy: p.v, r: rDot }); if (col) (dot as any).style.fill = col; drawables.push({ depth: p.depth - 1e4 - 1, node: dot }); });
  }

  /** Câble d'alimentation (type de câble de genre « power »). */
  protected cableIsPower(c: any): boolean { const t: any = c && c.cable_type_id ? this.store.get("cableTypes", c.cable_type_id) : null; return !!(t && t.kind === "power"); }

  /** Éclairs visibles seulement DE PRÈS (≤ 50 % du seuil de culling) pour ne pas surcharger la vue d'ensemble. */
  protected showPowerBolts(): boolean { return this.cullDistanceM > 0 && this.camViewWidthM(this.current()) <= this.cullDistanceM * 0.5; }

  /** Répartit des éclairs le long d'un chemin MONDE, billboardés (taille écran ~constante), au-dessus du câble. */
  protected powerBoltsAlong(worldPts: Vec3[], proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[]): void {
    if (!worldPts || worldPts.length < 2) return;
    const spacing = Math.max(50, this.powerBoltSpacingMm || 300);
    let dist = spacing * 0.5;
    for (let i = 0; i < worldPts.length - 1; i++) {
      const a = worldPts[i], b = worldPts[i + 1], dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, seg = Math.hypot(dx, dy, dz);
      if (seg < 1e-6) continue;
      while (dist <= seg) { const t = dist / seg, p = proj({ x: a.x + dx * t, y: a.y + dy * t, z: a.z + dz * t }); drawables.push({ depth: p.depth - 2e4, node: this.powerBoltNode(p) }); dist += spacing; }
      dist -= seg;
    }
  }

  /** Glyphe éclair billboardé au point écran p (taille écran ~constante). */
  protected powerBoltNode(p: { h: number; v: number }): SVGElement {
    const s = (15 / (this.scale || 1)) / 24;
    const g = Dom.svg("g", { class: "dc-power-bolt", transform: `translate(${p.h},${p.v}) scale(${s}) translate(-12,-12)` });
    g.appendChild(Dom.svg("path", { d: "M13 1 L4 14 L11 14 L9 23 L20 9 L13 9 Z" }));
    return g;
  }

  /** Waypoint 3D : rail (segment) ou pin (point libre), au-dessus des câbles. */
  protected waypoint3D(wp: any, proj: (p: Vec3) => { h: number; v: number; depth: number }): Drawable {
    const g = Dom.svg("g", { class: "dc-wp3d wp-" + Waypoint.typeOf(wp) });
    const z = wp.dc_z || 0; const r = (DC_DOT_PX + 4) * this.markerScale / (this.scale || 1);
    let depth: number;
    if (wp.kind === "segment" && wp.dc_x2 != null) {
      const p1 = proj({ x: wp.dc_x, y: wp.dc_y, z }), p2 = proj({ x: wp.dc_x2, y: wp.dc_y2, z });
      const W = (wp.width_mm > 0) ? wp.width_mm : 0, H = (wp.height_mm > 0) ? wp.height_mm : 0;
      if (this.showConduits) {   // GÉOMÉTRIE du passe-câble (bac / rail) — togglable
        if (W > 1 && H > 1) {
          // BAC 3D (chemin de câbles « STP ») : section W×H centrée sur le rail, le long de l'axe e0→e1.
          const ax = wp.dc_x2 - wp.dc_x, ay = wp.dc_y2 - wp.dc_y, L = Math.hypot(ax, ay) || 1;
          const rx = ay / L, ry = -ax / L, hw2 = W / 2, hh2 = H / 2;   // right horizontal ⊥ + demi-dims
          const e0 = { x: wp.dc_x, y: wp.dc_y }, e1 = { x: wp.dc_x2, y: wp.dc_y2 };
          const cn = (e: { x: number; y: number }, sx: number, sz: number) => proj({ x: e.x + rx * sx * hw2, y: e.y + ry * sx * hw2, z: z + sz * hh2 });
          const A = [cn(e0, -1, -1), cn(e0, 1, -1), cn(e0, 1, 1), cn(e0, -1, 1)];   // section au bout 0
          const Bb = [cn(e1, -1, -1), cn(e1, 1, -1), cn(e1, 1, 1), cn(e1, -1, 1)];  // section au bout 1
          const poly = (P: Array<{ h: number; v: number }>) => Dom.svg("polygon", { class: "dc-tray-face", points: P.map((p) => p.h + "," + p.v).join(" ") });
          g.appendChild(poly(A)); g.appendChild(poly(Bb));   // bouchons translucides (câbles visibles au travers)
          const edge = (a: { h: number; v: number }, b: { h: number; v: number }) => g.appendChild(Dom.svg("line", { class: "dc-tray-edge", x1: a.h, y1: a.v, x2: b.h, y2: b.v }));
          [0, 1, 2, 3].forEach((i) => edge(A[i], Bb[i]));   // 4 longerons
          ([[0, 1], [1, 2], [2, 3], [3, 0]] as Array<[number, number]>).forEach(([i, j]) => { edge(A[i], A[j]); edge(Bb[i], Bb[j]); });   // contours de section
          [e0, e1].forEach((e) => { const b = proj({ x: e.x, y: e.y, z: z - hh2 }), f = proj({ x: e.x, y: e.y, z: 0 }); g.appendChild(Dom.svg("line", { class: "dc-wp-mast", x1: f.h, y1: f.v, x2: b.h, y2: b.v })); });   // mâts au sol
          const hit = Dom.svg("line", { class: "dc-wp-hit-line", x1: p1.h, y1: p1.v, x2: p2.h, y2: p2.v, "data-wp": wp.id });
          this.wireWp(hit, wp); g.appendChild(hit);
        } else {   // section nulle → ancien rail simple
          const f1 = proj({ x: wp.dc_x, y: wp.dc_y, z: 0 }), f2 = proj({ x: wp.dc_x2, y: wp.dc_y2, z: 0 });
          g.appendChild(Dom.svg("line", { class: "dc-wp-mast", x1: f1.h, y1: f1.v, x2: p1.h, y2: p1.v }));
          g.appendChild(Dom.svg("line", { class: "dc-wp-mast", x1: f2.h, y1: f2.v, x2: p2.h, y2: p2.v }));
          const rail = Dom.svg("line", { class: "dc-wp3d-rail", x1: p1.h, y1: p1.v, x2: p2.h, y2: p2.v, "data-wp": wp.id });
          const hit = Dom.svg("line", { class: "dc-wp-hit-line", x1: p1.h, y1: p1.v, x2: p2.h, y2: p2.v, "data-wp": wp.id });
          this.wireWp(rail, wp); this.wireWp(hit, wp);
          g.appendChild(rail); g.appendChild(hit);
        }
      }
      if (this.showWaypoints) {   // MARQUEURS aux DEUX EXTRÉMITÉS (losanges persistants, cliquables) + ◆ central (accroche au survol)
        [p1, p2].forEach((p) => {
          const dia = Dom.svg("polygon", { class: "dc-wp3d-body", points: `${p.h},${p.v - r} ${p.h + r},${p.v} ${p.h},${p.v + r} ${p.h - r},${p.v}`, "data-wp": wp.id });
          this.wireWp(dia, wp); g.appendChild(dia);
        });
        const mh = (p1.h + p2.h) / 2, mv = (p1.v + p2.v) / 2, ai = (DC_DOT_PX + 4) * this.markerScale / (this.scale || 1);
        g.appendChild(Dom.svg("polygon", { class: "dc-wp-attach", points: `${mh},${mv - ai} ${mh + ai},${mv} ${mh},${mv + ai} ${mh - ai},${mv}` }));
      }
      depth = (p1.depth + p2.depth) / 2 - 2e4;
    } else {
      // pin : utiliser l'ancre RÉSOLUE (pin monté latéral `side_lr` / capot `cap_face` → repère de la baie),
      // pas le point brut dc_x/dc_y — sinon décalage vs le tracé du câble (qui passe, lui, par l'ancre).
      const a = this.resolver.waypointAnchor(wp);
      const p = proj({ x: a.x, y: a.y, z: a.z }), f = proj({ x: a.x, y: a.y, z: 0 });
      g.appendChild(Dom.svg("line", { class: "dc-wp-mast", x1: f.h, y1: f.v, x2: p.h, y2: p.v }));
      const dia = Dom.svg("polygon", { class: "dc-wp3d-body", points: `${p.h},${p.v - r} ${p.h + r},${p.v} ${p.h},${p.v + r} ${p.h - r},${p.v}`, "data-wp": wp.id });
      this.wireWp(dia, wp);
      g.appendChild(dia);
      depth = p.depth - 2e4;
    }
    const tt = Dom.svg("title"); tt.textContent = (wp.name || "(waypoint)"); g.appendChild(tt);
    return { depth, node: g };
  }

}
