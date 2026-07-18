import fs from "node:fs";
import path from "node:path";
import express from "express";
import { RequestAuthor, type ApiExtension } from "../api.js";   // RequestAuthor : id canonique de l'auteur (audit)
import type { DocumentStore } from "../documents.js";
import type { SqliteCtor } from "../db.js";
import { Logger } from "../logger.js";
import { ProviderConfigStore } from "./ProviderConfigStore.js";
import { ProviderConfigDb } from "./ProviderConfigDb.js";
import { ProviderConfigError } from "./ProviderConfigValidate.js";
import { SecretBox } from "../SecretBox.js";
import { VmSyncService, type VmLivePublisher, type ProblemReporter, type VmProviderStatus } from "./VmSyncService.js";
import { VmStatusEnrichment } from "./VmStatusEnrichment.js";

/* =============================================================================
   MODULE VM — façade d'assemblage et POINT DE BRANCHEMENT UNIQUE de la feature
   d'inventaire VM (amovible) : config des providers (par document) + moteur de
   synchro + routes REST, livrés au bootstrap sous forme d'ApiExtension.

   Suppression de la feature = retirer le câblage VmModule d'index.ts et le
   dossier vm/ — le cœur (api/db/documents/live) n'importe RIEN d'ici.

   CHOIX DU SUPPORT DE STOCKAGE (cadrage UI providers 2026-07-14), selon la
   présence de la clé de chiffrement `DCMANAGER_SECRETS_KEY` (SecretBox serveur
   partagé — l'ancienne `VM_PROVIDERS_KEY` reste lue en repli, cf. SecretBox) :
   - clé PRÉSENTE → stockage DB chiffré (`ProviderConfigDb`, vm-providers.db) +
     migration du fichier legacy au démarrage ; routes CRUD/test ACTIVES.
   - clé ABSENTE → comportement LEGACY (fichier `vm-providers.json`, lecture
     seule) : synchro/statut fonctionnent, mais les routes CRUD répondent 503
     explicite (« définir DCMANAGER_SECRETS_KEY… ») — les déploiements sans clé
     gardent le comportement actuel, sans gestion des providers.
   - clé ABSENTE **mais** `vm-providers.db` PRÉSENTE → module « en erreur »
     explicite (pas de silence) : des jetons chiffrés existent sans clé pour les
     lire — l'opérateur doit fournir la clé.

   Routes (montées sous la garde d'accès de l'API, mergeParams pour :docId) :
   - POST   /documents/:docId/vm/sync           → synchronise TOUS les providers
   - GET    /documents/:docId/vm/status         → état par provider
   - GET    /documents/:docId/vm/providers      → liste (SANS jeton)
   - PUT    /documents/:docId/vm/providers/:id  → créer/mettre à jour un provider
   - DELETE /documents/:docId/vm/providers/:id  → supprimer un provider
   - POST   /documents/:docId/vm/providers/test → tester une config candidate

   Après CHAQUE écriture CRUD : `service.rearmTimers()` (rechargement à chaud de
   la config — plus de redémarrage nécessaire). Une config INVALIDE ne fait PAS
   tomber le serveur : le module démarre « en erreur », les routes répondent 503
   avec le détail — visibilité opérateur sans sacrifier le reste de l'application.

   INVARIANT : aucune réponse ne contient de jeton (clair ou chiffré) — les
   réponses de lecture/écriture renvoient au plus `has_token: true` ; le test
   renvoie un ProviderInfo (aucun secret). Garanti par ProviderConfigDb/adapters.
   ============================================================================= */

/** Nom de la base des providers — utilisé pour détecter le cas « clé absente mais DB présente ». */
const PROVIDERS_DB_FILE = "vm-providers.db";

export class VmModule {
  private constructor(
    private readonly docs: DocumentStore,
    private readonly service: VmSyncService | null,
    /** Backend CRUD (stockage DB chiffré). null en mode legacy/clé absente ou module en erreur. */
    private readonly providerDb: ProviderConfigDb | null,
    /** Message d'erreur de chargement de la config (null = config saine ou absente). */
    private readonly configError: string | null,
    /** Vrai quand la clé de chiffrement est absente → les routes CRUD répondent 503 « définir la clé ». */
    private readonly keyMissing: boolean,
    private readonly log: Logger,
  ) {}

