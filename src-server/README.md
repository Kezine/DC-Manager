# NetMap — Backend REST (Node.js + SQLite, TypeScript)

Implémente le contrat de [`docs/rest-migration.md`](../docs/rest-migration.md).
Sert aussi le client (HTML autonome `dist/netmap.html`) en injectant
`window.__NETMAP_CONFIG__ = { mode: "api", apiBaseUrl: "/api" }` → le client passe
en mode API **sans configuration utilisateur**.

## Démarrage (dev)

```bash
# 1) builder le client (depuis NetMap/)
cd ..  &&  npm ci  &&  npm run build      # → dist/netmap.html

# 2) lancer le serveur
cd src-server
npm install                                # better-sqlite3 = module natif (compile)
cp .env.example .env                       # ajuster si besoin
npm run dev                                # tsx watch (TS direct) → http://localhost:3000
# prod : npm run build (tsc → dist/) puis npm start
```

Sans `SSO_URL`, l'auth est en **mode dev** (utilisateur factice `dev`).

## Endpoints (`/api`)

**Multi-documents** : chaque document est un workspace ISOLÉ (un fichier SQLite
par document + un registre). Les données sont scopées sous `/documents/{docId}`.

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/me` | utilisateur courant (proxy SSO) ou 401 |
| GET | `/documents` | liste des documents `{id,name,created_date,updated_date}` |
| POST | `/documents` `{name}` | crée un document (workspace vide) |
| PUT/DELETE | `/documents/{docId}` | renomme / supprime un document |
| GET | `/documents/{docId}/:collection?page=&pageSize=&q=&ids=&{champ}=` | liste paginée |
| GET/POST | `…/:collection` · `…/:collection/{id}` | lecture / création (upsert) |
| PUT/DELETE | `…/:collection/{id}` | mise à jour (upsert) / suppression |
| GET/PUT | `…/meta` | méta document |
| POST | `…/transact` | lot `{creates,updates,deletes,meta}` **atomique** (1 transaction SQLite) |
| PUT | `…/snapshot` | import complet (écrase le document) |
| GET | `…/images` · `…/images/{id}` | métadonnées (liste / une) |
| GET | `…/images/{id}/blob` | binaire de l'image |
| PUT | `…/images/{id}` | `multipart { meta:JSON, blob:file }` (crée/remplace) |
| DELETE | `…/images/{id}` | suppression |

(`…` = `/documents/{docId}`)

### Sémantique de filtrage (parité client)
- `q` : recherche plein-texte normalisée (minuscule + sans accents, `normSearch`).
- `where` (`{champ}={valeur}`) : égalité ; `null` → « non rattaché » ; champs
  tableaux (`network_ids`, `waypoint_ids`) → appartenance.
- tri par `created_date` croissant.

## Architecture (OO)
- **`Schema`** (`constants.ts`) — collections, champs-tableaux, `normSearch` (statique).
- **`Repository`** (`db.ts`) — TOUT l'accès SQLite d'UN document (CRUD, list, meta,
  transact, snapshot, images). Driver injecté (`Repository.open(file, Database)`).
- **`DocumentStore`** (`documents.ts`) — multi-documents : registre + un `Repository`
  par document (fichier SQLite isolé), ouverts à la demande et mis en cache.
- **`Api`** (`api.ts`) — couche HTTP : registre `/documents` + données scopées
  `/documents/:docId/…` (middleware → `Repository` du document).
- **`Server`** (`server.ts`) — application Express (API + service du client) ;
  `index.ts` = bootstrap (env → `DocumentStore` → `Server.listen`).

## Modèle de données
Une table SQLite par collection : `(id, data JSON, search, created_date)`. Le
serveur stocke les enregistrements bruts (le client hydrate). `meta` = 1 ligne.
`images` = `(id, meta JSON, blob, bytes)`.

> ⚠️ La liste des collections / champs-tableaux est dupliquée dans
> [`src/constants.ts`](src/constants.ts) — garder en phase avec
> `src/models/EntityRegistry.ts` et `src/data/config.ts` du client.

## Docker
Un `Dockerfile` (multi-stage : build client → serveur) est fourni comme point de
départ. Build depuis la racine `NetMap/` :

```bash
docker build -f src-server/Dockerfile -t netmap .
docker run -p 3000:3000 -v netmap-data:/data netmap
```

> À finaliser/aligner sur la convention du projet **SmsControl** (packaging,
> healthcheck, variables d'env, reverse-proxy SSO).

## Limites connues (cf. docs/rest-migration.md)
- Logique cascade/clone : **calculée côté client** (le serveur applique le lot tel
  quel). Un appel API direct ne déclenche pas les cascades → arbitrage P3/§3.
- Concurrence multi-client : pas encore d'ETag/version ni de canal live (P3).
- Undo serveur : non géré (le client désactive l'undo en mode API — à venir).
