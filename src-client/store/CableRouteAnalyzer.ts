/* =============================================================================
   GRAMMAIRE DE ROUTE DE CÂBLE — automate PUR extrait du Store (qui cumulait
   CRUD générique + orchestration + cette logique métier : cas d'école du
   principe n°2). Analyse la suite ordonnée des waypoints d'un câble
   (conteneur → exit → transit → conteneur…), la cohérence des bouts posés, et
   les CONTRAINTES qui en découlent (placement d'équipement/baie, casse et
   dégradation de câbles au déplacement).

   PURE LECTURE : toutes les résolutions passent par l'interface hôte
   `RouteStoreView` (implémentée par le Store — couplage par interface, comme
   `Cascade.plan` ou `PositioningTool`/`PositioningHost`). Les ÉCRITURES
   (applyCableBreaks…) restent dans le Store.

   Les erreurs portent des CODES STABLES : les appelants réagissent au `code`,
   jamais au libellé (reformulable librement, et traduit — cf. plus bas).

   ---------------------------------------------------------------------------
   L'AUTOMATE PARLE CONTENEURS, PLUS SALLES (doctrine `docs/placement.md` §6.31,
   décisions D2/D3/D4 du chantier « câblage des équipements d'étage »).

   Il tenait un booléen `outside` : un exit le levait, un SECOND exit le
   refermait, et une route qui finissait `outside` était refusée
   (`exit_unpaired`). Or un pin d'ÉTAGE n'était accepté qu'ENTRE deux exits :
   dans ce modèle, « être sur un étage » c'était DÉJÀ être dehors. Une route qui
   ABOUTIT à un équipement posé sur un étage se terminait donc légitimement
   dehors — et se faisait refuser. C'est la cause unique du blocage « les
   équipements d'étage ne sont pas câblables » (doctrine §6.4).

   LE CHANGEMENT GRAMMATICAL tient en une phrase : la fermeture d'un tronçon
   n'est plus « un second exit », c'est ARRIVER DANS UN CONTENEUR. Un conteneur
   SALLE s'atteint par un exit ; un conteneur ÉTAGE, non — un pin d'étage NOMME
   l'étage sur lequel on se trouve, et l'on y est déjà. L'état de l'automate
   n'est donc plus un booléen dedans/dehors mais un CONTENEUR (`EtatParcours`
   ci-dessous) : « dans » tel conteneur, ou « en transit » entre deux.

   ⚠ DEUX SEULS COMPORTEMENTS CHANGENT, et ce sont exactement ceux que le lot
   vise (mesuré, pas déduit — cf. le banc de parité de `test-core-store.js`) :
     (a) un pin d'étage n'est plus refusé faute d'exit PRÉCÉDENT : il l'est
         seulement à l'INTÉRIEUR d'une salle (là où il n'a physiquement pas sa
         place) — d'où une route qui COMMENCE sur un étage ;
     (b) une route qui se termine sur un pin d'étage est VALIDE, et son
         conteneur d'arrivée est cet étage — d'où une route qui FINIT sur un
         étage. Tout le reste (`wrong_room`, `exit_wrong_room`, `exit_reentry`,
         `room_wp_outside`, `unplaced`, `ports_split`, `portA/B`) est inchangé,
         code pour code, sur toute route ne comportant aucun pin d'étage.

   ⚠ AUCUN CODE SPÉCIFIQUE À L'ÉTAGE (décision D2) : la règle « deux bouts dans
   le MÊME conteneur ⇒ aucune sortie exigée » s'applique à un étage exactement
   comme elle s'appliquait à une salle. Ce lot RETIRE un cas particulier, il
   n'en ajoute pas.

   ⚠ LES CONTENEURS SE COMPARENT PAR `PlacementContainers.same`, JAMAIS PAR
   ÉGALITÉ D'ID : l'identité d'un ÉTAGE est le COUPLE (bâtiment, étage) et un
   étage non configuré n'a aucun enregistrement, donc aucun id.

   ⚠ LE CONTENEUR D'UN BOUT SE LIT SUR LA CHAÎNE, PAS SUR LE CONTENEUR IMMÉDIAT.
   Le conteneur immédiat d'un serveur monté est sa BAIE, celui d'un boîtier posé
   son ÉTAGÈRE — or une route ne traverse ni baies ni étagères : elle va d'une
   SALLE ou d'un ÉTAGE à un autre. C'est exactement la règle
   `Store.equipmentNamedContainer` (`core/ContainerLabel`, §6.29) : la salle de
   la chaîne, sinon l'étage immédiat. On la REÇOIT par l'interface hôte plutôt
   que d'en écrire une seconde — c'est la même question, elle n'a qu'une réponse.
   ============================================================================= */
