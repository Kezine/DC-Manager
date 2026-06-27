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
  /** Collection cible d'une clé étrangère (exploité par l'intégrité référentielle — V2). */
  ref?: string;
}

/** Spécification d'une collection : ses champs déclarés (partielle en V1 — seuls les champs
    porteurs de règles sont listés ; les autres traversent sans contrôle ni normalisation). */
export interface CollectionSpec {
  fields: Record<string, FieldSpec>;
}

/** Erreur de validation — contrat partagé UI ⇄ serveur. */
export interface ValidationError {
  collection: string;
  id?: string;
  path: string;            // champ concerné
  code: "required" | "type" | "enum" | "min";
  message: string;         // message humain (français)
}

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
      pdu_max_a:      { type: "number", nullable: true, default: null },
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

/** Valide un enregistrement (supposé déjà normalisé) contre la spec de sa collection.
    Renvoie la liste des erreurs (vide = valide). Sans spec pour la collection → aucune erreur. */
export function validateRecord(collection: string, record: Record<string, any>): ValidationError[] {
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
      continue;   // mauvais type → enum/min non pertinents
    }
    if (fieldSpec.enum && !fieldSpec.enum.includes(value as string)) {
      fail(field, "enum", `Valeur « ${value} » invalide pour « ${field} » (attendu : ${fieldSpec.enum.join(", ")}).`);
    }
    if (fieldSpec.min != null && typeof value === "number" && value < fieldSpec.min) {
      fail(field, "min", `Le champ « ${field} » doit être ≥ ${fieldSpec.min}.`);
    }
  }
  return errors;
}

/** Normalise PUIS valide — l'enchaînement appliqué au serveur avant écriture. */
export function normalizeAndValidate(collection: string, record: Record<string, any>): { record: Record<string, any>; errors: ValidationError[] } {
  const normalized = normalizeRecord(collection, record);
  return { record: normalized, errors: validateRecord(collection, normalized) };
}
