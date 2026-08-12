/* Types de la couche d'accès aux données. Les adapters manipulent des
   ENREGISTREMENTS BRUTS (plain objects), jamais des entités hydratées —
   l'hydratation est l'affaire du Store. */

/** Enregistrement brut (sérialisable). */
export type RawRecord = Record<string, any>;

/** Snapshot complet : méta + un tableau d'enregistrements par collection. */
export interface Snapshot {
  meta: Record<string, any>;
  [collection: string]: any;
}

/** Lot transactionnel atomique (cascade / clone / batch). */
export interface TxCreate { collection: string; record: RawRecord; }
export interface TxUpdate { collection: string; id: string; record: RawRecord; }
export interface TxDelete { collection: string; id: string; }
export interface Transaction {
  creates?: TxCreate[];
  updates?: TxUpdate[];
  deletes?: TxDelete[];
  meta?: Record<string, any>;
}

/** Critères d'égalité sérialisables (null ⇔ valeur vide). */
export type Where = Record<string, any> | null;

/** Options et résultat de `list()` (pagination + recherche + filtre + tri serveur). */
export interface ListOptions {
  page?: number;
  pageSize?: number;
  query?: string;
  where?: Where;
  /** TRI SERVEUR (pagination ORDONNÉE complète — lot 1b lazy-load, cf. docs/recherche.md § « Listings
      serveur-pilotés ») : nom d'un champ du modèle appartenant à la liste blanche PARTAGÉE
      (`src-shared/ListOrder` — c'est elle que le serveur valide, 400 sinon) + direction. Absent/null →
      ordre historique `created_date ASC, id ASC`. Ignoré par les adaptateurs locaux (le régime pagé
      n'existe qu'en mode API — le tri local reste l'affaire des vues). */
  sort?: string | null;
  dir?: "asc" | "desc" | null;
  /** ANNULATION par l'appelant (listings serveur-pilotés : la frappe suivante abandonne la requête en
      vol — même patron que `RestAdapter.searchAll`). Ignoré par les adaptateurs locaux, qui ne font
      aucune E/S réseau. */
  signal?: AbortSignal;
}
export interface ListResult {
  rows: RawRecord[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
}
