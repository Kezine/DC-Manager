# Cycle de vie matériel — alerte de dépassement de garantie

Feature **AMOVIBLE** : mini-module serveur `lifecycle/` qui surveille les **échéances de
garantie** des équipements et sous-équipements de **tous les documents** et les signale au
service de notifications ([`notifications.md`](notifications.md)). Volet 3 du TODO « âge &
garantie » (les volets 1-2 — mise en évidence en fiche/listing + filtre à états calculés —
sont côté client, cf. `core/LifecycleFormat`). Cadrage arbitré le 2026-08-15 : « reco +
anti-bruit 1er boot » — deux paliers alignés sur l'affichage, tick quotidien, et la première
passe d'un document jamais balayé lève ses alertes **sans notifier**.

> ⚠ Si un 2ᵉ veilleur « cycle de vie » apparaît un jour (âge limite du matériel,
> amortissement…), il rejoint CE module — d'où le nom `lifecycle/` et non `warranty/`.

## Vue d'ensemble

```
 DOCUMENTS (registry.db + <docId>.db)      MODULE lifecycle/ (amovible)         MODULE notify/
   equipments.warranty_end   ─┐        ┌──────────────────────────────┐
   subEquipments.warranty_end ┼─sweep─►│ WarrantyExpiryWatcher (PUR)  │─ raise(key, …, {silent?}) ─►  alertes
                              │        │   ├─ Lifecycle (src-shared/) │─ resolve(key) ────────────►  actives +
   pont index.ts              │        │   │   frontières PARTAGÉES   │                               rappels
   (WarrantySource,           │        │   └─ SweptState + RaisedState│      pont index.ts
    contrat de lecture réduit)┘        │       └─ LifecycleDb          │      (typage structurel,
                                       │          (lifecycle.db)       │       LifecycleProblemReporter)
                                       └──────────────────────────────┘
```

Le veilleur applique le **gabarit `cert-expiry`** (`certs/CertExpiryWatcher`) : passe
immédiate au boot + tick périodique, `raise` idempotent par passe (l'anti-spam/rappels vit
ENTIÈREMENT dans le moteur notify), resolve **différentiel** des clés levées qui disparaissent
du balayage (jeu mémoire — ici SEMÉ et MIROITÉ en base, cf. § resolve : persistance requise
faute de routes). **LA différence structurelle** (la raison du cadrage) : la garantie
vit dans les **collections des documents**, pas dans la base du module — c'est le **premier
veilleur à balayer les documents via `DocumentStore`**, un précédent posé proprement (contrat
de lecture réduit `WarrantySource`, rempli par le pont d'`index.ts` — le module n'importe rien
de `documents.ts`).

## Architecture — qui fait quoi

### Serveur (`src-server/src/lifecycle/` — le cœur n'importe JAMAIS ce dossier)

| Fichier | Rôle |
|---|---|
| `WarrantyExpiryWatcher.ts` | **Veilleur PUR** (source/rapporteur/états de balayage et de levée/horloge INJECTÉS — testé avec stubs, `Tests/modules/test-warranty-watcher.js`). Une passe (`scan()`) : pour chaque porteur d'échéance, `Lifecycle.warrantyStatus` → `warn` = `warranty-expiring` (warning), `err` = `warranty-expired` (error), `ok`/null = `resolve` ; puis resolve différentiel **PERSISTANT** (jeu mémoire semé depuis `RaisedState.all()` au constructeur, miroité aux transitions), `markSwept` des documents balayés, `prune` des marqueurs orphelins. Déclare CHEZ LUI (côté consommateur) les quatre contrats : `LifecycleProblemReporter` (notify), `WarrantySource` (documents), `SweptState` et `RaisedState` (états persistants). |
| `LifecycleDb.ts` | **Base SQLite dédiée** `lifecycle.db` (à côté de `registry.db`, pattern module-possède-sa-base : WAL, busy_timeout, synchronous NORMAL). DEUX tables : `swept_docs (doc_id PK, first_swept_at)` matérialise `SweptState` — **PERSISTANT** parce qu'un redémarrage ne doit **ni re-silencer** un document déjà balayé (les expirations survenues depuis sonneraient en silencieux → perdues), **ni rater** une expiration survenue serveur éteint (le document est marqué → elle sonne au boot) ; `raised_keys (key PK)` matérialise `RaisedState` — le jeu du resolve **différentiel**, persistant pour qu'une suppression survenue serveur éteint ne laisse pas d'alerte zombie (cf. § resolve ci-dessous). |
| `LifecycleModule.ts` | **Façade et POINT DE BRANCHEMENT UNIQUE** (pattern `CertsModule`) : assemble base + veilleur + timer (`create`/`start`/`stop`). **AUCUNE route REST** — le module ne produit que des alertes, elles s'affichent dans la page « Notifications » existante ; pas d'`extension()` donc. Une base illisible → module démarré DÉSACTIVÉ (loggé), jamais un serveur qui tombe. |

