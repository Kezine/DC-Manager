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

/* Icônes des contrôles 3D : règle graduée (mesure), projection orthographique (lignes parallèles) / perspective (lignes fuyantes). */
const ICON_RULER = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="8.5" width="19" height="7" rx="1"/><line x1="6.5" y1="8.5" x2="6.5" y2="12"/><line x1="10.5" y1="8.5" x2="10.5" y2="13"/><line x1="14.5" y1="8.5" x2="14.5" y2="12"/><line x1="18.5" y1="8.5" x2="18.5" y2="13"/></svg>';
/* Outil de POSITIONNEMENT : un rectangle (baie) avec une poignée de coin et une cote ⟂ vers un bord. */
const ICON_POSITION = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="1"/><circle cx="9" cy="9" r="2" fill="currentColor" stroke="none"/><line x1="2.5" y1="9" x2="7" y2="9"/><line x1="2.5" y1="6.5" x2="2.5" y2="11.5"/><line x1="9" y1="2.5" x2="9" y2="7"/><line x1="6.5" y1="2.5" x2="11.5" y2="2.5"/></svg>';
const ICON_ORTHO = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="4" x2="6" y2="20"/><line x1="18" y1="4" x2="18" y2="20"/><line x1="6" y1="9" x2="18" y2="9"/><line x1="6" y1="15" x2="18" y2="15"/></svg>';
const ICON_PERSP = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><line x1="9" y1="4" x2="3" y2="20"/><line x1="15" y1="4" x2="21" y2="20"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="5.5" y1="15" x2="18.5" y2="15"/></svg>';
/* Toggles RESPONSIVE (mobile/tablette) : « réglages 3D » (ouvre le panneau latéral en drawer) et « outils »
   (révèle l'overlay zoom/mesure/export, centré verticalement). Masqués en grand écran (cf. .gz-resp-toggle). */
const ICON_GEAR = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
/* Icônes des POINTS DE VUE caméra : un CUBE 3D (isométrique) dont la FACE regardée est soulignée d'un liseré
   ORANGE (accent) — indique le sens de visualisation. Dessus / Face / Arrière (face du fond) / Côté (face droite).
   Le filaire du cube est en `currentColor` atténué ; la face active est tracée + teintée à l'accent. */
const CUBE_WIRE = "M4 9L14 9L14 19L4 19Z M4 9L9 4L19 4L14 9 M14 19L19 14L19 4";
const cubeIcon = (faceD: string): string =>
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path opacity="0.45" d="' + CUBE_WIRE + '"/>'
  + '<path d="' + faceD + '" stroke-width="2" style="stroke:var(--accent);fill:var(--accent);fill-opacity:0.22"/></svg>';
const ICON_VIEW_TOP = cubeIcon("M4 9L9 4L19 4L14 9Z");     // face du dessus (losange supérieur)
const ICON_VIEW_FRONT = cubeIcon("M4 9L14 9L14 19L4 19Z"); // face avant (carré frontal)
const ICON_VIEW_SIDE = cubeIcon("M14 9L19 4L19 14L14 19Z"); // face droite (losange latéral)
const ICON_VIEW_BACK = cubeIcon("M9 4L19 4L19 14L9 14Z");   // face arrière (panneau du fond)

export class DcCamera extends DcBase {

