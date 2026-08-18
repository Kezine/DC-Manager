# Étiquettes QR & scan caméra

Chantier « étiquettes QR » : des étiquettes imprimables (baies, équipements…) dont le QR ouvre
la fiche de l'objet, et un module de scan caméra RÉUTILISABLE, greffable sur n'importe quel champ
de saisie de l'app (n° de série, référence, recherche…) — pas une vue monolithique.

## Vue d'ensemble — deux sens de circulation

- **Génération (serveur)** : l'app imprime une étiquette dont le QR encode l'URL absolue de la
  fiche. Aucune librairie de génération côté client.
- **Décodage (client)** : un téléphone en salle (ou un poste équipé d'une webcam) scanne
  l'étiquette pour sauter à la fiche, ou pour remplir un champ de saisie (service tags
  constructeur en Code 128 / DataMatrix dès la v1). Le décodage est **100 % local** au poste.

Le **format du deep-link** encodé/décodé a une **source unique** : `src-shared/EntityLink.ts`
(forme canonique de l'URL, liste blanche des collections, lecture **agnostique de l'hôte** — dans
l'app, le greffon extrait le deep-link sans tenir compte de l'hôte imprimé, l'étiquette survit
donc à un déménagement d'URL pour l'usage in-app). Génération serveur et décodage client passent
tous deux par lui — jamais de format recomposé à la main.

## Deep-link d'entité : du hash à la fiche

Côté client, deux entrées mènent au même service : le **hash** de l'URL (au boot et sur
`hashchange` — le navigateur a ouvert l'URL scannée hors app) et le **greffon de scan** (texte brut
décodé pendant que l'app tourne). D'où la découpe : `core/EntityLinkRouting` **décide** (module pur,
testé — `Tests/modules/test-entity-link-routing.js`), `app/EntityLinkOpener` **exécute** (store,
hôte de formulaires, accès aux documents et notification injectés ; son API prend une cible **déjà
parsée**). L'ouverture reprend le pattern de la palette Ctrl+K : cache → lecture unitaire
`fetchOne` (indispensable sous chargement paresseux) → `Forms.detail`.

