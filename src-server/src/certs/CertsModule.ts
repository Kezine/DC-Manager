import express from "express";
import type { ApiExtension } from "../api.js";
import type { DocumentStore } from "../documents.js";
import type { SqliteCtor } from "../db.js";
import { Logger } from "../logger.js";
import { CertsDb, type CertsListOpts } from "./CertsDb.js";
import { CertsConfigError, CERT_KINDS } from "./CertsValidate.js";
import { CertExpiryWatcher, type CertProblemReporter } from "./CertExpiryWatcher.js";

/* =============================================================================
   MODULE CERTIFICATS (PKI interne) — façade d'assemblage et POINT DE
   BRANCHEMENT UNIQUE de la feature (amovible, pattern vm/ et notify/) :
   persistance certs.db + routes REST, livrées au bootstrap en ApiExtension.

   Suppression de la feature = retirer le câblage CertsModule d'index.ts et le
   dossier certs/ — le cœur (api/db/documents/live) n'importe RIEN d'ici.

   ZÉRO-CONNAISSANCE : ce module ne détient AUCUNE clé — pas de SecretBox, pas
   de variable d'environnement. Toute la cryptographie vit dans le NAVIGATEUR
   (dérivation PBKDF2 de la clé maître, chiffrement AES-GCM des clés privées,
   signature X.509/SSH) ; le serveur stocke des MÉTADONNÉES (sujets, échéances,
   empreintes — matière du suivi d'expiration C7) et des blobs opaques
   (`key_enc`, `wrapped_dek`) qu'il est INCAPABLE de déchiffrer. Conséquence
   assumée (documentée) : phrase maître perdue = clés privées perdues.

   Routes (montées sous la garde d'accès de l'API, mergeParams pour :docId) —
   ⚠ /pki et /pki/rekey sont déclarées AVANT /:id (sinon « pki » serait lu comme id) :
   - GET    /documents/:docId/certs          → liste métadonnées + SAN (JAMAIS key_enc — Q5)
   - GET    /documents/:docId/certs/pki      → paramètres KDF + wrapped_dek (dérivation côté client)
   - PUT    /documents/:docId/certs/pki      → initialisation UNIQUE (409 si déjà initialisée :
                                               ré-initialiser rendrait tout indéchiffrable)
   - PUT    /documents/:docId/certs/pki/rekey → changer la phrase maître (ré-emballe le seul
                                               wrapped_dek ; AUCUN key_enc touché ; 404 si vierge,
                                               409 conflict si l'enveloppe a changé entre-temps ;
                                               l'ancienne enveloppe est ARCHIVÉE — récupérable)
   - GET    /documents/:docId/certs/:id      → détail unitaire, key_enc INCLUS (Q5)
   - PUT    /documents/:docId/certs/:id     → créer/mettre à jour (métadonnées validées,
                                              blobs opaques ; key_enc absent = conservé)
   - DELETE /documents/:docId/certs/:id     → suppression (409 si des dérivés existent)

   SUIVI DES ÉCHÉANCES (C7) : un timer HORAIRE fait tourner CertExpiryWatcher
   (raise/resolve `cert-expiry` par certificat, seuils Q6 30/14/7 j) — la
   granularité pertinente est le JOUR, une heure est déjà large. Une passe est
   aussi déclenchée après CHAQUE écriture (création/renouvellement/révocation/
   suppression) : le suivi reflète l'action sans attendre le tick. Le rapporteur
   est OPTIONNEL (interface CertProblemReporter injectée au bootstrap — sans
   lui, le module vit normalement, simplement sans notifications).
   ============================================================================= */

/** Période du timer d'échéances : 1 h (l'échéance se mesure en jours — inutile plus fin). */
const EXPIRY_TICK_MS = 3600 * 1000;

export class CertsModule {
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor(
    private readonly docs: DocumentStore,
    /** null = module en erreur (ouverture de certs.db impossible) → routes en 503 détaillé. */
    private readonly db: CertsDb | null,
    /** Veilleur d'échéances — null si module en erreur OU aucun rapporteur branché. */
    private readonly watcher: CertExpiryWatcher | null,
    /** Rapporteur de problèmes (pont notify du bootstrap) — resolve explicite aux suppressions/révocations. */
    private readonly problems: CertProblemReporter | null,
    private readonly configError: string | null,
    private readonly log: Logger,
  ) {}

