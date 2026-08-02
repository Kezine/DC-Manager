/* Tests modules — MIGRATION LEGACY blob → relationnel + BASCULE DocumentStore (lot L4 migration DB).
   ----------------------------------------------------------------------------
   Prouve le chemin de PRODUCTION de la bascule (src-server/LegacyMigration + DocumentStore.repo()) sur
   better-sqlite3 RÉEL et de VRAIS fichiers (os.tmpdir(), nettoyés — JAMAIS dans l'arbre du dépôt,
   dossier synchronisé) :
   - migration NOMINALE d'une fixture legacy construite en SQL BRUT (ancien format `(id, data, search,
     created_date, updated_rev)`) : backup `.pre-relationnel.bak` AUTO-SUFFISANT et relisible en ANCIEN
     format, records re-lus NORMALISÉS (défauts posés), clés legacy/inconnues PURGÉES, `updated_rev`
     préservée RECORD PAR RECORD, meta/images INTACTES, réouverture IDEMPOTENTE (pas de re-migration,
     `.bak` jamais écrasé), `USING INDEX` post-migration ;
   - migration en ÉCHEC (record sans champ `required`) : erreur NOMMANT collection/id (l'erreur SQL brute
     ne nomme que la colonne — consigne L3), transaction annulée EN BLOC (fichier resté LISIBLE en
     legacy, rien de perdu), `.bak` présent ;
   - base NEUVE : schéma relationnel DIRECT, aucun `.bak`, aucun log de migration ;
   - BASCULE : `DocumentStore.repo()` rend bien l'implémentation RELATIONNELLE (clé inconnue ignorée à
     l'écriture — le blob l'aurait stockée — + sonde `explainFindBy`).
   Harnais et assertions : harness.js. */
"use strict";
const fs = require("fs");
const os = require("os");
const { ck, section, path, SERVER, SharedSchema } = require("./harness.js");

/* -------- better-sqlite3 RÉEL (src-server/node_modules) --------
   Même politique que les lots L2/L3 : l'indisponibilité est un ÉCHEC avec message actionnable, jamais
   un saut silencieux — un skip ferait passer la bascule de PRODUCTION sans une seule preuve. */
let SQLITE = null, SQLITE_ERROR = "";
try {
  const candidatePath = path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3");
  const Candidate = require(candidatePath);
  new Candidate(":memory:").close();
  SQLITE = Candidate;
} catch (e) { SQLITE_ERROR = ((e && e.message) || String(e)).split("\n")[0]; }
const requireSqlite = () => {
  if (SQLITE) return true;
  ck(false, "better-sqlite3 RÉEL indisponible (" + SQLITE_ERROR + ") — `npm install` (ou `npm rebuild better-sqlite3`) dans src-server/ ; ce test ÉCHOUE au lieu de sauter (lot L4)");
  return false;
};

/** Logger CAPTURANT (duck-typé sur la classe serveur) : silencieux, et les tests peuvent asserter
    ce qui a été journalisé (warn du `.bak` préexistant, ABSENCE de log de migration sur base neuve). */
const mkLog = () => {
  const calls = { error: [], warn: [], info: [], debug: [], trace: [] };
  const push = (level) => (...a) => calls[level].push(a.map(String).join(" "));
  return { calls, error: push("error"), warn: push("warn"), info: push("info"), debug: push("debug"), trace: push("trace"),
    child() { return this; } };
};

/** Construit un fichier legacy (ANCIEN format blob) en SQL BRUT — AUCUNE dépendance à la classe
    `Repository` : la fixture doit survivre au retrait du blob (L5). `records` = { collection: [[record,
    rev], …] } ; `meta`/`image` optionnels. La colonne `search` reçoit un texte arbitraire : la migration
    la RECALCULE (elle ne se copie pas). */
