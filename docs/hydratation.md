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
`src-client/core/CollectionFacetCache.ts` (valeurs de facette async, pur — vague 3),
`src-client/core/TargetLabelResolution.ts` (partition pure de la résolution GROUPÉE des libellés de
cibles, vague 4),
`src-client/store/Store.ts` (câblage G1/G2/G3/G4/G6/G8 + hydratation à la demande + jumeaux async des
sections G7 + aperçu de cascade G5 + purge du résidu M4 + rafraîchissement du résidu M4b),
`src-client/core/ListRowEngine.ts` + `src-client/core/StoreListRowSource.ts` + `views/ListView.ts`
(pager serveur réel + facettes serveur), `src-client/core/ListServerSort.ts` + `src-shared/ListOrder.ts`
(tri serveur du régime pagé — pagination ordonnée complète, lot 1b), `src-shared/ListFacets.ts`
(liste blanche + `SELECT DISTINCT` des facettes, vague 3), `src-client/views/forms/AsyncSection.ts` +
`AttachmentUi.ts` + `ApplicationUi.ts` (sections de fiches asynchrones, vague 2),
`src-server/src/api.ts` (endpoint d'aperçu de cascade + endpoint de facettes + compte rendu du résidu),
`src-client/app/FileDocuments.ts` (branchement export), `src-client/core/HydrationStats.ts`
(instrumentation). Tests : `Tests/modules/test-hydration.js` (lot 0),
`Tests/modules/test-lazy-contacts.js` (vague 1 + tri du lot 1b),
`Tests/modules/test-lazy-vague2.js` (vague 2), `Tests/modules/test-lazy-vague3.js` (vague 3) et
`Tests/modules/test-lazy-vague4.js` (vague 4 — M4b, résolution groupée, spares) ;
côté serveur `Tests/modules/test-relational-schema.js` (liste blanche + ORDER BY) et
`test-relational-repository.js` (tri SQL réel + `SELECT DISTINCT` réel).

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
un rendu des pastilles (`shell.refreshCounts()`) et **oublie la page en main** du listing de cette
collection (`ListView.forgetServerPage()`, vague 2 — cf. § « Vague 2 »). Oublier une PAGE n'est pas
re-tirer la COLLECTION : c'est ce que G3 refuse, et la distinction est nette — le prochain rendu
redemande une page, exactement comme un clic sur « ‹ › ».

## Vague 1 — `contacts` chargée paresseusement (mode API)

`contacts` est la collection PILOTE : 0 FK entrante ou sortante, 0 cascade, 0 index dérivé — le coût
de la vague est quasi nul, elle sert à VALIDER le patron complet que les vagues suivantes rejoueront
(`attachments` + `applications`, `wifiClients`, puis `spares` ; `vms` reste EXCLUE du chantier).

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
- **le critère de tri ordonne le CORPUS ENTIER** (pagination ORDONNÉE complète, lot 1b — arbitrage
  utilisateur du 2026-08-12) : le critère actif de la vue est mappé en champ du modèle
  (`core/ListServerSort` — critères de date intrinsèques `__created__`/`__updated__` + colonnes
  déclarant leur `ListColumn.sortField`, validé contre la liste blanche PARTAGÉE
  `src-shared/ListOrder`) et part en `sort`/`dir` sur la route paginée ; l'`ORDER BY` serveur découpe
  alors les pages dans CET ordre, et la vue les affiche telles quelles. Changer de critère ou de
  direction EST une nouvelle demande serveur (`pageSignature`) et repart page 1 — comme tout
  changement de tri d'un listing. Détail serveur (liste blanche, collation, bris d'égalité, 400) :
  `docs/recherche.md` § « Listings serveur-pilotés » ;
- les lignes reçues sont **ABSORBÉES** au Store (`Store.list` → `_absorbRecord`, qui note l'état
  `partial`) : ce sont des entités ordinaires, donc colonnes, tris, fiches et actions de ligne
  fonctionnent à l'identique ;
- tant qu'aucune page n'est arrivée, le listing affiche « Chargement… » et non son état vide (un
  listing vide et un listing qui n'a pas répondu ne disent pas la même chose) ;
- une **écriture locale** (création, suppression) oublie la page en main (`ListRowEngine.forgetPage`
  branché sur `store.onChange`) : garder une page dont le total a bougé serait afficher un état faux.

**Limites ASSUMÉES du pilote** (la route paginée ne sait pas faire de facette) :

- **TRI : écart LEVÉ** (lot 1b, « pagination ordonnée complète »). Le critère de tri ordonne le
  corpus entier — cf. la liste ci-dessus. Limite RÉSIDUELLE : une colonne **sans `sortField`**
  (accesseur dérivé, sans champ scalaire en face) garde le comportement du pilote — l'`ORDER BY`
  retombe sur `created_date ASC, id ASC` et le critère n'ordonne que les lignes de la page affichée
  (repli assumé, documenté dans `ListColumn.sortField`). Sur le listing contacts, TOUTES les
  colonnes triables déclarent leur champ : aucune n'est concernée.
- **Filtres de colonne** : appliqués à la page reçue, pas au corpus.
- **Événement SSE d'un autre client** sur une collection lazy : G3 saute délibérément le rechargement
  de la COLLECTION. Le compteur est rafraîchi (cf. G6) et — depuis la vague 2 — la page en main est
  OUBLIÉE, donc redemandée au rendu suivant : une page, jamais la collection.

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
réservé aux volumineuses — cf. § « Vague 3 »). Concrètement, `ListConfigs.contacts` continue de lire
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

## Vague 2 — `attachments` + `applications` chargées paresseusement (mode API)

Deux collections plus RICHES que le pilote : elles ont des FK entrantes (les sections de fiches), un
rôle dans la CASCADE (supprimer un équipement supprime ses pièces jointes et détache ses applications)
et, pour `applications`, un statut de CIBLE D'INTERVENTION. Le patron du pilote se rejoue tel quel ;
ce qui suit ne décrit que les points DURS propres à la vague.

### Ce qui est acquis sans rien écrire

Ajouter les deux noms à `LAZY_COLLECTIONS_API` suffit à obtenir : le boot qui ne les tire plus
(`skipCollections`), la re-déclaration après `_hydrate` (`Store.init`), G1/G2/G3 (gardes de sûreté),
le **pager serveur réel** G4 avec son **tri serveur** (lot 1b), les **compteurs** G6 des pastilles
d'onglet (`count: () => store.countHint(cfg.collection)` est déclaré UNE fois pour tous les onglets de
liste, cf. `main.ts addListTab`) et les dégradations G9 de la palette. Ces gardes ne connaissent que
l'ÉTAT d'hydratation — jamais un nom de collection.

