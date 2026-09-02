# Validation & normalisation des données (code partagé)

> Garantit que toute donnée ÉCRITE dans un document respecte le schéma, **quel que soit
> le client** (l'UI packagée, ou une autre interface qui poste au serveur). Code PARTAGÉ
> front ⇄ back : la même règle vaut en saisie (UI) et à l'écriture (serveur, autorité).
> Source du code : [`src-shared/DataValidation.ts`](../src-shared/DataValidation.ts).

## 1. Pourquoi

Une règle d'intégrité **implicite** — vivant dans un commentaire du modèle (`/** FK → ports */`),
dans un constructeur d'entité ou dans un formulaire — ne protège que le chemin qui la traverse.
Un `upsert` serveur qui ne vérifie que « id présent + collection connue » laisse une interface
tierce (script, intégration) écrire n'importe quoi.

Ces règles sont donc **déclaratives et exécutables**, dans `src-shared/`, appliquées aux deux
points : **UI** (retour immédiat) et **serveur** (autorité : refus `400`).

## 2. Deux opérations, distinctes mais enchaînées

1. **Normalisation** — met l'enregistrement en forme canonique AVANT stockage : coercition
   de type (`"42"` → `42`), valeurs par défaut (`u_count` → 42), `null`-isation des vides.
   Idempotente. C'est elle qui rend une autre interface « propre » sans qu'elle connaisse
   toutes les conventions. Les specs sont COMPLÈTES : tout champ persisté est déclaré, donc
   normalisé ; seuls l'AUDIT serveur et deux legacy traversent sans être déclarés (cf. §10).
2. **Validation** — vérifie l'enregistrement normalisé et renvoie des erreurs. Ne mute pas.

Le serveur fait `record = normalize(...)` puis `errors = validate(record)` → si erreurs, `400`.

## 3. Niveaux de validation (et le contexte requis)

| Niveau | Exemple | Contexte nécessaire | Phase |
|---|---|---|---|
| **Intrinsèque** | champ requis, type, enum (`status ∈ CABLE_STATUSES`) | aucun (record seul) → **pur** | **V1** |
| **Référentiel** | `from_port_id` pointe un `ports` existant | « cet id existe-t-il ? » → résolveur injecté | V2 |
| **Invariants** | `network_id ∈ network_ids` ; `from ≠ to` | inter-champs (record seul) | V3 |

`src-shared/` reste PUR : le niveau référentiel (V2) reçoit un **résolveur injecté**
`(collection, id) => boolean` — l'UI l'adosse au `Store`, le serveur au `Repository`.

> **Piège transaction (V2)** : dans un `/transact`, un câble peut référencer un port créé
> dans le MÊME lot. Le résolveur serveur doit voir `persistées ∪ créées − supprimées` du
> lot, pas seulement les données persistées. Sinon on rejette des écritures légitimes.

## 4. Format de spécification (déclaratif)

Une `CollectionSpec` décrit les champs d'une collection :

```ts
FieldSpec = {
  type: "string" | "number" | "boolean" | "string[]" | "json",
  required?: boolean,     // absent/"" interdit
  nullable?: boolean,     // null autorisé (FK optionnelle…)
  default?: unknown,      // valeur posée par la normalisation si absent
  enum?: readonly string[], // valeurs autorisées
  min?: number,           // borne basse INCLUSIVE (number) — seul `value < min` est rejeté
  max?: number,           // borne haute INCLUSIVE (number) — seul `value > max` est rejeté
  format?: "ipv4" | "cidr" | "hostname" | "url", // format de chaîne — parseurs PARTAGÉS avec core/Ip (cf. §12 pour `hostname`, cas particuliers §10 pour `url`)
  ref?: string,           // collection cible (FK) — utilisé en V2
}
CollectionSpec = { fields: Record<string, FieldSpec> }   // + invariants[] en V3
```

> **`type: "json"`** : une STRUCTURE non exprimable par les types
> scalaires — objet value-object ou tableau d'objets (`racks.door_front`/`door_rear`,
> `datacenters.doors`, `vms.nics`). Sémantique volontairement MINIMALE : la normalisation laisse la
> valeur telle quelle (défaut posé si absente), la validation intrinsèque ne vérifie que
> présence/null (`required`/`nullable`) et « objet ou tableau, pas un scalaire ». Le CONTENU reste
> validé par les invariants (ex. « IPv4 des vNIC ») et normalisé côté client (`Normalize.rackDoor`,
> `Normalize.dcDoors`, `VmSync.normalizeNic`). Au DDL relationnel (générateur L1), un champ `json`
> devient une colonne TEXT JSON (décision D1b du cadrage migration DB).

Le **déclaratif** couvre l'essentiel ; les rares règles inter-champs deviennent des
fonctions pures (`invariants`) en V3. Les enums (`CABLE_STATUSES`, `EQUIP_DEPTHS`…) sont
repris du domaine ; un **test anti-divergence** vérifie que la spec partagée et les
constantes front restent alignées.

> ⚠️ **Une propriété de spec inconnue est une contrainte MORTE.** Le bloc `SPEC_FIELDS` est
> `as const` — indispensable, car les types `Records.*` en DÉRIVENT (`RecordOf`) — mais `as const`
> **seul ne vérifie rien** : sans annotation, TypeScript n'inspecte aucune propriété excédentaire.
> `sites.lat`/`lon` ont ainsi porté un `max:` que ni `FieldSpec` ni le moteur ne connaissaient : la
> borne était déclarée mais **inerte** (une latitude de 200 était acceptée), et se lisait pourtant
> comme appliquée. Le bloc se termine donc par `as const satisfies Record<string, Record<string,
> FieldSpec>>` : le type littéral est préservé (dérivation intacte) **et** toute propriété hors
> `FieldSpec` casse la compilation. Corollaire : ajouter une capacité de spec = déclarer le champ
> dans `FieldSpec` **et** l'appliquer dans le moteur, sinon `tsc` refuse la spec.

