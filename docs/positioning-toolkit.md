# Aide au positionnement (positioning toolkit)

Outil d'**aide au placement** d'une baie dans une salle via ses **coins**, par rapport
aux **murs** de la salle ou aux **coins d'autres baies** (ancres), avec des **cotes
perpendiculaires** aux côtés. C'est une AIDE : on déplace la baie « mover » et on écrit
`dc_x`/`dc_y` **une seule fois** — aucune relation (coin ↔ référence) n'est mémorisée
(pas de contraintes paramétriques persistantes). La baie-ancre, elle, ne bouge pas.

## Découpe (modulaire, portable à la vue Plan d'étage)

| Couche | Fichier | Rôle |
|---|---|---|
| **Cœur PUR** | [`src/geometry/Positioning.ts`](../src/geometry/Positioning.ts) | Géométrie sans DOM/store/vue : coins d'un rectangle, murs d'un cadre, distances/cotes ⟂, placement (`placeAxis`), accrochage (`snapCenter`). **Testé** (`Tests/modules/run.js`, section « Positioning »). |
| **Glue de vue** | [`src/views/dc/DcInteract.ts`](../src/views/dc/DcInteract.ts) (section « OUTIL DE POSITIONNEMENT ») | État + overlay SVG (poignées de coin, murs cliquables, cotes ⟂) + carte de panneau + glisser aimanté. Délègue toute la géométrie au cœur pur. |
| **État** | [`src/views/dc/DcBase.ts`](../src/views/dc/DcBase.ts) | Champ `positioning` (mover, coin actif, références X/Y, contexte). |

Le cœur est **générique** (rectangles alignés aux axes + un cadre), pas spécifique aux
racks : la vue **Plan d'étage** pourra le réutiliser tel quel avec les **salles** posées
sur un étage. Le seul point d'adaptation est `DcInteract.posScene()` qui renvoie le
**cadre**, la liste des **rectangles** déplaçables et la fonction d'**écriture** de la
position. Porter l'outil = fournir une variante « salles sur étage » de `posScene()` (+
appeler `drawPositioning2D` dans `renderFloor`).

## Repère & invariants

- Monde 2D en mm, `x` horizontal, `y` vertical (croît vers le bas). Cadre `[0,0]→[w,h]`.
- Les racks ont une orientation `0/90/180/270` → emprise au sol **axis-aligned** (cf.
  `rackHalfExtents`/`RackGeometry.halfExtents`). Les cotes sont donc **horizontales (X)**
  ou **verticales (Y)**, toujours ⟂ aux côtés. La permutation largeur/profondeur à 90°/270°
  est faite **en amont** (dans `posScene`), le cœur ne voit que des demi-extents déjà permutés.

## Interaction (vue Plan de salle)

1. Bouton **Positionnement** (barre d'outils du canevas, vue Dessus uniquement) → arme l'outil.
2. **Clic** sur une baie → elle devient la **mover** (ses 4 coins deviennent des poignées).
3. **Clic** sur une poignée de coin → **coin actif**.
4. **Référence** (deux possibles, une par axe) :
   - **Mur** (bande cliquable le long d'un bord) → fixe l'axe correspondant.
   - **Coin d'une autre baie** (poignée « ancre ») → fixe les **deux** axes (cote X et Y).
   Un mur recliqué remplace l'axe concerné → on peut combiner « X = mur, Y = coin d'ancre ».
5. **Deux modes complémentaires** pour régler la distance :
   - **Saisie numérique** : éditer la cote (mm) dans le panneau → la baie se place (côté conservé,
     pas de saut au travers de la référence).
   - **Glisser aimanté** : déplacer la baie ; ses bords s'**accrochent** aux murs et aux coins
     voisins (lignes-guides + cote flottante en direct).
6. **ÉCHAP** efface par paliers (références → coin → mover). L'outil est **éphémère** : rien
   n'est mémorisé hormis la position finale écrite dans le modèle.

## Choix notables

- **Le mover est la baie sélectionnée en PREMIER** ; toute autre baie sert d'**ancre** (intacte).
- Placement **borné à la salle** et **refusé sur une case inaccessible** (`GridGeometry.spanHitsBlocked`),
  cohérent avec le glisser normal.
- Outils **mutuellement exclusifs** (mesure / routage / positionnement) — un seul mode de clic à la fois.
- Persistance : `store.update("racks", id, { dc_x, dc_y })` (un pas d'undo) — en mode API,
  passe par le même chemin REST (verrou optimiste) que tout autre déplacement.
