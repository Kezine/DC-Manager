# Recherche — palette Ctrl+K, listings serveur-pilotés, termes partagés

Architecture de la **recherche** de DC Manager : la palette globale (Ctrl+K / loupe topbar), la recherche
et les filtres des **listings**, le module partagé des termes, les routes serveur et la répartition
local ⇄ serveur des deux modes de données.

## Vue d'ensemble

```
                         ┌──────────────────────────────┐
   saisie utilisateur →  │ GlobalSearchPalette (modale)  │ ← actions (« > »), familles
                         └──────┬────────────────┬──────┘   externes (certs, interventions)
                                │                │
                 mode FICHIER   │                │   mode API (provider injecté)
                                ▼                ▼
                 GlobalSearchSources.build   GET …/search (debounce 200 ms + abort)
                 (corpus local complet)      → records par collection (cap/collection)
                                │                │  GlobalSearchSources.dressRecords
                                └───────┬────────┘
                                        ▼
                            GlobalSearch.rank (scoring CLIENT,
                            paliers 100/80/60/30, groupes par famille)
```

Les **termes cherchables** des deux chemins sortent du même module : **`src-shared/SearchTerms.ts`**.
C'est lui qui calcule la colonne `search` du serveur (à l'écriture, cf. `docs/persistance.md`) ET les
termes du corpus local (à l'ouverture de la palette) — la parité des deux modes est **par
construction**, pas par discipline. La **recherche des LISTINGS** boit à la même source
(cf. « Listings serveur-pilotés » plus bas) : une seule définition de « quel texte trouve cet
enregistrement » pour toute l'application.

La palette s'ouvre aussi **pré-remplie par une URL** (`doc/<docId>/recherche/<texte>`) et sait
**copier le lien** de la recherche courante. Le texte porte alors la **portée** sous forme de préfixe
— `GlobalSearch.canonicalQuery`, réciproque exacte de `parsePrefix` — pour que le lien reste une
seule donnée : cf. [`liens-directs.md`](liens-directs.md) § 5.

## Les composants

| Composant | Rôle |
|---|---|
| `src-shared/SearchTerms.ts` | SOURCE UNIQUE de « quel texte trouve un enregistrement » : dérivés par lien/enfants, catalogues fr+en, compositions tapables, requêtes inverses d'invalidation, `SEARCH_VERSION`. |
| `src-client/core/RecordSearch.ts` | ADAPTATEUR client du module partagé : forme canonique du record (`toJSON`), forme LISTE (`termsOf`, pour le scoring de la palette) et forme TEXTE (`textOf` — littéralement le contenu de la colonne `search`, pour les listings). |
| `src-client/core/RecordSearchIndex.ts` | Index MÉMOÏSÉ des textes cherchables d'un listing + `filter(collection, rows, query)` ≡ le `LIKE` serveur. Mesures et politique d'invalidation en tête du fichier. |
| `src-client/core/GlobalSearch.ts` | Scoring PUR : paliers 100 (libellé exact) / 80 (préfixe) / 60 (contient) / 30 (sub/path/termes), groupes par famille jamais entrelacés, comptes, préfixes de portée, surlignage. |
| `src-client/views/GlobalSearchSources.ts` | Corpus et portées : habillage par famille (label/sub/path/pill/locate), termes via `RecordSearch`, `build` (corpus local), `dressRecords` (records serveur), invariant corpus ≡ fiches. |
| `src-client/views/GlobalSearchPalette.ts` | La modale : portées/préfixes, clavier, récents, actions, familles externes, et l'orchestration serveur-pilotée du mode API (debounce, abort, repli). |
| `src-client/core/ListRowEngine.ts` | MOTEUR de lignes des listings : décision local ⇄ serveur, debounce, abort, repli, anti-boucle d'échec. Source INJECTÉE (`ListRowSource`). |
| `src-client/core/StoreListRowSource.ts` | La source concrète : `local()` = cache hydraté + `RecordSearchIndex`, `remote()` = lecteur serveur injecté (`RemoteListReader`), traduction de la cible en `where` ou restriction cliente. |
| `src-client/views/ListTargets.ts` | Descripteurs du **filtre CIBLE unifié** par listing (recherche des candidats, libellés, badge, `where`/`restrict`). |
| `src-client/core/EntityCandidates.ts` | SOURCE de candidats d'entités PARTAGÉE : `EntityCandidates` (pur — `local`/`fromRecords`, re-classés par `TargetSearch`) + `EntityCandidateSource` (orchestration DOUBLE MODE : annulation + repli ; anti-rebond/StaleGate portés par le SearchPop). |
| `src-client/ui/FilterBar.ts` + `core/FilterChips.ts` + `core/TargetFilterDisplay.ts` | Dimension « à RECHERCHE » : déclencheur FERMÉ + panneau-portail à `SearchPop` HÉBERGÉ, chips à valeur LIBRE, badge/placeholder résolus par le module pur `TargetFilterDisplay`. |
| `src-server/src/RelationalRepository.searchAll` | Recherche transverse : un LIKE sur la colonne `search` par collection, plafond par collection, troncature signalée. |
| `src-server/src/RelationalRepository.list` | Listing d'UNE collection : LIKE sur `search` + `where` de colonnes + pagination + tri `sort`/`dir` (liste blanche partagée `ListOrder`, cf. § « Tri SERVEUR du régime pagé ») — la route que consomment les listings serveur-pilotés. |
| `src-shared/ListOrder.ts` + `src-client/core/ListServerSort.ts` | Tri SERVEUR du régime pagé (pagination ordonnée complète) : liste blanche des colonnes triables DÉRIVÉE de la spec + fragment `ORDER BY` (partagé), et mapping critère de vue → champ du modèle (client, pur). |
| `src-shared/ListFacets.ts` + `src-client/core/CollectionFacetCache.ts` | FACETTES du régime pagé : liste blanche des colonnes facettables DÉRIVÉE de la spec + `SELECT DISTINCT` (partagé), et valeurs async servies en synchrone aux options de filtre (client, pur). |
| `GET /api/documents/:docId/search` | La route transverse (api.ts). Garde : « ≥ 1 lecture documentaire », puis **assiette RESTREINTE** aux collections que l'appelant a le droit de lire — l'intersection est passée au dépôt, aucune requête n'est émise pour une collection interdite (cf. [`auth.md`](auth.md) § 8.3). |
| `GET /api/documents/:docId/facets/:collection` | Valeurs DISTINCTES d'une colonne (api.ts) — lecture PURE (cf. § « Facettes du régime pagé »), gardée par la lecture du domaine de la collection. |

## Exécution DOUBLE (principe n°15)

- **Mode FICHIER** : tout est local, **jamais de réseau**. `GlobalSearchSources.build(store)` construit
  le corpus à l'ouverture de la palette ; les termes de chaque item = valeurs PROPRES du record
  (tableaux étalés) + `SearchTerms.termsOf(collection, record, fetch, find)` avec les lecteurs du
  Store (`get`/`findByField`). Conséquence voulue : les catalogues **fr ET en** sont cherchables en
  local aussi (un utilisateur fr trouve une VM par « orphan », un spare par « hard drive ») — même
  contenu que la colonne serveur.
- **Mode API** : la palette est **serveur-pilotée**. Chaque saisie non vide interroge
  `GET …/search?q=…&collections=…` en UN aller-retour (jamais ~20 `list()` par frappe), avec un
  **debounce de 200 ms** (`GlobalSearchPalette.REMOTE_DEBOUNCE_MS`) et l'**annulation** de la requête
  précédente (AbortController). Les records reçus sont HABILLÉS localement
  (`GlobalSearchSources.dressRecords` — l'instance du Store est préférée quand elle existe, le
  document restant hydraté) puis CLASSÉS par le scoring client. Le corpus local reste construit :
  il affiche pendant le debounce/vol et sert de **REPLI** si le serveur échoue (log console, jamais
  bloquant).
- Les familles **externes** (certificats, interventions — bases serveur séparées) et les **actions**
  gardent leur mécanique propre : elles ne sont pas des collections du document.

## Le classement reste CLIENT (décision de cadrage)

Pas de ranking serveur en v1 : le serveur FILTRE (LIKE sur `search`), le client CLASSE
(`GlobalSearch.rank` — libellé exact > préfixe > contient > reste). Le tri serveur
(`created_date, id`) n'est qu'un ordre stable de troncature.

## Caps ASSUMÉS (v1)

- **`RelationalRepository.SEARCH_ALL_LIMIT` = 40 résultats PAR collection** (LIMIT cap+1, sans
  `COUNT(*)` ; les collections tronquées sont signalées dans `truncated`) : au-delà, l'utilisateur
  affine sa requête. La palette v1 n'affiche pas la troncature.
- Le LIKE `'%…%'` n'est pas sargeable (scan par collection) — assumé, la route est debouncée et le
  périmètre restreint aux familles à fiche (`collections=`, envoyé par la palette : inutile de
  scanner `ports`/`aggregates`, inhabillables au corpus).

## Compositions tapables (search-v2) et leurs limites

Le client cherche aussi ses chaînes d'HABILLAGE (sub/path au palier 30, libellés composés). Les
compositions qu'un humain TAPE sont répliquées dans la spec partagée (`own`) et donc cherchables des
deux côtés : **« U12 »** (position en baie), **« ét. 2 »/« fl. 2 »** (étages/salles — les deux
langues), **« 42 U »** (taille de baie), **« 12 brins »/« 12 strands »** (faisceaux), **« marque
modèle »** (équipements, spares), **capacités/rpm** des disques.

**Assumé non répliqué** : les assemblages purement typographiques — « équipement : port » et « A ↔ B »
(extrémités de câbles/faisceaux), « 10.0.0.1 – 10.0.0.9 » (plages DHCP), les joints « · » des
sous-lignes. Leurs termes constitutifs matchent individuellement ; personne ne tape le séparateur.
Un copier-coller de la chaîne complète ne matche donc que côté client (habillage), pas côté serveur.

⚠ **Toute évolution de `SEARCH_SPECS`/`SEARCH_CATALOGS` doit incrémenter `SearchTerms.SEARCH_VERSION`**
— le backfill à l'ouverture (`PRAGMA user_version`, cf. `docs/persistance.md`) met les documents
existants à niveau tout seul.

## Listings serveur-pilotés

Les listings du cœur (`views/ListView`, tous les onglets adossés à une collection du document) ne lisent
pas `store.all()` : leurs lignes viennent d'un **moteur à source injectée**.

```
   saisie / filtre CIBLE
            │
            ▼
     ListRowEngine.rows(request)          request = { collection, query, target }
       │                     │
       │ requête INACTIVE    │ requête ACTIVE (recherche saisie OU cible)
       ▼                     ▼
   source.local()      source.remote()  ─── null (mode fichier / cible à 2 sauts sans saisie)
   Store.all + index         │                └→ on reste sur local()
   (jamais de réseau)        ▼
                    GET …/<collection>?q=…&<where>   (debounce 200 ms + AbortController)
                             │  échec → repli LOCAL + console.warn, JAMAIS re-programmé
                             ▼
                     Store.list → entités absorbées → repeint

   … sauf si la collection n'est PAS hydratée (chargement PARESSEUX, mode API) :
     ListRowEngine.page(request, {page, pageSize, sort})   ← la SOURCE tranche (isServerPaged)
       └→ GET …/<collection>?page=N&pageSize=…&sort=<champ>&dir=asc|desc
          total = COUNT(*), pager RÉEL ; ORDER BY = le critère de tri du listing
          sur le CORPUS entier (pagination ordonnée complète, lot 1b)
          (cf. docs/hydratation.md § « Vague 1 — contacts »)

     … et ses OPTIONS de filtre d'énumération viennent alors du serveur :
     source.facetOptions(collection, champ)   ← la SOURCE tranche (état d'hydratation)
       └→ GET …/facets/<collection>?field=<champ>   → valeurs DISTINCTES du CORPUS
          (mémoïsées, servies en synchrone — cf. § « Facettes du régime pagé »)
```

### Les règles du moteur

- **La recherche d'un listing utilise le moteur PARTAGÉ**, dans les DEUX modes. Le texte cherché d'une
  ligne est `RecordSearch.textOf(...)` — c'est-à-dire, mot pour mot, le contenu de la colonne `search`
  que le serveur a calculé pour ce même enregistrement. **Assiette ASSUMÉE** : « tout champ propre +
  dérivés », pas un relevé de champs trié à la main. Un équipement se trouve donc par le nom de **sa
  baie**, d'un de ses **sous-équipements**, par « U12 » ou « 42 U » — le comportement de la palette,
  appliqué aux listes.
- **Aucun `ListConfigs.searchFields`**, sauf **une** exception documentée : la **bibliothèque
  d'images de façade**. Sa source est CUSTOM (`ImageStore`, hors collections du document, donc hors
  spec partagée) et ses enregistrements portent la **data URL complète** de l'image — qui n'a rien à
  faire dans un texte cherchable. Ce listing garde donc son relevé explicite (`ListOptions.searchFields`).
