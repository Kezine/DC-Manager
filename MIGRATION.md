# NetMap — migration du HTML monolithique vers TypeScript (orienté objet)

But : sortir **doucement** de l'app mono-fichier
(`netmap-vNNN-*.html`, ~19 000 lignes dont un seul `<script>` de ~15 000) vers
une application **TypeScript orientée objet**, compilée par **webpack**, sans
jamais casser la base existante.

## Principes

1. **Orienté objet, pas de fonctions « nues ».** Les helpers libres du HTML
   (`uid`, `normRackOrientation`, `isCableStatus`, …) deviennent des **méthodes
   statiques** de classes cohérentes (`Id`, `Normalize`, `GroupTypes`, …). Les
   constantes pures (données) restent des `export const` dans `domain/constants.ts`.
2. **Une classe = un fichier.**
3. **Strangler pattern.** On extrait couche par couche, de la plus pure (modèle)
   vers la plus couplée au DOM (vues). À chaque étape, `npm run typecheck` +
   `npm run build` doivent rester verts.
4. **Filet de régression conservé.** `Tests/run.js` (213 tests) continue de
   tourner contre le dernier `.html` livré tant que la logique n'est pas portée ;
   il sera ensuite reciblé sur les modules compilés.
5. **Sortie mono-fichier préservée.** `npm run build` réinjecte le bundle dans le
   HTML (`html-inline-script-webpack-plugin`) → un seul `dist/netmap.html`
   autonome, ce qui garde fonctionnel l'export « viewer standalone » (qui lit
   `document.documentElement.outerHTML`).

## Outillage

| Commande            | Effet                                                        |
|---------------------|-------------------------------------------------------------|
| `npm install`       | installe webpack + TypeScript + loaders                     |
| `npm run typecheck` | `tsc --noEmit` (porte de type)                              |
| `npm run test:modules` | compile en CJS (`tsconfig.node.json`) + tests modules    |
| `npm run build`     | bundle de production → `dist/netmap.html` (un seul fichier) |
| `npm run dev`       | webpack-dev-server (HMR) — **requiert Node ≥ 20**           |
| `npm run watch`     | rebuild incrémental (Node 19 OK)                            |
| `npm run test:legacy` | harnais de régression sur le dernier HTML livré           |

> Node installé ici : v19.9.0. La compilation marche ; `webpack serve` (dev) veut
> Node ≥ 20 (`npm run watch` reste utilisable en attendant).

## Arborescence cible

```
src/
  core/        Id, Normalize, … (services transverses)
  domain/      constants.ts (données) + registres (GroupTypes, CableStatuses, …)
  models/      Entity + 18 entités + EntityRegistry           ← FAIT
  data/        FieldIndex, DataAdapter, BrowserStorageAdapter, RestAdapter   (à venir)
  store/       Store (CRUD async, index secondaires, undo/redo)              (à venir)
  geometry/    Projection, Box, Painter, RackGeometry, GraphGeometry (purs)  ← FAIT (4a)
               RackScene (occupants, side/wall slots — store injecté)        ← FAIT (4b)
               FreeEquipGeometry (pur) · Resolver3D (resolvePort3D + waypoints) ← FAIT (4c)
  registries/  EquipmentTypes, PortRoles, Depths, EquipFaces, Port/CableTypes ← FAIT
  ui/          Dom, Notify, FormControls (helpers/composants DOM partagés)    ← FAIT (5a)
  views/       ListController, GraphView, DatacenterView                     (5b)
  app/         main.ts (bootstrap)
  index.html   coquille (markup + CSS à migrer en phase « Shell »)
```

## Feuille de route

- [x] **Phase 0 — Socle build.** package.json, tsconfig, webpack (sortie
      mono-fichier), `dist/netmap.html` qui compile.
- [x] **Phase 1 — Modèle de domaine.** `Entity` + 18 sous-classes + registre,
      avec leurs dépendances (constantes, `Id`, `Normalize`, registres). Type-check
      et build verts ; régression legacy intacte (213/213).
- [x] **Phase 2 — Couche données.** `FieldIndex` (+ helpers de match en statiques),
      `DataAdapter` (base abstraite), `BrowserStorageAdapter`, `RestAdapter` ; types
      partagés (`Snapshot`/`Transaction`/`ListResult`) ; config (`INDEX_SPEC`, tailles).
      Le global UI `noteUndoable` devient un callback injecté (`onUndoable`). Porté
      à l'identique ; tsc + build verts.
- [x] **Phase 3 — Store.** CRUD async, transactions, undo/redo, helpers métier
      (résolution inverse par index), cascade déclarative (`CASCADE_SPEC`),
      (dé)sérialisation + migration des dispositions. Catalogues par défaut tirés
      en avance (`registries/defaultCatalogs`, données seules). **Filet de
      régression au niveau MODULES** (`Tests/modules/run.js` via `npm run
      test:modules` : compile en CJS puis exerce modèle + données + store —
      32/32). tsc + build + legacy (213/213) verts.
