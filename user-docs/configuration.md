# Configuration — variables d'environnement

*Pour le technicien qui déploie/exploite — la conception de chaque mécanisme est dans
[`docs/`](../docs/).*

🚨 **Ce document est la SOURCE UNIQUE de vérité des variables d'environnement** reconnues par le
serveur. Toute autre mention ailleurs dans le dépôt (fichiers de documentation, `.env.example`,
`docker-compose.yml`) renvoie ici. Si le code lit une variable qui manque à la table ci-dessous,
c'est un **bug de documentation** : le signaler.

Où les poser, selon le mode de lancement :

| Lancement | Où déclarer les variables |
|---|---|
| **docker compose** | section `environment:` de [`src-server/docker-compose.yml`](../src-server/docker-compose.yml), puis `docker compose up -d` (recrée le conteneur) |
| **docker run** | options `-e NOM=valeur` |
| **sans Docker** | fichier `src-server/.env` (partir de [`src-server/.env.example`](../src-server/.env.example)) ou variables du shell |

---

## 1. La table de référence (28 variables)

### Service HTTP et stockage

| Variable | Défaut du **code** | Défaut de l'**image Docker** | Rôle |
|---|---|---|---|
| `PORT` | `3000` | `3000` | Port d'écoute HTTP. |
| `API_BASE` | `/api` | `/api` | Préfixe des routes de l'API REST, injecté dans le client. |
| `CLIENT_DIR` | `../../dist` (soit `DcManager/dist`) | `/client-dist` | Dossier du client buildé à servir. |
| `DOCS_DIR` | `../data/documents` | `/data/documents` | Dossier des bases SQLite : registre des documents, un `.db` par document, et les bases des modules. |
| `LOG_LEVEL` | `info` | `info` | Verbosité : `error` \| `warn` \| `info` \| `debug` \| `trace`. Détail des niveaux : [`exploitation.md`](exploitation.md) § Logs. |
| `PUBLIC_BASE_URL` | *(vide)* | *(vide)* | 🚨 **URL PUBLIQUE ABSOLUE** de l'application (la page du client, **chemin de reverse-proxy à sous-chemin compris**) — encodée dans les **étiquettes QR** des fiches. Même doctrine qu'`OIDC_REDIRECT_URL` : elle **ne se devine pas** derrière un reverse-proxy et **aucun en-tête de requête** n'entre dans sa construction (une URL dérivée de `Host` finirait **imprimée** sur des étiquettes). **Absente → la génération de QR répond 503** actionnable ; le serveur démarre normalement, tout le reste fonctionne. Ex. derrière un proxy à sous-chemin : `https://infra.exemple.org/dc-manager/`. |

> Les deux colonnes de défaut ne se contredisent pas : le **code** applique un chemin relatif à
> l'emplacement du serveur compilé, et l'**image Docker** pose explicitement des chemins absolus
> (`ENV` du `Dockerfile`) qui correspondent au volume monté. En Docker, c'est la colonne « image »
> qui s'applique.

### Authentification — sélection du mode

Cinq modes ; détail, exemples de configuration et modèle de confiance : [`auth.md`](auth.md).

| Variable | Défaut | Rôle |
|---|---|---|
| `AUTH_MODE` | *(vide)* | **Mode d'authentification EXPLICITE** : `dev` \| `basic` \| `sso` \| `forward` \| `oidc`. Vide ou absente → **inférence historique** (`BASIC_AUTH` → basic, sinon `SSO_URL` → sso, sinon dev) ; `forward` et `oidc` ne sont **jamais** inférés. 🚨 Une valeur **inconnue ou incohérente** (faute de frappe, `sso` sans `SSO_URL`, `basic` sans `BASIC_AUTH`, `oidc` sans `OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_REDIRECT_URL`) **empêche le démarrage**, avec une erreur explicite : jamais de repli silencieux sur le mode dev, qui n'authentifie personne. |

### Authentification — mode `dev` et mode `basic`

| Variable | Défaut | Rôle |
|---|---|---|
| `DEV_USER` | `dev` | Nom de l'utilisateur factice du mode dev. Vide ou absente → `dev`. |
| `BASIC_AUTH` | *(vide)* | `"user:pass"` → impose un challenge HTTP Basic au navigateur. Sous l'inférence, prioritaire sur `SSO_URL`. |

### Authentification — mode `sso` (SSO maison)

