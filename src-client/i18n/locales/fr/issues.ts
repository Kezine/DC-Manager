/* ============================================================================
   Domaine `issues` — FRANÇAIS. Feature TICKETS AMOVIBLE (remote issue tracker) :
   édition des champs locaux et des CIBLES d'un ticket, synchronisation, suivi
   d'un ticket, gestion des providers (trackers). Agrégé par `../fr.ts`.
   Voir docs/i18n.md.

   ⚠ AGNOSTICISME DE MARQUE (exigence n°1 du chantier) : AUCUN libellé de ce
   catalogue ne nomme un tracker. La seule chaîne qui cite une marque est le
   LIBELLÉ du `<select>` de type (« Jira »), qui est un nom propre et vit donc
   dans le code du formulaire, non traduit — exactement comme « Proxmox » côté VM
   et « UniFi » côté wifi. `opt.*` regroupe les libellés des options PROPRES à une
   marque : c'est là qu'une nouvelle marque ajoutera les siens.

   ⚠ Le STATUT d'un ticket (« En recette », « Attente client »…) n'est JAMAIS
   traduit — il vient du workflow du tracker et s'affiche tel quel (décision D3).
   Seule sa CATÉGORIE normalisée est traduisible : elle vit dans
   `domain.issueStatusCategory`, pas ici. */
