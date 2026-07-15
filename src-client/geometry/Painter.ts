/** Boîte locale alignée aux axes : coins min (`lo`) et max (`hi`) en [x,y,z]. */
export interface LocalBox { lo: [number, number, number]; hi: [number, number, number]; }

/** Comparateur de tri PEINTRE entre boîtes locales (extrait de `_rackBox3D`). */
export class Painter {
  /* Décide laquelle de A,B peindre en premier (la plus LOINTAINE) selon le gradient
     de profondeur `grad`=[gX,gY,gZ]. Si A,B sont disjointes le long d'un axe k, on
     tranche par le signe de grad sur l'axe le plus discriminant (|grad| max) ; sinon
     par profondeur du centroïde. <0 = A avant B ; >0 = B avant A.
     ⚠ NON TRANSITIF (correct par PAIRE) → s'emploie via un tri topologique. */
  static farFirst(A: LocalBox, B: LocalBox, grad: [number, number, number]): number {
    let bestAbs = -1, bk = -1, brel = 0;
    for (let k = 0; k < 3; k++) {
      let rel = 0;
      if (A.hi[k] <= B.lo[k] + 1e-6) rel = 1;
      else if (B.hi[k] <= A.lo[k] + 1e-6) rel = -1;
      if (rel && Math.abs(grad[k]) > bestAbs) { bestAbs = Math.abs(grad[k]); bk = k; brel = rel; }
    }
    if (bk < 0) {
      const cA = (A.lo[0] + A.hi[0]) / 2 * grad[0] + (A.lo[1] + A.hi[1]) / 2 * grad[1] + (A.lo[2] + A.hi[2]) / 2 * grad[2];
      const cB = (B.lo[0] + B.hi[0]) / 2 * grad[0] + (B.lo[1] + B.hi[1]) / 2 * grad[1] + (B.lo[2] + B.hi[2]) / 2 * grad[2];
      return cB - cA;
    }
    return brel === 1 ? (grad[bk] > 0 ? 1 : -1) : (grad[bk] > 0 ? -1 : 1);
  }
}
