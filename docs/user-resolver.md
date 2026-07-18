# Annuaire utilisateurs (user-resolver)

Service **CORE** (pas un module amovible) qui transforme un **identifiant** d'utilisateur
en **profil affichable** — `{ id, login, domain, firstname, lastname, email, phone }`.
Il répond à un besoin transverse : l'application ne mémorise les utilisateurs (auteurs
d'un audit « créé/modifié par », destinataires…) que par un **id**, et l'interface veut
en montrer « Prénom Nom », le login, éventuellement les coordonnées.

> **Périmètre livré (lots 1 & 2).** Le contrat, l'implémentation v1 (cache d'auth + snapshot
> SQLite), la capture au fil des authentifications, `RequestAuthor.identity(req)` et
> l'endpoint batch `GET /users/resolve` (lot 1) sont livrés et testés. L'**estampillage** de
> `created_by`/`updated_by` (id canonique) et des **dates serveur** sur TOUTES les écritures —
> cœur, interventions, configs des modules (lot 2) — l'est aussi (voir « Estampillage d'audit »).
> Reste le **client** (service `UserDirectory`, fiches, colonnes) : le **lot 3**.

Deux propriétés fondatrices :

- **Interface-driven (principe n°2)** : les consommateurs (Api, futur client) ne dépendent
  que du contrat `UserResolver`. L'implémentation est **sélectionnée au câblage** (`index.ts`).
- **Découplage de l'auth (principe n°2)** : `Auth` ne connaît PAS l'annuaire ; il pousse les
  profils authentifiés vers un **puits injecté** (`ProfileSink`). Aucun import du resolver dans
  `auth.ts`.
- **Aucune clé d'environnement requise** en v1 (rien à chiffrer, pas de connexion sortante).

## Vue d'ensemble

```
                       CORE users/ (service, non amovible)
  ┌───────────────────────────────────────────────────────────────┐
  │  UserResolver (contrat)   ResolvedUser / RawUserProfile /       │
  │                           ProfileSink   (types, aucun import)   │
  │  UserProfiles (PUR)  ── canonicalId / fromSsoUser / dummy /     │
  │                         redactFor / parseIdList                 │
  │  AuthCacheUserResolver (impl v1) ── cache mémoire + capture     │
  │        │  implements UserResolver, ProfileSink                  │
  │        └─ UsersDb (users.db, table users_seen)  ← snapshot      │
  └───────────────────────────────────────────────────────────────┘
        ▲ remember(profil)                 ▲ resolve(ids)
        │ (puits injecté)                   │
     Auth.validate (3 modes)          Api  GET /users/resolve
```

## Contrat (`users/UserResolver.ts`)

```ts
interface UserResolver { resolve(ids: string[]): Promise<ResolvedUser[]> }

interface ResolvedUser {
  id: string; login: string; domain: string;
  firstname: string; lastname: string; email: string; phone: string;
}
```

- **Tous les champs sont des chaînes** ; un renseignement inconnu vaut la **chaîne vide**
  (jamais `null`/`undefined`) → le client formate sans garde.
- `resolve` renvoie **autant d'éléments qu'il reçoit d'ids, dans le MÊME ordre**
  (correspondance positionnelle). Un id inconnu résout en profil **« dummy »** (id conservé,
  autres champs vides).
- **Asynchrone par contrat** : l'impl v1 répond en mémoire, mais l'impl SSO future fera un
  appel réseau.

Le fichier ne contient **que des types** (aucun import) : il reste compilable en isolation et
n'entraîne aucune dépendance (ni Express, ni `auth.ts`) chez ses consommateurs. Il définit aussi
`RawUserProfile` (sous-ensemble **structurel** de `SsoUser`, cf. « Clé canonique ») et `ProfileSink`
(cf. « Capture »).

## Clé canonique (`UserProfiles.canonicalId`)

L'identifiant sous lequel un utilisateur est **stocké et résolu** (arbitrage Q1) :

