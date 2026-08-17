# Inventaire des clients wifi (UniFi) — configuration & exploitation

*Pour le technicien qui déploie/exploite — l'architecture du module, le pivot agnostique de marque et
la procédure d'ajout d'une autre marque de contrôleur sont dans
[`docs/wifi-unifi.md`](../docs/wifi-unifi.md).*

Le module synchronise les clients connectés d'un contrôleur wifi vers la collection `wifiClients` du
document. UniFi est la première marque implémentée.

---

## 1. Prérequis : `DCMANAGER_SECRETS_KEY`

Le module chiffre au repos la clé d'API de chaque contrôleur : sans la clé de chiffrement des secrets
serveur, il reste inactif. Contrainte, génération et portée :
[`configuration.md`](configuration.md) § 2.

---

## 2. Configurer un provider (par document)

Un provider = **une console + UN site**. Multi-sites ⇒ plusieurs providers. Il n'y a **pas de pool
d'endpoints** (contrairement au module VM) : un contrôleur wifi n'a qu'une console.

La configuration se fait par l'interface, modale **« Providers… »**. Elle est stockée dans la base
chiffrée `wifi-providers.db`, dans `DOCS_DIR`, à côté de `registry.db`.

### Champs d'un provider

| Champ | Requis | Défaut | Notes |
|---|---|---|---|
| `id` | oui | — | **immuable** après création (clé de réconciliation des clients) |
| `kind` | oui | — | doit être un type **connu** (`unifi`) — sinon la validation refuse |
| `url` | oui | — | **https obligatoire** : la clé voyage en en-tête à chaque requête |
| `token` | oui à la création | — | clé d'API, **chiffrée au repos**, jamais relue ni renvoyée |
| `fingerprint` | non | `null` | empreinte SHA-256 à épingler (console à certificat auto-signé) |
| `ca_pem` | non | `null` | CA de la console, au format PEM — **publique**, renvoyée en lecture |
| `interval_sec` | non | `0` | `0` = synchro **manuelle** uniquement |
| `timeout_sec` | non | `15` | délai d'**une** requête HTTP |
| `options.site` *(UniFi)* | non | `"default"` | identifiant, **nom**, ou **référence interne** du site |
| `options.include_wired` *(UniFi)* | non | `false` | opt-in : l'API expose aussi les clients filaires |

> **Le champ « Site ».** Un site UniFi porte à la fois un **nom d'affichage** (ce que l'administrateur
> voit dans la console — p. ex. « Sonuma ») et une **référence interne stable** (typiquement
> `default`). Les deux sont reconnus, indépendamment l'un de l'autre : la valeur par défaut `default`
> se résout donc directement, même si la console affiche un tout autre nom. Si le site n'est pas
> trouvé, le message d'erreur **énumère les sites disponibles** (nom et identifiant) : recopier l'un
> des deux plutôt que le deviner.

### Confiance TLS

Hiérarchie, du plus spécifique au plus général : **empreinte épinglée** (`fingerprint`) → **CA
fournie** (`ca_pem`) → **CA système**. Il n'existe **aucune** option « accepter tout ». Une console
UniFi en certificat auto-signé se traite donc par empreinte ou par CA.

### Prise d'effet

Après **chaque** écriture (création, modification, suppression), les timers périodiques sont
**ré-armés** : la configuration prend effet à chaud, **sans redémarrage** du serveur.

---

## 3. Clé absente ou configuration invalide → 503

- **Clé absente** — module inactif : **toutes** les routes répondent **503** avec un détail
  actionnable (« définir `DCMANAGER_SECRETS_KEY`… »). Si une `wifi-providers.db` existe **déjà** sans
  clé, le message est enrichi (des jetons chiffrés attendent la clé).
- **Clé présente mais trop courte, ou base illisible** — module « démarré en erreur », routes en
  **503** avec le détail. Le serveur, lui, **démarre normalement** : une configuration invalide ne
  fait jamais tomber l'application.

