/* =============================================================================
   EntityCandidates — la SOURCE de candidats d'entités PARTAGÉE des recherches
   transverses (lot 4 du chantier « recherche partagée / chargement dynamique »).

   Répond à UNE question : « quels candidats {kind, id, label} pour cette saisie,
   dans ces familles ? » — la question que posaient, chacun de leur côté et à
   l'identique, `interventionTargets.search` (éditeur de liens d'intervention) et
   `ListTargets.candidates` (filtre CIBLE des listings). Un seul module désormais.

   EXÉCUTION DOUBLE (principe n°15) :
   - MODE FICHIER (et repli / affichage pendant le vol) : le CACHE LOCAL du Store
     (`all`) classé par `TargetSearch.rank` — jamais de réseau. C'est le SEUL
     chemin du mode fichier, et l'exécution SYNCHRONE toujours offerte du corollaire
     n°15 (`local`) ;
   - MODE API : la recherche transverse serveur (`GET …/search`, lecteur INJECTÉ)
     restreinte aux collections des familles, en UN aller-retour → records →
     candidats. Le LIBELLÉ vient de l'instance LOCALE du Store quand elle existe
     (patron `GlobalSearchSources.dressRecords`), sinon du record brut. Les
     candidats sont RE-CLASSÉS par `TargetSearch.rank` côté client : le serveur
     FILTRE (LIKE sur la colonne `search`), le client CLASSE — donc le CLASSEMENT
     est le MÊME dans les deux modes (cohérence par construction). En mode API, le
     serveur peut renvoyer des candidats AU-DELÀ du corpus chargé : préparation de
     l'hydratation PARTIELLE (option C), sans que rien ne change aujourd'hui puisque
     le document reste hydraté (la parité fichier ⇄ serveur est verrouillée par test).

   DEUX classes, un concept :
   - `EntityCandidates` : le cœur PUR (statique, testable headless) — `local` /
     `fromRecords` / le plafond partagé ;
   - `EntityCandidateSource` : l'orchestration DOUBLE MODE réutilisable (anti-rebond
     porté par le SearchPop appelant, ANNULATION de la requête devancée + REPLI local
     sur échec ici) — une instance par point de recherche (elle porte son
     AbortController, comme la palette globale porte le sien).

   POURQUOI ne PAS réutiliser `ListRowEngine` : son modèle est « lignes locales
   SYNCHRONES maintenant + repeinture ASYNC via rappel » (un listing qui se
   re-rend tout seul). Un `SearchPop` est piloté par un `fetch` qui rend une
   PROMESSE, et porte DÉJÀ l'anti-rebond + le `StaleGate` (fraîcheur). Empiler les
   deux dédoublerait l'anti-rebond et la garde de fraîcheur. Le branchement le plus
   simple qui ne duplique rien = le `fetch` du SearchPop + cette source pour
   l'annulation/repli. Cf. docs/recherche.md § « Pickers et recherches d'entités ».
   ============================================================================= */
import type { TargetSearchItem } from "./TargetSearch";
import { TargetSearch } from "./TargetSearch";
import { Schema } from "../../src-shared/Schema";
import { ListRowEngine } from "./ListRowEngine";

/** Lecture MINIMALE du Store dont la source a besoin — DÉCOUPLÉE du vrai Store (principe n°2), pour
    que le module reste testable en isolation (harnais Node) avec un store factice. Le vrai `Store`
    la satisfait structurellement. */
export interface CandidateStore {
  all(collection: string): any[];
  get(collection: string, id: string): any;
}

/** Une FAMILLE cherchable : le slug de cible (`kind`), la collection du document où lire les records,
    et la RÈGLE DE NOMMAGE (INJECTÉE — propre au contexte : `name`, `displayName` d'un spare, repli
    localisé). Le module ne connaît NI comment nommer un record : tout est injecté (le nommage est
    la seule chose qui varie d'un point de recherche à l'autre). */
export interface EntityCandidateFamily {
  kind: string;
  collection: string;
  label(record: any): string;
}

/** Lecteur SERVEUR injecté (mode API SEULEMENT) : recherche transverse `GET …/search` restreinte aux
    `collections`, en UN aller-retour → records par collection. `signal` annule la requête devancée
    (AbortController). Absent (null) = mode FICHIER : la source reste 100 % locale (principe n°15). */
export interface EntitySearchReader {
  search(query: string, collections: string[], signal: AbortSignal): Promise<Record<string, any[]>>;
}

/** Options communes au classement (plafond + dédup des cibles déjà liées). */
interface CandidateRankOptions {
  /** Plafond de candidats — défaut `EntityCandidates.SEARCH_LIMIT`. */
  limit?: number;
  /** Clés « kind:id » à écarter des résultats (cibles DÉJÀ liées — dédup silencieuse). */
  excluded?: ReadonlySet<string>;
}

export class EntityCandidates {
  /** Plafond de candidats proposés — MÊME valeur partout (éditeur de liens d'intervention, filtres
      CIBLE des listings) : au-delà, l'utilisateur affine sa saisie plutôt que de dérouler une liste
      illisible. C'était `ListTargets.SEARCH_LIMIT` (12), centralisé ici depuis la factorisation. */
  static readonly SEARCH_LIMIT = 12;

