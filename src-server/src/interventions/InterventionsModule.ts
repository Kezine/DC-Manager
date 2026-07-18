import express from "express";
import { type ApiExtension, RequestAuthor } from "../api.js";
import type { DocumentStore } from "../documents.js";
import type { SqliteCtor } from "../db.js";
import { Logger } from "../logger.js";
import { InterventionsDb, type InterventionsListOpts } from "./InterventionsDb.js";
import {
  InterventionsValidate, InterventionsConfigError,
  INTERVENTION_KINDS, INTERVENTION_STATUSES, INTERVENTION_PRIORITIES,
} from "./InterventionsValidate.js";
import { InterventionReminderWatcher, type InterventionProblemReporter } from "./InterventionReminderWatcher.js";

/* =============================================================================
   MODULE INTERVENTIONS (incidents & interventions liés aux équipements/VMs/spares)
   — façade d'assemblage et POINT DE BRANCHEMENT UNIQUE de la feature (amovible,
   pattern vm/, notify/ et certs/) : persistance interventions.db + routes REST +
   veilleur de rappels, livrés au bootstrap en ApiExtension.

   Suppression de la feature = retirer le câblage InterventionsModule d'index.ts et
   le dossier interventions/ — le cœur (api/db/documents/live) n'importe RIEN d'ici.

   Routes (montées sous la garde d'accès de l'API, SCOPÉES PAR DOCUMENT via
   mergeParams) — ⚠ /meta est déclarée AVANT /:id (sinon « meta » serait lu comme id) :
   - GET    /documents/:docId/interventions        → listing PAGINÉ ({ interventions, total, page, pages, pageSize })
   - GET    /documents/:docId/interventions/meta    → { jira_base_url } (variable d'env JIRA_BASE_URL)
   - GET    /documents/:docId/interventions/:id     → détail (404 sinon)
   - PUT    /documents/:docId/interventions/:id     → créer/mettre à jour (audit posé PAR LE SERVEUR)
   - DELETE /documents/:docId/interventions/:id     → suppression (cascade des liens, resolve du rappel)

   VEILLEUR DE RAPPELS : un timer de 5 MINUTES fait tourner InterventionReminderWatcher
   (raise/resolve `intervention-reminder`). Granularité fine ASSUMÉE : les paliers 1 h et
   « heure H » exigent plus fin que l'horaire des certs (une échéance certificat se mesure
   en jours ; un rappel d'intervention se joue à l'heure près). Une passe est aussi
   déclenchée après CHAQUE écriture. Le rapporteur est OPTIONNEL (sans lui, le module vit
   normalement, sans notifications).
   ============================================================================= */

/** Période du timer de rappels : 5 min (les paliers 1 h / heure H exigent plus fin que l'horaire des certs). */
const REMINDER_TICK_MS = 5 * 60 * 1000;

export class InterventionsModule {
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor(
    private readonly docs: DocumentStore,
    /** null = module en erreur (ouverture d'interventions.db impossible) → routes en 503 détaillé. */
    private readonly db: InterventionsDb | null,
    /** Veilleur de rappels — null si module en erreur OU aucun rapporteur branché. */
    private readonly watcher: InterventionReminderWatcher | null,
    /** Rapporteur de problèmes (pont notify du bootstrap) — resolve explicite aux écritures/suppressions. */
    private readonly problems: InterventionProblemReporter | null,
    private readonly configError: string | null,
    private readonly log: Logger,
  ) {}

  static create(opts: { docs: DocumentStore; dataDir: string; sqlite: SqliteCtor; log?: Logger; problems?: InterventionProblemReporter }): InterventionsModule {
    const log = opts.log || new Logger("error");
    try {
      const db = new InterventionsDb(opts.dataDir, opts.sqlite, log);
      const watcher = opts.problems ? new InterventionReminderWatcher(db, opts.problems, undefined, undefined, log) : null;
      log.info("module interventions prêt (interventions.db"
        + (watcher ? ", rappels actifs)" : ", rappels SANS rapporteur)"));
      return new InterventionsModule(opts.docs, db, watcher, opts.problems || null, null, log);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error("module interventions en erreur — démarré désactivé", message);
      return new InterventionsModule(opts.docs, null, null, opts.problems || null, message, log);
    }
  }

  /** Démarre le veilleur : une passe immédiate (état au boot) puis un tick de 5 min. */
  start(): void {
    if (!this.watcher) return;
    this.scanQuietly();
    this.timer = setInterval(() => this.scanQuietly(), REMINDER_TICK_MS);
    // `unref` : le timer ne retient pas l'arrêt du process (parité CertsModule/NotifyModule).
    (this.timer as any).unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.db?.close();
  }

  /** Passe de surveillance qui ne laisse JAMAIS échapper d'exception (un bug de balayage ne doit pas
      casser un tick d'horloge ni une réponse HTTP qui la déclenche). */
  private scanQuietly(): void {
    try {
      this.watcher?.scan();
    } catch (e) {
      this.log.error("interventions: passe de rappels en échec", e instanceof Error ? e.message : String(e));
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
      res.json(ctx.db.listPage(ctx.docId, InterventionsModule.parseListQuery(q)));
    });

    // /meta déclarée AVANT /:id (« meta » n'est pas un id). Sert au client à fabriquer le lien vers
    // un ticket depuis une clé Jira (jira_ref) — SANS aucun appel Jira côté serveur.
    router.get("/meta", (req, res) => {
      const ctx = this.context(req, res); if (!ctx) return;
      res.json({ jira_base_url: InterventionsValidate.jiraBaseUrl() });
    });

