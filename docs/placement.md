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
   REPÈRE DU CONTENU PLACÉ (`PlacementFrame`, nommé `RoomFrame` jusqu'à §6.22) — quatre via leur baie, la
   cinquième directement. La déduplication a
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
3. **Extraire l'abstraction à la DEUXIÈME occurrence, pas à la première.** On ne fabrique pas un repère
   de placement générique sur un seul cas : sa forme n'est pas encore connue et on figerait une
   généralisation spéculative. On nomme le conteneur, on compose explicitement, et on extrait quand le
   deuxième mode migre.
   > ⚠ **Le module `PlacementFrame` existe aujourd'hui (§6.22), et il n'est PAS le contre-exemple de
   > cette règle : il en est l'APPLICATION.** Cette règle citait autrefois son nom comme celui de la
   > mauvaise chose à faire ; ce qu'elle proscrit n'est pas le nom, c'est la CHRONOLOGIE. Le module a
   > été extrait à la DEUXIÈME occurrence sous un nom étroit (`RackFrame`, §6.11), élargi à la troisième
   > seulement (§6.12 puis §6.22), et à chaque fois sur des occurrences CONSTATÉES. Le fabriquer
   > d'emblée, sur un seul cas, reste exactement aussi proscrit qu'avant.
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
géométrie des waypoints délèguent leur composition à `PlacementFrame` (§6.22), et chaque contenu se
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

- ✅ **Cascade RÉCURSIVE requise — LEVÉE en §6.16.** Sous chaînage pur, supprimer une salle doit propager
  jusqu'au bout de la chaîne. La cascade était non récursive (dette connue produisant des orphelins) :
  elle était un **prérequis** de ce modèle, plus un nettoyage optionnel. `Cascade.plan` rejoue désormais
  la règle de chaque entité qu'il marque pour suppression, jusqu'au point fixe.
- **Garde de profondeur** sur le chaînage (cycle de références → boucle infinie). ✅ Posée pour la
  cascade en §6.16, sous la forme d'un ENSEMBLE des couples (collection, id) déjà traités — qui borne
  le parcours au nombre d'entités du document et rend toute garde de profondeur *arbitraire* inutile.
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
>
> ⚠ **Précision APPORTÉE EN §6.19 — « l'auto-suffisance n'est plus une règle » dit trop.** Ce qui est
> levé, c'est le seul interdit d'importer un AUTRE FICHIER PARTAGÉ. L'interdit d'importer **hors de
> `src-shared/`** (client, serveur, paquet npm), lui, est PERMANENT et n'a jamais dépendu d'une
> configuration. La formule « auto-suffisant » confondait les deux ; §6.19 les sépare et verrouille la
> première par un test.

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
  > ✅ **Dette RÉSORBÉE en §6.14** : la politique de profondeur vit désormais une seule fois
  > (`src-shared/RackDepthPolicy`) et la divergence est arbitrée en faveur du BORNAGE. Le choix de passer
  > la cage en NOMBRE, lui, reste le bon découpage — c'est l'appelant qui décide de quelle cage il parle.
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
place directement le posé, cf. §7), ~~le calcul de **CAGE reste dupliqué**~~ **résorbé en §6.14** (source
unique `src-shared/RackDepthPolicy`, divergence arbitrée en faveur du bornage), les **constantes générales
de baie** restent répliquées entre `domain/constants` et les modules partagés (`TrayGeometry`,
`RackDepthPolicy` — tests anti-divergence posés). ~~et la **cascade récursive** de §6.5 demeure un prérequis
non tenu~~ **tenu en §6.16**.

### 6.11 La BAIE devient un conteneur : `rack` / `side` / `wall` / `tray` — **IMPLÉMENTÉ**

