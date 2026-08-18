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

   🚨 DROITS PARTIELS (correctif 2026-08-17, cf. docs/auth.md § 10.6) : une
   collection que l'utilisateur n'a PAS le droit de lire entre au cache VIDE, et
   ce vide-là ne doit surtout pas se lire « collection vide » — sinon un
   `PUT /snapshot` ou un export en ferait un document AMPUTÉ. D'où le niveau
   `forbidden`, qui tient les DEUX bouts à la fois :
     · il compte comme non-hydraté, donc G1 refuse BRUYAMMENT le snapshot ;
     · mais il est EXCLU de tout ce qui déclenche une requête (hydrateAll, SSE,
       compteurs, facettes, pager, sections de fiche) — parce qu'il n'y a rien à
       aller chercher, seulement un 403 à récolter.
   `none` et `forbidden` décrivent le même cache vide pour des raisons opposées :
   « pas encore » contre « jamais ».

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

/** Niveau d'hydratation d'UNE collection dans le cache client.

    `forbidden` (correctif « droits partiels », cf. docs/auth.md § 10.6) est le seul niveau qui ne
    décrive PAS un retard de chargement mais une IMPOSSIBILITÉ : l'utilisateur n'a pas le droit de
    lire cette collection, elle ne sera donc JAMAIS chargée pendant cette session. La distinguer de
    `none` n'est pas un raffinement cosmétique — les deux appellent des comportements OPPOSÉS :
    `none` dit « va la chercher quand tu en auras besoin », `forbidden` dit « ne la demande jamais ». */
export type HydrationLevel = "full" | "partial" | "none" | "forbidden";

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
      se re-tire en entier sans annuler le lazy). Une collection INTERDITE ne l'est jamais. */
  isHydrated(collection: string): boolean { return !this.deviations.has(collection); }

  /** 🚨 La collection est-elle INTERDITE à la lecture (droits) ? Prédicat de toutes les surfaces qui
      s'apprêtaient à interroger le serveur « au cas où » : compteurs de pastille, valeurs de facette,
      pager de listing, sections de fiche. Une seule règle à retenir, et elle est absolue :
      **niveau `forbidden` ⇒ AUCUNE requête, jamais** — le serveur répondrait 403, l'utilisateur
      verrait un toast pour un geste qu'il n'a pas fait, et la fenêtre d'anti-rafale finirait par
      expirer (le symptôme S2 du correctif droits partiels). */
  isForbidden(collection: string): boolean { return this.deviations.get(collection) === "forbidden"; }

  /** TOUT le corpus est-il en cache ? (prédicat de G1 : condition des opérations snapshot). Une
      collection INTERDITE compte comme absente — c'est ce qui rend G1 structurellement vraie sous
      droits partiels : le cache ne contient pas le document, donc rien ne peut le sérialiser. */
  isFullyHydrated(): boolean { return this.deviations.size === 0; }

  /** Collections dont le cache n'est PAS complet — `none`, `partial` ET `forbidden`. C'est le
      DIAGNOSTIC de G1 (`assertFullyHydrated` les nomme dans son erreur) ; ce n'est PAS la liste de
      travail de `hydrateAll` : re-tirer une collection interdite donnerait un 403 en pleine face,
      d'où `hydratableCollections()` ci-dessous. */
  notFullCollections(): string[] { return [...this.deviations.keys()]; }

  /** Collections qu'on peut et doit RECHARGER pour compléter le corpus (G2 `hydrateAll`, et la
      réconciliation des catalogues du boot) : les non-`full` MOINS les interdites. La soustraction
      est la moitié « ne demande jamais l'interdit » du correctif — sans elle, un export ou un boot à
      catalogue désynchronisé repart en 403 et fait échouer TOUT le chargement (symptômes S1/S3). */
  hydratableCollections(): string[] {
    return [...this.deviations.entries()].filter(([, level]) => level !== "forbidden").map(([c]) => c);
  }

  /** Collections INTERDITES (diagnostic, tests, et le message de G1). */
  forbiddenCollections(): string[] {
    return [...this.deviations.entries()].filter(([, level]) => level === "forbidden").map(([c]) => c);
  }

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
    // PRÉCÉDENCE explicite : `forbidden` PRIME sur `none`. Une collection interdite est d'abord
    // interdite ; la déclarer lazy ensuite la rendrait « chargeable à la demande », donc requêtable —
    // exactement ce que le correctif ferme. La garde rend l'ordre des deux appels indifférent.
    for (const c of collections) { if (this.deviations.get(c) !== "forbidden") this.deviations.set(c, "none"); }
  }

  /** 🚨 Déclare des collections INTERDITES à la lecture (l'utilisateur n'a pas `<domaine>:read`) —
      posé par `Store.init` juste après l'hydratation, avec la même mécanique et au même endroit que
      `declareLazy`, dont c'est le pendant « ne chargera JAMAIS » (cf. docs/auth.md § 10.6).
      Le niveau est TERMINAL pour la session : rien ne le dégrade (`noteAbsorption` ne peut rien
      absorber d'une collection qu'on ne lit pas), seuls `markFull` (un rechargement complet a
      réellement abouti — donc les droits sont revenus) et `markAllFull` (remplacement total du cache)
      l'effacent, et `init` le re-pose aussitôt à partir des droits COURANTS.
      Sur l'état INERTE (mode fichier/visualiseur) : SANS EFFET — il n'y a ni identité ni ACL en local
      (principe n°15), donc aucun chemin de code ne peut y rendre une collection interdite. */
  declareForbidden(collections: readonly string[]): void {
    if (this.inert) return;
    for (const c of collections) this.deviations.set(c, "forbidden");
  }

  /** Un enregistrement de cette collection vient d'être ABSORBÉ au cache (lecture unitaire, page de
      listing, recherche) : `none` → `partial`. Une collection `full` RESTE full (l'absorption d'une
      ligne déjà connue n'apprend rien) ; `partial` reste partial (on ne sait pas si le tout y est) ;
      `forbidden` reste forbidden (défense en profondeur : si un enregistrement d'une collection
      interdite arrivait tout de même — une recherche transverse mal bornée, un lot résiduel —, le
      cache n'en deviendrait pas « partiellement chargeable », il resterait interdit de requête). */
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
      (point d'accroche `Store.onLazyReloadDeferred`, rempli au lot 1).
      🚨 Les collections INTERDITES ne sont dans NI l'un NI l'autre : elles n'ont ni cache à re-tirer
      ni dérivé à rafraîchir (compteur, facette, page de listing — le listing n'existe pas, l'onglet
      étant masqué). Les verser dans `deferred` ferait relever des compteurs voués au 403 à chaque
      écriture d'un autre client : la fuite S2, par la porte du SSE. */
  splitReload(collections: readonly string[]): { refetch: string[]; deferred: string[] } {
    const refetch: string[] = [], deferred: string[] = [];
    for (const c of collections) {
      if (this.isForbidden(c)) continue;
      (this.isHydrated(c) ? refetch : deferred).push(c);
    }
    return { refetch, deferred };
  }
}
