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
  Câblé sur les formulaires pilotes (baie, réseau IP, adresse IP) ; extensible aux autres.
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
