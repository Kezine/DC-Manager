# Terminaisons — un transceiver dans la cage

Une **terminaison** décrit ce qu'un port **présente au câble** quand un **transceiver** occupe sa cage : un port
SFP28 (la **cage**) équipé d'un module optique présente une **fibre LC monomode** (le **média**). Sans cet objet,
une jarretière FO-SM ne peut jamais rejoindre un switch : la compatibilité de câble exige l'égalité des familles
(`Store.cableCompatible`), et le câble reste en brouillon pour toujours. Ce document décrit le modèle, la règle de
jonction avec la compatibilité, les règles de validation, les gestes de l'interface et ce que la 3D en montre. Le
[breakout](breakout.md) est l'autre couche optionnelle d'un port — les deux sont orthogonales (multiplicité d'un
côté, média de l'autre) et se rencontrent en un seul point : `Store.portFamily`.

## Le besoin : la cage n'est pas le média

Un type de port porte deux axes depuis toujours : `family` (la clé de compatibilité du signal) et `connector` (la
forme physique). Pour une cage SFP/QSFP, la famille **est** la cage (`SFP28`) ; pour une fibre, la famille est le
**média** (`FO-SM`, connecteur `LC`). Un transceiver s'interpose entre les deux : il **occupe** une cage et **présente**
un média. C'est ce que la terminaison modélise — rien de plus : le débit du module n'est pas contrôlé (un module
10G dans une cage 25G n'est pas refusé), et le transceiver n'a pas de dessin 3D propre.

## Le modèle : le port dit ce qu'il présente, la pièce dit où elle est

Deux informations, deux porteurs, jamais confondus :

| Champ | Porteur | Sens |
|---|---|---|
| `termination_port_type_id` | `ports` | FK → `portTypes` : le type que la cage **présente** au câble (ex. « Fibre SM (LC) »). `null` = pas de terminaison. |
| `termination_label` | `ports` | Libellé lisible du module (« SFP-10G-LR »). Vide = transceiver **générique**. |
| `assigned_port_id` | `spares` | FK → `ports` : la **cage** qu'occupe cette pièce inventoriée, à côté de `assigned_equipment_id`. `null` = aucune. |

- **Le média vit sur le port** parce qu'il est lu dans des chemins **synchrones et chauds** (statut de chaque câble,
  candidats au clic, formulaires) et que `spares` est une collection **paresseuse** en mode API
  ([`hydratation.md`](hydratation.md) § vague 4) : la famille effective d'un port ne peut **jamais** s'y lire — un
  mensonge `[]` ferait retomber tous les câbles en brouillon tant que la collection n'est pas chargée. C'est la clause
  **C6** du contrat breakout ⇄ terminaison ([`breakout.md`](breakout.md) § Terminaison).
- **L'inventaire vit sur la pièce** parce que c'est la forme que réclame le suivi des pièces : *la pièce pointe son
  emplacement* (équipement, et désormais cage). Un `spare_id` sur le port ferait deux vérités pour une seule relation.
- **La pièce est facultative.** Poser une terminaison ne crée jamais de pièce : le **transceiver générique** est le
  choix par défaut du dialogue, et il n'a **aucune existence en base** — le média présenté sur le port suffit à un
  câblage structurellement correct. Lier une vraie pièce plus tard ne touche pas au câble.
- Le type **propre** du port (`port_type_id`) reste la **cage** : il pilote la taille 3D du connecteur
  (`Store.portConnectorSize`, inchangé) et permet de nommer un montage aberrant.
- Sans terminaison, le comportement est **identique** à celui d'un port sans transceiver, au bit près : zéro migration,
  aucun câble existant invalidé. Les types de câble « Fibre SFP+ Monomode » du catalogue (famille `SFP+`, média
  fibre) restent un **raccourci valide** pour un switch ⇄ switch sans terminaison.

## La jonction : le type effectif

`Store.terminationOf(port)` rend la terminaison **effective** d'un port — la sienne, sinon celle de son **trunk**
(montée récursive avec garde anti-cycle : un breakout imbriqué suivrait). `Store.effectivePortType(port)` rend le
type que le câble rencontre :

> type effectif(port) = type(terminaison du port) ?? type(terminaison du parent) ?? type(port)

`Store.portFamily` — **seul** point de lecture de la famille pour toute logique (clause C1) — est écrit sur cette
jonction : `cableCompatible` → `cableIsComplete` → `cableMaxStatus`, `cableDraftCandidatesForPort` et les options
du formulaire câble en héritent sans qu'aucun d'eux ne change. L'héritage lane ← trunk est le montage
« transceiver fan-out sur un trunk éclaté » (un QSFP-SR4 + fan-out MPO → 4 × LC) : une terminaison posée sur le
trunk, ses lanes présentent son média ; une lane qui porte sa **propre** terminaison prime. C'est la même montée que
`portConnectorSize`, qui lui ne change pas : une lane émerge du connecteur de son trunk.

Un média dont le type a disparu retombe sur la cage, jamais sur « inconnu » — la cascade `portTypes` détache
d'ailleurs les deux références (`port_type_id` et `termination_port_type_id`).

Les deux surfaces qui **nomment** un appariement fautif (retour terrain T3, [`validation.md`](validation.md) § 11)
— le toast du traçage de route (`RouteTool.warnIfIncompatible`) et le hint du formulaire câble — comparent les
types **effectifs** : avec un transceiver dans la cage, comparer les cages déclarerait « aberrant » un montage
correct. Le connecteur cité par le message est donc celui du média présenté (LC). `core/PortCompatibility` ne change
pas : il ne consomme qu'une forme `{ family, connector }`.

## Les règles

Toutes vivent dans la validation partagée ([`validation.md`](validation.md)), donc s'appliquent à l'UI, à l'API et à
l'import :

| Règle | Où | Effet |
|---|---|---|
| Le média présenté est un type de port de **données** (T-TERM1) | `ports`, cross-entité | refus — un port ne présente pas de l'énergie |
| Seul un **transceiver** occupe une cage | `spares`, invariant | refus |
| La cage occupée **appartient à l'équipement d'affectation**, et il y en a un | `spares`, cross-entité ; rejouée depuis `ports` (dépendance inverse) | refus — une pièce « disponible » qui occuperait encore une cage serait un mensonge d'inventaire |
| Supprimer un port **détache** la pièce logée (`assigned_port_id` → null) | cascade `ports` | la pièce survit, toujours affectée à l'équipement |
| Supprimer un type de port détache aussi les médias présentés | cascade `portTypes` | aucune FK pendante |

`spares.assigned_port_id` est indexé des deux côtés (`INDEX_SPEC`) : c'est le chemin chaud de la cascade et de la
dépendance inverse. ⚠ Côté client, `spares` étant paresseuse, le plan de cascade local peut manquer un détachement ;
le serveur rejoue la règle sur son état complet et le client rafraîchit les lignes rapportées (M4b).

## Les gestes

### Depuis le formulaire d'équipement — le brouillon

Le menu **⋮** de chaque ligne de port (ports ordinaires, trunks **et** lanes) porte, au **deuxième emplacement**
prévu par la clause C3 du breakout, **« Poser une terminaison… »** (ou **« Modifier la terminaison… »** quand elle
est posée) et **« Retirer la terminaison »**. Réservé aux ports de **données** — grisé avec la raison sinon.

- Le dialogue écrit le **brouillon** du port : rien n'est en base avant « Enregistrer », le média part avec le port.
- La **pièce** choisie n'est pas un brouillon (`spares` est paresseuse) : le choix est mémorisé comme **lien en
  attente** et appliqué **au save, dans le même `saveBatch`** que les ports — la pièce est logée (`assigned_port_id`,
  `assigned_equipment_id` = l'équipement, `status = assigned`, date du jour si vide) et la pièce qui occupait la cage
  en base est détachée si elle change. La vérité « qui occupe la cage en base » est **relue en async** au moment du
  save, pas mémorisée au geste.
- **« Retirer la terminaison »** vide les deux champs du port **et** détache la pièce logée — elle reste affectée à
  l'équipement, plus à la cage. L'inverse n'est pas vrai : retirer ou décommissionner la pièce depuis son formulaire
  ne retire **pas** la terminaison du port (décision utilisateur) ; son formulaire neutralise seulement
  `assigned_port_id` quand la pièce cesse d'être attribuée au même équipement, sans quoi la règle d'appartenance
  refuserait une ré-affectation légitime.
- Les têtes de ligne portent une pastille **« ⇒ Fibre SM (LC) · SFP-10G-LR »** ; sur une lane qui **hérite** du
  trunk, la même pastille, atténuée, titrée « héritée du trunk ». Classes thématisées (`.pill.p-term`, `.inherited`),
  aucune couleur en dur.

### Depuis le formulaire câble — l'écriture immédiate

C'est le geste du terrain (« je câble et ça coince »). Quand l'appariement **bloque**, le hint garde son message et
**propose** le geste : un bouton **« Poser une terminaison sur A »** / **« … sur B »** par bout de données (« Modifier
la terminaison de… » si le bout en a déjà une propre). Le média est **pré-rempli** depuis le type **effectif** de
l'autre bout — l'autre bout est un tiroir FO-SM, le générique présente FO-SM : « il prend automatiquement les bonnes
specs ». Le port est **écrit immédiatement** (`Store.saveBatch`, avec la pièce liée ou détachée dans le même lot), un
toast le dit, puis le formulaire se ré-évalue : options, statut maximal, hint. Assumé : le port est écrit même si le
câble est ensuite annulé — la terminaison décrit un fait physique, pas le câble.

Le traçage de route en 3D **accepte puis propose** : le toast d'appariement reste, le formulaire s'ouvre, et c'est
son hint qui offre la terminaison.

### Le dialogue — `FormBase.configureTermination`

Un seul dialogue pour les deux gestes :

- **Port (cage)** — affiché, pas saisi : la distinction cage ⇄ média est tout le sens du dialogue.
- **Média présenté au câble** — un **type de port existant de kind `data`** (sélecteur à recherche, famille dans le
  libellé) : le catalogue porte déjà famille, connecteur et duplex, un second catalogue de transceivers doublonnerait.
  Valeur initiale : la terminaison posée, sinon le média suggéré par l'autre bout, sinon — pour une cage SFP/QSFP —
  un type fibre LC (monomode d'abord), sinon rien.
- **Libellé du module** — libre ; vide ⇒ « Générique ».
- **Pièce inventoriée** — sélecteur **async** (`FormControls.entityPickerAsync`) dont la source dédiée
  [`core/TerminationSpareSource`](../src-client/core/TerminationSpareSource.ts) charge **une fois** les transceivers
  affectés à l'équipement (`Store.sparesOfEquipmentAsync`) et ceux du stock (`Store.sparesAvailableAsync`), sans
  jamais lire `store.all("spares")`. Entrée de **tête** : « Transceiver générique (non inventorié) », valeur vide,
  choix par défaut. Une pièce déjà logée dans une **autre** cage est listée grisée, cage nommée. Si `tx_form` /
  `tx_media` de la pièce contredisent la cage ou le média (comparaison insensible à la casse, sur le premier mot),
  un avertissement s'affiche sous le champ — **jamais bloquant**.

### Fiche, section spares, bulle 3D

La fiche de l'équipement (lecture) montre la même pastille sous le nom du port ; sa section « Spares affectés »
suffixe la désignation d'un transceiver logé par « · cage <port> ». En 3D, la **bulle** d'un port ajoute une ligne
« Terminaison : <module> ⇒ <média présenté> » (+ « (héritée du trunk) ») ; la ligne du type continue de nommer la
cage.

## 3D

**Logique.** Le transceiver ne se dessine pas : la cage est déjà dessinée à sa taille (`portConnectorSize` lit le
type propre), et c'est elle que l'utilisateur clique. Seule la bulle de survol parle de la terminaison. Rien de ce
document ne touche `DcThreeScene`.

## Mode local

Aucun écart : tout est **logique client** (Store, brouillon du formulaire, dialogue) et **validation partagée**. Les
champs suivent `SPEC_FIELDS` en mode fichier, le schéma serveur les gagne par évolution additive à l'ouverture
([`persistance.md`](persistance.md)). Les jumeaux async (`sparesOfEquipmentAsync`, `sparesAvailableAsync`) sont
résolus sur le cache en mode fichier, sans réseau (principe n°15).

## Limites

- Le **débit** transceiver ⇄ cage n'est pas contrôlé (un 10G-LR dans une cage 25G n'est pas refusé).
- Pas de **détecteur en lot** des câbles bloqués en brouillon faute de terminaison : la proposition vit dans le hint
  de chaque câble rouvert.
- Pas de **mesh** 3D du transceiver.
- Le **formulaire de spare** n'expose pas la cage (le chantier « pièces » T16 le fera) : elle se pose depuis le
  dialogue de terminaison.
- `sparesAvailableAsync` balaie `spares` sur `status` (colonne non indexée) : assumé, la collection se compte en
  dizaines et le chemin n'est parcouru qu'à l'ouverture d'un dialogue.
- Depuis le formulaire câble, la pièce qui occupe la cage à l'ouverture est retrouvée en **async** ; confirmer le
  dialogue avant la fin de ce chargement (fenêtre de quelques millisecondes en mode fichier) ne détache pas une
  pièce déjà logée — la fiche la montre toujours, on la retire d'un second geste.
- Le formulaire d'équipement ne connaît qu'**un niveau** d'héritage dans son brouillon (l'UI n'imbrique pas les
  breakouts) ; le Store, lui, monte récursivement.

## Tests

`Tests/modules/test-terminaisons.js` : la jonction (`terminationOf`, `effectivePortType`, `portFamily`, héritage
lane ← trunk et priorité de la lane, garde anti-cycle, `portConnectorSize` inchangé), le cas T5 mot pour mot
(jarretière FO-SM entre un port FO-SM et un SFP28 avec terminaison ⇒ complet, sans ⇒ brouillon), la validation
partagée (T-TERM1, appartenance de la cage, transceiver seul, dépendance inverse), la cascade (port supprimé ⇒ pièce
détachée, équipement conservé ; type de port supprimé ⇒ média détaché), la source de candidats du dialogue, et des
**verrous sur les sources** : les deux surfaces T3 lisent `effectivePortType`, aucun `store.all("spares")` synchrone
dans les fichiers touchés, le menu ⋮ et le hint passent bien par le dialogue.
