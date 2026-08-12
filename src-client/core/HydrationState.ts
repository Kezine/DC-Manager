/* =============================================================================
   HydrationState — ÉTAT D'HYDRATATION par collection (lot 0 du chantier
   « lazy-load des collections », cf. docs/hydratation.md).

   POURQUOI : `Store.data[c]` est initialisé `[]` pour toute collection — RIEN
   n'y distingue « vide » de « pas encore chargée », donc `store.all()` peut
   MENTIR silencieusement dès qu'une collection est chargée paresseusement. Ce
   module porte la vérité manquante : pour chaque collection, son NIVEAU
   d'hydratation (`full` | `partial` | `none`), ses transitions, et les
   PRÉDICATS que consomment les gardes de sûreté :

   - 🚨 G1 (anti-snapshot) : `assertFullyHydrated` — un `PUT /snapshot` dérivé
     d'un cache partiel serait une PERTE DE DONNÉES (le serveur remplace chaque
     collection par ce qu'on lui envoie) → refus BRUYANT par erreur NOMMÉE.
   - G2 (export = hydrater TOUT avant) : `notFullCollections` — la liste exacte
     de ce que `Store.hydrateAll()` doit recharger avant de laisser courir un
     `toJSON()` d'export.
   - G3 (SSE) : `splitReload` — partition d'un plan de rechargement entre
     collections à re-tirer (hydratées) et collections à SAUTER (les re-tirer
     annulerait le lazy).

   DEUX ÉTATS, UNE CLASSE (principe n°15 — mode local d'abord) :
   - `new HydrationState()` : état TRAÇANT (mode API) — les vagues du chantier
     y déclareront leurs collections lazy à l'ouverture d'un document.
   - `HydrationState.alwaysFull()` : état INERTE (mode fichier + visualiseur) —
     « le document EST le fichier », tout y est réputé `full` PAR CONSTRUCTION :
     `declareLazy` y est SANS EFFET, si bien qu'aucun chemin de code, présent ou
     futur, ne peut rendre un document local partiellement hydraté. C'est la
     matérialisation de l'INJECTION NULLE côté hôte (`REST_MODE ? … : null`,
     cf. main.ts) : zéro `if (mode)` dans les modules.

   Module PUR (aucun DOM, aucun réseau, aucun Store) : les transitions et les
   gardes sont testables headless (Tests/modules/test-hydration.js).
   ============================================================================= */

/** Niveau d'hydratation d'UNE collection dans le cache client. */
export type HydrationLevel = "full" | "partial" | "none";

/** Refus d'une opération qui exige le corpus COMPLET (garde G1) — erreur NOMMÉE, jamais silencieuse :
    un snapshot dérivé d'un cache partiel effacerait côté serveur les enregistrements non chargés. */
export class HydrationError extends Error {
  /** Collections dont l'absence a motivé le refus (niveau ≠ "full" au moment du contrôle). */
  readonly collections: string[];
  /** Opération refusée (libellé développeur : "persistAll (PUT /snapshot)"…). */
  readonly operation: string;
  constructor(operation: string, collections: string[]) {
    super("Opération refusée sur corpus PARTIELLEMENT hydraté : " + operation
      + " — collections non chargées : " + collections.join(", ")
      + " (garde G1, cf. docs/hydratation.md)");
    this.name = "HydrationError";
    this.operation = operation;
    this.collections = collections;
  }
}

export class HydrationState {
  /** SEULES les collections NON pleinement hydratées sont mémorisées (déviation par rapport au défaut
      « full ») : une collection inconnue de la carte est full — c'est le régime de TOUTES les collections
      tant qu'aucune vague n'a déclaré de lazy, donc l'état par défaut est le comportement historique. */
  private readonly deviations = new Map<string, Exclude<HydrationLevel, "full">>();
  /** État INERTE (mode fichier/visualiseur) : `declareLazy` sans effet → tout reste full pour toujours.
      Privé, posé UNIQUEMENT par la fabrique `alwaysFull` — `new HydrationState()` = état TRAÇANT (mode API). */
  private inert = false;

