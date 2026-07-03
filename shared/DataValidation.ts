/* ============================================================================
   NORMALISATION & VALIDATION DES DONNÉES — code PARTAGÉ front ⇄ back (TS pur).

   Garantit qu'un enregistrement écrit dans un document respecte le schéma, QUEL QUE
   SOIT le client (UI packagée ou autre interface postant au serveur). Appliqué aux deux
   points : saisie (UI, via le Store) et écriture (serveur, autorité → 400). Cf. docs/validation.md.

   API publique = DEUX classes sémantiques (méthodes statiques regroupées, cf. CLAUDE.md) :
     - `Ipv4`          : primitives IPv4 / CIDR pures (parité avec src/core/Ip).
     - `DataValidator` : normalisation + validation (intrinsèque V1, référentiel V2,
                         invariants V3, cross-entité V5, dépendance inverse V5b).
   Les énumérations, types et la table `COLLECTION_SPECS` restent des exports de données.

   Contrainte `shared/` : fichier AUTO-SUFFISANT (aucun import) → compile sous le front
   (résolution bundler) ET le serveur (NodeNext). Les enums sont donc déclarés ICI comme
   source canonique ; un test anti-divergence vérifie l'alignement avec les constantes front.
   ============================================================================ */

/* ---- énumérations canoniques (alignées au domaine front — cf. test anti-divergence) ---- */
/** Statuts de câble (cycle de vie). = `CABLE_STATUSES.map(s => s.id)` côté front. */
export const CABLE_STATUS_IDS = ["brouillon", "planifie", "cable", "a-remplacer", "casse"] as const;
/** Profondeurs d'équipement (drapeau de face). = `EQUIP_DEPTHS` côté front. */
export const EQUIPMENT_DEPTHS = ["full", "half", "quarter"] as const;
/** Modes de placement d'un équipement. */
export const EQUIPMENT_PLACEMENT_MODES = ["manual", "rack", "side", "wall", "floor"] as const;
/** Configurations de faces d'une baie. */
export const RACK_SIDE_CONFIGS = ["single", "dual"] as const;
/** Faces d'un équipement (où poser un port). = `EQUIP_FACE_IDS` côté front. */
export const EQUIPMENT_FACE_IDS = ["front", "rear", "top", "bottom", "left", "right"] as const;
/** Nature « données » vs « énergie » (réseaux, types de port/câble). */
export const DATA_OR_POWER = ["data", "power"] as const;
/** Types de groupe. = `GROUP_TYPES.map(t => t.id)` côté front. */
export const GROUP_TYPE_IDS = ["stack", "system", "general"] as const;
/** Genres de pseudo-occupant de baie. = `RACK_ITEM_KINDS.map(k => k.id)` côté front. */
export const RACK_ITEM_KIND_IDS = ["blank", "tray", "keepblank"] as const;
/** Côtés d'occupation d'une baie. */
export const RACK_OCCUPANT_SIDES = ["front", "rear"] as const;
/** Genres de waypoint. */
export const WAYPOINT_KINDS = ["point", "segment", "brush"] as const;
/** Catégories de waypoint (en salle vs sortie). */
export const WAYPOINT_TYPES = ["datacenter", "exit"] as const;
/** Sources d'alimentation d'un réseau power. */
export const POWER_SOURCES = ["ups", "ups_gen", "grid"] as const;
/** Types de pièce de rechange. = `SPARE_TYPES.map(t => t.id)` côté front. */
export const SPARE_TYPE_IDS = ["hdd", "ssd", "transceiver", "other"] as const;
/** Statuts de pièce de rechange. = `SPARE_STATUSES.map(s => s.id)` côté front. */
export const SPARE_STATUS_IDS = ["available", "assigned", "decommissioned"] as const;

/* ---- types de la spécification ---- */
export type FieldType = "string" | "number" | "boolean" | "string[]";

/** Règle déclarative pour UN champ d'une collection. */
export interface FieldSpec {
  type: FieldType;
  /** Champ obligatoire : `undefined` / `null` / chaîne vide interdits. */
  required?: boolean;
  /** `null` explicitement autorisé (FK optionnelle, mesure non renseignée…). */
  nullable?: boolean;
  /** Valeur posée par la normalisation quand le champ est absent / vide. */
  default?: unknown;
  /** Ensemble fermé de valeurs autorisées. */
  enum?: readonly string[];
  /** Borne inférieure (type `number`). */
  min?: number;
  /** Format attendu (chaîne) : `ipv4` (« a.b.c.d ») ou `cidr` (« a.b.c.d/n », n ∈ 0..32). */
  format?: "ipv4" | "cidr";
  /** Collection cible d'une clé étrangère (exploité par l'intégrité référentielle — V2). */
  ref?: string;
}

/** Spécification d'une collection : ses champs déclarés (partielle — seuls les champs porteurs de règles
    sont listés ; les autres traversent) + invariants inter-champs (V3) + règles cross-entité (V5). */
export interface CollectionSpec {
  fields: Record<string, FieldSpec>;
  invariants?: Invariant[];
  crossEntity?: CrossEntityRule[];
  /** Règles de PORTÉE (V6) : unicité / non-chevauchement contre les pairs (nécessitent le `find`). */
  scope?: ScopeRule[];
  /** Dépendances INVERSES (V5b) : collections-enfants à re-valider quand CETTE entité change (ex. un réseau IP
      dont le `cidr` change → re-vérifier ses adresses/plages). Les enfants sont re-validés via LEURS propres
      règles cross-entité, contre le nouvel état du parent. */
  dependents?: Array<{ collection: string; fkField: string }>;
}

