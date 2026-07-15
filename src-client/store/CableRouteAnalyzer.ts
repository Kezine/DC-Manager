/* =============================================================================
   GRAMMAIRE DE ROUTE DE CÂBLE — automate PUR extrait du Store (qui cumulait
   CRUD générique + orchestration + cette logique métier : cas d'école du
   principe n°2). Analyse la suite ordonnée des waypoints d'un câble
   (salle → exit → tronçon hors salle → exit → salle…), la cohérence des bouts
   posés, et les CONTRAINTES qui en découlent (placement d'équipement/baie,
   casse/dégradation de câbles au déplacement).

   PURE LECTURE : toutes les résolutions passent par l'interface hôte
   `RouteStoreView` (implémentée par le Store — couplage par interface, comme
   `Cascade.plan` ou `PositioningTool`/`PositioningHost`). Les ÉCRITURES
   (applyCableBreaks…) restent dans le Store.

   Les erreurs portent des CODES STABLES : les appelants réagissent au `code`,
   jamais au libellé (reformulable librement).
   ============================================================================= */
import { Waypoint } from "../models/Waypoint";
import { CABLE_STATUS_DRAFT, CABLE_STATUS_BROKEN, CABLE_STATUS_RANK } from "../domain/constants";

/** Codes STABLES des erreurs de route (cf. en-tête). */
export type RouteErrorCode =
  | "floor_outside"     // pin d'étage hors d'un tronçon inter-salles (entre deux exits)
  | "unplaced"          // waypoint non posé dans une salle
  | "room_wp_outside"   // waypoint de salle au milieu d'un tronçon hors-salle
  | "wrong_room"        // waypoint de salle dans une autre salle que le segment courant
  | "exit_wrong_room"   // exit qui n'est pas de la salle courante
  | "exit_reentry"      // exit ré-entrant dans la salle tout juste quittée
  | "exit_unpaired"     // exit ouvrant un tronçon jamais refermé
  | "portA_room"        // port A hors de la salle où la route commence
  | "portB_room"        // port B hors de la salle où la route finit
  | "ports_split";      // deux ports dans deux salles sans exits pour les relier
export interface RouteError { code: RouteErrorCode; message: string }
/** Sous-ensemble « EXIT TERMINAL » (cohérence de salle) : un exit ferme sa salle → tout waypoint/exit de salle
    mal placé ensuite viole la route. Sert à refuser l'ajout d'un waypoint au fil de l'eau (UI routage + formulaire). */
export const ROUTE_ROOM_BREAK_CODES: ReadonlySet<RouteErrorCode> = new Set<RouteErrorCode>(["room_wp_outside", "wrong_room", "exit_wrong_room", "exit_reentry"]);
/** Erreurs STRUCTURELLES (grammaire des tronçons) = ruptures de salle + pin d'étage hors tronçon + exit non
    appairé. Elles interdisent l'enregistrement MÊME en brouillon (route mal formée), contrairement aux erreurs
    d'INCOMPLÉTUDE (ports/bouts pas encore posés) qui restent tolérées en brouillon. Sur-ensemble des « room break ». */
export const ROUTE_STRUCTURAL_CODES: ReadonlySet<RouteErrorCode> = new Set<RouteErrorCode>([...ROUTE_ROOM_BREAK_CODES, "floor_outside", "exit_unpaired"]);

/** Analyse complète d'une route (cf. cableRoute). */
export interface RouteAnalysis { steps: any[]; errors: RouteError[]; valid: boolean; hasExits: boolean; startDc: string | null; endDc: string | null; dcA: string | null; dcB: string | null }

/** Capacités de LECTURE dont l'analyseur a besoin — sous-ensemble du Store, injecté (testable en isolation). */
export interface RouteStoreView {
  get(collection: string, id: string | null | undefined): any;
  waypointIsPlaced(wp: any): boolean;
  equipmentDcId(eqOrId: any): string | null;
  effectiveWaypointIds(cable: any): string[];
  portsOf(eqId: string): any[];
  cableOnPort(portId: string, exceptCableId?: string | null): any;
  cablesOfEquipment(eqId: string): any[];
  equipmentsOfRack(rackId: string): any[];
  cableIsComplete(cable: any): boolean;
}

export class CableRouteAnalyzer {
  constructor(private readonly s: RouteStoreView) {}