### Listings : tri serveur, et pas de facette à traiter

`ListConfigs.applications` / `ListConfigs.attachments` déclarent le `sortField` de chaque colonne dont
l'accesseur `sort` lit un champ SCALAIRE du modèle — `name`, `url`, `description` pour les
applications ; `name`, `file_name`, `size`, `description` pour les pièces jointes (`size` est
NUMÉRIQUE : l'`ORDER BY` serveur n'y applique pas `COLLATE NOCASE`, donc 9 avant 10). En régime pagé,
ces critères ordonnent le CORPUS entier.

Deux colonnes n'en déclarent PAS, à dessein : **« Hébergée sur »** et **« Attachée à »** trient un nom
d'équipement/VM/sous-équipement RÉSOLU par jointure CLIENTE, que la table de la collection ne porte
pas. C'est le repli documenté de `ListColumn.sortField` : la découpe suit l'ordre serveur par défaut
et le critère ne trie que la page affichée.

**G8 est SANS OBJET pour cette vague** (mesuré) : aucun des deux listings n'a de facette de colonne.
Le filtrage par cible passe par la dimension CIBLE (`targetFilter` → `where` SERVEUR sur colonnes
indexées), qui reste donc JUSTE sur corpus partiel — le serveur filtre, le cache ne sert de rien.

