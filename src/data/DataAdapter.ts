import {
  RawRecord,
  Snapshot,
  Transaction,
  Where,
  ListOptions,
  ListResult,
} from "./types";

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
  async load(): Promise<Snapshot | null> { throw new Error("DataAdapter.load() non implémenté"); }
  async replaceAll(_state: Snapshot): Promise<unknown> { throw new Error("DataAdapter.replaceAll() non implémenté"); }
  async saveMeta(_meta: Record<string, any>): Promise<unknown> { throw new Error("DataAdapter.saveMeta() non implémenté"); }
  async loadMeta(): Promise<Record<string, any> | null> {
    const s = await this.load();
    return s ? (s.meta || null) : null;
  }

  /* ---- transaction (lot atomique multi-entités) ---- */
  async transact(_tx: Transaction): Promise<unknown> { throw new Error("DataAdapter.transact() non implémenté"); }

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

  get label(): string { return "abstrait"; }
}
