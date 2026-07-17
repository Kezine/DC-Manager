import { GROUP_TYPES, GROUP_TYPE_DEFAULT, GroupTypeDef } from "./constants";
import { I18n } from "../i18n/I18n";

const BY_ID: Record<string, GroupTypeDef> = Object.fromEntries(GROUP_TYPES.map((t) => [t.id, t]));

/** Registre des types de groupe (stack | system | general). */
export class GroupTypes {
  static readonly ALL = GROUP_TYPES;
  static readonly DEFAULT = GROUP_TYPE_DEFAULT;

  static isType(x: unknown): boolean {
    return !!BY_ID[x as string];
  }

  static label(id: string): string {
    const t = BY_ID[id];
    return t ? I18n.t(t.labelKey) : (id || "—");
  }
}
