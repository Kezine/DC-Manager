/* ============================================================================
   Domaine `wifi` — FRANÇAIS. Feature CLIENTS WIFI AMOVIBLE : édition des champs
   locaux d'un client, synchronisation, gestion des providers (contrôleurs).
   Agrégé par `../fr.ts`. Voir docs/i18n.md et docs/wifi-unifi.md.

   ⚠ AGNOSTICISME DE MARQUE (décision D9 du cadrage) : AUCUN libellé de ce
   catalogue ne nomme un constructeur. Les seules chaînes qui citent une marque
   sont les LIBELLÉS DU `<select>` de type (« UniFi »), qui sont des noms propres
   et vivent donc dans le code du formulaire, non traduits — exactement comme
   « Proxmox » côté VM. `opt.*` regroupe les libellés des options PROPRES à une
   marque : c'est là qu'une nouvelle marque ajoutera les siens.

   Les valeurs PERSISTÉES (types de raccordement « wireless »/« wired », ids de
   kinds) ne sont JAMAIS localisées : hors périmètre, elles s'affichent telles quelles. */
export const wifi = {
  common: {
    noProvider: "Aucun provider configuré pour ce document.",
  },
  edit: {
    notFound: "Client wifi introuvable",
    localOnly: "Enrichissements locaux uniquement. Les autres champs (nom, MAC, IP, SSID, type, point d'accès…) sont gérés par la synchronisation et ne sont pas modifiables ici.",
    descriptionHint: "Description libre (jamais écrasée par la synchronisation).",
    notesHint: "Note libre d'enrichissement (jamais écrasée par la synchronisation).",
    title: "Modifier le client wifi (champs locaux)",
    saveRefused: "Enregistrement refusé (données invalides).",
    saved: "Client wifi mis à jour",
  },
  sync: {
    syncLabel: "Synchroniser",
    syncing: "Synchronisation…",
    syncImpossible: "Synchronisation impossible — {{detail}}",
  },
  providers: {
    title: "Providers wifi",
    subtitle: "Gestion des contrôleurs de synchronisation des clients wifi",
    loading: "Chargement des providers…",
    loadError: "Chargement des providers impossible — {{detail}}",
    intro: "Contrôleurs configurés pour ce document. Les clés d'API sont chiffrées côté serveur et ne sont jamais réaffichées.",
    empty: "Aucun provider configuré pour ce document. Ajoutez-en un pour synchroniser l'inventaire des clients wifi.",
    intervalManual: "manuelle",
    colProvider: "Provider",
    colType: "Type",
    colUrl: "Console",
    colInterval: "Intervalle",
    colTimeout: "Timeout",
    add: "+ Ajouter un provider",
    back: "← Retour à la liste",
    headingEdit: "Modifier « {{id}} »",
    headingNew: "Nouveau provider",
    idPlaceholder: "ex. wifi-siege",
    idField: "Identifiant du provider",
    idHintEdit: "Immuable — c'est la clé de réconciliation des clients de ce provider.",
    idHintNew: "Unique par document (référencé par les clients synchronisés).",
    typeField: "Type de contrôleur",
    typeHint: "Détermine l'adaptateur utilisé et les options affichées ci-dessous.",
    urlField: "URL de la console",
    urlHint: "URL https de la console (sans chemin d'API). La clé voyage en en-tête à chaque requête : le https est obligatoire.",
    tlsField: "Empreinte TLS",
    tlsHint: "Optionnel — épingle le certificat de la console (utile pour un certificat auto-signé). Vide = validation par la CA ci-dessous, sinon par les CA système.",
    fpPlaceholder: "empreinte SHA-256 (optionnelle)",
    caField: "CA de la console (PEM)",
    caHint: "Optionnel — collez le certificat de l'autorité qui a signé celui de la console. L'empreinte reste prioritaire. Vide = validation par les CA système.",
    tokenPlaceholderEdit: "inchangé si vide",
    tokenPlaceholderNew: "clé d'API (requise)",
    tokenField: "Clé d'API",
    tokenHintEdit: "Laissez vide pour conserver la clé actuelle. La clé n'est jamais réaffichée.",
    tokenHintNew: "Clé d'API en lecture seule, créée dans la console. Elle est chiffrée côté serveur.",
    intervalField: "Intervalle de synchro (s)",
    intervalHint: "0 = synchronisation manuelle uniquement.",
    timeoutField: "Timeout d'une requête (s)",
    timeoutHint: "Délai maximal d'une requête HTTP vers la console.",
    opt: {
      section: "Options {{kind}}",
      siteField: "Site",
      siteHint: "Identifiant OU nom du site à inventorier. Un provider couvre UN site : pour en suivre plusieurs, créez plusieurs providers.",
      sitePlaceholder: "default",
      wiredField: "Inclure les clients filaires",
      wiredHint: "Désactivé par défaut : seuls les clients sans fil sont inventoriés. Activez-le pour remonter aussi le filaire.",
    },
    test: "Tester la connexion",
    testing: "Test en cours…",
    testConnOk: "Connexion OK",
    testConnFail: "Connexion en échec",
    testApiOk: "API et site résolus",
    testApiWarn: "API ou site à vérifier",
    idRequired: "Identifiant du provider requis",
    savedUpdated: "Provider mis à jour",
    savedCreated: "Provider créé",
    deleteTitle: "Supprimer ce provider ?",
    deleteMessage: "Supprimer le provider « {{id}} » ? Les clients déjà synchronisés restent dans le document, figés dans leur dernier état : plus aucune synchro ne les couvre (un client affiché connecté le restera).",
    deleted: "Provider supprimé",
    disabledTitle: "Gestion des providers indisponible",
    disabledDetail: "La gestion des providers par l'UI est désactivée côté serveur. Définissez la clé de chiffrement des secrets (DCMANAGER_SECRETS_KEY) dans l'environnement du serveur pour l'activer.",
  },
} as const;
