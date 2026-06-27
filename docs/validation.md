# Validation & normalisation des données (code partagé)

> Garantit que toute donnée ÉCRITE dans un document respecte le schéma, **quel que soit
> le client** (l'UI packagée, ou une autre interface qui poste au serveur). Code PARTAGÉ
> front ⇄ back : la même règle vaut en saisie (UI) et à l'écriture (serveur, autorité).
> Source du code : [`shared/DataValidation.ts`](../shared/DataValidation.ts).

## 1. Pourquoi

Historiquement les règles d'intégrité étaient **implicites** : dans les commentaires du
modèle (`/** FK → ports */`), les constructeurs d'entités (`Normalize`), les enums du
domaine. Le serveur n'en vérifiait quasiment rien (`upsert` : id présent + collection
connue). Une autre interface (script, intégration) pouvait donc écrire n'importe quoi.

On rend ces règles **déclaratives et exécutables**, dans `shared/`, appliquées aux deux
points : **UI** (retour immédiat) et **serveur** (autorité : refus `400`).

## 2. Deux opérations, distinctes mais enchaînées

1. **Normalisation** — met l'enregistrement en forme canonique AVANT stockage : coercition
   de type (`"42"` → `42`), valeurs par défaut (`u_count` → 42), `null`-isation des vides.
   Idempotente. C'est elle qui rend une autre interface « propre » sans qu'elle connaisse
   toutes les conventions. (En V1 les specs sont PARTIELLES : seuls les champs déclarés sont
   normalisés, les autres traversent — la suppression des champs inconnus attendra des specs
   complètes.)
2. **Validation** — vérifie l'enregistrement normalisé et renvoie des erreurs. Ne mute pas.

Le serveur fait `record = normalize(...)` puis `errors = validate(record)` → si erreurs, `400`.

## 3. Niveaux de validation (et le contexte requis)

| Niveau | Exemple | Contexte nécessaire | Phase |
|---|---|---|---|
| **Intrinsèque** | champ requis, type, enum (`status ∈ CABLE_STATUSES`) | aucun (record seul) → **pur** | **V1** |
| **Référentiel** | `from_port_id` pointe un `ports` existant | « cet id existe-t-il ? » → résolveur injecté | V2 |
| **Invariants** | `network_id ∈ network_ids` ; `from ≠ to` | inter-champs (record seul) | V3 |

`shared/` reste PUR : le niveau référentiel (V2) reçoit un **résolveur injecté**
`(collection, id) => boolean` — l'UI l'adosse au `Store`, le serveur au `Repository`.

> **Piège transaction (V2)** : dans un `/transact`, un câble peut référencer un port créé
> dans le MÊME lot. Le résolveur serveur doit voir `persistées ∪ crened − supprimées` du
> lot, pas seulement les données persistées. Sinon on rejette des écritures légitimes.

## 4. Format de spécification (déclaratif)

Une `CollectionSpec` décrit les champs d'une collection :

```ts
FieldSpec = {
  type: "string" | "number" | "boolean" | "string[]",
  required?: boolean,     // absent/"" interdit
  nullable?: boolean,     // null autorisé (FK optionnelle…)
  default?: unknown,      // valeur posée par la normalisation si absent
  enum?: readonly string[], // valeurs autorisées
  min?: number,           // borne basse (number)
  format?: "ipv4" | "cidr", // format de chaîne (IPAM) — parseur PARTAGÉ avec core/Ip
  ref?: string,           // collection cible (FK) — utilisé en V2
}
CollectionSpec = { fields: Record<string, FieldSpec> }   // + invariants[] en V3
```

Le **déclaratif** couvre l'essentiel ; les rares règles inter-champs deviendront des
fonctions pures (`invariants`) en V3. Les enums (`CABLE_STATUSES`, `EQUIP_DEPTHS`…) sont
repris du domaine ; un **test anti-divergence** vérifie que la spec partagée et les
constantes front restent alignées.

## 5. Forme des erreurs (contrat partagé)

```ts
ValidationError = { collection, id?, path, code, message }
// code ∈ "required" | "type" | "enum" | "min" | "format" | "ref_missing" | "invariant"
```
- **UI** : `path` → champ de formulaire (surlignage, blocage de soumission).
- **Serveur** : `400 { errors: ValidationError[] }` (autorité). Le client surface les
  erreurs serveur en notification (filet de sécurité, même sans validation UI par champ).

