# Inventaire VM (Proxmox) — équipements virtuels synchronisés

Feature **AMOVIBLE** : inventaire des machines virtuelles (QEMU) et conteneurs (LXC)
d'un ou plusieurs clusters Proxmox, répliqué dans le document sous la collection
`vms` par une synchronisation côté serveur. Exigences fondatrices (cadrage
2026-07-12, amendé 2026-07-13) : **découplage maximal** (supprimable sans
cicatrice), **résilience aux releases Proxmox**, providers configurés **par
document** (chaque document = une infrastructure, multi-clusters possibles).

## Vue d'ensemble

```
            Proxmox VE (8/9)                     SERVEUR                          CLIENTS
  /version /cluster/resources /config    ┌──────────────────────┐        ┌──────────────────────┐
  /agent/network-get-interfaces          │ vm/ (module amovible)│  SSE   │ collection `vms`     │
        │                                │  ProxmoxAdapter      │ ─────► │ onglet VMs, fiche,   │
        └── HTTPS (jeton + épinglage) ──►│  → VmReconcile       │changeset│ mapping réseaux,     │
                                         │  → repo.transact     │ "vms"  │ bouton Synchroniser  │
                                         └──────────────────────┘        └──────────────────────┘
```

Une passe de synchro (par couple document × provider) :
1. `ProxmoxAdapter.inventory()` — orchestration des appels API, décodage par
   `ProxmoxParse` (pur, tolérant) → `{ vms: VmRecord[]; cluster: VmClusterInfo }`
   (UN seul passage réseau produit l'inventaire des VMs ET l'état du cluster —
   nœuds/métriques/quorum/version — cf. vue « Clusters », cadrage 2026-07-13) ;
2. `VmReconcile.plan()` (pur) — diff contre les `vms` du document → opérations
   `{créations, patchs minimaux, orphelines}` ;
3. `VmSyncService` — validation PARTAGÉE (autorité serveur), écriture
   transactionnelle + révision + événement SSE (changeset ciblé `vms`) : les
   clients rechargent en granulaire par le mécanisme standard.

