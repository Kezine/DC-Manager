# Notifications & certificats — configuration & exploitation

*Pour le technicien qui déploie/exploite — le moteur d'alertes, le schéma des bases et le modèle
cryptographique de la PKI sont dans [`docs/notifications.md`](../docs/notifications.md) et
[`docs/certs.md`](../docs/certs.md).*

Deux features distinctes, dont les volets « déploiement » sont courts et se croisent (le veilleur
d'échéances de certificats est un producteur de notifications).

---

# Partie A — Notifications

Le service émet des **alertes persistantes** : un problème détecté côté serveur donne une première
notification, puis des **rappels espacés** tant qu'il dure, et un message « rétabli » une fois quand
il disparaît. Un problème permanent ne produit donc jamais d'avalanche.

## A.1 Prérequis : `DCMANAGER_SECRETS_KEY`

Le module chiffre au repos les jetons des webhooks. **Sans la clé, le module est inactif EN BLOC** —
y compris le canal `console`, qui pourtant ne porte aucun secret. C'est une uniformité assumée : un
module, un prérequis, un message. Les routes répondent **503** explicite et la page d'administration
affiche un bandeau actionnable à la place des contrôles ; les signalements des producteurs deviennent
inertes.

Contrainte, génération et portée : [`configuration.md`](configuration.md) § 2. **Module en erreur**
(par exemple `notify.db` illisible) : routes en 503 avec le détail, sans faire tomber le serveur.

**Clé perdue = jetons à ressaisir.** Un test direct sur un canal dont le jeton est indéchiffrable
répond **409** (« ressaisir le jeton du canal »).

## A.2 Ce qui se configure : canaux, abonnements, rappels

Tout se règle dans l'application, **Paramètres → Notifications**. Trois notions :

- **Canal** — un moyen d'émission. Deux familles : `console` (écrit dans les logs du serveur, utile
  pour valider un routage sans passerelle) et `webhook` (POST JSON vers une URL, § A.3). Le jeton d'un
  canal est en écriture seule : jamais réaffiché, « inchangé si vide » à l'édition.
- **Abonnement** — le routage : *type d'événement* × *portée* × *contact* × *canal*. La portée est
  soit **ce document**, soit **globale** ; le type accepte le joker `*` (capte tout). Le destinataire
  est un **contact** du carnet du document : le canal détermine quelle adresse est utilisée — `email`
  → l'e-mail du contact, `sms` → son téléphone.
- **Rappel** — l'intervalle de répétition, réglable **par type d'événement** (défaut **12 h**,
  minimum 1 minute).

Un abonnement est **relu à chaque envoi** : en ajouter un le rend actif dès le prochain rappel, sans
redémarrage ni invalidation de cache.

> **Cas dégradés, tous non bloquants** : contact introuvable, contact sans adresse pour ce canal,
> instance de canal désactivée, jeton indéchiffrable — l'abonnement concerné est **journalisé et
> sauté**, jamais un échec global. Les autres destinataires du même problème sont servis normalement.
> Vérifier les logs (scope `[notify]`) après une configuration qui ne semble pas partir.

### Types d'événements produits par le serveur

| `event_type` | Ce qu'il signale |
|---|---|
| `vm-sync-failure` | une passe de synchronisation VM a échoué (par provider) |
| `cert-expiry` | un certificat de la PKI approche de son échéance (gravité croissante à 30 / 14 / 7 jours) |
| `warranty-expiring` | la garantie d'un équipement expire dans ≤ 90 jours |
| `warranty-expired` | la garantie d'un équipement est **dépassée** |
| `intervention-reminder` | rappel d'une intervention planifiée (paliers 24 h / 1 h / heure H) |

Un abonnement au type `*` capte l'ensemble.

## A.3 Contrat de payload des WEBHOOKS

Un canal `webhook` **POSTe du JSON** sur l'URL configurée. C'est le point d'intégration avec vos
passerelles d'envoi existantes (SMS, e-mail). **Trois réglages par instance de canal** choisissent la
forme du corps.

