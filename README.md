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
| [`src-client/`](src-client/) | Front (navigateur) | webpack (`ts-loader`) |
| [`src-server/`](src-server/) | Back (Node, ESM/NodeNext) | `tsc` |
| [`src-shared/`](src-shared/) | Code PARTAGÉ front ⇄ back (schéma, validation, cascade) | les deux |
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

Depuis la **racine du dépôt** (`DcManager/`) :

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
> qui injecte `window.__DCMANAGER_CONFIG__ = { mode: "api", apiBaseUrl: "api" }` dans le HTML.
> La base d'API est **relative** (sans slash initial, résolue contre le `<base>` du HTML) :
> c'est ce qui permet de servir l'app sous un sous-dossier — cf. [`docs/reverse-proxy.md`](docs/reverse-proxy.md).

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
> partagé `src-shared/`** avec lui (le `rootDir` est le parent commun). C'est voulu et identique
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

Le backend sert le client depuis `CLIENT_DIR` (défaut : `../../dist` → `DcManager/dist`).
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

> ⚠️ Le **contexte de build est la racine `DcManager/`** (le Dockerfile copie `src-client/`,
> `src-server/` et `src-shared/`), même si le Dockerfile vit dans `src-server/`.

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
# depuis la racine DcManager/ (le contexte = ".")
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

