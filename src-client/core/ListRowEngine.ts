/* =============================================================================
   ListRowEngine — « d'où viennent les lignes d'un listing ? »

   Le MOTEUR de lignes des `ListView` : il décide, à chaque rendu, si les lignes
   affichées viennent du CACHE LOCAL (le document hydraté) ou du SERVEUR, et
   orchestre l'aller-retour serveur exactement comme la palette globale du lot 2
   (anti-rebond + annulation de la requête précédente + REPLI local silencieux).
   La SOURCE des lignes est INJECTÉE (`ListRowSource`) : le moteur ne connaît ni
   le Store, ni le réseau — c'est ce qui le rend testable en isolation et ce qui
   permettra, plus tard, une hydratation PARTIELLE sans le rouvrir.

   RÈGLE DE BASCULE (arbitrage A2 du lot 3) :
   - requête INACTIVE (ni recherche saisie, ni cible filtrée) → LOCAL, toujours.
     Le corpus est hydraté : re-tirer la liste complète du serveur serait du
     gaspillage pur, et le mode fichier n'a de toute façon pas de serveur ;
   - requête ACTIVE → on DEMANDE à la source un chemin serveur. Elle rend `null`
     quand il n'y en a pas (mode fichier, ou critère non exprimable en `where`) :
     on reste alors local, sans réseau.

   TROISIÈME RÉGIME — PAGER SERVEUR RÉEL (garde G4 du chantier lazy-load, cf.
   docs/hydratation.md) : la règle ci-dessus SUPPOSE le corpus hydraté. Pour une
   collection chargée PARESSEUSEMENT, « requête inactive → local » afficherait le
   vide. Le listing demande alors des PAGES au serveur (`page()`), avec le total
   RÉEL (`COUNT(*)`) et la navigation page à page — c'est la pagination de l'app
   enfin visible. La SOURCE tranche (`isServerPaged`) : le moteur ne connaît pas
   plus l'état d'hydratation que le réseau. Les deux régimes ne se recouvrent
   jamais — une recherche ACTIVE sur une collection lazy repasse par le chemin
   historique `rows()` (jeu plafonné, tri et pagination client).

   CE QUE VOIT L'UTILISATEUR PENDANT LE VOL : les lignes LOCALES, filtrées avec
   la même assiette (`RecordSearchIndex`). Le listing ne « blanchit » donc jamais
   en tapant, et un serveur en échec ne casse rien — il dégrade vers le local,
   avec une trace console. Deux MÉMOIRES de signature évitent les rendus qui
   « tournent en rond » : l'ABSENCE de jeu serveur (échec réel ou pas de chemin)
   empêche la reprogrammation en boucle de la même requête, et la requête DÉJÀ
   en vol empêche un simple clic de tri de l'annuler pour la relancer à l'identique.

   ⚠ LIMITE ASSUMÉE du régime `rows()` : le TRI et la pagination y restent CLIENT,
   sur les lignes reçues (les accesseurs de tri d'un listing sont des fonctions
   arbitraires, souvent dérivées — il n'y a pas de colonne SQL en face). Le jeu
   serveur est donc PLAFONNÉ par la source ; au-delà, l'utilisateur affine sa
   recherche. Le régime `page()`, lui, pagine POUR DE VRAI (il n'a pas le choix :
   la collection n'est pas en cache) — et depuis la PAGINATION ORDONNÉE COMPLÈTE
   (lot 1b), le critère de tri du listing y ordonne le CORPUS entier quand il se
   mappe sur un champ serveur (`ListRowPageRequest.sort`, liste blanche partagée
   `ListOrder`) ; sans mapping, l'ordre serveur par défaut demeure et la vue trie
   la page reçue (repli documenté).
   Cf. docs/recherche.md § « Listings serveur-pilotés » et docs/hydratation.md.
   ============================================================================= */

/** Cible d'un filtre « à recherche » (dimension CIBLE unifiée) : une famille + un identifiant. */
export interface ListRowTarget { kind: string; id: string; }

/** Ce qu'un listing DEMANDE : sa collection, la saisie de recherche, la cible filtrée (ou aucune). */
export interface ListRowRequest {
  collection: string;
  query: string;
  target: ListRowTarget | null;
}

