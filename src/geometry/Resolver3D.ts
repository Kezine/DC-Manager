import type { Store } from "../store";
import { RackGeometry } from "./RackGeometry";
import { FreeEquipGeometry } from "./FreeEquipGeometry";
import { Depths } from "../registries/Depths";
import { Normalize } from "../core/Normalize";
import {
  RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_EAR_MM,
  U_MM, SIDE_U_STEP, BRUSH_PADDING_MM,
} from "../domain/constants";

/** Point 3D résolu d'un port : monde (mm) + normale sortante + baie hôte. */
export interface Port3D { x: number; y: number; z: number; rackId: string | null; n: { x: number; y: number; z: number }; }

/* =============================================================================
   Résolution 3D contre le STORE vivant (dépendance injectée) :
     - resolvePort3D : point monde d'un port (rack / side / wall / libre) ;
     - géométrie des waypoints (ancre, points de passage) et des pins/brosses.
   La machinerie de RÉPARTITION conduit (offsets dans la section) est laissée à une
   phase ultérieure : `waypointPassPoints` reçoit l'offset déjà calculé via `off`.
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
    let off;
    if (mountFront) off = emergesFront ? frontPostOff : (frontPostOff - span);
    else off = emergesFront ? (rearPostOff + span) : rearPostOff;
    const latSign = emergesFront ? 1 : -1;
    const lateral = latSign * (((geo.face_x != null) ? geo.face_x : 0.5) - 0.5) * (RACK_MOUNT_WIDTH - 2 * RACK_EAR_MM);
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

  /** Un waypoint est-il posé (coordonnées complètes pour sa forme) ? */
  waypointIsPlaced(wp: any): boolean {
    const s = this.store;
    if (!wp) return false;
    if (wp.kind === "brush") { const rk = wp.rack_id ? s.get("racks", wp.rack_id) : null; return !!(rk && rk.datacenter_id); }
    if (wp.kind === "point" && wp.rack_id && wp.side_lr != null) { const rk = s.get("racks", wp.rack_id); return !!(rk && rk.datacenter_id); }
    if (wp.kind === "point" && wp.rack_id && wp.cap_face) { const rk = s.get("racks", wp.rack_id); return !!(rk && rk.datacenter_id); }
    return wp.dc_x != null && wp.dc_y != null && (wp.kind !== "segment" || (wp.dc_x2 != null && wp.dc_y2 != null));
  }

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
}
