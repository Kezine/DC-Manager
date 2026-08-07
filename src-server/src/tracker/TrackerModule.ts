import fs from "node:fs";
import path from "node:path";
import express from "express";
import { RequestAuthor, type ApiExtension } from "../api.js";   // RequestAuthor : id canonique de l'auteur (audit)
import type { DocumentStore } from "../documents.js";
import type { SqliteCtor } from "../db.js";
import { Logger } from "../logger.js";
import { TrackerProviderConfigDb } from "./TrackerProviderConfigDb.js";
import { TrackerProviderConfigError } from "./TrackerProviderConfigValidate.js";
import { SecretBox } from "../SecretBox.js";
import type { InterventionTrackerSource } from "./TrackerProvider.js";
import {
  TrackerSyncService,
  type ProblemReporter, type TrackerActionResult, type TrackerLivePublisher, type TrackerProviderStatus,
} from "./TrackerSyncService.js";

/* =============================================================================
   MODULE TRACKER — façade d'assemblage et POINT DE BRANCHEMENT UNIQUE du PONT
   « interventions ⇄ tracker distant » (amovible) : config des providers (par
   document) + moteur de poussée/retour d'état + routes REST, livrés au bootstrap
   sous forme d'ApiExtension.

   Suppression de la feature = retirer le câblage `TrackerModule` d'index.ts et le
   dossier `tracker/` — le cœur (api/db/documents/live) n'importe RIEN d'ici, et
   `interventions/` non plus : il expose seulement un hook `onWrite` OPTIONNEL et
   des colonnes `tracker_*` qui restent simplement vides.

   AGNOSTIQUE DE MARQUE : aucune route, aucun message et aucun champ de ce fichier
   ne nomme une marque. Les réglages propres à un tracker transitent dans l'objet
   `options` du corps, validé par la branche `kind` correspondante
   (`TrackerProviderConfigValidate`) — un test relit ces sources pour le vérifier.

   SUPPORT DE STOCKAGE UNIQUE (base chiffrée `tracker-providers.db`), conditionné à
   la présence de la clé de chiffrement `DCMANAGER_SECRETS_KEY` — la MÊME que les
   modules vm/, wifi/ et notify/, ce qui est VOULU (SecretBox est un service serveur
   PARTAGÉ : une seule clé d'infrastructure à distribuer et à faire tourner) :
   - clé PRÉSENTE → stockage DB chiffré ; poussées/retour d'état + routes ACTIVES.
   - clé ABSENTE → module « clé manquante » : `service` null, TOUTES les routes
     répondent 503 ACTIONNABLE (« définir DCMANAGER_SECRETS_KEY… »). Si une
     `tracker-providers.db` existe DÉJÀ sans clé, le message est ENRICHI (des jetons
     chiffrés attendent la clé — l'opérateur doit la fournir pour les déchiffrer).
   ⚠ Le module interventions, lui, reste PLEINEMENT fonctionnel sans cette clé : le
   pont est un supplément, jamais une dépendance.

   Routes (montées sous la garde d'accès de l'API, mergeParams pour :docId) :
   - POST   /documents/:docId/tracker/sync            → poussées dues + retour d'état, tous providers
   - GET    /documents/:docId/tracker/status          → état par provider (mémoire)
   - GET    /documents/:docId/tracker/providers       → liste (SANS jeton)
   - PUT    /documents/:docId/tracker/providers/:id   → créer/mettre à jour un provider
   - DELETE /documents/:docId/tracker/providers/:id   → supprimer un provider
   - POST   /documents/:docId/tracker/providers/test  → tester une config candidate
   - POST   /documents/:docId/tracker/replicate/:interventionId → réplication MANUELLE
       (corps `{ provider_id? }` — requis si plusieurs providers ; `{ link: true }` ⇒ LIER
       le ticket déjà désigné par la référence Jira de l'intervention au lieu d'en créer un)
   - POST   /documents/:docId/tracker/push/:interventionId      → « Mettre à jour le ticket »
       (récupération d'un échec de poussée — décision E4)

   ⚠ Les segments d'ACTION (`/sync`, `/replicate/…`, `/push/…`) ne sont pas
   décoratifs : les extensions sont montées AVANT le routeur de données du cœur,
   précisément pour que leurs chemins ne soient pas lus comme des collections. Un
   module AMOVIBLE ne doit pas changer le comportement du cœur.

   Après CHAQUE écriture CRUD : `service.rearmTimers()` (rechargement à chaud de la
   config — plus de redémarrage nécessaire). Une config INVALIDE ne fait PAS tomber
   le serveur : le module démarre « en erreur », les routes répondent 503 avec le
   détail — visibilité opérateur sans sacrifier le reste de l'application.

   INVARIANT : aucune réponse ne contient de jeton (clair ou chiffré) — les réponses
   de lecture/écriture renvoient au plus `has_token: true` ; le test renvoie un
   `TrackerProviderInfo` (aucun secret). Garanti par TrackerProviderConfigDb/adaptateurs.
   ============================================================================= */

