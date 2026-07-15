import { Logger } from "../logger.js";

/* =============================================================================
   VEILLEUR D'ÉCHÉANCES DES CERTIFICATS — producteur `cert-expiry` du service
   de notifications (C7, cadrage certs §4). Balaye les MÉTADONNÉES (not_after —
   le serveur n'a jamais besoin des clés pour surveiller les échéances) et
   signale les certificats qui approchent de l'expiration.

   SEUILS GLOBAUX serveur (décision Q6, défaut 30/14/7 jours) → gravité
   CROISSANTE à mesure que l'échéance approche :
   - J ≤ 7 (ou déjà expiré) → error ;
   - J ≤ 14              → warning ;
   - J ≤ 30              → info ;
   - au-delà             → resolve (certificat renouvelé/ré-émis : l'alerte
     éventuelle se clôt — le moteur notify n'envoie le « rétabli » que si
     l'alerte était réellement partie).

   ANTI-SPAM : AUCUN comptage ici (pattern vm-sync-failure) — `raise` est
   idempotent par passe, les rappels (12 h par défaut, réglables par type)
   vivent ENTIÈREMENT dans le moteur notify. La gravité/le message sont
   rafraîchis à chaque passe (le prochain rappel porte le bon J-n).

   DISPARITIONS : un certificat supprimé/révoqué sort de `listExpiring()` —
   le veilleur mémorise les clés qu'il a levées et RESOLVE celles qui ont
   disparu de la passe courante (jeu en mémoire : après un redémarrage, les
   suppressions passées sont déjà résolues par CertsModule au moment de
   l'action — cf. routes DELETE/PUT — le jeu mémoire couvre le reste).

   Dépendance INVERSÉE (pattern VmSyncService.ProblemReporter) : l'interface
   du rapporteur est déclarée ICI, côté CONSOMMATEUR — certs/ n'importe RIEN
   de notify/, index.ts ponte par typage structurel. Les deux features restent
   amovibles indépendamment.
   ============================================================================= */

/** Ce que le veilleur exige du service de notifications (satisfait par NotifyModule
    via le pont du bootstrap — fire-and-forget, no-op si le module est inactif). */
export interface CertProblemReporter {
  raise(key: string, event: { event_type: string; severity: "info" | "warning" | "error"; title: string; body: string; doc_id?: string | null }): void;
  resolve(key: string): void;
}

/** Ce que le veilleur lit de la persistance (satisfait par CertsDb.listExpiring :
    certificats NON révoqués porteurs d'une échéance, tous documents). */
export interface CertExpirySource {
  listExpiring(): Array<{ doc_id: string; id: string; label: string; kind: string; not_after: string }>;
}

/** Bilan d'une passe (logs + tests). */
export interface CertExpiryScanResult {
  raised: number;
  resolved: number;
}

export class CertExpiryWatcher {
  /** Seuils GLOBAUX par défaut (jours avant échéance), du plus large au plus proche —
      décision Q6 : 30/14/7, non configurables par document en v1. */
  static readonly DEFAULT_THRESHOLDS_DAYS: readonly [number, number, number] = [30, 14, 7];

  /** Clés levées par CE processus — pour résoudre celles qui disparaissent du balayage
      (certificat supprimé/révoqué/date retirée entre deux passes). */
  private readonly raisedKeys = new Set<string>();

  constructor(
    private readonly source: CertExpirySource,
    private readonly reporter: CertProblemReporter,
    /** Horloge injectée (tests : contrôlée). */
    private readonly clock: () => Date = () => new Date(),
    /** Seuils [info, warning, error] en jours — injectables (tests), défaut Q6. */
    private readonly thresholdsDays: readonly [number, number, number] = CertExpiryWatcher.DEFAULT_THRESHOLDS_DAYS,
    private readonly log: Logger = new Logger("error"),
  ) {}

  /** Clé STABLE du problème d'échéance d'UN certificat (cadrage : cert-expiry:<docId>:<certId>). */
  static keyFor(docId: string, certId: string): string {
    return "cert-expiry:" + docId + ":" + certId;
  }

  /** Une passe de surveillance : raise/refresh les certificats sous seuil, resolve les
      autres (renouvelés, disparus). Synchrone (un SELECT + de l'arithmétique de dates) —
      le timer de CertsModule l'appelle périodiquement, les tests directement. */
  scan(): CertExpiryScanResult {
    const now = this.clock().getTime();
    const [infoDays, warningDays, errorDays] = this.thresholdsDays;
    const seen = new Set<string>();
    let raised = 0;
    let resolved = 0;

    for (const cert of this.source.listExpiring()) {
      const key = CertExpiryWatcher.keyFor(cert.doc_id, cert.id);
      seen.add(key);
      const msLeft = Date.parse(cert.not_after) - now;
      const daysLeft = Math.floor(msLeft / 86_400_000); // J-n entiers (J-0 = expire aujourd'hui)

      if (daysLeft > infoDays) {
        // Hors de tout seuil (ex. certificat RENOUVELÉ : not_after repoussée) → clôture.
        // resolve est no-op côté moteur si aucune alerte n'était ouverte — appel sans garde.
        this.reporter.resolve(key);
        this.raisedKeys.delete(key);
        resolved++;
        continue;
      }

      const expired = msLeft <= 0;
      const severity = (expired || daysLeft <= errorDays) ? "error" as const
        : daysLeft <= warningDays ? "warning" as const
        : "info" as const;
      const dateLabel = cert.not_after.slice(0, 10); // AAAA-MM-JJ lisible (l'heure n'apporte rien à J-30)
      this.reporter.raise(key, {
        event_type: "cert-expiry",
        severity,
        title: expired
          ? "Certificat expiré — " + cert.label
          : "Échéance certificat — " + cert.label + " (J-" + daysLeft + ")",
        body: expired
          ? "Le certificat « " + cert.label + " » (" + cert.kind + ") a expiré le " + dateLabel + " — à renouveler."
          : "Le certificat « " + cert.label + " » (" + cert.kind + ") expire le " + dateLabel + " (dans " + daysLeft + " jour(s)).",
        doc_id: cert.doc_id,
      });
      this.raisedKeys.add(key);
      raised++;
    }

    // Clés levées par ce processus qui ont DISPARU du balayage (supprimé/révoqué/date
    // retirée) : on les clôt — sinon le moteur rappellerait un problème sans objet.
    for (const key of [...this.raisedKeys]) {
      if (seen.has(key)) continue;
      this.reporter.resolve(key);
      this.raisedKeys.delete(key);
      resolved++;
    }

    if (raised > 0) this.log.info("certs: échéances signalées", raised + " certificat(s) sous seuil");
    return { raised, resolved };
  }
}
