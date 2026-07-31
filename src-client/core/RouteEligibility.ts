/* =============================================================================
   RouteEligibility — « quels waypoints puis-je ajouter ICI, et POURQUOI pas les
   autres ? », plus « quelle étape porte quelle erreur ? ».

   Classe PURE : aucun DOM, aucun store, aucun modèle. Tout ce dont elle a besoin
   est INJECTÉ (patron `PowerAnalysis`/`Locatable`/`ContainerLabel`) —
     • la liste des waypoints CANDIDATS, décrits par l'appelant (`RouteCandidate`) ;
     • une fonction d'ANALYSE `(waypoint_ids) => RouteAnalysis` : selon l'appelant,
       `store.cableRoute({from, to, waypoint_ids})` ou `store.bundleRoute({…})` ;
     • les conteneurs des deux ANCRES (bouts A/B du câble, extrémités du faisceau).

   ⚠ CE MODULE NE RÉIMPLÉMENTE PAS LA GRAMMAIRE — il la CONSOMME.
   `store/CableRouteAnalyzer` reste la SOURCE DE VÉRITÉ (doctrine `docs/placement.md`
   §6.31) ; ici on ne fait que lui POSER LA QUESTION : « que dirait l'analyse si
   j'insérais W en position i ? ». C'est la seule façon d'être certain que le
   popover d'ajout et la validation à l'enregistrement ne divergeront jamais —
   exactement le défaut que `core/Locatable` a refermé pour les boutons
   « Localiser » (prédicat d'un côté, action de l'autre, et l'écart s'appelle un
   bouton mort). Le SEUL jugement rendu ici sans passer par l'analyse concerne des
   cas où elle n'a rien à dire : un waypoint DÉJÀ dans la route, un waypoint NON
   POSÉ.

   ⚠ LES MOTIFS SONT DES CODES, jamais des phrases (patron `PowerAnalysis`) : la
   traduction se fait AU RENDU (`I18n.t`), côté `views/forms/RouteChainEditor`.
   Un module pur qui produirait du français serait intraduisible et intestable.

   ----------------------------------------------------------------------------
   RATTACHER UNE ERREUR À SON ÉTAPE — le point technique du module.

   `RouteAnalysis.errors` porte des `{ code, message }` SANS index d'étape : le
   carton de design affirmait le rattachement « possible depuis les steps », il
   ne l'est pas DIRECTEMENT. Il l'est en revanche par CONSTRUCTION de l'automate,
   et c'est ce qu'on exploite ici :

     1. l'automate est un PLI À GAUCHE (`wps.forEach`) : le verdict des k
        premières étapes ne dépend QUE des k premiers waypoints — allonger la
        route ne réécrit jamais le passé ;
     2. chaque étape pousse AU PLUS UNE erreur de grammaire (vérifié branche par
        branche dans `cableRoute`), et dans l'ORDRE des étapes.

   Donc : en analysant les PRÉFIXES successifs, l'étape qui fait CROÎTRE le
   nombre d'erreurs de grammaire est celle qui porte la dernière d'entre elles.
   `stepErrors` n'est rien d'autre que ce balayage. Coût : n+1 analyses pour une
   route de n étapes — négligeable (les routes réelles font 0 à 3 étapes, le
   maximum plausible une dizaine), et payé à la frappe, pas à l'image.

   ⚠ NE SONT DES ERREURS D'ÉTAPE que les codes de `STEP_CODES`. Les autres se
   rattachent AILLEURS et ne doivent surtout pas atterrir sur une étape :
   `exit_unpaired` est un état de FIN de route (et, depuis ce chantier, un état
   VISIBLE — le bandeau « Transit » — plutôt qu'une erreur), `portA_room`/
   `portB_room`/`ports_split`/`endpoints_split`/`endpoint_route_mismatch` parlent
   des ANCRES.
   ============================================================================= */
