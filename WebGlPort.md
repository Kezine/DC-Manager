# Portage WebGL de la vue 3D Datacenter — état d'avancement

> Document de passation. Le but : porter la vue 3D du datacenter du rendu **SVG** vers un rendu
> **WebGL (Three.js)** parallèle, derrière un toggle « ⚡ WebGL » de la barre d'outils, en réutilisant
> la couche géométrie déjà extraite (engine-agnostic). Le SVG reste le moteur par défaut.

## Décisions structurantes

- **Renderer PARALLÈLE** (pas de remplacement) : SVG reste le défaut, WebGL en option. Export SVG,
  HTML single-file et theming CSS préservés.
- **Three.js v0.160.0** + `@types/three`. Build single-file via webpack + `html-inline-script-webpack-plugin`.
- **Import dynamique `webpackMode: "eager"`** pour charger le moteur WebGL : garde le single-file ET
  évite l'erreur `ERR_REQUIRE_ESM` dans `test:modules` (Line2 est ESM-only, la chaîne de tests est CJS).
- **Render-on-demand** (pas de RAF perpétuel) ; rebuilds partiels via sous-groupes
  (`gDecor`/`gRacks`/`gFree`/`gWaypoints`/`cablesGroup`/`gExtra`/`gFloorDecor`) ; delta multi-salle
  incrémental (`applyRoomDelta`).
- **Picking par raycasting** ; câbles en **Line2/LineMaterial** (fat lines, épaisseur constante en px écran) ;
  billboards/pastilles **constants à l'écran** via rescale par frame (`_screenObjs`/`updateScreenScales`).
- Couche géométrie partagée SVG+WebGL : `src/geometry/CableRouting.ts` (routing engine-agnostic).

## Architecture des fichiers (chaîne d'héritage, un seul `this` au runtime)

- **SVG** : `DcBase → DcCamera → DcScene3D → DcViews2D → DcPanels → DcInteract → DatacenterView`.
- **WebGL** : `DcThreeBase → DcThreeCamera → DcThreeScene`.
- Appels cross-couches via interfaces fusionnées `export interface X { [key:string]: any }`.

### `src/views/dc/three/DcThreeBase.ts`
State, lifecycle (mount/dispose/render-on-demand), thème (readTheme/parseColor), helpers texture
(textTexture/diamondTexture/circleTexture/boltTexture, cache `texCache` ; textures d'images de face
`ownTex` libérées au rebuild), faceImagePlane (TextureLoader async + garde `_epoch`), faceLabel,
gridLines, localBox. Exporte les types (DcThreeOptions, ExtraCable avec `power?`, FloorDecor, SceneCtx,
RoomDesc, Theme). Champs callbacks remontés à la VUE :
```ts
tipCb: ((desc, x, y) => void) | null = null;   // tooltips
ctxCb: ((desc, x, y) => void) | null = null;   // menus contextuels
protected _navMovedR = false;                  // un glisser DROIT (orbite) → ne pas ouvrir le menu
```

### `src/views/dc/three/DcThreeCamera.ts`
Caméra (frame/recenter/setPreset/zoomBy/setProjection/updateCamera), interaction
(bindEvents/onMove/onUp/onHover), picking (rayHits/pick/setHover/applyHover/clearHover),
updateScreenScales, setMarkerScale/setCullDistance/targetAt.
- `targetAt(x,y)` : résout la cible TOOLTIP/MENU (même priorité qu'au clic : précis > câble si au-dessus
  > occupant > baie en repli).
- `frontFacing(h)` : vrai si la face touchée pointe vers la caméra — filtre les faces ARRIÈRE des
  capots/coques `DoubleSide` pour ne pas attraper la baie « depuis l'intérieur ».
- contextmenu : `preventDefault`, garde `_navMovedR` (orbite), `targetAt` → `ctxCb`.

### `src/views/dc/three/DcThreeScene.ts`
Couche scène finale (build/applyOptionsDiff/rooms/rackGroup/occColor/slot*/buildCapPlate/buildBrush/
buildFreeEquip/buildWaypoints/addMarker/cables/buildFloorDecor/emitCableTube/setCablesOnTop/
setCableSpline/cableColor/cableIsPower). Constantes : CABLE_PX=1, CABLE_OPACITY=0.5, CABLE_PX_SEL=2.5,
MARK_PX=9, OOB_PX=11, DOT_PX=5, BOLT_PX=3.25. Capots = grille de cellules (cellules-trou omises) ;
brosse = coque creuse avec tunnel.

