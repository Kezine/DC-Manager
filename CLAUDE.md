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
   paramètres injectés** (cf. `PositioningTool` ↔ `PositioningHost`, ou `PowerAnalysis`
   qui REÇOIT son store), pas par des imports en dur. Vaut PARTOUT : front, back,
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
14. **RÉUTILISER les primitives UI de l'app — JAMAIS réinventer un contrôle.** Cas particulier
    du principe n°3, appliqué à l'interface. Avant d'écrire un `<input>`, un `<button>` ou un
    sélecteur à la main, utiliser le composant maison correspondant (tous dans `ui/`). En
    particulier :
    - **Champs de DATE** → `FormControls.date(...)` (input thématisé avec boutons 📅 / Aujourd'hui /
      effacer, `.value` proxifié). **Jamais** un `<input type="date">` ou `type="datetime-local">`
      brut. Si une granularité heure est requise et manque au composant, l'ÉTENDRE (variante
      date-heure) plutôt que contourner — le contrôle reste unique et cohérent.
    - **Boutons d'ACTION** (ligne de liste, barre d'outils, actions par élément) → **boutons-ICÔNE**
      du registre `Icons` (pattern `iconAction(icon, ariaLabel, tip, onClick, danger?)` : `aria-label`
      + tooltip obligatoires, jamais d'emoji/glyphe en dur). **Pas de bouton texte** pour ces actions.
      Le texte reste réservé aux boutons PRIMAIRES explicites (création « + … » d'en-tête, Enregistrer/
      Annuler d'une modale).
    - **Champs de RECHERCHE** → le champ de recherche NORMALISÉ de l'app (même style/comportement que
      les recherches des listings), jamais un `<input>` ad hoc.
    - **SÉLECTION d'une entité** (lier un équipement / une VM / un spare / un objet du modèle) → le
      pattern **`SearchPop`** (recherche-popover UNIFIÉE sur TOUS les éléments, le **clic** sur un
      résultat sélectionne/lie), comme la vue 3D et la page Certificats — **pas** un `<select>` par
      famille suivi d'une liste. La recherche traverse l'ensemble des éléments, pas une famille à la fois.
      Dans un **FORMULAIRE**, où le champ doit AFFICHER sa valeur, ne pas gréer `SearchPop` à la main :
      utiliser **`FormControls.entityPicker(options, value)`** (`ui/EntityPicker`), qui le compose et y
      ajoute la valeur courante, l'effacement et l'état vide. Il prend **exactement la même liste
      d'options que `select(...)`** — donc la règle métier qui la construit (filtre par famille,
      contrainte de conteneur, options `disabled`, tri, `keepId`…) ne bouge PAS : on remplace le
      contrôle, jamais la règle. Le filtrage par la saisie et les règles de valeur sont, eux, dans le
      module pur `core/OptionSearch` (testé). Variante **`FormControls.entityPickerAsync`** (source
      injectée `core/EntityPickerSource`) pour les collections VOLUMINEUSES ou chargées paresseusement
      dont les options ne portent AUCUNE règle métier : les candidats et le libellé de la valeur
      viennent d'une source serveur-pilotée (parcours au focus par la route de listing, recherche
      transverse, résolution async) au lieu d'une liste en mémoire — dès qu'une règle d'options
      existe, c'est `entityPicker` qui s'applique. ⚠ **Distinguer entité et ÉNUMÉRATION** : un statut, une
      famille, une orientation, un mode de placement restent des `<select>` — `entityPicker` est pour
      les objets du modèle, dont la liste est longue, croissante et à libellés composés.
    Ces primitives portent le thème, l'accessibilité et le comportement clavier ; les réimplémenter
    diverge silencieusement du reste de l'app (dette repérée sur la feature `interventions/`, à résorber).