import { Waypoint } from "../models/Waypoint";
import { CABLE_STATUS_DRAFT, CABLE_STATUS_BROKEN, CABLE_STATUS_RANK } from "../domain/constants";
import { PlacementContainers } from "../../src-shared/PlacementContainers";
import type { PlacementContainer } from "../../src-shared/PlacementContainers";
import { I18n } from "../i18n/I18n";

/** Codes STABLES des erreurs de route (cf. en-tête). Les LIBELLÉS sont traduits, les codes non. */
export type RouteErrorCode =
  | "floor_outside"     // pin d'étage posé À L'INTÉRIEUR d'une salle (il n'y a pas sa place)
  | "unplaced"          // waypoint non posé dans une salle
  | "room_wp_outside"   // waypoint de salle alors que la route est hors de toute salle
  | "wrong_room"        // waypoint de salle dans une autre salle que le segment courant
  | "exit_wrong_room"   // exit qui n'est pas de la salle courante
  | "exit_reentry"      // exit ré-entrant dans la salle tout juste quittée
  | "exit_unpaired"     // exit ouvrant un tronçon jamais refermé (aucun conteneur atteint ensuite)
  | "portA_room"        // port A hors du conteneur où la route commence
  | "portB_room"        // port B hors du conteneur où la route finit
  | "ports_split"       // deux bouts dans deux conteneurs sans exits pour les relier
  | "endpoints_split"   // FAISCEAU : deux extrémités dans deux conteneurs sans exits (miroir de ports_split)
  | "endpoint_route_mismatch"; // FAISCEAU : extrémités alignées sur la route ni à l'endroit ni à l'envers
export interface RouteError { code: RouteErrorCode; message: string }
/** Sous-ensemble « EXIT TERMINAL » (cohérence de salle) : un exit ferme sa salle → tout waypoint/exit de salle
    mal placé ensuite viole la route. Sert à refuser l'ajout d'un waypoint au fil de l'eau (UI routage + formulaire). */
export const ROUTE_ROOM_BREAK_CODES: ReadonlySet<RouteErrorCode> = new Set<RouteErrorCode>(["room_wp_outside", "wrong_room", "exit_wrong_room", "exit_reentry"]);
/** Erreurs STRUCTURELLES (grammaire des tronçons) = ruptures de salle + pin d'étage mal posé + exit non
    appairé. Elles interdisent l'enregistrement MÊME en brouillon (route mal formée), contrairement aux erreurs
    d'INCOMPLÉTUDE (ports/bouts pas encore posés) qui restent tolérées en brouillon. Sur-ensemble des « room break ».
    ⚠ Les codes de FAISCEAU (`endpoints_split`/`endpoint_route_mismatch`, cf. `bundleRoute`) n'y entrent PAS,
    délibérément : ce sont des incohérences de DONNÉES complétables plus tard (extrémités à reposer, route à
    corriger), pas une route mal formée — les y ajouter empêcherait d'enregistrer un faisceau en cours de saisie. */
export const ROUTE_STRUCTURAL_CODES: ReadonlySet<RouteErrorCode> = new Set<RouteErrorCode>([...ROUTE_ROOM_BREAK_CODES, "floor_outside", "exit_unpaired"]);

/** Une ÉTAPE de la route : le waypoint, son type ("datacenter" | "exit" | "floor") et le CONTENEUR qu'il
    DÉCLARE — la salle où il est posé, ou l'étage d'un pin d'étage. `null` = rien de localisable.

    ⚠ Le conteneur est celui que le waypoint DÉCLARE, indépendamment de sa pose : un waypoint rattaché à une
    salle mais aux coordonnées incomplètes (erreur `unplaced`) porte tout de même sa salle. C'est ce que
    consommaient déjà les bandes du mini-graphe de tracé, qui lisaient `wp.datacenter_id` sans se soucier de
    la pose ; le champ ne fait que leur épargner de reposer la question. */
