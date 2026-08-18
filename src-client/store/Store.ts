import { DataAdapter } from "../data/DataAdapter";
import { FieldIndex } from "../data/FieldIndex";
import { INDEX_SPEC, PAGE_SIZE_DEFAULT, PAGE_SIZE_ALL } from "../data/config";
import { RawRecord, Snapshot, Transaction } from "../data/types";
import { Entity } from "../models/Entity";
import type { CollectionName, EntityOf } from "../models/EntityRegistry";
import { EntityRegistry } from "../models/EntityRegistry";
import { PortType } from "../models/PortType";
import { CableType } from "../models/CableType";
import { Waypoint } from "../models/Waypoint";
import { PortRoles } from "../registries/PortRoles";
import { HydrationState } from "../core/HydrationState";
import { CollectionCountCache } from "../core/CollectionCountCache";
import { CollectionFacetCache } from "../core/CollectionFacetCache";
import { Id } from "../core/Id";
import { Log } from "../core/Log";
import { PatchDiff } from "../core/PatchDiff";
import { Text } from "../core/Text";
import { Locatable } from "../core/Locatable";
import { ContainerLabel } from "../core/ContainerLabel";
import { I18n } from "../i18n/I18n";
import { APP_RELEASE, EQUIP_FACE_IMG_FIELD, CABLE_STATUS_DRAFT, PORT_CONNECTOR_MM, PORT_CONNECTOR_DEFAULT, LOCATIONS, RACK_DEPTH_DEFAULT } from "../domain/constants";
import { Depths } from "../registries/Depths";
import { DEFAULT_PORT_TYPES, DEFAULT_CABLE_TYPES } from "../registries/defaultCatalogs";
import { Cascade, CascadeDelete, CascadeDetach, CascadeTarget } from "./cascadeSpec";
import { DataValidator, PortStrands } from "../../src-shared/DataValidation";
import type { ValidationError, EntityFetcher, ChildFinder } from "../../src-shared/DataValidation";
import { PlacementContainers } from "../../src-shared/PlacementContainers";
import type { PlacementContainer } from "../../src-shared/PlacementContainers";
import { CableRouteAnalyzer as RouteAnalyzerImpl } from "./CableRouteAnalyzer";
import type { RouteError as RouteErrorT, RouteAnalysis as RouteAnalysisT, BundleRouteAnalysis as BundleRouteAnalysisT } from "./CableRouteAnalyzer";

const COLLECTIONS = EntityRegistry.COLLECTIONS;
const ENTITY_CLASSES = EntityRegistry.CLASSES;

/* Grammaire de route de câble : codes/types + AUTOMATE extraits dans `CableRouteAnalyzer` (principe n°2 — le
   Store cumulait CRUD + orchestration + cette logique métier). Ré-exportés ici pour les importeurs historiques. */
export { CableRouteAnalyzer, ROUTE_ROOM_BREAK_CODES, ROUTE_STRUCTURAL_CODES } from "./CableRouteAnalyzer";
export type { RouteError, RouteErrorCode, RouteAnalysis } from "./CableRouteAnalyzer";

/** Disposition de graphe NOMMÉE (positions des nœuds). */
export interface GraphLayout {
  id: string; name: string; positions: Record<string, any>;
  created_date: string; updated_date: string;
}
/** Métadonnées du document (hors entités). */
export interface StoreMeta {
  docName: string;
  theme: string;
  graphLayout: Record<string, any> | null;
  graphLayouts: GraphLayout[];
  activeLayoutId: string | null;
  graphFrames: any[];
  app_release?: string;
  [k: string]: any;
}

/** ASSIETTE DE LECTURE autorisée, vue par le Store (correctif « droits partiels », cf.
    `docs/auth.md` § 10.6). Port INJECTÉ, volontairement réduit à la seule question que le Store se
    pose : « ai-je le droit de lire cette collection ? ». Le Store ne connaît donc ni les permissions,
    ni les rôles, ni `AccessState` — c'est l'hôte (`app/main.ts`) qui traduit, exactement comme il le
    fait déjà pour les vues et les fiches (`FormBase.access`).
    INJECTION NULLE : `null` = tout est lisible. C'est le mode FICHIER et le VISUALISEUR — il n'y a
    ni identité ni frontière de confiance en local (principe n°15), donc pas une ligne du chargement
    n'y change, PAR CONSTRUCTION et non par convention. */
export interface CollectionReadAccess {
  canReadCollection(collection: string): boolean;
}

export interface ListStoreOptions {
  page?: number;
  pageSize?: number;
  query?: string;
  where?: Record<string, any> | null;
  /** Filtre non sérialisable (résolu côté client sur le cache). */
  filter?: ((o: any) => boolean) | null;
  /** Champs de recherche explicites (sinon toutes les valeurs sérialisées). */
  searchFields?: any[] | null;
  /** TRI SERVEUR du régime pagé (pagination ordonnée complète) — transmis à l'adaptateur tel quel :
      champ de la liste blanche partagée `ListOrder` + direction (cf. `data/types.ts ListOptions`). */
  sort?: string | null;
  dir?: "asc" | "desc" | null;
  /** ANNULATION de la requête (listings serveur-pilotés) — transmise à l'adaptateur. */
  signal?: AbortSignal;
}

/* =============================================================================
   STORE — orchestre les collections + l'adapter.
   API CRUD générique async + opérations métier (clone avec cascade, suppression
   avec cascade, compatibilité câble/port). Sert le CACHE hydraté en synchrone
   (requis par le rendu) ; les lectures « fraîches » passent par l'adapter.
   ============================================================================= */
export class Store {
  adapter: DataAdapter;
  data: Record<string, any[]>;
  meta: StoreMeta;
  restored?: boolean;
  /** ÉTAT D'HYDRATATION par collection (chantier lazy-load — cf. docs/hydratation.md).
      `data[c] = []` ne distingue pas « vide » de « non chargée » : cet état porte la vérité manquante.
      Le consomment : G1 (anti-snapshot), G2 (hydrateAll avant export), G3 (SSE), G4 (bascule du pager
      serveur d'un listing, via `StoreListRowSource`) et G6 (compteurs, ci-dessous). C'est LUI qu'on
      interroge, jamais une liste de noms « lazy » : une collection lazy peut être redevenue `full`.
      Injecté par l'hôte (main.ts) : état TRAÇANT en mode API ; null en mode fichier/visualiseur →
      état INERTE « tout full, par construction » (principe n°15, injection nulle). */
  readonly hydration: HydrationState;
  /** Point d'ACCROCHE G3 : des collections NON hydratées ont été SAUTÉES par un rechargement SSE
      (`reloadCollections`) — leurs enregistrements en cache peuvent être périmés. Le Store a déjà
      invalidé SES dérivés (les compteurs G6) ; ce rappel laisse l'hôte rafraîchir les SIENS (main.ts y
      redemande un rendu des pastilles d'onglet). */
  onLazyReloadDeferred: ((collections: string[]) => void) | null = null;
  /** Collections à charger PARESSEUSEMENT (vague 1 du chantier : `contacts`) — injectées par l'hôte
      (`main.ts`, cf. `core/LazyCollections`). Le Store les RE-DÉCLARE après chaque hydratation complète
      (`init`), parce que `_hydrate` re-marque tout `full` : c'est le contrat du lot 0. Vide en mode
      fichier/visualiseur PAR CONSTRUCTION (cf. constructeur). */
  private readonly lazyCollections: readonly string[];
  /** ASSIETTE DE LECTURE autorisée (auth/ACL) — injectée par l'hôte, `null` = tout lisible (mode
      fichier/visualiseur : injection nulle, cf. `CollectionReadAccess`). Lue à chaque `init()`, donc
      sur les droits COURANTS du document qu'on ouvre. */
  private readonly readAccess: CollectionReadAccess | null;
  /** COMPTES de collection relevés en ASYNC et mémoïsés (garde G6) — cf. `countOf`/`countHint`. */
  private readonly _counts: CollectionCountCache;
  /** Notifié quand un COMPTE relevé en async vient d'arriver : l'hôte repeint ce qui l'affiche
      (pastilles d'onglet). Sans lui, la valeur entrerait au cache sans que rien ne la peigne. */
  onCountResolved: ((collection: string, count: number) => void) | null = null;
  /** VALEURS DE FACETTE relevées en ASYNC et mémoïsées (garde G8, vague 3) — cf. `facetValues`. */
  private readonly _facets: CollectionFacetCache;
  /** Notifié quand des valeurs de FACETTE viennent d'arriver : l'hôte repeint la barre de filtres du
      listing concerné (`ListView.refreshFacetOptions`). Même rôle que `onCountResolved` pour les pastilles. */
  onFacetResolved: ((collection: string, field: string) => void) | null = null;
  private _idIndex: Record<string, Map<string, any>>;
  private _fk: Record<string, FieldIndex>;
  private _listeners: Array<() => void>;
  /** Cache de DÉDUCTION RÉSEAU par COMPOSANTE PURE : port id → { ids, primary, primaryPort } (le MÊME objet est
      partagé par tous les ports d'une composante). `primaryPort` = port assertant d'id minimal (fixe le principal
      déterministe et permet d'unionner plusieurs composantes dans l'aperçu). Vidé à chaque mutation (_emit) ET à
      tout ré-index (_reindexCollection : rechargement SSE/complet). Rend cableNetworkIds/cablePrimaryNetworkId O(1)
      après le 1er calcul — critique car appelés par câble ET par port sur les chemins chauds (rendu 3D, SVG, listes).
      INVARIANT (N3) : une entrée = une composante PURE (BFS mono-graine). L'union multi-graines (aperçu d'un câble
      pas encore créé) N'est PAS mémoïsée — sinon elle polluerait chaque composante avec le réseau de l'autre. */
  private _netCache = new Map<string, { ids: string[]; primary: string | null; primaryPort: string | null }>();

  constructor(adapter: DataAdapter, hydration: HydrationState | null = null, lazyCollections: readonly string[] = [], readAccess: CollectionReadAccess | null = null) {
    this.adapter = adapter;
    // Assiette de lecture : `null` = tout lisible. Aucune garde de mode ici non plus — le mode
    // fichier n'injecte simplement rien (cf. `CollectionReadAccess`).
    this.readAccess = readAccess;
    // Injection NULLE (forme du projet, cf. main.ts) : sans état injecté, l'état INERTE — mode fichier et
    // visualiseur restent « tout full » PAR CONSTRUCTION, aucun `if (mode)` ici ni ailleurs.
    this.hydration = hydration || HydrationState.alwaysFull();
    // MÊME construction pour la liste lazy : sans état TRAÇANT injecté, AUCUNE collection n'est lazy —
    // quoi que l'appelant passe. Le mode fichier/visualiseur ne peut donc pas sauter une collection au
    // chargement, et l'hôte n'a qu'UN test de mode à écrire (celui de l'état), pas deux.
    this.lazyCollections = hydration ? [...lazyCollections] : [];
    this.hydration.declareLazy(this.lazyCollections);
    // COMPTES async mémoïsés (G6) : le relevé est le `count` de l'adaptateur (un `list(pageSize:1).total`,
    // donc un COUNT(*) côté serveur) ; l'arrivée d'une valeur remonte à l'hôte via `onCountResolved`.
    this._counts = new CollectionCountCache(
      (collection) => this.adapter.count(collection, null),
      (collection, count) => this.onCountResolved?.(collection, count),
    );
    // FACETTES async mémoïsées (G8) : le relevé est le `SELECT DISTINCT` de l'adaptateur (`null` en
    // mode fichier — le chemin n'y est de toute façon jamais emprunté, tout y est `full`).
    this._facets = new CollectionFacetCache(
      (collection, field) => this.adapter.facetValues(collection, field).then((values) => values || []),
      (collection, field) => this.onFacetResolved?.(collection, field),
    );
    this.data = {};
    COLLECTIONS.forEach((c) => { this.data[c] = []; });
    this.meta = { docName: "", theme: "dark", graphLayout: null, graphLayouts: [], activeLayoutId: null, graphFrames: [] };
    this._idIndex = {};
    this._fk = {};
    this._listeners = [];
  }

  onChange(fn: () => void): void { this._listeners.push(fn); }
  private _emit(): void { this._netCache.clear(); this._listeners.forEach((fn) => { try { fn(); } catch (e) { console.warn(e); } }); }

  /* ---- COMPTES de collection (garde G6, cf. docs/hydratation.md) ----
     `store.all(c).length` MENT dès qu'une collection est chargée paresseusement : il ne compte que ce
     qui a été absorbé. Les surfaces qui affichent un TOTAL (pastilles d'onglet) passent donc par ici. */

  /** Compte EXACT d'une collection. Collection HYDRATÉE : le cache local fait foi — résolu sans le
      moindre aller-retour (zéro régression pour les 20+ collections non lazy). Collection partielle :
      `COUNT(*)` serveur, MÉMOÏSÉ (les demandes concurrentes partagent une seule requête) jusqu'à la
      prochaine invalidation (écriture locale, rechargement, SSE sauté par G3). */
  async countOf(collection: string): Promise<number> {
    if (this.hydration.isForbidden(collection)) return 0;   // interdite : 0 SANS requête (cf. countHint)
    if (this.hydration.isHydrated(collection)) return this.data[collection] ? this.data[collection].length : 0;
    return this._counts.request(collection);
  }

  /** Compte à AFFICHER MAINTENANT — SYNCHRONE, parce que les pastilles du Shell le sont. Collection
      hydratée : la longueur locale, exacte. Collection partielle : la dernière valeur connue, ou 0 en
      attendant — et le relevé serveur est DÉCLENCHÉ (au plus un en vol), son arrivée passant par
      `onCountResolved` pour que l'hôte repeigne. C'est le patron du badge « Interventions », rendu
      générique : une valeur asservie au réseau, servie sans faire attendre le rendu. */
  countHint(collection: string): number {
    // 🚨 SYMPTÔME S2 du correctif « droits partiels », et sa correction. Ce compteur est l'accesseur des
    // PASTILLES d'onglet, et `refreshCounts()` les repeint TOUTES — y compris celles des onglets MASQUÉS,
    // qui n'ont pourtant aucun spectateur. Sur une collection interdite, chaque repeinte partait donc en
    // `COUNT(*)` serveur → 403 → toast « droit manquant (wifi:read) » ; un échec n'étant (à raison) pas
    // mémoïsé, le relevé repartait à la repeinte suivante. Mesuré AVANT correctif : 257 requêtes 403 en
    // 9 s de navigation nominale. La pastille d'un onglet qu'on ne voit pas vaut 0, et ne coûte rien.
    if (this.hydration.isForbidden(collection)) return 0;
    if (this.hydration.isHydrated(collection)) return this.data[collection] ? this.data[collection].length : 0;
    return this._counts.value(collection);
  }

  /** Invalide les compteurs de ces collections (le prochain accès les relèvera). Appelée en interne à
      chaque mutation/rechargement ; publique pour l'hôte, qui la câble sur le point d'accroche G3
      (`onLazyReloadDeferred` : une collection SAUTÉE peut avoir changé chez un autre client — son
      compte est le SEUL dérivé qu'on puisse rafraîchir à bas coût). */
  invalidateCounts(collections: readonly string[]): void { this._counts.invalidate(collections); }

  /* ---- FACETTES de listing (garde G8, cf. docs/hydratation.md § « Vague 3 ») ----
     Les options d'un filtre d'énumération se calculent en balayant `store.all(c)` — qui, sur une
     collection paresseuse, ne contient que les pages parcourues. Les listings passent donc par ici. */

