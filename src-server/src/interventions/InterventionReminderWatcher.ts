import { Logger } from "../logger.js";

/* =============================================================================
   VEILLEUR DE RAPPELS D'INTERVENTIONS — producteur `intervention-reminder` du
   service de notifications (pattern CertExpiryWatcher). Balaye les fenêtres
   PLANIFIÉES (planned_start) des objets pas encore démarrés et rappelle leur
   échéance de démarrage avec une gravité CROISSANTE à l'approche de l'heure H.

   PÉRIMÈTRE : objets avec `planned_start` non nul ET status ∈ {declared, planned}
   (fournis par InterventionsDb.listReminderCandidates). Dès qu'un objet passe
   'in_progress'/'closed'/'cancelled' (ou perd son planned_start), il SORT de la
   source → le veilleur clôt (`resolve`) son rappel.

   PALIERS FIXES (non configurables en v1) — référencés à `planned_start` :
   - maintenant ≥ planned_start          → error  (« devait commencer »)
   - maintenant ≥ planned_start − 1 h     → warning
   - maintenant ≥ planned_start − 24 h    → info
   - en deçà (> 24 h avant)              → RIEN (resolve si un rappel traînait)
   Fenêtre DÉPASSÉE (planned_end passé) et toujours pas commencée : couverte par le
   palier error (maintenant ≥ planned_start l'implique) → error MAINTENU, jamais clos.

   ANTI-SPAM : AUCUN comptage ici (pattern cert-expiry) — `raise` est idempotent par
   passe, les rappels répétés (12 h par défaut, réglables par type) vivent ENTIÈREMENT
   dans le moteur notify. La gravité/le message sont rafraîchis à chaque passe.

   Dépendance INVERSÉE (pattern CertExpiryWatcher) : l'interface du rapporteur est
   déclarée ICI, côté CONSOMMATEUR — interventions/ n'importe RIEN de notify/, index.ts
   ponte par typage structurel. Les deux features restent amovibles indépendamment.
   ============================================================================= */

/** Ce que le veilleur exige du service de notifications (satisfait par NotifyModule via le
    pont du bootstrap — fire-and-forget, no-op si le module est inactif). */
export interface InterventionProblemReporter {
  raise(key: string, event: { event_type: string; severity: "info" | "warning" | "error"; title: string; body: string; doc_id?: string | null }): void;
  resolve(key: string): void;
}

/** Ce que le veilleur lit de la persistance (satisfait par InterventionsDb.listReminderCandidates). */
export interface InterventionReminderSource {
  listReminderCandidates(): Array<{ doc_id: string; id: string; title: string; kind: string; status: string; planned_start: string; planned_end: string | null }>;
}

/** Seuils (ms AVANT planned_start) déclenchant chaque gravité — injectables (tests). */
export interface InterventionReminderThresholds {
  /** ≤ ce délai avant le début → info (défaut 24 h). */
  info: number;
  /** ≤ ce délai avant le début → warning (défaut 1 h). */
  warning: number;
}

/** Bilan d'une passe (logs + tests). */
export interface InterventionReminderScanResult {
  raised: number;
  resolved: number;
}

export class InterventionReminderWatcher {
  /** Paliers PAR DÉFAUT (décision de cadrage, non configurables en v1) : info à −24 h, warning à −1 h. */
  static readonly DEFAULT_THRESHOLDS: InterventionReminderThresholds = { info: 24 * 3600 * 1000, warning: 3600 * 1000 };

  /** Clés levées par CE processus — pour résoudre celles qui disparaissent du balayage
      (objet démarré/clos/annulé, planned_start retiré, échéance repoussée hors seuil). */
  private readonly raisedKeys = new Set<string>();

  constructor(
    private readonly source: InterventionReminderSource,
    private readonly reporter: InterventionProblemReporter,
    /** Horloge injectée (tests : contrôlée). */
    private readonly clock: () => Date = () => new Date(),
    /** Seuils injectables (tests), défaut 24 h / 1 h. */
    private readonly thresholds: InterventionReminderThresholds = InterventionReminderWatcher.DEFAULT_THRESHOLDS,
    private readonly log: Logger = new Logger("error"),
  ) {}

