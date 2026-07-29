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
// Depuis l'ajout du code PARTAGÉ (src-shared/) au programme, le rootDir inféré devient la racine du dépôt :
// la sortie de compilation place les modules `src-client/` sous `dist-test/src-client/` et `src-shared/` sous `dist-test/src-shared/`.
const D = (p) => require(path.join(__dirname, "..", "..", "dist-test", "src-client", p));  // modules du front (src-client/…)
const SHARED = (p) => require(path.join(__dirname, "..", "..", "dist-test", p));           // code partagé (src-shared/…)
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

/* -------- lecture des IMPORTS d'une SOURCE TypeScript (verrous d'architecture) --------
   Deux verrous en dépendent, et un seul détecteur les sert (principe n°3 : réutiliser plutôt que
   dupliquer) : l'ISOLEMENT de `src-shared/` (test-shared-validation.js, doctrine §6.19) et la BORNE
   §6.6 de `PlacementFrame` (test-geometry.js, §6.22). Tous deux relisent les SOURCES `.ts` et jamais
   le compilé : c'est le spécificateur ÉCRIT par le contributeur qu'on contrôle, le compilé ayant déjà
   résolu les alias. Le contrôle de DISCRIMINATION qui prouve que ce détecteur voit chaque forme
   d'import vit dans la section d'isolement de `src-shared/`, et couvre donc les deux usages. */
class TsImports {
  /** Spécificateurs de module d'une source TS, TOUTES FORMES CONFONDUES → Map(spécificateur → ligne 1-based).
      Passer par le PARSEUR TypeScript plutôt que par une expression régulière n'est pas un luxe : les
      fichiers concernés DOCUMENTENT leurs propres imports en commentaire (`import { X } from "./Foo.js"` y
      figure en prose), et une regex y verrait des faux positifs.
      ⚠ `ts.preProcessFile` seul NE SUFFIT PAS — mesuré sur sonde : il RATE `export * as N from "x"`.
      On prend donc l'UNION d'un parcours d'AST (exhaustif) et de `preProcessFile` (filet contre un type de
      nœud oublié dans le parcours). Un verrou qui rate une forme donne une FAUSSE sécurité — c'est le
      défaut `FieldSpec.max` (contrainte déclarée mais inerte) qu'on ne veut pas reproduire. */
  static specifiersOf(text, fileName) {
    const ts = require("typescript");
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
    const found = new Map();
    const noteAt = (spec, pos) => {
      if (typeof spec !== "string" || found.has(spec)) return;
      found.set(spec, sf.getLineAndCharacterOfPosition(pos).line + 1);
    };
    const literalOf = (node) => (node && ts.isStringLiteralLike(node) ? node.text : null);
    const visit = (node) => {
      // `import … from "x"` / `import "x"` (effet de bord) / `import type … from "x"`
      if (ts.isImportDeclaration(node)) noteAt(literalOf(node.moduleSpecifier), node.getStart(sf));
      // `export … from "x"` / `export * from "x"` / `export * as N from "x"` / `export type { … } from "x"`
      else if (ts.isExportDeclaration(node) && node.moduleSpecifier) noteAt(literalOf(node.moduleSpecifier), node.getStart(sf));
      // `import X = require("x")` (forme TS)
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) noteAt(literalOf(node.moduleReference.expression), node.getStart(sf));
      // `import("x")` dynamique — et `require("x")` (CommonJS), refusé au même titre
      else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) noteAt(literalOf(node.arguments[0]), node.getStart(sf));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) noteAt(imported.fileName, imported.pos);
    return found;
  }
}

/* -------- localisation : init AVANT tout (lot B2a) --------
   Les registres de libellés (EquipmentTypes/SpareStatuses/Depths…) résolvent désormais leur libellé
   via `I18n.t(labelKey)` au POINT DE RENDU. Comme certaines sections testent `.label()` directement,
   la localisation doit être initialisée ici (locale résolue = "fr", cf. navigator absent → repli). */