/** Erreur de validation — contrat partagé UI ⇄ serveur. */
export interface ValidationError {
  collection: string;
  id?: string;
  path: string;            // champ concerné
  code: "required" | "type" | "enum" | "min" | "format" | "ref_missing" | "invariant" | "cross_entity" | "scope";
  message: string;         // message humain (français)
}

/** Invariant INTER-CHAMPS d'une collection (V3) : règle qui dépend de PLUSIEURS champs du même
    enregistrement (impossible à exprimer champ par champ). Pure → testable. */
export interface Invariant {
  path: string;            // champ auquel rattacher l'erreur (pour le surlignage UI)
  message: string;         // message humain (français)
  holds: (record: Record<string, any>) => boolean;   // true = respecté · false = violé
}

/** Lecteur d'entité (V2 référentiel + V5 cross-entité) : renvoie l'enregistrement pointé, ou `null` s'il
    n'existe pas. INJECTÉ pour garder `shared/` pur — l'UI l'adosse au `Store`, le serveur au `Repository`.
    Subsume l'ancien résolveur d'existence : « existe ? » = `fetch(coll, id) != null`. */
export type EntityFetcher = (collection: string, id: string) => Record<string, any> | null;

/** Règle CROSS-ENTITÉ (V5) : valide un enregistrement d'après les DONNÉES d'une entité liée (lue via `fetch`),
    pas seulement ses propres champs. Renvoie l'erreur (champ + message) ou `null` si respectée / non applicable. */
export type CrossEntityRule = (record: Record<string, any>, fetch: EntityFetcher) => { path: string; message: string } | null;

/** Recherche d'enregistrements par champ INDEXÉ (dépendance inverse V5b + portée V6) : tous les enregistrements
    de `collection` dont `field` vaut `value`. INJECTÉ — l'UI l'adosse aux index du `Store`, le serveur à une
    requête. `ChildFinder` (V5b, recherche par FK) en est un cas particulier — même signature. */
export type RecordFinder = (collection: string, field: string, value: string) => Record<string, any>[];
export type ChildFinder = RecordFinder;

/** Règle de PORTÉE (V6) : valide un enregistrement contre l'ENSEMBLE de ses pairs (unicité, non-chevauchement),
    via un `find` par champ (+ `fetch` optionnel pour lire une entité de contexte, ex. la baie). Doit EXCLURE
    l'enregistrement lui-même (par `id`). Renvoie l'erreur ou `null`. */
export type ScopeRule = (record: Record<string, any>, find: RecordFinder, fetch?: EntityFetcher) => { path: string; message: string } | null;

/** Forme minimale d'un lot atomique (mêmes champs que la transaction serveur). */
export interface BatchOps {
  creates?: Array<{ collection: string; record: Record<string, any> }>;
  updates?: Array<{ collection: string; record: Record<string, any> }>;
  deletes?: Array<{ collection: string; id: string }>;
}

/** Sous-réseau IPv4 analysé (sous-ensemble de `core/Ip.Cidr` : ce dont la validation a besoin). */
export interface ParsedCidr { base: number; prefix: number; mask: number; network: number; }

/* ============================================================================
   Ipv4 — primitives IPv4 / CIDR PURES (parité stricte avec src/core/Ip ; `core/Ip` y délègue).
   ============================================================================ */
export class Ipv4 {
  /** « a.b.c.d » → entier non signé, ou `null` si invalide (octets ≤ 255). */
  static toInt(value: string): number | null {
    const match = typeof value === "string" ? value.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/) : null;
    if (!match) return null;
    let result = 0;
    for (let i = 1; i <= 4; i++) { const octet = +match[i]; if (octet > 255) return null; result = result * 256 + octet; }
    return result >>> 0;
  }

  /** « a.b.c.d/n » → sous-réseau analysé, ou `null` si invalide. */
  static parseCidr(value: string): ParsedCidr | null {
    const match = typeof value === "string" ? value.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/) : null;
    if (!match) return null;
    const base = Ipv4.toInt(match[1]); const prefix = +match[2];
    if (base == null || prefix < 0 || prefix > 32) return null;
    const mask = prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - prefix)) >>> 0);
    return { base, prefix, mask, network: (base & mask) >>> 0 };
  }

  /** Vrai si `value` est un CIDR IPv4 valide (« a.b.c.d/n », n ∈ 0..32). */
  static isCidr(value: string): boolean {
    return Ipv4.parseCidr(value) != null;
  }

  /** L'entier d'IP appartient-il au sous-réseau ? */
  static inCidr(ipInt: number | null, cidr: ParsedCidr | null): boolean {
    return cidr != null && ipInt != null && ((ipInt & cidr.mask) >>> 0) === cidr.network;
  }
}

/* ============================================================================
   RackOccupancy — empilement en baie (V6c). Réplique FIDÈLE de RackGeometry.mountSides /
   RackScene.occupants : un occupant (équipement racké, rackItem, brosse) occupe des cellules
   « U:face » ; deux occupants entrent en COLLISION s'ils partagent une cellule.
   ============================================================================ */