export const issues = {
  common: {
    noProvider: "Aucun provider configuré pour ce document.",
  },
  edit: {
    notFound: "Ticket introuvable",
    localOnly: "Cibles et enrichissements locaux uniquement. Les autres champs (clé, titre, statut, type, priorité, assigné…) sont gérés par la synchronisation et ne sont pas modifiables ici.",
    descriptionHint: "Description libre (jamais écrasée par la synchronisation).",
    notesHint: "Note libre d'enrichissement (jamais écrasée par la synchronisation).",
    title: "Modifier le ticket (cibles et champs locaux)",
    saveRefused: "Enregistrement refusé (données invalides).",
    saved: "Ticket mis à jour",
  },
  targets: {
    label: "Objets ciblés",
    hint: "Objets du modèle concernés par ce ticket (équipements, VMs, spares, sous-équipements). Rattachement manuel : rien n'est déduit du tracker. Un objet supprimé est détaché automatiquement.",
    empty: "Aucun objet ciblé.",
    searchPlaceholder: "Rechercher un objet à lier…",
    remove: "Retirer cet objet",
    exists: "Cet objet est déjà lié à ce ticket.",
  },
  sync: {
    syncLabel: "Synchroniser",
    syncing: "Synchronisation…",
    syncImpossible: "Synchronisation impossible — {{detail}}",
  },
  follow: {
    title: "Suivre un ticket",
    intro: "Le ticket est résolu côté serveur, puis rafraîchi à chaque synchronisation. Rien n'est créé chez le tracker.",
    field: "Clé ou URL du ticket",
    placeholder: "INFRA-123 ou https://…",
    hint: "Collez la clé du ticket ou l'adresse de sa page. Le premier provider qui reconnaît la référence l'emporte.",
    submit: "Suivre",
    required: "Indiquez la clé du ticket ou l'URL de sa page.",
    added: "Ticket suivi",
    already: "Ce ticket est déjà suivi — il vient d'être rafraîchi.",
  },
  // « OUVRIR UN TICKET » (décision D7) — DC Manager CRÉE le ticket chez le tracker, puis l'enregistre.
  // ⚠ Ni le PROJET ni le TYPE ne sont demandés : ce sont des options du provider (l'utilisateur n'a
  // pas à connaître la configuration du tracker) — ils sont seulement RAPPELÉS.
  create: {
    title: "Ouvrir un ticket",
    intro: "Le ticket est créé chez le tracker, puis enregistré et suivi dans ce document. Le projet et le type de ticket viennent de la configuration du provider.",
    summaryField: "Titre",
    summaryPlaceholder: "Résumé court du problème",
    summaryHint: "Titre du ticket chez le tracker. Obligatoire.",
    summaryRequired: "Indiquez un titre pour le ticket.",
    descriptionHint: "Description envoyée au tracker (texte brut). Elle est aussi conservée ici comme enrichissement local.",
    providerField: "Tracker de destination",
    providerHint: "Ce document est relié à plusieurs trackers : indiquez celui chez qui créer le ticket.",
    destination: "Destination : {{provider}} · projet {{project}} · type {{type}}.",
    destinationUnknown: "Destination indisponible — le serveur choisira le provider configuré.",
    noProject: "Le provider « {{provider}} » n'a pas de projet de création configuré : la création sera refusée tant que l'option « Projet de création » est vide.",
    submit: "Ouvrir le ticket",
    created: "Ticket créé",
    // ÉCHEC PARTIEL : le ticket EXISTE chez le tracker mais n'a pas pu être enregistré ici. Le message
    // porte la CLÉ — c'est la seule chose qui rende la situation rattrapable.
    partial: "Le ticket « {{key}} » a été créé chez le tracker mais n'a PAS pu être enregistré ici. Reprenez-le avec « Suivre un ticket » en saisissant la clé « {{key}} ». Détail : {{detail}}",
    alreadyCreated: "Le ticket « {{key}} » a déjà été créé chez le tracker. Fermez cette fenêtre et reprenez-le avec « Suivre un ticket » — réenregistrer créerait un second ticket.",
  },
  // Rangée « Tickets » des fiches détail (équipement / VM / spare / sous-équipement).
  // ⚠ Contrairement à la rangée « Interventions », elle est SYNCHRONE et disponible en mode fichier :
  // les tickets sont une collection du document. Seul « Ouvrir un ticket » exige le mode API.
  fiche: {
    section: "Tickets",
    openCount: "{{n}} ouvert(s)",
    none: "Aucun ticket ouvert",
    create: "Ouvrir un ticket",
    createTitle: "Créer un ticket chez le tracker, déjà rattaché à cet objet",
    showMore: "Afficher plus",
    showMoreTitle: "Ouvrir l'onglet Tickets filtré sur cet objet",
    openDetail: "Ouvrir le ticket",
  },
  providers: {
    title: "Providers de tickets",
    subtitle: "Gestion des trackers interrogés pour ce document",
    loading: "Chargement des providers…",
    loadError: "Chargement des providers impossible — {{detail}}",
    intro: "Trackers configurés pour ce document. Les jetons d'API sont chiffrés côté serveur et ne sont jamais réaffichés.",
    empty: "Aucun provider configuré pour ce document. Ajoutez-en un pour pouvoir suivre des tickets.",
    intervalManual: "manuelle",
    colProvider: "Provider",
    colType: "Type",
    colUrl: "Instance",
    colAccount: "Compte",
    colInterval: "Intervalle",
    colTimeout: "Timeout",
    add: "+ Ajouter un provider",
    back: "← Retour à la liste",
    headingEdit: "Modifier « {{id}} »",
    headingNew: "Nouveau provider",
    idPlaceholder: "ex. jira-infra",
    idField: "Identifiant du provider",
    idHintEdit: "Immuable — c'est la clé référencée par les tickets déjà suivis.",
    idHintNew: "Unique par document (référencé par les tickets synchronisés).",
    typeField: "Type de tracker",
    typeHint: "Détermine l'adaptateur utilisé et les options affichées ci-dessous.",
    urlField: "URL de l'instance",
    urlPlaceholder: "https://exemple.atlassian.net",
    urlHint: "URL https de l'instance (sans chemin d'API). Le jeton voyage en en-tête à chaque requête : le https est obligatoire.",
    accountField: "Compte de service",
    accountPlaceholder: "service-dcmanager@exemple.fr",
    accountHint: "Identifiant du compte associé au jeton (souvent son adresse e-mail). Ce n'est pas un secret : il est réaffiché à l'édition.",
    tokenPlaceholderEdit: "inchangé si vide",
    tokenPlaceholderNew: "jeton d'API (requis)",
    tokenField: "Jeton d'API",
    tokenHintEdit: "Laissez vide pour conserver le jeton actuel. Le jeton n'est jamais réaffiché.",
    tokenHintNew: "Jeton d'API du compte de service, créé chez le tracker. Il est chiffré côté serveur. Préférez un compte dédié, aux droits limités au projet visé.",
    intervalField: "Intervalle de synchro (s)",
    intervalHint: "0 = synchronisation manuelle uniquement. À régler haut : une passe coûte une requête par centaine de tickets suivis, et l'état d'un ticket bouge lentement.",
    timeoutField: "Timeout d'une requête (s)",
    timeoutHint: "Délai maximal d'une requête vers le tracker. Une requête est une recherche à distance : mieux vaut être généreux.",
    opt: {
      section: "Options {{kind}}",
      projectField: "Projet de destination",
      projectHint: "Projet où les incidents et interventions de DC Manager sont répliqués. Obligatoire : sans destination, la réplication n'a nulle part où écrire.",
      projectPlaceholder: "ex. INFRA",
      typeIncidentField: "Type de ticket — incidents",
      typeIncidentHint: "Type appliqué aux INCIDENTS répliqués. Le libellé dépend de la configuration du projet et de sa langue ; un type inconnu fait refuser la création par le tracker.",
      typeIncidentPlaceholder: "Incident",
      typeInterventionField: "Type de ticket — interventions",
      typeInterventionHint: "Type appliqué aux INTERVENTIONS répliquées. Même remarque que pour les incidents : c'est un réglage du projet, pas une énumération.",
      typeInterventionPlaceholder: "Infrastructure",
      autoReplicateField: "Répliquer automatiquement",
      autoReplicateHint: "Crée le ticket dès l'enregistrement d'un incident ou d'une intervention. Un tracker indisponible ne bloque jamais l'enregistrement : la poussée est retentée à la synchronisation suivante.",
    },
    test: "Tester la connexion",
    testing: "Test en cours…",
    testConnOk: "Connexion OK",
    testConnFail: "Connexion en échec",
    testApiOk: "API reconnue",
    testApiWarn: "API à vérifier",
    idRequired: "Identifiant du provider requis",
    savedUpdated: "Provider mis à jour",
    savedCreated: "Provider créé",
    deleteTitle: "Supprimer ce provider ?",
    deleteMessage: "Supprimer le provider « {{id}} » ? Les tickets déjà suivis restent dans le document (ils apparaîtront introuvables).",
    deleted: "Provider supprimé",
    disabledTitle: "Gestion des providers indisponible",
    disabledDetail: "La gestion des providers par l'UI est désactivée côté serveur. Définissez la clé de chiffrement des secrets (DCMANAGER_SECRETS_KEY) dans l'environnement du serveur pour l'activer.",
  },
} as const;
