# Hydratation du cache client — état par collection, gardes de sûreté, instrumentation

Le Store client sert son cache hydraté en **synchrone** (le rendu l'exige) : `Store.data[c]` est
initialisé `[]` pour toute collection, et RIEN n'y distingue « vide » de « pas encore chargée » —
`store.all(c)` peut donc **mentir silencieusement** dès qu'une collection est chargée
**paresseusement** (chantier « lazy-load des collections », cadrage
`.notes/toDos/lazy-load-collections-cadrage-2026-08-11.md`). Ce document décrit la vérité
manquante — l'**état d'hydratation par collection** — et les **gardes** qui s'y adossent.

Modules concernés : `src-client/core/HydrationState.ts` (état + prédicats, pur),
`src-client/core/LazyCollections.ts` (LA liste des collections paresseuses),
`src-client/core/CollectionCountCache.ts` (compteurs async, pur),
`src-client/store/Store.ts` (câblage G1/G2/G3/G4/G6 + hydratation à la demande),
`src-client/core/ListRowEngine.ts` + `src-client/core/StoreListRowSource.ts` + `views/ListView.ts`
(pager serveur réel), `src-client/app/FileDocuments.ts` (branchement export),
`src-client/core/HydrationStats.ts` (instrumentation). Tests :
`Tests/modules/test-hydration.js` (lot 0) et `Tests/modules/test-lazy-contacts.js` (vague 1).

## Le modèle d'état

Chaque collection a un **niveau d'hydratation** :

| Niveau | Sens | Ce que `store.all(c)` vaut |
|---|---|---|
| `full` | tout le contenu serveur est en cache | la vérité |
| `partial` | des enregistrements ont été absorbés à la demande (fiche, page de listing, recherche) | un sous-ensemble — NE PAS s'y fier pour « tout » |
| `none` | collection déclarée lazy, rien n'a encore été lu | un mensonge (`[]`) |

L'état vit dans `core/HydrationState` (module **pur** : ni DOM, ni réseau, ni Store — testable
headless). Il ne mémorise que les **déviations** : une collection inconnue de la carte est `full`,
qui est le régime historique de toutes les collections tant qu'aucune vague n'a déclaré de lazy.

### Transitions

| Transition | Déclencheur | Point de câblage |
|---|---|---|
| `full → none` | `declareLazy([...])` — posé à l'**ouverture** d'un document, AVANT toute lecture | `Store` (constructeur) puis `Store.init` **après** `_hydrate` — cf. § « Vague 1 » |
| `none → partial` | `noteAbsorption(c)` — un enregistrement entre au cache | `Store._absorbRecord` (list/fetchOne/fetchMany/fetchBy) |
| `* → full` (une collection) | `markFull(c)` — la collection vient d'être re-tirée EN ENTIER | `Store._refetchWhole` (hydrateAll, rechargement granulaire) |
| `* → full` (tout) | `markAllFull()` — un instantané COMPLET vient d'être absorbé | `Store._hydrate` (init, import/`replaceAll`, `newDocument`, undo/redo) |

⚠ **Contrat des vagues futures** : `_hydrate` re-marque TOUT `full` parce qu'aujourd'hui tout
instantané absorbé est complet. Une ouverture de document qui NE chargera PAS tout (mode lazy)
devra **re-déclarer ses collections lazy APRÈS** l'hydratation — c'est le point d'entrée
`declareLazy`, et il est sans effet s'il est appelé avant.

