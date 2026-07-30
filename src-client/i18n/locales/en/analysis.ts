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
  route: {
    floorPinInRoom: "“{{name}}” (floor pin) cannot sit inside a room — leave through an exit first",
    unplaced: "“{{name}}” is not placed in a room",
    roomWpInTransit: "“{{name}}” (room waypoint) in the middle of an out-of-room leg",
    roomWpOnFloor: "“{{name}}” (room waypoint) while the route is on a floor",
    wrongRoom: "“{{name}}” is in a different room than the current segment",
    exitWrongRoom: "exit “{{name}}”: the way out must be an exit of the current room",
    exitReentry: "exit “{{name}}”: re-entering the room just left — pair it with an exit of ANOTHER room",
    exitUnpaired: "unpaired exit — add another room's exit, or a floor pin, to close the leg",
    portARoom: "port A is not in the room where the route starts",
    portAFloor: "port A is not on the floor where the route starts",
    portBRoom: "port B is not in the room where the route ends",
    portBFloor: "port B is not on the floor where the route ends",
    portsSplitRooms: "ports in two different rooms — the route must leave through an exit of each room",
    portsSplitPlaces: "ports in two different places — the route must leave through an exit",
    endpointsSplitRooms: "bundle endpoints in two different rooms — the route must leave through an exit of each room",
    endpointsSplitPlaces: "bundle endpoints in two different places — the route must leave through an exit",
    endpointRouteMismatch: "the route links “{{start}}” to “{{end}}”, but the bundle endpoints are in “{{a}}” and “{{b}}”",
    endpointRouteMismatchOne: "the route links “{{start}}” to “{{end}}”, but the bundle's placed endpoint is in “{{name}}”",
    blockedManyRooms: "cabled to several rooms at once ({{names}}) — re-route or detach a cable",
    blockedManyPlaces: "cabled to several places at once ({{names}}) — re-route or detach a cable",
    blockedOne: "cabled to “{{name}}” — re-route the cable (exits) or detach it",
    blockedRackEquip: "“{{name}}”: {{why}}",
    equipFallback: "(equipment)",
  },
  power: {
    psuUncabled: "{{n}} uncabled power feed(s) — reduced redundancy.",
    noSource: "No valid power feed (cabled to a source) — equipment not powered.",
    spof: "Non-redundant power feeds — same origin source (single point of failure).",
    originUnknown: "Power feed origin undeterminable (direction or upstream board not set) — redundancy not verifiable.",
    psuUndersized: "Power feed “{{name}}” ({{amps}} A) insufficient for the max load alone ({{req}} A required).",
    poeOverBudget: "POE over-budget: the PD load ({{load}} W) exceeds the {{budget}} W total budget.",
    poePortOver: "Port “{{port}}”: the connected PD draws {{load}} W, beyond the port budget ({{budget}} W).",
    poePdUnfed: "PoE port “{{port}}” not powered (no active PSE injector cabled).",
    pduOverCapacity: "Equipment capacity exceeded: {{load}} A downstream for {{cap}} A declared.",
    networkOverAmp: "Network “{{name}}”: {{load}} A drawn for a {{cap}} A capacity.",
  },
} as const;
