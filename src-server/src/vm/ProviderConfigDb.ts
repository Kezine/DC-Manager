import fs from "node:fs";
import path from "node:path";
import { Logger } from "../logger.js";
import type { SqliteCtor, SqliteDb } from "../db.js";
import type { ProviderConfig, ProviderConfigSource, ProviderEndpoint } from "./VmProvider.js";
import { AuditStamp } from "../AuditStamp.js";   // « auteur présent » partagé (id canonique de created_by/updated_by)
import { SecretBox } from "../SecretBox.js";
import { ProviderConfigValidate, ProviderConfigError } from "./ProviderConfigValidate.js";
import { ProviderConfigStore } from "./ProviderConfigStore.js";

/* =============================================================================
   STOCKAGE DB DES PROVIDERS VM — module `vm/` AMOVIBLE. Base SQLite DÉDIÉE au
   module (`vm-providers.db` dans le dossier de la DB, à côté de `registry.db`) :
   PAS une table de `registry.db` (le registre appartient au cœur, et le cœur ne
   connaît RIEN de `vm/`). Supprimer la feature = supprimer le module + ce fichier.

   POURQUOI une DB à colonnes typées (décision utilisateur 2026-07-14, cf.
   docs/persistance.md) : jamais de secret en JSON plaintext ; les jetons d'API
   sont CHIFFRÉS au repos (SecretBox serveur partagé, AES-256-GCM) — un backup du fichier
   n'expose aucun jeton. Le pool d'endpoints est un 1-N ordonné (table dédiée).

   AMOVIBILITÉ / DÉCOUPLAGE : le driver better-sqlite3 est INJECTÉ (même pattern
   que DocumentStore — type `SqliteCtor`), branché au bootstrap (index.ts). La
   validation par provider est DÉLÉGUÉE à `ProviderConfigValidate` (partagée avec
   le parseur du fichier legacy : mêmes messages d'erreur, zéro duplication).

   RÔLE : `ProviderConfigDb` remplace le fichier legacy `vm-providers.json` quand
   la clé de chiffrement est présente. Il expose DEUX surfaces :
   - LECTURE POUR LA SYNCHRO (`ProviderConfigSource` : providersFor/configuredDocIds)
     — VmSyncService ne voit que ce contrat, il ignore le support de stockage ;
   - CRUD (listFor/save/remove) alimentant l'UI de configuration (routes P2).

   SÉCURITÉ (invariants ABSOLUS) : aucun jeton (clair ou chiffré) ni la clé
   n'apparaît dans un log, un message d'erreur ou une réponse de LECTURE. `listFor`
   ne renvoie JAMAIS le jeton (seulement `has_token: true`) ; un jeton n'est
   déchiffré que pour la synchro ou un test de connexion (usage serveur, en mémoire).
   ============================================================================= */

/** Nom de la base dédiée au module, DANS le dossier injecté (à côté de registry.db). */
const PROVIDERS_DB_FILE = "vm-providers.db";
/** Nom du fichier legacy migré au démarrage (cf. importLegacyFile). */
const LEGACY_FILE = "vm-providers.json";

/** Placeholder de jeton NON VIDE injecté pour satisfaire la règle « token requis » de la
    validation partagée quand on CONSERVE le jeton existant (édition sans nouveau jeton). Il
    n'est JAMAIS stocké ni lu : seuls les AUTRES champs validés sont retenus, le token_enc
    existant est conservé tel quel. Un caractère de contrôle en tête le rend non collisionnable
    avec un vrai jeton et non affichable. */
const TOKEN_KEEP_SENTINEL = "\u0000jeton-conservé";

/** Élément de la liste CRUD (GET /providers) — SANS jeton (invariant de lecture). `has_token`
    signale qu'un jeton est stocké (toujours true : la colonne token_enc est NOT NULL), pour que
    l'UI affiche « jeton défini » et propose « inchangé si vide » à l'édition. Miroir DTO côté client. */
