# Authentification & autorisation (RBAC)

Deux questions **orthogonales**, deux mécanismes qu'on ne fusionne pas :

- **QUI est l'appelant ?** — l'*authentification*. Cinq modes, dont **un seul** conduit lui-même un
  login : `oidc`, où l'application est le *Relying Party* d'un OP. Les quatre autres délèguent —
  cookie proxifié à un SSO maison, en-têtes d'un reverse-proxy *identity-aware*, challenge Basic,
  ou mode dev. C'est un **orchestrateur** (`src-server/src/auth.ts`, `Auth`) et **un provider par
  mode** (`src-server/src/auth/`) — décrits à la section suivante ; le mode d'emploi côté
  exploitation vit dans `README.md` § 4 et [`../src-server/RUN.md`](../src-server/RUN.md)
  § « Authentification ».
- **CE QU'IL PEUT** — l'*autorisation*, objet de ce document. Un **RBAC à permissions atomiques** :
  un catalogue de permissions, des rôles qui les regroupent, une politique qui associe des rôles à
  des utilisateurs, et des **gardes** posées sur chaque route.

Les deux se rejoignent en un seul point, au bootstrap (`index.ts`), où la validation de session est
**injectée** dans le contrôle d'accès. Changer de mode d'authentification ne touche donc pas à la
politique, et inversement.

## Vue d'ensemble

```
  REQUÊTE ─► requireAuth (garde GLOBALE, api.ts)                          ┌── src-shared/Permissions ──┐
              │  ① Auth.validate  ──────────────►  session (QUI)          │  carte collection→domaine  │
              │     !logged ⇒ 401                                         │  catalogue atomique        │
              │  ② RoleProvider.rolesOf ────────►  rôles                   │  ROLE_PRESETS              │
              │     (FileRoleProvider : roles.json + BOOTSTRAP_ADMIN_IDS)  │  PermissionSet (jokers)    │
              │  ③ rôles → grants → PermissionSet ──────────────┐         └────────────┬───────────────┘
              │     set VIDE ⇒ 403  (« authentifié ≠ autorisé ») │                      │ (partagé front ⇄ back)
              ▼                                                  ▼                      ▼
        GARDE DE ROUTE                                     req.authAccess          CLIENT (mode API)
          access.require("dc.ip:update")                                            reconstruit le même
          access.requireCollection("read")   ─ 403 { permission } ─►                PermissionSet depuis
          access.requireBatch / requireAnyDocRead / …                               `GET /me`.permissions
              │
              ▼  HANDLER
```

## L'authentification — un orchestrateur, un provider par mode

`Auth` ne sait pas authentifier : il **choisit au boot** celui qui sait, puis lui ajoute les trois
services transverses qui ne dépendent d'aucun mode. C'est le patron *interface / implémentation
sélectionnée au câblage / injection* déjà tenu par [`UserResolver`](user-resolver.md) et par
`RoleProvider` (§ 5) — appliqué ici au dernier `switch` sur un mode qui restait dans le serveur.

```
  auth.ts  ── Auth (ORCHESTRATEUR)
   │   ① cache de session : clé = SHA-256 du jeton présenté, durée = expireDate
   │   ② capture d'annuaire : ProfileSink.remember (jamais un non-loggé)
   │   ③ annonce du mode au boot (WARN quand rien ne contrôle l'accès)
   │   ④ `mode` exposé — server.ts y accroche le gate de transport Basic
   │
   ├── auth/AuthModeResolution.ts  ── quel mode monter ? (PUR : AUTH_MODE ou inférence)
   │
   └── auth/AuthProvider.ts  ── CONTRAT (types seuls, aucun import)
         authenticate(req: AuthRequestView): Promise<SsoResult | null>   // null = anonyme
         sessionKey?(req): string | null                                  // OPTIONNEL — cf. plus bas
         │
         ├── auth/DevAuthProvider.ts           (défaut)
         ├── auth/BasicAuthProvider.ts         (BASIC_AUTH)          ─┐ secret comparé à temps
         ├── auth/LegacySsoAuthProvider.ts     (SSO_URL + COOKIE_NAME, │ constant par le helper
         │                                      `fetch` injecté)      │ auth/SecretCompare.ts
         ├── auth/ForwardHeaderAuthProvider.ts (en-têtes de proxy)   ─┘ groupes nettoyés par
         │                                                             le helper auth/GroupList.ts
         └── auth/OidcAuthProvider.ts          (cookie → session mémoire)  ─┘ (même helper)
               └── le FLUX vit à côté : auth/OidcRoutes.ts (login/callback/logout),
                   auth/OidcSessionStore.ts, auth/OidcConfig.ts, et la couche
                   auth/OpenIdClientAdapter.ts derrière le contrat auth/OidcClientPort.ts
```

**Les cinq modes** :

| Mode | Sélection | Ce que le provider rend |
|---|---|---|
| `basic` | `BASIC_AUTH="user:pass"` — **prioritaire** dans l'inférence | session `SUPER_ADMIN` + `dev: true` si les identifiants sont bons, sinon anonyme |
| `sso` | `SSO_URL` (sinon) | le **JSON du SSO, tel quel** (cf. passthrough ci-dessous) |
| `dev` | aucun des deux (défaut) | l'utilisateur factice `DEV_USER` (défaut `dev`), `SUPER_ADMIN` + `dev: true` |
| `forward` | `AUTH_MODE=forward` **uniquement** — jamais inféré | l'identité lue dans les en-têtes du reverse-proxy, avec ses **groupes** (§ « Forward-auth ») |
| `oidc` | `AUTH_MODE=oidc` **uniquement** — jamais inféré | l'identité de la **session locale** ouverte par le flux OIDC, avec ses **groupes** (§ « OIDC ») |

Les deux derniers ne s'infèrent jamais : ils exigent une configuration délibérée, et une instance ne
doit pas basculer de mode d'authentification parce qu'une variable a été ajoutée à côté.

La règle de format de `BASIC_AUTH` vit **chez le provider basic** (`fromSpec`) : « la valeur ne
décrit pas un couple » et « pas de mode basic » sont la même réponse, et l'orchestrateur n'a pas à
connaître le format d'un secret qui ne le concerne pas.

### `AUTH_MODE` — la sélection explicite, et son refus de démarrer

`AUTH_MODE` (`dev | basic | sso | forward | oidc`) **fait loi** quand elle est renseignée. Absente,
c'est l'**inférence historique** qui s'applique, inchangée : `BASIC_AUTH` → basic, sinon `SSO_URL` →
sso, sinon dev (avec son WARN). Un déploiement existant ne voit donc rien changer, et les modes
`forward` et `oidc` ne peuvent pas s'activer par accident.

🚨 **Une valeur inconnue ou incohérente NE DÉMARRE PAS.** `AUTH_MODE=frobnique` (valeur inconnue),
`AUTH_MODE=forwrad` (coquille), `AUTH_MODE=sso` sans `SSO_URL`, `AUTH_MODE=basic` sans `BASIC_AUTH`,
`AUTH_MODE=oidc` sans `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_REDIRECT_URL` (refusées **une à une**,
pour que le message nomme *celle* qui manque) : `log.error` nommant la variable et la correction
attendue, puis arrêt du process. C'est le point
important du mécanisme, pas un détail d'ergonomie — le seul repli possible serait le mode `dev`, qui
n'authentifie personne : une coquille retombant en silence sur lui laisserait un déploiement se
croire protégé et grand ouvert (**fail-open**). `AUTH_MODE=dev` **écrit explicitement** reste permis,
avec le même WARN qu'un mode dev par défaut.

