/* =============================================================================
   LAYOUT du MINI-GRAPHE de TRACÉ (fiches détail câble/faisceau) — géométrie
   PURE (aucun DOM, aucun accès Store) : abscisses des nœuds, bandes de salles,
   échelle de hauteur du mode « profil ». Le rendu SVG vit dans
   `views/RouteMiniGraph.ts` (séparation calcul/rendu — principe n°2, testable
   en isolation dans Tests/modules/test-geometry.js).

   Deux dispositions sur les MÊMES abscisses (la bascule chaîne ⇄ profil ne
   déplace pas les nœuds horizontalement, l'œil garde ses repères) :
   - CHAÎNE  : tous les nœuds sur une ligne de base, bandes de salles en
     arrière-plan (regroupement des nœuds consécutifs d'une même salle) ;
   - PROFIL  : l'ordonnée encode la hauteur `dc_z` (mm). ATTENTION : `dc_z` est
     RELATIF à la dalle de la salle (ou de l'étage du pin) — une route
     multi-étages empile donc UN RÉFÉRENTIEL PAR ÉTAGE traversé (une dalle par
     étage, zone faux-plancher sous chacune), avec une échelle z COMMUNE ;
     l'écart vertical ENTRE étages est schématique (pas à l'échelle).
   ============================================================================= */

/** Nœud d'entrée du layout — DÉJÀ résolu par l'appelant (aucune FK ici). */
export interface RouteGraphNode {
  /** Extrémité (boîte large, style nœud de GraphView) plutôt que waypoint (pastille). */
  endpoint?: boolean;
  /** Salle du nœud (null = hors salle : pin d'étage, waypoint non posé). */
  roomId: string | null;
  /** Nom de salle résolu ("" si hors salle). */
  roomLabel: string;
  /** Hauteur (mm) — null = inconnue (extrémités : la hauteur exacte du port n'est pas résolue ici). */
  z: number | null;
  /** Étage du nœud (numérique, convention Waypoint.floorLabel : étage vide/libre → 0) —
      étage de la SALLE pour un waypoint/extrémité de salle, `floor` du pin d'étage sinon ;
      null = inconnu (non posé) → hérité du plus proche voisin renseigné. */
  level?: number | null;
}

/** Bande de salle : nœuds consécutifs [from..to] d'une même salle + emprise X. */
export interface RouteRoomBand { from: number; to: number; label: string; x0: number; x1: number }

export interface RouteChainLayout {
  xs: number[]; cy: number; width: number; height: number; bands: RouteRoomBand[];
}
/** Référentiel d'UN étage traversé : sa dalle (z = 0 local) et son emprise. */
export interface RouteProfileFloor {
  level: number;
  /** Ordonnée de la dalle de CET étage. */
  y: number;
  /** Emprise horizontale des nœuds de cet étage (dalle + zone faux-plancher dessinées dessus). */
  x0: number; x1: number;
  /** Bas de la tranche verticale de l'étage (limite de la zone faux-plancher). */
  yBottom: number;
  /** Au moins un nœud de cet étage SOUS sa dalle (z < 0) → afficher « faux-plancher ». */
  hasUnderfloor: boolean;
}
export interface RouteProfileLayout {
  xs: number[]; ys: number[]; width: number; height: number;
  /** Une entrée PAR ÉTAGE traversé, niveaux croissants (bas → haut). */
  floors: RouteProfileFloor[];
  /** Route multi-étages (habillage des libellés de dalle au rendu). */
  multiFloor: boolean;
  /** Nœud à z inconnue → ordonnée HÉRITÉE du plus proche voisin renseigné (amorce pointillée au rendu). */
  snapped: boolean[];
  bands: RouteRoomBand[];
  /** Abscisses des séparateurs verticaux (changement de salle entre deux nœuds consécutifs). */
  separators: number[];
}