Idempotence de bout en bout : un inventaire inchangé ne produit **aucune**
écriture (ni révision, ni SSE, ni bruit d'undo).

## Architecture — qui fait quoi

### Serveur (`src-server/src/vm/` — le cœur n'importe JAMAIS ce dossier)

| Fichier | Rôle |
|---|---|
| `VmProvider.ts` | **Contrat** : `VmProviderAdapter` (test/inventory), pivot `VmRecord`/`VmNic` + état cluster `VmClusterInfo`/`VmClusterNode` (retour `VmInventory`), `ProviderConfig`. Agnostique du provider — Proxmox n'est que la 1re implémentation. |
| `PveHttp.ts` | Client HTTPS d'UN nœud : jeton d'API (`PVEAPIToken=…`) et **hiérarchie de confiance TLS** par endpoint (`trustOptions`, statique pure : épinglage d'empreinte SHA-256 > CA du cluster `ca_pem` > CA système) — jamais « accepter tout ». Erreurs TYPÉES (`PveHttpError.retryable` : joignabilité vs applicatif). Le jeton n'apparaît jamais dans une erreur/un log. |
| `PveHttpPool.ts` | **Pool de nœuds** avec bascule sur défaillance de joignabilité (jamais sur une erreur applicative) et préférence collante (le nœud mort ne coûte son délai qu'une fois par passe). |
| `ProxmoxParse.ts` | Décodage PUR des réponses JSON (chaînes `netN` QEMU/LXC, `/cluster/resources` → VMs ET nœuds, `/cluster/status` → nom + quorate, config, guest-agent). TOLÉRANT : clé inconnue ignorée, valeur manquante → null, jamais de throw. |
| `ProxmoxAdapter.ts` | Orchestration des appels (`/cluster/status` → nom + quorate, `/cluster/resources` SANS filtre → VMs + nœuds, `/version` → version + gamme, configs, agent pour les QEMU allumées). HTTP **injecté** (`PveJsonClient`) → testable par stub. Échec d'une config individuelle ou d'une métadonnée cluster (quorum/version) toléré ; seul l'échec de l'inventaire de masse rejette. |
| `ProviderConfigStore.ts` | Parseur/validation du fichier **LEGACY** `vm-providers.json` (lecture seule, cf. « Configuration »). Délègue la validation par provider à `ProviderConfigValidate`. Sert de source tant que la clé de chiffrement est absente, et alimente la migration vers la DB. |
| `ProviderConfigValidate.ts` | Validation PURE d'UN provider (id/kind/token requis, pool d'urls https + empreintes par nœud + doublons, include_lxc/interval_sec/timeout_sec avec défauts) — PARTAGÉE par le parseur legacy ET le CRUD DB (messages d'erreur IDENTIQUES, zéro duplication). Le token n'apparaît jamais dans un message. |
| `../SecretBox.ts` | Coffre de chiffrement des secrets AU REPOS — module serveur **PARTAGÉ** (hors de `vm/`, réutilisé par `notify/`) : AES-256-GCM (authentifié), clé = SHA-256 de la passphrase d'env `DCMANAGER_SECRETS_KEY` (**compat** : `VM_PROVIDERS_KEY` lue en repli, avertissement de migration), IV aléatoire 12 o, format versionné `v1:<iv>:<tag>:<ct>` (base64). Aucun secret (passphrase/clé/jeton) dans un log ou une erreur. Limites assumées + clé perdue = jetons à ressaisir (cf. « Configuration »). |
| `ProviderConfigDb.ts` | Stockage DB chiffré (`vm-providers.db`, tables typées `vm_providers` + `vm_provider_endpoints` ordonnées, jetons `token_enc`). Deux surfaces : LECTURE synchro (`providersFor`/`configuredDocIds`) ET CRUD sans fuite de jeton (`listFor`/`save`/`remove`/`buildForTest` — `has_token` seul, jamais le jeton). Migre le fichier legacy au démarrage. Driver SQLite injecté. |
| `VmReconcile.ts` | Moteur de réconciliation PUR (clé `ext_id`, périmètre = une instance de provider). Frontière source/locaux, orphelines jamais supprimées, patchs minimaux. Dépendances injectées (résolution d'hôte, id, horloge). |
| `VmSyncService.ts` | Exécution d'une synchro + statut mémoire par doc×provider + timers périodiques (`interval_sec`, anti-chevauchement, `unref`). Sans Express (bus live vu par interface) → testé de bout en bout. `rearmTimers()` relit la config à chaud après une écriture CRUD. **Producteur `vm-sync-failure`** : sur une VRAIE passe (hors sorties anticipées « déjà en cours »/anti-rafale), un échec `raise` et un succès `resolve` un problème persistant AUPRÈS DU MODULE NOTIFICATIONS, via l'interface OPTIONNELLE `ProblemReporter` injectée au bootstrap (typage structurel — `vm/` n'importe rien de `notify/`). Clé stable `vm-sync:<docId>:<providerId>` ; AUCUN comptage/anti-spam ici (rappels et déduplication côté notify — cf. [`docs/notifications.md`](notifications.md)). |
| `VmModule.ts` | Façade : routes REST (sync/status + CRUD/test des providers) + assemblage. Choisit le support de stockage selon `DCMANAGER_SECRETS_KEY` (ou son repli legacy) : DB chiffrée si présente (CRUD actif), fichier legacy sinon (CRUD en **503** explicite). Config invalide → module « en erreur » (503 détaillé) sans faire tomber le serveur ; ré-arme les timers après chaque écriture. |

**Branchement au cœur** : point d'extension GÉNÉRIQUE `ApiExtension`
(`api.ts` — montage sous la garde d'accès, avant la route `/:collection`) ;
le câblage concret tient en 3 lignes dans `index.ts`.

Endpoints (mode API uniquement) :
- `POST <apiBase>/documents/:docId/vm/sync` → synchronise tous les providers du document ;
- `GET  <apiBase>/documents/:docId/vm/status` → état par provider (dernière tentative/réussite,
  compteurs, erreurs) **+ `cluster`** : dernier état connu du cluster (nom, version PVE + gamme,
  quorum, nœuds avec métriques CPU/RAM/uptime) — capturé à chaque inventaire (même passe réseau,
  `/cluster/resources` sans filtre), conservé en MÉMOIRE à travers les échecs (comme
  `last_success`), null tant qu'aucune synchro depuis le démarrage ;
- `GET    …/vm/providers` → liste des providers du document, SANS jeton (`has_token: true`), endpoints inclus ;
- `PUT    …/vm/providers/:id` → créer/mettre à jour un provider (jeton REQUIS à la création, vide/absent en édition = conservé) ;
- `DELETE …/vm/providers/:id` → supprimer un provider (cascade de ses endpoints) ;
- `POST   …/vm/providers/test` → tester une config CANDIDATE (jeton vide + id existant = reprend le stocké) → `ProviderInfo` (ok/version/gamme/message).

Les quatre routes `providers` répondent **503** explicite si `DCMANAGER_SECRETS_KEY` est absente
(gestion CRUD désactivée — cf. « Configuration des providers »). Toute écriture ré-arme les
timers de synchro à chaud (`rearmTimers`), sans redémarrage.

### Partagé (`src-shared/VmSync.ts`)

**Source de vérité de la frontière source/locaux** : `VM_SOURCE_FIELDS` (les 14
champs que la synchro a le droit d'écraser) + normalisation canonique
(`normalizeSource`, `normalizeNic`). Le modèle client `Vm` ET le diff serveur
délèguent ici — une dérive de sémantique entre les deux côtés est impossible
par construction. Un test d'invariant vérifie la liste contre le modèle.

### Client

| Fichier | Rôle |
|---|---|
| `models/Vm.ts` | Entité `vms` (source/locaux commentés, vNIC **embarquées** `nics[]` — jamais des `ports` : incâblables par construction). |
| `core/VmNetMapping.ts` | Mapping MANUEL `bridge/vlan_tag → réseau logique`, persisté dans `store.meta.vmNetMappings` (résolution EXACTE : tag 42 ≠ sans-tag ; « non raccordé » sinon). La synchro n'y écrit jamais. |
| `core/VmIpMatch.ts` | Rapprochement IP assisté (PUR) : propose les `ipAddresses` EXISTANTES dont l'adresse correspond à une IP constatée d'une vNIC (normalisation trim/CIDR, correspondance EXACTE, « première vNIC gagne »), avec le CONFLIT d'exclusivité éventuel (`equipment`/`other_vm`). Aucune création, aucun rattachement — la fiche VM propose, l'utilisateur clique. |
| `views/forms/VmForms.ts` | Modale « Réseaux virtuels », formulaire d'édition (champs LOCAUX uniquement), lancement de synchro + modale de résultat (le statut vit dans le sous-onglet Clusters). |
| `views/forms/VmProvidersForm.ts` | Modale « Providers… » (en-tête du sous-onglet Clusters, mode API, non-viewer) : liste + formulaire création/édition (éditeur de POOL ordonné url+empreinte, jeton en ÉCRITURE SEULE « inchangé si vide », include_lxc/intervalle/timeout), « Tester la connexion », « Enregistrer », « Supprimer ». Clé absente/config invalide (503) → bandeau au lieu des contrôles ; rafraîchit la vue Clusters après écriture. |
| `views/forms/VmSyncClient.ts` | Accès aux endpoints vm (contexte REST minimal injecté) : synchro/statut + CRUD/test des providers ; DTOs miroirs du serveur (dupliqués, assumés/commentés). Le jeton ne part qu'à l'envoi (écriture seule). |
| `views/VmClustersView.ts` | Sous-onglet « Clusters » (mode API) : cartes par provider — version/gamme, quorum, état de synchro, table des nœuds (métriques, équipement rapproché, VMs par nœud) ; en-tête : « Providers… » (gestion) + « Actualiser » (l'état cluster est en mémoire serveur, sans push SSE). |
| `core/VmClusterFormat.ts` | Helpers PURS de la vue Clusters : rapprochement nœud→équipement — **MIROIR EXACT de la hiérarchie v3** du serveur (`VmSyncService`), à synchroniser des deux côtés : ① hostnames des IP rattachées (complet ou 1er label, casse/trim), ② nom exact insensible à la casse, ③ 1er label FQDN du nom ; à chaque niveau unique→résolu, plusieurs→null (sans descendre), zéro→suivant. Reçoit les `ipAddresses` en plus des équipements. Formatage uptime/CPU/Go. |
| Branchements fins | `EntityRegistry` (collection), `ListConfigs.vms` + `addListTab` (onglet), `DetailForms.detail` (case `vms`), `IpamForms`/`shared.ts` (sélecteur VM des adresses), `Store.ipAddressesOfVm`, `INDEX_SPEC`, `RenderImpact: "none"`. |

## Frontière SOURCE / LOCAUX

- **SOURCE** (écrasés à chaque synchro) : `ext_id`, `provider_id`, `vm_type`,
  `name`, `description_src`, `status`, `host_node`, `cpu`, `ram_mb`, `disk_gb`,
  `tags_src`, `nics`, `orphan`, `last_sync`.
- **LOCAUX** (jamais touchés) : `notes`, `description` (héritée d'Entity),
  `group_id`/`group_ids`, `host_equipment_id`.
- **Champ dérivé** (décision 2026-07-13, rapprochement v3 2026-07-14) :
  `host_equipment_id` est re-résolu à **chaque** synchro depuis `host_node` par
  une **hiérarchie à 3 niveaux**, évaluée dans l'ordre. À CHAQUE niveau : un
  candidat UNIQUE → résolu ; **plusieurs → ambigu → null** (on ne devine pas, et
  on **ne descend pas** au niveau suivant) ; zéro → niveau suivant.
  1. **PRIORITAIRE — hostnames des adresses IP rattachées aux équipements.** Les
     équipements possédant une `ipAddress` (champ `equipment_id` posé) dont le
     `hostname` correspond au nom du nœud : hostname **complet** égal, OU
     **premier label** du hostname égal (« srv37.int.exemple.com » → « srv37 »),
     insensible à la casse et trimé. TOUTES les IP d'un équipement comptent
     (plusieurs IP du **même** équipement = **un** candidat, dédup par équipement).
     C'est le canal voulu : l'utilisateur encode le FQDN dans le hostname des IP.
  2. **Nom d'équipement EXACT** — insensible à la casse et trimé (« SRV37 » ↔
     nœud « srv37 »).
  3. **Premier label du FQDN du nom d'équipement** (« srv1.int.exemple.com » →
     « srv1 ») — les équipements sont parfois nommés en FQDN, les nœuds Proxmox
     portent un nom court.

  *Exemple srv37* : un équipement au nom court « srv37 » (ou « SRV37 ») est
  apparié au niveau 2 ; s'il porte plutôt le FQDN sur l'une de ses adresses IP
  (`hostname` = « srv37.int.exemple.com »), il l'est dès le niveau 1. Une VM
  migrée suit son nœud, un nœud sans équipement correspondant donne null (rien
  n'est deviné). Le niveau retenu est journalisé (`info`) par nœud. Non éditable —
  la synchro est la source de vérité de l'hôte.
- **Anti-rafale** : un délai minimal (10 s) sépare deux passes d'un même couple
  document×provider — deux « Synchroniser » quasi simultanés (multi-clients)
  ne déclenchent qu'une passe, la seconde reçoit le dernier statut annoté.
- Une VM **disparue** de l'inventaire passe `orphan: true` (badge « orpheline »)
  — jamais supprimée automatiquement : la purge est un geste utilisateur, DEPUIS
  LA FICHE détail (bouton « Supprimer cette VM orpheline… », `DetailForms.vmDetail`).
  Le bouton est **réservé aux orphelines** : supprimer une VM encore présente au
  cluster serait vain (recréée à la synchro suivante) et destructeur (perte des
  enrichissements locaux) — l'UI l'interdit donc. La suppression emprunte le MÊME
  chemin que les listes (`store.remove` → cascade partagée) : les adresses IP
  rattachées sont **détachées** (`ipAddresses.vm_id → null`), pas supprimées.
- `last_sync` = dernière synchro ayant **modifié** la VM (pas le dernier
  passage) — c'est ce qui garantit l'idempotence ; l'horodatage du dernier
  passage vit dans le statut (`GET /vm/status`).
- **IPAM informatif** (décision de cadrage n°4) : les IPs des vNIC (`nics[].ips`)
  sont des données SOURCE affichées telles quelles ; la synchro ne crée JAMAIS
  d'entrée IPAM. La fiche VM (`DetailForms.vmDetail`) offre en plus un
  **rapprochement assisté** : elle PROPOSE de rattacher les `ipAddresses`
  **existantes** dont l'adresse correspond à une IP constatée (logique pure
  `core/VmIpMatch.ts`) — jamais de création, jamais de rattachement automatique.
  L'utilisateur clique « Rattacher » ; si l'adresse est déjà prise (équipement ou
  autre VM), un dialogue confirme la **bascule** (l'exclusivité `equipment_id`/`vm_id`
  vide l'affectation précédente). Réservé au mode non-visualiseur.

## VMs dans la vue graphe (Netmap)

La vue graphe (`views/GraphView.ts`) offre un **overlay opt-in** « VMs » qui matérialise
les machines virtuelles et leurs réseaux logiques comme nœuds, en plus du câblage
physique. Le toggle est **désactivé par défaut** — sans lui, le graphe est
STRICTEMENT inchangé (nœuds = équipements câblables, arêtes = câbles résolus). C'est
une **préférence d'affichage personnelle** (par navigateur et par fichier, comme les
toggles de la vue Datacenter), persistée dans `localStorage`
(`dcmanager.graphview.<fileId>`), **jamais dans le document**.

Quand l'overlay est actif :

- **Nœuds `vm:<id>`** — un par VM du document (préfixe obligatoire pour ne jamais
  entrer en collision avec un id d'équipement : positions/sélection/dispositions
  nommées sont indexées par id de nœud). Une VM **orpheline** est atténuée ; une VM
  dont aucune vNIC n'est mappée reste **isolée** (assumé).
- **Nœuds `net:<network_id>` matérialisés À LA DEMANDE** — un par réseau logique
  référencé par **au moins une vNIC affichée**, PAS tous les réseaux du document.
  Rendu en cartouche coloré (`networks.color`).
- **Arêtes VM→réseau** — le **mapping** `VmNetMapping` (bridge/VLAN → réseau, cf.
  `core/VmNetMapping.ts`) est la SOURCE des liens : pour chaque vNIC,
  `resolve(bridge, vlan_tag)` donne le réseau (ou rien → aucune arête). L'arête porte
  le `network_id`, donc elle colore le tracé et **alimente la légende** exactement
  comme les arêtes de câbles.

Le filtre « Réseaux » de la barre d'outils s'applique aux nœuds `net:` et aux arêtes
VM→réseau (un réseau exclu les masque/retire) ; il **n'affecte jamais** les nœuds VM.
Le double-clic ouvre la fiche (VM → `DetailForms.vmDetail` ; réseau →
`DetailForms.networkDetail`) et le menu contextuel est restreint à « Détails » — jamais
d'action d'équipement (suppression, etc.) sur un nœud vm/net.

## Configuration des providers (par document)

La configuration est **par document** (chaque document = une infrastructure) et
vit **côté serveur** — jamais dans le document (répliqué aux clients), pour que
les jetons ne quittent pas le serveur. Elle se fait par l'**UI** (modale
« Providers… » du sous-onglet Clusters) ; le stockage de référence est la base
chiffrée `vm-providers.db`. Le fichier `vm-providers.json` d'origine devient un
format **legacy** (lu sans clé, migré automatiquement quand la clé est présente).

> **État (fait — décidé 2026-07-13, livré 2026-07-14)** : la config est passée du
> fichier JSON transitoire v1 à une **DB à colonnes typées** avec jetons chiffrés
> au repos et édition par l'UI. *Historique* : `vm-providers.json` était le
> transitoire v1 (pas d'UI, modification → redémarrage) ; l'API `providersFor(docId)`
> ayant toujours isolé le reste du module du support de stockage, seul le backend
> de config a changé (ajout de `ProviderConfigDb`/`SecretBox`, extraction de
> `ProviderConfigValidate`), en cohérence avec la direction relationnelle de
> [`persistance.md`](persistance.md).

### Stockage de référence : `vm-providers.db` (chiffré)

Base SQLite **dédiée au module** (`vm-providers.db`, à côté de `registry.db` dans
`DOCS_DIR`), POSSÉDÉE par `vm/` — jamais une table de `registry.db` (le cœur ne
connaît rien de la feature ; supprimer la feature = supprimer le module + ce
fichier). Colonnes **typées** (décision 2026-07-14 : jamais de secret en JSON
plaintext, cf. persistance.md) :

- `vm_providers` : `doc_id`, `id`, `kind`, `token_enc` (jeton **chiffré**),
  `include_lxc`, `interval_sec`, `timeout_sec`, `ca_pem` (CA du cluster au format
  PEM — **PUBLIC**, pas un secret ; NULL = pas de CA cluster ; niveau 2 de la
  hiérarchie de confiance), `created_date`/`updated_date`, **`created_by`/`updated_by`**
  (id canonique de l'auteur — audit posé SERVEUR, migration `ALTER` idempotente ; cf.
  [`user-resolver.md`](user-resolver.md)). PK `(doc_id, id)`.
- `vm_provider_endpoints` : le **POOL est un 1-N ORDONNÉ** — `doc_id`,
  `provider_id`, `position` (= priorité de bascule), `url`, `fingerprint`
  (empreinte PAR nœud, NULL = CA système). FK `ON DELETE CASCADE` (supprimer un
  provider purge ses endpoints ; `PRAGMA foreign_keys = ON` à chaque connexion).

Le **jeton n'est jamais en clair ni jamais renvoyé** par l'API : la liste et
l'enregistrement renvoient au plus `has_token: true` ; un jeton n'est déchiffré
que côté serveur, en mémoire, pour une synchro ou un test de connexion. Le
`ca_pem`, lui, est un certificat **PUBLIC** (pas un secret) : il est renvoyé tel
quel par la liste et l'enregistrement (aucune réserve, contrairement au jeton).

### Chiffrement des jetons — `DCMANAGER_SECRETS_KEY` (SecretBox serveur partagé)

- Le coffre vit désormais **hors de `vm/`** (`src-server/src/SecretBox.ts`) :
  c'est le coffre à secrets serveur **PARTAGÉ** de l'application (généralisation
  de l'ex-`VmSecretBox`, décision 2026-07-14 — réutilisé par le module
  `notify/` pour les jetons de webhooks). Une **clé UNIQUE** pour tous les
  modules : `DCMANAGER_SECRETS_KEY`.
- **Compatibilité** : l'ancienne `VM_PROVIDERS_KEY` est lue **en repli** si la
  nouvelle est absente (même dérivation → les jetons déjà stockés restent
  déchiffrables sans intervention), avec un avertissement au démarrage invitant
  à renommer la variable (même valeur). Si les deux sont définies, la générique
  gagne.
- **AES-256-GCM** (chiffrement *authentifié* : toute altération du stocké est
  détectée au déchiffrement), clé = **SHA-256 de la passphrase d'environnement**
  (dérivation qui normalise une passphrase libre en 32
  octets — un KDF lent type scrypt serait du théâtre : c'est un secret
  d'infrastructure long, pas un mot de passe humain à force-brute), IV aléatoire
  de 12 octets par chiffrement, format stocké versionné `v1:<iv>:<tag>:<ct>`
  (base64, le préfixe autorise une rotation d'algorithme future).
- **Limites ASSUMÉES** : la clé vit dans l'environnement du serveur — le
  chiffrement protège les **copies** de la base (backups, exfiltration du
  fichier), PAS un attaquant qui contrôle l'hôte. Ni la passphrase, ni la clé, ni
  un jeton (clair ou chiffré) n'apparaissent dans un log ou une erreur.
- **Clé perdue = jetons à ressaisir** (aucune récupération — c'est le but).

### Clé absente / config invalide (503)

- Clé **absente** : la gestion CRUD est désactivée — les routes `providers`
  répondent **503** explicite (« définir `DCMANAGER_SECRETS_KEY`… ») et l'UI affiche un
  bandeau actionnable au lieu des contrôles d'édition. Le fichier legacy (ci-après)
  continue de fonctionner SEUL en lecture : les déploiements sans clé gardent le
  comportement historique (synchro/statut, sans gestion des providers).
- Clé absente **mais** `vm-providers.db` présente : module « en erreur » explicite
  (des jetons chiffrés existent sans clé pour les lire — l'opérateur doit fournir
  la clé). Pas de silence.
- Config invalide (fichier legacy illisible, DB en erreur) : module « en erreur »,
  routes en **503** avec le détail — visibilité opérateur sans faire tomber le reste.

### Dépannage — clé `DCMANAGER_SECRETS_KEY` CHANGÉE (jetons stockés indéchiffrables)

**Symptôme** (incident réel) : la vue **Clusters** n'affiche plus aucun cluster
et le bouton **« Tester »** d'un provider échoue — alors que la clé est bien
définie et la liste des providers reste affichée. Les logs serveur montrent :

```
ERROR [vm] POST /vm/providers/test : construction en échec <docId>
  SecretBox : déchiffrement refusé (clé DCMANAGER_SECRETS_KEY différente ou
  donnée altérée) — le secret doit être ressaisi
```

**Cause** : la valeur de `DCMANAGER_SECRETS_KEY` (ou de son repli
`VM_PROVIDERS_KEY`) a **changé** depuis l'enregistrement du jeton. Le jeton est
chiffré AU REPOS avec une clé dérivée de la passphrase (cf. « Chiffrement des
jetons ») : une passphrase différente ne peut PAS le déchiffrer (AES-256-GCM
authentifié — c'est le but : clé perdue = secret irrécupérable). Ce n'est PAS le
cas « clé absente » (§ 503) : ici la clé EST présente, mais ce n'est pas la bonne.
Le module fonctionne, la liste des providers s'affiche (elle ne déchiffre aucun
jeton), mais toute opération qui a besoin du jeton en clair (synchro, test) échoue.

**Comportement UI (désormais explicite — plus de silence)** :

- **Vue Clusters** : le provider concerné, jusqu'ici EXCLU de la liste des statuts
  (car `providersFor` écarte tout jeton indéchiffrable), est **réinjecté** comme
  une carte **« Provider en erreur »** (bandeau rouge) portant le message
  ci-dessus — au lieu d'une liste vide silencieuse.
- **Bouton « Tester »** : affiche le message SecretBox actionnable dans la zone
  d'erreur du formulaire (réponse **422**, corps `{ error }`) — plus de « test
  impossible » générique.
- **Bouton « Synchroniser »** : le résultat inclut aussi ces providers en erreur.

**Solution** : ré-ouvrir le provider (**Providers…** → *Modifier*), **ressaisir
le jeton** dans le champ « Jeton d'API » puis **Enregistrer**. Le jeton est
re-chiffré avec la clé COURANTE et redevient déchiffrable. (Alternative : restaurer
l'ANCIENNE valeur de `DCMANAGER_SECRETS_KEY` dans l'environnement du serveur, si
elle est connue.) Aucune donnée du document n'est perdue entre-temps : les VMs déjà
synchronisées restent en place, la synchro reprend une fois le jeton ressaisi.

### Fichier `vm-providers.json` — format **LEGACY** (migré automatiquement)

Le fichier `vm-providers.json` (à côté de la base) reste pris en charge pour
compatibilité, en LECTURE SEULE :

- **sans clé** : encore LU tel quel (pas de CRUD) — comportement v1 inchangé ;
- **dès que `DCMANAGER_SECRETS_KEY` (ou son repli legacy) est présente** : MIGRÉ automatiquement au démarrage
  (chaque jeton chiffré au passage) puis fichier RENOMMÉ
  `vm-providers.json.imported-<AAAA-MM-JJ>` (trace, plus jamais relu) — la DB
  devient l'unique source. Idempotent (au 2ᵉ démarrage le fichier est déjà
  renommé). Un document déjà présent en DB n'est pas ré-importé (on n'écrase pas
  un jeton ressaisi via l'UI par une vieille valeur du fichier).

Structure du fichier legacy (référence historique — l'édition passe par l'UI ;
cf. [`vm-providers.sample.json`](vm-providers.sample.json)) :

```json
{
  "<docId>": {
    "docName": "libellé libre (ignoré — lisibilité du fichier)",
    "providers": [
      {
        "id": "pve-prod",
        "kind": "proxmox",
        "urls": [
          { "url": "https://pve1.example.lan:8006", "fingerprint": "AA:BB:…(SHA-256 du nœud 1)" },
          { "url": "https://pve2.example.lan:8006", "fingerprint": "CC:DD:…(SHA-256 du nœud 2)" },
          "https://pve3.example.lan:8006"
        ],
        "token": "sync@pve!inventaire=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "include_lxc": true,
        "interval_sec": 0,
        "timeout_sec": 15
      }
    ]
  }
}
```

### Champs d'un provider (UI et fichier legacy — mêmes règles, validation partagée)

La validation est la MÊME des deux côtés (`ProviderConfigValidate`) — messages
d'erreur identiques par l'UI (400 affichée telle quelle) et au chargement du fichier.

- `id` : unique par document ; **immuable en édition** (clé de réconciliation des
  VMs — `ext_id` = `nomDuCluster/vmid`, repli : nom du nœud isolé puis id du provider).
- `kind` : `proxmox` (seul type supporté par `VmSyncService.adapterFor`).
- **Pool de nœuds** (`urls` dans le fichier ; éditeur ordonné dans l'UI) — palier à
  la défaillance d'un nœud : l'API Proxmox répond sur chaque nœud, les endpoints
  sont essayés dans l'ORDRE et le pool **bascule** quand un nœud est injoignable
  (réseau, DNS, délai, TLS). La bascule ne s'applique JAMAIS à une erreur
  applicative (authentification, statut HTTP) — elle échouerait à l'identique
  partout. Préférence collante : le dernier nœud ayant répondu est réessayé en
  premier, un nœud mort ne coûte donc son délai qu'une fois par passe (cf.
  `PveHttpPool.ts`). *Fichier legacy* : entrée = objet `{ url, fingerprint? }` ou
  chaîne (raccourci sans épinglage) ; raccourci mono-nœud `url` (+ `fingerprint`)
  exclusif de `urls`. *UI* : n'émet que la forme pool (`urls`, empreinte par nœud).
- **Confiance TLS — HIÉRARCHIE à 3 niveaux, décidée PAR ENDPOINT** (cf.
  `PveHttp.trustOptions`, du plus spécifique au plus général) :
  1. `fingerprint` de l'endpoint présent → **ÉPINGLAGE** : empreinte SHA-256 du
     certificat à épingler, **PAR NŒUD** (chaque nœud Proxmox porte SON propre
     certificat — l'UI Proxmox l'affiche). Le plus spécifique, **prioritaire** ;
     recommandé avec les certificats auto-signés.
  2. sinon `ca_pem` du provider présent → validation TLS par **CETTE CA de
     cluster** (`rejectUnauthorized: true` + option `ca`). ⚠ Le nom d'hôte de l'URL
     doit alors correspondre au CN/SAN du certificat du nœud (sinon
     `ERR_TLS_CERT_ALTNAME_INVALID`, expliqué par `explainNetworkError`).
  3. sinon → validation par les **CA système** (comportement historique).
- `ca_pem` : certificat **CA du cluster** (`pve-root-ca.pem`), au format PEM. La CA
  du cluster émet le certificat de CHAQUE nœud : lui faire confiance = **UNE seule
  valeur pour tout le pool**, qui SURVIT aux régénérations de certificats
  (`pvecm updatecerts`) — alternative plus robuste que l'épinglage par nœud. Où le
  trouver : fichier `/etc/pve/pve-root-ca.pem` sur un nœud, ou UI Proxmox
  (*Datacenter → … → Certificats*). **PUBLIC** (pas un secret) : il transite sans
  réserve et est renvoyé en lecture. Combinable avec des empreintes par endpoint
  (le pin prime par nœud, la CA sert de repli). Absent = validation CA système.
- `token` : jeton d'API Proxmox — le rôle lecture seule **PVEAuditor** suffit ;
  les jetons Proxmox sont cluster-wide : un seul jeton pour tout le pool. Dans
  l'UI, il est en **écriture seule** (champ password jamais pré-rempli ; vide en
  édition = jeton conservé). Chiffré au repos dès l'enregistrement.
  ⚠ **Séparation de privilèges** : par défaut (`privsep=1`), un jeton n'hérite
  PAS des permissions de son utilisateur — l'API filtre alors les résultats et
  `/cluster/resources` renvoie une liste **vide sans erreur** (« synchro OK,
  0 VM »). Donner le rôle AU JETON lui-même :
  `pveum acl modify / --tokens 'sync@pve!inventaire' --roles PVEAuditor --propagate 1`
  (UI Proxmox : *Datacenter → Permissions → Add → API Token Permission*, chemin `/`,
  propagation cochée) — ou créer le jeton avec `--privsep 0` pour qu'il hérite de
  l'utilisateur. Le statut de synchro signale explicitement ce cas.
- `include_lxc` : défaut `true` (décision de cadrage : conteneurs inclus).
- `interval_sec` : période de synchro automatique (entier ≥ 0) ; `0` = manuelle.
- `timeout_sec` : délai maximal d'UNE requête HTTP, en secondes (entier ≥ 1,
  défaut 15) — borne aussi le coût d'une bascule sur nœud mort.

### Déploiement

Ajouter **`DCMANAGER_SECRETS_KEY`** (une passphrase LONGUE) à l'environnement du
serveur pour activer la gestion des providers par l'UI et le chiffrement des
secrets au repos (clé UNIQUE partagée par tous les modules à secrets — VM,
notifications). Les déploiements historiques qui n'ont que `VM_PROVIDERS_KEY`
continuent de fonctionner (repli, même dérivation) — renommer la variable à
l'occasion (même valeur). Sans aucune clé : seule la lecture du fichier legacy
fonctionne (pas de CRUD). **Clé perdue = jetons à ressaisir** (aucune
récupération possible).

## Gamme Proxmox supportée

Déclarée dans `ProxmoxAdapter` : **PVE 8 à 9**. `test()` lit `GET /version` ;
hors gamme → **avertissement, pas de blocage** (l'inventaire est tenté quand
même — les endpoints utilisés sont stables depuis PVE 7). Le parsing est
tolérant par principe ; si une release future casse l'API, l'évolution reste
confinée à l'adaptateur (le reste de l'application ne connaît que `VmRecord`).

## Suppression de la feature (script d'amovibilité, vérifié T4.1)

1. **Serveur** : supprimer `src-server/src/vm/` (y compris
   `ProviderConfigValidate.ts`, `ProviderConfigDb.ts` — `SecretBox.ts` vit hors
   du module et RESTE : il sert aux autres features à secrets) + les lignes `VmModule` de
   `index.ts` — dont le passage du constructeur SQLite injecté (le point
   d'extension `ApiExtension` d'`api.ts` est générique, il reste). Supprimer les
   fichiers de config s'ils existent : `vm-providers.db` et un éventuel
   `vm-providers.json`(`.imported-*`).
2. **Client** : supprimer `models/Vm.ts`, `core/VmNetMapping.ts`,
   `views/forms/VmForms.ts`, `views/forms/VmProvidersForm.ts`,
   `views/forms/VmSyncClient.ts` ; retirer les
   branchements fins : entrée `vms` d'`EntityRegistry`, `ListConfigs.vms` +
   l'onglet dans `main.ts`, le `case "vms"` de `DetailForms`, le sélecteur VM
   d'`IpamForms`/`FormUi.vmOptions`, `Store.ipAddressesOfVm`, `INDEX_SPEC.vms`
   (+ `vm_id` d'`ipAddresses`), l'entrée `RenderImpact`.
3. **Partagé** : retirer `"vms"` de `Schema.COLLECTIONS`, la spec `vms` (+ champ
   `vm_id` et invariant d'exclusivité d'`ipAddresses`) de `DataValidation.ts`,
   les entrées `vms` de `Cascade.ts`, supprimer `VmSync.ts`.
4. **Modèle** : champ `vm_id` d'`IpAddress.ts` ; clé `vmNetMappings` de la méta
   (inerte si laissée). Les tests correspondants tombent avec leurs modules.

Aucun autre module ne dépend de la feature — vérifié par revue d'imports
(le cœur serveur n'importe jamais `vm/` ; côté client, tout vit dans les
fichiers dédiés ci-dessus).

## Ajouter un provider (VMware, Hyper-V…)

1. Implémenter `VmProviderAdapter` (nouveau sous-dossier ou fichier dans `vm/`) :
   produire des `VmRecord` normalisés — c'est le SEUL contrat que voient la
   réconciliation et l'UI. Réutiliser le découpage Proxmox : client HTTP dédié,
   parsing PUR séparé (testable par fixtures), adaptateur d'orchestration.
2. Déclarer le `kind` dans `VmSyncService.adapterFor` (fabrique par famille).
3. Étendre `ProviderConfigValidate` si la config exige d'autres champs (la
   validation partagée par le fichier legacy ET le CRUD DB ; les clés inconnues
   sont déjà tolérées).
4. `ext_id` : choisir une identité STABLE côté provider (équivalent de
   `cluster/vmid`) — c'est la clé de réconciliation.
