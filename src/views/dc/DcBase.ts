import type { Store } from "../../store";
import { Dom } from "../../ui/Dom";
import { FormControls } from "../../ui/FormControls";
import { Dialog } from "../../ui/Dialog";
import { Notify } from "../../ui/Notify";
import { ContextMenu } from "../../ui/ContextMenu";
import type { CtxSection } from "../../ui/ContextMenu";
import { TouchNav } from "../../ui/TouchNav";
import { ImageExport } from "../../ui/ImageExport";
import type { ExportOptions } from "../../ui/ImageExport";
import { Html } from "../../core/Html";
import { Normalize } from "../../core/Normalize";
import { RackGeometry } from "../../geometry/RackGeometry";
import { RackScene } from "../../geometry/RackScene";
import { FreeEquipGeometry } from "../../geometry/FreeEquipGeometry";
import { Resolver3D } from "../../geometry/Resolver3D";
import { FloorLayout } from "../../geometry/FloorLayout";
import { CableRouting } from "../../geometry/CableRouting";
import type { MultiLayout, RoomPlacement } from "../../geometry/FloorLayout";
import { Box } from "../../geometry/Box";
import { Painter } from "../../geometry/Painter";
import { PositioningTool } from "./PositioningTool";
import type { PositioningHost } from "./PositioningTool";
import { DoorTool } from "./DoorTool";
import type { DoorHost } from "./DoorTool";
import { GridGeometry } from "../../geometry/GridGeometry";
import { Measure } from "../../geometry/Measure";
import { Depths } from "../../registries/Depths";
import { EquipmentTypes } from "../../registries/EquipmentTypes";
import { Format } from "../../core/Format";
import { Text } from "../../core/Text";
import { Waypoint } from "../../models/Waypoint";
import { CableStatuses } from "../../domain/CableStatuses";
import { RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_EAR_MM, U_MM, SIDE_U_STEP, BRUSH_PADDING_MM } from "../../domain/constants";
import { DC_DOT_PX, WP_HIT_PX, CABLE_PORT_STUB_MM, CABLE_SPLINE_K, CAM_PRESETS, DC_SCOPE_ICONS } from "./shared";
import type { Vec3, Drawable, DatacenterHost } from "./shared";
// SPIKE : moteur 3D WebGL parallèle — importé DYNAMIQUEMENT (webpackMode "eager" → reste inliné single-file ;
// et la chaîne require() CJS du harnais de test ne charge pas ses dépendances ESM-only comme Line2).

export class DcBase {
  protected store: Store;
  protected host: DatacenterHost;
  protected stage: HTMLElement;
  protected toolbarEl!: HTMLElement;
  protected sideEl: HTMLElement | null = null;

  view: "3d" | "top" | "floor" = "3d";
  dcId: string | null = null;
  selEquipId: string | null = null;
  selWaypointId: string | null = null;
  selRoomId: string | null = null;                              // salle sélectionnée en vue Étage
  selFloorEquip: string | null = null;                          // équipement d'étage sélectionné
  freePlace = false;                                            // « Placement libre » : désactive l'aimantation à la grille au glisser
  blockEdit = false;                                            // mode « Cases inaccessibles » : glisser pour (dé)marquer des cases
  routeBuild: { fromPortId: string | null; wpIds: string[]; armed?: boolean; mouse?: Vec3 | null } | null = null;   // session de routage 3D
  // Outil de MESURE multipoint (éphémère, exclusif du routage). `pts`/`cursor` en coordonnées du CONTEXTE (`ctx` :
  // salle mono / monde multi / plan d'étage) ; raycast sur les surfaces en 3D, plan du sol en 2D. Voir DcInteract.
  measure: { active: boolean; ctx: string; pts: Vec3[]; cursor: Vec3 | null; done: Vec3[][] } | null = null;
  protected _measMouseClient: [number, number] | null = null;
  protected _measMouseTO: any = 0;
  protected _measHi: number | null = null;   // mesure terminée mise en évidence (survol du listing), ou null
  // Outil de POSITIONNEMENT (aide au placement par COINS + cotes ⟂). Module dédié `PositioningTool` (état + overlay
  // + panneau + glisser), piloté via l'interface PositioningHost que cette chaîne de vues implémente (cf. DcInteract
  // posScene/posCtxKey/…). Instancié dans le constructeur. ÉPHÉMÈRE : déplace l'élément puis écrit sa position UNE fois.
  posTool!: PositioningTool;
  doorTool!: DoorTool;
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
  hidden3dEquips = new Set<string>();          // équipements LIBRES masqués en 3D (par id) — piloté par le panneau + le menu contextuel (masquage par équipement / groupe / type)
  selRackId: string | null = null;
  slotSel: { rackId: string; side: string; lo: number; hi: number } | null = null;   // sélection U multiple (Ctrl+clic) — plage contiguë même baie/face
  multiDc = false;                       // vue 3D multi-salles (étages empilés, bâtiments côte à côte)
  visibleDcIds = new Set<string>();      // salles affichées en multi-salles (∪ salle active)
  visibleSites = new Set<string>();      // sites/bâtiments accessibles à l'UI (vide = tous) — filtre vue Étage / rail / portée 3D
  protected expanded = new Set<string>();  // cartes du panneau DÉPLIÉES (repliées par défaut)
  protected _cableEqFilter = "";           // filtre de la liste de câbles par équipement (aide à la sélection)
  protected _cableSearch = "";             // filtre texte de la liste de câbles
  // options d'affichage (exposées dans le panneau latéral « Vue 3D »)
  hideFrontEq = false; hideRearEq = false; showPlaceholders = true; showRackSides = true;
  showWaypoints = true; showConduits = true; showPorts = true; showEqNames = true;
  showOrientMarks = true; showPivot = false;
  showFloorAnchor = true;                // vue Étage : marqueur de point d'ancrage (déplaçable, discret) — masquable
  // PERSONNAGE d'échelle (repère PERSONNEL, vue seule — NON enregistré dans le document) : humanoïde ~1,75 m
  // positionnable en salle (dcX/dcY) et sur l'étage (floorX/floorY). Persisté dans l'état de vue (localStorage).
  showFigure = false;
  figure: { dcX: number; dcY: number; orient: number; floorX: number; floorY: number } | null = null;
  colorMode: "face" | "group" | "type" = "face";   // coloration des équipements 3D
  cableSplineK = CABLE_SPLINE_K;         // arrondi des câbles (slider)
  markerScale = 1;                       // taille des marqueurs de waypoint + connecteurs de port (slider, 1 = défaut/milieu)
  showAllCables = true;                 // false → seuls les câbles sélectionnés (selCables) sont tracés
  selCables = new Set<string>();         // câbles explicitement affichés quand showAllCables = false
  searchTerm = "";                       // surlignage + filtrage des listes (équipements / câbles)
  focusEqId: string | null = null;       // équipement ciblé (surligné + caméra recentrée)
  focusPortId: string | null = null;     // port ciblé (surligné comme l'équipement) lors d'une localisation de port
  // contrôles présents mais INERTES tant que la fonctionnalité n'est pas portée (cf. panneau « à venir »).
  showFaceImages = true; showDoors = true; showDoorSwing = false; showFloorGrid = true; cablePortNormal = false;
  powerBoltSpacingMm = 300;             // espacement (mm) des éclairs ⚡ le long des câbles power

