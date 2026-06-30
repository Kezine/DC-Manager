# Aide au positionnement (positioning toolkit)

Outil d'**aide au placement** d'un élément via ses **coins**, par rapport aux **murs**
du cadre ou aux **coins d'autres éléments** (ancres), avec des **cotes perpendiculaires**
aux côtés. C'est une AIDE : on déplace l'élément « mover » et on écrit sa position **une
seule fois** — aucune relation (coin ↔ référence) n'est mémorisée (pas de contraintes
paramétriques persistantes). L'élément-ancre, lui, ne bouge pas.

Disponible dans **les deux vues 2D**, sur tous les éléments déplaçables au sol :

| Vue | Cadre | Éléments déplaçables | Champs écrits |
|---|---|---|---|
| **Plan de salle** (`top`) | la salle (`width_mm × depth_mm`) | **baies** + **équipements libres** de la salle | `dc_x`/`dc_y` (centre) |
| **Plan d'étage** (`floor`) | le plan d'étage (`cfg.width_mm × depth_mm`) | **salles** + **équipements d'étage** | salle : `floor_x`/`floor_y` (coin haut-gauche de l'emprise) · équipement : `floor_x`/`floor_y` (centre) + `location`/`floor` |

## Découpe (modulaire)

| Couche | Fichier | Rôle |
|---|---|---|
| **Cœur PUR** | [`src/geometry/Positioning.ts`](../src/geometry/Positioning.ts) | Géométrie sans DOM/store/vue : coins d'un rectangle, murs d'un cadre, distances/cotes ⟂, placement (`placeAxis`), accrochage (`snapCenter`). **Testé** (`Tests/modules/run.js`, section « Positioning »). |
| **Contrôleur d'outil** | [`src/views/dc/PositioningTool.ts`](../src/views/dc/PositioningTool.ts) | Module DÉDIÉ : état + overlay SVG (poignées de coin, murs cliquables, cotes ⟂) + carte de panneau + glisser aimanté générique (`dragEntity`). Ne dépend que de l'interface `PositioningHost` + du cœur pur. |
| **Adaptation de vue** | [`src/views/dc/DcInteract.ts`](../src/views/dc/DcInteract.ts) | Implémente `PositioningHost` : `posScene()` (entités déplaçables de la vue — UNIQUE point spécifique) + services (`posScale`, `posGRoot`, `posCtxKey`…). Branche `posTool` dans le rendu (`drawOverlay`), les handlers de drag et le panneau. |
| **Instance** | [`src/views/dc/DcBase.ts`](../src/views/dc/DcBase.ts) | Champ `posTool: PositioningTool`, instancié avec `this` comme hôte. |

Le cœur ET le contrôleur sont **génériques** (rectangles alignés aux axes + un cadre), pas
spécifiques aux racks. Côté vue, **tout passe par un seul accès** : `DcInteract.posScene()`
renvoie le **cadre** + la liste des entités déplaçables, chacune avec un `rect` (centre +
demi-extents en repère monde), un `anchor` (`"center"` + rotation, ou `"topleft"` pour une
salle) et un `commit(cx, cy)` qui écrit la position dans le modèle (conversion centre →
champs de l'entité + bornage + garde « case inaccessible » pour les éléments en salle).
Ajouter un type déplaçable = ajouter une entrée dans `posScene()` ; le reste (overlay,
cotes, snap, panneau, drag) est agnostique. **Porter l'outil à une nouvelle vue** = fournir
un hôte implémentant `PositioningHost` (notamment son `posScene()`).

## Repère & invariants

- Monde 2D en mm, `x` horizontal, `y` vertical (croît vers le bas). Cadre `[0,0]→[w,h]`.
- Les racks ont une orientation `0/90/180/270` → emprise au sol **axis-aligned** (cf.
  `rackHalfExtents`/`RackGeometry.halfExtents`). Les cotes sont donc **horizontales (X)**
  ou **verticales (Y)**, toujours ⟂ aux côtés. La permutation largeur/profondeur à 90°/270°
  est faite **en amont** (dans `posScene`), le cœur ne voit que des demi-extents déjà permutés.

## Interaction (vues Plan de salle ET Plan d'étage)

1. Bouton **Positionnement** (barre d'outils du canevas, vues 2D uniquement) → arme l'outil.
2. **Clic** sur un élément (baie/équipement/salle) → il devient la **mover** (ses 4 coins deviennent des poignées).
3. **Clic** sur une poignée de coin → **coin actif**.
4. **Référence** (deux possibles, une par axe) :
   - **Mur** (bande cliquable le long d'un bord) → fixe l'axe correspondant.
   - **Coin d'un autre élément** (poignée « ancre ») → fixe les **deux** axes (cote X et Y).
   Un mur recliqué remplace l'axe concerné → on peut combiner « X = mur, Y = coin d'ancre ».
5. **Deux modes complémentaires** pour régler la distance :
   - **Saisie numérique** : éditer la cote (mm) dans le panneau → l'élément se place (côté conservé,
     pas de saut au travers de la référence).
   - **Glisser aimanté** : déplacer l'élément ; ses bords s'**accrochent** aux murs et aux coins
     voisins (lignes-guides + cote flottante en direct).
6. **ÉCHAP** efface par paliers (références → coin → mover). L'outil est **éphémère** : rien
   n'est mémorisé hormis la position finale écrite dans le modèle.

## Choix notables

- **Le mover est l'élément sélectionné en PREMIER** ; tout autre élément sert d'**ancre** (intact).
- Placement **borné au cadre** ; en salle, **refusé sur une case inaccessible**
  (`GridGeometry.spanHitsBlocked`), cohérent avec le glisser normal.
- Une **salle** d'étage est ancrée par son **coin haut-gauche** (`floor_x`/`floor_y`) mais raisonnée
  par son **centre** dans le cœur pur (`positionNodeTransform`/`commit` font la conversion via le footprint orienté).
- Outils **mutuellement exclusifs** (mesure / routage / positionnement) — un seul mode de clic à la fois.
- Persistance : un `store.update(...)` par déplacement (un pas d'undo) — en mode API, même chemin REST
  (verrou optimiste) que tout autre déplacement. OOB et point d'ancrage d'étage gardent leur drag normal.
