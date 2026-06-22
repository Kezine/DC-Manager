/* ============================================================================
   Suite 12 — Comparateur de tri peintre 3D (painterFarFirst).
   ----------------------------------------------------------------------------
   Cœur PUR extrait de `_rackBox3D` (v172, découpe incrémentale §7.1). Décide, pour
   deux boîtes locales A,B ({lo,hi}), laquelle peindre en premier (la plus LOINTAINE)
   selon le gradient de profondeur `grad`=[gX,gY,gZ]. Règle : si A,B sont disjointes
   le long d'un axe k, on tranche par le signe de grad sur l'axe le plus discriminant
   (|grad| max) ; sinon par profondeur du centroïde. <0 = A avant B ; >0 = B avant A.
   On caractérise le comportement courant (garde-fou), pas une spec idéale — le
   comparateur est connu NON TRANSITIF (d'où le tri topologique en aval).
   ========================================================================== */
"use strict";
module.exports = {
  name: "Tri peintre (painterFarFirst)",
  run: async (NM, ck) => {
    const ff = NM.painterFarFirst;
    ck(typeof ff === "function", "painterFarFirst exposée");
    if (typeof ff !== "function") return;

    const box = (x0, y0, z0, x1, y1, z1) => ({ lo: [x0, y0, z0], hi: [x1, y1, z1] });
    const A = box(0, 0, 0, 1, 1, 1);
    const B = box(2, 0, 0, 3, 1, 1);   // séparée de A le long de X (A.hi.x=1 ≤ B.lo.x=2)

    /* --- séparation sur X, grad.x > 0 : +x = plus loin → B (grand x) peint avant A --- */
    ck(ff(A, B, [1, 0, 0]) > 0, "sépar. X, grad.x>0 → B avant A (>0)");
    /* --- gradient inversé : A (petit x) devient le plus loin --- */
    ck(ff(A, B, [-1, 0, 0]) < 0, "sépar. X, grad.x<0 → A avant B (<0)");
    /* --- antisymétrie par paire (correct deux à deux) --- */
    ck(Math.sign(ff(A, B, [1, 0, 0])) === -Math.sign(ff(B, A, [1, 0, 0])), "antisymétrique sur une paire séparée");

    /* --- choix de l'axe le plus discriminant (|grad| max) ---
       A,B séparées sur X (A bas) ET sur Z (A bas). grad.z domine (|5|>|1|).
       Sur Z avec grad.z>0 : B (grand z) plus loin → >0. */
    const A2 = box(0, 0, 0, 1, 1, 1), B2 = box(2, 0, 2, 3, 1, 3);
    ck(ff(A2, B2, [1, 0, 5]) > 0, "axe dominant = Z (|grad| max) → B avant A");
    // si on annule grad.z, c'est X qui tranche (toujours >0 ici car A bas sur X aussi)
    ck(ff(A2, B2, [1, 0, 0]) > 0, "grad.z=0 → X tranche → B avant A");

    /* --- pas d'axe séparateur (boîtes qui se chevauchent en 3D) → centroïde --- */
    const O1 = box(0, 0, 0, 2, 2, 2), O2 = box(1, 1, 1, 3, 3, 3);   // chevauchement sur les 3 axes
    // centroïdes le long de grad=[1,0,0] : cA=1, cB=2 → cB-cA=1>0 (O2 plus profond → avant)
    ck(ff(O1, O2, [1, 0, 0]) > 0, "chevauchement → tri par centroïde (O2 plus loin)");
    ck.eq(ff(O1, O1, [1, 0, 0]), 0, "même boîte, chevauchement → centroïdes égaux → 0");

    /* --- grad nul partout + chevauchement → 0 (aucune préférence) --- */
    ck.eq(ff(O1, O2, [0, 0, 0]), 0, "grad nul + chevauchement → 0");
  }
};