- **Bascule serveur sur requête ACTIVE seulement.** Sans recherche ni cible, le document est hydraté :
  re-tirer la liste complète serait du gaspillage pur. Avec une requête active et en mode API, la liste
  vient du serveur (anti-rebond 200 ms — la même constante que la palette —, annulation de la requête
  devancée, **repli local silencieux** en cas d'échec). En mode FICHIER, aucun réseau n'existe :
  `remote()` rend `null` et le moteur reste local (principe n°15).
  ⚠ **« Le document est hydraté » n'est plus universel** : une collection chargée PARESSEUSEMENT
  (mode API — cf. `docs/hydratation.md`) n'a rien en cache, et une requête au repos y ouvrirait un
  listing vide. La source propose alors un TROISIÈME régime, la **pagination serveur réelle**
  (`isServerPaged`/`fetchPage` → `ListRowEngine.page`) : page par `pageSize`, total = `COUNT(*)`.
  Les deux régimes ne se recouvrent jamais — une requête ACTIVE, même sur une collection lazy,
  repasse par `remote()` et son plafond. Les collections hydratées, elles, ne changent en rien.
- **Le listing ne blanchit jamais** : pendant l'anti-rebond et le vol, ce sont les lignes LOCALES,
  filtrées avec la même assiette, qui s'affichent.
- **Anti-boucle** : un échec serveur est mémorisé POUR SA REQUÊTE. Sans ça, le rendu de repli
  reprogrammerait aussitôt la même requête, indéfiniment. Une requête *différente* reste tentée.
- **Une ÉCRITURE périme le jeu serveur en main.** Le jeu de lignes serveur est mémoïsé par SIGNATURE de
  requête (collection + saisie + cible), et une écriture (création, « dupliquer », édition, suppression)
  ne change PAS cette signature. Le moteur l'oublie donc sur `Store.onChange` (`ListRowEngine.forgetRemote`,
  jumeau de `forgetPage` du régime pagé) : le prochain rendu ré-interroge le serveur et affiche entre-temps
  les lignes LOCALES (index fraîchement invalidé), qui contiennent déjà la ligne écrite. Sans cet oubli,
  un enregistrement créé qui matche le filtre actif resterait invisible jusqu'à ce que la saisie change.
  En mode FICHIER, rien à oublier : le chemin `local()` recalcule à chaque rendu.

