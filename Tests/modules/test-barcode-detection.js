/* Tests modules — MOTEUR DE SCAN caméra (`core/BarcodeDetection`, lot A du chantier étiquettes QR).

   Le moteur enveloppe les deux sources de décodage (BarcodeDetector natif / ponyfill zxing-wasm
   inliné) derrière une seule classe — cf. docs/qr-scan.md. Ses imports du paquet et du binaire sont
   PARESSEUX (webpackMode eager) : le module compilé se charge donc ici, en Node CommonJS, SANS
   navigateur, et ses parties PURES se testent par injection :
     - `BarcodeSourcePolicy`    : décision auto/wasm (natif présent / absent / présent-mais-0-format,
                                  ce dernier cas MESURÉ sur Chromium sans décodeur OS) + intersection
                                  des formats demandés ∩ supportés ;
     - `BarcodeRoiGeometry`     : ROI écran → pixels vidéo sous `object-fit: cover` (échelle inverse
                                  du facteur cover, offsets centrés, clamp, dégénérée → null) ;
     - `CameraPermissionPolicy` : lecture des états de la Permissions API + diagnostic du
                                  `NotAllowedError` (bloquée pour l'origine ⇄ invite re-demandable).
   Le cycle caméra/boucle (getUserMedia, jeton d'annulation, torche), lui, exige un navigateur :
   validation à l'œil via le POC `poc/qr-decodage-camera-poc.html` et le viseur du lot UI.

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D } = require("./harness.js");
const { BarcodeDetection, BarcodeSourcePolicy, BarcodeRoiGeometry, CameraPermissionPolicy } = D("core/BarcodeDetection.js");

module.exports = async () => {

  await section("BarcodeDetection : décision de source (BarcodeSourcePolicy — prédicats injectés)", async () => {
  {
    // Le module se REQUIERT sans navigateur : c'est la garantie structurelle que les imports du
    // paquet npm et du .wasm sont bien paresseux (un import top-level aurait crashé ce require).
    ck.eq(typeof BarcodeDetection.create, "function", "module chargeable en Node : create() exposé");
    ck.eq(typeof BarcodeDetection.nativeAvailable, "function", "module chargeable en Node : nativeAvailable() exposé");
    ck.eq(BarcodeDetection.SCAN_INTERVAL_MS, 120, "boucle ~8 passes/s : période de 120 ms");

    // nativeUsable : le DOUBLE critère (présent ET au moins un format).
    ck.eq(BarcodeSourcePolicy.nativeUsable(null), false, "API absente (null) : natif inutilisable");
    ck.eq(BarcodeSourcePolicy.nativeUsable([]), false, "API présente mais 0 format (cas réel mesuré) : inutilisable");
    ck.eq(BarcodeSourcePolicy.nativeUsable(["qr_code"]), true, "API présente + formats déclarés : utilisable");

    // resolve en mode auto : natif seulement s'il est utilisable.
    ck.eq(BarcodeSourcePolicy.resolve("auto", ["qr_code", "ean_13"]), "native", "auto + natif utilisable → native");
    ck.eq(BarcodeSourcePolicy.resolve("auto", null), "wasm", "auto + API absente → wasm");
    ck.eq(BarcodeSourcePolicy.resolve("auto", []), "wasm", "auto + API présente mais 0 format → wasm");

    // resolve en mode wasm : SOUVERAIN (consigne utilisateur — zxing-wasm décode plus de styles
    // de QR que les décodeurs OS, la bascule doit gagner même quand le natif existe).
    ck.eq(BarcodeSourcePolicy.resolve("wasm", ["qr_code", "ean_13"]), "wasm", "wasm forcé : gagne MÊME avec un natif utilisable");
    ck.eq(BarcodeSourcePolicy.resolve("wasm", null), "wasm", "wasm forcé : wasm aussi sans natif");
  }
  });

  await section("BarcodeDetection : intersection des formats demandés ∩ supportés", async () => {
  {
    const supported = ["qr_code", "data_matrix", "code_128", "ean_13"];

    // Demande ABSENTE → tous les supportés (décodage tous formats par défaut, arbitrage v1 :
    // service tags Code 128 / DataMatrix lus d'emblée).
    ck.eq(BarcodeSourcePolicy.retainedFormats(undefined, supported).join(","), supported.join(","),
      "demande absente : tous les formats supportés");
    ck.eq(BarcodeSourcePolicy.retainedFormats(null, supported).join(","), supported.join(","),
      "demande null : tous les formats supportés");
    ck.eq(BarcodeSourcePolicy.retainedFormats([], supported).join(","), supported.join(","),
      "demande vide : tous les formats supportés");

    // Intersection : un format non supporté est FILTRÉ (le demander est au mieux ignoré, au pire
    // refusé selon les implémentations), l'ordre du DEMANDÉ est conservé.
    ck.eq(BarcodeSourcePolicy.retainedFormats(["qr_code", "aztec"], supported).join(","), "qr_code",
      "format non supporté (aztec) filtré de la demande");
    ck.eq(BarcodeSourcePolicy.retainedFormats(["ean_13", "qr_code"], supported).join(","), "ean_13,qr_code",
      "ordre du demandé conservé (pas celui du supporté)");

    // Intersection VIDE → repli sur tous les supportés : un constructeur natif REFUSE une liste
    // vide (TypeError) — décoder trop large vaut mieux qu'un moteur qui crashe.
    ck.eq(BarcodeSourcePolicy.retainedFormats(["pdf417"], ["qr_code"]).join(","), "qr_code",
      "intersection vide : repli sur tous les supportés (jamais de liste vide)");
  }
  });

  await section("BarcodeDetection : géométrie ROI sous object-fit: cover (BarcodeRoiGeometry.coverMap)", async () => {
  {
    // NOMINAL — mêmes proportions vidéo/affichage : échelle simple, offsets nuls.
    const nominal = BarcodeRoiGeometry.coverMap({ x: 10, y: 10, width: 50, height: 50 }, { width: 100, height: 100 }, { width: 200, height: 200 });
    ck.eq(JSON.stringify(nominal), JSON.stringify({ x: 20, y: 20, width: 100, height: 100 }),
      "proportions égales : échelle ×2, offsets nuls");

    // VIDÉO PAYSAGE dans un viseur PORTRAIT (LE cas du téléphone en salle : caméra 16:9, cadre 3:4).
    // Échelle = min(1280/300, 720/400) = 1,8 → la vidéo est rognée à GAUCHE/DROITE (offset X centré),
    // pleine hauteur. ⚠ Le max des ratios vidéo/affichage (erreur du POC de la maquette) donnerait
    // un offset Y NÉGATIF (-493 px) — c'est ce piège que cette assertion verrouille.
    const landscape = BarcodeRoiGeometry.coverMap({ x: 0, y: 0, width: 300, height: 400 }, { width: 300, height: 400 }, { width: 1280, height: 720 });
    ck.eq(JSON.stringify(landscape), JSON.stringify({ x: 370, y: 0, width: 540, height: 720 }),
      "vidéo plus LARGE que le cadre : offset X centré (370), pleine hauteur — jamais d'offset négatif");
    const landscapeCenter = BarcodeRoiGeometry.coverMap({ x: 100, y: 150, width: 100, height: 100 }, { width: 300, height: 400 }, { width: 1280, height: 720 });
    ck.eq(JSON.stringify(landscapeCenter), JSON.stringify({ x: 550, y: 270, width: 180, height: 180 }),
      "ROI intérieure du même cadre : translation + échelle 1,8 exactes");

    // VIDÉO PORTRAIT dans un cadre PAYSAGE : symétrique — rognée en HAUT/BAS (offset Y centré).
    const portrait = BarcodeRoiGeometry.coverMap({ x: 0, y: 0, width: 400, height: 300 }, { width: 400, height: 300 }, { width: 720, height: 1280 });
    ck.eq(JSON.stringify(portrait), JSON.stringify({ x: 0, y: 370, width: 720, height: 540 }),
      "vidéo plus HAUTE que le cadre : offset Y centré (370), pleine largeur");

    // CLAMP aux bornes : la zone peut être traînée jusqu'aux bords du cadre — la partie hors vidéo
    // est coupée, jamais de coordonnée négative ni au-delà des dimensions intrinsèques.
    const clamped = BarcodeRoiGeometry.coverMap({ x: -10, y: 90, width: 50, height: 50 }, { width: 100, height: 100 }, { width: 100, height: 100 });
    ck.eq(JSON.stringify(clamped), JSON.stringify({ x: 0, y: 90, width: 40, height: 10 }),
      "ROI débordant en haut-gauche/bas : recadrée aux bornes de la vidéo");
    const clampedRight = BarcodeRoiGeometry.coverMap({ x: 80, y: 10, width: 40, height: 20 }, { width: 100, height: 100 }, { width: 100, height: 100 });
    ck.eq(JSON.stringify(clampedRight), JSON.stringify({ x: 80, y: 10, width: 20, height: 20 }),
      "ROI débordant à droite : largeur coupée au bord");

    // DÉGÉNÉRÉE → null (rien à décoder, AUCUN appel au détecteur) : surface nulle, entièrement
    // hors cadre, ou dimensions pas encore connues (première frame non arrivée).
    ck.eq(BarcodeRoiGeometry.coverMap({ x: 10, y: 10, width: 0, height: 50 }, { width: 100, height: 100 }, { width: 100, height: 100 }), null,
      "ROI de largeur nulle : null");
    ck.eq(BarcodeRoiGeometry.coverMap({ x: 150, y: 10, width: 40, height: 20 }, { width: 100, height: 100 }, { width: 100, height: 100 }), null,
      "ROI entièrement hors cadre : null après clamp");
    ck.eq(BarcodeRoiGeometry.coverMap({ x: 10, y: 10, width: 50, height: 50 }, { width: 100, height: 100 }, { width: 0, height: 0 }), null,
      "vidéo sans dimensions (frame pas arrivée) : null");
    ck.eq(BarcodeRoiGeometry.coverMap({ x: 10, y: 10, width: 50, height: 50 }, { width: 0, height: 0 }, { width: 100, height: 100 }), null,
      "cadre d'affichage sans dimensions : null");
  }
  });

  await section("BarcodeDetection : états de permission caméra (CameraPermissionPolicy)", async () => {
  {
    // Lecture de l'état brut de la Permissions API — toute valeur hors des trois états connus
    // (API absente, nom `camera` inconnu sous Firefox…) vaut `unknown` : l'invite tranchera.
    ck.eq(CameraPermissionPolicy.fromStatus("granted"), "granted", "granted lu tel quel");
    ck.eq(CameraPermissionPolicy.fromStatus("prompt"), "prompt", "prompt lu tel quel");
    ck.eq(CameraPermissionPolicy.fromStatus("denied"), "denied", "denied lu tel quel");
    ck.eq(CameraPermissionPolicy.fromStatus(null), "unknown", "API absente (null) : unknown");
    ck.eq(CameraPermissionPolicy.fromStatus(undefined), "unknown", "état non fourni : unknown");
    ck.eq(CameraPermissionPolicy.fromStatus("granted-mais-pas-vraiment"), "unknown", "valeur inconnue : unknown");

    // Diagnostic d'un NotAllowedError d'après l'état RE-LU après l'échec : seul `denied` prouve
    // le blocage d'origine (l'invite ne reviendra jamais — déblocage MANUEL requis) ; tout le
    // reste = invite refusée/fermée, RE-DEMANDABLE au prochain essai.
    ck.eq(CameraPermissionPolicy.denialKind("denied"), "blocked", "re-lu denied : BLOQUÉE pour l'origine");
    ck.eq(CameraPermissionPolicy.denialKind("prompt"), "dismissed", "re-lu prompt : invite fermée, re-demandable");
    ck.eq(CameraPermissionPolicy.denialKind("granted"), "dismissed", "re-lu granted (course avec onchange) : re-demandable");
    ck.eq(CameraPermissionPolicy.denialKind("unknown"), "dismissed", "état illisible : re-demandable par défaut");
  }
  });

};
