/* ============================================================================
   Domaine `domain` — ANGLAIS. Calque EXACT de `../fr/domain.ts`. Agrégé par
   `../en.ts`. Termes techniques conservés (Switch, PDU, AP, SSD, HDD, Stack…). */
export const domain = {
  rackSide: {
    single: "Single face",
    dual: "Dual face",
  },
  rackFace: {
    front: "Front",
    rear: "Rear",
  },
  equipFace: {
    front: "Front",
    rear: "Rear",
    top: "Top",
    bottom: "Bottom",
    left: "Left",
    right: "Right",
  },
  equipmentType: {
    switch: "Switch",
    server: "Server",
    enclosure: "Enclosure",
    pc: "PC",
    printer: "Printer",
    ap: "AP",
    camera: "IP camera",
    patch_panel: "Patch panel",
    pdu: "PDU",
    switchboard: "Switchboard",
    ups: "UPS",
    other: "Other",
  },
  powerSource: {
    ups: "On UPS",
    ups_gen: "UPS + Generator",
    grid: "Grid (grid only)",
  },
  portDirection: {
    source: "Source (supplies)",
    sink: "Sink (consumes)",
  },
  portRole: {
    mgmt: "Mgmt",
    data: "Data",
    power: "Power",
    poe: "POE",
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
    stack: "Group the switches of a single stack",
    system: "Group the elements of a single system (e.g. a SAN)",
    general: "Generic grouping",
  },
  cableStatus: {
    brouillon: "Draft",
    planifie: "Planned",
    cable: "Cabled",
    aRemplacer: "To replace",
    casse: "Broken",
  },
  waypointType: {
    datacenter: "Internal room passage (pin / path)",
    exit: "Exit — room exit / entry",
  },
  spareType: {
    hdd: "HDD (hard drive)",
    ssd: "SSD",
    transceiver: "Transceiver",
    other: "Other",
  },
  // Issue state CATEGORY — CLOSED enumeration (`ISSUE_STATUS_CATEGORIES`), the ONLY translatable part
  // of the state. ⚠ The tracker's own `status` label is displayed AS IS and NEVER translated (D3:
  // workflows are configurable per project). Resolved at render time by `core/IssueStatus.categoryLabel`.
  // The first three entries are LOCKED by test against the shared search catalogue
  // `SEARCH_CATALOGS.issueStatusCategory`.
  issueStatusCategory: {
    todo: "Open",
    in_progress: "In progress",
    done: "Closed",
    unknown: "Unknown",
  },
  spareStatus: {
    available: "Available",
    assigned: "Assigned",
    decommissioned: "Decommissioned",
  },
  trayType: {
    dual: "Front + rear mounted (full cage)",
    cantilever: "Cantilever (triangular braces)",
  },
  rackItemKind: {
    blank: "Blanking Plate",
    tray: "Tray",
    keepblank: "KeepBlank",
  },
  placementLock: {
    blockedHint: "Positioning locked — unlock it first (or use the form).",
    lock: "Lock positioning",
    unlock: "Unlock positioning",
  },
  doorWall: {
    top: "front",
    bottom: "rear",
    left: "left",
    right: "right",
  },
} as const;
