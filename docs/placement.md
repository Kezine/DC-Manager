# Placement & repères — doctrine de l'application

> **Doctrine**, pas plan de refonte. Ce document dit ce qu'est un placement dans DC Manager, quelle
> règle suivre pour tout nouveau contenu spatial, et comment l'existant converge vers ce modèle.
> Il gouverne conjointement le chantier « contenu hors-salle » et la migration relationnelle
> (cf. `persistance.md`) : les deux figent le MÊME modèle, les concevoir séparément reviendrait à le
> figer deux fois de façons incompatibles.

## 1. Le constat : une hiérarchie née par accrétion

L'application s'est construite par élargissements successifs du cadre spatial :

```
baie  →  salle  →  étage  →  multi-étage  →  multi-bâtiment
```

À chaque élargissement, le niveau précédent était déjà câblé en dur. La hiérarchie spatiale est donc
**implicite** : elle existe dans l'UI et dans la tête de l'utilisateur, mais n'est portée par AUCUN
objet du code. Chaque couche la re-dérive à sa façon, à partir de FK éparses (`rack_id`, `dc_id`,
`tray_item_id`, `location` + `floor`).

Trois symptômes observés, tous ramenant à cette cause unique — ils sont cités parce qu'ils sont
FACTUELS et vérifiables, pas comme illustration rhétorique :

1. **La même erreur dans deux couches.** Le mode « Vue étage » portait deux garde-fous indépendants
   (`DcPanels`, puis `DcBase`) testant tous deux le NOMBRE DE SALLES pour décider d'un rendu qui dépend
   du REPÈRE. Sans nom pour distinguer *repère* et *portée*, chaque couche réinvente la distinction —
   et se trompe de la même manière.
2. **Une fonction écrite, documentée, sans consommateur.** `FloorLayout.equipFloorWorld` calculait
   depuis longtemps la position monde d'un équipement d'étage. Personne ne l'a branchée : il n'y avait
   pas de place pour elle dans le modèle de résolution.
3. **Cinq branches pour une seule mécanique.** `Resolver3D.resolveFaceAnchor3D` répète cinq fois
   « prendre une boîte locale, la tourner par l'orientation de l'hôte, la translater à sa position » —
   une branche par mode de placement. La sixième (étage) est IMPOSSIBLE à écrire dans ce moule, parce
   que son hôte n'est pas une salle.

## 2. La notion manquante : le CONTENEUR DE PLACEMENT

Un **conteneur de placement** est un objet qui possède un repère local et une transformée vers son
parent. La hiérarchie réelle est :

```
monde
 └─ bâtiment (location)        translation en X (bande de bâtiment)
     └─ étage (floor)          translation en Z (niveau)
         ├─ plan d'étage       repère du plan (ancre anchor_x/anchor_y)  ← porte du contenu DIRECT
         └─ salle (datacenter) translation + rotation (floor_orientation)
             ├─ contenu libre  translation + rotation (dc_x/dc_y, dc_orientation)
             └─ baie (rack)    translation + rotation (dc_x/dc_y, orientation)
                 └─ emplacement  U · étagère · marge latérale · paroi
```

**Deux axes ORTHOGONAUX en découlent, à ne jamais confondre** — c'est la leçon du symptôme n°1 :

- le **REPÈRE** : à quel niveau de la chaîne la vue s'enracine (salle seule, ou bâtiment) ;
- la **PORTÉE** : quels sous-arbres sont affichés.

Le nombre d'éléments affichés ne dit RIEN du repère pertinent. Une salle unique dans un bâtiment reste
un contenu de bâtiment.

## 3. Règles (à appliquer à toute contribution)

1. **Un placement se lit comme une CHAÎNE de conteneurs, pas comme un cas particulier.** Résoudre un
   point = partir d'un point LOCAL et composer les transformées en remontant la chaîne. Si l'on écrit
   une n-ième branche qui recompose à la main « rotation de l'hôte puis translation », c'est le signe
   qu'un conteneur manque.
