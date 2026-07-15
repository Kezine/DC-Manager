/* =============================================================================
   CONTRAT D'ADAPTATEUR D'INVENTAIRE VM — module `vm/` AMOVIBLE (exigence de
   cadrage : la feature doit pouvoir être SUPPRIMÉE sans cicatrice). Règle de
   dépendance ABSOLUE : le cœur du serveur (api/db/documents/live) n'importe
   JAMAIS depuis `vm/` — seul `vm/` dépend du cœur, et son montage se fait par
   UN point de branchement fin (cf. plan .notes/vm-proxmox-plan-2026-07-12.md).

   Le pivot `VmRecord` NORMALISE l'inventaire d'un cluster de virtualisation :
   tout le reste de l'application (réconciliation, document, UI) ne connaît QUE
   ce contrat — les évolutions d'API du provider (releases Proxmox…) restent
   confinées à son adaptateur. Proxmox est la PREMIÈRE implémentation ; le
   contrat doit rester agnostique (VMware/Hyper-V envisageables).
   ============================================================================= */

/** Interface réseau d'une VM (vNIC) — matière des « ports spéciaux » : jamais câblable,
    raccordée à un réseau logique DC Manager via la table de mapping bridge/tag (côté client). */
export interface VmNic {
  /** Nom de l'interface côté provider (ex. "net0", "eth0"). */
  name: string;
  /** Adresse MAC (pivot de rapprochement IPAM). null = inconnue. */
  mac: string | null;
  /** Bridge/vSwitch hôte (ex. "vmbr0"). null = inconnu. */
  bridge: string | null;
  /** Tag VLAN. null = pas de tag (réseau natif du bridge). */
  vlan_tag: number | null;
  /** Adresses IP connues (guest-agent ou config statique LXC) — INFORMATIF (cadrage : pas de création IPAM auto). */
  ips: string[];
}

/** Inventaire NORMALISÉ d'une VM — le contrat pivot, agnostique du provider.
    Les champs alimentent les champs SOURCE de l'entité `vms` du document
    (écrasés à chaque synchro) ; la frontière source/locaux vit dans la
    réconciliation, PAS ici. */
export interface VmRecord {
  /** Identité STABLE côté provider (ex. "cluster/vmid") — clé de réconciliation. */
  ext_id: string;
  /** Instance d'adaptateur d'origine (ProviderConfig.id) — multi-clusters. */
  provider_id: string;
  /** Nature : machine virtuelle ("qemu") ou conteneur ("lxc"). */
  vm_type: "qemu" | "lxc";
  name: string;
  /** Description/notes côté provider (champ SOURCE — distinct des notes locales DC Manager). */
  description: string;
  /** État courant ("running" | "stopped" | …) — TOLÉRANT : valeur inconnue conservée telle quelle
      (résilience aux releases provider, décision de cadrage). */
  status: string;
  /** Nom du NŒUD hébergeur (à rapprocher d'un équipement DC Manager par nom — jamais résolu ici). */
  host_node: string | null;
  /** Ressources allouées. null = non remonté par le provider. */
  cpu: number | null;
  ram_mb: number | null;
  disk_gb: number | null;
  /** Tags côté provider (champ SOURCE). */
  tags: string[];
  nics: VmNic[];
}

/** Un NŒUD physique du cluster de virtualisation, avec ses métriques instantanées. Alimente la
    vue « Clusters » (cadrage 2026-07-13) — état OPÉRATIONNEL, JAMAIS persisté dans le document.
    Toute métrique est NULLABLE : le provider peut ne pas la remonter (nœud hors ligne, droits
    partiels) et on ne DEVINE rien (null = inconnu, à distinguer d'une vraie valeur nulle). */
export interface VmClusterNode {
  /** Nom COURT du nœud (ex. "pve1") — à rapprocher d'un équipement DC Manager comme VmRecord.host_node. */
  name: string;
  /** Nœud actif/joignable dans le cluster (Proxmox : statut "online"). */
  online: boolean;
  /** Charge CPU INSTANTANÉE en FRACTION 0..1 (et non en pourcentage) — telle que Proxmox l'expose
      (champ `cpu`) ; c'est l'UI qui la formate en %. null = non remontée (typiquement hors ligne). */
  cpu_used: number | null;
  /** Nombre de cœurs du nœud (`maxcpu`) — dénominateur de cpu_used à l'affichage. */
  cpu_total: number | null;
  /** Mémoire UTILISÉE puis TOTALE, en Mo (octets Proxmox → Mo, même unité que VmRecord.ram_mb). */
  mem_used_mb: number | null;
  mem_total_mb: number | null;
  /** Uptime du nœud en secondes (l'UI le rend lisible). null = inconnu / hors ligne. */
  uptime_sec: number | null;
  /** URL PROFONDE de l'UI de management de CE nœud, GÉNÉRÉE PAR LE PROVIDER (chaque adaptateur
      connaît le schéma d'URL de son UI web). La vue « Clusters » en fait un lien par nœud. PUBLIC
      (pas un secret). null = provider sans UI web ou URL non générable (pool sans endpoint). */
  management_url: string | null;
}

