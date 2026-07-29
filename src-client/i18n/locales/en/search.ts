/* ============================================================================
   Domain `search` — ENGLISH. Mirrors `../fr/search.ts` key for key
   (completeness checked by `Tests/modules/test-i18n.js`).

   ⚠ `family.*` is keyed by COLLECTION NAME (the palette does
   `I18n.t("search.family." + kind)`) — every family added to the corpus needs
   its key here AND in `fr/search.ts`. */
export const search = {
  title: "Global search",
  placeholder: "Name, serial number, IP address, description…",
  hint: "At least 2 characters — clicking opens the detail sheet. To LOCATE an object in 2D/3D, the Datacenter view keeps its own search.",
  truncated: "+ {{n}} more — refine the search",
  family: {
    equipments: "Equipment",
    subEquipments: "Sub-equip.",
    racks: "Rack",
    datacenters: "Room",
    sites: "Site",
    floors: "Floor",
    cables: "Cable",
    cableBundles: "Trunk",
    networks: "Network",
    ipNetworks: "IP network",
    ipAddresses: "IP address",
    dhcpRanges: "DHCP range",
    vms: "VM",
    spares: "Spare",
    groups: "Group",
    contacts: "Contact",
    cableTypes: "Cable type",
    portTypes: "Port type",
  },
} as const;
