# RÉPLICATION des incidents & interventions vers un tracker distant

> Module serveur **AMOVIBLE** `src-server/src/tracker/` : un **PONT** entre le module
> [`interventions/`](interventions.md) et un projet de tracker distant **PARTAGÉ avec
> d'autres sources**. Il ne définit **aucune collection** — il RÉPLIQUE et SUIT.
> Première implémentation : **Atlassian Jira Cloud** — mais **la marque n'est qu'un
> adaptateur** : les contrats, le service, la base de configuration, les routes et l'UI en
> sont agnostiques (cf. § « Ajouter un provider d'une autre marque »).

## Vue d'ensemble

DC Manager sait déjà déclarer et suivre ses **incidents** et ses **interventions**. Cette
feature répond à la question voisine : **comment ce travail apparaît-il dans le tracker de
l'organisation**, celui où l'exploitation, les prestataires et les autres outils déposent
déjà leurs tickets. Les objets de DC Manager sont la **SOURCE**, un projet du tracker est la
**DESTINATION**, et nos tickets y vivent **parmi ceux des autres**.

Ce que la feature fait :

- **crée** un ticket pour un incident/une intervention — automatiquement à l'enregistrement
  (option `auto_replicate` du provider) ou à la demande depuis la fiche ;
- **repousse le contenu** à chaque enregistrement suivant (titre, description, type,
  priorité, échéance, étiquettes des objets liés), **sans jamais bloquer** l'enregistrement
  local si le tracker est indisponible ;
- **adopte** un ticket EXISTANT (« Lier ») quand la référence a déjà été saisie à la main —
  jamais **deux fois le même** ticket (un ticket n'appartient qu'à une intervention) ;
- **relit** le traitement du ticket (statut, assigné) en **LECTURE SEULE**, et l'affiche sur
  la fiche et dans le listing ;
- **étiquette** chaque ticket avec les objets liés de l'intervention (`DCM-EQ-SOS13`…), de
  façon **non destructrice** pour les étiquettes des autres sources.

Ce qu'elle ne fait **pas** (v1, non-buts) : aucun **commentaire** Jira, ni en lecture ni en
écriture · aucune **transition de statut** poussée depuis DC Manager · aucun **écrasement du
statut DC Manager** par celui du tracker (les deux workflows sont indépendants) · aucune
conversion **markdown → ADF fidèle** (la description part en texte brut) · `planned_start`
**non poussé** (pas d'équivalent standard) · **jamais** de suppression de ticket, en aucune
circonstance · aucun **webhook entrant** (le retour d'état est en *pull*) · aucune
**collection de tickets étrangers** dans le document : DC Manager ne miroite pas le tracker,
il y réplique les siens · aucun adaptateur **Jira Data Center** (base d'API et
authentification différentes — ce serait un adaptateur distinct).

## 🚨 LE PARTAGE DES VÉRITÉS

C'est **la** clé de compréhension du module : chaque champ a **un seul** propriétaire, et le
sens de circulation ne s'inverse jamais.

| Direction | Quoi | Qui fait foi |
|---|---|---|
| **DC Manager → tracker** | le **CONTENU** : titre, description, type de ticket, priorité, échéance, étiquettes `DCM-*` | **DC Manager** (poussé, il **écrase** le ticket) |
| **tracker → DC Manager** | le **TRAITEMENT** : statut, assigné, clé lisible, lien | le **tracker** (relu, **lecture seule**) |

Trois conséquences, toutes assumées :

- une **édition du résumé ou de la description faite côté tracker est ÉCRASÉE** à la poussée
  suivante. C'est le prix d'une source unique : à deux vérités concurrentes sur le même
  champ, on ne saurait plus laquelle garder, et la « fusion » d'un texte libre n'existe pas ;
- le **`status` DC Manager n'est JAMAIS poussé** et le statut du tracker **n'écrase jamais**
  le statut DC Manager. Les deux cycles de vie coexistent, sans ping-pong possible : clore un
  ticket dans le tracker ne clôt pas l'intervention, et réciproquement ;
- ce que le tracker sait et que DC Manager ignore (**assigné**) est **affiché** et **jamais
  modifiable** ici : DC Manager n'a pas de notion d'assignation.

C'est aussi ce partage qui découpe le code : côté client, `core/TrackerStatus` classe l'état
du **TICKET** (le tracker fait foi) et `core/TrackerReplication` décrit ce que DC Manager
sait de **SA** réplication (répliquée ou non, poussée à jour / en attente / en échec).

## Le cycle de POUSSÉE tolérante

L'enregistrement d'une intervention **réussit tracker éteint**. La poussée est une
**conséquence asynchrone**, jamais une condition : le hook d'écriture marque la poussée
**DUE** dans une colonne **persistée**, puis rend la main — le `PUT` a déjà répondu.

```
création / PUT d'une intervention répliquée (ou auto_replicate)
        │  hook onWrite → markPushDue (colonne PERSISTÉE), retour IMMÉDIAT
        ▼
    pending ─────── poussée OK ──────► synced
        │                                ▲
        └── échec (réseau / refus) ──► error  (message du tracker, INTACT)
                                         │  rejoué à CHAQUE passe périodique du provider
                                         │  + action manuelle « Mettre à jour le ticket »
                                         └────────── succès ──────────┘
```

- `tracker_push_state` ∈ `pending` | `error` | `synced` (`null` = jamais poussée). `error`
  est un état **STABLE**, pas une rafale : il est rejoué à la passe suivante et par l'action
  manuelle, **jamais en boucle immédiate** — un champ refusé en permanence ne doit pas
  marteler le tracker ;
- l'état étant **persisté**, un **redémarrage du serveur ne perd aucune poussée** : le
  **ramassage au démarrage** (`TrackerSyncService.sweepPushDue`, lancé par
  `TrackerModule.start()` **sans être attendu**) balaye `listPushDue()` **sans document** —
  donc **tous** les documents — et rejoue les poussées dues, provider par provider. Sans lui,
  la persistance ne servirait qu'aux providers **périodiques** : un provider en mode **manuel**
  (`interval_sec = 0`, le défaut) n'a ni timer ni geste automatique, et une poussée interrompue
  par un `docker stop` y dormirait jusqu'à la prochaine édition de l'objet. Le balayage ne fait
  que la moitié **poussée** du pont (le retour d'état ne rattrape rien, il rafraîchit), prend le
  **même verrou d'anti-chevauchement** que les passes, n'enregistre **aucun statut** de provider
  (poser un `last_attempt` ferait refuser par l'anti-rafale le premier « Synchroniser » de
  l'opérateur) et **ne jette jamais** : le serveur démarre normalement **tracker éteint** ;
- la **relecture au moment de pousser** est délibérée (`TrackerSyncService.pushOnce` relit
  l'intervention, il ne capture rien au moment du hook) : une édition concurrente pendant l'appel
  distant **gagne** (« dernier état gagne »), et l'inverse pousserait une version périmée ;
- 🚨 **les poussées d'une MÊME intervention sont SÉRIALISÉES** (`TrackerSyncService.pushIntervention`,
  champ `pushing`). La poussée n'étant pas attendue, tout autre événement du serveur entre pendant
  l'appel distant : un second enregistrement (corriger une coquille juste après avoir enregistré
  suffit), un « Synchroniser », une passe périodique. Deux poussées concurrentes d'une intervention
  **pas encore répliquée** reliraient toutes deux un `tracker_ext_id` **vide** et créeraient chacune
  un ticket — un **doublon chez un tiers**, que la doctrine « jamais de suppression distante » rend
  irrattrapable. Une poussée demandée pendant une autre n'est pas pour autant **perdue** : elle est
  **fusionnée** avec celle en cours, qui **rejoue une fois de plus** à la fin avec l'intervention
  relue — sans quoi le contenu poussé resterait celui d'avant la dernière édition alors que l'état
  passerait à `synced`. Chaque rejeu correspond à une demande réelle : ce n'est pas une rafale ;
- 🚨 **la clé créée est écrite AVANT tout le reste.** `createRemote` enregistre l'identité
  (`tracker_provider_id`, `tracker_ext_id`, `jira_ref`, `tracker_url`) **d'abord**, et
  seulement ensuite l'état de poussée et le statut. Si l'écriture locale échoue **après** la
  création distante, le ticket **existe** : la clé survit alors dans le message d'échec
  persisté, avec la marche à suivre. **Jamais** de suppression compensatoire chez le tracker —
  on ne détruit pas dans un système tiers pour rattraper notre propre écriture.

> 🚨 **ÉCHEC PARTIEL DE CRÉATION — pourquoi il ne fabrique pas un ticket par passe.** Une
> création distante **réussie** dont l'écriture locale **échoue** (base verrouillée, disque
> plein) laisse la ligne en `error` avec un `tracker_ext_id` **vide**. Or c'est exactement sur
> ce vide que la poussée décide de **créer** : la ligne étant toujours due, chaque passe
> suivante fabriquerait un ticket **de plus** dans un projet **partagé** — 12 par heure à
> `interval_sec = 300`, tous irrattrapables (aucune suppression distante). Le pont **mémorise**
> donc l'identité rendue par le tracker (`TrackerSyncService.createdIdentities`, clé
> `[docId, interventionId]`), **avant** de tenter l'écriture locale ; toute poussée ultérieure
> de cette intervention **rejoue l'écriture d'identité**, jamais la création, puis reprend son
> cours en **mise à jour**. L'entrée disparaît dès que l'identité est en base — par le
> rattrapage, par la voie nominale, ou par un **autre chemin** (liaison manuelle) — et à la
> suppression de l'intervention.
>
> ⚠ **Limite résiduelle assumée** : cette mémoire est **en mémoire** (comme le statut et les
> curseurs de roulement). Un **redémarrage** du serveur la perd, et une ligne restée `error`
> sans identité refait alors **une** création — **une seule**, jamais la boucle sans fin. La
> persister demanderait une colonne dans `interventions.db`, une base que ce module ne possède
> pas : un coût sans commune mesure avec la rareté de l'incident.
> **Exploitation** : surveiller dans le journal serveur la ligne `ÉCHEC PARTIEL — ticket créé,
> identité non enregistrée` (niveau **erreur**). Elle porte la **clé** du ticket, que le message
> d'erreur **persisté** sur la fiche répète. Si le serveur a redémarré entre-temps, le ticket
> laissé derrière est **orphelin** : le **fermer** chez le tracker, ou le reprendre sur une
> intervention en saisissant sa clé puis « Répliquer » en mode **liaison**.

**Ce qui déclenche une poussée** (`TrackerSyncService.markPushDue`) :

| Situation à l'écriture | Effet |
|---|---|
| intervention **déjà répliquée** (`tracker_ext_id` posé) | `pending` → mise à jour du contenu |
| non répliquée, **aucun** provider en `auto_replicate` | rien (réplication à la demande) |
| non répliquée, **un seul** provider en `auto_replicate` | provider posé + `pending` → création |
| non répliquée, **plusieurs** providers en `auto_replicate` | ⚠ **rien**, et c'est **journalisé** (`warn`) : une intervention = UN ticket, et rien ne permet de choisir un tracker à la place de l'utilisateur. L'action « Répliquer » désigne le provider |
| non répliquée mais **référence déjà saisie** (`jira_ref` non vide) | rien, **journalisé** (`info`) : créer produirait un doublon du ticket visé — c'est l'action « Lier » qui s'applique |
| **suppression** d'une intervention | rien côté tracker (doctrine « jamais de suppression distante ») ; le ticket sort simplement de l'assiette du retour d'état |

> ⚠ **Reprise — les trois chemins, et le trou qui reste.** Une poussée `pending`/`error` est
> rejouée : ① au **démarrage du serveur**, par le ramassage global (tous documents, tous
> providers, `interval_sec` compris **à 0**) ; ② par la **passe périodique** du provider, s'il a
> un `interval_sec` > 0 ; ③ par un geste — « Synchroniser » de l'en-tête, ou « Mettre à jour le
> ticket » sur la fiche.
> ⚠ Il reste donc **un** cas non couvert, et c'est délibéré : un échec survenu **en cours de
> fonctionnement** chez un provider en mode **manuel** (`interval_sec = 0`) attend un geste — ni
> le ramassage (déjà passé) ni un timer (inexistant) ne le reprendront avant le prochain
> redémarrage. C'est le comportement voulu du mode manuel ; il se règle en posant un intervalle.

## Architecture — qui fait quoi

### Serveur (`src-server/src/tracker/` — le cœur n'importe JAMAIS ce dossier)

| Fichier | Rôle |
|---|---|
| `TrackerProvider.ts` | **Contrats purs** et frontière d'agnosticisme : pivot `TrackerTicketState`, `TrackerResolution`, `TrackerPushContent`, `TrackerProviderConfig`/`Summary`/`ConfigSource`, `TrackerProviderAdapter`, catégories fermées `TRACKER_STATUS_CATEGORIES`, états `TRACKER_PUSH_STATES`, **et** la surface attendue du module interventions (`InterventionTrackerSource`, cf. plus bas). |
| `TrackerProviderConfigValidate.ts` | Validation **PURE** d'un provider : champs **communs** + **branche d'options par `kind`** (`KIND_OPTION_SPECS`). Point d'extension « marque » n°1. |
| `TrackerProviderConfigDb.ts` | Stockage `tracker-providers.db` (SQLite dédiée, **table unique**), jetons **chiffrés** (`SecretBox`), deux surfaces de lecture (synchro / CRUD UI). |
| `TrackerLabels.ts` | Étiquettes `DCM-*` : familles, normalisation, **DIFF en verbes** qui n'effleure jamais les étiquettes étrangères. Module **PUR**. |
| `TrackerPassScope.ts` | Périmètre d'**UNE passe** : plafond **ROULANT** à fenêtre circulaire. Module **PUR**, paramétré par **noms de champ** (il borne la poussée comme le retour d'état). |
| `TrackerSyncService.ts` | Le moteur : hook d'écriture, actions manuelles (répliquer / lier / re-pousser), composition du contenu, poussée (sérialisée par intervention, **mémoire des identités créées**), retour d'état, plafonds, **ramassage au démarrage**, timers, anti-rafale, statut mémoire, signalement `notify`, publication live. Porte la **fabrique `adapterFor`** — point d'extension « marque » n°2. |
| `TrackerModule.ts` | Façade + routes Express `/documents/:docId/tracker/*`, 503 actionnables, audit d'auteur sur les actions manuelles, réinjection des providers au jeton indéchiffrable dans le statut. |
| `JiraHttp.ts` | **Jira** : `fetch` **injecté**, auth **Basic**, respect du `Retry-After` (429) borné, plafond de réponse, erreurs traduites — le jeton n'apparaît nulle part. |
| `JiraParse.ts` | **Jira** : décodage **PUR et TOLÉRANT** (état, alias de champs, catégorie de statut, pagination bi-forme, `browseUrl`, référence saisie), table de **priorités**, `toAdf`, lecture des **refus par champ**. |
| `JiraAdapter.ts` | **Jira** : orchestration (chemins d'API, lots, pagination, composition des corps, repli « priorité refusée ») — déclare son besoin HTTP par l'interface `JiraJsonClient`. |

### Les DEUX modifications de `interventions/`

Le module interventions **n'importe RIEN** de `tracker/`. Il porte exactement deux choses :

1. **Les colonnes `tracker_*` d'`interventions.db`** (`InterventionsDb`), déclarées dans la
   liste unique `TRACKER_COLUMNS` — qui sert **à la fois** au DDL (migration `ensureColumn`
   idempotente) et à la **liste blanche d'écriture** d'`applyTrackerState`. Trois règles
   gouvernent ces colonnes :
   - `save()` **ne les touche jamais** (absentes du `DO UPDATE SET`) : une écriture
     utilisateur ne peut ni poser ni effacer un état de réplication, et un client qui les
     enverrait dans un `PUT` est simplement **ignoré**, comme l'audit ;
   - `applyTrackerState()` **ne touche jamais** `updated_by`/`updated_date` : le retour
     d'état n'est pas une édition de l'utilisateur. Sans cette règle, chaque passe ferait
     remonter en tête d'un listing trié par activité des objets que personne n'a modifiés ;
   - la **seule** colonne hors `tracker_*` que le pont écrit est **`jira_ref`**
     (`TRACKER_PATCH_COLUMNS`) : la clé lisible va là où l'utilisateur la cherche déjà.

   | Colonne | Rôle |
   |---|---|
   | `tracker_provider_id` | provider de réplication (`null` = non répliquée) |
   | `tracker_ext_id` | 🚨 identifiant **INTERNE** du ticket — jamais la clé (elle change au déplacement de projet) |
   | `tracker_status` | libellé de statut **BRUT**, affiché tel quel et jamais traduit |
   | `tracker_status_category` | catégorie **fermée** `todo`/`in_progress`/`done`/`unknown` (pastille, tri) |
   | `tracker_assignee` | assigné côté tracker (affichage) |
   | `tracker_url` | lien d'**interface** du ticket, persisté tel que composé par l'adaptateur |
   | `tracker_last_sync` | dernier retour d'état réussi (ISO) |
   | `tracker_push_state` | `synced` / `pending` / `error` |
   | `tracker_push_error` | dernier message d'échec de poussée (celui du tracker, **intact**) |

   Deux index servent les deux assiettes du pont : `(doc_id, tracker_ext_id)` pour le retour
   d'état, `(doc_id, tracker_push_state)` pour les poussées dues.

2. **Le hook `onWrite`** (`InterventionsModule`) : un rappel **OPTIONNEL**
   `(docId, id, "put" | "delete")` appelé **après** chaque écriture réussie et après la passe
   du veilleur de rappels, sous `try/catch` — l'abonné est un module tiers, et son échec ne
   doit pas transformer un enregistrement réussi en 500. Sans pont branché, le module se
   comporte exactement comme s'il n'existait pas.

### Le câblage — `index.ts`, et lui seul

**Les deux modules se pointent l'un l'autre SANS jamais s'importer**, chacun par une
interface déclarée **CHEZ LUI** (dépendance inversée des DEUX côtés) :

- `tracker/` déclare `InterventionTrackerSource` — quatre méthodes, pas une de plus :
  `listTracked(docId)` (l'assiette du retour d'état), `listPushDue(docId?)` (les poussées
  dues), `getOne(docId, id)` (relecture au moment de pousser),
  `applyTrackerState(docId, id, patch)` (écriture d'état sans audit) ;
- `interventions/` expose `onWrite` et satisfait la surface ci-dessus **structurellement**
  (la façade `InterventionsModule` relaie vers `InterventionsDb` ; module en erreur ⇒
  réponses neutres, jamais d'exception) ;
- `index.ts` fait correspondre les deux. La boucle de construction se dénoue par une
  **fermeture** : `onWrite` lit une variable `tracker` affectée quelques lignes plus bas —
  pont absent ⇒ `null` ⇒ rappel inerte.

Le `DocumentStore` (le cœur, autorisé) est la seule autre dépendance du service : il sert
**uniquement** à résoudre les objets liés pour composer les étiquettes.

### Client (`src-client/`)

| Fichier | Rôle |
|---|---|
| `core/TrackerStatus.ts` | **PUR** : catégorie normalisée, priorité de l'« introuvable », couleur, clé de tri, libellés localisés et **PASTILLE** de statut (source unique, listing **et** fiche). |
| `core/TrackerReplication.ts` | **PUR**, sans i18n (rend des **CLÉS**) : répliquée ou non, état de poussée + classe de badge, message d'échec, **arbitrage de l'URL** du ticket. |
| `views/forms/TrackerSyncClient.ts` | Client REST dédié des routes du module (`TrackerSyncError` porte le code HTTP, le `detail` et la **clé** d'un ticket créé malgré l'échec). |
| `views/forms/TrackerProvidersForm.ts` | Modale « Providers… » (liste ⇄ formulaire), champs de marque déclarés dans `KIND_FIELDS` — miroir **vérifié par test** de `KIND_OPTION_SPECS`. |
| `views/forms/TrackerTicketBlock.ts` | Bloc « Ticket » de la fiche de détail d'une intervention (état, actions, confirmation d'adoption). |
| `views/InterventionsAdminView.ts` | **Branchements fins** seulement : deux actions d'en-tête, l'enrichissement de la colonne « Jira », un conteneur dans la fiche, la relecture-repeinte après action. |

`tracker` (le client REST) est **null** en mode fichier et en viewer : tout ce qui précède
disparaît alors **sans une condition de plus** dans la vue.

## Mapping des champs

Composé par `TrackerSyncService.composeContent` (côté générique) puis traduit dans le
vocabulaire de la marque par l'adaptateur.

| DC Manager | Jira | Notes |
|---|---|---|
| `kind` | `issuetype` | via les options `type_incident` / `type_intervention`. Une nature inconnue retombe sur le type des interventions (un ticket au mauvais type est visible et corrigeable ; une réplication refusée ne l'est pas). **Non repoussé à la mise à jour** : changer le type d'un ticket existant est une opération à part entière côté Jira, et la nature d'un objet DC Manager est figée à la création |
| `title` | `summary` | **obligatoire** : un titre vide fait échouer la poussée avant tout appel réseau |
| `description` (markdown) | `description` (**ADF**) | v1 : le markdown **source** part en **texte brut** via `JiraParse.toAdf` (un document ADF à paragraphes, jamais une chaîne — l'API v3 la refuserait). Une conversion markdown → ADF fidèle est un chantier en soi |
| `priority` | `priority` | table **FIXE** : `low → Low`, `normal → Medium`, `high → High`, `critical → Highest` ; un slug hors table ⇒ **aucune** priorité poussée (jamais une priorité inventée). ⚠ **Retente sans priorité** : si le projet **refuse le champ** (typiquement un projet *team-managed* qui n'en a pas), la requête est rejouée **UNE fois** sans lui et le **dégradé** est signalé — la poussée réussit, elle n'échoue pas |
| `planned_end` | `duedate` | partie **DATE** seule (`YYYY-MM-DD`), calculée en **UTC** (convertir dans le fuseau du serveur ferait basculer l'échéance d'un jour selon l'endroit où il tourne). À la mise à jour, `duedate: null` **VIDE** le champ : une échéance retirée dans DC Manager disparaît du ticket |
| `planned_start` | — | **omis** : pas d'équivalent standard côté Jira |
| liens (`intervention_links`) | `labels` | étiquettes `DCM-*`, en **verbes** add/remove (cf. § suivant) |
| `status` DC Manager | — | **JAMAIS poussé** (cf. « Le partage des vérités ») |

Un **refus du tracker** remonte **TEL QUEL** jusqu'à la colonne `tracker_push_error` et
jusqu'à la fiche : c'est lui qui est actionnable (« le champ X est requis »), une enveloppe
générique le rendrait inexploitable. Les champs obligatoires par projet ne sont **pas
devinés** (aucun appel à `createmeta`) : deviner produirait un formulaire faux, alors que le
refus, lui, est juste.

## 🚨 Étiquettes `DCM-*` — le projet est PARTAGÉ

Les objets liés à une intervention partent vers le tracker sous forme d'**étiquettes
lisibles**, pour servir de **tag de recherche** côté tracker (« tous les tickets qui touchent
SOS13 »).

- **Format** : `DCM-<FAM>-<NOM>` où `FAM` ∈ `EQ` (equipment), `VM` (vm), `SP` (spare),
  `SEQ` (sub_equipment) — table unique `TrackerLabels.FAMILIES`, qui porte aussi la
  collection où résoudre le nom. Une famille inconnue est **ignorée** (aucune étiquette,
  aucune exception : les liens d'intervention sont des couples opaques, sans FK) ;
- **c'est le NOM de l'objet qui part**, pas son identifiant (choix explicite : `DCM-EQ-SOS13`
  se lit et se cherche, `DCM-EQ-9f3c1e…` non). Contrepartie assumée : un objet **renommé**
  change d'étiquette à la poussée suivante (l'ancienne est retirée, la nouvelle ajoutée) —
  l'étiquette est un **TAG**, jamais une clé étrangère ;
- **normalisation** (`TrackerLabels.normalizeName`, une étiquette n'admet pas d'espace) :
  minuscules + **accents retirés** par `Schema.normSearch` (la MÊME règle que la recherche du
  cœur), puis **ligatures** `œ`/`æ` → `oe`/`ae` (elles n'ont aucune décomposition canonique et
  survivraient à la décomposition NFD : « SW Cœur 01 » donnerait sinon `SW-C-UR-01`), puis
  **CAPITALES**, tout caractère hors `[A-Z0-9-]` → `-`, tirets multiples fondus, tirets de
  bord retirés, nom **borné** à `MAX_NAME_CHARS` = 80 caractères. Deux noms voisins peuvent
  donc produire la même étiquette : acceptable pour un tag de recherche ;
- **déduplication** et **ordre des liens** conservés (`compose`) ; une cible **disparue**
  (lien orphelin, toléré côté interventions) ne produit **aucune** étiquette — ni son
  identifiant brut (illisible), ni une étiquette « introuvable » (qui polluerait le projet).

**L'invariant qui protège les autres sources** : le pont ne connaît, ne compare et ne retire
**QUE** le sous-ensemble préfixé `DCM-` (`isManaged`, comparaison **insensible à la casse** —
un tracker peut normaliser la casse, et une étiquette qu'on ne reconnaîtrait plus se
ré-ajouterait indéfiniment). `TrackerLabels.diff(desired, current)` filtre les étrangères
**avant** toute comparaison : elles ne peuvent donc apparaître **dans aucun des deux verbes**,
par construction et non par vigilance. Le jeu désiré est filtré lui aussi — une étiquette
désirée sans préfixe serait ajoutée sans jamais pouvoir être retirée, c'est-à-dire une fuite
permanente dans le projet d'autrui.

La mise à jour passe donc par les **VERBES d'édition** du tracker
(`update.labels: [{add}, {remove}]`) et **jamais** par un remplacement du tableau `labels` —
ce qui évite au passage toute course lecture-modification-écriture. La relecture du ticket
qui précède une mise à jour n'est pas un confort : c'est elle qui donne les **étiquettes
courantes**, seule base d'un diff exact.

> ⚠ **Limite assumée** : une source tierce qui poserait délibérément des étiquettes `DCM-*`
> verrait les siennes retirées. Aucun préfixe n'est garantissable unique dans un projet
> partagé ; le seul remède serait de mémoriser localement les étiquettes posées, c'est-à-dire
> d'ajouter un état à resynchroniser à chaque divergence.

## Retour d'état (lecture seule)

Une **passe** de synchro traite un couple document×provider et fait **deux choses, dans cet
ordre** — une création faite en ① entre dans l'assiette de ② dès la même passe :

1. **les poussées DUES** (`tracker_push_state` ∈ `pending`/`error`) du provider ;
2. **le retour d'état** : `adapter.resolve(extIds)` **PAR LOTS** sur l'assiette (les
   interventions à `tracker_ext_id` non nul). Un tracker sait résoudre N identifiants en une
   requête ; N requêtes unitaires font la différence entre une passe à 3 appels et une passe
   à 300.

Un échec de poussée **n'interrompt pas** la passe : les deux moitiés du pont sont
indépendantes, et une panne d'écriture ne doit pas priver l'opérateur de la lecture. Le
statut de la passe rend les deux jeux de compteurs **séparément** (`push_due`, `pushed`,
`push_failed`, `push_skipped` · `tracked`, `queried`, `updated`, `missing`, `unchanged`,
`skipped`) : une poussée en échec et un retour d'état parfait ne doivent pas se compenser
dans un résumé. `last_success` n'avance **que** sur une passe entièrement réussie.

**Un ticket n'appartient qu'à UNE intervention.** L'assiette du retour d'état est indexée **par
identité distante** : si deux interventions du même document portaient le même
`tracker_ext_id` chez le même provider, la seconde écraserait la première dans l'index et
l'une des deux cesserait **silencieusement** d'être rafraîchie — sans erreur, sans journal,
sans rien à voir dans l'UI. L'invariant est tenu **à la source**, par la seule voie qui puisse
le rompre : l'adoption d'un ticket **existant** (`linkExisting`) est **refusée** — `409`, en
**nommant** l'intervention qui le porte déjà — quand ce ticket est déjà lié. Le contrôle porte
sur l'identité **interne**, résolue par le tracker : deux références saisies différemment (clé,
URL collée, clé d'avant un déplacement de projet) désignent le même ticket.

**Idempotence.** Chaque ticket résolu est comparé champ à champ (statut, catégorie, assigné,
URL, et la **clé** — elle suit le ticket, un déplacement de projet la change). Si rien n'a
bougé, **aucune écriture** : la passe compte l'objet en `unchanged` et passe au suivant.

**Introuvable.** Un identifiant demandé et non revenu (ticket supprimé, projet archivé,
permission perdue) fait écrire la **sentinelle** `TrackerSyncService.NOT_FOUND_STATUS` =
`"introuvable"` dans le statut brut, avec la catégorie `unknown`. **Jamais** de suppression
locale, **jamais** de re-création automatique : l'intervention porte des liens, une
description et un cycle de vie que le tracker ne connaît pas, et elle reviendra d'elle-même
si l'accès est rétabli. Le client **reconnaît** cette sentinelle
(`TrackerStatus.NOT_FOUND_STATUS`, duplication verrouillée par test) pour afficher un libellé
**localisé** et une pastille d'**avertissement**.

### Le plafond ROULANT, et pourquoi il roule

Les deux moitiés sont plafonnées : `MAX_PUSHES_PER_PASS` = **50** (une poussée coûte 1 à 2
requêtes **écrivantes**, et tracker éteint chacune consomme tout le délai de la requête) et
`MAX_TICKETS_PER_PASS` = **500** (5 lots de 100). Contrairement aux modules `vm/` et `wifi/`,
où la source borne naturellement le volume, **l'assiette est ici pilotée par l'utilisateur** :
rien n'empêche un document de répliquer des milliers d'interventions.

Le réflexe serait de trier par « le moins récemment synchronisé d'abord » et de prendre les N
premiers. ⚠ **Ce réflexe est FAUX ici, et le défaut est SILENCIEUX** : la synchro étant
**idempotente**, `tracker_last_sync` n'est écrit que sur un objet qui a **changé**. Sur une
assiette stable — le cas nominal — aucun `last_sync` ne bouge, l'ordre reste identique d'une
passe à l'autre, et la **queue de l'assiette n'est jamais interrogée**. Zone morte permanente,
qu'aucun journal ne signale puisque chaque passe se termine « normalement ».

D'où `TrackerPassScope.compute` : ordre stable (champ de fraîcheur croissant, les jamais
synchronisés d'abord, départage par identité) **plus** une **fenêtre circulaire** partant d'un
curseur mémorisé — `nextStart` dit où reprendre. L'assiette entière défile en ⌈N/plafond⌉
passes, que quelque chose change ou non. Deux curseurs **indépendants** par couple
document×provider (`push` et `pull` ne parcourent pas la même liste), clés sérialisées en
**JSON** (ni un id de document ni un id de provider n'ont de jeu de caractères garanti). Ce
qui est tronqué est **journalisé** et **remonté dans le statut**.

Sur la phase de poussée, le champ d'ordre est `tracker_push_state` : `error` trie **avant**
`pending`, donc les échecs anciens repassent d'abord — et le roulement garantit que la queue
de file finit toujours par être servie.

### Timers, anti-rafale, signalements

- **Timers** : un par couple document×provider dont `interval_sec` > 0, `unref` (ils ne
  retiennent pas le process). La configuration est **relue à chaud** après chaque écriture
  CRUD (`rearmTimers`) : plus de redémarrage nécessaire ;
- **anti-chevauchement** : un couple déjà en cours n'est pas doublé (timer ↔ synchro
  manuelle) ; sans état antérieur, un statut **synthétique** « synchronisation déjà en cours »
  est rendu **sans être stocké** — le stocker figerait un `ok: true` trompeur ;
- **anti-rafale** : sous `DEFAULT_MIN_INTERVAL_SEC` = **10 s** depuis la dernière tentative,
  le dernier statut est rendu **annoté** au lieu de relancer une passe complète (un
  `interval_sec` inférieur est de fait plafonné par ce délai) ;
- **notifications** : chaque passe en échec lève `tracker-sync-failure` (clé stable
  `tracker-sync:<docId>:<providerId>`, sévérité `error`, corps = le résumé **sans jeton**) et
  chaque retour à la normale la clôt. Tout l'anti-spam vit dans le moteur `notify` — le
  producteur ne compte rien. Le rapporteur est **optionnel** ;
- **live** : après une passe qui a écrit (`updated` ou `pushed` > 0) et après chaque action
  manuelle réussie, le pont publie l'événement du module interventions
  (`changeset.modules: ["interventions"]`) : les **autres** clients rafraîchissent pastilles
  et listings sans recharger le document (`interventions.db` est hors révision du cœur, le
  `ReloadPlanner` ignore ce marqueur). Le bus est **optionnel**.

## Configuration des providers (par document)

Un provider = **une instance de tracker + un projet de destination**. Champs communs à toute
marque, options propres à la marque.

| Champ | Requis | Défaut | Notes |
|---|---|---|---|
| `id` | oui | — | immuable après création (référencé par `interventions.tracker_provider_id`) |
| `kind` | oui | — | doit être un type **connu** (`jira`) — sinon la validation refuse, en listant les types supportés |
| `url` | oui | — | **https obligatoire** : le jeton voyage en en-tête d'autorisation à chaque requête |
| `account` | oui | — | moitié **PUBLIQUE** de l'identification (Jira Cloud : l'adresse e-mail du compte). **Relue et réaffichée** à l'édition, contrairement au jeton |
| `token` | oui à la création | — | jeton d'API, **chiffré au repos**, jamais relu ni renvoyé |
| `interval_sec` | non | `0` | `0` = synchro **manuelle** uniquement. ⚠ À régler **haut** en usage réel : l'état d'un ticket n'a pas la volatilité d'un client wifi |
| `timeout_sec` | non | `20` | délai d'UNE requête. Plus généreux que les 15 s de `vm/`/`wifi/` : ici une requête est une **recherche** SaaS (jusqu'à ~100 identifiants) qui traverse Internet |
| `options.project_key` *(Jira)* | **oui** | `""` | clé du **projet de destination**. **REQUIS** : sans projet, un provider de réplication n'a littéralement rien à faire |
| `options.type_incident` *(Jira)* | non | `"Incident"` | type de ticket des objets `kind: incident` |
| `options.type_intervention` *(Jira)* | non | `"Infrastructure"` | type de ticket des objets `kind: intervention` |
| `options.auto_replicate` *(Jira)* | non | `true` | réplication **automatique** à l'enregistrement. Défaut vrai : configurer un provider de réplication, c'est vouloir que les interventions y arrivent |

⚠ Les **libellés de type** dépendent de la configuration du projet **et de sa langue** : ce
sont des **réglages**, pas des énumérations — ils ne sont donc contraints à aucune liste
(seulement à « non vide »). Un type inconnu du projet fait **refuser la création**, et le
message du tracker remonte intact.

⚠ **Plusieurs providers en `auto_replicate` sur le même document ⇒ AUCUNE réplication
automatique**, et le fait est **journalisé** (cf. le tableau du § « poussée tolérante »). La
réplication se fait alors par l'action manuelle, qui désigne le provider.

Les **options** sont persistées en **JSON** dans une colonne `options` : c'est ce qui permet
d'ajouter une marque **sans toucher au schéma de la base**. Une option **non déclarée** est
écartée silencieusement (une option d'une autre marque, ou d'une version antérieure, ne doit
pas rendre une config irrécupérable) ; une option déclarée mais **mal typée** est une erreur
explicite.

### Stockage : `tracker-providers.db` (chiffrée)

Base SQLite **dédiée au module**, dans `DOCS_DIR` (à côté de `registry.db`, `vm-providers.db`
et `wifi-providers.db`) — jamais une table de `registry.db`. **Une seule table**
`tracker_providers`, PK `(doc_id, id)`, colonne `token_enc` (jeton **chiffré**), colonnes
d'audit `created_by`/`updated_by` posées **par le serveur**.

**Aucune** colonne `fingerprint`/`ca_pem`, contrairement à `vm/` et `wifi/` : ce matériel de
confiance TLS existe là-bas parce que les consoles Proxmox/UniFi sont massivement en
certificat auto-signé. Un tracker SaaS est un service public à certificat valide — les
demander ferait saisir un réglage sans emploi et laisserait croire que ce transport sait s'en
servir : il ne sait pas (`JiraHttp` est bâti sur `fetch`, pas sur `node:https`).

Invariants de sécurité (les mêmes que `vm/` et `wifi/`) :

- `listFor` ne renvoie **jamais** le jeton — seulement `has_token: true` ;
- le chemin **STATUT** ne fait circuler **aucun** jeton (`summariesFor` : le clair déchiffré
  ne sert qu'à vérifier la déchiffrabilité, puis il est jeté) ;
- un jeton **indéchiffrable** exclut CE provider de la passe et mémorise une erreur
  consultable — **jamais** de `throw` global qui ferait tomber la synchro des autres ;
- aucun jeton, clair ou chiffré, n'apparaît dans un log, un message d'erreur ou une réponse.

### Chiffrement — `DCMANAGER_SECRETS_KEY` (coffre serveur PARTAGÉ)

Le module utilise **la même clé** que `vm/`, `wifi/` et `notify/`, via le `SecretBox` serveur
partagé (AES-256-GCM). **C'est voulu** : une seule clé d'infrastructure à distribuer, protéger
et faire tourner. Passphrase de **16 caractères minimum** (la dérivation est un SHA-256
direct : toute la robustesse repose sur la longueur du secret).

> 🚨 **MODÈLE DE MENACE ÉLARGI par rapport aux modules d'INVENTAIRE.** Le jeton stocké ici
> n'est **pas en lecture seule** : le contrat d'adaptateur porte une **création** de ticket et
> sa **mise à jour**. Un serveur compromis peut donc **écrire** chez le tracker (créer des
> tickets, réécrire le contenu de ceux que DC Manager gère). D'où la recommandation, qui n'est
> pas une formalité : **un compte de service DÉDIÉ**, aux droits limités au **projet cible**,
> jamais un compte nominatif d'administrateur. Le chiffrement protège les **copies** de la
> base (backups, exfiltration du fichier), pas un attaquant qui contrôle l'hôte.

### Clé absente / config invalide (503)

- **clé absente** → module inactif : **toutes** les routes répondent `503` avec un `detail`
  actionnable (« définir `DCMANAGER_SECRETS_KEY`… »), et le **hook d'écriture devient un
  no-op**. Si une `tracker-providers.db` existe **déjà** sans clé, le message est enrichi (des
  jetons chiffrés attendent la clé) ;
- **clé présente mais trop courte, ou base illisible** → module « démarré en erreur », routes
  en `503` avec le détail. Le serveur démarre normalement.

⚠ **Le module interventions reste PLEINEMENT fonctionnel** dans les deux cas : le pont est un
supplément, jamais une dépendance.

### Dépannage — clé CHANGÉE (jetons indéchiffrables)

Symptômes : les providers concernés disparaissent des passes, le statut les **réaffiche en
erreur** avec « le secret doit être ressaisi » (ils sont réinjectés exprès — sans cela ils
disparaîtraient silencieusement de l'UI), et « Tester » répond `422` avec le même message.
Correctif : rouvrir « Providers… », **ressaisir le jeton d'API** de chaque provider,
enregistrer. Rien d'autre n'est perdu (URL, compte, options, intervalles sont en clair).

## Routes REST

Toutes montées sous la **garde d'accès** de l'API, **scopées par document**
(`mergeParams`). `404` si le document est inconnu ; `503` si le pont est indisponible (clé
absente ou module en erreur).

| Méthode | Chemin | Effet et codes |
|---|---|---|
| `POST` | `/documents/:docId/tracker/sync` | passe complète (poussées dues + retour d'état) sur **tous** les providers du document → `{ providers }` ; `500` sur échec interne inattendu |
| `GET` | `/documents/:docId/tracker/status` | état par provider (mémoire serveur), enrichi des providers au jeton indéchiffrable → `{ providers }` |
| `POST` | `/documents/:docId/tracker/replicate/:interventionId` | réplication **manuelle**. Corps : `{ provider_id? }` (**requis** si le document a plusieurs providers), `{ link: true }` ⇒ **LIER** le ticket déjà désigné par la référence de l'intervention au lieu d'en créer un. Succès → `{ ok, provider_id, ext_id, key, message }` ; refus → `404` (intervention inconnue), `409` (déjà répliquée, **ou** ticket déjà lié à une **autre** intervention du document — le message la nomme), `400` (demande incomplète/incohérente), `422` (le **tracker** a refusé) |
| `POST` | `/documents/:docId/tracker/push/:interventionId` | « Mettre à jour le ticket » — reprise d'un échec de poussée. Mêmes codes que ci-dessus |
| `GET` | `/documents/:docId/tracker/providers` | liste **sans** jeton (`has_token: true`) |
| `PUT` | `/documents/:docId/tracker/providers/:id` | créer/mettre à jour → `{ provider }` ; `400` + `issues` si invalide ; `500` sur échec d'écriture. Jeton vide/absent ⇒ **conserver** l'existant |
| `DELETE` | `/documents/:docId/tracker/providers/:id` | supprimer → `{ ok: true }` ; `404` si l'id est inconnu |
| `POST` | `/documents/:docId/tracker/providers/test` | tester une config **candidate** → `{ info }` ; `400` si invalide ou `kind` inconnu ; **`422`** si le jeton **stocké** est indéchiffrable (requête bien formée, donnée stockée inexploitable — c'est ce message que « Tester » affiche) ; `500` sur échec inattendu |

🚨 Sur les actions manuelles, la **clé du ticket accompagne la réponse MÊME en échec** quand
un ticket a réellement été créé : c'est la seule information qui rende la situation
rattrapable (l'utilisateur le **lie** ensuite). Le **code HTTP** est dérivé de la **nature** du
refus (`TrackerActionFailure`), jamais d'une relecture du message ; le **message**, lui, est
transmis tel quel.

Les segments d'**action** (`/sync`, `/replicate/…`, `/push/…`) ne sont pas décoratifs : les
extensions sont montées **avant** le routeur de données du cœur, précisément pour que leurs
chemins ne soient pas lus comme des collections. Après **chaque** écriture CRUD, les timers
sont **ré-armés** (configuration à chaud). Les actions manuelles sont **journalisées avec leur
auteur** (id canonique posé par le serveur) : répliquer chez un tiers est un effet
irréversible.

## Interface utilisateur

Tout vit dans la page **« Interventions »** — il n'y a pas d'onglet dédié : l'utilisateur voit
l'état du ticket sur **ses** incidents et interventions.

**En-tête de la vue** (mode API + non-viewer, garanti par la nullité du client) :

- **« Providers… »** → la modale de configuration (liste ⇄ formulaire, pied de page masqué,
  jeton « inchangé si vide », « Tester la connexion ») ; `503` ⇒ **bandeau** portant le
  `detail` du serveur **à la place** des contrôles — tant que la clé n'est pas là, il n'y a
  rien à configurer ;
- **« Synchroniser »** → une passe manuelle. Un provider en échec ne fait pas échouer l'appel
  (le serveur rend un **statut par provider**) : le premier message d'erreur est remonté en
  toast, et la page courante est rechargée.

**Bloc « Ticket » de la fiche de détail** (`TrackerTicketBlock`), qui n'affiche que ce qui a
du sens :

| Situation | Ce qui s'affiche |
|---|---|
| **répliquée, poussée à jour** | lien vers le ticket (icône + référence en mono), **pastille de statut** (libellé BRUT du tracker, jamais traduit ; infobulle explicative), assigné (« Non assigné » estompé sinon), dernier retour d'état, badge « à jour » **discret** — c'est le régime normal, il ne doit pas attirer l'œil |
| **répliquée, poussée en attente** | idem, badge « en attente » en avertissement. **Aucune action proposée** : elle se résorbe seule à la passe suivante, et la proposer inviterait à marteler le tracker |
| **répliquée, poussée en échec** | idem, badge d'erreur + le **message du tracker intact** (multi-lignes) + le bouton **« Mettre à jour le ticket »** |
| **non répliquée** | l'action d'amorçage — **« Répliquer vers le tracker »** (création) si aucune référence n'est saisie, **« Lier le ticket existant »** si `jira_ref` porte déjà une référence. Un **sélecteur de provider** apparaît uniquement quand le document en a **plusieurs** |

**Liaison d'un `jira_ref` existant** : l'action passe par une **confirmation explicite**. Le
ticket visé peut venir d'une **autre source** du projet partagé, et le contenu DC Manager
**écrasera son résumé et sa description** à la prochaine poussée — la confirmation le **dit**,
parce qu'une confirmation qui n'énonce pas ce qu'elle fait perdre ne protège personne. Côté
serveur, la liaison résout la référence (clé **ou** URL collée), **refuse** le ticket déjà lié
à une autre intervention du document (`409`, message nommant celle-ci), enregistre l'identité
**INTERNE** rendue par le tracker (jamais la référence saisie), puis aligne immédiatement le
contenu.

Après **toute** action réussie, la vue **relit l'intervention** et repeint le **corps entier**
de la fiche — et pas seulement le bloc : une réplication écrit **aussi** la référence, et
rafraîchir le bloc seul laisserait la rangée « Jira » juste au-dessus afficher « — » alors que
la clé vient d'être créée.

**Colonne « Jira » du listing** : la référence, **enrichie** quand le pont a fait son œuvre —
pastille de catégorie (sans infobulle : colonne étroite, pastille répétée à chaque ligne) et
un indicateur **discret** d'échec de poussée (infobulle + `aria-label` portant le message ; le
détail actionnable vit sur la fiche). Une intervention **non répliquée** garde **exactement**
le rendu d'avant le pont.

**Le lien du ticket** : `TrackerReplication.ticketUrl` donne la priorité au **lien persisté**
(`tracker_url`, composé par l'adaptateur à partir de l'instance réellement interrogée) sur le
montage local `JIRA_BASE_URL` + référence — ce dernier suppose que les deux désignent la même
instance, ce que rien ne garantit. Le lien passe par `Html.externalLink` (liste blanche de
schémas + `rel="noopener"`) : depuis le pont, l'URL vient d'un **tiers**.

## API Jira — ce qui est SUPPOSÉ

⚠ **Écrit SANS accès à une instance Jira : ce sont des HYPOTHÈSES, pas des constats.** Elles
sont rassemblées **en un seul point** (l'en-tête de `JiraAdapter.ts` et les constantes de
chemins, plus `JiraParse` pour les champs) afin de rester corrigeables d'un geste.

| # | Hypothèse | Où c'est isolé |
|---|---|---|
| 1 | Base d'API **`/rest/api/3`** (Jira **Cloud**). Une instance Data Center répond sur `/rest/api/2` et s'authentifie en `Bearer <PAT>` : ce serait un adaptateur **distinct** | `JiraAdapter.API_BASE` |
| 2 | Auth **Basic** `base64(e-mail:jeton d'API)` — ✅ schéma **confirmé contre la doc officielle** (developer.atlassian.com « Basic auth for REST APIs » : en-tête, jeton créé sur `id.atlassian.com/manage/api-tokens`, appels directs sur le site `*.atlassian.net`) ; reste à le voir répondre sur l'instance. ⚠ Une **politique d'organisation** Atlassian peut interdire les jetons d'API — l'alternative serait OAuth 2.0 (3LO) (consentement navigateur, `client_id`/`secret`, tokens à rafraîchir, appels via `api.atlassian.com/ex/jira/{cloudId}/…`) : un adaptateur/une variante à cadrer, pas un réglage | `JiraHttp` |
| 3 | 🚨 Recherche par lots sur **`POST /rest/api/3/search/jql`**, corps `{ jql, fields, maxResults }`, pagination par **`nextPageToken`** (Atlassian a remplacé l'ancien `POST …/search` en `startAt`/`total`). **L'hypothèse la plus fragile**, donc la plus isolée : si l'instance répond `404`, mettre `PATH_SEARCH_LEGACY` dans `PATH_SEARCH` et **rien d'autre** — le décodeur et la décision de pagination comprennent **déjà les deux formes** | `PATH_SEARCH` / `PATH_SEARCH_LEGACY`, `JiraParse.page`/`nextCursor` |
| 4 | Taille de lot **~100** identifiants par requête (à confirmer contre la limite réelle de `maxResults` **et** la longueur maximale du JQL) | `JiraAdapter.BATCH_SIZE` |
| 5 | Statut : `fields.status.name` (brut) + `fields.status.statusCategory.key` ∈ `new` / `indeterminate` / `done` → `todo` / `in_progress` / `done` ; toute autre valeur → `unknown` | `STATUS_CATEGORY_BY_JIRA_KEY` |
| 6 | Identité : `id` **stable** vs `key` **MOBILE** — le fondement de tout le module | `JiraParse.ticketState` |
| 7 | Lien d'interface : `<base>/browse/<clé>`. ⚠ Le champ `self` pointe l'**API**, pas l'interface | `JiraParse.browseUrl` |
| 8 | Création : `POST /rest/api/3/issue`, `fields: { project:{key}, issuetype:{name}, summary, description, labels, priority:{name}, duedate }` — description en **ADF** (objet JSON, jamais une chaîne) | `PATH_ISSUE_CREATE`, `JiraParse.toAdf` |
| 9 | Test de connexion : `GET /rest/api/3/myself`. La version applicative n'y est pas exposée → `version` reste `null` plutôt qu'un appel de plus pour un champ cosmétique | `PATH_MYSELF` |
| 10 | Mise à jour : **`PUT /rest/api/3/issue/{id}`**, corps `{ fields: {summary, description, priority, duedate}, update: { labels: [{add},{remove}] } }`, réponse **204 sans corps**. ⚠ Un même champ ne peut **pas** figurer à la fois dans `fields` et dans `update` — d'où des labels **exclusivement** en verbes | `JiraAdapter.pathIssue` |
| 11 | **`duedate`** accepte `YYYY-MM-DD` et se **vide** avec `null` ; **`priority`** se pose **par nom** (`{name: "High"}`) et peut être **absente du projet** (Jira répond alors `{ errors: { priority: … } }`) → **une seule** retente sans elle. Jamais de retente sans `issuetype` : un type refusé est une erreur de configuration à corriger | `OPTIONAL_FIELD_PRIORITY`, `JiraParse.errorMentionsField` |

Deux garde-fous complètent ces hypothèses : un **cap dur de pages par lot**
(`MAX_PAGES_PER_BATCH` = 10) contre un tracker qui ignorerait la pagination, et les champs
demandés **exactement** (`FIELDS` = `status`, `assignee`, `labels`) — ni `summary` ni
`description`, dont DC Manager fait foi : les relire créerait une seconde vérité concurrente.

### Procédure de re-validation (au premier déploiement, ou si l'API dévie)

Sur un **projet de test**, avec un **compte de service dédié** :

1. **Configurer un provider** (URL, compte, jeton, `project_key`, types) et cliquer
   **« Tester la connexion »** :
   - échec d'authentification → le message vient de Jira (compte, jeton, droits) ;
   - « l'API de RECHERCHE n'a pas répondu comme attendu » → hypothèse **3** (le test le
     signale sans bloquer : l'authentification, elle, est prouvée).
2. **Pousser une intervention de test** (« Répliquer »), puis **vérifier dans Jira** :
   **type** de ticket conforme à `type_intervention` (et à `type_incident` sur un incident),
   **résumé** et **description** présents, **priorité** correspondant à la table,
   **échéance** = la date de `planned_end`, **étiquettes** `DCM-EQ-…`/`DCM-VM-…` pour chaque
   objet lié.
3. 🚨 **Poser à la main une étiquette ÉTRANGÈRE** sur ce ticket (p. ex. `ops-2026`), puis
   modifier l'intervention dans DC Manager et attendre la poussée : l'étiquette étrangère doit
   **SURVIVRE**, et seules les `DCM-*` obsolètes doivent disparaître. C'est le risque n°1 du
   chantier — à tester explicitement, jamais par déduction.
4. **Éditer côté DC Manager** (titre, description) et vérifier que le ticket est **écrasé**
   par le contenu DC Manager (c'est le comportement voulu — cf. « Le partage des vérités »).
5. **Fermer le ticket côté Jira**, lancer « Synchroniser », et vérifier que la **pastille**
   change (statut brut + catégorie `done`) **sans** que le statut DC Manager bouge.
6. **Projet sans priorité** (créer un projet *team-managed*) : la poussée doit **réussir en
   DÉGRADÉ** — le statut de la passe porte « poussée(s) DÉGRADÉE(S) — priorité non
   appliquée… » et le ticket est bien créé.
7. **Ticket supprimé côté Jira** : la passe suivante doit marquer l'intervention
   **« introuvable »** (pastille d'avertissement), **sans** rien supprimer localement et sans
   re-créer de ticket.
8. **Volume** : si un lot plafonne, vérifier `BATCH_SIZE` et `MAX_PAGES_PER_BATCH` (hypothèses
   3 et 4) ; les identifiants non revenus ressortent en « introuvables », ce qui est
   précisément le signal qu'il faut regarder.

## Mode local (fichier) — principe n°15

**Constat.** Le pont **n'est pas disponible en mode fichier**, en trois temps :

1. les **interventions elles-mêmes** sont déjà API-seulement — écart **CONNU et à résorber**,
   documenté en § « Mode local » de [`interventions.md`](interventions.md) : rien dans leur
   métier n'exige un serveur, c'est un choix d'implémentation ;
2. le pont **hérite** de cette exception : sans interventions locales, il n'a rien à
   répliquer. Il en ajoute une qui lui est **propre** et légitime : il détient un **secret
   chiffré au repos** et fait des appels réseau **sortants et ÉCRIVANTS** vers un tiers —
   stocker un jeton d'API dans un document répliqué à tous les clients serait un contresens
   de sécurité, pas une commodité manquante (même exception que `vm/`, `wifi/` et `notify/`) ;
3. **ce qui reste vrai sans le pont** : le champ **`jira_ref`** de l'intervention est une
   feature **antérieure** et indépendante, qui continue de marcher — une clé ou une URL saisie
   à la main, transformée en lien par `JIRA_BASE_URL` côté client. Les colonnes `tracker_*`
   restent simplement vides, et le comportement du module interventions est **strictement
   inchangé**.

**Évolution.** Le jour où les interventions gagneront leur mode local, le pont restera
serveur : c'est sa nature (secret + réseau sortant), pas une limite d'implémentation.

## Suppression de la feature (script d'amovibilité)

Aucun autre module ne dépend de `tracker/` : le cœur ne l'importe jamais, et
`interventions/` non plus.

1. **Serveur** — supprimer `src-server/src/tracker/` **en entier** (les 10 fichiers ;
   `SecretBox.ts` vit **hors** du module et **reste** : il sert aux autres features à
   secrets). Dans `index.ts`, retirer : l'import de `TrackerModule`, la déclaration
   `let tracker: TrackerModule | null = null`, l'option **`onWrite`** passée à
   `InterventionsModule.create`, la création `TrackerModule.create({…})`, l'affectation
   `tracker = trackerModule`, `trackerModule.extension()` du tableau `extensions`,
   `trackerModule.start()` et `trackerModule.stop()`. Supprimer le fichier
   `tracker-providers.db` sur le serveur.
2. **Serveur — les retraits DANS `interventions/`** :
   - `InterventionsDb.ts` : les constantes `TRACKER_COLUMNS`/`TRACKER_PATCH_COLUMNS`, les
     neuf colonnes du `CREATE TABLE`, la boucle `ensureColumn` correspondante, les deux index
     `idx_interventions_tracker_ext`/`idx_interventions_tracker_push`, les méthodes
     `listTracked`/`listPushDue`/`applyTrackerState` (et le helper privé `exists` si plus
     personne ne l'utilise), les champs `tracker_*` de `InterventionRecord` et de `toRecord`,
     et les interfaces `TrackedInterventionRow`/`PendingPushRow`/`InterventionTrackerPatch`.
     ⚠ **Les colonnes déjà créées peuvent RESTER en base, inertes** : `ensureColumn` est
     **additif** (il n'a pas de pendant qui retire), SQLite garde les colonnes existantes, et
     `save()` ne les touche pas. Les laisser ne coûte que quelques octets par ligne ; les
     supprimer vraiment demande un `ALTER TABLE … DROP COLUMN` (SQLite ≥ 3.35) ou une
     régénération de la base ;
   - `InterventionsModule.ts` : le type `InterventionsWriteHook`, le paramètre `onWrite` de
     `create` et du constructeur, la méthode `announceWrite` et ses **deux** appels (routes
     `PUT` et `DELETE`), les **quatre** relais publics de la « surface de réplication »
     (`listTracked`/`listPushDue`/`getOne`/`applyTrackerState` — la route `GET /:id` passe, elle,
     par `ctx.db.getOne` en direct : elle n'en dépend pas), et la mention du hook dans le message
     de démarrage.
3. **Client** — supprimer `core/TrackerStatus.ts`, `core/TrackerReplication.ts`,
   `views/forms/TrackerSyncClient.ts`, `views/forms/TrackerProvidersForm.ts`,
   `views/forms/TrackerTicketBlock.ts` ; retirer l'export `TrackerSyncClient` de
   `views/index.ts`, la construction `trackerClient` de `main.ts` **et** le 5ᵉ argument passé
   à `new InterventionsAdminView(...)`. Dans `InterventionsAdminView.ts` : les imports
   `Tracker*`, le paramètre `tracker`, les champs `trackerProviders`/`trackerProvidersLoaded`
   et `ensureTrackerProviders`, les **deux actions d'en-tête** et la méthode `trackerSync`,
   l'enrichissement de `jiraCell` (pastille + indicateur d'échec), l'arbitrage d'URL de
   `jiraInline` (revenir à `InterventionsFormat.jiraUrl` seul), `attachTrackerBlock`,
   `refreshTicket`, et la mécanique `detailBody`/`detailContent` de repeinte (le corps
   redevient un simple `detailBody`).
4. **i18n** — supprimer `src-client/i18n/locales/fr/tracker.ts` et `en/tracker.ts` + leur
   import/entrée dans les agrégateurs `fr.ts`/`en.ts` ; retirer `domain.trackerStatusCategory`
   (fr **et** en) et `lists.ph.notFound` (sans autre consommateur).
5. **Tests / build** — supprimer `Tests/modules/test-tracker.js` + sa ligne dans `run.js`, et
   les entrées `src-server/src/tracker/*` de `tsconfig.node.json`.
6. **Documentation** — supprimer ce fichier, son entrée dans l'index de `CLAUDE.md`, la ligne
   `tracker-providers.db` de `src-server/RUN.md` § 5, et les mentions du module dans les
   descriptions de `DCMANAGER_SECRETS_KEY` (`README.md` § 4, `RUN.md` § 6 et § 8) ainsi que la
   ligne « pont tracker » des limites d'`interventions.md`.
7. **Ce qui RESTE, parce que ça ne vient pas de ce chantier** :
   - **`jira_ref`**, la variable **`JIRA_BASE_URL`**, la route `GET …/interventions/meta`, la
     colonne « Jira » du listing et `InterventionsFormat.jiraUrl` : la référence Jira **manuelle**
     est une feature **ANTÉRIEURE** au pont, décrite dans `interventions.md` ;
   - **`Html.externalLink`** (garde d'URL des liens sortants) et **`Icons.TICKET`** : des
     primitives partagées, pas du code de ce module ;
   - **`ListView.focusTarget`** (poser la dimension « Cible » depuis l'extérieur) : sert la
     navigation « Afficher plus » des fiches ;
   - le **`SecretBox`** serveur et le module **`notify/`** : le producteur
     `tracker-sync-failure` disparaît simplement, les autres sont intacts.

## Ajouter un provider d'une autre marque

C'est l'**exigence n°1** du chantier : les contrats, le service, les étiquettes, le plafond de
passe, la base de config, les routes et l'UI sont **agnostiques de la marque**. Ajouter un
tracker (GitHub, GitLab, Redmine, Jira Data Center…) se fait en **quatre** points, et **rien
d'autre** ne bouge — un test d'invariant relit d'ailleurs les sources des modules génériques
pour vérifier qu'aucune marque n'y a fui.

1. **L'adaptateur.** Écrire `XxxAdapter` implémentant `TrackerProviderAdapter` (`test`,
   `resolve`, `lookup`, `createIssue`, `updateIssue`), avec le même découpage que Jira :
   `XxxHttp` (accès réseau), `XxxParse` (décodage **PUR**, testable par fixtures),
   `XxxAdapter` (orchestration, qui déclare son besoin HTTP par une interface **consommateur**).
   Trois obligations de contrat : `resolve` résout **PAR LOTS** et distingue les **résolus**
   des **introuvables** ; `ext_id` porte l'identité **INTERNE** (jamais une clé mobile) ;
   `updateIssue` applique les labels **en verbes** add/remove et ne remplace jamais le tableau.
   Un tracker qui n'expose pas de catégorie d'état la **déduit chez lui** (GitHub : `closed` →
   `done`) — jamais l'appelant.
2. **La fabrique.** Ajouter une ligne dans `TrackerSyncService.adapterFor` :
   `if (config.kind === "xxx") return XxxAdapter.fromConfig(config);`.
3. **La validation des options.** Ajouter une entrée dans
   `TrackerProviderConfigValidate.KIND_OPTION_SPECS` déclarant les réglages propres à la
   marque (nom, type scalaire, défaut, `nonEmpty`/`min`). Elles sont persistées en JSON dans
   la colonne `options` : **aucune migration de schéma**. Déclarer `auto_replicate` si la
   marque veut la réplication automatique — le service la lit **par son nom générique**, et
   une marque qui ne la déclare pas est traitée comme « pas d'automatisme » (on ne crée pas
   chez un tiers sur une intention non exprimée).
4. **L'UI.** Ajouter le type au `<select>` (`TrackerProvidersForm.KINDS`) et ses champs
   d'option (`TrackerProvidersForm.KIND_FIELDS`, **miroir** de l'étape 3, confronté par test)
   + les libellés i18n correspondants dans `fr/tracker.ts` **et** `en/tracker.ts`
   (`providers.opt.*`).

Ce qu'il ne faut **pas** faire : ajouter une colonne à `tracker-providers.db` pour un réglage
de marque ; tester le `kind` ailleurs que dans la fabrique et la table d'options ; faire
remonter un champ propre à la marque jusqu'au pivot `TrackerTicketState` ou jusqu'à
`TrackerPushContent` ; ni traduire un libellé de statut du tracker (seule la **catégorie
fermée** est traduisible).

## Déploiement

| Variable | Rôle | Sans elle |
|---|---|---|
| `DCMANAGER_SECRETS_KEY` | passphrase de chiffrement des jetons (**partagée** avec `vm/`, `wifi/` et `notify/`), **≥ 16 caractères** | pont inactif, routes en `503` actionnable, hook inerte — les interventions restent pleinement fonctionnelles |

Aucune autre variable d'environnement n'est propre à cette feature : le lien de chaque ticket
est **persisté** au moment de la synchro (`tracker_url`), il n'y a donc rien à configurer pour
le fabriquer. (`JIRA_BASE_URL` appartient, elle, à la référence **manuelle** du module
interventions.)

Au premier déploiement : définir/vérifier la clé, configurer un provider, **valider les
hypothèses d'API** (procédure ci-dessus) avec `interval_sec = 0` le temps de la validation,
puis poser une période réaliste.

## Tests

`Tests/modules/test-tracker.js` couvre, du plus pur au plus intégré :

- **client** : `TrackerStatus` (catégories, priorité de l'« introuvable » sur la catégorie,
  clé de tri, libellés, **pastille** et son échappement) et `TrackerReplication` (répliquée ou
  non, état de poussée, arbitrage de l'URL) ; la garde d'URL des liens sortants
  (`Html.externalLink`) ; le **miroir** `KIND_FIELDS` ⇄ `KIND_OPTION_SPECS` (noms, ordre,
  types, défauts) ;
- **décodage Jira PUR** : `toAdf` (document valide, texte vide, multi-lignes), état décodé
  (`ext_id` = id interne, URL d'interface, catégorie, alias, tolérance aux formes creuses),
  table de priorités et lecture des **refus par champ**, pagination (chaque garde-fou
  séparément, **deux formes** d'API), JQL et référence saisie ;
- **étiquettes** : composition, normalisation (accents, ligatures, caractères refusés,
  bornage, déduplication) et surtout le **DIFF** — un test explicite prouve qu'une étiquette
  d'une autre source ne ressort d'**aucun** des deux verbes ;
- **adaptateur** sur stub HTTP structurel : `resolve` par lots (partage found/missing,
  pagination, cap dur, champs demandés), `lookup` (clé, URL, 404 → null, erreurs de provider
  remontées), `createIssue` (type par nature, ADF, labels/priorité/échéance, refus intact),
  `updateIssue` (PUT, labels **en verbes**, échéance vidable), `test` (sonde non bloquante) ;
- **transport** : `JiraHttp` en parties pures et en flux réel sur `fetch` **injecté**
  (429 borné, statuts, cap de réponse, jeton jamais cité) ;
- **configuration** : validation par marque (champs communs, `kind` inconnu, options) et
  stockage chiffré sur **better-sqlite3 réel** (CRUD sans fuite de jeton, compte relu, jeton
  indéchiffrable) ;
- **plafond ROULANT** (`TrackerPassScope`) : ordre stable, troncature, absence de zone morte ;
- **le pont de bout en bout** sur `interventions.db` **et** `DocumentStore` **réels** :
  poussée tolérante (tracker éteint ⇒ intervention enregistrée + `error` + reprise), survie au
  redémarrage, retour d'état **idempotent**, introuvable, auto-réplication et ses refus, la
  **course** de deux poussées en vol sur la même intervention (création distante **suspendue** :
  un seul ticket, et la seconde demande rejouée en mise à jour), l'**échec partiel de création**
  (identité mémorisée ⇒ **zéro** ticket de plus aux passes suivantes, et le **résiduel** de
  redémarrage mesuré : **une** re-création, pas une boucle), le **refus d'adoption double** d'un
  ticket, et le **ramassage au démarrage** d'une poussée laissée en plan (sans timer ni geste,
  tracker éteint compris) ;
- **invariants** : décodeur ≡ pivot (`TRACKER_TICKET_STATE_FIELDS`), **agnosticisme de
  marque** (aucun « jira » hors des points d'extension), et les trois duplications
  client ⇄ serveur verrouillées (sentinelle « introuvable », catégories, états de poussée).

Les routes (`TrackerModule.ts`, Express) restent hors test, comme `api.ts` et les autres
façades de module.
