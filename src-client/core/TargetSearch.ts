/* =============================================================================
   TargetSearch — sélection PURE des cibles liables d'une intervention
   (équipements + VMs + spares CONFONDUS), pour l'éditeur de liens unifié.

   POURQUOI un module dédié (principes n°2/n°7) : la PERTINENCE (préfixe avant
   simple inclusion), le PLAFOND de résultats et la DÉDUP des cibles déjà liées
   forment une logique testable headless, indépendante du Store (qui fournit les
   items) ET de la vue (qui fournit la requête et les exclusions). La
   NORMALISATION est INJECTÉE (paramètre) : le cœur passe `Schema.normSearch`
   (insensibilité casse/accents, partagée front ⇄ serveur), si bien que ce module
   n'importe RIEN de spécifique et reste auto-suffisant/réutilisable.
   ============================================================================= */

/** Un candidat liable : famille ("equipment"|"vm"|"spare"), identifiant, libellé lisible. */
export interface TargetSearchItem {
  kind: string;
  id: string;
  label: string;
}

/** Options du classement (tout injecté — le module ignore d'où viennent items/normalisation). */
export interface TargetSearchOptions {
  /** Normalisation appliquée à LA REQUÊTE ET AUX LIBELLÉS (ex. `Schema.normSearch`). */
  normalize: (value: unknown) => string;
  /** Nombre maximal de résultats renvoyés — défaut 12. */
  limit?: number;
  /** Clés « kind:id » des cibles DÉJÀ liées, à écarter des résultats (dédup silencieuse). */
  excluded?: ReadonlySet<string>;
}

export class TargetSearch {
  /** Clé d'identité d'une cible (couple famille+id) — MÊME convention que les liens d'intervention
      (« <kind>:<id> ») : c'est elle que la vue met dans `excluded` pour la dédup. */
  static key(kind: string, id: string): string { return kind + ":" + id; }

  /** Filtre, classe et borne les candidats pour une requête :
      - requête vide (après normalisation) → AUCUN résultat (on n'inonde pas le popover au focus) ;
      - un item est retenu si son libellé NORMALISÉ CONTIENT la requête normalisée ;
      - les cibles DÉJÀ liées (`excluded`) sont écartées AVANT le plafond (dédup) ;
      - PERTINENCE : les correspondances en PRÉFIXE (indexOf === 0) passent AVANT les simples
        inclusions ; à pertinence égale, tri alphabétique du libellé normalisé (ordre stable et
        déterministe, indépendant de l'ordre d'entrée) ;
      - le résultat est plafonné à `limit`. */
  static rank(items: readonly TargetSearchItem[], query: string, opts: TargetSearchOptions): TargetSearchItem[] {
    const normalize = opts.normalize;
    const needle = normalize(query);
    if (needle === "") return [];
    const limit = opts.limit != null ? opts.limit : 12;
    const excluded = opts.excluded;
    // Deux paniers pour matérialiser « préfixe d'abord » sans comparateur composite fragile.
    const prefix: Array<{ item: TargetSearchItem; norm: string }> = [];
    const contains: Array<{ item: TargetSearchItem; norm: string }> = [];
    for (const item of items) {
      if (excluded && excluded.has(TargetSearch.key(item.kind, item.id))) continue;
      const norm = normalize(item.label);
      const at = norm.indexOf(needle);
      if (at < 0) continue;
      (at === 0 ? prefix : contains).push({ item, norm });
    }
    const byLabel = (a: { norm: string }, b: { norm: string }): number => (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0);
    prefix.sort(byLabel);
    contains.sort(byLabel);
    return prefix.concat(contains).slice(0, Math.max(0, limit)).map((entry) => entry.item);
  }
}
