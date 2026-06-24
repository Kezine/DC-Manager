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

## Décision différée — moteur de rendu 3D (POST-migration)

La vue 3D est portée **à l'identique en SVG** (projection ortho + tri peintre topologique),
ce qui préserve l'export vectoriel, le theming CSS, la pile DOM/événements unifiée avec les
vues 2D, et le filet de régression. Un éventuel passage à un **moteur dédié** est un chantier
SÉPARÉ à n'ouvrir qu'une fois la migration terminée et l'app stable :
- **Three.js** : seul à supprimer vraiment le tri peintre (z-buffer réel) + perf/éclairage,
  MAIS ~600 Ko, export PNG seulement (plus de SVG vectoriel), theming à réimplémenter (pas de CSS).
- **Zdog** : minuscule (~28 Ko) et rend en SVG (export + theming partiellement préservés),
  MAIS trie les shapes par z (painter, **pas** de z-buffer) → n'améliore pas l'occlusion des
  scènes denses ; pensé pour l'illustration stylisée.
Les deux sont des RÉÉCRITURES du rendu ; la géométrie pure portée (`Projection`, `RackGeometry`,
`RackScene`, `FreeEquipGeometry`, `Resolver3D`, conduit) reste réutilisable quel que soit le moteur.

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
      10/11/12 absorbées).