/** TRI SERVEUR d'une page (pagination ORDONNÉE complète — lot 1b) : un champ du MODÈLE (liste blanche
    partagée `ListOrder`, mappé depuis le critère de la vue par `core/ListServerSort`) + la direction. */
export interface ListRowServerSort { field: string; dir: "asc" | "desc"; }

/** Ce qu'un listing demande d'une PAGE serveur (pager RÉEL des collections lazy). `sort` = le critère
    de tri ACTIF traduit en champ serveur — l'ORDER BY porte alors sur le CORPUS entier, la découpe en
    pages le suit (pagination ordonnée complète, cf. docs/hydratation.md § « Vague 1 »). `null` = aucun
    critère mappable (colonne sans `sortField`) : ordre serveur par défaut (`created_date`), et la vue
    assume le REPLI documenté « trier la page reçue ». */
export interface ListRowPageRequest { page: number; pageSize: number; sort: ListRowServerSort | null; }

/** Une PAGE servie par le serveur : ses lignes + les compteurs RÉELS (total = `COUNT(*)`), qui pilotent
    directement le pager de la vue — plus aucune arithmétique cliente sur un jeu plafonné. */
export interface ListRowPage { rows: any[]; total: number; page: number; pages: number; }

/** Source de lignes — INJECTÉE (principe n°2). Deux chemins, une seule sémantique : les lignes qui
    satisfont la requête. `remote` rend `null` quand cette source n'a pas de serveur (mode fichier) ou
    quand la requête n'est pas serveur-pilotable ; le moteur reste alors sur `local`. */
export interface ListRowSource {
  /** Lignes LOCALES (document hydraté), SYNCHRONES — jamais de réseau. */
  local(request: ListRowRequest): any[];
  /** Lignes SERVEUR de la requête, ou `null` si aucun chemin serveur ne s'applique. */
  remote(request: ListRowRequest, signal: AbortSignal): Promise<any[]> | null;
  /** Cette requête est-elle servie PAGE PAR PAGE par le serveur (collection NON hydratée, mode API) ?
      Prédicat SYNCHRONE et sans effet de bord : il est consulté à CHAQUE rendu. Absent (sources
      d'avant G4, sources de test) = jamais paginée serveur → comportement historique intégral. */
  isServerPaged?(request: ListRowRequest): boolean;
  /** Tire UNE page serveur. Appelée uniquement quand `isServerPaged` a répondu oui. */
  fetchPage?(request: ListRowRequest, page: ListRowPageRequest, signal: AbortSignal): Promise<ListRowPage>;
  /** Valeurs d'une FACETTE de colonne servies par le SERVEUR (garde G8, vague 3 du lazy-load), ou
      `null` quand cette source n'en propose pas — mode fichier, ou collection intégralement en cache :
      les options LOCALES du filtre sont alors exactes et la vue les garde, inchangées.
      SYNCHRONE et consulté à chaque rendu, comme `isServerPaged` : la source rend les dernières
      valeurs connues (vide en attendant) et déclenche le relevé. Absent (sources d'avant G8, sources
      de test) = jamais de facette serveur → comportement historique intégral.
      ⚠ Vit sur la SOURCE et non sur le moteur : le moteur ne s'occupe que des LIGNES. C'est la vue qui
      interroge sa source pour ses options, comme elle l'interroge — via le moteur — pour ses lignes. */
  facetOptions?(collection: string, field: string): string[] | null;
}

export class ListRowEngine {
  /** Anti-rebond avant l'aller-retour serveur — MÊME valeur que la palette globale
      (`GlobalSearchPalette.REMOTE_DEBOUNCE_MS`) : les deux surfaces réagissent au même rythme. */
  static readonly REMOTE_DEBOUNCE_MS = 200;

  /** Une requête est-elle ACTIVE ? (= mérite-t-elle qu'on interroge le serveur). Une saisie blanche ne
      compte pas — c'est aussi ce que fait le serveur, qui ignore une requête vide. */
  static isActive(request: ListRowRequest): boolean {
    return request.query.trim() !== "" || request.target !== null;
  }

