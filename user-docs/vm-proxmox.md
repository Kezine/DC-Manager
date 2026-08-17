# Inventaire VM (Proxmox) — configuration & exploitation

*Pour le technicien qui déploie/exploite — l'architecture du module, la frontière source/locaux et la
procédure d'ajout d'une autre marque d'hyperviseur sont dans
[`docs/vm-proxmox.md`](../docs/vm-proxmox.md).*

Le module synchronise l'inventaire des machines virtuelles d'un ou plusieurs clusters Proxmox vers
la collection `vms` du document.

---

## 1. Prérequis : `DCMANAGER_SECRETS_KEY`

La feature est **entièrement conditionnée** à la présence de la clé de chiffrement des secrets
serveur : sans elle, ni inventaire ni gestion des providers. Contrainte, génération et portée :
[`configuration.md`](configuration.md) § 2.

---

## 2. Configurer un provider (par document)

La configuration est **par document** (chaque document = une infrastructure) et vit **côté
serveur** — jamais dans le document, qui est répliqué aux clients : les jetons ne quittent pas le
serveur. Elle se fait **exclusivement par l'interface**, via la modale **« Providers… »** du
sous-onglet **Clusters**. Le stockage est la base chiffrée `vm-providers.db`, placée dans `DOCS_DIR`
à côté de `registry.db` : c'est l'**unique** source de configuration.

> 🚨 **Aucun fichier de configuration n'est lu**, et surtout pas un `vm-providers.json` : ce format
> porterait des jetons **EN CLAIR sur disque**, en contradiction directe avec la promesse « une
> sauvegarde n'expose aucun jeton ». Le code ne le lit jamais. **À vérifier sur tout serveur** : s'il
> traîne un `vm-providers.json` (ou un `vm-providers.json.imported-*`), le **SUPPRIMER à la main** —
> il porte des jetons exploitables. La configuration se (re)saisit alors par l'interface, une fois
> `DCMANAGER_SECRETS_KEY` définie.

Ce que la base stocke, et ce qu'elle ne rend jamais : le **jeton n'est jamais en clair ni jamais
renvoyé** par l'API (la liste et l'enregistrement renvoient au plus `has_token: true`) ; il n'est
déchiffré que côté serveur, en mémoire, pour une synchro ou un test de connexion. Le `ca_pem`, lui,
est un certificat **public** : il est renvoyé tel quel, sans réserve.

### Champs d'un provider

- **`id`** — unique par document, **immuable en édition** : c'est la clé de réconciliation des VMs.
- **`kind`** — `proxmox` (seul type supporté).
- **Pool de nœuds** (éditeur ordonné dans l'interface) — palier à la défaillance d'un nœud : l'API
  Proxmox répond sur chaque nœud, les endpoints sont essayés **dans l'ordre**, et le pool **bascule**
  quand un nœud est injoignable (réseau, DNS, délai, TLS). La bascule ne s'applique **jamais** à une
  erreur applicative (authentification, statut HTTP) : elle échouerait à l'identique partout.
  Préférence collante — le dernier nœud ayant répondu est réessayé en premier, un nœud mort ne coûte
  donc son délai qu'une fois par passe.
- **Confiance TLS — hiérarchie à 3 niveaux, décidée PAR ENDPOINT**, du plus spécifique au plus
  général :
  1. `fingerprint` de l'endpoint présent → **épinglage** : empreinte SHA-256 du certificat, **par
     nœud** (chaque nœud Proxmox porte son propre certificat — l'interface Proxmox l'affiche). Le
     plus spécifique, **prioritaire** ; recommandé avec des certificats auto-signés.
  2. sinon `ca_pem` du provider présent → validation TLS par **cette CA de cluster**. ⚠ Le nom d'hôte
     de l'URL doit alors correspondre au CN/SAN du certificat du nœud (sinon
     `ERR_TLS_CERT_ALTNAME_INVALID`).
  3. sinon → validation par les **CA système** (cas par défaut).
- **`ca_pem`** — certificat **CA du cluster** (`pve-root-ca.pem`), au format PEM. La CA du cluster
  émet le certificat de **chaque** nœud : lui faire confiance = **une seule valeur pour tout le
  pool**, qui **survit** aux régénérations de certificats (`pvecm updatecerts`) — alternative plus
  robuste que l'épinglage par nœud. Où le trouver : `/etc/pve/pve-root-ca.pem` sur un nœud, ou
  l'interface Proxmox (*Datacenter → … → Certificats*). **Public** (pas un secret). Combinable avec
  des empreintes par endpoint : le pin prime par nœud, la CA sert de repli. Absent = CA système.
