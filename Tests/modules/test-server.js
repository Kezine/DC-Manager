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
    // -- findBy : finder LEAN de la validation (V5b/V6), MÊMES lignes que list().where mais sans COUNT/tri/pagination --
    ck.eq(repo.findBy("cables", "network_id", "n1").length, 1, "findBy : égalité scalaire (parité list where)");
    ck.eq(repo.findBy("cables", "network_ids", "n2").length, 1, "findBy : appartenance à un champ tableau (parité list where)");
    ck.eq(repo.findBy("cables", "network_id", "zzz").length, 0, "findBy : aucune correspondance → []");
    ck.eq(repo.findBy("NIMPORTE", "x", "y").length, 0, "findBy : collection inconnue → []");
    // -- maintenance : PURGE des images orphelines (référencées par AUCUN équipement) + VACUUM --
    repo.putImage("imgA", { name: "utilisée", type: "image/png" }, Buffer.from([1, 2, 3]));
    repo.putImage("imgB", { name: "orpheline", type: "image/png" }, Buffer.from([4, 5, 6]));
    repo.upsert("equipments", { id: "e1", name: "sw", face_image_id: "imgA" }, 1);
    const mnt = repo.maintenance();
    ck.eq(mnt.purgedImages, 1, "maintenance : 1 image orpheline purgée");
    ck(!!repo.getImageMeta("imgA"), "maintenance : l'image RÉFÉRENCÉE (face_image_id) est conservée");
    ck.eq(repo.getImageMeta("imgB"), null, "maintenance : l'image orpheline est supprimée");
    ck.eq(repo.maintenance().purgedImages, 0, "maintenance : re-run → plus rien à purger (idempotent)");
    // -- rev d'image : jeton de cache-busting — bumpé à CHAQUE nouveau blob (même taille incluse), pas en méta seule --
    repo.upsert("equipments", { id: "e2", name: "sw2", face_image_id: "imgR" }, 1);   // référencée (survivra aux maintenances)
    repo.putImage("imgR", { name: "v1", type: "image/png" }, Buffer.from([1, 2]));
    ck.eq(repo.getImageMeta("imgR").rev, 1, "putImage : rev = 1 à la création");
    repo.putImage("imgR", { name: "v1 renommée", type: "image/png" }, null);
    ck.eq(repo.getImageMeta("imgR").rev, 1, "putImage : édition de MÉTA seule → rev inchangée");
    repo.putImage("imgR", { name: "v2", type: "image/png" }, Buffer.from([3, 4]));   // nouveau blob de MÊME taille
    ck.eq(repo.getImageMeta("imgR").rev, 2, "putImage : nouveau blob (même taille) → rev incrémentée (l'ancien jeton bytes ne le voyait pas)");
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

  /* ============ SERVEUR : ProxmoxParse (parsing Proxmox PUR, module vm/ amovible) ============ */

  await section("Serveur : ProxmoxParse.parseNetString — chaîne d'interface (QEMU/LXC, tolérance)", async () => {
  {
    const { ProxmoxParse } = SERVER("vm/ProxmoxParse.js");
    // QEMU multi-champs : le modèle est la clé dont la valeur est une MAC.
    const q = ProxmoxParse.parseNetString("virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=42,firewall=1");
    ck.eq(q.model, "virtio", "QEMU : modèle = clé porteuse de la MAC");
    ck.eq(q.mac, "AA:BB:CC:DD:EE:FF", "QEMU : MAC extraite de la valeur du modèle");
    ck.eq(q.bridge, "vmbr0", "QEMU : bridge");
    ck.eq(q.vlan_tag, 42, "QEMU : tag VLAN numérique");
    ck.eq(q.name, null, "QEMU : pas de nom interne dans la chaîne (vient de la clé netN)");
    ck.eq(q.ip, null, "QEMU : pas d'IP statique");
    // QEMU sans tag + autre modèle (e1000) : résilience de la détection par forme de valeur.
    const q2 = ProxmoxParse.parseNetString("e1000=DE:AD:BE:EF:00:01,bridge=vmbr9");
    ck(q2.model === "e1000" && q2.mac === "DE:AD:BE:EF:00:01" && q2.bridge === "vmbr9" && q2.vlan_tag === null, "QEMU sans tag : vlan_tag null, modèle e1000 reconnu");
    // LXC : nom interne, hwaddr, IP statique CIDR (préfixe retiré).
    const l = ProxmoxParse.parseNetString("name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:11:22,ip=10.0.0.5/24,gw=10.0.0.1,tag=7,firewall=1");
    ck.eq(l.name, "eth0", "LXC : nom interne eth0");
    ck.eq(l.mac, "BC:24:11:00:11:22", "LXC : MAC depuis hwaddr");
    ck.eq(l.ip, "10.0.0.5", "LXC : IP statique sans préfixe CIDR");
    ck.eq(l.vlan_tag, 7, "LXC : tag VLAN");
    ck.eq(l.model, null, "LXC : pas de modèle de carte (hwaddr n'est pas un modèle)");
    // LXC ip=dhcp / manual → pas d'IP statique.
    ck.eq(ProxmoxParse.parseNetString("name=eth0,bridge=vmbr0,ip=dhcp").ip, null, "LXC : ip=dhcp → pas d'IP");
    ck.eq(ProxmoxParse.parseNetString("name=eth0,ip=manual").ip, null, "LXC : ip=manual → pas d'IP");
    // TOLÉRANCE : chaîne malformée → ce qui est extractible, sans throw.
    const m = ProxmoxParse.parseNetString("virtio,bridge=vmbr0,tag=notanumber,inconnu=xyz");
    ck(m.model === null && m.mac === null, "malformé : segment sans '=' ignoré (pas de MAC)");
    ck.eq(m.bridge, "vmbr0", "malformé : bridge quand même extrait");
    ck.eq(m.vlan_tag, null, "malformé : tag non numérique → null");
    const empty = ProxmoxParse.parseNetString("");
    ck(empty.model === null && empty.mac === null && empty.bridge === null && empty.vlan_tag === null && empty.ip === null, "chaîne vide → tout null");
    ck(ProxmoxParse.parseNetString(null) && ProxmoxParse.parseNetString(undefined).mac === null, "null/undefined → objet tout-null (pas de throw)");
  }
  });

  await section("Serveur : ProxmoxParse.fromClusterResources — squelettes (templates exclus, tolérance statut/tags)", async () => {
  {
    const { ProxmoxParse } = SERVER("vm/ProxmoxParse.js");
    // Réponse réaliste PVE 8/9 : enveloppe { data: [...] }, tailles en OCTETS, tags séparés par ';'.
    const resp = { data: [
      { id: "qemu/100", type: "qemu", node: "pve1", vmid: 100, name: "web01", status: "running", maxcpu: 4, maxmem: 8589934592, maxdisk: 34359738368, template: 0, tags: "prod;web;edge" },
      { id: "lxc/101", type: "lxc", node: "pve2", vmid: 101, name: "db01", status: "stopped", maxcpu: 2, maxmem: 2147483648, maxdisk: 10737418240, tags: "db" },
      { id: "qemu/102", type: "qemu", node: "pve1", vmid: 102, name: "susp", status: "prelaunch", maxcpu: 1, maxmem: 1073741824, maxdisk: 0 },
      { id: "qemu/9000", type: "qemu", node: "pve1", vmid: 9000, name: "modele", status: "stopped", template: 1, maxcpu: 4, maxmem: 4294967296, maxdisk: 21474836480 },
    ] };
    const recs = ProxmoxParse.fromClusterResources("prod-cluster", resp);
    ck.eq(recs.length, 3, "templates exclus : 3 records (le template vmid 9000 est écarté)");
    const byId = {}; for (const r of recs) byId[r.ext_id] = r;
    const web = byId["prod-cluster/100"];
    ck(!!web, "ext_id = clusterName + '/' + vmid");
    ck.eq(web.vm_type, "qemu", "vm_type qemu");
    ck.eq(web.host_node, "pve1", "host_node depuis 'node'");
    ck.eq(web.status, "running", "status conservé");
    ck.eq(web.cpu, 4, "cpu depuis maxcpu");
    ck.eq(web.ram_mb, 8192, "ram_mb : octets → Mo (8589934592 → 8192)");
    ck.eq(web.disk_gb, 32, "disk_gb : octets → Go (34359738368 → 32)");
    ck.eq(JSON.stringify(web.tags), JSON.stringify(["prod", "web", "edge"]), "tags multiples séparés par ';'");
    ck.eq(web.provider_id, "", "provider_id laissé vide (estampillé par l'adaptateur)");
    ck.eq(JSON.stringify(web.nics), "[]", "nics vides dans le squelette");
    const db = byId["prod-cluster/101"];
    ck(db.vm_type === "lxc" && db.ram_mb === 2048 && db.disk_gb === 10, "lxc : conversions Mo/Go correctes");
    const susp = byId["prod-cluster/102"];
    ck.eq(susp.status, "prelaunch", "statut INCONNU conservé tel quel (résilience releases)");
    ck.eq(susp.disk_gb, 0, "maxdisk 0 → disk_gb 0 (valeur, pas null)");
    // Tolérance d'enveloppe : tableau nu accepté aussi bien que { data: [...] }.
    ck.eq(ProxmoxParse.fromClusterResources("c", resp.data).length, 3, "tolérance : tableau déjà déballé accepté");
    ck.eq(ProxmoxParse.fromClusterResources("c", null).length, 0, "tolérance : JSON nul → []");
    ck.eq(ProxmoxParse.fromClusterResources("c", {}).length, 0, "tolérance : objet sans data → []");
    // RÉPONSE NON FILTRÉE (?type=vm absent) : les entrées SANS vmid (nœuds, stockages, pools) sont
    // IGNORÉES — c'est ce qui permet à l'adaptateur d'appeler /cluster/resources sans filtre et d'en
    // tirer les VMs (ici) ET les nœuds (nodesFromClusterResources) en UNE seule réponse.
    const mixed = { data: [
      { type: "node", id: "node/pve1", node: "pve1", status: "online", cpu: 0.1, maxcpu: 8, mem: 4294967296, maxmem: 17179869184 },
      { type: "storage", id: "storage/pve1/local", node: "pve1", status: "available", maxdisk: 500000000000 },
      { type: "pool", id: "pool/prod", pool: "prod" },
      { id: "qemu/300", type: "qemu", node: "pve1", vmid: 300, name: "app", status: "running", maxcpu: 2, maxmem: 2147483648, maxdisk: 0 },
    ] };
    const mixedRecs = ProxmoxParse.fromClusterResources("prod-cluster", mixed);
    ck.eq(mixedRecs.length, 1, "réponse non filtrée : seules les entrées AVEC vmid deviennent des VMs (node/storage/pool écartés)");
    ck.eq(mixedRecs[0].ext_id, "prod-cluster/300", "…la seule VM (vmid 300) est retenue");
  }
  });

  await section("Serveur : ProxmoxParse.nodesFromClusterResources — nœuds + métriques (online/offline, conversions, tolérance)", async () => {
  {
    const { ProxmoxParse } = SERVER("vm/ProxmoxParse.js");
    // Réponse cluster-wide NON filtrée : entrées `type:"node"` mêlées aux VMs / stockages.
    const resp = { data: [
      { type: "node", id: "node/pve1", node: "pve1", status: "online", cpu: 0.0625, maxcpu: 16, mem: 8589934592, maxmem: 34359738368, uptime: 864000 },
      { type: "node", id: "node/pve2", node: "pve2", status: "offline", cpu: null, maxcpu: 8, mem: 0, maxmem: 17179869184, uptime: 0 },
      { vmid: 100, type: "qemu", node: "pve1", name: "web", status: "running", maxcpu: 4, maxmem: 4294967296 }, // VM → ignorée ici
      { type: "storage", id: "storage/pve1/local", node: "pve1", status: "available" },                        // stockage → ignoré
    ] };
    const nodes = ProxmoxParse.nodesFromClusterResources(resp);
    ck.eq(nodes.length, 2, "seules les entrées type:'node' deviennent des nœuds (VMs et stockages ignorés)");
    const n1 = nodes.find((n) => n.name === "pve1");
    ck.eq(n1.online, true, "statut 'online' → online true");
    ck.eq(n1.cpu_used, 0.0625, "cpu_used = fraction 0..1 telle quelle (aucune conversion en %)");
    ck.eq(n1.cpu_total, 16, "cpu_total depuis maxcpu");
    ck(n1.mem_used_mb === 8192 && n1.mem_total_mb === 32768, "mem/maxmem OCTETS → Mo (8Gi→8192, 32Gi→32768)");
    ck.eq(n1.uptime_sec, 864000, "uptime_sec depuis uptime (secondes)");
    const n2 = nodes.find((n) => n.name === "pve2");
    ck.eq(n2.online, false, "statut 'offline' → online false");
    ck.eq(n2.cpu_used, null, "métrique manquante (cpu null) → null (jamais devinée)");
    ck.eq(n2.mem_total_mb, 16384, "nœud hors ligne : maxmem tout de même converti (16Gi→16384)");
    // TOLÉRANCE : item malformé ignoré, nœud sans nom écarté, entrée non-objet sautée.
    const malformed = { data: [
      { type: "node", node: "", status: "online" }, // nom vide → écarté (name n'est PAS nullable)
      { type: "node", status: "online" },           // pas de champ node → écarté
      null, 42, "x",                                  // entrées non-objet → sautées
      { type: "node", node: "pve3", status: "weird" }, // statut inconnu → hors ligne, métriques null
    ] };
    const tol = ProxmoxParse.nodesFromClusterResources(malformed);
    ck.eq(tol.length, 1, "tolérance : seuls les nœuds NOMMÉS sont retenus (malformés/anonymes écartés)");
    ck(tol[0].name === "pve3" && tol[0].online === false, "statut inconnu → hors ligne (prudence)");
    ck(tol[0].cpu_used === null && tol[0].cpu_total === null && tol[0].mem_used_mb === null && tol[0].uptime_sec === null, "…toutes les métriques absentes → null");
    // Enveloppe : tableau nu accepté ; réponse vide/nulle → [] (mémoire vide, jamais de throw).
    ck.eq(ProxmoxParse.nodesFromClusterResources(resp.data).length, 2, "tolérance : tableau déjà déballé accepté");
    ck.eq(ProxmoxParse.nodesFromClusterResources(null).length, 0, "réponse nulle → [] (mémoire vide)");
    ck.eq(ProxmoxParse.nodesFromClusterResources({}).length, 0, "objet sans data → []");
    ck.eq(ProxmoxParse.nodesFromClusterResources({ data: [] }).length, 0, "cluster sans nœud remonté → []");
  }
  });

  await section("Serveur : ProxmoxParse.clusterStatusInfo — nom + quorate (quorate 1/0, nœud isolé → null, tolérance)", async () => {
  {
    const { ProxmoxParse } = SERVER("vm/ProxmoxParse.js");
    // Cluster nommé, quorate 1 → name + quorate true.
    const q1 = ProxmoxParse.clusterStatusInfo({ data: [
      { type: "cluster", id: "cluster", name: "prod-cluster", nodes: 3, quorate: 1 },
      { type: "node", id: "node/pve1", name: "pve1", online: 1 },
      { type: "node", id: "node/pve2", name: "pve2", online: 1 },
    ] });
    ck(q1.name === "prod-cluster" && q1.quorate === true, "cluster nommé + quorate:1 → name + quorate true");
    // Quorum PERDU (quorate 0) → false, DISTINCT de null (le cluster existe mais a perdu le quorum).
    const q0 = ProxmoxParse.clusterStatusInfo({ data: [ { type: "cluster", name: "prod-cluster", quorate: 0 }, { type: "node", name: "pve1" } ] });
    ck(q0.name === "prod-cluster" && q0.quorate === false, "quorate:0 → quorate false (quorum PERDU, ≠ inconnu)");
    // Nœud ISOLÉ (aucune entrée cluster) → nom du nœud unique, quorate inconnu (null).
    const solo = ProxmoxParse.clusterStatusInfo({ data: [ { type: "node", name: "pve-solo", online: 1 } ] });
    ck(solo.name === "pve-solo" && solo.quorate === null, "nœud isolé → name = nœud unique, quorate null (quorum sans objet)");
    // Plusieurs nœuds sans entrée cluster (cas dégénéré) → nom indéterminé → null.
    const ambiguous = ProxmoxParse.clusterStatusInfo({ data: [ { type: "node", name: "a" }, { type: "node", name: "b" } ] });
    ck(ambiguous.name === null && ambiguous.quorate === null, "plusieurs nœuds sans cluster → nom indéterminé (null), quorate null");
    // TOLÉRANCE : quorate booléen accepté ; enveloppe déballée ; réponse vide/nulle → tout null, jamais de throw.
    ck.eq(ProxmoxParse.clusterStatusInfo({ data: [ { type: "cluster", name: "c", quorate: true } ] }).quorate, true, "quorate booléen true accepté");
    const bare = ProxmoxParse.clusterStatusInfo([ { type: "cluster", name: "c", quorate: 1 } ]);
    ck(bare.name === "c" && bare.quorate === true, "tolérance : tableau déjà déballé accepté");
    ck(ProxmoxParse.clusterStatusInfo(null).name === null && ProxmoxParse.clusterStatusInfo(null).quorate === null, "réponse nulle → { name:null, quorate:null } (pas de throw)");
    ck.eq(ProxmoxParse.clusterStatusInfo({}).name, null, "objet sans data → name null");
  }
  });

  await section("Serveur : ProxmoxParse.mergeConfig — enrichissement (cpu/ram/nics, tri netN, fusion tolérante)", async () => {
  {
    const { ProxmoxParse } = SERVER("vm/ProxmoxParse.js");
    // QEMU : cpu = cores × sockets, ram = memory (déjà en Mo), nics depuis netN.
    const rec = ProxmoxParse.fromClusterResources("prod-cluster", { data: [
      { type: "qemu", node: "pve1", vmid: 100, name: "web01", status: "running", maxcpu: 4, maxmem: 8589934592, maxdisk: 34359738368 },
    ] })[0];
    const cfg = { data: {
      name: "web01", description: "Serveur web\nfrontal", cores: 2, sockets: 2, memory: 8192,
      net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=42,firewall=1",
      net1: "virtio=AA:BB:CC:DD:EE:00,bridge=vmbr1",
      net10: "e1000=AA:BB:CC:DD:EE:10,bridge=vmbr2,tag=100",
    } };
    ProxmoxParse.mergeConfig(rec, cfg);
    ck.eq(rec.description, "Serveur web\nfrontal", "description depuis la config");
    ck.eq(rec.cpu, 4, "QEMU : cpu = cores × sockets (2 × 2)");
    ck.eq(rec.ram_mb, 8192, "ram_mb depuis memory (déjà en Mo)");
    ck.eq(rec.nics.length, 3, "3 vNIC depuis net0/net1/net10");
    ck.eq(rec.nics[0].name, "net0", "QEMU : nom de vNIC = clé netN");
    ck.eq(rec.nics[0].vlan_tag, 42, "net0 : tag 42");
    ck.eq(rec.nics[1].vlan_tag, null, "net1 : sans tag → null");
    ck.eq(rec.nics[2].name, "net10", "tri NUMÉRIQUE : net10 en dernier (pas après net1)");
    ck.eq(rec.nics[2].vlan_tag, 100, "net10 : tag 100");
    // LXC : cpu = cores, nic avec nom interne + IP statique embarquée.
    const lrec = ProxmoxParse.fromClusterResources("prod-cluster", { data: [
      { type: "lxc", node: "pve2", vmid: 101, name: "db01", status: "running", maxcpu: 2, maxmem: 2147483648, maxdisk: 10737418240 },
    ] })[0];
    ProxmoxParse.mergeConfig(lrec, { data: { hostname: "db01", cores: 2, memory: 2048, net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:11:22,ip=10.0.0.5/24,gw=10.0.0.1,tag=7" } });
    ck.eq(lrec.cpu, 2, "LXC : cpu = cores (pas de sockets)");
    ck.eq(lrec.nics[0].name, "eth0", "LXC : nom de vNIC = nom interne (eth0)");
    ck.eq(lrec.nics[0].mac, "BC:24:11:00:11:22", "LXC : MAC depuis hwaddr");
    ck.eq(JSON.stringify(lrec.nics[0].ips), JSON.stringify(["10.0.0.5"]), "LXC : IP statique embarquée dans ips");
    // FUSION TOLÉRANTE : config sans cores/memory/netN → valeurs du squelette conservées (jamais écrasées par null).
    const keep = ProxmoxParse.fromClusterResources("prod-cluster", { data: [
      { type: "qemu", node: "pve1", vmid: 200, name: "x", status: "running", maxcpu: 8, maxmem: 4294967296, maxdisk: 0 },
    ] })[0];
    ProxmoxParse.mergeConfig(keep, { data: { name: "x" } });
    ck(keep.cpu === 8 && keep.ram_mb === 4096 && keep.nics.length === 0, "fusion tolérante : config partielle n'écrase pas cpu/ram et ne fabrique pas de nics");
  }
  });

  await section("Serveur : ProxmoxParse.mergeAgentInterfaces — IPs par MAC (filtres loopback/link-local, au mieux)", async () => {
  {
    const { ProxmoxParse } = SERVER("vm/ProxmoxParse.js");
    const rec = ProxmoxParse.fromClusterResources("prod-cluster", { data: [
      { type: "qemu", node: "pve1", vmid: 100, name: "web01", status: "running", maxcpu: 4, maxmem: 8589934592, maxdisk: 34359738368 },
    ] })[0];
    ProxmoxParse.mergeConfig(rec, { data: { net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=42" } });
    // Réponse guest-agent réaliste : loopback + link-local IPv6 à FILTRER, MAC en minuscules (rapprochement insensible à la casse).
    const agent = { data: { result: [
      { name: "lo", "hardware-address": "00:00:00:00:00:00", "ip-addresses": [
        { "ip-address-type": "ipv4", "ip-address": "127.0.0.1", prefix: 8 },
        { "ip-address-type": "ipv6", "ip-address": "::1", prefix: 128 },
      ] },
      { name: "eth0", "hardware-address": "aa:bb:cc:dd:ee:ff", "ip-addresses": [
        { "ip-address-type": "ipv4", "ip-address": "192.168.1.50", prefix: 24 },
        { "ip-address-type": "ipv6", "ip-address": "fe80::1234", prefix: 64 },
        { "ip-address-type": "ipv6", "ip-address": "2001:db8::5", prefix: 64 },
      ] },
    ] } };
    ProxmoxParse.mergeAgentInterfaces(rec, agent);
    const ips = rec.nics[0].ips;
    ck(ips.includes("192.168.1.50"), "IPv4 réelle rapprochée par MAC (casse ignorée)");
    ck(ips.includes("2001:db8::5"), "IPv6 globale conservée");
    ck(!ips.includes("fe80::1234"), "IPv6 link-local (fe80::/10) filtrée");
    ck(!ips.includes("127.0.0.1") && !ips.includes("::1"), "loopback (127.0.0.0/8, ::1) filtré");
    ck.eq(ips.length, 2, "exactement 2 IPs retenues");
    // Agent ABSENT / format inattendu → record INCHANGÉ, pas de throw.
    const before = JSON.stringify(rec.nics);
    ProxmoxParse.mergeAgentInterfaces(rec, { data: {} });
    ProxmoxParse.mergeAgentInterfaces(rec, null);
    ProxmoxParse.mergeAgentInterfaces(rec, { data: { result: "pas-un-tableau" } });
    ck.eq(JSON.stringify(rec.nics), before, "agent absent/erreur/format inattendu → nics inchangés");
    // DÉDUP : une IP déjà présente (statique LXC) n'est pas ajoutée deux fois.
    const lrec = ProxmoxParse.fromClusterResources("prod-cluster", { data: [ { type: "lxc", node: "pve2", vmid: 101, name: "db", status: "running" } ] })[0];
    ProxmoxParse.mergeConfig(lrec, { data: { net0: "name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:11:22,ip=10.0.0.5/24" } });
    ProxmoxParse.mergeAgentInterfaces(lrec, { data: { result: [ { "hardware-address": "BC:24:11:00:11:22", "ip-addresses": [ { "ip-address": "10.0.0.5", prefix: 24 }, { "ip-address": "10.0.0.6", prefix: 24 } ] } ] } });
    ck.eq(JSON.stringify(lrec.nics[0].ips), JSON.stringify(["10.0.0.5", "10.0.0.6"]), "dédup : IP statique déjà présente non dupliquée, nouvelle ajoutée");
  }
  });

  /* ============ SERVEUR : ProviderConfigStore (config providers VM PAR DOCUMENT, module vm/ amovible) ============ */

  await section("Serveur : ProviderConfigStore.parse — fichier valide multi-documents + défauts", async () => {
  {
    const { ProviderConfigStore } = SERVER("vm/ProviderConfigStore.js");
    const fp64 = Array(32).fill("AB").join(":"); // 32 octets → 64 hex séparés par ':' (empreinte SHA-256 valide)
    const valid = JSON.stringify({
      "doc-A": {
        docName: "Infra Paris (libellé libre, doit être IGNORÉ)",
        providers: [
          { id: "pve-paris", kind: "proxmox", url: "https://pve1.paris:8006", token: "root@pam!inv=UUID-1", fingerprint: fp64, include_lxc: false, interval_sec: 300 },
          { id: "pve-paris-2", kind: "proxmox", url: "https://pve2.paris:8006", token: "root@pam!inv=UUID-2" },
        ],
      },
      "doc-B": {
        providers: [
          { id: "pve-lyon", kind: "proxmox", url: "https://pve.lyon:8006", token: "svc@pve!ro=UUID-3", extraKeyInconnue: 42 },
        ],
      },
    });
    const map = ProviderConfigStore.parse(valid);
    ck.eq(map.size, 2, "2 documents parsés");
    const a = map.get("doc-A");
    ck.eq(a.length, 2, "doc-A : 2 providers (multi-clusters dans un document)");
    ck.eq(a[0].id, "pve-paris", "id conservé");
    ck.eq(a[0].kind, "proxmox", "kind conservé");
    // Raccourci MONO-NŒUD `url`/`fingerprint` → pool d'UN endpoint (l'empreinte suit l'entrée).
    ck.eq(a[0].endpoints.length, 1, "raccourci url → pool d'un seul endpoint");
    ck.eq(a[0].endpoints[0].url, "https://pve1.paris:8006", "url conservée (dans l'endpoint)");
    ck.eq(a[0].endpoints[0].fingerprint, fp64, "fingerprint valide conservée TELLE QUELLE (PveHttp normalise à la comparaison)");
    ck.eq(a[0].include_lxc, false, "include_lxc explicite (false) conservé");
    ck.eq(a[0].interval_sec, 300, "interval_sec explicite (300) conservé");
    // DÉFAUTS sur le 2e provider (rien fourni) : include_lxc true, interval_sec 0, fingerprint null, timeout 15 s.
    ck.eq(a[1].include_lxc, true, "défaut include_lxc = true (décision de cadrage)");
    ck.eq(a[1].interval_sec, 0, "défaut interval_sec = 0 (synchro manuelle)");
    ck.eq(a[1].endpoints[0].fingerprint, null, "défaut fingerprint = null (validation CA système)");
    ck.eq(a[1].timeout_sec, 15, "défaut timeout_sec = 15 s (parité avec l'ancien délai codé en dur)");
    ck.eq(a[1].id, "pve-paris-2", "2e provider bien identifié");
    // docName TOLÉRÉ et IGNORÉ : il n'apparaît pas dans les ProviderConfig produits.
    ck(!("docName" in a[0]), "docName ignoré (absent des ProviderConfig)");
    const b = map.get("doc-B");
    ck.eq(b.length, 1, "doc-B : 1 provider");
    ck(!("extraKeyInconnue" in b[0]), "clé inconnue au niveau provider TOLÉRÉE (ignorée, pas recopiée)");
  }
  });

  await section("Serveur : ProviderConfigStore.parse — validation & erreurs explicites (token JAMAIS cité)", async () => {
  {
    const { ProviderConfigStore } = SERVER("vm/ProviderConfigStore.js");
    const parseErr = (json) => { try { ProviderConfigStore.parse(json); return null; } catch (e) { return e.message; } };
    // 1) Champ requis manquant → message citant docId + provider (id) + champ fautif.
    const mUrl = parseErr(JSON.stringify({ "doc-X": { providers: [ { id: "p1", kind: "proxmox", token: "root@pam!t=UUID" } ] } }));
    ck(!!mUrl, "champ manquant → lève");
    ck(/doc-X/.test(mUrl) && /p1/.test(mUrl) && /url/.test(mUrl), "message cite docId + id du provider + champ « url »");
    // 2) JSON invalide → message clair.
    const badJson = parseErr("{ ceci n'est pas du json");
    ck(!!badJson && /JSON invalide/.test(badJson), "JSON invalide → message explicite");
    // 3) Racine non-objet → message clair.
    ck(/racine/.test(parseErr("[]") || ""), "racine tableau refusée");
    // 4) Doublon d'id dans un document → erreur citant l'id.
    const dup = parseErr(JSON.stringify({ "doc-D": { providers: [
      { id: "same", kind: "proxmox", url: "https://a:8006", token: "t@pam!x=U1" },
      { id: "same", kind: "proxmox", url: "https://b:8006", token: "t@pam!x=U2" },
    ] } }));
    ck(!!dup && /double/.test(dup) && /same/.test(dup), "doublon d'id PAR document → erreur citant l'id");
    // 5) fingerprint mal formée (hex mais mauvaise longueur) → erreur.
    const badFp = parseErr(JSON.stringify({ "doc-F": { providers: [ { id: "pf", kind: "proxmox", url: "https://a:8006", token: "t@pam!x=U", fingerprint: "AA:BB:CC" } ] } }));
    ck(!!badFp && /fingerprint/.test(badFp) && /pf/.test(badFp), "fingerprint mal formée → erreur citant le champ + l'id");
    // 6) providers manquant / mal typé → erreur citant le document.
    ck(/providers/.test(parseErr(JSON.stringify({ "doc-P": { docName: "x" } })) || ""), "champ « providers » manquant → erreur");
    // 7) include_lxc non booléen / interval_sec négatif → erreurs de type.
    ck(/include_lxc/.test(parseErr(JSON.stringify({ "d": { providers: [ { id: "i", kind: "proxmox", url: "https://a:8006", token: "t@pam!x=U", include_lxc: "oui" } ] } })) || ""), "include_lxc non booléen → erreur");
    ck(/interval_sec/.test(parseErr(JSON.stringify({ "d": { providers: [ { id: "i", kind: "proxmox", url: "https://a:8006", token: "t@pam!x=U", interval_sec: -5 } ] } })) || ""), "interval_sec négatif → erreur");
    // 8) SÉCURITÉ : le token n'apparaît JAMAIS dans un message d'erreur (assertion explicite).
    const secret = "SUPER-SECRET-TOKEN=deadbeef-cafe-0000";
    const leaky = parseErr(JSON.stringify({ "doc-S": { providers: [ { id: "ps", kind: "proxmox", token: secret /* url manquante → provoque une erreur */ } ] } }));
    ck(!!leaky && !leaky.includes(secret), "le token n'apparaît JAMAIS dans le message d'erreur (secret non divulgué)");
    ck(/ps/.test(leaky) && /url/.test(leaky), "le message cite l'id du provider et le champ fautif (pas le token)");
  }
  });

  await section("Serveur : ProviderConfigStore.parse — POOL d'endpoints (urls, fingerprint par nœud, timeout)", async () => {
  {
    const { ProviderConfigStore } = SERVER("vm/ProviderConfigStore.js");
    const parseErr = (json) => { try { ProviderConfigStore.parse(json); return null; } catch (e) { return e.message; } };
    const fpA = Array(32).fill("AA").join(":"), fpB = Array(32).fill("BB").join(":");

    // POOL valide : entrées objet (empreinte PAR nœud) et chaîne (raccourci sans épinglage), mélangées.
    const pool = ProviderConfigStore.parse(JSON.stringify({ "doc-H": { providers: [
      { id: "pve-ha", kind: "proxmox", token: "t@pam!x=U", timeout_sec: 5, urls: [
        { url: "https://pve1:8006", fingerprint: fpA },
        { url: "https://pve2:8006", fingerprint: fpB },
        "https://pve3:8006",
      ] },
    ] } })).get("doc-H")[0];
    ck.eq(pool.endpoints.length, 3, "pool de 3 endpoints parsé");
    ck.eq(pool.endpoints[0].fingerprint, fpA, "empreinte du nœud 1 portée par SON entrée");
    ck.eq(pool.endpoints[1].fingerprint, fpB, "empreinte du nœud 2 distincte (un certificat PAR nœud)");
    ck.eq(pool.endpoints[2].fingerprint, null, "entrée chaîne = raccourci sans épinglage");
    ck.eq(pool.timeout_sec, 5, "timeout_sec explicite conservé");

    // Ambiguïtés et erreurs du pool.
    ck(/exclusifs/.test(parseErr(JSON.stringify({ "d": { providers: [ { id: "i", kind: "proxmox", token: "t@pam!x=U", url: "https://a:8006", urls: ["https://b:8006"] } ] } })) || ""),
      "url ET urls ensemble → erreur (ambigu)");
    ck(/interdit avec/.test(parseErr(JSON.stringify({ "d": { providers: [ { id: "i", kind: "proxmox", token: "t@pam!x=U", fingerprint: fpA, urls: ["https://a:8006"] } ] } })) || ""),
      "fingerprint GLOBAL avec urls → erreur (l'empreinte est par nœud)");
    ck(/NON VIDE/.test(parseErr(JSON.stringify({ "d": { providers: [ { id: "i", kind: "proxmox", token: "t@pam!x=U", urls: [] } ] } })) || ""),
      "urls vide → erreur (au moins un endpoint)");
    ck(/urls\[1\]/.test(parseErr(JSON.stringify({ "d": { providers: [ { id: "i", kind: "proxmox", token: "t@pam!x=U", urls: ["https://a:8006", { fingerprint: fpA }] } ] } })) || ""),
      "entrée de pool sans url → erreur citant la position urls[1]");
    ck(/double/.test(parseErr(JSON.stringify({ "d": { providers: [ { id: "i", kind: "proxmox", token: "t@pam!x=U", urls: ["https://a:8006", "https://a:8006"] } ] } })) || ""),
      "url en double dans le pool → erreur (faute de frappe probable)");
    ck(/urls\[0\]/.test(parseErr(JSON.stringify({ "d": { providers: [ { id: "i", kind: "proxmox", token: "t@pam!x=U", urls: [{ url: "https://a:8006", fingerprint: "AA:BB" }] } ] } })) || ""),
      "fingerprint mal formée DANS une entrée → erreur citant la position");
    // timeout_sec invalide.
    ck(/timeout_sec/.test(parseErr(JSON.stringify({ "d": { providers: [ { id: "i", kind: "proxmox", token: "t@pam!x=U", url: "https://a:8006", timeout_sec: 0 } ] } })) || ""),
      "timeout_sec 0 → erreur (entier >= 1 attendu)");
    // URLs VALIDÉES AU CHARGEMENT (citées dans l'erreur) : sans schéma ou en http → refus explicite,
    // plutôt qu'une erreur réseau cryptique à la première synchro (« contacte-t-on le bon serveur ? »).
    const noScheme = parseErr(JSON.stringify({ "d": { providers: [ { id: "i", kind: "proxmox", token: "t@pam!x=U", url: "pve1.lan:8006" } ] } }));
    ck(!!noScheme && /pve1\.lan:8006/.test(noScheme) && /https/.test(noScheme), "url sans schéma → erreur au chargement, URL fautive citée");
    ck(/https/.test(parseErr(JSON.stringify({ "d": { providers: [ { id: "i", kind: "proxmox", token: "t@pam!x=U", urls: ["http://a:8006"] } ] } })) || ""),
      "http:// refusé (pveproxy n'écoute qu'en TLS)");
  }
  });

  await section("Serveur : ProviderConfigValidate — ca_pem (CA du cluster, publique) : défaut null, PEM validé, cumul avec le pin", async () => {
  {
    const { ProviderConfigStore } = SERVER("vm/ProviderConfigStore.js");
    const parse = (json) => ProviderConfigStore.parse(json);
    const parseErr = (json) => { try { ProviderConfigStore.parse(json); return null; } catch (e) { return e.message; } };
    const caPem = "-----BEGIN CERTIFICATE-----\nMIIB...FAUX...\n-----END CERTIFICATE-----";
    const fpA = Array(32).fill("AA").join(":");

    // ABSENT → ca_pem null (défaut, validation par CA système au niveau 3).
    const absent = parse(JSON.stringify({ "d": { providers: [ { id: "i", kind: "proxmox", url: "https://a:8006", token: "t@pam!x=U" } ] } })).get("d")[0];
    ck.eq(absent.ca_pem, null, "ca_pem absent → null (défaut : CA système)");

    // PRÉSENT et VALIDE (contient le marqueur PEM) → conservé tel quel.
    const withCa = parse(JSON.stringify({ "d": { providers: [ { id: "i", kind: "proxmox", url: "https://a:8006", token: "t@pam!x=U", ca_pem: caPem } ] } })).get("d")[0];
    ck.eq(withCa.ca_pem, caPem, "ca_pem PEM valide → conservé tel quel");

    // CUMUL empreinte par endpoint + ca_pem AUTORISÉ (le pin prime par nœud, la CA sert de repli).
    const both = parse(JSON.stringify({ "d": { providers: [ { id: "i", kind: "proxmox", token: "t@pam!x=U", ca_pem: caPem,
      urls: [ { url: "https://pve1:8006", fingerprint: fpA }, "https://pve2:8006" ] } ] } })).get("d")[0];
    ck(both.ca_pem === caPem && both.endpoints[0].fingerprint === fpA, "cumul ca_pem + empreinte par endpoint AUTORISÉ (pin par nœud + CA de repli)");

    // PEM INVALIDE (chaîne sans le marqueur) → erreur citant le champ « ca_pem ».
    const badPem = parseErr(JSON.stringify({ "d": { providers: [ { id: "pcx", kind: "proxmox", url: "https://a:8006", token: "t@pam!x=U", ca_pem: "pas un certificat" } ] } }));
    ck(!!badPem && /ca_pem/.test(badPem) && /pcx/.test(badPem), "ca_pem sans marqueur PEM → erreur citant le champ + l'id du provider");
    // ca_pem mal TYPÉ (nombre) → erreur également.
    ck(/ca_pem/.test(parseErr(JSON.stringify({ "d": { providers: [ { id: "i", kind: "proxmox", url: "https://a:8006", token: "t@pam!x=U", ca_pem: 42 } ] } })) || ""),
      "ca_pem non-chaîne → erreur (certificat PEM attendu)");
  }
  });

  await section("Serveur : PveHttpPool — bascule sur défaillance de nœud (retryable, préférence collante)", async () => {
  {
    const { PveHttpPool } = SERVER("vm/PveHttpPool.js");
    const { PveHttpError } = SERVER("vm/PveHttp.js");
    // Stub de nœud : soit répond `value`, soit rejette `error` ; journalise ses appels.
    const mkNode = (name, { value, error }) => ({
      name, calls: 0,
      getJson: async function (_path) { this.calls++; if (error) throw error; return { node: name, value }; },
    });
    const down = () => new PveHttpError("Proxmox : délai dépassé (5000 ms) sur /x", true);
    const authKo = new PveHttpError("Proxmox : authentification refusée (401) — vérifiez le jeton et ses permissions", false);

    // 1) Nœud 1 en panne → bascule sur le nœud 2, résultat rendu.
    const n1 = mkNode("pve1", { error: down() }), n2 = mkNode("pve2", { value: 42 });
    const pool = new PveHttpPool([n1, n2]);
    const r = await pool.getJson("/api2/json/version");
    ck.eq(r.node, "pve2", "nœud 1 injoignable → réponse servie par le nœud 2");
    // 2) PRÉFÉRENCE COLLANTE : l'appel suivant part DIRECTEMENT du nœud 2 (le mort n'est pas repayé).
    await pool.getJson("/api2/json/version");
    ck.eq(n1.calls, 1, "le nœud mort n'est PAS retenté à chaque appel (préférence collante)");
    ck.eq(n2.calls, 2, "les appels suivants partent du dernier nœud ayant répondu");
    // 3) Erreur APPLICATIVE (auth) → rejet IMMÉDIAT, pas de bascule (échouerait partout pareil).
    const nAuth = mkNode("pve1", { error: authKo }), nJamais = mkNode("pve2", { value: 1 });
    let threw = null;
    try { await new PveHttpPool([nAuth, nJamais]).getJson("/x"); } catch (e) { threw = e; }
    ck(!!threw && /authentification/.test(threw.message), "erreur applicative (401) → rejetée telle quelle");
    ck.eq(nJamais.calls, 0, "…SANS basculer (le jeton échouerait à l'identique sur tous les nœuds)");
    // 4) TOUS les nœuds en panne → erreur agrégée citant le nombre d'essais et le dernier échec.
    let allDown = null;
    try { await new PveHttpPool([mkNode("a", { error: down() }), mkNode("b", { error: down() })]).getJson("/x"); }
    catch (e) { allDown = e.message; }
    ck(!!allDown && /aucun nœud joignable/.test(allDown) && /2 essayé/.test(allDown), "tous injoignables → erreur agrégée (2 essayés)");
    // 5) Pool vide interdit (garde constructeur).
    let emptyThrew = false;
    try { new PveHttpPool([]); } catch (_) { emptyThrew = true; }
    ck(emptyThrew, "pool vide → erreur de construction");
  }
  });

  await section("Serveur : PveHttp.explainNetworkError — messages EXPLICITES pour l'utilisateur", async () => {
  {
    const { PveHttp } = SERVER("vm/PveHttp.js");
    const target = "https://pve.exemple.com:8006/api2/json/version";
    // Erreur TLS « certificat non vérifiable » (cas réel du 2026-07-13) → explication actionnable.
    const tlsErr = Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
    const explained = PveHttp.explainNetworkError(tlsErr, target);
    ck(/épinglez l'empreinte/.test(explained.message), "certificat non vérifiable → explication en français (épingler l'empreinte)");
    ck(explained.message.includes("unable to verify") && explained.message.includes(target), "…message technique d'origine ET cible conservés");
    ck(explained.retryable === true && (explained.cause === tlsErr), "…retryable (bascule possible) + cause transportée");
    // Connexion refusée → explication.
    const refused = PveHttp.explainNetworkError(Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:8006"), { code: "ECONNREFUSED" }), target);
    ck(/pveproxy|port 8006/.test(refused.message), "ECONNREFUSED → explication (pveproxy/port)");
    // Code inconnu → message technique conservé tel quel (pas d'invention), cible citée.
    const unknown = PveHttp.explainNetworkError(Object.assign(new Error("boom exotique"), { code: "EEXOTIQUE" }), target);
    ck(unknown.message.includes("boom exotique") && unknown.message.includes(target), "code inconnu → message brut + cible (pas d'explication inventée)");
  }
  });

  await section("Serveur : PveHttp.trustOptions — hiérarchie de confiance TLS (épinglage > CA cluster > CA système)", async () => {
  {
    const { PveHttp } = SERVER("vm/PveHttp.js");
    const fp = Array(32).fill("AB").join(":"); // empreinte SHA-256 valide (64 hex)
    const caPem = "-----BEGIN CERTIFICATE-----\nMIIB...FAKE-CA...\n-----END CERTIFICATE-----";

    // 1) ÉPINGLAGE SEUL : rejectUnauthorized=false (certificat auto-signé), checkServerIdentity posé,
    //    AUCUNE clé `ca`. La fonction impose l'empreinte exacte et rejette une empreinte inattendue.
    const pin = PveHttp.trustOptions(fp, null);
    ck.eq(pin.rejectUnauthorized, false, "pin seul : rejectUnauthorized=false (chaîne CA non exigée, épinglage plus strict)");
    ck(typeof pin.checkServerIdentity === "function", "pin seul : checkServerIdentity posé (impose l'empreinte)");
    ck(!("ca" in pin), "pin seul : pas de clé « ca »");
    // L'empreinte présentée doit correspondre (normalisation hex, séparateurs ignorés).
    ck.eq(pin.checkServerIdentity("h", { fingerprint256: fp }), undefined, "pin : empreinte conforme → acceptée");
    const bad = pin.checkServerIdentity("h", { fingerprint256: Array(32).fill("CD").join(":") });
    ck(bad instanceof Error && /épinglage refusé/.test(bad.message), "pin : empreinte inattendue → Error (épinglage refusé)");

    // 2) CA CLUSTER SEULE : rejectUnauthorized=true + option `ca`, PAS de checkServerIdentity
    //    (le contrôle de nom d'hôte par défaut de Node s'applique — CN/SAN du certificat du nœud).
    const ca = PveHttp.trustOptions(null, caPem);
    ck.eq(ca.rejectUnauthorized, true, "ca seule : rejectUnauthorized=true (chaîne validée contre la CA)");
    ck.eq(ca.ca, caPem, "ca seule : la CA fournie est passée à l'option « ca »");
    ck(!("checkServerIdentity" in ca), "ca seule : PAS de checkServerIdentity posé (clé absente, pas undefined — évite ERR_INTERNAL_ASSERTION)");

    // 3) PIN + CA : l'ÉPINGLAGE PRIME (le plus spécifique par nœud) — se comporte comme le pin seul.
    const both = PveHttp.trustOptions(fp, caPem);
    ck.eq(both.rejectUnauthorized, false, "pin+ca : l'empreinte prime → rejectUnauthorized=false (comme pin seul)");
    ck(typeof both.checkServerIdentity === "function" && !("ca" in both), "pin+ca : checkServerIdentity posé, la CA IGNORÉE (le pin est prioritaire)");

    // 4) NI PIN NI CA : validation par les CA système (comportement historique).
    const sys = PveHttp.trustOptions(null, null);
    ck.eq(sys.rejectUnauthorized, true, "ni pin ni ca : rejectUnauthorized=true (CA système)");
    ck(!("ca" in sys) && !("checkServerIdentity" in sys), "ni pin ni ca : ni « ca » ni checkServerIdentity (validation TLS standard)");
  }
  });

  await section("Serveur : ProviderConfigStore — enveloppe fichier (providersFor, dormance, fichier invalide)", async () => {
  {
    const { ProviderConfigStore } = SERVER("vm/ProviderConfigStore.js");
    const fs = require("fs"), os = require("os");
    const valid = JSON.stringify({
      "doc-A": { providers: [
        { id: "pve-1", kind: "proxmox", url: "https://a:8006", token: "root@pam!t=U1" },
        { id: "pve-2", kind: "proxmox", url: "https://b:8006", token: "root@pam!t=U2" },
      ] },
      "doc-B": { providers: [ { id: "pve-3", kind: "proxmox", url: "https://c:8006", token: "root@pam!t=U3" } ] },
    });
    // Fichier PRÉSENT et valide : providersFor + configuredDocIds.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-vmcfg-"));
    fs.writeFileSync(path.join(dir, "vm-providers.json"), valid, "utf8");
    const store = new ProviderConfigStore(dir); // Logger "error" par défaut → silencieux
    ck.eq(store.providersFor("doc-A").length, 2, "providersFor(doc-A) → 2 providers");
    ck.eq(store.providersFor("doc-ABSENT").length, 0, "providersFor(docId absent du fichier) → [] (dormant pour ce document)");
    ck.eq(store.configuredDocIds().sort().join(","), "doc-A,doc-B", "configuredDocIds → documents configurés (utile au timer T2.2)");
    // Copie DÉFENSIVE : muter le tableau renvoyé ne corrompt pas l'état interne.
    store.providersFor("doc-A").push({ id: "intrus" });
    ck.eq(store.providersFor("doc-A").length, 2, "providersFor renvoie une COPIE (mutation externe sans effet)");
    // Fichier ABSENT → feature dormante GLOBALE, PAS une erreur.
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-vmcfg-empty-"));
    const dormant = new ProviderConfigStore(emptyDir);
    ck.eq(dormant.configuredDocIds().length, 0, "fichier absent → aucune config (dormant global), pas d'erreur");
    ck.eq(dormant.providersFor("doc-A").length, 0, "fichier absent → providersFor → []");
    // Fichier PRÉSENT mais invalide → erreur explicite (pas de silence trompeur).
    const badDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-vmcfg-bad-"));
    fs.writeFileSync(path.join(badDir, "vm-providers.json"), "{ pas du json", "utf8");
    let threwLoad = false;
    try { new ProviderConfigStore(badDir); } catch (_) { threwLoad = true; }
    ck(threwLoad, "fichier présent mais invalide → lève (feature NON silencieusement dormante)");
    try { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(emptyDir, { recursive: true, force: true }); fs.rmSync(badDir, { recursive: true, force: true }); } catch (_) { /* dossiers temp */ }
  }
  });

  /* ============ SERVEUR : ProviderConfigValidate (validation PAR PROVIDER, partagée fichier ↔ CRUD DB) ============ */

  await section("Serveur : ProviderConfigValidate — validation par provider (défauts, requis, pool) + mêmes messages que le parseur fichier", async () => {
  {
    const { ProviderConfigValidate, ProviderConfigError } = SERVER("vm/ProviderConfigValidate.js");
    const { ProviderConfigStore } = SERVER("vm/ProviderConfigStore.js");
    const validate = (raw) => { const errors = []; const cfg = ProviderConfigValidate.parseProvider("doc-X", 0, raw, errors); return { cfg, errors }; };

    // 1) Provider valide → ProviderConfig avec DÉFAUTS appliqués.
    const ok = validate({ id: "p1", kind: "proxmox", url: "https://pve1:8006", token: "root@pam!t=U" });
    ck(!!ok.cfg && ok.errors.length === 0, "provider valide → config produite (aucune erreur)");
    ck.eq(ok.cfg.include_lxc, true, "défaut include_lxc = true");
    ck.eq(ok.cfg.interval_sec, 0, "défaut interval_sec = 0");
    ck.eq(ok.cfg.timeout_sec, 15, "défaut timeout_sec = 15");
    ck(ok.cfg.endpoints.length === 1 && ok.cfg.endpoints[0].fingerprint === null, "raccourci url → 1 endpoint, fingerprint null par défaut");

    // 2) Champs requis → erreurs citant l'id + le champ ; token JAMAIS divulgué.
    const secret = "SUPER-SECRET=deadbeef-cafe";
    const noUrl = validate({ id: "p1", kind: "proxmox", token: secret });
    ck(noUrl.cfg === null && noUrl.errors.some((m) => /p1/.test(m) && /url/.test(m)), "url manquante → erreur citant id + champ");
    ck(!noUrl.errors.join("\n").includes(secret), "token JAMAIS présent dans les messages d'erreur");
    ck(validate({ id: "p1", kind: "proxmox", url: "https://a:8006" }).errors.some((m) => /token/.test(m)), "token manquant → « token requis »");
    ck(validate({ id: "p1", url: "https://a:8006", token: "t@pam!x=U" }).errors.some((m) => /kind/.test(m)), "kind manquant → erreur");
    ck(validate({ kind: "proxmox", url: "https://a:8006", token: "t@pam!x=U" }).errors.some((m) => /id/.test(m)), "id manquant → erreur");

    // 3) Types des optionnels.
    ck(validate({ id: "p", kind: "proxmox", url: "https://a:8006", token: "t@x!y=U", include_lxc: "oui" }).errors.some((m) => /include_lxc/.test(m)), "include_lxc non booléen → erreur");
    ck(validate({ id: "p", kind: "proxmox", url: "https://a:8006", token: "t@x!y=U", interval_sec: -1 }).errors.some((m) => /interval_sec/.test(m)), "interval_sec négatif → erreur");
    ck(validate({ id: "p", kind: "proxmox", url: "https://a:8006", token: "t@x!y=U", timeout_sec: 0 }).errors.some((m) => /timeout_sec/.test(m)), "timeout_sec 0 → erreur");

    // 4) POOL d'urls : empreinte PAR nœud + raccourci chaîne, ambiguïtés.
    const fpA = Array(32).fill("AA").join(":");
    const pool = validate({ id: "p", kind: "proxmox", token: "t@x!y=U", urls: [{ url: "https://a:8006", fingerprint: fpA }, "https://b:8006"] });
    ck(pool.cfg && pool.cfg.endpoints.length === 2 && pool.cfg.endpoints[0].fingerprint === fpA && pool.cfg.endpoints[1].fingerprint === null, "pool : empreinte par nœud + raccourci chaîne sans épinglage");
    ck(validate({ id: "p", kind: "proxmox", token: "t@x!y=U", url: "https://a:8006", urls: ["https://b:8006"] }).errors.some((m) => /exclusifs/.test(m)), "url ET urls ensemble → « exclusifs »");
    ck(validate({ id: "p", kind: "proxmox", token: "t@x!y=U", url: "pve1.lan:8006" }).errors.some((m) => /https/.test(m)), "url sans schéma https → erreur");

    // 5) MÊMES MESSAGES : le message par provider produit par parse() (parseur fichier) CONTIENT
    //    exactement celui de parseProvider (délégation prouvée : une seule source de vérité).
    const viaValidate = validate({ id: "p1", kind: "proxmox", token: "t@x!y=U" }).errors[0]; // url manquante
    let viaFile = "";
    try { ProviderConfigStore.parse(JSON.stringify({ "doc-X": { providers: [{ id: "p1", kind: "proxmox", token: "t@x!y=U" }] } })); }
    catch (e) { viaFile = e.message; }
    ck(!!viaValidate && viaFile.includes(viaValidate), "message par provider IDENTIQUE via parse() (fichier legacy) et parseProvider (CRUD DB)");

    // 6) ProviderConfigError : porte les issues (rendues en 400 par les routes CRUD).
    const err = new ProviderConfigError(["souci A", "souci B"]);
    ck(Array.isArray(err.issues) && err.issues.length === 2 && /souci A/.test(err.message) && err.name === "ProviderConfigError", "ProviderConfigError porte les issues + message agrégé");

    // 7) management_url (URL du PDM, PUBLIQUE) : optionnel (défaut null), http ACCEPTÉ (PDM interne),
    //    https accepté, invalide REFUSÉ (message citant le champ, jamais le jeton).
    const base = { id: "p", kind: "proxmox", url: "https://a:8006", token: "t@x!y=U" };
    ck.eq(validate({ ...base }).cfg.management_url, null, "management_url absent → null (défaut)");
    ck.eq(validate({ ...base, management_url: "" }).cfg.management_url, null, "management_url vide → null (champ vidé côté UI)");
    ck.eq(validate({ ...base, management_url: "http://pdm.exemple.lan:8443" }).cfg.management_url, "http://pdm.exemple.lan:8443", "management_url http ACCEPTÉ (PDM en http interne)");
    ck.eq(validate({ ...base, management_url: "https://pdm.exemple.com" }).cfg.management_url, "https://pdm.exemple.com", "management_url https accepté");
    const badMgmt = validate({ ...base, management_url: "pas-une-url" });
    ck(badMgmt.cfg === null && badMgmt.errors.some((m) => /management_url/.test(m)), "management_url invalide (sans schéma) → erreur citant le champ");
    ck(validate({ ...base, management_url: "ftp://pdm:21" }).errors.some((m) => /management_url/.test(m)), "management_url ftp (protocole non http(s)) → erreur");
    ck(validate({ ...base, management_url: 42 }).errors.some((m) => /management_url/.test(m)), "management_url mal typé (nombre) → erreur");
  }
  });

  /* ============ SERVEUR : ProxmoxAdapter (orchestration, client HTTP stub) ============ */

  // Stub PveJsonClient : table route → fixture (une Error en valeur = rejet), journal des chemins
  // appelés — permet d'asserter l'ORCHESTRATION (quels appels, pour quelles VMs) sans réseau.
  const mkPveStub = (routes) => {
    const calls = [];
    return {
      calls,
      getJson: async (path) => {
        calls.push(path);
        if (path in routes) {
          const v = routes[path];
          if (v instanceof Error) throw v;
          return v;
        }
        throw new Error("Proxmox : HTTP 404 sur " + path);
      },
    };
  };
  const PVE_CFG = { id: "pve-prod", kind: "proxmox", endpoints: [{ url: "https://pve.example.lan:8006", fingerprint: null }], token: "sync@pve!inv=SECRET-UUID", include_lxc: true, interval_sec: 0, timeout_sec: 15 };

  await section("Serveur : ProxmoxAdapter.test — /version (gamme 8–9, avertissement, échec sans jeton)", async () => {
  {
    const { ProxmoxAdapter } = SERVER("vm/ProxmoxAdapter.js");
    // 1) Version dans la gamme → ok + supported.
    const okStub = mkPveStub({ "/api2/json/version": { data: { version: "8.4.1", release: "8.4", repoid: "abc" } } });
    const ok = await new ProxmoxAdapter(PVE_CFG, okStub).test();
    ck(ok.ok === true && ok.version === "8.4.1" && ok.supported === true, "PVE 8.4.1 → ok, version remontée, gamme supportée");
    ck(ok.kind === "proxmox", "ProviderInfo.kind = proxmox");
    // 2) Hors gamme (7.x, 10.x) → ok mais WARNING, jamais un blocage (cadrage : tolérance).
    const oldPve = await new ProxmoxAdapter(PVE_CFG, mkPveStub({ "/api2/json/version": { data: { version: "7.4-3" } } })).test();
    ck(oldPve.ok === true && oldPve.supported === false && /HORS gamme/.test(oldPve.message), "PVE 7.x → ok:true mais supported:false + avertissement");
    const nextPve = await new ProxmoxAdapter(PVE_CFG, mkPveStub({ "/api2/json/version": { data: { version: "10.0.1" } } })).test();
    ck(nextPve.ok === true && nextPve.supported === false, "PVE 10.x (future release) → ok:true, supported:false");
    // 3) Version illisible → accès ok, compatibilité non vérifiée (prudence sans blocage).
    const noVer = await new ProxmoxAdapter(PVE_CFG, mkPveStub({ "/api2/json/version": { data: {} } })).test();
    ck(noVer.ok === true && noVer.version === null && noVer.supported === false, "réponse sans version → ok:true, version:null, supported:false");
    // 4) Échec d'accès → ok:false + message (le stub imite PveHttp : message SANS le jeton).
    const authErr = new Error("Proxmox : authentification refusée (401) — vérifiez le jeton et ses permissions");
    const ko = await new ProxmoxAdapter(PVE_CFG, mkPveStub({ "/api2/json/version": authErr })).test();
    ck(ko.ok === false && ko.version === null && /401/.test(ko.message), "échec HTTP → ok:false, message d'erreur remonté");
    ck(!ko.message.includes("SECRET-UUID"), "le message de test() ne contient jamais le jeton");
    // 5) test() ne jette JAMAIS (contrat) — déjà couvert par le cas 4 (rejet du stub → ok:false).
  }
  });

  await section("Serveur : ProxmoxAdapter.inventory — orchestration (VMs + nœuds en 1 réponse, configs, agent, filtres)", async () => {
  {
    const { ProxmoxAdapter } = SERVER("vm/ProxmoxAdapter.js");
    // /cluster/resources est appelé SANS le filtre ?type=vm : la MÊME réponse porte les entrées
    // `type:"node"` (métriques) ET les VMs — les entrées sans vmid (nœuds, stockages) sont ignorées
    // par le parseur VM. Un seul passage réseau produit l'inventaire ET l'état du cluster.
    const routes = {
      "/api2/json/version": { data: { version: "8.4.1", release: "8.4", repoid: "abc" } },
      "/api2/json/cluster/status": { data: [
        { type: "cluster", name: "prod-cluster", nodes: 2, quorate: 1 },
        { type: "node", name: "pve1", online: 1 }, { type: "node", name: "pve2", online: 1 },
      ] },
      "/api2/json/cluster/resources": { data: [
        { type: "node", id: "node/pve1", node: "pve1", status: "online", cpu: 0.05, maxcpu: 8, mem: 4294967296, maxmem: 17179869184, uptime: 864000 },
        { type: "node", id: "node/pve2", node: "pve2", status: "offline", cpu: null, maxcpu: 4, mem: 0, maxmem: 8589934592, uptime: 0 },
        { type: "storage", id: "storage/pve1/local", node: "pve1", status: "available", maxdisk: 500000000000 }, // sans vmid → ni VM ni nœud
        { vmid: 100, type: "qemu", name: "web01", node: "pve1", status: "running", maxcpu: 4, maxmem: 4294967296, maxdisk: 34359738368, tags: "prod;web" },
        { vmid: 101, type: "lxc", name: "db01", node: "pve2", status: "stopped", maxcpu: 2, maxmem: 2147483648 },
        { vmid: 102, type: "qemu", name: "tpl-debian", node: "pve1", template: 1 }, // template → exclu
        { vmid: 103, type: "qemu", name: "old01", node: "pve1", status: "stopped", maxcpu: 1 },
      ] },
      "/api2/json/nodes/pve1/qemu/100/config": { data: { description: "Serveur web", cores: 2, sockets: 2, memory: 4096, net0: "virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=42" } },
      "/api2/json/nodes/pve2/lxc/101/config": { data: { cores: 2, memory: 2048, net0: "name=eth0,bridge=vmbr1,hwaddr=BC:24:11:00:11:22,ip=10.0.0.5/24,gw=10.0.0.1" } },
      "/api2/json/nodes/pve1/qemu/100/agent/network-get-interfaces": { data: { result: [
        { name: "eth0", "hardware-address": "aa:bb:cc:dd:ee:ff", "ip-addresses": [
          { "ip-address-type": "ipv4", "ip-address": "192.168.42.10", prefix: 24 },
          { "ip-address-type": "ipv6", "ip-address": "fe80::1", prefix: 64 }, // link-local → filtrée
        ] },
      ] } },
      // vm 103 : config ABSENTE de la table → rejet du stub (VM disparue entre les 2 appels).
    };
    const stub = mkPveStub(routes);
    const inv = await new ProxmoxAdapter(PVE_CFG, stub).inventory();
    const vms = inv.vms;
    // Inventaire : template exclu, ext_id préfixé du nom de cluster, provider_id estampillé.
    ck.eq(vms.length, 3, "3 VMs inventoriées (template exclu, entrées node/storage ignorées)");
    ck(vms.every((v) => v.provider_id === "pve-prod"), "provider_id estampillé sur TOUS les records (id de l'instance)");
    const web = vms.find((v) => v.name === "web01");
    ck.eq(web.ext_id, "prod-cluster/100", "ext_id = nomDuCluster/vmid (clé de réconciliation)");
    // Enrichissement config : cpu cores×sockets, nics, puis agent (IP réelle, link-local filtrée).
    ck.eq(web.cpu, 4, "config fusionnée : cpu = cores(2) × sockets(2)");
    ck.eq(web.nics.length, 1, "vNIC net0 décodée");
    ck.eq(web.nics[0].ips.join(","), "192.168.42.10", "agent fusionné : IP réelle présente, link-local fe80:: filtrée");
    const db = vms.find((v) => v.name === "db01");
    ck.eq(db.nics[0].ips.join(","), "10.0.0.5", "LXC : IP statique extraite de la config (pas d'agent)");
    // Tolérance : config de la vm 103 en échec → SQUELETTE conservé, pas de throw global.
    const old = vms.find((v) => v.name === "old01");
    ck(!!old && old.cpu === 1 && old.nics.length === 0, "config d'UNE VM en échec → squelette conservé (inventaire non bloqué)");
    // Orchestration : agent appelé UNIQUEMENT pour les QEMU allumées (ni lxc, ni stopped).
    const agentCalls = stub.calls.filter((p) => p.includes("/agent/"));
    ck.eq(agentCalls.length, 1, "guest-agent appelé UNIQUEMENT pour la QEMU running (ni LXC, ni stopped)");
    ck(agentCalls[0].includes("/qemu/100/"), "l'appel agent vise la vm 100");

    // ÉTAT DU CLUSTER produit dans la MÊME passe : nom, version + gamme, quorum, nœuds/métriques.
    ck.eq(inv.cluster.name, "prod-cluster", "cluster.name résolu depuis /cluster/status");
    ck(inv.cluster.version === "8.4.1" && inv.cluster.supported === true, "cluster.version + supported depuis /version (gamme 8–9)");
    ck.eq(inv.cluster.quorate, true, "cluster.quorate depuis l'entrée cluster (quorate 1 → true)");
    ck.eq(inv.cluster.nodes.length, 2, "2 nœuds extraits de la MÊME réponse /cluster/resources (VMs et nœuds, un seul appel)");
    const n1 = inv.cluster.nodes.find((n) => n.name === "pve1");
    ck(n1.online === true && n1.cpu_used === 0.05 && n1.cpu_total === 8, "nœud en ligne : cpu fraction 0..1 + maxcpu");
    ck(n1.mem_used_mb === 4096 && n1.mem_total_mb === 16384 && n1.uptime_sec === 864000, "nœud : mem octets → Mo (4Gi→4096, 16Gi→16384) + uptime");
    const n2 = inv.cluster.nodes.find((n) => n.name === "pve2");
    ck(n2.online === false && n2.cpu_used === null, "nœud hors ligne : online false, cpu null (non remonté)");

    // Un SEUL appel /cluster/resources, SANS filtre : VMs et nœuds sortent de cette unique réponse.
    const resourceCalls = stub.calls.filter((p) => p.startsWith("/api2/json/cluster/resources"));
    ck.eq(resourceCalls.length, 1, "/cluster/resources appelé UNE seule fois");
    ck(resourceCalls[0] === "/api2/json/cluster/resources", "…SANS le filtre ?type=vm (la réponse porte VMs + nœuds)");

    // include_lxc:false → LXC filtrés AVANT les appels de détail (aucun appel réseau pour eux).
    const stub2 = mkPveStub(routes);
    const noLxc = await new ProxmoxAdapter({ ...PVE_CFG, include_lxc: false }, stub2).inventory();
    ck.eq(noLxc.vms.length, 2, "include_lxc:false → LXC écartés de l'inventaire");
    ck.eq(noLxc.cluster.nodes.length, 2, "include_lxc n'affecte PAS les nœuds du cluster");
    ck(!stub2.calls.some((p) => p.includes("/lxc/")), "include_lxc:false → AUCUN appel de détail LXC (filtre avant orchestration)");

    // Échec de l'inventaire de MASSE → inventory rejette (contrat : l'appelant conserve l'état précédent).
    let threw = false;
    try { await new ProxmoxAdapter(PVE_CFG, mkPveStub({ "/api2/json/cluster/status": { data: [] } })).inventory(); }
    catch (_) { threw = true; }
    ck(threw, "échec de /cluster/resources → inventory rejette (jamais un inventaire vide trompeur)");
  }
  });

  await section("Serveur : ProxmoxAdapter.inventory — nom/quorum de cluster (nœud isolé, statut indisponible, version en échec), fromConfig", async () => {
  {
    const { ProxmoxAdapter } = SERVER("vm/ProxmoxAdapter.js");
    const resources = { data: [ { vmid: 200, type: "qemu", name: "solo01", node: "pve-solo", status: "stopped" } ] };
    // Nœud ISOLÉ (pas d'entrée cluster) → le nom du nœud unique sert d'identité stable ; quorate
    // inconnu (null, pas false). PAS de route /version → clusterVersion TOLÈRE l'échec : version
    // null, supported false, et l'inventaire des VMs CONTINUE (la version est informative).
    const solo = await new ProxmoxAdapter(PVE_CFG, mkPveStub({
      "/api2/json/cluster/status": { data: [ { type: "node", name: "pve-solo", online: 1 } ] },
      "/api2/json/cluster/resources": resources,
    })).inventory();
    ck.eq(solo.vms[0].ext_id, "pve-solo/200", "nœud isolé sans cluster → ext_id préfixé du nom du nœud");
    ck.eq(solo.cluster.name, "pve-solo", "…et cluster.name = nom du nœud isolé");
    ck.eq(solo.cluster.quorate, null, "nœud isolé (pas d'entrée cluster) → quorate inconnu (null, jamais false)");
    ck(solo.cluster.version === null && solo.cluster.supported === false, "/version indisponible → version null + supported false (TOLÉRANT)");
    ck.eq(solo.vms.length, 1, "…l'inventaire des VMs CONTINUE malgré la version manquante (informative)");
    // /cluster/status en échec (droits restreints) → repli sur l'id de l'instance, quorate null,
    // l'inventaire continue ; /version reste lue (indépendante du statut cluster).
    const fallback = await new ProxmoxAdapter(PVE_CFG, mkPveStub({
      "/api2/json/version": { data: { version: "9.0.0" } },
      "/api2/json/cluster/status": new Error("Proxmox : HTTP 403 sur /api2/json/cluster/status"),
      "/api2/json/cluster/resources": resources,
    })).inventory();
    ck.eq(fallback.vms[0].ext_id, "pve-prod/200", "statut cluster inaccessible → repli ext_id = idInstance/vmid (inventaire non bloqué)");
    ck.eq(fallback.cluster.name, "pve-prod", "…cluster.name = id d'instance (repli neutre)");
    ck.eq(fallback.cluster.quorate, null, "…quorate null (statut cluster indisponible)");
    ck(fallback.cluster.version === "9.0.0" && fallback.cluster.supported === true, "version 9.0.0 dans la gamme, indépendante du statut cluster");
    // fromConfig : construction standard (PveHttp réel, aucun appel réseau à la construction).
    const real = ProxmoxAdapter.fromConfig(PVE_CFG);
    ck(real.kind === "proxmox" && real.config === PVE_CFG, "fromConfig → adaptateur câblé sur la config (client HTTPS réel)");
  }
  });

  await section("Serveur : ProxmoxAdapter.inventory — URLs de management (lien par nœud généré, bouton cluster recopié de la config)", async () => {
  {
    const { ProxmoxAdapter } = SERVER("vm/ProxmoxAdapter.js");
    // Pool de 2 endpoints (l'ORDRE = priorité) : la base du PREMIER endpoint doit servir à TOUS les
    // liens de nœud (l'UI Proxmox est cluster-wide). Un nom de nœud avec un espace prouve l'encodage.
    const cfg = {
      id: "pve-prod", kind: "proxmox",
      endpoints: [{ url: "https://pve1.exemple.lan:8006", fingerprint: null }, { url: "https://pve2.exemple.lan:8006", fingerprint: null }],
      token: "sync@pve!inv=SECRET-UUID", include_lxc: true, interval_sec: 0, timeout_sec: 15,
      ca_pem: null, management_url: "http://pdm.exemple.lan:8443",
    };
    const routes = {
      "/api2/json/version": { data: { version: "8.4.1" } },
      "/api2/json/cluster/status": { data: [ { type: "cluster", name: "prod-cluster", quorate: 1 }, { type: "node", name: "pve one", online: 1 } ] },
      "/api2/json/cluster/resources": { data: [
        { type: "node", id: "node/pve one", node: "pve one", status: "online", cpu: 0.05, maxcpu: 8, mem: 4294967296, maxmem: 17179869184, uptime: 3600 },
        { type: "node", id: "node/pve2", node: "pve2", status: "online", cpu: 0.02, maxcpu: 4, mem: 0, maxmem: 8589934592, uptime: 60 },
      ] },
    };
    const inv = await new ProxmoxAdapter(cfg, mkPveStub(routes)).inventory();
    const n1 = inv.cluster.nodes.find((n) => n.name === "pve one");
    const n2 = inv.cluster.nodes.find((n) => n.name === "pve2");
    // Lien PROFOND standard de l'UI Proxmox : ORIGINE du 1er endpoint + « /#v1:0:=node/ » + nom ENCODÉ.
    ck.eq(n1.management_url, "https://pve1.exemple.lan:8006/#v1:0:=node/pve%20one", "nœud : URL = origine du 1er endpoint + lien profond, nom encodé (espace → %20)");
    ck.eq(n2.management_url, "https://pve1.exemple.lan:8006/#v1:0:=node/pve2", "TOUS les nœuds pointent sur la base du PREMIER endpoint du pool (UI cluster-wide)");
    // Bouton cluster = RECOPIE de config.management_url (l'URL du PDM, non déductible de l'API ; http accepté).
    ck.eq(inv.cluster.management_url, "http://pdm.exemple.lan:8443", "cluster.management_url = config.management_url (recopié tel quel)");
    // Config SANS management_url → cluster.management_url null (aucun bouton), liens de nœud toujours générés.
    const inv2 = await new ProxmoxAdapter({ ...cfg, management_url: null }, mkPveStub(routes)).inventory();
    ck.eq(inv2.cluster.management_url, null, "config sans management_url → cluster.management_url null (pas de bouton)");
    ck(inv2.cluster.nodes[0].management_url.startsWith("https://pve1.exemple.lan:8006/#v1:0:=node/"), "…les liens PAR nœud restent générés (indépendants du bouton cluster)");
  }
  });

  /* ============ SERVEUR : VmReconcile (réconciliation pure, frontière source/locaux) ============ */

  // Fabrique un VmRecord pivot complet (les tests ne varient que ce qui les concerne).
  const mkVmRecord = (over = {}) => ({
    ext_id: "prod/100", provider_id: "pve-prod", vm_type: "qemu", name: "web01",
    description: "Serveur web", status: "running", host_node: "pve1",
    cpu: 4, ram_mb: 4096, disk_gb: 32, tags: ["prod", "web"],
    nics: [{ name: "net0", mac: "AA:BB:CC:DD:EE:FF", bridge: "vmbr0", vlan_tag: 42, ips: ["192.168.1.10"] }],
    ...over,
  });
  // Entrées communes : résolution d'hôte et générateur d'id INJECTÉS (déterministes), horloge fixe.
  const mkInput = (records, existingVms, over = {}) => {
    let n = 0;
    return {
      providerId: "pve-prod", records, existingVms,
      resolveHostEquipmentId: (node) => (node === "pve1" ? "eq-pve1" : null),
      newId: () => "vm-id-" + (++n),
      nowIso: "2026-07-13T12:00:00.000Z",
      ...over,
    };
  };

  await section("Serveur : VmReconcile — frontière source/locaux (invariant partagé) + création", async () => {
  {
    const { VmReconcile } = SERVER("vm/VmReconcile.js");
    const { VM_SOURCE_FIELDS } = SHARED("src-shared/VmSync.js");
    const { Vm } = D("models/Vm.js");
    // INVARIANT : la liste partagée des champs source correspond au modèle client — chaque
    // champ source existe sur `new Vm()`, et les champs LOCAUX n'y figurent pas.
    const vmFields = Object.keys(new Vm({}));
    ck(VM_SOURCE_FIELDS.every((f) => vmFields.includes(f)), "VM_SOURCE_FIELDS ⊆ champs du modèle Vm (liste partagée en phase)");
    const locals = ["notes", "host_equipment_id", "group_id", "group_ids", "description"];
    ck(locals.every((f) => vmFields.includes(f) && !VM_SOURCE_FIELDS.includes(f)), "les champs LOCAUX (notes, hôte, groupes, description) sont HORS liste source");

    // CRÉATION : vm inconnue du document → enregistrement complet (source + locaux par défaut).
    const ops = VmReconcile.plan(mkInput([mkVmRecord()], []));
    ck.eq(ops.creates.length, 1, "vm inconnue → 1 création");
    ck.eq(ops.updates.length + ops.orphans.length, 0, "création : aucune autre op");
    const created = ops.creates[0];
    ck.eq(created.id, "vm-id-1", "id issu du générateur injecté");
    ck.eq(created.ext_id, "prod/100", "ext_id repris du pivot");
    ck.eq(created.description_src, "Serveur web", "mappage pivot description → doc description_src");
    ck.eq(created.tags_src.join(","), "prod,web", "mappage pivot tags → doc tags_src");
    ck.eq(created.description, "", "description (LOCALE, héritée d'Entity) vierge — réservée à l'utilisateur");
    ck.eq(created.host_equipment_id, "eq-pve1", "hôte auto-résolu par NOM de nœud à la création");
    ck(created.orphan === false && created.last_sync === "2026-07-13T12:00:00.000Z", "création : orphan false + last_sync posé");
    ck(created.notes === "" && created.group_id === null && created.group_ids.length === 0, "locaux par défaut (notes, groupes)");
    // Nœud non résolu → hôte null (jamais d'invention).
    const noHost = VmReconcile.plan(mkInput([mkVmRecord({ ext_id: "prod/101", host_node: "pve9" })], []));
    ck.eq(noHost.creates[0].host_equipment_id, null, "nœud inconnu des équipements → host_equipment_id null");
  }
  });

  await section("Serveur : VmReconcile — patch minimal, idempotence, locaux préservés", async () => {
  {
    const { VmReconcile } = SERVER("vm/VmReconcile.js");
    // Document à jour = le résultat d'une création précédente + enrichissements UTILISATEUR.
    // (host_equipment_id = eq-pve1 : la valeur DÉRIVÉE — le champ n'est plus éditable.)
    const base = VmReconcile.plan(mkInput([mkVmRecord()], [])).creates[0];
    const enriched = { ...base, notes: "précieuse note", group_id: "g1", group_ids: ["g1"] };

    // IDEMPOTENCE : même inventaire → AUCUNE op (pas de bruit rev/SSE), même last_sync ancien.
    const idem = VmReconcile.plan(mkInput([mkVmRecord()], [{ ...enriched, last_sync: "2020-01-01T00:00:00.000Z" }]));
    ck.eq(idem.creates.length + idem.updates.length + idem.orphans.length, 0, "inventaire inchangé → ZÉRO op (last_sync seul ne justifie jamais une écriture)");
    ck.eq(idem.unchanged, 1, "…comptée « unchanged » (observabilité du statut)");

    // PATCH MINIMAL : seul le statut change → patch = { status, last_sync }, rien d'autre.
    const upd = VmReconcile.plan(mkInput([mkVmRecord({ status: "stopped" })], [enriched]));
    ck.eq(upd.updates.length, 1, "changement de statut → 1 mise à jour");
    ck.eq(Object.keys(upd.updates[0].patch).sort().join(","), "last_sync,status", "patch MINIMAL : uniquement le champ modifié + last_sync");
    ck.eq(upd.updates[0].id, enriched.id, "patch ciblé sur l'id existant");
    ck(!("notes" in upd.updates[0].patch) && !("group_ids" in upd.updates[0].patch), "notes/groupes : hors patch (frontière source/locaux)");

    // HÔTE DÉRIVÉ (décision 2026-07-13 : la synchro est la SOURCE DE VÉRITÉ — plus d'édition) :
    // re-résolu à CHAQUE passe. Valeur divergente → réalignée ; null → remplie ; nœud
    // inconnu → null (pas de valeur inventée) ; résolution identique → aucune op (idempotence).
    const realign = VmReconcile.plan(mkInput([mkVmRecord()], [{ ...enriched, host_equipment_id: "eq-obsolete" }]));
    ck.eq(realign.updates.length, 1, "hôte divergent → réaligné par la synchro (source de vérité)");
    ck.eq(Object.keys(realign.updates[0].patch).sort().join(","), "host_equipment_id,last_sync", "…patch = host_equipment_id + last_sync uniquement");
    ck.eq(realign.updates[0].patch.host_equipment_id, "eq-pve1", "…sur la valeur résolue du nœud");
    const fill = VmReconcile.plan(mkInput([mkVmRecord()], [{ ...enriched, host_equipment_id: null }]));
    ck.eq(fill.updates.length, 1, "hôte null + nœud résoluble → rempli");
    ck.eq(fill.updates[0].patch.host_equipment_id, "eq-pve1", "…par correspondance de nom");
    const gone = VmReconcile.plan(mkInput([mkVmRecord({ host_node: "pve9" })], [{ ...enriched, host_node: "pve9" }]));
    ck(gone.updates.length === 1 && gone.updates[0].patch.host_equipment_id === null, "nœud sans équipement homonyme → hôte remis à null (rien d'inventé)");

    // NICS : un changement DANS la structure embarquée est détecté (vlan 42 → 43).
    const nicChange = mkVmRecord(); nicChange.nics = [{ ...nicChange.nics[0], vlan_tag: 43 }];
    const nicOps = VmReconcile.plan(mkInput([nicChange], [enriched]));
    ck(nicOps.updates.length === 1 && "nics" in nicOps.updates[0].patch, "vlan modifié dans une vNIC → patch.nics (comparaison profonde)");

    // Tolérance : champ source ABSENT du doc (vieil enregistrement) comparé à son défaut → pas de faux delta.
    const legacy = { ...enriched }; delete legacy.tags_src;
    const legacyOps = VmReconcile.plan(mkInput([mkVmRecord({ tags: [] })], [legacy]));
    ck.eq(legacyOps.updates.length, 0, "champ absent du doc vs défaut normalisé → aucun faux delta (normalisation partagée)");
  }
  });

  await section("Serveur : VmReconcile — orphelines (jamais delete), réapparition, périmètre par provider", async () => {
  {
    const { VmReconcile } = SERVER("vm/VmReconcile.js");
    const base = VmReconcile.plan(mkInput([mkVmRecord()], [])).creates[0];

    // DISPARUE : plus dans l'inventaire → orphan true (patch dédié, JAMAIS de delete).
    const gone = VmReconcile.plan(mkInput([], [base]));
    ck.eq(gone.orphans.length, 1, "vm disparue de l'inventaire → marquée orpheline");
    ck.eq(Object.keys(gone.orphans[0].patch).sort().join(","), "last_sync,orphan", "…patch = { orphan:true, last_sync } uniquement (pas de suppression)");
    // Déjà orpheline → aucune op (idempotence du marquage).
    const still = VmReconcile.plan(mkInput([], [{ ...base, orphan: true }]));
    ck.eq(still.orphans.length, 0, "déjà orpheline → pas de re-marquage");
    // RÉAPPARUE : orphan true + présente à l'inventaire → orphan repasse false (champ source, via le diff).
    const back = VmReconcile.plan(mkInput([mkVmRecord()], [{ ...base, orphan: true }]));
    ck(back.updates.length === 1 && back.updates[0].patch.orphan === false, "vm réapparue → patch orphan:false");

    // PÉRIMÈTRE : les vms d'une AUTRE instance de provider (multi-clusters par document,
    // amendement 2026-07-13) ne sont NI orphelinées NI touchées par cette synchro.
    const autre = { ...base, id: "vm-autre", ext_id: "lab/500", provider_id: "pve-lab" };
    const scoped = VmReconcile.plan(mkInput([], [autre]));
    ck.eq(scoped.orphans.length + scoped.updates.length + scoped.creates.length, 0, "vm d'un autre provider : hors périmètre (jamais orpheline par erreur)");
    // Et un record qui prétendrait venir d'une autre instance est écarté (garde-fou).
    const foreign = VmReconcile.plan(mkInput([mkVmRecord({ provider_id: "pve-lab" })], []));
    ck.eq(foreign.creates.length, 0, "record d'une autre instance → écarté (l'adaptateur estampille, le plan vérifie)");
  }
  });

  /* ============ SERVEUR : SecretBox partagé (chiffrement au repos des secrets) ============ */

  await section("Serveur : SecretBox — AES-256-GCM (aller-retour, clé différente, altération, repli env legacy)", async () => {
  {
    const { SecretBox } = SERVER("SecretBox.js");
    const box = new SecretBox("une-passphrase-d-infrastructure-longue");
    const secret = "sync@pve!inventaire=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    // Aller-retour + format versionné.
    const stored = box.encrypt(secret);
    ck(/^v1:/.test(stored) && !stored.includes(secret), "chiffré au format v1:…, le clair n'apparaît pas");
    ck.eq(box.decrypt(stored), secret, "déchiffrement → clair d'origine");
    // IV aléatoire : deux chiffrements du MÊME clair diffèrent (exigence GCM).
    ck(box.encrypt(secret) !== box.encrypt(secret), "IV aléatoire → sorties différentes pour le même clair");
    // Clé différente → refus EXPLICITE, sans fuite du contenu.
    const other = new SecretBox("autre-passphrase");
    let wrongKey = null;
    try { other.decrypt(stored); } catch (e) { wrongKey = e.message; }
    ck(!!wrongKey && /ressaisi/.test(wrongKey) && !wrongKey.includes(secret), "clé différente → erreur explicite (secret à ressaisir), aucun contenu divulgué");
    // Altération du stocké → refus (chiffrement AUTHENTIFIÉ).
    const tampered = stored.slice(0, -4) + (stored.endsWith("AAAA") ? "BBBB" : "AAAA");
    let alt = false;
    try { box.decrypt(tampered); } catch (_) { alt = true; }
    ck(alt, "donnée altérée → déchiffrement refusé (GCM authentifié)");
    // Format inconnu / donnée corrompue → erreur explicite.
    let badFmt = false;
    try { box.decrypt("v9:x:y:z"); } catch (_) { badFmt = true; }
    ck(badFmt, "format de version inconnue → erreur explicite");

    // -- fromEnv : clé générique, repli legacy (compat VM_PROVIDERS_KEY), priorité. --
    ck.eq(SecretBox.fromEnv({}), null, "aucune clé (ni DCMANAGER_SECRETS_KEY ni legacy) → null (features à secrets désactivées)");
    const fromEnv = SecretBox.fromEnv({ DCMANAGER_SECRETS_KEY: "une-passphrase-d-infrastructure-longue" });
    ck.eq(fromEnv.decrypt(stored), secret, "fromEnv (DCMANAGER_SECRETS_KEY) → même clé dérivée (déchiffre ce que le coffre direct a chiffré)");
    // Legacy seule → coffre opérationnel (les déploiements VM existants continuent de déchiffrer)
    // + AVERTISSEMENT de migration (noms de variables uniquement, jamais de valeur).
    const warns = [];
    const legacyBox = SecretBox.fromEnv({ VM_PROVIDERS_KEY: "une-passphrase-d-infrastructure-longue" }, { warn: (...a) => warns.push(a.join(" ")) });
    ck.eq(legacyBox.decrypt(stored), secret, "legacy VM_PROVIDERS_KEY seule → repli, même dérivation (secrets existants lisibles)");
    ck(warns.length === 1 && /VM_PROVIDERS_KEY/.test(warns[0]) && /DCMANAGER_SECRETS_KEY/.test(warns[0]), "…avec un avertissement invitant à migrer (les deux noms cités)");
    ck(!warns[0].includes("une-passphrase"), "…et JAMAIS la valeur de la passphrase dans le log");
    // Les deux présentes → la GÉNÉRIQUE gagne (pas d'ambiguïté), aucun avertissement.
    const bothWarns = [];
    const bothBox = SecretBox.fromEnv({ DCMANAGER_SECRETS_KEY: "une-passphrase-d-infrastructure-longue", VM_PROVIDERS_KEY: "autre-passphrase" }, { warn: (...a) => bothWarns.push(a.join(" ")) });
    ck.eq(bothBox.decrypt(stored), secret, "les deux clés présentes → DCMANAGER_SECRETS_KEY prioritaire");
    ck.eq(bothWarns.length, 0, "…sans avertissement (la configuration cible est en place)");
    // Passphrase vide/blanche = absente (pas de coffre au comportement surprenant).
    ck.eq(SecretBox.fromEnv({ DCMANAGER_SECRETS_KEY: "  " }), null, "passphrase blanche → traitée comme absente");
  }
  });

  /* ============ SERVEUR : NotifyEngine (moteur anti-spam PUR du module notify/) ============ */

  await section("Serveur : NotifyEngine — nouveau problème, rappel dû/pas dû, resolve, échec d'envoi, multi-types", async () => {
  {
    const { NotifyEngine, DEFAULT_REMIND_INTERVAL_SEC } = SERVER("notify/NotifyEngine.js");
    const { MemoryNotifyStateStore } = SERVER("notify/MemoryNotifyStateStore.js");

    // Horloge CONTRÔLÉE (le moteur ne touche jamais à l'horloge système).
    let nowMs = Date.parse("2026-07-14T08:00:00.000Z");
    const clock = () => new Date(nowMs);
    const HOUR = 3600 * 1000;
    // Notifier stub : capture les remises ; `fail` bascule l'échec à la demande.
    const mkNotifier = (kind) => {
      const stub = { kind, sent: [], fail: null };
      stub.send = async (m) => { if (stub.fail) throw new Error(stub.fail); stub.sent.push(m); };
      return stub;
    };
    const mkTarget = (contactId, channel) => ({ contact_id: contactId, address: channel === "sms" ? "+320000000" : contactId + "@exemple.test", channel });

    // -- 1) Cycle nominal : nouveau → silencieux → rappel dû → resolve notifié. --
    {
      const email = mkNotifier("webhook");
      const store = new MemoryNotifyStateStore();
      const journal = [];
      const engine = new NotifyEngine({
        store, clock,
        router: () => [{ notifier_id: "wh-1", notifier: email, target: mkTarget("c1", "email") }],
        journal: (e) => journal.push(e),
      });

      ck.eq(await engine.raise("vm-sync:doc1:pve", { event_type: "vm-sync-failure", severity: "error", title: "Synchro KO", body: "timeout", doc_id: "doc1" }), "sent", "problème NOUVEAU → envoi immédiat");
      ck.eq(email.sent.length, 1, "…une remise au destinataire routé");
      const msg = email.sent[0];
      ck(msg.event_type === "vm-sync-failure" && msg.severity === "error" && msg.title === "Synchro KO" && msg.body === "timeout" && msg.doc_id === "doc1", "…message complet (type/gravité/titre/corps/doc)");
      ck.eq(msg.target.address, "c1@exemple.test", "…adresse résolue par le routage portée au notifier");
      const st1 = store.get("vm-sync:doc1:pve");
      ck(st1.last_sent === "2026-07-14T08:00:00.000Z" && st1.last_error === null, "…état : last_sent posé, pas d'erreur");
      ck.eq(st1.remind_interval_sec, DEFAULT_REMIND_INTERVAL_SEC, "…intervalle par défaut = 12 h (décision Q2)");
      ck.eq(st1.next_remind_at, new Date(nowMs + 12 * HOUR).toISOString(), "…rappel planifié à +12 h");
      ck(journal.length === 1 && journal[0].phase === "alerte" && journal[0].ok === true && journal[0].notifier_id === "wh-1", "…journal : une entrée phase alerte, ok");

      // Idempotence PAR RUN : le détecteur re-signale à chaque passe → silencieux tant que pas dû.
      nowMs += 1 * HOUR;
      ck.eq(await engine.raise("vm-sync:doc1:pve", { event_type: "vm-sync-failure", severity: "error", title: "Synchro KO", body: "timeout", doc_id: "doc1" }), "silenced", "déjà suivi, rappel PAS dû → silencieux");
      ck.eq(email.sent.length, 1, "…aucune remise supplémentaire (anti-spam)");

      // Rappel DÛ via raise (le détecteur tourne encore) : re-remise + replanification.
      nowMs += 11 * HOUR + 1000;
      ck.eq(await engine.raise("vm-sync:doc1:pve", { event_type: "vm-sync-failure", severity: "error", title: "Synchro KO", body: "timeout persistant", doc_id: "doc1" }), "reminded", "échéance atteinte → rappel");
      ck.eq(email.sent.length, 2, "…2ᵉ remise");
      ck.eq(email.sent[1].body, "timeout persistant", "…avec le message RAFRAÎCHI du producteur");
      ck.eq(store.get("vm-sync:doc1:pve").next_remind_at, new Date(nowMs + 12 * HOUR).toISOString(), "…rappel replanifié à +12 h");
      ck.eq(journal.filter((e) => e.phase === "rappel").length, 1, "…journal : phase rappel");

      // Resolve : message « rétabli » UNE fois (l'alerte avait été envoyée — Q1).
      nowMs += 1 * HOUR;
      ck.eq(await engine.resolve("vm-sync:doc1:pve"), "resolved-notified", "resolve après envoi → rétablissement notifié");
      ck.eq(email.sent.length, 3, "…une remise de rétablissement");
      ck(email.sent[2].severity === "info" && /Rétabli/.test(email.sent[2].title), "…severity info + titre « Rétabli — … »");
      const closed = store.get("vm-sync:doc1:pve");
      ck(closed.resolved_at !== null && closed.next_remind_at === null, "…état clos : resolved_at posé, plus AUCUN rappel");
      ck.eq(await engine.resolve("vm-sync:doc1:pve"), "not-active", "resolve répété → no-op (une seule notification de rétablissement)");
      ck.eq(email.sent.length, 3, "…aucune remise supplémentaire");
      ck.eq(await engine.runReminders(), 0, "…et la passe de rappels ignore les états clos");

      // RÉ-APPARITION après resolve = NOUVEL épisode (alerte immédiate, first_seen repart).
      nowMs += 1 * HOUR;
      ck.eq(await engine.raise("vm-sync:doc1:pve", { event_type: "vm-sync-failure", severity: "error", title: "Synchro KO", body: "re-timeout", doc_id: "doc1" }), "sent", "re-signalé après resolve → nouvel épisode, envoi immédiat");
      ck.eq(store.get("vm-sync:doc1:pve").first_seen, new Date(nowMs).toISOString(), "…first_seen repart");
    }

    // -- 2) Passe de rappels AUTONOME (timer S3) : re-notifie sans producteur, y compris après échec d'envoi. --
    {
      const flaky = mkNotifier("webhook");
      const store = new MemoryNotifyStateStore();
      const journal = [];
      const engine = new NotifyEngine({
        store, clock,
        router: () => [{ notifier_id: "wh-flaky", notifier: flaky, target: mkTarget("c2", "sms") }],
        remindIntervalSec: () => 1800, // réglage PAR TYPE (ici : 30 min pour le test)
        journal: (e) => journal.push(e),
      });

      // Envoi initial en ÉCHEC : l'alerte est suivie, l'erreur mémorisée, last_sent RESTE null.
      flaky.fail = "HTTP 502 du webhook";
      await engine.raise("cert-expiry:doc1:cert9", { event_type: "cert-expiry", severity: "warning", title: "Certificat expire", body: "J-14", doc_id: "doc1" });
      const failed = store.get("cert-expiry:doc1:cert9");
      ck(failed.last_sent === null && /webhook: HTTP 502/.test(failed.last_error), "échec d'envoi → last_error mémorisé, last_sent null");
      ck(journal.length === 1 && journal[0].ok === false && /HTTP 502/.test(journal[0].detail), "…journal : remise KO avec le détail");

      // Pas dû → la passe ne fait rien ; dû → RETENTE (le rappel EST le retry), succès → last_sent posé.
      ck.eq(await engine.runReminders(), 0, "échéance pas atteinte → passe de rappels sans effet");
      nowMs += 1801 * 1000;
      flaky.fail = null;
      ck.eq(await engine.runReminders(), 1, "échéance atteinte → rappel AUTONOME (sans raise du producteur)");
      const retried = store.get("cert-expiry:doc1:cert9");
      ck(retried.last_sent !== null && retried.last_error === null, "…retry réussi : last_sent posé, last_error purgé");
      ck.eq(flaky.sent[0].title, "Certificat expire", "…message reconstruit depuis l'état (porté sans le producteur)");

      // Resolve d'une alerte JAMAIS remise : clôture SILENCIEUSE (pas de « rétabli » mensonger).
      flaky.fail = "HTTP 502 du webhook";
      await engine.raise("cert-expiry:doc1:cert-muet", { event_type: "cert-expiry", severity: "warning", title: "Jamais partie", body: "-", doc_id: "doc1" });
      flaky.fail = null;
      const sentBefore = flaky.sent.length;
      ck.eq(await engine.resolve("cert-expiry:doc1:cert-muet"), "resolved-silent", "resolve sans envoi préalable → clôture silencieuse (Q1)");
      ck.eq(flaky.sent.length, sentBefore, "…aucun message de rétablissement");
    }

    // -- 3) Multi-types et multi-destinataires : intervalle PAR TYPE, échec PARTIEL. --
    {
      const okChan = mkNotifier("console");
      const koChan = mkNotifier("webhook");
      koChan.fail = "injoignable";
      const store = new MemoryNotifyStateStore();
      const intervals = { "vm-sync-failure": 600, "cert-expiry": 7200 };
      const engine = new NotifyEngine({
        store, clock,
        router: (eventType) => eventType === "test" ? [] : [
          { notifier_id: "n-ok", notifier: okChan, target: mkTarget("c1", "email") },
          { notifier_id: "n-ko", notifier: koChan, target: mkTarget("c2", "sms") },
        ],
        remindIntervalSec: (t) => intervals[t] || 43200,
      });

      await engine.raise("vm-sync:docA:p1", { event_type: "vm-sync-failure", severity: "error", title: "KO", body: "-", doc_id: "docA" });
      await engine.raise("cert-expiry:docA:c1", { event_type: "cert-expiry", severity: "warning", title: "Expire", body: "-", doc_id: "docA" });
      const vmState = store.get("vm-sync:docA:p1"), certState = store.get("cert-expiry:docA:c1");
      ck(vmState.remind_interval_sec === 600 && certState.remind_interval_sec === 7200, "intervalle de rappel PAR TYPE d'événement (réglage injecté)");
      ck(vmState.last_sent !== null && /webhook: injoignable/.test(vmState.last_error), "échec PARTIEL : ≥1 remise OK → last_sent posé, l'échec reste diagnostiqué (last_error)");
      ck.eq(okChan.sent.length, 2, "…le canal sain a servi les deux types");

      // Aucun destinataire routé (type sans abonnement) : suivi silencieux, pas une erreur.
      await engine.raise("test:global", { event_type: "test", severity: "info", title: "Ping", body: "-" });
      const silent = store.get("test:global");
      ck(silent !== null && silent.last_sent === null && silent.last_error === null && silent.doc_id === null, "aucun destinataire routé → état suivi (doc_id null), rien d'envoyé, pas d'erreur");

      // Réglage modifié À CHAUD : relu à l'échéance (rappel replanifié avec le nouvel intervalle).
      intervals["vm-sync-failure"] = 60;
      nowMs += 601 * 1000;
      await engine.runReminders();
      ck.eq(store.get("vm-sync:docA:p1").remind_interval_sec, 60, "intervalle relu à CHAQUE échéance (réglage à chaud, sans redémarrage)");
    }

    // -- 4) ConsoleNotifier (dummy v1) : une ligne formatée, n'échoue jamais. --
    {
      const { ConsoleNotifier } = SERVER("notify/ConsoleNotifier.js");
      const lines = [];
      const consoleNotifier = new ConsoleNotifier((l) => lines.push(l));
      await consoleNotifier.send({ event_type: "test", severity: "info", title: "Ping", body: "corps", doc_id: null, target: { contact_id: "c1", address: "c1@exemple.test", channel: "email" } });
      ck.eq(consoleNotifier.kind, "console", "kind = console");
      ck(lines.length === 1 && /INFO/.test(lines[0]) && /test/.test(lines[0]) && /Ping/.test(lines[0]) && /c1@exemple\.test/.test(lines[0]), "une ligne lisible : gravité + type + titre + destinataire");
    }
  }
  });

  /* ============ SERVEUR : WebhookFormat (formatage PUR du corps — compact / HTML / brut) ============ */

  await section("Serveur : WebhookFormat — texte compact (gravité, repli, troncature), corps HTML échappé, corps brut", async () => {
  {
    const { WebhookFormat } = SERVER("notify/WebhookFormat.js");

    // -- simpleText : préfixe de gravité (rien pour info), « Titre — Corps », corps vide sans séparateur. --
    ck.eq(WebhookFormat.simpleText({ severity: "info", title: "Titre", body: "Corps" }, 300), "Titre — Corps", "info : pas de préfixe, « Titre — Corps »");
    ck.eq(WebhookFormat.simpleText({ severity: "warning", title: "T", body: "" }, 300), "[avertissement] T", "warning : préfixe + titre, corps vide → pas de séparateur");
    ck.eq(WebhookFormat.simpleText({ severity: "error", title: "T", body: "B" }, 300), "[erreur] T — B", "error : préfixe [erreur]");
    ck.eq(WebhookFormat.simpleText({ severity: "info", title: "L1\nL2", body: "détail A\ndétail B" }, 300), "L1 L2 — détail A détail B", "linefeeds repliés en espaces (mise à plat sur une ligne)");

    // -- Troncature EXACTE : longueur == maxChars → intact ; == maxChars+1 → tronqué à maxChars, ellipse comprise. --
    ck.eq(WebhookFormat.simpleText({ severity: "info", title: "ABCDEFGHIJ", body: "" }, 10), "ABCDEFGHIJ", "longueur == maxChars → intact");
    const trunc = WebhookFormat.simpleText({ severity: "info", title: "ABCDEFGHIJK", body: "" }, 10);
    ck(trunc.length === 10 && trunc === "ABCDEFGHI…", "longueur == maxChars+1 → tronqué à maxChars (ellipse finale comprise)");

    // -- htmlBody : entités échappées (& < > " '), paragraphes sur ligne vide, <br> sur linefeed simple. --
    ck.eq(WebhookFormat.htmlBody({ body: "Alerte <b>&\"'</b>" }), "<p>Alerte &lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;</p>", "HTML : entités échappées & < > \" '");
    ck.eq(WebhookFormat.htmlBody({ body: "Para1 A\nPara1 B\n\nPara2" }), "<p>Para1 A<br>Para1 B</p><p>Para2</p>", "HTML : paragraphe sur ligne vide, <br> sur linefeed simple");
    ck.eq(WebhookFormat.htmlBody({ body: "" }), "", "HTML : corps vide → fragment vide");

    // -- textBody : corps BRUT inchangé (linefeed = seul formatage). --
    ck.eq(WebhookFormat.textBody({ body: "Ligne 1\nLigne 2" }), "Ligne 1\nLigne 2", "texte brut : corps inchangé (comportement historique)");
  }
  });

  /* ============ SERVEUR : WebhookNotifier (fetch injecté — payload, auth, erreurs sans secret) ============ */

  await section("Serveur : WebhookNotifier — POST JSON (Q5), en-tête d'auth, erreurs sans secret ni URL complète", async () => {
  {
    const { WebhookNotifier } = SERVER("notify/WebhookNotifier.js");
    const message = { event_type: "test", severity: "info", title: "Sujet", body: "Corps", doc_id: null, target: { contact_id: "c1", address: "dest@exemple.test", channel: "email" } };

    // Payload + en-tête d'auth (fetch stub : capture sans réseau).
    const calls = [];
    const fetchOk = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; };
    await new WebhookNotifier("https://hooks.exemple.lan/chemin-secret/envoyer", "JETON-SECRET", fetchOk).send(message);
    ck.eq(calls.length, 1, "un POST par remise");
    ck.eq(calls[0].init.method, "POST", "méthode POST");
    const payload = JSON.parse(calls[0].init.body);
    ck(payload.to === "dest@exemple.test" && payload.subject === "Sujet" && payload.body === "Corps" && payload.severity === "info" && payload.event_type === "test",
      "contrat normal (clés anglaises, décision 2026-07-15) : { to, subject, body, severity, event_type }");
    ck.eq(calls[0].init.headers["Authorization"], "Bearer JETON-SECRET", "jeton en en-tête Authorization: Bearer");
    ck.eq(calls[0].init.headers["Content-Type"], "application/json", "Content-Type JSON");

    // Sans jeton : AUCUN en-tête d'auth (webhook interne non authentifié).
    calls.length = 0;
    await new WebhookNotifier("https://hooks.exemple.lan/envoyer", null, fetchOk).send(message);
    ck.eq(calls[0].init.headers["Authorization"], undefined, "token null → pas d'en-tête Authorization");

    // HTTP non-2xx → erreur SANS jeton, SANS chemin d'URL (hôte seul), statut cité.
    const fetch500 = async () => ({ ok: false, status: 500 });
    let httpErr = null;
    try { await new WebhookNotifier("https://hooks.exemple.lan/chemin-secret/envoyer", "JETON-SECRET", fetch500).send(message); } catch (e) { httpErr = e.message; }
    ck(!!httpErr && /HTTP 500/.test(httpErr) && /hooks\.exemple\.lan/.test(httpErr), "échec HTTP → statut + hôte dans l'erreur");
    ck(!httpErr.includes("JETON-SECRET") && !httpErr.includes("chemin-secret"), "…JAMAIS le jeton ni le chemin (capability) dans l'erreur");

    // Échec RÉSEAU : message bas niveau nettoyé (une URL citée est tronquée à l'hôte).
    const fetchDown = async () => { throw new Error("connect ECONNREFUSED https://hooks.exemple.lan/chemin-secret/envoyer"); };
    let netErr = null;
    try { await new WebhookNotifier("https://hooks.exemple.lan/chemin-secret/envoyer", "JETON-SECRET", fetchDown).send(message); } catch (e) { netErr = e.message; }
    ck(!!netErr && /injoignable/.test(netErr) && !netErr.includes("chemin-secret"), "échec réseau → « injoignable », URL nettoyée (hôte seul)");

    // -- Mode NORMAL défaut (options omises) : payload complet + clé format:"text", body BRUT. --
    calls.length = 0;
    const multiLineMsg = { ...message, body: "Ligne A\nLigne B" };
    await new WebhookNotifier("https://hooks.exemple.lan/envoyer", null, fetchOk).send(multiLineMsg);
    const normalPayload = JSON.parse(calls[0].init.body);
    ck(normalPayload.to === "dest@exemple.test" && normalPayload.subject === "Sujet" && normalPayload.severity === "info" && normalPayload.event_type === "test", "mode normal défaut : contrat { to, subject, severity, event_type }");
    ck.eq(normalPayload.format, "text", "mode normal défaut → clé format:\"text\"");
    ck.eq(normalPayload.body, "Ligne A\nLigne B", "mode normal défaut → body brut (linefeed = seul formatage)");

    // -- Mode SIMPLIFIÉ : payload EXACTEMENT { to, text } (deux clés), en-tête d'auth INCHANGÉ. --
    calls.length = 0;
    await new WebhookNotifier("https://hooks.exemple.lan/sms", "JETON-SECRET", fetchOk, { simple: true, simpleMaxChars: 300, html: false }).send(message);
    const simplePayload = JSON.parse(calls[0].init.body);
    ck.eq(Object.keys(simplePayload).sort().join(","), "text,to", "mode simplifié : payload à DEUX clés EXACTEMENT { to, text }");
    ck(simplePayload.to === "dest@exemple.test" && simplePayload.text === "Sujet — Corps", "mode simplifié : to = adresse, text = message compact");
    ck.eq(calls[0].init.headers["Authorization"], "Bearer JETON-SECRET", "mode simplifié : en-tête d'auth INCHANGÉ (pas de traitement différent)");

    // -- Mode NORMAL HTML : clé format:"html" + corps mis en forme et échappé. --
    calls.length = 0;
    await new WebhookNotifier("https://hooks.exemple.lan/mail", null, fetchOk, { simple: false, simpleMaxChars: 300, html: true }).send(multiLineMsg);
    const htmlPayload = JSON.parse(calls[0].init.body);
    ck.eq(htmlPayload.format, "html", "mode normal HTML → clé format:\"html\"");
    ck.eq(htmlPayload.body, "<p>Ligne A<br>Ligne B</p>", "mode normal HTML → body mis en forme (paragraphe/<br>)");
  }
  });

  /* ============ SERVEUR : NotifyDb + SubscriptionRouter (notify.db, better-sqlite3 RÉEL) ============ */

  await section("Serveur : NotifyDb — schéma+migrations, CRUD sans fuite de jeton, cascade, états, historique, réglages ; SubscriptionRouter", async () => {
    // better-sqlite3 RÉEL requis (binaire natif) — même probe que les autres sections DB.
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probe = new Candidate(":memory:"); probe.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section NotifyDb sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { NotifyDb } = SERVER("notify/NotifyDb.js");
    const { SecretBox } = SERVER("SecretBox.js");
    const { NotifyConfigError } = SERVER("notify/NotifyValidate.js");
    const { SubscriptionRouter } = SERVER("notify/SubscriptionRouter.js");
    const { NotifyEngine } = SERVER("notify/NotifyEngine.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-notify-"));
    let raw = null;
    try {
      const box = new SecretBox("passphrase-notify-de-test");
      const db = new NotifyDb(dir, Sqlite, box); // Logger "error" par défaut → silencieux

      // -- SCHÉMA : fichier matérialisé, 5 tables créées. --
      ck(fs.existsSync(path.join(dir, "notify.db")), "notify.db matérialisé dans le dossier injecté");
      raw = new Sqlite(path.join(dir, "notify.db"));
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
      for (const t of ["notifier_instances", "subscriptions", "notification_states", "notification_log", "notify_event_settings"]) {
        ck(tables.includes(t), "schéma : table " + t + " créée");
      }

      // -- Instances : création webhook avec jeton — réponse SANS jeton, stocké CHIFFRÉ. --
      const wh = db.saveInstance({ kind: "webhook", label: "SMS passerelle", url: "https://sms.exemple.lan/envoyer" }, "wh-sms", "JETON-CLAIR");
      ck(wh.id === "wh-sms" && wh.has_token === true && wh.enabled === true, "saveInstance → item (has_token, enabled)");
      ck.eq(Object.prototype.hasOwnProperty.call(wh, "token"), false, "…aucun champ token dans la réponse");
      const rowTok = raw.prepare("SELECT token_enc FROM notifier_instances WHERE id='wh-sms'").get().token_enc;
      ck(/^v1:/.test(rowTok) && !rowTok.includes("JETON-CLAIR"), "…jeton chiffré au repos (v1:, clair absent)");
      // Édition SANS jeton → l'existant est CONSERVÉ tel quel.
      db.saveInstance({ kind: "webhook", label: "SMS passerelle (renommée)", url: "https://sms.exemple.lan/envoyer" }, "wh-sms", null);
      ck.eq(raw.prepare("SELECT token_enc FROM notifier_instances WHERE id='wh-sms'").get().token_enc, rowTok, "édition sans jeton → token_enc inchangé");
      // instanceForSend : jeton déchiffré (usage serveur uniquement) ; désactivée → null.
      ck.eq(db.instanceForSend("wh-sms").token, "JETON-CLAIR", "instanceForSend → jeton déchiffré en mémoire");
      db.saveInstance({ kind: "webhook", label: "SMS", url: "https://sms.exemple.lan/envoyer", enabled: false }, "wh-sms", null);
      ck.eq(db.instanceForSend("wh-sms"), null, "instance désactivée → instanceForSend null");
      db.saveInstance({ kind: "webhook", label: "SMS", url: "https://sms.exemple.lan/envoyer", enabled: true }, "wh-sms", null);
      const consoleInst = db.saveInstance({ kind: "console", label: "Console" }, "con-1", null);
      ck(consoleInst.has_token === false && consoleInst.url === null, "instance console : ni url ni jeton");

      // -- Modes d'envoi du webhook (simple / simple_max_chars / html) : aller-retour + défauts. --
      const whOpt = db.saveInstance({ kind: "webhook", label: "SMS simple", url: "https://sms.exemple.lan/x", simple: true, simple_max_chars: 160, html: false }, "wh-opt", null);
      ck(whOpt.simple === true && whOpt.simple_max_chars === 160 && whOpt.html === false, "saveInstance/listInstances : réglages d'envoi persistés (simple, simple_max_chars, html)");
      const whOptSend = db.instanceForSend("wh-opt");
      ck(whOptSend.simple === true && whOptSend.simple_max_chars === 160 && whOptSend.html === false, "instanceForSend : réglages d'envoi remontés (usage serveur)");
      // Webhook sans réglages explicites → défauts (false, 300, false) : REPRODUIT le payload d'avant.
      const whDef = db.saveInstance({ kind: "webhook", label: "SMS défaut", url: "https://sms.exemple.lan/y" }, "wh-def", null);
      ck(whDef.simple === false && whDef.simple_max_chars === 300 && whDef.html === false, "webhook sans réglages → défauts (false, 300, false)");
      // Console : réglages d'envoi SANS OBJET → ramenés aux défauts SANS grief (booléen résiduel non fautif).
      const conOpt = db.saveInstance({ kind: "console", label: "Console b", simple: true, html: true, simple_max_chars: 45 }, "con-opt", null);
      ck(conOpt.simple === false && conOpt.simple_max_chars === 300 && conOpt.html === false, "console : réglages d'envoi ramenés aux défauts, sans grief");

      // -- Validation (griefs groupés, pattern ProviderConfigValidate). --
      let issues = null;
      try { db.saveInstance({ kind: "carrier-pigeon", label: " ", url: "pas-une-url" }, "bad", null); } catch (e) { if (e instanceof NotifyConfigError) issues = e.issues; }
      ck(!!issues && issues.some((i) => /kind/.test(i)) && issues.some((i) => /label/.test(i)), "instance invalide → NotifyConfigError avec TOUS les griefs");
      let whNoUrl = null;
      try { db.saveInstance({ kind: "webhook", label: "X" }, "bad2", null); } catch (e) { whNoUrl = e; }
      ck(whNoUrl instanceof NotifyConfigError && whNoUrl.issues.some((i) => /url/.test(i)), "webhook sans url → refusé");
      // simple_max_chars hors bornes [20, 5000] → grief (borne basse ET borne haute).
      let maxLow = null;
      try { db.saveInstance({ kind: "webhook", label: "X", url: "https://x.exemple.lan/", simple_max_chars: 10 }, "wh-low", null); } catch (e) { maxLow = e; }
      ck(maxLow instanceof NotifyConfigError && maxLow.issues.some((i) => /simple_max_chars/.test(i)), "simple_max_chars < 20 → grief");
      let maxHigh = null;
      try { db.saveInstance({ kind: "webhook", label: "X", url: "https://x.exemple.lan/", simple_max_chars: 99999 }, "wh-high", null); } catch (e) { maxHigh = e; }
      ck(maxHigh instanceof NotifyConfigError && maxHigh.issues.some((i) => /simple_max_chars/.test(i)), "simple_max_chars > 5000 → grief");

      // -- Abonnements : FK instance + cascade, portées doc/global, joker. --
      const sub = db.saveSubscription({ event_type: "vm-sync-failure", contact_id: "contact-1", channel: "email", notifier_id: "con-1", doc_id: "docA" }, "sub-1");
      ck(sub.id === "sub-1" && sub.doc_id === "docA", "saveSubscription → item");
      db.saveSubscription({ event_type: "*", contact_id: "contact-2", channel: "sms", notifier_id: "wh-sms" }, "sub-glob");
      db.saveSubscription({ event_type: "vm-sync-failure", contact_id: "contact-1", channel: "email", notifier_id: "con-1", doc_id: "docB" }, "sub-autre-doc");
      db.saveSubscription({ event_type: "cert-expiry", contact_id: "contact-1", channel: "email", notifier_id: "con-1", enabled: false }, "sub-off");
      let fkErr = false;
      try { db.saveSubscription({ event_type: "test", contact_id: "c", channel: "email", notifier_id: "instance-fantome" }, "sub-fk"); } catch (_) { fkErr = true; }
      ck(fkErr, "abonnement vers une instance inconnue → refusé (FK)");
      const routedSubs = db.subscriptionsFor("vm-sync-failure", "docA");
      ck.eq(routedSubs.map((s) => s.id).join(","), "sub-1,sub-glob", "subscriptionsFor : type exact (docA) + joker global — l'autre doc et l'inactif EXCLUS");
      ck.eq(db.subscriptionsFor("cert-expiry", "docA").map((s) => s.id).join(","), "sub-glob", "abonnement désactivé exclu (le joker global reste)");
      // Suppression d'une instance → ses abonnements suivent (ON DELETE CASCADE).
      const con2 = db.saveInstance({ kind: "console", label: "Temp" }, "con-temp", null);
      db.saveSubscription({ event_type: "test", contact_id: "c", channel: "email", notifier_id: con2.id }, "sub-temp");
      db.removeInstance("con-temp");
      ck.eq(db.listSubscriptions().some((s) => s.id === "sub-temp"), false, "suppression d'instance → abonnements en cascade");

      // -- NotifyStateStore (contrat du moteur) : set/get/listActive sur de VRAIES colonnes. --
      const state = { key: "k1", event_type: "test", severity: "warning", doc_id: "docA", title: "T", body: "B", first_seen: "2026-07-14T00:00:00.000Z", last_sent: null, next_remind_at: "2026-07-14T12:00:00.000Z", remind_interval_sec: 43200, resolved_at: null, last_error: null };
      db.set(state);
      ck.eq(JSON.stringify(db.get("k1")), JSON.stringify(state), "état : aller-retour fidèle (colonnes typées)");
      db.set({ ...state, key: "k2", resolved_at: "2026-07-14T01:00:00.000Z" });
      ck.eq(db.listActive().map((s) => s.key).join(","), "k1", "listActive : les résolus n'apparaissent pas");

      // -- Historique : append + pagination (récent d'abord) + filtre doc + purge par ancienneté. --
      for (let i = 1; i <= 5; i++) db.appendLog({ sent_at: "2026-07-1" + i + "T00:00:00.000Z", key: "k1", event_type: "test", contact_id: "c1", channel: "email", notifier_id: "con-1", phase: "alerte", ok: i % 2 === 1, detail: i % 2 === 1 ? null : "échec " + i });
      const page = db.listLog({ limit: 2, offset: 1 });
      ck(page.total === 5 && page.entries.length === 2 && page.entries[0].sent_at === "2026-07-14T00:00:00.000Z", "pagination : total + tranche, plus récent d'abord");
      ck.eq(db.listLog({ docId: "docA" }).total, 5, "filtre par document (clés des états du doc)");
      ck.eq(db.listLog({ docId: "doc-inconnu" }).total, 0, "…document sans état → historique vide");
      db.appendLog({ sent_at: "2020-01-01T00:00:00.000Z", key: "vieux", event_type: "test", contact_id: null, channel: null, notifier_id: null, phase: "alerte", ok: true, detail: null });
      ck.eq(db.purgeLog(90), 1, "purge par ancienneté : la vieille entrée seulement");

      // -- Réglages par type (Q2) : défaut 12 h, réglage, borne basse, retour au défaut. --
      ck.eq(db.remindIntervalSecFor("cert-expiry"), 43200, "intervalle non réglé → défaut 12 h");
      db.saveEventSetting({ event_type: "cert-expiry", remind_interval_sec: 3600 });
      ck.eq(db.remindIntervalSecFor("cert-expiry"), 3600, "réglage par type persisté");
      let low = null;
      try { db.saveEventSetting({ event_type: "x", remind_interval_sec: 30 }); } catch (e) { low = e; }
      ck(low instanceof NotifyConfigError, "intervalle < 60 s refusé (borne anti-spam)");
      db.removeEventSetting("cert-expiry");
      ck.eq(db.remindIntervalSecFor("cert-expiry"), 43200, "réglage supprimé → retour au défaut");

      // -- ROUTAGE (SubscriptionRouter) : abonnement → instance → contact → adresse par canal. --
      const contactsByDoc = {
        docA: { "contact-1": { id: "contact-1", name: "Alice", email: "alice@exemple.test", phone: "+3211111111" }, "contact-2": { id: "contact-2", name: "Bob", email: "", phone: "+3222222222" } },
        docB: { "contact-3": { id: "contact-3", name: "Carl", email: "carl@exemple.test", phone: "" } },
      };
      const contactSource = {
        documentIds: () => Object.keys(contactsByDoc),
        contact: (docId, contactId) => (contactsByDoc[docId] && contactsByDoc[docId][contactId]) || null,
      };
      const consoleSent = [];
      const consoleStub = { kind: "console", send: async (m) => { consoleSent.push(m); } };
      const fetchCalls = [];
      const fetchStub = async (url, init) => { fetchCalls.push({ url, init }); return { ok: true, status: 200 }; };
      const router = new SubscriptionRouter(db, contactSource, undefined, consoleStub, fetchStub);

      const recipients = router.route("vm-sync-failure", "docA");
      ck.eq(recipients.length, 2, "routage : 2 abonnements applicables (doc + joker global) résolus");
      const emailRec = recipients.find((r) => r.target.channel === "email"), smsRec = recipients.find((r) => r.target.channel === "sms");
      ck(emailRec.target.address === "alice@exemple.test" && emailRec.notifier_id === "con-1", "canal email → adresse email du contact, instance console");
      ck(smsRec.target.address === "+3222222222" && smsRec.notifier_id === "wh-sms", "canal sms → téléphone du contact, instance webhook");
      // Contact sans adresse pour le canal → ignoré ; contact inconnu → ignoré (référence souple).
      // (le joker global sub-glob reste routé, lui : on vérifie l'ABSENCE du destinataire fautif)
      db.saveSubscription({ event_type: "power", contact_id: "contact-3", channel: "sms", notifier_id: "con-1", doc_id: "docB" }, "sub-no-phone");
      ck.eq(router.route("power", "docB").some((r) => r.target.contact_id === "contact-3"), false, "contact sans téléphone en canal sms → abonnement ignoré (pas d'erreur)");
      db.saveSubscription({ event_type: "power", contact_id: "contact-fantome", channel: "email", notifier_id: "con-1", doc_id: "docA" }, "sub-ghost");
      ck.eq(router.route("power", "docA").some((r) => r.target.contact_id === "contact-fantome"), false, "contact introuvable → abonnement ignoré (garde-fou UI)");
      // Abonnement GLOBAL sur événement GLOBAL : le contact est retrouvé en balayant les documents.
      ck.eq(router.route("test", null).map((r) => r.target.address).join(","), "+3222222222", "événement global → repli de recherche du contact dans tous les documents");
      // Jeton indéchiffrable (clé changée) : l'instance est EXCLUE sans faire tomber le routage.
      const otherBoxDb = raw.prepare("UPDATE notifier_instances SET token_enc = ? WHERE id = 'wh-sms'");
      otherBoxDb.run(new SecretBox("autre-cle").encrypt("JETON"));
      ck.eq(router.route("vm-sync-failure", "docA").length, 1, "jeton indéchiffrable → instance exclue, les autres destinataires servis");

      // -- BOUT EN BOUT : moteur + notify.db (store/journal réels) + routage + horloge contrôlée. --
      db.set({ ...state, resolved_at: "2026-07-14T02:00:00.000Z" }); // k1 (test du store) clos — hors de la passe de rappels
      let nowMs = Date.parse("2026-07-14T08:00:00.000Z");
      const engine = new NotifyEngine({
        store: db,
        router: router.asRouter(),
        clock: () => new Date(nowMs),
        remindIntervalSec: (t) => db.remindIntervalSecFor(t),
        journal: (e) => db.appendLog(e),
      });
      await engine.raise("vm-sync:docA:pve", { event_type: "vm-sync-failure", severity: "error", title: "Synchro KO", body: "timeout", doc_id: "docA" });
      ck.eq(consoleSent.length, 1, "bout en bout : alerte remise via l'instance console routée");
      ck(db.get("vm-sync:docA:pve").last_sent !== null, "…état persisté dans notification_states");
      ck(db.listLog({}).entries.some((e) => e.key === "vm-sync:docA:pve" && e.phase === "alerte" && e.ok), "…journal persisté dans notification_log");
      nowMs += 12 * 3600 * 1000 + 1000;
      ck.eq(await engine.runReminders(), 1, "…rappel autonome dû après 12 h (timer S3)");
      await engine.resolve("vm-sync:docA:pve");
      ck(consoleSent.length === 3 && /Rétabli/.test(consoleSent[2].title), "…rétablissement notifié une fois (cycle complet)");
    } finally {
      if (raw) { try { raw.close(); } catch (_) {} }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }

    // -- MIGRATIONS idempotentes : une notify.db d'une version antérieure gagne les colonnes. --
    const dirOld = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-notify-migr-"));
    try {
      const pre = new Sqlite(path.join(dirOld, "notify.db"));
      pre.exec("CREATE TABLE notification_log (id INTEGER PRIMARY KEY AUTOINCREMENT, sent_at TEXT NOT NULL, key TEXT NOT NULL, event_type TEXT NOT NULL, contact_id TEXT, channel TEXT, notifier_id TEXT, ok INTEGER NOT NULL, detail TEXT)");
      pre.exec("CREATE TABLE notification_states (key TEXT PRIMARY KEY, event_type TEXT NOT NULL, severity TEXT NOT NULL, doc_id TEXT, first_seen TEXT NOT NULL, last_sent TEXT, next_remind_at TEXT, remind_interval_sec INTEGER NOT NULL, resolved_at TEXT, last_error TEXT)");
      // notifier_instances SANS les colonnes de modes d'envoi (simple_mode/simple_max_chars/html) + une ligne héritée.
      pre.exec("CREATE TABLE notifier_instances (id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, url TEXT, token_enc TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_date TEXT NOT NULL, updated_date TEXT NOT NULL)");
      pre.exec("INSERT INTO notifier_instances (id, kind, label, url, token_enc, enabled, created_date, updated_date) VALUES ('old-wh', 'webhook', 'Ancien', 'https://old.exemple.lan/', NULL, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
      pre.close();
      const db2 = new NotifyDb(dirOld, Sqlite, new SecretBox("p"));
      // La ligne héritée gagne les DÉFAUTS SQL → payload identique à avant (rétro-compat).
      const migrated = db2.listInstances().find((i) => i.id === "old-wh");
      ck(migrated && migrated.simple === false && migrated.simple_max_chars === 300 && migrated.html === false, "migration : instance antérieure → défauts d'envoi (false, 300, false)");
      const cols = (t) => {
        const check = new Sqlite(path.join(dirOld, "notify.db"));
        const names = check.prepare("SELECT name FROM pragma_table_info('" + t + "')").all().map((r) => r.name);
        check.close();
        return names;
      };
      db2.close();
      ck(cols("notification_log").includes("phase"), "migration : colonne phase ajoutée à une notification_log antérieure");
      ck(cols("notification_states").includes("title") && cols("notification_states").includes("body"), "migration : colonnes title/body ajoutées à une notification_states antérieure");
      ck(cols("notifier_instances").includes("simple_mode") && cols("notifier_instances").includes("simple_max_chars") && cols("notifier_instances").includes("html"), "migration : colonnes simple_mode/simple_max_chars/html ajoutées à une notifier_instances antérieure");
    } finally {
      try { fs.rmSync(dirOld, { recursive: true, force: true }); } catch (_) {}
    }
  });

  /* ============ SERVEUR : CertsDb (PKI zéro-connaissance, certs.db, better-sqlite3 RÉEL) ============ */

  await section("Serveur : CertsDb — schéma, PKI init unique, CRUD, FK émetteur, SAN ordonnés, garde-fous, invariant Q5", async () => {
    // better-sqlite3 RÉEL requis (binaire natif) — même probe que les autres sections DB.
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probe = new Candidate(":memory:"); probe.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section CertsDb sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { CertsDb } = SERVER("certs/CertsDb.js");
    const { CertsConfigError } = SERVER("certs/CertsValidate.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-certs-"));
    let raw = null;
    try {
      const db = new CertsDb(dir, Sqlite); // Logger "error" par défaut → silencieux

      // -- SCHÉMA : fichier matérialisé, 3 tables créées. --
      ck(fs.existsSync(path.join(dir, "certs.db")), "certs.db matérialisé dans le dossier injecté");
      raw = new Sqlite(path.join(dir, "certs.db"));
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
      for (const t of ["pki_documents", "certificates", "certificate_sans"]) ck(tables.includes(t), "schéma : table " + t + " créée");

      // -- PKI : initialisation UNIQUE (jamais d'écrasement — clé maître irremplaçable). --
      ck.eq(db.pkiParams("doc-A"), null, "PKI non initialisée → null (le client enchaîne sur l'initialisation)");
      const pkiOk = db.initPki("doc-A", { kdf_version: "v1", kdf_salt: "c2VsLWFsZWF0b2lyZQ==", kdf_iters: 600000, keycheck_enc: "v1:aXY=:Y2hlY2s=" });
      ck.eq(pkiOk, true, "initPki : première initialisation acceptée");
      const params = db.pkiParams("doc-A");
      ck(params.kdf_version === "v1" && params.kdf_iters === 600000 && params.kdf_salt === "c2VsLWFsZWF0b2lyZQ==", "pkiParams : aller-retour fidèle (sel/itérations/version)");
      ck.eq(db.initPki("doc-A", { kdf_version: "v1", kdf_salt: "YXV0cmU=", kdf_iters: 700000, keycheck_enc: "x" }), false, "ré-initialisation REFUSÉE (rendrait les clés stockées indéchiffrables)");
      ck.eq(db.pkiParams("doc-A").kdf_salt, "c2VsLWFsZWF0b2lyZQ==", "…paramètres d'origine INTACTS");
      // Validation des paramètres (plancher Q1, base64, version connue).
      let pkiIssues = null;
      try { db.initPki("doc-B", { kdf_version: "v2", kdf_salt: "pas du base64 !", kdf_iters: 1000, keycheck_enc: "" }); } catch (e) { if (e instanceof CertsConfigError) pkiIssues = e.issues; }
      ck(!!pkiIssues && pkiIssues.some((i) => /kdf_version/.test(i)) && pkiIssues.some((i) => /600000/.test(i)) && pkiIssues.some((i) => /kdf_salt/.test(i)), "paramètres PKI invalides → griefs groupés (version, plancher d'itérations, sel)");

      // -- CRÉATION d'une racine (métadonnées + SAN + clé chiffrée client). --
      const rootDetail = db.save("doc-A", "ca-1", {
        kind: "root-ca", label: "CA interne", subject: "CN=CA interne exemple", key_algo: "ec-p256",
        serial: "01", not_before: "2026-01-01T00:00:00.000Z", not_after: "2036-01-01T00:00:00.000Z",
        fingerprint: "AA:BB", public_pem: "-----BEGIN CERTIFICATE-----exemple-----END CERTIFICATE-----",
        key_enc: "v1:aXY=:Y2lwaGVydGV4dA==",
        sans: [{ san_type: "dns", value: "ca.exemple.lan" }],
      });
      ck(rootDetail.id === "ca-1" && rootDetail.has_key === true && rootDetail.key_enc === "v1:aXY=:Y2lwaGVydGV4dA==", "save (racine) → détail complet, clé chiffrée stockée telle quelle (opaque)");

      // -- INVARIANT Q5 : key_enc JAMAIS en liste, présent au GET unitaire. --
      const listed = db.listFor("doc-A");
      ck.eq(listed.length, 1, "listFor : la racine listée");
      ck(!Object.prototype.hasOwnProperty.call(listed[0], "key_enc") && listed[0].has_key === true, "INVARIANT Q5 : aucune propriété key_enc en liste (has_key seul)");
      ck.eq(db.getOne("doc-A", "ca-1").key_enc, "v1:aXY=:Y2lwaGVydGV4dA==", "GET unitaire : key_enc inclus (export côté client)");

      // -- DÉRIVÉ : FK émetteur (existant / inexistant), règles parent par kind. --
      const leaf = db.save("doc-A", "leaf-1", {
        kind: "leaf-tls", parent_id: "ca-1", label: "Service interne", subject: "CN=svc.exemple.lan", key_algo: "rsa-2048",
        not_before: "2026-01-01T00:00:00.000Z", not_after: "2026-06-01T00:00:00.000Z",
        sans: [{ san_type: "dns", value: "svc.exemple.lan" }, { san_type: "ip", value: "10.0.0.10" }],
      });
      ck(leaf.parent_id === "ca-1" && leaf.has_key === false, "save (dérivé) → rattaché à l'émetteur, sans clé détenue (has_key false)");
      let fkErr = false;
      try { db.save("doc-A", "leaf-x", { kind: "leaf-tls", parent_id: "ca-fantome", label: "X", subject: "CN=x", key_algo: "ec-p256" }); } catch (_) { fkErr = true; }
      ck(fkErr, "émetteur inconnu → refusé (FK composite doc_id+parent_id)");
      let kindIssues = null;
      try { db.save("doc-A", "bad-1", { kind: "leaf-tls", label: "X", subject: "CN=x", key_algo: "ec-p256" }); } catch (e) { if (e instanceof CertsConfigError) kindIssues = e.issues; }
      ck(!!kindIssues && kindIssues.some((i) => /parent_id : requis/.test(i)), "dérivé SANS émetteur → grief (parent_id requis)");
      let rootIssues = null;
      try { db.save("doc-A", "bad-2", { kind: "root-ca", parent_id: "ca-1", label: "X", subject: "CN=x", key_algo: "ec-p256" }); } catch (e) { if (e instanceof CertsConfigError) rootIssues = e.issues; }
      ck(!!rootIssues && rootIssues.some((i) => /sans objet/.test(i)), "racine AVEC émetteur → grief (parent_id sans objet)");
      let dateIssues = null;
      try { db.save("doc-A", "bad-3", { kind: "ssh-keypair", label: "X", subject: "user@exemple", key_algo: "ed25519", not_before: "2026-06-01T00:00:00.000Z", not_after: "2026-01-01T00:00:00.000Z" }); } catch (e) { if (e instanceof CertsConfigError) dateIssues = e.issues; }
      ck(!!dateIssues && dateIssues.some((i) => /not_after/.test(i)), "not_after antérieur à not_before → grief");

      // -- MISE À JOUR de métadonnées SANS key_enc → la clé stockée est CONSERVÉE (flux zéro-connaissance). --
      db.save("doc-A", "ca-1", {
        kind: "root-ca", label: "CA interne (révoquée)", subject: "CN=CA interne exemple", key_algo: "ec-p256",
        revoked_at: "2026-07-14T00:00:00.000Z",
        sans: [{ san_type: "dns", value: "ca.exemple.lan" }],
      });
      const revoked = db.getOne("doc-A", "ca-1");
      ck(revoked.revoked_at !== null && revoked.key_enc === "v1:aXY=:Y2lwaGVydGV4dA==", "PUT sans key_enc (métadonnées seules, ex. révocation) → clé chiffrée CONSERVÉE");

      // -- SAN : remplacement complet, ordre = position. --
      ck.eq(db.getOne("doc-A", "leaf-1").sans.map((s) => s.san_type + ":" + s.value).join(","), "dns:svc.exemple.lan,ip:10.0.0.10", "SAN ordonnés (position = index du tableau)");
      db.save("doc-A", "leaf-1", { kind: "leaf-tls", parent_id: "ca-1", label: "Service interne", subject: "CN=svc.exemple.lan", key_algo: "rsa-2048", sans: [{ san_type: "dns", value: "nouveau.exemple.lan" }] });
      ck.eq(db.getOne("doc-A", "leaf-1").sans.length, 1, "ré-enregistrement → SAN intégralement remplacés");
      let sanIssues = null;
      try { db.save("doc-A", "bad-4", { kind: "ssh-keypair", label: "X", subject: "u@x", key_algo: "ed25519", sans: [{ san_type: "pigeon-voyageur", value: "x" }] }); } catch (e) { if (e instanceof CertsConfigError) sanIssues = e.issues; }
      ck(!!sanIssues && sanIssues.some((i) => /san_type/.test(i)), "type de SAN inconnu → grief");

      // -- isActive : ni révoqué, ni expiré (seule question de sûreté que le serveur puisse trancher). --
      const NOW = Date.parse("2026-07-16T12:00:00Z");
      ck.eq(CertsDb.isActive({ revoked_at: null, not_after: "2027-01-01T00:00:00Z" }, NOW), true, "isActive : ni révoqué ni expiré → actif");
      ck.eq(CertsDb.isActive({ revoked_at: "2026-01-01T00:00:00Z", not_after: "2027-01-01T00:00:00Z" }, NOW), false, "isActive : révoqué → inactif");
      ck.eq(CertsDb.isActive({ revoked_at: null, not_after: "2026-01-01T00:00:00Z" }, NOW), false, "isActive : expiré → inactif");
      ck.eq(CertsDb.isActive({ revoked_at: null, not_after: null }, NOW), true, "isActive : sans date de fin → ACTIF (on protège par défaut)");
      ck.eq(CertsDb.isActive({ revoked_at: null, not_after: "pas-une-date" }, NOW), true, "isActive : date illisible → ACTIF (on ne suppose pas l'expiration)");

      // -- SUPPRESSION : descendance (prioritaire) > garde `force` (encore valide) ; cascade des SAN. --
      ck.eq(db.remove("doc-A", "ca-1"), "children", "suppression d'un émetteur avec dérivés → refusée (garde-fou)");
      ck.eq(db.remove("doc-A", "ca-1", true), "children", "…et `force` NE lève PAS la descendance : intégrité, pas intention");
      ck.eq(db.remove("doc-A", "leaf-1"), "force_required", "certificat ENCORE VALIDE sans force → force_required (428 côté route)");
      ck.eq(raw.prepare("SELECT COUNT(*) AS n FROM certificates WHERE id='leaf-1'").get().n, 1, "…et il est TOUJOURS là (le refus n'efface rien)");
      ck.eq(db.remove("doc-A", "leaf-1", true), "ok", "…avec ?force=true → supprimé");
      ck.eq(raw.prepare("SELECT COUNT(*) AS n FROM certificate_sans WHERE cert_id='leaf-1'").get().n, 0, "…ses SAN partent en cascade");
      ck.eq(db.remove("doc-A", "ca-1", true), "ok", "…puis l'émetteur peut être supprimé (force : lui aussi est encore valide)");
      ck.eq(db.remove("doc-A", "inconnu"), "missing", "suppression d'un inconnu → missing (404 côté route)");

      // Un RÉVOQUÉ et un EXPIRÉ partent SANS force : ils ne sont plus « encore valides ».
      db.save("doc-A", "gone-1", { kind: "ssh-keypair", label: "Révoqué", subject: "u@r", key_algo: "ed25519", revoked_at: "2026-07-01T00:00:00.000Z" });
      ck.eq(db.remove("doc-A", "gone-1"), "ok", "révoqué → suppression directe (aucun force)");
      db.save("doc-A", "gone-2", { kind: "ssh-keypair", label: "Expiré", subject: "u@e", key_algo: "ed25519", not_after: "2020-01-01T00:00:00.000Z" });
      ck.eq(db.remove("doc-A", "gone-2"), "ok", "expiré → suppression directe (aucun force)");

      // -- SUIVI D'ÉCHÉANCES (matière C7) : non-révoqués porteurs de not_after, tous documents, triés. --
      db.save("doc-A", "exp-1", { kind: "ssh-keypair", label: "Paire A", subject: "u@a", key_algo: "ed25519", not_after: "2026-09-01T00:00:00.000Z" });
      db.save("doc-A", "exp-2", { kind: "ssh-keypair", label: "Paire B", subject: "u@b", key_algo: "ed25519", not_after: "2026-08-01T00:00:00.000Z" });
      db.save("doc-A", "exp-3", { kind: "ssh-keypair", label: "Paire C (révoquée)", subject: "u@c", key_algo: "ed25519", not_after: "2026-08-15T00:00:00.000Z", revoked_at: "2026-07-01T00:00:00.000Z" });
      db.save("doc-A", "exp-4", { kind: "ssh-keypair", label: "Paire D (sans échéance)", subject: "u@d", key_algo: "ed25519" });
      ck.eq(db.listExpiring().map((c) => c.id).join(","), "exp-2,exp-1", "listExpiring : non-révoqués avec not_after, triés par échéance (révoqué et sans date exclus)");
    } finally {
      if (raw) { try { raw.close(); } catch (_) {} }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  /* ============ SERVEUR : CertsDb — listing paginé (filtres/tris/recherche SQL, sous-arbre CTE, focus, agrégats) ============ */

  await section("Serveur : CertsDb.listPage/listRoots — pagination SQL, filtres, tris, recherche, sous-arbre (CTE), focus, agrégats racines, backfill search", async () => {
    // better-sqlite3 RÉEL requis (recursive CTE + window ROW_NUMBER) — même probe que les autres sections DB.
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probe = new Candidate(":memory:"); probe.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section listing CertsDb sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { CertsDb } = SERVER("certs/CertsDb.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-certs-page-"));
    let rawBackfill = null;
    const backfillDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-certs-bf-"));
    try {
      const db = new CertsDb(dir, Sqlite); // Logger "error" par défaut → silencieux
      const D = "D";
      const NOW = new Date("2026-07-15T12:00:00.000Z"); // horloge INJECTÉE (statuts/agrégats déterministes)
      const FUT = "2030-01-01T00:00:00.000Z";           // échéance lointaine (« active », hors seuils)
      const pad2 = (n) => String(n).padStart(2, "0");

      // -- PARC SYNTHÉTIQUE : 2 racines à dérivés (X.509 r1 / SSH r2), un arbre à 3 NIVEAUX
      //    (r1 → mid → leaf-deep, pour prouver la CTE récursive), et 3 premiers niveaux orphelins. --
      db.save(D, "r1", { kind: "root-ca", label: "Autorite X509", subject: "CN=X509 exemple", key_algo: "ec-p256", not_after: FUT, key_enc: "v1:aXY=:Y2lwaGVy" });
      db.save(D, "r2", { kind: "ssh-ca", label: "Autorite SSH", subject: "ca@exemple.test", key_algo: "ed25519", not_after: FUT });
      db.save(D, "r3", { kind: "root-ca", label: "Autorite vide", subject: "CN=vide", key_algo: "ec-p256", not_after: FUT });
      db.save(D, "k1", { kind: "ssh-keypair", label: "Paire orpheline", subject: "u1@exemple.test", key_algo: "ed25519" }); // sans échéance
      db.save(D, "k2", { kind: "ssh-keypair", label: "Cle isolee", subject: "u2@exemple.test", key_algo: "ed25519" });        // sans échéance
      // 12 feuilles TLS sous r1 (échéances variées : a01 expiré, a02/a03 sous seuil, a04 révoqué).
      const aDates = { a01: "2026-07-01T00:00:00.000Z", a02: "2026-07-20T00:00:00.000Z", a03: "2026-08-10T00:00:00.000Z", a04: "2026-07-25T00:00:00.000Z" };
      for (let i = 1; i <= 12; i++) {
        const id = "a" + pad2(i);
        const cert = { kind: "leaf-tls", parent_id: "r1", label: "Service " + pad2(i), subject: "CN=" + id + ".exemple.test", key_algo: "ec-p256", not_after: aDates[id] || FUT };
        if (id === "a04") cert.revoked_at = "2026-07-10T00:00:00.000Z";                       // révoqué
        if (id === "a05") cert.sans = [{ san_type: "dns", value: "trouvemoi.exemple.test" }]; // recherche par SAN
        if (id === "a06") cert.subject = "CN=café.exemple.test";                              // recherche accent-insensible
        db.save(D, id, cert);
      }
      db.save(D, "mid", { kind: "leaf-tls", parent_id: "r1", label: "Intermediaire", subject: "CN=mid.exemple.test", key_algo: "ec-p256", not_after: FUT });        // niveau 2
      db.save(D, "leaf-deep", { kind: "leaf-tls", parent_id: "mid", label: "Feuille profonde", subject: "CN=deep.exemple.test", key_algo: "ec-p256", not_after: FUT }); // niveau 3
      // 10 certificats SSH sous r2 (b01 sous seuil).
      for (let i = 1; i <= 10; i++) {
        const id = "b" + pad2(i);
        db.save(D, id, { kind: "ssh-cert", parent_id: "r2", label: "Hote " + pad2(i), subject: "host" + i + "@exemple.test", key_algo: "ed25519", not_after: id === "b01" ? "2026-07-25T00:00:00.000Z" : FUT });
      }
      // Parc = 5 premiers niveaux (r1,r2,r3,k1,k2) + 14 sous r1 (12 + mid + leaf-deep) + 10 sous r2 = 29.

      // -- PAGINATION : total / pages / clamp de page / plafond de pageSize. --
      const p10 = db.listPage(D, { now: NOW, pageSize: 10 });
      ck(p10.total === 29 && p10.pages === 3 && p10.page === 1 && p10.pageSize === 10 && p10.certificates.length === 10, "listPage : total 29, 3 pages, page 1 pleine (10)");
      const pClamp = db.listPage(D, { now: NOW, page: 99, pageSize: 10 });
      ck(pClamp.page === 3 && pClamp.certificates.length === 9, "listPage : page hors borne clampée à la dernière (9 restants)");
      const pCap = db.listPage(D, { now: NOW, pageSize: 500 });
      ck(pCap.pageSize === 200 && pCap.certificates.length === 29 && pCap.pages === 1, "listPage : pageSize plafonné à 200 (tout sur une page)");

      // -- RECHERCHE (colonne search dénormalisée, normSearch partagé) : label ET valeur de SAN, insensible casse/accents. --
      const qSan = db.listPage(D, { now: NOW, query: "trouvemoi" });
      ck(qSan.total === 1 && qSan.certificates[0].id === "a05", "query : trouve par VALEUR de SAN (a05)");
      const qCase = db.listPage(D, { now: NOW, query: "TROUVEMOI" });
      ck(qCase.total === 1 && qCase.certificates[0].id === "a05", "query : insensible à la casse (normSearch)");
      const qAccent = db.listPage(D, { now: NOW, query: "cafe" });
      ck(qAccent.total === 1 && qAccent.certificates[0].id === "a06", "query : insensible aux accents (« café » ↦ « cafe »)");

      // -- KINDS (IN) : familles filtrées, répétable. --
      ck.eq(db.listPage(D, { now: NOW, kinds: ["ssh-cert"], pageSize: 200 }).total, 10, "kinds : ssh-cert → 10");
      ck.eq(db.listPage(D, { now: NOW, kinds: ["root-ca"], pageSize: 200 }).total, 2, "kinds : root-ca → 2 (r1, r3)");
      ck.eq(db.listPage(D, { now: NOW, kinds: ["root-ca", "ssh-ca"], pageSize: 200 }).total, 3, "kinds : root-ca|ssh-ca → 3");

      // -- STATUS (horloge injectée) : active / revoked / expired / expiring. --
      ck.eq(db.listPage(D, { now: NOW, status: "active" }).total, 28, "status active : revoked_at IS NULL (28)");
      ck.eq(db.listPage(D, { now: NOW, status: "revoked" }).total, 1, "status revoked : revoked_at IS NOT NULL (a04)");
      ck.eq(db.listPage(D, { now: NOW, status: "expired" }).total, 1, "status expired : not_after < now, non révoqué (a01)");
      ck.eq(db.listPage(D, { now: NOW, status: "expiring" }).total, 3, "status expiring : now ≤ not_after ≤ now+30 j, non révoqué (a02, a03, b01)");

      // -- TRI not_after : NULL en DERNIER dans les DEUX sens. --
      const naAsc = db.listPage(D, { now: NOW, sort: "not_after", dir: "asc", pageSize: 200 });
      ck(naAsc.certificates[0].not_after === "2026-07-01T00:00:00.000Z" && naAsc.certificates[28].not_after === null, "sort not_after asc : plus proche en tête, NULL en fin");
      const naDesc = db.listPage(D, { now: NOW, sort: "not_after", dir: "desc", pageSize: 200 });
      ck(naDesc.certificates[0].not_after === FUT && naDesc.certificates[28].not_after === null, "sort not_after desc : plus lointaine en tête, NULL TOUJOURS en fin");

      // -- SOUS-ARBRE (root) : CTE récursive, racine EXCLUE, 3 niveaux traversés. --
      const sub = db.listPage(D, { now: NOW, root: "r1", pageSize: 200 });
      const subIds = sub.certificates.map((c) => c.id);
      ck(sub.total === 14 && subIds.includes("mid") && subIds.includes("leaf-deep") && !subIds.includes("r1"), "root=r1 : sous-arbre STRICT (14 : intermédiaire ET feuille profonde, racine exclue)");
      const subMid = db.listPage(D, { now: NOW, root: "mid", pageSize: 200 });
      ck(subMid.total === 1 && subMid.certificates[0].id === "leaf-deep", "root=mid : sous-arbre d'un niveau 2 → la seule feuille (mid exclu)");

      // -- root_id porté par CHAQUE dérivé (racine de l'arbre — top-down, NULL au premier niveau). --
      ck(sub.certificates.every((c) => c.root_id === "r1"), "root_id : tous les dérivés de r1 portent root_id = r1");
      ck.eq(sub.certificates.find((c) => c.id === "leaf-deep").root_id, "r1", "root_id : la feuille de niveau 3 remonte à la RACINE (r1), pas à l'intermédiaire");
      const full = db.listPage(D, { now: NOW, pageSize: 200 });
      ck.eq(full.certificates.find((c) => c.id === "r1").root_id, null, "root_id : premier niveau → null");
      ck.eq(full.certificates.find((c) => c.id === "b01").root_id, "r2", "root_id : dérivé SSH → r2");

      // -- FOCUS : matche les filtres → page qui le contient (paramètre page ignoré). --
      const foc = db.listPage(D, { now: NOW, root: "r1", sort: "label", dir: "asc", pageSize: 5, page: 1, focus: "a08" });
      ck(foc.page === 2 && foc.certificates.some((c) => c.id === "a08"), "focus (dans les filtres) : renvoie LA page de l'élément (a08 → page 2), page demandée ignorée");
      // Hors filtres → comportement normal (page demandée). Sous-arbre r1 : r2 n'y est pas.
      const focOut = db.listPage(D, { now: NOW, root: "r1", sort: "label", dir: "asc", pageSize: 5, page: 3, focus: "r2" });
      ck.eq(focOut.page, 3, "focus HORS filtres (r2 absent du sous-arbre) : page demandée conservée (3)");
      // Focus exclu par un filtre de statut (a04 révoqué, status=active) → page demandée conservée.
      const focStatus = db.listPage(D, { now: NOW, status: "active", sort: "label", dir: "asc", pageSize: 5, page: 2, focus: "a04" });
      ck(focStatus.page === 2 && !focStatus.certificates.some((c) => c.id === "a04"), "focus exclu par status (a04 révoqué) : page demandée conservée, a04 absent");

      // -- INVARIANT Q5 : aucun key_enc dans listPage (r1 en détient un). --
      const r1item = full.certificates.find((c) => c.id === "r1");
      ck(!Object.prototype.hasOwnProperty.call(r1item, "key_enc") && r1item.has_key === true, "INVARIANT Q5 : listPage n'expose PAS key_enc (has_key seul)");

      // -- AGRÉGATS RACINES (listRoots) : children_total / children_alert / next_expiry. --
      const roots = db.listRoots(D, { now: NOW, pageSize: 200 });
      ck(roots.total === 5 && roots.certificates.every((c) => c.parent_id === null), "listRoots : 5 premiers niveaux (parent_id NULL uniquement)");
      const R = (id) => roots.certificates.find((c) => c.id === id);
      ck(R("r1").children_total === 14 && R("r1").children_alert === 3 && R("r1").next_expiry === "2026-07-01T00:00:00.000Z", "agg r1 : 14 descendants, 3 sous seuil (a01/a02/a03), next_expiry = a01");
      ck(R("r2").children_total === 10 && R("r2").children_alert === 1 && R("r2").next_expiry === "2026-07-25T00:00:00.000Z", "agg r2 : 10 descendants, 1 sous seuil (b01), next_expiry = b01");
      ck(R("k1").children_total === 0 && R("k1").children_alert === 0 && R("k1").next_expiry === null, "agg k1 : paire orpheline (0 descendant, sans échéance → next_expiry null)");
      ck(R("r3").children_total === 0 && R("r3").next_expiry === FUT, "agg r3 : racine vide, next_expiry = SA propre échéance");
      // Tri par children_total desc : les deux CA à dérivés en tête.
      const rootsByChildren = db.listRoots(D, { now: NOW, sort: "children_total", dir: "desc", pageSize: 200 });
      ck(rootsByChildren.certificates[0].id === "r1" && rootsByChildren.certificates[1].id === "r2", "listRoots sort children_total desc : r1 (14) puis r2 (10) en tête");

      db.close();

      // -- BACKFILL de la colonne search sur une base PRÉ-EXISTANTE (créée SANS la colonne, pattern migration
      //    ProviderConfigDb) : à la réouverture, ensureColumn ajoute `search` puis le backfill le recalcule. --
      const legacy = new Sqlite(path.join(backfillDir, "certs.db"));
      legacy.exec(`CREATE TABLE certificates (
        id TEXT NOT NULL, doc_id TEXT NOT NULL, kind TEXT NOT NULL, parent_id TEXT, label TEXT NOT NULL,
        subject TEXT NOT NULL, serial TEXT, not_before TEXT, not_after TEXT, fingerprint TEXT, key_algo TEXT NOT NULL,
        public_pem TEXT, key_enc TEXT, revoked_at TEXT, created_date TEXT NOT NULL, updated_date TEXT NOT NULL,
        PRIMARY KEY (doc_id, id), FOREIGN KEY (doc_id, parent_id) REFERENCES certificates(doc_id, id))`);
      legacy.exec(`CREATE TABLE certificate_sans (
        doc_id TEXT NOT NULL, cert_id TEXT NOT NULL, position INTEGER NOT NULL, san_type TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (doc_id, cert_id, position),
        FOREIGN KEY (doc_id, cert_id) REFERENCES certificates(doc_id, id) ON DELETE CASCADE)`);
      legacy.prepare("INSERT INTO certificates (id,doc_id,kind,parent_id,label,subject,serial,not_before,not_after,fingerprint,key_algo,public_pem,key_enc,revoked_at,created_date,updated_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("legacy-1", "OLD", "root-ca", null, "Ancien", "CN=ancien.exemple.test", "0A", null, null, null, "ec-p256", null, null, null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
      legacy.prepare("INSERT INTO certificate_sans (doc_id,cert_id,position,san_type,value) VALUES (?,?,?,?,?)")
        .run("OLD", "legacy-1", 0, "dns", "backfilled.exemple.test");
      const colsBefore = legacy.prepare("PRAGMA table_info(certificates)").all().map((c) => c.name);
      ck(!colsBefore.includes("search"), "backfill : base à l'ANCIEN schéma, SANS colonne search (état de départ)");
      legacy.close();

      const migDb = new CertsDb(backfillDir, Sqlite);
      rawBackfill = new Sqlite(path.join(backfillDir, "certs.db"));
      ck(rawBackfill.prepare("PRAGMA table_info(certificates)").all().map((c) => c.name).includes("search"), "backfill : réouverture → colonne search AJOUTÉE (ensureColumn idempotent)");
      const bfSan = migDb.listPage("OLD", { query: "backfilled" });
      ck(bfSan.total === 1 && bfSan.certificates[0].id === "legacy-1", "backfill : search recalculé DEPUIS le SAN de la ligne préexistante (query « backfilled » → legacy-1)");
      const bfLabel = migDb.listPage("OLD", { query: "ancien" });
      ck(bfLabel.total === 1 && bfLabel.certificates[0].id === "legacy-1", "backfill : search recalculé depuis le label (query « ancien » → legacy-1)");
      migDb.close();
    } finally {
      if (rawBackfill) { try { rawBackfill.close(); } catch (_) {} }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(backfillDir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  /* ============ SERVEUR : CertExpiryWatcher (producteur cert-expiry — seuils Q6, raise/resolve) ============ */

  await section("Serveur : CertExpiryWatcher — seuils 30/14/7, gravité croissante, renouvellement, disparition", async () => {
  {
    const { CertExpiryWatcher } = SERVER("certs/CertExpiryWatcher.js");
    const DAY = 86400000;
    const nowMs = Date.parse("2026-07-14T12:00:00.000Z");
    const clock = () => new Date(nowMs);
    const at = (days) => new Date(nowMs + days * DAY).toISOString();
    // Rapporteur stub : journal des appels ; source stub : parc mutable.
    const calls = [];
    const reporter = { raise: (key, event) => calls.push({ op: "raise", key, event }), resolve: (key) => calls.push({ op: "resolve", key }) };
    const parc = [];
    const watcher = new CertExpiryWatcher({ listExpiring: () => parc.slice() }, reporter, clock);

    ck.eq(CertExpiryWatcher.DEFAULT_THRESHOLDS_DAYS.join("/"), "30/14/7", "seuils globaux par défaut = 30/14/7 jours (décision Q6)");
    ck.eq(CertExpiryWatcher.keyFor("doc-A", "cert-1"), "cert-expiry:doc-A:cert-1", "clé stable cert-expiry:<docId>:<certId>");

    // -- Gravité CROISSANTE selon la proximité de l'échéance. --
    parc.push(
      { doc_id: "doc-A", id: "loin", label: "Loin", kind: "leaf-tls", not_after: at(60) },       // hors seuil → resolve
      { doc_id: "doc-A", id: "j25", label: "J-25", kind: "leaf-tls", not_after: at(25.5) },      // ≤ 30 → info
      { doc_id: "doc-A", id: "j10", label: "J-10", kind: "root-ca", not_after: at(10.5) },       // ≤ 14 → warning
      { doc_id: "doc-A", id: "j3", label: "J-3", kind: "leaf-tls", not_after: at(3.5) },         // ≤ 7 → error
      { doc_id: "doc-B", id: "mort", label: "Expiré", kind: "ssh-cert", not_after: at(-2) },     // expiré → error
    );
    const bilan = watcher.scan();
    ck(bilan.raised === 4 && bilan.resolved === 1, "passe : 4 alertes levées, 1 clôture (hors seuil)");
    const byId = (id) => calls.find((c) => c.op === "raise" && c.key.endsWith(":" + id));
    ck.eq(byId("j25").event.severity, "info", "J-25 → info (seuil 30)");
    ck.eq(byId("j10").event.severity, "warning", "J-10 → warning (seuil 14)");
    ck.eq(byId("j3").event.severity, "error", "J-3 → error (seuil 7)");
    ck.eq(byId("mort").event.severity, "error", "expiré → error");
    ck(/expiré/.test(byId("mort").event.title) && /J-3/.test(byId("j3").event.title), "titres : « expiré » vs « J-n »");
    ck(byId("j10").event.event_type === "cert-expiry" && byId("j10").event.doc_id === "doc-A", "événement : type cert-expiry + doc_id porté");
    ck(calls.some((c) => c.op === "resolve" && c.key === "cert-expiry:doc-A:loin"), "hors seuil → resolve (no-op moteur si jamais levée)");

    // -- Idempotence par passe : re-scan identique → mêmes raise (l'anti-spam vit dans le moteur notify). --
    calls.length = 0;
    watcher.scan();
    ck.eq(calls.filter((c) => c.op === "raise").length, 4, "re-scan → raise re-signalés (idempotents côté moteur)");

    // -- RENOUVELLEMENT : not_after repoussée hors seuil → resolve. --
    calls.length = 0;
    parc.find((c) => c.id === "j3").not_after = at(400);
    watcher.scan();
    ck(calls.some((c) => c.op === "resolve" && c.key === "cert-expiry:doc-A:j3"), "renouvellement (échéance repoussée) → alerte close");

    // -- DISPARITION (suppression/révocation → sort de listExpiring) : resolve via le jeu mémoire, une fois. --
    calls.length = 0;
    const index = parc.findIndex((c) => c.id === "mort");
    parc.splice(index, 1);
    watcher.scan();
    ck(calls.some((c) => c.op === "resolve" && c.key === "cert-expiry:doc-B:mort"), "certificat disparu → alerte close (jeu mémoire des clés levées)");
    calls.length = 0;
    watcher.scan();
    ck.eq(calls.filter((c) => c.op === "resolve" && c.key === "cert-expiry:doc-B:mort").length, 0, "…une seule fois (clé oubliée après clôture)");

    // -- Bordure : J-30 pile → info (≤ seuil), J-31 → resolve. --
    calls.length = 0;
    parc.length = 0;
    parc.push({ doc_id: "doc-C", id: "pile", label: "Pile", kind: "leaf-tls", not_after: at(30.2) });   // floor → 30
    parc.push({ doc_id: "doc-C", id: "au-dela", label: "Au-delà", kind: "leaf-tls", not_after: at(31.2) }); // floor → 31
    watcher.scan();
    ck(calls.some((c) => c.op === "raise" && c.key.endsWith(":pile") && c.event.severity === "info"), "J-30 pile → info (inclusif)");
    ck(calls.some((c) => c.op === "resolve" && c.key.endsWith(":au-dela")), "J-31 → hors seuil (resolve)");
  }
  });

  /* ============ SERVEUR : ProviderConfigDb (stockage DB des providers, better-sqlite3 RÉEL) ============ */

  await section("Serveur : ProviderConfigDb — schéma, CRUD sans fuite de jeton, cascade, providersFor, jeton indéchiffrable, migration legacy", async () => {
    // better-sqlite3 RÉEL requis (binaire natif) — même probe que les autres sections DB.
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probe = new Candidate(":memory:"); probe.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section ProviderConfigDb sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { ProviderConfigDb } = SERVER("vm/ProviderConfigDb.js");
    const { SecretBox } = SERVER("SecretBox.js");
    const { ProviderConfigError } = SERVER("vm/ProviderConfigValidate.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-vmdb-"));
    let raw = null;
    try {
      const box = new SecretBox("passphrase-infra-longue-de-test");
      const db = new ProviderConfigDb(dir, Sqlite, box); // Logger "error" par défaut → silencieux

      // -- SCHÉMA : fichier matérialisé, tables créées (introspection via une connexion brute). --
      ck(fs.existsSync(path.join(dir, "vm-providers.db")), "vm-providers.db matérialisé dans le dossier injecté");
      raw = new Sqlite(path.join(dir, "vm-providers.db"));
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
      ck(tables.includes("vm_providers") && tables.includes("vm_provider_endpoints"), "schéma : tables vm_providers + vm_provider_endpoints créées");

      // -- save (création) : pool ordonné + jeton fourni ; réponse SANS jeton. --
      const fpA = Array(32).fill("AA").join(":");
      const saved = db.save("doc-A", { id: "pve-1", kind: "proxmox", urls: [{ url: "https://pve1:8006", fingerprint: fpA }, "https://pve2:8006"], include_lxc: false, interval_sec: 300 }, "root@pam!t=SECRET-1");
      ck(saved.id === "pve-1" && saved.endpoints.length === 2, "save (création) → item renvoyé, 2 endpoints");
      ck.eq(saved.include_lxc, false, "save : include_lxc explicite conservé");
      ck.eq(saved.has_token, true, "save : has_token = true");
      ck.eq(saved.ca_pem, null, "save (sans ca_pem) : ca_pem null par défaut (CA système)");
      ck(!("token" in saved) && !("token_enc" in saved) && !JSON.stringify(saved).includes("SECRET-1"), "save : réponse SANS jeton (ni clair ni chiffré)");

      // -- listFor : SANS jeton, has_token true, pool ordonné avec empreinte par nœud. --
      const list = db.listFor("doc-A");
      ck(list.length === 1 && list[0].id === "pve-1", "listFor → 1 provider");
      ck(!("token" in list[0]) && !("token_enc" in list[0]) && list[0].has_token === true, "listFor : jeton JAMAIS renvoyé (has_token: true seulement)");
      ck(list[0].endpoints[0].url === "https://pve1:8006" && list[0].endpoints[0].fingerprint === fpA && list[0].endpoints[1].fingerprint === null, "listFor : pool ordonné, empreinte par nœud (2e sans épinglage)");
      // Le jeton est CHIFFRÉ en DB (colonne token_enc, format v1:) — jamais le clair.
      const encRow = raw.prepare("SELECT token_enc, ca_pem FROM vm_providers WHERE doc_id=? AND id=?").get("doc-A", "pve-1");
      ck(/^v1:/.test(encRow.token_enc) && !encRow.token_enc.includes("SECRET-1"), "DB : jeton stocké CHIFFRÉ (v1:…), jamais en clair");
      ck.eq(encRow.ca_pem, null, "DB : ca_pem absent à la création → colonne NULL (CA système)");

      // -- providersFor : déchiffre → ProviderConfig utilisable pour la synchro. --
      const forSync = db.providersFor("doc-A");
      ck(forSync.length === 1 && forSync[0].token === "root@pam!t=SECRET-1", "providersFor : jeton DÉCHIFFRÉ (ProviderConfig utilisable)");
      ck(forSync[0].endpoints.length === 2 && forSync[0].include_lxc === false && forSync[0].interval_sec === 300, "providersFor : endpoints + champs restitués");
      ck.eq(forSync[0].ca_pem, null, "providersFor : ca_pem null restitué (pas de CA cluster)");
      ck.eq(db.configuredDocIds().join(","), "doc-A", "configuredDocIds → documents configurés");

      // -- ca_pem (CA du cluster, PUBLIQUE) : ROUNDTRIP save → listFor + providersFor + colonne DB. --
      const caPem = "-----BEGIN CERTIFICATE-----\nMIIB...FAUX-CA-TEST...\n-----END CERTIFICATE-----";
      const savedCa = db.save("doc-A", { id: "pve-ca", kind: "proxmox", url: "https://pveca:8006", ca_pem: caPem }, "root@pam!t=CA-1");
      ck.eq(savedCa.ca_pem, caPem, "save (avec ca_pem) : réponse porte la CA (publique — pas de réserve)");
      ck.eq(db.listFor("doc-A").find((p) => p.id === "pve-ca").ca_pem, caPem, "listFor : ca_pem RENVOYÉ (public), contrairement au jeton");
      ck.eq(db.providersFor("doc-A").find((p) => p.id === "pve-ca").ca_pem, caPem, "providersFor : ca_pem restitué pour la synchro (PveHttpPool le passe à PveHttp)");
      ck.eq(raw.prepare("SELECT ca_pem FROM vm_providers WHERE doc_id=? AND id=?").get("doc-A", "pve-ca").ca_pem, caPem, "DB : ca_pem PERSISTÉ en clair (certificat public)");
      // Édition qui RETIRE la CA (ca_pem null) → colonne remise à NULL.
      db.save("doc-A", { id: "pve-ca", kind: "proxmox", url: "https://pveca:8006", ca_pem: null }, null);
      ck.eq(db.listFor("doc-A").find((p) => p.id === "pve-ca").ca_pem, null, "save (édition, ca_pem null) : CA retirée (colonne remise à NULL)");
      db.remove("doc-A", "pve-ca");

      // -- management_url (URL du PDM, PUBLIQUE) : ROUNDTRIP save → listFor + providersFor + colonne DB, puis retrait. --
      const mgmtUrl = "https://pdm.exemple.lan:8443";
      const savedMgmt = db.save("doc-A", { id: "pve-mgmt", kind: "proxmox", url: "https://pvem:8006", management_url: mgmtUrl }, "root@pam!t=MGMT-1");
      ck.eq(savedMgmt.management_url, mgmtUrl, "save (avec management_url) : réponse porte l'URL (publique — pas de réserve)");
      ck.eq(db.listFor("doc-A").find((p) => p.id === "pve-mgmt").management_url, mgmtUrl, "listFor : management_url RENVOYÉ (public), comme ca_pem");
      ck.eq(db.providersFor("doc-A").find((p) => p.id === "pve-mgmt").management_url, mgmtUrl, "providersFor : management_url restitué (l'adaptateur le recopie dans VmClusterInfo)");
      ck.eq(raw.prepare("SELECT management_url FROM vm_providers WHERE doc_id=? AND id=?").get("doc-A", "pve-mgmt").management_url, mgmtUrl, "DB : management_url PERSISTÉ en clair (URL publique)");
      // Édition qui RETIRE l'URL (management_url null) → colonne remise à NULL.
      db.save("doc-A", { id: "pve-mgmt", kind: "proxmox", url: "https://pvem:8006", management_url: null }, null);
      ck.eq(db.listFor("doc-A").find((p) => p.id === "pve-mgmt").management_url, null, "save (édition, management_url null) : URL retirée (colonne remise à NULL)");
      db.remove("doc-A", "pve-mgmt");

      // -- save (édition, token vide → CONSERVÉ) : change interval, pool remplacé, jeton inchangé. --
      const upd = db.save("doc-A", { id: "pve-1", kind: "proxmox", url: "https://pve1:8006", interval_sec: 600 }, null);
      ck.eq(upd.interval_sec, 600, "save (édition) : champ mis à jour");
      ck.eq(upd.endpoints.length, 1, "save (édition) : pool REMPLACÉ (1 endpoint)");
      ck.eq(db.providersFor("doc-A")[0].token, "root@pam!t=SECRET-1", "save (édition, token vide) : jeton EXISTANT conservé");

      // -- save (création SANS jeton) → ProviderConfigError « token requis ». --
      let noTokenErr = null;
      try { db.save("doc-A", { id: "pve-new", kind: "proxmox", url: "https://x:8006" }, null); } catch (e) { noTokenErr = e; }
      ck(noTokenErr instanceof ProviderConfigError && noTokenErr.issues.some((m) => /token/.test(m)), "save (création sans jeton) → ProviderConfigError « token requis »");

      // -- save invalide (url manquante) → ProviderConfigError, jeton jamais divulgué. --
      let invalidErr = null;
      try { db.save("doc-A", { id: "pve-bad", kind: "proxmox" }, "root@pam!t=NOPE"); } catch (e) { invalidErr = e; }
      ck(invalidErr instanceof ProviderConfigError && invalidErr.issues.some((m) => /url/.test(m)) && !invalidErr.message.includes("NOPE"), "save invalide → ProviderConfigError (url), jeton jamais dans le message");

      // -- remove + CASCADE endpoints (FK ON DELETE CASCADE, PRAGMA foreign_keys=ON). --
      db.save("doc-A", { id: "pve-2", kind: "proxmox", urls: ["https://a:8006", "https://b:8006"] }, "t@pam!x=U2");
      ck.eq(raw.prepare("SELECT COUNT(*) n FROM vm_provider_endpoints WHERE provider_id=?").get("pve-2").n, 2, "avant remove : 2 endpoints pour pve-2");
      ck.eq(db.remove("doc-A", "pve-2"), true, "remove → true");
      ck.eq(raw.prepare("SELECT COUNT(*) n FROM vm_provider_endpoints WHERE provider_id=?").get("pve-2").n, 0, "remove : endpoints PURGÉS par cascade FK");
      ck.eq(db.remove("doc-A", "inexistant"), false, "remove (id inconnu) → false");

      // -- Jeton INDÉCHIFFRABLE (coffre à AUTRE clé) → provider EXCLU + erreur consultable. --
      const otherBox = new SecretBox("une-toute-autre-passphrase-de-test");
      const db2 = new ProviderConfigDb(dir, Sqlite, otherBox);
      ck.eq(db2.providersFor("doc-A").length, 0, "jeton indéchiffrable (autre clé) → provider EXCLU de la synchro");
      const errs = db2.tokenErrorsFor("doc-A");
      ck(errs.length === 1 && errs[0].id === "pve-1" && /ressaisi/.test(errs[0].message) && !errs[0].message.includes("SECRET-1"), "…erreur MÉMORISÉE consultable (id + « à ressaisir »), sans le jeton");
      db2.close();

      // -- MIGRATION legacy : vm-providers.json → DB + renommage + idempotence au 2e démarrage. --
      const migDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-vmmig-"));
      fs.writeFileSync(path.join(migDir, "vm-providers.json"), JSON.stringify({
        "doc-M": { docName: "infra", providers: [{ id: "pve-m", kind: "proxmox", url: "https://m:8006", token: "root@pam!t=MIG-SECRET" }] },
      }), "utf8");
      const migDb = new ProviderConfigDb(migDir, Sqlite, box);
      const r1 = migDb.importLegacyFile();
      ck(r1.importedProviders === 1 && r1.skipped === false, "migration : 1 provider importé depuis le fichier");
      ck.eq(migDb.providersFor("doc-M")[0].token, "root@pam!t=MIG-SECRET", "migration : jeton chiffré en DB puis déchiffrable (aller-retour)");
      ck(!fs.existsSync(path.join(migDir, "vm-providers.json")), "migration : fichier legacy RENOMMÉ (plus jamais relu)");
      ck(!!fs.readdirSync(migDir).find((f) => f.startsWith("vm-providers.json.imported-")), "migration : renommé en vm-providers.json.imported-<date>");
      // 2e démarrage (fichier déjà renommé → absent) → no-op idempotent.
      const r2 = migDb.importLegacyFile();
      ck(r2.skipped === true && r2.importedProviders === 0, "migration : 2e démarrage → no-op (fichier absent)");
      ck.eq(migDb.providersFor("doc-M").length, 1, "migration : toujours 1 provider (pas de doublon)");
      // Robustesse : fichier legacy RÉAPPARU dont le doc est DÉJÀ en DB → ignoré (jeton ressaisi préservé), renommé quand même.
      fs.writeFileSync(path.join(migDir, "vm-providers.json"), JSON.stringify({ "doc-M": { providers: [{ id: "pve-m", kind: "proxmox", url: "https://m:8006", token: "root@pam!t=AUTRE" }] } }), "utf8");
      const r3 = migDb.importLegacyFile();
      ck(r3.importedProviders === 0 && r3.skipped === false, "migration : doc DÉJÀ en DB → aucun import (pas d'écrasement)");
      ck.eq(migDb.providersFor("doc-M")[0].token, "root@pam!t=MIG-SECRET", "…jeton d'origine préservé (le fichier réapparu n'écrase pas la DB)");
      migDb.close();
      try { fs.rmSync(migDir, { recursive: true, force: true }); } catch (_) { /* dossier temp */ }

      // -- MIGRATION DE COLONNE (management_url) : une base à l'ANCIEN schéma (sans la colonne) est
      //    rouverte → la colonne est AJOUTÉE (ALTER idempotent), données INTACTES. Des vm-providers.db
      //    existent DÉJÀ chez l'utilisateur, d'où ce test dédié (parité migrations DocumentStore). --
      const migColDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-vmcol-"));
      try {
        // 1) Base à l'ANCIEN schéma (colonnes d'avant management_url) + 1 provider (jeton chiffré) + endpoint.
        const old = new Sqlite(path.join(migColDir, "vm-providers.db"));
        old.exec(`CREATE TABLE vm_providers (
          doc_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, token_enc TEXT NOT NULL,
          include_lxc INTEGER NOT NULL DEFAULT 1, interval_sec INTEGER NOT NULL DEFAULT 0,
          timeout_sec INTEGER NOT NULL DEFAULT 15, ca_pem TEXT,
          created_date TEXT NOT NULL, updated_date TEXT NOT NULL, PRIMARY KEY (doc_id, id))`);
        old.exec(`CREATE TABLE vm_provider_endpoints (
          doc_id TEXT NOT NULL, provider_id TEXT NOT NULL, position INTEGER NOT NULL, url TEXT NOT NULL, fingerprint TEXT,
          PRIMARY KEY (doc_id, provider_id, position),
          FOREIGN KEY (doc_id, provider_id) REFERENCES vm_providers(doc_id, id) ON DELETE CASCADE ON UPDATE CASCADE)`);
        old.prepare("INSERT INTO vm_providers (doc_id,id,kind,token_enc,include_lxc,interval_sec,timeout_sec,ca_pem,created_date,updated_date) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run("doc-OLD", "pve-old", "proxmox", box.encrypt("root@pam!t=OLD-SECRET"), 1, 0, 15, null, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
        old.prepare("INSERT INTO vm_provider_endpoints (doc_id,provider_id,position,url,fingerprint) VALUES (?,?,?,?,?)")
          .run("doc-OLD", "pve-old", 0, "https://old:8006", null);
        const colsBefore = old.prepare("PRAGMA table_info(vm_providers)").all().map((c) => c.name);
        ck(!colsBefore.includes("management_url"), "migration colonne : base à l'ANCIEN schéma, SANS management_url (état de départ)");
        old.close();

        // 2) Réouverture via ProviderConfigDb → la migration idempotente AJOUTE la colonne, données intactes.
        const migColDb = new ProviderConfigDb(migColDir, Sqlite, box);
        const rawCol = new Sqlite(path.join(migColDir, "vm-providers.db"));
        const colsAfter = rawCol.prepare("PRAGMA table_info(vm_providers)").all().map((c) => c.name);
        ck(colsAfter.includes("management_url"), "migration colonne : réouverture → colonne management_url AJOUTÉE (ALTER idempotent)");
        const item = migColDb.listFor("doc-OLD")[0];
        ck(!!item && item.id === "pve-old" && item.endpoints.length === 1 && item.endpoints[0].url === "https://old:8006", "migration colonne : provider + endpoint INTACTS après migration");
        ck.eq(item.management_url, null, "migration colonne : lignes préexistantes → management_url null (colonne ajoutée sans valeur)");
        ck.eq(migColDb.providersFor("doc-OLD")[0].token, "root@pam!t=OLD-SECRET", "migration colonne : jeton toujours déchiffrable (données intactes)");
        // Après migration, l'URL de management s'écrit et se relit normalement.
        migColDb.save("doc-OLD", { id: "pve-old", kind: "proxmox", url: "https://old:8006", management_url: "https://pdm.old:8443" }, null);
        ck.eq(migColDb.listFor("doc-OLD")[0].management_url, "https://pdm.old:8443", "migration colonne : après migration, management_url s'écrit puis se relit");
        rawCol.close();
        migColDb.close();
      } finally {
        try { fs.rmSync(migColDir, { recursive: true, force: true }); } catch (_) { /* dossier temp */ }
      }

      db.close();
    } finally {
      try { if (raw) raw.close(); } catch (_) { /* déjà fermé */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* dossier temp (handles longs sous Windows) */ }
    }
  });

  /* ============ SERVEUR : VmSyncService (bout en bout — DocumentStore réel, adaptateur stub) ============ */

  await section("Serveur : VmSyncService — synchro de bout en bout (écritures, rev, SSE, statut)", async () => {
    // Même probe que la section Repository/DocumentStore : better-sqlite3 RÉEL requis (binaire natif).
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probeDb = new Candidate(":memory:"); probeDb.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section VmSyncService sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { DocumentStore } = SERVER("documents.js");
    const { VmSyncService } = SERVER("vm/VmSyncService.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-vmsync-"));
    try {
      const docs = new DocumentStore(dir, Sqlite);
      const doc = docs.create("infra-test");
      const repo = docs.repo(doc.id);
      // Équipements hôtes : « pve1 » = correspondance EXACTE ; « pve9.int.exemple.com » =
      // correspondance par FQDN (1er label) — les nœuds Proxmox portent un nom court.
      repo.transact({ creates: [
        { collection: "equipments", record: { id: "eq-pve1", name: "pve1" } },
        { collection: "equipments", record: { id: "eq-pve9", name: "pve9.int.exemple.com" } },
      ] }, docs.markChanged(doc.id));

      // Config par document (amendement 2026-07-13) : écrite APRÈS création du doc (docId connu).
      fs.writeFileSync(path.join(dir, "vm-providers.json"), JSON.stringify({
        [doc.id]: { docName: "infra-test", providers: [
          { id: "pve-test", kind: "proxmox", url: "https://pve:8006", token: "sync@pve!t=U", interval_sec: 0 },
        ] },
      }), "utf8");
      const { ProviderConfigStore } = SERVER("vm/ProviderConfigStore.js");
      const providers = new ProviderConfigStore(dir);

      // Adaptateur STUB : inventaire mutable (le scénario le fait évoluer), et bus live capturé.
      // `cluster` (produit dans la même passe) est FOURNI mais IGNORÉ par la synchro (capture = C2) —
      // sa présence vérifie seulement que le nouveau contrat inventory() est bien consommé.
      let vmsFixture = [
        { ext_id: "prod/100", provider_id: "pve-test", vm_type: "qemu", name: "web01", description: "front", status: "running",
          host_node: "pve1", cpu: 4, ram_mb: 4096, disk_gb: 32, tags: ["prod"],
          nics: [{ name: "net0", mac: "AA:BB:CC:DD:EE:FF", bridge: "vmbr0", vlan_tag: 42, ips: ["192.168.1.10"] }] },
        { ext_id: "prod/101", provider_id: "pve-test", vm_type: "lxc", name: "db01", description: "", status: "stopped",
          host_node: "pve9", cpu: 2, ram_mb: 2048, disk_gb: null, tags: [], nics: [] },
      ];
      const clusterFixture = { name: "prod-cluster", version: "8.4.1", supported: true, quorate: true,
        nodes: [{ name: "pve1", online: true, cpu_used: 0.1, cpu_total: 8, mem_used_mb: 2048, mem_total_mb: 16384, uptime_sec: 3600 }] };
      let failInventory = false;
      const makeAdapter = (config) => ({
        kind: config.kind, config,
        test: async () => ({ ok: true, kind: config.kind, version: "8.4.1", supported: true, message: "" }),
        inventory: async () => { if (failInventory) throw new Error("Proxmox : délai dépassé (15000 ms) sur /api2/json/cluster/resources"); return { vms: vmsFixture, cluster: clusterFixture }; },
      });
      const live = { events: [], publish(docId, data) { this.events.push({ docId, data }); } };
      // minIntervalSec 0 : l'anti-rafale est neutralisé pour dérouler le scénario sans attendre
      // (il a son propre test dédié ci-dessous).
      const service = new VmSyncService(docs, live, providers, undefined, makeAdapter, 0);

      // 1) Première synchro : 2 créations, hôte résolu, rev consommée, SSE ciblé « vms ».
      const revBefore = docs.getRev(doc.id);
      const r1 = await service.syncDocument(doc.id);
      ck(r1.length === 1 && r1[0].ok === true, "synchro OK (1 provider)");
      ck.eq(r1[0].counts.created, 2, "2 vms créées");
      const stored = repo.findBy("vms", "provider_id", "pve-test");
      ck.eq(stored.length, 2, "2 vms persistées dans le document");
      const web = stored.find((v) => v.name === "web01");
      ck.eq(web.host_equipment_id, "eq-pve1", "hôte résolu par nom EXACT (nœud pve1)");
      ck.eq(stored.find((v) => v.name === "db01").host_equipment_id, "eq-pve9", "hôte résolu par FQDN : nœud court « pve9 » ↔ équipement « pve9.int.exemple.com »");
      ck(docs.getRev(doc.id) > revBefore, "révision du document consommée par l'écriture");
      ck.eq(live.events.length, 1, "1 événement SSE publié");
      ck(live.events[0].data.changeset.collections.join(",") === "vms" && live.events[0].data.origin === "vm-sync",
        "changeset ciblé sur `vms` + origin vm-sync (tous les clients rechargent)");

      // 2) Re-synchro à l'identique : IDEMPOTENTE de bout en bout (ni rev, ni SSE).
      const revAfter1 = docs.getRev(doc.id);
      const r2 = await service.syncDocument(doc.id);
      ck(r2[0].ok === true && r2[0].counts.unchanged === 2, "re-synchro : 2 inchangées");
      ck.eq(docs.getRev(doc.id), revAfter1, "aucune révision consommée (pas de bruit)");
      ck.eq(live.events.length, 1, "aucun événement SSE supplémentaire");

      // 3) Enrichissement local + changement source : les locaux survivent, le source est écrasé.
      repo.transact({ updates: [{ collection: "vms", record: { ...web, notes: "ma note", host_equipment_id: "eq-pve1" } }] }, docs.markChanged(doc.id));
      vmsFixture = [{ ...vmsFixture[0], status: "stopped" }, vmsFixture[1]];
      await service.syncDocument(doc.id);
      const webAfter = repo.getOne("vms", web.id);
      ck.eq(webAfter.status, "stopped", "champ SOURCE écrasé par la synchro (statut)");
      ck.eq(webAfter.notes, "ma note", "champ LOCAL préservé (note utilisateur)");

      // 4) VM disparue → orpheline (jamais supprimée) ; statut : compteur orphaned.
      vmsFixture = [vmsFixture[0]];   // db01 disparaît
      const r4 = await service.syncDocument(doc.id);
      ck.eq(r4[0].counts.orphaned, 1, "1 vm orpheline comptée");
      const db01 = repo.findBy("vms", "provider_id", "pve-test").find((v) => v.name === "db01");
      ck(!!db01 && db01.orphan === true, "vm disparue → orphan:true, toujours persistée (jamais delete)");

      // 4bis) CAPTURE CLUSTER (C2, cadrage vue Clusters) : l'état du cluster accompagne le statut.
      const stBefore = service.statusFor(doc.id)[0];
      ck(!!stBefore.cluster && stBefore.cluster.name === "prod-cluster" && stBefore.cluster.version === "8.4.1",
        "statut porteur du DERNIER état de cluster (nom + version)");
      ck(stBefore.cluster.quorate === true && stBefore.cluster.nodes.length === 1
        && stBefore.cluster.nodes[0].name === "pve1" && stBefore.cluster.nodes[0].online === true,
        "…avec quorum et nœuds/métriques capturés à la synchro");

      // 5) Inventaire en ÉCHEC : statut en erreur, document INTACT, last_success conservé.
      failInventory = true;
      const revBeforeFail = docs.getRev(doc.id);
      const r5 = await service.syncDocument(doc.id);
      ck(r5[0].ok === false && /délai dépassé/.test(r5[0].message), "échec d'inventaire → statut en erreur (message réseau)");
      ck(r5[0].last_success !== null, "last_success conservé malgré l'échec");
      ck(!!r5[0].cluster && r5[0].cluster.name === "prod-cluster", "dernier état de cluster CONSERVÉ malgré l'échec (comme last_success)");
      ck.eq(docs.getRev(doc.id), revBeforeFail, "document intact après échec (aucune écriture)");
      ck.eq(repo.findBy("vms", "provider_id", "pve-test").length, 2, "les vms existantes survivent à l'échec");
      failInventory = false;

      // 6) statusFor : fusion config déclarée × runtime + document non configuré → [].
      const st = service.statusFor(doc.id);
      ck(st.length === 1 && st[0].provider_id === "pve-test" && st[0].interval_sec === 0, "statusFor → état du provider configuré");
      ck.eq(service.statusFor("doc-inexistant").length, 0, "document non configuré → aucun provider (feature dormante)");

      // 7) AUTORITÉ SERVEUR : un inventaire invalide (nom vide → spec `name` requis) est REFUSÉ en bloc.
      vmsFixture = [{ ...vmsFixture[0], ext_id: "prod/999", name: "" }];
      const r7 = await service.syncDocument(doc.id);
      ck(r7[0].ok === false && /invalide/.test(r7[0].message), "données provider invalides → écriture refusée (validation partagée)");
      ck(!repo.findBy("vms", "provider_id", "pve-test").some((v) => v.ext_id === "prod/999"), "…et rien n'a été écrit (pas d'écriture partielle)");

      // 8) Inventaire VIDE : suspect → le statut l'EXPLIQUE (piège de la séparation de privilèges
      //    des jetons Proxmox : l'API filtre par permissions et renvoie [] SANS erreur).
      vmsFixture = [];
      const r8 = await service.syncDocument(doc.id);
      ck(r8[0].ok === true, "inventaire vide : pas une erreur (cluster potentiellement vide)");
      ck(/AUCUNE VM remontée/.test(r8[0].message) && /jeton/i.test(r8[0].message) && /PVEAuditor/.test(r8[0].message),
        "…mais le statut explique le piège des permissions du JETON (privsep)");
      const web8 = repo.findBy("vms", "provider_id", "pve-test").find((v) => v.name === "web01");
      ck(!!web8 && web8.orphan === true, "…et les vms du document passent orphelines (jamais supprimées — réversible)");

      // 9) ANTI-RAFALE : avec un délai minimal, une relance immédiate NE déclenche PAS de
      //    nouvelle passe (deux clics quasi simultanés = une seule synchro).
      let adapterCalls = 0;
      const countingAdapter = (config) => ({ kind: config.kind, config,
        test: async () => ({ ok: true, kind: config.kind, version: "8.4.1", supported: true, message: "" }),
        inventory: async () => { adapterCalls++; return { vms: [], cluster: { name: config.id, version: null, supported: false, quorate: null, nodes: [] } }; } });
      const throttled = new VmSyncService(docs, live, providers, undefined, countingAdapter, 3600);
      const t1 = await throttled.syncDocument(doc.id);
      const t2 = await throttled.syncDocument(doc.id);
      ck.eq(adapterCalls, 1, "relance sous le délai minimal → UNE seule passe d'inventaire");
      ck(/relance ignorée/.test(t2[0].message) && /délai minimal/.test(t2[0].message), "…la seconde reçoit le dernier statut, annoté « relance ignorée »");
      ck(t1[0].last_attempt === t2[0].last_attempt, "…même horodatage de tentative (aucune nouvelle passe)");
      ck(!/relance ignorée/.test(throttled.statusFor(doc.id)[0].message), "…l'annotation n'est PAS stockée dans le statut persistant");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* dossier temp */ }
    }
  });

  /* ============ SERVEUR : VmSyncService — rapprochement d'hôte v3 (hiérarchie à 3 niveaux) ============ */

  await section("Serveur : VmSyncService — rapprochement d'hôte v3 (hostnames d'IP prioritaires, casse, ambiguïté)", async () => {
    // better-sqlite3 RÉEL requis (DocumentStore) — même probe que la section e2e.
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probeDb = new Candidate(":memory:"); probeDb.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section rapprochement d'hôte sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { DocumentStore } = SERVER("documents.js");
    const { VmSyncService } = SERVER("vm/VmSyncService.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-vmhost-"));
    try {
      const docs = new DocumentStore(dir, Sqlite);
      const doc = docs.create("infra-host");
      const repo = docs.repo(doc.id);
      // Équipements + adresses IP rattachées, couvrant les 3 niveaux de rapprochement. transact = écriture
      // bas niveau (sans validation) → on pose directement des enregistrements représentatifs.
      repo.transact({ creates: [
        // Niveau 1 (hostname d'IP) : eq1 par hostname COMPLET, eq2 par 1er label, eq3 multi-IP (dédup).
        { collection: "equipments", record: { id: "eq1", name: "sans-rapport-1" } },
        { collection: "equipments", record: { id: "eq2", name: "sans-rapport-2" } },
        { collection: "equipments", record: { id: "eq3", name: "sans-rapport-3" } },
        // Ambiguïté niveau 1 : eq4a et eq4b matchent tous deux « srv42 » par hostname d'IP ; eq4name est nommé
        // EXACTEMENT « srv42 » (niveau 2) — l'ambiguïté du niveau 1 ne doit PAS y descendre (null attendu).
        { collection: "equipments", record: { id: "eq4a", name: "sans-rapport-4a" } },
        { collection: "equipments", record: { id: "eq4b", name: "sans-rapport-4b" } },
        { collection: "equipments", record: { id: "eq4name", name: "srv42" } },
        // Niveau 2 (nom exact, INSENSIBLE À LA CASSE) : « SRV37 » ↔ nœud « srv37 ».
        { collection: "equipments", record: { id: "eqCase", name: "SRV37" } },
        // Niveau 3 (1er label du FQDN du nom) : « srv43.int.exemple.com » ↔ nœud « srv43 ».
        { collection: "equipments", record: { id: "eqFqdn", name: "srv43.int.exemple.com" } },
        // Adresses IP RATTACHÉES (equipment_id posé) — le FQDN est encodé dans le hostname.
        { collection: "ipAddresses", record: { id: "ip1", address: "10.0.0.1", equipment_id: "eq1", hostname: "srvfull.int.exemple.com" } },
        { collection: "ipAddresses", record: { id: "ip2", address: "10.0.0.2", equipment_id: "eq2", hostname: "srv40.int.exemple.com" } },
        { collection: "ipAddresses", record: { id: "ip3a", address: "10.0.0.3", equipment_id: "eq3", hostname: "srv41.int.exemple.com" } },
        { collection: "ipAddresses", record: { id: "ip3b", address: "10.0.0.4", equipment_id: "eq3", hostname: "srv41.dmz.exemple.com" } },
        { collection: "ipAddresses", record: { id: "ip4a", address: "10.0.0.5", equipment_id: "eq4a", hostname: "srv42.a.exemple.com" } },
        { collection: "ipAddresses", record: { id: "ip4b", address: "10.0.0.6", equipment_id: "eq4b", hostname: "srv42.b.exemple.com" } },
      ] }, docs.markChanged(doc.id));

      fs.writeFileSync(path.join(dir, "vm-providers.json"), JSON.stringify({
        [doc.id]: { docName: "infra-host", providers: [
          { id: "pve-host", kind: "proxmox", url: "https://pve:8006", token: "sync@pve!t=U", interval_sec: 0 },
        ] },
      }), "utf8");
      const { ProviderConfigStore } = SERVER("vm/ProviderConfigStore.js");
      const providers = new ProviderConfigStore(dir);

      const mkVm = (n, node) => ({ ext_id: "h/" + n, provider_id: "pve-host", vm_type: "qemu", name: n, description: "",
        status: "running", host_node: node, cpu: 1, ram_mb: 512, disk_gb: 8, tags: [], nics: [] });
      const vms = [
        mkVm("vm-full", "srvfull.int.exemple.com"),   // N1 hostname COMPLET → eq1
        mkVm("vm-label", "srv40"),                     // N1 1er label du hostname → eq2
        mkVm("vm-multi", "srv41"),                     // N1 deux IP du MÊME équipement (dédup) → eq3
        mkVm("vm-ambig", "srv42"),                     // N1 AMBIGU (eq4a/eq4b) → null, SANS descendre à eq4name
        mkVm("vm-case", "srv37"),                      // N2 nom exact insensible à la casse → eqCase
        mkVm("vm-fqdn", "srv43"),                      // N3 1er label du FQDN du nom → eqFqdn
        mkVm("vm-none", "inconnu"),                    // aucun niveau → null
      ];
      const makeAdapter = (config) => ({ kind: config.kind, config,
        test: async () => ({ ok: true, kind: config.kind, version: "8.4.1", supported: true, message: "" }),
        inventory: async () => ({ vms, cluster: { name: "c", version: "8.4.1", supported: true, quorate: true, nodes: [] } }),
      });
      const live = { events: [], publish(d, data) { this.events.push({ d, data }); } };
      const service = new VmSyncService(docs, live, providers, undefined, makeAdapter, 0);

      const res = await service.syncDocument(doc.id);
      ck(res.length === 1 && res[0].ok === true, "synchro OK (rapprochement d'hôte v3)");
      const stored = repo.findBy("vms", "provider_id", "pve-host");
      const byName = (n) => stored.find((v) => v.name === n) || {};
      ck.eq(byName("vm-full").host_equipment_id, "eq1", "niveau 1 : hostname d'IP COMPLET (srvfull.int.exemple.com) → équipement rattaché");
      ck.eq(byName("vm-label").host_equipment_id, "eq2", "niveau 1 : 1er label du hostname d'IP (srv40) → équipement rattaché");
      ck.eq(byName("vm-multi").host_equipment_id, "eq3", "niveau 1 : deux IP du MÊME équipement matchantes = 1 candidat (dédup par équipement)");
      ck.eq(byName("vm-ambig").host_equipment_id, null, "niveau 1 AMBIGU (2 équipements) → null, SANS descendre au niveau 2 (« srv42 » exact ignoré)");
      ck.eq(byName("vm-case").host_equipment_id, "eqCase", "niveau 2 : nom exact INSENSIBLE À LA CASSE (« SRV37 » ↔ nœud « srv37 »)");
      ck.eq(byName("vm-fqdn").host_equipment_id, "eqFqdn", "niveau 3 : 1er label du FQDN du nom (« srv43.int.exemple.com » ↔ « srv43 »)");
      ck.eq(byName("vm-none").host_equipment_id, null, "aucun niveau ne correspond → null (rien d'inventé)");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* dossier temp */ }
    }
  });

  /* ============ SERVEUR : VmSyncService.rearmTimers (rechargement à chaud — sans Express ni SQLite) ============ */

  await section("Serveur : VmSyncService.rearmTimers — ré-arme les timers selon la config COURANTE", async () => {
  {
    const { VmSyncService } = SERVER("vm/VmSyncService.js");
    // Fabrique un provider (ProviderConfig) minimal — seuls id/interval_sec importent à l'armement.
    const p = (id, interval_sec) => ({ id, kind: "proxmox", endpoints: [], token: "x", include_lxc: true, interval_sec, timeout_sec: 15 });
    // Source de config MUTABLE (ProviderConfigSource) : rearmTimers doit relire la config à l'appel,
    // pas un snapshot — c'est tout l'intérêt du rechargement à chaud (CRUD).
    let providersByDoc = { "doc-1": [p("a", 60), p("b", 0), p("c", 30)] }; // b = manuel (interval 0) → pas de timer
    const providers = { configuredDocIds: () => Object.keys(providersByDoc), providersFor: (docId) => providersByDoc[docId] || [] };
    const docsStub = { get: () => null, repo: () => null }; // non sollicité par (start|rearm|stop)Timers
    const liveStub = { publish() {} };

    // STUB des timers GLOBAUX : compter les timers ACTIFS sans dépendre du temps réel (déterministe,
    // aucune horloge). VmSyncService appelle setInterval/clearInterval (globaux) — on les intercepte.
    const savedSetInterval = global.setInterval, savedClearInterval = global.clearInterval;
    const activeTimers = new Set();
    global.setInterval = (fn, ms) => { const t = { fn, ms, unref() {} }; activeTimers.add(t); return t; };
    global.clearInterval = (t) => { activeTimers.delete(t); };
    try {
      const service = new VmSyncService(docsStub, liveStub, providers, undefined, () => ({}), 0);
      service.startTimers();
      ck.eq(activeTimers.size, 2, "startTimers : 1 timer par provider interval_sec > 0 (a, c) — b manuel exclu");

      // Config change À CHAUD : on retire c, on ajoute d → rearmTimers doit refléter la config COURANTE.
      providersByDoc = { "doc-1": [p("a", 60), p("d", 45)] };
      service.rearmTimers();
      ck.eq(activeTimers.size, 2, "rearmTimers : anciens timers arrêtés puis ré-armés selon la config courante (a, d)");

      // Plus aucun provider périodique → 0 timer (aucune fuite d'un ancien intervalle).
      providersByDoc = { "doc-1": [p("a", 0)] };
      service.rearmTimers();
      ck.eq(activeTimers.size, 0, "rearmTimers : plus aucun provider périodique → 0 timer actif (aucune fuite)");

      // rearmTimers n'explose pas même quand la source est vide.
      providersByDoc = {};
      let threw = false;
      try { service.rearmTimers(); } catch (_) { threw = true; }
      ck(!threw && activeTimers.size === 0, "rearmTimers : source vide → aucun timer, aucune exception");

      service.stopTimers();
      ck.eq(activeTimers.size, 0, "stopTimers : tous les timers arrêtés");
    } finally {
      global.setInterval = savedSetInterval;
      global.clearInterval = savedClearInterval;
    }
  }
  });

  /* ============ SERVEUR : VmSyncService — producteur vm-sync-failure (raise/resolve via ProblemReporter) ============ */

  await section("Serveur : VmSyncService — producteur vm-sync-failure (raise/resolve via ProblemReporter)", async () => {
    // better-sqlite3 RÉEL requis (DocumentStore) — même probe que les sections VmSyncService e2e.
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probeDb = new Candidate(":memory:"); probeDb.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section producteur vm-sync-failure sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { DocumentStore } = SERVER("documents.js");
    const { VmSyncService } = SERVER("vm/VmSyncService.js");
    const { ProviderConfigStore } = SERVER("vm/ProviderConfigStore.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-vmnotify-"));
    try {
      const docs = new DocumentStore(dir, Sqlite);
      const doc = docs.create("infra-notify");

      // Un seul provider configuré (manuel). Le jeton est factice — le producteur ne doit JAMAIS le
      // faire fuiter (body = message de statut, garanti sans jeton).
      fs.writeFileSync(path.join(dir, "vm-providers.json"), JSON.stringify({
        [doc.id]: { docName: "infra-notify", providers: [
          { id: "pve-report", kind: "proxmox", url: "https://pve:8006", token: "sync@pve!t=U", interval_sec: 0 },
        ] },
      }), "utf8");
      const providers = new ProviderConfigStore(dir);
      const live = { events: [], publish(d, data) { this.events.push({ d, data }); } };
      const expectedKey = "vm-sync:" + doc.id + ":pve-report";

      // Reporter STUB : simple journal d'appels (le moteur notify réel gère l'anti-spam — ici on
      // vérifie SEULEMENT que le producteur appelle le bon verbe avec le bon événement).
      const makeReporter = () => {
        const calls = [];
        return { calls, raise: (key, event) => calls.push({ verb: "raise", key, event }), resolve: (key) => calls.push({ verb: "resolve", key }) };
      };

      // Adaptateurs stub : l'un rejette l'inventaire (échec), l'autre renvoie un inventaire VIDE (succès).
      const failAdapter = (config) => ({ kind: config.kind, config,
        test: async () => ({ ok: true, kind: config.kind, version: "8.4.1", supported: true, message: "" }),
        inventory: async () => { throw new Error("Proxmox : délai dépassé (15000 ms) sur /api2/json/cluster/resources"); } });
      const okAdapter = (config) => ({ kind: config.kind, config,
        test: async () => ({ ok: true, kind: config.kind, version: "8.4.1", supported: true, message: "" }),
        inventory: async () => ({ vms: [], cluster: { name: config.id, version: null, supported: false, quorate: null, nodes: [] } }) });

      // 1) Synchro en ÉCHEC → raise, avec clé stable + événement vm-sync-failure/error + doc_id.
      const reporterFail = makeReporter();
      const svcFail = new VmSyncService(docs, live, providers, undefined, failAdapter, 0, reporterFail);
      const r1 = await svcFail.syncDocument(doc.id);
      ck(r1.length === 1 && r1[0].ok === false, "synchro en échec (adaptateur qui rejette) → statut en erreur");
      const raise = reporterFail.calls.find((c) => c.verb === "raise");
      ck(!!raise, "échec → raise appelé sur le reporter");
      ck.eq(raise.key, expectedKey, "…clé STABLE vm-sync:<docId>:<providerId>");
      ck.eq(raise.event.event_type, "vm-sync-failure", "…event_type vm-sync-failure");
      ck.eq(raise.event.severity, "error", "…severity error");
      ck.eq(raise.event.doc_id, doc.id, "…doc_id posé (document concerné)");
      ck(!/sync@pve/.test(raise.event.body), "…le corps ne contient PAS le jeton du provider");
      ck(!reporterFail.calls.some((c) => c.verb === "resolve"), "…et aucun resolve sur un échec");

      // 2) Synchro RÉUSSIE → resolve avec la MÊME clé, jamais raise (retour à la normale notifié).
      const reporterOk = makeReporter();
      const svcOk = new VmSyncService(docs, live, providers, undefined, okAdapter, 0, reporterOk);
      const r2 = await svcOk.syncDocument(doc.id);
      ck(r2[0].ok === true, "synchro réussie (inventaire vide) → statut OK");
      const resolve = reporterOk.calls.find((c) => c.verb === "resolve");
      ck(!!resolve && resolve.key === expectedKey, "succès → resolve appelé avec la même clé");
      ck(!reporterOk.calls.some((c) => c.verb === "raise"), "…et jamais raise sur un succès");

      // 3) SANS reporter (constructeur SANS le 7e paramètre) : comportement STRICTEMENT inchangé,
      //    l'optional chaining `this.problems?.` ne jette pas — succès ET échec.
      let threw = false;
      let statusNone;
      try {
        const svcNoneOk = new VmSyncService(docs, live, providers, undefined, okAdapter, 0);
        await svcNoneOk.syncDocument(doc.id);
        const svcNoneFail = new VmSyncService(docs, live, providers, undefined, failAdapter, 0);
        statusNone = await svcNoneFail.syncDocument(doc.id);
      } catch (_) { threw = true; }
      ck(!threw && statusNone && statusNone[0].ok === false, "sans reporter → aucun throw, statut en erreur inchangé");

      // 4) Chemin ANTICIPÉ anti-rafale (2e appel immédiat, minIntervalSec > 0) : AUCUN appel au
      //    reporter (ce n'est PAS une vraie passe — la 1re passe seule signale).
      const reporterThrottle = makeReporter();
      const svcThrottle = new VmSyncService(docs, live, providers, undefined, okAdapter, 3600, reporterThrottle);
      await svcThrottle.syncDocument(doc.id);                 // 1re passe RÉELLE → 1 resolve
      const callsAfterFirst = reporterThrottle.calls.length;
      ck.eq(callsAfterFirst, 1, "1re passe réelle → un seul appel au reporter (resolve)");
      const t2 = await svcThrottle.syncDocument(doc.id);      // 2e passe SOUS le délai → sortie anticipée
      ck(/relance ignorée/.test(t2[0].message), "2e appel immédiat → statut annoté « relance ignorée » (anti-rafale)");
      ck.eq(reporterThrottle.calls.length, callsAfterFirst, "…chemin anti-rafale → AUCUN nouvel appel au reporter (pas une vraie passe)");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* dossier temp */ }
    }
  });

  /* ============ SERVEUR : InterventionsDb (incidents/interventions, interventions.db, better-sqlite3 RÉEL) ============ */

  await section("Serveur : InterventionsDb — schéma, CRUD + estampillage d'audit (serveur), closed_date auto, liens remplacés + cascade, validation griefs groupés", async () => {
    // better-sqlite3 RÉEL requis (binaire natif) — même probe que les autres sections DB.
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probe = new Candidate(":memory:"); probe.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section InterventionsDb sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { InterventionsDb } = SERVER("interventions/InterventionsDb.js");
    const { InterventionsConfigError } = SERVER("interventions/InterventionsValidate.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-interv-"));
    let raw = null;
    try {
      const db = new InterventionsDb(dir, Sqlite); // Logger "error" par défaut → silencieux

      // -- SCHÉMA : fichier matérialisé, 2 tables. --
      ck(fs.existsSync(path.join(dir, "interventions.db")), "interventions.db matérialisé dans le dossier injecté");
      raw = new Sqlite(path.join(dir, "interventions.db"));
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
      for (const t of ["interventions", "intervention_links"]) ck(tables.includes(t), "schéma : table " + t + " créée");

      // -- CRÉATION : l'audit est posé PAR LE SERVEUR ; les champs d'audit ENVOYÉS par le client sont IGNORÉS. --
      const created = db.save("doc-A", "i1", {
        kind: "intervention", title: "Remplacement switch", description: "# Plan\nà faire", status: "planned", priority: "high",
        planned_start: "2026-08-01T09:00:00.000Z", planned_end: "2026-08-01T11:00:00.000Z", jira_ref: "INFRA-42",
        links: [{ target_kind: "equipment", target_id: "eq-1" }, { target_kind: "vm", target_id: "vm-9" }],
        created_by: "pirate", created_date: "1999-01-01T00:00:00.000Z", updated_by: "pirate", closed_date: "1999-01-01T00:00:00.000Z",
      }, "Alice Martin");
      ck(created.created_by === "Alice Martin" && created.updated_by === "Alice Martin", "création : created_by/updated_by = utilisateur authentifié (posé serveur)");
      ck(created.created_by !== "pirate" && created.created_date !== "1999-01-01T00:00:00.000Z", "création : champs d'audit envoyés par le CLIENT ignorés");
      ck.eq(created.created_date, created.updated_date, "création : created_date = updated_date (même instant)");
      ck.eq(created.closed_date, null, "création (status planned) : closed_date null (pas encore clos)");
      ck.eq(created.links.map((l) => l.target_kind + ":" + l.target_id).join(","), "equipment:eq-1,vm:vm-9", "liens ordonnés (position = index du tableau)");

      // -- MISE À JOUR (writer distinct + attente pour un updated_date distinct) : created_* CONSERVÉS, updated_* rafraîchis. --
      await new Promise((r) => setTimeout(r, 25));
      const updated = db.save("doc-A", "i1", { kind: "intervention", title: "Remplacement switch (repoussé)", status: "planned", priority: "critical", planned_start: "2026-08-02T09:00:00.000Z" }, "Bob Durand");
      ck(updated.created_by === "Alice Martin" && updated.created_date === created.created_date, "mise à jour : created_by/created_date CONSERVÉS");
      ck(updated.updated_by === "Bob Durand" && updated.updated_date !== created.updated_date, "mise à jour : updated_by/updated_date rafraîchis");
      ck.eq(updated.links.length, 0, "mise à jour SANS links → liens remplacés intégralement (vidés)");
      ck.eq(updated.priority, "critical", "mise à jour : priority modifiée");

      // -- closed_date : posé à l'ENTRÉE en 'closed', CONSERVÉ tant qu'on y reste, EFFACÉ en sortie. --
      const closed1 = db.save("doc-A", "i1", { kind: "intervention", title: "Remplacement switch (repoussé)", status: "closed", priority: "critical" }, "Bob Durand");
      ck(closed1.closed_date !== null, "entrée en 'closed' → closed_date posé automatiquement");
      await new Promise((r) => setTimeout(r, 25));
      const stay = db.save("doc-A", "i1", { kind: "intervention", title: "Toujours clos", status: "closed", priority: "critical" }, "Bob Durand");
      ck.eq(stay.closed_date, closed1.closed_date, "reste 'closed' → closed_date CONSERVÉ (pas ré-écrit)");
      const reopened = db.save("doc-A", "i1", { kind: "intervention", title: "Ré-ouvert", status: "in_progress", priority: "critical" }, "Bob Durand");
      ck.eq(reopened.closed_date, null, "sortie de 'closed' → closed_date EFFACÉ");

      // -- getOne + persistance des liens sur un autre objet ; cascade au DELETE. --
      db.save("doc-A", "i2", { kind: "incident", title: "Panne alim", status: "declared", priority: "normal", links: [{ target_kind: "spare", target_id: "sp-3" }] }, "Alice Martin");
      const got = db.getOne("doc-A", "i2");
      ck(got && got.kind === "incident" && got.links.length === 1 && got.links[0].target_id === "sp-3", "getOne : objet + liens restitués");
      ck.eq(db.getOne("doc-A", "inconnu"), null, "getOne inconnu → null");
      ck.eq(raw.prepare("SELECT COUNT(*) AS n FROM intervention_links WHERE intervention_id='i2'").get().n, 1, "avant suppression : 1 lien en base");
      ck.eq(db.remove("doc-A", "i2"), true, "remove → true (objet supprimé)");
      ck.eq(raw.prepare("SELECT COUNT(*) AS n FROM intervention_links WHERE intervention_id='i2'").get().n, 0, "…ses liens partent en CASCADE");
      ck.eq(db.remove("doc-A", "i2"), false, "remove d'un inconnu → false (404 côté route)");

      // -- VALIDATION : griefs GROUPÉS (title vide, kind inconnu, end sans start, end < start, liens trop nombreux / kind inconnu). --
      const grief = (cand) => { try { db.save("doc-A", "bad", cand, "Testeur"); return null; } catch (e) { return e instanceof InterventionsConfigError ? e.issues : ["AUTRE: " + (e && e.message)]; } };
      const gTitle = grief({ kind: "incident", title: "   ", status: "declared", priority: "low" });
      ck(!!gTitle && gTitle.some((i) => /title/.test(i)), "validation : title vide → grief");
      const gKind = grief({ kind: "sinistre", title: "X", status: "declared", priority: "low" });
      ck(!!gKind && gKind.some((i) => /kind/.test(i)), "validation : kind inconnu → grief");
      const gEndNoStart = grief({ kind: "intervention", title: "X", status: "planned", priority: "low", planned_end: "2026-08-01T10:00:00.000Z" });
      ck(!!gEndNoStart && gEndNoStart.some((i) => /exige planned_start/.test(i)), "validation : planned_end sans planned_start → grief");
      const gOrder = grief({ kind: "intervention", title: "X", status: "planned", priority: "low", planned_start: "2026-08-02T10:00:00.000Z", planned_end: "2026-08-01T10:00:00.000Z" });
      ck(!!gOrder && gOrder.some((i) => /antérieur/.test(i)), "validation : planned_end < planned_start → grief");
      const gManyLinks = grief({ kind: "intervention", title: "X", status: "planned", priority: "low", links: Array.from({ length: 201 }, (_, i) => ({ target_kind: "equipment", target_id: "eq" + i })) });
      ck(!!gManyLinks && gManyLinks.some((i) => /links/.test(i)), "validation : > 200 liens → grief");
      const gLinkKind = grief({ kind: "intervention", title: "X", status: "planned", priority: "low", links: [{ target_kind: "planet", target_id: "x" }] });
      ck(!!gLinkKind && gLinkKind.some((i) => /target_kind/.test(i)), "validation : target_kind de lien inconnu → grief");
      const gMulti = grief({ kind: "?", title: "", status: "?", priority: "?" });
      ck(!!gMulti && gMulti.length >= 4, "validation : griefs GROUPÉS (title + kind + status + priority cumulés en une passe)");
      ck.eq(raw.prepare("SELECT COUNT(*) AS n FROM interventions WHERE id='bad'").get().n, 0, "validation : un candidat rejeté n'écrit RIEN (parse avant transaction)");
    } finally {
      if (raw) { try { raw.close(); } catch (_) {} }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  /* ============ SERVEUR : InterventionsDb — listing paginé (filtres/tris/recherche SQL) ============ */

  await section("Serveur : InterventionsDb.listPage — pagination, filtres kind/status/priority (répétables), query (search), tris (rang sémantique), plafond pageSize", async () => {
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probe = new Candidate(":memory:"); probe.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section listing Interventions sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { InterventionsDb } = SERVER("interventions/InterventionsDb.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-interv-page-"));
    try {
      const db = new InterventionsDb(dir, Sqlite);
      const D = "D";
      const pad2 = (n) => String(n).padStart(2, "0");
      const STATUSES = ["declared", "planned", "in_progress", "closed", "cancelled"];
      const PRIORITIES = ["low", "normal", "high", "critical"];
      // Parc SYNTHÉTIQUE de 30 objets, kinds/status/priority variés + valeurs cherchables (titre/description/jira).
      for (let i = 1; i <= 30; i++) {
        const id = "o" + pad2(i);
        const cand = { kind: i % 3 === 0 ? "incident" : "intervention", title: "Objet " + pad2(i), status: STATUSES[i % 5], priority: PRIORITIES[i % 4] };
        if (id === "o07") { cand.title = "Café serveur"; cand.jira_ref = "INFRA-777"; }
        if (id === "o08") { cand.description = "contient le mot Trouvemoi caché"; }
        db.save(D, id, cand, "Testeur");
      }

      // -- PAGINATION : total / pages / clamp / plafond pageSize. --
      const p10 = db.listPage(D, { pageSize: 10 });
      ck(p10.total === 30 && p10.pages === 3 && p10.page === 1 && p10.pageSize === 10 && p10.interventions.length === 10, "listPage : total 30, 3 pages, page 1 pleine (10)");
      const clamp = db.listPage(D, { pageSize: 10, page: 99 });
      ck(clamp.page === 3 && clamp.interventions.length === 10, "listPage : page hors borne clampée à la dernière");
      const cap = db.listPage(D, { pageSize: 9999 });
      ck(cap.pageSize === 200 && cap.interventions.length === 30 && cap.pages === 1, "listPage : pageSize plafonné à 200 (tout sur une page)");

      // -- Chaque item INCLUT ses liens. --
      db.save(D, "olink", { kind: "intervention", title: "Avec liens", status: "planned", priority: "low", links: [{ target_kind: "vm", target_id: "vmX" }] }, "Testeur");
      const withLink = db.listPage(D, { query: "avec liens" }).interventions[0];
      ck(withLink && withLink.links.length === 1 && withLink.links[0].target_id === "vmX", "listPage : chaque item inclut ses liens");

      // -- QUERY (colonne search dénormalisée, normSearch partagé) : titre/description/jira, insensible casse/accents. --
      ck.eq(db.listPage(D, { query: "trouvemoi" }).interventions.map((x) => x.id).join(","), "o08", "query : trouve par DESCRIPTION (o08)");
      ck.eq(db.listPage(D, { query: "INFRA-777" }).interventions.map((x) => x.id).join(","), "o07", "query : trouve par jira_ref");
      ck.eq(db.listPage(D, { query: "cafe" }).interventions.map((x) => x.id).join(","), "o07", "query : insensible aux accents (« Café » ↦ « cafe »)");
      ck.eq(db.listPage(D, { query: "CAFE" }).interventions.map((x) => x.id).join(","), "o07", "query : insensible à la casse");

      // -- FILTRES kind/status/priority (IN, répétables) + combinés. --
      const incidents = db.listPage(D, { kinds: ["incident"], pageSize: 200 });
      ck(incidents.total === 10 && incidents.interventions.every((x) => x.kind === "incident"), "kinds : incident → 10 (multiples de 3)");
      const closed = db.listPage(D, { statuses: ["closed"], pageSize: 200 });
      ck(closed.total > 0 && closed.interventions.every((x) => x.status === "closed"), "statuses : closed uniquement");
      const twoStatuses = db.listPage(D, { statuses: ["closed", "cancelled"], pageSize: 200 });
      ck(twoStatuses.total > closed.total && twoStatuses.interventions.every((x) => x.status === "closed" || x.status === "cancelled"), "statuses : répétable (closed|cancelled)");
      const crit = db.listPage(D, { priorities: ["critical"], pageSize: 200 });
      ck(crit.total > 0 && crit.interventions.every((x) => x.priority === "critical"), "priorities : critical uniquement");
      const combo = db.listPage(D, { kinds: ["intervention"], statuses: ["planned"], pageSize: 200 });
      ck(combo.total > 0 && combo.interventions.every((x) => x.kind === "intervention" && x.status === "planned"), "filtres combinés (AND : intervention + planned)");

      // -- TRIS : rang SÉMANTIQUE pour priority/status (PAS alphabétique). --
      const prioDesc = db.listPage(D, { sort: "priority", dir: "desc", pageSize: 200 }).interventions.map((x) => x.priority);
      ck(prioDesc[0] === "critical" && prioDesc[prioDesc.length - 1] === "low", "sort priority desc : critical en tête, low en fin (rang sémantique, pas alphabétique)");
      const prioAsc = db.listPage(D, { sort: "priority", dir: "asc", pageSize: 200 }).interventions.map((x) => x.priority);
      ck(prioAsc[0] === "low" && prioAsc[prioAsc.length - 1] === "critical", "sort priority asc : low → critical");
      const statusAsc = db.listPage(D, { sort: "status", dir: "asc", pageSize: 200 }).interventions.map((x) => x.status);
      ck(statusAsc[0] === "declared" && statusAsc[statusAsc.length - 1] === "cancelled", "sort status asc : declared en tête, cancelled en fin (cycle de vie)");

      // -- TRI planned_start : NULL en DERNIER dans les deux sens. --
      db.save(D, "sched-a", { kind: "intervention", title: "Planif A", status: "planned", priority: "low", planned_start: "2026-09-01T08:00:00.000Z" }, "Testeur");
      db.save(D, "sched-b", { kind: "intervention", title: "Planif B", status: "planned", priority: "low", planned_start: "2026-08-01T08:00:00.000Z" }, "Testeur");
      const startAsc = db.listPage(D, { sort: "planned_start", dir: "asc", pageSize: 200 }).interventions;
      ck(startAsc[0].id === "sched-b" && startAsc[startAsc.length - 1].planned_start === null, "sort planned_start asc : plus proche en tête, NULL en fin");
      const startDesc = db.listPage(D, { sort: "planned_start", dir: "desc", pageSize: 200 }).interventions;
      ck(startDesc[0].id === "sched-a" && startDesc[startDesc.length - 1].planned_start === null, "sort planned_start desc : plus lointaine en tête, NULL TOUJOURS en fin");

      // -- Validation SOUPLE : sort/dir inconnus → défaut appliqué (jamais d'erreur). --
      const soft = db.listPage(D, { sort: "n_importe_quoi", dir: "n_importe" });
      ck(soft.total >= 30 && soft.interventions.length > 0, "sort/dir inconnus → défaut appliqué (validation souple, aucune erreur)");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  /* ============ SERVEUR : InterventionsDb.countOpenForTargets (badges de fiche — interventions OUVERTES par cible) ============ */

  await section("Serveur : InterventionsDb.countOpenForTargets — comptes OUVERTS par cible (exclut closed/cancelled, dédup lien, cible inconnue → 0, multi-cibles, souple)", async () => {
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probe = new Candidate(":memory:"); probe.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section counts Interventions sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { InterventionsDb } = SERVER("interventions/InterventionsDb.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-interv-counts-"));
    try {
      const db = new InterventionsDb(dir, Sqlite);
      const D = "D";
      const mk = (id, status, links) => db.save(D, id, { kind: "intervention", title: "T-" + id, status, priority: "normal", links }, "Testeur");
      // eq1 : 2 OUVERTES (declared + in_progress) + 1 closed + 1 cancelled (exclues) → 2.
      mk("i1", "declared",    [{ target_kind: "equipment", target_id: "eq1" }]);
      mk("i2", "in_progress", [{ target_kind: "equipment", target_id: "eq1" }, { target_kind: "vm", target_id: "vm9" }]);
      mk("i3", "closed",      [{ target_kind: "equipment", target_id: "eq1" }]);
      mk("i4", "cancelled",   [{ target_kind: "equipment", target_id: "eq1" }]);
      // vm9 : i2 (in_progress) + i5 (planned) → 2 ouvertes.
      mk("i5", "planned",     [{ target_kind: "vm", target_id: "vm9" }]);
      // sp3 : UNE intervention liée DEUX fois à la même cible (positions distinctes) → comptée UNE fois.
      mk("i6", "declared",    [{ target_kind: "spare", target_id: "sp3" }, { target_kind: "spare", target_id: "sp3" }]);

      const c = db.countOpenForTargets(D, [
        { kind: "equipment", id: "eq1" }, { kind: "vm", id: "vm9" }, { kind: "spare", id: "sp3" },
        { kind: "equipment", id: "absent" },
      ]);
      ck.eq(c["equipment:eq1"], 2, "eq1 : 2 ouvertes (declared + in_progress ; closed/cancelled exclues)");
      ck.eq(c["vm:vm9"], 2, "vm9 : 2 ouvertes (in_progress + planned)");
      ck.eq(c["spare:sp3"], 1, "sp3 : lien dupliqué compté UNE fois (COUNT DISTINCT sur l'intervention)");
      ck.eq(c["equipment:absent"], 0, "cible sans intervention → 0 (présente dans la map)");

      // Cible NON demandée → absente de la map.
      ck(!("vm:vm9" in db.countOpenForTargets(D, [{ kind: "equipment", id: "eq1" }])), "cible non demandée → absente de la map");
      // Cibles MALFORMÉES ignorées (validation souple) — seule eq1 subsiste.
      const cSoft = db.countOpenForTargets(D, [{ kind: "", id: "x" }, { kind: "equipment", id: "" }, { kind: "equipment", id: "eq1" }]);
      ck(Object.keys(cSoft).length === 1 && cSoft["equipment:eq1"] === 2, "cibles malformées ignorées (souple), seule eq1 comptée");
      // Aucune cible → map vide.
      ck.eq(Object.keys(db.countOpenForTargets(D, [])).length, 0, "aucune cible → map vide");

      // Fermeture d'une ouverte → le compte baisse.
      db.save(D, "i1", { kind: "intervention", title: "T-i1", status: "closed", priority: "normal", links: [{ target_kind: "equipment", target_id: "eq1" }] }, "Testeur");
      ck.eq(db.countOpenForTargets(D, [{ kind: "equipment", id: "eq1" }])["equipment:eq1"], 1, "après clôture de i1 → eq1 retombe à 1");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
  });

  /* ============ SERVEUR : InterventionReminderWatcher + route meta (logique PURE — sans SQLite) ============ */

  await section("Serveur : InterventionReminderWatcher — paliers info(−24h)/warning(−1h)/error(H), error maintenu fenêtre dépassée, resolve démarrage/disparition ; route meta (JIRA_BASE_URL)", async () => {
    const { InterventionReminderWatcher } = SERVER("interventions/InterventionReminderWatcher.js");
    const { InterventionsValidate } = SERVER("interventions/InterventionsValidate.js");
    const HOUR = 3600000;
    const nowMs = Date.parse("2026-07-20T12:00:00.000Z");
    const clock = () => new Date(nowMs);
    const at = (hours) => new Date(nowMs + hours * HOUR).toISOString();
    const calls = [];
    const reporter = { raise: (key, event) => calls.push({ op: "raise", key, event }), resolve: (key) => calls.push({ op: "resolve", key }) };
    const parc = [];
    const watcher = new InterventionReminderWatcher({ listReminderCandidates: () => parc.slice() }, reporter, clock);

    ck.eq(InterventionReminderWatcher.keyFor("doc-A", "i1"), "intervention-reminder:doc-A:i1", "clé stable intervention-reminder:<docId>:<id>");

    // -- PALIERS : gravité CROISSANTE à l'approche de l'heure H (défauts 24 h / 1 h). --
    parc.push(
      { doc_id: "d", id: "loin", title: "Loin", kind: "intervention", status: "planned", planned_start: at(48), planned_end: at(50) },     // > 24 h → rien (resolve)
      { doc_id: "d", id: "j-info", title: "Info", kind: "intervention", status: "planned", planned_start: at(20), planned_end: at(22) },    // ≤ 24 h, > 1 h → info
      { doc_id: "d", id: "j-warn", title: "Warn", kind: "intervention", status: "declared", planned_start: at(0.5), planned_end: at(2) },   // ≤ 1 h, > 0 → warning
      { doc_id: "d", id: "j-err", title: "Err", kind: "intervention", status: "planned", planned_start: at(-1), planned_end: at(1) },       // début passé → error
    );
    const bilan = watcher.scan();
    ck(bilan.raised === 3 && bilan.resolved === 1, "passe : 3 rappels levés (info/warning/error), 1 clôture (hors seuil > 24 h)");
    const byId = (id) => calls.find((c) => c.op === "raise" && c.key.endsWith(":" + id));
    ck.eq(byId("j-info").event.severity, "info", "départ dans ≤ 24 h et > 1 h → info");
    ck.eq(byId("j-warn").event.severity, "warning", "départ dans ≤ 1 h et > H → warning");
    ck.eq(byId("j-err").event.severity, "error", "départ atteint/dépassé → error (« devait commencer »)");
    ck(byId("j-err").event.event_type === "intervention-reminder" && byId("j-err").event.doc_id === "d", "événement : type intervention-reminder + doc_id porté");
    ck(/devait commencer/.test(byId("j-err").event.body) && /2026-07-20 11:00/.test(byId("j-err").event.body), "message error : « devait commencer » + fenêtre (heure incluse)");
    ck(calls.some((c) => c.op === "resolve" && c.key === "intervention-reminder:d:loin"), "> 24 h → resolve (no-op moteur si jamais levé)");

    // -- ERROR MAINTENU même fenêtre DÉPASSÉE (planned_end passé) et toujours pas démarré. --
    calls.length = 0;
    parc.length = 0;
    parc.push({ doc_id: "d", id: "depasse", title: "Dépassée", kind: "intervention", status: "planned", planned_start: at(-10), planned_end: at(-2) });
    watcher.scan();
    const dep = calls.find((c) => c.op === "raise" && c.key.endsWith(":depasse"));
    ck(dep && dep.event.severity === "error", "fenêtre dépassée (planned_end passé), pas démarrée → error MAINTENU (jamais clos)");

    // -- Idempotence par passe (l'anti-spam vit dans le moteur notify, pas ici). --
    calls.length = 0;
    watcher.scan();
    ck.eq(calls.filter((c) => c.op === "raise").length, 1, "re-scan → raise re-signalé (idempotent côté moteur, aucun anti-spam ici)");

    // -- RESOLVE quand l'objet DÉMARRE / se clôt / s'annule → il sort de listReminderCandidates. --
    calls.length = 0;
    parc.length = 0; // 'depasse' passé en in_progress/closed/cancelled → plus fourni par la source
    watcher.scan();
    ck(calls.some((c) => c.op === "resolve" && c.key === "intervention-reminder:d:depasse"), "objet démarré/clos/annulé → disparaît de la source → resolve (jeu mémoire des clés levées)");
    calls.length = 0;
    watcher.scan();
    ck.eq(calls.filter((c) => c.op === "resolve" && c.key.endsWith(":depasse")).length, 0, "…une seule fois (clé oubliée après clôture)");

    // -- BORDURES exactes des paliers (inclusives). --
    calls.length = 0;
    parc.length = 0;
    parc.push(
      { doc_id: "b", id: "pile24", title: "Pile 24h", kind: "intervention", status: "planned", planned_start: at(24), planned_end: null },     // pile −24 h → info (inclusif)
      { doc_id: "b", id: "pile1", title: "Pile 1h", kind: "intervention", status: "planned", planned_start: at(1), planned_end: null },         // pile −1 h → warning (inclusif)
      { doc_id: "b", id: "au-dela", title: "Au-delà", kind: "intervention", status: "planned", planned_start: at(24.001), planned_end: null },  // juste > 24 h → resolve
    );
    watcher.scan();
    ck(calls.some((c) => c.op === "raise" && c.key.endsWith(":pile24") && c.event.severity === "info"), "−24 h pile → info (inclusif)");
    ck(calls.some((c) => c.op === "raise" && c.key.endsWith(":pile1") && c.event.severity === "warning"), "−1 h pile → warning (inclusif)");
    ck(calls.some((c) => c.op === "resolve" && c.key.endsWith(":au-dela")), "juste au-delà de −24 h → hors seuil (resolve)");

    // -- Seuils INJECTABLES (tests) : paliers resserrés. --
    const calls2 = [];
    const reporter2 = { raise: (k, e) => calls2.push({ op: "raise", e }), resolve: (k) => calls2.push({ op: "resolve" }) };
    const tight = new InterventionReminderWatcher(
      { listReminderCandidates: () => [{ doc_id: "t", id: "x", title: "X", kind: "incident", status: "planned", planned_start: at(3), planned_end: null }] },
      reporter2, clock, { info: 6 * HOUR, warning: 2 * HOUR },
    );
    tight.scan();
    ck(calls2.some((c) => c.op === "raise" && c.e.severity === "info"), "seuils injectés (info=6 h/warning=2 h) : départ à +3 h → info");

    // -- ROUTE meta : jira_base_url = JIRA_BASE_URL (trim ; vide/absente → null). --
    ck.eq(InterventionsValidate.jiraBaseUrl({ JIRA_BASE_URL: "https://monorg.atlassian.net/browse/" }), "https://monorg.atlassian.net/browse/", "meta : JIRA_BASE_URL posée → valeur");
    ck.eq(InterventionsValidate.jiraBaseUrl({ JIRA_BASE_URL: "  https://x/browse/  " }), "https://x/browse/", "meta : valeur trimmée");
    ck.eq(InterventionsValidate.jiraBaseUrl({ JIRA_BASE_URL: "   " }), null, "meta : vide (espaces) → null");
    ck.eq(InterventionsValidate.jiraBaseUrl({}), null, "meta : absente → null");
  });
};