  static create(opts: { docs: DocumentStore; dataDir: string; sqlite: SqliteCtor; log?: Logger; problems?: CertProblemReporter }): CertsModule {
    const log = opts.log || new Logger("error");
    try {
      const db = new CertsDb(opts.dataDir, opts.sqlite, log);
      const watcher = opts.problems ? new CertExpiryWatcher(db, opts.problems, undefined, undefined, log) : null;
      log.info("module certificats prêt (certs.db — zéro-connaissance, aucune clé serveur"
        + (watcher ? ", suivi d'échéances actif)" : ", suivi d'échéances SANS rapporteur)"));
      return new CertsModule(opts.docs, db, watcher, opts.problems || null, null, log);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error("module certificats en erreur — démarré désactivé", message);
      return new CertsModule(opts.docs, null, null, opts.problems || null, message, log);
    }
  }

  /** Démarre le suivi d'échéances : une passe immédiate (état du parc au boot) puis un tick horaire. */
  start(): void {
    if (!this.watcher) return;
    this.scanQuietly();
    this.timer = setInterval(() => this.scanQuietly(), EXPIRY_TICK_MS);
    // `unref` : le timer ne retient pas l'arrêt du process (parité VmSyncService/NotifyModule).
    (this.timer as any).unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.db?.close();
  }

  /** Passe de surveillance qui ne laisse JAMAIS échapper d'exception (un bug de balayage
      ne doit pas casser un tick d'horloge ni une réponse HTTP qui la déclenche). */
  private scanQuietly(): void {
    try {
      this.watcher?.scan();
    } catch (e) {
      this.log.error("certs: passe d'échéances en échec", e instanceof Error ? e.message : String(e));
    }
  }

  /* --------------------------------------------------------------------------
     Routes REST
     -------------------------------------------------------------------------- */

  /** Extension API à passer au Server (montée après la garde d'accès du cœur). */
  extension(): ApiExtension {
    const router = express.Router({ mergeParams: true });

    router.get("/", (req, res) => {
      const ctx = this.context(req, res); if (!ctx) return;
      const q: any = (req.query && typeof req.query === "object") ? req.query : {};
      // RÉTRO-COMPATIBILITÉ : sans AUCUN paramètre de listing, comportement HISTORIQUE (une page géante,
      // réponse { certificates } SANS total) — CertsClient/CertsAdminView actuels ne doivent pas casser.
      // Dès qu'un paramètre est présent → vrai listing paginé SQL (réponse forme ListResult).
      if (!CertsModule.LIST_PARAMS.some((k) => q[k] !== undefined)) {
        res.json({ certificates: ctx.db.listFor(ctx.docId) }); // SANS key_enc (invariant Q5)
        return;
      }
      res.json(ctx.db.listPage(ctx.docId, CertsModule.parseListQuery(q, false)));
    });

    /* ---- Paramètres PKI (déclarés AVANT /:id — « pki » n'est pas un id) ---- */

    router.get("/pki", (req, res) => {
      const ctx = this.context(req, res); if (!ctx) return;
      const params = ctx.db.pkiParams(ctx.docId);
      // initialized:false SANS 404 : la première ouverture côté client enchaîne sur l'initialisation.
      res.json(params ? { initialized: true, ...params } : { initialized: false });
    });

    router.put("/pki", (req, res) => {
      const ctx = this.context(req, res); if (!ctx) return;
      const body: any = (req.body && typeof req.body === "object") ? req.body : {};
      try {
        if (!ctx.db.initPki(ctx.docId, body)) {
          // Écrasement REFUSÉ : ré-initialiser tirerait une NOUVELLE DEK = toutes les clés
          // stockées deviennent illisibles. Aucune ré-initialisation (irréversible). Le
          // CHANGEMENT de phrase passe par /pki/rekey (il CONSERVE la DEK → key_enc intacts).
          res.status(409).json({ error: "PKI déjà initialisée pour ce document — la ré-initialisation est refusée (elle rendrait les clés stockées indéchiffrables). Pour changer la phrase maître, utilisez /pki/rekey." });
          return;
        }
        res.json({ ok: true });
      } catch (e) {
        if (e instanceof CertsConfigError) { res.status(400).json({ error: "paramètres invalides", issues: e.issues }); return; }
        this.log.error("PUT /certs/pki : échec", ctx.docId, e instanceof Error ? e.message : String(e));
        res.status(500).json({ error: "initialisation en échec" });
      }
    });