/** Constantes de dessin (px SVG) — partagées avec le rendu pour ancrer arêtes et bandes. */
export const ROUTE_GRAPH = {
  EP_W: 118, EP_H: 40,          // boîte d'extrémité
  WP_R: 13,                     // rayon d'une pastille waypoint
  GAP_EP: 118,                  // écart de centres autour d'une extrémité
  GAP_WP: 92,                   // écart de centres entre deux waypoints
  GAP_ROOM: 18,                 // respiration supplémentaire au changement de salle
  PAD_X: 84,                    // marge horizontale (≥ demi-boîte + débord de bande)
  BAND_PAD: 16,                 // débord de bande autour des nœuds extrêmes
  CHAIN_H: 150, CHAIN_CY: 84,   // chaîne : hauteur totale, ligne de base
  BAND_TOP: 26, BAND_H: 106,    // chaîne : emprise verticale des bandes
  PROF_H: 200, PROF_TOP: 30, PROF_BOT: 24,   // profil : hauteur totale (UN étage), marges haut/bas
  PROF_FLOOR_EXTRA: 76,                      // profil : tracé supplémentaire par étage traversé EN PLUS
  PROF_FLOOR_GAP: 26,                        // profil : interstice vertical entre deux étages empilés
  Z_FLOOR_MIN: -160, Z_CEIL_MIN: 400,        // profil : amplitude minimale garantie (mm) autour de chaque dalle
} as const;

export class RouteGraphLayout {
  /** Demi-largeur d'un nœud (ancrage des arêtes et débord des bandes). */
  static halfWidth(node: RouteGraphNode): number {
    return node.endpoint ? ROUTE_GRAPH.EP_W / 2 : ROUTE_GRAPH.WP_R;
  }

  /** Abscisses des centres : écart large autour des extrémités, resserré entre waypoints,
      respiration supplémentaire au changement de salle (bande suivante décollée). */
  static xPositions(nodes: RouteGraphNode[]): number[] {
    const xs: number[] = [];
    let x = ROUTE_GRAPH.PAD_X;
    for (let i = 0; i < nodes.length; i++) {
      if (i > 0) {
        const a = nodes[i - 1], b = nodes[i];
        let gap = (a.endpoint || b.endpoint) ? ROUTE_GRAPH.GAP_EP : ROUTE_GRAPH.GAP_WP;
        if (a.roomId !== b.roomId) gap += ROUTE_GRAPH.GAP_ROOM;
        x += gap;
      }
      xs.push(x);
    }
    return xs;
  }

  /** Bandes de salles : groupes de nœuds CONSÉCUTIFS d'une même salle (roomId non null).
      Un nœud hors salle (pin d'étage, non posé) COUPE la bande — deux passages dans une
      même salle donnent deux bandes distinctes (pas de fusion à travers un tronçon). */
  static bands(nodes: RouteGraphNode[], xs: number[]): RouteRoomBand[] {
    const out: RouteRoomBand[] = [];
    let cur: RouteRoomBand | null = null;
    nodes.forEach((n, i) => {
      if (!n.roomId) { cur = null; return; }
      if (cur && nodes[cur.to].roomId === n.roomId) { cur.to = i; }
      else { cur = { from: i, to: i, label: n.roomLabel, x0: 0, x1: 0 }; out.push(cur); }
    });
    out.forEach((b) => {
      b.x0 = xs[b.from] - this.halfWidth(nodes[b.from]) - ROUTE_GRAPH.BAND_PAD;
      b.x1 = xs[b.to] + this.halfWidth(nodes[b.to]) + ROUTE_GRAPH.BAND_PAD;
    });
    return out;
  }

  /** Disposition CHAÎNE : nœuds sur une ligne de base, bandes de salles en fond. */
  static chain(nodes: RouteGraphNode[]): RouteChainLayout {
    const xs = this.xPositions(nodes);
    return {
      xs, cy: ROUTE_GRAPH.CHAIN_CY,
      width: (xs.length ? xs[xs.length - 1] : 0) + ROUTE_GRAPH.PAD_X,
      height: ROUTE_GRAPH.CHAIN_H,
      bands: this.bands(nodes, xs),
    };
  }

  /** Valeur inconnue (null) → celle du plus proche voisin renseigné (le précédent en cas
      d'égalité de distance), `fallback` si aucun. Sert aux z ET aux étages des nœuds
      non renseignés (extrémités, waypoints non posés). */
  private static inheritNearest(vals: Array<number | null>, fallback: number): number[] {
    return vals.map((v, i) => {
      if (v != null) return v;
      for (let d = 1; d < vals.length; d++) {
        const prev = vals[i - d], next = vals[i + d];
        if (prev != null) return prev;
        if (next != null) return next;
      }
      return fallback;
    });
  }

