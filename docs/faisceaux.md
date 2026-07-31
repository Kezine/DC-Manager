# Faisceaux (trunks) — modèle, contraintes, rendu

> Un **faisceau** (`cableBundles`) est un câble MULTI-FIBRES créé à l'avance entre **deux patch panels**
> (`endpoint_a/b_equipment_id`) : il forme un **pool de brins** que les ports de ces patchs « piochent »
> (`Port.bundle_id` + `strand_a`/`strand_b`) — **source unique** : l'ancien mécanisme « câble-brin »
> (`cables.bundle_id`/`strand_no`) a été RETIRÉ. Le versant **déduction réseau** (arête BRIN, garde-fous
> T4/T6/T7/V6) est décrit dans [`deduction-reseau.md`](deduction-reseau.md). Ce document couvre les
> **contraintes d'extrémité** et le **rendu du tracé** (2D + 3D).

## 1. Contraintes d'extrémité (validation PARTAGÉE)

Imposées dans `src-shared/DataValidation.ts` (spec `cableBundles`) — donc au **Store** (mode fichier), au
**serveur** (400) et à l'**import**, pas seulement dans l'UI :

- **T10 (invariant)** — un faisceau relie deux équipements **distincts** (A ≠ B) ;
- **T11 (cross-entité, une règle par bout)** — chaque extrémité référence un équipement de **type
  `patch_panel`** ;
- **dépendance inverse (V5b)** — re-typer un équipement qui ancre un faisceau rejoue T11 → refusé
  (`equipments.dependents → cableBundles.endpoint_a/b_equipment_id`, champs indexés dans `INDEX_SPEC`).

