# NetMap — Concept « patch panel » / fibres groupées : propositions (à discuter)

> Réflexion + propositions de modèle. **Rien n'est implémenté.** But : décider d'une direction
> avant de coder.

## ✅ DÉCISION (retour utilisateur)
**Direction retenue = Proposition A (bundle = groupe de brins 1:1).** Précisions :
- Le **bundle a un NOM** = le label utile sur **99 % de son tracé** (`cableBundles.name`).
- Les brins d'un bundle sont **dessinés ENSEMBLE / rapprochés** le long de la route du trunk.
- **Le trunk est créé À L'AVANCE** comme objet de 1re classe : on saisit **nom + type + nombre de
  brins** (`fiber_count`). Pas d'extrémités déclarées (elles découlent des ports des brins).
- **Le TYPE du trunk CONDITIONNE le type des câbles** qu'on peut lui associer : un câble associé à un
  trunk **prend le type du trunk** et **ne peut plus le redéfinir** (type verrouillé). `fiber_count` =
  **plafond** du nombre de brins (capacité).

Modèle retenu = « **trunk = groupement** » (pas de panels pré-déclarés). Associer un câble à un trunk
dans le formulaire câble : sélecteur « Faisceau / Trunk » → fixe `bundle_id`, **force + verrouille le
type**, attribue le prochain `strand_no` libre, hérite route + longueur du trunk.

Spécification du **comportement au câblage** ci-dessous.

## Comportement au CÂBLAGE (proposition A — spéc.)

**Répartition des données — bundle = PHYSIQUE/partagé, brin = LOGIQUE/propre :**
- **Bundle (trunk)** porte : **nom** (label sur 99 % du tracé), **type de fibre** (connecteur/medium),
  **capacité** `fiber_count`, **route** (`waypoint_ids` partagés), **longueur**, ses **2 panels
  d'extrémité**.
- **Brin (strand)** porte : ses **2 ports** (`from/to`, sur les deux panels), son **réseau/VLAN**, son
  **statut**, son **n° de fibre** (`strand_no`). Il **HÉRITE** route + longueur + type du bundle (non
  édités sur le brin).

**Un brin = un câble 1:1 normal**, donc on réutilise le moteur existant :
- Invariant inchangé : **≤ 1 câble par port** → 1 fibre par adaptateur (panel 12 ports = 12 brins/face).
- `cableRoute` / `cableMaxStatus` réutilisés, mais lisant la **route EFFECTIVE** (= celle du bundle si
  le câble est un brin) : *brouillon* (assignation incomplète OU route du trunk invalide) → *planifié*
  (route valide, panels pas encore posés admis = prévisionnel) → *câblé* (les 2 panels posés en salle).
- Compatibilité des 2 ports inchangée (même famille) ; type = celui du trunk.

**Contrainte d'extrémités** : un brin relie un port de **panel1** à un port de **panel2** (les 2 bouts du
trunk) — c'est ce qui le rend « DANS le trunk ». Un câble panel↔switch = **jarretière** = câble
**autonome** (`bundle_id = null`), pas un brin.

**Édition de la route UNE SEULE FOIS** : on édite waypoints/exits/OOB **sur le bundle** → tous les brins
suivent (plus de N routes à maintenir). Longueur idem (du trunk, partagée).

**Workflow** : (1) **+ Trunk** (nom, type fibre, nb fibres, panel1 ↔ panel2, route) ; (2) **affecter les
brins** via une grille « fibre 1..N » (port A panel1 + port B panel2 ; occupation 7/12), ou depuis un
port de panel en 3D (« raccorder via trunk T ») ; (3) **réseau/statut par brin** (indiv. ou en lot) ;
(4) **jarretières** = câblage normal existant.

**Rendu** : le trunk affiche son **nom une fois** + occupation (7/12) ; les brins **rapprochés** le long
de la route (léger décalage pour les distinguer), chacun sa couleur de réseau.

**« Un panel sert plusieurs câbles »** : les brins d'un panel peuvent venir de **bundles différents**
(chaque brin a son `bundle_id`) → naturel. ✓

**Suppression d'un trunk** : ses brins sont **détachés** (→ jarretières autonomes, perdent la route
partagée) **ou** supprimés — au choix, avec confirmation.

