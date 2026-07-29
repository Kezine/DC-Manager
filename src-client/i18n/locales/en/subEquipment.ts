/* ============================================================================
   Domain `subEquipment` — ENGLISH. Mirrors `../fr/subEquipment.ts` key for key
   (completeness is checked by `Tests/modules/test-i18n.js`).

   ⚠ Same intent as the French catalogue: never say "location" or "position" —
   a sub-equipment has none. `slot` is a free-text LANDMARK, and `natureHint`
   spells out why the sheet has no place and no ports, so it does not read as an
   incomplete record. */
export const subEquipment = {
  fallback: "(sub-equipment)",
  notFound: "Sub-equipment not found",
  detailTitle: "Sub-equipment details",
  titleNew: "New sub-equipment",
  titleEdit: "Edit sub-equipment",
  created: "Sub-equipment created",
  updated: "Sub-equipment updated",

  master: "Parent equipment",
  masterMissing: "Parent equipment not found",
  masterFixed: "Sub-equipment of “{{name}}” — it only exists through it.",
  openMaster: "Open the parent equipment sheet",

  slot: "Landmark",
  slotPlaceholder: "Shelf A / bay 3…",
  slotHint: "Free text, to find your way inside the parent. This is not a position: a sub-equipment is neither placed nor drawn.",
  hardware: "Hardware",
  namePlaceholder: "LTO-8 drive #2…",
  nameHint: "The name carries the meaning: there is no “type” field.",
  brandPlaceholder: "Quantum, IBM…",
  modelPlaceholder: "Vendor part number…",
  serialPlaceholder: "Serial number…",
  natureHint: "A sub-equipment has no location, no dimensions and no ports of its own: its physical existence is that of its parent equipment.",

  section: "Sub-equipments ({{count}})",
  sectionEmpty: "No sub-equipment.",
  add: "+ Sub-equipment",
} as const;
