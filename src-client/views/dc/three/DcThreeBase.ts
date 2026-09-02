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
import { TrunkRouting } from "../../../geometry/TrunkRouting";
import { FloorLayout } from "../../../geometry/FloorLayout";
// Boîte de bornage du PIVOT d'orbite : le TYPE seul (effacé à la compilation). Le décor d'étage la
// transporte, la couche caméra la consomme — une seule définition pour les deux (principe n°3).
import type { PivotAabb } from "../../../geometry/PivotBounds";
import { PivotMarker } from "./PivotMarker";   // style + tracé PURS du marqueur de centre de rotation (thème, halo, cache)
import { FocusArrowMarker } from "./FocusArrowMarker";   // style + tracé PURS de la flèche de localisation (jumeau de PivotMarker)
import type { CableCurveStyle } from "../../../geometry/CableSpline";
import type { DatacenterHost } from "../shared";

/** Labels À PLAT (noms d'équipement ET de baie) : réglages PARTAGÉS entre couches (principe n°3, réutilisés par
    `faceLabel` en lot 1 et `rackShellLabels` en lot 2).
    - LABEL_OPACITY : translucidité du plan de texte → on VOIT l'image de façade (ou la paroi) au travers, tout en
      gardant le texte lisible. Sans opacité < 1, le plan opaque masquerait l'image sous-jacente strictement coplanaire.
    - FACE_LABEL_STANDOFF_MM : saillie du label d'ÉQUIPEMENT le long de la normale de sa face, en mm. La face empile
      DÉJÀ trois plans le long de la normale : image à 0,5 mm, et PORTS à 1,5 mm (`DcThreeScene`, `n * 1.5`). Le label
      doit se glisser ENTRE les deux (0,5 mm de saillie → label à 1,0 mm) : devant l'image (donc lisible par-dessus)
      MAIS derrière les ports (qui l'occultent proprement), sans être coplanaire d'aucun des deux → aucun z-fighting.
    - LABEL_STANDOFF_MM : saillie du label de BAIE sur la coque (flancs/toit) — là il n'y a ni image ni port en vis-à-vis,
      donc 1 mm (marge plus robuste au rasant sur les grands panneaux ; convention maison, cf. ports 1,5 mm / slots 2 mm). */
export const LABEL_OPACITY = 0.85;
export const FACE_LABEL_STANDOFF_MM = 0.5;
export const LABEL_STANDOFF_MM = 1;

/** Couleurs de thème lues une fois depuis les variables CSS (fallbacks si absentes). */
export interface Theme { bg: number; floor: number; grid: number; line: number; rack: number; fg: number; front: number; doorMetal: number; doorPanel: number; }

/** Placement d'une salle dans le repère MONDE : centre (ox,oy,oz), orientation o (rad), dims (w×d).
    `underfloorMm` (optionnel, > 0) = hauteur sous le faux-plancher → dalle technique bleutée `underfloorMm` mm sous le sol. */
export interface RoomDesc { dcId: string; ox: number; oy: number; oz: number; o: number; w: number; d: number; underfloorMm?: number; }

/** Câble transversal en repère MONDE : polyligne `line` + indices `straight` (segments droits) + amorces ⊥
    `stubAt` (tangente G1 imposée) + couleur. `kind: "trunk"` = FAISCEAU (trait plus épais, couleur neutre,
    clic → formulaire faisceau) — même canal transversal que les câbles (routes inter-DC / stubs sortants). */
export interface ExtraCable { id: string; color: string | null; line: { x: number; y: number; z: number }[]; straight: number[]; stubAt?: number[]; power?: boolean; kind?: "cable" | "trunk"; }

/** Décor multi-salles (repère MONDE) : plans d'étage, OOB, étiquettes étage/bâtiment. */
export interface FloorPlaneDesc { W: number; D: number; cell: number; ox: number; oy: number; z: number; blocked: string[]; loc: string; floor: string; }
export interface FloorOobDesc { id: string; x: number; y: number; z: number; baseZ: number; }
/** Étiquette posée dans le monde (billboard). Sert aux étiquettes d'ÉTAGE comme à celles de BÂTIMENT. */
export interface FloorLabelDesc { label: string; x: number; y: number; z: number; }
/** Équipement posé sur un ÉTAGE (`placement_mode: "floor"`), hors de toute salle. `x`/`y` = centre au sol en
    coords MONDE ; `baseZ` = Z du NIVEAU seul — la hauteur propre de l'équipement (`dc_z`) est rajoutée par la
    géométrie de boîte côté moteur, comme pour un équipement libre de salle (d'où l'absence de `z` ici). */
