/* ============================================================================
   NORMALISATION & VALIDATION DES DONNÉES — code PARTAGÉ front ⇄ back (TS pur).

   Garantit qu'un enregistrement écrit dans un document respecte le schéma, QUEL QUE
   SOIT le client (UI packagée ou autre interface postant au serveur). Appliqué aux deux
   points : saisie (UI) et écriture (serveur, autorité → 400). Cf. docs/validation.md.

   V1 = NIVEAU INTRINSÈQUE (record seul : requis / type / enum / borne). L'intégrité
   référentielle (FK existantes) et les invariants inter-champs viendront en V2 / V3.

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
  code: "required" | "type" | "enum" | "min" | "format" | "ref_missing" | "invariant" | "cross_entity";
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

/** Recherche des ENFANTS d'une entité (dépendance inverse V5b) : tous les enregistrements de `collection`
    dont `fkField` vaut `parentId`. INJECTÉ — l'UI l'adosse aux index du `Store`, le serveur à une requête. */
export type ChildFinder = (collection: string, fkField: string, parentId: string) => Record<string, any>[];

/* ---- spécifications des collections PILOTES (V1) ---- */
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
  },

  /* ---- collections ÉTENDUES (V1 intrinsèque + V2 référentiel) — specs PARTIELLES :
         champs d'identité (non requis), énumérations, et surtout les CLÉS ÉTRANGÈRES (`ref`). ---- */
  ports: {
    fields: {
      name:           { type: "string" },
      equipment_id:   { type: "string", nullable: true, default: null, ref: "equipments" },
      port_type_id:   { type: "string", nullable: true, default: null, ref: "portTypes" },
      parent_port_id: { type: "string", nullable: true, default: null, ref: "ports" },
      aggregate_id:   { type: "string", nullable: true, default: null, ref: "aggregates" },
      face_side:      { type: "string", enum: EQUIPMENT_FACE_IDS, default: "front" },
    },
  },
  aggregates: {
    fields: {
      name:         { type: "string" },
      equipment_id: { type: "string", nullable: true, default: null, ref: "equipments" },
    },
  },
  networks: {
    fields: {
      label:         { type: "string" },
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
      label: { type: "string" },
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
      name: { type: "string" },
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
  },
  floors: {
    fields: {
      location: { type: "string" },
    },
  },
  ipNetworks: {
    fields: {
      label: { type: "string" },
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
        const cidr = network ? parseCidr(network.cidr) : null;
        if (!cidr) return null;                                             // réseau absent / CIDR invalide → déjà couvert ailleurs
        return inCidr(ipv4ToInt(addr.address), cidr) ? null
          : { path: "address", message: `L'adresse ${addr.address} n'appartient pas au sous-réseau ${network!.cidr}.` };
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
          const start = ipv4ToInt(range.start_ip), end = ipv4ToInt(range.end_ip);
          return start == null || end == null || start <= end;   // bornes invalides → déjà signalées par le format
        },
      },
    ],
    crossEntity: [
      // CROSS-ENTITÉ (V5) : les deux bornes doivent appartenir au sous-réseau du réseau IP rattaché.
      (range, fetch) => {
        if (!range.network_id) return null;
        const network = fetch("ipNetworks", range.network_id);
        const cidr = network ? parseCidr(network.cidr) : null;
        if (!cidr) return null;
        for (const field of ["start_ip", "end_ip"] as const) {
          if (!inCidr(ipv4ToInt(range[field]), cidr)) return { path: field, message: `La borne ${range[field]} n'appartient pas au sous-réseau ${network!.cidr}.` };
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
      name:    { type: "string" },
      address: { type: "string" },
    },
  },
};

/** `true` si une spécification existe pour cette collection (sinon : ni normalisation ni validation). */
export function hasSpec(collection: string): boolean {
  return collection in COLLECTION_SPECS;
}

/* ---- normalisation ---- */
const isEmpty = (value: unknown): boolean => value === undefined || value === null || value === "";

