/* =============================================================================
   CollectionFacetCache — les VALEURS D'UNE FACETTE de listing, relevées en
   ASYNCHRONE et servies en SYNCHRONE (garde G8 du chantier lazy-load, vague 3 —
   cf. docs/hydratation.md).

   POURQUOI : les options d'un filtre d'énumération sont SYNCHRONES par contrat
   (`ListColumn.filter.options(): FilterOption[]`, réévalué à chaque rendu, cf.
   `ListView._ensureToolbar`) — c'est la forme du rendu, pas un détail. Or, dès
   qu'une collection est chargée paresseusement, le balayage `store.all(c)` qui
   les produit ne voit que les pages déjà parcourues : la facette ne propose que
   les valeurs VUES. La vérité est un `SELECT DISTINCT` serveur, donc asynchrone.

   Ce cache réconcilie les deux, EXACTEMENT comme `CollectionCountCache` le fait
   pour les compteurs d'onglet (même patron, volontairement — deux mécaniques
   différentes pour le même problème auraient divergé) : il tient les dernières
   valeurs CONNUES (rendues IMMÉDIATEMENT, sans attente), déclenche AU PLUS UN
   relevé en vol par (collection, champ), et PRÉVIENT l'hôte à l'arrivée pour
   qu'il repeigne sa barre de filtres.

   ── LA RÈGLE QUI COMPTE : une valeur SÉLECTIONNÉE ne disparaît jamais ────────
   `ListView` PURGE de l'état de filtre toute valeur absente des options
   (« parité historique » : une organisation disparue ne doit pas laisser une
   chip fantôme). Servies en async, les options sont VIDES au premier rendu — la
   purge effacerait alors un filtre restauré depuis la session, en silence. D'où
   `withSelected` : les options rendues à la vue sont l'UNION des valeurs connues
   et des valeurs SÉLECTIONNÉES. La purge devient un no-op tant que le relevé
   n'est pas arrivé, et redevient exacte ensuite — sans que `ListView` n'ait à
   connaître le régime.

   Module PUR : le relevé est INJECTÉ (aucun réseau, aucun Store, aucun DOM ici).
   Un échec de relevé n'est PAS mis en cache et n'explose pas : un filtre est un
   confort, jamais une opération critique — les valeurs restent « inconnues » et
   seront retentées au prochain besoin.
   ============================================================================= */

export class CollectionFacetCache {
  /** Dernières valeurs CONNUES par clé `collection\nchamp` (absente = jamais relevée, ou invalidée). */
  private readonly known = new Map<string, string[]>();
  /** Relevés EN VOL, partagés : deux demandes rapprochées ne tirent qu'une requête. */
  private readonly inFlight = new Map<string, Promise<string[]>>();

  /** Clé de cache d'une facette. Le `\n` est impossible dans un nom de collection ou de champ (tous
      dérivés de la spec) : aucune collision de clés composées. */
  private static key(collection: string, field: string): string { return collection + "\n" + field; }

  /** Valeurs d'affichage NORMALISÉES : vides écartées, doublons fondus, ordre `Array.sort()` par
      défaut — la MÊME règle que les options locales d'un filtre (`[...new Set(…)].sort()`, cf.
      `ListConfigs`). Écrite ICI, une fois : c'est ce qui garantit qu'une facette servie par le serveur
      et la même facette calculée en local présentent leurs valeurs dans le MÊME ordre. */
  static normalize(values: readonly string[]): string[] {
    const set = new Set<string>();
    for (const value of values) { const v = String(value == null ? "" : value); if (v) set.add(v); }
    return [...set].sort();
  }

  /** Options à SERVIR à la vue : les valeurs connues UNION les valeurs SÉLECTIONNÉES (cf. l'en-tête —
      c'est ce qui empêche la purge de `ListView` d'effacer un filtre restauré avant l'arrivée du
      relevé). Normalisé comme le reste : une sélection vide ne crée pas d'option fantôme. */
  static withSelected(known: readonly string[], selected: Iterable<string>): string[] {
    return CollectionFacetCache.normalize([...known, ...selected]);
  }

