/* ============================================================================
   Domaine `domain` — FRANÇAIS. LIBELLÉS des TABLES MÉTIER (domain/constants.ts,
   registries/*). Ces tables sont des constantes de niveau module évaluées AVANT
   `I18n.init()` : elles ne stockent QUE des CLÉS i18n (`labelKey`/`hintKey`) — le
   texte traduit vit ICI et n'est résolu qu'au POINT DE RENDU (`I18n.t(labelKey)`
   dans les registres `EquipmentTypes.label`, `SpareStatuses.label`, …).
   Agrégé par `../fr.ts`. Voir docs/i18n.md. */
export const domain = {
  rackSide: {
    single: "Simple face",
    dual: "Double face",
  },
  rackFace: {
    front: "Avant",
    rear: "Arrière",
  },
  equipFace: {
    front: "Avant",
    rear: "Arrière",
    top: "Dessus",
    bottom: "Dessous",
    left: "Gauche",
    right: "Droite",
  },
  equipmentType: {
    switch: "Switch",
    server: "Serveur",
    enclosure: "Caisson",
    pc: "PC",
    printer: "Imprimante",
    ap: "AP",
    camera: "Caméra IP",
    patch_panel: "Patch panel",
    pdu: "PDU",
    switchboard: "Tableau électrique",
    ups: "Onduleur (UPS)",
    other: "Autre",
  },
  powerSource: {
    ups: "Sous UPS",
    ups_gen: "UPS + Générateur",
    grid: "Réseau (Grid only)",
  },
  portDirection: {
    source: "Source (fournit)",
    sink: "Sink (consomme)",
  },
  portRole: {
    mgmt: "Mgmt",
    data: "Data",
    power: "Power",
  },
  mountDepth: {
    full: "Full-depth",
    half: "Half-depth",
    quarter: "Quarter-depth",
    none: "No-depth",
  },
  groupType: {
    stack: "Stack",
    system: "System",
    general: "General",
  },
  groupTypeHint: {
    stack: "Grouper les switchs d'un même stack",
    system: "Grouper les éléments d'un même système (ex. un SAN)",
    general: "Regroupement générique",
  },
  cableStatus: {
    brouillon: "Brouillon",
    planifie: "Planifié",
    cable: "Câblé",
    aRemplacer: "À remplacer",
    casse: "Cassé",
  },
  waypointType: {
    datacenter: "Passage interne à la salle (pin / chemin)",
    exit: "Exit — sortie / entrée de salle",
  },
  spareType: {
    hdd: "HDD (disque dur)",
    ssd: "SSD",
    transceiver: "Transceiver",
    other: "Autre",
  },
  spareStatus: {
    available: "Disponible",
    assigned: "Attribué",
    decommissioned: "Décommissionné",
  },
  trayType: {
    dual: "Posée avant + arrière (pleine cage)",
    cantilever: "Porte-à-faux (renforts triangulaires)",
  },
  rackItemKind: {
    blank: "Blanking Plate",
    tray: "Tray",
    keepblank: "KeepBlank",
  },
  placementLock: {
    blockedHint: "Positionnement verrouillé — déverrouillez d'abord (ou passez par le formulaire).",
    lock: "Verrouiller le positionnement",
    unlock: "Déverrouiller le positionnement",
  },
  doorWall: {
    top: "avant",
    bottom: "arrière",
    left: "gauche",
    right: "droit",
  },
} as const;