### Limites v1 (assumées)

- **Le TRI et la PAGINATION restent CLIENT**, sur les lignes reçues : les accesseurs de tri d'un listing
  sont des fonctions arbitraires, souvent dérivées (occupation d'une baie, longueur d'un câble, chemin
  d'un équipement) — il n'y a pas de colonne SQL en face. Le jeu serveur est donc **plafonné**
  (`StoreListRowSource.REMOTE_LIMIT` = **500** lignes, même esprit que le cap par collection de la
  recherche transverse). Au-delà, l'utilisateur affine sa requête.
- La **pagination serveur** n'est exposée dans l'UI que pour les collections chargées
  PARESSEUSEMENT, qui n'ont pas le choix (cf. `docs/hydratation.md` § « Vague 1 »). Depuis la
  **pagination ORDONNÉE complète** (lot 1b), le critère de tri du listing y ordonne le **corpus
  entier** — voir la section suivante ; seul reste au comportement du pilote un critère **sans champ
  serveur** (colonne sans `sortField` : tri de la page reçue, découpe à l'ordre par défaut).

### Tri SERVEUR du régime pagé (pagination ordonnée complète — lot 1b)

La route paginée `GET …/<collection>` accepte `sort` (champ du modèle) et `dir` (`asc`/`desc`,
défaut `asc`). Les règles, portées par le module PARTAGÉ **`src-shared/ListOrder`** (une seule
source, client ET serveur — principe n°3) :

- **Liste blanche DÉRIVÉE de la spec** (`COLLECTION_SPECS`, comme le schéma relationnel lui-même) :
  champs scalaires `string`/`number`/`boolean` + les 4 colonnes d'audit (`created_date`/
  `updated_date` portent les critères « Date de création / de modification » des listings). Exclus :
  `string[]`/`json` (TEXT JSON — un ordre lexicographique n'aurait aucun sens), `search`/
  `updated_rev` (opérationnelles), `id` (clé opaque, déjà le bris d'égalité). Le serveur
  n'interpole JAMAIS un nom de colonne hors de cette liste : la route répond **400 explicite**
  (`colonne de tri invalide`, `direction de tri invalide`) — jamais d'ignorance silencieuse, un tri
  demandé et non appliqué serait un mensonge d'UI — et le dépôt (`RelationalRepository.list` →
  `ListOrder.orderBySql`) REFUSE de son côté (throw) toute valeur non validée (défense en
  profondeur, barrière anti-injection).
- **Bris d'égalité `id ASC` SYSTÉMATIQUE** : sans ordre total déterministe, deux lignes égales au
  critère peuvent permuter entre deux requêtes et la découpe en pages duplique/omet des lignes aux
  frontières.
- **Sémantique rapprochée du tri CLIENT** (`core/Sort.compare` : `localeCompare("fr", numeric,
  sensitivity: "base")`) : vides (NULL/`''`) rejetés à l'extrémité « plus grand » (derniers en asc,
  premiers en desc — comme la vue), `COLLATE NOCASE` sur les colonnes TEXT. **Écart résiduel
  assumé** : NOCASE ne replie ni les accents ni la casse non-ASCII, et il n'y a pas d'ordre
  numérique « naturel » (« item10 » < « item2 ») — une collation ICU serait hors de proportion.
- **Sans `sort`** : l'ordre historique `created_date ASC, id ASC`, verbatim — tous les appelants
  existants (boot, `findAll`, exports) sont inchangés.
- Côté client, le critère actif est mappé en champ serveur par le module pur
  **`core/ListServerSort`** (critères de date intrinsèques + colonnes déclarant leur
  `ListColumn.sortField`, opt-in), validé contre la MÊME liste blanche avant d'être envoyé.

### FACETTES du régime pagé (valeurs distinctes serveur — vague 3 du lazy-load)

Le régime pagé prive aussi les **filtres d'énumération** de leur matière : leurs options se bâtissent
en balayant `store.all(collection)`, qui ne contient alors que les pages parcourues. Une seconde
route les sert, sur le même modèle que le tri (module PARTAGÉ **`src-shared/ListFacets`**, jumeau de
`ListOrder`) :

```
GET /api/documents/:docId/facets/:collection?field=<champ>
  → 200 { field, values: string[], truncated }   ·   400 champ hors liste blanche   ·   404 collection inconnue
```

- **Liste blanche DÉRIVÉE de la spec** : les champs de type `string` UNIQUEMENT (les `number` ont
  autant de valeurs distinctes que de lignes, les `boolean` n'apprennent rien, les `string[]`/`json`
  demanderaient un `json_each`, les colonnes d'audit une valeur par ligne). Sous-ensemble STRICT de la
  liste blanche de tri, invariant testé. Barrière anti-injection identique : 400 côté route, throw
  côté dépôt, jamais d'interpolation d'un nom venu du client ;
- **`SELECT DISTINCT` sensible à la CASSE**, vides exclus, ordre déterminé, plafonné
  (`ListFacets.VALUES_CAP` = 500, `LIMIT cap+1` → `truncated`, cap assumé du même esprit que
  `SEARCH_ALL_LIMIT`). La casse est PRÉSERVÉE parce que le filtre compare par égalité exacte : replier
  deux graphies en une option donnerait un identifiant qui ne matcherait que la moitié des lignes ;
- **LECTURE PURE** : un GET, donc aucune révision consommée ni SSE publié. Montée sous
  `/facets/:collection` (et non `/:collection/facets`) pour ne pas faire dépendre le routage de la
  valeur d'un identifiant ;
- côté client, l'opt-in est **`ListColumn.filter.field`** (le champ scalaire que lit `valueOf`), la
  bascule est décidée par `StoreListRowSource.facetOptions` — état d'hydratation, jamais un nom de
  collection — et les valeurs sont mémoïsées par le module pur `core/CollectionFacetCache`. Détail et
  limites : `docs/hydratation.md` § « Vague 3 » (dont la limite résiduelle « le filtre s'applique à la
  page reçue, les options au corpus »).

### Coût de la recherche locale et mémoïsation

Calculer le texte cherchable d'une ligne n'est pas gratuit (sérialisation de toutes les valeurs propres
+ suivi des liens/enfants de la spec). Mesuré sur un corpus synthétique d'équipements rackés (Node 24) :

| corpus | une passe COMPLÈTE | 10 filtres sur l'index |
|---|---|---|
| 2 000 | ~23 ms | ~8 ms (0,8 ms/frappe) |
| 10 000 | ~106 ms | ~35 ms (3,5 ms/frappe) |

D'où l'**index mémoïsé** (`RecordSearchIndex`) : le prix est payé une fois par session de recherche, la
frappe devient ~30× moins chère. L'**invalidation** est volontairement GROSSIÈRE — le texte d'une ligne
dépend d'AUTRES enregistrements (renommer une baie change celui de tous ses équipements), aucune
invalidation fine n'y serait fiable. Deux déclencheurs : tout rendu qui **n'est pas** une simple frappe
(`ListView.render()` sans `typing`), et `Store.onChange` (filet pour les écritures venues d'ailleurs :
SSE, autre onglet). Un index périmé, c'est une recherche qui ment : dans le doute, on jette.

> ⚠ Ces invalidations supposent que le CACHE lui-même est à jour — or les événements SSE peuvent être
> MANQUÉS sans signal (onglet endormi, veille, coupure). La vérification de révision + rattrapage qui
> couvre ce trou passe par le chemin SSE ordinaire, donc les invalidations ci-dessus (et celles des
> recherches locales par construction, comme la modale de sélection 3D) jouent d'elles-mêmes :
> cf. [`hydratation.md`](hydratation.md) § « Fraîcheur — SSE manqués ».

## Filtre CIBLE unifié (dimension « à RECHERCHE »)

Un listing peut être filtré par une **entité du modèle** plutôt que par une valeur d'énumération : « les
adresses IP de SW-Coeur », « les câbles de SW-Coeur », « les interventions de cette VM ». La liste des
cibles est longue, croissante et à libellés composés → le contrôle est un **`SearchPop`**, jamais un
`<select>` par famille (principe n°14, même règle que `FormControls.entityPicker`).

- **`FilterBarDimension.search`** transforme une dimension en dimension « à recherche ». Elle se
  présente comme un **déclencheur FERMÉ** au même langage que les autres dimensions (`.multi-trigger`
  + `.count-badge`, `aria-haspopup="dialog"`), jamais comme un champ nu posé dans le menu (maquette de
  référence : `design-system/briefs/filtre-cible-porteur-maquette.html`).
  Le **badge** reflète la sélection : `(Tous)` sans cible,
  le **NOM** de l'entité (ellipsé, résolu à chaque rendu — repli sur l'identifiant si elle disparaît) à
  une cible, le **compteur** à 2+ (multi OR, v2). La règle badge/placeholder vit dans le module **pur**
  `core/TargetFilterDisplay` (testé) ; l'i18n et le DOM restent dans `FilterBar`.
- **Le panneau** (`.tf-panel`, 320 px) s'ouvre en **PORTAIL** sur `<body>` (`.dc-pop-portal`), ancré au
  déclencheur par la règle **partagée** `SearchPop.portalPlace` (retournement haut/bas, recadrage
  viewport, quasi-feuille mobile) — dont la géométrie vit dans le module pur `core/FloatPlacement`
  (règle UNIQUE des surfaces flottantes ancrées : SearchPop portail, autocomplétion, menu ⋮, tooltips). Le portail est ce qui résout le conflit de largeurs : le popover de
  résultats (~380 px) ne tient pas dans le menu « + Filtre » (200 px) — le menu ne bouge donc pas d'un
  pixel et le panneau déborde **volontairement et proprement**. Contenu, dans
  l'ordre : section « valeur courante » facultative (badge de famille + nom + ✕ — **le ✕ vide le filtre
  SANS fermer le panneau**), champ de recherche, liste de candidats, pied (aides clavier, mention du
  plafond `EntityCandidates.SEARCH_LIMIT`). États d'habillage : invite au repos, **squelette** pendant le
  vol (seulement sur liste vide — des résultats affichés ne blanchissent jamais), « aucun résultat »
  citant la saisie.