/** Met un champ en forme canonique selon sa règle de type. Renvoie la valeur normalisée. */
function normalizeField(rawValue: unknown, spec: FieldSpec): unknown {
  // Absent / vide : valeur par défaut si fournie, sinon `null` si nullable, sinon on laisse tel quel
  // (la validation signalera un éventuel `required`).
  if (isEmpty(rawValue)) {
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

/** Renvoie une COPIE normalisée de `record` selon la spec de `collection`. Les champs non déclarés
    traversent inchangés (specs partielles en V1) ; sans spec, l'enregistrement est renvoyé tel quel. */
export function normalizeRecord(collection: string, record: Record<string, any>): Record<string, any> {
  const spec = COLLECTION_SPECS[collection];
  if (!spec) return { ...record };
  const normalized: Record<string, any> = { ...record };
  for (const [field, fieldSpec] of Object.entries(spec.fields)) {
    normalized[field] = normalizeField(record[field], fieldSpec);
  }
  return normalized;
}

/* ---- formats (IPv4 / CIDR) — primitives PURES, parité stricte avec src/core/Ip.ts ---- */
/** « a.b.c.d » → entier non signé, ou `null` si invalide (octets ≤ 255). */
export function ipv4ToInt(value: string): number | null {
  const match = typeof value === "string" ? value.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/) : null;
  if (!match) return null;
  let result = 0;
  for (let i = 1; i <= 4; i++) { const octet = +match[i]; if (octet > 255) return null; result = result * 256 + octet; }
  return result >>> 0;
}
/** Vrai si `value` est un CIDR IPv4 valide (« a.b.c.d/n », n ∈ 0..32). */
export function isCidr(value: string): boolean {
  return parseCidr(value) != null;
}

/** Sous-réseau IPv4 analysé (sous-ensemble de `core/Ip.Cidr` : ce dont la validation a besoin). */
export interface ParsedCidr { base: number; prefix: number; mask: number; network: number; }

/** « a.b.c.d/n » → sous-réseau analysé, ou `null` si invalide. Parité stricte avec `core/Ip.parseCidr`. */
export function parseCidr(value: string): ParsedCidr | null {
  const match = typeof value === "string" ? value.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/) : null;
  if (!match) return null;
  const base = ipv4ToInt(match[1]); const prefix = +match[2];
  if (base == null || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - prefix)) >>> 0);
  return { base, prefix, mask, network: (base & mask) >>> 0 };
}

/** L'entier d'IP appartient-il au sous-réseau ? */
export function inCidr(ipInt: number | null, cidr: ParsedCidr | null): boolean {
  return cidr != null && ipInt != null && ((ipInt & cidr.mask) >>> 0) === cidr.network;
}
function matchesFormat(value: string, format: NonNullable<FieldSpec["format"]>): boolean {
  return format === "cidr" ? isCidr(value) : ipv4ToInt(value) != null;
}

/* ---- validation ---- */
/** Vrai si la valeur correspond bien au type déclaré (hors `null`, géré à part par `nullable`). */
function matchesType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "string[]": return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "string": default: return typeof value === "string";
  }
}

/** Valide un enregistrement (supposé déjà normalisé) contre la spec de sa collection. Renvoie la liste des
    erreurs (vide = valide). Sans spec → aucune erreur. Si `fetch` est fourni, ajoute l'INTÉGRITÉ RÉFÉRENTIELLE
    (FK existantes — V2) et les règles CROSS-ENTITÉ (d'après les données de l'entité liée — V5). */
