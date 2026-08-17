# Authentification & autorisation — configuration

*Pour le technicien qui déploie/exploite — le modèle, les contrats et l'implémentation sont dans
[`docs/auth.md`](../docs/auth.md).*

Deux questions distinctes, réglées séparément :

- **Authentification** — *qui est l'appelant ?* L'application **ne gère pas le login** : elle
  délègue, selon le mode choisi (§ 1 à 3).
- **Autorisation** — *que peut-il faire ?* Un RBAC à permissions atomiques, piloté par un fichier
  `roles.json` (§ 4).

Toutes les variables citées ici figurent dans la table de référence :
[`configuration.md`](configuration.md).

---

## 1. Choisir le mode — `AUTH_MODE`

Cinq modes : `dev` | `basic` | `sso` | `forward` | `oidc`.

| Mode | Pour qui | Ce qu'il exige |
|---|---|---|
| `dev` | essai local, réseau de confiance | rien — **aucune authentification**, tout appelant est administrateur |
| `basic` | serveur de développement à protéger sans infrastructure | `BASIC_AUTH=user:pass` |
| `sso` | l'instance SSO maison de l'auteur (besoin **personnel**) | `SSO_URL` (+ `COOKIE_NAME`) |
| `forward` | **recommandé** — un reverse-proxy *identity-aware* est déjà en place | le proxy pose des en-têtes ; `AUTH_FORWARD_SECRET` vivement conseillé |
| `oidc` | **recommandé** — pas de proxy *identity-aware* disponible | `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URL` |

**`AUTH_MODE` fait loi** quand elle est renseignée. Absente, l'**inférence historique** s'applique,
inchangée : `BASIC_AUTH` → basic, sinon `SSO_URL` → sso, sinon dev. Les modes `forward` et `oidc` ne
sont **jamais** inférés : ils exigent une configuration délibérée.

### 🚨 Une valeur inconnue ou incohérente empêche le démarrage

`AUTH_MODE=frobnique`, `AUTH_MODE=forwrad` (coquille), `AUTH_MODE=sso` sans `SSO_URL`,
`AUTH_MODE=basic` sans `BASIC_AUTH`, `AUTH_MODE=oidc` sans l'une de ses trois variables requises : le
serveur **journalise une erreur nommant la variable et la correction attendue** (scope `[auth]`),
puis s'arrête.

C'est voulu, et c'est le point important du mécanisme : le seul repli possible serait le mode `dev`,
qui n'authentifie personne. Une coquille retombant en silence sur lui laisserait un déploiement se
croire protégé et grand ouvert. `AUTH_MODE=dev` **écrit explicitement** reste permis, avec le même
avertissement de démarrage qu'un mode dev par défaut.

> **Si le conteneur redémarre en boucle après un changement d'authentification**, lire la dernière
> ligne du log : elle nomme précisément ce qui manque.

---

## 2. Mode `forward` — le proxy authentifie, l'application lit des en-têtes

Un proxy *identity-aware* (Authelia, Authentik, oauth2-proxy, Pomerium, Cloudflare Access,
Tailscale…) fait le login, la MFA et la session, puis transmet l'identité dans des en-têtes.
L'application n'a **aucun** flux OAuth à porter, et les **groupes** de l'annuaire deviennent des
rôles (table `groups` de `roles.json`, § 4) : les comptes se gèrent dans l'IdP.

### En-têtes attendus (configurables)

| Variable | Défaut | Contenu attendu |
|---|---|---|
| `AUTH_FORWARD_USER_HEADER` | `Remote-User` | **login** — requis : absent ou vide ⇒ appelant **anonyme** |
| `AUTH_FORWARD_EMAIL_HEADER` | `Remote-Email` | adresse e-mail |
| `AUTH_FORWARD_NAME_HEADER` | `Remote-Name` | nom d'**affichage complet** |
| `AUTH_FORWARD_GROUPS_HEADER` | `Remote-Groups` | groupes séparés par des **virgules** |
| `AUTH_FORWARD_SECRET` | *(vide)* | **secret partagé** proxy ↔ application |
| `AUTH_FORWARD_SECRET_HEADER` | `X-Auth-Secret` | en-tête portant ce secret |

Il n'y a volontairement pas de « profils » par marque : c'est à l'exploitant de **renommer** les
en-têtes selon ce que son proxy pose réellement.

