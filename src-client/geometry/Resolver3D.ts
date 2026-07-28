import type { Store } from "../store";
import { RackGeometry } from "./RackGeometry";
// CONTENEUR SALLE : la composition « point local d'un contenu → local salle » lui appartient
// (docs/placement.md §3 règle 1 et §6.1). Les branches ci-dessous — baies ET équipements libres — ne
// produisent plus que leur point/normale LOCAUX.
import { RoomFrame } from "./RoomFrame";
import { FreeEquipGeometry } from "./FreeEquipGeometry";
import { Depths } from "../registries/Depths";
import {
  RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_EAR_MM, RACK_EAR_STANDOFF_MM,
  U_MM, SIDE_U_STEP, BRUSH_PADDING_MM, CONDUIT_W_DEFAULT, CONDUIT_H_DEFAULT,
} from "../domain/constants";

/** Vecteur du repère LOCAL SALLE (mm) — cf. la note de repère en tête de la classe. */
export interface Vec3 { x: number; y: number; z: number; }
/** Dimensions UTILES de la section d'un conduit (marge d'exclusion déduite). */
export interface ConduitDims { usableW: number; usableH: number; kind: "segment" | "brush" | "pin"; }

/** Point 3D résolu d'un port : (mm) + normale sortante + baie hôte.
    ⚠ REPÈRE : celui qu'annonce la MÉTHODE qui l'a produit — LOCAL SALLE pour `resolvePort3D` et tout ce qui
    passe par `resolveFaceAnchor3D` (le cas général), MONDE pour `resolvePortWorld3D` (contenu placé sur un
    conteneur SANS salle). Le type ne peut pas porter cette distinction sans se dédoubler pour rien : les deux
    portent exactement les mêmes champs, et c'est le point d'appel qui sait d'où il vient (cf. l'en-tête). */
export interface Port3D { x: number; y: number; z: number; rackId: string | null; n: { x: number; y: number; z: number }; }

/** Position sur une FACE d'équipement (fraction 0..1 de la largeur/hauteur + face) — sous-ensemble des champs
    de géométrie d'un `Port` consommés par la résolution 3D. Permet de résoudre un point de face SANS port persisté
    (ex. l'uplink virtuel d'un faisceau). */
export interface FaceGeo { face_x: number | null; face_y: number | null; face_side: string; }

/** UPLINK DE FAISCEAU : tout patch porte D'OFFICE un point de terminaison réservé au trunk, par DÉFAUT au
    CENTRE de la FACE ARRIÈRE (les brins arrivent par l'arrière du tiroir optique). C'est un port VIRTUEL —
    aucune entité `ports` n'est créée : le tracé du faisceau s'y ancre dès que l'équipement est posé. */
export const TRUNK_UPLINK_GEO: FaceGeo = { face_x: 0.5, face_y: 0.5, face_side: "rear" };

/* =============================================================================
   Résolution 3D contre le STORE vivant (dépendance injectée) :
     - resolvePort3D : point d'un port (rack / side / wall / tray / libre) ;
     - géométrie des waypoints (ancre, points de passage) et des pins/brosses.

   ⚠ REPÈRE DE SORTIE : **LOCAL SALLE**, jamais monde — pour tout ce que ce
   fichier résout À L'INTÉRIEUR d'une salle (points, normales, offsets de
   conduit). Les docstrings annonçaient « monde », ce qui était FAUX : dette
   nommée par la doctrine (`docs/placement.md` §3 règle 5), corrigée ici. Et ce
   n'est pas un défaut à réparer, c'est le repère CORRECT (§6.6) : au-dessus de la
   salle il n'existe aucune transformée intrinsèque à appliquer — la position
   d'une salle dans son étage, d'un étage dans son bâtiment et d'un bâtiment dans
   le monde relève du LAYOUT, qui dépend de l'ensemble affiché et vit dans
   `FloorLayout` (`roomToWorld`, `multiLayout`). Un consommateur qui veut du monde
   compose donc lui-même ce dernier maillon.

   ⚠ UNE SEULE EXCEPTION, ET SON NOM LE DIT : `resolvePortWorld3D` rend du MONDE.
   Elle résout un contenu placé sur un conteneur SANS SALLE (un équipement posé
   sur un ÉTAGE), donc un cas où « local salle » n'a aucun sens — c'est le cas que
   §1 symptôme 3 désigne comme impossible à écrire dans le moule des cinq branches.
   Elle ne CALCULE pas la transformée du conteneur (elle relève du layout, §6.6) :
   elle la REÇOIT, sous forme d'origine monde. L'asymétrie des deux repères de
   sortie est donc voulue, et elle est ANNONCÉE dans les deux noms — c'est
   exactement ce qu'exige §3 règle 5, dont ce fichier avait été le contre-exemple.

   La machinerie de RÉPARTITION conduit (offsets dans la section) vit désormais ici
   (`waypointConduitDims`/`conduitGrid`/`conduitCell`/`conduitCablesOf`/`conduitBasis`/
   `conduitOffsetFor`) : elle produit l'offset monde qu'on passe à `waypointPassPoints`
   via `off` pour répartir N câbles dans la section d'un chemin/brosse/pin à rayon.
   ============================================================================= */
