import type { SqliteCtor } from "../db.js";
import { Logger } from "../logger.js";
import { LifecycleDb } from "./LifecycleDb.js";
import { WarrantyExpiryWatcher, type LifecycleProblemReporter, type WarrantySource } from "./WarrantyExpiryWatcher.js";

/* =============================================================================
   MODULE CYCLE DE VIE MATÉRIEL — façade d'assemblage et POINT DE BRANCHEMENT
   UNIQUE de la feature (amovible, pattern vm//notify//certs/) : veilleur de
   GARANTIES (WarrantyExpiryWatcher) + marqueur persistant « document déjà
   balayé » (lifecycle.db) + timer quotidien. Cf. docs/lifecycle.md.

   Suppression de la feature = retirer le câblage LifecycleModule d'index.ts et
   le dossier lifecycle/ — le cœur (api/db/documents/live) n'importe RIEN d'ici.

   AUCUNE route REST : le module ne produit que des alertes — elles s'affichent
   dans la page « Notifications » existante (états actifs + historique du module
   notify/), les abonnements s'y créent par type d'événement. Pas d'extension()
   donc, contrairement aux autres modules.

   DÉPENDANCES PAR INJECTION (aucun import du cœur au-delà des types du driver) :
   - `source` (WarrantySource) — le pont d'index.ts la remplit sur DocumentStore
     (lister les documents, lire equipments/subEquipments) ;
   - `problems` (LifecycleProblemReporter) — le pont vers NotifyModule (typage
     structurel, no-op si notify est inactif faute de clé).

   TICK QUOTIDIEN + passe au boot — DIVERGENCE ASSUMÉE avec cert-expiry
   (horaire) : `warranty_end` est une date à granularité JOUR, un tick horaire ne
   peut rien détecter de plus dans l'intervalle (l'état ne change qu'au passage
   de minuit UTC) ; le quotidien suffit et divise d'autant les ouvertures de
   dépôts. La passe au boot rattrape ce qui a expiré serveur éteint.
   ============================================================================= */

/** Période du tick de surveillance : 24 h (échéances à granularité JOUR — cf. en-tête). */
export const SCAN_INTERVAL_MS = 24 * 3600 * 1000;

export class LifecycleModule {
  private timer: ReturnType<typeof setInterval> | null = null;

  private constructor(
    /** null = module en erreur (ouverture de lifecycle.db impossible) → veilleur inactif, loggé. */
    private readonly db: LifecycleDb | null,
    private readonly watcher: WarrantyExpiryWatcher | null,
    private readonly log: Logger,
  ) {}

  static create(opts: { dataDir: string; sqlite: SqliteCtor; source: WarrantySource; problems: LifecycleProblemReporter; log?: Logger }): LifecycleModule {
    const log = opts.log || new Logger("error");
    try {
      const db = new LifecycleDb(opts.dataDir, opts.sqlite, log);
      // La MÊME base satisfait structurellement les DEUX contrats d'état du veilleur :
      // SweptState (anti-bruit du 1er balayage) et RaisedState (différentiel persistant).
      const watcher = new WarrantyExpiryWatcher(opts.source, opts.problems, db, db, undefined, log);
      log.info("module cycle de vie prêt (lifecycle.db — veilleur de garanties, passe au boot + tick quotidien)");
      return new LifecycleModule(db, watcher, log);
    } catch (e) {
      // Une base illisible ne fait pas tomber le serveur (philosophie VmModule/NotifyModule) :
      // le module démarre DÉSACTIVÉ, l'erreur est visible opérateur dans les logs.
      log.error("module cycle de vie en erreur — démarré désactivé", e instanceof Error ? e.message : String(e));
      return new LifecycleModule(null, null, log);
    }
  }

  /** Démarre la surveillance : une passe immédiate (état du parc au boot — c'est elle qui
      silencie le premier balayage d'un document jamais vu) puis un tick QUOTIDIEN. */
  start(): void {
    if (!this.watcher) return;
    this.scanQuietly();
    this.timer = setInterval(() => this.scanQuietly(), SCAN_INTERVAL_MS);
    // `unref` : le timer ne retient pas l'arrêt du process (parité VmSyncService/CertsModule).
    (this.timer as any).unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.db?.close();
  }

  /** Passe de surveillance qui ne laisse JAMAIS échapper d'exception (un document illisible ou
      une migration legacy en échec ne doit pas casser le tick d'horloge — parité CertsModule). */
  private scanQuietly(): void {
    try {
      this.watcher?.scan();
    } catch (e) {
      this.log.error("lifecycle: passe de garanties en échec", e instanceof Error ? e.message : String(e));
    }
  }
}
