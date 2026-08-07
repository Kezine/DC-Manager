/* =============================================================================
   CONTRATS DU PONT « TRACKER DISTANT » — module `tracker/` AMOVIBLE
   (exigence de cadrage : la feature doit pouvoir être SUPPRIMÉE sans cicatrice).
   Règle de dépendance ABSOLUE : le cœur du serveur (api/db/documents/live)
   n'importe JAMAIS depuis `tracker/` — seul `index.ts` le câble.

   ── CE QUE CE MODULE FAIT, ET DANS QUEL SENS ─────────────────────────────────
   Il RÉPLIQUE les incidents/interventions de DC Manager dans un projet de
   tracker distant PARTAGÉ avec d'autres sources, et suit leur traitement en
   LECTURE SEULE. Le partage des vérités est la clé de voûte de tout le module :

     DCM → tracker : le CONTENU (titre, description, type, priorité, échéance,
                     labels `DCM-*`)                      → DC Manager fait foi
     tracker → DCM : le TRAITEMENT (statut, assigné)      → le tracker fait foi

   Deux conséquences qui traversent tout le dossier :
   - on n'écrase JAMAIS un label que DC Manager n'a pas posé (le projet est
     partagé — cf. `TrackerLabels` et les VERBES d'édition de `JiraAdapter`) ;
   - on ne SUPPRIME JAMAIS rien chez le tracker : une intervention supprimée
     localement laisse son ticket vivre sa vie (il sortira simplement de
     l'assiette du retour d'état).

   ── DÉPENDANCE INVERSÉE AVEC `interventions/` ────────────────────────────────
   `tracker/` n'importe RIEN de `interventions/`, et réciproquement : chacun doit
   rester amovible SEUL. Ce fichier déclare donc ICI, chez le consommateur, la
   surface qu'il attend du module interventions (`InterventionTrackerSource` et
   ses trois formes de ligne) ; le câblage concret se fait dans `index.ts` par
   TYPAGE STRUCTUREL — exactement le patron du pont `interventions → notify`.

   ── AGNOSTICISME DE MARQUE (exigence n°1 du chantier, reprise de D9 du wifi) ──
   Ce fichier est la FRONTIÈRE : tout ce qu'il déclare est indépendant de la
   marque du tracker. Atlassian Jira Cloud est la PREMIÈRE implémentation, pas la
   seule envisagée (GitHub, GitLab, Redmine, Jira Data Center…). Tout ce qui est
   propre à Jira (HTTP, chemins `/rest/api/3/…`, décodage des champs, ADF) vit
   DERRIÈRE l'adaptateur `kind: "jira"` (fichiers préfixés `Jira*`), résolu par la
   fabrique `TrackerSyncService.adapterFor`.
   ➜ AJOUTER UNE MARQUE = 1 adaptateur `XxxAdapter` + 1 entrée dans la fabrique
     + 1 branche d'options dans `TrackerProviderConfigValidate.KIND_OPTION_SPECS`
     + 1 option du `<select>` « Type » côté UI. RIEN d'autre à toucher (ni ce
     fichier, ni le service, ni la DB, ni les routes).

   ── ⚠ L'ASSIETTE EST INVERSÉE par rapport à `vm/` et `wifi/` ──────────────────
   Là-bas, la SOURCE énumère (`inventory()` rend tout l'inventaire) et le document
   suit. ICI, ce sont les INTERVENTIONS RÉPLIQUÉES qui énumèrent, et la source est
   interrogée SUR CES IDENTIFIANTS-LÀ. D'où `resolve(extIds)` au lieu
   d'`inventory()`, et un retour qui distingue les RÉSOLUS des INTROUVABLES : c'est
   le service qui en déduit « introuvable », jamais l'adaptateur.
   ============================================================================= */

/** Catégories d'état — ENSEMBLE FERMÉ, la SEULE base des pastilles, tris et filtres sémantiques,
    donc la seule chose qui rende l'abstraction multi-marques possible. Un tracker qui ne l'expose
    pas la DÉDUIT chez lui (c'est le travail de son adaptateur), jamais l'appelant.
    L'ORDRE est SÉMANTIQUE (à faire → en cours → terminé → inclassable) et sert de rang de tri. */
export const TRACKER_STATUS_CATEGORIES = ["todo", "in_progress", "done", "unknown"] as const;
export type TrackerStatusCategory = (typeof TRACKER_STATUS_CATEGORIES)[number];

