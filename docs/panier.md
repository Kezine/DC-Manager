# Panier d'actions groupées

Un **panier** rassemble des éléments du modèle, **à travers les vues et les pages**, pour leur
appliquer une **action groupée**. Première (et seule) action à ce jour : **imprimer une planche
d'étiquettes**. Cadrage complet et arbitrages : `.notes/toDos/panier-actions-bulk-cadrage-2026-08-24.md`.

> **État : V1-Beta.** Le socle est complet et testé ; plusieurs raffinements sont volontairement
> repoussés, tous listés en fin de document (§ Limites). Rien de ce qui est ici n'aura à être défait
> pour les livrer.

## Le concept

- **Le panier ne porte qu'UNE famille à la fois.** Une *famille* est une classe d'équivalence de
  collections **qui partagent la même anatomie d'action** — pas un regroupement de confort.
- **Cocher une ligne SIGNIFIE « au panier ».** Il n'y a pas deux concepts (une sélection de listing
  *et* un panier) : la case reflète l'état du panier, lequel survit au changement de page, de tri,
  de filtre et de vue. C'est tout l'intérêt.
- **Le panier est LOCAL à l'appareil.** Remplir sur le téléphone puis imprimer sur le PC n'est pas
  offert — ce serait un panier serveur, arbitré « non ».

## Les familles — `core/CartFamilies` (PUR)

