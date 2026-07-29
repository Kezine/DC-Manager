/* =============================================================================
   CONTENEUR DE PLACEMENT — chaîne d'attache d'un contenu, PURE et partagée.
   Doctrine : `docs/placement.md`. TS PUR (ni DOM, ni Node) ; les collaborateurs
   sont INJECTÉS et non importés (patron `PowerAnalysis`), afin que ce module
   serve à la fois le client et la validation partagée sans dupliquer la règle.

   PRINCIPE — un contenu porte UNE SEULE référence : son conteneur IMMÉDIAT. Tous
   les ancêtres se déduisent en remontant la chaîne, jamais par une référence
   croisée vers un grand-parent (cf. doctrine §6.3).

       bâtiment  →  étage  →  salle  →  baie  →  étagère

   ÉTAT DE LA MIGRATION : ce module est BRANCHÉ. `Store.equipmentDcId` lui délègue
   (via `roomIdOf`), les libellés le lisent (`core/ContainerLabel`), les boutons
   « Localiser » aussi (`core/Locatable`), et depuis la doctrine §6.31 la GRAMMAIRE
   DE ROUTE (`store/CableRouteAnalyzer`) raisonne directement sur ses conteneurs.
   Chaque bascule a été faite APRÈS preuve de parité avec la règle historique,
   conformément à la méthode de vérification (doctrine §4.1).
   ============================================================================= */

/** Nature d'un conteneur. L'ordre reflète la hiérarchie, du plus large au plus fin. */
export type ContainerKind = "building" | "floor" | "room" | "rack" | "tray";

/** Conteneur de placement. UNION DISCRIMINÉE plutôt qu'un id composite : l'identité d'un ÉTAGE est le
    couple (bâtiment, étage) — un étage non configuré n'a pas d'enregistrement `floors`, il n'a donc pas
    d'id. Concaténer ce couple en une chaîne exigerait un séparateur, et le dépôt s'est déjà fait piéger
    par un séparateur NUL brut dans un littéral TS : on modélise le couple, on ne l'encode pas. */
export type PlacementContainer =
  | { kind: "building"; location: string }
  | { kind: "floor"; location: string; floor: string }
  | { kind: "room"; id: string }
  | { kind: "rack"; id: string }
  | { kind: "tray"; id: string };

/** Lecture d'un enregistrement par collection (injectée — aucun import de store ici). */
export type ContainerFetcher = (collection: string, id: string | null | undefined) => Record<string, any> | null | undefined;

export class PlacementContainers {
  /** Garde de profondeur : une chaîne de conteneurs ne peut pas dépasser bâtiment→étage→salle→baie→étagère.
      Protège d'un cycle de références (baie dont la salle pointerait vers elle, données corrompues…). */
  static readonly MAX_DEPTH = 8;

  /** Étage d'un enregistrement, en préservant l'étage « 0 ».
      ⚠ Le dépôt emploie DEUX conventions : `String(x || "")`, qui écrase le rez-de-chaussée (`0` → `""`),
      et `String(x == null ? "" : x)`, qui le préserve. On retient la seconde — la seule correcte — et
      l'unification des sites historiques reste à faire. */
  private static floorKey(v: unknown): string { return String(v == null ? "" : v); }

  /** Conteneur ÉTAGE construit depuis le couple (bâtiment, étage) — POINT D'ENTRÉE UNIQUE de la
      fabrication d'une clé d'étage, pour tout site qui tient ce couple en main (un enregistrement
      d'équipement, un pin d'étage, une salle…).

      ⚠ POURQUOI UNE FABRIQUE PLUTÔT QU'UN LITTÉRAL. `floorKey` est privée, et c'est délibéré : la
      seule façon correcte d'écrire la clé doit être la seule DISPONIBLE. Le dépôt s'est fait prendre
      deux fois au même endroit — `CableRouteAnalyzer.equipmentContext` ENCODAIT le couple en chaîne
      (« floor:<bâtiment>:<étage> ») ET employait `String(x || "")`, qui écrase le rez-de-chaussée
      (`0` → `""`) et confond donc l'étage 0 avec l'étage « vide ». Les deux défauts n'en faisaient
      qu'un : là où l'on RECOPIE la construction d'une identité, on finit par la construire de
      travers (doctrine §6.31). */
  static floorOf(location: unknown, floor: unknown): PlacementContainer {
    return { kind: "floor", location: String(location || ""), floor: PlacementContainers.floorKey(floor) };
  }