/** Nom de la base des providers — utilisé pour détecter le cas « clé absente mais DB présente ». */
const PROVIDERS_DB_FILE = "tracker-providers.db";

export class TrackerModule {
  private constructor(
    private readonly docs: DocumentStore,
    private readonly service: TrackerSyncService | null,
    /** Backend CRUD (stockage DB chiffré). null si clé absente ou module en erreur. */
    private readonly providerDb: TrackerProviderConfigDb | null,
    /** Message d'erreur de chargement de la config (null = config saine ou absente). */
    private readonly configError: string | null,
    /** Vrai quand la clé de chiffrement est absente → TOUTES les routes répondent 503 « définir la clé ». */
    private readonly keyMissing: boolean,
    private readonly log: Logger,
  ) {}

  static create(opts: {
    docs: DocumentStore;
    /** Surface du module interventions, vue par CONTRAT (typage structurel — cf. `TrackerProvider.ts`). */
    interventions: InterventionTrackerSource;
    dataDir: string;
    sqlite: SqliteCtor;
    log?: Logger;
    live?: TrackerLivePublisher;
    problems?: ProblemReporter;
  }): TrackerModule {
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
      log.error("clé de chiffrement des secrets de tracker invalide — module démarré en erreur (pont désactivé)", message);
      return new TrackerModule(opts.docs, null, null, message, false, log);
    }

    // ---- Clé PRÉSENTE : stockage DB chiffré (UNIQUE source de config). ----
    if (box) {
      try {
        const providerDb = new TrackerProviderConfigDb(opts.dataDir, opts.sqlite, box, log);
        // On re-passe EXPLICITEMENT les défauts des positions intermédiaires (fabrique d'adaptateur,
        // délai anti-rafale) pour atteindre les paramètres OPTIONNELS de queue : comportement
        // inchangé, seuls le rapporteur de problèmes et le bus live sont ajoutés.
        const service = new TrackerSyncService(
          opts.docs, opts.interventions, providerDb, log,
          TrackerSyncService.adapterFor, TrackerSyncService.DEFAULT_MIN_INTERVAL_SEC,
          opts.problems, opts.live,
        );
        log.info("module Tracker prêt (stockage DB chiffré, pont actif)", "node " + process.version);
        return new TrackerModule(opts.docs, service, providerDb, null, false, log);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.error("stockage DB des providers de tracker en erreur — module démarré en erreur (pont désactivé)", message);
        return new TrackerModule(opts.docs, null, null, message, false, log);
      }
    }