/** Catégorie de repli : tout ce qui n'a pas su être classé. Membre à part entière de l'ensemble
    fermé — c'est ce qui rend la tolérance possible sans faire échouer une passe. */
export const TRACKER_STATUS_CATEGORY_FALLBACK: TrackerStatusCategory = "unknown";

/** ÉTAT d'UN ticket distant — le pivot du RETOUR D'ÉTAT (sens tracker → DCM), AGNOSTIQUE de la
    marque. VOLONTAIREMENT réduit à ce que DC Manager AFFICHE et à ce dont il a BESOIN : le tracker
    fait foi pour le TRAITEMENT, pas pour le contenu (que DCM lui a poussé et connaît déjà).
    Rapatrier summary/description/type d'ici serait pire qu'inutile : ça donnerait deux vérités
    concurrentes sur des champs dont DC Manager est la SOURCE. */
export interface TrackerTicketState {
  /** Identité STABLE côté tracker — clé de RÉCONCILIATION.
      🚨 C'est l'identifiant INTERNE du ticket, JAMAIS la clé lisible : une clé `INFRA-123` CHANGE
      quand le ticket est déplacé de projet (elle devient `OPS-45`). La prendre pour identité
      produirait au premier déplacement un DOUBLON plus un ORPHELIN, en silence. */
  ext_id: string;
  /** Clé LISIBLE du ticket (« INFRA-123 ») — champ d'AFFICHAGE re-synchronisé à chaque passe. C'est
      elle que le pont recopie dans le `jira_ref` de l'intervention, là où l'utilisateur la cherche. */
  key: string;
  /** Libellé BRUT du statut, affiché tel quel et JAMAIS traduit (les workflows sont configurables
      par projet : « En recette », « Attente client »…). */
  status: string;
  /** Classification FERMÉE du statut (cf. `TRACKER_STATUS_CATEGORIES`). */
  status_category: string;
  /** Personne assignée, sous forme AFFICHABLE (un nom, pas un identifiant de compte). */
  assignee: string | null;
  /** Lien CANONIQUE du ticket, composé UNE FOIS par l'adaptateur (jamais reconstruit depuis une
      variable d'environnement serveur). ⚠ Ce lien vise l'INTERFACE du tracker, pas son API. */
  url: string | null;
  /** Étiquettes COURANTES du ticket — au moins toutes celles que DC Manager gère (`DCM-*`).
      🚨 INDISPENSABLE au diff : c'est en comparant ce jeu au jeu DÉSIRÉ que le pont calcule les
      verbes `add`/`remove` et n'effleure JAMAIS les labels posés par les AUTRES sources du projet
      (risque n°1 du cadrage). Un adaptateur qui ne les rendrait pas ferait retomber le pont sur
      « ajouter ce qui manque, ne retirer jamais rien » — dégradé, mais jamais destructeur. */
  labels: string[];
}

/** Liste CANONIQUE des champs de l'état, sous forme EXPLOITABLE À L'EXÉCUTION (une `interface` TS
    est effacée à la compilation : sans cette liste, aucun test ne pourrait vérifier qu'un décodeur
    produit EXACTEMENT les champs du contrat). */
export const TRACKER_TICKET_STATE_FIELDS = [
  "ext_id", "key", "status", "status_category", "assignee", "url", "labels",
] as const;

/** Champ du pivot ABSENT de `TRACKER_TICKET_STATE_FIELDS` (`never` quand la liste est complète). */
type MissingStateField = Exclude<keyof TrackerTicketState, (typeof TRACKER_TICKET_STATE_FIELDS)[number]>;
/** Entrée de la liste qui n'est PAS un champ du pivot (`never` quand elle est juste). */
type ExtraStateField = Exclude<(typeof TRACKER_TICKET_STATE_FIELDS)[number], keyof TrackerTicketState>;

/** SONDE DE COMPLÉTUDE vérifiée À LA COMPILATION : ajouter (ou renommer) un champ de
    `TrackerTicketState` sans mettre la liste à jour rend le type conditionnel `never`, et `true`
    n'est pas assignable à `never` — `tsc` échoue AVANT que le test d'invariant n'ait à s'en
    apercevoir. EXPORTÉE (et non locale) pour deux raisons : `noUnusedLocals` refuserait une
    constante morte, et une sonde consultable documente elle-même l'invariant qu'elle garde. */
export const TRACKER_TICKET_STATE_FIELDS_ARE_EXHAUSTIVE: [MissingStateField, ExtraStateField] extends [never, never] ? true : never = true;

