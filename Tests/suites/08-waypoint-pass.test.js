/* ============================================================================
   Suite 08 — Points de passage d'un waypoint (waypointPassPoints, waypointAnchor).
   ----------------------------------------------------------------------------
   Brique géométrique PURE au cœur de l'assemblage de route monde factorisé en
   `_buildWorldVia` (v163, §4.1 dedup transverse — `_interDcRoutes` ↔
   `_floorEquipCables3D`). Pour un waypoint « segment » (chemin de câbles), le câble
   longe TOUT le rail : il passe par ses 2 extrémités, dans l'orientation (e0→e1 ou
   e1→e0) qui MINIMISE le détour prev→entrée + sortie→next. Pour un pin/point isolé :
   un seul point (l'ancre). `off` (vecteur monde) décale les points (répartition conduit).
   On ne teste QUE les branches pures (segment / point sans rack) — pas brush/pin de
   rack, qui dépendent de la géométrie de baie et du store.
   ========================================================================== */
"use strict";
module.exports = {
  name: "Points de passage waypoint (waypointPassPoints)",
  run: async (NM, ck) => {
    await NM.makeStore();   // store présent par sûreté (les branches testées n'y touchent pas)
    const wpp = NM.waypointPassPoints, anchor = NM.waypointAnchor;
    ck(typeof wpp === "function", "waypointPassPoints exposée");
    ck(typeof anchor === "function", "waypointAnchor exposée");
    if (typeof wpp !== "function") return;

    // rail horizontal e0=(0,0) → e1=(10,0), à z=5
    const seg = { kind: "segment", dc_x: 0, dc_y: 0, dc_x2: 10, dc_y2: 0, dc_z: 5 };

    /* --- orientation min-détour : voisins du côté e0 puis e1 → ordre [e0, e1] --- */
    let r = wpp(seg, { x: -5, y: 0, z: 5 }, { x: 15, y: 0, z: 5 }, null);
    ck.eq(r.length, 2, "segment → 2 points de passage");
    ck.eq(r[0].x, 0, "prev près de e0 → 1er point = e0 (x=0)");
    ck.eq(r[1].x, 10, "… 2e point = e1 (x=10)");
    ck.eq(r[0].z, 5, "z du rail conservé");

    /* --- voisins inversés → l'orientation s'inverse : [e1, e0] --- */
    r = wpp(seg, { x: 15, y: 0, z: 5 }, { x: -5, y: 0, z: 5 }, null);
    ck.eq(r[0].x, 10, "prev près de e1 → 1er point = e1 (x=10)");
    ck.eq(r[1].x, 0, "… 2e point = e0 (x=0)");

    /* --- décalage `off` (répartition conduit) appliqué aux deux points --- */
    r = wpp(seg, { x: -5, y: 0, z: 5 }, { x: 15, y: 0, z: 5 }, { x: 0, y: 0, z: 2 });
    ck.eq(r[0].z, 7, "off appliqué au 1er point (z 5→7)");
    ck.eq(r[1].z, 7, "off appliqué au 2e point (z 5→7)");
    ck.eq(r[0].x, 0, "off n'altère pas x (offset z seul)");

    /* --- segment dégénéré (e0 == e1) → repli sur l'ancre unique --- */
    const degen = { kind: "segment", dc_x: 4, dc_y: 6, dc_x2: 4, dc_y2: 6, dc_z: 3 };
    r = wpp(degen, { x: 0, y: 0, z: 0 }, { x: 9, y: 9, z: 0 }, null);
    ck.eq(r.length, 1, "segment de longueur nulle → 1 seul point (ancre)");
    ck.eq(r[0].x, 4, "ancre = milieu (x=4)");

    /* --- point isolé (sans rack) → 1 point = l'ancre, décalable par off --- */
    const pt = { kind: "point", dc_x: 3, dc_y: 4, dc_z: 1 };
    r = wpp(pt, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, null);
    ck.eq(r.length, 1, "point isolé → 1 point");
    ck.eq(r[0].x, 3, "point isolé → ancre (x=3)");
    r = wpp(pt, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    ck.eq(r[0].y, 5, "off appliqué au point isolé (y 4→5)");

    /* --- waypointAnchor : milieu pour un segment placé --- */
    const aSeg = anchor(seg);
    ck.eq(aSeg.x, 5, "waypointAnchor(segment) → milieu x=5");
    ck.eq(aSeg.z, 5, "waypointAnchor(segment) → z=5");
  }
};
