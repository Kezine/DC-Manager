# DC Manager — Lancer l'image & consulter les logs

Guide d'exploitation du conteneur (client + backend REST). Aucun Node requis en
local : tout est construit dans l'image. Voir aussi [README.md](README.md).

> Prérequis : **Docker Desktop** démarré (icône baleine active).
> Toutes les commandes se lancent depuis le dossier `src-server/`.

---

## 1. Lancer

```bash
cd src-server
docker compose up -d --build      # construit (client+serveur) et démarre en arrière-plan
```

- `--build` : reconstruit l'image (à refaire après chaque modif du code).
- `-d` : détaché (rend la main). Sans `-d`, les logs défilent dans le terminal.

Puis ouvrir **http://localhost:3000** (mode API, utilisateur `dev` factice).

> 1ʳᵉ build ≈ 3-6 min (build du client + deps natives). Les suivants sont en cache.

### Sans docker compose
```bash
# depuis la racine DcManager/ :
docker build -f src-server/Dockerfile -t dc-manager .
docker run -d --name dc-manager -p 3000:3000 -v dc-manager-data:/data dc-manager
```

---

## 2. Vérifier que ça tourne

```bash
docker compose ps                 # statut + ports (doit être "Up", health "healthy")
curl http://localhost:3000/healthz       # → {"ok":true}
curl http://localhost:3000/api/me        # → {"name":"dev","dev":true}
```

---

## 3. Consulter les logs

```bash
docker compose logs -f            # logs EN DIRECT (Ctrl+C pour quitter le suivi)
docker compose logs --tail 100    # les 100 dernières lignes
docker compose logs --since 10m   # depuis 10 minutes
```

Sans compose (par nom de conteneur) :
```bash
docker logs -f dc-manager
docker logs --tail 200 dc-manager
```

Au démarrage, le serveur logue une ligne du type :
```
DC Manager server → http://localhost:3000  (api /api)
```

### Niveau de logs (serveur)
Le serveur logue **chaque requête** (méthode, URL, code, durée) + les opérations
sur les documents. Verbosité réglable par **`LOG_LEVEL`** (dans `docker-compose.yml`) :

| `LOG_LEVEL` | Ce qui apparaît |
|---|---|
| `error` | uniquement les exceptions / 5xx |
| `warn`  | + les réponses 4xx |
| `info` *(défaut)* | + chaque requête réussie + création/suppression de documents |
| `debug` | + ouverture des dépôts (documents) |
| `trace` | + le healthcheck `/healthz` |

```bash
# changer le niveau à chaud :
#   éditer LOG_LEVEL dans docker-compose.yml puis
docker compose up -d
docker compose logs -f            # observer
```

Format : `2026-… INFO  [http] GET /api/documents → 200 (3ms)`.

Côté **client**, logs console séparés : **Réglages → Débogage → « Logs de
débogage »** (ou `DcManagerLog.enable()` en console) ; l'onglet **Réseau** (F12)
montre les URL exactes appelées.

---

## 4. Arrêter / redémarrer / reconstruire

```bash
docker compose restart            # redémarre (garde les données)
docker compose stop               # arrête (garde conteneur + données)
docker compose up -d              # relance
docker compose down               # arrête ET supprime le conteneur (données conservées : volume)
docker compose up -d --build      # reconstruit après une modif de code
```

---

## 5. Données & persistance

Les documents vivent dans le volume **`dc-manager-data`** (monté sur `/data`,
un fichier `.db` par document + `registry.db`).

```bash
docker volume ls                  # liste les volumes (cherche *dc-manager-data)
docker compose down -v            # ⚠️ SUPPRIME le volume → repart de zéro (perte des documents)
```

### Pièces jointes : binaires HORS base (sauvegarde en DEUX morceaux)

Les **binaires** des pièces jointes (collection `attachments`) ne sont PAS dans le `.db` : ils vivent
dans **`/data/documents/attachments/<docId>/`** (un fichier par pièce, nommé par son id — cf.
[`docs/attachments.md`](../docs/attachments.md)). Conséquences d'exploitation :

- **Sauvegarder un document = son `.db` ET son dossier `attachments/<docId>/`** (et restaurer les
  deux ensemble) — un `.db` restauré seul laisse des pièces dont le téléchargement répond 404.
- La **suppression d'un document** emporte le dossier ; le bouton **Maintenance** de l'app purge les
  binaires dont l'enregistrement a disparu (c'est le SEUL mécanisme de purge — une suppression de
  pièce ne supprime jamais son binaire en ligne, l'undo doit pouvoir le retrouver).

