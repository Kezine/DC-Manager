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

> ⚠ **Depuis le chantier « liens directs » (2026-09-01), ce format est ENVELOPPÉ, pas remplacé.**
> `src-shared/AppLink` est désormais la **grammaire** de tous les liens de l'application (fiche,
> intervention, certificat, recherche) et **délègue** la forme « fiche » à `EntityLink`, qui reste sa
> source de vérité — le format est gravé sur des étiquettes physiques, il est **intangible**.
> Deux conséquences pour ce document : le routage client s'appelle maintenant `core/AppLinkRouting` +
> `app/AppLinkOpener`, et une étiquette imprimée **ne porte pas** le paramètre `?vue=1` — elle ouvre
> donc la fiche **par-dessus l'onglet courant**, exactement comme décrit ci-dessous. Voir
> [`liens-directs.md`](liens-directs.md).

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

## L'UI de scan — greffon de champ + viseur

La maquette `design-system/briefs/qr-saisie-camera-maquette.html` **fait foi** (consigne
utilisateur). Deux composants, et une découpe stricte : le **moteur** (`core/BarcodeDetection`)
fait caméra + boucle + décodage, l'**UI** traduit ses états et n'accède jamais aux API caméra.

- **`ui/ScanControl`** — le **greffon** attachable (principe n°14) : un bouton-icône 44 px
  (`Icons.SCAN`, aria-label + tooltip) accolé au champ hôte, qui ouvre le viseur et **injecte** la
  valeur validée « comme une frappe » (setter natif + événements `input`/`change` qui bullent →
  validation live et `onchange` du formulaire réagissent à l'identique ; flash de confirmation,
  focus rendu au champ). L'hôte (pile de modales + préférences) est **injecté** par `main.ts`
  (`ScanControl.setup`) — le module n'importe ni `Prefs` ni le Store.
- **`ui/ScanViewfinder`** — le **viseur** : un niveau **info** de la pile de modales STANDARD
  (jamais un overlay parallèle — Échap/✕/← gardent leur sémantique de pile, l'édition en dessous
  survit par construction), vidéo `playsinline muted`, badge du moteur actif, torche best-effort,
  bascule de caméra (si plusieurs), verrouillage visuel + vibration (`Haptics.decoded`, 40 ms) +
  annonce vocale `aria-live` à la lecture ; échecs caméra TYPÉS traduits (permission **bloquée**
  avec geste de déblocage ⇄ **re-demandable** avec « Réessayer », suivi `watchCameraPermission` :
  un accord donné dans les réglages du site **relance la caméra tout seul**) ; scanline coupée
  par `prefers-reduced-motion`.

### Deux régimes d'attachement

| Régime | Qui | Parseur |
|---|---|---|
| **Déclaré** | Les champs qui nomment leur parseur : les 3 `serial` (formulaires équipement, sous-équipement, spare — `ScanControl.attach({ input, parser: "serial", fieldKey, label })`) | `serial` |
| **Générique** | Préférence « bouton scan sur tous les champs texte » : un `MutationObserver` sur le corps de la modale (`Modal.body`) greffe les `input[type=text]` **enfants directs** d'une rangée `.form-field` — les contrôles composites (date, pickers, chips…) enveloppent leur input et sont exclus par construction | `raw` |

**Visibilité** (décision pure `core/ScanAffordance`, prédicats injectés — testée) : bouton de champ
= (pointeur grossier OU écran < 900 px OU préférence de forçage) ET une caméra existe ET contexte
sécurisé — « pas d'icône morte » sur PC 16/9 ; entrée globale = caméra + contexte seulement.
Évaluée à l'attachement (un champ vit le temps d'une modale).

### Parseurs nommés — « jamais d'injection silencieuse »

`core/ScanParsing` (pur, testé) : le scan est une **source de saisie**, la valeur décodée passe
par le parseur du champ avant toute injection. Résultat `{ ok, value, warning? }` en **codes**
(`empty` / `multiline` / `linklike`), l'UI traduit (`scan.warning.*`). Non conforme = valeur
**affichée** avec l'avertissement et « Valider » **désactivé**. `raw` : trim, non vide,
mono-ligne. `serial` : préfixes constructeur nettoyés (« SN: », « S/N », « SER »… — séparateur
**requis** : `SN123456` reste intact), et refus de ce qui ressemble à un **lien** (URL http(s) ou
deep-link — `EntityLink.parse` est la source unique, jamais une regex maison) : sur une planche
dense, c'est le mauvais code.

### Zone de décodage (ROI) mémorisée par champ