2. **Ne JAMAIS conditionner un comportement de REPÈRE au NOMBRE d'éléments.** `length > 1`, `length
   <= 1` sur des salles, des étages ou des bâtiments pour décider d'un rendu ou d'un mode est un bug
   par construction. Le cas dégénéré (un seul élément) doit suivre le MÊME chemin.
3. **Tout conteneur doit pouvoir porter du contenu DIRECT.** Un étage porte des équipements sans passer
   par une salle ; une salle porte des équipements sans passer par une baie. Un conteneur qui ne sait
   porter que d'autres conteneurs est une régression du modèle.
4. **La géométrie de composition est PURE et vit dans `geometry/`** (principe n°2) ; les vues ne font
   qu'appliquer. Aucune transformée ne se recalcule dans une vue.
5. **Le repère d'un point résolu doit être EXPLICITE.** « Monde » et « local à la salle » ne se
   devinent pas. ⚠ Dette actuelle : la docstring de `Resolver3D.resolveFaceAnchor3D` annonce « monde »
   alors qu'elle renvoie du LOCAL SALLE — corriger au passage de toute contribution sur ce fichier.

## 4. Stratégie de convergence — par le BAS, jamais big-bang

Le code concerné (ports, câbles, faisceaux, rendu 3D) est le plus subtil et le mieux testé de
l'application. Une réécriture d'un bloc serait déraisonnable. La convergence se fait donc ainsi :

1. **Commencer par le cas qui NE RENTRE PAS** dans le modèle actuel, pas par ceux qui marchent. C'est
   là que le nouveau modèle paie immédiatement, et le seul endroit sans risque de régression : il n'y
   a rien à casser.
2. **Migrer UN mode de placement à la fois**, derrière les tests existants (`Tests/modules/`, modules
   purs) qui servent de filet.
3. **Extraire l'abstraction à la DEUXIÈME occurrence, pas à la première.** On ne fabrique pas un
   `PlacementFrame` générique sur un seul cas : sa forme n'est pas encore connue et on figerait une
   généralisation spéculative. On nomme le conteneur, on compose explicitement, et on extrait quand le
   deuxième mode migre.
4. **Aucun élargissement de périmètre non demandé.** Un lot = un mode, vérifié, commité.

### 4.1 Méthode de vérification d'une migration

Le rendu est la seule partie de l'application SANS couverture automatique : la comparaison visuelle
n'y est donc pas un confort, c'est l'unique vérification possible. Elle s'organise ainsi :

- **BASCULEMENT À CHAUD, pas de vue dupliquée.** Un réglage choisit quel chemin de RÉSOLUTION alimente
  le descripteur de scène (historique / conteneur) ; la vue se reconstruit en place. Deux vues côte à
  côte ne partagent ni caméra, ni zoom, ni instant — elles rendent invisible l'écart de quelques
  millimètres qu'on cherche justement à voir.
- **L'interrupteur se place SOUS les deux rendus.** La 2D et la 3D consomment les MÊMES primitives de
  placement (`FreeEquipGeometry`, `FloorLayout`, `RackScene`) : un commutateur au niveau de la
  résolution les couvre donc toutes les deux. Dupliquer une vue n'en couvrirait qu'une, et clonerait
  au passage la couche qui ne change pas (matériaux, libellés, saillies anti z-fighting, picking).
- **La duplication se fait au bon endroit** : deux implémentations d'une même interface de résolution,
  jamais deux arbres de rendu.
- **PARITÉ NUMÉRIQUE d'abord.** La résolution étant pure, on fait tourner les deux chemins sur un même
  document et on compare les points résolus : cela attrape les écarts sub-millimétriques qu'aucun œil
  ne verra. La 2D s'y prête particulièrement — ses vues sont minces, elles ne font que mapper en SVG
  des positions calculées par des modules purs.
- **Le visuel est réservé à ce que lui seul juge** : en 2D le placement des libellés et l'empreinte ;
  en 3D les matériaux, la lisibilité et le z-fighting.
- **Période parallèle BORNÉE et ancien chemin GELÉ.** Dès qu'une correction atterrit sur un chemin sans
  l'autre, la comparaison ne prouve plus rien et l'on entretient deux mondes. « Une fois validé, on
  retire » doit être une ÉCHÉANCE, pas une intention.

## 5. Articulation avec le modèle relationnel

`persistance.md` acte la migration du serveur vers un vrai modèle relationnel au prochain remaniement
DB, `DataValidation.ts` faisant foi. Le conteneur de placement est PRÉCISÉMENT ce qu'un schéma
relationnel obligerait à nommer : aujourd'hui la hiérarchie est dispersée dans des FK optionnelles
mutuellement exclusives (`rack_id` XOR `dc_id` XOR `tray_item_id` XOR `location`+`floor`), avec des
invariants de cohérence écrits à la main dans la spec.

Conséquence pratique : **toute décision de modélisation du placement prise ici engage le schéma futur**
et réciproquement. Les six `placement_mode` actuels (`manual`, `rack`, `side`, `wall`, `floor`, `tray`)
ne sont pas six natures d'objet : ce sont **six types d'attache à un conteneur parent**. C'est cette
lecture qui devra guider le schéma.

## 6. Décisions de modélisation (arbitrées le 2026-07-27)

Ces décisions gouvernent la suite du chantier ET la migration relationnelle. Elles sont issues
d'un arbitrage explicite avec l'utilisateur ; les alternatives écartées sont notées, car ce sont
précisément les questions qu'on se repose six mois plus tard.

### 6.1 La responsabilité du placement appartient au CONTENEUR

Chaque conteneur place ses propres contenus : l'étagère les siens, la baie les siens, la salle les
siens, l'étage les siens. Aujourd'hui cette responsabilité est éclatée PAR MODE chez l'appelant — les
cinq branches de `resolveFaceAnchor3D`, les trois `…EquipBoxLocal` de `RackGeometry`,
`FreeEquipGeometry` pour la salle, `RackResize.fallout` pour la cage, `trayArrange`/`trayFindSpot` pour
le plateau. Chacune sait déjà placer *ses* contenus, mais aucune ne le dit. Nommer le conteneur donne
un porteur à ces règles, et le chaînage remplace le `switch`.

### 6.2 Interface COMMUNE mais ÉTROITE, DÉRIVÉE de l'existant

Les conteneurs sont dissemblables dans leur **paramétrage d'attache** (baie = index U + face + drapeaux
de profondeur ; plateau = x/y mm ; salle = x/y/z + lacet ; étage = x/y sur plan). Ce paramétrage **ne
fait PAS partie de l'interface** — l'y forcer produirait une union qui fuit.

N'est commun que ce qui existe déjà quatre fois : **remonter au parent**, **donner la boîte locale d'un
contenu**, **dire si un contenu tient**. Le placement AUTOMATIQUE n'existe que dans deux conteneurs sur
quatre → optionnel, hors interface de base. Règle : on n'ajoute à cette interface que ce qui est
constaté dans au moins deux implémentations.

### 6.3 RÉFÉRENCE UNIQUE au conteneur immédiat ; ancêtres DÉRIVÉS

Un contenu porte **une seule** référence — son conteneur immédiat. Tous les ancêtres se déduisent en
remontant la chaîne. **Aucune référence croisée vers un grand-parent.**

Le dépôt applique déjà les DEUX patrons, incohéremment : un équipement posé sur une étagère ne
référence que `tray_item_id` et sa salle est retrouvée par chaînage (correct) ; mais `location`,
`floor` et `room` sont **recopiés** du parent sur les baies et les équipements (« LOCALISATION héritée
par les baies / équipements LIBRES posés dans la salle », et le formulaire de baie écrit
`location: placeDc.location`). Ces copies sont à resynchroniser à la main dès qu'une salle change de
bâtiment — c'est la référence croisée à supprimer.

Conséquence heureuse : l'état « **non placé** » disparaît comme cas spécial. Une baie hors salle n'est
pas *nulle part*, elle est attachée au niveau **bâtiment**. La chaîne a des niveaux, et un contenu
s'attache à celui où il est posé — ce qui est exactement la lecture des six `placement_mode` : *à quel
niveau je m'attache, et comment*.

⚠ **Coût assumé et sa parade.** Dériver `location` supprime le filtrage et le regroupement bon marché
des listings, alors que la persistance actuelle fait un balayage complet sur un `find` par champ
(cf. `persistance.md`). On ne garde donc PAS ces champs autoritatifs, on les **rétrograde en CACHE
DÉRIVÉ** : recalculés à l'écriture, jamais source de vérité. Ce qui change est l'AUTORITÉ, pas
forcément la présence physique du champ.

### 6.4 L'étage est un CONTENEUR, pas une « salle virtuelle »

Tentation écartée : créer un enregistrement `datacenters` représentant l'étage. Un étage CONTIENT des
salles → ce serait une salle contenant des salles, emboîtement absent du modèle, qui casserait
`racksOfDc`, le rendu des murs, des portes et de la dalle, et exigerait un drapeau « virtuelle » pour
l'exclure des listings, sélecteurs, cascade et formulaires — donc le retour des cas particuliers, plus
deux sources de vérité pour le même étage.

Retenu : généraliser la **clé** dont dépend la machinerie de câblage, de « salle » à « conteneur ».
Bénéfice décisif : un câble baie → équipement d'étage part du conteneur *salle* et arrive dans le
conteneur *étage*, il traverse donc deux conteneurs et doit sortir par un exit — **physiquement exact**,
et déjà exprimable par la grammaire de route. L'exception « finir dehors est légal » qu'on envisageait
devient inutile : on RETIRE un cas particulier au lieu d'en ajouter un.

⚠ L'identité du conteneur étage est le couple **(bâtiment, étage)**, pas un `id` de `floors` : un étage
non configuré n'a pas d'enregistrement (`FloorLayout.config` renvoie un défaut virtuel à `id: null`).
Ce couple est déjà l'identité de fait (`allFloorKeys`, `oobWorld`, filtre des étages affichés).

### 6.5 Prérequis et garde-fous

- **Cascade RÉCURSIVE requise.** Sous chaînage pur, supprimer une salle doit propager jusqu'au bout de
  la chaîne. La cascade actuelle est non récursive (dette connue produisant des orphelins) : elle
  devient un **prérequis** de ce modèle, plus un nettoyage optionnel.
- **Garde de profondeur** sur le chaînage (cycle de références → boucle infinie).
- **Validation renforcée ET simplifiée** : « exactement une référence de conteneur, cohérente avec le
  mode » interdit par construction les combinaisons illégales aujourd'hui écrivables (`rack_id` ET
  `tray_item_id` renseignés).
- **Où ça vit** : `src-shared/`, collaborateurs INJECTÉS et non importés (patron `PowerAnalysis`, cité
  comme cible par `CLAUDE.md`). C'est ce qui fait DISPARAÎTRE la duplication `TrayFit` ⇄ `RackGeometry`
  au lieu de la contourner.
- **NE PAS toucher aux champs PERSISTÉS** pendant le refactor de code : les conteneurs *interprètent*
  les FK existantes. Coupler le refactor à une migration de données ferait perdre la réversibilité. La
  migration relationnelle suit, avec des concepts déjà éprouvés par l'usage.

### 6.6 La chaîne se COUPE EN DEUX : transformées intrinsèques vs LAYOUT

Constat fait en migrant (2026-07-27), qui corrige la lecture naïve « une seule chaîne de transformées » :

- **Sous la salle** (étagère → baie → salle), la transformée est **INTRINSÈQUE** : elle se déduit des seuls
  enregistrements (`dc_x`/`dc_y`/`orientation` d'une baie, position d'une salle sur son plan). Elle est donc
  calculable par le conteneur, sans contexte.
- **Au-dessus** (étage → bâtiment), elle est une **DÉCISION DE LAYOUT** : la bande d'un bâtiment résulte du
  rangement des bâtiments côte à côte avec des écarts, le Z d'un niveau de l'empilement des hauteurs
  d'étages. Ces valeurs dépendent de l'ENSEMBLE affiché, pas de l'enregistrement — c'est `multiLayout` qui
  les produit, et elles changent avec la portée.

C'est ce qui explique — et JUSTIFIE — que `Resolver3D` rende du LOCAL SALLE : au-dessus de la salle, il n'y
a pas de position intrinsèque à rendre. **Un conteneur ne peut donc pas exposer un `toParent()` uniforme
jusqu'au monde.** L'interface doit distinguer les niveaux intrinsèques (transformée propre) des niveaux de
layout (transformée fournie par le contexte d'affichage). Prétendre l'inverse produirait une abstraction qui
ment, du type de celles que cette doctrine cherche justement à éliminer.

> **Mise à jour (§6.9 livrée).** Le niveau SITE a basculé du côté INTRINSÈQUE : sa position se dérive
> désormais du modèle (coordonnées déclarées, sinon rang dans la collection), plus d'un rangement. La
> coupure remonte donc d'un cran — elle ne subsiste qu'entre l'ÉTAGE (dont le Z vient encore de
> l'empilement des hauteurs) et le reste. C'est bien ce qu'annonçait §6.8 : la coupure n'était pas une
> propriété du domaine, mais la conséquence d'un conteneur sans géométrie.

### 6.7 Duplication `TrayFit` ⇄ `RackGeometry` : SUPPRIMÉE — **IMPLÉMENTÉ**

§6.5 affirmait que loger l'abstraction dans `src-shared/` ferait « disparaître » la duplication
`TrayFit` ⇄ `RackGeometry`. La géométrie de l'étagère vit désormais **une seule fois**, dans
`src-shared/TrayGeometry.ts`, consommée par le RENDU (`RackGeometry.tray*`, qui délègue) ET par la
VALIDATION (règles T2d / V6e), avec ses sept constantes.

> **Correction de la version précédente de ce paragraphe.** Il affirmait que `DataValidation.ts`
> « ne pourra JAMAIS importer ce module » parce que les fichiers de `src-shared/` sont auto-suffisants.
> C'est **faux comme énoncé technique**, et la prémisse n'avait jamais été testée. Mesure faite avant de
> choisir (fichier sonde importé en `./__probe.js`, puis jeté) :
>
> | Chaîne | Verdict |
> |---|---|
> | `tsc --noEmit` racine (résolution *bundler*) | **PASSE** |
> | `tsc --noEmit` serveur (NodeNext) | **PASSE** |
> | `webpack --mode production` | **ÉCHOUE** — `Can't resolve './__probe.js'` |
>
> TypeScript 5.9 ramène de lui-même un spécificateur `.js` sur le `.ts` correspondant, dans les DEUX
> résolutions. Le seul point de rupture est **webpack**, dont la résolution AJOUTE les extensions au lieu
> de les substituer (il cherche `./__probe.js`, `./__probe.js.ts`, `./__probe.js.js`). Un
> `resolve.extensionAlias: { ".js": [".ts", ".js"] }` dans `webpack.config.js` fait passer les trois
> chaînes — vérifié, puis annulé.
>
> **L'auto-suffisance de `src-shared/` est donc un choix de CONFIGURATION DE BUILD, révocable en une
> ligne, pas une fatalité de TypeScript.** Elle est maintenue ici (toucher à la résolution de modules du
> bundle entier déborde d'un lot de déduplication), mais elle doit être énoncée pour ce qu'elle est.

**Décisions prises À L'IMPLÉMENTATION** — avec les alternatives écartées et leur motif :

- **Injection par OBJET NOMMÉ, pas par 5ᵉ paramètre anonyme.** `ValidationCollaborators { trayGeometry? }`
  traverse `validateRecord` / `normalizeAndValidate` / `validateDependents` et descend jusqu'aux règles
  (`CrossEntityRule` et `ScopeRule` gagnent un paramètre). Le nom du collaborateur reste lisible au point
  d'appel, et l'objet accueillera les suivants sans nouvelle rupture de signature.
- **Interface ÉTROITE et STRUCTURELLE** (doctrine §6.2). `DataValidation.ts` déclare `TrayGeometryPort` :
  exactement les quatre opérations que les règles consomment. Comme il ne peut pas importer le type, la
  garantie vient du typage structurel — les points d'INJECTION vérifient `TrayGeometry` contre le port, donc
  toute dérive de signature casse `tsc`. Écarté : un port `any`, qui aurait rendu la dérive indétectable.
- **Le collaborateur manquant fait ÉCHOUER FERMÉ.** C'est le vrai danger du patron : un appelant qui oublie
  d'injecter arrêterait la règle **en silence** — exactement le défaut du `FieldSpec.max` déclaré mais inerte
  (une contrainte muette est pire qu'une contrainte absente). Sans géométrie, T2d REFUSE tout équipement posé,
  avec un message qui nomme le collaborateur. Écarté : rendre le paramètre **obligatoire** pour que le
  compilateur serve de garde-fou — impossible sans réordonner les paramètres (`fetch`/`find` sont optionnels
  et précèdent), et surtout **inopérant là où ça compte** : les 221 appels de la suite de tests sont en JS,
  que le compilateur ne voit pas. Le garde-fou d'exécution couvre les deux mondes. Vérifié par sonde : le
  neutraliser fait ROUGIR les tests.
- **La profondeur de CAGE se passe en NOMBRE** (`plank(cageMm, tray)`), jamais l'enregistrement de baie. La
  géométrie du plateau n'a pas à connaître la politique de profondeur d'une baie (marges, cavités de portes,
  bornage). Conséquence assumée : le CALCUL de la cage reste dupliqué (`RackGeometry.cageDepth` ⇄
  `RackDepth.cage`) — hors périmètre, et **ces deux calculs divergent déjà** (le front ne borne pas
  `cage_depth_mm` à la profondeur extérieure, la validation si). Passer un nombre PRÉSERVE cette divergence
  à l'identique au lieu de l'arbitrer en douce.
- **Les signatures publiques de `RackGeometry.tray*` ne changent pas** (`Resolver3D`, `DcInteract`,
  `DcThreeScene`, `EquipmentForms`, `RackForms` et leurs tests les consomment) : elles deviennent l'ADAPTATION
  au repère de baie de primitives exprimées, elles, dans le repère du PLATEAU.
- **Le VERDICT est partagé, la PHRASE ne l'est pas.** `fitProblem` rend un code + les cotes ; la validation en
  fait un `path` + un message de formulaire, le front une phrase d'aide à la saisie. Ce sont deux produits
  différents, pas une duplication — les fusionner aurait fait remonter de la présentation dans la géométrie.
- **Constantes** : le module partagé est la source unique des cotes PROPRES à l'étagère
  (`TRAY_DEPTH_DEFAULT_MM`, `TRAY_SHEET_RESERVE_MM`, `TRAY_GUSSET_CLEARANCE_MM`), que
  `src-client/domain/constants.ts` se contente de RÉ-EXPORTER. Les constantes GÉNÉRALES de baie (`U_MM`,
  `RACK_MOUNT_WIDTH`, `RACK_EAR_MM`, `RACK_EAR_STANDOFF_MM`) restent RÉPLIQUÉES : elles servent toute la
  géométrie de baie, les migrer serait un lot à part. Un test anti-divergence verrouille leur égalité.
- **Parité prouvée AVANT bascule, puis attentes EXPLICITES.** 415 872 comparaisons sur une grille de 6 baies ×
  64 étagères × 180 équipements, entre l'ancien code (relu depuis git) et le nouveau : **zéro divergence sur
  tout le chemin de RENDU**, et **zéro bascule accepté ⇄ refusé** sur le chemin de validation. Les tests livrés
  ne comparent PAS les deux implémentations (elles n'en font plus qu'une : la comparaison serait tautologique,
  cf. §4.1) mais figent des valeurs EN DUR.

**Deux DIVERGENCES trouvées entre les deux implémentations** (le résultat le plus utile du lot) :

1. **Empreinte trop grande pour le plateau** : le front la signalait comme telle (« empreinte … > plateau … »),
   la validation la signalait comme un débord de POSITION (`tray_x`/`tray_y`). Même verdict — l'écriture était
   refusée des deux côtés — mais le formulaire pointait le champ de position alors que la faute est la TAILLE.
   Version retenue : celle du front. La validation désigne désormais `free_w_mm`/`free_l_mm` (en tenant compte
   de la rotation, qui échange les deux). Seul changement observable du lot.
2. **Orientation non entière** : le front TRONQUE l'angle avant de décider de la permutation
   (`Normalize.rackOrientation`), la validation testait l'angle flottant — à `dc_orientation: 90.5`, le rendu
   dessinait une empreinte permutée que la validation contrôlait NON permutée. Version retenue : celle du
   front, pour que ce qui est validé soit ce qui est dessiné.

**Non fait, volontairement** : le mode de placement `tray` n'est PAS migré vers le modèle de conteneur — ce lot
ne fait que la déduplication. Signalé au passage, non corrigé : la branche `no_space` de `fitProblem` (« aucun
espace au-dessus du plateau ») est **INATTEIGNABLE** — `availH = max(1, u_height) × 44,45 − 5 ≥ 39,45`. Elle
existait déjà des deux côtés ; elle est conservée en défense.

### 6.8 RÈGLE GÉNÉRALE : dériver du MODÈLE DÉCLARÉ, jamais de l'ENSEMBLE AFFICHÉ

Formulation unifiée de ce que §6.6 constatait comme une fatalité — et qui n'en est pas une.

La coupure « transformées intrinsèques en bas / layout en haut » n'est PAS une propriété du domaine :
c'est la conséquence directe d'un bâtiment sans géométrie (la spec `sites` ne porte que `name` et
`address` — le seul niveau de la hiérarchie sans taille ni position, hérité de l'époque où il n'y en
avait qu'un). Quand un conteneur n'a ni taille ni position, la seule issue est d'en improviser une par
rangement — d'où un layout qui dépend de ce qu'on affiche.

**La règle qui referme la coupure, sans aucun changement de schéma :**

> Toute grandeur géométrique se dérive du MODÈLE DÉCLARÉ (tous les étages, toutes les salles, tous les
> sites du document), JAMAIS de l'ensemble AFFICHÉ.

C'est le principe *repère ⊥ portée* appliqué à la géométrie : **la portée décide de ce qu'on VOIT,
jamais de OÙ SONT les choses.** Une seule règle couvre la largeur d'un bâtiment, l'ordre des bâtiments,
la hauteur d'un niveau et son altitude. Corollaire opératoire : on calcule le layout COMPLET à partir du
modèle, puis on FILTRE ce qu'on émet — on ne calcule jamais un layout à partir d'un sous-ensemble.

Deux corrections que cette règle impose à l'existant :

- l'ordre des bâtiments est trié en plaçant celui de la salle ACTIVE en premier — un souci d'affichage
  encodé dans la géométrie. Ordre STABLE (par site), et c'est la **caméra** qui va sur la salle active,
  pas le monde qui se réarrange autour d'elle ;
- **un site MASQUÉ conserve sa place.** Masquer retire du dessin, jamais du repère.

La déclaration de taille reste souhaitable, mais devient une **CONTRAINTE** (un plan d'étage ne peut
déborder de son bâtiment) et non un prérequis. Étant opt-in, elle ne peut pas rétro-invalider un
document : seuls les bâtiments qu'on a choisi de fixer sont contrôlés. — **IMPLÉMENTÉ**
(`sites.width_mm`/`sites.depth_mm`, règle cross-entité sur `floors`, emprise de `BuildingBand` dans
`FloorLayout.multiLayout`, champs au formulaire Site).

**Décisions prises À L'IMPLÉMENTATION** — comme en §6.9, avec les alternatives écartées et leur motif :

- **La contrainte est une règle CROSS-ENTITÉ (V5) sur `floors`, pas un invariant (V3).** Un invariant ne
  voit que son propre enregistrement ; il faut ici lire le SITE PARENT. Écarté : recopier la taille du
  bâtiment sur chaque étage pour la rendre lisible intra-enregistrement — ce serait exactement la
  référence croisée que §6.3 supprime, à resynchroniser à la main dès qu'un bâtiment change de taille.
- **Vérifiée AUX DEUX BOUTS.** La règle V5 refuse l'étage trop grand ; la dépendance inverse (V5b,
  `sites.dependents` → `floors` par `location`) re-valide les étages quand le bâtiment change. Sans elle la
  contrainte serait unilatérale : on interdirait d'agrandir le plan tout en laissant RAPETISSER le bâtiment
  sous lui — le même document incohérent, obtenu par l'autre porte.
- **`floors.location` reste une CHAÎNE, jamais `ref: "sites"`.** Tentation immédiate : la règle lit le site
  parent, autant déclarer la clé étrangère. Écarté — le dépôt contient des `location` HISTORIQUES (slugs de
  la table `LOCATIONS`, cf. `Store.siteLabel`) sans enregistrement `sites`. La FK les ferait rejeter par
  l'intégrité référentielle (V2) : une rétro-invalidation massive, précisément ce que le caractère opt-in
  doit empêcher. La règle est donc DÉFENSIVE — site introuvable ⇒ non applicable, jamais une erreur.
- **La contrainte porte sur `ancre + dimension`, pas sur la dimension seule.** Un plan ancré à 5 000 mm dans
  un bâtiment de 20 000 mm ne peut mesurer que 15 000 mm. Ne contrôler que la dimension laisserait sortir un
  plan par son ANCRAGE, c'est-à-dire par le champ non contrôlé.
- **Seuls les étages CONFIGURÉS sont contraints**, et c'est voulu : la collection `floors` n'existe que pour
  eux — un étage non configuré n'a pas d'enregistrement (`FloorLayout.config` lui rend un défaut virtuel à
  `id: null`). Contraindre un défaut virtuel reviendrait à refuser une saisie que personne n'a faite.
- **Largeur et profondeur sont INDISSOCIABLES** (invariant de spec), même raisonnement que lat/lon : une
  demi-taille ferait retomber le rendu sur l'emprise déduite en laissant croire le bâtiment fixé, et ne
  contraindrait qu'un seul axe.
- **L'emprise déclarée REMPLACE l'emprise déduite, elle ne s'y ajoute pas.** `BuildingBand.x1`/`y1` valent
  l'origine du site plus la taille déclarée ; sans déclaration, le calcul historique (le plus grand plan
  d'étage, ancre comprise) est conservé AU MICRON — c'est ce que verrouille le test de parité. Écarté :
  prendre le MAXIMUM des deux, qui aurait fait taire un débordement au lieu de le rendre visible, alors que
  c'est justement la contrainte qui garantit la cohérence des deux lectures.
- **Non fait, volontairement** : aucune enveloppe de bâtiment n'est DESSINÉE en 3D. Le lot donne au bâtiment
  une emprise et une contrainte ; matérialiser ses murs est un lot à part, à mener avec le reste du décor de
  bâtiment (plan séparateur compris — cf. la dette cosmétique de §6.9). La taille n'est pas non plus une
  colonne du listing des sites : le formulaire suffit au principe n°10, comme pour lat/lon.

### 6.9 Sites/bâtiments : position réelle, échelle COMPRESSÉE — **IMPLÉMENTÉ**

Le niveau site suit la même doctrine, avec une spécificité : il porte des distances GÉOGRAPHIQUES,
sans commune mesure avec un monde en millimètres.

- **Coordonnées GPS OPTIONNELLES** (comme la dimension du bâtiment), servant à calculer le
  positionnement RELATIF des sites.
- **Repli quand elles manquent** : le site est posé à **5 km du précédent**, dans l'ordre de la
  collection `sites`. Un repli déterministe, donc stable — et non un rangement dépendant de la vue.
- **L'échelle n'est PAS physique.** Référence : **1 km réel = 10 m dans le monde 3D**, soit un facteur
  **1/100** (1 km = 1 000 000 mm → 10 000 mm ; le repli de 5 km fait donc 50 m, soit 50 000 mm).
- **Réglage dans les paramètres 3D** : un curseur d'échelle, et À CÔTÉ un basculement **linéaire /
  logarithmique** — le logarithmique servant à rapprocher des bâtiments séparés par de longues
  distances, qu'une échelle linéaire rendrait inexploitables.
- **Pourquoi ça ne contredit pas §6.8** : l'échelle est un réglage d'AFFICHAGE, pas une donnée du
  modèle. Le modèle stocke la position RÉELLE (GPS, ou le rang dans la collection) ; la compression est
  appliquée au RENDU. Les coordonnées monde restent donc, conformément à §6.3, non persistables —
  elles dépendent d'un réglage de vue.

**Décisions prises À L'IMPLÉMENTATION** (module `src-client/geometry/SiteLayout.ts`, pur ; consommé par
`FloorLayout.multiLayout`) — ce sont les questions qu'on se reposera, elles sont donc tranchées ici :

- **Deux étapes SÉPARÉES, jamais mélangées.** `realPositions` rend des mètres RÉELS dérivés du seul
  modèle ; `compress` rend des millimètres MONDE après échelle. Fusionner les deux aurait fait entrer un
  réglage de vue dans la dérivation du modèle — précisément la faute que §6.8 corrige.
- **La position du site est l'ORIGINE de la bande de bâtiment** (le coin d'où partent ses plans
  d'étage), pas son centre : `BuildingBand.x0`/`y0` gardent ainsi leur sens, et les plans restent
  ancrés par `anchor_x`/`anchor_y` comme avant.
- **La bande devient bidimensionnelle** (`y0`/`y1` ajoutés). Des coordonnées GPS portent un nord-sud :
  le projeter sur un seul axe aurait jeté la moitié de l'information.
- **Nord = −y.** Les plans d'étage ont un `y` qui croît vers le bas de la vue en plan ; ancrer le nord
  sur `−y` fait coïncider « haut de l'écran » et « nord », comme sur une carte.
- **Projection équirectangulaire locale**, ancrée sur le PREMIER site géolocalisé. Écartée : un
  barycentre, qui se déplacerait à chaque ajout de site — donc une géométrie instable.
- **Normalisation à l'origine** : le monde est translaté pour que min(x) = min(y) = 0, sur TOUS les
  sites du modèle (un site masqué garde donc sa place). Bénéfice décisif : le cas **mono-site** — de
  très loin le plus courant — retombe EXACTEMENT sur (0, 0), donc à parité stricte avec le rangement
  historique. Aucun document à un seul site ne bouge.
- **Compression logarithmique** : la distance au barycentre devient `D₀·ln(1 + d/D₀)`, direction
  conservée, avec `D₀` = le pas de repli (5 km). Ici le barycentre EST le bon centre : contrairement à
  l'ancrage de projection, il ne fixe aucune position, il ne fait que centrer une déformation — et il a
  le mérite de ne pas dépendre de l'ordre d'insertion.
- **Latitude et longitude vont PAR PAIRE** (invariant de spec). Une saisie à moitié faite retomberait
  sur le repli en laissant croire le site géolocalisé ; on la rejette au lieu de l'ignorer.
- **Le RECOUVREMENT de deux bâtiments est possible** et assumé : à l'échelle par défaut, deux sites
  distants de moins de leur propre emprise se chevauchent. C'est un fait géographique, et le curseur
  d'échelle est précisément le remède. On ne « corrige » pas la position pour éviter le chevauchement —
  ce serait réintroduire un rangement, donc §6.8 à l'envers.
- ⚠ **Dette cosmétique connue** : le plan SÉPARATEUR vertical entre bâtiments (`FloorDecor.sepX`) est un
  décor hérité du rangement linéaire. Il n'a de sens qu'entre deux bandes consécutives EN X ; il est
  conservé tel quel (calculé sur les bandes triées par `x0`) et peut paraître arbitraire dès que des
  coordonnées GPS répartissent les sites en deux dimensions. À revoir quand le décor de bâtiment sera
  repris — pas dans ce lot.
- **Non fait, volontairement** : `lat`/`lon` ne sont pas exposés dans le LISTING des sites (le
  formulaire suffit au principe n°10), et la taille déclarée de bâtiment reste à venir (voir ci-dessous).

### 6.10 Ordre de migration

**étage** (rien n'existe encore → rode l'interface sans risque, et débloque les câbles) → **plateau**
(supprime la duplication `TrayFit` — **fait**, cf. §6.7 ; la migration du MODE lui-même reste à faire) →
**baie / side / wall** (les trois qui partagent le plus) → **salle** en dernier (la plus utilisée et la
mieux rodée).

À chaque étape, l'ancien et le nouveau chemin doivent donner le **même résultat au micron**, prouvé par
test, AVANT de retirer l'ancien — seule façon de migrer du code non couvert visuellement sans
régression silencieuse (méthode éprouvée sur la parité `face_up = "top"`).

## 7. État de la convergence

| Mode | Conteneur hôte | Repère résolu | Ports | État |
|---|---|---|---|---|
| *(site)* | monde | **monde** | s.o. | **migré** — position déclarée (GPS) ou repli 5 km (§6.9) ; TAILLE déclarée optionnelle faisant emprise et contraignant ses plans d'étage (§6.8) |
| `rack` | baie → salle | local salle | oui | historique, conforme |
| `side` / `wall` | baie → salle | local salle | oui | historique, conforme |
| `tray` | étagère → baie → salle | local salle | oui | historique, conforme ; **géométrie DÉDUPLIQUÉE** (`src-shared/TrayGeometry`, §6.7) — le MODE reste à migrer |
| `manual` (libre) | salle | local salle | oui | historique, conforme |
| `floor` | plan d'étage → étage → bâtiment | **monde** | **en cours** | premier cas migré |

Les équipements d'étage sont le premier contenu porté par un conteneur AUTRE qu'une salle. Ils sont
donc le banc d'essai de cette doctrine — d'où le choix de commencer par eux.

## 8. Références

- `src-shared/TrayGeometry.ts` — géométrie de l'ÉTAGÈRE, SOURCE UNIQUE (plateau utile, empreinte, position,
  chevauchement, verdict de tenue) : consommée par le RENDU (`RackGeometry.tray*` délègue) et par la
  VALIDATION (T2d/V6e), qui la reçoit en collaborateur INJECTÉ (`ValidationCollaborators`).
- `src-client/geometry/SiteLayout.ts` — position des SITES : `realPositions` (modèle → mètres réels),
  `compress` (mètres réels → millimètres monde, échelle linéaire/log), `worldPositions`.
- `src-client/geometry/FloorLayout.ts` — `multiLayout` (chaîne bâtiment/étage/salle), `roomToWorld`,
  `equipFloorWorld`, `oobWorld`, `levelZ`.
- `src-client/geometry/Resolver3D.ts` — `resolveFaceAnchor3D` (les cinq branches), `Port3D`.
- `src-client/geometry/FreeEquipGeometry.ts` — point local d'une face (`faceLocal`) et composition
  paramétrée par le centre et la base (`portWorldC`), déjà indépendante du conteneur.
- `src-client/views/dc/DcBase.ts` — repère (`multiDc`) vs portée (`visibleDcIds`), décor d'étage.
- `docs/persistance.md` — direction relationnelle (cf. §5).
- `docs/faisceaux.md`, `docs/deduction-reseau.md` — consommateurs de la résolution de ports.
