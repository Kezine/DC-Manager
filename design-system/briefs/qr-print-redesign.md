# Carton — IMPRESSION D'ÉTIQUETTES QR : re-design ergonomique

**Demande utilisateur du 2026-09-01** (point T11 du chantier « retours terrain ») : *« l'UI
qrcode a un peu dérivé et n'est plus très ergonomique. Il faudra faire un carton avec les
différentes permutations/type etc. pour qu'on re-travaille l'ergonomie. »*
Objectif : re-designer **la modale d'impression** à partir de l'inventaire complet ci-dessous.
Au retour : maquette PULL dans `briefs/` (cycle habituel).

⚠ **Ce carton REMPLACE-T-IL `qr-etiquettes-imprimables.md` ? Non — il le SUCCÈDE.** La maquette
d'origine a été suivie fidèlement et fait toujours foi pour le RENDU IMPRIMÉ (gabarits, drapeau,
manchon, planche). Ce qui a dérivé, c'est **le panneau de réglages** : il a reçu six mois
d'ajouts contextuels sans qu'aucun ne soit dessiné avec les autres sous les yeux.

## 1 · Inventaire EXACT des permutations (source : `core/LabelPrintPolicy`)

**6 SUJETS** (`LabelPrintKind`) — mais **4 anatomies**, ce qui est le vrai découpage :

| Anatomie | Sujets | Ce qui les distingue |
|---|---|---|
| **Objet** | `equipment` | seul à offrir « Propriétaire » |
| **Baie** | `rack` | seul à offrir le format « Baie » (100 × 60) |
| **Drapeau** | `cable`, `bundle` *(`isFlagKind`)* | 2 extrémités, seuls à offrir les MANCHONS |
| **Petit matériel** | `spare`, `subEquipment` *(`isSpareLike`)* | gabarit S par défaut, pas de propriétaire |

**4 CONTENUS** (`LabelContentId`) : `full` (QR + texte) · `qr` (QR seul) · `strip` (manchon sans
QR, repère complet) · `id` (manchon sans QR, identifiant seul). **Les deux manchons ne sont
offerts qu'aux drapeaux.**

**6 FORMATS** (`LabelSizeId`) : `s` 50×20 · `m` 50×30 *(défaut)* · `l` 70×40 · `rack` 100×60
*(baies seulement)* · `cable` drapeau *(drapeaux seulement)* · `custom` (cotes libres).

**Autres axes** : densité (Compact / Confort) · **1 ou N étiquettes** (N ⇒ section « Planche » :
colonnes plafonnées + traits de coupe) · 4 cases de champ (Emplacement — qui devient
« Extrémités A / B » pour un drapeau — · Type/famille · N° de série · Propriétaire) · la ligne
« Identifiant (toujours) », non décochable.

## 2 · 🚨 LA DÉRIVE, mesurée : onze drapeaux de visibilité