export interface FloorEquipDesc { id: string; x: number; y: number; baseZ: number; }
/** `floorLabels` = UNE étiquette par plan d'étage DESSINÉ (donc répétée sur chaque site), et non plus un
    jeu unique de niveaux globaux : depuis que les sites portent une position propre (doctrine §6.9), une
    colonne d'étiquettes plantée à l'origine du monde ne désignait plus aucun bâtiment en particulier. */
/** `world` = BORNES MONDE de la Vue étage : union des BANDES DE BÂTIMENT (XY) et hauteur du monde (Z), calculées
    par `DcBase.webglFloorDecor` via `PivotBounds.worldBounds`. Elles ne DESSINENT rien — elles donnent au bornage
    du pivot d'orbite un repère à la mesure de ce qu'on regarde, les salles seules ne décrivant plus le monde dès
    qu'on passe en Vue étage. ⚠ Ce n'est PAS le retour des `maxD`/`topZ` retirés au lot 9 avec le plan séparateur :
    ceux-là servaient à DESSINER un décor supprimé depuis ; ce champ-ci sert au REPÈRE de la caméra, un besoin
    différent — d'où un champ UNIQUE et nommé, plutôt que deux cotes éparses à recomposer chez le consommateur. */
export interface FloorDecor { planes: FloorPlaneDesc[]; oobs: FloorOobDesc[]; equips: FloorEquipDesc[]; floorLabels: FloorLabelDesc[]; buildings: FloorLabelDesc[]; world: PivotAabb | null; }

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
  cableSplineK: number;   // tension du spline cardinal des câbles (1/6 ≈ défaut) — pilote aussi le rayon max des congés (style « fillet »)
  cableCurveStyle: CableCurveStyle;   // style de tracé des câbles/faisceaux : spline uniforme · spline centripète · cordes arrondies (défaut)
  cablePortNormal: boolean;   // sortie ⊥ des ports : amorce droite de 20 mm le long de la normale avant l'arrondi
  showEqNames: boolean;   // noms d'équipement posés à plat sur la face
  showRackSides: boolean; // capots/parois : true = coque OPAQUE (baie fermée) · false = translucide (on voit dedans)
  showRackNames: boolean; // nom de baie posé à plat sur les flancs (±X) et le toit (+Z) — sauf baie sans capots
  showPorts: boolean;     // connecteurs de ports posés à plat sur les faces
  showDoors: boolean;     // portes des baies (panneaux en saillie + charnière)
  showRoomDoors: boolean; // portes de SALLE (value-objects `datacenters.doors`) : vantaux + listel + débattement — rendues en 2D ET 3D
  showDoorSwing: boolean; // projection 2D au sol du débattement (rayon d'ouverture) des portes
  showPlaceholders: boolean;  // emplacements U libres (cibles d'assignation cliquables)
  showFloorGrid: boolean; // grilles des plans d'étage (multi-salles)
  showOrientMarks: boolean;   // liserés/repères d'orientation (front)
  showPivot: boolean;     // marqueur du CENTRE DE ROTATION de la caméra (croix + anneau, taille écran constante)
  showFocusArrow: boolean;   // FLÈCHE de localisation : sprite billboard, taille écran constante, pointe posée sur l'objet localisé

  markerScale: number;    // facteur de taille des marqueurs de waypoint + pastilles (slider — s'applique aux DEUX modes)
  markerRealSize: boolean;   // true = taille RÉELLE (monde : waypoint 5 cm, pastille ⌀ 1 cm à 100 %) · false = taille ÉCRAN constante
  cablesOnTop: boolean;   // câbles toujours au-dessus des équipements/baies (depthTest off) — défaut activé
  showFaceImages: boolean;   // images de façade plaquées sur les faces des équipements
  powerBoltSpacingMm: number;   // espacement des éclairs le long des câbles d'alimentation
}

export abstract class DcThreeBase {
  protected store: Store;
  protected host: DatacenterHost;
  protected scene3d: RackScene;
  protected resolver: Resolver3D;
  protected routing: CableRouting;   // routage partagé (amorces ⊥, conduits) — réutilisé par le tracé des câbles
  protected trunks: TrunkRouting;    // routage des FAISCEAUX (uplinks de patch) — même mécanique, service dédié

