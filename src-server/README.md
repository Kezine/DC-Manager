# DC Manager — Backend REST (Node.js + SQLite, TypeScript)

Implémente le contrat de [`docs/rest-migration.md`](../docs/rest-migration.md).
Sert aussi le client (HTML autonome `dist/dc-manager.html`) en injectant
`window.__DCMANAGER_CONFIG__ = { mode: "api", apiBaseUrl: "/api" }` → le client passe
en mode API **sans configuration utilisateur**.

## Démarrage (dev)

```bash
# 1) builder le client (depuis DcManager/)
cd ..  &&  npm ci  &&  npm run build      # → dist/dc-manager.html

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

> ℹ️ **Pourquoi SQLite + une API aussi granulaire ?** C'est sciemment plus riche que le besoin
> actuel : le client charge aujourd'hui **tout le document d'un coup** (ni pagination ni chargement
> partiel), un simple *blob store* JSON suffirait. C'est un **socle assumé** pour les optimisations de
> *fetch* à venir (pagination, chargement partiel/paresseux, filtrage serveur, rechargement granulaire)
> sans refonte ultérieure — cf. [`docs/rest-migration.md`](../docs/rest-migration.md) § Périmètre.

## Docker (pas besoin de Node en local)

> 📘 Guide complet (lancer, logs, persistance, dépannage) : **[RUN.md](RUN.md)**.

Le `Dockerfile` (multi-stage : build du client → build du serveur) **construit
tout dans l'image**. Le plus simple :

```bash
cd src-server
docker compose up --build        # build client + serveur, démarre sur :3000
```

Puis ouvrir **http://localhost:3000** → le client démarre en **mode API**, crée/
ouvre un document, et tout est persisté dans le volume `dc-manager-data` (`/data`,
un fichier `.db` par document).

Sans `SSO_URL`, l'auth est en **mode dev** (utilisateur factice `dev`). Pour protéger
un déploiement réel, **privilégier la Basic Auth** (`BASIC_AUTH=user:pass`) : l'intégration
SSO est spécifique à un besoin personnel et **peu pertinente pour la plupart des usages**
(cf. [RUN.md](RUN.md) § Authentification). Pour quand même brancher le SSO : décommenter
`SSO_URL` dans `docker-compose.yml`.

Sans compose :
```bash
docker build -f src-server/Dockerfile -t dc-manager .   # depuis la racine DcManager/
docker run -p 3000:3000 -v dc-manager-data:/data dc-manager
```

> Healthcheck `/healthz` intégré. À aligner ensuite sur la convention **SmsControl**
> (reverse-proxy SSO, variables d'env de prod).

## Limites connues (cf. docs/rest-migration.md)
- Logique cascade/clone : **calculée côté client** (le serveur applique le lot tel
  quel). Un appel API direct ne déclenche pas les cascades → arbitrage P3/§3.
- Concurrence multi-client : pas encore d'ETag/version ni de canal live (P3).
- Undo serveur : non géré (le client désactive l'undo en mode API — à venir).
