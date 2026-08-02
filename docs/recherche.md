# Recherche globale — palette Ctrl+K, termes partagés, exécution double

Architecture de la **recherche globale** de DC Manager : la palette (Ctrl+K / loupe topbar), le module
partagé des termes, la route serveur transverse et la répartition local ⇄ serveur des deux modes de
données. Chantier « recherche partagée / chargement dynamique » (lots 1-2, 2026-08-02).

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
construction**, pas par discipline.

## Les composants

| Composant | Rôle |
|---|---|
| `src-shared/SearchTerms.ts` | SOURCE UNIQUE de « quel texte trouve un enregistrement » : dérivés par lien/enfants, catalogues fr+en, compositions tapables, requêtes inverses d'invalidation, `SEARCH_VERSION`. |
| `src-client/core/GlobalSearch.ts` | Scoring PUR : paliers 100 (libellé exact) / 80 (préfixe) / 60 (contient) / 30 (sub/path/termes), groupes par famille jamais entrelacés, comptes, préfixes de portée, surlignage. |
| `src-client/views/GlobalSearchSources.ts` | Corpus et portées : habillage par famille (label/sub/path/pill/locate), termes via le module partagé, `build` (corpus local), `dressRecords` (records serveur), invariant corpus ≡ fiches. |
| `src-client/views/GlobalSearchPalette.ts` | La modale : portées/préfixes, clavier, récents, actions, familles externes, et l'orchestration serveur-pilotée du mode API (debounce, abort, repli). |
| `src-server/src/RelationalRepository.searchAll` | Recherche transverse : un LIKE sur la colonne `search` par collection, plafond par collection, troncature signalée. |
| `GET /api/documents/:docId/search` | La route (api.ts) — même garde que toute lecture du document (session SSO + SUPER_ADMIN). |

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
  `COUNT(*)` ; les collections tronquées sont signalées dans `truncated`). Même esprit que la page de
  500 des interventions : au-delà, l'utilisateur affine sa requête. La palette v1 n'affiche pas la
  troncature.
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

## Invariants testés

- **corpus ≡ fiches ouvrables** (`GlobalSearchSources.families()` ⇄ `DetailForms.DETAIL_COLLECTIONS`,
  égalité stricte) — un résultat qui ne s'ouvre pas serait un clic sans effet.
- Catalogues et préfixes de composition **verrouillés sur les locales** client (test-search-terms.js) :
  la duplication assumée ne peut pas dériver en silence.
- Parité n°15 : « orphan »/« hard drive » trouvables en locale fr sur le corpus LOCAL
  (test-core-store.js) ; colonne serveur : goldens searchAll + backfill v1→v2.

## Pointeurs

- `docs/persistance.md` § « La colonne `search` ENRICHIE » — écriture/invalidation/backfill serveur.
- `.notes/toDos/chargement-dynamique-document-cadrage-2026-08-02.md` — cadrage du chantier (non versionné).
- Lots suivants : listings serveur-pilotés (lot 3) et pickers (lot 4) réutiliseront `searchAll`/`list`
  et le patron habillage-client de `dressRecords`.