  protected host_el: HTMLElement | null = null;
  protected renderer: THREE.WebGLRenderer | null = null;
  protected scene: THREE.Scene | null = null;
  protected camera: THREE.OrthographicCamera | THREE.PerspectiveCamera | null = null;
  perspective = false;                                // projection : false = orthographique (défaut) · true = perspective
  protected fov = 35;                                 // champ de vision (perspective)
  protected content: THREE.Group | null = null;       // contenu de la salle (jeté/reconstruit par build)
  protected ro: ResizeObserver | null = null;
  protected raf = 0;                                  // RAF en attente (0 = aucune) — rendu à la demande
  protected _hoverRaf = 0;                            // rAF de SURVOL en attente (0 = aucun) — au plus un raycast par frame
  protected _hoverClient: [number, number] | null = null;   // dernière position souris, consommée par le rAF de survol
  protected texCache = new Map<string, THREE.CanvasTexture>();   // textures de libellés mises en cache (clé texte+dims)
  protected texCacheTicks = new Map<string, number>();           // LRU des étiquettes : clé → tick du dernier usage (cf. pruneLabelTextureCache)
  protected texCacheTick = 0;
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
  // Boîte (monde) bornant le pivot d'orbite au repli « sol infini » (cf. PivotBounds +
  // DcThreeCamera.recenterPivotOnView). Son CONTENU dépend du REPÈRE, jamais du nombre de salles :
  // union des salles affichées en XY seul (repère salle), ou bandes de bâtiment × hauteur du monde
  // en XYZ (repère bâtiment = « Vue étage »). ÉCRITE par la couche scène à chaque (re)build, LUE par
  // la couche caméra ; null = aucun repère exploitable (bornage désactivé → comportement historique).
  protected pivotAabb: PivotAabb | null = null;
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
  protected opts: DcThreeOptions = { hideFrontEq: false, hideRearEq: false, colorMode: "face", showAllCables: true, selCables: new Set(), hiddenRacks: new Set(), hiddenEquips: new Set(), showFigure: false, figure: null, showWaypoints: true, showConduits: true, cableSplineK: 1 / 6, cableCurveStyle: "fillet", cablePortNormal: false, showEqNames: true, showRackSides: false, showRackNames: true, showPorts: true, showDoors: true, showRoomDoors: true, showDoorSwing: false, showPlaceholders: true, showFloorGrid: true, showOrientMarks: true, showPivot: false, showFocusArrow: true, markerScale: 1, markerRealSize: false, cablesOnTop: true, showFaceImages: true, powerBoltSpacingMm: 300 };
  protected _pivot: THREE.Sprite | null = null;   // marqueur du centre de rotation (sprite billboard, taille écran constante)
  /** FLÈCHE de localisation (sprite billboard, taille écran constante, pointe ancrée sur la cible).
      Vit sous `scene` comme le pivot — donc HORS `content` : elle survit aux reconstructions de données,
      ce qui évite de la voir disparaître/reparaître à chaque événement SSE pendant qu'on lit l'objet visé. */
  protected _focusArrow: THREE.Sprite | null = null;
  /** Point que la flèche désigne : centre de l'objet localisé, en MONDE. null = aucune localisation. */
  protected _focusAnchor: THREE.Vector3 | null = null;
  /** Demi-diagonale de l'objet localisé (mm) : de combien remonter vers la caméra pour que la pointe
      se pose SUR la face regardée plutôt qu'au cœur de l'objet. 0 pour un point (port, waypoint). */
  protected _focusRadius = 0;
  // FOCUS « Localiser » : cible caméra demandée par la vue (centre + emprise). Appliquée juste avant le rendu,
  // donc APRÈS le cadrage par défaut d'un éventuel (re)build → le focus prime. En attente tant que la scène n'est pas prête.
  protected pendingFocus: { p: { x: number; y: number; z: number }; extent: number; face: { az: number; el: number } | null } | null = null;
  protected _focusObjs: THREE.Object3D[] = [];   // meshes de l'équipement « localisé » sous surbrillance persistante

