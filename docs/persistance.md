# Persistance serveur — modèle RELATIONNEL (SQLite) & performance

> Décrit COMMENT le serveur REST (`src-server/`) stocke et interroge les données, et POURQUOI ce modèle. Un fichier
> SQLite par document ; une table par collection à **colonnes typées dérivées de la spec**. Complément de
> [`validation.md`](validation.md) : l'intégrité et les défauts vivent dans la validation/normalisation PARTAGÉES,
> pas dans le schéma SQL — le schéma apporte les **index**, pas les règles.

## Le modèle : une table à colonnes par collection

Le schéma cible n'est **jamais écrit à la main** : le module partagé **`src-shared/RelationalSchema`** le DÉRIVE de la
spec déclarative (`COLLECTION_SPECS` de `DataValidation.ts`). Il expose `tableDdl(collection)` / `indexDdls(collection)`
(et leurs agrégats `allTableDdls()` / `allIndexDdls()`, en DEUX phases — cf. « Évolution du schéma »), consommés côté
serveur par `RelationalRepository.open` (qui n'émet AUCUN DDL de collection lui-même).

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

## Évolution du schéma : ADDITIVE, à l'ouverture

**Ajouter un champ à la spec suffit : la colonne suit à l'ouverture du document.** `CREATE TABLE IF NOT EXISTS` est un
no-op sur une base existante — sans mécanisme dédié, la première évolution de spec rendrait toute base relationnelle
déjà créée inécrivable (l'upsert préparé dérive ses colonnes de la spec → `table X has no column named Y` → 400
systématique), voire INOUVRABLE si le champ entre aussi dans `INDEX_SPEC` (`CREATE INDEX` → `no such column`).

`RelationalRepository.open` exécute donc le DDL en **trois temps, dans un ordre impératif** :
**tables** (`allTableDdls`) → **colonnes de spec manquantes** (`ensureSpecColumns`) → **index** (`allIndexDdls`) —
l'index d'un champ nouvellement indexé doit trouver sa colonne. Le diff `PRAGMA table_info` ⇄ spec est produit par la
primitive PURE **`RelationalSchema.missingColumns(collection, colonnesExistantes)`** (même source de dérivation que
`tableDdl` : l'objet `fields` de la spec, même affinité de type, identifiants quotés). Pour chaque colonne manquante,
en **une transaction** pour toute la passe :

- **`ALTER TABLE … ADD COLUMN`** avec l'affinité du DDL neuf mais **SANS `NOT NULL`** (SQLite l'interdit sans DEFAULT
  sur une table peuplée, et le DEFAULT SQL est banni de ce schéma) ;
- **backfill du DÉFAUT de spec** : `UPDATE … SET col = ? WHERE col IS NULL`, valeur sérialisée EXACTEMENT comme à
  l'écriture (`toColumn` : boolean default `true` → `1`, string default `""` → `''`, tableau default `[]` → `'[]'`) —
  sans lui, la relecture rendrait `null` là où le mode fichier rend le défaut (divergence de parité). Un champ
  `nullable`/default `null` — ou historique, sans défaut — ne backfille RIEN : NULL est déjà la valeur correcte ;
- **`updated_rev` et les 4 colonnes d'audit INTACTS** par construction (l'UPDATE ne nomme que la colonne neuve) — même
  discipline que le backfill `search` : ni faux conflit 409, ni rechargement SSE induit ;
- un **log INFO par colonne ajoutée** (`collection.colonne`).

**Idempotent PAR CONSTRUCTION** : le diff pragma ⇄ spec est vide au run suivant — **pas de SCHEMA_VERSION** (le diff
EST le marqueur, comme les `ensureColumn` des bases de modules `users.db`/`notify.db`/`certs.db`…). Une base NEUVE
n'émet aucun ALTER (les tables naissent complètes). Les tables `meta`/`images` (hors spec) ne sont pas concernées.

**Ce que le mécanisme ne couvre PAS** (assumé, documenté) :

