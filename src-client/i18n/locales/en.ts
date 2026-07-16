/* ============================================================================
   Catalogue de traduction — ANGLAIS.
   ----------------------------------------------------------------------------
   Calque EXACT de `fr.ts` (mêmes clés, même structure). Le français reste la
   source de vérité : ne JAMAIS ajouter ici une clé absente de `fr.ts`. Le test
   `Tests/modules/test-i18n.js` échoue au moindre écart (clé manquante d'un côté
   ou de l'autre, valeur vide, feuille non-chaîne).

   « Netmap » reste « Netmap » (nom de fonctionnalité, cf. fr.ts). Les termes du
   domaine gardés tels quels : IPAM, DHCP, VLAN, Proxmox, QEMU, LXC, PKI,
   X.509/SSH, IndexedDB, IPv4 CIDR, U (unités de baie). */
export const en = {
  tabs: {
    equipements: {
      label: "Equipment",
      subtitle: "Switches, servers, enclosures, modems… with their ports, roles and aggregates.",
    },
    vms: {
      label: "VMs",
      title: "Virtual machines (VMs)",
      subtitle: "QEMU VMs and LXC containers fed by synchronisation with a management cluster (Proxmox). Source fields are read-only; local enrichments are made from the record.",
    },
    clusters: {
      label: "Clusters",
      subtitle: "Per-provider status of the synchronised clusters (nodes, metrics, quorum) and of synchronisation.",
    },
    racks: {
      label: "Racks",
      subtitle: "Racks: location, size (U), depth, faces, doors and covers. Use « ▦ Contents » to mount equipment into the U slots.",
    },
    cables: {
      label: "Cables",
      subtitle: "A named link between two ports — type compatible with the ports, network optional.",
    },
    ipam: {
      label: "IPAM",
      title: "IPAM — IP networks",
      subtitle: "Registry of static IP allocations. Declare subnets (IPv4 CIDR), then assign addresses to them and reserve DHCP ranges.",
    },
    graph: {
      label: "Netmap",
      subtitle: "View filtered by equipment, networks and/or port types. Zoom, recenter, highlight.",
    },
    datacenter: {
      label: "Datacenters",
      subtitle: "Physical layout of rooms: racks in 3D. Drag = move · Shift/right-click = orbit · wheel = zoom.",
    },
    groupes: {
      label: "Groups",
      subtitle: "Logical groupings of equipment: label + colour + description.",
    },
    spares: {
      label: "Spares",
      subtitle: "Inventory of spare parts (HDD · SSD · transceiver · other): per-unit tracking, status, assignment.",
    },
    faceimages: {
      label: "Faceplate images",
      subtitle: "Library of faceplate images (JPEG/PNG/WebP) shared by reference. Stored outside the document (IndexedDB).",
    },
    reseaux: {
      label: "Networks",
      subtitle: "Logical networks (VLAN…) or power circuits: label, colour, type.",
    },
    faisceaux: {
      label: "Trunks",
      title: "Bundles / trunks",
      subtitle: "MULTI-FIBRE cables between 2 patch panels, created ahead of time. The patch PORTS draw from the fibres; the trunk route carries its 2D/3D path.",
    },
    porttypes: {
      label: "Port types",
      title: "Port / link types",
      subtitle: "STANDARDISED catalogue (read-only). The « family » links compatible ports and cables; the « connector » is the physical shape.",
    },
    cabletypes: {
      label: "Cable types",
      subtitle: "STANDARDISED catalogue (read-only). Attached to a port « family ».",
    },
    ipaddresses: {
      label: "IP addresses",
      title: "Static IP addresses",
      subtitle: "One row = one assigned IP. Linked to a network, optionally to a piece of equipment. Uniqueness guaranteed.",
    },
    salles: {
      label: "Rooms",
      title: "Rooms (datacenters)",
      subtitle: "Floor grid of a room: dimensions + mesh. Place racks on it (Racks tab → Room field) to see them in 3D.",
    },
    sites: {
      label: "Sites",
      title: "Sites / buildings",
      subtitle: "Name + address. Deleting decommissions the site (rooms & floors deleted, racks → unplaced, logical links preserved).",
    },
    etages: {
      label: "Floors",
      title: "Floor plans",
      subtitle: "Dimensions, mesh and anchoring of a floor (building + level). « + Floor »: choose the building and the level.",
    },
    dhcpranges: {
      label: "DHCP ranges",
      title: "Reserved DHCP ranges",
      subtitle: "Ranges (start → end) assigned to a DHCP server. No overlap with another range or with a static IP of the network.",
    },
    contacts: {
      label: "Contacts",
      title: "Contacts (notifications)",
      subtitle: "Address book of notification recipients (email / sms). Name required; e-mail and phone optional (softly validated). Referenced by notify routing (soft reference contact_id, outside the document).",
    },
    notifications: {
      label: "Notifications",
      subtitle: "Administration of the notification service: delivery channels, subscriptions per event type, reminder intervals, active alerts, history and delivery tests.",
    },
    certificats: {
      label: "Certificates",
      subtitle: "Internal (zero-knowledge) PKI: master key, authorities and X.509/SSH certificates, issuance, exports, revocation. Cryptography happens in the browser — the server never sees the master key.",
    },
    parametres: {
      label: "Settings",
    },
  },
} as const;
