/* =============================================================================
   Moteur 3D WebGL (Three.js) PARALLÈLE au moteur SVG — découpé en chaîne d'héritage
   (un seul `this`, comme la vue SVG) :
     - DcThreeBase   : état + cycle de vie (mount/dispose/render à la demande) +
                       thème (variables CSS) + helpers de mesh génériques.
     - DcThreeCamera : caméra orbitale ortho/perspective + interaction + picking.
     - DcThreeScene  : construction du CONTENU (baies, occupants, libres, câbles,
                       waypoints) + diff d'options (reconstruction partielle).
   Réutilise la couche géométrie déjà portée (RackGeometry / RackScene / Resolver3D…).
   Repère MONDE (identique au SVG) : X = largeur, Y = profondeur, Z = hauteur (sol z=0).
   ============================================================================= */
import * as THREE from "three";
import type { Store } from "../../../store";
import { Color } from "../../../core/Color";
import { RackScene } from "../../../geometry/RackScene";
import { Resolver3D } from "../../../geometry/Resolver3D";
import { CableRouting } from "../../../geometry/CableRouting";
import { FloorLayout } from "../../../geometry/FloorLayout";
import type { DatacenterHost } from "../shared";

/** Couleurs de thème lues une fois depuis les variables CSS (fallbacks si absentes). */
export interface Theme { bg: number; floor: number; grid: number; line: number; rack: number; fg: number; front: number; doorMetal: number; doorPanel: number; }

/** Placement d'une salle dans le repère MONDE : centre (ox,oy,oz), orientation o (rad), dims (w×d). */
export interface RoomDesc { dcId: string; ox: number; oy: number; oz: number; o: number; w: number; d: number; }

/** Câble transversal en repère MONDE : polyligne `line` + indices `straight` (segments droits) + amorces ⊥
    `stubAt` (tangente G1 imposée) + couleur. */
export interface ExtraCable { id: string; color: string | null; line: { x: number; y: number; z: number }[]; straight: number[]; stubAt?: number[]; power?: boolean; }

/** Décor multi-salles (repère MONDE) : plans d'étage, OOB, étiquettes étage/bâtiment. */
export interface FloorPlaneDesc { W: number; D: number; cell: number; ox: number; oy: number; z: number; blocked: string[]; }
export interface FloorOobDesc { id: string; x: number; y: number; z: number; baseZ: number; }
export interface FloorLabelDesc { label: string; x: number; y: number; z: number; sepX?: number | null; }
export interface FloorDecor { planes: FloorPlaneDesc[]; oobs: FloorOobDesc[]; levels: FloorLabelDesc[]; buildings: FloorLabelDesc[]; maxD: number; topZ: number; }

/** Contexte de scène poussé par DcBase au moteur (mono/multi + câbles transversaux + décor d'étage). */
export interface SceneCtx { multi: { center: { x: number; y: number; z: number }; extent: number; rooms: RoomDesc[] } | null; extraCables: ExtraCable[]; floorDecor: FloorDecor | null; }

/** Options d'affichage poussées par le panneau/toolbar (sous-ensemble IMPLÉMENTÉ par le moteur WebGL ;
    les autres réglages restent sans effet — assumé). */
export interface DcThreeOptions {
  hideFrontEq: boolean; hideRearEq: boolean;
  colorMode: "face" | "group" | "type";
  showAllCables: boolean; selCables: Set<string>;
  hiddenRacks: Set<string>;   // baies masquées (hidden3dRacks) — bascule de visibilité du groupe de baie + ses ports
  hiddenEquips: Set<string>;  // équipements LIBRES masqués (hidden3dEquips) — non construits (rebuildFree au changement)
  showFigure: boolean;        // personnage d'échelle (repère personnel, vue seule)
  figure: { dcX: number; dcY: number; orient: number; floorX: number; floorY: number } | null;
  showWaypoints: boolean; showConduits: boolean;
  cableSplineK: number;   // tension du spline cardinal des câbles (1/6 ≈ défaut)
  cablePortNormal: boolean;   // sortie ⊥ des ports : amorce droite de 20 mm le long de la normale avant l'arrondi
  showEqNames: boolean;   // noms d'équipement posés à plat sur la face
  showRackSides: boolean; // capots/parois : true = coque OPAQUE (baie fermée) · false = translucide (on voit dedans)
  showPorts: boolean;     // connecteurs de ports posés à plat sur les faces
  showDoors: boolean;     // portes des baies (panneaux en saillie + charnière)
  showDoorSwing: boolean; // projection 2D au sol du débattement (rayon d'ouverture) des portes
  showPlaceholders: boolean;  // emplacements U libres (cibles d'assignation cliquables)
  showFloorGrid: boolean; // grilles des plans d'étage (multi-salles)
  showOrientMarks: boolean;   // liserés/repères d'orientation (front)
  showPivot: boolean;     // marqueur du CENTRE DE ROTATION de la caméra (croix + anneau, taille écran constante)
  markerScale: number;    // facteur de taille des marqueurs de waypoint (taille ÉCRAN constante)
  cablesOnTop: boolean;   // câbles toujours au-dessus des équipements/baies (depthTest off) — défaut activé
  showFaceImages: boolean;   // images de façade plaquées sur les faces des équipements
  powerBoltSpacingMm: number;   // espacement des éclairs le long des câbles d'alimentation
}

