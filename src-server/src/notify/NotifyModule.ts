import express from "express";
import { RequestAuthor, type ApiExtension } from "../api.js";   // RequestAuthor : id canonique de l'auteur (audit)
import type { DocumentStore } from "../documents.js";
import type { SqliteCtor } from "../db.js";
import { Logger } from "../logger.js";
import { SecretBox } from "../SecretBox.js";
import { NotifyDb } from "./NotifyDb.js";
import { NotifyEngine } from "./NotifyEngine.js";
import { SubscriptionRouter, type ContactSource } from "./SubscriptionRouter.js";
import { NotifyConfigError } from "./NotifyValidate.js";
import { ConsoleNotifier } from "./ConsoleNotifier.js";
import { WebhookNotifier } from "./WebhookNotifier.js";
import type { NotificationMessage, NotificationTarget, Notifier, NotifySeverity } from "./Notifier.js";
import type { Records } from "../../../src-shared/DataValidation.js";   // forme dérivée de la spec (contacts) — cast de frontière du store générique

/* =============================================================================
   MODULE NOTIFICATIONS — façade d'assemblage et POINT DE BRANCHEMENT UNIQUE de
   la feature (amovible, pattern vm/) : moteur anti-spam + persistance
   (notify.db) + routage par abonnements + timer de rappels + routes REST,
   livrés au bootstrap sous forme d'ApiExtension.

   Suppression de la feature = retirer le câblage NotifyModule d'index.ts et le
   dossier notify/ — le cœur (api/db/documents/live) n'importe RIEN d'ici.

   CLÉ DE CHIFFREMENT (pattern VmModule) : le module exige `DCMANAGER_SECRETS_KEY`
   (SecretBox partagé — clé UNIQUE, sans repli depuis le 2026-07-20) pour chiffrer
   les jetons des webhooks. Clé ABSENTE → module DÉSACTIVÉ en bloc : routes en 503 explicite,
   pas de timer, raise/resolve no-op (les producteurs ne voient qu'une
   interface optionnelle — cf. S4). Uniformité assumée : même les canaux
   console sont indisponibles sans clé (un module, un prérequis, un message).

   Routes (montées sous la garde d'accès de l'API, chemin GLOBAL /notify —
   les instances de canaux ne sont pas scopées par document ; les abonnements
   et états portent un doc_id optionnel) :
   - GET    /notify/instances            → liste des canaux (SANS jeton)
   - PUT    /notify/instances/:id        → créer/mettre à jour (jeton en écriture seule)
   - DELETE /notify/instances/:id        → supprimer (cascade des abonnements)
   - GET    /notify/subscriptions[?docId]→ abonnements (tous, ou d'un document + globaux)
   - PUT    /notify/subscriptions/:id    → créer/mettre à jour un abonnement
   - DELETE /notify/subscriptions/:id    → supprimer
   - GET    /notify/states[?docId]       → alertes ACTIVES (états anti-spam)
   - GET    /notify/log[?limit&offset&docId] → historique paginé
   - GET    /notify/settings             → intervalles de rappel par type
   - PUT    /notify/settings             → régler un intervalle (event_type + secondes)
   - DELETE /notify/settings/:eventType  → revenir au défaut (12 h)
   - POST   /notify/test                 → remise d'essai (routée par abonnements,
                                           ou directe { instance_id, address })

   TIMER DE RAPPELS (pattern VmSyncService) : un tick périodique appelle
   `engine.runReminders()` — anti-chevauchement (un tick sauté si le précédent
   court toujours), `unref()` (ne retient pas l'arrêt du process), purge
   d'historique par ancienneté une fois par jour.

   INVARIANT : aucune réponse ne contient de jeton (clair ou chiffré) —
   `has_token` au plus (garanti par NotifyDb).
   ============================================================================= */

/** Période du tick de rappels : 60 s — assez fin pour des intervalles réglés à la minute,
    négligeable en coût (un SELECT sur les états actifs). */
const REMINDER_TICK_MS = 60 * 1000;

