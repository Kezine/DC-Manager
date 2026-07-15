import type { Store } from "../store";
import { Resolver3D } from "./Resolver3D";
import type { Port3D } from "./Resolver3D";
import { CableRouting } from "./CableRouting";
import type { Vec3 } from "./CableRouting";
import { FloorLayout } from "./FloorLayout";
import type { MultiLayout, RoomPlacement } from "./FloorLayout";

/* =============================================================================
   SERVICE de ROUTAGE des FAISCEAUX (trunks) — agnostique du moteur de rendu,
   parallèle à `CableRouting` (cf. docs/faisceaux.md). Un faisceau relie les
   UPLINKS de ses 2 patchs d'extrémité (port VIRTUEL au centre de la face
   arrière — Resolver3D.resolveTrunkUplink3D) le long de SA route de waypoints.
   Le tracé existe dès que les 2 extrémités sont POSÉES, même si aucun port ne
   pioche encore de brin.

   RÉUTILISATION MAXIMALE : la grammaire de route vient de l'analyseur du Store
   (`cableRoute` sur un PSEUDO-CÂBLE portant la ROUTE du trunk, sans erreurs de
   bouts puisqu'il n'a pas de ports) ; la
   mécanique de polyligne (amorces ⊥, conduits, monde) vient de `CableRouting`
   (viaPoints / stubLineIn / worldLine — injecté). Dans un CONDUIT, le faisceau
   occupe un SLOT de répartition comme un câble (Resolver3D.conduitCablesOf
   énumère câbles + trunks) : il traverse physiquement la section, et ses brins
   piochés par ports n'étant pas dessinés, le trunk est LA ligne visible —
   centré, il chevaucherait un câble voisin.
   ============================================================================= */
export class TrunkRouting {
  constructor(private store: Store, private resolver: Resolver3D, private cables: CableRouting) {}

  /** Pseudo-câble portant la ROUTE du trunk : pas de ports → l'analyse de route (grammaire exits/étage)
      s'applique sans erreurs de bouts. L'`id` du bundle sert de linkId (répartition conduit). */
  private probe(bundle: any): any {
    return { id: bundle.id, from_port_id: null, to_port_id: null, waypoint_ids: bundle.waypoint_ids || [] };
  }

  /** Analyse de la route du faisceau (steps / valid / hasExits / startDc / endDc). */
  trunkRoute(bundle: any): any { return this.store.cableRoute(this.probe(bundle)); }

  /** Salle (datacenter) d'une extrémité du faisceau — null si non posée. */
  endpointDcId(bundle: any, side: "A" | "B"): string | null {
    const eqId = side === "A" ? bundle.endpoint_a_equipment_id : bundle.endpoint_b_equipment_id;
    return eqId ? this.store.equipmentDcId(eqId) : null;
  }

  /** Uplink d'une extrémité résolu dans `dcId` (centre de la face arrière du patch), ou null. */
  endpoint3D(bundle: any, side: "A" | "B", dcId: string): Port3D | null {
    const eqId = side === "A" ? bundle.endpoint_a_equipment_id : bundle.endpoint_b_equipment_id;
    return this.resolver.resolveTrunkUplink3D(eqId, dcId);
  }