/** Résultat d'UNE résolution d'identifiants — l'écart structurant avec `vm/`/`wifi/` (cf. en-tête).
    Enveloppe (plutôt qu'un simple tableau) parce que la synchro a besoin des DEUX moitiés : ce qui a
    été retrouvé, et ce qui ne l'a PAS été. Sans cette distinction, l'appelant devrait re-déduire les
    absents en comparant des tableaux — exactement le calcul qu'on veut faire UNE fois, là où l'on
    sait ce qui a été demandé. */
export interface TrackerResolution {
  /** Tickets RÉSOLUS, dans un ordre non garanti. */
  found: TrackerTicketState[];
  /** Identifiants DEMANDÉS mais non résolus : ticket supprimé, projet archivé, permission perdue.
      ⚠ Ce n'est PAS un événement banal : le service en déduit « introuvable », l'UI l'affiche, et
      l'intervention locale n'est JAMAIS supprimée d'office — elle porte des liens, une description
      et un cycle de vie que le tracker ne connaît pas. */
  missing: string[];
}

/** NATURE de l'objet poussé, telle que le pont la voit. Les DEUX slugs sont RECOPIÉS ici plutôt
    qu'importés de `interventions/` : la dépendance inversée l'exige (cf. en-tête), et cette
    duplication d'un couple de littéraux est le prix — assumé et signalé des deux côtés — de
    l'amovibilité indépendante des deux modules. C'est l'adaptateur qui traduit ce slug en type de
    ticket de SA marque, d'après les OPTIONS du provider. */
export type TrackerPushKind = "incident" | "intervention";

/** CONTENU poussé vers le tracker (sens DCM → tracker) — composé par le service, JAMAIS par une
    route ni par un client : le projet de destination et les types de tickets viennent des OPTIONS du
    provider, l'utilisateur de DC Manager n'a pas à connaître la configuration du tracker. */
export interface TrackerPushContent {
  /** Titre du ticket (le `title` de l'intervention). */
  summary: string;
  /** Description en TEXTE BRUT côté DC Manager ; c'est l'adaptateur qui l'encode au format attendu
      par sa marque (Jira Cloud v3 : un document ADF, cf. `JiraParse.toAdf`). Le markdown SOURCE
      part tel quel, non interprété (v1 assumée — une conversion fidèle est un chantier en soi). */
  description: string;
  /** Nature de l'objet → type de ticket, via les options du provider. */
  kind: TrackerPushKind;
  /** Étiquettes `DCM-*` DÉSIRÉES, DÉJÀ normalisées et dédupliquées (cf. `TrackerLabels`).
      🚨 C'est un jeu DÉSIRÉ, pas un remplacement : l'adaptateur en dérive des verbes add/remove et
      ne touche jamais aux labels des autres sources du projet. */
  labels: string[];
  /** Priorité DC Manager (`low` | `normal` | `high` | `critical`), ou null quand elle est inconnue.
      La correspondance vers le vocabulaire de la marque appartient à l'adaptateur. */
  priority: string | null;
  /** Échéance au format `YYYY-MM-DD` (partie DATE de `planned_end`), ou null. */
  duedate: string | null;
}

/** PUITS de signalement d'un DÉGRADÉ — injecté par l'appelant (inversion de dépendance, patron des
    `ProblemReporter`/`ProfileSink` du dépôt). Un dégradé n'est PAS un échec : la poussée a réussi,
    mais amputée d'un champ que le projet refuse (typiquement la priorité, absente des projets
    team-managed). Le taire ferait croire à une réplication complète ; en faire une erreur ferait
    boucler une poussée qui, elle, a abouti. D'où un canal SÉPARÉ du retour de la méthode. */
export type TrackerDegradeSink = (message: string) => void;

/** Résultat du test de joignabilité/compatibilité d'une instance (bouton « Tester »). */
export interface TrackerProviderInfo {
  /** Le tracker répond et l'authentification passe. */
  ok: boolean;
  kind: string;
  /** Version remontée par le tracker, si son API l'expose. null = indisponible. */
  version: string | null;
  /** L'API attendue par CET adaptateur répond bien. Hors gamme = AVERTISSEMENT, jamais un blocage —
      chaque adaptateur documente ce qu'il met derrière ce drapeau. */
  supported: boolean;
  /** Message lisible (erreur d'accès, compte reconnu, avertissement d'API…). JAMAIS le jeton. */
  message: string;
}