## 5. Forme des erreurs (contrat partagé)

```ts
ValidationError = { collection, id?, path, code, message }
// code ∈ "required" | "type" | "enum" | "min" | "max" | "format" | "ref_missing" | "invariant"
//       | "cross_entity" | "scope"
```
- **UI** : `path` → champ de formulaire (surlignage, blocage de soumission).
- **Serveur** : `400 { errors: ValidationError[] }` (autorité). Le client surface les
  erreurs serveur en notification (filet de sécurité, même sans validation UI par champ).

**Points d'application** (mêmes specs / fonctions des deux côtés via `src-shared/`) :
- **Client — formulaire** (`views/forms/LiveValidation`) : surlignage **par champ** + message
  inline à l'enregistrement (mappe le `path` de chaque `ValidationError` au contrôle DOM,
  via la même validation partagée + un `fetch` adossé au `Store` pour le référentiel/cross-entité).
  Câblé sur les formulaires d'édition principaux : baie, équipement, réseau IP, adresse IP,
  plage DHCP, réseau (logique), groupe, site, salle, câble (self-loop). Extensible aux autres
  (mapper `path → contrôle`). NB : la live n'apporte de la valeur que sur les champs à
  contrainte « libre » (texte requis, format IP/CIDR, cross-entité) ; les champs à choix
  (select) sont déjà contraints par construction.
- **Client — `Store`** (`create`/`update`/`saveBatch`, dont `updateBatch` est le cas particulier
  « updates seuls ») : normalise puis valide AVANT d'écrire ; bloque + notifie (`store.onInvalid`)
  si invalide. C'est le **SEUL garde-fou en mode FICHIER** (pas de serveur), et un filet sous la
  validation live. Le LOT (`saveBatch`) valide **contre l'état POST-lot**, en parité stricte avec
  `/transact` — cf. §8.5.
- **Serveur** (`create`/`update`/`transact`) : re-valide en **autorité** → `400` (couvre
  aussi toute interface tierce qui poste sans passer par le `Store`).

## 6. Décisions actées

- **Pas de rétro-compatibilité** : uniquement des jeux de test → on rejette directement
  en `400` (pas de phase « warn »). Les jeux non conformes sont recréés.
