# NetMap — guide de contribution (Claude)

Outil de cartographie réseau / datacenter : inventaire d'équipements, baies, câblage,
adressage IP, et **visualisation 3D** des salles (Three.js / WebGL). Deux modes de
données : **fichier** (local, File System Access API + IndexedDB) et **API** (serveur
REST multi-documents, multi-clients).

## Langue

Le code, les commentaires et la documentation sont en **français** (domaine métier
francophone). Garder cette langue pour toute contribution — commentaires inclus.

## Principes (à respecter pour TOUTE contribution)

1. **TypeScript, front ET back.** Même langage des deux côtés (cf. structure) pour
   pouvoir, à terme, partager du code (voir « Code partagé » plus bas).
2. **Orienté objet, modulaire, testable.** Découper en classes/modules à
   responsabilité unique. Une fonction *pure* (sans DOM, sans réseau, sans état
   global) est préférable dès que possible : elle est testable en isolation.
3. **Noms de variables PLEINS DE SENS.** Pas d'abréviations, sauf quand le sens coule
   de source (`id`, `url`, `db`) ou que la portée est très locale (index de boucle).
   Préférer `collectionsToRefetch` à `cols`, `threeRebuild` à `t3`.
4. **Commentaires DÉTAILLÉS.** Expliquer le *pourquoi* (intention, piège évité,
   invariant), pas seulement le *quoi*. Les zones subtiles (concurrence, rendu,
   invalidation de cache) méritent un paragraphe.
5. **Documentation profuse dans `docs/`.** Tout pan d'architecture non trivial est
   décrit dans un `.md` de `docs/` (voir l'index plus bas), et référencé depuis le
   code concerné.
6. **Tests unitaires sur les fonctions isolées.** Tout module pur a des tests dans
   `Tests/modules/run.js`. Le découpage OO doit *faciliter* ces tests — si une logique
   est dure à tester, c'est souvent qu'elle doit être extraite dans un module pur.
7. **Commits sur les grosses fonctionnalités.** Un commit cohérent par fonctionnalité
   (front + back + doc + tests ensemble), message en français, style *conventional
   commits* (`feat(...)`, `fix(...)`, `chore(...)`). Terminer par la ligne
   `Co-Authored-By` Claude.

## Structure du projet

```
src/            # FRONT (navigateur) — TS compilé par webpack
  models/       #   entités du domaine + EntityRegistry (COLLECTIONS)
  store/        #   Store : état en mémoire, index, transactions, undo
  data/         #   adaptateurs de persistance (BrowserStorage, RestAdapter, images)
  geometry/     #   calculs 3D/2D purs (layout, projection, géométrie de baies)
  views/        #   vues UI ; views/dc/ = vue Datacenter (chaîne d'héritage en couches)
  views/dc/three/ #   moteur 3D WebGL (Three.js)
  sync/         #   rechargement granulaire REST (changeset → plan)  ← cf. docs/render-impact.md
  ui/           #   primitives UI (modale, dialogue, notifications…)
  app/          #   main.ts (bootstrap), Shell, état de sauvegarde
src-server/src/ # BACK (Node) — TS compilé par tsc
  api.ts        #   couche HTTP (Express) : routes + verrou optimiste + SSE
  db.ts         #   Repository SQLite (better-sqlite3)
  documents.ts  #   registre multi-documents + révisions
  live.ts       #   bus SSE (notifications de changement)
docs/           # documentation d'architecture (voir index)
Tests/modules/  # tests unitaires (Node, sans navigateur) sur les modules compilés
```

## Commandes

| But | Commande | Où |
|---|---|---|
| Vérifier les types (front) | `npx tsc --noEmit` | racine |
| Tests unitaires (front) | `npm run test` (compile `dist-test/` puis exécute) | racine |
| Build front | `npm run build` (webpack) / `npm run dev` (serve) | racine |
| Vérifier les types (back) | `npx tsc --noEmit` | `src-server/` |

> ⚠️ `src-server/node_modules` peut être absent : `tsc` signale alors `multer` /
> `better-sqlite3` introuvables — **bruit attendu**, à ignorer (filtrer ces lignes).
> Aucune infra de test serveur pour l'instant : extraire la logique pure (`db.ts`)
> reste testable via le shim SQLite injectable.

## Documentation d'architecture (`docs/`)

- [`rest-migration.md`](docs/rest-migration.md) — migration vers le backend REST,
  phases, concurrence (révisions, SSE, **verrou optimiste 409 par entité**).
- [`render-impact.md`](docs/render-impact.md) — **carte d'impact de rendu** : quelle
  collection impose quelle reconstruction 3D (rechargement granulaire, P1/P3).

## Points d'architecture à connaître

- **`EntityRegistry.COLLECTIONS`** est la liste canonique des collections. Toute
  nouvelle collection doit être ajoutée à la carte d'impact (`src/sync/RenderImpact.ts`,
  invariant testé) et au schéma serveur (`src-server/src/constants.ts`).
- **Rendu 3D** : la scène est reconstruite via `build()` (complet) ou des chemins
  incrémentaux (`applyOptionsDiff`, `applyRoomDelta`). L'invalidation passe par
  `DcBase.invalidate3D()` + `markStale()`. Ne JAMAIS sous-invalider (laisserait un
  mesh périmé à l'écran) — préférer une reconstruction inutile à un affichage faux.
- **Mode REST** : `RestAdapter.docRev` suit la révision serveur (`X-Doc-Rev`). Les
  écritures envoient `X-Base-Rev` (verrou optimiste → 409). Les autres clients sont
  notifiés par SSE avec un **changeset** ; le `ReloadPlanner` en déduit quoi recharger.

## Code partagé front/back (intention)

Le projet vise un **dépôt unique** pour mutualiser le code entre UI et serveur et
éviter la duplication (p. ex. **validation/intégrité des données** soumises, type du
**changeset**). Aujourd'hui ces éléments sont encore DUPLIQUÉS (ex. `DocumentChangeset`
défini dans `src/sync/Changeset.ts` ET `src-server/src/api.ts`). Cible : un dossier de
code partagé (`shared/`) compilé par les deux côtés. En attendant, **garder les copies
synchronisées** et signaler toute divergence.
