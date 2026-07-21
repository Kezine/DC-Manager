# Analyse énergie (power) — fourniture / consommation / stats

Formalise la distribution électrique : d'où vient l'énergie, combien chaque équipement consomme, et où sont les
risques (surcharge, redondance). Module pur : `PowerAnalysis` (`src-client/store/PowerAnalysis.ts`), piloté par le store
injecté (aucun DOM). UI : `PortEditorControls` (contrôles power du port + panneaux stats/warnings), piloté par `EquipmentForms`.

## Modèle

- **`Port.direction`** : `"source"` (fournit — outlet PDU, départ de tableau) | `"sink"` (consomme — inlet PSU) |
  `""` (data / non applicable). Un câble power relie une **source** à un **sink** (validation T9).
- **`Port.power_max_a`** : plafond de **courant** (A) — délivrance (source) ou rating de la PSU (sink). Les
  **capacités sont en AMPÈRES** : c'est le courant qui fait déclencher le disjoncteur.
- **`Port.phase`** : `L1`/`L2`/`L3` sur un **départ** (source) ; déduite en aval (T8 : phase ⇒ source).
- **`Equipment.power_nominal_w` / `power_max_w`** : **CONSOMMATION en WATTS** (invariant de la PSU à puissance
  constante). Le **courant se DÉDUIT** : `A = W / tension du circuit` (tension déduite de la source racine).
- **Type d'équipement `tableau`** = la **racine** (origine ; ses départs sont des sources sans amont).

## Le graphe orienté (source → sink)

Deux types d'arêtes : **câble** (source→sink) et **interne** de distribution (dans un PDU/tableau, les inlets
alimentent les outlets — le pass-through). Le sens vient de `Port.direction`, pas de `from/to` du câble.

- **Remontée** — `rootSourcesOf(port)` : on remonte source→sink jusqu'à une **source dont l'équipement n'a aucun
  inlet ALIMENTÉ** = la **source initiale** (départ de tableau). Un inlet n'est « alimenté » que s'il est câblé
  **vers une source** (`isFedSink`) — un câble sink↔sink ou vers un port sans sens ne nourrit rien.
- **Phase / tension déduites** de la racine (`deducedPhaseOf`, `deducedVoltageOf` ; défaut 230 V si l'origine n'est
  pas renseignée). La tension vient du `Network` power (kind=power) asserté sur le départ racine.
- **Descente** — `downstreamLeafSinks(source)` : consommateurs feuilles en aval (les PDU passent au travers).
  Charge d'un départ = Σ courants des feuilles (demande W / tension, **partagée sur les feeds** du consommateur).

## Statistiques & avertissements

- **Charge par départ** et **par phase** (A vs calibre) — seuil d'alerte **80 %** (`POWER_LOAD_WARN_FRACTION`).
- **`spof`** : ≥ 2 alimentations mais toutes vers la **même racine** (point unique de défaillance).
- **`origin_unknown`** : ≥ 2 feeds mais **aucune racine traçable** (sens/tableau amont manquants) — on ne prétend
  pas « même origine ».
- **`psu_uncabled`** : prise power non câblée (redondance amoindrie).
- **`psu_undersized`** : rating d'une PSU insuffisant pour la charge **max** seule (redondance non réelle).
- **`no_source`** : aucune alimentation valide (câblée vers une source).
- **`poe_over_budget`** : survente du budget POE (Σ des budgets producteurs > budget total de l'équipement).

## POE (Power over Ethernet)

Le **POE** est une **catégorie de port** (`role: "poe"`, cf. `PortRoles.isPoe`), **pas** une valeur de `kind` : le
rôle poe reste de `kind: "data"` (connecteurs RJ45 + réseaux data — l'énergie passe sur l'Ethernet). Il **participe
néanmoins aux flux d'énergie**.

- **`Equipment.poe_device`** : l'équipement fait du POE (PSE **ou** PD) — **déverrouille** la catégorie POE des ports
  (**T-POE1** : un port poe exige `poe_device`). Non désactivable tant qu'un port POE existe (**T-POE2**).
- **`Equipment.poe_budget_w`** : budget POE **TOTAL** (W) — capacité PoE de l'équipement, **partagée** par ses ports PSE.
- **`Port.poe_budget_w`** : **CAPACITÉ** du port (ce qu'il peut **fournir**), **pas une conso**. Renseignée par une
  **norme PoE** (`POE_CLASSES` : PoE 15,4 · PoE+ 30 · PoE++ 60 · PoE+++ 90 W) ou une valeur libre. Le **sens réutilise
  `Port.direction`** : `source` = **PSE** (injecteur/switch), `sink` = **PD** (caméra, borne…). ⚠ Unités : port
  **power** en **ampères** (`power_max_a`), port **POE** en **watts** (`poe_budget_w`).
- **Conso RÉELLE = celle du PD câblé** (le budget de port n'est qu'une capacité). Pour chaque port PSE, on suit le
  câble jusqu'au **port PD** (poe+sink) → son équipement → sa conso (`power_nominal_w`/`power_max_w`).
  `PowerAnalysis.poePortLoadW(psePort, useMax)` = conso du PD (0 si aucun). La puissance ainsi **tirée** d'un PSE
  (`poeSuppliedW` = Σ des consos PD) est prélevée sur ses entrées d'alim → **s'ajoute à sa conso** (`demandW`).
- **POE ≠ graphe SECTEUR** : les ports poe portent une direction mais sont **exclus** du graphe power source→sink
  (`eqPortsByDir` filtre `role !== "poe"`) — sinon un PSE serait un « départ » et un PD une charge secteur (double
  comptage). Le PoE est comptabilisé **à part** (ci-dessus).
- **Avertissements** (non bloquants, seuil visuel **80 %** `POWER_LOAD_WARN_FRACTION`) :
  - **`poe_over_budget`** — survente de l'équipement : `poeSupply()` → `{ loadW, budgetW, over }`, `loadW` = Σ consos
    MAX des PD ; `over` = charge > budget total.
  - **`poe_port_over`** — par port : le PD câblé consomme **plus que la capacité (budget) du port** PSE.
- **UI** : bloc POE de l'équipement (bascule + budget total + **jauge** de charge live) et éditeur de ports (catégorie ·
  sens PSE/PD · **norme/budget**) dans `EquipmentForms` ; la jauge = Σ consos des PD câblés / budget total. Un **câble**
  touchant un port POE porte le même **éclair ambre** de scène que les câbles power (`CableRouting.carriesPower`).

## Performance

`PowerAnalysis` mémoïse **par instance** (une instance = un rendu ; le store ne mute pas pendant un rendu) la
remontée (`rootSourcesOf`) et la charge (`sourceLoadA`) → la remontée n'est pas refaite par feuille, et
`departLoads`/`phaseLoads`/`equipmentWarnings` partagent leurs calculs.

## Restant (V2)

Contingence **N-1** (bascule de charge sur perte d'un feed) ; vraie **PDU triphasée** (mapping prise→phase, ici
les PDU sont supposées monophasées réparties sur les 3 phases au niveau des départs du tableau).