- un **nouveau champ `required`** sur une collection existante : la colonne est ajoutée quand même (sans `NOT NULL`) et
  son défaut backfillé s'il en a un, avec un **WARN** explicite — la contrainte de nullité n'est portée que par les
  tables NEUVES, et on n'INVENTE pas de valeurs pour les lignes existantes (migration à la main si le métier l'exige).
  La validation partagée reste de toute façon l'autorité (D2b) ;
- le **retrait** ou le **re-typage** d'un champ : hors périmètre. Une colonne ORPHELINE (présente en base, absente de
  la spec) est ignorée sans danger — l'upsert et le `rebuild`, dérivés de la spec, ne la nomment jamais.

Preuves : `Tests/modules/test-relational-evolution.js` (fixture « base d'avant » amputée en SQL brut, backfill des
défauts par type, ordre tables → colonnes → index via un champ indexé, idempotence, base neuve inchangée).

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
- **`explainFindBy`** (méthode publique HORS `RepositoryContract`, diagnostic — comme `upsertRaw`, cf. migration)
  rejoue l'`EXPLAIN QUERY PLAN` du SQL EXACT de `findBy` : la preuve mesurable du `SEARCH … USING INDEX idx_…` sur le
  chemin chaud (test dédié, avec contre-épreuve SCAN quand la colonne n'est pas indexée).

Les mécaniques communes (verrou optimiste `updated_rev`, `/transact` deletes→updates→creates atomique, snapshot Q7
verbatim, maintenance) sont couvertes par `test-relational-repository.js` (better-sqlite3 RÉEL).

### Le coût résiduel : COUNT et LIKE

`getOne(collection, id)` (V2/V5) = lookup sur la CLÉ PRIMAIRE → rapide ; les `find` du chemin chaud tapent désormais
un INDEX (le gain visé). Restent deux coûts assumés : la LISTE paginée fait un `COUNT(*)` sur le filtre (nécessaire au
`total` de la pagination), et la recherche plein-texte est un `search LIKE '%…%'` — non sargeable, donc un scan, mais
hors du chemin chaud de validation.

## La colonne `search` ENRICHIE : termes dérivés partagés (`src-shared/SearchTerms`)

> L'architecture COMPLÈTE de la recherche (palette Ctrl+K, scoring client, route transverse
> `GET …/search`, exécution double n°15) est décrite dans **`docs/recherche.md`** — cette section ne
> couvre que le versant PERSISTANCE : le contenu de la colonne, son invalidation et son backfill.

