/* =============================================================================
   ANALYSE ÉNERGIE (power) — moteur PUR, piloté par un store INJECTÉ (aucun DOM,
   aucun Node). Vit dans src-shared/ pour être consommable des DEUX côtés : le
   client (fiches / formulaires) ET un FUTUR producteur d'alertes power côté serveur
   (module notify) — d'où deux DÉCOUPLAGES volontaires vs la version cliente d'origine :
     - STORE par INTERFACE (`PowerAnalysisStore`) au lieu du `Store` concret : le moteur
       ne consomme que 4 accès en LECTURE ; le `Store` client la satisfait
       STRUCTURELLEMENT (aucune adaptation), un adaptateur serveur la réimplémentera.
     - MESSAGES = CODES + PARAMS (`PowerWarning`) au lieu de chaînes traduites : un
       module partagé ne connaît PAS l'i18n (elle vit côté client) → le moteur n'émet
       qu'un code + les valeurs à interpoler ; la RÉSOLUTION du libellé se fait chez le
       consommateur (client : `registries/PowerWarnings`).

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

/** Seuil de charge (fraction du calibre) au-delà duquel on alerte (règle de l'art : 80 % en continu). Rapatrié ici
    depuis `domain/constants` : c'est une donnée du MOTEUR énergie, désormais partagée front/back avec lui. */
export const POWER_LOAD_WARN_FRACTION = 0.8;

/** Contrat MINIMAL que le moteur consomme du store (INJECTION : aucune dépendance à une implémentation concrète).
    Le `Store` client le satisfait STRUCTURELLEMENT (mêmes signatures, aucune adaptation) ; un futur producteur
    serveur en fournira sa propre implémentation (lecture des collections chargées). Lectures = enregistrements bruts. */
export interface PowerAnalysisStore {
  /** Enregistrement d'une collection (`equipments` | `ports` | `networks` …) par id, ou null s'il n'existe pas. */
  get(collection: string, id: string): any;
  /** Ports portés par un équipement. */
  portsOf(equipmentId: string): any[];
  /** Câbles touchant un port (indifféremment côté from/to). */
  cablesOfPort(portId: string): any[];
  /** Ports ASSERTANT explicitement un réseau (via leur `network_ids`) — PAS les ports qui en héritent par déduction. */
  portsOfNetwork(networkId: string): any[];
}

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

/** Code d'un avertissement énergie : chaîne STABLE identifiant la nature du constat. Le LIBELLÉ traduit n'est PAS
    produit ici (moteur partagé sans i18n) mais résolu chez le consommateur à partir du code + des params. */
export type PowerWarningCode = "spof" | "psu_uncabled" | "psu_undersized" | "no_source" | "origin_unknown" | "poe_over_budget" | "poe_port_over" | "poe_pd_unfed" | "pdu_over_capacity" | "network_over_amp";

/** Avertissement de fiabilité / capacité électrique sur un équipement. `code` = nature du constat ; `params` = valeurs
    à INTERPOLER dans le message (clés = noms EXACTS des placeholders i18n `analysis.power.*`). PAS de chaîne traduite
    ici : le moteur est partagé (src-shared/) et sans i18n ; le client résout le libellé via `registries/PowerWarnings`.
    Les codes `pdu_over_capacity` (charge aval d'un tableau/PDU > sa capacité déclarée `pdu_max_a`) et `network_over_amp`
    (charge d'un réseau power > `max_amp`) concernent la DISTRIBUTION (départs), pas la consommation. */
export interface PowerWarning { code: PowerWarningCode; params: Record<string, string | number>; }

const DEFAULT_VOLTAGE = 230;

export class PowerAnalysis {
  constructor(private store: PowerAnalysisStore) {}
  // Mémoïsation PAR INSTANCE (une instance = un rendu ; le store ne mute pas pendant un rendu). Évite de refaire
  // la remontée/charge pour chaque feuille et pour departLoads↔phaseLoads↔equipmentWarnings sur les mêmes ports.
  private _rootCache = new Map<string, string[]>();
  private _loadCache = new Map<string, number>();
  private _fedSinkCache = new Map<string, boolean>();   // isFedSink par PORT (réévalué sinon à chaque nœud intermédiaire)
  private _fedSinksCache = new Map<string, any[]>();     // fedSinksOf par ÉQUIPEMENT (remontée, charge ET warnings s'en servent)

