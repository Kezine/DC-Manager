# Optimisations de performance — vue Datacenter WebGL

> Notes d'optimisation pour le moteur 3D WebGL (`src-client/views/dc/three/`). Ce qui est **fait** sert de
> contexte ; la section **À faire** consigne des idées non encore implémentées (à ne PAS coder sans demande).

## ✅ Fait

- **TOUS les toggles d'affichage/masquage = bascule de visibilité** (aucune reconstruction). Chaque mesh basculable
  est tagué `userData.layer` (`port`/`name`/`door`/`doorswing`/`slot`/`faceImage`/`conduit`/`marker`/`rail`/
  `floorgrid`/`orient`/`rackshell`), `userData.eqSide` (`front`/`rear`) et/ou `userData.rackId` (masquage de baie).
  `applyLayerVisibility()` parcourt `gRacks`/`gFree`/`gWaypoints`/`gFloorDecor` et fixe `.visible` via
  `layerVisible(userData)`. Le picking (`rayHits`) ignore les meshes masqués (three ne le fait pas tout seul). Tout
  est **construit en permanence** → toggle instantané. Plus aucun `eqRebuild` dans `applyOptionsDiff`.
  - **`showRackSides`** : coque OPAQUE + capots toujours construits, couche `rackshell` (masquage = on voit dedans,
    pas de box translucide ; les arêtes restent). Les trous de capot (toit + sol) sont en couche `slot` → pilotés par
    le seul toggle « emplacements libres », indépendamment de l'affichage des capots.
  - **`hidden3dRacks`** (masquage de baie) : couche `rackId` — le groupe de baie (et ses ports, hors groupe) bascule
    en visibilité. Le moteur WebGL construit TOUTES les baies (le filtrage est en visibilité, pas au build).
  - **`colorMode`** : recoloration **en place** (`applyColorMode`), pas de rebuild.
  - `applyOptionsDiff` route : `eqRebuild` (= showRackSides) → `rebuildRacks/Free` ; `eqVis` → `applyLayerVisibility` ;
    `eqColor` → `applyColorMode` ; `cb` → `rebuildCables`.
- **Câbles** : toggle de visibilité (`selCables`/`showAllCables`) via `rerenderView()` (diff `rebuildCables`, pas de
  full `render()`). `webglOptions().selCables` est une COPIE (sinon le diff ne détecte pas le changement).
- **Retour de vue sans changement de données** : repère `_webglRev = store.histIndex()`. Dans `DcBase.render()`,
  si le canvas est attaché ET `histIndex()` inchangé → chemin diff (`renderThreeD`/`applyOptionsDiff`, souvent
  no-op) au lieu de `renderWebGL → mount → build()`. Sinon (1er rendu, canvas détaché par sous-vue, données
  modifiées) → (re)build.
- **Moteur préservé entre vues** : `render()` ne `dispose()` le moteur Three QUE si on bascule sur la 3D LEGACY
  (SVG). L'hôte WebGL est **persistant et conservé ATTACHÉ** (exclu de `clearStage`) : en 2D (Dessus/Étage) il est
  juste **masqué** (`display:none`), pas détaché. Au retour en 3D, comme il est toujours attaché, la garde de
  révision (`_webglRev`) prend le chemin diff (no-op si données inchangées) → **aucune reconstruction**. (Avant : le
  canvas était détaché → `mount→build` complet au retour = re-dessin de toute la scène multi-salles.)
- **Cache de textures d'images de façade** (`imgTexCache`, par URL) : réutilisées synchroniquement d'un build à
  l'autre (plus de rechargement TextureLoader à chaque reconstruction), élaguées après chaque build COMPLET
  (`pruneFaceTextureCache` : toute URL non reposée par ce build est libérée) + libération au `dispose` final.
- **Réglages en place sans rebuild** : `setCablesOnTop`, `setMarkerScale`, `setCullDistance`, `setCableSpline`.
- **Picking restreint aux CIBLES utiles + throttle rAF** (`rayHits`/`onHover`) : le survol n'intersecte plus toute
  la scène (les arêtes `EdgesGeometry` se testent segment PAR segment, pure perte : tous les consommateurs ne
  lisent que `userData.pick`) mais une collecte élaguée par visibilité des seuls objets pickables ; et `mousemove`
  (>100 Hz possible) est résolu au plus UNE fois par frame (rAF). L'outil mesure garde l'accrochage à TOUTE
  surface via `rayHits(x, y, false)`.
