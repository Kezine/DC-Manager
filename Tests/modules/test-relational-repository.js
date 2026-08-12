/* Tests modules — REPOSITORY RELATIONNEL (src-server/RelationalRepository, lot L2 migration DB).
   ----------------------------------------------------------------------------
   Prouve l'implémentation COLONNES du contrat `Repository` sur le schéma GÉNÉRÉ (RelationalSchema) avec
   better-sqlite3 RÉEL en `:memory:` (décision utilisateur « go pour du réel » — le shim SQLite des tests
   blob ne parle pas ce SQL et reste réservé au blob) :
   - CRUD RE-TYPÉ : chaque type de spec écrit puis relu en ÉGALITÉ STRUCTURELLE stricte des types JS
     (booléen === true/false, NUMERIC entier exact — le piège « le driver rend-il "42" string ? » est
     prouvé —, string[], json objet ET tableau, null nullable) ;
   - le CONTRAT des colonnes strictes : clés inconnues ignorées, audit présent/absent, reconstruction
     normalisée (toute colonne de spec présente, search/updated_rev exclus) ;
   - whereClause sur colonnes (égalité, sentinelle "null" scalaire ET tableau, appartenance, champ
     inconnu → 0 ligne), list (pagination/tri/q/ids), findBy, verrou optimiste, transact ATOMIQUE,
     replaceSnapshot (Q7), meta, images (purge par maintenance SUR LES COLONNES face_image_*_id) ;
   - 🎯 EXPLAIN QUERY PLAN : `USING INDEX` sur les findBy du chemin chaud — la PREUVE du gain, raison
     d'être du chantier — et contre-épreuve SCAN sur un champ non indexé.
   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, SERVER, SharedSchema, Validation } = require("./harness.js");

/* -------- better-sqlite3 RÉEL (src-server/node_modules) --------
   ⚠ Contrairement aux sections blob (probe → SKIP avec avertissement), l'indisponibilité est ici un
   ÉCHEC avec message ACTIONNABLE, jamais un saut silencieux : un skip ferait passer le lot L2 sans une
   seule preuve (décision du brief L2). Probe COMPLET (require + ouverture) : le module peut être présent
   mais son binaire natif absent ou compilé pour un autre Node. */
let SQLITE = null, SQLITE_VERSION = "", SQLITE_ERROR = "";
try {
  const candidatePath = path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3");
  const Candidate = require(candidatePath);
  new Candidate(":memory:").close();
  SQLITE = Candidate;
  SQLITE_VERSION = String(require(path.join(candidatePath, "package.json")).version || "");
} catch (e) { SQLITE_ERROR = ((e && e.message) || String(e)).split("\n")[0]; }
/** ÉCHOUE (pas de skip) si le driver réel manque ; à appeler en tête de CHAQUE section. */
const requireSqlite = () => {
  if (SQLITE) return true;
  ck(false, "better-sqlite3 RÉEL indisponible (" + SQLITE_ERROR + ") — `npm install` (ou `npm rebuild better-sqlite3`) dans src-server/ ; ce test ÉCHOUE au lieu de sauter (lot L2)");
  return false;
};

