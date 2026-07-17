# Interventions & incidents

Feature **AMOVIBLE** (lot SERVEUR) : suivre, DANS l'application, les **incidents** subis
(panne, sinistre) et les **interventions** planifiées (maintenance, changement) d'une
infrastructure, en les **liant** aux objets déjà inventoriés (équipements, VMs, spares).
Chaque objet porte un cycle de vie, une priorité de traitement, une fenêtre d'intervention
optionnelle, une référence Jira facultative et une description markdown. Un **veilleur de
rappels** signale au service de notifications les fenêtres qui approchent de l'heure H.

> **Serveur + client + fiches.** Le module serveur (base, routes, veilleur), la page « Interventions »
> (première page **entièrement localisée** FR/EN) et l'**intégration « fiches »** (badge d'interventions
> ouvertes + « Déclarer une intervention » depuis une fiche équipement/VM/spare) sont livrés. Les messages
> **serveur** restent en **français** ; les libellés localisés des slugs `kind`/`status`/`priority` sont
> l'affaire du **client**, via i18n (décision de cadrage 2026-07-16). Restent hors périmètre : badges dans
> les **listes** (ListView), vue **calendrier**, lecture **Jira enrichie**.

Deux exigences fondatrices (pattern `vm/`, `notify/`, `certs/`) :

- **Découplage maximal** : supprimable sans cicatrice — base SQLite dédiée
  (`interventions.db`), le cœur (api/db/documents/live) n'importe RIEN du dossier
  `interventions/` ; le seul câblage vit dans `index.ts`.
- **Aucune clé d'environnement requise** : rien à chiffrer côté serveur (pas de `SecretBox`).

## Vue d'ensemble

```
             SERVEUR interventions/ (amovible)
  ┌──────────────────────────────────────────────────┐
  │  InterventionsModule (routes + timer 5 min)        │
  │   ├─ InterventionsDb (interventions.db)            │
  │   │    interventions      (objet + audit serveur)  │
  │   │    intervention_links (cibles ordonnées)       │
  │   └─ InterventionReminderWatcher (24 h / 1 h / H)  │
  │              │ pont index.ts (structurel)          │
  │              ▼                                      │
  │   NotifyModule (intervention-reminder)             │
  └──────────────────────────────────────────────────┘
     routes SCOPÉES /documents/:docId/interventions
```

Un objet (`kind` = `incident` | `intervention`) traverse un **cycle de vie**
(`declared` → `planned` → `in_progress` → `closed`, ou `cancelled`), porte une **priorité**
d'ordre de traitement, une **fenêtre planifiée** optionnelle et jusqu'à **200 liens** vers des
cibles du document. Le serveur pose l'**audit** (qui/quand), calcule une colonne `search`
dénormalisée, et surveille les fenêtres à démarrer.

## Modèle

- **`kind`** (slug anglais, libellé côté client) : `incident` (subi) ou `intervention`
  (planifiée). Un seul modèle pour les deux — ils partagent cycle de vie, liens et fenêtre.
- **`status`** : `declared` · `planned` · `in_progress` · `closed` · `cancelled`. **UN SEUL
  état terminal « closed »** (décision de cadrage : pas de « résolu » distinct) ; `cancelled`
  = abandonné sans traitement. `closed_date` est posé **automatiquement à l'entrée** en
  `closed` (conservé tant qu'on y reste, **effacé** dès qu'on en sort).