  /** MODE FICHIER (et repli / affichage pendant le vol) : candidats depuis le CACHE LOCAL du Store,
      classés par pertinence (préfixe avant inclusion) via le module pur `TargetSearch`. C'est,
      À L'IDENTIQUE, ce que faisaient `interventionTargets.search` et `ListTargets.candidates` avant la
      factorisation — la parité fichier avant/après est verrouillée par test (golden). */
  static local(store: CandidateStore, families: readonly EntityCandidateFamily[], query: string,
    opts: CandidateRankOptions = {}): TargetSearchItem[] {
    const items = families.flatMap((family) => store.all(family.collection)
      .map((record: any) => ({ kind: family.kind, id: record.id, label: family.label(record) })));
    return EntityCandidates.rank(items, query, opts);
  }

  /** MODE API : records REÇUS DU SERVEUR (par collection) → candidats. Le LIBELLÉ est tiré de l'instance
      LOCALE du Store quand elle existe (patron `GlobalSearchSources.dressRecords` : habillage riche —
      `displayName` d'un spare — et cohérence avec le corpus local) ; un record INCONNU localement
      (écriture concurrente pas encore synchronisée) est nommé sur le record BRUT — dégradé mais
      fonctionnel. Puis RE-CLASSÉS par `TargetSearch.rank` : le classement est le MÊME qu'en mode fichier.
      Les collections inconnues des familles sont IGNORÉES (le serveur est générique — il peut renvoyer
      plus que ce que ces familles couvrent). */
  static fromRecords(store: CandidateStore, families: readonly EntityCandidateFamily[],
    recordsByCollection: Record<string, any[]>, query: string, opts: CandidateRankOptions = {}): TargetSearchItem[] {
    const familyByCollection = new Map(families.map((family) => [family.collection, family]));
    const items: TargetSearchItem[] = [];
    for (const [collection, records] of Object.entries(recordsByCollection || {})) {
      const family = familyByCollection.get(collection);
      if (!family) continue;
      for (const record of records || []) {
        if (!record || !record.id) continue;
        const local = store.get(collection, record.id) || record;   // instance locale PRÉFÉRÉE (habillage riche)
        items.push({ kind: family.kind, id: record.id, label: family.label(local) });
      }
    }
    return EntityCandidates.rank(items, query, opts);
  }

  /** Classement PARTAGÉ des deux modes : normalisation PARTAGÉE (`Schema.normSearch` — casse/accents,
      la MÊME que la colonne `search` du serveur), plafond commun, dédup. */
  private static rank(items: readonly TargetSearchItem[], query: string, opts: CandidateRankOptions): TargetSearchItem[] {
    return TargetSearch.rank(items, query, {
      normalize: Schema.normSearch,
      limit: opts.limit != null ? opts.limit : EntityCandidates.SEARCH_LIMIT,
      excluded: opts.excluded,
    });
  }
}

export class EntityCandidateSource {
  /** Anti-rebond avant l'aller-retour serveur — MÊME rythme que la palette globale et les listings
      (`ListRowEngine.REMOTE_DEBOUNCE_MS` = 200 ms) : toutes les surfaces serveur-pilotées réagissent au
      même tempo. RÉUTILISÉ (jamais réinventé) par les `SearchPop` que cette source alimente. */
  static readonly DEBOUNCE_MS = ListRowEngine.REMOTE_DEBOUNCE_MS;

  /** Requête serveur en vol — ANNULÉE dès qu'une nouvelle part (AbortController), comme la palette. */
  private abort: AbortController | null = null;

  /** `reader` null = mode FICHIER : `fetch` reste local, jamais de réseau (principe n°15). */
  constructor(
    private readonly store: CandidateStore,
    private readonly families: readonly EntityCandidateFamily[],
    private readonly reader: EntitySearchReader | null,
    private readonly limit: number = EntityCandidates.SEARCH_LIMIT,
  ) {}

  /** Candidats LOCAUX (SYNCHRONES) — le seul chemin du mode fichier, et le repli du mode API (corollaire
      n°15 : l'exécution synchrone locale reste toujours offerte). */
  local(query: string, excluded?: ReadonlySet<string>): TargetSearchItem[] {
    return EntityCandidates.local(this.store, this.families, query, { limit: this.limit, excluded });
  }

  /** Candidats de la saisie, DOUBLE MODE (principe n°15) :
      - mode FICHIER (reader null) → `local` synchrone, enveloppé d'une promesse résolue ;
      - mode API → `search` (transverse serveur) restreint aux collections des familles, avec ANNULATION
        de la requête devancée (AbortController) et REPLI local silencieux en cas d'échec RÉEL (parité
        palette / listings, trace console). Une ANNULATION n'est PAS un échec : on laisse filer le rejet
        (le `StaleGate` du SearchPop appelant ignore de toute façon la réponse périmée) plutôt que de
        retomber sur le local, ce qui serait un rendu concurrent. */
  async fetch(query: string, excluded?: ReadonlySet<string>): Promise<TargetSearchItem[]> {
    if (!this.reader) return this.local(query, excluded);
    if (this.abort) this.abort.abort();
    const abort = new AbortController();
    this.abort = abort;
    const collections = this.families.map((family) => family.collection);
    try {
      const byCollection = await this.reader.search(query, collections, abort.signal);
      return EntityCandidates.fromRecords(this.store, this.families, byCollection, query, { limit: this.limit, excluded });
    } catch (error) {
      if (abort.signal.aborted) throw error;   // requête devancée : le StaleGate tranche, pas de repli concurrent
      console.warn("[candidats] serveur indisponible, repli sur les candidats locaux :", error);
      return this.local(query, excluded);
    }
  }
}