/** Options PROPRES à une marque, normalisées par la branche `kind` de
    `TrackerProviderConfigValidate`. Forme VOLONTAIREMENT ouverte et scalaire : c'est ce qui permet
    d'ajouter une marque SANS toucher au schéma de la base (la colonne `options` porte ce JSON) ni au
    reste du module. Un adaptateur lit SES options via un petit décodeur dédié et ne suppose jamais
    la présence d'une option d'une AUTRE marque. */
export type TrackerProviderOptions = Record<string, string | number | boolean>;

/** Nom de l'option COMMUNE — bien que déclarée par chaque marque dans sa branche de
    `KIND_OPTION_SPECS` — qui autorise la réplication AUTOMATIQUE à l'enregistrement d'une
    intervention. Le service la lit par ce nom, sans jamais nommer de marque : une marque qui ne la
    déclare PAS est traitée comme « pas d'automatisme », jamais l'inverse (on ne crée pas chez un
    tiers sur une intention qu'il n'a pas exprimée). */
export const OPTION_AUTO_REPLICATE = "auto_replicate";

/** Configuration d'UNE instance d'adaptateur (un tracker) — stockée CÔTÉ SERVEUR (base chiffrée
    `tracker-providers.db`, cf. `TrackerProviderConfigDb`) : les secrets ne transitent JAMAIS par le
    document (répliqué à tous les clients) ni par l'API de consultation.

    ⚠ ÉCART ASSUMÉ avec `vm/` et `wifi/` : PAS de `fingerprint` ni de `ca_pem`. Ce matériel de
    confiance TLS existe là-bas parce que les consoles Proxmox/UniFi sont massivement en certificat
    AUTO-SIGNÉ — un tracker SaaS est un service public à certificat VALIDE, épinglé par personne.
    Ajouter ces deux colonnes « au cas où » demanderait à l'utilisateur de renseigner un matériel
    qui n'a pas d'emploi, et ferait croire que le transport de ce module sait s'en servir : il ne
    sait pas (cf. `JiraHttp`, bâti sur `fetch` et non sur `node:https`). Le jour où un tracker
    AUTO-HÉBERGÉ entre au périmètre, il arrive comme un adaptateur DISTINCT qui reprend le montage
    `trustOptions` chez lui — c'est précisément ce que l'abstraction garantit. */
export interface TrackerProviderConfig {
  /** Identifiant unique de l'instance (référencé par `interventions.tracker_provider_id`). */
  id: string;
  /** Type d'adaptateur — clé de la fabrique et de la validation d'options. */
  kind: string;
  /** URL de base de l'instance (ex. « https://exemple.atlassian.net »). https OBLIGATOIRE : le
      jeton voyage en en-tête d'autorisation à CHAQUE requête. */
  url: string;
  /** Jeton d'API du compte de service. SECRET : chiffré au repos, jamais relu par une lecture. */
  token: string;
  /** Identifiant du COMPTE de service côté tracker — la moitié PUBLIQUE du couple d'authentification
      (Jira Cloud s'authentifie en Basic `compte:jeton`, où `compte` est l'adresse e-mail Atlassian).
      N'est PAS un secret : il est relu et réaffiché à l'édition, contrairement au jeton. */
  account: string;
  /** Période de synchro automatique en secondes. 0 = synchro MANUELLE uniquement. */
  interval_sec: number;
  /** Délai maximal d'UNE requête HTTP en secondes. */
  timeout_sec: number;
  /** Options propres à la marque (validées par la branche `kind`). */
  options: TrackerProviderOptions;
}

/** Résumé d'UN provider SANS jeton — matière du STATUT et de l'UI. Volontairement RÉDUIT (ni jeton,
    ni URL, ni compte) : le jeton ne circule donc PAS dans le chemin STATUT, invariant repris tel
    quel des modules `vm/` et `wifi/` (constat d'audit : le statut VM déchiffrait TOUS les jetons à
    chaque poll — inutile, et matière sensible en transit). */
export interface TrackerProviderSummary {
  id: string;
  kind: string;
  interval_sec: number;
}

/** SOURCE de configuration des providers vue par le moteur de synchro — le strict minimum dont il a
    besoin, INDÉPENDAMMENT du support de stockage. Implémentation de production UNIQUE :
    `TrackerProviderConfigDb` (base chiffrée) ; les tests injectent un stub minimal. */
