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
| `links` | `cables`, `cableBundles` | `LabelPrintPolicy.isFlagKind()` les déclare **strictement équivalents** (mêmes contenus, mêmes formats, même anatomie de drapeau et d'extrémités A/B). La famille ne fait que NOMMER cette équivalence. |
| `equipments` | `equipments` | Anatomie propre : « baie · U », famille + marque/modèle, série, **et propriétaire** — le seul sujet qui en porte un. |
| `racks` | `racks` | Format « Baie » réservé, ni série ni propriétaire. |
| `components` | `subEquipments`, `spares` | Même raison que `links`, un cran plus loin : `LabelPrintPolicy.isSpareLike()` les déclare équivalents (mêmes contenus, mêmes formats, même gabarit S par défaut). Stock ou installé ne change pas la FORME de l'étiquette — et étiqueter d'un coup un bac de disques dont certains sont montés est le geste naturel. ⚠ Depuis **T10** leurs CASES diffèrent (chaque sujet déclare les siennes) : la planche mixte est portée par l'**union d'offre**, pas par une identité de champs — cf. [`qr-scan.md`](qr-scan.md) § « Champs déclarés par sujet ». |

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
- Les cases portent la classe **`.app-check`** — la case à cocher thématisée de l'app, créée avec ce
  chantier (il n'en existait aucune : les rares cases étaient nues, donc dépendantes de l'OS et mal
  alignées sur la grille des traits). CSS pur sur un `<input type="checkbox">` natif : le rôle ARIA,
  le focus clavier et l'état **indéterminé** restent ceux du navigateur, on ne repeint que le dessin.
  Adoptable partout par le simple ajout de la classe — les cases de la page Certificats et de
  `ui/MultiSelect` ne l'ont pas encore.

Le câblage vit **une seule fois**, dans `addListTab` de `main.ts` : une famille de plus héritera des
cases sans que personne y pense.

## L'action « imprimer les étiquettes » — `core/CartLabelPlan` (PUR) + câblage

Le **plan** d'une famille porte deux règles, écrites une fois et testées :

| Famille | `kind` | Étiquettes par élément |
|---|---|---|
| `links` | `cable` | **2** — un drapeau par extrémité (décision P9), en parité avec la fiche et l'action de ligne |
| `components` | `spare` | **1** |
| `equipments` | `equipment` | **1** |

Le `kind` unique ne pose aucun problème : une famille est **précisément** un ensemble de collections
que `LabelPrintPolicy` traite à l'identique (`isFlagKind`, `isSpareLike`) — et depuis **T10** ce que
la politique traite est bien la seule chose qu'un `kind` décide (contenus, formats, défauts) : les
CASES, elles, ne dépendent plus du `kind` mais des **sujets du tirage**, dont la modale prend
l'union. Une planche de spares hétérogènes, ou de spares *et* de sous-équipements, est donc le cas
NOMINAL et non un cas limite. Une famille **absente** de
la table n'a pas d'action — `main.ts` ne la déclare donc pas, et ses listings ne posent aucune case.
L'argument `families` de `CartPanel.setup` est **dérivé** de cette table, jamais recopié.

Côté `main.ts` ne reste que ce qui touche au `Store` : la table `collection → constructeur de sujet`
(`LabelSubjects.*`). Les éléments disparus sont comptés et signalés par un toast, les autres
s'impriment.

**Ajouter une famille au panier** = une entrée dans `CartFamilies`, une dans `CartLabelPlan`, un
constructeur dans `LabelSubjects`. Rien d'autre — les cases, la pastille et la modale suivent.

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
| Les **baies** ne sont pas au panier | Une entrée de plus dans `CartLabelPlan` — leur anatomie d'étiquette existe déjà, et la fiche baie offre déjà « Planche du contenu ». |
| Remplissage par **listings** seulement (ni fiches, ni scan en rafale) | Boutons de fiche ; mode lot du viseur (déjà cadré, `qr-scan.md` § « Extension future »). |

## Tests

`Tests/modules/test-cart.js` — les deux modules purs : la carte des familles, et l'état (ordre
d'ajout, idempotence, `conflict` qui ne détruit rien, plafond, remplacement explicite, relecture
tolérante du stockage). `ui/CartPanel` et le greffon de `ListView` sont du DOM : **non couverts en
headless**, à valider à l'œil.