- **Normalisation côté serveur** : oui — pour qu'une interface tierce écrive proprement.
- **Convergence des normaliseurs (V4) — DIFFÉRÉE PAR CHOIX** : aujourd'hui deux normaliseurs
  coexistent — les **constructeurs d'entités front** (impératifs, riches : dérivations bespoke
  comme `network_id ⊆ network_ids`, `dim_mode`, `rackOrientation`…) et `DataValidator.normalizeRecord`
  (déclaratif, piloté par la spec). « Converger » = faire déléguer les constructeurs à `src-shared/`
  pour n'avoir qu'UNE normalisation (l'UI, le serveur et une interface tierce normaliseraient à
  l'identique). **Non fait, volontairement** :
  - pas de bug — le client passe par les constructeurs, le serveur normalise+valide ;
  - la divergence est déjà **empêchée par un test** (toute entité produite par un constructeur
    front satisfait la spec partagée) ;
  - bénéfice marginal : ça ferait passer une interface tierce mal formée de « rejetée avec
    message clair » (400) à « auto-corrigée en silence » — un contrat discutable ;
  - coût/risque élevés : extraire la logique impérative des 19 constructeurs (voie B : hooks
    `normalize(record)` par collection), avec risque de régression UI.

  À reconsidérer **seulement** si des interfaces tierces postent du brut et qu'on veut qu'elles
  soient aussi tolérantes que l'UI. Sinon, le rejet-avec-message-clair actuel est préférable.
  Détail complet de la réflexion : cf. l'échange « convergence des normaliseurs » (juin 2026).
- **Collections non encore spécifiées** : tolérées (pas de spec → pas de rejet) → extension
  collection par collection sans bloquer le reste.

## 7. Phasage

| V | Contenu | État |
|---|---|---|
| **V1** | spec déclarative + normalisation + validation **intrinsèque** ; pilotes `equipments`, `cables`, `racks` ; serveur `400` + filet UI | ✅ |
| **V2** | intégrité **référentielle** (FK `ref`) avec résolveur injecté **batch-aware** (`buildBatchFetcher`, qui le subsume depuis V5a) ; serveur : `Repository.exists` + résolveur par requête, `/transact` conscient du lot | ✅ |
| **V3** | **invariants** inter-champs (`CollectionSpec.invariants`, ex. câble : `from ≠ to`, réseau principal ∈ réseaux portés) + **merge des patchs partiels** côté serveur (fusion sur l'existant avant normalisation) | ✅ |
| **V4** | **convergence des normaliseurs** : les constructeurs d'entités front délégueraient à `DataValidator.normalizeRecord` (une seule normalisation) — **différée par choix** (pas de bug, divergence déjà empêchée par test, gros refactor des 19 classes pour un bénéfice marginal ; cf. §6) | 🅿️ différée |
| **V5a** | **règles cross-entité** (sens direct) : `EntityFetcher` injecté (remplace le résolveur d'existence — il le subsume), `buildBatchFetcher` conscient du CONTENU du lot ; IP ∈ CIDR de son réseau, plage DHCP ⊂ CIDR (cf. §8) | ✅ |
| **V5b** | **dépendance inverse** : `CollectionSpec.dependents` + `ChildFinder` injecté → écrire un parent re-valide ses enfants via LEURS règles cross-entité contre le nouvel état (ex. changer un `cidr` rejette si une adresse/plage en sort). Câblé sur create/update (Store + serveur) ET sur `/transact` (lecteur d'enfants conscient du lot, `buildBatchChildFinder`) | ✅ |
| **T1/T2** | règles métier supplémentaires : invariants intra-record (équipement racké ⇒ baie ; port X/Y cohérents ; brosse ⇒ baie) + cross-entité (équipement tient dans la baie ; baie dans les bornes de la salle ; port parent/agrégat même équipement) | ✅ |
| **V6a** | contraintes de **portée — unicité simple** : `ScopeRule` + `RecordFinder` injecté (recherche par champ indexé, conscient du lot via `buildBatchChildFinder`) ; `ipAddresses.address` unique (« sauf moi-même »). Câblé Store + serveur + live | ✅ |
| **V6b** | portée — relations & intervalles : **1 câble par port** (périmètre `from`/`to`), **chevauchement** de plages DHCP, **IP ∈ plage** (exclusion bidirectionnelle adresse ↔ plage). Câblé Store + serveur + live (IPAM) | ✅ |
| **V6c** | portée — **empilement de baie** : pas de collision de cellule `U:face` entre occupants (équipements rackés + rackItems + brosses), via `RackOccupancy` (réplique fidèle de `RackGeometry.mountSides`/`RackScene.occupants`) ; index `waypoints.rack_id` ajouté ; les règles `scope` reçoivent aussi `fetch` (lecture de la baie). ⚠ Une **brosse** n'occupe que la face **AVANT** (elle est ancrée au plan de montage avant et s'étend de `depth_mm` vers l'arrière — cf. `Resolver3D.brushGeom`) : la face arrière n'est protégée que par l'arithmétique de **profondeur** (V6d-brosse ci-dessous), exactement comme entre deux équipements dos à dos | ✅ |
| **T2c/V6d** | **profondeur de baie en mm** (`depth_mm` remplace l'enum full/half/quarter — migré one-shot au chargement, `Store._migrateDepths` ; l'occupation des 2 faces est DÉCOUPLÉE via `locks_u`). T2c (cross-entité) : la profondeur d'un équipement racké tient dans l'espace disponible de sa baie (marges, cavités de portes, − 100 mm de sécurité derrière porte — parité brosses). V6d (portée) : **dos-à-dos** au même U d'une baie double, somme des profondeurs ≤ espace partagé (cage + cavités). La **politique de profondeur** (profondeur extérieure, cage BORNÉE au châssis, marges avant/arrière, cavités de portes) n'est plus répliquée : elle vit dans le module PARTAGÉ `src-shared/RackDepthPolicy`, **IMPORTÉ** ici (`"./RackDepthPolicy.js"`, extension impérative) et consommé aussi par le rendu (`RackGeometry` délègue) — cf. §11 et `docs/placement.md` §6.14, qui documente les DEUX divergences arbitrées. Reste propre à la validation, et volontairement NON mutualisée : la marge de sécurité de 100 mm derrière une porte (règle de prudence, pas de géométrie — le rendu ne la retranche pas). Les enregistrements legacy (sans `depth_mm`) ne sont JAMAIS sanctionnés. Le dos-à-dos est **étendu au duo équipement ⇄ brosse** (V6d-brosse) puisqu'une brosse ne bloque plus la face arrière (cf. V6c) : la somme profondeur d'un montage ARRIÈRE + profondeur de la brosse (défaut **100 mm**, en parité avec le constructeur client `Waypoint`) au même U doit tenir dans l'espace partagé — jugée dans les DEUX sens (`RackDepth.backToBack` quand on édite l'équipement, `RackDepth.brushBackToBack` en règle `scope` de `waypoints` quand on édite la brosse) | ✅ |
| **T1c/T2d/V6e** | **équipement POSÉ sur une étagère** (`placement_mode: "tray"`, FK `tray_item_id` → rackItems kind "tray"). T1c (invariant) : mode tray ⇒ étagère référencée. T2d (cross-entité) : l'empreinte (orientation 90/270 permutée), la position (`tray_x`/`tray_y`) et la hauteur tiennent dans la boîte utile du plateau (TOUTE la réservation `u_height` moins 5 mm de réserve de tôle — `tray_u` = hauteur de la structure qui porte le plateau, pure indication de dessin). V6e (portée) : pas de **chevauchement** entre colocataires du même plateau. Géométrie du plateau = module PARTAGÉ `src-shared/TrayGeometry` (source unique consommée aussi par le rendu), **IMPORTÉ** directement dans la validation (`"./TrayGeometry.js"`, extension impérative) — cf. §11 et `docs/placement.md` §6.7 : une seule définition de la géométrie du plateau, ni réplique dans `RackGeometry`, ni injection. Cascade : supprimer l'étagère DÉTACHE les posés (retour « non placé », jamais supprimés) — et supprimer sa BAIE aussi, par RÉCURSION de la cascade (la baie supprime ses étagères, dont la règle rejoue ; cf. `docs/placement.md` §6.16) | ✅ |
| **V6h** | portée — **unicité du nom de câble** : `cables.name` UNIQUE (non vide) dans le document, post-trim, comparaison EXACTE (casse discriminante), « sauf moi-même » par `id`, conscient du lot. Nom vide toléré en multiple (des câbles sans nom restent légaux — champ non `required`). MIROIR de l'unicité du nom d'équipement V6g (même mécanisme que V6a) ; l'invariant se manifeste à la prochaine écriture d'un câble concerné (des doublons préexistants ne sont pas rejetés rétroactivement). Câblé Store + serveur (au save/import) | ✅ |
| **T12/T9b** | **intégrité énergie (direction & genre)**. T12 (`ports`, invariant) : la **direction** (source/sink) ne se déclare que sur un port d'ÉNERGIE (rôle `power` ou `poe`) — un port `data` à direction résiduelle deviendrait un faux départ/charge SECTEUR (`PowerAnalysis.eqPortsByDir` sélectionne par `direction` en n'excluant que `poe`). T9b (`cables`, cross-entité) : un câble d'énergie relie deux ports de **même genre** — power↔power ou PoE↔PoE, jamais poe↔power (sinon un port PoE fuiterait dans le graphe secteur) ; complète T9 (source↔sink). Ferment le chemin API/import ; l'UI neutralise déjà la direction au save (changement de rôle). Rôles en dur — leur source de vérité `PortRoles` vit côté CLIENT, donc hors de portée d'un fichier partagé : c'est la règle d'**ISOLEMENT** de `src-shared/` (PERMANENTE, cf. `CLAUDE.md`), et non l'interdit d'importer un autre fichier PARTAGÉ (celui-là est levé, cf. §11) ; ids stables ; rejeu au changement de rôle/direction d'un port câblé via les `dependents` ports→cables | ✅ |
| **T13** | **taille de bâtiment déclarée** (`sites.width_mm`/`depth_mm`, mm, OPTIONNELS et indissociables — invariant, même patron que `lat`/`lon`). Cross-entité sur `floors` : un plan d'étage ne peut pas DÉBORDER de son bâtiment (`anchor + dimension ≤ taille du site`, sur les deux axes) ; `dependents` sur `sites` → `floors` par `location` pour que RÉTRÉCIR un bâtiment re-valide ses étages (la contrainte tient aux DEUX bouts). **OPT-IN** : sans taille déclarée, aucune vérification — aucun document existant ne peut devenir invalide. ⚠ `floors.location` reste une CHAÎNE (jamais `ref: "sites"`) : le dépôt contient des `location` historiques sans enregistrement `sites`, que la FK ferait rejeter (V2) ; la règle est donc défensive — site introuvable ⇒ non applicable. Cf. `docs/placement.md` §6.8 | ✅ |

Pilotes initiaux (`equipments`, `cables`, `racks`) choisis pour leur richesse (types, enums,
FK, tableaux). **Couverture : TOUTES les collections, et TOUS leurs champs persistés** (spec
COMPLÈTE — cf. §10). Un test d'invariant vérifie que (a) toutes
les collections sont couvertes, et (b) l'entité par défaut de chaque constructeur front
satisfait sa spec (aucune sur-contrainte) ; le verrou de complétude
(`Tests/modules/test-spec-completude.js`) vérifie (c) qu'aucun champ du corpus de démo n'est
hors spec. Les enums repris du domaine sont gardés alignés par des tests anti-divergence.

> ⚠ **Aucun COMPTE de collections n'est écrit ici, et il ne faut pas en introduire.** Un nombre
> écrit à la main dans une doc se périme au premier ajout, en silence, et personne ne le relit.
> C'est le test d'invariant qui fait foi, pas la prose.

## 8. V5 — règles cross-entité

> Tranche **distincte** (pas un invariant de plus) : valider un enregistrement à partir des
> **données d'une autre entité**, pas seulement de ses propres champs. **V5a et V5b
> implémentées** (sens direct + fetcher batch-aware ; dépendance inverse parent→enfants sur
> create/update). Ce qui suit décrit le périmètre et les pièges traités.

### 8.1 Le besoin

Règle motrice : une adresse IP doit appartenir au sous-réseau de son réseau —
`ipAddresses.address ∈ ipNetworks[network_id].cidr`. Portée par l'UI seule
([`IpamForms.ts`](../src-client/views/forms/IpamForms.ts)), elle ne vaudrait ni en mode fichier
hors formulaire, ni au serveur, ni pour une interface tierce — d'où son passage en règle
partagée. Même famille : plage DHCP ⊂ CIDR du réseau ; `cable.from`/`to` pointant des ports
d'équipements cohérents ; etc.

### 8.2 Pourquoi c'est un niveau À PART

| Niveau | Ce que la règle peut lire | Capacité injectée |
|---|---|---|
| Intrinsèque (V1) | un champ | — |
| Invariant (V3) | plusieurs champs **du même record** | — (fonction pure `(record) => bool`) |
| Référentiel (V2) | « l'id pointé existe ? » | `EntityResolver = (coll, id) => boolean` |
| **Cross-entité (V5)** | **les CHAMPS de l'entité pointée** | `EntityFetcher = (coll, id) => Record \| null` |

Les invariants V3 sont **purs** (record seul) → ne peuvent pas lire le `cidr` du réseau. Le
résolveur V2 renvoie un **booléen** → ne donne pas accès au `cidr`. V5 a besoin d'un
**fetcher** (récupère l'enregistrement lié), donc d'une **nouvelle capacité injectée**, qui
garde `src-shared/` pur (l'UI l'adosse au `Store`, le serveur au `Repository`).

### 8.3 Forme d'une règle

```ts
// dans la spec d'une collection :
crossEntity?: Array<(record, fetch: EntityFetcher) => ValidationError | null>
// ex. ipAddresses :
(addr, fetch) => {
  const net = addr.network_id ? fetch("ipNetworks", addr.network_id) : null;
  if (!net) return null;                       // pas de réseau → la règle ne s'applique pas
  return Ip.inCidr(Ip.toInt(addr.address), Ip.parseCidr(net.cidr))
    ? null
    : { code: "cross_entity", path: "address", message: "L'adresse n'est pas dans le CIDR du réseau." };
}
```

### 8.4 Les pièges (traités)

1. **Fetcher batch-aware sur le CONTENU.** Dans un `/transact`, l'IP et son réseau peuvent
   être créés/modifiés ensemble : le fetcher renvoie le réseau **tel qu'après le lot**
   (y compris un `cidr` modifié dans ce même lot), pas l'état persisté. C'est le rôle de
   `buildBatchFetcher`, qui superpose `creates`/`updates` du lot sur le persisté — là où la
   résolution d'existence de V2 se contentait d'un booléen.
2. **Dépendance INVERSE (parent → enfants).** Changer le `cidr` d'un réseau peut faire sortir
   ses adresses/plages du sous-réseau : valider l'IP quand on touche l'IP ne suffit pas. Une
   collection déclare donc ses `dependents` — les validations à rejouer quand on touche le
   parent (`validateDependents` + `ChildFinder` injecté, `buildBatchChildFinder` pour un lot).
3. **Réutilisation Ip.** Les primitives d'adressage (`Ipv4.toInt`, `parseCidr`, `inCidr`) vivent
   dans `src-shared/DataValidation.ts`, avec les règles qui les consomment : `src-shared/` ne
   peut pas importer `core/` (règle d'ISOLEMENT, cf. §11).
4. **Coût / portée.** La dépendance inverse rend la validation O(enfants) sur une écriture de
   parent — elle n'est donc déclenchée que par les champs concernés (ex. `cidr`), via des FK
   indexées.

### 8.5 Le LOT CÔTÉ CLIENT — `Store.saveBatch` (parité stricte avec `/transact`)

Tout ce qui précède décrivait le lot **serveur**. Le client en a désormais l'exact pendant :
`Store.saveBatch(ops)` applique **créations + mises à jour + suppressions-racines en UNE
transaction adapter**, et les valide de la même façon consciente du lot. C'est le point d'entrée
d'une action d'UI qui touche plusieurs enregistrements — « Enregistrer » un équipement écrit
l'équipement, ses agrégats et ses ports d'un seul geste.

**Pourquoi ce point d'entrée existe** : sans lui, un formulaire n'avait que des écritures
unitaires. Enregistrer un switch 24 ports produisait 27 `transact`, donc 27 révisions, 27
événements SSE et 27 pas d'undo, en violation du contrat « 1 action logique de l'UI =
1 `transact()` » (`data/DataAdapter`).

**Ce que la conscience du lot débloque, concrètement** — deux règles étaient jusque-là
infranchissables en une passe et obligeaient le formulaire d'équipement à des PRÉ-PASSES
séquentielles (qui ont disparu avec elles) :

| Règle | Écritures séquentielles | Lot unique |
|---|---|---|
| **T7** — un port de `patch_panel` n'assert aucun réseau | l'équipement re-typé partait AVANT ses ports → V5b refusait ⇒ pré-passe « vider le réseau des ports persistés » | l'état POST-lot montre des ports déjà vidés ⇒ accepté |
| **T-POE1 / T-POE2** — pas de port `poe` sans `poe_device` | couper la capacité partait AVANT la rétrogradation des ports ⇒ pré-passe « role ← data, direction vidée, budget null » | même mécanisme, une seule écriture |

**L'enchaînement, identique à celui d'`api.ts`** : normaliser chaque op → valider chaque op avec
`buildBatchFetcher` / `buildBatchChildFinder` → rejouer `validateDependents` sur les parents écrits.
Le moindre échec rejette **tout** le lot, avant la moindre mutation mémoire ou réseau. Les erreurs
remontent à l'appelant en plus du `onInvalid` habituel : elles portent `collection` et `id`
(cf. §5), ce qui permet à un formulaire de **désigner la ligne fautive** au lieu d'annoncer un échec
global.

**Deux règles propres au client**, sans équivalent serveur parce qu'elles portent sur des concepts
que le serveur ne reçoit pas :

- **Fusion cascade ⇄ lot par CHAMP.** Les suppressions sont des RACINES : leur cascade est calculée
  ici (`Cascade.planMany`, un plan pour toutes les racines). Une ligne touchée par la cascade ET par
  le lot ne produit qu'**une** entrée d'`updates` — les détachements posent le socle, le patch
  explicite passe par-dessus. Une ligne à la fois mise à jour et **supprimée** par la cascade :
  la suppression gagne (l'écrire la ressusciterait, les exécuteurs appliquant deletes puis updates).
- **Filtre no-op.** Une mise à jour sans effet après normalisation est retirée du lot (même
  court-circuit qu'`update()`), y compris pour `updateBatch`, qui n'est plus qu'un lot à `updates`
  seuls. Un lot devenu vide est un **succès sans écriture** — pas un refus : `{ ok: true,
  written: 0 }`. C'est ce qui fait qu'un « Enregistrer » d'un formulaire non modifié n'émet rien.

## 9. V6 — contraintes d'unicité / portée

> Tranche **distincte** : valider un enregistrement contre l'ENSEMBLE de ses PAIRS dans un
> périmètre (« aucun AUTRE n'a la même valeur », « ne chevauche aucun autre »), pas juste
> contre une entité liée. **Implémentée** (V6a→V6h, cf. §7) : la spec porte des règles `scope`,
> exécutées côté Store, serveur et validation live. Ce qui suit décrit le mécanisme et ses pièges.

### 9.1 Les règles couvertes

- **ipAddresses** : adresse **unique** dans le document ; pas DANS une plage DHCP du réseau.
- **dhcpRanges** : pas de **chevauchement** avec une autre plage du même réseau ; pas d'IP
  statique du réseau dans l'intervalle.
- **cables** : **1 câble par port** (aucun autre câble ne référence ce port en `from` ou `to`).
- **occupants de baie** : pas de **collision de U** dans une baie (équipements rackés +
  `rackItems` + brosses, par côté front/rear).

### 9.2 Pourquoi un niveau À PART

| Niveau | Ce que la règle lit | Capacité injectée |
|---|---|---|
| Intrinsèque / invariant (V1/V3) | le record (ses champs) | — |
| Cross-entité (V5) | UNE entité liée (par id) | `EntityFetcher` |
| **Portée (V6)** | **TOUS les pairs** d'un périmètre (collection + filtre) | **`RecordFinder`** (par champ, conscient du lot) |

Le `fetch` de V5 renvoie UNE entité ; ici il faut **énumérer un ensemble**. Le `ChildFinder` de
V5b (`(collection, fkField, parentId) => record[]`) est exactement ça — une **recherche par
champ** (les champs visés sont indexés : `address`, `from_port_id`, `to_port_id`, `network_id`,
`rack_id`…). Il est **généralisé** en `RecordFinder`, et `buildBatchChildFinder` (conscient du
lot) est réutilisé tel quel.

### 9.3 Forme d'une règle

```ts
// catégorie de règle dans la spec :
scope?: Array<(record, find: RecordFinder) => { path; message } | null>
// ex. unicité d'adresse IP :
(addr, find) =>
  find("ipAddresses", "address", addr.address).some((other) => other.id !== addr.id)
    ? { path: "address", message: "Adresse déjà attribuée." } : null
```

Le wiring est **symétrique de V5b** : Store (`_byFk`) et serveur (`repo.list(where)`) pour le
finder ; `buildBatchChildFinder` pour `/transact`.

### 9.4 Les pièges (traités)

1. **« Sauf moi-même ».** En update, le record EST persisté → le finder le renvoie → la règle
   DOIT l'exclure par `id` (sinon il entre en conflit avec lui-même). En création, pas de self
   (id neuf) ; en lot, le finder conscient du lot renvoie la version post-lot → exclure par id.
2. **Périmètre multi-champs.** « 1 câble par port » = aucun autre câble en `from_port_id`
   **OU** `to_port_id` → deux recherches + union. Idem un câble peut référencer le port des
   deux côtés.
3. **Intervalles** (DHCP) : pas une égalité mais un **recouvrement** `[s1,e1] ∩ [s2,e2] ≠ ∅` →
   la règle fait le calcul d'intervalles (réutilise `Ipv4.toInt`).
4. **Empilement multi-collections** (baie) : les occupants viennent de `equipments` +
   `rackItems` + brosses (`waypoints`), par **côté** et par **plage de U**. La règle la plus
   lourde — d'où l'entrée `waypoints.rack_id` dans `INDEX_SPEC`, sans laquelle elle imposerait
   un scan à chaque écriture d'occupant.
5. **Coût.** Une recherche par écriture, sur des champs **tous indexés** ; à surveiller pour les
   très gros documents.

## 10. Champs déclarés vs traversée — doctrine

La spec est **COMPLÈTE** : **tout champ réellement persisté** d'une collection est déclaré dans
`SPEC_FIELDS`. C'est la condition de la **dérivation du DDL relationnel** (chantier migration DB,
décision D3a) : en colonnes strictes, un champ non déclaré serait **perdu à l'écriture** — et la
mesure L0 avait montré que des champs lus par la validation elle-même (`equipments.rack_u`/`rack_side`,
`ports.role`/`face_x`/`face_y`, `floors.anchor_x`/`anchor_y`, `cableBundles.fiber_count`) étaient
alors hors spec. Le mécanisme de traversée des champs inconnus subsiste (la normalisation ne retire
rien, la validation ne rejette pas l'inconnu), mais il ne couvre plus que **deux cas assumés** :

- les champs d'**AUDIT** `created_by` / `updated_by` / `created_date` / `updated_date` : posés et
  écrasés PAR LE SERVEUR (`AuditStamp`) APRÈS la validation — les déclarer n'apporterait aucune
  règle côté client ; leur traversée est éprouvée par un test dédié, et le générateur DDL (L1) les
  pose en colonnes standard ;
- deux champs **LEGACY** d'équipement, `face_image` / `face_image_rear` (ancêtres inline des FK
  `face_image_*_id`, toujours null dans les corpus) : à **PURGER** à la migration L4, pas à déclarer.

Cette complétude est **verrouillée par un test** (`Tests/modules/test-spec-completude.js`) : chaque
clé de chaque enregistrement du corpus de démo versionné doit être déclarée, aux exceptions de la
liste fermée ci-dessus (+ `id`, clé primaire posée par le générateur) — l'échec NOMME collection et
champ. Un futur champ ne peut plus redevenir passthrough en silence.

Règles de déclaration tenues lors de la régularisation (à maintenir pour tout NOUVEAU champ) :

- **Défauts et nullabilité : rien d'inventé.** La source de vérité des défauts est le
  **constructeur du modèle client** (les classes `implements Records.X`) ; quand le défaut client
  est CONDITIONNEL (ex. `equipments.dim_mode` dérivé du mode de placement, `waypoints.dc_z`,
  `racks.lmargin_mm` replié sur `mount_margin_mm`), la spec déclare `null`/`""` = « non renseigné,
  le client dérive » plutôt qu'une valeur figée. Un champ géométrique absent reste `null` — jamais
  transformé en 0 (un équipement « téléporté à l'origine » serait une corruption silencieuse).
- **Aucun `required` nouveau** (rétro-invaliderait des documents) ; `min`/`max` seulement quand la
  borne est déjà tenue par construction (clamp du constructeur client) et vérifiée sans violation
  sur les corpus.
- **`enum` seulement si l'ensemble fermé existe comme constante PARTAGÉE** (ex. `rack_side` reprend
  `RACK_OCCUPANT_SIDES`). Un ensemble fermé côté client seulement (rôles de port, `dim_mode`,
  `side_*`/`wall_*`) reste déclaré `string` — la doc du champ le signale.
- Les `*_cells` (`blocked_cells`, `roof_cells`, `floor_cells`) sont des **`string[]` ordinaires**,
  **hors `Schema.ARRAY_FIELDS`** : cette liste gouverne la sémantique des filtres `where`
  (appartenance), pas l'inventaire des tableaux.
- `ports.role` et `equipments.dim_mode` sont **dérivés côté client** mais lus par la validation →
  colonnes persistées ; la dérivation reste un comportement client (documenté dans la spec).

Cas particuliers à connaître :

- **`ipAddresses.hostname`** est déclaré `{ type: "string", trim: true, format: "hostname" }`.
  Le format `hostname` (RFC 1123 : labels alphanumériques + tirets, 1–63 car., pas de tiret en
  tête/queue, total ≤ 253, insensible à la casse, nom court OU FQDN) est STRICT : une valeur mal
  formée (espaces, `_`, accents, ponctuation) est rejetée (400 serveur / erreur UI). Le champ reste
  **optionnel** — une IP peut n'avoir aucun nom d'hôte. Aucune rétro-compatibilité n'est prévue.
- **`datacenters`** déclare, au-delà de `name`, ses dimensions, sa localisation et son placement
  d'étage (défauts alignés sur le formulaire de salle, `floor_orientation` borné à `min 0` faute
  d'enum numérique), plus deux hauteurs nullables (`height_mm`, `underfloor_mm`).
- **`vms.nics`** et **`datacenters.doors`** sont déclarés via le type `json` ;
  `datacenters.blocked_cells` en `string[]` (cf. §4).
- **`applications.url`** est déclaré `{ type: "string", default: "", trim: true, format: "url" }`.
  Le format `url` n'admet que **http/https** — une **liste blanche** de schémas, jamais une liste
  noire (une liste noire oublie toujours un schéma : `javascript:`, `data:`…) : `https?://` suivi
  d'au moins un caractère, **sans espace**, casse du schéma ignorée. La chaîne **vide** traverse
  toujours (champ optionnel : « pas d'app web »). La règle est volontairement **dupliquée** avec la
  garde de **rendu** cliente `Html.isSafeHttpUrl` (l'isolement de `src-shared/` interdit d'importer
  le module client) — duplication assumée, commentaire croisé des deux côtés (principe n°3) : le
  validateur est l'autorité d'**écriture** (un `javascript:alert(1)` est refusé à la saisie/API), la
  garde de rendu protège en plus les données **importées** jamais passées par la spec.
- **`applications.equipment_id` / `vm_id`** : deux FK nullables à **exclusivité souple** (invariant
  V3, copie d'`ipAddresses`) — un hôte OU l'autre, jamais les deux ; les deux vides restent permis.
- **`attachments.mime`** est contraint par INVARIANT à la **liste blanche PARTAGÉE**
  `Schema.ATTACHMENT_MIME_TYPES` (PDF, PNG/JPEG/WebP, ODT/ODS/DOCX/XLSX, TXT/CSV/MD — **jamais
  `text/html` ni `image/svg+xml`**, anti-XSS-stocké, même doctrine qu'`IMAGE_MIME_TYPES` ; `text/markdown`
  est du texte INERTE resservi tel quel, cf. `attachments.md` § Viewer). La règle
  est rejouée à TOUTE écriture — pas seulement à l'upload serveur : une édition de métadonnées ne
  peut pas requalifier un binaire en type interdit. Contrôlée seulement si renseignée (patron
  `contacts.email`) : l'absence relève de `required`. `attachments.equipment_id` /
  `sub_equipment_id` : exclusivité souple (copie d'`applications`) ; `size` est posée par le
  SERVEUR à l'upload (`min 0`). Cf. [`attachments.md`](attachments.md).

## 11. Collaborateurs partagés (modules que la validation IMPORTE)

Certaines règles ont besoin d'un **module métier** qui vit lui aussi dans `src-shared/` : la politique de
profondeur de baie (`src-shared/RackDepthPolicy`, règles T2c/V6d) et la géométrie d'étagère
(`src-shared/TrayGeometry`, règles T2d/V6e). `DataValidation.ts` les **IMPORTE** tous deux directement —
`import { RackDepthPolicy } from "./RackDepthPolicy.js"`, `import { TrayGeometry } from "./TrayGeometry.js"`
(extension `.js` IMPÉRATIVE — NodeNext l'exige côté serveur, cf. `CLAUDE.md` § « Code partagé »).

> **Aucun collaborateur n'est INJECTÉ dans la validation** — ni objet `collaborators`, ni port
> structurel, ni garde-fou d'échec fermé. Un point de substitution que personne n'utilise coûte à
> chaque nouvel appelant (penser à injecter, sous peine de voir la règle échouer fermé en silence).
> L'import direct rend cet oubli impossible par construction.

```ts
// La géométrie est résolue par IMPORT DIRECT, sans paramètre « collaborators » :
DataValidator.validateRecord(collection, record, fetch?, find?)
DataValidator.normalizeAndValidate(collection, record, fetch?, find?)
DataValidator.validateDependents(parentColl, parentRecord, findChildren, fetch)
// → règles : CrossEntityRule(record, fetch) · ScopeRule(record, find, fetch?)
```

> ⚠ **Ne PAS en déduire que tout import partagé est libre.** Seul l'interdit d'importer un autre fichier
> **partagé** est tombé. L'interdit d'importer **hors de `src-shared/`** (client, serveur, paquet npm) est
> **PERMANENT** — c'est la règle (1) de `CLAUDE.md` § « Code partagé front/back », vérifiée par la section
> *« shared : ISOLEMENT du dossier »* de `Tests/modules/test-shared-validation.js` (cf. `docs/placement.md`
> §6.19). Le mot « auto-suffisant » désignait les deux règles à la fois : c'est pourquoi il est banni de
> cette doc.

L'injection par interface reste un patron LÉGITIME quand le découplage se justifie sur son propre mérite
(cf. `src-shared/PowerAnalysis`, qui REÇOIT son store) — mais plus aucun collaborateur n'est injecté dans
la validation.

## 11. HORS périmètre partagé — l'APPARIEMENT de deux ports (règle CLIENT)

> ⚠ Cette règle ne vit **pas** dans `src-shared/` : elle n'est appliquée qu'au CLIENT. Elle est
> documentée ici parce que c'est là qu'un lecteur vient chercher « pourquoi l'app refuse-t-elle
> mon câble ? » — pas parce qu'elle appartiendrait au code partagé.

**La règle d'écriture n'a pas changé depuis toujours** : un câble n'est COMPLET que si sa famille et
celle de ses DEUX ports coïncident (`Store.cableCompatible`) ; sinon `cableMaxStatus` le force à
**brouillon**. Décision utilisateur du 2026-09-02, prise **contre** la recommandation d'assouplir :
un appariement fautif **reste bloqué en brouillon**, il n'est pas « autorisé après confirmation ».

**Ce qui a changé (retour terrain T3), c'est le MESSAGE et son MOMENT.** Le refus était silencieux et
différé : l'outil de traçage de route acceptait n'importe quels deux ports, et le câble se retrouvait
figé en brouillon sans que personne n'ait dit pourquoi. Deux surfaces parlent désormais — le **geste**
(`RouteTool.finish` → toast) et le **formulaire** (hint) —, à partir d'un seul verdict :
[`core/PortCompatibility`](../src-client/core/PortCompatibility.ts) (module PUR, codes jamais phrases).

Il distingue **deux échecs que l'app confondait**, en lisant enfin une donnée présente depuis le début :

| Verdict | Situation | Exemple du catalogue livré |
|---|---|---|
| `ok` | mêmes familles | SFP28 ⇄ SFP28 · FC 32G ⇄ FC 16G (familles identiques, cages différentes) |
| `aberrant` | familles différentes, **même connecteur** — ça se branche, ça ne fonctionne pas | **FC 32G ⇄ SFP28** : `family` `FC` vs `SFP28`, `connector` `SFP28` **des deux côtés** |
| `impossible` | familles ET connecteurs différents — ça ne se rencontre même pas | RJ45 ⇄ SFP28 · patch FO-SM ⇄ SFP28 |
| `unknown` | un port sans type — on ne juge pas | — |

🚨 **Le connecteur ne sert QU'À FORMULER, jamais à refuser.** Le verdict « bloque-t-on ? » ne dépend
que de la **famille**, exactement comme avant ; `connector` ne fait que choisir le libellé. C'est ce qui
rend la règle sûre sur des données réelles : les types de port sont saisis à la main, et un `connector`
vide ou fantaisiste doit dégrader le MESSAGE, jamais le comportement. La propriété est verrouillée par
test (`test-route-eligibility.js`, section « PortCompatibility »), dans les deux sens : même famille ⇒
toujours `ok` quel que soit le connecteur ; familles différentes ⇒ toujours bloqué.

⚠ **`aberrant` est le cas que T5 fera disparaître**, pas celui qu'il autorisera : le chantier
« terminaisons / transceivers » donnera aux ports une famille EFFECTIVE (celle du transceiver posé dans
la cage), et un FC 32G dans une SFP28 cessera alors d'être une contradiction — il deviendra un montage
décrit. Jusque-là, le nommer est tout ce qu'on peut faire d'utile.
