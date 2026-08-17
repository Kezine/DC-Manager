# Installer DC Manager

*Pour le technicien qui déploie/exploite — la conception du build et du service HTTP est dans
[`docs/`](../docs/).*

Ce guide part d'un **clone nu du dépôt** et ne suppose aucune connaissance de TypeScript : toutes
les commandes sont données telles quelles. Deux chemins possibles, à choisir dès maintenant :

- **Docker (recommandé)** — l'image construit le client *et* le serveur ; aucun Node.js n'est requis
  sur la machine. Aller directement au § 3.
- **Sans Docker** — build manuel du client puis du serveur (§ 1 et § 2), utile en développement ou
  sur une machine où Docker n'est pas disponible.

Une fois l'application lancée, la configuration se fait par variables d'environnement :
[`configuration.md`](configuration.md). Pour l'exploitation courante (logs, sauvegarde, dépannage) :
[`exploitation.md`](exploitation.md).

---

## 0. Prérequis

| Chemin | Ce qu'il faut |
|---|---|
| **Docker** | **Docker Desktop** (ou `docker` + le plugin `compose`) démarré. Rien d'autre. |
| **Sans Docker** | **Node.js ≥ 18** (**Node 20 recommandé**, c'est la version des images Docker) et **npm**. Pour le serveur, en plus : une chaîne de compilation C++ (`python3`, `make`, `g++` — MSBuild sous Windows), car `better-sqlite3` est un module **natif**. |

Récupérer les sources :

```bash
git clone <url-du-depot> DcManager
cd DcManager
```

Toutes les commandes ci-dessous se lancent depuis ce dossier `DcManager/` (la **racine du dépôt**),
sauf mention contraire.

---

## 1. Build du client (front)

Depuis la **racine du dépôt** :

```bash
npm install
npm run build          # webpack --mode production
```

Sortie : **`dist/dc-manager.html`** — un **HTML autonome** (le bundle JavaScript et le CSS sont
*inlinés* dans la page). Ce fichier unique s'ouvre directement dans un navigateur (**mode fichier**,
les données vivent dans un `.json` sur disque) ou se fait servir par le backend (**mode API**).

### Vérifications (facultatives)

```bash
npm run typecheck      # tsc --noEmit (contrôle des types du front)
npm test               # tests unitaires (Node, sans navigateur)
```

### Développement avec rechargement à chaud

```bash
npm run dev            # webpack serve --mode development → ouvre /dc-manager.html
```

> Le serveur de développement webpack sert le client **sans configuration d'API injectée** : il
> démarre donc en **mode fichier**. Pour tester le **mode API**, lancer le backend (§ 2 ou § 3) — c'est
> lui qui injecte `window.__DCMANAGER_CONFIG__ = { mode: "api", apiBaseUrl: "api" }` dans le HTML.
> Cette base d'API est **relative** (sans slash initial, résolue contre le `<base>` du HTML) : c'est
> ce qui permet de servir l'app sous un sous-dossier, cf. [`reverse-proxy.md`](reverse-proxy.md).

---

## 2. Build du serveur (back)

Le serveur se compile depuis son propre dossier :

```bash
cd src-server
npm install
npm run build          # tsc
```

Sortie : **`src-server/dist/src-server/src/index.js`**.

> ℹ️ L'arborescence de sortie contient un niveau `src-server/` parce que le serveur **compile aussi
> le code partagé** `src-shared/` avec lui (la racine commune des deux dossiers sert de base). C'est
> voulu, et identique à ce que fait le build Docker.