  /** Valeurs DISTINCTES non vides d'un champ SCALAIRE — SYNCHRONE, parce que les options de filtre
      le sont (`ListColumn.filter.options()`). Deux régimes, et c'est l'ÉTAT d'hydratation qui tranche
      (jamais un nom de collection) :
      - collection HYDRATÉE : balayage du CACHE, exact et sans le moindre aller-retour. C'est aussi,
        PAR CONSTRUCTION, le seul chemin du mode fichier et du visualiseur (principe n°15) ;
      - collection partielle : les dernières valeurs connues du `SELECT DISTINCT` serveur — une liste
        VIDE en attendant, le relevé étant DÉCLENCHÉ (au plus un en vol), son arrivée passant par
        `onFacetResolved` pour que l'hôte repeigne. Patron STRICTEMENT identique à `countHint` (G6).
      ⚠ Le champ doit être une colonne SCALAIRE du modèle : une facette dont la valeur d'affichage est
      RÉSOLUE par jointure cliente (le nom d'un équipement…) n'a pas de champ en face — son listing ne
      déclare alors pas de `field` et garde ses options locales (repli documenté, cf. `ListColumn`).
      ⚠ Le chemin des LISTINGS court-circuite la première branche en amont (`StoreListRowSource.facetOptions`
      rend `null` sur une collection hydratée, pour que la vue garde ses options locales — qui passent, elles,
      par le `valueOf` de la colonne, parfois différent du champ brut). Cette branche n'en est pas moins le
      contrat : tout appelant obtient une réponse JUSTE dans les deux modes, sans écrire de test de mode. */
  facetValues(collection: string, field: string): string[] {
    // Interdite : aucune option, et surtout aucun `SELECT DISTINCT` (403). Le listing qui les afficherait
    // n'existe pas — son onglet est masqué —, mais la garde vit ICI, au point commun, et non chez lui.
    if (this.hydration.isForbidden(collection)) return [];
    if (this.hydration.isHydrated(collection)) {
      const rows = this.data[collection] || [];
      return CollectionFacetCache.normalize(rows.map((o: any) => String(o[field] == null ? "" : o[field])));
    }
    return this._facets.values(collection, field);
  }

  /** Invalide les valeurs de facette de ces collections (le prochain accès les relèvera). Appelée en
      interne à chaque mutation/rechargement ; publique pour l'hôte, par parité avec `invalidateCounts`.
      ⚠ Invalidée par les MISES À JOUR aussi, contrairement aux compteurs : un total ne bouge pas quand
      on édite un enregistrement, une valeur de colonne si. */
  invalidateFacets(collections: readonly string[]): void { this._facets.invalidate(collections); }

  /* ---- (dé)sérialisation ---- */
  toJSON(): Snapshot {
    const out: Snapshot = { meta: Object.assign({}, this.meta, { app_release: APP_RELEASE }) };
    COLLECTIONS.forEach((c) => { out[c] = this.data[c].map((o) => (o.toJSON ? o.toJSON() : o)); });
    return out;
  }
  private _hydrate(raw: Snapshot | null): void {
    COLLECTIONS.forEach((c) => { this.data[c] = []; });
    if (raw && typeof raw === "object") {
      if (raw.meta) this.meta = Object.assign({ docName: "", theme: "dark", graphLayout: null, graphLayouts: [], activeLayoutId: null, graphFrames: [] }, raw.meta);
      this._migrateLayouts();
      COLLECTIONS.forEach((c) => {
        const Cls = ENTITY_CLASSES[c];
        (Array.isArray(raw[c]) ? raw[c] : []).forEach((o: RawRecord) => this.data[c].push(new Cls(o)));
      });
    }
    this._ensureSites();
    this._migrateDepths();
    this._reindex();
    // Un _hydrate absorbe un instantané COMPLET du document (init, import/replaceAll, newDocument,
    // undo/redo) : quel qu'ait été l'état précédent, le cache reflète désormais TOUT le document → tout
    // redevient full. ⚠ CONTRAT du lazy-load : une ouverture qui NE charge PAS tout doit re-déclarer ses
    // collections lazy APRÈS ce point — c'est ce que fait `init()`, chemin UNIQUE de toute ouverture /
    // rechargement complet en mode API (cf. docs/hydratation.md § Transitions). `replaceAll` (import) et
    // `newDocument`, eux, ne re-déclarent RIEN : leur cache contient VRAIMENT tout le document.
    this.hydration.markAllFull();
    this._counts.invalidateAll();   // remplacement total du cache : tout compte relevé est périmé
    this._facets.invalidateAll();   // … et toute valeur de facette relevée avec lui (G8)
  }
  /** MIGRATION one-shot (EN MÉMOIRE) : profondeur d'équipement enum legacy (full/half/quarter) → mm.
      Référence = cage de SA baie s'il est racké, cage de la baie par défaut sinon (mêmes fractions que
      l'ancien rendu → aucun changement visuel ni d'occupation ; locks_u déjà cohérent à la construction).
      Comme _ensureSites : synchrone, persistance au prochain save (mode fichier = snapshot complet ;
      mode API = à la prochaine édition de l'enregistrement — pas de rafale d'écritures au chargement). */
  private _migrateDepths(): void {
    const racks = new Map<string, any>(this.data.racks.map((r: any) => [r.id, r]));
    this.data.equipments.forEach((e: any) => {
      if (e.depth_mm != null) return;   // déjà en mm (ou déjà migré)
      const rack = e.rack_id ? racks.get(e.rack_id) : null;
      // cage de référence — même formule que RackGeometry.cageDepth (import évité : couche données)
      const outer = rack ? (rack.depth || RACK_DEPTH_DEFAULT) : RACK_DEPTH_DEFAULT;
      const cage = (rack && rack.cage_depth_mm > 0) ? Math.min(outer, rack.cage_depth_mm | 0) : outer;
      e.depth_mm = Depths.legacyToMm(e.depth, cage);
    });
  }
  /** MIGRATION de tout `location` référencé qui n'a pas encore d'entité site (docs ≤ avant l'entité Site) → crée le
      site manquant (libellé de repli LOCATIONS si l'id est un ancien slug connu, sinon l'id). Un document vierge
      NE reçoit PLUS de sites par défaut (retiré à la demande) : il démarre sans site, l'utilisateur crée les siens.
      Synchrone (en mémoire) — la persistance suit au prochain save. */
  private _ensureSites(): void {
    const have = new Set(this.data.sites.map((s: any) => s.id));
    const Cls = ENTITY_CLASSES.sites;
    const add = (id: string, name?: string) => { if (id && !have.has(id)) { this.data.sites.push(new Cls({ id, name: name || id })); have.add(id); } };
    const lbl = (id: string) => { const l = LOCATIONS.find((x) => x.id === id); return l ? l.label : id; };
    ["datacenters", "racks", "equipments", "floors", "waypoints"].forEach((coll) => this.data[coll].forEach((o: any) => { if (o.location) add(o.location, lbl(o.location)); }));
  }
  /* Migration → dispositions NOMMÉES. L'ancien meta.graphLayout (objet unique)
     devient une entrée de meta.graphLayouts ; meta.activeLayoutId la désigne.
     meta.graphLayout reste le MIROIR de la disposition active (compat. descendante). */
  private _migrateLayouts(): void {
    const m = this.meta;
    if (!Array.isArray(m.graphLayouts)) m.graphLayouts = [];
    if (typeof m.activeLayoutId === "undefined") m.activeLayoutId = null;
    if (!m.graphLayouts.length && m.graphLayout && typeof m.graphLayout === "object" && Object.keys(m.graphLayout).length) {
      const id = Id.uid();
      m.graphLayouts.push({ id, name: "Disposition", positions: m.graphLayout, created_date: Id.nowIso(), updated_date: Id.nowIso() });
      m.activeLayoutId = id;
    }
    if (m.activeLayoutId && !m.graphLayouts.some((l) => l.id === m.activeLayoutId)) m.activeLayoutId = null;
    const active = m.graphLayouts.find((l) => l.id === m.activeLayoutId);
    m.graphLayout = active ? active.positions : null;
  }
  private _reindex(): void {
    COLLECTIONS.forEach((c) => this._reindexCollection(c));
  }
  /** (Re)construit les index (id + secondaires) d'UNE collection à partir de `data[c]`. */
  private _reindexCollection(c: string): void {
    // Le cache de déduction réseau est indexé par port et reflète l'état ports/câbles/faisceaux. TOUT remplacement de
    // données passe par ici — y compris le rechargement granulaire SSE (`reloadCollections`) et complet (`_hydrate`,
    // via `_reindex`) qui NE passent PAS par `_emit`. On l'invalide donc au chokepoint des index : sans ça, en mode
    // API multi-clients, un changement fait par un AUTRE client laisserait couleurs/tooltips/légendes périmés
    // jusqu'à une mutation locale (cache jamais vidé sur ce chemin). Vidage large mais sûr (« reconstruction inutile
    // plutôt qu'affichage faux ») : le cache se repeuple au 1er lookup suivant.
    this._netCache.clear();
    const m = new Map<string, any>();
    const fk = new FieldIndex(INDEX_SPEC[c] || []);
    this.data[c].forEach((o) => { m.set(o.id, o); fk.add(o); });
    this._idIndex[c] = m;
    this._fk[c] = fk;
  }

  /* ---- maintenance incrémentale des index (création/maj unitaires) ---- */
  private _indexAdd(collection: string, obj: any): void {
    this._idIndex[collection].set(obj.id, obj);
    if (this._fk[collection]) this._fk[collection].add(obj);
  }
  /* Applique `mutate(obj)` en gardant les index secondaires cohérents :
     désindexe AVANT mutation, ré-indexe après. */
  private _withReindex(collection: string, obj: any, mutate: (o: any) => void): void {
    const fk = this._fk[collection];
    if (fk) fk.remove(obj);
    mutate(obj);
    if (fk) fk.add(obj);
  }
  /* Entités telles que champ == valeur, via index secondaire (repli en scan si
     le champ n'est pas dans INDEX_SPEC). valeur null = « non rattaché ». */
  _byFk(collection: string, field: string, value: any): any[] {
    const fk = this._fk[collection];
    if (fk && fk.has(field)) {
      const m = this._idIndex[collection];
      return fk.ids(field, value).map((id) => m.get(id)).filter(Boolean);
    }
    return this.data[collection].filter((o) => FieldIndex.valueMatches(o[field], value));
  }

  /** 🚨 Collections que l'utilisateur COURANT n'a PAS le droit de lire (correctif « droits partiels »,
      cf. docs/auth.md § 10.6). Sans assiette injectée (mode fichier/visualiseur), la liste est VIDE
      par construction : le chargement local ne change pas d'une requête. */
  private _forbiddenCollections(): string[] {
    if (!this.readAccess) return [];
    const access = this.readAccess;
    return COLLECTIONS.filter((c) => !access.canReadCollection(c));
  }

  /* ---- init : charge depuis l'adapter. NE sème PAS si vide. ---- */
  async init(): Promise<this> {
    // Les collections LAZY ne sont PAS tirées par le chargement initial (mode API) : l'adaptateur les
    // saute, ce qui est tout le gain du chantier. La liste part d'ici — le Store est le seul à connaître
    // sa politique d'hydratation, l'adaptateur ne fait qu'obéir (et l'adaptateur FICHIER l'ignore : il
    // n'y a pas de « collection » à sauter dans un document qui EST un fichier).
    // 🚨 S'Y AJOUTENT LES COLLECTIONS INTERDITES (correctif « droits partiels »). Le chargement tirait
    // TOUTE collection non-lazy sans regarder les droits : un `dc-viewer` sans `vm:read` prenait un 403
    // sur `GET /vms`, le `Promise.all` de `RestAdapter.load` rejetait, et c'est le document ENTIER qui
    // ne se chargeait pas (symptôme S1 — l'app s'ouvrait vide). L'assiette de chargement est donc
    // INTERSECTÉE avec le lisible, ICI, au point COMMUN de toute ouverture : aucune requête n'est même
    // émise pour une collection interdite — strictement la même doctrine que l'assiette de la recherche
    // transverse côté serveur (docs/auth.md § 8.3), qui ne post-filtre pas non plus.
    const forbidden = this._forbiddenCollections();
    const skipCollections = [...new Set([...this.lazyCollections, ...forbidden])];
    const raw = await this.adapter.load({ skipCollections });
    if (raw) {
      this._hydrate(raw);
      // 🚨 CONTRAT du lot 0 : `_hydrate` vient de re-marquer TOUT `full`. Comme le chargement a SAUTÉ
      // les collections lazy, on les re-déclare ICI, immédiatement après — avant la moindre lecture.
      // `init()` est le chemin UNIQUE de toute ouverture ou rechargement COMPLET (boot, ouverture d'un
      // document serveur, rechargement total après un 409/400, changement de document) : centraliser la
      // re-déclaration ici, plutôt que sur chacun de ces appelants, rend structurellement impossible
      // d'en oublier un (cf. docs/hydratation.md § « Vague 1 — contacts »).
      this.hydration.declareLazy(this.lazyCollections);
      // … et les INTERDITES, dans la foulée et APRÈS les lazy (`forbidden` prime, cf. `declareLazy`).
      // Leur cache est vide, mais ce vide-là n'est PAS « la collection est vide » : G1 doit continuer de
      // refuser tout snapshot dérivé de ce corpus, et rien ne doit jamais tenter de les charger.
      this.hydration.declareForbidden(forbidden);
      this.restored = true;
      // Réconcilie les catalogues (types de port/câble — le CODE est la source de vérité) sur le document CHARGÉ,
      // pas seulement sur un document neuf : sinon les entrées AJOUTÉES au code n'apparaissent jamais dans un
      // document existant (selects sans la nouveauté) et, en mode API, une référence à un type neuf échouerait
      // (`ref_missing` côté serveur, car il n'y serait pas persisté). Persiste UNIQUEMENT si quelque chose a changé
      // → écriture one-shot après une mise à jour du catalogue, no-op ensuite (upsert idempotent).
      if (this.syncCatalogs()) {
        // 🚨 SÉMANTIQUE RETENUE (vague 1) pour le chemin le plus sournois du chantier. Ce `_persistAll` est
        // un `PUT /snapshot` : dérivé d'un cache où une collection lazy manque, il EFFACERAIT côté serveur
        // ce qui n'est pas en mémoire — c'est exactement ce que G1 refuse (bruyamment). On HYDRATE donc
        // d'abord, comme pour l'export (arbitrage n°3, même mécanique `hydrateAll`) plutôt que d'inventer
        // une écriture partielle des catalogues : aucune logique nouvelle, aucune divergence possible avec
        // ce que la cascade/le remap ont pu toucher. Le coût est RARE (la réconciliation n'écrit que
        // lorsque le catalogue du CODE a bougé depuis la dernière ouverture de CE document) et non
        // récurrent (l'upsert est idempotent : le boot suivant ne réécrit plus). CONSÉQUENCE ASSUMÉE : ce
        // boot-là se termine avec un corpus intégralement hydraté — on ne re-déclare donc RIEN ensuite,
        // l'état DIT la vérité (tout est en cache) et le lazy reprend au boot suivant.
        await this.hydrateAll();
        // 🚨 DROITS PARTIELS — `hydrateAll` ne peut plus, par construction, rendre le corpus complet
        // quand une collection est INTERDITE : la pousser en snapshot l'EFFACERAIT côté serveur, et
        // c'est exactement ce que G1 refuse. Ici on ne veut pas d'un refus BRUYANT : `init()` est le
        // chemin d'OUVERTURE du document, une exception y tue tout le chargement (symptôme S3 mesuré —
        // le boot mourait sur `GET /wifiClients` dès que le catalogue du code avait bougé, et comme le
        // snapshot n'était jamais écrit, il remourait à CHAQUE F5). On teste donc la MÊME condition que
        // G1 au lieu de la subir, et on renonce simplement à persister : la réconciliation reste EN
        // MÉMOIRE (les selects de la session sont justes), rien n'est perdu — le catalogue du code est
        // ré-appliqué à chaque ouverture, et un utilisateur qui peut tout lire la persistera pour tous.
        if (this.hydration.isFullyHydrated()) await this._persistAll();
        else Log.d("store", "catalogues réconciliés EN MÉMOIRE seulement : corpus incomplet (collections interdites)", this.hydration.forbiddenCollections());
      }
    }
    else { this._hydrate(null); this.restored = false; }
    return this;
  }

