import { POWER_LOAD_WARN_FRACTION } from "../domain/constants";

/* =============================================================================
   ANALYSE ÉNERGIE (power) — PURE, pilotée par le store injecté (aucun DOM).
   Le réseau électrique est un GRAPHE ORIENTÉ (source → sink) à 2 types d'arêtes :
     - CÂBLE  : un câble power relie une prise SOURCE ↔ une prise SINK ;
     - INTERNE : dans un équipement de distribution (PDU/tableau), les INLETS (sink)
                 alimentent les OUTLETS (source) — le « pass-through ».
   Le sens vient du champ Port.direction ("source"/"sink"), pas de from/to du câble.

   Architecture : docs/power.md. Décisions :
     - CAPACITÉS en AMPÈRES (disjoncteur) ; CONSOMMATION en WATTS (PSU à puissance
       constante) → courant = W / tension du circuit (déduite de la source racine).
     - La SOURCE INITIALE (racine = départ de tableau) se déduit en REMONTANT jusqu'à
       une source sans inlet alimenté. Elle porte l'origine (réseau power → tension) et
       la PHASE, déduites en AVAL.
     - Charge d'un départ = somme des courants des CONSOMMATEURS feuilles en aval
       (les PDU passent au travers). Répartition de la demande d'un consommateur sur
       ses feeds câblés (partage de charge).
   ============================================================================= */

/** Résultat de charge d'un départ / d'une phase : courant utilisé vs calibre. */
export interface PowerLoad {
  /** Départ ou phase concerné (id de port source, ou "L1"/"L2"/"L3"). */
  key: string;
  /** Courant sommé en aval (A). */
  usedA: number;
  /** Calibre / plafond (A). null = non renseigné. */
  capacityA: number | null;
  /** ≥ 80 % du calibre (règle de l'art). */
  warn: boolean;
  /** > 100 % du calibre. */
  overloaded: boolean;
}

/** Avertissement de fiabilité électrique sur un équipement. */
export interface PowerWarning { code: "spof" | "psu_uncabled" | "psu_undersized" | "no_source" | "origin_unknown"; message: string; }

const DEFAULT_VOLTAGE = 230;

export class PowerAnalysis {
  constructor(private store: any) {}
  // Mémoïsation PAR INSTANCE (une instance = un rendu ; le store ne mute pas pendant un rendu). Évite de refaire
  // la remontée/charge pour chaque feuille et pour departLoads↔phaseLoads↔equipmentWarnings sur les mêmes ports.
  private _rootCache = new Map<string, string[]>();
  private _loadCache = new Map<string, number>();
  private _fedSinkCache = new Map<string, boolean>();   // isFedSink par PORT (réévalué sinon à chaque nœud intermédiaire)
  private _fedSinksCache = new Map<string, any[]>();     // fedSinksOf par ÉQUIPEMENT (remontée, charge ET warnings s'en servent)

  private port(id: string | null): any { return id ? this.store.get("ports", id) : null; }
  private eqPortsByDir(equipmentId: string | null, direction: string): any[] {
    return equipmentId ? this.store.portsOf(equipmentId).filter((p: any) => p.direction === direction) : [];
  }
  /** Autre extrémité d'un câble touchant `pid`. */
  private otherEnds(pid: string): any[] {
    return this.store.cablesOfPort(pid)
      .map((c: any) => (c.from_port_id === pid ? c.to_port_id : c.from_port_id))
      .map((id: string) => this.port(id)).filter(Boolean);
  }
  /** Un sink est-il réellement ALIMENTÉ ? — un câble ne suffit pas : l'autre bout doit être une SOURCE. Un câble
      sink↔sink (ou vers un port sans direction) ne nourrit rien et ne doit pas compter comme un feed. */
  private isFedSink(sinkPort: any): boolean {
    if (!sinkPort) return false;
    const cached = this._fedSinkCache.get(sinkPort.id); if (cached !== undefined) return cached;
    const fed = this.otherEnds(sinkPort.id).some((o: any) => o.direction === "source");
    this._fedSinkCache.set(sinkPort.id, fed);
    return fed;
  }

  /* ---- REMONTÉE : sources racines (départs) alimentant un port ---- */

