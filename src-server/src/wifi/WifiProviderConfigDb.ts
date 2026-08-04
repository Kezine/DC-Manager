import fs from "node:fs";
import path from "node:path";
import { Logger } from "../logger.js";
import type { SqliteCtor, SqliteDb } from "../db.js";
import type { WifiProviderConfig, WifiProviderConfigSource, WifiProviderOptions, WifiProviderSummary } from "./WifiProvider.js";
import { AuditStamp } from "../AuditStamp.js";   // « auteur présent » partagé (id canonique de created_by/updated_by)
import { SecretBox } from "../SecretBox.js";
import { WifiProviderConfigValidate, WifiProviderConfigError } from "./WifiProviderConfigValidate.js";

/* =============================================================================
   STOCKAGE DB DES PROVIDERS WIFI — module `wifi/` AMOVIBLE. Base SQLite DÉDIÉE au
   module (`wifi-providers.db`, à côté de `registry.db` et de `vm-providers.db`) :
   PAS une table de `registry.db` (le registre appartient au cœur, et le cœur ne
   connaît RIEN de `wifi/`). Supprimer la feature = supprimer le module + ce fichier
   + le fichier `.db` sur le serveur.

   POURQUOI une DB à colonnes typées plutôt qu'un JSON : jamais de secret en clair
   sur disque — les jetons d'API sont CHIFFRÉS au repos (SecretBox serveur PARTAGÉ,
   AES-256-GCM, MÊME clé `DCMANAGER_SECRETS_KEY` que les modules vm/ et notify/, ce
   qui est VOULU : une seule clé d'infrastructure à gérer, cf. docs/wifi-unifi.md).
   Un backup du fichier n'expose aucun jeton.

   ── UNE SEULE TABLE (écart assumé au patron VM, décision D3) ──────────────────
   Le module VM a DEUX tables parce qu'un cluster Proxmox répond sur chaque nœud
   (pool 1-N ordonné). Un contrôleur wifi n'a qu'UNE console : la config tient
   entièrement dans une ligne. Ce qui est repris, en revanche, c'est tout le PATRON
   éprouvé : deux surfaces de lecture (synchro / CRUD UI), `has_token` sans jamais
   relire le jeton, sentinelle de conservation, `mapDecryptable` (jeton indéchiffrable
   = provider exclu + erreur mémorisée, JAMAIS de throw global), écriture en
   transaction, `close()` = checkpoint TRUNCATE + optimize.

   ── AGNOSTICISME DE MARQUE (D9) ──────────────────────────────────────────────
   Les colonnes sont COMMUNES à toute marque (id/kind/url/jeton/TLS/intervalle/
   délai). Les réglages PROPRES à une marque vivent dans la colonne `options`, qui
   porte le JSON normalisé par la branche `kind` de `WifiProviderConfigValidate`.
   Conséquence VOULUE : ajouter une marque ne touche NI ce fichier NI le schéma —
   c'est le critère d'acceptation de D9.

   AMOVIBILITÉ / DÉCOUPLAGE : le driver better-sqlite3 est INJECTÉ (même pattern que
   DocumentStore — type `SqliteCtor`), branché au bootstrap (index.ts).

   SÉCURITÉ (invariants ABSOLUS) : aucun jeton (clair ou chiffré) ni la clé
   n'apparaît dans un log, un message d'erreur ou une réponse de LECTURE. `listFor`
   ne renvoie JAMAIS le jeton (seulement `has_token: true`) ; un jeton n'est
   déchiffré que pour la synchro ou un test de connexion (usage serveur, en mémoire).
   ============================================================================= */

/** Nom de la base dédiée au module, DANS le dossier injecté (à côté de registry.db). */
const PROVIDERS_DB_FILE = "wifi-providers.db";