  /** Identité d'une requête : ce qui distingue deux jeux de lignes. Sert à savoir si une réponse en
      main COUVRE encore la saisie courante (la frappe avance vite, les réponses arrivent en désordre). */
  static signature(request: ListRowRequest): string {
    const target = request.target ? request.target.kind + ":" + request.target.id : "";
    return request.collection + "\n" + request.query.trim() + "\n" + target;
  }

  /** Identité d'une PAGE : la requête PLUS la découpe demandée PLUS le tri serveur — changer de page,
      de taille de page OU de critère/direction de tri EST une nouvelle demande serveur (pagination
      ordonnée complète : l'ORDER BY redécoupe le corpus entier ; l'ancien « le tri n'en est pas une »
      datait du pilote, où il ne s'appliquait qu'à la page reçue). `sort` absent/null (colonne sans
      champ serveur, source d'avant le lot 1b) = même identité : l'ordre par défaut du serveur. */
  static pageSignature(request: ListRowRequest, page: ListRowPageRequest): string {
    const sort = page.sort ? page.sort.field + " " + page.sort.dir : "";
    return ListRowEngine.signature(request) + "\n" + Math.max(1, page.page | 0) + "\n" + Math.max(1, page.pageSize | 0) + "\n" + sort;
  }

  /** Lignes SERVEUR de la dernière réponse — null tant qu'aucune ne couvre une requête. */
  private remoteRows: any[] | null = null;
  /** Signature que `remoteRows` couvre. */
  private remoteFor = "";
  /** Signature de la dernière requête pour laquelle AUCUN jeu serveur n'est à attendre — échec réel, ou
      absence de chemin serveur (mode fichier, critère non traduisible). Anti-boucle : sans elle, le rendu
      de repli reprogrammerait indéfiniment la même interrogation pour le même verdict. */
  private noRemoteFor = "";
  /** Signature de la requête DÉJÀ programmée / en vol — "" si aucune. Sans elle, un rendu qui ne change
      pas la requête (clic de tri, changement de page, re-rendu externe) RELANCERAIT la même interrogation :
      l'anti-rebond repartirait de zéro et la requête en vol serait annulée, retardant sa propre réponse. */
  private pendingFor = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  /** Génération : une réponse arrivée après un `reset()` (onglet quitté, listing détruit) est jetée. */
  private generation = 0;
  /** Le dernier jeu rendu venait-il du serveur ? (diagnostic + tests — le jeu serveur est plafonné). */
  private servedRemote = false;

  /* ---- état du PAGER SERVEUR (G4) : volontairement DISJOINT de l'état « recherche serveur » ci-dessus.
     Les deux régimes ne s'appliquent jamais en même temps (une requête active désactive le pager), et
     les mélanger ferait qu'une saisie effacerait la page en main — ou l'inverse. ---- */
  /** Dernière page SERVEUR reçue — null tant qu'aucune n'a abouti. */
  private pageResult: ListRowPage | null = null;
  /** Signature de page que `pageResult` couvre. */
  private pageFor = "";
  /** Signature dont le tirage a ÉCHOUÉ : anti-boucle (sans elle, le rendu de repli le reprogrammerait
      indéfiniment — même raison que `noRemoteFor` pour la recherche). */
  private pageFailedFor = "";
  /** Signature de page EN VOL — "" si aucune (un re-rendu ne relance pas la même page). */
  private pagePendingFor = "";
  private pageAbort: AbortController | null = null;

  /** `onRemoteRows` : le listing se REPEINT quand une réponse serveur arrive (le rendu, lui, reste
      synchrone). `debounceMs` est réglable pour les tests — jamais en production. */
  constructor(
    private readonly source: ListRowSource,
    private readonly onRemoteRows: () => void,
    private readonly debounceMs: number = ListRowEngine.REMOTE_DEBOUNCE_MS,
  ) {}

  /** Le jeu rendu au dernier `rows()` venait-il du SERVEUR ? */
  get fromRemote(): boolean { return this.servedRemote; }