export class Resolver3D {
  constructor(private store: Store) {}

  /** Résout un port en point 3D (LOCAL SALLE), ou null s'il n'est pas placé dans `dcId`. */
  resolvePort3D(portId: string, dcId: string): Port3D | null {
    const s = this.store;
    const port = s.get("ports", portId); if (!port) return null;
    // breakout : une lane émerge du connecteur du TRUNK.
    const geo = port.parent_port_id ? (s.get("ports", port.parent_port_id) || port) : port;
    const eq = s.get("equipments", port.equipment_id); if (!eq) return null;
    return this.resolveFaceAnchor3D(eq, geo, dcId);
  }

  /** Résout un port porté par un contenu placé DIRECTEMENT sur un conteneur SANS SALLE — aujourd'hui un
      équipement posé sur un ÉTAGE (`placement_mode: "floor"`). C'est le PENDANT de `resolvePort3D`, qui ne
      sait travailler qu'À L'INTÉRIEUR d'une salle : ses cinq branches exigent toutes un `dcId` et rendent
      null sans lui. La doctrine désigne précisément ce cas (`docs/placement.md` §1, symptôme 3) : « la
      sixième branche (étage) est IMPOSSIBLE à écrire dans ce moule, parce que son hôte n'est pas une salle ».

      ⚠ REPÈRE DE SORTIE : **MONDE** — d'où le `World` du nom (§3 règle 5 : le repère d'un point résolu doit
      être EXPLICITE, y compris quand il diffère de celui de ses voisins). Le contrat est exactement : origine
      MONDE en entrée ⇒ point MONDE en sortie. Ce n'est pas une entorse à l'en-tête du fichier mais sa
      conséquence : au-dessus de la salle il n'existe aucune transformée INTRINSÈQUE à composer (§6.6), la
      position d'un étage relevant du LAYOUT. Le conteneur ne peut donc pas se calculer ici — il se FOURNIT,
      par son origine monde (`FloorLayout.equipFloorWorld` pour x/y, `FloorLayout.levelZ` pour z).

      ⚠ `worldOriginZ` ne porte QUE le socle du CONTENEUR (Z du niveau). La hauteur propre de l'équipement
      (`dc_z`) est déjà comprise dans le point local rendu par `FreeEquipGeometry.portLocal` — elle est donc
      ajoutée ICI, et une seule fois. Même convention que `DcThreeScene.buildEquipBox`, qui pose son groupe
      sur le socle et sa boîte sur `box().z` : c'est ce qui interdit de compter `dc_z` deux fois entre
      l'appelant et la géométrie (piège verrouillé par test).

      ⚠ La NORMALE ne subit AUCUNE rotation de conteneur : bâtiment et étage sont de pures TRANSLATIONS
      (position du site, ancrage du plan, Z du niveau) — re-vérifié après l'arrivée de la position et de la
      taille déclarée des sites, dont la spec ne porte toujours aucune orientation. Seul le lacet PROPRE de
      l'équipement (`dc_orientation`) tourne. À revoir si un conteneur acquiert un jour une orientation. */
  resolvePortWorld3D(portId: string, worldOriginX: number, worldOriginY: number, worldOriginZ: number): Port3D | null {
    const s = this.store;
    const port = s.get("ports", portId); if (!port) return null;
    // BREAKOUT : une lane émerge du connecteur du TRUNK — MÊME règle que `resolvePort3D`. C'est tout
    // l'intérêt d'un résolveur partagé : la version qui composait cette chaîne dans la vue avait oublié
    // cette règle, et rien ne l'aurait signalé.
    const geo = port.parent_port_id ? (s.get("ports", port.parent_port_id) || port) : port;
    const eq = s.get("equipments", port.equipment_id); if (!eq) return null;
    if (eq.dim_mode !== "free") return null;   // seul un dimensionnement LIBRE porte une boîte 6 faces
    // COMPOSITION : lacet PROPRE du contenu, PUIS translation à l'origine de son conteneur. C'est
    // exactement ce que compose `RoomFrame` — on le RÉUTILISE plutôt que de réécrire ici une n-ième
    // « rotation de l'hôte puis translation », ce que §3 règle 1 désigne comme la signature d'un conteneur
    // manquant. Ce qui change n'est PAS la composition mais la PROVENANCE de l'origine : un contenu de
    // salle la DÉCLARE (`dc_x`/`dc_y`), un contenu d'étage la reçoit du LAYOUT (§6.6). `RoomFrame` compose
    // donc dans le repère de l'origine qu'on lui donne — d'où du monde ici.
    // ⚠ `halfW`/`halfD` sont INERTES : ils ne servent que de REPLI quand la position manque, or l'origine
    // du conteneur est toujours fournie. Ils valent 0 pour dire « aucun repli à faire », pas une demi-taille.
    const p = RoomFrame.place(
      { x: worldOriginX, y: worldOriginY, yawDeg: eq.dc_orientation, halfW: 0, halfD: 0 },
      FreeEquipGeometry.portLocal(eq, geo),
      FreeEquipGeometry.faceNormalLocal(geo.face_side),
    );
    return { x: p.x, y: p.y, z: p.z + worldOriginZ, rackId: null, n: p.n };
  }