- **`token`** — jeton d'API Proxmox. Le rôle **lecture seule `PVEAuditor`** suffit ; les jetons
  Proxmox sont *cluster-wide*, un seul jeton couvre tout le pool. Dans l'interface, il est en
  **écriture seule** (champ jamais pré-rempli ; laissé vide en édition = jeton conservé). Chiffré au
  repos dès l'enregistrement.

  ⚠ **Séparation de privilèges.** Par défaut (`privsep=1`), un jeton Proxmox n'hérite **pas** des
  permissions de son utilisateur : l'API filtre alors les résultats et `/cluster/resources` renvoie
  une liste **vide sans erreur** (symptôme : « synchro OK, 0 VM »). Donner le rôle **au jeton
  lui-même** :

  ```bash
  pveum acl modify / --tokens 'sync@pve!inventaire' --roles PVEAuditor --propagate 1
  ```

  (interface Proxmox : *Datacenter → Permissions → Add → API Token Permission*, chemin `/`,
  propagation cochée) — ou créer le jeton avec `--privsep 0` pour qu'il hérite de l'utilisateur. Le
  statut de synchro signale explicitement ce cas.
- **`include_lxc`** — défaut `true` : les conteneurs LXC sont inclus dans l'inventaire.
- **`interval_sec`** — période de synchro automatique (entier ≥ 0) ; `0` = manuelle uniquement.
- **`timeout_sec`** — délai maximal d'**une** requête HTTP, en secondes (entier ≥ 1, défaut 15) —
  borne aussi le coût d'une bascule sur nœud mort.

La validation est la même par l'interface et par l'API : les messages d'erreur sont identiques.

---

## 3. Clé absente ou configuration invalide → 503

- **Clé absente** — la feature est **entièrement** désactivée : **toutes** les routes `vm` (synchro,
  statut, CRUD, test) répondent **503** actionnable (« définir `DCMANAGER_SECRETS_KEY`… ») et
  l'interface affiche un bandeau à la place des contrôles.
- **Clé absente mais `vm-providers.db` présente** — module « en erreur » explicite, avec un message
  enrichi : « base chiffrée présente sans clé — définissez la clé pour déchiffrer les jetons
  stockés ». Jamais de silence.
- **Configuration invalide** (base illisible, clé trop courte) — module « en erreur », routes en
  **503** avec le détail. Le serveur, lui, **démarre normalement**.

---

## 4. Dépannage — la clé `DCMANAGER_SECRETS_KEY` a CHANGÉ

**Symptôme** : la vue **Clusters** n'affiche plus aucun cluster et le bouton **« Tester »** d'un
provider échoue — alors que la clé est bien définie et que la liste des providers reste affichée. Les
logs montrent :

```
ERROR [vm] POST /vm/providers/test : construction en échec <docId>
  SecretBox : déchiffrement refusé (clé DCMANAGER_SECRETS_KEY différente ou
  donnée altérée) — le secret doit être ressaisi
```

**Cause** : la valeur de `DCMANAGER_SECRETS_KEY` a **changé** depuis l'enregistrement du jeton (ou la
variable a été renommée sans reporter la **même** valeur). Le jeton est chiffré au repos avec une clé
dérivée de la passphrase : une passphrase différente ne peut pas le déchiffrer — c'est le but. Ce
n'est **pas** le cas « clé absente » (§ 3) : ici la clé est présente, mais ce n'est pas la bonne. Le
module fonctionne et la liste des providers s'affiche (elle ne déchiffre aucun jeton), mais toute
opération qui a besoin du jeton en clair — synchro, test — échoue.

**Ce que montre l'interface** — explicite, jamais silencieux :

- **Vue Clusters** : le provider concerné est **réinjecté** comme une carte **« Provider en erreur »**
  (bandeau rouge) portant le message ci-dessus, au lieu d'une liste vide silencieuse.
- **Bouton « Tester »** : affiche le message dans la zone d'erreur du formulaire (réponse **422**).
- **Bouton « Synchroniser »** : le résultat inclut aussi ces providers en erreur.

**Solution** : rouvrir le provider (**Providers…** → *Modifier*), **ressaisir le jeton** dans le champ
« Jeton d'API », puis **Enregistrer**. Le jeton est re-chiffré avec la clé courante et redevient
déchiffrable. *Alternative* : restaurer l'**ancienne** valeur de `DCMANAGER_SECRETS_KEY` dans
l'environnement du serveur, si elle est connue.

Aucune donnée du document n'est perdue entre-temps : les VMs déjà synchronisées restent en place, la
synchro reprend une fois le jeton ressaisi.

---

## 5. Dépannage — des VMs en DOUBLE

**Symptôme** : après une ou plusieurs synchros, chaque VM apparaît **deux fois** dans le listing.

**La mécanique en jeu.** La clé de réconciliation est `ext_id` = `nomDuCluster/vmid`, et le périmètre
d'une passe est le `provider_id`. Toute VM dont le couple (`provider_id`, `ext_id`) n'est pas
retrouvé est **créée** ; toute VM du périmètre absente de l'inventaire passe **orpheline**. Un doublon
est donc **toujours** la trace d'un changement d'identité — jamais d'une écriture dupliquée.

**Diagnostic différentiel** — ouvrir les **deux** fiches (`ext_id · provider_id` et « Dernière
synchro » y sont affichés) :