| Variable | Défaut | Rôle |
|---|---|---|
| `SSO_URL` | *(vide)* | URL du SSO externe auquel proxifier le jeton de session. Vide → mode dev (sous l'inférence). |
| `COOKIE_NAME` | *(vide)* | Nom du cookie portant le jeton à transmettre au SSO. Vide = l'en-tête `Cookie` complet est transmis. |
| `SSO_LOGIN_URL` | *(vide)* | URL de connexion du bouton « Connexion » de l'écran d'accueil (affiché si l'appelant n'est pas authentifié). La macro `${clbkUrl}` est remplacée par l'URL courante encodée, pour le retour après login. Vide = pas de bouton — **sauf en mode `oidc`**, où elle se défaut sur `auth/login`. |

### Authentification — mode `forward` (reverse-proxy *identity-aware*)

| Variable | Défaut | Rôle |
|---|---|---|
| `AUTH_FORWARD_USER_HEADER` | `Remote-User` | En-tête portant le **login**. Requis à l'exécution : absent ou vide ⇒ appelant **anonyme**. |
| `AUTH_FORWARD_EMAIL_HEADER` | `Remote-Email` | En-tête de l'adresse e-mail. |
| `AUTH_FORWARD_NAME_HEADER` | `Remote-Name` | En-tête du nom d'**affichage complet**. |
| `AUTH_FORWARD_GROUPS_HEADER` | `Remote-Groups` | En-tête des **groupes** de l'IdP, séparés par des virgules → traduits en rôles par la table `groups` de `ROLES_FILE`. |
| `AUTH_FORWARD_SECRET` | *(vide)* | 🚨 **Secret partagé** proxy ↔ application, comparé à **temps constant**. Configuré : toute requête dont l'en-tête ne correspond pas est **anonyme** (aucun autre en-tête n'est même lu). Absent : le mode fonctionne, mais le démarrage **avertit** — l'application doit alors être joignable **uniquement** par le proxy. |
| `AUTH_FORWARD_SECRET_HEADER` | `X-Auth-Secret` | En-tête portant ce secret partagé. |

### Authentification — mode `oidc` (l'application est le *Relying Party*)

