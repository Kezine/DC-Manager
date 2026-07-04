/* Tests modules — vues & outils pilotés par hôte injecté (Graph/Datacenter, outils 2D/3D, images).
   Sections extraites de run.js (audit P5) ; harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, mkStorage, Store, BrowserStorageAdapter, FieldIndex, Equipment, Cable, Port, Normalize, Labeler, ClickGuard, Projection, Box, Painter, RackGeometry, GraphGeometry, EquipmentTypes, PortRoles, Depths, EquipFaces, RackScene, Resolver3D, U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE, Html, Color, Format, GridGeometry, GraphView, Sort, Ip, Prefs, DatacenterView, FloorLayout, Positioning, DoorGeometry, Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM, DoorTool, Measure, CableSpline, MeasureTool, RouteTool, ImageStore, FaceImage, SaveState, EntityRegistry, ReloadPlanner, COLLECTION_THREE_IMPACT, RenderImpact, Changeset, SharedSchema, Text, PAGE_SIZE_DEFAULT, Validation, Cascade, Rack, CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS, makeStore } = require("./harness.js");

module.exports = async () => {
  await section("GraphView (pilote) : build + layout (sans DOM)", async () => {
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
  });

  await section("DatacenterView : persistance de l'état de vue (par fichier)", async () => {
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
  });

  await section("DatacenterView : presets caméra + résolution de câbles (helpers partagés avec la 2D)", async () => {
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
    // route builder : départ port A → waypoint → port B → ouvre le form câble prérempli. Machine d'état = RouteTool
    // (on pose l'état directement : arm/start émettent un toast → besoin du DOM, absent ici). L'état vit DANS l'outil.
    let routed = null;
    const dvr = new DatacenterView(s, {}, { openCableForm: (id, opts) => { routed = { id, opts }; } });
    dvr.routeTool.state = { fromPortId: pa, wpIds: [] };
    dvr.routeTool.addWp(exit1.id); ck.eq(JSON.stringify(dvr.routeTool.state.wpIds), JSON.stringify([exit1.id]), "RouteTool.addWp : waypoint ajouté");
    dvr.routeTool.finish(pc);
    ck(routed && routed.id === null && routed.opts.fromPortId === pa && routed.opts.toPortId === pc && JSON.stringify(routed.opts.waypointIds) === JSON.stringify([exit1.id]), "RouteTool.finish → openCableForm prérempli (from/to/waypoints)");
    ck.eq(dvr.routeTool.state, null, "RouteTool.finish : session terminée");
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
  });

  await section("MeasureTool : machine d'état de la mesure (via hôte injecté — testable en isolation)", async () => {
  {
    const host = {
      render: () => {}, buildToolbar: () => {}, showCote: () => {}, hideCote: () => {},
      viewKind: () => "top", isMultiDc: () => false, currentDc: () => ({ id: "DC1" }),
      floorTargetResolve: () => null, scaleOrNull: () => 1, hasSvg: () => true,
      clientToWorld: (x, y) => ({ x, y }), overlayRoot: () => null, dotScale: () => 1,
      isFloorTransformed: () => false, applyUprightText: () => {}, three: () => null,
      btn: () => ({}), disarmPositioning: () => {}, clearRoute: () => {}, refreshSide: () => {},
    };
    const tool = new MeasureTool(host);
    ck.eq(tool.hasActive(), false, "MeasureTool : inactif au départ");
    ck.eq(tool.ctxKey(), "room:DC1", "ctxKey : salle courante (top mono)");
    // on arme l'ÉTAT à la main (arm() passe par Notify.toast → DOM, hors périmètre de ce test unitaire)
    tool.state = { active: true, ctx: tool.ctxKey(), pts: [], cursor: null, done: [] };
    ck.eq(tool.hasActive() && tool.activeHere(), true, "état actif dans le contexte courant");
    ck.eq(tool.state.ctx, "room:DC1", "contexte capturé");
    tool.placeAt(100, 200); tool.placeAt(400, 600);
    ck.eq(tool.state.pts.length, 2, "placeAt : 2 points posés (2D, sol z=0)");
    ck.eq(tool.state.pts[0].z, 0, "placeAt : point au niveau du sol (z=0)");
    tool.commit();
    ck.eq(tool.state.done.length === 1 && tool.state.pts.length === 0, true, "commit : mesure archivée, points en cours vidés");
    tool.placeAt(10, 10); tool.placeAt(20, 20); tool.undo();
    ck.eq(tool.state.pts.length, 1, "undo : retire le dernier point");
    tool.clearAll();
    ck.eq(tool.state.pts.length === 0 && tool.state.done.length === 0, true, "clearAll : tout effacé");
    host.currentDc = () => ({ id: "DC2" });   // le contexte de vue change → la mesure (figée sur DC1) n'est plus « ici »
    ck.eq(tool.activeHere(), false, "activeHere : false si le contexte a changé");
    tool.cancel();
    ck.eq(tool.hasActive(), false, "cancel : outil désarmé");
  }
  });

  await section("RouteTool : machine d'état du routage (back/cancel, via hôte injecté)", async () => {
  {
    const host = { render: () => {}, svgEl: () => null, currentDc: () => null, openCableForm: () => {}, disarmPositioning: () => {}, three: () => null, btn: () => ({}), portShort: () => "" };
    const tool = new RouteTool(host, {}, {});   // store/resolver non sollicités par back/cancel
    ck.eq(tool.active, false, "RouteTool : inactif au départ");
    tool.state = { fromPortId: "P1", wpIds: ["w1", "w2"] };   // départ + 2 waypoints (pont d'accès de la vue)
    ck.eq(tool.active && tool.started, true, "démarré (port + waypoints)");
    tool.back(); ck.eq(JSON.stringify(tool.state.wpIds), JSON.stringify(["w1"]), "back : retire le dernier waypoint");
    tool.back(); ck.eq(tool.state.wpIds.length, 0, "back : retire le 2e waypoint");
    tool.back(); ck.eq(tool.state.fromPortId, null, "back : plus de waypoint → efface le port de départ (retour armement)");
    ck.eq(tool.started, false, "après back complet : plus démarré (encore armé)");
    tool.cancel(); ck.eq(tool.active, false, "cancel : outil désarmé");
  }
  });

  await section("Doors : domaine des portes de salle (valeurs canoniques, libellés, défauts, règles pures)", async () => {
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
  });

  await section("DoorTool : contrôleur des portes (CRUD + menu, via hôte injecté — testable en isolation)", async () => {
  {
    let saved = null;
    const host = { persistDoors: async (dcId, doors) => { saved = { dcId, doors }; }, openDoorForm: () => {} };
    const tool = new DoorTool(host);
    // add : porte par défaut centrée, persistée sur la salle
    const dc = { id: "DC1", width_mm: 6000, depth_mm: 4000, doors: [] };
    const id = await tool.add(dc, "top");
    ck(saved && saved.dcId === "DC1" && saved.doors.length === 1, "DoorTool.add : porte persistée sur la salle");
    ck.eq(saved.doors[0].offset, 3000, "DoorTool.add : offset centré (width/2)");
    ck.eq(saved.doors[0].wall, "top", "DoorTool.add : mur demandé");
    ck(typeof id === "string" && !!id, "DoorTool.add : renvoie l'id de la porte");
    // mur vertical → centré sur la profondeur
    await tool.add({ id: "DC1", width_mm: 6000, depth_mm: 4000, doors: [] }, "left");
    ck.eq(saved.doors[0].offset, 2000, "DoorTool.add : mur vertical → offset = depth/2");
    // update : patch partiel sur la BONNE porte, les autres inchangées
    const dc2 = { id: "DC1", doors: [{ id: "d1", wall: "top", hinge: "left" }, { id: "d2", wall: "left", hinge: "left" }] };
    await tool.update(dc2, "d1", { hinge: "right" });
    ck.eq(saved.doors.find((d) => d.id === "d1").hinge, "right", "DoorTool.update : patch sur la bonne porte");
    ck.eq(saved.doors.find((d) => d.id === "d2").hinge, "left", "DoorTool.update : autres portes inchangées");
    // remove
    await tool.remove(dc2, "d1");
    ck(saved.doors.length === 1 && saved.doors[0].id === "d2", "DoorTool.remove : porte retirée");
    // ctx : menu (passage libre dans l'en-tête + 4 actions)
    const sections = tool.ctx(dc2, { id: "d2", width_mm: 900, frame_mm: 40, hinge: "left", opening: "interior" });
    ck(sections[0].head.indexOf("820") >= 0, "DoorTool.ctx : en-tête montre le passage libre (820 mm)");
    ck.eq(sections[0].items.length, 4, "DoorTool.ctx : 4 actions (modifier/charnière/ouverture/supprimer)");
    // posEntries : entités déplaçables contraintes à leur mur (emprise le long = w/2, ⟂ fine ; commit = offset seul)
    const dc3 = { id: "DC1", width_mm: 6000, depth_mm: 4000, doors: [
      { id: "dt", wall: "top", offset: 2000, width_mm: 900, frame_mm: 40 },
      { id: "dl", wall: "left", offset: 1000, width_mm: 800, frame_mm: 40 },
    ] };
    const entries = tool.posEntries(dc3);
    ck.eq(entries.length, 2, "posEntries : une entrée par porte");
    const et = entries.find((e) => e.id === "dt");
    ck(et.rect.cy === 0 && Math.abs(et.rect.cx - 2000) < 1, "posEntries : mur haut → cy=0, cx=offset");
    ck(et.rect.hx === 450 && et.rect.hy === 30, "posEntries : mur haut → emprise le long = w/2, ⟂ fine (30)");
    const el = entries.find((e) => e.id === "dl");
    ck(el.rect.cx === 0 && Math.abs(el.rect.cy - 1000) < 1, "posEntries : mur gauche → cx=0, cy=offset");
    ck(el.rect.hx === 30 && el.rect.hy === 400, "posEntries : mur gauche → emprise le long = w/2 en y");
    await et.commit(2500, 999);   // mur horizontal → n'écrit que l'offset = nx (coord ⟂ ignorée), borné
    ck.eq(saved.doors.find((d) => d.id === "dt").offset, 2500, "posEntries.commit : mur haut → offset = nx (⟂ ignorée)");
  }
  });

  await section("ImageStore : helpers purs (dataUrl ↔ Blob · bundle .nmfb)", async () => {
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
  });

  await section("ImageStore : import/export EXPLICITE de la bibliothèque (.nmfb)", async () => {
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
  });

  await section("Images de façade : oreilles (with_ears) + règle « autre »", async () => {
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
  });

  await section("UndoTimeline : timeline d'undo unifiée (piles simulées)", async () => {
  {
    // Logique extraite de main.ts/boot (où elle était intestable) : deux piles, jetons chronologiques, plafond.
    const { UndoTimeline } = D("app/UndoTimeline.js");
    const mkStack = () => { const s = { u: 0, r: 0, canUndo: () => s.u > 0, canRedo: () => s.r > 0, undo: () => { s.u--; s.r++; }, redo: () => { s.r--; s.u++; } }; return s; };
    const model = mkStack(), image = mkStack();
    const t = new UndoTimeline();
    t.register("model", model); t.register("image", image);
    let changes = 0; t.onChange = () => { changes++; };
    model.u++; t.note("model"); image.u++; t.note("image"); model.u++; t.note("model");   // chronologie : M, I, M
    ck.eq(changes, 3, "onChange notifié à chaque note()");
    await t.undo(); ck.eq(model.u, 1, "undo 1 → dernière action (modèle) défaite");
    await t.undo(); ck.eq(image.u, 0, "undo 2 → image défaite (ordre chronologique inverse)");
    ck.eq(t.redoDepth, 2, "redoDepth suit les undos");
    await t.redo(); ck.eq(image.u, 1, "redo → image rétablie");
    model.u++; t.note("model");
    ck.eq(t.redoDepth, 0, "toute NOUVELLE action vide le redo unifié");
    // jeton dont la pile est épuisée (plafond côté pile) → sauté sans casser la timeline
    const t2 = new UndoTimeline(), m2 = mkStack(), i2 = mkStack();
    t2.register("model", m2); t2.register("image", i2);
    t2.note("model");   // jeton SANS undo réel (pile déjà épuisée)
    i2.u++; t2.note("image");
    ck.eq(await t2.undo(), true, "pile réelle défaite malgré le jeton fantôme en dessous");
    ck.eq(i2.u, 0, "…et c'est bien l'image qui a été défaite");
    ck.eq(await t2.undo(), false, "jeton épuisé sauté, plus rien à défaire → false");
    // filet de sécurité : timeline désynchronisée (vide) mais une pile encore dépilable
    const t3 = new UndoTimeline(), m3 = mkStack(); m3.u = 1;
    t3.register("model", m3);
    ck.eq(await t3.undo(), true, "filet : timeline vide mais pile dépilable → undo quand même");
    ck.eq(m3.u, 0, "…le filet a bien dépilé le modèle");
  }
  });

  await section("AutoSave : mécanique d'auto-save (hôte simulé, battement testé directement)", async () => {
  {
    const { AutoSave } = D("app/AutoSave.js");
    const mkHost = (over = {}) => {
      const h = {
        writes: 0, notices: [], states: [],
        fsApi: true, file: true, isDirty: true, perm: true,
        hasFsApi() { return h.fsApi; }, hasFile() { return h.file; }, dirty() { return h.isDirty; },
        ensureWritePermission: async () => h.perm,
        write: async () => { h.writes++; },
        pickFile: async () => {}, confirmEnable: async () => true,
        onStateChange: (on, i, s) => { h.states.push([on, i, s]); },
        notify: (m, k) => { h.notices.push([m, k]); },
      };
      return Object.assign(h, over);
    };
    // battement nominal : modifié + fichier lié → écrit
    const h1 = mkHost(); const a1 = new AutoSave({ autosave: true, autosaveInterval: 60 }, h1);
    await a1.tick(); ck.eq(h1.writes, 1, "tick : modifié + fichier → écrit");
    h1.isDirty = false; await a1.tick(); ck.eq(h1.writes, 1, "tick : propre → n'écrit PAS");
    // permission révoquée : désactive + notifie, n'écrit pas
    const p2 = { autosave: true, autosaveInterval: 60 };
    const h2 = mkHost({ perm: false }); const a2 = new AutoSave(p2, h2);
    await a2.tick();
    ck(h2.writes === 0 && p2.autosave === false, "tick : permission révoquée → désactivé, rien d'écrit");
    ck(h2.notices.some((n) => /permission/.test(n[0])), "tick : permission révoquée → notifié");
    a2.dispose();
    // activation sans FS API → refus notifié, préférence inchangée
    const p3 = { autosave: false, autosaveInterval: 30 };
    const h3 = mkHost({ fsApi: false }); const a3 = new AutoSave(p3, h3);
    await a3.setEnabled(true);
    ck(p3.autosave === false && h3.notices.some((n) => n[1] === "err"), "setEnabled(on) sans FS API → refusé + notifié");
    // activation sans fichier : dialogue accepté mais « Enregistrer sous » annulé → refus silencieux
    const p4 = { autosave: false, autosaveInterval: 30 };
    const h4 = mkHost({ file: false }); const a4 = new AutoSave(p4, h4);
    await a4.setEnabled(true);
    ck(p4.autosave === false && h4.states.length > 0 && h4.states[h4.states.length - 1][0] === false, "setEnabled(on) : « Enregistrer sous » annulé → chrome repassé à off");
    // désactivation
    const p5 = { autosave: true, autosaveInterval: 30 };
    const a5 = new AutoSave(p5, mkHost()); await a5.setEnabled(false); a5.dispose();
    ck.eq(p5.autosave, false, "setEnabled(off) → préférence coupée");
    // statut lisible
    ck(/File System Access/.test(new AutoSave(p5, mkHost({ fsApi: false })).statusHtml()), "statusHtml : navigateur sans FS API");
    ck(/off/.test(new AutoSave({ autosave: false, autosaveInterval: 30 }, mkHost()).statusHtml()), "statusHtml : off");
    ck(/actif/.test(new AutoSave({ autosave: true, autosaveInterval: 30 }, mkHost()).statusHtml()), "statusHtml : actif + intervalle");
  }
  });

  await section("CableRouteAnalyzer : grammaire de route EN ISOLATION (hôte RouteStoreView simulé)", async () => {
  {
    // L'automate est déjà couvert de bout en bout via le Store (qui délègue) ; ici on prouve la TESTABILITÉ
    // EN ISOLATION apportée par l'extraction : un hôte minimal simulé suffit, sans Store ni adapter.
    const { CableRouteAnalyzer } = D("store/CableRouteAnalyzer.js");
    const data = {
      waypoints: {
        w1: { id: "w1", name: "WP1", kind: "point", wp_type: "datacenter", datacenter_id: "dc1", dc_x: 1, dc_y: 1 },
        x1: { id: "x1", name: "X1", kind: "point", wp_type: "exit", datacenter_id: "dc1", dc_x: 2, dc_y: 2 },
        x2: { id: "x2", name: "X2", kind: "point", wp_type: "exit", datacenter_id: "dc2", dc_x: 3, dc_y: 3 },
      },
      datacenters: { dc1: { id: "dc1", name: "Salle A" }, dc2: { id: "dc2", name: "Salle B" } },
    };
    const view = {
      get: (c, id) => (data[c] && data[c][id]) || null,
      waypointIsPlaced: (wp) => wp.dc_x != null,
      equipmentDcId: () => null,
      effectiveWaypointIds: (cable) => cable.waypoint_ids || [],
      portsOf: () => [], cableOnPort: () => null, cablesOfEquipment: () => [], equipmentsOfRack: () => [],
      cableIsComplete: () => false,
    };
    const ra = new CableRouteAnalyzer(view);
    const ok = ra.cableRoute({ waypoint_ids: ["w1", "x1", "x2"] });
    ck(ok.valid && ok.hasExits && ok.startDc === "dc1" && ok.endDc === "dc2", "salle A → exit A → exit B : valide, bouts déduits");
    ck(ra.cableRoute({ waypoint_ids: ["x1"] }).errors.some((e) => e.code === "exit_unpaired"), "exit seul → exit_unpaired");
    ck(ra.cableRoute({ waypoint_ids: ["x1", "w1"] }).errors.some((e) => e.code === "room_wp_outside"), "waypoint de salle dans le tronçon hors salle → room_wp_outside");
    ck.eq(ra.routeHasRoomBreak({ waypoint_ids: ["x1", "w1"] }), true, "routeHasRoomBreak (codes stables) via l'hôte simulé");
    ck.eq(ra.dcName("dc2"), "Salle B", "dcName lu via l'hôte injecté");
    ck.eq(ra.cableRouteSummary(ok), "◆ Salle A → ⏏ Salle A → ⏏ Salle B", "résumé lisible de la route");
  }

  /* ================= SERVEUR : règles pures de la couche HTTP ================= */
  });
};
