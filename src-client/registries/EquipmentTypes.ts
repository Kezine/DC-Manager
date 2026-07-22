import { EQUIPMENT_TYPES, EQUIPMENT_TYPE_DEFAULT, EQUIPMENT_TYPE_FALLBACK, COLOR_PALETTE, EquipmentTypeDef } from "../domain/constants";
import { I18n } from "../i18n/I18n";

const BY_ID: Record<string, EquipmentTypeDef> = Object.fromEntries(EQUIPMENT_TYPES.map((t) => [t.id, t]));
// Mémo : EQUIPMENT_TYPES / COLOR_PALETTE sont des constantes → jamais périmé.
const colorCache = new Map<string, string>();

/* Matrice ÉNERGIE par type (source de vérité = maquette design-system/briefs/equipment-editor). Isolée ici, en un
   point unique, plutôt que dispersée en littéraux `type === "..."` dans les vues (formulaire + fiche détail — n°3).
   NO_POE  : infrastructure d'ÉNERGIE (distribution/secours) + patch passif → ne participent PAS au PoE (ni PSE ni PD).
   CAPACITY: portent une CAPACITÉ d'alimentation en ampères (départ de bandeau/tableau). */
const NO_POE_TYPES = new Set(["pdu", "switchboard", "ups", "patch_panel"]);
const CAPACITY_TYPES = new Set(["pdu", "switchboard"]);

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

  /* ---- capacités ÉNERGIE par type (pilotent la modale caméléon : visibilité + neutralisation par type) ---- */

  /** Le type participe-t-il au PoE (bascule « équipement PoE » + catégorie PoE des ports) ? Exclut l'infrastructure
      d'énergie (pdu/switchboard/ups) et le patch passif — ni PSE ni PD. */
  static canPoe(id: string): boolean {
    return !NO_POE_TYPES.has(EquipmentTypes.resolveId(id));
  }

  /** Le type peut-il SOURCER du PoE (budget total + jauge + ports PSE) ? Aujourd'hui le switch SEUL : les autres
      types PoE ne font que CONSOMMER (PD). Pilote le masquage du budget et du choix PSE/PD (cf. formulaire). */
  static isPoeSource(id: string): boolean {
    return EquipmentTypes.resolveId(id) === "switch";
  }

  /** Le type porte-t-il une CAPACITÉ d'alimentation (A) — départ de bandeau (pdu) ou de tableau (switchboard) ? */
  static hasPowerCapacity(id: string): boolean {
    return CAPACITY_TYPES.has(EquipmentTypes.resolveId(id));
  }

  /** Le type CONSOMME-t-il (champ conso W) ? Un tableau électrique (switchboard) FOURNIT l'énergie, il ne consomme pas. */
  static consumes(id: string): boolean {
    return EquipmentTypes.resolveId(id) !== "switchboard";
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
