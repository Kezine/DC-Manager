# Persistance serveur — modèle document (JSON sur SQLite) & performance

> Décrit COMMENT le serveur REST (`src-server/`) stocke et interroge les données, POURQUOI ce modèle, et la direction
> retenue si on retouche la couche DB. Complément de [`validation.md`](validation.md) : l'intégrité vit dans la
> validation partagée, pas dans le schéma SQL.
>
> ⚠ **ÉTAT (bascule L4, 2026-07-31) : le serveur TOURNE désormais sur le schéma RELATIONNEL.**
> `DocumentStore.repo()` ouvre `RelationalRepository` (les fichiers legacy sont migrés à la première
> ouverture — backup `.pre-relationnel.bak`, cf. `src-server/RUN.md` et `LegacyMigration.ts`), et
> `api.ts`/`documents.ts` consomment le TYPE de contrat `RepositoryContract` (db.ts). Le modèle blob
> décrit ci-dessous est donc l'état D'AVANT-bascule : sa classe `Repository` (db.ts) ne survit que
> comme référence de la preuve de parité (tests L3) et disparaît au lot L5 — la RÉÉCRITURE de ce
> document (le relationnel comme état nominal) est prévue au même lot.

## Le modèle : un document JSON par enregistrement

Chaque collection est **une table SQLite** de forme uniforme (`db.ts`, `Repository.open`) :

```sql
CREATE TABLE "<collection>" (
  id TEXT PRIMARY KEY,        -- clé
  data TEXT NOT NULL,         -- le record ENTIER sérialisé (JSON.stringify)
  search TEXT,                -- plein-texte dénormalisé (recherche LIKE)
  created_date TEXT,          -- promu pour le tri
  updated_rev INTEGER         -- promu pour le verrou optimiste par entité
)
```

Seuls quelques champs **opérationnels** sont promus en colonnes (`id`, `created_date`, `updated_rev`, `search`) ;
**tous les champs métier vivent dans le blob `data`**. C'est un *document store* au-dessus de SQLite (l'équivalent de
JSONB en Postgres — SQLite l'assume nativement avec `json_extract`/`json_each`). Le `data` écrit est EXACTEMENT ce que
le front sérialise (`Store.toJSON()`) → une seule forme de sérialisation des deux côtés.

### Audit « qui / quand » (posé PAR LE SERVEUR)

