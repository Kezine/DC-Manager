import { DEFAULT_CABLE_TYPES, CableTypeDef } from "./defaultCatalogs";

const BY_ID: Record<string, CableTypeDef> = Object.fromEntries(DEFAULT_CABLE_TYPES.map((t) => [t.id, t]));

/** Registre des types de câble standardisés (catalogue fermé). */
export class CableTypes {
  static readonly ALL = DEFAULT_CABLE_TYPES;

  static get(id: string): CableTypeDef | null { return BY_ID[id] || null; }
  static label(id: string): string { const t = BY_ID[id]; return t ? t.name : (id || "—"); }
  /** Famille de compatibilité d'un type (null si inconnu). */
  static family(id: string): string | null { const t = BY_ID[id]; return t ? t.family : null; }
}
