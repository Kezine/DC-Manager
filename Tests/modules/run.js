/* ============================================================================
   DC Manager — Tests AU NIVEAU MODULES (TypeScript compilé, sans navigateur).
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
// Depuis l'ajout du code PARTAGÉ (shared/) au programme, le rootDir inféré devient la racine du dépôt :
// la sortie de compilation place les modules `src/` sous `dist-test/src/` et `shared/` sous `dist-test/shared/`.
const D = (p) => require(path.join(__dirname, "..", "..", "dist-test", "src", p));        // modules du front (src/…)
const SHARED = (p) => require(path.join(__dirname, "..", "..", "dist-test", p));           // code partagé (shared/…)

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
const { Prefs } = D("core/Prefs.js");
const { DatacenterView } = D("views/DatacenterView.js");
const { FloorLayout } = D("geometry/FloorLayout.js");
const { Positioning } = D("geometry/Positioning.js");
const { DoorGeometry } = D("geometry/DoorGeometry.js");
const { Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM } = D("domain/Doors.js");
const { ImageStore } = D("data/ImageStore.js");
const { FaceImage } = D("models/index.js");
const { SaveState, computeSaveState, shouldAutosave } = D("app/SaveState.js");
const { EntityRegistry } = D("models/index.js");
const { ReloadPlanner } = D("sync/ReloadPlanner.js");
const { COLLECTION_THREE_IMPACT, RenderImpact } = D("sync/RenderImpact.js");
const { Changeset } = D("sync/Changeset.js");
const { Schema: SharedSchema } = SHARED("shared/Schema.js");
const { Text } = D("core/Text.js");
const { PAGE_SIZE_DEFAULT } = D("data/config.js");
const Validation = SHARED("shared/DataValidation.js");
const { Cascade } = SHARED("shared/Cascade.js");
const { Rack } = D("models/index.js");
const { CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS } = D("domain/constants.js");

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
  console.log("DC Manager — Tests modules (TypeScript compilé)\n");

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

  console.log("\n• shared : Cascade.plan (intégrité référentielle PARTAGÉE — front ⇄ back)");
  {
    // Jeu de données en mémoire + capacités injectées (find/fetch), comme côté serveur (repo) ou Store (_byFk).
    const db = {
      racks: [{ id: "R1" }],
      rackItems: [{ id: "ri1", rack_id: "R1" }, { id: "ri2", rack_id: "R2" }],
      equipments: [{ id: "E1", name: "srv", rack_id: "R1", placement_mode: "rack" }, { id: "E2", rack_id: "R1" }],
      ports: [{ id: "P1", equipment_id: "E1" }, { id: "P2", equipment_id: "E1" }],
      aggregates: [{ id: "A1", equipment_id: "E1" }],
      cables: [
        { id: "C1", from_port_id: "P1", to_port_id: "P2" },
        // route traversant DEUX brosses de la baie R1 (+ un waypoint tiers "X") → doit être nettoyée EN UNE FOIS
        { id: "C2", from_port_id: null, to_port_id: null, waypoint_ids: ["WB1", "X", "WB2"] },
      ],
      ipAddresses: [{ id: "IP1", equipment_id: "E1" }],
      dhcpRanges: [{ id: "D1", server_id: "E1" }],
      spares: [{ id: "S1", assigned_equipment_id: "E1", status: "assigned" }],
      datacenters: [{ id: "DC1" }],
      waypoints: [
        { id: "W1", datacenter_id: "DC1" },
        // brosses MONTÉES dans R1 (rack_id) : la suppression de la baie doit les supprimer (invariant T1).
        { id: "WB1", kind: "brush", datacenter_id: "DC1", rack_id: "R1", rack_u: 10 },
        { id: "WB2", kind: "brush", datacenter_id: "DC1", rack_id: "R1", rack_u: 12 },
      ],
    };
    const find = (coll, field, value) => (db[coll] || []).filter((o) => {
      const v = o[field];
      return Array.isArray(v) ? v.includes(value) : v === value;
    });
    const fetch = (coll, id) => (db[coll] || []).find((o) => o.id === id) || null;

    // -- rack : enfants supprimés (rackItems) + équipements détachés (rack_id null, placement manuel) --
    const rackPlan = Cascade.plan("racks", "R1", find, fetch);
    ck.eq(rackPlan.deletes.some((d) => d.c === "rackItems" && d.id === "ri1"), true, "rack : rackItem enfant supprimé");
    ck.eq(rackPlan.deletes.some((d) => d.id === "ri2"), false, "rack : rackItem d'une AUTRE baie épargné");
    const detachE1 = rackPlan.detaches.filter((d) => d.c === "equipments" && d.id === "E1");
    ck.eq(detachE1.some((d) => d.key === "rack_id" && d.value === null), true, "rack : équipement détaché (rack_id null)");
    ck.eq(detachE1.some((d) => d.key === "placement_mode" && d.value === "manual"), true, "rack : équipement repassé en manuel");
    // brosses montées : SUPPRIMÉES avec la baie (sinon rack_id pend / invariant T1 bloque le nullage → doc invalide)
    ck.eq(rackPlan.deletes.some((d) => d.c === "waypoints" && d.id === "WB1"), true, "rack : brosse montée WB1 supprimée");
    ck.eq(rackPlan.deletes.some((d) => d.c === "waypoints" && d.id === "WB2"), true, "rack : brosse montée WB2 supprimée");
    // route de câble : UN SEUL détachement waypoint_ids retirant les DEUX brosses d'un coup (pas d'écrasement)
    const c2det = rackPlan.detaches.filter((d) => d.c === "cables" && d.id === "C2" && d.key === "waypoint_ids");
    ck.eq(c2det.length, 1, "rack : câble touché → 1 seul détachement waypoint_ids (dédup, pas de dernier-gagne)");
    ck.eq(JSON.stringify(c2det[0] && c2det[0].value), JSON.stringify(["X"]), "rack : les 2 brosses retirées de la route en une passe");

    // -- équipement : ports + agrégats supprimés, câble des ports supprimé, IP/DHCP détachés --
    const eqPlan = Cascade.plan("equipments", "E1", find, fetch);
    ck.eq(eqPlan.deletes.some((d) => d.c === "ports" && d.id === "P1"), true, "équip. : port supprimé");
    ck.eq(eqPlan.deletes.some((d) => d.c === "aggregates" && d.id === "A1"), true, "équip. : agrégat supprimé");
    ck.eq(eqPlan.deletes.some((d) => d.c === "cables" && d.id === "C1"), true, "équip. : câble des ports supprimé");
    ck.eq(eqPlan.detaches.some((d) => d.c === "ipAddresses" && d.key === "equipment_id" && d.value === null), true, "équip. : IP détachée (registre conservé)");
    ck.eq(eqPlan.detaches.some((d) => d.c === "dhcpRanges" && d.key === "server_id" && d.value === null), true, "équip. : rôle serveur DHCP détaché");
    // spare : bascule en texte libre (info préservée) + FK détachée
    ck.eq(eqPlan.detaches.some((d) => d.c === "spares" && d.key === "assigned_free" && d.value === "srv"), true, "équip. : spare préservé en texte libre (nom)");
    ck.eq(eqPlan.detaches.some((d) => d.c === "spares" && d.key === "assigned_equipment_id" && d.value === null), true, "équip. : spare FK détachée");

    // -- datacenter : waypoints (et racks/équipements) détachés, jamais supprimés --
    const dcPlan = Cascade.plan("datacenters", "DC1", find, fetch);
    ck.eq(dcPlan.deletes.length, 0, "datacenter : aucune suppression (que des détachements)");
    ck.eq(dcPlan.detaches.some((d) => d.c === "waypoints" && d.key === "datacenter_id" && d.value === null), true, "datacenter : waypoint détaché");

    // -- collection sans règle de cascade : plan vide --
    const noop = Cascade.plan("floors", "F1", find, fetch);
    ck.eq(noop.deletes.length + noop.detaches.length, 0, "collection sans règle → plan vide");
  }

  console.log("\n• Store : rechargement granulaire (P2 — reloadCollections / reloadMeta)");
  {
    const s = await makeStore();
    const eq = await s.create("equipments", { name: "A" });
    await s.create("ports", { equipment_id: eq.id });
    // simule un AUTRE client : écrit DIRECTEMENT dans l'adapter → le store en mémoire reste périmé
    await s.adapter.transact({
      updates: [{ collection: "equipments", id: eq.id, record: Object.assign(eq.toJSON(), { name: "B" }) }],
      creates: [{ collection: "ports", record: { id: "P_ext", equipment_id: eq.id } }],
    });
    ck.eq(s.get("equipments", eq.id).name, "A", "avant reload : équipement périmé (en mémoire)");
    ck.eq(s.portsOf(eq.id).length, 1, "avant reload : 1 port en mémoire");
    // rechargement CIBLÉ : équipements seulement
    const done = await s.reloadCollections(["equipments"]);
    ck.eq(done.join(","), "equipments", "reloadCollections renvoie les collections rechargées");
    ck.eq(s.get("equipments", eq.id).name, "B", "équipement rafraîchi depuis l'adapter");
    ck.eq(s.portsOf(eq.id).length, 1, "ports NON rechargés (granularité) → encore périmés");
    // recharge les ports → l'index FK est reconstruit (le port externe apparaît)
    await s.reloadCollections(["ports"]);
    ck.eq(s.portsOf(eq.id).length, 2, "après reload ports : index FK reconstruit (port externe inclus)");
    ck.eq(!!s.get("ports", "P_ext"), true, "port externe présent après reload");
    // dédup + collection inconnue ignorées
    ck.eq((await s.reloadCollections(["equipments", "equipments", "pasUneCollection"])).length, 1, "dédup + collection inconnue ignorée");
    // méta rechargée à part (changement externe de nom de document)
    await s.adapter.saveMeta(Object.assign(s.toJSON().meta, { docName: "Renommé" }));
    await s.reloadMeta();
    ck.eq(s.meta.docName, "Renommé", "reloadMeta : méta rafraîchie depuis l'adapter");
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
    const rack = await s.create("racks", { name: "RK" });   // FK réelle (la validation référentielle exige un rack existant)
    const eq = await s.create("equipments", { name: "src", rack_id: rack.id, placement_mode: "rack", rack_u: 5 });
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
    // occupantsElev (rendu 3D) : un occupant équipement, U10 hauteur 2, face avant.
    const el = rs.occupantsElev(rack.id);
    ck.eq(el.length, 1, "occupantsElev : 1 occupant");
    ck(el[0].kind === "eq" && el[0].u === 10 && el[0].h === 2 && el[0].side === "front", "occupantsElev : eq U10 h2 front");
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

  console.log("\n• Resolver3D : répartition conduit (grille / dims / offsets)");
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

  console.log("\n• Store : route de câble (grammaire exit/OOB) + faisceaux");
  {
    const s = await makeStore();
    const dcA = await s.create("datacenters", { name: "Salle A" });
    const dcB = await s.create("datacenters", { name: "Salle B" });
    const rkA = await s.create("racks", { name: "RA", u_count: 42, datacenter_id: dcA.id, dc_x: 500, dc_y: 500 });
    const rkB = await s.create("racks", { name: "RB", u_count: 42, datacenter_id: dcB.id, dc_x: 500, dc_y: 500 });
    const mkEqPort = async (rack, u) => { const e = await s.create("equipments", { name: "e" + u, placement_mode: "rack", rack_id: rack.id, rack_u: u }); return (await s.create("ports", { equipment_id: e.id, name: "p" })).id; };
    const pA1 = await mkEqPort(rkA, 1), pA2 = await mkEqPort(rkA, 2), pB1 = await mkEqPort(rkB, 1);
    // waypoints : datacenter (posé), exits (posés), OOB
    const dcWpA = await s.create("waypoints", { wp_type: "datacenter", datacenter_id: dcA.id, dc_x: 600, dc_y: 600 });
    const exitA = await s.create("waypoints", { wp_type: "exit", datacenter_id: dcA.id, dc_x: 0, dc_y: 0 });
    const exitB = await s.create("waypoints", { wp_type: "exit", datacenter_id: dcB.id, dc_x: 0, dc_y: 0 });
    const oob = await s.create("waypoints", { wp_type: "oob", floor: "1" });

    // intra-salle (2 ports même salle, sans waypoint) → valide, pas d'exit
    let r = s.cableRoute({ from_port_id: pA1, to_port_id: pA2, waypoint_ids: [] });
    ck(r.valid && !r.hasExits, "route intra-salle (sans waypoint) → valide, sans exit");
    // waypoint de salle dans la BONNE salle → valide
    r = s.cableRoute({ from_port_id: pA1, to_port_id: pA2, waypoint_ids: [dcWpA.id] });
    ck(r.valid, "waypoint de salle dans la bonne salle → valide");
    // deux salles SANS exits → invalide
    r = s.cableRoute({ from_port_id: pA1, to_port_id: pB1, waypoint_ids: [] });
    ck(!r.valid, "ports dans deux salles sans exits → invalide");
    // route inter-salles exitA → OOB → exitB → valide, startDc/endDc
    r = s.cableRoute({ from_port_id: pA1, to_port_id: pB1, waypoint_ids: [exitA.id, oob.id, exitB.id] });
    ck(r.valid && r.hasExits, "exit A → OOB → exit B → valide, hasExits");
    ck.eq(r.startDc, dcA.id, "route : startDc = Salle A");
    ck.eq(r.endDc, dcB.id, "route : endDc = Salle B");
    // OOB hors d'un tronçon exit → invalide
    r = s.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: [oob.id] });
    ck(!r.valid, "OOB hors d'une paire d'exits → invalide");
    // exit non appairé → invalide
    r = s.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: [exitA.id] });
    ck(!r.valid, "exit non appairé → invalide");
    // -- CODES STABLES d'erreur + helpers (les appelants réagissent au code, PAS au libellé) --
    ck.eq(s.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: [oob.id] }).errors[0].code, "floor_outside", "code : pin d'étage hors tronçon → floor_outside");
    ck.eq(r.errors.some((e) => e.code === "exit_unpaired"), true, "code : exit seul → exit_unpaired");
    // routeHasRoomBreak : waypoint de salle APRÈS l'exit de sa salle (exit terminal) → rupture de cohérence
    ck.eq(s.routeHasRoomBreak({ from_port_id: null, to_port_id: null, waypoint_ids: [exitA.id, dcWpA.id] }), true, "routeHasRoomBreak : wp de salle après son exit → true");
    ck.eq(s.routeHasRoomBreak({ from_port_id: pA1, to_port_id: pA2, waypoint_ids: [dcWpA.id] }), false, "routeHasRoomBreak : route intra-salle cohérente → false");
    ck.eq(s.routeHasRoomBreak({ from_port_id: null, to_port_id: null, waypoint_ids: [exitA.id] }), false, "routeHasRoomBreak : exit non appairé n'est PAS un room break (toléré au fil de l'eau)");
    // routeStructuralError : exit non appairé = STRUCTUREL (bloque l'enregistrement) ; 2 salles sans exit = incomplétude (brouillon OK)
    const se = s.routeStructuralError({ from_port_id: null, to_port_id: null, waypoint_ids: [exitA.id] });
    ck.eq(se && se.code, "exit_unpaired", "routeStructuralError : exit non appairé → structurel");
    ck.eq(s.routeStructuralError({ from_port_id: pA1, to_port_id: pB1, waypoint_ids: [] }), null, "routeStructuralError : ports 2 salles sans exit = incomplétude, PAS structurel");
    // résumé lisible
    const okRoute = s.cableRoute({ from_port_id: pA1, to_port_id: pB1, waypoint_ids: [exitA.id, oob.id, exitB.id] });
    ck(s.cableRouteSummary(okRoute).indexOf("Salle A") >= 0 && s.cableRouteSummary(okRoute).indexOf("ét. 1") >= 0, "cableRouteSummary mentionne Salle A et ét. 1");
    // statut maximal : incomplet → brouillon ; intra complet+posé → câblé
    ck.eq(s.cableMaxStatus({ from_port_id: pA1, to_port_id: null, cable_type_id: null, waypoint_ids: [] }), "brouillon", "cableMaxStatus(incomplet) → brouillon");
    // contrainte de salle d'un bout
    const k = s.cableSideConstraint({ from_port_id: null, to_port_id: pB1, waypoint_ids: [exitA.id, oob.id, exitB.id] }, "A");
    ck.eq(k.dcId, dcA.id, "cableSideConstraint(A) impose la salle de départ");

    // faisceaux : un brin hérite la route du trunk ; occupation
    const ct = s.all("cableTypes")[0];
    const bundle = await s.create("cableBundles", { name: "T1", cable_type_id: ct ? ct.id : null, fiber_count: 4, waypoint_ids: [exitA.id, oob.id, exitB.id] });
    const strand = await s.create("cables", { name: "brin1", bundle_id: bundle.id, strand_no: 1 });
    ck.eq(JSON.stringify(s.effectiveWaypointIds(strand)), JSON.stringify([exitA.id, oob.id, exitB.id]), "effectiveWaypointIds(brin) → route du trunk");
    const occ = s.bundleOccupancy(bundle.id);
    ck(occ.used === 1 && occ.capacity === 4 && occ.free === 3 && occ.nextStrand === 2, "bundleOccupancy : 1/4 utilisé, nextStrand=2");
    // equipmentDcId via baie hôte
    const eqInA = s.get("ports", pA1) ? s.get("equipments", s.get("ports", pA1).equipment_id) : null;
    ck.eq(s.equipmentDcId(eqInA.id), dcA.id, "equipmentDcId(équipement racké) → salle de la baie");

    // contrainte de placement (câblage) : un équipement LIBRE câblé intra-salle vers pA1 (Salle A)
    const eqX = await s.create("equipments", { name: "X" });
    const pX = (await s.create("ports", { equipment_id: eqX.id, name: "pX" })).id;
    await s.create("cables", { name: "lien", from_port_id: pX, to_port_id: pA1 });
    ck.eq(s.equipmentPlacementBlockedReason(eqX.id, dcA.id), null, "blockedReason : pose dans la salle câblée → autorisée");
    ck(typeof s.equipmentPlacementBlockedReason(eqX.id, dcB.id) === "string", "blockedReason : pose dans une AUTRE salle → bloquée");
    ck(s.equipmentRequiredDcs(eqX.id).has(dcA.id), "equipmentRequiredDcs : contraint à la Salle A");
    // applyCableBreaks : deux bouts dans des salles différentes SANS exits → câble cassé (bout distant déconnecté)
    const eqY = await s.create("equipments", { name: "Y", placement_mode: "rack", rack_id: rkB.id, rack_u: 5 });
    const pY = (await s.create("ports", { equipment_id: eqY.id, name: "pY" })).id;
    const pX2 = (await s.create("ports", { equipment_id: eqX.id, name: "pX2" })).id;   // pX porte déjà « lien » (1 câble/port)
    await s.update("equipments", eqX.id, { placement_mode: "rack", dim_mode: "u", rack_id: rkA.id, rack_u: 5 });
    const brk = await s.create("cables", { name: "casse-moi", from_port_id: pX2, to_port_id: pY, status: "cable" });
    ck(s.cableContextValid(brk) === false, "cableContextValid : 2 salles sans exits → invalide");
    const n = await s.applyCableBreaks(eqX.id);
    ck.eq(n, 1, "applyCableBreaks : 1 câble cassé");
    const brk2 = s.get("cables", brk.id);
    ck(brk2.status === "casse" && brk2.to_port_id === null, "applyCableBreaks : statut « cassé » + bout distant déconnecté");
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

  console.log("\n• Store : portConnectorSize (taille connecteur 3D)");
  {
    const s = await makeStore();
    const e = await s.create("equipments", { name: "x" });
    const pNoType = await s.create("ports", { equipment_id: e.id, name: "q" });
    ck.eq(JSON.stringify(s.portConnectorSize(pNoType)), JSON.stringify({ w: 13, h: 12 }), "portConnectorSize sans type → défaut RJ45 13×12");
    const sfp = s.all("portTypes").find((t) => (t.connector || t.family) === "SFP+");
    if (sfp) { const p = await s.create("ports", { equipment_id: e.id, name: "p", port_type_id: sfp.id }); const sz = s.portConnectorSize(p); ck(sz.w === 14 && sz.h === 9, "portConnectorSize(SFP+) → 14×9"); }
  }

  console.log("\n• DatacenterView : persistance de l'état de vue (par fichier)");
  {
    const s = await makeStore();
    s.meta.fileId = "F1";
    const dv = new DatacenterView(s, {}, {});   // garde headless
    window.localStorage.setItem("dcmanager.view3d.F1", JSON.stringify({ az: 1.23, el: 0.5, scale: 2, tx: 10, ty: 20, camTarget: { x: 1, y: 2, z: 3 }, showAllCables: false, showPorts: false, hideFrontEq: true, dcId: "ghost", hidden3dRacks: ["ghost"] }));
    dv.restoreView();
    ck(Math.abs(dv.az - 1.23) < 1e-9 && dv.scale === 2 && dv.tx === 10, "restore : caméra (az/scale/tx)");
    ck(dv.showAllCables === false && dv.showPorts === false && dv.hideFrontEq === true, "restore : toggles d'affichage");
    ck.eq(dv.hidden3dRacks.size, 0, "restore : baie inexistante ignorée (failsafe)");
    window.localStorage.removeItem("dcmanager.view3d.F1");
    dv.restoreView();
    ck(Math.abs(dv.az - (-0.62)) < 1e-9 && dv.scale === null && dv.showAllCables === true && dv.hideFrontEq === false, "restore : défauts quand état absent");
    window.localStorage.clear();
  }

  console.log("\n• Prefs (préférences globales · localStorage)");
  {
    window.localStorage.clear();
    const p = new Prefs();
    ck.eq(p.theme, "dark", "défaut : thème dark");
    ck.eq(p.autosave, false, "défaut : auto-save off");
    ck.eq(p.autosaveInterval, Prefs.INTERVAL_DEFAULT, "défaut : intervalle = " + Prefs.INTERVAL_DEFAULT);
    ck.eq(p.dataSource, "local", "défaut : source local");
    p.theme = "light"; p.autosave = true; p.autosaveInterval = 30;
    const p2 = new Prefs();   // recharge depuis localStorage
    ck.eq(p2.theme, "light", "thème persisté (light)");
    ck.eq(p2.autosave, true, "auto-save persisté (on)");
    ck.eq(p2.autosaveInterval, 30, "intervalle persisté (30)");
    p.autosaveInterval = -5;  // valeur invalide → repli sur le défaut
    ck.eq(p.autosaveInterval, Prefs.INTERVAL_DEFAULT, "intervalle ≤ 0 → repli défaut");
    window.localStorage.clear();
  }

  console.log("\n• DatacenterView : presets caméra + résolution de câbles (helpers partagés avec la 2D)");
  {
    // NB : le moteur 3D SVG legacy (projection orbitale, builders) a été retiré — la 3D passe par le moteur WebGL.
    // Ne subsistent côté vue que les helpers de câbles partagés avec les vues 2D (resolvedCables / outgoingCableStubs).
    const s = await makeStore();
    const dv = new DatacenterView(s, {}, {});   // garde headless (pas de document) → méthodes pures testables
    dv.setCamPreset("top"); ck(Math.abs(dv.el - Math.PI / 2) < 1e-9, "preset « Dessus » → élévation π/2");
    dv.setCamPreset("front"); ck(dv.az === 0 && dv.el === 0, "preset « Face » → az=0, el=0");

    // résolution des câbles INTRA-salle : 2 équipements rackés reliés → 1 câble résolu (2 points).
    const dc = await s.create("datacenters", { name: "DC" });
    const rk = await s.create("racks", { name: "R", u_count: 42, datacenter_id: dc.id, dc_x: 500, dc_y: 500 });
    const mkEqPort = async (u) => { const e = await s.create("equipments", { name: "e" + u, placement_mode: "rack", rack_id: rk.id, rack_u: u }); return (await s.create("ports", { equipment_id: e.id, name: "p", face_x: 0.5, face_y: 0.5 })).id; };
    const pa = await mkEqPort(1), pb = await mkEqPort(2);
    await s.create("cables", { name: "patch", from_port_id: pa, to_port_id: pb });
    const rcs = dv.resolvedCables(dc.id);
    ck.eq(rcs.length, 1, "resolvedCables : 1 câble intra-salle");
    ck(rcs[0].pts.length === 2 && rcs[0].pts.every((p) => isFinite(p.x) && isFinite(p.z)), "resolvedCables : 2 points finis (sans waypoint)");
    // câbles SORTANTS : port local → exit de la salle (un seul bout résolu ici)
    const dc2 = await s.create("datacenters", { name: "DC2" });
    const rk2 = await s.create("racks", { name: "R2", u_count: 42, datacenter_id: dc2.id, dc_x: 500, dc_y: 500 });
    const e2 = await s.create("equipments", { name: "e2", placement_mode: "rack", rack_id: rk2.id, rack_u: 1 });
    const pc = (await s.create("ports", { equipment_id: e2.id, name: "p", face_x: 0.5, face_y: 0.5 })).id;
    const exit1 = await s.create("waypoints", { wp_type: "exit", datacenter_id: dc.id, dc_x: 0, dc_y: 0 });
    const exit2 = await s.create("waypoints", { wp_type: "exit", datacenter_id: dc2.id, dc_x: 0, dc_y: 0 });
    const paOut = await mkEqPort(3);   // pa porte déjà « patch » (1 câble/port) → port distinct pour le câble inter
    const outCable = await s.create("cables", { name: "inter", from_port_id: paOut, to_port_id: pc, waypoint_ids: [exit1.id, exit2.id] });
    ck(s.cableRoute(outCable).valid && s.cableRoute(outCable).hasExits, "câble inter-salles : route valide avec exits");
    const stubs = dv.outgoingCableStubs(dc.id);
    ck.eq(stubs.length, 1, "outgoingCableStubs : 1 câble sortant de la salle");
    ck(stubs[0].cable.id === outCable.id && stubs[0].pts.length >= 2 && stubs[0].pts.every((p) => isFinite(p.x) && isFinite(p.y) && isFinite(p.z)), "outgoingCableStubs : port → exit, points finis");
    ck.eq(dv.outgoingCableStubs(dc.id).length + dv.outgoingCableStubs(dc2.id).length, 2, "outgoingCableStubs : tracé dans CHAQUE salle traversée");
    // routes INTER-DC (multi-salles) : déléguées au service de routage `CableRouting` (réutilisé par le moteur WebGL).
    const mInter = new FloorLayout(s).multiLayout(dc, { visibleDcIds: new Set([dc.id, dc2.id]) });
    const inter = dv.routing.interDcRoutes(mInter, false);
    ck.eq(inter.length, 1, "routing.interDcRoutes : 1 route inter-salles");
    ck(inter[0].cable.id === outCable.id && inter[0].pts.length >= 2 && inter[0].pts.every((p) => isFinite(p.x) && isFinite(p.y) && isFinite(p.z)), "routing.interDcRoutes : port A → port B, points monde finis");
    // route builder : départ port A → waypoint → port B → ouvre le form câble prérempli
    // (on pose routeBuild directement : routeArm/routeStart émettent un toast → besoin du DOM, absent ici)
    let routed = null;
    const dvr = new DatacenterView(s, {}, { openCableForm: (id, opts) => { routed = { id, opts }; } });
    dvr.routeBuild = { fromPortId: pa, wpIds: [] };
    dvr.routeAddWp(exit1.id); ck.eq(JSON.stringify(dvr.routeBuild.wpIds), JSON.stringify([exit1.id]), "routeAddWp : waypoint ajouté");
    dvr.routeFinish(pc);
    ck(routed && routed.id === null && routed.opts.fromPortId === pa && routed.opts.toPortId === pc && JSON.stringify(routed.opts.waypointIds) === JSON.stringify([exit1.id]), "routeFinish → openCableForm prérempli (from/to/waypoints)");
    ck.eq(dvr.routeBuild, null, "routeFinish : session terminée");
    // brouillons-candidats : un câble draft à un seul bout est proposé pour un port compatible
    const pDraft = await mkEqPort(4);   // port libre distinct pour le brouillon (pa porte déjà « patch »)
    const draft = await s.create("cables", { name: "brouillon", from_port_id: pDraft, to_port_id: null, status: "brouillon" });
    const cands = s.cableDraftCandidatesForPort(pb);
    ck(cands.some((c) => c.id === draft.id), "cableDraftCandidatesForPort : draft à un bout proposé");
    ck(!s.cableDraftCandidatesForPort(pDraft).some((c) => c.id === draft.id), "cableDraftCandidatesForPort : pas le port déjà branché");
    // vue Dessus : aimantation au centre de maille + demi-emprise selon l'orientation
    ck.eq(dv.snap(610, 600), 900, "snap → centre de maille (610 → 900)");
    ck.eq(dv.snap(290, 600), 300, "snap → centre de maille (290 → 300)");
    // vue Étage : aimantation au BORD de maille (coin de salle) + résolution de l'étage cible
    ck.eq(dv.snapEdge(610, 600), 600, "snapEdge → bord de maille (610 → 600)");
    ck.eq(dv.snapEdge(910, 600), 1200, "snapEdge → bord de maille (910 → 1200)");
    const dcLoc = await s.create("datacenters", { name: "L1", location: "liege", floor: "2" });
    dv.dcId = dcLoc.id; dv.floorTarget = null;
    ck.eq(JSON.stringify(dv.floorTargetResolve()), JSON.stringify({ location: "liege", floor: "2" }), "floorTargetResolve → étage de la salle active");
    dv.floorTarget = { location: "herstal", floor: "0" };
    ck.eq(dv.floorTargetResolve().location, "herstal", "floorTargetResolve → cible explicite prioritaire");
    dv.floorTarget = null; dv.dcId = dc.id;
    // brosse de brassage : waypoint kind "brush" ancré à la baie → occupe ses U (bloque les emplacements libres)
    await s.create("waypoints", { wp_type: "datacenter", kind: "brush", datacenter_id: dc.id, rack_id: rk.id, rack_u: 20, u_height: 2 });
    const scn = new RackScene(s); const occB = scn.occupants(rk.id);
    ck(occB.has("20:front") && occB.has("21:front"), "brosse : occupe ses U (20–21 front)");
    ck.eq(scn.occupants(rk.id, { exceptBrushId: s.all("waypoints").find((w) => w.kind === "brush").id }).has("20:front"), false, "brosse : exclue via exceptBrushId");
    ck.eq(JSON.stringify(dv.rackHalfExtents({ width_mm: 600, depth: 1000, orientation: 0 })), JSON.stringify({ hx: 300, hy: 500 }), "rackHalfExtents 0° → (w/2, d/2)");
    ck.eq(JSON.stringify(dv.rackHalfExtents({ width_mm: 600, depth: 1000, orientation: 90 })), JSON.stringify({ hx: 500, hy: 300 }), "rackHalfExtents 90° → (d/2, w/2)");
    // recherche + visibilité câble (panneaux de contrôle)
    dv.searchTerm = "core"; ck(dv.matchSearch("Core-SW") === true && dv.matchSearch("srv-01") === false, "matchSearch (insensible casse)"); dv.searchTerm = "";
    dv.showAllCables = true; ck(dv.cableShown({ cable: { id: "x" } }) === true, "cableShown : tout affiché → vrai");
    dv.showAllCables = false; ck(dv.cableShown({ cable: { id: "x" } }) === false, "cableShown : non sélectionné → faux");
    dv.selCables = new Set(["x"]); ck(dv.cableShown({ cable: { id: "x" } }) === true, "cableShown : sélectionné → vrai");
    // NB : coloration d'équipement (eqFill), largeur de vue (camViewWidthM) et éclairs power (cableIsPower) étaient
    // des helpers du moteur 3D SVG retiré — ils vivent désormais dans le moteur WebGL (occColor / updateScreenScales).
  }

  console.log("\n• FloorLayout : disposition multi-salles (étages empilés, bâtiments côte à côte)");
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

  console.log("\n• Positioning : aide au positionnement (cœur pur — coins, cotes ⟂, placement, accrochage)");
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

  console.log("\n• DoorGeometry : portes de salle (ouverture, listel, passage libre, débattement)");
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

  console.log("\n• Doors : domaine des portes de salle (valeurs canoniques, libellés, défauts, règles pures)");
  {
    ck.eq(Doors.wallLabel("top"), "avant", "wallLabel(top) = avant");
    ck.eq(Doors.wallLabel("bottom"), "arrière", "wallLabel(bottom) = arrière");
    ck.eq(Doors.wallLabel("inconnu"), "inconnu", "wallLabel : mur inconnu → renvoyé tel quel");
    ck.eq(Doors.isVerticalWall("left"), true, "isVerticalWall(left) = true");
    ck.eq(Doors.isVerticalWall("top"), false, "isVerticalWall(top) = false");
    ck.eq(Doors.freeWidth({ width_mm: 900, frame_mm: 40 }), 820, "freeWidth = width − 2·frame");
    ck.eq(Doors.freeWidth({ width_mm: 60, frame_mm: 40 }), 0, "freeWidth borné à 0 (listel > demi-largeur)");
    ck.eq(Doors.toggleHinge("left"), "right", "toggleHinge(left) = right");
    ck.eq(Doors.toggleOpening("interior"), "exterior", "toggleOpening(interior) = exterior");
    // defaults : porte centrée le long du mur, dimensions par défaut, SANS id
    const def = Doors.defaults("top", 6000);
    ck.eq(def.offset, 3000, "defaults : offset centré (wallLen/2)");
    ck.eq(def.width_mm, DOOR_DEFAULT_WIDTH_MM, "defaults : largeur par défaut");
    ck.eq(def.hinge, "left", "defaults : charnière gauche");
    ck.eq("id" in def, false, "defaults : SANS id (ajouté par l'appelant)");
    ck.eq(DOOR_WALLS.length, 4, "DOOR_WALLS : 4 murs");
  }

  console.log("\n• ImageStore : helpers purs (dataUrl ↔ Blob · bundle .nmfb)");
  {
    const blob = ImageStore.dataUrlToBlob("data:text/plain;base64," + Buffer.from("hi").toString("base64"));
    ck(blob && blob.size === 2 && blob.type === "text/plain", "dataUrlToBlob → Blob (2 octets, type)");
    ck.eq(ImageStore.dataUrlToBlob("pas-une-data-url"), null, "dataUrlToBlob(invalide) → null");
    // round-trip bundle .nmfb (manifeste + blobs concaténés)
    const recs = [{ id: "a", name: "img", u_height: 2, face: "rear", description: "d", type: "image/png", blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }) }];
    const buf = await ImageStore.buildBundle(recs, "K1").arrayBuffer();
    const parsed = ImageStore.parseBundle(buf);
    ck(parsed.key === "K1" && parsed.recs.length === 1 && parsed.recs[0].id === "a" && parsed.recs[0].u_height === 2 && parsed.recs[0].face === "rear", "parseBundle → manifeste restauré");
    const pb = new Uint8Array(await parsed.recs[0].blob.arrayBuffer());
    ck(pb.length === 3 && pb[0] === 1 && pb[2] === 3, "parseBundle → blob d'image restauré (3 octets)");
    let threw = false; try { ImageStore.parseBundle(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer); } catch (_) { threw = true; }
    ck(threw, "parseBundle : signature NMFB invalide → exception");
  }

  console.log("\n• ImageStore : import/export EXPLICITE de la bibliothèque (.nmfb)");
  {
    // Stubs navigateur manquants pour exercer les méthodes d'INSTANCE (miroir → objectURL) hors navigateur.
    global.URL = global.URL || {};
    global.URL.createObjectURL = () => "blob:stub"; global.URL.revokeObjectURL = () => {};
    // Backend mémoire (remplace IndexedDB/REST) : Map id → ImageRec (blob conservé).
    const mkMemBackend = () => { const m = new Map(); return {
      put: async (rec) => { m.set(rec.id, rec); },
      del: async (id) => { m.delete(id); },
      getRaw: async (id) => m.get(id) || null,
      getAll: async () => Array.from(m.values()),
      clear: async () => { m.clear(); },
      _map: m,
    }; };
    const backend = mkMemBackend();
    const store = new ImageStore({ backend });
    // état de départ : une image "old" en bibliothèque
    await store.add({ id: "old", name: "ancienne", u_height: 1, face: "front", blob: new Blob([new Uint8Array([9])], { type: "image/png" }) });
    ck(store.has("old") && store.count() === 1, "pré-import : bibliothèque contient « old »");

    // bundle importé : 2 images aux ids "x"/"y" (issu d'un AUTRE document)
    const bundleRecs = [
      { id: "x", name: "x", u_height: 2, face: "rear", description: "", type: "image/png", blob: new Blob([new Uint8Array([1, 2])], { type: "image/png" }) },
      { id: "y", name: "y", u_height: 1, face: "front", description: "", type: "image/jpeg", blob: new Blob([new Uint8Array([7, 7, 7])], { type: "image/jpeg" }) },
    ];
    const bundle = ImageStore.buildBundle(bundleRecs, "OTHER");
    const n = await store.importBundle(bundle);
    ck.eq(n, 2, "importBundle → nombre d'images importées");
    ck(!store.has("old"), "import ÉCRASE : « old » a disparu (références orphelines → ré-assignation)");
    ck(store.has("x") && store.has("y"), "import : ids CONSERVÉS (x, y présents)");
    ck.eq(store.get("x").u_height, 2, "import : métadonnées conservées (u_height de x)");
    ck.eq(backend._map.size, 2, "import : backend remplacé (2 enregistrements)");
    ck(store.lastLoadedKey == null, "importBundle NE touche PAS la clé d'appariement du compagnon");

    // round-trip : ré-export → reparse rend les mêmes ids/blobs (blobs déjà présents → pas de fetch)
    const out = await store.serializeBundle("RT");
    const reparsed = ImageStore.parseBundle(await out.arrayBuffer());
    const ids = reparsed.recs.map((r) => r.id).sort();
    ck(reparsed.key === "RT" && ids.join(",") === "x,y", "serializeBundle → round-trip (clé + ids)");
    const yblob = new Uint8Array(await reparsed.recs.find((r) => r.id === "y").blob.arrayBuffer());
    ck(yblob.length === 3 && yblob[0] === 7, "serializeBundle → blobs hydratés dans le bundle");
  }

  console.log("\n• Images de façade : oreilles (with_ears) + règle « autre »");
  {
    // ---- modèle FaceImage ----
    ck(new FaceImage({ face: "front" }).with_ears === true, "FaceImage : défaut = avec oreilles (front)");
    ck(new FaceImage({ face: "rear" }).with_ears === false, "FaceImage : défaut = SANS oreilles (rear)");
    ck(new FaceImage({ face: "rear", with_ears: true }).with_ears === false, "FaceImage : arrière TOUJOURS sans oreilles (même si with_ears=true)");
    ck(new FaceImage({ face: "front", with_ears: false }).with_ears === false, "FaceImage : with_ears=false respecté (front)");
    const autre = new FaceImage({ face: "autre", u_height: 5, with_ears: true });
    ck(autre.u_height === 1 && autre.with_ears === false, "FaceImage : « autre » → pas de U (1) ni d'oreilles");

    // ---- bundle .nmfb : with_ears round-trip + normalisation « autre » au parse ----
    const recs = [
      { id: "a", name: "a", u_height: 2, face: "front", with_ears: false, type: "image/png", blob: new Blob([new Uint8Array([1])], { type: "image/png" }) },
      { id: "b", name: "b", u_height: 7, face: "autre", with_ears: true, type: "image/png", blob: new Blob([new Uint8Array([2])], { type: "image/png" }) },
    ];
    const parsed = ImageStore.parseBundle(await ImageStore.buildBundle(recs, null).arrayBuffer());
    const a = parsed.recs.find((r) => r.id === "a"), b = parsed.recs.find((r) => r.id === "b");
    ck(a.with_ears === false, "bundle : with_ears=false conservé (front)");
    ck(b.with_ears === false && b.u_height === 1, "bundle : « autre » normalisé (pas d'oreilles, U=1)");

    // ---- normaliseur d'INSTANCE (ImageStore.norm via add/update) ----
    global.URL = global.URL || {}; global.URL.createObjectURL = () => "blob:stub"; global.URL.revokeObjectURL = () => {};
    const m = new Map();
    const store = new ImageStore({ backend: {
      put: async (r) => { m.set(r.id, r); }, del: async (id) => { m.delete(id); },
      getRaw: async (id) => m.get(id) || null, getAll: async () => Array.from(m.values()), clear: async () => { m.clear(); },
    } });
    const f1 = await store.add({ id: "f1", name: "f", face: "front", u_height: 3, blob: new Blob([new Uint8Array([9])], { type: "image/png" }) });
    ck(f1.with_ears === true && f1.u_height === 3, "ImageStore.add : front → avec oreilles, U conservé");
    const f3 = await store.add({ id: "f3", name: "r", face: "rear", u_height: 2, with_ears: true, blob: new Blob([new Uint8Array([5])], { type: "image/png" }) });
    ck(f3.with_ears === false, "ImageStore.add : arrière → oreilles forcées à false (même si with_ears=true)");
    const f2 = await store.add({ id: "f2", name: "g", face: "autre", u_height: 4, with_ears: true, blob: new Blob([new Uint8Array([8])], { type: "image/png" }) });
    ck(f2.with_ears === false && f2.u_height === 1, "ImageStore.add : « autre » → pas d'oreilles, U=1");
    const f1b = await store.update("f1", { with_ears: false });
    ck(f1b.with_ears === false, "ImageStore.update : with_ears modifiable");
  }

  console.log("\n• Détection de modifications (dirty) + état de sauvegarde");
  {
    // ---- logique PURE de l'état de la pastille ----
    ck.eq(computeSaveState({ dirty: false, hasFile: false, autosaveOn: false }), "mem", "save: mémoire propre → mem");
    ck.eq(computeSaveState({ dirty: true, hasFile: false, autosaveOn: false }), "dirty", "save: mémoire modifiée → dirty");
    ck.eq(computeSaveState({ dirty: false, hasFile: true, autosaveOn: false }), "clean", "save: fichier à jour → clean");
    ck.eq(computeSaveState({ dirty: true, hasFile: true, autosaveOn: false }), "dirty", "save: fichier modifié (auto-save off) → dirty");
    ck.eq(computeSaveState({ dirty: true, hasFile: true, autosaveOn: true }), "dirty-on", "save: fichier modifié (auto-save on) → dirty-on");
    // ---- l'auto-save n'écrit QUE si modifié ET fichier lié ----
    ck(!shouldAutosave({ dirty: false, hasFile: true }), "auto-save: rien à écrire (propre) → non");
    ck(!shouldAutosave({ dirty: true, hasFile: false }), "auto-save: pas de fichier lié → non");
    ck(shouldAutosave({ dirty: true, hasFile: true }), "auto-save: modifié + fichier → oui");
    // ---- transitions du suivi (changements HORS historique : meta / images) ----
    const ss = new SaveState();
    ck(!ss.dirty && ss.state() === "mem", "SaveState initial : propre, mémoire");
    ss.markDirty(); ck(ss.dirty && ss.state() === "dirty", "markDirty (hors historique) → dirty");
    ss.markSaved(); ck(!ss.dirty && ss.state() === "mem", "markSaved → propre");
    ss.setFile(true); ck.eq(ss.state(), "clean", "fichier lié + propre → clean");
    ss.markDirty(); ss.setAutosave(true); ck.eq(ss.state(), "dirty-on", "fichier + modifié + auto-save → dirty-on");
    ck(ss.shouldAutosave(), "SaveState.shouldAutosave : modifié + fichier → oui");
    ss.markLoaded(0); ck(!ss.dirty && ss.state() === "clean", "markLoaded → propre (fichier toujours lié)");

    // ---- dirty par COMPARAISON DE RÉVISION (cœur du correctif undo→propre) ----
    const rv = new SaveState(); rv.setFile(true); rv.markLoaded(0);   // chargé à la révision 0, fichier lié
    ck(!rv.dirty && rv.state() === "clean", "révision : chargé (rev 0) → clean");
    rv.setRevision(1); ck(rv.dirty && rv.state() === "dirty", "révision : mutation (rev 1 ≠ sauvée 0) → dirty");
    rv.setRevision(2); ck(rv.dirty, "révision : 2e mutation (rev 2) → toujours dirty");
    rv.setRevision(1); ck(rv.dirty, "révision : undo partiel (rev 1) → encore dirty");
    rv.setRevision(0); ck(!rv.dirty && rv.state() === "clean", "révision : undo jusqu'au point sauvé (rev 0) → REDEVIENT propre");
    rv.setRevision(2); rv.markSaved(); ck(!rv.dirty, "révision : save à la rev 2 → propre");
    rv.setRevision(1); ck(rv.dirty, "révision : undo SOUS le point sauvé (rev 1 ≠ 2) → dirty");
    // un changement hors historique reste dirty même si la révision retombe sur le point sauvé
    rv.setRevision(2); ck(!rv.dirty, "révision : retour à la rev sauvée → propre");
    rv.markDirty(); rv.setRevision(2); ck(rv.dirty, "révision + meta : hors-historique force dirty malgré rev sauvée");
  }

  console.log("\n• Store : contrat de NOTIFICATION (toute mutation déclenche onChange → dirty)");
  {
    // La détection de dirty repose sur store.onChange : on vérifie que create/update/remove le déclenchent.
    const s = await makeStore();
    let n = 0; s.onChange(() => { n++; });
    const before = n;
    const e = await s.create("equipments", { name: "E1" });
    ck(n > before, "create → onChange déclenché");
    const afterCreate = n;
    await s.update("equipments", e.id, { name: "E2" });
    ck(n > afterCreate, "update → onChange déclenché");
    const afterUpdate = n;
    await s.remove("equipments", e.id);
    ck(n > afterUpdate, "remove → onChange déclenché");
    // undo/redo notifient aussi (cohérence de la pastille après annulation)
    const afterRemove = n;
    await s.undo();
    ck(n > afterRemove, "undo → onChange déclenché");
    const afterUndo = n;
    await s.redo();
    ck(n > afterUndo, "redo → onChange déclenché");
  }

  console.log("\n• Store + SaveState : la révision pilote le dirty (undo ramène au propre)");
  {
    // Simule la boucle de main.ts : markLoaded(histIndex) au chargement, setRevision(histIndex) à chaque onChange.
    const s = await makeStore();
    const ss = new SaveState(); ss.setFile(true);
    ss.markLoaded(s.histIndex());                 // état initial = propre, ancré sur la révision courante
    s.onChange(() => { ss.setRevision(s.histIndex()); });
    ck(!ss.dirty, "intégration : document chargé → propre");
    const e = await s.create("equipments", { name: "X1" });
    ck(ss.dirty, "intégration : création → dirty");
    ss.markSaved();                               // l'utilisateur sauvegarde
    ck(!ss.dirty, "intégration : après save → propre");
    await s.update("equipments", e.id, { name: "X2" });
    ck(ss.dirty, "intégration : modification après save → dirty");
    await s.undo();                               // annule la modif → revient au point sauvé
    ck(!ss.dirty, "intégration : UNDO jusqu'au point sauvé → REDEVIENT propre");
  }

  console.log("\n• Store : inventaire de spares (suivi unitaire + attribution + cascade)");
  {
    const s = await makeStore();
    const { Spare } = D("models/Spare.js");
    // entité : normalisation au constructeur
    const d1 = new Spare({ type: "hdd", capacity_value: "4", capacity_unit: "TB", interface: "SATA", form_factor: '3.5"', rpm: "7200" });
    ck.eq(d1.type, "hdd", "Spare HDD : type conservé");
    ck.eq(d1.isDisk(), true, "Spare HDD : isDisk()");
    ck.eq(d1.capacity_value, 4, "Spare HDD : capacité numérisée");
    ck.eq(d1.techSummary(), "4 TB · SATA · 3.5\" · 7200 rpm", "Spare HDD : résumé technique (avec rpm)");
    const d2 = new Spare({ type: "ssd", capacity_value: 1, capacity_unit: "TB", interface: "NVMe", form_factor: "M.2", rpm: 7200 });
    ck.eq(d2.techSummary(), "1 TB · NVMe · M.2", "Spare SSD : résumé SANS rpm (HDD seul)");
    const tx = new Spare({ type: "transceiver", tx_form: "QSFP28", tx_speed: "100G", tx_media: "LC", brand: "Cisco", model_pn: "QSFP-100G-LR4" });
    ck.eq(tx.techSummary(), "QSFP28 · 100G · LC", "Spare transceiver : résumé technique");
    ck.eq(tx.displayName(), "Cisco QSFP-100G-LR4 · QSFP28 · 100G · LC", "Spare : désignation dérivée (marque/modèle + tech)");
    const def = new Spare({});
    ck.eq(def.type, "other", "Spare : type défaut = other");
    ck.eq(def.status, "available", "Spare : statut défaut = available");

    // persistance + index FK + helper
    const eq = await s.create("equipments", { name: "srv-01" });
    const sp = await s.create("spares", { type: "ssd", name: "SSD-A", status: "assigned", assigned_equipment_id: eq.id, assigned_date: "2026-01-02" });
    ck.eq(s.sparesOfEquipment(eq.id).length, 1, "sparesOfEquipment : index FK");
    ck.eq(s.sparesOfEquipment(eq.id)[0].id, sp.id, "sparesOfEquipment : bon spare");

    // CASCADE : suppression de l'équipement → l'attribution bascule en TEXTE LIBRE (info préservée)
    await s.remove("equipments", eq.id);
    const after = s.get("spares", sp.id);
    ck.eq(after.assigned_equipment_id, null, "cascade : FK équipement détachée");
    ck.eq(after.assigned_free, "srv-01", "cascade : attribution préservée en texte libre (nom de l'équipement)");
    ck.eq(after.status, "assigned", "cascade : statut « attribué » conservé");
  }

  console.log("\n• Store : sites + removeSite (décommissionnement, liaisons logiques préservées)");
  {
    const s = await makeStore();
    ck.eq(s.siteLabel("liege"), "Liège", "siteLabel : site par défaut seedé");
    const site = await s.create("sites", { name: "S1" });
    const dc = await s.create("datacenters", { name: "DC1", location: site.id, floor: "0" });
    const rack = await s.create("racks", { name: "R1", datacenter_id: dc.id, location: site.id });
    const eqA = await s.create("equipments", { name: "A", rack_id: rack.id, placement_mode: "rack", rack_u: 1 });
    const eqB = await s.create("equipments", { name: "B" });   // hors site (pool)
    const pa = await s.create("ports", { equipment_id: eqA.id, name: "p1" });
    const pb = await s.create("ports", { equipment_id: eqB.id, name: "p1" });
    const cab = await s.create("cables", { from_port_id: pa.id, to_port_id: pb.id, status: "cable" });
    const wp = await s.create("waypoints", { kind: "point", datacenter_id: dc.id, dc_x: 100, dc_y: 100 });
    const fe = await s.create("equipments", { name: "FE", placement_mode: "floor", location: site.id, floor: "0", dim_mode: "free" });
    const pf = await s.create("ports", { equipment_id: fe.id, name: "pf" });
    const pb2 = await s.create("ports", { equipment_id: eqB.id, name: "p2" });
    const cabF = await s.create("cables", { from_port_id: pf.id, to_port_id: pb2.id, status: "cable" });

    await s.removeSite(site.id);

    ck.eq(s.get("sites", site.id), null, "site supprimé");
    ck.eq(s.get("datacenters", dc.id), null, "salle du site supprimée");
    const r2 = s.get("racks", rack.id);
    ck(!!r2 && r2.datacenter_id == null, "baie repassée « non placée » (datacenter_id null)");
    ck.eq(r2.location, "", "baie : location vidée");
    const a2 = s.get("equipments", eqA.id);
    ck(!!a2 && a2.rack_id === rack.id, "équipement conservé dans sa baie");
    ck.eq(s.get("cables", cab.id).status, "planifie", "câble intra → planifié (liaison logique préservée)");
    ck.eq(s.get("waypoints", wp.id), null, "waypoint du site supprimé");
    const fe2 = s.get("equipments", fe.id);
    ck(!!fe2 && fe2.placement_mode === "manual", "équipement d'étage dé-placé");
    ck.eq(s.get("cables", cabF.id), null, "câble d'équipement d'étage supprimé (décâblé)");
  }

  console.log("\n• sync : RenderImpact (carte d'impact 3D)");
  {
    // Invariant CRITIQUE : toute collection du registre a un impact déclaré (sinon défaut prudent, mais on veut un choix EXPLICITE).
    ck.eq(RenderImpact.unmapped().length, 0, "RenderImpact : toutes les collections sont mappées (" + EntityRegistry.COLLECTIONS.length + ")");
    // Classification (cf. docs/render-impact.md) — quelques ancres représentatives de chaque niveau.
    ck.eq(COLLECTION_THREE_IMPACT.racks, "geometry", "racks → geometry");
    ck.eq(COLLECTION_THREE_IMPACT.portTypes, "geometry", "portTypes → geometry (taille connecteur, dépendance indirecte)");
    ck.eq(COLLECTION_THREE_IMPACT.networks, "recolor", "networks → recolor (couleur câbles)");
    ck.eq(COLLECTION_THREE_IMPACT.groups, "recolor", "groups → recolor (couleur occupants)");
    ck.eq(COLLECTION_THREE_IMPACT.ipAddresses, "none", "ipAddresses → none (hors 3D)");
    ck.eq(COLLECTION_THREE_IMPACT.spares, "none", "spares → none (hors 3D)");
    ck.eq(COLLECTION_THREE_IMPACT.cableBundles, "none", "cableBundles → none (tooltip seul)");
    ck.eq(RenderImpact.of("collection_inexistante"), "geometry", "collection inconnue → défaut PRUDENT geometry");
    ck.eq(RenderImpact.worst("none", "geometry"), "geometry", "RenderImpact.worst : none < geometry");
    ck.eq(RenderImpact.worst("recolor", "none"), "recolor", "RenderImpact.worst : recolor > none");
  }

  console.log("\n• sync : Changeset (fusion + coercition)");
  {
    ck.eq(Changeset.empty().full, false, "Changeset.empty : full=false");
    ck.eq(Changeset.full().full, true, "Changeset.full : full=true");
    // coercition d'une valeur réseau non fiable
    ck.eq(Changeset.coerce(null).full, true, "coerce(null) → full (repli sûr)");
    ck.eq(Changeset.coerce({ full: true }).full, true, "coerce({full:true}) → full");
    const coerced = Changeset.coerce({ collections: ["racks", 42, "cables"], meta: 1, images: 0 });
    ck.eq(JSON.stringify(coerced.collections), JSON.stringify(["racks", "cables"]), "coerce : collections filtrées (non-strings retirées)");
    ck.eq(coerced.meta, true, "coerce : meta coercé en booléen");
    // prédicat INJECTÉ (garde `shared/` auto-suffisant) : filtre les collections inconnues
    const filtered = Changeset.coerce({ collections: ["racks", "bidon", "cables"] }, (c) => c === "racks" || c === "cables");
    ck.eq(JSON.stringify(filtered.collections), JSON.stringify(["racks", "cables"]), "coerce : collection inconnue retirée via prédicat");
    ck.eq(Changeset.coerce({ collections: ["racks", "bidon"] }).collections.length, 2, "coerce : sans prédicat → aucun filtre (compat)");
    // fusion : union des collections, OU des drapeaux
    const merged = Changeset.merge(
      { full: false, collections: ["racks"], meta: false, images: true },
      { full: false, collections: ["racks", "cables"], meta: true, images: false },
    );
    ck.eq(JSON.stringify(merged.collections), JSON.stringify(["racks", "cables"]), "merge : union dédupliquée des collections");
    ck.eq(merged.meta && merged.images, true, "merge : drapeaux meta/images en OU");
    ck.eq(Changeset.merge(Changeset.full(), Changeset.empty()).full, true, "merge : full domine");
  }

  console.log("\n• sync : ReloadPlanner (changeset → plan)");
  {
    const planner = new ReloadPlanner();
    // collections HORS 3D → aucune reconstruction (le gain : pas de gel d'UI pour une IP / un spare / un réseau IP)
    const ipPlan = planner.plan({ full: false, collections: ["ipAddresses", "spares"], meta: false, images: false });
    ck.eq(ipPlan.threeRebuild, "none", "plan : IP+spare → threeRebuild none (PAS de rebuild 3D)");
    ck.eq(JSON.stringify(ipPlan.refetchCollections), JSON.stringify(["ipAddresses", "spares"]), "plan : refetch ciblé (P2)");
    // collection géométrique → reconstruction complète
    ck.eq(planner.plan({ full: false, collections: ["racks"], meta: false, images: false }).threeRebuild, "geometry", "plan : racks → geometry");
    // collection couleur seule → recolor
    ck.eq(planner.plan({ full: false, collections: ["networks"], meta: false, images: false }).threeRebuild, "recolor", "plan : networks → recolor");
    // pire impact d'un lot mixte
    ck.eq(planner.plan({ full: false, collections: ["spares", "networks", "racks"], meta: false, images: false }).threeRebuild, "geometry", "plan : lot mixte → pire impact (geometry)");
    // image changée → au moins geometry (textures dessinées)
    ck.eq(planner.plan({ full: false, collections: [], meta: false, images: true }).threeRebuild, "geometry", "plan : image changée → geometry");
    ck.eq(planner.plan({ full: false, collections: ["spares"], meta: false, images: true }).refreshImages, true, "plan : images → refreshImages true");
    ck.eq(planner.plan({ full: false, collections: ["spares"], meta: false, images: false }).refreshImages, false, "plan : pas d'image → refreshImages false");
    // périmètre indéterminé → tout recharger + rebuild complet
    const fullPlan = planner.plan(Changeset.full());
    ck.eq(fullPlan.refetchCollections, null, "plan : full → refetch null (tout le document)");
    ck.eq(fullPlan.threeRebuild, "geometry", "plan : full → geometry");
  }

  console.log("\n• shared : schéma PARTAGÉ (garde anti-divergence front ⇄ back)");
  {
    // La liste canonique de shared/Schema DOIT correspondre EXACTEMENT aux classes du registre front (même ordre).
    ck.eq(JSON.stringify(SharedSchema.COLLECTIONS), JSON.stringify(EntityRegistry.COLLECTIONS),
      "shared.COLLECTIONS === EntityRegistry.COLLECTIONS (ordre inclus)");
    // normSearch : le front délègue au schéma partagé → parité STRICTE avec l'indexation serveur.
    ck.eq(Text.normSearch("Liège ÉQUIPE"), SharedSchema.normSearch("Liège ÉQUIPE"), "Text.normSearch délègue à shared (accents)");
    ck.eq(Text.normSearch("Liège"), "liege", "normSearch : minuscules + sans accents");
    ck.eq(SharedSchema.normSearch(0), "0", "normSearch(0) === '0' (et non '' — parité serveur)");
    // taille de page : constante partagée, ré-exportée côté front.
    ck.eq(PAGE_SIZE_DEFAULT, SharedSchema.PAGE_SIZE_DEFAULT, "config.PAGE_SIZE_DEFAULT === shared (source unique)");
    ck.eq(SharedSchema.isCollection("racks"), true, "isCollection(racks) = true");
    ck.eq(SharedSchema.isCollection("inconnue"), false, "isCollection(inconnue) = false");
    ck.eq(SharedSchema.isArrayField("network_ids"), true, "isArrayField(network_ids) = true");
  }

  console.log("\n• shared : normalisation (forme canonique avant écriture)");
  {
    const r = Validation.DataValidator.normalizeRecord("racks", { name: "R1", u_count: "10", width_mm: "600" });
    ck.eq(r.u_count, 10, "normalize racks : u_count '10' → 10 (number)");
    ck.eq(r.width_mm, 600, "normalize racks : width_mm '600' → 600");
    ck.eq(r.sides, "single", "normalize racks : sides défaut → 'single'");
    ck.eq(r.name, "R1", "normalize racks : name préservé");
    const e = Validation.DataValidator.normalizeRecord("equipments", { name: "sw" });
    ck.eq(e.type, "switch", "normalize equipments : type défaut → 'switch'");
    ck.eq(e.placement_mode, "manual", "normalize equipments : placement_mode défaut → 'manual'");
    ck.eq(e.u_height, 1, "normalize equipments : u_height défaut → 1");
    ck.eq(e.inventory_only, false, "normalize equipments : inventory_only défaut → false");
    ck.eq(e.group_id, null, "normalize equipments : group_id vide → null (nullable)");
    const passthrough = Validation.DataValidator.normalizeRecord("spares", { whatever: 7 });
    ck.eq(passthrough.whatever, 7, "normalize : collection SANS spec → traversée inchangée");
  }

  console.log("\n• shared : validation intrinsèque (requis / type / enum / borne)");
  {
    ck.eq(Validation.DataValidator.validateRecord("equipments", { name: "sw", type: "switch", depth: "full", placement_mode: "manual", u_height: 1, inventory_only: false, group_id: null }).length, 0,
      "validate equipments : record valide → 0 erreur");
    const missingName = Validation.DataValidator.validateRecord("equipments", { name: "", depth: "full" });
    ck.eq(missingName.some((x) => x.path === "name" && x.code === "required"), true, "validate : name manquant → erreur 'required'");
    const badStatus = Validation.DataValidator.validateRecord("cables", { status: "inexistant" });
    ck.eq(badStatus.some((x) => x.path === "status" && x.code === "enum"), true, "validate : status hors enum → erreur 'enum'");
    const badType = Validation.DataValidator.validateRecord("racks", { name: "R", u_count: "abc" });
    ck.eq(badType.some((x) => x.path === "u_count" && x.code === "type"), true, "validate : u_count non numérique → erreur 'type'");
    const belowMin = Validation.DataValidator.validateRecord("racks", { name: "R", u_count: 0 });
    ck.eq(belowMin.some((x) => x.path === "u_count" && x.code === "min"), true, "validate : u_count 0 → erreur 'min'");
    ck.eq(Validation.DataValidator.validateRecord("spares", { anything: true }).length, 0, "validate : collection sans spec → 0 erreur");
    // enchaînement serveur : normalise PUIS valide
    const nv = Validation.DataValidator.normalizeAndValidate("racks", { name: "R", u_count: "42" });
    ck.eq(nv.errors.length, 0, "normalizeAndValidate : '42' normalisé → valide");
    ck.eq(nv.record.u_count, 42, "normalizeAndValidate : record normalisé renvoyé");
  }

  console.log("\n• shared : validation — garde anti-divergence avec le domaine front");
  {
    // les enums de la spec partagée DOIVENT correspondre aux constantes du domaine front.
    ck.eq(JSON.stringify(Validation.CABLE_STATUS_IDS.slice()), JSON.stringify(CABLE_STATUSES.map((s) => s.id)),
      "spec.CABLE_STATUS_IDS === domaine CABLE_STATUSES (ids)");
    ck.eq(JSON.stringify(Validation.EQUIPMENT_DEPTHS.slice()), JSON.stringify(EQUIP_DEPTHS.slice()),
      "spec.EQUIPMENT_DEPTHS === domaine EQUIP_DEPTHS");
    // les ENTITÉS produites par les constructeurs front satisfont la spec partagée (normaliseurs alignés).
    ck.eq(Validation.DataValidator.validateRecord("equipments", new Equipment({ name: "sw" }).toJSON()).length, 0, "Equipment(name) front satisfait la spec");
    ck.eq(Validation.DataValidator.validateRecord("racks", new Rack({ name: "R" }).toJSON()).length, 0, "Rack(name) front satisfait la spec");
    ck.eq(Validation.DataValidator.validateRecord("cables", new Cable({}).toJSON()).length, 0, "Cable() front satisfait la spec");
    // enums étendus alignés au domaine front (mêmes ids, même ordre).
    ck.eq(JSON.stringify(Validation.GROUP_TYPE_IDS.slice()), JSON.stringify(GROUP_TYPES.map((t) => t.id)), "GROUP_TYPE_IDS === domaine");
    ck.eq(JSON.stringify(Validation.RACK_ITEM_KIND_IDS.slice()), JSON.stringify(RACK_ITEM_KINDS.map((k) => k.id)), "RACK_ITEM_KIND_IDS === domaine");
    ck.eq(JSON.stringify(Validation.SPARE_TYPE_IDS.slice()), JSON.stringify(SPARE_TYPES.map((t) => t.id)), "SPARE_TYPE_IDS === domaine");
    ck.eq(JSON.stringify(Validation.SPARE_STATUS_IDS.slice()), JSON.stringify(SPARE_STATUSES.map((s) => s.id)), "SPARE_STATUS_IDS === domaine");
    ck.eq(JSON.stringify(Validation.EQUIPMENT_FACE_IDS.slice()), JSON.stringify(EQUIP_FACE_IDS.slice()), "EQUIPMENT_FACE_IDS === domaine");
  }

  console.log("\n• shared : invariants inter-champs (V3)");
  {
    // câble : port relié à lui-même → interdit
    const selfLoop = Validation.DataValidator.validateRecord("cables", { status: "planifie", from_port_id: "p1", to_port_id: "p1" });
    ck.eq(selfLoop.some((e) => e.code === "invariant" && e.path === "to_port_id"), true, "invariant : from === to → erreur");
    ck.eq(Validation.DataValidator.validateRecord("cables", { status: "planifie", from_port_id: "p1", to_port_id: "p2" }).length, 0, "invariant : from ≠ to → 0 erreur");
    // câble : réseau principal hors des réseaux portés → interdit
    const orphanPrimary = Validation.DataValidator.validateRecord("cables", { status: "planifie", network_id: "n9", network_ids: ["n1", "n2"] });
    ck.eq(orphanPrimary.some((e) => e.code === "invariant" && e.path === "network_id"), true, "invariant : network_id ∉ network_ids → erreur");
    ck.eq(Validation.DataValidator.validateRecord("cables", { status: "planifie", network_id: "n1", network_ids: ["n1"] }).length, 0, "invariant : network_id ∈ network_ids → 0 erreur");
    ck.eq(Validation.DataValidator.validateRecord("cables", { status: "planifie", network_id: null, network_ids: [] }).length, 0, "invariant : pas de réseau principal → ignoré");
  }

  console.log("\n• shared : formats IPv4 / CIDR (IPAM)");
  {
    ck.eq(Validation.Ipv4.toInt("10.0.0.5"), 167772165, "ipv4ToInt : 10.0.0.5");
    ck.eq(Validation.Ipv4.toInt("256.0.0.1"), null, "ipv4ToInt : octet > 255 → null");
    ck.eq(Validation.Ipv4.toInt("10.0.0"), null, "ipv4ToInt : incomplet → null");
    ck.eq(Validation.Ipv4.isCidr("10.0.0.0/24"), true, "isCidr : 10.0.0.0/24 valide");
    ck.eq(Validation.Ipv4.isCidr("10.0.0.0/40"), false, "isCidr : préfixe > 32 → invalide");
    ck.eq(Validation.Ipv4.isCidr("10.0.0.0"), false, "isCidr : sans préfixe → invalide");
    // appliqué via la spec
    ck.eq(Validation.DataValidator.validateRecord("ipAddresses", { address: "10.0.0.5" }).length, 0, "ipAddresses : adresse valide → 0 erreur");
    ck.eq(Validation.DataValidator.validateRecord("ipAddresses", { address: "999.1.1.1" }).some((e) => e.code === "format"), true, "ipAddresses : adresse invalide → 'format'");
    ck.eq(Validation.DataValidator.validateRecord("ipAddresses", { address: "" }).some((e) => e.code === "required"), true, "ipAddresses : adresse vide → 'required'");
    ck.eq(Validation.DataValidator.validateRecord("ipNetworks", { label: "N", cidr: "10.0.0.0/24" }).length, 0, "ipNetworks : CIDR valide → 0 erreur");
    ck.eq(Validation.DataValidator.validateRecord("ipNetworks", { cidr: "nope" }).some((e) => e.code === "format"), true, "ipNetworks : CIDR invalide → 'format'");
  }

  console.log("\n• shared : invariants IPAM / réseaux");
  {
    // réseau power ne peut pas porter d'ip_network_id
    ck.eq(Validation.DataValidator.validateRecord("networks", { kind: "power", ip_network_id: "ipn1" }).some((e) => e.code === "invariant"), true, "invariant : réseau power + ip_network_id → erreur");
    ck.eq(Validation.DataValidator.validateRecord("networks", { label: "N", kind: "data", ip_network_id: "ipn1" }).length, 0, "invariant : réseau data + ip_network_id → OK");
    // plage DHCP : fin ≥ début
    ck.eq(Validation.DataValidator.validateRecord("dhcpRanges", { start_ip: "10.0.0.20", end_ip: "10.0.0.10" }).some((e) => e.code === "invariant"), true, "invariant : plage DHCP fin < début → erreur");
    ck.eq(Validation.DataValidator.validateRecord("dhcpRanges", { start_ip: "10.0.0.10", end_ip: "10.0.0.20" }).length, 0, "invariant : plage DHCP fin ≥ début → 0 erreur");
  }

  console.log("\n• shared : dépendance inverse (V5b — re-validation des enfants)");
  {
    // findChildren simulé : le réseau "net1" porte une adresse 10.0.0.5.
    const children = { "ipAddresses network_id net1": [{ id: "a1", address: "10.0.0.5", network_id: "net1" }] };
    const findChildren = (coll, fk, pid) => children[coll + " " + fk + " " + pid] || [];
    const fetch = () => null;   // les enfants résolvent le parent via l'injection de validateDependents
    ck.eq(Validation.DataValidator.validateDependents("ipNetworks", { id: "net1", cidr: "10.0.0.0/24" }, findChildren, fetch).length, 0, "V5b : nouveau CIDR contient l'enfant → 0 erreur");
    const errs = Validation.DataValidator.validateDependents("ipNetworks", { id: "net1", cidr: "10.0.5.0/24" }, findChildren, fetch);
    ck.eq(errs.some((e) => e.code === "cross_entity" && e.collection === "ipAddresses" && e.id === "a1"), true, "V5b : nouveau CIDR exclut l'enfant → erreur sur l'adresse");
    ck.eq(Validation.DataValidator.validateDependents("racks", { id: "r1" }, findChildren, fetch).length, 0, "V5b : collection sans dépendants → 0 erreur");

    // lecteur d'enfants CONSCIENT DU LOT (V5b dans /transact) : ensemble effectif des enfants après le lot.
    const persistedChildren = (coll, fk, pid) => (coll === "ipAddresses" && fk === "network_id" && pid === "net1")
      ? [{ id: "a1", address: "10.0.0.5", network_id: "net1" }, { id: "a3", address: "10.0.0.9", network_id: "net1" }] : [];
    const lot = {
      creates: [{ collection: "ipAddresses", record: { id: "a2", address: "10.0.0.7", network_id: "net1" } }],   // nouvel enfant
      updates: [{ collection: "ipAddresses", record: { id: "a1", address: "10.0.0.5", network_id: "net2" } }],   // déplacé hors de net1
      deletes: [{ collection: "ipAddresses", id: "a3" }],                                                          // enfant supprimé
    };
    const batchChildFinder = Validation.DataValidator.buildBatchChildFinder(persistedChildren, lot);
    const effective = batchChildFinder("ipAddresses", "network_id", "net1").map((c) => c.id).sort();
    ck.eq(JSON.stringify(effective), JSON.stringify(["a2"]), "batch-childFinder : a1 déplacé + a3 supprimé + a2 créé → {a2}");
  }

  console.log("\n• shared : portée V6a (unicité d'adresse IP)");
  {
    const DV = Validation.DataValidator;
    // find simulé : deux adresses persistées (a1=10.0.0.5, a2=10.0.0.6).
    const persisted = [{ id: "a1", address: "10.0.0.5" }, { id: "a2", address: "10.0.0.6" }];
    const find = (coll, field, value) => (coll === "ipAddresses" && field === "address") ? persisted.filter((r) => r[field] === value) : [];
    // SANS find → pas de contrôle de portée (V1-V5 inchangés)
    ck.eq(DV.validateRecord("ipAddresses", { id: "aX", address: "10.0.0.5" }).length, 0, "V6a : sans find → pas de contrôle d'unicité");
    // création d'une adresse déjà prise → conflit
    ck.eq(DV.validateRecord("ipAddresses", { id: "aX", address: "10.0.0.5" }, undefined, find).some((e) => e.code === "scope"), true, "V6a : adresse déjà attribuée → 'scope'");
    // « sauf moi-même » : ré-enregistrer a1 avec sa propre adresse → OK
    ck.eq(DV.validateRecord("ipAddresses", { id: "a1", address: "10.0.0.5" }, undefined, find).length, 0, "V6a : même entité (a1) garde son adresse → OK");
    // adresse libre → OK
    ck.eq(DV.validateRecord("ipAddresses", { id: "aX", address: "10.0.0.9" }, undefined, find).length, 0, "V6a : adresse libre → OK");
    // conscient du lot : deux créations avec la MÊME adresse dans un /transact → conflit
    const batch = { creates: [{ collection: "ipAddresses", record: { id: "n1", address: "10.0.0.50" } }, { collection: "ipAddresses", record: { id: "n2", address: "10.0.0.50" } }] };
    const batchFind = DV.buildBatchChildFinder(find, batch);
    ck.eq(DV.validateRecord("ipAddresses", { id: "n1", address: "10.0.0.50" }, undefined, batchFind).some((e) => e.code === "scope"), true, "V6a batch : doublon créé dans le lot → 'scope'");
  }

  console.log("\n• shared : portée V6b (1 câble/port, intervalles DHCP)");
  {
    const DV = Validation.DataValidator;
    // 1 câble par port : C0 utilise P1 (from) et P2 (to).
    const cables = [{ id: "C0", from_port_id: "P1", to_port_id: "P2" }];
    const cableFind = (coll, field, value) => coll === "cables" ? cables.filter((c) => c[field] === value) : [];
    ck.eq(DV.validateRecord("cables", { id: "CX", status: "planifie", from_port_id: "P1" }, undefined, cableFind).some((e) => e.code === "scope"), true, "V6b câble : port déjà relié → scope");
    ck.eq(DV.validateRecord("cables", { id: "C0", status: "planifie", from_port_id: "P1", to_port_id: "P2" }, undefined, cableFind).length, 0, "V6b câble : même câble garde ses ports → OK");
    ck.eq(DV.validateRecord("cables", { id: "CX", status: "planifie", from_port_id: "P9" }, undefined, cableFind).length, 0, "V6b câble : port libre → OK");

    // intervalles DHCP : réseau N → plage R0=[.10,.20] + IP statique .30
    const ranges = [{ id: "R0", network_id: "N", start_ip: "10.0.0.10", end_ip: "10.0.0.20" }];
    const addrs = [{ id: "A0", network_id: "N", address: "10.0.0.30" }];
    const ipamFind = (coll, field, value) => {
      if (coll === "dhcpRanges" && field === "network_id") return ranges.filter((r) => r.network_id === value);
      if (coll === "ipAddresses" && field === "network_id") return addrs.filter((a) => a.network_id === value);
      if (coll === "ipAddresses" && field === "address") return addrs.filter((a) => a.address === value);
      return [];
    };
    ck.eq(DV.validateRecord("dhcpRanges", { id: "RX", network_id: "N", start_ip: "10.0.0.15", end_ip: "10.0.0.25" }, undefined, ipamFind).some((e) => e.code === "scope"), true, "V6b DHCP : chevauchement → scope");
    ck.eq(DV.validateRecord("dhcpRanges", { id: "RX", network_id: "N", start_ip: "10.0.0.28", end_ip: "10.0.0.35" }, undefined, ipamFind).some((e) => e.code === "scope"), true, "V6b DHCP : IP statique dans la plage → scope");
    ck.eq(DV.validateRecord("dhcpRanges", { id: "RX", network_id: "N", start_ip: "10.0.0.40", end_ip: "10.0.0.50" }, undefined, ipamFind).length, 0, "V6b DHCP : plage disjointe → OK");
    ck.eq(DV.validateRecord("ipAddresses", { id: "AX", network_id: "N", address: "10.0.0.15" }, undefined, ipamFind).some((e) => e.code === "scope"), true, "V6b IP : adresse dans une plage DHCP → scope");
  }

  console.log("\n• shared : portée V6c (collision de U en baie)");
  {
    const DV = Validation.DataValidator;
    const rack = { id: "RK", u_count: 42, sides: "dual" };
    const fetch = (c, i) => (c === "racks" && i === "RK") ? rack : null;
    const occ = { eq: [{ id: "E0", placement_mode: "rack", rack_id: "RK", rack_u: 1, u_height: 2, depth: "half", rack_side: "front", name: "E0" }] };
    const find = (c, f, v) => (c === "equipments" && f === "rack_id" && v === "RK") ? occ.eq : [];
    ck.eq(DV.validateRecord("equipments", { id: "EX", name: "x", placement_mode: "rack", rack_id: "RK", rack_u: 2, u_height: 1, depth: "half", rack_side: "front" }, fetch, find).some((e) => e.code === "scope"), true, "V6c : chevauchement U2 front → collision");
    ck.eq(DV.validateRecord("equipments", { id: "EX", name: "x", placement_mode: "rack", rack_id: "RK", rack_u: 2, u_height: 1, depth: "half", rack_side: "rear" }, fetch, find).length, 0, "V6c : même U, face REAR → OK (faces distinctes en baie double)");
    ck.eq(DV.validateRecord("equipments", { id: "EX", name: "x", placement_mode: "rack", rack_id: "RK", rack_u: 3, u_height: 1, depth: "half", rack_side: "front" }, fetch, find).length, 0, "V6c : U libre → OK");
    ck.eq(DV.validateRecord("equipments", { id: "E0", name: "x", placement_mode: "rack", rack_id: "RK", rack_u: 1, u_height: 2, depth: "half", rack_side: "front" }, fetch, find).length, 0, "V6c : même occupant garde sa place → OK");
    ck.eq(DV.validateRecord("equipments", { id: "EX", name: "x", placement_mode: "rack", rack_id: "RK", rack_u: 2, u_height: 1, depth: "full", rack_side: "rear" }, fetch, find).some((e) => e.code === "scope"), true, "V6c : full depth (2 faces) chevauche U2 → collision");
    ck.eq(DV.validateRecord("equipments", { id: "EX", name: "x", placement_mode: "rack", rack_id: "RK", rack_u: 2, u_height: 1, depth: "half", rack_side: "front" }, fetch).length, 0, "V6c : sans find → pas de contrôle de collision");
  }

  console.log("\n• shared : règles métier T1 (invariants) / T2 (cross-entité)");
  {
    const DV = Validation.DataValidator;
    // T1 — équipement : placement_mode rack ⇒ rack_id requis
    ck.eq(DV.validateRecord("equipments", { name: "e", placement_mode: "rack", rack_id: null }).some((x) => x.code === "invariant" && x.path === "rack_id"), true, "T1 equip : racké sans baie → invariant");
    ck.eq(DV.validateRecord("equipments", { name: "e", placement_mode: "manual" }).length, 0, "T1 equip : manuel → OK");
    // T1b — équipement : side/wall (flanc/paroi d'une baie) ⇒ rack_id requis
    ck.eq(DV.validateRecord("equipments", { name: "e", placement_mode: "side", rack_id: null }).some((x) => x.code === "invariant" && x.path === "rack_id"), true, "T1b equip : side sans baie → invariant");
    ck.eq(DV.validateRecord("equipments", { name: "e", placement_mode: "wall", rack_id: null }).some((x) => x.code === "invariant" && x.path === "rack_id"), true, "T1b equip : wall sans baie → invariant");
    ck.eq(DV.validateRecord("equipments", { name: "e", placement_mode: "side", rack_id: "RK" }).some((x) => x.code === "invariant" && x.path === "rack_id"), false, "T1b equip : side AVEC baie → OK");
    ck.eq(DV.validateRecord("equipments", { name: "e", placement_mode: "floor" }).some((x) => x.code === "invariant" && x.path === "rack_id"), false, "T1b equip : floor (plan d'étage) → pas concerné");
    // T1 — port : face X/Y cohérents
    ck.eq(DV.validateRecord("ports", { face_x: 0.5, face_y: null }).some((x) => x.code === "invariant"), true, "T1 port : face X sans Y → invariant");
    ck.eq(DV.validateRecord("ports", { face_x: 0.5, face_y: 0.5 }).length, 0, "T1 port : X+Y → OK");
    ck.eq(DV.validateRecord("ports", { }).length, 0, "T1 port : ni X ni Y → OK");
    // T1 — waypoint : brosse ⇒ rack_id
    ck.eq(DV.validateRecord("waypoints", { kind: "brush", rack_id: null }).some((x) => x.code === "invariant"), true, "T1 wp : brosse sans baie → invariant");
    ck.eq(DV.validateRecord("waypoints", { kind: "point" }).length, 0, "T1 wp : point → OK");

    // T2 — équipement racké tient dans la baie (rack u_count = 10)
    const rackFetch = (c, i) => (c === "racks" && i === "RK") ? { id: "RK", u_count: 10 } : null;
    ck.eq(DV.validateRecord("equipments", { name: "e", placement_mode: "rack", rack_id: "RK", rack_u: 10, u_height: 2 }, rackFetch).some((x) => x.code === "cross_entity"), true, "T2 equip : U10+2 (→U11) dans baie 10U → dépasse");
    ck.eq(DV.validateRecord("equipments", { name: "e", placement_mode: "rack", rack_id: "RK", rack_u: 3, u_height: 2 }, rackFetch).length, 0, "T2 equip : U3+2 dans baie 10U → OK");
    // T2 — baie dans les bornes de la salle (5000 x 4000)
    const dcFetch = (c, i) => (c === "datacenters" && i === "DC") ? { id: "DC", width_mm: 5000, depth_mm: 4000 } : null;
    ck.eq(DV.validateRecord("racks", { name: "R", datacenter_id: "DC", dc_x: 6000, dc_y: 100 }, dcFetch).some((x) => x.code === "cross_entity"), true, "T2 rack : x hors salle → cross_entity");
    ck.eq(DV.validateRecord("racks", { name: "R", datacenter_id: "DC", dc_x: 1000, dc_y: 1000 }, dcFetch).length, 0, "T2 rack : dans la salle → OK");
    // T2 — port parent d'un autre équipement
    const portFetch = (c, i) => (c === "ports" && i === "P0") ? { id: "P0", equipment_id: "EQ2" } : null;
    ck.eq(DV.validateRecord("ports", { equipment_id: "EQ1", parent_port_id: "P0" }, portFetch).some((x) => x.code === "cross_entity" && x.path === "parent_port_id"), true, "T2 port : parent autre équipement → cross_entity");
  }

  console.log("\n• shared : couverture des specs (toutes les collections spécifiées)");
  {
    // INVARIANT : pour CHAQUE collection spécifiée, l'entité par défaut du constructeur front satisfait la spec
    // (aucune spec ne sur-contraint ce que le front produit → pas de blocage de flux légitime).
    const requiredSample = {   // collections à champ(s) requis : on fournit des valeurs valides
      equipments: { name: "x" }, racks: { name: "x" }, datacenters: { name: "x" }, sites: { name: "x" },
      networks: { label: "x" }, groups: { label: "x" },
      ipNetworks: { cidr: "10.0.0.0/24", label: "x" }, ipAddresses: { address: "10.0.0.5" },
      dhcpRanges: { start_ip: "10.0.0.10", end_ip: "10.0.0.20" },
    };
    const specced = Object.keys(Validation.COLLECTION_SPECS);
    ck.eq(specced.length, EntityRegistry.COLLECTIONS.length, "specs : TOUTES les collections couvertes (" + specced.length + "/" + EntityRegistry.COLLECTIONS.length + ")");
    for (const collection of specced) {
      const Cls = EntityRegistry.classOf(collection);
      const entity = new Cls(requiredSample[collection] || {});
      ck.eq(Validation.DataValidator.validateRecord(collection, entity.toJSON()).length, 0, collection + " : entité par défaut satisfait la spec");
    }
  }

  console.log("\n• serveur : PUT /snapshot valide le document COMPLET (autorité — le semis de catalogues doit passer)");
  {
    // Simule EXACTEMENT la validation serveur du snapshot (api.ts `snapshot`) sur un NOUVEAU document : lecteur
    // d'entité + chercheur d'enfants adossés au snapshot lui-même. GARDE-FOU : la création de document
    // (newDocument → PUT /snapshot) ne doit JAMAIS être rejetée par la validation (catalogues semés = valides).
    const s = await makeStore();   // newDocument() → sème les catalogues
    const snap = s.toJSON();
    const byId = new Map();
    for (const c of SharedSchema.COLLECTIONS) { const m = new Map(); for (const r of (snap[c] || [])) if (r && r.id) m.set(String(r.id), r); byId.set(c, m); }
    const fetch = (c, id) => (byId.get(c) && byId.get(c).get(String(id))) || null;
    const find = (c, fk, pid) => (snap[c] || []).filter((r) => { const v = r ? r[fk] : undefined; return Array.isArray(v) ? v.includes(pid) : v === pid; });
    const errs = [];
    for (const c of SharedSchema.COLLECTIONS) for (const rec of (snap[c] || [])) errs.push(...Validation.DataValidator.normalizeAndValidate(c, rec, fetch, find).errors);
    for (const c of SharedSchema.COLLECTIONS) for (const rec of (snap[c] || [])) errs.push(...Validation.DataValidator.validateDependents(c, rec, find, fetch));
    ck.eq(errs.length, 0, "snapshot d'un nouveau document (catalogues semés) → 0 erreur" + (errs.length ? " : " + JSON.stringify(errs.slice(0, 3)) : ""));
  }

  console.log("\n• shared : intégrité référentielle (V2 — FK + conscience du lot)");
  {
    // lecteur d'entité simulé : renvoie un record pour les id « existants », null sinon (subsume « existe ? »).
    const persisted = { "ports p1": { id: "p1" }, "networks n1": { id: "n1" } };
    const base = (coll, id) => persisted[coll + " " + id] || null;
    ck.eq(Validation.DataValidator.validateRecord("cables", { status: "planifie", from_port_id: "p1" }, base).length, 0, "ref : FK existante → 0 erreur");
    const broken = Validation.DataValidator.validateRecord("cables", { status: "planifie", from_port_id: "pX" }, base);
    ck.eq(broken.some((e) => e.path === "from_port_id" && e.code === "ref_missing"), true, "ref : FK introuvable → 'ref_missing'");
    ck.eq(Validation.DataValidator.validateRecord("cables", { status: "planifie", from_port_id: null }, base).length, 0, "ref : FK null → ignorée");
    const arr = Validation.DataValidator.validateRecord("cables", { status: "planifie", network_ids: ["n1", "nX"] }, base);
    ck.eq(arr.some((e) => e.path === "network_ids" && e.code === "ref_missing"), true, "ref : tableau de FK avec id absent → 'ref_missing'");
    ck.eq(Validation.DataValidator.validateRecord("cables", { status: "planifie", from_port_id: "pX" }).length, 0, "ref : SANS lecteur → pas de contrôle référentiel (V1)");

    // lecteur conscient du lot (renvoie le CONTENU du lot)
    const batch = { creates: [{ collection: "ports", record: { id: "pNew" } }], deletes: [{ collection: "networks", id: "n1" }] };
    const batchFetch = Validation.DataValidator.buildBatchFetcher(base, batch);
    ck(batchFetch("ports", "pNew") != null, "batch : entité créée dans le lot → existe");
    ck.eq(batchFetch("networks", "n1"), null, "batch : entité supprimée dans le lot → n'existe plus");
    ck(batchFetch("ports", "p1") != null, "batch : entité persistée hors lot → existe (base)");
    ck.eq(batchFetch("ports", "pX"), null, "batch : id inconnu → n'existe pas");
    ck.eq(Validation.DataValidator.validateRecord("cables", { status: "planifie", from_port_id: "pNew" }, batchFetch).length, 0,
      "batch : câble référençant un port créé DANS le lot → accepté (pas de faux rejet)");

    // couverture référentielle : toute FK déclarée doit cibler une collection RÉELLE (garde anti-typo / anti-oubli).
    const declaredRefs = [];
    for (const [coll, spec] of Object.entries(Validation.COLLECTION_SPECS)) {
      for (const [field, fieldSpec] of Object.entries(spec.fields)) if (fieldSpec.ref) declaredRefs.push({ coll, field, ref: fieldSpec.ref });
    }
    const validCollections = new Set(EntityRegistry.COLLECTIONS);
    ck.eq(declaredRefs.find((r) => !validCollections.has(r.ref)), undefined, "refs : toutes ciblent une collection réelle (" + declaredRefs.length + " FK)");

    // equipments : refs rack_id / dc_id (complétude V2).
    const eqFetch = (coll, id) => (((coll === "racks" && id === "r1") || (coll === "datacenters" && id === "dc1")) ? { id } : null);
    ck.eq(Validation.DataValidator.validateRecord("equipments", { name: "e", rack_id: "r1" }, eqFetch).length, 0, "equipments : rack_id existant → 0 erreur");
    ck.eq(Validation.DataValidator.validateRecord("equipments", { name: "e", rack_id: "rX" }, eqFetch).some((x) => x.path === "rack_id" && x.code === "ref_missing"), true, "equipments : rack_id inexistant → ref_missing");
    ck.eq(Validation.DataValidator.validateRecord("equipments", { name: "e", dc_id: "dc1" }, eqFetch).length, 0, "equipments : dc_id existant → 0 erreur");
  }

  console.log("\n• shared : règles cross-entité (V5 — IP ∈ CIDR de son réseau)");
  {
    // lecteur d'entité : un réseau IP « net1 » en 10.0.0.0/24.
    const fetch = (coll, id) => (coll === "ipNetworks" && id === "net1") ? { id: "net1", cidr: "10.0.0.0/24" } : null;
    ck.eq(Validation.DataValidator.validateRecord("ipAddresses", { address: "10.0.0.5", network_id: "net1" }, fetch).length, 0, "IP dans le CIDR du réseau → 0 erreur");
    ck.eq(Validation.DataValidator.validateRecord("ipAddresses", { address: "10.0.1.5", network_id: "net1" }, fetch).some((e) => e.code === "cross_entity"), true, "IP hors CIDR du réseau → 'cross_entity'");
    ck.eq(Validation.DataValidator.validateRecord("ipAddresses", { address: "10.0.1.5", network_id: null }, fetch).length, 0, "IP sans réseau → règle non applicable");
    ck.eq(Validation.DataValidator.validateRecord("ipAddresses", { address: "10.0.1.5", network_id: "net1" }).length, 0, "IP : SANS lecteur → pas de contrôle cross-entité");
    // plage DHCP ⊂ CIDR
    ck.eq(Validation.DataValidator.validateRecord("dhcpRanges", { start_ip: "10.0.0.10", end_ip: "10.0.0.20", network_id: "net1" }, fetch).length, 0, "plage DHCP dans le CIDR → 0 erreur");
    ck.eq(Validation.DataValidator.validateRecord("dhcpRanges", { start_ip: "10.0.0.10", end_ip: "10.0.9.20", network_id: "net1" }, fetch).some((e) => e.code === "cross_entity"), true, "borne DHCP hors CIDR → 'cross_entity'");
    // batch-aware : réseau dont le CIDR est MODIFIÉ dans le même lot → la règle voit le nouveau cidr
    const batch = { updates: [{ collection: "ipNetworks", record: { id: "net1", cidr: "10.0.5.0/24" } }] };
    const batchFetch = Validation.DataValidator.buildBatchFetcher(fetch, batch);
    ck.eq(Validation.DataValidator.validateRecord("ipAddresses", { address: "10.0.5.7", network_id: "net1" }, batchFetch).length, 0, "batch : IP dans le NOUVEAU CIDR du lot → acceptée");
    ck.eq(Validation.DataValidator.validateRecord("ipAddresses", { address: "10.0.0.7", network_id: "net1" }, batchFetch).some((e) => e.code === "cross_entity"), true, "batch : IP hors du nouveau CIDR → rejetée");
  }

  console.log("\n• Store : garde de validation (mode fichier — seul garde-fou, pas de serveur)");
  {
    const s = await makeStore();
    let captured = null;
    s.onInvalid = (errs) => { captured = errs; };
    // intrinsèque : équipement sans nom → bloqué + notifié
    const bad = await s.create("equipments", { type: "switch" });
    ck.eq(bad, null, "store.create équipement sans nom → bloqué (null)");
    ck.eq(!!captured && captured.some((e) => e.path === "name" && e.code === "required"), true, "onInvalid notifié (name required)");
    // valide → accepté, sans notification
    captured = null;
    const ok = await s.create("equipments", { name: "sw1" });
    ck(!!ok && !!ok.id, "store.create équipement nommé → accepté");
    ck.eq(captured, null, "écriture valide → onInvalid NON appelé");
    // référentiel : câble vers un port inexistant → bloqué
    const badRef = await s.create("cables", { status: "planifie", from_port_id: "PORT_INEXISTANT" });
    ck.eq(badRef, null, "store.create câble → FK port inexistant → bloqué");
    // update : patch normalisé (u_count '50' → 50)
    const rack = await s.create("racks", { name: "R1" });
    await s.update("racks", rack.id, { u_count: "50" });
    ck.eq(s.get("racks", rack.id).u_count, 50, "store.update : patch normalisé ('50' → 50)");
    // update invalide (u_count 0 < min) → bloqué, valeur inchangée
    const before = s.get("racks", rack.id).u_count;
    await s.update("racks", rack.id, { u_count: 0 });
    ck.eq(s.get("racks", rack.id).u_count, before, "store.update u_count 0 → bloqué (valeur inchangée)");

    // V5b end-to-end : changer le CIDR d'un réseau qui exclurait une de ses adresses → bloqué.
    const net = await s.create("ipNetworks", { cidr: "10.0.0.0/24", label: "N" });
    const ip = await s.create("ipAddresses", { address: "10.0.0.5", network_id: net.id });
    ck(!!ip, "V5b : adresse créée dans le CIDR");
    captured = null;
    await s.update("ipNetworks", net.id, { cidr: "10.0.5.0/24" });   // exclurait 10.0.0.5
    ck.eq(s.get("ipNetworks", net.id).cidr, "10.0.0.0/24", "V5b : CIDR excluant une adresse → update bloqué (inchangé)");
    ck.eq(!!captured && captured.some((e) => e.code === "cross_entity"), true, "V5b : onInvalid notifié (cross_entity)");
    captured = null;
    await s.update("ipNetworks", net.id, { cidr: "10.0.0.0/16" });   // contient toujours 10.0.0.5
    ck.eq(s.get("ipNetworks", net.id).cidr, "10.0.0.0/16", "V5b : CIDR contenant l'adresse → accepté");
  }

  console.log("\n" + "-".repeat(48));
  console.log("Résultat : " + pass + " PASS, " + fail + " FAIL");
  if (fail) { console.log("Échecs :\n  - " + failures.join("\n  - ")); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error("\n✗ HARNAIS A LEVÉ :", e && e.stack ? e.stack : e); process.exit(1); });