- Le champ et la liste sont un **`SearchPop` en mode HÉBERGÉ** (option `host` — extension
  rétrocompatible) : ils se rendent DANS le panneau, mais l'anti-rebond, le `StaleGate`, le clavier
  ↑↓/↵/Échap et l'ARIA combobox restent dans le composant (principe n°14 — zéro logique dupliquée) ; le
  panneau ne peint que l'habillage d'états via le rappel `onState`. Un candidat **déjà pris** reste
  visible, accentué (« déjà pris »), non cliquable — dès le mono, la cible courante s'annonce.
- Choisir **remplace** (MONO-cible en v1, borne `FilterBar.SEARCH_MAX_TARGETS` = 1 ; la forme — un `Set`
  + des chips + le compteur du badge — supporte déjà le multiple : lever la borne basculera le
  placeholder sur « Ajouter… ») et **ferme panneau + menu** (le geste est terminé). **Échap** ferme le
  panneau seul et **rend le focus au déclencheur** ; un clic extérieur ferme panneau ET menu (le panneau
  est intégré à la mécanique `FilterBar.closeAllMenus`).
- La chip produite est une chip **normale** (`FilterChips`), retirée par son ✕ **et** par « Réinitialiser ».
  Nouveauté du modèle pur : une dimension `search` porte des valeurs **LIBRES** — elle n'a pas d'options,
  donc ni ordre de référence (l'ordre devient celui de la sélection) ni libellé à y lire (il vient de
  l'accesseur `valueLabel` de `build`), et la **purge « option disparue » ne s'y applique pas**. Le
  libellé est résolu **à chaque rendu** : un renommage suit tout seul, une cible supprimée retombe sur
  « (supprimé) » sans effacer le filtre — l'utilisateur voit ce qui vide sa liste.
- **Convention de valeur** : `« <kind>:<id> »`, la MÊME que les liens d'intervention
  (`core/TargetSearch.key`/`parse`) — un seul encodage dans toute l'app.

### Les trois vues branchées, et leur asymétrie

| Listing | Familles cherchées | Chemin du filtre |
|---|---|---|
| **Adresses IP** | équipements **+** VMs (confondues) | `where` **SERVEUR** (`{ equipment_id }` / `{ vm_id }`) ; le « OU » porte sur la famille de la cible choisie, pas sur une requête OR |
| **Câbles** | équipements | **CLIENT** : le rattachement passe par les **ports** (câble → port → équipement), **2 sauts** qu'aucune égalité de colonne n'exprime. En mode API, le serveur ne sert que la recherche et la cible taille **ensuite** les lignes reçues ; sans saisie, rien ne part sur le réseau (le cache suffit) |
| **Interventions** | équipements, VMs, spares, sous-équipements | **SERVEUR** (paramètre `targets` déjà existant, cf. `docs/interventions.md`) — leur listing était DÉJÀ paginé serveur, seule la dimension y a été branchée |

Cette **asymétrie est assumée** : le jour où le serveur saura joindre les ports, seul le `where` des
câbles change — `restrict` reste de toute façon le chemin du mode fichier. Les **certificats** ne sont
pas branchés en v1 (base serveur séparée, client à part).

## Pickers et recherches d'entités

Les recherches d'ENTITÉS derrière les `SearchPop` transverses — l'éditeur de LIENS d'intervention et les
dimensions « à recherche » du **filtre CIBLE** des listings — sont **serveur-pilotées en mode API**, tout
en restant **100 % locales en mode fichier** (principe n°15). Une seule source répond à la
question « quels candidats {kind, id, label} pour cette saisie, dans ces familles ? ».

```
   saisie (SearchPop : anti-rebond 200 ms + StaleGate)
            │
            ▼
   EntityCandidateSource.fetch(query, excluded?)
       │                         │
       │ mode FICHIER            │ mode API (lecteur EntitySearchReader injecté)
       │ (reader null)           ▼
       ▼                 GET …/search?collections=<familles>   (annulation de la requête devancée)
   EntityCandidates.local          │  échec réel → REPLI local + console.warn
   (Store.all + rank)              ▼
                          EntityCandidates.fromRecords
                          (record → instance LOCALE du Store préférée, sinon brut)
            └──────────────┬───────────────┘
                           ▼
                 TargetSearch.rank (CLASSEMENT client : préfixe > inclusion, alpha, plafond, dédup)
```

- **`core/EntityCandidates`** — le cœur PUR (statique, testable headless) : `local` (cache du Store) et
  `fromRecords` (records serveur → candidats), tous deux re-classés par `TargetSearch.rank`. Le serveur
  **FILTRE** (LIKE sur `search`), le client **CLASSE** — donc le classement est le **MÊME dans les deux
  modes** (cohérence par construction). En mode API, le libellé vient de l'**instance LOCALE du Store**
  quand elle existe (patron `GlobalSearchSources.dressRecords`), sinon du record brut (dégradé mais
  fonctionnel — écriture concurrente pas encore synchronisée).
- **`core/EntityCandidateSource`** — l'orchestration DOUBLE MODE réutilisable : une instance par point de
  recherche (elle porte son `AbortController`). L'**anti-rebond** et le **StaleGate** (fraîcheur) sont
  portés par le `SearchPop` appelant ; l'**annulation** de la requête devancée et le **REPLI local** sur
  échec réel vivent ici. Une annulation n'est pas un échec (on laisse filer le rejet, le StaleGate
  tranche) : retomber sur le local serait un rendu concurrent.
