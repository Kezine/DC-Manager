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
import { Id } from "../core/Id";
import { Text } from "../core/Text";
import { I18n } from "../i18n/I18n";
import { APP_RELEASE, EQUIP_FACE_IMG_FIELD, CABLE_STATUS_DRAFT, PORT_CONNECTOR_MM, PORT_CONNECTOR_DEFAULT, LOCATIONS, RACK_DEPTH_DEFAULT } from "../domain/constants";
import { Depths } from "../registries/Depths";
import { DEFAULT_PORT_TYPES, DEFAULT_CABLE_TYPES } from "../registries/defaultCatalogs";
import { Cascade, CascadeDelete, CascadeDetach } from "./cascadeSpec";
import { DataValidator, PortStrands } from "../../src-shared/DataValidation";
import type { ValidationError, EntityFetcher, ChildFinder } from "../../src-shared/DataValidation";
import { CableRouteAnalyzer as RouteAnalyzerImpl } from "./CableRouteAnalyzer";
import type { RouteError as RouteErrorT, RouteAnalysis as RouteAnalysisT } from "./CableRouteAnalyzer";

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

export interface ListStoreOptions {
  page?: number;
  pageSize?: number;
  query?: string;
  where?: Record<string, any> | null;
  /** Filtre non sérialisable (résolu côté client sur le cache). */
  filter?: ((o: any) => boolean) | null;
  /** Champs de recherche explicites (sinon toutes les valeurs sérialisées). */
  searchFields?: any[] | null;
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

  constructor(adapter: DataAdapter) {
    this.adapter = adapter;
    this.data = {};
    COLLECTIONS.forEach((c) => { this.data[c] = []; });
    this.meta = { docName: "", theme: "dark", graphLayout: null, graphLayouts: [], activeLayoutId: null, graphFrames: [] };
    this._idIndex = {};
    this._fk = {};
    this._listeners = [];
  }