export interface RouteStep { wp: any; type: string; container: PlacementContainer | null }

/** Analyse complète d'une route (cf. cableRoute).

    ⚠ `startDc`/`endDc`/`dcA`/`dcB` (ids de SALLE) sont devenus des CONTENEURS : un id ne peut pas désigner
    un étage, dont l'identité est le couple (bâtiment, étage) et qui n'a pas d'enregistrement obligatoire.
    `startContainer`/`endContainer` sont déduits des WAYPOINTS (où la route commence/finit) ;
    `containerA`/`containerB` des PORTS (où les bouts se trouvent réellement). */
export interface RouteAnalysis {
  steps: RouteStep[];
  errors: RouteError[];
  valid: boolean;
  hasExits: boolean;
  startContainer: PlacementContainer | null;
  endContainer: PlacementContainer | null;
  containerA: PlacementContainer | null;
  containerB: PlacementContainer | null;
}

/** Analyse de la route d'un FAISCEAU (cf. bundleRoute) : l'analyse du pseudo-câble, PLUS le SENS
    d'alignement des extrémités sur la route — "aligned" (extrémité A au départ), "swapped" (route saisie
    à l'envers, TOLÉRÉE — le rendu inverse les bouts), ou null (extrémité absente/non localisable, ou
    incohérence — auquel cas une erreur `endpoint_route_mismatch` l'explique). */
export interface BundleRouteAnalysis extends RouteAnalysis { sens: "aligned" | "swapped" | null }

/** ÉTAT de l'automate — ce qui remplace le booléen `outside` (cf. en-tête).

    - `dans` : la route est DANS un conteneur. `conteneur` vaut `null` tant qu'aucun n'a été identifié
      (début de route, ou waypoint sans rattachement) : c'est l'état initial, et le seul depuis lequel un
      conteneur peut être ADOPTÉ (c'est-à-dire ouvrir la route).
    - `transit` : la route a QUITTÉ un conteneur par un exit et n'est arrivée nulle part. C'est le seul
      état qui reste incomplet en fin de route (`exit_unpaired`).

    ⚠ Un conteneur ÉTAGE est un état `dans`, PAS un transit — c'est toute la différence avec l'ancien
    `outside`, qui confondait « sur un étage » et « nulle part ». */
type EtatParcours =
  | { ou: "dans"; conteneur: PlacementContainer | null }
  | { ou: "transit" };

/** Capacités de LECTURE dont l'analyseur a besoin — sous-ensemble du Store, injecté (testable en isolation). */
export interface RouteStoreView {
  get(collection: string, id: string | null | undefined): any;
  waypointIsPlaced(wp: any): boolean;
  /** Conteneur de niveau ROUTE d'un équipement : la SALLE de sa chaîne, sinon l'ÉTAGE immédiat, sinon
      `null`. A généralisé l'ancien `equipmentDcId` — RETIRÉ du dépôt depuis (§6.33) — dont c'était le
      verdict EXACT sur tous les modes de placement existants (cf. `core/ContainerLabel.namedOfChain`,
      doctrine §6.29). */
  equipmentNamedContainer(eqOrId: any): PlacementContainer | null;
  /** Libellé affichable d'un conteneur (« Salle A », « Bât. X · ét. 1 »), `null` s'il n'y a rien à nommer. */
  containerLabel(container: PlacementContainer | null): string | null;
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

  /** Libellé d'un conteneur, avec le MÊME repli que `dcName` quand il n'y a rien à nommer ("?"). Un seul
      repli pour les deux, pour que le résumé d'une route ne se mette pas à parler deux langues. */
  private conteneurNom(container: PlacementContainer | null): string {
    return this.s.containerLabel(container) || this.dcName(null);
  }

  /** Conteneur DÉCLARÉ par un waypoint : l'ÉTAGE d'un pin d'étage, sinon la SALLE de rattachement. */
  private waypointContainer(wp: any): PlacementContainer | null {
    if (Waypoint.isFloorLevel(wp)) return PlacementContainers.floorOf(wp.location, wp.floor);
    return wp && wp.datacenter_id ? { kind: "room", id: String(wp.datacenter_id) } : null;
  }