  /** Lignes à AFFICHER MAINTENANT pour cette requête (synchrone), et programmation éventuelle de
      l'aller-retour serveur. Voir l'en-tête pour la règle complète. */
  rows(request: ListRowRequest): any[] {
    if (!ListRowEngine.isActive(request)) {
      // Retour au repos : on jette tout état serveur (une réponse en vol n'a plus d'objet).
      this.cancel();
      this.remoteRows = null; this.remoteFor = ""; this.noRemoteFor = "";
      this.servedRemote = false;
      return this.source.local(request);
    }
    const signature = ListRowEngine.signature(request);
    if (this.remoteRows && this.remoteFor === signature) {
      this.servedRemote = true;
      return this.remoteRows;
    }
    if (this.noRemoteFor !== signature && this.pendingFor !== signature) this.schedule(request, signature);
    this.servedRemote = false;
    return this.source.local(request);   // affichage pendant l'anti-rebond / le vol, et REPLI en cas d'échec
  }

  /** OUBLIE le jeu de lignes SERVEUR en main (régime `rows()`) et annule un tirage éventuellement en vol :
      le prochain `rows()` sur une requête ACTIVE redemandera au serveur, en affichant entre-temps les
      lignes LOCALES (index de recherche fraîchement invalidé par le même filet). JUMEAU de `forgetPage()`
      pour le régime NON paginé.

      🐛 POURQUOI (lot R2) : le jeu serveur est mémoïsé PAR SIGNATURE de requête (collection + saisie +
      cible, cf. `signature`), et une ÉCRITURE ne change pas cette signature. Sans cet oubli, un
      enregistrement CRÉÉ qui matche le filtre actif — « dupliquer » un équipement sous une recherche en
      cours — restait invisible : `rows()` ressortait le jeu serveur d'AVANT la copie, et il fallait vider
      puis re-saisir le filtre (nouvelle signature) pour la voir. La vue l'appelle donc sur `Store.onChange`,
      au même point que `searchIndex.invalidate()` et `forgetPage()`. No-op en mode fichier (jamais de jeu
      serveur en main) : le prochain `rows()` y reste local, le cache ayant déjà la ligne créée. */
  forgetRemote(): void {
    this.cancel();   // coupe un anti-rebond ou une requête en vol : la prochaine sera reprogrammée
    this.remoteRows = null; this.remoteFor = ""; this.noRemoteFor = "";
    this.servedRemote = false;
  }

  /** PAGE SERVEUR à afficher MAINTENANT (garde G4), ou `null` si ce listing n'est PAS paginé par le
      serveur pour cette requête — l'appelant retombe alors sur `rows()`, comportement historique intact.

      Contrat : synchrone comme `rows()`. Si la page demandée n'est pas en main, on la programme (sans
      anti-rebond : un clic de pager n'est pas une frappe) et on rend la DERNIÈRE page reçue — ses
      lignes ET ses compteurs, donc un affichage toujours COHÉRENT (jamais « page 2/45 » avec le contenu
      de la page 1). Faute de page en main, une page VIDE : le cache local ne contient pas la collection,
      il n'y a rien d'autre à montrer (`pageLoading` distingue « en cours » de « réellement vide »). */
  page(request: ListRowRequest, pageRequest: ListRowPageRequest): ListRowPage | null {
    if (!this.source.isServerPaged || !this.source.isServerPaged(request) || !this.source.fetchPage) {
      this.forgetPage();   // sortie du régime paginé (saisie, collection redevenue hydratée) : rien ne survit
      return null;
    }
    const signature = ListRowEngine.pageSignature(request, pageRequest);
    if (this.pageResult && this.pageFor === signature) return this.pageResult;
    if (this.pageFailedFor !== signature && this.pagePendingFor !== signature) this.fetchPageNow(request, pageRequest, signature);
    return this.pageResult || { rows: [], total: 0, page: Math.max(1, pageRequest.page | 0), pages: 1 };
  }

  /** Une page SERVEUR est-elle en vol sans qu'aucune ne soit encore en main ? (la vue affiche alors
      « Chargement… » plutôt que son état vide — un listing vide et un listing pas encore arrivé ne
      disent pas la même chose à l'utilisateur). */
  get pageLoading(): boolean { return this.pagePendingFor !== "" && this.pageResult === null; }