`core/ScanRoiMemory` (pur, testé) : rectangle en **fractions** du plateau, déplaçable au pointeur
et redimensionnable par les coins (pointer capture, comme la maquette ; coin **opposé ancré** —
écart assumé : la maquette laissait glisser la boîte au minimum de taille), tailles mini
16 %×14 %, défaut centré 62 %×46 %. Persistée dans localStorage (`dcmanager.scanRoi`, carte
`clé de champ → rect` — clés `equipments.serial`, `spares.serial`, `subEquipments.serial`,
`global` pour l'entrée globale, `field:<libellé>` pour le générique). La ROI est **relue à chaque
passe** par le moteur ; seule cette région part au décodeur (`detect(video, roi)` — le mapping
cover est au moteur, cf. plus haut).

### Bascule de moteur, résultat

Toggle « Moteur : Auto (natif) / WASM » dans le viseur — affiché **seulement** si
`nativeAvailable()` (sans natif, rien à basculer), préférence persistée (`Prefs.scanEngine`),
bascule = moteur **recréé à chaud**. Panneau résultat : valeur brute, format, heure ;
« Continuer » relance (le code tout juste lu est ignoré 1,5 s — sans quoi il re-verrouillerait
avant qu'on vise le suivant), « Valider » injecte et ferme.

### Entrée globale et raccourci clavier

- **Topbar** : bouton « Scanner une étiquette » (`Icons.SCAN`, à côté de la loupe), révélé par la
  sonde caméra du boot. Viseur en mode **libre** : un **deep-link** décodé part à l'instance
  unique `EntityLinkOpener` de `main.ts` (fermeture immédiate, la fiche s'ouvre) ; sinon panneau
  d'actions — copier, « insérer dans le dernier champ actif » (suivi `focusin` des champs texte
  éditables, cible **capturée à l'ouverture**), et un **lien cliquable** si la valeur est une URL
  http(s) (`Html.externalLink` — JAMAIS de navigation automatique, doctrine POC).
- **Ctrl+Maj+S** : ouvre le viseur sur le champ texte **focalisé** (parseur du champ s'il est
  déclaré, `raw` sinon). Enregistré dans `main.ts` à côté du Ctrl+F de la palette ; la garde est
  le focus lui-même — hors d'un champ texte éditable, la touche ne fait rien.

### Préférences

| Préférence (`core/Prefs`) | Réglages | Effet |
|---|---|---|
| `scanAllFields` (défaut faux) | « Bouton scan sur tous les champs texte » | greffon générique + forçage de visibilité |
| `scanForceButtons` (défaut faux) | « Toujours afficher le bouton scan » | force l'icône des champs déclarés sur desktop (webcam poste fixe) |
| `scanEngine` (`auto`/`wasm`, défaut `auto`) | toggle du viseur | source du moteur de décodage |

### Extension future — mode lot

Le « mode lot » de la maquette (champs **multivalués** : chaque lecture empile un chip, doublons
signalés, « Terminer » ferme) n'est **pas implémenté en v1** : aucun champ multivalué ne consomme
le scan aujourd'hui. Le jour venu, c'est une variante de cible du viseur (accumulation côté
`ScanViewfinder` + injection par chips côté hôte) — le moteur et les parseurs n'ont pas à bouger.

Tests : `Tests/modules/test-scan-ui.js` (parseurs, affordance, géométrie + persistance de la ROI).

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

**Route** : `GET <apiBase>/documents/:docId/qr/:collection/:id?format=png|svg|matrix&size=<px>`
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
- **Formats** — liste blanche FERMÉE (tout autre → 400), niveau de correction M, lib `qrcode`
  (npm, pure JS) ; validation = module pur testable `src-server/src/QrCodeParams.ts` :
  - `png` (défaut) — `QRCode.toBuffer` → `image/png` ;
  - `svg` — 🚨 **plus `QRCode.toString`** : la route récupère la **matrice** (`QRCode.create`) et
    émet **notre** SVG à **modules CARRÉS** via `src-server/src/QrSvg.ts` (module pur, testé en
    isolation). La librairie dessinait un **trait par rangée** à coordonnées en demi-module, ce qui
    rendait les modules inégaux à l'impression — cf. « QR à modules carrés » plus bas pour le
    diagnostic complet. Quiet zone de **4 modules inchangée** ;
  - `matrix` — la MÊME matrice en **JSON** `{ size, margin, rows }` (`rows` = une chaîne de `0`/`1`
    par rangée, SANS la quiet zone). Ce n'est pas une image : `?size=` n'y a aucun effet. Consommée
    par l'**export en images** des étiquettes, qui rasterise le QR à un nombre ENTIER de pixels par
    module au lieu de mettre un SVG à l'échelle.

  `?size=` en pixels, BORNÉE à [64, 1024] (défaut 256) — elle ne pose que les attributs
  `width`/`height` du SVG, que le chemin d'impression écrase de toute façon par une cote en mm.
- ⚠ Le **SVG est généré PAR NOUS** depuis des données maîtrisées (l'URL d'une fiche existante,
  composée par `EntityLink`) — aucun contenu tiers réinjecté : la doctrine anti-XSS-stocké des
  binaires UPLOADÉS (`putImage`/`createAttachment`) ne s'applique pas ici.
- **Erreurs** : **503** actionnable si `PUBLIC_BASE_URL` absente (patron des modules à clé absente —
  le serveur démarre, seule cette route se désactive) ; **404** si la collection est inconnue OU si
  l'enregistrement n'existe pas dans le document (pas d'étiquette morte, vérif par le dépôt en
  lecture seule) ; **400** si `format`/`size` sont invalides ; **500** si la génération échoue.
- **Lecture pure** : GET → moitié lecture de `resolveRepo` (aucune révision consommée, aucun SSE).

Tests : `Tests/modules/test-qr-params.js` — logique pure `QrCodeParams` (défauts, format en liste
blanche, bornes de taille) **et** l'émetteur `QrSvg` (carrés à coordonnées entières, un seul chemin
de modules, aucune coordonnée fractionnaire, `crispEdges` conservé), avec un **verrou d'intégration**
sur le consommateur client : `core/LabelQrSvg.detectMarginModules` doit continuer de lire la quiet
zone à 4 sur notre sortie — sinon `scaleToMm` la croirait insuffisante et **rétrécirait le QR en
silence**. La route HTTP elle-même n'est pas montée en test (mêmes raisons qu'`api.ts` :
Express/multer non résolus dans le programme de test — cf. en-tête de test-access.js).

**Mode local** : la génération d'étiquettes est SERVEUR par décision d'architecture (« aucune lib
de génération dans le client », GO 2026-08-18) — le mode fichier n'imprime donc pas d'étiquettes
(écart au principe n°15 assumé, cf. « Mode local » de la section suivante pour le mécanisme de
masquage). Le SCAN, lui, fonctionne dans les deux modes (cf. « Mode local » ci-dessus).

## Étiquettes imprimables

**Deux maquettes font foi, chacune sur sa moitié** : `qr-etiquettes-imprimables-maquette.html` sur le
**rendu imprimé** (gabarits, anatomie, flux — amendée par les décisions du cadrage E du 2026-08-20),
et `qr-print-redesign-maquette.html` sur le **panneau de réglages** (retour terrain T11 du
2026-09-03). Les deux vivent dans `design-system/briefs/`. **Un seul écran de sortie** : la modale
`ui/LabelPrintDialog` (pile de modales standard, principe n°11) ; ce qui change entre les points
d'entrée est ce qu'elle **reçoit** (`LabelPrintContext` — les OBJETS à étiqueter, un par objet).

> 🚨 **T11 en une phrase** : *« le rendu imprimé n'est pas en cause — c'est le panneau qui a dérivé,
> onze drapeaux de visibilité plus tard. »* D'où **quatre étages qui ne disparaissent jamais**, un axe
> **Support** qui remplace le fourre-tout « Format », une **disponibilité avec raison** au lieu d'un
> masquage, le **tirage** décidé devant l'aperçu, et **deux registres** d'avertissement. Le moteur
> d'impression (`LabelSpec`, `LabelLayout`, `LabelHtml`) et ses cinq pièges payés le 2026-08-25 n'ont
> **pas bougé** — sauf le repère du bout local, ci-dessous.

### Découpe des modules

| Module | Rôle |
|---|---|
| `core/LabelLayout` | **Géométrie PURE** (mm) : table des gabarits (cotes EXACTES de la maquette), **densités** (padding/gouttière), drapeau **dérivé du QR**, manchon (**1,5 tour, le demi-tour EST le recouvrement** + nombre de cases DÉDUIT), QR seul, **cellule de planche ≠ étiquette**, plafond de colonnes, capacité A4, bornes du personnalisé, **débordement en CODES** (`LabelWarning` — l'UI traduit) |
| `core/LabelPrintPolicy` | Les **règles TRANSVERSES** (pures) : contenus/formats/défauts par sujet, **union d'offre de planche** `fieldOffer(sujets)`, règle contenu × champ `fieldVisible`, et `sanitize` qui fait RETOMBER un réglage mémorisé devenu invalide. 🚨 Depuis T10, **plus aucune table de cases par sujet** — l'offre descend des déclarations. 🚨 Depuis T11 : la **projection support ⇄ (gabarit, contenu)** (`supportOf`/`applySupport`), le verdict **`availability`** (disponible / **CODE de raison**, en remplacement de `visibility`), les **registres** d'avertissement, le **développement du tirage** (`expand`) et le **papier** (`paperOf`) |
| `core/LabelQrSvg` | Retravail PUR du SVG servi par `/qr` : **quiet zone vérifiée** (marge en modules lue dans le tracé) et **compensée par un padding blanc calculé** si < 4 modules (un `?size=` plus grand n'y changerait rien — propriété en modules, pas en pixels), mise à l'échelle en mm |
| `core/LabelHtml` | Rendu HTML PUR **partagé aperçu ⇄ imprimé** (une seule source, fidélité par construction) : étiquette, page de planche, document d'impression. **Noir sur blanc, aucun token de thème** ; les COTES (padding/gouttière) sont posées INLINE depuis `LabelLayout`. Porte aussi le **modèle** `LabelFieldDecl`/`LabelSubject` et rend la liste déclarée **génériquement** (une ligne par déclaration cochée, registre typographique déclaré) |
| `core/LabelSubjects` | La matière d'une étiquette depuis un enregistrement (lecteur injecté) : équipement (« baie · U »), baie, câble (A/B = **ordre de la fiche**), **faisceau** (A/B = les deux patchs terminaux), spare, sous-équipement — la règle écrite UNE fois pour tous les points d'entrée. Depuis T10, chaque constructeur **DÉCLARE les champs imprimables** du sujet |
| `core/LabelExportPlan` | 🚨 **T11** — arithmétique PURE de l'export en images : nommage cadré des fichiers, millimètres → pixels à un dpi, et la cote de QR à **k pixels entiers par module** (mêmes règles que l'impression, écrites une fois) |
| `ui/LabelPrintDialog` | La modale : contexte + **quatre étages qui ne disparaissent jamais** + aperçu fidèle réduit + **deux registres** d'avertissement + iframe d'impression. **N'écrit AUCUNE règle de disponibilité** — elle consomme `availability` et pose `disabled` + la raison traduite (verrous de test sur cette source). Réglages **mémorisés en session** par contexte, et la mémoire est **visible** (jamais de Prefs persistées) |
| `ui/LabelImageExport` | 🚨 **T11** — « Exporter en images » : rasterise le MÊME HTML d'étiquette (`<foreignObject>` → canvas → PNG), le QR étant peint **depuis la matrice** à k pixels entiers par module ; ZIP dès la deuxième image |

### Gabarits et planche

Préréglages S 50×20 (QR 18) / **M 50×30 (QR 20, défaut)** / L 70×40 (QR 28) / Baie 100×60 (QR 34) /
Câble (drapeau dérivé du QR : compact 54×18, confort 62×22) + manchons SANS QR (repère complet en
2 panneaux, ou identifiant répété — cf. « Manchons » ci-dessous) + Personnalisé (largeur 20–210,
hauteur 12–297, QR 12–60 mm ; Ø 3–30 et longueur 10–60 pour les manchons). Densité **compact (défaut)** /
confort. Plancher de scannabilité **QR ≥ 18 mm** (signalé, jamais interdit) ; quiet zone 4 modules
INTOUCHABLE (dans le SVG servi — vérifiée/compensée par `LabelQrSvg`). QR TOUJOURS à gauche.

**Doctrine des DENSITÉS** (amende la maquette — retour terrain « énormément de marges ») :
**compact = marges NULLES**, padding et gouttières compris — la quiet zone vit DÉJÀ dans le SVG
servi (4 modules), une marge d'étiquette par-dessus ne protège rien et vole de la place au texte ;
**confort = l'aisance de la maquette** (1,5 mm en S/M, 3 en L, 4 en Baie ; gouttières 2/3/5).
Ces cotes vivent dans `LabelLayout` (`rectPadding`/`rectGap`) et sont posées **inline** par
`LabelHtml` — plus dans le CSS de classe : ce qui est calculé doit être vérifiable au millimètre
dans le HTML généré (c'est ce que testent `Tests/modules/test-labels.js`).

🚨 **Le QR d'un préréglage ne déborde JAMAIS** (`LabelLayout.rectQrGeometry`). Bug mesuré en format
S : 18 mm de QR + 2 × 1,5 mm de marge de confort = 21 mm dans une étiquette haute de 20 — le SVG
débordait de la zone de contenu et se faisait **rogner à l'impression**. La règle : le QR est clampé
à `hauteur − 2 marges`, et si ce clamp passait sous le plancher de scannabilité, **c'est la MARGE
verticale qui cède** — la scannabilité prime sur l'aisance, jamais l'inverse. Corollaire : l'UI ne
sert au SVG **que** la cote de `LabelLayout.renderQrMm(...)` — point de passage UNIQUE de l'aperçu
comme de l'imprimé, de l'unitaire comme de la planche (où c'est la hauteur de CELLULE qui compte).
Le gabarit « Personnalisé » n'est PAS clampé (l'utilisateur contrôle ses cotes) : il est **averti**
(`qr-exceeds-label`), avec le padding réel de sa densité.

### Manchons — enroulement et répétitions (🚨 AMENDENT la maquette)

Les deux règles ci-dessous **amendent explicitement la maquette** (retours terrain du 2026-08-20,
sur étiquettes **imprimées**, photos à l'appui). Elles vivent dans `core/LabelLayout`
(`sleeveGeometry`, `sleeveRepeats`, `sleeveCellWidth`) et sont posées **inline** par `LabelHtml`.

**① Enroulement : 1,5 tour, et le demi-tour excédentaire EST le recouvrement.** La maquette
donnait « 2 tours + un recouvrement forfaitaire » (12 mm en compact, 16 en confort) — verbatim
utilisateur : « 1.5 × le diamètre est OK sinon on a trop de papier à coller ». Désormais
`tour = π·Ø`, `recouvrement = tour / 2`, `largeur = 1,5 · tour` : il n'y a **plus de zone de
recouvrement ajoutée en supplément**, c'est le demi-tour en trop qui se colle sur lui-même
(auto-collant classique). La zone hachurée `.ov` représente donc ce demi-tour, et la partie
**VISIBLE** sur le câble (`largeur − recouvrement`) vaut **exactement un tour**.

| Ø (mm) | tour | recouvrement | largeur AVANT (2 tours + forfait) | largeur APRÈS (1,5 tour) | cases |
|---|---|---|---|---|---|
| 3 | 9,42 | 4,71 | 30,85 | **14,14** | 2 |
| 6 | 18,85 | 9,42 | 49,70 | **28,27** | 4 |
| 10 | 31,42 | 15,71 | 74,83 | **47,12** | 6 |
| 20 | 62,83 | 31,42 | 137,66 | **94,25** | 13 |

⚠ La **densité n'entre plus** dans l'enroulement : celui-ci est une géométrie **physique** (la
circonférence d'un câble ne dépend pas de l'aisance typographique voulue) — d'où la disparition du
paramètre `compact` de `sleeveGeometry`. La densité continue de piloter la **typographie** du
manchon via la classe `.lab.compact`.

**② Répétitions : le nombre est DÉDUIT de la longueur visible, les cases sont toutes égales.** Le
retour était « la case de la dernière répétition est plus grande que les autres ». Le diagnostic
(mesuré au navigateur sur le HTML généré) a trouvé **deux défauts cumulés**, tous deux corrigés :

- les 6 cases se partageaient `largeur − recouvrement` = **DEUX tours**, alors que la maquette dit
  « le même identifiant répété six fois **sur le tour** » — soit 3 par tour au lieu de 6 ; et ce 6
  était **figé quel que soit le Ø** : à Ø 3 la case tombait à 3,14 mm (le texte, 3,10 mm de hauteur
  de ligne, n'y tenait déjà plus et se faisait rogner), à Ø 20 elle atteignait 20,94 mm (le texte
  flottait au milieu de 9 mm de blanc de chaque côté — c'est ce qui fait *lire* une case comme
  surdimensionnée) ;
- la largeur des cases était laissée à `flex:1`, donc à un **reste réparti** par le moteur de
  flexbox : rien ne posait leur égalité, et rien ne pouvait la vérifier.

Règle retenue : `cases = clamp(arrondi(visible / 5 mm), 2, 20)`, puis **largeur de case =
`visible / cases` EXACTEMENT** — égales par construction, sans reste. Le **pas cible de 5 mm** est
l'épaisseur d'une bande mesurée *en travers* du câble (le nom, lui, se lit dans l'axe du câble) : la
ligne d'identifiant en 8 pt occupe 3,10 mm en travers, un pas de 4 mm ne laisserait que 0,45 mm de
blanc de part et d'autre du filet, un pas de 6 mm reproduirait le flottement fautif. À 5 mm la case
reste entre **4,19 et 5,76 mm** sur toute la gamme de Ø offerte (au pas de saisie de 0,5 mm), soit
1,35 à 1,86 fois la hauteur de ligne. Le minimum de 2 cases est une règle métier (« lisible sous
tous les angles » exige au moins deux repères sur le tour) ; le maximum de 20 est un garde-fou de
totalité de la fonction pure, il ne mord pas dans la gamme offerte (Ø 30 → 19 cases).

Le variant **« repère complet »** garde ses **2 panneaux** (son texte est riche : identifiant +
extrémités A/B + type + propriétaire), mais sur la **même assiette** — donc un **demi-tour chacun**,
exactement égaux. ⚠ Limite assumée : ce texte empilé demande ≈ 9,4 mm en travers ; en dessous de
**Ø 6** un panneau devient plus étroit que cela et les dernières lignes se font rogner — décocher un
champ (ou passer à « identifiant seul ») est le remède.

**Filets de séparation** : *toutes* les cases portent le même `border-right` (0,2 mm pointillé) —
leurs boîtes sont ainsi rigoureusement identiques ; retirer celui de la dernière élargirait sa boîte
de contenu de 0,2 mm et recréerait, en miniature, le défaut signalé. C'est la zone hachurée qui a
perdu son `border-left` (fin du **double trait** au raccord), la dernière case portant la classe
`fold` — filet plus sombre, même géométrie — pour marquer le début du recouvrement.

**Planche A4** (dès 2 étiquettes) : marge 8 mm, en-tête hors zone (source · compte/date), colonnes
2/3/4 **plafonnées par la largeur réelle**, traits de coupe pointillés 0,2 mm désactivables,
pagination silencieuse au-delà d'une feuille (le compteur l'annonce). ⚠ Sur une planche, l'étiquette
s'étire dans sa **cellule** de grille (colonne `cell` de la table — M : 48×33, d'où « 4 × 8 = 32 par
feuille » alors que la cote nominale est 50 mm) ; le plafond de colonnes se calcule sur la CELLULE.

**Colonnes** : un **champ numérique borné** (`min:1`, `max` = capacité réelle du gabarit), et non un
contrôle segmenté — celui-ci est une rangée de boutons, faite pour 3 ou 4 choix, alors qu'une planche
peut en accepter 8. Le champ est construit **une fois** et seul son `max` bouge au rendu : le recréer
coûterait le focus à chaque frappe. La capacité vient de `LabelLayout.maxColumns` (`columnChoices`
reste disponible pour un contrôle à choix discrets)
— elle n'est plus figée à `[2, 3, 4]` dans l'UI. Depuis que la cellule épouse l'étiquette, une
planche de manchons en loge 6 ; à l'inverse une étiquette de baie n'en accepte qu'**une**, choix
que la liste figée ne savait pas exprimer. `MAX_SHEET_COLUMNS` (8) est une borne d'**interface**
— le contrôle segmenté vit dans un panneau de 250 px —, pas une borne physique : une très petite
étiquette en logerait davantage. La capacité (`maxColumns`, `rows`) compte les **traits de coupe**
(`CUT_MM`), qui s'ajoutent autour de l'étiquette depuis le passage de la cellule en `content-box`.
**Unitaire** : page à la taille EXACTE de l'étiquette (`@page size` → imprimantes à rouleau
Brother/Dymo, sans découpe).

### Repère d'orientation des manchons « identifiant seul » (`core/LabelOrientation`)

Ce format ne porte **que** le numéro, répété autour du câble : aucun mot n'y donne le sens de
lecture. Un manchon posé à l'envers fait donc lire `168` comme `891` — un identifiant parfaitement
plausible, et le seul cas où l'on peut débrancher le mauvais câble **en ayant lu correctement**.
L'identifiant est alors **souligné**.

**Le déclencheur n'est pas « que des chiffres »**, qui attrape trop et trop peu :

| Identifiant | Retourné | Souligné ? | Pourquoi |
|---|---|---|---|
| `168` | `891` | **oui** | deux lectures plausibles — le vrai piège |
| `1234` | *(illisible)* | non | `2/3/4` n'ont pas d'image : on voit que c'est à l'envers |
| `689` | `689` | non | **strobogrammatique** — se relit à l'identique, aucune erreur possible |
| `SW-01` | *(illisible)* | non | un mot latin retourné se reconnaît instantanément |

Le critère est donc « **tous** les caractères ont une image par rotation (`0 1 6 8 9`, plus le tiret)
**et** la lecture retournée **diffère** de l'originale ». Le souligné porte alors une information —
« celui-ci est retournable » — au lieu d'être un ornement posé partout.

Choix de conception :

- **Souligné** plutôt qu'un point final ou un préfixe : sur un manchon, la ressource rare est la
  longueur le long du câble (cf. l'avertissement `sleeve-tight`) — un souligné ne coûte **aucune**
  largeur. C'est aussi la convention établie pour les chiffres ambigus.
- **Épaisseur posée en mm** (`0,4`), jamais l'automatique : à 8 pt un souligné auto ferait ~0,5 px et
  disparaîtrait selon l'arrondi — exactement le piège sous-pixel des traits de coupe.
- `text-decoration` plutôt qu'une bordure physique : le texte est en `writing-mode: vertical-rl`, le
  soulignement doit suivre le mode d'écriture et non un côté physique deviné.
- **« Identifiant seul » uniquement** (décision utilisateur) : le « repère complet » affiche déjà les
  extrémités A/B et le type, dont le sens de lecture est évident.

### Décisions du cadrage E (amendent la maquette)

- **« Société propriétaire » = le champ `equipments.owner`** (lot E1), PAS une saisie d'impression
  non persistée : sur l'étiquette il est derrière une **case** du bloc « Lisible humain » (décochée
  par défaut, mémorisée en session) ; sur une planche chaque étiquette porte le `owner` de SON
  enregistrement — vide → ligne absente. Le champ libre de la maquette a disparu.
- **Pas de sélection multiple des listings en v1** : ni cases ni barre de sélection — la planche
  s'obtient par la **baie** (« Planche du contenu », U décroissants : l'ordre de collage). Le point
  d'entrée listing est l'action de ligne **unitaire** seulement.
- Catalogue Avery nommé : NON (les colonnes réglables suffisent). Trace « imprimée le … » sur la
  fiche : NON.
- **Câbles** : sens A → B = l'**ordre de la fiche** (from → to). ⚠ **Amendé par T11** : les deux
  gestes ont fusionné en « Étiqueter… », le défaut reste les deux extrémités, et les deux drapeaux
  ne sont plus identiques — **chacun marque le bout qu'il habille** (cf. « Le repère du bout local »).

### Disponibilité avec raison (`core/LabelPrintPolicy`)

Le retour terrain de 2026-08-20 était « **tous les contrôles dans tous les contextes** » ; celui de
2026-09-03 (T11) a montré la moitié manquante : à force de masquer, **le panneau changeait de
vocabulaire d'un sujet à l'autre**, et une option disparue n'apprend rien. La règle vit donc toujours
dans UN module pur — mais son verdict a changé de nature. `availability(sujet, support, contenu,
offre)` rend, **par option**, soit `ok` soit un **CODE de raison** ; la modale **grise et traduit**
(clés `labels.why.*`) là où elle posait `hidden`. Même famille que `PortCompatibility` /
`BreakoutRules` : des codes, jamais de phrases.

**Deux traitements, jamais trois** :

| Situation | Traitement |
|---|---|
| Option d'un axe FIXE, indisponible ici (support, contenu, gabarit, bascule d'extrémités) | **listée, `disabled`, avec sa raison** sur sa propre ligne |
| Question qui ne se pose pas dans ce contexte (cote sans objet sous ce support, bascule d'extrémités sur un objet sans bouts) | **absente** |
| Case de champ non déclarée par le sujet | **absente** — structurel depuis T10 (« pas de case sans donnée ») |

#### L'axe « Support » est une PROJECTION

On ne choisit pas « un format ET un contenu » : on choisit **l'objet physique** qu'on va coller.
`supportOf(gabarit, contenu)` le lit dans les réglages existants, `applySupport(sujet, support, …)`
l'y réécrit — et l'invariant `supportOf(applySupport(x)) === x` est verrouillé par test. **`LabelSpec`,
`LabelLayout` et `LabelHtml` n'en savent rien** : le moteur d'impression et ses cinq pièges payés le
2026-08-25 sont intacts (décision Q11.1, voie A).

| Support | Projection | Cotes réglables |
|---|---|---|
| **Étiquette plate** | gabarit ∈ {S, M, L, libre} et contenu ∈ {QR + texte, QR seul} | largeur/hauteur **sous « libre » seulement**, cote de QR quand elle est **libre** (QR seul ou cotes libres — sinon le préréglage l'impose) |
| **Tête de baie** 100 × 60 | gabarit `rack` | cote de QR |
| **Drapeau de câble** | gabarit `cable` | cote de QR — **elle seule** : toute la géométrie du drapeau en est dérivée (`flagGeometry`). La maquette y plaçait aussi Ø et longueur ; ils n'auraient aucun effet, et un contrôle sans effet est un mensonge |
| **Manchon** | contenu ∈ {repère complet, identifiant seul} (le gabarit est ignoré) | Ø du câble, longueur le long du câble (pas de QR) |

Le **couplage** que l'ancienne modale laissait à la charge de l'utilisateur est désormais écrit une
fois : choisir « Manchon » force un contenu de manchon, et choisir un contenu de manchon force le
support — dans les deux sens, par la même fonction.

#### Les codes de raison

| Code | Sens |
|---|---|
| `flag-only` | réservé aux câbles et faisceaux — ce qui s'enroule (un équipement ne s'enroule pas) |
| `rack-only` | réservé aux baies (un autre sujet qui veut du 100 × 60 passe par les cotes libres) |
| `needs-sleeve` | ce contenu demande le support « Manchon » |
| `needs-not-sleeve` | le manchon ne porte pas de QR : ces contenus lui sont fermés |
| `not-flag` | un rectangle S/M/L ne s'attache pas à un brin |
| `no-text` | le contenu choisi n'imprime aucun texte : la case (ou la bascule) est sans effet |
| `cols-capped` | colonnes plafonnées par la largeur réelle de l'étiquette |
| `roll-no-cuts` | traits de coupe sans objet sur rouleau : chaque page EST une étiquette |

- **Sujets** (`LabelPrintKind`) : `equipment`, `rack`, `cable`, **`bundle`** (faisceau/trunk — même
  anatomie que le câble : un identifiant, deux extrémités, donc le même drapeau), `spare`,
  **`subEquipment`** (même famille que le spare — `isSpareLike` : mêmes contenus, mêmes formats,
  même gabarit S par défaut ; ce qui les sépare est ce qu'ils DÉCLARENT, pas la politique).
- **Informations additionnelles** : les cases se peignent depuis les **déclarations des sujets**
  (section suivante). Ne restent STRUCTURELLES que la rangée « Identifiant (toujours) » et la
  bascule « **Extrémités A / B** » (imprimer ou non les LIGNES d'extrémité), offerte aux seuls
  sujets à drapeau. La règle **contenu × champ** (`fieldVisible`) reste ici : « QR seul » ne garde
  que les déclarations marquées `qrOnly` (la bande sous le carré, historiquement le propriétaire) ;
  « identifiant seul » ne garde rien ; un manchon « repère complet » écarte le registre `sn`.
  Chaque case porte **sa valeur à droite** : la valeur elle-même quand il n'y a qu'un sujet,
  « **déclaré par n / N** » sur une planche (montrer la valeur d'un seul déclarant pour 150
  étiquettes serait un mensonge ; l'infobulle donne celle du premier, à titre d'exemple).
- **Mémoire de session** : `sanitize(kind, offre, settings)` tourne à CHAQUE ouverture — un réglage
  hérité devenu invalide (format drapeau sur un équipement) **retombe** sur le défaut du contexte,
  les cases mémorisées sont **réconciliées** avec l'offre du tirage courant (ids disparus retirés
  — la mémoire d'une case morte ne doit pas resurgir sur un id un jour recyclé —, ids nouveaux semés
  à leur état coché DÉCLARÉ), et les réglages de tirage sont bornés (`endsMode` retombe sur `A + B`
  hors sujet à drapeau, où il est sans objet). 🚨 **T11 : la mémoire est VISIBLE** — le panneau dit
  « Réglages repris de votre dernier tirage · session » et offre « **Revenir aux défauts** ». Un
  réglage qu'on ne s'explique pas est un réglage qu'on subit. Toujours session, **jamais persisté**.

### L'étage Tirage (T11)

Le tirage cesse d'être décidé par le point d'entrée pour devenir un réglage, **devant l'aperçu**.
L'étage passe **en tête** dès que le tirage compte au moins deux étiquettes (seul déplacement
structurel du panneau), sinon il vient en quatrième.

| Réglage | Rôle |
|---|---|
| **Bascule A / B / A+B** (étage Support, sujets à drapeau) | combien de drapeaux **et** quel bout chacun MARQUE. Défaut **A+B** = le geste principal d'avant T11 |
| **Occurrences × N** (1..20, défaut 1) | « une étiquette pour la boîte, une pour le disque ». Occurrences **groupées** : sujet, puis bout, puis copie — `A, A, B, B`, et les deux drapeaux d'un même câble restent voisins sur la planche (on les découpe ensemble pour les poser ensemble) |
| **Papier : planche A4 / rouleau** | `auto` par défaut = la règle historique (1 étiquette ⇒ page à la cote exacte, ≥ 2 ⇒ planche), désormais **modifiable** : un rouleau de 5 étiquettes sort en 5 pages à la cote exacte |
| **Résolution : 203 / 300 / 600 dpi** (défaut 300) | quantifie la cote du QR — cf. « QR à modules carrés » ci-dessous |
| **Colonnes** | segments 1..8, ceux que la largeur réelle refuse étant grisés avec `cols-capped` (`LabelLayout.maxColumns` reste la règle) |
| **Traits de coupe**, **Densité** (compact / confort) | inchangés ; la densité a rejoint cet étage |

`expand(sujets, sujet, réglages)` développe la liste PLATE que la planche consomme — `LabelLayout`
n'a rien à savoir de tout ceci. `paperOf(papier, nombre)` dit le régime effectif.

### Les deux registres d'avertissement (T11)

Les cinq codes de débordement (plus le sixième, ci-dessous) sont **classés**, pas empilés —
`warningRegister(code)` est une classification pure :

| Registre | Codes | Où, et pourquoi |
|---|---|---|
| **Risque de scan** | `qr-floor`, `qr-exceeds-label`, `sleeve-tight`, `module-too-small` | **collé sous l'aperçu**, bordure d'accent chaud, formulation à conséquence — ça compromet l'objet imprimé, et ça se voit sur l'aperçu |
| **Conséquence de tirage** | `columns-capped`, `multi-page` | **au pied**, à côté du bouton, ton neutre — ça ne compromet rien, ça décrit ce qui va sortir de l'imprimante |

**« Imprimer » reste toujours actif** : on imprime pour son propre usage, jamais pour satisfaire une
règle.

### QR à modules carrés (Q11.14)

**Le défaut signalé** : « *la taille la plus petite du QR produit un QR illisible — chaque ligne du
QR est altérée et ne produit plus des pixels de QR carrés* ». Le diagnostic, en trois lignes :

1. La librairie `qrcode` ne dessine **pas des carrés** mais un **trait horizontal par rangée**
   (`M4 4.5h7…`, `stroke-width` 1), d'où des coordonnées en **demi-module**.
2. `shape-rendering="crispEdges"` — imposé le 2026-08-25 contre l'amincissement — colle chaque
   rangée à la grille de sortie **indépendamment** : à 3,1 px par module (gabarit S sur thermique
   203 dpi), les rangées alternent 3 et 4 px et les centres en `.5` font se chevaucher ou s'écarter
   deux rangées voisines.
3. Un module n'est un carré **qu'à un nombre ENTIER de pixels de sortie**, et seulement si on le
   dessine comme un carré. C'est une question **physique**, pas logicielle.

**Les quatre mesures** :

- **Serveur** (`src-server/QrSvg`) : la route `/qr?format=svg` n'appelle plus `QRCode.toString` mais
  récupère la **matrice** (`QRCode.create`) et émet **notre** SVG — un carré unitaire
  `M x y h1 v1 h-1 z` par module sombre, coordonnées **entières**, réunis dans un seul `<path>`,
  fond blanc plein cadre. Arêtes partagées, snapping cohérent sur les deux axes. **Quiet zone de
  4 modules inchangée**, et `LabelQrSvg.detectMarginModules` continue de la lire à 4 (verrou de test :
  si l'émetteur cassait cette lecture, `scaleToMm` croirait la quiet zone insuffisante et rétrécirait
  le QR en silence).
- **Client** (`LabelLayout.quantizeQrMm`) : la cote servie est **quantifiée** à un nombre entier de
  pixels par module pour la résolution choisie — `px/module = ⌊(mm ÷ 25,4 × dpi) ÷ modules⌋`, puis
  `mm = modules × px/module × 25,4 ÷ dpi`. **Arrondi vers le bas** : le QR rétrécit d'au plus un
  pixel par module, donc il tient toujours dans la boîte qui l'attendait. Sans dpi (les goldens de
  gabarits), `renderQrMm` rend exactement ce qu'il rendait.