    // /counts déclarée AVANT /:id (« counts » n'est pas un id). Comptes d'interventions OUVERTES par cible
    // (badges de fiche équipement/VM/spare). `target` = paramètre RÉPÉTABLE « <kind>:<id> » ; validation
    // souple (cibles malformées ignorées, plafonnées par la couche DB).
    router.get("/counts", (req, res) => {
      const ctx = this.context(req, res); if (!ctx) return;
      const q: any = (req.query && typeof req.query === "object") ? req.query : {};
      const raw = q.target === undefined ? [] : (Array.isArray(q.target) ? q.target : [q.target]);
      const targets = raw.map((s: unknown) => InterventionsModule.parseTarget(s)).filter((t: any): t is { kind: string; id: string } => t !== null);
      res.json({ counts: ctx.db.countOpenForTargets(ctx.docId, targets) });
    });

    router.get("/:id", (req, res) => {
      const ctx = this.context(req, res); if (!ctx) return;
      const item = ctx.db.getOne(ctx.docId, (req.params as any).id);
      if (!item) { res.status(404).json({ error: "intervention inconnue" }); return; }
      res.json({ intervention: item });
    });

    router.put("/:id", (req, res) => {
      const ctx = this.context(req, res); if (!ctx) return;
      const id = (req.params as any).id as string;
      const body: any = (req.body && typeof req.body === "object") ? req.body : {};
      try {
        // L'AUDIT est posé PAR LE SERVEUR : l'ID CANONIQUE de l'auteur (RequestAuthor.identity — String(id)
        // SSO sinon login, résoluble a posteriori par l'annuaire) vient de la session authentifiée, jamais du
        // corps. Le client ne peut donc pas se faire passer pour un autre. Les valeurs LEGACY (noms en clair
        // écrits avant ce lot) restent en base et s'afficheront via le repli du client (lot 3).
        const intervention = ctx.db.save(ctx.docId, id, body, RequestAuthor.identity(req).id);
        // Un objet DÉMARRÉ/clos/annulé sort du périmètre de rappel → clôture EXPLICITE (vaut aussi pour
        // une alerte levée par un processus précédent, hors du jeu mémoire du veilleur). Puis une passe
        // reflète la création/modification sans attendre le tick de 5 min.
        if (intervention.status !== "declared" && intervention.status !== "planned") {
          this.problems?.resolve(InterventionReminderWatcher.keyFor(ctx.docId, id));
        }
        this.scanQuietly();
        res.json({ intervention });
      } catch (e) {
        if (e instanceof InterventionsConfigError) { res.status(400).json({ error: "données invalides", issues: e.issues }); return; }
        this.log.error("PUT /interventions/:id : échec", ctx.docId, id, e instanceof Error ? e.message : String(e));
        res.status(500).json({ error: "enregistrement de l'intervention en échec" });
      }
    });

    router.delete("/:id", (req, res) => {
      const ctx = this.context(req, res); if (!ctx) return;
      const id = (req.params as any).id as string;
      if (!ctx.db.remove(ctx.docId, id)) { res.status(404).json({ error: "intervention inconnue" }); return; }
      // Objet disparu → son rappel n'a plus d'objet (resolve no-op côté moteur si aucune alerte).
      this.problems?.resolve(InterventionReminderWatcher.keyFor(ctx.docId, id));
      res.json({ ok: true });
    });

    return { path: "/documents/:docId/interventions", router };
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Analyse une cible « <kind>:<id> » (séparateur = PREMIER « : » ; l'id peut en contenir d'autres). Renvoie
      null si malformée (ignorée par l'appelant — validation souple). */
  private static parseTarget(raw: unknown): { kind: string; id: string } | null {
    if (typeof raw !== "string") return null;
    const idx = raw.indexOf(":");
    if (idx <= 0) return null;
    const kind = raw.slice(0, idx).trim();
    const id = raw.slice(idx + 1).trim();
    return (kind === "" || id === "") ? null : { kind, id };
  }

  private static readonly LIST_SORTS = ["title", "status", "priority", "planned_start", "created_date", "updated_date"];

  /** Lecture SOUPLE des query params de listing (jamais de 400 : toute valeur inconnue est IGNORÉE et
      retombe sur le défaut). Le bornage fin (pageSize, page, tri stable) est fait par InterventionsDb. */
  private static parseListQuery(q: any): InterventionsListOpts {
    const int = (v: unknown): number | undefined => { const n = parseInt(String(v), 10); return Number.isFinite(n) ? n : undefined; };
    const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
    const enumList = (raw: unknown, allowed: readonly string[]): string[] | undefined => {
      const arr = raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]);
      const kept = arr.map((v: unknown) => String(v)).filter((v: string) => allowed.includes(v));
      return kept.length ? kept : undefined;
    };
    return {
      page: int(q.page),
      pageSize: int(q.pageSize),
      query: str(q.query),
      kinds: enumList(q.kind, INTERVENTION_KINDS),
      statuses: enumList(q.status, INTERVENTION_STATUSES),
      priorities: enumList(q.priority, INTERVENTION_PRIORITIES),
      sort: InterventionsModule.LIST_SORTS.includes(String(q.sort)) ? (q.sort as InterventionsListOpts["sort"]) : undefined,
      dir: (q.dir === "asc" || q.dir === "desc") ? q.dir : undefined,
    };
  }

  /** Garde commune des routes : document existant + module sain — sinon répond et renvoie null. */
  private context(req: express.Request, res: express.Response): { docId: string; db: InterventionsDb } | null {
    const docId = (req.params as any).docId as string;
    if (!this.docs.get(docId)) { res.status(404).json({ error: "document inconnu" }); return null; }
    if (!this.db) { res.status(503).json({ error: "module interventions en erreur", detail: this.configError }); return null; }
    return { docId, db: this.db };
  }
}
