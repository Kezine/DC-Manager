# TICKETS d'un tracker distant — collection miroir à assiette PILOTÉE PAR L'UTILISATEUR

> Module serveur **AMOVIBLE** `src-server/src/issues/`, collection partagée `issues`,
> onglet client « Tickets ». Première implémentation : **Atlassian Jira Cloud** — mais
> **la marque n'est qu'un adaptateur** : le pivot, la réconciliation, le service, la base
> de config, les routes et l'UI en sont agnostiques (cf. § « Ajouter un provider d'une
> autre marque »).

## Vue d'ensemble

DC Manager sait déjà ce qu'il y a dans le datacenter. Cette feature répond à la question
voisine : **quels tickets parlent de cet équipement, de cette VM, de ce spare**. Un
service serveur interroge périodiquement (ou à la demande) un tracker de tickets,
normalise ce qu'il en tire dans un pivot agnostique de la marque, et RAFRAÎCHIT la
collection `issues` du document.

Ce que la feature fait :

- **suit** les tickets que l'utilisateur a choisis, un par un — par « Suivre un ticket »
  (le ticket existe déjà chez le tracker) ou par « Ouvrir un ticket » (DC Manager le CRÉE
  chez le tracker, puis l'enregistre) ;
- **rafraîchit** leurs champs source à chaque passe (clé, titre, statut, type, priorité,
  assigné, étiquettes, résolution, horodatages du tracker, lien) ;
- **rattache** chaque ticket à des objets du modèle (`targets`), à la main, et rend ce
  rattachement filtrable dans les listings et lisible dans les fiches ;
- conserve les tickets qu'il ne résout plus en les marquant **« introuvables »** — jamais
  de suppression ;
- laisse l'utilisateur enrichir chaque ticket (`description`, `notes`, `targets`) sans que
  la synchro ne l'écrase jamais.

Ce qu'elle ne fait **pas** : aucun **commentaire** (ni lecture ni écriture) · aucune
**transition de statut** ni écriture d'un champ après création · aucune **description
distante** rapatriée (le lien ouvre le ticket ; on ne recopie pas ce que le tracker affiche
mieux que nous) · aucune **pièce jointe** · aucun **rattachement DÉRIVÉ** d'un label ou d'un
champ personnalisé (le rattachement est saisi — donc **aucune convention n'est imposée** aux
utilisateurs du tracker) · aucune **découverte** de tickets par JQL d'assiette (un provider
ne propose pas « tous les tickets du projet ») · aucun **pont avec `interventions/`** (les
deux modules cohabitent sans se connaître, cf. § « Suppression de la feature ») · aucun
**webhook entrant** (la synchro reste en *pull*) · aucun adaptateur **Jira Data Center**.

## 🚨 L'ASSIETTE EST INVERSÉE par rapport à `vm/` et `wifi/`

C'est **le** point d'architecture du module, et le piège n°1 pour un contributeur qui
arrive en connaissant les deux autres modules de synchro. Recopier `WifiReconcile` à
l'identique peuplerait le document de tickets que personne n'a demandés : la feature
serait fausse, et son assiette vidée de sens.

| | `vm/` et `wifi/` | `issues/` |
|---|---|---|
| Qui **ÉNUMÈRE** | la **source** (le cluster, la console) | le **DOCUMENT** (les tickets suivis) |
| Qui **SUIT** | le document | la source (elle est interrogée sur des identifiants) |
| Contrat d'adaptateur | `inventory()` → tout l'inventaire | **`resolve(extIds)`** → l'état de CES tickets |
| La synchro CRÉE-t-elle des enregistrements ? | **oui** (tout ce qui apparaît) | **jamais** |
| `orphan` veut dire | disparu de la source (VM détruite, client déconnecté) | **ticket introuvable ou inaccessible** |

Conséquences portées par tout le module :

- `IssueReconcile.plan` rend `{ updates, orphans, unchanged, untracked }` et **n'a pas de
  `creates`** — ce n'est pas un oubli, c'est l'invariant. Un ticket rendu par la source
  sans être suivi est compté dans `untracked` (observabilité : un adaptateur qui répond à
  côté de la demande se voit dans les journaux) et **ignoré** ;
- les **deux seules portes d'entrée** de l'assiette sont des ACTES utilisateur, et elles
  vivent dans le service : `IssueSyncService.followReference` et `IssueSyncService.openIssue` ;
- une assiette **vide** n'appelle même pas le tracker — il n'y a rien à demander ;
- le volume n'est pas borné par la source mais par l'utilisateur, d'où le **plafond de
  passe** (`IssueSyncService.MAX_ISSUES_PER_PASS = 500`) et son **roulement** (cf. § « Le
  plafond de passe ») ;
- la résolution se fait **par LOTS** (`JiraAdapter.BATCH_SIZE = 100`), jamais un ticket à
  la fois : c'est la différence entre une passe à 5 requêtes et une passe à 500.

> `orphan` n'est **pas** ici un événement banal (contrairement au wifi, où « déconnecté »
> est quotidien) : un ticket suivi qui devient introuvable signale une **suppression**, un
> **projet archivé** ou une **permission perdue**. D'où le libellé UI « **introuvable** »,
> une couleur d'**avertissement**, et **aucune suppression automatique** de l'enregistrement
> local — il porte des notes et des liens que le tracker ne connaît pas.

## Architecture — qui fait quoi

### Serveur (`src-server/src/issues/` — le cœur n'importe JAMAIS ce dossier)