  static create(opts: { docs: DocumentStore; live: VmLivePublisher; dataDir: string; sqlite: SqliteCtor; log?: Logger; problems?: ProblemReporter }): VmModule {
    const log = opts.log || new Logger("error");
    // Coffre PARTAGÉ (clé unique DCMANAGER_SECRETS_KEY, repli legacy VM_PROVIDERS_KEY loggué par fromEnv).
    const box = SecretBox.fromEnv(process.env, log);

    // ---- Clé PRÉSENTE : stockage DB chiffré + migration legacy au démarrage. ----
    if (box) {
      try {
        const providerDb = new ProviderConfigDb(opts.dataDir, opts.sqlite, box, log);
        // Migration one-shot du fichier legacy s'il existe (idempotente : renomme puis n'y touche plus).
        providerDb.importLegacyFile();
        // On re-passe EXPLICITEMENT les défauts des positions 5-6 (fabrique d'adaptateur + délai
        // anti-rafale) pour atteindre le 7e paramètre positionnel `problems` : comportement inchangé,
        // seul le rapporteur de problèmes (optionnel, injecté au bootstrap) est ajouté.
        const service = new VmSyncService(opts.docs, opts.live, providerDb, log, VmSyncService.adapterFor, VmSyncService.DEFAULT_MIN_INTERVAL_SEC, opts.problems);
        log.info("module VM prêt (stockage DB chiffré, CRUD actif)", "node " + process.version);
        return new VmModule(opts.docs, service, providerDb, null, false, log);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.error("stockage DB des providers VM en erreur — module démarré en erreur (synchro désactivée)", message);
        return new VmModule(opts.docs, null, null, message, false, log);
      }
    }

    // ---- Clé ABSENTE mais base chiffrée PRÉSENTE : erreur EXPLICITE (pas de silence). ----
    const dbPath = path.join(opts.dataDir, PROVIDERS_DB_FILE);
    if (fs.existsSync(dbPath)) {
      const message = PROVIDERS_DB_FILE + " présent mais aucune clé de chiffrement (" + SecretBox.ENV_VAR + ", ou legacy " + SecretBox.LEGACY_ENV_VAR + ") — définissez la clé pour déchiffrer les jetons stockés";
      log.error("module VM en erreur : base chiffrée présente sans clé", message);
      return new VmModule(opts.docs, null, null, message, true, log);
    }

    // ---- Clé ABSENTE : comportement LEGACY (fichier, lecture seule) ; CRUD → 503 « définir la clé ». ----
    try {
      const providers = new ProviderConfigStore(opts.dataDir, log);
      // Défauts des positions 5-6 re-passés pour injecter le rapporteur (cf. chemin DB chiffrée ci-dessus).
      const service = new VmSyncService(opts.docs, opts.live, providers, log, VmSyncService.adapterFor, VmSyncService.DEFAULT_MIN_INTERVAL_SEC, opts.problems);
      log.info("module VM prêt (fichier legacy, lecture seule — CRUD désactivé faute de clé)", "node " + process.version);
      return new VmModule(opts.docs, service, null, null, true, log);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error("config des providers VM (fichier legacy) invalide — module démarré en erreur (synchro désactivée)", message);
      return new VmModule(opts.docs, null, null, message, true, log);
    }
  }

  /** Démarre les synchros périodiques (no-op si config en erreur/absente). */
  start(): void {
    this.service?.startTimers();
  }

  stop(): void {
    this.service?.stopTimers();
    this.providerDb?.close();
  }

  /** Extension API à passer au Server (montée après la garde d'accès du cœur). */
  extension(): ApiExtension {
    const router = express.Router({ mergeParams: true });