**Deux actions, et deux seulement.** `open` (fiche dans le document courant) et `switch-doc` (mode
API, le lien désigne un autre document : le charger d'abord, sinon la fiche lirait un cache qui ne
contient pas l'objet). En **mode fichier** — visualiseur autonome compris — le `docId` de la cible
est **délibérément ignoré** : le mode est mono-document par nature, et l'arbitrage n°1 du chantier
veut qu'une étiquette imprimée par une instance serveur reste utilisable sur l'export fichier du
même parc.

**L'ordre du boot fait tout.** (1) La cible est capturée **tôt**, avant que `Shell.switchView` ne
reflète l'onglet actif dans l'URL — relire `location.hash` en fin de boot ne rendrait plus qu'un
nom de vue. (2) Elle n'est consommée qu'au moment où un document est **prêt** : la fermeture
`documentOpened` des deux contrôleurs (fichier et API), **après** la restauration de vue
(`core/ViewRestoration`) — la fiche est une modale, elle se pose **par-dessus** la vue restaurée
sans la perturber. La consommation est **unique** (cible remise à `null` avant exécution), ce qui
empêche une bascule de document de se rappeler elle-même. (3) Rien ne casse en cas d'échec :
l'opener ne lève jamais, notifie « objet introuvable » ou « pas de fiche pour ce type d'objet », et
se **tait** quand un autre mécanisme a déjà parlé (403 → `core/AccessDenial`, 401 →
`SessionExpiry`).

**Choix multi-documents (mode API).** Quand le lien vise un autre document que le « dernier doc
ouvert », `main.ts` **pré-positionne `prefs.lastRestDocId` sur le document du lien avant
`rest.bootstrap()`** : le bon document est ouvert **directement**, au lieu d'en charger un puis de
basculer (deux hydratations complètes au moment le plus lourd du démarrage, et une vue peuplée du
mauvais document qui clignote). Le pré-positionnement ne peut pas coincer le boot : `bootstrap`
vérifie que le document existe encore et retombe sinon sur sa priorité historique, et
`openDocument` réécrit la préférence avec le document réellement ouvert. Le chemin `switch-doc`
reste, lui, indispensable **en vol** (hash changé ou code scanné alors que l'application tourne) ;
une bascule qui échoue rouvre le document précédent, sans quoi l'application resterait branchée sur
un document mort.

**Hash de vue ⇄ hash d'entité.** Les deux routages ne peuvent pas se disputer un même fragment : un
lien d'entité contient des `/`, aucun nom de vue n'en contient. `EntityLink.parse` est tenté en
premier ; s'il rend `null`, on ne fait rien et la navigation par onglet du Shell
(`ShellNav.resolveHash`) reste exactement ce qu'elle était.

## Le moteur client — `core/BarcodeDetection`

Principe n°2 appliqué en frontière : **le reste de l'app ne touche jamais** ni au global
`BarcodeDetector` ni au paquet npm `barcode-detector` — tout passe par cette enveloppe. Elle ne
construit aucune UI (l'élément `<video>` est fourni par l'appelant) et n'affiche rien : elle
**expose des états** (permission, échec caméra) que l'UI traduit.

### Deux sources de décodage, bascule à la demande

| Source demandée | Résolution |
|---|---|
| `auto` (défaut) | Le décodeur **natif** de l'OS s'il est **utilisable** — API présente **et** au moins un format déclaré (cas réel mesuré : Chromium sur un poste sans décodeur OS expose l'API avec **zéro** format = inutilisable). Sinon **wasm**. |
| `wasm` | Le moteur **zxing-wasm forcé**, même quand le natif existe. |

Le mode forcé est une consigne utilisateur (GO du 2026-08-18) : zxing-wasm décode **plus de
styles de QR** que les décodeurs OS — l'UI offre la bascule (toggle « Moteur : Auto / WASM » de
la modale de scan, préférence persistée). Le prédicat statique `nativeAvailable()` dit à l'UI si
ce toggle a un sens : sans natif, wasm est la seule source possible, rien à basculer.

`getSupportedFormats()` reflète la **source retenue** (natif = liste de l'OS, wasm = tout zxing) ;
les formats demandés au constructeur sont **intersectés** avec les supportés (demander un format
absent est au mieux ignoré, au pire refusé selon les implémentations ; intersection vide → repli
sur tous les supportés, un constructeur natif refusant la liste vide). Défaut : **tous formats**
— arbitrage v1, les service tags Code 128 / DataMatrix sont lus d'emblée.

### Cycle caméra, boucle, ROI

- **Caméra** : `getUserMedia` arrière de préférence (`facingMode: environment` ideal, 1280×720
  ideal), énumération des caméras (`listCameras()` — ⚠ labels vides tant que la permission n'est
  pas accordée : re-lister après un `start()` réussi), **torche best-effort**
  (`setTorch()` → `applyConstraints({ advanced: [{ torch }] })`, échec silencieux signalé par le
  retour), arrêt propre des tracks.
- **Boucle** : ~8 passes/s (`setTimeout` 120 ms — pas de rAF : `detect()` est asynchrone et
  coûteux, 60 Hz n'apporterait rien à une visée manuelle), **jeton d'annulation** (un `stop()`
  pendant l'`await` rend la passe muette).
- **Permission** : la demande **est** l'appel `getUserMedia` (pas d'étape séparée) ; la
  Permissions API sert à **lire** l'état (`cameraPermission()`, suivi `onchange` par
  `watchCameraPermission()`, API absente tolérée → `unknown`). Un `NotAllowedError` est
  diagnostiqué en **re-lisant** l'état : `denied` = **bloquée pour l'origine** (l'invite ne
  reviendra jamais — déblocage manuel), sinon invite refusée/fermée = **re-demandable**.
- **ROI** : `detect()` accepte une zone de décodage optionnelle (le viseur de la maquette la rend
  déplaçable/redimensionnable — seule cette région part au décodeur, moins de faux positifs sur
  une planche d'étiquettes dense). Le mapping « rectangle écran → pixels vidéo » sous
  `object-fit: cover` est une géométrie **pure et testée** (`BarcodeRoiGeometry.coverMap` :
  échelle inverse du facteur cover, offsets centrés, clamp aux bornes, dégénérée → `null`) ; le
  recadrage passe par un **canvas réutilisé** (aucune allocation par frame). Les coordonnées des
  résultats sont retranslatées dans le repère intrinsèque de la vidéo — même repère avec ou sans
  ROI.

Parties pures testées sans navigateur (injection) : `Tests/modules/test-barcode-detection.js`.

### Le binaire WASM est DANS le bundle (data: URI)

La contrainte qui décide de tout : le build prod sort **un seul HTML autonome**
(`HtmlInlineScriptPlugin`) et l'app vit LAN/hors-ligne. Un fichier `.wasm` servi à côté
404erait pour tout poste du mode fichier qui n'a que `dc-manager.html` — précisément ceux qui ont
**besoin** du polyfill (Windows/Linux/Firefox/Safari n'ont pas de décodeur natif). D'où la règle
webpack `{ test: /\.wasm$/, type: "asset/inline" }`, même doctrine que les fontes `.woff2`.

- **Coût assumé (mesuré)** : **+1 505 715 octets (~1,44 Mio)** sur `dist/dc-manager.html` dès
  qu'un consommateur importe le moteur — 1 457 720 caractères de base64 pour le binaire
  `zxing_reader.wasm` (1 093 289 octets, zxing-wasm 3.1.3) + ~47 Ko de glue/ponyfill minifiés.
  Poids accepté au GO (forcé par la bascule WASM à la demande : le binaire doit toujours être là,
  même quand le natif existe).
- **Compilation paresseuse** : les imports du paquet et du binaire sont dynamiques avec
  `webpackMode: "eager"` (tout reste dans le chunk unique, le module npm n'est évalué qu'au
  premier `create()` en source wasm), et `prepareZXingModule({ overrides: { locateFile } })`
  n'enregistre que l'**emplacement** du binaire (le data: URI) — la **compilation** wasm n'a lieu
  qu'au premier `detect()`. L'inclusion est payée au **build**, jamais au boot.
- **Versions en lockstep** : le binaire est importé depuis le `zxing-wasm` **transitif** (épinglé
  en version exacte par `barcode-detector`) — le `.wasm` doit être celui que la glue JS embarquée
  attend ; une dépendance `zxing-wasm` déclarée à part pourrait diverger et casser silencieusement
  le décodage.
- Un data: URI n'a pas de souci de MIME `application/wasm` côté serveur ; si une CSP arrive un
  jour, prévoir `'wasm-unsafe-eval'` dans `script-src`.

## Sécurité

- **La caméra exige un contexte sécurisé** : HTTPS ou localhost (mesuré : `file://` passe sur
  Chrome desktop mais est refusé sur Android). Le moteur le signale par l'échec
  `insecure-context` (symptôme : `navigator.mediaDevices` absent) — consigne de proxy HTTPS déjà
  en place, cf. `user-docs/reverse-proxy.md`.
- **Aucun octet ne sort du poste** : décodage 100 % local (décodeur OS ou wasm embarqué), aucune
  image conservée, aucun appel réseau — le `locateFile` pointe le data: URI du bundle, jamais un
  CDN.

## Mode local

Le scan **fonctionne en mode fichier mono-HTML grâce à l'inline — c'est sa raison d'être** : les
postes de bureau (Windows notamment) n'ont pas de décodeur natif et le mode fichier n'a que
`dc-manager.html`, donc le moteur wasm doit être dans le fichier. Jamais de CDN (principe n°15).
Seule borne, commune aux deux modes : la **caméra** exige HTTPS/localhost (cf. Sécurité) — sur un
poste de bureau en `file://` (Chrome), elle fonctionne ; sur téléphone, servir l'app en HTTPS.

## Génération serveur

**Route** : `GET <apiBase>/documents/:docId/qr/:collection/:id?format=png|svg&size=<px>`
(montée dans `api.ts`, routeur SCOPÉ par document, aux côtés de `/search`/`/facets`/`/maintenance`).

- **Garde** : `this.access.requireCollection("read")` — permission de LECTURE de la collection
  demandée, résolue par la carte partagée collection → domaine (`src-shared/Permissions`). Elle est
  donc soumise au verrou d'exhaustivité de `Tests/modules/test-access.js` comme les autres routes.
  Sémantique 401/403 inchangée (garde globale `requireAuth` en amont).
- **Charge encodée** : `EntityLink.build(PUBLIC_BASE_URL, { docId, collection, id })` — le format
  d'URL est la SOURCE UNIQUE partagée `src-shared/EntityLink`, JAMAIS une URL forgée dans la route.
  Le QR encode donc `<PUBLIC_BASE_URL>#doc/<docId>/fiche/<collection>/<id>`.
- **Env var `PUBLIC_BASE_URL`** (cf. `user-docs/configuration.md`) : URL publique absolue de
  l'app, jamais dérivée des en-têtes de requête (anti-spoofing — une URL tirée de `Host` finirait
  imprimée sur des étiquettes ; même doctrine qu'`OIDC_REDIRECT_URL`). Lue au bootstrap
  (`index.ts`) et passée à l'`Api` via `ServerOptions.publicBaseUrl`.
- **Formats** : `?format=png` (défaut, `QRCode.toBuffer` → `image/png`) ou `?format=svg`
  (`QRCode.toString({type:"svg"})` → `image/svg+xml`). `?size=` en pixels, BORNÉE à [64, 1024]
  (défaut 256), niveau de correction M. Lib : `qrcode` (npm, pure JS) ; validation des paramètres =
  module pur testable `src-server/src/QrCodeParams.ts` (format en liste blanche fermée, taille
  bornée).
- ⚠ Le **SVG est généré PAR NOUS** depuis des données maîtrisées (l'URL d'une fiche existante,
  composée par `EntityLink`) — aucun contenu tiers réinjecté : la doctrine anti-XSS-stocké des
  binaires UPLOADÉS (`putImage`/`createAttachment`) ne s'applique pas ici.
- **Erreurs** : **503** actionnable si `PUBLIC_BASE_URL` absente (patron des modules à clé absente —
  le serveur démarre, seule cette route se désactive) ; **404** si la collection est inconnue OU si
  l'enregistrement n'existe pas dans le document (pas d'étiquette morte, vérif par le dépôt en
  lecture seule) ; **400** si `format`/`size` sont invalides ; **500** si la génération échoue.
- **Lecture pure** : GET → moitié lecture de `resolveRepo` (aucune révision consommée, aucun SSE).

Tests : `Tests/modules/test-qr-params.js` (logique pure `QrCodeParams` — défauts, format en liste
blanche, bornes de taille). La route HTTP elle-même n'est pas montée en test (mêmes raisons
qu'`api.ts` : Express/multer non résolus dans le programme de test — cf. en-tête de test-access.js).

**Mode local** : la génération d'étiquettes est SERVEUR par décision d'architecture (« aucune lib
de génération dans le client », GO 2026-08-18) — le mode fichier n'imprime donc pas d'étiquettes
(écart au principe n°15 assumé et documenté ici). Le SCAN, lui, fonctionne dans les deux modes
(cf. « Mode local » ci-dessus).
