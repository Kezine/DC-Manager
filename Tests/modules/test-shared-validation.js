/* Tests modules — code PARTAGÉ front/back (schéma, normalisation, validation, cascade).
   Sections extraites de run.js (audit P5) ; harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, mkStorage, Store, BrowserStorageAdapter, FieldIndex, Equipment, Cable, Port, Normalize, Labeler, ClickGuard, Projection, Box, Painter, RackGeometry, GraphGeometry, EquipmentTypes, PortRoles, Depths, EquipFaces, RackScene, Resolver3D, U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE, Html, Color, Format, GridGeometry, GraphView, Sort, Ip, Prefs, DatacenterView, FloorLayout, Positioning, DoorGeometry, Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM, DoorTool, Measure, CableSpline, MeasureTool, RouteTool, ImageStore, FaceImage, SaveState, EntityRegistry, ReloadPlanner, COLLECTION_THREE_IMPACT, RenderImpact, Changeset, SharedSchema, Text, PAGE_SIZE_DEFAULT, Validation, Cascade, Rack, CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS, TRAY_TYPES, makeStore } = require("./harness.js");

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
    ck.eq(passthrough.whatever, 7, "normalize : collection SANS spec → traversée inchangée");
    // VERROU DE PLACEMENT (`locked`) : booléen défaut false + coercition "true"→true, sur les 3 collections concernées.
    ["racks", "equipments", "waypoints"].forEach((coll) => {
      ck.eq(Validation.DataValidator.normalizeRecord(coll, { name: "X" }).locked, false, "normalize " + coll + " : locked défaut → false");
      ck.eq(Validation.DataValidator.normalizeRecord(coll, { name: "X", locked: "true" }).locked, true, "normalize " + coll + " : locked 'true' → true (coercition)");
      ck.eq(Validation.DataValidator.normalizeRecord(coll, { name: "X", locked: true }).locked, true, "normalize " + coll + " : locked true préservé");
    });
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
    const db = { racks: [rack], equipments: [] };
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
    // T8 — phase seulement sur un port source
    ck.eq(DV.validateRecord("ports", { phase: "L1", direction: "sink" }).some((x) => x.code === "invariant" && x.path === "phase"), true, "T8 port : phase sur un sink → invariant");
    ck.eq(DV.validateRecord("ports", { phase: "L1", direction: "source" }).some((x) => x.code === "invariant" && x.path === "phase"), false, "T8 port : phase sur une source → OK");
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
    // T9 — câble d'alimentation : source↔sink obligatoire (pas deux mêmes sens)
    const dirFetch = (c, i) => (c === "ports") ? ({ src1: { id: "src1", direction: "source" }, src2: { id: "src2", direction: "source" }, snk1: { id: "snk1", direction: "sink" }, dat1: { id: "dat1", direction: "" } })[i] || null : null;
    ck.eq(DV.validateRecord("cables", { status: "planifie", from_port_id: "src1", to_port_id: "src2" }, dirFetch).some((x) => x.code === "cross_entity" && x.path === "to_port_id"), true, "T9 câble : source↔source → cross_entity");
    ck.eq(DV.validateRecord("cables", { status: "planifie", from_port_id: "src1", to_port_id: "snk1" }, dirFetch).some((x) => x.code === "cross_entity"), false, "T9 câble : source↔sink → OK");
    ck.eq(DV.validateRecord("cables", { status: "planifie", from_port_id: "src1", to_port_id: "dat1" }, dirFetch).some((x) => x.code === "cross_entity"), false, "T9 câble : source↔data (sens vide) → non concerné");
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

  await section("shared : couverture des specs (toutes les collections spécifiées)", async () => {
  {
    // INVARIANT : pour CHAQUE collection spécifiée, l'entité par défaut du constructeur front satisfait la spec
    // (aucune spec ne sur-contraint ce que le front produit → pas de blocage de flux légitime).
    const requiredSample = {   // collections à champ(s) requis : on fournit des valeurs valides
      equipments: { name: "x" }, racks: { name: "x" }, datacenters: { name: "x" }, sites: { name: "x" },
      networks: { label: "x" }, groups: { label: "x" },
      ipNetworks: { cidr: "10.0.0.0/24", label: "x" }, ipAddresses: { address: "10.0.0.5" },
      dhcpRanges: { start_ip: "10.0.0.10", end_ip: "10.0.0.20" }, vms: { name: "x" }, contacts: { name: "x" },
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
};