- **Nouvel avertissement `module-too-small`** (registre « risque de scan ») : émis quand la cote
  **servie** rapportée au nombre de modules tombe sous **0,5 mm**. Le plancher de 18 mm parle de la
  cote TOTALE ; il est déjà trop optimiste à 41 modules (l'URL d'une fiche, ~70 caractères en EC « M »,
  donne une version 4 = 33 modules + 2 × 4 de quiet zone). Signalé, **jamais interdit**.
- **Export PNG** : le QR est rasterisé **depuis la matrice** à k pixels entiers par module, jamais
  par mise à l'échelle du SVG (cf. section suivante).

> ⚠ **Limite assumée, et le vrai levier.** À 41 modules, il faut **20,5 mm** de QR pour tenir le
> plancher de 0,5 mm : le gabarit M (20 mm) et le S (18 mm) le franchissent quelle que soit la
> résolution — monter le dpi réduit la *perte de quantification*, il ne crée pas de place. Le levier
> est de **raccourcir le payload** : une route courte `/q/<id>` au lieu du deep-link complet ferait
> tomber la version 4 → 3 (33 → 29 modules, +14 % de taille de module). Cela touche `EntityLink` et
> le scan — **hors périmètre**, à instruire à part.

### Export en images (Q11.13)

Bouton « **Exporter en images** » au pied, à gauche d'Imprimer, sous la même garde que l'impression
(mode API — le QR vient du serveur).

