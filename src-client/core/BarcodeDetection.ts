/* =============================================================================
   BarcodeDetection — LE moteur de décodage caméra (QR / codes-barres) du client.
   Documentation d'architecture : docs/qr-scan.md.

   PRINCIPE n°2 APPLIQUÉ EN FRONTIÈRE : le reste de l'app ne touche JAMAIS ni au
   global `BarcodeDetector` ni au paquet npm `barcode-detector` — tout passe par
   cette enveloppe. Elle ne construit AUCUNE UI : l'élément <video> est FOURNI
   par l'appelant (le greffon de scan, lot ultérieur), le moteur ne fait que
   caméra + boucle + décodage, et EXPOSE des états (permission, échec) que l'UI
   traduira — aucune chaîne affichable ici, donc aucune clé i18n.

   DEUX SOURCES DE DÉCODAGE (arbitrage du GO 2026-08-18) :
     - `auto` : le décodeur NATIF de l'OS quand il est UTILISABLE — API présente
       ET au moins un format déclaré. Le double critère est MESURÉ, pas
       théorique : Chromium sur un poste sans décodeur OS expose l'API avec
       ZÉRO format — présente mais inutilisable. Sinon, wasm.
     - `wasm` : le moteur zxing-wasm FORCÉ même quand le natif existe —
       consigne utilisateur : zxing-wasm décode plus de styles de QR que les
       décodeurs OS. L'UI offre la bascule (toggle de la modale de scan) ;
       `nativeAvailable()` lui dit si ce toggle a un sens (sans natif, il n'y a
       qu'un moteur possible — rien à basculer).

   LE BINAIRE WASM EST DANS LE BUNDLE (data: URI via la règle webpack
   `asset/inline`, même doctrine que les fontes .woff2) : l'app vit LAN /
   hors-ligne et le build prod sort UN SEUL HTML autonome — un chunk séparé
   404erait précisément pour les postes du mode fichier qui ont BESOIN du
   polyfill (jamais de CDN, principe n°15). ⚠ Les imports du paquet et du
   binaire sont DYNAMIQUES avec `webpackMode: "eager"` : tout reste dans le
   chunk unique (aucun fichier séparé émis), mais le module npm n'est ÉVALUÉ
   qu'au premier `create()` en source wasm — et `prepareZXingModule`
   n'enregistre que l'EMPLACEMENT du binaire : la COMPILATION wasm n'a lieu
   qu'au premier `detect()`. L'inclusion est donc payée au BUILD (~1,4 Mo de
   base64), jamais au boot. Accessoirement, ces imports paresseux gardent ce
   fichier chargeable par le harnais de tests Node (dist-test/, CommonJS) :
   les parties PURES ci-dessous s'y testent sans navigateur.

   DÉCOUPE INTERNE (testée dans Tests/modules/test-barcode-detection.js) :
     - `BarcodeSourcePolicy`    : décision de source + intersection des formats
                                  (pur — prédicats injectés en test) ;
     - `BarcodeRoiGeometry`     : zone de décodage écran → pixels vidéo sous
                                  `object-fit: cover` (géométrie pure) ;
     - `CameraPermissionPolicy` : lecture + diagnostic des états de permission
                                  caméra (pur) ;
     - `BarcodeDetection`       : l'enveloppe elle-même (détecteur, cycle
                                  caméra, boucle de scan, torche).
   ============================================================================= */

/** Source DEMANDÉE par l'appelant : `auto` = natif si utilisable sinon wasm ;
    `wasm` = zxing-wasm forcé même si le natif existe (cf. en-tête). */
export type BarcodeSourceMode = "auto" | "wasm";
/** Source EFFECTIVEMENT retenue après résolution. */
export type BarcodeEngineKind = "native" | "wasm";

export interface BarcodePoint { x: number; y: number; }

/** Un code décodé, en types PLATS (le `DOMRectReadOnly` natif est recopié).
    ⚠ Coordonnées dans le repère INTRINSÈQUE de la vidéo (videoWidth×videoHeight),
    y compris quand la détection est passée par une ROI recadrée : le moteur
    retranslate (offset du recadrage) pour que l'appelant ait TOUJOURS le même
    repère, ROI ou pas. */