const buildLegacyFile = (file, records, { meta = null, image = null } = {}) => {
  const db = new SQLITE(file);
  db.pragma("journal_mode = WAL");   // comme la prod (le checkpoint pré-backup a donc du travail réel)
  for (const c of SharedSchema.COLLECTIONS) {
    db.exec(`CREATE TABLE IF NOT EXISTS "${c}" (id TEXT PRIMARY KEY, data TEXT NOT NULL, search TEXT NOT NULL DEFAULT '', created_date TEXT, updated_rev INTEGER NOT NULL DEFAULT 0)`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, meta TEXT NOT NULL, blob BLOB, bytes INTEGER NOT NULL DEFAULT 0)`);
  for (const [collection, rows] of Object.entries(records)) {
    const insert = db.prepare(`INSERT INTO "${collection}" (id, data, search, created_date, updated_rev) VALUES (?, ?, ?, ?, ?)`);
    for (const [record, rev] of rows) insert.run(record.id, JSON.stringify(record), "texte-search-legacy", record.created_date || null, rev);
  }
  if (meta) db.prepare(`INSERT INTO meta (id, data) VALUES (1, ?)`).run(JSON.stringify(meta));
  if (image) db.prepare(`INSERT INTO images (id, meta, blob, bytes) VALUES (?, ?, ?, ?)`)
    .run(image.id, JSON.stringify({ ...image.meta, id: image.id }), image.blob, image.blob.length);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
};

/** Le fichier est-il (encore) au format LEGACY ? — même critère que la détection : colonne `data`. */
const isLegacyFile = (file, collection = "equipments") => {
  const db = new SQLITE(file);
  try { return db.prepare(`PRAGMA table_info("${collection}")`).all().some((c) => c.name === "data"); }
  finally { db.close(); }
};

module.exports = async () => {
  await section("Serveur : LegacyMigration — migration NOMINALE (backup, normalisation, rev préservée, idempotence, index)", async () => {
  {
    if (!requireSqlite()) return;
    const { LegacyMigration } = SERVER("LegacyMigration.js");
    const { RelationalRepository } = SERVER("RelationalRepository.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-legacy-"));
    const file = path.join(dir, "doc-legacy.db");
    try {
      // -- Fixture legacy : défauts ABSENTS (dim_mode, doors), clé legacy `face_image`, clé INCONNUE,
      //    `updated_rev` VARIÉES, audit partiel, meta remplie, une image avec blob. --
      buildLegacyFile(file, {
        equipments: [
          [{ id: "eq1", name: "Cœur réseau", face_image: "png-legacy", champ_fantome: 42, created_date: "2026-01-01T00:00:00.000Z", created_by: "u-alice" }, 3],
          [{ id: "eq2", name: "Serveur B", locked: true, u_height: 4 }, 7],
        ],
        datacenters: [[{ id: "dc1", name: "Salle legacy" }, 5]],
        cables: [[{ id: "c1", name: "Câble un", status: "brouillon", network_ids: ["n1", "n2"] }, 2]],
      }, {
        meta: { docName: "Doc legacy", graphe: { zoom: 2 } },
        image: { id: "img1", meta: { name: "façade", type: "image/png", rev: 1 }, blob: Buffer.from([9, 8, 7]) },
      });

      // -- Migration (l'appel que DocumentStore.repo() fait en prod). --
      const log = mkLog();
      const result = LegacyMigration.migrateIfLegacy(file, SQLITE, log);
      ck(result.migrated === true && result.records === 4, "migration : 4 records migrés (2 equipments + 1 datacenter + 1 câble)");
      ck.eq(result.perCollection.equipments, 2, "migration : détail par collection (equipments: 2)");
      ck.eq(result.backupPath, file + ".pre-relationnel.bak", "migration : backup écrit à <doc>.db.pre-relationnel.bak");
      ck(log.calls.info.some((l) => /migré/.test(l) && /4 record/.test(l)), "migration : une ligne info (nb de records, backup, durée)");

      // -- Le `.bak` est l'ANCIEN format, AUTO-SUFFISANT (relisible seul : colonne `data` + records intacts). --
      const bak = file + ".pre-relationnel.bak";
      ck(fs.existsSync(bak), "backup : le .bak existe");
      ck(isLegacyFile(bak), "backup : ANCIEN format (colonne `data` présente — relisible en legacy)");
      const bakDb = new SQLITE(bak);
      const bakRow = bakDb.prepare(`SELECT data, updated_rev FROM "equipments" WHERE id = 'eq1'`).get();
      ck(!!bakRow && JSON.parse(bakRow.data).face_image === "png-legacy" && bakRow.updated_rev === 3,
        "backup : record legacy INTACT dans le .bak (clé face_image encore là, rev 3) — le checkpoint pré-copie a rapatrié le -wal");
      bakDb.close();

      // -- Relecture RELATIONNELLE : forme normalisée, défauts posés, legacy/inconnu purgés, audit conservé. --
      const repo = RelationalRepository.open(file, SQLITE);
      const eq1 = repo.getOne("equipments", "eq1");
      ck.eq(eq1.name, "Cœur réseau", "relecture : champ déclaré intact (unicode inclus)");
      ck.eq(eq1.dim_mode, "", "relecture : DÉFAUT posé par la normalisation — dim_mode absent du blob → \"\" (jamais une copie colonne à colonne)");
      ck(!("face_image" in eq1) && !("champ_fantome" in eq1), "relecture : clé legacy `face_image` et clé inconnue PURGÉES (contrat des colonnes strictes)");
      ck(eq1.created_by === "u-alice" && eq1.created_date === "2026-01-01T00:00:00.000Z", "relecture : audit du blob PRÉSERVÉ (created_by/created_date)");
      ck(!("updated_by" in eq1), "relecture : audit ABSENT du blob → clé absente (pas de null inventé)");
      const dc1 = repo.getOne("datacenters", "dc1");
      ck(Array.isArray(dc1.doors) && dc1.doors.length === 0, "relecture : DÉFAUT posé — datacenters.doors absent → [] (type json)");
      const eq2 = repo.getOne("equipments", "eq2");
      ck(eq2.locked === true && eq2.u_height === 4, "relecture : booléen re-typé true (pas 1) + NUMERIC entier exact");
      ck.eq(repo.findBy("cables", "network_ids", "n2").length, 1, "relecture : champ tableau migré (appartenance json_each)");

      // -- `updated_rev` PRÉSERVÉE record par record (verrou optimiste par entité : il ne repart PAS de zéro). --
      ck.eq(repo.conflicts([{ collection: "equipments", id: "eq1" }], 2).length, 1, "updated_rev : eq1 rev 3 > baseRev 2 → conflit (rev préservée)");
      ck.eq(repo.conflicts([{ collection: "equipments", id: "eq1" }], 3).length, 0, "updated_rev : eq1 à baseRev 3 → pas de conflit (pas de bump parasite)");
      ck.eq(repo.conflicts([{ collection: "equipments", id: "eq2" }], 6).length, 1, "updated_rev : eq2 rev 7 préservée (variée PAR record, pas un rev global)");
      ck.eq(repo.conflicts([{ collection: "datacenters", id: "dc1" }], 4).length, 1, "updated_rev : dc1 rev 5 préservée");

      // -- meta / images : HORS migration, INTACTES. --
      ck(repo.getMeta().docName === "Doc legacy" && repo.getMeta().graphe.zoom === 2, "meta : sac JSON intact (hors migration)");
      const img = repo.getImageBlob("img1");
      ck(!!img && img.blob.length === 3 && img.blob[0] === 9, "images : blob intact (hors migration)");
      ck.eq(repo.getImageMeta("img1").rev, 1, "images : méta (rev de cache-busting) intacte");

      // -- 🎯 USING INDEX post-migration : le gain du chantier sert AUSSI aux documents migrés. --
      const plan = repo.explainFindBy("equipments", "name", "Cœur réseau").join(" | ");
      ck(plan.includes("USING INDEX idx_equipments_name"), "🎯 post-migration : findBy(equipments, name) → SEARCH USING INDEX (le DDL neuf porte les index)");
      repo.close();

      // -- IDEMPOTENCE : réouverture → no-op (plus de colonne `data`), `.bak` JAMAIS écrasé. --
      const bakStat = fs.statSync(bak);
      const again = LegacyMigration.migrateIfLegacy(file, SQLITE, mkLog());
      ck(again.migrated === false && again.records === 0, "idempotence : seconde ouverture → no-op (déjà relationnel, aucune re-migration)");
      const bakStat2 = fs.statSync(bak);
      ck(bakStat2.size === bakStat.size && bakStat2.mtimeMs === bakStat.mtimeMs, "idempotence : le .bak n'a PAS été réécrit (taille et mtime inchangés)");
      const reopened = RelationalRepository.open(file, SQLITE);
      ck.eq(reopened.getOne("equipments", "eq1").name, "Cœur réseau", "idempotence : les données migrées survivent à la réouverture");
      reopened.close();

      // -- `.bak` PRÉEXISTANT (autre fichier legacy à côté d'un vieux backup) : warn + backup CONSERVÉ. --
      const file2 = path.join(dir, "doc-rebak.db");
      buildLegacyFile(file2, { equipments: [[{ id: "e1", name: "avant" }, 1]] });
      fs.writeFileSync(file2 + ".pre-relationnel.bak", "SENTINELLE-PREMIER-ETAT");   // un .bak déjà là (le PREMIER état legacy)
      const logRebak = mkLog();
      const rebak = LegacyMigration.migrateIfLegacy(file2, SQLITE, logRebak);
      ck(rebak.migrated === true && rebak.backupPath === null, ".bak préexistant : migration faite, backupPath null (rien d'écrit)");
      ck.eq(fs.readFileSync(file2 + ".pre-relationnel.bak", "utf8"), "SENTINELLE-PREMIER-ETAT", ".bak préexistant : JAMAIS écrasé (le premier état legacy est le plus précieux)");
      ck(logRebak.calls.warn.some((l) => /PRÉEXISTANT/.test(l)), ".bak préexistant : warn journalisé");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* dossier temp (handles longs sous Windows) */ }
    }
  }
  });

  await section("Serveur : LegacyMigration — migration en ÉCHEC : erreur NOMMÉE collection/id, fichier resté LISIBLE en legacy, .bak présent", async () => {
  {
    if (!requireSqlite()) return;
    const { LegacyMigration } = SERVER("LegacyMigration.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-legfail-"));
    const file = path.join(dir, "doc-fautif.db");
    try {
      // Un record VALIDE + un record SANS champ `required` (equipments.name → colonne NOT NULL) :
      // aucun cas dans les corpus mesurés, mais l'abort doit être PROPRE et NOMMÉ (consigne L3).
      buildLegacyFile(file, {
        equipments: [
          [{ id: "ok1", name: "valide" }, 1],
          [{ id: "bad1", type: "switch" }, 2],   // sans `name` → NOT NULL au réinsert
        ],
        racks: [[{ id: "r1", name: "Baie" }, 1]],
      }, { meta: { docName: "fautif" } });

      const log = mkLog();
      let error = "";
      try { LegacyMigration.migrateIfLegacy(file, SQLITE, log); } catch (e) { error = String((e && e.message) || e); }
      ck(!!error, "échec : la migration LÈVE (jamais un demi-état silencieux)");
      ck(error.includes("equipments/bad1"), "échec : l'erreur NOMME collection/id du record fautif (« " + error.slice(0, 120) + " »)");
      ck(/NOT NULL/.test(error), "échec : la cause SQL (colonne NOT NULL) reste visible dans le message");
      ck(log.calls.error.some((l) => /legacy/.test(l)), "échec : erreur journalisée (marche à suivre : RUN.md)");

      // -- Transaction annulée EN BLOC : le fichier est resté 100 % LEGACY (rien de perdu, relisible). --
      ck(isLegacyFile(file, "equipments") && isLegacyFile(file, "racks"), "échec : tables encore au format legacy (colonne `data`) — l'ALTER/DDL de la transaction est annulé aussi");
      const raw = new SQLITE(file);
      ck.eq(raw.prepare(`SELECT COUNT(*) n FROM "equipments"`).get().n, 2, "échec : les 2 records equipments (fautif inclus) toujours là");
      ck.eq(JSON.parse(raw.prepare(`SELECT data FROM "equipments" WHERE id = 'ok1'`).get().data).name, "valide", "échec : le record valide est INTACT dans le blob");
      ck(!raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%__legacy'`).all().length, "échec : aucune table __legacy résiduelle (abort atomique)");
      raw.close();
      ck(fs.existsSync(file + ".pre-relationnel.bak"), "échec : le .bak est là (copié AVANT toute mutation)");

      // -- Une seconde tentative échoue À L'IDENTIQUE (pas de demi-état qui changerait le diagnostic). --
      let error2 = "";
      try { LegacyMigration.migrateIfLegacy(file, SQLITE, mkLog()); } catch (e) { error2 = String((e && e.message) || e); }
      ck(error2.includes("equipments/bad1"), "échec : re-tentative → même erreur nommée (état stable)");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* dossier temp */ }
    }
  }
  });

  await section("Serveur : bascule L4 — base NEUVE relationnelle directe + DocumentStore.repo() rend l'implémentation RELATIONNELLE", async () => {
  {
    if (!requireSqlite()) return;
    const { DocumentStore } = SERVER("documents.js");
    const { LegacyMigration } = SERVER("LegacyMigration.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-switch-"));
    try {
      // -- Base NEUVE : schéma relationnel DIRECT, aucun .bak, aucun log de migration. --
      const log = mkLog();
      const docs = new DocumentStore(dir, SQLITE, log);
      const created = docs.create("Doc neuf");
      const file = path.join(dir, created.id + ".db");
      ck(!fs.existsSync(file + ".pre-relationnel.bak"), "base neuve : AUCUN .bak (rien à sauvegarder)");
      ck(!isLegacyFile(file, "racks"), "base neuve : née RELATIONNELLE (pas de colonne `data`)");
      ck(!log.calls.info.some((l) => /migré/.test(l)) && !log.calls.warn.length && !log.calls.error.length,
        "base neuve : aucun log de migration (le no-op est silencieux)");
      // Et migrateIfLegacy sur un fichier ABSENT ne CRÉE rien (la base naît via l'ouverture relationnelle).
      const ghost = path.join(dir, "inexistant.db");
      ck(LegacyMigration.migrateIfLegacy(ghost, SQLITE, mkLog()).migrated === false && !fs.existsSync(ghost),
        "fichier absent : no-op ET aucun fichier créé par la détection");

      // -- BASCULE : repo() = implémentation RELATIONNELLE (sondes de comportement ET de type). --
      const repo = docs.repo(created.id);
      repo.upsert("equipments", { id: "e1", name: "sw", champ_fantome: 1, face_image: "x" }, 1);
      const e1 = repo.getOne("equipments", "e1");
      ck(!("champ_fantome" in e1) && !("face_image" in e1),
        "bascule : clé inconnue/legacy IGNORÉE à l'écriture — comportement RELATIONNEL (le blob les aurait stockées)");
      ck.eq(e1.dim_mode, null, "bascule : relecture normalisée (chaque champ de spec présent — dim_mode null : upsert ne normalise pas, c'est le rôle de l'API)");
      ck(typeof repo.explainFindBy === "function" && repo.explainFindBy("equipments", "name", "sw").join(" | ").includes("USING INDEX"),
        "bascule : sonde de type — explainFindBy (méthode propre au relationnel) présente et USING INDEX");

      // -- BASCULE d'un document LEGACY par le chemin DocumentStore (bout en bout). --
      const legacyDoc = docs.create("Doc à migrer");
      docs.closeAll();   // ferme dépôts + registre : on va REMPLACER le fichier sous un nouveau store
      const legacyFile = path.join(dir, legacyDoc.id + ".db");
      for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(legacyFile + ext, { force: true }); } catch (_) { /* absent */ } }
      buildLegacyFile(legacyFile, { equipments: [[{ id: "eqL", name: "Migré via store", face_image: "vieux" }, 9]] }, { meta: { docName: "à migrer" } });
      const log2 = mkLog();
      const docs2 = new DocumentStore(dir, SQLITE, log2);
      const migratedRepo = docs2.repo(legacyDoc.id);   // ← LE chemin de prod : migration PUIS ouverture relationnelle
      ck(fs.existsSync(legacyFile + ".pre-relationnel.bak"), "repo() sur doc legacy : .bak créé par le chemin DocumentStore");
      const eqL = migratedRepo.getOne("equipments", "eqL");
      ck(!!eqL && eqL.name === "Migré via store" && !("face_image" in eqL), "repo() sur doc legacy : record migré, normalisé, legacy purgé");
      ck.eq(migratedRepo.conflicts([{ collection: "equipments", id: "eqL" }], 8).length, 1, "repo() sur doc legacy : updated_rev 9 préservée à travers le chemin DocumentStore");
      ck.eq(migratedRepo.getMeta().docName, "à migrer", "repo() sur doc legacy : meta intacte");
      ck(log2.calls.info.some((l) => /migré/.test(l)), "repo() sur doc legacy : la migration est journalisée par le logger du store");
      docs2.closeAll();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* registry/handles longs sous Windows : dossier temp, sans conséquence */ }
    }
  }
  });
};