  /** Résout le PORT UPLINK virtuel d'un faisceau sur son équipement d'extrémité (patch) : centre de la face
      arrière par défaut (cf. TRUNK_UPLINK_GEO). null si l'équipement n'est pas placé dans `dcId`. */
  resolveTrunkUplink3D(equipmentId: string | null, dcId: string): Port3D | null {
    const eq = equipmentId ? this.store.get("equipments", equipmentId) : null; if (!eq) return null;
    return this.resolveFaceAnchor3D(eq, TRUNK_UPLINK_GEO, dcId);
  }

  /** Point 3D (LOCAL SALLE) d'une position de FACE (`geo`) sur un équipement — mécanique UNIQUE partagée par
      les ports persistés (resolvePort3D) et les points virtuels (uplink de faisceau). null si non placé
      dans `dcId`.

      Les CINQ modes ne calculent plus que leur point d'ancrage et leur normale dans le repère LOCAL de
      leur hôte — la BAIE pour `side`/`tray`/`wall`/`rack`, l'ÉQUIPEMENT lui-même pour le mode libre
      (`manual`) ; c'est le CONTENEUR SALLE (`RoomFrame`) qui les amène au repère de la salle, une baie et
      un équipement libre étant l'un comme l'autre un objet posé dans une salle avec position et lacet. Ce
      qui reste propre à chaque mode est son paramétrage d'ATTACHE (colonne de marge, plateau, paroi,
      index U + face de montage, face du boîtier) — hors interface commune, cf. doctrine §6.2. */
  resolveFaceAnchor3D(eq: any, geo: FaceGeo | any, dcId: string): Port3D | null {
    const s = this.store;

    if (eq.placement_mode === "side" && eq.rack_id) {
      const rack = s.get("racks", eq.rack_id); if (!rack || rack.datacenter_id !== dcId) return null;
      const b = RackGeometry.sideEquipBoxLocal(rack, eq);
      const xMin = Math.min(b.x0, b.x1), xMax = Math.max(b.x0, b.x1), yMin = Math.min(b.y0, b.y1), yMax = Math.max(b.y0, b.y1);
      const fx = (geo.face_x != null) ? geo.face_x : 0.5, fy = (geo.face_y != null) ? geo.face_y : 0.5;
      const sgn = b.front ? -1 : 1;   // −Y local = façade de la baie
      const xl = xMin + fx * (xMax - xMin);
      const yl = b.front ? yMin : yMax;
      const zl = b.z0 + (1 - fy) * (b.z1 - b.z0);
      const p = RoomFrame.place(RackGeometry.roomPlacement(rack), { x: xl, y: yl, z: zl }, { x: 0, y: sgn });
      return { x: p.x, y: p.y, z: p.z, rackId: rack.id, n: p.n };
    }
    if (eq.placement_mode === "tray" && eq.tray_item_id) {
      // POSÉ SUR UNE ÉTAGÈRE : boîte locale sur le plateau (baie dérivée de l'étagère). Le port sort sur la
      // face de la boîte tournée vers la façade (face_side "front") ou le fond ("rear") de la baie hôte.
      const tray = s.get("rackItems", eq.tray_item_id); if (!tray || !tray.rack_id) return null;
      const rack = s.get("racks", tray.rack_id); if (!rack || rack.datacenter_id !== dcId) return null;
      const b = RackGeometry.trayEquipBoxLocal(rack, tray, eq);
      const xMin = Math.min(b.x0, b.x1), xMax = Math.max(b.x0, b.x1), yMin = Math.min(b.y0, b.y1), yMax = Math.max(b.y0, b.y1);
      const fx = (geo.face_x != null) ? geo.face_x : 0.5, fy = (geo.face_y != null) ? geo.face_y : 0.5;
      const trayFront = tray.side !== "rear", portFront = geo.face_side !== "rear";
      const sgn = (portFront === trayFront) ? -1 : 1;   // −Y local = façade de la baie
      const xl = xMin + fx * (xMax - xMin);
      const yl = (sgn < 0) ? yMin : yMax;
      const zl = b.z0 + (1 - fy) * (b.z1 - b.z0);
      const p = RoomFrame.place(RackGeometry.roomPlacement(rack), { x: xl, y: yl, z: zl }, { x: 0, y: sgn });
      return { x: p.x, y: p.y, z: p.z, rackId: rack.id, n: p.n };
    }
    if (eq.placement_mode === "wall" && eq.rack_id) {
      const rack = s.get("racks", eq.rack_id); if (!rack || rack.datacenter_id !== dcId) return null;
      const b = RackGeometry.wallEquipBoxLocal(rack, eq);
      const xMin = Math.min(b.x0, b.x1), xMax = Math.max(b.x0, b.x1), yMin = Math.min(b.y0, b.y1), yMax = Math.max(b.y0, b.y1);
      const fx = (geo.face_x != null) ? geo.face_x : 0.5, fy = (geo.face_y != null) ? geo.face_y : 0.5;
      let xl, yl;
      if (b.n.x !== 0) { xl = (b.n.x > 0) ? xMax : xMin; yl = yMin + fx * (yMax - yMin); }
      else { yl = (b.n.y > 0) ? yMax : yMin; xl = xMin + fx * (xMax - xMin); }
      const zl = b.z0 + (1 - fy) * (b.z1 - b.z0);
      // seul mode BAIE dont la normale locale est portée par la BOÎTE (paroi gauche/droite ou fond de marge).
      const p = RoomFrame.place(RackGeometry.roomPlacement(rack), { x: xl, y: yl, z: zl }, { x: b.n.x, y: b.n.y });
      return { x: p.x, y: p.y, z: p.z, rackId: rack.id, n: p.n };
    }
    if (eq.dim_mode === "free") {
      // MODE LIBRE : l'hôte n'est pas une baie mais la SALLE elle-même. L'équipement produit son point et sa
      // normale LOCAUX (boîte 6 faces) ; le conteneur applique son lacet propre (`dc_orientation`) et sa
      // position. Seule face à pouvoir être HORIZONTALE (dessus/dessous) — d'où une normale à 3 composantes.
      if (eq.dc_id !== dcId || eq.dc_x == null || eq.dc_y == null) return null;
      const p = RoomFrame.place(FreeEquipGeometry.roomPlacement(eq), FreeEquipGeometry.portLocal(eq, geo), FreeEquipGeometry.faceNormalLocal(geo.face_side));
      return { x: p.x, y: p.y, z: p.z, rackId: null, n: p.n };
    }
    if (eq.placement_mode !== "rack" || !eq.rack_id || eq.rack_u == null) return null;
    const rack = s.get("racks", eq.rack_id); if (!rack || rack.datacenter_id !== dcId) return null;
    const mountFront = eq.rack_side !== "rear";
    const portFront = geo.face_side !== "rear";
    const emergesFront = mountFront ? portFront : !portFront;
    const dDepth = rack.depth || RACK_DEPTH_DEFAULT, halfD = dDepth / 2;
    const fm = RackGeometry.frontMargin(rack), cageD = RackGeometry.cageDepth(rack);
    const frontPostOff = halfD - fm, rearPostOff = halfD - fm - cageD;
    const span = Depths.mountSpanMm(eq, cageD);
    // FAÇADE DEVANT LA CAGE : la face de montage est posée RACK_EAR_STANDOFF_MM devant le plan des
    // montants (réserve d'oreilles) + le DÉBORD propre de l'équipement (face_offset_mm) — parité avec
    // le dessin des caissons (DcThreeScene) : les ports restent SUR les faces dessinées.
    const faceOff = RACK_EAR_STANDOFF_MM + Math.max(0, eq.face_offset_mm || 0);
    let off;
    if (mountFront) off = emergesFront ? (frontPostOff + faceOff) : (frontPostOff + faceOff - span);
    else off = emergesFront ? (rearPostOff - faceOff + span) : (rearPostOff - faceOff);
    const latSign = emergesFront ? 1 : -1;
    // face_x couvre la largeur RÉELLE du boîtier (rétréci si u_width_mm), au décalage PHYSIQUE de son
    // alignement (u_align) — parité avec le caisson 3D (DcThreeScene) et l'éditeur de façade.
    const lateral = RackGeometry.eqBodyOffsetX(eq) + latSign * (((geo.face_x != null) ? geo.face_x : 0.5) - 0.5) * RackGeometry.eqBodyWidth(eq);
    const uh = Math.max(1, eq.u_height | 0 || 1);
    const zf = (geo.face_y != null) ? (1 - geo.face_y) : 0.5;
    const ns = emergesFront ? 1 : -1;
    // ⚠ `off` se mesure vers la FAÇADE de la baie, donc vers les −Y LOCAUX (et `lateral` le long de +X) :
    // d'où le signe. Cette branche composait la même rotation que les trois autres, mais écrite sur la base
    // (avant, largeur) plutôt qu'en (cosinus, sinus) — deux notations d'UNE mécanique, ce que la
    // délégation au conteneur rend enfin visible.
    const p = RoomFrame.place(
      RackGeometry.roomPlacement(rack),
      { x: lateral, y: -off, z: RackGeometry.uBaseZ(rack) + ((eq.rack_u - 1) + zf * uh) * U_MM },
      { x: 0, y: -ns },
    );
    return { x: p.x, y: p.y, z: p.z, rackId: rack.id, n: p.n };
  }