export class NotifyModule {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Anti-chevauchement du tick (une passe de rappels lente ne s'empile pas). */
  private tickRunning = false;
  /** Jour (AAAA-MM-JJ) de la dernière purge d'historique — une purge par jour suffit. */
  private lastPurgeDay = "";

  private constructor(
    /** null = module désactivé (clé absente) ou en erreur. */
    private readonly db: NotifyDb | null,
    private readonly engine: NotifyEngine | null,
    /** Routeur d'abonnements (partagé moteur / bouton test). null quand le module est inactif. */
    private readonly router: SubscriptionRouter | null,
    /** Message d'erreur d'ouverture (null = sain ou simple clé absente). */
    private readonly configError: string | null,
    private readonly keyMissing: boolean,
    private readonly log: Logger,
  ) {}

  static create(opts: { docs: DocumentStore; dataDir: string; sqlite: SqliteCtor; log?: Logger }): NotifyModule {
    const log = opts.log || new Logger("error");
    const box = SecretBox.fromEnv(process.env);
    if (!box) {
      log.info("module notifications INACTIF — clé " + SecretBox.ENV_VAR + " absente (routes en 503 explicite)");
      return new NotifyModule(null, null, null, null, true, log);
    }
    try {
      const db = new NotifyDb(opts.dataDir, opts.sqlite, box, log);
      // Contacts : lecture SOUPLE dans les documents (collection standard, cf. cadrage §2).
      // Tant que la collection n'existe pas (S5), getOne renvoie null → abonnements muets, sans erreur.
      const contacts: ContactSource = {
        documentIds: () => opts.docs.list().map((d) => d.id),
        contact: (docId, contactId) => {
          const repo = opts.docs.repo(docId);
          // Frontière : le store de documents est GÉNÉRIQUE (Rec brut) ; la FORME est garantie par DataValidation à
          // l'écriture → cast assumé vers le type dérivé de la spec (source unique du contrat), consommé typé côté routeur.
          return (repo ? repo.getOne("contacts", contactId) : null) as Records.Contact | null;
        },
      };
      const router = new SubscriptionRouter(db, contacts, log);
      const engine = new NotifyEngine({
        store: db,
        router: router.asRouter(),
        remindIntervalSec: (eventType) => db.remindIntervalSecFor(eventType),
        journal: (entry) => db.appendLog(entry),
      });
      db.purgeLog(); // purge d'ancienneté au démarrage (puis quotidienne, via le timer)
      log.info("module notifications prêt (notify.db, tick de rappels " + (REMINDER_TICK_MS / 1000) + " s)");
      return new NotifyModule(db, engine, router, null, false, log);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error("module notifications en erreur — démarré désactivé", message);
      return new NotifyModule(null, null, null, message, false, log);
    }
  }

  /* --------------------------------------------------------------------------
     Producteurs (S4+) : signalement de problèmes — no-op si module inactif
     -------------------------------------------------------------------------- */

  /** Signale un problème persistant (fire-and-forget : les producteurs n'attendent pas la
      remise — un échec d'envoi est géré par le moteur, jamais remonté au producteur). */
  raise(key: string, event: { event_type: string; severity: NotifySeverity; title: string; body: string; doc_id?: string | null }): void {
    void this.engine?.raise(key, event).catch((e) =>
      this.log.error("notify: raise en échec inattendu", key, e instanceof Error ? e.message : String(e)));
  }

  /** Clôt un problème (même contrat fire-and-forget). */
  resolve(key: string): void {
    void this.engine?.resolve(key).catch((e) =>
      this.log.error("notify: resolve en échec inattendu", key, e instanceof Error ? e.message : String(e)));
  }

  /* --------------------------------------------------------------------------
     Cycle de vie
     -------------------------------------------------------------------------- */

  /** Démarre le timer de rappels (no-op si module inactif). */
  start(): void {
    if (!this.engine) return;
    this.timer = setInterval(() => { void this.tick(); }, REMINDER_TICK_MS);
    // `unref` : le timer ne retient pas l'arrêt du process (parité VmSyncService).
    (this.timer as any).unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.db?.close();
  }

  /** Un tick : passe de rappels (anti-chevauchement) + purge quotidienne de l'historique. */
  private async tick(): Promise<void> {
    if (this.tickRunning || !this.engine || !this.db) return;
    this.tickRunning = true;
    try {
      const reminded = await this.engine.runReminders();
      if (reminded > 0) this.log.info("notify: rappels émis", reminded);
      const today = new Date().toISOString().slice(0, 10);
      if (today !== this.lastPurgeDay) {
        this.lastPurgeDay = today;
        this.db.purgeLog();
      }
    } catch (e) {
      this.log.error("notify: passe de rappels en échec", e instanceof Error ? e.message : String(e));
    } finally {
      this.tickRunning = false;
    }
  }

  /* --------------------------------------------------------------------------
     Routes REST
     -------------------------------------------------------------------------- */

  /** Extension API à passer au Server (montée après la garde d'accès du cœur). */
  extension(): ApiExtension {
    const router = express.Router();

    /* ---- Instances de canaux ---- */

    router.get("/instances", (_req, res) => {
      const db = this.backend(res); if (!db) return;
      res.json({ instances: db.listInstances() });
    });

    router.put("/instances/:id", (req, res) => {
      const db = this.backend(res); if (!db) return;
      const body: any = (req.body && typeof req.body === "object") ? req.body : {};
      // Le jeton transite dans le corps UNIQUEMENT en écriture ; vide/absent = CONSERVER l'existant.
      const tokenPlain = typeof body.token === "string" && body.token.trim() !== "" ? (body.token as string) : null;
      const candidate = { ...body };
      delete candidate.token;
      try {
        // AUDIT posé PAR LE SERVEUR : id canonique de l'auteur (jamais le corps).
        res.json({ instance: db.saveInstance(candidate, (req.params as any).id, tokenPlain, RequestAuthor.identity(req).id) }); // réponse SANS jeton
      } catch (e) {
        if (e instanceof NotifyConfigError) { res.status(400).json({ error: "configuration invalide", issues: e.issues }); return; }
        this.log.error("PUT /notify/instances : échec", (req.params as any).id, e instanceof Error ? e.message : String(e));
        res.status(500).json({ error: "enregistrement du canal en échec" });
      }
    });

    router.delete("/instances/:id", (req, res) => {
      const db = this.backend(res); if (!db) return;
      if (!db.removeInstance((req.params as any).id)) { res.status(404).json({ error: "canal inconnu" }); return; }
      res.json({ ok: true });
    });

    /* ---- Abonnements ---- */

    router.get("/subscriptions", (req, res) => {
      const db = this.backend(res); if (!db) return;
      const docId = typeof req.query.docId === "string" && req.query.docId !== "" ? req.query.docId : undefined;
      res.json({ subscriptions: db.listSubscriptions(docId) });
    });

    router.put("/subscriptions/:id", (req, res) => {
      const db = this.backend(res); if (!db) return;
      const body: any = (req.body && typeof req.body === "object") ? req.body : {};
      try {
        // AUDIT posé PAR LE SERVEUR : id canonique de l'auteur (jamais le corps).
        res.json({ subscription: db.saveSubscription(body, (req.params as any).id, RequestAuthor.identity(req).id) });
      } catch (e) {
        if (e instanceof NotifyConfigError) { res.status(400).json({ error: "configuration invalide", issues: e.issues }); return; }
        if (e instanceof Error && /FOREIGN KEY/i.test(e.message)) {
          // FK notifier_id : l'instance référencée n'existe pas (ou plus) — erreur de saisie, pas un bug.
          res.status(400).json({ error: "configuration invalide", issues: ["notifier_id : instance de canal inconnue"] });
          return;
        }
        this.log.error("PUT /notify/subscriptions : échec", (req.params as any).id, e instanceof Error ? e.message : String(e));
        res.status(500).json({ error: "enregistrement de l'abonnement en échec" });
      }
    });

    router.delete("/subscriptions/:id", (req, res) => {
      const db = this.backend(res); if (!db) return;
      if (!db.removeSubscription((req.params as any).id)) { res.status(404).json({ error: "abonnement inconnu" }); return; }
      res.json({ ok: true });
    });

    /* ---- États actifs + historique ---- */

    router.get("/states", (req, res) => {
      const db = this.backend(res); if (!db) return;
      const docId = typeof req.query.docId === "string" && req.query.docId !== "" ? req.query.docId : undefined;
      const states = db.listActive().filter((s) => docId === undefined || s.doc_id === docId);
      res.json({ states });
    });

    router.get("/log", (req, res) => {
      const db = this.backend(res); if (!db) return;
      res.json(db.listLog({
        limit: req.query.limit !== undefined ? parseInt(String(req.query.limit), 10) || undefined : undefined,
        offset: req.query.offset !== undefined ? parseInt(String(req.query.offset), 10) || 0 : undefined,
        docId: typeof req.query.docId === "string" && req.query.docId !== "" ? req.query.docId : undefined,
      }));
    });

    /* ---- Réglages (intervalle de rappel par type — décision Q2) ---- */

    router.get("/settings", (_req, res) => {
      const db = this.backend(res); if (!db) return;
      res.json({ settings: db.listEventSettings() });
    });

    router.put("/settings", (req, res) => {
      const db = this.backend(res); if (!db) return;
      const body: any = (req.body && typeof req.body === "object") ? req.body : {};
      try {
        res.json({ setting: db.saveEventSetting(body) });
      } catch (e) {
        if (e instanceof NotifyConfigError) { res.status(400).json({ error: "configuration invalide", issues: e.issues }); return; }
        this.log.error("PUT /notify/settings : échec", e instanceof Error ? e.message : String(e));
        res.status(500).json({ error: "enregistrement du réglage en échec" });
      }
    });

    router.delete("/settings/:eventType", (req, res) => {
      const db = this.backend(res); if (!db) return;
      if (!db.removeEventSetting((req.params as any).eventType)) { res.status(404).json({ error: "réglage inconnu" }); return; }
      res.json({ ok: true });
    });

    /* ---- Test (bouton de la page admin — producteur « test » du cadrage) ---- */

    router.post("/test", (req, res) => {
      const db = this.backend(res); if (!db) return;
      const body: any = (req.body && typeof req.body === "object") ? req.body : {};
      const docId = typeof body.doc_id === "string" && body.doc_id !== "" ? (body.doc_id as string) : null;
      const message = (target: NotificationTarget): NotificationMessage => ({
        event_type: "test",
        severity: "info",
        title: "Test de notification DC Manager",
        body: "Remise d'essai déclenchée depuis la page d'administration (" + new Date().toISOString() + ").",
        doc_id: docId,
        target,
      });

      // Mode DIRECT : tester UNE instance vers UNE adresse saisie (sans abonnement préalable).
      if (typeof body.instance_id === "string" && body.instance_id !== "") {
        const address = typeof body.address === "string" ? body.address.trim() : "";
        if (address === "") { res.status(400).json({ error: "configuration invalide", issues: ["address : requise pour tester une instance"] }); return; }
        let instance;
        try {
          instance = db.instanceForSend(body.instance_id);
        } catch {
          res.status(409).json({ error: "jeton indéchiffrable (clé " + SecretBox.ENV_VAR + " changée ?) — ressaisir le jeton du canal" });
          return;
        }
        if (!instance) { res.status(404).json({ error: "canal inconnu ou désactivé" }); return; }
        let notifier: Notifier;
        try {
          notifier = NotifyModule.notifierFor(instance);
        } catch (e) {
          res.status(400).json({ error: e instanceof Error ? e.message : String(e) }); return;
        }
        notifier.send(message({ contact_id: "", address, channel: body.channel === "sms" ? "sms" : "email" }))
          .then(() => res.json({ results: [{ notifier_id: instance.id, address, ok: true, detail: null }] }))
          .catch((e) => res.json({ results: [{ notifier_id: instance.id, address, ok: false, detail: e instanceof Error ? e.message : String(e) }] }));
        return;
      }

      // Mode ROUTÉ : dérouler les abonnements du type « test » (vérifie la chaîne complète
      // abonnement → contact → adresse → canal), HORS moteur anti-spam (résultat immédiat).
      const recipients = this.router ? this.router.route("test", docId) : [];
      if (recipients.length === 0) {
        res.json({ results: [], hint: "aucun destinataire routé — créer un abonnement event_type « test » (ou « * ») avec un contact et un canal" });
        return;
      }
      void (async () => {
        const results = [];
        for (const recipient of recipients) {
          try {
            await recipient.notifier.send(message(recipient.target));
            results.push({ notifier_id: recipient.notifier_id, address: recipient.target.address, ok: true, detail: null });
          } catch (e) {
            results.push({ notifier_id: recipient.notifier_id, address: recipient.target.address, ok: false, detail: e instanceof Error ? e.message : String(e) });
          }
        }
        res.json({ results });
      })();
    });

    return { path: "/notify", router };
  }

  /* --------------------------------------------------------------------------
     Helpers privés
     -------------------------------------------------------------------------- */

  /** Renvoie la base OU répond 503 et renvoie null (pattern VmModule.crudBackend). */
  private backend(res: express.Response): NotifyDb | null {
    if (this.db) return this.db;
    if (this.keyMissing) {
      res.status(503).json({
        error: "notifications désactivées",
        detail: "définir " + SecretBox.ENV_VAR + " (passphrase de chiffrement des secrets) pour activer le service de notifications",
      });
      return null;
    }
    res.status(503).json({ error: "module notifications en erreur", detail: this.configError });
    return null;
  }

  /** Notifier concret d'une instance déjà déchiffrée (mode test direct) — mêmes fabriques
      que le SubscriptionRouter. */
  private static notifierFor(instance: { id: string; kind: string; url: string | null; token: string | null; simple: boolean; simple_max_chars: number; html: boolean }): Notifier {
    if (instance.kind === "console") return new ConsoleNotifier();
    if (instance.kind === "webhook" && instance.url) return new WebhookNotifier(instance.url, instance.token, undefined, WebhookNotifier.optionsFrom(instance));
    throw new Error("kind d'instance non testable : « " + instance.kind + " »");
  }
}
