import { DataAdapter } from "../data/DataAdapter";
import { FieldIndex } from "../data/FieldIndex";
import { INDEX_SPEC, PAGE_SIZE_DEFAULT } from "../data/config";
import { RawRecord, Snapshot, Transaction } from "../data/types";
import { Entity } from "../models/Entity";
import { EntityRegistry } from "../models/EntityRegistry";
import { PortType } from "../models/PortType";
import { CableType } from "../models/CableType";
import { Waypoint } from "../models/Waypoint";
import { PortRoles } from "../registries/PortRoles";
import { Id } from "../core/Id";
import { Text } from "../core/Text";
import { APP_RELEASE, EQUIP_FACE_IMG_FIELD, CABLE_STATUS_DRAFT, CABLE_STATUS_BROKEN, CABLE_STATUS_RANK, PORT_CONNECTOR_MM, PORT_CONNECTOR_DEFAULT, LOCATIONS } from "../domain/constants";
import { DEFAULT_PORT_TYPES, DEFAULT_CABLE_TYPES } from "../registries/defaultCatalogs";
import { Cascade, CascadeDelete, CascadeDetach } from "./cascadeSpec";
import { DataValidator } from "../../shared/DataValidation";
import type { ValidationError, EntityFetcher, ChildFinder } from "../../shared/DataValidation";

const COLLECTIONS = EntityRegistry.COLLECTIONS;
const ENTITY_CLASSES = EntityRegistry.CLASSES;

/** Codes STABLES des erreurs de route de câble (`Store.cableRoute`). Le libellé (`message`) peut être reformulé
    librement ; les appelants qui RÉAGISSENT à une erreur précise s'appuient sur le `code`, jamais sur le texte. */
export type RouteErrorCode =
  | "floor_outside"     // pin d'étage hors d'un tronçon inter-salles (entre deux exits)
  | "unplaced"          // waypoint non posé dans une salle
  | "room_wp_outside"   // waypoint de salle au milieu d'un tronçon hors-salle
  | "wrong_room"        // waypoint de salle dans une autre salle que le segment courant
  | "exit_wrong_room"   // exit qui n'est pas de la salle courante
  | "exit_reentry"      // exit ré-entrant dans la salle tout juste quittée
  | "exit_unpaired"     // exit ouvrant un tronçon jamais refermé
  | "portA_room"        // port A hors de la salle où la route commence
  | "portB_room"        // port B hors de la salle où la route finit
  | "ports_split";      // deux ports dans deux salles sans exits pour les relier
export interface RouteError { code: RouteErrorCode; message: string }
/** Sous-ensemble « EXIT TERMINAL » (cohérence de salle) : un exit ferme sa salle → tout waypoint/exit de salle
    mal placé ensuite viole la route. Sert à refuser l'ajout d'un waypoint au fil de l'eau (UI routage + formulaire). */
const ROUTE_ROOM_BREAK_CODES: ReadonlySet<RouteErrorCode> = new Set<RouteErrorCode>(["room_wp_outside", "wrong_room", "exit_wrong_room", "exit_reentry"]);
/** Erreurs STRUCTURELLES (grammaire des tronçons) = ruptures de salle + pin d'étage hors tronçon + exit non
    appairé. Elles interdisent l'enregistrement MÊME en brouillon (route mal formée), contrairement aux erreurs
    d'INCOMPLÉTUDE (ports/bouts pas encore posés) qui restent tolérées en brouillon. Sur-ensemble des « room break ». */