| Variable | Défaut | Rôle |
|---|---|---|
| `OIDC_ISSUER` | *(vide)* | **Émetteur** de l'IdP, ex. `https://keycloak.exemple/realms/infra`. **Requis** (refus de démarrer sinon). Doit être servi en **HTTPS** : la découverte refuse un émetteur HTTP. |
| `OIDC_CLIENT_ID` | *(vide)* | Identifiant du client déclaré chez l'IdP. **Requis**. |
| `OIDC_REDIRECT_URL` | *(vide)* | 🚨 **URL PUBLIQUE ABSOLUE** du callback (`https://dcmanager.exemple/auth/callback`), déclarée **à l'identique** chez l'IdP. **Requise** : elle ne peut pas être devinée derrière un reverse-proxy à sous-chemin, et aucun en-tête réseau n'entre dans sa composition. Doit se terminer par `/auth/callback` (sinon : avertissement au démarrage). |
| `OIDC_CLIENT_SECRET` | *(vide)* | Secret d'un client **confidentiel**. Vide = client **public** (PKCE seul) — les deux formes sont servies, PKCE est employé dans les deux cas. |
| `OIDC_SCOPES` | `openid profile email groups` | Scopes demandés (`openid` est **forcé** en tête s'il manque). Le scope `groups` n'est pas universel (Keycloak l'offre via un *client scope*, Entra ID ne le connaît pas) : le réduire si l'IdP refuse un scope inconnu. |
| `OIDC_COOKIE_SECURE` | `1` | Attribut `Secure` des cookies de session et de transaction. `0` = **développement en HTTP local uniquement** (avertissement au démarrage : le cookie circulerait en clair). |

### Autorisation (rôles et permissions)

| Variable | Défaut | Rôle |
|---|---|---|
| `ROLES_FILE` | `<DOCS_DIR>/roles.json` | Chemin du fichier de **politique d'autorisation** (RBAC), relu **à chaud**. **Fail-closed** : absent ou illisible → personne n'a de rôle. Format complet : [`auth.md`](auth.md) § `roles.json`. |
| `BOOTSTRAP_ADMIN_IDS` | *(vide)* | Ids canoniques ou logins, séparés par des **virgules**, promus rôle `admin` **en plus** de `ROLES_FILE`. Amorçage d'un déploiement neuf : sans elle, le premier administrateur serait verrouillé dehors par la politique qu'il doit écrire. |

### Secrets et intégrations

| Variable | Défaut | Rôle |
|---|---|---|
| `DCMANAGER_SECRETS_KEY` | *(vide)* | **Clé de chiffrement des secrets serveur.** Requise par les modules VM, wifi, réplication vers un tracker et notifications. Section dédiée ci-dessous — **§ 2**. |
| `JIRA_BASE_URL` | *(vide)* | **Base d'URL Jira** du module **interventions**, pour fabriquer un lien vers un ticket depuis une clé **saisie à la main** (ex. `https://monorg.atlassian.net/browse/`). La valeur est rognée ; vide ou absente → le client masque le lien. Aucun appel réseau vers Jira n'est fait pour ce lien. ⚠ **Sans rapport avec le pont de réplication** ([`jira-tracker.md`](jira-tracker.md)), qui persiste le lien de chaque ticket au moment de la synchro et n'a donc **aucune** variable d'environnement propre. |

---

## 2. 🚨 `DCMANAGER_SECRETS_KEY` — la clé des secrets serveur

**Une seule clé pour toute l'application.** Elle chiffre au repos les secrets que le serveur doit
pouvoir relire lui-même : jetons d'API des providers VM, clés d'API des contrôleurs wifi, jetons
d'API des trackers, jetons des webhooks de notification.

### Contrainte : au moins 16 caractères, long et aléatoire

La clé de chiffrement est un **SHA-256 direct** de la valeur fournie, sans sel ni itérations : c'est
volontaire — il s'agit d'un secret d'infrastructure, pas d'un mot de passe humain. Toute la
robustesse repose donc sur la **longueur** de la valeur. Une passphrase de moins de **16 caractères**
est **refusée** au démarrage du module concerné (qui passe « en erreur », routes en 503, sans faire
tomber le serveur) : une passphrase courte rendrait une copie de la base attaquable hors ligne.

La générer, par exemple :

```bash
openssl rand -base64 32
```

**Aucun autre nom de variable n'est reconnu**, et il n'existe aucun repli. Un déploiement qui
porterait la même passphrase sous un autre nom doit simplement **renommer** la variable : à valeur
identique, la dérivation est identique, donc les secrets déjà stockés restent déchiffrables sans
réécriture.

### Portée : quatre modules

| Module | Ce qu'elle chiffre | Sans la clé |
|---|---|---|
| **VM / Proxmox** ([`vm-proxmox.md`](vm-proxmox.md)) | jetons d'API des providers | feature **entièrement** désactivée : toutes les routes en **503**, bandeau dans l'UI |
| **Clients wifi** ([`wifi-unifi.md`](wifi-unifi.md)) | clés d'API des contrôleurs | module inactif, routes en **503** |
| **Réplication vers un tracker** ([`jira-tracker.md`](jira-tracker.md)) | jetons d'API des trackers (jetons en **ÉCRITURE**) | pont inactif, routes en **503**, hook d'écriture inerte |
| **Notifications** ([`notifications-certs.md`](notifications-certs.md)) | jetons des webhooks | module inactif en bloc (canal `console` compris), routes en **503** |

Deux features n'en dépendent **pas** : les **interventions** restent pleinement fonctionnelles, et la
**PKI / certificats** est *zéro-connaissance* (le chiffrement se fait dans le navigateur, avec une
phrase maître que le serveur ne connaît jamais).

### Le 503 est actionnable, et le serveur démarre quand même

Clé absente ou invalide, le serveur **démarre normalement** : seuls les modules concernés se
désactivent, et leurs routes répondent **503** avec un message qui nomme la variable à définir.
L'interface affiche ce message à la place des contrôles d'édition. C'est le comportement voulu — une
intégration non configurée ne doit pas empêcher le reste de servir.

Si une base chiffrée existe **déjà** alors que la clé est absente, le message est enrichi (« des
jetons chiffrés attendent la clé »).

### Ce qu'elle protège, et ce qu'elle ne protège pas

Le chiffrement protège les **copies** de la base : sauvegardes, fichier exfiltré. Il ne protège pas
d'un attaquant qui contrôle l'hôte — la clé vit dans l'environnement du serveur. Limite assumée.

### Clé perdue ou changée = secrets à ressaisir

Il n'existe **aucune récupération** : c'est le but. Si la valeur change, les secrets stockés
deviennent indéchiffrables ; chaque module le signale explicitement (« le secret doit être
ressaisi ») et il faut rouvrir chaque provider pour y **ressaisir le jeton**. Procédure détaillée par
module : [`vm-proxmox.md`](vm-proxmox.md), [`wifi-unifi.md`](wifi-unifi.md),
[`jira-tracker.md`](jira-tracker.md), [`notifications-certs.md`](notifications-certs.md).

---

## 3. Le minimum vital

Un déploiement réel se règle en pratique avec quatre décisions :

```yaml
environment:
  DOCS_DIR: /data/documents                # où vivent les bases (sur un volume persistant)
  AUTH_MODE: forward                       # ou oidc — jamais dev en production
  AUTH_FORWARD_SECRET: "…"                 # si mode forward : le secret partagé avec le proxy
  BOOTSTRAP_ADMIN_IDS: "jdupont"           # le temps d'écrire roles.json
  DCMANAGER_SECRETS_KEY: "…"               # si VM / wifi / tracker / notifications sont utilisés
```

Tout le reste a un défaut raisonnable.
