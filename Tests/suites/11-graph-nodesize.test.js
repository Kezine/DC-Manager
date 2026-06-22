/* ============================================================================
   Suite 11 — Taille de boîte d'un nœud GraphView (graphNodeSize).
   ----------------------------------------------------------------------------
   SOURCE UNIQUE extraite (v167, §4.2 dedup intra-région) : largeur/hauteur de la
   boîte d'un nœud, jadis recopiée en 5 formules divergentes (rendu, ×2 bbox,
   sélection, recentrage — ce dernier portait le bug latent §6). Formule canonique :
     chars = max(longueur du nom, longueur du libellé de type)
     w = max(120, round(chars*7) + 34 + 14) = max(120, chars*7 + 48) ; h = 40.
   On caractérise : plancher 120, croissance avec le nom, prise en compte du
   libellé de type (le plus long des deux gagne), hauteur fixe.
   ========================================================================== */
"use strict";
module.exports = {
  name: "Taille nœud GraphView (graphNodeSize)",
  run: async (NM, ck) => {
    const gs = NM.graphNodeSize;
    ck(typeof gs === "function", "graphNodeSize exposée");
    if (typeof gs !== "function") return;

    // type vide → equipmentTypeLabel("") = "—" (longueur 1) → c'est le nom qui pilote.
    const TL0 = NM.equipmentTypeLabel ? NM.equipmentTypeLabel("").length : 1;

    /* --- plancher à 120 px pour un nom court --- */
    ck.eq(gs({ name: "ab", type: "" }).h, 40, "hauteur fixe = 40");
    ck.eq(gs({ name: "ab", type: "" }).w, 120, "nom court → plancher 120");
    ck.eq(gs({ name: "", type: "" }).w, 120, "nom vide → plancher 120");

    /* --- au-delà du plancher : w = chars*7 + 48 (chars = max(nom, type)) --- */
    const long = "x".repeat(30);                 // 30 chars → 30*7+48 = 258
    const exp = Math.max(120, Math.round(Math.max(30, TL0) * 7) + 48);
    ck.eq(gs({ name: long, type: "" }).w, exp, "nom long (30) → 30*7+48 = " + exp);

    /* --- monotonie : un nom plus long ne rétrécit jamais la boîte --- */
    const w10 = gs({ name: "y".repeat(10), type: "" }).w;
    const w40 = gs({ name: "y".repeat(40), type: "" }).w;
    ck(w40 >= w10, "largeur croît (ou stable) avec la longueur du nom");
    ck(w40 > 120, "nom de 40 → au-dessus du plancher");

    /* --- le libellé de TYPE compte aussi : à nom égal court, un type connu peut élargir --- */
    if (NM.equipmentTypeLabel) {
      const tlSwitch = NM.equipmentTypeLabel("switch");   // libellé réel du catalogue
      const expSwitch = Math.max(120, Math.round(Math.max(1, tlSwitch.length) * 7) + 48);
      ck.eq(gs({ name: "", type: "switch" }).w, expSwitch, "type 'switch' (nom vide) → largeur pilotée par le libellé de type");
    }

    /* --- le PLUS LONG des deux gagne (nom court + type, ou nom long + type court) --- */
    const byName = gs({ name: "z".repeat(25), type: "" }).w;
    const expName = Math.max(120, Math.round(25 * 7) + 48);
    ck.eq(byName, expName, "nom (25) > type (1) → la largeur suit le nom");

    /* --- graphNodesBBox : bbox centre ± demi-taille (v171) --- */
    const bb = NM.graphNodesBBox;
    ck(typeof bb === "function", "graphNodesBBox exposée");
    if (typeof bb === "function") {
      // _w fixé → largeur déterministe (pas de dépendance au catalogue) ; demi-hauteur constante 10
      const nodes = [{ x: 0, y: 0, _w: 40 }, { x: 100, y: 50, _w: 20 }];
      const r = bb(nodes, () => 10);
      ck.eq(r.minX, -20, "bbox minX = 0 - 40/2");
      ck.eq(r.maxX, 110, "bbox maxX = 100 + 20/2");
      ck.eq(r.minY, -10, "bbox minY = 0 - 10");
      ck.eq(r.maxY, 60, "bbox maxY = 50 + 10");
      // demi-hauteur PAR nœud (halfHOf reçoit le nœud)
      const r2 = bb([{ x: 0, y: 0, _w: 10, _h: 40 }], (n) => (n._h || 40) / 2);
      ck.eq(r2.maxY, 20, "halfHOf par nœud : h/2 = 20");
      ck.eq(r2.maxX, 5, "largeur via _w (10/2)");
    }
  }
};
