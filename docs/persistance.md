# Persistance serveur — modèle document (JSON sur SQLite) & performance

> Décrit COMMENT le serveur REST (`src-server/`) stocke et interroge les données, POURQUOI ce modèle, et la direction
> retenue si on retouche la couche DB. Complément de [`validation.md`](validation.md) : l'intégrité vit dans la
> validation partagée, pas dans le schéma SQL.

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
la normalisation/validation sans être retirés ni rejetés (specs partielles). La colonne promue `created_date` reçoit
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
  + réécriture de `whereClause`/finder. Colonnes à indexer = les FK déjà listées dans `INDEX_SPEC` (front,
  `src-client/store/Store.ts`) — à **remonter dans `src-shared/`** pour une source unique front↔back.
