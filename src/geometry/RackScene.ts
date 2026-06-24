import type { Store } from "../store";
import { RackGeometry } from "./RackGeometry";
import { RackItemKinds } from "../domain/RackItemKinds";
import { SIDE_U_STEP, EQUIP_DEPTHS } from "../domain/constants";

/** Occupant à élévation (pour le rendu 3D) : U de départ, hauteur, face, profondeur, libellé. */
export interface OccupantElev { u: number; h: number; side: string; depth: string; depth_mm: any; locks_u: boolean; label: string; kind: string; id: string; }

/** Info d'occupation d'une case U:face. */
export interface OccupantInfo {
  kind: string; id: string; label: string; color: string | null;
  top: number; height: number; side: string; depth: string;
  [k: string]: any;
}

/* =============================================================================
   Géométrie de baie résolue contre le STORE vivant : occupation des U,
   emplacements side/wall libres, occupants. Décorrélé du global `store`
   historique — la dépendance est injectée au constructeur.
   ============================================================================= */
export class RackScene {
  constructor(private store: Store) {}

  /* ---- occupation des U (équipements rackés + pseudo-items + brosses) ---- */

  /** Carte d'occupation : "u:side" → info. */
  occupants(rackId: string, opts: { exceptEqId?: string; exceptItemId?: string; exceptBrushId?: string } = {}): Map<string, OccupantInfo> {
    const s = this.store;
    const rack = s.get("racks", rackId); const occ = new Map<string, OccupantInfo>();
    if (!rack) return occ;
    const put = (startU: number, height: number, sides: string[], info: OccupantInfo) => {
      for (let i = 0; i < height; i++) { const u = startU + i; sides.forEach((sd) => occ.set(u + ":" + sd, info)); }
    };
    s.equipmentsOfRack(rackId).forEach((e: any) => {
      if (e.placement_mode === "rack" && e.rack_u && e.id !== opts.exceptEqId) {
        const g = e.group_id ? s.get("groups", e.group_id) : null;
        put(e.rack_u, e.u_height || 1, RackGeometry.mountSides({ depth: e.depth, side: e.rack_side, locks_u: e.locks_u }, rack),
          { kind: "equipment", id: e.id, label: e.name || "(équipement)", type: e.type, color: g ? g.color : null, top: e.rack_u, height: e.u_height || 1, side: e.rack_side, depth: e.depth, depth_mm: e.depth_mm, locks_u: RackGeometry.mountLocksU(e) });
      }
    });
    s.rackItemsOf(rackId).forEach((it: any) => {
      if (it.u && it.id !== opts.exceptItemId) {
        put(it.u, it.u_height || 1, RackGeometry.mountSides({ side: it.side, isItem: true }, rack),
          { kind: it.kind, id: it.id, label: RackItemKinds.itemLabel(it), color: null, top: it.u, height: it.u_height || 1, side: it.side, depth: "none" });
      }
    });
    s.all("waypoints").forEach((w: any) => {
      if (w.kind === "brush" && w.rack_id === rackId && w.id !== opts.exceptBrushId) {
        const sides = rack.sides === "dual" ? ["front", "rear"] : ["front"];
        put(Math.max(1, w.rack_u | 0), Math.max(1, w.u_height | 0), sides,
          { kind: "brush", id: w.id, label: w.name || "(brosse)", color: null, top: Math.max(1, w.rack_u | 0), height: Math.max(1, w.u_height | 0), side: "front", depth: "full" });
      }
    });
    return occ;
  }

  /** Occupants à ÉLÉVATION (équipements rackés + pseudo-items), pour le rendu 3D. */
  occupantsElev(rackId: string): OccupantElev[] {
    const s = this.store;
    const eqs = s.equipmentsOfRack(rackId)
      .filter((e: any) => e.rack_u != null)
      .map((e: any) => ({ u: e.rack_u | 0, h: Math.max(1, e.u_height | 0 || 1), side: (e.rack_side === "rear") ? "rear" : "front", depth: EQUIP_DEPTHS.includes(e.depth) ? e.depth : "full", depth_mm: e.depth_mm, locks_u: RackGeometry.mountLocksU(e), label: e.name || "", kind: "eq", id: e.id }));
    const items = s.rackItemsOf(rackId)
      .filter((it: any) => it.u != null)
      .map((it: any) => ({ u: it.u | 0, h: Math.max(1, it.u_height | 0 || 1), side: (it.side === "rear") ? "rear" : "front", depth: "none", depth_mm: undefined, locks_u: false, label: it.label || "", kind: "item", id: it.id }));
    return (eqs as OccupantElev[]).concat(items as OccupantElev[]);
  }

  occupancyCount(rackId: string): number {
    return this.store.equipmentsOfRack(rackId).filter((e: any) => e.placement_mode === "rack").length
      + this.store.rackItemsOf(rackId).length;
  }

  /** U libres + plus grand bloc d'U contigus libres (un U pris dès qu'une face l'est). */
  freeUInfo(rackId: string): { free: number; contig: number; total: number } {
    const rack = this.store.get("racks", rackId);
    const total = rack ? (rack.u_count || 0) : 0;
    const occ = this.occupants(rackId);
    let free = 0, contig = 0, run = 0;
    for (let u = 1; u <= total; u++) {
      const taken = occ.has(u + ":front") || occ.has(u + ":rear");
      if (taken) { run = 0; } else { free++; run++; if (run > contig) contig = run; }
    }
    return { free, contig, total };
  }

  /** Équipements affectés au rack SANS position U (positionnement libre). */
  freeMounts(rackId: string): any[] {
    return this.store.equipmentsOfRack(rackId).filter((e: any) => e.placement_mode === "rack" && !e.rack_u);
  }