type RackSpan = { top: number; height: number; sides: string[] };

class RackOccupancy {
  /** Faces occupées par un occupant selon le type de baie (réplique `RackGeometry.mountSides`). */
  private static sides(record: Record<string, any>, collection: string, rack: Record<string, any>): string[] {
    if (rack.sides !== "dual") return ["front"];                                  // baie simple face → tout sur « front »
    if (collection === "rackItems") return [record.side === "rear" ? "rear" : "front"];
    if (collection === "waypoints") return ["front", "rear"];                     // brosse → pleine profondeur
    const locksU = record.depth === "full" || record.locks_u === true;            // équipement pleine profondeur → 2 faces
    return locksU ? ["front", "rear"] : [record.rack_side === "rear" ? "rear" : "front"];
  }

  /** Étendue U×faces d'un occupant de baie, ou `null` si l'enregistrement n'occupe pas de U dans une baie. */
  private static span(record: Record<string, any>, collection: string, rack: Record<string, any>): RackSpan | null {
    let top: number | null = null, height = 1;
    if (collection === "equipments") {
      if (record.placement_mode !== "rack" || record.rack_u == null) return null;
      top = record.rack_u | 0; height = Math.max(1, (record.u_height | 0) || 1);
    } else if (collection === "rackItems") {
      if (record.u == null) return null;
      top = record.u | 0; height = Math.max(1, (record.u_height | 0) || 1);
    } else if (collection === "waypoints") {
      if (record.kind !== "brush" || !record.rack_id) return null;
      top = Math.max(1, record.rack_u | 0); height = Math.max(1, record.u_height | 0);
    } else return null;
    if (top == null || top < 1) return null;
    return { top, height, sides: RackOccupancy.sides(record, collection, rack) };
  }

  /** Cellules « U:face » couvertes par une étendue. */
  private static cells(span: RackSpan): Set<string> {
    const set = new Set<string>();
    for (let i = 0; i < span.height; i++) for (const side of span.sides) set.add((span.top + i) + ":" + side);
    return set;
  }

  /** Règle de PORTÉE : l'occupant ne doit pas COLLIDER (même cellule U:face) avec un autre occupant de SA baie. */
  static collision(record: Record<string, any>, collection: string, find: RecordFinder, fetch?: EntityFetcher): { path: string; message: string } | null {
    const rackId = record.rack_id;
    if (!rackId || !fetch) return null;
    const rack = fetch("racks", rackId);
    if (!rack) return null;                                                        // baie absente → l'intégrité réf. le signale
    const self = RackOccupancy.span(record, collection, rack);
    if (!self) return null;                                                        // pas un occupant de baie
    const selfCells = RackOccupancy.cells(self);
    const path = collection === "rackItems" ? "u" : "rack_u";
    const others: Array<[string, Record<string, any>]> = [
      ...find("equipments", "rack_id", rackId).map((o) => ["equipments", o] as [string, Record<string, any>]),
      ...find("rackItems", "rack_id", rackId).map((o) => ["rackItems", o] as [string, Record<string, any>]),
      ...find("waypoints", "rack_id", rackId).map((o) => ["waypoints", o] as [string, Record<string, any>]),
    ];
    for (const [otherCollection, other] of others) {
      if (other.id === record.id) continue;                                        // « sauf moi-même »
      const span = RackOccupancy.span(other, otherCollection, rack);
      if (!span) continue;
      for (const cell of RackOccupancy.cells(span)) {
        if (selfCells.has(cell)) return { path, message: `Emplacement en collision avec « ${other.name || other.label || other.id} » (U${span.top}${span.height > 1 ? "–" + (span.top + span.height - 1) : ""}).` };
      }
    }
    return null;
  }
}

