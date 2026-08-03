/* Tests modules — ÉVOLUTION ADDITIVE du schéma relationnel (lot A sous-équipements v2).
   ----------------------------------------------------------------------------
   Prouve que quand la SPEC gagne un champ, une base relationnelle DÉJÀ créée le rattrape à
   l'ouverture (`RelationalRepository.open` → ensureSpecColumns) — sans ce mécanisme, la première
   évolution de spec depuis la bascule relationnelle rendait toute base existante inécrivable
   (« table X has no column named Y » → 400 systématique), voire INOUVRABLE si le champ est indexé
   (cadrage `.notes/toDos/sous-equipements-achat-garantie-listing-cadrage-2026-08-03.md` §2.3).
   - primitive PURE `RelationalSchema.missingColumns` : golden ALTER explicites, jamais de NOT NULL,
     colonnes orphelines ignorées, ordre de spec ;
   - fixture FICHIER RÉEL (os.tmpdir(), better-sqlite3 RÉEL) « base d'avant » : une base au schéma
     courant AMPUTÉE de colonnes en SQL BRUT (ALTER TABLE … DROP COLUMN) — l'équivalent exact d'une
     base créée quand la spec ne connaissait pas encore ces champs ;
   - réouverture : colonne ajoutée, DÉFAUT de spec backfillé (string ""/tableau []/booléen true→1),
     nullable resté NULL, `updated_rev`/audit INTACTS, upsert qui remarche (la sonde de
     DISCRIMINATION naturelle : sans le mécanisme, le prepare de l'upsert lève), champ requis ajouté
     SANS NOT NULL + WARN ;
   - colonne manquante ET INDEXÉE : l'ouverture ne lève plus (ordre tables → colonnes → index) et
     le plan d'exécution prouve USING INDEX après coup ;
   - idempotence (réouverture → aucun ALTER, aucun log) et base NEUVE inchangée (aucun ALTER émis).
   Harnais et assertions : harness.js. */
"use strict";
const fs = require("fs");
const os = require("os");
const { ck, section, path, SHARED, SERVER, Validation } = require("./harness.js");

/* -------- better-sqlite3 RÉEL (src-server/node_modules) --------
   Même politique que les lots L2/L3/L4 : l'indisponibilité est un ÉCHEC avec message actionnable,
   jamais un saut silencieux — le mécanisme protège le chemin d'ÉCRITURE de production. */
let SQLITE = null, SQLITE_ERROR = "";
try {
  const candidatePath = path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3");
  const Candidate = require(candidatePath);
  new Candidate(":memory:").close();
  SQLITE = Candidate;
} catch (e) { SQLITE_ERROR = ((e && e.message) || String(e)).split("\n")[0]; }
const requireSqlite = () => {
  if (SQLITE) return true;
  ck(false, "better-sqlite3 RÉEL indisponible (" + SQLITE_ERROR + ") — `npm install` (ou `npm rebuild better-sqlite3`) dans src-server/ ; ce test ÉCHOUE au lieu de sauter");
  return false;
};

/** Logger CAPTURANT (duck-typé sur la classe serveur) : silencieux, les tests assertent ce qui a
    été journalisé (une ligne info par colonne ajoutée, WARN du champ requis, SILENCE à la réouverture). */
const mkLog = () => {
  const calls = { error: [], warn: [], info: [], debug: [], trace: [] };
  const push = (level) => (...a) => calls[level].push(a.map(String).join(" "));
  return { calls, error: push("error"), warn: push("warn"), info: push("info"), debug: push("debug"), trace: push("trace"),
    child() { return this; } };
};

/** AMPUTE une base relationnelle de colonnes, en SQL BRUT (fixture « base d'avant ») : une base créée
    par une spec ANTÉRIEURE est exactement la base courante SANS les colonnes ajoutées depuis — les
    records y ont été écrits sans jamais porter ces champs. `statements` inclut les DROP INDEX
    éventuels (SQLite refuse de retirer une colonne encore indexée). Checkpoint avant fermeture pour
    que le fichier soit complet (pas de -wal orphelin), comme les autres fixtures fichier. */
