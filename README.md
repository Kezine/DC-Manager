# DC Manager

Outil de cartographie réseau / datacenter : inventaire d'équipements, baies, câblage,
adressage IP (IPAM) et **visualisation 3D** des salles (Three.js / WebGL).

Deux modes de données :

- **Fichier** (autonome) — un `.json` sur disque + compagnon `.nmfb` d'images, via la
  File System Access API. Le client est un **HTML mono-fichier** ouvrable par double-clic.
- **API / REST** — données servies par le backend Node.js + SQLite (multi-documents,
  multi-clients, notifications temps réel SSE).

Le dépôt contient **les deux** dans un seul projet TypeScript :

| Dossier | Rôle | Compilé par |
|---|---|---|
| [`src/`](src/) | Front (navigateur) | webpack (`ts-loader`) |
| [`src-server/`](src-server/) | Back (Node, ESM/NodeNext) | `tsc` |
| [`shared/`](shared/) | Code PARTAGÉ front ⇄ back (schéma, validation, cascade) | les deux |
| [`docs/`](docs/) | Documentation d'architecture | — |
| [`Tests/modules/`](Tests/modules/) | Tests unitaires (Node, sans navigateur) | `tsc` (`tsconfig.node.json`) |

Conventions de contribution : voir [`CLAUDE.md`](CLAUDE.md).

---

## Prérequis

- **Node.js ≥ 18** (le serveur exige ≥ 18 ; les images Docker utilisent Node 20).
- **npm**.
- Pour le serveur **hors Docker** : une chaîne de compilation C++ (`python3`, `make`,
  `g++`) car `better-sqlite3` est un module **natif**. Sous Docker, c'est géré par l'image.

---

## 1. Build du client (front)

Depuis la **racine du dépôt** (`NetMap/`) :

```bash
npm install
npm run build          # webpack --mode production
```

Sortie : **`dist/dc-manager.html`** — un **HTML autonome** (le bundle JS et le CSS sont
*inlinés* dans la page, cf. `webpack.config.js`). Ouvrable directement (mode fichier) ou
servi par le backend (mode API).

### Développement (rechargement à chaud)

```bash
npm run dev            # webpack serve --mode development → ouvre /dc-manager.html
```

> Le serveur de dev webpack sert le client **sans config API injectée** → il démarre en
> **mode fichier**. Pour tester le **mode API**, lancer le backend (section 3 ou Docker),
> qui injecte `window.__DCMANAGER_CONFIG__ = { mode: "api", apiBaseUrl: "/api" }` dans le HTML.

### Vérifications

```bash
npm run typecheck      # tsc --noEmit (front)
npm test               # compile tsconfig.node.json puis exécute Tests/modules/run.js
```

---

## 2. Build du serveur (back)

Depuis [`src-server/`](src-server/) :

```bash
cd src-server
npm install
npm run build          # tsc
```

Sortie : **`src-server/dist/src-server/src/index.js`**.

> ℹ️ L'arborescence de sortie inclut `src-server/` car le serveur **compile aussi le code
> partagé `shared/`** avec lui (le `rootDir` est le parent commun). C'est voulu et identique
> au build Docker — voir [`CLAUDE.md`](CLAUDE.md) « Code partagé ».

> ⚠️ **`better-sqlite3` est un module natif.** `npm install` tente de récupérer un binaire
> **pré-compilé** correspondant à votre version de Node ; à défaut, il **compile depuis les
> sources** (nécessite `python3` + une chaîne C++ / MSBuild). Pièges fréquents :
> - **Node trop ancien** (ce projet vise Node ≥ 18 ; **Node 20 recommandé**, comme l'image
>   Docker) : sous une version sans binaire pré-compilé, l'install bascule en compilation et
>   peut échouer. Le plus simple est d'utiliser **Node 20**.
> - **Compiler le client/serveur (TypeScript) ne requiert PAS le binaire natif**, seulement
>   les déclarations de types. Pour un build/typecheck qui n'a pas besoin de *lancer* le
>   serveur, on peut sauter l'étape native :
>   ```bash
>   npm install --ignore-scripts   # installe tout (types compris), saute la compilation native
>   npm run build                  # tsc → OK
>   ```
>   Le binaire reste nécessaire à l'**exécution** (`npm start`) — d'où l'intérêt de **Docker**
>   (section 3), qui embarque la chaîne native et Node 20.

### Lancer le serveur localement

Le backend sert le client depuis `CLIENT_DIR` (défaut : `../../dist` → `NetMap/dist`).
**Builder le client d'abord** (section 1), puis :

