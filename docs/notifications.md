# Notifications — alertes persistantes anti-spam

Feature **AMOVIBLE** : service serveur qui remet aux destinataires de l'utilisateur
(passerelles e-mail/SMS appelées en webhook, console de diagnostic) des **alertes
sur problèmes persistants** — synchro VM en échec, certificat qui expire… Cadrage
2026-07-14 (« notifications-contacts-cadrage »). Exigences fondatrices :
**découplage maximal** (supprimable sans cicatrice, pattern `vm/`), **anti-spam
intégré** (une alerte, pas un flux d'événements), canaux **branchés par
interface** (webhooks des services que l'utilisateur possède déjà).

> **Ce n'est PAS un flux d'événements.** Le service ne diffuse pas chaque
> occurrence : il suit l'**état d'un problème**. Un détecteur signale l'état
> COURANT à chaque passe (`raise` si le problème est là, `resolve` quand il est
> rétabli) ; le moteur décide seul s'il faut notifier — première alerte, rappel dû,
> ou silence. Le producteur ne compte rien, ne temporise rien.

> **Mode API uniquement.** Le service vit dans le serveur (bases + timer). En mode
> fichier/viewer il est **sans objet** : la page d'administration affiche « nécessite
> le mode API » et n'appelle jamais le réseau (parité `VmClustersView`).

## Vue d'ensemble

```
     PRODUCTEURS (dans le serveur)          MODULE notify/ (amovible)              DESTINATAIRES
  vm/ VmSyncService                    ┌─────────────────────────────┐
   échec de synchro ─ raise(key) ──┐   │  NotifyEngine (anti-spam PUR)│      ┌── console (logs serveur)
   retour normal   ─ resolve(key) ─┤   │   ├─ NotifyDb (notify.db)    │ POST │
                                   ├──►│   ├─ SubscriptionRouter      │─────►├── webhook e-mail
  (cert-expiry, test…)  raise/resolve  │   │    └─ contacts (doc)     │ JSON │
                                   ┘   │   └─ timer de rappels (60 s) │      └── webhook SMS
     ▲ pont index.ts (typage             └─────────────────────────────┘             ▲
       structurel, ProblemReporter)                     ▲                            │
                                          page admin « Notifications » (REST /notify) ┘
```

Cycle de vie d'un problème :
1. Un producteur appelle `raise(key, event)` **à chaque passe** où le problème
   persiste — `key` = identité STABLE du problème (ex. `vm-sync:<docId>:<providerId>`).
   Le moteur envoie la **première** alerte, puis **rien** tant que le rappel n'est pas
   dû (idempotence par run) ;
2. tant que le problème dure, le **timer** (tick 60 s) re-notifie les alertes actives
   dont l'échéance de rappel est atteinte — **sans** que le producteur rappelle `raise`
   (le message est porté par l'état) ;
3. quand le problème disparaît, le producteur appelle `resolve(key)` : message
   « rétabli » remis **une** fois, et seulement si l'alerte initiale était bien partie.

Anti-spam de bout en bout : un problème permanent ne produit qu'une alerte + des
rappels espacés (défaut 12 h, réglable par type), jamais une avalanche.

## Architecture — qui fait quoi

### Serveur (`src-server/src/notify/` — le cœur n'importe JAMAIS ce dossier)

| Fichier | Rôle |
|---|---|
| `Notifier.ts` | **Contrats** SEULS (aucune implémentation) : `NotifySeverity` (`info`/`warning`/`error`), `NotificationTarget` (contact + adresse résolue + canal), `NotificationMessage` (message COMPLET remis à un canal), `Notifier` (`kind` + `send`). `send` **JETTE** en cas d'échec — le moteur journalise et **retentera au prochain rappel** (jamais de retry immédiat) ; une erreur jetée ne contient JAMAIS de secret. |
| `NotifyEngine.ts` | **Moteur anti-spam PUR** (cœur du module) : aucun accès DB/réseau/horloge — état (`NotifyStateStore`), routage (`NotifyRouter`), journal et horloge **INJECTÉS** → testable en isolation. Expose `raise`/`resolve`/`runReminders`. Porte les types `NotifyState`, `ResolvedRecipient`, `NotifyJournalEntry` et la constante `DEFAULT_REMIND_INTERVAL_SEC` (12 h). |
| `MemoryNotifyStateStore.ts` | Implémentation **MÉMOIRE** de `NotifyStateStore` (tests du moteur, usage sans `notify.db`). COPIE les états à l'écriture ET à la lecture : le moteur mute ses objets en place — un store qui partagerait les références masquerait un oubli de `set()` (même sémantique « photo » qu'une ligne SQL). |
| `ConsoleNotifier.ts` | Canal **DUMMY console** (canal v1 livré avec le module) : une ligne par remise sur la sortie injectée (`console.log` par défaut), **n'échoue jamais**. Rend les alertes visibles sans aucune configuration ; aucun secret en jeu. |
| `WebhookNotifier.ts` | Canal **WEBHOOK générique** (décision Q5) : POST JSON `{ to, subject, body, severity, event_type, format }` (ou `{ to, text }` en mode simplifié) + `Authorization: Bearer` optionnel. `fetch` **injecté**, timeout par `AbortSignal`. INVARIANT : une erreur ne cite que le **statut HTTP + l'hôte** — jamais l'URL complète (chemin potentiellement secret), jamais le jeton, jamais le corps de la réponse. |
| `NotifyValidate.ts` | **Validation PURE** des objets de config (mêmes principes que `vm/ProviderConfigValidate`) : `parseInstance` (canal), `parseSubscription` (abonnement), `parseRemindInterval` (réglage) → `NotifyConfigError` à N griefs. Porte les tables `NOTIFIER_KINDS` (`console`/`webhook`) et `SUBSCRIPTION_CHANNELS` (`email`/`sms`). Le jeton n'est jamais cité dans un message. |
| `NotifyDb.ts` | **Persistance SQLite dédiée** (`notify.db`, à côté de `registry.db`), possédée par le module (jamais une table de `registry.db`). **5 tables** (cf. « Schéma »), implémente `NotifyStateStore` pour le moteur, CRUD des canaux/abonnements/réglages, historique paginé + purge. Jetons de webhook **chiffrés** (`token_enc`, `SecretBox`) ; JAMAIS de jeton en lecture (`has_token` seul). Driver SQLite **injecté**. |
| `SubscriptionRouter.ts` | Matérialise le `NotifyRouter` du moteur : `(event_type, doc_id)` → destinataires résolus (instance de canal + contact + adresse + notifier concret). Lit les contacts par le contrat réduit `ContactSource` (dépendance inversée sur le `DocumentStore`). Cas dégradés **loggués et exclus**, jamais d'échec global (cf. « Routage »). |
| `NotifyModule.ts` | **Façade et POINT DE BRANCHEMENT UNIQUE** (amovible, pattern `VmModule`) : assemble moteur + `notify.db` + routeur + timer + routes REST sous forme d'`ApiExtension`. Choisit son sort selon `DCMANAGER_SECRETS_KEY` : présente → module prêt ; absente → **désactivé en bloc** (routes 503, pas de timer, `raise`/`resolve` no-op). Expose `raise`/`resolve` **fire-and-forget** aux producteurs. |
| `../SecretBox.ts` | Coffre de chiffrement des secrets AU REPOS — module serveur **PARTAGÉ** (hors de `notify/`, également utilisé par `vm/`). Documenté en détail dans [`vm-proxmox.md`](vm-proxmox.md) ; résumé au § « Clé de chiffrement » ci-dessous. |

**Branchement au cœur** : point d'extension GÉNÉRIQUE `ApiExtension` (`api.ts`,
le même que `vm/`) ; le câblage concret tient en quelques lignes dans `index.ts`
(création du module, pont vers `vm/`, montage de l'extension, `start`/`stop`).

### Client (`src-client/` — feature AMOVIBLE, aucune dépendance du cœur front)

| Fichier | Rôle |
|---|---|
| `views/NotificationsAdminView.ts` | **Page d'administration** « Notifications » (sous-page du groupe « Paramètres »). Classe DÉDIÉE et AUTONOME (pattern `VmClustersView`, ne dérive PAS de `Forms`) : 5 onglets internes (Canaux, Abonnements, Rappels, Alertes actives, Historique) + bouton de test. `client` null (mode fichier) → message « mode API requis » ; 503 → bandeau actionnable. Le jeton d'un canal n'est JAMAIS réaffiché (écriture seule). |
| `views/forms/NotifyClient.ts` | **Client REST** du module `notify/` + `NotifyError` (code HTTP + `detail`). DTOs = **MIROIRS** commentés des formes serveur (duplication assumée, principe n°3 — préserve l'amovibilité). ⚠ Routes **GLOBALES** (`<apiRoot>/notify/…`, PAS scopées par document, contrairement à `VmSyncClient`) : le document courant n'est qu'un **paramètre** (`?docId`, `doc_id` du corps). |
| `core/NotifyFormat.ts` | Logique **PURE** de la page admin (aucun DOM) : conversions d'intervalle de rappel **HEURES ⟷ SECONDES** (l'UI raisonne en heures, le serveur en secondes), libellé lisible d'un intervalle (`intervalLabel`), résolution SOUPLE d'un libellé de contact (`contactLabel`, garde-fou « contact introuvable »). Constantes `DEFAULT_REMIND_HOURS`/`MIN_REMIND_SEC` = MIROIRS commentés des bornes serveur ; `EVENT_TYPE_SUGGESTIONS` (autocomplétion). Testée dans `Tests/modules`. |
| `models/Contact.ts` | Entité `contacts` (S5) — carnet des destinataires (`name` requis, `email`/`phone`/`notes` optionnels), tenu **PAR DOCUMENT**. Collection INDÉPENDANTE du module notify (cf. « Amovibilité »). |
| Groupe « Paramètres » (S6) | `Shell.addGroup({ kind:"group", children:["contacts","notifications"] })` + `ShellNav` : onglet TOUJOURS déroulant (jamais une vue) regroupant les sous-pages rarement visitées. Indépendant du module notify. |

## Sémantique du moteur (`NotifyEngine`)

Le moteur travaille sur un **état par problème** (`NotifyState`, une ligne par `key`)
et ne connaît que trois entrées, toutes idempotentes/sûres à rejouer.

- **`raise(key, event)` — idempotent PAR RUN.** Les détecteurs l'appellent à
  **chaque** passe sans jamais spammer.
  - `key` inconnue, OU ré-apparition après un `resolve` (nouvel épisode :
    `first_seen` repart) → **envoi immédiat** (`alerte`) ;
  - problème déjà suivi → l'état mémorise le dernier `severity`/`title`/`body` du
    producteur (rappels fidèles à un diagnostic qui s'affine), puis **envoie
    seulement si le rappel est dû** (`now ≥ next_remind_at`) — sinon **silence**.
- **`resolve(key)` — « rétabli » AU PLUS UNE FOIS (décision Q1).** Clôt le problème
  (`resolved_at` posé, plus aucun rappel). Le message « Rétabli — … » n'est remis
  que si l'alerte initiale était **effectivement partie** (`last_sent` posé) : pas
  de « rétabli » pour une alerte restée silencieuse (aucun destinataire routé, ou
  envoi jamais réussi). Inconnu / déjà clos = no-op. Le rétablissement n'est **pas**
  retenté en cas d'échec (message de confort ; l'état clos fait foi).
- **`runReminders()` — passe de rappels AUTONOME** (appelée par le timer). Re-notifie
  tous les états actifs dont l'échéance est atteinte, **y compris ceux dont l'envoi
  initial avait échoué** : le rappel EST le retry. À chaque rappel, l'intervalle est
  **relu** (`remindIntervalSec(event_type)`) → un réglage modifié à chaud prend effet
  dès l'échéance suivante.

Points de conception importants :

- **Rappels par TYPE d'événement** (décision Q2) : intervalle par `event_type`,
  défaut `DEFAULT_REMIND_INTERVAL_SEC` (12 h). L'accès se fait par **fonction
  injectée** (relue à chaque échéance) — d'où le réglage à chaud.
- **Échec d'envoi ≠ échec du problème** : `deliver` remet séquentiellement à TOUS
  les destinataires ; un échec n'empêche pas les autres, il est **journalisé** et
  mémorisé (`last_error`). `last_sent` n'est posé que si **au moins une** remise a
  réussi (et jamais pour un rétablissement) : c'est lui qui conditionne le message
  de rétablissement.
- **`title`/`body` portés par l'état** : le timer reconstruit la notification **sans
  le producteur** (passes espacées, serveur redémarré) — d'où ces colonnes dans
  `notification_states`, extension au cadrage assumée.
- **Aucun destinataire routé = silencieux** (pas une erreur) : les abonnements
  peuvent apparaître plus tard, le rappel suivant les servira.

## Schéma de `notify.db`

Base SQLite **dédiée au module** (`notify.db`, à côté de `registry.db` dans le
dossier injecté), POSSÉDÉE par `notify/` : jamais une table de `registry.db` (le
cœur ne connaît rien de la feature ; supprimer la feature = supprimer le module +
ce fichier). `PRAGMA foreign_keys = ON` à chaque connexion (le `ON DELETE CASCADE`
en dépend), WAL + `busy_timeout` (parité `DocumentStore`/`ProviderConfigDb`).

**Contrainte transverse du cadrage : VRAIES tables, jamais de blob JSON.**

- **`notifier_instances`** — canaux configurés :
  `id` (PK), `kind` (`console`/`webhook`), `label`, `url` (endpoint webhook, NULL
  pour console), `token_enc` (jeton d'appel **CHIFFRÉ** au repos, NULL = sans auth),
  `enabled`, `created_date`/`updated_date`.
- **`subscriptions`** — routage par TYPE d'événement (décision utilisateur) :
  `id` (PK), `doc_id` (NULL = abonnement **global**, tous documents), `event_type`
  (type exact ou `*`), `contact_id` (**référence SOUPLE** vers la collection
  `contacts` d'un document — pas de FK inter-bases), `channel` (`email`/`sms`),
  `notifier_id` (**FK `ON DELETE CASCADE`** → `notifier_instances.id`), `enabled`.
  Index sur `event_type`.
- **`notification_states`** — l'anti-spam/rappels (le `NotifyStateStore` du moteur) :
  `key` (PK), `event_type`, `severity`, `doc_id`, `title`/`body` (**extension au
  cadrage** : le timer reconstruit le message sans le producteur), `first_seen`,
  `last_sent` (dernière remise réussie — conditionne le « rétabli »), `next_remind_at`,
  `remind_interval_sec`, `resolved_at` (NULL = actif), `last_error`. Index sur
  `resolved_at` (la passe de rappels ne balaie que les actifs).
- **`notification_log`** — historique consultable, **purgé PAR ANCIENNETÉ**
  (`LOG_MAX_AGE_DAYS` = 90) : `id` (autoincrément), `sent_at`, `key`, `event_type`,
  `contact_id`, `channel`, `notifier_id`, `phase` (**extension au cadrage** :
  `alerte`/`rappel`/`retablissement`, pour l'affichage), `ok`, `detail`. Index sur
  `sent_at`. Une ligne PAR destinataire tenté.
- **`notify_event_settings`** — intervalle de rappel PAR TYPE (décision Q2, **5ᵉ
  table ajoutée au cadrage** : le réglage doit survivre au redémarrage) :
  `event_type` (PK), `remind_interval_sec`. Absent = défaut 12 h.

**Migrations idempotentes** : `CREATE TABLE IF NOT EXISTS` pour tout, complété par
des `ALTER TABLE ADD COLUMN` **idempotents** (`ensureColumn` inspecte
`pragma_table_info` avant d'ajouter). Les colonnes d'extension (`title`/`body`,
`phase`) sont dans les `CREATE` **et** couvertes par un `ensureColumn` : une
`notify.db` d'une version antérieure gagne les colonnes sans intervention ; sur une
base fraîche ces `ALTER` ne font rien (et documentent le pattern pour les évolutions
futures du schéma).

**Invariant de sécurité (ABSOLU, pattern `ProviderConfigDb`)** : aucun jeton (clair
ou chiffré) ni la clé n'apparaît dans un log, une erreur ou une réponse de LECTURE.
`listInstances` renvoie `has_token` seulement ; un jeton n'est déchiffré que pour
**construire** un notifier (usage serveur, en mémoire, le temps d'un envoi).

## Routage (`SubscriptionRouter`)

Le routeur matérialise le `NotifyRouter` injecté au moteur — **relu à chaque envoi**
(un abonnement ajouté est servi dès le prochain rappel, pas de cache à invalider).
Pour `(event_type, doc_id)`, il déroule les **abonnements applicables** puis résout
chacun en un destinataire concret.

**Sélection des abonnements** (`subscriptionsFor`, SQL) : ceux qui sont `enabled` ET
(`event_type` exact **OU** `*`) ET (portée **globale** `doc_id IS NULL` **OU**
document de l'événement). Un abonnement `*` global capte donc tout ; un abonnement
`vm-sync-failure` sur un document ne capte que ce document.

**Résolution d'UN abonnement**, en trois temps :
1. **Instance de canal** → notifier concret. `instanceForSend` renvoie l'instance
   ACTIVE + le jeton **déchiffré à l'instant** (`SecretBox`), puis fabrique le
   `Notifier` (`console` → `ConsoleNotifier` partagé ; `webhook` + URL →
   `WebhookNotifier`). Instance supprimée/désactivée → abonnement muet ; jeton
   **indéchiffrable** (clé changée) → instance EXCLUE, avertissement SANS contenu.
2. **Contact** (référence souple vers la collection `contacts` d'un document,
   `ContactSource`) : cherché dans le document de l'**événement**, sinon celui de
   l'**abonnement**, sinon dans **TOUS les documents** (repli des abonnements globaux
   — les ids sont des UUID, pas de collision réaliste). Introuvable → abonnement
   ignoré (`warn`).
3. **Adresse selon le canal** : `email` → `contact.email`, `sms` → `contact.phone`.
   Adresse vide → abonnement ignoré (`warn` : contact sans adresse pour ce canal).

**Principe des cas dégradés** : un abonnement inexploitable (contact introuvable,
adresse manquante, jeton indéchiffrable) est **loggué et sauté** — jamais un échec
global. Les autres destinataires du même problème sont servis normalement.

## Webhooks (`WebhookNotifier`, décision Q5)

Les services d'envoi de l'utilisateur (SMS, e-mail) **existent déjà** et s'appellent
en HTTP. Le module POSTe donc sur l'URL configurée, en JSON, un corps aux champs
français (comme les passerelles de l'utilisateur). **Trois réglages PAR INSTANCE**
(cf. `notify.db` : `simple_mode`, `simple_max_chars`, `html`) choisissent la forme
du payload — le formatage vit dans le module PUR `WebhookFormat` (testé en isolation).

**Forme NORMALE** (défaut) — payload complet en clés ANGLAISES (contrat aligné sur les
passerelles de l'utilisateur, décision 2026-07-15), avec une clé `format`
(`"text"` | `"html"`) qui indique à la passerelle comment lire `body` :

```
POST https://webhook.exemple.lan/notify
Content-Type: application/json
Authorization: Bearer <jeton>          (optionnel — omis si le canal n'a pas de jeton)

{
  "to": "ops@exemple.lan",             // adresse résolue (email ou téléphone selon le canal)
  "subject": "Synchro VM en échec — pve-prod",
  "body": "…résumé lisible du problème…",   // texte brut, OU HTML échappé (paragraphes/<br>) si html=true
  "severity": "error",                 // info | warning | error
  "event_type": "vm-sync-failure",
  "format": "text"                     // "text" (défaut) | "html"
}
```

- `html=false` (défaut) → `body` en texte brut (le linefeed est le seul formatage).
  `html=true` → `body` mis en forme HTML, **entités échappées** (le contenu vient des
  producteurs — jamais de confiance).

**Forme SIMPLIFIÉE** (`simple_mode=true`) — pour les passerelles SMS basiques : le POST
n'émet **QUE** deux clés, rien d'autre :

```
{
  "to":   "+32...",                    // adresse du destinataire
  "text": "[erreur] Synchro VM en échec — pve-prod : timeout…"   // message compact, une ligne
}
```

- `text` = gravité (`[avertissement] `/`[erreur] `, rien pour info) + sujet + `— corps`,
  linefeeds repliés en espaces, **tronqué à `simple_max_chars`** (défaut **300**, bornes
  `[20, 5000]`) — l'ellipse « … » finale compte DANS la limite. Le réglage `html` est
  **ignoré** en mode simplifié.

- **Auth** : jeton en `Authorization: Bearer` s'il est défini. Il arrive **en clair**
  à l'instant de l'envoi (déchiffré par `NotifyDb`/`SecretBox`, jamais avant) et ne
  vit qu'en mémoire.
- **Succès** = HTTP 2xx. Sinon échec (retenté au rappel).
- **Timeout** par `AbortSignal` (défaut 10 s) — pas de requête fantôme qui retient
  une remise.
- **INVARIANT « pas de fuite »** : une erreur ne cite que le **statut HTTP + l'hôte**
  (jamais l'URL complète — un chemin de webhook peut porter un secret de type
  capability), jamais le jeton, jamais le corps de la réponse (un service mal luné
  pourrait y refléter l'`Authorization` reçue). Une ceinture (`scrub`) tronque à
  l'hôte toute URL qui apparaîtrait dans un message d'erreur bas niveau.
- `http://` est accepté à dessein (services internes sur le LAN) — la confidentialité
  du trajet relève du déploiement, pas de la validation.

## Clé de chiffrement (`DCMANAGER_SECRETS_KEY`)

Le module réutilise le **coffre `SecretBox` partagé** (`src-server/src/SecretBox.ts`)
pour chiffrer les jetons de webhook au repos — la MÊME clé unique
`DCMANAGER_SECRETS_KEY` que le module `vm/` (détails cryptographiques : AES-256-GCM,
clé = SHA-256 de la passphrase, format versionné `v1:…` — cf. [`vm-proxmox.md`](vm-proxmox.md)).

- **Compatibilité** : l'ancienne `VM_PROVIDERS_KEY` est lue **en repli** si la
  nouvelle est absente (même dérivation), avec un **avertissement** au démarrage
  invitant à renommer la variable (même valeur).
- **Clé absente → module INACTIF en bloc.** Uniformité assumée : même les canaux
  `console` (pourtant sans secret) sont indisponibles — un module, un prérequis, un
  message. Les routes répondent **503 explicite** (« définir `DCMANAGER_SECRETS_KEY`… »)
  et la page admin affiche un bandeau actionnable au lieu des contrôles.
  `raise`/`resolve` deviennent des no-op (les producteurs ne voient qu'une interface
  optionnelle inerte).
- **Module en erreur** (ex. `notify.db` illisible) : routes **503** avec le détail —
  visibilité opérateur sans faire tomber le reste du serveur.
- **Clé perdue = jetons à ressaisir** (aucune récupération — c'est le but). Un test
  direct sur un canal dont le jeton est indéchiffrable répond **409** (« ressaisir le
  jeton du canal »).

## Producteurs de problèmes

Un producteur est un composant serveur qui **détecte** un problème persistant et le
signale au module. Il ne connaît RIEN du module `notify/` : il déclare **chez lui**
l'interface minimale qu'il attend, et `index.ts` **ponte** le `NotifyModule` vers
cette interface au bootstrap (typage **STRUCTUREL** — aucune des deux features
n'importe l'autre, les deux restent amovibles indépendamment).

**Exemple livré — `vm-sync-failure`** (`vm/VmSyncService.ts`) :

- Le service VM déclare **chez le consommateur** l'interface `ProblemReporter`
  (`raise`/`resolve`, mêmes signatures que `NotifyModule`), reçue en paramètre
  **OPTIONNEL** (dernier positionnel — les constructions existantes, tests inclus,
  restent valides sans la fournir ; `undefined` = feature notify absente/inactive →
  aucun signalement).
- Sur une **vraie** passe de synchro (hors sorties anticipées « déjà en cours » /
  anti-rafale, qui ne synchronisent rien) : échec → `raise`, succès → `resolve`,
  avec la clé STABLE `vm-sync:<docId>:<providerId>`. **Aucun comptage/anti-spam
  côté producteur** : il ne fait que refléter l'état COURANT.
- Le corps du `raise` reprend le résumé lisible du statut (garanti **sans jeton** par
  `PveHttp`/`ProviderConfig`).
- **Pont** (`index.ts`) : `problems: { raise: (k, e) => notify.raise(k, e), resolve: (k) => notify.resolve(k) }`,
  passé à `VmModule.create`. Le `NotifyModule` est **créé avant** `VmModule` pour être
  disponible au moment du pontage.

**Deuxième producteur livré — `cert-expiry`** (`certs/CertExpiryWatcher.ts`) : le
veilleur d'échéances de la PKI interne signale les certificats qui approchent de
l'expiration (gravité croissante sur les seuils 30/14/7 j), avec la clé stable
`cert-expiry:<docId>:<certId>`, et les clôt au renouvellement/révocation/suppression.
Même schéma que `vm/` (interface `CertProblemReporter` déclarée côté consommateur, pont
structurel dans `index.ts` sur le MÊME `NotifyModule`) — détails dans
[`certs.md`](certs.md).

**Ajouter un producteur** — 3 étapes (recette générique) :

1. Dans le module producteur, déclarer une interface minimale `raise`/`resolve`
   (copier `ProblemReporter`), reçue en dépendance **optionnelle** ; n'importer RIEN
   de `notify/`.
2. Choisir une **`key` STABLE** identifiant le problème (une clé = une alerte
   dédupliquée : ex. `cert-expiry:<id>`) et un `event_type` STABLE. Appeler `raise`
   **à chaque détection** du problème (l'anti-spam est au moteur), `resolve` au retour
   à la normale.
3. Dans `index.ts`, **ponter** le `NotifyModule` vers l'interface du producteur
   (comme pour `vm/`). Rien d'autre à câbler : les abonnements sur ce nouvel
   `event_type` se créent ensuite dans la page admin.

## Ajouter un notifier (nouveau `kind` de canal)

Pour brancher un nouveau transport (ex. un canal natif SMTP au lieu d'un webhook) :

1. **Implémenter `Notifier`** dans un fichier dédié de `notify/` (`kind` + `send` ;
   `send` JETTE sans secret en cas d'échec). Injecter les dépendances externes
   (client, horloge) pour rester testable.
2. **Déclarer le `kind`** dans `NOTIFIER_KINDS` (`NotifyValidate`) et étendre
   `parseInstance` si la config exige d'autres champs (les messages d'erreur y sont
   uniques, réutilisés par les routes et les tests).
3. **Câbler les fabriques** aux DEUX endroits qui construisent un notifier :
   `SubscriptionRouter.route` (chemin de production) et `NotifyModule.notifierFor`
   (test direct d'un canal). Déchiffrer le jeton via l'instance (`instanceForSend`),
   jamais avant l'envoi.
4. **Étendre l'UI** : ajouter l'option au sélecteur de `kind` du formulaire de canal
   (`NotificationsAdminView.renderCanalForm`) et adapter la visibilité des champs
   (endpoint/jeton) au nouveau `kind`.
5. **Tests** (`Tests/modules/test-server.js`) : aller-retour du notifier avec un
   transport stub (aucun réseau réel), + un cas d'échec vérifiant l'absence de secret
   dans le message.

## Routes REST

Toutes montées sous la **garde d'accès** du cœur, au chemin **GLOBAL** `<apiBase>/notify`
(les canaux ne sont pas scopés par document ; abonnements et états portent un `doc_id`
optionnel). Réponses **503** explicites si le module est inactif (clé absente) ou en
erreur. Aucune réponse ne porte de jeton.

- `GET    /notify/instances` → liste des canaux (SANS jeton, `has_token` seul) ;
- `PUT    /notify/instances/:id` → créer/mettre à jour (jeton en **écriture seule** :
  vide/absent = conserver l'existant) ;
- `DELETE /notify/instances/:id` → supprimer (abonnements en **cascade**) ;
- `GET    /notify/subscriptions[?docId]` → abonnements (tous, ou ceux d'un document +
  les globaux) ;
- `PUT    /notify/subscriptions/:id` → créer/mettre à jour un abonnement ;
- `DELETE /notify/subscriptions/:id` → supprimer ;
- `GET    /notify/states[?docId]` → alertes ACTIVES (états anti-spam non résolus) ;
- `GET    /notify/log[?limit&offset&docId]` → historique paginé (du plus récent) ;
- `GET    /notify/settings` → intervalles de rappel par type ;
- `PUT    /notify/settings` → régler un intervalle (`event_type` + secondes ≥ 60) ;
- `DELETE /notify/settings/:eventType` → revenir au défaut (12 h) ;
- `POST   /notify/test` → remise d'essai (event_type `test`), **HORS moteur
  anti-spam** (résultat immédiat) : mode **routé** (`{ doc_id }` → déroule les
  abonnements `test`/`*`) ou **direct** (`{ instance_id, address }` → teste un canal
  vers une adresse saisie).

## Page d'administration (« Paramètres → Notifications »)

Sous-page du groupe « Paramètres » (`kind:"secondary"`, `parent:"parametres"`),
barre segmentée à 5 onglets internes + actions globales (Actualiser, Envoyer une
notification de test). Rafraîchissement **manuel** (pas de SSE en v1) : l'état vit
côté serveur, on tire à la demande.

- **Canaux** : CRUD des instances ; jeton en champ password « inchangé si vide »,
  jamais réaffiché ; « Tester » un canal (mode direct).
- **Abonnements** : CRUD du routage `type × portée × contact × canal × instance`.
  `event_type` en saisie libre + suggestions ; portée « ce document » / « global » ;
  contact pris dans le carnet du document courant.
- **Rappels** : intervalle par type, **saisi en heures** (converti en secondes par
  `NotifyFormat`), minimum 1 minute ; « Réinitialiser » = retour au défaut 12 h.
- **Alertes actives** : lecture seule (gravité, type, titre, portée, 1re détection,
  dernier envoi, prochain rappel, dernière erreur) — la résolution est pilotée par
  les producteurs.
- **Historique** : journal paginé des remises (date, phase, type, contact, canal,
  résultat, détail).

## Suppression de la feature (script d'amovibilité)

Aucun autre module ne dépend de `notify/` (revue d'imports : le cœur serveur ne
l'importe jamais ; côté client tout vit dans les fichiers dédiés ci-dessous).

1. **Serveur** : supprimer `src-server/src/notify/` en entier. Dans `index.ts`,
   retirer l'import et la création du `NotifyModule`, son `notify.extension()` du
   tableau `extensions`, `notify.start()`/`notify.stop()`, **et le pont
   `problems: { … }`** passé à `VmModule.create` (ou le remettre à `undefined` — le
   paramètre `problems` de `vm/` est optionnel et inerte sans pont). Supprimer le
   fichier `notify.db` s'il existe. `SecretBox.ts` **RESTE** (partagé avec `vm/`).
2. **Client** : supprimer `views/NotificationsAdminView.ts`,
   `views/forms/NotifyClient.ts`, `core/NotifyFormat.ts` ; retirer de `main.ts` les
   enregistrements de la sous-page « Notifications » (`shell.addView` +
   `new NotificationsAdminView(...)` + le `notifyClient`) et l'export correspondant
   dans `views/index.ts`.
3. **Ce qui RESTE (indépendant du module notify)** :
   - `SecretBox` — coffre **partagé** (utilisé par `vm/`) ;
   - la collection **`contacts`** (S5, modèle `Contact` + schéma + validation) — un
     simple carnet du document, sans dépendance à notify ; à retirer séparément si
     voulu (aucune cascade : rien dans le document ne pointe vers un contact) ;
   - le groupe **« Paramètres »** (S6) — conteneur de navigation générique ; s'il ne
     reste que `contacts` dedans, il continue de fonctionner (ajuster ses `children`) ;
   - l'interface `ProblemReporter` dans `vm/VmSyncService.ts` — **optionnelle**, inerte
     sans pont ; on peut la laisser (le producteur ne signale simplement plus rien).
