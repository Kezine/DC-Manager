# DC Manager — guide de contribution (Claude)

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
   **Pas de fonctions exportées qui « traînent »** : regrouper les fonctions
   utilitaires apparentées dans une **classe sémantique à méthodes statiques**
   (`DataValidator.validateRecord(...)`, `Ipv4.parseCidr(...)`), pas un
   `validateRecord(...)` libre. Le nom de classe porte le contexte et améliore la
   lisibilité à l'appel. Les **données** (constantes, tables, types/interfaces)
   restent, elles, de simples exports.
   **RÈGLE (application-wide) : tout code MODULAIRE et RÉUTILISABLE vit dans sa PROPRE
   classe, dans son PROPRE fichier.** Dès qu'un comportement a une responsabilité
   identifiable et est (ou pourra être) réutilisé/testé séparément, il sort dans un
   module dédié — on ne l'empile PAS dans un fichier/une classe déjà gros (« monolithe »).
   Le couplage à un contexte (vue, store, serveur…) passe par une **interface/des
   paramètres injectés** (cf. `PositioningTool` ↔ `PositioningHost`, ou les modules
   `shared/` auto-suffisants), pas par des imports en dur. Vaut PARTOUT : front, back,
   géométrie, vues, données — pas seulement la vue Datacenter.
3. **Favoriser la RÉUTILISATION plutôt que la duplication.** Avant de copier une
   règle, une constante ou un type, se demander où il devrait vivre UNE seule fois.
   Cette discipline tire naturellement vers une découpe modulaire et réutilisable :
   ce qui est commun au front ET au back va dans `shared/` (cf. « Code partagé ») ;
   ce qui est commun à plusieurs vues va dans un module dédié. Une duplication
   acceptée doit être justifiée (et signalée par un commentaire des deux côtés).
4. **Noms de variables PLEINS DE SENS.** Pas d'abréviations, sauf quand le sens coule
   de source (`id`, `url`, `db`) ou que la portée est très locale (index de boucle).
   Préférer `collectionsToRefetch` à `cols`, `threeRebuild` à `t3`.
5. **Commentaires DÉTAILLÉS.** Expliquer le *pourquoi* (intention, piège évité,
   invariant), pas seulement le *quoi*. Les zones subtiles (concurrence, rendu,
   invalidation de cache) méritent un paragraphe.
6. **Documentation profuse dans `docs/`.** Tout pan d'architecture non trivial est
   décrit dans un `.md` de `docs/` (voir l'index plus bas), et référencé depuis le
   code concerné.
7. **Tests unitaires sur les fonctions isolées.** Tout module pur a des tests dans
   `Tests/modules/run.js`. Le découpage OO doit *faciliter* ces tests — si une logique
   est dure à tester, c'est souvent qu'elle doit être extraite dans un module pur.
8. **Commits sur les grosses fonctionnalités.** Un commit cohérent par fonctionnalité
   (front + back + doc + tests ensemble), message en français, style *conventional
   commits* (`feat(...)`, `fix(...)`, `chore(...)`). Terminer par la ligne
   `Co-Authored-By` Claude.
9. **NE JAMAIS pousser sur le remote.** Claude commit en local uniquement ; le
   `git push` (et la gestion des identifiants GitHub) est **toujours** réservé à
   l'utilisateur. Ne pas exécuter `git push` même si l'arbre est prêt — proposer,
   puis laisser l'utilisateur pousser.

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
src-server/src/ # BACK (Node, ESM/NodeNext) — TS compilé par tsc
  api.ts        #   couche HTTP (Express) : routes + verrou optimiste + SSE
  db.ts         #   Repository SQLite (better-sqlite3)
  documents.ts  #   registre multi-documents + révisions
  live.ts       #   bus SSE (notifications de changement)
shared/         # CODE PARTAGÉ front ⇄ back (TS PUR : ni DOM, ni Node) — schéma, types, validation
  Schema.ts     #   liste canonique des collections + champs tableau + normSearch + page size
  DocumentChangeset.ts #   type + helpers du changeset (rechargement granulaire)
  DataValidation.ts #   normalisation + validation des enregistrements (spec déclarative par collection)
  Cascade.ts    #   cascade de suppression (intégrité référentielle en DELETE) — Store (fichier) + serveur (API)
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
- [`validation.md`](docs/validation.md) — **normalisation & validation** partagées des
  données (spec déclarative, niveaux intrinsèque/référentiel/invariants, V1/V2/V3).
- [`reverse-proxy.md`](docs/reverse-proxy.md) — servir l'app **sous un sous-dossier**
  (URLs relatives + `<base>` + `X-Forwarded-Prefix`), sans reconfiguration.
- [`positioning-toolkit.md`](docs/positioning-toolkit.md) — **aide au positionnement** :
  placer un élément par ses coins (murs / coins d'autres éléments, cotes ⟂) dans les **deux
  vues 2D** (baies & équipements en salle ; salles & équipements sur l'étage) ; cœur pur
  `geometry/Positioning.ts` + contrôleur dédié `views/dc/PositioningTool.ts` (interface `PositioningHost`,
  adaptation par `DcInteract.posScene()`).

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
- **Nouvel OUTIL de vue 2D/3D (mesure, routage, positionnement, futurs…)** = cas d'application du principe n°2.
  `DcInteract`/`DcBase` sont déjà des monolithes ; n'y empile PAS la logique d'un nouvel outil. Crée une classe
  outil dans `src/views/dc/` (état + overlay + panneau + interactions) pilotée par une **interface hôte**
  (cf. `PositioningTool` + `PositioningHost`), instanciée dans `DcBase` ; ne laisse dans la chaîne de vues que de
  **fins branchements** (un point de rendu, le routage des événements, l'ajout de la carte) + l'**adaptation**
  spécifique (l'équivalent de `posScene()`). La géométrie PURE va dans `src/geometry/`. Les outils `measure`/`route`,
  encore inline dans `DcInteract`, sont de la DETTE — ne pas les prendre pour modèle.

## Code partagé front/back (`shared/`)

Mutualiser le code commun UI ⇄ serveur dans `shared/` plutôt que de le dupliquer
(principe n°3). Y vit déjà : le **schéma des collections** (`Schema.ts`) et le type du
**changeset** (`DocumentChangeset.ts`). Cible suivante : la **validation/intégrité des
données** soumises (aujourd'hui éparpillée dans les formulaires — à extraire en
fonction pure réutilisée en UI *et* au serveur).

**Contraintes techniques** (deux builds différents) :
- `shared/` ne contient que du **TS PUR** : aucun accès au DOM (front) ni à Node (back).
- Chaque côté COMPILE la source partagée : le front via son `include` (résolution
  *bundler*, imports SANS extension) ; le serveur via son `include` (NodeNext, imports
  AVEC extension `.js`). Pour rester compatible des deux, **les fichiers de `shared/`
  sont auto-suffisants** (pas d'import relatif entre eux) — on évite ainsi le conflit
  d'extensions de module. Une dépendance entre concepts partagés se passe par
  **injection** (paramètre) plutôt que par import.
- Le serveur émet désormais sous `dist/src-server/src/` (cf. `package.json` `start`).
