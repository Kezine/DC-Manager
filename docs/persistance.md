# Persistance serveur — modèle RELATIONNEL (SQLite) & performance

> Décrit COMMENT le serveur REST (`src-server/`) stocke et interroge les données, et POURQUOI ce modèle. Un fichier
> SQLite par document ; une table par collection à **colonnes typées dérivées de la spec**. Complément de
> [`validation.md`](validation.md) : l'intégrité et les défauts vivent dans la validation/normalisation PARTAGÉES,
> pas dans le schéma SQL — le schéma apporte les **index**, pas les règles.

## Le modèle : une table à colonnes par collection

Le schéma cible n'est **jamais écrit à la main** : le module partagé **`src-shared/RelationalSchema`** le DÉRIVE de la
spec déclarative (`COLLECTION_SPECS` de `DataValidation.ts`). Il expose `tableDdl(collection)`, `indexDdls(collection)`
et `allDdl()`, consommés côté serveur par `RelationalRepository.open` (qui n'émet AUCUN DDL de collection lui-même).

Chaque collection est **une table** de la forme (`tableDdl`) :

```sql
CREATE TABLE "<collection>" (
  id TEXT PRIMARY KEY,                 -- clé
  "<champ de spec>" <affinité> [NOT NULL],   -- un par champ, DANS L'ORDRE DE DÉCLARATION de la spec
  …
  created_by  TEXT, updated_by  TEXT,  -- audit (posé serveur, cf. plus bas) — NON déclaré dans la spec
  created_date TEXT, updated_date TEXT,
  search TEXT NOT NULL DEFAULT '',     -- plein-texte dénormalisé (recherche LIKE)
  updated_rev INTEGER NOT NULL DEFAULT 0   -- révision du dernier écrit (verrou optimiste par entité)
)
```

- **Affinités** (`RelationalSchema.sqlType`) : `string`→TEXT ; `number`→**NUMERIC** (jamais REAL — préserve les
  entiers exacts) ; `boolean`→INTEGER (0/1) ; `string[]` et `json`→TEXT (structure sérialisée JSON).
- **`NOT NULL`** est posé **UNIQUEMENT** sur les champs `required` de la spec — on n'invente aucune contrainte de
  nullité. Les 4 colonnes d'audit sont TEXT nullable ; `search`/`updated_rev` sont les seules à porter un DEFAULT SQL
  (ce sont des colonnes OPÉRATIONNELLES, hors normalisation métier).
- **Ordre des colonnes DÉTERMINISTE** (id, champs de spec, audit, `search`, `updated_rev`) : les tests golden
  (`test-relational-schema.js`) en dépendent, et l'upsert préparé s'y adosse.

### Les index : `INDEX_SPEC`, source unique front ⇄ back

`indexDdls` émet un `CREATE INDEX idx_<collection>_<champ>` pour chaque champ de **`INDEX_SPEC`**
(`src-shared/RelationalSchema`), la liste PARTAGÉE des colonnes du **chemin chaud** — **37 index** au total. C'est le
même `INDEX_SPEC` que le client RÉ-EXPORTE via `src-client/data/config.ts` pour ses propres index mémoire
(`Store._byFk`) : une seule déclaration gouverne l'indexation des deux côtés. Sont indexées les **FK / identités**
interrogées par les `find` de la validation (dépendance inverse V5b, portée/unicité V6 — `equipments.name`,
`cables.name`, `ports.equipment_id`, `ipAddresses.address`…). Un champ **`string[]`/`json`** est ÉCARTÉ de
l'indexation SQL (colonne TEXT JSON : l'appartenance passe par `json_each`, hors chemin chaud) — indexé élément par
élément côté client seulement.

### Ce que le schéma N'IMPOSE PAS (délibérément)

L'intégrité reste **applicative**, dans `src-shared/DataValidation` (rejouée à CHAQUE écriture API — cf. plus bas). Le
générateur n'émet donc VOLONTAIREMENT ni FK, ni CHECK, ni DEFAULT métier :

- **Aucune clé étrangère SQL** (décision D2b du cadrage) : la cascade métier MULTI-bases de `src-shared/Cascade` et
  l'ordre libre des lots `/transact` la doubleraient (et la contrediraient — un `/transact` applique deletes puis
  updates, un update peut cibler une ligne que le même lot vient de supprimer, résurrection par upsert).
- **Aucun CHECK / enum / min / max SQL** (D6) : les règles de VALEUR restent l'autorité UNIQUE de la validation
  partagée (une double définition dériverait en silence).
- **Aucun DEFAULT SQL** sur les colonnes de spec (D3) : les défauts vivent dans la NORMALISATION partagée
  (`DataValidator.normalizeRecord`) — `search`/`updated_rev` exceptés (opérationnels).

**Corollaire** : toute écriture DOIT passer par la validation. Un `INSERT` SQL direct stockerait n'importe quoi ; la
DB ne protège de rien. L'index est le gain ; l'intégrité reste au-dessus.