Depuis le lot 1 du chantier recherche/chargement (2026-08-02), la colonne `search` n'est plus un simple
`Object.values` du record : elle est calculée par le module PARTAGÉ **`src-shared/SearchTerms.ts`** —
`searchText(collection, record, fetch, find)` = valeurs PROPRES (parité stricte avec l'historique : aucun terme
d'hier n'est perdu, l'enrichissement AJOUTE) + termes **DÉRIVÉS PAR LIEN** + termes de **CATALOGUE traduits** +
**COMPOSITIONS tapables** (search-v2 : « U12 », « ét. N »/« fl. N », « 42 U », « 12 brins », « marque modèle »,
capacités/rpm — cf. `docs/recherche.md` pour le périmètre exact et ses limites assumées).

- **La spec est un RELEVÉ, pas une invention** : `SEARCH_SPECS` reprend les dérivations que le CLIENT effectue déjà
  (`GlobalSearchSources` : habillage sub/path cherché au palier 30 ; `ListConfigs.searchFields`). Ex. : équipement →
  nom de sa baie (directe OU via son étagère, 2 sauts) / salle / site (lien par le CHAMP `location`) / labels de
  groupes / noms+séries de ses sous-équipements ; câble → type + « équipement : port » des DEUX bouts (2 sauts) ;
  VM → hôte + « orpheline »/« orphan » + IPs des vNIC ; etc. Les PASTILLES (statuts, occupation) ne sont jamais
  cherchées → jamais de terme.
- **Exécution DOUBLE par construction** (principe n°15) : `termsOf`/`searchText` sont SYNCHRONES à lecteurs INJECTÉS
  (les contrats `EntityFetcher`/`ChildFinder` de la validation). Le serveur passe `getOne`/`findBy` du dépôt ; le
  corpus LOCAL de la palette (mode fichier) passe `get`/`findByField` du Store depuis le lot 2
  (`GlobalSearchSources`) — parité des termes entre les deux modes garantie par le module unique.
- **CATALOGUES fr+en** (`SEARCH_CATALOGS`) : le serveur ignore la langue de l'utilisateur → la colonne porte les DEUX
  (un spare `hdd` se trouve par « disque dur » ET « hard drive »). Seuls les catalogues RÉELLEMENT cherchés y sont
  (types d'équipement/groupe/spare, orphelinat VM). La duplication avec les locales client est ASSUMÉE et VERROUILLÉE
  par test (`test-search-terms.js` : chaque libellé d'affichage fr/en doit apparaître dans les termes partagés).
- **INVALIDATION** : les dépendances INVERSES sont DÉRIVÉES de la même spec (`SearchTerms.dependentQueries` — jamais
  une seconde table). Après CHAQUE écriture (upsert, delete, `/transact`, snapshot), un **post-pass dans la MÊME
  transaction** retrouve les dépendants par les FK INDEXÉES (chaînes à 2 sauts comprises : écrire un équipement →
  ports par `equipment_id` → câbles par `from/to_port_id`) et réécrit leur colonne par **`UPDATE … SET search = ?`
  SEUL**. Ce que ça N'AFFECTE PAS : `updated_rev` (aucun faux conflit 409), donc ni le verrou optimiste ni les
  rechargements SSE — la recherche est un DÉRIVÉ, pas une édition. Amplification bornée : renommer une baie de
  40 équipements = 1 `findBy` indexé + 40 UPDATE par clé primaire ; seuls les renommages de SITE (`location` non
  indexé sur equipments/datacenters) et de GROUPE (`group_ids` TEXT JSON) coûtent un scan — rares par nature, assumé.
  Dans un `/transact`, le post-pass court APRÈS toutes les écritures : l'ordre INTRA-LOT des creates est indifférent
  (créer une baie + un équipement qui la référence, dans n'importe quel ordre → équipement cherchable par le nom de
  la baie). `replaceSnapshot` écrit BRUT puis recalcule TOUT en seconde passe (même transaction).
- **BACKFILL `PRAGMA user_version`** : les documents antérieurs ont une colonne « pauvre » (valeurs propres seules).
  Le marqueur de version vit AU NIVEAU FICHIER (`user_version` : 0 = pré-enrichissement, `SearchTerms.SEARCH_VERSION`
  = spec courante) ; à l'ouverture (`RelationalRepository.open`), un marqueur en retard déclenche le recalcul de
  TOUTES les colonnes `search` en UNE transaction + pose du marqueur (une ligne de log info), idempotent à la
  réouverture. ⚠ Toute évolution de `SEARCH_SPECS`/`SEARCH_CATALOGS` doit INCRÉMENTER `SEARCH_VERSION`.
- **`upsertRaw`** (méthode publique HORS contrat, réservée) : écriture à colonne `search` PAUVRE, sans post-pass —
  utilisée par `LegacyMigration` (pendant la migration, les collections pas encore converties ont toujours le schéma
  blob : les `findBy` du calcul enrichi y casseraient) et par la seconde passe du snapshot. Un document fraîchement
  migré garde `user_version` 0 → l'ouverture qui suit l'enrichit par le backfill (un seul mécanisme).

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
  d'AVANT les migrations en mémoire du client) → upsert relationnel **BRUT** (`upsertRaw` : colonne `search` pauvre,
  enrichie par le backfill à l'ouverture qui suit — cf. § « La colonne `search` ENRICHIE ») avec `updated_rev`
  **préservée record par record** (sinon le verrou optimiste repartirait de zéro), enfin `DROP TABLE …__legacy`. La
  normalisation préserve id/audit/clés inconnues, l'upsert relationnel ignore les clés hors spec — c'est là la purge
  des legacy `face_image*`.
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
