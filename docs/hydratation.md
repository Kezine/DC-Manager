# Hydratation du cache client — état par collection, gardes de sûreté, instrumentation

Le Store client sert son cache hydraté en **synchrone** (le rendu l'exige) : `Store.data[c]` est
initialisé `[]` pour toute collection, et RIEN n'y distingue « vide » de « pas encore chargée » —
`store.all(c)` peut donc **mentir silencieusement** dès qu'une collection est chargée
**paresseusement** (chantier « lazy-load des collections », cadrage
`.notes/toDos/lazy-load-collections-cadrage-2026-08-11.md`). Ce document décrit la vérité
manquante — l'**état d'hydratation par collection** — et les **gardes** qui s'y adossent.

Modules concernés : `src-client/core/HydrationState.ts` (état + prédicats, pur),
`src-client/store/Store.ts` (câblage G1/G2/G3), `src-client/app/FileDocuments.ts` (branchement
export), `src-client/core/HydrationStats.ts` (instrumentation). Tests :
`Tests/modules/test-hydration.js`.

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
| `full → none` | `declareLazy([...])` — posé à l'**ouverture** d'un document, AVANT toute lecture | les **vagues 1-3** du chantier (personne au lot 0) |
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
| **boot** : `init()` → `if (syncCatalogs()) _persistAll()` (`Store.init`) | **le chemin que G1 ferme** | un boot futur à collections lazy déclencherait un snapshot amputé ; la garde le rend structurellement impossible — la vague qui activera le lazy devra réconcilier les catalogues autrement (écritures unitaires) ou hydrater d'abord |
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
appelé avec les collections sautées. C'est là que le **lot 1** invalidera les caches **dérivés**
(compteurs d'onglets `countOf`, facettes…) : les enregistrements en cache d'une collection
partielle peuvent être périmés après un événement SSE ignoré, et seuls les dérivés se recalculent
à bas coût. Personne ne s'y branche au lot 0 (rien n'est jamais sauté).

## Gardes à venir (hors lot 0)

Instruites par le cadrage `.notes/toDos/lazy-load-collections-cadrage-2026-08-11.md` § 2, livrées
avec les vagues : **G4** bascule des listings (`ListRowEngine`/`StoreListRowSource` — page 1
serveur sans saisie), **G5** aperçu de cascade (endpoint serveur), **G6** compteurs d'onglets
(`store.countOf` async), **G7** sections de fiches (`fetchBy` + rendu async), **G8** facettes
serveur, **G9** dégradations assumées de la palette, **G10** divers mesurés
(`warnAttachmentsExcluded`, `labelOf` des cibles d'intervention, consommateurs cachés de `vms`).

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

`Tests/modules/test-hydration.js` : niveaux/transitions/prédicats du module pur, état inerte
`alwaysFull`, erreur nommée de G1 (pure puis via `Store._persistAll` — appelée directement depuis
le JS compilé : le chokepoint est volontairement privé, c'est LUI que la garde ferme), légitimité
de `replaceAll`/`newDocument` en corpus partiel, `hydrateAll` qui recharge exactement les non-full
(adapter simulé espionné), `reloadCollections` qui saute les non hydratées et prévient le point
d'accroche.
