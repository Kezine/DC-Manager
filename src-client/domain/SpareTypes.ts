import { SPARE_TYPES, SPARE_TYPE_DEFAULT, SpareTypeDef } from "./constants";

const BY_ID: Record<string, SpareTypeDef> = Object.fromEntries(SPARE_TYPES.map((t) => [t.id, t]));

/** Registre des types de spare (hdd_ssd | transceiver | other). */
export class SpareTypes {
  static readonly ALL = SPARE_TYPES;
  static readonly DEFAULT = SPARE_TYPE_DEFAULT;

  static isType(x: unknown): boolean { return !!BY_ID[x as string]; }
  static label(id: string): string { const t = BY_ID[id]; return t ? t.label : (id || "—"); }
  static icon(id: string): string { const t = BY_ID[id]; return t ? t.icon : ""; }
}
