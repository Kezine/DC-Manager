import type { Store } from "../store";
import { Dom } from "../ui/Dom";
import { FormControls } from "../ui/FormControls";
import { Dialog } from "../ui/Dialog";
import { Notify } from "../ui/Notify";
import { ContextMenu } from "../ui/ContextMenu";
import type { CtxSection } from "../ui/ContextMenu";
import { ImageExport } from "../ui/ImageExport";
import type { ExportOptions } from "../ui/ImageExport";
import { Html } from "../core/Html";
import { Normalize } from "../core/Normalize";
import { RackGeometry } from "../geometry/RackGeometry";
import { RackScene } from "../geometry/RackScene";
import { FreeEquipGeometry } from "../geometry/FreeEquipGeometry";
import { Resolver3D } from "../geometry/Resolver3D";
import { FloorLayout } from "../geometry/FloorLayout";
import type { MultiLayout, RoomPlacement } from "../geometry/FloorLayout";
import { Box } from "../geometry/Box";
import { Painter } from "../geometry/Painter";
import { GridGeometry } from "../geometry/GridGeometry";
import { Depths } from "../registries/Depths";
import { EquipmentTypes } from "../registries/EquipmentTypes";
import { Format } from "../core/Format";
import { Text } from "../core/Text";
import { Waypoint } from "../models/Waypoint";
import { CableStatuses } from "../domain/CableStatuses";
import { RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_EAR_MM, U_MM, SIDE_U_STEP, BRUSH_PADDING_MM } from "../domain/constants";

const DC_DOT_PX = 5;                 // rayon écran (px) des pastilles de câble
const CABLE_PORT_STUB_MM = 20;       // longueur du stub de sortie ⊥ des ports (cablePortNormal)
const CABLE_SPLINE_K = 1 / 6;        // tension Catmull-Rom (arrondi des câbles routés)

/* =============================================================================
   DatacenterView — TRANCHE-PILOTE (Phase 5c.1).
   Valide le pattern de la vue 3D : caméra orbitale orthographique + projection
   peintre, rendu d'UNE salle (sol + baies en boîtes 3D), orbite / déplacement /
   zoom. Le couplage aux globals du monolithe (`store`, `prefs`, `openRackForm`,
   multi-salles, …) devient une injection (store + DatacenterHost).
   NON inclus (sous-phases suivantes) : occupants/équipements/câbles/waypoints dans
   les baies, portes & capots, multi-salles & routes inter-DC, vues Dessus/Étage 2D,
   panneau latéral, persistance de l'état de vue.
   ============================================================================= */
export interface DatacenterHost {
  setDirty?(v: boolean): void;
  openRackForm?(id: string): void;
  openEquipmentDetail?(id: string): void;
  openCableForm?(id: string | null, opts?: any): void;
  openWaypointForm?(id: string | null, opts?: any): void;
  openDatacenterForm?(id: string): void;
  openFloorForm?(location: string, floor: string, opts?: any): void;
  /** URL (objectURL) de l'image attachée à une face d'un équipement, ou null. */
  faceImageUrl?(eqId: string, face: string): string | null;
  /** Assignation d'un emplacement libre (clic 3D) → dialogue, puis `onDone` rafraîchit la vue. */
  assignSlot?(rackId: string, u: number, side: string, height: number, onDone: () => void): void;
  assignSideSlot?(rackId: string, face: string, lr: string, col: number, uTop: number, onDone: () => void): void;
  assignWallSlot?(rackId: string, wall: string, margin: string, col: number, uTop: number, onDone: () => void): void;
  assignCapSlot?(rackId: string, face: string, cx: number, cy: number, onDone: () => void): void;
}

interface Vec3 { x: number; y: number; z: number; }
interface Drawable { depth: number; node: SVGElement; }
/** Stub de sortie ⊥ : indique si P[1]/P[len-2] sont des points de sortie 20 mm (tracé droit + tangente imposée). */

const CAM_PRESETS: Record<string, [number, number]> = {
  iso: [-0.62, 0.46], top: [0, Math.PI / 2], front: [0, 0], back: [Math.PI, 0], side: [Math.PI / 2, 0],
};
/* icônes de PORTÉE d'affichage 3D (salle active / bâtiment / tous les sites). */
const DC_SCOPE_ICONS = {
  self: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7.5"/><line x1="12" y1="1.5" x2="12" y2="4.5"/><line x1="12" y1="19.5" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="4.5" y2="12"/><line x1="19.5" y1="12" x2="22.5" y2="12"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/></svg>',
  bldg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19"/><path d="M9.7 6h1.2M13.1 6h1.2M9.7 10h1.2M13.1 10h1.2M9.7 14h1.2M13.1 14h1.2" stroke-width="1.6"/></svg>',
  all: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="2.5" y="9" width="5.5" height="12.5"/><rect x="9.25" y="3.5" width="5.5" height="18"/><rect x="16" y="11.5" width="5.5" height="10"/></svg>',
};

export class DatacenterView {
  private store: Store;
  private host: DatacenterHost;
  private stage: HTMLElement;
  private toolbarEl!: HTMLElement;
  private sideEl: HTMLElement | null = null;
  private roomSel: HTMLSelectElement | null = null;

  view: "3d" | "top" | "floor" = "3d";
  dcId: string | null = null;
  selEquipId: string | null = null;
  selWaypointId: string | null = null;
  selRoomId: string | null = null;                              // salle sélectionnée en vue Étage
  selFloorEquip: string | null = null;                          // équipement d'étage sélectionné
  freePlace = false;                                            // « Placement libre » : désactive l'aimantation à la grille au glisser
  blockEdit = false;                                            // mode « Cases inaccessibles » : glisser pour (dé)marquer des cases
  routeBuild: { fromPortId: string | null; wpIds: string[]; armed?: boolean; mouse?: Vec3 | null } | null = null;   // session de routage 3D
  private _camC: Vec3 | null = null;   // centre caméra du dernier rendu 3D (pour l'aperçu de route → souris)
  private _routeMouseClient: [number, number] | null = null;
  private _routeMouseTO: any = 0;
  floorTarget: { location: string; floor: string } | null = null;   // étage visé (vue Étage), indépendant d'une salle
  // ROTATION de la vue 2D { angle, cx, cy, flip } : Étage = 180° ; Dessus = orientation salle + 180° → bord de réf. EN BAS.
  // Le flip horizontal donne une vraie vue « du dessus » (cohérente avec la 3D, et non « via le plancher »). Nul en 3D.
  private floorXf: { angle: number; cx: number; cy: number; flip: boolean } | null = null;
  private coteEl: HTMLElement | null = null;
  private ttEl: HTMLElement | null = null;   // tooltip enrichi de scène (positionné dans le stage)
  az = CAM_PRESETS.iso[0];
  el = CAM_PRESETS.iso[1];
  scale: number | null = null;
  tx = 0; ty = 0;
  camTarget: Vec3 | null = null;
  hidden3dRacks = new Set<string>();
  selRackId: string | null = null;
  slotSel: { rackId: string; side: string; lo: number; hi: number } | null = null;   // sélection U multiple (Ctrl+clic) — plage contiguë même baie/face
  multiDc = false;                       // vue 3D multi-salles (étages empilés, bâtiments côte à côte)
  visibleDcIds = new Set<string>();      // salles affichées en multi-salles (∪ salle active)
  fadedRacks = new Set<string>();        // baies estompées (translucides — voir au travers)
  private expanded = new Set<string>();  // cartes du panneau DÉPLIÉES (repliées par défaut)
  private _cableEqFilter = "";           // filtre de la liste de câbles par équipement (aide à la sélection)
  private _cableSearch = "";             // filtre texte de la liste de câbles
  // options d'affichage (exposées dans le panneau latéral « Vue 3D »)
  hideFrontEq = false; hideRearEq = false; showPlaceholders = true; showRackSides = true;
  showWaypoints = true; showConduits = true; showPorts = true; showEqNames = true;
  showOrientMarks = true; showPivot = false;
  showFloorAnchor = true;                // vue Étage : marqueur de point d'ancrage (déplaçable, discret) — masquable
  colorMode: "face" | "group" | "type" = "face";   // coloration des équipements 3D
  cableSplineK = CABLE_SPLINE_K;         // arrondi des câbles (slider)
  markerScale = 1;                       // taille des marqueurs de waypoint + connecteurs de port (slider, 1 = défaut/milieu)
  showAllCables = true;                 // false → seuls les câbles sélectionnés (selCables) sont tracés
  selCables = new Set<string>();         // câbles explicitement affichés quand showAllCables = false
  searchTerm = "";                       // surlignage + filtrage des listes (équipements / câbles)
  focusEqId: string | null = null;       // équipement ciblé (surligné + caméra recentrée)
  // contrôles présents mais INERTES tant que la fonctionnalité n'est pas portée (cf. panneau « à venir »).
  showFaceImages = true; showDoors = true; showFloorGrid = true; cablePortNormal = false; routePreviewToMouse = true; cullDistanceM = 15;
  powerBoltSpacingMm = 300;             // espacement (mm) des éclairs ⚡ le long des câbles power

  private scene: RackScene;
  private resolver: Resolver3D;
  private floor: FloorLayout;
  private _multi: MultiLayout | null = null;   // disposition multi-salles du dernier rendu (null = mono)
  private rowEl: HTMLElement | null = null;   // rangée stage|panneau — dimensionnée pour remplir le viewport
  private svg: SVGSVGElement | null = null;
  private gRoot: SVGGElement | null = null;
  private _raf3d = 0;
  private _resizeT: any = 0;
  private _pvTO: any = 0;              // persistance débouncée
  private _restoredKey: string | null = null;   // clé (fileId) dont l'état a déjà été restauré
  private _farCull = false;            // vue « loin » → ports + emplacements libres non rendus (perf)
  private _navMoved = false;           // un glisser (orbite) vient d'avoir lieu → ne pas ouvrir de menu contextuel
  private controlsEl: HTMLElement | null = null;   // overlay zoom / recentrage / points de vue (superposé au stage)
  private floorRail: HTMLElement | null = null;     // vue Étage : rail de navigation rapide entre étages (flottant à gauche)

