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

- la **grammaire de route** (exits par paires, pins d'étage) vient de l'analyseur du Store : le service
  interroge `store.cableRoute` sur un **pseudo-câble** portant la route du trunk (`waypoint_ids`) —
  l'absence de ports évite les erreurs de bouts ;
- la **polyligne** (amorces ⊥, conduits, spline) vient de `CableRouting` injecté : helpers extraits
  `viaPoints` / `stubLineIn` / `worldLine`, partagés câbles ⇄ faisceaux ;
- dans un **conduit**, le faisceau occupe un **slot de répartition** comme un câble
  (`Resolver3D.conduitCablesOf` énumère câbles + trunks) : il traverse physiquement la section, et comme
  les brins piochés par ports ne sont pas dessinés, le trunk est LA ligne visible — centré, il
  chevaucherait un câble voisin ;
- une route saisie « à l'envers » (extrémité A dans la salle d'arrivée) est **tolérée** en inversant les
  bouts (le formulaire faisceau n'oriente pas la route comme le fait `orientEnds` côté câble).

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
  route inversée / visibilité partagée) ;
- `Tests/modules/test-shared-validation.js` + `test-core-store.js` — T10/T11 + dépendance inverse ;
- `Tests/modules/test-sync.js` — carte d'impact.
