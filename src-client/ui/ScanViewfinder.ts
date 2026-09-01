/* =============================================================================
   ScanViewfinder — le VISEUR de scan caméra : la modale de visée de l'app.
   Documentation : docs/qr-scan.md § « L'UI de scan ». La maquette
   design-system/briefs/qr-saisie-camera-maquette.html FAIT FOI pour l'UI.

   CE QUE C'EST. Une modale de la PILE STANDARD (`Modal` via l'hôte injecté —
   jamais un overlay parallèle) qui affiche le flux caméra, une ZONE DE
   DÉCODAGE (ROI) déplaçable/redimensionnable par les coins et MÉMORISÉE PAR
   CHAMP (`core/ScanRoiMemory`), et un panneau RÉSULTAT à la lecture d'un code
   (valeur brute + format + « Continuer » / « Valider »). Elle est poussée
   PAR-DESSUS le formulaire en cours (niveau « info » de la pile : sans
   `onSave`, la garde D9b « une seule édition vivante » la laisse passer), et
   Échap/✕/← gardent leur sémantique de pile (D9a : une édition enfouie est
   rendue à l'écran, jamais détruite).

   DEUX CIBLES :
     - `field` : le viseur remplit UN champ — la valeur passe par le PARSEUR
       NOMMÉ du champ (`core/ScanParsing`, doctrine « jamais d'injection
       silencieuse » : non conforme = affichée + avertie + Valider désactivé) ;
     - `free`  : l'entrée GLOBALE « scanner une étiquette » — un lien direct
       (`AppLink.parse` non-null) OUVRE sa cible et ferme ; sinon
       panneau d'actions (copier, injecter dans le dernier champ actif, lien
       cliquable si URL http(s) — JAMAIS de navigation automatique).

   LE MOTEUR (`core/BarcodeDetection`) fait caméra + boucle + décodage ; le
   viseur ne fait qu'UI : il lui passe l'élément <video>, une ROI relue à
   chaque passe (rect en px AFFICHÉS + taille de la boîte — le mapping vers les
   pixels vidéo sous `object-fit: cover` est au moteur, cf. coverMap), et
   TRADUIT ses échecs TYPÉS (contexte non sécurisé, permission bloquée ⇄
   re-demandable — suivie en direct par `watchCameraPermission`, un accord
   dans l'onglet des réglages du site relance la caméra tout seul).

   BASCULE DE MOTEUR (arbitrage GO 2026-08-18) : toggle « Moteur : Auto (natif)
   / WASM » AFFICHÉ SEULEMENT si le natif existe (`nativeAvailable()` — sans
   lui, wasm est la seule source : rien à basculer), préférence PERSISTÉE par
   l'hôte (`Prefs.scanEngine`), bascule = moteur RECRÉÉ à chaud.
   ============================================================================= */

import type { ModalOptions } from "./Modal";
import { Icons } from "./Icons";
import { Notify } from "./Notify";
import { Clipboard } from "./Clipboard";
import { FormControls } from "./FormControls";
import { BarcodeDetection } from "../core/BarcodeDetection";
import type { BarcodeHit, CameraDescriptor, CameraStartFailure } from "../core/BarcodeDetection";
import { ScanParsing } from "../core/ScanParsing";
import type { ScanParserId } from "../core/ScanParsing";
import { ScanRoiMemory } from "../core/ScanRoiMemory";
import type { ScanRoiRect, ScanRoiCorner } from "../core/ScanRoiMemory";
import { Haptics } from "../core/Haptics";
import { Html } from "../core/Html";
import type { ScanEngineMode } from "../core/Prefs";
import { AppLink } from "../../src-shared/AppLink";
import type { AppLinkTarget } from "../../src-shared/AppLink";
import { I18n } from "../i18n/I18n";

/** Ce que le viseur attend de son hôte (main.ts via `ScanControl.setup`) : la pile de modales
    standard et la préférence de moteur — injectés, jamais importés (le viseur ignore `Prefs`). */
export interface ScanViewfinderHost {
  openModal(opts: ModalOptions): void;
  closeModal(): void;
  enginePref(): ScanEngineMode;
  setEnginePref(mode: ScanEngineMode): void;
}

