import type { Store } from "../store";
import { Resolver3D } from "./Resolver3D";
import type { Port3D } from "./Resolver3D";
import { CableRouting } from "./CableRouting";
import type { Vec3 } from "./CableRouting";
import { FloorLayout } from "./FloorLayout";
import type { FloorCfg, MultiLayout, RoomPlacement } from "./FloorLayout";
import { PlacementContainers } from "../../src-shared/PlacementContainers";
import type { PlacementContainer } from "../../src-shared/PlacementContainers";
import type { BundleRouteAnalysis } from "../store/CableRouteAnalyzer";

/* =============================================================================
   SERVICE de ROUTAGE des FAISCEAUX (trunks) — agnostique du moteur de rendu,
   parallèle à `CableRouting` (cf. docs/faisceaux.md). Un faisceau relie les
   UPLINKS de ses 2 patchs d'extrémité (port VIRTUEL au centre de la face
   arrière — Resolver3D.resolveTrunkUplink3D) le long de SA route de waypoints.
   Le tracé existe dès que les 2 extrémités sont POSÉES, même si aucun port ne
   pioche encore de brin.

   RÉUTILISATION MAXIMALE : l'analyse de route vient de l'analyseur du Store
   (`bundleRoute` : grammaire du pseudo-câble + cohérence des EXTRÉMITÉS) ; la
   mécanique de polyligne (amorces ⊥, conduits, monde) vient de `CableRouting`
   (viaPoints / stubLineIn / worldLine — injecté). Dans un CONDUIT, le faisceau
   occupe un SLOT de répartition comme un câble (Resolver3D.conduitCablesOf
   énumère câbles + trunks) : il traverse physiquement la section, et ses brins
   piochés par ports n'étant pas dessinés, le trunk est LA ligne visible —
   centré, il chevaucherait un câble voisin.

   COHÉRENCE EXTRÉMITÉS ⇄ ROUTE : le prédicat aligné/inversé ne s'écrit plus
   ICI — `store.bundleRoute` est la SOURCE UNIQUE du verdict (codes
   `endpoints_split`/`endpoint_route_mismatch`, tolérance d'une route saisie à
   l'envers via `sens`), et le formulaire faisceau AFFICHE le même verdict.
   ⚠ CHANGEMENT VOULU : `r.valid` intègre désormais ces erreurs → une route
   incohérente avec ses extrémités ne trace plus RIEN, y compris le stub
   « s'arrête au mur » (`outgoingTrunkStubs`) qui, avant, se dessinait dans la
   salle de l'extrémité qui matchait l'arrivée de la route. C'est la parité avec
   les câbles (un câble à bout hors route ne trace rien) ; le SIGNAL, lui, vit
   dans le formulaire. `resolvedTrunks` (intra-salle) ne lit pas la route et
   reste inchangé.
   ============================================================================= */
export class TrunkRouting {
  constructor(private store: Store, private resolver: Resolver3D, private cables: CableRouting) {}

  /** Pseudo-câble portant la ROUTE du trunk, pour les helpers de câble qui lisent `waypoint_ids`
      (`store.cableWaypointsIn`). L'`id` du bundle sert de linkId (répartition conduit). L'ANALYSE de la
      route, elle, passe par `trunkRoute` → `store.bundleRoute`, qui juge AUSSI les extrémités. */
  private probe(bundle: any): any {
    return { id: bundle.id, from_port_id: null, to_port_id: null, waypoint_ids: bundle.waypoint_ids || [] };
  }

  /** Analyse de la route du faisceau (steps / valid / hasExits / containerA/B / sens) — source unique
      `store.bundleRoute` (cf. en-tête). ⚠ `valid` intègre la cohérence des EXTRÉMITÉS : une route
      incohérente ne trace plus rien, stub compris. */
  trunkRoute(bundle: any): BundleRouteAnalysis { return this.store.bundleRoute(bundle); }