const { I18n } = D("i18n/I18n.js");
I18n.init();

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
// REPÈRE D'UN CONTENU PLACÉ : composition « point local d'un contenu → repère de l'origine fournie »
// (docs/placement.md §3 règle 1, §6.1, §6.22).
const { PlacementFrame } = D("geometry/PlacementFrame.js");
const { TrayFrame } = D("geometry/TrayFrame.js");   // l'ÉTAGÈRE comme CONTENEUR : repère plateau → repère baie
const { GraphGeometry } = D("geometry/GraphGeometry.js");
const { RouteGraphLayout, ROUTE_GRAPH } = D("geometry/RouteGraphLayout.js");
const { RouteMiniGraph } = D("views/RouteMiniGraph.js");   // mini-graphe de tracé — seule règle métier testée : le DÉCOMPTE des conteneurs distincts (le reste est du SVG)
const { LeaderLayout } = D("geometry/LeaderLayout.js");
const { FaceAlign } = D("geometry/FaceAlign.js");   // aimantation d'un port sur les autres (guides d'alignement/espacement)
const { RackLabelLayout } = D("geometry/RackLabelLayout.js");   // disposition des noms de baie sur la coque (flancs + toit), géométrie pure
const { Homography } = D("geometry/Homography.js");
const { ImageStitch } = D("geometry/ImageStitch.js");
const { EquipmentTypes, PortRoles, Depths, EquipFaces } = D("registries/index.js");
const { RackScene } = D("geometry/RackScene.js");
const { Resolver3D } = D("geometry/Resolver3D.js");
const { CableRouting } = D("geometry/CableRouting.js");
const { TrunkRouting } = D("geometry/TrunkRouting.js");   // routage des FAISCEAUX : même mécanique de polyligne que les câbles (worldLine partagé) — testé à côté d'eux depuis §6.30
const { U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE } = D("domain/constants.js");
const { Html } = D("core/Html.js");
const { Color } = D("core/Color.js");
const { Format } = D("core/Format.js");
const { GridGeometry } = D("geometry/GridGeometry.js");
const { GraphView } = D("views/GraphView.js");
const { Sort } = D("core/Sort.js");
const { FilterChips } = D("core/FilterChips.js");   // modèle pur des filtres actifs d'un listing (chips)
const { FieldFacet } = D("core/FieldFacet.js");
const { Ip } = D("core/Ip.js");
const { Markdown } = D("core/Markdown.js");
const { RichTooltip } = D("ui/RichTooltip.js");   // moteur de tooltips enrichis — seul `place()` est pur (testé ici)
const { VmNetMapping } = D("core/VmNetMapping.js");
const { VmIpMatch } = D("core/VmIpMatch.js");
const { VmClusterFormat } = D("core/VmClusterFormat.js");
const { FormSave } = D("views/forms/FormSave.js");   // écriture depuis un formulaire : rend null si le Store REFUSE
const { VmStatus } = D("core/VmStatus.js");   // état d'une VM (statut + orphelinat) : SOURCE UNIQUE des pastilles, couleurs, tri
const { VmHostTip } = D("core/VmHostTip.js");   // bloc « VMs hébergées » de la bulle d'équipement (tri/bornage/échappement)
const { VmLocate } = D("core/VmLocate.js");   // « Localiser » une VM = localiser son HÔTE (prédicat PUR, store injecté)
const { Locatable } = D("core/Locatable.js");   // « cet objet est-il LOCALISABLE ? » — règle UNIQUE des boutons « Localiser » (pur, store injecté)
const { ContainerLabel } = D("core/ContainerLabel.js");   // « comment s'appelle son endroit ? » — libellé du CONTENEUR (pur, store injecté)
const { NotifyFormat, DEFAULT_REMIND_HOURS } = D("core/NotifyFormat.js");
const { Prefs } = D("core/Prefs.js");
const { DatacenterView } = D("views/DatacenterView.js");
const { FloorLayout } = D("geometry/FloorLayout.js");
const { SiteLayout, SITE_FALLBACK_STEP_M, SITE_SCALE_DEFAULT_M_PER_KM } = D("geometry/SiteLayout.js");
const { Positioning } = D("geometry/Positioning.js");
const { PivotBounds } = D("geometry/PivotBounds.js");   // bornage du pivot d'orbite (géométrie pure)
const { CameraFraming } = D("geometry/CameraFraming.js");   // règle de CADRAGE de la caméra 3D (taux de remplissage, limite de zoom, plongée) — pure
const { DoorGeometry } = D("geometry/DoorGeometry.js");
const { Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM } = D("domain/Doors.js");
const { DoorTool } = D("views/dc/DoorTool.js");
const { Measure } = D("geometry/Measure.js");
const { CableSpline } = D("geometry/CableSpline.js");
const { MeasureTool } = D("views/dc/MeasureTool.js");
const { RouteTool } = D("views/dc/RouteTool.js");
// Signature de DISPOSITION + décision d'invalidation du moteur 3D : module PUR (types seuls importés
// de DcThreeBase, donc effacés) → chargeable en Node, contrairement au moteur WebGL lui-même.
const { SceneLayoutSignature } = D("views/dc/three/SceneLayoutSignature.js");
// Style + tracé du marqueur de PIVOT : module PUR lui aussi (aucun THREE, aucun DOM — le contexte 2D
// est REÇU), donc chargeable en Node alors que la texture qu'il sert ne l'est pas.
const { PivotMarker } = D("views/dc/three/PivotMarker.js");
const { ImageStore } = D("data/ImageStore.js");
const { FaceImage } = D("models/index.js");
const { SaveState } = D("app/SaveState.js");
const { ShellNav } = D("app/ShellNav.js");
const { EntityRegistry } = D("models/index.js");
const { ReloadPlanner } = D("sync/ReloadPlanner.js");
const { COLLECTION_THREE_IMPACT, RenderImpact } = D("sync/RenderImpact.js");
const { Changeset } = D("sync/Changeset.js");
const { Schema: SharedSchema } = SHARED("src-shared/Schema.js");
const { Text } = D("core/Text.js");
const { PAGE_SIZE_DEFAULT } = D("data/config.js");
const Validation = SHARED("src-shared/DataValidation.js");
const { Cascade } = SHARED("src-shared/Cascade.js");
const { PowerAnalysis } = SHARED("src-shared/PowerAnalysis.js");   // moteur énergie migré dans src-shared/ (cf. Validation/Cascade)
// CHAÎNE DE CONTENEURS de placement : source UNIQUE de l'identité d'un conteneur (dont le couple
// bâtiment+étage) et de sa comparaison. Exposée au harnais depuis que la GRAMMAIRE DE ROUTE en parle
// (doctrine §6.31) — les tests doivent pouvoir fabriquer un conteneur avec la seule clé correcte.
const { PlacementContainers } = SHARED("src-shared/PlacementContainers.js");
// Géométrie d'ÉTAGÈRE : source UNIQUE consommée par le rendu (RackGeometry) ET par la validation, qui la
// reçoit en COLLABORATEUR INJECTÉ. ⚠ L'injection est un CHOIX CONSERVÉ, pas une contrainte : depuis le
// lot 7, `DataValidation` POURRAIT l'importer (cf. `RackDepthPolicy` quatre lignes plus bas, qui le fait).
// Cf. docs/placement.md §6.7.
const TrayGeom = SHARED("src-shared/TrayGeometry.js");
const { TrayGeometry } = TrayGeom;
// POLITIQUE DE PROFONDEUR de baie : source UNIQUE consommée par le rendu (RackGeometry délègue) ET par
// la validation, qui l'IMPORTE directement (l'auto-suffisance de src-shared/ est levée). Cf. §6.14.
const RackDepthPol = SHARED("src-shared/RackDepthPolicy.js");
const { RackDepthPolicy } = RackDepthPol;
/** Collaborateurs à passer à la validation dans les tests — MÊME injection que le Store et le serveur. */
const VALIDATION_COLLABORATORS = { trayGeometry: TrayGeometry };
const { Rack } = D("models/index.js");
const { CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS, TRAY_TYPES } = D("domain/constants.js");

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

