/* Tests modules — entités, Store (CRUD, cascade, undo, routes, spares, sites…), helpers core.
   Sections extraites de run.js (audit P5) ; harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, mkStorage, Store, BrowserStorageAdapter, FieldIndex, Equipment, Cable, Port, Normalize, Labeler, ClickGuard, Projection, Box, Painter, RackGeometry, GraphGeometry, EquipmentTypes, PortRoles, Depths, EquipFaces, RackScene, Resolver3D, U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE, Html, Color, Format, GridGeometry, GraphView, Sort, FieldFacet, Ip, Markdown, VmNetMapping, VmIpMatch, VmClusterFormat, NotifyFormat, DEFAULT_REMIND_HOURS, Prefs, DatacenterView, FloorLayout, Positioning, DoorGeometry, Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM, DoorTool, Measure, CableSpline, MeasureTool, RouteTool, ImageStore, FaceImage, SaveState, EntityRegistry, ReloadPlanner, COLLECTION_THREE_IMPACT, RenderImpact, Changeset, SharedSchema, Text, PAGE_SIZE_DEFAULT, Validation, Cascade, PowerAnalysis, Rack, CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS, makeStore } = require("./harness.js");

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
    // GROUPES : group_id (primaire) + group_ids (tous). Migration legacy + primaire toujours membre + dédup.
    ck.eq(JSON.stringify(new Equipment({ group_id: "G1" }).group_ids), JSON.stringify(["G1"]), "Equipment.group_ids migré depuis group_id (legacy)");
    ck.eq(JSON.stringify(new Equipment({ group_id: "G1", group_ids: ["G2", "G1"] }).group_ids), JSON.stringify(["G1", "G2"]), "Equipment.group_ids : primaire remonté en tête + dédup");
    ck.eq(JSON.stringify(new Equipment({ group_ids: ["G2", "G2", "G3"] }).group_ids), JSON.stringify(["G2", "G3"]), "Equipment.group_ids : dédupliqué (sans primaire)");
    ck.eq(new Equipment({}).group_id, null, "Equipment.group_id défaut = null");
    // LARGEUR U : boîtier rétréci optionnel (null = pleine largeur) + alignement normalisé.
    ck.eq(new Equipment({}).u_width_mm, null, "Equipment.u_width_mm défaut = null (pleine largeur)");
    ck.eq(new Equipment({ u_width_mm: 200, u_align: "right" }).u_align, "right", "Equipment.u_align conservé");
    ck.eq(new Equipment({ u_align: "diagonal" }).u_align, "center", "Equipment.u_align hors liste → center");
    // CAPOTS : attribut physique de la baie — défaut AVEC capots (documents existants inchangés).
    ck.eq(new Rack({}).has_caps, true, "Rack.has_caps défaut = true (avec capots)");
    ck.eq(new Rack({ has_caps: false }).has_caps, false, "Rack.has_caps = false conservé (châssis ouvert)");
    ck.eq(new Rack({ has_caps: "n'importe quoi" }).has_caps, true, "Rack.has_caps : seul false explicite désactive");
    // PORTES : nombre de VANTAUX normalisé (1 par défaut, 2 = double battant ; "2" accepté, reste → 1).
    ck.eq(Normalize.rackDoor({}).leaves, 1, "rackDoor : leaves défaut = 1 (simple)");
    ck.eq(Normalize.rackDoor({ leaves: 2 }).leaves, 2, "rackDoor : leaves 2 conservé (double battant)");
    ck.eq(Normalize.rackDoor({ leaves: "2" }).leaves, 2, "rackDoor : '2' (chaîne) → 2");
    ck.eq(Normalize.rackDoor({ leaves: 3 }).leaves, 1, "rackDoor : valeur hors {1,2} → 1");
    const dd = Normalize.dcDoors([{ wall: "top", offset: 100 }, { wall: "left", offset: 200, leaves: 2 }]);
    ck.eq(dd[0].leaves, 1, "dcDoors : leaves défaut = 1");
    ck.eq(dd[1].leaves, 2, "dcDoors : leaves 2 conservé");
  }
  });

  await section("FieldFacet : suggestions distinctes facettées (autocomplétion)", async () => {
  {
    const recs = [
      { id: "1", brand: "Cisco", model: "C9200", name: "sw-01" },
      { id: "2", brand: "Cisco", model: "C9300", name: "sw-02" },
      { id: "3", brand: "Cisco", model: "C9200", name: "sw-03" },   // C9200 en double (fréquence)
      { id: "4", brand: "Dell", model: "N3248", name: "sw-04" },
      { id: "5", brand: "", model: "", name: "" },                  // valeurs vides ignorées
    ];
    ck.eq(JSON.stringify(FieldFacet.suggest(recs, "brand")), JSON.stringify(["Cisco", "Dell"]), "valeurs distinctes, vides ignorées, triées par fréquence");
    ck.eq(JSON.stringify(FieldFacet.suggest(recs, "model", { query: "c9" })), JSON.stringify(["C9200", "C9300"]), "filtre par saisie (accents/casse ignorés)");
    ck.eq(JSON.stringify(FieldFacet.suggest(recs, "model", { context: { brand: "Dell" } })), JSON.stringify(["N3248"]), "recherche FACETTÉE : modèles de la marque en contexte");
    ck.eq(FieldFacet.suggest(recs, "model", { limit: 1 }).length, 1, "plafond (limit) respecté");
    ck.eq(FieldFacet.clampLimit(999), FieldFacet.MAX_RESULTS_ABS, "clampLimit borne au plafond absolu (100)");
    ck.eq(FieldFacet.clampLimit(0), FieldFacet.MAX_RESULTS_DEFAULT, "clampLimit : valeur invalide → défaut");
    ck.eq(FieldFacet.suggest(recs, "name", { excludeId: "1" }).includes("sw-01"), false, "excludeId : l'enregistrement édité ne s'auto-suggère pas");
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

  await section("Store : migration one-shot profondeur enum → depth_mm (au chargement)", async () => {
  {
    const s = await makeStore();
    await s.replaceAll({
      meta: { docName: "t" },
      racks: [{ id: "R1", name: "R", u_count: 42, depth: 1000, cage_depth_mm: 800 }],
      equipments: [
        { id: "E1", name: "half-racké", placement_mode: "rack", rack_id: "R1", rack_u: 1, depth: "half" },
        { id: "E2", name: "full-libre", depth: "full" },
        { id: "E3", name: "déjà-mm", depth: "half", depth_mm: 555 },
      ],
    });
    ck.eq(s.get("equipments", "E1").depth_mm, 400, "half racké → 50 % de la cage de SA baie (800) = 400");
    ck.eq(s.get("equipments", "E1").locks_u, false, "half legacy → une seule face (locks_u false) préservé");
    ck.eq(s.get("equipments", "E2").depth_mm, 1000, "full non racké → cage de la baie par défaut (1000)");
    ck.eq(s.get("equipments", "E2").locks_u, true, "full legacy → 2 faces (locks_u forcé, compat occupation)");
    ck.eq(s.get("equipments", "E3").depth_mm, 555, "depth_mm déjà présent → intouché");
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
    // COPIE = NON PLACÉE : un équipement POSÉ SUR UNE ÉTAGÈRE ne doit pas être cloné au même endroit
    // (chevauchement V6e) — tous les placements sont effacés, le clone est « non placé » (valide).
    const dc = await s.create("datacenters", { name: "DC" });
    const rk2 = await s.create("racks", { name: "RK2", datacenter_id: dc.id, dc_x: 500, dc_y: 500, sides: "dual" });
    const tray = await s.create("rackItems", { rack_id: rk2.id, kind: "tray", tray_type: "cantilever", u: 3, u_height: 3, tray_u: 1, depth_mm: 400 });
    const onTray = await s.create("equipments", { name: "posé", dim_mode: "free", placement_mode: "tray", tray_item_id: tray.id, tray_x: 10, tray_y: 10, free_w_mm: 100, free_l_mm: 100, free_h_mm: 40 });
    const c2 = await s.cloneEquipment(onTray.id);
    ck(c2 && c2.tray_item_id === null && c2.tray_x === null && c2.tray_y === null, "clone d'un posé : placement étagère effacé");
    ck.eq(c2.placement_mode, "manual", "clone d'un posé (free) : mode « manual » (non placé)");
    ck.eq(s.equipmentsOnTray(tray.id).length, 1, "clone posé : l'étagère ne porte QUE l'original");
    // le clone NON PLACÉ passe la validation PARTAGÉE (même autorité que le serveur) ; à l'inverse, un
    // clone qui aurait GARDÉ la position de l'original serait REJETÉ (chevauchement V6e).
    const fetch = (coll, id) => s.get(coll, id) || null;
    const find = (coll, field, value) => s.findByField(coll, field, value);
    ck.eq(Validation.DataValidator.validateRecord("equipments", c2.toJSON(), fetch, find).length, 0, "clone posé : conforme (validation partagée, autorité serveur)");
    const overlapping = Object.assign({}, c2.toJSON(), { placement_mode: "tray", tray_item_id: tray.id, tray_x: 10, tray_y: 10 });
    ck(Validation.DataValidator.validateRecord("equipments", overlapping, fetch, find).some((e) => /[Cc]hevauche/.test(e.message)), "contre-preuve : même position que l'original → rejet V6e (le serveur refuserait)");
    // CLONE GÉNÉRIQUE (cloneSimple) : passe désormais par la validation → un DOUBLON en violation de portée est
    // REFUSÉ localement (plus de « copie locale appliquée mais refusée par le serveur »). Brosse au même U → V6c.
    const brush = await s.create("waypoints", { kind: "brush", wp_type: "datacenter", datacenter_id: dc.id, rack_id: rk2.id, rack_u: 20, u_height: 2, depth_mm: 100 });
    ck(!!brush, "setup : brosse montée en baie");
    const before = s.all("waypoints").length;
    const bc = await s.cloneSimple("waypoints", brush.id);
    ck.eq(bc, null, "cloneSimple : brosse au même U → REFUSÉE (collision V6c, aucun doublon appliqué)");
    ck.eq(s.all("waypoints").length, before, "cloneSimple refusé : cache local INCHANGÉ (pas de divergence)");
    // clone SANS conflit de portée → copie créée normalement
    const grp = await s.create("groups", { label: "G", type: "stack" });
    const gc = await s.cloneSimple("groups", grp.id);
    ck(!!gc && gc.label === "G (copie)", "cloneSimple : sans conflit → copie créée");
    // APPARTENANCE multi-groupe : equipmentsOfGroup couvre le PRIMAIRE ET les SECONDAIRES (index group_ids).
    const g2 = await s.create("groups", { label: "G2", type: "general" });
    const multiEq = await s.create("equipments", { name: "multi", group_id: grp.id, group_ids: [grp.id, g2.id] });
    ck.eq(s.equipmentsOfGroup(grp.id).some((e) => e.id === multiEq.id), true, "equipmentsOfGroup : trouve par groupe PRIMAIRE");
    ck.eq(s.equipmentsOfGroup(g2.id).some((e) => e.id === multiEq.id), true, "equipmentsOfGroup : trouve par groupe SECONDAIRE");
    ck.eq(JSON.stringify(s.equipmentGroupIds(multiEq)), JSON.stringify([grp.id, g2.id]), "equipmentGroupIds : primaire + secondaires");
    // RETRAIT DE BAIE (équipement U) : la convention « pool » = placement_mode "rack" + rack_id/rack_u null.
    // T1 corrigé (teste rack_u, pas placement_mode) → le retrait N'EST PLUS silencieusement rejeté.
    const racked = await s.create("equipments", { name: "U-eq", rack_id: rk2.id, placement_mode: "rack", rack_u: 30 });
    const nrem = await s.updateBatch([{ collection: "equipments", id: racked.id, patch: { placement_mode: "rack", dim_mode: "u", rack_id: null, rack_u: null } }]);
    ck.eq(nrem, 1, "retrait de baie (U) : accepté (updateBatch = 1)");
    ck.eq(s.get("equipments", racked.id).rack_id, null, "retrait de baie (U) : rack_id effacé (retrait EFFECTIF)");
    // updateBatch CONSCIENT DU LOT : deux équipements posés côte à côte, on les rapproche tous les deux dans le
    // MÊME lot de sorte que la nouvelle position de A est là où B ÉTAIT (pré-lot). Sans conscience du lot, V6e
    // rejetterait (faux chevauchement contre l'ancienne position de B). Prérequis du reflow d'étagère.
    const tray2 = await s.create("rackItems", { rack_id: rk2.id, kind: "tray", tray_type: "cantilever", u: 15, u_height: 3, tray_u: 1, depth_mm: 400 });
    const eqL = await s.create("equipments", { name: "L", dim_mode: "free", placement_mode: "tray", tray_item_id: tray2.id, tray_x: 0, tray_y: 10, free_w_mm: 100, free_l_mm: 100, free_h_mm: 40 });
    const eqR = await s.create("equipments", { name: "R", dim_mode: "free", placement_mode: "tray", tray_item_id: tray2.id, tray_x: 150, tray_y: 10, free_w_mm: 100, free_l_mm: 100, free_h_mm: 40 });
    const nmove = await s.updateBatch([
      { collection: "equipments", id: eqL.id, patch: { tray_x: 120 } },   // L: 0→120 (empiète l'ANCIENNE emprise de R : 150..250)... non : 120..220 chevauche 150..250
      { collection: "equipments", id: eqR.id, patch: { tray_x: 250 } },   // R: 150→250, libère la place
    ]);
    ck.eq(nmove, 2, "updateBatch conscient du lot : repositionnement croisé accepté (pas de faux chevauchement)");
    ck(s.get("equipments", eqL.id).tray_x === 120 && s.get("equipments", eqR.id).tray_x === 250, "updateBatch : les deux positions appliquées");
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
    // Noms d'équipement UNIQUES par document (contrainte V6g) : la baie préfixe le nom (deux baies au même U).
    const mkEqPort = async (rack, u) => { const e = await s.create("equipments", { name: "e" + rack.name + u, placement_mode: "rack", rack_id: rack.id, rack_u: u }); return (await s.create("ports", { equipment_id: e.id, name: "p" })).id; };
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

    // faisceaux : occupation du pool de fibres — piochée par les PORTS de patch (source UNIQUE des brins)
    const ct = s.all("cableTypes")[0];
    const bundle = await s.create("cableBundles", { name: "T1", cable_type_id: ct ? ct.id : null, fiber_count: 4, waypoint_ids: [exitA.id, oob.id, exitB.id] });
    const eqPatch = await s.create("equipments", { name: "patchA", type: "patch_panel" });
    await s.create("ports", { equipment_id: eqPatch.id, name: "P01", bundle_id: bundle.id, strand_a: 2, strand_b: 3 });
    const occ = s.bundleOccupancy(bundle.id);
    ck(occ.used === 2 && occ.capacity === 4 && occ.free === 2 && occ.nextStrand === 1, "bundleOccupancy : port duplex {2,3} → 2/4, nextStrand=1 (1re fibre libre)");
    await s.create("ports", { equipment_id: eqPatch.id, name: "P02", bundle_id: bundle.id, strand_a: 1 });
    const occ2 = s.bundleOccupancy(bundle.id);
    ck(occ2.used === 3 && occ2.free === 1 && occ2.nextStrand === 4, "bundleOccupancy : {1,2,3} piochés → 3/4, nextStrand=4");
    ck.eq(s.portsOfBundle(bundle.id).length, 2, "portsOfBundle : 2 ports de patch piochent dans le trunk");

    // -- DÉDUCTION RÉSEAU multi-hop : réseau asserté sur un port terminal, propagé à travers patch + trunk --
    const netN = await s.create("networks", { label: "VLAN 30" });
    const dev1 = await s.create("equipments", { name: "sw1" });
    const dev2 = await s.create("equipments", { name: "sw2" });
    const patA = await s.create("equipments", { name: "patchA2", type: "patch_panel" });   // nom UNIQUE (V6g) : « patchA » déjà pris ci-dessus
    const patB = await s.create("equipments", { name: "patchB", type: "patch_panel" });
    const trunk = await s.create("cableBundles", { name: "T-OM4", fiber_count: 12, endpoint_a_equipment_id: patA.id, endpoint_b_equipment_id: patB.id });
    const pD1 = await s.create("ports", { equipment_id: dev1.id, name: "g1", network_ids: [netN.id], network_id: netN.id });   // ASSERTION
    const pD2 = await s.create("ports", { equipment_id: dev2.id, name: "g1" });                                               // JOKER (aucun réseau)
    const pPA = await s.create("ports", { equipment_id: patA.id, name: "P1", bundle_id: trunk.id, strand_a: 1, strand_b: 2 });
    const pPB = await s.create("ports", { equipment_id: patB.id, name: "P1", bundle_id: trunk.id, strand_a: 1, strand_b: 2 });
    await s.create("cables", { from_port_id: pD1.id, to_port_id: pPA.id });               // jumper dev1 ↔ patch A
    const jumperB = await s.create("cables", { from_port_id: pPB.id, to_port_id: pD2.id }); // jumper patch B ↔ dev2 (joker)
    ck.eq(JSON.stringify(s.deducedNetworkIds([pD2.id])), JSON.stringify([netN.id]), "déduction multi-hop : dev2 (joker) hérite le réseau via patch + trunk");
    ck.eq(s.cablePrimaryNetworkId(jumperB), netN.id, "jumper côté B : réseau principal DÉDUIT (multi-hop)");
    ck.eq(s.deducedNetworkIds([pPB.id]).indexOf(netN.id) >= 0, true, "port de patch : réseau déduit du chemin (ne l'assert pas lui-même)");
    ck.eq(s.cablesOfNetwork(netN.id).some((c) => c.id === jumperB.id), true, "cablesOfNetwork : le jumper déduit est inclus");
    // #5 — le réseau PRINCIPAL déduit honore network_id du port (pas l'ordre d'ajout du BFS network_ids[0]).
    const netB = await s.create("networks", { label: "VLAN 40" });
    const dev3 = await s.create("equipments", { name: "sw3" });
    const dev4 = await s.create("equipments", { name: "sw4" });
    const pMulti = await s.create("ports", { equipment_id: dev3.id, name: "g1", network_ids: [netN.id, netB.id], network_id: netB.id });   // principal = netB (2e)
    const pPlain = await s.create("ports", { equipment_id: dev4.id, name: "g1" });
    const jm = await s.create("cables", { from_port_id: pMulti.id, to_port_id: pPlain.id });
    ck.eq(s.cablePrimaryNetworkId(jm), netB.id, "#5 : réseau principal = network_id choisi (netB), pas network_ids[0]");
    // P8a : invalider le cache AVANT le 2e assert — sinon pPlain, mémoïsé par l'appel ci-dessus, rendrait le 2e appel
    // un HIT de cache garanti (fausse couverture) et l'indépendance à l'ordre de parcours ne serait PAS testée.
    // Mutation NEUTRE (description d'un port joker sans réseau) : vide le cache (_emit) sans changer la déduction.
    await s.update("ports", pPlain.id, { description: "ping-cache" });
    ck.eq(s.cablePrimaryNetworkId({ from_port_id: pPlain.id, to_port_id: pMulti.id }), netB.id, "#5 : principal STABLE quel que soit le sens de parcours (cache vidé → vrai recalcul)");
    // #9 — cache de déduction invalidé à la mutation : changer le réseau du port change le résultat.
    await s.update("ports", pMulti.id, { network_ids: [netN.id], network_id: netN.id });
    ck.eq(s.cablePrimaryNetworkId(jm), netN.id, "#9 : cache réseau invalidé après mutation d'un port");
    // equipmentDcId via baie hôte
    const eqInA = s.get("ports", pA1) ? s.get("equipments", s.get("ports", pA1).equipment_id) : null;
    ck.eq(s.equipmentDcId(eqInA.id), dcA.id, "equipmentDcId(équipement racké) → salle de la baie");

    // contrainte de placement (câblage) : un équipement LIBRE câblé intra-salle vers pA1 (Salle A)
    const eqX = await s.create("equipments", { name: "X" });
    const pX = (await s.create("ports", { equipment_id: eqX.id, name: "pX" })).id;
    const lien = await s.create("cables", { name: "lien", from_port_id: pX, to_port_id: pA1 });
    // portDcId / cableDcId : résolveurs PARTAGÉS des boutons « Localiser en 3D » (parité locatePort/locateCable
    // de la vue 3D) — à ce stade eqX est encore NON PLACÉ (il n'est mis en baie que plus bas).
    ck.eq(s.portDcId(pA1), dcA.id, "portDcId : port d'un équipement racké → salle de la baie");
    ck.eq(s.portDcId(pX), null, "portDcId : port d'un équipement non placé → null");
    ck.eq(s.cableDcId(lien.id), dcA.id, "cableDcId : une extrémité localisable suffit → sa salle");
    ck.eq(s.cableDcId(jm), null, "cableDcId : aucune extrémité en salle → null (bouton Localiser masqué)");
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

  await section("Validation : régressions audit (unicité de brin par extrémité · P4 revalidation inverse)", async () => {
  {
    const s = await makeStore();
    // ---- unicité de FIBRE physique PAR EXTRÉMITÉ (ports de patch — source unique des brins, V6) ----
    const bundle = await s.create("cableBundles", { name: "trunk", fiber_count: 12 });
    const patch = await s.create("equipments", { name: "patch", type: "patch_panel" });
    const okPort = await s.create("ports", { equipment_id: patch.id, name: "P2", bundle_id: bundle.id, strand_a: 6 });
    ck.eq(!!okPort, true, "brin : fibre 6 libre → accepté");
    const clash = await s.create("ports", { equipment_id: patch.id, name: "P3", bundle_id: bundle.id, strand_a: 6 });
    ck.eq(clash, null, "brin : fibre 6 déjà piochée par un port du MÊME patch → refusé (V6)");

    // ---- P4b : réduire fiber_count SOUS un brin de port pioché → refusé (dependent cableBundles→ports, T6) ----
    const shrink = await s.update("cableBundles", bundle.id, { fiber_count: 5 });
    ck.eq(shrink, null, "P4b : réduire fiber_count sous un brin de port (6 > 5) → refusé (dependent T6)");
    const shrinkOk = await s.update("cableBundles", bundle.id, { fiber_count: 8 });
    ck.eq(!!shrinkOk, true, "P4b : réduire à 8 (≥ brins piochés) → accepté");

    // ---- P4a : re-typer un équipement en patch alors qu'un port ASSERT → refusé (dependent equipments→ports, T7) ----
    const net = await s.create("networks", { label: "VLAN 10" });
    const sw = await s.create("equipments", { name: "sw" });   // type par défaut = terminal (peut assurer un réseau)
    const asserting = await s.create("ports", { equipment_id: sw.id, name: "g1", network_ids: [net.id], network_id: net.id });
    ck.eq(!!asserting, true, "P4a setup : port assertant un réseau sur un équipement terminal");
    const toPatch = await s.update("equipments", sw.id, { type: "patch_panel" });
    ck.eq(toPatch, null, "P4a : passer l'équipement à patch alors qu'un port assert → refusé (dependent T7)");
    await s.update("ports", asserting.id, { network_ids: [], network_id: null });
    const toPatch2 = await s.update("equipments", sw.id, { type: "patch_panel" });
    ck.eq(!!toPatch2, true, "P4a : après vidage du port, le passage à patch est accepté");

    // ---- T10/T11 : extrémités de faisceau = 2 PATCHS DISTINCTS (refus direct + dépendance inverse au re-typage) ----
    const endA = await s.create("equipments", { name: "patch-A", type: "patch_panel" });
    const endB = await s.create("equipments", { name: "patch-B", type: "patch_panel" });
    const notAPatch = await s.create("equipments", { name: "serveur-X", type: "serveur" });
    const looped = await s.create("cableBundles", { name: "trunk-bouclé", endpoint_a_equipment_id: endA.id, endpoint_b_equipment_id: endA.id });
    ck.eq(looped, null, "T10 : faisceau bouclé sur le même patch → refusé (invariant)");
    const onServer = await s.create("cableBundles", { name: "trunk-KO", endpoint_a_equipment_id: notAPatch.id, endpoint_b_equipment_id: endB.id });
    ck.eq(onServer, null, "T11 : extrémité sur un équipement NON patch → refusé (cross-entité)");
    const anchored = await s.create("cableBundles", { name: "trunk-ancré", endpoint_a_equipment_id: endA.id, endpoint_b_equipment_id: endB.id });
    ck.eq(!!anchored, true, "T11 : faisceau entre 2 patchs distincts → accepté");
    const retype = await s.update("equipments", endA.id, { type: "switch" });
    ck.eq(retype, null, "T11 inverse : re-typer un patch qui ancre un faisceau → refusé (dependent equipments→cableBundles)");

    // ---- P4c : changer la direction d'un port CÂBLÉ pour créer source↔source → refusé (dependent ports→cables, T9) ----
    const pdu = await s.create("equipments", { name: "pdu" });
    const srv = await s.create("equipments", { name: "srv" });
    const outlet = await s.create("ports", { equipment_id: pdu.id, name: "out", role: "power", direction: "source" });
    const inlet = await s.create("ports", { equipment_id: srv.id, name: "in", role: "power", direction: "sink" });
    const feed = await s.create("cables", { name: "feed", from_port_id: outlet.id, to_port_id: inlet.id });
    ck.eq(!!feed, true, "P4c setup : câble power source↔sink accepté");
    const flip = await s.update("ports", inlet.id, { direction: "source" });
    ck.eq(flip, null, "P4c : passer un port câblé sink→source (crée source↔source) → refusé (dependent T9)");
  }
  });

  await section("Normalize.mergePrincipal (fusion réseau pure — anti-clobber #14 / P5 / P8c)", async () => {
  {
    const J = (o) => JSON.stringify({ network_id: o.network_id, network_ids: o.network_ids, removed: o.removed });
    // JOKER (next vide) : aucun réseau ; removed = nb retiré (perte SIGNALÉE, pas silencieuse — « joker + ids » irreprésentable)
    ck.eq(J(Normalize.mergePrincipal(["a", "b"], "a", "")), JSON.stringify({ network_id: null, network_ids: [], removed: 2 }), "joker : vide network_ids, removed=2");
    ck.eq(J(Normalize.mergePrincipal([], null, "")), JSON.stringify({ network_id: null, network_ids: [], removed: 0 }), "joker sur port déjà vide : removed=0");
    // port MONO : changer le principal REMPLACE (pas d'ancien principal fantôme inamovible)
    ck.eq(J(Normalize.mergePrincipal(["a"], "a", "c")), JSON.stringify({ network_id: "c", network_ids: ["c"], removed: 0 }), "mono a→c : REMPLACE ([c], pas [c,a])");
    ck.eq(J(Normalize.mergePrincipal(["a"], "a", "a")), JSON.stringify({ network_id: "a", network_ids: ["a"], removed: 0 }), "mono a→a : idempotent");
    // MULTI préexistant : additionnels PRÉSERVÉS, nouveau principal en tête
    ck.eq(J(Normalize.mergePrincipal(["a", "b"], "a", "b")), JSON.stringify({ network_id: "b", network_ids: ["b", "a"], removed: 0 }), "multi [a,b] principal a→b : [b,a]");
    ck.eq(J(Normalize.mergePrincipal(["a", "b"], "a", "c")), JSON.stringify({ network_id: "c", network_ids: ["c", "a", "b"], removed: 0 }), "multi [a,b]→c : [c,a,b]");
  }
  });

  await section("PowerAnalysis : traversée énergie (racine, phase, tension, charge, warnings)", async () => {
  {
    const s = await makeStore();
    const pa = new PowerAnalysis(s);
    // réseau power d'origine (tension 230 V) ; TABLEAU racine avec 1 départ (L1, calibre 16 A, porte l'origine)
    const pnet = await s.create("networks", { label: "UPS-A", kind: "power", voltage: 230, max_amp: 32 });
    const tab = await s.create("equipments", { name: "TGBT", type: "tableau" });
    const depart = await s.create("ports", { equipment_id: tab.id, name: "Q1", role: "power", direction: "source", power_max_a: 16, phase: "L1", network_ids: [pnet.id], network_id: pnet.id });
    // PDU (pass-through) : inlet sink + outlet source
    const pdu = await s.create("equipments", { name: "PDU-A", type: "pdu" });
    const pduIn = await s.create("ports", { equipment_id: pdu.id, name: "IN", role: "power", direction: "sink", power_max_a: 16 });
    const pduOut = await s.create("ports", { equipment_id: pdu.id, name: "C1", role: "power", direction: "source", power_max_a: 16 });
    // SERVEUR consommateur : 460 W nominal / 600 W max, 1 PSU (sink) sous-dimensionnée (2 A → 460 W < 600 W max)
    const srv = await s.create("equipments", { name: "srv1", power_nominal_w: 460, power_max_w: 600 });
    const psu = await s.create("ports", { equipment_id: srv.id, name: "PSU1", role: "power", direction: "sink", power_max_a: 2 });
    await s.create("cables", { from_port_id: depart.id, to_port_id: pduIn.id });   // tableau → PDU
    await s.create("cables", { from_port_id: pduOut.id, to_port_id: psu.id });      // PDU → serveur

    ck.eq(JSON.stringify(pa.rootSourcesOf(psu.id)), JSON.stringify([depart.id]), "power : racine du serveur = le départ du tableau (remontée multi-hop via PDU)");
    ck.eq(pa.deducedPhaseOf(psu.id), "L1", "power : phase déduite = L1 (héritée du départ)");
    ck.eq(pa.deducedVoltageOf(psu.id), 230, "power : tension déduite = 230 V (réseau d'origine)");
    const dl = pa.departLoads(tab.id)[0];
    ck(Math.abs(dl.usedA - 2) < 0.01 && dl.capacityA === 16 && !dl.warn && !dl.overloaded, "power : charge du départ ≈ 2 A / 16 A (460 W / 230 V), pas d'alerte");
    const pl = pa.phaseLoads(tab.id).find((x) => x.key === "L1");
    ck(pl && Math.abs(pl.usedA - 2) < 0.01, "power : charge de la phase L1 ≈ 2 A");
    ck.eq(pa.equipmentWarnings(srv.id).some((w) => w.code === "psu_undersized"), true, "power : PSU 2 A insuffisante pour 600 W max → warning");

    // SPOF : serveur à 2 PSU câblées sur 2 sorties du MÊME PDU → même racine (départ) = point unique de défaillance.
    const srv2 = await s.create("equipments", { name: "srv2", power_nominal_w: 200 });
    const out2 = await s.create("ports", { equipment_id: pdu.id, name: "C2", role: "power", direction: "source", power_max_a: 16 });
    const out3 = await s.create("ports", { equipment_id: pdu.id, name: "C3", role: "power", direction: "source", power_max_a: 16 });
    const p2a = await s.create("ports", { equipment_id: srv2.id, name: "PSU1", role: "power", direction: "sink", power_max_a: 4 });
    const p2b = await s.create("ports", { equipment_id: srv2.id, name: "PSU2", role: "power", direction: "sink", power_max_a: 4 });
    await s.create("cables", { from_port_id: out2.id, to_port_id: p2a.id });
    await s.create("cables", { from_port_id: out3.id, to_port_id: p2b.id });
    ck.eq(pa.equipmentWarnings(srv2.id).some((w) => w.code === "spof"), true, "power : 2 PSU sur le même PDU → SPOF (même origine)");

    // PSU non câblée : serveur à 2 PSU, une seule reliée → redondance amoindrie.
    const srv3 = await s.create("equipments", { name: "srv3", power_nominal_w: 100 });
    const out4 = await s.create("ports", { equipment_id: pdu.id, name: "C4", role: "power", direction: "source", power_max_a: 16 });
    const p3a = await s.create("ports", { equipment_id: srv3.id, name: "PSU1", role: "power", direction: "sink", power_max_a: 4 });
    await s.create("ports", { equipment_id: srv3.id, name: "PSU2", role: "power", direction: "sink", power_max_a: 4 });   // non câblée
    await s.create("cables", { from_port_id: out4.id, to_port_id: p3a.id });
    ck.eq(pa.equipmentWarnings(srv3.id).some((w) => w.code === "psu_uncabled"), true, "power : 1 PSU sur 2 câblée → warning non câblée");

    // #6/#4 — un sink câblé vers un port SANS sens (data) n'est PAS alimenté → no_source (isFedSink false).
    const srv4 = await s.create("equipments", { name: "srv4", power_nominal_w: 100 });
    const p4a = await s.create("ports", { equipment_id: srv4.id, name: "PSU1", role: "power", direction: "sink", power_max_a: 4 });
    const other = await s.create("equipments", { name: "misc" });
    const dataPort = await s.create("ports", { equipment_id: other.id, name: "g2" });   // direction "" (data)
    await s.create("cables", { from_port_id: p4a.id, to_port_id: dataPort.id });        // câblé mais pas vers une source
    ck.eq(pa.rootSourcesOf(p4a.id).length, 0, "power : sink câblé vers un port sans sens → aucune racine");
    ck.eq(pa.equipmentWarnings(srv4.id).some((w) => w.code === "no_source"), true, "power : sink câblé mais non alimenté → no_source");
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

  await section("VmNetMapping : mapping vNIC (bridge/tag → réseau logique)", async () => {
  {
    // --- normalize : bridge/network_id requis, tag entier|null, dédoublonnage « dernière gagne » ---
    const norm = VmNetMapping.normalize([
      { bridge: "vmbr0", vlan_tag: 10, network_id: "netA" },
      { bridge: "vmbr0", vlan_tag: null, network_id: "netB" },   // sans tag ≠ tag 10 → conservé distinct
      { bridge: "vmbr0", vlan_tag: "10", network_id: "netC" },   // MÊME couple que la 1re → dernière gagne
      { bridge: "", vlan_tag: 5, network_id: "netX" },           // bridge vide → rejet
      { bridge: "vmbr1", vlan_tag: 20, network_id: "" },         // network_id vide → rejet
      { bridge: "vmbr2", vlan_tag: 7.9, network_id: "netD" },    // tag fractionnaire → tronqué en 7
    ]);
    ck.eq(norm.length, 3, "normalize : 3 entrées valides (rejets + dédoublonnage)");
    const bt = norm.find((e) => e.bridge === "vmbr0" && e.vlan_tag === 10);
    ck.eq(bt && bt.network_id, "netC", "normalize : dernière occurrence gagne (netC)");
    ck(norm.some((e) => e.bridge === "vmbr0" && e.vlan_tag === null && e.network_id === "netB"), "normalize : couple sans-tag conservé distinct du tagué");
    ck(norm.some((e) => e.bridge === "vmbr2" && e.vlan_tag === 7), "normalize : tag fractionnaire tronqué en entier");
    ck.eq(VmNetMapping.normalize("pas un tableau").length, 0, "normalize : entrée non-tableau → [] (tolérant)");

    // --- resolve : correspondance EXACTE, aucun repli approximatif ---
    ck.eq(VmNetMapping.resolve(norm, "vmbr0", 10), "netC", "resolve : couple exact bridge+tag → netC");
    ck.eq(VmNetMapping.resolve(norm, "vmbr0", null), "netB", "resolve : sans tag → netB (distinct de tag 10)");
    ck.eq(VmNetMapping.resolve(norm, "vmbr0", 42), null, "resolve : tag inconnu → null (pas de repli sur sans-tag)");
    ck.eq(VmNetMapping.resolve(norm, "vmbr9", 10), null, "resolve : bridge inconnu → null");
    ck.eq(VmNetMapping.resolve(norm, "vmbr0", "10"), "netC", "resolve : tag en chaîne normalisé comme entier");

    // --- unmappedPairs : couples des vNIC absents de la table, dédoublonnés, triés (sans-tag d'abord) ---
    const vms = [
      { nics: [{ bridge: "vmbr1", vlan_tag: null }, { bridge: "vmbr0", vlan_tag: 30 }] },
      { nics: [{ bridge: "vmbr0", vlan_tag: 30 }, { bridge: "vmbr0", vlan_tag: 10 }] },   // vmbr0/10 est mappé → exclu
      { nics: [{ bridge: "vmbr2", vlan_tag: 5 }, { bridge: "vmbr2", vlan_tag: null }] },
      { nics: [{ bridge: "", vlan_tag: 5 }] },   // vNIC sans bridge → ignorée
      { nics: [] },
      {},                                        // VM sans nics → tolérée
    ];
    const unmapped = VmNetMapping.unmappedPairs(norm, vms);
    ck.eq(JSON.stringify(unmapped), JSON.stringify([
      { bridge: "vmbr0", vlan_tag: 30 },
      { bridge: "vmbr1", vlan_tag: null },
      { bridge: "vmbr2", vlan_tag: null },   // sans tag avant le tag numérique du même pont
      { bridge: "vmbr2", vlan_tag: 5 },
    ]), "unmappedPairs : absents, dédoublonnés, triés bridge puis tag (sans-tag d'abord)");
    ck.eq(VmNetMapping.unmappedPairs(norm, null).length, 0, "unmappedPairs : vms null → [] (tolérant)");

    // --- read : lecture tolérante depuis la méta (clé dédiée, absence → []) ---
    ck.eq(VmNetMapping.read(null).length, 0, "read : méta nulle → []");
    ck.eq(VmNetMapping.read({}).length, 0, "read : clé absente → []");
    const meta = {}; meta[VmNetMapping.META_KEY] = [{ bridge: "vmbr0", vlan_tag: 5, network_id: "n1" }];
    ck.eq(VmNetMapping.read(meta).length, 1, "read : entrées normalisées lues depuis META_KEY");
    ck.eq(VmNetMapping.META_KEY, "vmNetMappings", "META_KEY : clé méta dédiée (hors clés existantes)");
  }
  });

  await section("VmIpMatch : rapprochement IP assisté (propositions ipAddresses ↔ IPs constatées des vNIC)", async () => {
  {
    // VM avec deux vNIC ; net0 constate deux IPs (dont une en CIDR), net1 une IP.
    const vm = { id: "vmA", name: "VM A", nics: [
      { name: "net0", ips: ["10.0.0.5", " 10.0.0.6 "] },
      { name: "net1", ips: ["10.0.0.7/24"] },
    ] };

    // --- correspondance EXACTE + normalisation (trim, préfixe CIDR retiré des deux côtés) ---
    const base = [
      { id: "a1", address: "10.0.0.5", network_id: "ipn1", equipment_id: null, vm_id: null },   // libre → match net0
      { id: "a2", address: " 10.0.0.6", network_id: null, equipment_id: null, vm_id: null },     // adresse IPAM avec espace
      { id: "a3", address: "10.0.0.7", network_id: null, equipment_id: null, vm_id: null },       // match net1 (constatée en /24)
      { id: "a4", address: "10.0.0.99", network_id: null, equipment_id: null, vm_id: null },      // aucune vNIC ne la constate
    ];
    const sug = VmIpMatch.suggestions(vm, base);
    ck.eq(sug.map((s) => s.id).join(","), "a1,a2,a3", "suggestions : 3 adresses correspondantes (tri IP croissant)");
    ck.eq(sug.find((s) => s.id === "a1").nicName, "net0", "nicName : a1 rapprochée de net0");
    ck.eq(sug.find((s) => s.id === "a2").nicName, "net0", "nicName : a2 (IP constatée) rapprochée de net0 malgré espaces");
    ck.eq(sug.find((s) => s.id === "a3").nicName, "net1", "normalisation : IP constatée « 10.0.0.7/24 » matche l'adresse « 10.0.0.7 »");
    ck.eq(sug.find((s) => s.id === "a1").network_id, "ipn1", "network_id porté par la proposition (affichage réseau)");
    ck.eq(sug.find((s) => s.id === "a1").conflict, null, "conflict null pour une adresse libre");
    ck.eq(sug.some((s) => s.id === "a4"), false, "aucune proposition pour une adresse non constatée");

    // --- exclusion des adresses DÉJÀ rattachées à CETTE VM (elles figurent dans « adresses liées ») ---
    const withOwn = [
      { id: "a1", address: "10.0.0.5", equipment_id: null, vm_id: "vmA" },   // déjà liée à vmA → exclue
      { id: "a3", address: "10.0.0.7", equipment_id: null, vm_id: null },     // libre → proposée
    ];
    const sug2 = VmIpMatch.suggestions(vm, withOwn);
    ck.eq(sug2.map((s) => s.id).join(","), "a3", "exclusion : une adresse déjà rattachée à cette VM n'est pas proposée");

    // --- conflits signalés : equipment_id posé, ou vm_id d'une AUTRE VM ---
    const conflicting = [
      { id: "a1", address: "10.0.0.5", equipment_id: "e9", vm_id: null },     // prise par un équipement
      { id: "a3", address: "10.0.0.7", equipment_id: null, vm_id: "vmB" },     // prise par une autre VM
    ];
    const sug3 = VmIpMatch.suggestions(vm, conflicting);
    const c1 = sug3.find((s) => s.id === "a1"), c3 = sug3.find((s) => s.id === "a3");
    ck.eq(c1.conflict, "equipment", "conflict equipment pour une adresse rattachée à un équipement");
    ck.eq(c1.conflictId, "e9", "conflictId = equipment_id (résolution du nom côté UI)");
    ck.eq(c3.conflict, "other_vm", "conflict other_vm pour une adresse rattachée à une AUTRE VM");
    ck.eq(c3.conflictId, "vmB", "conflictId = vm_id de l'autre VM");

    // --- « première vNIC gagne » : une même adresse constatée par deux vNIC → une seule ligne (net0 d'abord) ---
    const vmDup = { id: "vmD", nics: [ { name: "net0", ips: ["10.0.0.5"] }, { name: "net1", ips: ["10.0.0.5"] } ] };
    const sugDup = VmIpMatch.suggestions(vmDup, [{ id: "a1", address: "10.0.0.5", equipment_id: null, vm_id: null }]);
    ck.eq(sugDup.length, 1, "pas de doublon si plusieurs vNIC constatent la même adresse");
    ck.eq(sugDup[0].nicName, "net0", "première vNIC (net0) gagne le rapprochement");

    // --- aucune proposition → tableau vide ; tolérance des entrées dégénérées ---
    ck.eq(VmIpMatch.suggestions(vm, [{ id: "z", address: "192.168.1.1", equipment_id: null, vm_id: null }]).length, 0, "aucune correspondance → []");
    ck.eq(VmIpMatch.suggestions(vm, []).length, 0, "liste d'adresses vide → []");
    ck.eq(VmIpMatch.suggestions(vm, null).length, 0, "ipAddresses null → [] (tolérant)");
    ck.eq(VmIpMatch.suggestions(null, base).length, 0, "vm null → [] (tolérant)");
    ck.eq(VmIpMatch.suggestions({ id: "x", nics: [] }, base).length, 0, "VM sans vNIC → [] (aucune IP constatée)");
  }
  });

  await section("VmClusterFormat : rapprochement nœud→équipement + formatage métriques (vue Clusters)", async () => {
  {
    // --- resolveHostEquipmentId : MIROIR EXACT du rapprochement d'hôte v3 du serveur (VmSyncService).
    //     Niveaux 2 (nom EXACT, INSENSIBLE à la casse) & 3 (1er label du FQDN du nom) : ips vide → le
    //     niveau 1 (hostnames d'IP) ne tranche pas et on descend aux niveaux « nom ». ---
    const eqs = [
      { id: "e1", name: "srv1" },
      { id: "e2", name: "srv2.int.exemple.com" },
      { id: "e3", name: "SRV3.int.exemple.com" },   // FQDN casse mixte côté équipement
      { id: "e4", name: "srv4.a.exemple.com" },
      { id: "e5", name: "srv4.b.exemple.com" },     // label FQDN « srv4 » AMBIGU (e4 + e5)
      { id: "e6", name: "dup" },
      { id: "e7", name: "dup" },                    // nom exact « dup » AMBIGU
      { id: "e8", name: "web" },
      { id: "e9", name: "web.exemple.com" },        // FQDN « web » — le nom EXACT « web » doit primer
      { id: "e10", name: "dup.zone.exemple.com" },  // label FQDN « dup » unique — NE doit PAS servir de repli (exact ambigu)
      { id: "e11" },                                 // name manquant → ignoré (tolérance de forme)
    ];
    const R = (node) => VmClusterFormat.resolveHostEquipmentId(eqs, [], node);
    ck.eq(R("srv1"), "e1", "resolve N2 : nom EXACT unique → e1");
    ck.eq(R("SRV1"), "e1", "resolve N2 : nom exact INSENSIBLE à la casse (alignement v3 — nœud majuscule) → e1");
    ck.eq(R("srv2"), "e2", "resolve N3 : repli 1er label de FQDN → e2");
    ck.eq(R("SRV2"), "e2", "resolve N3 : repli FQDN insensible à la casse (nœud majuscule) → e2");
    ck.eq(R("srv3"), "e3", "resolve N3 : label FQDN insensible à la casse côté équipement (SRV3) → e3");
    ck.eq(R("srv4"), null, "resolve N3 : label FQDN AMBIGU → null (rien deviné)");
    ck.eq(R("dup"), null, "resolve N2 : nom exact AMBIGU → null, SANS repli FQDN (même si dup.zone unique)");
    ck.eq(R("web"), "e8", "resolve N2 : nom EXACT prime sur le repli FQDN (web ≠ web.exemple.com)");
    ck.eq(R("inconnu"), null, "resolve : aucune correspondance → null");
    ck.eq(R(""), null, "resolve : nœud vide → null");
    ck.eq(R("  srv1  "), "e1", "resolve : nœud rogné (trim) → e1");
    ck.eq(VmClusterFormat.resolveHostEquipmentId(null, null, "srv1"), null, "resolve : équipements/IP null → null (tolérant)");

    // --- NIVEAU 1 (PRIORITAIRE) : hostnames des adresses IP RATTACHÉES — PARITÉ EXACTE avec le test
    //     serveur (VmSyncService rapprochement v3) : hostname COMPLET / 1er label / dédup multi-IP /
    //     ambiguïté sans descente / IP non rattachée ignorée. ---
    const eqs1 = [
      { id: "e1", name: "sans-rapport-1" },
      { id: "e2", name: "sans-rapport-2" },
      { id: "e3", name: "sans-rapport-3" },
      { id: "e4a", name: "sans-rapport-4a" },
      { id: "e4b", name: "sans-rapport-4b" },
      { id: "e4name", name: "srv42" },   // nom EXACT « srv42 » — l'AMBIGUÏTÉ du niveau 1 ne doit PAS y descendre
      { id: "e5name", name: "srv40" },   // nom EXACT « srv40 » — le niveau 1 UNIQUE doit primer (pas de descente)
    ];
    const ips1 = [
      { equipment_id: "e1", hostname: "srvfull.int.exemple.com" },   // N1 hostname COMPLET
      { equipment_id: "e2", hostname: "srv40.int.exemple.com" },     // N1 1er label
      { equipment_id: "e3", hostname: "srv41.int.exemple.com" },     // N1 deux IP du MÊME équipement (dédup)
      { equipment_id: "e3", hostname: "srv41.dmz.exemple.com" },
      { equipment_id: "e4a", hostname: "srv42.a.exemple.com" },      // N1 AMBIGU (e4a/e4b)
      { equipment_id: "e4b", hostname: "srv42.b.exemple.com" },
      { equipment_id: null, hostname: "srv40.autre.com" },           // IP NON rattachée → ignorée au N1
    ];
    const R1 = (node) => VmClusterFormat.resolveHostEquipmentId(eqs1, ips1, node);
    ck.eq(R1("srvfull.int.exemple.com"), "e1", "resolve N1 : hostname d'IP COMPLET → équipement rattaché");
    ck.eq(R1("srvfull"), "e1", "resolve N1 : 1er label du hostname d'IP → même équipement");
    ck.eq(R1("srv40"), "e2", "resolve N1 : 1er label unique prime sur le nom exact « srv40 » (pas de descente)");
    ck.eq(R1("SRV40"), "e2", "resolve N1 : insensible à la casse du nœud → e2");
    ck.eq(R1("srv41"), "e3", "resolve N1 : deux IP du MÊME équipement = 1 candidat (dédup par équipement)");
    ck.eq(R1("srv42"), null, "resolve N1 AMBIGU (e4a/e4b) → null, SANS descendre au nom exact « srv42 »");

    // --- uptime : j / h / min lisibles ; grain grossier ---
    ck.eq(VmClusterFormat.uptime(null), "—", "uptime : null → —");
    ck.eq(VmClusterFormat.uptime(-5), "—", "uptime : négatif → —");
    ck.eq(VmClusterFormat.uptime(0), "< 1 min", "uptime : 0 → < 1 min");
    ck.eq(VmClusterFormat.uptime(30), "< 1 min", "uptime : 30 s → < 1 min");
    ck.eq(VmClusterFormat.uptime(90), "1 min", "uptime : 90 s → 1 min");
    ck.eq(VmClusterFormat.uptime(3700), "1 h 1 min", "uptime : 3700 s → 1 h 1 min");
    ck.eq(VmClusterFormat.uptime(90000), "1 j 1 h", "uptime : 90000 s → 1 j 1 h");

    // --- cpuText : « X % / N vCPU » depuis une fraction 0..1 ---
    ck.eq(VmClusterFormat.cpuText(0.5, 4), "50 % / 4 vCPU", "cpuText : fraction + total");
    ck.eq(VmClusterFormat.cpuText(0.1234, 8), "12 % / 8 vCPU", "cpuText : pourcentage arrondi à l'entier");
    ck.eq(VmClusterFormat.cpuText(0.25, null), "25 %", "cpuText : total absent → pourcentage seul");
    ck.eq(VmClusterFormat.cpuText(null, 8), "8 vCPU", "cpuText : fraction absente → total seul");
    ck.eq(VmClusterFormat.cpuText(null, null), "—", "cpuText : tout absent → —");

    // --- memGo : « x,x / y,y Go » depuis des Mo (séparateur français) ---
    ck.eq(VmClusterFormat.memGo(8192, 16384), "8,0 / 16,0 Go", "memGo : utilisé + total (virgule française)");
    ck.eq(VmClusterFormat.memGo(1536, 2048), "1,5 / 2,0 Go", "memGo : décimale (1,5 Go)");
    ck.eq(VmClusterFormat.memGo(4096, null), "4,0 Go", "memGo : total absent → utilisé seul");
    ck.eq(VmClusterFormat.memGo(null, 16384), "? / 16,0 Go", "memGo : utilisé absent mais total présent");
    ck.eq(VmClusterFormat.memGo(null, null), "—", "memGo : tout absent → —");
  }
  });

  await section("NotifyFormat : conversion heures↔secondes, libellé d'intervalle, résolution de contact (page admin Notifications)", async () => {
  {
    // --- conversion HEURES (UI) ↔ SECONDES (serveur), aller-retour fidèle ---
    ck.eq(NotifyFormat.hoursToSec(12), 43200, "hoursToSec : 12 h → 43200 s");
    ck.eq(NotifyFormat.hoursToSec(0.5), 1800, "hoursToSec : 0,5 h → 1800 s");
    ck.eq(NotifyFormat.hoursToSec(NaN), 0, "hoursToSec : non-fini → 0 (tolérant)");
    ck.eq(NotifyFormat.secToHours(43200), 12, "secToHours : 43200 s → 12 h");
    ck.eq(NotifyFormat.secToHours(1800), 0.5, "secToHours : 1800 s → 0,5 h");
    ck.eq(NotifyFormat.hoursToSec(NotifyFormat.secToHours(43200)), 43200, "aller-retour : 43200 s conservés");
    ck.eq(DEFAULT_REMIND_HOURS, 12, "DEFAULT_REMIND_HOURS = 12 (miroir du défaut serveur)");

    // --- borne serveur (≥ 60 s) : garde-fou d'UI avant l'envoi ---
    ck.eq(NotifyFormat.isValidRemindSec(60), true, "isValidRemindSec : 60 s → valide (borne basse)");
    ck.eq(NotifyFormat.isValidRemindSec(59), false, "isValidRemindSec : 59 s → invalide");
    ck.eq(NotifyFormat.isValidRemindSec(NaN), false, "isValidRemindSec : non-fini → invalide");
    ck.eq(NotifyFormat.isValidRemindSec(NotifyFormat.hoursToSec(0.01)), false, "isValidRemindSec : 0,01 h (36 s) → invalide");

    // --- libellé d'intervalle lisible (français) ---
    ck.eq(NotifyFormat.intervalLabel(43200), "12 h", "intervalLabel : 43200 s → « 12 h »");
    ck.eq(NotifyFormat.intervalLabel(5400), "1 h 30", "intervalLabel : 5400 s → « 1 h 30 »");
    ck.eq(NotifyFormat.intervalLabel(1800), "30 min", "intervalLabel : 1800 s → « 30 min »");
    ck.eq(NotifyFormat.intervalLabel(90), "2 min", "intervalLabel : 90 s → « 2 min » (arrondi)");
    ck.eq(NotifyFormat.intervalLabel(0), "—", "intervalLabel : 0 → « — »");
    ck.eq(NotifyFormat.intervalLabel(NaN), "—", "intervalLabel : non-fini → « — »");

    // --- résolution SOUPLE du libellé de contact (garde-fou « contact introuvable ») ---
    const contacts = [{ id: "c1", name: "Alice" }, { id: "c2", name: "" }, { id: "c3" }];
    ck.eq(NotifyFormat.contactLabel(contacts, "c1"), "Alice", "contactLabel : id connu → nom");
    ck.eq(NotifyFormat.contactLabel(contacts, "c2"), "(sans nom)", "contactLabel : nom vide → « (sans nom) »");
    ck.eq(NotifyFormat.contactLabel(contacts, "c3"), "(sans nom)", "contactLabel : nom absent → « (sans nom) »");
    ck.eq(NotifyFormat.contactLabel(contacts, "zzz"), "(contact introuvable)", "contactLabel : id inconnu → « (contact introuvable) »");
    ck.eq(NotifyFormat.contactLabel(contacts, ""), "(aucun)", "contactLabel : id vide → « (aucun) »");
    ck.eq(NotifyFormat.contactLabel(contacts, null), "(aucun)", "contactLabel : id null → « (aucun) »");
    ck.eq(NotifyFormat.contactLabel(null, "c1"), "(contact introuvable)", "contactLabel : collection null → « (contact introuvable) » (tolérant)");
  }
  });

  await section("Markdown : rendu (micromark, défauts sûrs)", async () => {
  {
    // --- rendu des primitives markdown attendues (gras, liste, titre) ---
    ck(Markdown.render("**gras**").includes("<strong>gras</strong>"), "render : ** ** → <strong>");
    const list = Markdown.render("- a\n- b");
    ck(list.includes("<ul>") && list.includes("<li>a</li>") && list.includes("<li>b</li>"), "render : liste → <ul>/<li>");
    ck(Markdown.render("# Titre").includes("<h1>Titre</h1>"), "render : # Titre → <h1>");

    // --- SÉCURITÉ : HTML inline NEUTRALISÉ (allowDangerousHtml désactivé par défaut) ---
    const scriptOut = Markdown.render("Avant <script>alert(1)</script> après");
    ck(!scriptOut.includes("<script>"), "render : <script> jamais rendu comme balise active");
    ck(scriptOut.includes("&lt;script&gt;"), "render : <script> échappé en entités (&lt;script&gt;)");

    // --- SÉCURITÉ : protocole d'URL dangereux filtré (allowDangerousProtocol désactivé par défaut) ---
    const jsLink = Markdown.render("[clic](javascript:alert(1))");
    ck(!jsLink.includes("javascript:"), "render : lien javascript: non transformé en lien actif (href vidé)");
    // un protocole légitime reste, lui, intact (on n'a pas cassé les liens normaux) :
    ck(Markdown.render("[x](https://exemple.com)").includes('href="https://exemple.com"'), "render : URL http(s) légitime préservée");

    // --- entrée vide / absente → "" (pas de <p></p> parasite) ---
    ck.eq(Markdown.render(""), "", "render : chaîne vide → \"\"");
    ck.eq(Markdown.render(null), "", "render : null → \"\"");
    ck.eq(Markdown.render(undefined), "", "render : undefined → \"\"");
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

  await section("Store : carnet de CONTACTS (CRUD + validation tolérante + hydratation)", async () => {
  {
    const s = await makeStore();
    ck.eq(s.all("contacts").length, 0, "contacts : collection vide sur un nouveau document (aucun semis)");
    // création : nom requis honoré par le Store (mode fichier = seul garde-fou), e-mail/téléphone facultatifs.
    const c = await s.create("contacts", { name: "Astreinte réseau", email: "ops@exemple.test", phone: "+32 2 555 01 23", notes: "24/7" });
    ck(!!c && !!c.id, "contacts : contact créé");
    const back = s.get("contacts", c.id);
    ck.eq(back.name, "Astreinte réseau", "contacts : nom persisté");
    ck.eq(back.email, "ops@exemple.test", "contacts : e-mail persisté");
    ck.eq(back.phone, "+32 2 555 01 23", "contacts : téléphone persisté");
    ck.eq(back.notes, "24/7", "contacts : notes persistées");
    // édition : mise à jour partielle
    await s.update("contacts", c.id, { phone: "" });
    ck.eq(s.get("contacts", c.id).phone, "", "contacts : téléphone effaçable (facultatif)");
    // (dé)sérialisation : le contact figure dans le snapshot (collection câblée dans le registre), et se ré-hydrate
    // en instance Contact — c'est ce chemin qu'emprunte le rechargement d'un document (Store._hydrate → registre).
    const snap = s.toJSON();
    ck.eq((snap.contacts || []).length, 1, "contacts : présent dans le snapshot (collection câblée)");
    const hydrated = EntityRegistry.hydrate("contacts", snap.contacts[0]);
    ck.eq(hydrated.constructor.name, "Contact", "contacts : ré-hydraté en instance Contact");
    ck.eq(hydrated.name, "Astreinte réseau", "contacts : hydratation préserve le nom");
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