  /** Équipement (patch) d'une extrémité du faisceau, ou null. */
  private endpointEq(bundle: any, side: "A" | "B"): any {
    const eqId = side === "A" ? bundle.endpoint_a_equipment_id : bundle.endpoint_b_equipment_id;
    return eqId ? this.store.get("equipments", eqId) : null;
  }

  /** CONTENEUR (salle ou ÉTAGE) d'une extrémité du faisceau — null si le patch n'est rattaché à rien de
      traversable. Généralise `endpointDcId`, qui ne savait rendre qu'une salle : un patch posé sur un
      étage y valait `null`, et le faisceau n'était jamais tracé (doctrine §6.31). */
  endpointContainer(bundle: any, side: "A" | "B"): PlacementContainer | null {
    const eqId = side === "A" ? bundle.endpoint_a_equipment_id : bundle.endpoint_b_equipment_id;
    return eqId ? this.store.equipmentNamedContainer(eqId) : null;
  }

  /** Uplink d'une extrémité résolu dans `dcId` (centre de la face arrière du patch), ou null. */
  endpoint3D(bundle: any, side: "A" | "B", dcId: string): Port3D | null {
    const eqId = side === "A" ? bundle.endpoint_a_equipment_id : bundle.endpoint_b_equipment_id;
    return this.resolver.resolveTrunkUplink3D(eqId, dcId);
  }

