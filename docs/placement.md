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
   ✅ **RÉSORBÉ EN ENTIER (§6.11 puis §6.12)** : les cinq branches délèguent désormais leur composition au
   CONTENEUR SALLE (`RoomFrame`) — quatre via leur baie, la cinquième directement. La déduplication a
   confirmé le diagnostic deux fois : la branche `rack`, qui semblait différente, n'était que la même
   transformée écrite dans une autre notation ; et le mode libre, qu'on croyait « à part » parce que son
   hôte n'est pas une baie, était la MÊME transformée avec un autre nom de champ d'orientation.

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
   devinent pas. ✅ Dette RÉSORBÉE EN ENTIER. Premier temps (§6.11) : `Resolver3D` annonçait « monde »
   dans huit docstrings alors qu'il rend du **LOCAL SALLE** ; tout le fichier le dit désormais, en tête de
   classe comme au point d'appel — et dit AUSSI pourquoi ce local-salle est correct (§6.6). Second temps
   (§6.12) : `FreeEquipGeometry.portWorld`/`portWorldC`/`portNormal` portaient « monde » jusque dans leur
   NOM ; elles ne composent plus rien et ont cédé la place à `portLocal`/`faceNormalLocal`/`roomPlacement`,
   dont le nom dit le repère. Le champ `world` de `Resolver3D.sidePinGeom`/`capPinGeom` est renommé
   `roomPoint` par la même occasion. **Plus aucun identifiant du chemin de résolution n'annonce « monde ».**

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

✅ **Fait pour la RÉSOLUTION** (§6.11 puis §6.12) : les cinq branches de `resolveFaceAnchor3D` et la
géométrie des waypoints délèguent leur composition au conteneur SALLE (`RoomFrame`), et chaque contenu se
contente de DÉCLARER son placement. Restent éclatés, hors périmètre de ce chantier : `RackResize.fallout`
(cage) et `trayArrange`/`trayFindSpot` (placement AUTOMATIQUE sur plateau — qui n'existe que dans deux
conteneurs sur quatre, donc hors interface de base, cf. §6.2).

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
> de les substituer (il cherche `./__probe.js`, `./__probe.js.ts`, `./__probe.js.js`).

> **Mise à jour — la contrainte est LEVÉE (lot suivant).** Le `resolve.extensionAlias: { ".js": [".ts",
> ".js"] }` est désormais **posé dans `webpack.config.js`**, et l'auto-suffisance de `src-shared/` n'est
> plus une règle : **un import relatif entre fichiers partagés est autorisé**, à la condition IMPÉRATIVE
> d'écrire le spécificateur AVEC l'extension `.js` (`./TrayGeometry.js`) — la seule forme que les trois
> chaînes acceptent, parce que NodeNext l'EXIGE côté serveur. Re-mesuré à la pose, sonde comprise : les
> trois chaînes passent, la sonde retirée de la config fait bien ÉCHOUER webpack (donc la ligne travaille),
> et le bundle est identique **octet pour octet** à celui d'avant — la nouvelle résolution ne dévie rien
> dans `node_modules` ni ailleurs.
>
> **Ce que cela ne change PAS** : `ValidationCollaborators` reste en place. Le patron avait été choisi
> pour contourner la contrainte, mais son retrait est un lot à part — il touche onze points d'appel et le
> garde-fou d'échec fermé, alors que ce lot-ci ne modifie qu'une ligne de configuration et n'a donc AUCUN
> effet de bord à surveiller. Le raisonnement « il FAUT injecter » est mort ; l'injection, elle, se
> défend encore sur ses propres mérites (découplage), et c'est à ce titre qu'elle est conservée.

**Décisions prises À L'IMPLÉMENTATION** — avec les alternatives écartées et leur motif :

- **Injection par OBJET NOMMÉ, pas par 5ᵉ paramètre anonyme.** `ValidationCollaborators { trayGeometry? }`
  traverse `validateRecord` / `normalizeAndValidate` / `validateDependents` et descend jusqu'aux règles
  (`CrossEntityRule` et `ScopeRule` gagnent un paramètre). Le nom du collaborateur reste lisible au point
  d'appel, et l'objet accueillera les suivants sans nouvelle rupture de signature.