  // glisser (avec détection clic-vs-glisser pour le picking) — `slotsel` = sélection multiple d'emplacements U libres
  protected drag: { mode: "orbit" | "pan" | "slotsel"; x: number; y: number; downX: number; downY: number; btn: number; moved: boolean } | null = null;
  // sélection multiple d'emplacements U libres (glisser vertical) : plage CONTIGUË [lo,hi] de la même baie+face.
  // `overlay` : plan de SURBRILLANCE de la plage sélectionnée (les emplacements sont fusionnés en BANDES —
  // un mesh couvre toute une bande contiguë ; on ne peut plus surligner « par U » via le matériau du mesh).
  protected slotSel: { rackId: string; side: string; anchor: number; lo: number; hi: number; slots: Map<number, THREE.Object3D>; overlay: THREE.Mesh | null } | null = null;
  // Plan de surbrillance de la RANGÉE SURVOLÉE d'une bande d'emplacements (même raison que `slotSel.overlay`).
  protected _slotRowHover: THREE.Mesh | null = null;
  protected _slotRowHoverRow: number | null = null;
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
  // Overlay outil scindé STATIQUE/DYNAMIQUE : la signature détecte un changement STRUCTUREL (points posés,
  // mesures terminées, surbrillance) → rebuild complet ; sinon (seul le curseur bouge) on MUTE ces deux objets.
  protected _toolSig = "";
  protected _cursorLine: THREE.Line | null = null;     // segment pointillé « dernier point → curseur » (persistant)
  protected _cursorDot: THREE.Sprite | null = null;    // pastille du curseur (persistante, taille écran constante)
  // callbacks moteur → vue : placement/survol mesure (point monde) ; clic/survol route (cible pick / point monde).
  measurePlaceCb: ((world: { x: number; y: number; z: number }) => void) | null = null;
  measureHoverCb: ((world: { x: number; y: number; z: number } | null, clientX: number, clientY: number) => void) | null = null;
  routePickCb: ((desc: any) => void) | null = null;
  routeHoverCb: ((world: { x: number; y: number; z: number } | null) => void) | null = null;

  constructor(store: Store, host: DatacenterHost = {}) {
    this.store = store; this.host = host; this.scene3d = new RackScene(store); this.resolver = new Resolver3D(store);
    this.routing = new CableRouting(store, this.resolver, new FloorLayout(store));
    this.trunks = new TrunkRouting(store, this.resolver, this.routing);
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
    const light = Color.isLightHex(bg);   // thème clair = fond lumineux (règle PARTAGÉE, cf. Color.isLightHex)
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
      // ⚠ Le marqueur de PIVOT se décline sur LA MÊME règle (`Color.isLightHex`) — cf. `PivotMarker`.
      // Deux éléments de la même scène ne doivent pas basculer sur deux seuils différents.
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
    cancelAnimationFrame(this._hoverRaf); this._hoverRaf = 0; this._hoverClient = null;   // rAF de survol en attente
    window.removeEventListener("mousemove", this.onMove);
    window.removeEventListener("mouseup", this.onUp);
    if (this.ro) { this.ro.disconnect(); this.ro = null; }
    this.disposeContent();
    // L'overlay d'outils (mesure/route) vit sous `scene`, PAS sous `content` → non couvert par disposeContent :
    // on libère ses géométries/matériaux ici (ses textures, détenues par texCache, sont libérées juste après).
    if (this.gOverlay) { this.disposeGroup(this.gOverlay); this.scene?.remove(this.gOverlay); this.gOverlay = null; }
    this.texCache.forEach((t) => t.dispose()); this.texCache.clear(); this.texCacheTicks.clear();   // libère les textures de libellés mises en cache
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
    // MÊME raison pour la flèche de localisation (sprite sous `scene`, texture CanvasTexture propre).
    if (this._focusArrow) {
      this.scene?.remove(this._focusArrow);
      const m: any = this._focusArrow.material;
      if (m) { if (m.map) m.map.dispose(); m.dispose?.(); }
      this._focusArrow = null;
    }
    this.scene = null; this.camera = null; this.host_el = null;
  }

  protected disposeContent(): void {
    this.hovered = null; this._hoverObjs = []; this.cablesGroup = null; this.gRacks = null; this.gFree = null; this.gWaypoints = null; this.gDecor = null; this.gExtra = null; this.gFloorDecor = null;
    this._focusObjs = []; this._screenObjs = [];   // références vers des meshes qu'on va disposer → sinon GC retardé jusqu'au prochain collectScreenObjs/setFocusEquip
    this.stopFocusPulse();   // les meshes sous pulse partent avec le contenu — la boucle s'arrête AVEC eux (reconstruction comme dispose final) ; un focus encore actif la relancera au setFocusEquip du prochain rendu
    this._warm.clear();   // les groupes de salle vivent sous `content` (détruit ici) → cache chaud réinitialisé
    if (this.content && this.scene) this.scene.remove(this.content);
    // NB : on ne libère PAS les textures (`material.map`) ici — elles sont détenues par `texCache` et
    // réutilisées d'un rebuild à l'autre (libérées seulement au `dispose` final).
    this.content?.traverse((o: any) => this.disposeObjectResources(o));
    this.content = null;
  }

  /** Vide un groupe et libère la géométrie/les matériaux de ses enfants (textures détenues par texCache). */
  protected disposeGroup(g: THREE.Group): void {
    g.traverse((o: any) => this.disposeObjectResources(o));
    g.clear();
  }