export interface BarcodeHit {
  rawValue: string;
  format: string;
  cornerPoints?: BarcodePoint[];
  boundingBox?: { x: number; y: number; width: number; height: number };
}

/** État de la permission caméra. `unknown` = Permissions API absente ou nom
    `camera` inconnu (Firefox) — l'invite s'affichera au premier getUserMedia. */
export type CameraPermissionState = "granted" | "prompt" | "denied" | "unknown";

/** Diagnostic d'un `NotAllowedError` (deux réalités derrière la MÊME erreur) :
    - `blocked`   : permission BLOQUÉE pour l'origine — l'invite ne reviendra
                    JAMAIS, seul un déblocage manuel (icône caméra de la barre
                    d'adresse / réglages du site) la restaure ;
    - `dismissed` : invite refusée ou fermée — RE-DEMANDABLE au prochain essai. */
export type CameraDenialKind = "blocked" | "dismissed";

/** Échec du démarrage caméra, en valeurs (l'UI traduira — le moteur n'affiche rien). */
export type CameraStartFailure =
  /* getUserMedia ABSENT : contexte non sécurisé (la caméra exige HTTPS ou
     localhost — mesuré : file:// passe sur Chrome desktop, REFUSÉ sur Android). */
  | { kind: "insecure-context" }
  | { kind: "permission"; denial: CameraDenialKind }
  | { kind: "no-camera" }
  | { kind: "error"; name: string; message: string };

export type CameraStartResult =
  | { ok: true; width: number; height: number }
  | { ok: false; failure: CameraStartFailure };

/** Une caméra énumérée. ⚠ `label` est VIDE tant que la permission n'a pas été
    accordée (protection vie privée) : re-lister APRÈS un `start()` réussi pour
    obtenir les libellés lisibles (comportement repris du POC). */
export interface CameraDescriptor { deviceId: string; label: string; }

/** Rectangle générique (ROI écran, ROI vidéo) — unités selon le contexte. */
export interface BarcodeRoi { x: number; y: number; width: number; height: number; }

/** ROI de détection telle que l'appelant la connaît : `rect` dans le repère
    AFFICHÉ de l'élément vidéo (px CSS, origine = coin haut-gauche de la boîte),
    `display` = taille affichée de cette boîte. Le moteur la convertit en pixels
    vidéo via `BarcodeRoiGeometry.coverMap` (la vidéo est supposée rendue en
    `object-fit: cover`, cf. la maquette du viseur). */
export interface BarcodeRoiRequest { rect: BarcodeRoi; display: { width: number; height: number }; }

export interface BarcodeDetectionOptions {
  /** Source demandée (défaut `auto`). */
  source?: BarcodeSourceMode;
  /** Formats souhaités. ABSENT = tous les formats supportés par la source
      (arbitrage v1 : service tags Code 128 / DataMatrix lus d'emblée). La liste
      effective est l'INTERSECTION demandé ∩ supporté (cf. BarcodeSourcePolicy). */
  formats?: string[];
}

export interface BarcodeScanOptions {
  /** L'élément vidéo de l'appelant (le moteur ne crée AUCUNE UI). L'appelant le
      pose avec `playsinline muted` — indispensables à l'autoplay mobile. */
  video: HTMLVideoElement;
  /** Caméra explicite ; absente = caméra ARRIÈRE de préférence (cas étiquette). */
  deviceId?: string;
  /** Appelé à chaque passe qui décode AU MOINS un code. */
  onCodes: (codes: BarcodeHit[]) => void;
  /** ROI lue À CHAQUE passe (la zone de décodage de la maquette est déplaçable
      pendant le scan — une valeur figée au démarrage serait fausse dès le
      premier glissement). `null` = décoder la frame entière. */
  roi?: () => BarcodeRoiRequest | null;
  /** Période de la boucle (défaut `BarcodeDetection.SCAN_INTERVAL_MS`). */
  intervalMs?: number;
  /** Échec PONCTUEL de detect() (frame illisible…) : signalé, la boucle continue. */
  onDetectError?: (error: unknown) => void;
}

/* ---------------------------------------------------------------------------
 * Vue STRUCTURELLE minimale des détecteurs (natif et ponyfill s'y conforment
 * tous deux) — c'est elle qui permet de manipuler les deux sources d'une seule
 * main sans dépendre des types du paquet au niveau module.
 * ------------------------------------------------------------------------- */
