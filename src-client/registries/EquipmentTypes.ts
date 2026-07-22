import { EQUIPMENT_TYPES, EQUIPMENT_TYPE_DEFAULT, EQUIPMENT_TYPE_FALLBACK, COLOR_PALETTE, EquipmentTypeDef } from "../domain/constants";
import { I18n } from "../i18n/I18n";

const BY_ID: Record<string, EquipmentTypeDef> = Object.fromEntries(EQUIPMENT_TYPES.map((t) => [t.id, t]));
// Mémo : EQUIPMENT_TYPES / COLOR_PALETTE sont des constantes → jamais périmé.
const colorCache = new Map<string, string>();

/** Registre des types d'équipement (libellé, icône, couleur stable). Un id NON reconnu (ancien id français, id
    retiré…) est RÉSOLU sur le type de repli `other` — pas de migration de données ni de rétro-compat. */
export class EquipmentTypes {
  static readonly ALL = EQUIPMENT_TYPES;
  static readonly DEFAULT = EQUIPMENT_TYPE_DEFAULT;

  /** L'id correspond-il à un type CONNU ? */
  static has(id: string): boolean {
    return !!BY_ID[id];
  }

  /** Id RÉSOLU : l'id tel quel s'il est connu, sinon le repli `other`. Point d'entrée unique du fallback. */
  static resolveId(id: string): string {
    return BY_ID[id] ? id : EQUIPMENT_TYPE_FALLBACK;
  }

  /** Type à « pilotage fin » de l'app (traitement spécifique), non supprimable à terme — cf. note EQUIPMENT_TYPES. */
  static isSystem(id: string): boolean {
    return !!(BY_ID[id] && BY_ID[id].system);
  }

  static label(id: string): string {
    if (!id) return "—";   // pas de type (id vide) → tiret ; un id NON vide mais inconnu retombe sur `other`.
    const t = BY_ID[id] || BY_ID[EQUIPMENT_TYPE_FALLBACK];
    return t ? I18n.t(t.labelKey) : id;
  }

  static icon(id: string): string {
    const t = BY_ID[id] || BY_ID[EQUIPMENT_TYPE_FALLBACK] || BY_ID[EQUIPMENT_TYPE_DEFAULT];
    return t ? t.icon : "";
  }

  /** Couleur STABLE par type : indice (du type RÉSOLU) dans EQUIPMENT_TYPES → COLOR_PALETTE. */
  static color(id: string): string {
    if (colorCache.has(id)) return colorCache.get(id)!;
    const idx = EQUIPMENT_TYPES.findIndex((t) => t.id === EquipmentTypes.resolveId(id));
    const col = COLOR_PALETTE[(idx >= 0 ? idx : 0) % COLOR_PALETTE.length];
    colorCache.set(id, col);
    return col;
  }
}