**Branchement au cœur** (`index.ts`, quelques lignes) : le pont remplit `WarrantySource`
(`documentIds()` = `docs.list()` ; `sweep()` = pour chaque document, `repo(id).list("equipments"
/"subEquipments", pageSize tout)` filtrés `warranty_end` non vide) et ponte `problems` vers
`NotifyModule` (typage **structurel** — no-op si notify est inactif faute de clé). **Coût
ASSUMÉ du balayage** : `repo(id)` **ouvre** chaque document (migration legacy comprise au
premier accès) — passe **quotidienne** sur un parc de documents **petit**, dépôts ensuite en
cache (`DocumentStore.repos`) : le coût réel est une lecture de deux collections par document
et par jour.

### Client — RIEN de nouveau

Les alertes actives et l'historique s'affichent dans la page « Notifications » existante ; les
abonnements se créent par type d'événement (saisie libre). Seule retouche : les deux types
ajoutés aux suggestions d'autocomplétion (`EVENT_TYPE_SUGGESTIONS`, `core/NotifyFormat.ts`).

## Les deux types d'événement — et l'escalade UNE-clé

Deux `event_type` pour que les **abonnements routent différemment** (le préavis en e-mail
quotidien, l'expiration en SMS, etc.) :

- **`warranty-expiring`** (gravité `warning`) — préavis : échéance à ≤ 90 jours, **J-0
  inclus** (le jour de l'échéance, la garantie couvre encore la journée) ;
- **`warranty-expired`** (gravité `error`) — dépassement **STRICT** (J-1 et au-delà).

**Clé raise/resolve : `warranty:<docId>:<collection>:<id>` — UNE clé par équipement**, PAS une
par palier (⚠ **amendement au cadrage**, décidé après mesure du moteur notify — remplace la clé
à palier du § 4.4 du cadrage). Une clé par palier enverrait un **« rétabli » du préavis au
moment même où l'alerte d'expiration part** : le resolve différentiel clôturerait la clé
préavis disparue du balayage — un « bonne nouvelle » mensonger accolé à la mauvaise. La gravité
ET le type d'événement **escaladent donc sur la MÊME alerte** (warn → err : message/type/gravité
rafraîchis à chaque passe, jamais de resolve intermédiaire — parité exacte `cert-expiry` : une
clé, sévérité croissante). **Conséquence assumée et documentée** : l'escalade ne déclenche PAS
d'envoi immédiat — l'alerte est déjà active, seuls les **RAPPELS** portent le nouveau
type/gravité ; le délai est borné par l'intervalle de rappel (12 h par défaut, réglable par
type), exactement comme pour cert-expiry.

