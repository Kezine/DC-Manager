/* ============================================================================
   NetMap — Tests AU NIVEAU MODULES (TypeScript compilé, sans navigateur).
   ----------------------------------------------------------------------------
   Filet de régression de la migration : exerce les couches DÉJÀ portées
   (modèle de domaine, couche données, Store) directement sur les modules
   compilés (dist-test/, via `tsc -p tsconfig.node.json`). Complète le harnais
   legacy Tests/run.js, qui teste encore le HTML monolithique tant que la
   géométrie / les vues n'y sont pas portées.

   Usage :  npm run test:modules   (compile puis exécute ce fichier)
   ============================================================================ */
"use strict";
const path = require("path");
const D = (p) => require(path.join(__dirname, "..", "..", "dist-test", p));

/* -------- stubs navigateur minimaux (storage en mémoire) -------- */
const mkStorage = () => {
  let m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
    clear: () => { m = {}; },
    key: (i) => Object.keys(m)[i] || null,
    get length() { return Object.keys(m).length; },
  };
};
global.window = { localStorage: mkStorage(), sessionStorage: mkStorage() };

/* -------- modules sous test -------- */
const { Store } = D("store/Store.js");
const { BrowserStorageAdapter } = D("data/BrowserStorageAdapter.js");
const { FieldIndex } = D("data/FieldIndex.js");
const { Equipment, Cable, Port } = D("models/index.js");
const { Normalize } = D("core/Normalize.js");
const { Labeler } = D("core/Labeler.js");
const { ClickGuard } = D("core/ClickGuard.js");
const { Projection } = D("geometry/Projection.js");
const { Box } = D("geometry/Box.js");
const { Painter } = D("geometry/Painter.js");
const { RackGeometry } = D("geometry/RackGeometry.js");
const { GraphGeometry } = D("geometry/GraphGeometry.js");
const { EquipmentTypes, PortRoles, Depths, EquipFaces } = D("registries/index.js");
const { RackScene } = D("geometry/RackScene.js");
const { Resolver3D } = D("geometry/Resolver3D.js");
const { U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE } = D("domain/constants.js");
const { Html } = D("core/Html.js");
const { Color } = D("core/Color.js");
const { Format } = D("core/Format.js");
const { GridGeometry } = D("geometry/GridGeometry.js");
const { GraphView } = D("views/GraphView.js");
const { Sort } = D("core/Sort.js");
const { Ip } = D("core/Ip.js");

async function makeStore() {
  const s = new Store(new BrowserStorageAdapter({ persistent: false }));
  await s.init();
  await s.newDocument();
  return s;
}

/* -------- mini-framework -------- */
let pass = 0, fail = 0; const failures = [];
const ck = (cond, name) => { if (cond) pass++; else { fail++; failures.push(name); } console.log((cond ? "  ✓ " : "  ✗ FAIL ") + name); };
ck.eq = (a, b, name) => ck(a === b, name + "  (attendu " + JSON.stringify(b) + ", obtenu " + JSON.stringify(a) + ")");

