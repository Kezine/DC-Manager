/* =============================================================================
   CONTRAT D'ADAPTATEUR DE « REMOTE ISSUE TRACKER » — module `issues/` AMOVIBLE
   (exigence de cadrage : la feature doit pouvoir être SUPPRIMÉE sans cicatrice).
   Règle de dépendance ABSOLUE : le cœur du serveur (api/db/documents/live)
   n'importe JAMAIS depuis `issues/` — seul `issues/` dépend du cœur, et son
   montage se fera par UN point de branchement fin dans `index.ts` (lot L3).

   ── AGNOSTICISME DE MARQUE (exigence n°1 du chantier, reprise de D9 du wifi) ───
   Ce fichier est la FRONTIÈRE : tout ce qu'il déclare est indépendant de la marque
   du tracker. Atlassian Jira Cloud est la PREMIÈRE implémentation, pas la seule
   envisagée (GitHub, GitLab, Redmine, Jira Data Center…). Le pivot `IssueRecord`,
   le contrat `IssueProviderAdapter`, la validation COMMUNE, le stockage de config
   (`IssueProviderConfigDb`), puis la réconciliation, le service et les routes
   (lot L3) et l'UI (lot L4) ne connaissent QUE ce contrat.
   Tout ce qui est propre à Jira (HTTP, chemins `/rest/api/3/…`, décodage des
   champs, ADF) vit DERRIÈRE l'adaptateur `kind: "jira"` (fichiers préfixés
   `Jira*`), résolu par la fabrique du service de synchro.
   ➜ AJOUTER UNE MARQUE = 1 adaptateur `XxxAdapter` + 1 entrée dans la fabrique
     + 1 branche d'options dans `IssueProviderConfigValidate.KIND_OPTION_SPECS`
     + 1 option du `<select>` « Type » côté UI. RIEN d'autre à toucher (ni ce
     fichier, ni le service, ni la réconciliation, ni la DB, ni les routes).
     Procédure détaillée : `docs/issue-tracker.md` (lot L6) § « Ajouter un
     provider d'une autre marque ».

   ── ⚠ L'ASSIETTE EST INVERSÉE par rapport à `vm/` et `wifi/` ──────────────────
   Là-bas, la SOURCE énumère (`inventory()` rend tout l'inventaire) et le document
   suit. ICI, c'est le DOCUMENT qui énumère — les tickets SUIVIS — et la source est
   interrogée SUR CES IDENTIFIANTS-LÀ. D'où `resolve(extIds)` au lieu
   d'`inventory()`, et un retour qui distingue les RÉSOLUS des INTROUVABLES : c'est
   le service (L3) qui en déduit `orphan`, jamais l'adaptateur. Recopier
   `WifiReconcile` tel quel créerait des enregistrements pour des tickets que
   personne n'a demandé de suivre — la feature serait fausse.
   ============================================================================= */

/** Inventaire NORMALISÉ d'UN ticket — le contrat pivot, AGNOSTIQUE du tracker.
    Ses champs sont EXACTEMENT les champs SOURCE de l'entité `issues` du document, déclarés une
    seule fois en partagé (`src-shared/IssueSync.ts`, `ISSUE_SOURCE_FIELDS`) : un test d'invariant
    compare les deux listes, parce qu'une dérive entre le pivot serveur et la frontière partagée
    ne se verrait qu'EN PRODUCTION (champ jamais rafraîchi, ou champ écrasé par erreur).

    ⚠ AUTORITÉ des champs : l'adaptateur RENSEIGNE tout ce qu'il OBSERVE, mais deux champs
    appartiennent au SERVICE et sont ré-estampillés par lui à l'écriture —
    - `orphan` : l'adaptateur le pose à `false` sur tout ticket qu'il a RÉSOLU (c'est un constat,
      pas une décision) ; le marquage à `true` se déduit des `missing` d'une passe, ce qu'un
      adaptateur ne voit pas (il ignore ce que le document suit) ;
    - `last_sync` : horodatage de la passe, laissé `""` par l'adaptateur. UNE passe doit porter UN
      seul horodatage pour tous ses tickets, ce qu'un adaptateur qui ne voit qu'un LOT ne peut pas
      garantir (même partage des rôles que `provider_id` chez `UnifiParse`, laissé au décodeur pur).

    TOLÉRANCE : toute valeur inconnue du tracker est `null` (jamais devinée) et toute valeur libre
    (`status`, `issue_type`, `priority`, `resolution`) est conservée TELLE QUELLE — le pivot isole
    le reste de l'application des évolutions d'API et des différences entre marques. */