  /** Sources RACINES (id de ports) alimentant `startPortId`, en remontant source→sink jusqu'à une source dont
      l'équipement n'a aucun inlet ALIMENTÉ (= départ de tableau / origine). Garde-cycle : visited-set. */
  rootSourcesOf(startPortId: string): string[] {
    const cached = this._rootCache.get(startPortId); if (cached) return cached;
    const roots = new Set<string>();
    const seen = new Set<string>();
    const visit = (pid: string): void => {
      if (seen.has(pid)) return; seen.add(pid);
      const port = this.port(pid); if (!port) return;
      if (port.direction === "sink") {
        // amont d'un sink = la/les SOURCE(s) qui l'alimentent via un câble power.
        for (const other of this.otherEnds(pid)) if (other.direction === "source") visit(other.id);
      } else if (port.direction === "source") {
        // amont d'une source = les INLETS (sink) réellement ALIMENTÉS (câblés VERS une source) de son équipement
        // (pass-through). Aucun inlet alimenté ⇒ cette source est une RACINE (départ de tableau / origine).
        const fedInlets = this.fedSinksOf(port.equipment_id);   // inlets réellement ALIMENTÉS (mémoïsé — cf. fedSinksOf)
        if (!fedInlets.length) roots.add(pid);
        else for (const s of fedInlets) visit(s.id);
      }
    };
    visit(startPortId);
    const result = [...roots];
    this._rootCache.set(startPortId, result);
    return result;
  }

  /** Phase DÉDUITE d'un port : celle de sa source racine (départ). "" si indéterminée. */
  deducedPhaseOf(portId: string): string {
    for (const rid of this.rootSourcesOf(portId)) { const r = this.port(rid); if (r && r.phase) return r.phase; }
    return "";
  }

  /** Tension DÉDUITE d'un port (V) : celle du réseau power asserté sur la source racine, sinon défaut 230 V. */
  deducedVoltageOf(portId: string): number {
    for (const rid of this.rootSourcesOf(portId)) {
      const r = this.port(rid); if (!r) continue;
      for (const nid of (r.network_ids || [])) {
        const n: any = this.store.get("networks", nid);
        if (n && n.kind === "power" && n.voltage) return n.voltage;
      }
    }
    return DEFAULT_VOLTAGE;
  }

  /* ---- DESCENTE : consommateurs feuilles alimentés par un départ ---- */

  /** Sinks CONSOMMATEURS feuilles (équipement SANS prise source = pas une distribution) alimentés en aval de
      `sourcePortId`. Traverse les PDU (inlet→outlets). Garde-cycle. */
  downstreamLeafSinks(sourcePortId: string): any[] {
    const leaves: any[] = [];
    const seen = new Set<string>();
    const visitSource = (spid: string): void => {
      if (seen.has(spid)) return; seen.add(spid);
      for (const sink of this.otherEnds(spid)) {
        if (sink.direction !== "sink" || seen.has(sink.id)) continue;
        seen.add(sink.id);
        const outs = this.eqPortsByDir(sink.equipment_id, "source");
        if (outs.length) for (const o of outs) visitSource(o.id);   // distribution (PDU) → on descend
        else leaves.push(sink);                                      // consommateur feuille
      }
    };
    visitSource(sourcePortId);
    return leaves;
  }

  /* ---- courants ---- */

  private demandW(eq: any, useMax: boolean): number {
    if (!eq) return 0;
    const nominal = eq.power_nominal_w != null ? eq.power_nominal_w : 0;
    const max = eq.power_max_w != null ? eq.power_max_w : nominal;
    return useMax ? Math.max(max, nominal) : nominal;
  }
  /** Prises sink réellement ALIMENTÉES d'un équipement (câblées VERS une source) — ses feeds actifs. */
  fedSinksOf(equipmentId: string): any[] {
    const cached = this._fedSinksCache.get(equipmentId); if (cached) return cached;
    const fed = this.eqPortsByDir(equipmentId, "sink").filter((s: any) => this.isFedSink(s));
    this._fedSinksCache.set(equipmentId, fed);
    return fed;
  }
  /** Courant tiré par un sink CONSOMMATEUR feuille (A) : demande de l'équipement / tension, partagée sur ses feeds. */
  leafSinkCurrentA(sinkPort: any, useMax: boolean): number {
    const eq = sinkPort ? this.store.get("equipments", sinkPort.equipment_id) : null;
    const w = this.demandW(eq, useMax); if (w <= 0) return 0;
    const v = this.deducedVoltageOf(sinkPort.id) || DEFAULT_VOLTAGE;
    const feeds = Math.max(1, this.fedSinksOf(sinkPort.equipment_id).length);
    return (w / v) / feeds;
  }
  /** Charge (A) d'un départ (port source) = somme des courants des consommateurs feuilles en aval. Mémoïsé
      (departLoads ET phaseLoads interrogent les mêmes départs). */
  sourceLoadA(sourcePortId: string, useMax = false): number {
    const key = sourcePortId + (useMax ? "!" : "");
    const cached = this._loadCache.get(key); if (cached !== undefined) return cached;
    const load = this.downstreamLeafSinks(sourcePortId).reduce((sum, leaf) => sum + this.leafSinkCurrentA(leaf, useMax), 0);
    this._loadCache.set(key, load);
    return load;
  }