    router.post("/sync", (req, res) => {
      const docId = (req.params as any).docId as string;
      if (!this.docs.get(docId)) { res.status(404).json({ error: "document inconnu" }); return; }
      if (!this.service) { res.status(503).json({ error: "configuration des providers invalide", detail: this.configError }); return; }
      this.service.syncDocument(docId)
        // Enrichissement : les providers au jeton indéchiffrable sont EXCLUS de la synchro (donc
        // absents du résultat) — on les réinjecte en erreur pour qu'ils restent visibles côté UI.
        .then((providers) => res.json({ providers: this.withTokenErrors(docId, providers) }))
        .catch((e) => {
          // syncProvider ne jette jamais — ceci est une ceinture (bug interne) : 500 loggé, jamais silencieux.
          this.log.error("POST /vm/sync : échec inattendu", docId, e instanceof Error ? e.message : String(e));
          res.status(500).json({ error: "synchronisation en échec" });
        });
    });

    router.get("/status", (req, res) => {
      const docId = (req.params as any).docId as string;
      if (!this.docs.get(docId)) { res.status(404).json({ error: "document inconnu" }); return; }
      if (!this.service) { res.status(503).json({ error: "configuration des providers invalide", detail: this.configError }); return; }
      // Enrichissement : statusFor s'appuie sur providersFor, qui EXCLUT les providers au jeton
      // indéchiffrable (clé DCMANAGER_SECRETS_KEY changée) → sans ce complément ils disparaîtraient
      // silencieusement de la vue Clusters (l'incident corrigé). On les réinjecte en erreur.
      res.json({ providers: this.withTokenErrors(docId, this.service.statusFor(docId)) });
    });

    /* ---- CRUD des providers (stockage DB chiffré uniquement) ---- */

    router.get("/providers", (req, res) => {
      const docId = (req.params as any).docId as string;
      if (!this.docs.get(docId)) { res.status(404).json({ error: "document inconnu" }); return; }
      const db = this.crudBackend(res); if (!db) return;
      res.json({ providers: db.listFor(docId) }); // SANS jeton (has_token: true)
    });

    router.put("/providers/:id", (req, res) => {
      const docId = (req.params as any).docId as string;
      const id = (req.params as any).id as string;
      if (!this.docs.get(docId)) { res.status(404).json({ error: "document inconnu" }); return; }
      const db = this.crudBackend(res); if (!db) return;
      const body: any = (req.body && typeof req.body === "object") ? req.body : {};
      // Le jeton transite dans le corps UNIQUEMENT en écriture ; vide/absent = CONSERVER l'existant.
      const tokenPlain = typeof body.token === "string" && body.token.trim() !== "" ? (body.token as string) : null;
      // L'id vient de l'URL (immuable en édition) ; le jeton est retiré du candidat (paramètre dédié).
      const candidate = { ...body, id };
      delete candidate.token;
      try {
        // AUDIT posé PAR LE SERVEUR : id canonique de l'auteur (jamais le corps).
        const provider = db.save(docId, candidate, tokenPlain, RequestAuthor.identity(req).id);
        this.service?.rearmTimers(); // la config a changé À CHAUD → ré-armer les timers périodiques
        res.json({ provider }); // réponse SANS jeton (garanti par ProviderConfigDb)
      } catch (e) {
        if (e instanceof ProviderConfigError) { res.status(400).json({ error: "configuration invalide", issues: e.issues }); return; }
        this.log.error("PUT /vm/providers : échec", docId, id, e instanceof Error ? e.message : String(e));
        res.status(500).json({ error: "enregistrement du provider en échec" });
      }
    });

    router.delete("/providers/:id", (req, res) => {
      const docId = (req.params as any).docId as string;
      const id = (req.params as any).id as string;
      if (!this.docs.get(docId)) { res.status(404).json({ error: "document inconnu" }); return; }
      const db = this.crudBackend(res); if (!db) return;
      if (!db.remove(docId, id)) { res.status(404).json({ error: "provider inconnu" }); return; }
      this.service?.rearmTimers(); // la config a changé À CHAUD → ré-armer les timers périodiques
      res.json({ ok: true });
    });

