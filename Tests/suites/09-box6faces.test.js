/* ============================================================================
   Suite 09 — Boîte 3D « 6 faces » (box6Faces).
   ----------------------------------------------------------------------------
   Cœur géométrique PUR extrait (v164, §4.1 dedup transverse) du rendu des boîtes
   3D pleines : baie (portes), équipement racké / latéral / mural / libre. À partir
   des 8 coins PROJETÉS d'un pavé, produit ses 6 faces quad, chacune avec la
   profondeur de son centroïde, TRIÉES du plus lointain au plus proche (peintre).
   On caractérise : ordre canonique des coins par face, calcul du centroïde, tri
   décroissant stable, et fusion des métadonnées par face (opacité / plane).
   ========================================================================== */
"use strict";
module.exports = {
  name: "Boîte 6 faces (box6Faces)",
  run: async (NM, ck) => {
    const box6 = NM.box6Faces;
    ck(typeof box6 === "function", "box6Faces exposée");
    if (typeof box6 !== "function") return;

    // 8 coins étiquetés par leur indice ; depth = 100 pour le plancher (0..3),
    // 0 pour le plafond (4..7) → la face « dessous » est la plus lointaine.
    const C = [0, 1, 2, 3, 4, 5, 6, 7].map(i => ({ h: i, v: i, depth: i < 4 ? 100 : 0, id: i }));
    const ids = (f) => f.pts.map(p => p.id);

    /* --- forme du résultat --- */
    let faces = box6(C);
    ck.eq(faces.length, 6, "6 faces");
    ck.eq(faces.every(f => f.pts.length === 4), true, "chaque face = 4 coins");

    /* --- tri peintre : profondeurs décroissantes --- */
    const cds = faces.map(f => f.cd);
    ck.eq(cds.every((c, i) => i === 0 || cds[i - 1] >= c), true, "trié loin→près (cd décroissant)");
    ck.eq(faces[0].cd, 100, "1re face (la plus lointaine) = dessous, cd=100");
    ck.eq(faces[5].cd, 0, "dernière face (la plus proche) = dessus, cd=0");

    /* --- ordre canonique des coins : dessous=[0,1,2,3], dessus=[4,5,6,7] --- */
    ck.eq(JSON.stringify(ids(faces[0])), JSON.stringify([0, 1, 2, 3]), "face dessous = coins [0,1,2,3]");
    ck.eq(JSON.stringify(ids(faces[5])), JSON.stringify([4, 5, 6, 7]), "face dessus = coins [4,5,6,7]");

    /* --- centroïde = moyenne des profondeurs des 4 coins (face avant [0,1,5,4]) --- */
    const front = faces.find(f => JSON.stringify(ids(f)) === JSON.stringify([0, 1, 5, 4]));
    ck(!!front, "face avant [0,1,5,4] présente");
    ck.eq(front.cd, 50, "centroïde avant = (100+100+0+0)/4 = 50");

    /* --- 4 faces latérales à cd=50 : tri STABLE → ordre BOX6_FACE_IDX (avant,arrière,gauche,droite) --- */
    const mid = faces.filter(f => f.cd === 50).map(ids).map(a => JSON.stringify(a));
    ck.eq(mid[0], JSON.stringify([0, 1, 5, 4]), "tri stable : avant en tête du groupe cd=50");
    ck.eq(mid[3], JSON.stringify([1, 2, 6, 5]), "tri stable : droite en fin du groupe cd=50");

    /* --- fusion meta par face (opacité + plane), reportée APRÈS tri --- */
    const meta = [{ o: 0.55 }, { o: 1 }, { o: 0.92, plane: "y0" }, { o: 0.78, plane: "y1" }, { o: 0.72 }, { o: 0.72 }];
    faces = box6(C, meta);
    ck.eq(faces[0].o, 0.55, "meta : face dessous → o=0.55");
    ck.eq(faces[0].plane, undefined, "meta : face sans plane → plane absent");
    const frontM = faces.find(f => JSON.stringify(ids(f)) === JSON.stringify([0, 1, 5, 4]));
    ck.eq(frontM.o, 0.92, "meta : face avant → o=0.92");
    ck.eq(frontM.plane, "y0", "meta : face avant → plane=y0");

    /* --- meta optionnel : sans meta, pas d'opacité parasite --- */
    faces = box6(C);
    ck.eq(faces[0].o, undefined, "sans meta → o absent");
    ck.eq("cd" in faces[0] && "pts" in faces[0], true, "sans meta → pts/cd toujours présents");
  }
};
