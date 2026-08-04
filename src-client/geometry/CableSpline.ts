/* =============================================================================
   Tracé PUR des câbles/faisceaux (2D ⇄ 3D) : calcul des courbes + échantillonnage en polyligne
   dense — même mécanique que le tracé SVG, réutilisée par le moteur 3D. Sans DOM, ni scène,
   ni THREE (points simples {x,y,z}) → testable en isolation. Extrait de DcThreeScene (n°11).

   • Les segments listés dans `straight` restent des CHORDES DROITES (corps de conduit / amorces ⊥).
   • Aux points d'amorce `stubAt` (sortie ⟂), la tangente est IMPOSÉE = axe du segment droit adjacent
     (continuité G1 → la courbe part/arrive dans l'axe, aucun « kink », la sortie reste perpendiculaire).
   • Contrôles intérieurs : Catmull-Rom C1 = P[i] + (P[i+1] − P[i−1])·k, densité ~1 point / 5 mm.

   TROIS STYLES de tracé (sélecteur « Style des câbles », décision 2026-08-04 — cf. le diagnostic de
   l'« inertie » après waypoint : la tangente uniforme (P[i+1]−P[i−1])·k n'est JAMAIS bornée par le
   segment local, donc elle déborde sur segments inégaux) :
   • "spline"      — l'algo HISTORIQUE (Catmull-Rom uniforme), conservé BIT-IDENTIQUE (goldens) ;
   • "centripetal" — même allure, tangentes normalisées par les RACINES des distances (α = 0.5) :
                     plus de dépassement sur segments inégaux (`controlsCentripetal`) ;
   • "fillet"      — CORDES DROITES + CONGÉS bornés aux coins (`fillets`) : zéro influence au-delà
                     du coin, par construction — le style par DÉFAUT.
   ============================================================================= */
export interface SplinePt { x: number; y: number; z: number }

/** Styles de tracé d'un câble/faisceau — partagés 2D ⇄ 3D et câbles ⇄ faisceaux (TOUT le calcul vit ici,
    les rendus ne font que sérialiser en path SVG ou densifier en polyligne). */
export type CableCurveStyle = "spline" | "centripetal" | "fillet";

/** Primitive du style « cordes arrondies » : droite (p→q) ou coin (Bézier cubique p→q approximant un
    arc de cercle de rayon r). Les primitives s'ENCHAÎNENT (le q d'une primitive = le p de la suivante,
    la première part de P[0], la dernière arrive à P[n−1]) — le rendu 2D les sérialise en L/C, le rendu
    3D les échantillonne (`sampleFillet`). */
export type FilletPrimitive =
  | { kind: "line"; p: number[]; q: number[] }
  | { kind: "corner"; p: number[]; c1: number[]; c2: number[]; q: number[]; r: number };

/** Rayon MAXIMAL d'un congé par unité de tension (mm par unité de `k`) : le slider « Arrondi des
    câbles » (0 → 0.32, défaut 1/6) pilote AUSSI le style « cordes arrondies » — r_max = k · cette
    constante, soit 150 mm au défaut (un coude net mais lisible à l'échelle d'une salle) et ~288 mm en
    butée du slider. k = 0 → r_max = 0 → polyligne en cordes PURES, parité avec les styles spline où
    k = 0 annule aussi toutes les poignées. */
export const FILLET_RADIUS_PER_K_MM = 900;

export class CableSpline {
  /* ---- petites algèbres PARTAGÉES par les trois styles (dimension-agnostiques : 2D h/v · 3D x/y/z) ---- */
  private static sub(a: number[], b: number[]): number[] { return a.map((v, d) => v - b[d]); }
  private static len(v: number[]): number { return Math.hypot(...v); }
  private static unit(a: number[], b: number[]): number[] { const d = CableSpline.sub(b, a), L = CableSpline.len(d) || 1; return d.map((v) => v / L); }
  private static copyPt(p: SplinePt): SplinePt { return { x: p.x, y: p.y, z: p.z }; }

