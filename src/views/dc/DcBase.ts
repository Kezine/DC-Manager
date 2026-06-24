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

export class DcBase {
  protected store: Store;
  protected host: DatacenterHost;
  protected stage: HTMLElement;
  protected toolbarEl!: HTMLElement;
  protected sideEl: HTMLElement | null = null;
  protected roomSel: HTMLSelectElement | null = null;

  view: "3d" | "top" | "floor" = "3d";
  dcId: string | null = null;
  selEquipId: string | null = null;
  selWaypointId: string | null = null;
  selRoomId: string | null = null;                              // salle sélectionnée en vue Étage
  selFloorEquip: string | null = null;                          // équipement d'étage sélectionné
  freePlace = false;                                            // « Placement libre » : désactive l'aimantation à la grille au glisser
  blockEdit = false;                                            // mode « Cases inaccessibles » : glisser pour (dé)marquer des cases
  routeBuild: { fromPortId: string | null; wpIds: string[]; armed?: boolean; mouse?: Vec3 | null } | null = null;   // session de routage 3D
  protected _camC: Vec3 | null = null;   // centre caméra du dernier rendu 3D (pour l'aperçu de route → souris)
  protected _routeMouseClient: [number, number] | null = null;
  protected _routeMouseTO: any = 0;
  floorTarget: { location: string; floor: string } | null = null;   // étage visé (vue Étage), indépendant d'une salle
  // ROTATION de la vue 2D { angle, cx, cy, flip } : Étage = 180° ; Dessus = orientation salle + 180° → bord de réf. EN BAS.
  // Le flip horizontal donne une vraie vue « du dessus » (cohérente avec la 3D, et non « via le plancher »). Nul en 3D.
  protected floorXf: { angle: number; cx: number; cy: number; flip: boolean } | null = null;
  protected coteEl: HTMLElement | null = null;
  protected ttEl: HTMLElement | null = null;   // tooltip enrichi de scène (positionné dans le stage)
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
  protected expanded = new Set<string>();  // cartes du panneau DÉPLIÉES (repliées par défaut)
  protected _cableEqFilter = "";           // filtre de la liste de câbles par équipement (aide à la sélection)
  protected _cableSearch = "";             // filtre texte de la liste de câbles
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

  protected scene: RackScene;
  protected resolver: Resolver3D;
  protected floor: FloorLayout;
  protected _multi: MultiLayout | null = null;   // disposition multi-salles du dernier rendu (null = mono)
  protected rowEl: HTMLElement | null = null;   // rangée stage|panneau — dimensionnée pour remplir le viewport
  protected svg: SVGSVGElement | null = null;
  protected gRoot: SVGGElement | null = null;
  protected _raf3d = 0;
  protected _resizeT: any = 0;
  protected _pvTO: any = 0;              // persistance débouncée
  protected _restoredKey: string | null = null;   // clé (fileId) dont l'état a déjà été restauré
  protected _farCull = false;            // vue « loin » → ports + emplacements libres non rendus (perf)
  protected _navMoved = false;           // un glisser (orbite) vient d'avoir lieu → ne pas ouvrir de menu contextuel
  protected controlsEl: HTMLElement | null = null;   // overlay zoom / recentrage / points de vue (superposé au stage)
  protected floorRail: HTMLElement | null = null;     // vue Étage : rail de navigation rapide entre étages (flottant à gauche)



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


  /* ---- modèle ---- */

  protected dcs(): any[] { return this.store.all("datacenters").slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")); }

  current(): any { const all = this.dcs(); if (!all.length) return null; return (this.dcId && this.store.get("datacenters", this.dcId)) || all[0]; }

  /** Étage affiché par la vue Étage : floorTarget explicite → salle active → 1re salle → 1er étage connu → null. */
  protected floorTargetResolve(): { location: string; floor: string } | null {
    if (this.floorTarget) return this.floorTarget;
    const dc = this.dcId ? this.store.get("datacenters", this.dcId) : null;
    if (dc) return { location: dc.location || "", floor: String(dc.floor || "") };
    const all = this.dcs();
    if (all.length) return { location: all[0].location || "", floor: String(all[0].floor || "") };
    const keys = this.floor.allFloorKeys();
    return keys.length ? { location: keys[0].location, floor: keys[0].floor } : null;
  }

  protected racks(dcId: string): any[] { return this.store.racksOfDc(dcId); }

  protected zRef(dc: any): number { const maxU = this.racks(dc.id).reduce((m, r) => Math.max(m, r.u_count || 0), 0) || 42; return maxU * U_MM; }

  /** Salles affichées : mono = salle active ; multi = active ∪ visibleDcIds. */
  protected displayedDcIds(dc: any): string[] {
    if (this.view !== "3d") return dc ? [dc.id] : [];
    if (!this.multiDc && dc) return [dc.id];
    const ids = new Set<string>();
    if (dc) ids.add(dc.id);
    if (this.visibleDcIds.size) this.visibleDcIds.forEach((id) => { if (this.store.get("datacenters", id)) ids.add(id); });
    else if (!dc) this.store.all("datacenters").forEach((d: any) => ids.add(d.id));
    return [...ids];
  }

  protected setDirty(): void { this.host.setDirty?.(true); }

  protected btn(text: string, onClick: () => void, title?: string): HTMLButtonElement {
    const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost btn-sm"; b.textContent = text; if (title) b.title = title; b.onclick = onClick; return b;
  }

  protected labeled(label: string, control: HTMLElement): HTMLElement {
    const wrap = document.createElement("label"); wrap.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--fg-dim)";
    wrap.append(document.createTextNode(label), control); return wrap;
  }