La modale « Providers… » affiche ce détail **à la place** des contrôles d'édition : il n'y a rien à
configurer tant que la clé n'est pas là.

---

## 4. Dépannage — la clé a CHANGÉ (jetons indéchiffrables)

**Symptômes** : les providers disparaissent de la synchro, le statut les réaffiche **en erreur** avec
« le secret doit être ressaisi », et « Tester » répond **422** avec le même message.

**Correctif** : rouvrir « Providers… », **ressaisir la clé d'API** de chaque provider, enregistrer.
Rien d'autre n'est perdu : URL, site, intervalles, empreinte et CA sont stockés en clair.

Un jeton indéchiffrable exclut **ce** provider de la passe et mémorise une erreur consultable : la
synchro des autres providers n'est jamais interrompue.

---

## 5. Ce que l'API UniFi expose — et ce qu'elle n'expose pas

✅ **Validé le 2026-08-04** sur une console réelle : **UniFi Network 10.4.57**, **UniFi OS Server**
auto-hébergé, via l'**API d'intégration officielle** (l'API privée de la console n'est jamais
utilisée). Le module lit : nom du client, adresse MAC, adresse IP, type (sans fil / filaire), point
d'accès de rattachement, et « connecté depuis ».

### ⚠ Limite mesurée — le SSID n'est PAS exposé

Constat mesuré, pas un défaut de configuration : **l'API d'intégration officielle ne sert le SSID
nulle part**, ni dans la liste des clients ni dans la fiche détail. Conséquence : la colonne **SSID
reste vide** pour tous les clients d'un provider UniFi. Rien à régler — le champ est conservé au
contrat commun pour une autre marque, ou une future version de l'API.

### « Déconnecté » n'est pas « orphelin »

Le contrôleur ne liste que les clients **connectés** : disparaître est un événement **quotidien**, pas
un incident. Un client déconnecté est signalé en **avertissement**, jamais en erreur, et **aucune
suppression n'est proposée** — il revient dès qu'il se reconnecte, et purger détruirait ses notes pour
rien.

### Volume

Un plafond de **32 Mio par réponse** et un cap dur de pages par ressource protègent la synchro : une
console qui ignorerait la pagination ne peut pas la faire boucler indéfiniment.

---

## 6. Procédure de re-validation (au premier déploiement, ou si une future version d'API dévie)

1. Créer une clé d'API **en lecture seule** dans la console.
2. Configurer un provider (URL, clé, site) et cliquer **« Tester la connexion »** :
   - **404** → la base d'API est différente (console « Network Application » autonome : essayer sans
     le préfixe `/proxy/network`) ;
   - **« site introuvable »** → le message **énumère** les sites disponibles : recopier l'un d'eux
     dans le champ « Site » ;
   - **401 / 403** → droits de la clé.
3. Lancer une **synchro manuelle** et vérifier dans le listing : nom (ou MAC), IP, type, point
   d'accès, « connecté depuis » — le SSID restera vide (§ 5). Un champ **systématiquement** vide
   signale un décodage à corriger : le signaler.
4. Vérifier le **volume** : si le total plafonne à un multiple rond, la pagination de la console ne se
   comporte pas comme constaté — le signaler également.

---

## 7. Déploiement

| Variable | Rôle | Sans elle |
|---|---|---|
| `DCMANAGER_SECRETS_KEY` | chiffrement des clés d'API des contrôleurs (**partagée** avec les modules VM, tracker et notifications) | module inactif, routes en **503** actionnable |

**Aucune autre variable d'environnement n'est propre à cette feature** : le dossier des documents et
le pilote SQLite sont ceux du cœur.

Au premier déploiement :

1. définir ou vérifier `DCMANAGER_SECRETS_KEY` (si le module VM, tracker ou notifications tourne déjà,
   elle est là — c'est le but d'une clé partagée) ;
2. configurer un provider et **valider le comportement de l'API** (procédure du § 6) ;
3. régler `interval_sec` : `0` (manuel) le temps de la validation, puis une période **réaliste** — la
   synchro relit **tout** l'inventaire du site à chaque passe.
