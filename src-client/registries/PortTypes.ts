import { DEFAULT_PORT_TYPES, PortTypeDef } from "./defaultCatalogs";

const BY_ID: Record<string, PortTypeDef> = Object.fromEntries(DEFAULT_PORT_TYPES.map((t) => [t.id, t]));

/** Registre des types de port standardisés (catalogue fermé). */
export class PortTypes {
  static readonly ALL = DEFAULT_PORT_TYPES;

  static get(id: string): PortTypeDef | null { return BY_ID[id] || null; }
  static label(id: string): string { const t = BY_ID[id]; return t ? t.name : (id || "—"); }
  /** Famille de compatibilité d'un type (null si inconnu). */
  static family(id: string): string | null { const t = BY_ID[id]; return t ? t.family : null; }

  /** Débit d'une chaîne « 40G », « 10G », « 100M », « 1T » en Gbps (null si non parsable). */
  static speedGbps(speed: string | null | undefined): number | null {
    if (!speed) return null;
    const m = String(speed).trim().match(/^([\d.]+)\s*([GMT])/i);
    if (!m) return null;
    const v = parseFloat(m[1]); if (!isFinite(v)) return null;
    const u = m[2].toUpperCase();
    return u === "M" ? v / 1000 : (u === "T" ? v * 1000 : v);
  }
}
