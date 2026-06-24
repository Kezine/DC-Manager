# NetMap — Audit de code & pistes d'amélioration

**Cible auditée :** `netmap-v154-power-bolts.html` (18 771 lignes · 1,33 Mo · application mono-fichier HTML/CSS/JS, sans framework ni bundler)
**Date :** 2026-06-18
**Périmètre :** audit de qualité, repérage du code en double, pistes d'optimisation, plan de rationalisation des commentaires, feuille de route des points faibles.
**Décisions cadrantes (validées) :** le **changelog du header est conservé** (mémoire de session voulue) ; on ne rationalise que les commentaires **inline**.

> ✅ **Mise à jour (2026-06-18) — Cleanup n°1 (commentaires) APPLIQUÉ → [netmap-v155-comment-cleanup.html](netmap-v155-comment-cleanup.html).**
> **1021** jalons `vNN` retirés des commentaires du `<script>` (1127 → 106 keepers : `rétro-compat ≤ vNN`, tags de phase `vNN/C4`, bandeaux de section) ; blocs purement historiques condensés (migrateFaceImages, colonnes « Ordre », navigation clavier). Header conservé. **Code vérifié byte-identique** (12 804 lignes de code normalisées identiques — seuls les commentaires changent) ; `node --check` OK. Les autres chantiers (§4–§9) restent *à appliquer*.

> Convention de lecture : **Impact** H/M/L · **Effort** S/M/L · **Risque** = risque de régression de l'action proposée. Les références `fichier:NNNN` pointent la ligne dans `netmap-v154-power-bolts.html`.

---

## 1. Résumé exécutif

