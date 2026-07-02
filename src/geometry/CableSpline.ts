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
  /** Échantillonne le spline en polyligne dense. `P` = points de contrôle ; `straight` = index des segments
      laissés droits ; `k` = tension ; `stubAt` = index des points d'amorce (tangente imposée). */
  static sample(P: SplinePt[], straight: Set<number>, k: number, stubAt?: Set<number>): SplinePt[] {
    const copy = (p: SplinePt): SplinePt => ({ x: p.x, y: p.y, z: p.z });
    if (P.length < 2) return P.map(copy);
    const n = P.length, hk = k * 2.5;
    const dist = (a: SplinePt, b: SplinePt) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const unit = (a: SplinePt, b: SplinePt): SplinePt => { const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.hypot(dx, dy, dz) || 1; return { x: dx / L, y: dy / L, z: dz / L }; };
    // direction d'amorce imposée à i = axe de SON segment droit adjacent (G1 avec le segment droit)
    const stubDir = (i: number): SplinePt | null => {
      if (!stubAt || !stubAt.has(i)) return null;
      if (straight.has(i)) return unit(P[i], P[i + 1]);              // segment droit APRÈS i
      if (i > 0 && straight.has(i - 1)) return unit(P[i - 1], P[i]); // segment droit AVANT i
      return null;
    };
    const tan = (i: number, segLen: number): SplinePt => {
      const d = stubDir(i);
      if (d) return { x: d.x * segLen * hk, y: d.y * segLen * hk, z: d.z * segLen * hk };   // amorce : alignée sur l'axe
      const p0 = P[Math.max(0, i - 1)], p1 = P[Math.min(n - 1, i + 1)];
      return { x: (p1.x - p0.x) * k, y: (p1.y - p0.y) * k, z: (p1.z - p0.z) * k };            // intérieur : Catmull-Rom
    };
    const out: SplinePt[] = [copy(P[0])];
    for (let i = 0; i < n - 1; i++) {
      const p1 = P[i], p2 = P[i + 1];
      if (straight.has(i)) { out.push(copy(p2)); continue; }   // chorde droite (corps de conduit / amorce ⟂)
      const segLen = dist(p1, p2);
      const t1 = tan(i, segLen), t2 = tan(i + 1, segLen);
      const c1: SplinePt = { x: p1.x + t1.x, y: p1.y + t1.y, z: p1.z + t1.z };
      const c2: SplinePt = { x: p2.x - t2.x, y: p2.y - t2.y, z: p2.z - t2.z };
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