export class DcThreeBase {
  protected store: Store;
  protected host: DatacenterHost;
  protected scene3d: RackScene;
  protected resolver: Resolver3D;
  protected routing: CableRouting;   // routage partagé (amorces ⊥, conduits) — réutilisé par le tracé des câbles

  protected host_el: HTMLElement | null = null;
  protected renderer: THREE.WebGLRenderer | null = null;
  protected scene: THREE.Scene | null = null;
  protected camera: THREE.OrthographicCamera | THREE.PerspectiveCamera | null = null;
  perspective = false;                                // projection : false = orthographique (défaut) · true = perspective
  protected fov = 35;                                 // champ de vision (perspective)
  protected content: THREE.Group | null = null;       // contenu de la salle (jeté/reconstruit par build)
  protected ro: ResizeObserver | null = null;
  protected raf = 0;                                  // RAF en attente (0 = aucune) — rendu à la demande
  protected texCache = new Map<string, THREE.CanvasTexture>();   // textures de libellés mises en cache (clé texte+dims)
  protected imgTexCache = new Map<string, THREE.Texture>();      // textures d'IMAGES de façade par URL → réutilisées d'un build à l'autre (pas de rechargement), libérées au dispose
  protected faceUrlsInLastBuild = new Set<string>();            // URLs d'images RÉELLEMENT posées au dernier build() COMPLET → base de l'éviction des textures périmées

  // sous-groupes DÉDIÉS par catégorie → reconstruction PARTIELLE (un toggle ne refait que sa catégorie).
  protected gDecor: THREE.Group | null = null;        // sols + grilles (par salle) — rebuild plein seulement
  protected gRacks: THREE.Group | null = null;
  protected gFree: THREE.Group | null = null;
  protected gWaypoints: THREE.Group | null = null;
  protected cablesGroup: THREE.Group | null = null;   // = gCables
  protected builtDc: string | null = null;            // salle de la dernière construction (pour rebuild partiel)
  /** Descripteur MULTI-SALLES (null = mono-salle). Posé par DcBase : { center, extent, rooms[] } en repère MONDE. */
  protected multiInfo: { center: { x: number; y: number; z: number }; extent: number; rooms: RoomDesc[] } | null = null;
  protected rooms: RoomDesc[] = [];                    // salles AFFICHÉES (mono = 1)
  // CACHE CHAUD : les salles qui sortent du champ sont MASQUÉES (visible=false), pas détruites → bascule
  // simple↔multi / changement de portée instantanée (réveil au lieu de reconstruction). Borné par éviction LRU.
  protected _warm = new Map<string, number>();         // dcId d'une salle CONSTRUITE (visible ou masquée) → tick LRU
  protected _warmTick = 0;
  protected _warmCap = 16;
  /** Câbles TRANSVERSAUX en repère MONDE, calculés par DcBase (routes inter-DC en multi · stubs sortants en mono).
      Le moteur ne fait que tracer les tubes — la logique de routage reste côté SVG (réutilisée). */
  protected extraCables: ExtraCable[] = [];
  protected gExtra: THREE.Group | null = null;         // groupe des câbles transversaux (repère monde)
  protected floorDecor: FloorDecor | null = null;      // décor multi-salles (plans d'étage, OOB, étiquettes)
  protected gFloorDecor: THREE.Group | null = null;
  protected _screenObjs: THREE.Object3D[] = [];        // marqueurs à TAILLE ÉCRAN constante (rescalés par frame)
  // callbacks remontés à la VUE (tooltips + menus contextuels réutilisent la machinerie SVG existante).
  tipCb: ((desc: any, x: number, y: number) => void) | null = null;
  ctxCb: ((desc: any, x: number, y: number) => void) | null = null;
  protected _navMovedR = false;   // un glisser DROIT (orbite) vient d'avoir lieu → ne pas ouvrir le menu contextuel
  protected _texLoader: THREE.TextureLoader | null = null;   // chargeur d'images de façade (objectURL → texture)
  protected _epoch = 0;                                // incrémenté à chaque (re)construction de baies → invalide les chargements async périmés
  protected theme!: Theme;                             // thème de la dernière construction (réutilisé par les rebuilds partiels)
  protected cableRaf = 0;                              // RAF coalescée pour le rebuild des seuls câbles

