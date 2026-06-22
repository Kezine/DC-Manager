import { EQUIPMENT_TYPES, EQUIPMENT_TYPE_DEFAULT, COLOR_PALETTE, EquipmentTypeDef } from "../domain/constants";

const BY_ID: Record<string, EquipmentTypeDef> = Object.fromEntries(EQUIPMENT_TYPES.map((t) => [t.id, t]));
// Mémo : EQUIPMENT_TYPES / COLOR_PALETTE sont des constantes → jamais périmé.
const colorCache = new Map<string, string>();

/** Registre des types d'équipement (libellé, icône, couleur stable). */
export class EquipmentTypes {
  static readonly ALL = EQUIPMENT_TYPES;
  static readonly DEFAULT = EQUIPMENT_TYPE_DEFAULT;

  static label(id: string): string {
    const t = BY_ID[id];
    return t ? t.label : (id || "—");
  }

  static icon(id: string): string {
    const t = BY_ID[id] || BY_ID[EQUIPMENT_TYPE_DEFAULT];
    return t ? t.icon : "";
  }

  /** Couleur STABLE par type : indice dans EQUIPMENT_TYPES → COLOR_PALETTE ;
      type hors liste → hash stable de l'id sur la palette. */
  static color(id: string): string {
    if (colorCache.has(id)) return colorCache.get(id)!;
    const idx = EQUIPMENT_TYPES.findIndex((t) => t.id === id);
    let col: string;
    if (idx >= 0) col = COLOR_PALETTE[idx % COLOR_PALETTE.length];
    else {
      let h = 0;
      const s = String(id || "");
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      col = COLOR_PALETTE[Math.abs(h) % COLOR_PALETTE.length];
    }
    colorCache.set(id, col);
    return col;
  }
}