export function validateRecord(collection: string, record: Record<string, any>, fetch?: EntityFetcher): ValidationError[] {
  const spec = COLLECTION_SPECS[collection];
  if (!spec) return [];
  const errors: ValidationError[] = [];
  const id = typeof record.id === "string" ? record.id : undefined;
  const fail = (path: string, code: ValidationError["code"], message: string) =>
    errors.push({ collection, id, path, code, message });

  for (const [field, fieldSpec] of Object.entries(spec.fields)) {
    const value = record[field];

    if (isEmpty(value)) {
      if (fieldSpec.required) fail(field, "required", `Le champ « ${field} » est obligatoire.`);
      continue;   // vide non requis → rien d'autre à vérifier
    }
    if (value === null) {
      if (!fieldSpec.nullable) fail(field, "type", `Le champ « ${field} » ne peut pas être null.`);
      continue;
    }
    if (!matchesType(value, fieldSpec.type)) {
      fail(field, "type", `Le champ « ${field} » doit être de type ${fieldSpec.type}.`);
      continue;   // mauvais type → enum/min/ref non pertinents
    }
    if (fieldSpec.enum && !fieldSpec.enum.includes(value as string)) {
      fail(field, "enum", `Valeur « ${value} » invalide pour « ${field} » (attendu : ${fieldSpec.enum.join(", ")}).`);
    }
    if (fieldSpec.min != null && typeof value === "number" && value < fieldSpec.min) {
      fail(field, "min", `Le champ « ${field} » doit être ≥ ${fieldSpec.min}.`);
    }
    if (fieldSpec.format && typeof value === "string" && !matchesFormat(value, fieldSpec.format)) {
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
  return errors;
}

/** Normalise PUIS valide — l'enchaînement appliqué au serveur avant écriture. `fetch` (optionnel) active
    l'intégrité référentielle (V2) et les règles cross-entité (V5). */
export function normalizeAndValidate(collection: string, record: Record<string, any>, fetch?: EntityFetcher): { record: Record<string, any>; errors: ValidationError[] } {
  const normalized = normalizeRecord(collection, record);
  return { record: normalized, errors: validateRecord(collection, normalized, fetch) };
}

/** DÉPENDANCE INVERSE (V5b) : écrire `parentRecord` peut invalider ses ENFANTS (ex. réseau dont le `cidr` change
    → des adresses tombent hors sous-réseau). Pour chaque collection-enfant déclarée (`spec.dependents`), retrouve
    les enfants (`findChildren`) et re-joue LEURS règles cross-entité CONTRE LE NOUVEL ÉTAT du parent (qui n'est pas
    encore persisté → on l'injecte via `fetch`). Renvoie les violations (rattachées à l'enfant fautif). Sur une
    création, l'id du parent est neuf → aucun enfant → no-op. */
export function validateDependents(parentCollection: string, parentRecord: Record<string, any>, findChildren: ChildFinder, fetch: EntityFetcher): ValidationError[] {
  const spec = COLLECTION_SPECS[parentCollection];
  if (!spec || !spec.dependents || !parentRecord.id) return [];
  // le parent en cours d'écriture n'est pas encore persisté : on le superpose à l'état lu pour que les règles
  // des enfants voient le NOUVEAU parent (ex. le nouveau `cidr`).
  const fetchWithNewParent: EntityFetcher = (collection, id) =>
    (collection === parentCollection && id === parentRecord.id) ? parentRecord : fetch(collection, id);
  const errors: ValidationError[] = [];
  for (const dependent of spec.dependents) {
    for (const child of findChildren(dependent.collection, dependent.fkField, parentRecord.id)) {
      for (const error of validateRecord(dependent.collection, child, fetchWithNewParent)) {
        if (error.code === "cross_entity") errors.push({ ...error, message: error.message + ` — incohérent avec la modification de « ${parentCollection} ».` });
      }
    }
  }
  return errors;
}

/* ---- intégrité référentielle dans un LOT (transaction) ---- */
/** Forme minimale d'un lot atomique (mêmes champs que la transaction serveur). */
export interface BatchOps {
  creates?: Array<{ collection: string; record: Record<string, any> }>;
  updates?: Array<{ collection: string; record: Record<string, any> }>;
  deletes?: Array<{ collection: string; id: string }>;
}

const refKey = (collection: string, id: string): string => collection + " " + id;

/** Construit un résolveur d'existence CONSCIENT DU LOT : une FK peut désigner une entité créée dans le MÊME
    lot (pas encore persistée), ou ne plus exister car supprimée dans le lot. Sans cela, un `/transact` légitime
    (créer un port ET le câble qui le référence) serait rejeté à tort. L'ordre d'application du lot étant
    suppressions → mises à jour → créations, un upsert l'emporte sur une suppression du même id. */
export function buildBatchFetcher(base: EntityFetcher, batch: BatchOps): EntityFetcher {
  const upsertedInBatch = new Map<string, Record<string, any>>();
  const deletedInBatch = new Set<string>();
  for (const entry of [...(batch.creates || []), ...(batch.updates || [])]) {
    if (entry && entry.collection && entry.record && entry.record.id) upsertedInBatch.set(refKey(entry.collection, entry.record.id), entry.record);
  }
  for (const entry of (batch.deletes || [])) {
    if (entry && entry.collection && entry.id) deletedInBatch.add(refKey(entry.collection, entry.id));
  }
  return (collection: string, id: string): Record<string, any> | null => {
    const key = refKey(collection, id);
    if (upsertedInBatch.has(key)) return upsertedInBatch.get(key)!;   // créé/màj dans le lot → son CONTENU (appliqué après les deletes)
    if (deletedInBatch.has(key)) return null;                         // supprimé dans le lot → n'existe plus
    return base(collection, id);                                      // sinon : état persisté
  };
}