  /* ---- waypoints ---- */

  /** Un waypoint est-il posé (coordonnées complètes pour sa forme) ? Délègue au store (source unique). */
  waypointIsPlaced(wp: any): boolean { return this.store.waypointIsPlaced(wp); }

  /** Point représentatif (pin = le point ; segment = milieu ; brush = milieu de traversée). */
  waypointAnchor(wp: any): { x: number; y: number; z: number } {
    if (wp.kind === "brush") { const g = this.brushGeom(wp); if (g) return { x: (g.e0.x + g.e1.x) / 2, y: (g.e0.y + g.e1.y) / 2, z: g.zc }; }
    if (wp.kind === "point" && wp.rack_id && wp.side_lr != null) { const g = this.sidePinGeom(wp); if (g) return g.roomPoint; }
    if (wp.kind === "point" && wp.rack_id && wp.cap_face) { const g = this.capPinGeom(wp); if (g) return g.roomPoint; }
    if (wp.kind === "segment" && wp.dc_x2 != null) return { x: (wp.dc_x + wp.dc_x2) / 2, y: (wp.dc_y + wp.dc_y2) / 2, z: wp.dc_z || 0 };
    return { x: wp.dc_x, y: wp.dc_y, z: wp.dc_z || 0 };
  }

  /** Points de passage RÉELS d'un câble sur un waypoint (orientation min-détour pour
      segment/brush). `off` (vecteur LOCAL SALLE) décale les points (répartition conduit). */
  waypointPassPoints(wp: any, prev: any, next: any, off: any): Array<{ x: number; y: number; z: number }> {
    const ao = off ? (p: any) => ({ x: p.x + off.x, y: p.y + off.y, z: p.z + off.z }) : (p: any) => p;
    if (wp.kind === "brush") {
      const g = this.brushGeom(wp); if (!g) return [ao(this.waypointAnchor(wp))];
      const d = (p: any, q: any) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
      return (d(prev, g.e0) + d(g.e1, next) <= d(prev, g.e1) + d(g.e0, next)) ? [ao(g.e0), ao(g.e1)] : [ao(g.e1), ao(g.e0)];
    }
    if (wp.kind !== "segment" || wp.dc_x2 == null || wp.dc_y2 == null) return [ao(this.waypointAnchor(wp))];
    const ax = wp.dc_x, ay = wp.dc_y, bx = wp.dc_x2, by = wp.dc_y2, z = wp.dc_z || 0;
    if ((bx - ax) * (bx - ax) + (by - ay) * (by - ay) < 1e-6) return [ao(this.waypointAnchor(wp))];
    const e0 = { x: ax, y: ay, z }, e1 = { x: bx, y: by, z };
    const d = (p: any, q: any) => Math.hypot(p.x - q.x, p.y - q.y);
    return (d(prev, e0) + d(e1, next) <= d(prev, e1) + d(e0, next)) ? [ao(e0), ao(e1)] : [ao(e1), ao(e0)];
  }