  /** Faisceaux INTRA-salle (deux uplinks résolus dans `dcId`) → tracés en coords locales de salle. */
  resolvedTrunks(dcId: string, portNormal: boolean): Array<{ bundle: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
    const out: Array<{ bundle: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> = [];
    this.store.all("cableBundles").forEach((bundle: any) => {
      const a = this.endpoint3D(bundle, "A", dcId), b = this.endpoint3D(bundle, "B", dcId);
      if (!a || !b) return;
      const viaW = this.cables.viaPoints(this.store.cableWaypointsIn(this.probe(bundle), dcId), a, b, bundle.id);
      const sp = this.cables.cableLine(a, b, viaW, portNormal);
      out.push({ bundle, pts: sp.pts, linePts: sp.linePts, straight: sp.straight, stubAt: sp.stubAt });
    });
    return out;
  }

  /** Faisceaux dont UN SEUL uplink est résolu dans `dcId` et dont la route sort par un exit : tracés de
      l'uplink LOCAL jusqu'à l'exit de CETTE salle (« s'arrête au mur »). `endpointRackId` permet de masquer
      le stub avec sa baie (parité stubs de câbles). */
  outgoingTrunkStubs(dcId: string, portNormal: boolean): Array<{ bundle: any; endpoint: Vec3; endpointRackId: string | null; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
    const out: Array<{ bundle: any; endpoint: Vec3; endpointRackId: string | null; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> = [];
    this.store.all("cableBundles").forEach((bundle: any) => {
      const a = this.endpoint3D(bundle, "A", dcId), b = this.endpoint3D(bundle, "B", dcId);
      if ((a && b) || (!a && !b)) return;
      const r = this.trunkRoute(bundle);
      if (!r.valid || !r.hasExits) return;
      // Direction de la marche dans la route : par la SALLE (le trunk n'a pas de sens from/to imposé par un
      // formulaire) — la route commence ici → on descend depuis le début ; elle finit ici → on remonte la fin.
      const endAtStart = r.startDc === dcId;
      if (!endAtStart && r.endDc !== dcId) return;   // la route ne touche pas cette salle → rien à tracer
      const endRes = (a || b) as Port3D;
      const sp = this.cables.stubLineIn(dcId, endRes, endAtStart, r.steps, bundle.id, portNormal);
      if (!sp) return;
      out.push({ bundle, endpoint: endRes, endpointRackId: endRes.rackId ?? null, pts: sp.pts, linePts: sp.linePts, straight: sp.straight, stubAt: sp.stubAt });
    });
    return out;
  }

  /** Faisceaux inter-salles : route valide avec exits, 2 uplinks résolus dans des salles AFFICHÉES. pts en
      MONDE. Tolère une route saisie « à l'envers » (extrémité A dans la salle d'ARRIVÉE) en inversant les bouts. */
  interDcTrunks(m: MultiLayout, portNormal: boolean): Array<{ bundle: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
    const roomById = new Map<string, RoomPlacement>(m.rooms.map((r) => [r.dc.id, r]));
    const out: Array<{ bundle: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> = [];
    this.store.all("cableBundles").forEach((bundle: any) => {
      const r = this.trunkRoute(bundle);
      if (!r.valid || !r.hasExits || !r.startDc || !r.endDc) return;
      const dcA = this.endpointDcId(bundle, "A"), dcB = this.endpointDcId(bundle, "B");
      if (!dcA || !dcB) return;
      // aligne les extrémités sur le sens de la route (A → salle de départ) ; incohérent → non tracé (parité câbles).
      const aligned = (dcA === r.startDc && dcB === r.endDc);
      const swapped = !aligned && (dcB === r.startDc && dcA === r.endDc);
      if (!aligned && !swapped) return;
      const [sideStart, sideEnd] = aligned ? ["A", "B"] as const : ["B", "A"] as const;
      const ra = roomById.get(r.startDc), rb = roomById.get(r.endDc);
      if (!ra || !rb) return;
      const a = this.endpoint3D(bundle, sideStart, r.startDc), b = this.endpoint3D(bundle, sideEnd, r.endDc);
      if (!a || !b) return;
      const sp = this.cables.worldLine(m, roomById, ra, rb, a, b, r.steps, bundle.id, portNormal);
      out.push({ bundle, pts: sp.pts, linePts: sp.linePts, straight: sp.straight, stubAt: sp.stubAt });
    });
    return out;
  }

  /** Faisceaux inter-salles d'un ÉTAGE, en coordonnées PLAN 2D (uplink A → waypoints de la route → uplink B) —
      réplique 2D d'interDcTrunks pour la vue Plan d'étage (parité interDcRoutesFloor). `planOf` (injection vue)
      projette un point local de salle dans le plan. */
  interDcTrunksFloor(dcsOnFloor: Map<string, any>, cfg: any, planOf: (dc: any, p: Vec3) => Vec3): Array<{ bundle: any; pts: Vec3[] }> {
    const out: Array<{ bundle: any; pts: Vec3[] }> = [];
    this.store.all("cableBundles").forEach((bundle: any) => {
      const r = this.trunkRoute(bundle);
      if (!r.valid || !r.hasExits || !r.startDc || !r.endDc) return;
      const dcA = this.endpointDcId(bundle, "A"), dcB = this.endpointDcId(bundle, "B");
      if (!dcA || !dcB) return;
      const aligned = (dcA === r.startDc && dcB === r.endDc);
      const swapped = !aligned && (dcB === r.startDc && dcA === r.endDc);
      if (!aligned && !swapped) return;
      const [sideStart, sideEnd] = aligned ? ["A", "B"] as const : ["B", "A"] as const;
      const da = dcsOnFloor.get(r.startDc), db = dcsOnFloor.get(r.endDc);
      if (!da || !db) return;   // au moins un bout hors de cet étage → non tracé ici
      const a = this.endpoint3D(bundle, sideStart, r.startDc), b = this.endpoint3D(bundle, sideEnd, r.endDc);
      if (!a || !b) return;
      const pts: Vec3[] = [planOf(da, { x: a.x, y: a.y, z: 0 })];
      (r.steps || []).forEach((s: any) => {
        if (s.type === "floor") { const fp = FloorLayout.oobFloorPos(s.wp, cfg); pts.push({ x: fp.x, y: fp.y, z: 0 }); }
        else { const room = dcsOnFloor.get(s.wp.datacenter_id); if (room) { const al = this.resolver.waypointAnchor(s.wp); pts.push(planOf(room, { x: al.x, y: al.y, z: 0 })); } }
      });
      pts.push(planOf(db, { x: b.x, y: b.y, z: 0 }));
      out.push({ bundle, pts });
    });
    return out;
  }
}
