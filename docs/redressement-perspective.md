# Redressement de perspective & assemblage des images de façade

Corriger la perspective d'une **photo de façade prise de biais** (baie ouverte, recul
impossible) avant de l'ajouter à la bibliothèque d'images — l'image redressée se plaque
proprement sur la face de l'équipement (2D et 3D). Issu du POC `poc/perspective.html`.
Quand un seul cliché ne suffit pas (façade trop large/haute), **deux photos peuvent être
assemblées** : chacune redressée, puis alignées et fusionnées (voir plus bas).

## Découpage (principe n°2 du CLAUDE.md)

| Module | Responsabilité |
|---|---|
| [`src-client/geometry/Homography.ts`](../src-client/geometry/Homography.ts) | **Géométrie pure** (sans DOM, testée dans `Tests/modules/test-geometry.js`) : homographie par DLT (vecteur propre min de AᵀA, itérations de Jacobi), `estimateAspect` (ratio réel d'un rectangle vu en perspective — points de fuite + focale auto ; repli côtés opposés en vue frontale), `warpBilinear` (rééchantillonnage, hors-source → alpha 0). |
| [`src-client/geometry/ImageStitch.ts`](../src-client/geometry/ImageStitch.ts) | **Géométrie pure de l'assemblage** (testée) : `resizeBilinear` (normalisation d'échelle), `gainForB` (compensation d'auto-exposition sur le recouvrement), `blend` (fondu linéaire le long de l'axe), `autoCropRect`/`crop` (union le long de l'axe, intersection en travers), `refine` (affinage ±N px par corrélation de luminance). |
| [`src-client/ui/PerspectiveEditor.ts`](../src-client/ui/PerspectiveEditor.ts) | **Modale interactive** (`Dialog.custom`) : canvas zoom/pan, 4 coins + 0–4 points de bord par côté (déformation non rectiligne → homographie en moindres carrés), modes de proportions (Façade / Auto / Manuel / 1:1), résolution. `open(blob, opts) → Promise<Blob|null>` ; `openRaw` → RawImage (enchaînement d'outils SANS ré-encodage intermédiaire). |
| [`src-client/ui/StitchEditor.ts`](../src-client/ui/StitchEditor.ts) | **Assemblage de 2 photos** : question « Redresser ? » par photo (→ PerspectiveEditor), puis écran d'alignement (A fixe, B glissable ; pelure d'oignon / mode différence ; échelle auto-normalisée sur la dimension partagée ± réglage fin ; « Affiner ±10 px ») et fusion (gain + fondu + recadrage auto). |
| [`src-client/ui/ImageBlob.ts`](../src-client/ui/ImageBlob.ts) | Conversions Blob ⇄ RawImage ⇄ canvas (encodage WebP q0.92, repli PNG) — mutualisées entre les deux éditeurs. |

Le **warp** (lourd) s'exécute **après** la fermeture de la modale, derrière l'indicateur
`Notify.busy` (double rAF pour laisser peindre) — même patron que les builds 3D coûteux.
Sortie **WebP q0.92** (compact + couche alpha pour les pixels hors du quadrilatère),
repli PNG si l'encodeur WebP est indisponible.

## Recadrage séparé (référence ≠ emprise utile)

Les meilleurs repères de redressement (bandeau sérigraphié, vis, trous de rail — nets et
vraiment rectangulaires) ne coïncident pas toujours avec l'emprise utile de l'image. Le
toggle **« Recadrage séparé »** (persisté, désactivé par défaut — le flux combiné reste le
chemin rapide) dissocie les deux :

1. les points posent une **RÉFÉRENCE** de rectification (ses proportions se mesurent en
   Auto — le préréglage façade est masqué : la référence n'est pas le panneau entier) ;
2. l'image source **entière** est projetée dans l'espace redressé (emprise via `H⁻¹`,
   bornée à ±4× la référence près de la ligne de fuite ; aperçu ≤ 2048 px) et l'emprise
   utile se choisit dans **`CropEditor`** (poignées, damier sous les zones hors-source,
   « Caler au ratio cible » quand le contexte façade est connu) ;
3. le cadre choisi est **re-warpé directement depuis la source** à pleine résolution
   (`Résolution` = côté le plus long du cadre) — un seul rééchantillonnage source → final.

Profite aussi à l'assemblage (chaque photo passe par `openRaw` qui respecte le toggle) :
caler le dewarp sur un petit rectangle net, puis recadrer large sur la portion visible.

## Assemblage de deux photos (modèle « redresser puis aligner »)

Une façade est **PLANE** : deux photos redressées par homographie ne diffèrent que d'une
**translation + échelle** (pas de parallaxe possible sur le plan — seul le relief en avant
du plan peut créer du fantôme dans le recouvrement). L'assemblage exploite cette propriété :

1. chaque photo est redressée sur **sa portion visible** (sans préréglage de ratio — le
   cliché ne couvre pas tout le panneau), points posés sur des repères nets (rails, vis, U) ;
2. l'échelle de la 2de est **auto-normalisée** sur la dimension partagée (hauteur en côte à
   côte, largeur en empilées) → l'alignement se réduit à un glisser (+ réglage fin ±10 %) ;
3. à la jonction : **compensation de gain** (l'auto-exposition varie entre clichés →
   couture sinon), puis **coupe franche** (défaut : la 1re photo prioritaire, la 2de
   croppée à la jonction — aucun mélange de pixels, pas de flou/fantôme) ou **fondu
   linéaire** dans le recouvrement (toggle persisté — adoucit la couture au prix d'un
   possible fantôme sur le relief), et **recadrage auto** (union le long de l'axe,
   intersection en travers — élimine les bandes transparentes du désalignement fin).

Conseil de prise de vue : ~20–30 % de recouvrement, dans une zone « propre » (sans relief).
N > 2 photos : itérer (le résultat se ré-assemble avec la photo suivante).

## Branchements dans le flux d'images de façade

1. **Import inline du sélecteur d'image** (`FaceEditor.imagePicker`, tuile « + Importer ») :
   après le choix du fichier, un **choix à 3 options** (`Dialog.choice`) : « Utiliser telle
   quelle » / « Redresser la perspective… » / « Assembler avec une 2de photo… ».
   Annuler un éditeur = abandonner l'import.
2. **Formulaire bibliothèque** (`Forms.faceImage`, onglet « Images de façade ») : boutons
   **« Redresser la perspective… »** (image fraîchement importée **ou** existante) et
   **« Assembler 2 photos… »** (2 fichiers) ; le résultat remplace le blob en attente
   (écrit au store à l'enregistrement).

Dans les deux cas, le mode de proportions est **pré-réglé au format réel de la façade**
déduit du contexte (`FormBase.faceImageRatio`) : panneau 19″ complet (482,6 mm, avant avec
oreilles) ou corps seul (452,6 mm), hauteur `U × 44,45 mm`. Face « autre » / équipement
libre → pas de format imposé (mode Auto).

## Téléchargement d'une image de façade

- **Liste « Images de façade »** : action « Télécharger » du menu ⋮ (`ListActions.download`).
- **Formulaire d'image** : bouton « Télécharger » (blob courant, y compris redressé non enregistré).

Nom de fichier : `ImageStore.downloadName` (nom assaini + extension déduite du MIME).

## Réglages persistés

`localStorage["dcmanager.perspective"]` (par navigateur, indépendant du document) :
points de bord par côté, résolution de sortie, mode de proportions, ratio manuel.
