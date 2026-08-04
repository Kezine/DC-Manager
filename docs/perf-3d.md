# Optimisations de performance — vue Datacenter WebGL

> Notes d'optimisation pour le moteur 3D WebGL (`src-client/views/dc/three/`). Ce qui est **fait** sert de
> contexte ; la section **À faire** consigne des idées non encore implémentées (à ne PAS coder sans demande).

## ✅ Fait

- **TOUS les toggles d'affichage/masquage = bascule de visibilité** (aucune reconstruction). Chaque mesh basculable
  est tagué `userData.layer` (`port`/`name`/`door`/`doorswing`/`slot`/`faceImage`/`conduit`/`marker`/`rail`/
  `floorgrid`/`orient`/`rackshell`/`racklabel`), `userData.eqSide` (`front`/`rear`) et/ou `userData.rackId` (masquage de baie).
  `applyLayerVisibility()` parcourt `gRacks`/`gFree`/`gWaypoints`/`gFloorDecor` et fixe `.visible` via
  `layerVisible(userData)`. Le picking (`rayHits`) ignore les meshes masqués (three ne le fait pas tout seul). Tout
  est **construit en permanence** → toggle instantané. Plus aucun `eqRebuild` dans `applyOptionsDiff`.
  - **`showRackSides`** : coque OPAQUE + capots toujours construits, couche `rackshell` (masquage = on voit dedans,
    pas de box translucide ; les arêtes restent). Les trous de capot (toit + sol) sont en couche `slot` → pilotés par
    le seul toggle « emplacements libres », indépendamment de l'affichage des capots.
  - **`showRackNames`** : nom de la baie (`rack.name`) posé À PLAT sur le flanc gauche (−X), le flanc droit (+X) et le
    toit (+Z), translucide et 1 mm en saillie (matériau partagé `labelMaterial` + `LABEL_STANDOFF_MM`). Couche
    `racklabel` (toggle dédié, activé par défaut). Géométrie PURE déléguée à `RackLabelLayout` (position/rotation/taille
    par face, rotations PROPRES non miroir, testable en Node sans THREE). RIEN sur une baie SANS capots
    (`has_caps === false` : pas de surface réelle). Couche INDÉPENDANTE de `rackshell` — masquer les flancs tout en
    gardant les noms les laisse « flotter » là où étaient les panneaux (accepté). Le tag `rackId` masque aussi le nom
    quand la baie est masquée individuellement.
  - **`hidden3dRacks`** (masquage de baie) : couche `rackId` — le groupe de baie (et ses ports, hors groupe) bascule
    en visibilité. Le moteur WebGL construit TOUTES les baies (le filtrage est en visibilité, pas au build).
  - **`showFaceImages`** : DEUX mécanismes selon le chemin de rendu, même geste instantané. Montés en U : images =
    PLANS séparés (couche `faceImage`) → visibilité classique. Boîtes 6 faces (`buildEquipBox` — libre en salle,
    étage, étagère, marge, paroi) : l'image est un **MATÉRIAU** de la BoxGeometry, rien à masquer — chaque boîte à
    image porte donc DEUX jeux de matériaux (`userData.faceImageSwap` : `avec` images / `sans` corps coloré ; les
    faces sans image PARTAGENT la même instance) et `applyLayerVisibility` **ÉCHANGE le jeu actif**. La décision
    (jeu actif + repère d'orientation) vit dans `FaceImagePolicy` (module PUR, testé en Node — même démarche que
    `SceneLayoutSignature`). Le jeu « avec » garde ses textures même débranché (le chargement async y aboutit hors
    écran ; cache `imgTexCache` inchangé) ; `applyColorMode` recolore les DEUX jeux (sinon le jeu débranché
    réafficherait l'ancien mode couleur) ; `disposeObjectResources` (DcThreeBase) libère AUSSI le jeu débranché
    (sinon fuite GPU à chaque reconstruction). Le REPÈRE D'ORIENTATION (4 arêtes accent de la face avant) est
    désormais TOUJOURS construit : visible si `showOrientMarks` ET (pas d'image avant OU images masquées) — sans
    cette règle, une boîte à image avant perdrait TOUT repère quand la bascule masque son image
    (tag `frontImageAsMarker`, arbitré par `layerVisible`).
  - **`colorMode`** : recoloration **en place** (`applyColorMode`), pas de rebuild.
  - `applyOptionsDiff` route : `eqRebuild` (= showRackSides) → `rebuildRacks/Free` ; `eqVis` → `applyLayerVisibility` ;
    `eqColor` → `applyColorMode` ; `cb` → `rebuildCables`.
- **Câbles** : toggle de visibilité (`selCables`/`showAllCables`) via `rerenderView()` (diff `rebuildCables`, pas de
  full `render()`). `webglOptions().selCables` est une COPIE (sinon le diff ne détecte pas le changement).
- **Diff STRUCTUREL fondé sur une SIGNATURE DE DISPOSITION** (`SceneLayoutSignature` — module PUR, testé en Node ;
  `applyOptionsDiff` l'appelle et n'arbitre plus lui-même). La décision reposait sur une clé ne portant que
  l'ENSEMBLE des identifiants de salles (`"M:dc-a,dc-b"`) : tout ce qui DÉPLACE la géométrie sans changer cet
  ensemble était invisible au diff — la nouvelle disposition était mémorisée (`multiInfo`/`floorDecor` réaffectés)
  mais jamais appliquée au graphe de scène, d'où des réglages qui ne prenaient effet qu'au RECHARGEMENT de la page
  (curseur d'échelle inter-sites, bascule linéaire/logarithmique, bascule « Vue étage » quand la portée affichée ne
  change pas — le cas d'un document mono-salle ou d'une portée réduite à la salle active). La signature couvre
  désormais la disposition ENTIÈRE : origine/orientation/emprise/vide technique de chaque salle **et** décor d'étage
  (plans + cellules bloquées, OOB, équipements d'étage, étiquettes d'étage — une par plan dessiné — et de
  bâtiment). Trois
  issues : `keep` (rien n'a bougé — le diff d'options suit son cours), `roomDelta` (l'ENSEMBLE des salles change →
  chemin incrémental inchangé), `rebuild`. Conformément à la note « Rendu 3D » de `CLAUDE.md`, on préfère une
  reconstruction inutile à un mesh périmé. ⚠ **La STABILITÉ de la signature est aussi critique que sa sensibilité** :
  chaque rendu recalcule le contexte (objets neufs), donc une signature instable reconstruirait la scène à chaque
  événement d'affichage. Elle ne dépend que des VALEURS reçues (aucune horloge, aucun compteur, aucune identité
  d'objet) et l'ordre des collections — déjà déterministe dans `FloorLayout.multiLayout` — n'est pas re-trié.
  Coût mesuré : ~0,02 ms pour 4 salles (470 caractères), contre ~1,1 ms pour le `webglCtx()` qui la précède.
- **Retour de vue sans changement de données** : repère `_webglRev = store.histIndex()`. Dans `DcBase.render()`,
  si le canvas est attaché ET `histIndex()` inchangé → chemin diff (`renderThreeD`/`applyOptionsDiff`, souvent
  no-op) au lieu de `renderWebGL → mount → build()`. Sinon (1er rendu, canvas détaché par sous-vue, données
  modifiées) → (re)build.
- **Moteur préservé entre vues** : `render()` ne `dispose()` le moteur Three QUE si on bascule sur la 3D LEGACY
  (SVG). L'hôte WebGL est **persistant et conservé ATTACHÉ** (exclu de `clearStage`) : en 2D (Dessus/Étage) il est
  juste **masqué** (`display:none`), pas détaché. Au retour en 3D, comme il est toujours attaché, la garde de
  révision (`_webglRev`) prend le chemin diff (no-op si données inchangées) → **aucune reconstruction**. (Avant : le
  canvas était détaché → `mount→build` complet au retour = re-dessin de toute la scène multi-salles.)
  - **La VISIBILITÉ de cet hôte est une DÉCISION PURE** (`core/WebglHostVisibility.visible(view, useWebGL, hasRoom)`) :
    visible si, et seulement si, on est en 3D-WebGL **AVEC une salle à montrer**. La condition « salle » n'est pas
    cosmétique : sans elle, charger un document SANS SALLE en vue 3D laissait affiché le canevas — donc la scène — du
    document PRÉCÉDENT sous le message « Aucune salle » (deux lignes de `render()` décidaient chacune de leur côté et se
    contredisaient — dette n°7, corrigée). L'hôte reste masqué sans être détaché, donc le moteur reste chaud. Extraire
    la règle d'un `render()` non atteignable en test (garde headless `typeof document === "undefined"`) la rend
    VERROUILLABLE — table de vérité éprouvée dans `test-core-store.js`.
- **Cache de textures d'images de façade** (`imgTexCache`, par URL) : réutilisées synchroniquement d'un build à
  l'autre (plus de rechargement TextureLoader à chaque reconstruction), élaguées après chaque build COMPLET
  (`pruneFaceTextureCache` : toute URL non reposée par ce build est libérée) + libération au `dispose` final.
- **Réglages en place sans rebuild** : `setCablesOnTop`, `setMarkerScale`, `setCullDistance`, `setCableSpline`,
  `setCableCurveStyle` (le STYLE de tracé — spline uniforme / centripète / cordes arrondies — ne reconstruit que
  les câbles, coalescé rAF comme la tension). NB perf : le style « cordes arrondies » (défaut) échantillonne
  BEAUCOUP moins de points que les splines (les droites ne coûtent que leurs extrémités, ~1 pt / 5 mm sur les
  seuls congés — cf. `geometry/CableSpline.sampleFillet`) → rebuild des câbles moins cher.
- **Picking restreint aux CIBLES utiles + throttle rAF** (`rayHits`/`onHover`) : le survol n'intersecte plus toute
  la scène (les arêtes `EdgesGeometry` se testent segment PAR segment, pure perte : tous les consommateurs ne
  lisent que `userData.pick`) mais une collecte élaguée par visibilité des seuls objets pickables ; et `mousemove`
  (>100 Hz possible) est résolu au plus UNE fois par frame (rAF). L'outil mesure garde l'accrochage à TOUTE
  surface via `rayHits(x, y, false)`.
- **Éviction LRU des textures d'étiquettes** (`texCache`, `pruneLabelTextureCache`, plafond 256) : chaque libellé
  distinct (noms, U, cotes de mesure) créait une CanvasTexture GPU conservée à vie, y compris après changement de
  document. Les textures mutualisées (clés « ##… ») sont permanentes.
- **Labels à plat TRANSLUCIDES et EN SAILLIE** (`DcThreeBase.faceLabel` + matériau partagé `labelMaterial`, constantes
  `LABEL_OPACITY = 0.85` / `LABEL_STANDOFF_MM = 1`) : un nom d'équipement (plan texte) et son image de façade sont
  strictement coplanaires (même Y/normale) → z-fighting (clignotement selon l'angle). Le label est donc rendu
  translucide (opacité 0,85 → on voit l'image au travers) ET décalé de 1 mm vers l'EXTÉRIEUR le long de la normale de
  sa face (convention maison en mm, cf. ports 1,5 mm / slots 2 mm) : il passe DEVANT l'image, sans z-fighting, texte
  lisible par-dessus. Aucun `polygonOffset` (le décalage est géométrique, en mm monde).
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

- **Pivot d'orbite BORNÉ aux murs virtuels** (`PivotBounds` + `DcThreeCamera.recenterPivotOnView`,
  `pivotAabb` recalculée au build depuis les `RoomDesc`) : le contenu réellement touché au centre de l'écran reste
  prioritaire (pivot inchangé) ; seul le REPLI « sol infini » est borné. Sol DANS l'AABB des salles → gardé ; sol
  HORS mais rayon traversant → point de SORTIE (mur le plus loin) ; rayon qui rate → sol clampé au bord ; ni sol ni
  traversée → pivot non déplacé. Murs traités comme INFINIMENT hauts (bornage purement XY, aucune contrainte Z) —
  corrige le pivot délirant sous un angle rasant (multi-DC/multi-étage surtout). Géométrie PURE testée en Node.
- **Marqueur du pivot LISIBLE SUR LES DEUX THÈMES** (`views/dc/three/PivotMarker`, module PUR — style, tracé
  et clé de cache ; `DcThreeBase.pivotTexture`/`updatePivot` ne font que fournir le canvas et poser le sprite).
  Le marqueur était dessiné dans une couleur EN DUR (`#c8d2e0`, le `--fg` du thème SOMBRE) à `opacity: 0.55` :
  invisible sur fond clair. Il se décline désormais sur le thème — trait de la teinte OPPOSÉE au fond, **halo**
  (liseré de contraste, tracé SOUS le trait en une 1re passe plus épaisse) de la teinte du fond. Le halo est ce
  qui garantit la lisibilité PAR-DESSUS n'importe quel contenu, `depthTest: false` obligeant (baie sombre, sol
  clair, image de façade). Silhouette, taille écran (~46 px) et épaisseur apparente INCHANGÉES ; seule l'opacité
  monte à 0,85. Tous les réglages sont des constantes de `PivotMarker`.
  ⚠ **La clé de cache de la texture DÉPEND du thème** (`##pivot|light` / `##pivot|dark`) : les clés `##…` de
  `texCache` sont PERMANENTES (jamais évincées, cf. `pruneLabelTextureCache`), donc une clé fixe aurait resservi
  à vie la texture du premier thème rencontré. Deux entrées permanentes au maximum. Corollaire :
  `applyThemeChange` rappelle `updatePivot()` — le pivot est un sprite TEXTURÉ, hors des groupes dont il remappe
  les couleurs de matériau.
- **Dalle de PLANCHER TECHNIQUE** (`DcThreeScene.buildUnderfloorSlab`) : si une salle déclare `underfloor_mm > 0`,
  une seconde dalle légèrement BLEUTÉE (couleur de sol du thème mixée vers l'accent) est posée `underfloor_mm` mm
  sous le faux-plancher, matérialisant le vide technique. Même idiome que le sol de salle (plan horizontal dans
  `gDecor`, non interactif, toujours visible) ; la donnée voyage via `RoomDesc.underfloorMm`.

## ⏳ À faire (consigné, NON implémenté)

### REPOSITIONNER au lieu de reconstruire quand seule l'ÉCHELLE inter-sites change

**Problème** : bouger le curseur d'échelle inter-sites (ou basculer linéaire ⇄ logarithmique) déplace la géométrie
sans rien changer d'autre → `rebuild` complet (cf. la signature de disposition ci-dessus). D'où le choix, assumé, de
ne déclencher la reconstruction qu'au RELÂCHEMENT du curseur (`onChange`) et non à chaque cran : un rebuild par cran
figerait l'interface. Le curseur n'est donc **pas utilisable en glissé** — on règle à l'aveugle, on relâche, on
regarde, on recommence.

**Idée** : quand SEULE l'échelle change, TRANSLATER les groupes de salle au lieu de reconstruire la scène.

- Un changement d'échelle est une **translation RIGIDE par bâtiment** — vérifié : `SiteLayout.compress` ne produit
  que l'ORIGINE de chaque site ; dans `FloorLayout.multiLayout`, tout ce qui est INTÉRIEUR au bâtiment
  (`bx + anchor + pos + emprise/2`, `levelZ`, orientation) est inchangé. Vrai en linéaire **comme en
  logarithmique** : le log change de combien chaque bâtiment se déplace, pas le fait que son contenu le suive en
  bloc. Salles, baies, équipements, ports et câbles INTRA-salle gardent toutes leurs cotes.
- Le graphe de scène **s'y prête déjà** : chaque salle est bâtie sous un groupe transformé
  (`DcThreeScene.roomUnder` → `outer.position.set(room.ox, room.oy, room.oz)`), et `updateRoomTransform` sait DÉJÀ
  repositionner en place les groupes d'une salle conservée (il sert au chemin `applyRoomDelta`). Toute la part
  LOURDE d'un rebuild — baies, occupants, ports, textures d'étiquettes, câbles intra-salle — suivrait gratuitement.
- **Deux choses ne suivraient PAS**, et devraient être recalculées :
  - le décor d'étage (`gFloorDecor`) : coordonnées MONDE, mais géométrie plate (plans, grilles, étiquettes) donc
    bon marché à refaire — `rebuildFloorDecor()` existe déjà ;
  - surtout les **câbles/faisceaux TRANSVERSAUX** (`gExtra`) : polylignes en repère monde dont les deux extrémités
    sont dans des bâtiments DIFFÉRENTS, donc **non transformables rigidement** — à recalculer (`buildExtraCables`,
    déjà refait par `applyRoomDelta`).
- Détection : réutiliser `SceneLayoutSignature` en le SCINDANT — une signature « par salle hors origine » (identité,
  orientation, emprise) inchangée + des origines qui ne diffèrent que d'une translation par bâtiment ⇒ chemin
  translation ; sinon `rebuild`. Attention à ne pas ré-ouvrir la porte à la SOUS-invalidation que la signature vient
  de fermer : le repli par défaut doit rester `rebuild`.

**Gain attendu** : rendre le curseur d'échelle utilisable **en glissé** (aperçu continu), au lieu du seul aperçu au
relâchement.

**Ordre de grandeur (mesuré partiellement)** : sur un document 4 salles × 6 baies × 10 équipements (240 équipements,
960 ports, ~2 000 objets THREE), la part MESURABLE en Node d'un rebuild — `webglCtx()` (disposition + routes + décor)
+ les requêtes de données refaites salle par salle (occupants, équipements libres, câbles) — vaut ~1,6 ms. Le terme
DOMINANT est la création/libération des meshes THREE, non mesurable hors navigateur : le dépôt l'instrumente déjà
comme coûteux (overlay de chargement dès `build3DIsHeavy`, « plusieurs centaines de ms sur une grosse salle » dans
`DcBase.renderWebGL`, « ≈ 1 s » dans `rerenderView`, « ~1–2 s » ci-dessous pour une grosse config). C'est ce rapport
— quelques ms de repositionnement contre des centaines de ms de reconstruction — qui justifierait le lot.

**Risque/coût** : moyen. Aucun champ persisté n'est touché ; le risque est l'invalidation (voir ci-dessus) et la
cohérence du cadrage caméra pendant le glissé. À faire seulement sur demande explicite.

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
