/* =============================================================================
   CONTRAT D'ADAPTATEUR D'INVENTAIRE « CLIENTS WIFI » — module `wifi/` AMOVIBLE
   (exigence de cadrage : la feature doit pouvoir être SUPPRIMÉE sans cicatrice).
   Règle de dépendance ABSOLUE : le cœur du serveur (api/db/documents/live)
   n'importe JAMAIS depuis `wifi/` — seul `wifi/` dépend du cœur, et son montage
   se fait par UN point de branchement fin dans `index.ts`.

   ── AGNOSTICISME DE MARQUE (décision D9 du cadrage) ───────────────────────────
   Ce fichier est la FRONTIÈRE : tout ce qu'il déclare est indépendant de la
   marque du contrôleur. UniFi est la PREMIÈRE implémentation, pas la seule
   envisagée (Aruba, Meraki, Ruckus…). Le pivot `WifiClientRecord`, le contrat
   `WifiProviderAdapter`, la réconciliation (`WifiReconcile`), le moteur de
   synchro (`WifiSyncService`), le stockage de config (`WifiProviderConfigDb`),
   les routes (`WifiModule`) et l'UI ne connaissent QUE ce contrat.
   Tout ce qui est propre à UniFi (HTTP, chemins `/v1/`, décodage des champs)
   vit DERRIÈRE l'adaptateur `kind: "unifi"` (fichiers préfixés `Unifi*`), résolu
   par la fabrique `WifiSyncService.adapterFor`.
   ➜ AJOUTER UNE MARQUE = 1 adaptateur `XxxAdapter` + 1 entrée dans la fabrique
     + 1 branche d'options dans `WifiProviderConfigValidate.KIND_OPTION_SPECS`
     + 1 option du `<select>` « Type » côté UI. RIEN d'autre à toucher (ni ce
     fichier, ni le service, ni la réconciliation, ni la DB, ni les routes).
     Procédure détaillée : `docs/wifi-unifi.md` § « Ajouter un provider d'une
     autre marque ».
   ============================================================================= */

/** Inventaire NORMALISÉ d'UN client wifi — le contrat pivot, AGNOSTIQUE du contrôleur.
    Les champs alimentent les champs SOURCE de l'entité `wifiClients` du document
    (écrasés à chaque synchro) ; la frontière source/locaux vit dans la réconciliation
    et sa définition PARTAGÉE (`src-shared/WifiSync.ts`), PAS ici.

    TOLÉRANCE : toute valeur inconnue du contrôleur est `null` (jamais devinée) et
    toute valeur libre (`client_type`) est conservée TELLE QUELLE — le pivot isole le
    reste de l'application des évolutions d'API et des différences entre marques. */
export interface WifiClientRecord {
  /** Identité STABLE côté contrôleur — clé de réconciliation. L'adaptateur décide de
      sa composition ; elle doit SURVIVRE à une déconnexion/reconnexion du client
      (sinon chaque retour créerait un doublon et laisserait un orphelin derrière lui). */
  ext_id: string;
  /** Instance d'adaptateur d'origine (`WifiProviderConfig.id`) — multi-contrôleurs. */
  provider_id: string;
  /** Nom d'affichage (hostname / alias). "" = inconnu — cas NOMINAL côté wifi. */
  name: string;
  /** Adresse MAC du client. null = non remontée. */
  mac: string | null;
  /** Adresse IP CONSTATÉE (bail courant). null = non remontée. */
  ip: string | null;
  /** Nature du raccordement TELLE QUE remontée (« wireless »/« wired »/valeur inconnue) —
      chaîne LIBRE : chaque marque a son vocabulaire, on ne le normalise pas en enum. */
  client_type: string;
  /** SSID rejoint. null = inconnu (ou client filaire). */
  ssid: string | null;
  /** MAC du point d'accès porteur. null = inconnue. */
  ap_mac: string | null;
  /** Nom du point d'accès côté contrôleur — base du rapprochement vers un équipement
      DC Manager (jamais résolu ici : c'est la réconciliation qui le fait, cf. D4). */
  ap_name: string | null;
  /** Début de la connexion courante, en ISO 8601. null = non remonté. */
  connected_since: string | null;
}

/** Résultat d'UNE passe d'inventaire. Enveloppe (plutôt qu'un simple tableau) pour la
    MÊME raison que `VmInventory` : une marque pourra vouloir remonter, dans le même
    passage réseau, un état opérationnel supplémentaire (santé des AP…) sans casser le
    contrat de toutes les autres. La réconciliation ne consomme que `clients`. */
export interface WifiInventory {
  clients: WifiClientRecord[];
}

/** Résultat du test de joignabilité/compatibilité d'une instance (bouton « Tester »). */
export interface WifiProviderInfo {
  /** Le contrôleur répond et l'authentification passe. */
  ok: boolean;
  kind: string;
  /** Version remontée par le contrôleur, si l'API l'expose. null = indisponible. */
  version: string | null;
  /** L'API attendue par CET adaptateur répond bien (pour UniFi : l'API d'intégration
      versionnée `/v1/`). Hors gamme = AVERTISSEMENT, jamais un blocage — chaque
      adaptateur documente ce qu'il met derrière ce drapeau. */
  supported: boolean;
  /** Message lisible (erreur d'accès, site résolu, avertissement de version…). */
  message: string;
}