/** Cible « champ » : le viseur remplit un champ précis, via son parseur nommé. */
export interface ScanFieldTarget {
  kind: "field";
  parser: ScanParserId;
  /** Clé STABLE de la mémoire de ROI (ex. « equipments.serial »). */
  fieldKey: string;
  /** Libellé du champ — sous-titre de la modale (l'utilisateur doit savoir CE QU'il remplit). */
  label: string;
  /** Appelé au « Valider » (valeur PARSÉE) — le viseur est déjà fermé quand il s'exécute. */
  onValidate(value: string): void;
}

/** Cible « libre » : l'entrée globale — deep-link → fiche, sinon panneau d'actions. */
export interface ScanFreeTarget {
  kind: "free";
  onDeepLink(target: AppLinkTarget): void;
  /** L'injection « dernier champ actif » est-elle possible ? (champ encore vivant et éditable) */
  canInject(): boolean;
  onInject(value: string): void;
}

export type ScanViewfinderTarget = ScanFieldTarget | ScanFreeTarget;

/** Délai pendant lequel, après « Continuer », le code TOUT JUSTE lu est ignoré : sans lui, le même
    QR encore sous la zone re-verrouillerait instantanément — l'utilisateur n'aurait jamais le temps
    de viser l'étiquette suivante. */
const RESCAN_SUPPRESS_MS = 1500;

export class ScanViewfinder {
  /** Ouvre le viseur dans la pile de modales. Point d'entrée UNIQUE (le constructeur est privé). */
  static open(host: ScanViewfinderHost, target: ScanViewfinderTarget): void {
    const vf = new ScanViewfinder(host, target);
    host.openModal({
      title: target.kind === "field" ? I18n.t("scan.viewfinder.title") : I18n.t("scan.viewfinder.freeTitle"),
      subtitle: target.kind === "field" ? Html.escape(target.label) : "",
      body: vf.root,
      hideFooter: true,
      /* Clé d'identité de FICHE : rouvrir un viseur alors qu'un autre vit dans la pile redescend
         jusqu'à lui (D5) au lieu d'empiler des caméras — cas dégénéré, mais jamais deux flux. */
      stackKey: "scan:viewfinder",
      /* `onClose` joue à TOUTE disparition du niveau (✕, Échap, ←, fermeture totale D9a…) :
         c'est LA garantie que la caméra s'éteint (LED comprise) quel que soit le geste. */
      onClose: () => vf.destroy(),
    });
    void vf.init();
  }

  private readonly host: ScanViewfinderHost;
  private readonly target: ScanViewfinderTarget;

  readonly root: HTMLElement;
  private stage!: HTMLElement;
  private video!: HTMLVideoElement;
  private roiEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private badgeEl!: HTMLElement;
  private msgEl!: HTMLElement;
  private engineRow!: HTMLElement;
  private resultEl!: HTMLElement;
  private liveEl!: HTMLElement;
  private torchBtn!: HTMLButtonElement;
  private camBtn!: HTMLButtonElement;

  private engine: BarcodeDetection | null = null;
  private roi: ScanRoiRect;
  /** Verrou d'affichage : un résultat est à l'écran, les passes de détection sont IGNORÉES
      (la caméra et la boucle CONTINUENT — un stop/start ferait clignoter le flux). */
  private paused = false;
  private destroyed = false;
  private torchOn = false;
  private cameras: CameraDescriptor[] = [];
  private cameraIndex = -1;
  private currentDeviceId: string | undefined;
  private lastHit: BarcodeHit | null = null;
  private suppressValue: string | null = null;
  private suppressUntil = 0;
  private unwatchPermission: (() => void) | null = null;
  /** Anti-réentrance de la bascule de moteur (deux clics rapides sur le toggle). */
  private switching = false;

  private constructor(host: ScanViewfinderHost, target: ScanViewfinderTarget) {
    this.host = host;
    this.target = target;
    this.roi = this.loadRoi();
    this.root = this.build();
  }

  /* ------------------------------ construction ------------------------------ */