    router.post("/providers/test", (req, res) => {
      const docId = (req.params as any).docId as string;
      if (!this.docs.get(docId)) { res.status(404).json({ error: "document inconnu" }); return; }
      const db = this.crudBackend(res); if (!db) return;
      const body: any = (req.body && typeof req.body === "object") ? req.body : {};
      // Config CANDIDATE (corps complet) : jeton vide + id existant → reprend le STOCKÉ (déchiffré),
      // pour tester une modification SANS ressaisir le jeton. Le jeton reste HORS de la réponse.
      const tokenPlain = typeof body.token === "string" && body.token.trim() !== "" ? (body.token as string) : null;
      const candidate = { ...body };
      delete candidate.token;
      let config;
      try {
        config = db.buildForTest(docId, candidate, tokenPlain);
      } catch (e) {
        if (e instanceof ProviderConfigError) { res.status(400).json({ error: "configuration invalide", issues: e.issues }); return; }
        // Échec de CONSTRUCTION hors validation — cas typique : le jeton STOCKÉ est indéchiffrable
        // (clé DCMANAGER_SECRETS_KEY changée/perdue). Le message SecretBox est SÛR (aucun jeton) et
        // ACTIONNABLE (« le secret doit être ressaisi ») : on le RENVOIE au client au lieu du 500
        // muet « test impossible » — c'est CE message que le bouton « Tester » doit afficher pour
        // que l'utilisateur sache quoi faire (l'incident : la clé avait changé, l'UI ne disait rien).
        // 422 : la requête est bien formée, c'est la donnée STOCKÉE qui est inexploitable (à ressaisir).
        const message = e instanceof Error ? e.message : String(e);
        this.log.error("POST /vm/providers/test : construction en échec", docId, message);
        res.status(422).json({ error: message }); return;
      }
      let adapter;
      try {
        adapter = VmSyncService.adapterFor(config); // fabrique existante (par kind)
      } catch (e) {
        // kind inconnu → 400 (config candidate erronée), message sans secret.
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); return;
      }
      adapter.test()
        .then((info) => res.json({ info })) // ProviderInfo (ok/kind/version/supported/message) — AUCUN jeton
        .catch((e) => {
          this.log.error("POST /vm/providers/test : échec inattendu", docId, e instanceof Error ? e.message : String(e));
          res.status(500).json({ error: "test en échec" });
        });
    });

    return { path: "/documents/:docId/vm", router };
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Réinjecte dans la liste des statuts les providers dont le jeton stocké est INDÉCHIFFRABLE
      (clé DCMANAGER_SECRETS_KEY changée/perdue) : `providersFor` les exclut → ils sont absents de
      `statusFor`/`syncDocument` et, sans ce complément, DISPARAISSENT silencieusement de l'UI.
      No-op en mode fichier legacy (aucun chiffrement → aucune erreur de jeton possible).
      ⚠ PRÉCONDITION : appelé APRÈS `statusFor`/`syncDocument`, qui, via `providersFor`, rafraîchissent
      `tokenErrorsFor` pour ce document (sinon on lirait des erreurs périmées ou vides). */
  private withTokenErrors(docId: string, statuses: VmProviderStatus[]): VmProviderStatus[] {
    if (!this.providerDb) return statuses;
    return VmStatusEnrichment.withTokenErrors(statuses, this.providerDb.tokenErrorsFor(docId), this.providerDb.listFor(docId));
  }

  /** Renvoie le backend CRUD (stockage DB) OU répond 503 et renvoie null. Deux 503 distincts :
      - clé ABSENTE → « définir DCMANAGER_SECRETS_KEY… » (guidance actionnable) ;
      - module en erreur (clé présente mais DB/config KO) → le détail de l'erreur. */
  private crudBackend(res: express.Response): ProviderConfigDb | null {
    if (this.providerDb) return this.providerDb;
    if (this.keyMissing) {
      res.status(503).json({
        error: "gestion des providers désactivée",
        detail: "définir " + SecretBox.ENV_VAR + " (passphrase de chiffrement des secrets) pour activer la configuration des providers",
      });
      return null;
    }
    res.status(503).json({ error: "configuration des providers invalide", detail: this.configError });
    return null;
  }
}