**Points d'application** (mêmes specs / fonctions des deux côtés via `shared/`) :
- **Client — formulaire** (`views/forms/LiveValidation`) : surlignage **par champ** + message
  inline à l'enregistrement (mappe le `path` de chaque `ValidationError` au contrôle DOM,
  via la même validation partagée + un `fetch` adossé au `Store` pour le référentiel/cross-entité).
  Câblé sur les formulaires d'édition principaux : baie, équipement, réseau IP, adresse IP,
  plage DHCP, réseau (logique), groupe, site, salle, câble (self-loop). Extensible aux autres
  (mapper `path → contrôle`). NB : la live n'apporte de la valeur que sur les champs à
  contrainte « libre » (texte requis, format IP/CIDR, cross-entité) ; les champs à choix
  (select) sont déjà contraints par construction.
- **Client — `Store`** (`create`/`update`/`updateBatch`) : normalise puis valide AVANT
  d'écrire ; bloque + notifie (`store.onInvalid`) si invalide. C'est le **SEUL garde-fou
  en mode FICHIER** (pas de serveur), et un filet sous la validation live.
- **Serveur** (`create`/`update`/`transact`) : re-valide en **autorité** → `400` (couvre
  aussi toute interface tierce qui poste sans passer par le `Store`).

## 6. Décisions actées

- **Pas de rétro-compatibilité** : uniquement des jeux de test → on rejette directement
  en `400` (pas de phase « warn »). Les jeux non conformes sont recréés.
- **Normalisation côté serveur** : oui — pour qu'une interface tierce écrive proprement.
- **Convergence des normaliseurs** : à terme, les constructeurs d'entités front délèguent
  à `shared/normalize` (une seule normalisation). En V1, ils coexistent et un test garantit
  que les entités produites par le front **satisfont** la spec partagée (pas de divergence).
- **Collections non encore spécifiées** : tolérées (pas de spec → pas de rejet) → extension
  collection par collection sans bloquer le reste.

## 7. Phasage