- **Une image PAR étiquette**, en **PNG** (un QR est du trait pur : le JPEG y fabrique le halo qui
  fait rater un scan). Le besoin est de « *les ajouter moi-même dans un document* », donc une à une.
- **N > 1 ⇒ une archive ZIP** (`@zip.js/zip.js`, déjà en dépendance) : un navigateur qui reçoit 150
  téléchargements demande 150 confirmations. Les noms sont **cadrés** (`planche-001.png`) — un
  dossier se trie `1, 10, 100, 11…`, et l'ordre de la planche EST l'ordre de pose.
- **Option « la planche entière »** quand le tirage est une planche : une image par feuille A4, le
  même `sheetPage` que l'aperçu et que l'imprimé.
- **Fidélité par construction** : on rasterise le **même HTML** (`LabelHtml`), enveloppé dans un
  `<foreignObject>` avec la même CSS et la même fonte embarquée. Aucun second rendu, donc aucune
  divergence possible — c'est pourquoi la voie « produire un SVG vectoriel de l'étiquette » a été
  écartée (deux sources de vérité pour le même dessin, cinq pièges à repayer sur la seconde).
- 🚨 **XML strict** : un SVG chargé comme image est parsé en XML, pas en HTML. Le HTML d'étiquette
  n'étant pas du XHTML (balises vides, entités, `<`/`&` dans le `<style>`), l'enveloppe est
  construite dans le DOM puis **sérialisée par `XMLSerializer`** (namespace XHTML posé, balises
  auto-fermées, contenu échappé) avant d'entrer dans le `<foreignObject>` — sinon le document est
  rejeté et l'export échoue (« SVG illisible »).
