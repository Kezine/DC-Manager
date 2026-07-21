# Carton de design — Refonte de l'éditeur de ports (support POE)

> **Type** : brief PROSPECTIF (spec d'UI à créer), destiné à Claude Design. Contrairement aux
> `design-system/templates/*` (miroirs fidèles du code existant), ce document décrit une UI qui
> n'existe PAS encore. Objectif : produire une exploration/maquette prête à guider l'implémentation.
> **Aucun code n'est écrit à ce stade** — seule cette spec l'est.
> **Langue** : français (domaine métier francophone). Réutiliser les primitives et tokens de
> `src-client/styles/dc-manager.css` (voir la galerie `design-system/previews/`).

---

## 1. Contexte

Un **équipement** (switch, serveur, PDU, tableau, patch…) possède une liste de **ports**. Ces ports
s'éditent aujourd'hui dans le **formulaire d'équipement** (`views/forms/EquipmentForms.ts`), une **ligne
par port** (`portRow`). La ligne actuelle, de gauche à droite :

```
[nom] [rôle: mgmt|data|power] [type de port (connecteur)] [⟨contrôles power⟩ | ⟨agrégat⟩] [réseau] [⎘] [×]
```
Les **contrôles power** (rôle = power, `PortEditorControls.powerPortControls`) tiennent aussi sur la
ligne : `[sens: source|sink] [ampères] [phase L1/L2/L3 si source]`.

### Ce qui change (nouveauté POE)

On ajoute une **4ᵉ catégorie de port : POE (data + power)** — un port RJ45 qui transporte À LA FOIS des
données ET de l'alimentation (norme PoE). Ça introduit, en plus des champs actuels :

- un **sens** (comme le power) : **producteur** (PSE — ex. switch PoE, injecteur) ou **consommateur**
  (PD — ex. caméra, borne WiFi, téléphone) ;
- un **budget de puissance par port** (en **watts**) ;
- au niveau **équipement** : un **flag « équipement POE »** et un **budget POE total** (watts), **partagé
  par tous les ports** POE ;
- des **règles conditionnelles** et un **retour de validation** (dépassement de budget) que la mono-ligne
  ne peut plus porter lisiblement.

➡️ **La mono-ligne ne suffit plus.** Il faut un éditeur de port plus riche (bloc/carte par port, ou ligne
extensible), avec des **champs conditionnels** selon la catégorie et un **compteur de budget** au niveau
équipement. **C'est l'objet de ce carton.**

> ⚠️ **Piège d'unité à respecter dans l'UI** : un port **power** se règle en **ampères (A)** (le port porte
> un courant ; la conso en W vit sur l'équipement). Un port **POE** se règle en **watts (W)** (les classes
> PoE se raisonnent en W : 15,4 / 30 / 60 / 90 W). L'UI doit afficher **la bonne unité selon la catégorie**.

---

## 2. Réflexion d'implémentation (contexte pour comprendre les liaisons de données)

*Section de fond — la maquette n'a pas à tout montrer, mais le designer doit savoir à quoi les contrôles
se lient. Noms de champs = PROPOSITION, à confirmer côté implémentation.*

- **Modèle actuel** — `Port` : `role` (mgmt/data/power), `port_type_id` (connecteur), `direction`
  (`""`/`source`/`sink`), `power_max_a` (A), `phase` (L1/L2/L3). `Equipment` : `power_nominal_w`,
  `power_max_w`, `pdu_max_a`, flags booléens `inventory_only`/`locked`/`locks_u`.
- **Additions proposées** :
  - `Equipment.poe_device: boolean` — l'équipement sait faire du POE.
  - `Equipment.poe_budget_w: number` — budget POE TOTAL (W), partagé par tous ses ports POE.
  - Nouvelle catégorie de port **POE** (nouveau `role` « poe », genre hybride « data+power ») ; les types
    de port POE sont des **connecteurs data** (RJ45…) — POE passe sur l'Ethernet.
  - `Port.poe_budget_w: number` — budget MAX du port (W). Réutilise `Port.direction` (source=PSE /
    sink=PD).
- **Invariants** :
  1. La catégorie **POE n'est sélectionnable QUE si `equipment.poe_device === true`**.
  2. **`poe_device` ne peut plus être désactivé tant qu'au moins un port POE existe** (sinon on
     orphelinerait ces ports).
  3. Somme des budgets des ports POE **producteurs** ≤ `poe_budget_w` (sinon **survente** → avertissement).