15. **Toute fonctionnalité est PENSÉE pour le mode LOCAL (fichier).** L'app a deux modes — fichier
    local et API serveur — et le mode fichier n'est PAS un sous-produit : une nouvelle fonction se
    conçoit pour marcher SANS serveur. Si elle n'est PAS pertinente en local, cet écart se JUSTIFIE
    et se DOCUMENTE explicitement (section « Mode local » de son `docs/*.md`) — jamais implicite.
    Corollaire pour les logiques de DONNÉES (recherche, filtres, comptages…) : la NORME du mode API
    est l'exécution ASYNCHRONE côté serveur, mais le module doit TOUJOURS offrir une exécution
    SYNCHRONE sur les données locales (mode fichier) — d'où la forme maison : logique partagée
    (`src-shared/`, lecteur injecté), le serveur ET le Store client la consomment chacun dans son mode.
    Exceptions documentées à ce jour : **PKI/certificats** (crypto navigateur = contexte sécurisé
    localhost/HTTPS + coffres serveur), **contacts/notifications** (le service de notification est
    serveur), **VMs** (synchro côté serveur ; évolution prévue : un provider « Manuel » pour créer une
    VM à la main), **clients wifi** (même exception que les VMs, et pour la même raison : la synchro
    interroge un contrôleur tiers avec un secret chiffré au repos — la collection `wifiClients` reste,
    elle, entièrement lisible/cherchable/enrichissable en mode fichier, cf. `docs/wifi-unifi.md`
    § « Mode local »). ⚠ Écart CONNU à résorber : les **interventions** n'existent qu'en mode API alors
    que rien ne l'impose — chantier à venir (cf. `.notes/toDos/`).

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
  db.ts         #   types partagés du dépôt (driver SQLite, Rec, Tx, ListResult…) + contrat du dépôt (interface RepositoryContract)
  RelationalRepository.ts # dépôt RELATIONNEL de production (schéma dérivé de la spec, cf. docs/persistance.md)
  LegacyMigration.ts      # migration blob → relationnel au premier accès d'un document (backup .bak)
  documents.ts  #   registre multi-documents + révisions
  live.ts       #   bus SSE (notifications de changement)
src-shared/         # CODE PARTAGÉ front ⇄ back (TS PUR : ni DOM, ni Node) — schéma, types, validation
  Schema.ts     #   liste canonique des collections + champs tableau + normSearch + page size
  DocumentChangeset.ts #   type + helpers du changeset (rechargement granulaire)
  DataValidation.ts #   normalisation + validation des enregistrements (spec déclarative par collection)
  SearchTerms.ts #   termes de recherche DÉRIVÉS (spec par collection, lecteurs injectés) + requêtes inverses d'invalidation + catalogues fr/en + compositions tapables (cf. docs/recherche.md)
  Cascade.ts    #   cascade de suppression RÉCURSIVE et MULTI-RACINES (intégrité référentielle en DELETE) — Store (fichier) + serveur (API/transact)
  PowerAnalysis.ts #   moteur d'analyse énergie (graphe source→sink, charges, warnings codes+params) — store injecté par interface
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

- [`placement.md`](docs/placement.md) — **DOCTRINE : placement & repères** (conteneur de placement,
  chaîne bâtiment→étage→salle→baie, axes ORTHOGONAUX repère ⊥ portée, règles à appliquer à tout
  nouveau contenu spatial, convergence par le bas, articulation avec le modèle relationnel).
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
- [`persistance.md`](docs/persistance.md) — **persistance serveur** (modèle RELATIONNEL sur SQLite :
  tables à colonnes DÉRIVÉES de la spec via `RelationalSchema`, `INDEX_SPEC` partagé front⇄back, ce que
  le schéma n'impose PAS — FK/CHECK/DEFAULT restent dans la validation/normalisation partagées ;
  **évolution ADDITIVE du schéma** — un champ ajouté à la spec devient colonne à l'ouverture, défaut
  backfillé, ordre tables→colonnes→index, idempotent sans marqueur ; dépôt `RelationalRepository`
  (contrat des colonnes strictes), migration des documents legacy au boot
  (`LegacyMigration`, backup `.pre-relationnel.bak`), `meta`/`images` hors migration ; **colonne `search`
  ENRICHIE** — termes dérivés/catalogues fr+en du module partagé `SearchTerms`, invalidation par FK
  indexées SANS toucher `updated_rev`, backfill `PRAGMA user_version`).