Lues par le serveur au démarrage — cœur dans [`src-server/src/index.ts`](src-server/src/index.ts) ; la **clé de chiffrement** des secrets, elle, est lue par le coffre partagé [`SecretBox`](src-server/src/SecretBox.ts) (utilisé par les modules VM / wifi / réplication vers un tracker / notifications).

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port d'écoute HTTP. |
| `API_BASE` | `/api` | Préfixe des routes API (injecté dans le client). |
| `CLIENT_DIR` | `../../dist` | Dossier du client buildé à servir (dans l'image : `/client-dist`). |
| `DOCS_DIR` | `../data/documents` | Dossier des bases SQLite (dans l'image : `/data/documents`). |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` \| `trace`. |
| `AUTH_MODE` | *(vide)* | **Mode d'authentification EXPLICITE** : `dev` \| `basic` \| `sso` \| `forward` \| `oidc`. Vide/absente → **inférence historique** (`BASIC_AUTH` → basic, sinon `SSO_URL` → sso, sinon dev) — `forward` et `oidc` ne sont **jamais** inférés. 🚨 Une valeur **inconnue ou incohérente** (faute de frappe, `sso` sans `SSO_URL`, `basic` sans `BASIC_AUTH`, `oidc` sans `OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_REDIRECT_URL`) **empêche le démarrage** avec une erreur explicite : jamais de repli silencieux sur le mode dev, qui n'authentifie personne. |
| `SSO_URL` | *(vide)* | URL du SSO externe à proxifier. **`""` (vide) → mode dev** (utilisateur factice). |
| `COOKIE_NAME` | *(vide)* | Cookie du jeton à transmettre au SSO (`""` = en-tête `Cookie` complet). |
| `SSO_LOGIN_URL` | *(vide)* | URL de connexion SSO du bouton « Connexion » (écran d'accueil, si non authentifié). Macro `${clbkUrl}` → URL courante encodée (retour après login). Vide = pas de bouton — **sauf en mode `oidc`**, où elle se défaut automatiquement sur `auth/login` (le bouton marche sans configuration). |
| `DEV_USER` | — | Nom de l'utilisateur factice (mode dev). |
| `BASIC_AUTH` | — | `"user:pass"` → impose une Basic Auth navigateur (dev). Prioritaire sur le SSO. |
| `AUTH_FORWARD_USER_HEADER` | `Remote-User` | **Mode `forward`** (reverse-proxy *identity-aware* : Authelia, Authentik, oauth2-proxy, Cloudflare Access, Tailscale…) : en-tête portant le **login**. Requis à l'exécution — absent/vide ⇒ appelant anonyme. |
| `AUTH_FORWARD_EMAIL_HEADER` | `Remote-Email` | Mode `forward` : en-tête de l'adresse e-mail. |
| `AUTH_FORWARD_NAME_HEADER` | `Remote-Name` | Mode `forward` : en-tête du nom d'**affichage complet**. |
| `AUTH_FORWARD_GROUPS_HEADER` | `Remote-Groups` | Mode `forward` : en-tête des **groupes** de l'IdP, séparés par des virgules → mappés vers des rôles par la table `groups` de `ROLES_FILE`. |
| `AUTH_FORWARD_SECRET` | *(vide)* | 🚨 Mode `forward` : **secret partagé** proxy↔app, comparé à **temps constant**. Configuré → toute requête dont l'en-tête ne correspond pas est **anonyme** (aucun autre en-tête n'est même lu). Absent → le mode fonctionne mais le boot **avertit** : l'app doit alors être joignable **uniquement** par le proxy (bind localhost / réseau privé), sinon tout client direct peut forger son identité. Cf. [`docs/auth.md`](docs/auth.md). |
| `AUTH_FORWARD_SECRET_HEADER` | `X-Auth-Secret` | Mode `forward` : en-tête portant le secret partagé. |
| `OIDC_ISSUER` | *(vide)* | **Mode `oidc`** (l'application est elle-même le *Relying Party* d'un OP : Keycloak, Entra ID, Authelia en mode OP… — flux *Authorization Code + PKCE*, dépendance `openid-client`) : **émetteur** de l'IdP, ex. `https://keycloak.exemple/realms/infra`. **Requis** (refus de démarrer sinon). Doit être servi en **HTTPS**. |
| `OIDC_CLIENT_ID` | *(vide)* | Mode `oidc` : identifiant du client déclaré chez l'IdP. **Requis**. |
| `OIDC_REDIRECT_URL` | *(vide)* | 🚨 Mode `oidc` : **URL PUBLIQUE ABSOLUE** du callback (`https://dcmanager.exemple/auth/callback`), déclarée **à l'identique** chez l'IdP. **Requise** : elle ne peut pas être devinée derrière un reverse-proxy à sous-chemin, et aucun en-tête réseau n'entre dans sa composition. |
| `OIDC_CLIENT_SECRET` | *(vide)* | Mode `oidc` : secret d'un client **confidentiel**. **Vide = client PUBLIC** (PKCE seul) — les deux sont servis, PKCE est employé dans les deux cas. |
| `OIDC_SCOPES` | `openid profile email groups` | Mode `oidc` : scopes demandés (`openid` est **forcé** en tête s'il manque). Le scope `groups` n'est pas universel (Keycloak l'offre via un *client scope*, Entra ID ne le connaît pas) : le réduire si l'IdP refuse un scope inconnu. Les **groupes** obtenus sont mappés vers des rôles par la table `groups` de `ROLES_FILE`, comme en mode `forward`. |
| `OIDC_COOKIE_SECURE` | `1` | Mode `oidc` : attribut `Secure` des cookies de session et de transaction. `0` = **développement en HTTP local uniquement** (WARN de boot : le cookie circulerait en clair). |
| `ROLES_FILE` | `<DOCS_DIR>/roles.json` | **Politique d'AUTORISATION** (RBAC) : fichier JSON `{ "users": { "<id-ou-login>": ["rôle"] }, "groups": { "<groupe IdP>": ["rôle"] }, "roles": { "<rôle custom>": ["grants"] } }`, relu **à chaud**. La table `groups` mappe les **groupes** fournis par l'IdP (mode `forward`) : la gestion des utilisateurs vit alors dans l'IdP. **Fail-closed** : absent/illisible → personne n'a de rôle (403 partout sauf `GET /me`). Cf. [`docs/auth.md`](docs/auth.md). |
| `BOOTSTRAP_ADMIN_IDS` | *(vide)* | Ids canoniques ou logins (séparés par des **virgules**) promus rôle `admin`, **en plus** de `ROLES_FILE`. Amorçage d'un déploiement neuf : sans elle, le premier administrateur serait verrouillé dehors par la politique qu'il doit écrire. |
| `DCMANAGER_SECRETS_KEY` | — | **Clé de chiffrement** des secrets serveur (coffre `SecretBox` partagé, lu par les modules — pas par `index.ts`). Requise par les modules **VM/Proxmox** (jetons des providers), **clients wifi** (clés d'API des contrôleurs), **réplication des interventions vers un tracker** (jetons d'API des trackers — jetons en **ÉCRITURE**, cf. `docs/jira-interventions.md`) et **notifications** (jetons de webhook) : absente → ces modules se désactivent et le signalent (**503 explicite**) ; le serveur démarre quand même. **Doit être un secret LONG et ALÉATOIRE (≥ 16 caractères** — refusé au démarrage du module sinon, car la clé en est un simple SHA-256 sans sel : une passphrase courte rendrait un backup de la base force-brutable hors ligne). La générer, p. ex. `openssl rand -base64 32`. **Seule variable lue** pour ce coffre : aucun autre nom n'est reconnu. La PKI/certs est *zéro-connaissance* (chiffrement navigateur) et **n'en dépend pas**. |
| `JIRA_BASE_URL` | *(vide)* | **Base d'URL Jira** (module **interventions**) pour fabriquer un lien vers un ticket depuis une clé saisie à la main (ex. `https://monorg.atlassian.net/browse/`). Trimmée ; vide/absente → le client masque le lien. Exposée par `GET …/interventions/meta` ; simple RÉFÉRENCE (aucun appel Jira côté serveur). ⚠ **Sans rapport avec le pont de réplication** (`docs/jira-interventions.md`), qui PERSISTE le lien de chaque ticket au moment de la synchro et n'a donc aucune variable d'environnement propre. |

**Authentification.** L'app **ne gère pas le login**. Quatre modes, sélectionnés par `AUTH_MODE`
(ou, à défaut, inférés) : **dev** (aucun contrôle — défaut), **basic** (challenge HTTP Basic),
**sso** (cookie de session proxifié à un SSO maison) et **forward** (un reverse-proxy
*identity-aware* authentifie en amont et transmet l'identité dans des en-têtes — Authelia,
Authentik, oauth2-proxy, Cloudflare Access, Tailscale…). Le mode `forward` est **recommandé** pour un
déploiement réel, et se sécurise par un secret partagé (`AUTH_FORWARD_SECRET`) ; détail du modèle de
confiance : [`docs/auth.md`](docs/auth.md).

**Autorisation (rôles / permissions).** *Qui est l'appelant* et *ce qu'il peut* sont deux questions
distinctes. Une fois authentifié, l'accès est réglé par un **RBAC à permissions atomiques**
(`dc.ip:update`, `certs:pki`…) : des rôles (`dc-viewer`, `dc-editor`, `cert-manager`, `admin`…) sont
associés aux utilisateurs dans `ROLES_FILE`. **Opt-in strict** — un utilisateur authentifié SANS rôle
n'a **aucune** permission et reçoit 403 partout sauf `GET /me`. Les déploiements existants ne changent
pas de comportement : modes dev/basic et SSO `adminRight = "SUPER_ADMIN"` valent le rôle `admin`.
Modèle complet, catalogue, format du fichier et procédures : [`docs/auth.md`](docs/auth.md).

> ⚠️ L'intégration **SSO maison** (`SSO_URL`) répond à un **besoin personnel** (contrat spécifique :
> cookie de session proxifié vers un endpoint renvoyant `{ logged, adminRight, expireDate }`) et n'est
> **probablement pas adaptée à la plupart des usages**. Pour un déploiement réel, préférer
> **`AUTH_MODE=forward`** derrière un reverse-proxy *identity-aware* (Authelia, Authentik,
> oauth2-proxy, Cloudflare Access, Tailscale) : l'IdP gère les comptes, les groupes deviennent des
> rôles, et l'app n'a aucun flux OAuth à porter. À défaut, la **Basic Auth**
> (`BASIC_AUTH=user:pass`) protège un serveur sans infrastructure. Un provider **OIDC** natif reste à
> venir, pour les déploiements sans proxy identity-aware.

---

## Documentation

**Données & modèle**

- [`docs/validation.md`](docs/validation.md) — normalisation & validation partagées front ⇄ back.
- [`docs/persistance.md`](docs/persistance.md) — persistance serveur : modèle relationnel SQLite,
  schéma dérivé de la spec, colonne `search`, migration des documents legacy.
- [`docs/recherche.md`](docs/recherche.md) — palette Ctrl+K, listings serveur-pilotés, filtre cible.
- [`docs/placement.md`](docs/placement.md) — doctrine du placement (conteneurs, repères, chaîne
  bâtiment → étage → salle → baie).

**Domaine métier**

- [`docs/deduction-reseau.md`](docs/deduction-reseau.md) — réseau déduit depuis les ports terminaux.
- [`docs/faisceaux.md`](docs/faisceaux.md) — faisceaux (trunks) : contraintes et rendu du tracé.
- [`docs/power.md`](docs/power.md) — analyse énergie (source/sink, charges, PoE, avertissements).

**Vues 2D/3D**

- [`docs/perf-3d.md`](docs/perf-3d.md) — optimisations du moteur 3D WebGL.
- [`docs/redressement-perspective.md`](docs/redressement-perspective.md) — correction de perspective
  et assemblage des images de façade.

**Modules serveur amovibles**

- [`docs/vm-proxmox.md`](docs/vm-proxmox.md) — inventaire VM Proxmox.
- [`docs/wifi-unifi.md`](docs/wifi-unifi.md) — inventaire des clients wifi (UniFi).
- [`docs/notifications.md`](docs/notifications.md) — service de notifications et d'alertes.
- [`docs/certs.md`](docs/certs.md) — PKI interne zéro-connaissance.
- [`docs/interventions.md`](docs/interventions.md) — incidents & interventions.
- [`docs/jira-interventions.md`](docs/jira-interventions.md) — réplication des incidents & interventions vers un tracker distant (Jira Cloud).

**Transverse**

- [`docs/user-resolver.md`](docs/user-resolver.md) — annuaire utilisateurs et audit « créé/modifié par ».
- [`docs/i18n.md`](docs/i18n.md) — localisation du client (fr/en).
- [`docs/reverse-proxy.md`](docs/reverse-proxy.md) — servir l'app **sous un sous-dossier**
  derrière un reverse-proxy (URLs relatives, `X-Forwarded-Prefix`), sans reconfiguration.

---

## Crédits

Projet conçu et maintenu par **Kezine**.

Co-écrit avec **Claude** (Anthropic), utilisé comme assistant de développement pour la
conception, l'implémentation, les tests et la documentation. Les conventions que
l'assistant doit respecter sont réunies dans [`CLAUDE.md`](CLAUDE.md).
