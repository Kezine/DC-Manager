/* Tests modules — entités, Store (CRUD, cascade, undo, routes, spares, sites…), helpers core.
   Sections extraites de run.js (audit P5) ; harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, mkStorage, Store, BrowserStorageAdapter, PlacementContainers, FieldIndex, Equipment, Cable, Port, Normalize, Labeler, ClickGuard, Projection, Box, Painter, RackGeometry, GraphGeometry, EquipmentTypes, PortRoles, Depths, EquipFaces, RackScene, Resolver3D, U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE, Html, Color, Format, GridGeometry, GraphView, Sort, FieldFacet, Ip, Markdown, VmNetMapping, VmIpMatch, VmClusterFormat, VmStatus, VmHostTip, VmLocate, Locatable, ContainerLabel, WebglHostVisibility, OptionSearch, GlobalSearch, GlobalSearchSources, DetailForms, NotifyFormat, DEFAULT_REMIND_HOURS, Prefs, DatacenterView, FloorLayout, Positioning, DoorGeometry, Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM, DoorTool, Measure, CableSpline, MeasureTool, RouteTool, ImageStore, FaceImage, SaveState, EntityRegistry, ReloadPlanner, COLLECTION_THREE_IMPACT, RenderImpact, Changeset, SharedSchema, Text, PAGE_SIZE_DEFAULT, Validation, Cascade, PowerAnalysis, Rack, CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS, makeStore } = require("./harness.js");

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

  await section("PatchDiff : égalité profonde + champs techniques ignorés (module pur)", async () => {
  {
    const { PatchDiff } = D("core/PatchDiff.js");
    // -- same : égalité PROFONDE --
    ck(PatchDiff.same(["a"], ["a"]), "same : tableaux identiques → égaux");
    ck(!PatchDiff.same(["a", "b"], ["b", "a"]), "same : tableaux ORDONNÉS — ordre différent → différents");
    ck(!PatchDiff.same(["a"], ["a", "b"]), "same : longueurs différentes → différents");
    ck(PatchDiff.same({ a: { b: [1, 2] } }, { a: { b: [1, 2] } }), "same : objets imbriqués égaux (récursif)");
    ck(!PatchDiff.same({ a: 1 }, { a: 1, b: 2 }), "same : clé en plus → différents");
    ck(!PatchDiff.same(null, "x"), "same : null vs valeur → différents");
    ck(!PatchDiff.same(null, undefined), "same : null vs undefined → DIFFÉRENTS (repli sûr : on écrit)");
    ck(PatchDiff.same(null, null), "same : null vs null → égaux");
    // -- changes : les champs techniques n'emportent JAMAIS la décision --
    ck(!PatchDiff.changes({ name: "x", updated_date: "2026-01-01" }, { name: "x", updated_date: "2026-02-02", created_by: "u1" }),
      "changes : updated_date/created_by ignorés → patch sans effet");
    ck(PatchDiff.changes({ name: "x" }, { name: "y" }), "changes : valeur modifiée → changeant");
    ck(PatchDiff.changes({ name: "x" }, { name: "x", extra: 1 }), "changes : champ INCONNU du current → changeant (repli sûr)");
    ck(!PatchDiff.changes({ name: "x", tags: ["a", "b"] }, { tags: ["a", "b"] }), "changes : tableau identique → sans effet");
  }
  });

  await section("Store.update : court-circuit no-op (patch identique → AUCUNE écriture)", async () => {
  {
    /* Un save de formulaire SANS modification ré-émet tous les champs à l'identique : sans le
       court-circuit, chaque « Enregistrer » émettait un PUT (+ SSE en mode API) par enregistrement
       intact, et touch() polluait updated_date. On espionne l'adaptateur pour PROUVER l'absence d'écriture. */
    const s = await makeStore();
    const g = await s.create("groups", { label: "G" });
    const eq = await s.create("equipments", { name: "sw", type: "switch", group_id: g.id, group_ids: [g.id] });
    const dateBefore = s.get("equipments", eq.id).updated_date;
    const orig = s.adapter.updateOne.bind(s.adapter);
    let writes = 0;
    s.adapter.updateOne = (...a) => { writes++; return orig(...a); };
    // patch STRICTEMENT identique aux valeurs stockées (y compris un champ TABLEAU) → aucune écriture
    const unchanged = await s.update("equipments", eq.id, { name: "sw", type: "switch", group_ids: [g.id] });
    ck(!!unchanged, "no-op : retour truthy (succès pour les appelants, qui testent la nullité)");
    ck.eq(writes, 0, "no-op : AUCUNE écriture adaptateur (ni PUT ni SSE)");
    ck.eq(s.get("equipments", eq.id).updated_date, dateBefore, "no-op : updated_date INCHANGÉ (pas de touch)");
    // vrai changement → l'écriture repart
    const changed = await s.update("equipments", eq.id, { name: "sw-2" });
    ck(!!changed && changed.name === "sw-2", "changement réel : patch appliqué");
    ck.eq(writes, 1, "changement réel : 1 écriture adaptateur");
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
  {
    /* CASCADE RÉCURSIVE de bout en bout, à travers l'EXÉCUTEUR du mode fichier (Store.remove) :
       un breakout IMBRIQUÉ (trunk → lane → sous-lane) doit partir en ENTIER. Avant la récursion, la
       règle portée par `ports` n'était rejouée sur aucune lane supprimée : la sous-lane survivait,
       orpheline, avec son câble (docs/placement.md §6.16). */
    const s = await makeStore();
    const eq = await s.create("equipments", { name: "sw-breakout" });
    const peer = await s.create("equipments", { name: "peer" });
    const farA = await s.create("ports", { equipment_id: peer.id, name: "far-a" });
    const farB = await s.create("ports", { equipment_id: peer.id, name: "far-b" });   // un port ne porte qu'UN câble
    const trunk = await s.create("ports", { equipment_id: eq.id, name: "Trunk" });
    const lane = await s.create("ports", { equipment_id: eq.id, name: "Trunk/1", parent_port_id: trunk.id, lane: 1 });
    const sub = await s.create("ports", { equipment_id: eq.id, name: "Trunk/1/1", parent_port_id: lane.id, lane: 1 });
    const cLane = await s.create("cables", { from_port_id: lane.id, to_port_id: farA.id });
    const cSub = await s.create("cables", { from_port_id: sub.id, to_port_id: farB.id });
    await s.remove("ports", trunk.id);
    ck.eq(s.get("ports", trunk.id), null, "breakout : trunk supprimé");
    ck.eq(s.get("ports", lane.id), null, "breakout : lane supprimée (1er niveau)");
    ck.eq(s.get("ports", sub.id), null, "breakout IMBRIQUÉ : sous-lane supprimée (récursion)");
    ck.eq(s.get("cables", cLane.id), null, "breakout : câble de la lane supprimé");
    ck.eq(s.get("cables", cSub.id), null, "breakout IMBRIQUÉ : câble de la sous-lane supprimé (récursion)");
    ck(!!s.get("ports", farA.id), "breakout : le port distant SURVIT (rien au-delà de la chaîne)");
    ck(!!s.get("equipments", peer.id), "breakout : l'équipement distant SURVIT (le rayon d'action reste borné)");
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
    // SOUS-ÉQUIPEMENTS : mêmes champs de groupe, donc MÊME règle d'appartenance. `equipmentGroupIds` DÉLÈGUE
    // désormais à `groupIdsOf` (source unique) — sans cette délégation, la règle aurait été recopiée une 2ᵉ fois.
    const seMaster = await s.create("equipments", { name: "Librairie" });
    const se1 = await s.create("subEquipments", { name: "Drive 2", equipment_id: seMaster.id, group_id: grp.id, group_ids: [grp.id, g2.id] });
    const se2 = await s.create("subEquipments", { name: "Drive 1", equipment_id: seMaster.id });
    ck.eq(JSON.stringify(s.groupIdsOf(se1)), JSON.stringify([grp.id, g2.id]), "groupIdsOf : marche sur un SOUS-ÉQUIPEMENT (règle non liée à la collection)");
    ck.eq(JSON.stringify(s.groupIdsOf(multiEq)), JSON.stringify(s.equipmentGroupIds(multiEq)), "groupIdsOf ≡ equipmentGroupIds (la délégation ne change rien)");
    ck.eq(s.subEquipmentsOfGroup(grp.id).some((x) => x.id === se1.id), true, "subEquipmentsOfGroup : trouve par groupe PRIMAIRE");
    ck.eq(s.subEquipmentsOfGroup(g2.id).some((x) => x.id === se1.id), true, "subEquipmentsOfGroup : trouve par groupe SECONDAIRE");
    ck.eq(s.subEquipmentsOfGroup(g2.id).some((x) => x.id === se2.id), false, "subEquipmentsOfGroup : ignore un sous-équipement SANS groupe");
    // Tri par NOM : c'est la seule identité d'un sous-équipement (ni type, ni position) — donc le seul ordre stable.
    ck.eq(JSON.stringify(s.subEquipmentsOf(seMaster.id).map((x) => x.name)), JSON.stringify(["Drive 1", "Drive 2"]), "subEquipmentsOf : triés par NOM, pas par ordre de création");
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

  await section("Store : pose sur étagère refusée par le VRAI chemin d'écriture (géométrie partagée importée)", async () => {
  {
    // La géométrie d'étagère est IMPORTÉE directement par la validation partagée (`src-shared/DataValidation`
    // importe `src-shared/TrayGeometry` — cf. docs/placement.md §6.7). On le prouve ICI par le VRAI chemin
    // d'écriture du Store, pas par un `validateRecord` appelé à la main : c'est le comportement de bout en
    // bout qui compte.
    const s = await makeStore();
    const dc = await s.create("datacenters", { name: "DC" });
    const rack = await s.create("racks", { name: "RK", datacenter_id: dc.id, dc_x: 500, dc_y: 500, depth: 1000, cage_depth_mm: 900, sides: "dual" });
    const tray = await s.create("rackItems", { rack_id: rack.id, kind: "tray", tray_type: "cantilever", u: 10, u_height: 3, tray_u: 1, depth_mm: 400 });
    const pose = (props) => s.create("equipments", { dim_mode: "free", placement_mode: "tray", tray_item_id: tray.id, ...props });
    // plateau porte-à-faux : 444,6 × 400 mm utilisables, 128,35 mm de hauteur libre (3 U − 5 mm de tôle)
    const ok = await pose({ name: "tient", tray_x: 0, tray_y: 0, free_w_mm: 200, free_l_mm: 300, free_h_mm: 80 });
    ck(!!ok, "équipement conforme → CRÉÉ (la géométrie importée ne bloque pas ce qui tient)");
    ck.eq(await pose({ name: "trop large", tray_x: 0, tray_y: 0, free_w_mm: 600, free_l_mm: 100, free_h_mm: 80 }), null, "empreinte 600 > plateau 444,6 → REFUSÉE à l'écriture");
    ck.eq(await pose({ name: "trop haut", tray_x: 0, tray_y: 0, free_w_mm: 100, free_l_mm: 100, free_h_mm: 150 }), null, "hauteur 150 > 128,35 mm libres → REFUSÉE");
    ck.eq(await pose({ name: "hors plateau", tray_x: 400, tray_y: 0, free_w_mm: 200, free_l_mm: 100, free_h_mm: 80 }), null, "position x = 400 + 200 de large → REFUSÉE (débord)");
    ck.eq(await pose({ name: "chevauche", tray_x: 10, tray_y: 10, free_w_mm: 100, free_l_mm: 100, free_h_mm: 40 }), null, "chevauche l'équipement déjà posé → REFUSÉE (V6e)");
    ck.eq(s.equipmentsOnTray(tray.id).length, 1, "aucun refus n'a laissé de trace dans le cache local");
    // ROTATION : la même empreinte, pivotée, cesse de tenir en largeur — le VERDICT suit ce qui est DESSINÉ.
    ck(!!(await pose({ name: "profond droit", tray_x: 250, tray_y: 0, free_w_mm: 150, free_l_mm: 350, free_h_mm: 40 })), "150 × 350 à x = 250 → tient");
    ck.eq(await pose({ name: "profond pivoté", tray_x: 250, tray_y: 0, free_w_mm: 150, free_l_mm: 350, free_h_mm: 40, dc_orientation: 90 }), null, "…la MÊME pivotée à 90° (350 de large) → REFUSÉE");
  }
  });

  await section("PlacementContainers : chaîne d'attache — PARITÉ STRICTE avec la règle « salle » historique", async () => {
  {
    const { PlacementContainers } = SHARED("src-shared/PlacementContainers.js");
    const s = await makeStore();
    const fetch = (coll, id) => s.get(coll, id);

    const dc = await s.create("datacenters", { name: "Salle A", location: "liege", floor: "0" });
    const rack = await s.create("racks", { name: "R1", width_mm: 600, depth: 1000, u_count: 42, datacenter_id: dc.id, dc_x: 500, dc_y: 500 });
    const rackPool = await s.create("racks", { name: "R-pool", width_mm: 600, depth: 1000, u_count: 42, location: "liege" });   // baie HORS salle
    const tray = await s.create("rackItems", { rack_id: rack.id, kind: "tray", side: "front", u: 10, u_height: 2 });

    /* Un cas par MODE de placement, bords compris — c'est le jeu qui fait foi pour la migration.
       `attendu` = la salle EXPLICITEMENT attendue, figée à la main d'après la règle HISTORIQUE
       (`Store.equipmentDcId`, retiré au lot 7 / doctrine §6.33 : il projetait la chaîne sur son maillon
       « salle »). On n'a JAMAIS écrit « === s.equipmentDcId(e) » — la comparaison aurait été
       tautologique dès la délégation de cette méthode à la chaîne, et elle serait aujourd'hui
       impossible. C'est bien ce jeu de constantes qui porte la parité, et il survit donc au retrait. */
    const cases = [];
    const add = async (label, attendu, payload) => { cases.push({ label, attendu, e: await s.create("equipments", Object.assign({ name: label }, payload)) }); };
    await add("racké à un U", () => dc.id, { placement_mode: "rack", rack_id: rack.id, rack_u: 5 });
    await add("pool de baie (rack_id SANS rack_u)", () => null, { placement_mode: "rack", rack_id: rack.id });
    await add("marge latérale", () => dc.id, { placement_mode: "side", rack_id: rack.id });
    await add("paroi", () => dc.id, { placement_mode: "wall", rack_id: rack.id });
    await add("posé sur étagère", () => dc.id, { placement_mode: "tray", dim_mode: "free", tray_item_id: tray.id, tray_x: 10, tray_y: 10, free_w_mm: 100, free_l_mm: 100, free_h_mm: 40 });
    await add("libre EN salle", () => dc.id, { placement_mode: "manual", dim_mode: "free", dc_id: dc.id, dc_x: 100, dc_y: 100 });
    await add("libre NON placé", () => null, { placement_mode: "manual", dim_mode: "free" });
    await add("posé sur un ÉTAGE", () => null, { placement_mode: "floor", location: "liege", floor: "1", floor_x: 200, floor_y: 300 });
    await add("racké dans une baie HORS salle", () => null, { placement_mode: "rack", rack_id: rackPool.id, rack_u: 3 });

    /* La RÈGLE HISTORIQUE, transcrite ICI et nulle part ailleurs (le dépôt ne la porte plus, §6.33) :
       la chaîne d'attache PROJETÉE sur son maillon « salle ». Elle sert d'oracle de parité. */
    const salleDeLaChaine = (eq) => { const r = PlacementContainers.chain(eq, fetch).find((c) => c.kind === "room"); return r ? r.id : null; };
    /* La chaîne rend la salle ATTENDUE, mode par mode — et le point d'entrée VIVANT de l'application
       (`equipmentNamedContainer`, RESTREINT à « salle » comme le font les trois chemins salle de
       « Localiser ») rend exactement la même. C'est ce couple qui remplace l'ancienne comparaison entre
       deux implémentations : une constante écrite à la main d'un côté, l'API réelle de l'autre. */
    cases.forEach(({ label, attendu, e }) => {
      ck.eq(salleDeLaChaine(e), attendu(), "salle attendue — " + label);
      const k = s.equipmentNamedContainer(e);
      ck.eq(k && k.kind === "room" ? k.id : null, attendu(), "Store.equipmentNamedContainer restreint à la salle — " + label);
    });

    // STRUCTURE de la chaîne : une étagère remonte étagère → baie → salle → étage → bâtiment.
    const byLabel = (l) => cases.find((c) => c.label === l).e;
    const kinds = (e) => JSON.stringify(PlacementContainers.chain(e, fetch).map((c) => c.kind));
    ck.eq(kinds(byLabel("posé sur étagère")), JSON.stringify(["tray", "rack", "room", "floor", "building"]), "chaîne complète depuis une étagère");
    // Une baie HORS salle n'est pas « nulle part » : elle est rattachée au BÂTIMENT — sans faire apparaître
    // de salle, ce qui préserve la parité (cf. doctrine §6.3, disparition de l'état « non placé »).
    ck.eq(kinds(byLabel("racké dans une baie HORS salle")), JSON.stringify(["rack", "building"]), "baie hors salle → bâtiment, aucune salle");
    ck.eq(kinds(byLabel("posé sur un ÉTAGE")), JSON.stringify(["floor", "building"]), "étage → bâtiment, aucune salle");
    ck.eq(kinds(byLabel("pool de baie (rack_id SANS rack_u)")), JSON.stringify([]), "pool de baie : aucun conteneur localisable");

    // L'ÉTAGE est identifié par le COUPLE (bâtiment, étage), jamais par un id : un étage non configuré n'a
    // pas d'enregistrement `floors`.
    const fc = PlacementContainers.of(byLabel("posé sur un ÉTAGE"));
    ck(fc && fc.kind === "floor" && fc.location === "liege" && fc.floor === "1", "étage = conteneur (bâtiment, étage)");
    // Étage « 0 » (rez-de-chaussée) PRÉSERVÉ — la convention `String(x || "")` l'écraserait en chaîne vide.
    const ground = PlacementContainers.of({ placement_mode: "floor", location: "liege", floor: 0 });
    ck(ground && ground.floor === "0", "étage 0 préservé (et non écrasé en chaîne vide)");

    // Égalité STRUCTURELLE (pas d'id composite à comparer).
    ck(PlacementContainers.same(fc, { kind: "floor", location: "liege", floor: "1" }), "same() : mêmes bâtiment+étage");
    ck(!PlacementContainers.same(fc, { kind: "floor", location: "liege", floor: "2" }), "same() : étages différents");
    ck(!PlacementContainers.same(fc, { kind: "room", id: "liege" }), "same() : natures différentes");

    // Chaîne BORNÉE (garde défensive contre une donnée cyclique — la hiérarchie saine décroît toujours).
    cases.forEach(({ label, e }) => ck(PlacementContainers.chain(e, fetch).length <= PlacementContainers.MAX_DEPTH, "chaîne bornée — " + label));
    // Référence PENDANTE : une étagère dont la baie a disparu ne doit rien inventer.
    ck.eq(salleDeLaChaine({ placement_mode: "tray", tray_item_id: "inexistant" }), null, "étagère fantôme → aucune salle");

    /* ================= LA CLÉ GÉNÉRALISÉE — `Store.equipmentContainer` & co (lot 1 du câblage d'étage)
       Le trio `*Container` rend le conteneur IMMÉDIAT, là où le trio `*DcId` PROJETTE la chaîne sur son
       maillon « salle » et jette le reste. Les attentes ci-dessous sont EXPLICITES (le conteneur voulu,
       écrit à la main) et non « === PlacementContainers.of(e) », qui serait tautologique — `Store` y
       délègue. ================= */
    const conteneurAttendu = {
      "racké à un U": { kind: "rack", id: rack.id },
      "pool de baie (rack_id SANS rack_u)": null,
      "marge latérale": { kind: "rack", id: rack.id },
      "paroi": { kind: "rack", id: rack.id },
      "posé sur étagère": { kind: "tray", id: tray.id },
      "libre EN salle": { kind: "room", id: dc.id },
      "libre NON placé": null,
      "posé sur un ÉTAGE": { kind: "floor", location: "liege", floor: "1" },
      "racké dans une baie HORS salle": { kind: "rack", id: rackPool.id },
    };
    cases.forEach(({ label, e }) => {
      ck.eq(JSON.stringify(s.equipmentContainer(e)), JSON.stringify(conteneurAttendu[label]), "conteneur immédiat attendu — " + label);
    });

    /* CE QUE LA GÉNÉRALISATION CHANGE, et c'est TOUT le sujet du chantier : deux placements ont un
       conteneur parfaitement valide alors que la clé « salle » les déclare introuvables. C'est la
       raison unique pour laquelle un équipement d'étage n'est pas câblable (doctrine §6.4). */
    const gagnes = cases.filter(({ attendu, e }) => attendu() === null && s.equipmentContainer(e) !== null).map((c) => c.label);
    ck.eq(JSON.stringify(gagnes.sort()), JSON.stringify(["posé sur un ÉTAGE", "racké dans une baie HORS salle"]),
      "EXACTEMENT deux placements deviennent localisables : l'étage et la baie hors salle");
    // …et RIEN ne se perd dans l'autre sens : tout ce qui avait une salle garde un conteneur.
    const perdus = cases.filter(({ attendu, e }) => attendu() !== null && s.equipmentContainer(e) === null);
    ck.eq(perdus.length, 0, "aucun placement localisable aujourd'hui ne devient introuvable");

    // PORT et CÂBLE : mêmes règles, même priorité A-puis-B que l'historique `cableDcId` (le cadrage d'un
    // câble à deux bouts placés ne devait pas se déplacer en généralisant les appelants — il ne l'a pas fait).
    const eqEtage = byLabel("posé sur un ÉTAGE"), eqSalle = byLabel("libre EN salle");
    const pEtage = await s.create("ports", { equipment_id: eqEtage.id, name: "p-etage" });
    const pSalle = await s.create("ports", { equipment_id: eqSalle.id, name: "p-salle" });
    ck.eq(JSON.stringify(s.portContainer(pEtage.id)), JSON.stringify({ kind: "floor", location: "liege", floor: "1" }), "portContainer : port d'un équipement d'ÉTAGE (là où l'historique portDcId rendait null)");
    ck.eq(salleDeLaChaine(eqEtage), null, "…alors que sa chaîne ne traverse AUCUNE salle : c'est tout ce que voyait l'ancienne clé, et c'était le blocage");
    ck.eq(JSON.stringify(s.portContainer(pSalle.id)), JSON.stringify({ kind: "room", id: dc.id }), "portContainer : port d'un équipement de salle");
    ck.eq(s.portContainer("inexistant"), null, "portContainer : port inconnu → null (tolérant)");

    const cab = await s.create("cables", { name: "c1", from_port_id: pEtage.id, to_port_id: pSalle.id });
    ck.eq(JSON.stringify(s.cableContainer(cab)), JSON.stringify({ kind: "floor", location: "liege", floor: "1" }), "cableContainer : PREMIÈRE extrémité localisable (A), comme le faisait cableDcId");
    // ⚠ Deux ports NEUFS : la règle de portée V6b n'autorise qu'UN câble par port — réutiliser les
    // précédents ferait REFUSER la création, et `create` rend alors `null` en silence (cf. `FormSave`).
    const pEtage2 = await s.create("ports", { equipment_id: eqEtage.id, name: "p-etage-2" });
    const pSalle2 = await s.create("ports", { equipment_id: eqSalle.id, name: "p-salle-2" });
    const cabInverse = await s.create("cables", { name: "c2", from_port_id: pSalle2.id, to_port_id: pEtage2.id });
    ck.eq(JSON.stringify(s.cableContainer(cabInverse)), JSON.stringify({ kind: "room", id: dc.id }), "cableContainer : priorité A-puis-B RESPECTÉE (l'ordre des bouts décide)");
    ck.eq(s.cableContainer({ from_port_id: null, to_port_id: null }), null, "cableContainer : aucun bout placé → null");
    ck.eq(s.cableContainer("inexistant"), null, "cableContainer : câble inconnu → null (tolérant)");
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
    // matrice ÉNERGIE par type (modale caméléon) : PoE, source PoE, capacité (A), consommation
    ck(EquipmentTypes.canPoe("switch") && EquipmentTypes.canPoe("camera") && EquipmentTypes.canPoe("server"), "canPoe : switch/camera/server → vrai");
    ck(!EquipmentTypes.canPoe("pdu") && !EquipmentTypes.canPoe("switchboard") && !EquipmentTypes.canPoe("ups") && !EquipmentTypes.canPoe("patch_panel"), "canPoe : pdu/switchboard/ups/patch → faux (infra énergie)");
    ck(EquipmentTypes.canPoe("__inconnu__"), "canPoe : id inconnu → other (vrai)");
    ck(EquipmentTypes.isPoeSource("switch"), "isPoeSource : switch → vrai");
    ck(!EquipmentTypes.isPoeSource("camera") && !EquipmentTypes.isPoeSource("server") && !EquipmentTypes.isPoeSource("__inconnu__"), "isPoeSource : non-switch → faux");
    ck(EquipmentTypes.hasPowerCapacity("pdu") && EquipmentTypes.hasPowerCapacity("switchboard"), "hasPowerCapacity : pdu/switchboard → vrai");
    ck(!EquipmentTypes.hasPowerCapacity("switch") && !EquipmentTypes.hasPowerCapacity("ups"), "hasPowerCapacity : switch/ups → faux");
    ck(!EquipmentTypes.consumes("switchboard"), "consumes : switchboard → faux (il fournit)");
    ck(EquipmentTypes.consumes("switch") && EquipmentTypes.consumes("pdu") && EquipmentTypes.consumes("__inconnu__"), "consumes : switch/pdu/other → vrai");
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
    // route inter-conteneurs exitA → pin d'étage → exitB → valide, conteneurs de départ/arrivée
    r = s.cableRoute({ from_port_id: pA1, to_port_id: pB1, waypoint_ids: [exitA.id, oob.id, exitB.id] });
    ck(r.valid && r.hasExits, "exit A → pin d'étage → exit B → valide, hasExits");
    ck.eq(JSON.stringify(r.startContainer), JSON.stringify({ kind: "room", id: dcA.id }), "route : conteneur de DÉPART = Salle A");
    ck.eq(JSON.stringify(r.endContainer), JSON.stringify({ kind: "room", id: dcB.id }), "route : conteneur d'ARRIVÉE = Salle B");
    /* ⚠ CHANGEMENT DE GRAMMAIRE VOULU (doctrine §6.31, décisions D2/D3). Un pin d'étage n'est plus refusé
       faute d'exit PRÉCÉDENT : il NOMME l'étage sur lequel la route se trouve, et une route peut donc
       commencer ET finir sur un étage. L'ancienne grammaire rendait `floor_outside` sur ce cas. */
    r = s.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: [oob.id] });
    ck(r.valid, "pin d'étage SEUL → VALIDE (l'ancienne grammaire refusait par floor_outside)");
    ck.eq(JSON.stringify(r.endContainer), JSON.stringify({ kind: "floor", location: "", floor: "1" }), "…et la route ARRIVE sur cet étage (conteneur = couple bâtiment+étage)");
    // exit non appairé → invalide
    r = s.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: [exitA.id] });
    ck(!r.valid, "exit non appairé → invalide");
    // -- CODES STABLES d'erreur + helpers (les appelants réagissent au code, PAS au libellé) --
    // `floor_outside` SUBSISTE, avec un sens resserré : un pin d'étage À L'INTÉRIEUR d'une salle.
    ck.eq(s.cableRoute({ from_port_id: null, to_port_id: null, waypoint_ids: [dcWpA.id, oob.id] }).errors[0].code, "floor_outside", "code : pin d'étage À L'INTÉRIEUR d'une salle → floor_outside");
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
    ck.eq(JSON.stringify(k.container), JSON.stringify({ kind: "room", id: dcA.id }), "cableSideConstraint(A) impose le CONTENEUR de départ");

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
    /* SALLE d'un contenu = son conteneur de CHAÎNE restreint à « salle », l'expression exacte qu'emploient
       les trois chemins salle de « Localiser » depuis le retrait du trio `*DcId` (doctrine §6.33). */
    const salleDe = (eqOrId) => { const k = s.equipmentNamedContainer(eqOrId); return k && k.kind === "room" ? k.id : null; };
    const salleDuPort = (pid) => { const p = s.get("ports", pid); return p ? salleDe(p.equipment_id) : null; };
    // salle via baie hôte
    const eqInA = s.get("ports", pA1) ? s.get("equipments", s.get("ports", pA1).equipment_id) : null;
    ck.eq(salleDe(eqInA.id), dcA.id, "salle d'un équipement racké → salle de la baie");
    // salle via ÉTAGÈRE (tray) : posé sur une étagère d une baie placée → salle de la baie hôte.
    // Bug corrigé : le placement tray retombait à null (« non placé »), bloquant un câble vers ce posé à « planifié ».
    const rkTray = await s.create("racks", { name: "RTray", u_count: 42, datacenter_id: dcA.id, dc_x: 500, dc_y: 500 });
    const trayIt = await s.create("rackItems", { rack_id: rkTray.id, kind: "tray", tray_type: "cantilever", u: 10, u_height: 3, tray_u: 1, depth_mm: 400 });
    const eqOnTray = await s.create("equipments", { name: "surEtagere", dim_mode: "free", placement_mode: "tray", tray_item_id: trayIt.id, tray_x: 10, tray_y: 10, free_w_mm: 100, free_l_mm: 100, free_h_mm: 40 });
    ck.eq(salleDe(eqOnTray.id), dcA.id, "salle d'un posé sur étagère → salle de la baie hôte (bug tray corrigé)");

    // contrainte de placement (câblage) : un équipement LIBRE câblé intra-salle vers pA1 (Salle A)
    const eqX = await s.create("equipments", { name: "X" });
    const pX = (await s.create("ports", { equipment_id: eqX.id, name: "pX" })).id;
    const lien = await s.create("cables", { name: "lien", from_port_id: pX, to_port_id: pA1 });
    /* SALLE d'un PORT / d'une LIAISON : ce que résolvaient les anciens `portDcId`/`cableDcId`, résolveurs
       partagés des boutons « Localiser en 3D » (parité locatePort/locateCable de la vue 3D). Ils sont
       RETIRÉS (§6.33) ; leurs verdicts restent verrouillés ici, contre des salles écrites à la main.
       À ce stade eqX est encore NON PLACÉ (il n'est mis en baie que plus bas). */
    ck.eq(salleDuPort(pA1), dcA.id, "salle d'un port d'équipement racké → salle de la baie");
    ck.eq(salleDuPort(pX), null, "salle d'un port d'équipement non placé → null");
    ck.eq(salleDuPort(lien.from_port_id) || salleDuPort(lien.to_port_id), dcA.id, "liaison : une extrémité localisable suffit → sa salle (priorité A puis B)");
    ck.eq(salleDuPort(jm.from_port_id) || salleDuPort(jm.to_port_id), null, "liaison : aucune extrémité en salle → null (bouton Localiser masqué)");
    /* PARITÉ du chemin CONTENEUR sur une liaison de SALLE (§6.32) : le prédicat et l'extrémité retenue
       reproduisent exactement le verdict historique — désormais épinglé à des constantes, l'ancienne
       fonction n'étant plus là pour servir d'oracle vivant (§6.33). */
    ck.eq(s.cableLocatable(lien.id), true, "cableLocatable : même verdict que l'ancien `!!cableDcId` sur une liaison de salle");
    ck.eq(s.cableLocatableEnd(lien.id), pA1, "cableLocatableEnd : l'extrémité RETENUE est la première localisable — pX n'est pas placé, c'est donc pA1");
    ck.eq(salleDuPort(s.cableLocatableEnd(lien.id)), dcA.id, "…et la salle qu'elle désigne est bien la Salle A, celle que cadrait `cableDcId` : le cadrage ne bouge pas");
    ck.eq(s.cableLocatable(jm), false, "cableLocatable : aucune extrémité atteignable → false (parité `!!cableDcId`)");
    ck.eq(s.cableLocatableEnd(jm), null, "…et aucune extrémité retenue");
    ck.eq(s.equipmentPlacementBlockedReason(eqX.id, dcA.id), null, "blockedReason : pose dans la salle câblée → autorisée");
    ck(typeof s.equipmentPlacementBlockedReason(eqX.id, dcB.id) === "string", "blockedReason : pose dans une AUTRE salle → bloquée");
    ck(s.equipmentRequiredContainers(eqX.id).some((x) => x.container.kind === "room" && x.container.id === dcA.id), "equipmentRequiredContainers : contraint à la Salle A");
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

  await section("Grammaire de route : l'automate parle CONTENEURS (§6.31 — parité figée sur HEAD)", async () => {
  {
    /* Lot 5 du chantier « câblage des équipements d'étage » (décisions D2/D3/D4). L'automate tenait un
       booléen `outside` refermé par un SECOND exit ; il tient maintenant un CONTENEUR, et un pin d'étage
       ferme le tronçon en NOMMANT l'étage atteint. Deux familles d'assertions cohabitent ici :

       — PARITÉ : les valeurs marquées « (HEAD) » ont été MESURÉES sur l'analyseur d'avant bascule,
         régénéré depuis git (`git show HEAD:src-client/store/CableRouteAnalyzer.ts`, compilé à part) sur
         EXACTEMENT cette scène, puis écrites EN DUR. Elles ne comparent donc pas la fonction à elle-même
         (piège du lot 2 du chantier conteneur) : elles disent ce que l'analyse VALAIT, et doit valoir.
         Le banc complet (66 420 analyses, 6 400 sans aucun étage, 0 divergence) a servi à établir qu'AUCUN
         autre cas ne bouge ; ces cas-ci en sont les représentants figés.
       — CHANGEMENTS VOULUS : marqués « (NOUVEAU) », avec l'ancien verdict rappelé en commentaire. */
    const s = await makeStore();
    const dcA = await s.create("datacenters", { name: "Salle A", location: "liege", floor: "1" });
    const dcB = await s.create("datacenters", { name: "Salle B", location: "liege", floor: "1" });
    const rkA = await s.create("racks", { name: "RA", u_count: 42, datacenter_id: dcA.id, dc_x: 500, dc_y: 500 });
    const rkB = await s.create("racks", { name: "RB", u_count: 42, datacenter_id: dcB.id, dc_x: 500, dc_y: 500 });
    const mk = async (nom, patch) => { const e = await s.create("equipments", Object.assign({ name: nom }, patch)); return { e, p: (await s.create("ports", { equipment_id: e.id, name: "p" + nom })).id }; };
    const A = await mk("A", { placement_mode: "rack", rack_id: rkA.id, rack_u: 1 });
    const A2 = await mk("A2", { placement_mode: "rack", rack_id: rkA.id, rack_u: 2 });
    const B = await mk("B", { placement_mode: "rack", rack_id: rkB.id, rack_u: 1 });
    const F1 = await mk("F1", { placement_mode: "floor", location: "liege", floor: "1", floor_x: 1000, floor_y: 1000 });
    const F1b = await mk("F1b", { placement_mode: "floor", location: "liege", floor: "1", floor_x: 3000, floor_y: 1000 });
    const F2 = await mk("F2", { placement_mode: "floor", location: "liege", floor: "2", floor_x: 1000, floor_y: 1000 });
    const exA = await s.create("waypoints", { name: "sortieA", wp_type: "exit", datacenter_id: dcA.id, dc_x: 0, dc_y: 0 });
    const exB = await s.create("waypoints", { name: "sortieB", wp_type: "exit", datacenter_id: dcB.id, dc_x: 0, dc_y: 0 });
    const pin1 = await s.create("waypoints", { name: "gaine1", wp_type: "oob", location: "liege", floor: "1", floor_x: 2000, floor_y: 2000 });
    const pin2 = await s.create("waypoints", { name: "gaine2", wp_type: "oob", location: "liege", floor: "2", floor_x: 2000, floor_y: 2000 });
    const wpA = await s.create("waypoints", { name: "ptA", wp_type: "datacenter", datacenter_id: dcA.id, dc_x: 600, dc_y: 600 });

    const salle = (d) => ({ kind: "room", id: d.id });
    const etage = (f) => PlacementContainers.floorOf("liege", f);
    const route = (fa, fb, wps) => s.cableRoute({ id: "sonde", from_port_id: fa, to_port_id: fb, waypoint_ids: wps });
    const codes = (r) => r.errors.map((e) => e.code).join(",");
    const bilan = (r) => JSON.stringify([codes(r), r.valid, r.hasExits, r.startContainer, r.endContainer, r.containerA, r.containerB]);
    const attendu = (c, valid, hasExits, start, end, ca, cb) => JSON.stringify([c, valid, hasExits, start, end, ca, cb]);

    /* ---------- PARITÉ (valeurs mesurées sur HEAD, écrites en dur) ---------- */
    ck.eq(bilan(route(A.p, A2.p, [])), attendu("", true, false, null, null, salle(dcA), salle(dcA)),
      "(HEAD) intra-salle sans waypoint : valide, sans exit, deux bouts en Salle A");
    ck.eq(bilan(route(A.p, B.p, [exA.id, exB.id])), attendu("", true, true, salle(dcA), salle(dcB), salle(dcA), salle(dcB)),
      "(HEAD) salle A → salle B par deux exits : valide, départ et arrivée déduits");
    ck.eq(bilan(route(A.p, B.p, [exA.id, pin1.id, exB.id])), attendu("", true, true, salle(dcA), salle(dcB), salle(dcA), salle(dcB)),
      "(HEAD) salle A → pin d'étage → salle B : le pin ne change ni le départ ni l'arrivée");
    ck.eq(bilan(route(A.p, B.p, [])), attendu("ports_split", false, false, null, null, salle(dcA), salle(dcB)),
      "(HEAD) deux salles sans exit → ports_split");
    ck.eq(bilan(route(A.p, null, [exA.id])), attendu("exit_unpaired", false, true, salle(dcA), null, salle(dcA), null),
      "(HEAD) exit seul → exit_unpaired (la route quitte sans arriver)");
    ck.eq(codes(route(null, null, [exA.id, wpA.id])), "room_wp_outside,exit_unpaired",
      "(HEAD) waypoint de salle APRÈS son exit → room_wp_outside + exit_unpaired");
    ck.eq(codes(route(null, null, [wpA.id, pin1.id])), "floor_outside",
      "(HEAD) pin d'étage à l'INTÉRIEUR d'une salle → floor_outside (seul cas où le code subsiste)");
    ck.eq(codes(route(null, null, [exA.id, exA.id])), "exit_reentry",
      "(HEAD) ré-entrée par l'exit de la salle quittée → exit_reentry SEUL (le second exit referme bien le tronçon)");
    ck.eq(codes(route(null, null, [wpA.id, exB.id])), "exit_wrong_room,exit_unpaired",
      "(HEAD) exit d'une AUTRE salle que le segment courant → exit_wrong_room");
    ck.eq(s.cableRouteSummary(route(A.p, B.p, [exA.id, exB.id])), "⏏ Salle A → ⏏ Salle B",
      "(HEAD) résumé d'une route entre deux salles : inchangé au caractère près");
    /* Le résumé est devenu une CHAÎNE DE CONTENEURS ; le piège `same(null, null) === false` y mordrait.
       Deux waypoints flottants ne franchissent aucune frontière : le résumé reste VIDE, comme sur HEAD. */
    const flotA = await s.create("waypoints", { name: "flottant1" });
    const flotB = await s.create("waypoints", { name: "flottant2" });
    ck.eq(s.cableRouteSummary(route(null, null, [flotA.id, flotB.id])), "",
      "(HEAD) deux waypoints NON POSÉS d'affilée : aucune étape au résumé (deux absences ne font pas une transition)");
    ck.eq(codes(route(null, null, [flotA.id, flotB.id])), "unplaced,unplaced", "(HEAD) …et chacun est signalé « non posé »");

    /* ---------- CHANGEMENTS VOULUS ---------- */
    // (NOUVEAU) LE CAS DU LOT : une baie sort de sa salle et ARRIVE sur un étage. HEAD : exit_unpaired.
    const versEtage = route(A.p, F1.p, [exA.id, pin1.id]);
    ck.eq(bilan(versEtage), attendu("", true, true, salle(dcA), etage("1"), salle(dcA), etage("1")),
      "(NOUVEAU) salle A → pin d'étage : VALIDE, la route ARRIVE sur l'étage (HEAD : exit_unpaired)");
    ck.eq(s.cableContextValid({ from_port_id: A.p, to_port_id: F1.p, waypoint_ids: [exA.id, pin1.id] }), true,
      "(NOUVEAU) …et le câble baie → posé d'étage est jugé COHÉRENT (HEAD : invalide → cassé au déplacement)");
    // (NOUVEAU) symétrique : une route peut COMMENCER sur un étage. HEAD : floor_outside + exit_unpaired.
    ck.eq(bilan(route(F1.p, A.p, [pin1.id, exA.id])), attendu("", true, true, etage("1"), salle(dcA), etage("1"), salle(dcA)),
      "(NOUVEAU) pin d'étage → exit : la route COMMENCE sur l'étage (HEAD : floor_outside)");
    // (NOUVEAU) un pin d'étage SEUL décrit une route entièrement sur cet étage. HEAD : floor_outside.
    ck.eq(bilan(route(F1.p, F1b.p, [pin1.id])), attendu("", true, false, etage("1"), etage("1"), etage("1"), etage("1")),
      "(NOUVEAU) pin d'étage seul entre deux posés du même étage : valide, sans exit");
    // D2 — MÊME conteneur ⇒ aucune sortie exigée ; conteneurs DIFFÉRENTS ⇒ sortie exigée. Aucune branche
    // propre à l'étage : c'est la règle des salles, avec « conteneur » à la place de « salle ».
    ck.eq(codes(route(F1.p, F1b.p, [])), "",
      "(D2) deux posés du MÊME étage, aucun waypoint → valide (comme deux équipements d'une même salle)");
    ck.eq(codes(route(F1.p, F2.p, [])), "ports_split",
      "(D2) deux posés d'étages DIFFÉRENTS, aucun waypoint → ports_split (HEAD : accepté — c'était un TROU)");
    ck.eq(s.cableContextValid({ from_port_id: F1.p, to_port_id: F2.p, waypoint_ids: [] }), false,
      "(D2) …et `cableContextValid` l'exige aussi : le trou « au moins l'un est une salle » est refermé");
    ck.eq(s.cableContextValid({ from_port_id: F1.p, to_port_id: F1b.p, waypoint_ids: [] }), true,
      "(D2) même étage ⇒ aucune exigence de sortie");
    // Le port doit être DANS le conteneur d'arrivée — la vérification suit l'étage comme elle suivait la salle.
    ck.eq(codes(route(A.p, F2.p, [exA.id, pin1.id])), "portB_room",
      "port B sur l'étage 2 alors que la route arrive à l'étage 1 → portB_room");
    ck.eq(codes(route(A.p, F2.p, [exA.id, pin2.id])), "",
      "…et la même route menée au BON étage est valide");
    // CONSÉQUENCE ASSUMÉE de la grammaire : l'étage d'arrivée doit être NOMMÉ. Sans pin, la route quitte
    // la salle sans dire où elle va — elle reste donc incomplète, exactement comme avant.
    ck.eq(codes(route(A.p, F1.p, [exA.id])), "exit_unpaired",
      "salle → étage SANS pin d'étage : la route ne nomme aucune arrivée → exit_unpaired (inchangé)");

    /* ---------- D4 : le mot JUSTE selon le conteneur ---------- */
    const msg = (r, code) => (r.errors.find((e) => e.code === code) || {}).message || "";
    const msgB = msg(route(A.p, F2.p, [exA.id, pin1.id]), "portB_room");
    ck(msgB.indexOf("étage") >= 0 && msgB.indexOf("salle") < 0, "(D4) arrivée sur un ÉTAGE : le message dit « étage », pas « salle »");
    const msgBSalle = msg(route(A.p, F1.p, [exA.id, exB.id]), "portB_room");
    ck(msgBSalle.indexOf("salle") >= 0, "(D4) arrivée dans une SALLE : le message dit « salle » (libellé historique)");
    ck(msgB.indexOf("analysis.") < 0 && msgBSalle.indexOf("analysis.") < 0, "les messages sont TRADUITS (aucune clé i18n brute ne fuit)");
    ck(codes(route(F1.p, F2.p, [])) === "ports_split" && msg(route(F1.p, F2.p, []), "ports_split").indexOf("emplacements") >= 0,
      "(D4) deux ÉTAGES : « emplacements » ; deux salles gardent le mot « salles »");
    ck(msg(route(A.p, B.p, []), "ports_split").indexOf("salles") >= 0, "(D4) deux SALLES : le message historique, mot pour mot");

    /* ---------- contrainte de placement : elle peut désormais désigner un ÉTAGE ---------- */
    const libre = await s.create("equipments", { name: "Libre" });
    const pLibre = (await s.create("ports", { equipment_id: libre.id, name: "pL" })).id;
    await s.create("cables", { name: "vers-etage", from_port_id: pLibre, to_port_id: F1.p, waypoint_ids: [pin1.id] });
    const req = s.equipmentRequiredContainers(libre.id);
    ck.eq(JSON.stringify(req.map((x) => x.container)), JSON.stringify([etage("1")]), "equipmentRequiredContainers : contrainte vers un ÉTAGE (l'ancienne Map par id de salle ne savait pas l'exprimer)");
    const why = s.equipmentPlacementBlockedReason(libre.id, dcA.id);
    ck(typeof why === "string" && why.indexOf("analysis.") < 0, "…et poser cet équipement dans une salle est BLOQUÉ, avec un motif traduit");

    /* ---------- l'identité d'un étage : le couple, jamais une chaîne encodée ---------- */
    ck.eq(PlacementContainers.same(PlacementContainers.floorOf("liege", 0), PlacementContainers.floorOf("liege", "")), false,
      "floorOf : le rez-de-chaussée (0) et l'étage VIDE restent DEUX conteneurs distincts (piège `String(x || \"\")`)");
    ck.eq(PlacementContainers.same(PlacementContainers.floorOf("liege", 1), PlacementContainers.floorOf("liege", "1")), true,
      "floorOf : nombre et chaîne désignent le MÊME étage");
    ck.eq(PlacementContainers.same(PlacementContainers.floorOf("liege", "1"), PlacementContainers.floorOf("namur", "1")), false,
      "floorOf : même numéro d'étage dans deux BÂTIMENTS ≠ même conteneur");
    ck.eq(PlacementContainers.same(null, null), false, "same(null, null) = false : deux absences ne sont pas un même endroit");
    ck.eq(PlacementContainers.sameOrNone(null, null), true, "sameOrNone(null, null) = true : deux absences ne constituent pas une TRANSITION");
    ck.eq(PlacementContainers.sameOrNone(salle(dcA), null), false, "sameOrNone : une absence suivie d'un conteneur EST une transition");
  }
  });

  await section("Store : bundleRoute — cohérence extrémités ⇄ route des FAISCEAUX", async () => {
  {
    /* Un faisceau n'a pas de ports : le pseudo-câble qu'analysait le rendu ne pouvait JAMAIS déclencher
       `ports_split`/`portA_room`/`portB_room`, et l'alignement extrémités ⇄ route se vérifiait DANS le
       rendu — qui, en cas d'incohérence, ne traçait rien, silencieusement (incident réel : faisceau
       invisible, aucun message). `bundleRoute` est désormais la SOURCE UNIQUE de ce verdict :
       le rendu consomme `sens`, le formulaire affiche les erreurs. Cf. docs/faisceaux.md §3.1. */
    const s = await makeStore();
    const dcA = await s.create("datacenters", { name: "Salle A" });
    const dcB = await s.create("datacenters", { name: "Salle B" });
    const dcC = await s.create("datacenters", { name: "Salle C" });
    const rkA = await s.create("racks", { name: "RA", u_count: 42, datacenter_id: dcA.id, dc_x: 500, dc_y: 500 });
    const rkB = await s.create("racks", { name: "RB", u_count: 42, datacenter_id: dcB.id, dc_x: 500, dc_y: 500 });
    const patchA = await s.create("equipments", { name: "PatchA", type: "patch_panel", placement_mode: "rack", rack_id: rkA.id, rack_u: 1 });
    const patchB = await s.create("equipments", { name: "PatchB", type: "patch_panel", placement_mode: "rack", rack_id: rkB.id, rack_u: 1 });
    const patchPool = await s.create("equipments", { name: "PatchPool", type: "patch_panel" });   // volontairement NON placé
    const exA = await s.create("waypoints", { name: "sortieA", wp_type: "exit", datacenter_id: dcA.id, dc_x: 0, dc_y: 0 });
    const exB = await s.create("waypoints", { name: "sortieB", wp_type: "exit", datacenter_id: dcB.id, dc_x: 0, dc_y: 0 });
    const exC = await s.create("waypoints", { name: "sortieC", wp_type: "exit", datacenter_id: dcC.id, dc_x: 0, dc_y: 0 });

    const analyse = (epA, epB, wps) => s.bundleRoute({ endpoint_a_equipment_id: epA, endpoint_b_equipment_id: epB, waypoint_ids: wps });
    const codes = (r) => r.errors.map((e) => e.code).join(",");

    // (a) route alignée sur les extrémités → RAS
    let r = analyse(patchA.id, patchB.id, [exA.id, exB.id]);
    ck(r.valid && r.sens === "aligned" && !r.errors.length, "(a) route alignée → valide, sens « aligned », 0 erreur");
    ck.eq(JSON.stringify(r.containerA), JSON.stringify({ kind: "room", id: dcA.id }), "(a) containerA = conteneur du patch A (le pseudo-câble sans ports rendait null)");
    ck.eq(JSON.stringify(r.containerB), JSON.stringify({ kind: "room", id: dcB.id }), "(a) containerB = conteneur du patch B");
    // (b) route saisie à l'envers : TOLÉRÉE (parité rendu historique), le sens le dit
    r = analyse(patchA.id, patchB.id, [exB.id, exA.id]);
    ck(r.valid && r.sens === "swapped", "(b) route à l'envers → valide, sens « swapped » (tolérance conservée)");
    // (c) LE CAS DE L'INCIDENT : extrémités en salles A et B, route exit(C) → exit(B)
    r = analyse(patchA.id, patchB.id, [exC.id, exB.id]);
    ck(!r.valid && r.sens === null && codes(r) === "endpoint_route_mismatch",
      "(c) INCIDENT : route salle C → salle B vs extrémités A/B → endpoint_route_mismatch, valid=false, sens=null");
    const mc = r.errors[0].message;
    ck(["Salle A", "Salle B", "Salle C"].every((n) => mc.indexOf(n) >= 0) && mc.indexOf("analysis.") < 0,
      "(c) …le message NOMME les conteneurs (celui qui aurait révélé l'incident), traduit");
    // (d) endpoints_split : deux patchs dans deux salles, route sans exit (miroir de ports_split)
    r = analyse(patchA.id, patchB.id, []);
    ck(!r.valid && codes(r) === "endpoints_split" && r.sens === null, "(d) 2 extrémités / 2 salles, aucune sortie → endpoints_split");
    ck(r.errors[0].message.indexOf("salles") >= 0, "(d) …deux SALLES : le message emploie le mot juste (D4, parité portsSplitRooms)");
    // (e) une SEULE extrémité posée : elle peut tenir l'un OU l'autre bout de la route
    ck(analyse(patchA.id, null, [exA.id, exB.id]).valid, "(e) extrémité unique qui matche le DÉPART → aucune erreur");
    ck(analyse(patchA.id, null, [exB.id, exA.id]).valid, "(e) extrémité unique qui matche l'ARRIVÉE → aucune erreur (inversion tolérée)");
    r = analyse(patchA.id, null, [exB.id, exC.id]);
    ck(!r.valid && codes(r) === "endpoint_route_mismatch", "(e) extrémité unique qui ne matche NI départ NI arrivée → endpoint_route_mismatch");
    ck(["Salle A", "Salle B", "Salle C"].every((n) => r.errors[0].message.indexOf(n) >= 0), "(e) …message adapté : les TROIS conteneurs sont nommés");
    // (e') extrémité présente mais NON LOCALISABLE (pool) : rien à juger — comme une extrémité absente
    r = analyse(patchA.id, patchPool.id, [exA.id, exB.id]);
    ck(r.valid && r.sens === null, "(e') extrémité au pool (non localisable) → aucune erreur nouvelle, sens null (le rendu ne trace pas, faute de pose)");
    // (f) extrémités ABSENTES (création en cours) : aucun nouveau code
    r = analyse(null, null, [exA.id, exB.id]);
    ck(r.valid && r.sens === null && !r.errors.length, "(f) extrémités absentes → aucun nouveau code (brouillon en cours de saisie)");
    // les erreurs de GRAMMAIRE du pseudo-câble restent dans le verdict (bundleRoute les ENGLOBE)
    r = analyse(patchA.id, patchB.id, [exA.id]);
    ck(!r.valid && r.errors.some((e) => e.code === "exit_unpaired"), "grammaire : exit non appairé remonte tel quel dans bundleRoute");
    // (g) INVARIANT : les codes de faisceau ne sont NI structurels NI room-break — ils n'empêchent pas
    // d'enregistrer un brouillon (le formulaire ne bloque au save que ROUTE_STRUCTURAL_CODES).
    const { ROUTE_STRUCTURAL_CODES, ROUTE_ROOM_BREAK_CODES } = D("store/CableRouteAnalyzer.js");
    ["endpoints_split", "endpoint_route_mismatch"].forEach((c) => {
      ck(!ROUTE_STRUCTURAL_CODES.has(c) && !ROUTE_ROOM_BREAK_CODES.has(c), "(g) « " + c + " » n'appartient ni à ROUTE_STRUCTURAL_CODES ni à ROUTE_ROOM_BREAK_CODES");
    });
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
    const notAPatch = await s.create("equipments", { name: "serveur-X", type: "server" });
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
    const tab = await s.create("equipments", { name: "TGBT", type: "switchboard" });
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

    // ---- POE : le budget de port est une CAPACITÉ ; la conso RÉELLE vient du PD câblé. Bilan + survente + par port. ----
    const sw = await s.create("equipments", { name: "sw-poe", power_nominal_w: 50, power_max_w: 60, poe_device: true, poe_budget_w: 90 });
    const swPsu = await s.create("ports", { equipment_id: sw.id, name: "PSU", role: "power", direction: "sink", power_max_a: 4 });
    const poe1 = await s.create("ports", { equipment_id: sw.id, name: "poe-1", role: "poe", direction: "source", poe_budget_w: 30 });
    const poe2 = await s.create("ports", { equipment_id: sw.id, name: "poe-2", role: "poe", direction: "source", poe_budget_w: 30 });   // non câblé
    // PD : caméra alimentée en PoE (port poe SINK) — conso nominale 12 W / max 15 W. Un PD est aussi un poe_device (T-POE1).
    const cam = await s.create("equipments", { name: "cam", power_nominal_w: 12, power_max_w: 15, poe_device: true });
    const camPoe = await s.create("ports", { equipment_id: cam.id, name: "eth", role: "poe", direction: "sink" });
    await s.create("cables", { from_port_id: poe1.id, to_port_id: camPoe.id });   // PSE poe-1 → PD caméra
    const out5 = await s.create("ports", { equipment_id: pdu.id, name: "C5", role: "power", direction: "source", power_max_a: 16 });
    await s.create("cables", { from_port_id: out5.id, to_port_id: swPsu.id });     // PDU → alim du switch
    {
      const paP = new PowerAnalysis(s);   // instance fraîche (le store a muté depuis `pa`)
      // budget de port = CAPACITÉ (30 W) ; la charge = conso MAX du PD câblé (15 W). poe-2 non câblé → 0.
      ck.eq(paP.poePortLoadW(poe1, true), 15, "POE : charge du port PSE = conso MAX du PD câblé (15 W), pas le budget");
      ck.eq(paP.poePortLoadW(poe2, true), 0, "POE : port PSE sans PD câblé → charge 0 (le budget reste une capacité)");
      const supply = paP.poeSupply(sw.id);
      ck(supply.loadW === 15 && supply.budgetW === 90 && !supply.over, "POE : bilan 15 W tirés (PD) / 90 W budget, pas de survente");
      // conso du switch = base max 60 W + PoE tiré 15 W = 75 W → 75 / 230 V tirés par l'unique PSU.
      ck(Math.abs(paP.leafSinkCurrentA(swPsu, true) - (75 / 230)) < 0.01, "POE : conso switch = base max 60 W + PoE tiré 15 W (75 W)");
      // POE HORS du graphe secteur : les ports poe ne comptent pas comme départs power du switch (pas de double comptage).
      ck.eq(paP.departLoads(sw.id).length, 0, "POE : ports poe exclus des départs secteur");
      ck.eq(paP.equipmentWarnings(sw.id).some((w) => w.code === "poe_over_budget"), false, "POE : charge < budget total → pas de survente");
      ck.eq(paP.equipmentWarnings(sw.id).some((w) => w.code === "poe_port_over"), false, "POE : PD sous le budget du port → pas d'alerte port");
    }
    // SURVENTE PAR PORT : le PD (15 W) dépasse le budget (capacité) du port producteur ramené à 10 W.
    await s.update("ports", poe1.id, { poe_budget_w: 10 });
    ck.eq(new PowerAnalysis(s).equipmentWarnings(sw.id).some((w) => w.code === "poe_port_over"), true, "POE : PD 15 W > budget du port 10 W → alerte poe_port_over");
    // SURVENTE ÉQUIPEMENT : la charge PD (15 W) dépasse le budget TOTAL ramené à 10 W.
    await s.update("equipments", sw.id, { poe_budget_w: 10 });
    {
      const paP = new PowerAnalysis(s);
      ck.eq(paP.poeSupply(sw.id).over, true, "POE : charge PD 15 W > budget total 10 W → survente (over)");
      ck.eq(paP.equipmentWarnings(sw.id).some((w) => w.code === "poe_over_budget"), true, "POE : survente équipement → avertissement poe_over_budget");
    }
    // ---- POE `poe_enabled` : parité avec l'éclair (cableCarriesPower) — un lien coupé d'un côté OU de l'autre ne
    //      compte NI dans la charge du PSE NI dans sa conso secteur. Budgets encore ramenés à 10 W (assertions ci-dessus). ----
    await s.update("ports", camPoe.id, { poe_enabled: false });   // PD désactivé → le lien PoE ne transporte plus rien
    {
      const paP = new PowerAnalysis(s);
      ck.eq(paP.poePortLoadW(poe1, true), 0, "POE enabled : PD désactivé → charge du port PSE = 0 (parité éclair)");
      ck.eq(paP.poeSupply(sw.id).loadW, 0, "POE enabled : PD désactivé → aucune charge PoE tirée du switch (demandW sans PoE)");
      ck.eq(paP.equipmentWarnings(sw.id).some((w) => w.code === "poe_over_budget"), false, "POE enabled : PD désactivé → pas de survente même à 10 W de budget");
      ck.eq(paP.equipmentWarnings(sw.id).some((w) => w.code === "poe_port_over"), false, "POE enabled : PD désactivé → pas de dépassement de port");
    }
    // PD réactivé mais PSE (poe-1) désactivé → l'autre extrémité coupée suffit à annuler le lien.
    await s.update("ports", camPoe.id, { poe_enabled: true });
    await s.update("ports", poe1.id, { poe_enabled: false });
    {
      const paP = new PowerAnalysis(s);
      ck.eq(paP.poePortLoadW(poe1, true), 0, "POE enabled : PSE désactivé → charge du port PSE = 0 (parité éclair)");
      ck.eq(paP.poeSupply(sw.id).loadW, 0, "POE enabled : PSE désactivé → aucune charge PoE tirée du switch");
      ck.eq(paP.equipmentWarnings(sw.id).some((w) => w.code === "poe_over_budget"), false, "POE enabled : PSE désactivé → pas de survente");
      ck.eq(paP.equipmentWarnings(sw.id).some((w) => w.code === "poe_port_over"), false, "POE enabled : PSE désactivé → pas de dépassement de port");
    }
    // Les DEUX réactivés → la charge (conso MAX du PD = 15 W) revient.
    await s.update("ports", poe1.id, { poe_enabled: true });
    {
      const paP = new PowerAnalysis(s);
      ck.eq(paP.poePortLoadW(poe1, true), 15, "POE enabled : les deux extrémités actives → la charge revient (15 W)");
      ck.eq(paP.poeSupply(sw.id).loadW, 15, "POE enabled : les deux extrémités actives → charge PoE de 15 W tirée du switch");
    }

    // ---- CAPACITÉ DE DISTRIBUTION : pdu_over_capacity (Equipment.pdu_max_a) et network_over_amp (Network.max_amp). ----
    // Le scénario a empilé plusieurs consommateurs sur l'UNIQUE départ Q1 du tableau : on mesure la charge MAX réelle
    // en aval pour placer les plafonds de part et d'autre (test robuste au détail des consos). Instance fraîche à
    // chaque mutation (mémoïsation PAR INSTANCE).
    const tabLoadA = new PowerAnalysis(s).departLoads(tab.id, true).reduce((sum, dl) => sum + dl.usedA, 0);
    ck(tabLoadA > 1, "power capacité : le tableau porte une charge aval non triviale (repère de plafond)");
    // pdu_over_capacity : plafond SOUS la charge → alerte ; plafond largement AU-DESSUS → plus d'alerte.
    await s.update("equipments", tab.id, { pdu_max_a: 1 });
    ck.eq(new PowerAnalysis(s).equipmentWarnings(tab.id).some((w) => w.code === "pdu_over_capacity"), true, "power capacité : pdu_max_a (1 A) < charge aval → pdu_over_capacity");
    await s.update("equipments", tab.id, { pdu_max_a: Math.ceil(tabLoadA) + 1000 });
    ck.eq(new PowerAnalysis(s).equipmentWarnings(tab.id).some((w) => w.code === "pdu_over_capacity"), false, "power capacité : pdu_max_a >> charge aval → pas d'alerte");
    // network_over_amp : le départ racine Q1 asserte déjà pnet (kind power). Capacité du réseau SOUS la charge → alerte
    // sur le tableau (Σ des départs assertant pnet = ce seul départ) ; capacité large → plus d'alerte.
    await s.update("networks", pnet.id, { max_amp: 1 });
    ck.eq(new PowerAnalysis(s).equipmentWarnings(tab.id).some((w) => w.code === "network_over_amp"), true, "power capacité : max_amp (1 A) < charge du réseau power → network_over_amp");
    await s.update("networks", pnet.id, { max_amp: Math.ceil(tabLoadA) + 1000 });
    ck.eq(new PowerAnalysis(s).equipmentWarnings(tab.id).some((w) => w.code === "network_over_amp"), false, "power capacité : max_amp >> charge du réseau → pas d'alerte");
    // Un CONSOMMATEUR (sans pdu_max_a, sans départ assertant un réseau power) ne reçoit AUCUN de ces deux codes, et ses
    // assertions existantes (psu_undersized ici) restent inchangées — les nouveaux contrôles ne fuient pas sur lui.
    const srvCodes = new PowerAnalysis(s).equipmentWarnings(srv.id).map((w) => w.code);
    ck.eq(srvCodes.includes("pdu_over_capacity"), false, "power capacité : consommateur sans pdu_max_a → jamais pdu_over_capacity");
    ck.eq(srvCodes.includes("network_over_amp"), false, "power capacité : consommateur sans départ assertant → jamais network_over_amp");
    ck.eq(srvCodes.includes("psu_undersized"), true, "power capacité : les assertions existantes du consommateur restent (psu_undersized inchangé)");

    // ---- POE `poe_pd_unfed` : un appareil alimenté UNIQUEMENT en PoE (port poe+sink) est muet côté secteur
    //      (no_source/psu_uncabled ne voient que le graphe secteur) → on vérifie ici qu'un PD ACTIF a bien un
    //      injecteur PSE ACTIF câblé. À ce stade : poe1 (10 W, actif) → camPoe (actif) ; poe2 libre et actif. ----
    // cam est câblé à poe1 (PSE actif) → PAS d'alerte.
    ck.eq(new PowerAnalysis(s).equipmentWarnings(cam.id).some((w) => w.code === "poe_pd_unfed"), false, "POE non alimenté : PD câblé à un PSE actif → pas d'alerte");
    // Nouveau PD dont l'unique port PoE (sink) n'est câblé à rien → non alimenté.
    const cam2 = await s.create("equipments", { name: "cam2", power_nominal_w: 8, poe_device: true });
    const cam2Poe = await s.create("ports", { equipment_id: cam2.id, name: "eth", role: "poe", direction: "sink" });
    ck.eq(new PowerAnalysis(s).equipmentWarnings(cam2.id).some((w) => w.code === "poe_pd_unfed"), true, "POE non alimenté : PD au port PoE non câblé → poe_pd_unfed");
    // Câblé à poe2 (PSE libre et ACTIF du switch) → alimenté, alerte levée.
    await s.create("cables", { from_port_id: poe2.id, to_port_id: cam2Poe.id });
    ck.eq(new PowerAnalysis(s).equipmentWarnings(cam2.id).some((w) => w.code === "poe_pd_unfed"), false, "POE non alimenté : PD câblé à un PSE actif (poe-2) → alerte levée");
    // Injecteur coupé (poe2 désactivé) → câblé mais plus alimenté par un PSE ACTIF → l'alerte revient (parité éclair).
    await s.update("ports", poe2.id, { poe_enabled: false });
    ck.eq(new PowerAnalysis(s).equipmentWarnings(cam2.id).some((w) => w.code === "poe_pd_unfed"), true, "POE non alimenté : injecteur PSE désactivé → PD non alimenté (poe_pd_unfed revient)");
    // Port PD lui-même désactivé (injecteur rallumé) → désactivation VOLONTAIRE, PAS d'alerte.
    await s.update("ports", poe2.id, { poe_enabled: true });
    await s.update("ports", cam2Poe.id, { poe_enabled: false });
    ck.eq(new PowerAnalysis(s).equipmentWarnings(cam2.id).some((w) => w.code === "poe_pd_unfed"), false, "POE non alimenté : port PD désactivé volontairement (poe_enabled:false) → pas d'alerte");
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
    // oklch : conversion PURE OKLCH→sRGB (tokens du thème depuis la revue design). Références :
    // blanc/noir exacts, rouge sRGB (couple OKLCH connu), et l'accent du thème = ORANGE (pas le repli bleu 3D).
    ck.eq(Color.cssToHex("oklch(1 0 0)"), 0xffffff, "Color.cssToHex(oklch blanc) → #ffffff");
    ck.eq(Color.cssToHex("oklch(0 0 0)"), 0x000000, "Color.cssToHex(oklch noir) → #000000");
    ck.eq(Color.cssToHex("oklch(0.6279554 0.2576833 29.2338851)"), 0xff0000, "Color.cssToHex(oklch rouge sRGB) → #ff0000");
    const accent = Color.cssToHex("oklch(0.72 0.175 50)");
    ck(isFinite(accent), "Color.cssToHex(oklch accent) → fini (plus de repli bleu du thème 3D)");
    ck(((accent >> 16) & 255) > ((accent >> 8) & 255) && ((accent >> 8) & 255) > (accent & 255), "Color.cssToHex(oklch accent) → dominante ORANGE (R > V > B)");
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

  await section("VmStatus : état d'une VM (statut + orphelinat) — SOURCE UNIQUE des trois anciens sites", async () => {
  {
    // La règle « orphelinat prime, running vert, stopped neutre, le reste tel quel » était RÉÉCRITE dans
    // `ListConfigs.vms`, `DetailForms.vmDetail` et `VmHostTip`. Les attentes ci-dessous sont EXPLICITES et
    // byte-exactes — dérivées de l'ANCIEN code REGÉNÉRÉ depuis git (`git show HEAD:…`), jamais retranscrit
    // de mémoire, et posées comme attentes littérales plutôt que comparées à la nouvelle fonction (sinon
    // elles compareraient une fonction à elle-même et resteraient vertes sans rien prouver).
    const vm = (status, orphan) => ({ status, orphan: !!orphan });

    // ---- PARITÉ EXACTE avec les pastilles de l'ancien LISTING (sans `title`).
    ck.eq(VmStatus.pills(vm("running")), '<span class="pill" style="border-color:var(--ok);color:var(--ok)">running</span>', "listing : running → pastille verte, à l'octet près");
    ck.eq(VmStatus.pills(vm("stopped")), '<span class="pill" style="border-color:var(--fg-dimmer);color:var(--fg-dim)">stopped</span>', "listing : stopped → bordure neutre + texte --fg-dim (les DEUX variables diffèrent, c'est voulu)");
    ck.eq(VmStatus.pills(vm("paused")), '<span class="pill">paused</span>', "listing : statut inconnu → pastille nue, mot du provider TEL QUEL");
    ck.eq(VmStatus.pills(vm("")), '<span style="color:var(--fg-dimmer)">—</span>', "listing : aucun statut → tiret discret (identique à `dim(\"—\")` et à `DetailForms.MUTED`)");
    ck.eq(VmStatus.pills(vm("running", true)), '<span class="pill" style="border-color:var(--err);color:var(--err)">orpheline</span> <span class="pill" style="border-color:var(--ok);color:var(--ok)">running</span>', "listing : orpheline EN TÊTE + statut conservé (espace séparatrice comprise)");

    // ---- PARITÉ EXACTE avec la FICHE : même sortie, plus l'infobulle sur la seule pastille « orpheline ».
    ck.eq(VmStatus.pills(vm("running"), "Disparue à la dernière synchronisation"), VmStatus.pills(vm("running")), "fiche : VM non orpheline → le `title` ne change RIEN (aucune pastille où le poser)");
    ck.eq(VmStatus.pills(vm("stopped", true), "Disparue à la dernière synchronisation"), '<span class="pill" style="border-color:var(--err);color:var(--err)" title="Disparue à la dernière synchronisation">orpheline</span> <span class="pill" style="border-color:var(--fg-dimmer);color:var(--fg-dim)">stopped</span>', "fiche : orpheline + `title` → attribut posé APRÈS le style, comme avant");

    // ---- CLASSIFICATION : ensemble fermé, l'orphelinat est une dimension INDÉPENDANTE du statut.
    ck.eq(VmStatus.kindOf(vm("running")), "running", "kindOf : running");
    ck.eq(VmStatus.kindOf(vm("stopped")), "stopped", "kindOf : stopped");
    ck.eq(VmStatus.kindOf(vm("paused")), "other", "kindOf : statut présent mais inconnu → 'other'");
    ck.eq(VmStatus.kindOf(vm("")), "none", "kindOf : statut absent → 'none' (≠ 'other')");
    ck.eq(VmStatus.kindOf(vm("running", true)), "running", "kindOf : l'orphelinat ne CONTAMINE pas la classification du statut");

    // ---- COULEURS de la bulle : 3 seulement, l'orphelinat prime (parité `VmHostTip.swatchColor` d'origine).
    ck.eq(VmStatus.swatchColor(vm("running")), "var(--ok)", "swatchColor : running → --ok");
    ck.eq(VmStatus.swatchColor(vm("stopped")), "var(--fg-dimmer)", "swatchColor : stopped → neutre (la bulle n'a pas la nuance du listing)");
    ck.eq(VmStatus.swatchColor(vm("running", true)), "var(--err)", "swatchColor : orpheline PRIME sur running");
    ck.eq(VmHostTip.swatchColor(vm("running", true)), VmStatus.swatchColor(vm("running", true)), "VmHostTip.swatchColor DÉLÈGUE (API conservée pour ses appelants 2D/3D)");

    // ---- TRI : orphelines groupées à part, puis alphabétique — parité avec `(v.orphan ? "1_" : "0_") + (v.status || "")`.
    ck.eq(VmStatus.sortKey(vm("running")), "0_running", "sortKey : non orpheline → préfixe '0_'");
    ck.eq(VmStatus.sortKey(vm("running", true)), "1_running", "sortKey : orpheline → préfixe '1_' (groupées en fin de tri croissant)");
    ck.eq(VmStatus.sortKey(vm("")), "0_", "sortKey : sans statut → préfixe seul");

    // ---- RECHERCHE : le mot « orpheline » était écrit EN DUR en français dans `ListConfigs.searchFields`.
    // Il passe par le catalogue → en interface anglaise, « orphan » (le mot AFFICHÉ) devient cherchable.
    ck.eq(VmStatus.searchTerms(vm("running", true)).join("|"), "running|orpheline", "searchTerms : statut + mot LOCALISÉ (catalogue fr)");
    ck.eq(VmStatus.searchTerms(vm("running")).join("|"), "running|", "searchTerms : non orpheline → terme vide (le champ de recherche les ignore)");

    // ---- ÉCHAPPEMENT : `status` est une donnée SOURCE d'un cluster tiers, posée en innerHTML.
    ck.eq(VmStatus.pills(vm("<img src=x onerror=alert(1)>")), '<span class="pill">&lt;img src=x onerror=alert(1)&gt;</span>', "statut hostile → ÉCHAPPÉ (aucune balise ne sort d'ici)");
    ck(VmStatus.pills(vm("\"><script>")).indexOf("<script>") < 0, "évasion d'attribut → neutralisée");

    // ---- CONVERGENCE ASSUMÉE au regroupement : le statut est désormais ROGNÉ partout. Avant, le listing et
    // la fiche comparaient la chaîne BRUTE — « running » espacé y tombait dans « inconnu » (pastille nue)
    // alors que la bulle le montrait vert. Aucun provider n'émet ça ; l'incohérence n'avait pas à survivre.
    ck.eq(VmStatus.raw({ status: "  running  " }), "running", "raw : statut rogné");
    ck.eq(VmStatus.kindOf({ status: "  running  " }), "running", "statut espacé → running aux TROIS endroits (était 'other' au listing et à la fiche)");

    // ---- TOLÉRANCE : les enregistrements viennent d'une synchro tierce, rien n'est présumé présent.
    ck.eq(VmStatus.kindOf(null), "none", "entrée null → 'none', aucune exception");
    ck.eq(VmStatus.kindOf(undefined), "none", "entrée undefined → 'none'");
    ck.eq(VmStatus.kindOf({}), "none", "objet sans statut → 'none'");
    ck.eq(VmStatus.kindOf({ status: 42 }), "none", "statut non-chaîne → 'none' (jamais coercé)");
    ck.eq(VmStatus.isOrphan({ orphan: "oui" }), true, "orphan truthy non booléen → normalisé en booléen");
  }
  });

  await section("VmHostTip : bloc « VMs hébergées » de la bulle d'équipement (tri, bornage, échappement)", async () => {
  {
    // Fabrique de pastille INJECTÉE — l'appelant réel passe `DcInteract.tipSwatch` ; ici un marqueur
    // reconnaissable qui laisse la COULEUR visible dans la sortie (c'est elle qu'on veut vérifier).
    const sw = (color) => "[SW:" + color + "]";
    const vm = (name, status, orphan) => ({ name, status, orphan: !!orphan });

    // --- AUCUNE VM → AUCUNE ligne : la bulle d'un équipement sans VM doit rester STRICTEMENT inchangée
    //     (pas de section vide, pas de « 0 VM »). C'est l'exigence n°1 du lot. ---
    ck.eq(VmHostTip.rows([], sw).length, 0, "rows : liste vide → aucune ligne (bulle inchangée)");
    ck.eq(VmHostTip.rows(null, sw).length, 0, "rows : null → aucune ligne (tolérant)");
    ck.eq(VmHostTip.rows(undefined, sw).length, 0, "rows : undefined → aucune ligne (tolérant)");
    ck.eq(VmHostTip.rows("pas un tableau", sw).length, 0, "rows : entrée non-tableau → aucune ligne (tolérant)");
    ck.eq(VmHostTip.rows([null, undefined], sw).length, 0, "rows : que des trous → aucune ligne");

    // --- UNE VM : ligne de TÊTE (compte, singulier) + une ligne par VM ---
    const one = VmHostTip.rows([vm("srv-web-01", "running")], sw);
    ck.eq(one.length, 2, "rows : 1 VM → 2 lignes (tête + VM)");
    ck.eq(one[0], "1 VM hébergée", "rows : ligne de tête au SINGULIER (catalogue fr)");
    ck.eq(one[1], "[SW:var(--ok)]srv-web-01 <span style=\"color:var(--fg-dimmer)\">· running</span>", "rows : pastille injectée + nom + statut BRUT");

    // --- TRI par nom, STABLE : l'ordre d'entrée ne doit jamais transparaître dans la bulle ---
    const sorted = VmHostTip.rows([vm("zeta", "running"), vm("alpha", "running"), vm("Mid", "running")], sw);
    ck.eq(sorted[0], "3 VMs hébergées", "rows : ligne de tête au PLURIEL (3 VMs)");
    ck(sorted[1].indexOf("alpha") >= 0 && sorted[2].indexOf("Mid") >= 0 && sorted[3].indexOf("zeta") >= 0, "rows : VMs triées par nom (alpha < Mid < zeta)");

    // --- STATUTS : pastille par ensemble FERMÉ de couleurs, mot du provider affiché TEL QUEL ---
    const stopped = VmHostTip.rows([vm("s1", "stopped")], sw);
    ck.eq(stopped[1], "[SW:var(--fg-dimmer)]s1 <span style=\"color:var(--fg-dimmer)\">· stopped</span>", "rows : stopped → pastille neutre + mot brut");
    const unknown = VmHostTip.rows([vm("s2", "paused")], sw);
    ck.eq(unknown[1], "[SW:var(--fg-dimmer)]s2 <span style=\"color:var(--fg-dimmer)\">· paused</span>", "rows : statut INCONNU toléré, affiché tel quel (releases Proxmox)");
    const noStatus = VmHostTip.rows([vm("s3", "")], sw);
    ck.eq(noStatus[1], "[SW:var(--fg-dimmer)]s3", "rows : statut absent → nom seul (pas de suffixe vide)");
    const orphan = VmHostTip.rows([vm("s4", "running", true)], sw);
    ck.eq(orphan[1], "[SW:var(--err)]s4 <span style=\"color:var(--fg-dimmer)\">· orpheline · running</span>", "rows : orpheline PRIME sur le statut (pastille rouge + mention en tête du suffixe)");
    ck.eq(VmHostTip.swatchColor({ status: "running" }), "var(--ok)", "swatchColor : running → var(--ok)");
    ck.eq(VmHostTip.swatchColor({ status: "running", orphan: true }), "var(--err)", "swatchColor : orpheline prime sur running");
    ck.eq(VmHostTip.swatchColor({}), "var(--fg-dimmer)", "swatchColor : sans statut → neutre");

    // --- NOM absent → placeholder de listing (« (VM) »), jamais une ligne muette ---
    ck.eq(VmHostTip.rows([{ status: "running" }], sw)[1], "[SW:var(--ok)](VM) <span style=\"color:var(--fg-dimmer)\">· running</span>", "rows : nom absent → placeholder « (VM) »");
    ck.eq(VmHostTip.rows([vm("  espace  ", "")], sw)[1], "[SW:var(--fg-dimmer)]espace", "rows : nom rogné (trim)");

    // --- BORNAGE : au-delà de la limite, une dernière ligne porte le RESTE ; la tête garde le TOTAL ---
    const five = [vm("a", "running"), vm("b", "running"), vm("c", "running"), vm("d", "running"), vm("e", "running")];
    const capped = VmHostTip.rows(five, sw, 3);
    ck.eq(capped.length, 5, "bornage : limite 3 sur 5 VMs → 5 lignes (tête + 3 noms + reste)");
    ck.eq(capped[0], "5 VMs hébergées", "bornage : la ligne de tête porte le TOTAL, pas le nombre affiché");
    ck.eq(capped[4], "<span style=\"color:var(--fg-dimmer)\">… et 2 autres</span>", "bornage : ligne de reste « … et 2 autres »");
    ck(capped[1].indexOf("a") >= 0 && capped[3].indexOf("c") >= 0, "bornage : ce sont les 3 PREMIÈRES du tri qui sont nommées");
    const capped1 = VmHostTip.rows(five, sw, 4);
    ck.eq(capped1[5], "<span style=\"color:var(--fg-dimmer)\">… et 1 autre</span>", "bornage : reste au SINGULIER (« … et 1 autre »)");
    ck.eq(VmHostTip.rows(five, sw, 5).length, 6, "bornage : limite = total → aucune ligne de reste");
    ck.eq(VmHostTip.rows(five, sw, 9).length, 6, "bornage : limite > total → aucune ligne de reste");
    ck.eq(VmHostTip.rows(five, sw, 0).length, 3, "bornage : limite < 1 ramenée à 1 (tête + 1 nom + reste)");

    // --- LIMITE PAR DÉFAUT : valeur EN DUR (le seul endroit à retoucher pour rallonger la bulle) ---
    ck.eq(VmHostTip.MAX_LISTED, 8, "MAX_LISTED : borne d'affichage par défaut = 8");
    const nine = [];
    for (let i = 1; i <= 9; i++) nine.push(vm("vm-" + i, "running"));
    const byDefault = VmHostTip.rows(nine, sw);
    ck.eq(byDefault.length, 10, "défaut : 9 VMs → tête + 8 noms + reste = 10 lignes");
    ck.eq(byDefault[9], "<span style=\"color:var(--fg-dimmer)\">… et 1 autre</span>", "défaut : la 9e VM bascule dans le reste");

    // --- ÉCHAPPEMENT — LE point à ne pas rater : un nom et un statut de VM sont des données SOURCE
    //     (cluster tiers) posées en innerHTML par `showTip`. Aucune balise ne doit pouvoir naître. ---
    const hostile = VmHostTip.rows([{ name: '<img src=x onerror="alert(1)">', status: "<b>run</b>" }], sw);
    ck.eq(hostile[1].indexOf("<img"), -1, "échappement : aucun <img ne survit dans la ligne");
    ck.eq(hostile[1].indexOf("<b>"), -1, "échappement : aucune balise <b> ne naît d'un STATUT hostile");
    ck(hostile[1].indexOf("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;") >= 0, "échappement : le nom hostile est rendu en ENTITÉS (lisible, inerte)");
    ck(hostile[1].indexOf("&lt;b&gt;run&lt;/b&gt;") >= 0, "échappement : le statut hostile est rendu en ENTITÉS");
    // Sortie de l'attribut `style` par une apostrophe/guillemet : impossible, la couleur ne vient JAMAIS
    // de la donnée (ensemble fermé de constantes) et le nom est échappé avant d'y arriver.
    const quoted = VmHostTip.rows([{ name: '" onmouseover="alert(1)', status: "running" }], sw);
    ck.eq(quoted[1].indexOf('" onmouseover='), -1, "échappement : un guillemet du nom ne peut pas ouvrir un attribut");
    ck(quoted[1].indexOf("&quot; onmouseover=&quot;alert(1)") >= 0, "échappement : guillemets du nom convertis en entités");
    ck.eq(quoted[1].indexOf("[SW:var(--ok)]"), 0, "pastille : couleur issue de constantes internes, jamais de la donnée");
  }
  });

  await section("Store.vmsOfHost : VMs hébergées par un équipement (index host_equipment_id)", async () => {
  {
    const s = await makeStore();
    const host = await s.create("equipments", { name: "hyperviseur-1" });
    const other = await s.create("equipments", { name: "hyperviseur-2" });
    const v1 = await s.create("vms", { name: "web", ext_id: "c/100", host_equipment_id: host.id });
    await s.create("vms", { name: "db", ext_id: "c/101", host_equipment_id: other.id });
    await s.create("vms", { name: "sans-hote", ext_id: "c/102" });

    ck.eq(s.vmsOfHost(host.id).length, 1, "vmsOfHost : 1 VM hébergée par l'hôte");
    ck.eq(s.vmsOfHost(host.id)[0].id, v1.id, "vmsOfHost : c'est bien la VM rattachée");
    ck.eq(s.vmsOfHost(other.id).length, 1, "vmsOfHost : l'autre hôte a la sienne (pas de fuite entre hôtes)");
    ck.eq(s.vmsOfHost("inconnu").length, 0, "vmsOfHost : équipement sans VM → [] (donc bulle inchangée)");
    // L'index SECONDAIRE est ce qui rend la lecture bon marché au survol : sans lui, `_byFk` retomberait
    // en balayage de la collection à CHAQUE mouvement de souris.
    ck(s._fk.vms && s._fk.vms.has("host_equipment_id"), "vmsOfHost : le champ est bien INDEXÉ (pas de balayage)");
    // Cascade : supprimer l'hôte DÉTACHE la VM (elle n'est pas supprimée) → elle sort de la bulle.
    await s.remove("equipments", host.id);
    ck.eq(s.vmsOfHost(host.id).length, 0, "vmsOfHost : hôte supprimé → plus aucune VM hébergée (VM détachée, pas supprimée)");
    ck.eq(s.get("vms", v1.id).host_equipment_id, null, "cascade : la VM survit, host_equipment_id détaché");
  }
  });

  await section("Locatable : la règle « cet objet est-il LOCALISABLE ? », écrite UNE fois", async () => {
  {
    /* La règle NUE, éprouvée sur des chaînes de conteneurs construites à la main : deux branches, et le
       piège central du lot est la SECONDE. `!!equipmentContainer(x)` — « a-t-il un conteneur ? » — serait
       un prédicat FAUX : une baie hors salle en fournit un, et un posé d'ÉTAGE d'un bâtiment sans salle
       aussi, alors que ni l'un ni l'autre n'est atteignable par la vue. Cf. `docs/placement.md` §6.28. */
    const bâtimentsPeuplés = new Set(["liege"]);
    const scope = { get: () => null, roomsOfBuilding: (loc) => (bâtimentsPeuplés.has(loc) ? [{ id: "dc-1" }] : []) };

    ck.eq(Locatable.ofChain([], scope), false, "chaîne VIDE (pool, inventaire pur) → NON localisable");
    ck.eq(Locatable.ofChain([{ kind: "room", id: "dc-1" }], scope), true, "salle en tête → localisable");
    ck.eq(Locatable.ofChain([{ kind: "rack", id: "r1" }, { kind: "room", id: "dc-1" }, { kind: "floor", location: "liege", floor: "0" }], scope), true,
      "baie POSÉE en salle : la salle est PLUS LOIN dans la chaîne, et compte quand même");
    ck.eq(Locatable.ofChain([{ kind: "tray", id: "t1" }, { kind: "rack", id: "r1" }, { kind: "building", location: "liege" }], scope), false,
      "étagère d'une baie HORS salle : la chaîne existe mais ne traverse AUCUNE salle → NON localisable");
    ck.eq(Locatable.ofChain([{ kind: "rack", id: "r1" }, { kind: "building", location: "liege" }], scope), false,
      "baie hors salle : un CONTENEUR ne suffit pas — c'est tout l'écart avec `!!equipmentContainer`");
    // La branche ÉTAGE : elle DÉPEND du modèle (le bâtiment a-t-il une salle ?), pas du seul conteneur.
    ck.eq(Locatable.ofChain([{ kind: "floor", location: "liege", floor: "1" }, { kind: "building", location: "liege" }], scope), true,
      "posé d'étage, bâtiment AYANT une salle → localisable (la portée peut l'atteindre)");
    ck.eq(Locatable.ofChain([{ kind: "floor", location: "namur", floor: "0" }, { kind: "building", location: "namur" }], scope), false,
      "posé d'étage, bâtiment SANS salle → NON localisable (la portée s'exprime en salles — l'action REFUSE)");
    ck.eq(Locatable.ofChain([{ kind: "building", location: "liege" }], scope), false,
      "conteneur BÂTIMENT seul (jamais produit aujourd'hui) → NON localisable : rien de plus fin à viser");

    /* TOLÉRANCE des deux adaptateurs (mêmes contrats que les anciens `equipmentDcId`/`portDcId`, RETIRÉS
       au lot 7 / §6.33 : id OU enregistrement, et référence pendante rendue `false` plutôt que levée).
       Les mentions de ce trio, ici et dans les messages ci-dessous, sont HISTORIQUES : elles disent d'où
       vient la règle, elles ne désignent plus rien qu'on puisse aller lire. */
    const docs = { equipments: { "eq-1": { id: "eq-1", placement_mode: "manual", dim_mode: "free", dc_id: "dc-1" } }, ports: { "p-1": { id: "p-1", equipment_id: "eq-1" }, "p-orph": { id: "p-orph", equipment_id: "eq-disparu" } } };
    const store = { get: (coll, id) => (docs[coll] ? (docs[coll][id] || null) : null), roomsOfBuilding: () => [] };
    ck.eq(Locatable.equipment("eq-1", store), true, "équipement par ID → lu dans le store");
    ck.eq(Locatable.equipment(docs.equipments["eq-1"], store), true, "équipement par ENREGISTREMENT → aucune relecture (parité `equipmentDcId`)");
    ck.eq(Locatable.equipment("eq-disparu", store), false, "équipement inexistant → false (et non une exception)");
    ck.eq(Locatable.equipment(null, store), false, "équipement null → false (tolérant)");
    ck.eq(Locatable.port("p-1", store), true, "port → règle de son ÉQUIPEMENT porteur");
    ck.eq(Locatable.port("p-orph", store), false, "port dont l'équipement a disparu → false");
    ck.eq(Locatable.port(null, store), false, "port null → false (tolérant)");

    /* ---- LIAISONS (câbles) : `cableEnd` est LA RÈGLE, `cable` n'en est que le constat (§6.32) ----
       Ce qu'on cadre, ce n'est pas « le câble » (il n'a pas de placement) mais UNE de ses extrémités.
       Écrire le prédicat ailleurs que le choix de cette extrémité, c'est rouvrir le bouton MORT (D6).
       La priorité « A puis B » est héritée de l'ancien `cableDcId` (RETIRÉ, §6.33) : les messages qui le
       citent ci-dessous rappellent cette filiation, ils ne renvoient plus à du code existant. */
    const dEq = {
      "eq-salle": { id: "eq-salle", placement_mode: "manual", dim_mode: "free", dc_id: "dc-1" },
      "eq-salle2": { id: "eq-salle2", placement_mode: "manual", dim_mode: "free", dc_id: "dc-2" },
      "eq-etage": { id: "eq-etage", placement_mode: "floor", dim_mode: "free", location: "liege", floor: "1" },
      "eq-etage-nu": { id: "eq-etage-nu", placement_mode: "floor", dim_mode: "free", location: "namur", floor: "0" },
      "eq-hors-salle": { id: "eq-hors-salle", placement_mode: "rack", rack_id: "rk-nu", rack_u: 3 },
      "eq-rien": { id: "eq-rien", placement_mode: "manual", dim_mode: "free" },
    };
    const dPorts = {}; Object.keys(dEq).forEach((k) => { dPorts["p-" + k] = { id: "p-" + k, equipment_id: k }; });
    const dCables = {
      "c-salle-salle": { id: "c-salle-salle", from_port_id: "p-eq-salle", to_port_id: "p-eq-salle2" },
      "c-rien-salle": { id: "c-rien-salle", from_port_id: "p-eq-rien", to_port_id: "p-eq-salle2" },
      "c-horsSalle-salle": { id: "c-horsSalle-salle", from_port_id: "p-eq-hors-salle", to_port_id: "p-eq-salle2" },
      "c-etage-rien": { id: "c-etage-rien", from_port_id: "p-eq-etage", to_port_id: "p-eq-rien" },
      "c-salle-etage": { id: "c-salle-etage", from_port_id: "p-eq-salle", to_port_id: "p-eq-etage" },
      "c-etageNu-salle": { id: "c-etageNu-salle", from_port_id: "p-eq-etage-nu", to_port_id: "p-eq-salle2" },
      "c-rien-rien": { id: "c-rien-rien", from_port_id: "p-eq-rien", to_port_id: null },
      "c-vide": { id: "c-vide", from_port_id: null, to_port_id: null },
    };
    const bancs = { equipments: dEq, ports: dPorts, cables: dCables, racks: { "rk-nu": { id: "rk-nu", location: "liege" } } };
    const sL = { get: (coll, id) => (bancs[coll] ? (bancs[coll][id] || null) : null), roomsOfBuilding: (loc) => (bâtimentsPeuplés.has(loc) ? [{ id: "dc-1" }] : []) };

    ck.eq(Locatable.cableEnd("c-salle-salle", sL), "p-eq-salle", "deux bouts placés → l'extrémité A est RETENUE (priorité historique de `cableDcId`)");
    ck.eq(Locatable.cableEnd("c-rien-salle", sL), "p-eq-salle2", "bout A non placé → on passe à B, on ne s'arrête pas dessus");
    ck.eq(Locatable.cableEnd("c-horsSalle-salle", sL), "p-eq-salle2",
      "bout A dans une baie HORS SALLE : il a un CONTENEUR mais n'est pas atteignable → B retenu (parité stricte avec `cableDcId`)");
    ck.eq(Locatable.cableEnd("c-etage-rien", sL), "p-eq-etage", "bout A posé sur un ÉTAGE atteignable → retenu (l'ancien rendait null : bouton caché)");
    ck.eq(Locatable.cableEnd("c-salle-etage", sL), "p-eq-salle", "salle en A, étage en B → A reste retenu : la généralisation ne DÉPLACE pas un cadrage existant");
    ck.eq(Locatable.cableEnd("c-etageNu-salle", sL), "p-eq-salle2", "étage d'un bâtiment SANS salle en A → non atteignable, B retenu");
    ck.eq(Locatable.cableEnd("c-rien-rien", sL), null, "aucun bout atteignable → aucune extrémité");
    ck.eq(Locatable.cableEnd("c-vide", sL), null, "câble sans aucun port → aucune extrémité (et non une exception)");
    ck.eq(Locatable.cableEnd("c-inexistant", sL), null, "câble inconnu → null (tolérant)");
    ck.eq(Locatable.cableEnd(dCables["c-salle-salle"], sL), "p-eq-salle", "liaison par ENREGISTREMENT → aucune relecture (parité `cableDcId`)");

    /* Le PRÉDICAT : attente ÉCRITE cas par cas (colonne 2), PUIS l'équivalence avec la règle (colonne
       « existe-t-il une extrémité retenue ? »). Les deux, et pas seulement la seconde : épinglée à la
       règle seule, l'assertion resterait verte si `cable` était réécrit à l'identique DE TRAVERS. */
    const attentes = [
      ["c-salle-salle", true], ["c-rien-salle", true], ["c-horsSalle-salle", true],
      ["c-etage-rien", true],       // ⚠ NOUVEAU : `!!cableDcId` rendait false — bouton caché sur un câble atteignable
      ["c-salle-etage", true], ["c-etageNu-salle", true],
      ["c-rien-rien", false], ["c-vide", false],
    ];
    let cablesVus = 0;
    for (const [id, attendu] of attentes) {
      cablesVus++;
      ck.eq(Locatable.cable(id, sL), attendu, `prédicat de liaison — ${id}`);
      ck.eq(Locatable.cable(id, sL), Locatable.cableEnd(id, sL) !== null,
        `…et il est le CONSTAT de la règle, pas une seconde écriture — ${id}`);
    }
    ck.eq(cablesVus, 8, "les huit liaisons du banc ont bien été jouées (garde anti-boucle vide)");
  }
  });

  await section("ContainerLabel : « comment s'appelle l'endroit de cet objet ? » — le mot JUSTE selon le conteneur", async () => {
  {
    /* ---- 1. LA RÈGLE NUE, sur des chaînes construites à la main ----
       Trois branches : salle DE LA CHAÎNE (pas conteneur immédiat), étage EN TÊTE, sinon rien. */
    ck.eq(ContainerLabel.namedOfChain([]), null, "chaîne VIDE (pool, inventaire pur) → aucun conteneur à nommer");
    ck.eq(JSON.stringify(ContainerLabel.namedOfChain([{ kind: "room", id: "dc-1" }])), JSON.stringify({ kind: "room", id: "dc-1" }), "salle en tête → c'est elle");
    // LE point du module : le conteneur IMMÉDIAT d'un serveur monté est sa BAIE, et l'utilisateur veut
    // pourtant lire « Salle A ». Rendre le conteneur immédiat serait une RÉGRESSION déguisée.
    ck.eq(JSON.stringify(ContainerLabel.namedOfChain([{ kind: "rack", id: "r1" }, { kind: "room", id: "dc-1" }, { kind: "floor", location: "liege", floor: "0" }])),
      JSON.stringify({ kind: "room", id: "dc-1" }), "baie POSÉE en salle : c'est la SALLE qu'on nomme, pas la baie ni l'étage plus loin");
    ck.eq(JSON.stringify(ContainerLabel.namedOfChain([{ kind: "tray", id: "t1" }, { kind: "rack", id: "r1" }, { kind: "room", id: "dc-1" }, { kind: "floor", location: "liege", floor: "0" }])),
      JSON.stringify({ kind: "room", id: "dc-1" }), "posé sur étagère (TROIS conteneurs emboîtés) : toujours la SALLE");
    ck.eq(JSON.stringify(ContainerLabel.namedOfChain([{ kind: "floor", location: "liege", floor: "1" }, { kind: "building", location: "liege" }])),
      JSON.stringify({ kind: "floor", location: "liege", floor: "1" }), "posé d'ÉTAGE : l'étage IMMÉDIAT est le conteneur nommé");
    ck.eq(ContainerLabel.namedOfChain([{ kind: "rack", id: "r1" }, { kind: "building", location: "liege" }]), null,
      "baie HORS salle : rien de nommable — parité EXACTE avec l'ancien `equipmentDcId` (arbitrage §6.29, pas un oubli)");
    ck.eq(ContainerLabel.namedOfChain([{ kind: "tray", id: "t1" }, { kind: "rack", id: "r1" }, { kind: "building", location: "liege" }]), null,
      "étagère d'une baie hors salle : rien de nommable non plus");

    /* ---- 2. LE LIBELLÉ, sur un store STUB (les replis de `dcName` sont HÉRITÉS, pas recopiés) ---- */
    const stub = {
      get: () => null,
      dcName: (id) => (id === "dc-1" ? "Salle A" : (id === "dc-nue" ? "(salle)" : "?")),
      siteLabel: (id) => (id === "liege" ? "Bât. Liège" : id),
    };
    ck.eq(ContainerLabel.label(null, stub), null, "libellé d'AUCUN conteneur → null (le repli d'absence appartient à l'appelant)");
    ck.eq(ContainerLabel.label({ kind: "room", id: "dc-1" }, stub), "Salle A", "SALLE → exactement ce que `dcName` rendait");
    ck.eq(ContainerLabel.label({ kind: "room", id: "dc-nue" }, stub), "(salle)", "SALLE sans nom → repli « (salle) » HÉRITÉ de `dcName`, non recopié ici");
    ck.eq(ContainerLabel.label({ kind: "room", id: "zzz" }, stub), "?", "SALLE introuvable → repli « ? » hérité de `dcName`");
    ck.eq(ContainerLabel.label({ kind: "floor", location: "liege", floor: "1" }, stub), "Bât. Liège · ét. 1", "ÉTAGE → « bâtiment · étage » (l'identité d'un étage EST ce couple)");
    // ⚠ LE REZ-DE-CHAUSSÉE DOIT S'AFFICHER. Mesure du lot, contre-intuitive : le piège `String(x || "")`
    // du dépôt ne mord PAS sur ce calcul-ci (une sonde de mutation l'a prouvé — le repli `isFinite ? : 0`
    // ramène l'un et l'autre à 0). Il mord sur la CLÉ, pas sur l'affichage ; ces deux attentes verrouillent
    // donc le RENDU, et c'est `countLabel` qui verrouille la distinction des clés « 0 » / « ».
    ck.eq(ContainerLabel.label({ kind: "floor", location: "liege", floor: "0" }, stub), "Bât. Liège · ét. 0", "ÉTAGE 0 (rez-de-chaussée) → « ét. 0 », ni « ét. » ni disparu");
    ck.eq(ContainerLabel.label({ kind: "floor", location: "liege", floor: "" }, stub), "Bât. Liège · ét. 0", "ÉTAGE vide → niveau 0 (convention unique de l'app)");
    ck.eq(ContainerLabel.label({ kind: "floor", location: "liege", floor: "-1" }, stub), "Bât. Liège · ét. -1", "ÉTAGE négatif (sous-sol) → conservé");
    ck.eq(ContainerLabel.label({ kind: "floor", location: "namur", floor: "2" }, stub), "namur · ét. 2", "ÉTAGE d'un site sans entité → `siteLabel` replie sur l'id, comme partout");
    ck.eq(ContainerLabel.label({ kind: "rack", id: "r1" }, stub), null, "BAIE en conteneur nommé : jamais produit par la règle, et rien à nommer si on l'y force");
    ck.eq(ContainerLabel.label({ kind: "building", location: "liege" }, stub), null, "BÂTIMENT : idem — nommer un bâtiment changerait des libellés existants (§6.29)");

    /* ---- 3. ANTI-DIVERGENCE de la normalisation d'étage ----
       `ContainerLabel.floorNumber` DUPLIQUE `FloorLayout.floorNum` (inversion de couche core → geometry
       refusée). Une duplication acceptée doit être VERROUILLÉE, sinon elle diverge en silence. */
    ["0", "1", "-1", "", "2.5", "  3  ", "sous-sol", null, undefined, 0, 4, -2].forEach((v) => {
      ck.eq(ContainerLabel.floorNumber(v), FloorLayout.floorNum(v), "floorNumber ≡ FloorLayout.floorNum sur " + JSON.stringify(v));
    });

    /* ---- 4. INTÉGRATION sur un VRAI Store : un cas par MODE DE PLACEMENT ----
       Deux mesures par cas, comparées ENTRE ELLES : le libellé NOUVEAU, et l'expression HISTORIQUE
       (`dc ? dcName(dc) : null`) régénérée telle quelle. Une attente EN DUR accompagne chacune — sans
       elle, une dérive SIMULTANÉE des deux côtés passerait au vert (leçon du lot précédent). */
    const s = await makeStore();
    const site = await s.create("sites", { name: "Bât. Liège" });
    const dc = await s.create("datacenters", { name: "Salle A", location: site.id, floor: "0" });
    const rack = await s.create("racks", { name: "R1", width_mm: 600, depth: 1000, u_count: 42, datacenter_id: dc.id, dc_x: 500, dc_y: 500 });
    const rackHorsSalle = await s.create("racks", { name: "R-pool", width_mm: 600, depth: 1000, u_count: 42, location: site.id });
    const tray = await s.create("rackItems", { rack_id: rack.id, kind: "tray", side: "front", u: 10, u_height: 2 });
    /* Expression HISTORIQUE, telle qu'elle était écrite dans les six sites migrés (cf. `git show`) :
       `dcName(equipmentDcId(x))`. `Store.equipmentDcId` étant RETIRÉ (§6.33), sa projection est
       transcrite ici — et DÉLIBÉRÉMENT depuis `PlacementContainers.chain`, PAS depuis
       `equipmentNamedContainer` : ce dernier passe par `ContainerLabel.namedOfChain`, c'est-à-dire par
       la fonction MÊME que cette section éprouve. L'oracle serait alors une comparaison de la règle
       avec elle-même, verte quoi qu'il arrive. */
    const salleHistorique = (e) => { const r = PlacementContainers.chain(e, (coll, id) => s.get(coll, id)).find((c) => c.kind === "room"); return r ? r.id : null; };
    const ancien = (e) => { const d = salleHistorique(e); return d ? s.dcName(d) : null; };

    let k = 0;
    const cas = async (libelle, placement, attendu, memeQuAvant) => {
      const eq = await s.create("equipments", Object.assign({ name: "eq-" + (++k) }, placement));
      ck.eq(s.equipmentContainerLabel(eq.id), attendu, "libellé — " + libelle);
      // La comparaison des DEUX MESURES : c'est elle qui prouve qu'on n'a rien déplacé (ou qu'on l'a
      // déplacé EXPRÈS pour le seul mode `floor`).
      if (memeQuAvant) ck.eq(s.equipmentContainerLabel(eq.id), ancien(eq), "PARITÉ avec l'expression historique — " + libelle);
      else ck(s.equipmentContainerLabel(eq.id) !== ancien(eq), "DIVERGENCE VOULUE de l'expression historique — " + libelle);
      return eq;
    };
    await cas("monté en baie (rack + rack_u)", { placement_mode: "rack", rack_id: rack.id, rack_u: 5 }, "Salle A", true);
    await cas("libre positionné en salle", { placement_mode: "manual", dim_mode: "free", dc_id: dc.id, dc_x: 100, dc_y: 100 }, "Salle A", true);
    await cas("en marge latérale d'une baie", { placement_mode: "side", rack_id: rack.id }, "Salle A", true);
    await cas("en paroi d'une baie", { placement_mode: "wall", rack_id: rack.id }, "Salle A", true);
    await cas("posé sur une étagère", { placement_mode: "tray", dim_mode: "free", tray_item_id: tray.id, tray_x: 10, tray_y: 10, free_w_mm: 100, free_l_mm: 100, free_h_mm: 40 }, "Salle A", true);
    await cas("libre SANS salle (inventaire pur)", { placement_mode: "manual", dim_mode: "free" }, null, true);
    await cas("en POOL d'une baie (rack_id SANS rack_u)", { placement_mode: "rack", rack_id: rack.id }, null, true);
    await cas("monté dans une baie HORS salle", { placement_mode: "rack", rack_id: rackHorsSalle.id, rack_u: 3 }, null, true);
    // ⚠ LE SEUL CHANGEMENT DE COMPORTEMENT DU LOT, et il est le BUT : ces deux-là s'annonçaient
    // « non placé » alors qu'ils sont posés sur un étage parfaitement identifié (décision D4).
    await cas("posé sur un ÉTAGE (ét. 1)", { placement_mode: "floor", location: site.id, floor: "1", floor_x: 200, floor_y: 300 }, "Bât. Liège · ét. 1", false);
    await cas("posé sur un ÉTAGE au REZ-DE-CHAUSSÉE (ét. 0)", { placement_mode: "floor", location: site.id, floor: "0", floor_x: 10, floor_y: 20 }, "Bât. Liège · ét. 0", false);
    // Un posé d'étage d'un bâtiment SANS AUCUNE SALLE se NOMME quand même : nommer n'est pas localiser.
    // C'est la frontière avec `Locatable`, et elle se vérifie en mesurant les DEUX sur le MÊME objet.
    const orphelin = await s.create("equipments", { name: "eq-namur", placement_mode: "floor", location: "namur", floor: "3", floor_x: 5, floor_y: 5 });
    ck.eq(s.equipmentContainerLabel(orphelin.id), "namur · ét. 3", "posé d'étage d'un bâtiment SANS salle → NOMMÉ malgré tout");
    ck.eq(s.equipmentLocatable(orphelin.id), false, "…et pourtant NON localisable : `ContainerLabel` et `Locatable` répondent à DEUX questions");

    // Tolérances (mêmes contrats que l'ancien `equipmentDcId`) + point d'entrée « conteneur » du mini-graphe.
    ck.eq(s.equipmentContainerLabel("eq-disparu"), null, "équipement inexistant → null (et non une exception)");
    ck.eq(s.equipmentContainerLabel(null), null, "équipement null → null (tolérant)");
    ck.eq(s.containerLabel(null), null, "containerLabel(null) → null");
    ck.eq(JSON.stringify(s.equipmentNamedContainer(orphelin.id)), JSON.stringify({ kind: "floor", location: "namur", floor: "3" }),
      "equipmentNamedContainer : le CONTENEUR lui-même (ce que consomme le mini-graphe de tracé)");
  }
  });

  await section("WebglHostVisibility : l'hôte 3D visible SEULEMENT en 3D-WebGL AVEC une salle (dette n°7)", async () => {
  {
    /* La règle NUE, table de vérité complète. Ce verrou est le SEUL possible : `DcBase.render()` sort
       d'emblée sur `typeof document === "undefined"` (Node sans DOM), donc la décision devait sortir
       dans un module PUR pour être testable — c'est tout l'objet de la dette n°7. */
    const V = WebglHostVisibility;
    // LE cas fautif que corrige la dette n°7 : 3D-WebGL mais AUCUNE salle → hôte MASQUÉ (avant, le canevas
    // du document précédent restait affiché sous le message « Aucune salle »).
    ck.eq(V.visible("3d", true, false), false, "3D-WebGL SANS salle → MASQUÉ (le correctif ; c'est ce cas qui rougit si on retire `hasRoom`)");
    // Cas nominal, INCHANGÉ : une 3D-WebGL avec une salle montre bien son canevas.
    ck.eq(V.visible("3d", true, true), true, "3D-WebGL AVEC salle → VISIBLE (comportement nominal préservé)");
    // Moteur legacy SVG (useWebGL = false) : l'hôte Three est démonté ailleurs, jamais montré.
    ck.eq(V.visible("3d", false, true), false, "3D LEGACY (SVG) → hôte WebGL MASQUÉ, salle ou pas");
    ck.eq(V.visible("3d", false, false), false, "3D LEGACY sans salle → MASQUÉ");
    // Vue Dessus (2D SVG) : jamais l'hôte WebGL, quelle que soit la présence de salle.
    ck.eq(V.visible("top", true, true), false, "vue DESSUS → MASQUÉ (rendu 2D SVG)");
    ck.eq(V.visible("top", true, false), false, "vue DESSUS sans salle → MASQUÉ");
    // Vue Étage (« floor ») : rendu 2D également ; c'est pourquoi l'étage cible n'ENTRE PAS dans la règle
    // (la « Vue étage 3D » empilée est une vue « 3d » avec multiDc, pas la vue « floor »). Cette branche
    // n'était PAS touchée par le bug — la ligne `view === "3d"` la masquait déjà — et le reste vérifié.
    ck.eq(V.visible("floor", true, true), false, "vue ÉTAGE (2D) → MASQUÉ même avec une salle (l'étage cible n'est pas un paramètre)");
    ck.eq(V.visible("floor", true, false), false, "vue ÉTAGE sans salle → MASQUÉ");
  }
  });

  await section("OptionSearch : le sélecteur d'entité à RECHERCHE filtre sans jamais RECLASSER (dette n°8)", async () => {
  {
    /* Ce que ce verrou protège : la bascule `<select>` → sélecteur à recherche ne doit changer NI les
       options proposées, NI leur ORDRE, NI leurs libellés, NI leur état `disabled`. Les fonctions qui
       CONSTRUISENT ces listes (`CableForms.eqOpts`/`portOpts`/`patchEndpointOpts`) n'ont pas bougé d'une
       ligne — le diff sur elles est VIDE, ce qui est la meilleure preuve possible de parité de la RÈGLE.
       Reste à verrouiller le CONTRÔLE, c'est-à-dire ce module : c'est la SEULE logique nouvelle du lot.
       `render()` et les nœuds DOM ne sont pas testables ici (Node sans DOM), d'où l'extraction. */
    const norm = SharedSchema.normSearch;
    const ids = (list) => list.map((o) => o.value).join(",");

    /* Liste TÉMOIN calquée sur la sortie réelle de `CableForms.portOpts` : option de TÊTE (valeur vide),
       ports libres triés alphabétiquement, puis les OCCUPÉS rejetés en FIN de liste, `disabled` et
       nommant le câble qui les occupe (doctrine §6.29). L'accent d'« Éth1 » et le libellé de brin de
       trunk sont là exprès : ils éprouvent la normalisation et le cas breakout. */
    const ports = [
      { value: "", label: "— Choisir le port —" },
      { value: "p-a", label: "Eth0 · RJ45 · Uplink" },
      { value: "p-b", label: "Éth1 · RJ45 · Accès" },
      { value: "p-c", label: "SFP1 · LC · Accès · brin de TRUNK-1" },
      { value: "p-z", label: "Eth9 · RJ45 · Accès — occupé par SW-1 : Gi0/1", disabled: true },
    ];

    // --- 1. Saisie VIDE = parcourir la liste entière, comme on déroulait un <select> ---
    const tout = OptionSearch.filter(ports, "", { normalize: norm });
    ck.eq(ids(tout.shown), "p-a,p-b,p-c,p-z", "saisie vide → TOUTES les options, dans l'ordre d'entrée (l'option de TÊTE exclue : c'est un état, pas une entité)");
    ck.eq(tout.hidden, 0, "saisie vide sous le plafond → rien de masqué");
    ck.eq(tout.shown.map((o) => (o.disabled ? "1" : "0")).join(""), "0001", "l'état `disabled` TRAVERSE le filtre : le port occupé reste VISIBLE (parité <option disabled>)");
    ck.eq(tout.shown[3].label, "Eth9 · RJ45 · Accès — occupé par SW-1 : Gi0/1", "…et son libellé nomme toujours le câble qui l'occupe, au caractère près");
    ck.eq(ids(OptionSearch.filter(ports, "   ", { normalize: norm }).shown), "p-a,p-b,p-c,p-z", "saisie BLANCHE = saisie vide (la requête est trimée)");

    // --- 2. AUCUN reclassement : divergence VOULUE avec TargetSearch (« préfixe d'abord ») ---
    //     Cas discriminant : « e » est un PRÉFIXE de p-a/p-b/p-z et une simple INCLUSION dans p-c
    //     (« …brin de TRUNK-1 »). Un classement préfixe-d'abord rendrait p-a,p-b,p-z,p-c — ce qui
    //     remonterait un port OCCUPÉ avant un port LIBRE, en détruisant la règle de tri de portOpts.
    ck.eq(ids(OptionSearch.filter(ports, "e", { normalize: norm }).shown), "p-a,p-b,p-c,p-z", "ordre d'ENTRÉE conservé — un classement « préfixe d'abord » aurait remonté le port occupé (p-z) avant p-c");
    ck.eq(ids(OptionSearch.filter(ports, "eth", { normalize: norm }).shown), "p-a,p-b,p-z", "« eth » → les 3 ports Ethernet, occupé compris, dans l'ordre de la liste");
    ck.eq(ids(OptionSearch.filter(ports, "ETH0", { normalize: norm }).shown), "p-a", "casse ignorée (normSearch)");
    ck.eq(ids(OptionSearch.filter(ports, "eth1", { normalize: norm }).shown), "p-b", "accents ignorés : « eth1 » atteint « Éth1 »");
    ck.eq(ids(OptionSearch.filter(ports, "  eth0 ", { normalize: norm }).shown), "p-a", "espaces de bord ignorés");
    ck.eq(ids(OptionSearch.filter(ports, "trunk", { normalize: norm }).shown), "p-c", "le libellé de BREAKOUT (brin de trunk) est cherchable");
    ck.eq(ids(OptionSearch.filter(ports, "occupé", { normalize: norm }).shown), "p-z", "la mention d'occupation est cherchable (elle fait partie du libellé)");
    ck.eq(ids(OptionSearch.filter(ports, "zzz", { normalize: norm }).shown), "", "aucune correspondance → aucun résultat");

    // --- 3. TRONCATURE : bornée mais ANNONCÉE (taire le surplus ferait croire à une entité absente) ---
    const borne = OptionSearch.filter(ports, "", { normalize: norm, limit: 2 });
    ck.eq(ids(borne.shown), "p-a,p-b", "plafond 2 → les 2 PREMIÈRES, l'ordre décide (jamais un échantillon)");
    ck.eq(borne.hidden, 2, "…et le surplus est COMPTÉ (2 masqués)");
    ck.eq(OptionSearch.filter(ports, "eth", { normalize: norm, limit: 1 }).hidden, 2, "`hidden` compte les CORRESPONDANCES écartées par le plafond, pas les options écartées par le filtre");
    ck.eq(OptionSearch.filter(ports, "", { normalize: norm, limit: 0 }).shown.length, 0, "plafond 0 → rien d'affiché");
    ck.eq(OptionSearch.filter(ports, "", { normalize: norm, limit: 0 }).hidden, 4, "…mais les 4 sont annoncés masqués");
    ck.eq(OptionSearch.filter(ports, "", { normalize: norm, limit: 99 }).hidden, 0, "plafond au-dessus du besoin → rien de masqué");
    ck.eq(OptionSearch.DEFAULT_LIMIT, 50, "plafond par DÉFAUT = 50 (borne de coût d'AFFICHAGE, pas préférence de pertinence)");

    // --- 4. Libellés de l'ÉTAT (ce qu'un <select> fermé montrait) ---
    ck.eq(OptionSearch.placeholderLabel(ports), "— Choisir le port —", "libellé de l'état vide = celui de l'option de tête");
    ck.eq(OptionSearch.placeholderLabel([{ value: "a", label: "A" }]), "", "aucune option de tête → libellé vide (l'appelant repliera)");
    ck.eq(OptionSearch.labelOf(ports, "p-c"), "SFP1 · LC · Accès · brin de TRUNK-1", "libellé de la valeur courante");
    ck.eq(OptionSearch.labelOf(ports, ""), null, "valeur vide → PAS de libellé de valeur (c'est l'état vide, cf. placeholderLabel)");
    ck.eq(OptionSearch.labelOf(ports, null), null, "valeur nulle → null");
    ck.eq(OptionSearch.labelOf(ports, "disparu"), null, "valeur absente de la liste → null");

    // --- 5. « Y a-t-il quelque chose à chercher ? » — les deux listes DÉGÉNÉRÉES de portOpts ---
    ck.eq(OptionSearch.selectableCount(ports), 4, "4 options réellement proposables (les `disabled` comptent : elles ont vocation à être VUES)");
    ck.eq(OptionSearch.selectableCount([{ value: "", label: "Choisir un équipement d'abord" }]), 0, "liste réduite à son option de tête → rien à chercher (le champ cède la place au libellé)");
    ck.eq(OptionSearch.selectableCount([]), 0, "liste vide → rien à chercher");

    // --- 6. PARITÉ des règles de VALEUR avec un <select> repeuplé (attentes EXPLICITES, pas une
    //     comparaison de la fonction à elle-même) : ce sont exactement les cas que traversent
    //     `refresh()`, `swapEnds()` et `selEqX.onchange` dans CableForms. ---
    ck.eq(OptionSearch.resolveValue(ports, undefined), "", "valeur NON fournie → valeur de la 1re option, comme un <select> qui sélectionne son premier <option>");
    ck.eq(OptionSearch.resolveValue(ports, null), "", "valeur nulle → idem (fillSelect ne pose la valeur que si elle n'est pas nulle)");
    ck.eq(OptionSearch.resolveValue([{ value: "a", label: "A" }, { value: "b", label: "B" }], undefined), "a", "sans option de tête, « pas de valeur » retient bien la PREMIÈRE option (et non \"\")");
    ck.eq(OptionSearch.resolveValue(ports, "p-b"), "p-b", "valeur présente → conservée (c'est ce qui protège la saisie à chaque refresh)");
    ck.eq(OptionSearch.resolveValue(ports, "p-z"), "p-z", "valeur présente mais `disabled` → CONSERVÉE : poser une valeur par programme marche aussi sur un <select> désactivé (seul l'utilisateur ne peut pas la choisir)");
    ck.eq(OptionSearch.resolveValue(ports, "disparu"), "", "valeur ABSENTE → \"\", comme `select.value = \"inconnu\"` qui laisse selectedIndex à -1 — c'est pourquoi `keepId` existe");
    ck.eq(OptionSearch.resolveValue([], "p-a"), "", "liste vide → \"\"");
    ck.eq(OptionSearch.resolveValue([], undefined), "", "liste vide sans valeur → \"\" (aucune 1re option à retenir)");

    // --- 7. Le SUFFIXE D'EMPLACEMENT est cherchable — c'est le gain concret du lot (doctrine §6.29/§6.31) :
    //     ces libellés se sont allongés et un <select> natif ne s'y filtre au clavier que par PRÉFIXE. ---
    const equipements = [
      { value: "", label: "— Choisir l'équipement —" },
      { value: "e-1", label: "SW-CORE-01 · Salle A" },
      { value: "e-2", label: "Onduleur nord · Bât. B · ét. 1" },
      { value: "e-3", label: "SW-ACCES-02 · Salle A" },
    ];
    ck.eq(ids(OptionSearch.filter(equipements, "salle a", { normalize: norm }).shown), "e-1,e-3", "chercher « salle a » atteint les équipements PAR LEUR EMPLACEMENT (impossible avec un <select>)");
    ck.eq(ids(OptionSearch.filter(equipements, "bat. b", { normalize: norm }).shown), "e-2", "« bat. b » (sans accent) atteint « Bât. B » — un posé d'ÉTAGE se cherche comme les autres");
    ck.eq(ids(OptionSearch.filter(equipements, "acces", { normalize: norm }).shown), "e-3", "et le nom reste cherchable en MILIEU de libellé");
  }
  });

  await section("GlobalSearch : logique PURE de la modale (paliers de score, groupes par pertinence, préfixes, surlignage)", async () => {
  {
    const norm = SharedSchema.normSearch;
    const ORDER = ["equipments", "cables", "vms"];
    const it = (kind, id, label, extra = {}) => ({ kind, id, label, terms: [], ...extra });
    const ids = (groups) => groups.map((g) => g.kind + ":" + g.items.map((x) => x.id).join(",")).join(" | ");

    // --- 1. PALIERS DE SCORE (la sémantique de la maquette) : 100 exact > 80 préfixe > 60 contient > 30 reste. ---
    ck.eq(GlobalSearch.score(it("e", "1", "sw-01"), "sw-01", norm), 100, "score : libellé EXACT → 100");
    ck.eq(GlobalSearch.score(it("e", "1", "SW-01-b"), "sw-01", norm), 80, "score : libellé PRÉFIXE → 80 (casse ignorée)");
    ck.eq(GlobalSearch.score(it("e", "1", "Core-SW-01"), "sw-01", norm), 60, "score : libellé CONTIENT → 60");
    ck.eq(GlobalSearch.score(it("e", "1", "Onduleur", { sub: "réf SW-01" }), "sw-01", norm), 30, "score : seule la SOUS-LIGNE contient → 30");
    ck.eq(GlobalSearch.score(it("e", "1", "Onduleur", { path: "B12 · SW-01" }), "sw-01", norm), 30, "score : seul le CHEMIN contient → 30");
    ck.eq(GlobalSearch.score(it("e", "1", "Onduleur", { terms: [null, "SN-SW-01"] }), "sw-01", norm), 30, "score : seul un TERME contient → 30 (null toléré)");
    ck.eq(GlobalSearch.score(it("e", "1", "Onduleur"), "sw-01", norm), 0, "score : rien ne matche → 0");
    ck.eq(GlobalSearch.score(it("e", "1", "Rocade Étage"), "etage", norm), 60, "score : accents ignorés (normalisation partagée)");
    ck.eq(GlobalSearch.score(it("v", "1", "srv", { terms: [8443] }), "8443", norm), 30, "score : terme NUMÉRIQUE cherchable (valeurs brutes des searchFields)");

    // --- 2. GROUPES par famille, JAMAIS entrelacés, ordonnés par leur MEILLEUR score. ---
    let r = GlobalSearch.rank([
      it("cables", "c-exact", "sw"),                 // 100 → le groupe câbles passe DEVANT
      it("equipments", "e-mid", "Core-SW-1"),        // 60
      it("equipments", "e-pre", "SW-ACCES"),         // 80
      it("vms", "v-term", "web", { terms: ["sw"] }), // 30
    ], "sw", { normalize: norm, kindOrder: ORDER });
    ck.eq(ids(r), "cables:c-exact | equipments:e-pre,e-mid | vms:v-term",
      "groupes : ordonnés par MEILLEUR score (câbles 100 avant équipements 80), items par score puis alphabétique");
    // à meilleur score ÉGAL : le départage est l'ordre canonique injecté, pas l'ordre d'arrivée
    r = GlobalSearch.rank([it("vms", "v", "xx-1"), it("equipments", "e", "xx-2")], "xx", { normalize: norm, kindOrder: ORDER });
    ck.eq(r.map((g) => g.kind).join(","), "equipments,vms", "égalité de meilleur score → ordre canonique (equipments avant vms)");
    // famille INCONNUE de l'ordre : après les connues (défensif — le corpus ne peut pas casser l'affichage)
    r = GlobalSearch.rank([it("zeta", "z", "xx"), it("equipments", "e", "xx")], "xx", { normalize: norm, kindOrder: ORDER });
    ck.eq(r.map((g) => g.kind).join(","), "equipments,zeta", "famille hors ordre canonique → APRÈS les connues, pas perdue");
    // égalité de score DANS un groupe : alphabétique du libellé normalisé (déterministe)
    r = GlobalSearch.rank([it("vms", "v2", "srv-b"), it("vms", "v1", "srv-a")], "srv", { normalize: norm, kindOrder: ORDER });
    ck.eq(ids(r), "vms:v1,v2", "égalité dans un groupe → tri alphabétique du libellé (pas l'ordre d'entrée)");
    // requête vide : aucun résultat (l'accueil de la modale prend le relais)
    ck.eq(GlobalSearch.rank([it("e", "1", "x")], "", { normalize: norm, kindOrder: ORDER }).length, 0, "requête vide → []");

    // --- 3. COMPTES par famille (les pastilles de portée) — score > 0 seulement. ---
    const corpus = [it("equipments", "e1", "sw-a"), it("equipments", "e2", "sw-b"), it("cables", "c1", "xx", { terms: ["sw"] }), it("vms", "v1", "web")];
    ck.eq(JSON.stringify(GlobalSearch.countByKind(corpus, "sw", norm)), JSON.stringify({ equipments: 2, cables: 1 }), "countByKind : par famille, palier 30 inclus, familles muettes absentes");
    ck.eq(JSON.stringify(GlobalSearch.countByKind(corpus, "", norm)), "{}", "countByKind : requête vide → {}");

    // --- 4. PRÉFIXES de portée : « eq:sw-01 » → portée + requête débarrassée. ---
    const PREFIXES = { "eq:": "equip", "cb:": "cables" };
    ck.eq(JSON.stringify(GlobalSearch.parsePrefix("eq:sw-01", PREFIXES)), JSON.stringify({ scope: "equip", query: "sw-01" }), "parsePrefix : préfixe reconnu → portée + requête sans lui");
    ck.eq(JSON.stringify(GlobalSearch.parsePrefix("EQ:  sw", PREFIXES)), JSON.stringify({ scope: "equip", query: "sw" }), "parsePrefix : casse ignorée, espaces après le préfixe mangés");
    ck.eq(JSON.stringify(GlobalSearch.parsePrefix("sw-01", PREFIXES)), JSON.stringify({ scope: null, query: "sw-01" }), "parsePrefix : sans préfixe → portée null, requête intacte");
    ck.eq(JSON.stringify(GlobalSearch.parsePrefix("cb:", PREFIXES)), JSON.stringify({ scope: "cables", query: "" }), "parsePrefix : préfixe seul → portée active, requête vide (état « parcourir la portée »)");

    // --- 5. SURLIGNAGE : position du fragment dans le texte ORIGINAL (pour le <mark> du rendu). ---
    ck.eq(JSON.stringify(GlobalSearch.matchRange("Core-SW-01", "sw", norm)), JSON.stringify({ start: 5, end: 7 }), "matchRange : indices sur l'original (casse ignorée)");
    ck.eq(GlobalSearch.matchRange("Onduleur", "sw", norm), null, "matchRange : absent → null (pas de <mark>)");
    ck.eq(JSON.stringify(GlobalSearch.matchRange("Rocade Étage", "etage", norm)), JSON.stringify({ start: 7, end: 12 }), "matchRange : accent composé (NFC) → indices exacts (l'approximation documentée ne mord que sur du décomposé)");
  }
  });

  await section("GlobalSearchSources : corpus + PORTÉES de la modale — invariants d'OUVRABILITÉ et habillage", async () => {
  {
    // --- 1. L'INVARIANT du chantier : corpus ⇄ fiches, ÉGALITÉ des deux ensembles.
    //     ⊆ : un résultat qui ne s'ouvre pas serait un clic sans effet (asymétrie prédicat ⇄ action).
    //     ⊇ : une fiche sans entrée au corpus est une collection INTROUVABLE à la modale. ---
    const families = GlobalSearchSources.families().slice().sort();
    const openable = DetailForms.DETAIL_COLLECTIONS.slice().sort();
    ck.eq(JSON.stringify(families), JSON.stringify(openable), "corpus ≡ fiches ouvrables (égalité stricte, dans les deux sens)");
    // DETAIL_COLLECTIONS : attentes EXPLICITES à la bascule switch → carte (doctrine §4.1 — sinon on
    // comparerait la carte à elle-même). C'est la liste EXACTE de l'ancien switch, l'ordre du switch inclus.
    ck.eq(JSON.stringify(DetailForms.DETAIL_COLLECTIONS), JSON.stringify([
      "equipments", "subEquipments", "racks", "cables", "cableBundles", "networks", "ipNetworks",
      "ipAddresses", "dhcpRanges", "datacenters", "sites", "groups", "floors", "spares", "contacts",
      "vms", "cableTypes", "portTypes",
    ]), "DETAIL_COLLECTIONS = la liste exacte de l'ancien switch (bascule prouvée par attentes explicites)");
    families.forEach((f) => ck(EntityRegistry.COLLECTIONS.includes(f), "famille « " + f + " » = collection réelle du modèle"));

    // --- 2. PORTÉES : partition EXACTE des familles (chacune dans UNE portée), préfixes uniques,
    //     i18n complète — portées ET familles. ---
    const scoped = GlobalSearchSources.SCOPES.flatMap((s) => s.kinds);
    ck.eq(scoped.length, new Set(scoped).size, "portées : aucune famille dans DEUX portées");
    ck.eq(JSON.stringify(scoped.slice().sort()), JSON.stringify(families), "portées : chaque famille du corpus est dans EXACTEMENT une portée");
    ck.eq(JSON.stringify(GlobalSearchSources.FAMILY_ORDER), JSON.stringify(scoped), "FAMILY_ORDER = l'ordre des portées déplié (une seule source d'ordre)");
    const prefixes = GlobalSearchSources.SCOPES.map((s) => s.prefix);
    ck.eq(prefixes.length, new Set(prefixes).size, "portées : préfixes de saisie UNIQUES");
    prefixes.forEach((p) => ck(/^[a-z]+:$/.test(p), "préfixe « " + p + " » : minuscules + « : » (saisissable, sans ambiguïté avec une requête)"));
    ck.eq(GlobalSearchSources.scopeOf("subEquipments"), "equip", "scopeOf : un sous-équipement est dans la portée Équipements");
    ck.eq(GlobalSearchSources.scopeOf("inconnu"), "", "scopeOf : famille inconnue → \"\" (défensif)");
    const { I18n } = D("i18n/I18n.js");
    families.forEach((f) => ck(I18n.t("search.family." + f) !== "search.family." + f, "libellé i18n présent pour la famille « " + f + " »"));
    ["all", ...GlobalSearchSources.SCOPES.map((s) => s.id)].forEach((id) => ck(I18n.t("search.scope." + id) !== "search.scope." + id, "libellé i18n présent pour la portée « " + id + " »"));
    GlobalSearchSources.SCOPES.forEach((s) => ck(typeof s.icon === "string" && s.icon.includes("<svg"), "portée « " + s.id + " » : icône SVG du registre"));

    // --- 3. Le CORPUS sur un store réel : habillage (sub/path) et TERMES hérités des listings. ---
    const s = await makeStore();
    const lib = await s.create("equipments", { name: "Librairie SL3000", serial: "SN-LIB-1", type: "other" });
    const drv = await s.create("subEquipments", { name: "Drive LTO-8 n°2", equipment_id: lib.id, serial: "SN-DRV-7", slot: "Étagère A / 3" });
    const corpus = GlobalSearchSources.build(s);
    const of = (kind, id) => corpus.find((x) => x.kind === kind && x.id === id);
    ck.eq(of("equipments", lib.id).label, "Librairie SL3000", "libellé équipement = son nom");
    // le CHEMIN d'un SOUS-ÉQUIPEMENT nomme son MAÎTRE (+ repère) — sans onglet (D2), c'est ICI que ce lien se lit
    ck.eq(of("subEquipments", drv.id).label, "Drive LTO-8 n°2", "libellé sous-équipement = son nom (le maître est au CHEMIN, plus dans le libellé)");
    ck.eq(of("subEquipments", drv.id).path, "Librairie SL3000 › Étagère A / 3", "chemin sous-équipement : « maître › repère »");
    ck.eq(of("subEquipments", drv.id).sub, "SN-DRV-7", "sous-ligne sous-équipement : l'identité matérielle présente (ici la série seule)");
    // termes : l'équipement HÉRITE des searchFields du listing ; le sous-équipement porte les siens
    const normAll = (terms) => terms.filter((t) => t != null).map((t) => SharedSchema.normSearch(t)).join(" ");
    ck(normAll(of("equipments", lib.id).terms).includes("sn-lib-1"), "termes équipement : n° de série (via searchFields du listing)");
    ck(normAll(of("equipments", lib.id).terms).includes("drive lto-8"), "termes équipement : le NOM de son drive (lot 6, hérité du listing)");
    ck(normAll(of("subEquipments", drv.id).terms).includes("librairie"), "termes sous-équipement : le nom de son MAÎTRE (chercher la librairie remonte aussi ses drives)");
    // habillage d'un CÂBLE : extrémités « équipement : port » en TEXTE (jamais de HTML dans le corpus)
    const pA = await s.create("ports", { name: "FC-1", equipment_id: lib.id });
    const sw = await s.create("equipments", { name: "SW-1" });
    const pB = await s.create("ports", { name: "Gi0/1", equipment_id: sw.id });
    const cab = await s.create("cables", { name: "CBL-1", from_port_id: pA.id, to_port_id: pB.id });
    const cabItem = GlobalSearchSources.build(s).find((x) => x.kind === "cables" && x.id === cab.id);
    ck.eq(cabItem.path, "Librairie SL3000 : FC-1 ↔ SW-1 : Gi0/1", "chemin câble : extrémités en texte brut");
    ck.eq(/[<>]/.test((cabItem.sub || "") + cabItem.path + cabItem.label), false, "corpus : AUCUN HTML (le surlignage/échappement est l'affaire de la modale)");
    // le corpus ne contient RIEN d'inouvre-able
    ck.eq(corpus.some((x) => x.kind === "ports" || x.kind === "aggregates" || x.kind === "waypoints" || x.kind === "rackItems"), false, "ports/agrégats/waypoints/rackItems : PAS au corpus (pas de fiche)");

    // --- 4. Bout à bout corpus → classement : chercher le drive remonte drive ET librairie. ---
    const ranked = GlobalSearch.rank(GlobalSearchSources.build(s), "drive lto", { normalize: SharedSchema.normSearch, kindOrder: GlobalSearchSources.FAMILY_ORDER });
    ck.eq(ranked.map((g) => g.kind).join(","), "subEquipments,equipments", "« drive lto » → le drive (LIBELLÉ, 80) devant la librairie (TERME, 30) — pertinence d'abord");
    ck.eq(ranked[0].items[0].id, drv.id, "le drive matche par son libellé (palier préfixe)");

    // --- 5. PASTILLES d'état (affichage seul) + cibles « Localiser » gardées par les PRÉDICATS. ---
    // pastille de CÂBLE : statut + ton (cassé = err, câblé = ok, planifié = neutre).
    // ⚠ SES PROPRES ports : pA/pB portent déjà CBL-1, et un port n'accepte qu'UN câble — réutiliser
    // les mêmes faisait REFUSER la création (null) et crasher la suite (leçon : toujours des données neuves).
    const pC = await s.create("ports", { name: "FC-2", equipment_id: lib.id });
    const pD = await s.create("ports", { name: "Gi0/2", equipment_id: sw.id });
    const casse = await s.create("cables", { name: "CBL-HS", from_port_id: pC.id, to_port_id: pD.id, status: "casse" });
    const corpus2 = GlobalSearchSources.build(s);
    const of2 = (kind, id) => corpus2.find((x) => x.kind === kind && x.id === id);
    ck.eq(of2("cables", casse.id).pill.tone, "err", "pastille câble : statut « cassé » → ton err");
    // ⚠ mesuré, pas supposé : un câble créé SANS statut reçoit le défaut LEGACY « cable » (déjà câblé),
    // pas « planifie » — c'est le formulaire qui pose « planifie » à la création, pas le modèle.
    ck.eq(of2("cables", cab.id).pill.tone, "ok", "pastille câble : sans statut explicite → legacy « câblé » → ton ok");
    // (le forçage « brouillon si incomplet » est une règle du FORMULAIRE — en création brute, même sans
    // ports, le modèle pose le legacy « cable » : d'où un statut EXPLICITE pour couvrir le ton neutre)
    const draft = await s.create("cables", { name: "CBL-DRAFT", status: "planifie" });
    ck.eq(GlobalSearchSources.build(s).find((x) => x.kind === "cables" && x.id === draft.id).pill.tone, "", "pastille câble : « planifié » → ton neutre");
    // ⚠ la pastille n'est JAMAIS cherchée : un câble dont SEULE la pastille matcherait ne sort pas
    const pillText = of2("cables", casse.id).pill.text;
    ck(pillText.length > 0, "témoin : la pastille a bien un texte (le test suivant n'est pas vacant)");
    const hitByPill = GlobalSearch.rank([{ kind: "cables", id: "x", label: "aaa", terms: [], pill: { text: pillText, tone: "err" } }], pillText, { normalize: SharedSchema.normSearch, kindOrder: [] });
    ck.eq(hitByPill.length, 0, "la PASTILLE n'est pas un terme de recherche (affichage seul)");
    // pastille de BAIE : occupation « n/N U » (RackScene = source unique de l'occupation)
    const dc1 = await s.create("datacenters", { name: "Salle A" });
    const rk = await s.create("racks", { name: "B12", u_count: 42, datacenter_id: dc1.id });
    await s.create("equipments", { name: "srv-u", rack_id: rk.id, placement_mode: "rack", dim_mode: "u", rack_u: 10, u_height: 2 });
    const rkItem = GlobalSearchSources.build(s).find((x) => x.kind === "racks" && x.id === rk.id);
    ck.eq(rkItem.pill.text, "2/42 U", "pastille baie : U occupés / U totaux (via RackScene.occupants)");
    // « Localiser » : GARDÉ par les prédicats partagés — jamais de bouton qui mène à un toast
    ck.eq(rkItem.locate && rkItem.locate.kind, "rack", "baie EN SALLE → cible Localiser");
    const poolRack = await s.create("racks", { name: "B-pool" });   // sans salle → non localisable
    ck.eq(GlobalSearchSources.build(s).find((x) => x.kind === "racks" && x.id === poolRack.id).locate, undefined, "baie SANS salle → PAS de cible Localiser (même prédicat que les listes)");
    ck.eq(of2("equipments", lib.id).locate, undefined, "équipement NON localisable (manual sans lieu) → pas de cible");
    // sous-équipement : « Localiser » = SON MAÎTRE (pas d'existence physique propre), gardé pareil
    ck.eq(of2("subEquipments", drv.id).locate, undefined, "sous-équipement d'un maître non localisable → pas de cible");
    const drv2 = await s.create("subEquipments", { name: "Drive rk", equipment_id: (await s.create("equipments", { name: "eq-en-baie", rack_id: rk.id, placement_mode: "rack", dim_mode: "u", rack_u: 20 })).id });
    const drv2Item = GlobalSearchSources.build(s).find((x) => x.kind === "subEquipments" && x.id === drv2.id);
    ck.eq(drv2Item.locate && drv2Item.locate.kind, "equipment", "sous-équipement d'un maître EN BAIE → Localiser vise le MAÎTRE (kind equipment)");
    ck.eq(drv2Item.locate && drv2Item.locate.id === drv2.equipment_id, true, "…et la cible est l'id du maître, pas celui du drive");
  }
  });

  await section("VmLocate : « Localiser » une VM vise son HÔTE — et SEULEMENT s'il est localisable (version sobre)", async () => {
  {
    // --- Partie 1 : TOLÉRANCE et référence PENDANTE, sur un store STUB (aucune donnée réelle nécessaire).
    //     Le store stub compte ses lectures : on vérifie aussi qu'une VM sans hôte ne coûte AUCUNE lecture
    //     (le prédicat est évalué par LIGNE de listing, à chaque re-rendu). ---
    let lectures = 0;
    const stub = (equipments, localisable) => ({
      get: (coll, id) => { lectures++; return coll === "equipments" ? (equipments[id] || null) : null; },
      equipmentLocatable: (eq) => (eq ? localisable(eq) : false),
    });
    const vide = stub({}, () => false);
    ck.eq(VmLocate.hostEquipmentId(null, vide), null, "VM null → null (tolérant)");
    ck.eq(VmLocate.hostEquipmentId(undefined, vide), null, "VM undefined → null (tolérant)");
    ck.eq(VmLocate.hostEquipmentId({}, vide), null, "VM sans host_equipment_id → null (hôte ABSENT)");
    ck.eq(VmLocate.hostEquipmentId({ host_equipment_id: null }, vide), null, "host_equipment_id null → null");
    ck.eq(VmLocate.hostEquipmentId({ host_equipment_id: "" }, vide), null, "host_equipment_id vide → null");
    ck.eq(VmLocate.hostEquipmentId({ host_equipment_id: "   " }, vide), null, "host_equipment_id blanc → null (trimé)");
    ck.eq(lectures, 0, "VM sans hôte : AUCUNE lecture du store (le prédicat est évalué par ligne de listing)");
    // Référence PENDANTE : la synchro POSE ce champ, rien ne garantit que l'équipement survit (import, écriture
    // d'API tierce…). La cascade le détache quand la suppression passe par l'app, pas dans les autres cas.
    ck.eq(VmLocate.hostEquipmentId({ host_equipment_id: "eq-disparu" }, vide), null, "hôte INEXISTANT dans le document → null (référence pendante)");
    ck.eq(lectures, 1, "hôte inexistant : une seule lecture, et on s'arrête là");
    // Hôte présent et localisable → l'ID DE L'HÔTE est rendu (pas un booléen, pas l'id de la VM).
    const peuple = stub({ "eq-1": { id: "eq-1" } }, () => true);
    ck.eq(VmLocate.hostEquipmentId({ host_equipment_id: "eq-1" }, peuple), "eq-1", "hôte présent et localisable → id de l'HÔTE");
    ck.eq(VmLocate.hostEquipmentId({ host_equipment_id: "  eq-1  " }, peuple), "eq-1", "id d'hôte trimé avant lecture ET en sortie");
    // L'AUTORITÉ est `equipmentLocatable` : le même hôte, non localisable, ne donne rien.
    const horsSalle = stub({ "eq-1": { id: "eq-1" } }, () => false);
    ck.eq(VmLocate.hostEquipmentId({ host_equipment_id: "eq-1" }, horsSalle), null, "hôte présent mais equipmentLocatable → false ⇒ AUCUN bouton");

    // --- Partie 2 : INTÉGRATION sur un vrai Store, un cas par MODE DE PLACEMENT de l'hôte. C'est la partie
    //     qui fait foi : elle traverse `Store.equipmentLocatable` → `Locatable` → `PlacementContainers`. ---
    const s = await makeStore();
    const dc = await s.create("datacenters", { name: "Salle A", location: "liege", floor: "0" });
    const rack = await s.create("racks", { name: "R1", width_mm: 600, depth: 1000, u_count: 42, datacenter_id: dc.id, dc_x: 500, dc_y: 500 });
    const rackHorsSalle = await s.create("racks", { name: "R-pool", width_mm: 600, depth: 1000, u_count: 42, location: "liege" });
    const tray = await s.create("rackItems", { rack_id: rack.id, kind: "tray", side: "front", u: 10, u_height: 2 });

    let n = 0;
    /** Crée un hôte dans le mode voulu + une VM qui le désigne, et vérifie la cible attendue (EN DUR). */
    const cas = async (label, placement, localisable) => {
      const eq = await s.create("equipments", Object.assign({ name: "hote-" + (++n) }, placement));
      const vm = await s.create("vms", { name: "vm-" + n, ext_id: "c/" + (200 + n), host_equipment_id: eq.id });
      ck.eq(VmLocate.hostEquipmentId(s.get("vms", vm.id), s), localisable ? eq.id : null, "hôte " + label + (localisable ? " → localisable (id de l'hôte)" : " → NON localisable (aucun bouton)"));
      return eq;
    };
    await cas("monté en baie (rack + rack_u), baie posée en salle", { placement_mode: "rack", rack_id: rack.id, rack_u: 5 }, true);
    await cas("libre POSITIONNÉ en salle (dc_id)", { placement_mode: "manual", dim_mode: "free", dc_id: dc.id, dc_x: 100, dc_y: 100 }, true);
    await cas("en marge latérale d'une baie en salle", { placement_mode: "side", rack_id: rack.id }, true);
    await cas("en paroi d'une baie en salle", { placement_mode: "wall", rack_id: rack.id }, true);
    await cas("posé sur une étagère d'une baie en salle", { placement_mode: "tray", dim_mode: "free", tray_item_id: tray.id, tray_x: 10, tray_y: 10, free_w_mm: 100, free_l_mm: 100, free_h_mm: 40 }, true);
    await cas("libre SANS position (inventaire pur)", { placement_mode: "manual", dim_mode: "free" }, false);
    await cas("en POOL d'une baie (rack_id SANS rack_u)", { placement_mode: "rack", rack_id: rack.id }, false);
    await cas("monté dans une baie HORS salle", { placement_mode: "rack", rack_id: rackHorsSalle.id, rack_u: 3 }, false);
    // ⚠ ÉTAGE — CHANGEMENT DE COMPORTEMENT (doctrine §6.27 puis §6.28). Ce cas attendait `false` : le
    // prédicat était `equipmentDcId` (retiré depuis, §6.33), qui rendait `null` pour un posé d'étage.
    // « Localiser » sait désormais le
    // cadrer en MONDE, donc la VM qu'il héberge devient localisable — À CONDITION que son bâtiment ait au
    // moins une salle (la portée d'affichage s'exprime en salles). Ici `dc` est une salle du bâtiment
    // « liege », d'où `true` ; le cas SANS salle est vérifié juste après.
    await cas("posé sur un ÉTAGE d'un bâtiment AYANT une salle", { placement_mode: "floor", location: "liege", floor: "1", floor_x: 200, floor_y: 300 }, true);
    await cas("posé sur un ÉTAGE d'un bâtiment SANS AUCUNE salle", { placement_mode: "floor", location: "namur", floor: "0", floor_x: 200, floor_y: 300 }, false);

    // Une VM SANS hôte, sur un vrai store : rien à viser (cas le plus fréquent avant le 1er rapprochement).
    const orpheline = await s.create("vms", { name: "vm-sans-hote", ext_id: "c/999" });
    ck.eq(VmLocate.hostEquipmentId(s.get("vms", orpheline.id), s), null, "VM jamais rapprochée à un équipement → null");
    // DISCRIMINATION : deux VMs sur des hôtes différents ne se confondent pas (le module lit bien SA VM).
    const eqA = await s.create("equipments", { name: "hyp-A", placement_mode: "manual", dim_mode: "free", dc_id: dc.id, dc_x: 1, dc_y: 1 });
    const eqB = await s.create("equipments", { name: "hyp-B", placement_mode: "manual", dim_mode: "free", dc_id: dc.id, dc_x: 2, dc_y: 2 });
    const vmA = await s.create("vms", { name: "vm-A", ext_id: "c/900", host_equipment_id: eqA.id });
    const vmB = await s.create("vms", { name: "vm-B", ext_id: "c/901", host_equipment_id: eqB.id });
    ck.eq(VmLocate.hostEquipmentId(s.get("vms", vmA.id), s), eqA.id, "discrimination : vm-A vise hyp-A");
    ck.eq(VmLocate.hostEquipmentId(s.get("vms", vmB.id), s), eqB.id, "discrimination : vm-B vise hyp-B");
    // Un hôte qui SORT de sa salle rend la VM non localisable sans que la VM ait bougé (le prédicat se
    // recalcule à chaque rendu, il n'est jamais mémorisé).
    await s.update("equipments", eqA.id, { dc_id: null });
    ck.eq(VmLocate.hostEquipmentId(s.get("vms", vmA.id), s), null, "hôte DÉPLACÉ hors salle → la VM cesse d'être localisable");
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
    ck.eq(s.all("sites").length, 0, "aucun site par défaut sur un document vierge (seed retiré)");
    ck.eq(s.siteLabel("inconnu"), "inconnu", "siteLabel : id sans entité ni repli → l'id brut");
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