/* ---- spécifications des collections (couverture 19/19 — cf. docs/validation.md) ---- */
export const COLLECTION_SPECS: Record<string, CollectionSpec> = {
  equipments: {
    fields: {
      name:           { type: "string", required: true },
      type:           { type: "string", default: "switch" },
      depth:          { type: "string", enum: EQUIPMENT_DEPTHS, default: "full" },
      placement_mode: { type: "string", enum: EQUIPMENT_PLACEMENT_MODES, default: "manual" },
      u_height:       { type: "number", min: 1, default: 1 },
      inventory_only: { type: "boolean", default: false },
      group_id:       { type: "string", nullable: true, default: null, ref: "groups" },
      rack_id:        { type: "string", nullable: true, default: null, ref: "racks" },        // baie hôte (placement racké)
      dc_id:          { type: "string", nullable: true, default: null, ref: "datacenters" },  // salle hôte (placement libre)
      pdu_max_a:      { type: "number", nullable: true, default: null },
      // NB : les FK face_image_* visent le magasin d'images (hors modèle) → pas de `ref` (collection non modélisée).
    },
    invariants: [
      // T1 : placé en baie ⇒ doit référencer une baie.
      { path: "rack_id", message: "Un équipement placé en baie doit référencer une baie.", holds: (eq) => eq.placement_mode !== "rack" || !!eq.rack_id },
      // T1b : monté sur le FLANC (side) ou la PAROI (wall) d'une baie ⇒ doit référencer cette baie (rack_id).
      // Parité avec T1 : ces deux modes sont ancrés aux marges latérales d'une baie précise (cf. Equipment.ts) ;
      // un rack_id manquant est un état incohérent. (floor = plan d'étage via floor_x/y ; manual/dc_id = autres modes.)
      { path: "rack_id", message: "Un équipement monté sur le flanc ou la paroi d'une baie doit référencer une baie.", holds: (eq) => !["side", "wall"].includes(eq.placement_mode) || !!eq.rack_id },
    ],
    crossEntity: [
      // T2 : un équipement racké doit TENIR dans la hauteur de sa baie (U de tête + hauteur ≤ U de la baie).
      (eq, fetch) => {
        if (eq.placement_mode !== "rack" || !eq.rack_id || eq.rack_u == null) return null;
        const rack = fetch("racks", eq.rack_id);
        if (!rack || !rack.u_count) return null;   // baie absente / sans hauteur → couvert ailleurs
        const top = eq.rack_u | 0, height = Math.max(1, (eq.u_height | 0) || 1);
        return (top >= 1 && top + height - 1 <= rack.u_count) ? null
          : { path: "rack_u", message: `L'équipement (U${top}${height > 1 ? "–" + (top + height - 1) : ""}) dépasse la baie (${rack.u_count} U).` };
      },
    ],
    // V6c : pas de collision de U avec un autre occupant de la baie.
    scope: [(eq, find, fetch) => RackOccupancy.collision(eq, "equipments", find, fetch)],
  },
  cables: {
    fields: {
      cable_type_id: { type: "string", nullable: true, default: null, ref: "cableTypes" },
      from_port_id:  { type: "string", nullable: true, default: null, ref: "ports" },
      to_port_id:    { type: "string", nullable: true, default: null, ref: "ports" },
      network_ids:   { type: "string[]", default: [], ref: "networks" },
      network_id:    { type: "string", nullable: true, default: null, ref: "networks" },
      waypoint_ids:  { type: "string[]", default: [], ref: "waypoints" },
      length_m:      { type: "number", nullable: true, default: null, min: 0 },
      status:        { type: "string", required: true, enum: CABLE_STATUS_IDS, default: "brouillon" },
      bundle_id:     { type: "string", nullable: true, default: null, ref: "cableBundles" },
      strand_no:     { type: "number", nullable: true, default: null },
    },
    invariants: [
      {
        path: "to_port_id",
        message: "Un câble ne peut pas relier un port à lui-même.",
        holds: (cable) => !(cable.from_port_id && cable.to_port_id && cable.from_port_id === cable.to_port_id),
      },
      {
        path: "network_id",
        message: "Le réseau principal doit faire partie des réseaux du câble.",
        holds: (cable) => !cable.network_id || (Array.isArray(cable.network_ids) && cable.network_ids.includes(cable.network_id)),
      },
    ],
    scope: [
      // PORTÉE (V6b) : 1 câble par port — aucun AUTRE câble ne référence ce port (côté `from` OU `to`).
      (cable, find) => {
        for (const [path, portId] of [["from_port_id", cable.from_port_id], ["to_port_id", cable.to_port_id]] as const) {
          if (!portId) continue;
          const usingPort = [...find("cables", "from_port_id", portId), ...find("cables", "to_port_id", portId)];
          if (usingPort.some((other) => other.id !== cable.id)) return { path, message: "Ce port est déjà relié par un autre câble (1 câble par port)." };
        }
        return null;
      },
    ],
  },
  racks: {
    fields: {
      name:          { type: "string", required: true },
      location:      { type: "string", default: "" },
      u_count:       { type: "number", min: 1, default: 42 },
      width_mm:      { type: "number", min: 1 },
      depth:         { type: "number", min: 1 },
      sides:         { type: "string", enum: RACK_SIDE_CONFIGS, default: "single" },
      datacenter_id: { type: "string", nullable: true, default: null, ref: "datacenters" },
      dc_x:          { type: "number", nullable: true, default: null },
      dc_y:          { type: "number", nullable: true, default: null },
    },
    crossEntity: [
      // T2 : baie posée dans une salle ⇒ sa position doit tomber DANS les bornes de la salle.
      (rack, fetch) => {
        if (!rack.datacenter_id || rack.dc_x == null || rack.dc_y == null) return null;
        const dc = fetch("datacenters", rack.datacenter_id);
        if (!dc) return null;
        const width = dc.width_mm || 0, depth = dc.depth_mm || 0;
        return (rack.dc_x >= 0 && rack.dc_x <= width && rack.dc_y >= 0 && rack.dc_y <= depth) ? null
          : { path: "dc_x", message: `La position (${rack.dc_x}, ${rack.dc_y}) mm est hors de la salle (${width}×${depth} mm).` };
      },
    ],
  },

  /* ---- collections ÉTENDUES — specs PARTIELLES : champs d'identité, énumérations, et surtout les FK (`ref`). ---- */
  ports: {
    fields: {
      name:           { type: "string" },
      equipment_id:   { type: "string", nullable: true, default: null, ref: "equipments" },
      port_type_id:   { type: "string", nullable: true, default: null, ref: "portTypes" },
      parent_port_id: { type: "string", nullable: true, default: null, ref: "ports" },
      aggregate_id:   { type: "string", nullable: true, default: null, ref: "aggregates" },
      face_side:      { type: "string", enum: EQUIPMENT_FACE_IDS, default: "front" },
    },
    invariants: [
      // T1 : position de façade complète (X ET Y) ou absente (aucun des deux).
      { path: "face_y", message: "La position de façade doit avoir X et Y (ou aucun des deux).", holds: (p) => (p.face_x == null) === (p.face_y == null) },
    ],
    crossEntity: [
      // T2 : un port-lane et son port PARENT (breakout) appartiennent au même équipement.
      (port, fetch) => {
        if (!port.parent_port_id || !port.equipment_id) return null;
        const parent = fetch("ports", port.parent_port_id);
        return (parent && parent.equipment_id && parent.equipment_id !== port.equipment_id)
          ? { path: "parent_port_id", message: "Le port parent doit appartenir au même équipement." } : null;
      },
      // T2 : un port et son AGRÉGAT (LAG) appartiennent au même équipement.
      (port, fetch) => {
        if (!port.aggregate_id || !port.equipment_id) return null;
        const aggregate = fetch("aggregates", port.aggregate_id);
        return (aggregate && aggregate.equipment_id && aggregate.equipment_id !== port.equipment_id)
          ? { path: "aggregate_id", message: "L'agrégat doit appartenir au même équipement." } : null;
      },
    ],
  },
  aggregates: {
    fields: {
      name:         { type: "string" },
      equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
    },
  },
  networks: {
    fields: {
      label:         { type: "string", required: true },
      kind:          { type: "string", enum: DATA_OR_POWER, default: "data" },
      power_source:  { type: "string", nullable: true, default: null, enum: POWER_SOURCES },
      ip_network_id: { type: "string", nullable: true, default: null, ref: "ipNetworks" },
    },
    invariants: [
      {
        path: "ip_network_id",
        message: "Un réseau d'énergie (power) ne peut pas être rattaché à un réseau IP.",
        holds: (network) => network.kind !== "power" || !network.ip_network_id,
      },
    ],
  },
  groups: {
    fields: {
      label: { type: "string", required: true },
      type:  { type: "string", enum: GROUP_TYPE_IDS },
    },
  },
  rackItems: {
    fields: {
      label:   { type: "string" },
      rack_id: { type: "string", nullable: true, default: null, ref: "racks" },
      kind:    { type: "string", enum: RACK_ITEM_KIND_IDS, default: "blank" },
      side:    { type: "string", enum: RACK_OCCUPANT_SIDES, default: "front" },
    },
    // V6c : pas de collision de U avec un autre occupant de la baie.
    scope: [(item, find, fetch) => RackOccupancy.collision(item, "rackItems", find, fetch)],
  },
  portTypes: {
    fields: {
      name: { type: "string" },
      kind: { type: "string", enum: DATA_OR_POWER, default: "data" },
    },
  },
  cableTypes: {
    fields: {
      name: { type: "string" },
      kind: { type: "string", enum: DATA_OR_POWER, default: "data" },
    },
  },
  cableBundles: {
    fields: {
      name:          { type: "string" },
      cable_type_id: { type: "string", nullable: true, default: null, ref: "cableTypes" },
      waypoint_ids:  { type: "string[]", default: [], ref: "waypoints" },
    },
  },
  datacenters: {
    fields: {
      name: { type: "string", required: true },
    },
  },
  waypoints: {
    fields: {
      name:          { type: "string" },
      kind:          { type: "string", enum: WAYPOINT_KINDS, default: "point" },
      wp_type:       { type: "string", enum: WAYPOINT_TYPES, default: "datacenter" },
      rack_id:       { type: "string", nullable: true, default: null, ref: "racks" },
      datacenter_id: { type: "string", nullable: true, default: null, ref: "datacenters" },
    },
    invariants: [
      // T1 : une brosse est montée DANS une baie (rack_id obligatoire pour ce genre).
      { path: "rack_id", message: "Une brosse doit être montée dans une baie.", holds: (wp) => wp.kind !== "brush" || !!wp.rack_id },
    ],
    // V6c : une brosse ne doit pas collisionner d'autres occupants de la baie.
    scope: [(wp, find, fetch) => RackOccupancy.collision(wp, "waypoints", find, fetch)],
  },
  floors: {
    fields: {
      location: { type: "string" },
    },
  },
  ipNetworks: {
    fields: {
      label: { type: "string", required: true },
      cidr:  { type: "string", required: true, format: "cidr" },
    },
    // V5b : changer le CIDR d'un réseau peut faire sortir ses adresses/plages → re-valider ces enfants.
    dependents: [
      { collection: "ipAddresses", fkField: "network_id" },
      { collection: "dhcpRanges", fkField: "network_id" },
    ],
  },
  ipAddresses: {
    fields: {
      address:      { type: "string", required: true, format: "ipv4" },
      network_id:   { type: "string", nullable: true, default: null, ref: "ipNetworks" },
      equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
    },
    crossEntity: [
      // CROSS-ENTITÉ (V5) : l'adresse doit appartenir au sous-réseau de SON réseau IP (lecture du `cidr` du réseau lié).
      (addr, fetch) => {
        if (!addr.network_id) return null;                                  // pas de réseau → règle non applicable
        const network = fetch("ipNetworks", addr.network_id);
        const cidr = network ? Ipv4.parseCidr(network.cidr) : null;
        if (!cidr) return null;                                             // réseau absent / CIDR invalide → déjà couvert ailleurs
        return Ipv4.inCidr(Ipv4.toInt(addr.address), cidr) ? null
          : { path: "address", message: `L'adresse ${addr.address} n'appartient pas au sous-réseau ${network!.cidr}.` };
      },
    ],
    scope: [
      // PORTÉE (V6a) : adresse UNIQUE dans le document (aucune autre adresse n'a la même valeur).
      (addr, find) => {
        if (!addr.address) return null;
        const duplicate = find("ipAddresses", "address", addr.address).some((other) => other.id !== addr.id);
        return duplicate ? { path: "address", message: `L'adresse ${addr.address} est déjà attribuée.` } : null;
      },
      // PORTÉE (V6b) : l'adresse statique ne doit pas tomber DANS une plage DHCP de son réseau.
      (addr, find) => {
        if (!addr.network_id) return null;
        const ip = Ipv4.toInt(addr.address);
        if (ip == null) return null;
        for (const range of find("dhcpRanges", "network_id", addr.network_id)) {
          const start = Ipv4.toInt(range.start_ip), end = Ipv4.toInt(range.end_ip);
          if (start != null && end != null && ip >= start && ip <= end) return { path: "address", message: `L'adresse est dans la plage DHCP ${range.start_ip}→${range.end_ip}.` };
        }
        return null;
      },
    ],
  },
  dhcpRanges: {
    fields: {
      start_ip:   { type: "string", required: true, format: "ipv4" },
      end_ip:     { type: "string", required: true, format: "ipv4" },
      network_id: { type: "string", nullable: true, default: null, ref: "ipNetworks" },
      server_id:  { type: "string", nullable: true, default: null, ref: "equipments" },
    },
    invariants: [
      {
        path: "end_ip",
        message: "La fin de plage doit être ≥ au début.",
        holds: (range) => {
          const start = Ipv4.toInt(range.start_ip), end = Ipv4.toInt(range.end_ip);
          return start == null || end == null || start <= end;   // bornes invalides → déjà signalées par le format
        },
      },
    ],
    crossEntity: [
      // CROSS-ENTITÉ (V5) : les deux bornes doivent appartenir au sous-réseau du réseau IP rattaché.
      (range, fetch) => {
        if (!range.network_id) return null;
        const network = fetch("ipNetworks", range.network_id);
        const cidr = network ? Ipv4.parseCidr(network.cidr) : null;
        if (!cidr) return null;
        for (const field of ["start_ip", "end_ip"] as const) {
          if (!Ipv4.inCidr(Ipv4.toInt(range[field]), cidr)) return { path: field, message: `La borne ${range[field]} n'appartient pas au sous-réseau ${network!.cidr}.` };
        }
        return null;
      },
    ],
    scope: [
      // PORTÉE (V6b) : pas de CHEVAUCHEMENT avec une autre plage du même réseau ; pas d'IP STATIQUE dans l'intervalle.
      (range, find) => {
        if (!range.network_id) return null;
        const start = Ipv4.toInt(range.start_ip), end = Ipv4.toInt(range.end_ip);
        if (start == null || end == null) return null;   // format déjà signalé en amont
        for (const other of find("dhcpRanges", "network_id", range.network_id)) {
          if (other.id === range.id) continue;
          const os = Ipv4.toInt(other.start_ip), oe = Ipv4.toInt(other.end_ip);
          if (os != null && oe != null && start <= oe && os <= end) return { path: "start_ip", message: `Chevauche la plage ${other.start_ip}→${other.end_ip}.` };
        }
        for (const addr of find("ipAddresses", "network_id", range.network_id)) {
          const ip = Ipv4.toInt(addr.address);
          if (ip != null && ip >= start && ip <= end) return { path: "start_ip", message: `L'adresse statique ${addr.address} est dans cette plage.` };
        }
        return null;
      },
    ],
  },
  spares: {
    fields: {
      name:                  { type: "string" },
      type:                  { type: "string", enum: SPARE_TYPE_IDS },
      status:                { type: "string", enum: SPARE_STATUS_IDS },
      assigned_equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
    },
  },
  sites: {
    fields: {
      name:    { type: "string", required: true },
      address: { type: "string" },
    },
  },
};

