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

/* ---- montage latéral (side) & mural (wall) ---- */
export const SIDE_U_STEP = 2;                 // résolution verticale du montage latéral (U)
export const SIDE_POST_INSET = 8;             // retrait (mm) de la marge utile au-delà du montant 19″
export const WALL_COL_MIN = SIDE_U_STEP * U_MM;   // largeur mini d'une colonne murale (le long de la profondeur de marge)
export const EQUIP_FREE_DEFAULT_MM = 400;     // empreinte/hauteur par défaut d'un équipement libre (mm)

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
/** Mapping face d'équipement → champ FK de l'image de façade correspondante. */
export const EQUIP_FACE_IMG_FIELD: Record<string, string> = {
  front: "face_image_id", rear: "face_image_rear_id",
  top: "face_image_top_id", bottom: "face_image_bottom_id",
  left: "face_image_left_id", right: "face_image_right_id",
};

/** Numéro de release formel — estampillé dans meta.app_release à la sérialisation. */
export const APP_RELEASE = "R1";

/* ---- palette de couleurs (thème « couleur par type » 3D, couleurs de groupe…) ---- */
export const COLOR_PALETTE = [
  "#ff5500", "#facc15", "#4ade80", "#38bdf8", "#a78bfa", "#f472b6", "#fb923c", "#34d399",
  "#60a5fa", "#fbbf24", "#e879f9", "#22d3ee", "#f87171", "#84cc16", "#c084fc", "#2dd4bf",
  "#ec4899", "#eab308", "#10b981", "#0ea5e9", "#8b5cf6", "#f43f5e", "#14b8a6", "#d946ef", "#15803d",
];

/* ---- types d'équipement (icône SVG viewBox 24, currentColor) ---- */
export interface EquipmentTypeDef { id: string; label: string; icon: string; }
export const EQUIPMENT_TYPES: EquipmentTypeDef[] = [
  { id: "switch",     label: "Switch",     icon: `<rect x="2" y="6" width="20" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 10h7l-2-2m2 2-2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 14h-7l2-2m-2 2 2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` },
  { id: "serveur",    label: "Serveur",    icon: `<rect x="3" y="4" width="18" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="13" width="18" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="7.5" r="1.1" fill="currentColor"/><circle cx="7" cy="16.5" r="1.1" fill="currentColor"/>` },
  { id: "caisson",    label: "Caisson",    icon: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>` },
  { id: "pc",         label: "PC",         icon: `<rect x="3" y="4" width="18" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 20h6M12 16v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` },
  { id: "imprimante", label: "Imprimante", icon: `<path d="M7 9V4h10v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><rect x="3" y="9" width="18" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 14h10v6H7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="17.5" cy="12" r="0.9" fill="currentColor"/>` },
  { id: "ap",         label: "AP",         icon: `<path d="M5 11a10 10 0 0 1 14 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8 14a6 6 0 0 1 8 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="18" r="1.4" fill="currentColor"/>` },
  { id: "patch_panel",label: "Patch panel",icon: `<rect x="2" y="8" width="20" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="6" cy="12" r="1" fill="currentColor"/><circle cx="9.5" cy="12" r="1" fill="currentColor"/><circle cx="13" cy="12" r="1" fill="currentColor"/><circle cx="16.5" cy="12" r="1" fill="currentColor"/><circle cx="20" cy="12" r="1" fill="currentColor"/>` },
  { id: "pdu",        label: "PDU",        icon: `<rect x="8" y="2" width="8" height="20" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="6" r="1.1" fill="currentColor"/><circle cx="12" cy="10" r="1.1" fill="currentColor"/><circle cx="12" cy="14" r="1.1" fill="currentColor"/><circle cx="12" cy="18" r="1.1" fill="currentColor"/>` },
  { id: "autre",      label: "Autre",      icon: `<rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="12" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/><circle cx="16" cy="12" r="1.1" fill="currentColor"/>` },
];
export const EQUIPMENT_TYPE_DEFAULT = "switch";

/** Sources d'alimentation possibles d'un réseau Power. */
export const POWER_SOURCES = [
  { id: "ups", label: "Sous UPS" }, { id: "ups_gen", label: "UPS + Générateur" }, { id: "grid", label: "Réseau (Grid only)" },
];

/** Rôles de port (catégorie data | power). */
export interface PortRoleDef { id: string; label: string; kind: "data" | "power"; }
export const PORT_ROLES: PortRoleDef[] = [
  { id: "mgmt",  label: "Mgmt",  kind: "data" },
  { id: "data",  label: "Data",  kind: "data" },
  { id: "power", label: "Power", kind: "power" },
];

/* ---- profondeurs de montage (legacy) ---- */
export const MOUNT_DEPTHS = [
  { id: "full", label: "Full-depth" },
  { id: "half", label: "Half-depth" },
  { id: "quarter", label: "Quarter-depth" },
];
/** Part de la profondeur de cage occupée par chaque enum legacy (`none` = pseudo-élément). */
export const DEPTH_FRAC: Record<string, number> = { full: 1, half: 0.5, quarter: 0.25, none: 0.06 };

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