  private build(): HTMLElement {
    const root = document.createElement("div");

    // -- plateau vidéo --
    this.stage = document.createElement("div"); this.stage.className = "scan-stage";
    this.video = document.createElement("video");
    /* `playsinline muted` : indispensables à l'autoplay mobile (cf. BarcodeScanOptions). */
    this.video.setAttribute("playsinline", ""); this.video.muted = true;
    this.stage.appendChild(this.video);
    this.badgeEl = document.createElement("div"); this.badgeEl.className = "scan-src-tag"; this.stage.appendChild(this.badgeEl);

    // -- outils du plateau (colonne haut-droite, maquette) --
    const tools = document.createElement("div"); tools.className = "scan-stage-tools";
    const tool = (icon: string, label: string): HTMLButtonElement => {
      const b = document.createElement("button"); b.type = "button"; b.className = "scan-tool";
      b.innerHTML = icon; b.setAttribute("aria-label", label); b.title = label;
      return b;
    };
    this.camBtn = tool(Icons.CAMERA, I18n.t("scan.viewfinder.cameraNext"));
    this.camBtn.style.display = "none";   // visible seulement si PLUSIEURS caméras (après start)
    this.camBtn.onclick = () => { void this.cycleCamera(); };
    this.torchBtn = tool(Icons.TORCH, I18n.t("scan.viewfinder.torch"));
    this.torchBtn.setAttribute("aria-pressed", "false");
    this.torchBtn.onclick = () => { void this.toggleTorch(); };
    const recenterBtn = tool(Icons.RECENTER, I18n.t("scan.viewfinder.recenter"));
    recenterBtn.onclick = () => { this.roi = { ...ScanRoiMemory.DEFAULT }; this.applyRoi(); this.persistRoi(); };
    tools.append(this.camBtn, this.torchBtn, recenterBtn);
    this.stage.appendChild(tools);

    // -- zone de décodage (coins visibles + poignées 28px + scanline) --
    this.roiEl = document.createElement("div"); this.roiEl.className = "scan-roi";
    this.roiEl.innerHTML = '<i class="cn tl"></i><i class="cn tr"></i><i class="cn bl"></i><i class="cn br"></i>'
      + '<i class="h tl"></i><i class="h tr"></i><i class="h bl"></i><i class="h br"></i>'
      + '<div class="scan-scanline"></div>';
    this.installRoiDrag();
    this.stage.appendChild(this.roiEl);
    this.applyRoi();

    this.hintEl = document.createElement("div"); this.hintEl.className = "scan-stage-hint";
    this.hintEl.textContent = I18n.t("scan.viewfinder.hint");
    this.stage.appendChild(this.hintEl);
    root.appendChild(this.stage);

    // -- panneau d'état (permission, contexte…) : remplace le plateau quand la caméra échoue --
    this.msgEl = document.createElement("div"); this.msgEl.className = "scan-msg"; this.msgEl.style.display = "none";
    root.appendChild(this.msgEl);

    // -- rangée « Moteur : Auto / WASM » — remplie par init() si le natif existe --
    this.engineRow = document.createElement("div"); this.engineRow.className = "scan-engine-row"; this.engineRow.style.display = "none";
    root.appendChild(this.engineRow);

    // -- panneau résultat (rempli au verrouillage) --
    this.resultEl = document.createElement("div"); this.resultEl.className = "scan-result"; this.resultEl.style.display = "none";
    root.appendChild(this.resultEl);

    // -- annonce vocale : la valeur décodée est dite aux lecteurs d'écran (maquette, accessibilité) --
    this.liveEl = document.createElement("div"); this.liveEl.className = "scan-live";
    this.liveEl.setAttribute("aria-live", "polite");
    root.appendChild(this.liveEl);

    return root;
  }

  /* --------------------------------- cycle ---------------------------------- */

