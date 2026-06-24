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
import { DcBase } from "./DcBase";

export class DcCamera extends DcBase {

  /** Overlay de contrôles SUPERPOSÉ au stage (zoom · recentrage · points de vue caméra). Réplique de la source. */
  protected buildControls(): void {
    const c = document.createElement("div"); c.className = "graph-zoom-controls"; this.controlsEl = c;
    c.innerHTML = `
      <button class="btn btn-ghost btn-sm" data-act="in" title="Zoom avant" aria-label="Zoom avant">+</button>
      <button class="btn btn-ghost btn-sm" data-act="out" title="Zoom arrière" aria-label="Zoom arrière">−</button>
      <span class="gz-sep"></span>
      <button class="btn btn-ghost btn-sm" data-act="recenter" title="Recentrer / ajuster la vue" aria-label="Recentrer la vue">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><line x1="12" y1="1.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22.5" y2="12"/></svg>
      </button>
      <div class="dc-cam-presets" data-cam-presets title="Point de vue">
        <button class="btn btn-ghost btn-sm" data-preset="top" title="Vue de dessus">Dessus</button>
        <button class="btn btn-ghost btn-sm" data-preset="front" title="Vue de face">Face</button>
        <button class="btn btn-ghost btn-sm" data-preset="back" title="Vue de l'arrière">Arrière</button>
        <button class="btn btn-ghost btn-sm" data-preset="side" title="Vue de côté">Côté</button>
        <button class="btn btn-ghost btn-sm" data-preset="iso" title="Vue 3D isométrique">3D</button>
      </div>
      <button class="btn btn-ghost btn-sm" data-act="fs" title="Plein écran" aria-label="Plein écran">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/></svg>
      </button>
      <span class="gz-sep"></span>
      <button class="btn btn-ghost btn-sm graph-icon-btn" data-act="eimg" title="Exporter une image (SVG / JPEG)…" aria-label="Exporter une image">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
      </button>`;
    c.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button"); if (!b) return;
      const preset = (b as HTMLElement).dataset.preset; if (preset) { this.setCamPreset(preset); return; }
      const a = (b as HTMLElement).dataset.act;
      if (a === "in") this.zoomBy(1.2);
      else if (a === "out") this.zoomBy(1 / 1.2);
      else if (a === "recenter") { this.camTarget = null; this.scale = null; this.render(); }
      else if (a === "fs") this.toggleFullscreen();
      else if (a === "eimg") this.openExportDialog();
    });
    this.stage.appendChild(c);
  }
  /** Plein écran (Fullscreen API natif) sur la rangée stage|panneau. Les overlays flottants (modale,
      dialogues, toasts, menus) sont re-parentés dans l'élément plein écran par `ui/Fullscreen`. */

  toggleFullscreen(): void {
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    const el: any = this.rowEl || this.stage;
    if (el.requestFullscreen) el.requestFullscreen().catch(() => Notify.toast("Plein écran indisponible", "err"));
    else Notify.toast("Plein écran non supporté par le navigateur", "err");
  }

  /* ---- export SVG (fidèle) / JPEG (rasterisé) de la vue affichée ---- */
  protected exportName(ext: string): string { return ImageExport.fileBase(this.store.meta.docName || "", "datacenter") + "-datacenter-" + new Date().toISOString().slice(0, 10) + "." + ext; }

  /** SVG autonome fidèle (styles calculés inlinés) cadré sur la VUE actuelle (viewport du stage). */
  protected buildExportSvg(): { svg: string; w: number; h: number } {
    const W = Math.max(50, this.stage.clientWidth || 900), H = Math.max(50, this.stage.clientHeight || 560);
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-2").trim() || "#111";
    const clone = this.svg!.cloneNode(true) as SVGSVGElement;
    ImageExport.inlineComputedStyles(this.svg!, clone);
    clone.setAttribute("width", String(W)); clone.setAttribute("height", String(H));
    clone.setAttribute("viewBox", "0 0 " + W + " " + H); clone.setAttribute("xmlns", Dom.SVGNS);
    clone.insertBefore(Dom.svg("rect", { x: 0, y: 0, width: W, height: H, fill: bg }), clone.firstChild);
    return { svg: '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone), w: W, h: H };
  }

  async openExportDialog(): Promise<void> {
    if (!this.svg) { Notify.toast("Rien à exporter", "err"); return; }
    const res = await ImageExport.dialog(false);   // vue actuelle (la projection 3D n'a pas de « tout le contenu » trivial)
    if (res) this.exportImage(res);
  }

  exportImage(opts: ExportOptions): void {
    if (!this.svg) { Notify.toast("Rien à exporter", "err"); return; }
    const built = this.buildExportSvg();
    ImageExport.run(opts, built.svg, built.w, built.h, (ext) => this.exportName(ext));
  }

  /** Points de vue caméra visibles en vue 3D seulement (zoom/recentrage : toutes vues). */
  protected updateControls(): void {
    if (!this.controlsEl) return;
    const presets = this.controlsEl.querySelector("[data-cam-presets]") as HTMLElement | null;
    if (presets) presets.style.display = this.view === "3d" ? "flex" : "none";
  }


  /* ---- caméra orbitale (azimut autour de Z, puis élévation) ---- */
  protected camCenter(dc: any): Vec3 {
    if (!this.camTarget) {
      this.camTarget = this._multi
        ? { x: this._multi.totalW / 2, y: this._multi.maxD / 2, z: this._multi.topZ / 2 }   // centre de l'ensemble multi-salles
        : (dc ? { x: dc.width_mm / 2, y: dc.depth_mm / 2, z: this.zRef(dc) / 2 } : { x: 0, y: 0, z: 0 });
    }
    return this.camTarget;
  }

  protected camAxes(): { right: Vec3; up: Vec3 } {
    const ca = Math.cos(this.az), sa = Math.sin(this.az), ce = Math.cos(this.el), se = Math.sin(this.el);
    return { right: { x: ca, y: -sa, z: 0 }, up: { x: sa * se, y: ca * se, z: ce } };
  }

  /** Projection orthographique : h/v = écran ; depth = axe vue (tri peintre). */
  project3DCam(p: Vec3, c: Vec3): { h: number; v: number; depth: number } {
    const ca = Math.cos(this.az), sa = Math.sin(this.az), ce = Math.cos(this.el), se = Math.sin(this.el);
    const vx = p.x - c.x, vy = p.y - c.y, vz = p.z - c.z;
    const x1 = vx * ca - vy * sa, y1 = vx * sa + vy * ca;
    const y2 = y1 * ce - vz * se, z2 = y1 * se + vz * ce;
    return { h: x1, v: -z2, depth: y2 };
  }

  /** Inverse de project3DCam (rotation orthonormale → transposée). */
  unproject3DCam(h: number, v: number, depth: number, c: Vec3): Vec3 {
    const ca = Math.cos(this.az), sa = Math.sin(this.az), ce = Math.cos(this.el), se = Math.sin(this.el);
    const x1 = h, z2 = -v, y2 = depth;
    const y1 = y2 * ce + z2 * se, z1 = -y2 * se + z2 * ce;
    const vx = x1 * ca + y1 * sa, vy = -x1 * sa + y1 * ca;
    return { x: c.x + vx, y: c.y + vy, z: c.z + z1 };
  }

  setCamPreset(name: string): void {
    const p = CAM_PRESETS[name] || CAM_PRESETS.iso; this.az = p[0]; this.el = p[1];
    this.scale = null; this.render();
  }
  /** Active/désactive la vue multi-salles. À l'activation, affiche TOUTES les salles (visibleDcIds = tout)
      et recadre sur l'ensemble ; à la désactivation, revient à la salle active. */

  setMultiDc(on: boolean): void {
    this.multiDc = !!on;
    if (this.multiDc) this.visibleDcIds = new Set(this.store.all("datacenters").map((d: any) => d.id));
    this.camTarget = null; this.scale = null;
    this.buildToolbar(); this.render();
  }


  /* ---- cadrage ---- */
  protected sceneBounds(dc: any): { minH: number; minV: number; maxH: number; maxV: number } {
    if (this.view === "top") return { minH: 0, minV: 0, maxH: dc.width_mm, maxV: dc.depth_mm };   // vue Dessus : la salle (h=x, v=y)
    if (this.view === "floor") { const ft = this.floorTargetResolve(); const cfg = ft ? this.floor.config(ft.location, ft.floor) : null; return { minH: 0, minV: 0, maxH: cfg ? cfg.width_mm : 1000, maxV: cfg ? cfg.depth_mm : 1000 }; }
    const c = this.camCenter(dc);
    let minH = Infinity, minV = Infinity, maxH = -Infinity, maxV = -Infinity;
    const acc = (p: Vec3) => { const q = this.project3DCam(p, c); minH = Math.min(minH, q.h); maxH = Math.max(maxH, q.h); minV = Math.min(minV, q.v); maxV = Math.max(maxV, q.v); };
    // bornes d'une salle (en coords plan-salle), transformées au monde par `toW` (identité en mono-salle).
    const accRoom = (rdc: any, toW: (p: Vec3) => Vec3) => {
      const vis = this.store.racksOfDc(rdc.id).filter((r) => !this.hidden3dRacks.has(r.id));
      if (vis.length) {
        vis.forEach((r) => {
          const w = r.width_mm || RACK_WIDTH_DEFAULT, d = r.depth || RACK_DEPTH_DEFAULT, H = RackGeometry.physHeight(r);
          const o = Normalize.rackOrientation(r.orientation) * Math.PI / 180, co = Math.cos(o), so = Math.sin(o);
          const cx = (r.dc_x != null) ? r.dc_x : w / 2, cy = (r.dc_y != null) ? r.dc_y : d / 2, hw = w / 2, hd = d / 2;
          [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].forEach(([lx, ly]) => { const x = cx + lx * co - ly * so, y = cy + lx * so + ly * co; acc(toW({ x, y, z: 0 })); acc(toW({ x, y, z: H })); });
        });
      } else {
        const W = rdc.width_mm, D = rdc.depth_mm, H = this.zRef(rdc);
        [[0, 0, 0], [W, 0, 0], [W, D, 0], [0, D, 0], [0, 0, H], [W, 0, H], [W, D, H], [0, D, H]].forEach(([x, y, z]) => acc(toW({ x, y, z })));
      }
    };
    if (this._multi && this._multi.rooms.length) {
      this._multi.rooms.forEach((room) => accRoom(room.dc, (p) => FloorLayout.roomToWorld(room, p)));
    } else {
      accRoom(dc, (p) => p);
    }
    return { minH, minV, maxH, maxV };
  }

  protected minScale(dc: any): number {
    let floor = 0.02;
    try {
      let b = this.sceneBounds(dc); if (this.floorXf) b = this.rotBounds(b, this.floorXf);
      const bw = Math.max(1, b.maxH - b.minH), bh = Math.max(1, b.maxV - b.minV);
      const SW = this.stage.clientWidth || 900, SH = this.stage.clientHeight || 560;
      floor = Math.min(0.02, Math.min(SW / bw, SH / bh) * 0.4);
    } catch (_) { /* défaut */ }
    return Math.max(0.0005, floor);
  }

  recenter(keepScale?: boolean): void {
    if (!this.svg) return;
    const dc = this.current(); if (!dc && this.view !== "floor") return;   // vue Étage : cadrage sur l'étage (sans salle)
    let b = this.sceneBounds(dc); if (this.floorXf) b = this.rotBounds(b, this.floorXf);   // cadrer sur les bornes APRÈS rotation de la vue
    const bw = Math.max(1, b.maxH - b.minH), bh = Math.max(1, b.maxV - b.minV);
    const SW = this.stage.clientWidth || 900, SH = this.stage.clientHeight || 560, pad = 40;
    if (!keepScale || this.scale == null) this.scale = Math.max(this.minScale(dc), Math.min(6, Math.min((SW - pad * 2) / bw, (SH - pad * 2) / bh)));
    this.tx = (SW - bw * this.scale) / 2 - b.minH * this.scale;
    this.ty = (SH - bh * this.scale) / 2 - b.minV * this.scale;
    this.applyTransform();
  }

  protected zoomBy(factor: number): void {
    if (this.scale == null) return;
    const px = (this.stage.clientWidth || 900) / 2, py = (this.stage.clientHeight || 560) / 2;
    const wx = (px - this.tx) / this.scale, wy = (py - this.ty) / this.scale;
    this.scale = Math.max(this.minScale(this.current()), Math.min(6, this.scale * factor));
    this.tx = px - wx * this.scale; this.ty = py - wy * this.scale;
    // 2D (plan de salle / plan d'étage) : appliquer la transform à la vue courante ; 3D : recadrer le pivot caméra.
    if (this.view === "top" || this.view === "floor") this.applyTransform(); else this.recenterPivot3D();
  }

  /** AABB d'un rect de bornes après rotation de la vue (autour de cx,cy), pour recadrer. */
  protected rotBounds(b: { minH: number; minV: number; maxH: number; maxV: number }, xf: { angle: number; cx: number; cy: number }): { minH: number; minV: number; maxH: number; maxV: number } {
    const rad = xf.angle * Math.PI / 180, co = Math.cos(rad), si = Math.sin(rad);
    let minH = Infinity, minV = Infinity, maxH = -Infinity, maxV = -Infinity;
    ([[b.minH, b.minV], [b.maxH, b.minV], [b.maxH, b.maxV], [b.minH, b.maxV]] as Array<[number, number]>).forEach(([x, y]) => {
      const dx = x - xf.cx, dy = y - xf.cy, rx = xf.cx + dx * co - dy * si, ry = xf.cy + dx * si + dy * co;
      minH = Math.min(minH, rx); maxH = Math.max(maxH, rx); minV = Math.min(minV, ry); maxV = Math.max(maxV, ry);
    });
    return { minH, minV, maxH, maxV };
  }

  /** Remet les textes À L'ENDROIT malgré la rotation/miroir de la vue 2D (contre-transform autour de l'ancre de chaque texte). */
  protected uprightTexts(): void {
    if (!this.floorXf || !this.gRoot) return;
    const f = this.floorXf, ang = (360 - f.angle) % 360;
    if (!ang && !f.flip) return;
    this.gRoot.querySelectorAll("text").forEach((t) => {
      const x = parseFloat(t.getAttribute("x") || "0") || 0, y = parseFloat(t.getAttribute("y") || "0") || 0, pr = t.getAttribute("transform");
      let k = f.flip ? `translate(${2 * x} 0) scale(-1 1) ` : "";   // contre-miroir autour de l'ancre
      if (ang) k += `rotate(${ang} ${x} ${y})`;
      t.setAttribute("transform", (pr ? pr + " " : "") + k.trim());
    });
  }


  /* ---- interactions ---- */
  protected onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    if (this.scale == null || !this.svg) return;
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    const r = this.svg.getBoundingClientRect(), px = ev.clientX - r.left, py = ev.clientY - r.top;
    const wx = (px - this.tx) / this.scale, wy = (py - this.ty) / this.scale;
    this.scale = Math.max(this.minScale(this.current()), Math.min(6, this.scale * factor));
    this.tx = px - wx * this.scale; this.ty = py - wy * this.scale;
    if (this.view === "top" || this.view === "floor") this.applyTransform(); else this.recenterPivot3D();
  }

  /** Pan 2D (vue Dessus) : translation directe de tx/ty. */
  protected startPan2D(ev: MouseEvent): void {
    ev.preventDefault();
    const sx = ev.clientX, sy = ev.clientY, ox = this.tx, oy = this.ty;
    const move = (e: MouseEvent) => { this.tx = ox + (e.clientX - sx); this.ty = oy + (e.clientY - sy); this.applyTransform(); };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }

  protected startOrbit(ev: MouseEvent, dc: any): void {
    ev.preventDefault();
    this._navMoved = false;   // nouveau geste : un menu pourra s'ouvrir si pas de glisser
    let sx = ev.clientX, sy = ev.clientY, az0 = this.az, el0 = this.el, started = false;
    const move = (e: MouseEvent) => {
      if (!started) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) <= 4) return;
        started = true; this._navMoved = true; this.recenterPivot3D(); sx = e.clientX; sy = e.clientY; az0 = this.az; el0 = this.el;
      }
      this.az = az0 + (e.clientX - sx) * 0.01;
      this.el = Math.max(-1.5, Math.min(1.5, el0 + (e.clientY - sy) * 0.01));
      this.scheduleRender(dc);
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }

  protected startTargetPan(ev: MouseEvent, dc: any): void {
    ev.preventDefault();
    const sx = ev.clientX, sy = ev.clientY, t0 = Object.assign({}, this.camCenter(dc)), ax = this.camAxes();
    const move = (e: MouseEvent) => {
      const k = 1 / (this.scale || 1), dx = (e.clientX - sx) * k, dy = (e.clientY - sy) * k;
      this.camTarget = { x: t0.x - ax.right.x * dx + ax.up.x * dy, y: t0.y - ax.right.y * dx + ax.up.y * dy, z: t0.z - ax.right.z * dx + ax.up.z * dy };
      this.scheduleRender(dc);
    };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }

  protected scheduleRender(dc: any): void {
    if (this._raf3d) return;
    this._raf3d = requestAnimationFrame(() => { this._raf3d = 0; this.renderThreeD(dc); });
  }
  /** Recentre le pivot (camTarget) sur le centroïde VISIBLE sans bouger l'image (orbite naturelle).
      Repli (rien de visible) : point monde au centre de l'écran. Réplique de `_recenterPivot3D` (réf.). */

  protected recenterPivot3D(): void {
    if (this.view !== "3d" || !this.svg || this.scale == null) { this.applyTransform(); return; }
    const dc = this.current();   // peut être null (multi-salles vue d'ensemble) — camCenter gère via _multi
    const target = this.visibleCentroidWorld(dc);
    if (target) { this.setPivotKeepingView(target, dc); return; }
    const SW = this.stage.clientWidth || 900, SH = this.stage.clientHeight || 560;
    const c = this.camCenter(dc);
    const Hc = (SW / 2 - this.tx) / this.scale, Vc = (SH / 2 - this.ty) / this.scale;
    this.camTarget = this.unproject3DCam(Hc, Vc, 0, c);
    this.tx = SW / 2; this.ty = SH / 2;
    this.renderThreeD(dc);
  }

  /** Déplace le PIVOT vers le point monde P SANS bouger l'image (recale tx/ty sur sa position écran actuelle). */
  protected setPivotKeepingView(P: Vec3, dc: any): void {
    const c = this.camCenter(dc), q = this.project3DCam(P, c);
    this.tx = this.tx + q.h * this.scale!; this.ty = this.ty + q.v * this.scale!;
    this.camTarget = { x: P.x, y: P.y, z: P.z };
    this.renderThreeD(dc);
  }
  /** Centroïde MONDE des centres de gravité (baies + équipements libres) AFFICHÉS et DANS le viewport.
      Gère mono (coords locales) ET multi-salles (via roomToWorld par salle). null si rien de visible. */

  protected visibleCentroidWorld(dc: any): Vec3 | null {
    if (this.view !== "3d" || this.scale == null) return null;
    const c = this.camCenter(dc);
    const SW = this.stage.clientWidth || 900, SH = this.stage.clientHeight || 560;
    const inView = (wp: Vec3) => { const q = this.project3DCam(wp, c); const sx = this.tx + q.h * this.scale!, sy = this.ty + q.v * this.scale!; return sx >= 0 && sx <= SW && sy >= 0 && sy <= SH; };
    let ax = 0, ay = 0, az = 0, n = 0;
    const add = (wp: Vec3) => { if (inView(wp)) { ax += wp.x; ay += wp.y; az += wp.z; n++; } };
    const rooms = this._multi ? this._multi.rooms : null;
    const toWorld = (room: any, p: Vec3) => (room ? FloorLayout.roomToWorld(room, p) : p);
    this.displayedDcIds(dc).forEach((id) => {
      const room = rooms ? rooms.find((rm: any) => rm.dc.id === id) : null;
      if (rooms && !room) return;   // multi : salle non posée (masquée) → ignorée
      this.store.racksOfDc(id).filter((r: any) => !this.hidden3dRacks.has(r.id)).forEach((r: any) => {
        const local = { x: (r.dc_x != null ? r.dc_x : (r.width_mm || RACK_WIDTH_DEFAULT) / 2), y: (r.dc_y != null ? r.dc_y : (r.depth || RACK_DEPTH_DEFAULT) / 2), z: RackGeometry.physHeight(r) / 2 };
        add(toWorld(room, local));
      });
      this.store.freeEquipsOfDc(id).forEach((e: any) => {
        if (e.dc_x == null || e.dc_y == null) return;
        const bx = FreeEquipGeometry.box(e);
        add(toWorld(room, { x: e.dc_x, y: e.dc_y, z: (bx.z || 0) + bx.h / 2 }));
      });
    });
    return n ? { x: ax / n, y: ay / n, z: az / n } : null;
  }

  /** Largeur de vue visible (m) — proxy de distance caméra en ortho. Estime le « fit » si scale non encore posé. */
  protected camViewWidthM(dc: any): number {
    let sc = this.scale;
    if (sc == null) {
      const b = this.sceneBounds(dc), bw = Math.max(1, b.maxH - b.minH), bh = Math.max(1, b.maxV - b.minV);
      const SW = this.stage.clientWidth || 900, SH = this.stage.clientHeight || 560, pad = 40;
      sc = Math.max(0.02, Math.min(6, Math.min((SW - pad * 2) / bw, (SH - pad * 2) / bh)));
    }
    return ((this.stage.clientWidth || 900) / sc) / 1000;
  }

}