- **Pourquoi ne PAS empiler `ListRowEngine`** : son modèle est « lignes locales synchrones + repeinture
  async via rappel » (un listing qui se re-rend). Un `SearchPop` est piloté par un `fetch` qui rend une
  PROMESSE et porte DÉJÀ anti-rebond + StaleGate. Le branchement le plus simple qui ne duplique rien =
  le `fetch` du SearchPop + `EntityCandidateSource` pour l'annulation/repli.
- **Branchements** : `views/ListTargets` (`ipCarrier`/`cableEquipment`, filtres IP & câbles) et
  `interventionTargets` (main.ts, éditeur de liens). Comportement **identique en mode fichier** (mêmes
  candidats, même ordre — verrouillé par golden dans `test-entity-candidates.js`) ; en mode API, les
  candidats viennent du serveur, **au-delà du corpus chargé** (préparation de l'hydratation partielle).
- **Rythme & plafond** (aucun réglage inventé) : anti-rebond `EntityCandidateSource.DEBOUNCE_MS` =
  `ListRowEngine.REMOTE_DEBOUNCE_MS` (200 ms, le tempo de la palette et des listings) ; plafond de
  candidats `EntityCandidates.SEARCH_LIMIT` = 12, valeur unique dont `ListTargets.SEARCH_LIMIT` n'est qu'un alias.

### Ce qui reste CLIENT, et pourquoi (`EntityPicker` / `OptionSearch`)

Les **sélecteurs d'entité des FORMULAIRES** (`ui/EntityPicker` composé par `FormControls.entityPicker`,
filtrage `core/OptionSearch`) **ne bougent PAS**. Leurs options ne sont pas une recherche transverse : ce
sont des **RÈGLES MÉTIER par formulaire** (filtre par famille de port, contrainte de conteneur, options
`disabled` nommant le câble qui occupe un port, breakout, suffixe d'emplacement, tri des occupés en fin,
`keepId`) calculées sur le **corpus HYDRATÉ**. Le principe n°14 est explicite : on remplace le *contrôle*,
jamais la *règle*. Tant que le document reste **entièrement chargé**, ces règles s'appliquent sur un
corpus complet — les brancher sur le serveur n'aurait pas de sens (le serveur ne connaît pas la contrainte
de conteneur d'un formulaire donné).

