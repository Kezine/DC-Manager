import type { Store } from "../store";
import { RackGeometry } from "./RackGeometry";
import { FreeEquipGeometry } from "./FreeEquipGeometry";
import { Depths } from "../registries/Depths";
import { Normalize } from "../core/Normalize";
import {
  RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_EAR_MM, RACK_EAR_STANDOFF_MM,
  U_MM, SIDE_U_STEP, BRUSH_PADDING_MM, CONDUIT_W_DEFAULT, CONDUIT_H_DEFAULT,
} from "../domain/constants";

/** Vecteur monde (mm). */
export interface Vec3 { x: number; y: number; z: number; }
/** Dimensions UTILES de la section d'un conduit (marge d'exclusion déduite). */
export interface ConduitDims { usableW: number; usableH: number; kind: "segment" | "brush" | "pin"; }

/** Point 3D résolu d'un port : monde (mm) + normale sortante + baie hôte. */
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
     - resolvePort3D : point monde d'un port (rack / side / wall / libre) ;
     - géométrie des waypoints (ancre, points de passage) et des pins/brosses.
   La machinerie de RÉPARTITION conduit (offsets dans la section) vit désormais ici
   (`waypointConduitDims`/`conduitGrid`/`conduitCell`/`conduitCablesOf`/`conduitBasis`/
   `conduitOffsetFor`) : elle produit l'offset monde qu'on passe à `waypointPassPoints`
   via `off` pour répartir N câbles dans la section d'un chemin/brosse/pin à rayon.
   ============================================================================= */
export class Resolver3D {
  constructor(private store: Store) {}

  /** Résout un port en point 3D monde, ou null s'il n'est pas placé dans `dcId`. */
  resolvePort3D(portId: string, dcId: string): Port3D | null {
    const s = this.store;
    const port = s.get("ports", portId); if (!port) return null;
    // breakout : une lane émerge du connecteur du TRUNK.
    const geo = port.parent_port_id ? (s.get("ports", port.parent_port_id) || port) : port;
    const eq = s.get("equipments", port.equipment_id); if (!eq) return null;
    return this.resolveFaceAnchor3D(eq, geo, dcId);
  }

  /** Résout le PORT UPLINK virtuel d'un faisceau sur son équipement d'extrémité (patch) : centre de la face
      arrière par défaut (cf. TRUNK_UPLINK_GEO). null si l'équipement n'est pas placé dans `dcId`. */
  resolveTrunkUplink3D(equipmentId: string | null, dcId: string): Port3D | null {
    const eq = equipmentId ? this.store.get("equipments", equipmentId) : null; if (!eq) return null;
    return this.resolveFaceAnchor3D(eq, TRUNK_UPLINK_GEO, dcId);
  }