    // CHANGEMENT DE PHRASE MAÎTRE (déclarée AVANT /:id — « pki » n'est pas un id). Ne réécrit
    // que les paramètres KDF + le wrapped_dek (DEK ré-emballée sous la nouvelle KEK) : aucun
    // key_enc n'est touché. Le serveur ne pouvant PAS vérifier que le nouveau blob emballe la
    // même DEK (zéro-connaissance), l'opération est encadrée par un VERROU OPTIMISTE
    // (prev_wrapped_dek → 409 conflict si le coffre a changé entre-temps) et par
    // l'HISTORISATION de l'ancienne enveloppe (récupérable — cf. CertsDb.rekeyPki).
    router.put("/pki/rekey", (req, res) => {
      const ctx = this.context(req, res); if (!ctx) return;
      const body: any = (req.body && typeof req.body === "object") ? req.body : {};
      try {
        const verdict = ctx.db.rekeyPki(ctx.docId, body);
        if (verdict === "missing") {
          res.status(404).json({ error: "PKI non initialisée pour ce document — rien à re-chiffrer (initialisez-la d'abord)" });
          return;
        }
        if (verdict === "conflict") {
          // L'enveloppe a changé depuis la lecture du client (autre changement de phrase concurrent) :
          // écrire par-dessus perdrait silencieusement l'autre changement. Le client recharge et réessaie.
          res.status(409).json({ error: "le coffre a été modifié entre-temps (autre changement de phrase ?) — rechargez la page puis réessayez", code: "conflict" });
          return;
        }
        res.json({ ok: true });
      } catch (e) {
        if (e instanceof CertsConfigError) { res.status(400).json({ error: "paramètres invalides", issues: e.issues }); return; }
        this.log.error("PUT /certs/pki/rekey : échec", ctx.docId, e instanceof Error ? e.message : String(e));
        res.status(500).json({ error: "changement de phrase en échec" });
      }
    });

    /* ---- Racines + agrégats (déclarée AVANT /:id — « roots » n'est pas un id, comme /pki) ---- */

    router.get("/roots", (req, res) => {
      const ctx = this.context(req, res); if (!ctx) return;
      const q: any = (req.query && typeof req.query === "object") ? req.query : {};
      res.json(ctx.db.listRoots(ctx.docId, CertsModule.parseListQuery(q, true))); // forme ListResult + agrégats
    });

    /* ---- Certificats ---- */

    router.get("/:id", (req, res) => {
      const ctx = this.context(req, res); if (!ctx) return;
      const cert = ctx.db.getOne(ctx.docId, (req.params as any).id);
      if (!cert) { res.status(404).json({ error: "certificat inconnu" }); return; }
      res.json({ certificate: cert }); // key_enc INCLUS — GET unitaire uniquement (Q5)
    });

    router.put("/:id", (req, res) => {
      const ctx = this.context(req, res); if (!ctx) return;
      const id = (req.params as any).id as string;
      const body: any = (req.body && typeof req.body === "object") ? req.body : {};
      try {
        const certificate = ctx.db.save(ctx.docId, id, body);
        // Révocation → clôture EXPLICITE de l'alerte d'échéance (indépendante du jeu mémoire du
        // veilleur : vaut aussi pour une alerte levée par un processus précédent) ; toute écriture
        // relance une passe (création/renouvellement reflétés sans attendre le tick horaire).
        if (certificate.revoked_at !== null) this.problems?.resolve(CertExpiryWatcher.keyFor(ctx.docId, id));
        this.scanQuietly();
        res.json({ certificate });
      } catch (e) {
        if (e instanceof CertsConfigError) { res.status(400).json({ error: "données invalides", issues: e.issues }); return; }
        if (e instanceof Error && /FOREIGN KEY/i.test(e.message)) {
          // FK composite (doc_id, parent_id) : l'émetteur désigné n'existe pas dans CE document.
          res.status(400).json({ error: "données invalides", issues: ["parent_id : émetteur inconnu dans ce document"] });
          return;
        }
        this.log.error("PUT /certs/:id : échec", ctx.docId, id, e instanceof Error ? e.message : String(e));
        res.status(500).json({ error: "enregistrement du certificat en échec" });
      }
    });