export interface ProviderListItem {
  id: string;
  kind: string;
  endpoints: ProviderEndpoint[];
  include_lxc: boolean;
  interval_sec: number;
  timeout_sec: number;
  /** CA du cluster (PEM) — PUBLIC (pas un secret), donc renvoyé en lecture, contrairement au jeton. */
  ca_pem: string | null;
  /** URL de management du cluster (Proxmox Datacenter Manager) — PUBLIC, renvoyée en lecture. null = absente. */
  management_url: string | null;
  has_token: true;
  created_date: string;
  updated_date: string;
}

/** Erreur de déchiffrement d'un jeton stocké (clé DCMANAGER_SECRETS_KEY changée/perdue) — mémorisée par
    `providersFor` pour rester CONSULTABLE sans jamais faire tomber la synchro globale (le provider
    est exclu de la passe, pas les autres). Ne porte JAMAIS le contenu du jeton. */
export interface ProviderTokenError {
  id: string;
  message: string;
}

/** Ligne brute de `vm_providers` (colonnes typées) — usage interne uniquement. */
interface ProviderRow {
  id: string;
  kind: string;
  token_enc: string;
  include_lxc: number;
  interval_sec: number;
  timeout_sec: number;
  ca_pem: string | null;
  management_url: string | null;
  created_date: string;
  updated_date: string;
}

export class ProviderConfigDb implements ProviderConfigSource {
  private readonly db: SqliteDb;
  /** docId → erreurs de déchiffrement du DERNIER providersFor(docId). Consultable (invariant :
      jamais le jeton) — un jeton indéchiffrable exclut le provider de la synchro sans throw global. */
  private readonly tokenErrors = new Map<string, ProviderTokenError[]>();