  /** Point 3D monde d'une position de FACE (`geo`) sur un équipement — mécanique UNIQUE partagée par les ports
      persistés (resolvePort3D) et les points virtuels (uplink de faisceau). null si non placé dans `dcId`. */
  resolveFaceAnchor3D(eq: any, geo: FaceGeo | any, dcId: string): Port3D | null {
    const s = this.store;

    if (eq.placement_mode === "side" && eq.rack_id) {
      const rack = s.get("racks", eq.rack_id); if (!rack || rack.datacenter_id !== dcId) return null;
      const b = RackGeometry.sideEquipBoxLocal(rack, eq);
      const xMin = Math.min(b.x0, b.x1), xMax = Math.max(b.x0, b.x1), yMin = Math.min(b.y0, b.y1), yMax = Math.max(b.y0, b.y1);
      const fx = (geo.face_x != null) ? geo.face_x : 0.5, fy = (geo.face_y != null) ? geo.face_y : 0.5;
      const xl = xMin + fx * (xMax - xMin);
      const yl = b.front ? yMin : yMax;
      const zl = b.z0 + (1 - fy) * (b.z1 - b.z0);
      const o = Normalize.rackOrientation(rack.orientation) * Math.PI / 180, co = Math.cos(o), so = Math.sin(o);
      const cx = (rack.dc_x != null) ? rack.dc_x : 0, cy = (rack.dc_y != null) ? rack.dc_y : 0;
      const sgn = b.front ? -1 : 1;
      return { x: cx + xl * co - yl * so, y: cy + xl * so + yl * co, z: zl, rackId: rack.id, n: { x: -sgn * so, y: sgn * co, z: 0 } };
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
      const o = Normalize.rackOrientation(rack.orientation) * Math.PI / 180, co = Math.cos(o), so = Math.sin(o);
      const cx = (rack.dc_x != null) ? rack.dc_x : 0, cy = (rack.dc_y != null) ? rack.dc_y : 0;
      return { x: cx + xl * co - yl * so, y: cy + xl * so + yl * co, z: zl, rackId: rack.id, n: { x: -sgn * so, y: sgn * co, z: 0 } };
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
      const o = Normalize.rackOrientation(rack.orientation) * Math.PI / 180, co = Math.cos(o), so = Math.sin(o);
      const cx = (rack.dc_x != null) ? rack.dc_x : 0, cy = (rack.dc_y != null) ? rack.dc_y : 0;
      const nx = b.n.x, ny = b.n.y;
      return { x: cx + xl * co - yl * so, y: cy + xl * so + yl * co, z: zl, rackId: rack.id, n: { x: nx * co - ny * so, y: nx * so + ny * co, z: 0 } };
    }
    if (eq.dim_mode === "free") {
      if (eq.dc_id !== dcId || eq.dc_x == null || eq.dc_y == null) return null;
      const w = FreeEquipGeometry.portWorld(eq, geo);
      return { x: w.x, y: w.y, z: w.z, rackId: null, n: FreeEquipGeometry.portNormal(eq, geo) };
    }
    if (eq.placement_mode !== "rack" || !eq.rack_id || eq.rack_u == null) return null;
    const rack = s.get("racks", eq.rack_id); if (!rack || rack.datacenter_id !== dcId) return null;
    const o = Normalize.rackOrientation(rack.orientation) * Math.PI / 180;
    const fx = Math.sin(o), fy = -Math.cos(o);
    const wx = Math.cos(o), wy = Math.sin(o);
    const mountFront = eq.rack_side !== "rear";
    const portFront = geo.face_side !== "rear";
    const emergesFront = mountFront ? portFront : !portFront;
    const dDepth = rack.depth || RACK_DEPTH_DEFAULT, halfD = dDepth / 2;
    const fm = RackGeometry.frontMargin(rack), cageD = Math.min(dDepth, RackGeometry.cageDepth(rack));
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
    const cx = (rack.dc_x != null) ? rack.dc_x : 0, cy = (rack.dc_y != null) ? rack.dc_y : 0;
    const uh = Math.max(1, eq.u_height | 0 || 1);
    const zf = (geo.face_y != null) ? (1 - geo.face_y) : 0.5;
    const ns = emergesFront ? 1 : -1;
    return {
      x: cx + off * fx + wx * lateral,
      y: cy + off * fy + wy * lateral,
      z: RackGeometry.uBaseZ(rack) + ((eq.rack_u - 1) + zf * uh) * U_MM,
      rackId: rack.id,
      n: { x: ns * fx, y: ns * fy, z: 0 },
    };
  }

  /* ---- waypoints ---- */

  /** Un waypoint est-il posé (coordonnées complètes pour sa forme) ? Délègue au store (source unique). */
  waypointIsPlaced(wp: any): boolean { return this.store.waypointIsPlaced(wp); }

  /** Point représentatif (pin = le point ; segment = milieu ; brush = milieu de traversée). */
  waypointAnchor(wp: any): { x: number; y: number; z: number } {
    if (wp.kind === "brush") { const g = this.brushGeom(wp); if (g) return { x: (g.e0.x + g.e1.x) / 2, y: (g.e0.y + g.e1.y) / 2, z: g.zc }; }
    if (wp.kind === "point" && wp.rack_id && wp.side_lr != null) { const g = this.sidePinGeom(wp); if (g) return g.world; }
    if (wp.kind === "point" && wp.rack_id && wp.cap_face) { const g = this.capPinGeom(wp); if (g) return g.world; }
    if (wp.kind === "segment" && wp.dc_x2 != null) return { x: (wp.dc_x + wp.dc_x2) / 2, y: (wp.dc_y + wp.dc_y2) / 2, z: wp.dc_z || 0 };
    return { x: wp.dc_x, y: wp.dc_y, z: wp.dc_z || 0 };
  }

  /** Points de passage RÉELS d'un câble sur un waypoint (orientation min-détour pour
      segment/brush). `off` (vecteur monde) décale les points (répartition conduit). */
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

  /* ---- géométrie des pins / brosses (repère monde de la baie hôte) ---- */

