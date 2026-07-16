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
   `src-shared/` auto-suffisants), pas par des imports en dur. Vaut PARTOUT : front, back,
   géométrie, vues, données — pas seulement la vue Datacenter.
3. **Favoriser la RÉUTILISATION plutôt que la duplication.** Avant de copier une
   règle, une constante ou un type, se demander où il devrait vivre UNE seule fois.
   Cette discipline tire naturellement vers une découpe modulaire et réutilisable :
   ce qui est commun au front ET au back va dans `src-shared/` (cf. « Code partagé ») ;
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
   commits* (`feat(...)`, `fix(...)`, `chore(...)`).
9. **NE JAMAIS pousser sur le remote.** Claude commit en local uniquement ; le
   `git push` (et la gestion des identifiants GitHub) est **toujours** réservé à
   l'utilisateur. Ne pas exécuter `git push` même si l'arbre est prêt — proposer,
   puis laisser l'utilisateur pousser.
10. **TOUT est éditable SANS les vues 2D/3D.** Les vues Datacenter (Plan de salle, Plan
    d'étage, 3D) sont une **aide à l'encodage**, jamais le SEUL moyen d'agir. Tout attribut
    — y compris le placement (rattachement salle/étage/baie), la **position X/Y**, la
    **hauteur Z**, l'**orientation**, les dimensions — DOIT être éditable via les
    **FORMULAIRES** (onglets Équipements / Racks / Salles…). Un device à capacités limitées
    (sans WebGL/3D, petit écran) doit pouvoir gérer **l'ensemble** de l'application par les
    formulaires et les listes. Donc : toute action offerte dans une vue 2D/3D (déplacer,
    pivoter, placer, régler une hauteur…) a un **équivalent dans un formulaire**. Quand on
    ajoute un champ de placement au modèle, on ajoute le champ correspondant au formulaire.
11. **Formulaires en MODALE par défaut.** Toute création/édition (collection, config,
    administration) s'ouvre dans la **modale standard** de l'app (`Modal` via `FormHost`,
    cf. `Forms.*`/`VmProvidersForm`) — jamais un formulaire « pleine page » qui remplace
    une liste. Si une page complète semble PLUS pertinente pour un formulaire donné
    (workflow multi-étapes, éditeur très volumineux…), **poser la question à
    l'utilisateur** avant de dévier — c'est lui qui tranche.
12. **PROPOSER des librairies éprouvées plutôt que réinventer.** Quand un besoin est un
    problème « commodité » déjà résolu par l'écosystème (rendu markdown, parsing, dates,
    crypto, diff…), NE PAS le coder from scratch d'office : PRÉSENTER à l'utilisateur 2–3
    librairies candidates (taille, maintenance, sécurité, licence) avec une recommandation
    argumentée, et le LAISSER CHOISIR — aucun choix spontané, ni d'implémentation maison
    spontanée. L'implémentation maison reste légitime quand l'utilisateur la choisit, quand
    le besoin est trivial (< ~30 lignes) ou spécifique au domaine de l'application.
13. **DOCUMENTATION toujours À JOUR avec le code.** Toute contribution qui ajoute ou modifie
    un COMPORTEMENT OBSERVABLE (variable d'environnement, option de configuration, route, format
    d'échange, invariant, commande) met à jour la documentation correspondante (`docs/`,
    `CLAUDE.md`, aide en ligne) **dans le même commit**. En particulier, la doc de référence
    doit lister **TOUTES** les variables d'environnement reconnues par le serveur. Une doc en
    retard sur le code est un **bug** : dès qu'un écart est constaté, le corriger — ou, si ce
    n'est pas le moment, le SIGNALER explicitement (note/issue) plutôt que le laisser filer.

## Structure du projet

