/* Tests modules — géométrie pure (racks, salles, portes, splines, positionnement, 3D).
   Sections extraites de run.js (audit P5) ; harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, mkStorage, Store, BrowserStorageAdapter, FieldIndex, Equipment, Cable, Port, Normalize, Labeler, ClickGuard, Projection, Box, Painter, RackGeometry, GraphGeometry, EquipmentTypes, PortRoles, Depths, EquipFaces, RackScene, Resolver3D, U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE, Html, Color, Format, GridGeometry, GraphView, Sort, Ip, Prefs, DatacenterView, FloorLayout, Positioning, DoorGeometry, Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM, DoorTool, Measure, CableSpline, MeasureTool, RouteTool, ImageStore, FaceImage, SaveState, EntityRegistry, ReloadPlanner, COLLECTION_THREE_IMPACT, RenderImpact, Changeset, SharedSchema, Text, PAGE_SIZE_DEFAULT, Validation, Cascade, Rack, CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS, makeStore } = require("./harness.js");

module.exports = async () => {
  await section("Géométrie & couleurs (pures)", async () => {
  {
    const q = Projection.project3D({ x: 10, y: 20, z: 30 });
    ck.eq(q.h, 10, "project3D : h = X"); ck.eq(q.v, 20, "project3D : v = Y"); ck.eq(q.depth, 30, "project3D : depth = Z");
    const c1 = EquipmentTypes.color("switch"), c2 = EquipmentTypes.color("switch");
    ck(typeof c1 === "string" && c1.length > 0, "equipmentTypeColor → couleur non vide");
    ck.eq(c1, c2, "equipmentTypeColor : déterministe (mémo)");
    ck.eq(EquipmentTypes.color("hors-liste-xyz"), EquipmentTypes.color("hors-liste-xyz"), "equipmentTypeColor : hash stable hors catalogue");
    ck(COLOR_PALETTE.includes(c1), "equipmentTypeColor : valeur ∈ COLOR_PALETTE");
    ck([0, 90, 180, 270].includes(Normalize.rackOrientation(450)), "normRackOrientation(450) ∈ {0,90,180,270}");
  }
  });

  await section("RackGeometry (pure)", async () => {
  {
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
    const mk = async () => (await s.create("ports", { equipment_id: (await s.create("equipments", { name: "e" })).id, name: "p" })).id;
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
    // arc de débattement : 15 points, du vantail fermé (clearLatch) à l'ouvert (leafOpen)
    const arc = DoorGeometry.arcPoints(g, 14);
    ck.eq(arc.length, 15, "arcPoints : n+1 points");
    approx(arc[0].x, g.clearLatch.x, "arc démarre au vantail FERMÉ (x)");
    approx(arc[0].y, g.clearLatch.y, "arc démarre au vantail FERMÉ (y)");
    approx(arc[14].x, g.leafOpen.x, "arc finit au vantail OUVERT (x)", 1e-6);
    approx(arc[14].y, g.leafOpen.y, "arc finit au vantail OUVERT (y)", 1e-6);
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
    const arcR = DoorGeometry.arcPoints(gr2, 8);
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
    const pts = RackDoorGeometry.sectorPoints(w, d, false, { thickness_mm: 40, hinge: "left" }, 4);
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
  }
  });
};
