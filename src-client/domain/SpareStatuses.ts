import { SPARE_STATUSES, SPARE_STATUS_DEFAULT, SpareStatusDef } from "./constants";

const BY_ID: Record<string, SpareStatusDef> = Object.fromEntries(SPARE_STATUSES.map((s) => [s.id, s]));

/** Registre des statuts de spare (available | assigned | decommissioned). */
export class SpareStatuses {
  static readonly ALL = SPARE_STATUSES;
  static readonly DEFAULT = SPARE_STATUS_DEFAULT;

  static isStatus(x: unknown): boolean { return !!BY_ID[x as string]; }
  static label(id: string): string { const s = BY_ID[id]; return s ? s.label : (id || "—"); }
}