  /** Nom d'une salle (datacenter) — "?" si absente, "(salle)" si sans nom. */
  dcName(dcId: string | null): string { const d = dcId ? this.s.get("datacenters", dcId) : null; return d ? (d.name || "(salle)") : "?"; }

  /** Salle du bout A|B d'un câble (null = port absent OU équipement non placé). */
  cableEndDcId(cable: any, side: "A" | "B"): string | null {
    const pid = side === "A" ? cable.from_port_id : cable.to_port_id;
    const p = pid ? this.s.get("ports", pid) : null;
    return p ? this.s.equipmentDcId(p.equipment_id) : null;
  }

  /** Analyse de la route (waypoint_ids EFFECTIFS, ordonnés A→B) : grammaire + cohérence des bouts posés.
      → { steps[{wp,type,seg}], errors[], valid, hasExits, startDc, endDc, dcA, dcB }. Pure lecture. */
  cableRoute(cable: any): RouteAnalysis {
    const wps = this.s.effectiveWaypointIds(cable).map((id) => this.s.get("waypoints", id)).filter((w): w is NonNullable<typeof w> => w != null);
    const errors: RouteError[] = [], steps: any[] = [];
    const err = (code: RouteErrorCode, message: string) => { errors.push({ code, message }); };
    let cur: string | null = null, outside = false, exitFrom: string | null = null, startDc: string | null = null, exits = 0, seg = -1;
    wps.forEach((wp) => {
      const nm = wp.name || "(waypoint)";
      if (Waypoint.isFloorLevel(wp)) {   // pin d'ÉTAGE (ex-OOB) : doit être ENTRE deux exits
        if (!outside) err("floor_outside", "« " + nm + " » (pin d'étage) doit être ENTRE deux exits");
        steps.push({ wp, type: "floor", seg: outside ? seg : -1 });
        return;
      }
      const t = Waypoint.typeOf(wp);
      if (!this.s.waypointIsPlaced(wp)) { err("unplaced", "« " + nm + " » n'est pas posé dans une salle"); steps.push({ wp, type: t, seg: -1 }); return; }
      const room = wp.datacenter_id;
      if (t === "datacenter") {
        if (outside) err("room_wp_outside", "« " + nm + " » (waypoint de salle) au milieu d'un tronçon hors salle");
        else if (cur == null) { cur = room; if (startDc == null) startDc = room; }
        else if (room !== cur) err("wrong_room", "« " + nm + " » est dans une autre salle que le segment courant");
      } else {   // exit
        exits++;
        if (!outside) {   // SORTIE de la salle courante
          if (cur == null) { cur = room; if (startDc == null) startDc = room; }
          if (room !== cur) err("exit_wrong_room", "exit « " + nm + " » : la sortie doit être un exit de la salle courante");
          outside = true; exitFrom = cur; cur = null; seg++;
        } else {          // ENTRÉE dans une autre salle
          if (room === exitFrom) err("exit_reentry", "exit « " + nm + " » : ré-entrée dans la salle quittée — appariez avec un exit d'une AUTRE salle");
          cur = room; outside = false; exitFrom = null;
        }
      }
      steps.push({ wp, type: t, seg: -1 });
    });
    if (outside) err("exit_unpaired", "exit non appairé — ajoutez l'exit d'une autre salle pour fermer le tronçon");
    const endDc = outside ? null : cur;
    const dcA = this.cableEndDcId(cable, "A"), dcB = this.cableEndDcId(cable, "B");
    if (dcA && startDc && dcA !== startDc) err("portA_room", "le port A n'est pas dans la salle où la route commence");
    if (dcB && endDc && dcB !== endDc) err("portB_room", "le port B n'est pas dans la salle où la route finit");
    if (!exits && dcA && dcB && dcA !== dcB) err("ports_split", "ports dans deux salles différentes — la route doit sortir par un exit de chaque salle");
    return { steps, errors, valid: !errors.length, hasExits: exits > 0, startDc, endDc, dcA, dcB };
  }

  /** La route contient-elle une violation de COHÉRENCE DE SALLE (« exit terminal ») ? Testé sur les CODES stables. */
  routeHasRoomBreak(cable: any): boolean {
    return this.cableRoute(cable).errors.some((e) => ROUTE_ROOM_BREAK_CODES.has(e.code));
  }