  /* ---- géométrie des pins / brosses (points d'une baie hôte, rendus en LOCAL SALLE) ----

     ✅ MIGRÉES au conteneur. Elles recomposaient la transformée de baie à la main, et le lot précédent les
     avait laissées de côté pour une raison précise : elles employaient l'AUTRE convention d'origine pour
     une baie non positionnée (`dc_x`/`dc_y` absents = DEMI-EMPREINTE, quand les modes d'attache repliaient
     sur 0). Cette divergence est désormais ARBITRÉE en faveur de la demi-empreinte — celle du dessin, cf.
     l'en-tête de `RoomFrame` —, donc les unifier ne déplace plus rien : ces trois méthodes passent par le
     conteneur SANS changer d'un micron ce qu'elles rendaient. Ce sont les MODES D'ATTACHE qui se sont
     alignés sur elles, et non l'inverse.

     Le champ de sortie s'appelait `world` par héritage, alors qu'il rend du LOCAL SALLE : renommé
     `roomPoint` (doctrine §3 règle 5 — un repère résolu doit être EXPLICITE). */

  /** Brosse de brassage (conduit contraint à une baie). null si non résolue. */
  brushGeom(wp: any): any {
    const s = this.store;
    if (wp.kind !== "brush" || !wp.rack_id) return null;
    const rack = s.get("racks", wp.rack_id); if (!rack) return null;
    const basis = RoomFrame.basis(RackGeometry.roomPlacement(rack));
    const hd = (rack.depth || RACK_DEPTH_DEFAULT) / 2;
    const u0 = Math.max(1, wp.rack_u | 0), uh = Math.max(1, wp.u_height | 0);
    const z0 = RackGeometry.uBaseZ(rack) + (u0 - 1) * U_MM, z1 = z0 + uh * U_MM, zc = (z0 + z1) / 2;
    const depth = Math.min(Math.max(1, wp.depth_mm || 100), RackGeometry.cageDepth(rack));
    const fm = RackGeometry.frontMargin(rack);
    const toRoom = (lx: number, ly: number, lz: number) => RoomFrame.pointToRoom(basis, { x: lx, y: ly, z: lz });
    const e0 = toRoom(0, -hd + fm + 2, zc), e1 = toRoom(0, -hd + fm + 2 + depth, zc);
    // section de la brosse : sa largeur suit l'axe +X LOCAL de la baie (une DIRECTION, donc tournée SEULE).
    const right = RoomFrame.dirToRoom(basis, { x: 1, y: 0 }), up = { x: 0, y: 0, z: 1 };
    const bodyHW = RACK_MOUNT_WIDTH / 2 - RACK_EAR_MM;
    return { rack, co: basis.cos, so: basis.sin, cx: basis.originX, cy: basis.originY, hd, e0, e1, right, up, z0, z1, zc, depth,
      halfW: bodyHW, usableW: Math.max(0, 2 * bodyHW - 2 * BRUSH_PADDING_MM),
      usableH: Math.max(0, uh * U_MM - 2 * BRUSH_PADDING_MM), dcId: rack.datacenter_id };
  }