- 🚨 **Le QR vient de la MATRICE** (`?format=matrix`, JSON `{ size, margin, rows }`), peinte sur un
  canvas à k pixels entiers par module : la boîte du QR fait `k × modules` pixels **exactement**, ses
  modules sont carrés par construction, sans dépendre d'aucun moteur de rendu.
- ⚠ **Safari** salit le canvas dès qu'un `foreignObject` entre dans le SVG et refuse l'export
  (`SecurityError`). Aucun contournement propre : on attrape et on le **dit** (« export non pris en
  charge par ce navigateur »), plutôt que de produire des étiquettes fausses par un repli dégradé.

### Champs déclarés par SUJET (retour terrain T10, 2026-09-02)

Le retour était : « *les QR des sous-équipements et des spares ne reprennent pas les bonnes infos ;
il faut rendre dynamiques les éléments récupérables et imprimables, **ils diffèrent d'un élément à
l'autre*** ». La cause n'était pas un mauvais câblage mais le **modèle** : le sujet portait quatre
champs FIGÉS (`location`, `typeLabel`, `serial`, `owner`) distribués par une matrice par `kind`
(`offeredFieldsFor`/`defaultFieldsFor`). Toute donnée hors de ces quatre noms était **inimprimable**
— la capacité d'un disque, la portée d'un transceiver, une date d'achat n'avaient simplement aucun
nom où se poser.

