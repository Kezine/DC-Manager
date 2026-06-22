/* ============================================================================
   NetMap — Harnais de tests (NOUVEAU ; sans rapport avec le dossier Scrapped/).
   ----------------------------------------------------------------------------
   But : rendre VÉRIFIABLES en Node (sans navigateur) les parties STABLES et
   PURES de l'app (couche de données / Store / FieldIndex, entités & invariants,
   géométrie). C'est le filet de sécurité qui permet d'aborder ensuite les gros
   refactors (perf 3D, découpe de méthodes) sans régression silencieuse.

   Méthode : on extrait le <script> du .html livré, on stubbe le DOM/navigateur,
   on évalue le script pour exposer ses classes/fonctions, puis on exécute les
   suites de Tests/suites/*.test.js contre cette API. Les tests CARACTÉRISENT le
   comportement COURANT (garde-fous), ils ne redéfinissent pas la spec.

   Usage :  node Tests/run.js               (teste le dernier netmap-vNNN*.html)
            node Tests/run.js <fichier.html> (teste un fichier précis)
   ============================================================================ */
"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SUITES_DIR = path.join(__dirname, "suites");

/* -------- 1) Cible : argument explicite, sinon le dernier netmap-vNNN -------- */
function latestHtml() {
  const files = fs.readdirSync(ROOT)
    .filter(f => /^netmap-v\d+.*\.html$/.test(f) && !/\(\d+\)/.test(f))
    .sort((a, b) => parseInt(a.match(/v(\d+)/)[1], 10) - parseInt(b.match(/v(\d+)/)[1], 10));
  return files.length ? path.join(ROOT, files[files.length - 1]) : null;
}
const target = process.argv[2] ? path.resolve(process.argv[2]) : latestHtml();
if (!target || !fs.existsSync(target)) { console.error("Cible introuvable :", target); process.exit(2); }

/* -------- 2) Extraction du <script> -------- */
const htmlLines = fs.readFileSync(target, "utf8").split(/\r?\n/);
const open = htmlLines.findIndex((l, i) => i > 100 && l.trim() === "<script>");
const close = htmlLines.findIndex((l, i) => i > open && l.trim() === "</script>");
if (open < 0 || close < 0) { console.error("Bornes <script> introuvables dans", target); process.exit(2); }
const js = htmlLines.slice(open + 1, close).join("\n");

console.log("NetMap — Tests");
console.log("Cible :", path.basename(target), "(" + (close - open - 1) + " lignes de JS)\n");

/* -------- 3) node --check (porte syntaxe, règle du projet) -------- */
const tmp = path.join(__dirname, ".script-check.tmp.js");
fs.writeFileSync(tmp, js, "utf8");
try { cp.execSync('node --check "' + tmp + '"', { stdio: "pipe" }); console.log("node --check : PASS"); }
catch (e) { console.log("node --check : FAIL\n" + (e.stderr ? e.stderr.toString() : e.message)); process.exit(1); }
finally { try { fs.unlinkSync(tmp); } catch (_) {} }

/* -------- 4) Stubs DOM / navigateur (minimal, suffisant au boot) -------- */
const mkStorage = () => { let m = {}; return {
  getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); },
  removeItem: k => { delete m[k]; }, clear: () => { m = {}; },
  key: i => Object.keys(m)[i] || null, get length() { return Object.keys(m).length; } }; };
const el = () => new Proxy(function () {}, {
  get: (t, p) => {
    if (p === "style" || p === "dataset") return {};
    if (p === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
    if (p === "children" || p === "childNodes") return [];
    if (p === "textContent" || p === "innerHTML" || p === "value" || p === "outerHTML") return "";
    if (p === "getBoundingClientRect") return () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
    if (p === Symbol.toPrimitive || p === "toString") return () => "";
    return el();
  },
  set: () => true, apply: () => el()
});
global.window = { sessionStorage: mkStorage(), localStorage: mkStorage(), addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {}, removeListener() {} }), location: { href: "" },
  devicePixelRatio: 1, getComputedStyle: () => ({ getPropertyValue: () => "" }), requestAnimationFrame: () => 0 };
global.document = { addEventListener() {}, removeEventListener() {}, getElementById: () => el(), querySelector: () => el(),
  querySelectorAll: () => [], createElement: () => el(), createElementNS: () => el(), createDocumentFragment: () => el(),
  body: el(), documentElement: el(), head: el(), fullscreenElement: null, title: "", cookie: "" };
global.sessionStorage = window.sessionStorage; global.localStorage = window.localStorage;
global.performance = { now: () => 0, getEntriesByType: () => [], navigation: { type: 0 } };
global.fetch = () => Promise.reject(new Error("offline"));
global.indexedDB = { open: () => ({ result: null, onsuccess: null, onerror: null, addEventListener() {} }) };
global.navigator = { userAgent: "node" };
global.requestAnimationFrame = () => 0; global.cancelAnimationFrame = () => {};
global.getComputedStyle = window.getComputedStyle;
global.matchMedia = window.matchMedia;
global.Image = function () { return {}; };
global.Blob = global.Blob || function () { return {}; };
global.XMLSerializer = global.XMLSerializer || function () { return { serializeToString: () => "" }; };
global.URL = Object.assign(global.URL || {}, { createObjectURL: () => "", revokeObjectURL: () => {} });
global.BroadcastChannel = global.BroadcastChannel || function () { return { postMessage() {}, close() {}, addEventListener() {} }; };