/* ============================================================================
   DataValidator — normalisation + validation (niveaux V1/V2/V3/V5/V5b).
   ============================================================================ */
export class DataValidator {
  /** `true` si une spécification existe pour cette collection (sinon : ni normalisation ni validation). */
  static hasSpec(collection: string): boolean {
    return collection in COLLECTION_SPECS;
  }

  /* ---- normalisation ---- */
  /** Renvoie une COPIE normalisée de `record` selon la spec de `collection`. Les champs non déclarés
      traversent inchangés (specs partielles) ; sans spec, l'enregistrement est renvoyé tel quel. */
  static normalizeRecord(collection: string, record: Record<string, any>): Record<string, any> {
    const spec = COLLECTION_SPECS[collection];
    if (!spec) return { ...record };
    const normalized: Record<string, any> = { ...record };
    for (const [field, fieldSpec] of Object.entries(spec.fields)) {
      normalized[field] = DataValidator.normalizeField(record[field], fieldSpec);
    }
    return normalized;
  }

  /* ---- validation ---- */
  /** Valide un enregistrement (supposé déjà normalisé) contre la spec de sa collection. Renvoie la liste des
      erreurs (vide = valide). Sans spec → aucune erreur. Si `fetch` est fourni, ajoute l'INTÉGRITÉ RÉFÉRENTIELLE
      (FK existantes — V2) et les règles CROSS-ENTITÉ (d'après les données de l'entité liée — V5). */
  static validateRecord(collection: string, record: Record<string, any>, fetch?: EntityFetcher, find?: RecordFinder): ValidationError[] {
    const spec = COLLECTION_SPECS[collection];
    if (!spec) return [];
    const errors: ValidationError[] = [];
    const id = typeof record.id === "string" ? record.id : undefined;
    const fail = (path: string, code: ValidationError["code"], message: string) =>
      errors.push({ collection, id, path, code, message });

    for (const [field, fieldSpec] of Object.entries(spec.fields)) {
      const value = record[field];

      if (DataValidator.isEmpty(value)) {
        if (fieldSpec.required) fail(field, "required", `Le champ « ${field} » est obligatoire.`);
        continue;   // vide non requis → rien d'autre à vérifier
      }
      if (value === null) {
        if (!fieldSpec.nullable) fail(field, "type", `Le champ « ${field} » ne peut pas être null.`);
        continue;
      }
      if (!DataValidator.matchesType(value, fieldSpec.type)) {
        fail(field, "type", `Le champ « ${field} » doit être de type ${fieldSpec.type}.`);
        continue;   // mauvais type → enum/min/ref non pertinents
      }
      if (fieldSpec.enum && !fieldSpec.enum.includes(value as string)) {
        fail(field, "enum", `Valeur « ${value} » invalide pour « ${field} » (attendu : ${fieldSpec.enum.join(", ")}).`);
      }
      if (fieldSpec.min != null && typeof value === "number" && value < fieldSpec.min) {
        fail(field, "min", `Le champ « ${field} » doit être ≥ ${fieldSpec.min}.`);
      }
      if (fieldSpec.format && typeof value === "string" && !DataValidator.matchesFormat(value, fieldSpec.format)) {
        fail(field, "format", `Le champ « ${field} » n'est pas ${fieldSpec.format === "cidr" ? "un CIDR IPv4 (ex. 10.0.0.0/24)" : "une adresse IPv4 (ex. 10.0.0.5)"}.`);
      }
      // intégrité référentielle (si `fetch`) : la (ou les) FK doivent désigner une entité existante (fetch ≠ null).
      if (fetch && fieldSpec.ref) {
        const referencedIds = fieldSpec.type === "string[]" ? (value as string[]) : [value as string];
        for (const referencedId of referencedIds) {
          if (typeof referencedId === "string" && referencedId && fetch(fieldSpec.ref, referencedId) == null) {
            fail(field, "ref_missing", `Référence « ${referencedId} » introuvable dans « ${fieldSpec.ref} ».`);
          }
        }
      }
    }
    // invariants INTER-CHAMPS (V3) : règles dépendant de plusieurs champs (ex. réseau principal ∈ réseaux du câble).
    for (const invariant of spec.invariants || []) {
      if (!invariant.holds(record)) fail(invariant.path, "invariant", invariant.message);
    }
    // règles CROSS-ENTITÉ (V5, si `fetch`) : dépendent des données d'une entité liée (ex. IP ∈ CIDR de son réseau).
    if (fetch) {
      for (const rule of spec.crossEntity || []) {
        const violation = rule(record, fetch);
        if (violation) fail(violation.path, "cross_entity", violation.message);
      }
    }
    // règles de PORTÉE (V6, si `find`) : unicité / non-chevauchement contre les pairs (ex. adresse IP unique).
    if (find) {
      for (const rule of spec.scope || []) {
        const violation = rule(record, find, fetch);
        if (violation) fail(violation.path, "scope", violation.message);
      }
    }
    return errors;
  }