Le formulaire (`CableForms.cableBundle`) applique la même règle **par construction** : sélecteurs filtrés
aux patch panels, exclusion mutuelle A/B (chaque select retire la sélection de l'autre), `LiveValidation`
pour le surlignage par champ.

## 2. L'uplink de patch (port VIRTUEL)

Tout patch porte **d'office** un point de terminaison réservé au faisceau — l'**uplink** — placé par
défaut au **centre de sa face arrière**. Ce n'est PAS une entité `ports` : c'est une géométrie pure
(`Resolver3D.TRUNK_UPLINK_GEO` = `{face_x: 0.5, face_y: 0.5, face_side: "rear"}`), résolue par
`Resolver3D.resolveTrunkUplink3D(equipmentId, dcId)` via la **même mécanique** que les ports persistés
(`resolveFaceAnchor3D`, extraite de `resolvePort3D` — tous les modes de placement : rack, side, wall,
tray, libre). Le tracé du faisceau s'ancre donc dès que le patch est **posé**, même si aucun port ne
pioche encore de brin.

## 3. Routage du tracé — `src-client/geometry/TrunkRouting.ts`

Service pur parallèle à `CableRouting` (mêmes trois cas, parité complète avec les câbles) :

| Cas | Méthode | Consommé par |
|---|---|---|
| intra-salle (2 uplinks dans la salle) | `resolvedTrunks(dcId)` | `DcThreeScene.buildTrunks` (3D) · `DcViews2D.drawTrunks2D` (2D) |
| stub sortant (« s'arrête au mur ») | `outgoingTrunkStubs(dcId)` | `DcBase.webglCtx` (3D, extras) · `drawTrunks2D` (2D) |
| inter-salles (monde 3D) | `interDcTrunks(m)` | `DcBase.webglCtx` (extras `kind: "trunk"`) |
| inter-salles (plan d'étage 2D) | `interDcTrunksFloor(dcs, cfg, planOf)` | `DcViews2D.renderFloor` |

**Réutilisation** (aucune duplication de mécanique) :

- l'**analyse de route** vient de l'analyseur du Store : `store.bundleRoute` = grammaire du
  pseudo-câble (exits par paires, pins d'étage — un faisceau n'a pas de ports) **+ cohérence des
  extrémités** (cf. § 3.1) ; le pseudo-câble ne sert plus qu'aux helpers de câble qui lisent
  `waypoint_ids` (`store.cableWaypointsIn`, répartition en conduit) ;
- la **polyligne** (amorces ⊥, conduits, spline) vient de `CableRouting` injecté : helpers extraits
  `viaPoints` / `stubLineIn` / `worldLine`, partagés câbles ⇄ faisceaux ;
- dans un **conduit**, le faisceau occupe un **slot de répartition** comme un câble
  (`Resolver3D.conduitCablesOf` énumère câbles + trunks) : il traverse physiquement la section, et comme
  les brins piochés par ports ne sont pas dessinés, le trunk est LA ligne visible — centré, il
  chevaucherait un câble voisin ;
- une route saisie « à l'envers » (extrémité A dans la salle d'arrivée) est **tolérée** en inversant les
  bouts (le formulaire faisceau n'oriente pas la route comme le fait `orientEnds` côté câble) — le
  verdict vient du champ `sens` de `bundleRoute` (« aligned » / « swapped »), plus d'un calcul local.
  L'ÉDITEUR de route en propose désormais la CORRECTION (« Inverser les extrémités A ⇄ B ») sur l'ancre
  en alerte, plutôt que de laisser l'utilisateur deviner (cf. § 3.2).

### 3.1 Cohérence extrémités ⇄ route — `store.bundleRoute` (source unique du verdict)

Un faisceau n'a pas de ports : l'analyse du pseudo-câble ne pouvait déclencher NI `portA_room`/
`portB_room` NI `ports_split`, et l'alignement extrémités ⇄ route se vérifiait DANS le rendu — qui, en
cas d'incohérence, ne traçait rien, **silencieusement** (incident réel, corpus SONUMA 2026-07-30 : un
faisceau dont le 1er waypoint sortait d'une salle ne contenant AUCUNE extrémité était invisible en
2D/3D, sans le moindre message). Le verdict vit désormais dans `CableRouteAnalyzer.bundleRoute(bundle)`
(pure lecture, testé) :

- `containerA`/`containerB` = conteneurs des **patchs** (`equipmentNamedContainer` — la salle de la
  chaîne, sinon l'étage), remplaçant les `null` du pseudo-câble sans ports ;
- `sens` = « aligned » · « swapped » (route à l'envers, tolérée) · `null` (extrémité absente/non
  localisable, ou incohérence) ;
- erreurs à **codes stables** : `endpoints_split` (miroir exact de `ports_split`, appliqué aux
  extrémités) et `endpoint_route_mismatch` (route à exits dont ni l'endroit ni l'envers ne desservent
  les extrémités posées — le message **nomme les conteneurs**, c'est lui qui aurait révélé l'incident) ;
- ces codes ne sont **ni structurels ni « room break »** : un brouillon reste enregistrable. Le
  formulaire faisceau AFFICHE le verdict (cf. § 3.2) et ne bloque au save que les erreurs
  STRUCTURELLES (`routeStructuralError`), comme le câble.

**Conséquence rendu (voulue, parité câbles)** : `TrunkRouting.trunkRoute` délègue à `bundleRoute` et
`r.valid` intègre ces erreurs → une route incohérente avec ses extrémités ne trace plus **rien**, y
compris le stub « s'arrête au mur » (`outgoingTrunkStubs`) qui se dessinait auparavant dans la salle de
l'extrémité qui matchait l'arrivée de la route. Le signal vit dans le formulaire, plus dans un tracé
fantôme.

### 3.2 L'ÉDITEUR de route — une CHAÎNE, le même pour le câble et le faisceau

Depuis le 2026-07-31, la route ne s'édite plus par un **nuage de cases à cocher** doublé d'une liste
« Ordre du trajet » : les deux formulaires (`CableForms.cable` et `CableForms.cableBundle`) partagent le
composant **`views/forms/RouteChainEditor`**, qui affiche la route comme une **chaîne ordonnée** entre
deux **ancres**. Seules les ancres diffèrent — des **ports** pour un câble, des **patchs** pour un
faisceau (`equipmentNamedContainer`) —, et elles sont fournies par l'hôte : le composant n'importe ni le
store ni les formulaires (interface `RouteChainHost`).

Ce que le faisceau y gagne, et qui lui manquait totalement : chaque erreur rattachée à **SON étape**,
l'état « transit » (`exit_unpaired`) rendu **visible** en cours d'édition au lieu d'être découvert au
save, les **ancres en alerte** quand la route ne les dessert pas, et l'action **« Inverser les
extrémités A ⇄ B »** sur le cas « route à l'envers ».

- **La grammaire n'est pas réécrite** : `core/RouteEligibility` (pur, testé) la CONSOMME. Il rend, pour
  une position d'insertion, la liste des waypoints **utilisables** et le **motif** (code stable) des
  autres — affichés grisés dans le popover d'ajout (`ui/SearchPop`), « grisé ≠ caché ».
- **Rattachement erreur → étape** : `RouteAnalysis.errors` ne porte pas d'index. Il se déduit du fait
  que l'automate est un **pli à gauche** et qu'une étape pousse au plus UNE erreur de grammaire : en
  analysant les **préfixes** successifs, l'étape qui fait croître le compte porte la dernière erreur
  (`RouteEligibility.stepReports`, qui rend aussi l'état de l'automate APRÈS chaque étape — d'où les
  bandeaux de conteneur et le bandeau « Transit »).
- Spec de fond : `design-system/briefs/route-editor-waypoints.md` ; référence visuelle :
  `design-system/briefs/route-editor-waypoints.maquette.html`.

## 4. Style & comportement — « comme un câble, plus épais »

- **Style** : trait plus **épais** (`TRUNK_PX` 3 px / 4,5 px sélectionné — 3D `DcThreeScene`, 2D
  `.dc-trunk` dans `dc-manager.css`), couleur **neutre** (`TRUNK_COLOR` = gris `0x9aa6b8` : un faisceau
  n'a pas UN réseau — ses brins en portent plusieurs).
- **Visibilité** : MÊME modèle que les câbles — toggle « Tout afficher (estompé) » (`showAllCables`) et
  **sélection partagée `selCables`** (les ids sont uniques toutes collections) → Afficher / Isoler /
  Masquer valent indifféremment câbles et trunks (isoler un câble masque aussi les trunks, et
  réciproquement). Rangée « Faisceaux (trunks) » dans la carte Câbles du panneau (◉/◎).
- **3D** : les trunks vivent dans les MÊMES groupes que les câbles (`cablesGroup` par salle, `gExtra`
  transversal avec `ExtraCable.kind: "trunk"`) → `cablesOnTop`, survol, cache chaud de salles et
  `rebuildCables` s'appliquent sans code dédié. Picking : `pick.type === "trunk"` traité comme un câble
  (proximité au rayon) mais **clic → formulaire FAISCEAU** (`host.openCableBundleForm`), tooltip
  `bundleTipHtml`, menu contextuel `bundleCtx` (éditer · supprimer · sélection du trunk et de ses brins).
- **2D** : `drawTrunk2D` réutilise `cablePath` (mêmes splines/amorces), zone de clic large
  (`.dc-cable-hit`), survol/menu identiques aux câbles.
- **Impact SSE** : `cableBundles → "geometry"` dans `RenderImpact` (le tracé est dessiné — un changement
  de faisceau reconstruit la scène).

## 5. Tests

- `Tests/modules/test-geometry.js` — uplink (centre face arrière, parité port persisté, garde-fous null) ;
- `Tests/modules/test-views-tools.js` — tracés (intra / non posé / stub / inter-DC monde / plan d'étage /
  route inversée / visibilité partagée / route incohérente NON tracée, stub compris) ;
- `Tests/modules/test-shared-validation.js` + `test-core-store.js` — T10/T11 + dépendance inverse +
  cohérence extrémités ⇄ route (`bundleRoute` : sens, `endpoints_split`, `endpoint_route_mismatch`) ;
- `Tests/modules/test-sync.js` — carte d'impact.
