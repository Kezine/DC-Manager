/* Tests modules — code PARTAGÉ front/back (schéma, normalisation, validation, cascade).
   Sections extraites de run.js (audit P5) ; harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, mkStorage, Store, BrowserStorageAdapter, FieldIndex, Equipment, Cable, Port, Normalize, Labeler, ClickGuard, Projection, Box, Painter, RackGeometry, GraphGeometry, EquipmentTypes, PortRoles, Depths, EquipFaces, RackScene, Resolver3D, U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE, Html, Color, Format, GridGeometry, GraphView, Sort, Ip, Prefs, DatacenterView, FloorLayout, Positioning, DoorGeometry, Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM, DoorTool, Measure, CableSpline, MeasureTool, RouteTool, ImageStore, FaceImage, SaveState, EntityRegistry, ReloadPlanner, COLLECTION_THREE_IMPACT, RenderImpact, Changeset, SharedSchema, Text, PAGE_SIZE_DEFAULT, Validation, Cascade, Rack, CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS, makeStore } = require("./harness.js");

module.exports = async () => {
  await section("shared : Cascade.plan (intégrité référentielle PARTAGÉE — front ⇄ back)", async () => {
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
    // types MIME d'images : liste blanche PARTAGÉE (le front filtre à la sélection, le serveur rejette à l'upload).
    ck.eq(SharedSchema.isImageMime("image/png"), true, "isImageMime(image/png) = true");
    ck.eq(SharedSchema.isImageMime("image/webp"), true, "isImageMime(image/webp) = true");
    ck.eq(SharedSchema.isImageMime("image/svg+xml"), false, "isImageMime(image/svg+xml) = false (risque XSS stocké)");
    ck.eq(SharedSchema.isImageMime("text/html"), false, "isImageMime(text/html) = false");
    ck.eq(SharedSchema.isImageMime(null), false, "isImageMime(null) = false");
    ck.eq(SharedSchema.PAGE_SIZE_ALL >= 1e9, true, "PAGE_SIZE_ALL couvre un document complet (pas de plafond serveur — décision actée)");
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
    const passthrough = Validation.DataValidator.normalizeRecord("spares", { whatever: 7 });
    ck.eq(passthrough.whatever, 7, "normalize : collection SANS spec → traversée inchangée");
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
    ck.eq(Validation.DataValidator.validateRecord("spares", { anything: true }).length, 0, "validate : collection sans spec → 0 erreur");
    // enchaînement serveur : normalise PUIS valide
    const nv = Validation.DataValidator.normalizeAndValidate("racks", { name: "R", u_count: "42" });
    ck.eq(nv.errors.length, 0, "normalizeAndValidate : '42' normalisé → valide");
    ck.eq(nv.record.u_count, 42, "normalizeAndValidate : record normalisé renvoyé");
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
    ck.eq(Validation.DataValidator.validateRecord("ipNetworks", { label: "N", cidr: "10.0.0.0/24" }).length, 0, "ipNetworks : CIDR valide → 0 erreur");
    ck.eq(Validation.DataValidator.validateRecord("ipNetworks", { cidr: "nope" }).some((e) => e.code === "format"), true, "ipNetworks : CIDR invalide → 'format'");
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
  }
  });

  await section("shared : règles métier T1 (invariants) / T2 (cross-entité)", async () => {
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
  });

  await section("shared : couverture des specs (toutes les collections spécifiées)", async () => {
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
};