  // caméra orbitale (mêmes angles que project3DCam du moteur SVG : azimut autour de Z, puis élévation)
  protected az = -0.62;
  protected el = 0.46;
  protected zoom = 1;                                 // facteur de zoom ortho
  protected target = new THREE.Vector3();
  protected baseHalf = 1000;                          // demi-hauteur du frustum à zoom = 1 (cadrage initial)
  protected radius = 1;                               // distance caméra↔cible (ortho : n'affecte que near/far)
  protected framedDc: string | null = null;           // salle déjà cadrée (les re-rendus de données ne réinitialisent pas la caméra)
  protected frameArgs: [number, number, number, number, number, number] | null = null;   // derniers args de cadrage

  // options d'affichage (poussées par DcBase ; défauts = tout visible)
  protected opts: DcThreeOptions = { hideFrontEq: false, hideRearEq: false, colorMode: "face", showAllCables: true, selCables: new Set(), hiddenRacks: new Set(), hiddenEquips: new Set(), showFigure: false, figure: null, showWaypoints: true, showConduits: true, cableSplineK: 1 / 6, cablePortNormal: false, showEqNames: true, showRackSides: false, showPorts: true, showDoors: true, showDoorSwing: false, showPlaceholders: true, showFloorGrid: true, showOrientMarks: true, showPivot: false, markerScale: 1, cablesOnTop: true, showFaceImages: true, powerBoltSpacingMm: 300 };
  protected _pivot: THREE.Sprite | null = null;   // marqueur du centre de rotation (sprite billboard, taille écran constante)
  // FOCUS « Localiser » : cible caméra demandée par la vue (centre + emprise). Appliquée juste avant le rendu,
  // donc APRÈS le cadrage par défaut d'un éventuel (re)build → le focus prime. En attente tant que la scène n'est pas prête.
  protected pendingFocus: { p: { x: number; y: number; z: number }; extent: number; face: { az: number; el: number } | null } | null = null;
  protected _focusObjs: THREE.Object3D[] = [];   // meshes de l'équipement « localisé » sous surbrillance persistante

  // glisser (avec détection clic-vs-glisser pour le picking) — `slotsel` = sélection multiple d'emplacements U libres
  protected drag: { mode: "orbit" | "pan" | "slotsel"; x: number; y: number; downX: number; downY: number; btn: number; moved: boolean } | null = null;
  // sélection multiple d'emplacements U libres (glisser vertical) : plage CONTIGUË [lo,hi] de la même baie+face.
  protected slotSel: { rackId: string; side: string; anchor: number; lo: number; hi: number; slots: Map<number, THREE.Object3D>; meshes: THREE.Object3D[] } | null = null;
  // picking
  protected raycaster = new THREE.Raycaster();
  protected ndc = new THREE.Vector2();
  protected hovered: THREE.Object3D | null = null;    // élément survolé (mis en évidence) — mesh ou sprite
  protected _hoverObjs: THREE.Object3D[] = [];        // objets actuellement surlignés (un câble en regroupe plusieurs)