  constructor(store: Store, mount: HTMLElement, host: DatacenterHost = {}) {
    this.store = store; this.host = host; this.stage = mount; this.scene = new RackScene(store); this.resolver = new Resolver3D(store); this.floor = new FloorLayout(store);
    // Garde headless : sans `document` (tests Node), projection/cadrage restent utilisables.
    if (typeof document === "undefined") return;
    this.toolbarEl = document.createElement("div");
    this.toolbarEl.className = "dc-toolbar";
    this.toolbarEl.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:6px 8px;background:var(--bg-2);border-bottom:1px solid var(--line)";
    const parent = mount.parentElement;
    if (parent) parent.insertBefore(this.toolbarEl, mount);
    this.stage.style.position = this.stage.style.position || "relative";
    // dispose stage | panneau latéral dans une rangée flex (le panneau survit aux re-rendus du stage)
    if (parent) {
      const row = document.createElement("div");
      row.className = "dc-row"; row.style.cssText = "display:flex;min-height:560px;gap:10px;align-items:stretch";
      parent.insertBefore(row, mount);
      row.appendChild(mount);
      this.sideEl = document.createElement("div"); this.sideEl.className = "dc-side";
      row.appendChild(this.sideEl);
      this.rowEl = row;
    }
    // remplir le viewport verticalement (sans déborder) ; recalcul au redimensionnement.
    window.addEventListener("resize", () => {
      clearTimeout(this._resizeT);
      this._resizeT = setTimeout(() => { if (this.stage.offsetParent !== null) { this.fitHeight(); this.render(); } }, 120);
    });
    // entrée/sortie de plein écran → re-cadrer (la rangée change de taille)
    document.addEventListener("fullscreenchange", () => { this.fitHeight(); this.render(); });
    this.buildControls();
    this.buildToolbar();
  }
  /** Overlay de contrôles SUPERPOSÉ au stage (zoom · recentrage · points de vue caméra). Réplique de la source. */
  private buildControls(): void {
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
  private exportName(ext: string): string { return ImageExport.fileBase(this.store.meta.docName || "", "datacenter") + "-datacenter-" + new Date().toISOString().slice(0, 10) + "." + ext; }
  /** SVG autonome fidèle (styles calculés inlinés) cadré sur la VUE actuelle (viewport du stage). */
  private buildExportSvg(): { svg: string; w: number; h: number } {
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
  private updateControls(): void {
    if (!this.controlsEl) return;
    const presets = this.controlsEl.querySelector("[data-cam-presets]") as HTMLElement | null;
    if (presets) presets.style.display = this.view === "3d" ? "flex" : "none";
  }

  /* ---- modèle ---- */

  private dcs(): any[] { return this.store.all("datacenters").slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")); }
  current(): any { const all = this.dcs(); if (!all.length) return null; return (this.dcId && this.store.get("datacenters", this.dcId)) || all[0]; }
  /** Étage affiché par la vue Étage : floorTarget explicite → salle active → 1re salle → 1er étage connu → null. */
  private floorTargetResolve(): { location: string; floor: string } | null {
    if (this.floorTarget) return this.floorTarget;
    const dc = this.dcId ? this.store.get("datacenters", this.dcId) : null;
    if (dc) return { location: dc.location || "", floor: String(dc.floor || "") };
    const all = this.dcs();
    if (all.length) return { location: all[0].location || "", floor: String(all[0].floor || "") };
    const keys = this.floor.allFloorKeys();
    return keys.length ? { location: keys[0].location, floor: keys[0].floor } : null;
  }
  private racks(dcId: string): any[] { return this.store.racksOfDc(dcId); }
  private zRef(dc: any): number { const maxU = this.racks(dc.id).reduce((m, r) => Math.max(m, r.u_count || 0), 0) || 42; return maxU * U_MM; }

  /* ---- toolbar ---- */
  buildToolbar(): void {
    if (!this.toolbarEl) return;
    this.toolbarEl.innerHTML = "";
    const all = this.dcs();
    const sel = document.createElement("select"); sel.className = "app-select"; this.roomSel = sel;
    if (!all.length) { const o = document.createElement("option"); o.textContent = "— aucune salle —"; sel.appendChild(o); sel.disabled = true; }
    else all.forEach((d) => { const o = document.createElement("option"); o.value = d.id; o.textContent = d.name || "(salle)"; sel.appendChild(o); });
    const cur = this.current(); if (cur) sel.value = cur.id;
    sel.onchange = () => { this.dcId = sel.value; this.camTarget = null; this.scale = null; this.selRackId = null; this.render(); };
    this.toolbarEl.appendChild(this.labeled("Salle", sel));

    // mode de vue : 3D ⟷ Dessus (2D) ⟷ Étage (plan bâtiment 2D)
    const modes = document.createElement("div"); modes.className = "dc-subviews"; modes.style.cssText = "display:flex;gap:4px";
    ([["3d", "3D"], ["top", "Plan de salle"], ["floor", "Plan d'étage"]] as Array<["3d" | "top" | "floor", string]>).forEach(([m, label]) => {
      const b = this.btn(label, () => { if (this.view === m) return; this.view = m; if (m === "3d") this.blockEdit = false; this.scale = null; this.camTarget = null; this.buildToolbar(); this.render(); });
      b.classList.toggle("active", this.view === m);
      modes.appendChild(b);
    });
    this.toolbarEl.appendChild(modes);

    // bascule multi-salles (vue 3D seulement) : étages empilés, bâtiments côte à côte
    // (zoom · recentrage · points de vue caméra → overlay superposé au stage, cf. buildControls)
    const multiBtn = this.btn("Multi-salles", () => this.setMultiDc(!this.multiDc), "Afficher toutes les salles (étages empilés / bâtiments côte à côte)");
    multiBtn.classList.toggle("active", this.multiDc);
    multiBtn.style.display = this.view === "3d" ? "" : "none";
    this.toolbarEl.appendChild(multiBtn);
    // bascules d'édition de grille (plans 2D salle/étage) : placement libre + cases inaccessibles
    if (this.view === "top" || this.view === "floor") {
      const edits = document.createElement("div"); edits.className = "dc-subviews"; edits.style.cssText = "display:flex;gap:4px";
      const bFree = this.btn("Placement libre", () => { this.freePlace = !this.freePlace; bFree.classList.toggle("active", this.freePlace); }, "Désactive l'aimantation à la grille pendant le glisser (n'affecte pas les éléments déjà placés)");
      bFree.classList.toggle("active", this.freePlace);
      const bBlock = this.btn("Cases inaccessibles", () => { this.blockEdit = !this.blockEdit; bBlock.classList.toggle("active", this.blockEdit); this.render(); }, "Glissez une sélection sur la grille pour marquer / démarquer les cases (in)accessibles");
      bBlock.classList.toggle("active", this.blockEdit);
      edits.append(bFree, bBlock); this.toolbarEl.appendChild(edits);
    }
    this.updateControls();
  }
  private labeled(label: string, control: HTMLElement): HTMLElement {
    const wrap = document.createElement("label"); wrap.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--fg-dim)";
    wrap.append(document.createTextNode(label), control); return wrap;
  }
  private btn(text: string, onClick: () => void, title?: string): HTMLButtonElement {
    const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost btn-sm"; b.textContent = text; if (title) b.title = title; b.onclick = onClick; return b;
  }

  /* ---- caméra orbitale (azimut autour de Z, puis élévation) ---- */
  private camCenter(dc: any): Vec3 {
    if (!this.camTarget) {
      this.camTarget = this._multi
        ? { x: this._multi.totalW / 2, y: this._multi.maxD / 2, z: this._multi.topZ / 2 }   // centre de l'ensemble multi-salles
        : (dc ? { x: dc.width_mm / 2, y: dc.depth_mm / 2, z: this.zRef(dc) / 2 } : { x: 0, y: 0, z: 0 });
    }
    return this.camTarget;
  }
  private camAxes(): { right: Vec3; up: Vec3 } {
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
  private sceneBounds(dc: any): { minH: number; minV: number; maxH: number; maxV: number } {
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
  private minScale(dc: any): number {
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
  private zoomBy(factor: number): void {
    if (this.scale == null) return;
    const px = (this.stage.clientWidth || 900) / 2, py = (this.stage.clientHeight || 560) / 2;
    const wx = (px - this.tx) / this.scale, wy = (py - this.ty) / this.scale;
    this.scale = Math.max(this.minScale(this.current()), Math.min(6, this.scale * factor));
    this.tx = px - wx * this.scale; this.ty = py - wy * this.scale;
    // 2D (plan de salle / plan d'étage) : appliquer la transform à la vue courante ; 3D : recadrer le pivot caméra.
    if (this.view === "top" || this.view === "floor") this.applyTransform(); else this.recenterPivot3D();
  }

  /* ---- scène SVG ---- */
  private clearStage(): void { Array.from(this.stage.childNodes).forEach((n) => { if (n !== this.controlsEl && n !== this.floorRail) this.stage.removeChild(n); }); this.coteEl = null; this.ttEl = null; }
  private newScene(dc: any): SVGGElement {
    this.clearStage();
    const SW = Math.max(50, this.stage.clientWidth || 900), SH = Math.max(50, this.stage.clientHeight || 560);
    const svg = Dom.svg("svg", { class: "dc-svg", width: SW, height: SH }) as SVGSVGElement;
    this.svg = svg;
    const gRoot = Dom.svg("g") as SVGGElement; this.gRoot = gRoot; svg.appendChild(gRoot);
    svg.addEventListener("mousedown", (ev) => {
      if (this.view === "top" || this.view === "floor") { if (ev.button === 0) this.startPan2D(ev); return; }   // 2D : glisser le fond = pan
      // 3D : GAUCHE = déplacement du modèle · DROIT/Maj = orbite (boutons inversés, fidèle au monolithe).
      if (ev.button === 2 || ev.shiftKey) this.startOrbit(ev, dc); else if (ev.button === 0) this.startTargetPan(ev, dc);
    });
    svg.addEventListener("contextmenu", (e) => e.preventDefault());
    // aperçu de route jusqu'à la SOURIS (3D), throttlé
    svg.addEventListener("mousemove", (ev) => {
      if (this.view !== "3d" || !this.routePreviewToMouse || !this.routeBuild || !this.routeBuild.fromPortId || !this._camC) return;
      this._routeMouseClient = [ev.clientX, ev.clientY];
      if (this._routeMouseTO) return;
      this._routeMouseTO = setTimeout(() => {
        this._routeMouseTO = 0;
        const m = this._routeMouseClient; if (!m || !this.svg || !this.routeBuild || this.scale == null || !this._camC) return;
        const r = this.svg.getBoundingClientRect(), s = this.scale;
        this.routeBuild.mouse = this.unproject3DCam((m[0] - r.left - this.tx) / s, (m[1] - r.top - this.ty) / s, 0, this._camC);
        this.refreshRoutePreview3D();   // MAJ du SEUL aperçu (pas de reconstruction de scène → cibles cliquables préservées)
      }, 45);
    });
    svg.addEventListener("wheel", (ev) => this.onWheel(ev), { passive: false });
    this.stage.insertBefore(svg, this.stage.firstChild);
    return gRoot;
  }
  private finishScene(): void { if (this.scale == null) this.recenter(); else this.applyTransform(); this.markRouteWaypoints(); }
  /** Met en évidence (`.route-pick`) les waypoints DÉJÀ choisis dans la route en cours, sur tous les nœuds `[data-wp]`. */
  private markRouteWaypoints(): void {
    if (!this.svg) return;
    const ids = new Set(this.routeBuild ? this.routeBuild.wpIds : []);
    this.svg.querySelectorAll("[data-wp]").forEach((n) => n.classList.toggle("route-pick", ids.has(n.getAttribute("data-wp") || "")));
  }
  /** Recalcule le SEUL aperçu de route (suivi de souris) sans reconstruire la scène — préserve les cibles cliquables. */
  private refreshRoutePreview3D(): void {
    const g = this.gRoot, c = this._camC; if (!g) return;
    g.querySelectorAll(".dc-route-preview").forEach((n) => n.remove());   // retire l'ancien tracé
    const dc = this.current();
    if (this.view !== "3d" || !dc || !this.routeBuild || !c) return;
    const proj = (p: Vec3) => this.project3DCam(p, c);
    const drawables: Drawable[] = [];
    this.drawRoutePreview3D(dc, proj, drawables);
    drawables.forEach((d) => g.appendChild(d.node));   // ajouté en dernier dans gRoot = au-dessus (et pointer-events:none)
  }
  private applyTransform(): void {
    if (!this.gRoot) return;
    let xf = "";
    if (this.floorXf) {   // vue 2D tournée + miroir → vue réellement « du dessus »
      const f = this.floorXf;
      xf = ` rotate(${f.angle} ${f.cx} ${f.cy})`;
      if (f.flip) xf += ` translate(${2 * f.cx} 0) scale(-1 1)`;
    }
    this.gRoot.setAttribute("transform", `translate(${this.tx},${this.ty}) scale(${this.scale})${xf}`);
  }
  /** AABB d'un rect de bornes après rotation de la vue (autour de cx,cy), pour recadrer. */
  private rotBounds(b: { minH: number; minV: number; maxH: number; maxV: number }, xf: { angle: number; cx: number; cy: number }): { minH: number; minV: number; maxH: number; maxV: number } {
    const rad = xf.angle * Math.PI / 180, co = Math.cos(rad), si = Math.sin(rad);
    let minH = Infinity, minV = Infinity, maxH = -Infinity, maxV = -Infinity;
    ([[b.minH, b.minV], [b.maxH, b.minV], [b.maxH, b.maxV], [b.minH, b.maxV]] as Array<[number, number]>).forEach(([x, y]) => {
      const dx = x - xf.cx, dy = y - xf.cy, rx = xf.cx + dx * co - dy * si, ry = xf.cy + dx * si + dy * co;
      minH = Math.min(minH, rx); maxH = Math.max(maxH, rx); minV = Math.min(minV, ry); maxV = Math.max(maxV, ry);
    });
    return { minH, minV, maxH, maxV };
  }
  /** Remet les textes À L'ENDROIT malgré la rotation/miroir de la vue 2D (contre-transform autour de l'ancre de chaque texte). */
  private uprightTexts(): void {
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
  private onWheel(ev: WheelEvent): void {
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
  private startPan2D(ev: MouseEvent): void {
    ev.preventDefault();
    const sx = ev.clientX, sy = ev.clientY, ox = this.tx, oy = this.ty;
    const move = (e: MouseEvent) => { this.tx = ox + (e.clientX - sx); this.ty = oy + (e.clientY - sy); this.applyTransform(); };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }
  private startOrbit(ev: MouseEvent, dc: any): void {
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
  private startTargetPan(ev: MouseEvent, dc: any): void {
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
  private scheduleRender(dc: any): void {
    if (this._raf3d) return;
    this._raf3d = requestAnimationFrame(() => { this._raf3d = 0; this.renderThreeD(dc); });
  }
  /** Recentre le pivot sur le centroïde visible SANS bouger l'image (orbite naturelle). */
  private recenterPivot3D(): void {
    if (!this.svg || this.scale == null) { this.applyTransform(); return; }
    const dc = this.current(); if (!dc) { this.applyTransform(); return; }
    const target = this.visibleCentroidWorld(dc);
    if (target) {
      const c = this.camCenter(dc), q = this.project3DCam(target, c);
      this.tx = this.tx + q.h * this.scale; this.ty = this.ty + q.v * this.scale;
      this.camTarget = { x: target.x, y: target.y, z: target.z };
    }
    this.renderThreeD(dc);
  }
  private visibleCentroidWorld(dc: any): Vec3 | null {
    if (this.scale == null) return null;
    const c = this.camCenter(dc);
    const SW = this.stage.clientWidth || 900, SH = this.stage.clientHeight || 560;
    const inView = (wp: Vec3) => { const q = this.project3DCam(wp, c); const sx = this.tx + q.h * this.scale!, sy = this.ty + q.v * this.scale!; return sx >= 0 && sx <= SW && sy >= 0 && sy <= SH; };
    let ax = 0, ay = 0, az = 0, n = 0;
    this.racks(dc.id).filter((r) => !this.hidden3dRacks.has(r.id)).forEach((r) => {
      const wp = { x: (r.dc_x != null ? r.dc_x : (r.width_mm || RACK_WIDTH_DEFAULT) / 2), y: (r.dc_y != null ? r.dc_y : (r.depth || RACK_DEPTH_DEFAULT) / 2), z: RackGeometry.physHeight(r) / 2 };
      if (inView(wp)) { ax += wp.x; ay += wp.y; az += wp.z; n++; }
    });
    return n ? { x: ax / n, y: ay / n, z: az / n } : null;
  }

  /* ---- rendu 3D ---- */
  show(): void {
    // restaure l'état de vue UNE FOIS par fichier (les re-rendus de données ne réécrasent pas les réglages de session).
    const key = this.viewStateKey();
    if (key !== this._restoredKey) { this.restoreView(); this._restoredKey = key; }
    this.buildToolbar(); this.fitHeight(); this.render();
  }

  /* ---- persistance de l'état de vue (par fichier, localStorage) ---- */
  private viewStateKey(): string { return "netmap.view3d." + ((this.store.meta && this.store.meta.fileId) ? this.store.meta.fileId : "__nofile"); }
  private static readonly TOGGLE_KEYS = ["hideFrontEq", "hideRearEq", "showPlaceholders", "showRackSides", "showPorts", "showEqNames", "showAllCables", "showWaypoints", "showConduits", "showOrientMarks", "showPivot", "showFloorAnchor", "showFaceImages", "showDoors", "showFloorGrid", "cablePortNormal", "routePreviewToMouse"];
  /** Écrit l'état (débouncé 300 ms) — évite une écriture par frame de pan/zoom. */
  private persistView(): void {
    clearTimeout(this._pvTO);
    this._pvTO = setTimeout(() => {
      try {
        const o: any = { view: this.view, dcId: this.dcId, az: this.az, el: this.el, scale: this.scale, tx: this.tx, ty: this.ty, camTarget: this.camTarget, hidden3dRacks: [...this.hidden3dRacks], fadedRacks: [...this.fadedRacks], colorMode: this.colorMode, cableSplineK: this.cableSplineK, markerScale: this.markerScale, cullDistanceM: this.cullDistanceM, multiDc: this.multiDc, visibleDcIds: [...this.visibleDcIds], floorTarget: this.floorTarget };
        DatacenterView.TOGGLE_KEYS.forEach((k) => { o[k] = (this as any)[k]; });
        window.localStorage.setItem(this.viewStateKey(), JSON.stringify(o));
      } catch (_) { /* quota / indispo → ignoré */ }
    }, 300);
  }
  /** Restaure l'état pour le fichier courant (failsafes : références disparues ignorées ; défauts sinon). */
  private restoreView(): void {
    let o: any = {};
    try { const raw = window.localStorage.getItem(this.viewStateKey()); if (raw) { const p = JSON.parse(raw); if (p && typeof p === "object") o = p; } } catch (_) { o = {}; }
    const has = (coll: string, id: any) => !!(id && this.store.get(coll, id));
    // défauts (état propre par fichier)
    this.az = CAM_PRESETS.iso[0]; this.el = CAM_PRESETS.iso[1]; this.scale = null; this.tx = 0; this.ty = 0; this.camTarget = null;
    this.hideFrontEq = false; this.hideRearEq = false; this.showPlaceholders = true; this.showRackSides = true; this.showPorts = true; this.showEqNames = true; this.showAllCables = true; this.showWaypoints = true; this.showConduits = true;
    this.showOrientMarks = true; this.showPivot = false; this.showFloorAnchor = true; this.showFaceImages = true; this.showDoors = true; this.showFloorGrid = true; this.cablePortNormal = false; this.routePreviewToMouse = true;
    this.colorMode = "face"; this.cableSplineK = CABLE_SPLINE_K; this.markerScale = 1; this.cullDistanceM = 15;
    this.multiDc = false; this.visibleDcIds = new Set(); this.fadedRacks = new Set();
    this.floorTarget = null; this.selRoomId = null; this.selFloorEquip = null; this.routeBuild = null;
    this.selCables = new Set(); this.searchTerm = ""; this.focusEqId = null;
    this.view = (o.view === "top" || o.view === "floor") ? o.view : "3d";
    // toggles persistés
    DatacenterView.TOGGLE_KEYS.forEach((k) => { if (typeof o[k] === "boolean") (this as any)[k] = o[k]; });
    if (o.colorMode === "face" || o.colorMode === "group" || o.colorMode === "type") this.colorMode = o.colorMode;
    if (typeof o.cableSplineK === "number") this.cableSplineK = Math.max(0, Math.min(0.32, o.cableSplineK));
    if (typeof o.markerScale === "number") this.markerScale = Math.max(0.25, Math.min(1.75, o.markerScale));
    if (typeof o.cullDistanceM === "number") this.cullDistanceM = o.cullDistanceM;
    // caméra
    if (typeof o.az === "number") this.az = o.az;
    if (typeof o.el === "number") this.el = o.el;
    if (typeof o.scale === "number" || o.scale === null) this.scale = o.scale;
    if (typeof o.tx === "number") this.tx = o.tx;
    if (typeof o.ty === "number") this.ty = o.ty;
    if (o.camTarget && typeof o.camTarget === "object" && typeof o.camTarget.x === "number") this.camTarget = o.camTarget;
    // salle active + baies masquées (failsafe : seulement ce qui existe encore)
    if (has("datacenters", o.dcId)) this.dcId = o.dcId;
    this.hidden3dRacks = new Set((Array.isArray(o.hidden3dRacks) ? o.hidden3dRacks : []).filter((id: string) => has("racks", id)));
    this.fadedRacks = new Set((Array.isArray(o.fadedRacks) ? o.fadedRacks : []).filter((id: string) => has("racks", id)));
    // multi-salles + salles visibles (failsafe : seulement les salles encore présentes)
    this.multiDc = o.multiDc === true;
    this.visibleDcIds = new Set((Array.isArray(o.visibleDcIds) ? o.visibleDcIds : []).filter((id: string) => has("datacenters", id)));
    if (o.floorTarget && typeof o.floorTarget === "object" && "location" in o.floorTarget) this.floorTarget = { location: o.floorTarget.location || "", floor: String(o.floorTarget.floor != null ? o.floorTarget.floor : "") };
  }
  /** Oublie l'état restauré → la prochaine activation repart des défauts (après reset des préférences). */
  resetView(): void { this._restoredKey = null; }

  /** Étire la rangée stage|panneau pour occuper l'espace vertical RESTANT du viewport (sans déborder). */
  fitHeight(): void {
    const row = this.rowEl; if (!row || row.offsetParent === null) return;   // masqué (onglet inactif) → on saute
    if (document.fullscreenElement === row) { row.style.height = ""; return; }   // plein écran : hauteur gérée par le CSS :fullscreen
    const top = row.getBoundingClientRect().top;
    row.style.height = Math.max(360, Math.floor(window.innerHeight - top - 18 - 2)) + "px";
  }
  render(): void {
    if (typeof document === "undefined") return;
    const showControls = (on: boolean) => { if (this.controlsEl) this.controlsEl.style.display = on ? "flex" : "none"; };
    this.updateControls();
    if (this.floorRail && this.view !== "floor") this.floorRail.style.display = "none";   // rail d'étages : vue Étage uniquement
    // VUE ÉTAGE : pilotée par un étage cible (indépendante d'une salle active)
    if (this.view === "floor") {
      const dc = this.current(); this.renderSide(dc);
      const ft = this.floorTargetResolve();
      if (!ft) { showControls(false); this.clearStage(); const p = document.createElement("p"); p.style.cssText = "padding:24px;color:var(--fg-dim)"; p.textContent = "Aucun étage. Créez une salle (avec bâtiment + étage) pour afficher son plan."; this.stage.appendChild(p); return; }
      showControls(true); this.renderFloor(ft); return;
    }
    const dc = this.current();
    this.renderSide(dc);
    if (!dc) { showControls(false); this.clearStage(); const p = document.createElement("p"); p.style.cssText = "padding:24px;color:var(--fg-dim)"; p.textContent = "Aucune salle (datacenter). Créez-en une pour la visualiser en 3D."; this.stage.appendChild(p); return; }
    showControls(true);
    if (this.roomSel && this.roomSel.value !== dc.id) this.roomSel.value = dc.id;
    if (this.view === "top") this.renderTop(dc); else this.renderThreeD(dc);
  }

  /* =============================================================================
     Panneau latéral — orchestrateur + cartes (réplique OO de renderSide du monolithe).
     3D  : Datacenters (portée/Vue étage) · Racks · Câbles · Vue 3D.
     Dessus : Sélection · Racks dispo (pool) · Équipements libres (pool) · Câbles.
     Cartes repliables (état `expanded`, repliées par défaut sauf déplis explicites).
     ============================================================================= */

  /** Rend une carte repliable (clé persistée dans `expanded`). */
  private collapsible(card: HTMLElement, key: string): HTMLElement {
    const title = card.querySelector(".dc-card-title") as HTMLElement | null;
    if (!title) return card;
    const body = document.createElement("div"); body.className = "dc-card-body";
    while (title.nextSibling) body.appendChild(title.nextSibling);
    card.appendChild(body);
    title.classList.add("dc-card-head");
    const chev = document.createElement("span"); chev.className = "dc-chev";
    title.insertBefore(chev, title.firstChild);
    const apply = (c: boolean) => { chev.textContent = c ? "▸" : "▾"; card.classList.toggle("collapsed", c); };
    apply(!this.expanded.has(key));
    title.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".dc-help")) return;   // clic sur l'aide → ne replie pas
      if (this.expanded.has(key)) this.expanded.delete(key); else this.expanded.add(key);
      apply(!this.expanded.has(key));
    });
    return card;
  }
  /** Salles affichées : mono = salle active ; multi = active ∪ visibleDcIds. */
  private displayedDcIds(dc: any): string[] {
    if (this.view !== "3d") return dc ? [dc.id] : [];
    if (!this.multiDc && dc) return [dc.id];
    const ids = new Set<string>();
    if (dc) ids.add(dc.id);
    if (this.visibleDcIds.size) this.visibleDcIds.forEach((id) => { if (this.store.get("datacenters", id)) ids.add(id); });
    else if (!dc) this.store.all("datacenters").forEach((d: any) => ids.add(d.id));
    return [...ids];
  }
  /** N'affiche que la baie `id` (masque les autres salles affichées), la cible et la sélectionne. */
  private isolateRack(id: string): void {
    const dc = this.current(); if (!dc) return;
    this.hidden3dRacks = new Set(this.displayedDcIds(dc).flatMap((d) => this.store.racksOfDc(d)).map((r: any) => r.id)); this.hidden3dRacks.delete(id);
    const r: any = this.store.get("racks", id);
    if (r) this.camTarget = { x: (r.dc_x != null ? r.dc_x : 0), y: (r.dc_y != null ? r.dc_y : 0), z: RackGeometry.physHeight(r) / 2 };
    this.selRackId = id; this.scale = null; this.render();
  }
  /** Racks du pool (sans salle). */
  private poolRacks(): any[] { return this.store.all("racks").filter((r: any) => !r.datacenter_id).sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")); }
  /** Première maille libre de la salle (placement auto d'une baie/équipement). */
  private freeCell(dc: any): { x: number; y: number } {
    const cell = dc.cell_mm, placed = this.store.racksOfDc(dc.id);
    const occupied = (x: number, y: number) => placed.some((r: any) => Math.abs((r.dc_x || 0) - x) < cell * 0.5 && Math.abs((r.dc_y || 0) - y) < cell * 0.5);
    for (let y = cell / 2; y <= dc.depth_mm; y += cell) for (let x = cell / 2; x <= dc.width_mm; x += cell) if (!occupied(x, y)) return { x, y };
    return { x: cell / 2, y: cell / 2 };
  }
  /** Câble « inter-DC » : ses deux bouts résolvent dans des salles différentes. */
  private isInterDc(c: any): boolean { const a = this.store.cableEndDcId(c, "A"), b = this.store.cableEndDcId(c, "B"); return !!(a && b && a !== b); }
  private cableLabelShort(c: any): string {
    if (c.name) return c.name;
    const pa: any = c.from_port_id ? this.store.get("ports", c.from_port_id) : null, pb: any = c.to_port_id ? this.store.get("ports", c.to_port_id) : null;
    return (pa ? (pa.name || "?") : "?") + " ↔ " + (pb ? (pb.name || "?") : "?");
  }
  /** Câbles candidats de la carte (dessinables dans la vue) : intra-salle des salles affichées
      + inter-DC (mono : sortants ; multi : un bout résolu dans une salle affichée). */
  private panelCables(dc: any): Array<{ cable: any }> {
    const dcIds = this.displayedDcIds(dc), seen = new Set<string>(), out: Array<{ cable: any }> = [];
    const add = (c: any) => { if (!seen.has(c.id)) { seen.add(c.id); out.push({ cable: c }); } };
    dcIds.forEach((id) => this.resolvedCables(id).forEach((rc) => add(rc.cable)));
    if (dcIds.length === 1) this.outgoingCableStubs(dcIds[0]).forEach((st) => add(st.cable));
    else { const dset = new Set(dcIds); this.store.all("cables").forEach((c: any) => { const da = this.store.cableEndDcId(c, "A"), db = this.store.cableEndDcId(c, "B"); if ((da && dset.has(da)) || (db && dset.has(db))) add(c); }); }
    return out;
  }
  private eqAllowed(c: any): boolean {
    if (!this._cableEqFilter) return true;
    const pa: any = this.store.get("ports", c.from_port_id), pb: any = this.store.get("ports", c.to_port_id);
    return (pa && pa.equipment_id === this._cableEqFilter) || (pb && pb.equipment_id === this._cableEqFilter);
  }
  private cableListFiltered(resolved: Array<{ cable: any }>): Array<{ rc: { cable: any }; label: string }> {
    const q = Text.normSearch(this._cableSearch);
    return resolved.map((rc) => ({ rc, label: this.cableLabelShort(rc.cable) }))
      .filter((o) => this.eqAllowed(o.rc.cable) && (!q || Text.normSearch(o.label).includes(q)))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
  private renderCableList(wrap: HTMLElement, resolved: Array<{ cable: any }>): void {
    wrap.innerHTML = "";
    this.cableListFiltered(resolved).slice(0, 200).forEach(({ rc, label }) => {
      const tog = FormControls.toggle(label, this.selCables.has(rc.cable.id), (v) => { if (v) this.selCables.add(rc.cable.id); else this.selCables.delete(rc.cable.id); this.render(); });
      tog.classList.add("tgl-row"); wrap.appendChild(tog);
    });
  }

  /** Panneau latéral : orchestrateur (cartes selon la vue). */
  renderSide(dc: any): void {
    const side = this.sideEl; if (!side) return;
    side.innerHTML = "";
    if (this.routeBuild) side.appendChild(this.routeCard());   // panneau de routage (toutes vues), en tête
    if (this.view === "floor") {   // plan d'étage : carte étage + panneau Waypoints (scope étage, toutes les salles)
      side.appendChild(this.collapsible(this.floorCard(), "floor"));
      const ft = this.floorTargetResolve(); const cur = this.current();
      if (ft) {
        const onFloor = (cur && (cur.location || "") === ft.location && String(cur.floor || "") === ft.floor) ? cur : null;
        side.appendChild(this.collapsible(this.waypointsCard(onFloor, ft), "waypoints"));
      }
      return;
    }
    if (!dc) { const h = document.createElement("div"); h.className = "dc-card"; h.innerHTML = '<div class="dc-card-title">Datacenter</div><div class="form-hint">Aucune salle. Créez-en une (onglet Datacenters → Salles) pour la visualiser.</div>'; side.appendChild(h); return; }
    if (this.view === "top") {
      side.appendChild(this.collapsible(this.selectionCard(dc), "sel"));
      side.appendChild(this.collapsible(this.poolRacksCard(dc), "pool"));
      side.appendChild(this.collapsible(this.poolFreeEquipCard(dc), "freepool"));
      side.appendChild(this.collapsible(this.waypointsCard(dc), "waypoints"));
      side.appendChild(this.collapsible(this.cableCard(dc), "cables"));
    } else {
      side.appendChild(this.collapsible(this.dcScopeCard(dc), "dcscope"));   // Datacenters affichés / Vue étage
      side.appendChild(this.collapsible(this.racks3dCard(dc), "rack3d"));
      side.appendChild(this.collapsible(this.cableCard(dc), "cables"));
      side.appendChild(this.collapsible(this.view3dOptionsCard(), "view3d"));
    }
  }

  /* ---- carte SÉLECTION (vue Dessus) : baie / équipement libre / waypoint, ou aide ---- */
  private selectionCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const wpSel: any = this.selWaypointId ? this.store.get("waypoints", this.selWaypointId) : null;
    const fe: any = this.selEquipId ? this.store.get("equipments", this.selEquipId) : null;
    const r: any = this.selRackId ? this.store.get("racks", this.selRackId) : null;
    const title = (txt: string) => { const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = txt; box.appendChild(t); };
    const acts = () => { const a = document.createElement("div"); a.className = "dc-card-acts"; return a; };
    if (wpSel && wpSel.datacenter_id === dc.id) {
      title(Waypoint.glyph(wpSel) + " " + (wpSel.name || "(waypoint)"));
      const a = acts();
      const bEdit = this.btn("Modifier", () => this.host.openWaypointForm?.(wpSel.id));
      const bDel = this.btn("Supprimer", async () => {
        const ok = await Dialog.confirm({ title: "Supprimer le waypoint", danger: true, message: `Supprimer « ${wpSel.name || "(waypoint)"} » ? Les câbles qui le traversent seront détachés (pas supprimés).` });
        if (!ok) return;
        await this.store.remove("waypoints", wpSel.id); this.selWaypointId = null; this.host.setDirty?.(true); Notify.toast("Waypoint supprimé");
      }); bDel.classList.add("danger");
      a.append(bEdit, bDel); box.appendChild(a);
    } else if (fe && fe.dim_mode === "free" && fe.dc_id === dc.id) {
      title(fe.name || "(équipement)");
      const a = acts();
      const bRot = this.btn("Pivoter 90°", async () => { await this.store.update("equipments", fe.id, { dc_orientation: Normalize.rackOrientation((fe.dc_orientation || 0) + 90) }); this.host.setDirty?.(true); });
      const bEdit = this.btn("Détails", () => this.host.openEquipmentDetail?.(fe.id));
      const bOut = this.btn("Retirer", async () => {
        const ops: Array<{ collection: string; id: string; patch: Record<string, any> }> = [{ collection: "equipments", id: fe.id, patch: { dc_id: null, dc_x: null, dc_y: null, dc_z: 0 } }];
        if (fe.dc_id) ops.push(...this.store.cableDowngradeOps([fe.id]));
        await this.store.updateBatch(ops);
        this.selEquipId = null; this.host.setDirty?.(true);
        if (ops.length > 1) Notify.toast("Câble(s) repassé(s) en « Planifié » (équipement plus en salle)");
      }); bOut.classList.add("danger");
      a.append(bRot, bEdit, bOut); box.appendChild(a);
    } else if (r && r.datacenter_id === dc.id) {
      title(r.name || "(baie)");
      const info = document.createElement("div"); info.className = "form-hint";
      info.textContent = (r.width_mm || RACK_WIDTH_DEFAULT) + " × " + (r.depth || RACK_DEPTH_DEFAULT) + " mm · " + r.u_count + " U · orientation " + Normalize.rackOrientation(r.orientation) + "°";
      box.appendChild(info);
      const a = acts();
      a.append(
        this.btn("Pivoter 90°", async () => { await this.store.update("racks", r.id, { orientation: Normalize.rackOrientation(r.orientation + 90) }); this.host.setDirty?.(true); }),
        this.btn("Modifier", () => this.host.openRackForm?.(r.id)),
      );
      const bOut = this.btn("Retirer", async () => {
        const eqIds = this.store.equipmentsOfRack(r.id).filter((e: any) => e.placement_mode === "rack" && e.rack_u != null).map((e: any) => e.id);
        const ops: Array<{ collection: string; id: string; patch: Record<string, any> }> = [{ collection: "racks", id: r.id, patch: { datacenter_id: null, dc_x: null, dc_y: null } }];
        if (r.datacenter_id) ops.push(...this.store.cableDowngradeOps(eqIds));
        await this.store.updateBatch(ops);
        this.selRackId = null; this.host.setDirty?.(true);
        if (ops.length > 1) Notify.toast("Câble(s) repassé(s) en « Planifié » (contenu plus en salle)");
      }); bOut.classList.add("danger"); a.appendChild(bOut);
      box.appendChild(a);
    } else {
      title("Sélection");
      const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Cliquez une baie pour la sélectionner ; glissez-la pour la déplacer (aimantation à la grille).";
      box.appendChild(h);
    }
    return box;
  }

  /* ---- carte RACKS DISPONIBLES (pool) — vue Dessus ---- */
  private poolRacksCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "Racks disponibles (pool)"; box.appendChild(t);
    const pool = this.poolRacks();
    if (!pool.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Aucun rack libre. Créez un rack (onglet Racks) ou retirez-en un d'une salle."; box.appendChild(h); return box; }
    const list = document.createElement("div"); list.className = "dc-pool";
    pool.forEach((rk: any) => {
      const row = document.createElement("div"); row.className = "dc-pool-row";
      const lab = document.createElement("span"); lab.className = "grow"; lab.textContent = (rk.name || "(rack)") + " · " + (rk.width_mm || RACK_WIDTH_DEFAULT) + "×" + (rk.depth || RACK_DEPTH_DEFAULT) + " · " + rk.u_count + "U";
      const b = this.btn("Placer", async () => {
        const why = this.store.rackPlacementBlockedReason(rk.id, dc.id);
        if (why) { Notify.toast("Placement impossible : " + why, "err"); return; }
        const pos = this.freeCell(dc); this.selRackId = rk.id;
        await this.store.update("racks", rk.id, { datacenter_id: dc.id, dc_x: pos.x, dc_y: pos.y }); this.host.setDirty?.(true);
      });
      row.append(lab, b); list.appendChild(row);
    });
    box.appendChild(list); return box;
  }

  /* ---- carte ÉQUIPEMENTS LIBRES (pool) — vue Dessus ---- */
  private poolFreeEquipCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "Équipements libres (pool)"; box.appendChild(t);
    const fpool = this.store.all("equipments").filter((e: any) => e.dim_mode === "free" && !e.dc_id && e.placement_mode !== "floor" && !e.inventory_only).sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    if (!fpool.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Aucun équipement « libre » non placé. Créez-en un (onglet Équipements, mode Libre)."; box.appendChild(h); return box; }
    const list = document.createElement("div"); list.className = "dc-pool";
    fpool.forEach((eq: any) => {
      const bx = FreeEquipGeometry.box(eq);
      const row = document.createElement("div"); row.className = "dc-pool-row";
      const lab = document.createElement("span"); lab.className = "grow"; lab.textContent = (eq.name || "(équipement)") + " · " + bx.w + "×" + bx.d + "×" + bx.h + " mm";
      const b = this.btn("Placer", async () => {
        const why = this.store.equipmentPlacementBlockedReason(eq.id, dc.id);
        if (why) { Notify.toast("Placement impossible : " + why, "err"); return; }
        const pos = this.freeCell(dc); this.selRackId = null; this.selEquipId = eq.id;
        await this.store.update("equipments", eq.id, { dc_id: dc.id, dc_x: pos.x, dc_y: pos.y, dc_z: eq.dc_z || 0 }); this.host.setDirty?.(true);
      });
      row.append(lab, b); list.appendChild(row);
    });
    box.appendChild(list); return box;
  }

  /** Ouvre le form d'étage (création `pick` ou édition) avec navigation vers le plan créé. */
  private editFloor(location: string, floor: string, pick: boolean): void {
    this.host.openFloorForm?.(location, floor, { pick, onPicked: (L: string, F: string) => { this.floorTarget = { location: L, floor: F }; this.view = "floor"; this.scale = null; this.buildToolbar(); this.render(); } });
  }
  /* ---- carte PLAN D'ÉTAGE (vue Étage) : sélecteur bâtiment/étage + salles de l'étage + OOB ---- */
  private floorCard(): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "Plan d'étage"; box.appendChild(t);
    const ft = this.floorTargetResolve();
    if (!ft) {
      const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Aucun étage connu. Créez-en un pour afficher son plan."; box.appendChild(h);
      box.appendChild(this.btn("+ Créer un étage…", () => this.editFloor("", "", true)));
      return box;
    }
    // sélecteur d'étage (tous les couples bâtiment × étage connus)
    const keys = this.floor.allFloorKeys();
    const key = (k: { location: string; floor: string }) => (k.location || "") + "" + (k.floor || "");
    const sel = FormControls.select(keys.map((k) => ({ value: key(k), label: FloorLayout.locationLabel(k.location) + " · ét. " + (k.floor || "0") })), key(ft));
    sel.onchange = () => { const p = sel.value.split(""); this.floorTarget = { location: p[0], floor: p[1] || "" }; this.scale = null; this.render(); };
    box.appendChild(FormControls.fieldRow("Bâtiment · étage", sel));
    // salles de cet étage (clic = activer ; bouton = éditer)
    const dcs = this.store.dcsOfFloor(ft.location, ft.floor).sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    const rt = document.createElement("div"); rt.className = "dc-card-title"; rt.style.marginTop = "8px"; rt.textContent = "Salles (" + dcs.length + ")"; box.appendChild(rt);
    if (!dcs.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Aucune salle sur cet étage. Posez-en une (onglet Datacenters → Salles · bâtiment/étage)."; box.appendChild(h); }
    else {
      const list = document.createElement("div"); list.className = "dc-layers";
      dcs.forEach((d: any) => {
        const row = document.createElement("div"); row.className = "dc-layer-row";
        const nm = this.btn((d.name || "(salle)") + (d.id === this.dcId ? "  ◀ active" : ""), () => { this.selRoomId = d.id; this.dcId = d.id; this.render(); });
        nm.style.cssText = "flex:1 1 auto;text-align:left;justify-content:flex-start"; nm.classList.toggle("active", this.selRoomId === d.id);
        row.append(nm, this.btn("Modifier", () => this.host.openDatacenterForm?.(d.id)));
        list.appendChild(row);
      });
      box.appendChild(list);
    }
    // (OOB : listés dans le panneau « Waypoints » ci-dessous — pas de doublon ici)
    // équipements posés sur cet étage (clic = cibler/sélectionner ; bouton = fiche)
    const feqs = this.store.floorEquipments().filter((e: any) => (e.location || "") === ft.location && String(e.floor || "") === ft.floor).sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    const et = document.createElement("div"); et.className = "dc-card-title"; et.style.marginTop = "8px"; et.textContent = "Équipements de l'étage (" + feqs.length + ")"; box.appendChild(et);
    if (!feqs.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Aucun équipement posé sur cet étage (mode « Étage » du formulaire d'équipement)."; box.appendChild(h); }
    else {
      const list = document.createElement("div"); list.className = "dc-layers";
      feqs.forEach((eq: any) => {
        const row = document.createElement("div"); row.className = "dc-layer-row";
        const nm = this.btn((eq.name || "(équipement)") + (FloorLayout.floorEquipLocalized(eq) ? "" : " (auto)"), () => { this.selFloorEquip = eq.id; this.render(); });
        nm.style.cssText = "flex:1 1 auto;text-align:left;justify-content:flex-start"; nm.classList.toggle("active", this.selFloorEquip === eq.id);
        row.append(nm, this.btn("ⓘ", () => this.host.openEquipmentDetail?.(eq.id)));
        list.appendChild(row);
      });
      box.appendChild(list);
    }
    const acts = document.createElement("div"); acts.className = "dc-card-acts"; acts.style.marginTop = "8px";
    acts.append(
      this.btn("Éditer le plan…", () => this.editFloor(ft.location, ft.floor, false)),
      this.btn("+ Créer un étage…", () => this.editFloor(ft.location, ft.floor, true)),
    );
    box.appendChild(acts);
    const acfg = this.floor.config(ft.location, ft.floor);
    box.appendChild(FormControls.toggle("⚓ Afficher le point d'ancrage · " + Format.meters(acfg.anchor_x || 0) + " ; " + Format.meters(acfg.anchor_y || 0), this.showFloorAnchor, (v) => { this.showFloorAnchor = v; this.render(); }));
    box.appendChild(this.btn("Recadrer le plan", () => { this.scale = null; this.render(); }));
    return box;
  }

  /* ---- carte WAYPOINTS (passage de câbles) — GÉNÉRIQUE (plan de salle OU plan d'étage), types séparés en sections.
       `dc` = salle active (création in-situ + scope mono-salle) ; `floor` = scope étage (toutes les salles de l'étage). ---- */
  private waypointsCard(dc: any, floor?: { location: string; floor: string }): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "Waypoints (passage de câbles)"; box.appendChild(t);
    const kindLbl = (k: string) => k === "segment" ? "Chemin" : k === "brush" ? "Brosse" : "Pin";
    // ---- création (pins/chemins/exits dans la salle active si présente ; OOB toujours) ----
    const addActs = document.createElement("div"); addActs.className = "dc-card-acts";
    const mkAdd = (label: string, kind: string, wpType?: string) => this.btn(label, async () => {
      const pos = this.freeCell(dc), cellW = dc.cell_mm || 600;
      const props: any = { name: (wpType === "exit" ? "EXIT-" : "WP-") + (this.store.all("waypoints").length + 1), kind, wp_type: wpType || "datacenter", datacenter_id: dc.id, dc_x: pos.x, dc_y: pos.y };
      if (kind === "segment") { props.dc_x = Math.max(0, pos.x - cellW); props.dc_y = pos.y; props.dc_x2 = Math.min(dc.width_mm, pos.x + cellW); props.dc_y2 = pos.y; }
      const wp = await this.store.create("waypoints", props);
      this.selWaypointId = wp.id; this.setDirty();
      Notify.toast(wpType === "exit" ? "Exit créé — un câble sort par une PAIRE d'exits (salles différentes)" : (kind === "segment" ? "Chemin de câbles créé" : "Pin créé"));
    });
    if (dc) addActs.append(mkAdd("+ Pin", "point"), mkAdd("+ Chemin", "segment"), mkAdd("+ Exit", "point", "exit"));
    addActs.appendChild(this.btn("+ Pin d'étage", async () => {   // ex-OOB : pin hors salle rattaché à un bâtiment/étage
      const loc = floor ? floor.location : (dc ? (dc.location || "") : ""), fl = floor ? floor.floor : (dc ? String(dc.floor || "") : "");
      const wp: any = await this.store.create("waypoints", { name: "PIN-" + (this.store.all("waypoints").length + 1), kind: "point", location: loc, floor: fl });
      this.selWaypointId = wp.id; this.setDirty(); Notify.toast("Pin d'étage créé — glissez-le sur le plan d'étage, éditez sa hauteur");
    }));
    box.appendChild(addActs);
    const hint = document.createElement("div"); hint.className = "form-hint";
    hint.textContent = dc ? "Astuce : clic droit sur le sol pour créer un waypoint à l'endroit visé. ⏏ exits par paires (salles différentes) · ◎ pin d'étage entre deux exits."
      : "Sélectionnez une salle de l'étage (liste ci-dessus) pour y créer des pins/chemins. ◎ pin d'étage : hors salles, entre deux exits.";
    box.appendChild(hint);
    // ---- scope des waypoints POSÉS : salle active, ou toutes les salles de l'étage ----
    const scopeIds = floor ? this.store.dcsOfFloor(floor.location, floor.floor).map((d: any) => d.id) : (dc ? [dc.id] : []);
    const multiRoom = scopeIds.length > 1;
    const placed = this.store.all("waypoints").filter((w: any) => w.datacenter_id && scopeIds.includes(w.datacenter_id) && this.store.waypointIsPlaced(w) && !Waypoint.isFloorLevel(w));
    // ---- section par TYPE (réplique de la séparation par sections du form équipement) ----
    const section = (title: string, items: any[], action: (wp: any) => HTMLElement) => {
      if (!items.length) return;
      const st = document.createElement("div"); st.className = "dc-card-title"; st.style.marginTop = "8px"; st.textContent = title + " (" + items.length + ")"; box.appendChild(st);
      const list = document.createElement("div"); list.className = "dc-pool";
      items.sort((a, b) => (a.name || "").localeCompare(b.name || "")).forEach((wp) => {
        const row = document.createElement("div"); row.className = "dc-pool-row";
        const n = this.store.cablesOfWaypoint(wp.id).length, room = multiRoom ? " · " + this.store.dcName(wp.datacenter_id) : "";
        const lab = document.createElement("span"); lab.className = "grow"; lab.textContent = Waypoint.glyph(wp) + " " + (wp.name || "(waypoint)") + room + " · " + n + " câble" + (n > 1 ? "s" : "");
        row.append(lab, action(wp)); list.appendChild(row);
      });
      box.appendChild(list);
    };
    const edit = (wp: any) => this.btn("Éditer", () => this.host.openWaypointForm?.(wp.id));
    section("◆ Pins", placed.filter((w: any) => w.kind === "point" && Waypoint.typeOf(w) !== "exit"), edit);
    section("▬ Chemins de câbles", placed.filter((w: any) => w.kind === "segment" && Waypoint.typeOf(w) !== "exit"), edit);
    section("▦ Brosses de brassage", placed.filter((w: any) => w.kind === "brush"), edit);
    section("⏏ Exits (sortie de salle)", placed.filter((w: any) => Waypoint.typeOf(w) === "exit"), edit);
    // ---- pool du bâtiment (à poser dans la salle active) ----
    const wpool = dc ? this.store.waypointsOfDc(null).filter((w: any) => !Waypoint.isFloorLevel(w)) : [];
    section("⏳ Pool du bâtiment (à poser)", wpool, (wp: any) => this.btn("Placer", async () => {
      const pos = this.freeCell(dc), cellW = dc.cell_mm || 600, patch: any = { datacenter_id: dc.id, dc_x: pos.x, dc_y: pos.y };
      if (wp.kind === "segment") { patch.dc_x = Math.max(0, pos.x - cellW); patch.dc_x2 = Math.min(dc.width_mm, pos.x + cellW); patch.dc_y2 = pos.y; }
      this.selWaypointId = wp.id; await this.store.update("waypoints", wp.id, patch); this.setDirty();
    }));
    // ---- OOB (étage courant si scope étage, sinon tout le bâtiment) ----
    const oobs = this.store.oobWaypoints().filter((w: any) => !floor || ((w.location || "") === floor.location && String(w.floor || "") === floor.floor))
      .sort((a: any, b: any) => (FloorLayout.floorNum(a.floor) - FloorLayout.floorNum(b.floor)) || (a.name || "").localeCompare(b.name || ""));
    if (oobs.length) {
      const st = document.createElement("div"); st.className = "dc-card-title"; st.style.marginTop = "8px"; st.textContent = "◎ Pins d'étage — hors salles (" + oobs.length + ")"; box.appendChild(st);
      const list = document.createElement("div"); list.className = "dc-pool";
      oobs.forEach((wp: any) => {
        const row = document.createElement("div"); row.className = "dc-pool-row";
        const n = this.store.cablesOfWaypoint(wp.id).length;
        const lab = document.createElement("span"); lab.className = "grow"; lab.textContent = Waypoint.glyph(wp) + " " + (wp.name || "(waypoint)") + " · " + Waypoint.floorLabel(wp) + " · " + n + " câble" + (n > 1 ? "s" : "");
        row.append(lab, edit(wp)); list.appendChild(row);
      });
      box.appendChild(list);
    }
    return box;
  }

  /* ---- carte DATACENTERS (portée d'affichage / Vue étage) — vue 3D ---- */
  private dcScopeCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "Datacenters"; box.appendChild(t);
    const refit = () => { this.camTarget = null; this.scale = null; this.buildToolbar(); this.renderSide(this.current()); this.renderThreeD(this.current()); };
    const all = this.store.all("datacenters");
    const curLoc = dc ? (dc.location || "") : "";
    const bldgIds = (loc: string) => all.filter((d: any) => (d.location || "") === loc).map((d: any) => d.id);
    const selRow = document.createElement("div"); selRow.className = "form-hint"; selRow.style.cssText = "margin-bottom:6px"; selRow.innerHTML = "Salle active : <b>" + Html.escape(dc.name || "(salle)") + "</b>"; box.appendChild(selRow);
    // bascule maître : Vue étage (empilement 3D de plusieurs salles)
    if (all.length) {
      box.appendChild(FormControls.toggle("Vue étage", this.multiDc, (v) => {
        this.multiDc = v;
        if (v) { if (!this.visibleDcIds.size) { const b = bldgIds(curLoc); this.visibleDcIds = new Set(b.length ? b : all.map((d: any) => d.id)); } }
        refit();
      }, { block: true, title: "Empile plusieurs salles / étages en 3D (bâtiments côte à côte). Désactivé : une seule salle active." }));
    }
    // préréglages de portée (actifs en Vue étage)
    const displayed = new Set(this.displayedDcIds(dc));
    const sameSet = (arr: string[]) => displayed.size === arr.length && arr.every((id) => displayed.has(id));
    const acts = document.createElement("div"); acts.className = "dc-card-acts";
    const scopeBtn = (icon: string, titleTxt: string, active: boolean, onClick: () => void) => {
      const b = document.createElement("button"); b.type = "button";
      b.className = "btn btn-ghost btn-sm dc-scope-btn" + (active && this.multiDc ? " active" : "");
      b.title = this.multiDc ? titleTxt : (titleTxt + " — disponible en Vue étage"); b.disabled = !this.multiDc;
      b.innerHTML = icon; if (this.multiDc) b.onclick = onClick; return b;
    };
    acts.appendChild(scopeBtn(DC_SCOPE_ICONS.self, "Salle active seule", sameSet([dc.id]), () => { this.visibleDcIds = new Set([dc.id]); refit(); }));
    acts.appendChild(scopeBtn(DC_SCOPE_ICONS.bldg, "Tout le bâtiment", sameSet(bldgIds(curLoc)), () => { this.visibleDcIds = new Set(bldgIds(curLoc)); refit(); }));
    acts.appendChild(scopeBtn(DC_SCOPE_ICONS.all, "Tous les sites", sameSet(all.map((d: any) => d.id)), () => { this.visibleDcIds = new Set(all.map((d: any) => d.id)); refit(); }));
    box.appendChild(acts);
    // liste groupée par bâtiment puis étage (mono = sélection radio ; Vue étage = multi-sélection)
    const locs = Array.from(new Set(all.map((d: any) => d.location || "")))
      .sort((a, b) => (a === curLoc ? -1 : b === curLoc ? 1 : FloorLayout.locationLabel(a).localeCompare(FloorLayout.locationLabel(b))));
    locs.forEach((loc) => {
      const inLoc = all.filter((d: any) => (d.location || "") === loc).sort((a: any, b: any) => FloorLayout.floorNum(a.floor) - FloorLayout.floorNum(b.floor) || (a.name || "").localeCompare(b.name || ""));
      if (!inLoc.length) return;
      const h = document.createElement("div"); h.className = "dc-card-title"; h.style.marginTop = "8px"; h.textContent = FloorLayout.locationLabel(loc) + (loc === curLoc ? " (actif)" : ""); box.appendChild(h);
      const list = document.createElement("div"); list.className = "dc-layers";
      inLoc.forEach((d: any) => {
        const isCur = d.id === dc.id;
        let tog: HTMLElement;
        if (this.multiDc) {
          tog = FormControls.toggle((d.name || "(salle)") + (isCur ? "  ◀ active" : ""), displayed.has(d.id), (v) => { if (v) this.visibleDcIds.add(d.id); else this.visibleDcIds.delete(d.id); refit(); }, { disabled: isCur });
        } else {
          tog = FormControls.toggle((d.name || "(salle)") + (isCur ? "  ◀ active" : ""), isCur, () => { if (isCur) return; this.dcId = d.id; this.selRackId = null; refit(); }, { disabled: isCur });
        }
        tog.classList.add("tgl-row"); list.appendChild(tog);
      });
      box.appendChild(list);
    });
    return box;
  }

  /* ---- carte RACKS (visibilité / estomper / isoler — globale sur les salles affichées) — vue 3D ---- */
  private racks3dCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "Racks"; box.appendChild(t);
    const racks = this.displayedDcIds(dc).flatMap((id) => this.store.racksOfDc(id))
      .sort((a: any, b: any) => (a.datacenter_id !== b.datacenter_id ? this.store.dcName(a.datacenter_id).localeCompare(this.store.dcName(b.datacenter_id)) : 0) || (a.name || "").localeCompare(b.name || ""));
    if (!racks.length) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Aucun rack dans cette salle."; box.appendChild(h); return box; }
    const quick = document.createElement("div"); quick.className = "dc-card-acts";
    quick.append(
      this.btn("Tout afficher", () => { this.hidden3dRacks.clear(); this.render(); }),
      this.btn("Tout masquer", () => { this.hidden3dRacks = new Set(racks.map((r: any) => r.id)); this.render(); }),
    );
    box.appendChild(quick);
    const list = document.createElement("div"); list.className = "dc-layers";
    racks.forEach((r: any) => {
      const row = document.createElement("div"); row.className = "dc-rack-row";
      const tog = FormControls.toggle(r.name || "(rack)", !this.hidden3dRacks.has(r.id), (v) => { if (v) this.hidden3dRacks.delete(r.id); else this.hidden3dRacks.add(r.id); this.renderThreeD(this.current()); });
      tog.classList.add("tgl-row");
      const bFade = this.btn("◐", () => { if (this.fadedRacks.has(r.id)) this.fadedRacks.delete(r.id); else this.fadedRacks.add(r.id); bFade.classList.toggle("active", this.fadedRacks.has(r.id)); this.renderThreeD(this.current()); }, "Estomper (translucide)");
      bFade.classList.toggle("active", this.fadedRacks.has(r.id));
      const bIso = this.btn("Isoler", () => this.isolateRack(r.id), "N'afficher que ce rack et le cibler");
      row.append(tog, bFade, bIso); list.appendChild(row);
    });
    box.appendChild(list); return box;
  }

  /* ---- carte CÂBLES (sélection par réseau / inter-DC / liste filtrée) — 3D & Dessus ---- */
  private cableCard(dc: any): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const multi = this.displayedDcIds(dc).length > 1;
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "Câbles" + (multi ? " (toutes salles affichées)" : ""); box.appendChild(t);
    const resolved = this.panelCables(dc);
    const total = this.store.all("cables").length;
    // créer une route 3D au clic (le prochain clic sur un port libre démarre ; puis waypoints ; puis port terminal)
    const bRoute = this.btn(this.routeBuild ? "✕ Annuler la route" : "🧵 Créer une route", () => { if (this.routeBuild) this.routeCancel(); else this.routeArm(); }, "Tracer un câble en cliquant les ports + waypoints");
    bRoute.style.marginBottom = "6px"; box.appendChild(bRoute);
    box.appendChild(FormControls.toggle("Tout afficher (estompé)", this.showAllCables, (v) => { this.showAllCables = v; this.render(); }, { block: true }));
    const hint = document.createElement("div"); hint.className = "form-hint";
    hint.textContent = resolved.length + " câble(s) " + (multi ? "sur les salles affichées" : "raccordable(s) ici") + (total > resolved.length ? " · " + (total - resolved.length) + " hors champ" : "") + ". L'affichage suit la sélection (cases / clic) ; « Tout afficher » montre tout, estompé.";
    box.appendChild(hint);
    if (!resolved.length) return box;
    const addSel = (ids: string[]) => { ids.forEach((id) => this.selCables.add(id)); this.render(); };
    const delSel = (ids: string[]) => { ids.forEach((id) => this.selCables.delete(id)); this.render(); };
    const eyePair = (parent: HTMLElement, ids: () => string[], what: string) => {
      parent.append(
        this.btn("◉", () => addSel(ids()), "Sélectionner (afficher) " + what),
        this.btn("◎", () => delSel(ids()), "Désélectionner (masquer) " + what),
      );
    };
    // liens inter-DC
    const interIds = () => resolved.filter((o) => this.isInterDc(o.cable)).map((o) => o.cable.id);
    if (interIds().length) {
      const row = document.createElement("div"); row.className = "dc-layer-row";
      const itx = document.createElement("span"); itx.className = "grow"; itx.textContent = "Liens inter-DC · " + interIds().length;
      row.append(itx); eyePair(row, interIds, "les liens inter-DC"); box.appendChild(row);
    }
    // réseaux
    const netsMap = new Map<string, { label: string; color: string | null; count: number }>();
    resolved.forEach((rc) => { const ids = this.store.cableNetworkIds(rc.cable); (ids.length ? ids : ["__none__"]).forEach((key: string) => { if (!netsMap.has(key)) { const n: any = key !== "__none__" ? this.store.get("networks", key) : null; netsMap.set(key, { label: n ? (n.label || "(réseau)") : "Autre", color: n ? n.color : null, count: 0 }); } netsMap.get(key)!.count++; }); });
    if (netsMap.size) {
      const nt = document.createElement("div"); nt.className = "form-hint"; nt.style.marginTop = "6px"; nt.textContent = "Réseaux (◉ sélectionner · ◎ retirer) :"; box.appendChild(nt);
      const netList = document.createElement("div"); netList.className = "dc-layers";
      [...netsMap.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label)).forEach(([key, info]) => {
        const idsOf = () => resolved.filter((rc) => { const ks = this.store.cableNetworkIds(rc.cable); return (ks.length ? ks : ["__none__"]).includes(key); }).map((rc) => rc.cable.id);
        const row = document.createElement("div"); row.className = "dc-layer-row";
        const sw = document.createElement("span"); sw.className = "dc-net-sw"; sw.style.background = info.color || "var(--fg-dim)";
        const txt = document.createElement("span"); txt.className = "grow"; txt.textContent = info.label + " · " + info.count;
        row.append(sw, txt); eyePair(row, idsOf, "« " + info.label + " »"); netList.appendChild(row);
      });
      box.appendChild(netList);
    }
    // filtres de liste (équipement + texte) — aident à sélectionner, n'affectent pas l'affichage
    const eqIds = new Set<string>();
    resolved.forEach((rc) => { const pa: any = this.store.get("ports", rc.cable.from_port_id), pb: any = this.store.get("ports", rc.cable.to_port_id); if (pa) eqIds.add(pa.equipment_id); if (pb) eqIds.add(pb.equipment_id); });
    const eqOpts = [...eqIds].map((id) => this.store.get("equipments", id)).filter(Boolean).sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    if (this._cableEqFilter && !eqIds.has(this._cableEqFilter)) this._cableEqFilter = "";
    const eqSel = FormControls.select([{ value: "", label: "— tous les équipements —" }].concat(eqOpts.map((e: any) => ({ value: e.id, label: (e.name || "(sans nom)") + (multi ? " · " + this.store.dcName(this.store.equipmentDcId(e)) : "") }))), this._cableEqFilter);
    eqSel.style.cssText = "width:100%;margin-top:8px;font-size:11px"; eqSel.onchange = () => { this._cableEqFilter = eqSel.value; this.render(); };
    box.appendChild(eqSel);
    const search = document.createElement("input"); search.type = "text"; search.className = "search-input"; search.placeholder = "Filtrer la liste…"; search.style.cssText = "width:100%;margin:6px 0"; search.value = this._cableSearch;
    search.oninput = () => { this._cableSearch = search.value; this.renderCableList(listWrap, resolved); };
    box.appendChild(search);
    const listActs = document.createElement("div"); listActs.className = "dc-card-acts";
    listActs.append(
      this.btn("Sélectionner la liste", () => addSel(this.cableListFiltered(resolved).map((o) => o.rc.cable.id))),
      this.btn("Retirer la liste", () => delSel(this.cableListFiltered(resolved).map((o) => o.rc.cable.id))),
    );
    box.appendChild(listActs);
    if (this.selCables.size) box.appendChild(this.btn("Effacer la sélection (" + this.selCables.size + ")", () => { this.selCables.clear(); this.render(); }));
    const listWrap = document.createElement("div"); listWrap.className = "dc-layers"; box.appendChild(listWrap);
    this.renderCableList(listWrap, resolved);
    return box;
  }

  /* ---- carte VUE 3D (options d'affichage) ---- */
  private view3dOptionsCard(): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "Vue 3D";
    // icône d'aide (navigation 3D) — n'est pas un toggle de repli (collapsible() ignore les clics sur .dc-help)
    const help = document.createElement("span"); help.className = "settings-help-icon dc-help"; help.textContent = "?";
    help.setAttribute("role", "img"); help.tabIndex = 0; help.setAttribute("aria-label", "Aide : navigation 3D");
    help.title = "Glisser GAUCHE = déplacer le modèle · glisser DROIT (ou Maj+glisser) = orbiter (depuis n'importe où) · molette = zoom (vers la souris).\nSurvolez une baie pour son détail, cliquez-la pour l'éditer.\nEn multi-salles : clic GAUCHE sur le SOL d'une salle = l'activer · clic DROIT = menu.\nPoints de vue : boutons Dessus/Face/Arrière/Côté/3D près du recentrage.";
    t.appendChild(help); box.appendChild(t);
    const r3 = () => this.renderThreeD(this.current());
    const redraw = () => { const d = this.current(); if (!d) return; if (this.view === "top") this.renderTop(d); else this.renderThreeD(d); };
    const tgrid = document.createElement("div"); tgrid.className = "dc-3d-toggle-grid";
    const tg = (label: string, get: () => boolean, set: (v: boolean) => void, full?: boolean, title?: string) => tgrid.appendChild(FormControls.toggle(label, get(), (v) => { set(v); full ? this.render() : r3(); }, { block: true, title }));
    tg("Masquer équip. avant", () => this.hideFrontEq, (v) => { this.hideFrontEq = v; });
    tg("Masquer équip. arrière", () => this.hideRearEq, (v) => { this.hideRearEq = v; });
    tg("Noms des équipements", () => this.showEqNames, (v) => { this.showEqNames = v; });
    tg("Ports", () => this.showPorts, (v) => { this.showPorts = v; }, true);
    tg("Images de façade", () => this.showFaceImages, (v) => { this.showFaceImages = v; });
    tg("Capots des baies", () => this.showRackSides, (v) => { this.showRackSides = v; });
    tg("Portes des baies", () => this.showDoors, (v) => { this.showDoors = v; });
    tg("Emplacements libres", () => this.showPlaceholders, (v) => { this.showPlaceholders = v; });
    tg("Grilles d'étage", () => this.showFloorGrid, (v) => { this.showFloorGrid = v; });
    tg("Marqueurs", () => this.showWaypoints, (v) => { this.showWaypoints = v; }, true, "Affiche/masque les MARQUEURS de waypoint (pins, losanges aux extrémités des chemins/brosses, OOB). N'affecte pas le routage des câbles.");
    tg("Brosses et passe-câbles", () => this.showConduits, (v) => { this.showConduits = v; }, true, "Affiche/masque la GÉOMÉTRIE des conduits : bacs des chemins de câbles (passe-câbles) et coques des brosses de brassage.");
    tg("Centre de rotation", () => this.showPivot, (v) => { this.showPivot = v; });
    tg("Repères d'orientation", () => this.showOrientMarks, (v) => { this.showOrientMarks = v; });
    // sortie ⊥ des ports (stub de 20 mm le long de la normale) — affecte le tracé 3D ET Dessus
    tgrid.appendChild(FormControls.toggle("Sortie ⊥ des ports (20 mm)", this.cablePortNormal, (v) => { this.cablePortNormal = v; redraw(); }, { block: true, title: "Les câbles quittent leurs ports perpendiculairement à la face sur 20 mm, puis rejoignent le tracé comme via un waypoint." }));
    // aperçu de route jusqu'à la souris (re-rendu throttlé) — désactiver si souci de perf
    tgrid.appendChild(FormControls.toggle("Aperçu de route → souris", this.routePreviewToMouse, (v) => { this.routePreviewToMouse = v; if (!v && this.routeBuild) this.routeBuild.mouse = null; r3(); }, { block: true, title: "Pendant la création d'une route, prolonge l'aperçu jusqu'au curseur. Désactivez en cas de souci de performance." }));
    box.appendChild(tgrid);
    // coloration des équipements
    const colorRow = document.createElement("div"); colorRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px";
    const colTxt = document.createElement("span"); colTxt.className = "grow"; colTxt.textContent = "Coloration";
    const colSel = FormControls.select([{ value: "face", label: "Par face" }, { value: "group", label: "Par groupe" }, { value: "type", label: "Par type" }], this.colorMode);
    colSel.onchange = () => { this.colorMode = colSel.value as any; r3(); };
    colorRow.append(colTxt, colSel); box.appendChild(colorRow);
    // arrondi des câbles (slider)
    box.appendChild(this.slider("Arrondi des câbles", this.cableSplineK, 0, 0.32, 0.01, (v) => v.toFixed(2), (v) => { this.cableSplineK = v; redraw(); }));
    // taille des marqueurs de waypoint + connecteurs de port (1 = défaut = milieu du range)
    box.appendChild(this.slider("Taille marqueurs / ports", this.markerScale, 0.25, 1.75, 0.05, (v) => Math.round(v * 100) + " %", (v) => { this.markerScale = v; redraw(); }));
    // culling de distance (slider)
    box.appendChild(this.slider("Masquer ports/U au-delà", this.cullDistanceM, 1, 60, 1, (v) => Math.round(v) + " m", (v) => { this.cullDistanceM = Math.max(1, Math.min(60, Math.round(v))); }, () => r3()));
    box.appendChild(this.btn("Recentrer sur la salle", () => { this.camTarget = null; this.hidden3dRacks.clear(); this.fadedRacks.clear(); this.scale = null; this.render(); }));
    return box;
  }
  /** Curseur étiqueté générique (oninput = aperçu live ; onchange optionnel). */
  private slider(label: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string, onInput: (v: number) => void, onChange?: () => void): HTMLElement {
    const row = document.createElement("div"); row.style.cssText = "margin-top:6px;font-size:12px";
    const top = document.createElement("div"); top.style.cssText = "display:flex;align-items:center;gap:8px";
    const tx = document.createElement("span"); tx.className = "grow"; tx.textContent = label;
    const val = document.createElement("span"); val.style.cssText = "font-family:var(--mono);color:var(--accent)"; val.textContent = fmt(value);
    top.append(tx, val); row.appendChild(top);
    const inp = document.createElement("input"); inp.type = "range"; inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(value); inp.style.cssText = "width:100%;accent-color:var(--accent);cursor:pointer;margin-top:4px";
    inp.oninput = () => { const v = parseFloat(inp.value) || 0; val.textContent = fmt(v); onInput(v); };
    if (onChange) inp.onchange = onChange;
    row.appendChild(inp); return row;
  }
  /** Largeur de vue visible (m) — proxy de distance caméra en ortho. Estime le « fit » si scale non encore posé. */
  private camViewWidthM(dc: any): number {
    let sc = this.scale;
    if (sc == null) {
      const b = this.sceneBounds(dc), bw = Math.max(1, b.maxH - b.minH), bh = Math.max(1, b.maxV - b.minV);
      const SW = this.stage.clientWidth || 900, SH = this.stage.clientHeight || 560, pad = 40;
      sc = Math.max(0.02, Math.min(6, Math.min((SW - pad * 2) / bw, (SH - pad * 2) / bh)));
    }
    return ((this.stage.clientWidth || 900) / sc) / 1000;
  }
  renderThreeD(dc: any): void {
    this.persistView();   // capture l'état complet de la vue (débouncé)
    this.floorXf = null;   // pas de rotation de vue en 3D (réservée aux vues 2D Dessus/Étage)
    // disposition multi-salles (étages empilés / bâtiments côte à côte) — sinon mono-salle (null)
    this._multi = this.multiDc ? this.floor.multiLayout(this.current(), { visibleDcIds: this.visibleDcIds }) : null;
    this._farCull = this.cullDistanceM > 0 && this.camViewWidthM(dc) > this.cullDistanceM;   // culling de distance (perf)
    const gRoot = this.newScene(dc);
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
  private room3D(dc: any, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[], skipCables?: Set<string>): void {
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
  private buildWorldVia(steps: any[], roomById: Map<string, RoomPlacement>, m: MultiLayout, aw: Vec3, bw: Vec3, cableId: string): Array<{ p: Vec3; wp: any; oob?: boolean }> {
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
  private interDcRoutes(m: MultiLayout): Array<{ cable: any; a: any; b: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
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
  private interDc3D(inter: Array<{ cable: any; a: any; b: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }>, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[]): void {
    inter.forEach((rc) => {
      if (!this.cableShown(rc)) return;
      if (this.hidden3dRacks.has(rc.a.rackId) || this.hidden3dRacks.has(rc.b.rackId)) return;
      this.emitCable3D({ cable: rc.cable, pts: rc.pts, linePts: rc.linePts, straight: rc.straight, stubAt: rc.stubAt }, proj, drawables);
    });
  }

  /* ---- décor multi-salles (plans d'étage · OOB · étiquettes étage/bâtiment) ---- */

  /** Plans de grille d'étage en 3D (un par étage affiché de chaque bâtiment) + cases inaccessibles. */
  private floorPlanes3D(m: MultiLayout, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[], lvlBias: (lv: number) => number): void {
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
  private floorOobs3D(m: MultiLayout, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[], lvlBias: (lv: number) => number): void {
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
  private multiDecor3D(m: MultiLayout, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[]): void {
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
  private floorEquip3D(m: MultiLayout, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[], lvlBias: (lv: number) => number): void {
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
  private isFloorPort(pid: string): boolean { const p: any = pid ? this.store.get("ports", pid) : null; const e: any = p ? this.store.get("equipments", p.equipment_id) : null; return !!(e && e.placement_mode === "floor"); }
  /** Résout un bout de câble en point MONDE pour la 3D multi : équipement d'étage (boîte au monde) OU port en salle. */
  private resolveFloorCableEnd(m: MultiLayout, roomById: Map<string, RoomPlacement>, shown: Set<string>, pid: string): any {
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
  private floorEquipCables3D(m: MultiLayout, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[]): void {
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
  private rackBox3D(r: any, proj: (p: Vec3) => { h: number; v: number; depth: number }): Drawable {
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
  private rackInterior3D(r: any, toW: (lx: number, ly: number, lz: number) => Vec3, proj: (p: Vec3) => { h: number; v: number; depth: number }, faceNear: (lc: number[], n: number[]) => boolean, NRM: Record<string, number[]>): Drawable[] {
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
  private painterTopoSort(units: any[], grad: [number, number, number], toW: (lx: number, ly: number, lz: number) => Vec3, proj: (p: Vec3) => { h: number; v: number; depth: number }): void {
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
  private equipBox3D(e: any, proj: (p: Vec3) => { h: number; v: number; depth: number }): Drawable {
    const bx = FreeEquipGeometry.box(e);
    return this.freeEquipBoxAt(e, (e.dc_x != null) ? e.dc_x : bx.w / 2, (e.dc_y != null) ? e.dc_y : bx.d / 2, bx.z, proj);
  }
  /** Image de façade plaquée : unité 1×1 étirée sur 3 coins MONDE (TL, TR, BL) via une matrice affine. */
  private faceImageNode(TL: Vec3, TR: Vec3, BL: Vec3, href: string, proj: (p: Vec3) => { h: number; v: number; depth: number }): SVGElement {
    const pTL = proj(TL), pTR = proj(TR), pBL = proj(BL);
    const a = pTR.h - pTL.h, b = pTR.v - pTL.v, c = pBL.h - pTL.h, d = pBL.v - pTL.v;
    const g = Dom.svg("g", { class: "dc-face-img", transform: `matrix(${a} ${b} ${c} ${d} ${pTL.h} ${pTL.v})` });
    const im = Dom.svg("image", { x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: "none" });
    im.setAttribute("href", href); im.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", href);
    g.appendChild(im); return g;
  }
  /** Boîte 3D d'un équipement libre à un centre (cx,cy) et une base Z donnés (réutilisée par la pose en
      salle ET sur un étage). `sel` ajoute la classe de sélection ; clic → fiche équipement. */
  private freeEquipBoxAt(e: any, cx: number, cy: number, baseZ: number, proj: (p: Vec3) => { h: number; v: number; depth: number }, opts: { sel?: boolean } = {}): Drawable {
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
  private cableLine(a: any, b: any, viaW: Array<{ wp?: any; p: Vec3 }>): { pts: Vec3[]; linePts: Vec3[]; straight: Set<number>; stubAt: Set<number> } {
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
  private worldEndNormal(room: RoomPlacement, res: any): Vec3 | null {
    if (!res || !res.n) return null;
    const w0 = FloorLayout.roomToWorld(room, res as Vec3);
    const w1 = FloorLayout.roomToWorld(room, { x: res.x + res.n.x, y: res.y + res.n.y, z: res.z + res.n.z });
    return { x: w1.x - w0.x, y: w1.y - w0.y, z: w1.z - w0.z };
  }
  private resolvedCables(dcId: string): Array<{ cable: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
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
  private cableColor(c: any): string | null { const n: any = c && c.network_id ? this.store.get("networks", c.network_id) : null; return (n && n.color) ? n.color : null; }

  /* ---- recherche / focus / visibilité câbles ---- */
  private matchSearch(text: any): boolean { const q = this.searchTerm.trim(); return !!q && Text.normSearch(text).includes(Text.normSearch(q)); }
  private eqHit(eqId: string): boolean { if (eqId === this.focusEqId) return true; const e: any = this.store.get("equipments", eqId); return !!e && (this.matchSearch(e.name) || this.matchSearch(EquipmentTypes.label(e.type))); }
  private cableHit(c: any): boolean { return this.matchSearch(c.name); }
  /** Couleur de remplissage d'un équipement selon le mode (face = défaut CSS · groupe · type). */
  private eqFill(eqId: string): string | null {
    if (this.colorMode === "face") return null;
    const e: any = this.store.get("equipments", eqId); if (!e) return null;
    if (this.colorMode === "group") { const g: any = e.group_id ? this.store.get("groups", e.group_id) : null; return (g && g.color) ? g.color : null; }
    return EquipmentTypes.color(e.type) || null;
  }
  private cableShown(rc: { cable: any }): boolean { return this.showAllCables || this.selCables.has(rc.cable.id); }
  /** Centre monde (mm) d'un équipement de la salle `dcId`, ou null. */
  private equipCenter(e: any, dcId: string): Vec3 | null {
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
  private focusEquipment(eqId: string): void {
    const dc = this.current(); if (!dc) return;
    const e: any = this.store.get("equipments", eqId); if (!e) return;
    this.focusEqId = eqId; this.selRackId = e.rack_id || null;
    const ctr = this.equipCenter(e, dc.id);
    if (ctr && this.view === "3d") { this.camTarget = ctr; if (this.scale == null) this.scale = null; }
    this.render();
  }
  /** Spline Catmull-Rom (tension CABLE_SPLINE_K) sur des points écran ; droite si 2 points. `straight` = indices de
      segments à tracer DROITS (corps de conduit) au lieu d'une courbe. */
  private splinePath(pts: Array<{ h: number; v: number }>, straight?: Set<number>): string {
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
  private cablePath(P: Array<{ h: number; v: number }>, straight?: Set<number>, stubAt?: Set<number>): string {
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
  private emitCable3D(rc: { cable: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[]): void {
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
    rc.pts.map(proj).forEach((p) => { const dot = Dom.svg("circle", { class: "dc-cable-end", cx: p.h, cy: p.v, r: rDot }); if (col) (dot as any).style.fill = col; drawables.push({ depth: p.depth - 1e4 - 1, node: dot }); });   // pastilles sur points ORIGINAUX (jamais sur une amorce)
  }
  /** Câble d'alimentation (type de câble de genre « power »). */
  private cableIsPower(c: any): boolean { const t: any = c && c.cable_type_id ? this.store.get("cableTypes", c.cable_type_id) : null; return !!(t && t.kind === "power"); }
  /** Éclairs visibles seulement DE PRÈS (≤ 50 % du seuil de culling) pour ne pas surcharger la vue d'ensemble. */
  private showPowerBolts(): boolean { return this.cullDistanceM > 0 && this.camViewWidthM(this.current()) <= this.cullDistanceM * 0.5; }
  /** Répartit des éclairs le long d'un chemin MONDE, billboardés (taille écran ~constante), au-dessus du câble. */
  private powerBoltsAlong(worldPts: Vec3[], proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[]): void {
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
  private powerBoltNode(p: { h: number; v: number }): SVGElement {
    const s = (15 / (this.scale || 1)) / 24;
    const g = Dom.svg("g", { class: "dc-power-bolt", transform: `translate(${p.h},${p.v}) scale(${s}) translate(-12,-12)` });
    g.appendChild(Dom.svg("path", { d: "M13 1 L4 14 L11 14 L9 23 L20 9 L13 9 Z" }));
    return g;
  }
  /** Waypoint 3D : rail (segment) ou pin (point libre), au-dessus des câbles. */
  private waypoint3D(wp: any, proj: (p: Vec3) => { h: number; v: number; depth: number }): Drawable {
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

  /* ============================ VUE DESSUS (2D) ============================ */
  renderTop(dc: any): void {
    this.persistView();
    const gRoot = this.newScene(dc);
    const W = dc.width_mm, D = dc.depth_mm, cell = dc.cell_mm;
    // vue 2D TOURNÉE pour que la RÉFÉRENCE globale (liseré) soit toujours EN BAS : angle = orientation salle + 180°
    // (0→180, 90→270, 180→0, 270→90) + miroir horizontal → vraie vue « du dessus » (cohérente avec la 3D).
    this.floorXf = { angle: (Normalize.rackOrientation(dc.floor_orientation) + 180) % 360, cx: W / 2, cy: D / 2, flip: true };
    const room = Dom.svg("rect", { class: "dc-room", x: 0, y: 0, width: W, height: D });
    room.addEventListener("contextmenu", (e: any) => { const w = this.clientToWorld(e.clientX, e.clientY); this.ctxMenu(e, this.floorCtx(dc, w)); });   // clic droit sol → créer un waypoint
    gRoot.appendChild(room);
    gRoot.appendChild(this.gridNode(W, D, cell, dc.blocked_cells, (cx0, cy0, cx1, cy1) => this.toggleCellsRange("datacenters", dc.id, cx0, cy0, cx1, cy1)));
    if (this.showOrientMarks) { const th = Math.max(40, Math.min(W, D) * 0.012); gRoot.appendChild(Dom.svg("rect", { class: "dc-floor-room-front", x: 0, y: 0, width: W, height: th })); }   // liseré FRONT
    this.racks(dc.id).forEach((r) => { if (!this.hidden3dRacks.has(r.id)) gRoot.appendChild(this.rackNode(r)); });
    this.store.freeEquipsOfDc(dc.id).forEach((e: any) => { if (e.dc_x != null && e.dc_y != null) gRoot.appendChild(this.equipNode(e)); });
    this.drawCables2D(gRoot, dc);   // filtré par cableShown (showAllCables / selCables) à l'intérieur
    if (this.showWaypoints) this.store.waypointsOfDc(dc.id).forEach((wp: any) => { if (this.store.waypointIsPlaced(wp)) gRoot.appendChild(this.waypointNode2D(wp)); });
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
    const bg = Dom.svg("rect", { class: "dc-room", x: 0, y: 0, width: W, height: D });
    bg.addEventListener("contextmenu", (e: any) => { const w = this.clientToWorld(e.clientX, e.clientY); this.ctxMenu(e, this.floorPlaneCtx(loc, fl, w)); });   // clic droit sol → créer salle / OOB / éditer plan
    gRoot.appendChild(bg);
    gRoot.appendChild(this.gridNode(W, D, cell, cfg.blocked_cells, (cx0, cy0, cx1, cy1) => this.toggleFloorCellsRange(loc, fl, cx0, cy0, cx1, cy1)));
    if (this.showOrientMarks) gRoot.appendChild(Dom.svg("line", { class: "dc-orient-ref-edge", x1: 0, y1: 0, x2: W, y2: 0 }));   // bord de référence (y=0)
    const curId = this.dcId;
    this.store.dcsOfFloor(loc, fl).forEach((d: any) => gRoot.appendChild(this.floorRoomNode(d, curId, cfg)));
    if (this.showWaypoints) this.store.oobWaypoints().filter((w: any) => (w.location || "") === loc && String(w.floor || "") === fl).forEach((wp: any) => gRoot.appendChild(this.floorOobNode(wp, cfg)));
    this.store.floorEquipments().filter((e: any) => (e.location || "") === loc && String(e.floor || "") === fl).forEach((eq: any) => gRoot.appendChild(this.floorEquipNode2D(eq, cfg)));
    if (this.showFloorAnchor) gRoot.appendChild(this.floorAnchorNode(cfg, loc, fl));   // marqueur d'ancrage déplaçable (discret)
    this.renderFloorRail(ft);   // rail de navigation rapide entre étages (à gauche du plan)
    this.finishScene();
    this.uprightTexts();   // texte à l'endroit malgré la rotation/miroir de la vue
  }

  /** Marqueur de POINT D'ANCRAGE (vue Étage 2D) — règle graphiquement `floors.anchor_x/anchor_y` (décalage du
      plan dans la pile 3D multi-salles). Discret (croix pointillée + ⚓), déplaçable, masquable (showFloorAnchor). */
  private floorAnchorNode(cfg: any, loc: string, fl: string): SVGElement {
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
  private onFloorAnchorPointerDown(e: MouseEvent, cfg: any, loc: string, fl: string): void {
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
  private renderFloorRail(ft: { location: string; floor: string }): void {
    if (!this.floorRail) { const r = document.createElement("div"); r.className = "dc-floor-rail"; this.floorRail = r; this.stage.appendChild(r); }
    const rail = this.floorRail; rail.innerHTML = "";
    const keys = this.floor.allFloorKeys();
    if (!keys.length) { rail.style.display = "none"; return; }
    rail.style.display = "";
    const loc = ft.location || "", fl = String(ft.floor || "");
    const title = document.createElement("div"); title.className = "dc-floor-rail-title"; title.textContent = "Étages"; rail.appendChild(title);
    const byB = new Map<string, Array<{ location: string; floor: string }>>();
    keys.forEach((k) => { const b = k.location || ""; if (!byB.has(b)) byB.set(b, []); byB.get(b)!.push(k); });
    const multiB = byB.size > 1;
    [...byB.keys()].forEach((b) => {
      if (multiB) { const h = document.createElement("div"); h.className = "dc-floor-rail-bldg"; h.textContent = FloorLayout.locationLabel(b) || "(bât. ?)"; h.title = FloorLayout.locationLabel(b) || ""; rail.appendChild(h); }
      byB.get(b)!.slice().sort((a, c) => FloorLayout.floorNum(c.floor) - FloorLayout.floorNum(a.floor)).forEach((k) => {
        const isCur = (k.location || "") === loc && String(k.floor || "") === fl;
        const btn = document.createElement("button");
        btn.className = "btn btn-sm dc-floor-rail-btn " + (isCur ? "btn-primary" : "btn-ghost");
        btn.textContent = "ét. " + (String(k.floor) || "0");
        btn.title = (FloorLayout.locationLabel(k.location) || "(bât. ?)") + " · étage " + (String(k.floor) || "0");
        if (isCur) btn.setAttribute("aria-current", "true");
        btn.onclick = () => { if (!isCur) { this.floorTarget = { location: k.location, floor: String(k.floor) }; this.scale = null; this.render(); } };
        rail.appendChild(btn);
      });
    });
  }
  /** Un équipement posé sur le plan d'étage : empreinte orientée + libellé. Cliquable / déplaçable. */
  private floorEquipNode2D(eq: any, cfg: any): SVGElement {
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
  private onFloorEquipPointerDown(e: MouseEvent, eq: any, cfg: any): void {
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
  private floorRoomNode(d: any, curId: string | null, cfg: any): SVGElement {
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
  private floorOobNode(wp: any, cfg: any): SVGElement {
    const p = FloorLayout.oobFloorPos(wp, cfg), s = Math.max(120, cfg.cell_mm * 0.35) * this.markerScale;
    const g = Dom.svg("g", { class: "dc-wp wp-oob", "data-wp": wp.id });
    const dia = Dom.svg("polygon", { class: "dc-wp3d-oob", points: `${p.x},${p.y - s} ${p.x + s},${p.y} ${p.x},${p.y + s} ${p.x - s},${p.y}`, "data-wp": wp.id });
    const lab = Dom.svg("text", { class: "dc-wp-label", x: p.x, y: p.y - s * 1.4, "text-anchor": "middle", "font-size": cfg.cell_mm * 0.4 }); lab.textContent = (Waypoint.glyph(wp) + " " + (wp.name || "OOB")).trim();
    this.wireWp(dia, wp);
    g.append(dia, lab); return g;
  }
  private snapEdge(v: number, cell: number): number { return Math.round(v / cell) * cell; }
  /** Glisser une salle sur le plan d'étage (set floor_x/floor_y, aimanté à la maille, borné au plan) ;
      simple clic = sélection + activation de la salle. */
  private onFloorRoomPointerDown(e: MouseEvent, d: any, cfg: any): void {
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
  private gridNode(W: number, D: number, cell: number, blocked?: string[], onRange?: (cx0: number, cy0: number, cx1: number, cy1: number) => void): SVGElement {
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
  private async toggleCellsRange(coll: string, id: string, cx0: number, cy0: number, cx1: number, cy1: number): Promise<void> {
    const obj: any = this.store.get(coll, id); if (!obj) return;
    const set = new Set<string>(Array.isArray(obj.blocked_cells) ? obj.blocked_cells : []);
    const block = !set.has(cx0 + "," + cy0);
    for (let cx = Math.min(cx0, cx1); cx <= Math.max(cx0, cx1); cx++) for (let cy = Math.min(cy0, cy1); cy <= Math.max(cy0, cy1); cy++) { const k = cx + "," + cy; if (block) set.add(k); else set.delete(k); }
    await this.store.update(coll, id, { blocked_cells: [...set] }); this.setDirty(); this.render();
  }
  /** Entité `floors` de (loc, étage), créée au besoin (les cases inaccessibles d'étage s'y stockent). */
  private async ensureFloor(loc: string, fl: string): Promise<any> { let f: any = this.store.floorFor(loc, fl); if (!f) f = await this.store.create("floors", { location: loc, floor: String(fl) }); return f; }
  private async toggleFloorCellsRange(loc: string, fl: string, cx0: number, cy0: number, cx1: number, cy1: number): Promise<void> { const f = await this.ensureFloor(loc, fl); await this.toggleCellsRange("floors", f.id, cx0, cy0, cx1, cy1); }
  private rackNode(r: any): SVGElement {
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
  private equipNode(e: any): SVGElement {
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
  private waypointNode2D(wp: any): SVGElement {
    const a = this.resolver.waypointAnchor(wp);
    const g = Dom.svg("g", { class: "dc-wp wp-" + Waypoint.typeOf(wp), "data-wp": wp.id });
    if (a.x == null) return g;
    const s = 90 * this.markerScale;   // demi-taille du losange (mm monde)
    if (wp.kind === "segment" && wp.dc_x2 != null) {
      g.appendChild(Dom.svg("line", { class: "dc-wp3d-rail", x1: wp.dc_x, y1: wp.dc_y, x2: wp.dc_x2, y2: wp.dc_y2, "data-wp": wp.id }));
    }
    const dia = Dom.svg("polygon", { class: "dc-wp3d-body", points: `${a.x},${a.y - s} ${a.x + s},${a.y} ${a.x},${a.y + s} ${a.x - s},${a.y}`, "data-wp": wp.id });
    const lab = Dom.svg("text", { class: "dc-wp-label", x: a.x, y: a.y - s * 1.4, "text-anchor": "middle", "font-size": 120 }); lab.textContent = Waypoint.glyph(wp) + " " + (wp.name || "");
    this.wireWp(dia, wp);
    g.append(dia, lab);
    return g;
  }
  private drawCables2D(gRoot: SVGElement, dc: any): void {
    const rDot = DC_DOT_PX * this.markerScale / (this.scale || 1);
    this.resolvedCables(dc.id).forEach((rc) => { if (this.cableShown(rc)) this.drawCable2D(gRoot, rc, rDot); });
    // câbles SORTANTS (un seul bout ici) : tracés jusqu'à l'exit de la salle
    this.outgoingCableStubs(dc.id).forEach((st) => { if (this.cableShown(st)) this.drawCable2D(gRoot, st, rDot); });
  }
  /** Trace UN câble en vue Dessus (spline x,y + pastilles d'extrémité), depuis `{ cable, pts }`. */
  private drawCable2D(gRoot: SVGElement, rc: { cable: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }, rDot: number): void {
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
  private clientToWorld(cx: number, cy: number): { x: number; y: number } {
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
  private snap(v: number, cell: number): number { return (Math.round(v / cell - 0.5) + 0.5) * cell; }
  private rackHalfExtents(r: any): { hx: number; hy: number } {
    const w = r.width_mm || RACK_WIDTH_DEFAULT, d = r.depth || RACK_DEPTH_DEFAULT, o = Normalize.rackOrientation(r.orientation);
    return (o === 90 || o === 270) ? { hx: d / 2, hy: w / 2 } : { hx: w / 2, hy: d / 2 };
  }
  private showCote(text: string, clientX: number, clientY: number): void {
    if (!this.coteEl) { this.coteEl = document.createElement("div"); this.coteEl.className = "dc-cote"; this.stage.appendChild(this.coteEl); }
    this.coteEl.textContent = text; this.coteEl.style.display = "block";
    const r = this.stage.getBoundingClientRect();
    this.coteEl.style.left = (clientX - r.left + 14) + "px"; this.coteEl.style.top = (clientY - r.top + 14) + "px";
  }
  private hideCote(): void { if (this.coteEl) this.coteEl.style.display = "none"; }

  /* ---- tooltips enrichis de scène (réplique de _showTip/_moveTip/_hideTip + builders HTML) ---- */
  private showTip(html: string, ev: MouseEvent): void {
    if (!this.ttEl || !this.ttEl.isConnected) { this.ttEl = document.createElement("div"); this.ttEl.className = "dc-tooltip"; this.stage.appendChild(this.ttEl); }
    this.ttEl.innerHTML = html; this.ttEl.style.display = "block"; this.moveTip(ev);
  }
  private moveTip(ev: MouseEvent): void {
    if (!this.ttEl) return;
    const host = this.stage.getBoundingClientRect();
    let x = ev.clientX - host.left + 14, y = ev.clientY - host.top + 14;
    const tw = this.ttEl.offsetWidth, th = this.ttEl.offsetHeight;
    if (x + tw > host.width) x = ev.clientX - host.left - tw - 14;
    if (y + th > host.height) y = host.height - th - 6;
    this.ttEl.style.left = Math.max(4, x) + "px"; this.ttEl.style.top = Math.max(4, y) + "px";
  }
  private hideTip(): void { if (this.ttEl) this.ttEl.style.display = "none"; }
  /** Attache un tooltip enrichi (HTML construit à la volée) à un nœud de scène. */
  private wireTip(node: SVGElement, htmlFn: () => string): void {
    node.addEventListener("mouseenter", (e: any) => this.showTip(htmlFn(), e));
    node.addEventListener("mousemove", (e: any) => this.moveTip(e));
    node.addEventListener("mouseleave", () => this.hideTip());
  }
  private tipRow(html: string): string { return `<div class="tt-row">${html}</div>`; }
  private tipSwatch(color: string): string { return `<span class="tt-sw" style="background:${Html.escape(color || "#888")}"></span>`; }
  /** Tooltip d'une baie (dimensions, U, orientation, occupation). */
  private rackTipHtml(r: any): string {
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
  private equipmentTipHtml(eqId: string): string {
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
  private portTipHtml(port: any, cab: any): string {
    const eq: any = this.store.get("equipments", port.equipment_id);
    const head = (eq ? (eq.name || "(équip.)") + " : " : "") + (port.name || "(port)");
    return `<div class="tt-title">${Html.escape(head)}</div>`
      + (cab ? this.tipRow(`Câble : <b>${Html.escape(this.cableLabelShort(cab))}</b> — cliquer pour l'éditer`)
             : `<div class="tt-row" style="color:var(--accent)">Port libre — cliquer pour créer ou affecter un câble</div>`);
  }
  /** Tooltip d'un câble (type, faisceau, longueur, réseaux, extrémités, points de passage, état). */
  private cableTipHtml(c: any): string {
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
  private wpTipHtml(wp: any): string {
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
  private onRackPointerDown(e: MouseEvent, r: any): void {
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
  private onEquipPointerDown(ev: MouseEvent, eq: any): void {
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
  private portFlat(center: Vec3, rack: any, sz: { w: number; h: number }, on: boolean, color: string | null, proj: (p: Vec3) => { h: number; v: number; depth: number }): SVGElement {
    const o = Normalize.rackOrientation(rack.orientation) * Math.PI / 180, co = Math.cos(o), so = Math.sin(o);
    const u = { x: co, y: so, z: 0 }, v = { x: 0, y: 0, z: 1 }, hwd = sz.w / 2, hht = sz.h / 2;
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => proj({ x: center.x + su * hwd * u.x + sv * hht * v.x, y: center.y + su * hwd * u.y + sv * hht * v.y, z: center.z + su * hwd * u.z + sv * hht * v.z }));
    const poly = Dom.svg("polygon", { class: "dc-port" + (on ? " on" : ""), points: pts.map((p) => p.h + "," + p.v).join(" ") });
    if (color) { (poly as any).style.fill = color; (poly as any).style.stroke = color; }
    return poly;
  }

  /** Étiquette (nom + icône optionnelle) posée À PLAT sur la face — matrice affine déduite de la projection. */
  private flatLabel(center: Vec3, cx: number, cy: number, content: string, fontMM: number, iconInner: string, proj: (p: Vec3) => { h: number; v: number; depth: number }): SVGElement {
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
  private wireClick(node: SVGElement, fn: (e: MouseEvent) => void): void {
    let downX = 0, downY = 0;
    node.addEventListener("mousedown", (e: any) => { downX = e.clientX; downY = e.clientY; });
    node.addEventListener("click", (e: any) => { if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return; e.stopPropagation(); fn(e); });
  }

  /** Ctrl+clic sur un emplacement U libre → construit/ajuste une sélection CONTIGUË (même baie, même face).
      1er Ctrl+clic = ancre ; les suivants étendent (refus si un U intermédiaire est occupé) ou rétractent.
      Un clic SIMPLE dans la sélection ouvre l'assignation pré-remplie (hauteur = nb d'U). Réplique du monolithe. */
  private toggleSlotSel(rackId: string, u: number, side: string): void {
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

  private wireRack(poly: SVGElement, r: any): void {
    this.wireTip(poly, () => this.rackTipHtml(r));
    this.wireClick(poly, () => { this.hideTip(); this.selRackId = r.id; if (this.host.openRackForm) this.host.openRackForm(r.id); else this.render(); });
    poly.addEventListener("contextmenu", (e: any) => { this.hideTip(); this.ctxMenu(e, this.rackCtx(r)); });
  }
  private wireOccupant(node: SVGElement, eqId: string): void {
    node.setAttribute("data-occ", "eq:" + eqId);
    // survol : met en évidence TOUTES les faces du même équipement (.hover) + tooltip enrichi.
    const setHover = (on: boolean) => { if (this.svg) this.svg.querySelectorAll('[data-occ="eq:' + eqId + '"]').forEach((n) => n.classList.toggle("hover", on)); };
    node.addEventListener("mouseenter", (e: any) => { setHover(true); this.showTip(this.equipmentTipHtml(eqId), e); });
    node.addEventListener("mousemove", (e: any) => this.moveTip(e));
    node.addEventListener("mouseleave", () => { setHover(false); this.hideTip(); });
    this.wireClick(node, () => { this.hideTip(); this.host.openEquipmentDetail?.(eqId); });
    node.addEventListener("contextmenu", (e: any) => { this.hideTip(); this.ctxMenu(e, this.equipmentCtx(eqId)); });
  }
  /** Clic (route-aware) + clic droit (menu) + tooltip enrichi d'un nœud de waypoint/brosse/OOB. */
  private wireWp(node: SVGElement, wp: any): void {
    this.wireTip(node, () => this.wpTipHtml(wp));
    this.wireClick(node, () => { this.hideTip(); this.onWaypointClick(wp); });
    node.addEventListener("contextmenu", (e: any) => { this.hideTip(); this.ctxMenu(e, this.waypointCtx(wp)); });
  }
  /** Câble un connecteur de port : surbrillance au survol (`.dc-port.hover`) + clic (routage interactif si
      actif : démarre/termine la route ; sinon édite/crée le câble). */
  private wirePortNode(node: SVGElement, port: any, cab: any): void {
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
  private async connectPort(port: any): Promise<void> {
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
  private ctxMenu(e: MouseEvent, sections: CtxSection[]): void {
    e.preventDefault(); e.stopPropagation();
    if (this._navMoved) { this._navMoved = false; return; }
    if (sections.length) ContextMenu.show(e.clientX, e.clientY, sections);
  }
  private setDirty(): void { this.host.setDirty?.(true); }
  /** Actions de SÉLECTION de câbles (afficher / isoler / masquer) — manipule selCables, pas « Tout afficher ». */
  private cableSelItems(ids: string[], noun: string): Array<{ label: string; action: () => void }> {
    const u = [...new Set((ids || []).filter(Boolean))]; const n = u.length; if (!n) return [];
    const suf = n > 1 ? " (" + n + ")" : "";
    return [
      { label: "Afficher " + noun + suf, action: () => { u.forEach((id) => this.selCables.add(id)); this.render(); } },
      { label: "Isoler " + noun + suf, action: () => { this.selCables = new Set(u); this.render(); } },
      { label: "Masquer " + noun + suf, action: () => { u.forEach((id) => this.selCables.delete(id)); this.render(); } },
    ];
  }
  private portCtx(port: any, cab: any): CtxSection[] {
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
  private equipmentCtx(eqId: string): CtxSection[] {
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
  private rackCtx(rack: any): CtxSection[] {
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
  private waypointCtx(wp: any): CtxSection[] {
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
  private cableCtx(cable: any): CtxSection[] {
    let detach: { label: string; patch: Record<string, any>; msg: string } | null = null;
    if (cable.status === "cable" || cable.status === "a-remplacer") detach = { label: "Détacher (→ Planifié)", patch: { status: "planifie" }, msg: "Câble détaché — « Planifié »" };
    else if (cable.status === "planifie") detach = { label: "Détacher (→ Brouillon)", patch: { status: "brouillon", from_port_id: null, to_port_id: null, waypoint_ids: [] }, msg: "Câble détaché — assignation retirée" };
    const items: Array<{ label: string; danger?: boolean; action: () => void }> = [{ label: "Modifier le câble…", action: () => this.host.openCableForm?.(cable.id) }];
    if (detach) items.push({ label: detach.label, action: async () => { if (!this.store.get("cables", cable.id)) return; await this.store.update("cables", cable.id, detach!.patch); this.setDirty(); Notify.toast(detach!.msg); } });
    items.push({ label: "Supprimer le câble", danger: true, action: async () => { const ok = await Dialog.confirm({ title: "Supprimer ?", message: `Supprimer « ${cable.name || "ce câble"} » ?`, confirmLabel: "Supprimer", danger: true }); if (!ok || !this.store.get("cables", cable.id)) return; await this.store.remove("cables", cable.id); this.setDirty(); Notify.toast("Câble supprimé"); } });
    return [{ head: cable.name || "(câble)", items }, { items: this.cableSelItems([cable.id], "ce câble") }];
  }
  /** Menu du SOL (vue Dessus) : créer un waypoint (pin / chemin / exit) au point cliqué (aimanté ½ maille). */
  private floorCtx(dc: any, w: { x: number; y: number }): CtxSection[] {
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
  private floorPlaneCtx(loc: string, fl: string, w: { x: number; y: number }): CtxSection[] {
    const cfg = this.floor.config(loc, fl), half = (cfg.cell_mm || 1000) / 2;
    const x = Math.round(w.x / half) * half, y = Math.round(w.y / half) * half;
    return [{ head: "Plan d'étage — " + FloorLayout.locationLabel(loc) + " · ét. " + (fl || "0"), items: [
      { label: "+ Ajouter une salle…", action: () => this.host.openDatacenterForm?.("") },
      { label: "◎ Ajouter un pin d'étage ici", action: async () => { const wp: any = await this.store.create("waypoints", { name: "PIN-" + (this.store.oobWaypoints().length + 1), kind: "point", location: loc, floor: fl, floor_x: x, floor_y: y }); this.selWaypointId = wp.id; this.setDirty(); Notify.toast("Pin d'étage créé — glissez-le, éditez sa hauteur (clic droit)"); } },
      { label: "Éditer le plan d'étage…", action: () => this.editFloor(loc, fl, false) },
    ] }];
  }
  /** Menu de la DALLE d'étage en 3D multi-salles (clic droit) : éditer le plan · ajouter une salle · vue Étage 2D. */
  private floorPlane3DCtx(loc: string, fl: string): CtxSection[] {
    fl = String(fl || "");
    return [{ head: "Étage — " + (FloorLayout.locationLabel(loc) || "(bâtiment ?)") + " · ét. " + (fl || "0"), items: [
      { label: "Éditer le plan d'étage…", action: () => this.editFloor(loc, fl, false) },
      { label: "+ Ajouter une salle (DC) à cet étage…", action: () => this.host.openDatacenterForm?.("") },
      { label: "Vue Étage (2D)", action: () => { this.floorTarget = { location: loc, floor: fl }; this.view = "floor"; this.scale = null; this.buildToolbar(); this.render(); } },
    ] }];
  }
  /** Menu d'une salle dans le plan d'étage : pivoter / ouvrir (plan de salle) / modifier / position auto. */
  private floorRoomCtx(d: any): CtxSection[] {
    return [{ head: d.name || "(salle)", items: [
      { label: "↻ Pivoter 90°", action: async () => { await this.store.update("datacenters", d.id, { floor_orientation: Normalize.rackOrientation((d.floor_orientation || 0) + 90) }); this.selRoomId = d.id; this.setDirty(); } },
      { label: "Ouvrir la salle (Plan de salle)", action: () => { this.dcId = d.id; this.view = "top"; this.scale = null; this.buildToolbar(); this.render(); } },
      { label: "Modifier la salle…", action: () => this.host.openDatacenterForm?.(d.id) },
      { label: "Position auto (retirer le placement)", danger: true, action: async () => { await this.store.update("datacenters", d.id, { floor_x: null, floor_y: null }); this.setDirty(); } },
    ] }];
  }
  /** Menu d'un équipement posé sur le plan d'étage : modifier / fiche / délocaliser / retirer de l'étage. */
  private floorEquipCtx(eq: any): CtxSection[] {
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
  private onWaypointClick(wp: any): void {
    if (this.routeBuild && this.routeBuild.fromPortId) { this.routeAddWp(wp.id); return; }
    this.host.openWaypointForm?.(wp.id);
  }
  /* ---- routage interactif (création d'une route de câble au clic) ---- */
  routeArm(): void { this.routeBuild = { fromPortId: null, wpIds: [], armed: true }; Notify.toast("Routage : cliquez le PORT de départ", "ok"); this.render(); }
  private routeStart(portId: string): void { this.routeBuild = { fromPortId: portId, wpIds: [] }; Notify.toast("Route démarrée — cliquez des waypoints/brosses puis un PORT terminal"); this.render(); }
  private routeAddWp(wpId: string): void {
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
  private routeBack(): void { const rb = this.routeBuild; if (!rb) return; if (rb.wpIds.length) rb.wpIds.pop(); else if (rb.fromPortId) { rb.fromPortId = null; rb.armed = true; } this.render(); }
  routeCancel(): void { this.routeBuild = null; this.render(); }
  private routeFinish(endPortId: string): void {
    const rb = this.routeBuild; if (!rb || !rb.fromPortId) return;
    if (endPortId === rb.fromPortId) { Notify.toast("Le port terminal doit différer du port de départ", "err"); return; }
    const fromPortId = rb.fromPortId, wpIds = rb.wpIds.slice();
    this.routeBuild = null; this.render();
    this.host.openCableForm?.(null, { fromPortId, toPortId: endPortId, waypointIds: wpIds });   // dialogue de câblage prérempli
  }
  /** Libellé court d'un port (équipement : port). */
  private portShort(portId: string): string { const p: any = this.store.get("ports", portId); if (!p) return "(port ?)"; const e: any = this.store.get("equipments", p.equipment_id); return (e ? (e.name || "(équip.)") + " : " : "") + (p.name || "(port)"); }
  /** Un waypoint « conduit » (brosse / chemin de câbles posé) : le câble le TRAVERSE par ses extrémités. */
  private isConduitWp(w: any): boolean { return !!w && (w.kind === "brush" || (w.kind === "segment" && w.dc_x2 != null && w.dc_y2 != null)); }
  /** Carte « Route en cours » (panneau latéral) : étapes + retour + annuler. */
  private routeCard(): HTMLElement {
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
  private routePreviewWorldPts(dcId: string): Vec3[] {
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
  private drawRoutePreview3D(dc: any, proj: (p: Vec3) => { h: number; v: number; depth: number }, drawables: Drawable[]): void {
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