Quatre champs d'audit vivent DANS le blob : `created_by` / `updated_by` (id canonique de l'auteur, cf.
[`user-resolver.md`](user-resolver.md)) et `created_date` / `updated_date`. En **mode API** le serveur en fait
**autorité** : à chaque écriture qui traverse `resolveRepo` (CRUD, `/transact`, updates de cascade d'un `DELETE`),
`api.ts` estampille le record via la classe pure `AuditStamp` AVANT `upsert` — les valeurs client sont **écrasées**
(pas d'usurpation d'auteur ni d'antidatage). `created_*` sont figés à la création et repris de l'existant ensuite ;
`updated_*` sont rafraîchis à chaque écriture. **Exception** : `PUT /snapshot` (restauration) n'estampille PAS —
l'audit du snapshot est restauré tel quel (arbitrage Q7). En **mode fichier** (aucune identité), les `_by` sont
absents et les dates restent celles du client. Ces champs étant NON DÉCLARÉS dans `DataValidation`, ils traversent
la normalisation/validation sans être retirés ni rejetés — c'est, avec deux legacy à purger, le SEUL passthrough restant
depuis la régularisation D3a (spec COMPLÈTE, cf. `docs/validation.md` §10). La colonne promue `created_date` reçoit
donc, en mode API, l'horodatage serveur.

## Pourquoi ce choix

- **Évolution de schéma sans migration.** Ajouter un champ à un modèle = il tombe dans le JSON, aucun `ALTER TABLE`.
  Le modèle bouge beaucoup ; les migrations one-shot se font EN MÉMOIRE au chargement (`Store._migrate*`).
- **Symétrie front ⇄ back.** Mode fichier = un gros JSON ; mode API = des lignes de ce même JSON.
- **Intégrité déportée dans `src-shared/DataValidation`**, rejouée à CHAQUE écriture API (`api.ts`, `accept`) : FK (V2),
  cross-entité (V5), portée/unicité (V6), dépendance inverse (V5b). La DB n'impose NI type NI FK — c'est la couche de
  validation partagée qui garantit l'intégrité. **Corollaire** : toute écriture DOIT passer par la validation (un
  `INSERT` SQL direct stockerait n'importe quoi ; la DB ne protège de rien).

## Le coût : requêtes par champ = full scan

`fetch(collection, id)` (V2/V5) = lookup sur la **clé primaire** → rapide. Mais `find(collection, field, value)` (V5b
dépendance inverse + V6 portée) filtre sur un champ DANS le JSON :

```sql
WHERE CAST(json_extract(data, '$.<field>') AS TEXT) = ?
```

`json_extract` est calculé **ligne par ligne** → **aucun index utilisable → full table scan**. C'est le chemin CHAUD :
une écriture de port déclenche plusieurs `find` (V6 unicité de brin ; `dependents` ports→câbles et cableBundles→ports),
et un save d'équipement écrit P ports. L'audit 2026-07-10 a de plus AJOUTÉ des `find` (P1 confronte les brins legacy,
P4 revalidation inverse) → chemin d'autant plus sollicité.

## Ce qui est fait (stopgap agnostique au modèle)

`Repository.findBy` (`db.ts`) sert les `find` de la validation SANS `COUNT(*)`, SANS `ORDER BY`, SANS pagination — le
finder itère l'ensemble, il n'a besoin ni du total ni d'un tri. Divise par 2 le nombre de requêtes par `find` vs
`list()`. Sûr, sans changement de stockage, et il **survit tel quel** à une refonte relationnelle.

La **cascade résiduelle** d'un `/transact` (`ApiRules.residualCascade`) calcule le lot ENTIER en **un seul** parcours
de plan (`Cascade.planMany`) au lieu d'un par suppression — c'était d'abord une correction, mais aussi la fin d'un
coût quadratique : une chaîne de 40 ports supprimée en un lot passait de 2 460 `find` à 120 (mesuré, cf.
[`placement.md` §6.17](placement.md)). Sur le chemin `/transact` d'aujourd'hui le gain en `find` est nul — les
lecteurs conscients du lot masquent déjà au plan les entités que le lot supprime — mais il se matérialise dès que
l'instantané du client est périmé, c'est-à-dire le cas même pour lequel cette cascade existe.

## Direction si on retouche la DB : RELATIONNEL (pas JSONB)

**Décision (2026-07-10)** : le jour où la couche DB est retouchée, migrer vers un **vrai modèle relationnel** (colonnes
typées + vraies FK), PAS des rustines sur le blob.

- **JSONB écarté.** SQLite embarqué = **3.49.2** (JSONB disponible, vérifié à l'exécution). Mais l'adopter = migrer le
  stockage TEXT→binaire + réécrire les chemins **read** (`JSON.parse(r.data)` casse sur un blob) et **write**
  (`jsonb(@data)`), pour un gain SECONDAIRE (extraction sans re-parse). Le vrai gain-perf est l'INDEX, pas le format.
- **Index d'expression écarté comme cible aussi.** `CREATE INDEX … ON coll (CAST(json_extract(data,'$.x') AS TEXT))`
  fonctionne (vérifié : `EXPLAIN QUERY PLAN` → `SEARCH … USING INDEX`) et donne le gros gain, MAIS il reste attaché au
  modèle JSON qu'on veut défaire → rustine jetable, pas un investissement.
- **Cible = relationnel.** L'intégrité étant DÉJÀ dans `src-shared/DataValidation`, passer à des colonnes + FK **rapatrie**
  ces invariants au niveau DB sans réinventer la logique. Chantier = schéma par collection + migration des blobs `data`
  + réécriture de `whereClause`/finder. Colonnes à indexer = les FK listées dans `INDEX_SPEC`, désormais **remonté dans
  `src-shared/RelationalSchema`** (source unique front ↔ back : le générateur ci-dessous en tire les index, le client le
  RÉ-EXPORTE via `src-client/data/config.ts`).

### Générateur de DDL relationnel (BRANCHÉ depuis la bascule L4)

Le module partagé **`src-shared/RelationalSchema`** DÉRIVE le schéma cible de la spec (`COLLECTION_SPECS`), pour ne
JAMAIS l'écrire à la main. Il expose `tableDdl(collection)`, `indexDdls(collection)` et `allDdl()`. Une table par
collection : `id TEXT PRIMARY KEY` + les champs de la spec (dans l'ordre de déclaration) + les 4 colonnes d'audit +
`search TEXT NOT NULL DEFAULT ''` + `updated_rev INTEGER NOT NULL DEFAULT 0`. Affinités : `string`→TEXT,
`number`→NUMERIC (pas REAL), `boolean`→INTEGER, `string[]`/`json`→TEXT (JSON sérialisé). `NOT NULL` uniquement sur les
champs `required`.

Ce qu'il n'émet **volontairement PAS**, et pourquoi (décisions du cadrage) : aucune **clé étrangère SQL** (D2b — la
cascade métier multi-bases de `src-shared/Cascade` et l'ordre libre des lots `transact` la doubleraient) ; aucun **CHECK
/ enum / min / max** en SQL (D6 — les règles de valeur restent l'autorité UNIQUE de la validation partagée) ; aucun
**DEFAULT SQL** sur les colonnes de spec (D3 — les défauts vivent dans la normalisation partagée, `search`/`updated_rev`
exceptés). L'index est le gain ; l'intégrité reste applicative.

### Repository relationnel (EN PRODUCTION depuis la bascule L4)

**`src-server/src/RelationalRepository.ts`** (lot L2) implémente le contrat COMPLET de `Repository` sur ce schéma
généré : même surface publique (garde structurelle compilée `assertRepositoryParity` en bas de fichier), mêmes
mécaniques (`transact` deletes→updates→creates atomique, snapshot Q7 verbatim, verrou `updated_rev`, maintenance,
meta/images repris à l'identique — hors migration). Ses contrats PROPRES, ceux des colonnes strictes :

- **Clés inconnues IGNORÉES à l'écriture** : seules les colonnes dérivées de la spec (+ `id` + audit) sont
  persistées — la spec étant COMPLÈTE (régularisation D3a), aucun champ légitime n'est perdu ; les legacy
  `equipments.face_image`/`face_image_rear` disparaissent à l'écriture (purge L4 voulue).
- **Reconstruction NORMALISÉE à la lecture** : chaque champ de la spec présent et re-typé (INTEGER 0/1 → booléen,
  TEXT JSON → tableau/objet, NULL SQL → null) ; `id` + audit inclus seulement si non-NULL (pas de clés null
  inventées) ; `search`/`updated_rev` (opérationnelles) jamais dans le record.
- **Parité `whereClause`** : égalité textuelle, sentinelle `"null"`, appartenance `json_each` sur les champs
  tableaux — MAIS l'égalité sur colonne TEXT est DIRECTE (`"col" = ?`) : c'est la condition du `USING INDEX`, un
  `CAST` transformerait la colonne en expression et forcerait le SCAN (mesuré). Le `CAST AS TEXT` du blob est
  conservé sur les seules colonnes numériques/booléennes (parité stricte : booléen filtré `"1"`/`"0"`). Un champ
  de filtre INCONNU de la spec ne rend AUCUNE ligne (`1=0`) — le « match tout » accidentel du blob sur la
  sentinelle d'un champ inconnu n'est pas reconduit (aucun émetteur réel, mesure L0 §3.3).
- **`explainFindBy`** (seule méthode hors contrat, diagnostic) rejoue l'`EXPLAIN QUERY PLAN` du SQL exact de
  `findBy` : `SEARCH … USING INDEX idx_…` sur le chemin chaud (prouvé par test, contre-épreuve SCAN incluse).

✅ **BASCULÉ (lot L4)** : `DocumentStore.repo()` ouvre cette implémentation — le client ne voit rien (même contrat
REST), `api.ts`/`documents.ts` la consomment par le type `RepositoryContract` (la surface publique de `Repository`,
seule forme à laquelle une autre classe est nominalement assignable). Les documents LEGACY sont migrés à leur
première ouverture par **`LegacyMigration`** : backup `.pre-relationnel.bak` (handle fermé + checkpoint AVANT copie,
jamais écrasé s'il préexiste), puis blob→colonnes en UNE transaction (chaque record passé par
`DataValidator.normalizeRecord` — les défauts sont posés, les legacy `face_image*` purgés — et `updated_rev`
préservée par record) ; un échec ANNULE EN BLOC (fichier resté lisible en legacy) avec une erreur qui NOMME le record
fautif — procédure d'exploitation dans `src-server/RUN.md`. La **parité corpus contre corpus est PROUVÉE (lot L3)** :
corpus de démo par les tests (`Tests/modules/test-relational-parity.js`, comparateur canonique partagé
`parity-comparator.js` — lecture, écritures, divergences de contrat ENCODÉES comme attendues) et corpus réel par une
sonde hors dépôt (0 divergence). Reste le lot L5 : retrait du chemin blob (`db.ts` + tests de parité) et réécriture
de ce document — cf. cadrage `.notes/toDos/migration-db-relationnelle-cadrage-2026-07-31.md`.