| Ce qu'on observe sur la paire | Cause |
|---|---|
| `provider_id` IDENTIQUE, `ext_id` de préfixe DIFFÉRENT, un exemplaire portant la pastille **orpheline** | le **nom du cluster** a changé d'une passe à l'autre (renommage, nœud isolé ayant rejoint un cluster) |
| `ext_id` IDENTIQUE, `provider_id` DIFFÉRENT, **aucune** pastille orpheline, les deux « dernière synchro » vivantes | **deux providers** synchronisent le MÊME cluster (doublon de configuration) |
| `ext_id` IDENTIQUE, `provider_id` DIFFÉRENT, l'ancien exemplaire **sans** pastille orpheline et sa « dernière synchro » FIGÉE | le provider a été **supprimé puis recréé sous un autre id** : les VMs de l'ancien id ne sont plus dans aucun périmètre — elles ne sont donc jamais marquées orphelines, elles se figent |

⚠ **Conséquence du 3ᵉ cas, à connaître : supprimer un provider ne rend pas ses VMs orphelines** —
plus aucune passe ne couvre leur `provider_id`. Elles se **figent** dans leur dernier état, sans
pastille, jusqu'à une suppression explicite. C'est exactement ce que le groupe « provider disparu »
de la **purge de masse** sait retrouver (il compare les `provider_id` du document à la configuration
serveur).

**Le garde-fou.** Le nom du cluster vient de `/cluster/status`. Il est le **socle d'identité** de la
passe, pas une métadonnée : s'il n'est pas résolu (appel en échec, réponse sans entrée cluster nommée
ni nœud unique), la passe **avorte** — statut du provider en erreur, message actionnable, **aucune
écriture**. Se replier sur une autre valeur recréerait tout l'inventaire sous une seconde identité, et
la passe suivante ferait le chemin inverse (battement).

**Voir l'identité AVANT le dommage.** La carte provider du sous-onglet **Clusters** affiche l'identité
de réconciliation en clair — ligne « **Identité** » : `<nomDuCluster>/…` (la partie variable étant le
`vmid`), tirée du dernier état cluster connu. Un préfixe qui n'est plus celui des `ext_id` affichés
sur les fiches VM est **l'alarme la plus précoce disponible**. Aucune ligne n'apparaît tant que le
provider n'a pas été synchronisé depuis le démarrage du serveur : il n'y a alors pas d'identité
connue.

Deux autres lectures de la même carte, tirées de la **même** réponse `/cluster/status` (aucun appel
réseau supplémentaire) : le quorum porte le ratio « **x/y nœuds** » — nœuds **répondants** en ligne
sur nœuds **membres** déclarés par le cluster —, l'écart signalant un membre éteint ou injoignable ;
et la table des nœuds porte leur **adresse** (« — » si le nœud n'est pas décrit par cet endpoint).

**Remédier aux doublons existants.** Les exemplaires **orphelins** (1ᵉʳ cas) se purgent depuis leur
fiche (bouton « Supprimer cette VM orpheline… ») ou, quand ils se comptent par dizaines, d'un seul
geste via « **Purger…** » (en-tête de l'onglet VMs, ou carte provider).

> ⚠ Vérifier **avant** si l'exemplaire supprimé porte des enrichissements locaux (notes, groupes,
> hôte rattaché) : ils ne sont **pas** reportés sur son jumeau, ils sont perdus. C'est pourquoi la
> purge de masse **exclut les VMs enrichies par défaut** et les liste par leur nom.

Les exemplaires des 2ᵉ et 3ᵉ cas ne portent pas la pastille orpheline, donc pas le bouton de fiche
(réservé aux orphelines) : il faut d'abord **retirer le provider en trop** de la configuration, puis
purger ses VMs — elles apparaissent alors dans le groupe « **provider disparu** » de la purge de
masse, qui est précisément là pour ça.

---

## 6. Déploiement

Ajouter **`DCMANAGER_SECRETS_KEY`** à l'environnement du serveur : elle est **requise** pour toute la
feature VM — inventaire **et** gestion
des providers par l'interface. C'est la clé **unique** partagée par tous les modules à secrets (VM,
wifi, tracker, notifications) ; si l'un d'eux tourne déjà, elle est là. Détail :
[`configuration.md`](configuration.md) § 2.

Au premier déploiement :

1. définir ou vérifier `DCMANAGER_SECRETS_KEY` ;
2. créer un provider (pool de nœuds, confiance TLS, jeton `PVEAuditor`) et **« Tester la
   connexion »** ;
3. régler `interval_sec` : `0` (manuel) le temps de la validation, puis une période réaliste.

---

## 7. Gamme Proxmox supportée

**PVE 8 à 9.** Le test de connexion lit `GET /version` ; une version hors gamme donne un
**avertissement, pas un blocage** — l'inventaire est tenté quand même, les endpoints utilisés étant
stables depuis PVE 7. Le décodage des réponses est tolérant par principe.
