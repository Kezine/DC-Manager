/* ============================================================================
   Domaine `tabs` — FRANÇAIS. En-têtes d'onglets (libellé, titre d'en-tête,
   sous-titre). Agrégé par `../fr.ts`. Voir docs/i18n.md.

   NB : « Netmap » (onglet du graphe) est un NOM DE FONCTIONNALITÉ — il reste
   « Netmap » dans les deux langues (cf. CLAUDE.md / renommage DC Manager). */
export const tabs = {
  equipements: {
    label: "Équipements",
    subtitle: "Switchs, serveurs, caissons, modems… avec leurs ports, rôles et agrégats.",
  },
  vms: {
    label: "VMs",
    title: "Équipements virtuels (VMs)",
    subtitle: "VMs QEMU et conteneurs LXC alimentés par la synchronisation d'un cluster de management (Proxmox). Champs source en lecture ; les enrichissements locaux se font depuis la fiche.",
  },
  clusters: {
    label: "Clusters",
    subtitle: "État par provider des clusters synchronisés (nœuds, métriques, quorum) et de la synchronisation.",
  },
  racks: {
    label: "Racks",
    subtitle: "Baies : emplacement, taille (U), profondeur, faces, portes et capots. « ▦ Contenu » pour monter les équipements dans les U.",
  },
  cables: {
    label: "Câbles",
    subtitle: "Lien nommé entre deux ports — type compatible avec les ports, réseau optionnel.",
  },
  ipam: {
    label: "IPAM",
    title: "IPAM — Réseaux IP",
    subtitle: "Registre d'attribution d'IP statiques. Déclarez des sous-réseaux (CIDR IPv4), puis attribuez-y des adresses et réservez des plages DHCP.",
  },
  graph: {
    label: "Netmap",
    subtitle: "Rendu filtré par équipements, réseaux et/ou types de port. Zoom, recentrage, surbrillance.",
  },
  datacenter: {
    label: "Datacenters",
    subtitle: "Disposition physique des salles : baies en 3D. Glisser = déplacer · Maj/clic droit = orbiter · molette = zoom.",
  },
  groupes: {
    label: "Groupes",
    subtitle: "Regroupements logiques d'équipements : label + couleur + description.",
  },
  spares: {
    label: "Spares",
    subtitle: "Inventaire de pièces de rechange (HDD · SSD · transceiver · autre) : suivi unitaire, statut, attribution.",
  },
  faceimages: {
    label: "Images de façade",
    subtitle: "Bibliothèque d'images de façade (JPEG/PNG/WebP) partagées par référence. Stockées hors document (IndexedDB).",
  },
  reseaux: {
    label: "Réseaux",
    subtitle: "Réseaux logiques (VLAN…) ou circuits d'alimentation : label, couleur, type.",
  },
  faisceaux: {
    label: "Faisceaux",
    title: "Faisceaux / trunks",
    subtitle: "Câbles MULTI-FIBRES entre 2 patch panels, créés à l'avance. Les PORTS des patchs piochent les fibres ; la route du trunk porte son tracé 2D/3D.",
  },
  porttypes: {
    label: "Types de port",
    title: "Types de port / liaison",
    subtitle: "Catalogue STANDARDISÉ (lecture seule). La « famille » lie ports et câbles compatibles ; le « connecteur » est la forme physique.",
  },
  cabletypes: {
    label: "Types de câble",
    subtitle: "Catalogue STANDARDISÉ (lecture seule). Rattaché à une « famille » de port.",
  },
  ipaddresses: {
    label: "Adresses IP",
    title: "Adresses IP statiques",
    subtitle: "Une ligne = une IP attribuée. Liée à un réseau, optionnellement à un équipement. Unicité garantie.",
  },
  salles: {
    label: "Salles",
    title: "Salles (datacenters)",
    subtitle: "Grille au sol d'une salle : dimensions + maille. Placez-y des baies (onglet Racks → champ Salle) pour les voir en 3D.",
  },
  sites: {
    label: "Sites",
    title: "Sites / bâtiments",
    subtitle: "Nom + adresse. La suppression décommissionne le site (salles & étages supprimés, baies → non placé, liaisons logiques préservées).",
  },
  etages: {
    label: "Étages",
    title: "Plans d'étage",
    subtitle: "Dimensions, maille et ancrage d'un étage (bâtiment + niveau). « + Étage » : choisir le bâtiment et le niveau.",
  },
  dhcpranges: {
    label: "Plages DHCP",
    title: "Plages DHCP réservées",
    subtitle: "Plages (début → fin) attribuées à un serveur DHCP. Pas de chevauchement avec une autre plage ni une IP statique du réseau.",
  },
  contacts: {
    label: "Contacts",
    title: "Contacts (notifications)",
    subtitle: "Carnet des destinataires des notifications (email / sms). Nom requis ; e-mail et téléphone facultatifs (validés en douceur). Référencés par le routage notify (référence souple contact_id, hors document).",
  },
  notifications: {
    label: "Notifications",
    subtitle: "Administration du service de notifications : canaux d'envoi, abonnements par type d'événement, intervalles de rappel, alertes actives, historique et tests d'envoi.",
  },
  interventions: {
    label: "Interventions",
    subtitle: "Incidents subis et interventions planifiées, liés aux équipements, VMs et pièces de rechange : cycle de vie, priorité, fenêtre d'intervention, référence Jira.",
  },
  certificats: {
    label: "Certificats",
    subtitle: "PKI interne (zéro-connaissance) : clé maître, autorités et certificats X.509/SSH, émission, exports, révocation. La cryptographie se fait dans le navigateur — le serveur ne voit jamais la clé maître.",
  },
  parametres: {
    label: "Paramètres",
  },
} as const;