import { PlacementContainers } from "../../src-shared/PlacementContainers";
import type { PlacementContainer } from "../../src-shared/PlacementContainers";
// Import de TYPES SEULEMENT : effacé à la compilation, donc AUCUN couplage à
// l'exécution entre `core/` et `store/` (même patron que `core/Ip` ↔ `Store`).
// On préfère ce type-import à une redéclaration structurelle : dupliquer la forme
// de l'analyse, c'est se condamner à la voir diverger (principe n°3).
import type { RouteAnalysis, RouteError, RouteErrorCode } from "../store/CableRouteAnalyzer";

/** L'ANALYSE, injectée : la grammaire appliquée à une suite ORDONNÉE de waypoints.
    Le câble fournit `(ids) => store.cableRoute({from_port_id, to_port_id, waypoint_ids: ids})`,
    le faisceau `(ids) => store.bundleRoute({endpoint_a…, endpoint_b…, waypoint_ids: ids})`. */
export type RouteAnalyze = (waypointIds: readonly string[]) => RouteAnalysis;

/** Type NORMALISÉ d'un waypoint, tel que la grammaire le nomme (`RouteStep.type`). */
export type RouteCandidateType = "datacenter" | "exit" | "floor";

/** Un waypoint CANDIDAT, décrit par l'appelant — le module ne connaît ni `Waypoint` ni le store. */
export interface RouteCandidate {
  id: string;
  /** Conteneur DÉCLARÉ : la SALLE de rattachement, ou l'ÉTAGE d'un pin d'étage. `null` = rien de
      localisable (waypoint du pool). C'est la clé de GROUPEMENT — la question de l'utilisateur est
      « par où je passe ? », donc le conteneur, pas le type (carton §2.3). */
  container: PlacementContainer | null;
  /** Type normalisé (`Waypoint.typeOf`, `Waypoint.isFloorLevel`). Sert à faire remonter les EXITS en
      tête de leur groupe : ce sont les ARTICULATIONS de la route, ce qu'on cherche neuf fois sur dix. */
  type: RouteCandidateType;
  /** Le waypoint est-il POSÉ ? Un pin d'étage l'est toujours (il n'a pas de pose EN SALLE — la
      grammaire ne lui applique pas `waypointIsPlaced`). Un `false` bloque sans même analyser. */
  placed: boolean;
}

/** CONTENEURS des deux ancres — bouts A/B d'un câble, extrémités A/B d'un faisceau. */
export interface RouteAnchors {
  a: PlacementContainer | null;
  b: PlacementContainer | null;
}

/** Motif de REFUS d'un candidat. CODES STABLES (les libellés sont traduits au rendu) :
    - `already_in_route` : le waypoint est déjà une étape de cette route ;
    - `unplaced` : waypoint non posé — visible mais inutilisable (carton §5.7) ;
    - `floor_pin_in_room` : pin d'étage À L'INTÉRIEUR d'une salle (`floor_outside`) ;
    - `in_transit` : la route a quitté une salle et n'est arrivée nulle part — seuls l'exit d'une
      AUTRE salle ou un pin d'étage referment le tronçon (`room_wp_outside` en transit) ;
    - `room_wp_on_floor` : waypoint de salle alors que la route est SUR UN ÉTAGE (même code
      `room_wp_outside`, mais l'utilisateur doit lire le mot juste — décision D4 du chantier étage) ;
    - `wrong_room` : hors du conteneur COURANT de la route ;
    - `exit_wrong_room` : exit d'une autre salle que celle où la route se trouve ;
    - `exit_reentry` : re-rentrer dans la salle tout juste quittée ;
    - `breaks_route` : l'insertion AU MILIEU casserait une étape SUIVANTE (n'arrive jamais en fin
      de route — seul le « + » d'interstice, qui insère au milieu, peut le rencontrer) ;
    - `invalid_here` : filet de sécurité — un code de grammaire non encore cartographié ici. */