(async () => {
  console.log("NetMap — Tests modules (TypeScript compilé)\n");

  console.log("• Entités : normalisation au constructeur");
  {
    const e = new Equipment({});
    ck.eq(e.depth, "full", "Equipment.depth défaut = full");
    ck.eq(e.locks_u, true, "Equipment.locks_u = true quand full");
    ck.eq(e.placement_mode, "manual", "Equipment.placement_mode défaut = manual");
    ck.eq(e.dim_mode, "free", "Equipment.dim_mode déduit = free (manuel)");
    ck.eq(new Equipment({ placement_mode: "rack" }).dim_mode, "u", "rack ⇒ dim_mode = u");
    const c1 = new Cable({ network_id: "n1" });
    ck.eq(JSON.stringify(c1.network_ids), JSON.stringify(["n1"]), "Cable.network_ids normalisé depuis network_id");
    const c2 = new Cable({ network_ids: ["a", "a", "b"], network_id: "b" });
    ck.eq(JSON.stringify(c2.network_ids), JSON.stringify(["a", "b"]), "Cable.network_ids dédupliqué");
    ck.eq(c2.network_id, "b", "Cable.network_id principal préservé");
  }

  console.log("\n• FieldIndex : sémantique d'égalité");
  {
    ck(FieldIndex.valueMatches(["a", "b"], "a"), "valueMatches : tableau contient");
    ck(FieldIndex.valueMatches(null, null), "valueMatches : null ⇔ vide");
    ck(FieldIndex.valueMatches("", null), "valueMatches : \"\" ⇔ vide");
    ck(!FieldIndex.valueMatches("x", "y"), "valueMatches : x ≠ y");
  }

  console.log("\n• Store : CRUD + index FK");
  {
    const s = await makeStore();
    const rack = await s.create("racks", { name: "R1" });
    const eq = await s.create("equipments", { name: "sw1", type: "switch", rack_id: rack.id, placement_mode: "rack", rack_u: 1 });
    const p1 = await s.create("ports", { equipment_id: eq.id, name: "g1" });
    const p2 = await s.create("ports", { equipment_id: eq.id, name: "g2" });
    ck.eq(s.portsOf(eq.id).length, 2, "portsOf = 2");
    ck.eq(s.equipmentsOfRack(rack.id).length, 1, "equipmentsOfRack = 1");
    ck.eq(s.get("equipments", eq.id).name, "sw1", "get() sert le cache");
    const cab = await s.create("cables", { from_port_id: p1.id, to_port_id: p2.id });
    ck.eq(s.cablesOfPort(p1.id).length, 1, "cablesOfPort = 1");
    ck.eq(s.cablesOfPort(p1.id)[0].id, cab.id, "cablesOfPort renvoie le bon câble");
  }

  console.log("\n• Store : cascade de suppression");
  {
    const s = await makeStore();
    const eq = await s.create("equipments", { name: "sw" });
    const p1 = await s.create("ports", { equipment_id: eq.id });
    const p2 = await s.create("ports", { equipment_id: eq.id });
    const cab = await s.create("cables", { from_port_id: p1.id, to_port_id: p2.id });
    await s.remove("equipments", eq.id);
    ck.eq(s.get("equipments", eq.id), null, "équipement supprimé");
    ck.eq(s.get("ports", p1.id), null, "port 1 supprimé (cascade)");
    ck.eq(s.get("ports", p2.id), null, "port 2 supprimé (cascade)");
    ck.eq(s.get("cables", cab.id), null, "câble supprimé (cascade, dédup)");
  }

  console.log("\n• Store : undo / redo");
  {
    const s = await makeStore();
    const before = s.totalCount();
    const eq = await s.create("equipments", { name: "tmp" });
    ck.eq(s.totalCount(), before + 1, "create → +1");
    ck(s.canUndo(), "canUndo après create");
    await s.undo();
    ck.eq(s.totalCount(), before, "undo → retour au compte initial");
    ck.eq(s.get("equipments", eq.id), null, "undo → équipement absent");
    await s.redo();
    ck.eq(s.totalCount(), before + 1, "redo → ré-appliqué");
    ck(!!s.get("equipments", eq.id), "redo → équipement présent");
  }

  console.log("\n• Store : clone d'équipement (ports + agrégats)");
  {
    const s = await makeStore();
    const eq = await s.create("equipments", { name: "src", rack_id: "rack-x", placement_mode: "rack", rack_u: 5 });
    await s.create("ports", { equipment_id: eq.id, name: "a" });
    await s.create("ports", { equipment_id: eq.id, name: "b" });
    const copy = await s.cloneEquipment(eq.id);
    ck(copy && copy.id !== eq.id, "clone a un nouvel id");
    ck.eq(copy.name, "src (copie)", "clone : nom suffixé");
    ck.eq(copy.rack_id, null, "clone : placement rack réinitialisé");
    ck.eq(s.portsOf(copy.id).length, 2, "clone : 2 ports clonés");
    ck(s.portsOf(copy.id).every((p) => p.equipment_id === copy.id), "clone : ports ré-aiguillés");
  }

  console.log("\n• Géométrie & couleurs (pures)");
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

  console.log("\n• RackGeometry (pure)");
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

  console.log("\n• ClickGuard (pure)");
  {
    const g = (dn, x, y, t, r) => ClickGuard.blocks(dn, x, y, t, r);
    ck.eq(g([100, 100], 100, 100, 4, false), false, "normale : immobile → passe");
    ck.eq(g([100, 100], 110, 100, 4, false), true, "normale : >4px → bloque");
    ck.eq(g([100, 100], 104, 100, 4, false), false, "normale : ==4px → passe (seuil strict)");
    ck.eq(g(null, 100, 100, 4, false), false, "normale : dn=null → passe");
    ck.eq(g(null, 100, 100, 4, true), true, "reservePan : dn=null → bloque");
    ck.eq(g([0, 0], 3, 3, 4, false), true, "euclidien : (3,3)=4.24px → bloque");
  }

  console.log("\n• Box.faces / Painter.farFirst (pures)");
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

  console.log("\n• GraphGeometry (pure)");
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

  console.log("\n• Labeler & registres de libellés (purs)");
  {
    ck.eq(JSON.stringify(Normalize.uniqIds(["a", "b", "a", "c", "b"])), JSON.stringify(["a", "b", "c"]), "uniqIds : dédoublonne, garde le 1er");
    const list = [{ id: "a", label: "Alpha" }, { id: "b", label: "Bravo" }];
    ck.eq(Labeler.make(list)("a"), "Alpha", "Labeler : trouve le label");
    ck.eq(Labeler.make(list)("zzz"), "", "Labeler : absent + défaut → \"\"");
    ck.eq(Labeler.make(list, "—")("zzz"), "—", "Labeler : fallback valeur");
    ck.eq(Labeler.make(list, (v) => v || "?")("zzz"), "zzz", "Labeler : fallback fonction");
    ck.eq(Depths.label("none"), "No-depth", "Depths.label(none) → No-depth");
    ck.eq(Depths.label("__inconnu__"), "__inconnu__", "Depths.label(inconnu) → id");
    ck.eq(PortRoles.label("__inconnu__"), "__inconnu__", "PortRoles.label(inconnu) → id");
    ck.eq(PortRoles.label(""), "—", "PortRoles.label(vide) → —");
    ck.eq(EquipFaces.label("__inconnu__"), "Avant", "EquipFaces.label(inconnu) → Avant");
    ck.eq(EquipmentTypes.label(""), "—", "EquipmentTypes.label(vide) → —");
  }

  console.log("\n• RackScene : occupation des U (rackOccupants)");
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
  }

  console.log("\n• RackScene + RackGeometry : side-mount");
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

  console.log("\n• RackScene + RackGeometry : wall-mount");
  {
    const s = await makeStore();
    const rs = new RackScene(s);
    const dc = await s.create("datacenters", { name: "DC" });
    const rack = await s.create("racks", { name: "R", width_mm: 600, depth: 1200, u_count: 42, front_margin_mm: 200, cage_depth_mm: 700, datacenter_id: dc.id, dc_x: 2000, dc_y: 2000 });
    ck(RackGeometry.wallEnabled(rack, "front") === true, "wallEnabled(front) avec marge ≥ 1U");
    const eq = await s.create("equipments", { name: "WALL", placement_mode: "wall", dim_mode: "free", rack_id: rack.id, wall_lr: "left", wall_margin: "front", wall_col: 0, wall_u: 5, wall_orient: "center", free_w_mm: 80, free_h_mm: 150, free_l_mm: 100 });
    ck.eq(rs.wallOccupants(rack.id, "front", "left").length, 1, "wallOccupants(front,left) = 1");
    ck(rs.wallSlotFree(rack.id, "left", "front", 0, 5, 2, null) === false, "wallSlotFree : bande occupée = false");
    ck(rs.wallSlotFree(rack.id, "left", "front", 0, 35, 2, null) === true, "wallSlotFree : bande libre = true");
    ck(rs.wallFreeSlots(rack).length > 0, "wallFreeSlots non vide");
    const wbox = RackGeometry.wallEquipBoxLocal(rack, eq);
    ck(wbox.n && (wbox.n.x !== 0 || wbox.n.y !== 0), "wallEquipBoxLocal : normale définie");
    ck(wbox.z1 > wbox.z0, "wallEquipBoxLocal : hauteur cohérente");
  }

  console.log("\n• Resolver3D : resolvePort3D (rack / side / wall / libre)");
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

  console.log("\n• Resolver3D : waypointPassPoints / waypointAnchor");
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

  console.log("\n• Helpers partagés purs (Html / Color / Format / GridGeometry)");
  {
    ck.eq(Html.escape('<a b="c">&\''), "&lt;a b=&quot;c&quot;&gt;&amp;&#39;", "Html.escape : entités");
    ck.eq(Html.escape(null), "", "Html.escape(null) → \"\"");
    ck.eq(JSON.stringify(Color.hexToRgb("#ff8800")), JSON.stringify({ r: 255, g: 136, b: 0 }), "Color.hexToRgb(#ff8800)");
    ck.eq(Color.hexToRgb("xyz"), null, "Color.hexToRgb(invalide) → null");
    ck.eq(Color.contrastText("#ffffff"), "#000", "contrastText(blanc) → #000");
    ck.eq(Color.contrastText("#000000"), "#fff", "contrastText(noir) → #fff");
    ck.eq(Format.meters(1234), "1.23 m", "Format.meters(1234)");
    ck.eq(Format.dateTime(""), "—", "Format.dateTime(vide) → —");
    ck.eq(GridGeometry.cellKey(3, -2), "3,-2", "GridGeometry.cellKey");
    ck.eq(JSON.stringify(GridGeometry.cellOf(650, 50, 600)), JSON.stringify({ cx: 1, cy: 0 }), "GridGeometry.cellOf");
    ck(GridGeometry.isCellBlocked(["1,0", "2,3"], 1, 0) === true, "isCellBlocked : présent");
    ck(GridGeometry.isCellBlocked(["1,0"], 5, 5) === false, "isCellBlocked : absent");
    ck(GridGeometry.spanHitsBlocked(["1,1"], 600, 600, 1200, 1200, 600) === true, "spanHitsBlocked : touche (1,1)");
    ck(GridGeometry.spanHitsBlocked(["5,5"], 0, 0, 600, 600, 600) === false, "spanHitsBlocked : aucune");
  }

  console.log("\n• GraphView (pilote) : build + layout (sans DOM)");
  {
    const s = await makeStore();
    const sw = await s.create("equipments", { name: "sw", type: "switch" });
    const srv = await s.create("equipments", { name: "srv", type: "serveur" });
    await s.create("equipments", { name: "stock", type: "autre", inventory_only: true });
    const p1 = await s.create("ports", { equipment_id: sw.id, name: "a" });
    const p2 = await s.create("ports", { equipment_id: srv.id, name: "b" });
    await s.create("cables", { name: "lnk", from_port_id: p1.id, to_port_id: p2.id });
    const fakeStage = { clientWidth: 900, clientHeight: 560 };
    const gv = new GraphView(s, fakeStage, {});
    gv.computeVisible();
    ck.eq(gv.nodes.length, 2, "computeVisible : 2 nœuds (inventory_only exclu)");
    ck.eq(gv.edges.length, 1, "computeVisible : 1 arête");
    ck(gv.edges[0].a === sw.id && gv.edges[0].b === srv.id, "arête relie sw↔srv");
    gv.layout();
    ck(gv.nodes.every((n) => isFinite(n.x) && isFinite(n.y)), "layout : positions finies");
    ck(gv.nodes[0].x !== gv.nodes[1].x || gv.nodes[0].y !== gv.nodes[1].y, "layout : nœuds séparés");
    gv.selectAll();
    ck.eq(gv.selection.size, 2, "selectAll : 2 nœuds sélectionnés");
  }

  console.log("\n• Sort.compare (tri de liste)");
  {
    ck(Sort.compare(1, 2) < 0, "compare : 1 < 2");
    ck(Sort.compare("b", "a") > 0, "compare : b > a");
    ck.eq(Sort.compare("a", "a"), 0, "compare : a == a");
    ck(Sort.compare("", "x") > 0, "compare : vide en dernier");
    ck(Sort.compare("item2", "item10") < 0, "compare : numérique naturel (2 < 10)");
  }

  console.log("\n• Ip (IPv4 / CIDR pur)");
  {
    ck.eq(Ip.toInt("10.0.0.1"), 167772161, "toInt(10.0.0.1)");
    ck.eq(Ip.toInt("256.0.0.1"), null, "toInt invalide → null");
    ck.eq(Ip.toStr(167772161), "10.0.0.1", "toStr round-trip");
    const c = Ip.parseCidr("10.0.0.0/24");
    ck(c && c.networkStr === "10.0.0.0" && c.broadcastStr === "10.0.0.255", "parseCidr /24 network+broadcast");
    ck.eq(c.hostCount, 254, "parseCidr /24 → 254 hôtes");
    ck.eq(Ip.parseCidr("10.0.0.0/33"), null, "parseCidr préfixe invalide → null");
    ck(Ip.inCidr(Ip.toInt("10.0.0.42"), c) === true, "inCidr : 10.0.0.42 ∈ /24");
    ck(Ip.inCidr(Ip.toInt("10.0.1.1"), c) === false, "inCidr : 10.0.1.1 ∉ /24");
    ck.eq(Ip.parseCidr("10.0.0.5/24").networkStr, "10.0.0.0", "parseCidr normalise sur l'adresse réseau");
  }

  console.log("\n" + "-".repeat(48));
  console.log("Résultat : " + pass + " PASS, " + fail + " FAIL");
  if (fail) { console.log("Échecs :\n  - " + failures.join("\n  - ")); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("\n✗ HARNAIS A LEVÉ :", e && e.stack ? e.stack : e); process.exit(1); });