NetMap est une application **fonctionnellement très riche et globalement bien architecturée** : la séparation `DataAdapter / FieldIndex / Store` est propre, la maintenance des index secondaires est réellement incrémentale, le rendu 3D « algorithme du peintre » sans dépendance est un vrai exploit en mono-fichier. Le code est cohérent d'un bout à l'autre (mêmes helpers SVG, mêmes patterns d'UI).

La dette ne se situe **pas dans la logique mais dans trois axes** :

1. **Dette de commentaires (axe n°1, confirme votre intuition).** ~**1 019 références `vNN`** dans le JS + ~**125** tournures « avant…/maintenant… » + un header de **~1 640 lignes** de changelog. La majorité des commentaires inline racontent *quand* une chose a changé, pas *ce qu'elle fait*. C'est le premier frein à la lecture.

2. **Code en double.** Plusieurs familles de quasi-clones : trio d'export et menu contextuel dupliqués **entre** GraphView et DatacenterView ; bloc « boîte 6 faces + tri peintre », bloc « tracé de câble », garde « glissé vs clic » répétés 4–12× ; familles `opt*` (14×), `assign*` (5×), géométries side-mount/wall-mount jumelles.

3. **Performance du rendu 3D + méthodes géantes.** La 3D (vue par défaut) **reconstruit toute la scène depuis le store à chaque `mousemove`** d'orbite/pan, sans coalescing rAF ni dirty-check, avec un **tri topologique O(n²) par baie à chaque frame**. Et quelques méthodes monstres (`_rackBox3D` ~600 l., `openEquipmentForm` ~844 l., `openCableForm` ~414 l.) concentrent le risque structurel.

**Verdict santé :** 🟢 architecture saine · 🟠 lisibilité plombée par les commentaires historiques · 🟠 perf 3D à retravailler · 🟠 outillage de projet absent (pas de git, pas de tests intégrés, 119 Mo de snapshots).

### Top 5 des priorités

| # | Chantier | Pourquoi | Impact | Effort |
|---|----------|----------|:---:|:---:|
| 1 | **Perf 3D** : coalescing rAF + dirty-check + cache des *drawables* sur changement caméra seul + mémo de l'ordre de peinture par baie | La 3D est la vue par défaut et rame au glissé/zoom sur gros documents | H | M |
| 2 | **Rationalisation des commentaires inline** (strip `vNN`, suppression du code mort documenté) | ROI lisibilité maximal, c'est la demande initiale | H | M |
| 3 | **Découpe des méthodes géantes** (`_rackBox3D`, `openEquipmentForm`, `openCableForm`, `renderSide`) | Pré-requis à tout test et à toute évolution sûre | H | L |
| 4 | **Factorisation des doublons transverses** (export, menu contextuel, boîte 6 faces, tracé câble, garde glissé, `opt*`/`assign*`) | Réduit la surface de bug et la taille du fichier | M | M |
| 5 | **Hygiène projet** : `git init`, intégrer les smoke-tests, lint/`node --check` en CI, purge des copies `(1)` | Filet de sécurité aujourd'hui inexistant | H | S→M |

---

## 2. Méthodologie & périmètre

Audit mené par **7 analyseurs parallèles**, un par région du JS, plus une passe transverse (densité de commentaires, refs de version, doublons inter-régions) et une **vérification manuelle** des constats les plus impactants.

| Région | Lignes | Classe / contenu | Couverture |
|--------|-------:|------------------|:---:|
| Couche de données | 3487–5502 | helpers, constantes, entités, `FieldIndex`, adapters | ✅ |
| Store | 5502–6087¹ | orchestrateur collections + transactions + cascade + undo | ✅ |
| Plomberie UI globale | 6088–7412 | modale/dialogue/tooltip/toast, prefs, IDB-handle, fichier, autosave, undo UI, settings, `imageStore` | ⚠️ légère² |
| ListController p.1 | 7412–9798 | liste générique + formulaires équipement/rack/IPAM | ✅ |
| ListController p.2 | 9798–11542 | dialogues `assign*`, grilles capot, form câble, éditeur de façade, vues détail | ✅ |
| GraphView | 11542–12771¹ | vue NETMAP (graphe SVG force-directed) | ✅ |
| Fonctions libres waypoints | 12772–13908 | géométrie de routes, splines | ✅ (incident) |
| DatacenterView p.1 | 13908–16252 | état, panneaux, vues 2D Dessus/Étage, géométrie | ✅ |
| DatacenterView p.2 | 16252–18769 | cœur du rendu 3D, caméra, interactions, export, boot | ✅ |

¹ Frontières réelles : `class Store` se termine en **6087** (et non 7412) ; `class GraphView` en **12771**.
² **Point d'honnêteté :** la zone 6088–7412 (plomberie UI : modales, gestion de fichier, autosave, settings) n'a reçu qu'une passe légère. Les patterns y sont probablement similaires ; une relecture dédiée est recommandée avant d'appliquer des changements dans cette zone.

---

## 3. Audit des commentaires & plan de rationalisation

### 3.1 Constat chiffré (zone `<script>` 3487–18769)

| Mesure | Valeur |
|--------|-------:|
| Lignes portant un commentaire | ~1 859 |
| Lignes 100 % commentaire (`//…`) | ~914 |
| Blocs `/* … */` | ~504 |
| **Références à une version `vNN`** | **~1 019** |
| Tournures « avant/maintenant/désormais/ancien… » | ~125 |
| `TODO`/`FIXME`/`HACK` | **0** (propre sur cet axe) |
| Header de commentaire (avant `<style>`) | ~1 640 lignes (changelog v1→v150) |

### 3.2 Header — **conservé** (par décision)

Le header se déclare « seule source de vérité pour le futur Claude sans mémoire ». On le **garde tel quel**. Recommandation *facultative* pour plus tard : extraire la partie purement chronologique (v1→v150) vers un `CHANGELOG.md` et ne laisser dans le header que les blocs **ARCHITECTURE**, **INVARIANTS** (lignes [1619–1638](netmap-v154-power-bolts.html#L1619)) et **INDEX** — ce sont les seules sections « état courant ». Non bloquant.

### 3.3 Inline — **à rationaliser** : 4 catégories

> Règle générale : **supprimer le préfixe `vNN`, garder l'intention comportementale**. Ne jamais retirer un commentaire qui explique un *pourquoi* non évident (invariant, contrainte physique, piège de rendu).

**Catégorie A — Pierres tombales de code retiré (à SUPPRIMER, code + commentaire).** Priorité haute : ces commentaires décrivent ce qui *n'existe plus*.
- `migrateFaceImages()` : stub `return false` précédé de ~8 lignes d'historique v20→v21→v22→v52 — [5599–5609](netmap-v154-power-bolts.html#L5599). Le commentaire fait 3× la taille de la méthode morte.
- « v102 — colonne « Ordre » RETIRÉE » répété en [7766](netmap-v154-power-bolts.html#L7766) **et** [9431](netmap-v154-power-bolts.html#L9431).
- « navigation clavier RETIRÉE (sera reconstruite plus tard) » — [14166](netmap-v154-power-bolts.html#L14166).
- « la poignée de cadre v79 a été retirée en v80 » (header) et code de poignée déjà absent.

**Catégorie B — Post-mortems de bugs dans le code (à CONDENSER en intention présente).**
- « v127 — FIX : sinon display="" rallumait à tort… » — [8325–8327](netmap-v154-power-bolts.html#L8325).
- « v116 — FIX régression v88 : le recentrage du pivot DÉTRUIT le nœud pressé… » — [17275–17277](netmap-v154-power-bolts.html#L17275).
- « Bug corrigé : auparavant le test de retournement… → décision inversée » — [16924–16927](netmap-v154-power-bolts.html#L16924).
- « v154 — les quads de port transparaissaient à travers la boîte → ports sur les DEUX faces » — [16938–16942](netmap-v154-power-bolts.html#L16938).

**Catégorie C — Tags de provenance purs (STRIP `vNN`, garder le reste).** Le gros du volume (~1 000 occurrences). Exemples :
```
// v144 : montants avant/arrière           →   // montants avant/arrière
// v33 : la compat reste sur la FAMILLE …   →   // compat = FAMILLE (le connecteur ne pilote que le rendu 3D)
// v146 : résolution latérale = 2U (avant 4U) →  // résolution verticale du montage latéral = 2U
const SIDE_U_STEP = 2;   // v146 : …        →   const SIDE_U_STEP = 2;   // pas vertical du montage latéral (U)
```
Foyers denses : constructeur `DatacenterView` [13911–13957](netmap-v154-power-bolts.html#L13911) (quasi chaque champ taggé) ; `_cascadePlan` [5827–5919](netmap-v154-power-bolts.html#L5827) ; ligne [6042](netmap-v154-power-bolts.html#L6042) qui enchaîne *4* tags (v105/v115/v123/v147) ; tables de données [3688–3690](netmap-v154-power-bolts.html#L3688), [4522](netmap-v154-power-bolts.html#L4522).

**Catégorie D — TODO déguisés en prose (à CONVERTIR en vrai `TODO(...)` ou supprimer).**
- « un mécanisme de SWAP est prévu / swap à venir » — [10171](netmap-v154-power-bolts.html#L10171), [10196](netmap-v154-power-bolts.html#L10196).
- « La synchronisation serveur (API) arrivera plus tard », « le mode API sera activé ultérieurement » — [12852](netmap-v154-power-bolts.html#L12852), [12916](netmap-v154-power-bolts.html#L12916).

**Estimation :** ~1 000 retraits de tag (catégorie C, mécanique, scriptable par regex relue), ~30 suppressions ciblées (A/D), ~40 condensations (B). Gain attendu : fichier plus court, diff futurs lisibles, et surtout des commentaires qui *décrivent le code présent*.

---

## 4. Code en double

### 4.1 Doublons **transverses** (priorité — entre classes)

> ✅ **Appliqué en partie (2026-06-18) — [netmap-v156-dedup-helpers.html](netmap-v156-dedup-helpers.html).** Helpers partagés créés : `buildContextMenu` (rendu/positionnement du menu contextuel — corps identique aux 2 vues), `exportFileBase` (nom de fichier) + `runImageExport` (branche SVG/JPEG). `_showContextMenu` (×2) et l'export des 2 vues sont rewirés ; chaque vue garde sa garde propre (`_navMoved`) et son `_buildExportSvg` spécifique. `node --check` OK ; **diff = uniquement les extractions prévues**.
>
> ✅ **Garde « glissé vs clic » FAIT (2026-06-19) — [netmap-v162-clickguard-dedup.html](netmap-v162-clickguard-dedup.html).** Les **14** gardes inline (`let dn = null` + `mousedown` + `click` avec `Math.hypot(...) > 4`) de DatacenterView remplacées par `_clickGuard(node, onClick, {reservePan})`. La variante « pan réservé » (Maj/clic-droit n'arme pas le clic : sol `_room3D`, faces de baie `_rackBox3D`) est portée par l'option `reservePan` (logique `!dn || …` vs `dn && …`). Le **cœur de décision est extrait en fonction PURE `clickGuardBlocks(dn,x,y,thresh,reservePan)`** → **testée** (suite [07-click-guard](Tests/suites/07-click-guard.test.js), 11 assertions : seuil strict, distance euclidienne, 2 variantes). `node --check` OK ; **diff = uniquement les extractions** ; **135 PASS**.
>
> ✅ **Route inter-salle FAIT (2026-06-19) — [netmap-v163-route-dedup.html](netmap-v163-route-dedup.html).** Le bloc « points de passage MONDE » (items OOB/salle → ancres → prev/next → `conduitOffsetFor` → `waypointPassPoints` → retour monde), **dupliqué à l'identique** dans `_interDcRoutes` et `_floorEquipCables3D`, factorisé en `_buildWorldVia(steps, roomById, m, aw, bw, cableId)`. Seule différait la forme des ancres de repli (`aw/bw` monde vs bouts `a/b` — toutes deux `{x,y,z}`). Méthode instance/caméra-couplée (non testable seule en Node), mais sa **brique pure `waypointPassPoints` est désormais couverte** (suite [08-waypoint-pass](Tests/suites/08-waypoint-pass.test.js), 18 assertions : orientation min-détour, `off` conduit, segment dégénéré, point isolé). `node --check` OK ; **diff = uniquement l'extraction** ; **153 PASS**.
>
> ✅ **Boîte 6 faces FAIT (2026-06-19) — [netmap-v164-box6faces.html](netmap-v164-box6faces.html).** Le cœur géométrique (8 coins → 6 quads `BOX6_FACE_IDX` → centroïde → tri peintre loin→près), **dupliqué dans 5 sites** de rendu, factorisé en fonction PURE `box6Faces(C, meta)` → 6 faces `{...meta, pts, cd}` triées. Réécrits : équipement **latéral**/**mural**/**racké** (`occ`, plane y0/y1 → images)/**libre** (`_freeEquipBox3D`) + **portes** de baie. Chaque site garde son opacité/images/câblage (passés en `meta`). `_rackBox3D` lui-même (trous capot + test proche/lointain) **laissé tel quel** (trop spécifique). `box6Faces` **testé** (suite [09-box6faces](Tests/suites/09-box6faces.test.js), 18 assertions : ordre des coins, centroïde, tri stable, fusion meta). `node --check` OK ; **diff = uniquement l'extraction** ; **171 PASS**.
>
> ✅ **Tracé de câble FAIT (2026-06-19) — [netmap-v165-emitcable-dedup.html](netmap-v165-emitcable-dedup.html).** Les éléments **communs** du rendu d'un câble résolu (tracé+stubs `_makeCableLine` · éclairs power · **marqueurs ◎ OOB** ~10 l. dupliquées à l'identique), factorisés en `_emitCable3D(rc, P, proj, drawables, sel, col)`. Ce qui diffère reste propre à chaque site (pastilles : tous les points en inter-salles vs 2 bouts en étage ; connecteurs de port). Ordre de push indifférent (drawables trié par profondeur, bandes z disjointes). **Pas de nouveau test** (méthode instance/SVG-couplée, briques déjà DOM) — vérif par diff + `node --check`, 171 tests data/géométrie verts. **Diff = uniquement l'extraction.**
>
> ✅ **§4.1 (doublons transverses entre classes) : TERMINÉ** — menu ctx/export (v156), garde glissé/clic (v162), route inter-salle (v163), boîte 6 faces (v164), tracé câble (v165). Restent les doublons **intra-région** du §4.2.

| Doublon | Emplacements | Action proposée | Impact |
|---------|--------------|-----------------|:---:|
| **Trio d'export** `_exportName`/`_buildExportSvg`/`exportImage` | GraphView [12726](netmap-v154-power-bolts.html#L12726)/[12745](netmap-v154-power-bolts.html#L12745)/[12763](netmap-v154-power-bolts.html#L12763) ↔ DatacenterView [17319](netmap-v154-power-bolts.html#L17319)/[17326](netmap-v154-power-bolts.html#L17326)/[17379](netmap-v154-power-bolts.html#L17379) | `exportSvgView(view, opts)` partagé (les deux appellent déjà `inlineComputedStyles`/`svgStrToJpeg`) | M |
| **`_showContextMenu`** défini 2× | GraphView [12396](netmap-v154-power-bolts.html#L12396) ↔ DatacenterView [14177](netmap-v154-power-bolts.html#L14177) | Helper/mixin commun de menu contextuel | M |
| **Boîte 6 faces + tri peintre** ✅ **FAIT (v164)** | `side`, `wall`, `occ`, `_freeEquipBox3D`, portes (5 sites) | `box6Faces(C, meta)` pur (géométrie+tri ; testé). `_rackBox3D` laissé (trous capot) | M |
| **Bloc « tracé d'un câble résolu »** (projette pts → depth → `_makeCableLine` → bolts → ports → pastilles) ✅ **FAIT (v165)** | 3D `_interDc3D` ↔ `_floorEquipCables3D` | `_emitCable3D(rc, P, proj, drawables, sel, col)` (commun : tracé+bolts+OOB ; pastilles/ports propres à chaque site) | M |
| **Marqueur OOB ◎** (anneau + cercle hit + wire) | [16330](netmap-v154-power-bolts.html#L16330), [16076](netmap-v154-power-bolts.html#L16076), [16196](netmap-v154-power-bolts.html#L16196) | `_oobMarkerNode(p, wp, depthBias)` | S |
| **Garde « glissé vs clic »** (`dn` + `hypot>4`) ✅ **FAIT (v162)** | 14× dans DatacenterView | `_clickGuard(node, onClick, {reservePan})` + cœur pur `clickGuardBlocks` (testé) | S |
| **Assemblage de route inter-salle** ✅ **FAIT (v163)** | `_interDcRoutes` ↔ `_floorEquipCables3D` | `_buildWorldVia(steps, roomById, m, aw, bw, cableId)` (brique pure `waypointPassPoints` testée) | M |
| **Math zoom-vers-point** | GraphView `_onWheel` [12281](netmap-v154-power-bolts.html#L12281) ↔ `_zoomBy` [12290](netmap-v154-power-bolts.html#L12290) | `_zoomAtClient(px,py,factor)` | S |

> Note positive : la création SVG est **déjà** factorisée (`svgEl`), de même que `_makeCableLine`, `_portFlat`, `_faceImageNode`, `inlineComputedStyles`. Le doublon restant est surtout dans les *assemblages* de ces primitives.

### 4.2 Doublons **intra-région**

**Couche de données (3487–5502)**
- Géométries **side-mount ≈ wall-mount** jumelles : `rackSideOccupants` [3777](netmap-v154-power-bolts.html#L3777) ≈ `rackWallOccupants` [3953](netmap-v154-power-bolts.html#L3953) ; `sideSlotFree`≈`wallSlotFree` ; `sideFreeSlots`≈`wallFreeSlots` ; `sideSlotBoxLocal`≈`wallSlotBoxLocal`. → extraire un énumérateur d'emplacements paramétré par axe.
- `ttLine` redéfini 3× ([4258](netmap-v154-power-bolts.html#L4258), [4353](netmap-v154-power-bolts.html#L4353) + module `_ttLineApp` [4077](netmap-v154-power-bolts.html#L4077)).
- Idiome `LIST.find(...).label` → `makeLabeler(list, fallback)`. ✅ **FAIT (v166)** pour les 5 labelers *find-based* (`powerSourceLabel`/`depthLabel`/`portRoleLabel`/`faceLabel`/`waypointTypeLabel`). Les labelers *map-based* (`equipmentTypeLabel`/`groupTypeLabel`/`locationLabel`/`rackItemKindLabel`, lookup O(1) via `*_BY_ID`) **laissés tels quels** (ne pas régresser en find O(n)). Testé (suite 10).
- `arr.filter((id,i)=>arr.indexOf(id)===i)` 3× → ✅ **`uniqIds(arr)` FAIT (v166)**, testé (suite 10). `parseLengthM` : non extrait (idiome trivial `parseFloat(p.length_m)` ×2, peu de valeur).

**Store (5502–6087)**
- ~20 helpers `*Of(id)` à shape identique (`_byFk(coll, field, id)`) [5979–6040](netmap-v154-power-bolts.html#L5979) → ⏭️ **ÉCARTÉ (2026-06-19)** : la génération table-driven a une valeur marginale et **nuit à la repérabilité** (des méthodes explicites se grep/parcourent mieux que des assignations `prototype` générées, dans un fichier sans build). Laissés tels quels. *(Désormais couverts par les tests — suite 05.)*
- Union de 2 champs FK avec dédup par `includes` : `cablesOfPort` [5985](netmap-v154-power-bolts.html#L5985), `cablesOfNetwork` [6008](netmap-v154-power-bolts.html#L6008) → `_byFkUnion`.
- ✅ **FAIT (v160)** — Patch+reindex (identique dans `update`/`updateBatch`) → `_applyPatch(collection, obj, patch)`. Vérifié (Tests/ 94 PASS). *(`remove` garde sa logique de détache mono-clé, distincte.)*

**ListController p.1 (7412–9798)**
- **`opt*()` fournisseurs** : ⏭️ **ÉCARTÉ (2026-06-19)** après relecture — en v167 ils VARIENT trop (tri/label/couleur propres à chacun ; certains Set-based ou en dur). Un `optFromCollection(coll, opts)` deviendrait un god-config aussi long que les originaux, pour un gain marginal et un risque UI réel (sans test visuel). Laissés.
- `numberInput` réécrit à la main → ✅ **`numberInput(value, {min,step,placeholder})` FAIT** : helper + élimination des 2 closures `mkNum` + 17 appels (v168), puis **sweep des 29 `<input number>` inline restants (v169)** — TOUS convertis. DOM-builder → vérif par diff (= conversions seules) + `node --check` + 197 tests ; **à contrôler visuellement** (défauts/placeholders/min). **number-input : terminé.**
- 4 closures `refresh*Hint` IPAM identiques → `cidrHintUpdater` ; queue `create/update + toast + setDirty` répétée 6× → `saveEntity()` ; garde champ obligatoire répétée → helper.

**ListController p.2 (9798–11542)**
- **5 dialogues `assign*`** : ⏭️ **ÉCARTÉ (2026-06-19)** après relecture intégrale — le « squelette identique » est en réalité mince ; chaque dialogue (~70 l.) a des champs, règles de validation et mutations store BESPOKE (équipement/brosse/pin/rackItem, géométrie side/wall/cap/floor). Un `slotAssignDialog(opts)` serait un god-config quasi aussi gros que les originaux, à fort risque UI sans test visuel. Laissés.
- 2 grilles SVG quasi identiques : `capGrid` [9968](netmap-v154-power-bolts.html#L9968) ≈ `capPickGrid` [10038](netmap-v154-power-bolts.html#L10038).
- 2 sélecteurs de waypoints/route ([10344](netmap-v154-power-bolts.html#L10344) ↔ [10656](netmap-v154-power-bolts.html#L10656)) → `waypointRoutePicker`.
- Re-peuplement manuel de `<select>` 3× → `setSelectOptions(sel, opts, value)`.

**GraphView (11542–12771)**
- **Formule de largeur de nœud dupliquée 5×** → ✅ **`graphNodeSize(n)` FAIT (v167)**, source unique pure et testée (suite 11). **Corrige le bug latent §6** (changement de comportement assumé : bbox/recentrage utilisent la largeur réelle). Demi-hauteurs de bbox (24/26) laissées → cf. item suivant.
- Réduction bounding-box (demi-hauteurs 24/26/`h/2` divergentes) → ✅ **`graphNodesBBox(nodes, halfHOf)` FAIT (v171)** : pure, testée (suite 11) ; les 3 boucles (`bboxOf`/`recenter`/`_contentBounds`) y passent ; demi-hauteur conservée par site via `halfHOf`.
- Échafaudage de drag répété 3× (`_startNodesDrag`/`_startFrameDrag`/`_startFrameResize`) → ✅ **`_dragSession(onMove, onUp)` FAIT (v170)** : factorise l'enregistrement/détachage des écouteurs mousemove+mouseup ; chaque drag ne fournit que ses callbacks. UI → vérif diff + `node --check` + **visuelle**. (DC/3D/marquee/edge-pan gardent leur boilerplate — classe différente.)

**DatacenterView p.1 (13908–16252)**
- **4 handlers de drag d'étage** quasi identiques ([15109](netmap-v154-power-bolts.html#L15109), [15170](netmap-v154-power-bolts.html#L15170), [15198](netmap-v154-power-bolts.html#L15198), [15292](netmap-v154-power-bolts.html#L15292)) → `_makeFloorDrag(e, opts)`.
- « Retirer du DC → `cableDowngradeOps` + `updateBatch` + toast » répété 4× ([14312](netmap-v154-power-bolts.html#L14312), [14337](netmap-v154-power-bolts.html#L14337), [14361](netmap-v154-power-bolts.html#L14361), [15326](netmap-v154-power-bolts.html#L15326)).
- Fin de menu contextuel (`csi` + `secs.push` + `_showContextMenu`) copiée ~5×.

---

## 5. Pistes d'optimisation

### 5.1 Impact **HAUT**

> 🟡 **Partiellement traité (2026-06-18) — [netmap-v157-3d-raf-coalesce.html](netmap-v157-3d-raf-coalesce.html).** Le point n°1 ci-dessous est attaqué côté **coalescing** : les glissés d'orbite/déplacement passent par `_scheduleRender3D` (1 rendu/frame via `requestAnimationFrame`) au lieu d'un `renderThreeD` synchrone par `mousemove`. **Reste à faire** : le *dirty-check* (ne reconstruire la scène que sur changement de données ; re-projeter seulement sur changement caméra) et le **point n°2** (mémo du tri peintre par baie) — les gains les plus importants.

1. **3D : reconstruction totale de la scène à chaque `mousemove`.** `_startOrbit.move` [17290](netmap-v154-power-bolts.html#L17290) et `_startTargetPan.move` [17307](netmap-v154-power-bolts.html#L17307) appellent `renderThreeD(dc)` **synchroniquement** par évènement souris. `renderThreeD` [16343](netmap-v154-power-bolts.html#L16343) vide tout le SVG (`_newScene`→`_clearStage`), relance `_multiLayout`, `_interDcRoutes`, **tous** les `_rackBox3D`, et **re-scanne `store.all("cables")`** à chaque frame.
   → **(a)** coalescer via `requestAnimationFrame` (1 rendu/frame max) ; **(b)** *dirty-check* : un changement caméra (`az/el/scale/tx/ty`) est une **remise affine** — séparer « (re)construire les drawables » (sur changement **données/visibilité**) de « (re)projeter » (sur changement **caméra**). Gain attendu : ordre de grandeur sur l'orbite.

2. **Tri peintre topologique O(n²) par baie, à chaque frame.** Dans `_rackBox3D` [16820–16839](netmap-v154-power-bolts.html#L16820) : bbox projetée par unité (8 `proj`/unité) puis double boucle `for i…for j>i` + Kahn. Une baie dense = dizaines de milliers d'appels `proj` par frame, par baie. → mémoriser l'ordre par baie, clé = `(az,el)` quantifiés ; invalider sur changement de données.

3. **`_recenterPivot3D` provoque un rendu complet *en plus* au début du drag** ([17285](netmap-v154-power-bolts.html#L17285) → `_visibleCentroidWorld` [15785](netmap-v154-power-bolts.html#L15785) → `renderThreeD`). Un rebuild gaspillé par début d'orbite.

4. **GraphView : teardown/rebuild complet du SVG à chaque `rebuild()`** ([11962](netmap-v154-power-bolts.html#L11962)) + **force-layout O(itérations·M²)** fixé à **300 itérations sans test de convergence** [11880–11900](netmap-v154-power-bolts.html#L11880), relancé synchroniquement à chaque changement de filtre en mode A/C. → convergence anticipée ; en mode B, basculer sur visibilité seule (déjà partiellement présent).

5. **Store : ré-hydratation document complet à chaque undo/redo** [5673–5688](netmap-v154-power-bolts.html#L5673) → `_hydrate` reconstruit *toutes* les entités + `_reindex()` global, quelle que soit la taille du changement. Coût dominant sur gros documents. → envisager un undo par *delta* (au moins pour les transactions unitaires).

6. **ListController.render() : re-filtre + re-tri + `innerHTML` complet à chaque frappe/filtre**, avec lookups store par ligne ([7475–7500](netmap-v154-power-bolts.html#L7475), colonnes équipement [7712](netmap-v154-power-bolts.html#L7712)). → mémoriser le résultat filtré+trié par `(query, filterSig, sortKey, dir)` ; ne re-trancher que pour la pagination ; débouncer la recherche.

7. **`openCableForm.refresh()` reconstruit 5 selects par changement** [10529](netmap-v154-power-bolts.html#L10529) ; `equipmentSelectOptions` fait **O(E·P)** ([10175](netmap-v154-power-bolts.html#L10175)) *deux fois* par refresh. → cacher les listes triées à l'ouverture, indexer `famille→eqIds`.

8. **Scans non indexés `store.all("waypoints")` dans des boucles d'emplacement** : `rackSidePins`/`capSlotOccupied`/`sideFreeSlots`/`capFreeSlots` → effectivement **O(U×W)**. `waypoints` n'est pas indexé sur `rack_id` ([INDEX_SPEC](netmap-v154-power-bolts.html#L5056)). → ajouter l'index `rack_id` et utiliser `findBy`.

### 5.2 Impact **MOYEN / FAIBLE** (extraits)
- `applyHighlight`/`_renderSelection` font `nodes.find()` dans une boucle `querySelectorAll` (O(n·e)) alors que `_nodeById`/`_edgeLineById` existent — [12322](netmap-v154-power-bolts.html#L12322), [12329](netmap-v154-power-bolts.html#L12329).
- `_updateEdgesForSet` itère **toutes** les arêtes à chaque frame de drag [12250](netmap-v154-power-bolts.html#L12250) → pré-indexer `edgesByNode`.
- `getBoundingClientRect()` dans les boucles chaudes (`_clientToWorld` [12117](netmap-v154-power-bolts.html#L12117), edge-pan rAF) → cacher le rect au début du drag.
- `_sizeCableDots` fait 4 `querySelectorAll` après *chaque* transform [15469](netmap-v154-power-bolts.html#L15469).
- `cloneEquipment` fait `_reindex()` global [5953](netmap-v154-power-bolts.html#L5953) au lieu d'un ajout incrémental.
- `BrowserStorageAdapter.list` re-trie toute la collection par page [5317](netmap-v154-power-bolts.html#L5317) ; recherche plein-texte sur **tous** les champs via `Object.values` + normalisation NFD par frappe [5315](netmap-v154-power-bolts.html#L5315).
- `equipmentTypeColor` refait `findIndex`+hash à chaque appel [3587](netmap-v154-power-bolts.html#L3587) (catalogue fermé → table pré-calculée).
- Aucun rAF pour drag/marquee dans GraphView (seul l'edge-pan en profite).

---

## 6. Bugs latents / points à vérifier

| Sévérité | Constat | Réf. |
|:---:|---|---|
| ✅ **CORRIGÉ (v167)** | **`recenter()` cadrait faux** : le *fallback* de largeur `Math.max(120, name.length*7+60)` divergeait de la formule de rendu. Résolu par la source unique `graphNodeSize(n)` (le fallback utilise désormais la formule canonique). | `graphNodeSize` |
| 🟠 | **Écritures adapter non transactionnelles côté cache** : `create/update/remove/transact` mutent la mémoire **puis** `await` l'adapter **sans try/catch** → si l'écriture échoue (quota, REST), cache et backend divergent, pas de rollback. | [5762](netmap-v154-power-bolts.html#L5762), [5776](netmap-v154-power-bolts.html#L5776), [5819](netmap-v154-power-bolts.html#L5819) |
| 🟠 | **Perte de session silencieuse** : `_read` avale les erreurs de parse en `null` (clé corrompue → session jetée) ; `_write` non gardé (quota dépassé → exception non rattrapée). | [5228](netmap-v154-power-bolts.html#L5228), [5231](netmap-v154-power-bolts.html#L5231) |
| 🟡 | **Code mort probable** : `readImageFileAsDataURL` (chemin base64, seuil 5 Mo) semble supplanté par `validImageFile` (Blob, seuil 12 Mo) — **seuils incohérents** entre les deux. À vérifier : a-t-il encore des appelants ? | [10906](netmap-v154-power-bolts.html#L10906) vs [10919](netmap-v154-power-bolts.html#L10919) |
| 🟡 | **Commentaire trompeur** : « un composant détaché de >1 nœud est aussi signalé non placé » mais aucun marquage `unplaced` n'a lieu à cet endroit. Comportement décrit ≠ code. | [11865](netmap-v154-power-bolts.html#L11865) |
| 🟡 | **Comparateur de tri peintre non transitif** (documenté comme tel) — risque de cycle/ordre instable contourné à l'exécution (tri topologique). Depuis **v172** isolé en `painterFarFirst` pur + **testé** (suite 12) : comportement caractérisé, non-transitivité documentée. | `painterFarFirst` |
| 🟡 | **`_byFk` retombe en scan O(n) silencieux** si un champ non indexé est interrogé → masque les bugs d'index manquant. Ajouter un `console.warn` en mode dev. | [5576](netmap-v154-power-bolts.html#L5576) |

---

## 7. Points faibles structurels

### 7.1 Méthodes géantes (risque n°1 de maintenance)

| Méthode | Lignes | ~Taille | Réf. |
|---------|--------|:---:|---|
| `_rackBox3D` 🔪 **découpe en cours (v172+)** | 16560–17162 | **~600** | [16560](netmap-v154-power-bolts.html#L16560) |
| `openEquipmentForm` (+ `onSave` ~160) | 8294–9137 | **~844** | [8294](netmap-v154-power-bolts.html#L8294) |
| `openCableForm` | 10222–10636 | **~414** | [10222](netmap-v154-power-bolts.html#L10222) |
| `renderSide` ✅ **découpée (v161)** | 17613–17977 | ~360→~170 (+5 méthodes de cartes) | [17613](netmap-v154-power-bolts.html#L17613) |
| `openWaypointForm` | 18233–18480 | **~250** | [18233](netmap-v154-power-bolts.html#L18233) |
| `openRackForm` / `openRackContent` | 9426–9796 | ~209 / ~158 | [9426](netmap-v154-power-bolts.html#L9426) |
| `_waypoint3D` | 14432–14540 | ~108 | [14432](netmap-v154-power-bolts.html#L14432) |
| `render` (GraphView) | 11962–12066 | ~105 | [11962](netmap-v154-power-bolts.html#L11962) |
| `_cascadePlan` | 5827–5919 | ~92 | [5827](netmap-v154-power-bolts.html#L5827) |

`_rackBox3D` à lui seul émet 9 *kinds* d'unités (`post/brush/side/sidefree/wall/wallfree/capfree/occ/ph`) dans un `forEach` géant — un émetteur par kind + les helpers de §4.1 le rendraient testable.
> 🔪 **Découpe incrémentale en cours** (une extraction par version, tests ajoutés au fur et à mesure) : **v172** — comparateur de tri peintre `farFirst` → fonction pure `painterFarFirst(A,B,grad)` (testée, suite 12). *À venir* : tri topologique `_painterOrder`, construction des `units`, émetteurs par kind.

### 7.2 Autres fragilités
- **Mono-fichier de 18 771 lignes, sans modules** : impossible à tester unitairement, navigation pénible. Des fonctions « couche de données » appellent `store` (défini plus loin) en s'appuyant sur le hoisting — non pures, non testables isolément ([3704](netmap-v154-power-bolts.html#L3704), [3778](netmap-v154-power-bolts.html#L3778)).
- ✅ **FAIT (v159, 2026-06-19)** — **`_cascadePlan`** : l'échelle `if/else if` (12 branches, ~92 l.) est devenue un **spec déclaratif `CASCADE_SPEC`** (delete/detach par FK + `custom` pour les 4 cas complexes) interprété par un walker générique. Ajouter une relation = une entrée de spec. Comportement identique **prouvé** par [Tests/](Tests/) (70 PASS dont 29 assertions cascade sur les 12 collections). *Avant : échelle à clés-chaînes, FK en dur, éditée à chaque nouvelle relation.*
- **Nombres magiques du z-layer 3D** : `-1e4`/`-2e4`/`-3e4`/`1e7`/`BASE`/`levelStep*8` encodent un ordre de couches **implicite** sans constantes nommées — couplage peintre très fragile ([16841](netmap-v154-power-bolts.html#L16841), [15996](netmap-v154-power-bolts.html#L15996)). → constantes `Z_LAYER_*`.
- **État fragmenté de GraphView** : `pos` / `_moved` / `unplaced` / `n.x` vivant / layouts sauvegardés — invariants seulement en commentaire ; zone à plus forte charge cognitive.
- **Sémantique surchargée `dim_mode`/`placement_mode`** avec verrous réactifs (`syncDimMode`/`syncDimLock`/`isDimLocked`) — brittle, dépendant des commentaires ([8651](netmap-v154-power-bolts.html#L8651), [8995](netmap-v154-power-bolts.html#L8995)).
- **Validation éparpillée** : l'état d'un câble est recalculé en **4 endroits** (`updateHint`/`syncStatus`, `routeRooms`/`dcConstraintFor`, et de nouveau dans `onSave`) → risque de divergence UI/sauvegarde. Idem règles CIDR/DHCP réécrites par formulaire. → `computeCableState(draft)` unique.
- **`style.cssText` inline** un peu partout dans les formulaires au lieu de classes CSS → non thématisable, répétitif.

---

## 8. Hygiène du dépôt & outillage

| Constat | Détail | Recommandation |
|---|---|---|
| **Pas de dépôt git** | `Is a git repository: false` | `git init` + commit par version ; remplace le versionnage manuel et **rend le changelog du header redondant à terme** |
| **119 Mo de snapshots** | 153 fichiers `.html` (v1→v154) | Une fois sous git, archiver/supprimer les anciens `.html` ; garder le dernier + tags git |
| **Copies accidentelles `(1)`** | 4 `.html` + 4 `.md` (ex. `netmap-v29-rack-mount-margin (1).html`) | Supprimer après vérif d'identité |
| **Tests non intégrés** | `Scrapped/` = anciens smoke-tests *jetés* | ✅ **FAIT (2026-06-19)** — harnais NEUF [Tests/](Tests/) (`node Tests/run.js`) : `node --check` + caractérisation. **213 PASS** sur v154→v172 (portable) : data layer/Store, cascade (12 collections), helpers `*Of`/updateBatch, géométrie pure + **placement side/wall + resolvePort3D**, entités, **garde glissé/clic (`clickGuardBlocks`)**, **points de passage waypoint (`waypointPassPoints`)**, **boîte 6 faces (`box6Faces`)**, **helpers données (`uniqIds`/`makeLabeler`)**, **taille + bbox de nœud GraphView (`graphNodeSize`/`graphNodesBBox`)**, **tri peintre 3D (`painterFarFirst`)**. Filet de régression pour les refactors de LOGIQUE/géométrie. (Le rendu DOM/SVG/3D reste à vérifier visuellement.) |
| **Pas de lint/build** | Le header impose `node --check` *manuel* avant livraison | Script `npm`/CI : extraction du script, `node --check`, lint, smoke-tests |
| **Manifests de modèle** | présents jusqu'à v147, à jour pour les versions « SCHÉMA » | OK — continuer |

---

## 9. Feuille de route priorisée (pistes à investiguer)

### P0 — Quick wins (faible risque, fort ROI)
1. **Mise sous git** + suppression des copies `(1)` + archivage des vieux snapshots. *(S, risque nul)*
2. **Rationalisation des commentaires inline** : strip `vNN` (cat. C, scriptable + relecture), suppression du code mort documenté (cat. A : `migrateFaceImages`, notes « RETIRÉ »), conversion des « à venir » en `TODO(...)`. *(M, risque faible — n'altère pas la logique)*
3. **rAF coalescing sur le rendu 3D** : `renderThreeD` appelé via `requestAnimationFrame` depuis orbit/pan/zoom. Gain immédiat sur la fluidité, faible risque. *(S→M)*

### P1 — Structurel & perf (cœur de l'amélioration)
4. **Séparer données et caméra dans la 3D** (dirty-check + cache des drawables, re-projection seule sur changement caméra) + **mémo de l'ordre de peinture par baie**. *(M/L, risque M — bien couvrir par smoke-tests de rendu)*
5. **Découper les méthodes géantes** en commençant par `_rackBox3D` (un émetteur par kind) puis `openEquipmentForm`/`openCableForm` (un sous-builder par section, `onSave` éclaté). *(L, risque M)*
6. **Factoriser les doublons transverses** (§4.1) : export, menu contextuel, `_box6Faces`, `_emitCable3D`, `_clickGuard`, `_buildWorldRoute`. *(M)*
7. **Source unique d'état câble** `computeCableState(draft)` + cache des listes du form câble. *(M)*

### P2 — Fond & robustesse
8. **Gestion d'erreur transactionnelle** : try/catch + rollback mémoire sur échec adapter ; garder `_read`/`_write` (quota, parse). *(M, risque M)*
9. **Cascade déclarative** (`_cascadePlan` → spec par collection) + index `rack_id` sur `waypoints` + undo par delta. *(L)*
10. **Constantes nommées** pour le z-layer 3D et les nombres magiques de force-layout. *(S, risque faible mais à valider visuellement)*
11. **Optimisations ListController** (mémo filtré/trié, debounce) et GraphView (convergence force-layout, `edgesByNode`, usage des maps `_nodeById`). *(M)*
12. **Modularisation** (objectif long terme) : extraire le JS en modules ES + petite étape de bundle pour rester mono-fichier livrable. *(L, risque H — à planifier seul)*

---

## Annexe — Santé par région (synthèse des analyseurs)

- **Couche de données** : architecture adapter/index/Store propre et réellement incrémentale. Dette = scans `waypoints` non indexés + narration `vNN`/legacy + géométries side/wall jumelles.
- **Store** : solide et indexé en lecture. Falaises = ré-hydratation complète sur undo/redo, scans `syncCatalogs` au load ; `_cascadePlan` 92 l. à clés-chaînes ; écritures adapter sans rollback.
- **ListController** : riche mais `render()` reconstruit tout par frappe ; familles `opt*`/`assign*` à factoriser ; `openEquipmentForm` (844 l.) et `openCableForm` (414 l.) = risques majeurs ; ~60 tags `vNN`.
- **GraphView** : rebuild SVG complet + force-layout O(M²) fixe ; état de position fragmenté ; formule de largeur dupliquée 5× (bug latent recenter).
- **DatacenterView** : la zone la plus critique. Scène reconstruite depuis le store à **chaque frame** d'orbite, tri peintre O(n²)/baie, `_rackBox3D` ~600 l. ; nombreux blocs boîte/câble/marqueur quasi-clones ; z-layering magique fragile.

*Fin du document.*
