/* =============================================================================
   EntityPickerSource — la SOURCE DE CANDIDATS SERVEUR-PILOTÉE d'un sélecteur
   d'entité de FORMULAIRE (`ui/EntityPicker.buildAsync`, chantier « picker async »).

   POURQUOI un second régime : `EntityPicker.build` (le régime SYNC, la norme)
   exige la liste d'options EN MÉMOIRE — parfait tant que les options portent une
   RÈGLE MÉTIER (filtre par famille de port, `disabled` nommant l'occupant,
   `keepId`…) calculée sur le corpus hydraté. Mais une collection VOLUMINEUSE ou
   chargée PARESSEUSEMENT (le carnet de contacts en mode API) n'a PAS à être
   hydratée en entier pour alimenter un champ : quand les options n'ont AUCUNE
   règle métier — chaque enregistrement est un candidat, ni filtre ni `disabled` —
   la liste peut venir du SERVEUR à la demande. C'est ce régime-ci : une source
   injectée qui répond aux deux questions du contrôle — « quels candidats pour
   cette saisie ? » et « comment s'appelle la valeur courante ? ».

   DEUX chemins selon la saisie (contrat `EntityPickerCandidates.fetch`) :
   - REQUÊTE VIDE = PARCOURS. C'est LA condition du remplacement d'un `<select>`
     (on doit pouvoir dérouler sans taper, cf. en-tête d'EntityPicker) — et la
     recherche transverse NE SAIT PAS parcourir : une requête vide rend `{}` côté
     serveur (`RelationalRepository.searchAll`) et `TargetSearch.rank("")` rend
     `[]` côté client — un CHOIX de la recherche transverse (jamais d'inondation
     au focus), pas un manque (mesuré, pas déduit). Le parcours passe donc par la
     route de LISTING : collection HYDRATÉE → cache local (`all`, tri alpha sur le
     libellé NORMALISÉ `Schema.normSearch`, borné, surplus compté EXACT) ; sinon
     → `store.list(page 1, pageSize = plafond, tri `sortColumn` asc)` — les lignes
     reçues sont ABSORBÉES au cache par construction (`Store.list`), et le surplus
     est `total - rows.length` (le COUNT de la pagination est exact) ;
   - REQUÊTE NON VIDE = RECHERCHE, déléguée à `EntityCandidateSource` (UNE famille)
     — annulation, repli local et double mode déjà là, AUCUNE logique nouvelle.

   DOUBLE MODE n°15 PAR CONSTRUCTION : `reader` null (mode fichier/visualiseur) =
   recherche 100 % locale (contrat d'EntityCandidateSource) ET parcours local
   (tout y est hydraté par construction) — aucun test de mode nulle part.

   LIMITES ASSUMÉES (documentées, cf. docs/recherche.md § régime async) :
   - la RECHERCHE n'annonce PAS de surplus : le serveur ne rend pas de compte
     (cap `SEARCH_ALL_LIMIT` = 40/collection) — parité avec TOUTES les recherches
     transverses (palette, filtres cible), qui vivent très bien sans ;
   - PARCOURS SANS `sortColumn` : `store.list` part SANS `sort` (ordre serveur
     `created_date`) et la PAGE reçue est re-triée alpha CLIENT — le corpus
     entier, lui, n'est pas ordonné par libellé. Même famille de limite que les
     « tris sans colonne SQL » du régime pagé (docs/recherche.md).

   Le plafond est `OptionSearch.DEFAULT_LIMIT` (50) pour parcours ET recherche :
   parité du contrôle SYNC — un sélecteur d'entité borne son COÛT D'AFFICHAGE,
   pas sa pertinence, et le surplus du parcours est ANNONCÉ, jamais tu.
   ============================================================================= */
import { OptionSearch } from "./OptionSearch";
import type { PickableOption } from "./OptionSearch";
import { EntityCandidateSource } from "./EntityCandidates";
import type { EntityCandidateFamily, EntitySearchReader } from "./EntityCandidates";
import { Schema } from "../../src-shared/Schema";
import { ListOrder } from "../../src-shared/ListOrder";

/** Une fournée de candidats du picker : les options affichables + le surplus TU par le plafond
    (`hidden` > 0 ⇒ le contrôle l'annonce — rangée « + N masqués », jamais un silence). */
export interface EntityPickerBatch {
  options: PickableOption[];
  hidden: number;
}

/** LE CONTRAT que `EntityPicker.buildAsync` consomme — la vue appelante ne connaît que lui, jamais
    la construction de la source (principe n°2 : couplage par paramètres). Requête vide = PARCOURS. */