```bash
cd src-server
npm start              # node dist/src-server/src/index.js
# → http://localhost:3000  (mode API)
```

Sans `SSO_URL`, le serveur démarre en **mode dev** avec un utilisateur factice
`SUPER_ADMIN` (aucune authentification requise) — pratique pour tester hors réseau SSO.

Développement serveur (recompilation à chaud) :

```bash
cd src-server
npm run dev            # tsx watch src/index.ts
```

---

## 3. Build & exécution Docker

L'image embarque **le client buildé + le backend Node/SQLite**. Le `Dockerfile`
([`src-server/Dockerfile`](src-server/Dockerfile)) est multi-étapes :

1. build du client (`npm run build` → HTML autonome) ;
2. build du serveur (`tsc` + `npm prune --omit=dev`, avec la chaîne native pour
   `better-sqlite3`) ;
3. image finale qui sert le client et expose l'API sur le port **3000**.

> ⚠️ Le **contexte de build est la racine `NetMap/`** (le Dockerfile copie `src/`,
> `src-server/` et `shared/`), même si le Dockerfile vit dans `src-server/`.

### Option A — docker compose (recommandé)

Tout est câblé dans [`src-server/docker-compose.yml`](src-server/docker-compose.yml)
(contexte `..`, volume de persistance, variables d'env de dev) :

```bash
cd src-server
docker compose up --build
# → http://localhost:3000  (mode API, utilisateur dev factice)
```

Les documents sont persistés dans le volume nommé `dc-manager-data` (monté sur `/data` ;
un fichier SQLite `.db` par document).

### Option B — docker build / run manuels

```bash
# depuis la racine NetMap/ (le contexte = ".")
docker build -f src-server/Dockerfile -t dc-manager .

docker run --rm -p 3000:3000 -v dc-manager-data:/data dc-manager
# → http://localhost:3000
```

### Santé

Endpoint `GET /healthz` (utilisé par le `HEALTHCHECK` de l'image).

### Derrière un reverse-proxy / sous un sous-dossier

L'app fonctionne **à la racine ou sous n'importe quel sous-dossier**
(`https://host/dc-manager/`) **sans reconfiguration** : toutes ses URLs sont relatives.
Configuration du proxy (stripping de préfixe, `X-Forwarded-Prefix`, slash final) :
voir [`docs/reverse-proxy.md`](docs/reverse-proxy.md).

---

## 4. Configuration (variables d'environnement)

Lues par le serveur au démarrage ([`src-server/src/index.ts`](src-server/src/index.ts)).

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port d'écoute HTTP. |
| `API_BASE` | `/api` | Préfixe des routes API (injecté dans le client). |
| `CLIENT_DIR` | `../../dist` | Dossier du client buildé à servir (dans l'image : `/client-dist`). |
| `DOCS_DIR` | `../data/documents` | Dossier des bases SQLite (dans l'image : `/data/documents`). |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` \| `trace`. |
| `SSO_URL` | SSO externe | URL du SSO à proxifier. **`""` (vide) → mode dev** (utilisateur factice). |
| `COOKIE_NAME` | `SsoJWT` | Cookie du jeton à transmettre au SSO (`""` = en-tête `Cookie` complet). |
| `DEV_USER` | — | Nom de l'utilisateur factice (mode dev). |
| `BASIC_AUTH` | — | `"user:pass"` → impose une Basic Auth navigateur (dev). Prioritaire sur le SSO. |
| `DEV_RIGHT` | `SUPER_ADMIN` | Dev : `SUPER_ADMIN` \| `NONE` \| `ANON` (pour tester l'écran d'accès refusé). |

**Authentification.** L'app **ne gère pas le login** : elle transmet les cookies de
session au backend, qui valide via le SSO (ou le proxifie). Pour brancher le vrai SSO,
renseigner `SSO_URL` / `COOKIE_NAME` (cf. exemples commentés dans le `docker-compose.yml`).

---

## Documentation

- [`docs/rest-migration.md`](docs/rest-migration.md) — backend REST, concurrence
  (révisions, SSE, verrou optimiste 409), cascade de suppression, limites connues.
- [`docs/render-impact.md`](docs/render-impact.md) — rechargement granulaire et impact 3D.
- [`docs/validation.md`](docs/validation.md) — normalisation & validation partagées.
- [`docs/reverse-proxy.md`](docs/reverse-proxy.md) — servir l'app **sous un sous-dossier**
  derrière un reverse-proxy (URLs relatives, `X-Forwarded-Prefix`), sans reconfiguration.