interface RawDetectedCode {
  rawValue: string;
  format: string;
  cornerPoints?: readonly BarcodePoint[];
  boundingBox?: { x: number; y: number; width: number; height: number };
}
interface BarcodeDetectorLike { detect(image: CanvasImageSource): Promise<readonly RawDetectedCode[]>; }
interface BarcodeDetectorCtorLike {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<readonly string[]>;
}

/* ============================================================================
 * BarcodeSourcePolicy — décision de source + formats (PUR, testé par injection).
 * ========================================================================== */
export class BarcodeSourcePolicy {
  /** Le natif est-il UTILISABLE ? `null` = API absente ; `[]` = API présente
      mais AUCUN format déclaré (cas réel mesuré : Chromium sans décodeur OS) —
      aussi inutilisable qu'absente. */
  static nativeUsable(nativeFormats: readonly string[] | null): boolean {
    return nativeFormats !== null && nativeFormats.length > 0;
  }

  /** Résolution de la source : `wasm` demandé est SOUVERAIN (consigne
      utilisateur — bascule forcée même quand le natif existe) ; `auto` élit le
      natif seulement s'il est utilisable. */
  static resolve(mode: BarcodeSourceMode, nativeFormats: readonly string[] | null): BarcodeEngineKind {
    if (mode === "wasm") return "wasm";
    return BarcodeSourcePolicy.nativeUsable(nativeFormats) ? "native" : "wasm";
  }

  /** Formats retenus = INTERSECTION demandé ∩ supporté, dans l'ordre du
      demandé. Demander un format absent est au mieux ignoré, au pire REFUSÉ
      selon les implémentations (repris du POC) — d'où le filtre systématique.
      Demande ABSENTE → tous les supportés (décodage tous formats par défaut,
      arbitrage v1). Intersection VIDE → repli sur tous les supportés aussi :
      un constructeur natif refuse une liste vide (TypeError), et décoder trop
      large vaut mieux qu'un moteur qui crashe — l'appelant peut relire la
      liste effective via `getActiveFormats()`. */
  static retainedFormats(requested: readonly string[] | null | undefined, supported: readonly string[]): string[] {
    if (!requested || requested.length === 0) return [...supported];
    const kept = requested.filter((format) => supported.includes(format));
    return kept.length ? kept : [...supported];
  }
}

/* ============================================================================
 * BarcodeRoiGeometry — ROI écran → pixels vidéo sous `object-fit: cover`
 * (GÉOMÉTRIE PURE — le viseur de la maquette a une zone de décodage
 * déplaçable/redimensionnable : seule cette région part au décodeur).
 * ========================================================================== */
export class BarcodeRoiGeometry {
  /** Convertit une ROI exprimée dans la boîte AFFICHÉE de la vidéo (px CSS)
      en rectangle de pixels INTRINSÈQUES de la vidéo, la vidéo étant rendue en
      `object-fit: cover` (elle COUVRE la boîte, rognée au centre).

      L'échelle affichage → vidéo est l'INVERSE du facteur cover — cover scale
      la vidéo par MAX(display/video) sur les deux axes, l'inverse est donc le
      MIN des ratios vidéo/affichage. ⚠ Piège MESURÉ (le POC de la maquette le
      commettait) : prendre le MAX des ratios vidéo/affichage donne des offsets
      NÉGATIFS dès que les orientations diffèrent — vidéo paysage 16:9 dans un
      viseur portrait 3:4, précisément le cas du téléphone en salle. Les tests
      verrouillent ce cas.

      Offsets centrés (la partie rognée l'est symétriquement), clamp aux bornes
      de la vidéo (la ROI peut être traînée jusqu'aux bords de la boîte).
      Retourne `null` quand il n'y a RIEN à décoder : ROI dégénérée (≤ 0),
      entièrement hors cadre après clamp (< 1 px utile), ou dimensions
      vidéo/affichage pas encore connues (première frame non arrivée). */
  static coverMap(
    roi: BarcodeRoi,
    display: { width: number; height: number },
    video: { width: number; height: number },
  ): BarcodeRoi | null {
    if (video.width <= 0 || video.height <= 0 || display.width <= 0 || display.height <= 0) return null;
    if (roi.width <= 0 || roi.height <= 0) return null;

    const scale = Math.min(video.width / display.width, video.height / display.height);
    const offsetX = (video.width - display.width * scale) / 2;
    const offsetY = (video.height - display.height * scale) / 2;

    const left = Math.min(Math.max(offsetX + roi.x * scale, 0), video.width);
    const top = Math.min(Math.max(offsetY + roi.y * scale, 0), video.height);
    const right = Math.min(Math.max(offsetX + (roi.x + roi.width) * scale, 0), video.width);
    const bottom = Math.min(Math.max(offsetY + (roi.y + roi.height) * scale, 0), video.height);

    if (right - left < 1 || bottom - top < 1) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
}

/* ============================================================================
 * CameraPermissionPolicy — interprétation des états de permission (PUR).
 * La DEMANDE de permission n'est pas une étape séparée : c'est getUserMedia()
 * qui déclenche l'invite. La Permissions API ne sert qu'à LIRE l'état — et à
 * diagnostiquer le cas piégeux « bloquée » (logique reprise du POC).
 * ========================================================================== */
export class CameraPermissionPolicy {
  /** État brut de la Permissions API → état du moteur. Toute valeur inconnue
      ou absente (API indisponible, nom `camera` non reconnu — Firefox) vaut
      `unknown` : on ne sait rien, l'invite tranchera. */
  static fromStatus(state: string | null | undefined): CameraPermissionState {
    return state === "granted" || state === "prompt" || state === "denied" ? state : "unknown";
  }