  /** Pin monté en marge latérale : centre du slot (bande SIDE_U_STEP) en LOCAL SALLE. null sinon. */
  sidePinGeom(wp: any): any {
    const s = this.store;
    if (wp.kind !== "point" || !wp.rack_id || wp.side_lr == null) return null;
    const rack = s.get("racks", wp.rack_id); if (!rack) return null;
    const face = (wp.side_face === "rear") ? "rear" : "front", lr = (wp.side_lr === "right") ? "right" : "left";
    const col = (wp.side_col === 1) ? 1 : 0, uTop = Math.max(1, wp.side_u | 0);
    const b = RackGeometry.sideSlotBoxLocal(rack, face, lr, col, uTop, SIDE_U_STEP);
    const lx = (Math.min(b.x0, b.x1) + Math.max(b.x0, b.x1)) / 2, lz = (b.z0 + b.z1) / 2, ly = b.yPlane;
    const roomPoint = RoomFrame.pointToRoom(RoomFrame.basis(RackGeometry.roomPlacement(rack)), { x: lx, y: ly, z: lz });
    return { rack, face, lr, col, uTop, dcId: rack.datacenter_id, roomPoint };
  }

  /** Pin monté sur un capot : centre de la cellule sur le plan du capot. null sinon. */
  capPinGeom(wp: any): any {
    const s = this.store;
    if (wp.kind !== "point" || !wp.rack_id || !wp.cap_face) return null;
    const rack = s.get("racks", wp.rack_id); if (!rack) return null;
    const c = RackGeometry.capCellLocalCenter(rack, wp.cap_cx | 0, wp.cap_cy | 0);
    const z = (wp.cap_face === "floor") ? 0 : RackGeometry.physHeight(rack);
    const roomPoint = RoomFrame.pointToRoom(RoomFrame.basis(RackGeometry.roomPlacement(rack)), { x: c.lx, y: c.ly, z });
    return { rack, face: wp.cap_face, cx: wp.cap_cx | 0, cy: wp.cap_cy | 0, dcId: rack.datacenter_id, roomPoint };
  }