```
src-client/            # FRONT (navigateur) — TS compilé par webpack
  models/       #   entités du domaine + EntityRegistry (COLLECTIONS)
  store/        #   Store : état en mémoire, index, transactions, undo
  data/         #   adaptateurs de persistance (BrowserStorage, RestAdapter, images)
  geometry/     #   calculs 3D/2D purs (layout, projection, géométrie de baies)
  views/        #   vues UI ; views/dc/ = vue Datacenter (chaîne d'héritage en couches)
  views/dc/three/ #   moteur 3D WebGL (Three.js)
  sync/         #   rechargement granulaire REST (changeset → plan, carte d'impact 3D)
  ui/           #   primitives UI (modale, dialogue, notifications…)
  app/          #   main.ts (bootstrap), Shell, état de sauvegarde
src-server/src/ # BACK (Node, ESM/NodeNext) — TS compilé par tsc
  api.ts        #   couche HTTP (Express) : routes + verrou optimiste + SSE
  db.ts         #   Repository SQLite (better-sqlite3)
  documents.ts  #   registre multi-documents + révisions
  live.ts       #   bus SSE (notifications de changement)
src-shared/         # CODE PARTAGÉ front ⇄ back (TS PUR : ni DOM, ni Node) — schéma, types, validation
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

> **`docs/` = documentation PÉRENNE d'architecture UNIQUEMENT.** Les documents de SUIVI (checklists de
> refactor, plans d'avancement, notes de session, TODO temporaires, rapports d'audit en cours) NE vont
> PAS dans `docs/` ni dans le dépôt : les écrire dans un dossier NON VERSIONNÉ — `.notes/` (ajouté au
> `.gitignore`) ou le répertoire scratchpad de la session. Un fichier de `docs/` doit décrire un pan
> d'architecture stable, référencé depuis le code ; s'il ne survit pas à la tâche en cours, il n'y a pas sa place.

- [`validation.md`](docs/validation.md) — **normalisation & validation** partagées des
  données (spec déclarative, niveaux intrinsèque/référentiel/invariants, V1/V2/V3).
- [`deduction-reseau.md`](docs/deduction-reseau.md) — **réseau déduit** (source unique = port
  terminal, graphe jumper/brin, principal déterministe, cache par composante) + lien faisceaux/patch.
- [`faisceaux.md`](docs/faisceaux.md) — **faisceaux/trunks** : contraintes d'extrémité (2 patchs
  distincts, T10/T11), uplink virtuel (centre de face arrière), rendu du tracé 2D/3D (`TrunkRouting`,
  parité câbles : intra/stub/inter-salles, sélection partagée).
- [`power.md`](docs/power.md) — **analyse énergie** (direction source/sink, tableau-racine,
  remontée/phase/tension déduites, charge par départ/phase, warnings SPOF/redondance).
- [`reverse-proxy.md`](docs/reverse-proxy.md) — servir l'app **sous un sous-dossier**
  (URLs relatives + `<base>` + `X-Forwarded-Prefix`), sans reconfiguration.
- [`perf-3d.md`](docs/perf-3d.md) — **optimisations du moteur 3D WebGL** (visibilité vs
  rebuild, diff d'options, instancing…) : le fait sert de contexte, les idées « à faire »
  y sont consignées (à ne PAS coder sans demande).
- [`redressement-perspective.md`](docs/redressement-perspective.md) — **correction de
  perspective & assemblage des images de façade** (géométrie pure `Homography`/`ImageStitch`
  + modales `PerspectiveEditor`/`StitchEditor`, branchements dans le flux d'import, téléchargement).
- [`persistance.md`](docs/persistance.md) — **persistance serveur** (modèle *document* JSON sur SQLite,
  intégrité déportée dans la validation, coût des `find` par champ = full scan, `findBy` lean, direction
  RELATIONNELLE si on retouche la DB — pas JSONB).
- [`vm-proxmox.md`](docs/vm-proxmox.md) — **inventaire VM Proxmox** (module serveur AMOVIBLE `vm/`,
  pivot `VmRecord`, réconciliation source/locaux, providers PAR document `vm-providers.json`,
  mapping bridge/tag → réseau, script de suppression, procédure d'ajout d'un provider).
- [`notifications.md`](docs/notifications.md) — **service de notifications** (module serveur AMOVIBLE
  `notify/`, alertes persistantes anti-spam `raise`/`resolve`, moteur pur `NotifyEngine`, schéma
  `notify.db` à 5 tables, routage par abonnements, webhooks, coffre `SecretBox` partagé, producteurs
  via `ProblemReporter`, script de suppression, procédures d'ajout).
- [`certs.md`](docs/certs.md) — **PKI interne zéro-connaissance** (module serveur AMOVIBLE `certs/`,
  crypto 100 % navigateur : clé maître PBKDF2 + keycheck + clés privées chiffrées AES-GCM, serveur =
  métadonnées + blobs opaques ; schéma `certs.db` à 3 tables + invariant Q5, formats X.509/OpenSSH/
  PKCS#12 validés croisés ssh-keygen/openssl, veilleur d'échéances `cert-expiry`, limites assumées,
  procédures et script de suppression).
- [`interventions.md`](docs/interventions.md) — **incidents & interventions** (module serveur AMOVIBLE
  `interventions/`, base `interventions.db` à 2 tables, objets liés aux équipements/VMs/spares SANS FK
  inter-bases — orphelins tolérés ; audit posé SERVEUR via helper partagé `RequestAuthor`, `closed_date`
  auto, listing paginé SQL à tris sémantiques, veilleur `intervention-reminder` paliers 24 h/1 h/heure H,
  Jira = simple référence via `JIRA_BASE_URL`, limites v1 et script de suppression). Lot CLIENT à venir.
- [`i18n.md`](docs/i18n.md) — **localisation du client** (i18next enveloppé par la classe `I18n`,
  catalogues `.ts` par domaine `fr`/`en`, détection de locale + préférence persistée, bascule =
  reload assumé, pilote = libellés d'onglets, test de complétude fr⇄en, phase 2 = codes serveur).

## Points d'architecture à connaître

- **`EntityRegistry.COLLECTIONS`** est la liste canonique des collections. Toute
  nouvelle collection doit être ajoutée à la carte d'impact (`src-client/sync/RenderImpact.ts`,
  invariant testé) et au schéma serveur (`src-server/src/constants.ts`).
- **Localisation (i18n)** : le client se traduit via la classe `I18n` (i18next enveloppé,
  `src-client/i18n/`, catalogues `fr`/`en`). **Toute nouvelle chaîne UI passe par `I18n.t(...)`**
  (clé ajoutée DES DEUX CÔTÉS `fr.ts`/`en.ts` — test de complétude `test-i18n.js`). Pilote actuel :
  libellés d'onglets ; le reste migre par lots. `I18n.init()` DOIT précéder toute construction d'UI.
  Détails et procédure d'ajout : `docs/i18n.md`.
- **Rendu 3D** : la scène est reconstruite via `build()` (complet) ou des chemins
  incrémentaux (`applyOptionsDiff`, `applyRoomDelta`). L'invalidation passe par
  `DcBase.invalidate3D()` + `markStale()`. Ne JAMAIS sous-invalider (laisserait un
  mesh périmé à l'écran) — préférer une reconstruction inutile à un affichage faux.
- **Mode REST** : `RestAdapter.docRev` suit la révision serveur (`X-Doc-Rev`). Les
  écritures envoient `X-Base-Rev` (verrou optimiste → 409). Les autres clients sont
  notifiés par SSE avec un **changeset** ; le `ReloadPlanner` en déduit quoi recharger.
- **Nouvel OUTIL de vue 2D/3D (mesure, routage, positionnement, futurs…)** = cas d'application du principe n°2.
  `DcInteract`/`DcBase` sont déjà des monolithes ; n'y empile PAS la logique d'un nouvel outil. Crée une classe
  outil dans `src-client/views/dc/` (état + overlay + panneau + interactions) pilotée par une **interface hôte**
  (cf. `PositioningTool` + `PositioningHost`), instanciée dans `DcBase` ; ne laisse dans la chaîne de vues que de
  **fins branchements** (un point de rendu, le routage des événements, l'ajout de la carte) + l'**adaptation**
  spécifique (l'équivalent de `posScene()`). La géométrie PURE va dans `src-client/geometry/`. Les outils `PositioningTool`,
  `MeasureTool`, `RouteTool` et `DoorTool` suivent tous ce modèle — de BONS exemples à imiter. Dette résiduelle :
  les PONTS d'accès transitoires dans `DcBase` (`measure`/`routeBuild`/`_measHi`, aperçu souris throttlé) que les
  sites historiques utilisent encore — à résorber au fil de l'eau, pas à étendre.

## Code partagé front/back (`src-shared/`)

Mutualiser le code commun UI ⇄ serveur dans `src-shared/` plutôt que de le dupliquer
(principe n°3). Y vit déjà : le **schéma des collections** (`Schema.ts`) et le type du
**changeset** (`DocumentChangeset.ts`). Cible suivante : la **validation/intégrité des
données** soumises (aujourd'hui éparpillée dans les formulaires — à extraire en
fonction pure réutilisée en UI *et* au serveur).

**Contraintes techniques** (deux builds différents) :
- `src-shared/` ne contient que du **TS PUR** : aucun accès au DOM (front) ni à Node (back).
- Chaque côté COMPILE la source partagée : le front via son `include` (résolution
  *bundler*, imports SANS extension) ; le serveur via son `include` (NodeNext, imports
  AVEC extension `.js`). Pour rester compatible des deux, **les fichiers de `src-shared/`
  sont auto-suffisants** (pas d'import relatif entre eux) — on évite ainsi le conflit
  d'extensions de module. Une dépendance entre concepts partagés se passe par
  **injection** (paramètre) plutôt que par import.
- Le serveur émet désormais sous `dist/src-server/src/` (cf. `package.json` `start`).