  /** Clé STABLE du rappel d'UN objet (cadrage : intervention-reminder:<docId>:<id>). */
  static keyFor(docId: string, id: string): string {
    return "intervention-reminder:" + docId + ":" + id;
  }

  /** Une passe de surveillance : raise/refresh les objets dans un palier, resolve les autres
      (hors seuil, démarrés, disparus). Synchrone (un SELECT + de l'arithmétique de dates). */
  scan(): InterventionReminderScanResult {
    const now = this.clock().getTime();
    const seen = new Set<string>();
    let raised = 0;
    let resolved = 0;

    for (const item of this.source.listReminderCandidates()) {
      const key = InterventionReminderWatcher.keyFor(item.doc_id, item.id);
      seen.add(key);
      const startMs = Date.parse(item.planned_start);
      if (Number.isNaN(startMs)) {
        // planned_start illisible (ne devrait pas arriver — validé à l'écriture) : on clôt par prudence.
        this.reporter.resolve(key);
        this.raisedKeys.delete(key);
        resolved++;
        continue;
      }
      const msUntilStart = startMs - now;

      // Hors de tout palier (démarrage à > 24 h) → rien à signaler ; on clôt un éventuel rappel résiduel.
      if (msUntilStart > this.thresholds.info) {
        this.reporter.resolve(key);
        this.raisedKeys.delete(key);
        resolved++;
        continue;
      }

      const severity = msUntilStart <= 0 ? "error" as const
        : msUntilStart <= this.thresholds.warning ? "warning" as const
        : "info" as const;
      this.reporter.raise(key, InterventionReminderWatcher.event(item, severity));
      this.raisedKeys.add(key);
      raised++;
    }

    // Clés levées par ce processus qui ont DISPARU du balayage (démarré/clos/annulé/planned_start
    // retiré entre deux passes) : on les clôt — sinon le moteur rappellerait un problème sans objet.
    for (const key of [...this.raisedKeys]) {
      if (seen.has(key)) continue;
      this.reporter.resolve(key);
      this.raisedKeys.delete(key);
      resolved++;
    }

    if (raised > 0) this.log.info("interventions: rappels signalés", raised + " objet(s) sous seuil");
    return { raised, resolved };
  }

  /** Construit l'événement notify (titre + fenêtre) pour une gravité donnée. Le kind (slug) est cité
      tel quel — les libellés français/anglais viennent du client (i18n). */
  private static event(
    item: { doc_id: string; id: string; title: string; kind: string; planned_start: string; planned_end: string | null },
    severity: "info" | "warning" | "error",
  ): { event_type: string; severity: "info" | "warning" | "error"; title: string; body: string; doc_id: string } {
    const start = InterventionReminderWatcher.fmt(item.planned_start);
    const windowSuffix = item.planned_end ? " (fin prévue le " + InterventionReminderWatcher.fmt(item.planned_end) + ")" : "";
    let title: string;
    let body: string;
    if (severity === "error") {
      title = "Intervention à démarrer — " + item.title;
      body = "L'intervention « " + item.title + " » (" + item.kind + ") devait commencer le " + start + windowSuffix + " — elle n'a pas encore démarré.";
    } else if (severity === "warning") {
      title = "Intervention imminente — " + item.title;
      body = "L'intervention « " + item.title + " » (" + item.kind + ") doit commencer le " + start + windowSuffix + " (dans moins d'une heure).";
    } else {
      title = "Intervention planifiée — " + item.title;
      body = "L'intervention « " + item.title + " » (" + item.kind + ") est planifiée le " + start + windowSuffix + ".";
    }
    return { event_type: "intervention-reminder", severity, title, body, doc_id: item.doc_id };
  }

  /** ISO 8601 → « AAAA-MM-JJ HH:MM » lisible (l'heure compte ici, contrairement aux échéances certs). */
  private static fmt(iso: string): string {
    return iso.slice(0, 16).replace("T", " ");
  }
}