/** État d'ENSEMBLE d'un cluster synchronisé — identité, version, quorum, nœuds. Pivot AGNOSTIQUE
    du provider (Proxmox n'est que la 1re implémentation), produit dans le MÊME passage réseau que
    l'inventaire des VMs (cf. VmInventory) : le décodage de /cluster/resources porte les deux. État
    OPÉRATIONNEL destiné à la vue « Clusters » — gardé en mémoire serveur, jamais écrit au document. */
export interface VmClusterInfo {
  /** Nom du cluster — le MÊME qui préfixe les ext_id des VMs (déjà résolu par l'adaptateur, repli
      inclus sur l'id d'instance pour un nœud isolé) : garantit la cohérence UI ↔ réconciliation. */
  name: string;
  /** Version du gestionnaire (ex. "8.4.1"). null = indisponible (endpoint /version en échec) — elle
      est INFORMATIVE : son absence n'empêche JAMAIS l'inventaire (décision de cadrage). */
  version: string | null;
  /** Version DANS la gamme supportée par l'adaptateur — hors gamme = simple avertissement UI. */
  supported: boolean;
  /** État de QUORUM du cluster. null = inconnu : nœud isolé (hors cluster, le quorum n'a pas de
      sens) ou /cluster/status indisponible — à DISTINGUER d'un quorum PERDU (false). */
  quorate: boolean | null;
  /** Nœuds du cluster avec leurs métriques (tableau vide si non remontés). */
  nodes: VmClusterNode[];
  /** URL de l'outil de management du CLUSTER, RECOPIÉE par l'adaptateur depuis la config
      (ProviderConfig.management_url) : pour Proxmox, l'URL du Proxmox Datacenter Manager — un
      service DISTINCT des nœuds, NON déductible de l'API, donc FOURNIE en config. La vue
      « Clusters » en fait un bouton « Management » d'en-tête. PUBLIC (pas un secret). null = non
      renseignée. */
  management_url: string | null;
}

/** Résultat d'UNE passe d'inventaire : les VMs normalisées ET l'état du cluster, produits ENSEMBLE
    en un seul passage réseau (la réponse /cluster/resources porte les deux — zéro appel de plus pour
    les nœuds). La réconciliation ne consomme que `vms` ; `cluster` alimente la vue « Clusters »
    (capture mémoire côté VmSyncService, tâche C2). */
export interface VmInventory {
  vms: VmRecord[];
  cluster: VmClusterInfo;
}

/** Résultat du test de joignabilité/compatibilité d'une instance (bouton « Tester » / démarrage). */
export interface ProviderInfo {
  /** Le cluster répond et l'authentification passe. */
  ok: boolean;
  kind: string;
  /** Version remontée par le provider (ex. "8.4.1"). null = indisponible. */
  version: string | null;
  /** Version DANS la gamme supportée par l'adaptateur ? Hors gamme = WARNING, pas un blocage
      (décision de cadrage : tolérance aux releases, l'inventaire tente quand même). */
  supported: boolean;
  /** Message lisible (erreur d'accès, avertissement de version…). */
  message: string;
}

/** UN point d'accès à l'API du cluster (un nœud). L'API Proxmox répond sur CHAQUE nœud :
    déclarer plusieurs endpoints permet de BASCULER quand le nœud visé est en panne
    (exigence 2026-07-13). L'empreinte TLS est PAR ENDPOINT — chaque nœud Proxmox porte
    son PROPRE certificat, une empreinte globale n'aurait pas de sens. */
export interface ProviderEndpoint {
  /** URL de base de l'API de CE nœud (ex. "https://pve1.example.lan:8006"). */
  url: string;
  /** Empreinte SHA-256 du certificat TLS de CE nœud à ÉPINGLER (certificats auto-signés
      fréquents). null = validation TLS standard par les CA système. */
  fingerprint: string | null;
}

/** Configuration d'UNE instance d'adaptateur (un cluster) — chargée d'un fichier CÔTÉ SERVEUR
    (vm-providers.json, cf. ProviderConfigStore) : les secrets ne transitent JAMAIS par le
    document (répliqué à tous les clients) ni par l'API de consultation. */