    // `?force=true` = INTENTION EXPLICITE de supprimer un certificat ENCORE VALIDE. Sans lui, un tel
    // certificat est refusé (428) : par l'API il n'y a aucun prompt, c'est donc la seule barrière
    // contre un effacement naïf d'un certificat en production. Révoqué/expiré : aucune cérémonie.
    router.delete("/:id", (req, res) => {
      const ctx = this.context(req, res); if (!ctx) return;
      const id = (req.params as any).id as string;
      const force = String((req.query as any)?.force ?? "") === "true";
      const outcome = ctx.db.remove(ctx.docId, id, force);
      if (outcome === "missing") { res.status(404).json({ error: "certificat inconnu" }); return; }
      if (outcome === "children") {
        res.status(409).json({ error: "des certificats dérivés existent — supprimez (ou ré-émettez) d'abord la descendance de cet émetteur", code: "has_children" });
        return;
      }
      if (outcome === "force_required") {
        // 428 et NON 409 : le 409 signale déjà la descendance et le client lui associe un message
        // dédié — réutiliser le même statut afficherait « des dérivés existent », ce qui serait FAUX.
        res.status(428).json({
          error: "ce certificat est encore valide — rejouez la requête avec ?force=true pour confirmer la suppression",
          code: "force_required",
        });
        return;
      }
      // Certificat disparu → son alerte d'échéance n'a plus d'objet (resolve no-op si aucune).
      this.problems?.resolve(CertExpiryWatcher.keyFor(ctx.docId, id));
      res.json({ ok: true });
    });

    return { path: "/documents/:docId/certs", router };
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Query params reconnus du listing : leur présence bascule GET /certs du mode HISTORIQUE (page géante)
      vers le listing paginé (cf. route GET /). */
  private static readonly LIST_PARAMS = ["page", "pageSize", "query", "kind", "status", "root", "sort", "dir", "focus"];

  private static readonly LIST_STATUSES = ["active", "revoked", "expired", "expiring"];
  private static readonly LIST_SORTS = ["label", "kind", "not_after", "created_date", "parent"];
  /** La vue racines autorise en PLUS les tris d'agrégats. */
  private static readonly ROOT_SORTS = [...CertsModule.LIST_SORTS, "children_total", "next_expiry"];

  /** Lecture SOUPLE des query params de listing (cadrage §3/§4 — jamais de 400 : toute valeur inconnue est
      IGNORÉE et retombe sur le défaut). `rootsView` autorise les tris d'agrégats et ignore `root` (la vue
      racines n'a pas de sous-arbre). Le bornage fin (pageSize, page, tri stable) est fait par CertsDb. */
  private static parseListQuery(q: any, rootsView: boolean): CertsListOpts {
    const int = (v: unknown): number | undefined => { const n = parseInt(String(v), 10); return Number.isFinite(n) ? n : undefined; };
    const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
    const kindsRaw = q.kind === undefined ? [] : (Array.isArray(q.kind) ? q.kind : [q.kind]);
    const kinds = kindsRaw.map((k: unknown) => String(k)).filter((k: string) => (CERT_KINDS as readonly string[]).includes(k));
    const sorts = rootsView ? CertsModule.ROOT_SORTS : CertsModule.LIST_SORTS;
    return {
      page: int(q.page),
      pageSize: int(q.pageSize),
      query: str(q.query),
      kinds: kinds.length ? kinds : undefined,
      status: CertsModule.LIST_STATUSES.includes(String(q.status)) ? (q.status as CertsListOpts["status"]) : undefined,
      root: rootsView ? undefined : str(q.root),
      sort: sorts.includes(String(q.sort)) ? (q.sort as CertsListOpts["sort"]) : undefined,
      dir: (q.dir === "asc" || q.dir === "desc") ? q.dir : undefined,
      focus: str(q.focus),
    };
  }

  /** Garde commune des routes : document existant + module sain — sinon répond et renvoie null. */
  private context(req: express.Request, res: express.Response): { docId: string; db: CertsDb } | null {
    const docId = (req.params as any).docId as string;
    if (!this.docs.get(docId)) { res.status(404).json({ error: "document inconnu" }); return null; }
    if (!this.db) { res.status(503).json({ error: "module certificats en erreur", detail: this.configError }); return null; }
    return { docId, db: this.db };
  }
}