  /** Diagnostic d'un `NotAllowedError` à partir de l'état RE-LU après l'échec :
      seul `denied` prouve le blocage d'origine ; tout le reste (`prompt`,
      `granted`, `unknown`) se traite comme « invite refusée/fermée » —
      re-demandable, le prochain essai re-tentera l'invite. */
  static denialKind(stateAfterFailure: CameraPermissionState): CameraDenialKind {
    return stateAfterFailure === "denied" ? "blocked" : "dismissed";
  }
}

/* ============================================================================
 * BarcodeDetection — l'enveloppe : détecteur + cycle caméra + boucle de scan.
 * ========================================================================== */
export class BarcodeDetection {
  /** ~8 passes/s. PAS de requestAnimationFrame : detect() est asynchrone et
      coûteux, saturer à 60 Hz n'apporterait rien à une visée manuelle et
      affamerait le thread (repris du POC). */
  static readonly SCAN_INTERVAL_MS = 120;

  /** Source effectivement retenue (`native` | `wasm`) — l'UI l'affiche (badge
      « moteur » de la maquette) et le toggle s'en déduit. */
  readonly engine: BarcodeEngineKind;

  private readonly detector: BarcodeDetectorLike;
  private readonly supported: string[];
  private readonly retained: string[];

  /** Surface de recadrage RÉUTILISÉE (pas d'allocation par frame : à ~8
      passes/s, un canvas neuf par passe ne ferait que nourrir le GC). */
  private cropCanvas: HTMLCanvasElement | null = null;
  private cropContext: CanvasRenderingContext2D | null = null;

  private stream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  /** Jeton d'annulation : incrémenté à chaque stop(), la boucle en cours se
      découvre périmée au retour de son await (repris du POC). */
  private scanToken = 0;

  private constructor(engine: BarcodeEngineKind, detector: BarcodeDetectorLike, supported: string[], retained: string[]) {
    this.engine = engine;
    this.detector = detector;
    this.supported = supported;
    this.retained = retained;
  }

  /* ----------------------------- construction ----------------------------- */

  /** Le constructeur NATIF, s'il existe (typé structurellement — l'API n'est
      pas dans lib.dom de TypeScript). SEUL point du code à toucher au global. */
  private static nativeConstructor(): BarcodeDetectorCtorLike | null {
    const host = globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtorLike };
    return host.BarcodeDetector || null;
  }

  /** Formats du décodeur natif : `null` = API absente, `[]` = présente mais
      inutilisable (0 format déclaré, ou getSupportedFormats() qui échoue). */
  private static async probeNativeFormats(): Promise<readonly string[] | null> {
    const native = BarcodeDetection.nativeConstructor();
    if (!native) return null;
    try { return await native.getSupportedFormats(); }
    catch { return []; }
  }