**Le régime ASYNC** (`FormControls.entityPickerAsync` → `EntityPicker.buildAsync`, source
`core/EntityPickerSource`) — l'exception cadrée : une collection **VOLUMINEUSE ou chargée
PARESSEUSEMENT** dont les options ne portent **AUCUNE règle métier** (chaque enregistrement est
candidat — ni filtre, ni `disabled`, ni `keepId`) n'a pas à être hydratée en entier pour remplir un
champ. Le contrôle consomme alors un **CONTRAT injecté** (`EntityPickerCandidates` : `debounceMs`,
`fetch`, `labelOf`, `resolveLabel`) ; la source standard mono-collection est
`CollectionPickerSource` (construite par `main.ts`, la vue ne connaît que le contrat) :

- **PARCOURS au focus (requête vide)** — la condition du remplacement d'un `<select>`. La recherche
  transverse ne sait **PAS** parcourir (requête vide → `{}` serveur, `TargetSearch.rank("")` → `[]`
  client : un choix de la recherche, pas un manque) ; le parcours passe donc par la **route de
  LISTING** : collection hydratée → cache local (tri alpha sur le libellé **normalisé**
  `Schema.normSearch`, borné, surplus exact) ; sinon `store.list` (page 1, pageSize = plafond,
  tri = colonne injectée `sortColumn`, validée contre `ListOrder.isSortable` — invalide : traitée
  absente + trace), lignes **absorbées** au cache par construction, surplus = `total − rows`. Le
  surplus du parcours est **ANNONCÉ** (rangée « + N masqués », la clé pluralisée du régime sync).