  /** Normalise PUIS valide — l'enchaînement appliqué au serveur avant écriture. `fetch` (optionnel) active
      l'intégrité référentielle (V2) et les règles cross-entité (V5). */
  static normalizeAndValidate(collection: string, record: Record<string, any>, fetch?: EntityFetcher, find?: RecordFinder): { record: Record<string, any>; errors: ValidationError[] } {
    const normalized = DataValidator.normalizeRecord(collection, record);
    return { record: normalized, errors: DataValidator.validateRecord(collection, normalized, fetch, find) };
  }

  /** DÉPENDANCE INVERSE (V5b) : écrire `parentRecord` peut invalider ses ENFANTS (ex. réseau dont le `cidr` change
      → des adresses tombent hors sous-réseau). Pour chaque collection-enfant déclarée (`spec.dependents`), retrouve
      les enfants (`findChildren`) et re-joue LEURS règles cross-entité CONTRE LE NOUVEL ÉTAT du parent (pas encore
      persisté → on l'injecte via `fetch`). Renvoie les violations (rattachées à l'enfant fautif). Sur une création,
      l'id du parent est neuf → aucun enfant → no-op. */
  static validateDependents(parentCollection: string, parentRecord: Record<string, any>, findChildren: ChildFinder, fetch: EntityFetcher): ValidationError[] {
    const spec = COLLECTION_SPECS[parentCollection];
    if (!spec || !spec.dependents || !parentRecord.id) return [];
    // le parent en cours d'écriture n'est pas encore persisté : on le superpose à l'état lu pour que les règles
    // des enfants voient le NOUVEAU parent (ex. le nouveau `cidr`).
    const fetchWithNewParent: EntityFetcher = (collection, id) =>
      (collection === parentCollection && id === parentRecord.id) ? parentRecord : fetch(collection, id);
    const errors: ValidationError[] = [];
    for (const dependent of spec.dependents) {
      for (const child of findChildren(dependent.collection, dependent.fkField, parentRecord.id)) {
        for (const error of DataValidator.validateRecord(dependent.collection, child, fetchWithNewParent)) {
          if (error.code === "cross_entity") errors.push({ ...error, message: error.message + ` — incohérent avec la modification de « ${parentCollection} ».` });
        }
      }
    }
    return errors;
  }