  /** Première erreur STRUCTURELLE de route (cf. ROUTE_STRUCTURAL_CODES), ou null. Interdit l'enregistrement
      même en brouillon ; on renvoie l'erreur COMPLÈTE pour pouvoir afficher son `message`. */
  routeStructuralError(cable: any): RouteError | null {
    return this.cableRoute(cable).errors.find((e) => ROUTE_STRUCTURAL_CODES.has(e.code)) || null;
  }

  /** Contrainte de salle d'un BOUT ("A"|"B"), évaluée SANS son port : { dcId, onlyUnplaced, route }. */
  cableSideConstraint(cable: any, side: "A" | "B"): { dcId: string | null; onlyUnplaced: boolean; route: RouteAnalysis } {
    const probe = {
      from_port_id: side === "A" ? null : cable.from_port_id,
      to_port_id: side === "B" ? null : cable.to_port_id,
      waypoint_ids: cable.waypoint_ids || [],
    };
    const r = this.cableRoute(probe);
    if (!r.valid) return { dcId: null, onlyUnplaced: true, route: r };
    const own = side === "A" ? r.startDc : r.endDc;
    if (own) return { dcId: own, onlyUnplaced: false, route: r };
    if (!r.hasExits) {
      const other = side === "A" ? r.dcB : r.dcA;
      if (other) return { dcId: other, onlyUnplaced: false, route: r };
    }
    return { dcId: null, onlyUnplaced: false, route: r };
  }

  /** Résumé lisible de la route : « ◆ Salle A → ⏏ Salle A → ◎ ét. 1 → ⏏ Salle B ». */
  cableRouteSummary(r: RouteAnalysis): string {
    if (!r.steps.length) return "";
    const parts: string[] = [];
    let lastRoom: string | null = null;
    r.steps.forEach((s: any) => {
      if (s.type === "floor") { parts.push("◎ " + Waypoint.floorLabel(s.wp)); return; }
      const room = s.wp.datacenter_id;
      if (s.type === "exit") { parts.push("⏏ " + this.dcName(room)); lastRoom = room; }
      else if (room !== lastRoom) { parts.push("◆ " + this.dcName(room)); lastRoom = room; }
    });
    return parts.join(" → ");
  }

  /** Statut MAXIMAL d'un câble : brouillon (incomplet/route invalide) → planifié → câblé (2 bouts posés). */
  cableMaxStatus(cable: any): string {
    if (!this.s.cableIsComplete(cable)) return CABLE_STATUS_DRAFT;
    const r = this.cableRoute(cable);
    if (!r.valid) return CABLE_STATUS_DRAFT;
    return (r.dcA && r.dcB) ? "cable" : "planifie";
  }
  /** Le statut `statusId` est-il ≤ au maximum `maxId` ? */
  cableStatusFits(statusId: string, maxId: string): boolean {
    return (CABLE_STATUS_RANK[statusId] != null ? CABLE_STATUS_RANK[statusId] : 2) <= (CABLE_STATUS_RANK[maxId] || 0);
  }

  /* ---- contrainte physique de placement (câblage) ---- */