export interface IssueRecord {
  /** Identité STABLE côté tracker — clé de RÉCONCILIATION.
      🚨 C'est l'identifiant INTERNE du ticket, JAMAIS la clé lisible : une clé `INFRA-123` CHANGE
      quand le ticket est déplacé de projet (elle devient `OPS-45`). La prendre pour identité
      produirait au premier déplacement un DOUBLON plus un ORPHELIN, en silence. */
  ext_id: string;
  /** Instance d'adaptateur d'origine (`IssueProviderConfig.id`) — multi-trackers par document.
      ESTAMPILLÉ par l'adaptateur (le décodeur pur, lui, l'ignore). */
  provider_id: string;
  /** Clé LISIBLE du ticket (« INFRA-123 ») — champ d'AFFICHAGE re-synchronisé à chaque passe. */
  key: string;
  /** Titre du ticket. "" toléré. */
  summary: string;
  /** Libellé BRUT du statut, affiché tel quel et JAMAIS traduit (les workflows sont configurables
      par projet : « En recette », « Attente client »…). */
  status: string;
  /** Classification FERMÉE du statut (`ISSUE_STATUS_CATEGORIES` du partagé) — la seule base des
      couleurs, tris et filtres sémantiques, donc la seule chose qui rend l'abstraction possible.
      C'est l'ADAPTATEUR qui la produit : une marque qui ne l'expose pas la déduit chez elle. */
  status_category: string;
  /** Type de ticket (Bug / Tâche / …) — libellé brut, tolérant. */
  issue_type: string;
  /** Priorité (libellé brut) — `null` quand le tracker n'en expose pas. */
  priority: string | null;
  /** Personne assignée, sous forme AFFICHABLE (un nom, pas un identifiant de compte). */
  assignee: string | null;
  /** Auteur du ticket, sous forme AFFICHABLE. */
  reporter: string | null;
  /** Étiquettes du ticket. La normalisation DÉTERMINISTE (tri/dédup) est faite par la frontière
      partagée, pas ici : l'adaptateur rend ce qu'il a lu. */
  labels: string[];
  /** Libellé de résolution — `null` tant que le ticket est ouvert. */
  resolution: string | null;
  /** Horodatage ISO de création CÔTÉ TRACKER. */
  created_src: string | null;
  /** Horodatage ISO de dernière modification CÔTÉ TRACKER. */
  updated_src: string | null;
  /** Lien CANONIQUE du ticket, composé UNE FOIS par l'adaptateur (jamais reconstruit depuis une
      variable d'environnement serveur) : c'est ce qui rend la feature utile en MODE FICHIER et le
      multi-instances natif. ⚠ Ce lien vise l'INTERFACE du tracker, pas son API. */
  url: string | null;
  /** Ticket NON RÉSOLU à la dernière passe. Posé `false` par l'adaptateur (cf. l'AUTORITÉ des
      champs ci-dessus) ; c'est le service qui lève le drapeau à partir des `missing`. */
  orphan: boolean;
  /** Horodatage ISO de la passe — laissé `""` par l'adaptateur, posé par le service. */
  last_sync: string;
}

/** Liste CANONIQUE des champs du pivot, sous forme EXPLOITABLE À L'EXÉCUTION (une `interface` TS
    est effacée à la compilation : sans cette liste, aucun test ne pourrait comparer le pivot à la
    frontière partagée `ISSUE_SOURCE_FIELDS`). Ordre identique à celui du partagé, pour que la
    comparaison de test soit une égalité STRICTE et non un jeu d'ensembles. */
export const ISSUE_RECORD_FIELDS = [
  "ext_id", "provider_id", "key", "summary", "status", "status_category", "issue_type",
  "priority", "assignee", "reporter", "labels", "resolution", "created_src", "updated_src",
  "url", "orphan", "last_sync",
] as const;

/** Champ du pivot ABSENT de `ISSUE_RECORD_FIELDS` (`never` quand la liste est complète). */
type MissingPivotField = Exclude<keyof IssueRecord, (typeof ISSUE_RECORD_FIELDS)[number]>;
/** Entrée de `ISSUE_RECORD_FIELDS` qui n'est PAS un champ du pivot (`never` quand elle est juste). */
type ExtraPivotField = Exclude<(typeof ISSUE_RECORD_FIELDS)[number], keyof IssueRecord>;