  /** `load` : le relevé (injecté — en pratique `adapter.facetValues`, un `SELECT DISTINCT` serveur).
      `onResolved` : notifié quand des valeurs ARRIVENT (l'hôte repeint alors la barre de filtres du
      listing concerné) ; sans lui, elles entreraient au cache sans que rien ne les affiche avant le
      prochain rendu fortuit. */
  constructor(
    private readonly load: (collection: string, field: string) => Promise<string[]>,
    private readonly onResolved: ((collection: string, field: string, values: string[]) => void) | null = null,
  ) {}

  /** Valeurs connues, ou `null` si elles n'ont jamais été relevées (ou viennent d'être invalidées).
      LECTURE PURE : ne déclenche RIEN (à utiliser quand l'appelant ne veut surtout pas de réseau). */
  peek(collection: string, field: string): string[] | null {
    const values = this.known.get(CollectionFacetCache.key(collection, field));
    return values === undefined ? null : values;
  }

  /** Valeurs à AFFICHER MAINTENANT : les connues, sinon une liste VIDE — et, dans ce dernier cas,
      DEMANDE le relevé (au plus un en vol par facette). C'est l'accesseur des options de filtre :
      synchrone par contrat, exact dès que la réponse arrive (via `onResolved` → re-rendu). */
  values(collection: string, field: string): string[] {
    const values = this.known.get(CollectionFacetCache.key(collection, field));
    if (values !== undefined) return values;
    // Rejet AVALÉ ici (et non un `void` nu) : l'appelant est un RENDU synchrone, qui n'a rien à en
    // faire, et une promesse rejetée sans `catch` remonterait en « unhandled rejection » à chaque
    // panne réseau. L'échec n'est pas mémorisé (cf. `request`) : le prochain rendu retentera.
    void this.request(collection, field).catch(() => { /* facette indisponible : options vides, sans bruit */ });
    return [];
  }

  /** Relève les valeurs (mémoïsé) : la MÊME promesse est rendue à tous les demandeurs tant qu'elle est
      en vol, et le résultat reste en cache jusqu'à invalidation. Un échec ne met RIEN en cache — la
      prochaine demande retentera (une panne réseau ne doit pas figer un filtre vide pour la session). */
  request(collection: string, field: string): Promise<string[]> {
    const key = CollectionFacetCache.key(collection, field);
    const cached = this.known.get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const promise = this.load(collection, field).then((values) => {
      this.inFlight.delete(key);
      const normalized = CollectionFacetCache.normalize(values || []);
      // Une invalidation tombée PENDANT le vol rend cette réponse périmée… mais elle reste la meilleure
      // liste connue, et la prochaine invalidation explicite la chassera (même arbitrage que les compteurs).
      this.known.set(key, normalized);
      this.onResolved?.(collection, field, normalized);
      return normalized;
    }).catch((error) => {
      this.inFlight.delete(key);
      throw error;
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  /** Oublie les valeurs de TOUTES les facettes de ces collections (écriture locale — création,
      suppression ET modification, car une valeur de colonne a pu changer —, événement SSE SAUTÉ par
      G3, hydratation). Aucun relevé n'est déclenché ici : invalider n'est pas recharger. */
  invalidate(collections: readonly string[]): void {
    const targets = new Set(collections);
    for (const key of [...this.known.keys()]) {
      if (targets.has(key.slice(0, key.indexOf("\n")))) this.known.delete(key);
    }
  }

  /** Oublie TOUT (remplacement complet du cache : `_hydrate`, import, nouveau document). */
  invalidateAll(): void { this.known.clear(); }

  /** Nombre de relevés EN VOL — diagnostic et tests (la déduplication doit se PROUVER). */
  get pendingCount(): number { return this.inFlight.size; }
}
