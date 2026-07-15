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

/** Options et résultat de `list()` (pagination + recherche + filtre). */
export interface ListOptions {
  page?: number;
  pageSize?: number;
  query?: string;
  where?: Where;
}
export interface ListResult {
  rows: RawRecord[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
}
