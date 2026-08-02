/* ============================================================================
   MIGRATION LEGACY blob → RELATIONNEL — lot L4 de la migration DB (D5a).

   Migre le fichier SQLite d'UN document du modèle blob historique
   (`(id, data JSON, search, created_date, updated_rev)` par collection, cf.
   `db.ts`) vers le schéma relationnel GÉNÉRÉ (`src-shared/RelationalSchema`).
   Appelée par `DocumentStore.repo()` AVANT chaque ouverture relationnelle :
   le déclencheur est le premier accès au document (création, lecture, écriture),
   donc en pratique le boot du serveur pour les documents actifs (cadrage D5a,
   `.notes/toDos/migration-db-relationnelle-cadrage-2026-07-31.md`).

   ── Séquence (et pourquoi dans cet ordre) ───────────────────────────────────
   1. DÉTECTION : `PRAGMA table_info` sur chaque collection — une table qui
      porte une colonne `data` est LEGACY. Base absente/neuve ou déjà migrée →
      no-op (idempotence PAR CONSTRUCTION : après migration, plus de colonne
      `data` nulle part).
   2. BACKUP AVANT TOUT : checkpoint TRUNCATE puis FERMETURE du handle, puis
      `copyFileSync(file, file + ".pre-relationnel.bak")`. La fermeture n'est
      pas un luxe : sous Windows, copier un fichier au handle ouvert est le
      piège EBUSY (pattern `DocumentStore.delete`), et le checkpoint rapatrie
      le `-wal` dans le `.db` — le `.bak` doit être AUTO-SUFFISANT (un backup
      au `-wal` orphelin serait un backup amputé). Un `.bak` DÉJÀ PRÉSENT n'est
      JAMAIS écrasé (warn + on continue) : le premier état legacy sauvegardé
      est le plus précieux — l'écraser après une migration partielle ou un
      re-passage détruirait la seule copie d'avant-chantier.
   3. MIGRATION en UNE transaction SQLite : par collection legacy —
      `ALTER TABLE … RENAME TO …__legacy`, DDL neuf (RelationalSchema), lecture
      SQL BRUTE de `id, data, updated_rev` (AUCUNE dépendance à la classe blob,
      qui disparaît au lot L5), puis pour chaque record :
      `JSON.parse(data)` → `DataValidator.normalizeRecord` (pose les DÉFAUTS —
      un blob peut dater d'AVANT les migrations en mémoire du client, cadrage
      §6 : jamais une copie colonne à colonne) → upsert RELATIONNEL **BRUT**
      (`upsertRaw` : colonne `search` pauvre — l'ENRICHISSEMENT vient du
      backfill à l'ouverture qui suit, cf. le commentaire au point d'appel)
      avec `updated_rev` PRÉSERVÉE record par record (sinon le verrou optimiste
      par entité repartirait de zéro), enfin `DROP TABLE …__legacy`. La
      normalisation PRÉSERVE id/audit/clés inconnues, et l'upsert relationnel
      IGNORE les clés hors spec — c'est LA purge (voulue) des legacy
      `equipments.face_image`/`face_image_rear`. `meta` et `images` sont HORS
      migration : elles survivent TELLES QUELLES (cadrage §1).
   4. ÉCHEC : toute exception d'un record est ENRICHIE de `collection/id` du
      fautif (l'erreur SQL brute ne nomme que la COLONNE — consigne L3) et la
      transaction s'annule EN BLOC : le fichier reste LISIBLE en legacy, le
      `.bak` est là. Marche à suivre consignée dans `src-server/RUN.md`.
   ============================================================================ */

import fs from "node:fs";
import { Schema } from "./constants.js";
import { RelationalSchema } from "../../src-shared/RelationalSchema.js";
import { DataValidator } from "../../src-shared/DataValidation.js";
import { RelationalRepository } from "./RelationalRepository.js";
import type { SqliteCtor, SqliteDb } from "./db.js";
import type { Logger } from "./logger.js";

/** Bilan d'un passage de migration (consommé par les logs et les tests). */
export interface LegacyMigrationResult {
  /** `true` si le fichier ÉTAIT legacy et a été migré ; `false` = no-op (absent, neuf ou déjà relationnel). */
  migrated: boolean;
  /** Nombre total de records migrés (toutes collections). */
  records: number;
  /** Détail par collection (collections legacy uniquement). */
  perCollection: Record<string, number>;
  /** Chemin du backup ÉCRIT par ce passage — null si no-op OU si un `.bak` préexistant a été conservé. */
  backupPath: string | null;
  /** Durée du passage (détection incluse), en millisecondes. */
  durationMs: number;
}

/** Migration au boot d'un document legacy (blob) vers le schéma relationnel — méthodes statiques
    (cf. CLAUDE.md principe n°2). Le driver SQLite est INJECTÉ comme partout (better-sqlite3 en prod,
    réel aussi en test) ; le Logger vient de l'appelant (`DocumentStore`). */
export class LegacyMigration {
  /** Suffixe du backup pré-migration, accolé au chemin du fichier document (`<doc>.db.pre-relationnel.bak`). */
  static readonly BACKUP_SUFFIX = ".pre-relationnel.bak";