- **Interface ÉTROITE et STRUCTURELLE** (doctrine §6.2). `DataValidation.ts` déclare `TrayGeometryPort` :
  exactement les quatre opérations que les règles consomment. Comme il n'importe pas le type (injection
  oblige), la garantie vient du typage structurel — les points d'INJECTION vérifient `TrayGeometry` contre le
  port, donc toute dérive de signature casse `tsc`. Écarté : un port `any`, qui aurait rendu la dérive
  indétectable.
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
  bâtiment — dont il ne reste que l'étiquette, le plan séparateur ayant été supprimé depuis (cf. §6.9).
  La taille n'est pas non plus une
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
- ✅ **Dette cosmétique RÉSORBÉE — le plan séparateur est SUPPRIMÉ.** Le plan vertical translucide entre
  bâtiments (`FloorDecor.sepX` + `DcThreeScene.buildBuildingSep`) était un décor hérité du rangement
  linéaire : il ne séparait que deux bandes consécutives EN X, ce qui n'a plus de sens depuis que la
  position réelle des sites les répartit en DEUX dimensions — il coupait alors le monde à un endroit
  arbitraire, traversant au passage des bâtiments qu'il n'était pas censé toucher. Retiré en entier
  (descripteur, calcul et rendu) sur demande de l'utilisateur, avec les bornes du monde `FloorDecor.maxD`
  et `FloorDecor.topZ` qu'il était seul à consommer. Ce que la hauteur du monde continue de piloter
  (le Z de l'étiquette de bâtiment) reste porté par cette étiquette, donc par la signature d'invalidation.
  Le bâtiment n'est toujours PAS matérialisé en 3D — sa séparation d'avec son voisin se lit désormais
  dans l'écart entre leurs plans d'étage, pas dans un décor rapporté.
- ✅ **Étiquettes d'étage : UNE PAR PLAN DESSINÉ, donc répétées sur chaque site.** Elles se dérivaient des
  niveaux GLOBAUX (`MultiLayout.levels`) et formaient un jeu UNIQUE planté à l'origine du monde
  (`x = -gap*0,6`, `y = 0`) — cohérent tant que les bâtiments partaient de (0,0) en file, absurde une fois
  chaque site posé à sa position propre : la colonne d'étiquettes désignait au mieux un bâtiment, au pire
  aucun. Elles se dérivent maintenant de `MultiLayout.floorPlanes` : le libellé porte le numéro d'étage DU
  PLAN, la position son ancrage (même décalage `-gap*0,6` en X, conservé). Application directe de §6.8 :
  `floorPlanes` étant DÉJÀ filtré par la portée, la répétition par site et le respect de la portée
  tombent ensemble, sans traitement dédié — un étage non dessiné n'a simplement pas d'étiquette, et les
  étiquettes des étages dessinés ne bougent pas quand la portée change (repère ⊥ portée).
- **Non fait, volontairement** : `lat`/`lon` ne sont pas exposés dans le LISTING des sites (le
  formulaire suffit au principe n°10), et la taille déclarée de bâtiment reste à venir (voir ci-dessous).

### 6.10 Ordre de migration — **ÉPUISÉ**

**étage** (rien n'existe encore → rode l'interface sans risque, et débloque les câbles) → **plateau**
(supprime la duplication `TrayFit` — **fait**, cf. §6.7 ; la migration du MODE lui-même reste à faire) →
**baie / side / wall** (les trois qui partagent le plus — **fait**, cf. §6.11, avec `tray` par la même
occasion : les quatre partagent LE MÊME conteneur) → **salle** en dernier (la plus utilisée et la mieux
rodée — **fait**, cf. §6.12).

À chaque étape, l'ancien et le nouveau chemin doivent donner le **même résultat au micron**, prouvé par
test, AVANT de retirer l'ancien — seule façon de migrer du code non couvert visuellement sans
régression silencieuse (méthode éprouvée sur la parité `face_up = "top"`).

✅ **L'ordre est parcouru en entier.** Ce qui reste ouvert ne relève plus de la migration des MODES mais de
la profondeur de la chaîne et de dettes annexes : l'**ÉTAGÈRE n'est pas encore un conteneur** (la baie
place directement le posé, cf. §7), le calcul de **CAGE reste dupliqué** (`RackGeometry.cageDepth` ⇄
`RackDepth.cage`, et les deux divergent déjà — cf. §6.7), les **constantes générales de baie** restent
répliquées entre `domain/constants` et `src-shared/TrayGeometry` (test anti-divergence posé), et la
**cascade récursive** de §6.5 demeure un prérequis non tenu.

### 6.11 La BAIE devient un conteneur : `rack` / `side` / `wall` / `tray` — **IMPLÉMENTÉ**

C'est le symptôme n°3 du §1 qui commence à se refermer : `Resolver3D.resolveFaceAnchor3D` comptait CINQ
branches, dont **quatre** hébergées par une baie (`side`, `tray`, `wall`, `rack`) et une par la salle
(`manual`/libre, non migrée à ce lot — elle est la dernière de l'ordre §6.10). Les quatre recomposaient à
la main « rotation de l'hôte puis translation », ce que §3 règle 1 désigne comme la signature d'un
conteneur manquant. Le conteneur s'appelait `src-client/geometry/RackFrame.ts` ; les branches ne
produisent plus que leur point et leur normale LOCAUX.

> ⚠ **Lire ce paragraphe au passé.** Le conteneur BAIE a été GÉNÉRALISÉ en conteneur SALLE au lot suivant
> (`RoomFrame`, §6.12) : c'est le même module, renommé, une fois la deuxième occurrence constatée. Les
> décisions ci-dessous restent valables telles quelles — seul le NOM a changé.

**Ce que la déduplication a RÉVÉLÉ** — le résultat le plus utile du lot, comme au §6.7 :

- **La branche `rack` n'était pas une autre mécanique, seulement une autre NOTATION.** Trois branches
  écrivaient explicitement `cx + xl·cos − yl·sin`. La quatrième construisait deux vecteurs de base —
  « avant » `(sin, −cos)` et « largeur » `(cos, sin)` — puis composait `cx + off·avant + lateral·largeur`.
  C'est la MÊME transformée : le point local vaut `(lateral, −off)`, le signe venant de ce que `off` se
  mesure vers la FAÇADE, donc vers les −Y locaux. Rien à arbitrer, mais rien non plus qui le disait : deux
  écritures d'une seule règle, que seule l'extraction rend comparables.
- **Deux conventions d'origine COEXISTENT pour une baie non positionnée, et divergent.** Les quatre modes
  d'attache replient `dc_x`/`dc_y` absents sur **0** ; la géométrie des WAYPOINTS
  (`Resolver3D.brushGeom`/`sidePinGeom`/`capPinGeom`) les replie sur la **demi-empreinte**
  (`width/2`, `depth/2`), tout comme `FreeEquipGeometry.portWorld`. Sur une baie sans position, un port et
  une brosse de la même baie ne sont donc pas dans le même repère. Divergence **signalée, NON arbitrée** :
  la trancher déplacerait des points de brassage, ce qu'un lot de déduplication ne doit pas faire en
  douce — c'est le même principe qu'au §6.7 (« passer la cage en NOMBRE PRÉSERVE la divergence au lieu de
  l'arbitrer »). Le conteneur retient donc la convention des ports, et le dit.

**Décisions prises À L'IMPLÉMENTATION** — avec les alternatives écartées et leur motif :

- **Un conteneur BAIE, pas un `PlacementFrame` générique.** §4.3 autorise l'extraction dès la deuxième
  occurrence — il y en avait quatre — mais pas la généralisation spéculative. Écarté : couvrir du même
  geste la salle et l'étage. Leurs transformées ne sont pas de même nature (§6.6 : l'étage relève du
  LAYOUT, pas d'une transformée intrinsèque), et la salle est le morceau le plus utilisé et le mieux rodé :
  la fusionner ici aurait mêlé le risque maximal à un lot qui n'en portait aucun.
- **L'interface sépare POINT et DIRECTION.** `pointToRoom` tourne PUIS translate ; `dirToRoom` tourne
  SEULEMENT. C'est exactement la distinction que les quatre branches réécrivaient à la main, et la faute
  qu'on commet en recopiant — une normale translatée cesse d'être unitaire et expédie le connecteur 3D à
  l'autre bout de la salle. Écarté : une seule opération « transformer », qui aurait laissé le choix du
  bon traitement à l'appelant, c'est-à-dire à l'endroit d'où l'on cherchait justement à le retirer.
- **`place(baie, point, direction)` est la seule opération offerte D'UN BLOC**, parce que c'est la seule
  constatée dans plus d'une implémentation (§6.2) : les quatre modes veulent toujours les deux ensemble.
  Le paramétrage d'ATTACHE (index U et face de montage, colonne de marge, position au plateau, paroi et
  marge) reste PROPRE à chaque branche, hors interface — l'y forcer produirait l'union qui fuit que §6.2
  proscrit.
- **Le repère de sortie ne change PAS**, seule sa documentation change. `Resolver3D` rend du LOCAL SALLE,
  et c'est CORRECT (§6.6) ; huit docstrings qui annonçaient « monde » sont corrigées, la dette de §3
  règle 5 est éteinte. Écarté : rendre du monde pour « tenir la promesse » des docstrings — il faudrait
  injecter le layout dans la résolution, donc faire dépendre la position d'un port de ce qui est AFFICHÉ,
  exactement l'inverse de §6.8.
- **Parité prouvée AVANT bascule, puis attentes EXPLICITES.** 384 000 résolutions / **2 304 000
  comparaisons** (3 composantes de point + 3 de normale) entre l'ancien code relu depuis git et le
  nouveau, sur 64 baies (4 orientations × 4 positions dont l'absence de position × 4 géométries) × 50
  positions de face (bornes 0 et 1, centre, valeurs quelconques, absences) × les 4 modes. **`side`,
  `wall` et `tray` sont identiques BIT POUR BIT** ; `rack` diffère sur 1 980 composantes, d'au plus
  **2,3·10⁻¹³ mm** — la ré-association d'une somme flottante, conséquence inévitable de l'unification des
  deux notations (7 ordres de grandeur sous le micron exigé par §6.10). S'y ajoutent 44 800 composantes de
  normale qui changent le SIGNE DU ZÉRO (`−0` → `+0`) : vérifié inerte, les deux seuls consommateurs
  (`CableRouting.worldEndNormal`, `DcThreeScene.addPort`) n'en font que des additions et une
  normalisation. Les tests livrés ne comparent PAS les deux implémentations — elles n'en font plus qu'une,
  la comparaison serait tautologique (§4.1) — mais figent des coordonnées dérivées à la main du modèle.
- **Non fait, volontairement** : les trois géométries de WAYPOINT (`brushGeom`, `sidePinGeom`,
  `capPinGeom`) recomposent encore la transformée à la main. Elles ne sont pas des modes d'ATTACHE, et
  elles emploient l'autre convention d'origine ci-dessus : les migrer sans trancher cette divergence
  déplacerait des points de brassage. Le fichier le signale à l'endroit exact.
  ✅ **Fait au lot suivant**, une fois la divergence arbitrée (§6.12).

### 6.12 La SALLE devient le conteneur : le mode `manual` (libre) — **IMPLÉMENTÉ**

Dernier de l'ordre §6.10, et sa CLÔTURE. La cinquième branche de `resolveFaceAnchor3D` — le mode libre,
hébergé par la salle et non par une baie — déléguait à `FreeEquipGeometry.portWorld`/`portNormal`, qui
composaient la même rotation puis la même translation que le conteneur baie, avec le lacet de
l'ÉQUIPEMENT (`dc_orientation`). Le conteneur baie a donc été GÉNÉRALISÉ, pas dupliqué :
`src-client/geometry/RackFrame.ts` devient **`RoomFrame.ts`**, le CONTENEUR SALLE.

**Ce que la migration a RÉVÉLÉ — et qui justifie rétrospectivement tout le chantier :**

> **Les ports d'une baie NON POSITIONNÉE n'étaient pas au même endroit que la baie DESSINÉE.** Le §6.11
> avait constaté deux conventions d'origine sans les arbitrer. En les mettant côte à côte pour de bon, le
> compte est net : les deux vues qui DESSINENT (`DcThreeScene.rackGroup`, `DcViews2D.rackNode`/`equipNode`),
> la géométrie des waypoints et `FreeEquipGeometry` repliaient toutes une position absente sur la
> **demi-empreinte** ; seule la RÉSOLUTION des ports repliait sur **0**. Sur une baie sans `dc_x`/`dc_y`,
> les ports et les câbles étaient donc résolus à une demi-empreinte de la baie affichée — un port et une
> brosse de la MÊME baie n'étaient pas dans le même repère.
>
> Personne n'aurait trouvé ça en lisant le code : le défaut ne vit dans aucun des deux endroits, il vit
> dans leur ÉCART. C'est exactement ce que §1 annonce (« chaque couche re-dérive la hiérarchie à sa
> façon ») et ce que la convergence par le bas est faite de rendre visible. Le défaut PRÉEXISTAIT au
> §6.11, qui n'a fait que le répliquer fidèlement, et il préexistait probablement à l'ère TypeScript.

**Décisions prises À L'IMPLÉMENTATION** — avec les alternatives écartées et leur motif :

- **La DEMI-EMPREINTE gagne : la RÉSOLUTION s'aligne sur le RENDU.** Un contenu sans position est posé à
  RAS DU COIN de sa salle. Écarté : aligner le rendu sur la résolution (origine 0) — cela mettrait le
  CENTRE du contenu sur le coin de la salle, donc la moitié du contenu hors des murs, et ferait bouger deux
  vues au lieu d'une couche de calcul. ⚠ C'est un **CHANGEMENT DE COMPORTEMENT VOULU**, pas une parité : il
  déplace les ports (et donc les câbles et les faisceaux) de toute baie dont `dc_x` et/ou `dc_y` manque, de
  la demi-largeur en X et de la demi-profondeur en Y — 300 mm et 500 mm pour une baie aux cotes par défaut.
  Il ne touche NI Z, NI aucune normale (mesuré). Un document dont toutes les baies sont positionnées — le
  cas normal, puisque le formulaire de baie propose d'office le centre de la salle — est inchangé au micron.
- **GÉNÉRALISER le conteneur, ne pas le dupliquer.** §4.3 interdit la généralisation spéculative mais
  ordonne l'extraction à la DEUXIÈME occurrence : une baie et un équipement libre sont, l'un comme l'autre,
  « un objet posé dans une salle avec position et lacet ». Écarté : un second module `FreeEquipFrame`
  jumeau, qui aurait figé la duplication au moment précis où elle devenait démontrable.
- **La généralisation S'ARRÊTE au contenu d'une salle.** Pas de `PlacementFrame` universel : au-dessus de
  la salle, la transformée relève du LAYOUT et non d'une transformée intrinsèque (§6.6) — une abstraction
  qui remonterait jusqu'au monde mentirait. Le module le dit dans son en-tête.
- **La transformée de la SALLE elle-même n'est PAS réécrite.** `FloorLayout.roomToWorld`/`roomLocalToPlan`
  la portent déjà : elles voient la salle comme un CONTENU de son plan d'étage, quand `RoomFrame` la voit
  comme un CONTENEUR. Deux rôles, deux modules ; l'en-tête de `RoomFrame` avertit de ne pas les confondre.
- **Le paramétrage d'attache reste hors interface, y compris pour le repli.** Le conteneur reçoit un
  `RoomContentPlacement` = position (nullable) + lacet + demi-empreinte de repli — rien d'autre. Chaque
  contenu le DÉCLARE lui-même (`RackGeometry.roomPlacement`, `FreeEquipGeometry.roomPlacement`) parce que
  le NOM des champs lui est propre (`orientation` vs `dc_orientation`, `width_mm`/`depth` vs
  `free_w_mm`/`free_l_mm`). Écarté : donner l'enregistrement brut au conteneur avec un `switch` sur son
  type — ce serait rouvrir le `switch` que §6.1 remplace par le chaînage. Écarté aussi : faire calculer
  l'origine de repli par chaque contenu — la règle de repli serait alors dupliquée autant de fois qu'il y
  a de contenus, alors qu'elle est justement ce que ce lot unifie.
- **La demi-empreinte de repli n'est PAS permutée par le lacet**, contrairement à `halfExtents`. C'est la
  convention du DESSIN, qu'on reproduit à l'identique : une baie sans position tombe en (`width/2`,
  `depth/2`) quelle que soit son orientation. Écarté : « corriger » au passage en permutant — ce serait
  arbitrer en douce une SECONDE question, et faire diverger à nouveau la résolution du rendu.
- **La DIRECTION gagne une composante verticale.** Un équipement libre a six faces : celles du dessus et
  du dessous portent une normale VERTICALE, que le lacet laisse par construction inchangée. C'est la seule
  chose que la deuxième occurrence a ajoutée à l'interface — conforme à §6.2 (« on n'ajoute que ce qui est
  constaté »), la baie n'ayant que des faces verticales.
- **Les trois géométries de WAYPOINT passent enfin par le conteneur.** Elles employaient DÉJÀ la
  demi-empreinte : une fois la divergence arbitrée en leur faveur, les migrer ne déplace plus rien
  (prouvé : 72 576 comparaisons, zéro divergence). Ce sont les modes d'attache qui se sont alignés sur
  elles, et non l'inverse.
- **Renommages qui suppriment des noms MENTEURS** (§3 règle 5) : `portWorldC`/`portWorld`/`portNormal`
  cèdent la place à `portLocal`/`faceNormalLocal`/`roomPlacement`, et le champ `world` de
  `sidePinGeom`/`capPinGeom` devient `roomPoint`. Écarté : les renommer en `portRoom`/`portRoomC` en leur
  laissant la composition — cela aurait conservé une SECONDE composition à côté du conteneur, c'est-à-dire
  la duplication que ce lot supprime. Le repère de SORTIE de la résolution, lui, ne bouge pas : local salle.
- **Parité prouvée AVANT bascule, puis attentes EXPLICITES.** 42 120 résolutions comparées entre l'ancien
  code régénéré depuis git et le nouveau, sur 144 baies et 108 équipements libres (4 géométries × 6
  orientations dont 2 non cardinales × 6 positions dont l'absence totale et les deux absences partielles) ×
  40 à 140 positions de face × les 5 modes. **Hôte POSITIONNÉ : 149 040 comparaisons, ZÉRO divergence,
  écart maximal 0 — bit pour bit**, signe du zéro compris. **Waypoints : 72 576 comparaisons, zéro
  divergence.** Le cas « sans position » est EXCLU de la parité (c'est le changement voulu) et mesuré à
  part : 17 280 résolutions déplacées, de 300 à 721 mm, dont on a vérifié qu'elles se déplacent
  EXACTEMENT de la demi-empreinte sur le ou les axes manquants, sans toucher Z ni les normales. Les tests
  livrés ne comparent PAS les deux implémentations — elles n'en font plus qu'une, la comparaison serait
  tautologique (§4.1) — mais figent des coordonnées dérivées à la main du modèle. Sondes de mutation :
  signe de rotation inversé → 5 FAIL ; normale translatée → 21 FAIL ; retour à l'ancienne origine 0 →
  11 FAIL.
- **Non fait, volontairement** : l'ÉTAGÈRE ne devient pas un conteneur (la baie place directement le posé),
  et les origines repliées sur 0 qui subsistent dans `DcInteract` (cadrage caméra, ancre d'entité) ne sont
  pas touchées — elles ne résolvent aucun point de câblage, elles visent la caméra ; les aligner est un
  lot à part, à mener avec le reste du cadrage. ✅ **Fait en §6.13.**

### 6.13 Le repli d'une position absente n'est plus écrit qu'UNE fois — **IMPLÉMENTÉ**

Suite immédiate de §6.12, dont le « non fait, volontairement » désignait précisément ces sites. Le lot
précédent avait tranché la règle (position absente ⇒ DEMI-EMPREINTE) et aligné la RÉSOLUTION ; il restait des
consommateurs qui recopiaient l'ancien repli. `RoomFrame.origin(placement)` — le centre d'un contenu en local
salle, c'est-à-dire l'image de son point local (0, 0) — devient leur source unique.

**Le balayage complet du dépôt a trouvé DOUZE sites**, dont **trois conventions différentes** pour la même
question, et deux défauts qu'on ne cherchait pas :

| Site | Repli avant | Verdict |
|---|---|---|
| `DcInteract.equipCenter` (modes `tray`, `rack`, `side`/`wall`) | **0** | corrigé |
| `DcInteract.locateRack` · `DcPanels.isolateRack` | **0** | corrigé |
| `DcPanels.freeCell` (placement AUTOMATIQUE) | **0** (`\|\| 0`) | corrigé |
| `DcInteract.posScene` (outil de positionnement) | demi-empreinte **PERMUTÉE** par le lacet | corrigé |
| `DcViews2D.rackNode`/`doorSwingNode`/`equipNode`, `DcThreeScene.rackGroup` | demi-empreinte (la BONNE) | délèguent, à l'identique |
| `DcInteract` (glisser 2D historique) | position du POINTEUR | **laissé tel quel** (voir plus bas) |

- **`freeCell` traitait une baie non positionnée comme étant en (0, 0)** : le placement AUTOMATIQUE de la
  baie suivante pouvait donc la poser PILE dessus, puisqu'il la croyait ailleurs. Ce n'est pas du cadrage
  caméra — c'est une écriture dans le document.
- **Une TROISIÈME convention existait**, jamais nommée : `posScene` repliait sur `rackHalfExtents`, qui
  PERMUTE largeur et profondeur à 90/270. Une baie 800 × 1 200 tournée à 90° et non positionnée avait donc
  son rectangle d'outil en (600, 400) quand le dessin la posait en (400, 600). Le §6.12 avait cité ce site
  comme « déjà à la bonne convention » : il l'était à 0/180 seulement.
- ⚠ **Défaut trouvé en écrivant les tests, sans rapport avec le repli : la branche `side`/`wall` de
  `equipCenter` était INATTEIGNABLE.** `dim_mode` vaut « free » pour tout placement autre que « rack »
  (le formulaire de baie l'écrit en dur pour side/wall) ; la branche « libre », qui la précédait, rendait
  donc `null` faute de `dc_id`, et `locateEquipment` repliait sur `{0, 0, 0}`. **« Localiser » un équipement
  monté en marge ou en paroi visait l'origine de la salle, même sur une baie parfaitement positionnée.**
  Le piège était pourtant DÉJÀ documenté dans la même méthode, deux lignes plus haut, pour le mode `tray` —
  et `Resolver3D` traite ces deux modes AVANT le mode libre. L'ordre s'aligne sur lui.

**Décisions prises À L'IMPLÉMENTATION** — avec les alternatives écartées et leur motif :

- **`origin()` vit sur le CONTENEUR, pas sur chaque contenu.** Écarté : un `RackGeometry.roomCenter` +
  un `FreeEquipGeometry.roomCenter` jumeaux — ce serait deux copies d'un même une-ligne, donc la
  duplication qu'on supprime, déplacée d'un cran. Le contenu ne DÉCLARE que son placement
  (`roomPlacement`, §6.12) ; la règle de repli appartient à la salle.
- **Les vues qui DESSINENT délèguent aussi, bien qu'elles fussent DÉJÀ correctes.** Écarté : ne toucher
  que les fautives — il resterait alors quatre copies de la règle et la « source unique » n'en serait pas
  une ; la prochaine correction devrait à nouveau être portée cinq fois. Ce sont elles qui ont FIXÉ la
  convention (§6.12), elles la LISENT désormais au lieu de la réécrire. Parité exacte, par construction.
- **`posScene` garde son emprise ORIENTÉE** (`hx`/`hy` permutés à 90/270) : c'est l'emprise réelle au sol,
  et elle est juste. Seul le CENTRE de repli change. Confondre les deux — « puisque l'emprise permute, le
  repli doit permuter » — est exactement l'erreur d'origine.
- **Le glisser 2D historique n'est PAS aligné.** Il replie sur la position du POINTEUR : une baie sans
  position saute donc sous le curseur au premier mouvement. Ce n'est pas un repli de REPÈRE mais un choix
  d'interaction (« pas encore posée ⇒ elle vient là où tu la prends »), et le remplacer par l'origine
  changerait le ressenti du glisser sans qu'aucun test ne puisse en juger. Signalé, à arbitrer à l'œil.
- **Changement de comportement ASSUMÉ, couvert par des attentes EN DUR** (pas par une parité, qui serait
  ici un contresens) : sur une baie sans `dc_x`/`dc_y`, « Localiser » et l'isolement visent désormais la
  baie et non le coin de la salle ; l'outil de positionnement pose son rectangle SUR la baie dessinée ;
  le placement automatique ne recouvre plus une baie non positionnée. Un document dont toutes les baies
  sont positionnées est inchangé — c'est le cas normal, le formulaire proposant d'office le centre de la
  salle. Sondes de mutation : retour au repli 0 → **17 FAIL** ; branche `side`/`wall` neutralisée → **5 FAIL**.

## 7. État de la convergence

| Mode | Conteneur hôte | Repère résolu | Ports | État |
|---|---|---|---|---|
| *(site)* | monde | **monde** | s.o. | **migré** — position déclarée (GPS) ou repli 5 km (§6.9) ; TAILLE déclarée optionnelle faisant emprise et contraignant ses plans d'étage (§6.8) |
| `rack` | baie → salle | local salle | oui | **migré** — la SALLE place la baie, la baie place son contenu (`RoomFrame`, §6.11 puis §6.12) |
| `side` / `wall` | baie → salle | local salle | oui | **migré** — même conteneur que `rack` (§6.11) |
| `tray` | étagère → baie → salle | local salle | oui | **migré** côté RÉSOLUTION (§6.11) ; géométrie de plateau déjà DÉDUPLIQUÉE (`src-shared/TrayGeometry`, §6.7). Reste : l'ÉTAGÈRE elle-même n'est pas encore un conteneur — la baie place directement le posé |
| `manual` (libre) | salle | local salle | oui | **migré** — la SALLE place directement l'équipement, MÊME conteneur que les baies (`RoomFrame`, §6.12) ; l'origine d'un contenu non positionné est CORRIGÉE |
| *(waypoints)* | baie → salle | local salle | s.o. | **migré** — brosses et pins passent par le conteneur (§6.12) ; le champ `world` est renommé `roomPoint` |
| `floor` | plan d'étage → étage → bâtiment | **monde** | **en cours** | premier cas migré |

Les équipements d'étage sont le premier contenu porté par un conteneur AUTRE qu'une salle. Ils sont
donc le banc d'essai de cette doctrine — d'où le choix de commencer par eux.

✅ **L'ordre de migration §6.10 est ÉPUISÉ : tous les modes de placement passent par un conteneur.** Ce
qui reste ouvert est listé en fin de §6.10 (étagère-conteneur, cage dupliquée, constantes de baie,
cascade récursive) — dettes annexes, plus étapes de migration.

## 8. Références

- `src-shared/TrayGeometry.ts` — géométrie de l'ÉTAGÈRE, SOURCE UNIQUE (plateau utile, empreinte, position,
  chevauchement, verdict de tenue) : consommée par le RENDU (`RackGeometry.tray*` délègue) et par la
  VALIDATION (T2d/V6e), qui la reçoit en collaborateur INJECTÉ (`ValidationCollaborators`).
- `src-client/geometry/SiteLayout.ts` — position des SITES : `realPositions` (modèle → mètres réels),
  `compress` (mètres réels → millimètres monde, échelle linéaire/log), `worldPositions`.
- `src-client/geometry/FloorLayout.ts` — `multiLayout` (chaîne bâtiment/étage/salle), `roomToWorld`,
  `equipFloorWorld`, `oobWorld`, `levelZ`.
- `src-client/geometry/RoomFrame.ts` — **CONTENEUR SALLE** (§6.11 sous le nom `RackFrame`, généralisé en
  §6.12) : `basis` (lacet + origine, dérivés du seul placement DÉCLARÉ, position absente ⇒ demi-empreinte),
  `origin` (le CENTRE d'un contenu en local salle — source unique du repli, §6.13), `pointToRoom` (rotation
  PUIS translation), `dirToRoom` (rotation SEULE, composante verticale recopiée), `place` (les deux, ce que
  consomment les CINQ modes). `RoomContentPlacement` = l'interface étroite.
- `src-client/geometry/Resolver3D.ts` — `resolveFaceAnchor3D` : les cinq modes délèguent leur composition à
  `RoomFrame` (quatre via leur baie, le mode libre directement), ainsi que la géométrie des waypoints.
  Sortie en **LOCAL SALLE** pour tout le fichier — points, normales et offsets de conduit. `Port3D`.
- `src-client/geometry/FreeEquipGeometry.ts` — géométrie PROPRE de l'équipement libre : `faceLocal`,
  `portLocal` (point local d'un port), `faceNormalLocal` (normale AVANT lacet) et `roomPlacement` (ce
  qu'il déclare à son conteneur). Il ne compose plus aucune transformée.
- `src-client/geometry/RackGeometry.ts` — `roomPlacement` : ce que la BAIE déclare à son conteneur.
- `src-client/views/dc/DcBase.ts` — repère (`multiDc`) vs portée (`visibleDcIds`), décor d'étage.
- `docs/persistance.md` — direction relationnelle (cf. §5).
- `docs/faisceaux.md`, `docs/deduction-reseau.md` — consommateurs de la résolution de ports.