⚠ **Raffinement de G3 apporté par la vague** — mesuré sur un geste très courant : l'UPLOAD d'une pièce
jointe passe par sa route multipart dédiée, donc **hors du Store** ; le client le découvre par le SSE
de sa propre écriture (cette route n'envoie pas `X-Client-Id`, l'événement n'est donc pas filtré). En
régime hydraté, la collection était re-tirée et la nouvelle pièce apparaissait ; en régime lazy, G3
saute le rechargement — la pastille se mettait à jour, mais la page du listing restait telle quelle. Le
point d'accroche G3 **oublie donc désormais la page en main** du listing concerné
(`ListView.forgetServerPage`, registre `collection → listing` tenu par `main.ts`) : le rendu qui suit
immédiatement (`RestDocuments` appelle `refreshActive()` après tout rechargement) en redemande une
fraîche. Coût BORNÉ — une page, jamais la collection — et le bénéfice vaut aussi pour la vague 1.

### 🚨 G7 — les sections de fiches deviennent ASYNCHRONES

Les fiches affichent la section « Pièces jointes » (équipement, sous-équipement) et le bloc
« Applications hébergées » (équipement, VM) en lisant l'index FK du **cache**. Sur une collection
lazy, elles s'afficheraient **VIDES** alors que le serveur a des lignes — le pire mode de panne du
chantier : une fiche qui affirme qu'il n'y a rien.

Le Store expose donc les **jumeaux ASYNC** de ses quatre helpers de relation —
`attachmentsOfEquipmentAsync`, `attachmentsOfSubEquipmentAsync`, `applicationsOfEquipmentAsync`,
`applicationsOfVmAsync`. Corps UNIQUE (`Store._sectionRows`) : cache si la collection est `full`,
sinon `fetchBy` (la FK est indexée côté serveur — c'est exactement la requête que pose la section),
**même tri** que les jumeaux synchrones (comparateur écrit une fois, `Store.BY_NAME`). Les lignes
reçues sont **ABSORBÉES**, donc la fiche de la pièce ou de l'application s'ouvre ensuite normalement
(`store.get` la trouve). En mode fichier : promesse résolue sur le cache, **aucun réseau, aucun écart
visible** (principe n°15) — l'appelant n'écrit aucun test de mode.

Côté rendu, une fiche se construit d'un trait, de haut en bas : un `appendChild` au retour d'une
promesse poserait la section EN FIN de fiche. `views/forms/AsyncSection` réserve donc la **place**
tout de suite et la remplit ensuite —
- **jamais de flash « vide »** : « Chargement… » tant que rien n'est arrivé (en mode fichier la
  promesse est résolue avant le premier rendu du navigateur : le libellé n'est jamais vu) ;
- liste vide → conteneur laissé vide, la section reste **masquée** (comportement historique) ;
- échec réseau → ligne discrète « Chargement impossible », jamais un silence qui se lirait « aucune
  pièce jointe ».

Le rendu du bloc « Applications » était RECOPIÉ dans la fiche équipement et dans la fiche VM ; il est
extrait dans `views/forms/ApplicationUi` (jumeau d'`AttachmentUi`), sans quoi le passage à l'async
aurait recopié une seconde mécanique par-dessus la première.

**Limite assumée** : chaque (re)construction d'une fiche redemande sa section (les fiches se
reconstruisent à chaque `onResume`). C'est une requête par FK indexée, plafonnée par le nombre de
lignes de la relation — le prix, mesuré, de ne pas garder de cache d'affichage à invalider.

### 🚨 G5 — l'aperçu de cascade passe par un ENDPOINT SERVEUR

L'EXÉCUTION d'une suppression était déjà sûre (le serveur recalcule le plan résiduel,
`ApiRules.residualCascade`). L'APERÇU, lui, était calculé sur les index du CACHE : il
**sous-estimerait** dès qu'une collection du périmètre est lazy (« 0 adresse détachée » alors que le
serveur en détachera trois).

**Route** (montée sous `/documents/:docId`) :

```
POST /cascade-preview     { collection: string, ids: string[] }
  → 200 { deletes: [{ c, id }], detaches: [{ c, id, key, value }] }
```

- la réponse EST le `CascadePlan` partagé, tel quel : l'aperçu serveur et l'aperçu local rendent le
  MÊME objet, donc l'appelant les emploie indifféremment ;
- le moteur est celui de la suppression (`Cascade.planMany`, partagé, MULTI-RACINES — ce que la purge
  de masse demande) : l'aperçu ne peut pas diverger de ce que `DELETE`/`/transact` feront ;
- 🚨 **LECTURE PURE** : la route est montée **AVANT** `resolveRepo` et résout le dépôt par la moitié
  lecture de ce middleware (`resolveRepoRead`, extraite pour l'occasion). Passée par le chemin
  d'écriture, elle consommerait une **révision** et publierait un **SSE** à chaque ouverture de modale
  de confirmation. Elle est POST par sa CHARGE (une liste d'ids ne tient pas dans une query string sur
  une purge de masse), pas par son effet ;
- 400 sur `ids` non-tableau ou au-delà du plafond (`CASCADE_PREVIEW_CAP` = 1000 racines), 404 sur
  collection inconnue ; les ids inconnus sont simplement ignorés par le moteur.

**Critère client** (`Store.cascadePreviewAsync`, LE point d'entrée des UI) : **corpus intégralement
hydraté → plan LOCAL ; sinon → plan SERVEUR**. Volontairement CONSERVATEUR plutôt qu'exact — restreindre
le critère au périmètre RÉEL de la cascade demanderait de déclarer à la main les collections qu'atteint
chaque règle `custom` de `Cascade.SPEC` (fonctions opaques), et une déclaration oubliée ferait
sous-estimer EN SILENCE, exactement la panne que G5 existe pour empêcher. Le prix de la prudence est UN
aller-retour sur une modale déjà asynchrone. Conséquences : en **mode fichier** l'état inerte est
toujours « tout full » → le chemin est TOUJOURS local, sans réseau ni écart ; un adaptateur sans aperçu
serveur (contrat par défaut de `DataAdapter`, qui rend `null`) **retombe sur le plan local** ; une
sélection vide ne part jamais sur le réseau.

**Consommateur** : la purge de masse des VMs (`VmPurgeForm`), seul aperçu de cascade de l'app — la
modale de suppression générique, elle, n'affiche aucun effet (mesuré : `app.main.deleteGenericMessage`
ne dit que le nom). Elle a DEUX dépendances au corpus, qui ne posent pas la même question :

| Question | Réponse | Pourquoi |
|---|---|---|
| « que va emporter la purge ? » (PLAN) | `cascadePreviewAsync` | le plan est une propriété du corpus — le serveur fait autorité |
| « cette VM héberge-t-elle une application ? » (critère d'ENRICHISSEMENT, par VM, AVANT toute sélection) | `store.hydrate(["applications"])` à l'ouverture de la modale | aucun plan ne répond à ça : il liste les applications détachées, pas leur VM d'origine. Sans hydratation, des VMs enrichies seraient proposées comme « nues » et purgées avec leur rattachement, sans que rien ne le signale |

Le récapitulatif devient donc asynchrone : plan **mémoïsé par sélection** (cocher puis décocher ne
redemande rien), **jeton d'obsolescence** (une réponse devancée ne peint pas), « en attente » plutôt
qu'un compte d'IP provisoire, et le bouton de purge reste piloté par la seule SÉLECTION (il ne se
désactive jamais le temps d'un aller-retour). La confirmation finale lit le MÊME mémo : aucun
aller-retour de plus dans le cas nominal.

### M4 — purger du cache ce que le serveur a supprimé EN PLUS

Le client ignore l'événement SSE de sa PROPRE écriture (`X-Client-Id`) : rien ne lui apprendrait que le
serveur a supprimé plus que son plan. Le cas est réel et vient de G3 — une collection lazy n'est pas
rechargée sur événement SSE, sa copie en cache peut donc être PÉRIMÉE (un autre client a re-ciblé une
pièce jointe vers l'équipement qu'on supprime) ; et une pièce jamais absorbée n'entre pas dans notre
plan, mais compte dans le TOTAL affiché par la pastille.

Mesuré : `POST /transact` (le chemin de TOUTE suppression du client, cf. `Store._removeTargets`)
répondait **204 sans corps** — il n'y avait donc rien sur quoi purger. Il rend désormais un **compte
rendu du résidu** (changement ADDITIF : aucun appelant ne lisait ce corps) :

```
POST /transact  → 200 { residual: { deletes: [{ collection, id }], updates: [{ collection, id }] } }
```

`Store._applyResidualDeletes` en retire du cache les enregistrements supprimés (données + index id +
index FK) et **invalide leurs compteurs**. Tolérant par construction : sans `residual.deletes`
(adaptateur fichier, serveur antérieur), c'est un no-op strict. `residual.updates` est lui aussi
**consommé** depuis la vague 4 (**M4b**, `Store._refreshResidualUpdates` — la limite « rapporté mais
non exploité » de cette vague est LEVÉE) : cf. § « Vague 4 » pour le refetch groupé, ses
invalidations et sa tolérance aux échecs.

### G10 — les consommateurs synchrones, un par un

Relevé EXHAUSTIF des lectures synchrones des deux collections, et statut de chacune :

| Consommateur | Statut |
|---|---|
| Sections « Pièces jointes » des fiches équipement / sous-équipement | **ASYNC** (G7) |
| Bloc « Applications hébergées » des fiches équipement / VM | **ASYNC** (G7) |
| Pastilles d'onglet « Applications » / « Pièces jointes » | déjà générique — `store.countHint` (G6) |
| `warnAttachmentsExcluded` (avertissement D8 avant un export sans binaires, `main.ts`) | **corrigé** : `await store.countOf("attachments")` — le chemin était déjà async (`Dialog.confirm`) |
| `labelOf` des cibles d'intervention (`applications` est une famille de cibles) | **corrigé** : préalable `InterventionTargetSource.prepareLabels(links)` — résolution GROUPÉE des ids référencés (voir ci-dessous et § « Vague 4 ») |
| `VmPurgeForm` : critère d'enrichissement + aperçu | **corrigé** : hydratation ciblée + `cascadePreviewAsync` (G5) |
| Listing : `onDownload` / `onShow` / `canShow` (`store.get("attachments", id)`) | **rien à faire** : la ligne vient d'être servie par le listing, donc ABSORBÉE au cache |
| `AttachmentUi.section` (bouton Télécharger → `store.get`) | **rien à faire** : même raison, les lignes affichées sont absorbées |
| Fiches `attachmentDetail` / `applicationDetail` (`store.get`) | **rien à faire** : atteintes depuis un listing (absorbé), une section de fiche (absorbée par `fetchBy`), ou la palette (lecture unitaire `fetchOne` du lot 1) |
| Viewer intégré + téléchargement du binaire | **rien à faire** (vérifié) : `AttachmentUi.view`/`download` lisent le BINAIRE par `attachmentStore.getBlob(id)` / `downloadUrl(id)` — lecture UNITAIRE ou URL streamée, jamais `store.all` |
| `FileDocuments` : `docHasAttachments`, `attachmentsStillMissing`, `writeAttachmentsToHandle`, compagnon `.nmfa` | **rien à faire, prouvé** : appelés depuis `loadFromText` (import, où `Store.replaceAll` vient de re-marquer TOUT `full`) ou APRÈS `writeToHandle`, qui appelle `hydrateAll()` (G2) |
| `keepOnly` (purge des binaires orphelins) | **rien à faire, prouvé** : `main.ts` l'appelle dans la branche `else` d'`if (REST_MODE)` (mode fichier strict) et `FileDocuments.loadCompanionAttachmentsOnOpen` sur le chemin d'ouverture d'un `.json` (corpus complet par construction) |
| Palette de recherche globale (corpus local, « récents ») | **dégradation ACTÉE** — cf. G9 ci-dessous |

#### Cibles d'intervention : le préalable de résolution des libellés

`InterventionTargetSource.labelOf` est SYNCHRONE — la vue « Interventions » résout un libellé de cible
par id au moment du rendu (colonne « Liens », liste de la fiche, chip de filtre, éditeur de liens) et
ne peut pas attendre. Une intervention liée à une cible non absorbée d'une collection lazy
s'afficherait « introuvable », comme si la cible avait été supprimée.

Le contrat porte donc **`prepareLabels(links): Promise<void>`** : un préalable attendu par la vue
avant tout rendu qui résout des libellés, auquel elle passe les cibles QU'ELLE VA AFFICHER. La forme
actuelle (résolution GROUPÉE des seuls ids référencés, appelants, mode fichier) est décrite au
§ « Vague 4 » — elle a REMPLACÉ l'hydratation en masse d'`applications` que cette vague avait posée
(le patron `NotificationsAdminView` restait celui d'une surface qui a besoin de la liste COMPLÈTE,
ce que la résolution de quelques libellés n'est pas). Le SEAM, lui, n'a pas bougé : la vue
interventions ne touche toujours pas le Store, et un **échec est AVALÉ** par l'hôte — mieux vaut un
listing complet avec un libellé en moins qu'une page qui refuse de s'afficher (même doctrine que
`ensureTrackerProviders`).

### G9 — les dégradations de la palette s'étendent, telles quelles

Les trois dégradations actées de la vague 1 valent identiquement pour les deux collections : les
« consultés récemment » d'une pièce jointe ou d'une application non absorbée ne se résolvent pas ; un
échec de `/search` replie sur un corpus local incomplet (résultats ET compteurs par famille) ; le mode
fichier est inchangé. **Ouvrir** un résultat reste couvert par la lecture unitaire `fetchOne` de
`GlobalSearchPalette.activate` (correctif du lot 1, générique).

### Ce que la vague 2 ne change PAS

La cascade elle-même (le moteur partagé est inchangé), l'undo, la validation, le formulaire d'upload
d'une pièce jointe, les binaires (disque serveur / IndexedDB / compagnon `.nmfa`), les 20+ autres
listings, le mode fichier et le visualiseur.

## Vague 3 — `wifiClients` chargée paresseusement (mode API)

La collection la plus **VOLUMINEUSE** de l'app, et la seule alimentée par une **synchro** serveur
(inventaire d'un contrôleur wifi, cf. `docs/wifi-unifi.md`) : c'est elle qui porte le gain réel du
chantier. Elle hérite de tout ce qui précède ; ne sont décrits ici que ses points durs propres.

### Ce qui est acquis sans rien écrire

Ajouter `"wifiClients"` à `LAZY_COLLECTIONS_API` suffit à obtenir le boot qui ne la tire plus
(`skipCollections`), la re-déclaration après `_hydrate`, G1/G2/G3, le **pager serveur réel** G4 avec
son tri (lot 1b), les **compteurs** G6 de la pastille d'onglet, l'oubli de la page en main sur
événement SSE, l'aperçu de cascade serveur G5 et les dégradations G9 de la palette. Ces gardes ne
connaissent que l'ÉTAT d'hydratation — jamais un nom de collection.

**G7 est SANS OBJET** (mesuré) : aucune fiche n'affiche de section « clients wifi ». La seule FK
entrante du modèle est `wifiClients.ap_equipment_id` → `equipments`, et elle ne sert qu'à la colonne
« Point d'accès » du listing et au bouton « Localiser ». Il n'existe donc aucun bloc de fiche à
rendre asynchrone (`AsyncSection` reste disponible le jour où l'on voudrait « les clients de CETTE
borne » sur la fiche d'un équipement).

### Listing : tri serveur, et les quatre colonnes qui n'en déclarent pas

`ListConfigs.wifiClients` déclare le `sortField` des seules colonnes dont l'accesseur `sort` lit un
champ SCALAIRE : **`mac`**, **`ssid`**, **`connected_since`**. Les quatre autres colonnes triables en
sont dépourvues, chacune pour une raison mesurée — repli assumé (`ListColumn.sortField`) : la découpe
suit l'ordre serveur par défaut et le critère ne trie que la page affichée.

| Colonne | Ce que trie l'accesseur | Pourquoi pas de `sortField` |
|---|---|---|
| **Nom** | `WifiClient.displayName` = nom **sinon la MAC** | aucune colonne SQL ne porte cette expression. Trier sur `name` seul grouperait à l'extrémité **tous** les clients sans hostname — le cas NOMINAL côté wifi — alors que la colonne affiche leur MAC : un ordre visiblement faux, pire qu'un repli |
| **Type** | présence PUIS type (`WifiStatus.sortKey` + `rawType`) | deux colonnes en une |
| **IP** | `Ip.toInt(c.ip)` — un ENTIER | la colonne est du TEXT : l'`ORDER BY` mettrait « 10.0.0.10 » avant « 10.0.0.9 », le contraire de ce que la vue montre |
| **Point d'accès** | nom d'ÉQUIPEMENT résolu par jointure CLIENTE | même repli que « Hébergée sur » / « Attachée à » (vague 2) |

⚠ **« Nom » est le critère par DÉFAUT du listing** : au repos, la vue affiche donc la page 1 de
l'ordre serveur par défaut (`created_date`), triée côté client. C'est la limite résiduelle la plus
visible de la vague. Deux leviers, aucun retenu ici : basculer le tri par défaut sur une colonne
serveur-triable (changement d'UX non demandé), ou apprendre une EXPRESSION à `ListOrder`
(`COALESCE(name, mac)`) — ce qui ouvrirait la liste blanche à autre chose que des noms de colonnes.

### 🚨 G8 — les facettes deviennent un `SELECT DISTINCT` SERVEUR

C'est le morceau neuf de la vague, et l'application de l'**arbitrage n°4** : le calcul « sur-page »
des petites collections (vague 1) n'a plus de sens sur un corpus de synchro. Le listing wifi a trois
facettes de colonne — **Type**, **SSID**, **Point d'accès** — bâties en balayant
`store.all("wifiClients")`, qui ne contient que les pages parcourues.

#### La liste blanche, partagée (`src-shared/ListFacets`)

Jumeau de `ListOrder`, et pour la même raison : le CLIENT doit savoir ce qu'il peut demander (sinon
il dégraderait mal), le SERVEUR doit valider ce qu'il interpole (sinon c'est une injection SQL). Une
seule source — la spec déclarative :

- **facettable = champ de spec de type `string`**. Sont exclus les `number` (autant de valeurs
  distinctes que de lignes), les `boolean` (deux cases n'apprennent rien qu'une colonne triable ne
  dise), les `string[]`/`json` (le DISTINCT porterait sur le JSON **sérialisé**, pas sur les
  éléments — une facette d'appartenance demande un `json_each`, à instruire au besoin), les 4
  colonnes d'**audit**, `id`, `search` et `updated_rev` ;
- **invariant testé** : facettable ⊂ triable, sur TOUTES les collections. Inclusion **stricte** — la
  réciproque est fausse par construction ;
- `ListFacets.distinctSql` **REFUSE** (throw nommé) toute colonne hors liste : la liste blanche est
  la seule porte, jamais d'interpolation silencieuse.

Sémantique du SQL, calquée sur ce que font les options **locales** du même filtre :

```sql
SELECT DISTINCT "col" AS value FROM "coll" WHERE "col" IS NOT NULL AND "col" <> '' ORDER BY 1 LIMIT ?
```

- 🚨 **DISTINCT sensible à la CASSE** (collation binaire — surtout pas `COLLATE NOCASE`) : le filtre
  compare par ÉGALITÉ EXACTE de chaîne (`set.has(String(v))`), donc replier « WIRELESS » et
  « wireless » en une option produirait un identifiant qui ne matcherait que la moitié des lignes.
  Le filtre paraîtrait cassé. Les deux valeurs restent DEUX options, comme en mode fichier ;
- **NULL et chaîne vide exclus** — parité du `if (v)` local : « pas de valeur » n'est pas une option
  (`ListView` la traduit en sentinelle `__none__`, qu'aucune option ne porte) ;
- **`ORDER BY 1`** rend le plafond déterministe ; le tri d'AFFICHAGE, lui, reste client et applique
  la MÊME règle qu'en local ;
- **plafond `VALUES_CAP` = 500**, détecté par `LIMIT cap+1` (la ruse de `searchAll` : la ligne
  excédentaire dit « tronqué » sans payer un `COUNT(DISTINCT …)`). Cap ASSUMÉ — une colonne qui
  l'atteint n'est pas une facette. `truncated` est un signal de DIAGNOSTIC serveur, non remonté à
  l'UI (qui n'affiche que des valeurs).

#### La route

```
GET /documents/:docId/facets/:collection?field=<champ>
  → 200 { field: string, values: string[], truncated: boolean }
  → 400 champ absent ou hors liste blanche · 404 collection inconnue
```

- **LECTURE PURE au sens le plus simple** : c'est un GET, donc `resolveRepo` délègue à sa moitié
  lecture (`resolveRepoRead`) — aucune révision consommée, aucun SSE. Contrairement à l'aperçu de
  cascade (POST par sa CHARGE : une liste d'ids), la charge tient ici dans une query string ; rien ne
  justifierait un POST, ni le middleware dédié qu'il a fallu extraire pour lui ;
- **montée sous `/facets/:collection`**, et non `/:collection/facets` : le second ferait dépendre le
  routage de la VALEUR d'un identifiant (un enregistrement dont l'id vaudrait « facets » masquerait
  la route via `GET /:collection/:id`). Elle rejoint donc `/search` et `/maintenance`, les routes non
  collectionnelles déjà montées avant le CRUD générique ;
- **400 explicite** sur un champ hors liste, jamais un silence : une facette demandée et non servie
  ferait croire à un filtre vide alors que la colonne existe. Le dépôt re-refuse de toute façon
  (défense en profondeur, parité `list`) ;
- **aucun compte** dans la réponse. Mesuré : la barre de filtres n'affiche que des libellés
  (`MultiItem = { id, label }`) — un `GROUP BY … COUNT(*)` serait payé pour rien. Le jour où l'UI
  montrerait « SSID · Corp (312) », c'est ce contrat qui s'étend, pas un second endpoint.

#### Côté client : des options SYNCHRONES servies par une valeur ASYNCHRONE

`ListColumn.filter.options()` est synchrone par contrat (réévalué à chaque rendu). Le patron est
**strictement celui des compteurs G6**, transposé — deux mécaniques différentes pour le même
problème auraient divergé :

| | Compteurs (G6) | Facettes (G8) |
|---|---|---|
| module pur | `core/CollectionCountCache` | `core/CollectionFacetCache` |
| accesseur du Store | `countHint(c)` | `facetValues(c, field)` |
| point d'arrivée | `store.onCountResolved` → `shell.refreshCounts()` | `store.onFacetResolved` → `ListView.refreshFacetOptions()` |

- `Store.facetValues(collection, field)` : collection **hydratée** → balayage du CACHE, exact et sans
  réseau (donc le mode fichier et le visualiseur, PAR CONSTRUCTION) ; collection **partielle** → les
  dernières valeurs connues du DISTINCT serveur, liste VIDE en attendant, relevé déclenché (au plus
  un en vol par (collection, champ)) ;
- **opt-in `ListColumn.filter.field`** : le nom du champ scalaire que lit `valueOf`. Déclaré sur
  **Type** (`client_type`) et **SSID** (`ssid`). ⚠ **PAS sur « Point d'accès »**, à dessein : sa
  valeur est le nom de l'ÉQUIPEMENT rapproché (jointure cliente sur `ap_equipment_id`), et ne retombe
  sur `ap_name` qu'à défaut — un DISTINCT sur `ap_name` proposerait donc des valeurs que la colonne
  n'affiche pas (casse et espaces du contrôleur, borne renommée dans DC Manager) et le filtre, une
  fois posé, ne matcherait rien. Repli assumé : options du cache, comme la vague 1 ;
- la bascule est opérée par **`StoreListRowSource.facetOptions`**, qui rend `null` — « garde tes
  options locales » — en mode fichier et sur une collection hydratée. Mêmes conditions que le pager,
  **moins la troisième** : pas de « requête au repos ». Les options d'un filtre décrivent le CORPUS,
  pas le jeu affiché ; les rétrécir pendant une recherche serait un piège (filtre et recherche se
  composent) ;
- 🚨 **une valeur SÉLECTIONNÉE figure toujours dans les options** (`CollectionFacetCache.withSelected`).
  `ListView` purge de l'état de filtre tout ce qui n'est pas une option (« parité historique » : une
  valeur disparue ne laisse pas de chip fantôme). Servies en async, les options sont VIDES au premier
  rendu — sans cette union, un filtre restauré depuis la session serait effacé **en silence**, avant
  même la réponse du serveur. Avec elle, la purge est un no-op tant que le relevé n'est pas arrivé,
  et redevient exacte ensuite, sans que `ListView` connaisse le régime ;
- **invalidation** : les mêmes points que les compteurs — création, suppression/cascade (y compris le
  résidu M4), clonage, `_refetchWhole`, `_hydrate`, et le point d'accroche G3 — **plus les MISES À
  JOUR**, que les compteurs ignorent : un total ne bouge pas quand on édite un enregistrement, une
  valeur de colonne si ;
- **aucune chaîne d'UI nouvelle** (donc aucune clé i18n) : la demande part au PREMIER rendu du
  listing et la réponse repeint la barre. Une dimension vide n'est visible que dans la fenêtre d'un
  aller-retour, avant même que l'utilisateur ait ouvert le menu « + Filtre ».

#### ⚠ La limite résiduelle que G8 rend plus visible

Les **filtres de colonne s'appliquent à la PAGE reçue**, pas au corpus (limite déjà documentée pour
le pilote). Tant que les options ne proposaient que les valeurs vues, l'écart passait inaperçu ;
maintenant qu'elles couvrent le corpus entier, choisir une valeur absente de la page en main donne un
listing **vide** sous un compteur qui annonce toujours le total serveur (« 4 217 éléments · page
1/169 »). C'est cohérent avec le régime pagé mais déroutant, et c'est **le premier candidat à
instruire** pour une suite : porter les filtres de colonne actifs en `where` sur la route paginée.
Ce n'est pas un ajustement — la sélection est MULTI-valeurs alors que le `where` serveur est une
égalité mono-valeur (`whereClause` prend le premier élément d'un tableau), il faudrait donc un `IN`,
sa validation, sa place dans la signature de page, et l'articulation avec `_applyColumnFilters`.

### Synchro wifi ⇄ SSE : ce que voit l'utilisateur (statué)

Une passe de synchro écrit côté serveur puis publie un SSE `origin: "wifi-sync"` avec
`changeset.collections = ["wifiClients"]` (`WifiSyncService`). Aucun client ne porte cet id : **tous**
rechargent, y compris celui qui a cliqué « Synchroniser ». En régime lazy, G3 **saute** le
rechargement de la collection — et c'est voulu : la re-tirer entière à chaque passe annulerait le
chantier. Ce qui se passe alors, dans l'ordre :

1. `Store.reloadCollections` invalide le **compteur** (G6) **et les valeurs de facette** (G8 — une
   passe peut apporter un SSID ou un type de raccordement inédit), puis appelle `onLazyReloadDeferred` ;
2. `main.ts` **oublie la page en main** du listing wifi (`ListView.forgetServerPage`, mécanique de la
   vague 2) et redemande le rendu des pastilles ;
3. `RestDocuments.reload` appelle `refreshActive()` juste après → le listing se repeint, **redemande
   sa page** et ses facettes.

**Verdict : un listing wifi OUVERT pendant une synchro se rafraîchit tout seul**, sans intervention —
pastille juste, page fraîche, options de filtre à jour. Le coût reste BORNÉ : une page et deux
`SELECT DISTINCT`, jamais la collection. Onglet fermé : rien n'est tiré, et la page sera demandée à
la prochaine navigation. Ce qui NE se rafraîchit pas : une **fiche** de client wifi ouverte pendant
la passe garde ses valeurs à l'écran (elle lit le cache) — comportement inchangé par la vague, et le
même que pour toute autre collection dont la fiche est ouverte au moment d'un rechargement.

### G10 — les consommateurs synchrones, un par un

Relevé EXHAUSTIF des lectures synchrones de `wifiClients`, et statut de chacune. **Une seule ligne
demandait une correction — aucune** : tous les chemins partent d'un enregistrement déjà ABSORBÉ.

| Consommateur | Statut |
|---|---|
| Listing « Wifi » (colonnes, tri, filtres) | **régime pagé** (G4) + facettes serveur (G8) |
| Pastille d'onglet « Wifi » | déjà générique — `store.countHint` (G6) |
| **« Localiser » d'une ligne** (`WifiLocate.apEquipmentId(store.get("wifiClients", id), store))`, `main.ts`) | **rien à faire, prouvé** : l'action part de la LIGNE du listing, donc d'un enregistrement que le pager vient d'absorber. L'AP visé est un `equipments` — collection HYDRATÉE, hors chantier —, et `store.equipmentLocatable` reste exact |
| Bouton « Localiser » de la FICHE (`DetailForms.wifiClientDetail`) | **rien à faire** : la fiche a déjà l'enregistrement en main (elle vient de le lire) |
| Fiche `wifiClientDetail` (`store.get`) | **rien à faire** : atteinte depuis le listing (absorbé) ou depuis la palette — couverte par la lecture unitaire `fetchOne` de `GlobalSearchPalette.activate` (correctif générique du lot 1) |
| `WifiForms.edit` (`store.get`, édition des champs LOCAUX) | **rien à faire** : ouverte depuis la fiche, donc sur une ligne absorbée |
| Cascade : supprimer un ÉQUIPEMENT **détache** `wifiClients.ap_equipment_id` | **rien à faire, prouvé** : l'EXÉCUTION est sûre (le serveur recalcule le plan résiduel), la modale de suppression générique n'affiche AUCUN effet, et l'aperçu de `VmPurgeForm` — seul aperçu de l'app — passe déjà par `cascadePreviewAsync` (G5), qui bascule sur le serveur dès que le corpus est partiel. La FK d'un client wifi absorbé est en outre RAFRAÎCHIE par M4b depuis la vague 4 (`residual.updates` est désormais consommé) |
| Synchro / providers (`WifiForms.sync`, `WifiProvidersForm`, `WifiSyncClient`) | **rien à faire, vérifié** : ces surfaces parlent aux routes `…/wifi/*` du module serveur ; elles ne lisent JAMAIS la collection |
| Script de suppression de la feature (`docs/wifi-unifi.md`) | **doc mise à jour** : retirer `"wifiClients"` de `core/LazyCollections` fait désormais partie de la procédure |
| Palette de recherche globale (corpus local, « récents ») | **dégradation ACTÉE** — G9, à l'identique des vagues 1-2 |

### Ce que la vague 3 ne change PAS

La synchro elle-même (serveur, inchangée), la frontière SOURCE/LOCAUX (`src-shared/WifiSync`), la
réconciliation, le rapprochement de l'AP, la cascade, l'undo, la validation, les 20+ autres listings
(aucun ne déclare de `filter.field` : `contacts` GARDE son calcul sur-page de la vague 1, `vms` reste
exclue du chantier), le mode fichier et le visualiseur.

## Vague 4 — `spares` chargée paresseusement (mode API), M4b et la résolution groupée des libellés

La DERNIÈRE candidate du cadrage (`vms` reste EXCLUE — transverse : graphe, purge, certs, IPAM,
bulle 3D), instruite sous la **doctrine utilisateur du 2026-08-13** : « async par COHÉRENCE —
hydraté = ce que le 3D consomme ». Ses deux points durs (cascade `custom` qui LIT le nom, `labelOf`
synchrone des cibles d'intervention) ne se contournent plus par des hydratations en masse : la vague
livre les deux chaînons qui les résolvent PROPREMENT — **M4b** et la **résolution groupée** — puis
rejoue le patron des vagues 1-3.

### Ce qui est acquis sans rien écrire

Ajouter `"spares"` à `LAZY_COLLECTIONS_API` suffit à obtenir le boot qui ne la tire plus
(`skipCollections`), la re-déclaration après `_hydrate`, G1/G2/G3, le **pager serveur réel** G4 avec
son tri (lot 1b), les **compteurs** G6 de la pastille d'onglet, l'oubli de la page en main sur
événement SSE, l'aperçu de cascade serveur G5 et les dégradations G9 de la palette (étendues telles
quelles : « récents » non résolus hors cache, repli local incomplet de `/search`, mode fichier
inchangé — l'ouverture d'un résultat reste couverte par le `fetchOne` du lot 1).

### 🚨 M4b — consommer `residual.updates` (la raison d'être de la vague)

La cascade `custom` d'`equipments` **DÉTACHE** les spares du serveur supprimé (`assigned_free` ← nom
de l'équipement, `assigned_equipment_id` ← null — cf. `src-shared/Cascade.ts`). Côté client, le plan
LOCAL ne voit que les spares ABSORBÉS : sans M4b, un spare en cache détaché par la cascade SERVEUR
resterait affiché rattaché à un équipement disparu — c'est la limite « `residual.updates` rapporté
mais non exploité » que M4 avait documentée, désormais **LEVÉE**.

`Store._refreshResidualUpdates` (branché au MÊME endroit que M4 : `_removeTargets`, après
`_applyResidualDeletes` — TOUTES les suppressions du client passent par là ; les autres `transact`
du Store, `updateBatch` et le clonage, ne portent aucun delete → résidu vide par construction) :

- **tous les ids rapportés** sont refetchés — un enregistrement d'une collection HYDRATÉE doit
  impérativement l'être (son cache serait faux), un enregistrement pas encore en cache d'une
  collection lazy est simplement ABSORBÉ (`partial`, aucun mal — il devient résoluble) ;
- **refetch GROUPÉ par collection** (`fetchMany` → `GET ?ids=…`, absorption + ré-indexation), volume
  borné par la largeur de la cascade ;
- **en ARRIÈRE-PLAN** : l'écriture ne l'attend pas (patron des caches async G6/G8 — la valeur
  arrive, `_emit` repeint) ; un **échec réseau ne casse jamais l'écriture** (elle est faite) — trace
  `Log.d`, et les caches se rattrapent par les chemins ordinaires (page redemandée, SSE, F5) ;
- invalidations : les **facettes** des collections touchées (une valeur de colonne a changé — même
  règle que les écritures locales), jamais les compteurs (une mise à jour ne change aucun total).

### La résolution GROUPÉE des libellés de cibles (remplace « prepareLabels = hydrater tout »)

`InterventionTargetSource.prepareLabels` devient **`prepareLabels(links)`** : la vue passe les
cibles QU'ELLE VA AFFICHER, et l'hôte (`main.ts`) résout les seuls ids ABSENTS du cache — partition
par collection dans le module pur `core/TargetLabelResolution` (dédoublonnage, famille inconnue
ignorée, cache consulté), puis UN `fetchMany` par collection (absorption) ; le rendu synchrone
(`labelOf`) trouve alors tout. L'hydratation en masse d'`applications` posée en vague 2 **disparaît**
(aucune autre surface n'en dépendait — vérifié : `VmPurgeForm` porte SA propre hydratation ciblée).

Appelants, tous adaptés à passer leurs liens :

| Appelant | Liens passés |
|---|---|
| `loadPage()` (le point commun de `reload` et `refreshBody` — toute page affichée passe là) | liens de la page reçue + cible du filtre actif (sa chip résout le même `labelOf`) |
| `openDetailById()` (entrée depuis une fiche) | liens du record relu |
| `openDetail()` (entrée depuis la palette — trou d'AVANT la vague, corrigé au passage) | liens du record reçu |
| `refetch` de `detailModalById` + `refreshTicket` | liens du record rafraîchi (no-op nominal : tout est déjà en cache) |

Mode fichier : tout est en cache → partition VIDE → **aucun appel adaptateur**, no-op PAR
CONSTRUCTION (principe n°15). Lien ORPHELIN (cible réellement supprimée) : son id reste demandé à
chaque affichage qui le référence (une lecture groupée, jamais une erreur) et s'affiche
« introuvable » — le comportement voulu. Cas couvert au passage dans `ui/EntityLinkList` : un
candidat fraîchement choisi vient de la recherche SERVEUR (non absorbée) — le composant garde son
libellé de candidat comme REPLI de `labelOf` (jamais comme premier choix), sinon la rangée qu'on
vient d'ajouter s'afficherait « introuvable ».

### Listing : un seul `sortField`, et pas de facette à traiter

`ListConfigs.spares` déclare `sortField` sur la SEULE colonne dont l'accesseur lit un champ
SCALAIRE : **« Achat »** (`purchase_date`). Les autres sont DÉRIVÉES (repli assumé de
`ListColumn.sortField`) : « Désignation » trie `displayName()` (nom SINON marque/modèle — même
verdict que « Nom » wifi, et c'est le critère par DÉFAUT du listing → au repos, page 1 à l'ordre
serveur par défaut, la même limite résiduelle que la vague 3), « Type »/« Statut » trient le
LIBELLÉ localisé et non le slug stocké, « Attribué à » un nom d'équipement résolu par jointure
cliente. **G8 est SANS OBJET** : les deux filtres (Type, Statut) proposent des ÉNUMÉRATIONS FERMÉES
(`SpareTypes`/`SpareStatuses`), exactes par construction quel que soit le cache.

### G7 — la section « Spares affectés » de la fiche équipement

Jumeau async `Store.sparesOfEquipmentAsync` (corps commun `_sectionRows`, FK indexée
`assigned_equipment_id`) + `AsyncSection` (place réservée, pas de flash, masquée si vide). Le rendu
reste INLINE dans `EquipmentForms` : une seule fiche affiche des spares — rien à factoriser tant
qu'une deuxième surface n'existe pas. Le helper SYNCHRONE `sparesOfEquipment` trie désormais par nom
lui aussi (parité STRICTE des jumeaux — l'ordre historique d'insertion de l'index FK n'aurait pas
survécu au régime lazy).

### G10 — les consommateurs synchrones, un par un

| Consommateur | Statut |
|---|---|
| Listing « Spares » (colonnes, tri, filtres) | **régime pagé** (G4) ; filtres = énumérations fermées (G8 sans objet) |
| Pastille d'onglet « Spares » | déjà générique — `store.countHint` (G6) |
| Section « Spares affectés » de la fiche équipement | **ASYNC** (G7, ci-dessus) |
| Fiche `spareDetail` (`store.get`) | **rien à faire** : atteinte depuis le listing (absorbé), la section de fiche (absorbée par `fetchBy`), la palette (`fetchOne` du lot 1) ou un lien d'intervention (absorbé par la résolution groupée) |
| Formulaire `EquipmentForms.spare` (`store.get`) | **rien à faire** : ouvert depuis le listing ou la fiche — ligne déjà absorbée. Son picker « équipement d'accueil » liste des EQUIPMENTS (hydratés) |
| `labelOf` des cibles d'intervention (`spare` est une famille de cibles) | **corrigé** : la résolution GROUPÉE (ci-dessus) |
| Candidats d'intervention (`EntityCandidateSource`) | **rien à faire** : mode API = recherche transverse SERVEUR (au-delà du cache) ; le repli LOCAL sur échec réseau est incomplet — dégradation de la famille G9, actée |
| Cascade : supprimer un ÉQUIPEMENT détache ses spares (règle `custom`) | **couvert** : l'EXÉCUTION est serveur-sûre, l'aperçu passe par G5 dès corpus partiel, et le cache est rafraîchi par **M4b** — c'est SA raison d'être |
| Palette de recherche globale (corpus local, « récents ») | **dégradation ACTÉE** — G9, à l'identique des vagues 1-3 |

### Ce que la vague 4 ne change PAS

La cascade elle-même (le moteur partagé est inchangé — seul un commentaire y pointe M4b), l'undo, la
validation, le serveur (le compte rendu `residual` existait depuis la vague 2 — aucune route ne
bouge), les 20+ autres listings, le mode fichier et le visualiseur. Le chantier n'a plus de candidate :
`vms` reste exclue, et tout l'outillage est générique (G5, G7 + `AsyncSection`, G8, M4/M4b,
`TargetLabelResolution`).

## Arbitrages actés (utilisateur, 2026-08-12)

1. **Lazy par défaut** en mode API pour les vagues 1-3 (les seuils D3 restent l'argument de mesure).
2. **G5** : aperçu de cascade = **endpoint serveur** (le moteur `Cascade` est partagé).
3. **G2** : export = **hydrater tout** avant d'exporter — jamais de refus, jamais d'export amputé.
4. **G8** : **facettes serveur** (distinct SQL) pour les collections volumineuses.
5. **Pager serveur réel** pour les collections lazy ; plafond client conservé pour les hydratées.

S'y ajoute la **doctrine du 2026-08-13** (utilisateur), qui a débloqué la vague 4 : « async par
COHÉRENCE — hydraté = ce que le 3D consomme ». Concrètement : plus d'hydratation en masse posée pour
contourner un point dur (le `prepareLabels` de la vague 2) — on résout ce qu'on va AFFICHER, groupé.

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

`Tests/modules/test-lazy-vague3.js` (vague 3) : liste centrale étendue à `wifiClients` + boot qui saute
TOUTES les collections lazy ; **G8 partagé** — dérivation de la liste blanche `ListFacets` depuis la spec, exclusions
prouvées une par une (number/boolean/tableau/json/audit/id/search), invariant « facettable ⊂ triable »
sur TOUTES les collections (inclusion stricte), `SELECT DISTINCT` golden et barrière anti-injection ;
**G8 pur** — `CollectionFacetCache` (normalisation identique aux options locales, valeur async servie
en synchrone, déduplication, notification collection+champ, invalidation par collection, échec non
mémorisé) et surtout `withSelected`, la règle qui empêche la purge de `ListView` d'effacer un filtre
restauré ; **G8 Store** — `facetValues` local ⇄ serveur, casse préservée, invalidation par la MISE À
JOUR (que les compteurs ignorent) et par le SSE sauté de G3, mode fichier sans le moindre relevé ;
**G8 source** — `facetOptions` qui rend `null` sur une collection hydratée et en mode fichier ; enfin
les `sortField` ET les `filter.field` du listing wifi, confrontés aux DEUX listes blanches partagées,
avec la preuve que les colonnes à valeur dérivée n'en déclarent aucun et que `contacts` garde son
calcul sur-page. Côté serveur, `test-relational-repository.js` prouve le `SELECT DISTINCT` RÉEL
(doublon fondu, vide et NULL exclus, casse préservée, plafond + `truncated`, throw anti-injection).

`Tests/modules/test-lazy-vague2.js` (vague 2) : liste centrale ÉTENDUE + boot qui saute bien les trois
collections lazy ; **G7** — jumeaux async (lecture par FK indexée quand la collection est partielle,
CACHE quand elle est hydratée, absorption + indexation des lignes reçues, tri identique aux jumeaux
synchrones, et mode fichier qui n'émet AUCUN `findBy`) ; **G5** — critère de bascule de
`cascadePreviewAsync` (corpus complet → local sans réseau, corpus partiel → serveur, sélection vide
sans aller-retour, ids dédupliqués et NON filtrés sur le cache, repli local si l'adaptateur n'offre pas
d'aperçu, mode fichier toujours local) ; **M4** — une suppression dont le serveur rapporte un résidu
purge le cache et invalide le compteur, et l'absence de résidu est un no-op strict ; enfin les
`sortField` des deux listings, confrontés à la liste blanche PARTAGÉE (un nom fautif dégraderait en
silence vers le repli).

`Tests/modules/test-lazy-vague4.js` (vague 4) : la liste centrale étendue à `spares` — son contenu
EXACT est verrouillé ICI (délégation des vagues précédentes au dernier fichier à l'avoir étendue) —
et le boot qui saute les CINQ ; **M4b** — les mises à jour résiduelles rapportées par le serveur sont
refetchées GROUPÉES par collection (un `getMany` portant tous les ids), une copie absorbée est
ÉCRASÉE par la vérité serveur, un enregistrement jamais absorbé est ABSORBÉ (`partial`), un échec du
refetch ne casse pas l'écriture, et l'absence de résidu est un no-op strict ; la **partition PURE**
de la résolution groupée (`TargetLabelResolution` : par collection, dédoublonnée, familles inconnues
et ids au cache écartés — partition VIDE = le cas du mode fichier, aucun appel adaptateur) ; **G7** —
le jumeau `sparesOfEquipmentAsync` (FK indexée, absorption, tri par nom IDENTIQUE au jumeau
synchrone, mode fichier sans réseau) ; enfin le `sortField` unique du listing spares
(`purchase_date` ∈ liste blanche), les colonnes DÉRIVÉES qui n'en déclarent aucun, et l'absence
voulue de `filter.field` (énumérations fermées).
