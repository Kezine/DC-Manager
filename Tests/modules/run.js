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
const { U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE } = D("domain/constants.js");

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

  console.log("\n" + "-".repeat(48));
  console.log("Résultat : " + pass + " PASS, " + fail + " FAIL");
  if (fail) { console.log("Échecs :\n  - " + failures.join("\n  - ")); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("\n✗ HARNAIS A LEVÉ :", e && e.stack ? e.stack : e); process.exit(1); });