| V | Contenu | État |
|---|---|---|
| **V1** | spec déclarative + normalisation + validation **intrinsèque** ; pilotes `equipments`, `cables`, `racks` ; serveur `400` + filet UI | ✅ |
| **V2** | intégrité **référentielle** (FK `ref`) avec résolveur injecté **batch-aware** (`buildBatchResolver`) ; serveur : `Repository.exists` + résolveur par requête, `/transact` conscient du lot | ✅ |
| **V3** | **invariants** inter-champs (`CollectionSpec.invariants`, ex. câble : `from ≠ to`, réseau principal ∈ réseaux portés) + **merge des patchs partiels** côté serveur (fusion sur l'existant avant normalisation) | ✅ |
| **V4** | **convergence des normaliseurs** : les constructeurs d'entités front délèguent à `shared/normalize` (une seule normalisation) — gros refactor des 19 classes, à mener à part | ⏳ |
| **V5a** | **règles cross-entité** (sens direct) : `EntityFetcher` injecté (remplace le résolveur d'existence — il le subsume), `buildBatchFetcher` conscient du CONTENU du lot ; IP ∈ CIDR de son réseau, plage DHCP ⊂ CIDR (cf. §8) | ✅ |
| **V5b** | **dépendance inverse** : `CollectionSpec.dependents` + `ChildFinder` injecté → écrire un parent re-valide ses enfants via LEURS règles cross-entité contre le nouvel état (ex. changer un `cidr` rejette si une adresse/plage en sort). Câblé sur create/update (Store + serveur) ET sur `/transact` (lecteur d'enfants conscient du lot, `buildBatchChildFinder`) | ✅ |
| **T1/T2** | règles métier supplémentaires : invariants intra-record (équipement racké ⇒ baie ; port X/Y cohérents ; brosse ⇒ baie) + cross-entité (équipement tient dans la baie ; baie dans les bornes de la salle ; port parent/agrégat même équipement) | ✅ |
| **V6a** | contraintes de **portée — unicité simple** : `ScopeRule` + `RecordFinder` injecté (recherche par champ indexé, conscient du lot via `buildBatchChildFinder`) ; `ipAddresses.address` unique (« sauf moi-même »). Câblé Store + serveur + live | ✅ |
| **V6b/c** | portée — relations & intervalles (1 câble/port, chevauchement DHCP, IP-dans-plage) ; empilement de baie (collision de U, le plus lourd) (cf. §9) | ⏳ |

Pilotes initiaux (`equipments`, `cables`, `racks`) choisis pour leur richesse (types, enums,
FK, tableaux). **Couverture étendue aux 19 collections** : chaque collection a une spec
(partielle — identité + énumérations + clés étrangères). Un test d'invariant vérifie que
(a) toutes les collections sont couvertes, et (b) l'entité par défaut de chaque constructeur
front satisfait sa spec (aucune sur-contrainte). Les enums repris du domaine sont gardés
alignés par des tests anti-divergence.

## 8. V5 — règles cross-entité (cadrage)

> Tranche **distincte** (pas un invariant de plus) : valider un enregistrement à partir des
> **données d'une autre entité**, pas seulement de ses propres champs. **V5a et V5b
> implémentées** (sens direct + fetcher batch-aware ; dépendance inverse parent→enfants sur
> create/update). Ce qui suit fixe le périmètre et les pièges traités.

### 8.1 Le besoin

Règle motrice : une adresse IP doit appartenir au sous-réseau de son réseau —
`ipAddresses.address ∈ ipNetworks[network_id].cidr`. Aujourd'hui cette règle existe, mais
**codée à la main dans l'UI** ([`IpamForms.ts`](../src/views/forms/IpamForms.ts) : IP-dans-CIDR
à la création, et sur changement de CIDR, refus si une IP/plage existante tombe dehors).
Elle n'est donc enforce ni en mode fichier hors formulaire, ni au serveur, ni pour une
interface tierce. Autres candidates : plage DHCP ⊂ CIDR du réseau ; `cable.from`/`to`
pointant des ports d'équipements cohérents ; etc.

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
garde `shared/` pur (l'UI l'adosse au `Store`, le serveur au `Repository`).

### 8.3 Forme envisagée

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

### 8.4 Les pièges à traiter (le vrai travail)

1. **Fetcher batch-aware sur le CONTENU.** Dans un `/transact`, l'IP et son réseau peuvent
   être créés/modifiés ensemble : le fetcher doit renvoyer le réseau **tel qu'après le lot**
   (y compris un `cidr` modifié dans ce même lot), pas l'état persisté. V2 résolvait
   l'existence dans le lot ; V5 doit résoudre le **contenu** (étendre `buildBatchResolver`
   en un `buildBatchFetcher` qui superpose `creates`/`updates` du lot sur le persisté).
2. **Dépendance INVERSE (parent → enfants).** Changer le `cidr` d'un réseau peut faire sortir
   ses adresses/plages du sous-réseau. Valider l'IP quand on touche l'IP ne suffit pas : il
   faut **re-valider les enfants quand on touche le parent**. C'est la logique bidirectionnelle
   déjà présente dans `IpamForms`. À porter dans `shared` (probablement : une collection
   déclare les « validations déclenchées par un parent » à rejouer).
3. **Réutilisation Ip.** La règle s'appuie sur `Ip.inCidr`/`parseCidr` (déjà partiellement
   partagés : `Ip.toInt` délègue à `shared/ipv4ToInt`). Pour V5, `inCidr`/`parseCidr` devront
   eux aussi vivre côté partagé (sinon `shared/` importerait `core/` — interdit). À extraire.
4. **Coût / portée.** La dépendance inverse rend la validation potentiellement O(enfants) sur
   une écriture de parent → borner et ne déclencher que sur les champs concernés (ex. `cidr`).

### 8.5 Recommandation de découpe

- **V5a** — sens direct seulement : IP ∈ CIDR, plage DHCP ⊂ CIDR, avec `EntityFetcher`
  batch-aware. Couvre la création/édition d'une IP/plage. Risque modéré.
- **V5b** — dépendance inverse : re-validation des enfants sur changement de `cidr`. Plus
  lourd ; à faire seulement si V5a ne suffit pas (le `cidr` change rarement).

Prérequis transverse : extraire `Ip.parseCidr`/`inCidr` vers `shared/` (principe
réutilisation > duplication), comme déjà amorcé pour `ipv4ToInt`.