La décision est une logique **pure** (`auth/AuthModeResolution` : faits d'environnement →
`{ mode, error }`, `mode: null` quand la configuration est douteuse — il n'existe alors *aucun* mode,
et pas « le mode par défaut »). L'orchestrateur la consomme et **jette** ; le bootstrap
(`index.ts`) journalise et sort. Un objet `Auth` ne peut donc pas exister dans un état de
configuration ambigu. Corollaire tenu au passage : le provider basic n'est retenu que si le mode
`basic` l'est — un `BASIC_AUTH` oublié dans l'environnement d'un déploiement `forward` ne fait plus
challenger personne (sous l'inférence, les deux conditions coïncident).

**Express n'entre pas dans le contrat.** Un provider ne voit qu'une vue minimale de la requête —
`AuthRequestView { headers: { cookie?, authorization?, [nom]: string | string[] } }` — dont le
`Request` d'Express est un sur-ensemble **structurel**. Même doctrine que l'`AccessRequest`
d'`access/AccessControl`, et mêmes bénéfices : les providers sont **testables sans monter de serveur**
(`Tests/modules/test-auth-providers.js`), et ils ne dépendent pas d'une version d'Express (le
programme de test du dépôt n'en résout pas la même que le serveur). Un provider qui aurait besoin
d'autre chose que des en-têtes ferait plus que « lire l'identité présentée » : l'élargissement doit
rester un geste délibéré sur le contrat.

> L'**index de signature** des en-têtes est précisément un de ces gestes délibérés : le mode forward
> lit des en-têtes dont les **noms sont configurables** (`Remote-User` par défaut, renommés pour
> oauth2-proxy ou Tailscale), donc non énumérables dans le type. Le contrat reste borné aux en-têtes
> — ni chemin, ni corps, ni IP. Un en-tête **répété** arrivant en `string[]`, la normalisation
> (première valeur) est faite en **un** point (`ForwardHeaderAuthProvider.headerValue`).

### Ce que l'orchestrateur garde, et pourquoi

- **Le cache de session** est à lui, pas aux providers — mais il ne s'applique qu'à ceux qui savent
  **nommer** la session présentée (`sessionKey`, optionnelle). Aujourd'hui, seul le SSO l'implémente
  (elle rend le jeton ; `Auth` le **hache** avant d'en faire une clé — un secret ne devient pas un
  identifiant en clair). Dev et basic répondent de mémoire, sans le moindre appel sortant : les
  mettre en cache n'économiserait rien et ouvrirait une fenêtre pendant laquelle une identité
  révoquée resterait valide. Durée : `expireDate` pour une session authentifiée, **une minute** pour
  tout le reste — assez pour absorber une rafale, trop peu pour qu'une identité rétablie attende, et
  c'est aussi ce qui évite de **marteler un SSO déjà en difficulté**.
- **La capture d'annuaire** (`ProfileSink`, cf. [`user-resolver.md`](user-resolver.md)) : sur
  défaut de cache uniquement, et **jamais** un profil non loggé.
- **L'annonce du mode au démarrage** : WARN bien visible en mode dev (aucune authentification, tout
  appelant est `SUPER_ADMIN`), INFO descriptive sinon.

### `SsoResult` est le principal — il n'y en a pas deux

Le type de session **reste `SsoResult`** (`auth/AuthProvider.ts`), et il est le seul modèle
d'identité : `GET /me` en fait un passthrough additif (§ 7), le client le consomme tel quel, et le
contrôle d'accès n'en voit qu'un sous-ensemble **structurel** qu'il déclare chez lui
(`AccessControl.AccessSession`). Un second type « normalisé » n'ajouterait qu'une conversion à tenir
à jour des deux côtés.

Il porte un champ **`groups?: string[]`** — groupes bruts de l'annuaire d'entreprise, jamais
calculés par l'application. **Vide partout aujourd'hui** : aucun des trois providers n'a de groupes
à donner. Il est déclaré maintenant parce qu'il est la moitié manquante de la frontière auth ⇄
autorisation : les providers d'en-têtes de reverse-proxy et OIDC le rempliront, et la politique de
rôles pourra mapper « groupe → rôles » sans qu'on touche ni au type de session, ni au contrat.

**Passthrough SSO, et c'est un engagement** : le provider legacy rend le JSON du SSO *tel quel*, les
champs que nous ne connaissons pas compris (l'index de signature de `SsoResult` les porte). Un
déploiement peut en dépendre — ne rien normaliser là n'est pas une paresse.

**Fail-closed** : SSO injoignable, en erreur HTTP, ou répondant autre chose qu'un objet → session
**anonyme** (`ANONYMOUS_SESSION`, définie une seule fois avec le type). Le jeton, lui, n'apparaît
dans **aucun** log : les messages nomment l'URL et le code, jamais le secret de session.

### Forward-auth — l'identité vient du reverse-proxy

Un proxy *identity-aware* (Authelia, Authentik, oauth2-proxy, Pomerium, Cloudflare Access,
Tailscale…) authentifie en amont — login, MFA, session, déconnexion — puis **passe** l'identité à
l'application dans des en-têtes. L'app ne gère alors **aucun** flux OAuth, aucun cookie, aucune
expiration : elle lit. C'est le mode qui colle au déploiement réel (l'app est déjà derrière un proxy,
cf. [`reverse-proxy.md`](reverse-proxy.md)) et celui qui rend l'**IdP maître des utilisateurs**, la
table `groups` de `roles.json` traduisant ses groupes en rôles (§ 5).

**En-têtes configurables**, défauts = famille `Remote-*` :

| Variable | Défaut | Contenu attendu |
|---|---|---|
| `AUTH_FORWARD_USER_HEADER` | `Remote-User` | **login** — requis : absent ou vide ⇒ appelant **anonyme** |
| `AUTH_FORWARD_EMAIL_HEADER` | `Remote-Email` | adresse e-mail (`user.eMail`) |
| `AUTH_FORWARD_NAME_HEADER` | `Remote-Name` | nom d'**affichage complet** (`user.nom`) |
| `AUTH_FORWARD_GROUPS_HEADER` | `Remote-Groups` | groupes séparés par des **virgules** (rognés, vides écartées, doublons fondus) |
| `AUTH_FORWARD_SECRET` | *(vide)* | **secret partagé** proxy↔app — cf. le modèle de confiance ci-dessous |
| `AUTH_FORWARD_SECRET_HEADER` | `X-Auth-Secret` | en-tête portant ce secret |

Pour un autre outil, l'exploitant **renomme** les en-têtes ; il n'y a volontairement pas de
« profils » par marque, qui vieilliraient mal et masqueraient la seule chose qui compte — quels
en-têtes le proxy pose réellement.

| Outil | Utilisateur | Groupes |
|---|---|---|
| Authelia / Authentik | `Remote-User` | `Remote-Groups` |
| oauth2-proxy | `X-Forwarded-User` (ou `X-Forwarded-Preferred-Username`) | `X-Forwarded-Groups` |
| Cloudflare Access | `Cf-Access-Authenticated-User-Email` | *(néant — l'appartenance vit dans les politiques Access)* |
| Tailscale (`tailscale serve`) | `Tailscale-User-Login` | *(néant)* |

La session produite est **volontairement pauvre** : `logged: true`, `user.login`, `user.eMail`,
`user.nom`, `user.domain = "forward"`, `groups`. Et rien d'autre :

- **pas d'`adminRight`** — l'autorisation passe par les rôles. Poser `SUPER_ADMIN` ferait de tout
  utilisateur du proxy un administrateur ; la rétrocompatibilité du SSO maison (§ 11) est une règle
  de *politique*, pas un modèle à copier ;
- **pas d'`expireDate`** — la session appartient au proxy, qui la coupe quand il veut ; annoncer une
  échéance que nous ne tenons pas serait mentir au client ;
- **pas de `sessionKey`**, donc aucune mise en cache : lire des en-têtes ne coûte aucune E/S, et un
  cache n'ajouterait qu'une fenêtre de rémanence après une déconnexion côté proxy ;
- **pas de `prenom`** — le contrat maison sépare nom et prénom (héritage du SSO) mais un proxy ne
  fournit qu'un seul libellé d'affichage (« Alice Martin ») : le découper à l'espace inventerait une
  structure fausse pour tous les noms composés. `user.nom` porte donc le nom **complet**, tel quel.

#### 🚨 Modèle de confiance — le point capital

Un en-tête est **trivial à forger**. Qui peut joindre l'application directement peut se déclarer
n'importe qui, administrateur compris. Deux protections, et la première n'est pas optionnelle :

1. **l'application n'est joignable que par le proxy** — bind sur localhost, réseau Docker privé,
   règle de pare-feu. C'est une consigne de *déploiement* : le code ne peut pas la vérifier ;
2. un **secret partagé** `AUTH_FORWARD_SECRET`, que le proxy pose dans `AUTH_FORWARD_SECRET_HEADER`.
   Configuré, il est **exigé** : toute requête dont l'en-tête ne correspond pas est **anonyme**, et
   le provider ne lit alors **aucun autre en-tête** — pas même le nom d'utilisateur. La comparaison
   est à **temps constant** (`auth/SecretCompare`, le même helper que le mode basic) : c'est un
   secret, pas un identifiant. Un test le prouve en **observant les lectures d'en-têtes**, pas en
   relisant le commentaire.

Secret **non configuré** : le mode fonctionne, mais le boot émet un **WARN explicite** rappelant la
consigne réseau et ce qu'un client direct pourrait faire. Même ton que le WARN du mode dev, parce que
c'est le même genre de trou. Le secret, lui, n'apparaît dans **aucun** log — comme le jeton SSO.

Même discipline que `X-Forwarded-Prefix` ([`reverse-proxy.md`](reverse-proxy.md)) : un en-tête n'est
cru que dans la mesure où l'on sait d'où il vient.

> **Consigne de déploiement.** Dans le proxy, **effacer** les quatre en-têtes d'identité venus du
> client avant de les repositionner soi-même (`proxy_set_header Remote-User $user;` sous nginx,
> `RequestHeader unset` puis `set` sous Apache) : sans cela, un client qui envoie son propre
> `Remote-User` peut le voir traverser. Le secret partagé rend cette faute inoffensive — raison de
> plus pour le configurer.

Exemple de configuration (Authelia + nginx) : [`../src-server/RUN.md`](../src-server/RUN.md) § 6.

### OIDC — l'application est elle-même le *Relying Party*

Là où le mode `forward` délègue **tout** à un proxy *identity-aware*, le mode `oidc` s'adresse aux
déploiements qui n'en ont pas : l'application parle elle-même OpenID Connect à un OP (Keycloak,
Entra ID, Authelia en mode OP, Authentik…), en flux **Authorization Code + PKCE**.

> **Lequel choisir ?** `forward` si un proxy *identity-aware* est déjà en place — il reste le plus
> simple, l'application ne gérant alors ni cookie ni expiration. `oidc` sinon : il ne demande aucune
> brique d'infrastructure supplémentaire, au prix d'un flux et d'une session à tenir. Les deux
> mappent les **groupes** de l'IdP vers des rôles par la même table `groups` de `roles.json` (§ 5),
> et par la même règle de nettoyage (`auth/GroupList`, helper partagé — extrait le jour où le mode
> `oidc` a donné un second consommateur au mode `forward`, comme `SecretCompare` avant lui).

**La cryptographie du protocole n'est pas écrite ici.** C'est la seule dépendance npm que ce mode
introduit : **`openid-client`** (panva), dans `src-server/package.json`. Elle porte la découverte
`.well-known`, le JWKS et sa rotation, la vérification de signature de l'`id_token`, les contrôles
`iss`/`aud`/`exp`/`nonce`/`state`, la génération du verifier PKCE et l'échange du code. Réécrire
cela à la main aurait été une faute (principe n°12).

#### Les trois responsabilités, et la frontière de la librairie

```
  GET /auth/login ─► OidcRoutes ─► OidcClientPort.beginAuthorization()
                        │              (state + nonce + PKCE : c'est la LIBRAIRIE qui les fabrique)
                        ├─ cookie de TRANSACTION court (dcm_oidc_tx, 10 min, HttpOnly)
                        └─ 302 vers l'OP
  GET /auth/callback ─► OidcRoutes  ① error= de l'OP ?      → page sobre 401
                        │            ② cookie de transaction → absent = page sobre 400
                        │            ③ 🚨 state comparé (TEMPS CONSTANT) → faux = 400, AVANT tout appel sortant
                        │            ④ OidcClientPort.completeAuthorization()  (canal ARRIÈRE + PKCE)
                        ├─ OidcSessionStore.create(claims, exp, idToken) → id aléatoire 32 o
                        ├─ cookie de SESSION (dcm_oidc_session) + effacement de la transaction
                        └─ 302 vers la racine de l'application
  GET /auth/logout  ─► OidcSessionStore.destroy + effacement du cookie (INCONDITIONNEL)
                        └─ 302 vers end_session_endpoint (RP-initiated) si l'OP en annonce un, sinon l'app

  TOUTE REQUÊTE API ─► OidcAuthProvider : cookie → OidcSessionStore.get → SsoResult
                        (aucune E/S, aucun appel sortant : la validation a eu lieu UNE fois)
```

| Fichier | Responsabilité |
|---|---|
| `auth/OidcConfig.ts` | les **six** variables d'environnement (source unique), scopes normalisés, drapeau `Secure` |
| `auth/OidcSessionStore.ts` | sessions **en mémoire** : id aléatoire, TTL, purge, plafond, `nowMs` injectable |
| `auth/OidcAuthProvider.ts` | cookie → session → `SsoResult` (implémente `AuthProvider`) |
| `auth/OidcRoutes.ts` | **le flux** — et il ne connaît **pas** Express (vues minimales, cf. plus bas) |
| `auth/OidcClientPort.ts` | le **contrat** de la couche `openid-client` (types seuls, aucun import) |
| `auth/OpenIdClientAdapter.ts` | la **seule** implémentation, et le **seul** fichier du dépôt qui importe `openid-client` |

🚨 **Pourquoi la librairie est derrière un port.** Trois raisons, dont une décisive : le flux doit
être **testable**. Un flux OIDC de bout en bout exige un OP réel — hors du périmètre de preuve des
tests — mais les propriétés qui comptent (*un state faux est refusé et le code n'est même pas
échangé*, *le cookie posé est HttpOnly/Secure/SameSite=Lax*, *la déconnexion efface le cookie*) se
vérifient avec un **bouchon** du port, sans réseau. Les deux autres raisons sont structurelles :
`openid-client` est **ESM pur** et n'est pas installé à la racine du dépôt, où le programme de test
compile en CommonJS — un import depuis les routes les rendrait incompilables. `OpenIdClientAdapter`
est donc le seul fichier de `auth/` absent de `tsconfig.node.json`, et il doit le rester ; corollaire
à tenir : il **traduit**, il ne décide pas — toute règle qui y apparaîtrait serait, par construction,
non testée.

Comme `AccessControl` et `AuthProvider`, `OidcRoutes` déclare ses propres **vues minimales** de la
requête et de la réponse, dont les types d'Express sont des sur-ensembles structurels. `server.ts` ne
garde donc que le **branchement** — trois `app.get`, montés **hors de la garde d'API et avant elle**,
comme `/healthz` : une route de connexion derrière une garde d'authentification serait un verrou dont
la clé est à l'intérieur.

#### Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `OIDC_ISSUER` | *(requis)* | émetteur de l'OP (`https://keycloak.exemple/realms/infra`) — la découverte en dérive les endpoints |
| `OIDC_CLIENT_ID` | *(requis)* | identifiant du client déclaré chez l'OP |
| `OIDC_REDIRECT_URL` | *(requis)* | **URL publique absolue** du callback, `…/auth/callback` |
| `OIDC_CLIENT_SECRET` | *(vide)* | secret du client **confidentiel**. Vide = client **public** (PKCE seul) |
| `OIDC_SCOPES` | `openid profile email groups` | scopes demandés — `openid` est **forcé** en tête s'il manque |
| `OIDC_COOKIE_SECURE` | `1` | attribut `Secure` des cookies. `0` = **développement en HTTP local uniquement** (WARN de boot) |

🚨 **`OIDC_REDIRECT_URL` est requise et ne se devine pas.** Derrière un reverse-proxy à sous-chemin
([`reverse-proxy.md`](reverse-proxy.md)), l'application ne connaît ni le schéma, ni l'hôte, ni le
préfixe publics — au mieux des en-têtes `X-Forwarded-*` que rien n'oblige le proxy à poser
correctement. La deviner produirait une URL qui « marche en local et casse en production », avec pour
seul symptôme un `redirect_uri_mismatch` opaque côté OP. C'est aussi pourquoi l'URL remise à la
librairie au callback est la valeur **configurée** + la chaîne de requête reçue : **aucun en-tête
réseau n'entre dans sa composition** (anti-empoisonnement d'hôte). Cette même URL sert à déduire la
racine de l'application (`new URL("../", redirectUrl)`) — destination après connexion et
`post_logout_redirect_uri` —, donc cohérente avec ce qui est déclaré chez l'OP par construction. Une
URL qui ne se termine pas par `/auth/callback` produit un **WARN** de boot, sans refus (un proxy peut
légitimement réécrire le chemin).

**Client public ou confidentiel ?** Les deux sont servis, et **PKCE est employé dans les deux cas**
(il protège l'échange du code, pas le client). Sans `OIDC_CLIENT_SECRET`, l'authentification cliente
est explicitement `none` ; avec, c'est `client_secret_post`. Le secret n'apparaît dans **aucun** log.

> `groups` n'est pas un scope universel : Keycloak l'offre via un *client scope* dédié, Entra ID ne
> le connaît pas et passe les groupes autrement. C'est le défaut le plus utile pour la cible
> principale, et il se **remplace** par `OIDC_SCOPES` quand l'OP refuse un scope inconnu.

#### Cookies, session, et ce que le provider rend

Deux cookies, tous deux `HttpOnly` + `Path=/` + `SameSite=Lax`, `Secure` selon `OIDC_COOKIE_SECURE` :
`dcm_oidc_tx` (transaction, 10 min, porte `state`/`nonce`/verifier PKCE) et `dcm_oidc_session`
(session, durée alignée sur celle de la session serveur). **`SameSite=Lax` est un choix, pas un
défaut** : `Strict` retiendrait le cookie de transaction au *retour* de l'OP et casserait le
callback. La **pose et l'effacement portent exactement les mêmes attributs** — s'ils diffèrent, le
navigateur y voit deux cookies distincts et **garde l'ancien** (une déconnexion qui ne déconnecte
pas). C'est un invariant testé.

La session rendue est, comme celle du mode forward, volontairement pauvre : `logged: true`,
`user.id = String(sub)`, `user.login` (`preferred_username`, à défaut l'e-mail), `user.eMail`,
`user.nom` (nom **complet**, jamais découpé), `user.domain = "oidc"`, `groups`, et `expireDate`
(échéance de la **session**, en millisecondes). Et rien d'autre :

- **pas d'`adminRight`** — l'autorisation passe par les rôles ; poser `SUPER_ADMIN` ferait de tout
  utilisateur de l'IdP un administrateur ;
- **pas de `sessionKey`**, donc aucune mise en cache par l'orchestrateur. Ici la raison diffère de
  celle des autres modes : ce n'est pas qu'il n'y a rien à mettre en cache (la résolution est un
  `Map.get`, un cache n'économiserait rien), c'est qu'il y a quelque chose à **ne pas** faire
  survivre — une session **détruite** par une déconnexion resterait valide le temps du cache.

`user.id` est `String(sub)` parce que `sub` est la seule revendication qu'un OP garantit stable et
unique : ni l'e-mail (qui change) ni le login (qui se réattribue) ne peuvent servir de clé canonique
à l'annuaire et à l'audit. C'est ce qui a élargi `SsoUser.id` à `number | string` — les deux
consommateurs (`users/UserResolver`, `access/AccessControl`) le lisaient **déjà** dans les deux
types, et `UserProfiles.canonicalId` passe de toute façon par `String(id)` : le contrat était
simplement plus étroit que ses propres consommateurs.

#### L'OP injoignable au boot ne fait pas tomber le serveur

Un IdP qui démarre après nous (même `docker compose`), un DNS pas encore prêt : la découverte est
lancée en **tâche de fond**, réessayée avec un dos d'âne borné (5 s → 5 min, minuteurs `unref`és), et
le serveur **démarre normalement**. Tant qu'elle n'a pas abouti, `/auth/login` et `/auth/callback`
répondent **503 avec un message actionnable** — il nomme `OIDC_ISSUER`, la dernière erreur et les
deux causes les plus fréquentes (émetteur injoignable, émetteur en HTTP alors que la découverte
exige HTTPS). C'est le patron des modules à clé absente (cf. `VmModule`) : un prérequis externe
manquant rend **une** fonctionnalité indisponible, jamais le service entier. Toute requête sur
`/auth/*` **relance** en outre une tentative, pour que la reprise ne dépende pas du seul minuteur.

`/auth/logout`, lui, réussit **toujours** : la déconnexion locale (destruction de session +
effacement du cookie) est inconditionnelle. Répondre 503 laisserait une session ouverte sur une
instance en difficulté — l'inverse exact de ce que demande l'utilisateur qui clique.

Toute erreur de flux rend une **page sobre** avec un lien « réessayer », et **jamais une
redirection** : une redirection sur échec de connexion produit des boucles login → erreur → login que
rien n'arrête côté navigateur. Le texte venu de l'OP y est échappé. Les messages internes de la
librairie sont **journalisés** mais pas servis à un appelant non authentifié.

#### Le bouton « Connexion » ne demande aucune configuration

Le client affiche le bouton de l'écran d'accueil dès qu'une `loginUrl` lui est injectée. En mode
`oidc`, si `SSO_LOGIN_URL` est vide, `index.ts` la défaut sur la route servie, en valeur **relative
sans slash initial** (`auth/login`) — exactement comme `apiBaseUrl` que `server.ts` dérive de la même
façon (`"/api"` → `"api"`). Les URLs du client étant ancrées sur le `<base>` du HTML, c'est cette
forme, et elle seule, qui fonctionne aussi en **sous-dossier**. `SSO_LOGIN_URL` reste prioritaire si
elle est renseignée : un exploitant qui veut passer par une page intermédiaire garde la main.

#### 🚨 Limites assumées de la v1

- **Sessions en mémoire : un redémarrage déconnecte tout le monde.** C'est une décision, pas un
  oubli. Persister exigerait d'écrire des `id_token` sur disque, donc un chiffrement au repos, donc
  une clé, une base dédiée et son cycle de vie — un chantier entier pour une gêne dont le coût réel
  est un aller-retour vers l'IdP, généralement **invisible** (la session de l'OP survit, le
  navigateur revient authentifié sans rien retaper).
- **Corollaire multi-instances** : sans session partagée, deux répliques derrière un répartiteur ne
  se reconnaissent pas. Il faut des sessions **collantes**, ou le mode `forward` (dont le proxy porte
  la session).
- **Pas de rafraîchissement de jeton.** La session vaut la durée annoncée par l'`id_token`, plafonnée
  à 12 h (constante `OidcSessionStore.DEFAULT_TTL_MS` — aucune variable d'environnement de plus). Un
  rafraîchissement correct suppose de gérer la **rotation** des *refresh tokens* (Keycloak la fait
  par défaut) et donc les rafraîchissements **concurrents** — N requêtes parallèles qui rafraîchissent
  en même temps invalident la session. On préfère simple et juste à complet et fragile. À l'échéance,
  le client reçoit un 401 et repart par son flux de connexion habituel, qui existe déjà. Le champ
  `refreshToken?` du store est la **couture** prévue : il n'est pas alimenté en v1, parce que
  conserver un secret dont personne ne se sert n'ajouterait qu'une surface d'exposition.
- **Déconnexion RP-initiated seulement si l'OP annonce un `end_session_endpoint`.** Sinon la session
  de l'OP survit à la nôtre, et une reconnexion sera silencieusement ré-authentifiée. Limite du
  protocole, pas du code. L'`id_token` est conservé en session pour servir d'`id_token_hint` — sans
  lui, un OP comme Keycloak affiche une page de confirmation.
- **Le cookie de transaction n'est pas signé.** Il est `HttpOnly` (illisible en JS) et `Secure` ; un
  attaquant capable d'y **écrire** pourrait monter un CSRF de connexion, mais cela suppose une
  compromission déjà bien plus large. C'est la forme retenue par la plupart des RP sans état.
- **Émetteur en HTTPS obligatoire** : la découverte refuse un émetteur HTTP (règle de la librairie,
  non contournée ici). Un OP de développement doit donc être servi en HTTPS.

### Le challenge Basic n'est pas une identité

Deux rôles à ne pas confondre : renvoyer `401 WWW-Authenticate: Basic` pour que le **navigateur**
demande les identifiants est un geste de **transport** — il reste dans `server.ts` (`basicGate`),
monté sur tout le serveur, pages comprises. `Auth.checkBasic` est le point de contact : le gate
demande si les identifiants présentés sont bons, sans rien savoir de plus, et hors mode basic il n'a
rien à opposer (`true`). L'**identité**, elle, passe par `Auth.validate` dans tous les modes.

> **Ajouter un mode d'authentification.** Écrire une classe de `auth/` implémentant `AuthProvider`
> (plus `sessionKey` si le mode présente un jeton qu'il vaut la peine de mettre en cache), l'ajouter
> à `AuthModeResolution.MODES` (et le retirer de `PLANNED_MODES` s'il y figurait) avec sa règle de
> **cohérence** si le mode exige une configuration, le sélectionner dans le `switch` du constructeur
> d'`Auth`, documenter ses variables d'environnement (README § 4 + RUN.md + `.env.example`, principe
> n°13) et lui donner une section dans `test-auth-providers.js`. Rien d'autre ne bouge : ni `api.ts`,
> ni `access/`, ni le client.
>
> Le mode `oidc` l'a vérifié en grand : **le contrat n'a pas bougé d'une ligne** pour l'accueillir,
> alors que c'est le plus gros des cinq. Ce qu'il a demandé en plus, c'est ce qu'aucun contrat
> d'authentification n'a à porter — un **flux** (`auth/OidcRoutes`, branché par `server.ts` hors de
> la garde d'API), un **état de session** (`auth/OidcSessionStore`) et une **dépendance** isolée
> derrière un port (`auth/OidcClientPort`). Un mode qui a besoin de ses propres routes les fabrique à
> côté et les expose sur `Auth` ; il n'élargit pas `AuthProvider`, dont la question reste « qui est
> l'appelant ? ».

## 1. Le modèle : permissions atomiques, grants à jokers

Tout vit dans **`src-shared/Permissions.ts`** — code PARTAGÉ front ⇄ back, sur le patron de
`ListOrder`/`ListFacets` : une liste blanche déclarative, lue des deux côtés, verrouillée par des
tests. Le serveur **décide**, le client **anticipe** (masquage des vues et des actions — § 10).
S'ils dérivaient, l'interface proposerait des gestes que le serveur refuse.

| Notion | Forme | Qui l'emploie |
|---|---|---|
| **Permission atomique** | `domaine[.sous-domaine]:action` — `dc.ip:update`, `certs:pki`, `snapshot:write` | ce que les gardes **vérifient** — toujours atomique |
| **Grant** | idem, jokers admis — `*`, `dc.*:read`, `certs:*`, `dc.ip:*`, `dc.*:*` | ce qu'un rôle **donne** |
| **Rôle** | un nom → une liste de grants (preset partagé ou définition locale) | ce qu'une politique **associe** à un utilisateur |

**Règles de matching** (elles vivent dans `PermissionSet.has`, et nulle part ailleurs) :

- `*` couvre tout.
- `<domaine>:*` couvre toutes les actions de ce domaine.
- `<préfixe>.*:<action>` couvre les **sous-domaines** de `<préfixe>` — `dc.*:read` couvre
  `dc.ip:read`, mais pas un domaine `dc` nu (il n'en existe pas, et l'ambiguïté ne se tranche pas au
  plus large). De même, `vm:*` **ne couvre pas** `vm.providers:manage` : un sous-domaine n'est pas
  son domaine, ce qui garde les jetons des providers hors de portée d'un opérateur VM.
- Une **vérification** portant un joker est toujours refusée : un check est atomique par contrat, et
  « faire au mieux » masquerait la faute en ouvrant l'accès.
- Un grant **malformé** est ignoré, jamais interprété.

La composition multi-rôles est une **union additive**, sans deny : l'ordre des rôles est indifférent,
et une permission de plus ne peut jamais en retirer une autre.

## 2. Carte collections → domaines

Les 25 collections de `Schema.COLLECTIONS` sont **toutes** rattachées à un domaine. Un test
d'invariant le vérifie : ajouter une collection sans la mapper **casse la suite de tests** plutôt que
de laisser sa route générique sans permission utile.

| Domaine | Collections |
|---|---|
| `dc.equipment` | `equipments`, `subEquipments`, `ports`, `aggregates`, `spares` |
| `dc.cabling` | `cables`, `cableBundles`, `cableTypes`, `portTypes`, `waypoints` |
| `dc.rack` | `racks`, `rackItems` |
| `dc.site` | `sites`, `datacenters`, `floors`, `groups` (+ pseudo-collections `meta` et `images`) |
| `dc.ip` | `networks`, `ipNetworks`, `ipAddresses`, `dhcpRanges` |
| `dc.app` | `applications` |
| `dc.contact` | `contacts` |
| `dc.attachment` | `attachments` (métadonnées **et** binaires) |
| `vm` | `vms` (VMs manuelles comprises — leur CRUD passe par les routes génériques) |
| `wifi` | `wifiClients` |

Actions : `read`, `create`, `update`, `delete`.

> La découpe est un **compromis lisibilité / grain**, pas une taxonomie : elle est calibrée sur les
> rôles réels (elle rend `dc-connector` trivial — `dc.cabling:*` plus trois lectures) sans pulvériser
> le catalogue en 25 domaines que personne n'écrirait à la main.

`meta` et `images` ne sont pas des collections du schéma mais bien de la donnée du document :
rattachées à `dc.site`, ce sont les réglages et les fonds de plan du lieu.

## 3. Catalogue des permissions

**Cœur** — le CRUD de chacun des 10 domaines ci-dessus, plus quatre gestes d'administration qui ne
sont pas de la donnée :

| Permission | Ce qu'elle ouvre |
|---|---|
| `settings:manage` | réglages globaux de l'instance (`PUT /settings` — document par défaut) |
| `documents:manage` | création / renommage / (dé)verrouillage / suppression de documents |
| `snapshot:write` | remplacement **complet** d'un document (`PUT /snapshot`, import `.json`) |
| `maintenance:run` | purge des binaires orphelins + VACUUM/checkpoint (`POST /maintenance`) |

**Modules amovibles** — chaque module déclare les permissions de ses routes ; le cœur ne les
connaît pas (voir § 6.2). Retirer un module ne laisse qu'une entrée de catalogue inerte : une
permission que plus personne ne vérifie n'ouvre rien.

| Module | Permissions |
|---|---|
| `vm/` | `vm:read` (partagée avec la lecture de la collection `vms`), `vm:sync`, `vm.providers:manage` |
| `wifi/` | `wifi:read` (idem `wifiClients`), `wifi:sync`, `wifi.providers:manage` |
| `tracker/` | `tracker:read`, `tracker:push`, `tracker.providers:manage` |
| `certs/` | `certs:read`, `certs:write`, `certs:pki` |
| `interventions/` | `interventions:read`, `interventions:write` |
| `notify/` | `notify:read`, `notify:manage` |
| `lifecycle/` | *(aucune — le module n'expose pas de route)* |

`vm:read` et `wifi:read` sont **volontairement** les mêmes permissions que la lecture des collections
correspondantes : « lire l'inventaire VM » et « lire l'état de la synchro VM » sont un seul droit du
point de vue de l'utilisateur.

## 4. Rôles

Les **presets** sont une commodité de configuration ; la vérité reste le catalogue atomique.
La lecture est scopée **par domaine** : il n'existe volontairement pas de « viewer global »
implicite — « tout voir » s'écrit comme l'union explicite des `*-viewer`, pour qu'aucun droit ne
s'acquière par distraction.

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

Deux choix méritent leur justification. **Les opérateurs VM/wifi sont énumérés** plutôt qu'écrits
`vm:*` : un rôle d'opérateur ne doit pas hériter en silence d'un futur verbe sensible, et la gestion
des providers — qui porte des **jetons** — reste hors de son périmètre. **`cert-manager` n'a pas
`certs:pki`** : les cérémonies de coffre (initialisation, re-chiffrement des clés racine) sont
irréversibles si elles sont mal menées.

## 5. La politique : `roles.json`

Le `RoleProvider` (`src-server/src/access/RoleProvider.ts`) est un contrat ; l'implémentation servie
est `FileRoleProvider`, un fichier JSON relu **à chaud**. C'est délibérément le support le plus
simple qui soit : la politique d'un déploiement auto-hébergé tient en quelques lignes, et un fichier
se sauvegarde, se versionne et se corrige sans base ni écran d'administration.

```jsonc
{
  "users": {
    "jdupont": ["dc-editor"],            // clé = login BRUT
    "42": ["cert-manager", "vm-viewer"], // …ou id CANONIQUE (String(id) SSO)
    "zoe": ["cabliste-nuit"]
  },
  "groups": {                            // GROUPES de l'IdP (mode forward, OIDC demain)
    "grp-infra": ["dc-editor"],
    "grp-noc": ["vm-viewer", "wifi-viewer"]
  },
  "roles": {                             // rôles CUSTOM, optionnels — en plus des presets
    "cabliste-nuit": ["dc.cabling:*", "dc.rack:read"]
  }
}
```

- **Recherche par id canonique PUIS par login**, et **union** des deux si les deux sont déclarés :
  ce sont deux graphies de la même personne, un exploitant qui a écrit les deux doit obtenir la
  somme. La correspondance est **exacte, sensible à la casse** — prévisible et testable ; au besoin,
  déclarer les deux graphies.
- **Pas de bucket `default`** : l'opt-in est strict. Un utilisateur absent du fichier — et dont aucun
  **groupe** n'y figure — n'a aucun rôle.
- **Tolérant en forme, strict en droit.** Une clé de premier niveau inconnue est **ignorée et
  signalée** (le fichier reste exploitable) ; une valeur mal typée n'accorde **rien** (jamais de
  coercition) ; un grant hors catalogue est signalé comme la coquille qu'il est presque toujours —
  il ne correspondrait à aucune vérification, et l'exploitant croirait avoir donné un droit.
- Une définition locale qui porte le nom d'un preset le **masque** : le fichier est l'autorité du
  déploiement (un avertissement le rappelle au chargement).

### La table `groups` — la gestion des utilisateurs retourne dans l'IdP

`groups` associe un **groupe de l'annuaire** à des rôles. C'est ce qui rend forward-auth (et demain
OIDC) payant : le fichier ne décrit plus des personnes mais la **traduction** « groupe d'entreprise →
rôle applicatif », et un nouvel arrivant du bon groupe a ses droits sans qu'on touche à `roles.json`.

Les rôles effectifs sont l'**union** de `users[id]`, `users[login]` et de `groups[g]` pour chacun des
groupes de l'identité. Union, et pas priorité : la composition du modèle est purement additive (§ 1,
aucun deny), donc l'ordre est indifférent et rien ne se masque. Même correspondance **exacte et
sensible à la casse** que pour les utilisateurs — un nom de groupe d'IdP est une chaîne opaque, où
`Infra` et `infra` peuvent parfaitement coexister.

D'où viennent ces groupes : de `SsoResult.groups`, rempli par le provider d'en-têtes de proxy (§
Forward-auth) ou par le passthrough du SSO maison quand celui-ci en renvoie. Les modes dev et basic
n'ont pas d'annuaire, donc pas de groupes — leur comportement est strictement inchangé.
`AccessControl.identityOf` **filtre** au passage (chaînes non vides, rognées) : c'est la frontière par
laquelle une donnée d'annuaire non maîtrisée entre dans la politique.

🚨 **La clé du cache de permissions intègre les groupes, triés.** Deux requêtes du même login avec des
appartenances différentes n'ont pas les mêmes rôles : sans les groupes dans la clé, la première
réponse figerait les droits de la seconde — escalade dans un sens, perte d'accès dans l'autre. Le tri
garantit au passage que deux ordres du même ensemble **partagent** l'entrée au lieu de la dupliquer
(l'ordre du proxy n'a aucune signification pour la politique). Le séparateur est le caractère NUL,
groupes compris : avec une virgule, `["a,b"]` et `["a", "b"]` produiraient la même clé pour des rôles
différents.

### Fail-closed, et la nuance « absent » ≠ « illisible »

Fichier absent, illisible, JSON invalide : **personne n'a de rôle**. Jamais de repli ouvert « le
temps de réparer » — c'est précisément quand la configuration est cassée qu'un repli permissif
serait exploité. Deux échecs se ressemblent pourtant, et reçoivent deux traitements :

| Situation | Effet |
|---|---|
| Fichier **absent** (ou supprimé à chaud) | état parfaitement défini → politique **vide adoptée**, génération incrémentée, avertissement. C'est aussi l'état d'un déploiement neuf. |
| Fichier **présent mais illisible** (JSON tronqué en cours d'édition, droits retirés) | on ignore ce que l'exploitant voulait → la **dernière politique valide reste en vigueur**, erreur journalisée. Écraser la politique en cours par du vide sur une faute de frappe déconnecterait toute l'équipe. |
| **Premier** chargement illisible | il n'y a pas de « dernière valide » → politique **vide** (fail-closed). |

### Rechargement à chaud

Le fichier est surveillé par **sondage** (`fs.watchFile`, 2 s, `persistent: false`) et non par
`fs.watch` : il vit dans `DOCS_DIR`, dossier très bruyant (les `-wal`/`-shm` SQLite y changent en
permanence) et il est souvent remplacé par **renommage** — deux cas où une veille sur descripteur
soit noie le signal, soit le perd définitivement. Le sondage voit indifféremment création,
modification et suppression, ne jette pas quand la cible n'existe pas, et se comporte pareil sous
Windows, Linux et en conteneur. Le coût est un `stat` toutes les 2 s.

Chaque rechargement **adopté** incrémente une **génération**, seul signal d'invalidation du cache de
permissions : sans elle, une session déjà vue garderait ses droits d'avant l'édition.

### Amorçage — `BOOTSTRAP_ADMIN_IDS`

Ids canoniques ou logins séparés par des virgules, promus `admin`. Sans cette porte **explicite**, le
premier administrateur d'un déploiement neuf serait verrouillé dehors par la règle même qu'il doit
écrire. C'est la seule ouverture qui ne vienne pas du fichier de politique.

### Variables d'environnement

De la **politique** (l'authentification a les siennes : `AUTH_MODE` ci-dessus, `SSO_URL`,
`BASIC_AUTH`, `AUTH_FORWARD_*` — liste complète dans `README.md` § 4 et
[`../src-server/RUN.md`](../src-server/RUN.md) § 6) :

| Variable | Défaut | Rôle |
|---|---|---|
| `ROLES_FILE` | `<DOCS_DIR>/roles.json` | chemin du fichier de politique |
| `BOOTSTRAP_ADMIN_IDS` | *(vide)* | ids canoniques ou logins, séparés par des virgules → rôle `admin` |

## 6. Application : `requireAuth` + gardes par route

### 6.1 La garde globale

Montée en un point (`api.ts`), elle couvre le cœur **et** toutes les extensions :

1. valide la session et la pose sur la requête (`authUser`, relue par l'audit et la notification
   live) ; `!logged` → **401** ;
2. résout rôles → grants → `PermissionSet`, posé sur la requête (`authAccess`) ;
3. **403 immédiat si l'ensemble est vide** — c'est l'invariant « authentifié ≠ autorisé », garanti
   en **un** point et donc impossible à oublier route par route. Une route nouvelle est au pire
   fermée à ceux qui n'ont aucun droit, jamais ouverte à tous.

Les gardes de route ne départagent ensuite que des utilisateurs **légitimes** entre eux.

| Route du cœur | Garde |
|---|---|
| `GET /me` | **aucune** (montée avant la garde globale — § 7) |
| `GET /users/resolve`, `GET /settings`, `GET /documents` | *authentifié* (aucune permission propre — **déclaré**, pas oublié) |
| `PUT /settings` | `settings:manage` |
| `POST /documents`, `PUT /documents/:docId`, `DELETE /documents/:docId` | `documents:manage` |
| `POST /cascade-preview` | lecture du domaine de la collection racine (lue dans le **corps**) |
| `GET /events` (SSE) | ≥ 1 lecture documentaire |
| `GET /meta` · `PUT /meta` | `dc.site:read` · `dc.site:update` |
| `POST /transact` | par opération — § 8.1 |
| `PUT /snapshot` | `snapshot:write` |
| `GET /images`, `GET /images/:id`, `GET /images/:id/blob` | `dc.site:read` |
| `PUT /images/:id`, `DELETE /images/:id` | `dc.site:update` |
| `POST /attachments` · `GET /attachments/:id/blob` | `dc.attachment:create` · `dc.attachment:read` |
| `POST /maintenance` | `maintenance:run` |
| `GET /search` | ≥ 1 lecture documentaire, **assiette restreinte** — § 8.3 |
| `GET /facets/:collection` | lecture du domaine de la collection |
| CRUD générique (`/:collection`, `/:collection/:id`) | `<domaine(collection)>:<read\|create\|update\|delete>` |

Deux détails de placement qui comptent : sur `PUT /images/:id` et `POST /attachments`, la garde
précède **multer** — sinon un appelant sans droit ferait quand même streamer son upload sur le
disque du serveur avant d'être refusé. Une collection **inconnue** laisse passer la garde : le
handler répond 404 comme avant l'ACL, un 403 y serait faux et renseignerait sur l'existence des
collections.

### 6.2 Modules : la garde est **injectée**

Le contrat `ApiExtension { path, router }` n'a pas bougé. Chaque fabrique reçoit en plus un objet
`access` par **typage structurel** — exactement le patron de `problems`/`onWrite` :

```ts
export interface VmAccessGuards { require(permission: string): express.RequestHandler }
```

Le module déclare cette interface **chez lui** et n'importe rien de `access/` ; c'est `index.ts` qui
ponte l'`AccessControl` au bootstrap. La quasi-duplication de ces trois lignes d'un module à l'autre
est assumée, comme celle des `*ProblemReporter` : c'est le prix de l'amovibilité.

| Module | Permission → routes |
|---|---|
| `vm/` | `vm:read` → `GET /status`, `GET /providers` · `vm:sync` → `POST /sync` · `vm.providers:manage` → `PUT`/`DELETE /providers/:id`, `POST /providers/test` |
| `wifi/` | symétrique (`wifi:read` / `wifi:sync` / `wifi.providers:manage`) |
| `tracker/` | `tracker:read` → `GET /status`, `GET /providers` · `tracker:push` → `POST /sync`, `POST /replicate/:id`, `POST /push/:id` · `tracker.providers:manage` → `PUT`/`DELETE /providers/:id`, `POST /providers/test` |
| `certs/` | `certs:read` → tous les `GET` · `certs:write` → `PUT /:id`, `DELETE /:id` · `certs:pki` → `PUT /pki`, `PUT /pki/rekey`, `PUT /pki/vaults/:vaultId(/rekey)` |
| `interventions/` | `interventions:read` → les `GET` · `interventions:write` → `PUT /:id`, `DELETE /:id` (clôture comprise) |
| `notify/` | `notify:read` → les `GET` · `notify:manage` → les `PUT`/`DELETE` + `POST /test` |

> `GET /certs/:id` renvoie `key_enc` — une clé privée **chiffrée côté navigateur**, que le serveur ne
> sait pas déchiffrer. `certs:read` suffit donc : c'est la conséquence assumée du modèle
> zéro-connaissance (cf. [`certs.md`](certs.md)).

🚨 **La garde de permission passe AVANT le 503 « module indisponible »** : un appelant sans droit ne
doit pas apprendre si la feature est configurée, ni pourquoi elle ne l'est pas. Comme le 503 est
émis en tête de handler et que la garde est un middleware, l'ordre est garanti par construction.

### 6.3 Le verrou d'exhaustivité

« Toute route porte une garde » est une convention, et une convention non tenue par une machine finit
toujours par ne plus être tenue : la route ajoutée un vendredi hériterait du seul filet global
(« ≥ 1 permission »), c'est-à-dire d'à peu près aucun contrôle.

Toutes les gardes produites par `AccessControl` portent donc une **étiquette** (`aclTag`), et un test
(`Tests/modules/test-access.js`) relit les **sources** des routeurs — `api.ts` et les six
`*Module.ts` — pour échouer en **nommant** méthode, chemin et ligne de toute route sans garde. Même
philosophie et même outil (le parseur TypeScript) que le verrou d'isolement de `src-shared/`. Le test
vérifie aussi que chaque permission littérale appartient au catalogue partagé, et il porte un
contrôle de **discrimination** qui prouve que son détecteur voit bien ce qu'il prétend voir.

La liste des routes est **découverte**, jamais déclarée — c'est le point : un manifeste écrit à la
main serait aveugle au cas visé, puisqu'une route oubliée y manquerait aussi. Une seule route est en
liste blanche, `GET /me`, et le test échoue si cette entrée devient périmée.

**Portée du verrou** : `api.ts` et les routeurs de modules. `server.ts` est **hors champ**, et il n'a
pas bougé avec le mode OIDC : il ne monte que des routes délibérément **publiques** — `/healthz`, le
HTML du client et ses assets, et désormais `/auth/login`, `/auth/callback`, `/auth/logout`. Ces
trois-là *doivent* être joignables sans être authentifié (une route de connexion derrière une garde
d'authentification serait un verrou dont la clé est à l'intérieur) ; elles n'exposent aucune donnée
du modèle et ne consomment que des jetons de flux qu'elles ont elles-mêmes émis.

## 7. `GET /me`

Seule route montée **avant** la garde globale : un utilisateur sans aucun droit doit pouvoir
apprendre qu'il n'en a aucun (écran « aucun accès »), sinon il ne verrait qu'un 403 nu.

La réponse est **additive** : tous les champs historiques (`logged`, `adminRight`, `user`,
`expireDate`…) traversent inchangés, et s'y ajoute

```jsonc
{ "permissions": ["dc.*:read", "vm:read"] }   // les GRANTS effectifs, jokers compris
```

à partir desquels le client reconstruit le **même** `PermissionSet`. On expose les **permissions et
jamais les rôles** : le client applique la politique, il ne la connaît pas — et les noms de rôles
d'un déploiement ne le regardent pas.

## 8. Cas transverses

### 8.1 `/transact` — écriture de masse

Chaque opération du lot est vérifiée **avant** que rien ne soit appliqué :
`<domaine(collection)>:<create|update|delete>`. Une seule permission manquante refuse **tout** le
lot (403 nommant la permission) — l'atomicité du refus répond à l'atomicité de la transaction : un
lot à moitié écrit serait pire qu'un lot rejeté.

Le calcul est **pur et testable** (`Permissions.forBatch` : liste d'opérations → liste de
permissions) ; la garde HTTP ne fait que l'appeler. La `meta` d'un lot compte comme une écriture
`dc.site:update` — l'oublier laisserait une porte dérobée vers les réglages du document. Une
opération dont la collection est inconnue n'ajoute rien : le dépôt la rejettera de toute façon, et
ce n'est pas à l'ACL de requalifier une erreur de forme en refus d'accès.

### 8.2 Cascade de suppression — la permission porte sur les **racines**

Un `DELETE` (comme les suppressions d'un `/transact`) entraîne une cascade calculée par le serveur
sur plusieurs collections. **Cette cascade n'est pas re-vérifiée** : la permission porte sur les
racines **demandées**, et la cascade est de l'**intégrité référentielle** — une conséquence
mécanique, pas une action utilisateur distincte.

La décision est délibérée. L'alternative — vérifier chaque collection impactée — rendrait la
suppression d'un équipement impossible à un `dc-editor` dès qu'une pièce jointe y pend, alors même
qu'il a le droit de supprimer l'équipement : le modèle deviendrait incompréhensible et l'application
inutilisable. Même politique pour `POST /cascade-preview`, qui lit le plan de la même cascade.

### 8.3 Recherche transverse — assiette restreinte

`GET /search` n'exige qu'**une** lecture documentaire, sans quoi un lecteur partiel (`dc-viewer`) ne
pourrait pas chercher du tout. La restriction fine se fait donc dans le handler : l'assiette
effective est l'**intersection** de ce que le client demande et de ce qu'il a le droit de lire
(`Permissions.readableCollections`).

Le point d'injection est le paramètre `collections` du dépôt, qui borne la **boucle de requêtes** :
aucune requête SQL n'est même émise pour une collection interdite — strictement mieux qu'un
post-filtrage, qui l'aurait d'abord lue. Assiette vide → réponse vide immédiate (le dépôt interprète
une liste vide comme « toutes les collections », la lui passer serait l'inverse de l'intention).

### 8.4 SSE, annuaire, facettes

- **`GET /events`** ne transporte que des changesets (noms de collection et ids), jamais du
  contenu : ≥ 1 lecture documentaire suffit. Un filtrage fin du flux par collection reste possible
  plus tard ; le rechargement qui suit est de toute façon gardé par les routes de listing.
- **`GET /users/resolve`** n'exige aucune permission propre : l'audit affiche des noms partout. La
  règle de confidentialité qui s'y applique est inchangée — e-mail et téléphone sont caviardés sauf
  pour l'appelant (cf. [`user-resolver.md`](user-resolver.md)).
- **`GET /facets/:collection`** est déjà scopée par collection : garde directe sur son domaine.

## 9. Sémantique 401 / 403

Conservée à l'identique, parce que le client **agit différemment** selon le cas :

| Code | Quand | Ce que fait le client |
|---|---|---|
| **401** | `!logged` — session absente ou expirée | coupe la session locale et renvoie au **login** (verrou `SessionExpiry`) |
| **403** | authentifié, mais sans le droit | reste où il est : se reconnecter n'y changerait rien |

Les corps JSON gardent leur forme historique (`error`, `logged`, `adminRight`). Un refus de route
l'**enrichit** d'un champ `permission` nommant ce qui manque — un refus muet est indiagnostiquable,
côté support comme côté client. Quand une garde accepte plusieurs permissions (`any-doc-read`), le
champ porte la sentinelle de la règle.

## 10. Gating côté client — anticiper, jamais décider

Le serveur refuse déjà tout ce qui doit l'être (§ 6). Ce que le client apporte est d'un autre ordre :
**ne pas proposer un geste que le serveur refusera**. Un bouton qui produit un 403 n'est pas une
sécurité qui fonctionne, c'est une interface qui ment.

La règle qui gouverne tout ce volet : **le client APPLIQUE la politique, il ne la connaît pas.** Il ne
voit jamais un nom de rôle, jamais `adminRight`. Il reçoit des **grants** (§ 7) et reconstruit le
**même `PermissionSet` partagé** que le serveur. La version précédente dupliquait la règle d'accès
(`me.adminRight === "SUPER_ADMIN"`) : cette duplication a disparu, et avec elle la possibilité que les
deux côtés dérivent.

### 10.1 `AccessState` — l'état, et son injection nulle

`src-client/core/AccessState.ts` enveloppe un `PermissionSet` et n'ajoute **aucune règle de droit** :
il traduit le vocabulaire du client (« puis-je créer un câble ? ») en vocabulaire du modèle (« ai-je
`dc.cabling:create` ? »), en passant par `Permissions.forCollection` — la carte **partagée**, jamais
une table locale. Trois états, et trois seulement :

| État | Quand |
|---|---|
| `AccessState.ALL` | mode **fichier** et **visualiseur** — tout permis *par construction* |
| `AccessState.NONE` | mode API **avant** la réponse de `GET /me`, et utilisateur sans aucun grant |
| `AccessState.fromGrants(me.permissions)` | mode API, après le bootstrap (et après chaque relecture de `/me`) |

🚨 **Le mode fichier ne change pas d'un pixel**, et c'est structurel : l'état « tout permis » rend
chaque garde d'interface **inerte d'elle-même**. Il n'y a **aucun `if (mode === …)` disséminé** dans les
vues — exactement le patron d'**injection nulle** de `HydrationState` (cf.
[`hydratation.md`](hydratation.md)). L'unique test de mode de tout le volet tient en une ligne, dans
`app/main.ts` : `REST_MODE ? AccessState.NONE : AccessState.ALL`.

**Où il vit, comment il descend.** L'instance vit dans la racine de composition (`app/main.ts`), là où
le mode est décidé, et descend **par des prédicats** — jamais par un import d'état global depuis une
vue : `ShellView.visible` / `canAdd` pour les onglets et le « + créer », `ListActions.can*` pour les
actions de ligne, `FormBase.access` pour la chaîne (statique) des fiches, `DatacenterHost.canEditSpace`
pour les outils spatiaux, un prédicat de constructeur pour la page Notifications. Les prédicats
**relisent l'état courant à chaque évaluation**, donc un changement de droits se propage sans rien
reconstruire. Le mode API l'installe depuis `RestDocumentController` (`RestDocumentsHost.setAccess`) :
c'est lui qui parle à `/me`.

### 10.2 Ce qui est masqué, et par quoi

Grain **coarse** assumé pour cette version : on masque des ensembles cohérents, pas bouton par bouton.

**Onglets et vues** — permission de **lecture** :

| Vue | Permission | Provenance |
|---|---|---|
| Tout onglet de **listing** (Équipements, Racks, Câbles, IPAM, Spares, Contacts, Applications, PJ, VMs, Wifi, …) | `<domaine(collection)>:read` | **DÉRIVÉE** de `ListOptions.collection` par la carte partagée — aucune table à tenir, un listing ajouté demain est gaté par construction |
| Datacenter (2D/3D), bibliothèque d'images de façade | `dc.site:read` | carte `core/ViewAccess` |
| Netmap | `dc.equipment:read` | idem |
| Clusters VM | `vm:read` · Interventions `interventions:read` · Certificats `certs:read` · Notifications `notify:read` | idem |
| Recherche globale (loupe / Ctrl+F) | ≥ 1 lecture documentaire | même règle que la garde de `GET /search` (§ 8.3) |

Masquer une vue masque **tous** ses chemins d'accès (onglet desktop, entrée du menu responsive, entrée
de menu de groupe, bouton-lien d'en-tête) ; un **groupe** disparaît quand aucun de ses enfants n'est
visible. Si l'onglet **actif** devient inaccessible — droits retirés à chaud —, le Shell se replie sur
la première vue visible ; si plus rien ne l'est, l'écran « aucun accès » couvre l'application.

🚨 **Verrou de test** : `Tests/modules/test-client-access.js` relit les **sources** de `app/main.ts` et
échoue en **nommant** toute vue déclarée (`shell.addView({ name: "…" })`) qui n'aurait ni entrée dans
`ViewAccess` ni prédicat `visible`. Même philosophie et même outil que le verrou d'exhaustivité des
routes (§ 6.3) : la liste est **découverte**, jamais déclarée. Les listings, eux, échappent au verrou
sans risque : leur nom passe en propriété raccourcie (`name,`) parce qu'il vient d'un paramètre — la
distinction est structurelle, pas une liste d'exceptions.

**Gestes d'écriture** — masqués aux **points communs**, une fois pour toutes :

| Geste | Permission | Point commun |
|---|---|---|
| Bouton « + créer » d'en-tête | `<domaine>:create` | `ShellView.canAdd`, alimenté par `addListTab` |
| Actions de ligne : Modifier · Dupliquer · Supprimer · ▦ Contenu | `update` · `create` · `delete` · `update` | `ListActions.canEdit/canClone/canDel/canManage` — **composées** avec les raffinements métier existants (VMs manuelles…), jamais à leur place |
| Bouton « Modifier » des **fiches** (et « + Ajouter » / « Supprimer » d'une section de fiche) | `update` / `create` / `delete` de la collection | `FormBase.footer(edit, collection)` et `FormBase.canEditCollection` & co. |
| Outils d'**édition** de la barre d'outils Datacenter (placement libre, éditer la salle/l'étage, cases inaccessibles) | `dc.site:update` | `DatacenterHost.canEditSpace` — la navigation, les filtres, la localisation et la mesure restent entiers |

**Administration** — permissions **méta** (§ 3) :

| Geste | Permission |
|---|---|
| Créer / verrouiller / supprimer un document (sélecteur + « Nouveau » de la topbar) | `documents:manage` |
| ★ document par défaut de l'instance | `settings:manage` — sans lui l'étoile reste un **repère**, elle cesse d'être un bouton |
| Importer un `.json` dans un nouveau document | `documents:manage` **et** `snapshot:write` |
| Réglages ▸ Maintenance (purge des binaires, compactage) | `maintenance:run` |
| Providers VM / Wifi (jetons) · synchro VM / Wifi | `vm.providers:manage` / `wifi.providers:manage` · `vm:sync` / `wifi:sync` |
| Page Notifications : canaux, abonnements, rappels, test d'envoi | `notify:manage` (la lecture reste `notify:read`) |

### 10.3 Écran « aucun accès »

`authorized` vaut désormais « `me.permissions` **non vide** » (`AccessState.isEmpty()`) — exactement
l'invariant que la garde globale applique en 403 (§ 6.1). L'écran existant s'affiche sinon, avec son
bouton de connexion inchangé, et ses libellés ne nomment **plus aucun rôle** : dire « SUPER_ADMIN »
envoyait l'utilisateur réclamer un droit qui n'existe plus.

### 10.4 Un 403 **en vol**

La politique est relue à chaud (§ 5) : un rôle peut être retiré alors que l'interface a été bâtie avec
les droits d'avant. Un 403 sur une requête en cours de session produit donc, et seulement :

1. une **notification non bloquante** nommant la permission manquante (le corps du 403 la porte, § 9),
   **dédupliquée par permission** sur une courte fenêtre (`core/AccessDenial`) — une vue en cours de
   rendu tire plusieurs requêtes, et une rafale de 403 identiques noierait l'écran ;
2. une **relecture de `GET /me`**, sérialisée, qui réinstalle l'`AccessState` : le gating se resserre
   tout seul, l'onglet actif se repliant au besoin. Un `/me` injoignable ne touche à rien — écraser les
   droits par du vide sur une panne réseau masquerait l'application à un utilisateur légitime.

🚨 **Jamais de retour au login.** Le 401 et le 403 sortent de la même garde mais n'ont rien en commun :
le 401 pose une question d'**identité** et déclenche une action **terminale** (verrou `SessionExpiry`,
inchangé) ; le 403 dit « je sais qui vous êtes, et non » — se reconnecter n'y changerait rien, et le
refus doit pouvoir se re-signaler plus tard. D'où deux modules, et deux sémantiques.

### 10.5 Ce que le client ne gate PAS (v1 assumée)

Le grain reste coarse là où il n'existe pas de point commun ; ces gestes restent visibles et échouent
en 403 avec leur toast — jamais une écriture qui passe :

- les **menus contextuels et le glisser-déposer** des vues 2D/3D (déplacer une baie, poser un
  équipement, éditer une porte, tracer une route) : leurs affordances sont dispersées dans
  `DcInteract` ; seul le bloc d'outils d'édition de la barre d'outils est gaté ;
- les **écritures des pages Certificats et Interventions** (`certs:write`/`certs:pki`,
  `interventions:write`, `tracker:push`) : la **visibilité** de ces pages est gatée, pas leurs boutons
  internes ;
- les **actions de la palette** Ctrl+F (« Nouvel équipement… ») et le **champ de renommage** du
  document en topbar ;
- les **clients de feature** (certs, notify, interventions, vm, wifi, tracker) n'acheminent pas encore
  leur 403 vers le toast commun : seul le chemin `RestProtocol` (cœur documentaire) le fait.

## 11. Rétrocompatibilité

Un déploiement existant se comporte **exactement** comme avant. Ces deux règles vivent dans le
`RoleProvider`, parce qu'elles sont une politique et non une propriété de l'authentification :

- modes **dev** et **basic** (`SsoResult.dev`) → rôle `admin`. Ces modes n'ont jamais authentifié
  personne : tout appelant y était déjà `SUPER_ADMIN`, et le WARN de démarrage le crie depuis
  toujours ;
- SSO maison **`adminRight === "SUPER_ADMIN"`** → rôle `admin`. C'était l'unique droit d'accès de
  l'application ; le retirer aurait fermé la porte à tous les utilisateurs actuels.

Toute autre valeur d'`adminRight` ne donne rien : un utilisateur SSO valide mais non déclaré voit
`/me` et rien d'autre — c'est l'opt-in strict.

Le mode **forward** n'a, lui, aucune règle de rétrocompatibilité : il est nouveau, personne n'en
dépend, et il ne pose pas d'`adminRight`. Un utilisateur authentifié par le proxy mais absent de
`users` **et** dont aucun groupe ne figure dans `groups` n'a donc aucune permission — même opt-in
strict, sans exception à écrire.

## Mode local (fichier) — principe n°15

**L'authentification et les ACL sont serveur uniquement.** Écart assumé, et pour une raison de fond :
en mode fichier, l'utilisateur est **propriétaire de son fichier**. Il n'y a ni identité, ni
frontière de confiance, ni serveur pour la tenir — toute ACL y serait **décorative**, puisque le
fichier reste lisible et éditable hors de l'application. Le client en mode fichier fonctionne donc
sans restriction (équivalent `admin`), **par construction** : même logique que les écarts déjà
documentés des modules serveur (VMs, wifi, PKI).

Le `PermissionSet` vit quand même dans `src-shared/` : le client l'enveloppe dans un `AccessState`
(§ 10.1) que le mode fichier instancie « tout permis » (`AccessState.ALL`) et que le mode API remplit
depuis `/me` — patron d'**injection nulle** identique à `HydrationState` (un état inerte plutôt qu'un
`if (mode === …)` disséminé dans les vues). C'est ce qui garantit que **le mode fichier ne change pas
d'un pixel** : les gardes d'interface existent, mais répondent oui à tout.

## Procédures

### Ajouter une route au cœur

1. Choisir la permission : une permission de collection se dérive de la carte
   (`access.requireCollection(action)`) ; un geste d'administration en demande une nouvelle
   (§ 3), à ajouter à `Permissions.META_PERMISSIONS`.
2. Poser la garde **en premier argument** de la route, avant tout autre middleware (multer compris).
3. Le verrou d'exhaustivité échoue tant que ce n'est pas fait — c'est le rappel.

### Ajouter une route à un module

Même chose avec `this.access.require("<namespace>:<verbe>")`, et ajouter la permission à
`Permissions.MODULE_PERMISSIONS` (sinon le verrou la signale comme hors catalogue).

### Ajouter une collection

Lui donner un domaine dans `Permissions.COLLECTION_DOMAINS` — l'invariant de test l'exige.

### Ajouter un rôle

Un preset partagé (`Permissions.ROLE_PRESETS`, s'il a du sens pour tout déploiement) ou un rôle local
dans la section `roles` de `roles.json` (s'il est propre à un déploiement).

### Donner des droits à un groupe de l'IdP

Ajouter une entrée à la section `groups` de `roles.json` — le nom du groupe **exactement** comme
l'IdP l'écrit. Pour savoir ce que le serveur reçoit vraiment, appeler `GET <API_BASE>/me` : la
réponse porte `groups` (et les `permissions` qui en découlent). Rien à redémarrer : le fichier est
relu à chaud.

### Écrire une nouvelle implémentation de politique

Implémenter `RoleProvider` (`rolesOf`, plus éventuellement `grantsOfRole` et `generation`) et la
sélectionner dans `index.ts`, comme `UserResolver`. Le reste du système est inchangé.

## Limites de cette version

- **Rôles GLOBAUX à l'instance**, pas par document. Le scope par document reste une extension future
  du modèle (grants préfixés) sans casser le catalogue ; le module `notify/` n'est de toute façon
  pas scopé document.
- **Pas d'ACL par objet** (« cet utilisateur sur cette baie ») : le grain est le domaine.
- **Pas de deny** : la composition est purement additive.
- **Pas d'écran d'administration** des rôles — la politique s'édite dans `roles.json`.
- Le grain des verbes reste **coarse** là où les routes le sont : `certs:write` couvre un `PUT /:id`
  polyvalent (émission, renouvellement, révocation), et `interventions:write` inclut la clôture.
  Les affiner exigerait d'inspecter le corps des requêtes — possible plus tard, si un besoin réel
  l'exige.
