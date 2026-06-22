/* =============================================================================
   Constantes du DOMAINE (données pures, pas de comportement).
   Extraites telles quelles du HTML monolithique (repère monde en mm :
   X = largeur salle, Y = profondeur, Z = hauteur ; 1 U = 44,45 mm).
   ============================================================================= */

/* ---- géométrie de base ---- */
export const U_MM = 44.45;                    // hauteur d'un U (mm)
export const RACK_WIDTH_DEFAULT = 600;        // largeur EXTÉRIEURE de rack par défaut (mm)
export const RACK_MOUNT_MARGIN_DEFAULT = 50;  // marge par défaut (mm) — repli latéral ET vertical (≤ v108)
export const RACK_MOUNT_WIDTH = 482.6;        // entraxe des rails 19″ (mm) = largeur zone de montage
export const RACK_EAR_MM = 15;                // largeur d'une oreille de montage, par côté (mm)
export const RACK_DEPTH_DEFAULT = 1000;       // profondeur EXTÉRIEURE par défaut (mm)
export const RACK_DEPTHS = [600, 800, 1000, 1200];
export const RACK_ORIENTATIONS = [0, 90, 180, 270];   // pas de 90° (sens horaire)

/* ---- salle / étage ---- */
export const DC_CELL_DEFAULT = 600;           // dalle faux-plancher 600×600 → maille grille
export const DC_WIDTH_DEFAULT = 6000;
export const DC_DEPTH_DEFAULT = 6000;
export const FLOOR_WIDTH_DEFAULT = 20000;     // plan de bâtiment par défaut (mm)
export const FLOOR_DEPTH_DEFAULT = 20000;
export const FLOOR_CELL_DEFAULT = 1000;       // maille du plan d'étage (1 m)
export const OOB_HEIGHT_DEFAULT = 3000;       // hauteur standard d'un OOB (mm)

/* ---- waypoints / conduits ---- */
export const WAYPOINT_Z_DEFAULT = 2400;       // hauteur par défaut d'un waypoint (mm)
export const CONDUIT_W_DEFAULT = 300;         // largeur de section d'un chemin de câbles (mm)
export const CONDUIT_H_DEFAULT = 100;         // hauteur de section (mm)
export const BRUSH_PADDING_MM = 10;           // brosse : padding interne du pourtour (mm)

/* ---- faces d'équipement ----
   Avant/arrière : tous. Dessus/dessous/gauche/droite : équipements en
   dimensionnement LIBRE uniquement. */
export interface FaceDef { id: string; label: string; }
export const EQUIP_FACES: FaceDef[] = [
  { id: "front", label: "Avant" },   { id: "rear", label: "Arrière" },
  { id: "top", label: "Dessus" },    { id: "bottom", label: "Dessous" },
  { id: "left", label: "Gauche" },   { id: "right", label: "Droite" },
];
export const EQUIP_FACE_IDS: string[] = EQUIP_FACES.map((f) => f.id);
export const EQUIP_ANNEX_FACE_IDS = ["top", "bottom", "left", "right"];
export const EQUIP_DEPTHS = ["full", "half", "quarter"];

/* ---- types de groupe ---- */
export interface GroupTypeDef { id: string; label: string; hint: string; }
export const GROUP_TYPES: GroupTypeDef[] = [
  { id: "stack",   label: "Stack",   hint: "Grouper les switchs d'un même stack" },
  { id: "system",  label: "System",  hint: "Grouper les éléments d'un même système (ex. un SAN)" },
  { id: "general", label: "General", hint: "Regroupement générique" },
];
export const GROUP_TYPE_DEFAULT = "general";

/* ---- statut de câble (cycle de vie ; slug stable, pas le libellé affiché) ---- */
export interface CableStatusDef { id: string; label: string; cls: string; draft?: boolean; }
export const CABLE_STATUSES: CableStatusDef[] = [
  { id: "brouillon",   label: "Brouillon",   cls: "status-brouillon", draft: true },
  { id: "planifie",    label: "Planifié",    cls: "status-planifie" },
  { id: "cable",       label: "Câblé",       cls: "status-cable" },
  { id: "a-remplacer", label: "À remplacer", cls: "status-a-remplacer" },
  { id: "casse",       label: "Cassé",       cls: "status-casse" },
];
export const CABLE_STATUS_DRAFT = "brouillon";          // imposé tant que l'assignation est incomplète
export const CABLE_STATUS_DEFAULT_NEW = "planifie";     // câble complet créé via le formulaire
export const CABLE_STATUS_DEFAULT_LEGACY = "cable";     // câble chargé sans statut = déjà câblé
export const CABLE_STATUS_BROKEN = "casse";

/* ---- pseudo-équipements montables en rack (icône SVG viewBox 24, currentColor) ---- */
export interface RackItemKindDef { id: string; label: string; icon: string; }
export const RACK_ITEM_KINDS: RackItemKindDef[] = [
  { id: "blank",     label: "Blanking Plate", icon: `<rect x="2" y="8" width="20" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="5.5" cy="12" r="1.1" fill="currentColor"/><circle cx="18.5" cy="12" r="1.1" fill="currentColor"/><path d="M9 12h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` },
  { id: "tray",      label: "Tray",           icon: `<path d="M5 10h14v2l-1.5 4h-11L5 12z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M3 10h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` },
  { id: "keepblank", label: "KeepBlank",      icon: `<rect x="2" y="8" width="20" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2.5"/><path d="M8 15l8-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` },
];