- [x] **Phase 4d — Répartition conduit (pur).** `Resolver3D` étendu : `waypointConduitDims`
      (section utile segment/brush/pin), `conduitGrid`/`conduitCell` (statiques purs),
      `conduitCablesOf` (ids triés, ordre stable), `conduitBasis` (repère ⊥ au flux),
      `conduitOffsetFor` (offset monde d'un câble dans la section ; null si 1 câble/non-conduit).
      L'offset alimente `waypointPassPoints(…, off)`. Harnais modules → 177/177 (suite
      « répartition conduit »). Toute la géométrie nécessaire à `DatacenterView` est portée.
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
        (sans DOM, faux stage) → 147/147.
  - [x] **GraphView — manipulation directe** : sélection multiple (clic/Maj/marquee),
        déplacement de GROUPE avec auto-pan au bord, zoom-au-curseur, recadrage,
        menus contextuels (nœud : Détails/Supprimer · fond : sélection/recentrage)
        via `ui/ContextMenu`. Hôte étendu (`deleteEquipment`). Câblé dans `main.ts`.
  - [x] **GraphView — toolbar / filtres / légende** : barre d'outils avec 4 filtres
        multi-sélection (`ui/MultiSelect` : équipements/réseaux/groupes/types de port),
        mode de poignée (type/réseau/groupe), recherche-surlignage, « Tout afficher ».
        Filtrage du jeu de nœuds (`_filteredSets`), couleur de poignée dominante par
        réseau, légende réseaux/groupes. Garde headless (constructeur sans `document`).
  - [x] **GraphView — cadres** (`ui/ColorPalette`), **dispositions nommées + modes
        A/B/C** (masquage par filtres, gestionnaire de dispositions), **export
        SVG/JPEG + plein écran** (`ui/ImageExport`). **GraphView est COMPLET** —
        réplique fonctionnelle du contrôleur du monolithe.
  - [~] **ListController → `views/ListView`** : table générique OO (tri colonnes+dates,
        filtres multi-sélection, recherche, pagination ; état persisté en session ;
        actions de ligne déléguées). `views/ListConfigs` (colonnes par collection) +
        `core/Sort`. Câblé : onglets **Équipements / Réseaux / Groupes** (liste + détail
        + cloner + supprimer). Toutes les collections sont listées (câbles, racks,
        catalogues, IPAM). **Formulaires** (`views/Forms`, modale injectée) : réseau,
        groupe, et IPAM (réseau IP / adresse / DHCP) via `core/Ip` (CIDR pur testé).
        + **équipement (CŒUR)** : identité, admin, groupe, dimensions U/libre,
        placement rack simple (champs avancés préservés via patch). Stabilisation :
        `Store.onChange` → rafraîchissement live de la vue active + bascule de thème.
        + **ports/agrégats** + **breakout** (dialogue trunk→N lanes : span dérivé des débits
        via `PortTypes.speedGbps` + `BREAKOUT_SPANS`). Formulaires **câble**
        (extrémités/compat/réseaux/statut) et **rack** (cage/dims/side-mount, garde-fou
        redimensionnement) + **portes** (avant/arrière : épaisseur/charnière/creuse) +
        **capots** (éditeur de cellules waypoint toit/sol, grille SVG multi-sélection,
        sauvegarde immédiate). + **câble COMPLET** : faisceau (brin → type/route/longueur
        hérités), **points de passage** (waypoints ordonnés, grammaire exit/OOB en direct,
        contraintes famille + salle, statut borné) + formulaire **faisceau** + onglet
        **Faisceaux**. Helpers de domaine portés dans le `Store` (`equipmentDcId`, `cableRoute`,
        `cableSideConstraint`, `cableMaxStatus`/`cableStatusFits`, `cableRouteSummary`,
        `bundleOccupancy`/`effectiveWaypointIds`, `waypointIsPlaced`, `portKind`) + statiques
        `Waypoint.typeOf`/`glyph`/`floorLabel` ; `Resolver3D` délègue désormais au `Store`.
        Harnais modules → 191/191 (suite « route de câble / faisceaux »). + **éditeur de
        façade** (`Forms.faceEditor`, sous-éditeur empilé) : pose des ports sur les faces
        (onglets, glisser, snap de grille, « Tout poser / enlever », palette), reporté sur
        le brouillon du formulaire d'équipement (bouton « Façade… ») ou écrit au store.
        Navigation réalignée sur l'original. **ListView/Forms COMPLET** — réplique
        fonctionnelle du monolithe (hors bibliothèque d'images, voir ci-dessous).
  - [~] `DatacenterView` (Machinerie conduit : FAITE — phase 4d) :
    - [x] **5c.1 — pilote 3D** : `views/DatacenterView` + `DatacenterHost` injecté. Caméra
          orbitale orthographique (`project3DCam`/`unproject3DCam`, azimut+élévation, presets
          iso/dessus/face/côté), cadrage (`sceneBounds`/`recenter`/`minScale`), pivot recentré
          sur le centroïde visible. Rendu d'UNE salle : sol + liseré avant + baies en boîtes 3D
          (8 sommets → 6 faces triées peintre + plinthe avant), clic baie → formulaire rack.
          Orbite (Maj/clic droit) · déplacement (glisser) · zoom molette. Câblé dans `main.ts`
          (onglet Datacenters). Tests projection (round-trip + presets) → 204/204.
    - [x] **5c.2 — occupants & équipements** : `_rackBox3D` enrichi — enveloppe à faces classées
          near/far (les faces solides toit/côtés occultent, av/ar/sol restent « lointaines »),
          **occupants U** (équipements + pseudo-items, av/ar, boîtes 6 faces via `Box.faces`),
          **montants 19″**, **emplacements U libres** (face regardée), le tout ordonné par un **tri
          peintre topologique** (Kahn sur paires se chevauchant à l'écran via `Painter.farFirst`).
          + **équipements libres** posés dans la salle (`FreeEquipGeometry.box` → boîte 6 faces).
          Clic baie → form rack · clic occupant/équipement → détail. Nouveau `RackScene.occupantsElev`.
          Tests → 206/206.
    - [x] **5c.3 — câbles & waypoints 3D** : câbles INTRA-salle (deux bouts résolus via
          `Resolver3D.resolvePort3D`) avec points de passage (offsets de section conduit via
          `conduitOffsetFor`/`waypointPassPoints`), tracés en spline Catmull-Rom au-dessus des
          équipements + pastilles d'extrémité, clic → form câble. Waypoints de salle (rails
          `segment` + pins `point` libres) avec mât, clic → form waypoint. Nouveau
          `Store.cableWaypointsIn`. Tests (résolution intra-salle) → 208/208.
    - [x] **5c.4 — panneau latéral + création/placement** : `DatacenterView.renderSide` (carte
          « Affichage 3D » : toggles équipements av/ar · emplacements libres · parois & capots ·
          câbles · waypoints ; carte « Baies » : visibilité par baie + accès au form). Layout
          stage | panneau en rangée flex. **Déblocage des données** : `Forms.datacenter` +
          `ListConfigs.datacenters` + sous-onglet **Salles** (lien depuis l'onglet Datacenters) ;
          `Forms.rack` gagne le **placement en salle** (sélecteur datacenter + position X/Y mm,
          lieu/étage/local hérités). Tests → 208/208.
        - **Layout** : largeur des onglets portée à **95vw** ; `app/Shell` repasse `#app` en flux
          BLOC (les marges auto d'un item flex écrasaient le stretch → onglets étroits). Vue 3D :
          `DatacenterView.fitHeight` étire la rangée stage|panneau pour remplir la hauteur restante
          du viewport (recalcul au resize), comme `_fitHeight` du monolithe.
    - [x] **5c.5 — ports sur les faces** : connecteurs dessinés À PLAT dans le plan de la face
          (taille réelle via `Store.portConnectorSize` + `PORT_CONNECTOR_MM`), colorés si câblés,
          clic → form câble (préremplie `fromPortId` si port libre). Toggle « Ports » au panneau.
          Tests → 210/210.
    - [x] **5c.6 — noms d'équipement** : étiquette (nom + icône de type) posée À PLAT sur la face
          tournée vers la caméra (`flatLabel`, matrice affine + anti-miroir + taille adaptée à la
          boîte) ; toggle « Noms d'équipement » au panneau. Lecture de la baie nettement améliorée.
    - [x] **5c.7 — persistance de l'état de vue** : caméra (az/el/scale/tx/ty/camTarget) · salle
          active · baies masquées · toggles d'affichage écrits (débouncé 300 ms) en localStorage,
          **par fichier** (`netmap.view3d.<fileId>`). Restauration UNE FOIS par fichier (les
          re-rendus de données ne réécrasent pas les réglages de session) avec failsafes
          (références disparues ignorées, défauts sinon). « Réinitialiser les préférences 3D »
          (réglages) efface et réapplique les défauts. Tests round-trip → 214/214.
    - [x] **5c.8 — vue Dessus (2D) + placement par glisser** : bascule 3D ⟷ Dessus (toolbar,
          persistée). `renderTop` : salle + grille + liseré front + baies (rect orientées) +
          équipements libres + câbles 2D (spline sur x,y) + waypoints (pins/rails). **Glisser-
          déposer** baies/équipements avec **aimantation à la maille** (`snap`), bornage à la salle
          (`rackHalfExtents`/`FreeEquipGeometry.halfExtents`), cote en mètres pendant le drag ;
          pan 2D au glisser du fond, zoom molette. Clic câble/waypoint → form. Tests
          (snap/half-extents) → 218/218. (Rotation « réf. en bas » + édition cases inaccessibles :
          raffinements différés.)
    - [x] **5c.9 — occupants latéraux & paroi** : équipements `side` (marge latérale) et `wall`
          (paroi) ajoutés au flux d'unités du rack (boîtes 6 faces, tri peintre topologique commun),
          titre + clic → détail + nom. `RackScene.sideOccupants`/`wallOccupants` + `RackGeometry.
          sideEquipBoxLocal`/`wallEquipBoxLocal`.
    - [x] **5c.10 — panneaux de contrôle** : `renderSide` enrichi — carte **Recherche** (surligne
          équipements (`.hit`/`focus-pulse`) + câbles et filtre les listes, sans perte de focus de
          l'input), carte **Affichage 3D** (toggles), carte **Équipements** (liste filtrée → ciblage
          caméra `focusEquipment` + détails), carte **Câbles** (« afficher tous » + sélection
          par câble `selCables`/`showAllCables` + édition), carte **Baies** (visibilité + form).
          Rendu câbles gouverné par `cableShown`. Tests (matchSearch/cableShown) → 222/222.
    - [x] **5c.11 — carte « Vue 3D » complète (réplique de référence)** : grille de toggles
          (masquer av/ar · noms · ports · capots/parois · emplacements libres · waypoints ·
          repères d'orientation · centre de rotation), **coloration** des équipements (face/groupe/
          type via `eqFill`), **slider d'arrondi** des câbles (`cableSplineK`), bouton « Recentrer
          sur la salle ». Contrôles présents mais **inertes** (« à venir », désactivés) tant que la
          fonctionnalité n'est pas portée : images de façade, portes des baies, grilles d'étage,
          sortie ⊥ des ports, culling. Tout l'état est persisté (TOGGLE_KEYS + colorMode/spline/cull).
          Wirés en plus : `showOrientMarks` (liseré front 3D/2D), `showPivot` (marqueur). Tests
          (eqFill) → 225/225.
    - [x] **5c.12 — portes 3D + culling** : portes en saillie (av/ar) rendues (panneaux
          translucides + charnière, near/far comme les parois) → toggle « Portes » actif ;
          **culling de distance** (`camViewWidthM`/`_farCull`) masque ports + emplacements libres
          au-delà de N m → slider actif. Tests (camViewWidthM) → 226/226.
    - [x] **5c.13 — power bolts** : éclairs ⚡ (`powerBoltsAlong`/`powerBoltNode`) répartis le long
          des câbles d'alimentation (`cableIsPower`), billboardés, visibles DE PRÈS seulement
          (`showPowerBolts` ≤ 50 % du seuil de culling). Tests → 228/228.
    - [x] **5c.14 — câbles SORTANTS (exits)** : `DatacenterView.outgoingCableStubs(dcId)` — câbles dont
          UN SEUL bout est résolu dans la salle et qui sortent par un exit, tracés du port local jusqu'à
          l'exit (« s'arrêtent au mur ») via la grammaire `Store.cableRoute` (steps exit/oob) + offsets
          conduit (`conduitOffsetFor`/`waypointPassPoints`). Rendus en 3D (`emitCable3D`) et en vue Dessus
          (`drawCable2D`, extrait de `drawCables2D`), filtrés par `cableShown`/`hidden3dRacks`. Listés et
          sélectionnables dans le panneau « Câbles » (fusion intra-salle + sortants, dédup par id).
          Tests → 232/232. (Stub perpendiculaire `linePts` non porté — déjà simplifié pour les intra-salle.)
    - [x] **5c.15 — emplacements libres cliquables (assignation)** : tous les emplacements libres d'une baie
          en 3D deviennent des cibles d'assignation. **Rendu** (`DatacenterView.rackInterior3D`) : ajout des
          units `sidefree` (boîte plate au plan de la face, `RackGeometry.sideSlotBoxLocal` + `RackScene.
          sideFreeSlots`), `wallfree` (`wallSlotBoxLocal`/`wallFreeSlots`) et `capfree` (trous toit/sol,
          `capGrid`/`capFreeSlots`), gardés par `showPlaceholders`/`_farCull` + face regardée + hideFront/Rear,
          intégrés au tri peintre topologique. **Clic** → callbacks hôte : U libre → `assignSlot`, latéral →
          `assignSideSlot`, mural → `assignWallSlot`, capot → `assignCapSlot`. **Dialogues** (`Forms.assign*`,
          via `Dialog.custom`, réplique du monolithe) : U (équipement non placé / pseudo-élément `RackItemKinds`
          / brosse de brassage), latéral (équipement OU pin, snap montant/paroi), mural (équipement, orientation
          centre/façade), capot (pin uniquement). Validations portées dans le `Store` : `equipmentRequiredDcs`/
          `equipmentPlacementBlockedReason` (contrainte de salle par câblage), `equipmentContext`/
          `cableContextValid`/`cableBreakOps`/`applyCableBreaks` (casse des câbles dont la route n'est plus
          valide après placement). Réutilise `RackGeometry.canPlace`/`mountSides`/`sideColWidthMm`/`wallGeo`,
          `RackScene.occupants`/`sideSlotFree`/`wallSlotFree`/`capSlotOccupied`/`*FreeSlots`. Tests → 238/238.
          (Différé : sélection multi-U au Ctrl+clic — clic simple = 1 U pour l'instant.)
    - [x] **5c.16 — multi-salles & routes inter-DC** (chantier transverse, par sous-phases) :
      - [x] **5c.16.1 — socle de disposition (PUR, testé)** : `geometry/FloorLayout` (store injecté) porte la
            couche étage/bâtiment du monolithe : `config` (entité `floors` ou défaut virtuel), `roomFootprint`/
            `roomPos`/`roomAuto` (emprise + position auto par pavage), `roomLocalToPlan`/`planToRoomLocal`,
            `oobLocalized`/`oobFloorPos`/`oobHeight`, `allFloorKeys`, `zRef`, et surtout **`multiLayout(cur,
            {visibleDcIds, gap})`** (salles posées par lieu = bâtiment côte à côte, étages empilés en Z ;
            renvoie `rooms`/`levels`/`buildings`/`floorPlanes`/`stackH`/`totalW`/`maxD`/`topZ`/`levelStep`) +
            `roomToWorld`/`roomToLocal` (pivot autour du centre de salle), `levelZ` (Z interpolé), `oobWorld`.
            Nouveaux helpers `Store` : `dcsOfFloor`/`oobWaypoints`/`floorEquipments` ; constante `DC_GAP_DEFAULT`.
            **Aucun rendu encore** (strangler : couche pure d'abord). Tests → 252/252.
      - [x] **5c.16.2 — rendu 3D multi-salles** : champ `multiDc` + `visibleDcIds` + `_multi` ; bouton toolbar
            « Multi-salles » (`setMultiDc` : affiche TOUTES les salles, recadre). `renderThreeD` calcule
            `_multi = floor.multiLayout(...)` et itère `m.rooms` en composant la projection
            `projRoom = p => proj(FloorLayout.roomToWorld(room, p))` → chaque salle est rendue dans son repère
            LOCAL sans toucher aux méthodes géométriques (rackBox3D/equipBox3D/câbles/waypoints inchangés).
            `camCenter` (centre de l'ensemble : totalW/maxD/topZ) et `sceneBounds`/`recenter` rendus multi-aware
            (itèrent `m.rooms` via `roomToWorld`). État persisté (multiDc + visibleDcIds, failsafe). Tests → 252/252.
            (Limite assumée : la dalle de sol par salle reste à profondeur fixe `1e9` → pas d'occlusion
            inter-étages des sols ; réglé par `levelStep`/`floorPlanes3D` en 5c.16.3.)
      - [x] **5c.16.2b — panneau latéral REFAIT depuis la source** (pour piloter/tester la 3D & multi-salles) :
            l'ancien `renderSide` (cartes Recherche/Équipements ad-hoc) est REMPLACÉ par l'orchestrateur +
            card-builders du monolithe (`collapsible`/`displayedDcIds` + cartes). **3D** : **Datacenters**
            (`dcScopeCard` : bascule « Vue étage » = `multiDc`, multi-sélection des salles empilées, préréglages
            salle/bâtiment/sites via `DC_SCOPE_ICONS`, groupées par bâtiment→étage), **Racks** (`racks3dCard` :
            visibilité GLOBALE sur les salles affichées, tout afficher/masquer, **estomper** `fadedRacks` +
            opacité dans `rackBox3D`, **isoler**), **Câbles** (`cableCard` : sélection par réseau / liens
            inter-DC / liste filtrée équipement+texte via `panelCables`/`cableListFiltered`), **Vue 3D**
            (`view3dOptionsCard` : toggles + sliders arrondi/culling + recentrer). **Dessus** : **Sélection**
            (baie/équipement libre/waypoint : pivoter, modifier, retirer avec `cableDowngradeOps`), **Racks
            dispo (pool)** + **Équipements libres (pool)** (placement avec garde `rack/equipmentPlacementBlocked
            Reason`), **Câbles**. Cartes repliables (`expanded`). Nouveaux helpers `Store` : `cableDowngradeOps`,
            `rackPlacementBlockedReason`. **La case « Vue étage » pilote désormais le rendu multi-salles 5c.16.2.**
            (Non porté faute de socle : route builder 3D, vue Étage `floor`, form/pool waypoints, tooltips riches.)
      - [x] **5c.16.3 — décor** : biais de profondeur PAR ÉTAGE (`lvlBias` = (topIdx − idx niveau) × `levelStep`)
            appliqué au contenu de chaque salle → **un sol d'étage haut occulte le contenu d'un étage bas** (corrige
            la limite 5c.16.2). `floorPlanes3D` (grille de plan par bâtiment × étage, gardée par `showFloorGrid` →
            **toggle « Grilles d'étage » désormais actif** ; liseré de bord de réf. ; cases inaccessibles),
            `floorOobs3D` (anneau ◎ + mât des OOB posés sur leur étage, cliquable → form waypoint, via
            `FloorLayout.oobWorld`/`levelZ`), `multiDecor3D` (étiquettes « Étage N » à gauche + nom de bâtiment
            vertical + parois-séparateurs entre bâtiments). Tests (floorPlanes/oobWorld) → 256/256.
            (Non porté : menu contextuel du plan d'étage, équipements posés sur étage `floorEquip3D`.)
      - [x] **5c.16.4 — routes inter-DC** : `interDcRoutes(m)` sélectionne les câbles à route VALIDE avec exits
            dont les 2 bouts résolvent dans des salles AFFICHÉES, et construit le trajet MONDE (port A →
            `buildWorldVia` : waypoints de salle résolus dans LEUR salle [ancre → repère local des voisins →
            `conduitOffsetFor` → `waypointPassPoints` → retour monde] + OOB via `FloorLayout.oobWorld`, salle
            masquée sautée → raccourci → port B). `interDc3D` les trace via `emitCable3D` (spline + couleur réseau +
            sélection + power bolts + pastilles, clic → form câble), en sautant si une baie d'extrémité est masquée.
            `room3D` reçoit un `skipCables` (ids des routes inter-DC) → plus de DOUBLE tracé via les stubs sortants.
            Tests (interDcRoutes) → 258/258. **Multi-salles COMPLET** (hors équipements d'étage + vue Étage 2D).
    - [x] **5c.17 — vue Étage (plan bâtiment 2D)** : 3e mode de vue (`view: "floor"`, bouton toolbar « Étage »).
          `floorTargetResolve()` (floorTarget explicite → salle active → 1re salle → 1er étage connu). `renderFloor`
          (réutilise `FloorLayout.config`/`roomPos`/`roomFootprint`) : plan du bâtiment×étage (rect + grille +
          bord de réf.), **salles** en emprises orientées **déplaçables** (`onFloorRoomPointerDown` → `floor_x/y`
          aimantés au bord de maille `snapEdge`, bornés au plan ; clic simple = activer la salle), **OOB** de
          l'étage (losange cliquable → form waypoint). Panneau **Étage** (`floorCard`) : sélecteur bâtiment·étage,
          liste des salles (activer / modifier via nouveau host `openDatacenterForm`), liste des OOB, recadrage.
          Pan 2D + zoom molette + cadrage (`sceneBounds`/`recenter` étendus au mode floor) ; `view`/`floorTarget`
          persistés. Tests (snapEdge/floorTargetResolve) → 262/262. (Non porté : flip 180° « réf. en bas »,
          rail d'étages, marqueur d'ancrage déplaçable, équipements d'étage, menus contextuels, form d'étage.)
    - [x] **5c.18 — brosses de brassage 3D** : une brosse (waypoint kind « brush » ancré à une baie, posée via
          `assignSlot`) est désormais RENDUE par sa baie (`rackInterior3D`) comme une unité du tri peintre
          (boîte locale corps×U×profondeur `min(depth_mm, cage)`) → occlusion correcte vs équipements/montants.
          Émission **coque creuse + tunnel ajouré** (cadres av/ar `evenodd` + parois extérieures + parois du
          tunnel, faces `dc-eq3d item` triées par profondeur, arêtes `dc-brush-edge`), clic → form waypoint.
          La brosse occupe déjà ses U (`RackScene.occupants`, layer porté). Tests (occupants/exceptBrushId)
          → 264/264. (Non porté : menu contextuel, accroche de route, indicateur ◆ de routage.)
    - [x] **5c.19 — équipements posés sur un étage** (placement « floor ») : helpers purs `FloorLayout`
          (`floorEquipPos`/`floorEquipHeight`/`floorEquipLocalized` + `equipFloorWorld` au niveau de l'étage).
          **Vue Étage 2D** : `floorEquipNode2D` (empreinte orientée + libellé contre-tourné) **déplaçable**
          (`onFloorEquipPointerDown` → `floor_x/y` snappés + rattache bâtiment/étage ; clic = sélection) ;
          carte « Équipements de l'étage » dans `floorCard` (cibler / fiche). **3D multi-salles** : `floorEquip3D`
          (boîte d'équipement libre via `freeEquipBoxAt` au point monde de l'étage + mât si surélevé, biais peintre
          par niveau). Refactor : `equipBox3D` délègue à **`freeEquipBoxAt(e, cx, cy, baseZ, proj)`** (réutilisé
          salle + étage ; coloration `eqFill`/`eqHit`). Tests (floorEquipPos/equipFloorWorld) → 267/267.
          (Non porté : `floorEquipCables3D` — câbles touchant un équipement d'étage ; menus contextuels ; pose
          guidée `assignFloorEquip` — la pose se fait via le formulaire d'équipement en mode « Étage ».)
    - [x] **5c.20 — câbles d'équipement d'étage** : `floorEquipCables3D` trace en repère MONDE les câbles dont
          ≥ 1 bout est « floor » (sinon ni les câbles de salle ni les routes inter-DC ne les couvrent).
          `isFloorPort` + `resolveFloorCableEnd` (bout floor → `equipFloorWorld` + `FreeEquipGeometry.portWorldC` ;
          bout en salle → `resolvePort3D` + `roomToWorld`), points de passage via `buildWorldVia`, tracé via
          `emitCable3D`. Ces câbles sont ajoutés au `skip` des salles (anti double tracé). Tests
          (isFloorPort/resolveFloorCableEnd) → 269/269. (Non porté : stub ⊥ des ports, connecteur du bout racké
          [déjà dessiné par la baie].)
    - [x] **5c.21 — raffinements** : (1) **fiche DÉTAIL d'équipement** portée (`Forms.equipmentDetail`) —
          remplace le dump générique : identité (type/marque/modèle/série/groupe/admin/dims/emplacement/lieu),
          **façade** (bouton éditer + aperçus des faces avec image + pastilles ports), **ports** (type/rôle/
          agrégat/breakout), **câbles connectés** (liaison/réseau), bouton **« Modifier »** → `Forms.equipment`.
          Câblée sur `host.openEquipmentDetail` (clic 3D + nœud GraphView) ET la « view » de la liste Équipements.
          Helpers inline portés : `equipLocationBits`, `facePreview`, endpoints câble (`Color.pillStyle`/`Format.
          dateTime`/`FloorLayout.locationLabel`). (2) **Survol 3D réparé** : `wireOccupant` repose `data-occ="eq:id"`
          + mouseenter/leave → bascule `.hover` sur TOUTES les faces de l'équipement (mise en évidence).
          (3) **Contrôles caméra en OVERLAY** (réplique source) : `buildControls` crée un `.graph-zoom-controls`
          superposé au stage (bas-droite, `position:absolute`) — zoom +/− · recentrage · points de vue
          (Dessus/Face/Arrière/Côté/3D, masqués hors 3D via `updateControls`) + **plein écran** + **export image**
          (`openExportDialog`/`exportImage` via `ui/ImageExport` : clone SVG + styles inlinés + fond, vue affichée
          → SVG/JPEG) ; retirés du toolbar (qui ne garde que Salle · modes de vue · Multi-salles). Préservé par
          `clearStage` ; masqué sur écrans vides. **Plein écran** : `requestFullscreen` natif sur la rangée
          `.dc-row` (CSS `:fullscreen` portée) + **re-parentage des overlays** `ui/Fullscreen` (réplique de
          `fullscreenHost`/`homeInFullscreen`/`_rehomeFloatingUI`) : la modale/les dialogues/les toasts/les menus
          (`.modal-overlay`/`.dialog-overlay`/`#toast-container`/`.graph-ctx`) s'attachent à `Fullscreen.host()`
          (= élément FS courant) et sont re-homés sur `fullscreenchange` → visibles dans le top-layer. `fitHeight`
          laisse le CSS gérer la hauteur en FS ; re-cadrage sur `fullscreenchange`. Tests → 274/274.
    - [x] **5c.22 — survol des ports + route builder interactif** : (1) `wirePortNode` (remplace le `wireClick`
          des ports) → **survol** (`.dc-port.hover`) + titre + clic ROUTE-AWARE. (2) **Routage au clic**
          (`routeBuild = {fromPortId, wpIds, armed}`) : bouton « 🧵 Créer une route » (carte Câbles) → clic port
          libre = départ → clics waypoints/brosses/OOB (`onWaypointClick` route-aware sur tous les nœuds de scène)
          → clic port terminal = `routeFinish` → `host.openCableForm(null, {fromPortId, toPortId, waypointIds})`
          (form prérempli). Carte **« Route en cours »** (`routeCard` : étapes · ↩ Retour `routeBack` · ✕ Annuler).
          **Aperçu** `drawRoutePreview3D` (spline pointillée + pastilles, conduits dépliés via `waypointPassPoints`).
          Tests (routeAddWp/routeFinish) → 277/277. **FIX** : `.dc-port { pointer-events:none }` neutralisé dans
          `wirePortNode` (`style.pointerEvents="auto"`) → ports réellement survolables/cliquables.
    - [x] **5c.23 — menus contextuels (clic droit) + aperçu jusqu'au curseur** : helper `ctxMenu` (via
          `ui/ContextMenu`, garde anti-glisser `_navMoved` posé par l'orbite) + builders `portCtx`/`equipmentCtx`/
          `rackCtx`/`waypointCtx`/`cableCtx` (édition · routage démarrer/terminer · retirer/supprimer · sélection
          de câbles afficher/isoler/masquer `cableSelItems`), câblés sur ports/occupants/baies(3D+2D)/waypoints/
          câbles. **Aperçu de route → souris** : suivi `mousemove` throttlé (45 ms) → `unproject3DCam` au plan du
          centre caméra (`_camC`) → `routeBuild.mouse` ajouté à `routePreviewWorldPts`. **Welcome** : bouton
          « Continuer sans fichier » retiré. Tests → 277/277.
    - [x] **5c.24 — connectPortFlow (brouillons-candidats) + menu du SOL** : `Store.cableDraftCandidatesForPort`
          (câbles draft à un seul bout, famille compatible, salle acceptée) ; `Forms.cable` gagne **`assignPortId`**
          (préremplit le bout vide d'un brouillon depuis un port libre). `DatacenterView.connectPort(port)` : clic
          sur un port LIBRE → dialogue « Nouveau câble / affecter à un brouillon » (sinon form direct si aucun
          candidat) ; câblé au clic gauche ET au menu « Créer / affecter un câble… ». **Menu du SOL** (vue Dessus,
          `floorCtx`) : clic droit sur le sol → créer **pin / chemin de câbles / exit** au point (aimanté ½ maille).
          Tests (cableDraftCandidatesForPort) → 279/279.
    - [x] **5c.25 — raffinements (TOUS portés)** : (1) **rotation « réf. en bas » des vues 2D** (`floorXf`
          {angle,cx,cy,flip} : Dessus = orientation+180°, Étage = 180° + miroir → vraie vue « du dessus », cohérente
          3D ; `applyTransform`/`clientToWorld`/`rotBounds`/`uprightTexts`, cf. monolithe `_floorXf`). (2) **rail
          d'étages** (`renderFloorRail`, flottant à gauche) + **marqueur d'ancrage déplaçable** (`floorAnchorNode`/
          `onFloorAnchorPointerDown` → `floors.anchor_x/anchor_y`, toggle `showFloorAnchor` persisté). (3) **menu
          contextuel du plan d'étage 3D multi** (`floorPlane3DCtx` : éditer le plan / ajouter une salle / vue Étage 2D).
          (4) **sélection multi-U au Ctrl+clic** (`slotSel`/`toggleSlotSel` : plage contiguë → assignation N U).
          (5) **undo image dans la timeline GLOBALE** (`noteUndoable`/`doUndo`/`doRedo` dans `main.ts` : un seul
          Ctrl+Z défait modèle + images dans l'ordre, via `onUndoable` de l'adapter et d'`ImageStore`). (6) **compagnon
          `.nmfb` SÉPARÉ** : images dissociées du modèle (parité monolithe) — le `.json` FS n'inline plus, le save écrit
          le `.nmfb` à côté, le load le recharge (appariement `meta.facesKey`/`ImageStore.lastLoadedKey`, rechargement
          auto au welcome via `HandleStore.getFaces/putFaces`, modale « Ouvrir » JSON/compagnon ; download sans FS reste
          inline = autonome). **NB** : le comportement runtime FS (permissions, appariement) reste à valider en navigateur
          (typecheck + test:modules 313 + build verts).

> ### ⏯ REPRISE (état au 5c.25 — DatacenterView COMPLET, raffinements TOUS portés — nouvelle conversation)
> **Vert partout** : `npm run typecheck` (clean) · `npm run test:modules` (**313/313**) · `npm run build` (OK).
> **RAFFINEMENTS (5c.25) FAITS** : flip 2D « réf. en bas » (`floorXf`/`uprightTexts`) · rail d'étages + ancrage déplaçable ·
> menu contextuel plan d'étage 3D · multi-U Ctrl+clic (`slotSel`) · **undo image dans la timeline globale** (`noteUndoable`/
> `doUndo`/`doRedo`) · **compagnon `.nmfb` SÉPARÉ** (parité monolithe : `.json` FS sans images + `.nmfb` apparié `facesKey`).
> À VALIDER EN NAVIGATEUR : comportement runtime FS du compagnon (permissions, appariement). RESTE seul : Phase 6 finale
> (retrait du monolithe legacy + recalage du harnais de régression sur les modules).
> **CLIC DROIT** : ports/équipements/baies/waypoints/câbles/**sol** → `ContextMenu` (édition/routage/retrait/sélection/créer waypoint).
> **PORTS** : survol (`.dc-port.hover` via `wirePortNode` `pointer-events:auto`) ; clic libre → `connectPort` (brouillons-candidats / nouveau).
> **ROUTE** : « 🧵 Créer une route » → clic ports+waypoints (+ aperçu jusqu'au curseur) → form câble prérempli.
> **FICHE** : clic équipement (3D/Graph/liste) → `Forms.equipmentDetail` (riche, bouton Modifier). Survol équip 3D OK (`data-occ`+`.hover`).
> **ROUTE** : ports survolables (`wirePortNode`/`.dc-port.hover`) ; « 🧵 Créer une route » → clic ports+waypoints → form câble prérempli (`routeBuild`/`routeCard`/`drawRoutePreview3D`).
> **FS** : `requestFullscreen` natif + `ui/Fullscreen` re-parente les overlays. Contrôles caméra en overlay `.graph-zoom-controls`.
> **NAV** : `groupes` ET `faceimages` sont des SOUS-VUES de l'onglet `equipements` (liens d'en-tête).
> **IMAGES** : sous-système COMPLET — `data/ImageStore` (IndexedDB+miroir+undo), onglet CRUD, picker
> (`Forms.images`/`faceImagePicker`), rendu 3D (`faceImageNode`/`host.faceImageUrl`), bootstrap INLINE
> (`snapshotWithImages` au save · `replaceAllFromLegacy`/`clearAll` au load/new). Différé : compagnon `.nmfb` séparé.
> **DatacenterView** (`src/views/DatacenterView.ts`) est une vue OO autonome `(store, mount, host)` câblée
> dans `main.ts` (onglet Datacenters + sous-onglet Salles). FAIT : caméra orbitale 3D + projection + tri
> peintre, salle + baies (envelope faces near/far, montants, occupants U/side/wall, **portes**, emplacements
> libres), équipements libres, **ports** sur faces, **câbles** intra-salle (spline + offsets conduit) +
> **câbles sortants** (port → exit, « au mur »), **power bolts**, **waypoints** (pins/rails), **noms**
> d'équipement, **coloration** (face/groupe/type),
> **culling** de distance ; **vue Dessus 2D** + glisser-déposer (snap maille) ; **emplacements libres
> cliquables** (U/side/wall/cap → assignation équipement/pin/brosse) ; **panneau latéral** complet
> (Recherche/surlignage, Vue 3D, Équipements→ciblage, Câbles→visibilité par câble, Baies) ; **persistance**
> de l'état de vue par fichier. Contrôles INERTES restants (présents, « à venir ») : images de façade,
> sortie ⊥ des ports, grilles d'étage.
> **PROCHAINS CANDIDATS** (par pertinence) : (1) **retrait du mono-fichier legacy — Phase 6 finale** : le
> monolithe `netmap-v172-*.html` n'est plus la référence de portage ; recaler/retirer le harnais de régression
> legacy (`Tests/run.js` + `npm run test:legacy`, suites `Tests/suites/`) qui tourne encore contre le `.html`,
> puis SUPPRIMER le `.html` + zip d'archives. Le filet modules (`Tests/modules/run.js`, 279) reste la référence.
> (2) raffinements vue Étage (flip « réf. en bas », rail d'étages, ancrage déplaçable) ; (3) menu contextuel du
> plan d'étage 3D multi ; (4) sélection multi-U au Ctrl+clic ; (5) compagnon `.nmfb` séparé ; (6) undo image global.
> NB : tout le DatacenterView interactif est porté (3D/Dessus/Étage/multi-salles/images/route builder/menus).
> Helpers déjà portés et réutilisables : `FloorLayout` (multiLayout/roomToWorld/levelZ/oobWorld), `Store.cableRoute`/
> `cableWaypointsIn`/`waypointIsPlaced`, `Resolver3D` (resolvePort3D/waypoint/conduit), `RackScene`,
> `RackGeometry`, `Box.faces`, `Painter.farFirst`.
- [x] **Bibliothèque d'images de façade** (sous-système à part — COMPLÈTE, modèle inline ; compagnon `.nmfb` différé) :
  - [x] **5d.1 — `data/ImageStore` (cœur).** Réplique OO du `imageStore` : IndexedDB DÉDIÉE (`netmap-images`,
        store « images », keyPath id) ; **miroir mémoire synchrone** (id → métadonnées + objectURL) pour l'UI ;
        **pile d'undo/redo DISTINCTE** (`onUndoable` injecté) ; CRUD `add/update/remove` (Blob), `list/get/has/
        count`, `ready()` (peuple le miroir), `replaceAll`/`clearAll`/`keepOnly` ; **legacy** `replaceAllFromLegacy`/
        `loadMirrorFromLegacy`/`toLegacyArray` (data-URL ↔ Blob) ; **fichier compagnon `.nmfb`** `serializeBundle`/
        `loadBundle` + statiques PURS `buildBundle`/`parseBundle` (entête NMFB + manifeste JSON + blobs concaténés) +
        `dataUrlToBlob`/`blobToDataUrl` ; `lastLoadedKey` (persistée localStorage). Base IndexedDB SÉPARÉE du
        `HandleStore` (pas de coordination de version). Tests purs (dataUrl↔Blob, round-trip .nmfb) → 274/274.
  - [x] **5d.2 — onglet « Images de façade » (sous-vue d'Équipements) + réorg nav.** `imageStore` instancié
        dans `main.ts` (`onDirty` → dirty/refreshChrome/refreshActive) + `ready()` au boot. `ListConfigs.faceImages`
        (aperçu vignette `<img>`, nom, U, face [filtre front/rear/autre], usages `store.faceImageUsageCount`,
        description ; source `items: () => imageStore.list()`). `Forms.faceImage` (import/remplacement de fichier
        PNG/JPEG/WebP via `promptImageFile`/`validImageFile`, aperçu, U/face/description ; add/update sur
        `imageStore` ; avertissement si remplacement d'une image partagée). Onglet **`faceimages`** câblé en
        **SECONDAIRE sous `equipements`** (câblage dédié, hors `addListTab` car CRUD via `imageStore` : edit/clone
        [copie du Blob via fetch]/suppression [garde-fou usages]). **Réorganisation** : `groupes` passe AUSSI en
        sous-vue d'`equipements` (comme Réseaux sous Câbles) ; `equipements.links = ["groupes", "faceimages"]`.
        `ImageStore._norm` corrigé pour préserver la face « autre ». Tests purs inchangés → 274/274.
  - [x] **5d.3 — picker + attache d'image par face.** `Forms.images` (singleton ImageStore injecté au boot).
        `Forms.faceImagePicker(store, u, face, current)` : dialogue de tuiles (vignettes) des images ÉLIGIBLES
        (`eligibleImages` : face annexe → « autre » sans filtre U ; front/rear → même U + même face), image
        courante toujours visible (jamais de perte de réf.), recherche nom/description, « Aucune », import inline
        « + Importer » (→ `imageStore.add`). Intégré à `faceEditor` : bouton **« Attacher/Changer l'image… »** +
        **aperçu** de l'image en fond de stage (`face-bg`) + détache (déjà présent) ; `fids[face]` persisté dans
        `equipment.face_image_*_id` (déjà câblé). Tests purs inchangés → 274/274.
  - [x] **5d.4 — rendu 3D des images sur les faces.** `faceImageNode(TL, TR, BL, href, proj)` : `<image>` unité
        1×1 étirée sur 3 coins MONDE via matrice affine (`matrix(a b c d e f)`). Intégré aux **occupants U**
        (`rackInterior3D` : faces y0/y1 taguées `plane`, href via `host.faceImageUrl(eqId, side)` — avant/arrière
        selon le montage ; face arrière mirrorée) ET aux **équipements libres** (`freeEquipBoxAt` : 6 faces taguées
        front/rear/top/bottom/left/right via `FreeEquipGeometry.faceLocal` ; annexes = images « autre »). Toggle
        « Afficher les images de façade » (`showFaceImages`) désormais **actif**. Découplage : nouveau callback
        host `faceImageUrl` (câblé `main.ts` → `imageStore.get(eq.face_image_*_id).url`). Tests inchangés → 274/274.
  - [x] **5d.5 — bootstrap (cycle de vie fichier).** Le document est rendu **AUTONOME** : les images de façade
        (hors modèle, IndexedDB) sont embarquées **inline** dans le `.json` au save (`snapshotWithImages` =
        `store.toJSON()` + `faceImages: imageStore.toLegacyArray()`) — chemin FS (`writeToHandle`, donc save /
        save-as / **auto-save**) ET download. Au **chargement** (`loadFromText`) : `faceImages` présent →
        `imageStore.replaceAllFromLegacy` (couvre nos docs + legacy ≤ v51) ; absent → `clearAll` (zéro fuite
        inter-documents). **Nouveau document** → `imageStore.clearAll()`. Migre/round-trip sans perte ;
        l'undo image reste géré par `ImageStore` (pile dédiée). **DIFFÉRÉ (optimisation, non bloquant)** : le
        compagnon `.nmfb` SÉPARÉ (handle FS dédié, appariement `facesKey`/`lastLoadedKey`, rechargement auto au
        welcome) — `ImageStore.serializeBundle`/`loadBundle`/`buildBundle`/`parseBundle` sont prêts pour ce jour.
  > **BIBLIOTHÈQUE D'IMAGES DE FAÇADE — COMPLÈTE** (modèle inline). Reste optionnel : compagnon `.nmfb` séparé.
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
  - [x] **Chrome complet (fidèle au monolithe)** : `app/Shell` reconstruit la **topbar**
        (logo SVG + marque + nom de document éditable + onglets principaux `.tab` + actions
        FICHIER : nouveau / ouvrir / enregistrer / copie / annuler / rétablir + menu Réglages),
        la **barre de statut** (état save · fichier · release · source · nb d'entités · dernière
        save) et, pour CHAQUE vue, son `.view-header` (titre ▸ + sous-titre + actions). Les
        **sous-vues ne sont plus un bandeau** : elles vivent dans l'en-tête de leur domaine
        (liens `Réseaux/Types de port/…/Faisceaux` sous Câbles ; `Adresses IP/Plages DHCP`
        sous IPAM ; bouton « ← retour » sur les sous-vues). Onglets/badges/headers reconstruits
        en `build()` (indépendant de l'ordre). `addView` rend le **corps** (`.view-body`),
        la mise en page reste pilotée par `netmap.css`.
  - [x] **Bootstrap fichier / global** : `main.ts` câble le `ShellHost` au `Store`.
        **Préférences globales** `core/Prefs` (localStorage, hors document) : thème · source de
        données · auto-save + fréquence (8 tests). **Fichier** : ouvrir / enregistrer / copie via
        **File System Access API** quand dispo (handle conservé, écriture silencieuse), repli
        download/upload sinon ; nouveau document (confirm), annuler/rétablir (boutons grisés),
        renommage (`persistMeta`), suivi `dirty` + pastille d'état (`mem`/`clean`/`dirty`/`dirty-on`).
        **Auto-save** : timer périodique écrivant sur le fichier lié quand `dirty` (permission
        re-vérifiée) ; activation guidée (lie un fichier au besoin). **Réglages** : source de
        données (Local / API désactivé), auto-save (toggle + fréquence + ligne d'état), thème,
        reset prefs 3D. **Verrou d'ouverture exclusive** `app/TabChannel` (BroadcastChannel) :
        `meta.fileId` durable, claim/claimed/bye, refus d'ouvrir un fichier déjà édité ailleurs,
        libération à la fermeture/au remplacement. Harnais → 199/199.
  - [x] **Écran d'accueil + réouverture** : au (re)chargement le handle FS est perdu → le Shell
        affiche un `welcome-screen` qui FORCE une ré-interaction pour raccrocher le fichier
        (et relancer l'auto-save). `app/HandleStore` (IndexedDB, ouverture sans version) mémorise
        le dernier fichier ; bouton « Rouvrir « nom » » → `HandleStore.ensureReadPermission` (geste
        utilisateur) → `getFile` → `loadFromText` (revendique le `fileId`, raccroche le handle).
        Boutons « Ouvrir » / « Nouveau » + « Continuer sans fichier » (si session restaurée).
        Fichier introuvable (`NotFoundError`) → oubli du handle. Harnais → 199/199.
  - [x] **Document de démo retiré** : plus d'auto-seed au boot — l'app démarre sur un document
        propre (vide hors catalogues) derrière l'écran d'accueil ; helper `hasUserData()` pour la
        garde « Nouveau ». **Shell/bootstrap COMPLET** (hors retrait du monolithe, ci-dessous).
  - [ ] Retrait du mono-fichier legacy : VRAI dernier pas — le monolithe reste la RÉFÉRENCE de
        portage de `DatacenterView` et la cible du harnais de régression legacy. À supprimer
        une fois `DatacenterView` portée et la régression recalée sur les modules.
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