export type RouteBlockCode =
  | "already_in_route"
  | "unplaced"
  | "floor_pin_in_room"
  | "in_transit"
  | "room_wp_on_floor"
  | "wrong_room"
  | "exit_wrong_room"
  | "exit_reentry"
  | "breaks_route"
  | "invalid_here";

/** Verdict rendu sur UN candidat. */
export interface RouteVerdict {
  candidate: RouteCandidate;
  /** Sélectionnable à cette position ? */
  usable: boolean;
  /** Motif du refus (code stable) — `null` quand `usable`. */
  reason: RouteBlockCode | null;
}

/** Étiquette de PERTINENCE d'un groupe (code stable, traduit au rendu) :
    - `current` : le conteneur où la route se trouve à la position d'insertion ;
    - `endpoints` / `endpointA` / `endpointB` : conteneur du/des bout(s) ;
    - `left` : la salle QUITTÉE par le dernier exit (on ne peut pas y revenir) ;
    - `null` : rien de particulier à dire. */
export type RouteGroupRelevance = "current" | "endpoints" | "endpointA" | "endpointB" | "left" | null;

/** Un GROUPE de candidats partageant le même CONTENEUR. */
export interface RouteGroup {
  container: PlacementContainer | null;
  relevance: RouteGroupRelevance;
  items: RouteVerdict[];
}

/** ÉTAT de l'automate À LA POSITION D'INSERTION — ce que le popover doit expliquer. */
export interface RouteInsertState {
  /** La route a-t-elle quitté un conteneur sans en atteindre un autre (`exit_unpaired`) ? */
  transit: boolean;
  /** Conteneur COURANT ; `null` en transit, ou tant que la route n'en a identifié aucun. */
  container: PlacementContainer | null;
  /** Conteneur QUITTÉ par le dernier exit — sert à l'étiquette « salle quittée ». */
  left: PlacementContainer | null;
}

/** Ce qu'on sait d'UNE étape, sans avoir réimplémenté la grammaire : l'erreur qu'elle porte, et
    l'état de l'automate APRÈS elle. Le second est ce qui permet de peindre les BANDEAUX (« Transit »
    dès qu'un tronçon reste ouvert au-delà de l'étape, sinon le conteneur traversé). */
export interface RouteStepReport {
  error: RouteError | null;
  after: RouteInsertState;
}

/** Ce que produit `plan()` : l'état, les groupes ordonnés, et la MÊME liste à plat. */
export interface RouteAddPlan {
  state: RouteInsertState;
  /** Groupes par conteneur, ordonnés par PERTINENCE (① courant, ② bouts, ③ reste, ④ salle quittée). */
  groups: RouteGroup[];
  /** Concaténation des groupes — la MÊME liste sans en-têtes. Le popover consomme `groups` depuis le
      lot L3 ; la vue à plat reste pour les tests et tout consommateur sans en-têtes. */
  flat: RouteVerdict[];
}

export class RouteEligibility {
  /** Codes d'erreur RATTACHABLES À UNE ÉTAPE (cf. en-tête). Tout le reste parle de la FIN de route
      (`exit_unpaired`) ou des ANCRES (`portA_room`, `ports_split`, codes de faisceau…). */
  static readonly STEP_CODES: ReadonlySet<RouteErrorCode> = new Set<RouteErrorCode>([
    "floor_outside", "unplaced", "room_wp_outside", "wrong_room", "exit_wrong_room", "exit_reentry",
  ]);

  /** Rang d'affichage d'une pertinence — plus petit = plus haut. La « salle quittée » passe en
      DERNIER, et c'est délibéré : c'est le seul endroit où la grammaire interdit de retourner, donc
      le moins utile à proposer, quand bien même il serait aussi le conteneur d'un bout. */
  private static readonly RELEVANCE_RANK: Record<string, number> = {
    current: 0, endpoints: 1, endpointA: 2, endpointB: 3, other: 4, left: 5,
  };

  /* ---------------------------------------------------------------- étapes -- */