  /* ---- répartition conduit (offsets dans la section) ---- */

  /** Dimensions UTILES de section d'un waypoint-conduit (marge d'exclusion déduite), ou null si pas un conduit. */
  waypointConduitDims(w: any): ConduitDims | null {
    if (w.kind === "segment" && w.dc_x2 != null) {
      const W = (w.width_mm > 0) ? w.width_mm : CONDUIT_W_DEFAULT, H = (w.height_mm > 0) ? w.height_mm : CONDUIT_H_DEFAULT;
      // chemin de câbles : section PLEINE (pas de padding — le padding est propre à la brosse).
      return (W > 1 || H > 1) ? { usableW: W, usableH: H, kind: "segment" } : null;
    }
    if (w.kind === "brush") {
      const g = this.brushGeom(w); return g ? { usableW: g.usableW, usableH: g.usableH, kind: "brush" } : null;
    }
    if (w.kind === "point" && w.spread === true && w.radius > 0) {
      const sq = w.radius * 1.5;   // carré inscrit ~ dans le disque de rayon `radius` (réparti autour du pin)
      return { usableW: sq, usableH: sq, kind: "pin" };
    }
    return null;
  }

  /** Grille dynamique (cols×rows) pour N éléments, en respectant l'aspect largeur/hauteur de la section. */
  static conduitGrid(n: number, aspect: number): { cols: number; rows: number } {
    const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * (aspect > 0 ? aspect : 1))) || 1));
    return { cols, rows: Math.ceil(n / cols) };
  }

  /** Affectation d'un câble (index i sur n) à une cellule (col,row). ⚠ POINT D'EXTENSION : ordre
      STABLE par index (= ordre stable par id de câble, cf. conduitCablesOf). */
  static conduitCell(i: number, n: number, aspect: number): { col: number; row: number; cols: number; rows: number } {
    const g = Resolver3D.conduitGrid(n, aspect);
    return { col: i % g.cols, row: Math.floor(i / g.cols), cols: g.cols, rows: g.rows };
  }

  /** Liaisons (ids triés, ordre stable) routées par CE waypoint — base de l'index de répartition (toutes salles).
      Câbles ET FAISCEAUX : un trunk traverse physiquement la section du conduit comme un câble → il occupe un
      SLOT de répartition (sinon, centré, il chevaucherait visuellement un câble voisin — d'autant que les brins
      piochés par PORTS ne sont pas dessinés : le trunk est LA ligne visible). */
  conduitCablesOf(wpId: string): string[] {
    const cableIds = this.store.all("cables").filter((c: any) => this.store.effectiveWaypointIds(c).includes(wpId)).map((c: any) => c.id);
    const trunkIds = this.store.all("cableBundles").filter((b: any) => (b.waypoint_ids || []).includes(wpId)).map((b: any) => b.id);
    return cableIds.concat(trunkIds).sort();
  }

  /** Base orthonormée (right, up) de la SECTION d'un conduit : segment → ⊥ horizontale + verticale ;
      pin → plan ⊥ au FLUX (prev→next) ; brush → repère de la baie hôte (tourné par son lacet). */
  conduitBasis(w: any, prev: Vec3, next: Vec3): { right: Vec3; up: Vec3 } {
    if (w.kind === "brush") { const g = this.brushGeom(w); if (g) return { right: g.right, up: g.up }; }
    if (w.kind === "segment" && w.dc_x2 != null) {
      const ax = w.dc_x2 - w.dc_x, ay = w.dc_y2 - w.dc_y, L = Math.hypot(ax, ay) || 1;
      return { right: { x: ay / L, y: -ax / L, z: 0 }, up: { x: 0, y: 0, z: 1 } };
    }
    const fx = next.x - prev.x, fy = next.y - prev.y, fz = next.z - prev.z, L = Math.hypot(fx, fy, fz) || 1;
    const axis = { x: fx / L, y: fy / L, z: fz / L };
    const rl = Math.hypot(axis.y, -axis.x, 0);   // axis × zUp = (axis.y, −axis.x, 0)
    const right = rl > 1e-6 ? { x: axis.y / rl, y: -axis.x / rl, z: 0 } : { x: 1, y: 0, z: 0 };
    let up = { x: right.y * axis.z - right.z * axis.y, y: right.z * axis.x - right.x * axis.z, z: right.x * axis.y - right.y * axis.x };
    const ul = Math.hypot(up.x, up.y, up.z) || 1; up = { x: up.x / ul, y: up.y / ul, z: up.z / ul };
    return { right, up };
  }

  /** Offset (mm, repère LOCAL SALLE) d'un câble dans la section du conduit `w` (null si pas un conduit /
      1 seul câble / non routé). */
  conduitOffsetFor(w: any, cableId: string, prev: Vec3, next: Vec3): Vec3 | null {
    const dims = this.waypointConduitDims(w); if (!dims) return null;
    const ids = this.conduitCablesOf(w.id), n = ids.length, i = ids.indexOf(cableId);
    if (n <= 1 || i < 0) return null;   // 1 câble → centré (offset nul)
    const cell = Resolver3D.conduitCell(i, n, dims.usableH > 0 ? dims.usableW / dims.usableH : 1);
    const du = ((cell.col + 0.5) / cell.cols - 0.5) * dims.usableW;
    const dv = ((cell.row + 0.5) / cell.rows - 0.5) * dims.usableH;
    const b = this.conduitBasis(w, prev, next);
    return { x: b.right.x * du + b.up.x * dv, y: b.right.y * du + b.up.y * dv, z: b.right.z * du + b.up.z * dv };
  }
}