| Outil | Utilisateur | Groupes |
|---|---|---|
| Authelia / Authentik | `Remote-User` | `Remote-Groups` |
| oauth2-proxy | `X-Forwarded-User` (ou `X-Forwarded-Preferred-Username`) | `X-Forwarded-Groups` |
| Cloudflare Access | `Cf-Access-Authenticated-User-Email` | *(néant — l'appartenance vit dans les politiques Access)* |
| Tailscale (`tailscale serve`) | `Tailscale-User-Login` | *(néant)* |

### 🚨 Modèle de confiance — le point capital

Un en-tête est **trivial à forger** : qui peut joindre l'application directement peut se déclarer
administrateur. Deux protections, et la première n'est pas optionnelle.

1. **L'application n'est joignable QUE par le proxy** — ne publiez pas son port (`expose:` et non
   `ports:` dans le compose, ou bind sur `127.0.0.1`, ou règle de pare-feu). Le code ne peut pas le
   vérifier : c'est votre travail.
2. **Un secret partagé** `AUTH_FORWARD_SECRET`, que le proxy pose dans `AUTH_FORWARD_SECRET_HEADER`.
   Configuré, il est **exigé** : toute requête dont l'en-tête ne correspond pas est anonyme, et
   **aucun autre en-tête n'est même lu**. Sans secret configuré, le démarrage **avertit** —
   surveillez cet avertissement, il signale un déploiement dont la seule barrière est le réseau.

> **Consigne de déploiement.** Dans le proxy, **effacer** les en-têtes d'identité venus du client
> avant de les reposer soi-même (`proxy_set_header` sous nginx écrase ; sous Apache,
> `RequestHeader unset` puis `set`) : sans cela, un client qui envoie son propre `Remote-User` peut
> le voir traverser. Le secret partagé rend cette faute inoffensive — raison de plus pour le
> configurer.

### Exemple minimal — Authelia + nginx

Côté DC Manager (`docker-compose.yml`) :

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

Côté nginx — le bloc `location` de l'application, **en plus** des réglages de
[`reverse-proxy.md`](reverse-proxy.md) :

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
`AUTH_FORWARD_GROUPS_HEADER`.

### Vérifier

Depuis le réseau du proxy, avec le secret :

```bash
curl -s -H "X-Auth-Secret: …" -H "Remote-User: jdupont" -H "Remote-Groups: grp-infra" \
     http://dc-manager:3000/api/me
# → { "logged": true, "user": { "login": "jdupont", "domain": "forward" },
#     "groups": ["grp-infra"], "permissions": [ … ] }
```

Sans le bon `X-Auth-Secret`, la même requête renvoie `logged: false` : c'est le comportement attendu,
et la preuve que le secret est bien exigé.

---

## 3. Mode `oidc` — l'application parle elle-même à votre IdP

Pour les déploiements **sans** proxy *identity-aware*. L'application devient le *Relying Party* d'un
OP (Keycloak, Entra ID, Authelia en mode OP, Authentik…) en flux **Authorization Code + PKCE**, et
sert trois routes publiques : `/auth/login`, `/auth/callback`, `/auth/logout`.

### Exemple minimal — Keycloak

Dans le realm, créer un client :

| Réglage Keycloak | Valeur |
|---|---|
| *Client ID* | `dcmanager` |
| *Client authentication* | **Off** = client public (PKCE seul) · **On** = confidentiel (donne un secret) |
| *Valid redirect URIs* | `https://dcmanager.exemple/auth/callback` — **exactement** `OIDC_REDIRECT_URL` |
| *Valid post logout redirect URIs* | `https://dcmanager.exemple/` (la racine de l'application) |
| *Client scopes* | ajouter un scope `groups` (mappeur *Group Membership*) si vous voulez les groupes |

Puis, dans `docker-compose.yml` :

```yaml
environment:
  AUTH_MODE: oidc
  OIDC_ISSUER: https://keycloak.exemple/realms/infra
  OIDC_CLIENT_ID: dcmanager
  OIDC_REDIRECT_URL: https://dcmanager.exemple/auth/callback
  # OIDC_CLIENT_SECRET: …              # seulement si le client est CONFIDENTIEL
  # OIDC_SCOPES: openid profile email  # si l'IdP refuse le scope `groups` du défaut
  BOOTSTRAP_ADMIN_IDS: "<le `sub` ou le login de votre compte>"   # amorçage du 1er administrateur
```

Les **groupes** de l'IdP se traduisent en rôles par la table `groups` de `ROLES_FILE`, exactement
comme en mode `forward` (§ 4). Le bouton « Connexion » de l'écran d'accueil fonctionne **sans**
`SSO_LOGIN_URL` : elle se défaut sur `auth/login`.

### Ce qu'il faut savoir avant de déployer

- 🚨 **`OIDC_REDIRECT_URL` est requise et n'est pas devinée.** Derrière un reverse-proxy à
  sous-chemin, l'application ne connaît pas son URL publique ; une valeur fausse donne un
  `redirect_uri_mismatch` côté IdP. Elle doit se terminer par `/auth/callback` (sinon :
  avertissement au démarrage).
- **L'émetteur doit être en HTTPS** — la découverte refuse un émetteur HTTP.
- **Un redémarrage du serveur déconnecte tout le monde** : les sessions sont en mémoire (limite v1
  assumée). En pratique, le navigateur revient authentifié sans rien retaper, la session de l'IdP
  survivant à la nôtre.
- **Plusieurs instances** derrière un répartiteur exigent des sessions **collantes**, ou le mode
  `forward`.
- **Pas de rafraîchissement de jeton** : la session vaut la durée de l'`id_token`, plafonnée à 12 h.
  À l'échéance, l'utilisateur repasse par le flux de connexion.
- **IdP injoignable au démarrage ? Le serveur démarre quand même.** La découverte est réessayée en
  tâche de fond ; en attendant, `/auth/login` répond **503 avec un message actionnable** (il nomme
  `OIDC_ISSUER` et la dernière erreur) et `/api/me` répond « anonyme ». Un IdP qui monte après nous
  ne doit pas empêcher le service de démarrer.
- **Déconnexion** : l'application efface toujours sa propre session, puis redirige vers l'IdP
  seulement si celui-ci annonce un `end_session_endpoint`. Sinon, la session de l'IdP survit à la
  nôtre et une reconnexion sera silencieusement ré-authentifiée — limite du protocole.
- `OIDC_COOKIE_SECURE=0` n'est **que** pour du HTTP local ; le démarrage l'avertit.

---

## 4. Autorisation — rôles, permissions et `roles.json`

Une fois authentifié, l'accès est réglé par un **RBAC à permissions atomiques**
(`dc.ip:update`, `certs:pki`, `documents:manage`…).

🚨 **Opt-in strict** : un utilisateur authentifié **sans rôle** n'a aucune permission et reçoit
**403 partout** sauf `GET /me`. C'est voulu, mais ça se prépare **avant** de basculer un déploiement.

**Rétrocompatibilité** — rien à faire pour un déploiement existant : les modes **dev** et **basic**,
ainsi que le SSO maison avec `adminRight = "SUPER_ADMIN"`, valent tous le rôle `admin`. Le mode
`forward`, lui, n'a **aucune** règle de ce genre : c'est de l'opt-in strict.

### Le fichier

Créer `roles.json` dans `DOCS_DIR` (ou pointer `ROLES_FILE` ailleurs) :

```jsonc
{
  "users": {
    "jdupont": ["dc-editor"],             // clé = login BRUT…
    "42": ["cert-manager", "vm-viewer"],  // …ou id CANONIQUE (le `sub` OIDC, l'id SSO)
    "zoe": ["cabliste-nuit"]
  },
  "groups": {                             // GROUPES de l'IdP (modes forward et oidc) → rôles
    "grp-infra": ["dc-editor"],
    "grp-noc": ["vm-viewer", "wifi-viewer"]
  },
  "roles": {                              // rôles CUSTOM optionnels (en plus des presets)
    "cabliste-nuit": ["dc.cabling:*", "dc.rack:read"]
  }
}
```

### La table `groups` — la gestion des utilisateurs retourne dans l'IdP

C'est elle qui rend les modes `forward` et `oidc` payants : le fichier ne décrit plus des personnes
mais la **traduction** « groupe d'entreprise → rôle applicatif ». Un nouvel arrivant du bon groupe a
ses droits **sans** qu'on touche à `roles.json`.

- Les rôles effectifs sont l'**union** de `users[id]`, `users[login]` et de `groups[g]` pour chacun
  des groupes de l'identité. Union et non priorité : la composition est purement **additive**, rien
  ne se masque, l'ordre est indifférent.
- La correspondance — utilisateur **comme** groupe — est **exacte et sensible à la casse**. Écrire le
  nom du groupe **exactement** comme l'IdP l'envoie ; au besoin, déclarer les deux graphies.
- **Pas de bucket `default`** : un utilisateur absent du fichier, et dont aucun groupe n'y figure,
  n'a aucun rôle.
- Une définition locale portant le nom d'un preset le **masque** (le fichier est l'autorité du
  déploiement ; un avertissement le rappelle au chargement).

`GET <API_BASE>/me` affiche ce que le serveur reçoit vraiment : `user`, ses `groups` et la liste
`permissions` effective. C'est l'outil de diagnostic à utiliser en premier.

### Rôles fournis (13 presets)

| Rôle | Grants |
|---|---|
| `admin` | `*` |
| `dc-viewer` | `dc.*:read` |
| `dc-editor` | `dc.*:*` |
| `dc-connector` | `dc.cabling:*`, `dc.equipment:read`, `dc.rack:read`, `dc.site:read` |
| `vm-viewer` | `vm:read` |
| `vm-operator` | `vm:read`, `vm:sync`, `vm:create`, `vm:update`, `vm:delete` |
| `wifi-viewer` | `wifi:read` |
| `wifi-operator` | `wifi:read`, `wifi:sync`, `wifi:create`, `wifi:update`, `wifi:delete` |
| `cert-viewer` | `certs:read` |
| `cert-manager` | `certs:read`, `certs:write` (**pas** `certs:pki`) |
| `intervention-viewer` | `interventions:read`, `tracker:read` |
| `intervention-editor` | `interventions:read`, `interventions:write`, `tracker:read`, `tracker:push` |
| `notify-manager` | `notify:*`, `dc.contact:*` |

Deux choix à connaître : les **opérateurs VM/wifi sont énumérés** plutôt qu'écrits `vm:*` — la
gestion des providers, qui porte des **jetons**, reste hors de leur périmètre (permissions
`vm.providers:manage` / `wifi.providers:manage`, à réserver) ; et **`cert-manager` n'a pas
`certs:pki`** — les cérémonies de coffre sont irréversibles si elles sont mal menées.

Catalogue complet des permissions atomiques et carte des collections → domaines :
[`docs/auth.md`](../docs/auth.md) §§ 2-3.

### À savoir en exploitation

- **Relu à chaud** (sondage ~2 s) : aucun redémarrage après édition. Les avertissements de lecture
  (clé inconnue, grant mal orthographié) sortent dans les logs, scope `[access]`. **Vérifier les logs
  après chaque édition** — un grant hors catalogue est presque toujours une coquille, et l'exploitant
  croirait avoir donné un droit.
- **Fail-closed, avec une nuance :**

  | Situation | Effet |
  |---|---|
  | Fichier **absent** (ou supprimé à chaud) | politique **vide adoptée**, avertissement. C'est aussi l'état d'un déploiement neuf. |
  | Fichier **présent mais illisible** (JSON tronqué en cours d'édition, droits retirés) | la **dernière politique valide reste en vigueur**, une erreur est journalisée. Une faute de frappe ne déconnecte pas l'équipe. |
  | **Premier** chargement illisible | il n'y a pas de « dernière valide » → politique **vide**. |

- **Tolérant en forme, strict en droit** : une clé de premier niveau inconnue est ignorée et
  signalée (le fichier reste exploitable) ; une valeur mal typée n'accorde **rien** (jamais de
  coercition).
- **Amorçage** — `BOOTSTRAP_ADMIN_IDS=42,jdupont` promeut ces ids ou logins `admin` **en plus** du
  fichier. Indispensable sur un déploiement neuf (sans lui, le premier administrateur serait
  verrouillé dehors par la politique qu'il doit écrire), et utile comme filet si le fichier casse.

---

## 5. Sémantique 401 / 403, vue de l'exploitant

Les deux refus ne se diagnostiquent pas de la même façon, parce que le client n'y réagit pas pareil :

| Code | Quand | Ce que fait le client | Ce que ça veut dire pour vous |
|---|---|---|---|
| **401** | session absente ou **expirée** | coupe la session locale et **renvoie au login** | problème d'**authentification** : proxy, IdP, cookie, secret partagé |
| **403** | authentifié, mais **sans la permission** demandée | reste où il est (se reconnecter n'y changerait rien) | problème d'**autorisation** : `roles.json`, groupes, opt-in strict |

Un refus de route **nomme la permission manquante** dans le corps de la réponse (champ `permission`) :
c'est le point de départ du diagnostic. Un utilisateur qui voit un écran « aucun accès » est
authentifié mais sans aucun rôle — c'est l'opt-in strict qui s'applique.

---

## 6. Le SSO maison (`SSO_URL`) — un besoin personnel

> ⚠️ L'intégration **SSO maison** répond à un **besoin personnel** : elle attend un contrat très
> spécifique (proxifier un cookie de session vers un endpoint qui renvoie
> `{ logged, adminRight, expireDate }`, accès réservé à `adminRight = "SUPER_ADMIN"`). Elle n'est
> **probablement pas adaptée à la plupart des déploiements.**
>
> Pour un déploiement réel, préférer **`AUTH_MODE=forward`** (§ 2) si un reverse-proxy
> *identity-aware* est en place, ou **`AUTH_MODE=oidc`** (§ 3) sinon. À défaut, la **Basic Auth**
> (`BASIC_AUTH=user:pass`) protège un serveur sans infrastructure, et le mode dev convient à un
> réseau de confiance.

Configuration : `SSO_URL` (endpoint de validation), et si besoin `COOKIE_NAME` (nom du cookie portant
le jeton ; vide = l'en-tête `Cookie` complet est transmis). Le résultat est mis en cache tant que le
cookie ne change pas et que `expireDate` n'est pas dépassée.