  /** Salles (datacenter_id) où un câble POSÉ contraint l'équipement à être : Map<dcId, cables[]>.
      Une route en chantier (onlyUnplaced) ou sans contrainte n'impose rien. */
  equipmentRequiredDcs(eqId: string): Map<string, any[]> {
    const req = new Map<string, any[]>(), seen = new Set<string>();
    this.s.portsOf(eqId).forEach((p) => {
      const c = this.s.cableOnPort(p.id);
      if (!c || seen.has(c.id)) return; seen.add(c.id);
      const side = c.from_port_id === p.id ? "A" : "B";
      const k = this.cableSideConstraint(c, side as "A" | "B");
      if (k.onlyUnplaced || !k.dcId) return;
      if (!req.has(k.dcId)) req.set(k.dcId, []);
      req.get(k.dcId)!.push(c);
    });
    return req;
  }
  /** Motif de blocage du placement dans la salle cible (null = autorisé) : la cible doit
      satisfaire TOUTES les contraintes de câblage de l'équipement. */
  equipmentPlacementBlockedReason(eqId: string, targetDcId: string): string | null {
    const req = this.equipmentRequiredDcs(eqId);
    if (!req.size) return null;
    if (req.size === 1 && req.has(targetDcId)) return null;
    const names = [...req.keys()].map((id) => this.dcName(id)).join(", ");
    if (req.size > 1) return "câblé vers plusieurs salles à la fois (" + names + ") — re-routez ou détachez un câble";
    return "câblé vers « " + names + " » — re-routez le câble (exits) ou détachez-le";
  }
  /** Idem pour un RACK entier (vérifie chaque équipement monté en U). null = autorisé. */
  rackPlacementBlockedReason(rackId: string, targetDcId: string): string | null {
    const eqs = this.s.equipmentsOfRack(rackId).filter((e: any) => e.placement_mode === "rack" && e.rack_u != null);
    for (const e of eqs) {
      const why = this.equipmentPlacementBlockedReason(e.id, targetDcId);
      if (why) return "« " + (e.name || "(équipement)") + " » : " + why;
    }
    return null;
  }
  /** Contexte physique d'un équipement : id de salle, « floor:loc:étage » (posé hors salle), ou null. */
  equipmentContext(eq: any): string | null {
    if (!eq) return null;
    if (eq.placement_mode === "floor") return "floor:" + (eq.location || "") + ":" + String(eq.floor || "");
    return this.s.equipmentDcId(eq) || null;
  }
  /** Un câble est-il valide compte tenu des contextes physiques de ses deux bouts ?
      (deux contextes différents dont au moins une SALLE → route avec exits requise). */
  cableContextValid(c: any): boolean {
    const pf = c.from_port_id ? this.s.get("ports", c.from_port_id) : null, pt = c.to_port_id ? this.s.get("ports", c.to_port_id) : null;
    if (!pf || !pt) return true;
    const ca = this.equipmentContext(this.s.get("equipments", pf.equipment_id)), cb = this.equipmentContext(this.s.get("equipments", pt.equipment_id));
    if (ca == null || cb == null) return true;
    if (ca === cb) return true;
    const aSalle = !ca.startsWith("floor:"), bSalle = !cb.startsWith("floor:");
    if (aSalle || bSalle) { const r = this.cableRoute(c); return r.valid && r.hasExits; }
    return true;
  }
  /** Patchs de CASSE des câbles d'un équipement dont la route n'est plus valide après (dé)placement :
      déconnecte le bout DISTANT seulement, statut « cassé », raison ajoutée à la description. */
  cableBreakOps(eqId: string): Array<{ collection: string; id: string; patch: Record<string, any> }> {
    const eq = this.s.get("equipments", eqId); if (!eq) return [];
    const ops: Array<{ collection: string; id: string; patch: Record<string, any> }> = [];
    this.s.cablesOfEquipment(eqId).forEach((c: any) => {
      if (c.status === CABLE_STATUS_BROKEN || c.status === CABLE_STATUS_DRAFT) return;
      if (this.cableContextValid(c)) return;
      const pf = c.from_port_id ? this.s.get("ports", c.from_port_id) : null;
      const fromIsEq = !!(pf && pf.equipment_id === eqId);
      const remotePortId = fromIsEq ? c.to_port_id : c.from_port_id;
      const remotePort = remotePortId ? this.s.get("ports", remotePortId) : null;
      const remoteEq = remotePort ? this.s.get("equipments", remotePort.equipment_id) : null;
      const reason = "Suite au déplacement de l'équipement « " + (eq.name || "?") + " », la liaison vers « "
        + (remoteEq ? (remoteEq.name || "?") : "?") + " » sur le port « " + (remotePort ? (remotePort.name || "?") : "?") + " » n'est plus valide.";
      const patch: Record<string, any> = { status: CABLE_STATUS_BROKEN, description: (c.description ? c.description.trim() + "\n" : "") + reason };
      if (fromIsEq) patch.to_port_id = null; else patch.from_port_id = null;
      ops.push({ collection: "cables", id: c.id, patch });
    });
    return ops;
  }
  /** Patchs de DÉGRADATION (« Câblé / À remplacer » → « Planifié ») des câbles des équipements donnés —
      quand ils QUITTENT leur salle. À fusionner avec le patch de retrait pour un seul undo. */
  cableDowngradeOps(eqIds: string[]): Array<{ collection: string; id: string; patch: Record<string, any> }> {
    const ops: Array<{ collection: string; id: string; patch: Record<string, any> }> = [], seen = new Set<string>();
    eqIds.forEach((eqId) => this.s.portsOf(eqId).forEach((p: any) => {
      const c = this.s.cableOnPort(p.id);
      if (!c || seen.has(c.id)) return; seen.add(c.id);
      if (c.status === "cable" || c.status === "a-remplacer") ops.push({ collection: "cables", id: c.id, patch: { status: "planifie" } });
    }));
    return ops;
  }
}