- **RECHERCHE (requête non vide)** — déléguée à `EntityCandidateSource` (une famille) : annulation,
  repli local sur échec réel et double mode n°15 déjà là, aucune logique nouvelle. **Pas d'annonce
  de surplus** : le serveur ne rend pas de compte (cap 40/collection) — parité avec toutes les
  recherches transverses.
- **LIBELLÉ de la valeur courante** — sync d'abord (`store.get` + règle de nommage injectée) ;
  inconnu du cache → pastille « Chargement… » + `resolveLabel` (`fetchOne` absorbé, **garde de
  fraîcheur** : la réponse ne s'applique que si la valeur est encore cet id) ; introuvable →
  `fallbackLabel(id)` injecté (défaut : l'id brut). Au **PICK**, aucune résolution : le libellé est
  dans le résultat cliqué.
- **Plafonds & rythme** — `OptionSearch.DEFAULT_LIMIT` (50) pour parcours ET recherche (parité du
  contrôle sync) ; anti-rebond porté par la **SOURCE** (0 si locale, `EntityCandidateSource.DEBOUNCE_MS`
  sinon), le SearchPop du contrôle le consomme.
- **Limites assumées** — recherche sans annonce de surplus ; parcours sans `sortColumn` → ordre
  serveur `created_date` + re-tri alpha **client de la page reçue** seulement (même famille que les
  « tris sans colonne SQL » du régime pagé).
- **Pilote** — le champ « Contact » des abonnements de notifications (`NotificationsAdminView`) :
  la page n'hydrate plus le carnet (cf. `docs/hydratation.md` § vague 1, `docs/notifications.md`).

⚠ **Re-cadrage à prévoir pour l'option C (hydratation PARTIELLE).** Le jour où le document ne sera plus
entièrement en mémoire, ces règles devront être re-cadrées : la **résolution des contraintes** (quels
ports d'un équipement, quels conteneurs compatibles…) devra se faire **côté serveur ou à la demande**, car
le corpus local ne suffira plus à les évaluer. C'est un **constat**, pas un chantier d'aujourd'hui — la
source `EntityCandidateSource` prépare déjà le versant « recherche transverse » de cette bascule.

### Cherchabilité des statuts VM

`VmStatus` ne porte **aucun** terme de recherche : la cherchabilité de « orpheline »/« orphan » (fr
**et** en) est portée par le catalogue `vmOrphan` du module partagé `src-shared/SearchTerms` (invariant
n°15 testé). `VmStatus` reste la source unique de l'**affichage** des statuts (pastilles).

### Clients wifi

La collection `wifiClients` (cf. `docs/wifi-unifi.md`) fait partie de la spec partagée.
Elle apporte : un dérivé par LIEN (le nom du **point d'accès** rapproché, `ap_equipment_id` →
`equipments.name`) et le catalogue `wifiDisconnected` — **« déconnecté »/« disconnected »**, le pendant
wifi de `vmOrphan` (MÊME mécanique `orphan`, autre vocabulaire : côté wifi, disparaître de l'inventaire
est ordinaire). Tout le reste (nom, MAC, IP, SSID, type, nom d'AP brut) est une **colonne plate** déjà
couverte par `ownText` — d'où l'absence de `own` pour cette collection. Côté palette, elle a sa propre
**portée « wifi: »** : un client wifi n'est ni un sous-réseau ni une adresse, c'est un objet de présence.

### Applications

La collection `applications` (search-v5) fait partie de la spec partagée. Elle apporte deux dérivés
par **lien**, patron exact d'`ipAddresses` : le nom de l'**hôte** — équipement (`equipment_id` →
`equipments.name`) **ou** VM (`vm_id` → `vms.name`) — devient un terme de l'application. Taper le nom
du serveur remonte donc les applications qu'il héberge, et **renommer l'hôte invalide** la colonne
`search` des applications (requêtes inverses par FK indexées, `INDEX_SPEC.applications`). L'URL et la
description sont des colonnes **plates** déjà couvertes par `ownText` — aucun `own`, aucun catalogue.
Côté palette, portée **dédiée « app: »** (décision D6) : les applications sont des entités de premier
plan (ce qui tourne sur l'infrastructure), pas de l'inventaire secondaire.

### Pièces jointes

La collection `attachments` (search-v6) suit le même patron : deux dérivés par **lien** — le nom de
la **cible**, équipement (`equipment_id` → `equipments.name`) **ou** sous-équipement
(`sub_equipment_id` → `subEquipments.name`) — deviennent des termes de la pièce. Taper « SRV37 »
remonte sa convention de prêt, et **renommer la cible invalide** la colonne `search` des pièces
(requêtes inverses par FK indexées, `INDEX_SPEC.attachments`). Libellé, description et nom de fichier
d'origine sont des colonnes **plates** couvertes par `ownText` — aucun `own`, aucun catalogue.
Côté palette, la famille rejoindra la portée **« inv: »** avec sa fiche (décision D9 : une pièce
jointe est de l'intendance, pas du premier plan) — l'entrée au corpus arrive avec l'UI (invariant
corpus ≡ fiches). Cf. [`attachments.md`](attachments.md).

### Interventions et tickets répliqués

Les **interventions** ne sont **pas** une collection du document : elles vivent dans une base SERVEUR
séparée (`interventions.db`), avec leur propre colonne `search` et leur propre listing paginé
(cf. `docs/interventions.md`). Elles sont donc **hors** de la spec partagée `SearchTerms`, et **hors**
de la palette Ctrl+K. L'état de leur **réplication** vers un tracker distant
(cf. `docs/jira-interventions.md`) suit la même règle : les colonnes `tracker_*` ne sont ni dans le
corpus de la palette, ni dans le texte cherché du listing — seule la **référence** du ticket (`jira_ref`)
entre dans la colonne `search` de `interventions.db`.

## Invariants testés

- **corpus ≡ fiches ouvrables** (`GlobalSearchSources.families()` ⇄ `DetailForms.DETAIL_COLLECTIONS`,
  égalité stricte) — un résultat qui ne s'ouvre pas serait un clic sans effet.
- Catalogues et préfixes de composition **verrouillés sur les locales** client (test-search-terms.js) :
  la duplication assumée ne peut pas dériver en silence.
- Parité n°15 : « orphan »/« hard drive » trouvables en locale fr sur le corpus LOCAL
  (test-core-store.js) ; colonne serveur : goldens searchAll + backfill v1→v2.
- **Parité listing fichier ⇄ serveur** (test-list-rows.js) : sur un même mini-corpus, `RecordSearchIndex`
  et `RelationalRepository.list(collection, {query})` rendent les **mêmes ids** sur 15 requêtes golden
  (dérivés par lien, par enfants, compositions, catalogues, 2 sauts, casse, requête sans résultat).
  Le rognage de la requête en fait partie : `normSearch` ne rogne PAS, seul le `trim()` explicite des
  deux côtés évite qu'une saisie blanche diverge.
- **Une seule définition** : tout terme du corpus de la PALETTE est présent dans le texte cherché du
  LISTING (les deux formes de `RecordSearch` couvrent le même contenu).
- **Moteur de lignes** : requête active/inactive, bascule serveur, affichage local pendant le vol,
  repli sur échec **sans reprogrammation**, annulation de la requête devancée, `reset`.
- **Filtre CIBLE** : chips à valeur libre (conservées sans options, repli sur l'identifiant),
  `TargetSearch.parse` (inverse de `key`, id à deux-points préservé), `where` IP ⇄ restriction câbles à
  2 sauts sur un VRAI Store, famille inconnue → **aucune** ligne (jamais « toutes »).

## Pointeurs

- `docs/persistance.md` § « La colonne `search` ENRICHIE » — écriture/invalidation/backfill serveur.
- `docs/interventions.md` § « Filtre par CIBLE » — l'absorption de la chip de navigation par la dimension.
- `.notes/toDos/chargement-dynamique-document-cadrage-2026-08-02.md` — cadrage du chantier (non versionné).
- § « Pickers et recherches d'entités » ci-dessus — la source double mode `EntityCandidates` /
  `EntityCandidateSource`, ce qui reste client (`EntityPicker`/`OptionSearch`) et le re-cadrage prévu
  pour l'hydratation partielle (option C).