/** Options PROPRES à une marque, normalisées par la branche `kind` de
    `WifiProviderConfigValidate` (ex. UniFi : `site`, `include_wired`). Forme
    VOLONTAIREMENT ouverte et scalaire : c'est ce qui permet d'ajouter une marque
    SANS toucher au schéma de la base (la colonne `options` porte ce JSON) ni au
    reste du module — critère d'acceptation de D9. Un adaptateur lit SES options via
    un petit décodeur dédié (cf. `UnifiAdapter.optionsOf`) et ne suppose jamais la
    présence d'une option d'une AUTRE marque. */
export type WifiProviderOptions = Record<string, string | number | boolean>;

/** Configuration d'UNE instance d'adaptateur (un contrôleur) — stockée CÔTÉ SERVEUR
    (base chiffrée `wifi-providers.db`, cf. WifiProviderConfigDb) : les secrets ne
    transitent JAMAIS par le document (répliqué à tous les clients) ni par l'API de
    consultation.

    ⚠ ÉCART ASSUMÉ avec le patron VM (décision D3) : PAS de pool d'endpoints. Un
    cluster Proxmox répond sur CHAQUE nœud, ce qui donne son sens à la bascule ; un
    contrôleur wifi n'a qu'UNE console — un pool serait une complexité sans emploi.
    D'où une URL unique, une empreinte unique, et une table SQL unique. */
export interface WifiProviderConfig {
  /** Identifiant unique de l'instance (référencé par `WifiClientRecord.provider_id`). */
  id: string;
  /** Type d'adaptateur ("unifi" | futurs) — clé de la fabrique et de la validation d'options. */
  kind: string;
  /** URL de base de la console (ex. "https://unifi.example.lan"). */
  url: string;
  /** Jeton d'API (UniFi : clé statique envoyée en en-tête `X-API-KEY`). */
  token: string;
  /** Empreinte SHA-256 du certificat TLS à ÉPINGLER (consoles auto-signées fréquentes).
      null = pas d'épinglage (on retombe sur `ca_pem` puis sur les CA système). */
  fingerprint: string | null;
  /** Certificat CA (PEM) validant le certificat de la console — niveau 2 de la
      hiérarchie de confiance. PUBLIC (pas un secret) : peut circuler en lecture. */
  ca_pem: string | null;
  /** Période de synchro automatique en secondes. 0 = synchro MANUELLE uniquement. */
  interval_sec: number;
  /** Délai maximal d'UNE requête HTTP en secondes. */
  timeout_sec: number;
  /** Options propres à la marque (validées par la branche `kind`). */
  options: WifiProviderOptions;
}

/** Résumé d'UN provider SANS jeton — matière du STATUT (`GET /wifi/status`) et de l'UI.
    Volontairement RÉDUIT (ni jeton, ni URL, ni CA) : le jeton ne circule donc PAS dans
    le chemin STATUT, invariant repris tel quel du module VM (constat d'audit : le statut
    y déchiffrait TOUS les jetons à chaque poll — inutile, et matière sensible en transit). */
export interface WifiProviderSummary {
  id: string;
  kind: string;
  interval_sec: number;
}

/** SOURCE de configuration des providers vue par le moteur de synchro (`WifiSyncService`) —
    le strict minimum dont il a besoin, INDÉPENDAMMENT du support de stockage.
    Implémentation de production UNIQUE : `WifiProviderConfigDb` (base chiffrée) ; les tests
    injectent un stub minimal. Le moteur ne dépend QUE de ce contrat. */
export interface WifiProviderConfigSource {
  /** Providers configurés pour un document (jetons EN CLAIR, prêts pour l'adaptateur).
      Réservé à la SYNCHRO/au TEST. Document non configuré → `[]` (feature dormante). */
  providersFor(docId: string): WifiProviderConfig[];
  /** Résumés SANS jeton des providers d'un document — matière du STATUT et de l'UI.
      DOIT rafraîchir les erreurs de jeton (`tokenErrorsFor`) EXACTEMENT comme
      `providersFor` : c'est la PRÉCONDITION de la réinjection des providers au jeton
      indéchiffrable dans le statut (sans quoi ils disparaîtraient silencieusement de l'UI). */
  summariesFor(docId: string): WifiProviderSummary[];
  /** Documents ayant au moins un provider (armement des timers de synchro périodique). */
  configuredDocIds(): string[];
}

/** ADAPTATEUR d'inventaire de clients wifi — UNE implémentation par marque de contrôleur.
    Contrat volontairement minimal (lecture seule) : la synchro n'a besoin que de ça, et
    c'est ce qui rend une nouvelle marque bon marché (cf. D9 en tête de fichier). */
export interface WifiProviderAdapter {
  readonly kind: string;
  readonly config: WifiProviderConfig;
  /** Joignabilité + authentification + contrôle de l'API attendue. Ne doit JAMAIS jeter :
      toute erreur devient `ok: false` + message (SANS jamais citer le jeton). */
  test(): Promise<WifiProviderInfo>;
  /** Inventaire des clients CONNECTÉS au contrôleur (filtre filaire/sans-fil appliqué
      selon les options de la marque). Jette en cas d'échec de l'inventaire de MASSE :
      l'appelant (synchro) journalise et conserve l'état précédent du document. */
  inventory(): Promise<WifiInventory>;
}