  /** Construit un lecteur d'entité CONSCIENT DU LOT : une FK / règle cross-entité peut viser une entité créée ou
      modifiée dans le MÊME lot (on renvoie alors le CONTENU du lot, ex. un `cidr` modifié), ou supprimée (→ `null`).
      Sans cela, un `/transact` légitime (créer un réseau ET une adresse qui s'y rattache) serait rejeté à tort.
      Ordre d'application = suppressions → màj → créations, donc un upsert l'emporte sur une suppression du même id. */
  static buildBatchFetcher(base: EntityFetcher, batch: BatchOps): EntityFetcher {
    const upsertedInBatch = new Map<string, Record<string, any>>();
    const deletedInBatch = new Set<string>();
    for (const entry of [...(batch.creates || []), ...(batch.updates || [])]) {
      if (entry && entry.collection && entry.record && entry.record.id) upsertedInBatch.set(DataValidator.refKey(entry.collection, entry.record.id), entry.record);
    }
    for (const entry of (batch.deletes || [])) {
      if (entry && entry.collection && entry.id) deletedInBatch.add(DataValidator.refKey(entry.collection, entry.id));
    }
    return (collection: string, id: string): Record<string, any> | null => {
      const key = DataValidator.refKey(collection, id);
      if (upsertedInBatch.has(key)) return upsertedInBatch.get(key)!;   // créé/màj dans le lot → son CONTENU
      if (deletedInBatch.has(key)) return null;                         // supprimé dans le lot → n'existe plus
      return base(collection, id);                                      // sinon : état persisté
    };
  }

