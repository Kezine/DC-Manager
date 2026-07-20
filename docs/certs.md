# Certificats — PKI interne zéro-connaissance

Feature **AMOVIBLE** : une petite **PKI par document** pour gérer, DANS l'application,
les autorités et certificats internes d'une infrastructure — CA racines X.509, feuilles
TLS signées, CA et paires SSH, certificats SSH signés — avec exports prêts à déployer
(PEM, fullchain, PKCS#12, formats OpenSSH). Exigence fondatrice (cadrage
2026-07-14) : **zéro-connaissance**. Toute la cryptographie vit dans le NAVIGATEUR ;
le serveur ne stocke que des **métadonnées lisibles** (sujets, échéances, empreintes)
et des **blobs opaques** (clés privées déjà chiffrées) qu'il est **incapable de
déchiffrer**. Deuxième exigence : **découplage maximal** (supprimable sans cicatrice,
pattern `vm/` et `notify/`).

> **Zéro-connaissance, littéralement.** Les clés privées générées sont chiffrées côté
> client (AES-GCM) AVANT l'envoi ; le serveur reçoit un blob `key_enc` qu'il range et
> rend tel quel, sans jamais l'ouvrir. La clé qui les chiffre (la **DEK**, cf.
> « Chiffrement en enveloppe » ci-dessous) est elle-même scellée par une clé dérivée de
> la phrase secrète **par PBKDF2 dans le navigateur** ; ni la phrase, ni la DEK, ni la
> clé qui la scelle ne quittent jamais le poste. Conséquence assumée : **phrase secrète
> perdue = clés privées perdues** — aucune récupération, ni par nous ni par le serveur.
> C'est le but.

> **Mode API uniquement.** La PKI vit dans le serveur (base + timer d'échéances). En
> mode fichier/viewer elle est **sans objet** : la page « Certificats » affiche
> « mode API requis » et n'appelle jamais le réseau (parité `NotificationsAdminView`/
> `VmClustersView`).

## Vue d'ensemble

```
        NAVIGATEUR (toute la crypto)                 SERVEUR certs/ (amovible)
  ┌────────────────────────────────────┐      ┌──────────────────────────────────┐
  │ phrase secrète maître               │      │  CertsModule (routes + timer)     │
  │   └─ PBKDF2-SHA-256 (≥ 600 000)     │      │   ├─ CertsDb (certs.db)           │
  │        sel PAR document → KEK       │      │   │    pki_documents (wrapped_dek)│
  │   └─ KEK ──emballe──► wrapped_dek   │      │   │    certificates (+ key_enc)   │
  │            (AES-256-GCM)            │      │   │    certificate_sans           │
  │        wrapped_dek ──► DEK aléatoire│      │   └─ CertExpiryWatcher (30/14/7 j)│
  │              (NON extractible)      │ REST │                                   │
  │ X509Factory / OpenSshEncoder →      │─────►│  MÉTADONNÉES lisibles (sujet,     │
  │   clé privée EN CLAIR (le temps     │ JSON │  échéance, empreinte…)            │
  │   de la génération)                 │      │  + blobs OPAQUES (key_enc,        │
  │   └─ AES-GCM(DEK) → key_enc ────────┼─────►│    wrapped_dek) — jamais ouverts  │
  │                                     │      │            │ pont index.ts        │
  │ CertExports → PEM / PKCS#12 / SSH   │      │            ▼ (structurel)         │
  └────────────────────────────────────┘      │   NotifyModule (cert-expiry)      │
       onglet principal « Certificats »        └──────────────────────────────────┘
```

Cycle de vie d'un certificat :
1. l'utilisateur **déverrouille** la PKI du document (saisit la phrase secrète →
   dérivation PBKDF2 de la **KEK** → **déballage de la DEK** depuis `wrapped_dek` ;
   l'unwrap AES-GCM étant authentifié, il valide du même coup la phrase — cf. keycheck) ;
2. il **crée** une CA ou **émet** un dérivé : les clés naissent dans WebCrypto, la clé
   privée est chiffrée AUSSITÔT par la **DEK**, et seuls le **certificat public**
   (+ métadonnées) et le **blob `key_enc`** partent au serveur ;
3. il **exporte** un artefact : le serveur renvoie le blob au **GET unitaire**, le
   navigateur le déchiffre LOCALEMENT et fabrique le fichier (PEM/PKCS#12/OpenSSH) ;
4. le serveur **surveille les échéances** sur les seules métadonnées (`not_after`) et
   signale les certificats qui approchent de l'expiration au service de notifications.

Le serveur ne participe à AUCUNE opération cryptographique : il n'a ni clé
d'environnement, ni `SecretBox` (contrairement à `vm/`/`notify/` : ici il n'y a
**rien à chiffrer côté serveur**, tout arrive déjà chiffré).

## Modèle cryptographique

Toute la crypto est dans `src-client/certs/` (modules PURS : WebCrypto seul, ni DOM
ni réseau — testables headless sous Node ≥ 18, cf. `Tests/modules/test-certs.js`).

### Chiffrement en enveloppe — KEK / DEK (décision « changement de phrase », `PkiCrypto`)

Deux clés, deux rôles — c'est ce qui rend le **changement de phrase maître** peu coûteux
(cf. « Changer la phrase maître » dans « Procédures ») :

```
  phrase ──PBKDF2-SHA-256(sel)──► KEK ──AES-GCM──► wrapped_dek   (UN petit blob stocké)
                                                       │  déchiffre
                                                       ▼
                    DEK (32 octets ALÉATOIRES, FIXE À VIE) ──AES-GCM──► key_enc
```

- La **DEK** (*Data Encryption Key*) chiffre RÉELLEMENT toutes les clés privées ; tirée
  **aléatoirement une fois** à l'initialisation, elle **ne change jamais**. Les `key_enc`
  lui sont donc liés pour toute la vie du document.
- La **KEK** (*Key Encryption Key*) est dérivée de la phrase par **PBKDF2-SHA-256**,
  **≥ 600 000 itérations** (défaut `DEFAULT_ITERS = 600000` ; le serveur REFUSE un
  `kdf_iters` inférieur), **sel aléatoire de 16 octets PAR document** (`kdf_salt`, base64 ;
  même phrase + autre sel = autre KEK, ce qui **compartimente** les PKI). Son SEUL travail
  est d'emballer/déballer la DEK dans `wrapped_dek`.
- **Extractibilité** (durcie suite à l'audit 2026-07-17) : l'enveloppe passe par
  `crypto.subtle.wrapKey`/`unwrapKey` — les octets de la DEK **ne touchent JAMAIS la mémoire
  JS**. Le déverrouillage produit une DEK de session **NON extractible** : même sous page
  compromise (XSS), la clé maître peut être *utilisée* pendant la session mais **pas
  exfiltrée** — strictement la garantie qu'offrait l'ancienne clé dérivée directe. Seuls
  l'initialisation et le ré-emballage manipulent un handle extractible TRANSITOIRE
  (exigence de `wrapKey`), jamais exporté vers JS.
- **Schéma VERSIONNÉ** : `kdf_version = "v1"` (colonne en base + préfixe des blobs
  `v1:<iv>:<ct>`). Le versionnage est là POUR une rotation future de KDF/algo.

### keycheck — la vérification, portée par `wrapped_dek`

Il n'y a **pas de constante-témoin séparée** : c'est le déballage de la DEK qui vérifie la
phrase. Au déverrouillage, le client dérive la KEK depuis la phrase saisie et tente de
**déchiffrer `wrapped_dek`** (unwrap de la DEK). Le déchiffrement AES-GCM étant
**AUTHENTIFIÉ**, une phrase fausse produit une KEK fausse et l'unwrap **échoue** : la
phrase est donc validée exactement quand la DEK est déballable. La détection est
**IMMÉDIATE et locale** — le serveur n'y participe pas et ne sait pas si une phrase est
correcte. Tout échec (mauvaise phrase, blob altéré, format inconnu) donne la MÊME réponse
UI neutre (« clé maître incorrecte »), sans divulguer de détail.

### Session (décision Q2, `PkiSession`)

La **DEK** (déballée au déverrouillage) vit dans un **coffre de session en MÉMOIRE** :
- **verrouillage auto après 15 min d'INACTIVITÉ** (chaque action de la page appelle
  `touch()` pour ré-armer le compte à rebours) ;
- bouton **« Verrouiller »** = verrouillage manuel immédiat ;
- **meurt avec l'onglet** : la clé n'est JAMAIS persistée (ni storage, ni cookie, ni
  IndexedDB). Fermer l'onglet suffit à tout oublier.

Timers INJECTÉS (testable headless). `onLock` prévient l'UI (retour à l'écran
verrouillé) quelle que soit la cause (auto ou manuel).

#### Ce que le verrou gouverne — et ce qu'il ne gouverne pas

