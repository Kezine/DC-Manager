/* Tests modules — code PARTAGÉ front/back (schéma, normalisation, validation, cascade).
   Sections extraites de run.js (audit P5) ; harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, TsImports, mkStorage, Store, BrowserStorageAdapter, FieldIndex, Equipment, Cable, Port, Normalize, Labeler, ClickGuard, Projection, Box, Painter, RackGeometry, GraphGeometry, EquipmentTypes, PortRoles, Depths, EquipFaces, RackScene, Resolver3D, U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE, Html, Color, Format, GridGeometry, GraphView, Sort, Ip, Prefs, DatacenterView, FloorLayout, Positioning, DoorGeometry, Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM, DoorTool, Measure, CableSpline, MeasureTool, RouteTool, ImageStore, FaceImage, SaveState, EntityRegistry, ReloadPlanner, COLLECTION_THREE_IMPACT, RenderImpact, Changeset, SharedSchema, Text, PAGE_SIZE_DEFAULT, Validation, Cascade, PowerAnalysis, TrayGeom, TrayGeometry, RackDepthPol, RackDepthPolicy, Rack, CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS, TRAY_TYPES, makeStore } = require("./harness.js");

module.exports = async () => {
  await section("shared : DataValidation — champs d'audit (created_by/updated_by/dates) préservés au round-trip", async () => {
  {
    // Le serveur estampille created_by/updated_by/created_date/updated_date HORS spec de collection (blob JSON) :
    // ces champs NON DÉCLARÉS doivent TRAVERSER la normalisation + validation partagées sans être ni retirés ni
    // rejetés — sinon l'estampillage d'audit (lot 2) et la restauration de snapshot (Q7) les perdraient.
    const { DataValidator } = Validation;
    const audit = { created_by: "u-alice", updated_by: "u-bob", created_date: "2026-01-01T00:00:00.000Z", updated_date: "2026-02-02T00:00:00.000Z" };
    // Collection AVEC spec (equipments) : la normalisation ne touche qu'aux champs déclarés → l'audit traverse.
    const { record, errors } = DataValidator.normalizeAndValidate("equipments", { id: "e1", name: "srv1", ...audit });
    ck(record.created_by === "u-alice" && record.updated_by === "u-bob", "audit : created_by/updated_by traversent la normalisation d'une collection à spec");
    ck(record.created_date === audit.created_date && record.updated_date === audit.updated_date, "audit : created_date/updated_date préservés");
    ck.eq(errors.filter((e) => e.path === "created_by" || e.path === "updated_by").length, 0, "audit : aucun champ d'audit n'est rejeté par la validation");
    // Une AUTRE collection à spec (spares) : la normalisation applique ses défauts mais l'audit non déclaré traverse.
    const { record: r2 } = DataValidator.normalizeAndValidate("spares", { id: "s1", ...audit });
    ck(r2.created_by === "u-alice" && r2.updated_date === audit.updated_date, "audit : préservé aussi sur une autre collection à spec (champs non déclarés → traversent)");
  }
  });

  await section("shared : DataValidation — ipAddresses.hostname déclaré + format strict (RFC 1123)", async () => {
  {
    // RÉGULARISATION 2026-07-20 puis DURCISSEMENT (décision utilisateur, aucune donnée en conflit) :
    // `hostname` est déclaré { type:"string", trim:true, format:"hostname" } → format RFC 1123 STRICT
    // (nom court ou FQDN, insensible à la casse). Optionnel : une IP peut n'avoir aucun nom d'hôte.
    const { DataValidator } = Validation;
    const base = { id: "ip1", address: "10.0.0.5" };
    const errsOn = (host) => DataValidator.normalizeAndValidate("ipAddresses", { ...base, hostname: host }).errors.filter((e) => e.path === "hostname");
    // Valides : nom court, FQDN, casse mixte, tirets internes, chiffres.
    const { record: rTrim, errors: eTrim } = DataValidator.normalizeAndValidate("ipAddresses", { ...base, hostname: "  srv1.dom.local  " });
    ck.eq(rTrim.hostname, "srv1.dom.local", "hostname : trimé à la normalisation");
    ck.eq(eTrim.filter((e) => e.path === "hostname").length, 0, "hostname : FQDN accepté");
    ck.eq(errsOn("srv1").length, 0, "hostname : nom court accepté");
    ck.eq(errsOn("SRV1.DOM.local").length, 0, "hostname : casse mixte acceptée (insensible)");
    ck.eq(errsOn("edge-rtr-02.dc1.example.com").length, 0, "hostname : tirets internes + FQDN long acceptés");
    // Invalides (format strict) : espaces, slash, underscore, tiret en tête/queue, label vide, accents.
    ck.eq(errsOn("vip web / interne").length, 1, "hostname : espaces/slash REJETÉS (format)");
    ck.eq(errsOn("srv_1").length, 1, "hostname : underscore REJETÉ");
    ck.eq(errsOn("-srv1").length, 1, "hostname : tiret en tête REJETÉ");
    ck.eq(errsOn("srv1-").length, 1, "hostname : tiret en queue REJETÉ");
    ck.eq(errsOn("srv1..dom").length, 1, "hostname : label vide (double point) REJETÉ");
    ck.eq(errsOn("srvé1").length, 1, "hostname : accent REJETÉ");
    ck.eq(errsOn("a".repeat(64)).length, 1, "hostname : label > 63 caractères REJETÉ");
    // Optionnel : absent / null / vide → pas d'erreur (une IP peut n'avoir aucun hostname).
    const { record: rAbs, errors: eAbs } = DataValidator.normalizeAndValidate("ipAddresses", { ...base });
    ck(!("hostname" in rAbs) || rAbs.hostname === undefined, "hostname : absent reste absent (aucun défaut injecté)");
    ck.eq(eAbs.filter((e) => e.path === "hostname").length, 0, "hostname : absence acceptée (optionnel)");
    ck.eq(errsOn(null).length, 0, "hostname : null accepté (optionnel)");
    ck.eq(errsOn("").length, 0, "hostname : chaîne vide acceptée (optionnel)");
  }
  });

  await section("shared : Cascade.plan (intégrité référentielle PARTAGÉE — front ⇄ back)", async () => {
  {
    // Jeu de données en mémoire + capacités injectées (find/fetch), comme côté serveur (repo) ou Store (_byFk).
    const db = {
      racks: [{ id: "R1" }],
      rackItems: [{ id: "ri1", rack_id: "R1" }, { id: "ri2", rack_id: "R2" }],
      equipments: [
        { id: "E1", name: "srv", rack_id: "R1", placement_mode: "rack" }, { id: "E2", rack_id: "R1" },
        // multi-groupes : G1 primaire + G2 secondaire ; et E4 LEGACY (group_id seul, group_ids absent).
        { id: "E3", name: "sw", group_id: "G1", group_ids: ["G1", "G2"] },
        { id: "E4", name: "old", group_id: "G2" },
      ],
      groups: [{ id: "G1", label: "Cœur" }, { id: "G2", label: "SAN" }],
      ports: [{ id: "P1", equipment_id: "E1" }, { id: "P2", equipment_id: "E1" },
        // port de PATCH (sur E2) terminant des brins du faisceau B1 (brins physiques 1 & 2, duplex).
        { id: "P3", equipment_id: "E2", bundle_id: "B1", strand_a: 1, strand_b: 2 },
        // port TERMINAL assertant le réseau NET1 (source unique) → détaché à la suppression du réseau.
        { id: "P4", equipment_id: "E2", network_ids: ["NET1"], network_id: "NET1" }],
      networks: [{ id: "NET1", label: "VLAN" }],
      aggregates: [{ id: "A1", equipment_id: "E1" }],
      // sous-équipements : SE1 sur E1 (emporté par le maître), SE2 sur E2 (épargné) — parité aggregates.
      subEquipments: [{ id: "SE1", name: "Drive 1", equipment_id: "E1" }, { id: "SE2", name: "Drive 2", equipment_id: "E2" }],
      // faisceau rattaché à 2 patchs (E1 côté A) — la suppression de E1 doit détacher l'extrémité A.
      cableBundles: [{ id: "B1", endpoint_a_equipment_id: "E1", endpoint_b_equipment_id: "E2" }],
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
    // sous-équipements : ils n'ont d'existence QUE par leur maître → emportés avec lui ; ceux d'un AUTRE
    // maître sont épargnés (la règle suit la FK, elle ne balaie pas la collection).
    ck.eq(eqPlan.deletes.some((d) => d.c === "subEquipments" && d.id === "SE1"), true, "équip. : sous-équipement supprimé avec le maître");
    ck.eq(eqPlan.deletes.some((d) => d.c === "subEquipments" && d.id === "SE2"), false, "équip. : sous-équipement d'un AUTRE maître épargné");
    ck.eq(eqPlan.deletes.some((d) => d.c === "cables" && d.id === "C1"), true, "équip. : câble des ports supprimé");
    ck.eq(eqPlan.detaches.some((d) => d.c === "ipAddresses" && d.key === "equipment_id" && d.value === null), true, "équip. : IP détachée (registre conservé)");
    ck.eq(eqPlan.detaches.some((d) => d.c === "dhcpRanges" && d.key === "server_id" && d.value === null), true, "équip. : rôle serveur DHCP détaché");
    // spare : bascule en texte libre (info préservée) + FK détachée
    ck.eq(eqPlan.detaches.some((d) => d.c === "spares" && d.key === "assigned_free" && d.value === "srv"), true, "équip. : spare préservé en texte libre (nom)");
    ck.eq(eqPlan.detaches.some((d) => d.c === "spares" && d.key === "assigned_equipment_id" && d.value === null), true, "équip. : spare FK détachée");
    // faisceau : l'extrémité A pointant l'équipement supprimé est détachée (trunk demi-terminé, pas supprimé).
    ck.eq(eqPlan.detaches.some((d) => d.c === "cableBundles" && d.id === "B1" && d.key === "endpoint_a_equipment_id" && d.value === null), true, "équip. : extrémité A du faisceau détachée");
    ck.eq(eqPlan.deletes.some((d) => d.c === "cableBundles"), false, "équip. : faisceau JAMAIS supprimé (seulement détaché)");

    // -- faisceau : détache les affectations de brins des ports de patch (source unique des brins) --
    const bundlePlan = Cascade.plan("cableBundles", "B1", find, fetch);
    const p3det = bundlePlan.detaches.filter((d) => d.c === "ports" && d.id === "P3");
    ck.eq(p3det.some((d) => d.key === "bundle_id" && d.value === null), true, "faisceau : port de patch détaché (bundle_id null)");
    ck.eq(p3det.some((d) => d.key === "strand_a" && d.value === null), true, "faisceau : brin A du port remis à zéro");
    ck.eq(p3det.some((d) => d.key === "strand_b" && d.value === null), true, "faisceau : brin B du port remis à zéro");
    ck.eq(bundlePlan.deletes.length, 0, "faisceau : rien supprimé (détachement seul)");

    // -- réseau : détaché des PORTS terminaux qui l'assertent (source unique) --
    const netPlan = Cascade.plan("networks", "NET1", find, fetch);
    const p4det = netPlan.detaches.filter((d) => d.c === "ports" && d.id === "P4");
    ck.eq(p4det.some((d) => d.key === "network_ids" && JSON.stringify(d.value) === "[]"), true, "réseau : retiré de network_ids du port terminal");
    ck.eq(p4det.some((d) => d.key === "network_id" && d.value === null), true, "réseau : réseau principal du port repointé (null)");

    // -- datacenter : waypoints (et racks/équipements) détachés, jamais supprimés --
    const dcPlan = Cascade.plan("datacenters", "DC1", find, fetch);
    ck.eq(dcPlan.deletes.length, 0, "datacenter : aucune suppression (que des détachements)");
    ck.eq(dcPlan.detaches.some((d) => d.c === "waypoints" && d.key === "datacenter_id" && d.value === null), true, "datacenter : waypoint détaché");

    // -- groupe : retiré de group_ids des équipements membres, primaire repointé (modèle networks/network_ids) --
    const g1Plan = Cascade.plan("groups", "G1", find, fetch);
    const e3g = g1Plan.detaches.filter((d) => d.c === "equipments" && d.id === "E3");
    ck.eq(JSON.stringify((e3g.find((d) => d.key === "group_ids") || {}).value), JSON.stringify(["G2"]), "groupe : G1 retiré de group_ids de E3");
    ck.eq((e3g.find((d) => d.key === "group_id") || {}).value, "G2", "groupe : primaire supprimé → repointé sur le groupe restant");
    ck.eq(g1Plan.deletes.length, 0, "groupe : aucun équipement supprimé (détachement seul)");
    // suppression d'un groupe SECONDAIRE : le primaire reste inchangé ; couvre aussi le LEGACY (E4 : group_id seul).
    const g2Plan = Cascade.plan("groups", "G2", find, fetch);
    const e3g2 = g2Plan.detaches.filter((d) => d.c === "equipments" && d.id === "E3");
    ck.eq(JSON.stringify((e3g2.find((d) => d.key === "group_ids") || {}).value), JSON.stringify(["G1"]), "groupe : G2 (secondaire) retiré de group_ids de E3");
    ck.eq((e3g2.find((d) => d.key === "group_id") || {}).value, "G1", "groupe : primaire de E3 (G1) inchangé");
    const e4g2 = g2Plan.detaches.filter((d) => d.c === "equipments" && d.id === "E4");
    ck.eq(JSON.stringify((e4g2.find((d) => d.key === "group_ids") || {}).value), JSON.stringify([]), "groupe LEGACY : E4 (group_id seul) → group_ids vidé");
    ck.eq((e4g2.find((d) => d.key === "group_id") || {}).value, null, "groupe LEGACY : primaire de E4 effacé (null)");

    // -- 🚨 VERROU du piège n°1 : la cascade `groups` ÉNUMÈRE à la main les collections porteuses de
    //    groupes, et l'oubli a déjà eu lieu une fois (`vms`). On ne vérifie donc pas une liste écrite ici
    //    (elle se périmerait pareil) : on la DÉRIVE de la spec de validation — toute collection déclarant
    //    `group_ids: { ref: "groups" }` DOIT être balayée — puis on la confronte au plan RÉELLEMENT produit.
    //    Ajouter une 4ᵉ collection porteuse de groupes sans toucher à Cascade fera rougir ce test, en la nommant.
    const groupBearing = Object.entries(Validation.COLLECTION_SPECS)
      .filter(([, spec]) => spec.fields.group_ids && spec.fields.group_ids.ref === "groups")
      .map(([collection]) => collection).sort();
    ck.eq(JSON.stringify(groupBearing), JSON.stringify(["equipments", "subEquipments", "vms"]),
      "groupes : collections porteuses dérivées de la spec (témoin — si ça change, la cascade doit suivre)");
    for (const collection of groupBearing) {
      // un membre de G1 dans CETTE collection, fabriqué à la volée : le test ne dépend pas du jeu de données.
      const probe = { [collection]: [{ id: "M_" + collection, group_id: "G1", group_ids: ["G1", "G2"] }] };
      const probeFind = (coll, field, value) => (probe[coll] || db[coll] || []).filter((o) => {
        const v = o[field];
        return Array.isArray(v) ? v.includes(value) : v === value;
      });
      const plan = Cascade.plan("groups", "G1", probeFind, fetch);
      const det = plan.detaches.filter((d) => d.c === collection && d.id === "M_" + collection);
      ck.eq(JSON.stringify((det.find((d) => d.key === "group_ids") || {}).value), JSON.stringify(["G2"]),
        "groupes : « " + collection + " » est BALAYÉE par la cascade (group_ids nettoyé)");
      ck.eq((det.find((d) => d.key === "group_id") || {}).value, "G2",
        "groupes : « " + collection + " » — primaire repointé");
    }

    // -- collection sans règle de cascade : plan vide --
    const noop = Cascade.plan("floors", "F1", find, fetch);
    ck.eq(noop.deletes.length + noop.detaches.length, 0, "collection sans règle → plan vide");
  }
  });

  await section("shared : Cascade.plan RÉCURSIVE (point fixe, anti-cycle, détachements réduits)", async () => {
  {
    /* Le plan REJOUE la règle de chaque entité qu'il marque pour suppression, jusqu'au point fixe
       (docs/placement.md §6.16). Ces attentes sont EN DUR : elles ne comparent aucune implémentation à
       une autre (une parité serait tautologique — la cascade non récursive n'existe plus). */
    const mk = () => ({
      equipments: [{ id: "E1", name: "sw" }, { id: "E2", name: "peer" }],
      // Chaîne PROFONDE : trunk → lane → sous-lane → sous-sous-lane. L2 n'a PAS d'equipment_id
      // (cas produit par une écriture d'API tierce) : sans récursion, elle survivait à E1.
      ports: [
        { id: "T", equipment_id: "E1", aggregate_id: "A1" },
        { id: "L1", equipment_id: "E1", parent_port_id: "T" },
        { id: "L2", parent_port_id: "T" },
        { id: "L2a", parent_port_id: "L2" },
        { id: "L2b", parent_port_id: "L2a" },
        // Port d'un AUTRE équipement rattaché au MÊME agrégat (anomalie de données) : l'agrégat étant
        // supprimé avec E1, sa FK doit être détachée — c'est la récursion qui atteint cette règle.
        { id: "X", equipment_id: "E2", aggregate_id: "A1" },
      ],
      aggregates: [{ id: "A1", equipment_id: "E1" }],
      cables: [
        { id: "cT", from_port_id: "T", to_port_id: "X" },
        { id: "cL1", from_port_id: "L1", to_port_id: "X" },
        { id: "cL2", from_port_id: "L2", to_port_id: "X" },
        { id: "cL2a", from_port_id: "L2a", to_port_id: "X" },
        { id: "cL2b", from_port_id: "L2b", to_port_id: "X" },
      ],
    });
    const finderOf = (db) => (coll, field, value) => (db[coll] || []).filter((o) => {
      const v = o[field];
      return Array.isArray(v) ? v.includes(value) : v === value;
    });
    const fetcherOf = (db) => (coll, id) => (db[coll] || []).find((o) => o.id === id) || null;
    const idsOf = (list, coll) => list.filter((d) => d.c === coll).map((d) => d.id).sort().join(",");

    // -- 1) ÉQUIPEMENT : la chaîne entière part, y compris les lanes sans equipment_id et leurs câbles --
    {
      const db = mk(); const find = finderOf(db), fetch = fetcherOf(db);
      const plan = Cascade.plan("equipments", "E1", find, fetch);
      ck.eq(idsOf(plan.deletes, "ports"), "L1,L2,L2a,L2b,T", "récursion : équipement → trunk + lane + sous-lane + sous-sous-lane");
      ck.eq(idsOf(plan.deletes, "cables"), "cL1,cL2,cL2a,cL2b,cT", "récursion : les câbles de TOUTE la chaîne de ports partent");
      ck.eq(idsOf(plan.deletes, "aggregates"), "A1", "équipement : agrégat supprimé");
      ck.eq(plan.deletes.length, 11, "équipement : 11 entités supprimées au total (5 ports + 5 câbles + 1 agrégat)");
      // dédup : le plan est un ENSEMBLE, même si une entité est atteinte par plusieurs chemins.
      ck.eq(new Set(plan.deletes.map((d) => d.c + "/" + d.id)).size, plan.deletes.length, "plan : aucune entité en double dans deletes");
      // détachement de l'agrégat : le port SURVIVANT est détaché, les ports SUPPRIMÉS ne le sont pas.
      ck.eq(plan.detaches.filter((d) => d.c === "ports" && d.key === "aggregate_id").map((d) => d.id).join(","), "X",
        "agrégat supprimé : seul le port SURVIVANT est détaché (les ports supprimés ne le sont pas)");
      ck.eq(plan.detaches.some((d) => d.c === "ports" && d.id === "T"), false, "détachement visant une entité SUPPRIMÉE : ÉCARTÉ (anti-résurrection)");
      ck.eq(plan.deletes.some((d) => d.c === "equipments" && d.id === "E1"), false, "la CIBLE ne figure jamais dans son propre plan");
    }

    // -- 2) PORT : un breakout IMBRIQUÉ part en entier (l'ancien plan s'arrêtait au 1er niveau de lanes) --
    {
      const db = mk(); const find = finderOf(db), fetch = fetcherOf(db);
      const plan = Cascade.plan("ports", "T", find, fetch);
      ck.eq(idsOf(plan.deletes, "ports"), "L1,L2,L2a,L2b", "récursion : port trunk → lanes ET sous-lanes (breakout imbriqué)");
      ck.eq(idsOf(plan.deletes, "cables"), "cL1,cL2,cL2a,cL2b,cT", "récursion : câbles du trunk ET de toutes ses lanes");
      ck.eq(plan.deletes.length, 9, "port trunk : 9 entités supprimées (4 lanes + 5 câbles)");
      const sub = Cascade.plan("ports", "L2", find, fetch);
      ck.eq(idsOf(sub.deletes, "ports"), "L2a,L2b", "récursion : depuis une lane, le sous-breakout part aussi");
      ck.eq(sub.deletes.length, 5, "lane L2 : 5 entités supprimées (2 sous-lanes + 3 câbles)");
    }

    // -- 3) ANTI-CYCLE : un cycle de références TERMINE et ne double aucune entité --
    {
      const db = {
        // cycle à 3 : Y1 ← Y3 ← Y2 ← Y1 (chaque port est le parent du suivant)
        ports: [{ id: "Y1", parent_port_id: "Y2" }, { id: "Y2", parent_port_id: "Y3" }, { id: "Y3", parent_port_id: "Y1" },
          { id: "Z", parent_port_id: "Z" }],
        cables: [{ id: "cY", from_port_id: "Y2", to_port_id: "Y3" }, { id: "cZ", from_port_id: "Z", to_port_id: "Z" }],
      };
      const find = finderOf(db), fetch = fetcherOf(db);
      const cyc = Cascade.plan("ports", "Y1", find, fetch);
      ck.eq(idsOf(cyc.deletes, "ports"), "Y2,Y3", "anti-cycle : cycle à 3 → les 2 AUTRES ports, une seule fois chacun");
      ck.eq(cyc.deletes.some((d) => d.id === "Y1"), false, "anti-cycle : la cible ne se re-supprime pas via le cycle");
      ck.eq(idsOf(cyc.deletes, "cables"), "cY", "anti-cycle : le câble du cycle est supprimé une seule fois");
      ck.eq(cyc.deletes.length, 3, "anti-cycle : plan de 3 entités, terminaison prouvée");
      const self = Cascade.plan("ports", "Z", find, fetch);
      ck.eq(self.deletes.length, 1, "anti-cycle : port parent DE LUI-MÊME → seul son câble part (le port est la cible)");
      ck.eq(idsOf(self.deletes, "cables"), "cZ", "anti-cycle : boucle sur soi → aucune boucle infinie");
    }

    // -- 4) POINT FIXE sur une chaîne LONGUE (terminaison + coût linéaire) --
    {
      const N = 60;
      const ports = [{ id: "c0" }];
      for (let i = 1; i < N; i++) ports.push({ id: "c" + i, parent_port_id: "c" + (i - 1) });
      const db = { ports, cables: [] };
      const chain = Cascade.plan("ports", "c0", finderOf(db), fetcherOf(db));
      ck.eq(chain.deletes.length, N - 1, "point fixe : chaîne de 60 ports → 59 suppressions (la cible exclue)");
      ck.eq(chain.deletes[chain.deletes.length - 1].id, "c" + (N - 1), "point fixe : le DERNIER maillon de la chaîne est atteint");
    }

    // -- 5) DÉTACHEMENTS RÉDUITS : un seul par (collection, id, clé), valeur FINALE composée --
    {
      const db = {
        racks: [{ id: "R" }],
        // trois brosses montées dans la baie, toutes sur la MÊME route de câble
        waypoints: [{ id: "B1", kind: "brush", rack_id: "R" }, { id: "B2", kind: "brush", rack_id: "R" }, { id: "B3", kind: "brush", rack_id: "R" }],
        cables: [{ id: "CW", waypoint_ids: ["B1", "W", "B2", "B3"] }],
        cableBundles: [{ id: "BU", waypoint_ids: ["B3", "B1"] }],
        rackItems: [{ id: "RI", rack_id: "R" }],
        equipments: [{ id: "EG", tray_item_id: "RI", placement_mode: "tray", tray_x: 10, tray_y: 20 }],
      };
      const find = finderOf(db), fetch = fetcherOf(db);
      const plan = Cascade.plan("racks", "R", find, fetch);
      ck.eq(idsOf(plan.deletes, "waypoints"), "B1,B2,B3", "baie : les 3 brosses montées sont supprimées");
      ck.eq(idsOf(plan.deletes, "rackItems"), "RI", "baie : l'étagère est supprimée");
      const cw = plan.detaches.filter((d) => d.c === "cables" && d.id === "CW" && d.key === "waypoint_ids");
      ck.eq(cw.length, 1, "route : UN SEUL détachement waypoint_ids par câble (réduction par clé)");
      ck.eq(JSON.stringify(cw[0] && cw[0].value), JSON.stringify(["W"]), "route : les TROIS brosses retirées d'un coup (composition, pas dernier-gagne)");
      const bu = plan.detaches.filter((d) => d.c === "cableBundles" && d.id === "BU" && d.key === "waypoint_ids");
      ck.eq(bu.length, 1, "route de faisceau : un seul détachement waypoint_ids");
      ck.eq(JSON.stringify(bu[0] && bu[0].value), JSON.stringify([]), "route de faisceau : les 2 brosses retirées d'un coup");
      // étagère supprimée par récursion → son hôte redevient « non placé » (4 clés, une entrée chacune)
      const guest = plan.detaches.filter((d) => d.c === "equipments" && d.id === "EG");
      ck.eq(guest.length, 4, "étagère supprimée par la baie : 4 détachements sur l'équipement posé (pas de doublon)");
      ck.eq((guest.find((d) => d.key === "placement_mode") || {}).value, "manual", "équipement posé : replacé en « manual »");
      ck.eq((guest.find((d) => d.key === "tray_item_id") || {}).value, null, "équipement posé : tray_item_id détaché");
    }

    // -- 6) Une entité déjà supprimée par un autre chemin n'est ni re-supprimée ni détachée --
    {
      const db = {
        equipments: [{ id: "E" }],
        ports: [{ id: "PA", equipment_id: "E" }, { id: "PB", equipment_id: "E" }],
        // un câble entre DEUX ports du même équipement est atteint par les deux ports
        cables: [{ id: "CC", from_port_id: "PA", to_port_id: "PB" }],
      };
      const plan = Cascade.plan("equipments", "E", finderOf(db), fetcherOf(db));
      ck.eq(plan.deletes.filter((d) => d.c === "cables").length, 1, "dédup : câble atteint par ses DEUX ports → une seule suppression");
      ck.eq(plan.deletes.length, 3, "dédup : 2 ports + 1 câble");
    }
  }
  });

  await section("shared : Cascade.planMany (plan MULTI-RACINES d'un LOT — composition, dédup, anti-résurrection)", async () => {
  {
    /* UN SEUL plan pour tout un lot de suppressions (docs/placement.md §6.17). Les garanties du moteur
       (composition des retraits de LISTE, anti-cycle, écart des détachements sur entité supprimée) sont
       portées par des accumulateurs valables dans la portée d'UN appel : elles ne valaient donc PAS entre
       deux appels. Attentes EN DUR — comparer `planMany` à `planMany` (ou à `plan`, qui lui délègue
       désormais) serait tautologique. */
    const finderOf = (db) => (coll, field, value) => (db[coll] || []).filter((o) => {
      const v = o[field];
      return Array.isArray(v) ? v.includes(value) : v === value;
    });
    const fetcherOf = (db) => (coll, id) => (db[coll] || []).find((o) => o.id === id) || null;
    const idsOf = (list, coll) => list.filter((d) => d.c === coll).map((d) => d.id).sort().join(",");
    const valueOf = (list, coll, id, key) => {
      const hits = list.filter((d) => d.c === coll && d.id === id && d.key === key);
      return { count: hits.length, value: hits.length ? hits[hits.length - 1].value : undefined };
    };

    // -- 1) LE cas décisif : DEUX waypoints d'une même route, supprimés dans le MÊME lot --
    {
      const db = {
        waypoints: [{ id: "w1" }, { id: "w2" }, { id: "w3" }],
        cables: [{ id: "CW", waypoint_ids: ["w1", "garde", "w2", "w3"] }],
        cableBundles: [{ id: "BU", waypoint_ids: ["w2", "w1"] }],
      };
      const find = finderOf(db), fetch = fetcherOf(db);
      const two = Cascade.planMany([{ collection: "waypoints", id: "w1" }, { collection: "waypoints", id: "w2" }], find, fetch);
      const cw = valueOf(two.detaches, "cables", "CW", "waypoint_ids");
      ck.eq(cw.count, 1, "lot de 2 waypoints : UN SEUL détachement waypoint_ids sur le câble");
      ck.eq(JSON.stringify(cw.value), JSON.stringify(["garde", "w3"]), "lot de 2 waypoints : les DEUX sont retirés de la route (composition INTER-CIBLES)");
      const bu = valueOf(two.detaches, "cableBundles", "BU", "waypoint_ids");
      ck.eq(JSON.stringify(bu.value), JSON.stringify([]), "lot de 2 waypoints : la route du faisceau perd les deux aussi");
      const three = Cascade.planMany([{ collection: "waypoints", id: "w1" }, { collection: "waypoints", id: "w2" }, { collection: "waypoints", id: "w3" }], find, fetch);
      ck.eq(JSON.stringify(valueOf(three.detaches, "cables", "CW", "waypoint_ids").value), JSON.stringify(["garde"]),
        "lot de 3 waypoints : les TROIS retirés, seul le waypoint épargné subsiste");
      ck.eq(three.deletes.length, 0, "lot de waypoints : aucune suppression en cascade (les cibles sont exclues)");
    }

    // -- 2) DEUX groupes d'un même équipement : la liste ET le primaire se composent --
    {
      const db = {
        groups: [{ id: "g1" }, { id: "g2" }, { id: "g3" }],
        equipments: [{ id: "E", group_id: "g1", group_ids: ["g1", "g2", "g3"] }],
        vms: [{ id: "V", group_id: "g2", group_ids: ["g1", "g2"] }],
      };
      const find = finderOf(db), fetch = fetcherOf(db);
      const two = Cascade.planMany([{ collection: "groups", id: "g1" }, { collection: "groups", id: "g2" }], find, fetch);
      ck.eq(JSON.stringify(valueOf(two.detaches, "equipments", "E", "group_ids").value), JSON.stringify(["g3"]),
        "lot de 2 groupes : les DEUX retirés de group_ids de l'équipement");
      ck.eq(valueOf(two.detaches, "equipments", "E", "group_id").value, "g3", "lot de 2 groupes : primaire repointé sur le SEUL groupe survivant");
      ck.eq(JSON.stringify(valueOf(two.detaches, "vms", "V", "group_ids").value), JSON.stringify([]), "lot de 2 groupes : la VM membre est nettoyée pareillement");
      ck.eq(valueOf(two.detaches, "vms", "V", "group_id").value, null, "lot de 2 groupes : primaire de la VM effacé (aucun groupe restant)");
      const all = Cascade.planMany([{ collection: "groups", id: "g1" }, { collection: "groups", id: "g2" }, { collection: "groups", id: "g3" }], find, fetch);
      ck.eq(JSON.stringify(valueOf(all.detaches, "equipments", "E", "group_ids").value), JSON.stringify([]), "lot de 3 groupes : group_ids vidé");
      ck.eq(valueOf(all.detaches, "equipments", "E", "group_id").value, null, "lot de 3 groupes : primaire effacé");
    }

    // -- 3) DEUX réseaux d'un même port (et d'un même câble legacy) : idem --
    {
      const db = {
        networks: [{ id: "n1" }, { id: "n2" }, { id: "n3" }],
        ports: [{ id: "P", network_id: "n1", network_ids: ["n1", "n2", "n3"] }],
        cables: [{ id: "C", network_id: "n2", network_ids: ["n1", "n2"] }],
      };
      const find = finderOf(db), fetch = fetcherOf(db);
      const two = Cascade.planMany([{ collection: "networks", id: "n1" }, { collection: "networks", id: "n2" }], find, fetch);
      ck.eq(JSON.stringify(valueOf(two.detaches, "ports", "P", "network_ids").value), JSON.stringify(["n3"]),
        "lot de 2 réseaux : les DEUX retirés de network_ids du port terminal");
      ck.eq(valueOf(two.detaches, "ports", "P", "network_id").value, "n3", "lot de 2 réseaux : principal du port repointé sur le survivant");
      ck.eq(JSON.stringify(valueOf(two.detaches, "cables", "C", "network_ids").value), JSON.stringify([]), "lot de 2 réseaux : le câble legacy est nettoyé des deux");
      ck.eq(valueOf(two.detaches, "cables", "C", "network_id").value, null, "lot de 2 réseaux : principal du câble effacé");
    }

    // -- 4) DÉDUPLICATION à l'échelle du LOT : une cible du lot n'est jamais re-supprimée par la cascade d'une autre --
    {
      const db = {
        equipments: [{ id: "E" }],
        ports: [{ id: "PA", equipment_id: "E" }, { id: "PB", equipment_id: "E" }],
        cables: [{ id: "CC", from_port_id: "PA", to_port_id: "PB" }],
        aggregates: [{ id: "AG", equipment_id: "E" }],
      };
      const find = finderOf(db), fetch = fetcherOf(db);
      const plan = Cascade.planMany([{ collection: "equipments", id: "E" }, { collection: "ports", id: "PA" }], find, fetch);
      ck.eq(idsOf(plan.deletes, "ports"), "PB", "lot équipement + un de ses ports : le port CIBLE n'est pas re-supprimé, l'autre l'est");
      ck.eq(idsOf(plan.deletes, "cables"), "CC", "lot équipement + un de ses ports : le câble partagé n'est supprimé qu'une fois");
      ck.eq(plan.deletes.length, 3, "lot équipement + un de ses ports : 3 suppressions (PB + CC + AG)");
      ck.eq(new Set(plan.deletes.map((d) => d.c + "/" + d.id)).size, plan.deletes.length, "lot : aucune entité en double dans deletes");
    }

    // -- 5) ANTI-RÉSURRECTION à l'échelle du LOT : un détachement visant une CIBLE du lot est écarté PAR LE PLAN --
    {
      const db = {
        aggregates: [{ id: "AG" }],
        // X est rattaché à l'agrégat ET supprimé par le même lot : le détacher produirait un update
        // sur une ligne supprimée (RESSUSCITANTE côté API), Y survit et doit bien être détaché.
        ports: [{ id: "X", aggregate_id: "AG" }, { id: "Y", aggregate_id: "AG" }],
      };
      const find = finderOf(db), fetch = fetcherOf(db);
      const plan = Cascade.planMany([{ collection: "aggregates", id: "AG" }, { collection: "ports", id: "X" }], find, fetch);
      ck.eq(plan.detaches.filter((d) => d.c === "ports").map((d) => d.id).join(","), "Y",
        "lot : le détachement visant une CIBLE du lot est écarté, celui du port survivant est conservé");
      ck.eq(plan.detaches.some((d) => d.id === "X"), false, "lot : aucune trace de détachement sur une cible du lot");
    }

    // -- 6) `plan()` = ENVELOPPE à une racine : attentes EN DUR, identiques à celles d'une racine unique --
    {
      const db = {
        racks: [{ id: "R" }],
        waypoints: [{ id: "b1", kind: "brush", rack_id: "R" }, { id: "b2", kind: "brush", rack_id: "R" }],
        cables: [{ id: "CR", waypoint_ids: ["b1", "b2", "hors"] }],
        rackItems: [{ id: "RI", rack_id: "R" }],
        equipments: [{ id: "EQ", rack_id: "R", placement_mode: "rack" }],
      };
      const find = finderOf(db), fetch = fetcherOf(db);
      const single = Cascade.planMany([{ collection: "racks", id: "R" }], find, fetch);
      ck.eq(idsOf(single.deletes, "waypoints"), "b1,b2", "une seule racine : les 2 brosses de la baie sont supprimées");
      ck.eq(idsOf(single.deletes, "rackItems"), "RI", "une seule racine : l'étagère est supprimée");
      ck.eq(single.deletes.length, 3, "une seule racine : 3 suppressions");
      ck.eq(JSON.stringify(valueOf(single.detaches, "cables", "CR", "waypoint_ids").value), JSON.stringify(["hors"]),
        "une seule racine : la composition RÉCURSIVE (2 brosses) est intacte");
      ck.eq(valueOf(single.detaches, "equipments", "EQ", "placement_mode").value, "manual", "une seule racine : l'équipement de la baie repasse en manuel");
    }

    // -- 7) Lot VIDE : plan vide (aucune racine à développer) --
    {
      const empty = Cascade.planMany([], finderOf({}), fetcherOf({}));
      ck.eq(empty.deletes.length + empty.detaches.length, 0, "lot vide → plan vide");
    }
  }
  });

  await section("shared : schéma PARTAGÉ (garde anti-divergence front ⇄ back)", async () => {
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
    ck.eq(SharedSchema.isArrayField("group_ids"), true, "isArrayField(group_ids) = true (appartenance multi-groupe)");
    ck.eq(SharedSchema.isArrayField("tags_src"), true, "isArrayField(tags_src) = true (étiquettes VM filtrables)");
    // champs image de façade : la liste PARTAGÉE (purge serveur des orphelines) doit couvrir EXACTEMENT les
    // champs réellement écrits par le front (EQUIP_FACE_IMG_FIELD — carte face → champ).
    {
      const { EQUIP_FACE_IMG_FIELD } = D("domain/constants.js");
      const front = Object.values(EQUIP_FACE_IMG_FIELD).slice().sort();
      const shared = SharedSchema.EQUIPMENT_FACE_IMAGE_FIELDS.slice().sort();
      ck.eq(JSON.stringify(shared), JSON.stringify(front), "EQUIPMENT_FACE_IMAGE_FIELDS === champs front (anti-divergence)");
    }
    // types MIME d'images : liste blanche PARTAGÉE (le front filtre à la sélection, le serveur rejette à l'upload).
    ck.eq(SharedSchema.isImageMime("image/png"), true, "isImageMime(image/png) = true");
    ck.eq(SharedSchema.isImageMime("image/webp"), true, "isImageMime(image/webp) = true");
    ck.eq(SharedSchema.isImageMime("image/svg+xml"), false, "isImageMime(image/svg+xml) = false (risque XSS stocké)");
    ck.eq(SharedSchema.isImageMime("text/html"), false, "isImageMime(text/html) = false");
    ck.eq(SharedSchema.isImageMime(null), false, "isImageMime(null) = false");
    ck.eq(SharedSchema.PAGE_SIZE_ALL >= 1e9, true, "PAGE_SIZE_ALL couvre un document complet (pas de plafond serveur — décision actée)");
  }
  });

  await section("shared : ISOLEMENT du dossier — aucun import hors de src-shared/ (verrou PERMANENT)", async () => {
  {
    /* DEUX RÈGLES DISTINCTES gouvernent les imports de `src-shared/` ; la formulation historique
       « fichier auto-suffisant » les CONFONDAIT (cf. `CLAUDE.md` § « Code partagé front/back ») :

         (1) ISOLEMENT DU DOSSIER — PERMANENT, et c'est CETTE section qui le verrouille. Un fichier
             partagé n'importe RIEN hors de `src-shared/` : ni `src-client/`, ni `src-server/`, ni
             aucun paquet npm / module natif Node. Aucune configuration ne lèvera la règle : importer
             du client ferait embarquer du DOM dans le build SERVEUR, importer du serveur ferait
             embarquer du Node dans le FRONT — et de façon TRANSITIVE, donc INVISIBLE à la relecture
             (le module importé peut être pur aujourd'hui et cesser de l'être demain, sans que
             personne n'ait touché à `src-shared/`). La règle « TS PUR » de `CLAUDE.md` ne parle, elle,
             que du CONTENU d'un fichier : on peut la respecter à la lettre en violant celle-ci.
         (2) IMPORTS ENTRE FICHIERS PARTAGÉS — AUTORISÉS depuis le lot 7 (`resolve.extensionAlias` de
             `webpack.config.js`, cf. docs/placement.md §6.7), à condition IMPÉRATIVE de porter
             l'extension `.js` : NodeNext l'exige côté serveur, l'omettre compile côté front et CASSE
             le build serveur. Vérifié ici aussi, faute de quoi la seule forme légale resterait une
             convention non tenue.

       Le verrou lit les SOURCES `.ts`, jamais le compilé : c'est le spécificateur ÉCRIT par le
       contributeur qu'on contrôle (le compilé, lui, a déjà résolu les alias). */
    const fs = require("fs");
    const sharedDir = path.join(__dirname, "..", "..", "src-shared");

    /* Le DÉTECTEUR d'imports vit dans le harnais (`TsImports.specifiersOf`) : la BORNE §6.6 de
       `PlacementFrame` (test-geometry.js, doctrine §6.22) s'en sert aussi, et le dupliquer serait
       exactement la faute que ces verrous existent pour prévenir (principe n°3). Le contrôle de
       DISCRIMINATION ci-dessous reste ICI, et couvre donc les DEUX verrous. */
    const moduleSpecifiersOf = (text, fileName) => TsImports.specifiersOf(text, fileName);

    // -- contrôle de DISCRIMINATION : le détecteur voit-il VRAIMENT chaque forme, et RIEN d'autre ? --
    // Sans lui, le verrou passerait au vert en ne détectant rien du tout — le pire des états.
    {
      const sonde = [
        'import { A } from "./A.js";',
        'import "./B.js";',
        'import type { C } from "./C.js";',
        'import type D from "./D.js";',
        'export { E } from "./E.js";',
        'export * from "./F.js";',
        'export * as G from "./G.js";',
        'export type { H } from "./H.js";',
        'const i = import("./I.js");',
        'import J = require("./J.js");',
        'const k = require("./K.js");',
        'import {\n  L,\n  M\n} from "./L.js";',
        '// import { Faux } from "../src-client/nope.js";',
        '/* import { Faux2 } from "../src-server/nope2.js"; */',
        'const s = "import { Faux3 } from \\"paquet-npm\\"";',
      ].join("\n");
      const vus = moduleSpecifiersOf(sonde, "sonde.ts");
      const formes = { "./A.js": "import … from", "./B.js": 'import "x" (effet de bord)', "./C.js": "import type { … } from", "./D.js": "import type X from", "./E.js": "export { … } from", "./F.js": "export * from", "./G.js": "export * as N from (RATÉE par preProcessFile seul)", "./H.js": "export type { … } from", "./I.js": "import() dynamique", "./J.js": "import X = require()", "./K.js": "require()", "./L.js": "import multi-lignes" };
      for (const [spec, forme] of Object.entries(formes)) ck(vus.has(spec), "détecteur d'imports : forme COUVERTE — " + forme);
      ck.eq([...vus.keys()].filter((s) => s.includes("nope") || s === "paquet-npm").join(","), "",
        "détecteur d'imports : commentaires et chaînes littérales IGNORÉS (aucun faux positif)");
    }

    // -- le VERROU proprement dit, sur les sources RÉELLES --
    // Parcours RÉCURSIF : `src-shared/` est plat aujourd'hui, la règle doit tenir s'il cesse de l'être.
    const sourcesPartagees = [];
    (function collecte(dir) {
      for (const entree of fs.readdirSync(dir, { withFileTypes: true })) {
        const chemin = path.join(dir, entree.name);
        if (entree.isDirectory()) collecte(chemin);
        else if (entree.name.endsWith(".ts")) sourcesPartagees.push(chemin);
      }
    })(sharedDir);
    sourcesPartagees.sort();
    ck(sourcesPartagees.length >= 5, "src-shared/ : les sources .ts sont bien atteintes (" + sourcesPartagees.length + " fichiers lus)");

    const violations = [];
    const importsInternes = [];
    for (const chemin of sourcesPartagees) {
      const nom = path.relative(sharedDir, chemin).split(path.sep).join("/");
      for (const [spec, ligne] of moduleSpecifiersOf(fs.readFileSync(chemin, "utf8"), nom)) {
        const ou = nom + ":" + ligne + ' → "' + spec + '"';
        if (path.isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)) { violations.push(ou + " — chemin ABSOLU"); continue; }
        if (!spec.startsWith("./") && !spec.startsWith("../")) { violations.push(ou + " — spécificateur NON relatif (paquet npm ou module natif Node)"); continue; }
        const cible = path.resolve(path.dirname(chemin), spec);
        if (cible !== sharedDir && !cible.startsWith(sharedDir + path.sep)) { violations.push(ou + " — SORT de src-shared/"); continue; }
        // Import INTERNE légal (règle 2) : l'extension `.js` reste IMPÉRATIVE.
        if (!spec.endsWith(".js")) violations.push(ou + " — import interne SANS extension `.js` (NodeNext l'exige : compile côté front, CASSE le build serveur)");
        else importsInternes.push(nom + " → " + spec);
      }
    }
    ck.eq(violations.join("  |  "), "",
      "src-shared/ : ISOLEMENT — aucun import hors du dossier (règle PERMANENTE, cf. CLAUDE.md § « Code partagé front/back »)");
    // Anti-vacuité : le verrou doit avoir VU des imports réels, sinon il pourrait « passer » sur des fichiers vides.
    ck(importsInternes.length >= 1, "src-shared/ : le verrou lit des sources RÉELLES — imports internes vus : " + (importsInternes.join(", ") || "AUCUN"));
  }
  });

  await section("shared : baie sans capots (châssis ouvert) — T3/T3b + V6f + waypoint toit", async () => {
  {
    const base = { id: "R1", name: "baie", u_count: 42, width_mm: 600, depth: 1000, sides: "single" };
    const V = (rec, find) => Validation.DataValidator.validateRecord("racks", rec, () => null, find || (() => []));
    // avec capots (défaut) : portes et toit autorisés
    ck.eq(V({ ...base, has_caps: true, door_front: { enabled: true }, roof_cells: ["0,0"] }).length, 0, "avec capots : portes + toit OK");
    // T3 : sans capots ⇒ AUCUNE porte activée
    ck(V({ ...base, has_caps: false, door_front: { enabled: true } }).some((e) => e.path === "has_caps" && e.code === "invariant"), "T3 : sans capots + porte avant → erreur");
    ck(V({ ...base, has_caps: false, door_rear: { enabled: true } }).some((e) => e.path === "has_caps"), "T3 : sans capots + porte arrière → erreur");
    ck.eq(V({ ...base, has_caps: false, door_front: { enabled: false }, door_rear: { enabled: false } }).length, 0, "sans capots + portes désactivées → OK");
    // T3b : sans capots ⇒ TOIT vide ; le SOL reste autorisé (perçable par un waypoint)
    ck(V({ ...base, has_caps: false, roof_cells: ["0,0"] }).some((e) => e.path === "has_caps"), "T3b : sans capots + roof_cells → erreur");
    ck.eq(V({ ...base, has_caps: false, floor_cells: ["0,0"] }).length, 0, "sans capots + floor_cells → OK (sol perçable)");
    // V6f (portée) : conversion bloquée si un waypoint est encore posé sur le TOIT
    const findRoof = (coll, field, value) => (coll === "waypoints" && field === "rack_id" && value === "R1") ? [{ id: "W1", rack_id: "R1", cap_face: "roof" }] : [];
    ck(V({ ...base, has_caps: false }, findRoof).some((e) => e.path === "has_caps" && e.code === "scope"), "V6f : waypoint sur le toit → conversion sans capots refusée");
    const findFloor = (coll, field, value) => (coll === "waypoints" && field === "rack_id" && value === "R1") ? [{ id: "W1", rack_id: "R1", cap_face: "floor" }] : [];
    ck.eq(V({ ...base, has_caps: false }, findFloor).length, 0, "V6f : waypoint au SOL seulement → conversion acceptée");
    // T2 waypoint : poser un waypoint sur le TOIT d'une baie sans capots → refusé (le sol reste permis)
    const fetchOpen = (coll, id) => (coll === "racks" && id === "R1") ? { ...base, has_caps: false } : null;
    ck(Validation.DataValidator.validateRecord("waypoints", { id: "W2", kind: "point", wp_type: "datacenter", rack_id: "R1", cap_face: "roof" }, fetchOpen, () => [])
      .some((e) => e.path === "cap_face" && e.code === "cross_entity"), "waypoint toit sur baie sans capots → erreur");
    ck.eq(Validation.DataValidator.validateRecord("waypoints", { id: "W3", kind: "point", wp_type: "datacenter", rack_id: "R1", cap_face: "floor" }, fetchOpen, () => []).length, 0, "waypoint SOL sur baie sans capots → OK");
  }
  });

  await section("shared : normalisation (forme canonique avant écriture)", async () => {
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
    ck.eq(JSON.stringify(e.group_ids), JSON.stringify([]), "normalize equipments : group_ids défaut → [] (champ tableau)");
    const eg = Validation.DataValidator.normalizeRecord("equipments", { name: "sw", group_ids: ["G1", 5, "G2"] });
    ck.eq(JSON.stringify(eg.group_ids), JSON.stringify(["G1", "G2"]), "normalize equipments : group_ids filtre les non-chaînes (parité network_ids)");
    // LARGEUR RÉELLE d'un boîtier U : bornée au corps utile 19″ (T1e) ; alignement = enum.
    const uwBase = { name: "sw", type: "switch", depth: "full", placement_mode: "rack", u_height: 1, inventory_only: false };
    ck.eq(Validation.DataValidator.validateRecord("equipments", { ...uwBase, u_width_mm: 200, u_align: "left" }).length, 0, "u_width_mm 200 + alignement gauche → OK");
    ck(Validation.DataValidator.validateRecord("equipments", { ...uwBase, u_width_mm: 500 }).some((e) => e.path === "u_width_mm" && e.code === "invariant"), "T1e : u_width_mm > corps utile 19″ (452,6) → erreur");
    ck(Validation.DataValidator.validateRecord("equipments", { ...uwBase, u_align: "diagonal" }).some((e) => e.path === "u_align" && e.code === "enum"), "u_align hors enum → erreur");
    ck.eq(Validation.DataValidator.normalizeRecord("equipments", { name: "sw" }).u_width_mm, null, "normalize : u_width_mm défaut = null (pleine largeur)");
    ck.eq(Validation.DataValidator.normalizeRecord("equipments", { name: "sw" }).u_align, "center", "normalize : u_align défaut = center");
    // invariant T1d : le groupe primaire doit être MEMBRE (∈ group_ids) — parité avec le réseau principal d'un câble.
    ck.eq(Validation.DataValidator.validateRecord("equipments", { name: "sw", type: "switch", depth: "full", placement_mode: "manual", u_height: 1, inventory_only: false, group_id: "G1", group_ids: ["G1", "G2"] }).length, 0,
      "invariant groupe : primaire ∈ group_ids → OK");
    ck.eq(Validation.DataValidator.validateRecord("equipments", { name: "sw", type: "switch", depth: "full", placement_mode: "manual", u_height: 1, inventory_only: false, group_id: "G9", group_ids: ["G1", "G2"] }).some((e) => e.path === "group_id" && e.code === "invariant"),
      true, "invariant groupe : primaire HORS group_ids → erreur sur group_id");
    const passthrough = Validation.DataValidator.normalizeRecord("spares", { whatever: 7 });
    ck.eq(passthrough.whatever, 7, "normalize : champ INCONNU de la spec → traversé inchangé (mécanisme qui porte l'audit)");
    // VERROU DE PLACEMENT (`locked`) : booléen défaut false + coercition "true"→true, sur les 3 collections concernées.
    ["racks", "equipments", "waypoints"].forEach((coll) => {
      ck.eq(Validation.DataValidator.normalizeRecord(coll, { name: "X" }).locked, false, "normalize " + coll + " : locked défaut → false");
      ck.eq(Validation.DataValidator.normalizeRecord(coll, { name: "X", locked: "true" }).locked, true, "normalize " + coll + " : locked 'true' → true (coercition)");
      ck.eq(Validation.DataValidator.normalizeRecord(coll, { name: "X", locked: true }).locked, true, "normalize " + coll + " : locked true préservé");
    });
  }
  });

  await section("shared : salle (datacenters) — dimensions déclarées + hauteurs nullables + doors (json)", async () => {
  {
    const V = Validation.DataValidator;
    // DÉFAUTS posés par la normalisation quand le champ est ABSENT (une écriture tierce peut omettre les dimensions).
    const n = V.normalizeRecord("datacenters", { name: "Salle A" });
    ck.eq(n.width_mm, 6000, "normalize datacenters : width_mm défaut → 6000");
    ck.eq(n.depth_mm, 4000, "normalize datacenters : depth_mm défaut → 4000");
    ck.eq(n.cell_mm, 600, "normalize datacenters : cell_mm défaut → 600");
    ck.eq(n.location, "", "normalize datacenters : location défaut → ''");
    ck.eq(n.floor_x, null, "normalize datacenters : floor_x défaut → null (nullable)");
    ck.eq(n.floor_orientation, 0, "normalize datacenters : floor_orientation défaut → 0");
    // COERCITION numérique (une chaîne « 5000 » d'un POST tiers devient un nombre).
    ck.eq(V.normalizeRecord("datacenters", { name: "X", width_mm: "5000" }).width_mm, 5000, "normalize datacenters : width_mm '5000' → 5000 (number)");
    // HAUTEURS nullables : vide → null ; valeur conservée / coercée.
    ck.eq(n.height_mm, null, "normalize datacenters : height_mm défaut → null");
    ck.eq(n.underfloor_mm, null, "normalize datacenters : underfloor_mm défaut → null");
    ck.eq(V.normalizeRecord("datacenters", { name: "X", underfloor_mm: "300" }).underfloor_mm, 300, "normalize datacenters : underfloor_mm '300' → 300");
    ck.eq(V.validateRecord("datacenters", { name: "X", height_mm: null, underfloor_mm: null }).length, 0, "validate datacenters : hauteurs null → OK (nullable)");
    ck.eq(V.validateRecord("datacenters", { name: "X", height_mm: 2600, underfloor_mm: 400 }).length, 0, "validate datacenters : hauteurs > 0 → OK");
    // BORNE min ≥ 1 : 0 est refusé (dimension et hauteur sous plancher).
    ck(V.validateRecord("datacenters", { name: "X", underfloor_mm: 0 }).some((e) => e.path === "underfloor_mm" && e.code === "min"), "validate datacenters : underfloor_mm 0 → erreur 'min'");
    ck(V.validateRecord("datacenters", { name: "X", width_mm: 0 }).some((e) => e.path === "width_mm" && e.code === "min"), "validate datacenters : width_mm 0 → erreur 'min'");
    // `doors` (tableau d'OBJETS) : déclaré `json` depuis la régularisation D3a — la valeur PRÉSENTE traverse
    // toujours INCHANGÉE (sémantique minimale du type), le CONTENU restant normalisé par Normalize.dcDoors
    // côté client ; l'ABSENCE, elle, reçoit désormais le défaut [] (parité constructeur Datacenter.ts).
    const doors = [{ id: "d1", wall: "top", offset_mm: 100 }];
    ck.eq(JSON.stringify(V.normalizeRecord("datacenters", { name: "X", doors }).doors), JSON.stringify(doors), "normalize datacenters : doors (objets) traversés inchangés (type json)");
    ck.eq(JSON.stringify(V.normalizeRecord("datacenters", { name: "X" }).doors), "[]", "normalize datacenters : doors absent → [] (défaut posé — plus un passthrough)");
  }
  });

  await section("shared : validation intrinsèque (requis / type / enum / borne)", async () => {
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
    ck.eq(Validation.DataValidator.validateRecord("spares", { anything: true }).length, 0, "validate : champ INCONNU de la spec → jamais rejeté (l'audit en dépend)");
    // enchaînement serveur : normalise PUIS valide
    const nv = Validation.DataValidator.normalizeAndValidate("racks", { name: "R", u_count: "42" });
    ck.eq(nv.errors.length, 0, "normalizeAndValidate : '42' normalisé → valide");
    ck.eq(nv.record.u_count, 42, "normalizeAndValidate : record normalisé renvoyé");
  }
  });

  await section("shared : rackItems tray — normalisation + invariant structure ≤ réservation", async () => {
  {
    const n = Validation.DataValidator.normalizeRecord("rackItems", { kind: "tray" });
    ck.eq(n.tray_type, "dual", "normalize : tray_type défaut → dual");
    ck.eq(n.tray_u, 1, "normalize : tray_u défaut → 1");
    ck.eq(n.depth_mm, null, "normalize : depth_mm défaut → null (dual = pleine cage)");
    const bad = Validation.DataValidator.validateRecord("rackItems", { kind: "tray", u_height: 2, tray_u: 3 });
    ck(bad.some((x) => x.path === "tray_u"), "invariant : tray_u (3) > u_height (2) → erreur");
    ck.eq(Validation.DataValidator.validateRecord("rackItems", { kind: "tray", u_height: 3, tray_u: 1, tray_type: "cantilever", depth_mm: 400 }).length, 0, "tray valide → 0 erreur");
    ck.eq(Validation.DataValidator.validateRecord("rackItems", { kind: "blank", u_height: 1, tray_u: 5 }).length, 0, "invariant tray ignoré hors kind tray");
  }
  });

  await section("shared : profondeur de baie — T2c dépassement + V6d dos-à-dos (bloquants)", async () => {
  {
    // Baie 1000 mm, cage 900, marge avant 50 → dispo ancrage avant = 950 ; espace partagé = cage 900.
    const rack = { id: "R1", name: "R", u_count: 42, depth: 1000, cage_depth_mm: 900, front_margin_mm: 50, sides: "dual" };
    const db = { racks: [rack], equipments: [], waypoints: [] };
    const find = (coll, field, value) => (db[coll] || []).filter((o) => o[field] === value);
    const fetch = (coll, id) => (db[coll] || []).find((o) => o.id === id) || null;
    const V = (rec) => Validation.DataValidator.validateRecord("equipments", rec, fetch, find);
    const base = { id: "E1", name: "eq", type: "switch", placement_mode: "rack", rack_id: "R1", rack_u: 10, u_height: 1, rack_side: "front" };
    ck.eq(V({ ...base, depth_mm: 950, locks_u: true }).length, 0, "T2c : 950 ≤ 950 dispo → OK");
    ck(V({ ...base, depth_mm: 951, locks_u: true }).some((x) => x.path === "depth_mm"), "T2c : 951 > 950 dispo → erreur depth_mm");
    // derrière une PORTE : marge de sécurité 100 mm retranchée (parité brosses)
    db.racks.push({ ...rack, id: "R2", door_front: { enabled: true } });
    ck(V({ ...base, rack_id: "R2", depth_mm: 900, locks_u: true }).some((x) => x.path === "depth_mm"), "T2c : porte → 900 > 850 (sécurité déduite) → erreur");
    // LEGACY (depth_mm absent) : jamais sanctionné — sinon d'anciens documents deviendraient invalides
    ck.eq(V({ ...base, depth: "full", depth_mm: null }).length, 0, "legacy sans depth_mm → règles de profondeur ignorées");
    // DOS-À-DOS (V6d) : opposé non verrouillant de 500 mm au même U ; 400+500 = 900 ≤ cage 900 → OK ; 401 → erreur
    db.equipments.push({ id: "E9", name: "opposé", placement_mode: "rack", rack_id: "R1", rack_u: 10, u_height: 1, rack_side: "rear", depth_mm: 500, locks_u: false });
    ck.eq(V({ ...base, depth_mm: 400, locks_u: false }).length, 0, "V6d : 400+500 = 900 ≤ espace partagé → OK");
    ck(V({ ...base, depth_mm: 401, locks_u: false }).some((x) => x.path === "depth_mm" && x.message.includes("Dos-à-dos")), "V6d : 401+500 > 900 → erreur dos-à-dos");
    ck.eq(V({ ...base, rack_u: 11, depth_mm: 900, locks_u: false }).length, 0, "V6d : U disjoints → pas de conflit");
    // l'OPPOSÉ legacy (half sans depth_mm) est ESTIMÉ à sa fraction de cage (0,5 × 900 = 450)
    db.equipments[0] = { ...db.equipments[0], depth_mm: null, depth: "half" };
    ck(V({ ...base, depth_mm: 500, locks_u: false }).some((x) => x.message && x.message.includes("Dos-à-dos")), "V6d : opposé legacy half estimé 450 → 500+450 > 900 → erreur");

    // -- V6d-BROSSE : la brosse (ancrée au plan de montage AVANT) n'occupe plus la face arrière (V6c) —
    // c'est la PROFONDEUR qui protège l'espace, dans les DEUX sens (édition de l'équipement / de la brosse).
    db.waypoints.push({ id: "WB", kind: "brush", rack_id: "R1", rack_u: 20, u_height: 1, depth_mm: 100, name: "Brosse-20" });
    ck.eq(V({ ...base, rack_u: 20, rack_side: "rear", depth_mm: 800, locks_u: false }).length, 0, "V6d-brosse : équipement REAR 800 + brosse 100 = 900 ≤ 900 partagés → OK");
    ck(V({ ...base, rack_u: 20, rack_side: "rear", depth_mm: 801, locks_u: false }).some((x) => x.path === "depth_mm" && x.message.includes("Brosse-20")), "V6d-brosse : 801+100 > 900 → erreur dos-à-dos NOMMANT la brosse");
    ck.eq(V({ ...base, rack_u: 21, rack_side: "rear", depth_mm: 801, locks_u: false }).length, 0, "V6d-brosse : U disjoints → pas de conflit");
    // SYMÉTRIQUE (édition de la BROSSE) : équipement REAR au même U → la somme est jugée sur la brosse.
    const VW = (rec) => Validation.DataValidator.validateRecord("waypoints", rec, fetch, find);
    db.equipments.push({ id: "E30", name: "arrière-30", placement_mode: "rack", rack_id: "R1", rack_u: 30, u_height: 1, rack_side: "rear", depth_mm: 750, locks_u: false });
    ck(VW({ id: "WB2", kind: "brush", rack_id: "R1", rack_u: 30, u_height: 1, depth_mm: 200, name: "B30" }).some((x) => x.path === "depth_mm" && x.message.includes("arrière-30")), "brushBackToBack : 200+750 > 900 → erreur nommant l'équipement");
    ck.eq(VW({ id: "WB2", kind: "brush", rack_id: "R1", rack_u: 30, u_height: 1, depth_mm: 150, name: "B30" }).length, 0, "brushBackToBack : 150+750 = 900 ≤ 900 → OK");
    // brosse SANS depth_mm → défaut 100 (PARITÉ avec le constructeur client Waypoint) : les deux bornes
    // ENCADRENT le défaut à 100 exactement (800 passe → ≤ 100 ; 801 refuse → ≥ 100).
    db.equipments[db.equipments.length - 1].depth_mm = 800;
    ck.eq(VW({ id: "WB3", kind: "brush", rack_id: "R1", rack_u: 30, u_height: 1 }).length, 0, "brushBackToBack : sans depth_mm, défaut+800 ≤ 900 → défaut ≤ 100");
    db.equipments[db.equipments.length - 1].depth_mm = 801;
    ck(VW({ id: "WB3", kind: "brush", rack_id: "R1", rack_u: 30, u_height: 1 }).some((x) => x.path === "depth_mm"), "brushBackToBack : sans depth_mm, défaut+801 > 900 → défaut ≥ 100 (= 100 exactement)");
  }
  });

  await section("shared : équipement posé sur étagère — T1c/T2d/V6e + cascade de détachement", async () => {
  {
    const rack = { id: "R1", name: "R", u_count: 42, depth: 1000, cage_depth_mm: 900, sides: "dual" };
    const tray = { id: "T1", kind: "tray", rack_id: "R1", u: 10, u_height: 3, tray_u: 1, tray_type: "cantilever", depth_mm: 400, side: "front" };
    const db = { racks: [rack], rackItems: [tray, { id: "B1", kind: "blank", rack_id: "R1" }], equipments: [], waypoints: [], cables: [], cableBundles: [] };
    const find = (coll, field, value) => (db[coll] || []).filter((o) => o[field] === value);
    const fetch = (coll, id) => (db[coll] || []).find((o) => o.id === id) || null;
    const V = (rec) => Validation.DataValidator.validateRecord("equipments", rec, fetch, find);
    const base = { id: "E1", name: "posé", type: "other", placement_mode: "tray", tray_item_id: "T1", dim_mode: "free", free_w_mm: 200, free_l_mm: 300, free_h_mm: 80, tray_x: 0, tray_y: 0, dc_orientation: 0 };
    ck.eq(V(base).length, 0, "posé valide (80 ≤ 3 U − 5 mm de tôle) → 0 erreur");
    ck(V(Object.assign({}, base, { tray_item_id: null })).some((x) => x.path === "tray_item_id"), "T1c : mode tray sans étagère → erreur");
    ck(V(Object.assign({}, base, { tray_item_id: "B1" })).some((x) => x.message.includes("pas une étagère")), "T2d : cible non-tray → erreur");
    ck.eq(V(Object.assign({}, base, { free_h_mm: 100 })).length, 0, "T2d : tray_u n'exclut rien — 100 mm ≤ 128,35 mm utiles → OK");
    ck(V(Object.assign({}, base, { free_h_mm: 150 })).some((x) => x.path === "free_h_mm"), "T2d : 150 mm > 128,35 mm utiles (réserve de 5 mm déduite) → erreur");
    ck(V(Object.assign({}, base, { tray_x: 400 })).some((x) => x.path === "tray_x"), "T2d : dépasse le plateau en largeur → erreur");
    // V6e : chevauchement avec un colocataire du plateau
    db.equipments.push({ id: "E9", name: "coloc", placement_mode: "tray", tray_item_id: "T1", free_w_mm: 100, free_l_mm: 300, free_h_mm: 80, tray_x: 50, tray_y: 0, dc_orientation: 0 });
    ck(V(base).some((x) => x.message.includes("Chevauche")), "V6e : chevauchement → erreur");
    ck.eq(V(Object.assign({}, base, { tray_x: 200 })).length, 0, "V6e : positions disjointes → 0 erreur");
    // ROTATION : 90° permute l'empreinte → 300 de large à x=200 dépasse la largeur restante ? 200+300=500 > 463 → refus
    ck(V(Object.assign({}, base, { tray_x: 200, dc_orientation: 90 })).some((x) => x.path === "tray_x"), "rotation 90° re-contrôlée (dépasse en largeur) → erreur");
    // CASCADE : suppression de l'étagère → équipements posés DÉTACHÉS (jamais supprimés)
    const p1 = Cascade.plan("rackItems", "T1", find, fetch);
    ck(p1.detaches.some((d) => d.c === "equipments" && d.id === "E9" && d.key === "tray_item_id" && d.value === null), "cascade étagère : tray_item_id nettoyé");
    ck(p1.detaches.some((d) => d.c === "equipments" && d.id === "E9" && d.key === "placement_mode" && d.value === "manual"), "cascade étagère : retour « non placé »");
    ck.eq(p1.deletes.length, 0, "cascade étagère : aucun équipement supprimé");
    // CASCADE transitive : suppression de la BAIE → étagères supprimées + posés détachés
    const p2 = Cascade.plan("racks", "R1", find, fetch);
    ck(p2.deletes.some((d) => d.c === "rackItems" && d.id === "T1"), "cascade baie : l'étagère est supprimée");
    ck(p2.detaches.some((d) => d.c === "equipments" && d.id === "E9" && d.key === "tray_item_id"), "cascade baie : le posé est détaché (transitif)");
  }
  });

  await section("shared : TrayGeometry — géométrie d'étagère, SOURCE UNIQUE (attentes explicites)", async () => {
  {
    // Ces attentes sont des valeurs EN DUR, jamais une comparaison entre deux implémentations : depuis que
    // RackGeometry.tray* DÉLÈGUE à ce module, comparer les deux ne prouverait plus rien (cf. le piège du lot 2).
    const CAGE = 900;   // profondeur de cage passée en NOMBRE (le module ignore la politique de baie)

    // -- longueur du plateau --
    ck.eq(TrayGeometry.plankLength(CAGE, { tray_type: "dual", depth_mm: 300 }), 906, "dual : façade à façade = cage + 2 × réserve d'oreilles (depth_mm ignoré)");
    ck.eq(TrayGeometry.plankLength(CAGE, { tray_type: "cantilever", depth_mm: 400 }), 400, "porte-à-faux : depth_mm");
    ck.eq(TrayGeometry.plankLength(CAGE, { tray_type: "cantilever", depth_mm: 2000 }), 900, "porte-à-faux : borné à la cage");
    ck.eq(TrayGeometry.plankLength(CAGE, { tray_type: "cantilever", depth_mm: 10 }), 50, "porte-à-faux : plancher de 50 mm");
    ck.eq(TrayGeometry.plankLength(CAGE, { tray_type: "cantilever", depth_mm: null }), 450, "porte-à-faux : défaut TRAY_DEPTH_DEFAULT_MM");

    // -- plateau utile --
    ck.eq(TrayGeometry.fullWidth(), 452.6, "largeur PLEINE = corps 19″ (482,6 − 2 × 15)");
    ck.eq(TrayGeometry.gussetInset({ tray_type: "cantilever" }), 4, "porte-à-faux : garde latérale des renforts");
    ck.eq(TrayGeometry.gussetInset({ tray_type: "dual" }), 0, "dual : aucune garde latérale");
    const dual = TrayGeometry.plank(CAGE, { tray_type: "dual", u_height: 3 });
    ck.eq(dual.W, 452.6, "dual : largeur utilisable = largeur pleine");
    ck.eq(dual.L, 906, "dual : longueur = 906");
    ck(Math.abs(dual.availH - 128.35) < 1e-9, "hauteur libre = 3 U − 5 mm de tôle = 128,35 mm (tray_u n'exclut RIEN)");
    const cant = TrayGeometry.plank(CAGE, { tray_type: "cantilever", u_height: 3, depth_mm: 400, tray_u: 3 });
    ck.eq(cant.W, 444.6, "porte-à-faux : largeur utilisable = 452,6 − 2 × 4");
    ck.eq(cant.L, 400, "porte-à-faux : longueur = depth_mm");
    ck(Math.abs(cant.availH - 128.35) < 1e-9, "hauteur libre INDÉPENDANTE de tray_u (3 U réservés, structure de 3 U)");
    ck(Math.abs(TrayGeometry.plank(CAGE, { tray_type: "dual", u_height: 0 }).availH - 39.45) < 1e-9, "u_height absent/0 → 1 U planché (39,45 mm)");

    // -- empreinte (orientation) --
    const eq = { free_w_mm: 200, free_l_mm: 300, free_h_mm: 80, dc_orientation: 0 };
    ck.eq(JSON.stringify(TrayGeometry.footprint(eq)), JSON.stringify({ w: 200, d: 300, h: 80, rotated: false }), "empreinte 0° : largeur × longueur");
    ck.eq(JSON.stringify(TrayGeometry.footprint({ ...eq, dc_orientation: 90 })), JSON.stringify({ w: 300, d: 200, h: 80, rotated: true }), "empreinte 90° : PERMUTÉE (rotated)");
    ck.eq(JSON.stringify(TrayGeometry.footprint({ ...eq, dc_orientation: 270 })), JSON.stringify({ w: 300, d: 200, h: 80, rotated: true }), "empreinte 270° : permutée");
    ck.eq(TrayGeometry.footprint({ ...eq, dc_orientation: 180 }).rotated, false, "empreinte 180° : NON permutée");
    ck.eq(TrayGeometry.footprint({ ...eq, dc_orientation: -90 }).rotated, true, "angle négatif ramené dans [0, 360[");
    ck.eq(TrayGeometry.footprint({ ...eq, dc_orientation: 450 }).rotated, true, "angle > 360 ramené dans [0, 360[");
    ck.eq(TrayGeometry.footprint({ ...eq, dc_orientation: 45 }).rotated, false, "angle hors 90/270 : aucune permutation");
    // TRONCATURE à l'entier : sémantique du DOMAINE (Normalize.rackOrientation), donc du RENDU. La validation
    // partagée l'ignorait (elle testait l'angle flottant) et pouvait valider une empreinte AUTRE que la dessinée.
    ck.eq(TrayGeometry.footprint({ ...eq, dc_orientation: 90.5 }).rotated, true, "angle non entier TRONQUÉ (90,5 → 90) — parité avec le rendu");
    ck.eq(JSON.stringify(TrayGeometry.footprint({})), JSON.stringify({ w: 200, d: 200, h: 100, rotated: false }), "dimensions absentes → défauts prudents 200 × 200 × 100");

    // -- position au plateau --
    ck.eq(JSON.stringify(TrayGeometry.box({ ...eq, tray_x: 10, tray_y: 10 }, cant)), JSON.stringify({ x0: 10, x1: 210, y0: 10, y1: 310 }), "position saisie : rect au plateau");
    const centre = TrayGeometry.box(eq, cant);   // (444,6 − 200) / 2 = 122,3 en flottant → comparaison à tolérance
    ck(Math.abs(centre.x0 - 122.3) < 1e-9 && Math.abs(centre.x1 - 322.3) < 1e-9, "position absente → CENTRÉ en largeur (122,3 mm)");
    ck.eq(centre.y0, 50, "position absente → CENTRÉ en profondeur ((400 − 300) / 2)");
    ck.eq(centre.y1, 350, "…rect refermé sur l'empreinte");
    ck.eq(TrayGeometry.box({ ...eq, free_w_mm: 600, tray_x: null }, cant).x0, 0, "empreinte plus large que le plateau → centrage borné à 0");
    ck.eq(TrayGeometry.box({ ...eq, tray_x: "10" }, cant).x1, 210, "position en CHAÎNE coercée en nombre (pas de concaténation)");

    // -- chevauchement (tolérance de 0,5 mm) --
    const r = (x0, x1, y0, y1) => ({ x0, x1, y0, y1 });
    ck.eq(TrayGeometry.overlap(r(0, 100, 0, 100), r(100, 200, 0, 100)), false, "bord à bord → pas de chevauchement");
    ck.eq(TrayGeometry.overlap(r(0, 100, 0, 100), r(99.6, 200, 0, 100)), false, "recouvrement de 0,4 mm → toléré");
    ck.eq(TrayGeometry.overlap(r(0, 100, 0, 100), r(99, 200, 0, 100)), true, "recouvrement de 1 mm → chevauchement");
    ck.eq(TrayGeometry.overlap(r(0, 100, 0, 100), r(50, 150, 200, 300)), false, "décalés en profondeur → pas de chevauchement");

    // -- verdict de tenue --
    ck.eq(TrayGeometry.fitProblem({ ...eq, tray_x: 0, tray_y: 0 }, cant), null, "200 × 300 × 80 sur 444,6 × 400 (128,35 utiles) → tient");
    ck.eq(TrayGeometry.fitProblem({ ...eq, free_h_mm: 150, tray_x: 0, tray_y: 0 }, cant).code, "too_high", "150 mm > 128,35 mm utiles → too_high");
    ck.eq(TrayGeometry.fitProblem({ ...eq, free_h_mm: 128, tray_x: 0, tray_y: 0 }, cant), null, "128 mm ≤ 128,35 mm → tient (inclusif)");
    ck.eq(TrayGeometry.fitProblem({ ...eq, free_w_mm: 600, tray_x: 0, tray_y: 0 }, cant).code, "footprint", "empreinte 600 > plateau 444,6 → footprint (indépendant de la position)");
    ck.eq(TrayGeometry.fitProblem({ ...eq, free_l_mm: 900, tray_x: 0, tray_y: 0 }, cant).code, "footprint", "empreinte trop PROFONDE → footprint");
    const over = TrayGeometry.fitProblem({ ...eq, tray_x: 400, tray_y: 0 }, cant);
    ck.eq(over.code, "over_width", "à x = 400, 200 mm de large sort du plateau → over_width");
    ck.eq(over.reached, 600, "over_width : cote atteinte = 600 mm");
    ck.eq(over.at, 400, "over_width : position = 400 mm");
    const deep = TrayGeometry.fitProblem({ ...eq, tray_x: 0, tray_y: 300 }, cant);
    ck.eq(deep.code, "over_depth", "à y = 300, 300 mm de profond sort du plateau → over_depth");
    ck.eq(deep.reached, 600, "over_depth : cote atteinte = 600 mm");
    ck.eq(TrayGeometry.fitProblem({ ...eq, dc_orientation: 90, tray_x: 200, tray_y: 0 }, cant).code, "over_width", "rotation 90° : l'empreinte permutée (300 de large) déborde à x = 200");

    /* -- cotes GÉNÉRALES de baie : la RÉPLIQUE est SUPPRIMÉE, elles ont une source unique.
       ⚠ Les anciennes assertions d'anti-divergence (`TRAY_U_MM === C.U_MM`) sont devenues TAUTOLOGIQUES
       le jour de la bascule : les deux noms désignent désormais le MÊME binding, l'égalité ne pouvait
       plus échouer. Elles sont donc remplacées par des attentes EXPLICITES sur les VALEURS (recette de
       la doctrine §4.1) — seules capables de détecter qu'une cote a été changée par erreur — plus une
       vérification que le front RÉ-EXPORTE bien la source unique au lieu de la redéclarer. */
    const C = D("domain/constants.js");
    const RC = SHARED("src-shared/RackConstants.js");
    ck.eq(RC.U_MM, 44.45, "cote 19″ : hauteur d'un U (mm)");
    ck.eq(RC.RACK_MOUNT_WIDTH_MM, 482.6, "cote 19″ : entraxe des rails (mm)");
    ck.eq(RC.RACK_EAR_MM, 15, "cote 19″ : largeur d'une oreille, par côté (mm)");
    ck.eq(RC.RACK_EAR_STANDOFF_MM, 3, "cote 19″ : réserve d'oreilles devant la cage (mm)");
    ck.eq(RC.RACK_DEPTH_DEFAULT_MM, 1000, "cote de baie : profondeur extérieure par défaut (mm)");
    // le front RÉ-EXPORTE (noms historiques conservés par alias) — plus aucune valeur écrite deux fois.
    ck.eq(C.U_MM, RC.U_MM, "front : `U_MM` ré-exporté depuis la source unique");
    ck.eq(C.RACK_MOUNT_WIDTH, RC.RACK_MOUNT_WIDTH_MM, "front : `RACK_MOUNT_WIDTH` = alias de `RACK_MOUNT_WIDTH_MM`");
    ck.eq(C.RACK_EAR_MM, RC.RACK_EAR_MM, "front : `RACK_EAR_MM` ré-exporté");
    ck.eq(C.RACK_EAR_STANDOFF_MM, RC.RACK_EAR_STANDOFF_MM, "front : `RACK_EAR_STANDOFF_MM` ré-exporté");
    ck.eq(C.RACK_DEPTH_DEFAULT, RC.RACK_DEPTH_DEFAULT_MM, "front : `RACK_DEPTH_DEFAULT` = alias de `RACK_DEPTH_DEFAULT_MM`");
    // et les noms préfixés `TRAY_*` — qui n'avaient rien de propre à une étagère — ont DISPARU.
    ck.eq(TrayGeom.TRAY_U_MM, undefined, "les alias `TRAY_*` des cotes GÉNÉRALES ont disparu (elles ne sont pas propres à l'étagère)");
    ck.eq(TrayGeom.TRAY_MOUNT_WIDTH_MM, undefined, "… idem pour l'entraxe");
    ck(TrayGeom.TRAY_DEPTH_DEFAULT_MM != null, "…mais les cotes VRAIMENT propres à l'étagère restent publiées ici (anti-vacuité)");
    // les cotes PROPRES à l'étagère, elles, ne sont plus répliquées : le front les RÉ-EXPORTE d'ici.
    ck.eq(C.TRAY_DEPTH_DEFAULT_MM, TrayGeom.TRAY_DEPTH_DEFAULT_MM, "cote d'étagère : le front ré-exporte la valeur PARTAGÉE (450)");
    ck.eq(C.TRAY_SHEET_RESERVE_MM, TrayGeom.TRAY_SHEET_RESERVE_MM, "cote d'étagère : réserve de tôle ré-exportée (5)");
    ck.eq(C.TRAY_GUSSET_CLEARANCE_MM, TrayGeom.TRAY_GUSSET_CLEARANCE_MM, "cote d'étagère : garde des renforts ré-exportée (4)");
  }
  });

  /* ============================================================================================
     POLITIQUE DE PROFONDEUR DE BAIE — source UNIQUE (`src-shared/RackDepthPolicy`), consommée par
     la VALIDATION (qui l'IMPORTE) et par le RENDU (`RackGeometry`, qui délègue).

     ⚠ Ces attentes sont EN DUR, jamais une comparaison entre les deux implémentations : elles n'en
     font plus qu'une, la comparaison serait tautologique (doctrine §4.1). La parité a été prouvée
     À PART, avant la bascule, sur 444 528 comparaisons contre l'ancien code relu depuis git —
     ZÉRO divergence avec l'ancienne VALIDATION, et exactement 26 460 avec l'ancien FRONT, toutes
     dans les deux familles ARBITRÉES ci-dessous (§6.14).
     ============================================================================================ */
  await section("shared : politique de PROFONDEUR de baie — source unique, et ses deux CORRECTIONS", async () => {
  {
    const P = RackDepthPolicy;

    // -- profondeur extérieure : 0 et l'absence retombent sur le défaut --
    ck.eq(P.outerDepth({ depth: 800 }), 800, "profondeur extérieure : valeur déclarée");
    ck.eq(P.outerDepth({}), 1000, "profondeur extérieure : absente → défaut 1000");
    ck.eq(P.outerDepth({ depth: 0 }), 1000, "profondeur extérieure : 0 → défaut (une baie plate n'a pas de sens)");

    // -- cage : non déclarée = toute la profondeur --
    ck.eq(P.cage({ depth: 1000 }), 1000, "cage non déclarée → profondeur extérieure");
    ck.eq(P.cage({ depth: 1000, cage_depth_mm: 900 }), 900, "cage déclarée → valeur déclarée");
    ck.eq(P.cage({ depth: 1000, cage_depth_mm: 899.7 }), 899, "cage : troncature à l'entier (| 0)");
    ck.eq(P.cage({ depth: 1000, cage_depth_mm: "" }), 1000, "cage : saisie vide → profondeur extérieure");
    ck.eq(P.cage({ depth: 1000, cage_depth_mm: -5 }), 1000, "cage : valeur négative → profondeur extérieure");

    // ⚠ CORRECTION n°1 (arbitrage §6.14) : la cage est BORNÉE à la profondeur extérieure. Le front ne
    // bornait PAS — il dessinait donc une cage débordant de son propre châssis, et injectait cette valeur
    // non bornée dans la géométrie de plateau. Une cage ne peut pas être plus profonde que le châssis.
    ck.eq(P.cage({ depth: 1000, cage_depth_mm: 1200 }), 1000, "CORRECTION : cage DÉBORDANTE ramenée à la profondeur (1200 → 1000)");
    ck.eq(P.cage({ cage_depth_mm: 1200 }), 1000, "CORRECTION : bornée aussi quand la profondeur est le DÉFAUT");
    ck.eq(P.cage({ depth: 600, cage_depth_mm: 1000 }), 600, "CORRECTION : bornée sur une baie peu profonde");
    ck.eq(P.cage({ depth: 1000, cage_depth_mm: 1000 }), 1000, "cage PILE à la profondeur : inchangée (borne inclusive)");

    // ⚠ CORRECTION n°2 : plus de plancher à 1. Une cage sub-millimétrique vaut 0 (ce que disait déjà la
    // validation) et non 1 (ce que rendait le front) — un `Math.max(1, …)` sur une valeur déjà tronquée.
    ck.eq(P.cage({ depth: 1000, cage_depth_mm: 0.5 }), 0, "CORRECTION : cage de 0,5 mm → 0 (et non 1)");
    ck.eq(P.cage({ depth: 1000, cage_depth_mm: 1.4 }), 1, "cage de 1,4 mm → 1 (troncature, pas plancher)");
    ck.eq(P.cage({ depth: 1000, cage_depth_mm: 0 }), 1000, "cage à 0 → non déclarée → profondeur extérieure");

    // -- marges : la marge avant est bornée par ce que la cage laisse ; l'arrière est le reste --
    ck.eq(P.frontMargin({ depth: 1000, cage_depth_mm: 900 }), 0, "marge avant non saisie → 0");
    ck.eq(P.frontMargin({ depth: 1000, cage_depth_mm: 900, front_margin_mm: 50 }), 50, "marge avant saisie → valeur");
    ck.eq(P.frontMargin({ depth: 1000, cage_depth_mm: 900, front_margin_mm: 500 }), 100, "marge avant BORNÉE : la cage doit tenir (1000 − 900)");
    ck.eq(P.frontMargin({ depth: 1000, cage_depth_mm: 900, front_margin_mm: "" }), 0, "marge avant : saisie vide ≠ 0 saisi → 0");
    ck.eq(P.frontMargin({ depth: 1000, cage_depth_mm: 900, front_margin_mm: -20 }), 0, "marge avant : négative → 0");
    ck.eq(P.rearMargin({ depth: 1000, cage_depth_mm: 900, front_margin_mm: 50 }), 50, "marge arrière = 1000 − cage 900 − avant 50");
    ck.eq(P.rearMargin({ depth: 1000, cage_depth_mm: 900 }), 100, "marge arrière = tout le reste quand l'avant est nul");
    ck.eq(P.rearMargin({ depth: 1000 }), 0, "cage pleine profondeur → aucune marge arrière");
    // conséquence de la CORRECTION n°1 : une cage débordante ne produit plus de marge négative masquée.
    ck.eq(P.frontMargin({ depth: 1000, cage_depth_mm: 1200, front_margin_mm: 50 }), 0, "cage débordante : plus aucune place pour une marge avant");
    ck.eq(P.rearMargin({ depth: 1000, cage_depth_mm: 1200 }), 0, "cage débordante : marge arrière nulle (jamais négative)");

    // -- portes : cavité d'une porte CREUSE, et présence d'au moins une porte --
    ck.eq(P.doorExtra({ door_front: { enabled: true, hollow: true, hollow_mm: 60 } }, "front"), 60, "porte creuse → cavité utile");
    ck.eq(P.doorExtra({ door_front: { enabled: true, hollow: true, hollow_mm: 60 } }, "rear"), 0, "la cavité est lue FACE PAR FACE");
    ck.eq(P.doorExtra({ door_front: { enabled: false, hollow: true, hollow_mm: 60 } }, "front"), 0, "porte DÉSACTIVÉE → aucune cavité");
    ck.eq(P.doorExtra({ door_front: { enabled: true, hollow_mm: 60 } }, "front"), 0, "porte pleine (non creuse) → aucune cavité");
    ck.eq(P.doorExtra({ door_front: { enabled: true, hollow: true, hollow_mm: -3 } }, "front"), 0, "cavité négative → 0");
    ck.eq(P.doorExtra({}, "front"), 0, "aucune porte → aucune cavité");
    ck.eq(P.hasDoor({}), false, "aucune porte → hasDoor faux");
    ck.eq(P.hasDoor({ door_front: { enabled: false } }), false, "porte désactivée → hasDoor faux");
    ck.eq(P.hasDoor({ door_rear: { enabled: true } }), true, "porte ARRIÈRE activée suffit");
    ck.eq(P.door({ door_rear: { enabled: true } }, "rear").enabled, true, "door() rend l'enregistrement de la face demandée");

    // -- la constante n'est plus RÉPLIQUÉE : ce module la RÉ-EXPORTE depuis `RackConstants`, où elle
    //    est vérifiée par sa VALEUR (l'ancienne comparaison front ⇄ partagé serait tautologique).
    //    Ce qui est éprouvé ICI est que la POLITIQUE de profondeur continue de la publier et de s'en
    //    servir comme repli — c'est son comportement, pas l'égalité de deux noms.
    ck.eq(RackDepthPol.RACK_DEPTH_DEFAULT_MM, 1000, "la politique publie toujours la profondeur par défaut (1000 mm)");
    ck.eq(RackDepthPol.RackDepthPolicy.outerDepth({}), 1000, "…et s'en sert de repli quand la baie n'en déclare pas");
    ck.eq(RackDepthPol.RackDepthPolicy.outerDepth({ depth: 0 }), 1000, "…y compris pour une profondeur NULLE (qui n'a pas de sens)");

    // -- le RENDU délègue : `RackGeometry` n'est plus qu'un alias (mêmes signatures, mêmes valeurs) --
    ck.eq(RackGeometry.cageDepth({ depth: 1000, cage_depth_mm: 1200 }), 1000, "RackGeometry.cageDepth : borne désormais, comme la validation");
    ck.eq(RackGeometry.cageDepth({ depth: 1000, cage_depth_mm: 0.5 }), 0, "RackGeometry.cageDepth : plus de plancher à 1");
    ck.eq(RackGeometry.frontMargin({ depth: 1000, cage_depth_mm: 900, front_margin_mm: 500 }), 100, "RackGeometry.frontMargin délègue");
    ck.eq(RackGeometry.rearMargin({ depth: 1000, cage_depth_mm: 900, front_margin_mm: 50 }), 50, "RackGeometry.rearMargin délègue");
    ck.eq(RackGeometry.hasDoor({ door_rear: { enabled: true } }), true, "RackGeometry.hasDoor délègue");
    ck.eq(RackGeometry.doorExtraDepth({ door_front: { enabled: true, hollow: true, hollow_mm: 60 } }, "front"), 60, "RackGeometry.doorExtraDepth délègue");

    // -- effet AVAL de la correction n°1 : le plateau d'une étagère ne peut plus dépasser le châssis --
    // (la cage non bornée était injectée telle quelle dans `TrayGeometry.plank`, cf. §6.7.)
    const trayDual = { kind: "tray", tray_type: "dual", u_height: 2, tray_u: 1 };
    ck.eq(RackGeometry.trayLength({ depth: 1000, cage_depth_mm: 1200 }, trayDual), 1006, "plateau « dual » : cage BORNÉE 1000 + 2 × 3 mm d'oreilles (et non 1206)");
    ck.eq(RackGeometry.trayLength({ depth: 1000, cage_depth_mm: 900 }, trayDual), 906, "plateau « dual » : cas normal inchangé (900 + 6)");
    const trayCant = { kind: "tray", tray_type: "cantilever", u_height: 2, tray_u: 1, depth_mm: 1100 };
    ck.eq(RackGeometry.trayLength({ depth: 1000, cage_depth_mm: 1200 }, trayCant), 1000, "plateau en porte-à-faux : borné à la cage BORNÉE (1000)");
  }
  });

  await section("shared : validation — garde anti-divergence avec le domaine front", async () => {
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
    ck.eq(JSON.stringify(Validation.TRAY_TYPE_IDS.slice()), JSON.stringify(TRAY_TYPES.map((t) => t.id)), "TRAY_TYPE_IDS === domaine TRAY_TYPES");
    ck.eq(JSON.stringify(Validation.SPARE_TYPE_IDS.slice()), JSON.stringify(SPARE_TYPES.map((t) => t.id)), "SPARE_TYPE_IDS === domaine");
    ck.eq(JSON.stringify(Validation.SPARE_STATUS_IDS.slice()), JSON.stringify(SPARE_STATUSES.map((s) => s.id)), "SPARE_STATUS_IDS === domaine");
    ck.eq(JSON.stringify(Validation.EQUIPMENT_FACE_IDS.slice()), JSON.stringify(EQUIP_FACE_IDS.slice()), "EQUIPMENT_FACE_IDS === domaine");
  }
  });

  await section("shared : invariants inter-champs (V3)", async () => {
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
  });

  await section("shared : formats IPv4 / CIDR (IPAM)", async () => {
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
    // -- vm_id (rattachement à une VM, T0.2) : défaut null, FK contrôlée (ref vms), exclusivité SOUPLE équipement/VM --
    ck.eq(Validation.DataValidator.normalizeRecord("ipAddresses", { address: "10.0.0.5" }).vm_id, null, "ipAddresses : vm_id défaut → null (nullable)");
    const vmFetch = (coll, id) => (coll === "vms" && id === "V1") ? { id: "V1" } : ((coll === "equipments" && id === "E1") ? { id: "E1" } : null);
    ck.eq(Validation.DataValidator.validateRecord("ipAddresses", { address: "10.0.0.5", vm_id: "V1" }, vmFetch).length, 0, "ipAddresses : vm_id existant → 0 erreur");
    ck.eq(Validation.DataValidator.validateRecord("ipAddresses", { address: "10.0.0.5", vm_id: "V9" }, vmFetch).some((e) => e.path === "vm_id" && e.code === "ref_missing"), true, "ipAddresses : vm_id inexistant → ref_missing");
    // exclusivité : équipement ET VM → invariant ; un seul (ou aucun) → OK
    ck.eq(Validation.DataValidator.validateRecord("ipAddresses", { address: "10.0.0.5", equipment_id: "E1", vm_id: "V1" }, vmFetch).some((e) => e.path === "vm_id" && e.code === "invariant"), true, "ipAddresses : équipement ET VM → invariant (exclusivité)");
    ck.eq(Validation.DataValidator.validateRecord("ipAddresses", { address: "10.0.0.5", equipment_id: "E1" }, vmFetch).some((e) => e.code === "invariant"), false, "ipAddresses : équipement seul → OK");
    ck.eq(Validation.DataValidator.validateRecord("ipAddresses", { address: "10.0.0.5", vm_id: "V1" }, vmFetch).some((e) => e.code === "invariant"), false, "ipAddresses : VM seule → OK");
    ck.eq(Validation.DataValidator.validateRecord("ipAddresses", { address: "10.0.0.5" }, vmFetch).some((e) => e.code === "invariant"), false, "ipAddresses : ni équipement ni VM → OK (exclusivité souple)");
    ck.eq(Validation.DataValidator.validateRecord("ipNetworks", { label: "N", cidr: "10.0.0.0/24" }).length, 0, "ipNetworks : CIDR valide → 0 erreur");
    ck.eq(Validation.DataValidator.validateRecord("ipNetworks", { cidr: "nope" }).some((e) => e.code === "format"), true, "ipNetworks : CIDR invalide → 'format'");
    // passerelle : format IPv4 + doit appartenir au sous-réseau
    const IPN = { label: "N", cidr: "10.0.0.0/24" };
    ck.eq(Validation.DataValidator.validateRecord("ipNetworks", { ...IPN, gateway: "10.0.0.1" }).length, 0, "ipNetworks : passerelle ∈ CIDR → 0 erreur");
    ck.eq(Validation.DataValidator.validateRecord("ipNetworks", { ...IPN, gateway: "999.0.0.1" }).some((e) => e.code === "format"), true, "ipNetworks : passerelle mal formée → 'format'");
    ck.eq(Validation.DataValidator.validateRecord("ipNetworks", { ...IPN, gateway: "10.9.9.9" }).some((e) => e.code === "invariant" && e.path === "gateway"), true, "ipNetworks : passerelle hors sous-réseau → 'invariant'");
    ck.eq(Validation.DataValidator.normalizeRecord("ipNetworks", { ...IPN }).gateway, null, "ipNetworks : passerelle absente → null (nullable)");
    // serveurs DNS : chaque élément doit être une IPv4 (hors CIDR admis) ; défaut = []
    ck.eq(Validation.DataValidator.validateRecord("ipNetworks", { ...IPN, dns_servers: ["10.0.0.2", "1.1.1.1"] }).length, 0, "ipNetworks : DNS valides (dont externe) → 0 erreur");
    ck.eq(Validation.DataValidator.validateRecord("ipNetworks", { ...IPN, dns_servers: ["1.1.1.1", "nope"] }).some((e) => e.code === "invariant" && e.path === "dns_servers"), true, "ipNetworks : un DNS mal formé → 'invariant'");
    ck.eq(JSON.stringify(Validation.DataValidator.normalizeRecord("ipNetworks", { ...IPN }).dns_servers), "[]", "ipNetworks : DNS défaut → [] (champ tableau)");
    // serveur DHCP : FK equipments (intégrité référentielle V2)
    ck.eq(Validation.DataValidator.normalizeRecord("ipNetworks", { ...IPN }).dhcp_server_id, null, "ipNetworks : serveur DHCP défaut → null (nullable)");
    ck.eq(Validation.DataValidator.validateRecord("ipNetworks", { ...IPN, dhcp_server_id: "nope" }, (coll, i) => (coll === "equipments" && i === "eq1" ? { id: "eq1" } : null)).some((e) => e.path === "dhcp_server_id"), true, "ipNetworks : serveur DHCP FK inexistante → erreur référentielle");
    ck.eq(Validation.DataValidator.validateRecord("ipNetworks", { ...IPN, dhcp_server_id: "eq1" }, (coll, i) => (coll === "equipments" && i === "eq1" ? { id: "eq1" } : null)).length, 0, "ipNetworks : serveur DHCP FK existante → 0 erreur");
  }
  });

  await section("shared : invariants IPAM / réseaux", async () => {
  {
    // réseau power ne peut pas porter d'ip_network_id
    ck.eq(Validation.DataValidator.validateRecord("networks", { kind: "power", ip_network_id: "ipn1" }).some((e) => e.code === "invariant"), true, "invariant : réseau power + ip_network_id → erreur");
    ck.eq(Validation.DataValidator.validateRecord("networks", { label: "N", kind: "data", ip_network_id: "ipn1" }).length, 0, "invariant : réseau data + ip_network_id → OK");
    // plage DHCP : fin ≥ début
    ck.eq(Validation.DataValidator.validateRecord("dhcpRanges", { start_ip: "10.0.0.20", end_ip: "10.0.0.10" }).some((e) => e.code === "invariant"), true, "invariant : plage DHCP fin < début → erreur");
    ck.eq(Validation.DataValidator.validateRecord("dhcpRanges", { start_ip: "10.0.0.10", end_ip: "10.0.0.20" }).length, 0, "invariant : plage DHCP fin ≥ début → 0 erreur");
  }
  });

  await section("shared : dépendance inverse (V5b — re-validation des enfants)", async () => {
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
  });

  await section("shared : T13 — taille de bâtiment DÉCLARÉE, contrainte de débordement des plans d'étage (doctrine §6.8)", async () => {
  {
    const DV = Validation.DataValidator;
    // Deux sites : « s1 » DIMENSIONNÉ (20 m × 10 m), « s2 » sans taille déclarée.
    const sites = { s1: { id: "s1", name: "Liège", width_mm: 20000, depth_mm: 10000 }, s2: { id: "s2", name: "Herstal" } };
    const fetch = (coll, id) => (coll === "sites" ? (sites[id] || null) : null);
    const floor = (over) => ({ id: "f1", location: "s1", floor: "0", width_mm: 6000, depth_mm: 4000, anchor_x: 0, anchor_y: 0, ...over });

    // ---- OPT-IN : la contrainte ne s'applique QU'AUX bâtiments qu'on a choisi de dimensionner. C'est le
    // verrou ANTI-RÉTRO-INVALIDATION exigé par la doctrine : ce lot ne doit rendre invalide aucun document.
    ck.eq(DV.validateRecord("floors", floor({ location: "s2", width_mm: 999999, depth_mm: 999999 }), fetch).length, 0, "site SANS taille déclarée → plan de n'importe quelle dimension accepté (opt-in)");
    // `location` HISTORIQUE (slug LOCATIONS, aucun enregistrement `sites`) : règle NON APPLICABLE. ⚠ C'est
    // pour ce cas que `floors.location` n'est PAS déclaré `ref: "sites"` — la FK rejetterait ces documents.
    ck.eq(DV.validateRecord("floors", floor({ location: "liege", width_mm: 999999, depth_mm: 999999 }), fetch).length, 0, "location HISTORIQUE sans enregistrement sites → aucune erreur (règle non applicable)");
    ck.eq(DV.validateRecord("floors", floor({ location: "" }), fetch).length, 0, "location vide → aucune erreur");
    ck.eq(DV.validateRecord("floors", floor({ width_mm: 999999 })).length, 0, "sans fetch → aucun contrôle cross-entité (parité avec les autres V5)");

    // ---- Site DIMENSIONNÉ : ce qui TIENT passe, ce qui DÉBORDE est rejeté, sur le bon chemin.
    ck.eq(DV.validateRecord("floors", floor(), fetch).length, 0, "plan 6000×4000 dans un bâtiment 20000×10000 → accepté");
    ck.eq(DV.validateRecord("floors", floor({ width_mm: 20000, depth_mm: 10000 }), fetch).length, 0, "plan EXACTEMENT à la taille du bâtiment → accepté (borne inclusive)");
    const tropLarge = DV.validateRecord("floors", floor({ width_mm: 20001 }), fetch);
    ck.eq(tropLarge.length, 1, "plan plus LARGE que son bâtiment → 1 erreur");
    ck.eq(tropLarge[0].code, "cross_entity", "débordement en largeur → code 'cross_entity'");
    ck.eq(tropLarge[0].path, "width_mm", "débordement en largeur → path 'width_mm'");
    const tropProfond = DV.validateRecord("floors", floor({ depth_mm: 10001 }), fetch);
    ck.eq(tropProfond.length, 1, "plan plus PROFOND que son bâtiment → 1 erreur");
    ck.eq(tropProfond[0].path, "depth_mm", "débordement en profondeur → path 'depth_mm'");

    // ---- L'ANCRE fait partie de l'emprise : un plan qui tiendrait à l'origine déborde une fois ancré.
    ck.eq(DV.validateRecord("floors", floor({ width_mm: 15000, anchor_x: 5000 }), fetch).length, 0, "ancre X 5000 + largeur 15000 = 20000 → tient EXACTEMENT");
    ck.eq(DV.validateRecord("floors", floor({ width_mm: 15000, anchor_x: 5001 }), fetch)[0].path, "width_mm", "ancre X 5001 + largeur 15000 > 20000 → rejeté (l'ancre COMPTE)");
    ck.eq(DV.validateRecord("floors", floor({ depth_mm: 8000, anchor_y: 2000 }), fetch).length, 0, "ancre Y 2000 + profondeur 8000 = 10000 → tient EXACTEMENT");
    ck.eq(DV.validateRecord("floors", floor({ depth_mm: 8000, anchor_y: 2001 }), fetch)[0].path, "depth_mm", "ancre Y 2001 + profondeur 8000 > 10000 → rejeté");
    // Le message CITE les valeurs en cause : une erreur muette n'aide personne à corriger sa saisie.
    const msg = DV.validateRecord("floors", floor({ width_mm: 15000, anchor_x: 5001 }), fetch)[0].message;
    ck(msg.indexOf("5001") >= 0 && msg.indexOf("15000") >= 0 && msg.indexOf("20000") >= 0, "le message cite l'ancre, la dimension du plan et la taille du bâtiment  (obtenu : " + msg + ")");

    // ---- V5b : la contrainte tient AUX DEUX BOUTS. Rétrécir un bâtiment sous ses étages est refusé —
    // sinon on interdirait l'étage trop grand tout en laissant silencieusement rapetisser le bâtiment.
    const etages = [floor({ id: "f1", width_mm: 18000, depth_mm: 9000 })];
    const findChildren = (coll, fk, pid) => (coll === "floors" && fk === "location" && pid === "s1") ? etages : [];
    ck.eq(DV.validateDependents("sites", { id: "s1", width_mm: 20000, depth_mm: 10000 }, findChildren, fetch).length, 0, "V5b : bâtiment assez grand pour ses étages → 0 erreur");
    const retreci = DV.validateDependents("sites", { id: "s1", width_mm: 12000, depth_mm: 10000 }, findChildren, fetch);
    ck.eq(retreci.some((e) => e.code === "cross_entity" && e.collection === "floors" && e.id === "f1" && e.path === "width_mm"), true, "V5b : RÉTRÉCIR le bâtiment sous un étage existant → erreur sur l'étage");
    ck.eq(DV.validateDependents("sites", { id: "s1", width_mm: null, depth_mm: null }, findChildren, fetch).length, 0, "V5b : RETIRER la taille déclarée libère la contrainte (opt-in dans les deux sens)");

    // ---- COUPLE INDISSOCIABLE (invariant V3, même raisonnement que lat/lon) : une demi-dimension ne
    // décrit aucune emprise — le rendu retomberait sur l'emprise déduite en laissant croire le bâtiment fixé.
    const site = (over) => DV.normalizeRecord("sites", { id: "sX", name: "X", ...over });
    ck.eq(DV.validateRecord("sites", site({ width_mm: 20000 })).some((e) => e.code === "invariant" && e.path === "depth_mm"), true, "site : largeur SEULE → invariant");
    ck.eq(DV.validateRecord("sites", site({ depth_mm: 10000 })).some((e) => e.code === "invariant" && e.path === "depth_mm"), true, "site : profondeur SEULE → invariant");
    ck.eq(DV.validateRecord("sites", site({ width_mm: 20000, depth_mm: 10000 })).length, 0, "site : couple COMPLET → 0 erreur");
    ck.eq(DV.validateRecord("sites", site({})).length, 0, "site : aucune dimension → 0 erreur (optionnel)");
    ck.eq(DV.validateRecord("sites", site({ width_mm: 0, depth_mm: 10000 })).some((e) => e.code === "min" && e.path === "width_mm"), true, "site : largeur 0 → 'min' (une dimension nulle n'est pas une emprise)");
    const norm = site({});
    ck(norm.width_mm === null && norm.depth_mm === null, "site : dimensions absentes → null à la normalisation");
  }
  });

  await section("shared : borne HAUTE `FieldSpec.max` — appliquée par le moteur, INCLUSIVE (parité stricte avec `min`)", async () => {
  {
    const DV = Validation.DataValidator;
    // RÉGRESSION CORRIGÉE : `sites.lat`/`lon` DÉCLARAIENT `max: 90` / `max: 180` alors que ni l'interface
    // `FieldSpec` ni le moteur ne connaissaient `max` — la borne haute était INERTE. Une latitude de 200
    // passait donc à l'écriture (API tierce comprise), et la contrainte se LISAIT pourtant comme appliquée.
    // Ces tests la VERROUILLENT. ⚠ lat/lon étant INDISSOCIABLES (invariant porté par `lon`), chaque cas
    // renseigne les DEUX coordonnées : sinon l'invariant du couple polluerait le décompte d'erreurs et on
    // croirait éprouver la borne alors qu'on éprouverait l'appariement.
    const site = (lat, lon) => DV.normalizeRecord("sites", { id: "sX", name: "X", lat, lon });

    // ---- Le cas qui passait AVANT le correctif : au-delà de la borne → rejet, bon chemin, bon code.
    const tropAuNord = DV.validateRecord("sites", site(91, 0));
    ck.eq(tropAuNord.length, 1, "lat 91 → exactement 1 erreur (la borne haute, et rien d'autre)");
    ck.eq(tropAuNord[0].path, "lat", "lat 91 → path 'lat'");
    ck.eq(tropAuNord[0].code, "max", "lat 91 → code 'max'");
    ck(tropAuNord[0].message.indexOf("≤ 90") >= 0, "lat 91 → le message CITE la borne dépassée (obtenu : " + tropAuNord[0].message + ")");
    const tropALEst = DV.validateRecord("sites", site(0, 181));
    ck.eq(tropALEst.length, 1, "lon 181 → exactement 1 erreur");
    ck.eq(tropALEst[0].path, "lon", "lon 181 → path 'lon'");
    ck.eq(tropALEst[0].code, "max", "lon 181 → code 'max'");

    // ---- INCLUSIVITÉ : la valeur EXACTEMENT égale à la borne est LÉGITIME (±90 est un pôle, ±180 l'antiméridien),
    // par parité avec `min` dont le moteur ne rejette que `value < min`.
    ck.eq(DV.validateRecord("sites", site(90, 0)).length, 0, "lat 90 (borne EXACTE) → accepté : la borne haute est INCLUSIVE");
    ck.eq(DV.validateRecord("sites", site(0, 180)).length, 0, "lon 180 (borne EXACTE) → accepté");
    ck.eq(DV.validateRecord("sites", site(-90, -180)).length, 0, "lat -90 / lon -180 (bornes basses EXACTES) → accepté : `min` est inclusive de la même façon");
    ck.eq(DV.validateRecord("sites", site(50.6326, 5.5797)).length, 0, "coordonnées ordinaires (Liège) → 0 erreur");

    // ---- La borne BASSE reste active : le correctif AJOUTE `max`, il ne remplace pas `min`.
    ck.eq(DV.validateRecord("sites", site(-91, 0))[0].code, "min", "lat -91 → code 'min' (borne basse intacte)");
    ck.eq(DV.validateRecord("sites", site(0, -181))[0].code, "min", "lon -181 → code 'min'");

    // ---- NULLABLE : un champ non renseigné ne déclenche AUCUNE borne (sinon la coordonnée deviendrait
    // obligatoire de fait, ce que la doctrine `docs/placement.md` §6.9 interdit — le GPS est OPTIONNEL).
    ck.eq(DV.validateRecord("sites", site(null, null)).length, 0, "lat/lon null → aucune borne déclenchée (champ nullable)");
    const normalise = site(null, null);
    ck(normalise.lat === null && normalise.lon === null, "lat/lon absents → null à la normalisation (inchangé)");

    // ---- AUCUNE contrainte INVENTÉE ailleurs : `sites.lat`/`lon` sont les SEULS champs à déclarer un `max`
    // (vérifié sur SPEC_FIELDS). Un champ à `min` seul ne se voit donc poser aucun plafond implicite —
    // c'est la garantie de NON-RÉGRESSION du lot : activer `max` ne peut rétro-invalider aucun document.
    ck.eq(DV.validateRecord("racks", { name: "R", u_count: 100000, width_mm: 600, depth: 1000 }).length, 0, "champ à `min` SEUL (racks.u_count) → aucune borne haute implicite");
    ck.eq(DV.validateRecord("datacenters", { name: "X", width_mm: 9999999 }).length, 0, "champ à `min` SEUL (datacenters.width_mm) → aucun plafond inventé");
  }
  });

  await section("shared : `nullable` n'est PAS vérifié à la validation — trou MESURÉ, verrouillé en l'état", async () => {
  {
    const DV = Validation.DataValidator;
    // MÊME FAMILLE que la borne `max` ci-dessus — une propriété de spec qui se LIT comme appliquée sans l'être —
    // mais l'arbitrage est INVERSE, et c'est le sujet de cette section. `max` a été ACTIVÉE (aucun document ne
    // pouvait être rétro-invalidé) ; `nullable`, lui, reste INERTE À LA VALIDATION, parce que l'activer
    // DURCIRAIT une porte d'écriture. Le moteur portait une branche `if (value === null) { if (!nullable) fail }`
    // INATTEIGNABLE : `isEmpty` absorbe `null` et fait `continue` juste avant. Elle a été retirée ; ces tests
    // remplacent le code mort par l'attente EXPLICITE du comportement réel, pour qu'un rétablissement futur soit
    // un CHOIX (un test à réécrire) et non un effet de bord silencieux.

    // ---- Le trou : `null` explicite sur un champ ni `required`, ni `nullable`, ni pourvu d'un `default`.
    // `racks.width_mm` / `racks.depth` sont exactement ce cas (type "number", `min: 1`, rien d'autre).
    const baie = (extra) => DV.validateRecord("racks", Object.assign({ id: "r1", name: "R", u_count: 42, width_mm: 600, depth: 1000 }, extra));
    ck.eq(baie({}).length, 0, "baie complète → 0 erreur (témoin)");
    ck.eq(baie({ width_mm: null }).length, 0, "width_mm null sur champ NON nullable → ACCEPTÉ (le trou, tel qu'il est aujourd'hui)");
    ck.eq(baie({ depth: null }).length, 0, "depth null → accepté de la même façon");
    ck.eq(DV.validateRecord("contacts", { id: "c1", name: "N", email: null }).length, 0, "contacts.email null → accepté (même cas, type string)");

    // ---- Ce que `null` NE contourne PAS : `required` le rattrape, parce qu'il est testé DANS la branche `isEmpty`.
    // C'est la raison pour laquelle le trou est resté sans conséquence — les champs qui comptent sont requis.
    const sansNom = baie({ name: null });
    ck.eq(sansNom.length, 1, "name null (champ REQUIS) → exactement 1 erreur");
    ck.eq(sansNom[0].code, "required", "name null → code 'required' (et non 'type') : `isEmpty` traite null comme un vide");

    // ---- `nullable` n'est pas pour autant décoratif : il gouverne la NORMALISATION et le type dérivé.
    const normalisee = DV.normalizeRecord("racks", { id: "r1", name: "R", datacenter_id: undefined, width_mm: undefined });
    ck(normalisee.datacenter_id === null, "champ nullable + default null → normalisé à null (rôle RÉEL de `nullable`)");
    ck(normalisee.width_mm === undefined, "champ ni nullable ni pourvu d'un default → laissé TEL QUEL par la normalisation");

    // ---- MESURE du rayon d'action, verrouillée : combien de champs sont dans ce cas. Si ce compte bouge, c'est
    // qu'une spec a gagné (ou perdu) un champ exposé au trou → le relire et DÉCIDER, plutôt que de le découvrir
    // en production. Mesuré à 20 le 2026-07-28, pour 0 enregistrement concerné dans les corpus réel et de démo.
    const exposes = [];
    for (const [collection, spec] of Object.entries(Validation.COLLECTION_SPECS)) {
      for (const [field, fieldSpec] of Object.entries(spec.fields || {})) {
        const aUnDefaut = Object.prototype.hasOwnProperty.call(fieldSpec, "default");
        if (!fieldSpec.required && !fieldSpec.nullable && !aUnDefaut) exposes.push(collection + "." + field);
      }
    }
    ck.eq(exposes.length, 20, "champs exposés au `null` silencieux (ni required, ni nullable, ni default) — compte VERROUILLÉ");
    ck(exposes.indexOf("racks.width_mm") >= 0 && exposes.indexOf("contacts.email") >= 0, "les représentants testés ci-dessus font bien partie de l'ensemble mesuré");
  }
  });

  await section("shared : portée V6a (unicité d'adresse IP)", async () => {
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
  });

  await section("shared : nom d'équipement — trim (normalisation) + unicité V6g", async () => {
  {
    const DV = Validation.DataValidator;
    // -- TRIM à la normalisation : espaces de tête/queue retirés du `name`. --
    ck.eq(DV.normalizeRecord("equipments", { name: "  srv37  " }).name, "srv37", "trim : « ␠srv37␠ » → « srv37 »");
    ck.eq(DV.normalizeRecord("equipments", { name: "srv37" }).name, "srv37", "trim : nom déjà propre inchangé");
    // Nom « tout espaces » → "" après trim → signalé par `required` (comportement voulu).
    ck.eq(DV.normalizeAndValidate("equipments", { name: "   " }).record.name, "", "trim : « ␠␠␠ » → \"\"");
    ck.eq(DV.normalizeAndValidate("equipments", { name: "   " }).errors.some((e) => e.path === "name" && e.code === "required"), true, "trim : nom tout espaces → 'required'");

    // -- UNICITÉ V6g : même mécanisme que V6a (find conscient du lot, comparaison EXACTE, self-exclue). --
    // find simulé EXACT (parité findBy SQL) : un équipement « srv37 » déjà persisté (id E1).
    const persisted = [{ id: "E1", name: "srv37" }];
    const find = (coll, field, value) => (coll === "equipments" && field === "name") ? persisted.filter((r) => r.name === value) : [];
    // SANS find → aucun contrôle de portée.
    ck.eq(DV.validateRecord("equipments", { id: "EX", name: "srv37" }).some((e) => e.code === "scope"), false, "V6g : sans find → pas de contrôle d'unicité");
    // Création d'un nom déjà pris → conflit.
    ck.eq(DV.validateRecord("equipments", { id: "EX", name: "srv37" }, undefined, find).some((e) => e.code === "scope" && e.path === "name"), true, "V6g : nom déjà utilisé (création) → 'scope'");
    // Édition d'un AUTRE équipement VERS un nom déjà pris → conflit.
    ck.eq(DV.validateRecord("equipments", { id: "E2", name: "srv37" }, undefined, find).some((e) => e.code === "scope"), true, "V6g : édition vers un nom pris → 'scope'");
    // « Sauf moi-même » : ré-enregistrer E1 avec son propre nom → OK (édition sans changer le nom).
    ck.eq(DV.validateRecord("equipments", { id: "E1", name: "srv37" }, undefined, find).some((e) => e.code === "scope"), false, "V6g : même entité garde son nom → OK");
    // Nom libre → OK.
    ck.eq(DV.validateRecord("equipments", { id: "EX", name: "srv40" }, undefined, find).some((e) => e.code === "scope"), false, "V6g : nom libre → OK");
    // CASSE DIFFÉRENTE = noms DISTINCTS pour l'unicité (comparaison exacte) : « SRV37 » légal à côté de « srv37 ».
    ck.eq(DV.validateRecord("equipments", { id: "EX", name: "SRV37" }, undefined, find).some((e) => e.code === "scope"), false, "V6g : casse différente (« SRV37 ») ≠ « srv37 » → OK (unicité exacte)");
    // Conscient du lot : deux créations du MÊME nom dans un /transact → conflit.
    const batch = { creates: [{ collection: "equipments", record: { id: "n1", name: "srv50" } }, { collection: "equipments", record: { id: "n2", name: "srv50" } }] };
    const batchFind = DV.buildBatchChildFinder(find, batch);
    ck.eq(DV.validateRecord("equipments", { id: "n1", name: "srv50" }, undefined, batchFind).some((e) => e.code === "scope"), true, "V6g batch : doublon créé dans le lot → 'scope'");
  }
  });

  await section("shared : nom de câble — trim (normalisation) + unicité V6h (miroir V6g)", async () => {
  {
    const DV = Validation.DataValidator;
    // -- TRIM à la normalisation : `cables.name` est désormais un champ déclaré (trim opt-in). --
    ck.eq(DV.normalizeRecord("cables", { name: "  patch-A12  " }).name, "patch-A12", "trim câble : « ␠patch-A12␠ » → « patch-A12 »");
    // Nom ABSENT toléré (name NON `required`) → aucune erreur intrinsèque (au contraire de l'équipement).
    ck.eq(DV.normalizeAndValidate("cables", { status: "planifie" }).errors.some((e) => e.path === "name" && e.code === "required"), false, "câble sans nom → pas de 'required' (câbles anonymes légaux)");

    // -- UNICITÉ V6h : même mécanisme que V6g/V6a (find conscient du lot, comparaison EXACTE, self-exclue). --
    // find simulé EXACT (parité findBy SQL / scan store) : un câble « patch-A12 » déjà persisté (id C1).
    const persisted = [{ id: "C1", name: "patch-A12" }];
    const find = (coll, field, value) => (coll === "cables" && field === "name") ? persisted.filter((r) => r.name === value) : [];
    // SANS find → aucun contrôle de portée.
    ck.eq(DV.validateRecord("cables", { id: "CX", status: "planifie", name: "patch-A12" }).some((e) => e.code === "scope"), false, "V6h : sans find → pas de contrôle d'unicité");
    // Création d'un nom déjà pris → conflit rattaché à `name`.
    ck.eq(DV.validateRecord("cables", { id: "CX", status: "planifie", name: "patch-A12" }, undefined, find).some((e) => e.code === "scope" && e.path === "name"), true, "V6h : nom déjà utilisé (création) → 'scope'");
    // Édition d'un AUTRE câble VERS un nom déjà pris → conflit.
    ck.eq(DV.validateRecord("cables", { id: "C2", status: "planifie", name: "patch-A12" }, undefined, find).some((e) => e.code === "scope"), true, "V6h : édition vers un nom pris → 'scope'");
    // « Sauf moi-même » : ré-enregistrer C1 avec son propre nom → OK.
    ck.eq(DV.validateRecord("cables", { id: "C1", status: "planifie", name: "patch-A12" }, undefined, find).some((e) => e.code === "scope"), false, "V6h : même câble garde son nom → OK");
    // Nom libre → OK.
    ck.eq(DV.validateRecord("cables", { id: "CX", status: "planifie", name: "patch-Z99" }, undefined, find).some((e) => e.code === "scope"), false, "V6h : nom libre → OK");
    // NOM VIDE toléré en MULTIPLE : plusieurs câbles sans nom coexistent (name non `required`).
    const anon = [{ id: "C1", name: "" }, { id: "C2", name: "" }];
    const findAnon = (coll, field, value) => (coll === "cables" && field === "name") ? anon.filter((r) => r.name === value) : [];
    ck.eq(DV.validateRecord("cables", { id: "CX", status: "planifie", name: "" }, undefined, findAnon).some((e) => e.code === "scope"), false, "V6h : nom vide → jamais en conflit (câbles anonymes légaux)");
    // TRIM + unicité : « patch-A12␠␠ » normalisé en « patch-A12 » entre en conflit avec l'existant.
    const trimmed = DV.normalizeAndValidate("cables", { id: "CX", status: "planifie", name: "patch-A12  " }, undefined, find);
    ck.eq(trimmed.record.name, "patch-A12", "V6h trim : « patch-A12␠␠ » → « patch-A12 »");
    ck.eq(trimmed.errors.some((e) => e.code === "scope" && e.path === "name"), true, "V6h trim : « patch-A12␠␠ » entre en conflit avec « patch-A12 » (doublon post-trim)");
    // CASSE DISCRIMINANTE : « PATCH-A12 » ≠ « patch-A12 » → légal (comparaison exacte).
    ck.eq(DV.validateRecord("cables", { id: "CX", status: "planifie", name: "PATCH-A12" }, undefined, find).some((e) => e.code === "scope"), false, "V6h : casse différente (« PATCH-A12 ») ≠ « patch-A12 » → OK (unicité exacte)");
    // Conscient du lot : deux créations du MÊME nom dans un /transact → conflit.
    const batch = { creates: [{ collection: "cables", record: { id: "n1", status: "planifie", name: "patch-B7" } }, { collection: "cables", record: { id: "n2", status: "planifie", name: "patch-B7" } }] };
    const batchFind = DV.buildBatchChildFinder(find, batch);
    ck.eq(DV.validateRecord("cables", { id: "n1", status: "planifie", name: "patch-B7" }, undefined, batchFind).some((e) => e.code === "scope"), true, "V6h batch : doublon créé dans le lot → 'scope'");
  }
  });

  await section("shared : portée V6b (1 câble/port, intervalles DHCP)", async () => {
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
  });

  await section("shared : portée V6c (collision de U en baie)", async () => {
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
    // tray PLEINE PROFONDEUR (type "dual") : occupe les DEUX faces au même U → un occupant dos à dos entre en collision.
    occ.item = [{ id: "T5", kind: "tray", rack_id: "RK", side: "front", u: 5, u_height: 1, tray_type: "dual" }];
    const findI = (c, f, v) => (c === "rackItems" && f === "rack_id" && v === "RK") ? occ.item : find(c, f, v);
    ck.eq(DV.validateRecord("equipments", { id: "EX", name: "x", placement_mode: "rack", rack_id: "RK", rack_u: 5, u_height: 1, depth: "half", rack_side: "front" }, fetch, findI).some((e) => e.code === "scope"), true, "V6c : tray dual @U5 → collision face front");
    ck.eq(DV.validateRecord("equipments", { id: "EX", name: "x", placement_mode: "rack", rack_id: "RK", rack_u: 5, u_height: 1, depth: "half", rack_side: "rear" }, fetch, findI).some((e) => e.code === "scope"), true, "V6c : tray pleine profondeur occupe AUSSI la face REAR → collision");
    occ.item[0].tray_type = "cantilever";
    ck.eq(DV.validateRecord("equipments", { id: "EX", name: "x", placement_mode: "rack", rack_id: "RK", rack_u: 5, u_height: 1, depth: "half", rack_side: "rear" }, fetch, findI).length, 0, "V6c : tray cantilever (front) → face REAR libre");
    // BROSSE : ancrée au plan de montage AVANT → n'occupe QUE la face front. L'arrière n'est bloqué que
    // par la PROFONDEUR (V6d-brosse, testé dans la section T2c/V6d) — plus par une collision de cellule.
    occ.wp = [{ id: "WB", kind: "brush", rack_id: "RK", rack_u: 7, u_height: 2, name: "B7" }];
    const findW = (c, f, v) => (c === "waypoints" && f === "rack_id" && v === "RK") ? occ.wp : findI(c, f, v);
    ck.eq(DV.validateRecord("equipments", { id: "EX", name: "x", placement_mode: "rack", rack_id: "RK", rack_u: 7, u_height: 1, depth: "half", rack_side: "front" }, fetch, findW).some((e) => e.code === "scope"), true, "V6c : brosse @U7 → collision face FRONT");
    ck.eq(DV.validateRecord("equipments", { id: "EX", name: "x", placement_mode: "rack", rack_id: "RK", rack_u: 7, u_height: 1, depth: "half", rack_side: "rear" }, fetch, findW).length, 0, "V6c : brosse = face AVANT seule → face REAR libre (plus de collision)");
  }
  });

  await section("shared : règles métier T1 (invariants) / T2 (cross-entité)", async () => {
  {
    const DV = Validation.DataValidator;
    // T1 — équipement : placement_mode rack ⇒ rack_id requis
    // T1 — équipement : PLACÉ à un U (rack_u renseigné) ⇒ rack_id requis. L'état POOL (placement_mode "rack"
    // SANS rack_u ni rack_id) est VALIDE (équipement U non encore placé — cf. Store.unrackedEquipments).
    ck.eq(DV.validateRecord("equipments", { name: "e", placement_mode: "rack", rack_id: null, rack_u: 5 }).some((x) => x.code === "invariant" && x.path === "rack_id"), true, "T1 equip : placé à un U sans baie → invariant");
    ck.eq(DV.validateRecord("equipments", { name: "e", placement_mode: "rack", rack_id: null }).some((x) => x.code === "invariant" && x.path === "rack_id"), false, "T1 equip : pool (rack sans U ni baie) → VALIDE");
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
    // T4 — port de patch : affectation de brins (faisceau requis, appariement Tx/Rx cohérent)
    ck.eq(DV.validateRecord("ports", { strand_a: 1 }).some((x) => x.code === "invariant" && x.path === "bundle_id"), true, "T4 port : brin sans faisceau → invariant");
    ck.eq(DV.validateRecord("ports", { bundle_id: "B", strand_b: 2 }).some((x) => x.code === "invariant" && x.path === "strand_b"), true, "T4b port : brin Rx sans Tx → invariant");
    ck.eq(DV.validateRecord("ports", { bundle_id: "B", strand_a: 1, strand_b: 1 }).some((x) => x.code === "invariant" && x.path === "strand_b"), true, "T4c port : Tx=Rx (même fibre) → invariant");
    ck.eq(DV.validateRecord("ports", { bundle_id: "B", strand_a: 1, strand_b: 2 }).some((x) => x.code === "invariant"), false, "T4 port : duplex 1/2 → OK");
    ck.eq(DV.validateRecord("ports", { bundle_id: "B", strand_a: 3 }).some((x) => x.code === "invariant"), false, "T4 port : simplex → OK");
    // T5 — port terminal : réseau principal ∈ réseaux assertés (miroir de la règle câble)
    ck.eq(DV.validateRecord("ports", { network_id: "n9", network_ids: ["n1", "n2"] }).some((x) => x.code === "invariant" && x.path === "network_id"), true, "T5 port : réseau principal ∉ réseaux → invariant");
    ck.eq(DV.validateRecord("ports", { network_id: "n1", network_ids: ["n1"] }).some((x) => x.code === "invariant" && x.path === "network_id"), false, "T5 port : principal ∈ réseaux → OK");
    // T8 — phase seulement sur un port source (rôle power : sinon T12 refuserait déjà la direction).
    ck.eq(DV.validateRecord("ports", { role: "power", phase: "L1", direction: "sink" }).some((x) => x.code === "invariant" && x.path === "phase"), true, "T8 port : phase sur un sink → invariant");
    ck.eq(DV.validateRecord("ports", { role: "power", phase: "L1", direction: "source" }).some((x) => x.code === "invariant" && x.path === "phase"), false, "T8 port : phase sur une source → OK");
    // T12 — la direction (source/sink) est réservée aux ports d'ÉNERGIE (rôle power ou poe).
    ck.eq(DV.validateRecord("ports", { role: "data", direction: "source" }).some((x) => x.code === "invariant" && x.path === "direction"), true, "T12 port : direction sur un rôle data → invariant");
    ck.eq(DV.validateRecord("ports", { role: "power", direction: "source" }).some((x) => x.code === "invariant" && x.path === "direction"), false, "T12 port : direction sur un rôle power → OK");
    ck.eq(DV.validateRecord("ports", { role: "poe", direction: "source" }).some((x) => x.code === "invariant" && x.path === "direction"), false, "T12 port : direction sur un rôle poe → OK");
    ck.eq(DV.validateRecord("ports", { role: "data", direction: "" }).some((x) => x.code === "invariant" && x.path === "direction"), false, "T12 port : direction vide sur data → OK");
    // T6 — brin ≤ fiber_count du faisceau (crossEntity, via fetch)
    const bundleFetch = (c, i) => (c === "cableBundles" && i === "B12") ? { id: "B12", fiber_count: 12 } : null;
    ck.eq(DV.validateRecord("ports", { bundle_id: "B12", strand_a: 13 }, bundleFetch).some((x) => x.code === "cross_entity" && x.path === "strand_a"), true, "T6 port : brin 13 > 12 fibres → cross_entity");
    ck.eq(DV.validateRecord("ports", { bundle_id: "B12", strand_a: 1, strand_b: 2 }, bundleFetch).some((x) => x.code === "cross_entity"), false, "T6 port : brins 1/2 ≤ 12 → OK");
    // T7 — un port de patch n'assert pas de réseau (crossEntity, via fetch equipments)
    const patchFetch = (c, i) => (c === "equipments" && i === "PP") ? { id: "PP", type: "patch_panel" } : (c === "equipments" && i === "SW") ? { id: "SW", type: "switch" } : null;
    ck.eq(DV.validateRecord("ports", { equipment_id: "PP", network_ids: ["n1"], network_id: "n1" }, patchFetch).some((x) => x.code === "cross_entity" && x.path === "network_ids"), true, "T7 port : réseau sur un port de patch → cross_entity");
    ck.eq(DV.validateRecord("ports", { equipment_id: "SW", network_ids: ["n1"], network_id: "n1" }, patchFetch).some((x) => x.code === "cross_entity"), false, "T7 port : réseau sur un switch → OK");
    // V6 — unicité de brin par extrémité (scope, via find)
    const strandFind = (c, f, v) => (c === "ports" && f === "bundle_id" && v === "B12") ? [{ id: "P1", equipment_id: "E1", bundle_id: "B12", strand_a: 1, strand_b: 2 }] : [];
    ck.eq(DV.validateRecord("ports", { id: "P2", equipment_id: "E1", bundle_id: "B12", strand_a: 2 }, undefined, strandFind).some((x) => x.code === "scope"), true, "V6 port : même patch, brin déjà pioché → scope");
    ck.eq(DV.validateRecord("ports", { id: "P2", equipment_id: "E2", bundle_id: "B12", strand_a: 2 }, undefined, strandFind).some((x) => x.code === "scope"), false, "V6 port : AUTRE extrémité, même brin → OK (les 2 bouts d'une fibre)");
    ck.eq(DV.validateRecord("ports", { id: "P2", equipment_id: "E1", bundle_id: "B12", strand_a: 5 }, undefined, strandFind).some((x) => x.code === "scope"), false, "V6 port : même patch, brin libre → OK");
    // T9 — câble d'alimentation : source↔sink obligatoire (pas deux mêmes sens). Rôles EXPLICITES (power/poe) : T12
    // impose la direction sur un port d'énergie, et T9b exige un genre homogène (cf. plus bas).
    const dirFetch = (c, i) => (c === "ports") ? ({
      src1: { id: "src1", role: "power", direction: "source" }, src2: { id: "src2", role: "power", direction: "source" },
      snk1: { id: "snk1", role: "power", direction: "sink" }, dat1: { id: "dat1", role: "data", direction: "" },
      poeSrc: { id: "poeSrc", role: "poe", direction: "source" }, poeSnk: { id: "poeSnk", role: "poe", direction: "sink" },
    })[i] || null : null;
    ck.eq(DV.validateRecord("cables", { status: "planifie", from_port_id: "src1", to_port_id: "src2" }, dirFetch).some((x) => x.code === "cross_entity" && x.path === "to_port_id"), true, "T9 câble : source↔source → cross_entity");
    ck.eq(DV.validateRecord("cables", { status: "planifie", from_port_id: "src1", to_port_id: "snk1" }, dirFetch).some((x) => x.code === "cross_entity"), false, "T9 câble : source↔sink → OK");
    ck.eq(DV.validateRecord("cables", { status: "planifie", from_port_id: "src1", to_port_id: "dat1" }, dirFetch).some((x) => x.code === "cross_entity"), false, "T9 câble : source↔data (sens vide) → non concerné");
    // T9b — câble d'énergie de genre HOMOGÈNE : power↔power ou PoE↔PoE, jamais poe↔power.
    ck.eq(DV.validateRecord("cables", { status: "planifie", from_port_id: "poeSrc", to_port_id: "snk1" }, dirFetch).some((x) => x.code === "cross_entity" && x.path === "to_port_id"), true, "T9b câble : PoE(source)↔power(sink) → cross_entity (genre mixte)");
    ck.eq(DV.validateRecord("cables", { status: "planifie", from_port_id: "poeSrc", to_port_id: "poeSnk" }, dirFetch).some((x) => x.code === "cross_entity"), false, "T9b câble : PoE↔PoE (source/sink) → OK");
    ck.eq(DV.validateRecord("cables", { status: "planifie", from_port_id: "src1", to_port_id: "snk1" }, dirFetch).some((x) => x.code === "cross_entity"), false, "T9b câble : power↔power (source/sink) → OK");
    // T10 — faisceau : deux extrémités DISTINCTES (miroir du self-loop câble)
    ck.eq(DV.validateRecord("cableBundles", { name: "T", endpoint_a_equipment_id: "PP1", endpoint_b_equipment_id: "PP1" }).some((x) => x.code === "invariant" && x.path === "endpoint_b_equipment_id"), true, "T10 faisceau : A = B → invariant");
    ck.eq(DV.validateRecord("cableBundles", { name: "T", endpoint_a_equipment_id: "PP1", endpoint_b_equipment_id: "PP2" }).some((x) => x.code === "invariant"), false, "T10 faisceau : A ≠ B → OK");
    ck.eq(DV.validateRecord("cableBundles", { name: "T", endpoint_a_equipment_id: null, endpoint_b_equipment_id: null }).some((x) => x.code === "invariant"), false, "T10 faisceau : extrémités vides → non concerné");
    // T11 — faisceau : les extrémités sont des PATCH PANELS (crossEntity, via fetch equipments — une règle par bout)
    const bundleEndFetch = (c, i) => (c === "equipments") ? ({ PP1: { id: "PP1", type: "patch_panel" }, PP2: { id: "PP2", type: "patch_panel" }, SW: { id: "SW", type: "switch" } })[i] || null : null;
    ck.eq(DV.validateRecord("cableBundles", { name: "T", endpoint_a_equipment_id: "SW", endpoint_b_equipment_id: "PP2" }, bundleEndFetch).some((x) => x.code === "cross_entity" && x.path === "endpoint_a_equipment_id"), true, "T11 faisceau : extrémité A = switch → cross_entity (chemin A)");
    ck.eq(DV.validateRecord("cableBundles", { name: "T", endpoint_a_equipment_id: "PP1", endpoint_b_equipment_id: "SW" }, bundleEndFetch).some((x) => x.code === "cross_entity" && x.path === "endpoint_b_equipment_id"), true, "T11 faisceau : extrémité B = switch → cross_entity (chemin B)");
    ck.eq(DV.validateRecord("cableBundles", { name: "T", endpoint_a_equipment_id: "PP1", endpoint_b_equipment_id: "PP2" }, bundleEndFetch).length, 0, "T11 faisceau : 2 patchs distincts → OK");
    ck.eq(DV.validateRecord("cableBundles", { name: "T", endpoint_a_equipment_id: null, endpoint_b_equipment_id: null }, bundleEndFetch).length, 0, "T11 faisceau : extrémités vides → non concerné");
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
  });

  await section("shared : collection vms (modèle, invariant nics.ips, cascade hôte)", async () => {
  {
    const DV = Validation.DataValidator;
    const { Vm } = D("models/Vm.js");
    // -- normalisation au constructeur (patterns Equipment : strings || "", FK || null, booléens ===, tableaux filtrés) --
    const def = new Vm({});
    ck.eq(def.vm_type, "qemu", "Vm : vm_type défaut → qemu");
    ck.eq(def.status, "", "Vm : status défaut → '' (tolérant)");
    ck.eq(def.host_equipment_id, null, "Vm : host_equipment_id défaut → null (FK LOCALE)");
    ck.eq(def.orphan, false, "Vm : orphan défaut → false");
    ck.eq(def.cpu, null, "Vm : cpu défaut → null");
    ck.eq(JSON.stringify(def.tags_src), "[]", "Vm : tags_src défaut → [] (tableau de scalaires)");
    ck.eq(JSON.stringify(def.nics), "[]", "Vm : nics défaut → [] (tableau d'objets)");
    // vNIC EMBARQUÉE, normalisée par Vm.normalizeNic (jamais un port câblable)
    const withNic = new Vm({ name: "web", nics: [{ name: "net0", mac: "AA:BB", bridge: "vmbr0", vlan_tag: "42", ips: ["10.0.0.5", 7, ""] }] });
    ck.eq(withNic.nics.length, 1, "Vm : une vNIC normalisée");
    ck.eq(withNic.nics[0].vlan_tag, 42, "Vm : vlan_tag '42' → 42 (number)");
    ck.eq(JSON.stringify(withNic.nics[0].ips), JSON.stringify(["10.0.0.5"]), "Vm : nics.ips filtre les non-chaînes/vides");
    // GROUPES : parité Equipment — primaire TOUJOURS en tête de group_ids, dédupliqué
    const g = new Vm({ name: "g", group_id: "G1", group_ids: ["G2", "G1"] });
    ck.eq(JSON.stringify(g.group_ids), JSON.stringify(["G1", "G2"]), "Vm : group_id primaire en tête de group_ids (parité Equipment)");
    // -- l'entité par défaut satisfait la spec partagée --
    ck.eq(DV.validateRecord("vms", new Vm({ name: "web" }).toJSON()).length, 0, "Vm(name) satisfait la spec");
    ck.eq(DV.validateRecord("vms", new Vm({}).toJSON()).some((e) => e.path === "name" && e.code === "required"), true, "Vm sans nom → 'required'");
    // -- type/statut TOLÉRANTS : une valeur inconnue est acceptée (résilience aux releases Proxmox) --
    ck.eq(DV.validateRecord("vms", new Vm({ name: "x", status: "suspended", vm_type: "kvm" }).toJSON()).length, 0, "Vm : type/statut inconnus acceptés (tolérance)");
    // -- invariant nics.ips : chaque IP doit être une IPv4 valide (même style que ipNetworks.dns_servers) --
    ck.eq(DV.validateRecord("vms", { name: "x", nics: [{ name: "net0", ips: ["10.0.0.5", "192.168.1.1"] }] }).length, 0, "Vm : IPs de vNIC valides → 0 erreur");
    ck.eq(DV.validateRecord("vms", { name: "x", nics: [{ name: "net0", ips: ["10.0.0.5", "999.0.0.1"] }] }).some((e) => e.path === "nics" && e.code === "invariant"), true, "Vm : IP de vNIC mal formée → 'invariant'");
    // -- FK host_equipment_id : intégrité référentielle (V2, via fetch) --
    const eqFetch = (coll, id) => (coll === "equipments" && id === "E1") ? { id: "E1" } : null;
    ck.eq(DV.validateRecord("vms", { name: "x", host_equipment_id: "E1" }, eqFetch).length, 0, "Vm : host_equipment_id existant → 0 erreur");
    ck.eq(DV.validateRecord("vms", { name: "x", host_equipment_id: "E9" }, eqFetch).some((e) => e.path === "host_equipment_id" && e.code === "ref_missing"), true, "Vm : host_equipment_id inexistant → ref_missing");
    // -- CASCADE : supprimer l'équipement hôte DÉTACHE la VM (host_equipment_id → null), sans la supprimer --
    const db = { equipments: [{ id: "E1", name: "hyperviseur" }], vms: [{ id: "V1", name: "web", host_equipment_id: "E1" }] };
    const find = (coll, field, value) => (db[coll] || []).filter((o) => { const v = o[field]; return Array.isArray(v) ? v.includes(value) : v === value; });
    const fetch = (coll, id) => (db[coll] || []).find((o) => o.id === id) || null;
    const eqPlan = Cascade.plan("equipments", "E1", find, fetch);
    ck.eq(eqPlan.detaches.some((d) => d.c === "vms" && d.id === "V1" && d.key === "host_equipment_id" && d.value === null), true, "cascade équip. : VM hôte détachée (host_equipment_id null)");
    ck.eq(eqPlan.deletes.some((d) => d.c === "vms"), false, "cascade équip. : VM jamais supprimée (détachement seul)");
    // -- supprimer une VM DÉTACHE ses adresses IP rattachées (vm_id → null), sans les supprimer (T0.2, parité equipment_id) --
    db.ipAddresses = [{ id: "IP1", address: "10.0.0.5", vm_id: "V1" }];
    const vmPlan = Cascade.plan("vms", "V1", find, fetch);
    ck.eq(vmPlan.detaches.some((d) => d.c === "ipAddresses" && d.id === "IP1" && d.key === "vm_id" && d.value === null), true, "cascade vm : adresse IP détachée (vm_id null)");
    ck.eq(vmPlan.deletes.some((d) => d.c === "ipAddresses"), false, "cascade vm : adresse IP jamais supprimée (détachement seul)");

    // -- GROUPES : parité de VALIDATION avec equipments (refs V2 + invariant T1d) --
    const grpFetch = (coll, id) => (coll === "groups" && (id === "G1" || id === "G2")) ? { id } : null;
    ck.eq(DV.validateRecord("vms", { name: "x", group_id: "G1", group_ids: ["G1", "G2"] }, grpFetch).length, 0, "Vm groupes : FK existantes + primaire membre → 0 erreur");
    ck.eq(DV.validateRecord("vms", { name: "x", group_ids: ["G9"] }, grpFetch).some((e) => e.path === "group_ids" && e.code === "ref_missing"), true, "Vm groupes : group_ids avec FK inexistante → ref_missing");
    ck.eq(DV.validateRecord("vms", { name: "x", group_id: "G9", group_ids: ["G1"] }).some((e) => e.path === "group_id" && e.code === "invariant"), true, "Vm groupes (T1d) : primaire HORS group_ids → invariant");
    ck.eq(JSON.stringify(DV.normalizeRecord("vms", { name: "x" }).group_ids), "[]", "Vm groupes : group_ids défaut → [] (normalisation)");

    // -- CASCADE groups→vms : supprimer un groupe détache AUSSI les VMs (pas d'ids fantômes) --
    db.groups = [{ id: "G1", label: "Prod" }, { id: "G2", label: "SAN" }];
    // V2 : G1 primaire + G2 secondaire ; V3 LEGACY (group_id seul, group_ids absent — parité du cas equipments E4).
    db.vms.push({ id: "V2", name: "db", group_id: "G1", group_ids: ["G1", "G2"] }, { id: "V3", name: "old", group_id: "G2" });
    const g1Plan = Cascade.plan("groups", "G1", find, fetch);
    const v2g1 = g1Plan.detaches.filter((d) => d.c === "vms" && d.id === "V2");
    ck.eq(JSON.stringify((v2g1.find((d) => d.key === "group_ids") || {}).value), JSON.stringify(["G2"]), "cascade groupe : G1 retiré de vms.group_ids de V2");
    ck.eq((v2g1.find((d) => d.key === "group_id") || {}).value, "G2", "cascade groupe : primaire de V2 supprimé → repointé sur le groupe restant");
    ck.eq(g1Plan.deletes.some((d) => d.c === "vms"), false, "cascade groupe : aucune VM supprimée (détachement seul)");
    // groupe SECONDAIRE supprimé : primaire de V2 inchangé ; V3 legacy (group_id seul) vidé proprement.
    const g2Plan = Cascade.plan("groups", "G2", find, fetch);
    const v2g2 = g2Plan.detaches.filter((d) => d.c === "vms" && d.id === "V2");
    ck.eq(JSON.stringify((v2g2.find((d) => d.key === "group_ids") || {}).value), JSON.stringify(["G1"]), "cascade groupe : G2 (secondaire) retiré de vms.group_ids de V2");
    ck.eq((v2g2.find((d) => d.key === "group_id") || {}).value, "G1", "cascade groupe : primaire de V2 (G1) inchangé");
    const v3g2 = g2Plan.detaches.filter((d) => d.c === "vms" && d.id === "V3");
    ck.eq(JSON.stringify((v3g2.find((d) => d.key === "group_ids") || {}).value), JSON.stringify([]), "cascade groupe LEGACY : V3 (group_id seul) → group_ids vidé");
    ck.eq((v3g2.find((d) => d.key === "group_id") || {}).value, null, "cascade groupe LEGACY : primaire de V3 effacé (null)");
    // la factorisation n'a pas changé le comportement côté EQUIPMENTS (couvert en détail plus haut — ancre rapide ici).
    db.equipments.push({ id: "E5", name: "sw", group_id: "G1", group_ids: ["G1"] });
    ck.eq(Cascade.plan("groups", "G1", find, fetch).detaches.some((d) => d.c === "equipments" && d.id === "E5" && d.key === "group_id" && d.value === null), true, "cascade groupe : équipements toujours balayés (helper mutualisé)");
  }
  });

  await section("shared : collection applications (format url, exclusivité equipment_id/vm_id, cascade hôte)", async () => {
  {
    const V = Validation.DataValidator;

    // -- FORMAT `url` (nouveau FieldSpec.format, chantier applications 2026-08-10) : http/https en LISTE
    //    BLANCHE — jamais une liste noire, qui oublie toujours un schéma (`javascript:`, `data:`…). --
    const errsOn = (url) => V.normalizeAndValidate("applications", { name: "GLPI", url }).errors.filter((e) => e.path === "url");
    ck.eq(errsOn("https://glpi.exemple.local").length, 0, "url : https accepté");
    ck.eq(errsOn("http://intranet").length, 0, "url : http + hôte interne sans TLD accepté");
    ck.eq(errsOn("HTTPS://App.Local/chemin?q=1").length, 0, "url : casse du schéma ignorée (HTTPS://…)");
    ck.eq(errsOn("").length, 0, "url : chaîne vide TOUJOURS permise (pas une app web)");
    ck.eq(errsOn("   ").length, 0, "url : blancs trimés → vide → permis");
    ck.eq(errsOn("javascript:alert(1)").length, 1, "url : `javascript:` REJETÉ (le rendu cliquable en ferait un XSS — cf. Html.isSafeHttpUrl)");
    ck.eq(errsOn("ftp://serveur/fichier").length, 1, "url : `ftp:` REJETÉ (hors liste blanche http/https)");
    ck.eq(errsOn("glpi.exemple.local").length, 1, "url : chaîne sans schéma REJETÉE (une URL relative ne pointe aucun service)");
    ck.eq(errsOn("https://a b").length, 1, "url : espace REJETÉ (porte d'écriture plus stricte que la garde de rendu)");
    ck(errsOn("nope").some((e) => e.code === "format"), "url : le refus porte bien le code 'format'");

    // -- EXCLUSIVITÉ SOUPLE equipment_id/vm_id (copie de l'invariant ipAddresses) : un hôte OU l'autre,
    //    jamais les deux ; les DEUX vides restent permis (app pas encore rattachée). --
    const inv = (rec) => V.normalizeAndValidate("applications", rec).errors.filter((e) => e.code === "invariant");
    ck.eq(inv({ name: "GLPI", equipment_id: "E1", vm_id: "V1" }).length, 1, "exclusivité : les DEUX hôtes posés → REFUS (invariant)");
    ck.eq(inv({ name: "GLPI", equipment_id: "E1" }).length, 0, "exclusivité : équipement seul → OK");
    ck.eq(inv({ name: "GLPI", vm_id: "V1" }).length, 0, "exclusivité : VM seule → OK");
    ck.eq(inv({ name: "GLPI" }).length, 0, "exclusivité SOUPLE : aucun hôte → OK (état permis)");
    // Normalisation : FK absentes → null (nullable), name trimé, description au défaut "".
    const norm = V.normalizeRecord("applications", { name: "  GLPI  " });
    ck.eq(norm.equipment_id, null, "normalisation : equipment_id absent → null");
    ck.eq(norm.vm_id, null, "normalisation : vm_id absent → null");
    ck.eq(norm.name, "GLPI", "normalisation : name trimé (identité fiabilisée)");
    ck.eq(norm.description, "", "normalisation : description au défaut \"\"");
    // Intégrité référentielle (V2) : l'hôte doit EXISTER.
    const fetchApp = (coll, id) => (coll === "equipments" && id === "E1") || (coll === "vms" && id === "V1") ? { id } : null;
    ck.eq(V.validateRecord("applications", V.normalizeRecord("applications", { name: "x", equipment_id: "GHOST" }), fetchApp)
      .some((e) => e.path === "equipment_id" && e.code === "ref_missing"), true, "V2 : équipement hôte introuvable → 'ref_missing'");
    ck.eq(V.validateRecord("applications", V.normalizeRecord("applications", { name: "x", vm_id: "V1" }), fetchApp).length, 0, "V2 : VM hôte existante → valide");

    // -- CASCADE : supprimer l'HÔTE (équipement OU VM) DÉTACHE l'application — jamais une suppression
    //    (décision D2 : l'application survit « sans hôte »). Supprimer l'application n'entraîne RIEN. --
    const db = {
      equipments: [{ id: "E1", name: "srv" }],
      vms: [{ id: "V1", name: "vm" }],
      applications: [{ id: "A1", name: "GLPI", equipment_id: "E1", vm_id: null }, { id: "A2", name: "Grafana", equipment_id: null, vm_id: "V1" }],
    };
    const find = (coll, field, value) => (db[coll] || []).filter((r) => (Array.isArray(r[field]) ? r[field].includes(value) : r[field] === value));
    const fetch = (coll, id) => (db[coll] || []).find((r) => r.id === id) || null;
    const eqPlan = Cascade.plan("equipments", "E1", find, fetch);
    ck.eq(eqPlan.detaches.some((d) => d.c === "applications" && d.id === "A1" && d.key === "equipment_id" && d.value === null), true, "cascade équipement : application DÉTACHÉE (equipment_id → null)");
    ck.eq(eqPlan.deletes.some((d) => d.c === "applications"), false, "cascade équipement : application JAMAIS supprimée");
    const vmPlan = Cascade.plan("vms", "V1", find, fetch);
    ck.eq(vmPlan.detaches.some((d) => d.c === "applications" && d.id === "A2" && d.key === "vm_id" && d.value === null), true, "cascade VM : application DÉTACHÉE (vm_id → null)");
    ck.eq(vmPlan.deletes.some((d) => d.c === "applications"), false, "cascade VM : application JAMAIS supprimée");
    const appPlan = Cascade.plan("applications", "A1", find, fetch);
    ck.eq(appPlan.deletes.length + appPlan.detaches.length, 0, "cascade application : plan VIDE (rien ne pointe vers une application — règle déclarée vide, pas omise)");
  }
  });

  await section("shared : collection attachments (liste blanche MIME, exclusivité equipment_id/sub_equipment_id, cascade DELETE)", async () => {
  {
    const V = Validation.DataValidator;
    const okRec = { name: "Convention de prêt 2026", file_name: "convention.pdf", mime: "application/pdf" };

    // -- CHAMPS REQUIS : name, file_name, mime (une pièce sans libellé/nom d'origine/type n'est ni
    //    téléchargeable ni contrôlable). --
    const errs = (rec) => V.normalizeAndValidate("attachments", rec).errors;
    ck.eq(errs(okRec).length, 0, "pièce jointe minimale valide (name + file_name + mime liste blanche) → 0 erreur");
    ck.eq(errs({ ...okRec, name: "  " }).some((e) => e.path === "name" && e.code === "required"), true, "name vide (trimé) → 'required'");
    ck.eq(errs({ ...okRec, file_name: "" }).some((e) => e.path === "file_name" && e.code === "required"), true, "file_name vide → 'required'");
    ck.eq(errs({ ...okRec, mime: "" }).some((e) => e.path === "mime" && e.code === "required"), true, "mime vide → 'required' (et PAS l'invariant : contrôlé seulement si renseigné, patron contacts.email)");
    ck.eq(errs({ ...okRec, mime: "" }).some((e) => e.code === "invariant"), false, "mime vide → PAS de double erreur invariant");

    // -- LISTE BLANCHE MIME (invariant, source unique Schema.ATTACHMENT_MIME_TYPES — anti-XSS-stocké D6) :
    //    les types EXÉCUTABLES par un navigateur sont bannis, JAMAIS text/html ni image/svg+xml. --
    for (const good of ["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain", "text/csv",
      "application/vnd.oasis.opendocument.text", "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]) {
      ck.eq(errs({ ...okRec, mime: good }).length, 0, "mime « " + good + " » ∈ liste blanche → accepté");
    }
    for (const bad of ["text/html", "image/svg+xml", "application/javascript", "application/octet-stream"]) {
      ck.eq(errs({ ...okRec, mime: bad }).some((e) => e.path === "mime" && e.code === "invariant"), true, "mime « " + bad + " » HORS liste → refusé (invariant)");
    }
    // Parité helper partagé (même doctrine que isImageMime, cf. section Schéma partagé) :
    ck.eq(SharedSchema.isAttachmentMime("application/pdf"), true, "isAttachmentMime(application/pdf) = true");
    ck.eq(SharedSchema.isAttachmentMime("text/html"), false, "isAttachmentMime(text/html) = false (XSS stocké)");
    ck.eq(SharedSchema.isAttachmentMime("image/svg+xml"), false, "isAttachmentMime(image/svg+xml) = false (SVG scripté = document exécutable)");
    ck.eq(SharedSchema.isAttachmentMime(null), false, "isAttachmentMime(null) = false");

    // -- EXCLUSIVITÉ SOUPLE equipment_id/sub_equipment_id (copie de l'invariant applications) : une cible
    //    OU l'autre, jamais les deux ; les DEUX vides restent permis. --
    const inv = (rec) => errs(rec).filter((e) => e.code === "invariant");
    ck.eq(inv({ ...okRec, equipment_id: "E1", sub_equipment_id: "SE1" }).length, 1, "exclusivité : les DEUX cibles posées → REFUS (invariant)");
    ck.eq(inv({ ...okRec, equipment_id: "E1" }).length, 0, "exclusivité : équipement seul → OK");
    ck.eq(inv({ ...okRec, sub_equipment_id: "SE1" }).length, 0, "exclusivité : sous-équipement seul → OK");
    ck.eq(inv({ ...okRec }).length, 0, "exclusivité SOUPLE : aucune cible → OK (état permis)");

    // -- NORMALISATION : FK absentes → null, size au défaut 0 (min 0 : négatif refusé), name/file_name trimés. --
    const norm = V.normalizeRecord("attachments", { name: "  Convention  ", file_name: "  scan.pdf ", mime: "application/pdf" });
    ck.eq(norm.equipment_id, null, "normalisation : equipment_id absent → null");
    ck.eq(norm.sub_equipment_id, null, "normalisation : sub_equipment_id absent → null");
    ck.eq(norm.size, 0, "normalisation : size absente → 0 (posée par le serveur à l'upload)");
    ck.eq(norm.name, "Convention", "normalisation : name trimé");
    ck.eq(norm.file_name, "scan.pdf", "normalisation : file_name trimé (identité de download fiabilisée)");
    ck.eq(errs({ ...okRec, size: -1 }).some((e) => e.path === "size" && e.code === "min"), true, "size négative → refusée (min 0)");
    // Intégrité référentielle (V2) : la cible doit EXISTER.
    const fetchAtt = (coll, id) => ((coll === "equipments" && id === "E1") || (coll === "subEquipments" && id === "SE1")) ? { id } : null;
    ck.eq(V.validateRecord("attachments", V.normalizeRecord("attachments", { ...okRec, equipment_id: "GHOST" }), fetchAtt)
      .some((e) => e.path === "equipment_id" && e.code === "ref_missing"), true, "V2 : équipement cible introuvable → 'ref_missing'");
    ck.eq(V.validateRecord("attachments", V.normalizeRecord("attachments", { ...okRec, sub_equipment_id: "SE1" }), fetchAtt).length, 0, "V2 : sous-équipement cible existant → valide");

    // -- CASCADE (décision D3) : supprimer la CIBLE SUPPRIME ses pièces jointes — un DELETE, PAS un
    //    detach (une convention orpheline n'a pas de sens, contrairement aux applications qui SURVIVENT
    //    au détachement — les deux régimes coexistent, chacun testé). Le BINAIRE, lui, n'est jamais
    //    touché par la cascade : sa purge est le travail EXCLUSIF de la maintenance (D5). --
    const db = {
      equipments: [{ id: "E1", name: "srv" }],
      subEquipments: [{ id: "SE1", name: "drive", equipment_id: "E1" }],
      ports: [{ id: "P1", equipment_id: "E1", sub_equipment_id: "SE1" }],
      attachments: [
        { id: "A-eq", name: "Convention", file_name: "c.pdf", mime: "application/pdf", equipment_id: "E1", sub_equipment_id: null },
        { id: "A-se", name: "Garantie", file_name: "g.pdf", mime: "application/pdf", equipment_id: null, sub_equipment_id: "SE1" },
      ],
    };
    const find = (coll, field, value) => (db[coll] || []).filter((r) => (Array.isArray(r[field]) ? r[field].includes(value) : r[field] === value));
    const fetch = (coll, id) => (db[coll] || []).find((r) => r.id === id) || null;
    // Sous-équipement supprimé → SA pièce est SUPPRIMÉE (delete), le port seulement DÉTACHÉ (régimes distincts).
    const sePlan = Cascade.plan("subEquipments", "SE1", find, fetch);
    ck.eq(sePlan.deletes.some((d) => d.c === "attachments" && d.id === "A-se"), true, "cascade sous-équipement : pièce jointe SUPPRIMÉE (delete, pas detach — D3)");
    ck.eq(sePlan.detaches.some((d) => d.c === "attachments"), false, "cascade sous-équipement : AUCUN détachement de pièce jointe (jamais d'orpheline)");
    ck.eq(sePlan.detaches.some((d) => d.c === "ports" && d.id === "P1" && d.key === "sub_equipment_id"), true, "cascade sous-équipement : le port reste DÉTACHÉ (régime inchangé)");
    // Équipement supprimé → RÉCURSION complète : ses pièces directes ET celles de ses sous-équipements
    // (la règle subEquipments est REJOUÉE sur SE1 par le moteur — rien n'est réécrit à la main).
    const eqPlan = Cascade.plan("equipments", "E1", find, fetch);
    ck.eq(eqPlan.deletes.some((d) => d.c === "attachments" && d.id === "A-eq"), true, "cascade équipement : pièce jointe DIRECTE supprimée (equipment_id)");
    ck.eq(eqPlan.deletes.some((d) => d.c === "attachments" && d.id === "A-se"), true, "cascade équipement : pièce du SOUS-ÉQUIPEMENT supprimée AUSSI (récursion equipments → subEquipments → attachments)");
    ck.eq(eqPlan.detaches.some((d) => d.c === "attachments"), false, "cascade équipement : aucune pièce jointe simplement détachée");
    // Supprimer une PIÈCE JOINTE n'entraîne rien (rien ne pointe vers elle — règle déclarée vide, pas omise).
    const attPlan = Cascade.plan("attachments", "A-eq", find, fetch);
    ck.eq(attPlan.deletes.length + attPlan.detaches.length, 0, "cascade pièce jointe : plan VIDE (règle déclarée vide, convention wifiClients/applications)");
  }
  });

  await section("shared : couverture des specs (toutes les collections spécifiées)", async () => {
  {
    // INVARIANT : pour CHAQUE collection spécifiée, l'entité par défaut du constructeur front satisfait la spec
    // (aucune spec ne sur-contraint ce que le front produit → pas de blocage de flux légitime).
    const requiredSample = {   // collections à champ(s) requis : on fournit des valeurs valides
      equipments: { name: "x" }, racks: { name: "x" }, datacenters: { name: "x" }, sites: { name: "x" },
      networks: { label: "x" }, groups: { label: "x" },
      ipNetworks: { cidr: "10.0.0.0/24", label: "x" }, ipAddresses: { address: "10.0.0.5" },
      dhcpRanges: { start_ip: "10.0.0.10", end_ip: "10.0.0.20" }, vms: { name: "x" }, contacts: { name: "x" },
      applications: { name: "x" },
      // attachments : name/file_name/mime REQUIS (une pièce sans libellé, sans nom d'origine ou sans type
      // n'est ni téléchargeable ni contrôlable) ; le mime doit être dans la liste blanche (invariant).
      attachments: { name: "x", file_name: "x.pdf", mime: "application/pdf" },
      // subEquipments : `equipment_id` est REQUIS (un sous-équipement sans maître n'a aucune existence) —
      // divergence VOULUE avec aggregates.equipment_id, nullable. `validateRecord` sans `fetch` ne contrôle
      // pas la FK, l'id fourni n'a donc pas besoin d'exister ici (l'intégrité V2 est testée à part).
      subEquipments: { name: "x", equipment_id: "eq-1" },
    };
    const specced = Object.keys(Validation.COLLECTION_SPECS);
    ck.eq(specced.length, EntityRegistry.COLLECTIONS.length, "specs : TOUTES les collections couvertes (" + specced.length + "/" + EntityRegistry.COLLECTIONS.length + ")");
    for (const collection of specced) {
      const Cls = EntityRegistry.classOf(collection);
      const entity = new Cls(requiredSample[collection] || {});
      ck.eq(Validation.DataValidator.validateRecord(collection, entity.toJSON()).length, 0, collection + " : entité par défaut satisfait la spec");
    }
  }
  });

  await section("shared : validation des SOUS-ÉQUIPEMENTS (nom + maître requis ; absences DÉLIBÉRÉES)", async () => {
  {
    const V = Validation.DataValidator;
    const errs = (rec) => V.validateRecord("subEquipments", V.normalizeRecord("subEquipments", rec));
    const ok = { name: "Drive LTO-8 n°2", equipment_id: "E1" };
    ck.eq(errs(ok).length, 0, "sous-équip. : nom + maître → valide");

    // NOM requis, et TRIMÉ (la sémantique vit dans le nom, il n'y a pas de champ `type` pour la porter).
    ck.eq(errs({ ...ok, name: "" }).some((e) => e.path === "name" && e.code === "required"), true, "sous-équip. : nom vide → 'required'");
    ck.eq(errs({ ...ok, name: "   " }).some((e) => e.path === "name" && e.code === "required"), true, "sous-équip. : nom tout-espaces (trimé) → 'required'");
    ck.eq(V.normalizeRecord("subEquipments", { ...ok, name: "  Drive 1  " }).name, "Drive 1", "sous-équip. : nom trimé à la normalisation");

    // MAÎTRE requis — c'est LA divergence voulue avec aggregates.equipment_id (nullable). Un sous-équipement
    // sans maître n'a aucune existence : le refus doit être explicite, pas un orphelin toléré.
    ck.eq(errs({ name: "x" }).some((e) => e.path === "equipment_id" && e.code === "required"), true, "sous-équip. : sans maître → 'required'");
    ck.eq(errs({ name: "x", equipment_id: null }).some((e) => e.path === "equipment_id" && e.code === "required"), true, "sous-équip. : maître null → 'required'");
    ck.eq(Validation.COLLECTION_SPECS.aggregates.fields.equipment_id.nullable, true, "témoin : aggregates.equipment_id est bien NULLABLE (la divergence est réelle, pas imaginée)");

    // INTÉGRITÉ RÉFÉRENTIELLE (V2, avec fetch) : le maître doit EXISTER.
    const fetch = (coll, id) => (coll === "equipments" && id === "E1") ? { id: "E1" } : null;
    ck.eq(V.validateRecord("subEquipments", V.normalizeRecord("subEquipments", ok), fetch).length, 0, "sous-équip. : maître existant → valide");
    ck.eq(V.validateRecord("subEquipments", V.normalizeRecord("subEquipments", { ...ok, equipment_id: "GHOST" }), fetch)
      .some((e) => e.path === "equipment_id" && e.code === "ref_missing"), true, "sous-équip. : maître introuvable → 'ref_missing'");

    // `description` porte un DÉFAUT : un null explicite est ramené à "" (sinon il traverserait normalisation
    // ET validation alors que le type dérivé promet `string` — c'est le verrou « null silencieux »).
    ck.eq(V.normalizeRecord("subEquipments", { ...ok, description: null }).description, "", "sous-équip. : description null → \"\" (pas de null silencieux)");

    // LES ABSENCES SONT LA FONCTIONNALITÉ — ce verrou est le cœur du lot. Si l'un de ces champs apparaît un
    // jour dans la spec, c'est que la collection est en train de redevenir un `equipments` : le test doit
    // rougir pour forcer la DÉCISION, pas laisser la dérive passer.
    const fields = Object.keys(Validation.COLLECTION_SPECS.subEquipments.fields);
    ["type", "placement_mode", "dim_mode", "u_height", "u_width_mm", "free_l_mm", "free_w_mm", "free_h_mm",
      "rack_id", "dc_id", "dc_x", "dc_y", "dc_z", "tray_item_id", "floor_x", "floor_y", "location", "floor", "room",
      "assigned_to", "assigned_date", "inventory_only", "locked",
      "sub_equipment_id", "parent_id", "sub_equipments"].forEach((forbidden) => {
      ck.eq(fields.includes(forbidden), false, "sous-équip. : AUCUN champ « " + forbidden + " » (ni type, ni placement, ni dimension, ni attribution, ni imbrication)");
    });
    // Hiérarchie PLATE : on ÉNUMÈRE les FK du modèle entier qui visent `subEquipments`. Au lot 1 la liste était
    // VIDE et ce test annonçait qu'elle passerait à `ports.sub_equipment_id` au lot 4 : c'est arrivé, et il l'a
    // dit de lui-même. Le garder EXHAUSTIF (et non « au moins celle-là ») est ce qui fait qu'une FK ajoutée
    // ailleurs — surtout une FK depuis `subEquipments` vers elle-même — ne peut pas passer inaperçue.
    const refsToSelf = Object.entries(Validation.COLLECTION_SPECS).flatMap(([coll, spec]) =>
      Object.entries(spec.fields).filter(([, f]) => f.ref === "subEquipments").map(([field]) => coll + "." + field));
    // Depuis le chantier pièces jointes (2026-08-10), une SECONDE FK le vise : `attachments.sub_equipment_id`
    // (cible d'une pièce, décision D2) — le test exhaustif a rougi comme prévu et la liste s'est étendue.
    ck.eq(JSON.stringify(refsToSelf), JSON.stringify(["ports.sub_equipment_id", "attachments.sub_equipment_id"]), "sous-équip. : les FK qui le visent = le port qui le dessert + la pièce jointe qui le cible (liste EXHAUSTIVE)");
    ck.eq(Object.values(Validation.COLLECTION_SPECS.subEquipments.fields).some((f) => f.ref === "subEquipments"), false, "sous-équip. : AUCUNE FK auto-référente (hiérarchie plate, pas de garde anti-cycle à écrire)");

    // IDENTITÉ MATÉRIELLE + REPÈRE (lot 3, D5/D6) : chaînes libres à DÉFAUT "" — donc pas de null silencieux.
    ck.eq(errs({ ...ok, brand: "Quantum", model: "SL-X", serial: "SN-42", slot: "Étagère A / 3" }).length, 0, "sous-équip. : marque/modèle/série/repère → valides");
    ["brand", "model", "serial", "slot"].forEach((field) => {
      ck.eq(V.normalizeRecord("subEquipments", { ...ok, [field]: null })[field], "", "sous-équip. : « " + field + " » null → \"\"");
    });
    // Le REPÈRE est TRIMÉ, comme le nom : spec ET classe doivent s'accorder (elles ont divergé une fois).
    ck.eq(V.normalizeRecord("subEquipments", { ...ok, slot: "  Étagère A  " }).slot, "Étagère A", "sous-équip. : repère trimé à la normalisation");
    ck.eq(new (EntityRegistry.classOf("subEquipments"))({ ...ok, slot: "  Étagère A  " }).slot, "Étagère A", "sous-équip. : repère trimé aussi par la CLASSE (accord spec ⇄ classe)");
    // ⚠ Le repère est un TEXTE, jamais une coordonnée : aucune contrainte de format, aucune borne.
    ck.eq(errs({ ...ok, slot: "n'importe quoi / 3 · B" }).length, 0, "sous-équip. : repère = texte LIBRE (aucun format imposé)");

    // ADMINISTRATIF (achat / garantie) — D5(c) 2026-08-03 : revirement de la décision d'origine, les 3 champs
    // rejoignent enfin la spec (l'attribution, elle, reste hors-jeu — cf. le verrou d'absences ci-dessus,
    // volontairement NON étendu à purchase_date/po_ref/warranty_end).
    ["purchase_date", "po_ref", "warranty_end"].forEach((field) => {
      ck.eq(fields.includes(field), true, "sous-équip. : « " + field + " » présent dans la spec depuis D5(c)");
      ck.eq(Validation.COLLECTION_SPECS.subEquipments.fields[field].default, "", "sous-équip. : « " + field + " » a un défaut \"\" (verrou null silencieux)");
      ck.eq(!!Validation.COLLECTION_SPECS.subEquipments.fields[field].required, false, "sous-équip. : « " + field + " » n'est PAS requis");
    });
    ck.eq(errs({ ...ok, purchase_date: "2026-01-15", po_ref: "BDC-42", warranty_end: "2029-01-15" }).length, 0, "sous-équip. : achat/BDC/garantie renseignés → valides");
    ["purchase_date", "po_ref", "warranty_end"].forEach((field) => {
      ck.eq(V.normalizeRecord("subEquipments", { ...ok, [field]: null })[field], "", "sous-équip. : « " + field + " » null → \"\" (pas de null silencieux)");
    });
    // Un record qui ne porte PAS ces champs du tout (pas même `undefined`) doit normaliser vers "" — c'est le
    // scénario du round-trip d'un enregistrement écrit AVANT D5(c) (ou du mode fichier legacy).
    ck.eq(V.normalizeRecord("subEquipments", { name: "x", equipment_id: "E1" }).purchase_date, "", "sous-équip. : achat ABSENT du record → \"\" à la normalisation");
    ck.eq(V.normalizeRecord("subEquipments", { name: "x", equipment_id: "E1" }).po_ref, "", "sous-équip. : BDC ABSENT du record → \"\" à la normalisation");
    ck.eq(V.normalizeRecord("subEquipments", { name: "x", equipment_id: "E1" }).warranty_end, "", "sous-équip. : garantie ABSENTE du record → \"\" à la normalisation");

    // GROUPES (lot 2) — PARITÉ STRICTE avec equipments/vms : primaire ⊂ group_ids (T1d), 3ᵉ copie de la règle.
    ck.eq(errs({ ...ok, group_id: "G1", group_ids: ["G1", "G2"] }).length, 0, "sous-équip. : primaire membre de group_ids → valide");
    ck.eq(errs({ ...ok, group_id: "G1", group_ids: ["G2"] }).some((e) => e.path === "group_id" && e.code === "invariant"), true, "sous-équip. : primaire ABSENT de group_ids → invariant (parité T1d)");
    ck.eq(errs({ ...ok, group_id: null, group_ids: [] }).length, 0, "sous-équip. : aucun groupe → valide (les groupes sont facultatifs)");
    // La CLASSE tient l'invariant d'elle-même : primaire semé dans group_ids, EN TÊTE, dédupliqué (parité Vm).
    const SubCls = EntityRegistry.classOf("subEquipments");
    ck.eq(JSON.stringify(new SubCls({ ...ok, group_id: "G1" }).group_ids), JSON.stringify(["G1"]), "sous-équip. : classe — primaire semé dans group_ids");
    ck.eq(JSON.stringify(new SubCls({ ...ok, group_id: "G1", group_ids: ["G2", "G1"] }).group_ids), JSON.stringify(["G1", "G2"]), "sous-équip. : classe — primaire remis EN TÊTE, sans doublon");
    ck.eq(Validation.DataValidator.validateRecord("subEquipments", new SubCls({ ...ok, group_id: "G1", group_ids: ["G2"] }).toJSON()).length, 0, "sous-équip. : classe — l'entité construite satisfait T1d même sur une entrée incohérente");
  }
  });

  await section("shared : liaison PORT ⇄ SOUS-ÉQUIPEMENT (T2c d'appartenance + dependents, lot 4)", async () => {
  {
    const V = Validation.DataValidator;
    // E1 porte le drive SE1 ; E2 est un AUTRE équipement, avec son propre sous-équipement SE2.
    const db = {
      equipments: [{ id: "E1", name: "Librairie" }, { id: "E2", name: "Switch" }],
      subEquipments: [{ id: "SE1", name: "Drive 1", equipment_id: "E1" }, { id: "SE2", name: "Carte", equipment_id: "E2" }],
      ports: [{ id: "P1", name: "FC-1", equipment_id: "E1", sub_equipment_id: "SE1" }],
    };
    const fetch = (coll, id) => (db[coll] || []).find((o) => o.id === id) || null;
    const find = (coll, field, value) => (db[coll] || []).filter((o) => {
      const v = o[field]; return Array.isArray(v) ? v.includes(value) : v === value;
    });
    const portErrs = (port) => V.validateRecord("ports", V.normalizeRecord("ports", port), fetch, find);

    // T2c — le cas LÉGITIME, puis celui qui rend le modèle faux en silence si rien ne l'arrête.
    ck.eq(portErrs({ id: "P1", equipment_id: "E1", sub_equipment_id: "SE1" }).length, 0, "T2c : port et sous-équipement du MÊME équipement → valide");
    const cross = portErrs({ id: "P1", equipment_id: "E1", sub_equipment_id: "SE2" });
    ck.eq(cross.some((e) => e.path === "sub_equipment_id" && e.code === "cross_entity"), true, "T2c : sous-équipement d'un AUTRE équipement → cross_entity");
    ck.eq(portErrs({ id: "P1", equipment_id: "E1", sub_equipment_id: null }).length, 0, "T2c : pas de liaison → aucune contrainte");
    // FK inexistante : c'est V2 (ref_missing) qui parle, pas T2c — les deux niveaux restent distincts.
    ck.eq(portErrs({ id: "P1", equipment_id: "E1", sub_equipment_id: "GHOST" }).some((e) => e.code === "ref_missing"), true, "liaison : sous-équipement inexistant → ref_missing (V2), pas cross_entity");

    // 🚨 D10 — LE cas que T2c ne peut PAS attraper seule : c'est le SOUS-ÉQUIPEMENT qui déménage, le port n'est
    // pas touché. Sans le `dependents` de `subEquipments`, l'incohérence s'installerait en silence.
    const moved = { id: "SE1", name: "Drive 1", equipment_id: "E2" };   // le drive passe sous E2, son port reste sur E1
    const deps = V.validateDependents("subEquipments", moved, find, fetch);
    ck.eq(deps.some((e) => e.collection === "ports" && e.path === "sub_equipment_id" && e.code === "cross_entity"), true,
      "D10 : déplacer un sous-équipement sous un AUTRE maître est REFUSÉ (ses ports redeviennent incohérents)");
    ck.eq(deps.length > 0 && deps.every((e) => /incohérent avec la modification/.test(e.message)), true,
      "D10 : le message dit que c'est la MODIFICATION du parent qui est en cause (pas le port)");
    // Témoin d'anti-vacuité : le même sous-équipement, NON déplacé, ne produit aucune erreur.
    ck.eq(V.validateDependents("subEquipments", { id: "SE1", name: "Drive 1", equipment_id: "E1" }, find, fetch).length, 0,
      "D10 : sous-équipement inchangé → aucun refus (le verrou n'est pas vacant)");

    // CASCADE : un sous-équipement supprimé DÉTACHE ses ports, il ne les supprime pas — le port est au maître.
    const plan = Cascade.plan("subEquipments", "SE1", find, fetch);
    ck.eq(plan.deletes.length, 0, "cascade : supprimer un sous-équipement ne supprime AUCUN port");
    ck.eq(plan.detaches.some((d) => d.c === "ports" && d.id === "P1" && d.key === "sub_equipment_id" && d.value === null), true,
      "cascade : le port est DÉTACHÉ (il survit à la disparition du sous-équipement)");
  }
  });

  await section("shared : validation des CONTACTS (nom requis ; e-mail / téléphone TOLÉRANTS)", async () => {
  {
    const V = Validation.DataValidator;
    const errs = (rec) => V.validateRecord("contacts", V.normalizeRecord("contacts", rec));
    // NOM requis (seul champ obligatoire)
    ck.eq(errs({ name: "" }).some((e) => e.path === "name" && e.code === "required"), true, "contacts : nom vide → erreur 'required'");
    ck.eq(errs({ name: "   " }).some((e) => e.path === "name" && e.code === "required"), true, "contacts : nom tout-espaces (trimé) → 'required'");
    ck.eq(errs({ name: "Astreinte réseau" }).length, 0, "contacts : nom seul → valide (e-mail/téléphone facultatifs)");
    // E-MAIL toléré : vide OK · forme valide OK · hôte interne sans TLD OK · clairement invalide (aucun @) refusé
    ck.eq(errs({ name: "x", email: "" }).length, 0, "contacts : e-mail vide → toléré (0 erreur)");
    ck.eq(errs({ name: "x", email: "ops@exemple.test" }).length, 0, "contacts : e-mail bien formé → accepté");
    ck.eq(errs({ name: "x", email: "ops@intranet" }).length, 0, "contacts : e-mail interne sans TLD → accepté (permissif)");
    ck.eq(errs({ name: "x", email: "pasunemail" }).some((e) => e.path === "email" && e.code === "invariant"), true, "contacts : e-mail sans @ → refusé (clairement invalide)");
    ck.eq(errs({ name: "x", email: "a@b@c" }).some((e) => e.path === "email"), true, "contacts : e-mail à double @ → refusé");
    // TÉLÉPHONE quasi libre : vide OK · chiffres + séparateurs OK · lettres refusées
    ck.eq(errs({ name: "x", phone: "" }).length, 0, "contacts : téléphone vide → toléré");
    ck.eq(errs({ name: "x", phone: "+32 2 555 01 23" }).length, 0, "contacts : téléphone international (+ espaces) → accepté");
    ck.eq(errs({ name: "x", phone: "(02) 555.01.23" }).length, 0, "contacts : téléphone points/parenthèses → accepté");
    ck.eq(errs({ name: "x", phone: "appelle-moi" }).some((e) => e.path === "phone" && e.code === "invariant"), true, "contacts : téléphone avec lettres → refusé");
    // NORMALISATION : trim sur nom/e-mail/téléphone (identité/coordonnées fiables) ; notes traversent
    const norm = V.normalizeRecord("contacts", { name: "  Jean  ", email: "  jean@exemple.test ", phone: " +32 2 555 01 23 ", notes: "  garde  " });
    ck.eq(norm.name, "Jean", "contacts : nom trimé");
    ck.eq(norm.email, "jean@exemple.test", "contacts : e-mail trimé");
    ck.eq(norm.phone, "+32 2 555 01 23", "contacts : téléphone trimé");
    // AUCUNE FK déclarée → aucune cascade ne pointe vers contacts (plan de suppression vide, hors périmètre ici).
    ck.eq((Validation.COLLECTION_SPECS.contacts.fields.name.required === true), true, "contacts : spec — name requis déclaré");
    // ORGANISATION / POSTE (2026-08-05) : identité saisie à la main, comme e-mail — trimées, optionnelles,
    // `default: ""` OBLIGATOIRE (verrou « null silencieux » des tests, cf. autre section de ce fichier).
    ck.eq(Validation.COLLECTION_SPECS.contacts.fields.organization.default, "", "contacts : organization — default '' (pas de null silencieux)");
    ck.eq(Validation.COLLECTION_SPECS.contacts.fields.position.default, "", "contacts : position — default '' (pas de null silencieux)");
    ck.eq(!!Validation.COLLECTION_SPECS.contacts.fields.organization.required, false, "contacts : organization — non requis");
    ck.eq(!!Validation.COLLECTION_SPECS.contacts.fields.position.required, false, "contacts : position — non requis");
    const normOrgPos = V.normalizeRecord("contacts", { name: "x", organization: "  Sonuma  ", position: "  Chef de projet  " });
    ck.eq(normOrgPos.organization, "Sonuma", "contacts : organization trimée");
    ck.eq(normOrgPos.position, "Chef de projet", "contacts : position trimée");
    // Enregistrement SANS ces champs → normalisés au défaut "" (pas de null qui traverserait silencieusement).
    const normAbsent = V.normalizeRecord("contacts", { name: "x" });
    ck.eq(normAbsent.organization, "", "contacts : organization absente → normalisée à '' par défaut");
    ck.eq(normAbsent.position, "", "contacts : position absente → normalisée à '' par défaut");
  }
  });

  await section("serveur : PUT /snapshot valide le document COMPLET (autorité — le semis de catalogues doit passer)", async () => {
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
  });

  await section("shared : intégrité référentielle (V2 — FK + conscience du lot)", async () => {
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
  });

  await section("shared : règles cross-entité (V5 — IP ∈ CIDR de son réseau)", async () => {
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
  });

  await section("shared : POE — port POE exige un équipement POE (T-POE1) + capacité non retirable (T-POE2)", async () => {
  {
    const V = (coll, rec, fetch, find) => Validation.DataValidator.validateRecord(coll, rec, fetch, find);
    // T-POE1 : un port role="poe" EXIGE que son équipement porteur soit poe_device.
    const fetchNoPoe = (coll, id) => (coll === "equipments" && id === "E1") ? { id: "E1", poe_device: false } : null;
    const fetchPoe   = (coll, id) => (coll === "equipments" && id === "E1") ? { id: "E1", poe_device: true }  : null;
    ck(V("ports", { id: "P1", name: "poe-1", role: "poe", equipment_id: "E1" }, fetchNoPoe, () => []).some((e) => e.path === "role" && e.code === "cross_entity"), "T-POE1 : port POE sur équipement NON-POE → cross_entity");
    ck.eq(V("ports", { id: "P1", name: "poe-1", role: "poe", equipment_id: "E1" }, fetchPoe, () => []).filter((e) => e.path === "role").length, 0, "T-POE1 : port POE sur équipement POE → OK");
    ck.eq(V("ports", { id: "P2", name: "eth0", role: "data", equipment_id: "E1" }, fetchNoPoe, () => []).filter((e) => e.path === "role").length, 0, "T-POE1 : port DATA → règle non applicable");
    // T-POE2 : on ne peut pas retirer la capacité POE (poe_device faux) tant qu'un port POE existe.
    const eqBase = { name: "sw", type: "switch", depth: "full", placement_mode: "manual", u_height: 1, inventory_only: false, group_id: null, id: "E1" };
    const findPoePort = (coll, field, value) => (coll === "ports" && field === "equipment_id" && value === "E1") ? [{ id: "P1", role: "poe", equipment_id: "E1" }] : [];
    ck(V("equipments", { ...eqBase, poe_device: false }, () => null, findPoePort).some((e) => e.path === "poe_device" && e.code === "scope"), "T-POE2 : désactiver POE avec un port POE présent → scope");
    ck.eq(V("equipments", { ...eqBase, poe_device: true }, () => null, findPoePort).filter((e) => e.path === "poe_device").length, 0, "T-POE2 : poe_device actif → OK malgré le port POE");
    ck.eq(V("equipments", { ...eqBase, poe_device: false }, () => null, () => []).filter((e) => e.path === "poe_device").length, 0, "T-POE2 : aucun port POE → désactivation OK");
  }
  });

  await section("shared : PowerAnalysis — store MINIMAL injecté (nu) + contrat codes+params", async () => {
  {
    // PREUVE DU DÉCOUPLAGE : on instancie le moteur avec un FAKE store objet NU (Maps/arrays en dur) qui satisfait
    // STRUCTURELLEMENT l'interface PowerAnalysisStore — aucun Store client, aucun DOM. On vérifie que les
    // avertissements sortent en CODES + PARAMS bruts (pas de chaîne i18n : le moteur partagé ignore la localisation).
    const equipments = new Map([
      ["tab", { id: "tab", name: "TGBT", type: "switchboard" }],
      // srv : PSU 2 A câblée à une source racine, mais 600 W max → 2 A × 230 V = 460 W < 600 W ⇒ psu_undersized.
      ["srv", { id: "srv", name: "srv", power_nominal_w: 460, power_max_w: 600 }],
      // box : une PSU (sink) NON câblée ⇒ non alimentée ⇒ no_source.
      ["box", { id: "box", name: "box" }],
      // cam : appareil PoE (PD) dont l'unique port poe+sink n'a aucun injecteur en face ⇒ poe_pd_unfed.
      ["cam", { id: "cam", name: "cam", poe_device: true }],
    ]);
    const ports = new Map([
      ["q1", { id: "q1", equipment_id: "tab", name: "Q1", role: "power", direction: "source", power_max_a: 16 }],
      ["psu1", { id: "psu1", equipment_id: "srv", name: "PSU1", role: "power", direction: "sink", power_max_a: 2 }],
      ["boxIn", { id: "boxIn", equipment_id: "box", name: "IN", role: "power", direction: "sink", power_max_a: 4 }],
      ["camEth", { id: "camEth", equipment_id: "cam", name: "eth", role: "poe", direction: "sink" }],
    ]);
    const cables = [{ id: "c1", from_port_id: "q1", to_port_id: "psu1" }];   // tableau → PSU du serveur
    const collections = { equipments, ports, networks: new Map() };
    const fakeStore = {
      get: (collection, id) => (collections[collection] ? collections[collection].get(id) || null : null),
      portsOf: (eqId) => [...ports.values()].filter((p) => p.equipment_id === eqId),
      cablesOfPort: (pid) => cables.filter((c) => c.from_port_id === pid || c.to_port_id === pid),
      portsOfNetwork: (nid) => [...ports.values()].filter((p) => (p.network_ids || []).includes(nid)),
    };
    const pa = new PowerAnalysis(fakeStore);   // ← moteur PILOTÉ par le fake store nu (découplage prouvé)

    // no_source : présence du CODE.
    ck.eq(pa.equipmentWarnings("box").some((w) => w.code === "no_source"), true, "shared power : PSU non câblée → code no_source (store nu injecté)");

    // psu_undersized : CODE + PARAMS aux BONNES valeurs (name/amps/req) et AUCUN champ `message` (moteur sans i18n).
    const undersized = pa.equipmentWarnings("srv").find((w) => w.code === "psu_undersized");
    ck(!!undersized, "shared power : PSU sous-dimensionnée → code psu_undersized");
    ck.eq(undersized && undersized.message, undefined, "shared power : warning porte des params, PAS de chaîne message (i18n côté client)");
    ck.eq(undersized && undersized.params.name, "PSU1", "shared power : params.name = nom de la prise (PSU1)");
    ck.eq(undersized && undersized.params.amps, 2, "shared power : params.amps = calibre de la PSU (2 A)");
    ck.eq(undersized && undersized.params.req, 3, "shared power : params.req = courant requis Math.ceil(600/230) = 3 A");

    // poe_pd_unfed : CODE + PARAMS { port }.
    const unfed = pa.equipmentWarnings("cam").find((w) => w.code === "poe_pd_unfed");
    ck(!!unfed, "shared power : PD PoE sans injecteur → code poe_pd_unfed");
    ck.eq(unfed && unfed.params.port, "eth", "shared power : params.port = nom du port PD (eth)");
  }
  });
};
