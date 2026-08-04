/* ============================================================================
   Domain `search` — ENGLISH. Mirrors `../fr/search.ts` key for key
   (completeness checked by `Tests/modules/test-i18n.js`).

   ⚠ `family.*` is keyed by COLLECTION NAME and `scope.*` by SCOPE ID —
   every family/scope added to the corpus needs its key here AND in
   `fr/search.ts`. */
export const search = {
  title: "Global search",
  placeholder: "Equipment, rack, cable, IP address, serial number…",

  scope: {
    all: "All",
    equip: "Equipment",
    places: "Racks & rooms",
    cables: "Cables",
    network: "Network & IP",
    vms: "VMs",
    wifi: "Wi-Fi",
    inventory: "Inventory",
    certs: "Certificates",
    interventions: "Interventions",
    actions: "Actions",
  },

  family: {
    equipments: "Equipment",
    subEquipments: "Sub-equipments",
    racks: "Racks",
    datacenters: "Rooms",
    sites: "Sites",
    floors: "Floors",
    cables: "Cables",
    cableBundles: "Trunks",
    networks: "Networks",
    ipNetworks: "IP networks",
    ipAddresses: "IP addresses",
    dhcpRanges: "DHCP ranges",
    vms: "VMs",
    wifiClients: "Wi-Fi clients",
    spares: "Spares",
    groups: "Groups",
    contacts: "Contacts",
    cableTypes: "Cable types",
    portTypes: "Port types",
  },

  action: {
    newEquipment: "Add an equipment",
    newEquipmentSub: "Opens the creation form",
    newRack: "Add a rack",
    newRackSub: "Opens the creation form",
    newCable: "Add a cable",
    newCableSub: "Opens the creation form",
    gotoDatacenter: "Datacenter view",
    gotoDatacenterSub: "Room plans and 3D",
    toggleTheme: "Toggle theme",
    toggleThemeSub: "Dark ⇄ light",
    exportJson: "Export document as JSON",
    exportJsonSub: "Standalone download",
  },

  recents: "Recently viewed",
  welcome: "Search by name, IP, serial number, U position or cable identifier. Narrow the scope with a prefix:",
  emptyTitle: "No result for “{{query}}”",
  emptyText: "Check the spelling, widen the scope to “All”, or search by identifier (rack, IP, serial number).",

  countOne: "{{n}} result",
  countMany: "{{n}} results",
  countNone: "0 results",

  kbd: {
    esc: "Esc",
    navigate: "navigate",
    open: "open",
    nextScope: "next scope",
  },

  sub: {
    strands: "strands",
  },
} as const;