Le déverrouillage n'est **pas** une autorisation : c'est la **disponibilité de la clé maître**.
N'exigent donc le déverrouillage que les opérations qui **ont besoin de la clé** :

| Opération | Verrouillé | Pourquoi |
|---|---|---|
| Consulter la liste, les échéances | ✅ | métadonnées, jamais chiffrées |
| Exporter les artefacts **publics** | ✅ | rien à déchiffrer |
| **Révoquer** | ✅ | pose `revoked_at` — **métadonnée** |
| **Supprimer** | ✅ | efface des lignes + un blob **opaque** |
| Initialiser la PKI, **créer une CA** | ❌ | génère et chiffre une clé privée |
| **Émettre** (feuille TLS, certificat SSH) | ❌ | **signer** exige la clé privée de l'émetteur |
| Exporter **avec la clé privée** | ❌ | il faut déchiffrer `key_enc` |

Révoquer et supprimer restent donc offerts **coffre verrouillé** : c'est ce qui rend une PKI
dont la phrase est perdue **consultable ET purgeable** (cf. « Limites assumées »). Les en
exclure aurait transformé une phrase oubliée en **impasse définitive** — un coffre qu'on ne
peut ni ouvrir ni vider.

Le verrou n'est pas non plus une frontière de sécurité pour la suppression : il est **local**,
le serveur ne peut pas le connaître (zéro-connaissance). Ce qui protège réellement le `DELETE`,
c'est l'**authentification** (SSO / Basic Auth) — plus l'exigence d'**intention explicite**
décrite dans « Garde-fous de suppression ».

### Chiffrement des clés privées

Chaque clé privée (PKCS#8 PEM pour X.509, graine ed25519 pour SSH) est chiffrée en
**AES-256-GCM** par la **DEK**, IV aléatoire de 12 octets (jamais réutilisé), format
stocké `v1:<iv>:<ct>` en base64 (le tag GCM est inclus dans `<ct>` par WebCrypto). Deux
chiffrements du même clair diffèrent (IV aléatoire). Même philosophie que le `SecretBox`
serveur (cf. [`vm-proxmox.md`](vm-proxmox.md)), mais **côté client, avec la clé de
l'utilisateur**. `wrapped_dek` emploie EXACTEMENT le même format `v1:<iv>:<ct>` (autre
clé : la KEK) — un déchiffrement avec la mauvaise clé échoue simplement (GCM), sans
ambiguïté.

### Extractibilité — un choix délibéré et asymétrique

- La **DEK** (et la **KEK**) sont **NON extractibles** : elles servent uniquement à
  chiffrer/déchiffrer, jamais à être lues. Les 32 octets bruts de la DEK n'apparaissent en
  mémoire JS qu'à l'init/au déverrouillage/au re-chiffrement, effacés aussitôt.
- Les **clés générées** (CA, feuilles, paires SSH) sont créées **extractibles** — il
  FAUT pouvoir exporter la clé privée en PKCS#8 pour la chiffrer, puis la ré-exporter à
  la demande de l'utilisateur. Elles n'existent en clair que **le temps de la
  génération/de l'export** (session déverrouillée), puis sont scellées par la DEK.

## Limites assumées (cadrage §2)

Ces limites sont des **conséquences voulues** du modèle zéro-connaissance, pas des
manques à combler :

- **Clé maître perdue = clés privées perdues.** Aucune récupération : c'est le sens même
  d'un chiffrement dont le serveur ne détient pas la clé. Les certificats **publics** et
  les métadonnées, eux, restent lisibles (une PKI dont on a perdu la phrase peut encore
  être consultée et purgée, mais plus rien n'y est déchiffrable).
- **Le serveur ne peut PAS renouveler seul.** Renouveler ou ré-émettre exige la clé
  privée de la CA → la **page déverrouillée**. Aucun renouvellement automatique côté
  serveur (il n'a pas les clés). Le serveur se contente de **surveiller** les échéances.
- **Pas de CRL/OCSP — la révocation est un SUIVI simple** (décision Q4) : un certificat
  révoqué porte un `revoked_at`, est **exclu des exports** (garde-fou dans `CertExports`
  ET l'UI grise le bouton) et son alerte d'échéance est close. Il n'y a ni liste de
  révocation publiée, ni répondeur OCSP : la PKI est **interne**, la révocation
  s'applique par le **non-déploiement** (on ne réexporte plus l'objet).
- **Ré-initialisation refusée (409) — mais changement de phrase POSSIBLE.** Une PKI déjà
  initialisée ne peut pas être **ré-initialisée** (`PUT /pki` → 409) : cela tirerait une
  NOUVELLE DEK aléatoire et rendrait indéchiffrables toutes les clés déjà stockées. En
  revanche **changer la phrase maître** est offert (`PUT /pki/rekey`) : il **conserve la
  DEK** et ne ré-emballe que `wrapped_dek` — aucun `key_enc` n'est touché (cf. « Changer la
  phrase maître » dans « Procédures »). Deux gestes à ne pas confondre : l'un remplace la
  clé des données (interdit), l'autre remplace seulement ce qui la protège (permis).
- **CA de signature SSH ed25519 uniquement** (`OpenSshEncoder`, décision Q3) : la
  signature déterministe d'ed25519 est ce qui rend la validation croisée byte-à-byte
  possible. Les paires RSA restent supportées comme **clés simples** et comme **sujets**
  de certificat ; une CA SSH RSA (rsa-sha2) viendra si le besoin apparaît.
- **CONTEXTE SÉCURISÉ requis (HTTPS ou localhost).** Les navigateurs ne fournissent
  `crypto.subtle` (WebCrypto) que dans un contexte sécurisé — servie en HTTP simple sur
  un hôte de LAN, TOUTE la crypto de la page (dérivation, chiffrement, signatures) est
  indisponible. La page le détecte (`PkiCrypto.available()`) et affiche un bandeau
  actionnable ; la consultation des métadonnées/échéances, elle, reste possible.
  Déploiement : servir l'app derrière un proxy TLS (cf.
  [`reverse-proxy.md`](reverse-proxy.md)) ou y accéder via `http://localhost`.

## Architecture — qui fait quoi

### Serveur (`src-server/src/certs/` — le cœur n'importe JAMAIS ce dossier)

| Fichier | Rôle |
|---|---|
| `CertsValidate.ts` | **Validation PURE** (ni DB ni réseau), griefs GROUPÉS, messages français uniques (mêmes principes que `NotifyValidate`/`ProviderConfigValidate`). Ne valide que des **métadonnées** et **borne** la taille des blobs OPAQUES (`key_enc`, `wrapped_dek` jamais déchiffrés). Porte les tables `CERT_KINDS` (`root-ca`/`leaf-tls`/`ssh-ca`/`ssh-keypair`/`ssh-cert`), `KEY_ALGOS`, `SAN_TYPES` et l'invariant émetteur (une racine n'a pas de `parent_id`, un dérivé en exige un). |
| `CertsDb.ts` | **Persistance SQLite dédiée** (`certs.db`, à côté de `registry.db`), possédée par le module (jamais une table de `registry.db`). **3 tables** (cf. « Schéma »). CRUD métadonnées + blobs, garde-fous de suppression (`childrenOf`), `listExpiring` pour le veilleur. **Listing PAGINÉ SQL** (`listPage`/`listRoots` — LIMIT/OFFSET, jamais de chargement complet) : filtres query/kinds/status, tris stables, portée **sous-arbre** et agrégats racines par **CTE récursive**, paramètre `focus` (page contenant un élément via `ROW_NUMBER`), colonne **`search`** dénormalisée (migration + backfill). Porte l'**invariant Q5** par des DTO distincts : `CertificateListItem` (SANS `key_enc`) / `CertificateDetail` (AVEC). Driver SQLite **injecté**. **Pas de `SecretBox`** : rien à chiffrer côté serveur. |
| `CertExpiryWatcher.ts` | **Veilleur d'échéances** (producteur `cert-expiry`, C7) : balaye les métadonnées `not_after`, `raise` les certificats sous seuil (gravité croissante 30/14/7 j), `resolve` ceux qui repassent au vert ou disparaissent. Déclare **chez lui** l'interface `CertProblemReporter` (dépendance INVERSÉE, pattern `VmSyncService`) — `certs/` n'importe RIEN de `notify/`. Horloge et seuils injectables (tests). |
| `CertsModule.ts` | **Façade et POINT DE BRANCHEMENT UNIQUE** (amovible, pattern `VmModule`/`NotifyModule`) : assemble `certs.db` + routes REST (`ApiExtension`) + timer horaire d'échéances. Module « en erreur » (certs.db illisible) → routes **503** détaillé sans faire tomber le serveur. Rapporteur de problèmes **OPTIONNEL** (sans lui, le module vit normalement, sans notifications). |

