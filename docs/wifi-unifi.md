# Inventaire des CLIENTS WIFI — collection synchronisée depuis un contrôleur

> Module serveur **AMOVIBLE** `src-server/src/wifi/`, collection partagée `wifiClients`,
> onglet client « Wifi » en LECTURE SEULE. Première implémentation : **UniFi** (API
> d'intégration officielle) — mais **la marque n'est qu'un adaptateur** : tout le reste
> du module en est agnostique (cf. § « Ajouter un provider d'une autre marque »).
> Cadrage d'origine : `.notes/toDos/wifi-clients-provider-unifi-cadrage-2026-08-03.md`.

## Vue d'ensemble

DC Manager sait déjà quels ÉQUIPEMENTS existent (dont les points d'accès, saisis à la
main comme n'importe quel équipement). Cette feature répond à la question voisine :
**qui est connecté, sur quelle borne, depuis quand**. Un service serveur interroge
périodiquement (ou à la demande) un contrôleur wifi, normalise ce qu'il en tire dans un
pivot agnostique, et RÉCONCILIE le résultat avec la collection `wifiClients` du document.

Ce que la feature fait :

- inventorie les clients **connectés** d'UN site d'UN contrôleur, par provider ;
- rapproche chaque client de son **point d'accès** DC Manager (par nom d'équipement) ;
- conserve les clients disparus en les marquant **« déconnectés »** — jamais de suppression ;
- laisse l'utilisateur enrichir chaque client (`description`, `notes`) sans que la synchro
  ne l'écrase jamais.

Ce qu'elle ne fait **pas** (v1, non-buts du cadrage) : aucune écriture IPAM automatique
(l'IP est une colonne cherchable, pas un enregistrement `ipAddresses`) · aucun groupe ·
aucun historique de présence (l'état COURANT seulement) · aucune gestion des bornes
elles-mêmes (les AP restent des équipements saisis à la main — le provider n'en crée
jamais) · ni signal, ni débit, ni roaming · **aucun usage de l'API privée UniFi**.

## Architecture — qui fait quoi

### Serveur (`src-server/src/wifi/` — le cœur n'importe JAMAIS ce dossier)

| Fichier | Rôle |
|---|---|
| `WifiProvider.ts` | **Contrats purs** : pivot `WifiClientRecord`, `WifiInventory`, `WifiProviderConfig`/`Summary`/`ConfigSource`, `WifiProviderAdapter`. **Agnostique de marque** — c'est la frontière. |
| `WifiProviderConfigValidate.ts` | Validation PURE d'un provider : champs **communs** + **branche d'options par `kind`** (`KIND_OPTION_SPECS`). Point d'extension « marque » n°1. |
| `WifiProviderConfigDb.ts` | Stockage `wifi-providers.db` (SQLite dédiée, **table unique**), jetons **chiffrés** (`SecretBox`), deux surfaces (synchro / CRUD UI). |
| `WifiReconcile.ts` | Réconciliation **PURE** : inventaire pivot + clients du document → `{creates, updates, orphans}`. |
| `WifiSyncService.ts` | Boucle : timers, anti-chevauchement, anti-rafale, statut mémoire, validation partagée, écriture transactionnelle + SSE, signalement `notify`. Porte la **fabrique `adapterFor`** — point d'extension « marque » n°2. |
| `WifiModule.ts` | Façade + routes Express `/documents/:docId/wifi/*`, 503 actionnables, audit d'auteur. |
| `UnifiHttp.ts` | **UniFi** : `node:https`, en-tête `X-API-KEY`, hiérarchie de confiance TLS, plafond de réponse, erreurs traduites. |
| `UnifiParse.ts` | **UniFi** : décodage **PUR et TOLÉRANT** (clients, périphériques, sites) + logique de **pagination** pure. |
| `UnifiAdapter.ts` | **UniFi** : orchestration (résolution de site, index des AP, pagination, filtre filaire) — déclare son besoin HTTP par l'interface `UnifiJsonClient`. |

Branchement : **une** ligne d'import + `create`/`extension()`/`start()`/`stop()` dans
`src-server/src/index.ts`. Rien d'autre du cœur ne connaît la feature.

### Partagé (`src-shared/WifiSync.ts`)

La **frontière SOURCE / LOCAUX** : `WIFI_SOURCE_FIELDS` (la liste canonique de ce que la
synchro a le droit d'écraser), `normalizeSource`, `sourceEquals`. Le modèle client
`WifiClient` **délègue** sa normalisation ici, et la réconciliation serveur aussi — c'est
ce qui rend impossible, par construction, un écart de sémantique entre les deux côtés.

> ⚠ Si le modèle client réécrivait sa propre normalisation, la synchro trouverait un écart
> à chaque passe (`"" ` vs `null`, casse, …) et **réécrirait le document en boucle**. Un
> test d'invariant compare les deux, champ par champ.

### Client

- `models/WifiClient.ts` — entité + `displayName` (nom, **sinon la MAC**) ;
- `core/WifiStatus.ts` — présence (« déconnecté ») + type de raccordement : pastilles,
  couleur, tri. Règle **unique**, partagée listing / fiche / palette de recherche ;
- `core/WifiLocate.ts` — « Localiser » un client = **localiser son point d'accès** ;
- `views/ListConfigs.wifiClients` — colonnes et filtres de l'onglet (lecture seule) ;
- `views/forms/WifiForms.ts` — édition des champs LOCAUX + action « Synchroniser » ;
- `views/forms/WifiProvidersForm.ts` — modale de configuration des contrôleurs ;
- `views/forms/WifiSyncClient.ts` — client REST dédié des routes du module ;
- `views/forms/DetailForms.wifiClientDetail` — la fiche ;
- `views/GlobalSearchSources` — famille + portée « wifi: » de la palette Ctrl+K.

## Frontière SOURCE / LOCAUX

| Famille | Champs | Qui écrit |
|---|---|---|
| **SOURCE** | `ext_id`, `provider_id`, `name`, `mac`, `ip`, `client_type`, `ssid`, `ap_mac`, `ap_name`, `connected_since`, `orphan`, `last_sync` | la **synchro**, à chaque passe (écrasement) |
| **DÉRIVÉ** | `ap_equipment_id` | la **synchro** (re-résolu à chaque passe — cf. ci-dessous) |
| **LOCAUX** | `description`, `notes` | l'**utilisateur** seul (fiche → « Modifier ») |

`ext_id` est la **clé de réconciliation**. L'adaptateur UniFi la compose de la **MAC** du
client (repli : l'identifiant technique). Ce choix n'est pas cosmétique : l'identité doit
SURVIVRE à une déconnexion/reconnexion, sinon chaque retour créerait un doublon et
laisserait un « déconnecté » derrière lui.

### Champ dérivé : `ap_equipment_id`

Rapprochement **v1 SIMPLE** (décision D4) : le nom d'AP remonté par le contrôleur (`ap_name`)
est comparé au **nom d'équipement**, insensible à la casse et trimé.

- candidat **unique** → rattaché ;
- **plusieurs** homonymes → **ambigu → null** (on ne devine pas quelle borne) ;
- **aucun** → null.

Il est **re-résolu à CHAQUE passe** : un client qui change de borne suit sa borne, et un AP
créé après coup dans DC Manager est rattaché tout seul à la synchro suivante. Il n'est donc
**pas éditable** (l'éditer serait écrasé à la passe suivante — pire qu'un champ absent).
La suppression d'un équipement le **détache** (cascade `equipments`), sans toucher au client.

> Volontairement plus simple que la hiérarchie à 3 niveaux des VMs (hostnames d'IP, FQDN…) :
> le besoin n'est pas démontré côté wifi, et une hiérarchie non éprouvée produirait des
> rattachements **faux** plutôt que des absents.

### « Déconnecté » ≠ « orphelin »

Le champ persisté s'appelle `orphan`, comme pour les VMs, et la **mécanique est identique**
(patch, jamais de `DELETE`, réapparition couverte sans cas particulier) — c'est ce qui permet
de partager toute la chaîne. Mais le **sens** diffère : l'API d'un contrôleur ne liste que les
clients **connectés**, donc disparaître est un événement **quotidien**, pas un incident. D'où :

- libellé UI « **déconnecté** » (`lists.ph.disconnected`), jamais « orphelin » ;
- couleur d'**avertissement** (`var(--warn)`) et non d'erreur ;
- `connected_since` distingue un vrai **retour** d'une présence continue ;
- **aucune suppression** proposée dans la fiche (contrairement aux VMs orphelines) : un
  client revient dès qu'il se reconnecte, purger détruirait ses notes pour rien.

## Configuration des providers (par document)

Un provider = **une console + UN site**. Multi-sites ⇒ plusieurs providers.
**Pas de pool d'endpoints** (écart assumé au patron VM) : un cluster Proxmox répond sur
chaque nœud, ce qui donne son sens à la bascule ; un contrôleur wifi n'a qu'une console.

### Champs d'un provider

| Champ | Requis | Défaut | Notes |
|---|---|---|---|
| `id` | oui | — | immuable après création (clé de réconciliation des clients) |
| `kind` | oui | — | doit être un type **connu** (`unifi`) — sinon la validation refuse |
| `url` | oui | — | **https obligatoire** : la clé voyage en en-tête à chaque requête |
| `token` | oui à la création | — | clé d'API, **chiffrée au repos**, jamais relue |
| `fingerprint` | non | `null` | empreinte SHA-256 à épingler (console auto-signée) |
| `ca_pem` | non | `null` | CA de la console (PEM) — **publique**, renvoyée en lecture |
| `interval_sec` | non | `0` | `0` = synchro **manuelle** uniquement |
| `timeout_sec` | non | `15` | délai d'UNE requête HTTP |
| `options.site` *(UniFi)* | non | `"default"` | identifiant **OU** nom du site |
| `options.include_wired` *(UniFi)* | non | `false` | opt-in : l'API expose aussi le filaire |

Les **options** sont propres à la marque et validées par la branche `kind` correspondante ;
elles sont persistées en **JSON** dans une colonne `options` — c'est ce qui permet d'ajouter
une marque **sans toucher au schéma de la base**.

### Stockage : `wifi-providers.db` (chiffrée)

Base SQLite **dédiée au module**, dans `DOCS_DIR` (à côté de `registry.db` et de
`vm-providers.db`). **Une seule table** `wifi_providers`, PK `(doc_id, id)`, colonne
`token_enc` (jeton **chiffré**, jamais en clair), colonnes d'audit `created_by`/`updated_by`
posées **par le serveur**.

Invariants de sécurité (les mêmes que le module VM) :

- `listFor` ne renvoie **jamais** le jeton — seulement `has_token: true` ;
- le chemin **STATUT** ne fait circuler **aucun** jeton (`summariesFor`) ;
- un jeton **indéchiffrable** (clé changée) exclut CE provider de la passe et mémorise une
  erreur consultable — **jamais** de `throw` global qui ferait tomber la synchro des autres ;
- aucun jeton, clair ou chiffré, n'apparaît dans un log, un message d'erreur ou une réponse.

### Chiffrement — `DCMANAGER_SECRETS_KEY` (coffre serveur PARTAGÉ)

Le module utilise **la même clé** que `vm/` et `notify/`, via le `SecretBox` serveur partagé
(AES-256-GCM, format `v1:iv:tag:ct`). **C'est voulu** : une seule clé d'infrastructure à
distribuer, à protéger et à faire tourner, plutôt qu'une par feature. Passphrase de **16
caractères minimum** (le constructeur refuse en dessous : la dérivation est un SHA-256 direct,
toute la robustesse repose sur la longueur du secret).

Le chiffrement protège les **copies** de la base (backups, exfiltration du fichier), pas un
attaquant qui contrôle l'hôte — limite assumée, identique à celle documentée pour `vm/`.

### Clé absente / config invalide (503)

- **clé absente** → module inactif : **toutes** les routes répondent `503` avec un `detail`
  actionnable (« définir `DCMANAGER_SECRETS_KEY`… »). Si une `wifi-providers.db` existe
  **déjà** sans clé, le message est enrichi (des jetons chiffrés attendent la clé) ;
- **clé présente mais trop courte, ou base illisible** → module « démarré en erreur »,
  routes en `503` avec le détail. Le serveur, lui, **démarre normalement** : une config
  invalide ne fait jamais tomber l'application.

La modale « Providers… » affiche ce `detail` **à la place** des contrôles d'édition — il n'y
a rien à configurer tant que la clé n'est pas là.

### Dépannage — clé CHANGÉE (jetons indéchiffrables)

Symptômes : les providers disparaissent de la synchro, le statut les réaffiche **en erreur**
avec « le secret doit être ressaisi », et « Tester » répond `422` avec le même message.
Correctif : rouvrir « Providers… », **ressaisir la clé d'API** de chaque provider, enregistrer.
Rien d'autre n'est perdu (URL, site, intervalles, empreinte, CA sont en clair).

## Routes REST

Toutes sous la garde d'accès de l'API, scopées par document. `404` si le document est inconnu.

| Méthode | Chemin | Effet |
|---|---|---|
| `POST` | `/documents/:docId/wifi/sync` | synchronise **tous** les providers du document |
| `GET` | `/documents/:docId/wifi/status` | état par provider (mémoire serveur) |
| `GET` | `/documents/:docId/wifi/providers` | liste **sans** jeton (`has_token`) |
| `PUT` | `/documents/:docId/wifi/providers/:id` | créer/mettre à jour (400 + `issues` si invalide) |
| `DELETE` | `/documents/:docId/wifi/providers/:id` | supprimer (404 si inconnu) |
| `POST` | `/documents/:docId/wifi/providers/test` | tester une config candidate (422 si jeton stocké indéchiffrable) |

Après **chaque** écriture CRUD, les timers périodiques sont **ré-armés** : la configuration
prend effet à chaud, sans redémarrage.

## API UniFi — VALIDÉ sur console réelle / limites

✅ **Validé le 2026-08-04** sur une console réelle : **UniFi Network 10.4.57**, **UniFi OS
Server** auto-hébergé. Le tableau ci-dessous est un **constat**, pas une liste d'hypothèses —
et il reste rassemblé en un seul endroit du code, pour rester corrigeable d'un geste si une
future version de l'API dévie.

| Élément | Constaté | Où c'est décodé |
|---|---|---|
| Base d'API | `/proxy/network/integration/v1` | `UnifiAdapter.API_BASE` |
| Sites | `…/sites` — réponse `{ offset, limit, count, totalCount, data }` | `UnifiAdapter.PATH_SITES` |
| Périphériques | `…/sites/{siteId}/devices` | `UnifiAdapter.pathDevices` |
| Clients | `…/sites/{siteId}/clients` — la **fiche détail** (`GET …/clients/{clientId}`) renvoie **exactement le même objet** que la liste | `UnifiAdapter.pathClients` |
| Pagination | `?offset=&limit=`, réponse `{ data, offset, totalCount }` (+ `limit`/`count`, ignorés) | `UnifiParse.page` / `nextOffset` |
| Authentification | en-tête `X-API-KEY` (clé statique) | `UnifiHttp.AUTH_HEADER` |
| Champs d'un client | `id`, `type` (`WIRELESS`/`WIRED`), `name`, `macAddress`, `ipAddress`, `connectedAt` (ISO **sans** millisecondes), `uplinkDeviceId`, `access.type` (ignoré — hors pivot) | `FIELD_ALIASES` de `UnifiParse.ts` |
| Champs d'un périphérique | `id`, `macAddress`, `ipAddress`, `name`, `model`, `state`, `firmwareVersion`… (seuls `id`/`name`/`macAddress` sont consommés) | `DEVICE_ALIASES` de `UnifiParse.ts` |
| Résolution de l'AP d'un client | par `uplinkDeviceId` → index des périphériques (le client ne porte pas le nom de son AP directement) | `UnifiParse.deviceIndex` / `clientRecord` |
| Site — `internalReference` | un site porte À LA FOIS un `name` lisible (« Sonuma ») **et** une `internalReference` stable (« default » — la valeur par défaut du champ « Site » du formulaire) : la résolution reconnaît maintenant les DEUX, indépendamment (cf. § ci-dessous) | `SITE_INTERNAL_REF_ALIASES` de `UnifiParse.ts` |

Les noms de champs restent acceptés par **alias** (nomenclature camelCase de l'API
d'intégration **et** orthographes historiques d'écosystème) — un choix conservé même après
validation : il ne coûte que quelques lignes et couvre une éventuelle console « Network
Application » autonome dont le vocabulaire diffère légèrement.

### Résolution de site par `internalReference`

Un site UniFi réel porte à la fois un **nom d'affichage** (`name`, ce que l'administrateur voit
dans la console — p. ex. « Sonuma ») et une **référence interne stable** (`internalReference`,
typiquement « default », qui est précisément la valeur par défaut du champ « Site » du formulaire
de provider). Les deux ne coïncident pas, et « Sonuma » ne matche pas « default ».

`findSiteId` teste donc l'`internalReference` comme un **critère de correspondance INDÉPENDANT**
de l'id et du nom (`SITE_INTERNAL_REF_ALIASES`, constante SÉPARÉE de `SITE_NAME_ALIASES`) : un
champ « Site » configuré à `default` se résout **directement** sur le site dont
l'`internalReference` vaut `default`.

⚠ **Ne pas la ranger dans `SITE_NAME_ALIASES`** : la résolution ne retient qu'un seul nom par
site (le premier alias présent), donc dès qu'un `name` existe l'alias serait MORT. La
correspondance ne tiendrait plus que par le repli « console mono-site » de
`UnifiAdapter.resolveSite` — correct par coïncidence sur une console à un seul site, faux sur une
console **multi-site**.
`siteSummaries` (l'énumération du message « site introuvable ») n'a **pas changé** : le libellé
affiché reste `name` en priorité (« Sonuma »), l'`internalReference` n'y sert que de dernier
repli d'affichage quand aucun nom n'est renseigné — cohérent avec ce que voit l'administrateur
dans la console.

### ⚠ Limite mesurée — le SSID n'est PAS exposé

Constat mesuré, pas un problème d'alias : **l'API d'intégration officielle ne sert le SSID nulle
part**, ni dans la liste des clients ni dans la fiche détail (`GET …/clients/{clientId}` rend
exactement le même objet, sans champ SSID caché). Conséquence :

- la colonne **SSID reste vide** pour tous les clients d'un provider UniFi — `UnifiParse` ne
  peut pas décoder ce qu'elle ne reçoit jamais ;
- le champ `ssid` du pivot `WifiClientRecord` **n'est pas retiré** pour autant : il reste au
  contrat commun (multi-marques, décision D9) — une autre marque, ou une future version de
  l'API UniFi, peut le servir ;
- `FIELD_ALIASES.ssid` reste le **point unique** où brancher le champ si l'Integration API
  l'ajoute un jour.

**Piste documentée, SANS implémentation** (décision à prendre par l'utilisateur avant tout
code) : le SSID existe côté contrôleur et est visible dans l'**API privée** de la console
(celle qu'utilise l'interface web UniFi elle-même, non documentée/non stable, hors du contrat
« API d'intégration officielle » retenu par ce module — cf. non-buts en tête de ce document :
« aucun usage de l'API privée UniFi »). Un enrichissement complémentaire par cette API privée
resterait un module strictement SÉPARÉ (`unifi-legacy` ou équivalent), à ne construire que si
le besoin d'exploitation se confirme : elle n'est pas versionnée, peut changer sans préavis
d'une release à l'autre, et sort du modèle de confiance (clé d'API scoping) du reste du module.

### Procédure de re-validation (si une future version d'API dévie)

1. créer une clé d'API **en lecture seule** dans la console ;
2. configurer un provider (URL, clé, site) et cliquer **« Tester la connexion »** :
   - `404` → la base d'API est différente (console « Network Application » autonome :
     essayer sans le préfixe `/proxy/network`) ;
   - « site INTROUVABLE » → le message ÉNUMÈRE les sites disponibles de la console (nom et
     identifiant, plafonné à `UnifiAdapter.MAX_SITES_IN_ERROR`) : recopier l'un des deux dans
     le champ « Site » plutôt que le deviner ;
   - `401/403` → droits de la clé ;
3. lancer une **synchro manuelle** et vérifier dans le listing : nom (ou MAC), IP, type, AP,
   « connecté depuis » (le SSID restera vide, cf. limite ci-dessus). Un champ systématiquement
   vide = un alias à corriger dans `FIELD_ALIASES` ;
4. vérifier le volume : si le total plafonne à `MAX_PAGES × PAGE_SIZE`, la pagination de la
   console ne se comporte pas comme constaté (cf. `UnifiParse.nextOffset`).

## Transport HTTPS et confiance TLS

`node:https` natif, **zéro dépendance**. Hiérarchie de confiance, du plus spécifique au plus
général : **empreinte épinglée** → **CA fournie** → **CA système**. Jamais de « accepter tout ».

> ⚠ `UnifiHttp.trustOptions` est un **jumeau assumé** de `vm/PveHttp.trustOptions` (même
> logique, même piège `checkServerIdentity` qui a causé un bug de production en Node 20/24).
> La duplication est le **prix de l'amovibilité** des deux modules — un fichier commun
> resterait orphelin à la suppression de l'un d'eux. **Toute correction de sécurité dans l'un
> doit être répercutée dans l'autre** ; c'est signalé des deux côtés dans le code.

Plafond de **32 Mio par réponse** (une réponse démesurée est avortée, pas accumulée) et
**cap dur de pages** par ressource : une console qui ignorerait `offset` ne peut pas faire
boucler la synchro indéfiniment.

## Mode local (fichier) — principe n°15

**Constat.** La synchronisation n'est **pas disponible en mode fichier** : elle est produite
côté serveur (jetons chiffrés au repos, appels réseau sortants vers la console).

**Justification.** C'est **la même exception que les VMs et les notifications**, pour la même
raison de fond : le mode fichier n'a ni secret protégé au repos, ni service capable
d'interroger périodiquement un tiers. Stocker une clé d'API dans un document répliqué à tous
les clients serait un contresens de sécurité, pas une commodité manquante.

**Ce qui marche quand même en mode fichier**, et c'est délibéré : `wifiClients` est une
collection du **DOCUMENT** comme les autres. Un document synchronisé puis exporté reste
entièrement **lisible, filtrable, cherchable** (palette Ctrl+K comprise, via la spec partagée
`SearchTerms`) et ses champs **LOCAUX restent éditables**. Seules les actions
« Synchroniser » et « Providers… » sont masquées — il n'y a pas de serveur à interroger.

### Chargement de la collection : PARESSEUX en mode API, complet en mode fichier

Depuis la **vague 3 du chantier lazy-load** (cf. `docs/hydratation.md` § « Vague 3 »),
`wifiClients` — la collection la plus VOLUMINEUSE de l'app, puisqu'elle est alimentée par une
synchro — n'est **plus tirée au démarrage** en mode API. Ce qui change à l'usage :

- l'onglet « Wifi » sert des **pages SERVEUR** réelles (le compteur « n éléments · page x/y » dit la
  vérité du serveur), et son tri porte sur le CORPUS entier pour les colonnes MAC, SSID et
  « Connecté depuis » ; les autres critères ne trient que la page affichée (repli documenté) ;
- les options des filtres **Type** et **SSID** viennent d'un `SELECT DISTINCT` serveur — elles
  couvrent donc tout l'inventaire, pas seulement les pages parcourues. Le filtre **Point d'accès**,
  lui, garde ses options locales : sa valeur est un nom d'ÉQUIPEMENT résolu côté client ;
- après une passe de synchro, un listing OUVERT se rafraîchit tout seul (pastille, page et options) —
  la collection entière, elle, n'est jamais re-tirée : c'est le sens du chargement paresseux ;
- **« Localiser »**, la fiche et l'édition des champs locaux sont **inchangés** : ils partent tous
  d'une ligne déjà affichée, donc déjà en cache.

**Mode fichier / visualiseur : STRICTEMENT rien ne change**, par construction — « le document EST le
fichier », toute collection y est réputée complète (cf. `docs/hydratation.md` § « Mode local »). Les
options de filtre y sont calculées sur le document entier, comme avant.

**Évolution.** Si un besoin de saisie manuelle apparaît (déclarer un client connu sans
contrôleur), il suivra le chemin prévu pour les VMs : un provider « Manuel », qui devra
fonctionner **aussi** en mode fichier.

## Suppression de la feature (script d'amovibilité)

1. **Serveur** : supprimer `src-server/src/wifi/` (les 9 fichiers — `SecretBox.ts` vit HORS
   du module et **reste** : il sert aux autres features à secrets) + les lignes `WifiModule`
   d'`index.ts` (import, `create`, `extension()` de la liste d'extensions, `start()`,
   `stop()`). Supprimer le fichier `wifi-providers.db` sur le serveur.
2. **Client** : supprimer `models/WifiClient.ts`, `core/WifiStatus.ts`, `core/WifiLocate.ts`,
   `views/forms/WifiForms.ts`, `views/forms/WifiProvidersForm.ts`,
   `views/forms/WifiSyncClient.ts` ; retirer les branchements fins : entrée `wifiClients`
   d'`EntityRegistry`, `ListConfigs.wifiClients` + l'onglet `wifi` de `main.ts` (dont son
   `locate`/`locateTarget` et le `wifiSyncClient`), l'entrée `wifiClients` de
   `DetailForms.DETAIL_OPENERS` **et** la méthode `wifiClientDetail`, la famille
   `wifiClients` + la portée `wifi` de `GlobalSearchSources`, les exports de `views/index.ts`,
   l'entrée `RenderImpact`, l'icône `Icons.WIFI`, les catalogues i18n `fr|en/wifi.ts` (+ leur
   ligne dans les agrégateurs) et les clés `tabs.wifi`, `app.wifi`, `detail.wifi`,
   `detail.nf.wifiClient`, `lists.empty.wifiClients`, `lists.ph.disconnected`,
   `lists.ph.wifiClient`, `lists.col.ssid|accessPoint|connectedSince`,
   `search.family.wifiClients`, `search.scope.wifi`. ⚠ Retirer aussi `"wifiClients"` de
   `core/LazyCollections.LAZY_COLLECTIONS_API` (la collection y est déclarée chargée
   PARESSEUSEMENT depuis la vague 3 — cf. `docs/hydratation.md`) : le nom deviendrait sinon
   silencieusement sans effet, et l'invariant testé de la liste échouerait.
3. **Partagé** : retirer `"wifiClients"` de `Schema.COLLECTIONS`, la spec `wifiClients` de
   `DataValidation.ts` (champs **et** entrée de `COLLECTION_SPECS`, plus le type
   `Records.WifiClient`), l'entrée `wifiClients` de `Cascade.ts` **et** le détachement
   `{ coll: "wifiClients", fk: "ap_equipment_id" }` de la règle `equipments`, l'entrée
   `INDEX_SPEC.wifiClients`, la spec `SEARCH_SPECS.wifiClients` + le catalogue
   `SEARCH_CATALOGS.wifiDisconnected` (et **incrémenter** `SEARCH_VERSION`) ; supprimer
   `WifiSync.ts`.
4. **Tests / build** : supprimer `Tests/modules/test-wifi.js` + sa ligne dans `run.js`, les
   entrées `src-server/src/wifi/*` de `tsconfig.node.json`, et remettre à jour les goldens
   qui énumèrent les collections (`DETAIL_COLLECTIONS`, liste d'index relationnels).

Aucun autre module ne dépend de la feature — le cœur serveur n'importe jamais `wifi/`, et
côté client tout vit dans les fichiers dédiés ci-dessus.

## Ajouter un provider d'une autre marque

C'est l'exigence structurante du chantier (décision **D9**) : le pivot, la réconciliation, le
service de synchro, la base de config, les routes et l'UI sont **agnostiques de la marque**.
Ajouter un contrôleur (Aruba, Meraki, Ruckus…) se fait en **quatre** points, et **rien
d'autre** ne bouge — un test d'invariant vérifie d'ailleurs qu'aucun module agnostique ne
nomme une marque dans son code.

1. **L'adaptateur.** Écrire `XxxAdapter` implémentant `WifiProviderAdapter` (`test()` +
   `inventory()`), avec le même découpage que UniFi : `XxxHttp` (accès réseau), `XxxParse`
   (décodage **PUR**, testable par fixtures), `XxxAdapter` (orchestration, qui déclare son
   besoin HTTP par une interface consommateur). Produire des `WifiClientRecord` normalisés —
   c'est le SEUL contrat que voient la réconciliation et l'UI. Choisir un `ext_id` **stable
   à travers les déconnexions** (la MAC est le candidat naturel).
2. **La fabrique.** Ajouter une ligne dans `WifiSyncService.adapterFor` : `if (config.kind
   === "xxx") return XxxAdapter.fromConfig(config);`.
3. **La validation des options.** Ajouter une entrée dans
   `WifiProviderConfigValidate.KIND_OPTION_SPECS` déclarant les réglages propres à la marque
   (nom, type scalaire, défaut). Ils sont persistés en JSON dans la colonne `options` :
   **aucune migration de schéma**.
4. **L'UI.** Ajouter le type au `<select>` (`WifiProvidersForm.KINDS`) et ses champs
   d'option (`WifiProvidersForm.KIND_FIELDS`, miroir de l'étape 3) + les libellés i18n
   correspondants dans `fr/wifi.ts` **et** `en/wifi.ts` (`providers.opt.*`).

Ce qu'il ne faut **pas** faire : ajouter une colonne à `wifi-providers.db` pour un réglage de
marque, tester le `kind` ailleurs que dans la fabrique et la table d'options, ou faire
remonter un champ propre à la marque jusqu'au pivot `WifiClientRecord`.

## Déploiement

| Variable | Rôle | Sans elle |
|---|---|---|
| `DCMANAGER_SECRETS_KEY` | passphrase de chiffrement des jetons (**partagée** avec `vm/` et `notify/`), **≥ 16 caractères** | module inactif, routes en `503` actionnable |

Aucune autre variable d'environnement n'est propre à cette feature (le dossier des documents
et le driver SQLite sont ceux du cœur). Au **premier déploiement** :

1. définir/vérifier `DCMANAGER_SECRETS_KEY` (si `vm/` ou `notify/` tournent déjà, elle est
   là — c'est le but du coffre partagé) ;
2. configurer un provider et **valider les hypothèses d'API** (cf. la procédure plus haut) ;
3. régler `interval_sec` : `0` (manuel) le temps de la validation, puis une période réaliste
   — la synchro relit **tout** l'inventaire du site à chaque passe.

## Tests

`Tests/modules/test-wifi.js` couvre, du plus pur au plus intégré : la frontière partagée et
sa **délégation par le modèle client** (verrou anti-faux-delta), la collection dans les
mécaniques transverses (cascade, recherche, spec, ordre des collections), le **décodage UniFi**
(formes pleines/creuses/inattendues, horodatages, résolution d'AP), la **pagination pure**
(chaque garde-fou séparément) et **réelle** (multi-pages + cap dur), l'orchestration de
l'adaptateur avec un stub HTTP structurel, la **validation par marque**, le **stockage
chiffré** sur better-sqlite3 réel, la **réconciliation**, la **synchro de bout en bout** sur
`DocumentStore` réel, et les **invariants d'agnosticisme de marque**. Les routes
(`WifiModule.ts`, Express) restent hors test, comme `api.ts` et `VmModule.ts`.