  /** État INERTE : tout est réputé `full` PAR CONSTRUCTION, définitivement (mode fichier + visualiseur —
      « le document EST le fichier »). Fabriqué par le Store quand l'hôte n'injecte RIEN (injection nulle). */
  static alwaysFull(): HydrationState {
    const state = new HydrationState();
    state.inert = true;
    return state;
  }

  /* ---- lectures / prédicats (consommés par les gardes) ---- */

  /** Niveau d'hydratation d'une collection — défaut `full` (aucune déviation connue). */
  levelOf(collection: string): HydrationLevel { return this.deviations.get(collection) || "full"; }

  /** La collection est-elle INTÉGRALEMENT en cache ? (prédicat de G3 : seule une collection hydratée
      se re-tire en entier sans annuler le lazy). */
  isHydrated(collection: string): boolean { return !this.deviations.has(collection); }

  /** TOUT le corpus est-il en cache ? (prédicat de G1 : condition des opérations snapshot). */
  isFullyHydrated(): boolean { return this.deviations.size === 0; }

  /** Collections dont le cache n'est PAS complet (`none` + `partial`) — la liste de travail de
      `Store.hydrateAll()` (G2). */
  notFullCollections(): string[] { return [...this.deviations.keys()]; }

  /** Collections PARTIELLEMENT en cache (des enregistrements absorbés à la demande, pas le tout). */
  partialCollections(): string[] {
    return [...this.deviations.entries()].filter(([, level]) => level === "partial").map(([c]) => c);
  }

  /* ---- transitions ---- */

  /** Déclare des collections CHARGÉES PARESSEUSEMENT (→ `none`). À poser à l'OUVERTURE d'un document,
      AVANT toute lecture : c'est le point d'entrée que les vagues 1-3 du chantier appelleront — personne
      ne l'appelle au lot 0 (comportement inchangé). Sur l'état INERTE (mode fichier) : SANS EFFET. */
  declareLazy(collections: readonly string[]): void {
    if (this.inert) return;   // mode fichier/visualiseur : le document est le fichier, rien n'est jamais lazy
    for (const c of collections) this.deviations.set(c, "none");
  }

  /** Un enregistrement de cette collection vient d'être ABSORBÉ au cache (lecture unitaire, page de
      listing, recherche) : `none` → `partial`. Une collection `full` RESTE full (l'absorption d'une
      ligne déjà connue n'apprend rien) ; `partial` reste partial (on ne sait pas si le tout y est). */
  noteAbsorption(collection: string): void {
    if (this.deviations.get(collection) === "none") this.deviations.set(collection, "partial");
  }

  /** La collection vient d'être re-tirée EN ENTIER (hydrateAll, rechargement granulaire complet) → `full`. */
  markFull(collection: string): void { this.deviations.delete(collection); }

  /** Un instantané COMPLET du document vient d'être absorbé (`Store._hydrate` : init, import/replaceAll,
      newDocument, undo/redo) → tout est full. ⚠ CONTRAT pour les vagues futures : une ouverture qui NE
      charge PAS tout doit re-déclarer ses collections lazy APRÈS l'hydratation (cf. docs/hydratation.md). */
  markAllFull(): void { this.deviations.clear(); }

  /* ---- gardes ---- */

  /** 🚨 G1 — refuse BRUYAMMENT (HydrationError) toute opération qui sérialiserait le document ENTIER
      depuis un cache incomplet. `operation` nomme le chemin refusé (message de débogage). */
  assertFullyHydrated(operation: string): void {
    if (this.deviations.size) throw new HydrationError(operation, this.notFullCollections());
  }

  /** G3 — partition d'un plan de rechargement (SSE) : `refetch` = collections hydratées (re-tirage
      complet légitime), `deferred` = collections `none`/`partial` à SAUTER — les re-tirer en entier
      annulerait le lazy ; leurs caches DÉRIVÉS (compteurs…) sont à invalider chez l'appelant
      (point d'accroche `Store.onLazyReloadDeferred`, rempli au lot 1). */
  splitReload(collections: readonly string[]): { refetch: string[]; deferred: string[] } {
    const refetch: string[] = [], deferred: string[] = [];
    for (const c of collections) (this.isHydrated(c) ? refetch : deferred).push(c);
    return { refetch, deferred };
  }
}
