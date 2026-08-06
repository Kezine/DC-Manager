import fs from "node:fs";
import path from "node:path";
import express from "express";
import { RequestAuthor, type ApiExtension } from "../api.js";   // RequestAuthor : id canonique de l'auteur (audit)
import type { DocumentStore } from "../documents.js";
import type { SqliteCtor } from "../db.js";
import { Logger } from "../logger.js";
import { IssueProviderConfigDb } from "./IssueProviderConfigDb.js";
import { IssueProviderConfigError } from "./IssueProviderConfigValidate.js";
import { SecretBox } from "../SecretBox.js";
import { IssueSyncService, type IssueLivePublisher, type ProblemReporter, type IssueProviderStatus } from "./IssueSyncService.js";

/* =============================================================================
   MODULE ISSUES — façade d'assemblage et POINT DE BRANCHEMENT UNIQUE de la feature
   « remote issue tracker » (amovible) : config des providers (par document) +
   moteur de synchro + routes REST, livrés au bootstrap sous forme d'ApiExtension.

   Suppression de la feature = retirer le câblage `IssueModule` d'index.ts et le
   dossier `issues/` — le cœur (api/db/documents/live) n'importe RIEN d'ici.
   Procédure complète (client, partagé, modèle) : docs/issue-tracker.md (lot L6).

   AGNOSTIQUE DE MARQUE : aucune route, aucun message et aucun champ de ce fichier
   ne nomme une marque. Les réglages propres à un tracker transitent dans l'objet
   `options` du corps, validé par la branche `kind` correspondante
   (`IssueProviderConfigValidate`) — un test relit ces sources pour le vérifier.

   SUPPORT DE STOCKAGE UNIQUE (base chiffrée `issue-providers.db`), conditionné à la
   présence de la clé de chiffrement `DCMANAGER_SECRETS_KEY` — la MÊME que les
   modules vm/, wifi/ et notify/, ce qui est VOULU (SecretBox est un service serveur
   PARTAGÉ : une seule clé d'infrastructure à distribuer et à faire tourner) :
   - clé PRÉSENTE → stockage DB chiffré ; synchro/statut + routes CRUD/test ACTIVES.
   - clé ABSENTE → module « clé manquante » : `service` null, TOUTES les routes
     répondent 503 ACTIONNABLE (« définir DCMANAGER_SECRETS_KEY… »). Si une
     `issue-providers.db` existe DÉJÀ sans clé, le message est ENRICHI (des jetons
     chiffrés attendent la clé — l'opérateur doit la fournir pour les déchiffrer).

   Routes (montées sous la garde d'accès de l'API, mergeParams pour :docId) :
   - POST   /documents/:docId/issues/sync           → synchronise TOUS les providers
   - GET    /documents/:docId/issues/status         → état par provider
   - GET    /documents/:docId/issues/providers      → liste (SANS jeton)
   - PUT    /documents/:docId/issues/providers/:id  → créer/mettre à jour un provider
   - DELETE /documents/:docId/issues/providers/:id  → supprimer un provider
   - POST   /documents/:docId/issues/providers/test → tester une config candidate
   - POST   /documents/:docId/issues/follow         → « Suivre un ticket » (cf. ci-dessous)

   ⚠ `POST …/issues/follow` est la PORTE D'ENTRÉE de l'assiette (décision D4), et la
   seule route de ce module qui ÉCRIT dans le document. Elle prend une RÉFÉRENCE
   saisie — clé lisible (« INFRA-123 ») ou URL collée — parce que c'est ce que
   l'utilisateur a sous la main ; le serveur, lui, persiste l'identifiant INTERNE.
   Une référence non résolue rend un 422 ACTIONNABLE et ne crée RIEN : on ne
   persiste pas un ticket fantôme (422 et non 404 — la requête est bien formée,
   c'est la référence qui est inexploitable).

   Après CHAQUE écriture CRUD : `service.rearmTimers()` (rechargement à chaud de la
   config — plus de redémarrage nécessaire). Une config INVALIDE ne fait PAS tomber
   le serveur : le module démarre « en erreur », les routes répondent 503 avec le
   détail — visibilité opérateur sans sacrifier le reste de l'application.

   INVARIANT : aucune réponse ne contient de jeton (clair ou chiffré) — les réponses
   de lecture/écriture renvoient au plus `has_token: true` ; le test renvoie un
   `IssueProviderInfo` (aucun secret). Garanti par IssueProviderConfigDb/adaptateurs.
   ============================================================================= */