  /** Erreurs de GRAMMAIRE rattachées à LEUR étape : tableau INDEXÉ COMME `analyze(ids).steps`
      (`null` = étape saine). Cf. l'en-tête pour la démonstration ; en deux mots : on analyse les
      préfixes et l'on regarde quelle étape fait croître le compte d'erreurs d'étape.

      ⚠ INDEXÉ PAR ÉTAPE, PAS PAR `waypoint_ids`. Un id qui ne résout aucun waypoint (référence
      pendante) ne produit PAS d'étape — l'appelant doit donc apparier ses lignes aux `steps`, pas
      aux ids bruts. C'est ce que fait `RouteChainEditor`, qui filtre les ids non résolus avant de
      peindre ses lignes (parité avec l'ancien « Ordre des points », qui les sautait déjà). */
  static stepErrors(ids: readonly string[], analyze: RouteAnalyze): Array<RouteError | null> {
    return RouteEligibility.stepReports(ids, analyze).map((report) => report.error);
  }

  /** Le BALAYAGE DE PRÉFIXES complet : par étape, l'erreur qu'elle porte ET l'état de l'automate
      APRÈS elle. Même indexation que `analyze(ids).steps` (cf. `stepErrors`).

      L'état par étape n'est pas un supplément décoratif : c'est lui qui distingue un tronçon
      RESTÉ OUVERT (bandeau « Transit ») d'un tronçon aussitôt refermé par l'étape suivante — la
      différence exacte entre les états 6.3 et 6.6 de la maquette. Le déduire des seuls conteneurs
      d'étape est impossible : deux exits d'affilée n'en disent rien. */
  static stepReports(ids: readonly string[], analyze: RouteAnalyze): RouteStepReport[] {
    const out: RouteStepReport[] = [];
    let previousSteps = 0;
    let previousErrors = 0;
    for (let taken = 1; taken <= ids.length; taken++) {
      const analysis = analyze(ids.slice(0, taken));
      const stepErrors = RouteEligibility.stepErrorsOf(analysis);
      const steps = analysis.steps.length;
      if (steps > previousSteps) {
        const after = RouteEligibility.stateOf(analysis);
        // Cet id a produit une (ou plusieurs, en théorie jamais) étape(s). La dernière porte
        // l'erreur nouvellement apparue, s'il y en a une.
        while (out.length < steps - 1) out.push({ error: null, after });
        out.push({ error: stepErrors.length > previousErrors ? stepErrors[stepErrors.length - 1] : null, after });
      }
      previousSteps = steps;
      previousErrors = stepErrors.length;
    }
    return out;
  }

  /** ÉTAT de l'automate tel qu'une analyse le laisse (fin de la route analysée). */
  static stateOf(analysis: RouteAnalysis): RouteInsertState {
    const transit = RouteEligibility.isTransit(analysis);
    return {
      transit,
      container: transit ? null : analysis.endContainer,
      left: transit ? RouteEligibility.lastExitContainer(analysis) : null,
    };
  }

  /** La route est-elle saisie À L'ENVERS — les deux ancres desservies, mais échangées ?

      C'est l'« équivalent câble » du `sens: "swapped"` que `bundleRoute` expose déjà, écrit une
      seule fois pour les deux formulaires : la question ne porte que sur `containerA`/`containerB`
      (les ANCRES, quelles qu'elles soient — ports d'un câble, patchs d'un faisceau) face à
      `startContainer`/`endContainer` (la ROUTE). D'où une action à proposer plutôt qu'un blocage
      (carton §4.4, maquette 6.7b) : le moteur tolère déjà l'inversion au rendu. */
  static isReversed(analysis: RouteAnalysis): boolean {
    const { containerA, containerB, startContainer, endContainer } = analysis;
    if (!containerA || !containerB || !startContainer || !endContainer) return false;
    if (PlacementContainers.same(containerA, startContainer)) return false;   // déjà à l'endroit
    return PlacementContainers.same(containerA, endContainer) && PlacementContainers.same(containerB, startContainer);
  }