- **Éviction LRU des textures d'étiquettes** (`texCache`, `pruneLabelTextureCache`, plafond 256) : chaque libellé
  distinct (noms, U, cotes de mesure) créait une CanvasTexture GPU conservée à vie, y compris après changement de
  document. Les textures mutualisées (clés « ##… ») sont permanentes.
- **Overlay outil scindé statique/dynamique** (`_toolSig` + `ensureToolCursor`/`updateToolCursor`) : au survol en
  mode mesure/route, seuls le segment pointillé et la pastille du curseur sont MUTÉS en place — l'overlay complet
  (polylignes, étiquettes, pastilles posées + `collectScreenObjs`) n'est reconstruit qu'aux changements
  STRUCTURELS (point posé, mesure terminée/supprimée, surbrillance).
- **Emplacements libres FUSIONNÉS en bandes** : un mesh par U / rangée latérale mettait les iGPU à genoux dès
  quelques baies vides (~3 200 plans transparents + cadres + étiquettes pour 7 baies 42U à latéraux av+ar →
  ~250 après fusion). Les emplacements CONTIGUS forment UN seul mesh (`slotU` par bande de U, `slotSide`/
  `slotWall` par couloir de colonne) ; le U / uTop précis est recalculé AU CLIC depuis le point d'impact
  (`DcThreeCamera.slotRowFromHit`, coordonnées locales du plan). Étiquettes « U n » aux extrémités de bande
  seulement. La sélection multi-U au glisser surligne la plage via un PLAN dédié enfant de la bande
  (`applySlotSel`), muté en place.

## ⏳ À faire (consigné, NON implémenté)

### Rebuild INCRÉMENTAL par baie (et par catégorie d'entité)

**Problème** : une édition de données (équipement, câble, baie…) déclenche `store.onChange → refreshActive →
render()`. Comme `histIndex()` change, on fait un **build complet** de la scène (toutes les baies, occupants,
etc.). Sur une grosse config c'est ~1–2 s, alors qu'une seule baie a souvent changé.

**Idée** : reconstruire UNIQUEMENT ce qui a changé, pas toute la scène.

- Le store émet déjà sur chaque mutation, mais SANS dire QUOI a changé. Piste : enrichir `store.onChange` (ou un
  nouveau canal) pour transmettre `{ collection, id }` (ou un ensemble d'IDs touchés) du delta.
- Côté moteur, indexer les sous-groupes par entité : p.ex. tagger le groupe d'une baie `userData.rackId` (déjà
  le cas pour les salles via `dcId`). Sur delta :
  - équipement/rackItem/brosse/port modifié → retrouver sa `rack_id`, **disposer + reconstruire le seul groupe de
    cette baie** (`rackGroup(r)`) au lieu de `rebuildRacks()` (toutes les baies).
  - câble modifié → ne ré-émettre que ce câble (la couche câbles est déjà séparée ; un rebuild ciblé d'un seul
    tube est faisable).
  - équipement libre / waypoint / décor → idem, rebuild ciblé de l'élément.
- Repère de révision plus fin que `histIndex()` global : signature par baie (hash des occupants/dimensions) pour
  ne rebâtir que les baies réellement modifiées ; ou s'appuyer sur le delta d'IDs ci-dessus.
- Garder le repli : si le delta n'est pas exploitable (changement global : salle, options structurelles), full
  build comme aujourd'hui.

**Gain attendu** : édition d'un équipement → reconstruction d'une seule baie (quelques ms) au lieu de toute la
salle. Supprime le ~1–2 s ressenti après une édition + retour de vue.

**Risque/coût** : moyen-élevé. Touche le contrat `store.onChange` (delta d'IDs) et la gestion fine du cycle de vie
des sous-groupes/géométries. À faire seulement sur demande explicite.

### Autres pistes mineures

- Couches lourdes optionnelles (images de façade, nombreux emplacements) : build paresseux si réellement un
  problème de coût au 1er build (aujourd'hui tout est construit d'emblée pour des toggles instantanés).
- Réutiliser les géométries identiques (instancing / géométries partagées) pour occupants/emplacements
  répétitifs si le nombre de meshes devient un goulot.