export interface ProviderConfig {
  /** Identifiant unique de l'instance (référencé par VmRecord.provider_id et l'état de synchro). */
  id: string;
  /** Type d'adaptateur ("proxmox" | futurs). */
  kind: string;
  /** POOL de points d'accès (≥ 1), essayés DANS L'ORDRE en cas de défaillance réseau d'un
      nœud (cf. PveHttpPool : la bascule ne s'applique qu'aux erreurs de JOIGNABILITÉ —
      une erreur d'authentification échouerait à l'identique sur tous les nœuds). */
  endpoints: ProviderEndpoint[];
  /** Jeton d'API (Proxmox : "USER@REALM!TOKENID=UUID", rôle lecture seule suffisant) —
      le MÊME pour tout le cluster (les jetons Proxmox sont cluster-wide). */
  token: string;
  /** Inclure les conteneurs LXC (décision de cadrage : oui par défaut). */
  include_lxc: boolean;
  /** Période de synchro automatique en secondes. 0 = synchro MANUELLE uniquement. */
  interval_sec: number;
  /** Délai maximal d'UNE requête HTTP en secondes (exigence 2026-07-13 : configurable —
      il borne aussi le coût d'une bascule : un nœud mort coûte au plus ce délai). */
  timeout_sec: number;
  /** Certificat CA du cluster (PEM `pve-root-ca.pem`) — alternative à l'épinglage PAR NŒUD.
      La CA du cluster émet le certificat de CHAQUE nœud : lui faire confiance = UNE seule valeur
      pour tout le pool, qui SURVIT aux régénérations de certificats (`pvecm updatecerts`).
      HIÉRARCHIE DE CONFIANCE, par ENDPOINT (cf. PveHttp.trustOptions) :
        1. `fingerprint` de l'endpoint présent → ÉPINGLAGE (le plus spécifique, prioritaire) ;
        2. sinon `ca_pem` présent → validation TLS par CETTE CA (le nom d'hôte de l'URL doit
           alors correspondre au CN/SAN du certificat du nœud, sinon ERR_TLS_CERT_ALTNAME_INVALID) ;
        3. sinon → validation par les CA système.
      Un certificat CA est PUBLIC (pas un secret) : contrairement au jeton, il peut transiter
      dans les réponses de lecture. null = pas de CA cluster (comportement historique). */
  ca_pem: string | null;
  /** URL de l'outil de management du CLUSTER, FOURNIE en config (Proxmox : l'URL du Proxmox
      Datacenter Manager — un service DISTINCT des nœuds, NON déductible de l'API). Recopiée telle
      quelle dans VmClusterInfo.management_url (bouton « Management » de la vue Clusters). À NE PAS
      confondre avec les URLs par nœud, elles GÉNÉRÉES par l'adaptateur (VmClusterNode.management_url).
      PUBLIC (pas un secret) : transite en clair, renvoyée en lecture. null = non renseignée. */
  management_url: string | null;
}

/** SOURCE de configuration des providers vue par le moteur de synchro (VmSyncService) — le
    strict minimum dont il a besoin, INDÉPENDAMMENT du support de stockage. Deux implémentations :
    `ProviderConfigStore` (fichier legacy `vm-providers.json`, lecture seule) et `ProviderConfigDb`
    (base `vm-providers.db`, jetons chiffrés + CRUD). VmSyncService ne dépend QUE de ce contrat :
    basculer fichier ↔ DB (cf. VmModule selon la présence de la clé) ne le touche pas. */
export interface ProviderConfigSource {
  /** Providers configurés pour un document (jetons EN CLAIR, prêts pour l'adaptateur). Document
      non configuré → `[]` (feature dormante pour CE document). */
  providersFor(docId: string): ProviderConfig[];
  /** Documents ayant au moins un provider (utile à l'armement des timers de synchro périodique). */
  configuredDocIds(): string[];
}

/** ADAPTATEUR d'inventaire VM — une implémentation par famille de provider.
    Contrat volontairement minimal (lecture seule) : la synchro n'a besoin que de ça. */
export interface VmProviderAdapter {
  readonly kind: string;
  readonly config: ProviderConfig;
  /** Joignabilité + authentification + contrôle de gamme de versions (GET /version côté Proxmox). */
  test(): Promise<ProviderInfo>;
  /** Inventaire complet du cluster EN UN SEUL PASSAGE réseau : les VMs normalisées (QEMU + LXC
      selon config, templates exclus, VMs arrêtées INCLUSES — cadrage) ET l'état du cluster (nœuds,
      métriques, quorum, version) — la MÊME réponse /cluster/resources porte VMs et nœuds.
      Jette en cas d'échec de l'inventaire de MASSE : l'appelant (synchro) journalise et conserve
      l'état précédent. Les métadonnées cluster SECONDAIRES (quorum, version) sont TOLÉRANTES —
      leur indisponibilité donne des champs null, sans faire échouer la passe. */
  inventory(): Promise<VmInventory>;
}
