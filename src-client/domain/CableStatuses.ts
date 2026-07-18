import {
  CABLE_STATUSES,
  CABLE_STATUS_DRAFT,
  CABLE_STATUS_DEFAULT_NEW,
  CABLE_STATUS_DEFAULT_LEGACY,
  CABLE_STATUS_BROKEN,
  CableStatusDef,
} from "./constants";
import { I18n } from "../i18n/I18n";

/** Registre des statuts de câble (cycle de vie). */
export class CableStatuses {
  static readonly ALL = CABLE_STATUSES;
  static readonly DRAFT = CABLE_STATUS_DRAFT;
  static readonly DEFAULT_NEW = CABLE_STATUS_DEFAULT_NEW;
  static readonly DEFAULT_LEGACY = CABLE_STATUS_DEFAULT_LEGACY;
  static readonly BROKEN = CABLE_STATUS_BROKEN;

  static get(id: string): CableStatusDef | null {
    return CABLE_STATUSES.find((s) => s.id === id) || null;
  }

  static label(id: string): string {
    const s = CableStatuses.get(id);
    return s ? I18n.t(s.labelKey) : (id || "—");
  }

  static isStatus(id: unknown): boolean {
    return CABLE_STATUSES.some((s) => s.id === id);
  }
}