  /** Direction d'amorce IMPOSÉE au point i = axe de SON segment droit adjacent (G1 avec le segment
      droit) — null si i n'est pas un point d'amorce. Partagée par les deux splines : la sortie ⟂ des
      ports est un invariant de ROUTAGE, pas une affaire de style. */
  private static stubDirAt(P: number[][], i: number, straight: Set<number> | undefined, stubAt: Set<number> | undefined): number[] | null {
    const isStraight = (j: number) => !!(straight && straight.has(j));
    if (!stubAt || !stubAt.has(i)) return null;
    if (isStraight(i)) return CableSpline.unit(P[i], P[i + 1]);              // segment droit APRÈS i
    if (i > 0 && isStraight(i - 1)) return CableSpline.unit(P[i - 1], P[i]); // segment droit AVANT i
    return null;
  }

  /** Points de contrôle Bézier PAR SEGMENT (null = segment laissé droit), pour un polyligne de dimension
      QUELCONQUE (2D h/v du tracé SVG · 3D x/y/z de l'échantillonnage) — LE calcul de tangentes vit ici,
      UNE seule fois, pour les deux moteurs (auparavant dupliqué dans DcScene3D.cablePath) :
      • amorce ⟂ (`stubAt`) : tangente IMPOSÉE le long du segment droit adjacent (continuité G1) ;
      • point intérieur : Catmull-Rom C1 = (P[i+1] − P[i−1])·k.
      ⚠ Style « spline » historique : conservé BIT-IDENTIQUE (goldens de test-geometry.js) — toute
      évolution passe par un NOUVEAU style, jamais par une retouche ici. */
  static controls(P: number[][], straight: Set<number> | undefined, k: number, stubAt?: Set<number>): Array<{ c1: number[]; c2: number[] } | null> {
    const n = P.length, hk = k * 2.5;
    const isStraight = (i: number) => !!(straight && straight.has(i));
    const tan = (i: number, segLen: number): number[] => {
      const d = CableSpline.stubDirAt(P, i, straight, stubAt);
      if (d) return d.map((v) => v * segLen * hk);                 // amorce : alignée sur l'axe
      const p0 = P[Math.max(0, i - 1)], p1 = P[Math.min(n - 1, i + 1)];
      return CableSpline.sub(p1, p0).map((v) => v * k);            // intérieur : Catmull-Rom
    };
    const out: Array<{ c1: number[]; c2: number[] } | null> = [];
    for (let i = 0; i < n - 1; i++) {
      if (isStraight(i)) { out.push(null); continue; }
      const segLen = CableSpline.len(CableSpline.sub(P[i + 1], P[i]));
      const t1 = tan(i, segLen), t2 = tan(i + 1, segLen);
      out.push({ c1: P[i].map((v, d) => v + t1[d]), c2: P[i + 1].map((v, d) => v - t2[d]) });
    }
    return out;
  }