- **Intégration aux flux d'énergie** (`store/PowerAnalysis.ts`, `docs/power.md`) : la puissance POE doit
  **compter dans l'analyse énergie** :
  - un port POE **producteur** (PSE) délivre X W → cette puissance **s'ajoute à la consommation** de
    l'équipement source (il doit bien la tirer de ses entrées d'alimentation) ;
  - un port POE **consommateur** (PD) tire X W → c'est **sa charge** (souvent son unique alimentation) ;
  - le calcul de charge des **ports power** en aval doit donc **inclure la contribution POE**.
  *(Détail hors carton — mentionné pour cohérence.)*
- **Signal visuel de scène (hors éditeur, mais lié)** : un **câble connecté à un port POE portera le petit
  éclair d'avertissement** ambre, comme les câbles d'alimentation. Aujourd'hui le prédicat est
  `cableTypes[...].kind === "power"` (`DcThreeScene.cableIsPower`) ; il faudra l'**étendre** pour qu'un
  câble touchant un port POE le déclenche aussi. → **Conséquence design** : POE = « porteur d'énergie »,
  son langage visuel doit rappeler le power (éclair, teinte ambre) tout en restant distinct du data pur.

---

## 3. Les contrôles que le nouvel éditeur de port doit contenir

### 3.1 Par PORT (le bloc/ligne d'un port)

| # | Contrôle | Widget | Visible quand | Notes |
|---|---|---|---|---|
| 1 | **Nom** | input texte | toujours | court, extensible |
| 2 | **Catégorie** | sélecteur `data · mgmt · power · POE` | toujours | **POE désactivé + tooltip explicatif** si `poe_device` faux (découvrabilité du flag) |
| 3 | **Type de port (connecteur)** | select groupé par famille | toujours | filtré par la catégorie (POE ⇒ connecteurs data/RJ45) |
| 4 | **Sens** | segmenté `Producteur (PSE) · Consommateur (PD)` pour POE — `Source · Sink` pour power | catégorie ∈ {power, POE} | libellés adaptés à la catégorie ; défaut non choisi possible |
| 5a | **Calibre (A)** | input nombre + unité **A** | catégorie = power | existant |
| 5b | **Phase** | select `L1/L2/L3` | catégorie = power **et** sens = source | existant |
| 6 | **Budget POE (W)** | input nombre + unité **W** | catégorie = POE | budget MAX du port ; indice de classe PoE possible (15,4 / 30 / 60 / 90 W) |
| 7 | **Réseau (terminal)** | sélecteur réseau | catégories non-power (data/mgmt/POE) | existant |
| 8 | **Actions** | boutons-icône **dupliquer** ⎘ + **supprimer** × | toujours | existant |
| 9 | **État/validation du port** | pastille/liseré discret + message | si anomalie | ex. « budget > budget équipement », « POE indisponible » |

> Les **trunks/lanes** (ports en faisceau/breakout) restent affichés en **pastilles figées** (non
> éditables) — le nouveau layout doit cohabiter avec ces lignes en lecture seule.

### 3.2 Au niveau ÉQUIPEMENT (nouveau bloc « POE », près des champs énergie existants)

Les champs énergie actuels de l'équipement : `pdu_max_a` (si PDU/tableau), `power_nominal_w`,
`power_max_w` (masqué si type = tableau). **Ajouter un bloc POE** :

| # | Contrôle | Widget | Notes |
|---|---|---|---|
| A | **Équipement POE** | **bascule** (`FormControls.toggle`, style `.toggle-pill`) | **verrouillée/désactivée + explication** tant qu'un port POE existe (« retirez d'abord les ports POE ») |
| B | **Budget POE total (W)** | input nombre + unité **W** | visible si bascule ON ; c'est le pool partagé |
| C | **Compteur de budget** | **jauge / barre** : `alloué / total` + reste | LE nouvel élément visuel clé ; états : normal · ~80 % (avert.) · **survente** (dépassement, rouge) |

---

## 4. Règles conditionnelles (synthèse)