/** SONDE DE COMPLÉTUDE vérifiée À LA COMPILATION : ajouter (ou renommer) un champ d'`IssueRecord`
    sans mettre `ISSUE_RECORD_FIELDS` à jour rend le type conditionnel `never`, et `true` n'est pas
    assignable à `never` — `tsc` échoue AVANT que le test d'invariant n'ait à s'en apercevoir.
    EXPORTÉE (et non locale) pour deux raisons : `noUnusedLocals` refuserait une constante morte, et
    une sonde consultable documente elle-même l'invariant qu'elle garde. */
export const ISSUE_RECORD_FIELDS_ARE_EXHAUSTIVE: [MissingPivotField, ExtraPivotField] extends [never, never] ? true : never = true;

/** Résultat d'UNE résolution d'identifiants — l'écart structurant avec `vm/`/`wifi/` (cf. en-tête).
    Enveloppe (plutôt qu'un simple tableau) parce que la synchro a besoin des DEUX moitiés :
    ce qui a été retrouvé, et ce qui ne l'a PAS été. Sans cette distinction, l'appelant devrait
    re-déduire les absents en comparant des tableaux — exactement le calcul qu'on veut faire UNE
    fois, là où l'on sait ce qui a été demandé. */
export interface IssueResolution {
  /** Tickets RÉSOLUS, dans un ordre non garanti. */
  found: IssueRecord[];
  /** Identifiants DEMANDÉS mais non résolus : ticket supprimé, projet archivé, permission perdue.
      ⚠ Ce n'est PAS un événement banal (contrairement au « déconnecté » du wifi) : le service en
      déduit `orphan`, l'UI affiche « introuvable », et l'enregistrement local n'est JAMAIS supprimé
      d'office — il porte des notes et des liens que le tracker ne connaît pas. */
  missing: string[];
}

/** Matière d'une CRÉATION de ticket depuis DC Manager. VOLONTAIREMENT minimale : le PROJET et le
    TYPE de ticket viennent des OPTIONS du provider, pas de l'appelant — l'utilisateur de DC Manager
    n'a pas à connaître la configuration du tracker pour ouvrir un ticket. */
export interface IssueCreateInput {
  /** Titre du ticket. */
  summary: string;
  /** Description en TEXTE BRUT côté DC Manager ; c'est l'adaptateur qui l'encode au format attendu
      par sa marque (Jira Cloud v3 : un document ADF, cf. `JiraParse.toAdf`). */
  description: string;
}

