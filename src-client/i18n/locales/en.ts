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
    interventions: {
      label: "Interventions",
      subtitle: "Incidents and planned interventions, linked to equipment, VMs and spare parts: lifecycle, priority, maintenance window, Jira reference.",
    },
    certificats: {
      label: "Certificates",
      subtitle: "Internal (zero-knowledge) PKI: master key, authorities and X.509/SSH certificates, issuance, exports, revocation. Cryptography happens in the browser — the server never sees the master key.",
    },
    parametres: {
      label: "Settings",
    },
  },
  interventions: {
    kind: {
      incident: "Incident",
      intervention: "Intervention",
    },
    status: {
      declared: "Declared",
      planned: "Planned",
      in_progress: "In progress",
      closed: "Closed",
      cancelled: "Cancelled",
    },
    priority: {
      low: "Low",
      normal: "Normal",
      high: "High",
      critical: "Critical",
    },
    target: {
      equipment: "Equipment",
      vm: "VM",
      spare: "Spare part",
      unknown: "(not found)",
      fallback: {
        equipment: "(equipment)",
        vm: "(VM)",
        spare: "(spare)",
      },
    },
    fiche: {
      section: "Interventions",
      declare: "Declare an intervention",
      openCount: "{{n}} open",
      none: "None open",
    },
    col: {
      title: "Title",
      type: "Type",
      priority: "Priority",
      status: "Status",
      window: "Planned window",
      links: "Links",
      jira: "Jira",
      createdBy: "Created by",
      actions: "Actions",
    },
    filter: {
      label: "Filter",
      type: "Type",
      status: "Status",
      priority: "Priority",
      reset: "Reset filters",
    },
    search: {
      placeholder: "Search (title, description, Jira ref)…",
    },
    action: {
      addIncident: "+ Incident",
      addIntervention: "+ Intervention",
      refresh: "Refresh",
    },
    rowAction: {
      details: "Details",
      edit: "Edit",
      start: "Start",
      close: "Close",
      delete: "Delete",
    },
    detail: {
      title: "Intervention details",
      noDescription: "No description.",
      updatedBy: "Updated by",
    },
    modal: {
      createIncidentTitle: "New incident",
      createInterventionTitle: "New intervention",
      editTitle: "Edit",
      kind: "Kind",
      title: "Title",
      titlePlaceholder: "e.g. Core switch replacement",
      description: "Description",
      descriptionHint: "Markdown accepted (rendered in the detail view). Describe the context, action plan and impact.",
      priority: "Priority",
      status: "Status",
      plannedStart: "Planned start",
      plannedHint: "Optional maintenance window (local time). The end requires a start and must be later than it.",
      plannedEnd: "Planned end",
      jiraRef: "Jira reference",
      jiraRefPlaceholder: "e.g. INFRA-123 or a URL",
      jiraHint: "A ticket key or URL. Reference only — no call is made to Jira.",
      links: "Linked objects",
      linksHint: "Equipment, VMs or spares involved. A deleted target stays as “not found” (the link is kept).",
      linksSearchPlaceholder: "Search for equipment, a VM or a spare…",
      linksEmpty: "No linked object.",
      linksRemove: "Remove",
    },
    confirm: {
      deleteTitle: "Delete this intervention?",
      deleteMessage: "Delete “{{title}}”? Its links will be removed. This action is permanent.",
      deleteConfirm: "Delete",
    },
    toast: {
      created: "Intervention created",
      updated: "Intervention updated",
      deleted: "Intervention deleted",
      started: "Intervention started",
      closed: "Intervention closed",
      linkExists: "This object is already linked.",
    },
    error: {
      titleRequired: "Title is required.",
    },
    pager: {
      count: "{{n}} item(s)",
      page: "page {{page}}/{{pages}}",
      perPage: "{{n}}/page",
    },
    msg: {
      loadError: "Unable to load",
      empty: "No interventions. Create one with “+ Incident” or “+ Intervention”, or adjust the filters.",
      needsApiTitle: "Interventions — API mode required",
      needsApi: "Incident and intervention tracking is provided by the server. It is only available in API mode. Switch the data source to “API” in Settings to use it.",
      noDocTitle: "Interventions — no document open",
      noDoc: "Interventions are specific to EACH document. Open or create a document to manage them.",
      disabledTitle: "Interventions service unavailable",
      disabled: "The interventions module is disabled on the server (interventions.db unreadable). Check the server logs.",
    },
  },
} as const;
