# Breakout — un port trunk éclaté en N lanes

Un **breakout** est un port physique (le **trunk**, ex. une cage QSFP+ 40G) que l'équipement fait
travailler comme **N ports logiques** (les **lanes**, ex. 4 × SFP+ 10G). Le trunk ne porte pas de câble ;
ce sont ses lanes qui en portent, une chacune. Ce document décrit le modèle, les règles, l'interface et
le contrat que le breakout signe avec la future **terminaison** (transceivers). La règle de validation
associée (« lane et trunk au même équipement ») est celle de [`validation.md`](validation.md) (T2).

## Le modèle

Le breakout est **une propriété du port**, sans entité dédiée :

| Champ (`ports`) | Rôle |
|---|---|
| `parent_port_id` | FK → `ports` : le trunk dont ce port est une lane. `null` = port ordinaire **ou** trunk. |
| `lane` | Numéro de la lane (1..N). `null` hors lane. |

- Un port est un **trunk** dès qu'au moins un port le désigne comme parent (`Store.isBreakoutParent`) ; ses
  lanes se lisent par `Store.breakoutLanes(trunkId)` (triées par `lane`). Aucun drapeau stocké : le trunk
  qui perd toutes ses lanes **redevient un port ordinaire** par le seul fait de n'en plus avoir.
- **Une lane porte son PROPRE `port_type_id`** — celui de la sortie (SFP+), pas celui du trunk (QSFP+).
  C'est ce que lit `Store.portFamily` pour la compatibilité de câble : un câble « Breakout QSFP+→4×SFP+ »
  du catalogue a `family: "SFP+"` et se branche sur des lanes, jamais sur le trunk.
- **Une lane n'a pas de position de façade** (`face_x`/`face_y` ne sont posés que sur les ports sans
  parent, l'éditeur de façade ne les propose pas) : elle émerge du **connecteur du trunk**, et c'est ce que
  la géométrie 3D applique — `Store.portConnectorSize` remonte au parent, `Resolver3D` résout une lane sur le
  connecteur de son trunk.
- Supprimer un trunk **emporte ses lanes** (cascade déclarative, récursive : une sous-lane suivrait), et
  chaque lane emporte le câble qu'elle porte.

## Les règles

Toutes vivent dans le module **pur** [`core/BreakoutRules`](../src-client/core/BreakoutRules.ts)
(aucun DOM, aucun store — patron `PortCompatibility`), qui rend des **verdicts en codes** traduits au
rendu. L'état « ce port porte-t-il un câble ? » lui est transmis en booléen par l'appelant, qui le lit
dans `Store.cableOnPort` — un port brouillon jamais enregistré n'en a donc pas, sans cas particulier.

| Règle | Où | Verdict |
|---|---|---|
| Lane et trunk appartiennent au **même équipement** | validation partagée, règle T2 | refus à l'écriture |
| Le **trunk éclaté est incâblable** — les lanes portent les câbles | `CableForms.portOpts` (exclu de la liste, sauf s'il est la valeur déjà retenue), clic 3D sur un trunk → choix d'une lane | doctrine, inchangée |
| **Éclater** n'est offert qu'à un port de **données** (le PoE en est), ni lane ni trunk — pas de breakout **imbriqué** par l'UI (le modèle et la cascade le supportent, l'UI v1 ne l'offre pas) | `BreakoutRules.canSplit` | `not-data` · `is-lane` · `is-trunk` |
| **Éclater un port qui porte un câble est refusé** — un trunk ne peut pas en porter, il faut décâbler d'abord | `BreakoutRules.canSplit` | `cabled` |
| **Défaire est refusé si une lane porte un câble** — la supprimer supprimerait le câble en cascade ; le verdict **nomme** les lanes en cause | `BreakoutRules.canUnsplit` | `{ ok: false, cabledLanes }` |
| Les lanes se nomment `<trunk>/1` … `<trunk>/N` | `BreakoutRules.laneNames` — **seule** source du schéma | — |

L'ordre des verdicts de `canSplit` va du plus **structurel** au plus **circonstanciel** (lane > trunk >
genre > câble) : le message dit ce qui ne changera pas avant ce qui pourrait changer.

