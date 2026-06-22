/* Géométrie & couleurs : fonctions PURES (sans store ni DOM). */
module.exports = {
  name: "Géométrie & couleurs (fonctions pures)",
  run: (NM, ck) => {
    // PROJECTION (vue Dessus) : h=X, v=Y, depth=Z (cf. invariant PROJECTION du header)
    if (NM.project3D) {
      const q = NM.project3D({ x: 10, y: 20, z: 30 });
      ck.eq(q.h, 10, "project3D : h = X");
      ck.eq(q.v, 20, "project3D : v = Y");
      ck.eq(q.depth, 30, "project3D : depth = Z");
    } else { ck(false, "project3D exposé"); }

    // equipmentTypeColor : pure + déterministe (mémoïsée en v158 → doit rester stable)
    if (NM.equipmentTypeColor) {
      const c1 = NM.equipmentTypeColor("switch"), c2 = NM.equipmentTypeColor("switch");
      ck(typeof c1 === "string" && c1.length > 0, "equipmentTypeColor → couleur non vide");
      ck.eq(c1, c2, "equipmentTypeColor : déterministe (mémo)");
      const x1 = NM.equipmentTypeColor("type-hors-liste-xyz"), x2 = NM.equipmentTypeColor("type-hors-liste-xyz");
      ck.eq(x1, x2, "equipmentTypeColor : hash STABLE pour un type hors catalogue");
      if (Array.isArray(NM.COLOR_PALETTE)) ck(NM.COLOR_PALETTE.includes(c1), "equipmentTypeColor : valeur issue de COLOR_PALETTE");
    } else { ck(false, "equipmentTypeColor exposé"); }

    // normRackOrientation : ramène à {0,90,180,270}
    if (NM.normRackOrientation) {
      ck.eq(NM.normRackOrientation(0), 0, "normRackOrientation(0) = 0");
      ck.eq(NM.normRackOrientation(90), 90, "normRackOrientation(90) = 90");
      ck([0, 90, 180, 270].includes(NM.normRackOrientation(450)), "normRackOrientation(450) ∈ {0,90,180,270}");
    }

    // floorNum : numérique, vide → 0
    if (NM.floorNum) {
      ck.eq(NM.floorNum(""), 0, "floorNum('') = 0");
      ck.eq(NM.floorNum(3), 3, "floorNum(3) = 3");
    }
  }
};