  /** Libère géométrie + matériaux d'UN objet du graphe (corps commun de disposeContent/disposeGroup).
      Y COMPRIS le jeu de matériaux DÉBRANCHÉ du swap « Images de façade » (`userData.faceImageSwap`,
      cf. DcThreeScene.buildEquipBox) : `o.material` ne référence que le jeu ACTIF — sans ce détour,
      l'autre jeu fuirait ses ressources GPU à chaque reconstruction. Les instances PARTAGÉES entre les
      deux jeux (faces sans image) sont libérées deux fois : `dispose()` est sans effet la seconde fois.
      Les TEXTURES, elles, restent détenues par `imgTexCache`/`texCache` (réutilisées de rebuild en
      rebuild) — seule exception `ownTex` (clone recadré propre au mesh), libérée avec lui. */
  private disposeObjectResources(o: any): void {
    if (o.geometry) o.geometry.dispose();
    const swap = o.userData && o.userData.faceImageSwap;
    const sets: any[] = swap ? [swap.avec, swap.sans] : (o.material ? [o.material] : []);
    sets.forEach((m: any) => (Array.isArray(m) ? m : [m]).forEach((mm: any) => { if (o.userData && o.userData.ownTex && mm.map) mm.map.dispose(); mm.dispose && mm.dispose(); }));
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
     options, resize). Hors interaction → zéro travail GPU/CPU. Une seule RAF en attente à la fois.
     ⚠ UNE exception ASSUMÉE (arbitrage utilisateur 2026-08-13, cf. docs/perf-3d.md) : tant qu'une mise en
     évidence « Localiser » est active, la boucle de PULSE (`DcThreeCamera.startFocusPulse`) fait respirer
     la surbrillance ambre et demande une frame par tick. Elle est STRICTEMENT bornée par le focus — start
     à son application (`setFocusEquip`), stop à son extinction, à chaque reconstruction (`disposeContent`)
     et au dispose — et s'efface devant `prefers-reduced-motion`. */
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
  /** Matériau PARTAGÉ d'un label à plat (principe n°3) : plan texturé TRANSLUCIDE (LABEL_OPACITY → on voit l'image
      de façade / la paroi au travers), `depthWrite:false` (n'écrit pas la profondeur → ne masque pas ce qui est
      derrière). `protected` (non `private`) car réutilisé par `rackShellLabels` dans la couche scène (lot 2). */
  protected labelMaterial(tex: THREE.Texture): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: LABEL_OPACITY });
  }

  /** Texture canvas d'un libellé (texte clair sur fond translucide), mise en cache (clé texte+dims). */
  protected textTexture(text: string, wMm: number, hMm: number): THREE.CanvasTexture | null {
    if (typeof document === "undefined") return null;
    const cw = 512, ch = Math.max(64, Math.min(512, Math.round(cw * hMm / Math.max(1, wMm))));
    const key = text + "|" + ch;   // même texte + même hauteur de canvas → texture réutilisée (pas de re-rasterisation)
    this.texCacheTicks.set(key, ++this.texCacheTick);   // LRU : marque la clé comme récemment utilisée
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
    this.pruneLabelTextureCache();   // borne le cache (chaque libellé distinct = ~0,1-1 Mo GPU)
    return tex;
  }

  /** ÉVICTION LRU des textures d'ÉTIQUETTES. Contrairement à `imgTexCache` (élagué à chaque build complet via
      `pruneFaceTextureCache`), `texCache` n'était JAMAIS élagué en cours de session : chaque libellé distinct —
      nom d'équipement, numéro d'U, et surtout chaque COTE de mesure (« 12,34 m ») — créait une CanvasTexture GPU
      conservée à vie, y compris après changement de document. Plafond LRU ; les clés « ##… » (textures MUTUALISÉES :
      pastille, losange, éclair, pivot) sont permanentes. Une texture évincée encore posée sur un sprite vivant est
      simplement RE-TÉLÉVERSÉE par three au prochain rendu (dispose ne casse pas la référence JS) — pas d'artefact. */
  protected pruneLabelTextureCache(cap = 256): void {
    const evictable = [...this.texCache.keys()].filter((k) => !k.startsWith("##"));
    if (evictable.length <= cap) return;
    evictable.sort((a, b) => (this.texCacheTicks.get(a) || 0) - (this.texCacheTicks.get(b) || 0));   // plus ancien d'abord
    for (const key of evictable.slice(0, evictable.length - cap)) {
      this.texCache.get(key)?.dispose();
      this.texCache.delete(key);
      this.texCacheTicks.delete(key);
    }
  }

  /** Texture (mutualisée) d'un LOSANGE blanc à CENTRE NOIR — teintée par la couleur du sprite (marqueur waypoint). */
  protected diamondTexture(): THREE.CanvasTexture | null {
    if (typeof document === "undefined") return null;
    const key = "##diamond"; const cached = this.texCache.get(key); if (cached) return cached;
    const s = 64, cv = document.createElement("canvas"); cv.width = cv.height = s;
    const g = cv.getContext("2d"); if (!g) return null;
    const dia = (cx: number, cy: number, r: number, fill: string) => { g.beginPath(); g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy); g.closePath(); g.fillStyle = fill; g.fill(); };
    const R = s / 2 - 2;                            // rayon extérieur du losange (inchangé)
    dia(s / 2, s / 2, R, "#ffffff");                // losange blanc (teinté par la couleur du sprite)
    // Centre noir AGRANDI pour que le liseré teinté (la « marge » orange) soit 50 % plus FIN qu'à l'origine
    // (centre historique : 0.24·s), SANS changer la taille extérieure du losange.
    dia(s / 2, s / 2, R - (R - s * 0.24) / 2, "#000000");
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

  /** Texture (mutualisée) du marqueur de CENTRE DE ROTATION : anneau + croix en pointillés, cerclés d'un
      liseré de contraste. Le STYLE et le TRACÉ vivent dans le module pur `PivotMarker` (testable) ; ici on
      ne fait que fournir le canvas et gérer le cache.

      ⚠ CLÉ DE CACHE DÉPENDANTE DU THÈME. Les clés « ##… » ne sont JAMAIS évincées (cf.
      `pruneLabelTextureCache`) : avec une clé fixe, la texture du PREMIER thème rencontré aurait été
      resservie à vie, et basculer clair↔sombre n'aurait rien changé au marqueur. `PivotMarker.cacheKey`
      encode donc la variante — deux entrées permanentes au maximum. */
  protected pivotTexture(): THREE.CanvasTexture | null {
    if (typeof document === "undefined") return null;
    // `theme` est renseigné par `build()` ; avant lui (fenêtre très courte), on retombe sur le thème SOMBRE,
    // qui est le défaut historique de `readTheme`.
    const backgroundHex = this.theme ? this.theme.bg : 0x0e1116;
    const key = PivotMarker.cacheKey(backgroundHex);
    const cached = this.texCache.get(key); if (cached) return cached;
    const s = PivotMarker.TEXTURE_SIZE_PX, cv = document.createElement("canvas"); cv.width = cv.height = s;
    const g = cv.getContext("2d"); if (!g) return null;
    PivotMarker.draw(g, s, PivotMarker.ink(backgroundHex));
    const tex = new THREE.CanvasTexture(cv); tex.needsUpdate = true; this.texCache.set(key, tex); return tex;
  }

  /** (Re)pose et dimensionne le marqueur de centre de rotation sur la cible caméra (taille ÉCRAN constante),
      ou le masque si l'option est désactivée. Appelé à chaque mise à jour de caméra (suit le pivot) ET après
      un changement de thème (cf. `applyThemeChange`). */
  protected updatePivot(): void {
    if (!this.scene) return;
    if (!this.opts.showPivot) { if (this._pivot) this._pivot.visible = false; return; }
    const tex = this.pivotTexture(); if (!tex) return;
    if (!this._pivot || this._pivot.parent !== this.scene) {
      this._pivot = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: PivotMarker.OPACITY, depthTest: false, depthWrite: false }));
      this._pivot.renderOrder = 30; this.scene.add(this._pivot);
    } else {
      // Le sprite n'est créé QU'UNE FOIS : sans cette réaffectation, il garderait la texture du thème
      // dans lequel il est né. `applyThemeChange` ne le rattraperait pas — il ne remappe que des COULEURS
      // de matériau, jamais des textures, et le pivot vit sous `scene` (hors des groupes qu'il parcourt).
      const mat = this._pivot.material as THREE.SpriteMaterial;
      if (mat.map !== tex) { mat.map = tex; mat.needsUpdate = true; }
    }
    this._pivot.visible = true;
    this._pivot.position.copy(this.target);
    this._pivot.scale.setScalar(PivotMarker.SCREEN_SIZE_PX * this.worldPerPixel());   // taille écran constante, quel que soit le zoom
  }

  /** Texture (mutualisée, DÉPENDANTE DU THÈME) de la flèche de localisation — jumelle de `pivotTexture`.
      Le tracé vit dans le module pur `FocusArrowMarker` ; ici on ne fait que fournir le canvas. */
  protected focusArrowTexture(): THREE.CanvasTexture | null {
    if (typeof document === "undefined") return null;
    const backgroundHex = this.theme ? this.theme.bg : 0x0e1116;
    const key = FocusArrowMarker.cacheKey(backgroundHex);
    const cached = this.texCache.get(key); if (cached) return cached;
    const s = FocusArrowMarker.TEXTURE_SIZE_PX, cv = document.createElement("canvas"); cv.width = cv.height = s;
    const g = cv.getContext("2d"); if (!g) return null;
    FocusArrowMarker.draw(g, s, FocusArrowMarker.ink(backgroundHex));
    const tex = new THREE.CanvasTexture(cv); tex.needsUpdate = true; this.texCache.set(key, tex); return tex;
  }

  /** (Re)pose et dimensionne la FLÈCHE de localisation sur l'objet localisé, ou la masque.
      Appelée à chaque mise à jour de caméra (comme `updatePivot`) : c'est ce qui la maintient du BON CÔTÉ
      de l'objet quand on orbite, et à taille écran constante quand on zoome.

      TROIS conditions pour l'afficher, et elles sont indépendantes : le toggle est allumé, une
      localisation est active (`_focusAnchor`), et la scène existe. Aucune n'est devinée ailleurs.

      POSITION. La flèche est ancrée par son BORD INFÉRIEUR (`center = (0.5, 0)`, cf. l'en-tête du module) :
      sa pointe tombe donc EXACTEMENT sur le point rendu ici, et son corps monte au-dessus sans jamais
      recouvrir la cible. Ce point est le centre de l'objet REMONTÉ vers la caméra de sa demi-diagonale :
      sans ce décalage la pointe viserait le CŒUR de l'objet, donc l'intérieur d'une boîte — visible
      seulement grâce au `depthTest: false`, mais visuellement « enfoncée » dedans. Le décalage suit la
      caméra, donc la flèche reste sur la face qu'on regarde, quel que soit l'angle. */
  protected updateFocusArrow(): void {
    if (!this.scene) return;
    const show = !!this.opts.showFocusArrow && !!this._focusAnchor;
    if (!show) { if (this._focusArrow) this._focusArrow.visible = false; return; }
    const tex = this.focusArrowTexture(); if (!tex) return;
    if (!this._focusArrow || this._focusArrow.parent !== this.scene) {
      this._focusArrow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: FocusArrowMarker.OPACITY, depthTest: false, depthWrite: false }));
      this._focusArrow.center.set(0.5, 0);   // ancrage par le BAS : la pointe se pose sur la cible
      this._focusArrow.renderOrder = 31;     // au-dessus du pivot (30) : c'est une désignation, elle prime
      this.scene.add(this._focusArrow);
    } else {
      // Même raison que pour le pivot : le sprite n'est créé QU'UNE FOIS et garderait sinon la texture
      // du thème dans lequel il est né (`applyThemeChange` ne remappe que des couleurs de matériau).
      const mat = this._focusArrow.material as THREE.SpriteMaterial;
      if (mat.map !== tex) { mat.map = tex; mat.needsUpdate = true; }
    }
    this._focusArrow.visible = true;
    const p = this._focusAnchor as THREE.Vector3;
    const cam = this.camera;
    if (cam && this._focusRadius > 0) {
      // direction CAMÉRA → objet, normalisée : on remonte du centre vers la caméra.
      const dir = cam.position.clone().sub(p);
      const len = dir.length();
      if (len > 1e-6) this._focusArrow.position.copy(p).addScaledVector(dir.multiplyScalar(1 / len), this._focusRadius);
      else this._focusArrow.position.copy(p);
    } else this._focusArrow.position.copy(p);
    // ÉCHELLE : la MÊME règle que `updateScreenScales`, et pas `worldPerPixel()` seul. En PERSPECTIVE le
    // mm/px dépend de la distance CAMÉRA↔OBJET, pas de la distance à la CIBLE d'orbite : la flèche vit
    // devant l'objet localisé, qui n'est presque jamais le pivot (on peut avoir orbité depuis). Prendre le
    // plan de la cible la ferait gonfler ou rétrécir au fil de l'orbite — exactement le défaut que la note
    // d'`updateScreenScales` documente pour les marqueurs.
    const h = Math.max(1, this.host_el ? this.host_el.clientHeight : 1);
    const perspK = (2 * Math.tan(this.fov * Math.PI / 360)) / h;
    const mmPerPx = (this.perspective && cam) ? perspK * cam.position.distanceTo(this._focusArrow.position) : this.worldPerPixel();
    this._focusArrow.scale.setScalar(FocusArrowMarker.SCREEN_SIZE_PX * mmPerPx);   // taille écran constante
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
  protected faceImagePlane(group: THREE.Group, url: string, x: number, y: number, z: number, w: number, h: number, front: boolean, extra?: any, trimX = 0): void {
    if (typeof document === "undefined") return;
    const place = (tex0: THREE.Texture): void => {
      let tex = tex0, own = false;
      if (trimX > 0) {   // RECADRAGE horizontal (ex. oreilles trimmées quand le corps déborde de la façade) :
        // clone LÉGER (l'image GPU est partagée, seuls offset/repeat diffèrent) → ownTex : le clone est à nous.
        tex = tex0.clone(); tex.needsUpdate = true;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.repeat.x = Math.max(0.01, 1 - 2 * trimX); tex.offset.x = trimX;
        own = true;
      }
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
      mesh.position.set(x, y, z);
      // rotation pure (pas de scale/winding inversé) : avant normale −Y · arrière normale +Y NON miroir
      if (front) mesh.rotation.x = Math.PI / 2;
      else mesh.setRotationFromAxisAngle(new THREE.Vector3(0, 1, 1).normalize(), Math.PI);
      mesh.renderOrder = 1; mesh.userData = Object.assign({}, extra, own ? { ownTex: true } : null);   // sans trim : texture détenue par imgTexCache
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
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.labelMaterial(tex));   // matériau translucide PARTAGÉ
    // SAILLIE anti z-fighting : le label est décalé de FACE_LABEL_STANDOFF_MM vers l'EXTÉRIEUR le long de la normale de
    // sa face (avant = −Y → on RECULE en −Y ; arrière = +Y → on avance en +Y). Il se glisse ainsi ENTRE l'image de
    // façade (0,5 mm, coplanaire sinon → il passe devant, lisible) et les PORTS (1,5 mm, qui l'occultent proprement) →
    // aucun clignotement avec l'un ni l'autre. (0,5 mm ici, PAS 1 mm : à 1 mm le label serait coplanaire aux ports.)
    const yStandoff = front ? y - FACE_LABEL_STANDOFF_MM : y + FACE_LABEL_STANDOFF_MM;
    mesh.position.set(x, yStandoff, z);
    // ROTATION PURE (pas de scale → pas de winding inversé ni de miroir) : avant = normale −Y ; arrière = normale +Y,
    // texte droit et NON miroir (180° autour de l'axe (0,1,1) → right=−X = droite du spectateur arrière, up=+Z).
    if (front) mesh.rotation.x = Math.PI / 2;
    else mesh.setRotationFromAxisAngle(new THREE.Vector3(0, 1, 1).normalize(), Math.PI);
    mesh.userData = Object.assign({ layer: "name" }, extra);   // couche "name" (showEqNames) + côté éventuel (hideAv/Ar)
    group.add(mesh);
  }

  /* ---- CONTRAT CROISÉ (membres définis dans les couches SUPÉRIEURES, appelés d'ici) --------------
     La chaîne DcThreeBase → DcThreeCamera → DcThreeScene répartit un même objet en tranches : la base
     appelle des membres définis plus haut. Ils sont déclarés `abstract` ICI (l'ancienne signature
     d'index `[key: string]: any` désactivait TOUT le contrôle de type — chaque `this.x` compilait,
     fautes de frappe comprises). Tout NOUVEL appel croisé doit ajouter sa déclaration dans ce bloc. */
  // Définis dans DcThreeCamera :
  protected abstract makeCamera(): void;
  protected abstract bindEvents(dom: HTMLElement): void;
  protected abstract updateCamera(): void;
  protected abstract worldPerPixel(): number;
  protected abstract applyPendingFocus(): void;
  protected abstract stopFocusPulse(): void;   // borne « reconstruction / destruction » de la boucle de pulse (cf. disposeContent)
  protected abstract onMove: (e: MouseEvent) => void;
  protected abstract onUp: (e: MouseEvent) => void;
  // Définis dans DcThreeScene :
  protected abstract build(dcId: string | null): void;
  abstract rebuild(dcId: string | null): void;
  protected abstract layerVisible(u: any): boolean;
  protected abstract measureClick(clientX: number, clientY: number): void;
  protected abstract routeClick(clientX: number, clientY: number): void;
  protected abstract toolHover(clientX: number, clientY: number): void;
}