    // ---- Clé ABSENTE : module « clé manquante ». Le pont est ENTIÈREMENT désactivé : toutes les
    // routes répondent 503 actionnable, et le hook d'écriture devient un no-op. Message ENRICHI si
    // une tracker-providers.db existe DÉJÀ sans clé (des jetons chiffrés attendent la clé). ----
    const dbPath = path.join(opts.dataDir, PROVIDERS_DB_FILE);
    if (fs.existsSync(dbPath)) {
      const message = PROVIDERS_DB_FILE + " présent mais aucune clé de chiffrement (" + SecretBox.ENV_VAR
        + ") — base chiffrée présente sans clé : définissez la clé pour déchiffrer les jetons stockés";
      log.error("module Tracker en erreur : base chiffrée présente sans clé", message);
      return new TrackerModule(opts.docs, null, null, message, true, log);
    }
    log.info("module Tracker inactif : aucune clé de chiffrement (" + SecretBox.ENV_VAR + ") — réplication vers un tracker indisponible");
    return new TrackerModule(opts.docs, null, null, null, true, log);
  }

  /** Démarre le pont (no-op si config en erreur/absente) : ① le RAMASSAGE des poussées qu'un arrêt
      du serveur a laissées en plan, ② les passes périodiques des providers à `interval_sec > 0`.
      ⚠ Le ramassage n'est PAS attendu — il parle à un tiers, et le serveur doit démarrer
      normalement tracker ÉTEINT (il est appelé APRÈS `listen()`, comme les autres modules). Il ne
      jette jamais de son propre fait ; le `catch` est une ceinture contre un bug interne, qui ne
      doit pas devenir un rejet de promesse non capturé. */
  start(): void {
    void this.service?.sweepPushDue().catch((e) =>
      this.log.error("tracker : ramassage au démarrage — échec inattendu", e instanceof Error ? e.message : String(e)));
    this.service?.startTimers();
  }

  stop(): void {
    this.service?.stopTimers();
    this.providerDb?.close();
  }

  /** PONT D'ÉCRITURE — branché sur le hook `onWrite` du module interventions dans `index.ts`.
      No-op quand le pont est inactif (clé absente, module en erreur) : c'est exactement ce qui rend
      les interventions utilisables SANS tracker. Ne jette jamais (le service s'en charge). */
  onInterventionWrite(docId: string, interventionId: string, kind: "put" | "delete"): void {
    this.service?.onInterventionWrite(docId, interventionId, kind);
  }

  /* --------------------------------------------------------------------------
     Routes REST
     -------------------------------------------------------------------------- */

  /** Extension API à passer au Server (montée après la garde d'accès du cœur). */
  extension(): ApiExtension {
    const router = express.Router({ mergeParams: true });

    router.post("/sync", (req, res) => {
      const docId = (req.params as any).docId as string;
      if (!this.docs.get(docId)) { res.status(404).json({ error: "document inconnu" }); return; }
      if (!this.service) { this.respondUnavailable(res); return; }
      this.service.syncDocument(docId)
        // Enrichissement : les providers au jeton indéchiffrable sont EXCLUS de la passe (donc
        // absents du résultat) — on les réinjecte en erreur pour qu'ils restent visibles côté UI.
        .then((providers) => res.json({ providers: this.withTokenErrors(docId, providers) }))
        .catch((e) => {
          // syncProvider ne jette jamais — ceci est une ceinture (bug interne) : 500 loggé, jamais silencieux.
          this.log.error("POST /tracker/sync : échec inattendu", docId, e instanceof Error ? e.message : String(e));
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

    /* ---- ACTIONS MANUELLES sur UNE intervention (décisions E2 et E4) ---- */

    router.post("/replicate/:interventionId", (req, res) => {
      const docId = (req.params as any).docId as string;
      if (!this.docs.get(docId)) { res.status(404).json({ error: "document inconnu" }); return; }
      if (!this.service) { this.respondUnavailable(res); return; }
      const interventionId = (req.params as any).interventionId as string;
      const body: any = (req.body && typeof req.body === "object") ? req.body : {};
      // AUDIT : répliquer chez un tiers est un effet IRRÉVERSIBLE — on trace QUI l'a demandé (id
      // canonique posé par le serveur, jamais le corps de la requête).
      const author = RequestAuthor.identity(req);
      this.service.replicate(docId, interventionId, {
        providerId: typeof body.provider_id === "string" ? body.provider_id : null,
        link: body.link === true,
      })
        .then((result) => {
          if (result.ok) this.log.info("POST /tracker/replicate : intervention répliquée", docId, interventionId, result.provider_id || "", result.key || "", "par " + author.id + " (" + author.name + ")");
          TrackerModule.respondAction(res, result);
        })
        .catch((e) => {
          this.log.error("POST /tracker/replicate : échec inattendu", docId, interventionId, e instanceof Error ? e.message : String(e));
          res.status(500).json({ error: "réplication en échec" });
        });
    });

    router.post("/push/:interventionId", (req, res) => {
      const docId = (req.params as any).docId as string;
      if (!this.docs.get(docId)) { res.status(404).json({ error: "document inconnu" }); return; }
      if (!this.service) { this.respondUnavailable(res); return; }
      const interventionId = (req.params as any).interventionId as string;
      const author = RequestAuthor.identity(req);
      this.service.pushNow(docId, interventionId)
        .then((result) => {
          if (result.ok) this.log.info("POST /tracker/push : ticket mis à jour", docId, interventionId, result.key || "", "par " + author.id + " (" + author.name + ")");
          TrackerModule.respondAction(res, result);
        })
        .catch((e) => {
          this.log.error("POST /tracker/push : échec inattendu", docId, interventionId, e instanceof Error ? e.message : String(e));
          res.status(500).json({ error: "mise à jour du ticket en échec" });
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
        this.service?.rearmTimers();   // la config a changé À CHAUD → ré-armer les passes périodiques
        res.json({ provider });        // réponse SANS jeton (garanti par TrackerProviderConfigDb)
      } catch (e) {
        if (e instanceof TrackerProviderConfigError) { res.status(400).json({ error: "configuration invalide", issues: e.issues }); return; }
        this.log.error("PUT /tracker/providers : échec", docId, id, e instanceof Error ? e.message : String(e));
        res.status(500).json({ error: "enregistrement du provider en échec" });
      }
    });

    router.delete("/providers/:id", (req, res) => {
      const docId = (req.params as any).docId as string;
      const id = (req.params as any).id as string;
      if (!this.docs.get(docId)) { res.status(404).json({ error: "document inconnu" }); return; }
      const db = this.crudBackend(res); if (!db) return;
      if (!db.remove(docId, id)) { res.status(404).json({ error: "provider inconnu" }); return; }
      this.service?.rearmTimers();   // la config a changé À CHAUD → ré-armer les passes périodiques
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
        if (e instanceof TrackerProviderConfigError) { res.status(400).json({ error: "configuration invalide", issues: e.issues }); return; }
        // Échec de CONSTRUCTION hors validation — cas typique : le jeton STOCKÉ est indéchiffrable
        // (clé DCMANAGER_SECRETS_KEY changée/perdue). Le message SecretBox est SÛR (aucun jeton) et
        // ACTIONNABLE (« le secret doit être ressaisi ») : on le RENVOIE au client au lieu d'un 500
        // muet — c'est CE message que le bouton « Tester » doit afficher. 422 : la requête est bien
        // formée, c'est la donnée STOCKÉE qui est inexploitable (à ressaisir).
        const message = e instanceof Error ? e.message : String(e);
        this.log.error("POST /tracker/providers/test : construction en échec", docId, message);
        res.status(422).json({ error: message }); return;
      }
      let adapter;
      try {
        adapter = TrackerSyncService.adapterFor(config);   // fabrique par kind (LE point d'extension marque)
      } catch (e) {
        // kind inconnu → 400 (config candidate erronée), message sans secret.
        res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); return;
      }
      adapter.test()
        .then((info) => res.json({ info }))   // TrackerProviderInfo — AUCUN jeton
        .catch((e) => {
          this.log.error("POST /tracker/providers/test : échec inattendu", docId, e instanceof Error ? e.message : String(e));
          res.status(500).json({ error: "test en échec" });
        });
    });

    return { path: "/documents/:docId/tracker", router };
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Traduit le résultat d'une action manuelle en réponse HTTP. Le CODE est dérivé de la NATURE du
      refus (`TrackerActionFailure`), jamais d'une relecture du message ; le MESSAGE, lui, est
      toujours transmis TEL QUEL — sur un refus du tracker c'est le sien (« le champ X est requis »),
      et l'envelopper le rendrait inexploitable.
      🚨 `key` accompagne la réponse MÊME en échec : quand un ticket a réellement été créé, c'est la
      seule information qui rende la situation rattrapable (l'utilisateur le LIE ensuite). */
  private static respondAction(res: express.Response, result: TrackerActionResult): void {
    if (result.ok) {
      res.json({ ok: true, provider_id: result.provider_id, ext_id: result.ext_id, key: result.key, message: result.message });
      return;
    }
    const status = result.failure === "not_found" ? 404
      : result.failure === "conflict" ? 409
        : result.failure === "invalid" ? 400 : 422;
    res.status(status).json({ error: result.message, provider_id: result.provider_id, ext_id: result.ext_id, key: result.key });
  }

  /** Réinjecte dans la liste des statuts les providers dont le jeton stocké est INDÉCHIFFRABLE (clé
      DCMANAGER_SECRETS_KEY changée/perdue) : les lectures les excluent → ils sont absents de
      `statusFor`/`syncDocument` et, sans ce complément, DISPARAISSENT silencieusement de l'UI
      (l'incident constaté sur le module VM). Le message d'erreur de SecretBox est SÛR (aucun secret)
      et actionnable.
      ⚠ PRÉCONDITION : appelé APRÈS `statusFor` (via `summariesFor`) OU `syncDocument` (via
      `providersFor`) — les DEUX rafraîchissent `tokenErrorsFor` pour ce document (sinon on lirait des
      erreurs périmées ou vides). */
  private withTokenErrors(docId: string, statuses: TrackerProviderStatus[]): TrackerProviderStatus[] {
    if (!this.providerDb) return statuses;
    const errors = this.providerDb.tokenErrorsFor(docId);
    if (!errors.length) return statuses;
    const known = new Set(statuses.map((s) => s.provider_id));
    const configured = this.providerDb.listFor(docId);
    const extra: TrackerProviderStatus[] = [];
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
  private crudBackend(res: express.Response): TrackerProviderConfigDb | null {
    if (this.providerDb) return this.providerDb;
    this.respondUnavailable(res);
    return null;
  }

  /** Écrit le 503 approprié quand la feature est indisponible. Deux cas :
      - clé ABSENTE (keyMissing) → 503 ACTIONNABLE « définir DCMANAGER_SECRETS_KEY… », enrichi du
        détail « base chiffrée présente sans clé… » quand une tracker-providers.db existe déjà ;
      - module en erreur (clé présente mais DB/config KO) → le détail de l'erreur de chargement. */
  private respondUnavailable(res: express.Response): void {
    if (this.keyMissing) {
      res.status(503).json({
        error: "réplication vers un tracker désactivée",
        detail: this.configError || ("définir " + SecretBox.ENV_VAR + " (passphrase de chiffrement des secrets) pour activer la configuration des providers"),
      });
      return;
    }
    res.status(503).json({ error: "configuration des providers de tracker invalide", detail: this.configError });
  }
}