### Migration automatique blob → relationnel (2026-07, une fois par document)

Les documents créés avant la migration DB relationnelle stockaient chaque enregistrement en
**blob JSON** (colonne `data`). Depuis la bascule, le serveur travaille sur un **schéma relationnel
typé** (une colonne par champ, index sur les clés étrangères) et **migre chaque fichier legacy
automatiquement, à sa première ouverture** (en pratique : au premier accès après la mise à jour).
Aucune action requise. Déroulé, pour chaque document legacy détecté :

1. **Sauvegarde d'abord** : copie du fichier en **`<doc>.db.pre-relationnel.bak`** (handle fermé,
   `-wal` rapatrié → le `.bak` est auto-suffisant). Un `.bak` déjà présent n'est **jamais écrasé**
   (avertissement dans les logs). Ces `.bak` peuvent être supprimés à la main une fois la migration
   validée — le serveur n'y touche plus.
2. **Migration en une transaction** : chaque enregistrement est relu, normalisé (défauts posés) et
   réinséré en colonnes ; la révision par entité (`updated_rev`, verrou optimiste) est préservée ;
   la méta du document et les images ne bougent pas. Une ligne `INFO` au log récapitule (nombre de
   records, chemin du backup, durée).
3. **En cas d'échec** (enregistrement invalide — ex. champ obligatoire absent) : la transaction est
   **annulée en bloc**, le fichier **reste lisible à l'ancien format**, rien n'est perdu, et l'erreur
   au log **nomme le record fautif** (`collection/id` + cause SQL). Marche à suivre : corriger le
   record nommé dans le fichier legacy (cf. § *Éditer une base à la main*, serveur arrêté) puis
   rouvrir le document — ou restaurer le `.bak` et demander de l'aide avec le message d'erreur.

> 💡 Ceinture-bretelles : avant une mise à jour qui embarque cette migration, faire un **export
> snapshot JSON** de chaque document depuis l'app (menu documents) — c'est un second filet,
> indépendant du `.bak`.

Inspecter le contenu du volume dans le conteneur :
```bash
docker compose exec dc-manager ls -la /data/documents
```

### Éditer une base à la main (client SQLite)

Le compose déclare un service **`sqlite`** sous `profiles: ["tools"]` : il est **inerte**
(`docker compose up` l'ignore), donc **l'image de production n'embarque aucun éditeur de base**.
Il monte le même volume et se place dans `/data/documents`, ce qui suffit à atteindre les fichiers.

```bash
docker compose stop dc-manager        # ⚠️ INDISPENSABLE (voir ci-dessous)
docker compose run --rm sqlite        # ouvre sqlite3 sur certs.db (le profil "tools" s'active seul)
#   sqlite> .tables                    # lister les tables de la base ouverte
#   sqlite> .open notify.db            # basculer sur une AUTRE base (même dossier)
#   sqlite> .quit                      # sortir
docker compose start dc-manager        # redémarrer le serveur après
```

Bases dans `/data/documents/` : `registry.db` (documents), un `<doc>.db` par document, `certs.db`
(PKI), `notify.db`, `interventions.db`, `users.db` (annuaire), `vm-providers.db`,
`wifi-providers.db`, `tracker-providers.db` (trackers de destination de la réplication des
interventions). Le service ouvre **`certs.db`**
par défaut — `.open <base>.db` pour changer (chemins relatifs à `/data/documents`, ex.
`.open registry.db`).

> ⚠️ **Toujours arrêter le serveur avant d'écrire.** Les bases sont ouvertes en **WAL** : deux
> écrivains concurrents, c'est au mieux un timeout, au pire un état incohérent (le serveur garde
> en mémoire des lignes effacées sous lui). À la main, **aucun garde-fou applicatif ne s'applique** :
> penser à `PRAGMA foreign_keys = ON;` avant toute suppression.

---

## 6. Configuration (variables d'environnement)