**Le modèle (décision Q10.B).** Chaque `LabelSubject` **déclare** ses champs imprimables :

```ts
interface LabelFieldDecl {
  id: string;        // identité STABLE — clé de la mémoire de session ET de l'union de planche
  label: string;     // libellé de la case, déjà localisé (catalogue labels.field.*)
  value: string;     // valeur composée à imprimer — non vide PAR CONSTRUCTION
  checked: boolean;  // cochée au premier tirage du contexte
  style: "loc" | "meta" | "sn" | "own";   // registre typographique de la ligne (classes .l-* héritées)
  hideOnSmall?: boolean;   // ligne supprimée au gabarit S
  qrOnly?: boolean;        // survit au contenu « QR seul » (bande sous le carré)
}
```

La modale **se peint** depuis ces déclarations : elle ne connaît plus aucun champ par son nom, et la
**matrice de cases a disparu** de `LabelPrintPolicy` (une résurrection d'`offeredFieldsFor` serait
une régression du modèle — c'est verrouillé par un test). Le rendu (`LabelHtml`) consomme la même
liste : une ligne par déclaration cochée, dans le registre déclaré. Les registres typographiques,
eux, n'ont PAS bougé — les nouveaux venus du petit matériel se posent dans les classes `.l-loc` /
`.l-meta` / `.l-sn` / `.l-own` existantes (le CSS du gabarit S a seulement reçu les tailles `meta`
et `sn`, qu'il n'avait jamais eu à donner).

🚨 **« Pas de case sans donnée » devient STRUCTUREL (décision Q10.C).** Ce n'était qu'un garde-fou
d'interface, tenu à la main dans la matrice ; c'est désormais une règle de **construction** : un
sujet **ne déclare pas** un champ à valeur vide, donc la case n'existe pas, donc la ligne non plus.
Les deux chemins d'avant (case décochée / valeur vide) convergent vers le même imprimé. Corollaire
assumé : un câble sans type ni longueur n'offre plus **aucune** case là où l'ancienne UI en
proposait une qui n'imprimait rien. **Pas de plafond dur** de champs : les garde-fous existants
suffisent (lignes vides absentes, avertissements de gabarit `multi-page`/`qr-exceeds-label`), et les
DÉFAUTS restent sobres.

**Union d'une planche HÉTÉROGÈNE** (`LabelPrintPolicy.fieldOffer`). Une planche peut mélanger des
sujets qui ne déclarent pas la même chose — c'est le cas nominal du **panier** (famille
`components` = spares *et* sous-équipements ; et deux spares de TYPES différents ne déclarent déjà
pas les mêmes caractéristiques). L'offre du tirage est donc l'**UNION** des déclarations, dans
l'ordre de première apparition : un id déclaré par **au moins un** sujet a sa case ; libellé et état
coché viennent du **PREMIER déclarant** (règle assumée : déterministe — l'ordre d'une planche est
celui du panier ou du contenu de baie —, et sur une planche homogène, le cas courant, tous les
déclarants disent la même chose). Au rendu, **un sujet qui ne déclare pas un id coché saute la
ligne** : c'est ce qui rend la planche mixte sûre sans le moindre cas particulier.

**Les contenus décidés (Q10.A).**

| Sujet | Cases déclarées (ordre) | Cochées par défaut |
|---|---|---|
| **spare** | `type` (SpareTypes) · **`characteristics`** · `brandModel` (`brand`+`model_pn`) · `serial` · `purchase` (`purchase_date` · BC `po_ref`) · `storage` (`storage_location`) | toutes **sauf `storage`** |
| **sous-équipement** | `master` (le maître · le repère `slot`) · `brandModel` · `serial` · `purchase` | toutes |
| **équipement** | `location` · `type` · `serial` · `owner` | `location` seule — **inchangé** |
| **baie** | `location` (la salle) · `type` (« Baie *N*U ») | les deux — **inchangé** |
| **câble / faisceau** | `type` (+ extrémités A/B **structurelles**, hors liste) | `type` — **inchangé** |

- 🚨 **`characteristics` est UNE seule case, à valeur composée SELON LE TYPE** — c'est le cœur du
  « ils diffèrent d'un élément à l'autre » : disque = capacité · interface · format · rpm ;
  transceiver = forme · débit · média · portée ; autre = `specs` libres. La composition n'est PAS
  réécrite ici : c'est `Spare.techSummary()` du modèle, déjà source unique du listing et de la
  désignation automatique (principe n°3).
- **`storage` est OFFERT mais DÉCOCHÉ** : la liste de l'utilisateur énumérait les champs *cochés*,
  et retirer le stockage de l'**offre** aurait été une régression silencieuse vs l'étiquette
  d'avant. **Statut et attribution ne sont PAS déclarés** (non cités — une étiquette de terrain
  n'est pas une fiche de suivi).
