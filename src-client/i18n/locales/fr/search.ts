/* ============================================================================
   Domaine `search` — FRANÇAIS. RECHERCHE GLOBALE (palette Ctrl+K / loupe
   topbar) : titre de la modale, champ, familles, troncature annoncée.
   Vues : `views/GlobalSearchPalette.ts` (+ corpus `GlobalSearchSources`).
   Agrégé par `../fr.ts`. Voir docs/i18n.md.

   ⚠ `family.*` est indexé par NOM DE COLLECTION (la palette fait
   `I18n.t("search.family." + kind)`) : toute famille ajoutée au corpus doit
   avoir sa clé ICI ET dans `en/search.ts` — le test de complétude fr ⇄ en ne
   voit que la parité entre catalogues, pas l'oubli SIMULTANÉ des deux côtés ;
   c'est le test du corpus qui couvre ce cas (chaque famille a un libellé). */
export const search = {
  title: "Recherche globale",
  placeholder: "Nom, n° de série, adresse IP, description…",
  hint: "Au moins 2 caractères — un clic ouvre la fiche. Pour LOCALISER un objet en 2D/3D, la vue Datacenter garde sa propre recherche.",
  truncated: "+ {{n}} autres — affinez la recherche",
  family: {
    equipments: "Équipement",
    subEquipments: "Sous-équip.",
    racks: "Baie",
    datacenters: "Salle",
    sites: "Site",
    floors: "Étage",
    cables: "Câble",
    cableBundles: "Faisceau",
    networks: "Réseau",
    ipNetworks: "Réseau IP",
    ipAddresses: "Adresse IP",
    dhcpRanges: "Plage DHCP",
    vms: "VM",
    spares: "Spare",
    groups: "Groupe",
    contacts: "Contact",
    cableTypes: "Type câble",
    portTypes: "Type port",
  },
} as const;