  /** Conteneur IMMÉDIAT d'un équipement, ou null s'il n'est attaché à rien de localisable (« pool »).

      ⚠ L'ORDRE des cas est SIGNIFIANT et réplique exactement `Store.equipmentDcId` :
      — l'étagère DOIT précéder le repli « libre », car un équipement posé est `dim_mode: "free"` mais
        n'a pas de `dc_id` (il est rattaché par `tray_item_id`) ; l'inverse le rendrait « non placé » et
        un câble vers lui resterait bloqué à « planifié » ;
      — un équipement en mode `rack` AVEC `rack_id` mais SANS `rack_u` n'est PAS dans la baie : il est
        dans son POOL, et n'a donc volontairement aucun conteneur localisable. */
  static of(eq: Record<string, any> | null | undefined): PlacementContainer | null {
    if (!eq) return null;
    if (eq.placement_mode === "floor") return PlacementContainers.floorOf(eq.location, eq.floor);
    if ((eq.placement_mode === "side" || eq.placement_mode === "wall") && eq.rack_id) return { kind: "rack", id: String(eq.rack_id) };
    if (eq.placement_mode === "tray" && eq.tray_item_id) return { kind: "tray", id: String(eq.tray_item_id) };
    if (eq.dim_mode === "free") return eq.dc_id ? { kind: "room", id: String(eq.dc_id) } : null;
    if (eq.placement_mode === "rack" && eq.rack_id && eq.rack_u != null) return { kind: "rack", id: String(eq.rack_id) };
    return null;
  }

  /** Conteneur PARENT, d'un cran. null = racine atteinte, ou chaîne rompue (référence pendante).

      Une baie SANS salle n'est pas « nulle part » : elle est rattachée au BÂTIMENT (doctrine §6.3), ce
      qui fait disparaître l'état spécial « non placé ». La parité avec la règle historique est
      préservée puisqu'aucune SALLE n'apparaît alors dans la chaîne. */
  static parentOf(container: PlacementContainer | null | undefined, fetch: ContainerFetcher): PlacementContainer | null {
    if (!container) return null;
    if (container.kind === "tray") {
      const tray = fetch("rackItems", container.id);
      return tray && tray.rack_id ? { kind: "rack", id: String(tray.rack_id) } : null;
    }
    if (container.kind === "rack") {
      const rack = fetch("racks", container.id);
      if (!rack) return null;
      if (rack.datacenter_id) return { kind: "room", id: String(rack.datacenter_id) };
      return { kind: "building", location: rack.location || "" };
    }
    if (container.kind === "room") {
      const dc = fetch("datacenters", container.id);
      if (!dc) return null;
      return PlacementContainers.floorOf(dc.location, dc.floor);
    }
    if (container.kind === "floor") return { kind: "building", location: container.location };
    return null;   // building = racine
  }

  /** Chaîne complète, du conteneur IMMÉDIAT à la racine (bornée par MAX_DEPTH). Vide = rien de localisable. */
  static chain(eq: Record<string, any> | null | undefined, fetch: ContainerFetcher): PlacementContainer[] {
    const out: PlacementContainer[] = [];
    let cur = PlacementContainers.of(eq);
    let depth = 0;
    while (cur && depth++ < PlacementContainers.MAX_DEPTH) { out.push(cur); cur = PlacementContainers.parentOf(cur, fetch); }
    return out;
  }

  /** Salle de la chaîne, ou null si le contenu n'en traverse aucune (posé sur un étage, en pool, baie hors
      salle…). REMPLACERA `Store.equipmentDcId` une fois la parité prouvée puis l'ancien chemin retiré. */
  static roomIdOf(eq: Record<string, any> | null | undefined, fetch: ContainerFetcher): string | null {
    const room = PlacementContainers.chain(eq, fetch).find((c) => c.kind === "room");
    return room && room.kind === "room" ? room.id : null;
  }

  /** Deux conteneurs désignent-ils le MÊME ? (comparaison structurelle — cf. l'union discriminée). */
  static same(a: PlacementContainer | null | undefined, b: PlacementContainer | null | undefined): boolean {
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === "floor" && b.kind === "floor") return a.location === b.location && a.floor === b.floor;
    if (a.kind === "building" && b.kind === "building") return a.location === b.location;
    return (a as { id: string }).id === (b as { id: string }).id;
  }

  /** Y a-t-il une TRANSITION de conteneur entre `a` et `b` ? (rendu inversé : `true` = pas de transition.)

      ⚠ CE N'EST PAS `same`, ET LA NUANCE EST LE PIÈGE DU CHANTIER. `same(null, null)` rend `false`,
      à raison : l'absence de conteneur n'est pas un conteneur commun, et deux objets non placés ne
      sont pas « au même endroit ». Mais la question que posent les PARCOURS (le regroupement en
      bandes du mini-graphe de tracé, le résumé textuel d'une route) n'est pas celle-là : c'est
      « franchit-on une frontière entre ces deux étapes ? », et deux étapes hors conteneur
      consécutives n'en franchissent aucune. C'est exactement ce que rendait l'expression historique
      `a.roomId !== b.roomId` sur deux `null` ; s'en remettre à `same` seul insérerait une bande, une
      respiration et un séparateur ENTRE DEUX WAYPOINTS NON POSÉS de documents existants.

      La règle a d'abord vécu dans `RouteGraphLayout.sameContainer` (doctrine §6.29, un seul
      consommateur) ; la grammaire de route en est devenue le second (§6.31), ce qui la fait
      descendre ici — auprès de `same`, dont elle n'est qu'une variante, plutôt que recopiée. */
  static sameOrNone(a: PlacementContainer | null | undefined, b: PlacementContainer | null | undefined): boolean {
    if (!a && !b) return true;
    return PlacementContainers.same(a, b);
  }
}