  /** Lecteur d'enfants CONSCIENT DU LOT (dépendance inverse V5b dans un `/transact`) : renvoie l'ensemble EFFECTIF
      des enfants APRÈS application du lot — état persisté, moins les enfants supprimés / déplacés hors du parent,
      plus ceux créés ou déplacés VERS le parent dans le lot. Sans cela, un lot qui change un `cidr` ET crée/déplace
      des adresses raterait des incohérences (ou en signalerait de fausses). */
  static buildBatchChildFinder(base: ChildFinder, batch: BatchOps): ChildFinder {
    return (collection: string, fkField: string, parentId: string): Record<string, any>[] => {
      const childrenById = new Map<string, Record<string, any>>();
      for (const child of base(collection, fkField, parentId)) if (child && child.id) childrenById.set(child.id, child);
      for (const del of (batch.deletes || [])) if (del && del.collection === collection) childrenById.delete(del.id);
      for (const entry of [...(batch.creates || []), ...(batch.updates || [])]) {
        if (!entry || entry.collection !== collection || !entry.record || !entry.record.id) continue;
        if (entry.record[fkField] === parentId) childrenById.set(entry.record.id, entry.record);   // (post-lot) rattaché à ce parent
        else childrenById.delete(entry.record.id);                                                  // déplacé / détaché du parent
      }
      return [...childrenById.values()];
    };
  }

  /* ---- helpers internes ---- */
  private static isEmpty(value: unknown): boolean {
    return value === undefined || value === null || value === "";
  }

  /** Met un champ en forme canonique selon sa règle de type. */
  private static normalizeField(rawValue: unknown, spec: FieldSpec): unknown {
    // Absent / vide : valeur par défaut si fournie, sinon `null` si nullable, sinon on laisse tel quel
    // (la validation signalera un éventuel `required`).
    if (DataValidator.isEmpty(rawValue)) {
      if ("default" in spec) return spec.default;
      if (spec.nullable) return null;
      return rawValue;
    }
    switch (spec.type) {
      case "number": {
        const coerced = Number(rawValue);
        return Number.isFinite(coerced) ? coerced : rawValue;   // non convertible → laissé (validation → "type")
      }
      case "boolean":
        return rawValue === true || rawValue === "true";
      case "string[]":
        return Array.isArray(rawValue) ? rawValue.filter((item) => typeof item === "string") : [];
      case "string":
      default:
        return String(rawValue);
    }
  }

  /** Vrai si la valeur correspond bien au type déclaré (hors `null`, géré à part par `nullable`). */
  private static matchesType(value: unknown, type: FieldType): boolean {
    switch (type) {
      case "number": return typeof value === "number" && Number.isFinite(value);
      case "boolean": return typeof value === "boolean";
      case "string[]": return Array.isArray(value) && value.every((item) => typeof item === "string");
      case "string": default: return typeof value === "string";
    }
  }

  private static matchesFormat(value: string, format: NonNullable<FieldSpec["format"]>): boolean {
    return format === "cidr" ? Ipv4.isCidr(value) : Ipv4.toInt(value) != null;
  }

  private static refKey(collection: string, id: string): string {
    return collection + " " + id;
  }
}