### Forme normale (défaut)

```
POST https://webhook.exemple.lan/notify
Content-Type: application/json
Authorization: Bearer <jeton>          (optionnel — omis si le canal n'a pas de jeton)

{
  "to": "ops@exemple.lan",             // adresse résolue (e-mail ou téléphone, selon le canal)
  "subject": "Synchro VM en échec — pve-prod",
  "body": "…résumé lisible du problème…",
  "severity": "error",                 // info | warning | error
  "event_type": "vm-sync-failure",
  "format": "text"                     // "text" (défaut) | "html"
}
```

- Réglage **`html`** : `false` (défaut) → `body` en texte brut, le saut de ligne étant le seul
  formatage. `true` → `body` mis en forme HTML, **entités échappées** (le contenu vient des
  producteurs, jamais de confiance). La clé `format` indique à la passerelle comment lire `body`.

### Forme simplifiée (réglage `simple_mode`)

Pour les passerelles SMS basiques : le POST n'émet **que** deux clés, rien d'autre.

```json
{
  "to":   "+32...",
  "text": "[erreur] Synchro VM en échec — pve-prod : timeout…"
}
```

- `text` = gravité (`[avertissement] ` / `[erreur] `, rien pour `info`) + sujet + `— corps`, sauts de
  ligne repliés en espaces, **tronqué à `simple_max_chars`** (défaut **300**, bornes `[20, 5000]`) —
  l'ellipse finale « … » compte **dans** la limite. Le réglage `html` est **ignoré** dans cette forme.

### Comportement du transport

- **Authentification** : jeton en `Authorization: Bearer` s'il est défini. Il n'est déchiffré qu'à
  l'instant de l'envoi et ne vit qu'en mémoire.
- **Succès** = HTTP **2xx**. Tout le reste est un échec, retenté au prochain rappel.
- **Timeout** de 10 s par défaut : pas de requête fantôme qui retiendrait une remise.
- **`http://` est accepté à dessein** (services internes sur le LAN) : la confidentialité du trajet
  relève du déploiement.
- 🚨 **Aucune fuite dans les erreurs** : un échec ne cite que le **statut HTTP et l'hôte** — jamais
  l'URL complète (un chemin de webhook peut porter un secret), jamais le jeton, jamais le corps de la
  réponse. Ne cherchez donc pas l'URL fautive dans les logs : c'est délibéré.

---

# Partie B — Certificats (PKI interne)

La PKI est **zéro-connaissance** : les clés privées sont chiffrées **dans le navigateur** par une
**phrase maître** que le serveur ne connaît jamais. Elle **ne dépend pas** de
`DCMANAGER_SECRETS_KEY`.

> ⚠ **Contexte sécurisé requis.** La cryptographie du navigateur (`crypto.subtle`) est désactivée
> hors contexte sécurisé : pour initialiser ou déverrouiller la PKI, l'application doit être servie en
> **HTTPS** (cf. [`reverse-proxy.md`](reverse-proxy.md)) ou via `http://localhost`. La liste des
> certificats et leurs échéances restent consultables sans cela.

## B.1 Déployer la confiance (magasins clients)

Produire un certificat ne suffit pas : pour qu'une machine, un navigateur ou un service **valide** les
certificats signés par une autorité interne, il faut installer cette autorité dans son **magasin de
confiance**.

**Ce document est la référence.** L'application offre, sur chaque autorité, une action **« Déployer la
confiance… »** qui ouvre les mêmes procédures avec les commandes **pré-remplies** du nom de l'autorité
et un bouton « Copier » par bloc — c'est un pense-bête, disponible même verrouillé.

