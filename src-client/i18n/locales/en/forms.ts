/* ============================================================================
   Domaine `forms` — ANGLAIS. Calque EXACT de `../fr/forms.ts`. Agrégé par
   `../en.ts`. Termes techniques conservés (breakout, trunk, lane, U, QSFP…). */
export const forms = {
  faceRatio: {
    frontEars: "Faceplate {{u}}U · with ears",
    frontNoEars: "Faceplate {{u}}U · without ears",
    rear: "Faceplate {{u}}U · rear",
  },
  breakout: {
    needPortTypes: "Create port types first (QSFP+ and SFP+).",
    lanes: "Number of lanes: <b>×{{n}}</b>  ({{trunk}} ÷ {{lane}} = {{n}} — standard breakout).",
    nonStandard: "Non-standard combination: {{trunk}} ÷ {{lane}} = {{ratio}}. A valid breakout requires trunk rate = N × lane rate with N ∈ {{spans}}.",
    laneOpt: "×{{n}} lanes",
    lanesField: "Number of lanes",
    lanesManualHint: "Rate not set on these types → manual choice among the standard breakouts.",
    title: "New breakout",
    create: "Create",
    namePlaceholder: "e.g. QSFP1",
    nameField: "Trunk name",
    nameHint: "The lanes will be named « name/1 », « name/2 », …",
    trunkField: "Trunk type (physical connector)",
    trunkHint: "E.g. 400G QSFP-DD — the trunk does not carry a cable itself.",
    laneField: "Lane type",
    laneHint: "Identical for ALL lanes — each carries a 1:1 cable.",
    errName: "Give the trunk a name.",
    errTrunk: "Choose the trunk type.",
    errLane: "Choose the lane type.",
    errCombo: "Non-standard trunk/lane combination: adjust the types (trunk rate = N × lane rate, N ∈ {{spans}}).",
  },
  cap: {
    kept_one: "{{count}} cell kept: a pin is placed on it.",
    kept_other: "{{count}} cells kept: a pin is placed on them.",
    clearAll: "Clear all",
    clearAllTitle: "Remove all holes from this cap (cells bearing a pin are kept)",
  },
  image: {
    badFormat: "Unsupported format (PNG / JPEG / WebP).",
  },
  side: {
    left: "L",
    right: "R",
    bay: "bay",
    marginLeft: "left margin",
    marginRight: "right margin",
    here: "here",
    tooWide: "The equipment (width {{w}} mm) exceeds the column width ({{col}} mm).",
  },
  rack: {
    rearSuffix: " (back)",
    remove: "Remove",
    mount: "Mount an item here",
  },
  ph: {
    equipment: "(equipment)",
  },
} as const;