> ⚠️ **`better-sqlite3` est un module natif.** `npm install` tente d'abord de récupérer un binaire
> **pré-compilé** correspondant à votre version de Node ; à défaut, il **compile depuis les sources**
> (d'où le prérequis `python3` + chaîne C++). Deux pièges fréquents :
>
> - **Version de Node sans binaire pré-compilé** : l'installation bascule en compilation et peut
>   échouer. Le plus simple est d'utiliser **Node 20**.
> - **Compiler le TypeScript ne requiert PAS le binaire natif**, seulement les déclarations de types.
>   Pour un build ou un contrôle de types qui n'a pas besoin de *lancer* le serveur :
>   ```bash
>   npm install --ignore-scripts   # installe tout (types compris), saute la compilation native
>   npm run build                  # tsc → OK
>   ```
>   Le binaire reste nécessaire à l'**exécution** (`npm start`) — d'où l'intérêt de Docker (§ 3), qui
>   embarque la chaîne native et Node 20.

### Lancer le serveur localement (sans Docker)

Le backend sert le client depuis le dossier `CLIENT_DIR` (défaut : `../../dist`, soit `DcManager/dist`).
**Il faut donc avoir buildé le client d'abord** (§ 1). Ensuite :

```bash
cd src-server
npm start              # node dist/src-server/src/index.js
# → http://localhost:3000  (mode API)
```

Sans configuration d'authentification, le serveur démarre en **mode dev** : un utilisateur factice
`dev` a tous les droits et aucune authentification n'est demandée. Pratique pour un premier essai —
**jamais** pour un déploiement réel : voir [`auth.md`](auth.md).

Développement serveur (recompilation à chaud) :

```bash
cd src-server
npm run dev            # tsx watch src/index.ts
```

---

## 3. Docker (client + serveur dans une image)

L'image embarque **le client buildé et le backend Node/SQLite**. Le `Dockerfile`
([`src-server/Dockerfile`](../src-server/Dockerfile)) est multi-étapes :

1. build du client (`npm run build` → HTML autonome) ;
2. build du serveur (`tsc`, puis `npm prune --omit=dev`, avec la chaîne native pour `better-sqlite3`) ;
3. image finale qui sert le client et expose l'API sur le port **3000**.

> ⚠️ Le **contexte de build est la racine `DcManager/`** (le Dockerfile copie `src-client/`,
> `src-server/` et `src-shared/`), même si le `Dockerfile` vit dans `src-server/`.

### Option A — docker compose (recommandé)

Tout est câblé dans [`src-server/docker-compose.yml`](../src-server/docker-compose.yml) : contexte de
build `..`, volume de persistance, variables d'environnement.

```bash
cd src-server
docker compose up -d --build      # construit (client + serveur) et démarre en arrière-plan
```

- `--build` : reconstruit l'image (à refaire après chaque modification du code).
- `-d` : détaché, rend la main. Sans `-d`, les logs défilent dans le terminal.

Puis ouvrir **http://localhost:3000** (mode API, utilisateur `dev` factice).

> La **1ʳᵉ** construction prend ≈ 3-6 min (build du client + dépendances natives). Les suivantes
> réutilisent le cache.

Les documents sont persistés dans le volume nommé `dc-manager-data`, monté sur `/data` (un fichier
SQLite `.db` par document).

### Option B — docker build / run manuels

```bash
# depuis la racine DcManager/ (le contexte de build = ".")
docker build -f src-server/Dockerfile -t dc-manager .

docker run -d --name dc-manager -p 3000:3000 -v dc-manager-data:/data dc-manager
# → http://localhost:3000
```

---

## 4. Vérifier que ça tourne

```bash
docker compose ps                          # statut + ports : "Up", health "healthy"
curl http://localhost:3000/healthz         # → {"ok":true}
curl http://localhost:3000/api/me          # → {"name":"dev","dev":true} en mode dev
```

L'endpoint **`GET /healthz`** est celui qu'utilise le `HEALTHCHECK` de l'image ; il ne demande
aucune authentification et convient à une sonde de supervision.

Au démarrage, le serveur écrit une ligne du type :

```
DC Manager server → http://localhost:3000  (api /api)
```

---

## 5. Et ensuite

- **Configurer** (port, dossier des documents, authentification, clé de chiffrement des secrets) :
  [`configuration.md`](configuration.md).
- **Choisir et régler un mode d'authentification** : [`auth.md`](auth.md).
- **Servir l'application derrière un reverse-proxy**, éventuellement sous un sous-dossier :
  [`reverse-proxy.md`](reverse-proxy.md).
- **Exploiter au quotidien** (logs, sauvegarde, arrêt/redémarrage, dépannage) :
  [`exploitation.md`](exploitation.md).
