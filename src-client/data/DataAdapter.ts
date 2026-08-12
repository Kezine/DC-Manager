import {
  RawRecord,
  Snapshot,
  Transaction,
  Where,
  ListOptions,
  ListResult,
} from "./types";

/** Options du chargement initial. `skipCollections` = les collections que le Store charge
    PARESSEUSEMENT (mode API, cf. docs/hydratation.md) : l'adaptateur ne les tire PAS, et le Store les
    déclare aussitôt `none` dans son état d'hydratation. Un adaptateur dont le document est MONOLITHIQUE
    (fichier local : « le document EST le fichier ») l'IGNORE — il n'y a rien à sauter dans un blob. */
export interface LoadOptions { skipCollections?: readonly string[]; }

/* =============================================================================
   Interface abstraite de la couche d'accès aux données — pattern Repository.

   L'UI ne parle JAMAIS à un store concret : elle passe par le Store, qui passe
   par un DataAdapter. Toutes les lectures sont GRANULAIRES (par élément/page) et
   renvoient des ENREGISTREMENTS BRUTS ; l'hydratation est l'affaire du Store.

   Écritures unitaires (createOne/updateOne/deleteOne) : routées par défaut vers
   transact() → tous les adapters en héritent gratuitement.

   Contrat transactionnel : 1 action logique de l'UI = 1 transact() (jamais de
   re-sérialisation de tout l'état). BULK (load/replaceAll/saveMeta) : réservé au
   boot / import / nouveau document. UNDO/REDO : géré par l'adapter.
   ============================================================================= */
export abstract class DataAdapter {
  /* ---- bulk (boot / import) ---- */
  async load(_opts?: LoadOptions): Promise<Snapshot | null> { throw new Error("DataAdapter.load() non implémenté"); }
  async replaceAll(_state: Snapshot): Promise<unknown> { throw new Error("DataAdapter.replaceAll() non implémenté"); }
  async saveMeta(_meta: Record<string, any>): Promise<unknown> { throw new Error("DataAdapter.saveMeta() non implémenté"); }
  async loadMeta(): Promise<Record<string, any> | null> {
    const s = await this.load();
    return s ? (s.meta || null) : null;
  }

  /* ---- transaction (lot atomique multi-entités) ---- */
  /** Applique le lot. Le retour est LIBRE (chaque adaptateur y met ce que son support rapporte) ; le
      Store n'y lit qu'une chose, de façon TOLÉRANTE : la cascade RÉSIDUELLE d'un serveur qui aurait
      supprimé plus que le plan client (`{ residual: { deletes } }`, garde M4 — cf. docs/hydratation.md). */
  async transact(_tx: Transaction): Promise<unknown> { throw new Error("DataAdapter.transact() non implémenté"); }

  /* ---- APERÇU de cascade SERVEUR (garde G5, cf. docs/hydratation.md § Vague 2) ----
     Plan de suppression calculé par le SERVEUR sur le corpus COMPLET, pour les UI qui annoncent les
     effets d'une suppression alors que le cache client peut être partiel. `null` = cet adaptateur
     n'offre pas d'aperçu serveur (mode fichier : le cache EST le document, le plan local fait foi) →
     le Store retombe sur son plan local, sans test de mode chez l'appelant. */
  async cascadePreview(_collection: string, _ids: readonly string[]): Promise<{ deletes: Array<{ c: string; id: string }>; detaches: Array<{ c: string; id: string; key: string; value: any }> } | null> { return null; }

  /* ---- lectures granulaires (par élément) ---- */
  async list(_collection: string, _opts?: ListOptions): Promise<ListResult> { throw new Error("DataAdapter.list() non implémenté"); }
  async getOne(_collection: string, _id: string): Promise<RawRecord | null> { throw new Error("DataAdapter.getOne() non implémenté"); }
  async getMany(collection: string, ids: string[]): Promise<RawRecord[]> {
    const rows = await Promise.all((ids || []).map((id) => this.getOne(collection, id)));
    return rows.filter(Boolean) as RawRecord[];
  }
  async findBy(_collection: string, _field: string, _value: any): Promise<RawRecord[]> { throw new Error("DataAdapter.findBy() non implémenté"); }
  async count(collection: string, where: Where = null): Promise<number> {
    const res = await this.list(collection, { page: 1, pageSize: 1, where });
    return res.total;
  }

  /* ---- FACETTE d'une colonne (garde G8, cf. docs/hydratation.md § Vague 3) ----
     Valeurs DISTINCTES non vides d'un champ, calculées par le SERVEUR : les options d'un filtre
     d'énumération d'un listing dont la collection n'est PAS en cache (le balayage local ne verrait
     que les pages parcourues). `null` = cet adaptateur n'offre pas de facettes serveur (mode fichier :
     le cache EST le document, les options locales sont exactes) → le Store calcule en local, sans
     test de mode chez l'appelant. */
  async facetValues(_collection: string, _field: string): Promise<string[] | null> { return null; }

  /* ---- écritures unitaires (défaut : via transact → undo/historique inclus) ---- */
  async createOne(collection: string, record: RawRecord): Promise<RawRecord> {
    await this.transact({ creates: [{ collection, record }] });
    return record;
  }
  async updateOne(collection: string, id: string, record: RawRecord): Promise<RawRecord> {
    await this.transact({ updates: [{ collection, id, record }] });
    return record;
  }
  async deleteOne(collection: string, id: string): Promise<void> {
    await this.transact({ deletes: [{ collection, id }] });
  }

  /* ---- undo/redo ---- */
  canUndo(): boolean { return false; }
  canRedo(): boolean { return false; }
  async undo(): Promise<Snapshot | null> { return null; }
  async redo(): Promise<Snapshot | null> { return null; }
  /** Révision courante (position d'historique) pour le calcul du « dirty ». Défaut : sans historique. */
  histIndex(): number { return 0; }

  get label(): string { return "abstrait"; }
}