  /** Variante CENTRIPÈTE (α = 0.5) de `controls()` — MÊME contrat de sortie ({c1,c2}|null par segment),
      donc les deux rendus la consomment sans changement. Le Catmull-Rom UNIFORME norme la tangente
      intérieure sur la corde COMPLÈTE entre les deux voisins ((P[i+1]−P[i−1])·k), jamais bornée par le
      segment local : sur des segments inégaux, le point de contrôle est projeté au-delà du point suivant
      (dépassement + ondulation après un waypoint — l'« inertie » constatée). La paramétrisation
      centripète pondère chaque voisin par la RACINE de sa distance (nœuds t_i basés sur d_i^0.5,
      conversion Catmull-Rom → Bézier standard) : poignées bornées par le segment local, pas de boucle ni
      de dépassement (propriété démontrée du centripète).
      `k` reste la tension du slider : les poignées standard sont multipliées par 6k — à k = 1/6
      (défaut), c'est EXACTEMENT la paramétrisation centripète canonique, et à espacement ÉGAL le
      résultat rejoint l'uniforme (mêmes poignées (P[i+1]−P[i−1])·k) ; k = 0 → poignées nulles (cordes
      droites, parité avec les deux autres styles). Amorces ⟂ : même direction IMPOSÉE que l'uniforme. */
  static controlsCentripetal(P: number[][], straight: Set<number> | undefined, k: number, stubAt?: Set<number>): Array<{ c1: number[]; c2: number[] } | null> {
    const n = P.length, hk = k * 2.5, gain = 6 * k;   // gain 6k : poignée standard = 1/6 → le slider garde sa sémantique
    const EPS = 1e-9;
    const isStraight = (i: number) => !!(straight && straight.has(i));
    const out: Array<{ c1: number[]; c2: number[] } | null> = [];
    for (let i = 0; i < n - 1; i++) {
      if (isStraight(i)) { out.push(null); continue; }
      const A = P[i], B = P[i + 1];
      const prev = P[Math.max(0, i - 1)], next = P[Math.min(n - 1, i + 2)];
      const segLen = CableSpline.len(CableSpline.sub(B, A));
      // nœuds par d^α (α = 0.5) : racines des longueurs des trois cordes voisines du segment
      const d1 = Math.sqrt(CableSpline.len(CableSpline.sub(A, prev)));
      const d2 = Math.sqrt(segLen);
      const d3 = Math.sqrt(CableSpline.len(CableSpline.sub(next, B)));
      const sd1 = CableSpline.stubDirAt(P, i, straight, stubAt);
      const sd2 = CableSpline.stubDirAt(P, i + 1, straight, stubAt);
      // Poignée au DÉPART du segment (en A) : conversion CR→Bézier standard
      //   B1 = (d1²·B − d2²·prev + (2d1² + 3d1d2 + d2²)·A) / (3d1(d1 + d2)) ; poignée = (B1 − A)·gain.
      // Extrémité de polyligne / segment quasi nul (d ≈ 0) → repli sur la corde ·k, exactement le
      // comportement de l'uniforme aux extrémités (tan y vaut (P[1]−P[0])·k).
      let h1: number[], h2: number[];
      if (sd1) h1 = sd1.map((v) => v * segLen * hk);   // amorce : alignée sur l'axe (identique à l'uniforme)
      else if (d1 < EPS || d2 < EPS) h1 = CableSpline.sub(B, A).map((v) => v * k);
      else {
        const den = 3 * d1 * (d1 + d2), w = 2 * d1 * d1 + 3 * d1 * d2 + d2 * d2;
        h1 = A.map((av, d) => ((d1 * d1 * B[d] - d2 * d2 * prev[d] + w * av) / den - av) * gain);
      }
      // Poignée à l'ARRIVÉE du segment (en B) : symétrique, avec le voisin SUIVANT
      //   B2 = (d3²·A − d2²·next + (2d3² + 3d3d2 + d2²)·B) / (3d3(d3 + d2)) ; poignée = (B − B2)·gain.
      if (sd2) h2 = sd2.map((v) => v * segLen * hk);
      else if (d3 < EPS || d2 < EPS) h2 = CableSpline.sub(B, A).map((v) => v * k);
      else {
        const den = 3 * d3 * (d3 + d2), w = 2 * d3 * d3 + 3 * d3 * d2 + d2 * d2;
        h2 = B.map((bv, d) => (bv - (d3 * d3 * A[d] - d2 * d2 * next[d] + w * bv) / den) * gain);
      }
      out.push({ c1: A.map((v, d) => v + h1[d]), c2: B.map((v, d) => v - h2[d]) });
    }
    return out;
  }

