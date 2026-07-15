import type { Store } from "../store";
import { Resolver3D } from "./Resolver3D";
import { FloorLayout } from "./FloorLayout";
import type { MultiLayout, RoomPlacement } from "./FloorLayout";
import { Waypoint } from "../models/Waypoint";

/** Point monde (mm) : X = largeur, Y = profondeur, Z = hauteur. */
export interface Vec3 { x: number; y: number; z: number; }

const CABLE_PORT_STUB_MM = 20;   // longueur de l'amorce ⊥ d'un port (cf. dc/shared.CABLE_PORT_STUB_MM)

/* =============================================================================
   SERVICE de ROUTAGE des câbles — agnostique du moteur de rendu (SVG comme WebGL).
   Produit des POLYLIGNES (points + indices de segments droits + amorces) à partir
   du store + Resolver3D + FloorLayout. Aucune dépendance au DOM ni à une vue :
   les deux moteurs le consomment, et il survit à la suppression du rendu SVG.
   `cablePortNormal` (sortie ⊥ des ports) est passé en paramètre (état de vue).
   ============================================================================= */
export class CableRouting {
  constructor(private store: Store, private resolver: Resolver3D, private floor: FloorLayout) {}

  /** Couleur d'un câble = couleur de son réseau principal DÉDUIT (des ports terminaux ; null sinon). */
  cableColor(c: any): string | null { const nid = this.store.cablePrimaryNetworkId(c); const n: any = nid ? this.store.get("networks", nid) : null; return (n && n.color) ? n.color : null; }

  /** Tracé d'un câble (mécanique UNIQUE ports + conduits) :
        - `pts`      : points ORIGINAUX (pastilles) ;
        - `linePts`  : points du TRACÉ (avec amorces ⊥ si `portNormal`) ;
        - `straight` : indices de segments tracés DROITS (corps de conduit + amorces) ;
        - `stubAt`   : indices des points d'AMORCE (tangente G1 imposée).
      Corps de conduit (2 points consécutifs du même segment/brush) TOUJOURS droit ; amorce ⊥ de 20 mm
      à chaque port / entrée-sortie de conduit si `portNormal`, bornée à 45 % de la distance au voisin. */
  cableLine(a: any, b: any, viaW: Array<{ wp?: any; p: Vec3 }>, portNormal: boolean): { pts: Vec3[]; linePts: Vec3[]; straight: Set<number>; stubAt: Set<number> } {
    const on = portNormal, STUB = CABLE_PORT_STUB_MM;
    const dist = (p: Vec3, q: Vec3) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    const pts: Vec3[] = [a as Vec3].concat(viaW.map((v) => v.p), [b as Vec3]);
    const linePts: Vec3[] = []; const straight = new Set<number>(); const stubAt = new Set<number>();
    const push = (p: Vec3, straightSeg: boolean, isStub: boolean) => { if (straightSeg && linePts.length) straight.add(linePts.length - 1); if (isStub) stubAt.add(linePts.length); linePts.push(p); };
    const stubAlong = (pt: Vec3, dir: any, toward: Vec3 | null): Vec3 | null => {
      if (!on || !pt || !dir || !toward) return null;
      const u = Math.hypot(dir.x, dir.y, dir.z) || 1, L = Math.min(STUB, dist(pt, toward) * 0.45); if (L < 0.5) return null;
      return { x: pt.x + dir.x / u * L, y: pt.y + dir.y / u * L, z: pt.z + dir.z / u * L };
    };
    const sa = stubAlong(a, a && a.n, viaW.length ? viaW[0].p : b), sb = stubAlong(b, b && b.n, viaW.length ? viaW[viaW.length - 1].p : a);
    push(a, false, false);
    if (sa) push(sa, true, true);
    let i = 0;
    while (i < viaW.length) {
      const w = viaW[i].wp;
      const isConduit = i + 1 < viaW.length && w && viaW[i + 1].wp && viaW[i + 1].wp.id === w.id && (w.kind === "segment" || w.kind === "brush");
      if (isConduit) {
        const e0 = viaW[i].p, e1 = viaW[i + 1].p;
        const pred = linePts[linePts.length - 1], succ = (i + 2 < viaW.length) ? viaW[i + 2].p : b;
        const sIn = stubAlong(e0, { x: e0.x - e1.x, y: e0.y - e1.y, z: e0.z - e1.z }, pred);
        if (sIn) push(sIn, false, true);
        push(e0, !!sIn, false);
        push(e1, true, false);
        const sOut = stubAlong(e1, { x: e1.x - e0.x, y: e1.y - e0.y, z: e1.z - e0.z }, succ);
        if (sOut) push(sOut, true, true);
        i += 2;
      } else { push(viaW[i].p, false, false); i += 1; }
    }
    if (sb) { push(sb, false, true); push(b, true, false); }
    else push(b, false, false);
    return { pts, linePts, straight, stubAt };
  }