## 9. V6 — contraintes d'unicité / portée (cadrage)

> Tranche **distincte** : valider un enregistrement contre l'ENSEMBLE de ses PAIRS dans un
> périmètre (« aucun AUTRE n'a la même valeur », « ne chevauche aucun autre »), pas juste
> contre une entité liée. Non implémentée — ce qui suit fixe le périmètre, le mécanisme et
> les pièges. Ces règles existent aujourd'hui codées à la main dans les formulaires/le Store.

### 9.1 Le besoin (règles « Tier 3 »)

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

Le `fetch` de V5 renvoie UNE entité ; ici il faut **énumérer un ensemble**. Bonne nouvelle :
le `ChildFinder` de V5b (`(collection, fkField, parentId) => record[]`) est déjà exactement
ça — un **recherche par champ** (les champs visés sont indexés : `address`, `from_port_id`,
`to_port_id`, `network_id`, `rack_id`…). On le **généralise** en `RecordFinder` et on
réutilise `buildBatchChildFinder` (déjà conscient du lot).

### 9.3 Forme envisagée

```ts
// nouvelle catégorie de règle dans la spec :
scope?: Array<(record, find: RecordFinder) => { path; message } | null>
// ex. unicité d'adresse IP :
(addr, find) =>
  find("ipAddresses", "address", addr.address).some((other) => other.id !== addr.id)
    ? { path: "address", message: "Adresse déjà attribuée." } : null
```

Le wiring est **symétrique de V5b** : Store (`_byFk`) et serveur (`repo.list(where)`) pour le
finder ; `buildBatchChildFinder` pour `/transact`.

### 9.4 Les pièges à traiter (le vrai travail)

1. **« Sauf moi-même ».** En update, le record EST persisté → le finder le renvoie → la règle
   DOIT l'exclure par `id` (sinon il entre en conflit avec lui-même). En création, pas de self
   (id neuf) ; en lot, le finder conscient du lot renvoie la version post-lot → exclure par id.
2. **Périmètre multi-champs.** « 1 câble par port » = aucun autre câble en `from_port_id`
   **OU** `to_port_id` → deux recherches + union. Idem un câble peut référencer le port des
   deux côtés.
3. **Intervalles** (DHCP) : pas une égalité mais un **recouvrement** `[s1,e1] ∩ [s2,e2] ≠ ∅` →
   la règle fait le calcul d'intervalles (réutilise `Ipv4.toInt`).
4. **Empilement multi-collections** (baie) : les occupants viennent de `equipments` +
   `rackItems` + brosses (`waypoints`), par **côté** et par **plage de U**. Le plus lourd.
   ⚠️ `waypoints.rack_id` **n'est pas indexé** (cf. `INDEX_SPEC`) → soit ajouter l'index, soit
   accepter un scan. C'est ce qui fait de cette règle la plus coûteuse.
5. **Coût.** Un scan par écriture. Acceptable car les champs sont indexés (sauf le cas baie) ;
   à surveiller pour les très gros documents.

### 9.5 Découpe proposée

- **V6a — unicité simple (un champ)** : `ipAddresses.address` unique. ✅ **Fait** — nouvelle
  catégorie de règle `CollectionSpec.scope` + `RecordFinder` injecté (généralisation du
  `ChildFinder`), code d'erreur `scope`, « sauf moi-même » par `id`, conscient du lot
  (`buildBatchChildFinder`). Câblé Store + serveur + live (formulaire adresse IP).
- **V6b — relations & intervalles** : 1 câble par port (multi-champs) ; chevauchement de plages
  DHCP + IP-dans-plage (intervalles). Risque moyen.
- **V6c — empilement de baie** (collision de U) : multi-collections + côtés + index manquant
  sur `waypoints.rack_id`. Le plus lourd ; à faire seulement si on veut retirer la logique
  correspondante du Store (sinon elle y reste très bien).

### 9.6 Recommandation

Commencer par **V6a** (unicité d'adresse — net, sûr, réutilise tout l'existant), puis **V6b**.
Laisser **V6c** au Store (`rackPlacementBlockedReason`) tant qu'il n'y a pas de besoin
multi-client / interface tierce sur le placement en baie.