- **`priority`** : `low` · `normal` · `high` · `critical`. Sémantique = **ordre de traitement
  / complexité** (PAS une gravité d'incident). Sert de **rang de tri sémantique** (cf. « Tris »).
- **`planned_start` / `planned_end`** : fenêtre d'intervention **OPTIONNELLE** (ISO 8601).
  `planned_end` **exige** `planned_start` et doit lui être **postérieur ou égal**.
- **`jira_ref`** : clé (`INFRA-123`) ou URL — **simple RÉFÉRENCE**, AUCUN appel Jira n'est
  fait côté serveur. Le client fabrique un lien en la préfixant par `JIRA_BASE_URL` (cf. route
  `/meta`).
- **`description`** : markdown (rendu côté client plus tard), bornée à 100 000 caractères.
- **Audit** (`created_by`/`created_date`, `updated_by`/`updated_date`) : posé **PAR LE
  SERVEUR**, jamais par le client. Le nom vient de l'utilisateur authentifié (SSO/Basic Auth),
  via le helper PARTAGÉ `RequestAuthor.name(req)` (le même que la notif live du cœur — cf.
  `src-server/src/api.ts`). Un client qui enverrait ces champs est **ignoré**.

## Liens sans FK — politique d'orphelins

Les cibles (`equipment` / `vm` / `spare`) vivent dans les **bases des DOCUMENTS**
(`registry.db` par document), **séparées** de `interventions.db`. Une clé étrangère
inter-bases est impossible : un lien est donc un **simple couple opaque** `(target_kind,
target_id)`. Conséquences **assumées** :

- **AUCUNE validation d'existence** de la cible à l'écriture — une cible supprimée après coup
  laisse un **lien orphelin**, **toléré**. C'est le **client** qui affichera « introuvable » en
  résolvant les liens contre le document.
- Les liens sont une **table ORDONNÉE** (`position` = index du tableau, jamais de JSON en DB,
  pattern `certificate_sans`) et **remplacés INTÉGRALEMENT** à chaque `save` (l'ordre du
  tableau fait foi). Ils partent en **CASCADE** à la suppression de l'objet.

## Schéma de `interventions.db`

Base SQLite **dédiée au module** (à côté de `registry.db` dans le dossier injecté), POSSÉDÉE
par `interventions/` : jamais une table de `registry.db`. `PRAGMA foreign_keys = ON` à chaque
connexion (le `ON DELETE CASCADE` des liens en dépend), WAL + `busy_timeout` + `synchronous =
NORMAL` (parité `DocumentStore`/`CertsDb`). Migrations `ensureColumn` idempotentes **prêtes
pour l'avenir** (pattern `CertsDb`).

- **`interventions`** — l'objet : `doc_id` + `id` (**PK composite**), `kind`, `title`,
  `description` (`TEXT NOT NULL DEFAULT ''`), `status`, `priority`, `created_by`,
  `created_date`, `updated_by`, `updated_date`, `planned_start`, `planned_end`, `jira_ref`,
  `closed_date`, **`search`** (colonne DÉNORMALISÉE `TEXT NOT NULL DEFAULT ''` =
  `normSearch(title + description + jira_ref)`, recalculée à CHAQUE save avec la MÊME
  normalisation partagée que le cœur — `Schema.normSearch`). Index : `(doc_id, search)`
  (filtre `query` — LIKE), `(doc_id, status)`, `planned_start` (balayage du veilleur).
- **`intervention_links`** — cibles liées en **table ORDONNÉE** : `doc_id`,
  `intervention_id`, `position` (**PK composite**), `target_kind` (`equipment`/`vm`/`spare`),
  `target_id`. **FK `ON DELETE CASCADE`** `(doc_id, intervention_id) → interventions(doc_id,
  id)`. **AUCUNE FK vers la cible** (elle vit dans une autre base — cf. « Liens sans FK »).

## Listing paginé

`GET /documents/:docId/interventions` renvoie une **page** (LIMIT/OFFSET en SQL pur, jamais de
chargement complet), réponse forme ListResult `{ interventions, total, page, pages, pageSize }`
— chaque item **inclut ses liens** (petits). Paramètres (validation **SOUPLE** : toute valeur
inconnue est **ignorée**, jamais de 400) :

- `page` (déf. 1, clampée à la dernière page existante), `pageSize` (déf. **25**, plafond
  **200**) ;
- `query` : recherche normalisée (`normSearch`) sur la colonne `search` (titre + description +
  réf. Jira), **insensible à la casse et aux accents** ;
- `kind` / `status` / `priority` : filtres **RÉPÉTABLES** (`IN`) ;
- `sort` : `title` | `status` | `priority` | `planned_start` | `created_date` |
  `updated_date` ; `dir` : `asc` | `desc`. **Tri STABLE** (`id` en dernier critère).

**Tris — rangs sémantiques.** `status` et `priority` sont triés par **RANG** (leur ordre
canonique), pas alphabétiquement (l'ordre lexical de leurs slugs n'aurait aucun sens) :
`status` suit le **cycle de vie** (`declared` < `planned` < `in_progress` < `closed` <
`cancelled`), `priority` suit l'**intensité** (`low` < `normal` < `high` < `critical`).
`planned_start` place les **NULL en dernier** dans les deux sens. **Défaut** (sort absent/
inconnu) : les plus **récemment modifiés** en tête (`updated_date DESC`).

## Routes REST

Toutes montées sous la **garde d'accès** du cœur, au chemin **SCOPÉ PAR DOCUMENT**
`<apiBase>/documents/:docId/interventions` (`mergeParams`). Réponses **503** explicites si le
module est en erreur (base illisible). ⚠ `/meta` est déclarée **AVANT** `/:id` (sinon « meta »
serait lu comme un id).

- `GET    /documents/:docId/interventions` → **listing paginé** (cf. ci-dessus) ;
- `GET    /documents/:docId/interventions/meta` → `{ jira_base_url }` : valeur de la variable
  d'environnement **`JIRA_BASE_URL`** (trim ; vide/absente → `null`). Sert au client à
  fabriquer le lien vers un ticket depuis une clé Jira — SANS aucun appel Jira côté serveur ;
- `GET    /documents/:docId/interventions/counts?target=<kind>:<id>&target=…` → `{ counts: { "<kind>:<id>":
  n, … } }` où `n` = nombre d'interventions **OUVERTES** (status ∉ {closed, cancelled}) liées à cette cible.
  `target` est **RÉPÉTABLE** ; validation SOUPLE (cibles malformées ignorées, dédupliquées, plafonnées à 100 ;
  une cible sans intervention → `0`). Déclarée AVANT `/:id` (« counts » n'est pas un id). Sert les **badges
  de fiche** (équipement/VM/spare). Logique SQL dans `InterventionsDb.countOpenForTargets` (COUNT DISTINCT
  sur l'intervention → un objet lié deux fois à la même cible compte pour 1) ;
- `GET    /documents/:docId/interventions/:id` → détail (liens inclus ; **404** sinon) ;
- `PUT    /documents/:docId/interventions/:id` → **créer/mettre à jour** : validation (griefs
  groupés → **400** `{ issues }`), liens **remplacés intégralement**, **audit posé par le
  serveur** (création : `created_*` + `updated_*` ; mise à jour : `updated_*` seuls, `created_*`
  CONSERVÉS), `closed_date` géré automatiquement. Une passe du veilleur suit l'écriture ;
- `DELETE /documents/:docId/interventions/:id` → suppression (**cascade** des liens ; **404**
  si inconnu ; `resolve` du rappel).

## Veilleur de rappels (`InterventionReminderWatcher`)

Producteur **`intervention-reminder`** du service de notifications (pattern
`CertExpiryWatcher`). Il balaye les fenêtres **planifiées** des objets **pas encore démarrés**
(`planned_start` non nul **ET** `status ∈ {declared, planned}`, tous documents) et rappelle
leur échéance de démarrage.

- **Paliers FIXES** (non configurables en v1), référencés à `planned_start` → gravité
  CROISSANTE à l'approche de l'**heure H** :
  - maintenant ≥ `planned_start`          → **error** (« l'intervention devait commencer ») ;
  - maintenant ≥ `planned_start − 1 h`     → **warning** ;
  - maintenant ≥ `planned_start − 24 h`    → **info** ;
  - en deçà (> 24 h avant)                → RIEN (`resolve` d'un éventuel rappel résiduel).
  - **Fenêtre DÉPASSÉE** (`planned_end` passé) et toujours pas démarrée : couverte par le
    palier error (`maintenant ≥ planned_start` l'implique) → **error MAINTENU**, jamais clos.
- **Clé STABLE** `intervention-reminder:<docId>:<id>` ; message **français** avec titre +
  fenêtre (heure incluse — l'heure compte ici, contrairement aux échéances certs mesurées en
  jours). Gravité et message **rafraîchis à chaque passe**.
- **Aucun anti-spam ici** (pattern `cert-expiry`) : `raise` est **idempotent par passe**, les
  rappels répétés (12 h par défaut, réglables par type) vivent ENTIÈREMENT dans le moteur
  `notify`.
- **`resolve` de sortie de périmètre** : dès qu'un objet passe `in_progress`/`closed`/
  `cancelled` (ou perd son `planned_start`), il **disparaît de la source** → le veilleur clôt
  son rappel (jeu MÉMOIRE des clés levées). Les routes **PUT** (changement de status) et
  **DELETE** appellent en plus un `resolve` **EXPLICITE** (vaut même pour une alerte levée par
  un processus précédent, hors du jeu mémoire).
- **Timer de 5 MINUTES** (`unref`) — granularité fine **ASSUMÉE** : les paliers 1 h / heure H
  exigent plus fin que l'horaire des certs (une échéance de certificat se mesure en jours ; un
  rappel d'intervention se joue à l'heure près). **Passe immédiate** au démarrage **et après
  chaque écriture**. Horloge et seuils **INJECTABLES** (tests).

Dépendance **INVERSÉE** (pattern `CertExpiryWatcher`) : l'interface
`InterventionProblemReporter` est déclarée **chez le veilleur** — `interventions/` n'importe
RIEN de `notify/`. Le pont concret (`raise`/`resolve` → `NotifyModule`) est câblé dans
`index.ts` par **typage structurel** (le MÊME `NotifyModule` que `vm/` et `certs/`) ; les
features restent amovibles indépendamment. Le rapporteur est **OPTIONNEL** : sans lui, le
module vit normalement, simplement sans notifications.

## Architecture — qui fait quoi (`src-server/src/interventions/`, le cœur n'importe JAMAIS ce dossier)

| Fichier | Rôle |
|---|---|
| `InterventionsValidate.ts` | **Validation PURE** (ni DB ni réseau), griefs GROUPÉS, messages français uniques (mêmes principes que `CertsValidate`/`NotifyValidate`). Porte les tables `INTERVENTION_KINDS`/`INTERVENTION_STATUSES`/`INTERVENTION_PRIORITIES`/`INTERVENTION_TARGET_KINDS`, les invariants de fenêtre (`end` exige `start`, `end ≥ start`) et le bornage des liens (≤ 200, `target_id` non vide ≤ 200). **Ignore** les champs d'audit envoyés par le client. Héberge aussi `jiraBaseUrl(env)` (normalisation de `JIRA_BASE_URL`), placée ICI — module PUR, sans Express — pour rester **testable en isolation** ; la route `/meta` ne fait que la RELAYER. |
| `InterventionsDb.ts` | **Persistance SQLite dédiée** (`interventions.db`), possédée par le module. **2 tables** (cf. « Schéma »). CRUD + **estampillage d'audit SERVEUR** + gestion auto de `closed_date` + **remplacement intégral des liens** + colonne `search` (`normSearch` partagé). **Listing PAGINÉ SQL** (`listPage` — LIMIT/OFFSET, filtres query/kinds/statuses/priorities, tris à **rang sémantique**). `listReminderCandidates` pour le veilleur. Migrations `ensureColumn` prêtes. Driver SQLite **injecté**. **Pas de `SecretBox`** : rien à chiffrer côté serveur. |
| `InterventionReminderWatcher.ts` | **Veilleur de rappels** (producteur `intervention-reminder`) : balaye `planned_start`, `raise` les fenêtres sous seuil (gravité croissante 24 h/1 h/H), `resolve` celles qui démarrent/disparaissent. Déclare **chez lui** l'interface `InterventionProblemReporter` (dépendance INVERSÉE) — n'importe RIEN de `notify/`. Horloge et seuils injectables (tests). |
| `InterventionsModule.ts` | **Façade et POINT DE BRANCHEMENT UNIQUE** (amovible, pattern `CertsModule`) : assemble `interventions.db` + routes REST (`ApiExtension`) + timer de 5 min. Module « en erreur » (base illisible) → routes **503** détaillé sans faire tomber le serveur. Rapporteur de problèmes **OPTIONNEL**. |

**Branchement au cœur** : point d'extension GÉNÉRIQUE `ApiExtension` (`api.ts`, le même que
`vm/`/`notify/`/`certs/`) ; le câblage concret tient en quelques lignes dans `index.ts`
(création du module, **pont** `problems` vers `notify/`, montage de l'extension,
`start`/`stop`). Le helper d'audit `RequestAuthor` est exporté par `api.ts` et **partagé** par
le cœur (notif live) et ce module (principe n°3 — aucune duplication de la règle « qui a
écrit ? »).

### Client (`src-client/` — aucune dépendance du cœur front ne pointe vers ces fichiers)

| Fichier | Rôle |
|---|---|
| `views/forms/InterventionsClient.ts` | **Client REST** du module + `InterventionsError` (code HTTP + `detail`). DTOs = **MIROIRS** commentés des formes serveur (duplication assumée, principe n°3 — préserve l'amovibilité). `listPage`/`meta`/`counts`/`getOne`/`save`/`remove` ; `buildQuery` PURE (filtres `kind`/`status`/`priority` **répétables**). ⚠ Routes **SCOPÉES PAR DOCUMENT** (`<dataBase>/interventions/…`, comme `CertsClient`). |
| `core/InterventionsFormat.ts` | Logique **PURE** (aucun DOM, aucune dépendance i18n — testée en isolation) : `kindLabelKey`/`statusLabelKey`/`priorityLabelKey`/`targetKindLabelKey` renvoient des **CLÉS** i18n (la vue appelle `I18n.t` dessus, le module reste pur) ; `priorityRank`/`priorityClass`/`statusClass` (rang & couleur de badge) ; `jiraUrl` (référence Jira → lien, jointures de `/`) ; `formatWindow` ; `shortId`. Porte les slugs MIROIRS des énumérations serveur. |
| `views/InterventionsAdminView.ts` | **Page « Interventions »** (onglet PRINCIPAL), classe DÉDIÉE et AUTONOME (ne dérive PAS de `Forms`, pattern `CertsAdminView`/`NotificationsAdminView`) : listing paginé serveur, modales de création/édition, éditeur de liens, transitions rapides. Déclare l'interface hôte `InterventionTargetSource` (cibles injectées — la vue ne touche JAMAIS le Store) ; `openCreateFor(kind, id)` ouvre une création PRÉ-LIÉE (déclaration depuis une fiche). Les formulaires s'ouvrent dans LA modale de l'app (principe n°11). |
| `views/InterventionFicheHooks.ts` | **Contrat d'intégration « fiches »** `InterventionFicheHooks { countOpen; declareFor }` (injecté via `FormHost.interventionHooks`, implémenté dans `main.ts`) — permet aux fiches détail d'afficher le badge et de déclarer SANS importer la vue ni le client (découplage principe n°2). |
| `views/forms/InterventionFicheRow.ts` | Helper DOM PARTAGÉ (une seule implémentation pour les 3 fiches) : rangée « Interventions » (badge async + bouton « Déclarer »). No-op si `hooks` null. Ne connaît que le contrat. |

**Branchement client** : `main.ts` enregistre l'onglet principal « Interventions » (`shell.addView`, JUSTE AVANT « Certificats »), crée `InterventionsClient` en mode API seulement (null sinon → « mode API requis »), et injecte l'implémentation de `InterventionTargetSource` construite sur le Store (collections `equipments`/`vms`/`spares`).

## Page « Interventions » (`InterventionsAdminView`)

**Onglet PRINCIPAL** de premier niveau, enregistré JUSTE AVANT « Certificats ». Vue custom TOUJOURS
enregistrée : `interventionsClient` est null hors mode API → la page affiche « mode API requis »
(parité `NotificationsAdminView`/`CertsAdminView`). Aucun document ouvert → message dédié (les
interventions sont propres au document).

- **PREMIÈRE PAGE ENTIÈREMENT LOCALISÉE** : TOUTES les chaînes d'UI passent par `I18n.t` (domaine
  `interventions.*` + `tabs.interventions`, catalogues `fr`/`en` — complétude vérifiée par
  `Tests/modules/test-i18n.js`). La logique PURE (`InterventionsFormat`) reste i18n-agnostique (elle
  renvoie des CLÉS) ; la vue localise au point d'affichage.
- **Listing PAGINÉ SERVEUR** (jamais de slice client, CSS des `ListView` : `.list-toolbar`/`.pagination`/
  `.sortable`/`.sort-ind`) : toolbar = champ de **recherche** (query, anti-rebond ~250 ms) + filtres
  **MultiSelect** « Type »/« Statut »/« Priorité » (répétables) + « Réinit. filtres » ; **tri** par clic
  d'en-tête (Titre/Priorité/Statut/Fenêtre) ; état de listing en mémoire d'instance (après écriture, la
  **page courante** est rechargée — clamp serveur si elle disparaît). Colonnes : Titre, Type, **Priorité**
  (badge coloré par rang), **Statut** (badge), **Fenêtre planifiée** (`formatWindow`, vide sinon), **Liens**
  (compte + détail en survol), **Jira** (lien cliquable via `jiraUrl` + `meta` chargée UNE fois ; texte brut
  si pas de base), **Créé par**, Actions.
- **Actions par ligne** : **Modifier** (modale), **Démarrer** (declared/planned → `in_progress`), **Clore**
  (`in_progress` → `closed`), **Supprimer** (confirmation danger). Les transitions rapides font un **GET
  unitaire puis un PUT du corps complet** avec le status changé (le serveur re-estampille `updated_*` ;
  repartir de l'état serveur évite d'écraser une édition concurrente).
- **Modale de création/édition** (principe n°11) : nature FIGÉE (création via bouton dédié « + Incident » /
  « + Intervention », édition immuable), titre, description (textarea markdown), priorité, statut (édition
  seulement — création : `planned` pour une intervention, `declared` pour un incident), `planned_start`/
  `planned_end` (inputs `datetime-local` optionnels, manipulés en **UTC** pour rester cohérents avec le
  stockage et le veilleur), `jira_ref`, et l'**éditeur de LIENS**.
- **Éditeur de liens** (interface hôte `InterventionTargetSource` injectée) : sélecteur « famille »
  (équipement/VM/spare, libellés i18n) + sélecteur des cibles disponibles (libellés du document) + bouton
  « Ajouter » ; liste ORDONNÉE des liens avec retrait. **Politique orphelins côté UI** : une cible disparue
  (`labelOf` → null) s'affiche « (introuvable) » **grisée** — le lien est conservé (aucune FK côté serveur,
  cf. « Liens sans FK »), c'est bien le client qui matérialise l'orphelin.
- **Lien Jira** : la base d'URL vient de `GET …/interventions/meta` (`JIRA_BASE_URL`), chargée **une seule
  fois** au premier rendu. `InterventionsFormat.jiraUrl(base, ref)` fabrique le lien (référence déjà URL →
  telle quelle ; base absente → référence en texte brut). Aucun appel à Jira.

## Depuis les fiches (badge + déclaration)

Point d'usage du cadrage : **déclarer une intervention DEPUIS la fiche** d'un équipement / d'une VM / d'un
spare, et y **voir d'un coup d'œil** les interventions ouvertes.

- **Où.** Une rangée « Interventions » DISCRÈTE dans les **fiches détail** (`equipmentDetail`, `vmDetail`,
  `spareDetail`) — placée sous l'identité de l'objet. Choix des fiches détail (et non des formulaires
  d'édition) : c'est là que « voir d'un coup d'œil » a du sens, ces fiches sont en **lecture seule** (donc
  fermer proprement pour déclarer ne perd aucune saisie) et n'existent que pour un objet **déjà créé** (jamais
  en création). La rangée porte un **badge** « N ouverte(s) » (chargé en **async**, `warn` si N > 0, discret
  sinon ; **silencieux et non bloquant** en cas d'échec réseau → « — ») et un bouton **« Déclarer une
  intervention »**.
- **Découplage** (principe n°2). Les fiches n'importent **NI la vue NI le client** interventions : elles ne
  connaissent que le contrat `InterventionFicheHooks { countOpen; declareFor }` (fichier
  `views/InterventionFicheHooks.ts`), injecté via **`FormHost.interventionHooks`** et implémenté dans
  `main.ts`. La rangée elle-même est un helper PARTAGÉ `views/forms/InterventionFicheRow.ts` (une seule
  implémentation pour les trois fiches).
- **Modale dans modale.** La modale de l'app est un **overlay UNIQUE** (pas d'empilement — cf. `ui/Modal`).
  Le bouton **FERME donc d'abord** la fiche courante (`host.closeModal`), **PUIS** `declareFor` **navigue**
  vers l'onglet « Interventions » (`shell.switchView`) et ouvre la **modale de création PRÉ-LIÉE** à la cible
  (`InterventionsAdminView.openCreateFor` — nature « intervention », lien pré-ajouté, cible en sous-titre).
- **Mode fichier / hors API.** `interventionHooks` est **null** → `InterventionFicheRow.attach` est un **no-op**
  (aucune rangée « Interventions » dans les fiches). L'intégration est ainsi totalement absente sans serveur.

## Limites assumées (v1)

- **Pas de commentaires ni de journal d'activité** par objet (un seul texte : `description`).
- **Pas d'assignation** (qui traite quoi) : l'audit note seulement le dernier auteur d'écriture.
- **Pas de vue calendrier** côté serveur : le listing trie/filtre, l'agenda est l'affaire du
  client s'il vient un jour.
- **Jira = simple RÉFÉRENCE** : aucune intégration (pas d'appel API, pas de synchro d'état) —
  juste une clé/URL et une base d'URL (`JIRA_BASE_URL`) pour fabriquer un lien côté client.
- **Liens sans intégrité référentielle** (bases séparées) : orphelins tolérés (cf. « Liens
  sans FK »).
- **Paliers de rappel FIXES** (24 h/1 h/H), non configurables par document (les intervalles de
  RAPPEL, eux, restent réglables par type dans la page « Notifications », comme tout producteur).

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `JIRA_BASE_URL` | *(vide)* | Base d'URL pour fabriquer un lien vers un ticket depuis une clé Jira (ex. `https://monorg.atlassian.net/browse/`). Trimmée ; vide/absente → `null` (le client masque alors le lien). Exposée par `GET …/interventions/meta`. |

> La variable peut être ajoutée à `src-server/docker-compose.yml` (section `environment`) ; ce
> fichier n'est PAS modifié ici (l'utilisateur y a des modifications locales non committées).
> Doc de référence des variables d'environnement : `README.md` §4.

## Suppression de la feature (script d'amovibilité)

Aucun autre module ne dépend de `interventions/` (revue d'imports : le cœur serveur ne
l'importe jamais).

1. **Serveur** : supprimer `src-server/src/interventions/` en entier. Dans `index.ts`, retirer
   l'import et la création de `InterventionsModule`, son `interventions.extension()` du tableau
   `extensions`, `interventions.start()`/`interventions.stop()`, **et le pont
   `problems: { … }`** passé à `InterventionsModule.create` (les ponts `notify` de `vm/` et
   `certs/` restent inchangés). Supprimer le fichier `interventions.db` s'il existe.
2. **Client** : supprimer `src-client/views/InterventionsAdminView.ts`,
   `src-client/views/forms/InterventionsClient.ts`, `src-client/core/InterventionsFormat.ts`,
   `src-client/views/InterventionFicheHooks.ts`, `src-client/views/forms/InterventionFicheRow.ts` ; retirer de
   `main.ts` l'enregistrement de l'**onglet principal** « Interventions » (`shell.addView` + `new
   InterventionsAdminView(...)` + `interventionsClient` + l'implémentation `InterventionTargetSource` + les
   `interventionHooks`), et les exports dans `views/index.ts`. Retirer le champ `interventionHooks` de
   `FormHost` (`views/forms/shared.ts`) et les **trois appels `InterventionFicheRow.attach`** (+ imports) dans
   `equipmentDetail` (`EquipmentForms.ts`), `vmDetail` et `spareDetail` (`DetailForms.ts`). Retirer le domaine
   `interventions.*` et l'entrée `tabs.interventions` des catalogues `src-client/i18n/locales/fr.ts` ET
   `en.ts` (le test de complétude vérifie la parité).
3. **Tests** : retirer les **trois sections « Serveur : Interventions… »** de
   `Tests/modules/test-server.js`, le fichier `Tests/modules/test-interventions.js` et son entrée dans
   `Tests/modules/run.js`, et les **trois entrées `src-server/src/interventions/…`** de
   `tsconfig.node.json` (`include`).
4. **Documentation** : supprimer ce fichier (`docs/interventions.md`), son entrée dans l'index
   de `CLAUDE.md`, la ligne `JIRA_BASE_URL` de `README.md` §4 et de `src-server/RUN.md` §6.
5. **Ce qui RESTE (indépendant du module)** :
   - le helper **`RequestAuthor`** de `api.ts` — désormais utilisé par le cœur (notif live) ;
     il PRÉEXISTE à la feature (extrait de `writerInfo`) et n'a aucun lien avec elle ;
   - le **service de notifications** (`notify/`) — le producteur `intervention-reminder`
     disparaît simplement, les autres producteurs et abonnements sont intacts ;
   - la variable **`JIRA_BASE_URL`**, si elle a été ajoutée au `docker-compose.yml`, peut y
     être retirée (elle n'est plus lue par personne).