1. `String(SsoUser.id)` si l'`id` SSO est présent (**0 compris** — un id numérique valide) ;
2. **sinon** le `login` (repli : SSO sans id, ou modes **basic**/**dev** qui n'ont qu'un login) ;
3. **sinon** la chaîne vide (profil dégénéré : jamais mémorisé).

Cette règle est **centralisée** dans une méthode pure (principe n°3) : la **capture** (resolver),
l'**estampillage d'audit** (`RequestAuthor.identity`) et l'**endpoint** appliquent la MÊME
définition. `UserProfiles.fromSsoUser` normalise un profil brut (mapping `prenom→firstname`,
`nom→lastname`, `eMail→email`, `domain` conservé, **`phone` toujours vide en v1** — le SSO ne le
fournit pas).

> **`RawUserProfile` plutôt qu'un import de `SsoUser`.** `users/` définit sa propre forme d'entrée
> (sous-ensemble de `SsoUser`) au lieu d'importer le type d'`auth.ts` : découplage (principe n°2) et
> compilation en isolation. `SsoUser` (dont l'`id` est un `number`) reste **assignable** à
> `RawUserProfile`, donc `Auth` pousse ses `SsoUser` sans conversion. Quand le SSO fournira le
> téléphone, on étendra `RawUserProfile` + `fromSsoUser` ensemble.

## Capture par injection (`ProfileSink`)

`Auth` reçoit un **puits optionnel** `ProfileSink { remember(user: RawUserProfile): void }`,
posé au bootstrap. À **chaque authentification réussie**, `Auth.validate` capture le profil :

- **dev** : profil synthétique (`login` factice) ;
- **basic** : profil synthétique depuis le `login` de la Basic Auth ;
- **sso** : `SsoResult.user` reçu, **uniquement sur défaut de cache jeton** (un hit du cache par
  hash de jeton ne re-capture pas — la fréquence est déjà bornée).

**Invariant** : on ne capture **JAMAIS** un profil non loggé (anonyme / échec).
`Auth` n'importe QUE le **type** `ProfileSink` (jamais le resolver) — condition du découplage.

## Implémentation v1 : `AuthCacheUserResolver`

- **État** = un cache mémoire `Map<idCanonique, ResolvedUser>` qui **est** la source de vérité des
  résolutions, **réhydraté au boot** depuis le snapshot.
- **`remember`** : normalise, met à jour le cache, puis écrit le snapshot **de façon throttlée** —
  seulement si le profil a **changé** ou si le dernier écrit remonte à plus de
  `SNAPSHOT_REFRESH_MS` (6 h). Sans ce throttle, un mode dev/basic (qui rappelle `remember` à
  CHAQUE requête, faute de cache par jeton) martèlerait la base. Un échec d'écriture snapshot est
  **journalisé sans casser l'authentification** (le cache mémoire reste correct).
- **`resolve`** : id connu → son profil ; id inconnu → **dummy**.

### Snapshot persistant (`users.db`)

Base SQLite **dédiée** `users.db`, dans le **même dossier data** que `registry.db`, ouverte avec le
**même driver injecté** (`SqliteCtor`) que `DocumentStore` — donc un **shim SQLite injectable** en
test (pattern `NotifyDb`/`InterventionsDb`/`CertsDb`). **Une table typée** (jamais de blob JSON) :

```
users_seen(
  id TEXT PRIMARY KEY, login, domain, firstname, lastname, email, phone,
  updated_date TEXT NOT NULL
)
```

Migrations idempotentes prêtes (`ensureColumn`, inspection de `pragma_table_info`). Sans snapshot
(users.db indisponible), l'annuaire vit **en mémoire seule** : après un redémarrage, les auteurs
historiques résolvent en dummy jusqu'à leur reconnexion — le snapshot évite précisément cet effet
(réhydratation au boot).

## Endpoint batch : `GET /users/resolve`

Monté dans `Api`, **derrière `requireAdmin`** (comme tout le reste). Réponse `{ users: ResolvedUser[] }`.

- Paramètre `id` **RÉPÉTABLE** (`?id=…&id=…`), **dédupliqué**, **plafonné à 200**, **ordre de la
  requête préservé** (`UserProfiles.parseIdList` — pur, testé).
- **RESTRICTION de confidentialité (arbitrage Q4)** : `email` et `phone` sont renvoyés **VIDES pour
  autrui** ; renseignés **uniquement** quand l'id résolu est celui de l'**appelant** (il voit ses
  propres coordonnées). `login`/`domain`/`firstname`/`lastname` restent visibles pour tout admin.
  Caviardage **pur et testé** : `UserProfiles.redactFor(callerId, user)`.

## Estampillage d'audit : `RequestAuthor.identity(req)` + `AuditStamp`

`RequestAuthor.identity(req) → { id, name }` : `id` = clé canonique (même logique partagée
`UserProfiles.canonicalId`), `name` = display-name (`RequestAuthor.name`, conservé pour le SSE `by`).

Les écritures posent l'**id canonique** de l'auteur dans `created_by` / `updated_by`, et les dates
d'audit deviennent **autoritatives serveur en mode API** (arbitrage Q9 ; le mode fichier n'a aucune
identité et garde ses dates client). Le SERVEUR est seul autoritaire : les valeurs d'audit envoyées
par le client sont **systématiquement écrasées** (aucune usurpation d'auteur ni antidatage possible).

### Règles PURES : `AuditStamp` (`src-server/src/AuditStamp.ts`)

`AuditStamp.apply(incoming, existing, authorId, nowIso)` renvoie une COPIE estampillée (l'entrée
n'est pas mutée). Règle unique, testée en isolation :

- **Création** (`existing === null`) : `created_by = updated_by = id`,
  `created_date = updated_date = nowIso`.
- **Mise à jour** (`existing` fourni) : `created_by` / `created_date` **repris de l'existant**
  (immuables ; **absents** d'un enregistrement legacy → restent absents), `updated_by = id`,
  `updated_date = nowIso`.
- **id canonique VIDE** (dégénéré — profil sans id ni login) : on ne pose PAS les `_by` (à la
  création ils restent absents ; à la mise à jour on conserve le dernier auteur connu de l'existant)
  ; les **dates** sont tout de même posées.

`AuditStamp.author(authorId)` centralise « auteur présent » (chaîne non vide → id, sinon `null`),
partagé avec les modules à colonnes typées.

### Points d'application (cœur, `api.ts`)

Toutes les écritures qui traversent `resolveRepo` sont estampillées AVANT `upsert` : `create` (création),
`update` (mise à jour), **chaque op** `create`/`update` d'un `/transact` (y compris les updates de
**cascade résiduelle**), et les **updates de CASCADE** d'un `DELETE` (détacher une FK = une modification
de l'entité par l'auteur de la suppression → `updated_by`). Les champs d'audit sont NON DÉCLARÉS dans
`src-shared/DataValidation` (pas nécessaire) : ils **traversent** la normalisation/validation sans être
retirés ni rejetés (specs partielles), et sont écrits dans le blob `data`.

**Exception : la restauration de snapshot (`PUT /snapshot`) N'ESTAMPILLE PAS** (arbitrage Q7) —
l'audit contenu dans le snapshot est restauré **tel quel** (fidélité historique). C'est le seul chemin
d'écriture qui ne passe pas par `AuditStamp` ; la normalisation partagée préserve les champs d'audit.

### Modules (colonnes typées)

`interventions.db`, `certs.db`, `notify.db` (canaux + abonnements) et `vm-providers.db` portent
`created_by` / `updated_by` en **colonnes** : `created_by` posé à la création puis PRÉSERVÉ par l'upsert
(hors `DO UPDATE SET`), `updated_by` rafraîchi à chaque écriture ; id vide → colonnes `NULL`. L'identité
vient de la requête (`RequestAuthor.identity(req).id`, posée côté route). **Interventions** stocke
désormais l'id canonique (les valeurs LEGACY = noms en clair restent lisibles via le repli du client).

## Impl future : `SsoUserResolver` (hors périmètre v1)

Interroge le **SSO par id** pour obtenir le profil à jour (téléphone compris). Sélectionnable par
**variable d'environnement** (pattern des modes d'auth) ; si une telle variable est introduite, la
lister dans le **README §4** (principe n°13).

### Procédure d'ajout d'une implémentation

1. Créer `users/SsoUserResolver.ts` **implémentant `UserResolver`** (aucun autre contrat à respecter).
2. Câbler dans `index.ts` : choisir l'implémentation (selon l'environnement) et l'injecter dans
   `Server` (`resolver`). Si elle doit aussi **capturer** (implémenter `ProfileSink`), la passer à
   `Auth` comme puits — sinon passer un autre puits (ou aucun).
3. Documenter toute nouvelle variable d'environnement (README §4) et compléter les tests.

## Suppression

Retirer le câblage de `index.ts` (UsersDb + resolver + injection dans `Auth`/`Server`), l'endpoint
`GET /users/resolve` d'`Api`, `RequestAuthor.identity`, puis le dossier `users/` et le fichier
`users.db`. Aucune autre base n'y référence — snapshot autonome.
