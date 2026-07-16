/* ============================================================================
   Catalogue de traduction — FRANÇAIS (langue de RÉFÉRENCE).
   ----------------------------------------------------------------------------
   POURQUOI un fichier .ts (et non .json) : le tsconfig n'active pas
   `resolveJsonModule`, et un module .ts fige gratuitement le TYPE des clés via
   `as const` — l'anglais (`en.ts`) doit calquer EXACTEMENT cette structure
   (garde-fou : `Tests/modules/test-i18n.js` compare récursivement les deux).

   RÈGLE : le FRANÇAIS est la source de vérité. Toute chaîne UI migrée est
   déplacée ICI telle quelle, puis traduite dans `en.ts` sous la MÊME clé.
   Clés STRUCTURÉES par DOMAINE (ici `tabs` = en-têtes d'onglets : libellé,
   titre d'en-tête, sous-titre). Voir docs/i18n.md pour la procédure d'ajout.

   NB : « Netmap » (onglet du graphe) est un NOM DE FONCTIONNALITÉ — il reste
   « Netmap » dans les deux langues (cf. CLAUDE.md / renommage DC Manager). */
export const fr = {
  tabs: {
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
  },
  interventions: {
    kind: {
      incident: "Incident",
      intervention: "Intervention",
    },
    status: {
      declared: "Déclaré",
      planned: "Planifié",
      in_progress: "En cours",
      closed: "Clos",
      cancelled: "Annulé",
    },
    priority: {
      low: "Basse",
      normal: "Normale",
      high: "Haute",
      critical: "Critique",
    },
    target: {
      equipment: "Équipement",
      vm: "VM",
      spare: "Pièce (spare)",
      unknown: "(introuvable)",
    },
    col: {
      title: "Titre",
      type: "Type",
      priority: "Priorité",
      status: "Statut",
      window: "Fenêtre planifiée",
      links: "Liens",
      jira: "Jira",
      createdBy: "Créé par",
      actions: "Actions",
    },
    filter: {
      label: "Filtrer",
      type: "Type",
      status: "Statut",
      priority: "Priorité",
      reset: "Réinit. filtres",
    },
    search: {
      placeholder: "Rechercher (titre, description, réf. Jira)…",
    },
    action: {
      addIncident: "+ Incident",
      addIntervention: "+ Intervention",
      refresh: "Actualiser",
    },
    rowAction: {
      edit: "Modifier",
      start: "Démarrer",
      close: "Clore",
      delete: "Supprimer",
    },
    modal: {
      createIncidentTitle: "Nouvel incident",
      createInterventionTitle: "Nouvelle intervention",
      editTitle: "Modifier",
      kind: "Nature",
      title: "Titre",
      titlePlaceholder: "ex. Remplacement du switch cœur",
      description: "Description",
      descriptionHint: "Markdown accepté (rendu à venir). Détaillez le contexte, le plan d'action, les impacts.",
      priority: "Priorité",
      status: "Statut",
      plannedStart: "Début planifié",
      plannedHint: "Fenêtre d'intervention optionnelle (heure locale). La fin exige un début et doit lui être postérieure.",
      plannedEnd: "Fin planifiée",
      jiraRef: "Référence Jira",
      jiraRefPlaceholder: "ex. INFRA-123 ou une URL",
      jiraHint: "Clé ou URL d'un ticket. Simple référence — aucun appel à Jira.",
      links: "Objets liés",
      linksHint: "Équipements, VMs ou pièces concernés. Une cible supprimée reste « introuvable » (lien conservé).",
      linksFamily: "Famille",
      linksTarget: "Cible",
      linksAdd: "Ajouter",
      linksEmpty: "Aucun objet lié.",
      linksNoTarget: "— aucun disponible —",
      linksRemove: "Retirer",
    },
    confirm: {
      deleteTitle: "Supprimer cette intervention ?",
      deleteMessage: "Supprimer « {{title}} » ? Ses liens seront retirés. Cette action est définitive.",
      deleteConfirm: "Supprimer",
    },
    toast: {
      created: "Intervention créée",
      updated: "Intervention mise à jour",
      deleted: "Intervention supprimée",
      started: "Intervention démarrée",
      closed: "Intervention close",
    },
    error: {
      titleRequired: "Le titre est requis.",
    },
    pager: {
      count: "{{n}} élément(s)",
      page: "page {{page}}/{{pages}}",
      perPage: "{{n}}/page",
    },
    msg: {
      loadError: "Chargement impossible",
      empty: "Aucune intervention. Créez-en une avec « + Incident » ou « + Intervention », ou ajustez les filtres.",
      needsApiTitle: "Interventions — mode API requis",
      needsApi: "Le suivi des incidents et interventions est fourni par le serveur. Il n'est disponible qu'en mode API. Basculez la source de données sur « API » dans les Réglages pour l'utiliser.",
      noDocTitle: "Interventions — aucun document ouvert",
      noDoc: "Les interventions sont propres à CHAQUE document. Ouvrez ou créez un document pour les gérer.",
      disabledTitle: "Service d'interventions indisponible",
      disabled: "Le module interventions est désactivé côté serveur (base interventions.db illisible). Consultez les journaux du serveur.",
    },
  },
} as const;