C'est le symptôme n°3 du §1 qui commence à se refermer : `Resolver3D.resolveFaceAnchor3D` comptait CINQ
branches, dont **quatre** hébergées par une baie (`side`, `tray`, `wall`, `rack`) et une par la salle
(`manual`/libre, non migrée à ce lot — elle est la dernière de l'ordre §6.10). Les quatre recomposaient à
la main « rotation de l'hôte puis translation », ce que §3 règle 1 désigne comme la signature d'un
conteneur manquant. Le conteneur s'appelait `src-client/geometry/RackFrame.ts` ; les branches ne
produisent plus que leur point et leur normale LOCAUX.

> ⚠ **Lire ce paragraphe au passé.** Le conteneur BAIE a été GÉNÉRALISÉ en conteneur SALLE au lot suivant
> (`RoomFrame`, §6.12) une fois la deuxième occurrence constatée, puis renommé **`PlacementFrame`** à la
> troisième (§6.22). C'est le même module de bout en bout, et les décisions ci-dessous restent valables
> telles quelles — seul le NOM a changé, deux fois.

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

- **Un conteneur BAIE, pas un repère de placement générique d'emblée.** §4.3 autorise l'extraction dès la
  deuxième occurrence — il y en avait quatre — mais pas la généralisation spéculative. Écarté : couvrir du
  même geste la salle et l'étage. Leurs transformées ne sont pas de même nature (§6.6 : l'étage relève du
  LAYOUT, pas d'une transformée intrinsèque), et la salle est le morceau le plus utilisé et le mieux rodé :
  la fusionner ici aurait mêlé le risque maximal à un lot qui n'en portait aucun.
  ⚠ Ce point s'écrivait « pas un `PlacementFrame` générique », en citant ce nom comme celui du travers à
  éviter. Le module le PORTE désormais (§6.22) — non par renoncement, mais parce que l'élargissement s'est
  fait dans l'ordre que ce point exigeait : un nom étroit tant qu'une seule forme de contenu était
  constatée, élargi seulement à mesure que les suivantes l'étaient. La borne §6.6 invoquée ici, elle, n'a
  pas bougé d'un pouce.
- **L'interface sépare POINT et DIRECTION.** `composePoint` tourne PUIS translate ; `composeDir` tourne
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

> ⚠ **Lire les noms de ce paragraphe au passé.** `RoomFrame` s'appelle **`PlacementFrame`** depuis §6.22,
> et ses types avec lui (`RoomContentPlacement` → `ContentPlacement`, `RoomBasis` → `PlacementBasis`,
> `RoomPlacedPoint` → `PlacedPoint`). C'est le même module, et toutes les décisions ci-dessous valent
> telles quelles. Ce que §6.22 a corrigé n'est aucune d'elles : c'est le constat, fait ici même, que le
> module ne lit QUE les champs du CONTENU — la salle n'y a jamais été qu'un espace de coordonnées.

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
- **La généralisation S'ARRÊTE là où la transformée cesse d'être INTRINSÈQUE.** Au-dessus de la salle,
  elle relève du LAYOUT (§6.6) — une abstraction qui remonterait d'elle-même jusqu'au monde mentirait.
  Le module le dit dans son en-tête.
  > ⚠ **Mise à jour (§6.22) — ce point s'écrivait « pas de `PlacementFrame` universel », et le module
  > porte aujourd'hui ce nom.** Ce qui était visé n'était pas le NOM mais une CAPACITÉ : composer seul
  > jusqu'au monde. Cette capacité reste proscrite, et elle n'est plus seulement affirmée — un verrou de
  > test refuse tout import porteur de layout ou de vue (§6.22). Ce qui a changé est la PRÉMISSE : le
  > point supposait que la limite passait à la frontière de la SALLE, alors qu'elle passe à la frontière
  > de l'INTRINSÈQUE. Le module ne connaît toujours ni étage, ni bâtiment, ni layout ; il compose dans le
  > repère de l'origine qu'on lui donne, d'où qu'elle vienne — c'est ce qui a rendu §6.20 possible sans
  > y toucher, et ce qui a fini par rendre le nom « Room » faux.
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
consommateurs qui recopiaient l'ancien repli. `PlacementFrame.origin(placement)` — le centre d'un contenu en local
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

### 6.14 La POLITIQUE DE PROFONDEUR de baie n'est plus écrite deux fois — **IMPLÉMENTÉ**

Dette ouverte depuis §6.7, listée en fin de §6.10 : « le calcul de CAGE reste dupliqué
(`RackGeometry.cageDepth` ⇄ `RackDepth.cage`), et les deux divergent déjà ». Elle est refermée.
`src-shared/RackDepthPolicy` porte désormais, une seule fois, les cinq règles de lecture de la profondeur
d'une baie : profondeur extérieure, cage, marges avant/arrière, cavités de portes creuses. Le RENDU
(`RackGeometry`) et la VALIDATION (`RackDepth`, règles T2c / V6d) n'en sont plus que des consommateurs.

**LES DIVERGENCES TROUVÉES — le résultat le plus utile du lot** (444 528 comparaisons sur une grille de
7 profondeurs × 18 cages × 12 marges avant × 7 portes avant × 7 portes arrière, entre les deux anciennes
implémentations relues depuis git) : **exactement DEUX**, et rien d'autre. 26 460 comparaisons divergentes,
toutes classées dans ces deux familles ; `doorExtra` et `hasDoor` sont identiques BIT POUR BIT, ainsi que
toutes les gardes de saisie (`!= null`, chaîne vide, valeur négative, valeur en chaîne).

1. **La validation BORNAIT la cage à la profondeur extérieure, le front NON** (9 996 comparaisons). Une baie
   déclarant une cage plus profonde que son châssis était DESSINÉE avec une cage qui en débordait — et,
   depuis §6.7, cette valeur NON bornée était injectée telle quelle dans `TrayGeometry.plank` : la longueur
   de plateau dessinée pouvait dépasser ce que la validation autorise.
   **Version retenue : la BORNÉE (validation).** Une cage ne peut physiquement pas être plus profonde que le
   châssis qui la contient — ce n'est pas une question de convention d'affichage, c'est une impossibilité
   matérielle. Écarté : la version du rendu. ⚠ Ne PAS généraliser la leçon du §6.13, où c'est le chemin qui
   DESSINE qui avait raison : chaque divergence se juge sur le fond, jamais par une règle de pouce.
2. **Plancher à 1 sur une cage sub-millimétrique** (16 464 comparaisons, dont 8 232 sur la cage elle-même et
   8 232 répercutées sur les marges). Pour `cage_depth_mm` dans ]0, 1[, le front rendait 1 (`Math.max(1, …)`
   appliqué à une valeur déjà tronquée par `| 0`, donc à 0), la validation 0.
   **Version retenue : celle de la validation (0).** Le `Math.max(1, …)` ne protégeait rien : aucun calcul
   aval ne divise par la cage (vérifié) — il maquillait une saisie absurde en cage d'un millimètre au lieu
   de la laisser produire un plateau vide, que la validation refuse déjà.

**Décisions prises À L'IMPLÉMENTATION** — avec les alternatives écartées et leur motif :

- **La marge de SÉCURITÉ derrière une porte n'entre PAS dans le module partagé.** `RackDepth.avail`/`shared`
  retranchent `RACK_DEPTH_SAFETY_MM`, `RackGeometry.mountAvailDepth`/`sharedMountDepth` non — et c'est
  VOULU depuis l'origine (le rendu dessine ce qui existe physiquement, la validation applique une prudence).
  Ce n'est donc pas une divergence à arbitrer mais deux politiques distinctes sur une même géométrie ; les
  mutualiser aurait imposé la prudence au dessin, ou l'aurait retirée à la validation. Le commentaire du
  front qui annonçait « répliqué dans shared/DataValidation — parité à maintenir » est corrigé en
  conséquence : ce qui est partagé, ce sont les PRIMITIVES, pas la composition.
- **`DataValidation.ts` IMPORTE ce module, il ne le reçoit pas.** Premier bénéficiaire de la levée de
  l'auto-suffisance de `src-shared/` (§6.7, mise à jour) : `import { RackDepthPolicy } from
  "./RackDepthPolicy.js"` — extension `.js` IMPÉRATIVE, NodeNext l'exige côté serveur. Écarté : reproduire
  le patron `ValidationCollaborators` — il n'a plus de justification technique, et il coûterait ici un
  garde-fou d'échec fermé et onze points d'injection pour un module que rien ne demande de découpler.
  ⚠ **Les DEUX patrons coexistent donc dans le même fichier, et c'est assumé** : `TrayGeometry` reste
  INJECTÉ (retrait possible, non demandé — lot à part). Les trois en-têtes concernés le disent.
- **`RACK_DEPTH_DEFAULT_MM` reste une RÉPLIQUE**, comme `TRAY_U_MM` et consorts en §6.7, verrouillée par un
  test anti-divergence. La migrer reviendrait à migrer `src-client/domain/constants.ts` en entier — elle sert
  toute la géométrie de baie, pas seulement la profondeur.
- **Les signatures publiques de `RackGeometry` ne changent pas** (`cageDepth`, `frontMargin`, `rearMargin`,
  `door`, `doorExtraDepth`, `hasDoor`) : elles deviennent de simples alias. Leurs consommateurs sont
  nombreux — `Resolver3D`, `DcThreeScene`, `DcViews2D`, les formulaires de baie et leurs tests.
- **Les re-bornages `Math.min(profondeur, cageDepth(...))` DISPARAISSENT** de leurs sept points d'appel
  (`RackGeometry` ×5, `Resolver3D`, `DcThreeScene`) : la cage étant bornée à la source, ils étaient devenus
  idempotents. Les garder aurait laissé croire que la valeur rendue peut encore déborder — c'est-à-dire
  entretenir le doute que ce lot supprime. Aucun effet sur les valeurs (prouvé par la parité).
- **Parité prouvée AVANT bascule, puis attentes EXPLICITES.** Après bascule : le module partagé est identique
  BIT POUR BIT à l'ancienne validation (444 528 comparaisons, ZÉRO divergence) et diffère de l'ancien front
  exactement sur les 26 460 comparaisons des deux familles arbitrées ; `RackGeometry` branché est identique
  au module partagé (444 528 comparaisons, zéro divergence). Les tests livrés ne comparent PAS les deux
  implémentations — elles n'en font plus qu'une, la comparaison serait tautologique (§4.1) — mais figent des
  valeurs EN DUR. Sondes de mutation : bornage retiré → **8 FAIL** ; cavité de porte neutralisée → **3 FAIL** ;
  cage déclarée ignorée → **27 FAIL**, dont **4 tests de VALIDATION** (T2c ×2, V6d ×2) — c'est cette
  troisième sonde qui prouve que la validation consomme bien le module, et non une copie restée sur place.

**Changements de comportement OBSERVABLES** (tous dans le sens « le dessin cesse de promettre plus que ce que
la validation accepte »), sur une baie dont la cage déclarée dépasse sa propre profondeur :
la CAGE dessinée et les montants s'arrêtent au châssis ; la longueur d'un plateau d'étagère est ramenée ;
la profondeur d'une brosse (waypoint) est bornée à la cage réelle ; le formulaire de baie AFFICHE la cage
bornée (et l'enregistre à l'édition). Une baie dont la cage tient dans son châssis — le cas normal, et le
seul que le formulaire permette de saisir sans forcer — est inchangée au micron.

**Non fait, volontairement** : `RackGeometry.mountAvailDepth`/`sharedMountDepth` et `RackDepth.avail`/`shared`
composent encore les mêmes primitives chacun de leur côté (à la marge de sécurité près, cf. ci-dessus).
✅ Les deux autres dettes signalées ici — le doublon `RackGeometry.frontMountAvailDepth` et le code mort
`RackGeometry.minDepth` — sont **RÉSORBÉES en §6.18**.

### 6.15 Le CADRAGE de « Localiser » devient une règle nommée — **IMPLÉMENTÉ**

Suite de §6.13, qui avait corrigé **où** la caméra vise sans jamais toucher à **combien** elle embrasse. Signalé
par l'utilisateur : « pour les équipements en rack c'est bien centré dans la vue ; pour les équipements libres et
les baies c'est pas top, et il faut dé-zoomer en plus ».

**Le défaut était dans les DEUX, et c'est l'enquête qui le dit** — pas la lecture d'une ligne :

- **La formule** (`DcThreeCamera.applyPendingFocus`) valait `baseHalf = max(400, extent × 0,7 + 200)`. Elle mêlait un
  facteur, un rembourrage constant et un plancher, et n'exprimait donc AUCUN taux de remplissage : un objet occupait
  `extent / (1,4·extent + 400)` de la vue, soit **62 %** pour une baie de 2 m, **48 %** à 600 mm, **25 %** à 200 mm,
  **71 %** à la limite des très grands objets. Le cadrage dépendait de la TAILLE de la cible, ce qui est exactement
  ce que décrit l'utilisateur.
- **L'étendue fournie** était fausse dans deux cas sur quatre. Équipement LIBRE : une **constante de 1 600 mm**,
  sans aucun rapport avec l'objet — c'est le seul chemin capable de faire DÉBORDER la cible de la vue (au-delà de
  ~2 640 mm de haut), donc la seule cause possible du « il faut dé-zoomer », la formule ne cadrant jamais plus serré
  que 71 % de l'objet. Baie visée directement : sa seule **HAUTEUR**, ce qui tronque une baie murale plus large que
  haute. Équipement en baie : l'étendue était bien celle de la baie, mais la cible restait le centre de
  l'ÉQUIPEMENT — la baie n'était donc pas centrée, et son sommet sortait du cadre dès que l'objet était bas.

**La règle vit désormais dans `src-client/geometry/CameraFraming.ts`** (§3 règle 4 : la géométrie pure vit dans
`geometry/`, les vues ne font qu'appliquer). Elle ne connaît ni THREE, ni le DOM, ni le store : elle prend des
nombres et rend un nombre, ce qui la rend testable en Node — le moteur 3D, lui, ne l'est pas.

| Objet localisé | monde cadré AVANT | remplissage AVANT | monde cadré APRÈS | remplissage APRÈS |
|---|---|---|---|---|
| Baie 42U (600 × 1000 × 2000) | 3 200 mm | 62,5 % | 2 222 mm | **90 %** |
| Baie murale 6U (600 × 600 × 400) | 960 mm | 62,5 % | 667 mm | **90 %** |
| Équipement 1U dans la baie 42U (on cadre LA BAIE) | 3 200 mm | 62,5 %, baie NON centrée | 2 222 mm | **90 %**, baie centrée |
| Coffret libre 600 × 600 × 600 | 2 640 mm | 22,7 % | 667 mm | **90 %** |
| Grande armoire libre 800 × 1200 × 2200 | 2 640 mm | 83,3 % | 2 444 mm | **90 %** |
| Très grande armoire libre 2000 × 1000 × 3000 | 2 640 mm | **113,6 % — DÉBORDE** | 3 333 mm | **90 %** |
| Petit boîtier libre 100 × 100 × 100 | 2 640 mm | 3,8 % | 600 mm (**limite de zoom**) | 16,7 % |

**Décisions prises À L'IMPLÉMENTATION** — avec les alternatives écartées et leur motif :

- **Le taux visé est une CONSTANTE NOMMÉE** (`FILL_RATIO = 0,9`), pas un facteur noyé dans une formule. C'est ce
  qui rend le cadrage PRÉVISIBLE : la même promesse pour un boîtier et pour une armoire. Écarté : ajuster le
  couple facteur/rembourrage existant — on aurait déplacé la courbe sans lui donner de sens, et le taux serait
  resté fonction de la taille.
- **LIMITE DE ZOOM = une largeur de baie standard** (`MIN_FRAMED_EXTENT_MM = RACK_WIDTH_DEFAULT`, 600 mm), et non
  un nombre choisi au jugé. Justification : en deçà, la vue ne contient plus aucun élément structurel
  reconnaissable du datacenter — un fragment de panneau, sans repère d'échelle. 600 mm valent ~13,5 U : localiser
  un 1U laisse encore voir ~6 U de baie de part et d'autre. Sans elle, un boîtier de 100 mm serait cadré sur
  111 mm de monde. ⚠ Le plancher se pose sur la demi-étendue CADRÉE (il empêche de trop zoomer AVANT), au même
  endroit que l'ancien `max(400, …)` : le « il faut dé-zoomer » ne venait PAS de la limite mais de l'étendue
  sous-évaluée — vérifié par le calcul, l'ancienne formule ne cadrant jamais plus serré que 71 % de son
  `extent`.
- **L'étendue cadrable d'un objet est sa PLUS GRANDE COTE** (`objectExtent`). Le cadrage ne connaît pas l'azimut
  sous lequel l'objet sera regardé : sa hauteur écran varie avec l'élévation, sa largeur écran entre sa largeur et
  la diagonale de son empreinte. La plus grande cote est la borne SÛRE. Écarté : projeter la boîte sous l'angle
  courant — exact, mais cela ferait dépendre le cadrage de l'orientation de la caméra, donc changer la taille
  apparente de l'objet à chaque orbite.
- **Équipement MONTÉ en baie : on cadre LA BAIE, centrée.** L'équipement se repère à sa surbrillance ambre, déjà
  posée par `setFocusEquip`. Écarté : garder l'équipement au centre et élargir le cadrage jusqu'à englober la baie
  — il faudrait embrasser deux fois la distance du centre de l'équipement au bout le plus lointain de la baie (près
  de 4 m pour un 1U en bas d'une baie de 2 m), et la baie n'occuperait alors que ~50 % de la vue, en position
  décentrée. C'est le contraire de la demande.
- **`equipCenter` n'est PAS déplacée** : elle rend toujours le centre de l'ÉQUIPEMENT, et reste la cible du mode
  LIBRE. Ses branches `rack`/`side`/`wall`/`tray` (corrigées en §6.13) ne sont simplement plus CONSULTÉES par
  « Localiser », qui cadre la baie — elles restent la lecture canonique de « où est cet équipement dans sa salle »,
  et leur verrouillage par test est conservé. Écarté : les retirer, ce qui aurait mêlé un nettoyage à un
  changement de comportement.
- **13ᵉ SITE du balayage de §6.13, trouvé ici** : la branche LIBRE de `equipCenter` rendait `null` quand `dc_x`/`dc_y`
  manquaient, et « Localiser » repliait alors sur (0, 0, 0) — le coin de la salle. Le balayage l'avait manqué parce
  que le repli n'y était pas écrit `|| 0` mais caché derrière un `return null` chez l'appelant. Elle passe désormais
  par `PlacementFrame.origin(FreeEquipGeometry.roomPlacement(e))`, comme les quatre autres : l'objet est visé là où il est
  DESSINÉ. La garde de salle (`dc_id !== dcId`) est conservée.
- **Les trois cibles PONCTUELLES gardent leur cadrage actuel** (port, extrémité de câble, waypoint). Un point n'a pas
  de taille : ce qu'on cadre autour de lui est un rayon de CONTEXTE, réglé à l'œil contre l'ancienne formule. Leurs
  constantes sont donc RECALIBRÉES (700 → 1 250, 2 500 → 3 500, 1 200 → 1 900) pour que le monde cadré reste celui
  d'avant à 1,5 % près. Écarté : les reprendre telles quelles — la nouvelle règle aurait resserré ces trois vues
  de 30 à 45 %, alors que le lot ne doit changer que ce qui est signalé.
- **PLONGÉE par défaut** (`FOCUS_ELEVATION_RAD = π/9`, 20°), extraite de `frontAzimuth` où elle était un littéral.
  Arbitrage : **une face visée GAGNE toujours** (« se positionner en face » est une intention exprimée sur CET objet) ;
  sans face — câble, waypoint, des POINTS sans façade — on **conserve l'azimut** (« de quel côté je regarde » reste un
  choix de l'utilisateur, et rien ne permet d'en deviner un meilleur) mais on **impose l'élévation** : une caméra restée
  rasante ou au zénith rend la cible illisible. Écarté : ne replonger que si l'élévation courante sort d'une plage
  « lisible » — un seuil de plus à justifier, pour un gain nul dans les deux cas qui comptent.
- **L'ASPECT du canevas entre dans la règle**, lu par le moteur et passé en paramètre. En paysage (`aspect ≥ 1`, le
  cas normal) il est inerte ; en portrait c'est la LARGEUR qui borne, et le cadrage s'élargit pour que « 90 % de la
  vue » reste vrai. Écarté : cadrer la seule hauteur — la promesse serait fausse dès qu'on rétrécit la fenêtre.
- **Une baie MASQUÉE est démasquée quand on la localise.** Défaut trouvé en enquêtant : `locateEquipment` ISOLE la
  baie hôte (`hidden3dRacks` = toutes sauf elle) et personne ne défait cet isolement — localiser ENSUITE une autre
  baie visait donc une baie invisible. Seule la baie VISÉE est démasquée : les autres masquages sont des choix de
  l'utilisateur. Écarté : réinitialiser tout le masquage, qui détruirait un isolement voulu.
- **Sondes de mutation** : taux ramené à l'ancien 62,5 % → **11 FAIL** ; limite de zoom neutralisée → **7 FAIL** ;
  cadrage de la baie court-circuité → **5 FAIL** ; ancien repli `null` du mode libre rétabli → **3 FAIL**.

**Non couvert par les tests, à juger À L'ŒIL** : l'élévation de 20° (`CameraFraming.FOCUS_ELEVATION_RAD`, constante
UNIQUE à retoucher) et le confort réel des 90 % — `DcThreeCamera` importe THREE, hors de portée du harnais CJS. Ce
qui est testable l'est : la règle pure, et l'étendue + la cible poussées au moteur par chaque « Localiser ».

### 6.16 La CASCADE DE SUPPRESSION devient RÉCURSIVE — **IMPLÉMENTÉ**

Prérequis nommé par §6.5, resté ouvert tout le chantier. `Cascade.plan` ne jouait la règle QUE de l'entité
visée : il ne la rejouait jamais sur les entités qu'il venait de marquer pour suppression. La transitivité
était rattrapée À LA MAIN dans des hooks `custom`, et ce qui n'y figurait pas laissait des orphelins **en
usage normal**, pas seulement par appel d'API brut. Le moteur rejoue désormais la règle de chaque entité
supprimée, **jusqu'au point fixe**.

**Le vrai travail du lot n'est pas la boucle : c'est le CLASSEMENT des hooks `custom`.** Plusieurs
n'existaient que pour compenser l'absence de récursion. Les laisser en place aurait au mieux doublé le
travail — au pire changé la sémantique (voir la composition des listes, plus bas). Chacun a donc été classé
en (A) « compense la récursion manquante », donc retirable, ou (B) « encode autre chose qu'une cascade de
FK », donc à conserver :

| Hook `custom` | Classement | Motif |
|---|---|---|
| `equipments` — câbles des ports | **(A) retiré** | La règle `delete` supprime déjà les ports ; la récursion rejoue `ports`, qui emporte leurs câbles. Ensemble IDENTIQUE (mesuré). |
| `equipments` — spares | **(B) conservé** | Pas une cascade de FK : écrit une valeur CALCULÉE à partir du parent (le nom de l'équipement, préservé en texte libre). |
| `ports` — câbles branchés | **(B) conservé** | Deux champs d'extrémité (`from_port_id`/`to_port_id`) à dédupliquer : non réductible à une FK simple. |
| `ports` — lanes de breakout | **(A) devenu déclaratif** | `find("ports", "parent_port_id", …)` est une FK simple → passe en `delete`. Leurs câbles ET un breakout IMBRIQUÉ suivent par récursion — ce que le hook ne faisait PAS. |
| `networks` | **(B) conservé** | Retrait d'un id d'une LISTE + repointage du principal : ni suppression, ni nullification de FK. |
| `groups` | **(B) conservé** | Même modèle multi-valeurs, sur `equipments` **et** `vms`. |
| `racks` — équipements posés sur les étagères | **(A) retiré** | Le commentaire le disait lui-même (« TRANSITIF, plan non récursif »). La récursion sur `rackItems` produit exactement les mêmes détachements (mesuré, entrée pour entrée). |
| `racks` — suppression des brosses | **(A) devenu déclaratif** | `find("waypoints", "rack_id", …)` est une FK simple → passe en `delete`. |
| `racks` — nettoyage des routes | **(A) retiré** | La récursion sur `waypoints` le fait, une fois par brosse — **à condition** de composer les valeurs (voir décision ci-dessous). |
| `rackItems` | **(B) conservé** | Règle PROPRE de l'étagère (et non une transitivité) : détache ses posés en écrivant quatre champs. |
| `waypoints` | **(B) conservé** | Règle PROPRE du waypoint : retrait d'un id d'une LISTE (`waypoint_ids`) de câbles et de faisceaux. |

**RAYON D'ACTION — la question qui pouvait faire échouer le lot.** Une cascade récursive peut, via une FK
mal déclarée, emporter tout un document. Mesuré AVANT/APRÈS sur **chaque enregistrement de chaque
collection**, avec l'ancien moteur relu depuis git (§4.1) :

| Document | Suppressions AVANT | APRÈS | Δ | Détachements AVANT | APRÈS | Δ |
|---|---|---|---|---|---|---|
| `samples-public/demo-infra.json` (246 enreg.) | 204 | 204 | **0** | 343 | 343 | **0** |
| Document de PRODUCTION (656 enreg., non versionné) | 498 | 498 | **0** | 692 | 692 | **0** |
| Jeu de test à chaînes PROFONDES (breakout imbriqué, lane sans `equipment_id`, cycles) | 50 | 61 | **+11** | 59 | 59 | **0** |

**Sur des données réelles, le rayon d'action ne bouge PAS D'UNE ENTITÉ** — et c'est le résultat attendu, pas
une déception : les hooks `custom` couvraient bien les cas produits par l'application. Ce que la récursion
ajoute est une **garantie de FERMETURE**, valable pour les cas que l'UI ne produit pas (écriture d'API
tierce, import) et pour toute règle FUTURE. Le delta n'apparaît que sur le jeu à chaînes profondes, et
chaque entité s'y justifie nommément :

- depuis l'**ÉQUIPEMENT** (+6) : une lane portée par un port de l'équipement mais **sans `equipment_id`**
  (donc invisible à la règle `delete` de l'équipement), ses deux niveaux de sous-lanes, et leurs 3 câbles ;
- depuis les **PORTS** (+6) : les sous-lanes et sous-sous-lanes d'un **breakout IMBRIQUÉ** et leurs câbles —
  l'ancien plan ne descendait jamais là, il ne regardait qu'UN niveau sous le port supprimé ;
- **−1** : le port déclaré parent DE LUI-MÊME, qui figurait dans son propre plan (voir le sur-ensemble
  ci-dessous).

Aucune collection sans lien logique avec la racine n'est atteinte : les seules collections gagnantes sont
`ports` et `cables`, à partir de `equipments` et de `ports`.

**Le plan est un SUR-ENSEMBLE de l'ancien** : sur les trois documents, **aucune** entité ne DISPARAÎT des
suppressions — à une exception, voulue et vérifiée : un port déclaré parent DE LUI-MÊME figurait dans son
propre plan (l'appelant le supprimait donc deux fois). Le garde anti-cycle l'écarte. Côté détachements,
les seules entrées qui disparaissent sont celles visant une entité que le plan SUPPRIME (voir décision
ci-dessous) ; sur données réelles, il n'y en a aucune.

**Décisions prises À L'IMPLÉMENTATION** — avec les alternatives écartées et leur motif :

- **Le garde ANTI-CYCLE est un ENSEMBLE des couples (collection, id) déjà traités, et la CIBLE y est
  inscrite d'entrée.** Il sert trois choses d'un coup : terminaison sur un cycle de références
  (`ports.parent_port_id` peut en former un — le dépôt ne l'interdit pas), déduplication d'une entité
  atteinte par deux chemins, et exclusion de la cible elle-même (que l'appelant supprime). Écarté : une
  **garde de profondeur** chiffrée, comme le suggérait §6.5 — elle aurait fixé une limite arbitraire, et
  se serait tue en tronquant le plan au lieu de le clore. Ici la borne est structurelle : chaque entité est
  traitée au plus une fois, donc le parcours est borné par la taille du document.
- **Un détachement visant une entité que le plan SUPPRIME est ÉCARTÉ.** Inutile en mode fichier ; **fatal**
  en mode API : `Repository.transact` applique les *deletes* PUIS les *updates*, donc un update sur une
  ligne supprimée la RESSUSCITE par upsert — comportement déjà verrouillé par un test, et déjà gardé par
  `ApiRules.residualCascade` pour le lot `/transact`. Le cas ne pouvait PAS se produire avant la récursion ;
  il le peut maintenant (supprimer un équipement supprime ses agrégats, dont la règle détache des ports que
  le même plan supprime). Écarté : laisser passer et compter sur les exécuteurs — le `Store` s'en sortait
  par accident (il relit l'enregistrement après suppression et le filtre), `Api.remove` non. La garantie
  appartient au plan, pas à celui qui l'applique.
- **Les détachements sont RÉDUITS à un par (collection, id, clé), la DERNIÈRE valeur gagnant.** C'est
  exactement ce que produisent les deux exécuteurs, qui les appliquent en séquence : la réduction ne change
  aucun résultat, elle empêche seulement le plan d'enfler d'un facteur égal au nombre de chemins.
- **Un détachement qui RETIRE un élément d'une LISTE doit se composer sur la valeur DÉJÀ PLANIFIÉE
  (`pendingValue`), pas sur l'enregistrement d'origine.** C'est le piège central du lot, et il n'a rien
  d'académique : supprimer une baie supprime ses N brosses, donc rejoue N fois la règle `waypoints` sur les
  MÊMES routes. Chaque valeur étant ABSOLUE et le dernier écrit gagnant, calculer chaque retrait sur la route
  ORIGINALE n'en aurait retiré qu'UNE SEULE — les autres brosses seraient restées dans les `waypoint_ids`,
  pointant des waypoints supprimés. La cascade récursive aurait donc **créé** l'orphelin qu'elle prétend
  supprimer. Écarté : conserver le nettoyage EN LOT du hook `racks` (il masquait le problème sans le
  résoudre — il serait resté faux pour toute autre règle supprimant plusieurs waypoints), et écarté aussi
  un post-traitement par INTERSECTION des valeurs proposées (correct pour un retrait, faux pour tout autre
  détachement, et magique). Vérifié par sonde : sans la composition, une route de trois brosses n'en perd
  qu'une.
- **Deux hooks deviennent des règles `delete` DÉCLARATIVES** (lanes de breakout, brosses d'une baie) plutôt
  que d'être réécrits en `custom` allégés. Ce sont des FK simples ; l'en-tête du fichier pose depuis toujours
  la règle « une entrée déclarative, un `custom` seulement pour ce qui n'est pas une FK simple ». La
  récursion est ce qui les rend enfin exprimables ainsi. Écarté : garder les `custom` amputés — même
  ensemble d'entités, mais deux règles qui se lisent comme des exceptions.
- **La spec de cascade n'est PAS redessinée.** Aucune relation n'est ajoutée ni retirée : les deux entrées
  `delete` nouvelles sont les MÊMES `find(...)` que les `custom` qu'elles remplacent, et le rayon d'action
  mesuré sur données réelles le confirme (Δ = 0). Écarté : profiter du lot pour convertir `rackItems` en
  `detach` avec `set` (c'est possible), ou pour combler des cascades manquantes — un lot qui touche la
  SUPPRESSION DE DONNÉES ne mélange pas deux sources de changement.
- **Aucune adaptation des deux exécuteurs.** `Store.remove` (mode fichier) applique les détachements PUIS
  les suppressions, en un seul lot où l'ordre des suppressions est indifférent ; `Api.remove` (mode API)
  fusionne les détachements par enregistrement puis délègue à une transaction SQLite unique. Un plan plus
  PROFOND n'est pour eux qu'un plan plus LONG. Les deux reçoivent un commentaire expliquant *pourquoi* ils
  n'ont rien à faire — la propriété qui les sauve (aucun détachement sur une entité supprimée) est
  désormais garantie en amont, et il faut que ça se lise à l'endroit qui en dépend.
- **Attentes EXPLICITES, jamais de parité** (§4.1). L'ancien moteur a servi à MESURER le rayon d'action
  (relu depuis git, jamais retranscrit), puis a été jeté : les tests livrés figent des ensembles d'ids et des
  comptes EN DUR. Comparer le plan récursif au plan récursif n'aurait rien prouvé.
- **Sondes de mutation** : récursion neutralisée (la file n'est plus alimentée) → **31 FAIL**, dont **5
  tests PRÉEXISTANTS** — c'est ce qui prouve que la récursion porte bien le comportement des hooks retirés ;
  garde anti-cycle neutralisé → **12 FAIL** (dont des plans de 2 000 entités sur un cycle, plafonnés par la
  sonde) ; filtre « détachement sur entité supprimée » neutralisé → **2 FAIL** ; composition des retraits de
  liste neutralisée → **3 FAIL**, dont **1 test PRÉEXISTANT** (« les 2 brosses retirées de la route en une
  passe »).

**Coût mesuré, assumé** : la récursion appelle `find` un peu plus souvent (une passe supplémentaire par
entité supprimée). En mode API, chaque `find` est un balayage complet de table (cf. `persistance.md`) —
supprimer un équipement de 88 ports passe d'environ 180 à 270 requêtes. C'est le prix de la fermeture, et il
disparaîtra avec la migration relationnelle (§5), où ces `find` deviendront des index.

~~**Non fait, volontairement** : `ApiRules.residualCascade` appelle `Cascade.plan` UNE FOIS PAR suppression
du lot…~~ ✅ **CORRIGÉ en §6.17** : le lot se calcule désormais en UN SEUL plan (`Cascade.planMany`).

### 6.17 Le LOT se calcule en UN SEUL plan — **IMPLÉMENTÉ**

Dette nommée par §6.16 (« la composition ne joue qu'à l'intérieur d'un appel »), refermée ici.
`ApiRules.residualCascade` bouclait `Cascade.plan` **une fois par suppression du lot** et fusionnait les
résultats après coup. Or les trois garanties du moteur (composition des retraits de liste, garde
anti-cycle/dédup, écart des détachements sur entité supprimée) sont portées par des **accumulateurs**
(`seen`, la liste des détachements planifiés) qui ne valent que dans la portée d'UN appel : **entre deux
appels, rien ne compose**.

**Le défaut était RÉEL, pas théorique.** Un détachement qui retire un id d'une LISTE porte une valeur
ABSOLUE, et le dernier écrit gagne chez les deux exécuteurs. Deux waypoints d'une même route supprimés
dans le même lot produisaient donc deux valeurs de `waypoint_ids` calculées chacune sur la route
d'ORIGINE : la seconde écrasait la première, **un seul des deux sortait de la route**, et le câble
conservait une référence vers un waypoint pourtant supprimé — exactement l'orphelin que la cascade existe
pour empêcher. Mesuré sur les documents réels : sur `demo-infra.json`, un lot supprimant deux waypoints du
câble `cbl-core01-swb01` laissait `wp-a-chemin` dans sa route ; sur le document de PRODUCTION, un lot
supprimant deux groupes d'un même équipement laissait le groupe supprimé dans `group_ids` **et l'y
repointait comme groupe PRIMAIRE**. Sur un lot de stress (400 waypoints sur 200 câbles à routes
partagées), **200 câbles sur 200** gardaient au moins une référence pendante ; après correction, **0**.

**Ce qui a été fait** : `Cascade.planMany(targets, find, fetch)` calcule le plan de TOUT un lot en une
passe — un seul `seen` (amorcé avec TOUTES les cibles), un seul accumulateur de détachements, une seule
réduction finale. `Cascade.plan(collection, id, …)` devient une **enveloppe à une racine** ; ses deux
appelants (`Store.remove`, `Api.remove`) ne bougent pas. `residualCascade` appelle `planMany` **une fois**
puis retranche ce que le lot contient déjà — son CONTRAT (ne rendre que le travail MANQUANT) est inchangé.

**RAYON D'ACTION.** Ancien moteur relu depuis le build de HEAD (§4.1), jamais retranscrit :

| Mesure | Document | Résultat |
|---|---|---|
| Balayage MONO-suppression (parité stricte du chemin `plan`) | `demo-infra.json` (246) + PRODUCTION (644) | **890 lots, 0 différence** — ni suppression, ni détachement, ni valeur |
| Lots multi-suppressions ciblés (2 waypoints d'une route, 2 ports d'un équipement, équipement + un de ses ports, baie + une de ses étagères, 2 groupes, 2 réseaux, lot client complet, « tous les waypoints/groupes/réseaux ») | les deux documents | **0 suppression perdue, 0 gagnée, 0 update perdu ou apparu** — seules changent les VALEURS des retraits de liste |
| Fuzz de lots aléatoires (2 à 7 suppressions) | 8 000 lots sur les deux documents | **0 régression** ; 6 champs changent, tous sur `demo-infra` — et ce sont exactement les 6 listes qui gardaient une référence PENDANTE (**6 → 0**) |

**Le plan reste un SUR-ENSEMBLE de l'ancien** : aucune entité ne DISPARAÎT des suppressions, aucun
détachement ne disparaît sur une cible survivante. La seule différence observable est la **valeur** d'un
retrait de liste, toujours dans le sens « la référence supprimée sort enfin ».

**Décisions prises À L'IMPLÉMENTATION** — avec les alternatives écartées et leur motif :

- **`plan()` DÉLÈGUE à `planMany([une cible])`** plutôt que de coexister avec elle. Une seule
  implémentation de la récursion, des garanties et de leur commentaire. Écarté : dupliquer la boucle pour
  « ne pas risquer » le chemin unitaire — c'est précisément la duplication que le principe n°3 interdit, et
  la parité est prouvée par balayage (890 suppressions, Δ = 0) plutôt que par prudence.
- **Les cibles s'écrivent `{ collection, id }`, les effets `{ c, id }`.** Le vocabulaire d'entrée est celui
  de `plan(collection, id, …)` et des lots `/transact`, dont la liste de suppressions se passe **telle
  quelle** à `planMany` (aucun remaniement de forme au point d'appel). La forme terse reste aux effets.
- **La composition est ÉTENDUE aux GROUPES et aux RÉSEAUX** (`detachGroupFromMembers`, hook `networks`).
  Elle n'y était pas, et son absence était explicitement documentée comme sûre : « un seul groupe pouvant
  être supprimé par plan ». **`planMany` rend cette prémisse fausse** — un lot peut en supprimer plusieurs,
  et ils atterrissent dans le même plan. Sans cette extension, le lot aurait *créé* la version « groupes »
  du bug qu'il corrige pour les waypoints. La liste ET le primaire se composent (repointer le primaire sur
  un groupe que le même lot supprime serait une seconde façon de laisser une référence pendante). Écarté :
  s'en tenir à la lettre du besoin (les waypoints) — trois règles retirent d'une liste, la garantie doit
  valoir pour les trois, sinon elle n'est pas une garantie. Le chemin à UNE racine est inchangé au champ
  près (aucune règle ne supprime de groupes ni de réseaux, donc rien à composer).
- **La garde anti-résurrection ne ferme PAS de trou au niveau `/transact`** — vérifié, et dit ici pour
  qu'on ne le « redécouvre » pas comme un gain. `residualCascade` filtrait déjà ses updates contre
  l'ensemble COMPLET des entités supprimées (lot + résidu), constitué avant le filtrage : les deux ordres
  de suppression étaient donc couverts, et la sonde le confirme (neutraliser l'amorçage de `seen` ne fait
  rougir AUCUN test serveur). Ce que l'amorçage apporte : la garantie descend **dans le plan**, donc elle
  vaut pour tout futur consommateur de `planMany` qui ne re-filtrerait pas, et le plan cesse de produire
  des détachements voués à être jetés (avec le `fetch` inutile qui va avec).
- **`residualCascade` GARDE son filtre final** bien que le plan exclue déjà les cibles du lot. Il n'est
  redondant que pour les cibles : les suppressions **RÉSIDUELLES**, que le plan découvre et que le lot ne
  contient pas, ne peuvent être écartées qu'ici. Écarté : le supprimer au motif qu'il « ne sert plus » —
  il sert, pour l'autre moitié des cas.
- **Attentes EXPLICITES, jamais de parité** (§4.1). L'ancien moteur a servi à MESURER, puis a été jeté :
  les tests livrés figent des valeurs de liste EN DUR. Le test décisif (« un lot de deux waypoints d'une
  même route les retire tous les deux ») a été exécuté contre l'ANCIEN moteur : **il échoue**, en rendant
  `["w1","w3"]` au lieu de `["w3"]` — la preuve que le défaut existait.
- **Sondes de mutation** : composition INTER-RACINES neutralisée (plancher de balayage de `pendingValue`
  ramené au début de la racine courante) → **19 FAIL**, et aucun test préexistant — c'est ce qui montre que
  la sonde isole bien le lot, la composition RÉCURSIVE de §6.16 restant intacte ; `seen` amorcé avec la
  PREMIÈRE cible seulement → **4 FAIL**, tous au niveau du PLAN (voir la décision ci-dessus).

**COÛT — mesuré, et sans triomphalisme.** Le nombre de **parcours de plan** passe de N à **1** pour un lot
de N suppressions. En appels `find` (chacun étant un balayage complet de table côté serveur, cf.
`persistance.md`) le gain dépend du régime de lecteurs :

| Lot | Parcours de plan | `find()` — lecteurs BRUTS | `find()` — lecteurs CONSCIENTS DU LOT |
|---|---|---|---|
| Équipement de 53 ports + TOUTE sa cascade (PRODUCTION, N = 54) | 54 → **1** | 327 → **168** (−49 %) | 168 → 168 (**inchangé**) |
| Baie + toute sa cascade (PRODUCTION, N = 4) | 4 → **1** | 11 → **7** (−36 %) | 7 → 7 (**inchangé**) |
| Chaîne de breakout de 40 ports supprimée en un lot | 40 → **1** | 2 460 → **120** (−95 %) | 120 → 120 (**inchangé**) |

Autrement dit : le coût **quadratique** est réel (dernière ligne : chaque plan re-descendait toute la
chaîne), mais sur le chemin `/transact` d'aujourd'hui il était déjà **masqué** par les lecteurs conscients
du lot, qui cachent au plan les entités que le lot supprime lui-même. Ce qui disparaît à coup sûr, c'est le
travail par-plan (N allocations + N réductions + N fusions de détachements) : sur le lot de stress de
400 waypoints, **69 ms → 21 ms**. Le gain en `find` se matérialise dès que les cascades des cibles se
recouvrent sans être masquées — c'est-à-dire précisément quand l'instantané du client est périmé, la
situation pour laquelle `residualCascade` existe.

**Non fait, volontairement** : `Store.remove` (mode fichier) et `Api.remove` (DELETE unitaire) continuent
d'appeler `plan()` — ils suppriment UNE entité, `planMany` ne leur apporterait rien. Le jour où le mode
fichier offrira une suppression multiple, c'est `planMany` qu'il devra appeler, pour exactement les raisons
ci-dessus.

### 6.18 Les dettes laissées par le chantier sont refermées — **IMPLÉMENTÉ**

Lot de NETTOYAGE, sans nouveau concept. Il solde ce que §6.7, §6.14 et le lot 9 avaient explicitement
laissé derrière eux. Un seul de ses quatre points est un vrai défaut ; les trois autres sont du résidu.

**1. Quatre fichiers de `src-shared/` AFFIRMAIENT ENCORE une contrainte abolie — et c'est un BUG, pas un
détail de forme.** `Schema.ts`, `DocumentChangeset.ts`, `VmSync.ts` portaient en en-tête « Contrainte
`shared/` : fichier AUTO-SUFFISANT (aucun import relatif) », et `DataValidation.ts` répétait la même chose
en deux commentaires internes — alors qu'il **importe** `./RackDepthPolicy.js` depuis §6.14, six lignes
plus haut. La contrainte est levée depuis §6.7 (mise à jour).

> **Pourquoi ce n'est pas cosmétique.** Une doc périmée qui *interdit* quelque chose ne se contente pas de
> vieillir : elle **fabrique la dette qu'elle prétendait éviter**. Un contributeur qui lit « auto-suffisant »
> renonce à un import légitime et RÉÉCRIT la règle sur place — c'est-à-dire exactement la duplication
> `TrayFit` ⇄ `RackGeometry` (§6.7) et `RackDepth` ⇄ `RackGeometry` (§6.14), qui ont coûté deux lots et fait
> apparaître **quatre divergences silencieuses** entre les copies. La règle générale : un énoncé de doc qui
> **empêche** une action est plus dangereux qu'un énoncé qui la décrit, parce que son effet ne se voit nulle
> part dans le code — seulement dans le code qu'on n'a PAS écrit.

Les en-têtes disent désormais la règle RÉELLE : import relatif AUTORISÉ entre fichiers partagés, extension
`.js` IMPÉRATIVE (NodeNext l'exige côté serveur ; l'omettre compile côté front et casse le build serveur),
et l'avertissement de ne pas dupliquer une règle « pour rester auto-suffisant ». Corrigés au passage, même
défaut : la phrase de `CLAUDE.md` « les modules partagés existants n'ont, eux, aucun import relatif »
(fausse depuis §6.14) et la justification « shared/ auto-suffisant » de la ligne T12/T9b de
`validation.md`. ⚠ Deux occurrences SUBSISTENT, dans le harnais de tests (`Tests/modules/harness.js`,
`test-sync.js`) : hors périmètre de ce lot, signalées.

**2. `RackGeometry.frontMountAvailDepth` était bien un doublon — mais la preuve a trouvé une nuance.**
§6.14 l'annonçait « doublon EXACT de `mountAvailDepth(rack, "front")` ». Vérifié avant de retirer (méthode
§4.1, sur le code COMPILÉ, jamais retranscrit) : **257 400 comparaisons** sur une grille de 18 profondeurs
× 13 cages × 11 marges avant × 10 portes avant × 10 portes arrière (valeurs absentes, vides, nulles,
négatives, fractionnaires, en chaîne et non numériques comprises) → **205 divergences**, **TOUTES** sur la
seule profondeur `2^53` mm (≈ 9 milliards de km), écart maximal **2 mm**, soit **un ULP** à cette
magnitude. Sur les 228 800 comparaisons restantes — toute profondeur physiquement représentable — **ZÉRO
divergence**, NaN et signe du zéro compris.

> La cause n'est pas une différence de RÈGLE mais d'**associativité IEEE 754** : `((d − marge) + av) + ar`
> contre `(d − marge) + (av + ar)`. Les deux expressions sont la même somme regroupée autrement, et
> l'addition flottante n'est pas associative. Verdict : **équivalents**. La méthode reste bonne — c'est
> précisément parce que la sonde couvrait des valeurs absurdes qu'on peut affirmer *où* est la limite au
> lieu de l'espérer. Contrôle de discrimination posé dans la même sonde : `mountAvailDepth(rack, "rear")`
> diffère bien de la forme `"front"` sur 1 027 des 2 574 formes testées — sans quoi la sonde aurait aussi
> bien pu comparer une fonction qui ignore son argument.

Les deux appelants (`RackForms`, hauteur de brosse) passent à la forme paramétrée, dans le même fichier et
la même fonction qu'un `mountAvailDepth(rack, side)` déjà présent. Le doublon disparaît.

**3. Code MORT retiré**, après recherche exhaustive d'usages (`src-client/`, `src-server/`, `Tests/`,
`design-system/`, usages dynamiques et chaînes comprises) : `RackGeometry.minDepth` (aucun appelant, et
vacuité pure depuis §6.14 — il ne faisait que déléguer à `cageDepth`, la cage étant désormais bornée) et
`DcCamera.setMultiDc()` (aucun appelant : la bascule « Vue étage » écrit `this.multiDc` puis `refit()`
depuis `DcPanels`). Aucun test ne les nommait : **aucun test retiré**.

**4. CSS orpheline retirée** : la règle `.dc-bldg-sep`, vestige 2D du plan séparateur inter-bâtiments
supprimé au lot 9 (§6.9 / « ce que le lot 4 a laissé de côté »). Aucun code TS ne l'émet plus — vérifié, y
compris pour un nom de classe CONSTRUIT. Le commentaire de bloc qui l'annonçait (« PAROI pointillée
translucide marquant le passage à un autre bâtiment ») part avec elle. Les 23 previews de `design-system/`
inlinent le CSS de l'app : régénérées par `design-system/build.js`, leur diff ne contient QUE cette
suppression.

**Aucun changement de comportement observable** : les quatre points sont de la doc, du code sans appelant,
un alias prouvé équivalent et une règle CSS que rien ne sélectionne.

### 6.19 L'isolement de `src-shared/` devient MÉCANIQUE — **IMPLÉMENTÉ**

§6.7 et §6.18 ont corrigé une doctrine périmée. Ce lot corrige la doctrine qui la remplaçait : elle
**confondait deux règles** que rien ne rendait comparables.

| Règle | Nature | État avant ce lot |
|---|---|---|
| (1) un fichier partagé n'importe RIEN **hors de `src-shared/`** | **PERMANENTE** — aucune configuration ne la lèvera | jamais énoncée explicitement |
| (2) les fichiers partagés ne peuvent pas s'importer **entre eux** | artefact de build (résolution webpack) | **LEVÉE en §6.7** |

L'énoncé historique — « les fichiers de `src-shared/` sont **auto-suffisants** » — les tenait en une seule
phrase, et **justifiait la (1) par la contrainte de build de la (2)**. Quand §6.7 a démoli cette
justification par la mesure, la phrase entière a paru tomber : c'est ce glissement qu'il fallait arrêter.

**Pourquoi (1) est permanente, et pourquoi elle est GRAVE.** Un `src-shared/X.ts` qui importerait un module
de `src-client/` ferait embarquer du **DOM** dans le build SERVEUR ; un import vers `src-server/` ferait
embarquer du **Node** dans le FRONT. Un paquet npm tombe sous la même règle : rien ne garantit sa présence
des deux côtés. Et l'effet est **TRANSITIF**, donc **invisible à la relecture** — le module importé peut
être pur *aujourd'hui* et cesser de l'être demain, la violation apparaissant sans que personne n'ait
touché à `src-shared/`. `CLAUDE.md` n'énonçait qu'une règle sur le **CONTENU** (« TS PUR : ni DOM ni
Node ») ; on pouvait la respecter à la lettre en violant la **fermeture transitive**.

**Le verrou.** Section *« shared : ISOLEMENT du dossier »* de `Tests/modules/test-shared-validation.js`,
posée à côté des gardes anti-divergence existantes (même forme : `section()` + `ck`, aucun mécanisme
parallèle). Elle relit les **SOURCES** `src-shared/**/*.ts` — jamais le compilé, car c'est le spécificateur
ÉCRIT par le contributeur qu'on contrôle — et échoue en **nommant le fichier, la ligne et le spécificateur**
fautifs. Accepté : un relatif qui reste dans le dossier ET porte l'extension `.js` (règle (2)). Refusé :
tout ce qui sort, tout chemin absolu, tout spécificateur nu (npm / natif Node), et — au titre de la règle
(2) — un import interne sans extension.

**Décisions prises à l'implémentation :**

- **Parseur TypeScript, pas d'expression régulière.** Ces fichiers **documentent leurs propres imports en
  prose** (`import { RackDepthPolicy } from "./RackDepthPolicy.js"` figure en commentaire dans plusieurs
  d'entre eux) : une regex y verrait des faux positifs, et un jour un faux négatif. Le parcours d'AST
  ignore commentaires et chaînes littérales par construction.
- **`ts.preProcessFile` seul NE SUFFIT PAS — mesuré, pas supposé.** Sur une sonde couvrant douze formes, il
  **RATE `export * as N from "x"`**. C'est précisément le défaut qu'on cherchait à éviter — une contrainte
  déclarée mais inerte, comme le `FieldSpec.max` du lot 12c. Le détecteur prend donc l'**UNION** d'un
  parcours d'AST (exhaustif) et de `preProcessFile` (filet contre un type de nœud oublié).
- **Un contrôle de DISCRIMINATION accompagne le verrou**, dans la même section : douze formes d'import
  synthétiques doivent être VUES (`import … from`, `import "x"`, `import type` sous ses deux formes,
  `export { … } from`, `export * from`, `export * as N from`, `export type { … } from`, `import()`
  dynamique, `import X = require()`, `require()`, import multi-lignes) et trois leurres — deux
  commentaires et une chaîne littérale — doivent être IGNORÉS. Sans lui, le verrou passerait au vert en
  ne détectant rien du tout. Une assertion d'anti-vacuité vérifie en outre qu'il a bien LU des sources
  réelles (au moins un import interne effectivement vu).
- **Parcours RÉCURSIF du dossier**, bien qu'il soit plat aujourd'hui : la règle doit tenir s'il cesse de
  l'être, et un spécificateur est résolu contre le répertoire de SON fichier.

**Preuve que le verrou MORD** (sonde posée puis retirée par copie) : un `import { Html } from
"../src-client/core/Html.js"` ajouté à `src-shared/Schema.ts` fait rougir la suite avec
`src-shared/ : ISOLEMENT — aucun import hors du dossier … (attendu "", obtenu
"Schema.ts:26 → \"../src-client/core/Html.js\" — SORT de src-shared/")`.

**État constaté** : **aucune violation**. Un seul import existe dans tout `src-shared/`
(`DataValidation.ts:30 → "./RackDepthPolicy.js"`), et **aucun fichier partagé n'importe de paquet npm** —
l'invariant tenait déjà, par convention seule ; il tient désormais par construction.

### 6.20 Les PORTS d'un équipement posé sur un ÉTAGE — **IMPLÉMENTÉ**

Le cas que §1 symptôme 3 désigne nommément : « la sixième branche (étage) est IMPOSSIBLE à écrire dans ce
moule, parce que son hôte n'est pas une salle ». Les cinq branches de `resolveFaceAnchor3D` exigent toutes
un `dcId` ; un équipement d'étage n'en a pas, donc `resolvePort3D` rend `null` pour tous ses ports — ils
étaient DESSINÉS en 3D depuis le lot du décor d'étage, mais sans un seul connecteur. `Resolver3D`
gagne le PENDANT sans salle, `resolvePortWorld3D(portId, worldOriginX, worldOriginY, worldOriginZ)`, et
`DcThreeScene` sépare enfin le DESSIN d'un port (`addPortAt`) de sa RÉSOLUTION.

C'est aussi le seul lot du chantier à appliquer §4.1 point 1 à la lettre — **commencer par le cas qui ne
rentre pas** — puisque rien n'existait : il n'y a aucune parité à prouver, seulement des attentes à écrire.

**TRAVAIL REPRIS, pas réécrit.** Une première implémentation avait été faite puis RETIRÉE de `dev` sur
demande ; elle vit dans le tag `sauvegarde-avant-scrap-2026-07-27` (commits `35d8190` et `8c9fa33`). Le
DESIGN, les DÉCISIONS et les TESTS en sont repris ; le CODE, lui, a dû être RÉ-EXPRIMÉ, parce que les trois
méthodes qu'il appelait (`FreeEquipGeometry.portWorldC`/`portWorld`/`portNormal`) n'existent plus — §6.12 les
a remplacées par `portLocal`/`faceNormalLocal`/`roomPlacement`, qui ne composent plus rien. Un cherry-pick
aurait donc compilé sur une API morte.

**Décisions prises À L'IMPLÉMENTATION** — avec les alternatives écartées et leur motif :

- **Le repère de sortie est DANS LE NOM** : `resolvePortWorld3D` rend du **MONDE**, quand tout le reste du
  fichier rend du LOCAL SALLE. L'asymétrie n'est pas un défaut à corriger : au-dessus de la salle il n'existe
  aucune transformée INTRINSÈQUE à composer (§6.6), la position d'un étage relevant du LAYOUT. Le contrat est
  donc « origine MONDE en entrée ⇒ point MONDE en sortie », et les paramètres se nomment `worldOrigin*` pour
  qu'il ne se lise pas de travers. ⚠ §6.12 se terminait sur « plus aucun identifiant du chemin de résolution
  n'annonce *monde* » : ce lot en réintroduit un, et ce n'est PAS une rechute. La dette d'alors était que le
  nom MENTAIT ; §3 règle 5 n'exige pas le silence sur le repère, elle exige qu'il soit EXPLICITE. Écarté :
  taire le monde pour préserver l'uniformité du fichier — on aurait rendu implicite la seule chose que la
  règle demande d'annoncer.
- **La transformée du conteneur est REÇUE, jamais calculée par le résolveur.** L'appelant lui donne l'origine
  monde de l'étage (`FloorLayout.equipFloorWorld` pour x/y, `FloorLayout.levelZ` pour le socle). Écarté :
  injecter le `MultiLayout` dans `Resolver3D` pour qu'il aille la chercher — cela ferait dépendre la position
  d'un port de l'ensemble AFFICHÉ, exactement l'inverse de §6.8, et c'est déjà l'alternative écartée en §6.11.
- **La composition est DÉLÉGUÉE à `PlacementFrame`, pas réécrite.** Ce qu'il faut composer — « lacet PROPRE du
  contenu, PUIS translation à son origine » — est *mot pour mot* ce que fait le conteneur salle ; seule la
  PROVENANCE de l'origine change (déclarée dans l'enregistrement pour un contenu de salle, fournie par le
  layout pour un contenu d'étage). Écarté : recomposer `cos`/`sin` dans `Resolver3D`, ce que §3 règle 1
  désigne comme la signature d'un conteneur manquant — et ce que le tag faisait *de facto*, en appelant un
  `portWorldC` qui composait à l'intérieur de `FreeEquipGeometry`. Écarté aussi : un module `FloorFrame`
  jumeau, qui aurait figé une duplication ligne pour ligne.
- **⚠ TROISIÈME OCCURRENCE CONSTATÉE, généralisation NON FAITE — et c'est un ARBITRAGE, pas un oubli.** Une
  baie dans une salle, un équipement libre dans une salle, un équipement libre sur un étage : trois contenus
  « posés avec une position et un lacet ». §4.3 autoriserait d'extraire. On ne l'a délibérément PAS fait :
  §6.12 a borné la généralisation au contenu d'une SALLE en s'appuyant sur §6.6, et la lever est une décision
  de doctrine, pas un effet de bord d'un lot de rendu. Ce qui est acquis et vérifiable est plus modeste, et
  suffit : **le module compose dans le repère de l'origine qu'on lui donne**, il ne connaît toujours ni
  étage, ni bâtiment, ni layout. Son en-tête le dit désormais, et pose la question ouverte plutôt que d'y
  répondre seul.
  ✅ **Question TRANCHÉE en §6.22**, par l'utilisateur et non par un effet de bord : le module s'appelle
  `PlacementFrame`. La constatation faite ici est exactement ce qui a rendu la décision possible ; ce qui
  est resté intact, c'est la borne (le module ne remonte toujours pas au monde tout seul), et elle est
  passée de l'affirmation au VERROU DE TEST.
- **`worldOriginZ` ne porte QUE le socle du conteneur.** La hauteur propre (`dc_z`) est déjà dans le point
  local (`portLocal` part de `box().z`) : elle est ajoutée UNE fois, du côté du résolveur. C'est la même
  convention que `DcThreeScene.buildEquipBox`, qui pose son groupe sur le socle puis sa boîte sur `box().z` —
  donc que le descripteur `FloorEquipDesc`, qui ne porte volontairement aucun `z`. Écarté : passer l'origine
  déjà sommée (`equipFloorWorld().z`, qui inclut `dc_z`) — le port serait monté de `dc_z` AU-DESSUS de la
  boîte, un décalage d'autant plus traître qu'il est invisible tant que l'équipement est posé au sol.
- **Le DESSIN d'un port est séparé de sa RÉSOLUTION** (`addPortAt`). Le connecteur, sa couleur, sa taille
  physique, son cadre noir, sa couche « port » et son `pick` ne dépendent PAS du conteneur ; seule la
  résolution en dépend. Les deux conteneurs partagent donc un seul rendu — d'où le fait, gratuit, qu'un port
  d'étage se comporte exactement comme un port de salle vis-à-vis de `showPorts` et du masquage individuel.
  Écarté : un second chemin de dessin pour l'étage, qui aurait divergé au premier réglage ajouté.
- **La règle du BREAKOUT est retrouvée par construction.** Une lane émerge du connecteur de son TRUNK
  (`parent_port_id`) : la version qui composait la chaîne DANS la vue l'avait oubliée, et rien ne l'aurait
  signalé. Ce n'est pas un détail d'implémentation mais l'argument le plus concret contre un second chemin de
  résolution parallèle — la règle vit là où les deux conteneurs la lisent.
- **Aucune ROTATION de conteneur, RE-VÉRIFIÉE et non supposée.** L'invariant est daté du premier jet, avant
  que le site n'acquière une position (§6.9) puis une taille déclarée (§6.8) : il fallait donc le remesurer.
  Verdict : il TIENT. La spec `sites` ne porte que `name`, `address`, `lat`, `lon`, `width_mm`, `depth_mm` —
  aucune orientation ; `SiteLayout` rend des `{x, y}` (la compression logarithmique déplace un point le long
  d'un rayon, elle ne tourne rien) ; `multiLayout` ne compose pour un plan d'étage que `bx + anchor_x`,
  `by + anchor_y` et `levelZ` ; le seul angle du layout est le `floor_orientation` d'une SALLE, qui est la
  transformée de la salle en tant que CONTENU, pas celle d'un conteneur d'équipement d'étage. Seul le lacet
  propre de l'équipement tourne. À revoir si un conteneur acquiert un jour une orientation — le résolveur le
  dit à l'endroit exact.
- **Attentes EXPLICITES, plus une équivalence — les deux, jamais l'une à la place de l'autre.** Les
  coordonnées sont figées EN DUR, dérivées à la main du modèle (boîte 200 × 400 × 300 à `dc_z` 250, port avant
  à 0,25 / 0,5 ⇒ local (−50 ; −200 ; 400)), aux QUATRE lacets cardinaux. S'y ajoute le test d'équivalence que
  le tag prévoyait : **le même équipement posé en salle et posé sur un étage donne des ports au même endroit,
  au décalage du socle près** — vérifié aux quatre lacets, sur le point ET la normale. Le relatif dit
  l'intention (un seul repère), l'absolu dit la valeur ; un test purement relatif resterait vert si les deux
  chemins dérivaient ENSEMBLE (piège du lot 2, §4.1).
- **La CHAÎNE COMPLÈTE est verrouillée, pas seulement le résolveur.** `DatacenterView` s'instancie en
  headless : `webglCtx().floorDecor` rend un descripteur PUR, donc on peut figer ce que la vue POUSSE au
  résolveur — `baseZ = 6 000` (socle du niveau 1) et **pas** `6 250`, l'absence de champ `z`, puis le port à
  `z = 6 400`. C'est là que le piège du `dc_z` se joue réellement : entre deux couches, pas dans une seule.
- **Sondes de mutation** : `dc_z` comptée DEUX fois → **25 FAIL** ; normale TRANSLATÉE par l'origine du
  conteneur → **31 FAIL** ; règle du breakout neutralisée → **1 FAIL** (l'assertion dédiée, doublée d'un
  contrôle de discrimination prouvant qu'un port aux mêmes fractions SANS parent tombe ailleurs — sans quoi
  l'assertion serait tautologique).
- **Non fait, volontairement — LES ÉQUIPEMENTS D'ÉTAGE NE SONT TOUJOURS PAS CÂBLABLES**, et ce lot ne le
  prétend pas. `Store.equipmentDcId` rend `null` pour eux PAR CONCEPTION, et toute la machinerie de câblage ne
  connaît que « dans la salle X » ou « non placé » : un câble ne peut donc toujours pas s'y raccorder, et les
  connecteurs nouvellement dessinés resteront gris (non câblés) tant que ce blocage tient. C'est le chantier
  que §6.4 décrit — généraliser la CLÉ de la machinerie de câblage de « salle » à « conteneur » — et il est
  distinct. Ce lot le rend simplement VISIBLE : on voit désormais où les câbles devront arriver.

### 6.21 Le PIVOT D'ORBITE suit le REPÈRE, et devient une boîte 3D — **IMPLÉMENTÉ**

Signalé par l'utilisateur : en « Vue étage », la contrainte de rotation de la caméra **reste liée à la salle
active** au lieu de suivre les enveloppes de bâtiment ; pointer hors d'un bâtiment envoie le pivot sur un plan
que rien ne dessine ; les limites devraient être une boîte englobant les sites affichés.

Cause, vérifiée : `DcThreeScene.recomputePivotAabb` posait `pivotAabb` = l'union des **SALLES** affichées, en
**XY seul**. C'est le symptôme n°1 du §1 une couche plus loin — un comportement de **REPÈRE** dérivé d'un
sous-arbre de **PORTÉE**. Le repli du pivot (aucune surface au centre de l'écran) tombe, lui, sur le plan de sol
`z = 0` **infini et invisible** de `DcThreeBase`, puis était ramené dans cette boîte de salle.

**Décisions prises À L'IMPLÉMENTATION** — avec les alternatives écartées et leur motif :

- **L'enveloppe est celle des BÂTIMENTS** (`MultiLayout.buildings`), donc la taille **DÉCLARÉE** du site quand
  elle existe (§6.8), sinon l'emprise déduite de ses plans. Écarté : l'union des **plans d'étage** dessinés —
  elle se confond avec l'enveloppe tant que rien n'est déclaré, mais un bâtiment déclaré plus grand que ses
  plans est précisément le cas où les deux lectures divergent, et c'est l'enveloppe qui fait foi.
- **Les bandes sont FILTRÉES par la portée, les positions ne le sont pas.** `multiLayout` émet une bande pour
  chaque bâtiment du **MODÈLE** (§6.8 : masquer retire du dessin, pas du repère) ; on n'en retient que celles
  qui ont au moins un plan **dessiné**. C'est le corollaire opératoire de §6.8 appliqué à la lettre — layout
  complet, puis on filtre ce qu'on ÉMET —, et aucune bande ne change de position selon la portée. Écarté :
  englober tous les bâtiments du modèle, ce qui ferait orbiter autour de **kilomètres de vide** dès qu'un site
  est hors portée : le défaut même qu'on corrige, réintroduit par l'autre bout.
- **⚠ ASYMÉTRIE ASSUMÉE en Z** : la hauteur reste `MultiLayout.topZ`, celle du **modèle**, non celle des seuls
  niveaux dessinés. La filtrer demanderait de recomposer la pile des niveaux **dans la vue**, ce que §3 règle 4
  interdit, pour un écart borné par la hauteur du monde — là où l'écart en XY est kilométrique. Signalé ici
  plutôt que laissé implicite.
- **Une VRAIE boîte 3D, et le plan `z = 0` RÉTROGRADÉ.** `PivotBounds.slabExitT` faisait la méthode du slab sur
  X puis Y ; elle la fait désormais sur les **trois** axes. Conséquence directe : le point de sortie du rayon ne
  quitte plus le monde (il sortait 500 mm sous le plancher ou 2 000 mm au-dessus du toit dans les cas mesurés),
  et un sol sous le plancher n'est plus « dans la boîte ». Le plan `z = 0` n'est plus qu'une **entrée de dernier
  recours, elle-même ramenée dans la boîte**.
- **Le bornage en Z est OPTIONNEL, et son absence a un sens.** `PivotAabb.minZ`/`maxZ` absents = « parois
  verticales infiniment hautes » : c'est ce que rend `unionAabb` (repère salle), dont le comportement est ainsi
  conservé **au micron** — hors Vue étage, rien ne change. Écarté : borner aussi la salle en Z, qui aurait
  changé le ressenti d'un mode que personne n'a signalé comme fautif.
- **Le DISCRIMINANT est la PRÉSENCE d'un décor d'étage, jamais un COMPTAGE.** `DcBase.webglCtx` ne pousse un
  `floorDecor` qu'en Vue étage et pose `floorDecor = null` en salle unique : c'est donc une propriété du repère.
  Écarté (et interdit par §3 règle 2) : tester le nombre de salles — `webglCtx` décrit la salle unique comme un
  « multi » à **une** salle, un comptage mentirait. C'est le piège exact qui avait égaré le diagnostic du lot 8,
  et un test le fige : une salle unique affichée en Vue étage voit l'enveloppe de **son bâtiment**.
- **La SIGNATURE d'invalidation suit** (`SceneLayoutSignature`), bien que ces bornes ne DESSINENT rien —
  justement parce qu'elles ne dessinent rien : `recomputePivotAabb` n'est rejoué qu'à la (re)construction de la
  scène, donc une enveloppe qui changerait sans changer la signature laisserait le pivot borné à l'ANCIEN monde
  jusqu'au rechargement — la sous-invalidation du lot 8, déplacée du dessin vers la caméra. Écarté : se reposer
  sur le fait que l'étiquette de bâtiment bouge « en général » quand sa bande bouge — un test le réfute, en
  déclarant une profondeur de site qui ne déplace **aucune** étiquette.
- **Un champ UNIQUE et nommé** (`FloorDecor.world`), et non le retour des `maxD`/`topZ` retirés au lot 9 : ceux-là
  DESSINAIENT le plan séparateur, supprimé depuis. Le besoin est distinct (un REPÈRE de caméra), d'où un champ qui
  le dit, plutôt que deux cotes éparses à recomposer chez le consommateur.

**⚠ LIMITE CONNUE, mesurée et NON corrigée — le pivot ne se pose pas au NIVEAU regardé.** Le raycast prioritaire
(`DcThreeCamera.recenterPivotOnView`) porte sur `gDecor`/`gRacks`/`gFree`/`gWaypoints` et **EXCLUT
délibérément `gFloorDecor`** — « le décor d'étage ne doit jamais influencer le centre de rotation ». Un plan
d'étage n'est donc **jamais** touché : en Vue étage, viser une zone vide d'un étage haut emprunte toujours le
repli. La boîte 3D borne désormais ce repli au monde (c'était le défaut criant), mais le point obtenu est une
**paroi du monde le long du rayon**, pas le plan du niveau regardé : sur un étage haut, le pivot peut encore
descendre de quelques mètres. Le remède serait un repli « plan du niveau regardé » ; il n'est **pas** implémenté —
il suppose de connaître le niveau visé, donc d'ajouter un critère au repli, et la simplicité l'emporte tant que
l'utilisateur n'a pas jugé le résultat à l'œil. Alternative annexe, également écartée ici : rendre les plans
d'étage sélectionnables par le raycast du pivot, ce qui reviendrait sur une décision d'un lot antérieur.

**Sondes de mutation** : axe Z neutralisé → **8 FAIL** ; bornes monde jamais émises par la vue → **8 FAIL** ;
filtre des bâtiments dessinés retiré → **2 FAIL** ; bornes monde non signées → **10 FAIL**.

### 6.22 `RoomFrame` devient `PlacementFrame` — **IMPLÉMENTÉ**

Renommage PUR, décidé par l'utilisateur : zéro changement de comportement, aucune signature touchée
au-delà des noms, aucune valeur d'assertion modifiée. Ce qui suit explique pourquoi le nom était devenu
faux, et surtout **ce que la doctrine doit corriger d'elle-même** — car elle citait `PlacementFrame`,
en trois endroits, comme le nom de ce qu'il ne fallait PAS faire.

**Le nom mentait, et pas d'un cheveu.** Le module s'appelait « le repère de la SALLE », mais **aucun
champ de la salle n'entre dans son calcul** : il reçoit un `RoomContentPlacement { x, y, yawDeg, halfW,
halfD }`, qui sont entièrement les champs du **CONTENU**. La salle n'était que l'espace de coordonnées
d'arrivée. Depuis §6.20, même cela avait cessé d'être vrai : `Resolver3D.resolvePortWorld3D` lui passe
l'origine MONDE d'un conteneur ÉTAGE et récupère du MONDE. Le symptôme était visible dans le fichier
lui-même — son en-tête portait **deux paragraphes dont le seul objet était de désamorcer son propre nom
de classe**. Le code s'était généralisé de lui-même ; seul le nom était en retard.

**Ce que la doctrine disait, et ce qu'elle dit maintenant.** §4.3, §6.11 et §6.12 employaient
`PlacementFrame` comme CONTRE-EXEMPLE. Les laisser en l'état aurait rendu ce document *activement*
trompeur — exactement le défaut que §6.7, §6.18 et §6.19 ont passé leur temps à réparer (« une doc qui
dit *auto-suffisant* fait DUPLIQUER »). Les trois passages sont donc corrigés SUR PLACE, en distinguant :

| | Statut |
|---|---|
| « On n'extrait pas une abstraction générique SPÉCULATIVEMENT, sur un seul cas » (§4.3) | **INTACT.** Le module en est même l'application : nom étroit à la 2ᵉ occurrence, élargi à la 3ᵉ, jamais avant |
| « La généralisation s'arrête au contenu d'une SALLE » (§6.12) | **PRÉMISSE CORRIGÉE.** La limite ne passe pas à la frontière de la salle mais à celle de l'INTRINSÈQUE (§6.6) |
| « Pas de repère qui remonte tout seul jusqu'au monde » (§6.6) | **INTACT, et désormais VERROUILLÉ** au lieu d'être seulement affirmé |

L'extraction n'est plus spéculative parce qu'elle n'est plus une extraction : **trois occurrences sont
CONSTATÉES** (baie en salle, équipement libre en salle, équipement libre sur étage), et le module s'est
révélé être le repère du CONTENU, pas d'un conteneur particulier.

**Décisions prises À L'IMPLÉMENTATION :**

- **Le NOM faisait un travail de SÛRETÉ ; il fallait le remplacer, pas seulement le changer.** « Room »
  BORNAIT la portée : personne n'aurait songé à verser une transformée d'étage dans un module nommé
  d'après la salle. `PlacementFrame` ne borne plus rien — il INVITE au contraire à y verser tout le
  placement, layout compris. C'est le prix du renommage, et il est payé en deux endroits : la borne §6.6
  passe **en tête** de l'en-tête (elle y était jusqu'ici noyée en quatrième position), et un **VERROU
  MÉCANIQUE** la tient.
- **Le verrou** — section *« PlacementFrame : BORNE §6.6 »* de `Tests/modules/test-geometry.js`, calquée
  sur §6.19. Il relit la **SOURCE** `src-client/geometry/PlacementFrame.ts` et refuse tout spécificateur
  hors **LISTE BLANCHE** (aujourd'hui : `../core/Normalize`), en nommant fichier, ligne et spécificateur.
  Liste BLANCHE et non noire : un refus par motif raterait le layout atteint **indirectement** — par le
  barrel `./index`, par un module qui le ré-exporte, par un voisin neutre aujourd'hui et porteur demain
  (le même effet TRANSITIF que §6.19 décrit pour `src-shared/`). Les motifs « porte le layout » / « module
  de vue » ne servent qu'à DIRE pourquoi un refus tombe. **Preuve qu'il mord** : quatre sondes
  synthétiques (import de `FloorLayout`, de `SiteLayout`, d'une vue, et `import()` DYNAMIQUE) produisent
  chacune un refus, et une cinquième vérifie que l'import légitime passe — sans quoi le verrou serait un
  refus aveugle. Le détecteur d'imports est CELUI de §6.19, déplacé dans le harnais
  (`TsImports.specifiersOf`) plutôt que dupliqué ; son contrôle de DISCRIMINATION (douze formes vues,
  commentaires et chaînes littérales ignorés) reste dans `test-shared-validation.js` et couvre donc les
  deux verrous.
- **Les TYPES suivent, et la COLLISION est évitée par construction.** `RoomContentPlacement` →
  **`ContentPlacement`**, `RoomBasis` → **`PlacementBasis`**, `RoomPlacedPoint` → **`PlacedPoint`**.
  `ContentLocalPoint`/`ContentLocalDir` ne changent PAS : ils nomment déjà le CONTENU, c'est-à-dire la
  thèse même de ce lot. ⚠ `FloorLayout.RoomPlacement` existe et désigne autre chose — la salle comme
  CONTENU de son plan d'étage. Aucun nom retenu ne s'en approche (`ContentPlacement` n'est pas
  `RoomPlacement`), et l'avertissement de l'en-tête est CONSERVÉ : il reste utile, les deux modules
  parlant de la salle dans des rôles inverses.
- **⚠ `pointToRoom`/`dirToRoom` et `roomPlacement` GARDENT leur nom — SIGNALÉ, non arbitré.** Ces deux
  méthodes ne sont appelées, dans le code tel qu'il est, qu'avec une origine LOCALE SALLE (la géométrie
  des waypoints) ; seul `place` reçoit parfois une origine monde. Leur nom ne ment donc à aucun point
  d'appel. Les renommer serait un SECOND arbitrage, qui devrait trancher du même geste
  `RackGeometry.roomPlacement` et `FreeEquipGeometry.roomPlacement` — des noms que §6.12 a posés
  délibérément, dans un lot dont c'était le sujet. Le précédent de §6.11 (les deux conventions d'origine,
  signalées puis tranchées un lot plus tard) s'applique : une question qui apparaît en cours de route se
  signale, elle ne s'arbitre pas en douce. `toParent()` reste, lui, explicitement proscrit (§6.6).

  > **Mise à jour — ARBITRÉ en §6.26, et l'argument ci-dessus était le mauvais.** « Aucun point d'appel
  > n'en souffre ENCORE » décrit un mensonge sans conséquence, pas un nom juste : la destination de ces
  > deux méthodes N'EST PAS la salle, elle est le repère de l'origine reçue, parfois MONDE. Elles
  > s'appellent `composePoint`/`composeDir` — l'OPÉRATION, seule chose qui ne dépende pas de l'appelant.
  > `roomPlacement`, en revanche, garde son nom pour de bon : une baie EST placée dans une salle.
- **L'histoire n'est pas effacée.** §6.11 et §6.12 GARDENT `RackFrame`/`RoomFrame` dans leur corps, sous
  un avertissement « lire au passé » — la même forme que §6.6 (« Mise à jour ») et §6.19. Un lecteur qui
  remonte un `git blame` doit retrouver les noms de l'époque ; un lecteur qui cherche le code d'aujourd'hui
  est renvoyé ici.

### 6.23 L'ÉTAGÈRE devient un conteneur : le repère PLATEAU → BAIE — **IMPLÉMENTÉ**

Dernier maillon manquant de la chaîne étagère → baie → salle. `src-shared/PlacementContainers` la
déclarait depuis le lot 1 et `src-shared/TrayGeometry` tenait la géométrie du plateau depuis §6.7,
mais la GÉOMÉTRIE DE PLACEMENT ne suivait pas : c'était la BAIE qui plaçait directement le posé,
l'étagère n'étant qu'un intermédiaire de calcul. Le conteneur s'appelle
`src-client/geometry/TrayFrame.ts`.

**Ce que l'extraction a RÉVÉLÉ** — comme en §6.7, §6.11 et §6.12, c'est le résultat le plus utile :

- **QUATRE sites re-dérivaient `tray.side !== "rear"`**, et chacun en tirait sa propre conséquence
  sans jamais nommer la règle commune (« une étagère arrière retourne ses contenus ») :
  `RackGeometry.trayEquipBoxLocal` pour retourner l'axe des profondeurs, `Resolver3D` pour le signe de
  la normale d'un port, `DcThreeScene.buildRackTrays` pour la face qui porte l'image de façade, et
  `DcThreeScene.buildRackPorts` pour le côté de masquage des ports. Le recensement en annonçait trois ;
  le quatrième n'est apparu qu'en cherchant les occurrences restantes après migration — la raison même
  pour laquelle on balaie au lieu de se fier à la liste établie (§4.1).
- **L'axe X n'est PAS retourné, l'axe Y l'est.** `tray_x` reste compté depuis la gauche DE LA BAIE, y
  compris sur une étagère arrière — donc pas depuis la gauche que voit un opérateur placé derrière.
  ⚠ **Constaté, SIGNALÉ, NON arbitré.** Ce n'est pas une divergence à réparer (les quatre sites étaient
  d'accord), c'est une question de domaine : trancher déplacerait des équipements déjà saisis. Même
  traitement qu'en §6.11 pour les deux conventions d'origine — qui ont été arbitrées un lot plus tard,
  une fois la question posée clairement.

  > **Mise à jour — ARBITRÉ en §6.24, exactement comme §6.11 l'avait été.** L'utilisateur a tranché :
  > c'est une **ROTATION de 180°**, donc les DEUX axes se retournent. Le paragraphe ci-dessus décrit
  > l'état d'avant cet arbitrage, et le délai entre les deux lots n'a duré qu'une question — parce que
  > le lot suivant a montré que la réflexion ne pouvait pas être correcte : elle NE SE COMPOSE PAS avec
  > les lacets, ce qui bloquait la correction d'un défaut réel.

**Décisions prises À L'IMPLÉMENTATION** — avec les alternatives écartées et leur motif :

- **Un conteneur SÉPARÉ, pas une extension de `PlacementFrame`.** La transformée plateau → baie est une
  TRANSLATION plus un RETOURNEMENT de l'axe Y ; celle de `PlacementFrame` est un LACET plus une
  translation. Un retournement n'est pas une rotation de 180° — celle-ci inverserait AUSSI l'axe X, ce
  que le comportement existant ne fait pas. Les faire entrer dans un seul module aurait produit
  exactement l'union qui fuit que §6.2 proscrit : deux repères voisins, deux transformées de nature
  différente. Écarté également : exprimer l'étagère comme un `ContentPlacement` à lacet 0/180 — cela
  aurait changé le comportement en douce, sous couvert d'unification.
- **Le conteneur REÇOIT son placement, il ne le calcule pas.** `RackGeometry.trayPlacementInRack(rack, tray)`
  dérive `TrayPlacement` de la boîte de l'étagère — pendant EXACT de `roomPlacement`, un cran plus bas.
  `TrayFrame` n'importe donc ni `RackGeometry` (ce qui BOUCLERAIT) ni quoi que ce soit d'autre que le
  TYPE du rectangle qu'il transporte. Le **verrou de borne §6.6** de `PlacementFrame` a été ÉTENDU à ce
  module, avec sa propre liste blanche : même code de détection, une liste de plus (principe n°3).
- **Interface ÉTROITE, littéralement (§6.2).** Seuls des RECTANGLES sont transportés — aucun appelant ne
  transporte un point ni une direction du plateau vers la baie. Pas de `pointToRack`/`dirToRack`
  spéculatifs, alors même que `PlacementFrame` en a l'équivalent : ce qui vaut pour un conteneur ne
  se recopie pas chez le voisin sans constat.
- **Parité prouvée AVANT bascule, puis attentes EXPLICITES.** L'ancien corps a été RÉGÉNÉRÉ depuis git
  (§4.1) et comparé au nouveau sur **2 488 320 cas / 22 394 880 comparaisons** — 24 baies × 96 étagères
  × 1 080 équipements posés : **identiques BIT POUR BIT**. Un second balayage, sur des valeurs
  délibérément non représentables en binaire, isole la seule différence possible : les bornes **hautes**
  `x1`/`y1` diffèrent d'au plus **1,14·10⁻¹³ mm** (l'ancien code faisait `x1 = x0 + largeur`, le
  conteneur transporte la borne elle-même — ré-association d'une somme flottante, 7 ordres de grandeur
  sous le micron exigé par §6.10). `x0`, `y0`, `z0`, `z1` et l'empreinte sont bit pour bit partout.
- **Une conséquence heureuse, vérifiée et non exploitée** : `trayEquipBoxLocal` rendait deux champs
  `tx`/`ty` (coordonnées plateau) que PLUS AUCUN appelant ne lisait. Ils disparaissent avec le transport
  manuel — le conteneur rend un rectangle, pas un fourre-tout.

**Reste ouvert, signalé ici** : un équipement posé dont l'orientation propre est 90° ou 270° voit son
EMPREINTE permutée par `TrayGeometry.footprint` (le dessin est donc juste), mais ses PORTS continuent de
sortir par les faces ±Y de sa boîte, comme s'il n'avait pas tourné. À vérifier et arbitrer à part : c'est
un défaut de RÉSOLUTION potentiel, pas une conséquence de ce lot, et le corriger déplacerait des
connecteurs.

> **Mise à jour — VÉRIFIÉ, plus large qu'annoncé, et CORRIGÉ en §6.24.** La sonde montre que les QUATRE
> orientations rendaient la même normale : le défaut ne touchait pas que 90°/270°, mais aussi **180°** —
> le cas le plus net, puisque la boîte y est identique et que seule la façade s'inverse. Ce paragraphe
> disait « à vérifier » à juste titre : l'énoncé déduit du code était incomplet.

### 6.24 Le LACET PROPRE d'un posé atteint ses ports, et l'étagère arrière TOURNE — **IMPLÉMENTÉ**

Suite immédiate de §6.23, et démonstration de ce que la doctrine attend d'un signalement : les deux
points laissés ouverts n'en formaient qu'UN, et l'un ne pouvait pas se corriger sans que l'autre soit
tranché.

**Le défaut, MESURÉ et non déduit.** Une sonde compare la résolution d'un port sur un posé aux quatre
orientations, en mode `tray` puis en mode LIBRE, boîtier identique : le mode libre rend **quatre**
normales distinctes, le mode `tray` rend **(0, −1) pour les quatre**. La branche `tray` interpolait sur
les seules faces ±Y de la boîte et ne lisait jamais `dc_orientation`. L'énoncé initial de §6.23 (« les
90°/270° ») était donc incomplet : **180° était touché aussi**, et le plus visiblement — empreinte
inchangée, façade inversée, port immobile.

**Pourquoi les deux points n'en font qu'un.** Corriger le défaut demande de faire remonter le lacet du
posé jusqu'à `PlacementFrame`. Or une RÉFLEXION — ce que faisait l'étagère arrière — ne se compose pas
avec des lacets : le « lacet effectif » d'un contenu dans sa baie n'aurait pas été une addition. Sous
réflexion, un boîtier tourné à 90° aurait regardé la **même direction absolue** sur une étagère avant et
sur une arrière, ce qui contredit l'idée même qu'une étagère arrière retourne ses contenus.

**Décision (utilisateur) : ROTATION de 180°.** Les deux axes se retournent. `tray_x` se compte depuis la
gauche de QUI REGARDE l'étagère — la gauche de la baie pour une avant, sa droite pour une arrière. Dès
lors tout se compose : `TrayFrame.contentYawDeg` ADDITIONNE le lacet du posé et le demi-tour éventuel de
son étagère, et `PlacementFrame` fait le reste. Le résolveur ne calcule plus aucun signe à la main.

**Conséquences, toutes vérifiées :**

- Les posés produisent leur point et leur normale LOCAUX via **le même `FreeEquipGeometry`** que les
  équipements libres — un posé sur plateau n'est rien d'autre qu'un boîtier libre juché plus haut. Ce qui
  reste propre à l'étagère est la BASE Z (le dessus du plateau, et non `dc_z`).
- **Effet de bord voulu** : les faces HORIZONTALES (dessus / dessous) d'un posé deviennent résolvables,
  comme elles l'étaient déjà en mode libre. L'ancienne branche ne savait produire que des faces ±Y.
- **Rayon d'action mesuré AVANT de toucher au code** : les deux corpus (réel et démonstration) portent
  **1 étagère, avant, vide** — zéro posé, zéro posé tourné, zéro étagère arrière. Aucune donnée existante
  ne bouge. C'était le moment le moins cher possible pour trancher, et c'est ce qui a permis de le faire
  sans migration.
- Aucun test existant ne rougit : la seule section à réécrire est celle du lot précédent. Autrement dit
  le comportement des étagères ARRIÈRE n'était couvert par **aucun** test — ce que le lot précédent
  n'avait pas dit, et qu'il aurait dû.

**Le DESSIN suit, et par RÉUTILISATION plutôt que par correction.** L'ancien rendu des posés dessinait
l'ENVELOPPE alignée sur les axes et plaquait l'image de façade sur ses seules faces ±Y, sans consulter
`dc_orientation` — la boîte et les connecteurs auraient donc divergé dès que la résolution s'est mise à
suivre le lacet. Plutôt que de rattraper ce rendu parallèle, il est SUPPRIMÉ : un posé passe désormais
par le MÊME `buildEquipBox` que les équipements libres d'une salle et que ceux d'un étage — un posé
n'est rien d'autre qu'un boîtier libre juché sur un plateau, ce que la résolution affirmait déjà en
réutilisant `FreeEquipGeometry`. C'est le troisième conteneur servi par ce rendu, et le principe n°3
appliqué au bout : le lot ne corrige pas deux chemins, il en retire un.

- La boîte est TOURNÉE du lacet EFFECTIF (`trayContentPlacementInRack`), le même que celui de la résolution.
- Ses UV de face dérivent de `FreeEquipGeometry.faceFraction`, la source de vérité qui place aussi les
  ports : image et connecteurs coïncident **par construction**, sur les SIX faces et non plus deux.
- `buildEquipBox` gagne trois options — `yawDeg` (lacet effectif), `elevation` (un posé REPOSE sur son
  plateau, `dc_z` ne s'y applique pas) et `extra` (le `eqSide` de masquage). Le côté de masquage reste
  celui de l'ÉTAGÈRE : « masquer l'avant » parle de la face de baie qu'on regarde, pas de l'orientation
  d'un boîtier.

⚠ **Deux comportements VISIBLES changent** — conséquence de l'alignement sur le rendu des équipements
libres, pas d'un choix propre à l'étagère : le nom d'un posé n'est plus écrit sur les DEUX faces ±Y mais
sur sa PROPRE façade ; et son image de façade n'obéit plus à la bascule « images de façade », qui n'a
jamais agi sur les équipements libres (l'image y est un MATÉRIAU de la boîte, pas un plan taggé). À
juger à l'œil.

**Ce que le verrou de cohérence couvre, exactement** : un test compare la boîte que le rendu DESSINE
(cotes propres + lacet effectif) à celle que `trayEquipBoxLocal` RAPPORTE, sur les 8 combinaisons. Sondé,
il MORD sur 4 cas si le lacet est ignoré (les 90°/270°) — mais il est **AVEUGLE au demi-tour**, une
rotation de 180° laissant une enveloppe alignée inchangée. Le demi-tour est couvert par les NORMALES de
la section de résolution (avant et arrière exactement opposées). Les deux ensemble couvrent les quatre
orientations ; croire que l'un suffit serait la fausse sécurité que §6.19 nomme.

### 6.25 Les montages MARGE et PAROI rejoignent le rendu commun des boîtiers — **IMPLÉMENTÉ**

Constat fait en répondant à une question de l'utilisateur — « est-ce la même primitive qui dessine tous
les équipements ? » — et non en cherchant un défaut : **non**, et l'inventaire est instructif. Sur les six
modes de placement, `buildEquipBox` en servait trois (libre en salle, étage, posé sur étagère depuis
§6.24) ; le mode `rack` a son chemin propre ; `side` et `wall` étaient dessinés par un `localBox` de trois
lignes. Or il n'existe, dans TOUTE la scène 3D, que deux appels à `faceLabel` et deux à `faceImageUrl` —
aucun ne venait de ces deux modes. **Un équipement monté en marge ou en paroi n'avait donc ni nom, ni
image de façade, ni repère d'orientation**, alors que ses PORTS étaient bel et bien résolus : des
connecteurs flottant sur un volume gris anonyme. Personne ne l'avait signalé parce que rien ne le disait :
il fallait comparer les modes entre eux.

**Le mode `rack` reste à part, et c'est délibéré.** Un équipement monté en U s'inscrit entre les rails,
son Z vient de la grille de U, son image de façade doit être ROGNÉE à la largeur du corps (les oreilles
19″ n'en font pas partie) et il n'a pas de lacet libre — il est avant ou arrière. Le faire entrer dans la
même primitive produirait la fonction à drapeaux que le principe n°2 proscrit.

**Décompte, à ne pas confondre avec le nombre de points d'appel.** `EQUIPMENT_PLACEMENT_MODES` en compte
SIX (`manual`, `rack`, `side`, `wall`, `floor`, `tray`). Après ce lot, `buildEquipBox` en sert **CINQ** —
tous sauf `rack` — depuis QUATRE points d'appel seulement, `side` et `wall` partageant le leur. Compter
les appels au lieu des modes fait dire « quatre sur six », ce qui est faux d'une unité et suggère qu'il
resterait du travail au-delà de `rack` : il n'en reste aucun. Ce qui échappe à la primitive commune n'est
pas un reliquat, c'est le SEUL mode qui ne soit pas un « boîtier posé par position + lacet ».

**L'obstacle réel, et pourquoi ce n'était pas un simple branchement.** `sideEquipBoxLocal` et
`wallEquipBoxLocal` **BORNENT** les cotes déclarées — largeur ramenée à la colonne, longueur à la cage
moins 8 mm, hauteur plancher à 1 U — tandis que `buildEquipBox` lisait les cotes BRUTES de
l'enregistrement. Un branchement direct aurait redimensionné les équipements, et surtout **détaché la
coque de ses ports**, qui sont résolus sur la boîte BORNÉE. D'où deux ajustements :

- `buildEquipBox` accepte désormais une **boîte fournie** (`box`), et les UV de face en dérivent via
  `FreeEquipGeometry.faceFractionIn` — extrait de `faceFraction`, parce que ces fractions sont une
  propriété de la BOÎTE et jamais de l'enregistrement. Les plaquer sur les cotes déclarées ferait glisser
  l'image hors de la coque.
- `RackGeometry.mountedContentPlacementInRack` **DÉRIVE** centre, lacet et cotes de l'enveloppe existante,
  au lieu de re-calculer les bornes — les dupliquer aurait recréé la divergence que ce lot supprime.

**Le lacet est la seule inconnue, donc le seul vrai test.** Il doit amener la façade du boîtier (−Y local)
sur la normale sortante de son montage : ±Y pour `side`, ±X ou ±Y pour `wall` selon qu'il est posé « en
travers » de sa paroi ou dans son plan. Un test CROISE donc deux chemins indépendants sur les **32
configurations** (16 marge × 16 paroi) : le lacet déduit par le rendu, et la normale rendue par
`Resolver3D`. Les quatre lacets 0°/90°/180°/270° sont exercés — sans quoi le test comparerait un cas
unique à lui-même. **Les deux vérifications MORDENT**, mesuré et non supposé : lacet forcé à 0 → 20 échecs
sur 32 ; cotes non permutées à 90°/270° → 8 sur 32.

⚠ **Ce qui devient VISIBLE, et n'existait pas avant** : nom, image de façade sur les six faces et repère
d'orientation (arêtes de la face avant) sur les équipements en marge et en paroi. Aucune donnée n'est
concernée aujourd'hui — les deux corpus en comptent **zéro** — mais c'est un ajout d'affichage franc,
**à juger à l'œil** dès qu'un tel montage existera.

### 6.26 Les noms qui MENTAIENT sont corrigés — les autres sont gardés — **IMPLÉMENTÉ**

Deux dettes de nommage traînaient depuis §6.22, sous la même formule : « ne trompe à aucun point d'appel
AUJOURD'HUI ». C'est le raisonnement qu'on refait à chaque fois qu'un nom faux survit — il décrit un
mensonge sans conséquence, pas un nom juste, et il perd sa validité au premier appelant qui change.

**Renommés, parce qu'ils désignaient une DESTINATION qui n'est pas la leur :**

| Avant | Après | Pourquoi c'était faux |
|---|---|---|
| `PlacementFrame.pointToRoom` | `composePoint` | Le module rend dans le repère de l'ORIGINE reçue — parfois MONDE (résolveur d'étage, §6.20). « Room » nommait une destination que l'appelant choisit. |
| `PlacementFrame.dirToRoom` | `composeDir` | Idem. |
| `RackGeometry.trayPlacement` | `trayPlacementInRack` | Se lisait « placement DE l'étagère » ou « placement DANS l'étagère » — deux lectures opposées, et c'est la première qui est juste, exprimée dans le repère de la BAIE. |
| `RackGeometry.trayContentPlacement` | `trayContentPlacementInRack` | Même ambiguïté ; le repère de sortie est celui de la baie, pas du plateau. |
| `RackGeometry.mountedContentPlacement` | `mountedContentPlacementInRack` | Idem. |

Les trois derniers dataient de §6.23–§6.25, c'est-à-dire de la veille : une dette de nommage se contracte
vite, et la corriger tant qu'elle n'a que huit points d'appel coûte le dixième de ce qu'elle coûtera plus
tard.

**GARDÉS, et pas par prudence** : `RackGeometry.roomPlacement` et `FreeEquipGeometry.roomPlacement`. Une
baie EST placée dans une salle, un équipement libre AUSSI — ces noms sont exacts. §6.22 annonçait que les
renommer serait « un SECOND arbitrage à trancher du même geste » ; vérification faite, il n'y avait rien à
trancher. Le périmètre d'un lot de renommage est **ce qui est faux**, pas ce qui est ancien.

`toParent()` reste explicitement proscrit (§6.6) — c'est d'ailleurs pourquoi `composePoint` ne s'appelle
pas `pointToParent` : le mot inviterait précisément l'abstraction que la borne interdit.

### 6.27 « Localiser » atteint les contenus d'ÉTAGE — **IMPLÉMENTÉ**

Premier lot du chantier « câbler les équipements d'étage » (§6.4) à toucher l'expérience. Il est PRÉALABLE
à la migration des appelants de `Store.equipmentDcId` vers la clé CONTENEUR : cinq de ces appelants
commandent l'affichage du bouton « Localiser », et `DcInteract` n'avait aucun chemin pour un posé d'étage —
les migrer d'abord aurait ouvert un **bouton mort**. On rend donc l'action possible AVANT d'ouvrir son bouton.

**Deux repères, deux points d'entrée — et c'est irréductible.** `focus3DAt` force `multiDc = false` et reçoit
un point en LOCAL SALLE (« repère salle = monde en mode simple DC »). Un contenu d'étage n'a pas de salle : sa
position n'existe QUE dans le repère bâtiment. Aucune valeur de paramètre ne rendrait `focus3DAt` applicable —
d'où `focusWorld3DAt`, qui bascule en **Vue étage** et prend du MONDE. Le repère est dans le nom (§3 règle 5),
exactement comme `resolvePortWorld3D` en §6.20.

**Décisions prises À L'IMPLÉMENTATION** — avec les alternatives écartées et leur motif :

- **`FloorLayout.equipFloorOrigin` devient la SOURCE UNIQUE de l'origine d'un posé d'étage** (`x`, `y`,
  `baseZ`), et `equipFloorWorld` n'en est plus qu'un consommateur (`baseZ + dc_z`). La vue 3D recomposait
  cette origine à la main — position par `equipFloorWorld`, socle par un second appel à `levelZ` — et le
  cadrage caméra aurait été le TROISIÈME site à répondre à la question du `dc_z`. Écarté : recopier le
  motif dans `DcInteract` ; il suffit d'y répondre une fois de travers pour que la caméra vise 250 mm
  au-dessus de ce que la scène dessine, et rien ne le signalerait.
- **La PORTÉE est amenée à la cible, sinon on cadre le vide.** `multiLayout` n'émet les plans d'étage que des
  bâtiments dont une salle est AFFICHÉE : localiser un posé d'un AUTRE bâtiment que la salle active cadrait
  donc parfaitement un point où la scène ne dessine rien. « Localiser » AJOUTE les salles du bâtiment visé à
  `visibleDcIds` (il ne remplace pas la portée — les autres salles affichées sont un choix de l'utilisateur,
  comme les masquages que `locateRack` respecte déjà). ⚠ Le REPÈRE, lui, ne bouge pas : l'origine calculée est
  **identique avant et après** l'élargissement (§6.8, verrouillé par test).
- **La salle ACTIVE n'est pas déplacée.** Écarté : poser `dcId` sur une salle du bâtiment visé, ce qui aurait
  emporté le panneau latéral et les vues 2D sans que rien ne l'ait demandé. La Vue étage montre un BÂTIMENT ;
  la portée suffit à l'y faire entrer.
- **`equipCenter` ne reçoit PAS de branche `floor`, et c'est un choix.** Elle répond « où est cet équipement
  DANS la salle `dcId` » — question sans réponse pour un posé d'étage. Il en ressort `null` par la branche
  « libre » (pas de `dc_id`), ce qui est le verdict JUSTE et non le piège d'ordre qui avait frappé `tray`
  puis `side`/`wall` (§6.13). Écarté : y ajouter une branche « pour la cohérence » — il aurait fallu inventer
  un repère salle à un objet qui n'en a pas.
- **La SURBRILLANCE ambre a dû suivre.** `DcThreeCamera.setFocusEquip` ne parcourait que `gRacks` et `gFree` ;
  les posés d'étage vivent dans `gFloorDecor`. Ils y sont pourtant construits par le MÊME `buildEquipBox`
  (donc même `pick.type === "occ"`) et leurs ports par le MÊME `addPortAt` (donc même `pick.type === "port"`) :
  il suffisait d'ajouter le troisième groupe à la traversée. Sans cela, « Localiser » cadrait la caméra sans
  rien allumer.
- **Deux traversées JUMELLES ont été mesurées puis LAISSÉES EN PLACE**, parce qu'elles ne relèvent pas de ce
  lot : `DcThreeCamera.applyHover` (survol) — sans effet observable, le seul mesh d'une boîte d'équipement à
  porter un `pick` étant celui que le raycast a déjà touché ; et `DcThreeScene.applyColorMode`, qui recolore
  EN PLACE lors d'un changement de mode de couleur et **saute donc les posés d'étage** jusqu'au prochain
  rebuild complet. Ce second point est un vrai défaut, étranger à « Localiser » — signalé, non corrigé (§3 :
  on ne « rationalise » pas hors périmètre).

**LIMITE ASSUMÉE, et son diagnostic exact** : un bâtiment SANS AUCUNE SALLE reste inaffichable en 3D. La
portée s'exprime en SALLES (`visibleDcIds`) : un tel bâtiment n'a aucun moyen d'y entrer, donc son plan
d'étage n'est jamais émis et son contenu n'est jamais dessiné. « Localiser » le DIT (toast) au lieu de viser
le vide. ⚠ Le diagnostic naturel — « `DcBase.webglCtx` teste `m.rooms.length`, donc la scène entière
disparaît » — est **faux, mesuré** : `multiLayout` place TOUJOURS la salle active dans `rooms`, et `render()`
sort avant sur « aucune salle » ; ce garde-là est inatteignable, et le corriger n'aurait rien débloqué. Le
seul verrou réel est le filtre `shownFloors`. Le lever demande une portée exprimée en BÂTIMENTS (option de
`multiLayout`, réglage de vue persisté, et un contrôle pour en sortir) : **lot à part, non fait**.

**Sondes de mutation** : branche d'étage neutralisée dans `locateEquipment` → la section entière tombe
(38 assertions perdues, l'ancien chemin partant sur le toast « non placé dans une salle ») ; `dc_z` compté
DEUX fois dans `equipFloorOrigin` → **8 FAIL**, répartis sur les quatre couches (descripteur poussé au
moteur, chaîne port, origine pure, cible caméra) ; portée NON élargie → **4 FAIL** dont « le posé n'est pas
dessiné » alors que la caméra le vise ; garde du bâtiment sans salle retirée → **3 FAIL**.

**Non couvert par les tests, à juger À L'ŒIL** : la surbrillance ambre elle-même et le confort du cadrage
(`DcThreeCamera` importe THREE, hors de portée du harnais), et le toast de refus (il exige un DOM).

### 6.28 Le PRÉDICAT des boutons « Localiser » est écrit UNE fois — **IMPLÉMENTÉ**

§6.27 a rendu l'ACTION possible pour un contenu d'étage ; ce lot ouvre le BOUTON qui la déclenche. L'ordre
n'est pas un confort de découpage, c'est la décision **D6** du chantier : ouvrir le bouton d'abord aurait
livré un **bouton mort**.

**Le défaut de fond n'était pas le mot « salle », c'était la DUPLICATION.** Sept sites écrivaient la même
question sous la forme `!!store.equipmentDcId(x)` — listings (`app/main.ts`), fiche équipement, tableau des
ports, fiche faisceau, contenu d'une baie, panneau de recherche 3D, « Localiser une VM ». Sept copies d'une
règle qui ne demandait qu'à diverger, et qui ont divergé : l'action a appris l'étage en §6.27, les sept
gardes ne l'ont pas su. La règle vit désormais **une seule fois**, dans `src-client/core/Locatable` (classe
PURE, store injecté par interface étroite — patron `PowerAnalysis`/`VmLocate`), exposée par
`Store.equipmentLocatable` / `portLocatable`.

**⚠ LE PRÉDICAT N'EST PAS `!!equipmentContainer(x)`, et c'est le cœur du lot.** Avoir un conteneur ne rend
pas atteignable. Deux contre-exemples **mesurés**, tous deux porteurs d'une chaîne parfaitement valide :

- une **baie HORS SALLE** produit un conteneur `kind: "rack"` dont la chaîne ne traverse aucune salle ;
- un **posé d'ÉTAGE d'un bâtiment SANS AUCUNE SALLE** produit un conteneur `kind: "floor"` que la PORTÉE
  d'affichage — exprimée en salles (`visibleDcIds`) — ne peut pas faire entrer dans la scène (limite §6.27).

D'où la règle en deux branches : *la chaîne traverse une salle* **OU** *le conteneur immédiat est un étage
dont le bâtiment a au moins une salle*. La seconde condition interroge `Store.roomsOfBuilding`, **la même
requête** que `DcInteract.scopeFloorBuilding` emploie pour élargir la portée — pas deux filtres jumeaux, sinon
ils divergeraient, c'est-à-dire rouvriraient le bouton mort qu'ils ferment. Le jour où la portée s'exprimera
en bâtiments, les deux cesseront de refuser **ensemble**, par construction.

**Le verrou : un test d'ÉQUIVALENCE, pas deux attentes parallèles.** Douze cas — un par mode de placement,
plus pool / baie hors salle / inventaire pur / les deux faces de la branche étage — mesurent le prédicat
**et** l'action (« `locateEquipment` programme-t-il une cible caméra ? »), puis comparent **les deux mesures
entre elles**. ⚠ La nuance est le test lui-même : épinglés chacun à une constante écrite à la main, les deux
côtés se surveillent déjà, mais une dérive **simultanée** (on « corrige » l'attente en même temps que le code)
passerait au vert. C'est la propriété que `Locatable` revendique — « miroir des refus » — donc c'est elle
qu'on écrit. Sonde de mutation : garde d'étage neutralisée → **5 FAIL** sur quatre couches (règle nue, prédicat
du store, `VmLocate`, et l'équivalence elle-même) ; avec l'assertion contre constante seule, la même mutation
n'en donnait que 4 — l'équivalence restait muette.

**⚠ LES CÂBLES RESTENT SUR LA CLÉ « SALLE », DÉLIBÉRÉMENT** (trois sites : `app/main.ts`, `DetailForms`,
panneau de recherche). Ce n'est pas un oubli : `DcInteract.locateCable` cadre par `resolvePort3D`, **scopé par
salle**, et n'a aucune branche pour un conteneur d'étage. Migrer ces gardes afficherait le bouton d'un câble
dont les deux extrémités sont des posés d'étage, et le clic ne rendrait qu'un toast — exactement le bouton
mort que D6 interdit. **Un prédicat ne se migre qu'avec son action** : celui-là suivra le lot `worldLine`.

**CHANGEMENTS DE COMPORTEMENT, tous voulus** : le bouton « Localiser » apparaît désormais pour un équipement
posé sur un étage (fiche, listing, tableau de ports, recherche 3D) et pour **une VM hébergée par un tel
équipement** ; l'en-tête de `VmLocate` affirmait le contraire « PAR CONCEPTION » — il est corrigé, et le test
qui figeait `false` pour ce cas attend maintenant `true`. Zéro effet sur les corpus (aucun `floor`).

**ÉCART CONNU, NOMMÉ ET VERROUILLÉ — pas refermé** : un équipement libre rattaché à une salle mais SANS
`dc_x`/`dc_y` est jugé localisable (l'action replie sur la demi-empreinte, §6.13), alors que `Resolver3D`
refuse de résoudre ses PORTS et que la scène ne le dessine pas — le bouton « Localiser » d'un tel PORT n'ouvre
donc qu'un toast. C'est **antérieur** au lot (`portDcId` se comportait à l'identique) et sans occurrence dans
les deux corpus ; on le verrouille par un test pour qu'il soit constaté et non redécouvert. Le refermer
demande de trancher où l'on dessine un libre non positionné — hors périmètre.

## 7. État de la convergence

| Mode | Conteneur hôte | Repère résolu | Ports | État |
|---|---|---|---|---|
| *(site)* | monde | **monde** | s.o. | **migré** — position déclarée (GPS) ou repli 5 km (§6.9) ; TAILLE déclarée optionnelle faisant emprise et contraignant ses plans d'étage (§6.8) |
| `rack` | baie → salle | local salle | oui | **migré** — la SALLE place la baie, la baie place son contenu (`PlacementFrame`, §6.11 puis §6.12) |
| `side` / `wall` | baie → salle | local salle | oui | **migré** — même conteneur que `rack` (§6.11) ; RENDU rejoint la primitive commune des boîtiers (§6.25), avec nom, image de façade et repère d'orientation qu'ils n'avaient pas |
| `tray` | étagère → baie → salle | local salle | oui | **migré de bout en bout** — l'ÉTAGÈRE place ses contenus (`TrayFrame`, §6.23), la baie place l'étagère, la salle place la baie (`PlacementFrame`, §6.11). Géométrie de plateau DÉDUPLIQUÉE (`src-shared/TrayGeometry`, §6.7) et profondeur de cage aussi (`src-shared/RackDepthPolicy`, §6.14). **Seule chaîne à TROIS conteneurs emboîtés** ; le lacet PROPRE d'un posé s'y compose enfin (§6.24) et une étagère arrière est une vraie ROTATION |
| `manual` (libre) | salle | local salle | oui | **migré** — la SALLE place directement l'équipement, MÊME conteneur que les baies (`PlacementFrame`, §6.12) ; l'origine d'un contenu non positionné est CORRIGÉE |
| *(waypoints)* | baie → salle | local salle | s.o. | **migré** — brosses et pins passent par le conteneur (§6.12) ; le champ `world` est renommé `roomPoint` |
| `floor` | plan d'étage → étage → bâtiment | **monde** | oui | **migré** — `Resolver3D.resolvePortWorld3D` compose depuis l'origine MONDE que le layout fournit au conteneur (§6.20) ; la composition elle-même est celle de `PlacementFrame`. **LOCALISABLE** depuis §6.27 (équipement et ports), via `focusWorld3DAt` + `FloorLayout.equipFloorOrigin` |

Les équipements d'étage sont le premier contenu porté par un conteneur AUTRE qu'une salle. Ils sont
donc le banc d'essai de cette doctrine — d'où le choix de commencer par eux.

⚠ **Leurs ports sont RÉSOLUS, DESSINÉS et LOCALISABLES ; ils ne sont toujours pas CÂBLABLES** (§6.20 puis
§6.27). `Store.equipmentDcId` rend `null` pour un équipement d'étage par conception, et la machinerie de
câblage ne connaît que « dans la salle X » ou « non placé ». Généraliser cette clé de « salle » à
« conteneur » est le chantier décrit en §6.4 ; il est OUVERT — `Store.equipmentContainer`/`portContainer`/
`cableContainer` existent, et §6.27 a débloqué le seul prérequis d'expérience (un « Localiser » opérant).

✅ **L'ordre de migration §6.10 est ÉPUISÉ : tous les modes de placement passent par un conteneur**, et la
règle de repli d'une position absente n'est plus écrite qu'une fois (§6.13). Les deux **prérequis** de §6.5
qui restaient dus sont tenus : la cascade est RÉCURSIVE et le chaînage porte un garde anti-cycle (§6.16).

✅ **La CHAÎNE est désormais complète sous la salle** (§6.23) : étagère → baie → salle, chaque maillon
plaçant ses propres contenus. C'était le dernier endroit où un conteneur déclaré dans
`src-shared/PlacementContainers` n'avait pas de géométrie en face. Ce qui reste de §6.10 n'est plus une
étape de migration mais une dette annexe : les constantes GÉNÉRALES de baie répliquées dans
`TrayGeometry`/`RackDepthPolicy` (unifier = migrer `domain/constants.ts` vers `src-shared/`, très au-delà
du besoin — verrouillé par des tests anti-divergence).

## 8. Références

- `src-shared/Cascade.ts` — **CASCADE DE SUPPRESSION** partagée front ⇄ back (§6.16, §6.17). `planMany()`
  est le moteur : MULTI-RACINES (un LOT de suppressions = UN plan) et RÉCURSIF jusqu'au point fixe, avec
  garde anti-cycle + déduplication (ensemble des couples (collection, id) traités, **toutes les cibles**
  incluses), écart des détachements visant une entité SUPPRIMÉE, et réduction à un détachement par
  (collection, id, clé). `plan(collection, id, …)` en est l'enveloppe à une racine. ⚠ Un détachement qui
  retire un élément d'une LISTE doit se composer sur la valeur déjà planifiée (`pendingValue`), sinon on
  n'en retire qu'UN seul — vrai sous récursion (une baie et ses N brosses) comme au sein d'un LOT (deux
  waypoints, deux groupes ou deux réseaux supprimés ensemble). Les trois règles concernées le font :
  `pruneWaypointsFromRoutes`, `detachGroupFromMembers`, hook `networks`.
- `src-server/src/ApiRules.ts` — `residualCascade` : cascade RÉSIDUELLE d'un `/transact`, calculée en UN
  SEUL `planMany` sur toutes les suppressions du lot, puis retranchée de ce que le lot contient déjà
  (§6.17). Le filtre final reste indispensable pour les suppressions RÉSIDUELLES, que le plan ne peut pas
  connaître comme « déjà dans le lot ».
- `src-shared/TrayGeometry.ts` — géométrie de l'ÉTAGÈRE, SOURCE UNIQUE (plateau utile, empreinte, position,
  chevauchement, verdict de tenue) : consommée par le RENDU (`RackGeometry.tray*` délègue) et par la
  VALIDATION (T2d/V6e), qui la reçoit en collaborateur INJECTÉ (`ValidationCollaborators`) — par choix de
  découplage, plus par impossibilité d'import (§6.14).
- `src-shared/RackDepthPolicy.ts` — POLITIQUE DE PROFONDEUR de baie, SOURCE UNIQUE (§6.14) : `outerDepth`,
  `cage` (BORNÉE au châssis), `door`/`doorExtra`/`hasDoor`, `frontMargin`, `rearMargin`. Consommée par le
  RENDU (`RackGeometry` délègue) et par la VALIDATION (T2c/V6d), qui l'IMPORTE directement (`./…​.js`).
  N'y figure PAS la marge de sécurité derrière une porte : règle de prudence propre à la validation.
- `src-client/geometry/SiteLayout.ts` — position des SITES : `realPositions` (modèle → mètres réels),
  `compress` (mètres réels → millimètres monde, échelle linéaire/log), `worldPositions`.
- `src-client/geometry/FloorLayout.ts` — `multiLayout` (chaîne bâtiment/étage/salle), `roomToWorld`,
  `equipFloorOrigin` (**source unique** de l'origine monde d'un posé d'étage : `x`/`y` sur le plan et
  `baseZ` = SOCLE du niveau, **sans `dc_z`**), `equipFloorWorld` (= cette origine + `dc_z`, seule addition
  du chemin), `oobWorld`, `levelZ`.
- `src-client/geometry/PivotBounds.ts` — **BORNAGE DU PIVOT D'ORBITE** (§6.21), pur : `rectCorners`/`unionAabb`
  (repère SALLE, boîte **XY seule** — bornes en Z absentes = parois infinies), `worldBounds` (repère BÂTIMENT,
  boîte **3D** = bandes de bâtiment dessinées × hauteur du monde) et `clampPivot` (méthode du slab sur les TROIS
  axes). Ne borne QUE le repli « plan de sol infini » : le contenu réellement touché par le raycast reste
  prioritaire. La boîte est CHOISIE par `DcThreeScene.recomputePivotAabb`, sur la PRÉSENCE d'un décor d'étage.
- `src-client/geometry/CameraFraming.ts` — **RÈGLE DE CADRAGE** de « Localiser » (§6.15), pure : `FILL_RATIO` (90 %
  de la vue), `MIN_FRAMED_EXTENT_MM` (limite de zoom = une largeur de baie), `FOCUS_ELEVATION_RAD` (plongée par
  défaut), `objectExtent` (plus grande cote) et `halfExtentFor` (demi-étendue monde à cadrer, aspect compris).
- `src-client/geometry/PlacementFrame.ts` — **REPÈRE D'UN CONTENU PLACÉ** (`RackFrame` en §6.11,
  `RoomFrame` en §6.12, nom actuel depuis §6.22) : `basis` (lacet + origine, dérivés du seul placement
  DÉCLARÉ, position absente ⇒ demi-empreinte), `origin` (le CENTRE d'un contenu en local salle — source
  unique du repli, §6.13), `composePoint` (rotation PUIS translation), `composeDir` (rotation SEULE,
  composante verticale recopiée), `place` (les deux, ce que consomment les CINQ modes de salle ET le
  résolveur d'étage). `ContentPlacement` = l'interface étroite, faite des SEULS champs du contenu.
  ⚠ Il compose dans le repère de l'ORIGINE qu'on lui donne : local salle pour ses appelants de salle,
  MONDE pour le résolveur d'étage (§6.20). La transformée du conteneur étage n'est PAS ici — elle lui est
  fournie. ⚠ **BORNE §6.6** : il ne connaît ni étage, ni bâtiment, ni site, ni layout — le NOM ne le dit
  plus, un VERROU de `Tests/modules/test-geometry.js` le tient (§6.22).
- `src-client/geometry/Resolver3D.ts` — `resolveFaceAnchor3D` : les cinq modes délèguent leur composition à
  `PlacementFrame` (quatre via leur baie, le mode libre directement), ainsi que la géométrie des waypoints.
  Sortie en **LOCAL SALLE** pour tout ce qui est résolu DANS une salle — points, normales et offsets de
  conduit. `Port3D`. ⚠ **Une exception, annoncée par son nom** : `resolvePortWorld3D(portId, worldOriginX,
  worldOriginY, worldOriginZ)` résout un contenu placé sur un conteneur SANS salle (équipement d'étage) et
  rend du **MONDE** (§6.20). `worldOriginZ` = le SOCLE du conteneur seul ; la hauteur propre (`dc_z`) est
  ajoutée par le résolveur, jamais par l'appelant.
- `src-client/geometry/FreeEquipGeometry.ts` — géométrie PROPRE de l'équipement libre : `faceLocal`,
  `portLocal` (point local d'un port), `faceNormalLocal` (normale AVANT lacet) et `roomPlacement` (ce
  qu'il déclare à son conteneur). Il ne compose plus aucune transformée.
- `src-client/geometry/RackGeometry.ts` — `roomPlacement` : ce que la BAIE déclare à son conteneur.
- `src-client/views/dc/DcBase.ts` — repère (`multiDc`) vs portée (`visibleDcIds`), décor d'étage.
  `webglFloorDecor` produit `FloorEquipDesc { id, x, y, baseZ }` : `baseZ` = **socle du niveau seul**, sans
  `dc_z` — c'est ce contrat qui interdit le double comptage côté moteur (§6.20). Il produit aussi
  `FloorDecor.world`, les **BORNES MONDE** (bandes de bâtiment DESSINÉES × hauteur du monde) que le moteur
  utilise pour borner le pivot d'orbite (§6.21) — un champ qui ne dessine rien, donc à ne pas oublier dans
  `SceneLayoutSignature`.
- `src-client/views/dc/DcInteract.ts` — « Localiser ». DEUX points d'entrée, un par REPÈRE (§6.27) :
  `focus3DAt` (local SALLE, force le mode simple DC) et `focusWorld3DAt` (**MONDE**, bascule en Vue étage,
  pour les contenus sans salle). `locateFloorEquip`/`locateFloorPort` précèdent le chemin salle et se
  désistent (`false`) pour tout autre conteneur ; `scopeFloorBuilding` amène le bâtiment visé dans la
  PORTÉE, sans quoi la caméra cadrerait un point que la scène ne dessine pas.
- `src-client/views/dc/three/DcThreeScene.ts` — `addPort` (résolution EN SALLE puis dessin) et `addPortAt`
  (dessin SEUL, à un point déjà résolu) : la RÉSOLUTION dépend du conteneur, le DESSIN non. Les ports
  d'étage passent par `resolvePortWorld3D` puis par le MÊME `addPortAt` — d'où leur comportement identique
  vis-à-vis de `showPorts` et du masquage individuel (§6.20).
- `docs/persistance.md` — direction relationnelle (cf. §5).
- `docs/faisceaux.md`, `docs/deduction-reseau.md` — consommateurs de la résolution de ports.