  /** Séparateur vertical entre groupes de la toolbar (visualisation | déplacement/exclusion). */
  protected vsep(): HTMLElement {
    const d = document.createElement("div");
    d.style.cssText = "align-self:stretch;width:1px;min-height:22px;margin:0 4px;background:var(--line)";
    return d;
  }


  /** Rend une carte repliable (clé persistée dans `expanded`). */
  protected collapsible(card: HTMLElement, key: string): HTMLElement {
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

  /** Curseur étiqueté générique (oninput = aperçu live ; onchange optionnel). */
  protected slider(label: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string, onInput: (v: number) => void, onChange?: () => void): HTMLElement {
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


  /* ---- scène SVG ---- */
  protected clearStage(): void { Array.from(this.stage.childNodes).forEach((n) => { if (n !== this.controlsEl && n !== this.floorRail) this.stage.removeChild(n); }); this.coteEl = null; this.ttEl = null; }

  protected newScene(dc: any): SVGGElement {
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

  protected finishScene(): void { if (this.scale == null) this.recenter(); else this.applyTransform(); this.markRouteWaypoints(); }

  protected applyTransform(): void {
    if (!this.gRoot) return;
    let xf = "";
    if (this.floorXf) {   // vue 2D tournée + miroir → vue réellement « du dessus »
      const f = this.floorXf;
      xf = ` rotate(${f.angle} ${f.cx} ${f.cy})`;
      if (f.flip) xf += ` translate(${2 * f.cx} 0) scale(-1 1)`;
    }
    this.gRoot.setAttribute("transform", `translate(${this.tx},${this.ty}) scale(${this.scale})${xf}`);
  }


  /** Étire la rangée stage|panneau pour occuper l'espace vertical RESTANT du viewport (sans déborder). */
  fitHeight(): void {
    const row = this.rowEl; if (!row || row.offsetParent === null) return;   // masqué (onglet inactif) → on saute
    if (document.fullscreenElement === row) { row.style.height = ""; return; }   // plein écran : hauteur gérée par le CSS :fullscreen
    const top = row.getBoundingClientRect().top;
    row.style.height = Math.max(360, Math.floor(window.innerHeight - top - 18 - 2)) + "px";
  }


  /* ---- rendu 3D ---- */
  show(): void {
    // restaure l'état de vue UNE FOIS par fichier (les re-rendus de données ne réécrasent pas les réglages de session).
    const key = this.viewStateKey();
    if (key !== this._restoredKey) { this.restoreView(); this._restoredKey = key; }
    this.buildToolbar(); this.fitHeight(); this.render();
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

  /** Oublie l'état restauré → la prochaine activation repart des défauts (après reset des préférences). */
  resetView(): void { this._restoredKey = null; }


  /* ---- persistance de l'état de vue (par fichier, localStorage) ---- */
  protected viewStateKey(): string { return "netmap.view3d." + ((this.store.meta && this.store.meta.fileId) ? this.store.meta.fileId : "__nofile"); }
  protected static readonly TOGGLE_KEYS = ["hideFrontEq", "hideRearEq", "showPlaceholders", "showRackSides", "showPorts", "showEqNames", "showAllCables", "showWaypoints", "showConduits", "showOrientMarks", "showPivot", "showFloorAnchor", "showFaceImages", "showDoors", "showFloorGrid", "cablePortNormal", "routePreviewToMouse"];

  /** Écrit l'état (débouncé 300 ms) — évite une écriture par frame de pan/zoom. */
  protected persistView(): void {
    clearTimeout(this._pvTO);
    this._pvTO = setTimeout(() => {
      try {
        const o: any = { view: this.view, dcId: this.dcId, az: this.az, el: this.el, scale: this.scale, tx: this.tx, ty: this.ty, camTarget: this.camTarget, hidden3dRacks: [...this.hidden3dRacks], fadedRacks: [...this.fadedRacks], colorMode: this.colorMode, cableSplineK: this.cableSplineK, markerScale: this.markerScale, cullDistanceM: this.cullDistanceM, multiDc: this.multiDc, visibleDcIds: [...this.visibleDcIds], floorTarget: this.floorTarget };
        DcBase.TOGGLE_KEYS.forEach((k) => { o[k] = (this as any)[k]; });
        window.localStorage.setItem(this.viewStateKey(), JSON.stringify(o));
      } catch (_) { /* quota / indispo → ignoré */ }
    }, 300);
  }

  /** Restaure l'état pour le fichier courant (failsafes : références disparues ignorées ; défauts sinon). */
  protected restoreView(): void {
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
    DcBase.TOGGLE_KEYS.forEach((k) => { if (typeof o[k] === "boolean") (this as any)[k] = o[k]; });
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

}

/* Fusion de déclaration : la chaîne d'héritage répartit les méthodes sur plusieurs classes, mais à
   l'exécution `this` est l'instance finale `DatacenterView` qui les possède toutes. Cette signature
   d'index (héritée par toutes les couches) autorise les appels croisés `this.x()` entre couches. */
export interface DcBase { [key: string]: any; }