  /* ---- stats agrégées ---- */

  private loadOf(key: string, usedA: number, capacityA: number | null): PowerLoad {
    const warn = capacityA != null && capacityA > 0 && usedA >= capacityA * POWER_LOAD_WARN_FRACTION;
    const overloaded = capacityA != null && capacityA > 0 && usedA > capacityA;
    return { key, usedA, capacityA, warn, overloaded };
  }
  /** Charge par DÉPART (prise source) d'un tableau/PDU. */
  departLoads(equipmentId: string, useMax = false): PowerLoad[] {
    return this.eqPortsByDir(equipmentId, "source")
      .map((sp: any) => this.loadOf(sp.id, this.sourceLoadA(sp.id, useMax), sp.power_max_a != null ? sp.power_max_a : null));
  }
  /** Charge par PHASE d'un tableau (départs monophasés répartis sur L1/L2/L3). Capacité = somme des calibres de la phase. */
  phaseLoads(equipmentId: string, useMax = false): PowerLoad[] {
    const byPhase = new Map<string, { used: number; cap: number }>();
    for (const sp of this.eqPortsByDir(equipmentId, "source")) {
      const ph = sp.phase || "?";
      const cur = byPhase.get(ph) || { used: 0, cap: 0 };
      cur.used += this.sourceLoadA(sp.id, useMax);
      cur.cap += (sp.power_max_a != null ? sp.power_max_a : 0);
      byPhase.set(ph, cur);
    }
    return [...byPhase.entries()].map(([ph, v]) => this.loadOf(ph, v.used, v.cap || null));
  }

  /* ---- avertissements de fiabilité ---- */

  /** Avertissements électriques d'un équipement CONSOMMATEUR (redondance, PSU non câblée, alims non diverses…). */
  equipmentWarnings(equipmentId: string): PowerWarning[] {
    const out: PowerWarning[] = [];
    const eq = this.store.get("equipments", equipmentId); if (!eq) return out;
    const sinks = this.eqPortsByDir(equipmentId, "sink");
    if (!sinks.length) return out;   // pas un consommateur alimenté par des PSU
    const wired = sinks.filter((s: any) => this.store.cablesOfPort(s.id).length > 0);   // a un câble (peu importe l'autre bout)
    const fed = this.fedSinksOf(equipmentId);                                            // câblé VERS une source (réellement alimenté) — mémoïsé, plus de re-filtre inline
    // PSU non câblée : redondance amoindrie (compte les prises SANS aucun câble).
    if (sinks.length >= 2 && wired.length < sinks.length) out.push({ code: "psu_uncabled", message: `${sinks.length - wired.length} alimentation(s) non câblée(s) — redondance amoindrie.` });
    if (!fed.length) { out.push({ code: "no_source", message: "Aucune alimentation valide (câblée vers une source) — équipement non alimenté." }); return out; }
    // Diversité des feeds : ≥ 2 feeds RÉELS mais toutes vers la MÊME racine = point unique de défaillance. 0 racine
    // traçable ⇒ on NE prétend PAS « même origine » (les sens/racines amont manquent) → message distinct.
    if (fed.length >= 2) {
      const roots = new Set<string>();
      for (const s of fed) this.rootSourcesOf(s.id).forEach((r) => roots.add(r));
      if (roots.size === 1) out.push({ code: "spof", message: "Alimentations non redondantes — même source d'origine (point unique de défaillance)." });
      else if (roots.size === 0) out.push({ code: "origin_unknown", message: "Origine des alimentations indéterminable (sens ou tableau amont non renseignés) — redondance non vérifiable." });
    }
    // Rating PSU vs charge max : chaque PSU doit tenir la charge MAX seule (redondance réelle).
    const maxW = this.demandW(eq, true);
    if (maxW > 0) for (const s of fed) {
      const v = this.deducedVoltageOf(s.id) || DEFAULT_VOLTAGE;
      if (s.power_max_a != null && s.power_max_a > 0 && s.power_max_a * v < maxW) {
        out.push({ code: "psu_undersized", message: `Alimentation « ${s.name || "?"} » (${s.power_max_a} A) insuffisante pour la charge max seule (${Math.ceil(maxW / v)} A requis).` });
      }
    }
    return out;
  }

  /** Sévérité d'AFFICHAGE d'un warning : `origin_unknown` est INFORMATIF (redondance non VÉRIFIABLE faute de sens /
      tableau amont renseignés) — pas une faute avérée comme les autres → l'UI l'affiche en sévérité moindre (info). */
  static isInfo(code: PowerWarning["code"]): boolean { return code === "origin_unknown"; }
}
