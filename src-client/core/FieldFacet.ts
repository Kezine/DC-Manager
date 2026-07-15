import { Schema } from "../../src-shared/Schema";

export interface FacetOptions {
  /** Saisie courante (filtre sous-chaîne, accents/casse ignorés). Vide = toutes les valeurs. */
  query?: string;
  /** CONTEXTE (recherche facettée) : { champ: valeur } — ne considère que les enregistrements dont ces champs
      correspondent (ex. proposer les Modèles de la Marque déjà saisie). Valeur vide = facette ignorée. */
  context?: Record<string, string>;
  /** Nombre MAX de suggestions renvoyées (borné à MAX_RESULTS_ABS). Défaut : MAX_RESULTS_DEFAULT. */
  limit?: number;
  /** Id de l'enregistrement en cours d'édition — exclu du calcul (n'auto-suggère pas sa propre valeur). */
  excludeId?: string | null;
}

/* =============================================================================
   FIELD FACET — valeurs DISTINCTES d'un champ texte, proposées en autocomplétion.
   Pur (aucun DOM, aucun réseau) → testable en isolation. Calculé sur les
   enregistrements DÉJÀ chargés côté client (le front hydrate le document complet,
   fichier comme API), donc pas d'appel serveur.

   « Recherche FACETTÉE dans leur contexte » : les suggestions d'un champ peuvent
   être restreintes par d'autres champs déjà renseignés (ex. Modèle filtré par la
   Marque courante), via `opts.context`.

   Plafonds : `limit` (défaut 10, RÉGLABLE dans l'app) borné par MAX_RESULTS_ABS
   (100) — plafond absolu aligné sur la limite serveur.
   ============================================================================= */
export class FieldFacet {
  /** Nb de suggestions par défaut (réglable — cf. Prefs.autocompleteMaxResults). */
  static readonly MAX_RESULTS_DEFAULT = 10;
  /** Plafond ABSOLU (« 100 côté serveur ») — aucune configuration ne le dépasse. */
  static readonly MAX_RESULTS_ABS = 100;
  /** Options proposées dans les réglages. */
  static readonly MAX_RESULTS_OPTIONS = [5, 10, 20, 50, 100];

  /** Borne une limite demandée dans [1, MAX_RESULTS_ABS]. */
  static clampLimit(n: unknown): number {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v) || v < 1) return FieldFacet.MAX_RESULTS_DEFAULT;
    return Math.min(v, FieldFacet.MAX_RESULTS_ABS);
  }

  /** Valeurs distinctes de `field`, filtrées par saisie + contexte, triées (préfixe, fréquence, alpha), plafonnées. */
  static suggest(records: Array<Record<string, any>>, field: string, opts: FacetOptions = {}): string[] {
    const q = Schema.normSearch((opts.query || "").trim());
    const limit = FieldFacet.clampLimit(opts.limit ?? FieldFacet.MAX_RESULTS_DEFAULT);
    const ctx = Object.entries(opts.context || {})
      .map(([f, v]) => [f, Schema.normSearch(String(v || "").trim())] as const)
      .filter(([, v]) => v !== "");   // facette vide = ignorée

    // Agrège par valeur normalisée : garde la casse la PLUS fréquente comme représentante.
    const agg = new Map<string, { count: number; forms: Map<string, number> }>();
    for (const rec of records) {
      if (opts.excludeId && rec.id === opts.excludeId) continue;
      if (ctx.some(([f, v]) => Schema.normSearch(rec[f]) !== v)) continue;   // hors contexte facetté
      const raw = rec[field];
      const label = (raw == null ? "" : String(raw)).trim();
      if (!label) continue;
      const key = Schema.normSearch(label);
      if (q && !key.includes(q)) continue;   // filtre par la saisie
      let a = agg.get(key); if (!a) { a = { count: 0, forms: new Map() }; agg.set(key, a); }
      a.count++; a.forms.set(label, (a.forms.get(label) || 0) + 1);
    }

    const rows = [...agg.entries()].map(([key, a]) => {
      let best = "", bestN = -1;
      a.forms.forEach((n, form) => { if (n > bestN) { bestN = n; best = form; } });
      return { key, label: best, count: a.count, prefix: q ? (key.startsWith(q) ? 0 : 1) : 0 };
    });
    rows.sort((x, y) => x.prefix - y.prefix || y.count - x.count || x.label.localeCompare(y.label));
    return rows.slice(0, limit).map((r) => r.label);
  }
}