/* -------- 5) Évaluation du script + exposition d'une API curée -------- */
// Noms exposés (avec garde typeof → un nom absent devient undefined sans planter).
const EXPOSE = [
  "Entity", "Equipment", "Port", "FaceImage", "Aggregate", "Cable", "Network", "Group", "Rack", "RackItem",
  "Datacenter", "Floor", "Waypoint", "PortType", "CableType", "CableBundle", "IpNetwork", "IpAddress", "DhcpRange",
  "FieldIndex", "DataAdapter", "BrowserStorageAdapter", "RestAdapter", "Store",
  "project3D", "equipmentTypeColor", "rackHalfExtents", "normRackOrientation", "floorNum", "uid",
  "clickGuardBlocks", "waypointPassPoints", "waypointAnchor", "box6Faces",
  "uniqIds", "makeLabeler", "depthLabel", "portRoleLabel", "faceLabel",
  "graphNodeSize", "graphNodesBBox", "equipmentTypeLabel", "painterFarFirst",
  "DEFAULT_PORT_TYPES", "DEFAULT_CABLE_TYPES", "EQUIPMENT_TYPES", "COLOR_PALETTE", "CABLE_STATUS_DRAFT",
  // géométrie 3D / placement (dépendent du `store` global → utiliser makeStore() d'abord)
  "resolvePort3D", "mountSpanMm", "rackOccupants",
  "rackSideMarginMm", "rackSideColumns", "rackSideEnabled", "rackSideOccupants", "sideSlotFree", "sideFreeSlots", "sideSlotBoxLocal", "sideEquipBoxLocal",
  "rackMarginDepth", "rackWallEnabled", "rackWallGeo", "rackWallOccupants", "wallSlotFree", "wallFreeSlots", "wallSlotBoxLocal", "wallEquipBoxLocal",
  // constantes géométriques
  "U_MM", "RACK_MOUNT_WIDTH", "RACK_WIDTH_DEFAULT", "RACK_DEPTH_DEFAULT"
];
const exposeSrc = "\n;(function(){ try {\n  globalThis.__NM__ = {\n"
  + EXPOSE.map(n => "    " + n + ": (typeof " + n + " !== 'undefined' ? " + n + " : undefined)").join(",\n")
  + ",\n    makeStore: async function () { const s = new Store(new BrowserStorageAdapter({ persistent: false })); await s.init(); await s.newDocument(); store = s; return s; }\n"
  + "  };\n} catch (e) { globalThis.__NM_ERR__ = e; } })();";

try { (0, eval)(js + exposeSrc); }
catch (e) { console.log("\n✗ L'APP NE SE CHARGE PAS sous stubs : " + (e && e.stack ? e.stack : e)); process.exit(1); }
if (global.__NM_ERR__) { console.log("\n✗ Exposition de l'API échouée : " + global.__NM_ERR__); process.exit(1); }
const NM = global.__NM__;

/* -------- 6) Mini-framework + exécution des suites -------- */
let pass = 0, fail = 0; const failures = [];
const ck = (cond, name) => {
  if (cond) { pass++; } else { fail++; failures.push(name); }
  console.log((cond ? "  ✓ " : "  ✗ FAIL ") + name);
};
ck.eq = (a, b, name) => ck(a === b, name + "  (attendu " + JSON.stringify(b) + ", obtenu " + JSON.stringify(a) + ")");
ck.ok = ck;
ck.throws = async (fn, name) => { let t = false; try { await fn(); } catch (_) { t = true; } ck(t, name); };

(async () => {
  const suiteFiles = fs.existsSync(SUITES_DIR)
    ? fs.readdirSync(SUITES_DIR).filter(f => /\.test\.js$/.test(f)).sort()
    : [];
  if (!suiteFiles.length) { console.log("\n(aucune suite dans Tests/suites/)"); }
  for (const f of suiteFiles) {
    const suite = require(path.join(SUITES_DIR, f));
    console.log("\n• " + (suite.name || f));
    try { await suite.run(NM, ck); }
    catch (e) { fail++; failures.push(suite.name + " a levé : " + e.message); console.log("  ✗ SUITE THREW : " + (e && e.stack ? e.stack : e)); }
  }
  console.log("\n" + "-".repeat(48));
  console.log("Résultat : " + pass + " PASS, " + fail + " FAIL");
  if (fail) { console.log("Échecs :\n  - " + failures.join("\n  - ")); }
  process.exit(fail ? 1 : 0);
})();