export interface TrackerProviderConfigSource {
  /** Providers configurés pour un document (jetons EN CLAIR, prêts pour l'adaptateur). Réservé à la
      SYNCHRO/au TEST. Document non configuré → `[]` (feature dormante). */
  providersFor(docId: string): TrackerProviderConfig[];
  /** Résumés SANS jeton des providers d'un document — matière du STATUT et de l'UI. DOIT rafraîchir
      les erreurs de jeton EXACTEMENT comme `providersFor` : c'est la PRÉCONDITION de la réinjection
      des providers au jeton indéchiffrable dans le statut (sans quoi ils disparaîtraient
      silencieusement de l'UI). */
  summariesFor(docId: string): TrackerProviderSummary[];
  /** Documents ayant au moins un provider (armement des timers de synchro périodique). */
  configuredDocIds(): string[];
}

/** ADAPTATEUR de tracker — UNE implémentation par marque. Contrat volontairement MINIMAL : le pont
    n'a besoin que de ça, et c'est ce qui rend une nouvelle marque bon marché (cf. l'en-tête). */
export interface TrackerProviderAdapter {
  readonly kind: string;
  readonly config: TrackerProviderConfig;
  /** Joignabilité + authentification + contrôle de l'API attendue. Ne doit JAMAIS jeter : toute
      erreur devient `ok: false` + message (SANS jamais citer le jeton). */
  test(): Promise<TrackerProviderInfo>;
  /** Résout l'état COURANT des tickets DÉSIGNÉS (cf. l'assiette inversée en tête de fichier).
      IMPÉRATIF de mise en œuvre : résoudre PAR LOTS — un tracker sait résoudre N identifiants en
      une requête ; N requêtes unitaires font la différence entre une passe à 3 appels et une passe
      à 300. Jette en cas d'échec de la RÉSOLUTION elle-même (réseau, auth, débit) : l'appelant
      journalise et conserve l'état précédent. Un ticket simplement introuvable n'est PAS un échec :
      il ressort dans `missing`. */
  resolve(extIds: string[]): Promise<TrackerResolution>;
  /** Résout UNE référence saisie par l'utilisateur — clé lisible du ticket OU URL collée depuis le
      navigateur. Sert la LIAISON d'un ticket EXISTANT à une intervention (adoption d'un `jira_ref`
      saisi à la main), et la relecture des labels COURANTS avant une mise à jour. Rend `null` si le
      ticket n'existe pas, n'est pas accessible, ou si la référence n'est pas exploitable : l'appelant
      en fait un refus ACTIONNABLE, et rien n'est persisté (on n'adopte pas un ticket fantôme).
      ⚠ L'état rendu porte l'identifiant INTERNE en `ext_id`, jamais la clé saisie. */
  lookup(reference: string): Promise<TrackerTicketState | null>;
  /** CRÉE un ticket chez le tracker et rend son état. Le projet et les types viennent des OPTIONS du
      provider. ⚠ En cas de REFUS du tracker (champ personnalisé obligatoire, projet inconnu,
      droits), le message d'origine doit remonter TEL QUEL : c'est lui qui est actionnable
      (« le champ X est requis »), une enveloppe générique le rendrait inexploitable. */
  createIssue(content: TrackerPushContent, onDegraded?: TrackerDegradeSink): Promise<TrackerTicketState>;
  /** MET À JOUR le contenu d'un ticket déjà répliqué.
      🚨 Les LABELS passent par des VERBES d'édition (`labelsAdd`/`labelsRemove`) et JAMAIS par un
      remplacement du tableau : le projet est PARTAGÉ avec d'autres sources, dont les labels ne
      doivent jamais être touchés (risque n°1 du cadrage). C'est l'appelant qui calcule le diff
      (`TrackerLabels.diff`) — l'adaptateur se contente de le TRANSMETTRE dans la grammaire de sa
      marque, ce qui évite au passage toute course lecture-modification-écriture.
      Ne rend RIEN : l'état du ticket (statut, assigné) n'est pas modifié par une poussée de contenu,
      il vient du RETOUR D'ÉTAT — deux vérités, deux chemins. */
  updateIssue(extId: string, content: TrackerPushContent, labelsAdd: string[], labelsRemove: string[], onDegraded?: TrackerDegradeSink): Promise<void>;
}

/* =============================================================================
   SURFACE ATTENDUE DU MODULE `interventions/` — DÉPENDANCE INVERSÉE.
   Déclarée ICI, chez le CONSOMMATEUR : `tracker/` n'importe rien de
   `interventions/`, et `index.ts` fait correspondre les deux par typage
   STRUCTUREL. Les formes ci-dessous sont donc des MIROIRS commentés de ce que
   rend `InterventionsDb` — duplication ASSUMÉE et signalée des deux côtés, au
   prix exact de l'amovibilité indépendante des deux features (même arbitrage que
   `InterventionProblemReporter` chez le veilleur de rappels).
   ============================================================================= */