  /** Normale d'un bout résolu (repère LOCAL salle) tournée dans le repère MONDE de sa salle (W affine). */
  worldEndNormal(room: RoomPlacement, res: any): Vec3 | null {
    if (!res || !res.n) return null;
    const w0 = FloorLayout.roomToWorld(room, res as Vec3);
    const w1 = FloorLayout.roomToWorld(room, { x: res.x + res.n.x, y: res.y + res.n.y, z: res.z + res.n.z });
    return { x: w1.x - w0.x, y: w1.y - w0.y, z: w1.z - w0.z };
  }

  /** Points de passage TAGUÉS d'une liaison sur une suite de waypoints (répartition conduit incluse) — mécanique
      UNIQUE partagée par les câbles ET les faisceaux (TrunkRouting), en intra-salle comme sur un stub. `linkId`
      alimente la répartition conduit (câble OU faisceau : les deux occupent un slot de la section — cf.
      Resolver3D.conduitCablesOf). */
  viaPoints(wps: any[], a: Vec3, b: Vec3, linkId: string): Array<{ wp: any; p: Vec3 }> {
    const anchors = wps.map((w: any) => this.resolver.waypointAnchor(w));
    const viaW: Array<{ wp: any; p: Vec3 }> = [];
    wps.forEach((w: any, i: number) => {
      const prev = i === 0 ? a : anchors[i - 1], next = i === wps.length - 1 ? b : anchors[i + 1];
      const off = this.resolver.conduitOffsetFor(w, linkId, prev, next);
      this.resolver.waypointPassPoints(w, prev, next, off).forEach((p: Vec3) => viaW.push({ wp: w, p }));
    });
    return viaW;
  }