  /** Disposition PROFIL : l'ordonnée encode la hauteur (mm) DANS le référentiel de l'étage
      du nœud (`dc_z` est relatif à la dalle de sa salle). Les étages traversés sont EMPILÉS
      de bas en haut avec une échelle z COMMUNE ; l'amplitude de chaque étage est bornée a
      minima ([Z_FLOOR_MIN, Z_CEIL_MIN]) pour que sa dalle reste lisible même sur un tracé
      plat, et la hauteur totale s'étend avec le nombre d'étages. */
  static profile(nodes: RouteGraphNode[]): RouteProfileLayout {
    const xs = this.xPositions(nodes);
    const zs = nodes.map((n) => (n.z != null && isFinite(n.z) ? n.z : null));
    const lvs = nodes.map((n) => (n.level != null && isFinite(n.level) ? n.level : null));
    const snapped = zs.map((z) => z == null);
    const resolvedZ = this.inheritNearest(zs, 0);
    const resolvedLv = this.inheritNearest(lvs, 0);

    // étages traversés (niveaux croissants) + amplitude z PROPRE à chacun
    const levels = Array.from(new Set(resolvedLv)).sort((a, b) => a - b);
    const spanOf = new Map<number, { lo: number; hi: number }>();
    levels.forEach((L) => {
      const real = zs.filter((z, i) => z != null && resolvedLv[i] === L) as number[];
      spanOf.set(L, { lo: Math.min(ROUTE_GRAPH.Z_FLOOR_MIN, ...real), hi: Math.max(ROUTE_GRAPH.Z_CEIL_MIN, ...real) });
    });

    // hauteur de tracé : base d'un étage + extension par étage supplémentaire ; échelle k COMMUNE
    // à tous les étages (les pentes restent comparables d'un étage à l'autre)
    const gaps = ROUTE_GRAPH.PROF_FLOOR_GAP * (levels.length - 1);
    const plotH = (ROUTE_GRAPH.PROF_H - ROUTE_GRAPH.PROF_TOP - ROUTE_GRAPH.PROF_BOT)
      + ROUTE_GRAPH.PROF_FLOOR_EXTRA * (levels.length - 1);
    const height = ROUTE_GRAPH.PROF_TOP + plotH + ROUTE_GRAPH.PROF_BOT;
    const totalSpan = levels.reduce((s, L) => s + (spanOf.get(L)!.hi - spanOf.get(L)!.lo), 0);
    const k = (plotH - gaps) / totalSpan;

    // empilement de bas en haut : chaque étage occupe sa tranche [yBottom − span·k, yBottom]
    const bandBottom = new Map<number, number>();
    let cursor = ROUTE_GRAPH.PROF_TOP + plotH;
    levels.forEach((L) => {
      bandBottom.set(L, cursor);
      cursor -= (spanOf.get(L)!.hi - spanOf.get(L)!.lo) * k + ROUTE_GRAPH.PROF_FLOOR_GAP;
    });
    const yOf = (z: number, L: number) => bandBottom.get(L)! - (z - spanOf.get(L)!.lo) * k;

    const floors: RouteProfileFloor[] = levels.map((L) => {
      const idxs = nodes.map((_, i) => i).filter((i) => resolvedLv[i] === L);
      return {
        level: L,
        y: yOf(0, L),
        x0: Math.min(...idxs.map((i) => xs[i] - this.halfWidth(nodes[i]))) - ROUTE_GRAPH.BAND_PAD,
        x1: Math.max(...idxs.map((i) => xs[i] + this.halfWidth(nodes[i]))) + ROUTE_GRAPH.BAND_PAD,
        yBottom: bandBottom.get(L)!,
        hasUnderfloor: zs.some((z, i) => z != null && z < 0 && resolvedLv[i] === L),
      };
    });

    const separators: number[] = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      if (nodes[i].roomId !== nodes[i + 1].roomId) separators.push((xs[i] + xs[i + 1]) / 2);
    }
    return {
      xs, ys: resolvedZ.map((z, i) => yOf(z, resolvedLv[i])),
      width: (xs.length ? xs[xs.length - 1] : 0) + ROUTE_GRAPH.PAD_X,
      height,
      floors,
      multiFloor: levels.length > 1,
      snapped,
      bands: this.bands(nodes, xs),
      separators,
    };
  }
}