| Famille | Collections | Pourquoi ensemble |
|---|---|---|
| `links` | `cables`, `cableBundles` | `LabelPrintPolicy.isFlagKind()` les déclare **strictement équivalents** (mêmes contenus, formats, champs et défauts d'étiquette). La famille ne fait que NOMMER cette équivalence. |
| `equipments` | `equipments` | Formats, champs offerts et gabarit par défaut qui lui sont propres. |
| `racks` | `racks` | Format « Baie » réservé, ni série ni propriétaire. |
| `spares` | `spares` | Gabarit S par défaut, pas de propriétaire. |

Une collection **absente de la carte n'entre pas au panier**, et c'est volontaire : elle y entrera le
jour où au moins une action groupée l'accepte. Offrir le geste sans l'issue serait un mensonge
d'interface.

## L'état — `core/CartModel` (PUR)

Stocke `{ collection, id, label }`. Le `label` est un **secours d'affichage** — il permet de montrer
le panier sans réhydrater une collection paginée ; il n'est jamais la vérité. **Au moment d'agir,
chaque enregistrement est relu dans le `Store`** : ceux qui ont disparu entre-temps (suppression par
un autre client, SSE) sont **exclus et signalés**, jamais cause d'un échec global.

`add()` rend un **verdict** — `added` · `already` (idempotent) · `unsupported` (hors carte) ·
`conflict` (autre famille) · `full` (plafond).

> 🚨 **`add` ne vide JAMAIS le panier de sa propre initiative.** Sur `conflict` il ne touche à rien
> et laisse l'UI proposer ; le remplacement est un geste séparé et explicite (`replaceWith`).
> Sans cette règle, un clic distrait effacerait un travail de préparation.

**Plafond `CartModel.MAX` = 50.** Le cadrage a tranché 200, mais l'impression tire aujourd'hui **un
appel réseau par étiquette unique**, sans bridage de concurrence. La V1-Beta se tient donc à 50 le
temps que le pool existe ; monter la constante suffira, elle est le seul endroit qui la porte.

## L'orchestration — `ui/CartPanel`

Persistance, pastille et modale. Trois points à connaître :

- **Injection nulle** (patron `LabelPrintDialog` / `AccessState`) : `setup()` n'est appelé par
  `main.ts` **que si au moins une action groupée est disponible**. Partout ailleurs `available()`
  rend faux, l'entrée de topbar reste masquée et **les listings ne posent aucune case** — sans le
  moindre test de mode dispersé.
- **Cloisonnement par document** : le document courant est relu à **chaque accès** (`host.docKey()`)
  et comparé à la portée chargée ; dès qu'il change, le panier est rechargé depuis le stockage, donc
  vide s'il appartenait à un autre document. Aucun événement à brancher, donc aucun à oublier.
- **Stockage** : `localStorage`, clé `dcmanager.cart.v1`, charge utile `{ doc, items }`. La relecture
  est **tolérante** — vide, corrompu ou bricolé à la main, rien ne peut installer un panier que l'UI
  ne saurait plus représenter (l'invariant de famille est ré-imposé à la lecture).

## Les cases des listings — `views/ListView`

`ListOptions.selection` (`ListSelection`) est un greffon **optionnel**. Le listing ne porte **aucun
état de sélection** : il pose des cases et rapporte les gestes.

- `enabled()` est réévalué **à chaque rendu** — pas de case en mode fichier, suivi à chaud d'un
  changement de droits.
- `setSelected()` rend `false` quand le geste n'aboutit pas (conflit, plafond) : **la case revient
  alors où elle était**. L'affichage ne prétend jamais un ajout que le panier n'a pas fait.
- La case d'en-tête coche **la page** et **reflète** son état (cochée / indéterminée) sans porter
  d'état propre.
- Cocher **ne repeint pas le listing** : on perdrait le défilement et, en régime pagé, on
  relancerait une requête pour rien.

Le câblage vit **une seule fois**, dans `addListTab` de `main.ts` : une famille de plus héritera des
cases sans que personne y pense.

## L'action « imprimer les étiquettes »

Câblée dans `main.ts` (là où vivent déjà les autres points d'entrée d'impression) :

- **deux drapeaux par lien** — un par extrémité, comme la fiche et l'action de ligne : un câble
  s'étiquette par paire ;
- **`kind: "cable"` vaut pour toute la famille `links`** — `LabelPrintPolicy` traite câble et
  faisceau à l'identique, un panier mixte n'a donc rien à arbitrer ;
- les éléments disparus sont comptés et signalés par un toast, les autres s'impriment.

La suite (gabarits, planche, `@page`, manchons) est celle de
[`qr-scan.md`](qr-scan.md) § « Étiquettes imprimables » — le panier n'ajoute **aucun** chemin de
rendu, il fournit juste plus de sujets à la même modale.

## Mode local

**Le panier n'est pas offert en mode fichier**, et c'est un écart assumé (principe n°15) : sa seule
action, l'impression d'étiquettes, est **mode API seulement** (génération serveur des QR). Le panier
lui-même est pourtant 100 % client — le jour où une action non-serveur existe (export, ajout à un
groupe…), il suffira que le bootstrap appelle `CartPanel.setup` dans les deux modes. La disponibilité
est portée par les **actions**, jamais par un test de mode.

Le panier **survit au mode lecture seule** (`viewer-mode`) : imprimer une étiquette ne modifie rien.

## Limites de la V1-Beta

| Limite | Ce qui la lèvera |
|---|---|
| Plafond à **50** au lieu de 200 | Bridage de concurrence des requêtes QR (pool ~6). |
| Pas de synchro **entre onglets** | Un `BroadcastChannel` (le patron existe : `app/TabChannel`). |
| Pas de dialogue de **remplacement** au conflit de famille — simple refus expliqué | Impossible à déclencher aujourd'hui : les cases n'apparaissent que sur les listings d'une seule famille. À livrer avec la 2e famille porteuse d'une action. |
| La case d'en-tête coche la **page**, pas « les N résultats du filtre » | Un second geste explicite, plafonné. |
| **2 drapeaux par lien** imposés (pas de case pour n'en tirer qu'un) | Une case dans le panneau du panier. |
| Remplissage par **listings** seulement (ni fiches, ni scan en rafale) | Boutons de fiche ; mode lot du viseur (déjà cadré, `qr-scan.md` § « Extension future »). |

## Tests

`Tests/modules/test-cart.js` — les deux modules purs : la carte des familles, et l'état (ordre
d'ajout, idempotence, `conflict` qui ne détruit rien, plafond, remplacement explicite, relecture
tolérante du stockage). `ui/CartPanel` et le greffon de `ListView` sont du DOM : **non couverts en
headless**, à valider à l'œil.