  /** Séquence de PRIMITIVES du style « cordes arrondies » : entre les waypoints, la CORDE DROITE ; à
      chaque coin intérieur, un CONGÉ (arc de cercle approximé par UNE Bézier cubique) de rayon borné
      r = min(r_max, 45 % du plus court des 2 segments adjacents), avec r_max = k · FILLET_RADIUS_PER_K_MM.
      Zéro influence au-delà du coin, PAR CONSTRUCTION — la réponse littérale à l'« inertie » du
      Catmull-Rom. Dimension-agnostique (2D h/v du SVG · 3D x/y/z). Règles :
      • segment de `straight` (corps de conduit) : JAMAIS entamé — pas de congé à ses coins…
      • …SAUF au point d'AMORCE (`stubAt`) : le congé se fait À LA JONCTION, et son recul (≤ 45 % de
        l'amorce de 20 mm, soit ≤ 9 mm) préserve l'axe ⟂ au port sur le reste de l'amorce ;
      • coin colinéaire / demi-tour exact / segment quasi nul → coin FRANC (aucune primitive coin) ;
      • deux congés voisins d'un même segment ne se chevauchent jamais (45 % + 45 % < 100 %). */
  static fillets(P: number[][], straight: Set<number> | undefined, k: number, stubAt?: Set<number>): FilletPrimitive[] {
    const n = P.length, out: FilletPrimitive[] = [];
    if (n < 2) return out;
    const rMax = k * FILLET_RADIUS_PER_K_MM;
    const EPS = 1e-6;
    const isStraight = (i: number) => !!(straight && straight.has(i));
    // congé éventuel au point INTÉRIEUR j (entre les segments j−1 et j)
    const cornerAt = (j: number): { p: number[]; c1: number[]; c2: number[]; q: number[]; r: number } | null => {
      if (rMax <= EPS) return null;   // k = 0 → cordes pures (parité avec les splines à poignées nulles)
      if ((isStraight(j - 1) || isStraight(j)) && !(stubAt && stubAt.has(j))) return null;   // conduit : jamais entamé (hors jonction d'amorce)
      const A = P[j - 1], Q = P[j], B = P[j + 1];
      const lin = CableSpline.len(CableSpline.sub(Q, A)), lout = CableSpline.len(CableSpline.sub(B, Q));
      if (lin < EPS || lout < EPS) return null;   // segment quasi nul → dégénéré, coin franc
      const u = CableSpline.sub(Q, A).map((v) => v / lin);    // direction ENTRANTE
      const w = CableSpline.sub(B, Q).map((v) => v / lout);   // direction SORTANTE
      const cos = Math.max(-1, Math.min(1, u.reduce((s, v, d) => s + v * w[d], 0)));
      const theta = Math.acos(cos);   // angle de VIRAGE (0 = tout droit)
      if (theta < 1e-4 || Math.PI - theta < 1e-4) return null;   // colinéaire (rien à arrondir) / demi-tour (aucun plan du congé)
      // Rayon borné par le plus court des deux segments, PUIS par le RECUL : le point de tangence
      // recule de T = r·tan(θ/2) depuis le coin — sur un coin très fermé, c'est T qu'il faut contenir
      // dans le segment, sinon deux congés voisins se chevaucheraient malgré la borne sur r.
      const maxSetback = 0.45 * Math.min(lin, lout);
      let r = Math.min(rMax, maxSetback);
      let T = r * Math.tan(theta / 2);
      if (T > maxSetback) { T = maxSetback; r = T / Math.tan(theta / 2); }
      if (r < EPS) return null;
      const p = Q.map((v, d) => v - u[d] * T);   // début d'arc, sur le segment entrant
      const q = Q.map((v, d) => v + w[d] * T);   // fin d'arc, sur le segment sortant
      // UNE Bézier cubique ≈ arc de cercle : poignées TANGENTES de longueur h = (4/3)·tan(θ/4)·r
      // (la formule standard d'approximation d'arc — erreur radiale < 0,03 % jusqu'à 90°).
      const h = (4 / 3) * Math.tan(theta / 4) * r;
      return { p, c1: p.map((v, d) => v + u[d] * h), c2: q.map((v, d) => v - w[d] * h), q, r };
    };
    let start = P[0];
    for (let i = 0; i < n - 1; i++) {
      const c = i + 1 < n - 1 ? cornerAt(i + 1) : null;
      out.push({ kind: "line", p: start, q: c ? c.p : P[i + 1] });
      if (c) { out.push({ kind: "corner", p: c.p, c1: c.c1, c2: c.c2, q: c.q, r: c.r }); start = c.q; }
      else start = P[i + 1];
    }
    return out;
  }

  /** Densifie une polyligne en suivant des contrôles Bézier par segment (cf. `controls` /
      `controlsCentripetal`) : la MÊME évaluation cubique pour les deux splines — `sample()` historique
      délègue ici à l'identique (extraction sans changement de calcul, goldens intacts). */
  private static densify(P: SplinePt[], ctrls: Array<{ c1: number[]; c2: number[] } | null>): SplinePt[] {
    const out: SplinePt[] = [CableSpline.copyPt(P[0])];
    for (let i = 0; i < P.length - 1; i++) {
      const p1 = P[i], p2 = P[i + 1], c = ctrls[i];
      if (!c) { out.push(CableSpline.copyPt(p2)); continue; }   // chorde droite (corps de conduit / amorce ⟂)
      const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
      const c1: SplinePt = { x: c.c1[0], y: c.c1[1], z: c.c1[2] };
      const c2: SplinePt = { x: c.c2[0], y: c.c2[1], z: c.c2[2] };
      // densité adaptée à la longueur de la corde (~1 point / 5 mm), pour des courbes franchement lisses.
      const perSeg = Math.max(16, Math.min(260, Math.round(segLen / 5)));
      for (let s = 1; s <= perSeg; s++) {
        const t = s / perSeg, u = 1 - t;
        // Bézier cubique B(t) = u³P1 + 3u²t C1 + 3ut² C2 + t³P2
        out.push({
          x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
          y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
          z: u * u * u * p1.z + 3 * u * u * t * c1.z + 3 * u * t * t * c2.z + t * t * t * p2.z,
        });
      }
    }
    return out;
  }

