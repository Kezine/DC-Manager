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
// code ∈ "required" | "type" | "enum" | "min" | "ref_missing" | "invariant"
```
- **UI** : `path` → champ de formulaire (surlignage, blocage de soumission).
- **Serveur** : `400 { errors: ValidationError[] }` (autorité). Le client surface les
  erreurs serveur en notification (filet de sécurité, même sans validation UI par champ).

**Points d'application** (mêmes specs / fonctions des deux côtés via `shared/`) :
- **Client — `Store`** (`create`/`update`/`updateBatch`) : normalise puis valide AVANT
  d'écrire ; bloque + notifie (`store.onInvalid`) si invalide. C'est le **SEUL garde-fou
  en mode FICHIER** (pas de serveur), et un retour immédiat en mode API.
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
| **V3** | **invariants** inter-champs + convergence des normaliseurs front | ⏳ |

Pilotes V1 choisis pour leur richesse (types, enums, FK, tableaux) : ils exercent toutes
les formes de la spec avant l'extension aux 19 collections.