  /** Le natif est-il utilisable sur ce poste ? Pour l'UI (lot ultérieur) : le
      toggle « Moteur : Auto / WASM » n'a de sens que si ce prédicat est vrai —
      sans natif, wasm est la seule source possible. */
  static async nativeAvailable(): Promise<boolean> {
    return BarcodeSourcePolicy.nativeUsable(await BarcodeDetection.probeNativeFormats());
  }

  /** Fabrique le moteur (asynchrone : sonde du natif, import paresseux du
      chemin wasm). Une instance = un détecteur configuré + au plus un flux
      caméra à la fois. */
  static async create(options: BarcodeDetectionOptions = {}): Promise<BarcodeDetection> {
    const mode: BarcodeSourceMode = options.source || "auto";
    /* En mode wasm forcé, la sonde du natif serait du travail perdu : resolve()
       n'en a pas besoin pour élire wasm. */
    const nativeFormats = mode === "auto" ? await BarcodeDetection.probeNativeFormats() : null;
    const engine = BarcodeSourcePolicy.resolve(mode, nativeFormats);

    let ctor: BarcodeDetectorCtorLike;
    let supported: string[];
    if (engine === "native") {
      /* resolve() n'élit le natif que présent ET utilisable — le `!` est sûr. */
      ctor = BarcodeDetection.nativeConstructor()!;
      supported = [...(nativeFormats as readonly string[])];
    } else {
      /* Chemin wasm — imports PARESSEUX mais INLINE (webpackMode eager, cf.
         en-tête : chunk unique préservé, évaluation différée au premier appel).
         ⚠ Le binaire est importé depuis `zxing-wasm` TRANSITIF (épinglé en
         version EXACTE par barcode-detector) : le .wasm DOIT être celui que la
         glue JS embarquée attend — un zxing-wasm déclaré à part pourrait
         diverger de version et casser silencieusement le décodage. */
      const ponyfill = await import(/* webpackMode: "eager" */ "barcode-detector/ponyfill");
      const wasm = await import(/* webpackMode: "eager" */ "zxing-wasm/reader/zxing_reader.wasm");
      /* `prepareZXingModule` N'ENREGISTRE que l'emplacement du binaire (le
         data: URI inliné par webpack) — sans lui, la glue irait le chercher
         sur le CDN jsDelivr, interdit ici (LAN/hors-ligne, principe n°15).
         La COMPILATION wasm, elle, n'a lieu qu'au premier detect(). */
      ponyfill.prepareZXingModule({
        overrides: {
          locateFile: (file: string, prefix: string) => (file.endsWith(".wasm") ? wasm.default : prefix + file),
        },
      });
      ctor = ponyfill.BarcodeDetector as unknown as BarcodeDetectorCtorLike;
      supported = [...(await ctor.getSupportedFormats())];
    }

    const retained = BarcodeSourcePolicy.retainedFormats(options.formats, supported);
    return new BarcodeDetection(engine, new ctor({ formats: retained }), supported, retained);
  }

  /* ------------------------------- formats -------------------------------- */

  /** Formats supportés par la SOURCE retenue (natif = liste de l'OS, wasm =
      tout zxing) — l'UI s'y adapte. */
  getSupportedFormats(): string[] { return [...this.supported]; }

  /** Formats effectivement DÉCODÉS (intersection demandé ∩ supporté, cf.
      `BarcodeSourcePolicy.retainedFormats`). */
  getActiveFormats(): string[] { return [...this.retained]; }

  /* ------------------------------ permission ------------------------------ */

  /** État courant de la permission caméra (`unknown` si illisible). */
  static async cameraPermission(): Promise<CameraPermissionState> {
    try {
      const status = await navigator.permissions.query({ name: "camera" as PermissionName });
      return CameraPermissionPolicy.fromStatus(status.state);
    } catch { return "unknown"; }
  }