  private async init(): Promise<void> {
    /* Toggle de moteur : SEULEMENT si le natif est utilisable (sans lui, rien à basculer). */
    const nativeAvailable = await BarcodeDetection.nativeAvailable();
    if (this.destroyed) return;
    if (nativeAvailable) {
      const label = document.createElement("span"); label.textContent = I18n.t("scan.viewfinder.engineLabel");
      const seg = FormControls.segmented(
        [
          { value: "auto", label: I18n.t("scan.viewfinder.engineAuto") },
          { value: "wasm", label: I18n.t("scan.viewfinder.engineWasm") },
        ],
        this.host.enginePref(),
        (mode) => { void this.switchEngine(mode === "wasm" ? "wasm" : "auto"); },
        { ariaLabel: I18n.t("scan.viewfinder.engineLabel") },
      );
      this.engineRow.append(label, seg);
      this.engineRow.style.display = "";
    }
    /* Suivi de permission EN DIRECT : un accord donné pendant que le panneau d'échec est affiché
       (réglages du site dans un autre volet) relance la caméra sans geste supplémentaire. */
    const watch = await BarcodeDetection.watchCameraPermission((state) => {
      if (state === "granted" && !this.destroyed && this.engine && !this.engine.running) {
        this.showStage(); void this.startCamera();
      }
    });
    if (this.destroyed) { watch.unwatch(); return; }
    this.unwatchPermission = watch.unwatch;
    await this.startEngine();
  }

  /** (Re)crée le moteur selon la préférence, puis démarre la caméra. */
  private async startEngine(): Promise<void> {
    try {
      this.engine = await BarcodeDetection.create({ source: this.host.enginePref() });
    } catch (e) {
      /* Échec de l'import wasm (jamais vu : le binaire est dans le bundle) — on le dit plutôt
         que de laisser un plateau noir muet. */
      console.error(e);
      this.showMessage(I18n.t("scan.error.engineFailed"));
      return;
    }
    if (this.destroyed) return;
    this.badgeEl.textContent = this.engine.engine === "native"
      ? I18n.t("scan.viewfinder.badgeNative") : I18n.t("scan.viewfinder.badgeWasm");
    await this.startCamera();
  }

  private async startCamera(): Promise<void> {
    if (!this.engine || this.destroyed) return;
    const result = await this.engine.start({
      video: this.video,
      deviceId: this.currentDeviceId,
      onCodes: (codes) => this.onCodes(codes),
      /* ROI relue À CHAQUE passe (elle bouge pendant le scan) — px de la boîte AFFICHÉE, le
         mapping vers les pixels vidéo est le travail du moteur (coverMap). */
      roi: () => this.roiRequest(),
    });
    if (this.destroyed) { this.engine.stop(); return; }
    if (!result.ok) { this.handleFailure(result.failure); return; }
    this.showStage();
    /* Re-lister APRÈS un start réussi : les LABELS des caméras sont vides avant le premier accord
       de permission (cf. CameraDescriptor) — c'est maintenant qu'on sait s'il y a un choix. */
    this.cameras = await BarcodeDetection.listCameras();
    this.camBtn.style.display = this.cameras.length > 1 ? "" : "none";
    /* Repère la caméra ACTIVE dans la liste (le prochain « changer de caméra » part d'elle). */
    try {
      const track = (this.video.srcObject as MediaStream | null)?.getVideoTracks()[0];
      const activeId = track?.getSettings?.().deviceId;
      if (activeId) this.cameraIndex = this.cameras.findIndex((c) => c.deviceId === activeId);
    } catch { /* getSettings absent (vieux navigateur) : le cycle partira du début */ }
  }

  /** Arrêt + libération — appelé par l'`onClose` du niveau de modale (toute disparition). */
  private destroy(): void {
    this.destroyed = true;
    if (this.engine) this.engine.stop();
    if (this.unwatchPermission) { this.unwatchPermission(); this.unwatchPermission = null; }
  }

  /* ------------------------------ moteur / outils ---------------------------- */

  /** Bascule Auto ⇄ WASM : préférence persistée par l'hôte, moteur RECRÉÉ à chaud. */
  private async switchEngine(mode: ScanEngineMode): Promise<void> {
    if (this.switching) return;
    this.switching = true;
    try {
      this.host.setEnginePref(mode);
      if (this.engine) this.engine.stop();
      this.torchOn = false; this.syncTorchButton();
      this.resume();   // un résultat affiché ne survit pas au changement de moteur
      await this.startEngine();
    } finally { this.switching = false; }
  }