  /** Brosse de brassage (conduit contraint à une baie). null si non résolue. */
  brushGeom(wp: any): any {
    const s = this.store;
    if (wp.kind !== "brush" || !wp.rack_id) return null;
    const rack = s.get("racks", wp.rack_id); if (!rack) return null;
    const o = Normalize.rackOrientation(rack.orientation) * Math.PI / 180, co = Math.cos(o), so = Math.sin(o);
    const w = rack.width_mm || RACK_WIDTH_DEFAULT, d = rack.depth || RACK_DEPTH_DEFAULT, hd = d / 2;
    const cx = (rack.dc_x != null) ? rack.dc_x : w / 2, cy = (rack.dc_y != null) ? rack.dc_y : d / 2;
    const u0 = Math.max(1, wp.rack_u | 0), uh = Math.max(1, wp.u_height | 0);
    const z0 = RackGeometry.uBaseZ(rack) + (u0 - 1) * U_MM, z1 = z0 + uh * U_MM, zc = (z0 + z1) / 2;
    const depth = Math.min(Math.max(1, wp.depth_mm || 100), RackGeometry.cageDepth(rack));
    const fm = RackGeometry.frontMargin(rack);
    const toW = (lx: number, ly: number, lz: number) => ({ x: cx + lx * co - ly * so, y: cy + lx * so + ly * co, z: lz });
    const e0 = toW(0, -hd + fm + 2, zc), e1 = toW(0, -hd + fm + 2 + depth, zc);
    const right = { x: co, y: so, z: 0 }, up = { x: 0, y: 0, z: 1 };
    const bodyHW = RACK_MOUNT_WIDTH / 2 - RACK_EAR_MM;
    return { rack, o, co, so, cx, cy, hd, e0, e1, right, up, z0, z1, zc, depth,
      halfW: bodyHW, usableW: Math.max(0, 2 * bodyHW - 2 * BRUSH_PADDING_MM),
      usableH: Math.max(0, uh * U_MM - 2 * BRUSH_PADDING_MM), dcId: rack.datacenter_id };
  }

  /** Pin monté en marge latérale : centre du slot (bande SIDE_U_STEP) en monde. null sinon. */
  sidePinGeom(wp: any): any {
    const s = this.store;
    if (wp.kind !== "point" || !wp.rack_id || wp.side_lr == null) return null;
    const rack = s.get("racks", wp.rack_id); if (!rack) return null;
    const face = (wp.side_face === "rear") ? "rear" : "front", lr = (wp.side_lr === "right") ? "right" : "left";
    const col = (wp.side_col === 1) ? 1 : 0, uTop = Math.max(1, wp.side_u | 0);
    const b = RackGeometry.sideSlotBoxLocal(rack, face, lr, col, uTop, SIDE_U_STEP);
    const lx = (Math.min(b.x0, b.x1) + Math.max(b.x0, b.x1)) / 2, lz = (b.z0 + b.z1) / 2, ly = b.yPlane;
    const o = Normalize.rackOrientation(rack.orientation) * Math.PI / 180, co = Math.cos(o), so = Math.sin(o);
    const cx = (rack.dc_x != null) ? rack.dc_x : (rack.width_mm || RACK_WIDTH_DEFAULT) / 2;
    const cy = (rack.dc_y != null) ? rack.dc_y : (rack.depth || RACK_DEPTH_DEFAULT) / 2;
    return { rack, face, lr, col, uTop, dcId: rack.datacenter_id, world: { x: cx + lx * co - ly * so, y: cy + lx * so + ly * co, z: lz } };
  }

  /** Pin monté sur un capot : centre de la cellule sur le plan du capot. null sinon. */
  capPinGeom(wp: any): any {
    const s = this.store;
    if (wp.kind !== "point" || !wp.rack_id || !wp.cap_face) return null;
    const rack = s.get("racks", wp.rack_id); if (!rack) return null;
    const c = RackGeometry.capCellLocalCenter(rack, wp.cap_cx | 0, wp.cap_cy | 0);
    const z = (wp.cap_face === "floor") ? 0 : RackGeometry.physHeight(rack);
    const o = Normalize.rackOrientation(rack.orientation) * Math.PI / 180, co = Math.cos(o), so = Math.sin(o);
    const cx = (rack.dc_x != null) ? rack.dc_x : (rack.width_mm || RACK_WIDTH_DEFAULT) / 2;
    const cy = (rack.dc_y != null) ? rack.dc_y : (rack.depth || RACK_DEPTH_DEFAULT) / 2;
    return { rack, face: wp.cap_face, cx: wp.cap_cx | 0, cy: wp.cap_cy | 0, dcId: rack.datacenter_id,
      world: { x: cx + c.lx * co - c.ly * so, y: cy + c.lx * so + c.ly * co, z } };
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
      pin → plan ⊥ au FLUX (prev→next) ; brush → repère monde de la baie. */
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

  /** Offset MONDE (mm) d'un câble dans la section du conduit `w` (null si pas un conduit / 1 seul câble / non routé). */
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