  /** Conteneur du bout A|B d'un câble (null = port absent OU équipement rattaché à rien de traversable). */
  cableEndContainer(cable: any, side: "A" | "B"): PlacementContainer | null {
    const pid = side === "A" ? cable.from_port_id : cable.to_port_id;
    const p = pid ? this.s.get("ports", pid) : null;
    return p ? this.s.equipmentNamedContainer(p.equipment_id) : null;
  }

  /** Analyse de la route (waypoint_ids EFFECTIFS, ordonnés A→B) : grammaire + cohérence des bouts posés.
      → { steps, errors, valid, hasExits, startContainer, endContainer, containerA, containerB }. Pure lecture. */
  cableRoute(cable: any): RouteAnalysis {
    const wps = this.s.effectiveWaypointIds(cable).map((id) => this.s.get("waypoints", id)).filter((w): w is NonNullable<typeof w> => w != null);
    const errors: RouteError[] = [], steps: RouteStep[] = [];
    const err = (code: RouteErrorCode, message: string) => { errors.push({ code, message }); };

    /* ÉTAT MUTABLE de l'automate, réuni dans un objet — ce n'est pas un caprice de style : l'analyse de
       flot de TypeScript ne suit pas les affectations faites dans le rappel d'un `forEach`, et figerait des
       `let` sur le type de leur valeur INITIALE (`etat` réduit à « dans », `startContainer` à `null`), au
       point de rendre le bilan de fin de route inexprimable. Les propriétés d'un objet, elles, voient leur
       affinement remis à zéro par tout appel de fonction. */
    const parcours: {
      etat: EtatParcours;
      /** Dernier conteneur QUITTÉ par un exit (détection de la ré-entrée). Survit à l'arrivée sur un
          étage : sortir d'une salle, traverser son étage puis y re-rentrer reste une ré-entrée. */
      quitte: PlacementContainer | null;
      start: PlacementContainer | null;
      exits: number;
    } = { etat: { ou: "dans", conteneur: null }, quitte: null, start: null, exits: 0 };
    /** ARRIVÉE dans un conteneur. Le conteneur de DÉPART se fixe au moment où l'automate en identifie un
        PREMIER, c'est-à-dire depuis l'état `dans(null)` : ni une entrée depuis un transit (la route a déjà
        commencé, un exit l'a ouverte), ni un changement d'étage ne le déplacent. */
    const arriver = (c: PlacementContainer | null) => {
      if (parcours.start == null && parcours.etat.ou === "dans" && parcours.etat.conteneur == null) parcours.start = c;
      parcours.etat = { ou: "dans", conteneur: c };
    };

    wps.forEach((wp) => {
      const nm = wp.name || "(waypoint)";
      const conteneur = this.waypointContainer(wp);
      // Lecture de l'état AVANT transition — `dedans` n'a de sens que hors transit (d'où les deux variables
      // plutôt qu'un `null` ambigu, qui confondrait « en transit » et « dans un conteneur inconnu »).
      const enTransit = parcours.etat.ou === "transit";
      const dedans: PlacementContainer | null = parcours.etat.ou === "dans" ? parcours.etat.conteneur : null;

      if (Waypoint.isFloorLevel(wp)) {
        /* PIN D'ÉTAGE : il NOMME l'étage sur lequel la route se trouve. Il n'est refusé qu'à l'INTÉRIEUR
           d'une salle — là il n'a physiquement pas sa place. Ailleurs (début de route, transit après un
           exit, ou déjà sur un étage) il fait ARRIVER la route sur son étage : c'est la fermeture de
           tronçon qui remplace « un second exit » quand la destination n'est pas une salle. */
        if (!enTransit && dedans != null && dedans.kind === "room") err("floor_outside", I18n.t("analysis.route.floorPinInRoom", { name: nm }));
        else arriver(conteneur);
        steps.push({ wp, type: "floor", container: conteneur });
        return;
      }

      const t = Waypoint.typeOf(wp);
      if (!this.s.waypointIsPlaced(wp)) { err("unplaced", I18n.t("analysis.route.unplaced", { name: nm })); steps.push({ wp, type: t, container: conteneur }); return; }

      if (t === "datacenter") {
        if (enTransit) err("room_wp_outside", I18n.t("analysis.route.roomWpInTransit", { name: nm }));
        else if (dedans != null && dedans.kind !== "room") err("room_wp_outside", I18n.t("analysis.route.roomWpOnFloor", { name: nm }));
        else if (dedans == null) arriver(conteneur);
        else if (!PlacementContainers.sameOrNone(conteneur, dedans)) err("wrong_room", I18n.t("analysis.route.wrongRoom", { name: nm }));
      } else {   // exit
        parcours.exits++;
        /* SORTIE ou ENTRÉE ? On SORT quand la route est dans une SALLE — ou n'a pas encore de conteneur,
           l'exit ouvrant alors la route en ADOPTANT sa salle. On ENTRE quand elle est en transit ou sur un
           ÉTAGE. C'est la généralisation stricte de l'ancien `!outside` : un étage y comptait pour « dehors ». */
        if (!enTransit && (dedans == null || dedans.kind === "room")) {
          const quittee = dedans == null ? conteneur : dedans;
          if (dedans == null) arriver(conteneur);
          if (!PlacementContainers.sameOrNone(conteneur, quittee)) err("exit_wrong_room", I18n.t("analysis.route.exitWrongRoom", { name: nm }));
          parcours.quitte = quittee; parcours.etat = { ou: "transit" };
        } else {
          if (PlacementContainers.sameOrNone(parcours.quitte, conteneur)) err("exit_reentry", I18n.t("analysis.route.exitReentry", { name: nm }));
          arriver(conteneur); parcours.quitte = null;
        }
      }
      steps.push({ wp, type: t, container: conteneur });
    });

    /* FIN DE ROUTE. Seul le TRANSIT est incomplet : la route a quitté un conteneur sans en atteindre un
       autre. Être « sur un étage » est une arrivée à part entière (c'est le nœud du lot). */
    if (parcours.etat.ou === "transit") err("exit_unpaired", I18n.t("analysis.route.exitUnpaired"));
    const endContainer: PlacementContainer | null = parcours.etat.ou === "transit" ? null : parcours.etat.conteneur;
    const startContainer = parcours.start;
    const containerA = this.cableEndContainer(cable, "A"), containerB = this.cableEndContainer(cable, "B");
    if (containerA && startContainer && !PlacementContainers.same(containerA, startContainer)) err("portA_room", I18n.t(startContainer.kind === "floor" ? "analysis.route.portAFloor" : "analysis.route.portARoom"));
    if (containerB && endContainer && !PlacementContainers.same(containerB, endContainer)) err("portB_room", I18n.t(endContainer.kind === "floor" ? "analysis.route.portBFloor" : "analysis.route.portBRoom"));
    // D2 : deux bouts dans deux conteneurs DIFFÉRENTS exigent une sortie — que ce soient deux salles, deux
    // étages, ou l'un et l'autre. Deux bouts du MÊME conteneur n'exigent rien : c'est la règle historique,
    // « conteneur » remplaçant « salle », sans branche propre à l'étage.
    if (!parcours.exits && containerA && containerB && !PlacementContainers.same(containerA, containerB)) {
      const deuxSalles = containerA.kind === "room" && containerB.kind === "room";
      err("ports_split", I18n.t(deuxSalles ? "analysis.route.portsSplitRooms" : "analysis.route.portsSplitPlaces"));
    }
    return { steps, errors, valid: !errors.length, hasExits: parcours.exits > 0, startContainer, endContainer, containerA, containerB };
  }

