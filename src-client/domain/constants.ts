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
export const RACK_EAR_STANDOFF_MM = 3;        // épaisseur standard RÉSERVÉE aux oreilles DEVANT la cage : la façade de tout occupant (équipement ou pseudo) est posée à cette distance du plan de montage — les oreilles remplissent la réserve, dans la continuité de la face, sans collision avec les montants
export const RACK_DEPTH_DEFAULT = 1000;       // profondeur EXTÉRIEURE par défaut (mm)
export const RACK_DEPTHS = [600, 800, 1000, 1200];
export const RACK_ORIENTATIONS = [0, 90, 180, 270];   // pas de 90° (sens horaire)
/** Faces de baie (simple / double). Libellés i18n (résolus au rendu, cf. domaine `domain`). */
export const RACK_SIDES = [{ id: "single", labelKey: "domain.rackSide.single" }, { id: "dual", labelKey: "domain.rackSide.dual" }];
/** Faces portant une porte (avant / arrière). Libellés i18n. */
export const RACK_FACES = [{ id: "front", labelKey: "domain.rackFace.front" }, { id: "rear", labelKey: "domain.rackFace.rear" }];

/* ---- lieux & étages (listes FERMÉES — éditables ici) ---- */
// LOCATIONS NON migré en i18n VOLONTAIREMENT : ses libellés servent de VALEURS SEED PERSISTÉES (Store amorce le
// nom des sites par défaut à partir d'eux) et sont des noms propres géographiques identiques en fr/en — ce sont
// des données, pas des chaînes d'UI traduisibles.
export const LOCATIONS = [
  { id: "liege", label: "Liège" }, { id: "herstal", label: "Herstal" }, { id: "bruxelles", label: "Bruxelles" },
];
export const FLOORS = ["-3", "-2", "-1", "0", "1", "2", "3", "4", "5"];

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
export const DC_GAP_DEFAULT = 2000;           // écart (mm) entre salles / niveaux de la vue multi-salles

/* ---- waypoints / conduits ---- */
export const WAYPOINT_Z_DEFAULT = 2400;       // hauteur par défaut d'un waypoint (mm)
export const CONDUIT_W_DEFAULT = 300;         // largeur de section d'un chemin de câbles (mm)
export const CONDUIT_H_DEFAULT = 100;         // hauteur de section (mm)
export const BRUSH_PADDING_MM = 10;           // brosse : padding interne du pourtour (mm)
export const RACK_DEPTH_SAFETY_MM = 100;      // marge de sécurité (mm) retranchée de la profondeur dispo derrière une porte (montage en U / brosse). 0 = aucune.

/* ---- breakout ----
   Facteurs de BREAKOUT standard (« spans »). Un breakout impose TOUJOURS débit(trunk) =
   N × débit(lane), avec N ∈ {2,4,8} : 40G→4×10G; 100G→4×25G ou 2×50G; 400G→8×50G… */
export const BREAKOUT_SPANS = [2, 4, 8];

/* ---- faces d'équipement ----
   Avant/arrière : tous. Dessus/dessous/gauche/droite : équipements en
   dimensionnement LIBRE uniquement. */