À régler dans `docker-compose.yml` (section `environment`) :

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | port d'écoute |
| `API_BASE` | `/api` | préfixe des endpoints REST |
| `DOCS_DIR` | `/data/documents` | dossier des documents (registre + 1 `.db`/doc) |
| `AUTH_MODE` | *(vide)* | **mode d'authentification EXPLICITE** : `dev` \| `basic` \| `sso` \| `forward`. Vide → inférence historique (`BASIC_AUTH` → basic, sinon `SSO_URL` → sso, sinon dev). 🚨 valeur inconnue ou incohérente (`oidc`, coquille, `sso` sans `SSO_URL`, `basic` sans `BASIC_AUTH`) → **le serveur refuse de démarrer** (jamais de repli sur le mode dev) |
| `SSO_URL` | *(vide)* | endpoint SSO externe qui valide la session (cf. ci-dessous). **vide → mode dev** |
| `COOKIE_NAME` | *(vide)* | nom du cookie contenant le jeton à proxifier au SSO (`""` = en-tête `Cookie` complet) |
| `SSO_LOGIN_URL` | *(vide)* | URL de connexion SSO du bouton « Connexion » (écran d'accueil, si non authentifié) ; macro `${clbkUrl}` → URL courante encodée. Vide = pas de bouton |
| `DEV_USER` | `dev` | nom de l'utilisateur factice en mode dev |
| `AUTH_FORWARD_USER_HEADER` | `Remote-User` | mode `forward` : en-tête portant le **login** (requis — absent/vide ⇒ anonyme) |
| `AUTH_FORWARD_EMAIL_HEADER` | `Remote-Email` | mode `forward` : en-tête de l'e-mail |
| `AUTH_FORWARD_NAME_HEADER` | `Remote-Name` | mode `forward` : en-tête du nom d'affichage complet |
| `AUTH_FORWARD_GROUPS_HEADER` | `Remote-Groups` | mode `forward` : en-tête des **groupes** (virgules) → table `groups` de `ROLES_FILE` |
| `AUTH_FORWARD_SECRET` | *(vide)* | 🚨 mode `forward` : **secret partagé** proxy↔app (temps constant). Absent → le mode marche mais le boot **avertit** : l'app doit être joignable **uniquement** par le proxy |
| `AUTH_FORWARD_SECRET_HEADER` | `X-Auth-Secret` | mode `forward` : en-tête portant ce secret |
| `ROLES_FILE` | `<DOCS_DIR>/roles.json` | **politique d'AUTORISATION** (rôles/permissions), fichier JSON relu **à chaud** ; **fail-closed** : absent/illisible → personne n'a de rôle, 403 partout sauf `GET /me` (cf. ci-dessous et `docs/auth.md`) |
| `BOOTSTRAP_ADMIN_IDS` | *(vide)* | ids canoniques ou logins séparés par des **virgules** → rôle `admin`, **en plus** du fichier. Amorçage d'un déploiement neuf (sans lui, le premier administrateur serait verrouillé dehors) |
| `DCMANAGER_SECRETS_KEY` | *(vide)* | passphrase de chiffrement des secrets stockés en base (coffre `SecretBox` **partagé**), **≥ 16 caractères**. Consommée par les modules **VM/Proxmox**, **clients wifi**, **réplication des interventions vers un tracker** et **notifications** ; absente → ces modules sont inactifs et leurs routes répondent **503 actionnable**, le serveur démarre quand même (les interventions, elles, restent pleinement fonctionnelles). La générer p. ex. par `openssl rand -base64 32` (cf. `README.md` § 4) |
| `JIRA_BASE_URL` | *(vide)* | base d'URL Jira du module **interventions** (ex. `https://monorg.atlassian.net/browse/`) pour lier une clé **saisie à la main** à son ticket ; vide/absente → pas de lien. Simple référence, aucun appel Jira (cf. `docs/interventions.md`). ⚠ **Sans rapport avec le pont de réplication** (`docs/jira-interventions.md`), qui persiste le lien de chaque ticket au moment de la synchro et n'a donc aucune variable d'environnement propre |

### Authentification

Quatre modes, sélectionnés par **`AUTH_MODE`** (`dev` | `basic` | `sso` | `forward`). Variable
**absente** → inférence historique : `BASIC_AUTH` → basic, sinon `SSO_URL` → sso, sinon dev.

🚨 **Une `AUTH_MODE` inconnue ou incohérente empêche le démarrage** (erreur explicite dans les logs,
scope `[auth]`). C'est voulu : le seul repli possible serait le mode dev, qui n'authentifie personne —
une coquille laisserait un déploiement se croire protégé et grand ouvert. Si le conteneur redémarre en
boucle après un changement, **lire la dernière ligne du log** : elle nomme la variable et la
correction attendue.

> ⚠️ **L'implémentation SSO maison (`SSO_URL`) répond à un besoin PERSONNEL** et attend un contrat très
> spécifique (proxifier un cookie de session vers un endpoint qui renvoie `{ logged, adminRight,
> expireDate }`, accès réservé à `adminRight = "SUPER_ADMIN"`). Elle n'est **probablement pas
> pertinente pour la plupart des déploiements**. Pour un déploiement réel, privilégiez
> **`AUTH_MODE=forward`** derrière un reverse-proxy *identity-aware* (section suivante) ; à défaut, la
> **Basic Auth** (`BASIC_AUTH=user:pass`) protège un serveur sans infrastructure, et le mode dev
> convient à un réseau de confiance. Un provider **OIDC** natif reste à venir.

L'app **ne gère pas l'auth** : le serveur **proxifie le jeton** (cookie `COOKIE_NAME`)
au SSO externe (`SSO_URL`) qui renvoie l'utilisateur
(`logged`, `adminRight`, `expireDate`). Le résultat est **mis en cache** (clé =
hash du cookie) tant que le cookie ne change pas et que `expireDate` n'est pas
dépassée. L'authentification dit **qui** est l'appelant ; ce qu'il a le droit de faire est réglé
séparément (section suivante).
Le refus est distingué par le **code HTTP**, car le client agit différemment :
- **`401` (non authentifié)** quand la session est absente ou **EXPIRÉE** (`logged: false`) → le client
  coupe la session locale et **renvoie au login** (une expiration en cours de session ne se traduit plus
  en erreurs éparses, mais en un retour propre à l'écran de connexion) ;
- **`403` (accès refusé)** quand la session est valide mais **sans la permission** demandée → le client
  reste où il est (se reconnecter n'y changerait rien).

- **Mode dev** (offline, défaut du `docker-compose.yml`) : `SSO_URL=""` →
  utilisateur factice `dev` en SUPER_ADMIN, tout est autorisé.
- **Mode dev + mot de passe** : `BASIC_AUTH=user:pass` (prioritaire sur le SSO) →
  le navigateur demande un user/mot de passe (HTTP Basic) ; identifiants OK →
  SUPER_ADMIN. Pratique pour protéger un serveur de dev sans le SSO.
- **SSO réel** : dans `docker-compose.yml`, renseigner `SSO_URL` (endpoint de validation
  de votre SSO) et, si besoin, `COOKIE_NAME` (nom du cookie portant le jeton ; vide =
  en-tête `Cookie` complet). Ex. `SSO_URL: https://sso.example.com/validate`.
- **Reverse-proxy identity-aware** (recommandé) : `AUTH_MODE=forward` — section suivante.

Après modif du compose : `docker compose up -d` (recrée le conteneur).

### Mode `forward` : le proxy authentifie, l'app lit des en-têtes

Un proxy *identity-aware* (Authelia, Authentik, oauth2-proxy, Pomerium, Cloudflare Access,
Tailscale…) fait le login, la MFA et la session, puis transmet l'identité dans des en-têtes.
L'application n'a **aucun** flux OAuth à porter, et les **groupes** de l'annuaire deviennent des
rôles (table `groups` de `roles.json`, section suivante) : les comptes se gèrent dans l'IdP.

🚨 **Un en-tête est trivial à forger** : qui peut joindre l'app directement peut se déclarer
administrateur. Deux protections, et la première n'est pas optionnelle.

1. **L'app n'est joignable QUE par le proxy** — ne publiez pas son port (`expose:` et non `ports:`
   dans le compose, ou bind sur `127.0.0.1`). Le code ne peut pas le vérifier : c'est votre travail.
2. **Un secret partagé** `AUTH_FORWARD_SECRET`, que le proxy pose dans `X-Auth-Secret`. Configuré, il
   est **exigé** : sans lui, la requête est anonyme. Sans secret configuré, le boot **avertit** —
   surveillez ce WARN, il signale un déploiement dont la seule barrière est le réseau.

**Exemple minimal — Authelia + nginx.** Côté DC Manager (`docker-compose.yml`) :

```yaml
services:
  dc-manager:
    expose: ["3000"]           # PAS `ports:` — seul le proxy doit pouvoir joindre l'app
    environment:
      AUTH_MODE: forward
      AUTH_FORWARD_SECRET: "collez-ici-un-secret-long-et-aleatoire"   # openssl rand -base64 32
      # En-têtes par défaut (Remote-User / Remote-Email / Remote-Name / Remote-Groups) :
      # rien à déclarer avec Authelia ou Authentik.
      BOOTSTRAP_ADMIN_IDS: "jdupont"   # le temps d'écrire roles.json
```

Côté nginx (le bloc `location` de l'app, en plus des réglages du § « reverse proxy ») :

```nginx
location / {
    # 1. délégation de l'authentification à Authelia
    auth_request     /internal/authelia;
    auth_request_set $user   $upstream_http_remote_user;
    auth_request_set $email  $upstream_http_remote_email;
    auth_request_set $name   $upstream_http_remote_name;
    auth_request_set $groups $upstream_http_remote_groups;

    # 2. ⚠ on REPOSE les en-têtes nous-mêmes : `proxy_set_header` ÉCRASE ce que le client
    #    aurait envoyé sous le même nom — sans cela, un `Remote-User` forgé traverserait.
    proxy_set_header Remote-User   $user;
    proxy_set_header Remote-Email  $email;
    proxy_set_header Remote-Name   $name;
    proxy_set_header Remote-Groups $groups;

    # 3. la PREUVE que la requête vient bien de ce proxy (même valeur que AUTH_FORWARD_SECRET)
    proxy_set_header X-Auth-Secret "collez-ici-un-secret-long-et-aleatoire";

    proxy_pass http://dc-manager:3000;
}
# Sous-requête interne vers Authelia (redirection de login gérée par `error_page 401`).
location = /internal/authelia {
    internal;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_pass http://authelia:9091/api/verify;
}
```

Pour **oauth2-proxy** ou **Tailscale**, mêmes principes avec d'autres noms d'en-têtes : renseigner
`AUTH_FORWARD_USER_HEADER` (`X-Forwarded-User`, `Tailscale-User-Login`…) et, s'il y en a,
`AUTH_FORWARD_GROUPS_HEADER`. Tableau complet des conventions par outil : `../docs/auth.md`.

**Vérifier** (depuis le réseau du proxy, avec le secret) :

```bash
curl -s -H "X-Auth-Secret: …" -H "Remote-User: jdupont" -H "Remote-Groups: grp-infra" \
     http://dc-manager:3000/api/me
# → { "logged": true, "user": { "login": "jdupont", "domain": "forward" },
#     "groups": ["grp-infra"], "permissions": [ … ] }
```

Sans le bon `X-Auth-Secret`, la même requête renvoie `logged: false` : c'est le comportement
attendu, et la preuve que le secret est bien exigé.

### Autorisation (rôles & permissions)

Une fois authentifié, l'accès est réglé par un **RBAC à permissions atomiques**
(`dc.ip:update`, `certs:pki`, `documents:manage`…). Référence complète — catalogue, rôles,
procédures : [`../docs/auth.md`](../docs/auth.md).

🚨 **Opt-in strict** : un utilisateur authentifié **sans rôle** n'a aucune permission et reçoit
**403 partout** sauf `GET /me`. C'est voulu, mais ça se prépare avant de basculer un déploiement.

**Rétrocompatibilité** — rien à faire pour un déploiement existant : le mode **dev**, la **Basic
Auth** et le SSO `adminRight = "SUPER_ADMIN"` valent tous le rôle `admin`.

Pour donner des droits **fins**, créer `roles.json` dans `DOCS_DIR` (ou pointer `ROLES_FILE`) :

```jsonc
{
  "users": {
    "jdupont": ["dc-editor"],             // clé = login BRUT, ou id canonique SSO ("42")
    "42": ["cert-manager", "vm-viewer"]
  },
  "groups": {                             // GROUPES de l'IdP (mode forward) → rôles
    "grp-infra": ["dc-editor"],
    "grp-noc": ["vm-viewer", "wifi-viewer"]
  },
  "roles": {                              // rôles CUSTOM optionnels (en plus des presets)
    "cabliste-nuit": ["dc.cabling:*", "dc.rack:read"]
  }
}
```

**La table `groups`** est ce qui rend le mode `forward` payant : les comptes se gèrent dans l'IdP, et
ce fichier ne décrit plus que la traduction « groupe d'entreprise → rôle applicatif ». Un nouvel
arrivant du bon groupe a ses droits **sans** qu'on touche à `roles.json`. Les rôles effectifs sont
l'**union** du nominatif et des groupes (composition additive : rien ne se masque). Écrire le nom du
groupe **exactement** comme l'IdP l'envoie — la correspondance est sensible à la casse ;
`GET <API_BASE>/me` affiche ce que le serveur reçoit vraiment (`groups`).

Rôles fournis : `admin`, `dc-viewer`, `dc-editor`, `dc-connector`, `vm-viewer`, `vm-operator`,
`wifi-viewer`, `wifi-operator`, `cert-viewer`, `cert-manager`, `intervention-viewer`,
`intervention-editor`, `notify-manager`.

À savoir en exploitation :

- **Relu à chaud** (sondage ~2 s) : aucun redémarrage après édition. Les avertissements de lecture
  (clé inconnue, grant mal orthographié) sortent dans les logs, scope `[access]`.
- **Fail-closed.** Fichier **absent** → personne n'a de rôle. Fichier **illisible** (JSON tronqué en
  cours d'édition) → la **dernière politique valide reste en vigueur** et une ERROR est journalisée :
  une faute de frappe ne déconnecte pas l'équipe. Vérifier les logs après chaque édition.
- **Amorçage** : `BOOTSTRAP_ADMIN_IDS=42,jdupont` promeut ces ids/logins `admin` en plus du fichier —
  indispensable sur un déploiement neuf, et utile comme filet si le fichier est cassé.
- La correspondance id/login/**groupe** est **exacte** (sensible à la casse) ; au besoin, déclarer les
  deux graphies. Pour connaître l'identité vue par le serveur, appeler `GET <API_BASE>/me` : il renvoie
  `user`, ses `groups` et la liste `permissions` effective.
- **Rétrocompatibilité, et le mode `forward`** : dev, Basic Auth et SSO `SUPER_ADMIN` valent `admin`,
  mais le mode `forward` n'a **aucune** règle de ce genre. Un utilisateur authentifié par le proxy et
  absent de `users` **comme** de `groups` n'a donc aucune permission (403 partout sauf `/me`) — c'est
  l'opt-in strict : prévoir `BOOTSTRAP_ADMIN_IDS` ou une entrée `groups` **avant** de basculer.

---

## 7. Importer un document `.json` dans la base

Script `scripts/import-json.mjs` : crée un document serveur depuis un export
`.json` (format mode-fichier), pousse les données, et importe les images de
façade (inline `faceImages` **ou** compagnon `.nmfb`).

```bash
# serveur lancé (dev) :
node scripts/import-json.mjs ../Samples/mondoc.json --name "Mon doc"
# avec compagnon d'images :
node scripts/import-json.mjs ../Samples/mondoc.json ../Samples/mondoc.nmfb --name "Mon doc"
# serveur distant + auth :
node scripts/import-json.mjs doc.json --url https://dc-manager.example.com --cookie "SsoJWT=…"
node scripts/import-json.mjs doc.json --url http://host:3000 --basic dev:secret
```

(`node` requis sur la machine qui lance le script ; le serveur, lui, tourne dans Docker.)

## 8. Dépannage

| Symptôme | Cause probable / solution |
|---|---|
| **404 sur les endpoints dans le navigateur** | Ancien bundle en cache → **Ctrl+Shift+R** (hard refresh). |
| **Page blanche / vieille version** | Idem : hard refresh, ou vider le cache du site. |
| **`port is already allocated`** | Le port 3000 est pris : changer `ports: "3001:3000"` dans le compose. |
| **`Cannot connect to the Docker daemon`** | Docker Desktop n'est pas démarré. |
| **Conteneur en `Restarting`/`Exited`** | `docker compose logs --tail 50` pour voir l'erreur de démarrage. |
| **`Client introuvable`** (503 sur `/`) | Le build du client a échoué : `docker compose up --build` et regarder les logs de build. |
| **Aucun cluster affiché / test provider VM en échec** (logs : `SecretBox : déchiffrement refusé … le secret doit être ressaisi`) | La valeur de `DCMANAGER_SECRETS_KEY` a **changé** (c'est la **seule** variable lue pour ce coffre) → les jetons chiffrés au repos ne sont plus déchiffrables. Même symptôme et même correctif pour les providers **wifi** et les providers de **réplication vers un tracker**, qui partagent ce coffre. La vue Clusters montre désormais le provider en **« Provider en erreur »** et « Tester » renvoie le message. **Solution** : ré-ouvrir le provider (Providers… → Modifier), **ressaisir le jeton**, Enregistrer — ou restaurer l'ancienne valeur de la clé. Détails : [`docs/vm-proxmox.md`](../docs/vm-proxmox.md) § Dépannage. |
| **Repartir totalement de zéro** | `docker compose down -v && docker compose up -d --build`. |
