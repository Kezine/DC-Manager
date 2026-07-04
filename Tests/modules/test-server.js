/* Tests modules — serveur (ApiRules pures, Repository/DocumentStore SQLite réel, protocole REST).
   Sections extraites de run.js (audit P5) ; harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, mkStorage, Store, BrowserStorageAdapter, FieldIndex, Equipment, Cable, Port, Normalize, Labeler, ClickGuard, Projection, Box, Painter, RackGeometry, GraphGeometry, EquipmentTypes, PortRoles, Depths, EquipFaces, RackScene, Resolver3D, U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE, Html, Color, Format, GridGeometry, GraphView, Sort, Ip, Prefs, DatacenterView, FloorLayout, Positioning, DoorGeometry, Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM, DoorTool, Measure, CableSpline, MeasureTool, RouteTool, ImageStore, FaceImage, SaveState, EntityRegistry, ReloadPlanner, COLLECTION_THREE_IMPACT, RenderImpact, Changeset, SharedSchema, Text, PAGE_SIZE_DEFAULT, Validation, Cascade, Rack, CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS, makeStore } = require("./harness.js");

module.exports = async () => {
  await section("Serveur : ApiRules — ciblage du verrou optimiste (writeTargets)", async () => {
  {
    const { ApiRules } = SERVER("ApiRules.js");
    const lot = ApiRules.writeTargets({ updates: [{ collection: "racks", record: { id: "r1" } }], deletes: [{ collection: "ports", id: "p1" }] }, {});
    ck.eq(JSON.stringify(lot), JSON.stringify([{ collection: "racks", id: "r1" }, { collection: "ports", id: "p1" }]), "lot /transact → updates + deletes ciblés");
    ck.eq(ApiRules.writeTargets({ creates: [{ collection: "racks", record: { id: "r9" } }] }, {}).length, 0, "les creates ne sont PAS ciblés (id neuf → pas de garde)");
    ck.eq(JSON.stringify(ApiRules.writeTargets({}, { collection: "racks", id: "r1" })), JSON.stringify([{ collection: "racks", id: "r1" }]), "CRUD unitaire → cible de route");
    ck.eq(ApiRules.writeTargets({}, {}).length, 0, "meta/snapshot/images → aucune cible (assumé, cf. api.ts)");
    ck.eq(ApiRules.writeTargets({ updates: [null, { record: { id: "x" } }], deletes: [{}] }, {}).length, 0, "entrées malformées ignorées");
  }
  });

  await section("Serveur : ApiRules — périmètre de rechargement (buildChangeset)", async () => {
  {
    const { ApiRules } = SERVER("ApiRules.js");
    const lot = ApiRules.buildChangeset({ creates: [{ collection: "racks" }], deletes: [{ collection: "ports" }], meta: { a: 1 } }, undefined, "/transact");
    ck(!lot.full && lot.collections.includes("racks") && lot.collections.includes("ports") && lot.meta === true && lot.images === false, "lot → union des collections + meta");
    const unit = ApiRules.buildChangeset({}, "cables", "/cables/c1");
    ck(!unit.full && JSON.stringify(unit.collections) === JSON.stringify(["cables"]), "CRUD unitaire → collection de route");
    ck(ApiRules.buildChangeset({}, undefined, "/snapshot").full, "/snapshot → full (tout recharger)");
    const meta = ApiRules.buildChangeset({}, undefined, "/meta");
    ck(!meta.full && meta.meta && !meta.images, "/meta → meta seul");
    const img = ApiRules.buildChangeset({}, undefined, "/images/i1");
    ck(!img.full && !img.meta && img.images, "/images → images seul");
    ck(ApiRules.buildChangeset({}, undefined, "/inconnu").full, "chemin inconnu → full (repli sûr)");
  }
  });

  await section("Serveur : ApiRules — création stricte (createConflicts)", async () => {
  {
    const { ApiRules } = SERVER("ApiRules.js");
    const persisted = { "racks r1": { id: "r1" } };
    const fetchP = (c, id) => persisted[c + " " + id] || null;
    ck.eq(ApiRules.createConflicts([{ collection: "racks", record: { id: "r1" } }], [], fetchP).length, 1, "create sur id EXISTANT → collision (409)");
    ck.eq(ApiRules.createConflicts([{ collection: "racks", record: { id: "r1" } }], [{ collection: "racks", id: "r1" }], fetchP).length, 0, "id supprimé PUIS recréé dans le MÊME lot → autorisé (deletes avant creates)");
    ck.eq(ApiRules.createConflicts([{ collection: "racks", record: { id: "neuf" } }], [], fetchP).length, 0, "id neuf → pas de collision");
    ck.eq(ApiRules.createConflicts([null, { collection: "racks" }, { collection: "racks", record: {} }], [], fetchP).length, 0, "entrées malformées ignorées");
  }
  });

  await section("Serveur : ApiRules — cascade résiduelle d'un lot (residualCascade)", async () => {
  {
    const { ApiRules } = SERVER("ApiRules.js");
    // Jeu de données : une baie r1 avec un rackItem monté et un équipement rack-é ; un port p1 câblé (c1),
    // dont la route traverse le waypoint w1.
    const mkData = () => ({
      racks: [{ id: "r1", name: "Baie" }],
      rackItems: [{ id: "ri1", rack_id: "r1" }],
      equipments: [{ id: "e1", rack_id: "r1", placement_mode: "rack" }],
      ports: [{ id: "p1", equipment_id: "e9" }],
      cables: [{ id: "c1", from_port_id: "p1", to_port_id: "px", waypoint_ids: ["w1"] }],
      waypoints: [{ id: "w1" }],
    });
    const finders = (data, body) => {
      const find = (c, f, v) => (data[c] || []).filter((r) => (Array.isArray(r[f]) ? r[f].includes(v) : r[f] === v));
      const fetch = (c, id) => (data[c] || []).find((r) => r.id === id) || null;
      // Mêmes lecteurs CONSCIENTS DU LOT que le serveur (api.ts) : état post-lot → seul le résidu ressort.
      return { find: Validation.DataValidator.buildBatchChildFinder(find, body), fetch: Validation.DataValidator.buildBatchFetcher(fetch, body) };
    };
    // 1) Lot INCOMPLET (client périmé : il ignore ri1/e1) → le serveur découvre le travail manquant.
    {
      const body = { deletes: [{ collection: "racks", id: "r1" }] };
      const { find, fetch } = finders(mkData(), body);
      const plan = ApiRules.residualCascade(body.deletes, find, fetch);
      ck(plan.deletes.some((d) => d.collection === "rackItems" && d.id === "ri1"), "lot incomplet : rackItem monté → suppression résiduelle découverte");
      const detach = plan.updates.find((u) => u.collection === "equipments" && u.record.id === "e1");
      ck(!!detach && detach.record.rack_id === null && detach.record.placement_mode === "manual", "lot incomplet : équipement rack-é → détaché (rack_id null + placement manual)");
    }
    // 2) Lot COMPLET (le client a déjà calculé la cascade) → résidu VIDE (pas de double travail).
    {
      const body = {
        deletes: [{ collection: "racks", id: "r1" }, { collection: "rackItems", id: "ri1" }],
        updates: [{ collection: "equipments", record: { id: "e1", rack_id: null, placement_mode: "manual" } }],
      };
      const { find, fetch } = finders(mkData(), body);
      const plan = ApiRules.residualCascade(body.deletes, find, fetch);
      ck.eq(plan.deletes.length + plan.updates.length, 0, "lot complet → résidu vide (les lecteurs conscients du lot voient l'état post-lot)");
    }
    // 3) GARDE ANTI-RÉSURRECTION : la suppression de p1 cascade sur c1 (delete), et celle de w1 voudrait
    //    DÉTACHER c1 (waypoint_ids) — un update sur c1 après son delete le RECRÉERAIT : il doit être écarté.
    {
      const body = { deletes: [{ collection: "ports", id: "p1" }, { collection: "waypoints", id: "w1" }] };
      const { find, fetch } = finders(mkData(), body);
      const plan = ApiRules.residualCascade(body.deletes, find, fetch);
      ck(plan.deletes.some((d) => d.collection === "cables" && d.id === "c1"), "port câblé supprimé → câble supprimé en cascade");
      ck(!plan.updates.some((u) => u.collection === "cables" && u.record.id === "c1"), "anti-résurrection : AUCUN update sur un câble supprimé par la cascade");
    }
    // 4) Ordre inverse des deletes (w1 avant p1) → même invariant (le filtre final couvre les deux ordres).
    {
      const body = { deletes: [{ collection: "waypoints", id: "w1" }, { collection: "ports", id: "p1" }] };
      const { find, fetch } = finders(mkData(), body);
      const plan = ApiRules.residualCascade(body.deletes, find, fetch);
      ck(!plan.updates.some((u) => u.collection === "cables" && u.record.id === "c1"), "anti-résurrection : idem quel que soit l'ordre des deletes du lot");
    }
  }

  /* ============ SERVEUR : Repository + DocumentStore (SQLite RÉEL) ============ */
  });

  await section("Serveur : Repository / DocumentStore (better-sqlite3 réel)", async () => {
  let SqliteDatabase = null;
  // PROBE complet (require + ouverture) : le module peut être présent mais son BINAIRE NATIF absent ou compilé
  // pour un autre Node (bindings introuvables) — dans les deux cas on SAUTE avec un avertissement visible.
  try {
    const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
    new Candidate(":memory:").close();
    SqliteDatabase = Candidate;
  } catch (e) { console.log("  (better-sqlite3 inutilisable ici : " + ((e && e.message) || e).split("\n")[0] + ")"); }
  if (!SqliteDatabase) {
    console.log("  ⚠ SAUTÉ : better-sqlite3 indisponible — `npm ci` (ou `npm rebuild better-sqlite3`) dans src-server/ pour couvrir le serveur. La CI les exécute.");
  } else {
    const { Repository } = SERVER("db.js");
    const repo = Repository.open(":memory:", SqliteDatabase);
    // -- aller-retour + verrou optimiste par entité (updated_rev) --
    repo.upsert("racks", { id: "r1", name: "Baie 1" }, 3);
    ck.eq(repo.getOne("racks", "r1").name, "Baie 1", "upsert/getOne : aller-retour JSON");
    ck.eq(repo.conflicts([{ collection: "racks", id: "r1" }], 2).length, 1, "conflicts : écrite en rev 3 > baseRev 2 → CONFLIT (409)");
    ck.eq(repo.conflicts([{ collection: "racks", id: "r1" }], 3).length, 0, "conflicts : baseRev 3 (à jour) → pas de conflit");
    ck.eq(repo.conflicts([{ collection: "racks", id: "absent" }], 0).length, 0, "conflicts : entité absente (création / déjà supprimée) → pas de conflit");
    ck.eq(repo.conflicts([{ collection: "PAS_UNE_TABLE", id: "r1" }], 0).length, 0, "conflicts : collection hors liste blanche ignorée");
    repo.upsert("racks", { id: "r1", name: "Baie 1b" }, 5);
    ck.eq(repo.conflicts([{ collection: "racks", id: "r1" }], 4).length, 1, "conflicts : ré-écriture → updated_rev ré-estampillée (rev 5 > baseRev 4)");
    // -- transact : ordre deletes → updates → creates, atomicité --
    repo.upsert("ports", { id: "p1", name: "old" }, 1);
    repo.transact({ deletes: [{ collection: "ports", id: "p1" }], creates: [{ collection: "ports", record: { id: "p2" } }] }, 6);
    ck.eq(repo.getOne("ports", "p1"), null, "transact : delete appliqué");
    ck(!!repo.getOne("ports", "p2"), "transact : create appliqué");
    repo.upsert("cables", { id: "c1" }, 1);
    repo.transact({ deletes: [{ collection: "cables", id: "c1" }], updates: [{ collection: "cables", record: { id: "c1", note: "res" } }] }, 7);
    ck(!!repo.getOne("cables", "c1"), "transact : update APRÈS delete ressuscite l'enregistrement (upsert) — d'où la garde d'ApiRules");
    repo.upsert("racks", { id: "r2" }, 1);
    let batchThrew = false;
    try { repo.transact({ deletes: [{ collection: "racks", id: "r2" }, { collection: "NIMPORTE", id: "x" }] }, 8); } catch (_) { batchThrew = true; }
    ck(batchThrew && !!repo.getOne("racks", "r2"), "transact : entrée invalide → TOUT le lot rejeté (transaction SQLite, r2 intact)");
    // -- list / where : égalité JSON + appartenance à un champ tableau (json_each) --
    repo.upsert("cables", { id: "c2", network_ids: ["n1", "n2"], network_id: "n1" }, 1);
    ck.eq(repo.list("cables", { where: { network_ids: "n2" } }).rows.length, 1, "list where : appartenance à un champ tableau");
    ck.eq(repo.list("cables", { where: { network_id: "n1" } }).rows.length, 1, "list where : égalité sur champ scalaire");
    repo.close();

    // -- DocumentStore : cycle de vie complet SUR DISQUE (fix Windows : close() avant suppression) --
    const fs = require("fs"), os = require("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-docs-"));
    const { DocumentStore } = SERVER("documents.js");
    const docs = new DocumentStore(dir, SqliteDatabase);   // Logger par défaut : "error" → silencieux
    const created = docs.create("Doc test");
    ck(!!created.id && created.name === "Doc test", "DocumentStore.create : méta renvoyée");
    ck(fs.existsSync(path.join(dir, created.id + ".db")), "create : fichier SQLite matérialisé sur disque");
    const rev = docs.markChanged(created.id);
    ck.eq(docs.getRev(created.id), rev, "markChanged : rev incrémentée et relue");
    docs.repo(created.id).upsert("racks", { id: "r1" }, rev);   // ouvre le handle → le cas Windows EBUSY sans close()
    docs.setDefaultDocId(created.id);
    ck.eq(docs.delete(created.id), true, "delete : accepté");
    ck(!fs.existsSync(path.join(dir, created.id + ".db")), "delete : fichier .db SUPPRIMÉ du disque (handle fermé AVANT rmSync — fix Windows)");
    ck.eq(docs.get(created.id), null, "delete : ligne registre supprimée");
    ck.eq(docs.getDefaultDocId(), null, "delete : réglage defaultDocId périmé effacé");
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* registry.db encore ouvert (process-long) : dossier temp, sans conséquence */ }
  }

  /* ============ CLIENT REST : protocole pur (sans réseau) ============ */
  });

  await section("RestProtocol : interprétation des réponses (X-Doc-Rev, 409, 400 structuré)", async () => {
  {
    const { RestProtocol } = D("data/RestProtocol.js");
    const resp = (status, { body = "", rev = null } = {}) => ({
      status, ok: status >= 200 && status < 300,
      header: (n) => (n === "X-Doc-Rev" ? rev : null),
      text: async () => body,
    });
    const p = new RestProtocol();
    await p.interpret(resp(200, { body: "{}", rev: "7" }), "GET", "/meta");
    ck.eq(p.docRev, 7, "X-Doc-Rev → docRev synchronisé");
    await p.interpret(resp(200, { body: "{}" }), "GET", "/meta");
    ck.eq(p.docRev, 7, "réponse sans X-Doc-Rev → docRev conservé");
    ck.eq(JSON.stringify(p.writeHeaders()), JSON.stringify({ "X-Base-Rev": "7" }), "writeHeaders : X-Base-Rev = docRev courant");
    let conflictInfo = null; p.onConflict = (i) => { conflictInfo = i; };
    const r409 = await p.interpret(resp(409, { body: JSON.stringify({ conflicts: [{ collection: "racks", id: "r1", rev: 9 }] }), rev: "9" }), "PUT", "/racks/r1");
    ck.eq(r409, null, "409 → null (pas de throw, pas de rejeu : le hôte recharge)");
    ck(!!conflictInfo && conflictInfo.conflicts[0].id === "r1", "409 → onConflict notifié avec les entités en conflit");
    ck.eq(p.docRev, 9, "409 → docRev resynchronisé sur la rev serveur");
    let valErrors = null; p.onValidationError = (e) => { valErrors = e; };
    const r400 = await p.interpret(resp(400, { body: JSON.stringify({ errors: [{ collection: "racks", path: "name", code: "required", message: "requis" }] }) }), "POST", "/racks");
    ck.eq(r400, null, "400 structuré → null (notifié, pas de throw)");
    ck(!!valErrors && valErrors[0].code === "required", "400 structuré → onValidationError");
    let threw400 = false;
    try { await p.interpret(resp(400, { body: JSON.stringify({ error: "boom" }) }), "POST", "/racks"); } catch (e) { threw400 = /boom/.test(e.message); }
    ck(threw400, "400 NON structuré → throw (message serveur inclus)");
    ck.eq(await p.interpret(resp(404), "GET", "/racks/x", { allow404: true }), null, "404 toléré → null");
    let threw404 = false;
    try { await p.interpret(resp(404), "GET", "/racks/x"); } catch (_) { threw404 = true; }
    ck(threw404, "404 non toléré → throw");
    ck.eq(await p.interpret(resp(204), "PUT", "/meta"), null, "204 → null (pas de corps)");
    ck.eq((await p.interpret(resp(200, { body: '{"a":1}' }), "GET", "/x")).a, 1, "200 → corps JSON parsé");
  }
  });
};