/** Nom de la base des providers — utilisé pour détecter le cas « clé absente mais DB présente ». */
const PROVIDERS_DB_FILE = "issue-providers.db";

export class IssueModule {
  private constructor(
    private readonly docs: DocumentStore,
    private readonly service: IssueSyncService | null,
    /** Backend CRUD (stockage DB chiffré). null si clé absente ou module en erreur. */
    private readonly providerDb: IssueProviderConfigDb | null,
    /** Message d'erreur de chargement de la config (null = config saine ou absente). */
    private readonly configError: string | null,
    /** Vrai quand la clé de chiffrement est absente → TOUTES les routes répondent 503 « définir la clé ». */
    private readonly keyMissing: boolean,
    private readonly log: Logger,
  ) {}

  static create(opts: { docs: DocumentStore; live: IssueLivePublisher; dataDir: string; sqlite: SqliteCtor; log?: Logger; problems?: ProblemReporter }): IssueModule {
    const log = opts.log || new Logger("error");
    // Coffre PARTAGÉ (clé unique DCMANAGER_SECRETS_KEY ; aucun repli — cf. SecretBox).
    // `fromEnv` PEUT jeter si la clé est PRÉSENTE mais trop courte : ce n'est PAS « clé absente »
    // (qui désactive proprement la feature) mais une clé INVALIDE. On l'encaisse en « module démarré
    // EN ERREUR » (routes en 503 avec le message actionnable) sans faire tomber le serveur —
    // philosophie « une config invalide ne fait pas tomber le serveur ».
    let box: SecretBox | null;
    try {
      box = SecretBox.fromEnv(process.env);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error("clé de chiffrement des secrets de tickets invalide — module démarré en erreur (feature désactivée)", message);
      return new IssueModule(opts.docs, null, null, message, false, log);
    }

    // ---- Clé PRÉSENTE : stockage DB chiffré (UNIQUE source de config). ----
    if (box) {
      try {
        const providerDb = new IssueProviderConfigDb(opts.dataDir, opts.sqlite, box, log);
        // On re-passe EXPLICITEMENT les défauts des positions 5-6 (fabrique d'adaptateur + délai
        // anti-rafale) pour atteindre le 7e paramètre positionnel `problems` : comportement
        // inchangé, seul le rapporteur de problèmes (optionnel) est ajouté.
        const service = new IssueSyncService(opts.docs, opts.live, providerDb, log, IssueSyncService.adapterFor, IssueSyncService.DEFAULT_MIN_INTERVAL_SEC, opts.problems);
        log.info("module Tickets prêt (stockage DB chiffré, CRUD actif)", "node " + process.version);
        return new IssueModule(opts.docs, service, providerDb, null, false, log);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.error("stockage DB des providers de tickets en erreur — module démarré en erreur (synchro désactivée)", message);
        return new IssueModule(opts.docs, null, null, message, false, log);
      }
    }

    // ---- Clé ABSENTE : module « clé manquante ». La feature est ENTIÈREMENT désactivée : toutes les
    // routes répondent 503 actionnable. Message ENRICHI si une issue-providers.db existe DÉJÀ sans
    // clé (des jetons chiffrés attendent la clé). ----
    const dbPath = path.join(opts.dataDir, PROVIDERS_DB_FILE);
    if (fs.existsSync(dbPath)) {
      const message = PROVIDERS_DB_FILE + " présent mais aucune clé de chiffrement (" + SecretBox.ENV_VAR
        + ") — base chiffrée présente sans clé : définissez la clé pour déchiffrer les jetons stockés";
      log.error("module Tickets en erreur : base chiffrée présente sans clé", message);
      return new IssueModule(opts.docs, null, null, message, true, log);
    }
    log.info("module Tickets inactif : aucune clé de chiffrement (" + SecretBox.ENV_VAR + ") — configuration des providers indisponible");
    return new IssueModule(opts.docs, null, null, null, true, log);
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
      if (!this.service) { this.respondUnavailable(res); return; }
      this.service.syncDocument(docId)
        // Enrichissement : les providers au jeton indéchiffrable sont EXCLUS de la synchro (donc
        // absents du résultat) — on les réinjecte en erreur pour qu'ils restent visibles côté UI.
        .then((providers) => res.json({ providers: this.withTokenErrors(docId, providers) }))
        .catch((e) => {
          // syncProvider ne jette jamais — ceci est une ceinture (bug interne) : 500 loggé, jamais silencieux.
          this.log.error("POST /issues/sync : échec inattendu", docId, e instanceof Error ? e.message : String(e));
          res.status(500).json({ error: "synchronisation en échec" });
        });
    });

    router.get("/status", (req, res) => {
      const docId = (req.params as any).docId as string;
      if (!this.docs.get(docId)) { res.status(404).json({ error: "document inconnu" }); return; }
      if (!this.service) { this.respondUnavailable(res); return; }
      // `statusFor` s'appuie sur `summariesFor`, qui EXCLUT les providers au jeton indéchiffrable
      // (clé changée) → sans ce complément ils disparaîtraient silencieusement de l'UI.
      res.json({ providers: this.withTokenErrors(docId, this.service.statusFor(docId)) });
    });

    /* ---- « SUIVRE UN TICKET » : la porte d'entrée de l'assiette (D4) ---- */

    router.post("/follow", (req, res) => {
      const docId = (req.params as any).docId as string;
      if (!this.docs.get(docId)) { res.status(404).json({ error: "document inconnu" }); return; }
      if (!this.service) { this.respondUnavailable(res); return; }
      const body: any = (req.body && typeof req.body === "object") ? req.body : {};
      const reference = typeof body.reference === "string" ? body.reference : "";
      this.service.followReference(docId, reference)
        .then((result) => {
          // REFUS → 422 : la requête est bien formée, c'est la RÉFÉRENCE qui est inexploitable
          // (ticket inexistant, hors permissions, provider en panne). Le message du service est déjà
          // actionnable — on ne l'enveloppe pas, sinon il ne reste plus rien d'exploitable.
          if (!result.ok) { res.status(422).json({ error: result.message }); return; }
          res.json({ issue: result.issue, already: result.already, provider_id: result.provider_id, message: result.message });
        })
        .catch((e) => {
          this.log.error("POST /issues/follow : échec inattendu", docId, e instanceof Error ? e.message : String(e));
          res.status(500).json({ error: "suivi du ticket en échec" });
        });
    });

    /* ---- CRUD des providers (stockage DB chiffré uniquement) ---- */

    router.get("/providers", (req, res) => {
      const docId = (req.params as any).docId as string;
      if (!this.docs.get(docId)) { res.status(404).json({ error: "document inconnu" }); return; }
      const db = this.crudBackend(res); if (!db) return;
      res.json({ providers: db.listFor(docId) });   // SANS jeton (has_token: true)
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
        this.service?.rearmTimers();   // la config a changé À CHAUD → ré-armer les timers périodiques
        res.json({ provider });        // réponse SANS jeton (garanti par IssueProviderConfigDb)
      } catch (e) {
        if (e instanceof IssueProviderConfigError) { res.status(400).json({ error: "configuration invalide", issues: e.issues }); return; }
        this.log.error("PUT /issues/providers : échec", docId, id, e instanceof Error ? e.message : String(e));
        res.status(500).json({ error: "enregistrement du provider en échec" });
      }
    });

    router.delete("/providers/:id", (req, res) => {
      const docId = (req.params as any).docId as string;
      const id = (req.params as any).id as string;
      if (!this.docs.get(docId)) { res.status(404).json({ error: "document inconnu" }); return; }
      const db = this.crudBackend(res); if (!db) return;
      if (!db.remove(docId, id)) { res.status(404).json({ error: "provider inconnu" }); return; }
      this.service?.rearmTimers();   // la config a changé À CHAUD → ré-armer les timers périodiques
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
        if (e instanceof IssueProviderConfigError) { res.status(400).json({ error: "configuration invalide", issues: e.issues }); return; }
        // Échec de CONSTRUCTION hors validation — cas typique : le jeton STOCKÉ est indéchiffrable
        // (clé DCMANAGER_SECRETS_KEY changée/perdue). Le message SecretBox est SÛR (aucun jeton) et
        // ACTIONNABLE (« le secret doit être ressaisi ») : on le RENVOIE au client au lieu d'un 500
        // muet — c'est CE message que le bouton « Tester » doit afficher. 422 : la requête est bien
        // formée, c'est la donnée STOCKÉE qui est inexploitable (à ressaisir).
        const message = e instanceof Error ? e.message : String(e);
        this.log.error("POST /issues/providers/test : construction en échec", docId, message);
        res.status(422).json({ error: message }); return;
      }
      let adapter;
      try {
        adapter = IssueSyncService.adapterFor(config);   // fabrique par kind (LE point d'extension marque)
      } catch (e) {
        // kind inconnu → 400 (config candidate erronée), message sans secret.
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); return;
      }
      adapter.test()
        .then((info) => res.json({ info }))   // IssueProviderInfo — AUCUN jeton
        .catch((e) => {
          this.log.error("POST /issues/providers/test : échec inattendu", docId, e instanceof Error ? e.message : String(e));
          res.status(500).json({ error: "test en échec" });
        });
    });

    return { path: "/documents/:docId/issues", router };
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Réinjecte dans la liste des statuts les providers dont le jeton stocké est INDÉCHIFFRABLE (clé
      DCMANAGER_SECRETS_KEY changée/perdue) : les lectures les excluent → ils sont absents de
      `statusFor`/`syncDocument` et, sans ce complément, DISPARAISSENT silencieusement de l'UI
      (l'incident constaté sur le module VM). Le message d'erreur de SecretBox est SÛR (aucun secret)
      et actionnable.
      ⚠ PRÉCONDITION : appelé APRÈS `statusFor` (via `summariesFor`) OU `syncDocument` (via
      `providersFor`) — les DEUX rafraîchissent `tokenErrorsFor` pour ce document (sinon on lirait des
      erreurs périmées ou vides). */
  private withTokenErrors(docId: string, statuses: IssueProviderStatus[]): IssueProviderStatus[] {
    if (!this.providerDb) return statuses;
    const errors = this.providerDb.tokenErrorsFor(docId);
    if (!errors.length) return statuses;
    const known = new Set(statuses.map((s) => s.provider_id));
    const configured = this.providerDb.listFor(docId);
    const extra: IssueProviderStatus[] = [];
    for (const error of errors) {
      if (known.has(error.id)) continue;
      const item = configured.find((p) => p.id === error.id);
      extra.push({
        provider_id: error.id,
        kind: item ? item.kind : "",
        interval_sec: item ? item.interval_sec : 0,
        last_attempt: null, last_success: null, ok: false,
        message: error.message,   // « le secret doit être ressaisi » — sans aucun contenu sensible
        counts: null,
      });
    }
    // Ordre STABLE (par id) : la liste est affichée telle quelle, elle ne doit pas sautiller d'un
    // rafraîchissement à l'autre selon qu'un jeton se déchiffre ou non.
    return [...statuses, ...extra].sort((a, b) => a.provider_id.localeCompare(b.provider_id));
  }

  /** Renvoie le backend CRUD (stockage DB) OU répond 503 (via respondUnavailable) et renvoie null. */
  private crudBackend(res: express.Response): IssueProviderConfigDb | null {
    if (this.providerDb) return this.providerDb;
    this.respondUnavailable(res);
    return null;
  }

  /** Écrit le 503 approprié quand la feature est indisponible. Deux cas :
      - clé ABSENTE (keyMissing) → 503 ACTIONNABLE « définir DCMANAGER_SECRETS_KEY… », enrichi du
        détail « base chiffrée présente sans clé… » quand une issue-providers.db existe déjà ;
      - module en erreur (clé présente mais DB/config KO) → le détail de l'erreur de chargement. */
  private respondUnavailable(res: express.Response): void {
    if (this.keyMissing) {
      res.status(503).json({
        error: "gestion des providers de tickets désactivée",
        detail: this.configError || ("définir " + SecretBox.ENV_VAR + " (passphrase de chiffrement des secrets) pour activer la configuration des providers"),
      });
      return;
    }
    res.status(503).json({ error: "configuration des providers de tickets invalide", detail: this.configError });
  }
}
