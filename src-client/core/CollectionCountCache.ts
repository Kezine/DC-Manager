/* =============================================================================
   CollectionCountCache — un COMPTE de collection à valeur ASYNCHRONE, servi en
   SYNCHRONE (garde G6 du chantier lazy-load, cf. docs/hydratation.md).

   POURQUOI : les pastilles d'onglet du Shell sont SYNCHRONES (`count: () =>
   number`) — c'est la forme du rendu, pas un détail. Or, dès qu'une collection
   est chargée paresseusement, `store.all(c).length` ne compte plus que ce qui a
   été absorbé : il MENT (0 au boot, puis la taille des pages parcourues). La
   vérité est un `COUNT(*)` serveur, donc asynchrone.

   Ce cache réconcilie les deux : il tient la dernière valeur CONNUE (rendue
   IMMÉDIATEMENT, sans attente), déclenche AU PLUS UN relevé en vol par
   collection (les rendus se succèdent bien plus vite qu'un aller-retour) et
   PRÉVIENT l'hôte à l'arrivée pour qu'il repeigne — patron du badge
   « Interventions » (`main.ts`), généralisé et rendu testable.

   Module PUR : le relevé est INJECTÉ (aucun réseau, aucun Store, aucun DOM ici).
   Un échec de relevé n'est PAS mis en cache et n'explose pas : une pastille est
   un confort, jamais une opération critique — la valeur reste « inconnue » et
   sera retentée au prochain besoin.
   ============================================================================= */

export class CollectionCountCache {
  /** Dernière valeur CONNUE par collection (absente = jamais relevée, ou invalidée). */
  private readonly known = new Map<string, number>();
  /** Relevés EN VOL, partagés : deux demandes rapprochées ne tirent qu'une requête. */
  private readonly inFlight = new Map<string, Promise<number>>();

  /** `load` : le relevé (injecté — en pratique `adapter.count`, un `list(pageSize:1).total`).
      `onResolved` : notifié quand une valeur ARRIVE (l'hôte repeint alors ses pastilles) ; sans lui,
      la valeur entrerait au cache sans que rien ne l'affiche avant le prochain rendu fortuit. */
  constructor(
    private readonly load: (collection: string) => Promise<number>,
    private readonly onResolved: ((collection: string, count: number) => void) | null = null,
  ) {}

  /** Valeur connue, ou `null` si elle n'a jamais été relevée (ou vient d'être invalidée).
      LECTURE PURE : ne déclenche RIEN (à utiliser quand l'appelant ne veut surtout pas de réseau). */
  peek(collection: string): number | null {
    const value = this.known.get(collection);
    return value === undefined ? null : value;
  }

  /** Valeur à AFFICHER MAINTENANT : la connue, sinon `fallback` — et, dans ce dernier cas, DEMANDE le
      relevé (au plus un en vol par collection). C'est l'accesseur des pastilles : synchrone par
      contrat, exact dès que la réponse arrive (via `onResolved` → re-rendu). */
  value(collection: string, fallback = 0): number {
    const value = this.known.get(collection);
    if (value !== undefined) return value;
    void this.request(collection);
    return fallback;
  }

  /** Relève le compte (mémoïsé) : la MÊME promesse est rendue à tous les demandeurs tant qu'elle est en
      vol, et la valeur résolue reste en cache jusqu'à invalidation. Un échec ne met RIEN en cache — la
      prochaine demande retentera (une panne réseau ne doit pas figer une pastille fausse pour la session). */
  request(collection: string): Promise<number> {
    const cached = this.known.get(collection);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.inFlight.get(collection);
    if (pending) return pending;
    const promise = this.load(collection).then((count) => {
      this.inFlight.delete(collection);
      // Une invalidation tombée PENDANT le vol rend cette réponse périmée… mais elle reste la meilleure
      // valeur connue, et la prochaine invalidation explicite la chassera. On la garde : une pastille
      // légèrement en retard vaut mieux qu'une pastille vide.
      this.known.set(collection, count);
      this.onResolved?.(collection, count);
      return count;
    }).catch((error) => {
      this.inFlight.delete(collection);
      throw error;
    });
    this.inFlight.set(collection, promise);
    return promise;
  }

  /** Oublie les valeurs de ces collections (écriture locale, événement SSE SAUTÉ par G3, hydratation) :
      le prochain accès les relèvera. Aucun relevé n'est déclenché ici — invalider n'est pas recharger. */
  invalidate(collections: readonly string[]): void {
    for (const collection of collections) this.known.delete(collection);
  }

  /** Oublie TOUT (remplacement complet du cache : `_hydrate`, import, nouveau document). */
  invalidateAll(): void { this.known.clear(); }

  /** Nombre de relevés EN VOL — diagnostic et tests (la déduplication doit se PROUVER). */
  get pendingCount(): number { return this.inFlight.size; }
}
