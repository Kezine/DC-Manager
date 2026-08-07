/* ============================================================================
   Domaine `search` — FRANÇAIS. RECHERCHE GLOBALE (modale dédiée, Ctrl+K /
   déclencheur topbar) : déclencheur, champ, portées, familles, accueil
   (récents + préfixes), états vide/aucun, pied de raccourcis.
   Vues : `views/GlobalSearchPalette.ts` (+ corpus `GlobalSearchSources`).
   Agrégé par `../fr.ts`. Voir docs/i18n.md.

   ⚠ `family.*` est indexé par NOM DE COLLECTION et `scope.*` par ID DE PORTÉE
   (la modale fait `I18n.t("search.family." + kind)` / `…scope.` + id) : toute
   famille ou portée ajoutée au corpus doit avoir sa clé ICI ET dans
   `en/search.ts` — le test de complétude fr ⇄ en ne voit que la parité entre
   catalogues ; c'est le test du corpus qui couvre l'oubli SIMULTANÉ. */
export const search = {
  title: "Recherche globale",
  placeholder: "Équipement, baie, câble, adresse IP, n° de série…",

  scope: {
    all: "Tout",
    equip: "Équipements",
    places: "Baies & salles",
    cables: "Câbles",
    network: "Réseau & IP",
    vms: "VMs",
    wifi: "Wifi",
    issues: "Tickets",
    inventory: "Inventaire",
    certs: "Certificats",
    interventions: "Interventions",
    actions: "Actions",
  },

  family: {
    equipments: "Équipements",
    subEquipments: "Sous-équipements",
    racks: "Baies",
    datacenters: "Salles",
    sites: "Sites",
    floors: "Étages",
    cables: "Câbles",
    cableBundles: "Faisceaux",
    networks: "Réseaux",
    ipNetworks: "Réseaux IP",
    ipAddresses: "Adresses IP",
    dhcpRanges: "Plages DHCP",
    vms: "VMs",
    wifiClients: "Clients wifi",
    issues: "Tickets",
    spares: "Spares",
    groups: "Groupes",
    contacts: "Contacts",
    cableTypes: "Types de câble",
    portTypes: "Types de port",
  },

  action: {
    newEquipment: "Ajouter un équipement",
    newEquipmentSub: "Ouvre le formulaire de création",
    newRack: "Ajouter une baie",
    newRackSub: "Ouvre le formulaire de création",
    newCable: "Ajouter un câble",
    newCableSub: "Ouvre le formulaire de création",
    gotoDatacenter: "Vue Datacenter",
    gotoDatacenterSub: "Plans de salle et 3D",
    toggleTheme: "Basculer le thème",
    toggleThemeSub: "Sombre ⇄ clair",
    exportJson: "Exporter le document en JSON",
    exportJsonSub: "Téléchargement autonome",
  },

  recents: "Consultés récemment",
  welcome: "Cherchez par nom, IP, numéro de série, position U ou identifiant de câble. Restreignez la portée avec un préfixe :",
  emptyTitle: "Aucun résultat pour « {{query}} »",
  emptyText: "Vérifiez l'orthographe, élargissez la portée à « Tout », ou cherchez par identifiant (baie, IP, n° de série).",

  countOne: "{{n}} résultat",
  countMany: "{{n}} résultats",
  countNone: "0 résultat",

  kbd: {
    esc: "Échap",
    navigate: "naviguer",
    open: "ouvrir",
    nextScope: "portée suivante",
  },

  sub: {
    strands: "brins",
  },
} as const;