/** Placeholder de jeton NON VIDE injecté pour satisfaire la règle « token requis » de la
    validation quand on CONSERVE le jeton existant (édition sans nouveau jeton). Il n'est
    JAMAIS stocké ni lu : seuls les AUTRES champs validés sont retenus, le `token_enc`
    existant est conservé tel quel. Un caractère de contrôle en tête le rend non
    collisionnable avec un vrai jeton et non affichable.
    ⚠ Écrit en SÉQUENCE D'ÉCHAPPEMENT (`\u0000`) et jamais en caractère brut : un NUL tapé
    en clair ressort tel quel dans le JS compilé et fait passer le fichier pour binaire aux
    yeux de la plupart des outils (piège déjà rencontré dans ce dépôt). */
const TOKEN_KEEP_SENTINEL = "\u0000jeton-conservé";

/** Élément de la liste CRUD (GET /providers) — SANS jeton (invariant de lecture). `has_token`
    signale qu'un jeton est stocké (toujours true : la colonne `token_enc` est NOT NULL), pour
    que l'UI affiche « jeton défini » et propose « inchangé si vide » à l'édition. */
export interface WifiProviderListItem {
  id: string;
  kind: string;
  url: string;
  /** Empreinte TLS épinglée — PUBLIQUE (une empreinte n'est pas un secret), renvoyée en lecture. */
  fingerprint: string | null;
  /** CA de la console (PEM) — PUBLIQUE, renvoyée en lecture, contrairement au jeton. */
  ca_pem: string | null;
  interval_sec: number;
  timeout_sec: number;
  /** Options propres à la marque (`kind`) — aucun secret n'y transite (l'UI les ré-affiche). */
  options: WifiProviderOptions;
  has_token: true;
  created_date: string;
  updated_date: string;
}

/** Erreur de déchiffrement d'un jeton stocké (clé `DCMANAGER_SECRETS_KEY` changée/perdue) —
    mémorisée par les lectures pour rester CONSULTABLE sans jamais faire tomber la synchro
    globale (le provider est exclu de la passe, pas les autres). Ne porte JAMAIS le jeton. */
export interface WifiProviderTokenError {
  id: string;
  message: string;
}

/** Ligne brute de `wifi_providers` (colonnes typées) — usage interne uniquement. */
interface ProviderRow {
  id: string;
  kind: string;
  url: string;
  token_enc: string;
  fingerprint: string | null;
  ca_pem: string | null;
  interval_sec: number;
  timeout_sec: number;
  options: string | null;
  created_date: string;
  updated_date: string;
}

export class WifiProviderConfigDb implements WifiProviderConfigSource {
  private readonly db: SqliteDb;
  /** docId → erreurs de déchiffrement de la DERNIÈRE lecture de ce document. Consultable
      (invariant : jamais le jeton) — un jeton indéchiffrable exclut le provider de la synchro
      sans throw global. */
  private readonly tokenErrors = new Map<string, WifiProviderTokenError[]>();

