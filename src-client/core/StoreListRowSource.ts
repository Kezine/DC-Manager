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

   PAGER SERVEUR RÉEL (garde G4, cf. docs/hydratation.md) : `local()` suppose la
   collection HYDRATÉE — pour une collection chargée paresseusement, elle rendrait
   le vide. Cette source consulte donc l'ÉTAT D'HYDRATATION du Store (jamais une
   liste de noms « lazy » : une collection lazy peut être redevenue `full` en cours
   de session — export, hydratation à la demande d'un formulaire) et propose alors
   au moteur un chemin PAGE PAR PAGE. Articulation avec le plafond ci-dessus :
   REMOTE_LIMIT reste la borne du mode « recherche ACTIVE » (inchangé, tous modes) ;
   la pagination réelle, elle, ne s'applique qu'AU REPOS et page par `pageSize`.
   ============================================================================= */
import type { Store } from "../store";
import { ListRowEngine } from "./ListRowEngine";
import type { ListRowPage, ListRowPageRequest, ListRowRequest, ListRowServerSort, ListRowSource } from "./ListRowEngine";
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
  /** PAGE serveur d'une collection NON hydratée (pager RÉEL — garde G4) : les lignes de la page ET les
      compteurs du serveur (`total` = `COUNT(*)`). `sort` (pagination ORDONNÉE complète, lot 1b) = le
      critère de tri du listing traduit en champ serveur, ou null (ordre par défaut `created_date`).
      Absent = cet hôte n'offre pas de pagination serveur (mode fichier, lecteur d'avant G4) → la
      source ne proposera jamais le régime paginé. */
  page?(collection: string, options: {
    page: number;
    pageSize: number;
    where: Record<string, any> | null;
    sort: ListRowServerSort | null;
    signal: AbortSignal;
  }): Promise<ListRowPage>;
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

  /** G4 — ce listing est-il servi PAGE PAR PAGE par le serveur ? TROIS conditions, toutes nécessaires :
      1. l'hôte offre un chemin paginé (mode API — `null`/absent en mode fichier, principe n°15) ;
      2. la collection n'est PAS intégralement en cache (`store.hydration`) : c'est l'ÉTAT qui décide, pas
         une liste de noms — une collection lazy REDEVENUE `full` (export G2, hydratation à la demande)
         retrouve aussitôt le régime local, sans que rien d'autre ne change ;
      3. la requête est AU REPOS : une recherche (ou une cible) active garde le chemin historique
         `remote()`, plafonné à REMOTE_LIMIT, trié et paginé côté client — la bascule serait sinon
         double, et deux découpes concurrentes se disputeraient le pager. */
  isServerPaged(request: ListRowRequest): boolean {
    if (!this.reader || !this.reader.page) return false;
    // 🚨 Collection INTERDITE (droits) : jamais de page serveur — elle vaudrait un 403 par clic de
    // pager. On retombe sur `local()`, donc sur le cache VIDE : l'onglet est de toute façon masqué,
    // et si un chemin détourné y menait, mieux vaut un listing vide qu'une rafale de refus.
    if (this.store.hydration.isForbidden(request.collection)) return false;
    if (this.store.hydration.isHydrated(request.collection)) return false;
    return !ListRowEngine.isActive(request);
  }

  /** Tire UNE page serveur. `where` est TOUJOURS null ici : `isServerPaged` exige une requête au repos,
      donc sans cible — la dimension CIBLE relève du régime `remote()`. `sort` (pagination ordonnée
      complète) est TRANSMIS tel quel : c'est le serveur qui ordonne le corpus, la source ne retrie rien.
      Les lignes reçues sont ABSORBÉES au Store par le lecteur (`Store.list` → `_absorbRecord`), donc
      rendues, triées et ouvertes comme n'importe quelle entité : les colonnes du listing n'ont rien à
      savoir de leur provenance. */
  fetchPage(request: ListRowRequest, pageRequest: ListRowPageRequest, signal: AbortSignal): Promise<ListRowPage> {
    return this.reader!.page!(request.collection, {
      page: pageRequest.page, pageSize: pageRequest.pageSize, where: null, sort: pageRequest.sort || null, signal,
    });
  }

  /** G8 — valeurs SERVEUR d'une facette de colonne, ou `null` si ce listing garde ses options locales.
      DEUX conditions, exactement celles du pager (même doctrine, même ordre) :
      1. l'hôte offre un chemin serveur (mode API — `null` en mode fichier, principe n°15 : les options
         locales y sont exactes PAR CONSTRUCTION, « le document EST le fichier ») ;
      2. la collection n'est PAS intégralement en cache : c'est l'ÉTAT qui décide, jamais une liste de
         noms — une collection lazy redevenue `full` (export G2, hydratation à la demande) retrouve
         aussitôt ses options locales, sans que rien d'autre ne change.
      ⚠ Pas de 3ᵉ condition « requête au repos », contrairement au pager : les options d'un filtre
      décrivent le CORPUS, pas le jeu affiché — elles ne doivent pas se rétrécir parce qu'une recherche
      est en cours (le filtre et la recherche se composent). */
  facetOptions(collection: string, field: string): string[] | null {
    if (!this.reader) return null;
    if (this.store.hydration.isHydrated(collection)) return null;
    // Collection INTERDITE : options locales (donc vides), et surtout aucun `SELECT DISTINCT`.
    // `Store.facetValues` le garantit déjà ; on court-circuite ici pour la même raison que le pager —
    // la source est le point où le régime SERVEUR se décide, la garde s'y lit.
    if (this.store.hydration.isForbidden(collection)) return null;
    return this.store.facetValues(collection, field);
  }
}