export interface EntityPickerCandidates {
  /** Anti-rebond que le SearchPop du contrôle doit appliquer : 0 si la source est locale (aucun
      réseau à ménager), sinon le tempo serveur partagé (`EntityCandidateSource.DEBOUNCE_MS`). */
  readonly debounceMs: number;
  /** Candidats de la saisie — vide = PARCOURS (borné, surplus annoncé), sinon RECHERCHE. */
  fetch(query: string): Promise<EntityPickerBatch>;
  /** Libellé SYNCHRONE de la valeur courante depuis le cache — `null` si l'enregistrement n'y est
      pas (le contrôle affiche alors « Chargement… » et passe par `resolveLabel`). */
  labelOf(id: string): string | null;
  /** Résolution ASYNCHRONE du libellé (lecture unitaire, absorbée au cache) — `null` si
      l'enregistrement n'existe pas (supprimé / autre document) : le contrôle applique son repli. */
  resolveLabel(id: string): Promise<string | null>;
}

/** Lecture MINIMALE du Store dont la source a besoin — DÉCOUPLÉE du vrai Store (même recette que
    `CandidateStore` d'EntityCandidates) : le vrai `Store` la satisfait STRUCTURELLEMENT, et le
    harnais Node la remplit d'un store factice. `list` est typé sur ce que la source CONSOMME
    (lignes + total) — pas sur tout ce que le Store sait rendre. */
export interface PickerStore {
  all(collection: string): any[];
  get(collection: string, id: string): any;
  list(collection: string, opts: {
    page: number; pageSize: number; sort?: string; dir?: "asc" | "desc"; signal?: AbortSignal;
  }): Promise<{ rows: any[]; total: number }>;
  fetchOne(collection: string, id: string): Promise<any>;
  hydration: { isHydrated(collection: string): boolean };
}

/** La famille du picker = celle des candidats (`kind`/`collection`/règle de NOMMAGE injectée),
    plus la colonne de TRI du parcours distant. */
export interface CollectionPickerFamily extends EntityCandidateFamily {
  /** Colonne SQL du `ORDER BY` du parcours DISTANT — liste blanche partagée `ListOrder.isSortable`
      (validée défensivement à la construction : invalide = traitée absente + trace console).
      Absente : ordre serveur (`created_date`) + re-tri alpha CLIENT de la page reçue (limite
      documentée en tête de fichier). */
  sortColumn?: string;
}

/** La source STANDARD mono-collection du picker async : parcours par la route de LISTING,
    recherche déléguée à `EntityCandidateSource`, libellés par la règle de nommage injectée. */
export class CollectionPickerSource implements EntityPickerCandidates {
  readonly debounceMs: number;

  /** Recherche transverse (requête non vide) — l'orchestration double mode EXISTANTE, une famille. */
  private readonly candidates: EntityCandidateSource;
  /** Colonne de tri VALIDÉE du parcours distant (null = absente OU refusée par la liste blanche). */
  private readonly sortColumn: string | null;
  /** Requête de PARCOURS en vol — ANNULÉE dès qu'une nouvelle part (même doctrine que la recherche :
      chaque chemin porte SON AbortController, cf. EntityCandidateSource). */
  private abort: AbortController | null = null;

  constructor(
    private readonly store: PickerStore,
    private readonly family: CollectionPickerFamily,
    reader: EntitySearchReader | null,
    private readonly limit: number = OptionSearch.DEFAULT_LIMIT,
  ) {
    // Anti-rebond porté par la SOURCE (le SearchPop du contrôle le consomme) : une source locale
    // répond en mémoire — un délai n'aurait aucune contrepartie (parité `EntityPicker.build`) ;
    // une source serveur ménage le réseau au tempo partagé de toutes les surfaces serveur-pilotées.
    this.debounceMs = reader ? EntityCandidateSource.DEBOUNCE_MS : 0;
    this.candidates = new EntityCandidateSource(store, [family], reader, limit);
    // Validation DÉFENSIVE de la colonne de tri : une colonne hors liste blanche ferait échouer
    // `store.list` BRUYAMMENT à chaque focus (400 serveur / throw ListOrder) — mieux vaut dégrader
    // vers « sans tri » UNE FOIS, tracé, que casser le parcours à chaque ouverture.
    if (family.sortColumn != null && !ListOrder.isSortable(family.collection, family.sortColumn)) {
      console.warn("[picker] colonne de tri hors liste blanche, parcours sans tri serveur : "
        + family.collection + "." + family.sortColumn);
      this.sortColumn = null;
    } else {
      this.sortColumn = family.sortColumn != null ? family.sortColumn : null;
    }
  }