  private port(id: string | null): any { return id ? this.store.get("ports", id) : null; }
  private eqPortsByDir(equipmentId: string | null, direction: string): any[] {
    // EXCLUT les ports POE : ils portent une direction (source=PSE / sink=PD) mais vivent sur le réseau ENERGIE
    // POE, pas sur le graphe SECTEUR (source→sink des câbles power). Sans ça, un port PSE apparaîtrait comme un
    // « départ » et un PD comme une charge secteur (double comptage — le PoE est comptabilisé à part, cf. poeSuppliedW).
    return equipmentId ? this.store.portsOf(equipmentId).filter((p: any) => p.direction === direction && p.role !== "poe") : [];
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
    const base = useMax ? Math.max(max, nominal) : nominal;
    // POE : la puissance RÉELLEMENT tirée d'un équipement PSE = Σ des consos des PD câblés à ses ports producteurs
    // (le budget de port n'est qu'une CAPACITÉ, pas une conso). Elle est prélevée sur ses entrées d'alimentation →
    // S'AJOUTE à sa conso. Le PD, alimenté par le câble, est couvert par cette contribution côté PSE (pas de double
    // comptage : les ports POE sont hors du graphe secteur — cf. eqPortsByDir). Un lien PoE désactivé (poe_enabled
    // coupé d'un côté ou de l'autre) ne tire rien — filtré une seule fois dans pdOfPsePort (parité avec l'éclair).
    return base + this.poeSuppliedW(eq.id, useMax);
  }
  /** L'équipement PD (alimenté) au bout d'un port PSE (poe+source) : l'autre extrémité du câble SI c'est un port
      POE consommateur (poe+sink) ACTIF. null si le port n'est pas PSE, si son injection est coupée
      (`poe_enabled === false`), s'il n'est pas câblé, ou si son vis-à-vis n'est pas un PD ACTIF.
      PARITÉ avec l'éclair de scène (`Store.cableCarriesPower`) : un lien PoE ne transporte de l'énergie que si les
      DEUX extrémités sont activées (`poe_enabled`). Coupé d'un côté OU de l'autre, le PD ne compte donc NI dans la
      charge du PSE (poePortLoadW / poeSuppliedW / poeSupply) NI dans sa conso secteur (demandW) — cohérent avec le
      câble qui perd son éclair. NB : `psePort` peut être un BROUILLON de formulaire → on ne lit QUE ses champs. */
  private pdOfPsePort(psePort: any): any | null {
    if (!psePort || psePort.role !== "poe" || psePort.direction !== "source" || psePort.poe_enabled === false) return null;
    for (const other of this.otherEnds(psePort.id)) {
      if (other.role === "poe" && other.direction === "sink" && other.poe_enabled !== false) return this.store.get("equipments", other.equipment_id);
    }
    return null;
  }
  /** L'équipement PSE (injecteur) qui ALIMENTE un port PD (poe+sink) : le vis-à-vis de câble SI c'est un port POE
      producteur (poe+source) ACTIF. null si le port n'est pas un PD ACTIF (`poe_enabled === false` = désactivation
      volontaire du port), s'il n'est câblé à rien, ou si aucun vis-à-vis n'est un PSE ACTIF (injecteur coupé).
      MIROIR EXACT de `pdOfPsePort` : même définition d'un lien PoE actif (les DEUX extrémités `poe_enabled`), en
      PARITÉ avec l'éclair de scène (`Store.cableCarriesPower`). Un PD à qui aucun injecteur actif ne fait face n'est
      pas réellement alimenté → warning `poe_pd_unfed`. Réutilise `otherEnds` (pas de duplication du parcours câbles). */
  private pseOfPdPort(pdPort: any): any | null {
    if (!pdPort || pdPort.role !== "poe" || pdPort.direction !== "sink" || pdPort.poe_enabled === false) return null;
    for (const other of this.otherEnds(pdPort.id)) {
      if (other.role === "poe" && other.direction === "source" && other.poe_enabled !== false) return this.store.get("equipments", other.equipment_id);
    }
    return null;
  }
  /** Charge POE tirée sur un port PSE = consommation du PD câblé (0 si aucun PD, ou si le lien PoE est désactivé d'un
      côté ou de l'autre — cf. pdOfPsePort, parité avec l'éclair de cableCarriesPower). `useMax` : conso MAX
      (dimensionnement) sinon nominale. Publique : réutilisée par le formulaire (jauge live + survente par port). */
  poePortLoadW(psePort: any, useMax: boolean): number {
    const pd = this.pdOfPsePort(psePort); if (!pd) return 0;
    const nominal = pd.power_nominal_w != null ? pd.power_nominal_w : 0;
    const max = pd.power_max_w != null ? pd.power_max_w : nominal;
    return useMax ? Math.max(max, nominal) : nominal;
  }
  /** Puissance POE réellement TIRÉE d'un équipement PSE = Σ des consos des PD câblés à ses ports producteurs ACTIFS
      (les liens PoE désactivés donnent 0 via poePortLoadW/pdOfPsePort — parité avec l'éclair). */
  private poeSuppliedW(equipmentId: string | null, useMax: boolean): number {
    if (!equipmentId) return 0;
    return this.store.portsOf(equipmentId)
      .filter((p: any) => p.role === "poe" && p.direction === "source")
      .reduce((sum: number, p: any) => sum + this.poePortLoadW(p, useMax), 0);
  }
  /** Bilan POE d'un équipement (jauge + survente) : CHARGE réelle (Σ consos MAX des PD câblés par des liens ACTIFS)
      vs budget TOTAL déclaré. `over` = survente (charge > budget). budget null = non renseigné. Un lien PoE désactivé
      d'un côté ou de l'autre ne compte pas (parité avec l'éclair — cf. pdOfPsePort). */
  poeSupply(equipmentId: string): { loadW: number; budgetW: number | null; over: boolean } {
    const eq = this.store.get("equipments", equipmentId);
    const loadW = this.poeSuppliedW(equipmentId, true);
    const budgetW = eq && eq.poe_budget_w != null ? eq.poe_budget_w : null;
    return { loadW, budgetW, over: budgetW != null && loadW > budgetW };
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

  /** Avertissements électriques d'un équipement : côté DISTRIBUTION (POE, capacité `pdu_max_a`, capacité `max_amp`
      des réseaux power assertés) ET côté CONSOMMATEUR (redondance, PSU non câblée, alims non diverses, sous-calibrage). */
  equipmentWarnings(equipmentId: string): PowerWarning[] {
    const out: PowerWarning[] = [];
    const eq = this.store.get("equipments", equipmentId); if (!eq) return out;
    // POE : SURVENTE du budget (charge des PD > budget total) + dépassement PAR PORT (un PD tire plus que la capacité
    // du port). Testé AVANT la garde « consommateur » ci-dessous — un injecteur PoE (midspan) peut n'avoir aucune
    // prise power modélisée et doit tout de même alerter.
    if (eq.poe_device) {
      const poe = this.poeSupply(equipmentId);
      // `over` implique déjà `budgetW != null` (cf. poeSupply) — la garde `!= null` ne change RIEN au comportement,
      // elle ne fait que rétrécir le type pour le contrat codes+params (params interdit null).
      if (poe.over && poe.budgetW != null) out.push({ code: "poe_over_budget", params: { load: poe.loadW, budget: poe.budgetW } });
      for (const sp of this.store.portsOf(equipmentId).filter((p: any) => p.role === "poe" && p.direction === "source")) {
        if (sp.poe_budget_w == null) continue;
        const load = this.poePortLoadW(sp, true);   // conso MAX du PD câblé
        if (load > sp.poe_budget_w) out.push({ code: "poe_port_over", params: { port: sp.name || "?", load, budget: sp.poe_budget_w } });
      }
      // PD NON ALIMENTÉ : un appareil alimenté UNIQUEMENT en PoE (caméra, borne…) est muet côté SECTEUR (ses seuls
      // ports vivent sur le réseau POE, exclus du graphe source→sink → no_source/psu_uncabled ne le voient pas). On
      // vérifie donc ici, dans le bloc POE, que chaque port PD ACTIF (poe+sink, `poe_enabled ≠ false` — un port coupé
      // est un choix volontaire, pas une alerte) a bien un injecteur PSE ACTIF câblé en vis-à-vis (`pseOfPdPort`,
      // miroir de `pdOfPsePort` — parité avec l'éclair de `cableCarriesPower`). Sinon : câble absent ou injecteur
      // éteint → le PD n'est pas réellement alimenté.
      for (const pd of this.store.portsOf(equipmentId).filter((p: any) => p.role === "poe" && p.direction === "sink" && p.poe_enabled !== false)) {
        if (!this.pseOfPdPort(pd)) out.push({ code: "poe_pd_unfed", params: { port: pd.name || "?" } });
      }
    }
    // CAPACITÉ DE DISTRIBUTION : un pdu/tableau porte une capacité d'alimentation (`pdu_max_a`) et ses départs
    // assertent un/des réseau(x) power à capacité (`max_amp`). On confronte ces plafonds à la charge MAX en aval
    // (`useMax` — cohérent avec `psu_undersized` qui dimensionne au pire cas). Testé AVANT la garde « consommateur »
    // ci-dessous, comme le bloc POE : un tableau n'a AUCUNE prise sink → cette garde court-circuiterait ces contrôles.
    const departs = this.eqPortsByDir(equipmentId, "source");
    // pdu_over_capacity : Σ des charges MAX des départs de l'équipement vs sa capacité d'alimentation déclarée.
    if (eq.pdu_max_a != null && eq.pdu_max_a > 0) {
      const totalA = departs.reduce((sum: number, sp: any) => sum + this.sourceLoadA(sp.id, true), 0);
      if (totalA > eq.pdu_max_a) out.push({ code: "pdu_over_capacity", params: { load: Math.ceil(totalA), cap: eq.pdu_max_a } });
    }
    // network_over_amp : pour chaque réseau POWER à capacité asserté par un départ de CET équipement, on somme les
    // charges MAX de TOUS les départs (source, hors poe) du document assertant ce réseau, puis on compare à `max_amp`.
    // HYPOTHÈSE (cf. docs/power.md) : l'assertion power ne vit que sur les départs RACINES (la tension/phase sont
    // déduites en aval, pas re-assertées) → sommer les ports assertants ne double-compte pas en usage normal. On
    // dédoublonne par réseau (plusieurs départs du même équipement peuvent assurer le même réseau → un seul warning).
    const seenPowerNets = new Set<string>();
    for (const sp of departs) {
      for (const nid of (sp.network_ids || [])) {
        if (seenPowerNets.has(nid)) continue;
        const net: any = this.store.get("networks", nid);
        if (!net || net.kind !== "power" || net.max_amp == null || net.max_amp <= 0) continue;
        seenPowerNets.add(nid);
        const netA = this.store.portsOfNetwork(nid)
          .filter((p: any) => p.direction === "source" && p.role !== "poe")
          .reduce((sum: number, p: any) => sum + this.sourceLoadA(p.id, true), 0);
        if (netA > net.max_amp) out.push({ code: "network_over_amp", params: { name: net.label || "?", load: Math.ceil(netA), cap: net.max_amp } });
      }
    }
    const sinks = this.eqPortsByDir(equipmentId, "sink");
    if (!sinks.length) return out;   // pas un consommateur alimenté par des PSU
    const wired = sinks.filter((s: any) => this.store.cablesOfPort(s.id).length > 0);   // a un câble (peu importe l'autre bout)
    const fed = this.fedSinksOf(equipmentId);                                            // câblé VERS une source (réellement alimenté) — mémoïsé, plus de re-filtre inline
    // PSU non câblée : redondance amoindrie (compte les prises SANS aucun câble).
    if (sinks.length >= 2 && wired.length < sinks.length) out.push({ code: "psu_uncabled", params: { n: sinks.length - wired.length } });
    if (!fed.length) { out.push({ code: "no_source", params: {} }); return out; }
    // Diversité des feeds : ≥ 2 feeds RÉELS mais toutes vers la MÊME racine = point unique de défaillance. 0 racine
    // traçable ⇒ on NE prétend PAS « même origine » (les sens/racines amont manquent) → message distinct.
    if (fed.length >= 2) {
      const roots = new Set<string>();
      for (const s of fed) this.rootSourcesOf(s.id).forEach((r) => roots.add(r));
      if (roots.size === 1) out.push({ code: "spof", params: {} });
      else if (roots.size === 0) out.push({ code: "origin_unknown", params: {} });
    }
    // Rating PSU vs charge max : chaque PSU doit tenir la charge MAX seule (redondance réelle).
    const maxW = this.demandW(eq, true);
    if (maxW > 0) for (const s of fed) {
      const v = this.deducedVoltageOf(s.id) || DEFAULT_VOLTAGE;
      if (s.power_max_a != null && s.power_max_a > 0 && s.power_max_a * v < maxW) {
        out.push({ code: "psu_undersized", params: { name: s.name || "?", amps: s.power_max_a, req: Math.ceil(maxW / v) } });
      }
    }
    return out;
  }

  /** Sévérité d'AFFICHAGE d'un warning : `origin_unknown` est INFORMATIF (redondance non VÉRIFIABLE faute de sens /
      tableau amont renseignés) — pas une faute avérée comme les autres → l'UI l'affiche en sévérité moindre (info). */
  static isInfo(code: PowerWarningCode): boolean { return code === "origin_unknown"; }
}