  /** Analyse de la route d'un FAISCEAU (`cableBundles`) : la grammaire du pseudo-câble + la COHÉRENCE de
      ses extrémités (`endpoint_a/b_equipment_id` — des patchs, pas des ports).

      POURQUOI ICI ET PAS DANS LE RENDU. Un faisceau n'a pas de ports : le rendu (`TrunkRouting`) analysait
      sa route via un pseudo-câble SANS bouts — `portA_room`/`portB_room`/`ports_split` ne pouvaient donc
      JAMAIS se déclencher — puis vérifiait LUI-MÊME l'alignement extrémités ⇄ route et, en cas
      d'incohérence, ne traçait RIEN, silencieusement. Incident réel (corpus SONUMA) : un faisceau dont le
      1er waypoint sortait d'une salle ne contenant AUCUNE extrémité était invisible en 2D/3D, sans le
      moindre message nulle part. Le verdict vit désormais ICI (source unique) ; le rendu le CONSOMME
      (`sens`), le formulaire faisceau l'AFFICHE (hint de route).

      — `containerA`/`containerB` : conteneurs des extrémités (`equipmentNamedContainer` — la salle de la
        chaîne, sinon l'étage) ; ils REMPLACENT les null que le pseudo-câble sans ports rendait ;
      — `sens` : cf. `BundleRouteAnalysis` — la tolérance d'inversion est une PARITÉ avec le rendu
        historique (`interDcTrunks` la pratiquait déjà), on ne la retire pas ;
      — `endpoints_split` : miroir EXACT de `ports_split`, appliqué aux extrémités — aucun doublon
        possible, le pseudo-câble n'ayant pas de ports pour déclencher l'original ;
      — `endpoint_route_mismatch` : la route a des exits et nomme départ/arrivée, mais les extrémités ne
        s'y alignent NI à l'endroit NI à l'envers. Le message NOMME les conteneurs (les quatre à deux
        extrémités posées, les trois à une seule) — c'est lui qui aurait révélé l'incident.
      ⚠ Ces deux codes n'entrent ni dans ROUTE_STRUCTURAL_CODES ni dans ROUTE_ROOM_BREAK_CODES (cf. leur
      en-tête) : erreurs de COHÉRENCE complétables, pas de grammaire — un brouillon reste enregistrable. */
  bundleRoute(bundle: any): BundleRouteAnalysis {
    const r = this.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: bundle.waypoint_ids || [] });
    const cA = bundle.endpoint_a_equipment_id ? this.s.equipmentNamedContainer(bundle.endpoint_a_equipment_id) : null;
    const cB = bundle.endpoint_b_equipment_id ? this.s.equipmentNamedContainer(bundle.endpoint_b_equipment_id) : null;
    const errors = r.errors.slice();
    /* SENS : `same` rend false dès qu'un terme manque → « aligned »/« swapped » exigent d'eux-mêmes les
       DEUX extrémités posées ET un départ/arrivée nommés, sans garde supplémentaire. */
    const aligned = PlacementContainers.same(cA, r.startContainer) && PlacementContainers.same(cB, r.endContainer);
    const swapped = !aligned && PlacementContainers.same(cB, r.startContainer) && PlacementContainers.same(cA, r.endContainer);
    const sens: BundleRouteAnalysis["sens"] = aligned ? "aligned" : (swapped ? "swapped" : null);
    // Miroir de `ports_split` (même condition, mêmes mots — D4 : « salles » quand c'en sont deux).
    if (!r.hasExits && cA && cB && !PlacementContainers.same(cA, cB)) {
      const deuxSalles = cA.kind === "room" && cB.kind === "room";
      errors.push({ code: "endpoints_split", message: I18n.t(deuxSalles ? "analysis.route.endpointsSplitRooms" : "analysis.route.endpointsSplitPlaces") });
    }
    // Route à exits, départ et arrivée NOMMÉS : les extrémités posées doivent s'y aligner (un sens ou l'autre).
    if (r.hasExits && r.startContainer && r.endContainer) {
      const start = this.conteneurNom(r.startContainer), end = this.conteneurNom(r.endContainer);
      if (cA && cB) {
        if (!sens) errors.push({ code: "endpoint_route_mismatch", message: I18n.t("analysis.route.endpointRouteMismatch", { start, end, a: this.conteneurNom(cA), b: this.conteneurNom(cB) }) });
      } else if (cA || cB) {
        // Une SEULE extrémité posée : elle peut encore tenir l'un ou l'autre bout (route à compléter) —
        // erreur seulement si elle ne matche NI le départ NI l'arrivée.
        const seule = (cA || cB) as PlacementContainer;
        if (!PlacementContainers.same(seule, r.startContainer) && !PlacementContainers.same(seule, r.endContainer))
          errors.push({ code: "endpoint_route_mismatch", message: I18n.t("analysis.route.endpointRouteMismatchOne", { start, end, name: this.conteneurNom(seule) }) });
      }
    }
    return { ...r, errors, valid: !errors.length, containerA: cA, containerB: cB, sens };
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

  /** Contrainte de CONTENEUR d'un BOUT ("A"|"B"), évaluée SANS son port : { container, onlyUnplaced, route }. */
  cableSideConstraint(cable: any, side: "A" | "B"): { container: PlacementContainer | null; onlyUnplaced: boolean; route: RouteAnalysis } {
    const probe = {
      from_port_id: side === "A" ? null : cable.from_port_id,
      to_port_id: side === "B" ? null : cable.to_port_id,
      waypoint_ids: cable.waypoint_ids || [],
    };
    const r = this.cableRoute(probe);
    if (!r.valid) return { container: null, onlyUnplaced: true, route: r };
    const own = side === "A" ? r.startContainer : r.endContainer;
    if (own) return { container: own, onlyUnplaced: false, route: r };
    if (!r.hasExits) {
      const other = side === "A" ? r.containerB : r.containerA;
      if (other) return { container: other, onlyUnplaced: false, route: r };
    }
    return { container: null, onlyUnplaced: false, route: r };
  }

  /** Résumé lisible de la route : « ◆ Salle A → ⏏ Salle A → ◎ Bât. Liège · ét. 1 → ⏏ Salle B ».
      CHAÎNE DE CONTENEURS : chaque étape nomme le sien, et l'on n'écrit une étape que lorsqu'elle change de
      conteneur (un exit en écrit une systématiquement — il MARQUE la traversée). Le pin d'étage suit la même
      règle que les autres au lieu de la sienne : c'est le cas particulier que ce lot retire. */
  cableRouteSummary(r: RouteAnalysis): string {
    if (!r.steps.length) return "";
    const parts: string[] = [];
    let dernier: PlacementContainer | null = null;
    r.steps.forEach((s) => {
      const glyphe = s.type === "floor" ? "◎" : s.type === "exit" ? "⏏" : "◆";
      if (s.type === "exit" || !PlacementContainers.sameOrNone(s.container, dernier)) {
        parts.push(glyphe + " " + this.conteneurNom(s.container));
        dernier = s.container;
      }
    });
    return parts.join(" → ");
  }

  /** Statut MAXIMAL d'un câble : brouillon (incomplet/route invalide) → planifié → câblé (2 bouts posés). */
  cableMaxStatus(cable: any): string {
    if (!this.s.cableIsComplete(cable)) return CABLE_STATUS_DRAFT;
    const r = this.cableRoute(cable);
    if (!r.valid) return CABLE_STATUS_DRAFT;
    return (r.containerA && r.containerB) ? "cable" : "planifie";
  }
  /** Le statut `statusId` est-il ≤ au maximum `maxId` ? */
  cableStatusFits(statusId: string, maxId: string): boolean {
    return (CABLE_STATUS_RANK[statusId] != null ? CABLE_STATUS_RANK[statusId] : 2) <= (CABLE_STATUS_RANK[maxId] || 0);
  }

  /* ---- contrainte physique de placement (câblage) ---- */

  /** Conteneurs où un câble POSÉ contraint l'équipement à être, avec les câbles qui l'imposent.
      Une route en chantier (onlyUnplaced) ou sans contrainte n'impose rien.

      ⚠ UNE LISTE, PLUS UNE `Map` : un étage n'a pas d'id, il ne peut donc pas servir de CLÉ. Les
      conteneurs se dédoublonnent par `PlacementContainers.same` (comparaison structurelle), comme partout
      ailleurs dans le chantier. */
  equipmentRequiredContainers(eqId: string): Array<{ container: PlacementContainer; cables: any[] }> {
    const req: Array<{ container: PlacementContainer; cables: any[] }> = [], seen = new Set<string>();
    this.s.portsOf(eqId).forEach((p) => {
      const c = this.s.cableOnPort(p.id);
      if (!c || seen.has(c.id)) return; seen.add(c.id);
      const side = c.from_port_id === p.id ? "A" : "B";
      const k = this.cableSideConstraint(c, side as "A" | "B");
      const impose = k.container;
      if (k.onlyUnplaced || !impose) return;
      const deja = req.find((x) => PlacementContainers.same(x.container, impose));
      if (deja) deja.cables.push(c); else req.push({ container: impose, cables: [c] });
    });
    return req;
  }
  /** Motif de blocage du placement dans la salle cible (null = autorisé) : la cible doit
      satisfaire TOUTES les contraintes de câblage de l'équipement.

      La CIBLE reste une salle : c'est ce que proposent les vues 2D/3D et les formulaires de baie (on
      dépose un équipement DANS une salle). Les contraintes, elles, peuvent désormais désigner un étage —
      auquel cas aucune salle ne les satisfait, et le message le dit avec le mot juste (décision D4). */
  equipmentPlacementBlockedReason(eqId: string, targetDcId: string): string | null {
    const req = this.equipmentRequiredContainers(eqId);
    if (!req.length) return null;
    const cible: PlacementContainer = { kind: "room", id: targetDcId };
    if (req.length === 1 && PlacementContainers.same(req[0].container, cible)) return null;
    const names = req.map((x) => this.conteneurNom(x.container)).join(", ");
    const queDesSalles = req.every((x) => x.container.kind === "room");
    if (req.length > 1) return I18n.t(queDesSalles ? "analysis.route.blockedManyRooms" : "analysis.route.blockedManyPlaces", { names });
    return I18n.t("analysis.route.blockedOne", { name: names });
  }
  /** Idem pour un RACK entier (vérifie chaque équipement monté en U). null = autorisé. */
  rackPlacementBlockedReason(rackId: string, targetDcId: string): string | null {
    const eqs = this.s.equipmentsOfRack(rackId).filter((e: any) => e.placement_mode === "rack" && e.rack_u != null);
    for (const e of eqs) {
      const why = this.equipmentPlacementBlockedReason(e.id, targetDcId);
      if (why) return I18n.t("analysis.route.blockedRackEquip", { name: e.name || I18n.t("analysis.route.equipFallback"), why });
    }
    return null;
  }
  /** Un câble est-il valide compte tenu des conteneurs physiques de ses deux bouts ?

      ⚠ CE PRÉDICAT AVAIT UN TROU, refermé ici (doctrine §6.31). Il n'exigeait une route à exits que si
      « au moins l'un des deux contextes est une SALLE » : deux ÉTAGES DIFFÉRENTS retombaient donc sur
      « valide », sans aucune exigence de sortie. La décision D2 dit « pas d'exit entre deux équipements du
      MÊME conteneur » — donc deux conteneurs DIFFÉRENTS, quels qu'ils soient, exigent la sortie. La règle
      se lit maintenant telle quelle, sans énumérer les natures de conteneur. */
  cableContextValid(c: any): boolean {
    const pf = c.from_port_id ? this.s.get("ports", c.from_port_id) : null, pt = c.to_port_id ? this.s.get("ports", c.to_port_id) : null;
    if (!pf || !pt) return true;
    const ca = this.s.equipmentNamedContainer(pf.equipment_id), cb = this.s.equipmentNamedContainer(pt.equipment_id);
    if (!ca || !cb) return true;                                   // un bout non localisable n'impose rien
    if (PlacementContainers.same(ca, cb)) return true;             // MÊME conteneur ⇒ aucune sortie exigée (D2)
    const r = this.cableRoute(c); return r.valid && r.hasExits;     // conteneurs différents ⇒ la route doit sortir
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
      const reason = I18n.t("analysis.cable.breakReason", {
        equip: eq.name || "?",
        remote: remoteEq ? (remoteEq.name || "?") : "?",
        port: remotePort ? (remotePort.name || "?") : "?",
      });
      const patch: Record<string, any> = { status: CABLE_STATUS_BROKEN, description: (c.description ? c.description.trim() + "\n" : "") + reason };
      if (fromIsEq) patch.to_port_id = null; else patch.from_port_id = null;
      ops.push({ collection: "cables", id: c.id, patch });
    });
    return ops;
  }
  /** Patchs de DÉGRADATION (« Câblé / À remplacer » → « Planifié ») des câbles des équipements donnés —
      quand ils QUITTENT leur conteneur. À fusionner avec le patch de retrait pour un seul undo. */
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
