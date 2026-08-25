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
(écart au principe n°15 assumé, cf. « Mode local » de la section suivante pour le mécanisme de
masquage). Le SCAN, lui, fonctionne dans les deux modes (cf. « Mode local » ci-dessus).

## Étiquettes imprimables

La maquette `design-system/briefs/qr-etiquettes-imprimables-maquette.html` **fait foi** (gabarits,
anatomie, flux), amendée par les décisions du cadrage E (2026-08-20) — notées ci-dessous. **Un seul
écran de sortie** : la modale d'impression `ui/LabelPrintDialog` (pile de modales standard, principe
n°11) ; ce qui change entre les points d'entrée est ce qu'elle **reçoit** (`LabelPrintContext` — un
objet, les deux extrémités d'un câble, le contenu d'une baie).

### Découpe des modules

| Module | Rôle |
|---|---|
| `core/LabelLayout` | **Géométrie PURE** (mm) : table des gabarits (cotes EXACTES de la maquette), **densités** (padding/gouttière), drapeau **dérivé du QR**, manchon (**1,5 tour, le demi-tour EST le recouvrement** + nombre de cases DÉDUIT), QR seul, **cellule de planche ≠ étiquette**, plafond de colonnes, capacité A4, bornes du personnalisé, **débordement en CODES** (`LabelWarning` — l'UI traduit) |
| `core/LabelPrintPolicy` | **LA matrice de visibilité contextuelle** (pure) : contenus/formats/défauts/cases OFFERTS par sujet, **verdict** `visibility(sujet, contenu, format, nombre)` consommé tel quel par la modale, et `sanitize` qui fait RETOMBER un réglage mémorisé devenu invalide |
| `core/LabelQrSvg` | Retravail PUR du SVG servi par `/qr` : **quiet zone vérifiée** (marge en modules lue dans le tracé) et **compensée par un padding blanc calculé** si < 4 modules (un `?size=` plus grand n'y changerait rien — propriété en modules, pas en pixels), mise à l'échelle en mm |
| `core/LabelHtml` | Rendu HTML PUR **partagé aperçu ⇄ imprimé** (une seule source, fidélité par construction) : étiquette, page de planche, document d'impression. **Noir sur blanc, aucun token de thème** ; les COTES (padding/gouttière) sont posées INLINE depuis `LabelLayout` |
| `core/LabelSubjects` | La matière d'une étiquette depuis un enregistrement (lecteur injecté) : équipement (« baie · U »), baie, câble (A/B = **ordre de la fiche**), **faisceau** (A/B = les deux patchs terminaux), spare — la règle écrite UNE fois pour tous les points d'entrée |
| `ui/LabelPrintDialog` | La modale : panneau de réglages + aperçu fidèle réduit + avertissements + iframe d'impression. **N'écrit AUCUNE règle de visibilité** — elle applique le verdict de `LabelPrintPolicy` (pose `hidden`). Réglages **mémorisés en session** par contexte (jamais de Prefs persistées — dernier tirage repris) |

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
- **Câbles** : le geste principal imprime **les 2 extrémités** (deux drapeaux identiques), « Un
  drapeau » reste offert ; sens A → B = l'**ordre de la fiche** (from → to).

### Matrice de visibilité contextuelle (`core/LabelPrintPolicy`)

Le retour terrain était « **tous les contrôles dans tous les contextes** » : Ø de câble sur une baie,
largeur/hauteur personnalisées sous un préréglage… La règle « quels contrôles pour (sujet, contenu,
format, nombre) ? » était éparpillée dans le rendu DOM, donc invérifiable — elle vit désormais dans
UN module pur, et la modale ne fait plus qu'**appliquer le verdict** (poser `hidden`).

- **Sujets** (`LabelPrintKind`) : `equipment`, `rack`, `cable`, **`bundle`** (faisceau/trunk — même
  anatomie que le câble : un identifiant, deux extrémités, donc le même drapeau), `spare`.
- **Contenus** : les manchons (repère complet / identifiant seul) n'existent que pour ce qui
  s'ENROULE — câble et faisceau ; un équipement ne s'enroule pas.
- **Formats** : « Câble — drapeau » = câble/faisceau seulement (et réciproquement : un rectangle
  S/M/L ne s'attache pas à un brin) ; « Baie » 100×60 = baies seulement (un autre sujet qui veut ces
  cotes passe par « Personnalisé »).
- **Cotes mm** : Larg./Haut. **uniquement** sous « Personnalisé » ; la cote de QR quand elle est
  LIBRE (QR seul, drapeau, personnalisé — sinon le préréglage l'impose) ; Ø et longueur
  **uniquement** pour les manchons. La rangée entière disparaît quand aucune ne s'applique.
- **Informations additionnelles** (ex-« Lisible humain », renommé sur retour terrain) : les cases
  offertes sont **ce que le sujet POSSÈDE** (pas de n° de série sur une baie ni sur un faisceau, pas
  de propriétaire hors équipement — une case sans donnée est un mensonge d'interface), intersectées
  avec les règles du contenu (« QR seul » ne garde que le propriétaire ; « identifiant seul » ne
  garde rien, section comprise). Le libellé « Emplacement » devient « **Extrémités A / B** » pour
  les sujets à drapeau.
- **Planche** : à partir de 2 étiquettes.
- **Mémoire de session** : `sanitize(kind, settings)` tourne à CHAQUE ouverture — un réglage hérité
  devenu invalide (format drapeau sur un équipement, case d'un champ inexistant) **retombe** sur le
  défaut du contexte, plutôt que de laisser un état que l'UI ne sait plus représenter.

⚠ **Corollaire CSS indissociable** : `.label-print [hidden] { display: none !important }`
(`dc-manager.css`). Sans cette ligne les `hidden` de la modale sont **inertes** — `[hidden]` vient
de la feuille du NAVIGATEUR, et toute règle d'auteur qui pose un `display` la bat, quelle que soit
sa spécificité ; or `.btn`, `.label-print-fset`, `.label-print-mm` et `.label-print-mm-field` en
posent une. C'était la cause première du retour terrain.

### Points d'entrée (tous sous `LabelPrintDialog.available()`)

| Où | Geste |
|---|---|
| Fiche équipement | « Imprimer l'étiquette » (pied de fiche) |
| Listing équipements | Action de ligne « Imprimer l'étiquette » (menu ⋮ — les actions secondaires de ligne y vivent toutes, cf. `ListView._openRowMenu`) |
| Fiche baie | « Étiquette de baie » (gabarit Baie) **et** « Planche du contenu (N) » (masquée si vide) — deux gestes distincts, deux papiers |
| Fiche câble | « Un drapeau » / « Imprimer les 2 extrémités » |
| Listing câbles | Action de ligne : les **2 extrémités** (le geste principal de la fiche — un câble s'étiquette par paire, la ligne n'a pas de raison d'en offrir un demi) |
| Fiche faisceau | « Un drapeau » / « Imprimer les 2 extrémités » (les deux patchs terminaux) |
| Listing faisceaux | Action de ligne : les **2 extrémités**, comme les câbles |
| Fiche spare | « Imprimer l'étiquette » (gabarit S par défaut) |
| Listing spares | Action de ligne « Imprimer l'étiquette » (parité avec la fiche) |
| Fiche sous-équipement | « Imprimer l'étiquette » — sujet `subEquipment`, MÊME anatomie que le spare (`isSpareLike`) : emplacement = le maître puis le repère `slot`, type = marque + modèle (la collection n'a pas de champ `type`) |
| Listing sous-équipements | Action de ligne « Imprimer l'étiquette » |
| **Panier** (topbar) | « Imprimer les étiquettes (N) » — planche d'un lot de câbles/faisceaux préparé par les cases des listings, DEUX drapeaux par lien. Cf. [`panier.md`](panier.md) |

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
> · **Traits qui sautent.** Un pointillé de 0,2 mm produit une cinquantaine de tirets par bord, et le
>   rasteur d'impression en escamote — invisible à l'écran, criant sur le papier. Les traits sont
>   désormais **SOLIDES** : un trait plein ne peut pas sauter, et ses segments se raccordent sans
>   décalage de phase d'une cellule à l'autre. On perd la convention « pointillé = à découper », on
>   gagne un repère fiable.
> · **Chiffres inégalement espacés.** Deux causes cumulées : `system-ui` et `ui-monospace` sont des
>   familles **résolues par le système** — rien ne garantit que le chemin d'impression retienne la
>   même police que l'écran, et une autre police a d'autres chasses ; et `letter-spacing:-.02em`,
>   fractionnaire et négatif, s'arrondissait différemment d'une paire de glyphes à l'autre une fois
>   les avances ramenées aux points de l'imprimante. Les piles nomment maintenant des familles
>   **concrètes**, le crénage est nul, `text-rendering:geometricPrecision` demande des avances
>   **exactes** plutôt qu'ajustées à la grille, et `font-variant-numeric:tabular-nums` impose des
>   chiffres de **largeur égale** même si une police proportionnelle finit par gagner.


Les QR viennent de `GET <dataBase>/qr/:collection/:id?format=svg` (`RestAdapter.qrSvg` — fetch
dédié : la réponse est du SVG brut, hors protocole JSON), mis à l'échelle en mm par `LabelQrSvg`
puis **inlinés** dans un document print-CSS **isolé** (iframe cachée) : unitaire =
`@page { size: <w>mm <h>mm; margin: 0 }`, planche = A4 + grille + traits de coupe. Tout étant
inline, `print()` n'attend que le `load` de l'iframe. Les SVG sont tirés en parallèle et mis en
cache le temps de la modale ; un échec (503 `PUBLIC_BASE_URL` absente, 404…) affiche le message
serveur et désactive « Imprimer ».

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
dans le HTML, marges de la fenêtre d'impression, **la matrice de visibilité** — offres par sujet,
verdict, retombée sur défaut — et le sujet FAISCEAU ; **manchons** : goldens de l'enroulement par Ø
(3/6/10/20), invariants « largeur = 1,5 × tour » et « visible = un tour », dérivation et bornes du
nombre de cases, et 🚨 **égalité STRICTE des cases mesurée dans le HTML généré** — la régression du
retour terrain).
