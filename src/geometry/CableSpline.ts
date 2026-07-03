/* =============================================================================
   Échantillonnage PUR du SPLINE de câble (cardinal / Catmull-Rom, tension `k`) en polyligne
   dense 3D — même mécanique que le tracé SVG, réutilisée par le moteur 3D. Sans DOM, ni scène,
   ni THREE (points simples {x,y,z}) → testable en isolation. Extrait de DcThreeScene (n°11).

   • Les segments listés dans `straight` restent des CHORDES DROITES (corps de conduit / amorces ⊥).
   • Aux points d'amorce `stubAt` (sortie ⟂), la tangente est IMPOSÉE = axe du segment droit adjacent
     (continuité G1 → la courbe part/arrive dans l'axe, aucun « kink », la sortie reste perpendiculaire).
   • Contrôles intérieurs : Catmull-Rom C1 = P[i] + (P[i+1] − P[i−1])·k, densité ~1 point / 5 mm.
   ============================================================================= */
export interface SplinePt { x: number; y: number; z: number }

export class CableSpline {
  /** Points de contrôle Bézier PAR SEGMENT (null = segment laissé droit), pour un polyligne de dimension
      QUELCONQUE (2D h/v du tracé SVG · 3D x/y/z de l'échantillonnage) — LE calcul de tangentes vit ici,
      UNE seule fois, pour les deux moteurs (auparavant dupliqué dans DcScene3D.cablePath) :
      • amorce ⟂ (`stubAt`) : tangente IMPOSÉE le long du segment droit adjacent (continuité G1) ;
      • point intérieur : Catmull-Rom C1 = (P[i+1] − P[i−1])·k. */
  static controls(P: number[][], straight: Set<number> | undefined, k: number, stubAt?: Set<number>): Array<{ c1: number[]; c2: number[] } | null> {
    const n = P.length, hk = k * 2.5;
    const sub = (a: number[], b: number[]) => a.map((v, d) => v - b[d]);
    const len = (v: number[]) => Math.hypot(...v);
    const unit = (a: number[], b: number[]) => { const d = sub(b, a), L = len(d) || 1; return d.map((v) => v / L); };
    const isStraight = (i: number) => !!(straight && straight.has(i));
    // direction d'amorce imposée à i = axe de SON segment droit adjacent (G1 avec le segment droit)
    const stubDir = (i: number): number[] | null => {
      if (!stubAt || !stubAt.has(i)) return null;
      if (isStraight(i)) return unit(P[i], P[i + 1]);              // segment droit APRÈS i
      if (i > 0 && isStraight(i - 1)) return unit(P[i - 1], P[i]); // segment droit AVANT i
      return null;
    };
    const tan = (i: number, segLen: number): number[] => {
      const d = stubDir(i);
      if (d) return d.map((v) => v * segLen * hk);                 // amorce : alignée sur l'axe
      const p0 = P[Math.max(0, i - 1)], p1 = P[Math.min(n - 1, i + 1)];
      return sub(p1, p0).map((v) => v * k);                        // intérieur : Catmull-Rom
    };
    const out: Array<{ c1: number[]; c2: number[] } | null> = [];
    for (let i = 0; i < n - 1; i++) {
      if (isStraight(i)) { out.push(null); continue; }
      const segLen = len(sub(P[i + 1], P[i]));
      const t1 = tan(i, segLen), t2 = tan(i + 1, segLen);
      out.push({ c1: P[i].map((v, d) => v + t1[d]), c2: P[i + 1].map((v, d) => v - t2[d]) });
    }
    return out;
  }

  /** Échantillonne le spline en polyligne dense. `P` = points de contrôle ; `straight` = index des segments
      laissés droits ; `k` = tension ; `stubAt` = index des points d'amorce (tangente imposée). */
  static sample(P: SplinePt[], straight: Set<number>, k: number, stubAt?: Set<number>): SplinePt[] {
    const copy = (p: SplinePt): SplinePt => ({ x: p.x, y: p.y, z: p.z });
    if (P.length < 2) return P.map(copy);
    const ctrls = CableSpline.controls(P.map((p) => [p.x, p.y, p.z]), straight, k, stubAt);
    const out: SplinePt[] = [copy(P[0])];
    for (let i = 0; i < P.length - 1; i++) {
      const p1 = P[i], p2 = P[i + 1], c = ctrls[i];
      if (!c) { out.push(copy(p2)); continue; }   // chorde droite (corps de conduit / amorce ⟂)
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
}