`noteAbsorption` ne **rétrograde jamais** : une collection `full` reste `full` (absorber une ligne
déjà couverte n'apprend rien), une `partial` reste `partial` (rien ne dit que le tout y est).

### Injection (qui possède l'état)

Le Store **expose** l'état (`store.hydration`) ; l'hôte (`main.ts`) décide de sa nature par
**injection nulle** — la forme du projet (`REST_MODE ? … : null`), zéro `if (mode)` dans les
modules :

- **mode API** : `new Store(adapter, new HydrationState())` — état **traçant**, les vagues y
  déclareront leurs collections lazy ;
- **mode fichier + visualiseur** : `new Store(adapter)` (rien d'injecté) — le Store fabrique
  l'état **inerte** `HydrationState.alwaysFull()`, où `declareLazy` est **sans effet**.

## Les gardes livrées (lot 0)

### 🚨 G1 — anti-snapshot partiel

`Store._persistAll()` exécute `adapter.replaceAll(this.toJSON())` — en mode API, un
`PUT /snapshot` que le serveur applique en **DELETE + réinsertion par collection** : dérivé d'un
cache où une collection n'est pas `full`, il **effacerait** côté serveur tout ce qui n'est pas en
mémoire. C'est une **perte de données**, pas un bug d'affichage.

La garde vit au **chokepoint** `_persistAll` : `hydration.assertFullyHydrated(...)` lève une
erreur **nommée** (`HydrationError`, `name`, `operation` et `collections` manquantes portées par
l'erreur) **avant** toute écriture réseau, et **hors** du `try` → elle ne part pas dans
`onPersistError` (qui « avale » en toast) : elle remonte à l'appelant. Jamais de refus silencieux.

Statut de chaque chemin qui atteint `_persistAll` / `toJSON()` :

| Chemin | Verdict | Pourquoi |
|---|---|---|
| **boot** : `init()` → `if (syncCatalogs()) _persistAll()` (`Store.init`) | **le chemin que G1 ferme — traité en vague 1** | un boot à collections lazy y déclencherait un snapshot amputé ; la garde le rend structurellement impossible, et la vague 1 a tranché : **hydrater d'abord** (`hydrateAll` puis `_persistAll`), cf. § « Vague 1 » |
| **import** : `Store.replaceAll(raw)` (import serveur `RestDocuments.importJson`, chargement fichier `FileDocuments.loadFromText`, visualiseur `main.ts` EMBED) | **légitime, passe par construction** | le remplacement TOTAL est l'intention de l'appelant : `_hydrate(raw)` remplace le cache par un document **complet** (le `.json` est un format d'échange autosuffisant) et re-marque tout `full` AVANT `_persistAll` — le snapshot poussé EST le document |
| **nouveau document** : `Store.newDocument()` | **légitime, passe par construction** | un document neuf est complet (et vide) ; même mécanique que l'import |
| **mode fichier** : `BrowserStorageAdapter.replaceAll` (save/undo) | **passe par construction** | état inerte tout-`full` (injection nulle) — comportement strictement inchangé |

### G2 — export = hydrater TOUT avant (arbitrage n°3)

Un export porte le document **entier**. `Store.hydrateAll()` recharge EN ENTIER les collections
non-`full` (`notFullCollections()` → `_refetchWhole` → `markFull`) — **no-op** quand tout est déjà
`full` (lot 0 : toujours). Ni refus, ni export amputé ; un échec réseau **rejette** (pas d'export
plutôt qu'un fichier tronqué).

Branchements (`FileDocuments`, disponibles dans TOUS les modes) :

- `snapshotWithImages()` — point **unique** des deux exports : **JSON autonome**
  (`exportJsonDownload`, aussi le repli download de `doSaveAs`) et **visualiseur HTML**
  (`exportStandalone`) ;
- `writeToHandle()` — toute écriture d'un `.json` sur disque (save, save-as, auto-save). En mode
  fichier c'est un no-op par construction ; la ligne n'existe que pour la sûreté **structurelle**
  (aucun chemin d'écriture de fichier ne peut sérialiser un cache partiel).

`serializeJson()` n'est appelée que par `writeToHandle` — couverte. Il n'existe aucun autre
consommateur de `Store.toJSON()` à visée d'export (`_persistAll` est couvert par G1).

### G3 — SSE : ne re-tirer que l'hydraté

`Store.reloadCollections(plan)` (rechargement granulaire piloté par le `ReloadPlanner` sur
événement SSE) **partitionne** le plan via `hydration.splitReload(...)` :

- collections **hydratées** → re-tirées en entier (comportement historique) ;
- collections `none`/`partial` → **sautées** : les re-tirer en entier au premier événement d'un
  autre client annulerait tout le bénéfice du lazy. Le retour de `reloadCollections` ne liste que
  les collections réellement rechargées ; les sautées sont tracées (`Log.d("store", …)`).

**Point d'accroche** : `Store.onLazyReloadDeferred: ((collections: string[]) => void) | null` —
appelé avec les collections sautées. Le Store y invalide d'abord SES dérivés (les compteurs G6, seul
dérivé recalculable à bas coût), puis appelle l'accroche pour ceux de l'hôte : `main.ts` y redemande
un rendu des pastilles (`shell.refreshCounts()`). La PAGE de listing en main, elle, n'est pas
rafraîchie — re-tirer la collection est précisément ce que G3 refuse.

## Vague 1 — `contacts` chargée paresseusement (mode API)

`contacts` est la collection PILOTE : 0 FK entrante ou sortante, 0 cascade, 0 index dérivé — le coût
de la vague est quasi nul, elle sert à VALIDER le patron complet que les vagues 2-3 rejoueront
(`attachments` + `applications`, puis `wifiClients` ; `vms` reste EXCLUE du chantier).

### La liste, et le seul endroit où elle s'écrit

`src-client/core/LazyCollections.ts` porte `LAZY_COLLECTIONS_API` — une DONNÉE, pas une politique
répartie. Chaque vague y ajoute sa collection, et rien d'autre ne change. Son unique lecteur
légitime est l'hôte (`app/main.ts`), qui l'injecte au Store :

```ts
new Store(adapter, REST_MODE ? new HydrationState() : null, LAZY_COLLECTIONS_API)
```

⚠ **La liste est une INTENTION, l'état est la VÉRITÉ.** Aucun consommateur ne teste l'appartenance à
`LAZY_COLLECTIONS_API` pour décider d'un comportement : il interroge `store.hydration`. Une
collection déclarée lazy peut être redevenue `full` en cours de session (export G2, réconciliation
des catalogues, hydratation à la demande d'un formulaire) — et tout doit alors repasser en régime
local, sans que rien d'autre ne bouge. Un test verrouille aussi que chaque nom EST une collection :
une faute de frappe serait silencieusement sans effet.

**Mode fichier / visualiseur : rien ne change, PAR CONSTRUCTION.** Le Store n'accepte la liste que
s'il a reçu un état d'hydratation TRAÇANT (`this.lazyCollections = hydration ? [...] : []`) — même
construction que l'état inerte. L'hôte n'écrit donc qu'UN test de mode, et aucun module n'en
contient.

### Ce que le boot ne charge plus, et où les lazy sont RE-DÉCLARÉES

`Store.init()` transmet la liste à l'adaptateur (`adapter.load({ skipCollections })`) ; en mode API,
`RestAdapter.load` ne tire tout simplement pas ces collections — c'est là que le coût du boot
disparaît. L'adaptateur FICHIER l'ignore : il n'y a rien à sauter dans un document monolithique.

🚨 **`_hydrate` re-marque TOUT `full`** (contrat du lot 0). La re-déclaration est donc posée
**dans `init()`, immédiatement après `_hydrate`, avant toute lecture** — et *seulement là* :

| Chemin d'ouverture / rechargement COMPLET | Passe par | Verdict |
|---|---|---|
| boot mode API (avant tout document) | `main.ts boot()` → `store.init()` | couvert |
| ouverture d'un document serveur | `RestDocumentController.openDocument` → `store.init()` | couvert |
| rechargement TOTAL après 409 / 400 | `RestDocumentController.reload` (`refetchCollections === null`) → `store.init()` | couvert |
| changement de document (sélecteur) | `openChooser` → `openDocument` → `store.init()` | couvert |
| **import** `.json` dans un nouveau document | `Store.replaceAll` | **ne re-déclare RIEN, à dessein** |
| **nouveau document** | `Store.newDocument` | **ne re-déclare RIEN, à dessein** |

Les deux derniers ne re-déclarent rien parce que leur cache contient VRAIMENT tout le document (un
export `.json` est autosuffisant ; un document neuf est complet et vide) : l'état dit alors la
vérité, et le snapshot qu'ils poussent EST le document. Le lazy reprend à la prochaine ouverture.

Centraliser dans `init()` plutôt que sur chaque appelant n'est pas une commodité : c'est ce qui rend
structurellement impossible d'oublier un chemin — un futur point d'entrée qui rechargerait tout
passera forcément par `init()`.

### 🚨 Boot + réconciliation des catalogues : la sémantique retenue

`init()` finit par `if (syncCatalogs()) await _persistAll()` — le chemin que le lot 0 avait désigné
comme **le plus sournois** : ce `PUT /snapshot`, dérivé d'un cache où `contacts` manque, EFFACERAIT
les contacts côté serveur. G1 le refuse (bruyamment), donc le boot planterait.

**Sémantique retenue : on HYDRATE d'abord** (`await this.hydrateAll(); await this._persistAll();`) —
le même arbitrage que pour l'export (n°3) et la même mécanique, plutôt qu'une écriture partielle des
catalogues inventée pour l'occasion (qui devrait re-décrire à la main tout ce que l'upsert *et* le
remap legacy ont pu toucher, et divergerait au premier ajustement).

- le coût est **rare** : `syncCatalogs()` ne renvoie `true` que si le catalogue du CODE a bougé
  depuis la dernière ouverture de CE document ;
- il n'est **pas récurrent** : l'upsert est idempotent, le boot suivant ne réécrit plus ;
- **conséquence assumée** : ce boot-là se termine avec un corpus intégralement hydraté. On ne
  re-déclare donc RIEN ensuite — l'état DIT la vérité (tout est en cache) et le lazy reprend au boot
  suivant.

G1 reste **structurellement vraie** : `_persistAll` conserve son `assertFullyHydrated`, et c'est le
corpus qu'on rend complet, jamais la garde qu'on assouplit.

⚠ Effet de bord traité : le `store.init()` **docless** du boot API (avant le choix d'un document)
déclare lui aussi ses lazy, et la réconciliation des catalogues y est toujours vraie (store vide) →
il hydraterait `contacts` sur un `dataBase` sans document. `RestAdapter.list` a donc reçu la même
**garde docless** que `load`/`loadMeta`/`maintenance`/`replaceAll` (parité déjà documentée dans
`replaceAll`) : sans document scopé, elle rend une page vide au lieu de viser une route qui n'existe
que scopée.

### G4 — le listing `contacts` : pagination SERVEUR réelle

Le moteur de lignes (`core/ListRowEngine`) avait une règle unique : « requête inactive → local,
toujours ». Elle SUPPOSAIT le corpus hydraté. Un **troisième régime** s'y ajoute, et la SOURCE
tranche (`StoreListRowSource.isServerPaged`) — le moteur ne connaît ni l'état d'hydratation ni le
réseau :

| Requête | Collection hydratée | Collection lazy |
|---|---|---|
| **au repos** (ni saisie, ni cible) | `local()` — cache, tri et pagination CLIENT (inchangé) | **`page()` — pages SERVEUR** |
| **ACTIVE** (saisie ou cible) | `remote()` — jeu plafonné `REMOTE_LIMIT` = 500, tri/pagination client (inchangé) | idem : chemin **historique** |

C'est l'articulation du plafond demandée par l'arbitrage n°5 : **`REMOTE_LIMIT` reste la borne du
mode « recherche active »** (identique pour tout le monde, dans les deux modes) ; **la pagination
réelle, elle, page par `pageSize`** et ne s'applique qu'au repos. Les deux régimes ne se recouvrent
jamais — deux découpes concurrentes se disputeraient sinon le pager.

Ce que le pager réel apporte concrètement :

- `total` = `COUNT(*)` SQL renvoyé par la route paginée (`RelationalRepository.list`), donc « 137
  éléments · page 3/6 » dit la vérité du serveur, pas la taille d'un jeu plafonné ;
- chaque clic « ‹ › « » » **va chercher sa page** (`GET …/contacts?page=N&pageSize=…`) ;
- les lignes reçues sont **ABSORBÉES** au Store (`Store.list` → `_absorbRecord`, qui note l'état
  `partial`) : ce sont des entités ordinaires, donc colonnes, tris, fiches et actions de ligne
  fonctionnent à l'identique ;
- tant qu'aucune page n'est arrivée, le listing affiche « Chargement… » et non son état vide (un
  listing vide et un listing qui n'a pas répondu ne disent pas la même chose) ;
- une **écriture locale** (création, suppression) oublie la page en main (`ListRowEngine.forgetPage`
  branché sur `store.onChange`) : garder une page dont le total a bougé serait afficher un état faux.

**Limites ASSUMÉES du pilote** (elles tiennent toutes à une même cause : la route paginée ne sait
faire ni tri ni facette) :

- **TRI.** La route ordonne exclusivement par `created_date ASC, id ASC` — il n'existe aucun
  paramètre de tri. La **découpe en pages** suit donc l'ordre de création ; le critère choisi par
  l'utilisateur (Nom, Organisation…) ordonne **les lignes de la page affichée**. Seul le tri « Date
  de création, croissant » est globalement exact. Écart DOCUMENTÉ, pas contourné : le lever demande
  un `ORDER BY` serveur (candidat pour la vague 3, où le volume le justifiera).
- **Filtres de colonne** : appliqués à la page reçue, pas au corpus (mêmes raisons).
- **Événement SSE d'un autre client** sur une collection lazy : G3 saute délibérément son
  rechargement, la page en main n'est donc PAS rafraîchie. Seul le COMPTEUR l'est (cf. G6). Cohérent
  avec G3 — refuser de re-tirer la collection ET la re-tirer pour repeindre serait contradictoire.

Le listing des collections **hydratées** ne change pas d'un pixel : `page()` y rend `null` et la vue
reprend son chemin historique, ligne pour ligne.

### G6 — compteurs d'onglet

`count: () => store.all(c).length` MENT sur une collection lazy (0 au boot, puis la taille des pages
parcourues). Le Store expose donc deux accesseurs, et l'état choisit :

| | Collection hydratée | Collection lazy |
|---|---|---|
| `store.countOf(c): Promise<number>` | longueur locale, résolue sans réseau | `COUNT(*)` serveur, **mémoïsé** |
| `store.countHint(c): number` | longueur locale (synchrone, exacte) | dernière valeur connue, **0 en attendant** — et le relevé est déclenché |

`countHint` est l'accesseur des pastilles : le rendu du Shell est SYNCHRONE par contrat, il ne peut
pas attendre. L'arrivée d'une valeur passe par `store.onCountResolved`, que `main.ts` câble sur
`shell.refreshCounts()` — c'est le patron du badge « Interventions », généralisé et rendu testable
(`core/CollectionCountCache`, module pur : le relevé est injecté, les demandes rapprochées partagent
UNE requête, un échec n'est pas mis en cache).

Invalidations (toutes portées par le Store) : création / suppression / clonage (le total a bougé),
`_refetchWhole` (la collection redevient locale), `_hydrate` (remplacement total), et **le point
d'accroche G3** — une collection SAUTÉE par un événement SSE a pu changer chez un autre client, et
son compte est le seul dérivé qu'on puisse rafraîchir à bas coût. `Store.onLazyReloadDeferred` reste
offert à l'hôte pour SES propres dérivés ; `main.ts` y redemande un rendu des pastilles.

### G8 — facette « Organisation » du listing

Arbitrage n°4 : **calcul sur-page** pour les petites collections (le `SELECT DISTINCT` serveur est
réservé aux volumineuses de la vague 3). Concrètement, `ListConfigs.contacts` continue de lire
`store.all("contacts")` — qui, en régime lazy, ne contient que **les pages déjà parcourues**.

- **Limite** : la facette ne propose que les organisations VUES, et le filtre s'applique à la page.
- **Pourquoi cette forme plutôt que « strictement la page courante »** : le cache ACCUMULE, donc les
  valeurs proposées ne font que croître — aucune chip ne disparaît en changeant de page (la purge
  des « options disparues » de `ListView` ne se déclenche jamais à tort). Et le code du listing
  hydraté n'est pas touché : zéro risque de régression sur les 20+ autres listings.

### Hydratation À LA DEMANDE (le patron des formulaires)

`Store.hydrate(collections)` recharge EN ENTIER celles qui ne sont pas `full`, et **ne fait rien**
sur les autres — donc rien du tout en mode fichier, par construction : **l'appelant n'écrit aucun
test de mode**. (`hydrateAll()` de G2 n'en est plus qu'un cas particulier : « hydrater la liste des
non-full ».)

C'est le patron des surfaces qui ont besoin de la liste **complète** d'une collection lazy et ne
peuvent pas se contenter d'une page : un `<select>` où doit figurer CHAQUE contact, une table qui
résout des libellés par identifiant. Le gain du chargement paresseux est **au BOOT** ; une surface
qui a réellement besoin du tout le charge à son ouverture, **une fois** — après quoi l'état passe à
`full` et listing, compteur et gardes reprennent le régime local sans autre changement.

Seule surface concernée par la vague 1 : `views/NotificationsAdminView` (abonnements de
notification + historique des remises), qui appelle `store.hydrate(["contacts"])` **en parallèle**
des appels au service `notify/` — les deux I/O sont indépendantes, et l'attente est déjà couverte
par le message « Chargement… » de la page. Un échec réseau REJETTE : mieux vaut une page qui affiche
son erreur qu'un `<select>` silencieusement amputé.

### G9 — dégradations de la palette globale (actées, NON corrigées)

Le chemin serveur de la palette existe (`GET …/search` + habillage `GlobalSearchSources.dressRecords`)
et couvre `contacts` comme les autres : **une recherche saisie en mode API trouve tous les
contacts**, y compris ceux qui ne sont pas en cache. Ce qui se dégrade, et qu'on assume pour le
pilote :

- **« Consultés récemment »** (écran d'accueil de la palette) : les entrées sont résolues contre le
  **corpus LOCAL** (`this.corpus.find(...)`), donc un contact récemment consulté disparaît de la
  liste tant qu'il n'est pas en cache. Aucune erreur, juste une entrée en moins.
- **Repli local** : si `/search` échoue (réseau, 5xx), la palette retombe sur le corpus local — qui
  ne contient plus tous les contacts. Les résultats ET les **compteurs par famille** (pastilles de
  portée, calculés sur le jeu réellement classé) sont alors incomplets pour cette famille.
- Mode fichier : **inchangé** (corpus complet).

Ce n'est pas un correctif oublié : les résoudre demanderait de résoudre les « récents » par
`fetchMany` asynchrone et de compter côté serveur — à instruire quand le volume le justifiera.

⚠ En revanche, **ouvrir** un résultat n'était pas une dégradation mais une RUPTURE, et a été corrigé :
`dressRecords` habille les records reçus **sans les absorber**, alors que `Forms.detail` lit le cache
(`store.get`) — le clic sur un contact trouvé par la recherche transverse n'aurait donné qu'un toast
« introuvable ». `GlobalSearchPalette.activate` fait donc une lecture UNITAIRE (`store.fetchOne`, qui
absorbe et indexe) avant d'ouvrir la fiche, et seulement si l'enregistrement manque — cas jamais
rencontré en mode fichier ni sur une collection hydratée, donc aucun aller-retour ajouté. Bénéfice
collatéral : le contact ainsi absorbé devient résoluble dans les « récents ».

### Ce que la vague 1 ne change PAS

`Store.get/all/findByField`, la validation partagée, la cascade, l'undo, l'export (G2 hydrate déjà
tout), les 20+ autres listings, le mode fichier et le visualiseur. `contacts` n'ayant ni FK ni
cascade ni index dérivé, aucune règle métier ne dépend de sa présence en cache.

## Gardes à venir (hors vague 1)

Instruites par le cadrage `.notes/toDos/lazy-load-collections-cadrage-2026-08-11.md` § 2, livrées
avec les vagues suivantes : **G5** aperçu de cascade (endpoint serveur), **G7** sections de fiches
(`fetchBy` + rendu async), **G10** divers mesurés (`warnAttachmentsExcluded`, `labelOf` des cibles
d'intervention, consommateurs cachés de `vms`). **G4**, **G6**, **G8** et **G9** sont livrées ci-dessus
sous une forme GÉNÉRIQUE (elles ne connaissent que l'état d'hydratation, jamais `contacts`) : les
vagues 2-3 en héritent en ajoutant leur collection à `LAZY_COLLECTIONS_API` — restent à traiter,
pour elles, les points durs qui leur sont propres (facettes distinctes serveur, sections de fiches,
aperçu de cascade).

## Arbitrages actés (utilisateur, 2026-08-12)

1. **Lazy par défaut** en mode API pour les vagues 1-3 (les seuils D3 restent l'argument de mesure).
2. **G5** : aperçu de cascade = **endpoint serveur** (le moteur `Cascade` est partagé).
3. **G2** : export = **hydrater tout** avant d'exporter — jamais de refus, jamais d'export amputé.
4. **G8** : **facettes serveur** (distinct SQL) pour les collections volumineuses.
5. **Pager serveur réel** pour les collections lazy ; plafond client conservé pour les hydratées.

## Instrumentation (`core/HydrationStats`)

Volet A du cadrage chargement-dynamique (2026-08-02, décisions D1/D3) : à chaque hydratation
complète du boot REST (`RestDocumentController.openDocument` → `reportHydration`), un relevé —
records par collection non vide, taille approximative (`JSON.stringify().length`, ordre de
grandeur assumé), durée — part dans le `Log` maison (scope `boot`, visible avec la préférence
« Logs de débogage »). Le dépassement des **seuils D3** — payload > **5 Mo** OU hydratation >
**1 s** (`PAYLOAD_WARN_BYTES` / `DURATION_WARN_MS`, à ne pas ajuster sans re-cadrage) — sort en
`console.warn` **non gaté** : c'est l'alerte qui justifie d'étendre le lazy-load à d'autres
collections. Classe pure, testée dans `Tests/modules/test-search-terms.js`.

## Mode local (principe n°15)

Le mode fichier et le visualiseur autonome sont **inchangés par construction** : « le document EST
le fichier » — il n'y a rien à charger paresseusement, toute collection y est réputée `full`.
Cette garantie n'est pas une convention (« personne n'appelle `declareLazy` en local ») mais une
**construction** : l'injection nulle fait fabriquer au Store l'état inerte
`HydrationState.alwaysFull()`, dont `declareLazy` est un no-op — aucun chemin de code, présent ou
futur, ne peut rendre un document local partiellement hydraté. Les gardes y sont donc toutes
passantes : `_persistAll` ne refuse jamais, `hydrateAll` est un no-op, `reloadCollections` ne
saute rien (et n'est de toute façon appelée qu'en mode API). L'écart de mode est ainsi **assumé et
localisé** dans l'injection de `main.ts`, jamais dans les modules.

## Tests

`Tests/modules/test-hydration.js` (lot 0) : niveaux/transitions/prédicats du module pur, état inerte
`alwaysFull`, erreur nommée de G1 (pure puis via `Store._persistAll` — appelée directement depuis
le JS compilé : le chokepoint est volontairement privé, c'est LUI que la garde ferme), légitimité
de `replaceAll`/`newDocument` en corpus partiel, `hydrateAll` qui recharge exactement les non-full
(adapter simulé espionné), `reloadCollections` qui saute les non hydratées et prévient le point
d'accroche.

`Tests/modules/test-lazy-contacts.js` (vague 1) : contenu et invariant de `LAZY_COLLECTIONS_API`
(chaque nom EST une collection), module pur `CollectionCountCache` (valeur async servie en
synchrone, déduplication des relevés, notification, invalidation ciblée, échec non mémorisé), boot
qui transmet `skipCollections` puis re-déclare les lazy APRÈS `_hydrate` (y compris au rechargement
complet), mode fichier qui ne saute rien par construction, sémantique « hydrater d'abord » du couple
`syncCatalogs`/`_persistAll` (le snapshot poussé porte bien les contacts) et retour au lazy au boot
suivant, `hydrate` ciblée et idempotente, compteurs locaux ⇄ serveur avec leurs invalidations
(écriture locale, SSE sauté), décision de régime `isServerPaged` (état et non liste de noms) et
machinerie de page du moteur (compteurs serveur, anti-relance, cohérence lignes ⇄ compteurs pendant
le vol, annulation d'une page devancée, échec sans boucle, oubli sur mutation).