- [x] **Phase 4a — Géométrie PURE & registres OO.** `core/Labeler`, `core/ClickGuard` ;
      `registries/` (EquipmentTypes couleur/icône/libellé, PortRoles, Depths, EquipFaces,
      + `PortTypes`/`CableTypes` promus depuis `defaultCatalogs`) ; `geometry/`
      (Projection, Box, Painter, RackGeometry, GraphGeometry). Harnais modules
      étendu (suites legacy 02/07/09/10/11/12 absorbées) → 86/86.
- [x] **Phase 4b — Occupation & géométrie side/wall.** `RackGeometry` étendu (helpers
      dimensionnels + boîtes side/wall/capot, purs) ; `geometry/RackScene` (classe à
      store injecté : `occupants`, side/wall occupants + slots libres, capots).
      Harnais modules → 106/106 (volet side/wall de la suite 06 + occupation).
- [x] **Phase 4c — Ports 3D & géométrie waypoint.** `geometry/FreeEquipGeometry`
      (boîte « 6 faces » des équipements libres : `box`/`faceLocal`/`portWorld(C)`/
      `portNormal`, pure) ; `geometry/Resolver3D` (store injecté : `resolvePort3D`,
      `waypointAnchor`/`waypointPassPoints`, `brushGeom`/`sidePinGeom`/`capPinGeom`).
      Harnais modules → 127/127 (toutes les suites géométrie legacy 02/06/07/08/09/
      10/11/12 absorbées). RESTE : la RÉPARTITION conduit (`conduitOffsetFor` & co.,
      offsets dans la section) — non testée, à porter avec les vues si besoin.
- [x] **Phase 5a — Helpers DOM/UI partagés.** Purs : `core/Html` (escape),
      `core/Color` (hexToRgb/contrast/pill), `core/Format` (meters/date),
      `geometry/GridGeometry` (cellKey/cellOf/blocked). Composants DOM :
      `ui/Dom` (svg), `ui/Notify` (toast), `ui/FormControls` (fieldRow/text/number/
      select/toggle/date/datalist). Harnais modules → 141/141 (volets purs testés).
- [~] **Phase 5b — Contrôleurs de vue** (un par sous-phase, sur `store` + hôte injecté) :
  - [x] **GraphView — tranche-pilote** : `views/GraphView` (build depuis le store →
        layout force-directed → rendu SVG nœuds/arêtes + pan/zoom + glisser de nœud),
        `GraphHost` injecté (`setDirty`/`openEquipmentDetail`). Câblé dans `main.ts`
        (document de démo). Build = `dist/netmap.html` exécutable. Tests build+layout
        (sans DOM, faux stage) → 146/146. RESTE GraphView : cadres, dispositions
        nommées, modes A/B/C, sélection/marquee, menus, légende, export, toolbar.
  - [ ] GraphView complet, puis `ListController`, puis `DatacenterView`
        (+ machinerie conduit restante).
- [~] **Phase 6 — Shell / bootstrap** :
  - [x] **CSS** extrait du monolithe → `src/styles/netmap.css` (verbatim, 1423 l.),
        chargé par webpack (`style-loader`/`css-loader`) → injecté au runtime, donc
        toujours **inliné** dans le HTML autonome. Le pilote GraphView est désormais
        correctement thématisé (nœuds/texte/arêtes lisibles).
  - [x] **Modale / dialogues / toasts** en classes auto-construites (DOM créé au
        besoin, stylé par le CSS extrait) : `ui/Notify` (toast + conteneur lazy),
        `ui/Dialog` (confirm/alert/custom/prompt empilables, Promise), `ui/Modal`
        (modale d'édition unique : open/close/requestClose/markDirty + détection de
        modif par instantané). Démo : double-clic d'un nœud → fiche équipement.
  - [x] **Navigation + ossature** : `app/Shell` construit en-tête + onglets + conteneurs
        de vue et porte `switchView` (bascule `.active` → rendu de la vue). Les vues
        s'enregistrent via `addView`. `main.ts` monte la Topologie (GraphView) +
        onglets placeholder (Équipements/Datacenter à porter). Tabs/views stylés par
        le CSS extrait.
  - [ ] Bootstrap final (remplace le document de démo par un vrai chargement) ;
        câblage complet des `*Host` ; portage des vues restantes ; retrait du
        mono-fichier.
- [ ] **Phase 5 — Vues** (`ListController`, `GraphView`, `DatacenterView`).
- [ ] **Phase 6 — Shell / UI.** Migration du `<head>`/`<style>`/`<body>` et du
      bootstrap ; câblage final ; retrait du mono-fichier.

## État actuel (Phases 1–2)

Modèle de domaine **et** couche d'accès aux données extraits **à l'identique**
(mêmes normalisations / défauts / rétro-compat / logique transactionnelle que le
HTML v172). `src/app/main.ts` est un point d'entrée provisoire qui instancie le
registre + un adapter pour prouver la chaîne — il sera remplacé par le vrai
bootstrap en phase 6.

Le filet de régression au niveau **modules** arrive en phase 3 (le Store est la
première couche dont le comportement justifie des tests directs ; la couche
données y sera couverte au passage). D'ici là, `Tests/run.js` continue de valider
le comportement contre le dernier HTML livré.