  /* ---- rechargement GRANULAIRE (P2 : changement externe ciblé en mode API) ----
     Re-tire de l'adapter UNIQUEMENT les collections indiquées (au lieu d'un `init()` complet),
     remplace leurs entités et ré-indexe CES collections seulement. Bien moins coûteux qu'un
     rechargement total quand un autre client n'a touché qu'une poignée de collections.
     Pilotée par `ReloadPlanner.plan().refetchCollections`. */
  async reloadCollections(collections: string[]): Promise<string[]> {
    const targets = (collections || []).filter((c, i, a) => COLLECTIONS.indexOf(c) !== -1 && a.indexOf(c) === i);
    // G3 (docs/hydratation.md) : ne re-tirer QUE les collections HYDRATÉES. Re-tirer EN ENTIER une
    // collection lazy (`none`/`partial`) au premier événement SSE d'un autre client annulerait tout le
    // bénéfice du chargement paresseux. Les collections sautées passent par le point d'accroche
    // `onLazyReloadDeferred` (invalidation des caches dérivés — compteurs au lot 1) et sont tracées.
    const { refetch, deferred } = this.hydration.splitReload(targets);
    if (deferred.length) {
      Log.d("store", "reloadCollections : collections non hydratées SAUTÉES (G3)", deferred);
      // Le SEUL dérivé qu'on puisse rafraîchir à bas coût sur une collection SAUTÉE : son COMPTE (G6).
      // Un autre client a pu en créer ou en supprimer — la pastille d'onglet mentirait jusqu'à la
      // prochaine écriture locale. Invalidé ICI (le Store possède ce cache) ; le point d'accroche, lui,
      // reste offert à l'hôte pour SES dérivés (repeindre les pastilles, jeter une facette…).
      this._counts.invalidate(deferred);
      // … et ses VALEURS DE FACETTE (G8, vague 3) : une passe de synchro wifi chez le serveur peut
      // introduire un SSID ou un type de raccordement inédit. Second dérivé à bas coût — un relevé
      // `SELECT DISTINCT` au prochain rendu du listing, pas un rechargement de collection.
      this._facets.invalidate(deferred);
      this.onLazyReloadDeferred?.(deferred);
    }
    if (!refetch.length) return [];
    await this._refetchWhole(refetch);
    this.restored = true;
    return refetch;
  }

  /** Re-tire de l'adapter le CONTENU COMPLET des collections indiquées (une page PAGE_SIZE_ALL chacune,
      en parallèle : I/O réseau indépendantes), remplace leurs entités, ré-indexe et marque `full`.
      Chemin UNIQUE du rechargement granulaire (`reloadCollections`) et de l'hydratation totale
      (`hydrateAll`) — le corps était identique, le dupliquer les aurait laissés diverger (principe n°3). */
  private async _refetchWhole(collections: string[]): Promise<void> {
    await Promise.all(collections.map(async (c) => {
      const res = await this.adapter.list(c, { pageSize: PAGE_SIZE_ALL });
      const Cls = ENTITY_CLASSES[c];
      this.data[c] = (res.rows || []).map((o: RawRecord) => new Cls(o));
    }));
    if (collections.includes("equipments")) this._migrateDepths();   // re-migrer les profondeurs legacy
    collections.forEach((c) => {
      this._reindexCollection(c);      // index reconstruits pour les seules collections rechargées
      this.hydration.markFull(c);      // le cache contient désormais TOUTE la collection (vérité d'état)
    });
    // La collection redevient hydratée : son compte redevient LOCAL et exact — le relevé serveur mémoïsé
    // n'a plus lieu d'être (et serait périmé s'il datait d'avant ce re-tirage). Idem pour ses facettes,
    // désormais calculées sur le cache complet (G8).
    this._counts.invalidate(collections);
    this._facets.invalidate(collections);
  }

  /** HYDRATATION À LA DEMANDE (vague 1) : recharge EN ENTIER les collections indiquées qui ne sont pas
      déjà `full`. No-op sur les hydratées, et en mode fichier/visualiseur PAR CONSTRUCTION (tout y est
      `full`) — l'appelant n'a donc aucun test de mode à écrire.

      C'est le PATRON des surfaces qui ont besoin de la liste COMPLÈTE d'une collection lazy et ne
      peuvent pas se contenter d'une page : un `<select>` de contacts, un formulaire qui résout des
      libellés par identifiant. Le gain du chargement paresseux est au BOOT ; une surface qui a
      RÉELLEMENT besoin du tout le charge à son ouverture, une fois, et retrouve alors le régime local
      (l'état passe à `full` : listing, compteur et gardes suivent sans autre changement).

      Renvoie les collections effectivement rechargées (trace / tests). Un échec réseau REJETTE : mieux
      vaut une modale qui ne s'ouvre pas qu'un select silencieusement amputé. */
  async hydrate(collections: readonly string[]): Promise<string[]> {
    // 🚨 Les collections INTERDITES sont écartées ICI, au point d'entrée COMMUN de toute hydratation
    // (à la demande comme totale) : les demander ne rendrait pas un corpus plus complet, seulement un
    // 403 — et, l'appelant ne s'y attendant pas, une modale qui ne s'ouvre pas ou un boot qui meurt.
    const missing = collections.filter((c, i, a) => COLLECTIONS.indexOf(c) !== -1 && a.indexOf(c) === i && !this.hydration.isHydrated(c) && !this.hydration.isForbidden(c));
    if (!missing.length) return [];
    Log.d("store", "hydrate : hydratation à la demande", missing);
    await this._refetchWhole(missing);
    return missing;
  }

  /** G2 — hydrate TOUT le corpus : recharge EN ENTIER les collections non `full` avant une opération qui
      exige le document COMPLET. DEUX appelants : les exports (JSON autonome, visualiseur HTML — cf.
      FileDocuments) et la RÉCONCILIATION DES CATALOGUES du boot (`init` : son snapshot serait sinon
      amputé, cf. G1). Arbitrage acté (2026-08-12, n°3) : on HYDRATE plutôt que de refuser ou de tronquer
      silencieusement. No-op quand tout est déjà full (mode fichier : TOUJOURS, aucun coût nouveau) ; en
      corpus lazy, c'est le prix assumé d'un document complet. Un échec réseau REJETTE (l'opération n'a
      pas lieu — jamais un fichier tronqué). Renvoie les collections rechargées (trace/tests). */
  async hydrateAll(): Promise<string[]> {
    // `hydratableCollections` et non `notFullCollections` : les INTERDITES sont non-full mais ne se
    // rechargent pas (403). Conséquence ASSUMÉE et documentée : sous droits partiels, « hydrater tout »
    // ne rend PAS le corpus complet — c'est pourquoi les EXPORTS sont MASQUÉS dans ce cas
    // (`AccessState.hasFullDocumentRead`, docs/auth.md § 10.6) plutôt que d'exporter un document amputé.
    const missing = this.hydration.hydratableCollections();
    if (!missing.length) return [];
    Log.d("store", "hydrateAll : hydratation complète (G2 export / réconciliation des catalogues)", missing);
    // DÉLÉGUÉ à l'hydratation ciblée : « tout hydrater » n'est que « hydrater la liste des non-full »
    // (principe n°3 — deux corps identiques auraient divergé au premier ajustement).
    return this.hydrate(missing);
  }

  /* Recharge la MÉTA du document (nom, dispositions, thème…) depuis l'adapter, sans toucher aux entités.
     Utilisé par le rechargement granulaire quand seul `meta` a changé (cf. ReloadPlan.refreshMeta). */
  async reloadMeta(): Promise<void> {
    const meta = await this.adapter.loadMeta();
    if (meta && typeof meta === "object") {
      this.meta = Object.assign(this.meta, meta);
      this._migrateLayouts();
    }
  }
  /* No-op : la migration des images legacy se fait ailleurs (les images de façade
     ne sont plus une collection du modèle). */
  migrateFaceImages(): boolean { return false; }

  /* Réconcilie portTypes/cableTypes sur les catalogues CODE (clé = id stable).
     Crée le manquant, met à jour les champs gérés par le code, ne supprime rien
     (sauf purge des entrées « hors-liste » non référencées après remap). */
  syncCatalogs(): boolean {
    let changed = false;
    const upsert = (coll: string, Cls: any, defs: any[], fields: string[]) => {
      defs.forEach((def) => {
        const ex = this.data[coll].find((o) => o.id === def.id);
        if (!ex) { this.data[coll].push(new Cls(def)); changed = true; return; }
        fields.forEach((k) => { if (def[k] !== undefined && ex[k] !== def[k]) { ex[k] = def[k]; changed = true; } });
      });
    };
    upsert("portTypes", PortType, DEFAULT_PORT_TYPES, ["name", "family", "connector", "speed", "kind", "duplex"]);
    upsert("cableTypes", CableType, DEFAULT_CABLE_TYPES, ["name", "family", "medium", "kind"]);
    if (this._remapLegacyCatalog("portTypes", DEFAULT_PORT_TYPES, "ports", "port_type_id",
      (o) => [o.family, o.connector || o.family, o.speed].join("|").toLowerCase())) changed = true;
    if (this._remapLegacyCatalog("cableTypes", DEFAULT_CABLE_TYPES, "cables", "cable_type_id",
      (o) => [o.family, o.medium].join("|").toLowerCase())) changed = true;
    if (changed) this._reindex();
    return changed;
  }
  private _remapLegacyCatalog(coll: string, defs: any[], fkColl: string, fkKey: string, sigFn: (o: any) => string): boolean {
    const codeIds = new Set(defs.map((d) => d.id));
    const legacy = this.data[coll].filter((o) => !codeIds.has(o.id));
    if (!legacy.length) return false;
    let changed = false;
    const bySig = new Map<string, string>();
    this.data[coll].forEach((o) => { if (codeIds.has(o.id)) { const s = sigFn(o); if (!bySig.has(s)) bySig.set(s, o.id); } });
    legacy.forEach((old) => {
      const target = bySig.get(sigFn(old));
      if (target) this.data[fkColl].forEach((r) => { if (r[fkKey] === old.id) { r[fkKey] = target; changed = true; } });
    });
    const referenced = new Set(this.data[fkColl].map((r) => r[fkKey]).filter(Boolean));
    const keep = this.data[coll].filter((o) => codeIds.has(o.id) || referenced.has(o.id));
    if (keep.length !== this.data[coll].length) { this.data[coll] = keep; changed = true; }
    return changed;
  }
  seedCatalogs(): boolean { return this.syncCatalogs(); }

  totalCount(): number { return COLLECTIONS.reduce((n, c) => n + this.data[c].length, 0); }

  /* ---- persistance (hors système transactionnel) ---- */
  /** Notifié quand une persistance HORS transaction échoue (saveMeta / replaceAll). Sans lui, un échec réseau en
      mode REST (renommage, import, dispositions de graphe…) finissait en console.warn et l'UI croyait au succès —
      contrairement aux écritures d'entités, couvertes par onConflict/onValidationError. Le hôte (main.ts) notifie. */
  onPersistError: ((op: "meta" | "all", error: unknown) => void) | null = null;
  async persistMeta(): Promise<void> {
    try { await this.adapter.saveMeta(this.meta); }
    catch (e) { console.warn("saveMeta a échoué", e); this.onPersistError?.("meta", e); }
  }
  private async _persistAll(): Promise<void> {
    // 🚨 GARDE G1 — anti-snapshot partiel (docs/hydratation.md). `adapter.replaceAll(toJSON())` devient un
    // `PUT /snapshot` en mode API, que le serveur applique en DELETE + réinsertion PAR COLLECTION : dérivé
    // d'un cache où une collection n'est pas `full`, il EFFACERAIT côté serveur tout ce qui n'est pas en
    // mémoire — PERTE DE DONNÉES. Le chemin le plus sournois est le boot : `init()` fait
    // `if (syncCatalogs()) _persistAll()` — un boot futur à collections lazy déclencherait un snapshot
    // amputé sans cette garde. Refus BRUYANT (HydrationError, AVANT le try) : ce n'est PAS un échec de
    // persistance à router vers onPersistError (qui « avale » en toast), c'est un garde-fou structurel qui
    // doit remonter à l'appelant. Les chemins légitimes passent PAR CONSTRUCTION : mode fichier/visualiseur
    // (état inerte tout-full), import `replaceAll` et `newDocument` (remplacement TOTAL voulu : `_hydrate`
    // vient de re-marquer tout full — le snapshot poussé EST le document complet).
    this.hydration.assertFullyHydrated("persistAll (adapter.replaceAll / PUT /snapshot)");
    try { await this.adapter.replaceAll(this.toJSON()); }
    catch (e) { console.warn("replaceAll a échoué", e); this.onPersistError?.("all", e); }
  }

  /* ---- UNDO / REDO (délégué à l'adapter) ---- */
  canUndo(): boolean { return typeof this.adapter.canUndo === "function" && this.adapter.canUndo(); }
  canRedo(): boolean { return typeof this.adapter.canRedo === "function" && this.adapter.canRedo(); }
  /** Révision courante du modèle (position d'historique) — pour recalculer le « dirty » par rapport à la dernière
      sauvegarde (un undo qui ramène au point sauvegardé → révision identique → propre). */
  histIndex(): number { return typeof this.adapter.histIndex === "function" ? this.adapter.histIndex() : 0; }
  async undo(): Promise<boolean> {
    if (!this.canUndo()) return false;
    const snap = await this.adapter.undo();
    if (snap == null) return false;
    this._hydrate(snap); this._emit(); return true;
  }
  async redo(): Promise<boolean> {
    if (!this.canRedo()) return false;
    const snap = await this.adapter.redo();
    if (snap == null) return false;
    this._hydrate(snap); this._emit(); return true;
  }

  /* ---- LECTURE (cache hydraté, synchrone) ----
     SURCHARGES TYPÉES : une collection LITTÉRALE (`store.get("racks", id)`) renvoie le type d'entité
     réel (`Rack | null`) — le compilateur impose alors la garde null et connaît les champs. Une
     collection VARIABLE (chaîne quelconque) retombe sur `any` (compat. code générique / historique). */
  get<C extends CollectionName>(collection: C, id: string | null | undefined): EntityOf<C> | null;
  get(collection: string, id: string | null | undefined): any;
  get(collection: string, id: string | null | undefined): any {
    // id nullable ACCEPTÉ (FK optionnelle → null), comme depuis toujours (Map.get(undefined) → undefined → null).
    return this._idIndex[collection] ? this._idIndex[collection].get(id as string) || null : null;
  }
  all<C extends CollectionName>(collection: C): EntityOf<C>[];
  all(collection: string): any[];
  all(collection: string): any[] { return this.data[collection].slice(); }

  /* Ré-hydrate une entité depuis un enregistrement adapter (identité préservée si
     déjà au cache ; normalisation + copie des tableaux via le constructeur). */
  private _absorbRecord(collection: string, r: RawRecord): any {
    if (!r || !r.id) return null;
    // Transition d'hydratation : absorber un enregistrement d'une collection déclarée lazy (`none`) la
    // rend `partial` — le cache en détient DÉSORMAIS une fraction, plus jamais « rien », pas encore
    // « tout ». No-op sur une collection `full` (lot 0 : toujours). Cf. docs/hydratation.md.
    this.hydration.noteAbsorption(collection);
    const Cls = ENTITY_CLASSES[collection];
    const fresh: any = new Cls(r);
    const cached = this.get(collection, r.id);
    if (cached) {
      this._withReindex(collection, cached, (o) => { Object.keys(fresh).forEach((k) => { if (k !== "id") o[k] = fresh[k]; }); });
      return cached;
    }
    this.data[collection].push(fresh);
    this._indexAdd(collection, fresh);
    return fresh;
  }

  /* list paginé + filtré — DÉLÉGUÉ à l'adapter (chemin legacy `filter`/`searchFields`
     résolu côté client sur le cache). */
  async list(collection: string, { page = 1, pageSize = PAGE_SIZE_DEFAULT, query = "", where = null, filter = null, searchFields = null, sort = null, dir = null, signal }: ListStoreOptions = {}): Promise<any> {
    if (filter || searchFields) {
      let rows = this.data[collection].slice();
      if (filter) rows = rows.filter(filter);
      if (query && query.trim()) {
        const q = Text.normSearch(query);
        rows = rows.filter((o) => {
          const fields = searchFields || Object.values(o.toJSON());
          return fields.some((v) => Text.normSearch(v).includes(q));
        });
      }
      rows.sort((a, b) => String(a.created_date).localeCompare(String(b.created_date)));
      const total = rows.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const p = Math.min(Math.max(1, page), pages);
      return { rows: rows.slice((p - 1) * pageSize, p * pageSize), total, page: p, pages, pageSize };
    }
    const res = await this.adapter.list(collection, { page, pageSize, query, where, sort, dir, signal });
    return Object.assign({}, res, { rows: res.rows.map((r) => this._absorbRecord(collection, r)).filter(Boolean) });
  }