  /** Uplink d'une extrémité posée sur un ÉTAGE, résolu en MONDE — pendant de `endpoint3D`. L'origine du
      posé vient de la SOURCE UNIQUE (`FloorLayout.equipFloorOrigin`), relayée par `CableRouting` qui
      porte le layout : parité STRICTE avec le chemin des câbles (§6.31). */
  endpointWorld3D(m: MultiLayout, bundle: any, side: "A" | "B"): Port3D | null {
    const eq = this.endpointEq(bundle, side); if (!eq) return null;
    const o = this.cables.floorOriginOf(m, eq);
    return this.resolver.resolveTrunkUplinkWorld3D(eq.id, o.x, o.y, o.baseZ);
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
      const ici: PlacementContainer = { kind: "room", id: dcId };
      const endAtStart = PlacementContainers.same(r.startContainer, ici);
      if (!endAtStart && !PlacementContainers.same(r.endContainer, ici)) return;   // la route ne touche pas cette salle → rien à tracer
      const endRes = (a || b) as Port3D;
      const sp = this.cables.stubLineIn(dcId, endRes, endAtStart, r.steps, bundle.id, portNormal);
      if (!sp) return;
      out.push({ bundle, endpoint: endRes, endpointRackId: endRes.rackId ?? null, pts: sp.pts, linePts: sp.linePts, straight: sp.straight, stubAt: sp.stubAt });
    });
    return out;
  }

  /** Faisceaux inter-CONTENEURS : route valide avec exits, 2 uplinks résolus dans des conteneurs AFFICHÉS
      (salle ou ÉTAGE). pts en MONDE. Tolère une route saisie « à l'envers » (extrémité A dans le conteneur
      d'ARRIVÉE) en inversant les bouts. */
  interDcTrunks(m: MultiLayout, portNormal: boolean): Array<{ bundle: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
    const roomById = new Map<string, RoomPlacement>(m.rooms.map((r) => [r.dc.id, r]));
    const out: Array<{ bundle: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> = [];
    this.store.all("cableBundles").forEach((bundle: any) => {
      const r = this.trunkRoute(bundle);
      if (!r.valid || !r.hasExits || !r.startContainer || !r.endContainer) return;
      // Alignement extrémités ⇄ route : le prédicat ne s'écrit plus qu'UNE fois (`store.bundleRoute`), le
      // rendu consomme `sens`. null ici = extrémité absente ou non localisable (rien à ancrer) — une
      // INCOHÉRENCE, elle, a déjà invalidé la route ci-dessus (et le formulaire porte le message).
      if (!r.sens) return;
      const [sideStart, sideEnd] = r.sens === "aligned" ? ["A", "B"] as const : ["B", "A"] as const;
      // Bouts portés au MONDE par LEUR conteneur avant le tracé — parité STRICTE avec les câbles (§6.30 puis
      // §6.31) : la mécanique de polyligne reste UNIQUE, et c'est l'appelant qui sait CE QU'il résout (ici
      // l'uplink virtuel du patch, là un port persisté).
      const a = this.cables.worldEndIn(m, roomById, r.startContainer, (dcId) => this.endpoint3D(bundle, sideStart, dcId), () => this.endpointWorld3D(m, bundle, sideStart));
      const b = this.cables.worldEndIn(m, roomById, r.endContainer, (dcId) => this.endpoint3D(bundle, sideEnd, dcId), () => this.endpointWorld3D(m, bundle, sideEnd));
      if (!a || !b) return;
      const sp = this.cables.worldLine(m, roomById, a, b, r.steps, bundle.id, portNormal);
      out.push({ bundle, pts: sp.pts, linePts: sp.linePts, straight: sp.straight, stubAt: sp.stubAt });
    });
    return out;
  }

  /** Uplink d'une extrémité posée sur un ÉTAGE, en coordonnées PLAN — pendant 2D de `endpointWorld3D`
      (même translation pure, cf. `CableRouting.portOnFloorPlan`). */
  private endpointPlan3D(bundle: any, side: "A" | "B", cfg: FloorCfg): Port3D | null {
    const eq = this.endpointEq(bundle, side); if (!eq) return null;
    const pos = FloorLayout.floorEquipPos(eq, cfg);
    return this.resolver.resolveTrunkUplinkWorld3D(eq.id, pos.x, pos.y, 0);
  }

  /** Faisceaux inter-conteneurs d'un ÉTAGE, en coordonnées PLAN 2D (uplink A → waypoints de la route →
      uplink B) — réplique 2D d'interDcTrunks pour la vue Plan d'étage (parité interDcRoutesFloor).
      `planOf` (injection vue) projette un point local de salle dans le plan ; `etage` est le conteneur
      dessiné, qui sert de portée aux extrémités posées à même l'étage (décision D3). */
  interDcTrunksFloor(dcsOnFloor: Map<string, any>, cfg: FloorCfg, etage: PlacementContainer, planOf: (dc: any, p: Vec3) => Vec3): Array<{ bundle: any; pts: Vec3[] }> {
    const out: Array<{ bundle: any; pts: Vec3[] }> = [];
    this.store.all("cableBundles").forEach((bundle: any) => {
      const r = this.trunkRoute(bundle);
      if (!r.valid || !r.hasExits || !r.startContainer || !r.endContainer) return;
      // Même consommation de `sens` qu'interDcTrunks — le prédicat aligné/inversé vit dans `bundleRoute`.
      if (!r.sens) return;
      const [sideStart, sideEnd] = r.sens === "aligned" ? ["A", "B"] as const : ["B", "A"] as const;
      const a = this.cables.planEndIn(dcsOnFloor, etage, r.startContainer, planOf, (dcId) => this.endpoint3D(bundle, sideStart, dcId), () => this.endpointPlan3D(bundle, sideStart, cfg));
      const b = this.cables.planEndIn(dcsOnFloor, etage, r.endContainer, planOf, (dcId) => this.endpoint3D(bundle, sideEnd, dcId), () => this.endpointPlan3D(bundle, sideEnd, cfg));
      if (!a || !b) return;   // au moins un bout hors de cet étage → non tracé ici
      const pts: Vec3[] = [a];
      (r.steps || []).forEach((s: any) => {
        if (s.type === "floor") { const fp = FloorLayout.oobFloorPos(s.wp, cfg); pts.push({ x: fp.x, y: fp.y, z: 0 }); }
        else { const room = dcsOnFloor.get(s.wp.datacenter_id); if (room) { const al = this.resolver.waypointAnchor(s.wp); pts.push(planOf(room, { x: al.x, y: al.y, z: 0 })); } }
      });
      pts.push(b);
      out.push({ bundle, pts });
    });
    return out;
  }
}