module.exports = async () => {
  await section("Serveur : RelationalRepository — module réel, schéma généré, CRUD RE-TYPÉ (better-sqlite3 :memory:)", async () => {
  {
    if (!requireSqlite()) return;
    const { RelationalRepository } = SERVER("RelationalRepository.js");

    // -- ANTI-VACUITÉ 1 : le module natif réellement chargé (version affichée). --
    console.log("    better-sqlite3 v" + SQLITE_VERSION + " (module RÉEL chargé depuis src-server/node_modules)");
    ck(/^\d+\./.test(SQLITE_VERSION), "anti-vacuité : better-sqlite3 réellement chargé (version " + SQLITE_VERSION + ")");

    const repo = RelationalRepository.open(":memory:", SQLITE);

    // -- ANTI-VACUITÉ 2 : les tables réellement créées (TOUTES les collections du schéma + meta + images —
    //    compte DÉRIVÉ de Schema.COLLECTIONS, il suit tout seul l'ajout d'une collection).
    //    `repo.db` est privé TypeScript (compile-time) — accessible du test JS, assumé pour l'inspection. --
    const tables = repo.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    ck.eq(tables.length, SharedSchema.COLLECTIONS.length + 2, "anti-vacuité : " + SharedSchema.COLLECTIONS.length + " tables de collection + meta + images");
    ck(SharedSchema.COLLECTIONS.every((c) => tables.includes(c)), "anti-vacuité : CHAQUE collection du schéma a sa table");
    ck(tables.includes("meta") && tables.includes("images"), "anti-vacuité : tables meta + images (hors migration) présentes");

    // -- CRUD RE-TYPÉ : un record par type de champ, relu en égalité STRUCTURELLE stricte des types JS. --
    repo.upsert("racks", {
      id: "r1", name: "Baie α",
      u_count: 42, dc_x: 1234.5,                                    // number : entier ET décimal
      has_caps: true, locked: false,                                // boolean : les deux valeurs
      roof_cells: ["0,0", "1,2"], floor_cells: [],                  // string[] : peuplé ET vide
      door_front: { thickness_mm: 40, hinge: "left", hollow: true }, // json : objet
      datacenter_id: null,                                          // nullable : null explicite
    }, 1);
    const r = repo.getOne("racks", "r1");
    ck(r.has_caps === true, "boolean : true relu === true (INTEGER 0/1 re-mappé, pas 1)");
    ck(r.locked === false, "boolean : false relu === false (pas 0)");
    ck(typeof r.u_count === "number" && Number.isInteger(r.u_count) && r.u_count === 42,
      "NUMERIC : entier relu ENTIER JS exact (piège driver prouvé — pas \"42\" string)");
    ck(r.dc_x === 1234.5, "NUMERIC : décimal relu décimal exact (1234.5)");
    ck(Array.isArray(r.roof_cells) && JSON.stringify(r.roof_cells) === JSON.stringify(["0,0", "1,2"]), "string[] : relu tableau JS (contenu exact)");
    ck(Array.isArray(r.floor_cells) && r.floor_cells.length === 0, "string[] : tableau vide relu []");
    ck.eq(JSON.stringify(r.door_front), JSON.stringify({ thickness_mm: 40, hinge: "left", hollow: true }), "json : objet relu structurellement");
    ck.eq(r.datacenter_id, null, "nullable : null relu null");
    ck.eq(r.name, "Baie α", "string : relue telle quelle (unicode inclus)");

    // json TABLEAU (vms.nics) + string[] métier (tags_src).
    repo.upsert("vms", { id: "v1", name: "vm-1", nics: [{ mac: "aa:bb", bridge: "vmbr0" }, { mac: "cc:dd", bridge: "vmbr1" }], tags_src: ["prod", "web"] }, 1);
    const v = repo.getOne("vms", "v1");
    ck(Array.isArray(v.nics) && v.nics.length === 2 && v.nics[1].bridge === "vmbr1", "json : TABLEAU d'objets (nics) relu structurellement");
    ck(Array.isArray(v.tags_src) && v.tags_src.join(",") === "prod,web", "string[] : tags_src relu");

    // -- RECONSTRUCTION NORMALISÉE : chaque colonne de spec présente ; opérationnelles exclues. --
    const rackFields = Object.keys(Validation.COLLECTION_SPECS.racks.fields);
    ck(rackFields.every((f) => f in r), "reconstruction : CHAQUE champ de la spec présent (" + rackFields.length + " champs, y compris non fournis)");
    ck.eq(r.width_mm, null, "reconstruction : champ non fourni → clé PRÉSENTE à null (forme normalisée)");
    ck(!("search" in r) && !("updated_rev" in r), "reconstruction : search/updated_rev (colonnes OPÉRATIONNELLES) hors record");

    // -- upsert = update sur conflit d'id + getMany/delete. --
    repo.upsert("racks", { id: "r1", name: "Baie α rev2", u_count: 47 }, 2);
    ck.eq(repo.getOne("racks", "r1").u_count, 47, "upsert : ON CONFLICT(id) → update en place");
    ck.eq(repo.getMany("racks", ["r1", "absent"]).length, 1, "getMany : ids trouvés seulement");
    repo.delete("racks", "r1");
    ck.eq(repo.getOne("racks", "r1"), null, "delete : ligne supprimée");
    repo.close();
  }
  });

  await section("Serveur : RelationalRepository — clés INCONNUES ignorées + audit présent/absent", async () => {
  {
    if (!requireSqlite()) return;
    const { RelationalRepository } = SERVER("RelationalRepository.js");
    const repo = RelationalRepository.open(":memory:", SQLITE);

    // -- Clés hors spec : SILENCIEUSEMENT ignorées (contrat des colonnes strictes), AUCUNE erreur.
    //    `face_image` = legacy réel (purge L4 voulue) ; `champ_fantome` = clé arbitraire. --
    repo.upsert("equipments", { id: "e1", name: "sw-1", face_image: "x", champ_fantome: 1 }, 1);
    const e1 = repo.getOne("equipments", "e1");
    ck(!("face_image" in e1) && !("champ_fantome" in e1), "clés inconnues : absentes du record relu (legacy face_image disparu — VOULU, purge L4)");
    ck.eq(e1.name, "sw-1", "clés inconnues : les champs déclarés du même record survivent");

    // -- Audit PRÉSENT (posé par AuditStamp côté api) → colonnes d'audit, relu tel quel. --
    repo.upsert("equipments", {
      id: "e2", name: "sw-2",
      created_by: "u-alice", updated_by: "u-bob",
      created_date: "2026-01-01T00:00:00.000Z", updated_date: "2026-02-01T00:00:00.000Z",
    }, 1);
    const e2 = repo.getOne("equipments", "e2");
    ck(e2.created_by === "u-alice" && e2.updated_by === "u-bob", "audit présent : _by relus tels quels");
    ck(e2.created_date === "2026-01-01T00:00:00.000Z" && e2.updated_date === "2026-02-01T00:00:00.000Z", "audit présent : dates relues telles quelles");

    // -- Audit ABSENT (mode fichier / legacy) → clés ABSENTES du record relu, PAS null (parité blob). --
    ck(!("created_by" in e1) && !("updated_by" in e1) && !("created_date" in e1) && !("updated_date" in e1),
      "audit absent : clés ABSENTES du record relu (pas de null inventé — parité mode fichier)");
    repo.close();
  }
  });

  await section("Serveur : RelationalRepository — whereClause sur COLONNES (égalité, sentinelle, appartenance, inconnu)", async () => {
  {
    if (!requireSqlite()) return;
    const { RelationalRepository } = SERVER("RelationalRepository.js");
    const repo = RelationalRepository.open(":memory:", SQLITE);
    repo.upsert("cables", { id: "c1", status: "brouillon", network_id: "n1", network_ids: ["n1", "n2"], waypoint_ids: ["w1"] }, 1);
    repo.upsert("cables", { id: "c2", status: "brouillon", network_id: null, network_ids: [] }, 1);   // waypoint_ids ABSENT → colonne NULL
    repo.upsert("cables", { id: "c3", status: "brouillon", network_id: "n9", network_ids: ["n9"], waypoint_ids: [] }, 1);

    // Égalité scalaire (colonne TEXT, filtre HTTP string).
    ck.eq(repo.list("cables", { where: { network_id: "n1" } }).rows.map((x) => x.id).join(","), "c1", "égalité scalaire : network_id = n1 → c1");
    // Sentinelle "null" SCALAIRE → IS NULL.
    ck.eq(repo.list("cables", { where: { network_id: "null" } }).rows.map((x) => x.id).join(","), "c2", "sentinelle null scalaire : network_id null → c2");
    // Appartenance à un champ tableau (json_each sur la colonne TEXT JSON).
    ck.eq(repo.list("cables", { where: { network_ids: "n2" } }).rows.map((x) => x.id).join(","), "c1", "appartenance tableau : n2 ∈ network_ids → c1");
    // Sentinelle "null" TABLEAU : couvre colonne NULL (champ absent, c2) ET tableau vide (c3).
    ck.eq(repo.list("cables", { where: { waypoint_ids: "null" } }).rows.map((x) => x.id).sort().join(","), "c2,c3",
      "sentinelle null tableau : NULL (c2) ET [] (c3) — les deux formes de « non rattaché »");
    // Champ INCONNU de la spec → AUCUNE ligne (1=0), valeur COMME sentinelle (décision colonnes strictes).
    ck.eq(repo.list("cables", { where: { champ_fantome: "x" } }).rows.length, 0, "champ inconnu + valeur → 0 ligne");
    ck.eq(repo.list("cables", { where: { champ_fantome: "null" } }).rows.length, 0, "champ inconnu + sentinelle null → 0 ligne (le « match tout » accidentel du blob n'est PAS reconduit)");
    // Filtres combinés (ET).
    ck.eq(repo.list("cables", { where: { network_ids: "n1", network_id: "n1" } }).rows.length, 1, "filtres combinés : ET logique");

    // PARITÉ des colonnes NON-TEXT (CAST conservé) : booléen filtré "1"/"0", jamais "true" ; "42.0" ≠ 42.
    repo.upsert("equipments", { id: "e1", name: "sw", locked: true, u_height: 42 }, 1);
    repo.upsert("equipments", { id: "e2", name: "sw2", locked: false }, 1);
    ck.eq(repo.list("equipments", { where: { locked: "1" } }).rows.map((x) => x.id).join(","), "e1", "boolean : filtre \"1\" matche true (parité blob 0/1)");
    ck.eq(repo.list("equipments", { where: { locked: "true" } }).rows.length, 0, "boolean : filtre \"true\" ne matche PAS (comparaison TEXTUELLE conservée)");
    ck.eq(repo.list("equipments", { where: { u_height: "42" } }).rows.length, 1, "number : \"42\" matche 42 (texte à texte)");
    ck.eq(repo.list("equipments", { where: { u_height: "42.0" } }).rows.length, 0, "number : \"42.0\" ne matche PAS 42 (parité CAST du blob, pas de comparaison numérique)");
    repo.close();
  }
  });

  await section("Serveur : RelationalRepository — list (pagination, tri created_date, recherche normalisée, ids)", async () => {
  {
    if (!requireSqlite()) return;
    const { RelationalRepository } = SERVER("RelationalRepository.js");
    const repo = RelationalRepository.open(":memory:", SQLITE);
    // created_date = colonne d'AUDIT (vient du record) — c'est ELLE qui porte le tri, comme dans le blob.
    repo.upsert("racks", { id: "rb", name: "Baie B", created_date: "2026-01-02T00:00:00.000Z" }, 1);
    repo.upsert("racks", { id: "ra", name: "Baie A", created_date: "2026-01-01T00:00:00.000Z" }, 1);
    repo.upsert("racks", { id: "rc", name: "Générateur Été", created_date: "2026-01-03T00:00:00.000Z" }, 1);

    const page1 = repo.list("racks", { page: 1, pageSize: 2 });
    ck.eq(page1.rows.map((x) => x.id).join(","), "ra,rb", "tri : created_date ASC (ordre d'insertion ignoré)");
    ck(page1.total === 3 && page1.pages === 2 && page1.pageSize === 2, "pagination : total 3, pages 2, pageSize 2");
    ck.eq(repo.list("racks", { page: 2, pageSize: 2 }).rows.map((x) => x.id).join(","), "rc", "pagination : page 2 → le reste");
    ck.eq(repo.list("racks", { page: 99, pageSize: 2 }).page, 2, "pagination : page hors bornes clampée");

    // Recherche q : colonne `search` normalisée à l'upsert + requête normalisée (accents/casse, normSearch).
    ck.eq(repo.list("racks", { query: "generateur" }).rows.map((x) => x.id).join(","), "rc", "q : accents APLATIS côté colonne (Générateur ← generateur)");
    ck.eq(repo.list("racks", { query: "ÉTÉ" }).rows.map((x) => x.id).join(","), "rc", "q : casse + accents normalisés côté REQUÊTE aussi");
    ck.eq(repo.list("racks", { query: "zzz" }).total, 0, "q : aucun match → total 0");

    // ids : court-circuit getMany (total = ids.length, pas de pagination).
    const byIds = repo.list("racks", { ids: ["rc", "ra"] });
    ck.eq(byIds.total, 2, "ids : total = ids.length (court-circuit getMany, parité blob)");
    ck(byIds.rows.some((x) => x.id === "ra") && byIds.rows.some((x) => x.id === "rc"), "ids : les enregistrements demandés, eux seuls");
    repo.close();
  }
  });

  await section("Serveur : RelationalRepository — list TRIÉE (sort/dir, pagination ORDONNÉE complète — lot 1b)", async () => {
  {
    if (!requireSqlite()) return;
    const { RelationalRepository } = SERVER("RelationalRepository.js");
    const repo = RelationalRepository.open(":memory:", SQLITE);
    // Corpus contacts : casse mêlée (NOCASE), organisation VIDE (garde des vides), doublon de nom (bris
    // d'égalité id), created_date à rebours de l'ordre alphabétique (prouve que le tri ne suit PAS le défaut).
    repo.upsert("contacts", { id: "c1", name: "Zoé",    organization: "Beta",  created_date: "2026-01-01T00:00:00.000Z" }, 1);
    repo.upsert("contacts", { id: "c2", name: "albert", organization: "",      created_date: "2026-01-02T00:00:00.000Z" }, 1);
    repo.upsert("contacts", { id: "c3", name: "Bruno",  organization: "Alpha", created_date: "2026-01-03T00:00:00.000Z" }, 1);
    repo.upsert("contacts", { id: "c5", name: "Bruno",  organization: "Alpha", created_date: "2026-01-04T00:00:00.000Z" }, 1);
    repo.upsert("contacts", { id: "c4", name: "Alice",  organization: "Gamma", created_date: "2026-01-05T00:00:00.000Z" }, 1);

    // -- Le CORPUS entier est ordonné, pas la page : la découpe SUIT le critère. --
    ck.eq(repo.list("contacts", { sort: "name", dir: "asc" }).rows.map((x) => x.id).join(","), "c2,c4,c3,c5,c1",
      "🎯 sort=name asc : albert < Alice < Bruno < Bruno < Zoé — NOCASE (« albert » ne trie pas après « Zoé »), doublon départagé par id");
    ck.eq(repo.list("contacts", { sort: "name", dir: "desc" }).rows.map((x) => x.id).join(","), "c1,c3,c5,c4,c2",
      "sort=name desc : ordre inverse, bris d'égalité id TOUJOURS ASC (c3 avant c5 — ordre total stable dans les deux sens)");
    ck.eq(repo.list("contacts", { sort: "name", dir: "asc", page: 2, pageSize: 2 }).rows.map((x) => x.id).join(","), "c3,c5",
      "🎯 pagination : la page 2 continue l'ordre du critère (découpe stable — ni doublon ni omission aux frontières)");

    // -- Garde des VIDES : extrémité « plus grand », comme le tri client (derniers en asc, premiers en desc). --
    ck.eq(repo.list("contacts", { sort: "organization", dir: "asc" }).rows.map((x) => x.id).join(","), "c3,c5,c1,c4,c2",
      "sort=organization asc : Alpha,Alpha,Beta,Gamma puis la VIDE en DERNIER (parité core/Sort : nuls en dernier)");
    ck.eq(repo.list("contacts", { sort: "organization", dir: "desc" }).rows.map((x) => x.id).join(","), "c2,c4,c1,c3,c5",
      "sort=organization desc : la vide en PREMIER (le garde suit la direction — parité ListView, r*dir)");

    // -- Défaut inchangé + audit triable + refus hors liste. --
    ck.eq(repo.list("contacts", {}).rows.map((x) => x.id).join(","), "c1,c2,c3,c5,c4",
      "🎯 SANS sort : created_date ASC, id ASC — le comportement historique, verbatim");
    ck.eq(repo.list("contacts", { sort: "created_date", dir: "desc" }).rows.map((x) => x.id).join(","), "c4,c5,c3,c2,c1",
      "sort=created_date desc : les colonnes d'AUDIT sont triables (critère « Date de création » des listings)");
    const throws = (fn) => { try { fn(); return null; } catch (e) { return String(e.message || e); } };
    ck(/colonne de tri invalide/.test(throws(() => repo.list("contacts", { sort: 'name"; DROP TABLE contacts;--' }))),
      "🎯 injection : le dépôt REFUSE (throw) un sort hors liste blanche — la route, elle, pré-valide en 400");
    ck(/direction de tri invalide/.test(throws(() => repo.list("contacts", { sort: "name", dir: "sideways" }))),
      "direction inconnue : refusée aussi");
    ck.eq(repo.list("contacts", { ids: ["c1", "c4"], sort: "name" }).total, 2,
      "ids : court-circuit getMany AVANT le tri (aucun contrat d'ordre — inchangé)");
    repo.close();
  }
  });

  await section("Serveur : RelationalRepository — facetValues (SELECT DISTINCT, garde G8 lazy-load vague 3)", async () => {
  {
    if (!requireSqlite()) return;
    const { RelationalRepository } = SERVER("RelationalRepository.js");
    const repo = RelationalRepository.open(":memory:", SQLITE);
    // Corpus wifi : deux SSID dont un DOUBLON, une casse mêlée sur le type (« wireless »/« WIRELESS »),
    // un SSID VIDE et un NULL — les quatre cas que la sémantique du DISTINCT doit trancher.
    repo.upsert("wifiClients", { id: "w1", ssid: "Corp",  client_type: "WIRELESS" }, 1);
    repo.upsert("wifiClients", { id: "w2", ssid: "Guest", client_type: "wireless" }, 1);
    repo.upsert("wifiClients", { id: "w3", ssid: "Corp",  client_type: "WIRED" }, 1);
    repo.upsert("wifiClients", { id: "w4", ssid: "",      client_type: "WIRED" }, 1);
    repo.upsert("wifiClients", { id: "w5", ssid: null,    client_type: null }, 1);

    ck.eq(repo.facetValues("wifiClients", "ssid").values.join(","), "Corp,Guest",
      "🎯 DISTINCT : doublon fondu, chaîne VIDE et NULL EXCLUS (parité du `if (v)` des options locales)");
    ck.eq(repo.facetValues("wifiClients", "client_type").values.join(","), "WIRED,WIRELESS,wireless",
      "🎯 DISTINCT sensible à la CASSE : « wireless » ≠ « WIRELESS ». Les replier donnerait un identifiant d'option qui ne matcherait que la moitié des lignes (le filtre compare par ÉGALITÉ EXACTE)");
    ck.eq(repo.facetValues("wifiClients", "ssid").truncated, false, "sous le plafond : `truncated` faux");

    // -- PLAFOND : LIMIT cap+1 → la ligne excédentaire signale la troncature sans COUNT(DISTINCT …). --
    const capped = repo.facetValues("wifiClients", "ssid", 1);
    ck.eq(capped.values.length, 1, "plafond : la liste est tronquée à la limite demandée");
    ck.eq(capped.truncated, true, "🎯 … et la troncature est SIGNALÉE (une facette qui l'atteint n'en est pas une)");

    // -- BARRIÈRE anti-injection (défense en profondeur : la route pré-valide déjà en 400). --
    const throws = (fn) => { try { fn(); return null; } catch (e) { return String(e.message || e); } };
    ck(/colonne de facette invalide/.test(throws(() => repo.facetValues("wifiClients", 'ssid"; DROP TABLE wifiClients;--'))),
      "🎯 injection : le dépôt REFUSE (throw) un champ hors liste blanche — jamais d'interpolation");
    ck(/colonne de facette invalide/.test(throws(() => repo.facetValues("wifiClients", "orphan"))),
      "colonne non facettable (boolean) : refusée aussi");
    ck.eq(repo.facetValues("inconnue", "ssid").values.length, 0, "collection inconnue → résultat vide (la route répond déjà 404)");
    repo.close();
  }
  });

  await section("Serveur : RelationalRepository — findBy, verrou optimiste, transact ATOMIQUE, snapshot (Q7), meta, images", async () => {
  {
    if (!requireSqlite()) return;
    const { RelationalRepository } = SERVER("RelationalRepository.js");
    const repo = RelationalRepository.open(":memory:", SQLITE);

    // -- findBy : le finder LEAN de la validation (V5b/V6), sur colonnes. --
    repo.upsert("ports", { id: "p1", equipment_id: "e1", network_ids: ["n5"] }, 3);
    ck.eq(repo.findBy("ports", "equipment_id", "e1").length, 1, "findBy : égalité scalaire");
    ck.eq(repo.findBy("ports", "network_ids", "n5").length, 1, "findBy : appartenance tableau");
    ck.eq(repo.findBy("ports", "equipment_id", "zzz").length, 0, "findBy : aucune correspondance → []");
    ck.eq(repo.findBy("NIMPORTE", "x", "y").length, 0, "findBy : collection inconnue → []");
    ck.eq(repo.findBy("ports", "champ_fantome", "x").length, 0, "findBy : champ inconnu → [] (1=0)");

    // -- Verrou optimiste par entité (updated_rev estampillée à l'upsert). --
    ck.eq(repo.conflicts([{ collection: "ports", id: "p1" }], 2).length, 1, "verrou : écrite en rev 3 > baseRev 2 → conflit");
    ck.eq(repo.conflicts([{ collection: "ports", id: "p1" }], 3).length, 0, "verrou : baseRev à jour → pas de conflit");
    ck.eq(repo.conflicts([{ collection: "ports", id: "absent" }], 0).length, 0, "verrou : entité absente → pas de conflit");
    ck.eq(repo.conflicts([{ collection: "PAS_UNE_TABLE", id: "p1" }], 0).length, 0, "verrou : collection hors liste blanche ignorée");

    // -- transact : ordre deletes → updates → creates + rev estampillée. --
    repo.upsert("racks", { id: "r1", name: "Vieille" }, 1);
    repo.transact({ deletes: [{ collection: "racks", id: "r1" }], creates: [{ collection: "racks", record: { id: "r2", name: "Neuve" } }] }, 5);
    ck.eq(repo.getOne("racks", "r1"), null, "transact : delete appliqué");
    ck(!!repo.getOne("racks", "r2"), "transact : create appliqué");
    ck.eq(repo.conflicts([{ collection: "racks", id: "r2" }], 4).length, 1, "transact : rev du lot estampillée sur les écritures");
    // ATOMICITÉ : une erreur au MILIEU du lot ne laisse RIEN (le create valide qui précède est annulé).
    let batchThrew = false;
    try { repo.transact({ creates: [{ collection: "racks", record: { id: "r3", name: "OK" } }, { collection: "NIMPORTE", record: { id: "x" } }] }, 6); } catch (_) { batchThrew = true; }
    ck(batchThrew && repo.getOne("racks", "r3") === null, "transact : erreur au milieu → TOUT le lot rejeté (r3 annulé par la transaction)");

    // -- replaceSnapshot : DELETE all + réinsert rev 0, audit VERBATIM (Q7), meta remplacée. --
    repo.setMeta({ layout: "avant" });
    repo.replaceSnapshot({
      racks: [{ id: "s1", name: "Snap", created_by: "u-alice", created_date: "2020-01-01T00:00:00.000Z" }],
      meta: { layout: "après" },
    }, 0);
    ck.eq(repo.getOne("racks", "r2"), null, "snapshot : l'existant de la collection remplacé");
    ck.eq(repo.getOne("ports", "p1"), null, "snapshot : les AUTRES collections vidées aussi");
    const s1 = repo.getOne("racks", "s1");
    ck(!!s1 && s1.created_by === "u-alice" && s1.created_date === "2020-01-01T00:00:00.000Z", "snapshot : audit restauré VERBATIM (Q7 — pas de ré-estampillage)");
    ck.eq(repo.conflicts([{ collection: "racks", id: "s1" }], 0).length, 0, "snapshot : rev 0 (non versionné) → aucun conflit");
    ck.eq(repo.getMeta().layout, "après", "snapshot : meta remplacée");

    // -- meta : aller-retour simple. --
    repo.setMeta({ graphe: { zoom: 2 } });
    ck.eq(repo.getMeta().graphe.zoom, 2, "meta : aller-retour JSON");

    // -- images : put/get/list/del + PURGE par maintenance SUR LES COLONNES face_image_*_id. --
    repo.putImage("imgA", { name: "utilisée", type: "image/png" }, Buffer.from([1, 2, 3]));
    repo.putImage("imgB", { name: "orpheline", type: "image/png" }, Buffer.from([4, 5, 6]));
    // Référence par un champ NON-premier de la liste partagée → prouve le SELECT multi-colonnes.
    repo.upsert("equipments", { id: "e9", name: "sw", face_image_rear_id: "imgA" }, 1);
    ck.eq(repo.getImageBlob("imgA").blob.length, 3, "images : blob relu (3 octets)");
    ck.eq(repo.listImages().length, 2, "images : listing complet");
    const mnt = repo.maintenance();
    ck.eq(mnt.purgedImages, 1, "maintenance : 1 orpheline purgée (références lues SUR LES COLONNES face_image_*_id)");
    ck(!!repo.getImageMeta("imgA") && repo.getImageMeta("imgB") === null, "maintenance : référencée (face_image_rear_id) conservée, orpheline supprimée");
    ck.eq(repo.maintenance().purgedImages, 0, "maintenance : idempotente (re-run → rien)");
    repo.deleteImage("imgA");
    ck.eq(repo.getImageMeta("imgA"), null, "images : delete");
    repo.close();
  }
  });

  await section("Serveur : RelationalRepository — 🎯 EXPLAIN QUERY PLAN : USING INDEX sur le chemin chaud, SCAN en contre-épreuve", async () => {
  {
    if (!requireSqlite()) return;
    const { RelationalRepository } = SERVER("RelationalRepository.js");
    const repo = RelationalRepository.open(":memory:", SQLITE);
    repo.upsert("equipments", { id: "e1", name: "srv-1", brand: "hp" }, 1);
    repo.upsert("ports", { id: "p1", equipment_id: "e1" }, 1);

    // `explainFindBy` rejoue le SQL EXACT de findBy (factorisation interne) — le plan prouvé est celui
    // du chemin réellement exécuté, pas d'une reconstruction du test qui pourrait diverger.
    const planName = repo.explainFindBy("equipments", "name", "srv-1").join(" | ");
    console.log("    plan equipments.name    : " + planName);
    ck(planName.includes("USING INDEX idx_equipments_name"), "🎯 findBy(equipments, name) → SEARCH USING INDEX idx_equipments_name (unicité V6g indexée — le gain du chantier)");

    const planFk = repo.explainFindBy("ports", "equipment_id", "e1").join(" | ");
    console.log("    plan ports.equipment_id : " + planFk);
    ck(planFk.includes("USING INDEX idx_ports_equipment_id"), "🎯 findBy(ports, equipment_id) → SEARCH USING INDEX idx_ports_equipment_id (FK du chemin chaud)");

    // CONTRE-ÉPREUVE : un champ hors INDEX_SPEC (equipments.brand) → SCAN, aucun index. Elle prouve que
    // les deux verts ci-dessus mesurent bien l'INDEX (et pas un artefact du plan sur table minuscule).
    const planScan = repo.explainFindBy("equipments", "brand", "hp").join(" | ");
    console.log("    plan equipments.brand   : " + planScan);
    ck(planScan.includes("SCAN") && !planScan.includes("USING INDEX"), "contre-épreuve : findBy(equipments, brand) non indexé → SCAN (pas d'index)");

    // Le résultat du findBy indexé reste CORRECT (l'index sert la même sémantique).
    ck.eq(repo.findBy("equipments", "name", "srv-1").length, 1, "l'égalité indexée renvoie bien la ligne (sémantique intacte)");
    repo.close();
  }
  });
};