const amputate = (file, statements) => {
  const db = new SQLITE(file);
  try {
    for (const sql of statements) db.exec(sql);
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally { db.close(); }
};

/** Noms de colonnes d'une table (PRAGMA table_info) — pour prouver l'état de la fixture. */
const columnsOf = (file, table) => {
  const db = new SQLITE(file);
  try { return db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name); }
  finally { db.close(); }
};

/** Valeur SQL BRUTE d'une colonne d'une ligne (sans re-typage `rebuild`) — pour prouver la
    SÉRIALISATION du backfill (booléen stocké 1, tableau stocké '[]') et l'`updated_rev` intact. */
const rawCell = (file, table, id, column) => {
  const db = new SQLITE(file);
  try { return db.prepare(`SELECT "${column}" AS v FROM "${table}" WHERE id = ?`).get(id).v; }
  finally { db.close(); }
};

module.exports = async () => {
  await section("shared : RelationalSchema.missingColumns — diff PUR colonnes existantes ⇄ spec (golden ALTER, jamais NOT NULL)", async () => {
  {
    const { RelationalSchema } = SHARED("src-shared/RelationalSchema.js");
    const COLLECTION_SPECS = Validation.COLLECTION_SPECS;
    const specFields = (collection) => Object.keys(COLLECTION_SPECS[collection].fields);
    // Colonnes « complètes » d'une table à jour : champs de spec + colonnes fixes du DDL (id/audit/
    // search/updated_rev) — missingColumns ne diffe que la spec, les fixes ne comptent pas.
    const fullColumns = (collection) => ["id", ...specFields(collection), "created_by", "updated_by", "created_date", "updated_date", "search", "updated_rev"];

    // Table À JOUR → diff VIDE (le chemin de TOUTES les ouvertures courantes).
    ck.eq(RelationalSchema.missingColumns("subEquipments", fullColumns("subEquipments")).length, 0, "diff : table à jour → aucun ALTER");

    // GOLDEN : il manque `slot` → UN ALTER, chaîne EXACTE écrite en clair (recette maison : attente
    // explicite, jamais dérivée du générateur qu'on juge).
    const sansSlot = fullColumns("subEquipments").filter((c) => c !== "slot");
    const slotDiff = RelationalSchema.missingColumns("subEquipments", sansSlot);
    ck.eq(JSON.stringify(slotDiff), JSON.stringify([{ field: "slot", ddl: 'ALTER TABLE "subEquipments" ADD COLUMN "slot" TEXT' }]),
      "golden : subEquipments sans slot → ALTER TABLE ADD COLUMN slot TEXT (quoté, sans NOT NULL)");

    // AFFINITÉS : number → NUMERIC, boolean → INTEGER, string[] → TEXT (mêmes que tableDdl) ; et
    // l'ORDRE de sortie est celui de la DÉCLARATION de la spec (comme les colonnes du DDL neuf).
    const racksAmputee = fullColumns("racks").filter((c) => !["u_count", "has_caps", "roof_cells"].includes(c));
    const racksDiff = RelationalSchema.missingColumns("racks", racksAmputee);
    ck.eq(racksDiff.map((m) => m.field).join(","), "u_count,has_caps,roof_cells", "diff : champs manquants rendus dans l'ORDRE de la spec");
    ck.eq(racksDiff[0].ddl, 'ALTER TABLE "racks" ADD COLUMN "u_count" NUMERIC', "affinité : number → NUMERIC");
    ck.eq(racksDiff[1].ddl, 'ALTER TABLE "racks" ADD COLUMN "has_caps" INTEGER', "affinité : boolean → INTEGER");
    ck.eq(racksDiff[2].ddl, 'ALTER TABLE "racks" ADD COLUMN "roof_cells" TEXT', "affinité : string[] → TEXT (JSON)");

    // Champ REQUIS : l'ALTER ne porte JAMAIS `NOT NULL` (SQLite l'interdit sans DEFAULT sur table
    // peuplée) — la contrainte n'existe que sur les tables neuves, la validation partagée est l'autorité.
    const sansName = fullColumns("equipments").filter((c) => c !== "name");
    const nameDiff = RelationalSchema.missingColumns("equipments", sansName);
    ck.eq(nameDiff.length, 1, "requis : equipments sans name → un ALTER quand même (colonne ajoutée sans contrainte)");
    ck.eq(nameDiff[0].ddl, 'ALTER TABLE "equipments" ADD COLUMN "name" TEXT', "requis : ALTER SANS NOT NULL (le DDL neuf, lui, le porte)");
    ck(!nameDiff.some((m) => m.ddl.includes("NOT NULL")), "requis : aucun NOT NULL dans aucun ALTER émis");

    // Identifiant mot-clé SQL : quotage (même robustesse que tableDdl — racks.row).
    const sansRow = fullColumns("racks").filter((c) => c !== "row");
    ck.eq(RelationalSchema.missingColumns("racks", sansRow)[0].ddl, 'ALTER TABLE "racks" ADD COLUMN "row" TEXT', "quotage : racks.row (mot-clé SQL) entre guillemets doubles");

    // Colonne ORPHELINE (présente en base, absente de la spec) : IGNORÉE — le retrait de champ est
    // hors périmètre, l'upsert dérivé de la spec ne la nomme jamais (inoffensive).
    ck.eq(RelationalSchema.missingColumns("subEquipments", [...fullColumns("subEquipments"), "colonne_fantome"]).length, 0,
      "orpheline : colonne inconnue en base → aucun ALTER (ajout seulement, jamais de retrait)");

    // Collection inconnue → erreur explicite (même garde que tableDdl/indexDdls).
    let threw = false;
    try { RelationalSchema.missingColumns("inconnue", []); } catch (e) { threw = true; }
    ck(threw, "garde : missingColumns(collection inconnue) lève une erreur");
  }
  });

  await section("Serveur : évolution additive — colonne de spec manquante (subEquipments) : ALTER + backfill des DÉFAUTS, audit/rev intacts, upsert qui remarche", async () => {
  {
    if (!requireSqlite()) return;
    const { RelationalRepository } = SERVER("RelationalRepository.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-evol-"));
    const file = path.join(dir, "doc-ampute.db");
    try {
      // -- Base au schéma COURANT + un record avec audit et rev variée, puis AMPUTATION en SQL brut :
      //    l'état exact d'une base créée quand la spec ne connaissait ni `slot` ni `group_ids`. --
      const writer = RelationalRepository.open(file, SQLITE);
      writer.upsert("subEquipments", {
        id: "se1", name: "Drive LTO-9", equipment_id: "eq1", brand: "IBM", serial: "SN-1",
        created_by: "u-alice", created_date: "2026-01-01T00:00:00.000Z",
      }, 5);
      writer.close();
      amputate(file, [
        'ALTER TABLE "subEquipments" DROP COLUMN "slot"',
        'ALTER TABLE "subEquipments" DROP COLUMN "group_ids"',
      ]);
      const before = columnsOf(file, "subEquipments");
      ck(!before.includes("slot") && !before.includes("group_ids"), "fixture : colonnes ABSENTES avérées (base « d'avant » en SQL brut)");

      // -- Réouverture = LE mécanisme : ALTER + backfill des défauts, en une transaction. --
      const log = mkLog();
      const repo = RelationalRepository.open(file, SQLITE, log);
      const se1 = repo.getOne("subEquipments", "se1");
      ck.eq(se1.slot, "", "backfill : slot relu \"\" (le DÉFAUT de spec) — PAS null (parité avec le mode fichier)");
      ck.eq(JSON.stringify(se1.group_ids), "[]", "backfill : group_ids relu [] (défaut tableau, re-typé depuis '[]')");
      ck.eq(rawCell(file, "subEquipments", "se1", "group_ids"), "[]", "backfill : tableau SÉRIALISÉ comme à l'écriture (colonne TEXT = '[]')");
      ck(se1.name === "Drive LTO-9" && se1.brand === "IBM", "backfill : les champs existants n'ont pas bougé");
      ck.eq(se1.created_by, "u-alice", "audit : created_by INTACT (l'UPDATE de backfill ne nomme que la colonne neuve)");
      ck.eq(rawCell(file, "subEquipments", "se1", "updated_rev"), 5, "verrou : updated_rev INTACTE (pas de faux 409 — même discipline que le backfill search)");
      ck.eq(log.calls.info.filter((l) => /colonne de spec ajoutée/.test(l)).length, 2, "log : UNE ligne info par colonne ajoutée (2)");
      ck(log.calls.info.some((l) => /subEquipments\.slot/.test(l)) && log.calls.info.some((l) => /subEquipments\.group_ids/.test(l)),
        "log : chaque ligne NOMME collection.colonne");
      ck.eq(log.calls.warn.length, 0, "log : aucun WARN (champs non requis)");

      // -- 🎯 SONDE DE DISCRIMINATION : l'ÉCRITURE remarche. Sans le mécanisme, l'upsert préparé
      //    (colonnes dérivées de la spec) lèverait « table subEquipments has no column named slot »
      //    au prepare → 400 systématique dès le premier POST/PUT/transact (comportement mesuré §2.3). --
      repo.upsert("subEquipments", { id: "se1", name: "Drive LTO-9", equipment_id: "eq1", slot: "Baie 3", group_ids: ["g1"] }, 6);
      const rewritten = repo.getOne("subEquipments", "se1");
      ck(rewritten.slot === "Baie 3" && rewritten.group_ids.length === 1, "🎯 discrimination : l'upsert POST-évolution écrit et relit les colonnes ajoutées");
      repo.close();

      // -- IDEMPOTENCE : le diff pragma ⇄ spec est VIDE au run suivant — aucun ALTER, aucun log. --
      const logAgain = mkLog();
      const again = RelationalRepository.open(file, SQLITE, logAgain);
      ck.eq(logAgain.calls.info.filter((l) => /colonne de spec ajoutée/.test(l)).length, 0, "idempotence : réouverture → aucun ALTER (le diff EST le marqueur, pas de SCHEMA_VERSION)");
      ck.eq(again.getOne("subEquipments", "se1").slot, "Baie 3", "idempotence : les valeurs écrites après évolution survivent");
      again.close();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* dossier temp (handles longs sous Windows) */ }
    }
  }
  });

  await section("Serveur : évolution additive — colonne manquante ET INDEXÉE (equipments.name) : l'ouverture ne lève plus, index créé APRÈS l'ALTER, WARN du requis", async () => {
  {
    if (!requireSqlite()) return;
    const { RelationalRepository } = SERVER("RelationalRepository.js");
    const { RelationalSchema } = SHARED("src-shared/RelationalSchema.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-evolidx-"));
    const file = path.join(dir, "doc-index.db");
    try {
      const writer = RelationalRepository.open(file, SQLITE);
      writer.upsert("equipments", { id: "eq1", name: "Cœur réseau", type: "switch" }, 3);
      writer.close();
      // Amputation de `name` : l'index doit tomber d'abord (SQLite refuse de retirer une colonne indexée) —
      // la base résultante est celle d'une spec qui n'aurait connu ni le champ NI son entrée INDEX_SPEC.
      amputate(file, [
        'DROP INDEX "idx_equipments_name"',
        'ALTER TABLE "equipments" DROP COLUMN "name"',
      ]);
      ck(!columnsOf(file, "equipments").includes("name"), "fixture : colonne name ABSENTE avérée");

      // -- 🎯 SONDE DE DISCRIMINATION : SANS l'ALTER interposé, le CREATE INDEX du champ lève —
      //    c'est le no-go « document INOUVRABLE » mesuré au cadrage §2.3 (on rejoue le DDL réel). --
      const probe = new SQLITE(file);
      let indexError = "";
      try { for (const ddl of RelationalSchema.indexDdls("equipments")) probe.exec(ddl); }
      catch (e) { indexError = String((e && e.message) || e); }
      finally { probe.close(); }
      ck(/no such column/.test(indexError), "🎯 discrimination : CREATE INDEX avant l'ALTER → « no such column » (l'ordre tables → colonnes → index est vital)");

      // -- Réouverture : ne lève PLUS (l'ALTER court entre tables et index). --
      const log = mkLog();
      const repo = RelationalRepository.open(file, SQLITE, log);
      const eq1 = repo.getOne("equipments", "eq1");
      ck(eq1.name === null && eq1.type === "switch", "requis sans défaut : name relu null (on n'INVENTE pas de valeur — migration à la main si besoin), le reste intact");
      ck.eq(rawCell(file, "equipments", "eq1", "updated_rev"), 3, "verrou : updated_rev INTACTE");
      ck(log.calls.warn.some((l) => /NOT NULL/.test(l) && /equipments\.name/.test(l)),
        "log : WARN explicite — champ requis ajouté sans NOT NULL (contrainte portée par les tables neuves seulement)");
      // L'index du champ rattrapé EXISTE et SERT (créé après l'ALTER) — gabarit test-legacy-migration.
      const plan = repo.explainFindBy("equipments", "name", "Cœur réseau").join(" | ");
      ck(plan.includes("USING INDEX idx_equipments_name"), "🎯 index : findBy(equipments, name) → SEARCH USING INDEX après évolution");
      repo.close();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* dossier temp */ }
    }
  }
  });

  await section("Serveur : évolution additive — défauts NON-string (boolean 1/0, number nullable) + base NEUVE inchangée", async () => {
  {
    if (!requireSqlite()) return;
    const { RelationalRepository } = SERVER("RelationalRepository.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-evoltypes-"));
    const file = path.join(dir, "doc-types.db");
    try {
      const writer = RelationalRepository.open(file, SQLITE);
      writer.upsert("ports", { id: "p1", name: "Gi0/1", equipment_id: "eq1" }, 4);
      writer.close();
      // poe_enabled (boolean, default true) et poe_budget_w (number, nullable/default null) — ni l'un
      // ni l'autre indexés : l'amputation ne touche aucun index.
      amputate(file, [
        'ALTER TABLE "ports" DROP COLUMN "poe_enabled"',
        'ALTER TABLE "ports" DROP COLUMN "poe_budget_w"',
      ]);

      const log = mkLog();
      const repo = RelationalRepository.open(file, SQLITE, log);
      ck.eq(rawCell(file, "ports", "p1", "poe_enabled"), 1, "backfill : boolean default true → 1 en colonne (sérialisation toColumn, comme à l'écriture)");
      const p1 = repo.getOne("ports", "p1");
      ck.eq(p1.poe_enabled, true, "backfill : relu true (re-typé booléen par rebuild — jamais un 1 brut)");
      ck.eq(rawCell(file, "ports", "p1", "poe_budget_w"), null, "nullable : number default null → resté NULL (aucun backfill — NULL est déjà correct)");
      ck.eq(p1.poe_budget_w, null, "nullable : relu null");
      ck.eq(log.calls.info.filter((l) => /colonne de spec ajoutée/.test(l)).length, 2, "log : 2 colonnes ajoutées (backfillée ou non, l'ALTER est journalisé)");
      // Le filtre serveur sur le champ rattrapé marche (whereClause préparait un SQL sur colonne
      // manquante → 500 avant le mécanisme) ; parité blob : booléen filtré "1"/"0".
      ck.eq(repo.findBy("ports", "poe_enabled", "1").map((r) => r.id).join(","), "p1", "filtre : findBy sur la colonne ajoutée → le record backfillé");
      repo.close();

      // -- Base NEUVE : le DDL des tables porte déjà toutes les colonnes → diff vide, AUCUN ALTER émis. --
      const freshLog = mkLog();
      const fresh = RelationalRepository.open(path.join(dir, "doc-neuf.db"), SQLITE, freshLog);
      ck.eq(freshLog.calls.info.filter((l) => /colonne de spec ajoutée/.test(l)).length, 0, "base neuve : aucun ALTER, aucun log (comportement inchangé)");
      ck.eq(freshLog.calls.warn.length, 0, "base neuve : aucun WARN");
      fresh.upsert("subEquipments", { id: "se-n", name: "Neuf", equipment_id: "eq-n", slot: "A" }, 1);
      ck.eq(fresh.getOne("subEquipments", "se-n").slot, "A", "base neuve : écriture/lecture nominales");
      fresh.close();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* dossier temp */ }
    }
  }
  });
};