const ROUTE_STRUCTURAL_CODES: ReadonlySet<RouteErrorCode> = new Set<RouteErrorCode>([...ROUTE_ROOM_BREAK_CODES, "floor_outside", "exit_unpaired"]);

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
  private _emit(): void { this._listeners.forEach((fn) => { try { fn(); } catch (e) { console.warn(e); } }); }

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
    this._reindex();
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
    if (raw) { this._hydrate(raw); this.restored = true; }
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
      const res = await this.adapter.list(c, { pageSize: 1_000_000_000 });
      const Cls = ENTITY_CLASSES[c];
      this.data[c] = (res.rows || []).map((o: RawRecord) => new Cls(o));
    }));
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
    upsert("portTypes", PortType, DEFAULT_PORT_TYPES, ["name", "family", "connector", "speed", "kind"]);
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

  /* ---- LECTURE (cache hydraté, synchrone) ---- */
  get(collection: string, id: string): any {
    return this._idIndex[collection] ? this._idIndex[collection].get(id) || null : null;
  }
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
    const errors = DataValidator.validateRecord(collection, record, this.entityFetcher, this.recordFinder);
    if (!errors.length) errors.push(...DataValidator.validateDependents(collection, record, this.recordFinder, this.entityFetcher));
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
    // 1) prépare + VALIDE tout AVANT de muter → le moindre échec annule le lot entier (atomicité).
    const prepared: Array<{ obj: any; collection: string; id: string; patch: Record<string, any> }> = [];
    for (const { collection, id, patch } of ops) {
      const obj = this.get(collection, id); if (!obj) continue;
      const normalizedPatch = this._normalizePatch(collection, obj, patch);
      if (!this.accepts(collection, { ...obj.toJSON(), ...normalizedPatch })) return 0;
      prepared.push({ obj, collection, id, patch: normalizedPatch });
    }
    // 2) applique + persiste
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
    copy.rack_id = null; copy.rack_u = null;
    copy.dc_id = null; copy.dc_x = null; copy.dc_y = null;
    copy.dc_z = 0; copy.dc_orientation = 0;
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
  cablesOfNetwork(networkId: string): any[] {
    const out = this._byFk("cables", "network_ids", networkId);
    this._byFk("cables", "network_id", networkId).forEach((c) => { if (!out.includes(c)) out.push(c); });
    return out.filter((c) => this.cableNetworkIds(c).includes(networkId));
  }
  equipmentsOfGroup(groupId: string): any[] { return this._byFk("equipments", "group_id", groupId); }
  portsOfType(portTypeId: string): any[] { return this._byFk("ports", "port_type_id", portTypeId); }
  cablesOfType(cableTypeId: string): any[] { return this._byFk("cables", "cable_type_id", cableTypeId); }
  racksOfDc(datacenterId: string | null): any[] { return this._byFk("racks", "datacenter_id", datacenterId || null); }
  rackItemsOf(rackId: string): any[] { return this._byFk("rackItems", "rack_id", rackId); }
  portsOfAggregate(aggregateId: string): any[] { return this._byFk("ports", "aggregate_id", aggregateId); }
  equipmentsOfRack(rackId: string): any[] { return this._byFk("equipments", "rack_id", rackId); }
  freeEquipsOfDc(datacenterId: string | null): any[] { return this._byFk("equipments", "dc_id", datacenterId || null).filter((e) => e.dim_mode === "free"); }
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
  dhcpRangesOfNetwork(netId: string): any[] { return this._byFk("dhcpRanges", "network_id", netId); }
  dhcpRangesOfServer(eqId: string): any[] { return this._byFk("dhcpRanges", "server_id", eqId); }
  ipAddressByValue(addr: string): any { const r = this._byFk("ipAddresses", "address", addr); return r.length ? r[0] : null; }
  networksOfIpNetwork(ipNetId: string): any[] { return this._byFk("networks", "ip_network_id", ipNetId); }
  unrackedEquipments(): any[] {
    return this.data.equipments.filter((e) => !e.inventory_only && e.placement_mode !== "floor" && !(e.placement_mode === "side" && e.rack_id) && !(e.placement_mode === "wall" && e.rack_id) && (e.placement_mode !== "rack" || !e.rack_id));
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
    if (!ct) return { ok: false, reason: "Type de câble manquant" };
    if (!pf || !pt) return { ok: false, reason: "Un port n'a pas de type défini" };
    if (ct.family !== pf || ct.family !== pt) {
      return { ok: false, reason: `Incompatible : câble « ${ct.family} » vs ports « ${pf} » / « ${pt} »` };
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

  /* ---- faisceaux (trunks) : un brin hérite type/route/longueur de son trunk ---- */

  cableBundleOf(c: any): any { return (c && c.bundle_id) ? this.get("cableBundles", c.bundle_id) : null; }
  strandsOfBundle(bundleId: string | null): any[] { return bundleId ? this.all("cables").filter((c) => c.bundle_id === bundleId) : []; }
  /** waypoint_ids EFFECTIFS d'un câble : ceux de son trunk si c'est un brin, sinon les siens.
      Accepte un câble OU un draft { bundle_id?, waypoint_ids? }. */
  effectiveWaypointIds(c: any): string[] {
    if (c && c.bundle_id) { const b = this.get("cableBundles", c.bundle_id); if (b) return b.waypoint_ids || []; }
    return c ? (c.waypoint_ids || []) : [];
  }
  /** Occupation d'un trunk : { used, capacity, free, nextStrand } (1er n° de fibre libre). */
  bundleOccupancy(bundleId: string): { used: number; capacity: number; free: number; nextStrand: number } {
    const b = this.get("cableBundles", bundleId); if (!b) return { used: 0, capacity: 0, free: 0, nextStrand: 1 };
    const used = new Set(this.strandsOfBundle(bundleId).map((s) => s.strand_no).filter((n) => n != null));
    let next = 1; while (used.has(next)) next++;
    return { used: used.size, capacity: b.fiber_count, free: Math.max(0, b.fiber_count - used.size), nextStrand: next };
  }

  /* ---- câbles : réseaux / complétude ---- */

  /** Réseaux d'un câble (network_ids sinon network_id seul). */
  cableNetworkIds(c: any): string[] { return (c && Array.isArray(c.network_ids) && c.network_ids.length) ? c.network_ids : (c && c.network_id ? [c.network_id] : []); }
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

  /** Salle du bout A|B d'un câble (null = port absent OU équipement non placé). */
  cableEndDcId(cable: any, side: "A" | "B"): string | null {
    const pid = side === "A" ? cable.from_port_id : cable.to_port_id;
    const p = pid ? this.get("ports", pid) : null;
    return p ? this.equipmentDcId(p.equipment_id) : null;
  }

  /** Analyse de la route (waypoint_ids EFFECTIFS, ordonnés A→B) : grammaire + cohérence des bouts posés.
      → { steps[{wp,type,seg}], errors[], valid, hasExits, startDc, endDc, dcA, dcB }. Pure lecture. */
  cableRoute(cable: any): { steps: any[]; errors: RouteError[]; valid: boolean; hasExits: boolean; startDc: string | null; endDc: string | null; dcA: string | null; dcB: string | null } {
    const wps = this.effectiveWaypointIds(cable).map((id) => this.get("waypoints", id)).filter(Boolean);
    const errors: RouteError[] = [], steps: any[] = [];
    const err = (code: RouteErrorCode, message: string) => { errors.push({ code, message }); };
    let cur: string | null = null, outside = false, exitFrom: string | null = null, startDc: string | null = null, exits = 0, seg = -1;
    wps.forEach((wp) => {
      const nm = wp.name || "(waypoint)";
      if (Waypoint.isFloorLevel(wp)) {   // pin d'ÉTAGE (ex-OOB) : doit être ENTRE deux exits
        if (!outside) err("floor_outside", "« " + nm + " » (pin d'étage) doit être ENTRE deux exits");
        steps.push({ wp, type: "floor", seg: outside ? seg : -1 });
        return;
      }
      const t = Waypoint.typeOf(wp);
      if (!this.waypointIsPlaced(wp)) { err("unplaced", "« " + nm + " » n'est pas posé dans une salle"); steps.push({ wp, type: t, seg: -1 }); return; }
      const room = wp.datacenter_id;
      if (t === "datacenter") {
        if (outside) err("room_wp_outside", "« " + nm + " » (waypoint de salle) au milieu d'un tronçon hors salle");
        else if (cur == null) { cur = room; if (startDc == null) startDc = room; }
        else if (room !== cur) err("wrong_room", "« " + nm + " » est dans une autre salle que le segment courant");
      } else {   // exit
        exits++;
        if (!outside) {   // SORTIE de la salle courante
          if (cur == null) { cur = room; if (startDc == null) startDc = room; }
          if (room !== cur) err("exit_wrong_room", "exit « " + nm + " » : la sortie doit être un exit de la salle courante");
          outside = true; exitFrom = cur; cur = null; seg++;
        } else {          // ENTRÉE dans une autre salle
          if (room === exitFrom) err("exit_reentry", "exit « " + nm + " » : ré-entrée dans la salle quittée — appariez avec un exit d'une AUTRE salle");
          cur = room; outside = false; exitFrom = null;
        }
      }
      steps.push({ wp, type: t, seg: -1 });
    });
    if (outside) err("exit_unpaired", "exit non appairé — ajoutez l'exit d'une autre salle pour fermer le tronçon");
    const endDc = outside ? null : cur;
    const dcA = this.cableEndDcId(cable, "A"), dcB = this.cableEndDcId(cable, "B");
    if (dcA && startDc && dcA !== startDc) err("portA_room", "le port A n'est pas dans la salle où la route commence");
    if (dcB && endDc && dcB !== endDc) err("portB_room", "le port B n'est pas dans la salle où la route finit");
    if (!exits && dcA && dcB && dcA !== dcB) err("ports_split", "ports dans deux salles différentes — la route doit sortir par un exit de chaque salle");
    return { steps, errors, valid: !errors.length, hasExits: exits > 0, startDc, endDc, dcA, dcB };
  }

  /** La route contient-elle une violation de COHÉRENCE DE SALLE (« exit terminal ») ? Un exit ferme sa salle → un
      waypoint/exit de salle mal placé ensuite casse la route. Testé sur les CODES stables (pas le libellé) → sert à
      refuser l'ajout d'un waypoint au fil de l'eau (UI routage + formulaire câble), sans couplage fragile au texte. */
  routeHasRoomBreak(cable: any): boolean {
    return this.cableRoute(cable).errors.some((e) => ROUTE_ROOM_BREAK_CODES.has(e.code));
  }

  /** Première erreur STRUCTURELLE de route (cf. `ROUTE_STRUCTURAL_CODES` : cohérence de salle + pin d'étage hors
      tronçon + exit non appairé), ou null. Ces erreurs interdisent l'enregistrement même en brouillon (route mal
      formée) ; on renvoie l'erreur COMPLÈTE pour pouvoir afficher son `message`. */
  routeStructuralError(cable: any): RouteError | null {
    return this.cableRoute(cable).errors.find((e) => ROUTE_STRUCTURAL_CODES.has(e.code)) || null;
  }

  /** Contrainte de salle d'un BOUT ("A"|"B"), évaluée SANS son port : { dcId, onlyUnplaced, route }. */
  cableSideConstraint(cable: any, side: "A" | "B"): { dcId: string | null; onlyUnplaced: boolean; route: any } {
    const probe = {
      from_port_id: side === "A" ? null : cable.from_port_id,
      to_port_id: side === "B" ? null : cable.to_port_id,
      waypoint_ids: cable.waypoint_ids || [], bundle_id: cable.bundle_id || null,
    };
    const r = this.cableRoute(probe);
    if (!r.valid) return { dcId: null, onlyUnplaced: true, route: r };
    const own = side === "A" ? r.startDc : r.endDc;
    if (own) return { dcId: own, onlyUnplaced: false, route: r };
    if (!r.hasExits) {
      const other = side === "A" ? r.dcB : r.dcA;
      if (other) return { dcId: other, onlyUnplaced: false, route: r };
    }
    return { dcId: null, onlyUnplaced: false, route: r };
  }

  /** Résumé lisible de la route : « ◆ Salle A → ⏏ Salle A → ◎ ét. 1 → ⏏ Salle B ». */
  cableRouteSummary(r: any): string {
    if (!r.steps.length) return "";
    const parts: string[] = [];
    let lastRoom: string | null = null;
    r.steps.forEach((s: any) => {
      if (s.type === "floor") { parts.push("◎ " + Waypoint.floorLabel(s.wp)); return; }
      const room = s.wp.datacenter_id;
      if (s.type === "exit") { parts.push("⏏ " + this.dcName(room)); lastRoom = room; }
      else if (room !== lastRoom) { parts.push("◆ " + this.dcName(room)); lastRoom = room; }
    });
    return parts.join(" → ");
  }

  /** Nom d'une salle (datacenter) — "?" si absente, "(salle)" si sans nom. */
  dcName(dcId: string | null): string { const d = dcId ? this.get("datacenters", dcId) : null; return d ? (d.name || "(salle)") : "?"; }

  /** Statut MAXIMAL d'un câble : brouillon (incomplet/route invalide) → planifié → câblé (2 bouts posés). */
  cableMaxStatus(cable: any): string {
    if (!this.cableIsComplete(cable)) return CABLE_STATUS_DRAFT;
    const r = this.cableRoute(cable);
    if (!r.valid) return CABLE_STATUS_DRAFT;
    return (r.dcA && r.dcB) ? "cable" : "planifie";
  }
  /** Le statut `statusId` est-il ≤ au maximum `maxId` ? */
  cableStatusFits(statusId: string, maxId: string): boolean {
    return (CABLE_STATUS_RANK[statusId] != null ? CABLE_STATUS_RANK[statusId] : 2) <= (CABLE_STATUS_RANK[maxId] || 0);
  }

  /* ---- contrainte physique de placement (câblage) ---- */

  /** Salles (datacenter_id) où un câble POSÉ contraint l'équipement à être : Map<dcId, cables[]>.
      Une route en chantier (onlyUnplaced) ou sans contrainte n'impose rien. */
  equipmentRequiredDcs(eqId: string): Map<string, any[]> {
    const req = new Map<string, any[]>(), seen = new Set<string>();
    this.portsOf(eqId).forEach((p) => {
      const c = this.cableOnPort(p.id);
      if (!c || seen.has(c.id)) return; seen.add(c.id);
      const side = c.from_port_id === p.id ? "A" : "B";
      const k = this.cableSideConstraint(c, side as "A" | "B");
      if (k.onlyUnplaced || !k.dcId) return;
      if (!req.has(k.dcId)) req.set(k.dcId, []);
      req.get(k.dcId)!.push(c);
    });
    return req;
  }
  /** Motif de blocage du placement dans la salle cible (null = autorisé) : la cible doit
      satisfaire TOUTES les contraintes de câblage de l'équipement. */
  equipmentPlacementBlockedReason(eqId: string, targetDcId: string): string | null {
    const req = this.equipmentRequiredDcs(eqId);
    if (!req.size) return null;
    if (req.size === 1 && req.has(targetDcId)) return null;
    const names = [...req.keys()].map((id) => this.dcName(id)).join(", ");
    if (req.size > 1) return "câblé vers plusieurs salles à la fois (" + names + ") — re-routez ou détachez un câble";
    return "câblé vers « " + names + " » — re-routez le câble (exits) ou détachez-le";
  }
  /** Idem pour un RACK entier (vérifie chaque équipement monté en U). null = autorisé. */
  rackPlacementBlockedReason(rackId: string, targetDcId: string): string | null {
    const eqs = this.equipmentsOfRack(rackId).filter((e) => e.placement_mode === "rack" && e.rack_u != null);
    for (const e of eqs) {
      const why = this.equipmentPlacementBlockedReason(e.id, targetDcId);
      if (why) return "« " + (e.name || "(équipement)") + " » : " + why;
    }
    return null;
  }
  /** Contexte physique d'un équipement : id de salle, « floor:loc:étage » (posé hors salle), ou null. */
  equipmentContext(eq: any): string | null {
    if (!eq) return null;
    if (eq.placement_mode === "floor") return "floor:" + (eq.location || "") + ":" + String(eq.floor || "");
    return this.equipmentDcId(eq) || null;
  }
  /** Un câble est-il valide compte tenu des contextes physiques de ses deux bouts ?
      (deux contextes différents dont au moins une SALLE → route avec exits requise). */
  cableContextValid(c: any): boolean {
    const pf = c.from_port_id ? this.get("ports", c.from_port_id) : null, pt = c.to_port_id ? this.get("ports", c.to_port_id) : null;
    if (!pf || !pt) return true;
    const ca = this.equipmentContext(this.get("equipments", pf.equipment_id)), cb = this.equipmentContext(this.get("equipments", pt.equipment_id));
    if (ca == null || cb == null) return true;
    if (ca === cb) return true;
    const aSalle = !ca.startsWith("floor:"), bSalle = !cb.startsWith("floor:");
    if (aSalle || bSalle) { const r = this.cableRoute(c); return r.valid && r.hasExits; }
    return true;
  }
  /** Patchs de CASSE des câbles d'un équipement dont la route n'est plus valide après (dé)placement :
      déconnecte le bout DISTANT seulement, statut « cassé », raison ajoutée à la description. */
  cableBreakOps(eqId: string): Array<{ collection: string; id: string; patch: Record<string, any> }> {
    const eq = this.get("equipments", eqId); if (!eq) return [];
    const ops: Array<{ collection: string; id: string; patch: Record<string, any> }> = [];
    this.cablesOfEquipment(eqId).forEach((c) => {
      if (c.status === CABLE_STATUS_BROKEN || c.status === CABLE_STATUS_DRAFT) return;
      if (this.cableContextValid(c)) return;
      const pf = c.from_port_id ? this.get("ports", c.from_port_id) : null;
      const fromIsEq = !!(pf && pf.equipment_id === eqId);
      const remotePortId = fromIsEq ? c.to_port_id : c.from_port_id;
      const remotePort = remotePortId ? this.get("ports", remotePortId) : null;
      const remoteEq = remotePort ? this.get("equipments", remotePort.equipment_id) : null;
      const reason = "Suite au déplacement de l'équipement « " + (eq.name || "?") + " », la liaison vers « "
        + (remoteEq ? (remoteEq.name || "?") : "?") + " » sur le port « " + (remotePort ? (remotePort.name || "?") : "?") + " » n'est plus valide.";
      const patch: Record<string, any> = { status: CABLE_STATUS_BROKEN, description: (c.description ? c.description.trim() + "\n" : "") + reason };
      if (fromIsEq) patch.to_port_id = null; else patch.from_port_id = null;
      ops.push({ collection: "cables", id: c.id, patch });
    });
    return ops;
  }
  /** Applique `cableBreakOps` en une transaction ; renvoie le nb de câbles cassés. */
  async applyCableBreaks(eqId: string): Promise<number> {
    const ops = this.cableBreakOps(eqId);
    if (ops.length) await this.updateBatch(ops);
    return ops.length;
  }
  /** Patchs de DÉGRADATION (« Câblé / À remplacer » → « Planifié ») des câbles des équipements donnés —
      quand ils QUITTENT leur salle. À fusionner avec le patch de retrait pour un seul undo. */
  cableDowngradeOps(eqIds: string[]): Array<{ collection: string; id: string; patch: Record<string, any> }> {
    const ops: Array<{ collection: string; id: string; patch: Record<string, any> }> = [], seen = new Set<string>();
    eqIds.forEach((eqId) => this.portsOf(eqId).forEach((p) => {
      const c = this.cableOnPort(p.id);
      if (!c || seen.has(c.id)) return; seen.add(c.id);
      if (c.status === "cable" || c.status === "a-remplacer") ops.push({ collection: "cables", id: c.id, patch: { status: "planifie" } });
    }));
    return ops;
  }

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
    const inSiteRoom = (e: any) => !!((e.rack_id && dcIds.has((this.get("racks", e.rack_id) || {}).datacenter_id)) || (e.dc_id && dcIds.has(e.dc_id)));
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
    for (const w of this.all("waypoints").filter((w) => dcIds.has(w.datacenter_id) || ((w.location || "") === siteId))) await this.remove("waypoints", w.id);
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
