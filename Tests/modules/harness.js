/* ============================================================================
   DC Manager — HARNAIS des tests modules (partagé par les fichiers test-*.js).
   ----------------------------------------------------------------------------
   Contient : stubs navigateur, loaders des modules compilés (dist-test/),
   makeStore, mini-framework d'assertions (ck) et l'isolation PAR SECTION
   (section() : un crash dans une section est COMPTÉ comme échec mais
   n'interrompt pas le reste de la suite). Les sections vivent dans les
   fichiers test-<domaine>.js ; run.js orchestre l'ensemble.
   ============================================================================ */
"use strict";
const path = require("path");
// Depuis l'ajout du code PARTAGÉ (shared/) au programme, le rootDir inféré devient la racine du dépôt :
// la sortie de compilation place les modules `src/` sous `dist-test/src/` et `shared/` sous `dist-test/shared/`.
const D = (p) => require(path.join(__dirname, "..", "..", "dist-test", "src", p));        // modules du front (src/…)
const SHARED = (p) => require(path.join(__dirname, "..", "..", "dist-test", p));           // code partagé (shared/…)
const SERVER = (p) => require(path.join(__dirname, "..", "..", "dist-test", "src-server", "src", p));   // modules SERVEUR purs (cf. tsconfig.node.json)

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
const { DoorTool } = D("views/dc/DoorTool.js");
const { Measure } = D("geometry/Measure.js");
const { CableSpline } = D("geometry/CableSpline.js");
const { MeasureTool } = D("views/dc/MeasureTool.js");
const { RouteTool } = D("views/dc/RouteTool.js");
const { ImageStore } = D("data/ImageStore.js");
const { FaceImage } = D("models/index.js");
const { SaveState } = D("app/SaveState.js");
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
const ck = (cond, name) => { if (cond) pass++; else { fail++; failures.push(name); } console.log((cond ? "  \u2713 " : "  \u2717 FAIL ") + name); };
ck.eq = (a, b, name) => ck(a === b, name + "  (attendu " + JSON.stringify(b) + ", obtenu " + JSON.stringify(a) + ")");

/** Exécute une section ISOLÉE : un crash (throw hors assertion) est compté comme un échec
    et journalisé, mais n'interrompt PAS les sections suivantes (audit P5). */
async function section(title, fn) {
  console.log("\n\u2022 " + title);
  try { await fn(); }
  catch (e) {
    fail++; failures.push(title + " \u2014 CRASH : " + ((e && e.message) || e));
    console.log("  \u2717 CRASH " + ((e && e.stack) ? e.stack.split("\n").slice(0, 3).join("\n    ") : e));
  }
}

/** Bilan final : code de sortie 1 au moindre échec (assertion ou crash de section). */
function summary() {
  console.log("\n" + "-".repeat(48));
  console.log("Résultat : " + pass + " PASS, " + fail + " FAIL");
  if (fail) { console.log("Échecs :\n  - " + failures.join("\n  - ")); process.exit(1); }
  process.exit(0);
}

module.exports = { ck, section, summary, path, D, SHARED, SERVER, mkStorage, Store, BrowserStorageAdapter, FieldIndex, Equipment, Cable, Port, Normalize, Labeler, ClickGuard, Projection, Box, Painter, RackGeometry, GraphGeometry, EquipmentTypes, PortRoles, Depths, EquipFaces, RackScene, Resolver3D, U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE, Html, Color, Format, GridGeometry, GraphView, Sort, Ip, Prefs, DatacenterView, FloorLayout, Positioning, DoorGeometry, Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM, DoorTool, Measure, CableSpline, MeasureTool, RouteTool, ImageStore, FaceImage, SaveState, EntityRegistry, ReloadPlanner, COLLECTION_THREE_IMPACT, RenderImpact, Changeset, SharedSchema, Text, PAGE_SIZE_DEFAULT, Validation, Cascade, Rack, CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS, makeStore };