- **Le sous-équipement n'imprime PAS `warranty_end`** (décision explicite) ni de `type` de
  substitution : la collection n'a pas de champ `type`, sa spec dit que « la sémantique est dans le
  nom » — on n'en fabrique pas un.
- **Équipement, baie, câble et faisceau : offres, défauts et imprimé STRICTEMENT inchangés** — c'est
  une décision, et elle est verrouillée par une section de non-régression écrivant EN DUR les
  valeurs d'avant T10 (dont `hideOnSmall` sur type/série d'un équipement et `qrOnly` sur le
  propriétaire).

⚠ **Corollaire CSS indissociable** : `.label-print [hidden] { display: none !important }`
(`dc-manager.css`). Sans cette ligne les `hidden` de la modale sont **inertes** — `[hidden]` vient
de la feuille du NAVIGATEUR, et toute règle d'auteur qui pose un `display` la bat, quelle que soit
sa spécificité ; or `.btn`, `.lp-num`, `.lp-mm` et `.lp-field` en posent une. C'était la cause
première du retour terrain de 2026-08-20. ⚠ **T11 : `hidden` ne cache plus aucun VERDICT** — il ne
sert qu'aux questions structurellement sans objet dans le contexte (cf. « Disponibilité avec raison »).

### Le repère du bout local (Q11.2)

Jusqu'à T11, les deux drapeaux d'une paire étaient **rigoureusement identiques** : rien ne disait au
poseur lequel allait à quelle extrémité — et une bascule A / B / A+B n'aurait eu, dans ces
conditions, qu'une seule valeur utile. `LabelFieldChoice` gagne donc `localEnd` : la ligne du bout
que **cette** étiquette habille est pointée d'un « ▶ » et mise en gras.

**Aucune cote ne bouge** : c'est un marquage sur une ligne DÉJÀ rendue, pas une ligne de plus (les
goldens de géométrie le verrouillent). Le marquage vaut aussi pour le **manchon « repère complet »**,
qui habille lui aussi un seul bout.

> ⚠ **Limite assumée** : quand la bascule « Extrémités A / B » est **décochée**, il n'y a plus de
> lettre à pointer — les drapeaux d'une paire redeviennent indiscernables. C'est le prix de la règle
> « aucune cote ne bouge » : ajouter une ligne de repère ferait déborder les petits gabarits.

### Points d'entrée (tous sous `LabelPrintDialog.available()`)

**Neuf** depuis T11 : « Un drapeau » et « Imprimer les 2 extrémités » ont fusionné sur les fiches câble et
faisceau — c'était une décision de même nature que toutes celles de la modale, et elle se prenait
avant d'avoir vu le moindre aperçu.

| Où | Geste |
|---|---|
| Fiche équipement | « Imprimer l'étiquette » (pied de fiche) |
| Listing équipements | Action de ligne « Imprimer l'étiquette » (menu ⋮ — les actions secondaires de ligne y vivent toutes, cf. `ListView._openRowMenu`) |
| Fiche baie | « Étiquette de baie » (gabarit Baie) **et** « Planche du contenu (N) » (masquée si vide) — deux gestes distincts, deux papiers |
| Fiche câble | « **Étiqueter…** » — un seul geste (T11) : *combien* de drapeaux et *quel bout* se décident dans la modale (bascule A / B / A+B, défaut **A+B**) |
| Listing câbles | Action de ligne « Imprimer l'étiquette » — **un sujet**, défaut A+B comme la fiche |
| Fiche faisceau | « **Étiqueter…** » — idem (les deux bouts sont les deux patchs terminaux) |
| Listing faisceaux | Action de ligne « Imprimer l'étiquette », comme les câbles |
| Fiche spare | « Imprimer l'étiquette » (gabarit S par défaut) |
| Listing spares | Action de ligne « Imprimer l'étiquette » (parité avec la fiche) |
| Fiche sous-équipement | « Imprimer l'étiquette » — sujet `subEquipment`, MÊME famille que le spare (`isSpareLike`, gabarit S par défaut) ; ses cases sont celles qu'il DÉCLARE (maître · repère, marque/modèle, série, achat — cf. « Champs déclarés par sujet ») |
| Listing sous-équipements | Action de ligne « Imprimer l'étiquette » |
| **Panier** (topbar) | « Imprimer les étiquettes (N) » — planche d'un lot préparé par les cases des listings (familles `links`, `components`, `equipments` — cf. `core/CartLabelPlan`). 🚨 **T11 : UN sujet par élément** — c'est la bascule de la modale qui multiplie (`defaultEndsMode: "ab"` pour les liens), la volumétrie restant réglable devant l'aperçu. 🚨 **Seul point d'entrée à planche HÉTÉROGÈNE** : l'offre de cases y est l'UNION des déclarations. Cf. [`panier.md`](panier.md) |

### Rendu d'impression