  /** État courant + suivi EN DIRECT (`onchange` de la Permissions API : accord
      ou blocage pendant que le viseur est ouvert). API absente TOLÉRÉE :
      `unknown` et un désabonnement no-op. */
  static async watchCameraPermission(
    onChange: (state: CameraPermissionState) => void,
  ): Promise<{ state: CameraPermissionState; unwatch: () => void }> {
    try {
      const status = await navigator.permissions.query({ name: "camera" as PermissionName });
      const listener = () => onChange(CameraPermissionPolicy.fromStatus(status.state));
      status.addEventListener("change", listener);
      return {
        state: CameraPermissionPolicy.fromStatus(status.state),
        unwatch: () => status.removeEventListener("change", listener),
      };
    } catch {
      return { state: "unknown", unwatch: () => {} };
    }
  }

  /* ------------------------------- caméras -------------------------------- */

  /** Caméras disponibles. ⚠ Labels vides avant le premier accord de permission
      (cf. `CameraDescriptor`) : l'appelant RE-LISTE après un start() réussi. */
  static async listCameras(): Promise<CameraDescriptor[]> {
    const media = navigator.mediaDevices;
    if (!media || !media.enumerateDevices) return [];
    try {
      const devices = await media.enumerateDevices();
      return devices
        .filter((device) => device.kind === "videoinput")
        .map((device) => ({ deviceId: device.deviceId, label: device.label }));
    } catch { return []; }
  }

  /* --------------------------- cycle caméra + scan ------------------------- */

  /** Démarre caméra + boucle de scan sur l'élément vidéo FOURNI. Sans
      `deviceId` : caméra ARRIÈRE de préférence (`facingMode` ideal — cas
      d'usage étiquette en salle), 1280×720 ideal (suffisant pour décoder, sans
      payer un flux 4K). Un start() remplace le flux précédent de l'instance. */
  async start(options: BarcodeScanOptions): Promise<CameraStartResult> {
    this.stop();
    const media = navigator.mediaDevices;
    if (!media || !media.getUserMedia) {
      /* getUserMedia n'existe qu'en CONTEXTE SÉCURISÉ (HTTPS/localhost) — son
         absence est le symptôme mesuré du file:// Android, cf. docs/qr-scan.md. */
      return { ok: false, failure: { kind: "insecure-context" } };
    }
    const constraints: MediaStreamConstraints = options.deviceId
      ? { video: { deviceId: { exact: options.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } }
      : { video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } };
    try {
      const stream = await media.getUserMedia(constraints);
      this.stream = stream;
      this.videoElement = options.video;
      options.video.srcObject = stream;
      await options.video.play();
      this.runLoop(++this.scanToken, options);
      return { ok: true, width: options.video.videoWidth, height: options.video.videoHeight };
    } catch (error) {
      this.stop();
      return { ok: false, failure: await BarcodeDetection.explainCameraFailure(error) };
    }
  }