- [`attachments.md`](docs/attachments.md) — **pièces jointes** (collection `attachments` = MÉTADONNÉES du
  document — recherche/cascade/undo/verrou gratuits ; BINAIRES HORS document : disque serveur
  `DOCS_DIR/attachments/<docId>/<id>` streamé (id opaque = nom de fichier, anti path-traversal par
  construction), IndexedDB + compagnon `.nmfa` en mode fichier (enveloppe COMMUNE `BinaryBundle` avec le
  `.nmfb` d'images) ; suppression de la cible = DELETE en cascade des pièces, mais AUCUN unlink en ligne —
  la purge des binaires est le travail EXCLUSIF de la maintenance (l'undo retrouve un binaire intact) ;
  liste blanche MIME partagée + `Content-Disposition: attachment` toujours ; sauvegarde d'un document
  serveur = `.db` + dossier).
- [`vm-proxmox.md`](docs/vm-proxmox.md) — **inventaire VM Proxmox** (module serveur AMOVIBLE `vm/`,
  pivot `VmRecord`, réconciliation source/locaux, providers PAR document dans `vm-providers.db`
  chiffrée (clé `DCMANAGER_SECRETS_KEY` requise), mapping bridge/tag → réseau, script de suppression,
  procédure d'ajout d'un provider ; **purge de masse des orphelines** — 2 groupes (orphelines d'un
  provider configuré / VMs FIGÉES d'un provider disparu), enrichies exclues par défaut et listées
  nominativement, comptes tirés du PLAN de cascade, garantie « UNE transaction = UNE révision, UN SSE,
  UN undo » (`Store.removeMany`), disponible AUSSI en mode fichier).
- [`wifi-unifi.md`](docs/wifi-unifi.md) — **inventaire des CLIENTS WIFI** (module serveur AMOVIBLE `wifi/`,
  pivot `WifiClientRecord` et contrat d'adaptateur AGNOSTIQUES de la marque — UniFi n'est que la 1re
  implémentation, ajout d'une marque en 4 points ; réconciliation source/locaux, « orphelin » = DÉCONNECTÉ,
  AP dérivé du nom d'équipement, providers PAR document dans `wifi-providers.db` chiffrée (clé
  `DCMANAGER_SECRETS_KEY` partagée avec vm/notify), transport `node:https` + pagination, API UniFi
  VALIDÉE sur console réelle le 2026-08-04 (limite mesurée : le SSID n'est pas exposé par le contrat
  officiel), script de suppression).
- [`jira-interventions.md`](docs/jira-interventions.md) — **RÉPLICATION des incidents & interventions vers un
  tracker distant** (module serveur AMOVIBLE `tracker/` — un PONT, AUCUNE collection ; Atlassian Jira Cloud
  n'est que la 1re implémentation, contrats/service/config/routes/UI AGNOSTIQUES, ajout d'une marque en
  4 points ; 🚨 **PARTAGE DES VÉRITÉS** — DC Manager fait foi sur le CONTENU (poussé, il ÉCRASE le ticket),
  le tracker fait foi sur le TRAITEMENT (statut/assigné, LECTURE SEULE), le `status` DCM n'est JAMAIS poussé ;
  **poussée TOLÉRANTE** `pending→synced/error` en colonnes PERSISTÉES — jamais bloquante pour le PUT, reprise
  par passe périodique + action manuelle, clé créée écrite AVANT tout le reste ; 🚨 étiquettes **`DCM-<FAM>-<NOM>`**
  gérées par VERBES add/remove — les labels des AUTRES sources d'un projet PARTAGÉ ne sont jamais touchés ;
  retour d'état `resolve` par LOTS à plafond ROULANT (`TrackerPassScope`), idempotent, introuvable = sentinelle
  sans jamais rien supprimer ; dépendance INVERSÉE des DEUX côtés avec `interventions/` (colonnes `tracker_*` +
  hook `onWrite`, câblage `index.ts` par typage structurel) ; providers PAR document dans `tracker-providers.db`
  chiffrée (clé `DCMANAGER_SECRETS_KEY` partagée avec vm/wifi/notify), `project_key` REQUIS, modèle de menace
  ÉLARGI (jeton en ÉCRITURE ⇒ compte de service dédié) ; ⚠ 11 hypothèses d'API Jira NON validées sur instance
  réelle + procédure de re-validation ; script de suppression).
- [`notifications.md`](docs/notifications.md) — **service de notifications** (module serveur AMOVIBLE
  `notify/`, alertes persistantes anti-spam `raise`/`resolve`, moteur pur `NotifyEngine`, schéma
  `notify.db` à 5 tables, routage par abonnements, webhooks, coffre `SecretBox` partagé, producteurs
  via `ProblemReporter`, script de suppression, procédures d'ajout).
- [`certs.md`](docs/certs.md) — **PKI interne zéro-connaissance** (module serveur AMOVIBLE `certs/`,
  crypto 100 % navigateur : phrases PBKDF2 + keycheck + clés privées chiffrées AES-GCM, serveur =
  métadonnées + blobs opaques ; **coffres multi-DEK** `pki_vaults` — compartimentation des clés
  racine, cérémonie « Protéger les clés racine » ; **hiérarchie à N niveaux** (CA intermédiaires,
  pathLen, NameConstraints, chaîne à servir) ; schéma `certs.db` à 5 tables + invariant Q5, formats
  X.509/OpenSSH/PKCS#12 validés croisés ssh-keygen/openssl, listing arborescent client, veilleur
  d'échéances `cert-expiry`, limites assumées, procédures et script de suppression).
- [`interventions.md`](docs/interventions.md) — **incidents & interventions** (module serveur AMOVIBLE
  `interventions/`, base `interventions.db` à 2 tables, objets liés aux équipements/VMs/spares SANS FK
  inter-bases — orphelins tolérés ; audit posé SERVEUR via helper partagé `RequestAuthor`, `closed_date`
  auto, listing paginé SQL à tris sémantiques, veilleur `intervention-reminder` paliers 24 h/1 h/heure H,
  page « Interventions » localisée + intégration « fiches » (badge, mini-listing, filtre CIBLE) ; `jira_ref` =
  simple référence MANUELLE via `JIRA_BASE_URL` — limite LEVÉE par le pont OPTIONNEL `tracker/` (colonnes
  `tracker_*` + hook `onWrite`, cf. `jira-interventions.md`) ; limites v1 et script de suppression).
- [`recherche.md`](docs/recherche.md) — **recherche** (palette Ctrl+K, scoring client à paliers, termes
  PARTAGÉS `src-shared/SearchTerms` — exécution DOUBLE n°15 : corpus local en mode fichier, route
  transverse `GET …/search` serveur-pilotée en mode API avec debounce/abort/repli, caps assumés,
  compositions tapables et limites ; **LISTINGS serveur-pilotés** : moteur de lignes à source injectée
  `core/ListRowEngine`/`StoreListRowSource`, recherche sur la MÊME assiette que la colonne serveur
  (`core/RecordSearch` + index mémoïsé), tri/pagination restés CLIENT, plafond du jeu serveur ;
  **filtre CIBLE unifié** — dimension `FilterBar` « à recherche » (SearchPop), chips à valeur libre,
  `where` serveur ⇄ restriction cliente à 2 sauts ; **FACETTES du régime pagé** — route
  `GET …/facets/:collection?field=…`, liste blanche partagée `ListFacets`).
- [`hydratation.md`](docs/hydratation.md) — **hydratation du cache client** (état PAR COLLECTION
  `full`/`partial`/`none` — module pur `core/HydrationState`, injection nulle : mode fichier/visualiseur
  = tout `full` PAR CONSTRUCTION ; gardes de sûreté — 🚨 **G1 anti-snapshot** : `_persistAll` refuse
  BRUYAMMENT (`HydrationError`) un `PUT /snapshot` dérivé d'un cache partiel, import/`newDocument`
  légitimes par construction ; **G2 export = hydrater TOUT avant** (`Store.hydrateAll`, arbitrage acté) ;
  **G3 SSE** : `reloadCollections` ne re-tire que l'hydraté, point d'accroche `onLazyReloadDeferred` ;
  **G8 facettes SERVEUR** — liste blanche partagée `ListFacets` dérivée de la spec (⊂ celle du tri) +
  route de LECTURE PURE `GET …/facets/:collection?field=…` (`SELECT DISTINCT` sensible à la casse,
  vides exclus, plafond), options async mémoïsées `CollectionFacetCache` servies en synchrone ;
  gardes G4-G10, vagues 1-4 livrées (`contacts`, `attachments`+`applications`, `wifiClients`,
  `spares`) ; **M4b** — les mises à jour RÉSIDUELLES d'un `/transact` (`residual.updates`) sont
  refetchées GROUPÉES au cache ; **résolution GROUPÉE des libellés de cibles d'intervention**
  (`core/TargetLabelResolution` — remplace l'hydratation en masse, doctrine « hydraté = ce que le
  3D consomme ») ; instrumentation `HydrationStats`, seuils D3 5 Mo / 1 s).
- [`i18n.md`](docs/i18n.md) — **localisation du client** (i18next enveloppé par la classe `I18n`,
  catalogues `.ts` par domaine `fr`/`en`, détection de locale + préférence persistée, bascule =
  reload assumé, pilote = libellés d'onglets, test de complétude fr⇄en, phase 2 = codes serveur).
- [`user-resolver.md`](docs/user-resolver.md) — **annuaire utilisateurs** (service CORE interface-driven
  `UserResolver` : id canonique `String(id)` SSO sinon login → profil affichable ; impl v1
  `AuthCacheUserResolver` = cache d'auth capturé par puits injecté `ProfileSink` + snapshot SQLite
  `users.db` réhydraté au boot ; `RequestAuthor.identity` ; endpoint batch `GET /users/resolve`,
  email/téléphone caviardés sauf pour l'appelant ; impl SSO future, procédure d'ajout).

## Points d'architecture à connaître

- **`Schema.COLLECTIONS`** (`src-shared/Schema.ts`) est la liste canonique des collections —
  code PARTAGÉ, source de vérité UNIQUE des deux côtés (`src-server/src/constants.ts` n'en est
  qu'un ré-export ; l'y ajouter ne sert à rien). Côté client, `EntityRegistry.COLLECTIONS` doit
  la refléter : un invariant testé compare les deux listes, ORDRE compris. Toute nouvelle
  collection s'ajoute donc à `src-shared/Schema.ts` + `EntityRegistry`, à la spec de validation
  (`src-shared/DataValidation.ts`) et à la carte d'impact (`src-client/sync/RenderImpact.ts`,
  invariant testé).
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
  `MeasureTool`, `RouteTool` et `DoorTool` suivent tous ce modèle — de BONS exemples à imiter. L'ÉTAT vit DANS
  l'outil (`routeTool.state`, `measureTool`), jamais dans un pont d'accès porté par `DcBase`.

## Code partagé front/back (`src-shared/`)

Mutualiser le code commun UI ⇄ serveur dans `src-shared/` plutôt que de le dupliquer
(principe n°3). Y vit déjà : le **schéma des collections** (`Schema.ts`), le type du
**changeset** (`DocumentChangeset.ts`), la **validation/intégrité** des données
(`DataValidation.ts`), la **cascade de suppression** (`Cascade.ts`) et le **moteur
d'analyse énergie** (`PowerAnalysis.ts` — store injecté par interface, warnings en
codes+params, i18n résolue côté client). Ce dernier illustre le PATTERN cible : un
moteur métier pur, découplé du store (interface injectée) et de la présentation
(codes plutôt que chaînes traduites), donc réutilisable par un futur producteur serveur.

**Contraintes techniques** (deux builds différents) :
- `src-shared/` ne contient que du **TS PUR** : aucun accès au DOM (front) ni à Node (back).
- Chaque côté COMPILE la source partagée : le front via son `include` (résolution
  *bundler*) ; le serveur via son `include` (NodeNext). Les imports depuis `src-client/`
  vers `src-shared/` s'écrivent SANS extension, comme partout dans le front.

> ⚠️ **DEUX RÈGLES DISTINCTES gouvernent les imports de `src-shared/`, et elles ne sont pas de
> même nature.** L'une est PERMANENTE (l'isolement du dossier), l'autre n'était qu'un réglage de
> build. Les confondre en une seule phrase — comme le fait le mot « auto-suffisant », BANNI ici —
> revient à justifier la permanente par la contingente : le jour où la contingente tombe, la
> permanente paraît tomber avec elle. Toujours écrire LAQUELLE des deux on invoque.

**(1) ISOLEMENT DU DOSSIER — règle PERMANENTE.** Un fichier de `src-shared/` n'importe **RIEN hors
de `src-shared/`** : ni `src-client/`, ni `src-server/`, ni aucun **paquet npm** ou module natif
Node. Aucune configuration ne la lèvera, parce qu'elle n'est pas un artefact de build mais la
raison d'être du dossier : importer du client ferait embarquer du **DOM** dans le build SERVEUR,
importer du serveur ferait embarquer du **Node** dans le FRONT, et un paquet npm n'est pas garanti
présent des deux côtés. Surtout, l'effet est **TRANSITIF**, donc **invisible à la relecture** : le
module importé peut être pur *aujourd'hui* et cesser de l'être demain — la violation apparaîtrait
sans que personne n'ait touché à `src-shared/`. C'est la **raison de fond** de tout ce qui précède ;
la règle « TS PUR » ci-dessus ne parle, elle, que du **contenu** d'un fichier, et on peut la
respecter à la lettre en violant celle-ci.
- ✅ **Vérifiée MÉCANIQUEMENT** (plus seulement affirmée) par la section
  *« shared : ISOLEMENT du dossier »* de `Tests/modules/test-shared-validation.js` : elle relit les
  **SOURCES** `src-shared/**/*.ts` — pas le compilé, car c'est le spécificateur ÉCRIT qu'on contrôle —
  et échoue en **nommant le fichier, la ligne et le spécificateur** fautifs. Elle couvre toutes les
  formes (`import … from`, `import "x"`, `import type`, `export … from`, `export * as N from`,
  `import()` dynamique, `require`) via le **parseur TypeScript**, donc sans faux positif sur les
  commentaires — ces fichiers documentent leurs propres imports en prose. Un contrôle de
  discrimination, dans la même section, prouve que le détecteur voit bien chacune de ces formes.

**(2) IMPORTS ENTRE FICHIERS PARTAGÉS — AUTORISÉS** (cf. `docs/placement.md` §6.7). Ce qui les
empêchait était un défaut de configuration webpack — un artefact de build, jamais une règle de
conception.
- ✅ **Un import relatif ENTRE fichiers de `src-shared/` est AUTORISÉ** — à une condition
  IMPÉRATIVE : le spécificateur porte l'extension **`.js`**, `import { X } from "./Foo.js"`
  pour un fichier `Foo.ts`. C'est la SEULE forme que les trois chaînes acceptent :
  **NodeNext l'EXIGE** (le serveur émet du JS, le spécificateur doit désigner le fichier
  ÉMIS), la résolution *bundler* l'accepte, et webpack l'accepte grâce à l'alias ci-dessous.
  Un import SANS extension entre fichiers partagés compile côté front puis **casse le build
  serveur** — c'est la faute à ne pas commettre. La même section de test que la règle (1)
  **vérifie aussi cette extension** : une convention non tenue par une machine finit toujours
  par ne plus être tenue.
- ⚠ **Pourquoi l'extension, EXACTEMENT** (mesuré, pas déduit). Un import relatif `./Foo.js`
  entre fichiers partagés est accepté par **`tsc` des DEUX côtés** (TypeScript 5.9 ramène le
  spécificateur `.js` sur le `.ts`, en résolution *bundler* comme en NodeNext). Le seul
  point de rupture est **webpack** : sa résolution AJOUTE les extensions au lieu de les
  substituer (`Can't resolve './Foo.js'` — il essaie `./Foo.js`, `./Foo.js.ts`,
  `./Foo.js.js`). D'où le `resolve.extensionAlias: { ".js": [".ts", ".js"] }` de
  `webpack.config.js`, qui lui apprend à résoudre un spécificateur `.js` sur le `.ts`
  correspondant. **Ne pas retirer cette ligne** : les trois chaînes en dépendent.
- L'**injection** d'un concept partagé dans un autre (paramètre plutôt qu'import) reste un
  patron légitime **quand elle se justifie** — mais c'est un **choix de conception**, jamais une
  contrainte de build : `PowerAnalysis` reçoit son store parce que ça découple, pas parce que
  l'import serait impossible.
- ⚠ **Les deux collaborateurs partagés de `DataValidation.ts` sont IMPORTÉS** — `RackDepthPolicy`
  (politique de profondeur de baie) et `TrayGeometry` (géométrie d'étagère, règles T2d/V6e), tous
  deux en `import { X } from "./X.js"`. **Aucun collaborateur n'est injecté dans la validation** :
  un point de substitution que personne n'utilise oblige chaque nouvel appelant à penser à
  injecter, sous peine de voir la règle échouer fermé. Le patron d'injection reste légitime
  ailleurs quand le découplage se défend sur son propre mérite (cf. `PowerAnalysis`).
- ⚠ **Le mot « auto-suffisant » fait DUPLIQUER.** Un contributeur qui le lit renonce à un import
  légitime et **réécrit la règle sur place** — c'est exactement la dette que les déduplications
  `TrayGeometry` / `RackDepthPolicy` ont eu à résorber. Si un en-tête ou un commentaire l'affirme
  encore, c'est un **bug** (principe n°13) : le corriger.
- Le serveur émet sous `dist/src-server/src/` (cf. `package.json` `start`).