  /** OUBLIE la page en main et annule le tirage en cours : le prochain `page()` repartira du serveur.
      Appelée à la sortie du régime paginé, et par la vue quand le document a MUTÉ (une création ou une
      suppression change la page ET le total — les garder serait afficher un état faux). */
  forgetPage(): void {
    if (this.pageAbort) { this.pageAbort.abort(); this.pageAbort = null; }
    this.pageResult = null; this.pageFor = ""; this.pageFailedFor = ""; this.pagePendingFor = "";
  }

  /** Tire la page demandée : ANNULE la précédente (le pager peut avancer plus vite que le réseau) et
      n'applique la réponse que si elle est encore fraîche. Échec réel → page VIDE assumée + trace
      console (parité `fetch` : jamais d'UI d'erreur), signature mémorisée pour ne pas boucler. */
  private fetchPageNow(request: ListRowRequest, pageRequest: ListRowPageRequest, signature: string): void {
    if (this.pageAbort) this.pageAbort.abort();
    const abort = new AbortController();
    this.pageAbort = abort;
    const generation = this.generation;
    this.pagePendingFor = signature;
    this.source.fetchPage!(request, pageRequest, abort.signal).then((page) => {
      if (generation !== this.generation || abort.signal.aborted) return;
      this.pagePendingFor = ""; this.pageFailedFor = "";
      this.pageResult = page; this.pageFor = signature;
      this.onRemoteRows();
    }).catch((error) => {
      if (generation !== this.generation || abort.signal.aborted) return;
      this.pagePendingFor = ""; this.pageFailedFor = signature;
      // trace de diagnostic volontaire — contrairement à la recherche, il n'existe PAS de repli local
      // ici (la collection n'est pas en cache) : la vue affichera son état vide.
      console.warn("[listing] page serveur indisponible :", error);
      this.onRemoteRows();
    });
  }

  /** Coupe toute activité serveur et oublie la réponse en main (changement d'onglet, destruction). */
  reset(): void {
    this.generation++;
    this.cancel();
    this.remoteRows = null; this.remoteFor = ""; this.noRemoteFor = "";
    this.servedRemote = false;
    this.forgetPage();
  }

  /** (Re)programme l'interrogation serveur — une frappe annule la programmation précédente. */
  private schedule(request: ListRowRequest, signature: string): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.pendingFor = signature;
    this.timer = setTimeout(() => { this.timer = null; this.fetch(request, signature); }, this.debounceMs);
  }

  /** Tire la requête : ANNULE la précédente (AbortController), applique la réponse si elle est encore
      fraîche. Échec réel (réseau, 5xx) → repli LOCAL silencieux + trace console, et la signature est
      marquée en échec pour ne pas boucler. Une annulation n'est PAS un échec (la frappe a avancé). */
  private fetch(request: ListRowRequest, signature: string): void {
    if (this.abort) this.abort.abort();
    const abort = new AbortController();
    this.abort = abort;
    const generation = this.generation;
    const pending = this.source.remote(request, abort.signal);
    // Pas de chemin serveur (mode fichier, critère non traduisible) : le local fait déjà foi. On MÉMORISE
    // la signature comme « traitée » — sans quoi chaque rendu la reprogrammerait pour le même verdict.
    if (!pending) { this.abort = null; this.noRemoteFor = signature; this.pendingFor = ""; return; }
    pending.then((rows) => {
      if (generation !== this.generation || abort.signal.aborted) return;
      this.pendingFor = "";
      this.remoteRows = rows;
      this.remoteFor = signature;
      this.noRemoteFor = "";
      this.onRemoteRows();
    }).catch((error) => {
      if (generation !== this.generation || abort.signal.aborted) return;
      this.pendingFor = "";
      this.noRemoteFor = signature;
      this.remoteRows = null; this.remoteFor = "";
      // trace de diagnostic volontaire — le repli local est ASSUMÉ, aucune UI d'erreur (parité palette).
      console.warn("[listing] serveur indisponible, repli sur les lignes locales :", error);
    });
  }

  private cancel(): void {
    if (this.timer != null) { clearTimeout(this.timer); this.timer = null; }
    if (this.abort) { this.abort.abort(); this.abort = null; }
    this.pendingFor = "";   // plus rien n'est en attente : la prochaine requête active repart d'une page blanche
  }
}