  /* ---- lectures fraîches par élément (via adapter) ---- */
  async fetchOne(collection: string, id: string): Promise<any> {
    const r = await this.adapter.getOne(collection, id);
    return r ? this._absorbRecord(collection, r) : null;
  }
  async fetchMany(collection: string, ids: string[]): Promise<any[]> {
    const rows = await this.adapter.getMany(collection, ids);
    return rows.map((r) => this._absorbRecord(collection, r)).filter(Boolean);
  }
  async fetchBy(collection: string, field: string, value: any): Promise<any[]> {
    const rows = await this.adapter.findBy(collection, field, value);
    return rows.map((r) => this._absorbRecord(collection, r)).filter(Boolean);
  }

  /* ---- VALIDATION PARTAGÉE (intégrité côté client — cf. shared/DataValidation, docs/validation.md) ----
     En mode FICHIER il n'y a pas de serveur → c'est le SEUL garde-fou. En mode API, ce contrôle donne un
     retour immédiat AVANT l'écriture réseau (le serveur reste l'autorité et re-valide). */
  /** Notifié quand une écriture est BLOQUÉE car non conforme (parité avec le rejet 400 serveur). */
  onInvalid: ((errors: ValidationError[]) => void) | null = null;
  /** Lecteur d'entité (intégrité référentielle V2 + cross-entité V5) adossé au cache hydraté. */
  private entityFetcher: EntityFetcher = (collection, id) => this.get(collection, id) || null;
  /** Recherche d'enregistrements par champ INDEXÉ (dépendance inverse V5b + portée V6) via les index secondaires. */
  private recordFinder: ChildFinder = (collection, field, value) => this._byFk(collection, field, value);
  /** Recherche publique par champ indexé — pour la validation de PORTÉE (V6) en live dans les formulaires. */
  findByField(collection: string, field: string, value: any): any[] { return this._byFk(collection, field, value); }
  /** Valide un enregistrement (forme canonique) + portée (V6) + dépendances inverses (V5b) ; si invalide →
      notifie et renvoie false (écriture bloquée). `record` = état (fusionné) qui SERA écrit. */
  private accepts(collection: string, record: Record<string, any>): boolean {
    return this.acceptsWith(collection, record, this.entityFetcher, this.recordFinder);
  }
  /** Comme `accepts`, mais avec des lecteurs INJECTÉS (pour la validation CONSCIENTE DU LOT — cf. updateBatch,
      parité avec le `/transact` serveur : chaque op est validée contre l'état POST-lot). */
  private acceptsWith(collection: string, record: Record<string, any>, fetcher: EntityFetcher, finder: ChildFinder): boolean {
    const errors = DataValidator.validateRecord(collection, record, fetcher, finder);
    if (!errors.length) errors.push(...DataValidator.validateDependents(collection, record, finder, fetcher));
    if (errors.length) { this.onInvalid?.(errors); return false; }
    return true;
  }
  /** Normalise les CHAMPS PATCHÉS (forme canonique partagée) à partir du résultat fusionné — fixe l'incohérence
      historique où un patch posait des valeurs brutes (ex. `u_count: "10"`). */
  private _normalizePatch(collection: string, obj: any, patch: Record<string, any>): Record<string, any> {
    const merged = DataValidator.normalizeRecord(collection, { ...obj.toJSON(), ...patch });
    const normalizedPatch: Record<string, any> = {};
    for (const field of Object.keys(patch)) normalizedPatch[field] = (field in merged) ? merged[field] : patch[field];
    return normalizedPatch;
  }

  /* ---- ÉCRITURE (1 action logique = 1 transaction) ---- */
  async create(collection: string, props: any): Promise<any> {
    const obj = props instanceof Entity ? props : new ENTITY_CLASSES[collection](props);
    if (!this.accepts(collection, obj.toJSON())) return null;   // validation partagée (intrinsèque + référentielle)
    this.data[collection].push(obj);
    this._indexAdd(collection, obj);
    await this.adapter.createOne(collection, obj.toJSON());
    this._counts.invalidate([collection]);   // G6 : le total de la collection a bougé (pastille d'onglet)
    this._facets.invalidate([collection]);   // G8 : la création peut apporter une valeur de facette inédite
    this._emit();
    return obj;
  }
  /* Applique un patch EN MÉMOIRE (index maintenu, horodatage), en ignorant id/created_date. */
  private _applyPatch(collection: string, obj: any, patch: Record<string, any>): void {
    this._withReindex(collection, obj, (o) => {
      Object.keys(patch).forEach((k) => { if (k === "id" || k === "created_date") return; o[k] = patch[k]; });
      o.touch();
    });
  }
  async update(collection: string, id: string, patch: Record<string, any>): Promise<any> {
    const obj = this.get(collection, id);
    if (!obj) return null;
    const normalizedPatch = this._normalizePatch(collection, obj, patch);
    // COURT-CIRCUIT no-op : patch sans effet → aucune écriture (ni PUT/SSE, ni touch, ni validation —
    // rien n'est écrit, l'état stocké n'est pas re-jugé ; un enregistrement legacy invalide reste éditable
    // « à blanc »). Sans lui, chaque « Enregistrer » de formulaire non modifié ré-émettait tous les champs à
    // l'identique : un PUT + broadcast SSE par enregistrement intact (l'équipement ET chacun de ses ports),
    // et `touch()` polluait `updated_date`. NB : la migration en mémoire `_migrateDepths` comptait sur la
    // « persistance à la prochaine édition » — un save à blanc ne la persiste donc plus ; assumé : elle est
    // idempotente et rejouée à chaque chargement.
    if (!PatchDiff.changes(obj.toJSON(), normalizedPatch)) return obj;
    // valide le RÉSULTAT fusionné AVANT de muter (abort propre, aucune mutation partielle si invalide).
    if (!this.accepts(collection, { ...obj.toJSON(), ...normalizedPatch })) return null;
    this._applyPatch(collection, obj, normalizedPatch);
    await this.adapter.updateOne(collection, id, obj.toJSON());
    // G8 : le TOTAL n'a pas bougé (aucune invalidation de compteur ici), mais une valeur de colonne a
    // pu changer — donc l'ensemble des valeurs distinctes de la collection aussi.
    this._facets.invalidate([collection]);
    this._emit();
    return obj;
  }
  /* Plusieurs patchs (multi-collections) en UNE transaction = UN pas d'undo. */
  async updateBatch(ops: Array<{ collection: string; id: string; patch: Record<string, any> }>): Promise<number> {
    // 1) prépare tout (normalisation + état fusionné) SANS muter.
    const prepared: Array<{ obj: any; collection: string; id: string; patch: Record<string, any>; merged: Record<string, any> }> = [];
    for (const { collection, id, patch } of ops) {
      const obj = this.get(collection, id); if (!obj) continue;
      const normalizedPatch = this._normalizePatch(collection, obj, patch);
      prepared.push({ obj, collection, id, patch: normalizedPatch, merged: { ...obj.toJSON(), ...normalizedPatch } });
    }
    // 2) VALIDE tout AVANT de muter, de façon CONSCIENTE DU LOT (parité `/transact` serveur) : chaque op est
    // validée contre l'état POST-lot. Sans ça, un repositionnement MULTIPLE (ex. reflow d'étagère où A prend la
    // place que B va libérer) déclencherait un faux chevauchement (V6e) contre les positions PRÉ-lot. Le moindre
    // échec annule le lot entier (atomicité).
    const body = { updates: prepared.map((p) => ({ collection: p.collection, record: p.merged })) };
    const fetcher = DataValidator.buildBatchFetcher(this.entityFetcher, body);
    const finder = DataValidator.buildBatchChildFinder(this.recordFinder, body);
    for (const p of prepared) { if (!this.acceptsWith(p.collection, p.merged, fetcher, finder)) return 0; }
    // 3) applique + persiste
    const updates: Transaction["updates"] = [];
    for (const { obj, collection, id, patch } of prepared) {
      this._applyPatch(collection, obj, patch);
      updates!.push({ collection, id, record: obj.toJSON() });
    }
    if (updates!.length) {
      await this.adapter.transact({ updates });
      this._facets.invalidate([...new Set(updates!.map((u) => u.collection))]);   // G8 : mêmes motifs que `update`
      this._emit();
    }
    return updates!.length;
  }
  async remove(collection: string, id: string): Promise<void> {
    await this._removeTargets([{ collection, id }]);
  }

  /** Suppression EN LOT de plusieurs racines d'une MÊME collection, en UNE SEULE transaction — donc
      UNE révision, UN événement SSE et UNE entrée d'undo, quel que soit le nombre de racines.

      🚨 NE JAMAIS boucler sur `remove()` pour obtenir ce résultat : N appels = N transactions, donc N
      révisions consommées, N événements SSE réveillant tous les autres clients, et un undo « en miettes »
      (l'utilisateur devrait défaire N fois pour revenir en arrière). C'est exactement le cas d'usage qui a
      motivé ce point d'entrée : purger d'un geste les ~60 VMs orphelines laissées par une bascule d'identité
      de réconciliation (cf. `core/VmPurge`, docs/vm-proxmox.md « Purge de masse des orphelines »).

      Le plan de cascade est calculé en UNE fois sur TOUTES les racines (`Cascade.planMany`) : c'est une
      exigence de CORRECTION, pas une optimisation — les garanties du moteur (composition des retraits de
      liste, garde anti-résurrection) ne valent que dans la portée d'un appel (cf. src-shared/Cascade.ts).

      Les ids INCONNUS (déjà supprimés par un autre client, double-clic) et les DOUBLONS sont écartés en
      amont : sans ce filtre, la transaction porterait des suppressions sans objet. Renvoie le nombre de
      racines réellement supprimées (0 = rien à faire, aucune écriture, aucune révision consommée). */
  async removeMany(collection: string, ids: ReadonlyArray<string>): Promise<number> {
    const targets = this._existingTargets(collection, ids);
    if (!targets.length) return 0;   // aucune écriture (ni transaction, ni rev, ni SSE, ni pas d'undo)
    await this._removeTargets(targets);
    return targets.length;
  }

  /** PRÉVISUALISATION de la cascade d'un lot de suppressions — ne mute RIEN, n'écrit RIEN. Sert aux UI qui
      doivent ANNONCER les effets avant de les déclencher (« Z adresses IP seront détachées ») : le compte
      vient alors du PLAN RÉEL, jamais d'une estimation refaite à la main qui divergerait de la cascade.
      Mêmes racines retenues que `removeMany` (ids inconnus et doublons écartés) → l'aperçu décrit
      EXACTEMENT ce que la purge fera. */
  cascadePreview(collection: string, ids: ReadonlyArray<string>): { deletes: CascadeDelete[]; detaches: CascadeDetach[] } {
    const targets = this._existingTargets(collection, ids);
    if (!targets.length) return { deletes: [], detaches: [] };
    return this._cascadePlan(targets);
  }

  /** 🚨 G5 — APERÇU DE CASCADE des UI, en corpus éventuellement PARTIEL (docs/hydratation.md § Vague 2).
      C'est le point d'entrée que doivent utiliser les surfaces qui ANNONCENT les effets d'une
      suppression : `cascadePreview` (ci-dessus) calcule le plan sur les index du CACHE, donc
      SOUS-ESTIME dès qu'une collection du périmètre est chargée paresseusement (une pièce jointe
      jamais absorbée n'apparaîtrait pas dans « ce qui sera supprimé »).

      CRITÈRE de bascule retenu (arbitrage n°2, endpoint serveur) : **corpus intégralement hydraté →
      plan LOCAL, sinon plan SERVEUR**. Volontairement CONSERVATEUR plutôt qu'exact :
      - il est EXACT là où ça compte — en mode fichier/visualiseur l'état inerte est toujours
        « tout full », donc le chemin est TOUJOURS local, sans réseau ni écart (principe n°15) ; et
        une collection lazy redevenue `full` (export G2, hydratation à la demande) y revient aussi ;
      - restreindre le critère au PÉRIMÈTRE RÉEL de la cascade demanderait de déclarer à la main les
        collections qu'atteint chaque règle `custom` de `Cascade.SPEC` (fonctions opaques) : une
        déclaration oubliée ferait SOUS-ESTIMER en silence — exactement la panne que G5 existe pour
        empêcher. Le coût de la prudence est UN aller-retour sur une modale de confirmation, qui est
        déjà asynchrone.

      Adaptateur sans aperçu serveur (mode fichier, adaptateur d'avant la vague 2) → repli sur le plan
      local : jamais d'erreur, jamais d'aperçu vide. */
  async cascadePreviewAsync(collection: string, ids: ReadonlyArray<string>): Promise<{ deletes: CascadeDelete[]; detaches: CascadeDetach[] }> {
    const unique = [...new Set((ids || []).filter(Boolean))];
    if (!unique.length) return { deletes: [], detaches: [] };   // rien à supprimer → aucun aller-retour
    if (this.hydration.isFullyHydrated()) return this.cascadePreview(collection, unique);
    // Les ids sont transmis TELS QUELS (pas de filtre `_existingTargets`) : sur un corpus partiel, une
    // racine absente du cache n'est pas une racine inexistante — c'est le serveur qui fait autorité.
    const plan = await this.adapter.cascadePreview(collection, unique);
    return plan || this.cascadePreview(collection, unique);
  }