export interface FaceDef { id: string; labelKey: string; }
export const EQUIP_FACES: FaceDef[] = [
  { id: "front", labelKey: "domain.equipFace.front" },   { id: "rear", labelKey: "domain.equipFace.rear" },
  { id: "top", labelKey: "domain.equipFace.top" },       { id: "bottom", labelKey: "domain.equipFace.bottom" },
  { id: "left", labelKey: "domain.equipFace.left" },     { id: "right", labelKey: "domain.equipFace.right" },
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
export interface EquipmentTypeDef { id: string; labelKey: string; icon: string; }
export const EQUIPMENT_TYPES: EquipmentTypeDef[] = [
  { id: "switch",     labelKey: "domain.equipmentType.switch",     icon: `<rect x="2" y="6" width="20" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 10h7l-2-2m2 2-2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 14h-7l2-2m-2 2 2 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` },
  { id: "serveur",    labelKey: "domain.equipmentType.serveur",    icon: `<rect x="3" y="4" width="18" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="13" width="18" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="7.5" r="1.1" fill="currentColor"/><circle cx="7" cy="16.5" r="1.1" fill="currentColor"/>` },
  { id: "caisson",    labelKey: "domain.equipmentType.caisson",    icon: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>` },
  { id: "pc",         labelKey: "domain.equipmentType.pc",         icon: `<rect x="3" y="4" width="18" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 20h6M12 16v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` },
  { id: "imprimante", labelKey: "domain.equipmentType.imprimante", icon: `<path d="M7 9V4h10v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><rect x="3" y="9" width="18" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 14h10v6H7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="17.5" cy="12" r="0.9" fill="currentColor"/>` },
  { id: "ap",         labelKey: "domain.equipmentType.ap",         icon: `<path d="M5 11a10 10 0 0 1 14 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8 14a6 6 0 0 1 8 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="18" r="1.4" fill="currentColor"/>` },
  { id: "patch_panel",labelKey: "domain.equipmentType.patch_panel",icon: `<rect x="2" y="8" width="20" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="6" cy="12" r="1" fill="currentColor"/><circle cx="9.5" cy="12" r="1" fill="currentColor"/><circle cx="13" cy="12" r="1" fill="currentColor"/><circle cx="16.5" cy="12" r="1" fill="currentColor"/><circle cx="20" cy="12" r="1" fill="currentColor"/>` },
  { id: "pdu",        labelKey: "domain.equipmentType.pdu",        icon: `<rect x="8" y="2" width="8" height="20" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="6" r="1.1" fill="currentColor"/><circle cx="12" cy="10" r="1.1" fill="currentColor"/><circle cx="12" cy="14" r="1.1" fill="currentColor"/><circle cx="12" cy="18" r="1.1" fill="currentColor"/>` },
  { id: "tableau",    labelKey: "domain.equipmentType.tableau", icon: `<rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="6.5" y="6" width="3" height="5" rx="0.6" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="10.5" y="6" width="3" height="5" rx="0.6" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="14.5" y="6" width="3" height="5" rx="0.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 15h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M6 18h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>` },
  { id: "autre",      labelKey: "domain.equipmentType.autre",      icon: `<rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="12" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/><circle cx="16" cy="12" r="1.1" fill="currentColor"/>` },
];
export const EQUIPMENT_TYPE_DEFAULT = "switch";

/** Sources d'alimentation possibles d'un réseau Power. Libellés i18n (cf. domaine `domain`). */
export const POWER_SOURCES = [
  { id: "ups", labelKey: "domain.powerSource.ups" }, { id: "ups_gen", labelKey: "domain.powerSource.ups_gen" }, { id: "grid", labelKey: "domain.powerSource.grid" },
];

/** SENS de l'énergie d'un port power : source (fournit) | sink (consomme). Libellés i18n. */
export const PORT_DIRECTIONS = [
  { id: "source", labelKey: "domain.portDirection.source" }, { id: "sink", labelKey: "domain.portDirection.sink" },
];
/** PHASES d'un réseau triphasé (départ de tableau monophasé réparti sur 3 phases). */
export const POWER_PHASES = ["L1", "L2", "L3"];
/** Seuil de charge (fraction du calibre) au-delà duquel on alerte (règle de l'art : 80 % en continu). */
export const POWER_LOAD_WARN_FRACTION = 0.8;

/** Rôles de port (catégorie data | power). */
export interface PortRoleDef { id: string; labelKey: string; kind: "data" | "power"; }
export const PORT_ROLES: PortRoleDef[] = [
  { id: "mgmt",  labelKey: "domain.portRole.mgmt",  kind: "data" },
  { id: "data",  labelKey: "domain.portRole.data",  kind: "data" },
  { id: "power", labelKey: "domain.portRole.power", kind: "power" },
];

/* ---- profondeur d'équipement en mm (remplace l'enum legacy full/half/quarter) ---- */
/** Profondeurs STANDARDS proposées au formulaire (saisie libre possible au-delà). */
export const DEPTH_PRESETS_MM = [200, 300, 450, 600, 750, 900, 1000, 1200];
/** Profondeur par défaut d'un nouvel équipement en U (mm). */
export const EQUIP_DEPTH_DEFAULT_MM = 600;

/* ---- profondeurs de montage LEGACY (full/half/quarter) — plus jamais ÉCRITES par l'UI ;
       ne servent qu'au REPLI de lecture des vieux documents et à la MIGRATION → depth_mm
       (Store._migrateDepths / Depths.legacyToMm). ---- */
export const MOUNT_DEPTHS = [
  { id: "full", labelKey: "domain.mountDepth.full" },
  { id: "half", labelKey: "domain.mountDepth.half" },
  { id: "quarter", labelKey: "domain.mountDepth.quarter" },
];
/** Part de la profondeur de cage occupée par chaque enum legacy (`none` = pseudo-élément). */
export const DEPTH_FRAC: Record<string, number> = { full: 1, half: 0.5, quarter: 0.25, none: 0.06 };

/* ---- types de groupe ---- */
export interface GroupTypeDef { id: string; labelKey: string; hintKey: string; }
export const GROUP_TYPES: GroupTypeDef[] = [
  { id: "stack",   labelKey: "domain.groupType.stack",   hintKey: "domain.groupTypeHint.stack" },
  { id: "system",  labelKey: "domain.groupType.system",  hintKey: "domain.groupTypeHint.system" },
  { id: "general", labelKey: "domain.groupType.general", hintKey: "domain.groupTypeHint.general" },
];
export const GROUP_TYPE_DEFAULT = "general";

/* ---- statut de câble (cycle de vie ; slug stable, pas le libellé affiché) ---- */
export interface CableStatusDef { id: string; labelKey: string; cls: string; draft?: boolean; }
export const CABLE_STATUSES: CableStatusDef[] = [
  { id: "brouillon",   labelKey: "domain.cableStatus.brouillon",   cls: "status-brouillon", draft: true },
  { id: "planifie",    labelKey: "domain.cableStatus.planifie",    cls: "status-planifie" },
  { id: "cable",       labelKey: "domain.cableStatus.cable",       cls: "status-cable" },
  { id: "a-remplacer", labelKey: "domain.cableStatus.aRemplacer", cls: "status-a-remplacer" },
  { id: "casse",       labelKey: "domain.cableStatus.casse",       cls: "status-casse" },
];
export const CABLE_STATUS_DRAFT = "brouillon";          // imposé tant que l'assignation est incomplète
export const CABLE_STATUS_DEFAULT_NEW = "planifie";     // câble complet créé via le formulaire
export const CABLE_STATUS_DEFAULT_LEGACY = "cable";     // câble chargé sans statut = déjà câblé
export const CABLE_STATUS_BROKEN = "casse";
/** Rang de cycle de vie : brouillon < planifié < (câblé ≡ à remplacer). Sert à borner le statut. */
export const CABLE_STATUS_RANK: Record<string, number> = { brouillon: 0, planifie: 1, cable: 2, "a-remplacer": 2 };

/** Taille (mm) du connecteur PHYSIQUE par clé `connector`/`family` (rendu des ports en 3D). */
export const PORT_CONNECTOR_MM: Record<string, { w: number; h: number }> = {
  RJ45: { w: 13, h: 12 }, ETH: { w: 13, h: 12 },
  SFP: { w: 14, h: 9 }, "SFP+": { w: 14, h: 9 }, SFP28: { w: 14, h: 9 }, SFP56: { w: 14, h: 9 },
  QSFP: { w: 18, h: 9 }, "QSFP+": { w: 18, h: 9 }, QSFP28: { w: 18, h: 9 }, QSFP56: { w: 18, h: 9 },
  "QSFP-DD": { w: 18, h: 10 }, OSFP: { w: 19, h: 11 },
  SAS: { w: 17, h: 10 }, "SFF-8644": { w: 17, h: 10 }, FC: { w: 14, h: 9 },
  LC: { w: 12, h: 6 }, ST: { w: 9, h: 9 }, SC: { w: 13, h: 7 }, MPO: { w: 12, h: 6 },
  USB: { w: 12, h: 5 }, "USB-A": { w: 12, h: 5 }, "USB-B": { w: 12, h: 11 }, "USB-C": { w: 9, h: 3 },
  DB9: { w: 17, h: 9 }, HDMI: { w: 15, h: 6 }, DP: { w: 16, h: 6 }, VGA: { w: 17, h: 9 },
  C13: { w: 14, h: 10 }, C14: { w: 14, h: 10 }, C19: { w: 17, h: 12 }, C20: { w: 17, h: 12 },
  "CEE7/3": { w: 16, h: 16 }, "CEE7/4": { w: 16, h: 16 }, "CEE-16A": { w: 20, h: 20 }, "CEE-32A": { w: 24, h: 24 },
  BS1363: { w: 18, h: 14 }, "NEMA5-15": { w: 15, h: 10 },
};
export const PORT_CONNECTOR_DEFAULT = PORT_CONNECTOR_MM.RJ45;

/** Types de waypoint (passage interne salle · exit · OOB hors salles). */
// Types de waypoint. Le pin « hors salle » (ex-OOB) est désormais un PIN dont le placement est au niveau ÉTAGE
// (cf. Waypoint.isFloorLevel) — plus un type à part.
export const WAYPOINT_TYPES = [
  { id: "datacenter", labelKey: "domain.waypointType.datacenter" },
  { id: "exit",       labelKey: "domain.waypointType.exit" },
];

/* ---- INVENTAIRE DE SPARES (pièces de rechange, hors graphe réseau) ---- */
export interface SpareTypeDef { id: string; labelKey: string; icon: string; }
export const SPARE_TYPES: SpareTypeDef[] = [
  // icon = INNER markup SVG (enveloppé par SpareTypes.svg), même convention qu'EquipmentTypes.
  { id: "hdd",         labelKey: "domain.spareType.hdd", icon: `<rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="12" r="0.7" fill="currentColor"/>` },
  { id: "ssd",         labelKey: "domain.spareType.ssd",              icon: `<rect x="3" y="6" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 10h6M7 13.5h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` },
  { id: "transceiver", labelKey: "domain.spareType.transceiver",      icon: `<rect x="2" y="9" width="13" height="6" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15 10.5h4l3 1.5-3 1.5h-4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>` },
  { id: "other",       labelKey: "domain.spareType.other",            icon: `<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>` },
];
export const SPARE_TYPE_DEFAULT = "other";
/** Types « disque » partageant le même groupe de champs (capacité/interface/format ; RPM = HDD seul). */
export const SPARE_DISK_TYPES = ["hdd", "ssd"];

export interface SpareStatusDef { id: string; labelKey: string; }
export const SPARE_STATUSES: SpareStatusDef[] = [
  { id: "available",      labelKey: "domain.spareStatus.available" },
  { id: "assigned",       labelKey: "domain.spareStatus.assigned" },
  { id: "decommissioned", labelKey: "domain.spareStatus.decommissioned" },
];
export const SPARE_STATUS_DEFAULT = "available";

// listes d'options (datalists / sélecteurs) des champs spécifiques par type
export const SPARE_CAP_UNITS = ["GB", "TB"];
export const SPARE_HDD_INTERFACES = ["SATA", "SAS", "NVMe", "SCSI", "IDE/PATA", "FC"];
export const SPARE_HDD_FORMATS = ['3.5"', '2.5"', "M.2", "U.2", "mSATA"];
export const SPARE_HDD_RPM = [5400, 7200, 10000, 15000];
export const SPARE_TX_FORMS = ["SFP", "SFP+", "SFP28", "QSFP", "QSFP+", "QSFP28", "QSFP-DD", "XFP", "GBIC", "CFP"];
export const SPARE_TX_SPEEDS = ["1G", "10G", "25G", "40G", "100G", "200G", "400G"];
export const SPARE_TX_MEDIA = ["LC (fibre)", "RJ45 (cuivre)", "DAC", "AOC", "MPO/MTP", "SC"];

/* ---- pseudo-équipements montables en rack (icône SVG viewBox 24, currentColor) ---- */
export interface RackItemKindDef { id: string; labelKey: string; icon: string; }
/* ---- tray (étagère de baie — pseudo-équipement rackItems, kind "tray") ---- */
export interface TrayTypeDef { id: string; labelKey: string; }
export const TRAY_TYPES: TrayTypeDef[] = [
  { id: "dual", labelKey: "domain.trayType.dual" },
  { id: "cantilever", labelKey: "domain.trayType.cantilever" },
];
export const TRAY_DEPTH_DEFAULT_MM = 450;   // longueur de plateau par défaut d'une étagère en porte-à-faux (mm)
export const TRAY_SHEET_RESERVE_MM = 5;     // réserve de hauteur INUTILISABLE au ras du plateau (tôle + renforts transversaux du tray)
export const TRAY_GUSSET_CLEARANCE_MM = 4;  // garde LATÉRALE (mm) de chaque côté réservée aux renforts (porte-à-faux) : les équipements posés n'y empiètent pas

export const RACK_ITEM_KINDS: RackItemKindDef[] = [
  { id: "blank",     labelKey: "domain.rackItemKind.blank", icon: `<rect x="2" y="8" width="20" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="5.5" cy="12" r="1.1" fill="currentColor"/><circle cx="18.5" cy="12" r="1.1" fill="currentColor"/><path d="M9 12h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` },
  { id: "tray",      labelKey: "domain.rackItemKind.tray",           icon: `<path d="M5 10h14v2l-1.5 4h-11L5 12z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M3 10h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` },
  { id: "keepblank", labelKey: "domain.rackItemKind.keepblank",      icon: `<rect x="2" y="8" width="20" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 2.5"/><path d="M8 15l8-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>` },
];