  onChange(fn: () => void): void { this._listeners.push(fn); }
  private _emit(): void { this._netCache.clear(); this._listeners.forEach((fn) => { try { fn(); } catch (e) { console.warn(e); } }); }

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
  /** Garantit l'existence d'entités `sites` : seed des sites par défaut (anciennes LOCATIONS) sur un document
      vierge/legacy, + MIGRATION de tout `location` référencé qui n'a pas encore d'entité site (docs ≤ avant
      l'entité Site). Synchrone (en mémoire) — la persistance suit au prochain save. */
  private _ensureSites(): void {
    const have = new Set(this.data.sites.map((s: any) => s.id));
    const Cls = ENTITY_CLASSES.sites;
    const add = (id: string, name?: string) => { if (id && !have.has(id)) { this.data.sites.push(new Cls({ id, name: name || id })); have.add(id); } };
    if (!this.data.sites.length) LOCATIONS.forEach((l) => add(l.id, l.label));   // doc vierge/legacy → sites par défaut
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

  /* ---- init : charge depuis l'adapter. NE sème PAS si vide. ---- */
  async init(): Promise<this> {
    const raw = await this.adapter.load();
    if (raw) {
      this._hydrate(raw); this.restored = true;
      // Réconcilie les catalogues (types de port/câble — le CODE est la source de vérité) sur le document CHARGÉ,
      // pas seulement sur un document neuf : sinon les entrées AJOUTÉES au code n'apparaissent jamais dans un
      // document existant (selects sans la nouveauté) et, en mode API, une référence à un type neuf échouerait
      // (`ref_missing` côté serveur, car il n'y serait pas persisté). Persiste UNIQUEMENT si quelque chose a changé
      // → écriture one-shot après une mise à jour du catalogue, no-op ensuite (upsert idempotent).
      if (this.syncCatalogs()) await this._persistAll();
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
    if (!targets.length) return [];
    // Chaque collection en UNE page (document complet de cette collection). En parallèle : I/O réseau indépendantes.
    await Promise.all(targets.map(async (c) => {
      const res = await this.adapter.list(c, { pageSize: PAGE_SIZE_ALL });
      const Cls = ENTITY_CLASSES[c];
      this.data[c] = (res.rows || []).map((o: RawRecord) => new Cls(o));
    }));
    if (targets.includes("equipments")) this._migrateDepths();   // rechargement granulaire : re-migrer les profondeurs legacy
    targets.forEach((c) => this._reindexCollection(c));   // index reconstruits pour les seules collections rechargées
    this.restored = true;
    return targets;
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
  async list(collection: string, { page = 1, pageSize = PAGE_SIZE_DEFAULT, query = "", where = null, filter = null, searchFields = null }: ListStoreOptions = {}): Promise<any> {
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
    const res = await this.adapter.list(collection, { page, pageSize, query, where });
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
  async countOf(collection: string, where: Record<string, any> | null = null): Promise<number> { return this.adapter.count(collection, where); }

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
    // valide le RÉSULTAT fusionné AVANT de muter (abort propre, aucune mutation partielle si invalide).
    if (!this.accepts(collection, { ...obj.toJSON(), ...normalizedPatch })) return null;
    this._applyPatch(collection, obj, normalizedPatch);
    await this.adapter.updateOne(collection, id, obj.toJSON());
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
    if (updates!.length) { await this.adapter.transact({ updates }); this._emit(); }
    return updates!.length;
  }
  async remove(collection: string, id: string): Promise<void> {
    // 1. calcule la cascade AVANT toute mutation
    const { deletes, detaches } = this._cascadePlan(collection, id);
    // 2. applique en mémoire : détachements puis suppressions (index incrémental)
    detaches.forEach((d) => {
      const o = this.get(d.c, d.id);
      if (o) this._withReindex(d.c, o, (x) => { x[d.key] = ("value" in d) ? d.value : null; if (x.touch) x.touch(); });
    });
    const delByColl: Record<string, Set<string>> = {};
    deletes.concat([{ c: collection, id }]).forEach((d) => { (delByColl[d.c] = delByColl[d.c] || new Set()).add(d.id); });
    Object.keys(delByColl).forEach((c) => {
      delByColl[c].forEach((did) => {
        const o = this._idIndex[c].get(did);
        if (o) { if (this._fk[c]) this._fk[c].remove(o); this._idIndex[c].delete(did); }
      });
      this.data[c] = this.data[c].filter((o) => !delByColl[c].has(o.id));
    });
    // 3. UNE transaction : détachements (updates) + suppressions enfants + cible.
    const tx: Transaction = {
      updates: detaches.map((d) => { const o = this.get(d.c, d.id); return o ? { collection: d.c, id: d.id, record: o.toJSON() } : null; }).filter(Boolean) as Transaction["updates"],
      deletes: deletes.map((d) => ({ collection: d.c, id: d.id })).concat([{ collection, id }]),
    };
    await this.adapter.transact(tx);
    this._emit();
  }

  /* Plan de cascade (intégrité référentielle) : entités à SUPPRIMER + à DÉTACHER. Délègue au calcul
     PARTAGÉ `Cascade.plan` (même logique côté serveur sur `DELETE`), alimenté par nos capacités
     injectées : résolutions inverses via les index secondaires (`recordFinder`), lecture via `entityFetcher`. */
  private _cascadePlan(collection: string, id: string): { deletes: CascadeDelete[]; detaches: CascadeDetach[] } {
    return Cascade.plan(collection, id, this.recordFinder, this.entityFetcher);
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
    this._emit();
    return copy;
  }

  /* ---- helpers métier (résolution inverse via index secondaires) ---- */
  portsOf(equipmentId: string): any[] { return this._byFk("ports", "equipment_id", equipmentId); }
  aggregatesOf(equipmentId: string): any[] { return this._byFk("aggregates", "equipment_id", equipmentId); }
  /** Spares (pièces de rechange) attribués à un équipement. */
  sparesOfEquipment(equipmentId: string): any[] { return this._byFk("spares", "assigned_equipment_id", equipmentId); }
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
  /** Tous les groupes d'un équipement (primaire inclus), dédupliqués — source unique pour l'appartenance. */
  equipmentGroupIds(eq: any): string[] {
    let ids: string[] = Array.isArray(eq && eq.group_ids) ? eq.group_ids.filter((x: any): x is string => typeof x === "string" && !!x) : [];
    if (eq && eq.group_id) ids = [eq.group_id, ...ids.filter((x) => x !== eq.group_id)];   // primaire TOUJOURS en tête
    return [...new Set(ids)];
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
  /** Salles d'un étage (location + floor). */
  dcsOfFloor(location: string | null, floor: any): any[] { const f = String(floor != null ? floor : ""); return this.all("datacenters").filter((d) => (d.location || "") === (location || "") && String(d.floor || "") === f); }
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

  /* ---- placement : salle (datacenter) d'un équipement ---- */

  /** Salle (datacenter_id) d'un équipement, via sa baie hôte ou sa pose libre. null = hors salle. */
  equipmentDcId(eqOrId: any): string | null {
    const eq = (typeof eqOrId === "object") ? eqOrId : this.get("equipments", eqOrId);
    if (!eq) return null;
    if (eq.placement_mode === "floor") return null;   // posé sur un étage (hors DC)
    if ((eq.placement_mode === "side" || eq.placement_mode === "wall") && eq.rack_id) {
      const rack = this.get("racks", eq.rack_id);
      return (rack && rack.datacenter_id) ? rack.datacenter_id : null;
    }
    if (eq.dim_mode === "free") return eq.dc_id || null;
    if (eq.placement_mode === "rack" && eq.rack_id && eq.rack_u != null) {
      const rack = this.get("racks", eq.rack_id);
      return (rack && rack.datacenter_id) ? rack.datacenter_id : null;
    }
    return null;
  }

  /** Salle où se résout un PORT : celle de son équipement porteur. null = port inconnu ou équipement hors salle.
      Résolveur PARTAGÉ (vue 3D, boutons « Localiser ») — même règle que `equipmentDcId`. */
  portDcId(portId: string | null): string | null {
    const p: any = this.get("ports", portId);
    return p ? this.equipmentDcId(p.equipment_id) : null;
  }

  /** Salle où se résout un CÂBLE : première extrémité dont le port est localisable (parité avec
      `locateCable` de la vue 3D). null = aucune extrémité en salle → câble non localisable. */
  cableDcId(cableOrId: any): string | null {
    const c: any = (typeof cableOrId === "object") ? cableOrId : this.get("cables", cableOrId);
    if (!c) return null;
    return this.portDcId(c.from_port_id) || this.portDcId(c.to_port_id);
  }

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

  /** Salle du bout A|B d'un câble (null = port absent OU équipement non placé). */
  cableEndDcId(cable: any, side: "A" | "B"): string | null { return this.routes.cableEndDcId(cable, side); }
  /** Analyse de la route (grammaire + cohérence des bouts posés) — cf. CableRouteAnalyzer.cableRoute. */
  cableRoute(cable: any): RouteAnalysisT { return this.routes.cableRoute(cable); }
  /** Violation de COHÉRENCE DE SALLE (« exit terminal ») ? — cf. CableRouteAnalyzer. */
  routeHasRoomBreak(cable: any): boolean { return this.routes.routeHasRoomBreak(cable); }
  /** Première erreur STRUCTURELLE de route, ou null — cf. CableRouteAnalyzer. */
  routeStructuralError(cable: any): RouteErrorT | null { return this.routes.routeStructuralError(cable); }
  /** Contrainte de salle d'un BOUT ("A"|"B"), évaluée SANS son port — cf. CableRouteAnalyzer. */
  cableSideConstraint(cable: any, side: "A" | "B"): { dcId: string | null; onlyUnplaced: boolean; route: RouteAnalysisT } { return this.routes.cableSideConstraint(cable, side); }
  /** Résumé lisible de la route : « ◆ Salle A → ⏏ Salle A → ◎ ét. 1 → ⏏ Salle B ». */
  cableRouteSummary(r: any): string { return this.routes.cableRouteSummary(r); }
  /** Nom d'une salle (datacenter) — "?" si absente, "(salle)" si sans nom. */
  dcName(dcId: string | null): string { return this.routes.dcName(dcId); }
  /** Statut MAXIMAL d'un câble : brouillon → planifié → câblé — cf. CableRouteAnalyzer. */
  cableMaxStatus(cable: any): string { return this.routes.cableMaxStatus(cable); }
  /** Le statut `statusId` est-il ≤ au maximum `maxId` ? */
  cableStatusFits(statusId: string, maxId: string): boolean { return this.routes.cableStatusFits(statusId, maxId); }

  /* ---- contrainte physique de placement (câblage) — logique dans CableRouteAnalyzer, délégations ---- */

  /** Salles où un câble POSÉ contraint l'équipement à être : Map<dcId, cables[]> — cf. CableRouteAnalyzer. */
  equipmentRequiredDcs(eqId: string): Map<string, any[]> { return this.routes.equipmentRequiredDcs(eqId); }
  /** Motif de blocage du placement dans la salle cible (null = autorisé) — cf. CableRouteAnalyzer. */
  equipmentPlacementBlockedReason(eqId: string, targetDcId: string): string | null { return this.routes.equipmentPlacementBlockedReason(eqId, targetDcId); }
  /** Idem pour un RACK entier (vérifie chaque équipement monté en U). null = autorisé. */
  rackPlacementBlockedReason(rackId: string, targetDcId: string): string | null { return this.routes.rackPlacementBlockedReason(rackId, targetDcId); }
  /** Contexte physique d'un équipement : id de salle, « floor:loc:étage », ou null — cf. CableRouteAnalyzer. */
  equipmentContext(eq: any): string | null { return this.routes.equipmentContext(eq); }
  /** Un câble est-il valide compte tenu des contextes physiques de ses deux bouts ? — cf. CableRouteAnalyzer. */
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
    const fam = this.portFamily(port), myDc = this.equipmentDcId(port.equipment_id);
    return this.all("cables").filter((c: any) => {
      if (c.status !== CABLE_STATUS_DRAFT) return false;
      const missA = !c.from_port_id, missB = !c.to_port_id;
      if (!missA && !missB) return false;
      if (c.from_port_id === portId || c.to_port_id === portId) return false;
      const ct = c.cable_type_id ? this.get("cableTypes", c.cable_type_id) : null;
      if (ct && fam && ct.family !== fam) return false;
      const otherPid = missA ? c.to_port_id : c.from_port_id;
      if (otherPid) { const f2 = this.portFamily(this.get("ports", otherPid)); if (f2 && fam && f2 !== fam) return false; }
      const fits = (side: "A" | "B") => { const k = this.cableSideConstraint(c, side); if (k.onlyUnplaced) return myDc == null; return !k.dcId || !myDc || k.dcId === myDc; };
      return (missA && fits("A")) || (missB && fits("B"));
    });
  }

  /* ---- import / remplacement complet (BULK légitime) ---- */
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