- Catégorie **POE** dans le sélecteur (#2) : **activée seulement si `poe_device`** ; sinon grisée + tooltip.
- **Sens** (#4) : montré pour power et POE uniquement ; libellés différents (PSE/PD vs Source/Sink).
- **Phase** (#5b) : power + source uniquement.
- **Unité** : #5a = **A** (power), #6 = **W** (POE) — ne jamais confondre.
- **Bascule POE équipement** (#A) : **verrouillée** dès qu'un port POE est défini.
- **Survente** : Σ(budgets des ports POE producteurs) > budget total ⇒ jauge (#C) en état d'alerte **et**
  liseré d'avertissement sur les ports concernés (#9).

---

## 5. États à maquetter

1. Équipement **sans port** (état vide + bouton « + Ajouter un port »).
2. Un port **data**, un port **mgmt** (cas simples, catégorie sans champs énergie).
3. Un port **power source** (A + phase) et un port **power sink** (A) — *inchangé, à préserver*.
4. **Un port POE producteur (PSE)** avec budget W — **le cas neuf**.
5. Un port POE consommateur (PD).
6. Équipement **POE désactivé** → catégorie POE grisée dans les ports (tooltip).
7. Équipement **POE activé** avec **jauge de budget** : (a) remplissage partiel, (b) ~80 % (avert.),
   (c) **survente** (rouge).
8. Bascule POE **verrouillée** (des ports POE existent).
9. Lignes **trunk / lane** figées cohabitant avec des ports éditables.
10. **Responsive** : rendu mobile < 560 px (l'app a déjà des cartes mobiles `ui/CardTable` + `data-label`).

---

## 6. Passage du mono-ligne au layout riche (pistes)

La liste doit rester **scannable même avec beaucoup de ports** (un switch = 24/48 ports). Deux directions à
explorer / arbitrer par le designer :

- **Ligne extensible** : ligne compacte (nom · pastille catégorie · sens · métrique clé) + zone de détail
  révélée (champs spécifiques à la catégorie). Garde la densité pour les longues listes.
- **Carte par port** : en-tête compact + corps de détail. Plus lisible unitairement, plus volumineux en
  masse — à réserver si peu de ports, ou avec repli compact.

**Recommandation** : privilégier une **ligne/carte compacte par défaut** (les champs énergie POE/power en
détail inline ou replié), pour ne pas exploser la hauteur sur un switch 48 ports.

### Réutiliser les primitives existantes (design-system)
- **Bascule** POE équipement → `.toggle-pill` (cf. carte « Bascules »).
- **Sens** → segmenté `.rm-toggle` (choix 1/N), cf. contrôles segmentés existants.
- **Pastilles de catégorie** → `pill role-mgmt / role-data / role-power` **+ une nouvelle `role-poe`** (à
  définir : teinte hybride « data qui porte aussi de l'énergie » — suggestion : accent ambre du power
  mêlé au data, à valider en clair/sombre).
- **Champs** → `FormControls` (select, number, toggle) ; barre `.list-chrome` ; `form-field`.
- **Jauge de budget** (#C) → barre simple thématisée (états normal/avert./alerte via tokens
  `--accent`/`--warn`/`--err`) ; s'inspirer des seuils énergie (80 %).
- **Unités** : suffixe d'unité discret dans le champ (A / W) — homogène avec les champs énergie actuels.

---

## 7. Langage visuel POE (à cadrer)

- POE = **data + énergie** → sa pastille/teinte doit se **distinguer du data pur** et **évoquer le power**
  (éclair/ambre), sans se confondre avec un power « pur ». Proposer 1–2 pistes en clair ET sombre.
- Rappel de cohérence : le **câble** relié à un port POE portera l'**éclair ambre** de scène (même signal
  que les câbles power) — la teinte POE de l'éditeur doit rester cohérente avec ce signal.

---

## 8. Livrables attendus de Claude Design

1. Une **maquette de l'éditeur de port refondu** couvrant les états du §5 (au moins : data, power
   source/sink, POE PSE/PD, équipement POE off/on, jauge normale/80 %/survente, bascule verrouillée).
2. Le **bloc POE de l'équipement** (bascule + budget + jauge) intégré près des champs énergie.
3. La proposition de **teinte/pastille `role-poe`** (clair + sombre).
4. Recommandation de **layout** (ligne extensible vs carte) argumentée pour la densité (48 ports).

Sources reflétées (pour ancrer la maquette sur l'existant) :
`src-client/views/forms/EquipmentForms.ts` (portRow/renderPorts), `PortEditorControls.ts`
(powerPortControls), `src-client/domain/constants.ts` (PORT_ROLES, PORT_DIRECTIONS, POWER_PHASES),
`src-client/styles/dc-manager.css` (`.toggle-pill`, `.rm-toggle`, `.pill role-*`, `.form-field`,
`.list-chrome`), `docs/power.md` (analyse énergie).
