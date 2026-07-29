import type { Store } from "../store";
import { Resolver3D } from "./Resolver3D";
import type { Port3D } from "./Resolver3D";
import { FloorLayout } from "./FloorLayout";
import type { FloorCfg, MultiLayout, RoomPlacement, WorldEnd } from "./FloorLayout";
import { PlacementContainers } from "../../src-shared/PlacementContainers";
import type { PlacementContainer } from "../../src-shared/PlacementContainers";
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

  /** Le câble transporte-t-il de l'ÉNERGIE (→ éclair d'avertissement ambre en scène) ? DÉLÈGUE au prédicat PARTAGÉ
      `Store.cableCarriesPower` (type de genre `power`, OU deux extrémités PoE dont l'injection/consommation est
      ACTIVÉE des deux côtés). Reste ici pour que les deux moteurs (SVG `DcBase` / WebGL `DcThreeScene`) passent tous
      par `this.routing` sans dupliquer le test. Cf. docs/power.md. */
  carriesPower(c: any): boolean {
    return this.store.cableCarriesPower(c);
  }

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

  /* ⚠ `worldEndNormal(room, res)` VIVAIT ICI. Elle tournait la normale d'un bout en composant DEUX
     `roomToWorld` — donc elle appliquait, dans le TRACEUR, la transformée d'un CONTENEUR. Elle est
     devenue `FloorLayout.roomDirToWorld`, à l'endroit qui possède déjà cette transformée, et le
     traceur ne reçoit plus que des extrémités DÉJÀ EN MONDE (doctrine §6.30). */

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

  /** Ligne MONDE d'une liaison inter-conteneurs (câble OU faisceau) : extrémités DÉJÀ EXPRIMÉES EN MONDE,
      points de passage de la route, tracé. Mécanique UNIQUE câbles ⇄ faisceaux.

      ⚠ CE QUI A CHANGÉ, ET POURQUOI (doctrine §6.30, décision D1). Cette méthode prenait deux bouts en
      LOCAL SALLE plus la transformée de LEUR salle (`ra`/`rb`), et les portait au monde elle-même. Elle
      exigeait donc que toute extrémité de liaison VIVE DANS UNE SALLE — ce qu'un équipement posé sur un
      ÉTAGE ne fait pas, et ce qui bloquait son câblage. Elle ne connaît plus la NATURE des conteneurs :
      c'est l'APPELANT qui résout chaque bout dans le sien (`FloorLayout.roomEndToWorld` pour une salle,
      `Resolver3D.resolvePortWorld3D` pour un étage). Ce n'est pas un contrôle perdu : la grammaire des
      exits vit dans `CableRouteAnalyzer`, dont on ne fait ici que CONSOMMER le verdict (`r.valid`,
      `r.hasExits`). Et c'est le traitement que `buildWorldVia` réservait DÉJÀ aux points de PASSAGE —
      un waypoint d'étage part droit en monde, un waypoint de salle passe par sa salle ; seules les
      extrémités étaient restées câblées en dur sur « salle ».

      ⚠ `m` et `roomById` RESTENT, et ce n'est pas une inconséquence : ils servent aux points de PASSAGE
      (`buildWorldVia`), pas aux extrémités. Les généraliser est le lot de la grammaire de route. */
  worldLine(m: MultiLayout, roomById: Map<string, RoomPlacement>, aWorld: WorldEnd, bWorld: WorldEnd, routeSteps: any[], linkId: string, portNormal: boolean): { pts: Vec3[]; linePts: Vec3[]; straight: Set<number>; stubAt: Set<number> } {
    const via = this.buildWorldVia(routeSteps, roomById, m, aWorld, bWorld, linkId);
    return this.cableLine(aWorld, bWorld, via, portNormal);
  }

  /** Extrémité d'une liaison portée au MONDE depuis SON conteneur — l'UNIQUE endroit du traceur qui
      regarde encore la NATURE d'un conteneur, et seulement pour savoir QUI le résout et OÙ vérifier qu'il
      est affiché. Le reste du tracé ne voit que des points monde (doctrine §6.30 puis §6.31).

      `enSalle` résout le bout en LOCAL SALLE (`resolvePort3D`, la transformée de la salle est appliquée
      ici) ; `surEtage` le résout DÉJÀ EN MONDE (`resolvePortWorld3D`, qui a reçu l'origine du plan
      d'étage). Les deux sont fournis par l'appelant parce que lui seul sait CE QU'il résout : un port
      persisté pour un câble, l'uplink virtuel pour un faisceau.

      ⚠ DÉCISION D3 : un ÉTAGE est un conteneur AFFICHABLE au même titre qu'une salle. Une salle non
      affichée fait déjà disparaître le tracé (`roomById.get` → `undefined`) ; un étage non affiché le fait
      aussi (`FloorLayout.floorShown`). Aucun cas particulier, dans un sens ni dans l'autre.

      null = conteneur absent, non affiché, non traçable (une baie n'est pas un conteneur d'extrémité de
      liaison : ses contenus se résolvent dans la salle qui la porte), ou bout non résolu. */
  worldEndIn(m: MultiLayout, roomById: Map<string, RoomPlacement>, container: PlacementContainer | null,
             enSalle: (dcId: string) => Port3D | null, surEtage: () => Port3D | null): WorldEnd | null {
    if (!container) return null;
    if (container.kind === "room") {
      const room = roomById.get(container.id); if (!room) return null;
      const p = enSalle(container.id); return p ? FloorLayout.roomEndToWorld(room, p) : null;
    }
    if (container.kind === "floor") {
      if (!FloorLayout.floorShown(m, container.location, container.floor)) return null;
      const p = surEtage(); return p ? FloorLayout.worldEndOf(p) : null;
    }
    return null;
  }

  /** Origine MONDE du repère propre d'un équipement posé sur un ÉTAGE — relais vers la SOURCE UNIQUE
      (`FloorLayout.equipFloorOrigin`, doctrine §6.27) pour les appelants qui consomment ce service sans
      avoir le layout injecté (`TrunkRouting`). Recalculer cette origine chez eux reposerait la question du
      `dc_z`, et il suffit d'y répondre une fois de travers pour que le tracé parte à côté du dessin. */
  floorOriginOf(m: MultiLayout, eq: any): { x: number; y: number; baseZ: number } {
    return this.floor.equipFloorOrigin(m, eq);
  }

  /** Port d'un équipement posé sur un ÉTAGE, résolu en MONDE (origine du posé + composition du résolveur). */
  portOnFloorWorld(m: MultiLayout, portId: string | null): Port3D | null {
    const p = portId ? this.store.get("ports", portId) : null; if (!p) return null;
    const eq = this.store.get("equipments", p.equipment_id); if (!eq) return null;
    const o = this.floorOriginOf(m, eq);
    return this.resolver.resolvePortWorld3D(String(portId), o.x, o.y, o.baseZ);
  }

  /** Port d'un équipement posé sur un ÉTAGE, résolu en coordonnées PLAN de son étage (vue 2D).

      ⚠ ON RÉUTILISE LE RÉSOLVEUR MONDE, ET C'EST JUSTE : la transformée « plan d'étage → monde » n'est
      qu'une TRANSLATION (origine du bâtiment + ancrage du plan + Z du niveau — aucun conteneur au-dessus
      de la salle ne porte d'orientation, cf. `Resolver3D.resolvePortWorld3D`). Lui donner l'origine PLAN
      du posé au lieu de son origine MONDE lui fait donc rendre du PLAN, exactement. Écrire une seconde
      géométrie de port « pour la 2D » dupliquerait la composition lacet + faces (§3 règle 1). */
  portOnFloorPlan(portId: string | null, cfg: FloorCfg): Port3D | null {
    const p = portId ? this.store.get("ports", portId) : null; if (!p) return null;
    const eq = this.store.get("equipments", p.equipment_id); if (!eq) return null;
    const pos = FloorLayout.floorEquipPos(eq, cfg);
    return this.resolver.resolvePortWorld3D(String(portId), pos.x, pos.y, 0);
  }

  /** Extrémité d'une liaison en coordonnées PLAN d'étage — PENDANT 2D de `worldEndIn`, même découpage :
      la portée d'abord (la salle est-elle sur CET étage ? l'étage est-il CELUI qu'on dessine ?), puis la
      résolution déléguée à l'appelant, qui seul sait ce qu'il résout. */
  planEndIn(dcsOnFloor: Map<string, any>, etage: PlacementContainer, container: PlacementContainer | null,
            planOf: (dc: any, p: Vec3) => Vec3, enSalle: (dcId: string) => Port3D | null, surEtage: () => Port3D | null): Vec3 | null {
    if (!container) return null;
    if (container.kind === "room") {
      const dc = dcsOnFloor.get(container.id); if (!dc) return null;
      const p = enSalle(container.id); return p ? planOf(dc, { x: p.x, y: p.y, z: 0 }) : null;
    }
    if (container.kind === "floor") {
      if (!PlacementContainers.same(container, etage)) return null;   // bout sur un AUTRE étage → pas ici
      const p = surEtage(); return p ? { x: p.x, y: p.y, z: 0 } : null;
    }
    return null;
  }

  /** Câbles inter-CONTENEURS : route valide avec exits, 2 bouts résolus dans des conteneurs AFFICHÉS
      (salle ou ÉTAGE). pts en MONDE.

      ⚠ C'EST ICI QU'UN CÂBLE BAIE → ÉQUIPEMENT D'ÉTAGE DEVIENT VISIBLE. La garde lisait `r.dcA`/`r.dcB`,
      que l'analyseur n'exprimait qu'en SALLES : un bout d'étage y valait `null` et le câble n'était jamais
      tracé, quand bien même sa route eût été valide. Elle lit maintenant les CONTENEURS de l'analyseur
      (doctrine §6.31) — la généralisation de la grammaire et celle du tracé se rejoignent exactement là. */
  interDcRoutes(m: MultiLayout, portNormal: boolean): Array<{ cable: any; a: WorldEnd; b: WorldEnd; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
    const roomById = new Map<string, RoomPlacement>(m.rooms.map((r) => [r.dc.id, r]));
    const out: Array<{ cable: any; a: WorldEnd; b: WorldEnd; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> = [];
    this.store.all("cables").forEach((c: any) => {
      const r = this.store.cableRoute(c);
      if (!r.valid || !r.hasExits) return;
      const a = this.worldEndIn(m, roomById, r.containerA, (dcId) => this.resolver.resolvePort3D(c.from_port_id, dcId), () => this.portOnFloorWorld(m, c.from_port_id));
      const b = this.worldEndIn(m, roomById, r.containerB, (dcId) => this.resolver.resolvePort3D(c.to_port_id, dcId), () => this.portOnFloorWorld(m, c.to_port_id));
      if (!a || !b) return;
      const sp = this.worldLine(m, roomById, a, b, r.steps, c.id, portNormal);
      out.push({ cable: c, a, b, pts: sp.pts, linePts: sp.linePts, straight: sp.straight, stubAt: sp.stubAt });
    });
    return out;
  }
}