  /** Échantillonne le spline HISTORIQUE (uniforme) en polyligne dense. `P` = points de contrôle ;
      `straight` = index des segments laissés droits ; `k` = tension ; `stubAt` = index des points
      d'amorce (tangente imposée). */
  static sample(P: SplinePt[], straight: Set<number>, k: number, stubAt?: Set<number>): SplinePt[] {
    if (P.length < 2) return P.map(CableSpline.copyPt);
    return CableSpline.densify(P, CableSpline.controls(P.map((p) => [p.x, p.y, p.z]), straight, k, stubAt));
  }

  /** Échantillonne le style « cordes arrondies » : les DROITES ne coûtent que leurs extrémités,
      seuls les CONGÉS sont densifiés (~1 pt / 5 mm) → BEAUCOUP moins de points que les splines
      (bénéfice de rebuild attendu du style), avec la même évaluation cubique que `densify()`. */
  static sampleFillet(P: SplinePt[], straight: Set<number> | undefined, k: number, stubAt?: Set<number>): SplinePt[] {
    if (P.length < 2) return P.map(CableSpline.copyPt);
    const prims = CableSpline.fillets(P.map((p) => [p.x, p.y, p.z]), straight, k, stubAt);
    const out: SplinePt[] = [CableSpline.copyPt(P[0])];
    prims.forEach((pr) => {
      if (pr.kind === "line") { out.push({ x: pr.q[0], y: pr.q[1], z: pr.q[2] }); return; }
      const p1: SplinePt = { x: pr.p[0], y: pr.p[1], z: pr.p[2] }, p2: SplinePt = { x: pr.q[0], y: pr.q[1], z: pr.q[2] };
      const c1: SplinePt = { x: pr.c1[0], y: pr.c1[1], z: pr.c1[2] }, c2: SplinePt = { x: pr.c2[0], y: pr.c2[1], z: pr.c2[2] };
      // densité ~1 pt / 5 mm sur la CORDE du congé (l'arc n'en diffère que de < 11 % sous 90° —
      // heuristique de densité, l'exactitude n'importe pas ici), bornée [4, 64].
      const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
      const perSeg = Math.max(4, Math.min(64, Math.round(chord / 5)));
      for (let s = 1; s <= perSeg; s++) {
        const t = s / perSeg, u = 1 - t;
        out.push({
          x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
          y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
          z: u * u * u * p1.z + 3 * u * u * t * c1.z + 3 * u * t * t * c2.z + t * t * t * p2.z,
        });
      }
    });
    return out;
  }

  /** Point d'entrée UNIQUE de l'échantillonnage 3D selon le STYLE sélectionné (le rendu 2D, lui,
      consomme `controls`/`controlsCentripetal`/`fillets` directement pour sérialiser en path SVG —
      les tangentes/primitives restent PARTAGÉES, donc la parité 2D ⇄ 3D tient par construction).
      "spline" passe par `sample()` historique : bit-identique. */
  static sampleStyle(style: CableCurveStyle, P: SplinePt[], straight: Set<number>, k: number, stubAt?: Set<number>): SplinePt[] {
    if (style === "fillet") return CableSpline.sampleFillet(P, straight, k, stubAt);
    if (style === "centripetal") {
      if (P.length < 2) return P.map(CableSpline.copyPt);
      return CableSpline.densify(P, CableSpline.controlsCentripetal(P.map((p) => [p.x, p.y, p.z]), straight, k, stubAt));
    }
    return CableSpline.sample(P, straight, k, stubAt);
  }
}
