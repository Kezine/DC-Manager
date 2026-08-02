/* ---- contrat minimal d'un driver SQLite (satisfait par better-sqlite3 ET par un shim de test) ---- */
export interface SqliteStatement { run(...args: any[]): { changes?: number }; get(...args: any[]): any; all(...args: any[]): any[]; }
export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(source: string): unknown;
  transaction<A extends any[]>(fn: (...a: A) => void): (...a: A) => void;
  close(): void;
}
export type SqliteCtor = new (file: string) => SqliteDb;

export type Rec = Record<string, any>;

export interface Snapshot { meta?: Rec; [collection: string]: any }
export interface Tx {
  creates?: { collection: string; record: Rec }[];
  updates?: { collection: string; record: Rec }[];
  deletes?: { collection: string; id: string }[];
  meta?: Rec;
}
export interface ListOpts { page?: number; pageSize?: number; query?: string; where?: Rec | null; ids?: string[] | null }
export interface ListResult { rows: Rec[]; total: number; page: number; pages: number; pageSize: number }
export interface ImageMeta { id: string; name?: string; u_height?: number; face?: string; with_ears?: boolean; description?: string; type?: string; bytes?: number }

/** CONTRAT du dépôt d'un document : la SURFACE PUBLIQUE que doit offrir toute implémentation de la
    persistance d'un document (une base SQLite par document). `documents.ts`/`api.ts` ne dépendent QUE de
    cette interface — jamais d'une classe concrète — de sorte que le choix d'implémentation reste interne à
    `DocumentStore.repo()`.

    Implémentation de PRODUCTION : `RelationalRepository` (`RelationalRepository.ts`), qui `implements` ce
    contrat — le compilateur GARANTIT dès lors que la surface reste conforme (plus besoin d'une garde
    structurelle ad hoc). Le modèle blob JSON historique (`Repository`, ex-`db.ts`) a été retiré au lot L5
    de la migration DB après que sa parité de comportement eut été PROUVÉE corpus contre corpus (lot L3) —
    cf. `docs/persistance.md` et l'historique git. */
export interface RepositoryContract {
  /** Ferme le handle SQLite. INDISPENSABLE avant de supprimer le fichier du document : sous Windows,
      supprimer un fichier encore ouvert échoue (EBUSY/EPERM) — cf. `DocumentStore.delete`. */
  close(): void;

  /* ---- écritures (CRUD unitaire ET /transact) ---- */
  /** Insère ou met à jour un enregistrement. `rev` = révision du document portée par cette écriture →
      estampillée sur la ligne (`updated_rev`) pour le verrou optimiste par entité (cf. `conflicts`).
      0 = écriture non versionnée (import/seed). */
  upsert(collection: string, record: Rec, rev?: number): void;
  /** Supprime l'enregistrement `id` de `collection` (no-op s'il est absent). */
  delete(collection: string, id: string): void;

  /** VERROU OPTIMISTE (par entité) : parmi `targets`, renvoie celles MODIFIÉES après `baseRev`
      (`updated_rev > baseRev`) — c.-à-d. qu'un autre client a écrit dessus depuis le snapshot du client
      courant. Liste vide = aucune collision → l'écriture peut s'appliquer. Les entités absentes (création /
      déjà supprimée) ne comptent pas comme conflit (résurrection sur update-after-delete = limite connue). */
  conflicts(targets: Array<{ collection: string; id: string }>, baseRev: number): Array<{ collection: string; id: string; rev: number }>;

  /* ---- lectures ---- */
  /** Un enregistrement par clé primaire, ou `null` s'il n'existe pas. */
  getOne(collection: string, id: string): Rec | null;
  /** Les enregistrements de `collection` dont l'id est dans `ids` (ordre non garanti). */
  getMany(collection: string, ids: string[]): Rec[];
  /** Liste paginée : { rows, total, page, pages, pageSize }. `query` = plein-texte ; `where` = filtre par
      champ (égalité ; "null" = non rattaché ; champs tableaux = appartenance) ; `ids` court-circuite le
      filtre ; tri sur `created_date`. */
  list(collection: string, opts?: ListOpts): ListResult;

  /** Recherche LEAN par champ, pour les `find` de la validation (dépendance inverse V5b + portée V6). Renvoie
      TOUTES les lignes correspondantes, SANS `COUNT(*)`, SANS `ORDER BY`, SANS pagination — le finder itère
      l'ensemble, il n'a besoin ni du total ni d'un tri. Chemin CHAUD (un save de port déclenche plusieurs
      `find` V6/dependents), d'où l'indexation dédiée côté relationnel (cf. docs/persistance.md). */
  findBy(collection: string, field: string, value: string): Rec[];

  /* ---- meta ---- */
  /** Le sac `meta` du document (objet JSON libre), ou `{}` s'il est absent. */
  getMeta(): Rec;
  /** Remplace le sac `meta` du document. */
  setMeta(meta: Rec): void;

  /* ---- lot atomique (POST /transact) ---- */
  /** Applique un lot d'écritures en UNE transaction, dans l'ordre deletes → updates → creates (puis meta) ;
      `rev` estampille les écritures (verrou optimiste). Une entrée invalide annule TOUT le lot. */
  transact(tx?: Tx, rev?: number): void;

  /* ---- import complet (PUT /snapshot) ---- */
  /** Restauration COMPLÈTE : remplace toutes les collections par le contenu de `snapshot` (DELETE all +
      réinsertion) en une transaction ; `rev` estampille les écritures. */
  replaceSnapshot(snapshot: Snapshot, rev?: number): void;

  /* ---- maintenance ---- */
  /** Opération ADMIN (à la demande) : PURGE les images ORPHELINES (référencées par AUCUN équipement) puis
      COMPACTE la base (checkpoint/optimize/VACUUM). Renvoie le nombre d'images purgées. */
  maintenance(): { purgedImages: number };

  /* ---- images (blobs) ---- */
  /** Métadonnées de toutes les images (sans les blobs). */
  listImages(): ImageMeta[];
  /** Métadonnées d'une image, ou `null` si absente. */
  getImageMeta(id: string): ImageMeta | null;
  /** Contenu binaire d'une image (type MIME + blob), ou `null` si absente / sans blob. */
  getImageBlob(id: string): { type: string; blob: Buffer } | null;
  /** Insère ou met à jour une image (méta + blob optionnel) ; la révision de cache-busting (`?v=`) n'est
      incrémentée que quand un NOUVEAU blob arrive (une édition de méta seule ne bump pas). */
  putImage(id: string, meta: Rec, blob: Buffer | null): void;
  /** Supprime une image. */
  deleteImage(id: string): void;
}
