import { DEFAULT_PORT_TYPES, PortTypeDef } from "./defaultCatalogs";

const BY_ID: Record<string, PortTypeDef> = Object.fromEntries(DEFAULT_PORT_TYPES.map((t) => [t.id, t]));

/** Registre des types de port standardisés (catalogue fermé). */
export class PortTypes {
  static readonly ALL = DEFAULT_PORT_TYPES;

  static get(id: string): PortTypeDef | null { return BY_ID[id] || null; }
  static label(id: string): string { const t = BY_ID[id]; return t ? t.name : (id || "—"); }
  /** Famille de compatibilité d'un type (null si inconnu). */
  static family(id: string): string | null { const t = BY_ID[id]; return t ? t.family : null; }
}