> **On ne déploie QUE le PUBLIC.** Seul le **certificat public** de l'autorité se déploie (export
> « Certificat public » → `cert.pem`, renommable en `.crt`). La **clé privée** de la CA ne quitte
> jamais la PKI — ne l'installez sur aucun client. Rappel du partage des rôles : un serveur TLS
> présente sa **feuille** (et, s'il y a des intermédiaires, la **fullchain SANS la racine**) ; la
> **racine**, elle, vit dans le magasin de confiance des **clients**.

### CA racine X.509 — magasins de confiance

Dans ce qui suit, `<FICHIER>` = le certificat public de la racine, renommé avec l'extension `.crt`
(ex. `CA Racine interne.crt`).

**Linux.** Le fichier doit porter l'extension `.crt` (contenu PEM accepté).

- Debian / Ubuntu :
  ```
  sudo cp <FICHIER> /usr/local/share/ca-certificates/
  sudo update-ca-certificates
  ```
- RHEL / Fedora / CentOS :
  ```
  sudo cp <FICHIER> /etc/pki/ca-trust/source/anchors/
  sudo update-ca-trust
  ```
- Vérifier une feuille signée par la racine :
  ```
  openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt feuille.pem
  ```

*Caveats Linux* — magasins qui **ne lisent pas** le magasin système :

- **Firefox** (et applications NSS) ont leur propre magasin : importer la racine dans Paramètres →
  Vie privée et sécurité → Certificats → Autorités, ou activer
  `security.enterprise_roots.enabled` (`about:config`) pour qu'il lise le magasin système.
- **Java (JVM)** : `keytool -importcert -cacerts -alias <alias> -file <FICHIER>`.
- **Node.js** : `NODE_EXTRA_CA_CERTS=/chemin/vers/<FICHIER>` (variable d'environnement).
- **Python (requests)** : `REQUESTS_CA_BUNDLE=/chemin/vers/<FICHIER>` (ou `verify=…`).

**Windows.** En **administrateur**, dans le magasin de la **machine** (« Ordinateur local » →
« Autorités de certification racines de confiance ») :

- Invite de commandes (admin) : `certutil -addstore -f Root <FICHIER>`
- PowerShell (admin) : `Import-Certificate -FilePath <FICHIER> -CertStoreLocation Cert:\LocalMachine\Root`

> **Extension `.pem` vs `.crt`** : `certutil` accepte le `.pem` exporté **tel quel** (inutile de
> renommer). Seuls `Import-Certificate` (PowerShell) et l'installation par **double-clic** exigent
> l'extension `.crt` — renommez alors le `.pem` en `.crt` (contenu identique).

- Interface graphique : double-cliquer le fichier → « Installer un certificat » → « Ordinateur
  local » → placer **explicitement** dans le magasin « Autorités de certification racines de
  confiance » (ne pas laisser la sélection automatique).
- Parc en domaine : déployer par **GPO** (Configuration ordinateur → Stratégies → Paramètres Windows
  → Paramètres de sécurité → Stratégies de clé publique → Autorités de certification racines de
  confiance).
- **Firefox** : même remarque que sous Linux (magasin NSS propre).

**Android.** Installation **manuelle** : Paramètres → Sécurité → Chiffrement et identifiants →
Installer un certificat → Certificat CA (puis choisir le fichier).

- Android 11+ : ce passage est **manuel** (obligatoire) et un avertissement s'affiche — le confirmer.
- Un bandeau « le réseau peut être surveillé » apparaît ensuite : c'est **normal** pour une CA
  installée par l'utilisateur.
- ⚠ Depuis **Android 7**, les **applications tierces** ne font confiance qu'aux CA du magasin
  **système** : une CA « utilisateur » est reconnue par Chrome et les navigateurs, mais **pas** par
  les applications — sauf opt-in explicite (`networkSecurityConfig`).
- Parc géré : déployer la CA via une solution **MDM** (Android Enterprise).

### CA SSH — confiance déclarée à la main

Une CA SSH n'a pas de magasin système : la confiance se déclare différemment pour les certificats
**utilisateur** et **hôte**. On ne publie que la **clé publique** de la CA ; sa clé privée ne quitte
jamais la PKI.

- **Serveurs** — accepter les certificats **UTILISATEUR** signés : déposer la clé publique de la CA
  (ex. `/etc/ssh/ca.pub`), la déclarer dans `sshd_config`, puis recharger :
  ```
  TrustedUserCAKeys /etc/ssh/ca.pub
  ```
  (`sudo systemctl reload sshd`).
- **Clients** — accepter les certificats **HÔTE** signés : ajouter une ligne `@cert-authority` dans un
  `known_hosts` (global `/etc/ssh/ssh_known_hosts` ou personnel `~/.ssh/known_hosts`) :
  ```
  @cert-authority *.exemple.lan <clé publique de la CA>
  ```

## B.2 Changer la phrase maître

Bouton **« Changer la phrase maître… »** de l'en-tête de la page Certificats (session déverrouillée
requise) → modale demandant la phrase actuelle et la nouvelle deux fois.

L'opération est **instantanée quel que soit le volume** : les certificats ne sont pas re-chiffrés,
seule la clé interne est ré-emballée sous la nouvelle phrase. Conséquences pratiques :

- la **phrase actuelle est re-vérifiée** au passage : une erreur donne « Phrase actuelle incorrecte »
  et rien n'est écrit ;
- la **session reste ouverte** ; les prochains déverrouillages utilisent la nouvelle phrase, et
  l'ancienne ne déverrouille plus ;
- deux changements **concurrents** ne peuvent pas se perdre silencieusement : le second reçoit un
  **409** et l'interface propose de réessayer ;
- l'enveloppe précédente est **archivée**. Un changement accidentel ou hostile ne détruit donc rien
  d'irrécupérable : restaurer une enveloppe archivée rend le coffre déchiffrable **avec la phrase de
  l'époque** — procédure SQL dans [`exploitation.md`](exploitation.md) § 5.

> **Ré-initialiser n'est pas changer de phrase.** Ré-initialiser une PKI déjà en service est
> **refusé** (409) : cela tirerait une nouvelle clé interne et perdrait toutes les clés privées
> existantes.

## B.3 Renouvellement de masse

Trois opérations, selon ce qui expire.

- **Une feuille TLS ou un certificat SSH** — le formulaire d'émission se rouvre **pré-rempli à
  l'identique** (CN, O, OU, SAN, usage, algorithme, durée). L'ancien est **révoqué** au motif
  *superseded*, le neuf porte la trace de sa lignée.
- **Plusieurs feuilles TLS d'un coup** — sélectionner les feuilles actives, puis « Renouveler » : la
  modale ne demande que la **durée**, appliquée à toutes. Réservé aux feuilles **TLS** : un certificat
  SSH se renouvelle à l'unité.
- **Une autorité (racine ou intermédiaire)** — deux mécaniques, à choisir en connaissance de cause :

  | Mécanique | Effet sur les clients | Quand |
  |---|---|---|
  | **Prolonger (même clé)** | **rien à redéployer** : l'identité de clé est inchangée, tous les certificats déjà émis continuent de chaîner | échéance qui approche, sans compromission |
  | **Rotation de clé** | nouvelle autorité à **déployer dans les magasins de confiance** (§ B.1) ; l'ancienne est révoquée, les feuilles actives et les sous-autorités sont ré-émises | compromission suspectée, ou politique de rotation |

  En rotation, un **certificat croisé** est produit : pendant la transition, un client qui fait
  **encore** confiance à l'ancienne racine valide déjà les nouvelles feuilles. Il s'exporte comme
  artefact « Certificat croisé (.cross.pem) » et se déploie sur les serveurs, le temps que les
  magasins clients soient mis à jour.

  ⚠ La durée d'une autorité intermédiaire est **plafonnée à l'échéance de son parent**.

## B.4 Suivi des échéances

Un veilleur serveur signale les certificats qui approchent de leur expiration, sous le type
d'événement **`cert-expiry`** (partie A) : gravité croissante aux seuils **30 / 14 / 7 jours**,
alerte close automatiquement au renouvellement, à la révocation ou à la suppression. Créer un
abonnement sur ce type pour être averti hors de l'application.