  /** @param dir  Dossier contenant la base (le MÊME que registry.db — injecté, jamais dérivé ici).
      @param Database  Constructeur SQLite INJECTÉ (better-sqlite3 en prod, réel en test).
      @param box  Coffre de chiffrement des jetons (clé présente — sinon le module reste inactif).
      @param log  Journalisation (résumés SANS secret). */
  constructor(
    dir: string,
    Database: SqliteCtor,
    private readonly box: SecretBox,
    private readonly log: Logger = new Logger("error"),
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, PROVIDERS_DB_FILE));
    // Réglages de parité avec DocumentStore/Repository (WAL + anti-SQLITE_BUSY). `foreign_keys`
    // est posé par cohérence bien qu'AUCUNE FK n'existe ici (table unique — décision D3) : le jour
    // où une table fille apparaîtrait, l'oubli du PRAGMA serait un bug silencieux (OFF par défaut).
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.createSchema();
    this.log.info("wifi: base des providers ouverte", path.join(dir, PROVIDERS_DB_FILE));
  }

  /** Schéma : UNE table (cf. en-tête). `token_enc` = jeton CHIFFRÉ (jamais en clair) ;
      `fingerprint`/`ca_pem` = matériel de confiance TLS, PUBLIC ; `options` = JSON des
      réglages propres à la marque. Les `ALTER` idempotents en fin de méthode sont le PATRON
      de migration du dépôt (`try{ALTER}catch{}`, cf. DocumentStore/ProviderConfigDb) : sur une
      base NEUVE la colonne vient déjà du CREATE et l'ALTER échoue, ce qui est sans effet. */
  private createSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS wifi_providers (
      doc_id       TEXT NOT NULL,
      id           TEXT NOT NULL,
      kind         TEXT NOT NULL,
      url          TEXT NOT NULL,
      token_enc    TEXT NOT NULL,
      fingerprint  TEXT,
      ca_pem       TEXT,
      interval_sec INTEGER NOT NULL DEFAULT 0,
      timeout_sec  INTEGER NOT NULL DEFAULT 15,
      options      TEXT NOT NULL DEFAULT '{}',
      created_date TEXT NOT NULL,
      updated_date TEXT NOT NULL,
      created_by   TEXT,
      updated_by   TEXT,
      PRIMARY KEY (doc_id, id)
    )`);
    // Aucune migration de colonne à ce jour (schéma initial) — l'emplacement est PRÉPARÉ et
    // commenté pour que la prochaine évolution suive le patron du dépôt plutôt que d'inventer :
    //   try { this.db.exec("ALTER TABLE wifi_providers ADD COLUMN <col> <type>"); } catch { }
    // C'est d'ailleurs pourquoi les réglages de marque passent par `options` : les faire entrer
    // en colonnes obligerait à un ALTER par marque ajoutée (cf. D9, critère d'acceptation).
  }

  /* --------------------------------------------------------------------------
     LECTURE POUR LA SYNCHRO / LE STATUT (WifiProviderConfigSource)
     -------------------------------------------------------------------------- */

  /** Providers d'un document, jetons DÉCHIFFRÉS (prêts pour l'adaptateur). Réservé à la
      SYNCHRO/au TEST — seuls chemins qui ont besoin du jeton en clair. Un jeton INDÉCHIFFRABLE
      (clé changée/perdue) → provider EXCLU de la passe + erreur mémorisée (consultable via
      `tokenErrorsFor`), JAMAIS de throw global : les autres providers restent synchronisables. */
  providersFor(docId: string): WifiProviderConfig[] {
    // Le jeton EN CLAIR est CONSOMMÉ ici (champ `token` de la config servie à l'adaptateur).
    return this.mapDecryptable(docId, (row, token) => ({
      id: row.id,
      kind: row.kind,
      url: row.url,
      token,
      fingerprint: row.fingerprint ?? null,
      ca_pem: row.ca_pem ?? null,
      interval_sec: row.interval_sec,
      timeout_sec: row.timeout_sec,
      options: WifiProviderConfigDb.decodeOptions(row.options),
    }));
  }

  /** Résumés SANS jeton des providers d'un document (id/kind/interval_sec) — matière du STATUT
      et de l'UI. Le jeton est déchiffré par `mapDecryptable` UNIQUEMENT pour VÉRIFIER sa
      déchiffrabilité (et alimenter `tokenErrors`) : le clair est IMMÉDIATEMENT JETÉ — le
      projecteur l'IGNORE. INVARIANT : aucun jeton (clair ni chiffré) ne figure dans un résumé. */
  summariesFor(docId: string): WifiProviderSummary[] {
    return this.mapDecryptable(docId, (row) => ({
      id: row.id,
      kind: row.kind,
      interval_sec: row.interval_sec,
    }));
  }

  /** Balaye les providers d'un document en VÉRIFIANT la déchiffrabilité de chaque jeton,
      MUTUALISE la gestion d'erreur des deux surfaces de lecture et projette chaque ligne
      DÉCHIFFRABLE via `project` (qui reçoit le jeton en clair — libre de le consommer ou de
      l'ignorer). Un jeton indéchiffrable → ligne EXCLUE + erreur mémorisée (jamais de throw
      global). Le message de SecretBox ne contient AUCUN contenu sensible — sûr à mémoriser. */
  private mapDecryptable<T>(docId: string, project: (row: ProviderRow, token: string) => T): T[] {
    const rows = this.db.prepare(
      `SELECT id, kind, url, token_enc, fingerprint, ca_pem, interval_sec, timeout_sec, options FROM wifi_providers WHERE doc_id = ? ORDER BY id`,
    ).all(docId) as ProviderRow[];
    const out: T[] = [];
    const errors: WifiProviderTokenError[] = [];
    for (const row of rows) {
      let token: string;
      try {
        token = this.box.decrypt(row.token_enc);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ id: row.id, message });
        this.log.warn("wifi: jeton indéchiffrable — provider exclu (à ressaisir)", docId, row.id);
        continue;
      }
      out.push(project(row, token));
    }
    this.tokenErrors.set(docId, errors);
    return out;
  }

  /** Documents ayant au moins un provider (armement des timers périodiques). */
  configuredDocIds(): string[] {
    return (this.db.prepare(`SELECT DISTINCT doc_id FROM wifi_providers ORDER BY doc_id`).all() as { doc_id: string }[])
      .map((r) => r.doc_id);
  }

  /** Erreurs de déchiffrement mémorisées lors de la DERNIÈRE lecture de ce document —
      consultation opérateur (jamais le jeton). Vide si tous les jetons se déchiffrent. */
  tokenErrorsFor(docId: string): WifiProviderTokenError[] {
    return (this.tokenErrors.get(docId) || []).slice();
  }

  /* --------------------------------------------------------------------------
     CRUD — le jeton n'est JAMAIS renvoyé en lecture
     -------------------------------------------------------------------------- */

  /** Liste des providers d'un document pour l'UI — SANS jeton (`has_token: true`). */
  listFor(docId: string): WifiProviderListItem[] {
    const rows = this.db.prepare(
      `SELECT id, kind, url, fingerprint, ca_pem, interval_sec, timeout_sec, options, created_date, updated_date FROM wifi_providers WHERE doc_id = ? ORDER BY id`,
    ).all(docId) as Omit<ProviderRow, "token_enc">[];
    return rows.map((row) => WifiProviderConfigDb.toListItem(row));
  }

  /** Crée ou met à jour un provider (unicité par PK `(doc_id, id)`). Jeton :
      - `tokenPlain` non vide → NOUVEAU jeton, chiffré et stocké ;
      - `tokenPlain === null` (ou vide) → CONSERVE le jeton existant (édition « inchangé ») ;
      - création (aucun existant) SANS jeton → erreur de validation (« token requis »).
      Lève `WifiProviderConfigError` si invalide. Renvoie l'élément SANS jeton.
      AUDIT posé PAR LE SERVEUR : `authorId` = id canonique de l'auteur (RequestAuthor.identity,
      résolu côté route) → `updated_by` à chaque écriture, `created_by` à la création puis
      PRÉSERVÉ par l'upsert. */
  save(docId: string, candidate: unknown, tokenPlain: string | null, authorId: string = ""): WifiProviderListItem {
    if (!WifiProviderConfigValidate.isPlainObject(candidate)) {
      throw new WifiProviderConfigError([WifiProviderConfigValidate.providerLabel(docId, 0, null) + " : provider attendu (objet)"]);
    }
    const id = typeof candidate["id"] === "string" ? (candidate["id"] as string) : null;
    const existing = id !== null ? this.rowOf(docId, id) : null;
    const hasNewToken = typeof tokenPlain === "string" && tokenPlain.trim() !== "";

    // On injecte la PRÉSENCE d'un jeton dans l'objet validé (la validation exige « token » non
    // vide) : nouveau jeton → sa valeur ; conservation → sentinelle non stockée ; ni l'un ni
    // l'autre (création sans jeton) → on laisse `token` absent pour déclencher « token requis ».
    const forValidation: Record<string, unknown> = { ...candidate };
    delete forValidation["token"];   // le jeton transite HORS de la config candidate (paramètre dédié)
    if (hasNewToken) forValidation["token"] = tokenPlain;
    else if (existing) forValidation["token"] = TOKEN_KEEP_SENTINEL;

    const errors: string[] = [];
    const config = WifiProviderConfigValidate.parseProvider(docId, 0, forValidation, errors);
    if (config === null || errors.length) throw new WifiProviderConfigError(errors);

    // token_enc : jeton chiffré (nouveau) ou conservation de l'existant (jamais déchiffré ici).
    const tokenEnc = hasNewToken ? this.box.encrypt(tokenPlain as string) : (existing as ProviderRow).token_enc;
    const now = new Date().toISOString();
    const createdDate = existing ? existing.created_date : now;
    this.writeProvider(docId, config, tokenEnc, createdDate, now, AuditStamp.author(authorId));
    this.log.info(existing ? "wifi: provider mis à jour" : "wifi: provider créé", docId, config.id);
    return WifiProviderConfigDb.toListItem({
      id: config.id, kind: config.kind, url: config.url, fingerprint: config.fingerprint,
      ca_pem: config.ca_pem, interval_sec: config.interval_sec, timeout_sec: config.timeout_sec,
      options: JSON.stringify(config.options), created_date: createdDate, updated_date: now,
    });
  }

  /** Supprime un provider. Renvoie false si l'id n'existait pas. */
  remove(docId: string, id: string): boolean {
    const info = this.db.prepare(`DELETE FROM wifi_providers WHERE doc_id = ? AND id = ?`).run(docId, id);
    const removed = (info.changes || 0) > 0;
    if (removed) this.log.info("wifi: provider supprimé", docId, id);
    return removed;
  }

  /** Construit une `WifiProviderConfig` COMPLÈTE (jeton EN CLAIR) pour un TEST de connexion à la
      volée, SANS rien persister. Le jeton vient du corps (nouveau) ou, s'il est vide et que le
      provider existe, du STOCKÉ déchiffré. Le jeton n'est utilisé QUE pour construire l'adaptateur
      côté serveur — jamais journalisé, jamais renvoyé au client. Lève `WifiProviderConfigError`
      si la config est invalide ; laisse REMONTER l'erreur de SecretBox si le jeton stocké est
      indéchiffrable (la route la traduit en 422 actionnable « secret à ressaisir »). */
  buildForTest(docId: string, candidate: unknown, tokenPlain: string | null): WifiProviderConfig {
    if (!WifiProviderConfigValidate.isPlainObject(candidate)) {
      throw new WifiProviderConfigError([WifiProviderConfigValidate.providerLabel(docId, 0, null) + " : provider attendu (objet)"]);
    }
    const id = typeof candidate["id"] === "string" ? (candidate["id"] as string) : null;
    const existing = id !== null ? this.rowOf(docId, id) : null;
    const hasNewToken = typeof tokenPlain === "string" && tokenPlain.trim() !== "";

    const forValidation: Record<string, unknown> = { ...candidate };
    delete forValidation["token"];
    if (hasNewToken) forValidation["token"] = tokenPlain;
    else if (existing) forValidation["token"] = this.box.decrypt(existing.token_enc);   // besoin du VRAI jeton pour tester

    const errors: string[] = [];
    const config = WifiProviderConfigValidate.parseProvider(docId, 0, forValidation, errors);
    if (config === null || errors.length) throw new WifiProviderConfigError(errors);
    return config;   // config.token = jeton réel (nouveau ou stocké déchiffré) — usage adaptateur uniquement
  }

  /** Ferme le handle SQLite (arrêt propre / avant suppression du fichier — parité Repository.close). */
  close(): void {
    try { this.db.pragma("wal_checkpoint(TRUNCATE)"); this.db.pragma("optimize"); } catch { /* driver réduit / déjà fermé */ }
    try { this.db.close(); } catch { /* déjà fermé */ }
  }

  /* --------------------------------------------------------------------------
     Helpers internes (privés)
     -------------------------------------------------------------------------- */

  /** Écrit UN provider (upsert par PK) en UNE transaction. `createdBy` = id canonique de
      l'auteur (null si inconnu) : posé à la CRÉATION puis PRÉSERVÉ par l'upsert (hors
      DO UPDATE SET) ; `updated_by` rafraîchi à chaque écriture. La transaction n'a qu'UN
      ordre aujourd'hui (table unique — D3) : elle est conservée parce qu'elle DOCUMENTE
      l'atomicité attendue et ne coûte rien, et parce que le patron VM en a deux. */
  private writeProvider(docId: string, config: WifiProviderConfig, tokenEnc: string, createdDate: string, updatedDate: string, createdBy: string | null = null): void {
    const write = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO wifi_providers (doc_id, id, kind, url, token_enc, fingerprint, ca_pem, interval_sec, timeout_sec, options, created_date, updated_date, created_by, updated_by)
         VALUES (@doc_id, @id, @kind, @url, @token_enc, @fingerprint, @ca_pem, @interval_sec, @timeout_sec, @options, @created_date, @updated_date, @created_by, @updated_by)
         ON CONFLICT(doc_id, id) DO UPDATE SET
           kind = @kind, url = @url, token_enc = @token_enc, fingerprint = @fingerprint,
           ca_pem = @ca_pem, interval_sec = @interval_sec, timeout_sec = @timeout_sec,
           options = @options, updated_date = @updated_date, updated_by = @updated_by`,
      ).run({
        doc_id: docId, id: config.id, kind: config.kind, url: config.url, token_enc: tokenEnc,
        fingerprint: config.fingerprint, ca_pem: config.ca_pem,
        interval_sec: config.interval_sec, timeout_sec: config.timeout_sec,
        options: JSON.stringify(config.options),
        created_date: createdDate, updated_date: updatedDate,
        created_by: createdBy, updated_by: createdBy,
      });
    });
    write();
  }

  /** Ligne brute d'un provider (null si absent) — pour la logique interne de save/buildForTest. */
  private rowOf(docId: string, id: string): ProviderRow | null {
    const row = this.db.prepare(
      `SELECT id, kind, url, token_enc, fingerprint, ca_pem, interval_sec, timeout_sec, options, created_date, updated_date FROM wifi_providers WHERE doc_id = ? AND id = ?`,
    ).get(docId, id) as ProviderRow | undefined;
    return row || null;
  }

  /** JSON des options → objet scalaire. TOLÉRANT : colonne vide/illisible → `{}` plutôt qu'un
      throw. Une base éditée à la main (ou écrite par une version future) ne doit pas rendre
      TOUS les providers du document illisibles — l'adaptateur retombera sur ses défauts. */
  private static decodeOptions(raw: string | null): WifiProviderOptions {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return WifiProviderConfigValidate.isPlainObject(parsed) ? (parsed as WifiProviderOptions) : {};
    } catch {
      return {};
    }
  }

  /** Convertit une ligne (SANS token_enc) en élément de liste — jeton JAMAIS inclus. */
  private static toListItem(row: Omit<ProviderRow, "token_enc">): WifiProviderListItem {
    return {
      id: row.id,
      kind: row.kind,
      url: row.url,
      fingerprint: row.fingerprint ?? null,
      ca_pem: row.ca_pem ?? null,
      interval_sec: row.interval_sec,
      timeout_sec: row.timeout_sec,
      options: WifiProviderConfigDb.decodeOptions(row.options),
      has_token: true,
      created_date: row.created_date,
      updated_date: row.updated_date,
    };
  }
}