  useWebGL = true;                               // moteur 3D = WebGL (Three.js) — unique moteur 3D (le SVG legacy a été retiré)
  webglPerspective = false;                      // projection du moteur WebGL : false = ortho · true = perspective
  cablesOnTop = true;                            // WebGL : câbles dessinés au-dessus des équipements/baies (défaut activé)
  protected _three: any = null;                  // instance DcThreeScene (chargée à la demande)
  protected _focusTarget: { p: Vec3; extent: number; face: { az: number; el: number } | null } | null = null;   // cible « Localiser » à pousser au moteur après (re)rendu
  protected _returnAction: (() => void) | null = null;   // action du bouton « Retour » (rouvrir la modale / revenir à l'onglet d'origine)
  protected _webglHost: HTMLElement | null = null;
  protected _webglRev: number | null = null;     // révision du store au dernier (re)build WebGL → éviter un build complet au simple retour de vue

  protected scene: RackScene;
  protected resolver: Resolver3D;
  protected floor: FloorLayout;
  protected routing: CableRouting;               // service de routage des câbles (agnostique du moteur — SVG + WebGL)
  protected rowEl: HTMLElement | null = null;   // rangée stage|panneau — dimensionnée pour remplir le viewport
  protected svg: SVGSVGElement | null = null;
  protected gRoot: SVGGElement | null = null;
  protected _resizeT: any = 0;
  protected _pvTO: any = 0;              // persistance débouncée
  protected _restoredKey: string | null = null;   // clé (fileId) dont l'état a déjà été restauré
  protected controlsEl: HTMLElement | null = null;   // overlay zoom / recentrage / points de vue (superposé au stage)
  protected floorRail: HTMLElement | null = null;     // vue Étage : rail de navigation rapide entre étages (flottant à gauche)
  // Handlers GLOBAUX (window/document) mémorisés pour pouvoir les retirer dans `dispose()` — sinon une éventuelle
  // ré-instanciation de la vue laisserait des handlers fantômes appelant `render()` sur une instance morte.
  private _onWinResize: (() => void) | null = null;
  private _onFullscreen: (() => void) | null = null;
  private _onKeydown: ((e: KeyboardEvent) => void) | null = null;