  private async toggleTorch(): Promise<void> {
    if (!this.engine) return;
    const ok = await this.engine.setTorch(!this.torchOn);
    if (!ok) {
      /* Best-effort du moteur : matériel sans torche ou contrainte refusée → bouton INERTE
         (doctrine `setTorch`) + un toast qui explique, plutôt qu'un bouton qui « ne marche pas ». */
      this.torchBtn.disabled = true;
      Notify.toast(I18n.t("scan.viewfinder.torchUnavailable"));
      return;
    }
    this.torchOn = !this.torchOn;
    this.syncTorchButton();
  }

  private syncTorchButton(): void {
    this.torchBtn.setAttribute("aria-pressed", this.torchOn ? "true" : "false");
    this.torchBtn.disabled = false;
  }

  /** Caméra SUIVANTE (cycle) — le bouton n'existe que s'il y en a plusieurs. */
  private async cycleCamera(): Promise<void> {
    if (this.cameras.length < 2) return;
    this.cameraIndex = (this.cameraIndex + 1) % this.cameras.length;
    const next = this.cameras[this.cameraIndex];
    this.currentDeviceId = next.deviceId;
    this.camBtn.title = next.label || I18n.t("scan.viewfinder.cameraNext");
    this.torchOn = false; this.syncTorchButton();
    await this.startCamera();
  }

  /* ------------------------------ ROI (drag/resize) -------------------------- */

  private applyRoi(): void {
    this.roiEl.style.left = (this.roi.x * 100) + "%";
    this.roiEl.style.top = (this.roi.y * 100) + "%";
    this.roiEl.style.width = (this.roi.w * 100) + "%";
    this.roiEl.style.height = (this.roi.h * 100) + "%";
  }

  /** Déplacement (corps) / redimensionnement (poignées de coin) au POINTEUR, avec capture — même
      mécanique que la maquette. Les deltas sont convertis en FRACTIONS du plateau ; la géométrie
      (bornes, tailles mini, coin opposé ancré) vit dans `core/ScanRoiMemory` (testée). */
  private installRoiDrag(): void {
    let drag: { corner: ScanRoiCorner | null; startX: number; startY: number; base: ScanRoiRect } | null = null;
    this.roiEl.addEventListener("pointerdown", (e) => {
      const handle = (e.target as HTMLElement).closest(".h");
      const corner = handle
        ? ((["tl", "tr", "bl", "br"] as ScanRoiCorner[]).find((c) => handle.classList.contains(c)) || null)
        : null;
      drag = { corner, startX: e.clientX, startY: e.clientY, base: { ...this.roi } };
      this.roiEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.roiEl.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const w = this.stage.clientWidth || 1;
      const h = this.stage.clientHeight || 1;
      const dx = (e.clientX - drag.startX) / w;
      const dy = (e.clientY - drag.startY) / h;
      this.roi = drag.corner
        ? ScanRoiMemory.resize(drag.base, drag.corner, dx, dy)
        : ScanRoiMemory.move(drag.base, dx, dy);
      this.applyRoi();
    });
    const end = () => { if (drag) { drag = null; this.persistRoi(); } };
    this.roiEl.addEventListener("pointerup", end);
    this.roiEl.addEventListener("pointercancel", end);
  }

  /** ROI pour le moteur : rectangle en px de la boîte AFFICHÉE + taille de cette boîte. `null`
      quand le plateau n'est pas mesurable (niveau recouvert par une autre modale). */
  private roiRequest(): { rect: { x: number; y: number; width: number; height: number }; display: { width: number; height: number } } | null {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    if (w < 1 || h < 1) return null;
    return {
      rect: { x: this.roi.x * w, y: this.roi.y * h, width: this.roi.w * w, height: this.roi.h * h },
      display: { width: w, height: h },
    };
  }

  private roiStorageKey(): string {
    return this.target.kind === "field" ? this.target.fieldKey : "global";
  }