  /** Candidats de la saisie : vide = PARCOURS (route de listing), sinon RECHERCHE (transverse).
      Les candidats sont des options SANS `disabled` — pas de règle métier ici, c'est le point :
      une option hors jeu relève du régime SYNC. */
  async fetch(query: string): Promise<EntityPickerBatch> {
    const trimmed = String(query == null ? "" : query).trim();
    if (trimmed === "") return this.browse();
    // RECHERCHE déléguée (aucune logique nouvelle) ; pas de surplus annoncé — cf. limites en tête.
    const items = await this.candidates.fetch(trimmed);
    return { options: items.map((item) => ({ value: item.id, label: item.label })), hidden: 0 };
  }

  /** Libellé de la valeur courante depuis le CACHE — la règle de nommage injectée, ou null si
      l'enregistrement n'est pas (encore) absorbé. */
  labelOf(id: string): string | null {
    const record = this.store.get(this.family.collection, id);
    return record ? this.family.label(record) : null;
  }

  /** Résolution ASYNC du libellé : lecture unitaire (`fetchOne`, ABSORBÉE au cache — les prochains
      `labelOf` la trouveront en synchrone). Introuvable (404 → null) : null, le contrôle applique
      son repli (`fallbackLabel`). */
  async resolveLabel(id: string): Promise<string | null> {
    const record = await this.store.fetchOne(this.family.collection, id);
    return record ? this.family.label(record) : null;
  }

  /* ------------------------------------------------------------- parcours -- */

  /** PARCOURS (requête vide) : hydraté → cache local ; sinon → route de listing, avec annulation
      de la requête devancée et REPLI local silencieux sur échec RÉEL (parité
      `EntityCandidateSource.fetch` : une ANNULATION n'est PAS un échec — on laisse filer le rejet,
      le StaleGate du SearchPop appelant tranche, retomber sur le local serait un rendu concurrent). */
  private async browse(): Promise<EntityPickerBatch> {
    if (this.store.hydration.isHydrated(this.family.collection)) return this.localBatch();
    if (this.abort) this.abort.abort();
    const abort = new AbortController();
    this.abort = abort;
    // SANS `sortColumn` on n'envoie NI sort NI dir : l'ordre serveur par défaut (`created_date`)
    // s'applique, et la page reçue est re-triée alpha CLIENT ci-dessous (limite documentée).
    const listOptions: { page: number; pageSize: number; sort?: string; dir?: "asc" | "desc"; signal: AbortSignal } =
      { page: 1, pageSize: this.limit, signal: abort.signal };
    if (this.sortColumn) { listOptions.sort = this.sortColumn; listOptions.dir = "asc"; }
    try {
      const result = await this.store.list(this.family.collection, listOptions);
      let options = (result.rows || []).map((record: any) => this.toOption(record));
      if (!this.sortColumn) options = options.sort(CollectionPickerSource.byLabel);
      return { options, hidden: Math.max(0, (result.total || 0) - options.length) };
    } catch (error) {
      if (abort.signal.aborted) throw error;   // requête devancée : le StaleGate tranche, pas de repli concurrent
      console.warn("[picker] parcours serveur indisponible, repli sur le cache local :", error);
      return this.localBatch();
    }
  }

  /** Parcours LOCAL : tout le cache, nommé par la règle injectée, trié alpha sur le libellé
      NORMALISÉ (casse/accents repliés — la même normalisation que la recherche), borné au plafond
      avec surplus compté EXACT. Seul chemin du mode fichier (tout y est `full` par construction),
      et repli du parcours distant. */
  private localBatch(): EntityPickerBatch {
    const options = this.store.all(this.family.collection)
      .map((record: any) => this.toOption(record))
      .sort(CollectionPickerSource.byLabel);
    return { options: options.slice(0, this.limit), hidden: Math.max(0, options.length - this.limit) };
  }

  /** Un enregistrement → une option pickable. Jamais `disabled` (cf. `fetch`). */
  private toOption(record: any): PickableOption {
    return { value: record.id, label: this.family.label(record) };
  }

  /** Ordre alpha des options sur le libellé NORMALISÉ (`Schema.normSearch` : casse et accents
      repliés — « émile » entre « d » et « f », pas après « z »). */
  private static byLabel(a: PickableOption, b: PickableOption): number {
    const left = Schema.normSearch(a.label);
    const right = Schema.normSearch(b.label);
    return left < right ? -1 : left > right ? 1 : 0;
  }
}
