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

   CE QUE VOIT L'UTILISATEUR PENDANT LE VOL : les lignes LOCALES, filtrées avec
   la même assiette (`RecordSearchIndex`). Le listing ne « blanchit » donc jamais
   en tapant, et un serveur en échec ne casse rien — il dégrade vers le local,
   avec une trace console. Deux MÉMOIRES de signature évitent les rendus qui
   « tournent en rond » : l'ABSENCE de jeu serveur (échec réel ou pas de chemin)
   empêche la reprogrammation en boucle de la même requête, et la requête DÉJÀ
   en vol empêche un simple clic de tri de l'annuler pour la relancer à l'identique.

   ⚠ LIMITE ASSUMÉE v1 : le TRI et la pagination restent CLIENT, sur les lignes
   reçues (les accesseurs de tri d'un listing sont des fonctions arbitraires,
   souvent dérivées — il n'y a pas de colonne SQL en face). Le jeu serveur est
   donc PLAFONNÉ par la source ; au-delà, l'utilisateur affine sa recherche.
   Cf. docs/recherche.md § « Listings serveur-pilotés ».
   ============================================================================= */

/** Cible d'un filtre « à recherche » (dimension CIBLE unifiée) : une famille + un identifiant. */
export interface ListRowTarget { kind: string; id: string; }

/** Ce qu'un listing DEMANDE : sa collection, la saisie de recherche, la cible filtrée (ou aucune). */
export interface ListRowRequest {
  collection: string;
  query: string;
  target: ListRowTarget | null;
}

/** Source de lignes — INJECTÉE (principe n°2). Deux chemins, une seule sémantique : les lignes qui
    satisfont la requête. `remote` rend `null` quand cette source n'a pas de serveur (mode fichier) ou
    quand la requête n'est pas serveur-pilotable ; le moteur reste alors sur `local`. */
export interface ListRowSource {
  /** Lignes LOCALES (document hydraté), SYNCHRONES — jamais de réseau. */
  local(request: ListRowRequest): any[];
  /** Lignes SERVEUR de la requête, ou `null` si aucun chemin serveur ne s'applique. */
  remote(request: ListRowRequest, signal: AbortSignal): Promise<any[]> | null;
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

  /** Coupe toute activité serveur et oublie la réponse en main (changement d'onglet, destruction). */
  reset(): void {
    this.generation++;
    this.cancel();
    this.remoteRows = null; this.remoteFor = ""; this.noRemoteFor = "";
    this.servedRemote = false;
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
