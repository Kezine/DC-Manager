/* =============================================================================
   HydrationStats — INSTRUMENTATION du boot REST (volet A du cadrage
   `.notes/toDos/chargement-dynamique-document-cadrage-2026-08-02.md`, décision
   D1/D3 du 2026-08-02).

   POURQUOI : « actuellement on charge tout » est ACCEPTABLE tant que le document
   reste petit — mais cette affirmation doit être MESURÉE, pas supposée. À chaque
   hydratation complète (mode REST), on relève : les records par collection non
   vide, la taille approximative du corpus et la durée — et on COMPARE aux seuils
   D3 validés (payload > 5 Mo OU hydratation > 1 s) qui déclencheraient le
   chantier « hydratation partielle » (option C du cadrage, au frigo d'ici là).

   Classe PURE (aucun DOM, aucun réseau) : le calcul est testable headless, seule
   l'ÉMISSION du log vit chez l'appelant (`RestDocumentController.openDocument`).

   ⚠ Taille APPROXIMATIVE assumée : `JSON.stringify().length` compte des
   caractères, pas des octets UTF-8, et re-sérialise le cache hydraté plutôt que
   de mesurer les octets réellement transférés (compression HTTP, en-têtes…).
   Pour un JSON majoritairement ASCII l'écart est marginal, et c'est l'ORDRE DE
   GRANDEUR qui arme le seuil — pas une comptabilité réseau.
   ============================================================================= */

/** Relevé d'une hydratation complète. */
export interface HydrationReport {
  /** Records par collection NON VIDE (les vides n'apportent rien à la ligne de log). */
  counts: Record<string, number>;
  totalRecords: number;
  /** Taille approximative du corpus sérialisé (cf. l'avertissement d'en-tête). */
  approxBytes: number;
  durationMs: number;
  /** Seuils D3 du cadrage dépassés → l'appelant émet un `warn` explicite. */
  overPayload: boolean;
  overDuration: boolean;
}

export class HydrationStats {
  /** Seuils D3 VALIDÉS par le cadrage (décision utilisateur 2026-08-02) : au-delà, le chantier
      « hydratation partielle » (option C) sort du frigo. Ne pas les ajuster sans re-cadrage. */
  static readonly PAYLOAD_WARN_BYTES = 5 * 1024 * 1024;
  static readonly DURATION_WARN_MS = 1000;

  /** Mesure une hydratation : `data` = les collections hydratées (le `Store.data` — les entités y ont
      un `toJSON`, que `JSON.stringify` applique), `durationMs` = durée mesurée par l'appelant. */
  static measure(data: Record<string, readonly unknown[]>, durationMs: number): HydrationReport {
    const counts: Record<string, number> = {};
    let totalRecords = 0;
    let approxBytes = 0;
    for (const [collection, records] of Object.entries(data || {})) {
      if (!Array.isArray(records) || !records.length) continue;
      counts[collection] = records.length;
      totalRecords += records.length;
      try { approxBytes += JSON.stringify(records).length; } catch (_) { /* structure cyclique inattendue : la taille reste un ordre de grandeur */ }
    }
    return {
      counts, totalRecords, approxBytes, durationMs,
      overPayload: approxBytes > HydrationStats.PAYLOAD_WARN_BYTES,
      overDuration: durationMs > HydrationStats.DURATION_WARN_MS,
    };
  }

  /** Ligne de log lisible : « 246 records (equipments:57, cables:41, …) · ~143 Ko · 87 ms ».
      Log DÉVELOPPEUR (console), volontairement hors I18n — comme le reste des traces `Log`. */
  static line(report: HydrationReport): string {
    const detail = Object.entries(report.counts).map(([c, n]) => c + ":" + n).join(", ");
    return report.totalRecords + " records" + (detail ? " (" + detail + ")" : "")
      + " · ~" + HydrationStats.formatBytes(report.approxBytes)
      + " · " + Math.round(report.durationMs) + " ms";
  }

  /** Octets → texte compact (o / Ko / Mo — l'ordre de grandeur, cf. en-tête). */
  static formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " Mo";
    if (bytes >= 1024) return Math.round(bytes / 1024) + " Ko";
    return Math.max(0, Math.round(bytes)) + " o";
  }
}