  /** Les erreurs de l'analyse qui se rattachent à une ÉTAPE, dans l'ordre des étapes. */
  static stepErrorsOf(analysis: RouteAnalysis): RouteError[] {
    return analysis.errors.filter((e) => RouteEligibility.STEP_CODES.has(e.code));
  }

  /** La route se termine-t-elle EN TRANSIT (exit ouvert, tronçon non refermé) ? C'est l'ÉTAT que la
      chaîne affiche en bandeau pointillé, et non plus une erreur au save (carton §4.3). */
  static isTransit(analysis: RouteAnalysis): boolean {
    return analysis.errors.some((e) => e.code === "exit_unpaired");
  }

  /** Conteneur que la route DEVRAIT encore atteindre pour desservir l'ancre `anchor`, ou `null` si
      elle l'atteint déjà (ou s'il n'y a rien à dire : pas d'ancre, ou route vide → tracé direct).
      C'est la « suggestion de fin » du carton §4.3 (« il manque l'exit de X pour rejoindre le bout B »). */
  static endGap(analysis: RouteAnalysis, anchor: PlacementContainer | null): PlacementContainer | null {
    if (!anchor || !analysis.steps.length) return null;
    const end = analysis.endContainer;
    return (end && PlacementContainers.same(end, anchor)) ? null : anchor;
  }

  /* ------------------------------------------------------------- insertion -- */

  /** La suite d'ids obtenue en insérant `id` à la position `at` (bornée). Point d'entrée UNIQUE de
      l'insertion : la sonde d'éligibilité et l'ajout réel doivent produire EXACTEMENT la même route,
      sans quoi le popover promettrait ce que l'ajout ne tiendrait pas. */
  static insertAt(ids: readonly string[], id: string, at?: number | null): string[] {
    const position = RouteEligibility.clampPosition(ids, at);
    const next = ids.slice();
    next.splice(position, 0, id);
    return next;
  }

  /** Position d'insertion effective : `null`/absente = FIN de route (le défaut du carton §4.2). */
  private static clampPosition(ids: readonly string[], at?: number | null): number {
    if (at == null || !isFinite(at)) return ids.length;
    return Math.max(0, Math.min(ids.length, Math.floor(at)));
  }

  /** ÉTAT de l'automate à la position d'insertion (analyse du PRÉFIXE). */
  static insertState(ids: readonly string[], analyze: RouteAnalyze, at?: number | null): RouteInsertState {
    return RouteEligibility.stateOf(analyze(ids.slice(0, RouteEligibility.clampPosition(ids, at))));
  }

  /** Conteneur de la DERNIÈRE étape `exit` d'une analyse.
      ⚠ APPROXIMATION ASSUMÉE du `quitte` interne de l'automate : les deux ne diffèrent que sur une
      route DÉJÀ fautive (un `exit_wrong_room` fait quitter le conteneur COURANT, pas celui de
      l'exit). Elle ne sert qu'à l'ÉTIQUETTE « salle quittée » et à l'ordre d'affichage — jamais à
      une règle d'éligibilité, qui passe, elle, par l'analyse. */
  private static lastExitContainer(analysis: RouteAnalysis): PlacementContainer | null {
    for (let i = analysis.steps.length - 1; i >= 0; i--) {
      if (analysis.steps[i].type === "exit") return analysis.steps[i].container;
    }
    return null;
  }

  /* ----------------------------------------------------------- éligibilité -- */