### Audit « qui / quand » (posé PAR LE SERVEUR)

Quatre champs d'audit vivent dans des colonnes : `created_by` / `updated_by` (id canonique de l'auteur, cf.
[`user-resolver.md`](user-resolver.md)) et `created_date` / `updated_date`. En **mode API** le serveur en fait
**autorité** : à chaque écriture qui traverse `resolveRepo` (CRUD, `/transact`, updates de cascade d'un `DELETE`),
`api.ts` estampille le record via la classe pure `AuditStamp` AVANT `upsert` — les valeurs client sont **écrasées**
(pas d'usurpation d'auteur ni d'antidatage). `created_*` sont figés à la création et repris de l'existant ensuite ;
`updated_*` rafraîchis à chaque écriture. **Exception** : `PUT /snapshot` (restauration) n'estampille PAS — l'audit du
snapshot est restauré tel quel (arbitrage Q7). En **mode fichier** (aucune identité), les `_by` sont absents et les
dates restent celles du client — le dépôt ne fait alors apparaître AUCUNE colonne d'audit null dans le record relu.
Ces champs sont NON déclarés dans la spec (passthrough assumé) mais sont des colonnes standard du schéma cible.

## Le dépôt : `RelationalRepository`

**`src-server/src/RelationalRepository.ts`** implémente le contrat **`RepositoryContract`** (`db.ts`) sur ce schéma. Le
`implements` fait du COMPILATEUR le garde de conformité de la surface publique — `documents.ts`/`api.ts` ne dépendent
que du TYPE de contrat, jamais d'une classe concrète, de sorte que le choix d'implémentation reste interne à
`DocumentStore.repo()`. Les contrats PROPRES aux colonnes strictes :

- **Clés inconnues IGNORÉES à l'écriture** : seules les colonnes dérivées de la spec (+ `id` + audit) sont
  persistées — la spec étant COMPLÈTE (régularisation D3a, verrou `test-spec-completude.js`), aucun champ légitime
  n'est perdu ; les legacy `equipments.face_image` / `face_image_rear` disparaissent à l'écriture (purge voulue).
- **Reconstruction NORMALISÉE à la lecture** (`rebuild`) : chaque champ de la spec présent et RE-TYPÉ d'après elle
  (INTEGER 0/1 → booléen, TEXT JSON → tableau/objet via `JSON.parse`, NULL SQL → null) ; `id` + audit inclus SEULEMENT
  si non-NULL (pas de clés null inventées) ; `search`/`updated_rev` (opérationnelles) JAMAIS dans le record. Le
  re-typage est CRITIQUE : un booléen relu `1` brut casserait les `===` du client et la validation (piège du cadrage).
- **Filtres `whereClause`** (parité de sémantique avec l'ancien blob) : égalité TEXTUELLE, sentinelle `"null"` = non
  rattaché, appartenance aux champs tableaux via `json_each` (0 ligne sur colonne NULL). Deux décisions propres aux
  colonnes strictes :
  - un champ de filtre **INCONNU** de la spec → AUCUNE ligne (`1=0`). (Aucun émetteur réel ne dépendait du « match
    tout » accidentel de l'ancien modèle sur la sentinelle d'un champ inconnu — mesure L0 §3.3 : les filtres émis
    portent tous sur des champs d'`INDEX_SPEC`.)
  - l'égalité ne **CASTe que les colonnes NON-TEXT**. Sur une colonne TEXT, `"col" = ?` (l'argument HTTP arrive déjà
    en string) est une comparaison texte-à-texte — et c'est **la condition du gain** : `CAST("col" AS TEXT)` est une
    EXPRESSION, le planificateur n'utilise alors JAMAIS l'index (mesuré : SCAN au lieu de `SEARCH … USING INDEX`, la
    raison d'être du chantier s'évaporerait). Les colonnes NUMERIC/INTEGER (nombres, booléens — aucune indexée)
    GARDENT le CAST pour une comparaison stricte (booléen filtré `"1"`/`"0"`, `"42.0"` ne matche pas `42`).
- **`findBy` lean** : les `find` de la validation (V5b/V6) renvoient TOUTES les lignes correspondantes, SANS
  `COUNT(*)`, SANS `ORDER BY`, SANS pagination — le finder itère l'ensemble, il n'a besoin ni du total ni d'un tri.
  C'est le chemin CHAUD (un save de port déclenche plusieurs `find` V6/dependents ; un save d'équipement écrit P
  ports). Le SQL exact est factorisé (`findBySql`) pour que la preuve porte sur ce qui s'exécute vraiment.
- **`explainFindBy`** (seule méthode publique HORS `RepositoryContract`, diagnostic) rejoue l'`EXPLAIN QUERY PLAN` du
  SQL EXACT de `findBy` : la preuve mesurable du `SEARCH … USING INDEX idx_…` sur le chemin chaud (test dédié, avec
  contre-épreuve SCAN quand la colonne n'est pas indexée).

Les mécaniques communes (verrou optimiste `updated_rev`, `/transact` deletes→updates→creates atomique, snapshot Q7
verbatim, maintenance) sont couvertes par `test-relational-repository.js` (better-sqlite3 RÉEL).

### Le coût résiduel : COUNT et LIKE

`getOne(collection, id)` (V2/V5) = lookup sur la CLÉ PRIMAIRE → rapide ; les `find` du chemin chaud tapent désormais
un INDEX (le gain visé). Restent deux coûts assumés : la LISTE paginée fait un `COUNT(*)` sur le filtre (nécessaire au
`total` de la pagination), et la recherche plein-texte est un `search LIKE '%…%'` (dénormalisé à l'écriture par
`searchText`, `Schema.normSearch` sur toutes les valeurs) — non sargeable, donc un scan, mais hors du chemin chaud de
validation.

## La migration legacy : `LegacyMigration`

Les documents créés AVANT la bascule sont au modèle blob historique (`(id, data JSON, search, created_date,
updated_rev)` par collection). **`src-server/src/LegacyMigration.ts`** les convertit, appelée par
`DocumentStore.repo()` AVANT chaque ouverture relationnelle — le déclencheur est le premier accès au document (en
pratique le boot du serveur pour les documents actifs).

- **Détection** : `PRAGMA table_info` — une table portant une colonne `data` est LEGACY. Base absente/neuve ou déjà
  migrée → no-op (idempotence PAR CONSTRUCTION : après migration, plus aucune colonne `data`).
- **Backup AVANT TOUT** : checkpoint TRUNCATE + fermeture du handle (le `-wal` rapatrié dans le `.db` → backup
  AUTO-SUFFISANT ; fermeture obligatoire, sinon EBUSY à la copie sous Windows), puis
  `copyFileSync(file, file + ".pre-relationnel.bak")`. Un `.bak` DÉJÀ présent n'est **JAMAIS écrasé** (le premier état
  d'avant-chantier est le plus précieux).
- **Migration en UNE transaction** : par collection, `ALTER TABLE … RENAME TO …__legacy`, DDL neuf
  (`RelationalSchema`), lecture SQL BRUTE de `id, data, updated_rev` (aucune dépendance à une classe de dépôt), puis
  pour chaque record `JSON.parse(data)` → `DataValidator.normalizeRecord` (pose les DÉFAUTS — un blob peut dater
  d'AVANT les migrations en mémoire du client) → upsert relationnel avec `updated_rev` **préservée record par record**
  (sinon le verrou optimiste repartirait de zéro), enfin `DROP TABLE …__legacy`. La normalisation préserve
  id/audit/clés inconnues, l'upsert relationnel ignore les clés hors spec — c'est là la purge des legacy `face_image*`.
- **Échec** : toute exception d'un record est ENRICHIE de `collection/id` du fautif (l'erreur SQL brute ne nomme que la
  colonne) et la transaction s'annule EN BLOC — le fichier reste LISIBLE en legacy, le `.bak` est là. Marche à suivre
  d'exploitation : [`src-server/RUN.md`](../src-server/RUN.md).

## `meta` et `images` : HORS migration

Deux tables échappent au modèle relationnel (cadrage §1), DDL et mécanique repris à l'identique :

- **`meta`** (`id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT`) : le sac `meta` du document, un unique blob JSON.
- **`images`** (`id TEXT PRIMARY KEY, meta TEXT, blob BLOB, bytes INTEGER`) : les binaires de façade + leurs
  métadonnées. La révision de cache-busting (`?v=`) n'est incrémentée que quand un NOUVEAU blob arrive (une édition de
  méta seule ne bump pas — sinon un remplacement par un fichier de MÊME taille laisserait la texture navigateur
  périmée). La `maintenance()` purge les images ORPHELINES (référencées par aucun `equipments.face_image_*_id`) puis
  compacte (checkpoint TRUNCATE + optimize + VACUUM).

## Historique (bref)

Le serveur a d'abord porté un **modèle blob JSON** (2026-07) : une colonne `data TEXT` par ligne stockant le record
entier, interrogée par `json_extract` — simple, mais un `find` par champ = **full table scan** (aucun index
utilisable), sur le chemin chaud de la validation. La **cible RELATIONNELLE** (décision 2026-07-10 : colonnes + index,
PAS de rustine JSONB) a été livrée le **2026-07-31** en lots L0→L5 (mesure du coût, générateur de DDL partagé, dépôt
relationnel, preuve de parité, bascule, retrait du blob). La **parité de comportement blob ⇄ relationnel a été PROUVÉE
corpus contre corpus** (corpus de démo par les tests, corpus RÉEL par une sonde hors dépôt : 0 divergence) AVANT le
retrait du modèle blob. Le détail des lots vit dans l'historique git et le cadrage
`.notes/toDos/migration-db-relationnelle-cadrage-2026-07-31.md`.