  /* ---- side-mount ---- */

  sideOccupants(rackId: string, face: string | null, lr: string | null): any[] {
    return this.store.equipmentsOfRack(rackId).filter((e: any) => e.placement_mode === "side"
      && (face == null || (e.side_face === "rear" ? "rear" : "front") === face)
      && (lr == null || (e.side_lr === "right" ? "right" : "left") === lr));
  }
  /** Pins de waypoint montés en marge latérale (occupent une bande SIDE_U_STEP). */
  sidePins(rackId: string, face: string | null, lr: string | null): any[] {
    return this.store.all("waypoints").filter((w: any) => w.kind === "point" && w.rack_id === rackId && w.side_lr != null
      && (face == null || (w.side_face === "rear" ? "rear" : "front") === face)
      && (lr == null || (w.side_lr === "right" ? "right" : "left") === lr));
  }
  /** La bande [uTop, uTop+heightU) d'une colonne (face/côté) est-elle libre ? */
  sideSlotFree(rackId: string, face: string, lr: string, col: number, uTop: number, heightU: number, exceptId: string | null): boolean {
    const lo = uTop, hi = uTop + heightU, sameCol = (c: any) => (c === 1 ? 1 : 0) === (col === 1 ? 1 : 0);
    const eqClash = this.sideOccupants(rackId, face, lr).some((e: any) => {
      if (e.id === exceptId || !sameCol(e.side_col)) return false;
      const eLo = Math.max(1, e.side_u | 0), eHi = eLo + RackGeometry.sideEquipHeightU(e);
      return lo < eHi && eLo < hi;
    });
    if (eqClash) return false;
    return !this.sidePins(rackId, face, lr).some((w: any) => {
      if (w.id === exceptId || !sameCol(w.side_col)) return false;
      const pLo = Math.max(1, w.side_u | 0), pHi = pLo + SIDE_U_STEP;
      return lo < pHi && pLo < hi;
    });
  }
  /** Emplacements latéraux LIBRES (bandes SIDE_U_STEP) par face × côté × colonne. */
  sideFreeSlots(rack: any): Array<{ face: string; lr: string; col: number; uTop: number }> {
    const out: Array<{ face: string; lr: string; col: number; uTop: number }> = [];
    ["front", "rear"].forEach((face) => {
      if (!RackGeometry.sideEnabled(rack, face)) return;
      const cols = RackGeometry.sideColumns(rack), uMax = rack.u_count || 42;
      ["left", "right"].forEach((lr) => {
        for (let c = 0; c < cols; c++) {
          for (let u = 1; u + SIDE_U_STEP - 1 <= uMax; u += SIDE_U_STEP) {
            if (this.sideSlotFree(rack.id, face, lr, c, u, SIDE_U_STEP, null)) out.push({ face, lr, col: c, uTop: u });
          }
        }
      });
    });
    return out;
  }

  /* ---- wall-mount ---- */

  wallOccupants(rackId: string, margin: string | null, wall: string | null): any[] {
    return this.store.equipmentsOfRack(rackId).filter((e: any) => e.placement_mode === "wall"
      && (margin == null || (e.wall_margin === "rear" ? "rear" : "front") === margin)
      && (wall == null || (e.wall_lr === "right" ? "right" : "left") === wall));
  }
  wallSlotFree(rackId: string, wall: string, margin: string, col: number, uTop: number, heightU: number, exceptId: string | null): boolean {
    const lo = uTop, hi = uTop + heightU;
    return !this.wallOccupants(rackId, margin, wall).some((e: any) => {
      if (e.id === exceptId) return false;
      if ((e.wall_col | 0) !== (col | 0)) return false;
      const eLo = Math.max(1, e.wall_u | 0), eHi = eLo + RackGeometry.sideEquipHeightU(e);
      return lo < eHi && eLo < hi;
    });
  }
  wallFreeSlots(rack: any): Array<{ wall: string; margin: string; col: number; uTop: number }> {
    const out: Array<{ wall: string; margin: string; col: number; uTop: number }> = [], uMax = rack.u_count || 42;
    ["front", "rear"].forEach((margin) => {
      if (!RackGeometry.wallEnabled(rack, margin)) return;
      const cols = RackGeometry.wallGeo(rack, margin).cols;
      ["left", "right"].forEach((wall) => {
        for (let c = 0; c < cols; c++) {
          for (let u = 1; u + SIDE_U_STEP - 1 <= uMax; u += SIDE_U_STEP) {
            if (this.wallSlotFree(rack.id, wall, margin, c, u, SIDE_U_STEP, null)) out.push({ wall, margin, col: c, uTop: u });
          }
        }
      });
    });
    return out;
  }

  /* ---- capots ---- */

  capSlotOccupied(rackId: string, face: string, cx: number, cy: number, exceptId: string | null): boolean {
    return this.store.all("waypoints").some((w: any) => w.kind === "point" && w.rack_id === rackId && w.cap_face === face
      && (w.cap_cx | 0) === (cx | 0) && (w.cap_cy | 0) === (cy | 0) && w.id !== exceptId);
  }
  capFreeSlots(rack: any, face: string): Array<{ cx: number; cy: number }> {
    const g = RackGeometry.capGrid(rack);
    return RackGeometry.capCells(rack, face).map((k) => { const p = k.split(","); return { cx: +p[0], cy: +p[1] }; })
      .filter((c) => isFinite(c.cx) && isFinite(c.cy) && c.cx >= 0 && c.cy >= 0 && c.cx < g.nx && c.cy < g.ny
        && !this.capSlotOccupied(rack.id, face, c.cx, c.cy, null));
  }
}