### `src/views/dc/DcBase.ts`
Possède `_three`. `renderWebGL` (import dynamique eager), `webglOptions()`, `webglCtx()` (multi-salle :
centroïde dynamique, extraCables via routing, floorDecor). Handlers tooltip/menu WebGL :
`webglTip`/`webglTipHtml`/`webglContextMenu`/`webglCtxSections` (+ `_webglTipId`) — réutilisent les
builders SVG de `DcInteract`. Câblage des callbacks à la création de `_three`.

## ✅ Fait (parité atteinte)

- Scène complète : baies (coque, capots troués, slots U/latéraux/muraux/capot), occupants (équipements,
  items, brosses de brassage), équipements libres, waypoints (+ OOB), marqueurs, étiquettes, décor d'étage.
- Câbles : Line2 fat-lines, splines cardinales alignées sur le SVG (CableRouting partagé), pastilles de
  terminaison 2D, power bolts, toggle `cablesOnTop`.
- Caméra : perspective/orthographique, framing, presets, multi-salle (centroïde dynamique).
- Perf : render-on-demand, rebuilds partiels par sous-groupes, cache textures, delta multi-salle,
  setters in-place (cablesOnTop/markerScale/cullDistance/cableSplineK sans rebuild).
- Picking : priorité câble (proximité latérale) > précis > occupant > baie ; capots masqués transparents
  au clic via priorité ; baie cliquable par ses faces extérieures uniquement (`frontFacing`).
- Panneau de contrôles 3D (`DcPanels.view3dOptionsCard`) regroupé par thèmes, toggle `cablesOnTop` (icône).
- **Tooltips + menus contextuels** (clic droit) : remontés du moteur à la vue via `tipCb`/`ctxCb`,
  réutilisent les builders SVG (rack/equipment/cable/wp/port/item). Bugs corrigés :
  - mousedown DROIT ne `preventDefault` plus → l'event `contextmenu` se déclenche.
  - coque de nouveau cliquable (repli basse priorité) au lieu de raycast désactivé.
  - filtre `frontFacing` → la baie n'est plus attrapée « depuis l'intérieur ».
  - `webglContextMenu` appelle `ContextMenu.show` EN DIRECT (plus via `ctxMenu`, qui appelait `e.stopPropagation()`
    sur un faux event sans cette méthode → exception → aucun menu nulle part). La garde anti-orbite reste `_navMovedR`.
  - capot/paroi OPAQUE capture désormais survol/clic/menu : helper `rackSolid(h)` (matériau de la face touchée)
    → une face de baie opaque (plaque de capot, paroi ±X de la coque) OCCLUT l'occupant derrière (gagne à sa
    profondeur), tandis que la coque/porte translucide reste en repli (clic-through). `onHover` gère enfin `rack`.
- **Capot centré** : `RackGeometry.capGrid` renvoie `mx`/`my` (marge égale de chaque côté) → trous symétriques ;
  la marge (hors grille, non perçable) reste couverte. WebGL : cellules centrées + 4 bandes de bord pleines ;
  SVG : trous décalés de `(mx,my)`. Propagé à `capCellLocalCenter` (pins) + slots libres SVG/WebGL.
- **Sortie ⊥ des ports** (toggle « Sortie ⊥ ») désormais portée : le tracé intra-salle réutilise la couche
  partagée `CableRouting.cableLine(a,b,via, cablePortNormal)` (au lieu d'une réplique sans amorces). `cardinalSample`
  gère `stubAt` (tangente G1 imposée = axe du segment droit adjacent, comme `cablePath` du SVG). `cablePortNormal`
  ajouté à `DcThreeOptions` + `webglOptions` + déclencheur `cb` d'`applyOptionsDiff` ; `stubAt` propagé aux câbles
  extra (inter-DC / stubs sortants) via `webglCtx`. Le moteur WebGL possède son `CableRouting` (`this.routing`).

## ⏳ Reste à faire

- **Route builder interactif** en WebGL (les entrées de menu « démarrer/terminer une route » posent
  l'état `routeBuild` mais l'interaction de routage au clic n'est pas portée).
- **Images sur équipements libres** (6 faces) — non portées.
- Tooltip de baie au survol d'une zone vide (optionnel : la baie n'est pas dans la liste de survol
  `onHover`, seulement clic/clic-droit).

## Portes qualité (toutes vertes au dernier passage)

```
Set-Location "c:\Users\Kezine\Nextcloud\Job\sso\Claudi\NetMap"
npm run typecheck      # tsc --noEmit — clean
npm run test:modules   # 337 PASS, 0 FAIL
npm run build          # webpack single-file → dist/netmap.html — compiled successfully
```

- Node v19.9.0. Le tool PowerShell doit `Set-Location` dans `…/NetMap` d'abord.
- Test manuel : recharger `dist/netmap.html`, basculer **⚡ WebGL**.