  /** @param dir  Dossier contenant la base (le MÊME que registry.db — injecté, jamais dérivé ici).
      @param Database  Constructeur SQLite INJECTÉ (better-sqlite3 en prod, réel en test).
      @param box  Coffre de chiffrement des jetons (clé présente — sinon le module reste sur le fichier legacy).
      @param log  Journalisation (résumés SANS secret). */
  constructor(
    private readonly dir: string,
    Database: SqliteCtor,
    private readonly box: SecretBox,
    private readonly log: Logger = new Logger("error"),
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, PROVIDERS_DB_FILE));
    // FK ON à CHAQUE connexion (OFF par défaut dans SQLite) — sinon ON DELETE CASCADE des endpoints
    // ne s'appliquerait pas. Réglages de parité avec DocumentStore/Repository (WAL + anti-SQLITE_BUSY).
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.createSchema();
    this.log.info("vm: base des providers ouverte", path.join(dir, PROVIDERS_DB_FILE));
  }

  /** Schéma EXACT du cadrage (2026-07-14). `token_enc` = jeton CHIFFRÉ (jamais en clair) ;
      `ca_pem` = CA du cluster au format PEM (PUBLIC — pas un secret ; NULL = pas de CA cluster,
      niveau 2 de la hiérarchie de confiance) ; endpoints = 1-N ORDONNÉ (position) avec FK ON DELETE
      CASCADE (supprimer un provider purge ses endpoints, PRAGMA foreign_keys = ON). */
  private createSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS vm_providers (
      doc_id       TEXT NOT NULL,
      id           TEXT NOT NULL,
      kind         TEXT NOT NULL,
      token_enc    TEXT NOT NULL,
      include_lxc  INTEGER NOT NULL DEFAULT 1,
      interval_sec INTEGER NOT NULL DEFAULT 0,
      timeout_sec  INTEGER NOT NULL DEFAULT 15,
      ca_pem       TEXT,
      management_url TEXT,
      created_date TEXT NOT NULL,
      updated_date TEXT NOT NULL,
      created_by   TEXT,
      updated_by   TEXT,
      PRIMARY KEY (doc_id, id)
    )`);
    // MIGRATION IDEMPOTENTE : des vm-providers.db existent DÉJÀ chez l'utilisateur (créés avant
    // l'ajout de management_url). CREATE TABLE IF NOT EXISTS n'ajoute pas de colonne à une table
    // existante → on ALTERe, dans un try/catch « colonne déjà présente » (pattern EXACT des
    // migrations de DocumentStore, src-server/src/documents.ts). Sur une base neuve, la colonne
    // vient déjà du CREATE ci-dessus → l'ALTER échoue et est ignoré (idempotent).
    try { this.db.exec("ALTER TABLE vm_providers ADD COLUMN management_url TEXT"); } catch { /* colonne déjà présente */ }
    // AUDIT « qui a créé / modifié » (lot audit utilisateur) : colonnes nullable ajoutées idempotemment —
    // une vm-providers.db antérieure les gagne sans valeur (lignes legacy = NULL), estampillées à la prochaine écriture.
    try { this.db.exec("ALTER TABLE vm_providers ADD COLUMN created_by TEXT"); } catch { /* colonne déjà présente */ }
    try { this.db.exec("ALTER TABLE vm_providers ADD COLUMN updated_by TEXT"); } catch { /* colonne déjà présente */ }
    this.db.exec(`CREATE TABLE IF NOT EXISTS vm_provider_endpoints (
      doc_id       TEXT NOT NULL,
      provider_id  TEXT NOT NULL,
      position     INTEGER NOT NULL,
      url          TEXT NOT NULL,
      fingerprint  TEXT,
      PRIMARY KEY (doc_id, provider_id, position),
      FOREIGN KEY (doc_id, provider_id) REFERENCES vm_providers(doc_id, id)
        ON DELETE CASCADE ON UPDATE CASCADE
    )`);
  }

  /* --------------------------------------------------------------------------
     LECTURE POUR LA SYNCHRO (ProviderConfigSource) — jetons DÉCHIFFRÉS
     -------------------------------------------------------------------------- */

  /** Providers d'un document, jetons DÉCHIFFRÉS (prêts pour l'adaptateur). Un jeton INDÉCHIFFRABLE
      (clé changée/perdue) → provider EXCLU de la passe + erreur mémorisée (consultable via
      `tokenErrorsFor`), JAMAIS de throw global : les autres providers restent synchronisables. */
  providersFor(docId: string): ProviderConfig[] {
    const rows = this.db.prepare(
      `SELECT id, kind, token_enc, include_lxc, interval_sec, timeout_sec, ca_pem, management_url FROM vm_providers WHERE doc_id = ? ORDER BY id`,
    ).all(docId) as ProviderRow[];
    const out: ProviderConfig[] = [];
    const errors: ProviderTokenError[] = [];
    for (const row of rows) {
      let token: string;
      try {
        token = this.box.decrypt(row.token_enc);
      } catch (e) {
        // Le message de SecretBox ne contient AUCUN contenu sensible (« secret à ressaisir ») : sûr à mémoriser.
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ id: row.id, message });
        this.log.warn("vm: jeton indéchiffrable — provider exclu de la synchro", docId, row.id);
        continue;
      }
      out.push({
        id: row.id,
        kind: row.kind,
        endpoints: this.endpointsOf(docId, row.id),
        token,
        include_lxc: !!row.include_lxc,
        interval_sec: row.interval_sec,
        timeout_sec: row.timeout_sec,
        ca_pem: row.ca_pem ?? null,
        management_url: row.management_url ?? null,
      });
    }
    this.tokenErrors.set(docId, errors);
    return out;
  }

  /** Documents ayant au moins un provider (armement des timers périodiques). */
  configuredDocIds(): string[] {
    return (this.db.prepare(`SELECT DISTINCT doc_id FROM vm_providers ORDER BY doc_id`).all() as { doc_id: string }[])
      .map((r) => r.doc_id);
  }

  /** Erreurs de déchiffrement mémorisées lors du DERNIER providersFor(docId) — consultation
      opérateur (jamais le jeton). Vide si tous les jetons se déchiffrent (ou docId jamais lu). */
  tokenErrorsFor(docId: string): ProviderTokenError[] {
    return (this.tokenErrors.get(docId) || []).slice();
  }

  /* --------------------------------------------------------------------------
     CRUD (routes P2) — le jeton n'est JAMAIS renvoyé en lecture
     -------------------------------------------------------------------------- */

  /** Liste des providers d'un document pour l'UI — SANS jeton (`has_token: true`), endpoints inclus. */
  listFor(docId: string): ProviderListItem[] {
    const rows = this.db.prepare(
      `SELECT id, kind, include_lxc, interval_sec, timeout_sec, ca_pem, management_url, created_date, updated_date FROM vm_providers WHERE doc_id = ? ORDER BY id`,
    ).all(docId) as Omit<ProviderRow, "token_enc">[];
    return rows.map((row) => this.toListItem(docId, row));
  }

  /** Crée ou met à jour un provider (unicité par PK `(doc_id, id)`). Jeton :
      - `tokenPlain` non vide → NOUVEAU jeton, chiffré et stocké ;
      - `tokenPlain === null` (ou vide) → CONSERVE le jeton existant (édition « inchangé ») ;
      - création (aucun existant) SANS jeton → erreur de validation (« token requis »).
      La config candidate (SANS jeton) est validée par `ProviderConfigValidate` (mêmes messages que
      le parseur fichier). Lève `ProviderConfigError` si invalide. Renvoie l'élément SANS jeton.
      AUDIT posé PAR LE SERVEUR : `authorId` = id canonique de l'auteur (RequestAuthor.identity, résolu côté
      route) → `updated_by` à chaque écriture, `created_by` à la création puis préservé par l'upsert. */
  save(docId: string, candidate: unknown, tokenPlain: string | null, authorId: string = ""): ProviderListItem {
    if (!ProviderConfigValidate.isPlainObject(candidate)) {
      throw new ProviderConfigError([ProviderConfigValidate.providerLabel(docId, 0, null) + " : provider attendu (objet)"]);
    }
    const id = typeof candidate["id"] === "string" ? (candidate["id"] as string) : null;
    const existing = id !== null ? this.rowOf(docId, id) : null;
    const hasNewToken = typeof tokenPlain === "string" && tokenPlain.trim() !== "";

    // On injecte la PRÉSENCE d'un jeton dans l'objet validé (la validation partagée exige « token »
    // non vide) : nouveau jeton → sa valeur ; conservation → sentinelle non stockée ; ni l'un ni
    // l'autre (création sans jeton) → on laisse `token` absent pour déclencher « token requis ».
    const forValidation: Record<string, unknown> = { ...candidate };
    delete forValidation["token"]; // le jeton transite HORS de la config candidate (paramètre dédié)
    if (hasNewToken) forValidation["token"] = tokenPlain;
    else if (existing) forValidation["token"] = TOKEN_KEEP_SENTINEL;

    const errors: string[] = [];
    const config = ProviderConfigValidate.parseProvider(docId, 0, forValidation, errors);
    if (config === null || errors.length) throw new ProviderConfigError(errors);

    // token_enc : jeton chiffré (nouveau) ou conservation de l'existant (jamais déchiffré ici).
    const tokenEnc = hasNewToken ? this.box.encrypt(tokenPlain as string) : (existing as ProviderRow).token_enc;
    const now = new Date().toISOString();
    const createdDate = existing ? existing.created_date : now;
    this.writeProvider(docId, config, tokenEnc, createdDate, now, AuditStamp.author(authorId));
    this.log.info(existing ? "vm: provider mis à jour" : "vm: provider créé", docId, config.id);
    return this.toListItem(docId, {
      id: config.id, kind: config.kind, include_lxc: config.include_lxc ? 1 : 0,
      interval_sec: config.interval_sec, timeout_sec: config.timeout_sec, ca_pem: config.ca_pem,
      management_url: config.management_url,
      created_date: createdDate, updated_date: now,
    });
  }

  /** Supprime un provider (et ses endpoints par CASCADE FK). Renvoie false si l'id n'existait pas. */
  remove(docId: string, id: string): boolean {
    const info = this.db.prepare(`DELETE FROM vm_providers WHERE doc_id = ? AND id = ?`).run(docId, id);
    const removed = (info.changes || 0) > 0;
    if (removed) this.log.info("vm: provider supprimé", docId, id);
    return removed;
  }

  /** Construit une ProviderConfig COMPLÈTE (jeton EN CLAIR) pour un TEST de connexion à la volée,
      SANS rien persister. Le jeton vient du corps (nouveau) ou, s'il est vide et que le provider
      existe, du STOCKÉ déchiffré. Le jeton n'est utilisé QUE pour construire l'adaptateur côté
      serveur — jamais journalisé, jamais renvoyé au client. Lève `ProviderConfigError` si invalide. */
  buildForTest(docId: string, candidate: unknown, tokenPlain: string | null): ProviderConfig {
    if (!ProviderConfigValidate.isPlainObject(candidate)) {
      throw new ProviderConfigError([ProviderConfigValidate.providerLabel(docId, 0, null) + " : provider attendu (objet)"]);
    }
    const id = typeof candidate["id"] === "string" ? (candidate["id"] as string) : null;
    const existing = id !== null ? this.rowOf(docId, id) : null;
    const hasNewToken = typeof tokenPlain === "string" && tokenPlain.trim() !== "";

    const forValidation: Record<string, unknown> = { ...candidate };
    delete forValidation["token"];
    if (hasNewToken) forValidation["token"] = tokenPlain;
    else if (existing) forValidation["token"] = this.box.decrypt(existing.token_enc); // besoin du VRAI jeton pour tester

    const errors: string[] = [];
    const config = ProviderConfigValidate.parseProvider(docId, 0, forValidation, errors);
    if (config === null || errors.length) throw new ProviderConfigError(errors);
    return config; // config.token = jeton réel (nouveau ou stocké déchiffré) — usage adaptateur uniquement
  }

  /* --------------------------------------------------------------------------
     MIGRATION du fichier legacy vm-providers.json → DB (au démarrage)
     -------------------------------------------------------------------------- */

  /** Migre le fichier legacy `vm-providers.json` (à côté de la DB) vers cette base. Cadrage :
      si le fichier existe et que ses documents ne sont PAS déjà en DB → import (jetons CHIFFRÉS au
      passage), puis fichier RENOMMÉ `vm-providers.json.imported-<AAAA-MM-JJ>` (trace, plus jamais
      relu → la DB devient l'unique source). Idempotent : au 2e démarrage le fichier est déjà
      renommé (absent) → no-op. Log récapitulatif SANS aucun secret (compteurs seuls). */
  importLegacyFile(legacyPath: string = path.join(this.dir, LEGACY_FILE)): { importedDocs: number; importedProviders: number; skipped: boolean } {
    let raw: string;
    try {
      raw = fs.readFileSync(legacyPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { importedDocs: 0, importedProviders: 0, skipped: true };
      throw new Error("vm: lecture du fichier legacy impossible : " + (err instanceof Error ? err.message : String(err)));
    }

    // Réutilise le parseur/validation LEGACY (mêmes règles) — un fichier invalide LÈVE (pas de
    // silence : on n'écraserait pas une config cassée par une migration partielle).
    const byDoc = ProviderConfigStore.parse(raw);
    const alreadyConfigured = new Set(this.configuredDocIds());
    const now = new Date().toISOString();
    let importedDocs = 0;
    let importedProviders = 0;
    for (const [docId, providers] of byDoc) {
      // Documents DÉJÀ en DB : ignorés (la DB est la source depuis un précédent import) — évite
      // d'écraser des jetons déjà ressaisis via l'UI par de vieilles valeurs du fichier.
      if (alreadyConfigured.has(docId) || providers.length === 0) continue;
      for (const config of providers) this.writeProvider(docId, config, this.box.encrypt(config.token), now, now);
      importedProviders += providers.length;
      importedDocs++;
    }

    // Renommage systématique (même si 0 importé : on ne veut PLUS JAMAIS relire ce fichier).
    const renamed = legacyPath + ".imported-" + now.slice(0, 10);
    fs.renameSync(legacyPath, renamed);
    this.log.info("vm: migration du fichier legacy → DB", "documents=" + importedDocs, "providers=" + importedProviders, "fichier renommé");
    return { importedDocs, importedProviders, skipped: false };
  }

  /** Ferme le handle SQLite (arrêt propre / avant suppression du fichier — parité Repository.close). */
  close(): void {
    try { this.db.pragma("wal_checkpoint(TRUNCATE)"); this.db.pragma("optimize"); } catch { /* driver réduit / déjà fermé */ }
    try { this.db.close(); } catch { /* déjà fermé */ }
  }

  /* --------------------------------------------------------------------------
     Helpers internes (privés)
     -------------------------------------------------------------------------- */

  /** Écrit UN provider (upsert par PK) + REMPLACE ses endpoints (delete puis insert ordonné), en
      UNE transaction. `ca_pem` est PERSISTÉ (CA du cluster, PUBLIC) : posé à la création comme à la
      mise à jour — vide côté UI = null (« pas de CA cluster »). `createdBy` = id canonique de l'auteur
      (null en migration legacy) : posé à la CRÉATION puis PRÉSERVÉ par l'upsert (hors DO UPDATE SET) ;
      `updated_by` rafraîchi à chaque écriture. */
  private writeProvider(docId: string, config: ProviderConfig, tokenEnc: string, createdDate: string, updatedDate: string, createdBy: string | null = null): void {
    const write = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO vm_providers (doc_id, id, kind, token_enc, include_lxc, interval_sec, timeout_sec, ca_pem, management_url, created_date, updated_date, created_by, updated_by)
         VALUES (@doc_id, @id, @kind, @token_enc, @include_lxc, @interval_sec, @timeout_sec, @ca_pem, @management_url, @created_date, @updated_date, @created_by, @updated_by)
         ON CONFLICT(doc_id, id) DO UPDATE SET
           kind = @kind, token_enc = @token_enc, include_lxc = @include_lxc,
           interval_sec = @interval_sec, timeout_sec = @timeout_sec, ca_pem = @ca_pem,
           management_url = @management_url, updated_date = @updated_date, updated_by = @updated_by`,
      ).run({
        doc_id: docId, id: config.id, kind: config.kind, token_enc: tokenEnc,
        include_lxc: config.include_lxc ? 1 : 0, interval_sec: config.interval_sec, timeout_sec: config.timeout_sec,
        ca_pem: config.ca_pem, management_url: config.management_url, created_date: createdDate, updated_date: updatedDate,
        created_by: createdBy, updated_by: createdBy,
      });
      // Le pool est REMPLACÉ intégralement (ordre + fingerprints peuvent changer) : delete puis ré-insert.
      this.db.prepare(`DELETE FROM vm_provider_endpoints WHERE doc_id = ? AND provider_id = ?`).run(docId, config.id);
      const ins = this.db.prepare(`INSERT INTO vm_provider_endpoints (doc_id, provider_id, position, url, fingerprint) VALUES (?, ?, ?, ?, ?)`);
      config.endpoints.forEach((endpoint, position) => ins.run(docId, config.id, position, endpoint.url, endpoint.fingerprint));
    });
    write();
  }

  /** Endpoints ORDONNÉS d'un provider (position croissante). */
  private endpointsOf(docId: string, providerId: string): ProviderEndpoint[] {
    return (this.db.prepare(
      `SELECT url, fingerprint FROM vm_provider_endpoints WHERE doc_id = ? AND provider_id = ? ORDER BY position`,
    ).all(docId, providerId) as { url: string; fingerprint: string | null }[])
      .map((r) => ({ url: r.url, fingerprint: r.fingerprint ?? null }));
  }

  /** Ligne brute d'un provider (null si absent) — pour la logique interne de save/buildForTest. */
  private rowOf(docId: string, id: string): ProviderRow | null {
    const row = this.db.prepare(
      `SELECT id, kind, token_enc, include_lxc, interval_sec, timeout_sec, ca_pem, management_url, created_date, updated_date FROM vm_providers WHERE doc_id = ? AND id = ?`,
    ).get(docId, id) as ProviderRow | undefined;
    return row || null;
  }

  /** Convertit une ligne (SANS token_enc) en élément de liste — jeton JAMAIS inclus (`has_token: true`). */
  private toListItem(docId: string, row: Omit<ProviderRow, "token_enc">): ProviderListItem {
    return {
      id: row.id,
      kind: row.kind,
      endpoints: this.endpointsOf(docId, row.id),
      include_lxc: !!row.include_lxc,
      interval_sec: row.interval_sec,
      timeout_sec: row.timeout_sec,
      ca_pem: row.ca_pem ?? null,
      management_url: row.management_url ?? null,
      has_token: true,
      created_date: row.created_date,
      updated_date: row.updated_date,
    };
  }
}