**Branchement au cœur** : point d'extension GÉNÉRIQUE `ApiExtension` (`api.ts`, le même
que `vm/`/`notify/`) ; le câblage concret tient en quelques lignes dans `index.ts`
(création du module, **pont** `problems` vers `notify/`, montage de l'extension,
`start`/`stop`). Le `CertsModule` réutilise le pont `notify` déjà construit pour `vm/`
(typage STRUCTUREL — les trois features restent amovibles indépendamment).

### Client (`src-client/certs/` — crypto PURE, aucune dépendance du cœur front)

| Fichier | Rôle |
|---|---|
| `PkiCrypto.ts` | **Enveloppe KEK/DEK** : dérivation KEK (PBKDF2-SHA-256), `initDek`/`unwrapDek` (emballage/déballage de la DEK — l'unwrap fait office de keycheck), `rewrapDek` (changement de phrase), chiffrement AES-GCM `v1:<iv>:<ct>` des clés privées. WebCrypto seul. Porte `KDF_VERSION`/`DEFAULT_ITERS`. |
| `PkiSession.ts` | **Coffre de session** de la **DEK** (clé de chiffrement des données, déballée au déverrouillage) : verrouillage auto (15 min d'inactivité), `touch`/`lock`, `onLock` → re-render. Clé en MÉMOIRE seule. Timers injectés. |
| `X509Factory.ts` | **Fabrique X.509** via `@peculiar/x509` : CA racines auto-signées + feuilles signées (extensions, EKU par usage, SKI/AKI, tolérance d'horloge). Produit la clé privée EN CLAIR le temps de la génération (l'appelant la chiffre aussitôt). |
| `SshWire.ts` | **Primitives d'encodage « wire » SSH** (RFC 4251 §5) : uint32/uint64, string, mpint (règle du zéro de tête), base64. Brique de bas niveau des encodeurs OpenSSH. |
| `OpenSshEncoder.ts` | **Encodeur OpenSSH MAISON** (décision Q3) : ligne `authorized_keys`, fichier privé `openssh-key-v1` (non chiffré), **certificat SSH signé** ed25519. Champs aléatoires (nonce/checkint) INJECTABLES → **validation croisée byte-identique ssh-keygen**. |
| `SshKeyMaterial.ts` | **Interop WebCrypto ↔ OpenSSH** : extrait le matériau brut attendu par l'encodeur (graine ed25519 = 32 derniers octets du PKCS#8 RFC 8410, module/exposant RSA depuis le JWK), reconstruit une clé ed25519 « sign » depuis sa graine (pour signer un certificat). |
| `Pkcs12Kdf.ts` | **KDF de PKCS#12** (RFC 7292 §B.2, distinct de PBKDF2) — dérive la clé du **MAC** d'intégrité (encodage BMPString UTF-16BE). Maison car aucune lib navigateur ne l'expose ; **validé par fixture croisée openssl**. |
| `Pkcs12Builder.ts` | **Fabrique PKCS#12** (.p12/PFX moderne) via l'écosystème `@peculiar/asn1-*` + `asn1js` : chiffrement **PBES2 (PBKDF2-SHA-256 + AES-256-CBC)** du keyBag et des certBags, MAC HMAC-SHA-256. |
| `CertExports.ts` | **Exports** : assemble les artefacts téléchargeables (PEM, fullchain, ca-chain, clé privée, PKCS#12, OpenSSH) à partir de matériau DÉJÀ déchiffré. Résolution PURE de la **chaîne d'émission** par `parent_id` (garde-fous : émetteur introuvable, cycle). Refuse un objet **révoqué** (décision Q4). |
| `CertZip.ts` | **Emballage ZIP** des exports : `bundleFor` compose le BUNDLE d'un certificat selon son kind (RÉUTILISE `CertExports`), FILTRABLE par catégories cochées (public/fullchain/ca-chain/key — cf. dialogue groupé) ; `resolveEntries` calcule l'arborescence dossier/fichier (noms ASSAINIS + DÉDUPLIQUÉS -2/-3…), partagée par les DEUX emballages : `zipArtifacts` (**fflate** `zipSync` STORE, ZIP en clair) et `zipArtifactsEncrypted` (**@zip.js/zip.js**, ZIP AES-256 / WinZip AE-2 protégé par mot de passe, `useWebWorkers: false` car bundle monolithique). Sert l'export unitaire « Tout (ZIP) » ET les exports groupés. Module PUR (WebCrypto pour la graine SSH). Refuse un révoqué (garde-fou partagé). Le mot de passe ne sert QU'À dériver la clé AES — jamais stocké ni journalisé. |
| `BulkActions.ts` | Logique **PURE** des opérations groupées : INTERSECTION des actions communes à une sélection (selon snapshots + état de session, parité STRICTE avec les actions par ligne), **partition d'export** (retenus / exclus-révoqués) et **`exportChoices`** (catégories d'artefacts COMMUNES à la sélection : `public` toujours, `fullchain`/`ca-chain` si tous leaf-tls, `key` si déverrouillé + tous `has_key` — calculées sur les NON-révoqués). Testée en isolation. |
| `core/CertsFormat.ts` | Logique **PURE** de la page (aucun DOM) : jours restants + classe de couleur d'échéance, libellés des `kind`, **libellé de l'émetteur** résolu depuis les items d'une page (colonne « Émetteur » de la vue B ; repli sur l'id court) + `shortId`. Testée dans `Tests/modules`. |
| `core/CertsSearch.ts` | Logique **PURE** de la recherche (L3) : mapping d'un item serveur en résultat de popover (`tag` = famille lisible) et **décision de navigation** au clic (premier niveau → vue A ; dérivé → vue B scopée sur `root_id` ; focus). Alimente `ui/SearchPop`. Testée dans `Tests/modules`. |
| `core/CertDeployGuide.ts` | Logique **PURE** de l'**aide au déploiement** de la confiance (aucun DOM) : structure déclarative (intro + sections + blocs de commande PRÉ-REMPLIS) pour un CA racine X.509 (Linux/Windows/Android + caveats) ou une CA SSH (serveurs/clients). Alimente la modale « Déployer la confiance… » ; la doc en est la référence. Testée dans `Tests/modules`. |
| `ui/Clipboard.ts` | Primitive **GÉNÉRIQUE** (hors feature certs) : copie presse-papiers (API `navigator.clipboard`, repli `<textarea>`+`execCommand` hors contexte sécurisé) + toast de retour. RESTE si la feature est retirée. |
| `views/CertsAdminView.ts` | **Page « Certificats »** (onglet PRINCIPAL), classe DÉDIÉE et AUTONOME (ne dérive PAS de `Forms`, pattern `NotificationsAdminView`) : écran verrouillé/déverrouillé, **deux listings paginés serveur** (autorités / certificats d'une racine), créations/émissions/exports/révocation/suppression, **aide au déploiement** (modale « Déployer la confiance… », consultation pure via `CertDeployGuide` + `Clipboard`). Toute la crypto vit ICI ; les formulaires s'ouvrent dans LA modale de l'app (principe n°11). |
| `views/forms/CertsClient.ts` | **Client REST** du module `certs/` + `CertsError` (code HTTP + `detail`). DTOs = **MIROIRS** commentés des formes serveur (duplication assumée, principe n°3 — préserve l'amovibilité). `listPage`/`listRoots` (pagination serveur ; `buildQuery` PURE, `kind` répétable), `list` conservée pour la résolution des chaînes d'export. ⚠ Routes **SCOPÉES PAR DOCUMENT** (`<dataBase>/certs/…`, comme `VmSyncClient`, PAS globales comme `NotifyClient`). |

## Schéma de `certs.db`

Base SQLite **dédiée au module** (`certs.db`, à côté de `registry.db` dans le dossier
injecté), POSSÉDÉE par `certs/` : jamais une table de `registry.db` (le cœur ne connaît
rien de la feature ; supprimer la feature = supprimer le module + ce fichier).
`PRAGMA foreign_keys = ON` à chaque connexion (la FK composite parent et le
`ON DELETE CASCADE` des SAN en dépendent), WAL + `busy_timeout` (parité `DocumentStore`).

**Aucun secret exploitable ici** : `key_enc`/`wrapped_dek` arrivent DÉJÀ chiffrés côté
client ; le serveur ne stocke que des métadonnées lisibles et ces blobs opaques.

- **`pki_documents`** — paramètres de dérivation de la KEK + enveloppe de la DEK **PAR
  document** : `doc_id` (PK), `kdf_version`, `kdf_salt`, `kdf_iters`, `wrapped_dek` (la DEK
  chiffrée par la KEK côté client — sert AUSSI de keycheck). Le serveur ne fait que
  **STOCKER** — il ne dérive ni ne déballe jamais. Le **changement de phrase** ne réécrit
  que cette ligne (`kdf_salt`/`kdf_iters`/`wrapped_dek`), sans toucher aux `certificates`.
- **`pki_envelope_history`** — **archive append-only** des enveloppes remplacées par un
  changement de phrase : `doc_id`, `archived_date`, `kdf_version`, `kdf_salt`, `kdf_iters`,
  `wrapped_dek`. Filet de récupération (audit 2026-07-17) : **toute enveloppe passée emballe
  la MÊME DEK** — n'importe quelle ligne restaurée à la main rend le coffre déchiffrable avec
  la phrase de l'époque (cf. « Procédures »). Jamais purgée (quelques centaines d'octets par
  changement de phrase — événement rarissime).
- **`certificates`** — métadonnées + matériau : `id` + `doc_id` (**PK composite**),
  `kind`, `parent_id` (émetteur), `label`, `subject`, `serial`, `not_before`,
  `not_after`, `fingerprint`, `key_algo`, `public_pem` (PUBLIC par nature),
  `key_enc` (**clé privée chiffrée client** — blob opaque), `revoked_at`,
  `created_date`/`updated_date`, **`created_by`/`updated_by`** (id canonique de l'auteur —
  audit posé SERVEUR sur création/renouvellement/révocation, migration `ensureColumn` ; cf.
  [`user-resolver.md`](user-resolver.md)), **`search`** (colonne DÉNORMALISÉE `TEXT NOT NULL
  DEFAULT ''` = `normSearch(label + subject + serial + valeurs de SAN)`, recalculée
  à CHAQUE save avec la MÊME normalisation partagée que le cœur ; migration
  `ensureColumn` + **backfill** one-shot des lignes antérieures). **FK composite**
  `(doc_id, parent_id) → certificates(doc_id, id)` : l'émetteur d'un dérivé doit
  exister dans LE MÊME document. Index : `not_after` (balayage d'échéances),
  `(doc_id, search)` (filtre `query` — LIKE), `(doc_id, parent_id)` (remontée d'arbre).
- **`certificate_sans`** — SAN en **table ORDONNÉE** (jamais de JSON en DB) :
  `doc_id`, `cert_id`, `position` (**PK composite**), `san_type` (`dns`/`ip`/`email`/
  `principal`), `value`. **FK `ON DELETE CASCADE`** vers `certificates` (supprimer un
  certificat purge ses SAN). L'ordre du tableau fait foi (`position` = index).

### Garde-fous de suppression — `?force=true` (intention explicite)

Le verrou étant **local** (le serveur ne peut pas le connaître), il ne peut rien garder. En
revanche « ce certificat est-il **ENCORE VALIDE** ? » se répond avec `revoked_at` + `not_after` :
des **métadonnées que le serveur détient en clair**. C'est donc une garde qu'il peut réellement
appliquer — et il le fait.

**ACTIF** ⇔ `revoked_at IS NULL` **ET** `not_after > now`.
`not_after` absent ou illisible ⇒ **ACTIF** : on protège plutôt que de supposer l'expiration (une
paire SSH sans échéance n'expire jamais — elle est donc toujours active).

`DELETE /certs/:id` — verdicts de `CertsDb.remove(docId, id, force)`, **dans cet ordre** :

| Verdict | HTTP | Quand |
|---|---|---|
| `missing` | 404 | inconnu |
| `children` | 409 `has_children` | des dérivés existent — **`force` ne le lève PAS** : c'est une contrainte d'**intégrité**, pas une question d'intention |
| `force_required` | **428** `force_required` | le certificat est **ENCORE VALIDE** et l'appel n'a pas posé `?force=true` |
| `ok` | 200 | supprimé (révoqué/expiré : aucune cérémonie ; actif : `force` fourni) |

> **428 et non 409** — le 409 signale déjà la descendance, et le client lui associe un message
> dédié (« des dérivés existent »). Réutiliser le même statut aurait affiché un motif **faux**.
> Le champ `code` (`has_children` / `force_required`) permet de discriminer sans se fier au statut.

**Côté UI** (`DeleteGuard`, logique pure), la cérémonie est **proportionnée au risque** — elle
n'autorise rien, elle matérialise l'intention que le serveur exigera :

| Cas | Confirmation |
|---|---|
| 1 certificat révoqué ou expiré | confirmation ordinaire |
| **1 certificat encore valide** | **recopier la phrase NOMMANT la cible** : « Oui je supprime `<label>` » |
| **plusieurs certificats** | saisir **« Oui je supprime »** (phrase de base + décompte des encore-valides) |

Comparaison : `trim()` puis égalité **stricte** — la casse compte, c'est le point de friction.
La phrase qui **nomme la cible** (`DeleteGuard.phraseFor(label)`, clé `certs.guard.phraseNamed` à
interpolation `{{label}}`) affirme l'intention et vise CE certificat sans ambiguïté ; l'invite affichée
et la référence de comparaison sortent de la **même source** — impossible de diverger. Un actif au
libellé vide bascule sur la phrase de base (une phrase nommée intapable bloquerait la purge). Le lot
exige la phrase **même sans aucun actif** : une sélection se fait d'un glissement de souris.

> **Recopie manuelle imposée** : le champ de saisie **bloque le collage** (`paste → preventDefault`).
> Coller la phrase (souvent récupérée du texte de l'invite juste au-dessus) réduirait la cérémonie à un
> Ctrl-V machinal — la friction voulue disparaîtrait.

> Il n'y a **pas de route bulk** (N appels unitaires) : `force` s'applique **par certificat**.
> `DeleteGuard.isActive` duplique `CertsDb.isActive` — duplication **assumée** (le front ne peut
> pas importer un module serveur) ; le serveur reste **seul juge**, l'UI ne fait qu'anticiper.

### Invariant Q5 — `key_enc` au GET unitaire seulement

La clé privée chiffrée (`key_enc`) **ne sort JAMAIS en liste** : `GET /certs` renvoie
`CertificateListItem` (métadonnées + SAN + `has_key: boolean`), **sans** `key_enc`.
Elle n'est incluse qu'au **GET unitaire** `GET /certs/:id` (`CertificateDetail`), quand
le client va la déchiffrer LOCALEMENT pour émettre un dérivé ou exporter. Garanti par
des **DTO distincts** dans `CertsDb`, pas par une omission ponctuelle.

Corollaire au **PUT** : `key_enc` **ABSENT** du corps = **CONSERVÉ** tel quel côté
serveur. Une mise à jour de métadonnées (ex. révocation) ne renvoie pas la clé — et
comme la liste ne la renvoie jamais, le client ne PEUT pas la rejouer par erreur. C'est
ce qui rend le flux zéro-connaissance sûr : révoquer, renommer, re-tagger un certificat
ne touche jamais au blob chiffré.

## Formats produits

### X.509 (`X509Factory`)

Via `@peculiar/x509` (choix utilisateur acté, principe n°11 : encoder soi-même de
l'ASN.1 DER / des extensions est un piège à bugs de sécurité). Algos émis :
**EC P-256**, **RSA 2048/4096** (RSASSA-PKCS1-v1_5 + SHA-256 pour la compat TLS
maximale ; exposant 65537). Numéro de série aléatoire 16 octets, garanti positif.
Fenêtre de validité **antidatée de 5 min** (tolérance d'horloge, piège classique des
PKI internes).

- **CA racine** (auto-signée) : `BasicConstraints CA=true` (CRITIQUE, `pathLen`
  libre), `KeyUsage keyCertSign | cRLSign` (CRITIQUE), `SubjectKeyIdentifier`.
- **Feuille** (signée par la CA) : `BasicConstraints CA=false` (CRITIQUE),
  `KeyUsage digitalSignature | keyEncipherment`, **`ExtendedKeyUsage` par usage**
  (`serverAuth`/`clientAuth`/les deux), `SubjectAlternativeName` (dns/ip/email),
  `SKI` + `AKI` pointant vers la clé de la CA (la chaîne se résout sans ambiguïté). La
  signature emploie l'algo de la **clé CA**, indépendant de l'algo de la feuille.

### OpenSSH (`OpenSshEncoder` + `SshWire`/`SshKeyMaterial`)

Encodeur **maison** (décision Q3 — aucune lib navigateur éprouvée pour ces formats
propres à OpenSSH, distincts de X.509). Trois formats :

- **Clé publique** `authorized_keys` : `ssh-ed25519 AAAA… commentaire` (et `ssh-rsa`
  pour les paires RSA simples).
- **Clé privée** `openssh-key-v1` NON chiffrée (`ciphername`/`kdfname` = `none` : la
  protection au repos est NOTRE AES-GCM ; produire ce fichier en clair est un geste
  d'export explicite). ⚠ **Piège de l'octet NUL** : le magic `openssh-key-v1` est suivi
  d'un `\0` de terminaison **construit en OCTETS**, jamais écrit brut dans un littéral
  (un NUL brut rend le fichier source binaire pour git — piège récurrent du dépôt).
- **Certificat SSH signé** `ssh-ed25519-cert-v01@openssh.com` : type user (5 extensions
  `permit-*` en ordre canonique) ou host (aucune), principaux, fenêtre de validité,
  signature ed25519 de la CA sur le TBS. CA de signature **ed25519 v1 uniquement**
  (signature déterministe).

**Validation byte-identique ssh-keygen** : ed25519 étant déterministe, mêmes entrées +
même nonce + même graine ⇒ sortie **au bit près** identique à `ssh-keygen`. Des fixtures
croisées (générées une fois avec des paramètres fixes) le vérifient dans
`Tests/modules/test-certs.js` — la garantie de sécurité la plus forte pour un encodeur
maison.

### Exports PEM / PKCS#12 (`CertExports` + `Pkcs12Builder`/`Pkcs12Kdf`)

- **PEM** : certificat public (`.pem`), clé privée (`.key.pem`), **fullchain**
  (`<label>.fullchain.pem` = feuille + émetteurs remontés par `parent_id` jusqu'à la
  racine), **ca-chain** (émetteurs sans la feuille). Chaîne résolue par une fonction
  PURE, garde-fous émetteur-introuvable et boucle-de-parent. Le **certificat public d'une
  racine** (`.pem`, renommable `.crt`) est ce qu'on DÉPLOIE chez les clients — cf.
  « Déployer la confiance (magasins clients) » ci-dessous.
- **PKCS#12** (`.p12`/PFX **moderne**) : **PBES2 = PBKDF2-SHA-256 (≥ 100 000 itérations)
  + AES-256-CBC** pour le keyBag ET les certBags ; intégrité **MAC HMAC-SHA-256** (clé
  dérivée par le KDF PKCS#12, `Pkcs12Kdf`). Les consommateurs 3DES/RC2 très anciens ne
  sont PAS visés. **Compatible OpenSSL ≥ 1.1 / 3.x, Windows 10+, navigateurs et outils
  modernes** — vérifié par **validation croisée openssl** (le MAC et le déchiffrement
  reproduits au bit près). ⚠ **Deux encodages de mot de passe** pour la MÊME passphrase
  (piège d'interop) : **UTF-8 brut** pour PBES2/PBKDF2, **BMPString (UTF-16BE +
  terminateur)** pour le MAC — confirmés empiriquement contre openssl.
- **OpenSSH** : selon la nature — paire/CA (clé privée `openssh-key-v1` + `.pub`),
  certificat SSH (`-cert.pub`).
- **ZIP** (`CertZip`) : emballage des artefacts ci-dessus — bundle d'un certificat (« Tout
  (ZIP) ») ou archive multi-certificats (un dossier par cert, noms assainis/DÉDUPLIQUÉS -2/-3…).
  Deux chemins partageant la MÊME arborescence : **en clair** (fflate `zipSync` STORE) et
  **chiffré par mot de passe** (@zip.js/zip.js, **AES-256** / WinZip AE-2 — ouvrable par
  **7-Zip/WinRAR**, PAS par l'explorateur Windows natif qui ignore l'AES ZIP). Compression
  accessoire (petits fichiers texte). PKCS#12 reste HORS bundle (unitaire, passphrase par cert).

**Révocation (décision Q4)** : un objet révoqué (`revoked_at` posé) est **EXCLU de tous
les exports** — garde-fou dans `CertExports` (message français explicite), en plus du
bouton grisé dans l'UI.

## Déployer la confiance (magasins clients)

Produire un certificat ne suffit pas : pour qu'une machine, un navigateur ou un service
**valide** les certificats signés par une autorité interne, il faut installer cette
autorité dans son **magasin de confiance**. La page « Certificats » offre, sur chaque
AUTORITÉ (racine X.509 ou CA SSH), une action **« Déployer la confiance… »** qui ouvre une
modale **de consultation** (disponible même verrouillé — aucune clé requise) : les mêmes
procédures que ci-dessous, avec les commandes **pré-remplies** du nom de l'autorité et un
bouton « Copier » par bloc. Le contenu pur (données des procédures) vit dans
`core/CertDeployGuide.ts` (testé) ; **cette section de doc est la RÉFÉRENCE**, la modale
n'en est que le pense-bête pré-rempli.

> **On ne déploie QUE le PUBLIC.** Seul le **certificat public** de l'autorité se déploie
> (export « Certificat public » → `cert.pem`, renommable en `.crt`). La **clé privée** de la
> CA ne quitte JAMAIS la PKI — ne l'installez sur aucun client. Rappel du partage des rôles :
> un serveur TLS présente sa **feuille** (et, s'il y a des intermédiaires, la **fullchain**
> SANS la racine) ; la **racine**, elle, vit dans le magasin de confiance des **clients**.

### CA racine X.509 — magasins de confiance

Dans ce qui suit, `<FICHIER>` = le certificat public de la racine, renommé avec l'extension
`.crt` (ex. `CA Racine interne.crt`).

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

*Caveats Linux* — magasins qui NE lisent PAS le magasin système :

- **Firefox** (et applications NSS) ont leur propre magasin : importer la racine dans
  Paramètres → Vie privée et sécurité → Certificats → Autorités, ou activer
  `security.enterprise_roots.enabled` (`about:config`) pour qu'il lise le magasin système.
- **Java (JVM)** : `keytool -importcert -cacerts -alias <alias> -file <FICHIER>`.
- **Node.js** : `NODE_EXTRA_CA_CERTS=/chemin/vers/<FICHIER>` (variable d'environnement).
- **Python (requests)** : `REQUESTS_CA_BUNDLE=/chemin/vers/<FICHIER>` (ou `verify=…`).

**Windows.** En **administrateur**, dans le magasin de la **machine** (« Ordinateur local »
→ « Autorités de certification racines de confiance ») :

- Invite de commandes (admin) : `certutil -addstore -f Root <FICHIER>`
- PowerShell (admin) : `Import-Certificate -FilePath <FICHIER> -CertStoreLocation Cert:\LocalMachine\Root`

> **Extension `.pem` vs `.crt`** : `certutil` accepte le `.pem` exporté **tel quel** (inutile de
> renommer). Seuls `Import-Certificate` (PowerShell) et l'installation par **double-clic** exigent
> l'extension `.crt` — renommez alors le `.pem` en `.crt` (contenu identique).
- Interface graphique : double-cliquer le fichier → « Installer un certificat » →
  « Ordinateur local » → placer **explicitement** dans le magasin « Autorités de
  certification racines de confiance » (ne pas laisser la sélection automatique).
- Parc en domaine : déployer par **GPO** (Configuration ordinateur → Stratégies →
  Paramètres Windows → Paramètres de sécurité → Stratégies de clé publique → Autorités de
  certification racines de confiance).
- **Firefox** : même remarque que sous Linux (magasin NSS propre —
  `security.enterprise_roots.enabled`).

**Android.** Installation MANUELLE : Paramètres → Sécurité → Chiffrement et identifiants →
Installer un certificat → Certificat CA (puis choisir le fichier).

- Android 11+ : ce passage est **manuel** (obligatoire) et un avertissement s'affiche — le
  confirmer.
- Un bandeau « le réseau peut être surveillé » apparaît ensuite : c'est **normal** pour un
  CA installé par l'utilisateur.
- ⚠ Depuis **Android 7**, les **applications tierces** ne font confiance qu'aux CA du
  magasin **système** : un CA « utilisateur » est reconnu par Chrome et les navigateurs,
  mais **pas** par les applis — sauf opt-in explicite (`networkSecurityConfig`).
- Parc géré : déployer le CA via une solution **MDM** (Android Enterprise).

### CA SSH — confiance déclarée à la main

Une CA SSH n'a pas de magasin système : la confiance se déclare différemment pour les
certificats **utilisateur** et **hôte**. On ne publie que la **clé publique** de la CA (la
ligne `authorized_keys` = le `public_pem` stocké) ; sa clé privée ne quitte jamais la PKI.

- **Serveurs** — accepter les certificats **UTILISATEUR** signés : déposer la clé publique
  de la CA (ex. `/etc/ssh/ca.pub`), la déclarer dans `sshd_config`, puis recharger :
  ```
  TrustedUserCAKeys /etc/ssh/ca.pub
  ```
  (`sudo systemctl reload sshd`).
- **Clients** — accepter les certificats **HÔTE** signés : ajouter une ligne
  `@cert-authority` dans un `known_hosts` (global `/etc/ssh/ssh_known_hosts` ou personnel
  `~/.ssh/known_hosts`) :
  ```
  @cert-authority *.exemple.lan <clé publique de la CA>
  ```

## Suivi d'échéances (`CertExpiryWatcher`, C7)

Producteur `cert-expiry` du service de notifications. Il balaye les **métadonnées**
(`not_after` — le serveur n'a jamais besoin des clés pour surveiller une date) des
certificats **non révoqués** porteurs d'une échéance, tous documents.

- **Seuils GLOBAUX serveur (décision Q6, défaut 30/14/7 jours)** → gravité CROISSANTE à
  mesure que l'échéance approche : J ≤ 7 (ou expiré) → `error` ; J ≤ 14 → `warning` ;
  J ≤ 30 → `info` ; au-delà → `resolve` (renouvelé/ré-émis : l'alerte éventuelle se
  clôt). Non configurables par document en v1.
- **Aucun anti-spam ici** (pattern `vm-sync-failure`) : `raise` est **idempotent par
  passe**, les rappels (12 h par défaut, réglables par type) vivent ENTIÈREMENT dans le
  moteur `notify`. La gravité/le message sont rafraîchis à chaque passe (le prochain
  rappel porte le bon J-n). Clé STABLE `cert-expiry:<docId>:<certId>`.
- **Timer HORAIRE** (l'échéance se mesure en jours — une heure est déjà large) : passe
  immédiate au démarrage puis tick horaire (`unref`). Une passe est **aussi déclenchée
  après CHAQUE écriture** (création/renouvellement/révocation/suppression) — le suivi
  reflète l'action sans attendre le tick.
- **`resolve` au renouvellement/révocation/suppression** : le veilleur mémorise les clés
  qu'il a levées et clôt celles qui disparaissent du balayage. Les routes DELETE/PUT
  (révocation) appellent en plus un `resolve` EXPLICITE (vaut même pour une alerte levée
  par un processus précédent, hors du jeu mémoire).

Côté service de notifications, `cert-expiry` est un **producteur comme un autre** (pont
structurel `index.ts`, cf. [`notifications.md`](notifications.md)) : ses rappels sont
réglables par type dans la page admin « Notifications », ses abonnements se créent comme
les autres. Le pont est branché sur le MÊME `NotifyModule` que `vm/`.

> **NB — deux jeux de seuils, deux rôles distincts.** Le **veilleur serveur** (ci-dessus)
> gradue la GRAVITÉ des notifications sur **30/14/7 j**. La **coloration de la page**
> (`CertsFormat`, cadrage §5) est indépendante et n'a que deux paliers : `warn` ≤ 30 j,
> `err` ≤ 7 j (ou expiré), `ok` au-delà. Les deux sont des décisions de cadrage
> assumées ; ne pas confondre l'affichage (2 paliers) et les notifications (3 niveaux).

## Routes REST

Toutes montées sous la **garde d'accès** du cœur, au chemin **SCOPÉ PAR DOCUMENT**
`<apiBase>/documents/:docId/certs` (`mergeParams`). Réponses **503** explicites si le
module est en erreur (certs.db illisible). ⚠ `/pki` et `/roots` sont déclarées **AVANT**
`/:id` (sinon ces segments seraient lus comme un id).

- `GET    /documents/:docId/certs` → liste métadonnées + SAN (**JAMAIS `key_enc`** — Q5).
  **SANS aucun paramètre** → comportement HISTORIQUE (une page géante, réponse
  `{ certificates }` — rétro-compat CertsClient). **Avec paramètre(s)** → listing
  **PAGINÉ** (réponse forme ListResult `{ certificates, total, page, pages, pageSize }`,
  chaque item porte en plus `root_id`) : `page` (déf. 1), `pageSize` (déf. 25, plafond
  200), `query` (recherche normalisée sur la colonne `search`), `kind` (répétable),
  `status` (`active|revoked|expired|expiring`, `expiring` = ≤ 30 j), `root` (id d'une
  racine → **sous-arbre STRICT**, CTE récursive), `sort`
  (`label|kind|not_after|created_date|parent`), `dir` (`asc|desc`), `focus` (id → page
  qui le contient si l'élément matche les filtres, sinon page demandée). Validation
  **souple** : toute valeur inconnue est ignorée (jamais de 400) ;
- `GET    /documents/:docId/certs/roots` → premiers niveaux paginés + **agrégats de
  sous-arbre** (`children_total`, `children_alert` = descendants non révoqués à échéance
  ≤ 30 j — expirés inclus, `next_expiry` = échéance la plus proche de l'arbre). Mêmes
  paramètres que ci-dessus (sauf `root`) + tris `children_total`/`next_expiry` ;
- `GET    /documents/:docId/certs/pki` → paramètres KDF + `wrapped_dek` (`initialized:false`
  SANS 404 : la première ouverture enchaîne sur l'initialisation) ;
- `PUT    /documents/:docId/certs/pki` → initialisation **UNIQUE** (**409** si déjà
  initialisée : ré-initialiser rendrait tout indéchiffrable) ;
- `PUT    /documents/:docId/certs/pki/rekey` → **changer la phrase maître** : réécrit
  `kdf_salt`/`kdf_iters`/`wrapped_dek` (DEK ré-emballée sous la nouvelle KEK), **aucun
  `key_enc` touché**. Exige **`prev_wrapped_dek`** (l'enveloppe sur laquelle le client a fondé
  son ré-emballage) : **404** si PKI vierge, **409 `conflict`** si l'enveloppe a changé
  entre-temps (verrou optimiste — deux changements concurrents ne s'écrasent pas), et
  l'ancienne enveloppe est **archivée** avant l'UPDATE (cf. « Garde-fous du changement de
  phrase »). Déclarée AVANT `/:id` (« pki » n'est pas un id) ;
- `GET    /documents/:docId/certs/:id` → détail unitaire, `key_enc` **INCLUS** (Q5) ;
- `PUT    /documents/:docId/certs/:id` → créer/mettre à jour (métadonnées validées,
  blobs opaques ; `key_enc` absent = conservé ; **400** si `parent_id` désigne un
  émetteur inconnu du document — FK composite) ;
- `DELETE /documents/:docId/certs/:id` → suppression (**409** si des dérivés existent —
  supprimer un émetteur orphelinerait sa descendance).

**Notification LIVE (pastille d'onglet).** À CHAQUE écriture réussie (PUT/DELETE — création, renouvellement,
révocation, suppression), le module publie sur le **`LiveBus` du document** un événement MINIMAL porteur du
marqueur **`modules: ["certs"]`** (`src-shared/DocumentChangeset.ts`). Les AUTRES clients (l'écrivain ignore
son propre `origin`) recomptent alors la **pastille d'onglet** — l'**alerte d'échéance** : nombre d'**expirants**
(`status=expiring`, ≤ 30 j non encore expirés) + **expirés** (`status=expired`), teinte `err` s'il y a au moins
un expiré sinon `warn`, masquée à 0 — THROTTLÉ. La base `certs.db` étant SÉPARÉE du document cœur, le
`ReloadPlanner` du client **ignore** ce marqueur (aucun rechargement de collections). Bus OPTIONNEL (non injecté
→ badges simplement non rafraîchis en live). Aucun paramètre serveur ajouté : les comptages réutilisent le filtre
`status` **existant** du listing paginé.

## Page « Certificats » (`CertsAdminView`)

**Onglet PRINCIPAL** de premier niveau (`kind:"primary"`, décision utilisateur 2026-07-15 :
« ce n'est pas vraiment un paramètre ») — enregistré dans `main.ts` juste AVANT le groupe
« Paramètres », donc rendu comme dernier onglet primaire de la barre ; hash `#certificats`
bookmarkable inchangé. Toujours enregistrée (`certsClient` null hors mode API → message
« mode API requis »).

- **Écran VERROUILLÉ** : soit l'**initialisation** (PKI vierge → choix de la phrase
  secrète ×2, avertissement de perte, dérivation KEK + tirage/emballage de la DEK +
  `PUT /pki`), soit le **déverrouillage** (saisie de la phrase → dérivation KEK →
  **déballage de la DEK**, qui valide la phrase — cf. keycheck). Les
  **listings restent CONSULTABLES** en lecture seule (métadonnées + échéances colorées,
  filtres/tris/pagination, drill-in « Lister les certificats ») sans déverrouiller —
  seules les opérations de CLÉ l'exigent.
- **DEUX LISTINGS PAGINÉS SERVEUR** (l'arbre O(n) ne tenait pas ~100 dérivés/racine ;
  tout le tri/filtre/pagination est calculé côté serveur, jamais de slice client — CSS
  repris des `ListView` : `.pagination`, `.list-toolbar`, `.sortable`/`.sort-ind`) :
  - **Vue A « Autorités & clés »** (par défaut, `GET /certs/roots`) : racines (parent_id
    nul) + agrégats **Dérivés** (`children_total`) et **Sous seuil** (`children_alert`,
    badge warn/err selon `next_expiry`). Par ligne : **Détail** (info lecture seule, cf.
    plus bas), **Émettre TLS/SSH**, **Exporter…**, **Révoquer**, **Supprimer**, **Lister les
    certificats** (si dérivés > 0) → vue B, et — sur une AUTORITÉ (root-ca / ssh-ca), même
    verrouillé — **Déployer la confiance…** (aide au déploiement, cf. « Déployer la confiance » plus bas).
  - **Vue B « Certificats de \<racine\> »** (`GET /certs?root=…`) : fil d'Ariane
    « ← Autorités » + sous-arbre PLAT de la racine à la place de l'indentation. Colonnes :
    **Émetteur** (LIBELLÉ de l'autorité — la racine scopée `rootScope` n'étant PAS dans la
    page (sous-arbre strict), on affiche son nom plutôt que l'id hexa ; repli page/id court
    pour d'éventuels intermédiaires, non produits en v1), **Émission** (`not_before`, triable
    serveur) et **Échéance** (`not_after`, colorée). Mêmes actions par ligne.
  - **Filtres** : « Type » (MultiSelect, kinds pertinents à la vue) + « État » (sélection
    **UNIQUE** — le serveur n'accepte qu'un `status`) + « Réinit. filtres ». **Tri** par
    clic d'en-tête. État de listing (page/tris/filtres/vue+racine) en mémoire d'instance
    (pas de sessionStorage — cohérence après écritures ; après une écriture, la **page
    courante** est rechargée, le serveur clampe si elle disparaît).
  - **Recherche** (composant réutilisable `ui/SearchPop`, calqué sur la vue 3D) : champ de
    toolbar (visible dans les DEUX vues, **même verrouillé** — il ne lit que des
    métadonnées), popover de résultats (badge = famille) alimenté par
    `GET /certs?query=…&pageSize=8` (anti-rebond ~180 ms ; les réponses PÉRIMÉES d'une
    saisie devancée sont ignorées via `ui/StaleGate`). Un clic ouvre la **BONNE vue** avec
    l'élément mis en évidence — premier niveau → vue A, dérivé → vue B scopée sur SA racine
    (`root_id`) — en RÉINITIALISANT filtres/tri et en passant `focus=<id>` (le serveur
    renvoie la page qui le contient) ; la ligne est surlignée (`.row-focus` + `scrollIntoView`,
    estompée au premier clic ailleurs / à la navigation suivante). La logique PURE (mapping
    du résultat, décision de vue) vit dans `core/CertsSearch` (testée en isolation).
- **En-tête** (déverrouillé) : créer une **CA racine X.509**, une **CA SSH**, une **paire
  SSH** ; **Changer la phrase maître…** (modale : phrase actuelle + nouvelle ×2 →
  `rewrapDek` + `PUT /pki/rekey` ; la session reste ouverte, la DEK ne changeant pas) ;
  **Verrouiller** ; **Actualiser**.
- **Créations en MODALE** (principe n°11) : chaque formulaire (init, CA racine, feuille
  TLS, CA/paire SSH, certificat SSH, PKCS#12) s'ouvre dans LA modale de l'app. La clé
  privée est générée dans WebCrypto, chiffrée par la clé maître, et seuls le public +
  `key_enc` partent au serveur.
- **Détail (info)** : action par ligne (icône ⓘ, disponible MÊME verrouillé — lecture seule,
  aucun secret) → modale récapitulant les métadonnées de l'objet (sujet, **émetteur en clair**,
  numéro de série, empreinte SHA-256, émission/échéance, algo, SAN, dates). Alimentée par l'item
  de listing (jamais `key_enc`).
- **Exports** : menu par ligne. Chaque artefact TEXTE (PEM, ligne OpenSSH) offre **⬇ Télécharger**
  ET **👁 Afficher** — une zone en LECTURE SEULE + « Copier », pour le copier-coller courant sans
  passer par un fichier. PKCS#12 (binaire) et clé OpenSSH (multi-fichiers) restent en téléchargement
  seul. Les clés privées sont déchiffrées LOCALEMENT (session déverrouillée) et ne transitent jamais
  par le serveur ; la passphrase d'un PKCS#12 est demandée en modale et JAMAIS stockée.
  - **RÉVÉLER une clé privée** — l'afficher en clair OU la télécharger/zipper — passe par une
    CONFIRMATION : simple pour une clé ordinaire, **TEXTUELLE** (re-saisie de la phrase
    « Oui je révèle la clé racine », collage bloqué — même cérémonie que la suppression) pour la clé
    privée d'une **CA RACINE**, dont la fuite compromet TOUTE la PKI (`confirmRevealPrivateKey`).
  - L'export unitaire propose en plus **« Tout (ZIP) »** : le BUNDLE du certificat selon son kind
    (ex. feuille TLS = cert + fullchain + clé en un geste ; clé incluse si déverrouillé ET clé
    détenue, sinon artefacts publics seuls — le libellé l'indique ; clé RACINE ⇒ garde textuelle).
- **Sélection multiple & actions groupées** (les DEUX listings, L4) : case par ligne + case
  d'en-tête « toute la page » (état INDÉTERMINÉ si sélection partielle). La sélection
  (instantanés `{kind,label,has_key,revoked_at}` en mémoire d'instance) SURVIT aux changements
  de page/tri/filtre, est VIDÉE au changement de vue (A↔B, recherche) et après une action
  groupée. Une **barre de sélection** (au-dessus de la table quand N > 0) propose
  l'INTERSECTION des actions communes (`BulkActions`, parité STRICTE avec les actions par
  ligne — verrouillée, seul l'export publics reste) :
  - **Exporter (ZIP)** : ouvre d'abord un **DIALOGUE** (modale, principe n°11) qui propose de
    COCHER les catégories d'artefacts COMMUNES à la sélection (`BulkActions.exportChoices` :
    uniquement celles qui ont du sens pour TOUS les non-révoqués — public toujours, fullchain/
    ca-chain si tous leaf-tls, clé privée si déverrouillé + tous `has_key` ; tout coché par
    défaut) et, en option, un **MOT DE PASSE** (deux champs) protégeant l'archive en **AES-256**
    (vides = ZIP en clair ; renseigné = chiffré, ouvrable par 7-Zip/WinRAR). Les RÉVOQUÉS sont
    EXCLUS du ZIP et signalés au bilan ; chaînes résolues via `client.list()` UNE fois ; `key_enc`
    récupérés par GET unitaire (N fois, séquentiel) et déchiffrés LOCALEMENT — la clé privée n'est
    déchiffrée que si la catégorie « clé privée » est cochée. Un dossier par certificat
    (`CertZip.zipArtifacts` en clair / `zipArtifactsEncrypted` chiffré). Mot de passe jamais stocké.
  - **Révoquer** : proposé si AUCUN sélectionné n'est déjà révoqué ; confirmation ; N PUT.
  - **Supprimer** : confirmation danger ; N DELETE ; les 409 (descendance) collectés.
  - **BILAN systématique** (dialogue) de toute action groupée : X réussi(s), Y refusé(s)/
    exclu(s) avec raison PAR élément — jamais de silence partiel.
- **Emballage ZIP côté client** (`CertZip`) : en clair via **fflate** (`zipSync` STORE) ou
  chiffré par mot de passe via **@zip.js/zip.js** (AES-256, `useWebWorkers: false` — le bundle
  client est monolithique, un worker issu d'un blob n'y survivrait pas ; le codec tourne sur le
  thread courant, coût négligeable pour de petits fichiers texte). Réutilise `CertExports` pour le
  CONTENU (le ZIP n'est qu'un conteneur). Les deux dépendances sont amovibles avec la feature.
  PKCS#12 reste HORS bundle (unitaire, passphrase).

Toute erreur `CertsError` **503** (module serveur en erreur) bascule sur un bandeau
détaillé ; les messages d'erreur ne portent aucun matériau de clé.

## Procédures

### Éditer `certs.db` à la main (client SQLite)

Cas d'usage : purger un coffre dont la phrase maître est perdue au-delà de ce que l'UI permet,
ou inspecter l'état réel. **À réserver au dépannage** — l'UI et l'API restent la voie normale
(elles appliquent les garde-fous : descendance, `force`).

Le `docker-compose.yml` déclare un service **`sqlite`** sous `profiles: ["tools"]` : il est
**inerte** (`docker compose up` l'ignore), donc **l'image de production ne contient aucun éditeur
de base**. Il monte le même volume nommé — c'est ce qui suffit à atteindre les fichiers.

```bash
docker compose stop dc-manager        # ⚠️ INDISPENSABLE (WAL — voir ci-dessous)
docker compose run --rm sqlite        # cibler le service active son profil automatiquement
# sqlite> .tables
# sqlite> SELECT id, label, revoked_at, not_after FROM certificates WHERE doc_id='…';
# sqlite> DELETE FROM certificates WHERE doc_id='…' AND id='…';   -- les SAN partent en CASCADE
docker compose start dc-manager
```

**Restaurer une enveloppe archivée** (coffre écrasé par un changement de phrase indésirable —
cf. « Garde-fous du changement de phrase ») : chaque ligne de `pki_envelope_history` emballe
la MÊME DEK ; en restaurer une rend le coffre déchiffrable avec la **phrase en vigueur à
l'époque** de cette ligne.

```sql
-- repérer l'enveloppe à restaurer (la plus récente saine, en général) :
SELECT rowid, archived_date, kdf_iters FROM pki_envelope_history WHERE doc_id = '…' ORDER BY rowid;
-- la remettre en service (remplacer <N> par le rowid choisi) :
UPDATE pki_documents
   SET (kdf_version, kdf_salt, kdf_iters, wrapped_dek) =
       (SELECT kdf_version, kdf_salt, kdf_iters, wrapped_dek FROM pki_envelope_history WHERE rowid = <N>)
 WHERE doc_id = '…';
```

> ⚠️ **Arrêter le serveur d'abord.** `CertsDb` ouvre en **WAL + `busy_timeout`** : écrire pendant
> qu'il tourne, c'est **deux écrivains concurrents** — au mieux un timeout, au pire un état
> incohérent (le serveur garde en mémoire des lignes qu'on vient d'effacer sous lui).

> À la main, **aucun garde-fou ne s'applique** : `PRAGMA foreign_keys` n'est pas actif par défaut
> dans le shell `sqlite3`. Un `DELETE` sur un émetteur peut donc **orpheliner sa descendance** et
> laisser des SAN derrière lui. Activer `PRAGMA foreign_keys = ON;` avant toute suppression.

### Ajouter un FORMAT d'export

1. Ajouter une méthode statique à `CertExports` renvoyant un `ExportArtifact`
   (`{ filename, mime, content }`), en déléguant la crypto/ASN.1 à un module dédié si
   nécessaire (comme `Pkcs12Builder`). Appeler `requireNotRevoked` (garde-fou Q4).
2. Câbler un bouton dans `CertsAdminView.exportModal` (visibilité selon `kind`/`has_key`).
3. Tester le format dans `Tests/modules/test-certs.js` — idéalement par **fixture
   croisée** avec l'outil de référence (ssh-keygen/openssl), comme les formats existants.

### Ajouter un KIND (famille d'objet)

1. Déclarer la valeur dans `CERT_KINDS` (`CertsValidate`) et l'invariant émetteur
   correspondant (racine sans `parent_id` ou dérivé qui en exige un).
2. Ajouter son libellé dans `CertsFormat.KIND_LABELS` (miroir client) et l'option de
   création/émission dans `CertsAdminView`.
3. Étendre la génération (`X509Factory`/`OpenSshEncoder`) et les exports (`CertExports`)
   selon la nature du nouvel objet. Rien à changer côté schéma DB (les métadonnées et le
   blob sont génériques).

### Changer la phrase maître (`PUT /pki/rekey`, `PkiCrypto.rewrapDek`)

Grâce au chiffrement en enveloppe, changer la phrase est **O(1)** : on ne re-chiffre PAS
les certificats, on ré-emballe seulement la DEK. Bouton **« Changer la phrase maître… »**
de l'en-tête (session déverrouillée requise) → modale (phrase actuelle + nouvelle ×2).

1. le client dérive l'**ancienne KEK** (phrase actuelle + `kdf_salt`/`kdf_iters` courants)
   et la **nouvelle KEK** (nouvelle phrase + **sel régénéré**) ;
2. `rewrapDek(oldKek, newKek, wrapped_dek)` **déballe** la DEK sous l'ancienne KEK et la
   **ré-emballe** sous la nouvelle → nouveau `wrapped_dek`. La phrase actuelle est ainsi
   RE-VÉRIFIÉE (le déballage échoue si elle est fausse → « Phrase actuelle incorrecte »).
   Tout passe par `unwrapKey`/`wrapKey` : les octets de la DEK voyagent de blob à blob
   **à l'intérieur du moteur WebCrypto**, jamais par la mémoire JS ;
3. `PUT /pki/rekey` persiste `kdf_salt`/`kdf_iters`/`wrapped_dek`, accompagnés de
   **`prev_wrapped_dek`** (l'enveloppe de départ) ; **aucun `key_enc` n'est envoyé ni
   modifié** ;
4. la DEK étant inchangée, la **session reste ouverte** ; les prochains déverrouillages
   utilisent la nouvelle phrase. L'ancienne phrase ne déverrouille plus (l'ancienne KEK ne
   déballe plus le nouveau `wrapped_dek`).

#### Garde-fous du changement de phrase (audit 2026-07-17)

Le serveur ne peut PAS vérifier que le nouveau blob emballe bien la même DEK
(zéro-connaissance) : un client autorisé mais **bogué ou malveillant** pourrait soumettre
une enveloppe étrangère. Deux garde-fous rendent le geste **non-écrasant et récupérable** :

- **Verrou optimiste** : `prev_wrapped_dek` obligatoire ; s'il ne correspond plus à
  l'enveloppe courante → **409 `conflict`**, rien n'est écrit — deux changements concurrents
  ne peuvent pas se perdre silencieusement (l'UI re-lit l'état PKI et laisse réessayer) ;
- **Historisation append-only** : l'ancien tuple (sel, itérations, enveloppe) est archivé
  dans `pki_envelope_history` AVANT l'UPDATE, dans la MÊME transaction. Toute enveloppe
  passée emballant la MÊME DEK, restaurer n'importe quelle ligne d'historique (cf. « Éditer
  `certs.db` à la main ») rend le coffre à nouveau déchiffrable **avec la phrase de
  l'époque** — un écrasement accidentel ou hostile ne détruit plus rien d'irrécupérable.

> **Ré-init ≠ changement de phrase.** `PUT /pki` reste bloqué (409) sur une PKI déjà
> initialisée — il tirerait une nouvelle DEK et perdrait les clés. Seul `PUT /pki/rekey`,
> qui CONSERVE la DEK, est autorisé à réécrire les paramètres — sous les garde-fous
> ci-dessus.

### Rotation future du KDF (le versionnage v1 est prévu pour ça)

Le schéma est **VERSIONNÉ de bout en bout** (`kdf_version`, préfixe `v1:` des blobs) :
1. introduire un `v2` dans `PkiCrypto` (nouveau KDF/algo) et l'accepter dans
   `CertsValidate.parsePkiParams` ;
2. `decryptSecret` lit déjà le préfixe → les blobs `v1` restent déchiffrables ;
3. faire évoluer le KDF ne touche que la **KEK** : ré-emballer la DEK sous une nouvelle KEK
   `v2` (déchiffrer `wrapped_dek` en `v1`, re-chiffrer en `v2`) suffit — c'est exactement
   le flux `rewrapDek` ci-dessus, les `key_enc` restant inchangés. Aucun changement de
   schéma DB n'est requis (le format est porté par la valeur, pas par une colonne dédiée).

## Suppression de la feature (script d'amovibilité)

Aucun autre module ne dépend de `certs/` (revue d'imports : le cœur serveur ne l'importe
jamais ; côté client tout vit dans les fichiers dédiés ci-dessous).

1. **Serveur** : supprimer `src-server/src/certs/` en entier. Dans `index.ts`, retirer
   l'import et la création du `CertsModule`, son `certs.extension()` du tableau
   `extensions`, `certs.start()`/`certs.stop()`, **et le pont `problems: { … }`** passé
   à `CertsModule.create` (le pont `notify` de `vm/` reste inchangé). Supprimer le
   fichier `certs.db` s'il existe.
2. **Client** : supprimer `src-client/certs/` (crypto pure), `views/CertsAdminView.ts`,
   `views/forms/CertsClient.ts`, `core/CertsFormat.ts`, `core/CertsSearch.ts`,
   `core/CertDeployGuide.ts` (les primitives GÉNÉRIQUES `ui/SearchPop.ts`, `ui/StaleGate.ts`
   ET `ui/Clipboard.ts` RESTENT — réutilisables, non spécifiques aux certificats) ; retirer de
   `main.ts` l'enregistrement de l'**onglet principal** « Certificats » (`shell.addView` +
   `new CertsAdminView(...)` + le `certsClient`), et les exports dans `views/index.ts`. Le
   groupe `parametres` ne référence plus « certificats » (l'onglet est désormais primaire) —
   rien à retirer de ses `children`. Retirer le fichier de tests `Tests/modules/test-certs.js`.
3. **Dépendances** : `@peculiar/x509` (et l'écosystème `@peculiar/asn1-*` transitif) ET
   **`fflate`** (emballage ZIP, importée UNIQUEMENT par `CertZip`) n'étaient utilisées QUE par
   la PKI → **retirables** de `package.json` une fois la feature partie (vérifier qu'aucun autre
   module ne les importe avant de désinstaller — `fflate` n'est employée que par `certs/`).
4. **Ce qui RESTE (indépendant du module certs)** :
   - le **groupe « Paramètres »** — conteneur de navigation générique (l'onglet
     « Certificats » est primaire, hors de ses `children` : rien à y ajuster) ;
   - la primitive **`ui/Clipboard.ts`** — copie presse-papiers générique (réutilisable) ;
   - le **service de notifications** (`notify/`) — le producteur `cert-expiry` disparaît
     simplement, les autres producteurs et abonnements sont intacts ;
   - le **`SecretBox` serveur** — coffre PARTAGÉ par `vm/`/`notify/`, jamais utilisé par
     `certs/` (rien à chiffrer côté serveur) ; il reste, sans lien avec cette feature.
