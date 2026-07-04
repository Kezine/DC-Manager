/* Tests modules — entités, Store (CRUD, cascade, undo, routes, spares, sites…), helpers core.
   Sections extraites de run.js (audit P5) ; harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, mkStorage, Store, BrowserStorageAdapter, FieldIndex, Equipment, Cable, Port, Normalize, Labeler, ClickGuard, Projection, Box, Painter, RackGeometry, GraphGeometry, EquipmentTypes, PortRoles, Depths, EquipFaces, RackScene, Resolver3D, U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE, Html, Color, Format, GridGeometry, GraphView, Sort, Ip, Prefs, DatacenterView, FloorLayout, Positioning, DoorGeometry, Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM, DoorTool, Measure, CableSpline, MeasureTool, RouteTool, ImageStore, FaceImage, SaveState, EntityRegistry, ReloadPlanner, COLLECTION_THREE_IMPACT, RenderImpact, Changeset, SharedSchema, Text, PAGE_SIZE_DEFAULT, Validation, Cascade, Rack, CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS, makeStore } = require("./harness.js");

module.exports = async () => {
  await section("Entités : normalisation au constructeur", async () => {
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
  });

  await section("FieldIndex : sémantique d'égalité", async () => {
  {
    ck(FieldIndex.valueMatches(["a", "b"], "a"), "valueMatches : tableau contient");
    ck(FieldIndex.valueMatches(null, null), "valueMatches : null ⇔ vide");
    ck(FieldIndex.valueMatches("", null), "valueMatches : \"\" ⇔ vide");
    ck(!FieldIndex.valueMatches("x", "y"), "valueMatches : x ≠ y");
  }
  });

  await section("Store : CRUD + index FK", async () => {
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
  });

  await section("Store : cascade de suppression", async () => {
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
  });

  await section("Store : rechargement granulaire (P2 — reloadCollections / reloadMeta)", async () => {
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
  });

  await section("Store : undo / redo", async () => {
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
  });

  await section("Store : clone d'équipement (ports + agrégats)", async () => {
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
  });

  await section("ClickGuard (pure)", async () => {
  {
    const g = (dn, x, y, t, r) => ClickGuard.blocks(dn, x, y, t, r);
    ck.eq(g([100, 100], 100, 100, 4, false), false, "normale : immobile → passe");
    ck.eq(g([100, 100], 110, 100, 4, false), true, "normale : >4px → bloque");
    ck.eq(g([100, 100], 104, 100, 4, false), false, "normale : ==4px → passe (seuil strict)");
    ck.eq(g(null, 100, 100, 4, false), false, "normale : dn=null → passe");
    ck.eq(g(null, 100, 100, 4, true), true, "reservePan : dn=null → bloque");
    ck.eq(g([0, 0], 3, 3, 4, false), true, "euclidien : (3,3)=4.24px → bloque");
  }
  });

  await section("Labeler & registres de libellés (purs)", async () => {
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
  });

  await section("Store : route de câble (grammaire exit/OOB) + faisceaux", async () => {
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
  });

  await section("Helpers partagés purs (Html / Color / Format / GridGeometry)", async () => {
  {
    ck.eq(Html.escape('<a b="c">&\''), "&lt;a b=&quot;c&quot;&gt;&amp;&#39;", "Html.escape : entités");
    ck.eq(Html.escape(null), "", "Html.escape(null) → \"\"");
    ck.eq(JSON.stringify(Color.hexToRgb("#ff8800")), JSON.stringify({ r: 255, g: 136, b: 0 }), "Color.hexToRgb(#ff8800)");
    ck.eq(Color.hexToRgb("xyz"), null, "Color.hexToRgb(invalide) → null");
    ck.eq(Color.cssToHex("#ff8800"), 0xff8800, "Color.cssToHex(#rrggbb)");
    ck.eq(Color.cssToHex("#f80"), 0xff8800, "Color.cssToHex(#rgb → étendu)");
    ck.eq(Color.cssToHex("rgb(255, 136, 0)"), 0xff8800, "Color.cssToHex(rgb(...))");
    ck.eq(Number.isNaN(Color.cssToHex("bleu")), true, "Color.cssToHex(inconnu) → NaN");
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
  });

  await section("Sort.compare (tri de liste)", async () => {
  {
    ck(Sort.compare(1, 2) < 0, "compare : 1 < 2");
    ck(Sort.compare("b", "a") > 0, "compare : b > a");
    ck.eq(Sort.compare("a", "a"), 0, "compare : a == a");
    ck(Sort.compare("", "x") > 0, "compare : vide en dernier");
    ck(Sort.compare("item2", "item10") < 0, "compare : numérique naturel (2 < 10)");
  }
  });

  await section("Ip (IPv4 / CIDR pur)", async () => {
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
  });

  await section("Store : portConnectorSize (taille connecteur 3D)", async () => {
  {
    const s = await makeStore();
    const e = await s.create("equipments", { name: "x" });
    const pNoType = await s.create("ports", { equipment_id: e.id, name: "q" });
    ck.eq(JSON.stringify(s.portConnectorSize(pNoType)), JSON.stringify({ w: 13, h: 12 }), "portConnectorSize sans type → défaut RJ45 13×12");
    const sfp = s.all("portTypes").find((t) => (t.connector || t.family) === "SFP+");
    if (sfp) { const p = await s.create("ports", { equipment_id: e.id, name: "p", port_type_id: sfp.id }); const sz = s.portConnectorSize(p); ck(sz.w === 14 && sz.h === 9, "portConnectorSize(SFP+) → 14×9"); }
  }
  });

  await section("Prefs (préférences globales · localStorage)", async () => {
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
  });

  await section("Détection de modifications (dirty) + état de sauvegarde", async () => {
  {
    // ---- logique PURE de l'état de la pastille ----
    ck.eq(SaveState.compute({ dirty: false, hasFile: false, autosaveOn: false }), "mem", "save: mémoire propre → mem");
    ck.eq(SaveState.compute({ dirty: true, hasFile: false, autosaveOn: false }), "dirty", "save: mémoire modifiée → dirty");
    ck.eq(SaveState.compute({ dirty: false, hasFile: true, autosaveOn: false }), "clean", "save: fichier à jour → clean");
    ck.eq(SaveState.compute({ dirty: true, hasFile: true, autosaveOn: false }), "dirty", "save: fichier modifié (auto-save off) → dirty");
    ck.eq(SaveState.compute({ dirty: true, hasFile: true, autosaveOn: true }), "dirty-on", "save: fichier modifié (auto-save on) → dirty-on");
    // ---- l'auto-save n'écrit QUE si modifié ET fichier lié ----
    ck(!SaveState.shouldAutosave({ dirty: false, hasFile: true }), "auto-save: rien à écrire (propre) → non");
    ck(!SaveState.shouldAutosave({ dirty: true, hasFile: false }), "auto-save: pas de fichier lié → non");
    ck(SaveState.shouldAutosave({ dirty: true, hasFile: true }), "auto-save: modifié + fichier → oui");
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
  });

  await section("Store : contrat de NOTIFICATION (toute mutation déclenche onChange → dirty)", async () => {
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
  });

  await section("Store + SaveState : la révision pilote le dirty (undo ramène au propre)", async () => {
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
  });

  await section("Store : inventaire de spares (suivi unitaire + attribution + cascade)", async () => {
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
  });

  await section("Store : sites + removeSite (décommissionnement, liaisons logiques préservées)", async () => {
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
  });

  await section("Store : garde de validation (mode fichier — seul garde-fou, pas de serveur)", async () => {
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
  });

  await section("Store : onPersistError (échec de persistance méta/snapshot NOTIFIÉ)", async () => {
  {
    const s = await makeStore();
    let captured = null;
    s.onPersistError = (op, e) => { captured = { op, msg: e && e.message }; };
    s.adapter.saveMeta = async () => { throw new Error("réseau HS"); };
    await s.persistMeta();
    ck(!!captured && captured.op === "meta", "saveMeta échoue → onPersistError('meta') notifié");
    ck.eq(captured && captured.msg, "réseau HS", "l'erreur d'origine est transmise au hôte");
  }
  });
};