## L'interface

### Formulaire d'équipement — la section dédiée

Un trunk et ses lanes forment **un groupe** `div.port-breakout`, visuellement distinct des cartes
`<details class="port">` des ports ordinaires : liseré accent à gauche, en-tête sur fond relevé
(étiquette « Breakout · N lanes », **nom du trunk éditable**, pastille de catégorie, type, menu ⋮), puis
les lanes **dedans**. Les lanes reprennent la **grammaire des têtes de port** (`.p-name` / `.p-cat` /
`.p-metric` : nom éditable, catégorie, type, tag « lane N ») mais ne sont **pas extensibles** — une lane
n'a ni sens, ni budget, ni brins, ni façade. Un repère vertical rattache chaque lane à son trunk. Le
groupe est construit par `BreakoutRules.groupByTrunk(brouillon)` : un groupe par trunk, une carte par
port ordinaire, une lane orpheline (parent absent) rendue comme un port ordinaire — jamais cachée.

Tout le style vient de classes de `dc-manager.css` (tokens `--accent`, `--bg-2`, `--bg-3`, `--line-2`,
`--lift`…) : aucune couleur en dur, le thème clair suit de lui-même. Un refus d'enregistrement pose le
même `data-err` (liseré rouge) sur le groupe ou la lane fautive que sur une carte de port.

### Les gestes — le menu ⋮

Chaque ligne de port porte un menu **⋮** (`ui/RowMenu`, le même que les listings) à **emplacements** :

| Ligne | Item | Effet | Refus |
|---|---|---|---|
| port ordinaire | **Éclater en N lanes…** | ouvre le dialogue en mode `split` ; les lanes s'insèrent après le port dans le brouillon, avec `parent_port_id` = ce port. **Le port ne change pas** (id, nom, type, position de façade, agrégat, réseau) — il devient trunk par le seul fait d'avoir des lanes | item grisé + raison en infobulle (`canSplit` ≠ ok) |
| trunk | **Défaire le breakout** | les lanes quittent le brouillon ; le trunk **reste** et redevient une carte ordinaire au re-rendu. Le retrait en base passe par l'enregistrement (les ports absents du brouillon sont supprimés, cascade comprise) | item grisé nommant les lanes câblées (`canUnsplit`) |
| trunk | **Supprimer le port et ses lanes** (danger) | retire trunk et lanes du brouillon | — |

Le menu d'un port ordinaire n'a qu'**un** item aujourd'hui, et c'est voulu : la forme accueille un
second emplacement (« poser une terminaison ») sans être refaite — clause C3 ci-dessous. On ne livre pas
d'item factice grisé.

Le bouton **« + Breakout »** (trunk neuf) existe toujours ; il ouvre le même dialogue en mode `new`.

### Le dialogue de configuration — `FormBase.configureBreakout`

Un seul dialogue, deux modes :

- **`new`** : nom du trunk, type du trunk, type des lanes, nombre de lanes ;
- **`split`** : le trunk est le port existant — nom et type **affichés**, figés ; on ne choisit que le type
  des lanes et leur nombre. Un port sans nom est refusé (les lanes héritent de son nom) : le message renvoie
  à la ligne du port.

Le **nombre de lanes** se déduit des débits (`PortTypes.speedGbps`) quand les deux types en ont un —
ratio entier ∈ `BREAKOUT_SPANS` (2, 4, 8) — sinon il se choisit à la main. Les types se choisissent dans
des **sélecteurs à recherche** (`FormControls.entityPicker`, principe n°14) ; la famille figure dans le
libellé (donc cherchable), à défaut de `<optgroup>`. Seuls les types de **données** sont proposés : les
lanes sont créées en rôle `data`, un type d'énergie y serait « hors rôle ».

### Fiche de l'équipement (lecture)