  /** CLASSE tous les candidats pour une position d'insertion, et les GROUPE par conteneur.

      Coût : UNE analyse par candidat quand on insère en FIN (le cas de L2), deux au milieu (il faut
      alors éprouver aussi la suite de la route). Les routes faisant 0 à 3 étapes et les documents
      quelques dizaines de waypoints, c'est sans conséquence — et c'est le prix de la certitude que
      le popover dit EXACTEMENT ce que dira la validation. */
  static plan(
    candidates: readonly RouteCandidate[],
    ids: readonly string[],
    analyze: RouteAnalyze,
    anchors: RouteAnchors,
    at?: number | null,
  ): RouteAddPlan {
    const position = RouteEligibility.clampPosition(ids, at);
    const head = ids.slice(0, position);
    const tail = ids.slice(position);
    const prefix = analyze(head);
    const prefixErrorCount = RouteEligibility.stepErrorsOf(prefix).length;
    const state = RouteEligibility.stateOf(prefix);
    // Référence pour la détection de casse EN AVAL : le compte d'erreurs d'étape de la route TELLE
    // QU'ELLE EST. Inutile (et non calculé) quand on insère en fin — il n'y a alors pas d'aval.
    const baseErrorCount = tail.length ? RouteEligibility.stepErrorsOf(analyze(ids)).length : prefixErrorCount;

    const verdicts = candidates.map((candidate) => RouteEligibility.judge(
      candidate, ids, head, tail, analyze, state, prefixErrorCount, baseErrorCount,
    ));
    const groups = RouteEligibility.group(verdicts, state, anchors);
    const flat: RouteVerdict[] = [];
    groups.forEach((g) => g.items.forEach((item) => flat.push(item)));
    return { state, groups, flat };
  }

  /** Verdict d'UN candidat. Les deux seuls jugements rendus SANS l'analyse sont ceux sur lesquels
      elle n'a rien à dire : un waypoint déjà présent (la route n'est pas un multi-ensemble — l'ancien
      nuage de cases l'interdisait déjà) et un waypoint non posé. */
  private static judge(
    candidate: RouteCandidate,
    ids: readonly string[],
    head: readonly string[],
    tail: readonly string[],
    analyze: RouteAnalyze,
    state: RouteInsertState,
    prefixErrorCount: number,
    baseErrorCount: number,
  ): RouteVerdict {
    if (ids.indexOf(candidate.id) >= 0) return { candidate, usable: false, reason: "already_in_route" };
    if (!candidate.placed) return { candidate, usable: false, reason: "unplaced" };

    // 1. L'étape INSÉRÉE elle-même : on analyse « préfixe + candidat ». Si le compte d'erreurs
    //    d'étape croît, la dernière est la sienne (cf. en-tête).
    const withCandidate = analyze(head.concat([candidate.id]));
    const ownErrors = RouteEligibility.stepErrorsOf(withCandidate);
    if (ownErrors.length > prefixErrorCount) {
      return { candidate, usable: false, reason: RouteEligibility.reasonOf(ownErrors[ownErrors.length - 1].code, state) };
    }
    // 2. L'AVAL (insertion au milieu seulement) : la route complète avec le candidat inséré ne doit
    //    pas porter PLUS d'erreurs d'étape qu'avant.
    //    ⚠ Limite assumée : une insertion qui EFFACERAIT une erreur aval tout en en créant une autre
    //    passerait au travers du comptage. Elle ne peut de toute façon pas mentir sur l'étape
    //    insérée (point 1). Ce chemin est EMPRUNTÉ depuis le lot L3 (le « + » d'interstice).
    if (tail.length) {
      const probe = analyze(head.concat([candidate.id], tail));
      if (RouteEligibility.stepErrorsOf(probe).length > baseErrorCount) {
        return { candidate, usable: false, reason: "breaks_route" };
      }
    }
    return { candidate, usable: true, reason: null };
  }