  // ---- OUTILS interactifs (mesure / routage) pilotés par la vue (DcBase) ----
  // Le moteur intercepte clic/survol selon `toolMode` (clic = poser/choisir, glisser = navigation préservée) et
  // dessine l'overlay dans `gOverlay` (groupe PERSISTANT, hors `content` → survit aux reconstructions de données).
  toolMode: "none" | "measure" | "route" = "none";
  protected gOverlay: THREE.Group | null = null;
  protected _groundPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);   // plan du sol z=0 (repli de raycast)
  protected measurePts: { x: number; y: number; z: number }[] = [];
  protected measureCursor: { x: number; y: number; z: number } | null = null;
  protected measureDone: { x: number; y: number; z: number }[][] = [];   // mesures TERMINÉES conservées (session)
  protected measureHi: number | null = null;   // index de la mesure terminée mise en évidence (survol listing), ou null
  protected routePts: { x: number; y: number; z: number }[] = [];
  protected routeCursor: { x: number; y: number; z: number } | null = null;
  // callbacks moteur → vue : placement/survol mesure (point monde) ; clic/survol route (cible pick / point monde).
  measurePlaceCb: ((world: { x: number; y: number; z: number }) => void) | null = null;
  measureHoverCb: ((world: { x: number; y: number; z: number } | null, clientX: number, clientY: number) => void) | null = null;
  routePickCb: ((desc: any) => void) | null = null;
  routeHoverCb: ((world: { x: number; y: number; z: number } | null) => void) | null = null;

  constructor(store: Store, host: DatacenterHost = {}) {
    this.store = store; this.host = host; this.scene3d = new RackScene(store); this.resolver = new Resolver3D(store);
    this.routing = new CableRouting(store, this.resolver, new FloorLayout(store));
    (this.raycaster.params as any).Line2 = { threshold: 18 };   // tolérance de picking des câbles (resserrée → clic plus précis)
  }

  /* ---- thème (variables CSS → couleurs Three) ---- */
  protected readTheme(): Theme {
    const def: Theme = { bg: 0x0e1116, floor: 0x1b2230, grid: 0x2c3647, line: 0x3a4658, rack: 0x445066, fg: 0xc8d2e0, front: 0x4ea1ff, doorMetal: 0x59616e, doorPanel: 0x767f8d };
    if (typeof document === "undefined") return def;
    const cs = getComputedStyle(document.body);
    const col = (name: string, fallback: number): number => {
      const v = cs.getPropertyValue(name).trim();
      const c = v ? Color.cssToHex(v) : NaN;
      return isFinite(c) ? c : fallback;
    };
    const bg = col("--bg", 0x0a0a0a);
    const light = (((bg >> 16) & 255) + ((bg >> 8) & 255) + (bg & 255)) / 3 > 128;   // thème clair = fond lumineux
    return {
      bg,
      floor: col("--bg-2", 0x1b2230),
      grid: col("--line", 0x2c3647),
      line: col("--line", 0x3a4658),
      rack: col("--bg-3", 0x445066),
      fg: col("--fg", 0xc8d2e0),
      front: col("--accent", 0x4ea1ff),
      // portes de baie : métal + panneau perforé, déclinés clair/sombre (sinon trop sombres sur fond clair).
      doorMetal: light ? 0x868d97 : 0x59616e,
      doorPanel: light ? 0x9aa0aa : 0x767f8d,
    };
  }


  /* ---- cycle de vie ---- */
  mount(container: HTMLElement, dcId: string | null, opts?: DcThreeOptions, ctx?: SceneCtx): void {
    if (opts) this.opts = opts;
    this.multiInfo = ctx ? ctx.multi : null;
    this.extraCables = ctx ? ctx.extraCables : [];
    this.floorDecor = ctx ? ctx.floorDecor : null;
    if (!this.renderer) {
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this.renderer = renderer;
      renderer.domElement.style.cssText = "display:block;width:100%;height:100%;outline:none";
      this.scene = new THREE.Scene();
      this.makeCamera();
      this.bindEvents(renderer.domElement);
    }
    // (ré)attache le canvas au conteneur courant + observe ses redimensionnements (le conteneur peut changer
    //  entre deux activations ; le canvas/renderer, lui, persiste).
    if (this.host_el !== container) {
      if (this.ro) this.ro.disconnect();
      this.host_el = container;
      this.ro = new ResizeObserver(() => { this.resize(); this.request(); });
      this.ro.observe(container);
    }
    if (this.renderer.domElement.parentElement !== container) container.appendChild(this.renderer.domElement);
    this.build(dcId);
    this.resize();
    this.request();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf); this.raf = 0;
    cancelAnimationFrame(this.cableRaf); this.cableRaf = 0;
    window.removeEventListener("mousemove", this.onMove);
    window.removeEventListener("mouseup", this.onUp);
    if (this.ro) { this.ro.disconnect(); this.ro = null; }
    this.disposeContent();
    this.texCache.forEach((t) => t.dispose()); this.texCache.clear();   // libère les textures de libellés mises en cache
    this.imgTexCache.forEach((t) => t.dispose()); this.imgTexCache.clear();   // libère les textures d'images de façade
    if (this.renderer) {
      this.renderer.dispose();
      const el = this.renderer.domElement;
      if (el.parentElement) el.parentElement.removeChild(el);
      this.renderer = null;
    }
    // Le marqueur de pivot vit sous `scene` (PAS sous `content`) → non couvert par disposeContent : on libère son
    // matériau ET sa texture (CanvasTexture propre) ici, sinon fuite GPU à chaque unmount/remount de la vue 3D.
    if (this._pivot) {
      this.scene?.remove(this._pivot);
      const m: any = this._pivot.material;
      if (m) { if (m.map) m.map.dispose(); m.dispose?.(); }
      this._pivot = null;
    }
    this.scene = null; this.camera = null; this.host_el = null;
  }

  protected disposeContent(): void {
    this.hovered = null; this._hoverObjs = []; this.cablesGroup = null; this.gRacks = null; this.gFree = null; this.gWaypoints = null; this.gDecor = null; this.gExtra = null; this.gFloorDecor = null;
    this._warm.clear();   // les groupes de salle vivent sous `content` (détruit ici) → cache chaud réinitialisé
    if (this.content && this.scene) this.scene.remove(this.content);
    // NB : on ne libère PAS les textures (`material.map`) ici — elles sont détenues par `texCache` et
    // réutilisées d'un rebuild à l'autre (libérées seulement au `dispose` final).
    this.content?.traverse((o: any) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { const m = o.material; (Array.isArray(m) ? m : [m]).forEach((mm: any) => { if (o.userData && o.userData.ownTex && mm.map) mm.map.dispose(); mm.dispose && mm.dispose(); }); }
    });
    this.content = null;
  }

  /** Vide un groupe et libère la géométrie/les matériaux de ses enfants (textures détenues par texCache). */
  protected disposeGroup(g: THREE.Group): void {
    g.traverse((o: any) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { const m = o.material; (Array.isArray(m) ? m : [m]).forEach((mm: any) => { if (o.userData && o.userData.ownTex && mm.map) mm.map.dispose(); mm.dispose && mm.dispose(); }); }
    });
    g.clear();
  }

  protected resize(): void {
    const el = this.host_el, r = this.renderer; if (!el || !r) return;
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
    r.setSize(w, h, false);
    // les LineMaterial (câbles épais) ont besoin de la résolution écran pour une largeur en pixels correcte
    this.content?.traverse((o: any) => { const m = o.material; if (m && m.isLineMaterial && m.resolution) m.resolution.set(w, h); });
    this.updateCamera();
  }

  /* ---- rendu À LA DEMANDE ----
     Pas de boucle RAF perpétuelle : une frame n'est calculée que sur un vrai changement (caméra, survol,
     options, resize). Hors interaction → zéro travail GPU/CPU. Une seule RAF en attente à la fois. */
  protected request(): void {
    if (this.raf || !this.renderer) return;
    this.raf = requestAnimationFrame(this.renderFrame);
  }
  protected renderFrame = (): void => {
    this.raf = 0;
    if (this.pendingFocus) this.applyPendingFocus();   // applique le focus « Localiser » après tout (re)cadrage
    if (this.renderer && this.scene && this.camera) this.renderer.render(this.scene, this.camera);
  };

  /* ---- helpers de mesh génériques (réutilisés par la couche scène) ---- */
  /** Grille au sol (lignes sur les mailles). */
  protected gridLines(W: number, D: number, cell: number, color: number): THREE.LineSegments {
    const pts: number[] = [];
    for (let x = 0; x <= W + 0.5; x += cell) { pts.push(x, 0, 0, x, D, 0); }
    for (let y = 0; y <= D + 0.5; y += cell) { pts.push(0, y, 0, W, y, 0); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 });
    return new THREE.LineSegments(geo, mat);
  }

  /** Boîte pleine en coords LOCALES (+ arêtes), ajoutée au groupe ; userData.pick optionnel. */
  protected localBox(group: THREE.Group, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: number, pick?: any, extra?: any): void {
    const sx = Math.abs(x1 - x0), sy = Math.abs(y1 - y0), sz = Math.abs(z1 - z0);
    if (sx <= 0 || sy <= 0 || sz <= 0) return;
    const geo = new THREE.BoxGeometry(sx, sy, sz);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.15 }));
    mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    mesh.userData = Object.assign({}, pick ? { pick } : null, extra);   // `extra` (layer/eqSide) → bascule de visibilité
    group.add(mesh);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }));
    e.position.copy(mesh.position); if (extra) e.userData = Object.assign({}, extra); group.add(e);   // arêtes : mêmes couche/côté
  }

  /* ---- étiquettes (noms d'équipement, à plat sur la face) ---- */
  /** Texture canvas d'un libellé (texte clair sur fond translucide), mise en cache (clé texte+dims). */
  protected textTexture(text: string, wMm: number, hMm: number): THREE.CanvasTexture | null {
    if (typeof document === "undefined") return null;
    const cw = 512, ch = Math.max(64, Math.min(512, Math.round(cw * hMm / Math.max(1, wMm))));
    const key = text + "|" + ch;   // même texte + même hauteur de canvas → texture réutilisée (pas de re-rasterisation)
    const cached = this.texCache.get(key);
    if (cached) return cached;
    const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
    const g = cv.getContext("2d"); if (!g) return null;
    // fond pilule sombre translucide pour le contraste
    g.fillStyle = "rgba(12,16,22,0.55)";
    const pad = 10, rr = Math.min(28, ch / 3);
    g.beginPath(); g.moveTo(pad + rr, pad);
    g.arcTo(cw - pad, pad, cw - pad, ch - pad, rr); g.arcTo(cw - pad, ch - pad, pad, ch - pad, rr);
    g.arcTo(pad, ch - pad, pad, pad, rr); g.arcTo(pad, pad, cw - pad, pad, rr); g.closePath(); g.fill();
    // texte ajusté à la largeur
    let fs = Math.floor(ch * 0.5);
    g.fillStyle = "#e8eef7"; g.textAlign = "center"; g.textBaseline = "middle";
    const fit = (s: number) => { g.font = `600 ${s}px system-ui, sans-serif`; return g.measureText(text).width; };
    while (fs > 10 && fit(fs) > cw - 4 * pad) fs -= 2;
    g.fillText(text, cw / 2, ch / 2);
    const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4; tex.needsUpdate = true;
    this.texCache.set(key, tex);
    return tex;
  }

  /** Texture (mutualisée) d'un LOSANGE blanc à CENTRE NOIR — teintée par la couleur du sprite (marqueur waypoint). */
  protected diamondTexture(): THREE.CanvasTexture | null {
    if (typeof document === "undefined") return null;
    const key = "##diamond"; const cached = this.texCache.get(key); if (cached) return cached;
    const s = 64, cv = document.createElement("canvas"); cv.width = cv.height = s;
    const g = cv.getContext("2d"); if (!g) return null;
    const dia = (cx: number, cy: number, r: number, fill: string) => { g.beginPath(); g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy); g.closePath(); g.fillStyle = fill; g.fill(); };
    dia(s / 2, s / 2, s / 2 - 2, "#ffffff");   // losange blanc (teinté par la couleur du sprite)
    dia(s / 2, s / 2, s * 0.24, "#000000");    // centre noir
    const tex = new THREE.CanvasTexture(cv); tex.needsUpdate = true; this.texCache.set(key, tex); return tex;
  }

  /** Texture (mutualisée) d'un ÉCLAIR (power bolt) — glyphe jaune, billboardé le long des câbles d'alimentation. */
  protected boltTexture(): THREE.CanvasTexture | null {
    if (typeof document === "undefined") return null;
    const key = "##bolt"; const cached = this.texCache.get(key); if (cached) return cached;
    const s = 64, cv = document.createElement("canvas"); cv.width = cv.height = s;
    const g = cv.getContext("2d"); if (!g) return null;
    const k = s / 24, P = [[13, 1], [4, 14], [11, 14], [9, 23], [20, 9], [13, 9]];   // même tracé que .dc-power-bolt (24)
    g.beginPath(); g.moveTo(P[0][0] * k, P[0][1] * k);
    for (let i = 1; i < P.length; i++) g.lineTo(P[i][0] * k, P[i][1] * k);
    g.closePath(); g.fillStyle = "#ffd23a"; g.fill(); g.lineWidth = 2; g.strokeStyle = "#6b4e00"; g.stroke();
    const tex = new THREE.CanvasTexture(cv); tex.needsUpdate = true; this.texCache.set(key, tex); return tex;
  }

  /** Texture (mutualisée) du marqueur de CENTRE DE ROTATION : anneau + croix en pointillés (cf. SVG `.dc-cam-pivot`). */
  protected pivotTexture(): THREE.CanvasTexture | null {
    if (typeof document === "undefined") return null;
    const key = "##pivot"; const cached = this.texCache.get(key); if (cached) return cached;
    const s = 64, cv = document.createElement("canvas"); cv.width = cv.height = s;
    const g = cv.getContext("2d"); if (!g) return null;
    const c = s / 2, r = s * 0.27;
    g.strokeStyle = "#c8d2e0"; g.lineWidth = 2.5; g.setLineDash([4, 3]); g.lineCap = "round";
    g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.stroke();                                  // anneau
    g.beginPath(); g.moveTo(c - s * 0.45, c); g.lineTo(c + s * 0.45, c);                         // croix horizontale
    g.moveTo(c, c - s * 0.45); g.lineTo(c, c + s * 0.45); g.stroke();                            // croix verticale
    const tex = new THREE.CanvasTexture(cv); tex.needsUpdate = true; this.texCache.set(key, tex); return tex;
  }

  /** (Re)pose et dimensionne le marqueur de centre de rotation sur la cible caméra (taille ÉCRAN constante),
      ou le masque si l'option est désactivée. Appelé à chaque mise à jour de caméra (suit le pivot). */
  protected updatePivot(): void {
    if (!this.scene) return;
    if (!this.opts.showPivot) { if (this._pivot) this._pivot.visible = false; return; }
    if (!this._pivot || this._pivot.parent !== this.scene) {
      const tex = this.pivotTexture(); if (!tex) return;
      this._pivot = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false }));
      this._pivot.renderOrder = 30; this.scene.add(this._pivot);
    }
    this._pivot.visible = true;
    this._pivot.position.copy(this.target);
    this._pivot.scale.setScalar(46 * this.worldPerPixel());   // ~46 px à l'écran, quel que soit le zoom
  }

  /** Texture (mutualisée) d'un DISQUE plein blanc — teinté par la couleur du sprite (pastille de câble 2D). */
  protected circleTexture(): THREE.CanvasTexture | null {
    if (typeof document === "undefined") return null;
    const key = "##circle"; const cached = this.texCache.get(key); if (cached) return cached;
    const s = 64, cv = document.createElement("canvas"); cv.width = cv.height = s;
    const g = cv.getContext("2d"); if (!g) return null;
    g.beginPath(); g.arc(s / 2, s / 2, s / 2 - 2, 0, Math.PI * 2); g.fillStyle = "#ffffff"; g.fill();
    const tex = new THREE.CanvasTexture(cv); tex.needsUpdate = true; this.texCache.set(key, tex); return tex;
  }

  /** Texture d'alphaMap de PERFORATION (porte ventilée) : métal plein (blanc = opaque) percé d'une grille de
      trous (noir = alpha 0 → écartés via `alphaTest`). Partagée/caché ; mappée 1:1 sur le panneau (les trous
      suivent légèrement le format de la porte, ce qui reste crédible). */
  protected perfTexture(): THREE.CanvasTexture | null {
    if (typeof document === "undefined") return null;
    const key = "##perf"; const cached = this.texCache.get(key); if (cached) return cached;
    const s = 256, n = 18, cell = s / n, rw = cell * 0.5, rh = cell * 0.78;   // densité réduite + trous RECTANGULAIRES (fentes)
    const cv = document.createElement("canvas"); cv.width = cv.height = s;
    const g = cv.getContext("2d"); if (!g) return null;
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, s, s);
    g.fillStyle = "#000000";
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) g.fillRect((i + 0.5) * cell - rw / 2, (j + 0.5) * cell - rh / 2, rw, rh);
    const tex = new THREE.CanvasTexture(cv); tex.needsUpdate = true; this.texCache.set(key, tex); return tex;
  }

  /** Charge (async) une image de façade et la plaque sur une face verticale (avant = normale −Y ; arrière = +Y),
      en coords LOCALES. Le chargement est annulé si la scène a été reconstruite entre-temps (epoch / parent). */
  protected faceImagePlane(group: THREE.Group, url: string, x: number, y: number, z: number, w: number, h: number, front: boolean, extra?: any): void {
    if (typeof document === "undefined") return;
    const place = (tex: THREE.Texture): void => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
      mesh.position.set(x, y, z);
      // rotation pure (pas de scale/winding inversé) : avant normale −Y · arrière normale +Y NON miroir
      if (front) mesh.rotation.x = Math.PI / 2;
      else mesh.setRotationFromAxisAngle(new THREE.Vector3(0, 1, 1).normalize(), Math.PI);
      mesh.renderOrder = 1; mesh.userData = Object.assign({}, extra);   // PAS ownTex : texture détenue par imgTexCache
      mesh.visible = this.layerVisible(extra);
      group.add(mesh);
    };
    this.faceUrlsInLastBuild.add(url);   // marque cette URL « utilisée » (l'URL porte une version REST → change si l'image est remplacée)
    const cached = this.imgTexCache.get(url);
    if (cached) { place(cached); return; }   // déjà chargée → pose SYNCHRONE, aucun rechargement (rebuild instantané)
    if (!this._texLoader) this._texLoader = new THREE.TextureLoader();
    const epoch = this._epoch;
    this._texLoader.load(url, (tex) => {
      (tex as any).colorSpace = (THREE as any).SRGBColorSpace;
      this.imgTexCache.set(url, tex);   // cache → réutilisée aux reconstructions suivantes
      if (this._epoch !== epoch || !group.parent) return;   // (re)build entre-temps : texture conservée pour le prochain build
      place(tex); this.request();
    }, undefined, () => { /* échec de chargement → ignoré */ });
  }

  /** Éviction des textures de façade PÉRIMÉES après un build() COMPLET : libère (dispose) et retire du cache toute
      texture dont l'URL n'a pas été reposée par ce build. Couvre l'image remplacée (l'URL versionnée a changé →
      l'ancienne n'est plus demandée), l'image supprimée, et le changement de document. À n'appeler QU'APRÈS un build
      complet (toutes les faces reconstruites) : `faceUrlsInLastBuild` y est exhaustif. Les chemins INCRÉMENTAUX
      (applyRoomDelta) ne touchent pas au contenu d'image et ne doivent PAS élaguer (ensemble partiel). */
  protected pruneFaceTextureCache(): void {
    for (const [url, texture] of this.imgTexCache) {
      if (this.faceUrlsInLastBuild.has(url)) continue;
      texture.dispose();
      this.imgTexCache.delete(url);
    }
  }

  /** Pose un libellé À PLAT sur une face verticale (avant = normale −Y ; arrière = +Y), en coords LOCALES. */
  protected faceLabel(group: THREE.Group, text: string, x: number, y: number, z: number, w: number, h: number, front: boolean, extra?: any): void {
    const tex = this.textTexture(text, w, h); if (!tex) return;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    mesh.position.set(x, y, z);
    // ROTATION PURE (pas de scale → pas de winding inversé ni de miroir) : avant = normale −Y ; arrière = normale +Y,
    // texte droit et NON miroir (180° autour de l'axe (0,1,1) → right=−X = droite du spectateur arrière, up=+Z).
    if (front) mesh.rotation.x = Math.PI / 2;
    else mesh.setRotationFromAxisAngle(new THREE.Vector3(0, 1, 1).normalize(), Math.PI);
    mesh.userData = Object.assign({ layer: "name" }, extra);   // couche "name" (showEqNames) + côté éventuel (hideAv/Ar)
    group.add(mesh);
  }
}

/* Fusion de déclaration : la chaîne d'héritage répartit les méthodes sur plusieurs classes mais à
   l'exécution `this` est l'instance finale `DcThreeScene` qui les possède toutes. Cette signature
   d'index autorise les appels croisés `this.x()` entre couches (cf. moteur SVG `DcBase`). */
export interface DcThreeBase { [key: string]: any; }
