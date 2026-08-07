/* ============================================================================
   Domaine `tracker` — FRANÇAIS. PONT « interventions ⇄ tracker distant »
   (feature AMOVIBLE) : actions d'en-tête de la vue Interventions, bloc « Ticket »
   des fiches d'intervention et gestion des providers de réplication. Agrégé par
   `../fr.ts`. Voir docs/i18n.md.

   ⚠ AGNOSTICISME DE MARQUE (exigence n°1 du chantier) : AUCUN libellé de ce
   catalogue ne nomme un tracker. La seule chaîne qui cite une marque est le
   LIBELLÉ du `<select>` de type (« Jira »), qui est un nom propre et vit donc
   dans le code du formulaire, non traduit — exactement comme « Proxmox » côté VM
   et « UniFi » côté wifi. `opt.*` regroupe les libellés des options PROPRES à une
   marque : c'est là qu'une nouvelle marque ajoutera les siens.

   ⚠ Le STATUT d'un ticket (« En recette », « Attente client »…) n'est JAMAIS
   traduit — il vient du workflow du tracker et s'affiche tel quel (décision D3).
   Seule sa CATÉGORIE normalisée est traduisible : elle vit dans
   `domain.trackerStatusCategory`, pas ici. */
export const tracker = {
  // Actions d'EN-TÊTE de la vue Interventions — mode API ET hors viewer (les deux écrivent).
  action: {
    sync: "Synchroniser",
    syncTitle: "Envoyer les mises à jour dues et relire l'état des tickets chez les trackers configurés pour ce document",
    syncing: "Synchronisation…",
    syncDone: "Synchronisation terminée",
    syncFailed: "Synchronisation impossible — {{detail}}",
    providers: "Providers…",
    providersTitle: "Configurer les trackers de destination (instance, compte de service, jeton, projet, intervalle)",
  },
  // Bloc « Ticket » de la fiche de DÉTAIL d'une intervention. ⚠ `notFoundTitle` explique la même
  // mécanique que `vm.orphanTitle` et `wifi.disconnectedTitle`, avec un TROISIÈME sens : un ticket
  // qu'on ne résout plus signale une suppression, un projet archivé ou une permission perdue.
  ticket: {
    section: "Ticket",
    notFoundTitle: "Non résolu à la dernière synchronisation — supprimé, projet archivé ou permission perdue. L'intervention et son contenu sont conservés ici, et le ticket reviendra si l'accès est rétabli.",
    assignee: "Assigné",
    unassigned: "Non assigné",
    lastSync: "Dernier retour d'état",
    never: "Jamais",
    // ÉTAT DE POUSSÉE : ce que DC Manager sait de l'envoi de SON contenu vers le ticket.
    push: {
      label: "Contenu du ticket",
      synced: "À jour",
      pending: "Envoi en attente",
      error: "Envoi en échec",
      none: "Jamais envoyé",
    },
    update: "Mettre à jour le ticket",
    updated: "Ticket mis à jour",
    // AMORÇAGE — deux cas qui s'excluent (cf. l'en-tête de TrackerTicketBlock).
    replicate: "Répliquer vers le tracker",
    replicateHint: "Crée le ticket chez le tracker et suit ensuite son traitement. Le projet et le type de ticket viennent de la configuration du provider.",
    replicated: "Intervention répliquée",
    link: "Lier le ticket existant",
    linkHint: "Une référence de ticket est déjà renseignée sur cette intervention ({{reference}}) : elle sera ADOPTÉE plutôt que doublée par un nouveau ticket.",
    linkConfirmTitle: "Lier ce ticket existant ?",
    linkConfirmMessage: "Adopter le ticket « {{reference}} » pour cette intervention ? DC Manager fait foi sur le CONTENU : le titre et la description de l'intervention ÉCRASERONT le résumé et la description de ce ticket à la prochaine mise à jour. Si ce ticket a été créé par une autre source, son contenu actuel sera perdu.",
    linkConfirm: "Lier le ticket",
    providerField: "Tracker de destination",
    providerHint: "Ce document est relié à plusieurs trackers : indiquez celui chez qui répliquer.",
    // ÉCHEC après création RÉELLE : le ticket EXISTE chez le tracker mais l'état local n'a pas suivi.
    // Le message porte la CLÉ — c'est la seule chose qui rende la situation rattrapable.
    createdOrphan: "Le ticket « {{key}} » existe chez le tracker mais l'intervention n'a pas pu être mise à jour ici. Renseignez la référence « {{key}} » sur l'intervention puis utilisez « Lier le ticket existant ». Détail : {{detail}}",
  },
  // Indicateur d'échec de poussée dans le LISTING (colonne du ticket) — infobulle = message du tracker.
  list: {
    pushErrorTitle: "Envoi du contenu en échec — {{detail}}",
  },
  providers: {
    title: "Providers de réplication",
    subtitle: "Gestion des trackers de destination de ce document",
    loading: "Chargement des providers…",
    loadError: "Chargement des providers impossible — {{detail}}",
    intro: "Trackers où les incidents et interventions de ce document sont répliqués. Les jetons d'API sont chiffrés côté serveur et ne sont jamais réaffichés.",
    empty: "Aucun provider configuré pour ce document. Ajoutez-en un pour pouvoir répliquer les incidents et interventions.",
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
    idHintEdit: "Immuable — c'est la clé référencée par les interventions déjà répliquées.",
    idHintNew: "Unique par document (référencé par les interventions répliquées).",
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
    intervalHint: "0 = synchronisation manuelle uniquement. À régler haut : une passe envoie les mises à jour dues puis relit l'état des tickets répliqués, et l'état d'un ticket bouge lentement.",
    timeoutField: "Timeout d'une requête (s)",
    timeoutHint: "Délai maximal d'une requête vers le tracker. Une requête traverse Internet : mieux vaut être généreux.",
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
    deleteMessage: "Supprimer le provider « {{id}} » ? Les interventions déjà répliquées gardent leur ticket et sa référence, mais leur état cessera d'être rafraîchi.",
    deleted: "Provider supprimé",
    disabledTitle: "Gestion des providers indisponible",
    disabledDetail: "La gestion des providers par l'UI est désactivée côté serveur. Définissez la clé de chiffrement des secrets (DCMANAGER_SECRETS_KEY) dans l'environnement du serveur pour l'activer.",
  },
} as const;