  /** BANDEAU de contrôles en HAUT du canevas (zoom · recentrage · points de vue caméra · outils). Disposé en
      ligne (cf. .dc-control-bar) ; défilable horizontalement sur petit écran. L'icône « réglages 3D » (responsive)
      ouvre le panneau latéral en modale. */
  protected buildControls(): void {
    const c = document.createElement("div"); c.className = "graph-zoom-controls dc-control-bar"; this.controlsEl = c;
    c.innerHTML = `
      <button class="btn btn-sm dc-back-btn" data-act="back" title="Retour à la vue précédente" aria-label="Retour" style="display:none"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="M11 18l-6-6 6-6"/></svg></button>
      <span class="gz-sep" data-back-sep style="display:none"></span>
      <button class="btn btn-ghost btn-sm" data-act="in" title="Zoom avant" aria-label="Zoom avant">+</button>
      <button class="btn btn-ghost btn-sm" data-act="out" title="Zoom arrière" aria-label="Zoom arrière">−</button>
      <span class="gz-sep"></span>
      <button class="btn btn-ghost btn-sm" data-act="recenter" title="Recentrer / ajuster la vue" aria-label="Recentrer la vue">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><line x1="12" y1="1.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22.5" y2="12"/></svg>
      </button>
      <div class="dc-cam-presets" data-cam-presets title="Point de vue">
        <button class="btn btn-ghost btn-sm graph-icon-btn" data-preset="top" title="Vue de dessus" aria-label="Vue de dessus">${ICON_VIEW_TOP}</button>
        <button class="btn btn-ghost btn-sm graph-icon-btn" data-preset="front" title="Vue de face" aria-label="Vue de face">${ICON_VIEW_FRONT}</button>
        <button class="btn btn-ghost btn-sm graph-icon-btn" data-preset="back" title="Vue de l'arrière" aria-label="Vue de l'arrière">${ICON_VIEW_BACK}</button>
        <button class="btn btn-ghost btn-sm graph-icon-btn" data-preset="side" title="Vue de côté" aria-label="Vue de côté">${ICON_VIEW_SIDE}</button>
      </div>
      <button class="btn btn-ghost btn-sm" data-act="fs" title="Plein écran" aria-label="Plein écran">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/></svg>
      </button>
      <span class="gz-sep" data-tools-sep></span>
      <button class="btn btn-ghost btn-sm graph-icon-btn" data-act="proj" title="Projection : orthographique / perspective" style="display:none"></button>
      <button class="btn btn-ghost btn-sm graph-icon-btn" data-act="measure" title="Outil de mesure multipoint (cliquer pour poser des points)">${ICON_RULER}</button>
      <button class="btn btn-ghost btn-sm graph-icon-btn" data-act="position" title="Aide au positionnement : placer une baie par ses coins (murs / coins d'autres baies, cotes ⟂)" style="display:none">${ICON_POSITION}</button>
      <span class="gz-sep"></span>
      <button class="btn btn-ghost btn-sm graph-icon-btn" data-act="eimg" title="Exporter une image (SVG / JPEG)…" aria-label="Exporter une image">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
      </button>
      <button class="btn btn-ghost btn-sm gz-resp-toggle" data-act="resp-opts" title="Réglages 3D / panneau latéral" aria-label="Réglages 3D">${ICON_GEAR}</button>`;
    c.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button"); if (!b) return;
      // Toggle RESPONSIVE : « réglages 3D » → ouvre/ferme le panneau latéral en modale (cf. .dc-row.show-side).
      if ((b as HTMLElement).dataset.act === "resp-opts") { if (this.rowEl) this.rowEl.classList.toggle("show-side"); return; }
      const gl = this.view === "3d" && this.useWebGL && this._three;   // moteur Three SEULEMENT en vue 3D-WebGL ; en 2D (Dessus/Étage) → caméra SVG (le moteur Three persiste mais est détaché)
      const preset = (b as HTMLElement).dataset.preset; if (preset) { if (gl) this._three.setPreset(preset); else this.setCamPreset(preset); return; }
      const a = (b as HTMLElement).dataset.act;
      if (a === "back") { this.goBack(); return; }
      if (a === "measure") { if (this.measure && this.measure.active) this.measureCancel(); else this.measureArm(); return; }
      if (a === "position") { if (this.positioning && this.positioning.active) this.positionCancel(); else this.positionArm(); return; }
      if (a === "proj") { this.webglPerspective = !this.webglPerspective; if (this._three) this._three.setProjection(this.webglPerspective); this.persistView(); this.updateControls(); return; }
      if (a === "in") { if (gl) this._three.zoomBy(1.2); else this.zoomBy(1.2); }
      else if (a === "out") { if (gl) this._three.zoomBy(1 / 1.2); else this.zoomBy(1 / 1.2); }
      else if (a === "recenter") { if (gl) this._three.recenter(); else { this.camTarget = null; this.scale = null; this.render(); } }
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
    // VUE 3D (WebGL) : JPEG de la VUE ACTUELLE, sur-échantillonnée ×N (×1 = résolution affichée). Pas de SVG en 3D.
    if (this.view === "3d" && this.useWebGL && this._three) {
      const base = this._three.exportBaseSize();
      const scale = await ImageExport.scaleDialog(base.w, base.h, this._three.exportMaxDim());
      if (!scale) return;
      this._three.exportJPEG(scale, (b: Blob | null) => {
        if (b) { ImageExport.download(this.exportName("jpg"), b); Notify.toast("Export JPEG généré (" + (base.w * scale) + "×" + (base.h * scale) + ")"); }
        else Notify.toast("Échec de l'export JPEG", "err");
      });
      return;
    }
    // VUES 2D (Plan de salle / Plan d'étage) : SVG vectoriel conservé (ou JPEG rasterisé).
    if (!this.svg) { Notify.toast("Rien à exporter", "err"); return; }
    const res = await ImageExport.dialog(false);
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
    const is3d = this.view === "3d";
    const presets = this.controlsEl.querySelector("[data-cam-presets]") as HTMLElement | null;
    if (presets) presets.style.display = is3d ? "flex" : "none";
    // outil de MESURE (toutes vues) : état actif
    const meas = this.controlsEl.querySelector('[data-act="measure"]') as HTMLElement | null;
    if (meas) meas.classList.toggle("active", !!(this.measure && this.measure.active));
    // outil de POSITIONNEMENT : vue Plan de salle uniquement (placement au sol) — masqué ailleurs + état actif
    const pos = this.controlsEl.querySelector('[data-act="position"]') as HTMLElement | null;
    if (pos) { pos.style.display = (this.view === "top") ? "" : "none"; pos.classList.toggle("active", !!(this.positioning && this.positioning.active)); }
    // PROJECTION (3D uniquement) : icône (ortho = lignes parallèles · perspective = lignes fuyantes) + visibilité
    const proj = this.controlsEl.querySelector('[data-act="proj"]') as HTMLElement | null;
    if (proj) { proj.style.display = is3d ? "" : "none"; proj.innerHTML = this.webglPerspective ? ICON_PERSP : ICON_ORTHO; proj.title = this.webglPerspective ? "Projection : perspective (cliquer pour orthographique)" : "Projection : orthographique (cliquer pour perspective)"; }
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


  /* ---- cadrage (vues 2D : Plan de salle / Plan d'étage ; la 3D est cadrée par le moteur WebGL) ---- */
  protected sceneBounds(dc: any): { minH: number; minV: number; maxH: number; maxV: number } {
    if (this.view === "floor") { const ft = this.floorTargetResolve(); const cfg = ft ? this.floor.config(ft.location, ft.floor) : null; return { minH: 0, minV: 0, maxH: cfg ? cfg.width_mm : 1000, maxV: cfg ? cfg.depth_mm : 1000 }; }
    return { minH: 0, minV: 0, maxH: dc ? dc.width_mm : 1000, maxV: dc ? dc.depth_mm : 1000 };   // vue Dessus : la salle (h=x, v=y)
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
    this.applyTransform();   // 2D (Plan de salle / Plan d'étage) — la 3D (WebGL) gère son propre zoom
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

  /** Recalcule le transform anti-miroir/rotation d'UN texte à partir de son x/y COURANT (le remplace) — pour
      les labels SANS transform de base (waypoints) déplacés en direct : sinon le contre-miroir reste figé sur
      l'ancienne ancre et le label part dans le sens inverse. */
  protected applyUprightText(t: Element): void {
    const f = this.floorXf; if (!f) return;
    const ang = (360 - f.angle) % 360;
    if (!ang && !f.flip) { t.removeAttribute("transform"); return; }
    const x = parseFloat(t.getAttribute("x") || "0") || 0, y = parseFloat(t.getAttribute("y") || "0") || 0;
    let k = f.flip ? `translate(${2 * x} 0) scale(-1 1) ` : "";
    if (ang) k += `rotate(${ang} ${x} ${y})`;
    t.setAttribute("transform", k.trim());
  }


  /* ---- interactions ---- */
  protected onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    this.zoomAtClient(ev.deltaY < 0 ? 1.1 : 1 / 1.1, ev.clientX, ev.clientY);
  }

  /** Zoom 2D autour d'un point écran (molette OU pinch tactile). Mêmes bornes que la molette. */
  protected zoomAtClient(factor: number, clientX: number, clientY: number): void {
    if (this.scale == null || !this.svg) return;
    const r = this.svg.getBoundingClientRect(), px = clientX - r.left, py = clientY - r.top;
    const wx = (px - this.tx) / this.scale, wy = (py - this.ty) / this.scale;
    this.scale = Math.max(this.minScale(this.current()), Math.min(6, this.scale * factor));
    this.tx = px - wx * this.scale; this.ty = py - wy * this.scale;
    this.applyTransform();   // 2D (Plan de salle / Plan d'étage) — la 3D (WebGL) gère son propre zoom
  }

  /** Pan 2D incrémental (glisser tactile à 1 doigt / centroïde à 2 doigts). */
  protected panByClient(dx: number, dy: number): void {
    if (this.scale == null) return;
    this.tx += dx; this.ty += dy; this.applyTransform();
  }

  /** Pan 2D (vue Dessus) : translation directe de tx/ty. */
  protected startPan2D(ev: MouseEvent): void {
    ev.preventDefault();
    const sx = ev.clientX, sy = ev.clientY, ox = this.tx, oy = this.ty;
    const move = (e: MouseEvent) => { this.tx = ox + (e.clientX - sx); this.ty = oy + (e.clientY - sy); this.applyTransform(); };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }

}