  /** Traduction CODE DE GRAMMAIRE → motif d'interface. Deux codes se dédoublent selon l'état, parce
      que l'automate les confond alors que l'utilisateur, lui, doit lire le mot juste (décision D4 du
      chantier « câblage des équipements d'étage ») : `room_wp_outside` dit « en transit » ou « sur un
      étage » selon d'où l'on parle. */
  private static reasonOf(code: RouteErrorCode, state: RouteInsertState): RouteBlockCode {
    switch (code) {
      case "unplaced": return "unplaced";
      case "floor_outside": return "floor_pin_in_room";
      case "room_wp_outside": return state.transit ? "in_transit" : "room_wp_on_floor";
      case "wrong_room": return "wrong_room";
      case "exit_wrong_room": return "exit_wrong_room";
      case "exit_reentry": return "exit_reentry";
      default: return "invalid_here";
    }
  }

  /* --------------------------------------------------------------- groupes -- */

  /** Groupe les verdicts par CONTENEUR (comparaison STRUCTURELLE — un étage n'a pas d'id, son
      identité est le couple bâtiment+étage), puis ordonne :
      - les GROUPES par pertinence, à égalité par ordre d'apparition (stable) ;
      - les ITEMS d'un groupe : EXITS d'abord (les articulations), puis l'ordre reçu. */
  private static group(
    verdicts: readonly RouteVerdict[],
    state: RouteInsertState,
    anchors: RouteAnchors,
  ): RouteGroup[] {
    const groups: RouteGroup[] = [];
    verdicts.forEach((verdict) => {
      const container = verdict.candidate.container;
      let group = groups.find((g) => RouteEligibility.sameGroup(g.container, container));
      if (!group) {
        group = { container, relevance: RouteEligibility.relevanceOf(container, state, anchors), items: [] };
        groups.push(group);
      }
      group.items.push(verdict);
    });
    groups.forEach((g) => { g.items = RouteEligibility.exitsFirst(g.items); });
    // Tri STABLE (`Array.prototype.sort` l'est depuis ES2019) : à pertinence égale, l'ordre
    // d'apparition — donc celui que l'appelant a choisi — est préservé.
    return groups.slice().sort((x, y) => RouteEligibility.rankOf(x.relevance) - RouteEligibility.rankOf(y.relevance));
  }

  /** Deux conteneurs forment-ils le MÊME groupe ? `same` répond `false` dès qu'un terme manque
      (c'est ce qu'on veut partout ailleurs) ; ici les candidats SANS conteneur doivent tout de même
      se retrouver ensemble, d'où le cas `null`/`null` traité à part. */
  private static sameGroup(a: PlacementContainer | null, b: PlacementContainer | null): boolean {
    if (!a || !b) return !a && !b;
    return PlacementContainers.same(a, b);
  }

  private static rankOf(relevance: RouteGroupRelevance): number {
    return RouteEligibility.RELEVANCE_RANK[relevance || "other"];
  }

  /** Étiquette de pertinence d'un conteneur. La « salle quittée » l'emporte sur « conteneur d'un
      bout » : c'est l'information qui explique un refus, alors que « bout A » n'explique rien de
      plus que ce que l'ancre affiche déjà. */
  private static relevanceOf(
    container: PlacementContainer | null,
    state: RouteInsertState,
    anchors: RouteAnchors,
  ): RouteGroupRelevance {
    if (!container) return null;
    if (state.container && PlacementContainers.same(container, state.container)) return "current";
    if (state.left && PlacementContainers.same(container, state.left)) return "left";
    const isA = !!anchors.a && PlacementContainers.same(container, anchors.a);
    const isB = !!anchors.b && PlacementContainers.same(container, anchors.b);
    if (isA && isB) return "endpoints";
    if (isA) return "endpointA";
    if (isB) return "endpointB";
    return null;
  }

  /** EXITS en tête, le reste dans l'ordre reçu (tri stable, aucun reclassement alphabétique — l'ordre
      d'entrée porte déjà les décisions de l'appelant, cf. la doctrine de `core/OptionSearch`). */
  private static exitsFirst(items: readonly RouteVerdict[]): RouteVerdict[] {
    return items.slice().sort((x, y) => (x.candidate.type === "exit" ? 0 : 1) - (y.candidate.type === "exit" ? 0 : 1));
  }
}