  /** Arrêt PROPRE : périme la boucle (jeton), stoppe chaque track (la LED
      caméra s'éteint), détache le flux de l'élément vidéo. Idempotent. */
  stop(): void {
    this.scanToken++;
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement = null;
    }
  }

  /** Un flux caméra est-il actif sur cette instance ? */
  get running(): boolean { return this.stream !== null; }

  /** Torche BEST-EFFORT (fond de baie sombre). L'échec est SILENCIEUX côté
      moteur et signalé par le retour : `false` = pas de flux, matériel sans
      torche ou contrainte refusée — l'UI en tire un bouton inerte/masqué.
      (`torch` n'est pas dans les types DOM de TypeScript, d'où le cast.) */
  async setTorch(on: boolean): Promise<boolean> {
    const track = this.stream ? this.stream.getVideoTracks()[0] : undefined;
    if (!track) return false;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as unknown as MediaTrackConstraintSet] });
      return true;
    } catch { return false; }
  }

  /* ------------------------------- détection ------------------------------ */

  /** Décode la frame COURANTE de la vidéo. Avec `roi` : seule la région
      recadrée part au détecteur (moins de faux positifs sur une planche
      d'étiquettes dense) — les coordonnées des résultats sont RETRANSLATÉES
      dans le repère intrinsèque de la vidéo (cf. `BarcodeHit`). ROI dégénérée
      ou hors cadre → aucun appel au détecteur, résultat vide. */
  async detect(video: HTMLVideoElement, roi?: BarcodeRoiRequest | null): Promise<BarcodeHit[]> {
    let input: CanvasImageSource = video;
    let offsetX = 0;
    let offsetY = 0;
    if (roi) {
      const mapped = BarcodeRoiGeometry.coverMap(roi.rect, roi.display, { width: video.videoWidth, height: video.videoHeight });
      if (!mapped) return [];
      const cropped = this.cropInto(video, mapped);
      if (cropped) {
        input = cropped;
        offsetX = Math.round(mapped.x);
        offsetY = Math.round(mapped.y);
      }
      /* Surface 2D indisponible (jamais vu en pratique) : on décode la frame
         ENTIÈRE plutôt que rien — le scan reste fonctionnel, juste moins ciblé. */
    }
    const found = await this.detector.detect(input);
    return found.map((code) => BarcodeDetection.toHit(code, offsetX, offsetY));
  }

  /* -------------------------------- interne ------------------------------- */

  /** Boucle de scan auto-replanifiée (setTimeout, cf. SCAN_INTERVAL_MS). La
      ROI est relue à CHAQUE passe ; le jeton est re-testé APRÈS chaque await
      (un stop() pendant detect() doit rendre la passe muette). */
  private runLoop(token: number, options: BarcodeScanOptions): void {
    const interval = options.intervalMs !== undefined ? options.intervalMs : BarcodeDetection.SCAN_INTERVAL_MS;
    const pass = async (): Promise<void> => {
      if (token !== this.scanToken) return;
      /* HAVE_CURRENT_DATA : au moins une frame est décodable. */
      if (options.video.readyState >= 2) {
        try {
          const codes = await this.detect(options.video, options.roi ? options.roi() : null);
          if (token !== this.scanToken) return;
          if (codes.length) options.onCodes(codes);
        } catch (error) {
          if (token !== this.scanToken) return;
          if (options.onDetectError) options.onDetectError(error);
        }
      }
      window.setTimeout(pass, interval);
    };
    void pass();
  }

  /** Recadre la région (pixels vidéo) dans le canvas réutilisé. */
  private cropInto(video: HTMLVideoElement, region: BarcodeRoi): HTMLCanvasElement | null {
    if (!this.cropCanvas) {
      this.cropCanvas = document.createElement("canvas");
      this.cropContext = this.cropCanvas.getContext("2d", { willReadFrequently: true });
    }
    if (!this.cropContext) return null;
    const sourceX = Math.round(region.x);
    const sourceY = Math.round(region.y);
    const width = Math.max(1, Math.round(region.width));
    const height = Math.max(1, Math.round(region.height));
    if (this.cropCanvas.width !== width) this.cropCanvas.width = width;
    if (this.cropCanvas.height !== height) this.cropCanvas.height = height;
    this.cropContext.drawImage(video, sourceX, sourceY, width, height, 0, 0, width, height);
    return this.cropCanvas;
  }

  /** Résultat brut du détecteur → `BarcodeHit` plat, coordonnées retranslatées
      du repère du recadrage vers celui de la vidéo (dx/dy = origine de la ROI). */
  private static toHit(code: RawDetectedCode, dx: number, dy: number): BarcodeHit {
    const hit: BarcodeHit = { rawValue: code.rawValue, format: String(code.format) };
    if (code.cornerPoints && code.cornerPoints.length) {
      hit.cornerPoints = code.cornerPoints.map((point) => ({ x: point.x + dx, y: point.y + dy }));
    }
    if (code.boundingBox) {
      hit.boundingBox = {
        x: code.boundingBox.x + dx,
        y: code.boundingBox.y + dy,
        width: code.boundingBox.width,
        height: code.boundingBox.height,
      };
    }
    return hit;
  }

  /** Échec de getUserMedia → valeur diagnostiquée. Pour `NotAllowedError`, on
      RE-LIT l'état de permission plutôt que se fier à un cache : le `onchange`
      de la Permissions API peut arriver APRÈS nous (logique reprise du POC). */
  private static async explainCameraFailure(error: unknown): Promise<CameraStartFailure> {
    const name = error instanceof Error ? error.name : "";
    if (name === "NotAllowedError") {
      const state = await BarcodeDetection.cameraPermission();
      return { kind: "permission", denial: CameraPermissionPolicy.denialKind(state) };
    }
    if (name === "NotFoundError") return { kind: "no-camera" };
    return { kind: "error", name: name || String(error), message: error instanceof Error ? error.message : "" };
  }
}