`LabelControlsVisibility` (le verdict que la modale APPLIQUE sans jamais le calculer) compte
**onze** champs : `header` à trois valeurs (Format / Taille du QR / Manchon), `showSizeSelect`,
`showWidthHeight`, `showQrMm`, `showDiaLen`, `showMmRow`, `showIdRow`, `showFieldsSection`,
`fields` (∩ de l'offre du sujet et des règles du contenu), `locationAsEnds`, `showSheetSection`.

**Une seule modale se replie donc en un grand nombre de visages** (4 anatomies × 4 contenus ×
formats × 1-ou-N). Chacun a été ajouté isolément et est individuellement défendable ; c'est leur
COEXISTENCE qui n'a jamais été dessinée. Le symptôme est classique : l'utilisateur ne sait pas
prévoir ce qu'il verra, ni pourquoi un contrôle a disparu.

⚠ **Le principe qui a produit ces drapeaux reste JUSTE et doit survivre** : *ne jamais proposer
une case sans donnée derrière — ce serait un mensonge d'interface*. Le re-design doit garder
cette promesse **en la rendant lisible** (l'utilisateur doit COMPRENDRE l'absence), pas en
affichant tout partout — un retour terrain du 2026-08-20 avait justement demandé l'inverse
(« tous les contrôles dans tous les contextes ») et c'est ce qui a été corrigé.

## 3 · Les 11 points d'entrée (tous ouvrent LA MÊME modale)

Fiches : équipement · baie *(deux gestes distincts : « Étiquette de baie » ≠ « Planche du contenu
(N) »)* · câble *(« Un drapeau » et « Imprimer les 2 extrémités »)* · faisceau *(idem)* · spare ·
sous-équipement. Actions de ligne des listings : équipements · câbles · faisceaux · spares ·
sous-équipements. Plus le **PANIER** (cf. § 5).

## 4 · Comportements ACTUELS à connaître

- **Réglages mémorisés EN SESSION, par sujet** (jamais de préférence persistée — décision de
  cadrage) : le dernier tirage d'un même contexte revient tel quel. Un réglage mémorisé devenu
  invalide est ramené sur les défauts du contexte, silencieusement.
- **Aperçu vivant** à côté des réglages ; **avertissements** non bloquants : QR sous le plancher
  de scannabilité (18 mm), QR qui ne tient pas dans l'étiquette, colonnes plafonnées, planche
  multi-feuilles, manchon trop court pour son texte. **Aucun n'interdit** — on imprime pour son
  propre usage.
- **Impression** : iframe print-CSS isolée. Unitaire = `@page` à la taille EXACTE (imprimantes à
  rouleau Brother/Dymo) ; ≥ 2 = planche A4 (marge 8 mm, en-tête de 6 mm, grille, traits de coupe).
- **Mode API seulement** (le QR est généré par le serveur) : en mode fichier, toutes les entrées
  d'impression sont absentes — pas grisées, absentes.
- i18n fr/en intégrale ; la modale vit dans la **pile standard** (par-dessus la fiche appelante,
  ← y revient).

## 5 · Le PANIER change la volumétrie (à intégrer, pas à ignorer)

Le panier d'actions groupées imprime **100 à 200 étiquettes** en un tirage — c'est le cas d'usage
réel du terrain, et il passe par cette même modale avec N sujets. Un panneau pensé pour « une
étiquette » et un panneau pensé pour « une planche de 200 » n'ont pas les mêmes priorités :
la section Planche, aujourd'hui reléguée en bas, devient l'essentiel. Le panier est
**mono-famille** par construction : les N sujets d'un tirage partagent toujours la même anatomie.

## 6 · Douleurs identifiées (matière à re-design, pas une liste de solutions)

1. **Le panneau change de forme sans le dire.** Onze drapeaux ⇒ des contrôles apparaissent et
   disparaissent au fil des choix ; rien n'explique l'absence.
2. **« Format » est un axe fourre-tout** : il porte à la fois un gabarit d'étiquette, un drapeau
   de câble et un manchon — trois objets physiques différents sous un même intitulé, dont deux
   ne concernent qu'une anatomie.
3. **Deux entrées par objet pour les drapeaux** (« un drapeau » / « les 2 extrémités ») : la
   décision est prise AVANT d'ouvrir la modale, alors qu'elle est de même nature que celles qu'on
   y prend ensuite.
4. **La section Planche est en bas**, alors que c'est le mode dominant dès qu'on vient du panier.
5. **Les champs offerts sont un quatuor FIGÉ** (emplacement / type / série / propriétaire) : toute
   autre donnée est inimprimable, et un sous-équipement ou un spare n'ont pas les mêmes champs
   utiles qu'un équipement — cf. § 7.
6. Les **avertissements** cohabitent avec les réglages sans hiérarchie claire entre « ton QR sera
   peu lisible » et « ta planche fera 3 feuilles ».

## 7 · Entrée attendue du chantier T10 (champs dynamiques)

En parallèle de ce carton, le point T10 doit faire **descendre l'offre de champs du SUJET** :
chaque sujet déclarerait les champs qu'il POSSÈDE (libellé + valeur) au lieu de la matrice figée
à quatre noms. Conséquence pour la maquette : **la section « Informations additionnelles » doit
être dessinée pour une liste de longueur VARIABLE selon l'objet** (un spare voudra sa quantité et
son emplacement de stock, un sous-équipement son maître et son repère), bornée par ce que le
gabarit peut physiquement porter. Ne pas la dessiner comme quatre cases en dur.

## 8 · Contraintes — dont cinq pièges d'impression DÉJÀ payés cher

Primitives et tokens du design system ; fr d'abord ; cibles tactiles ≥ 44 px.

🚨 **Ces cinq contraintes ont été mesurées au prix fort le 2026-08-25 — une maquette qui les
ignore fera régresser l'impression** :

1. Le QR est dessiné **au trait** par la librairie : sans `shape-rendering="crispEdges"`,
   l'anti-aliasing amincit les modules jusqu'à les faire disparaître au plus petit gabarit.
2. Sans `print-color-adjust: exact`, le navigateur **supprime les fonds** à l'impression (les
   hachures de recouvrement du manchon sortaient blanches).
3. Traits de coupe : **un trait par ARÊTE**, jamais quatre bordures par cellule — sinon trait
   intérieur doublé et pointillés déphasés.
4. `1fr` et `border-box` : les cotes des étiquettes sont posées **en mm**, jamais en fractions.
5. `@page`, `html` et `body` à marge **nulle des deux côtés**.

Et deux invariants de fond : le **manchon fait 1,5 tour**, dont le demi-tour excédentaire EST le
recouvrement (la partie visible vaut donc UN tour) ; **une cellule de planche n'est pas une
étiquette** (l'étiquette s'y étire).

## 9 · Livrable attendu

Une maquette HTML dans `explorations/` (« Impression d'étiquettes QR - maquette ») montrant :

- le panneau de réglages re-pensé, **dans au moins 4 de ses visages** (équipement seul · drapeau
  de câble en manchon · planche de 150 depuis le panier · petit matériel en gabarit S) — c'est la
  COEXISTENCE de ces visages qui est le sujet, pas chacun pris isolément ;
- comment l'absence d'un contrôle **se comprend** (le principe « pas de case sans donnée » reste) ;
- la place de l'aperçu et la hiérarchie des avertissements ;
- la section « Informations additionnelles » à longueur variable (§ 7) ;
- les recommandations tranchées en notes, et un AVANT/APRÈS si la structure du panneau change.

**Hors périmètre** : le rendu imprimé lui-même (gabarits, drapeau, manchon, grille — la maquette
`qr-etiquettes-imprimables` fait toujours foi) et le **scan caméra**, qui a son propre carton
(`qr-saisie-camera-maquette.html`).