  /** Migre `file` s'il est au format legacy ; no-op sinon (cf. en-tête pour la séquence complète).
      LÈVE en cas d'échec de migration — le fichier reste alors lisible en legacy, le backup est présent,
      et l'erreur NOMME le record fautif (`collection/id`). */
  static migrateIfLegacy(file: string, Database: SqliteCtor, log: Logger): LegacyMigrationResult {
    const noop: LegacyMigrationResult = { migrated: false, records: 0, perCollection: {}, backupPath: null, durationMs: 0 };
    // Base ABSENTE : ne pas ouvrir (l'ouverture CRÉERAIT le fichier) — elle naîtra relationnelle via
    // `RelationalRepository.open`, sans backup ni log (une base neuve n'a rien à sauvegarder).
    if (!fs.existsSync(file)) return noop;
    const startedAt = Date.now();

    // -- 1. DÉTECTION (handle éphémère, refermé quoi qu'il arrive) --
    const probe = new Database(file);
    let legacyCollections: string[];
    try { legacyCollections = LegacyMigration.legacyCollectionsOf(probe); }
    finally {
      // Checkpoint AVANT fermeture : si on va copier, le `.bak` doit contenir tout le `-wal` (auto-suffisant).
      try { probe.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* base non-WAL / driver réduit */ }
      probe.close();
    }
    if (!legacyCollections.length) return noop;   // déjà relationnelle (ou vide) — idempotence

    // -- 2. BACKUP (handle FERMÉ ci-dessus — jamais de copie handle ouvert, piège Windows EBUSY) --
    const backupPath = file + LegacyMigration.BACKUP_SUFFIX;
    let backupWritten: string | null = null;
    if (fs.existsSync(backupPath)) {
      log.warn("migration legacy : backup PRÉEXISTANT conservé (jamais écrasé — premier état legacy = le plus précieux)", backupPath);
    } else {
      fs.copyFileSync(file, backupPath);
      backupWritten = backupPath;
    }

    // -- 3. MIGRATION en UNE transaction (rename → DDL neuf → normalisation + réinsertion → drop) --
    const db = new Database(file);
    db.pragma("busy_timeout = 5000");   // parité réglages Repository.open (journal WAL : propriété déjà portée par le fichier)
    const writer = RelationalRepository.onOpenHandle(db);   // l'upsert relationnel, sur CE handle, DANS la transaction
    const perCollection: Record<string, number> = {};
    try {
      db.transaction(() => {
        for (const collection of legacyCollections) {
          db.exec(`ALTER TABLE "${collection}" RENAME TO "${collection}__legacy"`);
          db.exec(RelationalSchema.tableDdl(collection));
          for (const ddl of RelationalSchema.indexDdls(collection)) db.exec(ddl);
          const rows = db.prepare(`SELECT id, data, updated_rev FROM "${collection}__legacy"`).all();
          for (const row of rows) {
            try {
              const record = DataValidator.normalizeRecord(collection, JSON.parse(String(row.data)));
              // upsert BRUT (colonne `search` = valeurs propres) et non l'upsert ENRICHI : à cet instant les
              // collections pas encore migrées ont TOUJOURS le schéma blob — le calcul des termes dérivés y
              // ferait des `findBy` sur des colonnes inexistantes (« no such column »). `user_version` reste
              // à 0 → l'ouverture qui suit (DocumentStore.repo → RelationalRepository.open) enrichit tout le
              // document en une transaction (backfill search-v1) — cf. RelationalRepository.upsertRaw.
              writer.upsertRaw(collection, record, (row.updated_rev as number) | 0);
            } catch (cause) {
              // L'erreur SQL ne nomme que la COLONNE (ex. « NOT NULL constraint failed: equipments.name ») :
              // on y accole collection/id du record FAUTIF — c'est ce que l'exploitant doit corriger.
              throw new Error(`record fautif ${collection}/${row.id} — ${LegacyMigration.messageOf(cause)}`);
            }
          }
          perCollection[collection] = rows.length;
          db.exec(`DROP TABLE "${collection}__legacy"`);
        }
      })();
    } catch (cause) {
      db.close();
      const message = LegacyMigration.messageOf(cause);
      log.error("migration legacy ÉCHOUÉE — transaction annulée EN BLOC : le document reste lisible en legacy, backup présent", file, message);
      throw new Error(`migration legacy de ${file} : ${message}`);
    }
    db.close();

    const records = Object.values(perCollection).reduce((sum, n) => sum + n, 0);
    const detail = Object.entries(perCollection).filter(([, n]) => n > 0).map(([c, n]) => c + ":" + n).join(", ") || "aucun record";
    log.info("document migré blob → relationnel", file,
      records + " record(s) [" + detail + "]",
      "backup " + (backupWritten ? backupWritten : "préexistant conservé (" + backupPath + ")"),
      (Date.now() - startedAt) + " ms");
    return { migrated: true, records, perCollection, backupPath: backupWritten, durationMs: Date.now() - startedAt };
  }

  /** Collections dont la table porte une colonne `data` = tables LEGACY (blob). `PRAGMA table_info` d'une
      table absente renvoie 0 ligne → une base vide ou déjà migrée ne détecte RIEN (no-op). */
  private static legacyCollectionsOf(db: SqliteDb): string[] {
    const out: string[] = [];
    for (const collection of Schema.COLLECTIONS) {
      const columns = db.prepare(`PRAGMA table_info("${collection}")`).all();
      if (columns.some((column: any) => column.name === "data")) out.push(collection);
    }
    return out;
  }

  /** Message lisible d'une exception quelconque (Error ou valeur brute). */
  private static messageOf(cause: unknown): string {
    return String((cause && (cause as any).message) || cause);
  }
}