**Décisions — état :**
- ✅ Trunk **créé à l'avance** (nom + type + `fiber_count`). *(confirmé)*
- ✅ **Type du trunk verrouille** le type des brins (un câble associé ne peut plus changer de type). *(confirmé)*
- ✅ `fiber_count` = **capacité/plafond** ; brins créés **à la demande**. *(confirmé)*
- ✅ **Pas d'extrémités pré-déclarées** : trunk = groupement, extrémités = ports des brins. *(retenu)*
- ◻ Route **strictement héritée** du trunk (éditée une fois sur le trunk), non éditable par brin → **défaut oui**.
- ◻ **Réseau & statut par brin** → **défaut oui**.
- ◻ Longueur **du trunk, partagée** → **défaut oui**.

---


## Le besoin (reformulé)
1. Un **patch panel** expose des ports qui se câblent en **fibres** ; plusieurs fibres peuvent être
   **groupées dans un même « câble »** (un câble physique multi-fibres = un trunk).
2. Un même patch panel **sert des fibres provenant de PLUSIEURS câbles** (il agrège des fibres de
   trunks différents).

## Modèle actuel (rappel, v73)
- **`cables` = strictement 1:1** : `from_port_id ↔ to_port_id`, **au plus 1 câble par port**
  (`store.cableOnPort`). Un câble porte : type, réseaux, **route** (waypoint_ids), longueur, statut.
- **`ports`** : `equipment_id, port_type_id (famille/connecteur), role, aggregate_id` (LAG),
  **breakout** `parent_port_id` + `lane` (un trunk transceiver QSFP → N lanes SFP ; le trunk ne porte
  pas de câble, chaque lane porte un câble 1:1).
- **`EQUIPMENT_TYPES`** = liste FERMÉE (switch, serveur, caisson, pc, imprimante, ap, autre) — **pas**
  de type « patch panel ».
- Précédents de **groupement** déjà présents : `aggregate_id` (LAG de ports), `parent_port_id/lane`
  (breakout). Le problème « trunk multi-fibres » est le même besoin de groupement, mais **au niveau du
  CÂBLE** (un câble physique qui contient N liens), pas du port.

## Vocabulaire fibre (pour cadrer)
- **Brin / fibre (strand)** : 1 fibre = 1 lien entre 2 terminaisons.
- **Trunk / câble multi-fibres** : N brins partageant **un même cheminement physique** (ex. 12F/24F),
  typiquement tiré entre deux **patch panels** (ou points d'épissure).
- **Jarretière (patch cord)** : court câble (1 brin ou 1 paire duplex) du **front** d'un panel vers un
  équipement actif.
- **Patch panel** : boîtier **passif**. Arrière = terminaisons trunk/épissure ; avant = adaptateurs pour
  jarretières ; intérieur = correspondance 1:1 arrière↔avant.
- **Cross-connect** : on prolonge un circuit en jarretièrant le front d'un panel A au front d'un panel B.

---

## Proposition A — « Bundle » = groupe de brins 1:1  ★ RECOMMANDÉE (risque faible)
Garder `cables` en 1:1 (chaque **brin** reste un câble 1:1) et ajouter une couche de **groupement**.

**Schéma (delta) :**
- Nouvelle collection **`cableBundles`** (le trunk) :
  `{ id, name, cable_type_id, fiber_count (capacité), waypoint_ids (ROUTE partagée), length_m,
     from_equipment_id?, to_equipment_id? (les 2 panels, option), description }`
- **`cables`** gagne : `bundle_id` (FK → cableBundles ; null = câble/jarretière autonome) +
  `strand_no` (1..fiber_count). Un brin reste un câble **1:1** (ses 2 ports = ports de panels), mais
  sa **route/longueur sont HÉRITÉES du bundle** (surchargeables).

**Couvre le besoin :**
- « fibres groupées dans un même câble » → un **bundle** de N brins. ✓
- « un panel sert des fibres de plusieurs câbles » → les ports d'un panel portent des brins de
  **bundles différents** (chaque brin a son `bundle_id`). ✓ (tombe naturellement)

**Rendu :** dessiner le **bundle UNE fois** le long de sa route (trait épais + libellé « Trunk 12F ·
7/12 utilisés ») au lieu de 12 traits superposés ; éditeur de bundle listant les brins.

**Pour :** réutilise `cables` (statut / réseaux / route **par brin**), **petit delta de schéma**,
compatible avec `cableRoute`/`resolvePort3D` (un brin se résout comme un câble), invariant 1‑câble/port
conservé. **Contre :** nouveau concept « bundle » + son UI ; décider de l'héritage de route.

## Proposition B — Câble multi-liens (un `cable` porte N liens)
`cables.links = [{ from_port_id, to_port_id, strand_no, network_ids, status }]` → **1 câble = 1 câble
physique multi-fibres**.

**Pour :** « un objet câble = un câble physique » colle au mental ; route/longueur intrinsèquement
partagées. **Contre :** **réécriture lourde** — tout lit `from_port_id/to_port_id`, `cableOnPort`,
`cableRoute`, `resolvePort3D`, rendu, statut, l'invariant 1:1. La jarretière simple devient un cas N=1.
**Risque/effort élevés** (touche le cœur du câblage).

## Proposition C — Patch panel « pass-through » (cross-connect / traçage de circuit) — COMPLÉMENTAIRE
Orthogonale à A/B : modéliser la **continuité logique** à travers les panels passifs.
- Nouveau type d'équipement **`patch_panel`** (passif : pas d'alim ; ports = adaptateurs fibre ;
  avant/arrière).