  private loadRoi(): ScanRoiRect {
    try { return ScanRoiMemory.load((k) => window.localStorage.getItem(k), this.roiStorageKey()); }
    catch { return { ...ScanRoiMemory.DEFAULT }; }
  }

  private persistRoi(): void {
    /* Stockage indisponible (navigation privée…) : la mémoire de zone est un CONFORT — silence. */
    try {
      ScanRoiMemory.save(
        (k) => window.localStorage.getItem(k),
        (k, v) => window.localStorage.setItem(k, v),
        this.roiStorageKey(), this.roi,
      );
    } catch { /* sans effet */ }
  }

  /* ------------------------------ lecture / résultat ------------------------- */

  private onCodes(codes: BarcodeHit[]): void {
    if (this.paused || this.destroyed || !codes.length) return;
    const hit = codes[0];
    /* Fenêtre de grâce post-« Continuer » : le code tout juste validé/relu est ignoré le temps
       de viser le suivant (cf. RESCAN_SUPPRESS_MS). */
    if (this.suppressValue === hit.rawValue && Date.now() < this.suppressUntil) return;
    this.lock(hit);
  }

  /** VERROUILLAGE (maquette) : zone verte, vibration, annonce vocale, panneau résultat. */
  private lock(hit: BarcodeHit): void {
    this.paused = true;
    this.lastHit = hit;
    this.roiEl.classList.add("lock");
    this.hintEl.textContent = I18n.t("scan.viewfinder.locked");
    Haptics.decoded();
    this.liveEl.textContent = I18n.t("scan.result.announce", { value: hit.rawValue });

    if (this.target.kind === "free") {
      /* Lien direct : ouvrir sa cible EST le geste — fermeture immédiate, pas de panneau. */
      const link = AppLink.parse(hit.rawValue);
      if (link) { this.host.closeModal(); this.target.onDeepLink(link); return; }
      this.showFreeResult(hit);
    } else {
      this.showFieldResult(hit, this.target);
    }
  }

  /** Reprend la lecture (« Continuer », ou après bascule de moteur). */
  private resume(): void {
    if (this.lastHit) {
      this.suppressValue = this.lastHit.rawValue;
      this.suppressUntil = Date.now() + RESCAN_SUPPRESS_MS;
    }
    this.paused = false;
    this.roiEl.classList.remove("lock");
    this.hintEl.textContent = I18n.t("scan.viewfinder.hint");
    this.resultEl.style.display = "none";
    this.resultEl.replaceChildren();
  }

  /** Socle commun du panneau résultat : ✓ + nature, valeur, format + heure. */
  private buildResultBase(hit: BarcodeHit, warning: string | null): void {
    this.resultEl.replaceChildren();
    const head = document.createElement("div"); head.className = "scan-res-head";
    head.innerHTML = Icons.CHECK;
    const kind = document.createElement("span");
    kind.textContent = hit.format === "qr_code" ? I18n.t("scan.result.decodedQr") : I18n.t("scan.result.decoded");
    head.appendChild(kind);
    this.resultEl.appendChild(head);

    const val = document.createElement("div"); val.className = "scan-res-val";
    val.textContent = hit.rawValue;   // valeur BRUTE, toujours affichée (jamais silencieux)
    this.resultEl.appendChild(val);

    const meta = document.createElement("div"); meta.className = "scan-res-meta";
    const fmt = document.createElement("span"); fmt.textContent = hit.format;
    const time = document.createElement("span"); time.textContent = new Date().toLocaleTimeString();
    meta.append(fmt, time);
    this.resultEl.appendChild(meta);

    if (warning) {
      const warn = document.createElement("div"); warn.className = "scan-res-warn";
      warn.textContent = warning;
      this.resultEl.appendChild(warn);
    }
    this.resultEl.style.display = "";
  }

  private actionButton(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button"); b.type = "button";
    b.className = primary ? "btn btn-primary" : "btn btn-ghost";
    b.textContent = label;
    b.onclick = onClick;
    return b;
  }

