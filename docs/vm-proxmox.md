# Inventaire VM (Proxmox) — équipements virtuels synchronisés

Feature **AMOVIBLE** : inventaire des machines virtuelles (QEMU) et conteneurs (LXC)
d'un ou plusieurs clusters Proxmox, répliqué dans le document sous la collection
`vms` par une synchronisation côté serveur. Exigences fondatrices : **découplage
maximal** (supprimable sans cicatrice), **résilience aux releases Proxmox**,
providers configurés **par document** (chaque document = une infrastructure,
multi-clusters possibles).

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
   nœuds/métriques/quorum/version — cf. vue « Clusters ») ;
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
| `PveHttp.ts` | Client HTTPS d'UN nœud : jeton d'API (`PVEAPIToken=…`) et **hiérarchie de confiance TLS** par endpoint (`trustOptions`, statique pure : épinglage d'empreinte SHA-256 > CA du cluster `ca_pem` > CA système) — jamais « accepter tout ». Erreurs TYPÉES (`PveHttpError.retryable` : joignabilité vs applicatif). Le jeton n'apparaît jamais dans une erreur/un log. **Réponse BORNÉE** : au-delà de `MAX_RESPONSE_BYTES` (32 Mio) la requête est avortée (erreur non-retryable — données cluster-wide, basculer ne servirait à rien) pour qu'un endpoint détraqué ne gonfle pas la mémoire du serveur. **Agent HTTPS injectable** (dernier paramètre, optionnel) : sans injection, une socket **dédiée par requête** ; avec l'agent keep-alive du pool, les connexions sont réutilisées (cf. `PveHttpPool.ts`). |
| `PveHttpPool.ts` | **Pool de nœuds** avec bascule sur défaillance de joignabilité (jamais sur une erreur applicative) et préférence collante (le nœud mort ne coûte son délai qu'une fois par passe). **Agent keep-alive PARTAGÉ à la durée d'UNE passe** (`fromConfig` l'ouvre, `dispose()` le détruit en fin d'inventaire) : les **handshakes TLS sont AMORTIS** sur les ~N appels de détail d'une passe. Sans lui, `agent: false` repaierait TCP + un handshake TLS complet par requête — ~50 ms de pur handshake par appel sur un gros cluster. Sûr entre endpoints aux confiances TLS différentes : l'agent réutilise les sockets **par origine** (host:port), chacune validée à SON handshake ; deux nœuds = deux origines distinctes. Le N+1 séquentiel lui-même **reste** (assumé, volumes faibles). |
| `ProxmoxParse.ts` | Décodage PUR des réponses JSON (chaînes `netN` QEMU/LXC, `/cluster/resources` → VMs ET nœuds, `/cluster/status` → nom + quorate, config, guest-agent). TOLÉRANT : clé inconnue ignorée, valeur manquante → null, jamais de throw. |
| `ProxmoxAdapter.ts` | Orchestration des appels (`/cluster/status` → nom + quorate, `/cluster/resources` SANS filtre → VMs + nœuds, `/version` → version + gamme, configs, agent pour les QEMU allumées). HTTP **injecté** (`PveJsonClient`) → testable par stub. Échec d'une config individuelle ou d'une métadonnée cluster SECONDAIRE (quorum/version) toléré ; **deux** échecs rejettent : l'inventaire de masse, et le **nom du cluster** — socle d'identité des `ext_id`, jamais une métadonnée (`requireClusterName` : non résolu ⇒ passe avortée, aucune écriture, cf. « Dépannage — VMs en DOUBLE »). Les segments issus du cluster distant (nom de nœud, `vmid`) sont **encodés** (`encodeURIComponent`) avant d'entrer dans un chemin d'URL. |
| `ProviderConfigValidate.ts` | Validation PURE d'UN provider (id/kind/token requis, pool d'urls https + empreintes par nœud + doublons, include_lxc/interval_sec/timeout_sec avec défauts) — utilisée par le CRUD DB (messages d'erreur uniques, zéro duplication). Le token n'apparaît jamais dans un message. |
| `../SecretBox.ts` | Coffre de chiffrement des secrets AU REPOS — module serveur **PARTAGÉ** (hors de `vm/`, réutilisé par `notify/`) : AES-256-GCM (authentifié), clé = SHA-256 de la passphrase d'env `DCMANAGER_SECRETS_KEY` (**clé UNIQUE, sans repli**), IV aléatoire 12 o, format versionné `v1:<iv>:<tag>:<ct>` (base64). Aucun secret (passphrase/clé/jeton) dans un log ou une erreur. Limites assumées + clé perdue = jetons à ressaisir (cf. « Configuration »). |
| `ProviderConfigDb.ts` | Stockage DB chiffré (`vm-providers.db`, tables typées `vm_providers` + `vm_provider_endpoints` ordonnées, jetons `token_enc`) — **UNIQUE source de config**. Deux surfaces : LECTURE synchro (`providersFor`/`configuredDocIds`) ET CRUD sans fuite de jeton (`listFor`/`save`/`remove`/`buildForTest` — `has_token` seul, jamais le jeton). Driver SQLite injecté. |
| `VmReconcile.ts` | Moteur de réconciliation PUR (clé `ext_id`, périmètre = une instance de provider). Frontière source/locaux, orphelines jamais supprimées, patchs minimaux. Dépendances injectées (résolution d'hôte, id, horloge). |
| `VmSyncService.ts` | Exécution d'une synchro + statut mémoire par doc×provider + timers périodiques (`interval_sec`, anti-chevauchement, `unref`). Sans Express (bus live vu par interface) → testé de bout en bout. `rearmTimers()` relit la config à chaud après une écriture CRUD. **Producteur `vm-sync-failure`** : sur une VRAIE passe (hors sorties anticipées « déjà en cours »/anti-rafale), un échec `raise` et un succès `resolve` un problème persistant AUPRÈS DU MODULE NOTIFICATIONS, via l'interface OPTIONNELLE `ProblemReporter` injectée au bootstrap (typage structurel — `vm/` n'importe rien de `notify/`). Clé stable `vm-sync:<docId>:<providerId>` ; AUCUN comptage/anti-spam ici (rappels et déduplication côté notify — cf. [`docs/notifications.md`](notifications.md)). |
| `VmModule.ts` | Façade : routes REST (sync/status + CRUD/test des providers) + assemblage. Le stockage est la DB chiffrée `vm-providers.db`, conditionnée à `DCMANAGER_SECRETS_KEY` : clé présente → feature ACTIVE ; clé absente → module « clé manquante », **TOUTES** les routes en **503** actionnable (« définir DCMANAGER_SECRETS_KEY… »). Config invalide → module « en erreur » (503 détaillé) sans faire tomber le serveur ; ré-arme les timers après chaque écriture. |

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

**TOUTES** ces routes (synchro/statut ET CRUD/test) répondent **503** actionnable si
`DCMANAGER_SECRETS_KEY` est absente (feature entièrement désactivée — cf. « Configuration des
providers ») : la clé est REQUISE pour toute la feature. Toute écriture ré-arme les timers de
synchro à chaud (`rearmTimers`), sans redémarrage.

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
| `core/VmPurge.ts` | Règle PURE de la **purge de masse** (lecteurs injectés) : construction des GROUPES proposables (orphelines par provider configuré / VMs figées d'un provider disparu / fusion en mode fichier), critère « **enrichie** » par FAMILLE, résolution de la sélection et comptes du récapitulatif dérivés du PLAN de cascade. Voir « Purge de masse des orphelines » plus bas. |
| `views/forms/VmPurgeForm.ts` | Modale « **Purger des VMs…** » (les DEUX modes, non-viewer) : groupes cochables + compteurs, enrichies listées NOMINATIVEMENT et décochées, case d'inclusion, récapitulatif exact, bouton DANGER + confirmation. N'arbitre rien (règle dans `core/VmPurge`, suppression par `Store.removeMany`). |
| `views/forms/VmSyncClient.ts` | Accès aux endpoints vm (contexte REST minimal injecté) : synchro/statut + CRUD/test des providers ; DTOs miroirs du serveur (dupliqués, assumés/commentés). Le jeton ne part qu'à l'envoi (écriture seule). |
| `views/VmClustersView.ts` | Sous-onglet « Clusters » (mode API) : cartes par provider — version/gamme, quorum, état de synchro, table des nœuds (métriques, équipement rapproché, VMs par nœud) ; en-tête : « Providers… » (gestion) + « Actualiser » (l'état cluster est en mémoire serveur, sans push SSE). Chaque carte porte aussi le raccourci « **Purger…** » (non-viewer, s'il existe une orpheline de CE provider) qui ouvre la purge de masse pré-sélectionnée. |
| `core/VmStatus.ts` | **SOURCE UNIQUE** de l'état affiché d'une VM (PUR) : classification fermée du statut source (`running`/`stopped`/`other`/`none`), priorité de l'**orphelinat** sur le statut, couleurs sémantiques, clé de tri et **pastilles HTML échappées**. `ListConfigs.vms`, `DetailForms.vmDetail` et `VmHostTip` la CONSOMMENT, aucun ne la réécrit. Statut affiché TEL QUEL et jamais traduit (tolérance aux releases Proxmox) ; seul le mot « orpheline » est localisé (`lists.ph.orphan`). Le statut est **rogné** avant classification. |
| `core/VmHostTip.ts` | Bloc « VMs hébergées » de la **bulle de survol d'un équipement** en vue Datacenter (PUR : ni DOM, ni store). Reçoit les VMs de l'hôte, rend des LIGNES HTML **déjà échappées** — tri par nom, bornage `MAX_LISTED` ; la pastille de statut est **déléguée à `VmStatus`**. Cf. « VMs dans la bulle d'un équipement » plus bas. |
| `core/VmLocate.ts` | « Localiser en 3D » une VM = localiser son **HÔTE** (PUR : store injecté par interface étroite). Rend l'**id de l'équipement à viser**, ou `null` si la localisation ne peut pas aboutir. Cf. « Localiser une VM » plus bas. |
| `core/VmClusterFormat.ts` | Helpers PURS de la vue Clusters : rapprochement nœud→équipement — **MIROIR EXACT de la hiérarchie v3** du serveur (`VmSyncService`), à synchroniser des deux côtés : ① hostnames des IP rattachées (complet ou 1er label, casse/trim), ② nom exact insensible à la casse, ③ 1er label FQDN du nom ; à chaque niveau unique→résolu, plusieurs→null (sans descendre), zéro→suivant. Reçoit les `ipAddresses` en plus des équipements. Formatage uptime/CPU/Go. |
| Branchements fins | `EntityRegistry` (collection), `ListConfigs.vms` + `addListTab` (onglet, dont `locate`/`locateTarget`), `DetailForms.detail` (case `vms`), `IpamForms`/`shared.ts` (sélecteur VM des adresses), `Store.ipAddressesOfVm`, `Store.vmsOfHost`, `DcInteract.equipmentTipHtml` (bloc « VMs hébergées »), `INDEX_SPEC`, `RenderImpact: "none"`. |

## Frontière SOURCE / LOCAUX

- **SOURCE** (écrasés à chaque synchro) : `ext_id`, `provider_id`, `vm_type`,
  `name`, `description_src`, `status`, `host_node`, `cpu`, `ram_mb`, `disk_gb`,
  `tags_src`, `nics`, `orphan`, `last_sync`.
- **LOCAUX** (jamais touchés) : `notes`, `description` (héritée d'Entity),
  `group_id`/`group_ids`, `host_equipment_id`.
- **Champ dérivé** : `host_equipment_id` est re-résolu à **chaque** synchro depuis `host_node` par
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
  — jamais supprimée automatiquement : la purge est un geste utilisateur, à l'unité
  DEPUIS LA FICHE détail (bouton « Supprimer cette VM orpheline… », `DetailForms.vmDetail`)
  ou **en masse** (section « Purge de masse des orphelines » plus bas).
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

## Purge de masse des orphelines

Le geste unitaire de la fiche suffit pour un résidu isolé, pas pour un **accident
d'identité** : une bascule du nom de cluster (cf. « Dépannage — VMs en DOUBLE ») peut
laisser **des dizaines** d'orphelines d'un coup, et supprimer un provider **FIGE** ses
VMs — qui ne deviendront jamais orphelines, puisque plus aucune passe ne couvre leur
`provider_id`. D'où une action de masse.

**Où** : bouton « **Purger…** » dans l'en-tête de l'onglet **VMs** (les DEUX modes,
hors visualiseur), affiché **seulement s'il y a matière** ; et raccourci « Purger… »
sur chaque **carte provider** de la vue Clusters, qui pré-sélectionne les orphelines
de ce provider. La modale (`VmPurgeForm`) ne décide rien : la règle vit dans le module
PUR `core/VmPurge`, la suppression dans `Store.removeMany`.

**Deux groupes**, cochables séparément, avec compteurs :

| Groupe | Ce qu'il propose | Coché par défaut |
|---|---|---|
| **Orphelines** d'un provider **configuré** | les VMs `orphan: true` de ce `provider_id`, **elles seules** — une VM encore inventoriée serait recréée à la passe suivante | non (sauf pré-sélection par le raccourci de la carte provider) |
| VMs d'un provider **DISPARU** (`provider_id` présent dans le document, absent de la configuration serveur) | **TOUTES** ses VMs, orphelines ou non : c'est le cas « figé sans pastille », introuvable autrement | **jamais** — ce groupe ratisse large, il ne se coche que délibérément |

**Les ENRICHIES sont exclues par défaut.** Une VM porteuse d'un travail LOCAL —
`notes`, `description`, appartenance à un **groupe** (`group_id`/`group_ids`), ou au
moins une `ipAddress` **rattachée** — est listée **par son nom** sous son groupe, avec
la ou les raisons, et **décochée**. Une case « Inclure aussi les N enrichies » les
ajoute d'un geste explicite. Rien n'est recopié automatiquement : c'est à l'utilisateur
de reporter ses enrichissements sur le jumeau conservé **avant** de purger.

**Récapitulatif exact** avant confirmation : « X VMs seront supprimées, dont Y
enrichies ; Z adresses IP seront détachées ». Le compte des IP vient du **plan de
cascade réel** (`Store.cascadePreview`), jamais d'une estimation — la règle `vms` de
`src-shared/Cascade` **détache** `ipAddresses.vm_id` (l'adresse survit, « non
attribuée »), elle ne supprime rien. Bouton **danger** + confirmation finale.

**UNE transaction, UN undo.** `Store.removeMany` calcule **un seul** plan de cascade
sur toutes les racines (`Cascade.planMany`) et n'émet **qu'une** transaction : une
révision, un événement SSE, un pas d'undo — un unique « Annuler » restitue les 60 VMs
*et* réattache leurs adresses IP. Boucler sur `remove()` donnerait N révisions, N
réveils SSE et un undo en miettes ; c'est interdit, et un test le verrouille (60
racines ⇒ 1 transaction côté client, 1 révision + 1 SSE sur un `DocumentStore` réel).
En mode API, le lot part par le chemin d'écriture standard `POST /transact` (verrou
optimiste `X-Base-Rev` → 409 si un autre client a écrit entre-temps) : **aucun endpoint
serveur nouveau**, la cascade résiduelle serveur constate simplement qu'il n'y a rien à
compléter.

**Ce que la purge ne fait pas** : rien côté Proxmox ; aucune VM **vivante** d'un
provider configuré ; aucune annulation partielle (c'est un lot atomique) ; aucune
recopie d'enrichissement.

**Mode fichier** : la liste des providers configurés n'existe pas (aucun serveur). Les
deux groupes **fusionnent** en « orphelines par identifiant de provider » et la modale
le dit — on ne peut pas distinguer un provider configuré d'un provider disparu sans la
configuration, et proposer « toutes les VMs d'un provider » sur cette ignorance
ratisserait un inventaire vivant. Même repli, avec la cause affichée, si
`GET /vm/providers` échoue en mode API (503 clé absente, panne réseau).

## VMs dans la bulle d'un équipement (vue Datacenter 2D/3D)

Survoler un équipement en vue Datacenter affiche une bulle (type, marque/modèle, série,
emplacement en baie, groupes, nombre de ports). Quand cet équipement **héberge des VMs**
— c'est-à-dire quand des `vms` portent son id dans `host_equipment_id` (champ DÉRIVÉ par
la synchro, cf. « Frontière SOURCE / LOCAUX ») —, la bulle liste ces VMs **en plus**.

- **Rien à afficher = rien d'affiché.** Un équipement qui n'héberge aucune VM produit une
  bulle STRICTEMENT inchangée : ni section vide, ni « 0 VM ».
- **Un seul chemin.** `DcInteract.equipmentTipHtml` est l'UNIQUE constructeur du contenu de
  cette bulle : la vue 2D (`wireOccupant`) et la vue 3D (`DcBase.webglTipHtml`, cible
  « occ »/« eq ») l'appellent toutes les deux — la 2D et la 3D ne peuvent donc pas diverger.
- **Contenu par VM** : nom (placeholder « (VM) » si le provider n'en donne pas), puis l'état —
  mention « orpheline » d'abord si la VM a disparu du dernier inventaire, puis le **statut BRUT**
  du provider (« running », « stopped », valeur inconnue affichée telle quelle : même vocabulaire
  et même tolérance que le listing VMs et la fiche VM). Une pastille de couleur reprend la même
  sémantique : vert = en marche, gris = autre, **rouge = orpheline** (l'orphelinat prime).
- **Ordre STABLE** : tri par nom — une bulle dont l'ordre saute d'un survol à l'autre serait
  déroutante. En tête, le compte TOTAL des VMs hébergées.
- **Bornage** : au plus `VmHostTip.MAX_LISTED` (**8**) VMs sont nommées ; le reste est porté par une
  dernière ligne « … et N autres ». C'est le SEUL endroit à retoucher pour rallonger la bulle. Un
  hyperviseur peut porter des dizaines de VMs ; sans borne, la bulle couvrirait l'écran. La liste
  complète vit dans l'onglet VMs (filtre « Hôte »).
- **Coût de survol** : la bulle est reconstruite à CHAQUE mouvement de souris sur l'objet. La lecture
  passe donc par l'index secondaire `vms.host_equipment_id` (`Store.vmsOfHost`, cf. `data/config.ts`),
  soit un coût en O(VMs de CET hôte) — jamais un balayage de la collection.
- **Échappement** : nom et statut sont des données SOURCE d'un cluster tiers, et la bulle est posée en
  `innerHTML`. `VmHostTip` les échappe LUI-MÊME (`Html.escape`) et ne laisse jamais une donnée du
  provider entrer dans un attribut `style` (les couleurs sont un ensemble fermé de constantes internes).
  Verrouillé par des tests dédiés (`Tests/modules/test-core-store.js`).

## « Localiser en 3D » une VM (= localiser son HÔTE)

Une VM n'a **aucune existence** dans la scène 3D : ni position, ni conteneur de placement
(cf. [`placement.md`](placement.md)). Ce qui est localisable, c'est son **hôte** — l'équipement
physique qui l'exécute, rapproché par la synchro dans `host_equipment_id`. « Localiser une VM »
signifie donc, très exactement, **« localiser son hôte »**, et l'action réutilise TEL QUEL le
chemin « Localiser » des équipements (même icône `Icons.LOCATE`, même `dcView.locate("equipment", …)`,
même bouton « Retour »).

- **Où** : le **listing VMs** (action de ligne, dans le menu « … » comme partout) et la **fiche VM**
  (bouton du pied d'actions, à côté de « Modifier » — même idiome que la fiche équipement).
- **Version SOBRE** (choix produit) : le bouton n'apparaît **QUE** si la localisation peut aboutir.
  Jamais de bouton grisé, jamais de bouton qui n'ouvrirait qu'un toast d'erreur.
- **Prédicat unique** : `core/VmLocate.hostEquipmentId(vm, store)` rend **l'id de l'équipement à viser**
  ou `null`. Les deux points d'entrée (listing, fiche) l'appellent — la règle n'est écrite qu'une fois.
  Trois conditions, toutes nécessaires : (1) la VM porte un `host_equipment_id` ; (2) cet équipement
  EXISTE encore dans le document (la référence peut pendre — la synchro pose le champ, seul le passage
  par l'app garantit le détachement en cascade) ; (3) la vue 3D sait **atteindre** cet équipement.
- **L'autorité de (3) est `Store.equipmentLocatable`** (→ `core/Locatable`, règle UNIQUE des boutons
  « Localiser », `placement.md` §6.28) : hôte monté en baie, libre positionné, en marge/paroi ou posé
  sur une étagère (baie en salle) ⇒ localisable ; hôte libre sans position, en « pool » de baie
  (`rack_id` sans `rack_u`), ou dans une baie hors salle ⇒ non localisable.
  ⚠ L'autorité était `Store.equipmentDcId` (« se résout-il en une SALLE ? ») ; cette clé a été
  **RETIRÉE** avec le chantier « câblage des équipements d'étage » (`placement.md` §6.33), parce que
  projeter un placement sur une salle déclarait « nulle part » tout contenu d'étage.
- ✅ **Hôte posé sur un ÉTAGE (`placement_mode: "floor"`) : LOCALISABLE depuis `placement.md` §6.27/§6.28**
  — « Localiser » cadre un posé d'étage en MONDE (Vue étage), donc le bouton s'affiche pour la VM qu'il
  héberge. ⚠ Une **exception subsiste** : le posé d'un bâtiment n'ayant **AUCUNE SALLE** reste non
  localisable, la portée d'affichage de la Vue étage s'exprimant en salles (limite §6.27). ⚠ Cette puce
  affirmait l'inverse « par conception » jusqu'au lot 2 de ce chantier ; c'était vrai tant que la vue ne
  savait viser qu'une salle.

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
les jetons ne quittent pas le serveur. Elle se fait EXCLUSIVEMENT par l'**UI**
(modale « Providers… » du sous-onglet Clusters) ; le stockage est la base
chiffrée `vm-providers.db`, **UNIQUE source de configuration**. La clé
`DCMANAGER_SECRETS_KEY` est donc **REQUISE** pour toute la feature.

> 🚨 **Aucun fichier de configuration n'est lu**, et surtout pas un `vm-providers.json` :
> ce format porterait des jetons **EN CLAIR sur disque**, en contradiction directe avec la
> promesse « un backup n'expose aucun jeton ». Le code ne le lit jamais. **À vérifier sur
> tout serveur** : s'il traîne un `vm-providers.json` (ou un `vm-providers.json.imported-*`),
> le **SUPPRIMER à la main** — il porte des jetons exploitables. La configuration se
> (re)saisit alors via l'UI, une fois `DCMANAGER_SECRETS_KEY` définie.

### Stockage de référence : `vm-providers.db` (chiffré)

Base SQLite **dédiée au module** (`vm-providers.db`, à côté de `registry.db` dans
`DOCS_DIR`), POSSÉDÉE par `vm/` — jamais une table de `registry.db` (le cœur ne
connaît rien de la feature ; supprimer la feature = supprimer le module + ce
fichier). Colonnes **typées** — jamais de secret en JSON plaintext :

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

- Le coffre vit **hors de `vm/`** (`src-server/src/SecretBox.ts`) : c'est le coffre
  à secrets serveur **PARTAGÉ** de l'application, réutilisé par les modules `notify/`
  et `wifi/`. Une **clé UNIQUE** pour tous les modules : `DCMANAGER_SECRETS_KEY`.
- **Aucun autre nom de variable n'est reconnu**, et aucun repli n'existe : sans
  `DCMANAGER_SECRETS_KEY`, les features à secrets se comportent comme sans clé
  (503 explicite, feature désactivée). Renommer une variable qui portait la même
  passphrase suffit — même valeur → même dérivation SHA-256, donc les jetons déjà
  stockés restent déchiffrables sans réécriture.
- **AES-256-GCM** (chiffrement *authentifié* : toute altération du stocké est
  détectée au déchiffrement), clé = **SHA-256 de la passphrase d'environnement**
  (dérivation qui normalise une passphrase libre en 32
  octets — un KDF lent type scrypt serait du théâtre : c'est un secret
  d'infrastructure long, pas un mot de passe humain à force-brute), IV aléatoire
  de 12 octets par chiffrement, format stocké versionné `v1:<iv>:<tag>:<ct>`
  (base64, le préfixe autorise une rotation d'algorithme future).
- **Longueur minimale VÉRIFIÉE** : l'hypothèse « secret long et aléatoire » (sur
  laquelle repose l'absence de sel/itérations) n'est plus seulement documentée —
  `SecretBox` **REFUSE au démarrage** toute passphrase de moins de
  `MIN_PASSPHRASE_LENGTH` (**16**) caractères (le module concerné démarre alors
  « en erreur », routes en **503** avec le message actionnable, sans faire tomber
  le serveur). Générer un vrai secret, p. ex. `openssl rand -base64 32`.
- **Limites ASSUMÉES** : la clé vit dans l'environnement du serveur — le
  chiffrement protège les **copies** de la base (backups, exfiltration du
  fichier), PAS un attaquant qui contrôle l'hôte. Ni la passphrase, ni la clé, ni
  un jeton (clair ou chiffré) n'apparaissent dans un log ou une erreur.
- **Clé perdue = jetons à ressaisir** (aucune récupération — c'est le but).

### Modèle de menace — administrateur de confiance (limites assumées)

La gate d'accès de l'API est un **SUPER_ADMIN unique** (pas de rôles fins en v1). La
sécurité de la feature repose donc explicitement sur un **administrateur de confiance** :
plusieurs surfaces le supposent, et le chiffrement au repos NE protège PAS d'un admin
malveillant (il protège les copies de la base — cf. `SecretBox`).

- **Repointage d'endpoint = exfiltration du jeton.** Un admin peut éditer un provider
  pour faire pointer un `url` d'endpoint vers **un serveur qu'il contrôle**, puis lancer
  une synchro / un test : le jeton stocké est alors envoyé en clair à ce serveur dans
  l'en-tête `Authorization: PVEAPIToken=…`. Le jeton d'un admin n'est donc jamais
  « protégé » de lui — seul un opérateur ayant accès aux SEULES copies de la base l'est.
- **`POST …/vm/providers/test` = sonde HTTPS du réseau interne.** La route ouvre une
  connexion TLS vers une URL fournie et en renvoie le résultat (joignabilité, version,
  message d'erreur) : elle peut servir de **scanner** du réseau interne joignable par le
  serveur (SSRF **assumé**, réservé au SUPER_ADMIN).
- **Absence d'AAD** (cf. `SecretBox`) : les jetons chiffrés ne sont pas liés à leur
  table/ligne — un attaquant ayant l'**ÉCRITURE** sur les bases pourrait échanger deux
  ciphertexts (jeton de webhook ↔ jeton de provider) sans erreur de déchiffrement. Hors
  modèle (protection des copies en LECTURE), à lier via une AAD dans un éventuel format v2.

Tout ceci est **ASSUMÉ** tant que l'admin est de confiance (gate SUPER_ADMIN unique) —
**à réévaluer** si des rôles plus fins apparaissent (un « éditeur » non-admin ne devrait
alors ni repointer un endpoint ni sonder le réseau).

> **Note d'implémentation (`markChanged`)** : une passe qui écrit consomme une révision
> (`docs.markChanged`) **avant** `repo.transact`. Si l'écriture échoue, la révision est
> « dépensée » à vide — **sans conséquence** : la révision n'est qu'un compteur monotone
> de verrou optimiste, la cohérence se jouant PAR LIGNE au `transact` (pas de rollback de
> révision à prévoir).

### Clé absente / config invalide (503)

- Clé **absente** : la feature est ENTIÈREMENT désactivée (le mode fichier a été
  retiré) — **TOUTES** les routes `vm` (synchro/statut ET CRUD/test) répondent **503**
  actionnable (« définir `DCMANAGER_SECRETS_KEY`… ») et l'UI affiche un bandeau au lieu
  des contrôles. Sans clé, ni inventaire ni gestion des providers n'est possible.
- Clé absente **mais** `vm-providers.db` présente : module « en erreur » explicite,
  message ENRICHI (« base chiffrée présente sans clé — définissez la clé pour déchiffrer
  les jetons stockés »). Pas de silence.
- Config invalide (DB en erreur) : module « en erreur », routes en **503** avec le
  détail — visibilité opérateur sans faire tomber le reste.

### Dépannage — clé `DCMANAGER_SECRETS_KEY` CHANGÉE (jetons stockés indéchiffrables)

**Symptôme** (incident réel) : la vue **Clusters** n'affiche plus aucun cluster
et le bouton **« Tester »** d'un provider échoue — alors que la clé est bien
définie et la liste des providers reste affichée. Les logs serveur montrent :

```
ERROR [vm] POST /vm/providers/test : construction en échec <docId>
  SecretBox : déchiffrement refusé (clé DCMANAGER_SECRETS_KEY différente ou
  donnée altérée) — le secret doit être ressaisi
```

**Cause** : la valeur de `DCMANAGER_SECRETS_KEY` a **changé** depuis
l'enregistrement du jeton (ou la variable a été renommée depuis l'ancien
`VM_PROVIDERS_KEY` sans reporter la MÊME valeur). Le jeton est
chiffré AU REPOS avec une clé dérivée de la passphrase (cf. « Chiffrement des
jetons ») : une passphrase différente ne peut PAS le déchiffrer (AES-256-GCM
authentifié — c'est le but : clé perdue = secret irrécupérable). Ce n'est PAS le
cas « clé absente » (§ 503) : ici la clé EST présente, mais ce n'est pas la bonne.
Le module fonctionne, la liste des providers s'affiche (elle ne déchiffre aucun
jeton), mais toute opération qui a besoin du jeton en clair (synchro, test) échoue.

**Comportement UI — explicite, jamais silencieux** :

- **Vue Clusters** : le provider concerné, qu'un simple `providersFor` écarterait
  (il rejette tout jeton indéchiffrable), est **réinjecté** comme
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

### Dépannage — VMs en DOUBLE (identité de réconciliation)

**Symptôme** : après une ou plusieurs synchros, chaque VM apparaît **deux fois**
dans le listing.

**Mécanique en jeu** : la clé de réconciliation est `ext_id` =
`nomDuCluster/vmid`, et le périmètre d'une passe est `provider_id`. Toute VM dont
le couple (`provider_id`, `ext_id`) n'est pas retrouvé est **créée** ; toute VM du
périmètre absente de l'inventaire passe **orpheline**. Un doublon est donc TOUJOURS
la trace d'un changement d'identité — jamais d'une écriture dupliquée (la table
`vms` a `id` en clé primaire, et la réconciliation ignore un `ext_id` déjà vu).

**Diagnostic DIFFÉRENTIEL** — ouvrir les DEUX fiches (`ext_id · provider_id` et
« Dernière synchro » y sont affichés) :

| Ce qu'on observe sur la paire | Cause |
|---|---|
| `provider_id` IDENTIQUE, `ext_id` de préfixe DIFFÉRENT, un exemplaire portant la pastille **orpheline** | le **nom du cluster** a changé d'une passe à l'autre (renommage, nœud isolé ayant rejoint un cluster — ou, avant le garde-fou ci-dessous, un simple échec de `/cluster/status`) |
| `ext_id` IDENTIQUE, `provider_id` DIFFÉRENT, **aucune** pastille orpheline, les deux `last_sync` vivantes | **deux providers** synchronisent le MÊME cluster (doublon de configuration) |
| `ext_id` IDENTIQUE, `provider_id` DIFFÉRENT, l'ancien exemplaire **sans** pastille orpheline et `last_sync` FIGÉE | le provider a été **supprimé/recréé sous un autre id** : les VMs de l'ancien id ne sont plus dans AUCUN périmètre — elles ne sont donc jamais marquées orphelines, elles se figent |

⚠ Conséquence du 3ᵉ cas, à connaître : **supprimer un provider ne rend pas ses VMs
orphelines** — plus aucune passe ne couvre leur `provider_id`. Elles se **figent** dans
leur dernier état, sans pastille, jusqu'à une suppression explicite. C'est exactement ce
que le groupe « provider disparu » de la **purge de masse** sait retrouver (il compare
les `provider_id` du document à la configuration serveur) — voir « Purge de masse des
orphelines ».

**Garde-fou (identité FAILLIBLE)** : le nom du cluster vient de `/cluster/status`.
Il est le **socle d'identité** de la passe, pas une métadonnée : s'il n'est pas
résolu (appel en échec, réponse sans entrée cluster nommée ni nœud unique), la
passe **AVORTE** — statut du provider en erreur, message actionnable, **aucune
écriture** (`ProxmoxAdapter.requireClusterName`). Se replier sur une autre valeur
recréerait TOUT l'inventaire sous une seconde identité, et la passe suivante ferait
le chemin inverse (battement). Corollaire : la **composition** de l'`ext_id` ne se
change pas non plus « pour la rendre plus stable » — ce serait dédoubler l'existant
une fois de plus.

**Remédier aux doublons existants** : les exemplaires **orphelins** (1ᵉʳ cas) se
purgent **depuis leur fiche** (bouton « Supprimer cette VM orpheline… ») ou, quand ils
se comptent par dizaines, d'un seul geste via « **Purger…** » (en-tête de l'onglet VMs
ou carte provider — cf. « Purge de masse des orphelines »). Vérifier AVANT si
l'exemplaire supprimé porte des enrichissements locaux (notes, groupes, hôte rattaché) :
ils ne sont PAS reportés sur son jumeau, ils sont perdus — c'est pourquoi la purge de
masse **exclut les enrichies par défaut** et les liste par leur nom.
Les exemplaires des 2ᵉ/3ᵉ cas ne portent PAS la pastille orpheline, donc pas le bouton
de fiche (réservé aux orphelines — supprimer une VM encore inventoriée serait vain) :
il faut d'abord **retirer le provider en trop** de la configuration, puis purger ses
VMs — elles apparaissent alors dans le groupe « **provider disparu** » de la purge de
masse, qui est précisément là pour ça.

### Champs d'un provider (validation `ProviderConfigValidate`)

La validation est assurée par `ProviderConfigValidate` (classe pure) — messages
d'erreur identiques par l'UI (400 affichée telle quelle) et par le CRUD DB.

- `id` : unique par document ; **immuable en édition** (clé de réconciliation des
  VMs — `ext_id` = `nomDuCluster/vmid`, seul repli : le nom du nœud d'une
  installation ISOLÉE ; sans nom résolu la passe avorte, cf. « Dépannage — VMs en DOUBLE »).
- `kind` : `proxmox` (seul type supporté par `VmSyncService.adapterFor`).
- **Pool de nœuds** (éditeur ordonné dans l'UI) — palier à la défaillance d'un
  nœud : l'API Proxmox répond sur chaque nœud, les endpoints sont essayés dans
  l'ORDRE et le pool **bascule** quand un nœud est injoignable (réseau, DNS, délai,
  TLS). La bascule ne s'applique JAMAIS à une erreur applicative (authentification,
  statut HTTP) — elle échouerait à l'identique partout. Préférence collante : le
  dernier nœud ayant répondu est réessayé en premier, un nœud mort ne coûte donc son
  délai qu'une fois par passe (cf. `PveHttpPool.ts`). L'UI émet la forme pool (`urls`,
  empreinte par nœud) ; la validation partagée tolère aussi le raccourci mono-nœud
  `url` (+ `fingerprint`), exclusif de `urls`.
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
  3. sinon → validation par les **CA système** (cas par défaut).
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
serveur : elle est **REQUISE** pour toute la feature VM (inventaire ET gestion des
providers par l'UI) et chiffre les secrets au repos (clé UNIQUE partagée par tous
les modules à secrets — VM, notifications, wifi). **Aucun autre nom n'est reconnu** :
un déploiement qui porterait la passphrase sous un autre nom doit **renommer** la
variable en `DCMANAGER_SECRETS_KEY` (même valeur → même dérivation, jetons déjà
stockés déchiffrables sans réécriture). Sans clé : la feature est entièrement
désactivée (toutes les routes en 503 actionnable). **Clé perdue = jetons à ressaisir**
(aucune récupération possible).

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
2. **Client** : supprimer `models/Vm.ts`, `core/VmNetMapping.ts`, `core/VmStatus.ts`,
   `core/VmHostTip.ts`,
   `core/VmLocate.ts`, `views/forms/VmForms.ts`, `views/forms/VmProvidersForm.ts`,
   `views/forms/VmSyncClient.ts` ; retirer les
   branchements fins : entrée `vms` d'`EntityRegistry`, `ListConfigs.vms` +
   l'onglet dans `main.ts` (dont son `locate`/`locateTarget` — l'option
   `TabOpts.locateTarget` elle-même n'a plus d'utilisateur et peut partir avec),
   le `case "vms"` de `DetailForms`, le sélecteur VM
   d'`IpamForms`/`FormUi.vmOptions`, `Store.ipAddressesOfVm`, `Store.vmsOfHost`,
   le bloc « VMs hébergées » de `DcInteract.equipmentTipHtml` (+ les clés i18n
   `dc.interact.vmCount`/`vmMore`), le bouton « Localiser » de `DetailForms.vmDetail`
   (+ la clé i18n `detail.vm.locateHost`), `INDEX_SPEC.vms`
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
3. Étendre `ProviderConfigValidate` si la config exige d'autres champs (validation
   du CRUD DB ; les clés inconnues sont déjà tolérées).
4. `ext_id` : choisir une identité STABLE côté provider (équivalent de
   `cluster/vmid`) — c'est la clé de réconciliation.

## Mode local (fichier) — principe n°15

**Non disponible en mode fichier AUJOURD'HUI — écart assumé et documenté** (principe n°15 de
`CLAUDE.md`) : l'inventaire est produit par la SYNCHRO côté serveur (jetons chiffrés au repos,
appels Proxmox). ⚠ Ce qui ne dépend PAS du serveur reste, lui, disponible en local : la
collection `vms` est une collection du DOCUMENT (lisible, cherchable, enrichissable), et la
**purge de masse** fonctionne SANS serveur — un document exporté avec ses orphelines se purge
en local, avec le repli documenté « liste des providers inconnue » (cf. « Purge de masse des
orphelines »). ⚠ **Évolution PRÉVUE** (décision utilisateur 2026-08-02) : un provider
**« Manuel »** permettant de créer/éditer une VM à la main — ce chemin-là devra fonctionner
AUSSI en mode fichier (`vms` est une collection du DOCUMENT ; seule la synchro est serveur).
Cadrage à venir : `.notes/toDos/vms-provider-manuel-todo-2026-08-02.md`.