| Fichier | Rôle |
|---|---|
| `IssueProvider.ts` | **Contrats purs** : pivot `IssueRecord` (+ `ISSUE_RECORD_FIELDS` et sa sonde de complétude vérifiée à la compilation), `IssueResolution`, `IssueCreateInput`, `IssueProviderConfig`/`Summary`/`Info`/`ConfigSource`, `IssueProviderAdapter` (`test` / `resolve` / `lookup` / `createIssue`). **La frontière d'agnosticisme.** |
| `IssueProviderConfigValidate.ts` | Validation PURE : champs **communs** + **branche d'options par `kind`** (`KIND_OPTION_SPECS`). Point d'extension « marque » n°1. Porte `IssueProviderConfigError` (liste de griefs → 400). |
| `IssueProviderConfigDb.ts` | Stockage `issue-providers.db` (SQLite dédiée, **table unique** `issue_providers`), jetons **chiffrés** (`SecretBox`), deux surfaces de lecture (synchro / CRUD UI), `mapDecryptable`. |
| `IssueReconcile.ts` | Réconciliation **PURE** — ⚠ variante **INVERSÉE** : `{ updates, orphans, unchanged, untracked }`, **jamais de creates**. Porte aussi `sourceOf` (pivot → champs source normalisés), matière des deux portes d'entrée. |
| `IssueSyncService.ts` | Boucle : timers, anti-chevauchement, anti-rafale, plafond + roulement (`passScope`), statut mémoire, validation partagée, triptyque `markChanged`→`transact`→`live.publish`, signalement `ProblemReporter`. Porte la **fabrique `adapterFor(kind)`** (point d'extension n°2) et les deux portes d'entrée `followReference` / `openIssue`. |
| `IssueModule.ts` | Façade + routes Express `/documents/:docId/issues/*`, 503 actionnables, audit `RequestAuthor`. |
| `JiraHttp.ts` | **Jira** : `fetch` **injecté** + `AbortSignal.timeout`, auth Basic, gestion du 429 (`Retry-After` borné), plafond de réponse, erreurs traduites actionnables, extraction du message d'erreur du tracker. |
| `JiraParse.ts` | **Jira** : décodage **PUR et TOLÉRANT** (alias de champs, catégorie d'état, personnes, dates), pagination pure aux **deux** formes d'API, composition du lien d'interface, référence saisie → id/clé, liste JQL échappée, **ADF**. |
| `JiraAdapter.ts` | **Jira** : orchestration (chemins d'API, découpage en lots, pagination, création, test) — déclare son besoin HTTP par l'interface consommateur `JiraJsonClient`. |

Branchement : **une** ligne d'import + `create`/`extension()`/`start()`/`stop()` dans
`src-server/src/index.ts`. Rien d'autre du cœur ne connaît la feature.

### Partagé (`src-shared/`)

| Fichier | Rôle |
|---|---|
| `IssueSync.ts` | La **frontière SOURCE / LOCAUX** : `ISSUE_SOURCE_FIELDS` (la liste canonique de ce que la synchro a le droit d'écraser), `normalizeSource`, `sourceEquals`, `normalizeCategory`, `normalizeLabels`, et l'énumération fermée `ISSUE_STATUS_CATEGORIES`. |
| `IssueTargets.ts` | La règle de composition/décomposition des clés de cible **« famille:id »** : `ISSUE_TARGET_KINDS`, `KINDS`, `SEPARATOR`, `COLLECTION_BY_KIND`, `key`, `parse`, `isKind`, `isValidKey`. |

Le modèle client `Issue` **délègue** sa normalisation à `IssueSync`, et la réconciliation
serveur aussi — c'est ce qui rend impossible, par construction, un écart de sémantique
entre les deux côtés.

> ⚠ Si le modèle client réécrivait sa propre normalisation, la synchro trouverait un écart
> à chaque passe (`""` vs `null`, ordre des étiquettes…) et **réécrirait le document en
> boucle** (révision qui monte, SSE, bruit d'undo). Un test d'invariant compare les deux,
> champ par champ.

`IssueTargets` est importé par `DataValidation.ts` (invariant de forme) et par `Cascade.ts`
(recomposition de la clé d'un objet supprimé) : c'est un import **entre fichiers partagés**,
donc écrit avec l'extension `.js` — impérative (cf. `CLAUDE.md` § « Code partagé »).

### Client

- `models/Issue.ts` — entité + `displayName` (**clé lisible**, sinon titre, sinon identité
  côté tracker) ;
- `core/IssueStatus.ts` — état d'un ticket : catégories, couleurs, clé de tri, libellés et
  **pastilles**. Règle **unique**, partagée listing / fiche / palette / mini-listing ;
- `core/IssueTargetSummary.ts` — « quels tickets parlent de CET objet ? », en logique pure
  (ouverts, total, N derniers) ;
- `views/ListConfigs.issues` — colonnes et filtres de l'onglet (lecture seule) ;
- `views/ListTargets.issueTarget` — la dimension **CIBLE** du listing (le même descripteur
  sert d'éditeur de liens, cf. § « Rattachement aux objets ») ;
- `views/IssueTargetSource.ts` — contrat des cibles liables, injecté via `FormHost.issueTargets` ;
- `views/IssueFicheHooks.ts` — contrat d'intégration « fiches », injecté via `FormHost.issueHooks` ;
- `views/forms/IssueForms.ts` — édition des champs LOCAUX + des cibles, « Synchroniser »,
  « Suivre un ticket », « Ouvrir un ticket » ;
- `views/forms/IssueProvidersForm.ts` — modale de configuration des trackers ;
- `views/forms/IssueSyncClient.ts` — client REST dédié des routes du module ;
- `views/forms/IssueFicheRow.ts` — la rangée « Tickets » des fiches (équipement / VM / spare /
  sous-équipement) ;
- `views/forms/DetailForms.issueDetail` — la fiche d'un ticket ;
- `views/GlobalSearchSources` — famille `issues` + portée **« ticket: »** de la palette Ctrl+K.

## Frontière SOURCE / LOCAUX

| Famille | Champs | Qui écrit |
|---|---|---|
| **SOURCE** | `ext_id`, `provider_id`, `key`, `summary`, `status`, `status_category`, `issue_type`, `priority`, `assignee`, `reporter`, `labels`, `resolution`, `created_src`, `updated_src`, `url`, `orphan`, `last_sync` | la **synchro**, à chaque passe (écrasement) |
| **LOCAUX** | `description` (héritée d'`Entity`), `notes`, **`targets`** | l'**utilisateur** seul (fiche → « Modifier ») |

Aucun champ **DÉRIVÉ**, contrairement à `vms.host_equipment_id` et
`wifiClients.ap_equipment_id` : le rattachement aux objets du modèle est **saisi**, la
synchro n'a donc rien à re-résoudre.

Deux champs du pivot appartiennent au **SERVICE** et non à l'adaptateur, et sont
ré-estampillés à l'écriture (`IssueReconcile.sourceOf`) : `orphan` (l'adaptateur ne voit
que ce qu'il a résolu, il ignore ce que le document suit) et `last_sync` (UNE passe porte
UN seul horodatage, ce qu'un adaptateur qui ne voit qu'un lot ne peut pas garantir).
`last_sync` est en outre **exclu du diff** puis posé uniquement sur une écriture réelle :
sans cela, l'idempotence serait perdue dès la première passe.

### 🚨 `ext_id` est l'identifiant INTERNE, jamais la clé

`ext_id` est la **clé de réconciliation**, et c'est l'**identifiant interne** du ticket
(« 10042 » chez Jira), **jamais** la clé lisible (« INFRA-123 »).

La raison est mesurable et coûteuse : une clé Jira **change** quand le ticket est déplacé
d'un projet à l'autre (`INFRA-123` devient `OPS-45`). Prendre la clé pour identité
produirait, au premier déplacement, un **doublon** (le « nouveau » ticket) **plus un
orphelin** (l'ancien, devenu introuvable) — et le défaut resterait **silencieux** jusqu'au
jour où il frappe. `key` n'est donc qu'un **champ d'affichage**, re-synchronisé à chaque
passe : un déplacement de projet se reflète tout seul dans la colonne « Clé ».

Corollaires portés par le code :

- `JiraParse.issueRecord` **refuse** (rend `null`) un item sans identité interne — mieux
  vaut ne pas suivre un ticket que le suivre sous une identité mobile ;
- quand l'utilisateur saisit `INFRA-123`, le serveur **résout d'abord** la référence
  (`adapter.lookup`) puis persiste l'identifiant interne ;
- `INDEX_SPEC.issues` indexe `ext_id` (écart volontaire avec `vms`/`wifiClients`, qui
  n'indexent pas le leur : là-bas la réconciliation part de l'inventaire complet d'un
  provider, ici on résout des tickets **nommés**).

## Statut : libellé BRUT + catégorie NORMALISÉE

C'est le partage qui décide si l'abstraction multi-providers tient. Un tracker n'a pas
« des statuts » : il a ceux de ses **workflows**, configurables par projet (« En recette »,
« Attente client »…), et un autre tracker en a d'autres (GitHub n'en a que deux).

- **`status`** = le libellé remonté, **affiché tel quel et JAMAIS traduit**. Le montrer
  vaut mieux que le masquer derrière une énumération que la prochaine configuration
  démentira (même doctrine que `VmStatus` pour Proxmox et `WifiStatus` pour les types de
  raccordement) ;
- **`status_category`** = classification **FERMÉE** à 4 valeurs — `todo` / `in_progress` /
  `done` / `unknown` (`ISSUE_STATUS_CATEGORIES`, partagé) — **seule** base des couleurs, des
  tris et des filtres sémantiques. C'est l'**adaptateur** qui la produit : Jira l'expose
  nativement (`statusCategory.key`), une marque qui n'en aurait pas la déduit chez elle.

C'est ce partage — libellé libre / catégorie fermée — qui permet à un futur provider
d'entrer **sans toucher une ligne de vue**.

`unknown` n'est pas un bouche-trou : c'est la valeur qui rend la **tolérance** possible.
Un état que l'adaptateur ne sait pas classer est accepté et rangé là, plutôt que de faire
échouer la passe entière. Deux gardes complémentaires :

- `IssueSync.normalizeCategory` **CLAMPE** sur `unknown` — la synchro écrit un LOT, et un
  seul ticket mal classé ferait rejeter la passe entière par `normalizeAndValidate` ;
- la spec `issues.status_category` déclare quand même un `enum` **strict** : il protège la
  porte d'écriture **directe** (API, import), qui doit refuser une valeur inventée.

`core/IssueStatus` est la **source unique** de l'état affiché côté client. Deux règles y
sont écrites une fois pour toutes :

- l'**orphelinat prime** sur la catégorie pour la couleur (`color`) et regroupe en tête du
  tri (`sortKey`) : la catégorie affichée date de la dernière résolution réussie, donc
  potentiellement périmée, tandis qu'« introuvable » est l'état **courant** ;
- mais les **deux pastilles** sont rendues côte à côte, jamais l'une à la place de l'autre
  (`pills` = `notFoundPill` + `statusPill`) : savoir qu'un ticket introuvable était « En
  cours » est précisément ce qui aide à décider quoi en faire ;
- `isOpen` = **la négation de `done`**, et non la liste blanche `todo` + `in_progress` :
  `unknown` est le repli de tout ce qu'on n'a pas su classer — le compter comme clos le
  ferait disparaître des badges alors que c'est justement ce qui mérite un coup d'œil.

## Rattachement aux objets (`targets`)

Le rattachement d'un ticket aux objets du modèle est **MANUEL** : rien n'est dérivé d'une
convention imposée aux utilisateurs du tracker (pas de label `dcm:*` à faire respecter).

**Stockage** : `issues.targets: string[]`, valeurs de la forme **« famille:id »** —
`equipment:<id>` / `vm:<id>` / `spare:<id>` / `sub_equipment:<id>`. La composition et le
décodage vivent **une seule fois**, dans `src-shared/IssueTargets` : quatre consommateurs
sans rapport entre eux en dépendent (la validation, la cascade, le filtre du listing,
l'éditeur de liens), et ils la liraient sinon chacun à sa façon.

**Vocabulaire partagé avec les interventions, SANS dépendance de code.** Les familles et la
composition de clé sont **volontairement identiques** à `INTERVENTION_TARGET_KINDS` (serveur),
`InterventionsFormat.TARGET_KIND_SLUGS` (client) et `core/TargetSearch.key` : un utilisateur
qui lie « equipment:E1 » sur une intervention et sur un ticket écrit la même chose, et
l'éditeur (SearchPop alimenté par `TargetSearch`) sert les deux sans conversion. C'est une
**convergence vérifiée par test**, pas un import — faire s'importer les deux modules
casserait les **deux** amovibilités.

**Validation : la FORME, jamais l'EXISTENCE.** Un invariant de la spec `issues` vérifie que
chaque clé s'écrit « famille:id » avec une famille **connue** et un id non vide. On ne
contrôle pas l'existence de la cible : elle peut être créée après le lien, et surtout la
validation référentielle (V2) ne sait contrôler qu'un champ `ref` désignant **une**
collection — ce qu'une clé polymorphe n'est pas. En revanche une clé **mal formée** est
refusée, parce qu'aucune règle de cascade ne saurait la détacher : elle deviendrait une
référence pendante silencieuse.

**Filtre par appartenance, sans code neuf.** `targets` (comme `labels`) est ajouté à
`Schema.ARRAY_FIELDS` : le `where` serveur y teste l'**appartenance** (`json_each`) au lieu
de l'égalité, exactement comme `tags_src`. Le **filtre « Cible » unifié** des listings
marche donc tel quel (`ListTargets.issueTarget` — `where` serveur ⇄ `restrict` client). C'est
le 3ᵉ cas de figure de ce filtre, après l'égalité de colonne (`ipCarrier`) et les deux sauts
non mappables (`cableEquipment`), et le seul dont la valeur cherchée est une clé composée.

> ⚠ L'appartenance est une **égalité** de chaîne dans le tableau, jamais un test de préfixe :
> « equipment:E1 » ne doit pas matcher « equipment:E10 ». C'est le piège classique de ce
> genre de clés, et il est couvert par test des deux côtés (filtre du listing et
> `IssueTargetSummary.of`).

**Intégrité en SUPPRESSION : quatre `custom` de cascade.** `Cascade.detachTargetFromIssues`
est une fabrique commune appelée par les règles `equipments`, `vms`, `spares` et
`subEquipments` : elle retire la clé composée du `targets` de tous les tickets qui la
portent. Le ticket, lui, **n'est jamais supprimé** — il porte des notes et d'autres liens,
et le lien coupé est une information en soi. La règle `issues` elle-même est déclarée
**vide** (`{ delete: [], detach: [] }`) : rien ne pointe vers un ticket dans le document, et
une entrée vide commentée dit « examiné, rien à faire » là où une absence serait
indiscernable d'un oubli.

> 🚨 **Le `custom` COMPOSE sur le déjà planifié** (`Cascade.pendingValue`), comme
> `detachGroupFromMembers` et la règle `networks`. La raison est mesurée : `planMany`
> développe **plusieurs** suppressions dans le même plan, et rien n'empêche un lot de
> supprimer deux cibles d'un même ticket (un équipement **et** la VM qu'il héberge — ou un
> équipement **et** l'un de ses sous-équipements, ce dernier cas arrivant même par
> **récursion**, sans lot). Chaque valeur de détachement étant absolue et le dernier écrit
> gagnant chez les deux exécuteurs, calculer le retrait sur le `targets` d'origine n'en
> retirerait qu'**une** : l'autre clé resterait, pointant un objet supprimé, et la perte
> serait silencieuse.

> Écart **assumé** avec les interventions : elles **tolèrent** les liens orphelins parce que
> leurs cibles vivent dans une **autre base** (aucune FK, aucune cascade possible). Ici tout
> est dans le **même document** : on tient l'intégrité, et le coût est une entrée `custom`
> par famille.

**Un seul descripteur pour deux surfaces.** `ListTargets.issueTarget(store, reader)` décrit
la dimension « Cible » du listing **et** satisfait structurellement le contrat
`IssueTargetSource` de l'éditeur de liens : mêmes familles, même règle de nommage, même
source de candidats (serveur en mode API, cache local en mode fichier). `main.ts` passe donc
le **même** descripteur aux deux — il n'existe qu'une table de familles à tenir à jour.
Le paramètre facultatif `excluded` de `search` sert uniquement à l'éditeur (dédupliquer les
cibles déjà liées à chaque frappe) ; une dimension de filtre est mono-valeur et l'ignore.

### La rangée « Tickets » des fiches

`views/forms/IssueFicheRow` ajoute aux fiches équipement / VM / spare / sous-équipement un
badge « N ticket(s) ouvert(s) », un bouton « Ouvrir un ticket », un mini-listing des
**3 derniers** tickets et un « Afficher plus ». Elle ne connaît que le contrat
`IssueFicheHooks`, implémenté dans `main.ts`.

🚨 **Ce qui la distingue de la rangée des interventions, et pourquoi c'est un gain.**
Là-bas, `countOpen` et `latestFor` sont **asynchrones** parce que les interventions vivent
dans une base serveur séparée que le client n'a pas — d'où deux appels réseau, un
clignotement, un état d'échec à absorber, et une rangée qui **n'existe pas** en mode fichier.
Ici, `issues` est une **collection du document** : le comptage et les « N derniers » sont un
simple filtre en mémoire (`core/IssueTargetSummary`, pur et testé). Donc `digestFor` est
**synchrone**, aucune route de comptage n'existe côté serveur, et la rangée **fonctionne en
mode fichier**. Seule `createFor` parle au tracker : elle est le seul membre conditionné au
mode API (absente ⇒ bouton non rendu, jamais grisé).

Les trois actions ont trois sémantiques de navigation distinctes : une **ligne** du
mini-listing **empile** la fiche du ticket (← Retour ramène à l'objet) ; « Afficher plus »
**change de vue** (la fiche est fermée, puis `ListView.focusTarget` pose le filtre de cible
sur l'onglet d'arrivée) ; « Ouvrir un ticket » **empile** une modale et ne ferme rien.

## Configuration des providers (par document)

Un provider = **une instance de tracker**. Plusieurs providers par document sont possibles
(deux Jira différents, ou une autre marque) ; `IssueRecord.provider_id` délimite le
périmètre de chaque passe.

### Champs d'un provider

| Champ | Requis | Défaut | Notes |
|---|---|---|---|
| `id` | oui | — | immuable après création (clé de réconciliation des tickets) |
| `kind` | oui | — | doit être un type **connu** (`jira`) — sinon la validation refuse, en listant les types supportés |
| `url` | oui | — | **https obligatoire** : le jeton voyage en en-tête d'autorisation à chaque requête |
| `account` | oui | — | identifiant du **compte de service** (Jira Cloud : l'adresse e-mail Atlassian). Moitié **PUBLIQUE** de l'identification — **relue et réaffichée** à l'édition |
| `token` | oui à la création | — | jeton d'API, **chiffré au repos**, **jamais relu** |
| `interval_sec` | non | `0` | `0` = synchro **manuelle** uniquement |
| `timeout_sec` | non | `20` | délai d'UNE requête HTTP |
| `options.project_key` *(Jira)* | non | `""` | projet où sont **créés** les tickets. Vide = provider en lecture seule (« Ouvrir un ticket » est alors refusé avec un message qui nomme l'option) |
| `options.issue_type` *(Jira)* | non | `"Task"` | type de ticket créé (non vide). Le libellé dépend de la langue du projet (« Tâche » sur une instance francophone) : c'est un réglage, pas une énumération |

Les **options** sont propres à la marque et validées par la branche `kind` correspondante
(`KIND_OPTION_SPECS`) ; elles sont persistées en **JSON** dans une colonne `options` — c'est
ce qui permet d'ajouter une marque **sans toucher au schéma de la base**.

⚠ **Pas de `fingerprint` ni de `ca_pem`**, contrairement aux providers VM et wifi. Ce
matériel de confiance TLS existe là-bas parce que les consoles Proxmox/UniFi sont
massivement en certificat **auto-signé** ; un tracker SaaS est un service public à
certificat **valide**. Les demander ferait saisir un réglage sans emploi et laisserait
croire que ce transport sait s'en servir : il ne sait pas (il est bâti sur `fetch`, pas sur
`node:https` — cf. § « Transport »).

⚠ Le délai par défaut est **20 s**, plus généreux que les 15 s des modules `vm/`/`wifi/`, et
c'est délibéré : là-bas une requête liste une ressource locale sur le LAN, ici une requête
est une **recherche** côté SaaS (jusqu'à ~100 identifiants d'un coup) traversant Internet.
Un délai trop court transformerait une passe lente en passe **échouée**, donc en tickets
faussement « introuvables » à la lecture d'un opérateur pressé.

### Stockage : `issue-providers.db` (chiffrée)

Base SQLite **dédiée au module**, dans `DOCS_DIR` (à côté de `registry.db`, de
`vm-providers.db` et de `wifi-providers.db`). **Une seule table** `issue_providers`, PK
`(doc_id, id)`, colonne `token_enc` (jeton **chiffré**, jamais en clair), colonne `account`
(publique, relue), colonne `options` (JSON), colonnes d'audit `created_by`/`updated_by`
posées **par le serveur** (`RequestAuthor.identity`, jamais le corps de la requête).

Une seule table, là où le module VM en a deux : un cluster Proxmox répond sur chaque nœud
(pool 1-N ordonné), un tracker n'a qu'une instance et sa config tient dans une ligne.

Invariants de sécurité (les mêmes que les modules `vm/` et `wifi/`) :

- `listFor` ne renvoie **jamais** le jeton — seulement `has_token: true` ;
- le chemin **STATUT** ne fait circuler **aucun** jeton (`summariesFor` projette
  id/kind/interval_sec et jette immédiatement le clair) ;
- un jeton **indéchiffrable** (clé changée) exclut CE provider de la passe et mémorise une
  erreur consultable (`tokenErrorsFor`) — **jamais** de `throw` global qui ferait tomber la
  synchro des autres ;
- aucun jeton, clair ou chiffré, n'apparaît dans un log, un message d'erreur ou une réponse.

### Chiffrement — `DCMANAGER_SECRETS_KEY` (coffre serveur PARTAGÉ)

Le module utilise **la même clé** que `vm/`, `wifi/` et `notify/`, via le `SecretBox`
serveur partagé (AES-256-GCM, format `v1:iv:tag:ct`). **C'est voulu** : une seule clé
d'infrastructure à distribuer, à protéger et à faire tourner, plutôt qu'une par feature.
Passphrase de **16 caractères minimum** (le constructeur refuse en dessous : la dérivation
est un SHA-256 direct, toute la robustesse repose sur la longueur du secret).

Le chiffrement protège les **copies** de la base (backups, exfiltration du fichier), pas un
attaquant qui contrôle l'hôte — limite assumée, identique à celle documentée pour `vm/`.

🚨 **Le modèle de menace est ÉLARGI** par rapport aux modules d'inventaire : le jeton stocké
ici n'est **pas** en lecture seule, puisque le contrat d'adaptateur porte une **création**
de ticket. Un serveur compromis peut donc **écrire** chez le tracker. Recommandation :
utiliser un **compte de service DÉDIÉ**, aux droits **limités au projet cible** (lecture des
tickets suivis + création dans ce seul projet), et non un compte nominatif d'administrateur.

### Clé absente / config invalide (503)

- **clé absente** → module inactif : **toutes** les routes répondent `503` avec un `detail`
  actionnable (« définir `DCMANAGER_SECRETS_KEY`… »). Si une `issue-providers.db` existe
  **déjà** sans clé, le message est enrichi (des jetons chiffrés attendent la clé) ;
- **clé présente mais trop courte, ou base illisible** → module « démarré en erreur »,
  routes en `503` avec le détail. Le serveur, lui, **démarre normalement** : une config
  invalide ne fait jamais tomber l'application.

La modale « Providers… » affiche ce `detail` **à la place** des contrôles d'édition — il n'y
a rien à configurer tant que la clé n'est pas là.

### Dépannage — clé CHANGÉE (jetons indéchiffrables)

Symptômes : les providers disparaissent de la synchro, le statut les réaffiche **en erreur**
avec « le secret doit être ressaisi », et « Tester » répond `422` avec le même message.
Correctif : rouvrir « Providers… », **ressaisir le jeton d'API** de chaque provider,
enregistrer. Rien d'autre n'est perdu (URL, compte, intervalles, options sont en clair).

Ce comportement tient à un complément explicite côté routes : les lectures **excluent** les
providers au jeton indéchiffrable, donc `statusFor`/`syncDocument` ne les rendent pas ;
`IssueModule.withTokenErrors` les **réinjecte** en erreur pour qu'ils ne disparaissent pas
silencieusement de l'UI (l'incident constaté sur le module VM).

## Routes REST

Toutes sous la garde d'accès de l'API, scopées par document. `404` si le document est
inconnu ; `503` (actionnable) si la feature est inactive ou en erreur.

| Méthode | Chemin | Effet | Codes notables |
|---|---|---|---|
| `POST` | `/documents/:docId/issues/sync` | synchronise **tous** les providers du document | `200 { providers }` · `500` (ceinture) |
| `GET` | `/documents/:docId/issues/status` | état par provider (mémoire serveur) | `200 { providers }` |
| `POST` | `/documents/:docId/issues/follow` | **« Suivre un ticket »** — corps `{ reference }` (clé lisible **ou** URL collée) | `200 { issue, already, provider_id, message }` · **`422`** référence inexploitable (rien n'est créé) |
| `POST` | `/documents/:docId/issues/create` | **« Ouvrir un ticket »** — corps `{ provider_id?, summary, description?, targets? }` | `200 { issue, provider_id, message }` · `400` demande incomplète · **`422`** refus du tracker (son message, tel quel) · **`500 { created_key }`** échec PARTIEL |
| `GET` | `/documents/:docId/issues/providers` | liste **sans** jeton (`has_token: true`) | `200 { providers }` |
| `PUT` | `/documents/:docId/issues/providers/:id` | créer/mettre à jour | `200 { provider }` · `400 { issues }` si invalide |
| `DELETE` | `/documents/:docId/issues/providers/:id` | supprimer | `200 { ok: true }` · `404` provider inconnu |
| `POST` | `/documents/:docId/issues/providers/test` | tester une config candidate | `200 { info }` · `400` config invalide ou `kind` inconnu · **`422`** jeton stocké indéchiffrable |

`follow` et `create` sont les **seules** routes du module qui écrivent dans le document.

⚠ **Pourquoi `/issues/create` et non `POST /documents/:docId/issues`.** Ce dernier chemin
**existe déjà** : c'est la création générique d'un enregistrement du cœur
(`data.post("/:collection")` d'`api.ts`). Les extensions étant montées **avant** le routeur
de données — précisément pour que leurs segments ne soient pas lus comme des collections —,
y déclarer `router.post("/")` **masquerait** silencieusement cette création générique pour la
seule collection `issues`. Un module amovible ne doit pas changer le comportement du cœur :
d'où un segment d'ACTION, comme pour `/sync`, `/follow` et `/providers/test`.

Après **chaque** écriture CRUD, les timers périodiques sont **ré-armés**
(`service.rearmTimers()`) : la configuration prend effet à chaud, sans redémarrage.

### Une passe de synchro, de bout en bout

1. **Assiette** : `repo.findBy("issues", "provider_id", config.id)` — c'est le DOCUMENT qui
   énumère. Assiette vide ⇒ aucun appel au tracker, statut « aucun ticket suivi ».
2. **Périmètre de passe** : `IssueSyncService.passScope` trie par `last_sync` croissant (les
   jamais synchronisés d'abord), départage par `ext_id`, et applique le **plafond**.
3. **Résolution** : `adapter.resolve(extIds)` — par lots, jamais un ticket à la fois. Un
   échec laisse le document **intact** et rend un statut en erreur.
4. **Réconciliation** : `IssueReconcile.plan` — patchs **minimaux** champ à champ sur des
   valeurs **normalisées des deux côtés**.
5. **Écriture** : relecture au moment d'écrire (les `notes`/`targets` saisis pendant la
   passe survivent), validation partagée `DataValidator.normalizeAndValidate` (autorité
   serveur), puis `markChanged` → `repo.transact` → `live.publish` (origine `issue-sync`,
   changeset limité à `["issues"]`).
6. **Idempotence** : rien à écrire ⇒ **aucune** révision, **aucun** SSE, **aucun** bruit
   d'undo.
7. **Signalement** : chaque passe en échec `raise` une alerte de clé stable
   `issue-sync:<docId>:<providerId>` (type `issue-sync-failure`), chaque retour à la normale
   la `resolve` — via l'interface `ProblemReporter` déclarée **par ce module** et pontée par
   `index.ts` (typage structurel : `issues/` n'importe rien de `notify/`).

### Le plafond de passe et son roulement

Contrairement à `vm/` et `wifi/` où la source borne naturellement le volume, l'assiette est
ici pilotée par l'utilisateur : rien n'empêche un document de suivre des milliers de
tickets. `IssueSyncService.MAX_ISSUES_PER_PASS = 500` borne donc chaque passe (5 lots de
100), et ce qui est tronqué est **journalisé et remonté dans le statut** — un plafond
silencieux se lirait « tout est à jour » alors que la moitié de l'assiette n'a pas été
regardée. Les compteurs `tracked` / `queried` / `skipped` existent pour ça.

Un **curseur de roulement** (en mémoire, par couple document × provider) fait repartir la
passe suivante là où celle-ci s'arrête. Sans lui, une assiette plafonnée dont rien ne change
resterait **figée** : l'idempotence n'écrit `last_sync` que sur un ticket qui a changé, donc
l'ordre de priorité ne bougerait plus et la queue de l'assiette ne serait jamais interrogée.
Avec le roulement, l'assiette entière défile en ⌈N/plafond⌉ passes, que quelque chose change
ou non.

Les `orphans` sont dérivés des `missing` **rendus par l'adaptateur**, et surtout **pas**
d'une différence d'ensembles « suivi mais pas revenu » : la passe étant plafonnée, un ticket
suivi peut n'avoir tout simplement pas été demandé — le déduire d'une différence le
marquerait « introuvable » à tort à chaque passe tronquée.

Deux garde-fous complètent la boucle : **anti-chevauchement** (un couple document × provider
déjà en cours n'est pas doublé) et **anti-rafale** (`DEFAULT_MIN_INTERVAL_SEC = 10` — sous ce
délai depuis la dernière tentative, l'appelant reçoit le dernier statut **annoté**, sans
qu'il soit stocké, au lieu d'une nouvelle passe complète).

## Création de ticket

### L'ordre est impératif : tracker D'ABORD, écriture locale ENSUITE

L'inverse (écrire puis créer) laisserait, au moindre refus du tracker, un enregistrement
local **sans ticket en face** — une ligne mensongère dans le document. L'ordre retenu ne
peut produire, au pire, qu'un ticket **réel** non référencé chez nous, que l'utilisateur
rattrape en une saisie.

### 🚨 L'échec partiel

Si l'écriture locale échoue **après** une création réussie, le ticket **existe** chez le
tracker. Alors, et dans cet ordre d'importance :

- la réponse **porte la clé créée** (`created_key`, `500`) pour que l'utilisateur la reprenne
  par « Suivre un ticket » — un message sans la clé rendrait la situation irrattrapable. Le
  client la relève dans `IssueSyncError.createdKey`, affiche un message dédié, et
  **VERROUILLE** la modale : ré-enregistrer créerait un **second** ticket ;
- **jamais** de suppression compensatoire du ticket distant. On ne détruit pas dans un
  système tiers pour rattraper NOTRE propre écriture : la suppression pourrait elle-même
  échouer, elle serait invisible dans nos journaux, et surtout le ticket peut déjà avoir été
  vu, commenté ou assigné. Un ticket en trop se ferme ; un ticket supprimé ne revient pas.

L'incident est journalisé en **erreur** côté serveur : c'est un écart durable entre le
tracker et le document, pas un incident passager.

### Les champs obligatoires par projet ne sont pas devinés

Un projet peut exiger des champs personnalisés (composant, version, équipe…). On
n'interroge **pas** `createmeta` pour les deviner : deviner produirait un formulaire faux,
alors que le refus, lui, est juste. Si la création échoue, le **message du tracker remonte
TEL QUEL** jusqu'à l'utilisateur (`JiraHttp.errorDetail` extrait `errorMessages` et les
erreurs **par champ** — « customfield_10010 : Le champ X est requis »). L'envelopper dans un
« échec de création » générique détruirait la seule information actionnable.

C'est pourquoi la route distingue la **nature** du refus (`IssueOpenFailure`) plutôt que de
relire un message : `invalid` → `400`, `tracker` → `422`, `partial` → `500`.

### Ce que le formulaire ne demande pas

Ni le **projet**, ni le **type** de ticket : ce sont des **options du provider**, réglées une
fois par l'opérateur. Les demander à chaque création obligerait l'utilisateur à connaître la
configuration du tracker, et permettrait à un client de viser un autre projet que celui qui
a été autorisé. Ils sont simplement **rappelés** en clair sous le formulaire (et un projet
non configuré est signalé **avant** la tentative, plutôt que découvert après rédaction).

Le **provider** est implicite quand le document n'en a qu'un, et **requis** au-delà : aucun
repli « le premier », contrairement à « Suivre un ticket » où les providers sont *interrogés*
et où l'un d'eux *reconnaît* la référence — créer produit, lui, un effet **irréversible**
chez un tiers.

Les **cibles** sont validées **avant** l'appel distant (`IssueTargets.isValidKey`) : une clé
mal formée est le seul refus de validation prévisible sur ce chemin, et la laisser filer
transformerait une faute de saisie en échec **partiel**.

### ADF (Atlassian Document Format)

Sur l'API v3, `description` n'est **pas** du texte mais un document JSON. `JiraParse.toAdf`
est une fonction pure qui produit **un paragraphe par ligne**. Une ligne vide devient un
paragraphe **sans contenu** (`content: []`) et surtout **pas** un nœud `text` de chaîne vide :
un `text` vide est invalide au schéma ADF, et c'est l'erreur qu'on commet naturellement en
mappant les lignes sans y penser. Les caractères spéciaux ne demandent aucun traitement —
c'est la sérialisation JSON de la requête qui les échappe.

### Transport et débit

`JiraHttp` est bâti sur **`fetch` injecté** + `AbortSignal.timeout` (patron
`notify/WebhookNotifier`), et **non** sur `node:https` + `trustOptions` comme `vm/PveHttp` et
`wifi/UnifiHttp`. L'écart est délibéré : ce montage n'existe là-bas que parce que les
consoles auto-hébergées sont massivement en certificat auto-signé et que le `fetch` de Node
n'offre aucun moyen — sans dépendance — de fournir une CA ou d'épingler une empreinte par
requête. Jira Cloud est un service public à certificat valide : il n'y a rien à épingler.
Bénéfice collatéral : **tout** est testable sans réseau, en injectant un stub.

Corollaire : ce client ne **sait pas** gérer un certificat privé, et le dit dans ses messages
d'erreur TLS. Un tracker auto-hébergé entrera comme un **adaptateur distinct** qui reprendra
`trustOptions` chez lui.

**429** : le tracker demande de ralentir. On honore `Retry-After` (les deux formes de la RFC :
secondes ou date HTTP), **borné des deux côtés** — au plus `MAX_RETRIES_ON_THROTTLE = 3`
nouvelles tentatives, attente par défaut `DEFAULT_RETRY_WAIT_MS = 5 s`, plafond
`MAX_RETRY_WAIT_MS = 60 s` au-delà duquel on **abandonne** la passe. On ne martèle jamais :
réessayer en boucle sur un service qui vient de dire « trop vite » aggrave ce qu'il signale et
peut faire blacklister le compte de service. Plafond de **32 Mio par réponse**
(`MAX_RESPONSE_BYTES`), avec interruption **dès le dépassement** quand `fetch` expose un flux.

### Le lien du ticket est PERSISTÉ au pivot, pas reconstruit

`url` est composé **une fois** par l'adaptateur (`JiraParse.browseUrl` : `<base>/browse/<clé>`)
et persisté dans l'enregistrement. Ce n'est pas un détail d'implémentation :

- le lien reste **cliquable en mode fichier**, après export — un document synchronisé puis
  emporté hors serveur garde des tickets ouvrables d'un clic ;
- **rien à configurer en double** : la base d'URL est déjà dans la config du provider ;
- **multi-instances natif** : deux providers sur deux trackers produisent chacun ses liens,
  ce qu'une variable d'environnement unique ne saurait pas faire.

Le module `interventions/`, lui, fabrique ses liens depuis la variable `JIRA_BASE_URL`
(exposée par `GET …/interventions/meta`). Ce montage n'est **pas** reproduit ici, et
`JIRA_BASE_URL` reste ce qu'elle est pour ce module-là.

⚠ Le champ `self` d'une réponse Jira pointe la **ressource d'API**
(`…/rest/api/3/issue/10042`) : le recopier donnerait à l'utilisateur un lien qui affiche du
JSON ou demande une authentification. C'est le piège classique de cette intégration.

Côté affichage, `url` est une donnée d'**origine distante** (et un document importé peut
porter n'importe quoi) : elle passe systématiquement par `Html.externalLink`, qui n'accepte
que les schémas `http`/`https` (liste **blanche**), pose `target="_blank"` +
`rel="noopener noreferrer"`, et **retombe sur du texte** si l'URL n'est pas conforme. Un
`javascript:` rendu cliquable serait un XSS que l'échappement HTML **n'empêche pas**.

## API Jira — ce qui est SUPPOSÉ (à VALIDER sur instance réelle)

⚠ **Contrairement à l'intégration UniFi, AUCUNE instance Jira n'a été interrogée.** Le
tableau ci-dessous n'est **pas un constat** : ce sont des **hypothèses**, écrites d'après la
documentation publique. Elles sont rassemblées **en un seul point du code** — les constantes
de chemins de `JiraAdapter` et les alias de `JiraParse` — afin de rester corrigeables d'un
geste, et l'en-tête de `JiraAdapter.ts` les énumère une par une, dans le même ordre.

| # | Élément | Hypothèse | Où c'est décodé / à corriger |
|---|---|---|---|
| 1 | Base d'API | `/rest/api/3` (Jira **Cloud**) | `JiraAdapter.API_BASE` — une instance Data Center répond sur `/rest/api/2` : ce sera un **adaptateur distinct**, pas un réglage |
| 2 | Authentification | **Basic** `base64(e-mail:jeton d'API)` | `JiraHttp.authHeader` — Data Center utilise `Bearer <PAT>` |
| 3 | Recherche par lots | `POST /rest/api/3/search/jql`, corps `{ jql, fields, maxResults }`, pagination par **`nextPageToken`** | `JiraAdapter.PATH_SEARCH`. 🚨 **L'hypothèse la plus fragile.** Atlassian a REMPLACÉ l'ancien `POST …/search` (`startAt`/`total`) par celui-ci — si l'instance répond `404`, il suffit de mettre `PATH_SEARCH_LEGACY` dans cette constante, **rien d'autre** : `JiraParse.page`/`nextCursor` comprennent DÉJÀ les deux formes et choisissent selon ce que la réponse porte |
| 4 | Taille de lot | ~**100** identifiants par requête | `JiraAdapter.BATCH_SIZE` — à confronter à la limite réelle de `maxResults` **et** à la longueur maximale du JQL |
| 5 | Statut | `fields.status.name` (libellé brut) + `fields.status.statusCategory.key` ∈ { `new`, `indeterminate`, `done` } | table `STATUS_CATEGORY_BY_JIRA_KEY` de `JiraParse.ts` — une clé absente de la table tombe sur `unknown`, on ne devine jamais |
| 6 | Identité stable | `id` (numérique, **stable**) vs `key` (**mobile**) | `FIELD_ALIASES.id` de `JiraParse.ts` — fondement de tout le chantier |
| 7 | Lien du ticket | `<base>/browse/<clé>` | `JiraParse.browseUrl` — ⚠ `self` pointe l'API, **pas** l'interface |
| 8 | Création | `POST /rest/api/3/issue`, `fields: { project:{key}, issuetype:{name}, summary, description }`, description en **ADF** | `JiraAdapter.PATH_ISSUE_CREATE` + `JiraParse.toAdf` |
| 9 | Test de connexion | `GET /rest/api/3/myself` | `JiraAdapter.PATH_MYSELF` — la **version** applicative n'y est pas exposée (`/serverInfo` la porterait) : `version` reste `null` plutôt que d'ajouter un appel à chaque test pour un champ cosmétique |

Les noms de champs sont acceptés par **alias** (`FIELD_ALIASES`, `NAMED_ALIASES`,
`PERSON_ALIASES`, `CATEGORY_KEY_ALIASES`), du plus probable au plus tolérant, le premier
présent gagnant — un filet peu coûteux face à une API dont le vocabulaire peut varier d'une
route à l'autre.

### Procédure de re-validation (au premier déploiement)

1. créer un **compte de service dédié** et son jeton d'API, aux droits **limités au projet
   cible** (cf. § modèle de menace) ;
2. configurer un provider (URL de l'instance, compte, jeton, `project_key`, `issue_type`) et
   cliquer **« Tester la connexion »**. Le test fait DEUX choses et les rapporte séparément :
   - `ok: false` → l'authentification ou la joignabilité échoue (message actionnable :
     `401/403` = compte/jeton/droits, `ENOTFOUND` = URL, etc.) ;
   - `ok: true` mais **`supported: false`** → l'authentification passe mais le **chemin de
     recherche** n'a pas répondu : c'est l'hypothèse n°3 qui est fausse. Le message le dit et
     l'avertissement n'est **pas bloquant** (le provider reste enregistrable) ;
3. **« Suivre un ticket »** avec une clé connue. Un refus `422` distingue déjà deux choses :
   « introuvable ou inaccessible » (Jira répond `404` dans les deux cas, délibérément, pour
   ne pas divulguer l'existence d'un ticket) ou l'échec d'un provider, dont le message est
   alors repris ;
4. ouvrir la **fiche** du ticket et vérifier champ par champ : clé, titre, statut **et sa
   couleur** (hypothèse n°5), type, priorité, assigné, rapporteur, étiquettes, résolution,
   dates du tracker, et surtout le **lien** (hypothèse n°7 — il doit ouvrir l'interface, pas
   du JSON). Un champ systématiquement vide = un alias à corriger dans `JiraParse.FIELD_ALIASES` ;
5. lancer une **synchro manuelle** et lire le statut : `tracked` / `queried` / `updated` /
   `missing` / `unchanged` / `skipped`. Relancer aussitôt doit rendre `updated: 0`
   (idempotence) ;
6. **déplacer** un ticket de test d'un projet à l'autre chez le tracker, puis re-synchroniser :
   la colonne « Clé » doit suivre **sans** créer de doublon ni d'orphelin (hypothèse n°6 —
   c'est le risque n°1 du chantier, et le seul contrôle qui le lève vraiment) ;
7. **« Ouvrir un ticket »** : vérifier la destination annoncée (projet + type), puis que le
   ticket créé porte bien la description saisie (hypothèse n°8 — un `400` peu lisible
   signalerait un problème d'ADF). Si le projet exige un champ personnalisé, vérifier que son
   message remonte **tel quel** dans la modale ;
8. vérifier le volume et la cadence : si `queried` plafonne à `MAX_ISSUES_PER_PASS`, le
   statut le dit explicitement ; régler `interval_sec` **haut** (l'état d'un ticket n'a pas la
   volatilité d'un client wifi) et surveiller l'absence de `429` dans les journaux.

## Mode local (fichier) — principe n°15

**Constat.** La **synchronisation** et la **création** de ticket ne sont pas disponibles en
mode fichier : elles sont produites côté serveur (jetons chiffrés au repos, appels réseau
sortants vers le tracker).

**Justification.** C'est **la même exception que les VMs, les clients wifi et les
notifications**, pour la même raison de fond : le mode fichier n'a ni secret protégé au
repos, ni service capable d'interroger périodiquement un tiers. Stocker un jeton d'API dans
un document répliqué à tous les clients serait un contresens de sécurité, pas une commodité
manquante — et il est ici **en écriture**, ce qui aggrave l'enjeu.

**Ce qui marche quand même en mode fichier**, et c'est mieux servi que pour le wifi :

- `issues` est une collection du **DOCUMENT** : un document synchronisé puis exporté reste
  entièrement **lisible, filtrable et cherchable** (palette Ctrl+K comprise, portée
  « ticket: », via la spec partagée `SearchTerms`) ;
- les champs **LOCAUX** restent éditables (`description`, `notes`) ;
- les **CIBLES** restent éditables : ce sont des données du document, pas du tracker. C'est
  pourquoi `FormHost.issueTargets` est injecté dans les **deux** modes, contrairement aux
  hooks d'interventions et de certificats — la source de candidats se rabat simplement sur le
  cache local ;
- le **lien du ticket reste cliquable**, parce que `url` est persisté au pivot et non
  reconstruit depuis une variable d'environnement serveur (cf. § « Le lien du ticket est
  PERSISTÉ ») ;
- la **rangée « Tickets » des fiches fonctionne**, badge et mini-listing compris : le
  comptage est un filtre **synchrone** en mémoire (`core/IssueTargetSummary`), sans aucune
  route. C'est un bénéfice direct du choix d'une collection du document plutôt que d'une base
  serveur séparée — la rangée des interventions, elle, n'existe pas en mode fichier.

Sont donc masqués — jamais grisés — « Synchroniser », « Suivre un ticket », « Ouvrir un
ticket » et « Providers… », plus le bouton « Ouvrir un ticket » de la rangée des fiches
(`createFor` absent).

**Évolution.** Si le besoin d'un suivi purement local apparaît (déclarer un ticket connu sans
tracker joignable), il suivra le chemin prévu pour les VMs : un provider « Manuel », qui
devra fonctionner **aussi** en mode fichier.

## Suppression de la feature (script d'amovibilité)

1. **Serveur** : supprimer `src-server/src/issues/` (les **9** fichiers) + les lignes
   `IssueModule` d'`index.ts` (import, `create`, `issues.extension()` de la liste
   d'extensions, `issues.start()`, `issues.stop()` du gestionnaire de signaux, et la mention
   de `issue-providers.db` dans le commentaire d'arrêt). Supprimer le fichier
   `issue-providers.db` sur le serveur. `SecretBox.ts`, `AuditStamp.ts` et `RequestAuthor`
   vivent **hors** du module et **restent** : ils servent aux autres features.
2. **Client** : supprimer `models/Issue.ts`, `core/IssueStatus.ts`,
   `core/IssueTargetSummary.ts`, `views/IssueTargetSource.ts`, `views/IssueFicheHooks.ts`,
   `views/forms/IssueForms.ts`, `views/forms/IssueProvidersForm.ts`,
   `views/forms/IssueSyncClient.ts`, `views/forms/IssueFicheRow.ts` ; retirer les
   branchements fins :
   - entrée `issues` d'`EntityRegistry` (+ son import) ;
   - `ListConfigs.issues` (+ les imports `IssueStatus`/`Issue`/`IssueTargets`) ;
   - `ListTargets.issueTarget` **et** les familles `SPARE`/`SUB_EQUIPMENT` qu'elle seule
     utilise (+ l'import `IssueTargets`) ;
   - dans `main.ts` : `issueSyncClient`, l'onglet `tickets` (`addListTab` + ses
     `extraActions` + `addLabel`/`onAdd`), `openIssueCreate`, `formHost.issueTargets`,
     `formHost.issueHooks` (l'objet `issueFicheHooks`), et les imports `IssueForms`/
     `IssueProvidersForm`/`IssueSyncClient`/`IssueFicheHooks`/`ListTargets`/
     `IssueTargetSummary`/`IssueTargets` ;
   - l'entrée `issues` de `DetailForms.DETAIL_OPENERS` **et** la méthode `issueDetail`, plus
     les imports `IssueStatus`/`Issue`/`IssueForms`/`IssueTargets`/`IssueFicheRow` ;
   - les quatre appels `IssueFicheRow.attach` : `EquipmentForms`, `SubEquipmentForms`, et
     `DetailForms` (fiches spare et VM), avec leurs imports ;
   - les champs `issueTargets` et `issueHooks` de `FormHost` (`views/forms/shared.ts`) + leurs
     imports de type ;
   - la famille `issues` **et** la portée `ticket:` de `GlobalSearchSources` (+ les imports
     `IssueStatus`/`Issue`) ;
   - les exports de `views/index.ts` (`IssueForms`, `IssueProvidersForm`, `IssueSyncClient`,
     et les types `IssueTargetSource`/`IssueFicheHooks`/`IssueFicheItem`/`IssueFicheDigest`) ;
   - l'entrée `issues` de `RenderImpact` ;
   - l'icône `Icons.TICKET` (+ sa vignette dans `design-system/previews/icones/registre.html`,
     à régénérer par `node design-system/build.js`) ;
   - les catalogues i18n `fr|en/issues.ts` (+ leur import et leur mention dans les
     agrégateurs `fr.ts`/`en.ts`) et les clés `tabs.issues.*`, `app.issues.*`,
     `detail.issue.*`, `detail.nf.issue`, `domain.issueStatusCategory.*`,
     `lists.empty.issues`, `lists.col.key|summary|priority|assignee|targets|provider|updatedSrc`,
     `lists.filter.issueTarget|issueTargetPlaceholder|issueCategory|targetSpare|targetSubEquipment`,
     `lists.ph.notFound`, `lists.ph.issue`, `search.family.issues`, `search.scope.issues`.
3. **Partagé** : retirer `"issues"` de `Schema.COLLECTIONS`, `"labels"` et `"targets"` de
   `Schema.ARRAY_FIELDS`, la spec `issues` de `DataValidation.ts` (champs **et** entrée de
   `COLLECTION_SPECS`, plus le type `Records.Issue` et les imports `ISSUE_STATUS_CATEGORIES`/
   `IssueTargets`), l'entrée `issues` de `Cascade.ts` **et** la fabrique
   `detachTargetFromIssues` **et** ses quatre appels — le `custom` de `vms`, celui de
   `subEquipments`, la règle `spares` **entière** (elle n'existe que pour ça) et la ligne du
   `custom` d'`equipments` (dont le reste doit survivre) — plus l'import `IssueTargets` ;
   l'entrée `INDEX_SPEC.issues` ; la spec `SEARCH_SPECS.issues` et les catalogues
   `SEARCH_CATALOGS.issueNotFound` / `issueStatusCategory` (et **incrémenter**
   `SEARCH_VERSION`, qui passe donc à **5** : retirer une collection de la spec **est** une
   évolution de spec) ; supprimer `IssueSync.ts` et `IssueTargets.ts`.
4. **Tests / build** : supprimer `Tests/modules/test-issues.js` + sa ligne dans `run.js`, les
   entrées `src-server/src/issues/*` de `tsconfig.node.json` (8 fichiers), et remettre à jour
   les goldens qui énumèrent les collections : `DETAIL_COLLECTIONS` (`test-core-store.js`), la
   liste d'index relationnels et son décompte (`test-relational-schema.js`), et la valeur
   attendue de `SEARCH_VERSION` (`test-search-terms.js`).

**Ce qui RESTE** — des primitives ajoutées au passage, utiles hors de la feature et sans
dépendance à elle :

- `Html.isSafeHttpUrl` / `Html.externalLink` (`src-client/core/Html.ts`) — la garde de schéma
  des liens sortants ; toute donnée d'origine tierce affichée en lien devrait y passer ;
- `ListView.focusTarget` — pose la dimension CIBLE d'un listing depuis l'extérieur ; utile à
  toute navigation « montre-moi les X de CET objet » ;
- le champ facultatif `name?` de `TargetFamily` (`views/ListTargets.ts`) — règle de nommage
  propre à une famille, pour les collections sans `name` ;
- le paramètre facultatif `excluded` de `ListTargetFilter.search` ;
- `SecretBox`, `AuditStamp`, `RequestAuthor`, `EntityCandidateSource` — antérieurs et partagés.

Aucun autre module ne dépend de la feature : le cœur serveur n'importe jamais `issues/`, et
côté client tout vit dans les fichiers dédiés ci-dessus.

## Ajouter un provider d'une autre marque

C'est l'**exigence structurante** du chantier : le pivot, la réconciliation, le service de
synchro, la base de config, les routes et l'UI sont **agnostiques de la marque**. Ajouter un
tracker (GitHub, GitLab, Redmine, Jira Data Center…) se fait en **quatre** points, et **rien
d'autre** ne bouge — un test d'invariant relit les sources et vérifie qu'aucun module
agnostique ne nomme une marque hors des points d'extension.

1. **L'adaptateur.** Écrire `XxxAdapter` implémentant `IssueProviderAdapter` (`test()`,
   **`resolve(extIds)`**, `lookup(reference)`, `createIssue(input)`), avec le même découpage
   que Jira : `XxxHttp` (accès réseau), `XxxParse` (décodage **PUR**, testable par fixtures),
   `XxxAdapter` (orchestration, qui déclare son besoin HTTP par une **interface
   consommateur**). Produire des `IssueRecord` normalisés — c'est le SEUL contrat que voient
   la réconciliation et l'UI. Trois obligations de mise en œuvre :
   - `ext_id` = une identité **stable au déplacement / au renommage** (jamais une clé lisible) ;
   - `resolve` **par lots**, jamais N requêtes unitaires, et un retour qui distingue `found`
     de `missing` (c'est le service qui en déduit `orphan`) ;
   - `status_category` produite chez soi si la marque ne l'expose pas (GitHub : `closed` →
     `done`), et `url` **composée** vers l'interface, pas vers l'API.
2. **La fabrique.** Ajouter une ligne dans `IssueSyncService.adapterFor` :
   `if (config.kind === "xxx") return XxxAdapter.fromConfig(config);`.
3. **La validation des options.** Ajouter une entrée dans
   `IssueProviderConfigValidate.KIND_OPTION_SPECS` déclarant les réglages propres à la marque
   (nom, type scalaire, défaut). Ils sont persistés en JSON dans la colonne `options` :
   **aucune migration de schéma**. `SUPPORTED_KINDS` en est dérivé, jamais recopié.
4. **L'UI.** Ajouter le type au `<select>` (`IssueProvidersForm.KINDS`) et ses champs
   d'option (`IssueProvidersForm.KIND_FIELDS`, **miroir exact** de l'étape 3 : mêmes noms,
   même ordre, mêmes types, mêmes défauts) + les libellés i18n correspondants dans
   `fr/issues.ts` **et** `en/issues.ts` (`providers.opt.*`). Un test confronte
   mécaniquement `KIND_FIELDS` et `KIND_OPTION_SPECS` — un miroir que personne ne vérifie
   finit par diverger.

Ce qu'il ne faut **pas** faire : ajouter une colonne à `issue-providers.db` pour un réglage
de marque, tester le `kind` ailleurs que dans la fabrique et la table d'options, faire
remonter un champ propre à la marque jusqu'au pivot `IssueRecord`, ou traduire un libellé de
statut du tracker (seule `status_category` est traduisible).

## Tests

`Tests/modules/test-issues.js` couvre, du plus pur au plus intégré :

- **la frontière partagée** `IssueSync` (défauts, catégorie clampée, étiquettes
  déterministes) et sa **délégation par le modèle client** — le verrou anti-faux-delta,
  comparé champ par champ ;
- **les clés de cible** `IssueTargets` (composition, décodage, forme) et leur **égalité avec
  `TargetSearch.key`** — la convergence de vocabulaire avec les interventions, vérifiée sans
  dépendance de code ;
- **la collection dans les mécaniques transverses** : spec (enum fermée de `status_category`,
  invariant de forme des `targets`, tolérance d'une cible inexistante), ordre de
  `Schema.COLLECTIONS` ⇄ `EntityRegistry`, `RenderImpact` ;
- **la cascade des `targets`** : les quatre familles, la **récursion** équipement →
  sous-équipement, et le cas décisif du **lot multi-suppressions du MÊME ticket** (celui que
  la composition sur le déjà planifié sauve) ;
- **la recherche** : catalogues « introuvable » et catégorie d'état **verrouillés sur les
  locales** fr/en, colonnes plates, bump de `SEARCH_VERSION`, et l'absence de requête inverse
  (aucun dérivé par cible — cf. la limite mesurée dans `SEARCH_SPECS.issues`) ;
- **`core/IssueStatus`** : catégories, **priorité de l'introuvable**, clé de tri, libellés, et
  les **pastilles** avec leur échappement (un statut porteur de balisage, une infobulle
  d'attribut) ;
- **`Html.externalLink`** : un lien sortant ne peut pas être un vecteur XSS ;
- **la dimension CIBLE** des tickets : familles, `where` d'appartenance, restriction locale, et
  le piège « equipment:E1 » ≠ « equipment:E10 » ;
- **le miroir `KIND_FIELDS` ⇄ `KIND_OPTION_SPECS`** ;
- **`core/IssueTargetSummary`** : sélection pure, ouverts, tri par récence, bornage ;
- **le décodage Jira** (`ext_id` = id interne, `url` d'interface, catégorie, alias, tolérance),
  l'**ADF**, la **pagination pure** (chaque garde-fou séparément, les DEUX formes d'API), la
  liste JQL échappée et la référence saisie ;
- **l'adaptateur** avec un client HTTP stub : `resolve` (lots, partage found/missing,
  pagination, cap dur, estampillage), `lookup` (clé, URL, 404 → null, erreurs de PROVIDER
  remontées), `createIssue` (ADF, options du provider, message d'échec **intact**), `test`
  (sonde non bloquante) ;
- **`JiraHttp`** : parties pures (Basic, `Retry-After`, extraction du message du tracker) et
  flux réel sur `fetch` **injecté** (429 borné, statuts, cap de réponse, **jeton jamais cité**) ;
- **la validation par marque** et le **stockage chiffré** sur better-sqlite3 réel (schéma, CRUD
  sans fuite de jeton, compte relu, jeton indéchiffrable) ;
- **la réconciliation** : **aucun `creates`**, orphelinat **aller-retour**, patch minimal,
  idempotence ;
- **`passScope`** : plafond de passe, ordre stable et **roulement** (aucune zone morte) ;
- **le service de bout en bout** sur `DocumentStore` réel : suivi, triptyque d'écriture,
  idempotence, introuvable, plafond, anti-rafale ; puis `openIssue` (ordre tracker → local,
  **échec partiel**, message du tracker intact, choix du provider) ;
- **les invariants** : pivot `IssueRecord` ≡ `ISSUE_SOURCE_FIELDS`, et **agnosticisme de
  marque** (aucun littéral « jira » hors des points d'extension).

Les routes (`IssueModule.ts`, Express) restent hors test, comme `api.ts`, `VmModule.ts` et
`WifiModule.ts`.