module.exports = { ck, section, summary, path, D, SHARED, SERVER, TsImports, mkStorage, Store, BrowserStorageAdapter, PlacementContainers, FieldIndex, Equipment, Cable, Port, Normalize, Labeler, ClickGuard, Projection, Box, Painter, RackGeometry, PlacementFrame, TrayFrame, GraphGeometry, RouteGraphLayout, ROUTE_GRAPH, RouteMiniGraph, LeaderLayout, FaceAlign, RackLabelLayout, Homography, ImageStitch, EquipmentTypes, PortRoles, Depths, EquipFaces, RackScene, Resolver3D, CableRouting, TrunkRouting, U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE, Html, Color, Format, GridGeometry, GraphView, Sort, FilterChips, FieldFacet, Ip, Markdown, RichTooltip, VmNetMapping, VmIpMatch, VmClusterFormat, FormSave, VmStatus, VmHostTip, VmLocate, Locatable, ContainerLabel, NotifyFormat, DEFAULT_REMIND_HOURS, Prefs, DatacenterView, FloorLayout, SiteLayout, SITE_FALLBACK_STEP_M, SITE_SCALE_DEFAULT_M_PER_KM, Positioning, PivotBounds, CameraFraming, DoorGeometry, Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM, DoorTool, Measure, CableSpline, MeasureTool, RouteTool, SceneLayoutSignature, PivotMarker, ImageStore, FaceImage, SaveState, ShellNav, EntityRegistry, ReloadPlanner, COLLECTION_THREE_IMPACT, RenderImpact, Changeset, SharedSchema, Text, PAGE_SIZE_DEFAULT, Validation, Cascade, PowerAnalysis, TrayGeom, TrayGeometry, RackDepthPol, RackDepthPolicy, VALIDATION_COLLABORATORS, Rack, CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS, TRAY_TYPES, makeStore };