- Les ports vont par paires avant/arrière avec **correspondance interne 1:1** (`Port.passthrough_id`
  ou appariement front/rear).
- Un **circuit** = la chaîne câble → pass-through panel → câble … de A à B. Permet de **tracer** le
  trajet réel d'une fibre à travers plusieurs panels (« ce port est patché vers ce serveur via le panel
  X brin 7 + jarretière »).

**Pour :** colle à la réalité (panels = brassage passif) ; trace bout‑à‑bout ; répond à « où finit cette
fibre ? ». **Contre :** nouveau concept de lien interne ; interagit avec route/statut.

---

## Recommandation — plan par étapes
1. **Type d'équipement `patch_panel`** (passif : sans alim ; ports = adaptateurs fibre avant/arrière ;
   icône dédiée). Brique de base, faible risque.
2. **Proposition A (bundles)** pour les trunks multi-fibres — réponse directe aux deux besoins.
3. **Plus tard, Proposition C (pass-through)** pour le traçage de circuit bout‑à‑bout entre panels.

Garder le **breakout** existant (`parent_port_id/lane`) pour les **transceivers** (QSFP→SFP, MPO→LC au
niveau d'un module) ; utiliser les **bundles** pour les **câbles trunk** entre panels. (Les deux peuvent
coexister : un MPO peut être vu comme un breakout de connecteur OU une fonction de panel — à trancher.)

## Questions ouvertes (pour décider)
- **Granularité par brin** : chaque fibre a-t-elle son propre réseau / statut / libellé (→ A ou B le
  permettent), ou le trunk est-il atomique (tous les brins identiques) ?
- **Duplex vs simplex** : un lien fibre = 1 brin, ou une **paire TX/RX** (LC duplex) ? (impacte
  `strand_no` et la notion de port duplex).
- **Continuité physique** : faut-il tracer brin→brin **à travers** un panel (épissure / cross-connect,
  Proposition C), ou suffit-il de savoir « quel trunk alimente ce port » (A seule) ?
- **MPO** : éclatement 1 MPO → 12 LC = fonction de **panel** ou **câble breakout** ? (recoupe le
  breakout existant).
- **Rendu 3D/2D** : un bundle a-t-il sa propre route dessinée **une fois** (brins masqués par défaut,
  dépliables) ? Compteur d'occupation (7/12) sur le trait ?
- **Capacité & occupation** : gérer une **capacité** de bundle (fiber_count) et l'occupation des brins
  (libres/affectés), comme les U d'un rack ?

## Impact estimé (ordre de grandeur)
- Type `patch_panel` : **faible** (ajout à EQUIPMENT_TYPES + icône + éventuelles contraintes passives).
- Proposition A : **moyen** (collection + 2 champs sur `cables` + éditeur de bundle + rendu groupé +
  héritage de route ; le câblage 1:1 existant reste valide).
- Proposition B : **élevé** (refonte du cœur câblage).
- Proposition C : **moyen-élevé** (liens internes + moteur de traçage de circuit).