Le tableau des ports range les **lanes immédiatement sous leur trunk** (`BreakoutRules.orderWithLanes`),
quel que soit l'ordre de saisie. Les lignes portent `tr.port-trunk` (nom en accent, pastille « trunk ×N »)
et `tr.port-lane` (retrait, repère vertical, pastille « lane N · trunk »).

## 3D

Les lanes **ne se dessinent pas** (v1) : elles se superposeraient toutes au connecteur du trunk, et une
règle de disposition n'a pas encore été arbitrée. Seul le trunk a un mesh ; le cliquer propose ses lanes
(c'est le geste de câblage, cf. `DcInteract.resolveLaneToCable`). « Localiser » une lane cadre le
connecteur de son trunk (`Resolver3D`). Rien de ce document ne touche `DcThreeScene`.

## Mode local

Aucun écart : tout est **logique client** (brouillon du formulaire, `BreakoutRules`, `Store`) et
**validation partagée** (règle T2). Éclater, défaire, nommer, câbler une lane fonctionnent à l'identique
en mode fichier et en mode API — rien n'exige le serveur (principe n°15).

## Terminaison (à venir)

Le breakout modélise la **multiplicité** (« ce port se comporte comme N ports ») ; la terminaison
modélisera le **média** (« ce que la cage présente au câble » — un transceiver). Ce sont deux notions
orthogonales, donc **deux modèles autonomes**, reliés par un seul point de lecture : `Store.portFamily`
deviendra la famille **effective** du port (terminaison du port ?? terminaison du trunk ?? famille du
type). Pour que la terminaison s'ajoute sans rien défaire, le breakout tient six clauses :

| # | Clause |
|---|---|
| **C1** | Toute **logique** lit la famille par `Store.portFamily`, jamais `pt.family` en direct (l'affichage d'un libellé peut lire le type). |
| **C2** | Les lanes **gardent leur `port_type_id` propre** ; la terminaison surchargera, elle ne changera pas le type de la lane. |
| **C3** | Le menu ⋮ des lignes de port est un menu à **emplacements** : « éclater » en occupe un, « poser une terminaison » en occupera un autre. |
| **C4** | Le **trunk éclaté reste incâblable** ; un trunk qui perd toutes ses lanes redevient câblable. |
| **C5** | Éclater un port **existant conserve son identité et sa position de façade** — c'est ce qui rend l'opération réversible (défaire). |
| **C6** | **Aucune donnée du breakout ne migre vers `spares`**, et aucun chemin synchrone n'en lit : `spares` est une collection paresseuse en mode API, la famille effective d'un port ne pourra jamais s'y lire. |

## Limites de la v1

- Les lanes ne sont **pas extensibles** dans le formulaire : leur sous-équipement desservi
  (`sub_equipment_id`) ne s'y règle pas — il se règle sur le port avant de l'éclater, ou plus tard, par une
  ligne de lane extensible.
- Renommer le trunk **ne renomme pas ses lanes** (elles ont été nommées à la création) ; les noms restent
  éditables lane par lane.
- « Supprimer le port et ses lanes » n'est pas gardé contre les lanes câblées : c'est une suppression
  explicite, marquée danger, dont la cascade emporte les câbles à l'enregistrement — comme la corbeille
  d'un port ordinaire câblé.
- Pas de breakout **imbriqué** par l'UI (une lane ne s'éclate pas), bien que le modèle le supporte.

## Tests

`Tests/modules/test-breakout.js` : toutes les branches de `canSplit` (dont l'ordre des verdicts), de
`canUnsplit`, de `laneNames` et de `groupByTrunk`/`orderWithLanes` ; la relecture de l'état au Store
(`cableOnPort`) ; et un **verrou sur les sources** — le formulaire appelle bien la règle, le nommage passe
par `laneNames`, l'ancien « × » destructeur a disparu, les sélecteurs de types sont à recherche, le bloc
CSS ne contient aucune couleur en dur. La section T2-B1 de `test-views-tools.js` (lanes atteignables au
geste, trunk incâblable) reste la référence du câblage.
