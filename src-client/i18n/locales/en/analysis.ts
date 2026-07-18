/* ============================================================================
   Domain `analysis` — ENGLISH. Calque EXACT de `../fr/analysis.ts` (mêmes clés).
   Messages d'analyse du store rendus à l'écran (toasts, bilans, descriptions).
   Agrégé par `../en.ts`. Voir docs/i18n.md. */
export const analysis = {
  cable: {
    typeMissing: "Missing cable type",
    portTypeMissing: "A port has no defined type",
    incompatible: "Incompatible: cable “{{family}}” vs ports “{{pf}}” / “{{pt}}”",
    breakReason: "After moving equipment “{{equip}}”, the link to “{{remote}}” on port “{{port}}” is no longer valid.",
  },
  power: {
    psuUncabled: "{{n}} uncabled power feed(s) — reduced redundancy.",
    noSource: "No valid power feed (cabled to a source) — equipment not powered.",
    spof: "Non-redundant power feeds — same origin source (single point of failure).",
    originUnknown: "Power feed origin undeterminable (direction or upstream board not set) — redundancy not verifiable.",
    psuUndersized: "Power feed “{{name}}” ({{amps}} A) insufficient for the max load alone ({{req}} A required).",
  },
} as const;
