/* Tests modules — géométrie pure (racks, salles, portes, splines, positionnement, 3D).
   Sections extraites de run.js (audit P5) ; harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, mkStorage, Store, BrowserStorageAdapter, FieldIndex, Equipment, Cable, Port, Normalize, Labeler, ClickGuard, Projection, Box, Painter, RackGeometry, GraphGeometry, RouteGraphLayout, ROUTE_GRAPH, LeaderLayout, Homography, ImageStitch, EquipmentTypes, PortRoles, Depths, EquipFaces, RackScene, Resolver3D, CableRouting, U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE, Html, Color, Format, GridGeometry, GraphView, Sort, Ip, Prefs, DatacenterView, FloorLayout, Positioning, DoorGeometry, Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM, DoorTool, Measure, CableSpline, MeasureTool, RouteTool, ImageStore, FaceImage, SaveState, EntityRegistry, ReloadPlanner, COLLECTION_THREE_IMPACT, RenderImpact, Changeset, SharedSchema, Text, PAGE_SIZE_DEFAULT, Validation, Cascade, Rack, CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS, makeStore } = require("./harness.js");

module.exports = async () => {
  await section("Géométrie & couleurs (pures)", async () => {
  {
    const q = Projection.project3D({ x: 10, y: 20, z: 30 });
    ck.eq(q.h, 10, "project3D : h = X"); ck.eq(q.v, 20, "project3D : v = Y"); ck.eq(q.depth, 30, "project3D : depth = Z");
    const c1 = EquipmentTypes.color("switch"), c2 = EquipmentTypes.color("switch");
    ck(typeof c1 === "string" && c1.length > 0, "equipmentTypeColor → couleur non vide");
    ck.eq(c1, c2, "equipmentTypeColor : déterministe (mémo)");
    ck(COLOR_PALETTE.includes(c1), "equipmentTypeColor : valeur ∈ COLOR_PALETTE");
    // fallback : un id NON reconnu (ancien id FR, type retiré) est RÉSOLU sur `other` (ids anglais + pas de rétro-compat).
    ck.eq(EquipmentTypes.resolveId("serveur"), "other", "resolveId : id inconnu (ancien FR) → other");
    ck.eq(EquipmentTypes.resolveId("switch"), "switch", "resolveId : id connu → inchangé");
    ck.eq(EquipmentTypes.has("server") && !EquipmentTypes.has("serveur"), true, "has : server connu, serveur inconnu");
    ck.eq(EquipmentTypes.color("hors-liste-xyz"), EquipmentTypes.color("other"), "color : type inconnu → couleur du repli other");
    ck.eq(EquipmentTypes.label("serveur"), EquipmentTypes.label("other"), "label : type inconnu → libellé du repli other");
    // `system` = types à pilotage fin (non supprimables à terme) : switch/patch_panel/pdu/switchboard uniquement.
    ck(EquipmentTypes.isSystem("switch") && EquipmentTypes.isSystem("patch_panel") && EquipmentTypes.isSystem("pdu") && EquipmentTypes.isSystem("switchboard"), "isSystem : types à pilotage fin marqués system");
    ck(!EquipmentTypes.isSystem("server") && !EquipmentTypes.isSystem("camera") && !EquipmentTypes.isSystem("other") && !EquipmentTypes.isSystem("inconnu"), "isSystem : inventaire générique / inconnu → non-system");
    ck([0, 90, 180, 270].includes(Normalize.rackOrientation(450)), "normRackOrientation(450) ∈ {0,90,180,270}");
  }
  });

  await section("LeaderLayout : étiquettes déportées (répulsion pure)", async () => {
  {
    ck.eq(JSON.stringify(LeaderLayout.layout([])), "[]", "layout([]) = [] (aucun port)");
    // 1 port : l'étiquette reste dans le cadre et proche de son ancre.
    const one = LeaderLayout.layout([{ x: 0.5, y: 0.5, w: 0.2, h: 0.1 }], { aspect: 5 });
    ck.eq(one.length, 1, "layout : une position par ancre");
    ck(one[0].x >= 0 && one[0].x <= 1 && one[0].y >= 0 && one[0].y <= 1, "layout : étiquette DANS le cadre [0,1]²");
    // 2 ports au même endroit : les RECTANGLES d'étiquette ne doivent PAS se chevaucher (séparation AABB).
    const asp = 4, W = 0.15, H = 0.1;
    const two = LeaderLayout.layout([{ x: 0.5, y: 0.5, w: W, h: H }, { x: 0.5, y: 0.5, w: W, h: H }], { aspect: asp, iterations: 160 });
    const dxpx = Math.abs(two[0].x - two[1].x) * asp, dypx = Math.abs(two[0].y - two[1].y);
    ck(dxpx >= W * asp - 1e-6 || dypx >= H - 1e-6, "layout : les rectangles des 2 étiquettes ne se chevauchent PAS (AABB séparés sur un axe)");
    // aucune étiquette ne recouvre un port : le rect ne contient pas l'ancre (0.5,0.5) en pixels.
    const covers = (L) => Math.abs(L.x - 0.5) * asp < (W * asp) / 2 && Math.abs(L.y - 0.5) < H / 2;
    ck(!covers(two[0]) && !covers(two[1]), "layout : aucune étiquette posée sur le port");
  }
  });

  await section("RouteGraphLayout : mini-graphe de tracé (pur)", async () => {
  {
    const G = ROUTE_GRAPH;
    const N = (roomId, extra = {}) => Object.assign({ roomId, roomLabel: roomId || "", z: null }, extra);
    // trajet type : patch A → chemin bas → exit A → pin d'étage → exit B → chemin haut → patch B
    const nodes = [
      N("A", { endpoint: true }), N("A", { z: -80 }), N("A", { z: -80 }),
      N(null, { z: -80 }),
      N("B", { z: -80 }), N("B", { z: 2600 }), N("B", { endpoint: true }),
    ];
    const ch = RouteGraphLayout.chain(nodes);
    ck.eq(ch.xs.length, 7, "chain : une abscisse par nœud");
    ck(ch.xs.every((x, i) => i === 0 || x > ch.xs[i - 1]), "chain : abscisses strictement croissantes");
    ck.eq(ch.xs[1] - ch.xs[0], G.GAP_EP, "chain : écart extrémité→waypoint = GAP_EP");
    ck.eq(ch.xs[2] - ch.xs[1], G.GAP_WP, "chain : écart waypoint→waypoint (même salle) = GAP_WP");
    ck.eq(ch.xs[3] - ch.xs[2], G.GAP_WP + G.GAP_ROOM, "chain : changement de salle → respiration GAP_ROOM");
    ck.eq(ch.width, ch.xs[6] + G.PAD_X, "chain : largeur = dernier centre + marge");
    ck.eq(ch.bands.length, 2, "chain : 2 bandes de salles (le pin d'étage coupe)");
    ck.eq(ch.bands[0].from + "-" + ch.bands[0].to, "0-2", "chain : bande A = nœuds 0..2");
    ck.eq(ch.bands[1].from + "-" + ch.bands[1].to, "4-6", "chain : bande B = nœuds 4..6");
    ck(ch.bands[0].x0 < ch.xs[0] - G.EP_W / 2 && ch.bands[0].x1 > ch.xs[2] + G.WP_R, "chain : la bande déborde de ses nœuds extrêmes");
    // deux passages dans la même salle (A, étage, A) → deux bandes DISTINCTES (pas de fusion à travers un tronçon)
    const back = [N("A", { z: 0 }), N(null, { z: 100 }), N("A", { z: 0 })];
    ck.eq(RouteGraphLayout.chain(back).bands.length, 2, "chain : pas de fusion de bandes à travers un tronçon");

    const pr = RouteGraphLayout.profile(nodes);
    ck.eq(JSON.stringify(pr.xs), JSON.stringify(ch.xs), "profil : mêmes abscisses que la chaîne (bascule sans saut)");
    ck.eq(pr.floors.length, 1, "profil : un seul étage (aucun level fourni) → une seule dalle");
    ck.eq(pr.multiFloor, false, "profil : multiFloor faux sur un seul étage");
    ck(pr.ys[5] < pr.ys[4], "profil : z plus haut → ordonnée plus petite (2600 au-dessus de −80)");
    ck(pr.ys[1] > pr.floors[0].y, "profil : z négatif SOUS la dalle");
    ck.eq(pr.floors[0].hasUnderfloor, true, "profil : faux-plancher détecté (z < 0)");
    ck(pr.snapped[0] === true && pr.snapped[6] === true, "profil : z d'extrémité inconnue → héritée (amorce)");
    ck.eq(pr.ys[0], pr.ys[1], "profil : l'extrémité hérite l'ordonnée du waypoint voisin");
    ck(pr.ys.every((y) => y >= G.PROF_TOP - 1e-9 && y <= pr.height - G.PROF_BOT + 1e-9), "profil : ordonnées dans les marges");
    ck.eq(pr.separators.length, 2, "profil : un séparateur par changement de salle");
    // amplitude minimale garantie : tracé plat à z = 0 → la dalle n'est collée à aucun bord
    const flat = RouteGraphLayout.profile([N("A", { z: 0 }), N("A", { z: 0 })]);
    ck(flat.floors[0].y > G.PROF_TOP && flat.floors[0].y < G.PROF_H - G.PROF_BOT, "profil : dalle lisible même sur tracé plat");
    // dégénéré : deux extrémités sans aucun z (intra-salle) → pas de crash, valeurs finies
    const two = RouteGraphLayout.profile([N("A", { endpoint: true }), N("A", { endpoint: true })]);
    ck(two.ys.every((y) => isFinite(y)), "profil : tracé sans waypoint → ordonnées finies (repli sûr)");

    // MULTI-ÉTAGE : salle A à l'ét. 0 → pin d'étage à l'ét. 1 → salle B à l'ét. 1
    // (dc_z est RELATIF à la dalle de chaque étage → un référentiel empilé par étage)
    const mf = [
      N("A", { endpoint: true, level: 0 }), N("A", { z: -80, level: 0 }), N("A", { z: 0, level: 0 }),
      N(null, { z: 300, level: 1 }),
      N("B", { z: 0, level: 1 }), N("B", { endpoint: true }),   // extrémité B sans étage → hérité (1)
    ];
    const pf = RouteGraphLayout.profile(mf);
    ck.eq(pf.floors.length, 2, "profil multi-étage : une dalle par étage traversé");
    ck.eq(pf.multiFloor, true, "profil multi-étage : multiFloor vrai");
    ck.eq(pf.floors[0].level + "→" + pf.floors[1].level, "0→1", "profil multi-étage : niveaux croissants");
    ck(pf.floors[1].y < pf.floors[0].y, "profil multi-étage : la dalle de l'ét. 1 AU-DESSUS de celle de l'ét. 0");
    ck(pf.height > G.PROF_H, "profil multi-étage : hauteur étendue avec le nombre d'étages");
    ck.eq(pf.ys[2], pf.floors[0].y, "profil multi-étage : z=0 à l'ét. 0 posé sur SA dalle");
    ck.eq(pf.ys[4], pf.floors[1].y, "profil multi-étage : z=0 à l'ét. 1 posé sur SA dalle");
    const kA = (pf.ys[1] - pf.ys[2]) / 80, kB = (pf.ys[4] - pf.ys[3]) / 300;
    ck(Math.abs(kA - kB) < 1e-9, "profil multi-étage : échelle z COMMUNE à tous les étages");
    ck(pf.floors[1].x1 >= pf.xs[5] + G.EP_W / 2, "profil multi-étage : l'extrémité à étage hérité compte dans l'emprise de SON étage");
    ck(pf.floors[0].x1 < pf.floors[1].x0, "profil multi-étage : emprises d'étages disjointes (dalles séparées à l'écran)");
  }
  });

  await section("RackGeometry (pure)", async () => {
  {
    // LARGEUR RÉELLE d'un boîtier U (u_width_mm) + alignement (u_align, vu de face : left = −X).
    const BODY = RACK_MOUNT_WIDTH - 30;   // corps utile = panneau − 2 oreilles (15 mm)
    ck.eq(RackGeometry.mountBodyWidth(), BODY, "mountBodyWidth = panneau 19″ − 2 oreilles");
    ck.eq(RackGeometry.eqBodyWidth({}), BODY, "eqBodyWidth défaut = pleine largeur du corps");
    ck.eq(RackGeometry.eqBodyWidth({ u_width_mm: 200 }), 200, "eqBodyWidth = u_width_mm si renseignée");
    ck.eq(RackGeometry.eqBodyWidth({ u_width_mm: 9999 }), BODY, "eqBodyWidth bornée au corps utile");
    ck.eq(RackGeometry.eqBodyOffsetX({ u_width_mm: 200, u_align: "left" }), -(BODY - 200) / 2, "offset gauche = −(full−w)/2");
    ck.eq(RackGeometry.eqBodyOffsetX({ u_width_mm: 200, u_align: "right" }), (BODY - 200) / 2, "offset droite = +(full−w)/2");
    ck.eq(RackGeometry.eqBodyOffsetX({ u_width_mm: 200 }), 0, "offset centré (défaut) = 0");
    ck.eq(RackGeometry.eqBodyOffsetX({}), 0, "pleine largeur → offset 0 (u_align ignoré)");
    ck.eq(RackGeometry.sideMarginMm({ width_mm: 800 }), (800 - RACK_MOUNT_WIDTH) / 2, "sideMarginMm(800)");
    ck.eq(RackGeometry.sideColumns({ width_mm: 800 }), 2, "sideColumns(800) = 2");
    ck.eq(RackGeometry.sideColumns({ width_mm: 600 }), 1, "sideColumns(600) = 1");
    ck(RackGeometry.sideEnabled({ width_mm: 800, allow_side_front: true }, "front") === true, "sideEnabled front (marge≥1U + flag)");
    ck(RackGeometry.sideEnabled({ width_mm: 800, allow_side_front: true }, "rear") === false, "sideEnabled rear faux sans flag");
    ck(RackGeometry.sideEnabled({ width_mm: 500, allow_side_front: true }, "front") === false, "sideEnabled faux si marge < 1U");
    const r0 = RackGeometry.halfExtents({ width_mm: 600, depth: 1000, orientation: 0 });
    const r90 = RackGeometry.halfExtents({ width_mm: 600, depth: 1000, orientation: 90 });
    ck(r0.hx === 300 && r0.hy === 500, "halfExtents 0° = {300,500}");
    ck(r90.hx === 500 && r90.hy === 300, "halfExtents 90° permute hx/hy");
    void U_MM;
  }
  });

  await section("Box.faces / Painter.farFirst (pures)", async () => {
  {
    const C = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ h: i, v: i, depth: i < 4 ? 100 : 0, id: i }));
    const ids = (f) => f.pts.map((p) => p.id);
    let faces = Box.faces(C);
    ck.eq(faces.length, 6, "box : 6 faces");
    ck.eq(faces[0].cd, 100, "box : 1re face (loin) cd=100");
    ck.eq(faces[5].cd, 0, "box : dernière face (proche) cd=0");
    ck.eq(JSON.stringify(ids(faces[0])), JSON.stringify([0, 1, 2, 3]), "box : dessous = [0,1,2,3]");
    const front = faces.find((f) => JSON.stringify(ids(f)) === JSON.stringify([0, 1, 5, 4]));
    ck.eq(front.cd, 50, "box : centroïde avant = 50");
    faces = Box.faces(C, [{ o: 0.55 }, { o: 1 }, { o: 0.92, plane: "y0" }, { o: 0.78 }, { o: 0.72 }, { o: 0.72 }]);
    ck.eq(faces[0].o, 0.55, "box meta : face dessous o=0.55");
    const fm = faces.find((f) => JSON.stringify(ids(f)) === JSON.stringify([0, 1, 5, 4]));
    ck.eq(fm.plane, "y0", "box meta : face avant plane=y0");

    const box = (x0, y0, z0, x1, y1, z1) => ({ lo: [x0, y0, z0], hi: [x1, y1, z1] });
    const A = box(0, 0, 0, 1, 1, 1), B = box(2, 0, 0, 3, 1, 1);
    ck(Painter.farFirst(A, B, [1, 0, 0]) > 0, "painter : sépar X, grad.x>0 → B avant A");
    ck(Painter.farFirst(A, B, [-1, 0, 0]) < 0, "painter : grad.x<0 → A avant B");
    const A2 = box(0, 0, 0, 1, 1, 1), B2 = box(2, 0, 2, 3, 1, 3);
    ck(Painter.farFirst(A2, B2, [1, 0, 5]) > 0, "painter : axe dominant Z → B avant A");
    const O1 = box(0, 0, 0, 2, 2, 2), O2 = box(1, 1, 1, 3, 3, 3);
    ck(Painter.farFirst(O1, O2, [1, 0, 0]) > 0, "painter : chevauchement → centroïde (O2 plus loin)");
    ck.eq(Painter.farFirst(O1, O1, [1, 0, 0]), 0, "painter : même boîte → 0");
    ck.eq(Painter.farFirst(O1, O2, [0, 0, 0]), 0, "painter : grad nul → 0");
  }
  });

  await section("GraphGeometry (pure)", async () => {
  {
    ck.eq(GraphGeometry.nodeSize({ name: "ab", type: "" }).h, 40, "nodeSize : hauteur fixe 40");
    ck.eq(GraphGeometry.nodeSize({ name: "ab", type: "" }).w, 120, "nodeSize : nom court → plancher 120");
    const long = "x".repeat(30);
    ck.eq(GraphGeometry.nodeSize({ name: long, type: "" }).w, Math.max(120, 30 * 7 + 48), "nodeSize : nom(30) → 30*7+48");
    const w10 = GraphGeometry.nodeSize({ name: "y".repeat(10), type: "" }).w;
    const w40 = GraphGeometry.nodeSize({ name: "y".repeat(40), type: "" }).w;
    ck(w40 >= w10 && w40 > 120, "nodeSize : croît avec le nom");
    const bb = GraphGeometry.nodesBBox([{ x: 0, y: 0, _w: 40 }, { x: 100, y: 50, _w: 20 }], () => 10);
    ck.eq(bb.minX, -20, "bbox minX = -20"); ck.eq(bb.maxX, 110, "bbox maxX = 110");
    ck.eq(bb.minY, -10, "bbox minY = -10"); ck.eq(bb.maxY, 60, "bbox maxY = 60");
  }
  });

  await section("RackScene : occupation des U (rackOccupants)", async () => {
  {
    const s = await makeStore();
    const rs = new RackScene(s);
    const rack = await s.create("racks", { name: "R", u_count: 42, sides: "single" });
    await s.create("equipments", { name: "sw", placement_mode: "rack", rack_id: rack.id, rack_u: 10, u_height: 2 });
    const occ = rs.occupants(rack.id);
    ck(occ.has("10:front") && occ.has("11:front"), "occupants : U10–U11 front occupés");
    ck(!occ.has("12:front"), "occupants : U12 libre");
    ck.eq(rs.occupancyCount(rack.id), 1, "occupancyCount = 1");
    ck.eq(rs.freeUInfo(rack.id).free, 40, "freeUInfo : 40 U libres sur 42");
    // occupantsElev (rendu 3D) : un occupant équipement, U10 hauteur 2, face avant.
    const el = rs.occupantsElev(rack.id);
    ck.eq(el.length, 1, "occupantsElev : 1 occupant");
    ck(el[0].kind === "eq" && el[0].u === 10 && el[0].h === 2 && el[0].side === "front", "occupantsElev : eq U10 h2 front");
  }
  });

  await section("RackScene + RackGeometry : side-mount", async () => {
  {
    const s = await makeStore();
    const rs = new RackScene(s);
    const dc = await s.create("datacenters", { name: "DC" });
    const rack = await s.create("racks", { name: "R", width_mm: 800, depth: 1000, u_count: 42, allow_side_front: true, datacenter_id: dc.id, dc_x: 1000, dc_y: 1000 });
    const eq = await s.create("equipments", { name: "PDU", placement_mode: "side", dim_mode: "free", rack_id: rack.id, side_face: "front", side_lr: "left", side_col: 0, side_u: 5, free_w_mm: 60, free_h_mm: 150, free_l_mm: 300 });
    ck.eq(rs.sideOccupants(rack.id, "front", "left").length, 1, "sideOccupants(front,left) = 1");
    ck.eq(rs.sideOccupants(rack.id, "rear", null).length, 0, "sideOccupants(rear) = 0");
    const box = RackGeometry.sideEquipBoxLocal(rack, eq), h = box.heightU;
    ck(rs.sideSlotFree(rack.id, "front", "left", 0, 5, h, null) === false, "sideSlotFree : bande occupée = false");
    ck(rs.sideSlotFree(rack.id, "front", "left", 0, 35, 2, null) === true, "sideSlotFree : bande libre = true");
    ck(rs.sideSlotFree(rack.id, "front", "left", 0, 5, h, eq.id) === true, "sideSlotFree : exceptId ignore l'occupant");
    const free = rs.sideFreeSlots(rack);
    ck(free.length > 0 && free.every((sl) => !(sl.face === "front" && sl.lr === "left" && sl.col === 0 && sl.uTop === 5)), "sideFreeSlots exclut la bande occupée");
    ck(box.x0 < 0 && box.x1 <= 0, "sideEquipBoxLocal : gauche → x ≤ 0");
    ck(box.front === true && box.z1 > box.z0, "sideEquipBoxLocal : front + hauteur cohérente");
    const slotBox = RackGeometry.sideSlotBoxLocal(rack, "front", "left", 0, 5, 2);
    ck(slotBox.x0 < 0 && slotBox.front === true, "sideSlotBoxLocal : gauche/front cohérent");
  }
  });

  await section("RackScene + RackGeometry : wall-mount", async () => {
  {
    const s = await makeStore();
    const rs = new RackScene(s);
    const dc = await s.create("datacenters", { name: "DC" });
    // `allow_side_front` REQUIS depuis l'unification latéral/paroi : le toggle side-mount gouverne AUSSI les parois.
    const rack = await s.create("racks", { name: "R", width_mm: 600, depth: 1200, u_count: 42, front_margin_mm: 200, cage_depth_mm: 700, allow_side_front: true, datacenter_id: dc.id, dc_x: 2000, dc_y: 2000 });
    ck(RackGeometry.wallEnabled(rack, "front") === true, "wallEnabled(front) avec marge ≥ 1U ET side-mount avant autorisé");
    // UNIFICATION latéral/paroi : les emplacements en paroi sont gouvernés par le MÊME toggle que la marge.
    ck(RackGeometry.wallEnabled(rack, "rear") === false, "wallEnabled(rear) faux SANS allow_side_rear (unifié avec le side-mount)");
    ck(RackGeometry.wallEnabled({ ...rack, allow_side_front: false }, "front") === false, "wallEnabled(front) faux sans allow_side_front");
    const eq = await s.create("equipments", { name: "WALL", placement_mode: "wall", dim_mode: "free", rack_id: rack.id, wall_lr: "left", wall_margin: "front", wall_col: 0, wall_u: 5, wall_orient: "center", free_w_mm: 80, free_h_mm: 150, free_l_mm: 100 });
    ck.eq(rs.wallOccupants(rack.id, "front", "left").length, 1, "wallOccupants(front,left) = 1");
    ck(rs.wallSlotFree(rack.id, "left", "front", 0, 5, 2, null) === false, "wallSlotFree : bande occupée = false");
    ck(rs.wallSlotFree(rack.id, "left", "front", 0, 35, 2, null) === true, "wallSlotFree : bande libre = true");
    ck(rs.wallFreeSlots(rack).length > 0, "wallFreeSlots non vide");
    const wbox = RackGeometry.wallEquipBoxLocal(rack, eq);
    ck(wbox.n && (wbox.n.x !== 0 || wbox.n.y !== 0), "wallEquipBoxLocal : normale définie");
    ck(wbox.z1 > wbox.z0, "wallEquipBoxLocal : hauteur cohérente");
  }
  });

  await section("Resolver3D : resolvePort3D (rack / side / wall / libre)", async () => {
  {
    const s = await makeStore();
    const r3 = new Resolver3D(s);
    const dc = await s.create("datacenters", { name: "DC" });
    // rack
    const rack = await s.create("racks", { name: "R", width_mm: 600, depth: 1000, u_count: 42, datacenter_id: dc.id, dc_x: 500, dc_y: 500 });
    const eq = await s.create("equipments", { name: "SW", placement_mode: "rack", rack_id: rack.id, rack_u: 10 });
    const p = await s.create("ports", { equipment_id: eq.id, name: "p", face_x: 0.3, face_y: 0.4, face_side: "front" });
    const pr = r3.resolvePort3D(p.id, dc.id);
    ck(pr && isFinite(pr.x) && isFinite(pr.y) && isFinite(pr.z), "resolvePort3D(rack) → point fini");
    ck.eq(r3.resolvePort3D(p.id, "autre-dc"), null, "resolvePort3D : dc ≠ rack.datacenter_id → null");
    // FAÇADE DEVANT LA CAGE : le port avant est à STANDOFF (3 mm) devant le plan des montants (orientation 0
    // → façade en −Y : y = dc_y − depth/2 − 3) ; un DÉBORD (face_offset_mm) l'avance d'autant en plus.
    ck(pr && Math.abs(pr.y - (500 - 500 - 3)) < 1e-6, "port avant = plan de montage − réserve d'oreilles (3 mm)");
    await s.update("equipments", eq.id, { face_offset_mm: 50 });
    const pr2 = r3.resolvePort3D(p.id, dc.id);
    ck(pr2 && Math.abs(pr2.y - (pr.y - 50)) < 1e-6, "débord de façade 50 mm → port avancé de 50 mm");
    await s.update("equipments", eq.id, { face_offset_mm: 0 });
    // LARGEUR RÉELLE (boîtier rétréci) + alignement : face_x couvre la largeur du boîtier, au décalage
    // physique de son alignement (vu de face, left = −X à orientation 0).
    await s.update("equipments", eq.id, { u_width_mm: 200, u_align: "left" });
    const prN = r3.resolvePort3D(p.id, dc.id);
    const xcN = -(482.6 - 30 - 200) / 2;
    ck(prN && Math.abs(prN.x - (500 + xcN + (0.3 - 0.5) * 200)) < 1e-6, "boîtier rétréci 200 mm aligné à gauche : port sur la largeur réelle, décalé");
    await s.update("equipments", eq.id, { u_width_mm: null, u_align: "center" });
    const prBack = r3.resolvePort3D(p.id, dc.id);
    ck(prBack && Math.abs(prBack.x - pr.x) < 1e-6, "largeur vidée → retour pleine largeur (comportement historique)");
    // libre
    const fe = await s.create("equipments", { name: "free", dim_mode: "free", dc_id: dc.id, dc_x: 800, dc_y: 800, free_w_mm: 200, free_h_mm: 100, free_l_mm: 200 });
    const fp = await s.create("ports", { equipment_id: fe.id, name: "fp", face_x: 0.5, face_y: 0.5 });
    const fr = r3.resolvePort3D(fp.id, dc.id);
    ck(fr && isFinite(fr.x) && isFinite(fr.z), "resolvePort3D(libre) → point fini");
    ck(fr && fr.n && (Math.abs(fr.n.x) + Math.abs(fr.n.y) + Math.abs(fr.n.z)) > 0, "resolvePort3D(libre) → normale non nulle");
    // side
    const rk2 = await s.create("racks", { name: "R2", width_mm: 800, depth: 1000, u_count: 42, allow_side_front: true, datacenter_id: dc.id, dc_x: 2000, dc_y: 2000 });
    const se = await s.create("equipments", { name: "PDU", placement_mode: "side", dim_mode: "free", rack_id: rk2.id, side_face: "front", side_lr: "left", side_u: 5, free_w_mm: 60, free_h_mm: 150, free_l_mm: 300 });
    const sp = await s.create("ports", { equipment_id: se.id, name: "sp", face_x: 0.5, face_y: 0.5 });
    const sr = r3.resolvePort3D(sp.id, dc.id);
    ck(sr && isFinite(sr.x) && isFinite(sr.z) && (Math.abs(sr.n.x) + Math.abs(sr.n.y)) > 0, "resolvePort3D(side) → point + normale");
    // wall
    const rk3 = await s.create("racks", { name: "R3", width_mm: 600, depth: 1200, u_count: 42, front_margin_mm: 200, cage_depth_mm: 700, datacenter_id: dc.id, dc_x: 3000, dc_y: 3000 });
    const we = await s.create("equipments", { name: "WALL", placement_mode: "wall", dim_mode: "free", rack_id: rk3.id, wall_lr: "left", wall_margin: "front", wall_u: 5, wall_orient: "center", free_w_mm: 80, free_h_mm: 150, free_l_mm: 100 });
    const wp = await s.create("ports", { equipment_id: we.id, name: "wp", face_x: 0.5, face_y: 0.5 });
    const wr = r3.resolvePort3D(wp.id, dc.id);
    ck(wr && isFinite(wr.x) && isFinite(wr.z), "resolvePort3D(wall) → point fini");
  }
  });

  await section("CableRouting : carriesPower — POE compris (éclair d'avertissement)", async () => {
  {
    const s = await makeStore();
    // `carriesPower` n'utilise que le store ; resolver/floor non requis pour ce prédicat.
    const cr = new CableRouting(s, null, null);
    const eqData = await s.create("equipments", { name: "SW" });
    const eqPoe = await s.create("equipments", { name: "SW-POE", poe_device: true });
    const pData1 = await s.create("ports", { equipment_id: eqData.id, name: "d1", role: "data" });
    const pData2 = await s.create("ports", { equipment_id: eqData.id, name: "d2", role: "data" });
    const pPoe = await s.create("ports", { equipment_id: eqPoe.id, name: "poe1", role: "poe", direction: "source", poe_budget_w: 30 });
    const ctData = await s.create("cableTypes", { name: "Cat6", kind: "data" });
    const ctPower = await s.create("cableTypes", { name: "C13", kind: "power" });
    // carriesPower ne lit que {cable_type_id, from_port_id, to_port_id} + le store : on passe des câbles LITTÉRAUX
    // (pas besoin de persister — et la validation de compatibilité de câble n'est pas l'objet du test).
    // 1) câble data reliant deux ports data → pas d'énergie.
    ck.eq(cr.carriesPower({ cable_type_id: ctData.id, from_port_id: pData1.id, to_port_id: pData2.id }), false, "carriesPower : câble data + ports data → false");
    // 2) câble de TYPE power → énergie (comportement historique préservé).
    ck.eq(cr.carriesPower({ cable_type_id: ctPower.id, from_port_id: pData1.id, to_port_id: pData2.id }), true, "carriesPower : câble de type power → true");
    // 3) câble data dont UNE extrémité est un port POE → énergie (nouveauté POE).
    ck.eq(cr.carriesPower({ cable_type_id: ctData.id, from_port_id: pData1.id, to_port_id: pPoe.id }), true, "carriesPower : câble data touchant un port POE → true");
    ck.eq(cr.carriesPower(null), false, "carriesPower : câble nul → false");
  }
  });

  await section("Resolver3D : resolveTrunkUplink3D (uplink de faisceau — centre de face arrière)", async () => {
  {
    const s = await makeStore();
    const r3 = new Resolver3D(s);
    const dc = await s.create("datacenters", { name: "DC" });
    const rack = await s.create("racks", { name: "R", width_mm: 600, depth: 1000, u_count: 42, datacenter_id: dc.id, dc_x: 500, dc_y: 500 });
    const patch = await s.create("equipments", { name: "PATCH", type: "patch_panel", placement_mode: "rack", rack_id: rack.id, rack_u: 10 });
    const up = r3.resolveTrunkUplink3D(patch.id, dc.id);
    ck(up && isFinite(up.x) && isFinite(up.y) && isFinite(up.z), "uplink → point fini (sans AUCUN port persisté)");
    ck(up && Math.abs(up.x - 500) < 1e-6, "uplink centré sur la largeur du patch (face_x = 0.5)");
    ck(up && up.n && up.n.y > 0.99, "uplink sur la face ARRIÈRE (normale +Y à orientation 0)");
    ck(up && up.rackId === rack.id, "uplink : baie hôte exposée (masquage avec la baie)");
    // parité avec un port PERSISTÉ posé au même endroit : la résolution de face est PARTAGÉE (resolveFaceAnchor3D)
    const p = await s.create("ports", { equipment_id: patch.id, name: "up", face_x: 0.5, face_y: 0.5, face_side: "rear" });
    const pr = r3.resolvePort3D(p.id, dc.id);
    ck(up && pr && Math.abs(up.x - pr.x) < 1e-6 && Math.abs(up.y - pr.y) < 1e-6 && Math.abs(up.z - pr.z) < 1e-6, "uplink ≡ port persisté au centre de la face arrière (mécanique unique)");
    ck.eq(r3.resolveTrunkUplink3D(patch.id, "autre-dc"), null, "salle ≠ salle de la baie → null");
    ck.eq(r3.resolveTrunkUplink3D(null, dc.id), null, "extrémité absente → null");
    ck.eq(r3.resolveTrunkUplink3D("inconnu", dc.id), null, "équipement inconnu → null");
  }
  });

  await section("Resolver3D : waypointPassPoints / waypointAnchor", async () => {
  {
    const s = await makeStore();
    const r3 = new Resolver3D(s);
    const seg = { kind: "segment", dc_x: 0, dc_y: 0, dc_x2: 10, dc_y2: 0, dc_z: 5 };
    let r = r3.waypointPassPoints(seg, { x: -5, y: 0, z: 5 }, { x: 15, y: 0, z: 5 }, null);
    ck.eq(r.length, 2, "segment → 2 points");
    ck.eq(r[0].x, 0, "prev près de e0 → 1er = e0"); ck.eq(r[1].x, 10, "… 2e = e1"); ck.eq(r[0].z, 5, "z du rail");
    r = r3.waypointPassPoints(seg, { x: 15, y: 0, z: 5 }, { x: -5, y: 0, z: 5 }, null);
    ck.eq(r[0].x, 10, "voisins inversés → 1er = e1"); ck.eq(r[1].x, 0, "… 2e = e0");
    r = r3.waypointPassPoints(seg, { x: -5, y: 0, z: 5 }, { x: 15, y: 0, z: 5 }, { x: 0, y: 0, z: 2 });
    ck.eq(r[0].z, 7, "off appliqué (z 5→7)"); ck.eq(r[0].x, 0, "off n'altère pas x");
    const degen = { kind: "segment", dc_x: 4, dc_y: 6, dc_x2: 4, dc_y2: 6, dc_z: 3 };
    r = r3.waypointPassPoints(degen, { x: 0, y: 0, z: 0 }, { x: 9, y: 9, z: 0 }, null);
    ck.eq(r.length, 1, "segment nul → 1 point (ancre)"); ck.eq(r[0].x, 4, "ancre = milieu (x=4)");
    const pt = { kind: "point", dc_x: 3, dc_y: 4, dc_z: 1 };
    r = r3.waypointPassPoints(pt, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, null);
    ck.eq(r.length, 1, "point isolé → 1 point"); ck.eq(r[0].x, 3, "point → ancre x=3");
    r = r3.waypointPassPoints(pt, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    ck.eq(r[0].y, 5, "off appliqué au point isolé (y 4→5)");
    const aSeg = r3.waypointAnchor(seg);
    ck.eq(aSeg.x, 5, "waypointAnchor(segment) → milieu x=5"); ck.eq(aSeg.z, 5, "waypointAnchor → z=5");
  }
  });

  await section("Resolver3D : répartition conduit (grille / dims / offsets)", async () => {
  {
    // grille & cellule (PURS, statiques)
    ck.eq(JSON.stringify(Resolver3D.conduitGrid(1, 1)), JSON.stringify({ cols: 1, rows: 1 }), "conduitGrid(1) → 1×1");
    ck.eq(JSON.stringify(Resolver3D.conduitGrid(4, 1)), JSON.stringify({ cols: 2, rows: 2 }), "conduitGrid(4, carré) → 2×2");
    ck.eq(Resolver3D.conduitGrid(2, 3).cols, 2, "conduitGrid(2, large) → 2 colonnes");
    const c0 = Resolver3D.conduitCell(0, 4, 1), c3 = Resolver3D.conduitCell(3, 4, 1);
    ck.eq(c0.col + "," + c0.row, "0,0", "conduitCell(0/4) → (0,0)");
    ck.eq(c3.col + "," + c3.row, "1,1", "conduitCell(3/4) → (1,1)");

    const s = await makeStore();
    const r3 = new Resolver3D(s);
    const dc = await s.create("datacenters", { name: "DC" });
    // chemin de câbles (segment) : section pleine 300×100, de (0,0,5) à (10,0,5).
    const seg = await s.create("waypoints", { kind: "segment", datacenter_id: dc.id, dc_x: 0, dc_y: 0, dc_x2: 10, dc_y2: 0, dc_z: 5 });
    const dims = r3.waypointConduitDims(seg);
    ck(dims && dims.kind === "segment" && dims.usableW === 300 && dims.usableH === 100, "waypointConduitDims(segment) → 300×100");
    ck.eq(r3.waypointConduitDims({ kind: "point" }), null, "waypointConduitDims(point sans spread) → null");
    const pinDims = r3.waypointConduitDims({ kind: "point", spread: true, radius: 200 });
    ck(pinDims && pinDims.usableW === 300 && pinDims.usableH === 300, "waypointConduitDims(pin spread r=200) → 300×300 (carré inscrit)");

    // 2 câbles routés par CE segment → ids triés + offsets symétriques ⊥ au rail (axe x).
    // Noms d'équipement UNIQUES par document (contrainte V6g) : compteur incrémental.
    let mkSeq = 0;
    const mk = async () => (await s.create("ports", { equipment_id: (await s.create("equipments", { name: "e" + (++mkSeq) })).id, name: "p" })).id;
    const cabA = await s.create("cables", { name: "A", from_port_id: await mk(), to_port_id: await mk(), waypoint_ids: [seg.id] });
    const cabB = await s.create("cables", { name: "B", from_port_id: await mk(), to_port_id: await mk(), waypoint_ids: [seg.id] });
    const ids = r3.conduitCablesOf(seg.id);
    ck.eq(ids.length, 2, "conduitCablesOf(segment) → 2 câbles");
    ck.eq(JSON.stringify(ids), JSON.stringify([cabA.id, cabB.id].sort()), "conduitCablesOf → ids triés (ordre stable)");
    const prev = { x: -5, y: 0, z: 5 }, next = { x: 15, y: 0, z: 5 };
    const offA = r3.conduitOffsetFor(seg, cabA.id, prev, next);
    const offB = r3.conduitOffsetFor(seg, cabB.id, prev, next);
    ck(offA && offB, "conduitOffsetFor(2 câbles) → offsets non nuls");
    ck(Math.abs(offA.x) < 1e-9 && Math.abs(offA.z) < 1e-9, "offset ⊥ au rail horizontal (x≈0, z≈0)");
    ck(Math.abs(Math.abs(offA.y) - 75) < 1e-9, "demi-pas de répartition (|y|=75 sur 300/2 colonnes)");
    ck(Math.abs(offA.y + offB.y) < 1e-9, "offsets symétriques (offA.y = −offB.y)");
    ck.eq(r3.conduitOffsetFor(seg, "câble-inconnu", prev, next), null, "conduitOffsetFor(câble non routé) → null");

    // 1 seul câble par CE segment → centré (offset null).
    const seg2 = await s.create("waypoints", { kind: "segment", datacenter_id: dc.id, dc_x: 0, dc_y: 20, dc_x2: 10, dc_y2: 20, dc_z: 5 });
    await s.create("cables", { name: "solo", from_port_id: await mk(), to_port_id: await mk(), waypoint_ids: [seg2.id] });
    ck.eq(r3.conduitOffsetFor(seg2, r3.conduitCablesOf(seg2.id)[0], prev, next), null, "conduitOffsetFor(1 seul câble) → null (centré)");

    // FAISCEAU routé par un conduit → occupe un SLOT de répartition comme un câble (sinon, centré, il
    // chevaucherait visuellement un câble voisin — ses brins piochés par ports ne sont pas dessinés).
    const seg3 = await s.create("waypoints", { kind: "segment", datacenter_id: dc.id, dc_x: 0, dc_y: 40, dc_x2: 10, dc_y2: 40, dc_z: 5 });
    const cabT = await s.create("cables", { name: "voisin", from_port_id: await mk(), to_port_id: await mk(), waypoint_ids: [seg3.id] });
    const pat1 = await s.create("equipments", { name: "p1", type: "patch_panel" });
    const pat2 = await s.create("equipments", { name: "p2", type: "patch_panel" });
    const trunk = await s.create("cableBundles", { name: "TRK", endpoint_a_equipment_id: pat1.id, endpoint_b_equipment_id: pat2.id, waypoint_ids: [seg3.id] });
    const ids3 = r3.conduitCablesOf(seg3.id);
    ck.eq(ids3.length, 2, "conduitCablesOf : câble + FAISCEAU routés par le conduit");
    ck(ids3.includes(trunk.id) && ids3.includes(cabT.id), "conduitCablesOf : le faisceau occupe la section (id présent)");
    const offC = r3.conduitOffsetFor(seg3, cabT.id, prev, next), offT = r3.conduitOffsetFor(seg3, trunk.id, prev, next);
    ck(offC && offT, "conduitOffsetFor : offsets non nuls pour le câble ET le faisceau");
    ck(offC && offT && Math.abs(offC.y + offT.y) < 1e-9 && Math.abs(offT.y) > 1, "répartition câble ⇄ faisceau : offsets symétriques (pas de chevauchement)");
  }
  });

  await section("FloorLayout : disposition multi-salles (étages empilés, bâtiments côte à côte)", async () => {
  {
    const s = await makeStore();
    const fl = new FloorLayout(s);
    // helpers purs
    ck.eq(FloorLayout.floorNum("2"), 2, "floorNum(\"2\") → 2");
    ck.eq(FloorLayout.floorNum(""), 0, "floorNum(vide) → 0");
    ck.eq(JSON.stringify(FloorLayout.roomFootprint({ width_mm: 600, depth_mm: 1000, floor_orientation: 0 })), JSON.stringify({ w: 600, h: 1000 }), "roomFootprint 0° → (w,d)");
    ck.eq(JSON.stringify(FloorLayout.roomFootprint({ width_mm: 600, depth_mm: 1000, floor_orientation: 90 })), JSON.stringify({ w: 1000, h: 600 }), "roomFootprint 90° → (d,w)");
    // config virtuelle quand pas d'entité floors
    const cfg = fl.config("liege", "0");
    ck(cfg.id === null && cfg.width_mm > 0 && cfg.cell_mm > 0, "config(sans entité) → défaut virtuel");
    // deux salles, deux étages d'un même bâtiment → empilées en Z, posées en X
    const dcA = await s.create("datacenters", { name: "A", location: "liege", floor: "0", width_mm: 6000, depth_mm: 4000, floor_x: 1000, floor_y: 1000 });
    const dcB = await s.create("datacenters", { name: "B", location: "liege", floor: "1", width_mm: 6000, depth_mm: 4000, floor_x: 1000, floor_y: 1000 });
    const m = fl.multiLayout(dcA, { visibleDcIds: new Set([dcA.id, dcB.id]) });
    ck.eq(m.rooms.length, 2, "multiLayout : 2 salles disposées");
    ck(m.levels.length === 2 && m.levels[0] === 0 && m.levels[1] === 1, "multiLayout : niveaux [0,1]");
    const rA = m.rooms.find((r) => r.dc.id === dcA.id), rB = m.rooms.find((r) => r.dc.id === dcB.id);
    ck(rB.off.z > rA.off.z, "multiLayout : étage 1 EMPILÉ au-dessus de l'étage 0 (z plus grand)");
    ck.eq(m.buildings.length, 1, "multiLayout : 1 bâtiment (Liège)");
    // roomToWorld / roomToLocal : aller-retour exact
    const p = { x: 2500, y: 1500, z: 700 };
    const w = FloorLayout.roomToWorld(rA, p), back = FloorLayout.roomToLocal(rA, w);
    ck(Math.abs(back.x - p.x) < 1e-6 && Math.abs(back.y - p.y) < 1e-6 && Math.abs(back.z - p.z) < 1e-6, "roomToWorld/roomToLocal : aller-retour exact");
    // centre local de la salle → centre monde = room.off
    const ctr = FloorLayout.roomToWorld(rA, { x: dcA.width_mm / 2, y: dcA.depth_mm / 2, z: 0 });
    ck(Math.abs(ctr.x - rA.off.x) < 1e-6 && Math.abs(ctr.y - rA.off.y) < 1e-6, "roomToWorld(centre salle) = room.off");
    // levelZ interpolé : niveau intermédiaire entre 0 et 1
    const z05 = FloorLayout.levelZ(m, 0.5);
    ck(z05 > rA.off.z && z05 < rB.off.z, "levelZ(0.5) interpolé entre étage 0 et 1");
    // deux bâtiments → posés côte à côte (x croissant)
    const dcC = await s.create("datacenters", { name: "C", location: "herstal", floor: "0", width_mm: 6000, depth_mm: 4000, floor_x: 1000, floor_y: 1000 });
    const m2 = fl.multiLayout(null, { visibleDcIds: new Set([dcA.id, dcC.id]) });
    ck.eq(m2.buildings.length, 2, "multiLayout : 2 bâtiments côte à côte");
    ck(m2.buildings[1].x0 >= m2.buildings[0].x1, "multiLayout : bâtiments non chevauchants (x croissant)");
    // décor (5c.16.3) : plans d'étage (un par bâtiment × étage) + position monde d'un OOB
    ck(m.floorPlanes.length >= 2, "multiLayout : ≥ 2 plans d'étage (Liège ét.0 + ét.1)");
    const fpA = m.floorPlanes.find((fp) => fp.floor === "0"); ck(!!fpA && fpA.off.z === 0, "floorPlane ét.0 → z = 0");
    const fpB = m.floorPlanes.find((fp) => fp.floor === "1"); ck(!!fpB && fpB.off.z > 0, "floorPlane ét.1 → z > 0 (empilé)");
    const oob = await s.create("waypoints", { wp_type: "oob", location: "liege", floor: "1", floor_x: 500, floor_y: 700, dc_z: 3000 });
    const m3 = fl.multiLayout(dcA, { visibleDcIds: new Set([dcA.id, dcB.id]) });
    const ow = fl.oobWorld(m3, oob);
    ck(isFinite(ow.x) && isFinite(ow.y) && ow.z > FloorLayout.levelZ(m3, 1), "oobWorld : OOB au-dessus du sol de son étage");
    // équipement posé sur un étage : position localisée vs centre (auto) + point monde au niveau de l'étage
    const cfg0 = fl.config("liege", "0");
    ck.eq(JSON.stringify(FloorLayout.floorEquipPos({ placement_mode: "floor", floor_x: 800, floor_y: 600 }, cfg0)), JSON.stringify({ x: 800, y: 600 }), "floorEquipPos localisé → (floor_x, floor_y)");
    ck.eq(JSON.stringify(FloorLayout.floorEquipPos({ placement_mode: "floor" }, cfg0)), JSON.stringify({ x: cfg0.width_mm / 2, y: cfg0.depth_mm / 2 }), "floorEquipPos non localisé → centre du plan");
    const fe = { placement_mode: "floor", location: "liege", floor: "1", floor_x: 500, floor_y: 700, dc_z: 1000 };
    const ew = fl.equipFloorWorld(m3, fe);
    ck(isFinite(ew.x) && isFinite(ew.y) && Math.abs(ew.z - (FloorLayout.levelZ(m3, 1) + 1000)) < 1e-6, "equipFloorWorld : base = niveau étage + dc_z");
  }
  });

  await section("Positioning : aide au positionnement (cœur pur — coins, cotes ⟂, placement, accrochage)", async () => {
  {
    const approx = (a, b, name, eps) => ck(Math.abs(a - b) <= (eps || 1e-6), name + "  (attendu ≈" + b + ", obtenu " + a + ")");
    const frame = { w: 6000, h: 4000 };
    // rack 600×1000 centré en (1000,1000), orientation 0 → hx=300, hy=500
    const A = { cx: 1000, cy: 1000, hx: 300, hy: 500 };
    const cA = Positioning.corners(A);
    ck.eq(JSON.stringify(cA.TL), JSON.stringify({ x: 700, y: 500 }), "corners TL = (cx−hx, cy−hy)");
    ck.eq(JSON.stringify(cA.BR), JSON.stringify({ x: 1300, y: 1500 }), "corners BR = (cx+hx, cy+hy)");
    // murs
    ck.eq(JSON.stringify(Positioning.wallLine(frame, "left")), JSON.stringify({ axis: "x", value: 0 }), "wallLine left → x=0");
    ck.eq(JSON.stringify(Positioning.wallLine(frame, "bottom")), JSON.stringify({ axis: "y", value: 4000 }), "wallLine bottom → y=h");
    // distance ⟂ d'un coin au mur gauche
    approx(Positioning.distance(cA.TL, { kind: "wall", wall: "left" }, "x", frame, {}), 700, "distance TL → mur gauche = 700");
    // un mur horizontal ne porte pas l'axe x
    ck.eq(Positioning.distance(cA.TL, { kind: "wall", wall: "top" }, "x", frame, {}), null, "mur top ne porte pas l'axe x → null");
    // cote ⟂ : segment porté par l'axe (de la référence jusqu'au coin)
    const coteX = Positioning.cote(cA.TL, { kind: "wall", wall: "left" }, "x", frame, {});
    ck(coteX && coteX.from.x === 0 && coteX.from.y === cA.TL.y && coteX.to.x === cA.TL.x, "cote ⟂ mur gauche : segment horizontal jusqu'au coin");
    // placement : coin TL du mover à 500 mm du mur gauche → cx tel que (cx−hx)=500 → cx=800
    const nx = Positioning.placeAxis(A, "TL", "x", { kind: "wall", wall: "left" }, 500, frame, {});
    approx(nx, 800, "placeAxis : TL à 500 du mur gauche → cx=800");
    // côté CONSERVÉ : le coin reste à droite du mur (pas de saut), valeur négative traitée en abs
    const nx2 = Positioning.placeAxis(A, "TL", "x", { kind: "wall", wall: "left" }, -500, frame, {});
    approx(nx2, 800, "placeAxis : |valeur| utilisée, côté conservé");
    // référence COIN d'un autre rect (ancre) : B centré (3000,1000), hx=300 → BL.x = 2700
    const B = { cx: 3000, cy: 1000, hx: 300, hy: 500 };
    const rects = { rb: B };
    approx(Positioning.refValue({ kind: "corner", rectId: "rb", corner: "BL" }, "x", frame, rects), 2700, "refValue coin BL de B sur x = 2700");
    // placer le coin TR de A à 100 mm à GAUCHE du coin BL de B (A est à gauche → côté conservé) :
    // coin TR cible = 2700 − 100 = 2600 ; cx = 2600 − hx = 2300
    const nx3 = Positioning.placeAxis(A, "TR", "x", { kind: "corner", rectId: "rb", corner: "BL" }, 100, frame, rects);
    approx(nx3, 2300, "placeAxis : TR de A à 100 du coin BL de B (côté gauche) → cx=2300");
    // ACCROCHAGE : centre candidat dont un bord est à 5 mm d'un mur → accroché (tol 9)
    const snapped = Positioning.snapCenter(A, 305, 1000, frame, [A], 0, 9);   // bord gauche = 305−300 = 5 ⟶ mur 0
    approx(snapped.cx, 300, "snapCenter : bord gauche accroché au mur 0 (cx=300)");
    ck.eq(snapped.snapX, 0, "snapCenter : ligne X accrochée = mur 0");
    // hors tolérance → pas d'accrochage
    const noSnap = Positioning.snapCenter(A, 400, 1000, frame, [A], 0, 9);
    ck.eq(noSnap.snapX, null, "snapCenter : hors tolérance → aucun accrochage X");
    // accrochage à un BORD d'un autre rect (alignement de coins). Cas NON ambigu : C (hx=200) → bords 2800/3200 ;
    // candidat cx=3103 → bord gauche 2803 ≈ 2800 ; bord droit 3403 loin de tout → seul le bord gauche s'aligne.
    const C = { cx: 3000, cy: 1000, hx: 200, hy: 500 };
    const snapAlign = Positioning.snapCenter(A, 3103, 1000, frame, [A, C], 0, 9);
    approx(snapAlign.cx, 3100, "snapCenter : bord gauche de A aligné sur le bord gauche de C");
    ck.eq(snapAlign.snapX, 2800, "snapCenter : ligne accrochée = bord gauche de C (2800)");
    // accrochage DÉTERMINISTE à égalité : bord équidistant du mur 0 ET d'un bord de rect → la 1re ligne (mur) gagne.
    const D = { cx: 300, cy: 1000, hx: 200, hy: 500 };   // bord gauche de D = 100
    const tie = Positioning.snapCenter(A, 350, 1000, frame, [A, D], 0, 60);   // bord gauche = 50 : à 50 du mur 0 ET du bord 100
    ck.eq(tie.snapX, 0, "snapCenter : égalité mur/bord → le mur (1re ligne) l'emporte (déterministe)");
    approx(tie.cx, 300, "snapCenter : accroché au mur 0 (cx=300)");
    // orientation 90 : hx/hy permutés en amont (responsabilité de la couche vue) — on vérifie juste le calcul de coins
    const R90 = { cx: 0, cy: 0, hx: 500, hy: 300 };   // ex. rack 600×1000 tourné à 90°
    ck.eq(JSON.stringify(Positioning.corners(R90).TR), JSON.stringify({ x: 500, y: -300 }), "corners d'un rect permuté (orientation 90 en amont)");
  }
  });

  await section("DoorGeometry : portes de salle (ouverture, listel, passage libre, débattement)", async () => {
  {
    const approx = (a, b, name, eps) => ck(Math.abs(a - b) <= (eps || 1e-6), name + "  (attendu ≈" + b + ", obtenu " + a + ")");
    const room = { w: 6000, h: 4000 };
    // porte mur HAUT, 900 mm, listel 40, charnière gauche, ouvre vers l'intérieur, centrée à x=2000
    const d = { wall: "top", offset: 2000, width_mm: 900, frame_mm: 40, hinge: "left", opening: "interior" };
    const g = DoorGeometry.geom(d, room);
    ck.eq(JSON.stringify(g.a), JSON.stringify({ x: 1550, y: 0 }), "ouverture a = (offset−w/2, 0)");
    ck.eq(JSON.stringify(g.b), JSON.stringify({ x: 2450, y: 0 }), "ouverture b = (offset+w/2, 0)");
    approx(g.clear, 820, "passage libre = width − 2·listel");
    // charnière côté GAUCHE de l'observateur intérieur regardant le mur → extrémité +x (cf. convention)
    ck.eq(JSON.stringify(g.hinge), JSON.stringify({ x: 2450, y: 0 }), "charnière (gauche, intérieur, mur haut) → +x");
    ck.eq(JSON.stringify(g.leafOpen), JSON.stringify({ x: 2410, y: 820 }), "vantail ouvert 90° → vers l'intérieur (+y), longueur = passage");
    // ouvre vers l'EXTÉRIEUR → le vantail balaie de l'autre côté (y négatif)
    const gExt = DoorGeometry.geom({ ...d, opening: "exterior" }, room);
    ck(gExt.leafOpen.y < 0, "ouverture extérieure → vantail vers y négatif (hors salle)");
    // charnière DROITE → l'autre extrémité
    const gR = DoorGeometry.geom({ ...d, hinge: "right" }, room);
    ck.eq(JSON.stringify(gR.hinge), JSON.stringify({ x: 1550, y: 0 }), "charnière droite → extrémité opposée");
    // bornage de l'offset : trop près du coin → ramené à w/2
    ck.eq(DoorGeometry.clampOffset({ wall: "top", offset: 100, width_mm: 900 }, room), 450, "clampOffset : borné à w/2 du coin");
    ck.eq(DoorGeometry.wallLen("left", room), 4000, "wallLen(left) = profondeur");
    ck.eq(DoorGeometry.wallLen("top", room), 6000, "wallLen(top) = largeur");
    // arc de débattement : 15 points, du vantail fermé (clearLatch) à l'ouvert (leafOpen) — via la chaîne
    // VIVANTE leaves()→leafArc() (l'ancien wrapper mono-vantail arcPoints a été supprimé, code mort).
    const arc = DoorGeometry.leafArc(DoorGeometry.leaves(g, d)[0], 14);
    ck.eq(arc.length, 15, "leafArc : n+1 points");
    approx(arc[0].x, g.clearLatch.x, "arc démarre au vantail FERMÉ (x)");
    approx(arc[0].y, g.clearLatch.y, "arc démarre au vantail FERMÉ (y)");
    approx(arc[14].x, g.leafOpen.x, "arc finit au vantail OUVERT (x)", 1e-6);
    approx(arc[14].y, g.leafOpen.y, "arc finit au vantail OUVERT (y)", 1e-6);
    // VANTAUX : simple → 1 vantail pleine largeur ; DOUBLE BATTANT → 2 demi-vantaux, charnières aux 2 extrémités,
    // loquets au CENTRE, chacun balayant clear/2. `hinge` sans effet en double (symétrique).
    const one = DoorGeometry.leaves(g, d);
    ck.eq(one.length, 1, "leaves(simple) : 1 vantail");
    ck.eq(JSON.stringify(one[0].hinge), JSON.stringify(g.clearHinge), "leaves(simple) : charnière = clearHinge");
    ck.eq(JSON.stringify(one[0].open), JSON.stringify(g.leafOpen), "leaves(simple) : ouvert = leafOpen");
    const two = DoorGeometry.leaves(g, { ...d, leaves: 2 });
    ck.eq(two.length, 2, "leaves(double) : 2 vantaux");
    approx(Math.hypot(two[0].latch.x - two[0].hinge.x, two[0].latch.y - two[0].hinge.y), g.clear / 2, "double : vantail 1 = clear/2");
    approx(Math.hypot(two[1].latch.x - two[1].hinge.x, two[1].latch.y - two[1].hinge.y), g.clear / 2, "double : vantail 2 = clear/2");
    ck.eq(JSON.stringify(two[0].latch), JSON.stringify(two[1].latch), "double : les loquets se rejoignent au CENTRE");
    approx(two[0].latch.x, (g.clearHinge.x + g.clearLatch.x) / 2, "double : joint au milieu du passage (x)");
    ck(two[0].open.y > 0 && two[1].open.y > 0, "double intérieur : les 2 vantaux balaient vers l'intérieur (+y)");
    const arcL = DoorGeometry.leafArc(two[0], 10);
    approx(arcL[0].x, two[0].latch.x, "leafArc démarre au vantail FERMÉ (loquet)");
    approx(arcL[10].x, two[0].open.x, "leafArc finit au vantail OUVERT", 1e-6);
    // porte sur mur GAUCHE : ouverture le long de y
    const dl = { wall: "left", offset: 2000, width_mm: 1000, frame_mm: 50, hinge: "left", opening: "interior" };
    const gl = DoorGeometry.geom(dl, room);
    ck.eq(JSON.stringify(gl.a), JSON.stringify({ x: 0, y: 1500 }), "mur gauche : ouverture le long de y");
    ck(Math.abs(gl.leafOpen.x - gl.clear) < 1e-6, "mur gauche intérieur : vantail balaie vers +x (dans la salle)");
    // listel borné à [0, demi-largeur] et réutilisé partout (clear + inset des extrémités du passage)
    const gNeg = DoorGeometry.geom({ ...d, frame_mm: -30 }, room);   // frame négatif → 0
    approx(gNeg.clear, 900, "listel négatif → borné à 0 (passage = pleine largeur)");
    ck.eq(JSON.stringify(gNeg.clearHinge), JSON.stringify(gNeg.hinge), "listel négatif → aucun inset (clearHinge = hinge)");
    const gBig = DoorGeometry.geom({ ...d, frame_mm: 999999 }, room);   // frame > w/2 (=450)
    approx(gBig.clear, 0, "listel > demi-largeur → passage borné à 0 (jamais négatif)");
    approx(Math.hypot(gBig.clearHinge.x - g.hinge.x, gBig.clearHinge.y - g.hinge.y), 450, "listel surdimensionné borné à la demi-largeur (extrémités non croisées)");
    // mur BAS (y=h) : ouverture le long de x, charnière/vantail vers l'INTÉRIEUR (y décroît) — couvre la branche `bottom`
    const db = { wall: "bottom", offset: 2000, width_mm: 900, frame_mm: 40, hinge: "left", opening: "interior" };
    const gb = DoorGeometry.geom(db, room);
    ck.eq(JSON.stringify(gb.hinge), JSON.stringify({ x: 1550, y: 4000 }), "mur bas, charnière gauche intérieur → extrémité −x");
    ck.eq(JSON.stringify(gb.leafOpen), JSON.stringify({ x: 1590, y: 3180 }), "mur bas intérieur : vantail vers l'intérieur (y décroît)");
    ck.eq(JSON.stringify(DoorGeometry.geom({ ...db, hinge: "right" }, room).hinge), JSON.stringify({ x: 2450, y: 4000 }), "mur bas, charnière droite → extrémité opposée");
    // mur DROIT (x=w) : ouverture le long de y — couvre la branche `right` (normale, charnière, signe de l'arc)
    const dr = { wall: "right", offset: 2000, width_mm: 1000, frame_mm: 50, hinge: "left", opening: "interior" };
    const gr2 = DoorGeometry.geom(dr, room);
    ck.eq(JSON.stringify(gr2.hinge), JSON.stringify({ x: 6000, y: 2500 }), "mur droit, charnière gauche intérieur → extrémité +y");
    ck.eq(JSON.stringify(gr2.leafOpen), JSON.stringify({ x: 5100, y: 2450 }), "mur droit intérieur : vantail vers l'intérieur (x décroît)");
    ck(DoorGeometry.geom({ ...dr, opening: "exterior" }, room).leafOpen.x > 6000, "mur droit extérieur : vantail hors salle (x > w)");
    // arc sur mur droit : couvre le `sign` de rotation hors du seul cas « mur haut »
    const arcR = DoorGeometry.leafArc(DoorGeometry.leaves(gr2, dr)[0], 8);
    approx(arcR[0].x, gr2.clearLatch.x, "arc mur droit démarre au vantail FERMÉ (x)");
    approx(arcR[0].y, gr2.clearLatch.y, "arc mur droit démarre au vantail FERMÉ (y)");
    approx(arcR[8].x, gr2.leafOpen.x, "arc mur droit finit au vantail OUVERT (x)");
    approx(arcR[8].y, gr2.leafOpen.y, "arc mur droit finit au vantail OUVERT (y)");
  }
  });

  await section("Measure : géométrie pure de mesure (longueur segment · total polyligne, 3D)", async () => {
  {
    ck.eq(Measure.dist({ x: 0, y: 0 }, { x: 3, y: 4 }), 5, "dist : 3-4-5 en 2D (z absent → 0)");
    ck.eq(Measure.dist({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }), 2, "dist : composante z prise en compte");
    ck.eq(Measure.total([{ x: 0, y: 0 }]), 0, "total : < 2 points → 0");
    ck.eq(Measure.total([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 4 }]), 5, "total : somme des segments (dernier nul)");
    ck.eq(Measure.total([{ x: 0, y: 0 }, { x: 0, y: 4 }, { x: 3, y: 4 }]), 7, "total : polyligne 4 + 3 = 7");
    ck.eq(Measure.centroid([]), null, "centroid : nuage vide → null");
    ck.eq(JSON.stringify(Measure.centroid([{ x: 0, y: 0, z: 0 }, { x: 4, y: 2, z: 0 }])), JSON.stringify({ x: 2, y: 1, z: 0 }), "centroid : moyenne des points");
    ck.eq(Measure.centroid([{ x: 3, y: 3 }]).z, 0, "centroid : z absent → 0");
  }
  });

  await section("CableSpline : échantillonnage pur du spline de câble (droit / courbe / amorces)", async () => {
  {
    const A = { x: 0, y: 0, z: 0 }, B = { x: 100, y: 0, z: 0 };
    // < 2 points → renvoyé tel quel (copie)
    ck.eq(CableSpline.sample([{ x: 1, y: 2, z: 3 }], new Set(), 0.25).length, 1, "sample : < 2 points → inchangé");
    // segment DROIT (index 0 dans `straight`) → 2 points, aux extrémités
    const straight = CableSpline.sample([A, B], new Set([0]), 0.25);
    ck.eq(JSON.stringify(straight), JSON.stringify([A, B]), "sample : segment droit → 2 points inchangés");
    // segment COURBE → densifié, commence à A, finit à B
    const curve = CableSpline.sample([A, B], new Set(), 0.25);
    ck(curve.length > 2, "sample : segment courbe → densifié (> 2 points)");
    ck.eq(JSON.stringify(curve[0]), JSON.stringify(A), "sample : commence exactement à P0");
    const last = curve[curve.length - 1];
    ck(Math.abs(last.x - 100) < 1e-6 && Math.abs(last.y) < 1e-6 && Math.abs(last.z) < 1e-6, "sample : finit exactement à P1");
    // 3 points ALIGNÉS sur l'axe x, courbes → la courbe reste sur l'axe (y=z=0)
    const collinear = CableSpline.sample([A, { x: 50, y: 0, z: 0 }, B], new Set(), 0.25);
    ck(collinear.every((p) => Math.abs(p.y) < 1e-6 && Math.abs(p.z) < 1e-6), "sample : points alignés → courbe reste sur l'axe");
  }
  });

  await section("CableSpline.controls : tangentes PARTAGÉES 2D/3D (path SVG ⇄ échantillonnage)", async () => {
  {
    const k = 1 / 6;
    // segment droit → null (chorde) ; intérieur → Catmull-Rom (P[i+1]−P[i−1])·k
    const P = [[0, 0], [100, 0], [200, 100], [300, 100]];
    const cs = CableSpline.controls(P, new Set([0]), k);
    ck.eq(cs[0], null, "segment droit → pas de contrôles (chorde)");
    ck(!!cs[1] && Math.abs(cs[1].c1[0] - (100 + (200 - 0) * k)) < 1e-9, "intérieur : C1 = P + (P[i+1]−P[i−1])·k (Catmull-Rom)");
    // amorce ⟂ : la tangente au point d'amorce est ALIGNÉE sur l'axe du segment droit adjacent (G1)
    const P2 = [[0, 0], [0, 20], [150, 220]];   // segment 0 droit vertical, amorce au point 1
    const c2 = CableSpline.controls(P2, new Set([0]), k, new Set([1]));
    ck(!!c2[1] && Math.abs(c2[1].c1[0] - 0) < 1e-9 && c2[1].c1[1] > 20, "amorce : C1 part le long de l'axe du segment droit (x inchangé)");
    // PARITÉ 3D : sample() consomme les mêmes contrôles — un point échantillonné juste après l'amorce reste sur l'axe
    const P3 = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 20, z: 0 }, { x: 150, y: 220, z: 0 }];
    const line = CableSpline.sample(P3, new Set([0]), k, new Set([1]));
    const justAfter = line[2];   // 1er point de la courbe après le point d'amorce
    ck(Math.abs(justAfter.x) < 2, "parité 3D : la courbe part de l'amorce le long de l'axe (x ≈ 0)");
  }
  });

  await section("GraphGeometry : disposition force-directed (extraite de GraphView, déterministe)", async () => {
  {
    const mkN = (id) => ({ id, name: id, type: "", x: 0, y: 0, vx: 0, vy: 0 });
    // nœud isolé : centré à l'origine par la simulation, puis ancré ≥ 0 par le packing
    const solo = [mkN("s")];
    GraphGeometry.forceLayout(solo, [], 900, 560);
    ck(isFinite(solo[0].x) && isFinite(solo[0].y), "nœud isolé : position finie");
    // paire connectée : les deux nœuds s'écartent (répulsion) mais restent liés (attraction) — distance saine
    const pair = [mkN("a"), mkN("b")];
    GraphGeometry.forceLayout(pair, [{ a: "a", b: "b" }], 900, 560);
    const d = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
    ck(d > 10 && d < 3000, "paire connectée : distance d'équilibre saine (" + Math.round(d) + " px)");
    // DÉTERMINISME : mêmes entrées → même disposition (aucune source aléatoire)
    const pair2 = [mkN("a"), mkN("b")];
    GraphGeometry.forceLayout(pair2, [{ a: "a", b: "b" }], 900, 560);
    ck(Math.abs(pair[0].x - pair2[0].x) < 1e-9 && Math.abs(pair[1].y - pair2[1].y) < 1e-9, "déterministe : deux exécutions identiques");
    // packing : le composant principal est ANCRÉ à l'origine (bbox min ≈ 0), le satellite rangé DESSOUS
    const nodes = [mkN("m1"), mkN("m2"), mkN("m3"), mkN("iso")];
    GraphGeometry.forceLayout(nodes, [{ a: "m1", b: "m2" }, { a: "m2", b: "m3" }], 900, 560);
    const main = nodes.slice(0, 3), iso = nodes[3];
    const bb = GraphGeometry.nodesBBox(main, () => 24);
    ck(bb.minX > -1 && bb.minY > -1, "packing : composant principal ancré à l'origine");
    ck(iso.y > bb.maxY, "packing : le composant satellite est rangé SOUS le principal");
    // placement des nœuds sans position : en grille sous le centroïde des nœuds placés
    const placed = [{ id: "p1", x: 100, y: 100, vx: 0, vy: 0 }, { id: "p2", x: 300, y: 100, vx: 0, vy: 0 }];
    const missing = [mkN("x1"), mkN("x2")];
    GraphGeometry.placeMissingNearCentroid(missing, placed, 450, 280);
    ck(missing.every((n) => n.y === 220) && missing[0].x < missing[1].x, "nœuds manquants : grille sous le centroïde (y = 100 + 120)");
  }
  });

  await section("Homography : redressement de perspective (DLT, ratio, rééchantillonnage)", async () => {
  {
    // IDENTITÉ : carré unité → lui-même ; H (défini à un facteur près) doit appliquer l'identité.
    const sq = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const hId = Homography.solve(sq, sq);
    const [ix, iy] = Homography.apply(hId, 0.3, 0.7);
    ck(Math.abs(ix - 0.3) < 1e-6 && Math.abs(iy - 0.7) < 1e-6, "identité : apply(H, p) = p");
    // TRANSFORMATION CONNUE : carré unité → quad quelconque ; les 4 coins doivent tomber exactement.
    const quad = [[10, 20], [110, 30], [120, 140], [5, 120]];
    const hQ = Homography.solve(sq, quad);
    const ok4 = sq.every((s, i) => { const [x, y] = Homography.apply(hQ, s[0], s[1]); return Math.hypot(x - quad[i][0], y - quad[i][1]) < 1e-4; });
    ck(ok4, "solve : les 4 correspondances sont satisfaites exactement");
    // SUR-DÉTERMINATION (points de bord) : 8 correspondances cohérentes → même homographie (moindres carrés).
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const src8 = sq.concat([mid(sq[0], sq[1]), mid(sq[1], sq[2]), mid(sq[2], sq[3]), mid(sq[3], sq[0])]);
    const dst8 = src8.map((p) => Homography.apply(hQ, p[0], p[1]));
    const h8 = Homography.solve(src8, dst8);
    const [mx, my] = Homography.apply(h8, 0.5, 0.5);
    const [ex, ey] = Homography.apply(hQ, 0.5, 0.5);
    ck(Math.hypot(mx - ex, my - ey) < 1e-4, "moindres carrés : 8 points cohérents → même transformation");
    // RATIO — vue FRONTALE (bords dans le plan image) : ratio EXACT sans focale.
    const rect = [[100, 100], [500, 100], [500, 300], [100, 300]];   // 400 × 200 centré dans une image 600×400
    ck(Math.abs(Homography.estimateAspect(rect, 600, 400) - 2) < 1e-9, "estimateAspect : vue frontale → ratio exact 2");
    // RATIO — perspective à DEUX points de fuite : rectangle 3D 2:1 tourné (Rx·Ry), caméra sténopé
    // f = 800 / centre optique au centre de l'image → la méthode de Zhang doit être EXACTE.
    const W = 1200, Hh = 900, f = 800, rx = 0.4, ry = 0.5, dist = 5;
    const proj = (X, Y) => {
      let x = X, y = Y, z = 0;
      [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];   // rotation Y
      [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];    // rotation X
      z += dist;
      return [W / 2 + (f * x) / z, Hh / 2 + (f * y) / z];
    };
    const persp = [proj(-1, -0.5), proj(1, -0.5), proj(1, 0.5), proj(-1, 0.5)];   // [TL,TR,BR,BL] d'un rectangle 2×1
    const r = Homography.estimateAspect(persp, W, Hh);
    ck(Math.abs(r - 2) < 1e-3, "estimateAspect : deux points de fuite → ratio exact ≈ 2 (obtenu " + r.toFixed(5) + ")");
    // RATIO — UN SEUL point de fuite (bascule autour du seul axe X : bords horizontaux fronto-parallèles) :
    // focale non estimable (dégénéré) → REPLI côtés opposés, fini et plausible (l'exactitude n'est pas atteignable).
    const proj1 = (X, Y) => { const y = Y * Math.cos(0.5), z = dist + Y * Math.sin(0.5); return [W / 2 + (f * X) / z, Hh / 2 + (f * y) / z]; };
    const one = [proj1(-1, -0.5), proj1(1, -0.5), proj1(1, 0.5), proj1(-1, 0.5)];
    const r1 = Homography.estimateAspect(one, W, Hh);
    ck(isFinite(r1) && r1 > 1.5 && r1 < 3, "estimateAspect : un point de fuite → repli fini et plausible (obtenu " + r1.toFixed(3) + ")");
    // WARP — identité : image 2×2 recopiée à l'identique (H sortie→source = identité).
    const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
    const out = Homography.warpBilinear({ data: px, width: 2, height: 2 }, [1, 0, 0, 0, 1, 0, 0, 0, 1], 2, 2);
    ck(out.data[0] === 255 && out.data[1] === 0 && out.data[3] === 255, "warp identité : pixel (0,0) recopié");
    // WARP — hors source : antécédent hors image → pixel transparent (alpha 0).
    const far = Homography.warpBilinear({ data: px, width: 2, height: 2 }, [1, 0, 100, 0, 1, 100, 0, 0, 1], 2, 2);
    ck(far.data[3] === 0, "warp hors source : alpha 0 (transparent)");
    // INVERSE : h⁻¹∘h = identité (aller-retour sur plusieurs points) — sert au recadrage séparé
    const hInv = Homography.invert(hQ);
    const okInv = hInv && [[0.2, 0.3], [0.9, 0.1], [0.5, 0.8]].every(([x, y]) => {
      const [fx, fy] = Homography.apply(hQ, x, y); const [bx, by] = Homography.apply(hInv, fx, fy);
      return Math.hypot(bx - x, by - y) < 1e-6;
    });
    ck(!!okInv, "invert : aller-retour h⁻¹∘h = identité");
    ck.eq(Homography.invert([1, 2, 3, 2, 4, 6, 0, 0, 0]), null, "invert : matrice dégénérée → null");
  }
  });

  await section("RackGeometry : tray (étagère) — longueur effective + boîte utile", async () => {
  {
    const rack = { u_count: 42, depth: 1000, cage_depth_mm: 900, front_margin_mm: 50, width_mm: 600 };
    // longueur EFFECTIVE : dual = pleine cage (depth_mm ignoré) ; cantilever = depth_mm borné à la cage
    ck.eq(RackGeometry.trayLength(rack, { tray_type: "dual", depth_mm: 300 }), 906, "trayLength dual → façade à façade (cage + 2 × réserve d'oreilles, depth_mm ignoré)");
    ck.eq(RackGeometry.trayLength(rack, { tray_type: "cantilever", depth_mm: 400 }), 400, "trayLength cantilever → depth_mm");
    ck.eq(RackGeometry.trayLength(rack, { tray_type: "cantilever", depth_mm: 2000 }), 900, "trayLength cantilever → borné à la cage");
    // boîte UTILE : plateau au BAS de la réservation (+ réserve de tôle 5 mm) → plafond de la réservation.
    // tray_u (hauteur de la structure qui PORTE le plateau, au-dessus) = pure indication de dessin.
    const it = { u: 10, u_height: 3, tray_u: 1, tray_type: "cantilever", depth_mm: 400, side: "front" };
    const b = RackGeometry.trayBoxLocal(rack, it), base = RackGeometry.uBaseZ(rack);
    ck(Math.abs(b.z0 - (base + 9 * U_MM + 5)) < 1e-9, "plancher utile = plateau (bas de réservation) + 5 mm de tôle");
    ck(Math.abs(b.z1 - (base + 12 * U_MM)) < 1e-9, "plafond utile = réservation (u−1+u_height)");
    ck(Math.abs((b.y1 - b.y0) - 400) < 1e-9 && b.front === true, "profondeur utile = longueur du plateau, ancrée au plan de façade");
    ck(Math.abs(b.y0 - (-453)) < 1e-9, "plan de façade = plan de montage − réserve d'oreilles (3 mm)");
    // tray_u N'EXCLUT PAS d'espace : la boîte utile est identique quelle que soit la structure
    const b2 = RackGeometry.trayBoxLocal(rack, Object.assign({}, it, { tray_u: 3 }));
    ck(Math.abs(b2.z0 - b.z0) < 1e-9 && Math.abs(b2.z1 - b.z1) < 1e-9, "tray_u = indication de dessin (boîte utile inchangée)");

    // ---- équipements POSÉS : boîte, rotation, contrôle d'espace, auto-position ----
    const eqA = { name: "A", free_w_mm: 200, free_l_mm: 300, free_h_mm: 80, dc_orientation: 0, tray_x: 0, tray_y: 0 };
    const bA = RackGeometry.trayEquipBoxLocal(rack, it, eqA);
    ck(Math.abs((bA.x1 - bA.x0) - 200) < 1e-9 && Math.abs((bA.y1 - bA.y0) - 300) < 1e-9, "posé : empreinte 200 × 300 sur le plateau");
    ck(Math.abs(bA.z0 - b.z0) < 1e-9 && Math.abs((bA.z1 - bA.z0) - 80) < 1e-9, "posé SUR le plateau (z0 = dessus), hauteur 80");
    const bR = RackGeometry.trayEquipBoxLocal(rack, it, Object.assign({}, eqA, { dc_orientation: 90 }));
    ck(Math.abs((bR.x1 - bR.x0) - 300) < 1e-9 && Math.abs((bR.y1 - bR.y0) - 200) < 1e-9, "rotation 90° : largeur ↔ profondeur");
    ck.eq(RackGeometry.trayEquipFitsWhy(rack, it, eqA, []), null, "fitsWhy : tient (80 ≤ 3 U − 5 mm = 128,35 mm utiles)");
    ck(!!RackGeometry.trayEquipFitsWhy(rack, it, Object.assign({}, eqA, { free_h_mm: 150 }), []), "fitsWhy : 150 mm > 128,35 mm utiles → refus");
    ck(!!RackGeometry.trayEquipFitsWhy(rack, it, Object.assign({}, eqA, { free_l_mm: 500 }), []), "fitsWhy : profondeur 500 > plateau 400 → refus");
    ck(!!RackGeometry.trayEquipFitsWhy(rack, it, Object.assign({}, eqA, { tray_x: 400 }), []), "fitsWhy : position hors plateau → refus");
    const other = { name: "B", free_w_mm: 100, free_l_mm: 300, free_h_mm: 80, dc_orientation: 0, tray_x: 0, tray_y: 0 };
    ck(String(RackGeometry.trayEquipFitsWhy(rack, it, eqA, [other])).includes("chevauche"), "fitsWhy : chevauchement détecté");
    const spot = RackGeometry.trayFindSpot(rack, it, eqA, [other]);
    ck(!!spot && !RackGeometry.trayEquipFitsWhy(rack, it, Object.assign({}, eqA, { tray_x: spot.x, tray_y: spot.y }), [other]), "findSpot : auto-position valide en évitant l'occupant");
    // AUTO-POSITION AMÉLIORÉE — plateau 444,6 mm utilisables (452,6 corps − 2 × 4 garde), profondeur 400 mm.
    // 1) plateau VIDE : équipement (w=100) CENTRÉ en largeur ET en profondeur (place distribuée autour).
    const solo = RackGeometry.trayFindSpot(rack, it, { free_w_mm: 100, free_l_mm: 100, free_h_mm: 40, dc_orientation: 0 }, []);
    ck(Math.abs(solo.x - (444.6 - 100) / 2) < 1 && Math.abs(solo.y - (400 - 100) / 2) < 1, "findSpot vide : centré en largeur et profondeur");
    // 2) CÔTE À CÔTE : un colocataire (w=100) posé à gauche → le nouveau se place à la MÊME profondeur
    // (même rangée), centré dans le plus grand intervalle libre à sa droite, sans chevauchement.
    const co = { free_w_mm: 100, free_l_mm: 100, free_h_mm: 40, dc_orientation: 0, tray_x: 0, tray_y: 150 };
    const s2 = RackGeometry.trayFindSpot(rack, it, { free_w_mm: 100, free_l_mm: 100, free_h_mm: 40, dc_orientation: 0 }, [co]);
    ck(Math.abs(s2.y - 150) < 1, "findSpot côte à côte : même rangée (profondeur du colocataire)");
    ck(s2.x >= 100 - 0.5, "findSpot côte à côte : à droite du colocataire (pas de chevauchement)");
    ck.eq(RackGeometry.trayEquipFitsWhy(rack, it, Object.assign({ free_w_mm: 100, free_l_mm: 100, free_h_mm: 40, dc_orientation: 0 }, { tray_x: s2.x, tray_y: s2.y }), [co]), null, "findSpot côte à côte : position valide");
    // milieu du plus grand intervalle [100, 444,6] → centre ≈ (100 + 444,6 − 100)/2 = 222,3
    ck(Math.abs(s2.x - (100 + (444.6 - 100 - 100) / 2)) < 1.5, "findSpot : centré dans le plus grand intervalle libre");
    // REFLOW UNIFORME : 3 équipements (w=100) sur 444,6 utiles → 4 espaces égaux de (444,6−300)/4 = 36,15 ;
    // positions x = 36,15 · 172,3 · 308,45 ; tous centrés en profondeur.
    const three = [0, 1, 2].map(() => ({ free_w_mm: 100, free_l_mm: 100, free_h_mm: 40, dc_orientation: 0 }));
    const arr = RackGeometry.trayArrange(rack, it, three);
    ck(!!arr && arr.length === 3, "trayArrange : 3 positions");
    const g = (444.6 - 300) / 4;
    ck(Math.abs(arr[0].x - g) < 0.5 && Math.abs(arr[1].x - (2 * g + 100)) < 0.5 && Math.abs(arr[2].x - (3 * g + 200)) < 0.5, "trayArrange : espaces horizontaux ÉGAUX");
    ck(arr.every((p) => Math.abs(p.y - (400 - 100) / 2) < 0.5), "trayArrange : tous centrés en profondeur");
    // espaces uniformes = écarts entre bords consécutifs (bord gauche, entre 1-2, entre 2-3, bord droit) tous ≈ g
    const gaps = [arr[0].x, arr[1].x - (arr[0].x + 100), arr[2].x - (arr[1].x + 100), 444.6 - (arr[2].x + 100)];
    ck(gaps.every((v) => Math.abs(v - g) < 0.5), "trayArrange : marges de bord = interstices (distribution uniforme)");
    // ne tient pas côte à côte → null (repli findSpot côté appelant)
    ck.eq(RackGeometry.trayArrange(rack, it, [0, 1, 2, 3, 4].map(() => ({ free_w_mm: 100, free_l_mm: 100, free_h_mm: 40, dc_orientation: 0 }))), null, "trayArrange : 5 × 100 > 444,6 → null");
    // GARDE LATÉRALE des renforts (porte-à-faux) : 4 mm de chaque côté, la pose s'y refuse
    ck.eq(b.xInset, 4, "cantilever → garde latérale 4 mm (xInset)");
    ck(Math.abs(bA.x0 - (b.x0 + 4)) < 1e-9, "posé : bord gauche décalé de la garde (x0 = plateau + 4 mm)");
    const usableW = (b.x1 - b.x0) - 8;   // corps 19″ − 2 × 4
    ck.eq(RackGeometry.trayEquipFitsWhy(rack, it, { free_w_mm: usableW, free_l_mm: 200, free_h_mm: 80, dc_orientation: 0, tray_x: 0, tray_y: 0 }, []), null, "largeur = zone utilisable → tient");
    ck(!!RackGeometry.trayEquipFitsWhy(rack, it, { free_w_mm: usableW + 2, free_l_mm: 200, free_h_mm: 80, dc_orientation: 0, tray_x: 0, tray_y: 0 }, []), "largeur > zone utilisable (garde renforts) → refus");
    // DUAL : pas de renforts latéraux → aucune garde
    ck.eq(RackGeometry.trayBoxLocal(rack, { u: 10, u_height: 3, tray_u: 1, tray_type: "dual", side: "front" }).xInset, 0, "dual → aucune garde latérale");
  }
  });

  await section("RackGeometry/Depths : profondeur en MM (legacy→mm, occupation découplée, dispo)", async () => {
  {
    // conversion legacy → mm (migration)
    ck.eq(Depths.legacyToMm("half", 800), 400, "legacyToMm : half sur cage 800 → 400");
    ck.eq(Depths.legacyToMm("quarter", 1000), 250, "legacyToMm : quarter sur cage 1000 → 250");
    ck.eq(Depths.legacyToMm("full", 900), 900, "legacyToMm : full → cage entière");
    // mountLocksU DÉCOUPLÉ : l'enum « full » ne verrouille QUE pré-migration ; ensuite locks_u fait foi
    ck(RackGeometry.mountLocksU({ depth: "full", depth_mm: null }), "legacy full non migré → verrouille les 2 faces");
    ck(!RackGeometry.mountLocksU({ depth: "full", depth_mm: 600, locks_u: false }), "migré : depth passif ignoré, locks_u false fait foi");
    ck(RackGeometry.mountLocksU({ depth_mm: 600, locks_u: true }), "locks_u explicite → verrouille");
    ck(!RackGeometry.mountLocksU({ depth: "half", depth_mm: null, locks_u: false }), "legacy half → une seule face");
    // profondeurs disponibles (dépassement + dos-à-dos) — parité avec shared/DataValidation (RackDepth)
    const rk = { depth: 1000, cage_depth_mm: 900, front_margin_mm: 50 };
    ck.eq(RackGeometry.rearMargin(rk), 50, "marge arrière = 1000 − cage 900 − avant 50");
    ck.eq(RackGeometry.mountAvailDepth(rk, "front"), 950, "dispo ancrage avant = 1000 − 50");
    ck.eq(RackGeometry.mountAvailDepth(rk, "rear"), 950, "dispo ancrage arrière = 1000 − 50");
    ck.eq(RackGeometry.sharedMountDepth(rk), 900, "espace partagé dos-à-dos = cage");
    const rkDoor = { depth: 1000, cage_depth_mm: 900, front_margin_mm: 50, door_front: { enabled: true, hollow: true, hollow_mm: 60 } };
    ck.eq(RackGeometry.mountAvailDepth(rkDoor, "front"), 1010, "cavité de porte creuse ajoutée (950 + 60)");
  }
  });

  await section("ImageStitch : assemblage de photos redressées (resize, gain, fondu, recadrage, affinage)", async () => {
  {
    // petit constructeur d'image brute : lum(x,y) → pixel gris opaque
    const mkRaw = (w, h, lum) => {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, v = lum(x, y); d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
      return { data: d, width: w, height: h };
    };
    // RESIZE : uni 1×1 → 3×2 uni ; dégradé 2×1 → 4×1 : extrémités PURES (clamp aux bords)
    const uni = ImageStitch.resizeBilinear(mkRaw(1, 1, () => 137), 3, 2);
    ck(uni.width === 3 && uni.height === 2 && uni.data[0] === 137 && uni.data[3 * 2 * 4 - 1] === 255, "resize : uni 1×1 → 3×2 uni");
    const grad = ImageStitch.resizeBilinear(mkRaw(2, 1, (x) => x ? 200 : 0), 4, 1);
    ck(grad.data[0] === 0 && grad.data[12] === 200 && grad.data[4] < grad.data[8], "resize : dégradé — extrémités pures, milieu croissant");
    // GAIN : A à 200, B à 100, recouvrement complet → ×2 (borne haute)
    ck.eq(ImageStitch.gainForB(mkRaw(8, 8, () => 200), mkRaw(8, 8, () => 100), 0, 0), 2, "gainForB : 200/100 → 2");
    // FONDU (seam "feather") : A à 100 (4×2), B à 220 (4×2) posé à dx=2 → composite 6×2 ; A pur à gauche,
    // B pur à droite, rampe croissante dans le recouvrement [2,4) ; alpha opaque partout.
    const bl = ImageStitch.blend(mkRaw(4, 2, () => 100), mkRaw(4, 2, () => 220), 2, 0, "h", 1, "feather");
    ck(bl.img.width === 6 && bl.img.height === 2 && bl.ox === 0 && bl.oy === 0, "blend : union 6×2, origine (0,0)");
    const px = (x) => bl.img.data[(0 * 6 + x) * 4];
    ck(px(0) === 100 && px(5) === 220 && px(2) === 100 && px(3) > 100 && px(3) < 220, "blend fondu : A pur | rampe | B pur");
    ck(bl.img.data[(1 * 6 + 4) * 4 + 3] === 255, "blend : alpha opaque");
    // COUPE FRANCHE (seam "cut", DÉFAUT) : la 1re photo PRIORITAIRE sur tout le recouvrement — aucun mélange ;
    // B n'apparaît qu'au-delà de A (croppée à la jonction).
    const bc = ImageStitch.blend(mkRaw(4, 2, () => 100), mkRaw(4, 2, () => 220), 2, 0, "h");
    const pc = (x) => bc.img.data[(0 * 6 + x) * 4];
    ck(pc(2) === 100 && pc(3) === 100 && pc(4) === 220 && pc(5) === 220, "blend coupe franche : A jusqu'à sa fin, B croppée à la jonction");
    // RECADRAGE AUTO (h) : dy=1 → union en x, INTERSECTION en y (coupe les bandes transparentes)
    const r = ImageStitch.autoCropRect({ width: 4, height: 4 }, { width: 4, height: 4 }, 3, 1, "h");
    ck(r.x === 0 && r.w === 7 && r.y === 1 && r.h === 3, "autoCropRect : union x (0..7), intersection y (1..4)");
    const cropped = ImageStitch.crop(bl.img, 1, 0, 4, 2);
    ck(cropped.width === 4 && cropped.height === 2 && cropped.data[0] === 100, "crop : dims + contenu");
    // AFFINAGE : B = extrait de A décalé — refine retrouve le décalage exact depuis une position approchée
    const A = mkRaw(24, 24, (x, y) => (x * 7 + y * 13 + ((x * y) % 5) * 31) % 256);   // texture non périodique
    const B = ImageStitch.crop(A, 5, 3, 12, 12);   // B s'aligne exactement à (dx,dy) = (5,3)
    const best = ImageStitch.refine(A, B, 7, 5, 4);   // départ décalé de (2,2), recherche ±4
    ck(best.dx === 5 && best.dy === 3, "refine : retrouve l'alignement exact (5,3) depuis (7,5)");
  }
  });

  await section("FreeEquipGeometry : faceFraction = inverse de faceLocal (plaquage des images de façade)", async () => {
  {
    const { FreeEquipGeometry } = D("geometry/FreeEquipGeometry.js");
    const approx = (a, b, name) => ck(Math.abs(a - b) <= 1e-9, name + "  (attendu ≈" + b + ", obtenu " + a + ")");
    const eq = { free_w_mm: 600, free_l_mm: 400, free_h_mm: 300 };
    // ALLER-RETOUR sur les 6 faces (points non triviaux) : faceLocal(fx,fy) → faceFraction → (fx,fy) inchangés.
    ["front", "rear", "left", "right", "top", "bottom"].forEach((face) => {
      [[0, 0], [1, 0], [0.25, 0.7]].forEach(([fx, fy]) => {
        const p = FreeEquipGeometry.faceLocal(eq, face, fx, fy, 0);
        const f = FreeEquipGeometry.faceFraction(eq, face, p.lx, p.ly, p.lz, 0);
        approx(f.fx, fx, "roundtrip " + face + " fx(" + fx + "," + fy + ")");
        approx(f.fy, fy, "roundtrip " + face + " fy(" + fx + "," + fy + ")");
      });
    });
    // Orientation ARRIÈRE (le bug corrigé : image à 180° en 3D) : fy=0 = HAUT (z max), fx=0 = +X (gauche vue de derrière).
    const rTop = FreeEquipGeometry.faceFraction(eq, "rear", 0, 200, 300, 0);   // coin z=h (haut), x=0 (centre)
    approx(rTop.fy, 0, "rear : z = h → fy = 0 (haut de l'image en haut)");
    const rLeft = FreeEquipGeometry.faceFraction(eq, "rear", 300, 200, 150, 0);   // x = +w/2
    approx(rLeft.fx, 0, "rear : x = +w/2 → fx = 0 (gauche de l'image, vue de derrière)");
    // DESSUS : fy=0 = avant (−Y) — convention faceLocal (« dessus/dessous : fy = profondeur, 0 = avant −Y »).
    const tFront = FreeEquipGeometry.faceFraction(eq, "top", 0, -200, 300, 0);
    approx(tFront.fy, 0, "top : y = −d/2 (avant) → fy = 0");
  }
  });

  await section("RackDoorGeometry : débattement des portes de baie (partagé 2D/3D)", async () => {
  {
    const { RackDoorGeometry } = D("geometry/RackDoorGeometry.js");
    const w = 800, d = 1000;
    // porte AVANT, charnière gauche, pleine : pivot sur l'arête EXTÉRIEURE (d/2 + épaisseur), ouverture vers −Y.
    const s = RackDoorGeometry.swingSector(w, d, false, { thickness_mm: 40, hinge: "left" });
    ck.eq(s.hx, -w / 2 + 40, "pivot X = bord gauche + épaisseur");
    ck.eq(s.hy, -(d / 2 + 40), "pivot Y = arête extérieure (face + épaisseur), côté avant (−Y)");
    ck.eq(s.R, w - 40, "rayon = largeur du vantail (largeur − épaisseur)");
    // fin d'arc = vantail OUVERT : R(beta)·(dirX·R, 0) = (0, sgn·R) → pointe vers l'extérieur (−Y devant)
    const pts = RackDoorGeometry.sectorPointsOf(s, 4);
    const last = pts[pts.length - 1];
    ck(Math.abs(last.x - s.hx) < 1e-6 && Math.abs(last.y - (s.hy - s.R)) < 1e-6, "fin d'arc : vantail ouvert perpendiculaire, vers l'extérieur");
    // CAVITÉ (porte creuse) : le pivot recule d'autant — c'était la DIVERGENCE 2D/3D tranchée par la mutualisation.
    const sc = RackDoorGeometry.swingSector(w, d, false, { thickness_mm: 40, hinge: "left", hollow: true, hollow_mm: 60 });
    ck.eq(sc.hy, -(d / 2 + 60 + 40), "cavité : pivot décalé de hollow_mm en plus (parité 2D = 3D)");
    // porte ARRIÈRE, charnière droite : miroir complet (pivot +Y, charnière inversée vue de la face).
    const sr = RackDoorGeometry.swingSector(w, d, true, { thickness_mm: 40, hinge: "right" });
    ck.eq(sr.hy, d / 2 + 40, "arrière : pivot +Y");
    ck.eq(sr.hx, -w / 2 + 40, "arrière + charnière droite : côté inversé vue de la face");
    ck.eq(RackDoorGeometry.swingSector(w, d, false, { thickness_mm: 2, hinge: "left" }).hx, -w / 2 + 6, "épaisseur plancher 6 mm");
    // VANTAUX : simple → 1 secteur identique à l'historique ; DOUBLE BATTANT → 2 secteurs, pivots aux DEUX bords,
    // rayon = demi-largeur − épaisseur, ouvertures symétriques (loquets au centre). `hinge` sans effet en double.
    const one = RackDoorGeometry.swingSectors(w, d, false, { thickness_mm: 40, hinge: "left" });
    ck.eq(one.length, 1, "swingSectors(simple) : 1 secteur");
    ck.eq(JSON.stringify(one[0]), JSON.stringify(s), "swingSectors(simple) : identique à swingSector");
    const two = RackDoorGeometry.swingSectors(w, d, false, { thickness_mm: 40, hinge: "left", leaves: 2 });
    ck.eq(two.length, 2, "swingSectors(double) : 2 secteurs");
    ck.eq(two[0].hx, -w / 2 + 40, "double : pivot 1 au bord gauche");
    ck.eq(two[1].hx, w / 2 - 40, "double : pivot 2 au bord droit");
    ck.eq(two[0].R, w / 2 - 40, "double : rayon = demi-largeur − épaisseur");
    ck.eq(two[0].R, two[1].R, "double : rayons égaux (demi-vantaux symétriques)");
    ck.eq(two[0].dirX, 1, "double : vantail gauche fermé vers +X (loquet au centre)");
    ck.eq(two[1].dirX, -1, "double : vantail droit fermé vers −X (loquet au centre)");
    // fin d'arc des DEUX vantaux : perpendiculaires, vers l'extérieur (−Y à l'avant)
    two.forEach((sec, i) => {
      const p = RackDoorGeometry.sectorPointsOf(sec, 4); const last = p[p.length - 1];
      ck(Math.abs(last.x - sec.hx) < 1e-6 && Math.abs(last.y - (sec.hy - sec.R)) < 1e-6, "double : vantail " + (i + 1) + " ouvert perpendiculaire, vers l'extérieur");
    });
  }
  });
};