  /* Racines RÉELLEMENT supprimables d'un lot : ids vides, doublons et entités absentes du cache écartés.
     Partagé par `removeMany` et `cascadePreview` pour qu'aperçu et exécution portent sur le MÊME ensemble. */
  private _existingTargets(collection: string, ids: ReadonlyArray<string>): CascadeTarget[] {
    const targets: CascadeTarget[] = [];
    const seen = new Set<string>();
    for (const id of ids || []) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (!this.get(collection, id)) continue;   // racine absente du cache → rien à supprimer
      targets.push({ collection, id });
    }
    return targets;
  }

  /* Suppression EFFECTIVE d'un ENSEMBLE de racines : plan de cascade → mutation du cache → UNE transaction.
     Chemin UNIQUE de `remove` (une racine) et de `removeMany` (un lot) — le corps était identique à la
     boucle de racines près, et le dupliquer aurait laissé les deux copies diverger (principe n°3). */
  private async _removeTargets(targets: ReadonlyArray<CascadeTarget>): Promise<void> {
    // 1. calcule la cascade AVANT toute mutation (UN SEUL plan pour TOUTES les racines)
    const { deletes, detaches } = this._cascadePlan(targets);
    // 2. applique en mémoire : détachements puis suppressions (index incrémental)
    detaches.forEach((d) => {
      const o = this.get(d.c, d.id);
      if (o) this._withReindex(d.c, o, (x) => { x[d.key] = ("value" in d) ? d.value : null; if (x.touch) x.touch(); });
    });
    const delByColl: Record<string, Set<string>> = {};
    deletes.concat(targets.map((t) => ({ c: t.collection, id: t.id }))).forEach((d) => { (delByColl[d.c] = delByColl[d.c] || new Set()).add(d.id); });
    Object.keys(delByColl).forEach((c) => {
      delByColl[c].forEach((did) => {
        const o = this._idIndex[c].get(did);
        if (o) { if (this._fk[c]) this._fk[c].remove(o); this._idIndex[c].delete(did); }
      });
      this.data[c] = this.data[c].filter((o) => !delByColl[c].has(o.id));
    });
    // 3. UNE transaction : détachements (updates) + suppressions enfants + cibles.
    const tx: Transaction = {
      updates: detaches.map((d) => { const o = this.get(d.c, d.id); return o ? { collection: d.c, id: d.id, record: o.toJSON() } : null; }).filter(Boolean) as Transaction["updates"],
      deletes: deletes.map((d) => ({ collection: d.c, id: d.id })).concat(targets.map((t) => ({ collection: t.collection, id: t.id }))),
    };
    const result = await this.adapter.transact(tx);
    this._counts.invalidate(Object.keys(delByColl));   // G6 : les totaux des collections purgées ont bougé
    // G8 : suppressions ET détachements changent l'ensemble des valeurs distinctes des collections touchées.
    this._facets.invalidate([...new Set([...Object.keys(delByColl), ...detaches.map((d) => d.c)])]);
    // M4 (chantier lazy-load) : le SERVEUR a pu supprimer PLUS que notre plan — sa cascade RÉSIDUELLE
    // (cf. ApiRules.residualCascade) porte ce que notre cache ne pouvait pas savoir. Deux effets sinon :
    // un enregistrement absorbé mais supprimé côté serveur resterait AFFICHÉ, et la pastille d'une
    // collection lazy garderait un COUNT périmé (notre invalidation ne couvre que le plan local). On
    // applique donc le résidu que la réponse rapporte. En mode fichier : aucun résidu (pas de serveur).
    this._applyResidualDeletes(result);
    // M4b (vague 4) : même autorité serveur pour les MISES À JOUR résiduelles — des enregistrements
    // DÉTACHÉS par la cascade serveur que notre plan local ne portait pas (jamais absorbés, ou copie
    // périmée parce que G3 a sauté leur rechargement SSE). Refetch GROUPÉ, en ARRIÈRE-PLAN : l'écriture
    // est FAITE, on ne la fait pas attendre un aller-retour de plus (patron des caches async G6/G8 —
    // la valeur arrive, le rendu se rattrape).
    void this._refreshResidualUpdates(result);
    this._emit();
  }

  /** M4 — retire du cache les enregistrements supprimés par la cascade RÉSIDUELLE du serveur.
      Le résidu vient de la RÉPONSE de l'écriture (`POST /transact` → `{ residual: { deletes } }`) et
      non d'un événement SSE : le client IGNORE ses propres événements (X-Client-Id), donc rien
      d'autre ne le lui apprendrait avant un F5. Tolérant à toute autre forme de retour (adaptateur
      fichier, serveur d'avant la vague 2) : sans `residual.deletes`, c'est un no-op strict. */
  private _applyResidualDeletes(result: unknown): void {
    const residual = (result as any)?.residual;
    const deletes: Array<{ collection?: string; id?: string }> = Array.isArray(residual?.deletes) ? residual.deletes : [];
    if (!deletes.length) return;
    const touched = new Set<string>();
    for (const d of deletes) {
      const c = d && d.collection, id = d && d.id;
      if (!c || !id || !this._idIndex[c]) continue;
      touched.add(c);
      const obj = this._idIndex[c].get(id);
      if (!obj) continue;   // jamais absorbé : rien à retirer du cache (mais le COMPTE a bougé)
      if (this._fk[c]) this._fk[c].remove(obj);
      this._idIndex[c].delete(id);
      this.data[c] = this.data[c].filter((o) => o.id !== id);
    }
    if (touched.size) {
      Log.d("store", "cascade résiduelle du serveur appliquée au cache (M4)", [...touched]);
      this._counts.invalidate([...touched]);
      this._facets.invalidate([...touched]);   // G8 : le résidu a retiré des lignes — leurs valeurs aussi
    }
  }

  /** M4b (vague 4) — RAFRAÎCHIT au cache les enregistrements que la cascade RÉSIDUELLE du serveur a
      MIS À JOUR en plus de notre plan (`POST /transact` → `{ residual: { updates: [{collection,id}] } }`).
      Cas concret, et RAISON D'ÊTRE de M4b : supprimer un équipement DÉTACHE ses spares côté serveur
      (règle `custom` de `Cascade.SPEC` : `assigned_free` ← nom, `assigned_equipment_id` ← null) — un
      spare EN CACHE dont le détachement n'était pas dans notre plan local resterait sinon affiché
      rattaché à un équipement disparu, jusqu'au prochain chargement de la collection.

      DÉCISIONS (documentées dans docs/hydratation.md § « Vague 4 ») :
      - on refetch TOUS les ids rapportés : un enregistrement d'une collection HYDRATÉE doit
        impérativement être rafraîchi (son cache serait faux) ; un enregistrement pas encore en cache
        d'une collection lazy est simplement absorbé (`partial`) — aucun mal, et il devient résoluble ;
      - refetch GROUPÉ par collection (`fetchMany` → `GET ?ids=…`, absorption + ré-indexation) — le
        volume est borné par la largeur de la cascade, jamais la collection ;
      - les COMPTEURS ne bougent pas (une mise à jour ne change aucun total) ; les FACETTES si (une
        valeur de colonne a changé) — même invalidation que les écritures locales (cf. `update`) ;
      - un ÉCHEC réseau ne casse JAMAIS l'écriture (elle est faite) : trace, et les caches se
        rattraperont (prochain chargement de page, SSE d'un autre client, F5).
      Tolérant par construction : sans `residual.updates` (adaptateur fichier, serveur antérieur),
      c'est un no-op strict — aucun aller-retour. */
  private async _refreshResidualUpdates(result: unknown): Promise<void> {
    const residual = (result as any)?.residual;
    const updates: Array<{ collection?: string; id?: string }> = Array.isArray(residual?.updates) ? residual.updates : [];
    if (!updates.length) return;
    const idsByCollection = new Map<string, Set<string>>();
    for (const u of updates) {
      const c = u && u.collection, id = u && u.id;
      if (!c || !id || !this.data[c]) continue;   // collection inconnue du client : rien à rafraîchir
      // … ni une collection INTERDITE : la cascade serveur a pu toucher des `wifiClients` qu'on n'a
      // pas le droit de lire — les refetcher ne rafraîchirait rien (rien n'est en cache), seulement
      // un 403 en marge d'une écriture par ailleurs réussie.
      if (this.hydration.isForbidden(c)) continue;
      (idsByCollection.get(c) || idsByCollection.set(c, new Set()).get(c)!).add(id);
    }
    if (!idsByCollection.size) return;
    const collections = [...idsByCollection.keys()];
    // G8 AVANT le refetch : les valeurs distinctes ont changé CÔTÉ SERVEUR quoi qu'il arrive du
    // refetch local — le relevé `SELECT DISTINCT` du prochain rendu doit repartir de zéro.
    this._facets.invalidate(collections);
    try {
      await Promise.all(collections.map((c) => this.fetchMany(c, [...idsByCollection.get(c)!])));
      Log.d("store", "mises à jour résiduelles du serveur rafraîchies au cache (M4b)", collections);
      this._emit();   // les enregistrements rafraîchis atteignent l'écran (fiches/listings ouverts)
    } catch (e) {
      // L'écriture est FAITE et son plan local appliqué : on ne remonte rien. Le cache concerné se
      // rattrapera par les chemins ordinaires (page redemandée, SSE, hydratation à la demande).
      Log.d("store", "M4b : refetch du résidu impossible (cache rattrapé plus tard)", e);
    }
  }

  /* Plan de cascade (intégrité référentielle) : entités à SUPPRIMER + à DÉTACHER. Délègue au calcul
     PARTAGÉ `Cascade.planMany` (même logique côté serveur sur `DELETE` et sur `/transact`), alimenté par nos
     capacités injectées : résolutions inverses via les index secondaires (`recordFinder`), lecture via
     `entityFetcher`. MULTI-RACINES par construction : une racine seule n'est qu'un lot d'un élément.
     Le plan est RÉCURSIF (chaîne complète, jusqu'au point fixe — cf. docs/placement.md §6.16) : il peut donc
     être bien plus profond qu'une liste d'enfants directs. L'appelant n'a rien à y adapter — les suppressions
     forment un ENSEMBLE (aucun ordre à respecter) et le plan garantit qu'aucun détachement ne vise une entité
     qu'il supprime, donc l'étape 2 ne peut plus « nettoyer » une FK sur un enregistrement qui part juste après. */
  private _cascadePlan(targets: ReadonlyArray<CascadeTarget>): { deletes: CascadeDelete[]; detaches: CascadeDetach[] } {
    return Cascade.planMany(targets, this.recordFinder, this.entityFetcher);
  }

  /* ---- CLONAGE ---- */
  /* Clone un équipement AVEC ses ports et agrégats (FK ré-aiguillées ; câbles non
     clonés — un câble relie des ports physiques précis). */
  async cloneEquipment(id: string): Promise<any> {
    const eq = this.get("equipments", id);
    if (!eq) return null;
    const copy = eq.clone();
    copy.name = (eq.name || "équipement") + " (copie)";
    // COPIE = NON PLACÉE : un clone ne doit JAMAIS occuper le MÊME emplacement physique que l'original —
    // sinon collision de U, CHEVAUCHEMENT d'étagère (V6e), ou double-ancrage latéral/paroi/étage. On efface
    // TOUS les placements (rack · sol · latéral · paroi · étage · étagère) → état « non placé », valide
    // partout (le clone contourne accepts() : il DOIT produire un enregistrement conforme). « manual » = état
    // POOL/non placé, valide quel que soit dim_mode (T1 refuse « rack » sans rack_id ; T1b « side/wall » sans
    // baie ; T1c « tray » sans étagère) — c'est la seule valeur sûre pour un équipement sans emplacement.
    copy.placement_mode = "manual";
    copy.rack_id = null; copy.rack_u = null;
    copy.dc_id = null; copy.dc_x = null; copy.dc_y = null; copy.dc_z = 0; copy.dc_orientation = 0;
    copy.tray_item_id = null; copy.tray_x = null; copy.tray_y = null;
    copy.floor_x = null; copy.floor_y = null;
    // VALIDATION cliente (mêmes règles partagées que le serveur) AVANT toute mutation optimiste : le clone ne
    // doit produire QUE des données conformes (en mode fichier, c'est le seul garde-fou ; en mode API, évite la
    // divergence cache local ⇄ serveur si le serveur refusait). Le clone est « non placé » → passe normalement.
    if (!this.accepts("equipments", copy.toJSON())) return null;
    this.data.equipments.push(copy);
    const aggMap: Record<string, string> = {};
    const newAggs: any[] = [];
    this.aggregatesOf(id).forEach((a) => {
      const na = a.clone(); na.equipment_id = copy.id;
      this.data.aggregates.push(na); aggMap[a.id] = na.id; newAggs.push(na);
    });
    const newPorts: any[] = [];
    const portMap: Record<string, string> = {};
    this.portsOf(id).forEach((p) => {
      const np = p.clone(); np.equipment_id = copy.id;
      np.aggregate_id = p.aggregate_id ? (aggMap[p.aggregate_id] || null) : null;
      portMap[p.id] = np.id;
      this.data.ports.push(np); newPorts.push(np);
    });
    newPorts.forEach((np) => { if (np.parent_port_id) np.parent_port_id = portMap[np.parent_port_id] || null; });
    this._reindex();
    await this.adapter.transact({
      creates: ([{ collection: "equipments", record: copy.toJSON() }] as Transaction["creates"])!
        .concat(newAggs.map((a) => ({ collection: "aggregates", record: a.toJSON() })))
        .concat(newPorts.map((p) => ({ collection: "ports", record: p.toJSON() }))),
    });
    this._counts.invalidate(["equipments", "aggregates", "ports"]);   // G6 : trois totaux ont bougé
    this._facets.invalidate(["equipments", "aggregates", "ports"]);   // G8 : et leurs valeurs distinctes avec
    this._emit();
    return copy;
  }
  /* Clone générique (entités simples). */
  async cloneSimple(collection: string, id: string): Promise<any> {
    const obj = this.get(collection, id);
    if (!obj) return null;
    const copy = obj.clone();
    if ("name" in copy && copy.name) copy.name = copy.name + " (copie)";
    if ("label" in copy && copy.label) copy.label = copy.label + " (copie)";
    // Le clone générique COPIE tous les champs, y compris ceux à PORTÉE (adresse IP unique, plage DHCP,
    // brosse/pseudo-élément au même U…). Valider AVANT de muter (comme create) : un doublon en violation est
    // REFUSÉ (feedback immédiat via onInvalid + aucune corruption en mode fichier ni divergence en mode API).
    if (!this.accepts(collection, copy.toJSON())) return null;
    this.data[collection].push(copy);
    this._indexAdd(collection, copy);
    await this.adapter.createOne(collection, copy.toJSON());
    this._counts.invalidate([collection]);   // G6 : le total de la collection a bougé
    this._facets.invalidate([collection]);   // G8 : le clone peut porter une valeur inédite (libellé « (copie) »)
    this._emit();
    return copy;
  }

  /* ---- helpers métier (résolution inverse via index secondaires) ---- */
  portsOf(equipmentId: string): any[] { return this._byFk("ports", "equipment_id", equipmentId); }
  aggregatesOf(equipmentId: string): any[] { return this._byFk("aggregates", "equipment_id", equipmentId); }
  /** Sous-équipements d'un équipement MAÎTRE (contenu logique : drives d'une librairie, cartes d'un châssis…).
      Triés par NOM : c'est leur seule identité (pas de type, pas de position — cf. la spec `subEquipments`),
      donc le seul ordre stable et lisible qu'on puisse leur donner. */
  subEquipmentsOf(equipmentId: string): any[] {
    return this._byFk("subEquipments", "equipment_id", equipmentId).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }
  /** Spares (pièces de rechange) attribués à un équipement. Triés par NOM depuis la vague 4 (parité
      STRICTE avec le jumeau async `sparesOfEquipmentAsync` — même contenu, même ordre, cf. G7) :
      l'ordre historique était celui de l'index FK (insertion), qui n'aurait pas survécu au régime
      lazy — les lignes servies par `fetchBy` arrivent dans l'ordre du serveur. */
  sparesOfEquipment(equipmentId: string): any[] { return this._byFk("spares", "assigned_equipment_id", equipmentId).sort(Store.BY_NAME); }
  breakoutLanes(parentPortId: string): any[] { return this._byFk("ports", "parent_port_id", parentPortId).sort((a, b) => (a.lane || 0) - (b.lane || 0)); }
  isBreakoutParent(port: any): boolean { const id = port && port.id ? port.id : port; return !!id && this._byFk("ports", "parent_port_id", id).length > 0; }
  cablesOfPort(portId: string): any[] {
    if (!portId) return [];
    const out = this._byFk("cables", "from_port_id", portId);
    this._byFk("cables", "to_port_id", portId).forEach((c) => { if (!out.includes(c)) out.push(c); });
    return out;
  }
  cablesOfPorts(portIds: Set<string> | string[]): any[] {
    const ids = portIds instanceof Set ? [...portIds] : (portIds || []);
    const seen = new Set<string>(), out: any[] = [];
    ids.forEach((pid) => this.cablesOfPort(pid).forEach((c) => { if (!seen.has(c.id)) { seen.add(c.id); out.push(c); } }));
    return out;
  }
  cablesOfEquipment(equipmentId: string): any[] { return this.cablesOfPorts(this.portsOf(equipmentId).map((p) => p.id)); }
  cableOnPort(portId: string, exceptCableId: string | null = null): any {
    if (!portId) return null;
    return this.cablesOfPort(portId).find((c) => c.id !== exceptCableId) || null;
  }
  /** Câbles portant un réseau — DÉDUIT (le réseau vit sur les ports terminaux). Un câble « porte » le réseau si
      sa composante de chemin contient un port terminal l'assertant. */
  cablesOfNetwork(networkId: string): any[] {
    return this.all("cables").filter((c) => this.cableNetworkIds(c).includes(networkId));
  }
  /** Équipements MEMBRES d'un groupe (primaire OU secondaire). Cherche les deux champs (modèle cablesOfNetwork). */
  equipmentsOfGroup(groupId: string): any[] {
    const out = this._byFk("equipments", "group_ids", groupId);
    this._byFk("equipments", "group_id", groupId).forEach((e) => { if (!out.includes(e)) out.push(e); });
    return out.filter((e) => this.equipmentGroupIds(e).includes(groupId));
  }
  /** Tous les groupes d'un enregistrement PORTEUR DE GROUPES (primaire inclus), dédupliqués, primaire en TÊTE.
      SOURCE UNIQUE de l'appartenance : la règle ne dépend pas de la collection, seulement du couple de champs
      `group_id`/`group_ids` — que portent aujourd'hui `equipments`, `vms` et `subEquipments` (parité stricte,
      cf. la spec partagée). L'écrire une fois par collection l'aurait fait diverger. */
  groupIdsOf(record: any): string[] {
    let ids: string[] = Array.isArray(record && record.group_ids) ? record.group_ids.filter((x: any): x is string => typeof x === "string" && !!x) : [];
    if (record && record.group_id) ids = [record.group_id, ...ids.filter((x) => x !== record.group_id)];   // primaire TOUJOURS en tête
    return [...new Set(ids)];
  }
  /** Tous les groupes d'un équipement — DÉLÈGUE à `groupIdsOf`. Nom conservé pour ses nombreux points d'appel. */
  equipmentGroupIds(eq: any): string[] { return this.groupIdsOf(eq); }
  /** Ports du MAÎTRE assignés à ce sous-équipement (« ce drive est desservi par FC-1 et FC-2 »).
      Triés par NOM de port — l'ordre de création n'a aucun sens à la lecture. */
  portsOfSubEquipment(subEquipmentId: string): any[] {
    return this._byFk("ports", "sub_equipment_id", subEquipmentId).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }
  /** Sous-équipements MEMBRES d'un groupe (primaire OU secondaire) — même forme que `equipmentsOfGroup`. */
  subEquipmentsOfGroup(groupId: string): any[] {
    const out = this._byFk("subEquipments", "group_ids", groupId);
    this._byFk("subEquipments", "group_id", groupId).forEach((se) => { if (!out.includes(se)) out.push(se); });
    return out.filter((se) => this.groupIdsOf(se).includes(groupId)).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }
  portsOfType(portTypeId: string): any[] { return this._byFk("ports", "port_type_id", portTypeId); }
  cablesOfType(cableTypeId: string): any[] { return this._byFk("cables", "cable_type_id", cableTypeId); }
  racksOfDc(datacenterId: string | null): any[] { return this._byFk("racks", "datacenter_id", datacenterId || null); }
  rackItemsOf(rackId: string): any[] { return this._byFk("rackItems", "rack_id", rackId); }
  portsOfAggregate(aggregateId: string): any[] { return this._byFk("ports", "aggregate_id", aggregateId); }
  equipmentsOfRack(rackId: string): any[] { return this._byFk("equipments", "rack_id", rackId); }
  freeEquipsOfDc(datacenterId: string | null): any[] { return this._byFk("equipments", "dc_id", datacenterId || null).filter((e) => e.dim_mode === "free"); }
  /** Équipements POSÉS sur une étagère (rackItem kind "tray"). */
  equipmentsOnTray(trayItemId: string): any[] { return this._byFk("equipments", "tray_item_id", trayItemId).filter((e) => e.placement_mode === "tray"); }
  waypointsOfDc(datacenterId: string | null): any[] { return this._byFk("waypoints", "datacenter_id", datacenterId || null); }
  floorsOf(location: string | null): any[] { return this._byFk("floors", "location", location || null); }
  floorFor(location: string, floor: any): any { const f = String(floor != null ? floor : ""); return this.floorsOf(location).find((x) => String(x.floor) === f) || null; }
  /* ---- SITES (bâtiments) ---- */
  /** Sites triés par nom. */
  sitesSorted(): any[] { return this.all("sites").slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || "")); }
  /** Libellé d'un site : nom de l'entité → libellé legacy (LOCATIONS) → id. */
  siteLabel(id: string): string { if (!id) return "—"; const s: any = this.get("sites", id); if (s) return s.name || id; const l = LOCATIONS.find((x) => x.id === id); return l ? l.label : id; }
  /** Salles d'un BÂTIMENT (site), tous étages confondus. Question du MODÈLE qui décide aussi d'une question
      de VUE : la PORTÉE d'affichage de la Vue étage s'exprime en salles (`visibleDcIds`), donc un bâtiment
      sans aucune salle ne peut pas entrer dans la scène. `DcInteract.scopeFloorBuilding` (qui élargit la
      portée) et `core/Locatable` (qui décide d'afficher le bouton « Localiser ») posent tous deux CETTE
      question — d'où une seule requête, ici, plutôt que deux filtres jumeaux qui divergeraient. */
  roomsOfBuilding(location: string | null): any[] { return this.all("datacenters").filter((d) => (d.location || "") === (location || "")); }
  /** Salles d'un étage (location + floor). */
  dcsOfFloor(location: string | null, floor: any): any[] { const f = String(floor != null ? floor : ""); return this.roomsOfBuilding(location).filter((d) => String(d.floor || "") === f); }
  /** Waypoints hors-salle (OOB). */
  /** Pins d'ÉTAGE (ex-OOB) : pins hors salle rattachés à un bâtiment/étage. */
  oobWaypoints(): any[] { return this.all("waypoints").filter((w) => Waypoint.isFloorLevel(w)); }
  /** Équipements posés sur un plan d'étage (hors salle). */
  floorEquipments(): any[] { return this.all("equipments").filter((e) => e.placement_mode === "floor"); }
  cablesOfWaypoint(waypointId: string): any[] { return this._byFk("cables", "waypoint_ids", waypointId); }
  ipAddressesOfNetwork(netId: string): any[] { return this._byFk("ipAddresses", "network_id", netId); }
  ipAddressesOfEquipment(eqId: string): any[] { return this._byFk("ipAddresses", "equipment_id", eqId); }
  /** Adresses IPAM RAPPROCHÉES d'une VM (index `vm_id`, cf. config.ts) — enfants liés listés par la fiche VM (T3.2),
      strict parité avec `ipAddressesOfEquipment` (même relation exclusive equipment_id / vm_id sur `ipAddresses`). */
  ipAddressesOfVm(vmId: string): any[] { return this._byFk("ipAddresses", "vm_id", vmId); }
  /** VMs HÉBERGÉES par un équipement (index `host_equipment_id`, cf. data/config.ts) — sens INVERSE du lien
      que la fiche VM suit déjà (`vm.host_equipment_id` → équipement). Passe par l'index secondaire, donc en
      O(VMs de cet hôte) et jamais en balayage de la collection : le premier consommateur est la BULLE DE
      SURVOL d'un équipement, reconstruite à chaque mouvement de souris. */
  vmsOfHost(equipmentId: string): any[] { return this._byFk("vms", "host_equipment_id", equipmentId); }
  /** Applications HÉBERGÉES sur un équipement (index `applications.equipment_id`) — SOURCE UNIQUE de la
      section « Applications » de la fiche équipement (D5). Triées par nom : c'est leur seule identité
      lisible (même choix que `subEquipmentsOf`). */
  applicationsOfEquipment(equipmentId: string): any[] {
    return this._byFk("applications", "equipment_id", equipmentId).sort(Store.BY_NAME);
  }
  /** Applications HÉBERGÉES sur une VM (index `applications.vm_id`) — parité stricte avec
      `applicationsOfEquipment` (même relation exclusive equipment_id / vm_id sur `applications`).
      Consommée par la fiche VM (D5) ET par l'enrichissement `applications` de la purge de masse
      (`VmPurgeReaders.hostedApplicationCount` — cf. core/VmPurge). */
  applicationsOfVm(vmId: string): any[] {
    return this._byFk("applications", "vm_id", vmId).sort(Store.BY_NAME);
  }
  /** Pièces jointes d'un ÉQUIPEMENT (index `attachments.equipment_id`) — SOURCE UNIQUE de la future
      section « Pièces jointes » de la fiche équipement (lot B). Triées par nom (même choix que
      `applicationsOfEquipment` : le libellé est leur seule identité lisible). */
  attachmentsOfEquipment(equipmentId: string): any[] {
    return this._byFk("attachments", "equipment_id", equipmentId).sort(Store.BY_NAME);
  }
  /** Pièces jointes d'un SOUS-ÉQUIPEMENT (index `attachments.sub_equipment_id`) — parité stricte avec
      `attachmentsOfEquipment` (même relation exclusive equipment_id / sub_equipment_id sur `attachments`). */
  attachmentsOfSubEquipment(subEquipmentId: string): any[] {
    return this._byFk("attachments", "sub_equipment_id", subEquipmentId).sort(Store.BY_NAME);
  }

  /* ---- G7 : les JUMEAUX ASYNC des relations de SECTION DE FICHE (docs/hydratation.md § Vague 2) ----

     Les quatre helpers ci-dessus lisent l'index FK du CACHE. Sur une collection chargée
     PARESSEUSEMENT, ce cache ne contient que ce qui a été absorbé : la section « Pièces jointes »
     d'un équipement s'afficherait VIDE alors que le serveur en a. Les fiches consomment donc ces
     jumeaux, qui rendent la MÊME liste (même contenu, même tri) mais vont la CHERCHER quand il le
     faut — la FK est indexée côté serveur, c'est exactement la requête que la section pose.

     Mode fichier (et toute collection hydratée) : promesse résolue sur le cache, AUCUN réseau, aucun
     écart visible (principe n°15). L'appelant n'écrit donc aucun test de mode. */

  /** Pièces jointes d'un équipement — jumeau ASYNC de `attachmentsOfEquipment` (G7). */
  attachmentsOfEquipmentAsync(equipmentId: string): Promise<any[]> { return this._sectionRows("attachments", "equipment_id", equipmentId); }
  /** Pièces jointes d'un sous-équipement — jumeau ASYNC de `attachmentsOfSubEquipment` (G7). */
  attachmentsOfSubEquipmentAsync(subEquipmentId: string): Promise<any[]> { return this._sectionRows("attachments", "sub_equipment_id", subEquipmentId); }
  /** Applications hébergées sur un équipement — jumeau ASYNC de `applicationsOfEquipment` (G7). */
  applicationsOfEquipmentAsync(equipmentId: string): Promise<any[]> { return this._sectionRows("applications", "equipment_id", equipmentId); }
  /** Applications hébergées sur une VM — jumeau ASYNC de `applicationsOfVm` (G7). */
  applicationsOfVmAsync(vmId: string): Promise<any[]> { return this._sectionRows("applications", "vm_id", vmId); }
  /** Spares attribués à un équipement — jumeau ASYNC de `sparesOfEquipment` (G7, vague 4 : `spares`
      est chargée paresseusement en mode API ; la FK `assigned_equipment_id` est indexée des deux
      côtés, cf. INDEX_SPEC). Consommé par la section « Spares affectés » de la fiche équipement. */
  sparesOfEquipmentAsync(equipmentId: string): Promise<any[]> { return this._sectionRows("spares", "assigned_equipment_id", equipmentId); }

  /** Corps UNIQUE des jumeaux async (principe n°3) : cache si la collection est INTÉGRALEMENT en
      mémoire, lecture serveur par FK indexée sinon (`fetchBy`, qui ABSORBE les lignes — la fiche
      d'une pièce ainsi listée s'ouvre donc normalement, `store.get` la trouve). C'est l'ÉTAT qui
      décide, jamais une liste de noms : une collection lazy redevenue `full` reprend le chemin local. */
  private async _sectionRows(collection: string, field: string, value: string): Promise<any[]> {
    // Collection INTERDITE : section vide, sans `fetchBy`. La fiche la masquera comme une relation
    // vide — c'est la bonne lecture : ce que l'utilisateur n'a pas le droit de voir n'existe pas pour
    // lui, et un « Chargement impossible » l'inviterait à réessayer un geste voué au 403.
    if (this.hydration.isForbidden(collection)) return [];
    const rows = this.hydration.isHydrated(collection)
      ? this._byFk(collection, field, value)
      : await this.fetchBy(collection, field, value);
    return rows.slice().sort(Store.BY_NAME);
  }

  /** Comparateur de TRI des relations ci-dessus : par nom. Écrit UNE fois — les quatre helpers (et
      leurs jumeaux async) doivent trier à l'identique, sinon la même liste change d'ordre selon le
      chemin qui l'a produite. */
  private static readonly BY_NAME = (a: any, b: any): number => String(a.name || "").localeCompare(String(b.name || ""));
  dhcpRangesOfNetwork(netId: string): any[] { return this._byFk("dhcpRanges", "network_id", netId); }
  dhcpRangesOfServer(eqId: string): any[] { return this._byFk("dhcpRanges", "server_id", eqId); }
  ipAddressByValue(addr: string): any { const r = this._byFk("ipAddresses", "address", addr); return r.length ? r[0] : null; }
  networksOfIpNetwork(ipNetId: string): any[] { return this._byFk("networks", "ip_network_id", ipNetId); }
  unrackedEquipments(): any[] {
    return this.data.equipments.filter((e) => !e.inventory_only && e.placement_mode !== "floor" && !(e.placement_mode === "side" && e.rack_id) && !(e.placement_mode === "wall" && e.rack_id) && !(e.placement_mode === "tray" && e.tray_item_id) && (e.placement_mode !== "rack" || !e.rack_id));
  }
  faceImageUsageCount(imageId: string): number {
    const s = new Set<string>();
    Object.values(EQUIP_FACE_IMG_FIELD).forEach((fld) => this._byFk("equipments", fld, imageId).forEach((e) => s.add(e.id)));
    return s.size;
  }
  hasFaceImageRefs(): boolean { return this.data.equipments.some((e) => Object.values(EQUIP_FACE_IMG_FIELD).some((fld) => e[fld])); }
  faceImageRefIds(): Set<string> { const s = new Set<string>(); this.data.equipments.forEach((e) => Object.values(EQUIP_FACE_IMG_FIELD).forEach((fld) => { if (e[fld]) s.add(e[fld]); })); return s; }
  portFamily(port: any): string | null {
    if (!port || !port.port_type_id) return null;
    const pt = this.get("portTypes", port.port_type_id);
    return pt ? pt.family : null;
  }
  cableCompatible(cableTypeId: string, fromPortId: string, toPortId: string): { ok: boolean; reason?: string } {
    const ct = this.get("cableTypes", cableTypeId);
    const pf = this.portFamily(this.get("ports", fromPortId));
    const pt = this.portFamily(this.get("ports", toPortId));
    if (!ct) return { ok: false, reason: I18n.t("analysis.cable.typeMissing") };
    if (!pf || !pt) return { ok: false, reason: I18n.t("analysis.cable.portTypeMissing") };
    if (ct.family !== pf || ct.family !== pt) {
      return { ok: false, reason: I18n.t("analysis.cable.incompatible", { family: ct.family, pf, pt }) };
    }
    return { ok: true };
  }
  equipmentOfPort(portId: string): any {
    const p = this.get("ports", portId);
    return p ? this.get("equipments", p.equipment_id) : null;
  }

  /** Kind d'un port (data/power) : type de port sinon rôle. null si port absent. */
  portKind(port: any): "data" | "power" | null {
    if (!port) return null;
    const pt = port.port_type_id ? this.get("portTypes", port.port_type_id) : null;
    return pt ? (pt.kind === "power" ? "power" : "data") : PortRoles.kind(port.role);
  }

  /** Taille (mm) du connecteur physique émergent. Une LANE de breakout hérite du connecteur du TRUNK. */
  portConnectorSize(port: any): { w: number; h: number } {
    if (port && port.parent_port_id) { const par = this.get("ports", port.parent_port_id); if (par) port = par; }
    const pt = (port && port.port_type_id) ? this.get("portTypes", port.port_type_id) : null;
    const key = pt ? (pt.connector || pt.family) : null;
    return (key && PORT_CONNECTOR_MM[key]) ? PORT_CONNECTOR_MM[key] : PORT_CONNECTOR_DEFAULT;
  }

  /* ---- placement : CONTENEUR (la clé « salle », GÉNÉRALISÉE) ----

     ⚠ CE BLOC A REMPLACÉ UN TRIO HISTORIQUE, `equipmentDcId`/`portDcId`/`cableDcId`, RETIRÉ ICI MÊME
     (doctrine `docs/placement.md` §6.33, décision D5 du chantier « câblage des équipements d'étage »).
     Ces trois méthodes rendaient un ID DE SALLE : elles PROJETAIENT la chaîne d'attache du contenu sur
     son seul maillon « salle » et jetaient le reste. Un équipement posé sur un ÉTAGE — dont la chaîne
     (`floor` → `building`) est pourtant parfaitement valide — s'en voyait déclarer NULLE PART, pour la
     seule raison qu'aucun de ses maillons ne s'appelle `room`. C'était la cause unique du blocage
     « les équipements d'étage ne sont pas câblables » (§6.4), et leur RETRAIT est ce qui a fait
     désigner par le COMPILATEUR les derniers appelants, plutôt que par un relevé à la main.

     ⚠ NE PAS LES RÉTABLIR SOUS UN AUTRE NOM. La salle est UN maillon de la chaîne, pas l'identité d'un
     placement : une primitive de store qui la projette redevient aussitôt la réponse par défaut de
     « où est cet objet ? », et le cas particulier repousse. Un site qui a réellement besoin d'un repère
     SALLE — c'est légitime, la résolution en salle est la règle et le MONDE l'exception (§6.20) — lit
     le conteneur et le RESTREINT SUR PLACE (`kind === "room"`), ce qui rend l'hypothèse visible à la
     lecture et vérifiée par `tsc` (l'union est discriminée). Les trois chemins salle de
     `DcInteract.locateEquipment`/`locatePort`/`locateCable` sont les seuls à le faire.

     ⚠ DEUX QUESTIONS DISTINCTES, DEUX MÉTHODES — ne pas les confondre. `equipmentContainer` rend le
     conteneur IMMÉDIAT (la BAIE d'un serveur monté, l'ÉTAGÈRE d'un boîtier posé) ; `equipmentNamedContainer`
     (plus bas) rend le conteneur de niveau CHAÎNE — la salle traversée, sinon l'étage immédiat. C'est ce
     SECOND qui généralise l'ancien `equipmentDcId`, et c'est lui que consomment la grammaire de route,
     le tracé, les libellés et les chemins salle de « Localiser ». Le premier ne répond QUE de l'attache
     immédiate (contraintes de dépose, dégradation d'un câble) : l'employer là où l'on attend une salle
     déclarerait « non placé » tout équipement monté en baie.

     ⚠ Comparer deux conteneurs se fait avec `PlacementContainers.same`, JAMAIS par égalité d'id :
     l'identité d'un ÉTAGE est le COUPLE (bâtiment, étage) et un étage non configuré n'a pas d'id. */

  /** Conteneur IMMÉDIAT d'un équipement (baie, étagère, salle, étage…), ou null s'il n'est attaché à
      rien de localisable (« pool »). ⚠ PAS la salle : cf. l'avertissement ci-dessus. */
  equipmentContainer(eqOrId: any): PlacementContainer | null {
    const eq = (typeof eqOrId === "object") ? eqOrId : this.get("equipments", eqOrId);
    return PlacementContainers.of(eq);
  }

  /** Conteneur IMMÉDIAT où se résout un PORT : celui de son équipement porteur (l'historique `portDcId`
      en projetait la salle ; il est RETIRÉ, §6.33). */
  portContainer(portId: string | null): PlacementContainer | null {
    const p: any = this.get("ports", portId);
    return p ? this.equipmentContainer(p.equipment_id) : null;
  }

  /** Conteneur où se résout un CÂBLE : celui de la PREMIÈRE extrémité localisable — même règle de
      priorité que l'historique `cableDcId` (A puis B, RETIRÉ §6.33), pour que la généralisation n'ait
      pas déplacé le cadrage d'un câble dont les deux bouts sont placés. */
  cableContainer(cableOrId: any): PlacementContainer | null {
    const c: any = (typeof cableOrId === "object") ? cableOrId : this.get("cables", cableOrId);
    if (!c) return null;
    return this.portContainer(c.from_port_id) || this.portContainer(c.to_port_id);
  }

  /* ---- placement : « cet objet est-il LOCALISABLE ? » (véracité des boutons « Localiser ») ----

     ⚠ CE N'EST PAS `!!equipmentContainer(x)`. Un contenu peut avoir un conteneur parfaitement valide et
     rester injoignable par la vue : une baie HORS SALLE en donne un (`kind: "rack"`) sans qu'aucune salle
     n'apparaisse dans sa chaîne, et un posé d'ÉTAGE d'un bâtiment SANS SALLE en donne un que la portée
     d'affichage — exprimée en salles — ne peut pas atteindre. La règle vit donc UNE FOIS, dans
     `core/Locatable`, dont ces deux méthodes ne sont que le point d'entrée depuis le store (même patron
     de délégation que le trio « conteneur » ci-dessus vers `src-shared/PlacementContainers`). */

  /** L'équipement est-il localisable en 3D ? Prédicat des boutons « Localiser » — MIROIR des refus de
      `DcInteract.locateEquipment` (verrouillé par un test d'équivalence). A remplacé le prédicat
      historique `!!equipmentDcId` (RETIRÉ §6.33), qui cachait le bouton d'un posé d'ÉTAGE alors que
      l'action aboutit (doctrine §6.27 puis §6.28). */
  equipmentLocatable(eqOrId: any): boolean { return Locatable.equipment(eqOrId, this); }

  /** Le PORT est-il localisable en 3D ? Même règle que son équipement porteur (a remplacé `!!portDcId`). */
  portLocatable(portId: string | null): boolean { return Locatable.port(portId, this); }

  /** La LIAISON est-elle localisable en 3D ? A remplacé `!!cableDcId`, qui ne reconnaissait qu'une
      extrémité posée en SALLE et cachait donc le bouton d'un câble aboutissant sur un ÉTAGE. */
  cableLocatable(cableOrId: any): boolean { return Locatable.cable(cableOrId, this); }

  /** Extrémité RETENUE pour cadrer une liaison : le port de la première extrémité localisable (A puis B).
      ⚠ C'est la MÊME méthode que consomme `DcInteract.locateCable` — le prédicat ci-dessus n'est que
      « cette extrémité existe-t-elle ? », si bien que bouton et action ne peuvent pas diverger. */
  cableLocatableEnd(cableOrId: any): string | null { return Locatable.cableEnd(cableOrId, this); }

  /* ---- placement : « comment s'appelle l'endroit de cet objet ? » (LIBELLÉS) ----

     ⚠ ENCORE UNE AUTRE QUESTION que les deux blocs précédents, et c'est pourquoi c'est un TROISIÈME
     module. `equipmentContainer` rend le conteneur IMMÉDIAT (une baie, une étagère) ; `equipmentLocatable`
     dit si la VUE 3D peut le montrer. Nommer, c'est lire la CHAÎNE : le conteneur immédiat d'un serveur
     monté est sa baie, mais l'utilisateur veut lire « Salle A » — ce qu'affichait l'expression historique
     `dcName(equipmentDcId(x))`. La règle vit UNE FOIS dans `core/ContainerLabel` (doctrine §6.29).

     ⚠ CE MODULE PORTE DÉSORMAIS PLUS QUE DES LIBELLÉS, et son nom est en retard sur son emploi : la
     GRAMMAIRE DE ROUTE (§6.31), le TRACÉ des faisceaux et les chemins salle de « Localiser » (§6.33)
     consomment `equipmentNamedContainer` comme LEUR conteneur de référence — c'est lui, et non
     `equipmentContainer`, qui a succédé à `equipmentDcId`. Le renommer (`equipmentChainContainer` ?)
     est une dette de nommage assumée, pas un lot du chantier de câblage. */

  /** Conteneur de niveau CHAÎNE d'un équipement : la SALLE traversée, sinon l'ÉTAGE immédiat, sinon null.
      C'est la GÉNÉRALISATION EXACTE de l'historique `equipmentDcId` (RETIRÉ §6.33) : même verdict sur
      tous les modes de placement existants, une réponse EN PLUS pour le mode `floor`. */
  equipmentNamedContainer(eqOrId: any): PlacementContainer | null { return ContainerLabel.ofEquipment(eqOrId, this); }

  /** Libellé d'un conteneur nommé (« Salle A », « Bât. X · ét. 1 »), null s'il n'y a rien à nommer.
      Les replis d'absence restent chez l'appelant — ils diffèrent d'un site à l'autre (« non placé »,
      « ? », suffixe vide), et les uniformiser changerait des libellés existants. */
  containerLabel(container: PlacementContainer | null): string | null { return ContainerLabel.label(container, this); }

  /** Raccourci des sites qui n'ont qu'un équipement en main. A remplacé `dcName(equipmentDcId(x))`. */
  equipmentContainerLabel(eqOrId: any): string | null { return ContainerLabel.ofEquipmentLabel(eqOrId, this); }

  /* ---- faisceaux (trunks) : pool de fibres pioché par les PORTS des patchs d'extrémité ---- */

  /** Ports de PATCH piochant dans ce faisceau (bundle_id + strand_a/strand_b sur le Port). Indexé (_byFk). */
  portsOfBundle(bundleId: string | null): any[] { return bundleId ? this._byFk("ports", "bundle_id", bundleId) : []; }
  /** Brins PHYSIQUES occupés d'un faisceau : brins piochés par ses ports de patch (strand_a/strand_b). Un n°
      de fibre affecté aux 2 extrémités du trunk ne compte qu'UNE fois (Set) — c'est une seule fibre physique. */
  usedStrandsOfBundle(bundleId: string): Set<number> {
    const used = new Set<number>();
    for (const p of this.portsOfBundle(bundleId)) {
      if (p.strand_a != null) used.add(p.strand_a);
      if (p.strand_b != null) used.add(p.strand_b);
    }
    return used;
  }
  /** Numéro de fibre le PLUS ÉLEVÉ pioché dans un faisceau (0 si aucun) — plancher de réduction de fiber_count (on ne
      peut pas descendre le nb de brins sous un n° déjà utilisé). Mutualise le calcul dupliqué hint ⇄ garde (CableForms). */
  maxUsedStrandOfBundle(bundleId: string): number {
    const used = this.usedStrandsOfBundle(bundleId);
    return used.size ? Math.max(...used) : 0;
  }
  /** waypoint_ids EFFECTIFS d'une liaison — accepte un câble OU un draft { waypoint_ids? } (ex. le pseudo-câble
      de TrunkRouting, qui porte la route de SON trunk). Point d'extension conservé : toute la grammaire de route
      (cableRoute, cableWaypointsIn…) passe par ici. */
  effectiveWaypointIds(c: any): string[] {
    return c ? (c.waypoint_ids || []) : [];
  }
  /** Occupation d'un trunk : { used, capacity, free, nextStrand } (1er n° de fibre PHYSIQUE libre).
      `used`/`free` en FIBRES ; base = affectations de brins des ports de patch. */
  bundleOccupancy(bundleId: string): { used: number; capacity: number; free: number; nextStrand: number } {
    const b = this.get("cableBundles", bundleId); if (!b) return { used: 0, capacity: 0, free: 0, nextStrand: 1 };
    const used = this.usedStrandsOfBundle(bundleId);
    let next = 1; while (used.has(next)) next++;
    return { used: used.size, capacity: b.fiber_count, free: Math.max(0, b.fiber_count - used.size), nextStrand: next };
  }

  /* ---- DÉDUCTION RÉSEAU (multi-hop) — architecture : docs/deduction-reseau.md ----
     Le réseau vit sur les ports d'équipement TERMINAL (source unique) et se DÉDUIT le long du chemin. Graphe non
     orienté à 2 types d'arêtes : (a) JUMPER — un câble relie from_port↔to_port ; (b) BRIN — dans un faisceau,
     2 ports de patch partageant une même fibre PHYSIQUE (même strand) sont reliés. Le réseau déduit d'un ensemble
     de ports = union des `network_ids` de TOUS les ports terminaux de sa COMPOSANTE connexe (multi-hop : traverse
     patchs et brassages patch↔patch). Garde-cycle : visited-set sur les ports. Un port de patch n'assert rien
     (network_ids vide) → il déduit. `network_ids` vide sur un port terminal = JOKER (adopte le déduit). */
  /** Réseau déduit d'un ensemble de ports de départ : { ids: union des réseaux des composantes touchées ; primary:
      le réseau PRINCIPAL déterministe }. Le PRINCIPAL est STABLE (indépendant de l'ordre de parcours) : `network_id`
      (principal choisi par l'utilisateur) du port assertant d'`id` minimal — sinon son 1er `network_ids`. → deux
      câbles d'une même liaison obtiennent la MÊME couleur, et le choix de principal du port est honoré.
      Mono-composante (un câble RÉEL : ses 2 ports sont déjà reliés par le câble lui-même) → résultat MÉMOÏSÉ O(1).
      Multi-composantes (aperçu d'un câble PAS ENCORE créé, cf. CableForms.renderNets — les 2 ports ne sont pas encore
      reliés) → union des composantes, NON mémoïsée : rien ne les relie dans le graphe réel, mémoïser l'union
      polluerait chaque composante avec le réseau de l'autre (couleurs/étoile/légende faux jusqu'à mutation — N3). */
  deducedNetwork(startPortIds: (string | null | undefined)[]): { ids: string[]; primary: string | null } {
    const seeds = startPortIds.filter((x): x is string => !!x);
    if (!seeds.length) return { ids: [], primary: null };
    // une COMPOSANTE PURE par graine (mémoïsée) ; des graines CONNECTÉES partagent le MÊME objet → dédup par référence.
    const comps: Array<{ ids: string[]; primary: string | null; primaryPort: string | null }> = [];
    for (const s of seeds) { const comp = this._componentOf(s); if (comps.indexOf(comp) === -1) comps.push(comp); }
    if (comps.length === 1) return comps[0];   // graines dans la MÊME composante (câble réel / lookup mono-port) → mémoïsé
    // graines DISJOINTES (aperçu) : union SANS mémoïsation. Principal = celui de la composante au port assertant d'id
    // minimal (même règle déterministe, appliquée à travers les composantes).
    const ids: string[] = [];
    let primary: string | null = null, primaryPort: string | null = null;
    for (const comp of comps) {
      for (const nid of comp.ids) if (ids.indexOf(nid) === -1) ids.push(nid);
      if (comp.primaryPort !== null && (primaryPort === null || comp.primaryPort < primaryPort)) { primaryPort = comp.primaryPort; primary = comp.primary; }
    }
    return { ids, primary };
  }
  /** Composante connexe PURE d'UN port (BFS mono-graine sur le graphe réel : arêtes JUMPER = câble, BRIN = même fibre
      physique d'un faisceau). Mémoïsée SOUS CHAQUE port visité — une entrée de cache = UNE composante pure (cf.
      _netCache / N3). `primaryPort` = port assertant d'id minimal (fixe le principal, et permet l'union multi-graines).
      Garde-cycle : `seen`. NE PAS appeler avec des graines de composantes différentes — c'est le rôle du wrapper
      `deducedNetwork` (qui unionne sans mémoïser). */
  private _componentOf(startId: string): { ids: string[]; primary: string | null; primaryPort: string | null } {
    const hit = this._netCache.get(startId); if (hit) return hit;   // O(1) si la composante est déjà calculée
    const seen = new Set<string>();
    const nets: string[] = [];
    const addNet = (nid: string) => { if (nid && !nets.includes(nid)) nets.push(nid); };
    let primaryPort: string | null = null, primary: string | null = null;   // port assertant d'id minimal
    const queue: string[] = [startId];
    for (let head = 0; head < queue.length; head++) {   // curseur (pas de shift() O(n)) ; seen dédoublonne
      const pid = queue[head];
      if (seen.has(pid)) continue; seen.add(pid);
      const port: any = this.get("ports", pid); if (!port) continue;
      const pnets: string[] = port.network_ids || [];
      if (pnets.length) {   // assertion du port terminal (patch : vide → joker)
        for (const nid of pnets) addNet(nid);
        if (primaryPort === null || pid < primaryPort) { primaryPort = pid; primary = port.network_id || pnets[0]; }
      }
      for (const c of this.cablesOfPort(pid)) {                    // arête JUMPER : autre extrémité du câble
        const other = (c.from_port_id === pid) ? c.to_port_id : c.from_port_id;
        if (other && !seen.has(other)) queue.push(other);
      }
      // arête BRIN : deux ports partageant une fibre PHYSIQUE (même strand) sont reliés. L'unicité « 1 brin par
      // extrémité » (sinon deux circuits fusionneraient à tort) est garantie en amont par V6 (DataValidation ports/scope).
      if (port.bundle_id && (port.strand_a != null || port.strand_b != null)) {
        const mine = PortStrands.of(port);
        for (const q of this.portsOfBundle(port.bundle_id)) {
          if (q.id === pid || seen.has(q.id)) continue;
          if (mine.includes(q.strand_a) || mine.includes(q.strand_b)) queue.push(q.id);
        }
      }
    }
    // résultat identique pour TOUTE la composante → mémoïsé sous chaque port visité (invalidé au _emit / _reindex).
    // `ids` est GELÉ : l'objet est PARTAGÉ par tous les ports de la composante ET tous les appelants — un futur
    // `ids.sort()`/`push` chez un appelant corromprait silencieusement la composante (note perf « cache par référence »).
    const result = { ids: Object.freeze(nets) as string[], primary, primaryPort };
    for (const pid of seen) this._netCache.set(pid, result);
    return result;
  }
  /** Réseaux déduits d'un ensemble de ports (union de la composante). */
  deducedNetworkIds(startPortIds: (string | null | undefined)[]): string[] { return this.deducedNetwork(startPortIds).ids; }
  /** Ports assertant un réseau (indexé) — déduction inverse / listes. */
  portsOfNetwork(networkId: string): any[] {
    const out = this._byFk("ports", "network_ids", networkId);
    this._byFk("ports", "network_id", networkId).forEach((p) => { if (!out.includes(p)) out.push(p); });
    return out;
  }

  /* ---- câbles : réseaux / complétude ---- */

  /** Réseaux DÉDUITS d'un câble (depuis ses 2 ports, propagés le long du chemin). Source unique = ports terminaux. */
  cableNetworkIds(c: any): string[] { return c ? this.deducedNetwork([c.from_port_id, c.to_port_id]).ids : []; }
  /** Réseau PRINCIPAL déduit d'un câble (pilote la couleur) — STABLE le long d'une même liaison. null = indéfini. */
  cablePrimaryNetworkId(c: any): string | null { return c ? this.deducedNetwork([c.from_port_id, c.to_port_id]).primary : null; }
  /** Câble « complet » : 2 ports distincts + type + compatibilité OK. */
  cableIsComplete(c: any): boolean {
    if (!c || !c.from_port_id || !c.to_port_id || !c.cable_type_id || c.from_port_id === c.to_port_id) return false;
    return this.cableCompatible(c.cable_type_id, c.from_port_id, c.to_port_id).ok;
  }
  /** Le câble transporte-t-il de l'ÉNERGIE (→ éclair) ? Vrai si son TYPE est de genre `power`, OU s'il relie DEUX
      ports PoE dont l'injection (PSE) / la consommation (PD) est ACTIVÉE des DEUX côtés (poe_enabled). Prédicat
      PARTAGÉ : scène 2D/3D (via CableRouting), listing (EntityViz.cableLink), fiches (câble / équipement) et tooltip. */
  cableCarriesPower(c: any): boolean {
    if (!c) return false;
    const t: any = c.cable_type_id ? this.get("cableTypes", c.cable_type_id) : null;
    if (t && t.kind === "power") return true;
    return this._portPoeActive(c.from_port_id) && this._portPoeActive(c.to_port_id);
  }
  /** Port PoE dont l'injection/consommation est active (rôle "poe" + poe_enabled ≠ false). */
  private _portPoeActive(portId: string | null): boolean {
    const p: any = portId ? this.get("ports", portId) : null;
    return !!(p && p.role === "poe" && p.poe_enabled !== false);
  }

  /* ---- waypoints : pose ---- */

  /** Un waypoint est-il posé (coordonnées complètes pour sa forme) ? */
  waypointIsPlaced(wp: any): boolean {
    if (!wp) return false;
    if (wp.kind === "brush") { const rk = wp.rack_id ? this.get("racks", wp.rack_id) : null; return !!(rk && rk.datacenter_id); }
    if (wp.kind === "point" && wp.rack_id && wp.side_lr != null) { const rk = this.get("racks", wp.rack_id); return !!(rk && rk.datacenter_id); }
    if (wp.kind === "point" && wp.rack_id && wp.cap_face) { const rk = this.get("racks", wp.rack_id); return !!(rk && rk.datacenter_id); }
    return wp.dc_x != null && wp.dc_y != null && (wp.kind !== "segment" || (wp.dc_x2 != null && wp.dc_y2 != null));
  }

  /* ---- route d'un câble (grammaire exit/OOB) ---- */

  /** Waypoints EFFECTIFS d'un câble posés dans `dcId`, dans l'ordre du trajet A→B. */
  cableWaypointsIn(cable: any, dcId: string): any[] {
    return this.effectiveWaypointIds(cable)
      .map((id) => this.get("waypoints", id))
      .filter((w) => w && w.datacenter_id === dcId && this.waypointIsPlaced(w));
  }

  /* La GRAMMAIRE DE ROUTE (automate exit/OOB) et les CONTRAINTES de câblage vivent dans `CableRouteAnalyzer`
     (pure lecture, couplage par l'interface RouteStoreView que ce Store implémente structurellement).
     Le Store DÉLÈGUE pour préserver son API publique — les vues/outils/tests appellent `store.cableRoute(...)`
     comme avant ; le détail est consultable (et testable) sur `store.routes`. */
  readonly routes: RouteAnalyzerImpl = new RouteAnalyzerImpl(this);

  /** Conteneur du bout A|B d'un câble (null = port absent OU équipement rattaché à rien de traversable). */
  cableEndContainer(cable: any, side: "A" | "B"): PlacementContainer | null { return this.routes.cableEndContainer(cable, side); }
  /** Analyse de la route (grammaire + cohérence des bouts posés) — cf. CableRouteAnalyzer.cableRoute. */
  cableRoute(cable: any): RouteAnalysisT { return this.routes.cableRoute(cable); }
  /** Analyse de la route d'un FAISCEAU : grammaire + cohérence des EXTRÉMITÉS (sens aligné/inversé) — cf. CableRouteAnalyzer.bundleRoute. */
  bundleRoute(bundle: any): BundleRouteAnalysisT { return this.routes.bundleRoute(bundle); }
  /** Violation de COHÉRENCE DE SALLE (« exit terminal ») ? — cf. CableRouteAnalyzer. */
  routeHasRoomBreak(cable: any): boolean { return this.routes.routeHasRoomBreak(cable); }
  /** Première erreur STRUCTURELLE de route, ou null — cf. CableRouteAnalyzer. */
  routeStructuralError(cable: any): RouteErrorT | null { return this.routes.routeStructuralError(cable); }
  /** Contrainte de CONTENEUR d'un BOUT ("A"|"B"), évaluée SANS son port — cf. CableRouteAnalyzer. */
  cableSideConstraint(cable: any, side: "A" | "B"): { container: PlacementContainer | null; onlyUnplaced: boolean; route: RouteAnalysisT } { return this.routes.cableSideConstraint(cable, side); }
  /** Résumé lisible de la route : « ◆ Salle A → ⏏ Salle A → ◎ ét. 1 → ⏏ Salle B ». */
  cableRouteSummary(r: any): string { return this.routes.cableRouteSummary(r); }
  /** Nom d'une salle (datacenter) — "?" si absente, "(salle)" si sans nom. */
  dcName(dcId: string | null): string { return this.routes.dcName(dcId); }
  /** Statut MAXIMAL d'un câble : brouillon → planifié → câblé — cf. CableRouteAnalyzer. */
  cableMaxStatus(cable: any): string { return this.routes.cableMaxStatus(cable); }
  /** Le statut `statusId` est-il ≤ au maximum `maxId` ? */
  cableStatusFits(statusId: string, maxId: string): boolean { return this.routes.cableStatusFits(statusId, maxId); }

  /* ---- contrainte physique de placement (câblage) — logique dans CableRouteAnalyzer, délégations ---- */

  /** Conteneurs où un câble POSÉ contraint l'équipement à être, et les câbles qui l'imposent — cf. CableRouteAnalyzer. */
  equipmentRequiredContainers(eqId: string): Array<{ container: PlacementContainer; cables: any[] }> { return this.routes.equipmentRequiredContainers(eqId); }
  /** Motif de blocage du placement dans la salle cible (null = autorisé) — cf. CableRouteAnalyzer. */
  equipmentPlacementBlockedReason(eqId: string, targetDcId: string): string | null { return this.routes.equipmentPlacementBlockedReason(eqId, targetDcId); }
  /** Idem pour un RACK entier (vérifie chaque équipement monté en U). null = autorisé. */
  rackPlacementBlockedReason(rackId: string, targetDcId: string): string | null { return this.routes.rackPlacementBlockedReason(rackId, targetDcId); }
  /* ⚠ `equipmentContext` A DISPARU (doctrine §6.31), et ce n'est pas un oubli. Elle rendait « le contexte
     physique » d'un équipement sous forme de chaîne — un id de salle, ou « floor:<bâtiment>:<étage> » —
     c'est-à-dire une SECONDE écriture de la question à laquelle `equipmentNamedContainer` répond déjà, et
     une identité d'étage ENCODÉE à la main (avec le `String(x || "")` qui écrase le rez-de-chaussée). Les
     appelants lisent désormais `equipmentNamedContainer` et comparent par `PlacementContainers.same`. */
  /** Un câble est-il valide compte tenu des conteneurs physiques de ses deux bouts ? — cf. CableRouteAnalyzer. */
  cableContextValid(c: any): boolean { return this.routes.cableContextValid(c); }
  /** Patchs de CASSE des câbles dont la route n'est plus valide après (dé)placement — cf. CableRouteAnalyzer. */
  cableBreakOps(eqId: string): Array<{ collection: string; id: string; patch: Record<string, any> }> { return this.routes.cableBreakOps(eqId); }
  /** Applique `cableBreakOps` en une transaction ; renvoie le nb de câbles cassés. (ÉCRITURE → reste au Store.) */
  async applyCableBreaks(eqId: string): Promise<number> {
    const ops = this.cableBreakOps(eqId);
    if (ops.length) await this.updateBatch(ops);
    return ops.length;
  }
  /** Patchs de DÉGRADATION (« câblé » → « planifié ») des câbles quittant leur salle — cf. CableRouteAnalyzer. */
  cableDowngradeOps(eqIds: string[]): Array<{ collection: string; id: string; patch: Record<string, any> }> { return this.routes.cableDowngradeOps(eqIds); }

  /** SUPPRESSION D'UN SITE (décommissionnement / déménagement) — cascade SCOPÉE au site, conçue pour
      PRÉSERVER les LIAISONS LOGIQUES (port↔port) afin de re-placer les baies ailleurs sans recâbler :
      1. câbles des équipements du site (en baie ou libres en salle) « câblé / à-remplacer » → « planifié »
         (liaison logique conservée) ;
      2. équipements d'ÉTAGE du site : COMPLÈTEMENT décâblés (câbles SUPPRIMÉS) + dé-placés ;
      3. tous les WAYPOINTS du site (salles + niveau étage/OOB) SUPPRIMÉS → les routes inter-DC les
         traversant sont débranchées (la cascade waypoint retire leur id des routes) ;
      4. ÉTAGES (floors) et SALLES (datacenters) du site SUPPRIMÉS ; supprimer une salle remet ses baies
         « non placé » (cascade datacenters) et dé-place ses équipements libres ;
      5. baies encore marquées de ce site (champ location) → location vidée (pool propre) ;
      6. l'entité site est supprimée.
      NB : opération en plusieurs étapes (plusieurs entrées d'undo) — choix de cohérence sur la facilité. */
  async removeSite(siteId: string): Promise<void> {
    if (!this.get("sites", siteId)) return;
    const dcIds = new Set(this.all("datacenters").filter((d) => (d.location || "") === siteId).map((d) => d.id));
    const inSiteRoom = (e: any) => { const rackDc = e.rack_id ? (this.get("racks", e.rack_id)?.datacenter_id ?? null) : null; return !!((rackDc && dcIds.has(rackDc)) || (e.dc_id && dcIds.has(e.dc_id))); };
    const floorEq = this.all("equipments").filter((e) => e.placement_mode === "floor" && (e.location || "") === siteId);
    // 1) liaisons logiques préservées : câbles des équipements en baie/salle du site → « planifié »
    const preserve = this.all("equipments").filter((e) => e.placement_mode !== "floor" && inSiteRoom(e)).map((e) => e.id);
    const ops = this.cableDowngradeOps(preserve);
    if (ops.length) await this.updateBatch(ops);
    // 2) équipements d'étage : câbles SUPPRIMÉS (décâblés) + dé-placés
    for (const e of floorEq) {
      for (const c of this.cablesOfEquipment(e.id)) await this.remove("cables", c.id);
      await this.update("equipments", e.id, { placement_mode: "manual", location: "", floor: "", floor_x: null, floor_y: null });
    }
    // 3) waypoints du site (salles + étage/OOB) → supprimés
    for (const w of this.all("waypoints").filter((w) => (w.datacenter_id != null && dcIds.has(w.datacenter_id)) || ((w.location || "") === siteId))) await this.remove("waypoints", w.id);
    // 4) étages + salles → supprimés (cascade : baies non-placées, équipements libres dé-placés)
    for (const f of this.all("floors").filter((f) => (f.location || "") === siteId)) await this.remove("floors", f.id);
    for (const d of this.all("datacenters").filter((d) => (d.location || "") === siteId)) await this.remove("datacenters", d.id);
    // 5) baies encore marquées de ce site → location vidée
    for (const r of this.all("racks").filter((r) => (r.location || "") === siteId)) await this.update("racks", r.id, { location: "" });
    // 6) le site
    await this.remove("sites", siteId);
  }
  /** Brouillons de câble (un seul bout) compatibles avec ce port — candidats à l'affectation au clic. */
  cableDraftCandidatesForPort(portId: string): any[] {
    const port = this.get("ports", portId); if (!port) return [];
    // CONTENEUR (et non plus salle) du port : un brouillon peut désormais s'affecter à un port d'équipement
    // posé sur un ÉTAGE, la contrainte de route sachant désigner un étage (doctrine §6.31).
    const fam = this.portFamily(port), monConteneur = this.equipmentNamedContainer(port.equipment_id);
    return this.all("cables").filter((c: any) => {
      if (c.status !== CABLE_STATUS_DRAFT) return false;
      const missA = !c.from_port_id, missB = !c.to_port_id;
      if (!missA && !missB) return false;
      if (c.from_port_id === portId || c.to_port_id === portId) return false;
      const ct = c.cable_type_id ? this.get("cableTypes", c.cable_type_id) : null;
      if (ct && fam && ct.family !== fam) return false;
      const otherPid = missA ? c.to_port_id : c.from_port_id;
      if (otherPid) { const f2 = this.portFamily(this.get("ports", otherPid)); if (f2 && fam && f2 !== fam) return false; }
      const fits = (side: "A" | "B") => { const k = this.cableSideConstraint(c, side); if (k.onlyUnplaced) return monConteneur == null; return !k.container || !monConteneur || PlacementContainers.same(k.container, monConteneur); };
      return (missA && fits("A")) || (missB && fits("B"));
    });
  }

  /* ---- import / remplacement complet (BULK légitime) ----
     Vis-à-vis de la garde G1 (docs/hydratation.md) : ces deux chemins passent PAR CONSTRUCTION, même si le
     corpus était partiel juste avant — `_hydrate` remplace le cache par un document COMPLET (l'import est
     un format d'échange autosuffisant ; un document neuf est complet et vide) et re-marque tout `full`
     AVANT `_persistAll`. Le remplacement TOTAL est ici l'INTENTION de l'appelant, pas un accident : le
     danger que G1 ferme est le snapshot DÉRIVÉ d'un cache incomplet, jamais l'import délibéré. */
  async replaceAll(raw: Snapshot | null): Promise<void> {
    this._hydrate(raw);
    this.syncCatalogs();   // réconcilie le catalogue (code = source de vérité) AVANT de persister → les nouvelles entrées partent dans l'écriture
    await this._persistAll();
    this._emit();
  }
  async newDocument(): Promise<void> {
    this._hydrate(null);
    this.meta = { docName: "", theme: this.meta.theme || "dark", graphLayout: null, graphLayouts: [], activeLayoutId: null, graphFrames: [] };
    this.seedCatalogs();
    await this._persistAll();
    this._emit();
  }
}