> 🚨 **Trois pièges d'impression mesurés le 2026-08-25** (l'aperçu était juste, le PAPIER ne l'était
> pas). Ils ne venaient d'aucune « transformation » : l'aperçu et l'imprimé partagent déjà le même
> HTML et le même CSS, et le seul `transform: scale()` est celui de l'aperçu de PLANCHE (un
> `transform` ne recompose rien).
>
> 1. **QR « rogné » au plus petit gabarit.** La lib `qrcode` ne dessine pas des carrés mais des
>    **traits** — une commande horizontale par rangée de modules (`M4 4.5h7…`, d'où les demi-modules),
>    rendue au trait d'un module de large. Anti-aliasées par défaut puis ramenées sur la grille de
>    sortie, ces rangées perdent du noir à chaque bord et la plus fine disparaît. Correctif :
>    `shape-rendering="crispEdges"` posé par `LabelQrSvg.scaleToMm` — propriété de RENDU, aucune
>    géométrie touchée.
> 2. **Hachures absentes du papier.** Les zones de recouvrement des manchons/drapeaux sont peintes en
>    `repeating-linear-gradient`, donc en **image de fond** — que le navigateur SUPPRIME à
>    l'impression sauf « Graphiques d'arrière-plan ». Correctif : `print-color-adjust: exact` sur
>    `.label-render` (propriété héritée, elle couvre tout le rendu et fige aussi les gris).
> 3. **Traits de coupe brouillons.** Une bordure sur les quatre côtés de chaque cellule faisait se
>    toucher le bord droit d'une cellule et le bord gauche de la suivante : trait intérieur deux fois
>    plus épais que le pourtour, et deux pointillés calés chacun sur sa propre phase. Correctif :
>    **un trait par arête** — chaque cellule ne peint que son bord droit et son bord bas, la première
>    rangée et la première colonne ajoutant le pourtour manquant (`cut-t`/`cut-l`, posés par
>    `LabelHtml.sheetPage` qui seul connaît `cols` et l'index).
>
> **Suite (même journée) — le rectangle de coupe ÉPOUSE l'étiquette.** Deux défauts restants tenaient
> à la même cause : la cellule n'avait pas la taille de ce qu'elle contient.
> · Les colonnes étaient en **`1fr`**, donc larges de 194/cols mm quelle que soit l'étiquette — un
>   manchon de 28 mm se retrouvait centré dans une colonne de 65 mm, et couper sur les traits laissait
>   deux bandes de papier mort. La cellule porte désormais sa **largeur réelle**, les pistes sont en
>   `auto` et la grille est calée à gauche (`justify-content:start` — sans quoi des pistes `auto`
>   s'étirent pour remplir la page et le `1fr` revient par la bande).
> · En **`border-box`**, le trait de 0,2 mm était **pris sur la cellule** : son contenu tombait à
>   24,8 mm pour une étiquette de 25, qui débordait donc et arrivait au contact du trait — or un
>   enfant est peint APRÈS la bordure de son parent, d'où un trait masqué sur la largeur de
>   l'étiquette. La cellule est passée en **`content-box`** : la cote posée est celle de l'étiquette,
>   les traits se dessinent en dehors d'elle.
> Effet de bord assumé : les traits ajoutent ≤ 0,2 mm par cellule (~1 mm sur une rangée de 5), pris
> sur la marge de 8 mm de la page, jamais sur l'étiquette.
>
> **Suite — pourquoi « le même HTML » ne suffit pas.** Deux défauts restaient, tous deux nés du fait
> que le navigateur **refait la mise en page contre les métriques de l'imprimante** : « HTML direct »
> ne veut pas dire « mêmes pixels ».
> · **Traits qui sautent.** 🚨 **L'épaisseur était la cause** — trouvée par la reproduction de
>   l'utilisateur : *le défaut apparaît et disparaît selon le **zoom du navigateur***. Signature d'un
>   filet **sous-pixel** : 0,2 mm ≈ 0,76 px CSS, donc selon l'endroit où chaque ligne tombe, le
>   rasteur en met 1 pixel… ou 0. Les traits n'étaient pas recouverts : ils n'étaient pas dessinés.
>   `LabelLayout.CUT_MM` passe à **0,5 mm** (≈ 1,9 px — survit à l'arrondi même à 50 % d'échelle,
>   et c'est la cote des planches d'étiquettes du commerce), et devient une **source unique** :
>   `LabelHtml.CSS` l'interpole, la capacité de la planche la compte. Le trait vit dans la
>   **gouttière** de la grille (`gap`), il sépare donc réellement deux cellules au lieu de mordre sur
>   l'étiquette voisine — une rangée occupe N cellules + (N − 1) gouttières, les traits du pourtour
>   étant tirés dans la marge de 8 mm.
>   *Trois correctifs antérieurs sont conservés, justes en eux-mêmes mais qui n'expliquaient pas le
>   symptôme* : passage en **solide** (un pointillé de 0,2 mm fait ~50 tirets par bord), cellule en
>   **`content-box`** (la cote posée est celle de l'étiquette), et trait porté par un **`::after`
>   absolu** — un pseudo-élément positionné se peint après le contenu en flux, donc hors de portée
>   de tout fond opaque ; corollaire, `.cell` n'a plus d'`overflow:hidden`.
> · **Chiffres inégalement espacés.** Deux causes cumulées : `system-ui` et `ui-monospace` sont des
>   familles **résolues par le système** — rien ne garantit que le chemin d'impression retienne la
>   même police que l'écran, et une autre police a d'autres chasses ; et `letter-spacing:-.02em`,
>   fractionnaire et négatif, s'arrondissait différemment d'une paire de glyphes à l'autre une fois
>   les avances ramenées aux points de l'imprimante. Le crénage est nul,
>   `text-rendering:geometricPrecision` demande des avances **exactes** plutôt qu'ajustées à la
>   grille, et `font-variant-numeric:tabular-nums` impose des chiffres de **largeur égale**.
>   🚨 Surtout, la fonte est désormais **EMBARQUÉE** dans le document d'impression
>   (`ui/LabelFontAssets` → `LabelHtml.fontFaceCss`, data: URI) : c'est la seule façon d'ÊTRE SÛR
>   que les deux surfaces dessinent avec la même fonte, plutôt que d'espérer que le système
>   choisisse la même des deux côtés. Les woff2 sont ceux, déjà vendorés et OFL, de la feuille de
>   l'app — aucun asset nouveau, aucune requête réseau.
>   ⚠ **Découpe imposée par les tests** : un `import … from "*.woff2"` n'est une chaîne que sous
>   webpack, or `ui/LabelPrintDialog` est chargé sous Node par la suite de tests (via la chaîne des
>   fiches). Les assets vivent donc dans `ui/LabelFontAssets`, que seul `app/main.ts` importe — et
>   la modale reçoit le bloc `@font-face` par **injection** (`LabelPrintHost.fontCss`).
>   ⚠ **Aucune monospace n'est vendorée** : `--lp-mono` retombe sur Plex Sans, donc les identifiants
>   perdent leur chasse fixe (les chiffres, eux, restent alignés par `tabular-nums`). Déposer
>   `IBMPlexMono-latin-*.woff2` dans `src-client/fonts/` et l'ajouter à `LABEL_FONT_FACES` suffirait.


Les QR viennent de `GET <dataBase>/qr/:collection/:id?format=svg` (`RestAdapter.qrSvg` — fetch
dédié : la réponse est du SVG brut, hors protocole JSON), mis à l'échelle en mm par `LabelQrSvg`
puis **inlinés** dans un document print-CSS **isolé** (iframe cachée) : **rouleau** =
`@page { size: <w>mm <h>mm; margin: 0 }` et **une page par étiquette** (T11 — même à N), **planche**
= A4 + grille + traits de coupe. Tout étant inline, `print()` n'attend que le `load` de l'iframe.
Les SVG sont tirés en parallèle et mis en cache le temps de la modale ; un échec (503
`PUBLIC_BASE_URL` absente, 404…) affiche le message serveur et désactive « Imprimer ».

La route sert un **troisième format**, `?format=matrix` (`RestAdapter.qrMatrix`) : la matrice de
modules en JSON `{ size, margin, rows }`, consommée **à la demande** par l'export en images — un
tirage qu'on imprime sans exporter ne paie aucun aller serveur de plus. `?size=` n'y a aucun effet
(ce n'est pas une image).

**Zéro marge parasite** (vérifié par test) : `@page … margin: 0` dans les DEUX régimes, et
`html, body { margin: 0; padding: 0 }` dans l'iframe — les cotes de l'étiquette sont la seule
géométrie qui compte, une marge de document décalerait tout un rouleau. Les 8 mm de marge d'une
planche appartiennent à la **grille A4**, pas à la page.

### Mode local

L'impression d'étiquettes est **mode API seulement** (la génération des QR est serveur, décision
§ 2.1 du GO — écart au principe n°15 assumé). Mécanisme : patron **injection nulle**
(`AccessState`/`HydrationState`) — `LabelPrintDialog.setup(...)` n'est appelé par `main.ts` QU'EN
mode API ; partout ailleurs `LabelPrintDialog.available()` rend faux et TOUTES les entrées
d'impression (fiches, action de ligne) restent masquées. **Un seul test de mode**, dans `main.ts` —
aucun test dispersé.

Tests : `Tests/modules/test-labels.js` (gabarits golden, géométrie drapeau/manchon, cellule de
planche et plafonds, bornes du personnalisé, codes de débordement, quiet zone du SVG, rendu HTML
partagé — échappement, `@page`, zéro token de thème dans l'imprimé ; **densités amendées et
NON-DÉBORDEMENT du QR sur tous les préréglages × les deux densités**, cotes retrouvées au millimètre
dans le HTML, marges de la fenêtre d'impression, offres par sujet, retombée sur défaut, sujet
FAISCEAU ; **manchons** : goldens de l'enroulement par Ø (3/6/10/20), invariants « largeur = 1,5 ×
tour » et « visible = un tour », dérivation et bornes du nombre de cases, et 🚨 **égalité STRICTE des
cases mesurée dans le HTML généré**).

**T11** ajoute, dans le même fichier : la **projection** support ⇄ (gabarit, contenu) et son
invariant aller-retour sur tous les sujets × tous les supports disponibles ; la **disponibilité avec
raison** (qui REMPLACE l'ancienne section « LA matrice » — le verrou n'a pas été supprimé, il a été
réécrit pour le nouveau verdict) ; les **registres** d'avertissement et leur exhaustivité ; **`expand`**
(groupement `A, A, B, B` et sujet en boucle extérieure) et le **papier** ; le `sanitize` des nouveaux
réglages ; la **quantification** du QR et sa non-régression sans dpi ; l'avertissement **`module-too-small`** ;
le **repère du bout local** dans le HTML rendu (avec la preuve que les cotes n'ont pas bougé) ; le
plan d'**export** (`core/LabelExportPlan`) ; et des **verrous sur les sources** (patron T2-B1) : la
modale ne réécrit aucune règle de disponibilité, aucun `hidden` n'est posé depuis un verdict,
`DetailForms` n'a plus qu'une entrée drapeau par fiche, `main.ts` ne duplique plus les sujets du
panier, tout code de refus a sa phrase dans les DEUX langues, et la CSS de la modale n'a aucune
couleur en dur. Côté serveur, `Tests/modules/test-qr-params.js` verrouille l'émetteur **`QrSvg`**
(carrés à coordonnées entières, un seul chemin, quiet zone toujours lue à 4 par `LabelQrSvg`) et le
format `matrix` dans la liste blanche.
