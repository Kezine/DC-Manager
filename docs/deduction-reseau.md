# Déduction réseau (source unique = port terminal)

Le **réseau logique** (`networks` : VLAN data / circuit power) ne vit **plus sur le câble**. Il est **asserté
sur les ports d'équipement TERMINAL** (switch, serveur, HBA — là où un VLAN/une fabric se configure réellement) et
**DÉDUIT** partout ailleurs le long du chemin. C'est la source unique : `Port.network_ids` (+ `network_id`
principal). Un port sans réseau = **joker** (il adopte le réseau déduit). Un port de **patch** n'assert jamais
(invariant T7) — il déduit.

> Implémentation : `Store.deducedNetwork()` / `deducedNetworkIds()` / `cableNetworkIds()` / `cablePrimaryNetworkId()`
> (`src-client/store/Store.ts`). Rendu couleur : `CableRouting.cableColor` (2D), `DcThreeScene.cableColorHex` (3D),
> `GraphView` (arête). Édition : `PortEditorControls` (réseau assigné sur le port terminal), piloté par `EquipmentForms`.

## Le graphe de connectivité

On modélise un graphe **non orienté** de ports à **deux types d'arêtes** :

- **JUMPER** — un câble relie `from_port_id ↔ to_port_id`.
- **BRIN** — dans un faisceau (`cableBundles`), deux ports de patch qui **partagent une même fibre PHYSIQUE**
  (même n° de brin `strand_a`/`strand_b`, cf. [faisceaux/patch](#lien-avec-les-faisceaux)) sont reliés.

Le **réseau déduit d'un port** = union des `network_ids` de **tous les ports terminaux de sa COMPOSANTE connexe**
(multi-hop : traverse patchs et brassages patch↔patch). Garde-cycle : visited-set sur les ports.

## Réseau principal (couleur) — déterministe

`cablePrimaryNetworkId` pilote la couleur. Comme la composante est la même quel que soit le point de départ, le
principal est **stable** : c'est le `network_id` (principal choisi par l'utilisateur) du **port assertant d'`id`
minimal** — sinon son 1er `network_ids`. Conséquence : deux câbles d'une même liaison ont la **même** couleur, et
le principal choisi sur le port est honoré (et non `network_ids[0]`, qui dépendrait de l'ordre de parcours).

## Performance — cache par composante

`cableNetworkIds`/`cablePrimaryNetworkId` sont appelés sur les chemins chauds (rebuild 3D par tube ET par port,
rendu SVG, légende, graphe, liste réseaux). La déduction est donc **mémoïsée par composante** : `Store._netCache`
(port → `{ ids, primary }`, partagé par toute la composante, rempli en une seule traversée), **invalidé à chaque
mutation** (`Store._emit`). Après le 1er calcul d'une composante, chaque lookup est O(1). Ne jamais sous-invalider :
le cache est vidé en bloc au moindre changement.

## Transition depuis l'ancien modèle

Décision produit : **on ignore les données réseau préexistantes des câbles** (`Cable.network_ids`/`network_id`
laissés **dormants** — plus jamais écrits par les formulaires ni lus par la déduction). Aucune migration.

## Lien avec les faisceaux

Un faisceau se rattache à **2 équipements patch** (`endpoint_a/b_equipment_id`) et forme un **pool de brins** ; un
port de patch « pioche » 1 (simplex) ou 2 (duplex Tx/Rx) brins physiques. L'arête BRIN relie les ports des deux
extrémités partageant la même fibre. Garde-fous (validation partagée `src-shared/DataValidation.ts`) : un brin n'est
pioché qu'une fois **par extrémité** (V6), ≤ `fiber_count` (T6), un port de patch n'assert pas de réseau (T7),
les extrémités sont **deux patchs distincts** (T10 : A ≠ B ; T11 : `type === "patch_panel"`, rejoué par dépendance
inverse si l'équipement d'ancrage est re-typé).