**Resolve** quand : garantie **prolongée** (la date repasse au-delà du préavis), **retirée**
(champ vidé/illisible), équipement **supprimé**, document **supprimé** — par différentiel à
chaque passe (tout ce qui était levé et n'est plus constaté est résolu). ⚠ Le jeu des clés
levées est **PERSISTANT** (`raised_keys`, `lifecycle.db`) — pas seulement en mémoire comme chez
cert-expiry : une suppression (ou une garantie vidée) survenue **PENDANT QUE LE SERVEUR EST
ÉTEINT** fait sortir l'item du balayage AVANT le premier scan post-boot ; avec un jeu mémoire
seul (reparti vide au redémarrage), le différentiel ne verrait rien à résoudre et l'alerte
deviendrait un **zombie** rappelé toutes les 12 h à vie. Cert-expiry vit avec ce trou parce que
ses routes DELETE/PUT résolvent au moment de l'action ; `lifecycle/` n'a **aucune route** — la
persistance est son seul colmatage. (Une garantie **prolongée** pendant l'extinction n'a pas ce
problème : l'item reste au balayage avec statut `ok` → resolve explicite.) Le Set mémoire reste
le chemin chaud du scan ; la base n'est écrite qu'aux **transitions** (levée/clôture) et relue à
la construction du veilleur (semence).

**Messages** (français, style cert-expiry) : titre « Garantie expirée — \<nom\> » /
« Échéance de garantie — \<nom\> (J-n) » ; corps avec la collection **lisible**
(« de l'équipement » / « du sous-équipement »), la date AAAA-MM-JJ et la durée en jours ;
`doc_id` posé sur l'événement (portée des abonnements par document).

## Anti-bruit du premier balayage (raise silencieux + marqueur persistant)

**Le problème** : un parc ancien branché sur un serveur neuf = 200 garanties déjà expirées →
200 notifications d'un coup si un abonnement écoute. **La décision** (arbitrage § 4.6) : la
**première passe d'un document JAMAIS balayé** lève ses alertes **SANS notifier**.

Mécanique, en deux pièces :

1. **`raise(key, event, { silent: true })`** — extension **GÉNÉRIQUE** du moteur notify (pas un
   contournement dans lifecycle, cf. [`notifications.md`](notifications.md)) : l'alerte est
   **créée et active** (visible dans la page Notifications, `first_seen` posé) mais **rien ne
   part et rien n'est programmé** — `last_sent` ET `next_remind_at` restent null (un rappel
   planifié n'aurait fait que DIFFÉRER le flood de 12 h). Une alerte née silencieuse le reste
   **à vie** et se clôt **en silence** (décision Q1 : pas de « rétabli » sans `last_sent`).
2. **Le marqueur persistant `swept_docs`** (`lifecycle.db`) : le silencieux est décidé par
   document — `silent` = « ce document n'était pas encore balayé au DÉBUT de la passe ». En fin
   de passe, TOUS les documents visités sont marqués (y compris ceux **sans** échéance : si une
   garantie déjà expirée y apparaît plus tard, elle doit sonner normalement — le serveur
   veillait), et les marqueurs des documents supprimés sont purgés (`prune`).

Les passes **suivantes** sont sonores : une **nouvelle** expiration sur un document déjà balayé
est un problème NOUVEAU pour le moteur → envoi immédiat, comme n'importe quel producteur.

**Limite assumée** : si notify est INACTIF au premier boot (clé `DCMANAGER_SECRETS_KEY`
absente), les documents sont marqués balayés quand même (les `raise` sont des no-op — aucun
état n'existe côté notify). À l'activation ultérieure de notify, les expirations pré-existantes
seront re-signalées par des raise **non silencieux** (documents déjà balayés) → une salve
initiale possible. Le vrai réglage anti-bruit reste alors le choix des **abonnements** (ne pas
s'abonner à `warranty-expired`, ne garder que le préavis).

## Seuils — source UNIQUE partagée (`src-shared/Lifecycle`)

Le serveur ne **re-dérive JAMAIS** le seuil ni les frontières (principe n°3) : la règle
jours/frontières a **déménagé** du client (`core/LifecycleFormat`) vers le module **PARTAGÉ**
`src-shared/Lifecycle.ts` (TS pur, aucun import) — `parseDate`/`daysUntil` (minuits UTC,
granularité jour), `WARN_DAYS = 90` et la décision `warrantyStatus` (`ok`/`warn`/`err`/null ;
J-0 = `warn`, dépassement STRICT = `err`). `LifecycleFormat` **délègue** (il garde la
présentation : décomposition calendaire, libellés i18n, `age`, l'état de filtre) ; le veilleur
consomme la même classe côté serveur. Conséquence garantie : la valeur que l'utilisateur voit
en **orange** dans les listings est EXACTEMENT celle qui déclenche l'alerte — jamais un jour
d'écart. Verrouillé par tests des deux côtés (`test-lifecycle-format.js` § « source unique »,
`test-warranty-watcher.js`).

## Tick — quotidien, divergence assumée avec cert-expiry

Passe au **boot** (état du parc immédiat + rattrapage de ce qui a expiré serveur éteint) puis
tick **QUOTIDIEN** (`SCAN_INTERVAL_MS`, `LifecycleModule`). Le gabarit cert-expiry tourne, lui,
toutes les heures — divergence **assumée** : `warranty_end` est une date à granularité **JOUR**
(l'état ne change qu'au passage de minuit UTC), un tick horaire ne détecterait rien de plus et
multiplierait par 24 les ouvertures de dépôts. Les seuils sont des constantes v1 (pas de
réglage par document — parité « paliers fixes » du veilleur de rappels d'interventions).

## Périmètre

`equipments` + `subEquipments` (les deux porteurs de `warranty_end`) de **tous les documents**.
Les spares n'ont pas de garantie (hors périmètre, comme au volet 1 du TODO).

## Mode local (fichier) — principe n°15

**Même exception documentée que notify** : le service de notification est serveur par nature
(canaux, anti-spam, rappels, veilleur qui tourne en continu) — ce module n'existe donc qu'en
mode API. Les **ÉTATS de garantie**, eux, restent entièrement visibles en mode fichier : mise
en évidence en fiche, colonne « Âge / garantie » des listings et filtre à états calculés
(volets 1-2, `core/LifecycleFormat` sur la règle partagée `src-shared/Lifecycle`) fonctionnent
sans serveur — seule l'ALERTE POUSSÉE est absente.

## Suppression de la feature (script d'amovibilité)

Aucun autre module ne dépend de `lifecycle/` (le cœur serveur ne l'importe jamais ; notify est
pointé par typage structurel, jamais importé).

1. **Serveur** : supprimer `src-server/src/lifecycle/` en entier. Dans `index.ts`, retirer
   l'import `LifecycleModule` (et l'import `Schema` s'il n'y sert qu'au pont), la création
   `LifecycleModule.create({ … })` (source + pont `problems`), `lifecycle.start()` et le
   `lifecycle.stop()` du handler d'arrêt. Supprimer le fichier `lifecycle.db` (et ses `-wal`/
   `-shm`) s'il existe.
2. **Compilation des tests** : retirer les deux entrées `src-server/src/lifecycle/*.ts` de
   `tsconfig.node.json`.
3. **Client** : retirer `"warranty-expiring"`/`"warranty-expired"` des `EVENT_TYPE_SUGGESTIONS`
   (`core/NotifyFormat.ts`) — la saisie reste libre, c'est cosmétique.
4. **Tests** : supprimer `Tests/modules/test-warranty-watcher.js` + sa ligne dans `run.js`, et
   la section « source unique » de `test-lifecycle-format.js` si `src-shared/Lifecycle.ts` est
   retiré aussi. ⚠ `src-shared/Lifecycle.ts` ne PART que si le client cesse d'y déléguer
   (`LifecycleFormat` le consomme pour l'affichage — indépendant du module serveur : le laisser
   est le choix normal).
5. **Doc** : supprimer ce fichier + son entrée dans l'index de `CLAUDE.md` + le paragraphe
   « producteur warranty-* » de `notifications.md`.

## Ajouter un veilleur au module

Un futur veilleur « cycle de vie » (âge limite, amortissement…) rejoint CE module :

1. Créer `lifecycle/<Nom>Watcher.ts` sur le gabarit `WarrantyExpiryWatcher` : contrats déclarés
   CHEZ LUI (source de lecture, rapporteur — réutiliser `LifecycleProblemReporter` si les
   signatures suffisent), clé stable `"<préfixe>:<docId>:…"`, `scan()` synchrone avec resolve
   différentiel, horloge injectée, règle de décision dans `src-shared/` si le client l'affiche
   aussi (source unique).
2. S'il a besoin d'un état persistant, ajouter sa table à `LifecycleDb` (CREATE idempotent +
   `ensureColumn` si évolution) — jamais une table de `registry.db`.
3. L'instancier dans `LifecycleModule.create` et le faire tourner dans le MÊME tick (ou un
   timer dédié si sa granularité diffère — commenter la divergence).
4. Étendre le pont d'`index.ts` (nouvelles lectures dans la source) + `EVENT_TYPE_SUGGESTIONS`.
5. Tests dans `Tests/modules/test-warranty-watcher.js` (ou un fichier frère) : stubs + horloge
   contrôlée, paliers aux frontières, resolve, clés.