/** Résultat du test de joignabilité/compatibilité d'une instance (bouton « Tester »). */
export interface IssueProviderInfo {
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
    `IssueProviderConfigValidate` (ex. Jira : `project_key`, `issue_type`). Forme VOLONTAIREMENT
    ouverte et scalaire : c'est ce qui permet d'ajouter une marque SANS toucher au schéma de la base
    (la colonne `options` porte ce JSON) ni au reste du module. Un adaptateur lit SES options via un
    petit décodeur dédié et ne suppose jamais la présence d'une option d'une AUTRE marque. */
export type IssueProviderOptions = Record<string, string | number | boolean>;

/** Configuration d'UNE instance d'adaptateur (un tracker) — stockée CÔTÉ SERVEUR (base chiffrée
    `issue-providers.db`, cf. `IssueProviderConfigDb`) : les secrets ne transitent JAMAIS par le
    document (répliqué à tous les clients) ni par l'API de consultation.

    ⚠ ÉCART ASSUMÉ avec `vm/` et `wifi/` : PAS de `fingerprint` ni de `ca_pem`. Ce matériel de
    confiance TLS existe là-bas parce que les consoles Proxmox/UniFi sont massivement en certificat
    AUTO-SIGNÉ — un tracker SaaS est un service public à certificat VALIDE, épinglé par personne.
    Ajouter ces deux colonnes « au cas où » demanderait à l'utilisateur de renseigner un matériel
    qui n'a pas d'emploi, et ferait croire que le transport de ce module sait s'en servir : il ne
    sait pas (cf. `JiraHttp`, bâti sur `fetch` et non sur `node:https`). Le jour où un tracker
    AUTO-HÉBERGÉ entre au périmètre, il arrive comme un adaptateur DISTINCT qui reprend le montage
    `trustOptions` chez lui — c'est précisément ce que l'abstraction garantit. */
export interface IssueProviderConfig {
  /** Identifiant unique de l'instance (référencé par `IssueRecord.provider_id`). */
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
  options: IssueProviderOptions;
}

/** Résumé d'UN provider SANS jeton — matière du STATUT et de l'UI. Volontairement RÉDUIT (ni jeton,
    ni URL, ni compte) : le jeton ne circule donc PAS dans le chemin STATUT, invariant repris tel
    quel des modules `vm/` et `wifi/` (constat d'audit : le statut VM déchiffrait TOUS les jetons à
    chaque poll — inutile, et matière sensible en transit). */
export interface IssueProviderSummary {
  id: string;
  kind: string;
  interval_sec: number;
}

/** SOURCE de configuration des providers vue par le moteur de synchro (lot L3) — le strict minimum
    dont il a besoin, INDÉPENDAMMENT du support de stockage. Implémentation de production UNIQUE :
    `IssueProviderConfigDb` (base chiffrée) ; les tests injectent un stub minimal. */
export interface IssueProviderConfigSource {
  /** Providers configurés pour un document (jetons EN CLAIR, prêts pour l'adaptateur). Réservé à la
      SYNCHRO/au TEST. Document non configuré → `[]` (feature dormante). */
  providersFor(docId: string): IssueProviderConfig[];
  /** Résumés SANS jeton des providers d'un document — matière du STATUT et de l'UI. DOIT rafraîchir
      les erreurs de jeton EXACTEMENT comme `providersFor` : c'est la PRÉCONDITION de la réinjection
      des providers au jeton indéchiffrable dans le statut (sans quoi ils disparaîtraient
      silencieusement de l'UI). */
  summariesFor(docId: string): IssueProviderSummary[];
  /** Documents ayant au moins un provider (armement des timers de synchro périodique). */
  configuredDocIds(): string[];
}

/** ADAPTATEUR de tracker — UNE implémentation par marque. Contrat volontairement MINIMAL : la
    synchro et les deux portes d'entrée de l'assiette n'ont besoin que de ça, et c'est ce qui rend
    une nouvelle marque bon marché (cf. l'en-tête). */
export interface IssueProviderAdapter {
  readonly kind: string;
  readonly config: IssueProviderConfig;
  /** Joignabilité + authentification + contrôle de l'API attendue. Ne doit JAMAIS jeter : toute
      erreur devient `ok: false` + message (SANS jamais citer le jeton). */
  test(): Promise<IssueProviderInfo>;
  /** Résout l'état COURANT des tickets DÉSIGNÉS (cf. l'assiette inversée en tête de fichier).
      IMPÉRATIF de mise en œuvre : résoudre PAR LOTS — un tracker sait résoudre N identifiants en
      une requête ; N requêtes unitaires font la différence entre une passe à 3 appels et une passe
      à 300. Jette en cas d'échec de la RÉSOLUTION elle-même (réseau, auth, débit) : l'appelant
      journalise et conserve l'état précédent du document. Un ticket simplement introuvable n'est
      PAS un échec : il ressort dans `missing`. */
  resolve(extIds: string[]): Promise<IssueResolution>;
  /** Résout UNE référence saisie par l'utilisateur — clé lisible du ticket OU URL collée depuis le
      navigateur — pour la porte d'entrée « Suivre un ticket ». Rend `null` si le ticket n'existe
      pas, n'est pas accessible, ou si la référence n'est pas exploitable : l'appelant en fait un
      refus ACTIONNABLE, et rien n'est persisté (on n'enregistre pas un ticket fantôme).
      ⚠ Le record rendu porte l'identifiant INTERNE en `ext_id`, jamais la clé saisie. */
  lookup(reference: string): Promise<IssueRecord | null>;
  /** CRÉE un ticket chez le tracker et rend son pivot. Le projet et le type viennent des OPTIONS du
      provider. ⚠ En cas de REFUS du tracker (champ personnalisé obligatoire, projet inconnu,
      droits), le message d'origine doit remonter TEL QUEL : c'est lui qui est actionnable
      (« le champ X est requis »), une enveloppe générique le rendrait inexploitable. */
  createIssue(input: IssueCreateInput): Promise<IssueRecord>;
}