/** ÉTATS de poussée persistés (colonne `tracker_push_state`). `null` = jamais poussée.
    ⚠ `error` est un état STABLE, pas une rafale : il est retenté à la passe périodique et par
    l'action manuelle, jamais en boucle immédiate (risque n°3 du cadrage). */
export const TRACKER_PUSH_STATES = ["synced", "pending", "error"] as const;
export type TrackerPushState = (typeof TRACKER_PUSH_STATES)[number];

/** Ligne d'ASSIETTE du retour d'état : une intervention RÉPLIQUÉE (identité distante non nulle). */
export interface TrackedIntervention {
  id: string;
  /** Clé LISIBLE actuellement affichée — comparée à celle que rend le tracker : une clé CHANGE au
      déplacement de projet, et c'est elle que l'utilisateur lit sur la fiche. */
  jira_ref: string | null;
  tracker_provider_id: string | null;
  tracker_ext_id: string | null;
  tracker_status: string | null;
  tracker_status_category: string | null;
  tracker_assignee: string | null;
  tracker_url: string | null;
  tracker_last_sync: string | null;
}

/** Ligne d'une poussée DUE (`tracker_push_state` ∈ pending | error). Porte son `doc_id` : le
    ramassage au démarrage balaye TOUS les documents (une poussée due survit à un redémarrage). */
export interface PendingPush {
  doc_id: string;
  id: string;
  tracker_provider_id: string | null;
  tracker_ext_id: string | null;
  tracker_push_state: string | null;
}

/** Intervention relue AU MOMENT DE POUSSER (dernier état gagne — risque n°4 du cadrage). Miroir
    RÉDUIT de `InterventionRecord` : seuls les champs qui composent le contenu poussé et l'état de
    réplication. Le `status` DC Manager n'y figure PAS, et c'est délibéré : il n'est JAMAIS poussé
    (les deux workflows sont indépendants — décision E3). */
export interface InterventionForPush {
  id: string;
  kind: string;
  title: string;
  description: string;
  priority: string;
  planned_end: string | null;
  jira_ref: string | null;
  links: Array<{ target_kind: string; target_id: string }>;
  tracker_provider_id: string | null;
  tracker_ext_id: string | null;
  tracker_push_state: string | null;
}

/** Écriture PARTIELLE de l'état de suivi. Toutes les clés sont OPTIONNELLES : une passe idempotente
    n'écrit que ce qui a CHANGÉ.
    🚨 Aucun champ d'AUDIT ici, et c'est structurel : le retour d'état n'est pas une édition de
    l'utilisateur — écrire `updated_by`/`updated_date` ferait apparaître le serveur comme dernier
    éditeur de chaque intervention répliquée, et ferait remonter en tête d'un listing trié par
    activité des objets que personne n'a touchés. */
export interface TrackerStatePatch {
  tracker_provider_id?: string | null;
  tracker_ext_id?: string | null;
  tracker_status?: string | null;
  tracker_status_category?: string | null;
  tracker_assignee?: string | null;
  tracker_url?: string | null;
  tracker_last_sync?: string | null;
  tracker_push_state?: string | null;
  tracker_push_error?: string | null;
  /** ⚠ SEULE colonne HORS `tracker_*` que le pont écrit : la clé LISIBLE du ticket créé/lié. Elle
      va là où l'utilisateur la cherche DÉJÀ (le champ « réf. Jira » de la fiche), ce qui fait
      marcher le lien `JIRA_BASE_URL` existant sans une ligne de code de plus. */
  jira_ref?: string | null;
}

/** Ce que le pont EXIGE du module interventions — quatre méthodes, pas une de plus. */
export interface InterventionTrackerSource {
  /** L'ASSIETTE : interventions RÉPLIQUÉES d'un document (`tracker_ext_id` non nul). */
  listTracked(docId: string): TrackedIntervention[];
  /** Les poussées DUES. `docId` absent = TOUS les documents (ramassage au démarrage). */
  listPushDue(docId?: string): PendingPush[];
  /** Une intervention précise (réplication manuelle, poussée) — null si inconnue/supprimée. */
  getOne(docId: string, id: string): InterventionForPush | null;
  /** Écrit l'état de suivi SANS toucher à l'audit. `false` si l'intervention n'existe plus. */
  applyTrackerState(docId: string, id: string, patch: TrackerStatePatch): boolean;
}