  constructor(store: Store, mount: HTMLElement, host: DatacenterHost = {}) {
    this.store = store; this.host = host; this.stage = mount; this.scene = new RackScene(store); this.resolver = new Resolver3D(store); this.floor = new FloorLayout(store); this.routing = new CableRouting(store, this.resolver, this.floor);
    // Outil de positionnement : cette chaîne de vues EST son hôte (implémente PositioningHost via DcInteract).
    this.posTool = new PositioningTool(this as unknown as PositioningHost);
    this.doorTool = new DoorTool(this as unknown as DoorHost);
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
      // En GRAND écran : `.dc-side-modal` est `display:contents` → `.dc-side` reste la colonne latérale inline
      // (rendu inchangé). En RESPONSIVE : `.dc-row.show-side` la transforme en MODALE centrée (backdrop + bouton
      // fermer), ouverte par l'icône « réglages 3D » de l'overlay — sans empiéter sur le rendu de la vue.
      const sideModal = document.createElement("div"); sideModal.className = "dc-side-modal";
      const closeBtn = document.createElement("button"); closeBtn.type = "button"; closeBtn.className = "btn btn-ghost btn-sm dc-side-close"; closeBtn.textContent = "✕"; closeBtn.title = "Fermer";
      closeBtn.onclick = () => this.rowEl && this.rowEl.classList.remove("show-side");
      sideModal.append(closeBtn, this.sideEl);
      const backdrop = document.createElement("div"); backdrop.className = "dc-side-backdrop";
      backdrop.onclick = () => this.rowEl && this.rowEl.classList.remove("show-side");
      row.append(sideModal, backdrop);
      this.rowEl = row;
    }
    // remplir le viewport verticalement (sans déborder) ; recalcul au redimensionnement.
    this._onWinResize = () => {
      clearTimeout(this._resizeT);
      this._resizeT = setTimeout(() => {
        if (this.stage.offsetParent === null) return;
        // MOBILE : l'apparition du clavier virtuel déclenche un `resize`. Reconstruire le panneau (render →
        // renderSide) détruirait le champ EN COURS DE SAISIE (perte du focus + du texte, en boucle). Si un champ
        // est focalisé, on se contente de re-dimensionner la rangée sans reconstruire la scène/le panneau.
        const ae = document.activeElement as HTMLElement | null;
        const typing = !!(ae && (ae.isContentEditable || /^(input|textarea|select)$/i.test(ae.tagName)));
        this.fitHeight();
        if (!typing) this.render();
      }, 120);
    };
    window.addEventListener("resize", this._onWinResize);
    // entrée/sortie de plein écran → re-cadrer (la rangée change de taille)
    this._onFullscreen = () => { this.fitHeight(); this.render(); };
    document.addEventListener("fullscreenchange", this._onFullscreen);
    // Mode mesure : ENTRÉE valide la mesure en cours (elle reste affichée) · ÉCHAP annule la mesure en cours.
    // Ignoré dans un champ de saisie ou sous un overlay (modale/dialogue) ouvert.
    this._onKeydown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      const tg = e.target as HTMLElement | null;
      if (tg && (tg.isContentEditable || /^(input|textarea|select)$/i.test(tg.tagName))) return;
      if (document.querySelector(".modal-overlay.open, .dialog-overlay")) return;
      // ÉCHAP en mode POSITIONNEMENT : efface la sélection courante (références → coin → mover) par paliers.
      if (this.posTool.active && e.key === "Escape" && this.posTool.activeHere()) { e.preventDefault(); this.posTool.escape(); return; }
      if (!this.measure || !this.measure.active) return;
      e.preventDefault();
      if (e.key === "Enter") this.measureCommit(); else this.measureCancelCurrent();
    };
    document.addEventListener("keydown", this._onKeydown);
    this.buildControls();
    this.buildToolbar();
  }

  /** Libère les ressources de la vue : handlers GLOBAUX (window/document), timers débouncés et moteur 3D.
      Actuellement la vue est un quasi-singleton (créée une fois ; les bascules de mode passent par un
      `window.location.reload()` qui purge tout) → non appelé en pratique. Fourni pour rendre la classe HONNÊTE sur
      ses ressources et SÛRE si elle venait à être ré-instanciée/démontée (sinon : handlers fantômes → `render()`
      sur une instance morte). Cf. `DcThreeBase.dispose()` pour la libération GPU. */
  dispose(): void {
    if (this._onWinResize) { window.removeEventListener("resize", this._onWinResize); this._onWinResize = null; }
    if (this._onFullscreen) { document.removeEventListener("fullscreenchange", this._onFullscreen); this._onFullscreen = null; }
    if (this._onKeydown) { document.removeEventListener("keydown", this._onKeydown); this._onKeydown = null; }
    clearTimeout(this._resizeT); clearTimeout(this._pvTO);
    if (this._three) { this._three.dispose(); this._three = null; this._webglHost = null; }
  }


  /* ---- modèle ---- */

  protected dcs(): any[] { return this.store.all("datacenters").slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")); }

  current(): any { const all = this.dcs(); if (!all.length) return null; return (this.dcId && this.store.get("datacenters", this.dcId)) || all[0]; }

  /** Étage affiché par la vue Étage : floorTarget explicite → salle active → 1re salle → 1er étage connu → null. */
  /** Un site/bâtiment est-il ACCESSIBLE à l'UI ? (filtre `visibleSites` ; vide = tous accessibles). */
  protected siteAccessible(loc: string): boolean { return this.visibleSites.size === 0 || this.visibleSites.has(loc || ""); }

  protected floorTargetResolve(): { location: string; floor: string } | null {
    if (this.floorTarget && this.siteAccessible(this.floorTarget.location)) return this.floorTarget;
    const dc = this.dcId ? this.store.get("datacenters", this.dcId) : null;
    if (dc && this.siteAccessible(dc.location || "")) return { location: dc.location || "", floor: String(dc.floor || "") };
    const all = this.dcs().filter((d: any) => this.siteAccessible(d.location || ""));
    if (all.length) return { location: all[0].location || "", floor: String(all[0].floor || "") };
    const keys = this.floor.allFloorKeys().filter((k: any) => this.siteAccessible(k.location));
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

  /* ---- DoorHost : services fournis au DoorTool (cf. DoorTool.ts) ---- */
  /** Persiste la liste de portes d'une salle + marque le document modifié. */
  async persistDoors(dcId: string, doors: any[]): Promise<void> { await this.store.update("datacenters", dcId, { doors }); this.setDirty(); }
  /** Ouvre le formulaire d'édition d'une porte (délégué à l'hôte applicatif — optionnel). */
  openDoorForm(dcId: string, doorId: string): void { this.host.openDoorForm?.(dcId, doorId); }
  /** Toggle d'affichage du débattement (option de vue partagée 2D/3D). */
  doorShowSwing(): boolean { return this.showDoorSwing; }
  /** Échelle mm→px courante (1 par défaut). */
  doorScale(): number { return this.scale || 1; }
  /** Positionnement assisté actif ici ? / délégation du glisser aimanté (contraint au mur par le commit `posScene`). */
  posActiveHere(): boolean { return this.posTool.activeHere(); }
  posDragEntity(e: MouseEvent, id: string): void { this.posTool.dragEntity(e, id); }
  /** Reconstruit le panneau latéral de la salle courante (après un ajout de porte via la carte). */
  refreshSide(): void { this.renderSide(this.current()); }

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
  protected clearStage(): void { Array.from(this.stage.childNodes).forEach((n) => { if (n !== this.controlsEl && n !== this.floorRail && n !== this._webglHost) this.stage.removeChild(n); }); this.coteEl = null; this.ttEl = null; }

  protected newScene(dc: any): SVGGElement {
    this.clearStage();
    const SW = Math.max(50, this.stage.clientWidth || 900), SH = Math.max(50, this.stage.clientHeight || 560);
    const svg = Dom.svg("svg", { class: "dc-svg", width: SW, height: SH }) as SVGSVGElement;
    this.svg = svg;
    const gRoot = Dom.svg("g") as SVGGElement; this.gRoot = gRoot; svg.appendChild(gRoot);
    // MODE MESURE : le contenu de la scène devient inerte au pointeur (CSS `.dc-measuring * { pointer-events:none }`)
    // → seuls les handlers du <svg> reçoivent les événements : le GLISSER navigue (pan/orbite, non inhibé) et le
    // CLIC franc pose un point. Les actions de clic normales (édition baie/câble/waypoint) sont ainsi neutralisées.
    if (this.measure && this.measure.active) svg.classList.add("dc-measuring");
    let mdX = 0, mdY = 0;   // position du dernier mousedown → distinguer le clic franc du glisser de navigation
    // newScene ne sert QUE les vues 2D (Plan de salle / Plan d'étage) — la 3D est rendue par le moteur WebGL (canvas).
    svg.addEventListener("mousedown", (ev) => { mdX = ev.clientX; mdY = ev.clientY; if (ev.button === 0) this.startPan2D(ev); });   // glisser le fond = pan 2D
    // CLIC franc en mode mesure (≤ 4 px de déplacement = pas un glisser de navigation) → pose un point.
    svg.addEventListener("click", (ev) => {
      if (!this.measure || !this.measure.active || ev.button !== 0) return;
      if (Math.hypot(ev.clientX - mdX, ev.clientY - mdY) > 4) return;
      this.measurePlaceAt(ev.clientX, ev.clientY);
    });
    svg.addEventListener("contextmenu", (e) => e.preventDefault());
    // aperçu de MESURE jusqu'à la SOURIS (2D ET 3D), throttlé — segment courant en pointillé + cote (longueur live).
    svg.addEventListener("mousemove", (ev) => {
      if (!this.measure || !this.measure.active || !this.measureActiveHere() || !this.measure.pts.length) return;
      this._measMouseClient = [ev.clientX, ev.clientY];
      if (this._measMouseTO) return;
      this._measMouseTO = setTimeout(() => {
        this._measMouseTO = 0;
        const mc = this._measMouseClient; if (!mc || !this.measure || !this.measure.active) return;
        this.measure.cursor = this.measurePick(mc[0], mc[1]);
        this.refreshMeasurePreview();
        const last = this.measure.pts[this.measure.pts.length - 1];
        if (this.measure.cursor) this.showCote(Format.meters(Measure.dist(last, this.measure.cursor)), mc[0], mc[1]); else this.hideCote();
      }, 40);
    }, true);
    svg.addEventListener("wheel", (ev) => this.onWheel(ev), { passive: false });
    // navigation TACTILE 2D (Plan de salle / Plan d'étage) : 1 doigt = pan · 2 doigts = pinch-zoom.
    // Le tap d'1 doigt n'est pas intercepté → la sélection (baie/équipement) passe par les events souris de compat.
    TouchNav.attach(svg, {
      panBy: (dx, dy) => this.panByClient(dx, dy),
      zoomAt: (f, x, y) => this.zoomAtClient(f, x, y),
      panStart: () => svg.classList.add("panning"),
      panEnd: () => svg.classList.remove("panning"),
    });
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
    this.setReturnAction(null);   // activation normale → pas de bouton « Retour » périmé (le flux « Localiser » le re-définit après)
    this.buildToolbar(); this.fitHeight(); this.render();
  }

  render(): void {
    if (typeof document === "undefined") return;
    // SPIKE WebGL : on NE démonte le moteur Three QUE si on bascule sur la 3D LEGACY (SVG) — qui occupe le même
    // stage. On le PRÉSERVE en changeant d'onglet ou de sous-vue (Dessus/Étage) : le canvas est détaché par
    // clearStage mais le contexte/scène persistent (réattachés au retour) → pas de réinitialisation coûteuse.
    if (this._three && this.view === "3d" && !this.useWebGL) { this._three.dispose(); this._three = null; this._webglHost = null; }
    // hôte WebGL PERSISTANT : visible seulement en 3D-WebGL, sinon MASQUÉ mais conservé attaché (exclu de clearStage)
    // → au retour en 3D, la garde de révision évite la reconstruction (pas de re-dessin de toute la scène).
    if (this._webglHost) this._webglHost.style.display = (this.view === "3d" && this.useWebGL) ? "" : "none";
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
    if (this.view === "top") this.renderTop(dc);
    else {   // vue 3D : moteur WebGL (unique moteur 3D)
      if (this.svg) { this.clearStage(); this.svg = null; }   // retire une scène SVG résiduelle (l'hôte WebGL persistant est conservé)
      // RETOUR DE VUE sans changement de données + hôte toujours attaché → chemin DIFF (souvent un no-op),
      // pas de build complet. Sinon (1er rendu / données modifiées) → (re)build.
      const attached = !!(this._three && this._webglHost && this._webglHost.parentElement === this.stage);
      if (attached && this._webglRev === this.store.histIndex()) this.renderThreeD(dc);
      else this.renderWebGL(dc);
    }
  }

  /** Invalide le cache de (re)build WebGL : force une RECONSTRUCTION COMPLÈTE de la scène 3D au prochain
      `render()` (au lieu du diff léger `renderThreeD`). À appeler quand les DONNÉES ont changé hors timeline
      locale — typiquement un reload SSE d'un document modifié par un autre client : en mode REST `histIndex()`
      vaut toujours 0, donc la garde de révision (`_webglRev === histIndex()`) croirait la scène à jour. */
  invalidate3D(): void { this._webglRev = null; if (this._three) this._three.markStale(); }

  /** Re-render LÉGER pour un simple changement d'OPTION d'affichage (ex. visibilité d'un câble) : en WebGL 3D,
      diff (`applyOptionsDiff` → rebuild de la seule catégorie touchée) au lieu d'un full build coûteux
      (`renderWebGL` reconstruit baies + occupants + textures de noms ≈ 1 s). Panneau latéral rafraîchi normalement
      (peu coûteux : états de toggles dépendants). Hors WebGL/3D : `render()` complet (chemin inchangé). */
  protected rerenderView(): void {
    if (!(this.view === "3d" && this.useWebGL && this._three)) { this.render(); return; }
    const dc = this.current(); if (!dc) { this.render(); return; }
    this.renderSide(dc);
    this.persistView();
    this._three.applyOptionsDiff(this.webglOptions(), dc.id, this.webglCtx());
  }

  /* ---- SPIKE : rendu via le moteur WebGL (Three.js) ---- */
  /** Options d'affichage poussées au moteur WebGL (sous-ensemble implémenté ; le reste est sans effet). */
  protected webglOptions(): any {
    // COPIE de selCables : applyOptionsDiff compare old vs new ; une même référence (mutée) masquerait le changement.
    return { hideFrontEq: this.hideFrontEq, hideRearEq: this.hideRearEq, colorMode: this.colorMode, showAllCables: this.showAllCables, selCables: new Set(this.selCables), hiddenRacks: new Set(this.hidden3dRacks), hiddenEquips: new Set(this.hidden3dEquips), showWaypoints: this.showWaypoints, showConduits: this.showConduits, cableSplineK: this.cableSplineK, cablePortNormal: this.cablePortNormal, showEqNames: this.showEqNames, showRackSides: this.showRackSides, showPorts: this.showPorts, showDoors: this.showDoors, showPlaceholders: this.showPlaceholders, showFloorGrid: this.showFloorGrid, showOrientMarks: this.showOrientMarks, showPivot: this.showPivot, markerScale: this.markerScale, cablesOnTop: this.cablesOnTop, showFaceImages: this.showFaceImages, showDoorSwing: this.showDoorSwing, powerBoltSpacingMm: this.powerBoltSpacingMm, showFigure: this.showFigure, figure: this.figure ? { ...this.figure } : null };
  }

  /** Personnage d'échelle : garantit une position (centre de la salle courante / de l'étage) au 1er affichage. */
  protected figureEnsure(dc: any): void {
    if (this.figure) return;
    const cx = dc ? (dc.width_mm || 4000) / 2 : 2000, cy = dc ? (dc.depth_mm || 3000) / 2 : 1500;
    let fx = cx, fy = cy;
    try { const ft = this.floorTargetResolve && this.floorTargetResolve(); if (ft) { const cfg = this.floor.config(ft.location, ft.floor); fx = (cfg.width_mm || 20000) / 2; fy = (cfg.depth_mm || 20000) / 2; } } catch (_) { /* défaut */ }
    this.figure = { dcX: cx, dcY: cy, orient: 0, floorX: fx, floorY: fy };
  }

  /** Contexte de scène pour le moteur WebGL : descripteur multi-salles + câbles transversaux (repère MONDE).
      La logique de routage (inter-DC / stubs sortants) reste ici (réutilise les helpers SVG) ; le moteur ne fait
      que tracer les tubes — pas de réimplémentation côté Three. */
  protected webglCtx(): any {
    if (this.view !== "3d" || !this.useWebGL) return { multi: null, extraCables: [], floorDecor: null };
    const shown = (c: any) => this.showAllCables || this.selCables.has(c.id);   // visibilité = état de vue
    const extraCables: any[] = [];
    const isPower = (c: any) => { const t: any = c && c.cable_type_id ? this.store.get("cableTypes", c.cable_type_id) : null; return !!(t && t.kind === "power"); };
    const push = (cable: any, linePts: any[], straight?: Set<number>, stubAt?: Set<number>) => {
      if (!shown(cable)) return;
      extraCables.push({ id: cable.id, color: this.routing.cableColor(cable), line: linePts.map((p) => ({ x: p.x, y: p.y, z: p.z })), straight: straight ? [...straight] : [], stubAt: stubAt ? [...stubAt] : [], power: isPower(cable) });
    };
    let multi: any = null, floorDecor: any = null;
    if (this.multiDc) {
      const m = this.floor.multiLayout(this.current(), { visibleDcIds: this.visibleDcIds });
      if (m.rooms.length) {
        // CENTROÏDE DYNAMIQUE : boîte englobante des salles VISIBLES (et non la boîte théorique totalW×maxD×topZ,
        // dominée par la hauteur empilée → caméra mal cadrée). Pivot + cadrage suivent le contenu réellement affiché.
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        const acc = (p: any) => { for (let k = 0; k < 3; k++) { const v = k === 0 ? p.x : k === 1 ? p.y : p.z; lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v); } };
        m.rooms.forEach((rm: any) => { const W = rm.dc.width_mm || 4000, D = rm.dc.depth_mm || 3000; ([[0, 0], [W, 0], [W, D], [0, D]] as Array<[number, number]>).forEach(([x, y]) => [0, m.stackH].forEach((z: number) => acc(FloorLayout.roomToWorld(rm, { x, y, z })))); });
        const center = { x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, z: (lo[2] + hi[2]) / 2 };
        const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 2000);
        multi = {
          center, extent,
          rooms: m.rooms.map((rm: any) => ({ dcId: rm.dc.id, ox: rm.off.x, oy: rm.off.y, oz: rm.off.z, o: rm.o, w: rm.dc.width_mm, d: rm.dc.depth_mm })),
        };
        this.routing.interDcRoutes(m, this.cablePortNormal).forEach((rc: any) => push(rc.cable, rc.linePts, rc.straight, rc.stubAt));   // routes inter-DC (monde)
        // décor d'étage (plans/OOB/étiquettes) SEULEMENT en vrai multi (≥ 2 salles) → une seule salle = on ne dessine que la salle.
        floorDecor = m.rooms.length > 1 ? this.webglFloorDecor(m) : null;
      }
    } else {
      const dc = this.current();
      if (dc) {
        // UNIFIÉ : la salle unique est décrite comme un « multi » à 1 salle (repère identité) → MÊME chemin
        // incrémental (applyRoomDelta + cache chaud) que le Multi-DC → bascule simple↔multi sans rebuild complet.
        const W = dc.width_mm || 4000, D = dc.depth_mm || 3000, H = Math.max(this.zRef(dc) || 0, 1000);
        multi = { center: { x: W / 2, y: D / 2, z: H / 2 }, extent: Math.max(W, D, H, 2000), rooms: [{ dcId: dc.id, ox: W / 2, oy: D / 2, oz: 0, o: 0, w: W, d: D }] };
        this.routing.outgoingCableStubs(dc.id, this.cablePortNormal).forEach((st: any) => { if (!this.hidden3dRacks.has(st.portRackId)) push(st.cable, st.linePts, st.straight, st.stubAt); });   // stubs sortants → mur
        floorDecor = null;   // une seule salle : pas de décor d'étage
      }
    }
    return { multi, extraCables, floorDecor };
  }

  /** Décor d'étage (repère MONDE) à partir de la disposition `multiLayout` : plans, OOB posés, étiquettes. */
  protected webglFloorDecor(m: any): any {
    const shown = new Set(m.floorPlanes.map((fp: any) => (fp.loc || "") + "" + String(fp.floor || "")));
    const planes = m.floorPlanes.map((fp: any) => ({ W: fp.cfg.width_mm, D: fp.cfg.depth_mm, cell: fp.cfg.cell_mm || 600, ox: fp.off.x, oy: fp.off.y, z: fp.off.z, blocked: (fp.cfg.blocked_cells || []).slice() }));
    const oobs = this.store.oobWaypoints()
      .filter((wp: any) => shown.has((wp.location || "") + "" + String(wp.floor || "")))
      .map((wp: any) => { const w = this.floor.oobWorld(m, wp); return { id: wp.id, x: w.x, y: w.y, z: w.z, baseZ: FloorLayout.levelZ(m, FloorLayout.floorNum(String(wp.floor || ""))) }; });
    const levels = m.levels.map((lv: number, i: number) => ({ label: "Étage " + lv, x: -m.gap * 0.6, y: 0, z: m.levelZs ? m.levelZs[i] : i * (m.stackH + m.gap) }));
    const buildings = m.buildings.map((b: any, i: number) => ({ label: this.store.siteLabel(b.loc), x: (b.x0 + b.x1) / 2, y: -m.gap * 0.5, z: m.topZ / 2, sepX: i > 0 ? b.x0 - m.gap : null }));
    return { planes, oobs, levels, buildings, maxD: m.maxD, topZ: m.topZ };
  }

  /* ---- WebGL : tooltips + menus contextuels (remontés du moteur → réutilisent la machinerie SVG existante) ---- */
  protected _webglTipId: string | null = null;
  /** HTML de tooltip pour une cible WebGL (occ · rack · câble · wp · port), via les builders existants. */
  protected webglTipHtml(desc: any): string | null {
    const s = this.store;
    switch (desc.type) {
      case "occ": return desc.kind === "eq" ? this.equipmentTipHtml(desc.id) : (s.get("rackItems", desc.id) ? this.itemTipHtml(s.get("rackItems", desc.id)) : null);
      case "rack": { const r = s.get("racks", desc.id); return r ? this.rackTipHtml(r) : null; }
      case "cable": { const c = s.get("cables", desc.id); return c ? this.cableTipHtml(c) : null; }
      case "wp": { const w = s.get("waypoints", desc.id); return w ? this.wpTipHtml(w) : null; }
      case "port": { const p = s.get("ports", desc.id); return p ? this.portTipHtml(p, s.cableOnPort(p.id)) : null; }
    }
    return null;
  }
  protected webglTip(desc: any, x: number, y: number): void {
    if (!desc) { this.hideTip(); this._webglTipId = null; return; }
    const html = this.webglTipHtml(desc);
    if (!html) { this.hideTip(); this._webglTipId = null; return; }
    const ev: any = { clientX: x, clientY: y };
    if (desc.id !== this._webglTipId) { this.showTip(html, ev); this._webglTipId = desc.id; } else this.moveTip(ev);
  }
  /** Sections de menu contextuel pour une cible WebGL, via les builders existants. */
  protected webglContextMenu(desc: any, x: number, y: number): void {
    const s = this.store; let sections: any = null;
    switch (desc.type) {
      case "occ": sections = desc.kind === "eq" ? this.equipmentCtx(desc.id) : (s.get("rackItems", desc.id) ? this.itemCtx(s.get("rackItems", desc.id)) : null); break;
      case "rack": { const r = s.get("racks", desc.id); sections = r ? this.rackCtx(r) : null; break; }
      case "cable": { const c = s.get("cables", desc.id); sections = c ? this.cableCtx(c) : null; break; }
      case "wp": { const w = s.get("waypoints", desc.id); sections = w ? this.waypointCtx(w) : null; break; }
      case "port": { const p = s.get("ports", desc.id); sections = p ? this.portCtx(p, s.cableOnPort(p.id)) : null; break; }
      case "room": { const d = s.get("datacenters", desc.id); sections = d ? this.roomCtx(d) : null; break; }   // clic droit sur le sol d'un DC
      case "door": { const d = s.get("datacenters", desc.dcId); const dr = d && (d.doors || []).find((x: any) => x.id === desc.id); sections = (d && dr) ? this.doorTool.ctx(d, dr) : null; break; }
    }
    // appel DIRECT (pas via `ctxMenu`, qui attend un vrai MouseEvent pour `stopPropagation`) : le moteur WebGL a
    // déjà filtré l'orbite via `_navMovedR` avant d'appeler ctxCb.
    if (sections && sections.length) { this.hideTip(); this._webglTipId = null; ContextMenu.show(x, y, sections); }
  }

  protected renderWebGL(dc: any): void {
    this._webglRev = this.store.histIndex();   // état de données reflété par ce (re)build → repère pour éviter un rebuild au simple retour
    // hôte PERSISTANT : on garde le même conteneur (et donc le canvas) entre les re-rendus de données,
    // pour ne pas réinitialiser la caméra ni recréer le contexte WebGL à chaque toggle.
    let hostDiv = this._webglHost;
    if (!hostDiv || hostDiv.parentElement !== this.stage) {
      this.clearStage(); this.svg = null;   // retire l'éventuelle scène SVG
      hostDiv = document.createElement("div");
      hostDiv.className = "dc-webgl-host";
      hostDiv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:hidden";
      this.stage.insertBefore(hostDiv, this.stage.firstChild);
      this._webglHost = hostDiv;
    }
    // import DYNAMIQUE eager (cf. en-tête) : inliné dans le bundle, mais non chargé par la chaîne require() CJS des tests.
    const opts = this.webglOptions(), ctx = this.webglCtx(), persp = this.webglPerspective, dcId = dc.id;
    const doMount = (): Promise<void> => import(/* webpackMode: "eager" */ "./three/DcThreeScene").then(({ DcThreeScene }) => {
      if (this._webglHost !== hostDiv) return;   // un re-rendu a remplacé l'hôte entre-temps → abandon
      if (!this._three) {
        this._three = new DcThreeScene(this.store, this.host);
        this._three.tipCb = (d: any, x: number, y: number) => this.webglTip(d, x, y);            // tooltips
        this._three.ctxCb = (d: any, x: number, y: number) => this.webglContextMenu(d, x, y);   // menus contextuels
        // outils interactifs (mesure / routage) — le moteur remonte les clics/survols, la vue tient l'état + le panneau.
        this._three.measurePlaceCb = (w: any) => this.onWebglMeasurePlace(w);
        this._three.measureHoverCb = (w: any, x: number, y: number) => this.onWebglMeasureHover(w, x, y);
        this._three.routePickCb = (desc: any) => this.onWebglRoutePick(desc);
        this._three.routeHoverCb = (w: any) => this.onWebglRouteHover(w);
      }
      this._three.setProjection(persp);                       // projection choisie
      this._three.mount(hostDiv, dcId, opts, ctx);            // (ré)attache + reconstruit (mono/multi + câbles transversaux)
      this.syncWebglTool();                                   // (ré)applique le mode outil + l'overlay courant
      this.applyFocus3D();                                    // « Localiser » : pousse la cible caméra au moteur
    });
    // INDICATEUR DE CHARGEMENT généralisé pour les (re)builds 3D COÛTEUX. Le build (mount) est SYNCHRONE et gèle le
    // thread (≈ plusieurs centaines de ms sur une grosse salle) → un simple clic « changer de vue » paraît figé. On
    // affiche l'overlay AVANT le gel, on laisse le navigateur PEINDRE (double rAF), puis on construit, et on efface.
    // Même mécanique que le reload SSE. Sauté pour les petites scènes (build imperceptible → pas de flash inutile) ;
    // TOUJOURS montré au 1er passage en 3D (chargement du moteur + build initial, le plus lent).
    if (Notify.isBusy()) {
      doMount();   // un appelant gère déjà l'overlay (ex. reload SSE : il l'affiche et l'efface lui-même) → ne pas doubler
    } else if (!this._three || this.build3DIsHeavy(dc)) {
      Notify.busy("Rendu 3D…");
      requestAnimationFrame(() => requestAnimationFrame(() => { doMount().finally(() => Notify.idle()); }));
    } else {
      doMount();
    }
  }

  /** Le prochain (re)build 3D vaut-il un indicateur de chargement ? Coût estimé bon marché (baies + occupants +
      équipements libres des salles affichées) : au-delà du seuil, le build synchrone se voit à l'écran. Seuil ajustable. */
  protected build3DIsHeavy(dc: any): boolean {
    try {
      let cost = 0;
      for (const id of this.displayedDcIds(dc)) {
        const racks = this.racks(id);
        cost += racks.length * 2;
        for (const r of racks) cost += this.store.equipmentsOfRack(r.id).length;   // occupants = le gros du coût de build
        cost += this.store.freeEquipsOfDc(id).length * 2;
        if (cost >= 12) return true;
      }
      return false;
    } catch { return false; }
  }

  /* =============================================================================
     Panneau latéral — orchestrateur + cartes (réplique OO de renderSide du monolithe).
     3D  : Datacenters (portée/Vue étage) · Racks · Câbles · Vue 3D.
     Dessus : Sélection · Racks dispo (pool) · Équipements libres (pool) · Câbles.
     Cartes repliables (état `expanded`, repliées par défaut sauf déplis explicites).
     ============================================================================= */

  /** Oublie l'état restauré → la prochaine activation repart des défauts (après reset des préférences). */
  resetView(): void { this._restoredKey = null; }

  /** Changement de thème : les vues 2D (SVG/CSS) se mettent à jour seules ; le moteur 3D WebGL relit le thème et
      remappe les couleurs de ses matériaux EN PLACE (pas de reconstruction de la scène). */
  onThemeChanged(): void { if (this._three) this._three.applyThemeChange(); }


  /* ---- persistance de l'état de vue (par fichier, localStorage) ---- */
  protected viewStateKey(): string { return "dcmanager.view3d." + ((this.store.meta && this.store.meta.fileId) ? this.store.meta.fileId : "__nofile"); }
  protected static readonly TOGGLE_KEYS = ["hideFrontEq", "hideRearEq", "showPlaceholders", "showRackSides", "showPorts", "showEqNames", "showAllCables", "showWaypoints", "showConduits", "showOrientMarks", "showPivot", "showFloorAnchor", "showFaceImages", "showDoors", "showDoorSwing", "showFloorGrid", "cablePortNormal", "webglPerspective", "cablesOnTop", "showFigure"];

  /** Écrit l'état (débouncé 300 ms) — évite une écriture par frame de pan/zoom. */
  protected persistView(): void {
    clearTimeout(this._pvTO);
    this._pvTO = setTimeout(() => {
      try {
        const o: any = { view: this.view, dcId: this.dcId, az: this.az, el: this.el, scale: this.scale, tx: this.tx, ty: this.ty, camTarget: this.camTarget, hidden3dRacks: [...this.hidden3dRacks], hidden3dEquips: [...this.hidden3dEquips], figure: this.figure, colorMode: this.colorMode, cableSplineK: this.cableSplineK, markerScale: this.markerScale, multiDc: this.multiDc, visibleDcIds: [...this.visibleDcIds], visibleSites: [...this.visibleSites], floorTarget: this.floorTarget };
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
    this.showOrientMarks = true; this.showPivot = false; this.showFloorAnchor = true; this.showFaceImages = true; this.showDoors = true; this.showDoorSwing = false; this.showFloorGrid = true; this.cablePortNormal = false;
    this.useWebGL = true; this.webglPerspective = false; this.cablesOnTop = true;   // WebGL = unique moteur 3D ; projection/cables-on-top restaurés depuis TOGGLE_KEYS
    this.colorMode = "face"; this.cableSplineK = CABLE_SPLINE_K; this.markerScale = 1;
    this.multiDc = false; this.visibleDcIds = new Set(); this.visibleSites = new Set();
    this.floorTarget = null; this.selRoomId = null; this.selFloorEquip = null; this.routeBuild = null; this.measure = null;
    this.selCables = new Set(); this.searchTerm = ""; this.focusEqId = null; this.focusPortId = null;
    this.view = (o.view === "top" || o.view === "floor") ? o.view : "3d";
    // toggles persistés
    DcBase.TOGGLE_KEYS.forEach((k) => { if (typeof o[k] === "boolean") (this as any)[k] = o[k]; });
    if (o.colorMode === "face" || o.colorMode === "group" || o.colorMode === "type") this.colorMode = o.colorMode;
    if (typeof o.cableSplineK === "number") this.cableSplineK = Math.max(0, Math.min(0.32, o.cableSplineK));
    if (typeof o.markerScale === "number") this.markerScale = Math.max(0.25, Math.min(1.75, o.markerScale));
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
    this.hidden3dEquips = new Set((Array.isArray(o.hidden3dEquips) ? o.hidden3dEquips : []).filter((id: string) => has("equipments", id)));
    // personnage d'échelle (repère personnel) : position restaurée si présente et bien formée
    const f = o.figure;
    this.figure = (f && typeof f === "object" && typeof f.dcX === "number") ? { dcX: +f.dcX, dcY: +f.dcY, orient: Normalize.rackOrientation(f.orient), floorX: typeof f.floorX === "number" ? +f.floorX : 0, floorY: typeof f.floorY === "number" ? +f.floorY : 0 } : null;
    // multi-salles + salles visibles (failsafe : seulement les salles encore présentes)
    this.multiDc = o.multiDc === true;
    this.visibleDcIds = new Set((Array.isArray(o.visibleDcIds) ? o.visibleDcIds : []).filter((id: string) => has("datacenters", id)));
    this.visibleSites = new Set((Array.isArray(o.visibleSites) ? o.visibleSites : []).filter((id: string) => has("sites", id)));
    if (o.floorTarget && typeof o.floorTarget === "object" && "location" in o.floorTarget) this.floorTarget = { location: o.floorTarget.location || "", floor: String(o.floorTarget.floor != null ? o.floorTarget.floor : "") };
  }

}

/* Fusion de déclaration : la chaîne d'héritage répartit les méthodes sur plusieurs classes, mais à
   l'exécution `this` est l'instance finale `DatacenterView` qui les possède toutes. Cette signature
   d'index (héritée par toutes les couches) autorise les appels croisés `this.x()` entre couches. */
export interface DcBase { [key: string]: any; }
