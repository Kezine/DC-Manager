/* =============================================================================
   StoreListRowSource — la source de lignes des listings adossée au STORE.

   Implémente `ListRowSource` (cf. core/ListRowEngine) pour les collections DU
   DOCUMENT, dans les DEUX modes de données :

   - `local()`  : le cache hydraté (`Store.all`), restreint par la CIBLE puis
     filtré par la recherche PARTAGÉE (`RecordSearchIndex` → même assiette que
     la colonne `search` du serveur). Aucun réseau, jamais — c'est le seul
     chemin du mode fichier (principe n°15) ;
   - `remote()` : le LECTEUR SERVEUR injecté (absent = mode fichier → `null`,
     et le moteur reste local). Traduit la cible en `where` quand elle s'exprime
     en une égalité de colonne, sinon RESTREINT côté client les lignes reçues.

   ASYMÉTRIE ASSUMÉE des cibles (arbitrage A4) : une adresse IP porte l'id de son
   équipement/VM → `where` direct, le serveur fait tout le travail. Un CÂBLE, lui,
   se rattache à un équipement par ses PORTS (deux sauts) : aucun `where` de
   colonne ne l'exprime, la restriction reste CLIENTE — sur les lignes reçues en
   mode API, sur le cache complet en mode fichier. Documenté dans
   docs/recherche.md ; le jour où le serveur saura joindre, seul `where` change.

   PLAFOND : `REMOTE_LIMIT` lignes par requête serveur (le tri et la pagination
   restent CLIENT, cf. l'en-tête du moteur). Même esprit que la page de 500 des
   interventions et que le cap par collection de la recherche transverse : au-delà,
   l'utilisateur affine sa requête.
   ============================================================================= */
import type { Store } from "../store";
import type { ListRowRequest, ListRowSource } from "./ListRowEngine";
import type { RecordSearchIndex } from "./RecordSearchIndex";

/** Contrat DONNÉES d'une cible filtrable — le strict minimum dont la source a besoin (l'habillage UI
    de la dimension « à recherche » vit, lui, dans `views/ListTargets`). */
export interface ListTargetResolver {
  /** Traduction en `where` SERVEUR, ou null si le lien n'est pas une égalité de colonne (2 sauts). */
  where(kind: string, id: string): Record<string, any> | null;
  /** Restriction CLIENTE des lignes à la cible — TOUJOURS définie : c'est le seul chemin du mode fichier. */
  restrict(rows: readonly any[], kind: string, id: string): any[];
}

/** Lecteur SERVEUR injecté (mode API seulement) — un `Store.list` paginé derrière une signature
    minimale, pour que la source ne connaisse ni l'adaptateur REST ni les entêtes de révision. */
export interface RemoteListReader {
  list(collection: string, options: {
    query: string;
    where: Record<string, any> | null;
    limit: number;
    signal: AbortSignal;
  }): Promise<any[]>;
}

export class StoreListRowSource implements ListRowSource {
  /** Plafond du jeu SERVEUR d'un listing (cf. en-tête). */
  static readonly REMOTE_LIMIT = 500;

  /** `target` : le résolveur de la dimension CIBLE (absent = ce listing n'en a pas).
      `reader` : le lecteur serveur (absent = mode FICHIER, `remote()` rendra toujours null). */
  constructor(
    private readonly store: Store,
    private readonly index: RecordSearchIndex,
    private readonly target: ListTargetResolver | null = null,
    private readonly reader: RemoteListReader | null = null,
  ) {}

  local(request: ListRowRequest): any[] {
    let rows: any[] = this.store.all(request.collection);
    if (request.target && this.target) rows = this.target.restrict(rows, request.target.kind, request.target.id);
    return this.index.filter(request.collection, rows, request.query);
  }

  remote(request: ListRowRequest, signal: AbortSignal): Promise<any[]> | null {
    if (!this.reader) return null;                       // mode FICHIER : aucun réseau (principe n°15)
    const query = request.query.trim();
    const target = request.target;
    const where = (target && this.target) ? this.target.where(target.kind, target.id) : null;
    // Ni recherche, ni critère traduisible : rien à demander au serveur — le cache local fait foi
    // (cas d'une cible à 2 sauts sans saisie : les câbles d'un équipement se trouvent en mémoire).
    if (!query && !where) return null;
    return this.reader.list(request.collection, { query, where, limit: StoreListRowSource.REMOTE_LIMIT, signal })
      // Cible NON traduite en `where` (2 sauts) : la restriction reste cliente, sur les lignes reçues.
      .then((rows) => (target && this.target && !where) ? this.target.restrict(rows, target.kind, target.id) : rows);
  }
}