  /** Câbles INTRA-salle (deux bouts résolus dans `dcId`) → tracés en coords locales de salle. */
  resolvedCables(dcId: string, portNormal: boolean): Array<{ cable: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
    const out: Array<{ cable: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> = [];
    this.store.all("cables").forEach((c: any) => {
      const a = this.resolver.resolvePort3D(c.from_port_id, dcId), b = this.resolver.resolvePort3D(c.to_port_id, dcId);
      if (!a || !b) return;
      const viaW = this.viaPoints(this.store.cableWaypointsIn(c, dcId), a, b, c.id);
      const sp = this.cableLine(a, b, viaW, portNormal);
      out.push({ cable: c, pts: sp.pts, linePts: sp.linePts, straight: sp.straight, stubAt: sp.stubAt });
    });
    return out;
  }

  /** STUB SORTANT d'une liaison (câble OU faisceau) : tracé du bout résolu LOCALEMENT jusqu'à l'exit de CETTE
      salle (« s'arrête au mur »), le long des waypoints de la route qui restent dans la salle. `endAtStart` :
      le bout local est-il au DÉBUT de la route (sinon on remonte la route depuis la fin). null si la route ne
      traverse pas d'exit de cette salle. Mécanique UNIQUE câbles ⇄ faisceaux. */
  stubLineIn(dcId: string, endRes: Vec3, endAtStart: boolean, routeSteps: any[], linkId: string, portNormal: boolean): { pts: Vec3[]; linePts: Vec3[]; straight: Set<number>; stubAt: Set<number> } | null {
    const inRoom: any[] = [];
    if (endAtStart) {
      for (const s of routeSteps) {
        if (s.type === "floor" || s.wp.datacenter_id !== dcId) break;
        inRoom.push(s.wp);
        if (s.type === "exit") break;
      }
    } else {
      for (let i = routeSteps.length - 1; i >= 0; i--) {
        const s = routeSteps[i];
        if (s.type === "floor" || s.wp.datacenter_id !== dcId) break;
        inRoom.unshift(s.wp);
        if (s.type === "exit") break;
      }
    }
    if (!inRoom.length || Waypoint.typeOf(inRoom[endAtStart ? inRoom.length - 1 : 0]) !== "exit") return null;
    const anchors = inRoom.map((w) => this.resolver.waypointAnchor(w));
    const viaW: Array<{ wp: any; p: Vec3 }> = [];
    inRoom.forEach((w, i) => {
      const prev = (i === 0) ? (endAtStart ? endRes : anchors[i]) : anchors[i - 1];
      const next = (i === inRoom.length - 1) ? (endAtStart ? anchors[i] : endRes) : anchors[i + 1];
      const off = this.resolver.conduitOffsetFor(w, linkId, prev, next);
      this.resolver.waypointPassPoints(w, prev, next, off).forEach((p: Vec3) => viaW.push({ wp: w, p }));
    });
    return !viaW.length ? { pts: [endRes], linePts: [endRes], straight: new Set<number>(), stubAt: new Set<number>() }
      : endAtStart ? this.cableLine(endRes, viaW[viaW.length - 1].p, viaW.slice(0, -1), portNormal)
      : this.cableLine(viaW[0].p, endRes, viaW.slice(1), portNormal);
  }

  /** Câbles dont UN SEUL bout est résolu dans `dcId` et qui sortent par un exit : tracés du port LOCAL
      jusqu'à l'exit de CETTE salle (« s'arrête au mur »). pts en coords locales de salle. */
  outgoingCableStubs(dcId: string, portNormal: boolean): Array<{ cable: any; portId: string; port: Vec3; portRackId: string | null; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
    const out: Array<{ cable: any; portId: string; port: Vec3; portRackId: string | null; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> = [];
    this.store.all("cables").forEach((c: any) => {
      const a = this.resolver.resolvePort3D(c.from_port_id, dcId), b = this.resolver.resolvePort3D(c.to_port_id, dcId);
      if ((a && b) || (!a && !b)) return;
      const r = this.store.cableRoute(c);
      if (!r.valid || !r.hasExits) return;
      const portAtStart = !!a;
      const portRes = (a || b) as Vec3, portId = portAtStart ? c.from_port_id : c.to_port_id;
      const sp = this.stubLineIn(dcId, portRes, portAtStart, r.steps, c.id, portNormal);
      if (!sp) return;
      out.push({ cable: c, portId, port: portRes, portRackId: (portRes as any).rackId ?? null, pts: sp.pts, linePts: sp.linePts, straight: sp.straight, stubAt: sp.stubAt });
    });
    return out;
  }

  /** Points de passage MONDE d'une route (waypoints de salle résolus dans leur salle + OOB au monde). */
  buildWorldVia(steps: any[], roomById: Map<string, RoomPlacement>, m: MultiLayout, aw: Vec3, bw: Vec3, cableId: string): Array<{ p: Vec3; wp: any; oob?: boolean }> {
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

  /** Ligne MONDE d'une liaison inter-salles (câble OU faisceau) : bouts locaux `a`/`b` (résolus dans `ra`/`rb`)
      portés au monde (normales tournées), points de passage de la route, tracé. Mécanique UNIQUE câbles ⇄ faisceaux. */
  worldLine(m: MultiLayout, roomById: Map<string, RoomPlacement>, ra: RoomPlacement, rb: RoomPlacement, a: any, b: any, routeSteps: any[], linkId: string, portNormal: boolean): { pts: Vec3[]; linePts: Vec3[]; straight: Set<number>; stubAt: Set<number> } {
    const aw: any = FloorLayout.roomToWorld(ra, a as Vec3), bw: any = FloorLayout.roomToWorld(rb, b as Vec3);
    aw.n = this.worldEndNormal(ra, a); bw.n = this.worldEndNormal(rb, b);
    const via = this.buildWorldVia(routeSteps, roomById, m, aw, bw, linkId);
    return this.cableLine(aw, bw, via, portNormal);
  }

  /** Câbles inter-salles : route valide avec exits, 2 bouts résolus dans des salles AFFICHÉES. pts en MONDE. */
  interDcRoutes(m: MultiLayout, portNormal: boolean): Array<{ cable: any; a: any; b: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
    const roomById = new Map<string, RoomPlacement>(m.rooms.map((r) => [r.dc.id, r]));
    const out: Array<{ cable: any; a: any; b: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> = [];
    this.store.all("cables").forEach((c: any) => {
      const r = this.store.cableRoute(c);
      if (!r.valid || !r.hasExits || !r.dcA || !r.dcB) return;
      const ra = roomById.get(r.dcA), rb = roomById.get(r.dcB);
      if (!ra || !rb) return;
      const a = this.resolver.resolvePort3D(c.from_port_id, r.dcA), b = this.resolver.resolvePort3D(c.to_port_id, r.dcB);
      if (!a || !b) return;
      const sp = this.worldLine(m, roomById, ra, rb, a, b, r.steps, c.id, portNormal);
      out.push({ cable: c, a, b, pts: sp.pts, linePts: sp.linePts, straight: sp.straight, stubAt: sp.stubAt });
    });
    return out;
  }
}