  /** Cible CHAMP : la valeur passe le parseur du champ — conforme = « Valider » actif (injecte et
      ferme), non conforme = avertissement + « Valider » DÉSACTIVÉ (doctrine maquette). */
  private showFieldResult(hit: BarcodeHit, target: ScanFieldTarget): void {
    const parsed = ScanParsing.parse(target.parser, hit.rawValue);
    this.buildResultBase(hit, parsed.warning ? I18n.t("scan.warning." + parsed.warning) : null);

    const actions = document.createElement("div"); actions.className = "scan-res-actions";
    actions.appendChild(this.actionButton(I18n.t("scan.result.again"), false, () => this.resume()));
    const validate = this.actionButton(I18n.t("scan.result.validate"), true, () => {
      /* Fermer D'ABORD (le formulaire hôte revient à l'écran), injecter ENSUITE : le flash de
         confirmation se joue sur un champ visible, et le focus revient dessus. */
      this.host.closeModal();
      target.onValidate(parsed.value);
    });
    validate.disabled = !parsed.ok;
    actions.appendChild(validate);
    this.resultEl.appendChild(actions);
    validate.focus();
  }

  /** Cible LIBRE, valeur NON deep-link : panneau d'actions — copier, injecter dans le dernier
      champ actif, et lien cliquable si URL http(s) (JAMAIS de navigation automatique). */
  private showFreeResult(hit: BarcodeHit): void {
    if (this.target.kind !== "free") return;
    const free = this.target;
    this.buildResultBase(hit, null);

    if (Html.isSafeHttpUrl(hit.rawValue)) {
      const link = document.createElement("div"); link.className = "scan-res-link";
      link.innerHTML = Html.externalLink(hit.rawValue, I18n.t("scan.result.openLink"));
      this.resultEl.appendChild(link);
    }

    const actions = document.createElement("div"); actions.className = "scan-res-actions";
    actions.appendChild(this.actionButton(I18n.t("scan.result.again"), false, () => this.resume()));
    actions.appendChild(this.actionButton(I18n.t("scan.result.copy"), false, () => { void Clipboard.copy(hit.rawValue, I18n.t("scan.result.copied")); }));
    if (free.canInject()) {
      actions.appendChild(this.actionButton(I18n.t("scan.result.inject"), true, () => {
        this.host.closeModal();
        free.onInject(hit.rawValue);
      }));
    }
    this.resultEl.appendChild(actions);
  }

  /* ------------------------------ états d'échec ------------------------------ */

  /** Échec TYPÉ du moteur → message TRADUIT (le moteur n'affiche rien, doctrine frontière). */
  private handleFailure(failure: CameraStartFailure): void {
    switch (failure.kind) {
      case "insecure-context": this.showMessage(I18n.t("scan.error.insecure")); return;
      case "no-camera": this.showMessage(I18n.t("scan.error.noCamera")); return;
      case "permission":
        if (failure.denial === "blocked") {
          /* BLOQUÉE pour l'origine : l'invite ne reviendra jamais — on explique le geste de
             déblocage ; `watchCameraPermission` (init) relancera tout seul si l'accord arrive. */
          this.showMessage(I18n.t("scan.error.permissionBlocked"));
        } else {
          /* Invite refusée/fermée : RE-DEMANDABLE — bouton « Réessayer » qui rejoue getUserMedia. */
          this.showMessage(I18n.t("scan.error.permissionDismissed"), () => { this.showStage(); void this.startCamera(); });
        }
        return;
      default: this.showMessage(I18n.t("scan.error.generic", { name: failure.name, message: failure.message }));
    }
  }

  /** Panneau d'état à la place du plateau ; `onRetry` ajoute un bouton « Réessayer ». */
  private showMessage(text: string, onRetry?: () => void): void {
    this.stage.style.display = "none";
    this.msgEl.replaceChildren();
    const p = document.createElement("div"); p.textContent = text;
    this.msgEl.appendChild(p);
    if (onRetry) this.msgEl.appendChild(this.actionButton(I18n.t("scan.error.retry"), true, onRetry));
    this.msgEl.style.display = "";
    this.liveEl.textContent = text;   // l'échec aussi est annoncé vocalement
  }

  private showStage(): void {
    this.msgEl.style.display = "none";
    this.stage.style.display = "";
  }
}
