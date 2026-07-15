/* Couche CAMÉRA + INTERACTION + PICKING du moteur 3D WebGL (cf. en-tête de DcThreeBase).
   Caméra orbitale orthographique/perspective (mêmes angles az/el que project3DCam du SVG),
   pan/zoom/orbite à la souris, et picking par raycasting (clic = détail / form ; survol = highlight). */
import * as THREE from "three";
import { CAM_PRESETS } from "../shared";
import { DcThreeBase } from "./DcThreeBase";
import { Haptics } from "../../../core/Haptics";
import { U_MM } from "../../../domain/constants";

export abstract class DcThreeCamera extends DcThreeBase {
  /** Dernière position (clientX, clientY) du geste TACTILE — sert de point de picking au `touchend` (qui ne
      porte pas de coordonnées de doigt actif), et de centroïde mémorisé entre deux `touchmove`. */
  protected _touchPos: [number, number] | null = null;
  /** Distance (px) entre les deux doigts au dernier `touchmove` — base du PINCH/ZOOM (facteur = d/dPrécédent). */
  protected _pinchDist: number | null = null;

  /* ---- cadrage ---- */
  /** Cadre la salle : fixe la cible + la demi-hauteur de frustum pour tout voir (réinitialise zoom + cible). */
  protected frame(W: number, D: number, H: number, tx: number, ty: number, tz: number): void {
    this.target.set(tx, ty, tz);
    this.radius = Math.max(W, D, H) * 4 + 1000;
    this.baseHalf = Math.max(W, D, H) * 0.62 + 200;
    this.zoom = 1;
    this.updateCamera();
  }

  /** Cadre UNE FOIS par salle : mémorise les args ; ne recadre pas aux re-rendus de données (caméra préservée). */
  protected frameOnce(dcId: string | null, W: number, D: number, H: number, tx: number, ty: number, tz: number): void {
    this.frameArgs = [W, D, H, tx, ty, tz];
    if (this.framedDc !== dcId) { this.frame(W, D, H, tx, ty, tz); this.framedDc = dcId; }
    else this.updateCamera();   // même salle → garde la caméra, ré-ajuste juste l'aspect
  }

  /** Recentre/ajuste la vue sur la salle courante (réutilise le dernier cadrage). */
  recenter(): void { if (this.frameArgs) this.frame(...this.frameArgs); this.request(); }

  /** Applique un preset de point de vue (mêmes angles az/el que le moteur SVG). */
  setPreset(name: string): void {
    const p = CAM_PRESETS[name] || CAM_PRESETS.iso;
    this.az = p[0]; this.el = p[1];
    this.updateCamera(); this.request();
  }

  /** Zoom incrémental (boutons overlay). */
  zoomBy(factor: number): void {
    this.zoom = Math.max(0.05, Math.min(40, this.zoom * factor));
    this.updateCamera(); this.request();
  }

  /** Réinitialise la caméra sur la salle courante (preset iso). */
  resetCam(): void { this.az = -0.62; this.el = 0.46; this.updateCamera(); this.request(); }

  /** Dimension max (px) d'un côté à l'export = limite de texture du GPU (plafond réel, souvent 16384). */
  exportMaxDim(): number { return (this.renderer && (this.renderer as any).capabilities) ? (this.renderer as any).capabilities.maxTextureSize || 8192 : 8192; }

  /** Taille (px) du tampon de rendu actuel = export ×1 (résolution réellement affichée, pixelRatio inclus). */
  exportBaseSize(): { w: number; h: number } {
    const r = this.renderer, el = this.host_el; if (!r || !el) return { w: 0, h: 0 };
    const dpr = r.getPixelRatio();
    return { w: Math.max(1, Math.round(el.clientWidth * dpr)), h: Math.max(1, Math.round(el.clientHeight * dpr)) };
  }

  /** Export JPEG de la VUE ACTUELLE, SUR-ÉCHANTILLONNÉE ×`scale` (×1 = résolution affichée). La caméra, l'aspect,
      l'épaisseur des câbles et les marqueurs restent INCHANGÉS → image strictement identique à l'écran, juste plus
      détaillée (tout est proportionnel). Le render target est encodé en sRGB → couleurs FIDÈLES (sinon « ternes »). */
  exportJPEG(scale: number, cb: (blob: Blob | null) => void, quality = 0.92): void {
    const r = this.renderer, cam = this.camera, scene = this.scene;
    if (!r || !cam || !scene) { cb(null); return; }
    const s = Math.max(1, scale || 1), base = this.exportBaseSize(), width = base.w * s, height = base.h * s;
    if (width < 16 || height < 16) { cb(null); return; }
    const rt = new THREE.WebGLRenderTarget(width, height, { samples: 4 });
    rt.texture.colorSpace = (THREE as any).SRGBColorSpace;   // encodage sRGB en sortie (comme le canvas) → couleurs identiques
    try {
      r.setRenderTarget(rt); r.render(scene, cam);
      const buf = new Uint8Array(width * height * 4);
      r.readRenderTargetPixels(rt, 0, 0, width, height, buf);
      r.setRenderTarget(null);
      const cv = document.createElement("canvas"); cv.width = width; cv.height = height;
      const ctx = cv.getContext("2d"); if (!ctx) { cb(null); return; }
      const img = ctx.createImageData(width, height);
      for (let y = 0; y < height; y++) { const src = (height - 1 - y) * width * 4; img.data.set(buf.subarray(src, src + width * 4), y * width * 4); }   // WebGL : origine bas-gauche → flip Y
      ctx.putImageData(img, 0, 0);
      cv.toBlob((b) => cb(b), "image/jpeg", quality);
    } catch (e) { cb(null); }
    finally { rt.dispose(); this.request(); }
  }

  /** « Localiser » : centre la caméra sur un point monde (mm) et cadre à ~`extent` (mm), en conservant l'angle.
      Différé si la scène n'est pas encore construite (appliqué au prochain rendu, après le cadrage du build). */
  focusOn(p: { x: number; y: number; z: number }, extent: number, face?: { az: number; el: number } | null): void {
    this.pendingFocus = { p: { x: p.x, y: p.y, z: p.z }, extent: extent > 0 ? extent : 2000, face: face || null };
    this.applyPendingFocus();   // applique tout de suite si la scène est prête, sinon reste en attente (renderFrame)
  }
  protected applyPendingFocus(): void {
    const f = this.pendingFocus; if (!f || !this.content || !this.camera) return;   // scène pas prête → reste en attente
    this.pendingFocus = null;
    this.target.set(f.p.x, f.p.y, f.p.z);
    this.baseHalf = Math.max(400, f.extent * 0.7 + 200);
    this.zoom = 1;
    if (f.face) { this.az = f.face.az; this.el = f.face.el; }   // « se positionner en face » : oriente la caméra vers le front
    this.framedDc = this.builtDc;   // marque comme cadré → un re-rendu (même salle) ne re-cadrera pas
    this.updateCamera(); this.request();
  }

  /** Surbrillance PERSISTANTE de l'équipement « localisé » (`eqId`) ET, optionnellement, du PORT localisé (`portId`)
      — même émissive ambre, distincte du survol (bleu). Réappliquée à chaque (re)rendu ; null pour l'éteindre. */
  setFocusEquip(eqId: string | null, portId: string | null = null): void {
    const had = this._focusObjs.length > 0;
    this._focusObjs.forEach((o) => this.setFocusHi(o, false));
    this._focusObjs = [];
    if (eqId || portId) {
      [this.gRacks, this.gFree].forEach((g) => g && g.traverse((o: any) => {
        const ud = o.userData; if (!ud) return;
        const p = ud.pick;
        if (eqId && ((p && p.type === "occ" && p.id === eqId) || ud.eqId === eqId)) this._focusObjs.push(o);   // équipement (+ ses plans d'image, tagués eqId)
        else if (portId && p && p.type === "port" && p.id === portId) this._focusObjs.push(o);                 // port (même surbrillance ambre)
      }));
      this._focusObjs.forEach((o) => this.setFocusHi(o, true));
    }
    if (had || this._focusObjs.length) this.request();
  }

  /** Émissive ambre persistante sur un mesh occupant (mono- ou multi-matériau), sans collision avec le survol. */
  protected setFocusHi(mesh: THREE.Object3D | null, on: boolean): void {
    if (!mesh) return;
    const HI = 0xf5a623;
    const m = (mesh as any).material as any; if (!m) return;
    if (Array.isArray(m)) {
      const HIC = 0xffce8a;   // teinte ambre pour les faces texturées (MeshBasic sans emissive)
      if (on) {
        if ((mesh as any).userData._focArr == null) {
          (mesh as any).userData._focArr = m.map((x: any) => (x && x.emissive) ? x.emissive.getHex() : -1);
          (mesh as any).userData._focColArr = m.map((x: any) => (x && !x.emissive && x.color) ? x.color.getHex() : -1);
        }
        m.forEach((x: any) => { if (!x) return; if (x.emissive) x.emissive.setHex(HI); else if (x.color) x.color.setHex(HIC); });
      } else if ((mesh as any).userData._focArr) {
        m.forEach((x: any, i: number) => {
          if (!x) return;
          if (x.emissive && (mesh as any).userData._focArr[i] >= 0) x.emissive.setHex((mesh as any).userData._focArr[i]);
          else if (x.color && (mesh as any).userData._focColArr && (mesh as any).userData._focColArr[i] >= 0) x.color.setHex((mesh as any).userData._focColArr[i]);
        });
        (mesh as any).userData._focArr = null; (mesh as any).userData._focColArr = null;
      }
      return;
    }
    if (on) {
      if (m.emissive) { (mesh as any).userData._focEmi = m.emissive.getHex(); m.emissive.setHex(HI); }
      else if (m.color) { (mesh as any).userData._focCol = m.color.getHex(); m.color.setHex(0xffce8a); }   // plan d'image (MeshBasic) → teinte ambre
    } else {
      if ((mesh as any).userData._focEmi != null && m.emissive) { m.emissive.setHex((mesh as any).userData._focEmi); (mesh as any).userData._focEmi = null; }
      if ((mesh as any).userData._focCol != null && m.color) { m.color.setHex((mesh as any).userData._focCol); (mesh as any).userData._focCol = null; }
    }
  }

  /** Recentre le PIVOT d'orbite sur le point de scène au CENTRE de l'écran (1re surface, sinon plan du sol). Ce point
      est sur le rayon central → déplacer la cible le long de ce rayon NE BOUGE PAS l'image en ORTHO. En PERSPECTIVE, le
      même déplacement RAPPROCHERAIT la caméra (caméra = cible + dir·dist) → saut de zoom ; on compense en fixant la
      distance perspective à la distance caméra↔surface, ce qui laisse la caméra STRICTEMENT en place (aucun saut) tout en
      posant le pivot sur le contenu → comportement IDENTIQUE à l'ortho. Réplique l'esprit de `_recenterPivot3D` (v88) :
      on orbite autour de ce qu'on regarde — crucial en multi-DC/multi-étage où le centroïde flotte dans le vide. */
  protected recenterPivotOnView(): void {
    const cam = this.camera, dom = this.renderer?.domElement;
    if (!cam || !dom || !this.content) return;
    this.ndc.set(0, 0);   // centre de l'écran (NDC 0,0)
    this.raycaster.setFromCamera(this.ndc, cam);
    // pivot = CONTENU de salle : sol, baies, équipements, et WAYPOINTS (marqueurs/pins, rails, bacs de
    // chemins de câbles) — on EXCLUT le décor d'étage (plans/grilles), qui ne doit jamais influencer le
    // centre de rotation, visible ou masqué. Le filtre `face` écarte les hits de LIGNES (grilles, arêtes,
    // seuil de tolérance trompeur) ; les SPRITES (marqueurs de waypoint, sans face) restent éligibles.
    const groups = [this.gDecor, this.gRacks, this.gFree, this.gWaypoints].filter(Boolean) as THREE.Object3D[];
    const hits = this.raycaster.intersectObjects(groups, true).filter((h) => this.hitVisible(h.object) && ((h as any).face || (h.object as any).isSprite));
    const P = new THREE.Vector3();
    if (hits.length) P.copy(hits[0].point);
    else if (!this.raycaster.ray.intersectPlane(this._groundPlane, P)) return;   // repli : intersection avec le sol z=0
    // PERSPECTIVE : garder la caméra EXACTEMENT en place. P est sur le rayon central → la distance caméra↔P est celle à
    // conserver ; on règle `zoom` pour que perspDist() (∝ 1/zoom) l'égale, sinon updateCamera rapprocherait la caméra.
    if (this.perspective) {
      const dist = cam.position.distanceTo(P);
      if (dist > 1e-3) this.zoom = (this.baseHalf / Math.tan(this.fov * Math.PI / 360)) / dist;
    }
    this.target.copy(P);   // pivot posé sur le contenu ; l'orbite qui suit appelle updateCamera (image inchangée)
  }

  /* ---- projection ---- */
  /** (Re)crée la caméra selon `perspective`, en préservant up = +Z. */
  protected makeCamera(): void {
    const cam = this.perspective
      ? new THREE.PerspectiveCamera(this.fov, 1, 1, 1e7)
      : new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1e7);
    cam.up.set(0, 0, 1);
    this.camera = cam;
  }

  /** Bascule projection orthographique ⟷ perspective (conserve angles/cible/zoom). */
  setProjection(persp: boolean): void {
    if (this.perspective === persp) return;
    this.perspective = persp;
    this.makeCamera();
    this.updateCamera(); this.request();
  }

  /** Échelle monde/pixel au plan de la cible (pour le pan), selon la projection. */
  protected worldPerPixel(): number {
    const el = this.host_el; const h = Math.max(1, el ? el.clientHeight : 1);
    if (this.perspective) { const dist = this.perspDist(); return (2 * dist * Math.tan(this.fov * Math.PI / 360)) / h; }
    return (2 * (this.baseHalf / this.zoom)) / h;
  }

  /** Distance caméra↔cible en perspective (le zoom rapproche/éloigne). */
  protected perspDist(): number { return (this.baseHalf / Math.tan(this.fov * Math.PI / 360)) / this.zoom; }

  protected updateCamera(): void {
    const cam = this.camera, el = this.host_el; if (!cam || !el) return;
    // position depuis (azimut, élévation) — direction cible→caméra
    const ce = Math.cos(this.el), se = Math.sin(this.el), ca = Math.cos(this.az), sa = Math.sin(this.az);
    const dir = new THREE.Vector3(ce * ca, ce * sa, se);
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight), aspect = w / h;
    if (cam instanceof THREE.OrthographicCamera) {
      cam.position.copy(this.target).addScaledVector(dir, this.radius);
      const half = this.baseHalf / this.zoom;
      cam.left = -half * aspect; cam.right = half * aspect; cam.top = half; cam.bottom = -half;
      cam.near = 0.1; cam.far = this.radius * 4;
    } else {
      const dist = this.perspDist();
      cam.position.copy(this.target).addScaledVector(dir, dist);
      cam.fov = this.fov; cam.aspect = aspect;
      cam.near = Math.max(1, dist * 0.01); cam.far = dist * 4 + this.radius * 4;
    }
    cam.lookAt(this.target);
    cam.updateProjectionMatrix();
    this.updateScreenScales();   // marqueurs à taille écran constante (dépend du zoom)
    this.updatePivot();          // marqueur du centre de rotation : suit la cible, taille écran constante
  }

  /** Rescale les marqueurs taggés `screenSize`/`worldSize` ; les power bolts ne sont visibles que DE PRÈS
      (largeur de vue ≤ 50 % du seuil de culling), comme le SVG. DEUX MODES (toggle « taille réelle ») :
      - STATIQUE (défaut) : taille ÉCRAN constante = screenSize px × markerScale, quel que soit le zoom.
        En PERSPECTIVE, le mm/px dépend de la distance CAMÉRA↔OBJET — PAS de la distance à la cible : avec
        `worldPerPixel()` (plan de la CIBLE), un marqueur devant/derrière le pivot (ex. pivot placé derrière
        une baie) gonflerait/rétrécirait au zoom. On calcule donc l'échelle AU PLAN DE CHAQUE OBJET.
      - RÉELLE : taille MONDE constante = worldSize mm × markerScale (suit le zoom, comme la géométrie).
        Les objets SANS `worldSize` (power bolts, pastilles des outils mesure/route) restent en taille écran
        — aides visuelles sans dimension physique. Comportement IDENTIQUE mono-salle / multi-DC (même chemin). */
  protected updateScreenScales(): void {
    const objs = this._screenObjs; if (!objs || !objs.length) return;
    const wpp = this.worldPerPixel(), k = this.opts.markerScale || 1, real = !!this.opts.markerRealSize;
    const viewWidthM = (wpp * Math.max(1, this.host_el ? this.host_el.clientWidth : 1)) / 1000;
    const boltsOn = viewWidthM <= 7.5;   // power bolts (⚡) visibles seulement DE PRÈS (vue ≤ 7,5 m de large)
    const cam = this.camera, h = Math.max(1, this.host_el ? this.host_el.clientHeight : 1);
    const perspK = (2 * Math.tan(this.fov * Math.PI / 360)) / h;   // mm/px = perspK × distance caméra↔objet
    const wp = new THREE.Vector3();   // tampon réutilisé (pas d'allocation par marqueur, appelé à chaque frame caméra)
    objs.forEach((o) => {
      if (real && o.userData.worldSize) o.scale.setScalar((o.userData.worldSize as number) * k);
      else {
        const w = (this.perspective && cam) ? perspK * cam.position.distanceTo(o.getWorldPosition(wp)) : wpp;
        o.scale.setScalar((o.userData.screenSize as number) * w * k);
      }
      if (o.userData.powerBolt) o.visible = boltsOn;
    });
  }

  /** Met à jour le facteur de taille des marqueurs en direct (slider), sans reconstruire. */
  setMarkerScale(v: number): void { this.opts.markerScale = v; this.updateScreenScales(); this.request(); }

  /** Bascule taille STATIQUE (écran) ⟷ RÉELLE (monde) des marqueurs/pastilles en direct, sans reconstruire. */
  setMarkerRealSize(v: boolean): void { this.opts.markerRealSize = v; this.updateScreenScales(); this.request(); }

  /* ---- interaction (orbite / pan / zoom / picking) ---- */
  protected bindEvents(dom: HTMLElement): void {
    dom.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (this._navMovedR) { this._navMovedR = false; return; }   // c'était une orbite (clic droit glissé) → pas de menu
      const desc = this.targetAt(e.clientX, e.clientY);
      if (desc && this.ctxCb) { if (this.tipCb) this.tipCb(null, 0, 0); this.ctxCb(desc, e.clientX, e.clientY); }
    });
    dom.style.touchAction = "none";   // gestes tactiles capturés par l'appli (pas de scroll/pinch-zoom natif du navigateur)
    dom.addEventListener("mousedown", (e) => {
      if (this.beginPointer(e.clientX, e.clientY, e.button, e.shiftKey)) { e.preventDefault(); return; }   // sélection d'emplacements
      if (e.button !== 2) e.preventDefault();   // PAS sur le bouton droit → l'event `contextmenu` peut se déclencher
    });
    dom.addEventListener("mouseleave", () => { if (this.tipCb) this.tipCb(null, 0, 0); });
    dom.addEventListener("mousemove", this.onHover);
    window.addEventListener("mousemove", this.onMove);
    window.addEventListener("mouseup", this.onUp);
    dom.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.zoomToCursor(Math.pow(1.0015, -e.deltaY), e.clientX, e.clientY);   // zoom VERS LE CURSEUR (cf. zoom-souris du moteur SVG)
    }, { passive: false });
    this.bindTouch(dom);
  }

  /** AMORCE d'un geste de navigation/sélection, PARTAGÉE souris ⇄ tactile. `button` : 0 = pan (ou sélection
      d'un emplacement U sur un slot libre), 2 = orbite ; `shift` force l'orbite (cohérent avec le moteur SVG).
      Le mode OUTIL (mesure/route) inhibe la sélection d'emplacement (le glisser navigue, le clic pose/choisit).
      Renvoie true si une SÉLECTION d'emplacements a démarré (l'appelant doit alors `preventDefault`). */
  protected beginPointer(clientX: number, clientY: number, button: number, shift: boolean): boolean {
    const slot = (this.toolMode === "none" && button === 0 && !shift) ? this.slotUnder(clientX, clientY) : null;
    if (slot) {
      this.clearHover(); this.hovered = null;   // évite un double setHover(true) sur l'emplacement déjà survolé
      this.slotSel = { rackId: slot.rackId, side: slot.side, anchor: slot.u, lo: slot.u, hi: slot.u, slots: this.collectFreeSlots(slot.rackId, slot.side), overlay: null };
      this.drag = { mode: "slotsel", x: clientX, y: clientY, downX: clientX, downY: clientY, btn: 0, moved: false };
      this.applySlotSel();
      if (this.tipCb) this.tipCb(null, 0, 0);
      return true;
    }
    const mode: "orbit" | "pan" = (button === 2 || shift) ? "orbit" : "pan";
    this.drag = { mode, x: clientX, y: clientY, downX: clientX, downY: clientY, btn: button, moved: false };
    if (this.tipCb) this.tipCb(null, 0, 0);   // masque le tooltip pendant un glisser
    return false;
  }

  /** NAVIGATION TACTILE (responsive). Mapping demandé : 1 doigt glissé = glissé CLIC GAUCHE (pan, ou sélection
      d'emplacement) ; 2 doigts glissés = glissé CLIC DROIT (orbite), le pivot suivant le CENTROÏDE des deux doigts.
      Un appui simple SANS déplacement = clic (picking : édition baie/câble, ou pose de point en mode outil).
      On réutilise la machine d'état souris (`onMove`/`onUp`) en lui passant des coordonnées synthétiques. */
  protected bindTouch(dom: HTMLElement): void {
    // Seuils du geste 2 doigts : le mode (ORBITE ou ZOOM) se VERROUILLE au 1er franchissement et reste figé
    // jusqu'au décollage COMPLET des doigts (jamais pan+zoom en même temps). Le zoom exige un écart de pinch
    // nettement plus marqué que l'orbite → un simple glissé à 2 doigts oriente vers l'orbite, un vrai
    // pincement vers le zoom.
    const ORBIT_LOCK = 12;   // px de déplacement du centroïde pour verrouiller l'orbite
    const PINCH_LOCK = 28;   // px de variation d'écartement pour verrouiller le zoom
    const centroid = (tl: TouchList): { x: number; y: number } => {
      const n = Math.min(2, tl.length); let sx = 0, sy = 0;
      for (let i = 0; i < n; i++) { sx += tl[i].clientX; sy += tl[i].clientY; }
      return { x: sx / n, y: sy / n };
    };
    const pinchDist = (tl: TouchList): number => Math.hypot(tl[0].clientX - tl[1].clientX, tl[0].clientY - tl[1].clientY);

    let twoMode: "none" | "orbit" | "zoom" = "none";   // mode du geste 2 doigts, verrouillé une fois décidé
    let pinchStart = 0, centroidStart = { x: 0, y: 0 };
    let multiTouch = false;   // le geste a impliqué ≥2 doigts → AUCUN clic au relâchement (pas de pick parasite)

    // DOUBLE-TAP (1 doigt) → menu contextuel. Le 1er tap programme un pick DIFFÉRÉ (annulable) ; un 2e tap rapproché
    // l'annule et ouvre le menu contextuel. Tout nouveau geste annule le pick en attente.
    let lastTapTime = 0, lastTapX = 0, lastTapY = 0, tapTimer = 0;
    const TAP_GAP = 320, TAP_NEAR = 28, TAP_DELAY = 280;
    const openCtxAt = (x: number, y: number) => {
      const desc = this.targetAt(x, y);
      if (desc && this.ctxCb) { if (this.tipCb) this.tipCb(null, 0, 0); this.ctxCb(desc, x, y); }
    };
    const handleTap = (x: number, y: number, ts: number) => {
      if (lastTapTime && (ts - lastTapTime) < TAP_GAP && Math.hypot(x - lastTapX, y - lastTapY) < TAP_NEAR) {
        if (tapTimer) { clearTimeout(tapTimer); tapTimer = 0; }
        lastTapTime = 0; Haptics.tick(); openCtxAt(x, y); return;   // DOUBLE TAP → menu contextuel
      }
      lastTapTime = ts; lastTapX = x; lastTapY = y;
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = window.setTimeout(() => { tapTimer = 0; lastTapTime = 0; this.pick(x, y); }, TAP_DELAY);   // 1er tap → pick différé
    };

    // APPUI LONG (1 doigt immobile sur un objet) → met l'objet EN ÉVIDENCE (comme un survol) + TOOLTIP épinglé. N'ouvre
    // PAS la fiche (la levée après long-press ne pick pas). La mise en évidence + le tooltip restent jusqu'au prochain
    // contact (ou un pan), qui les ferment (`dismissLongPress`). Annulé si le doigt bouge (> seuil) ou si 2e doigt.
    let pressTimer = 0, longPressed = false, pressX = 0, pressY = 0;
    const LONG_PRESS_MS = 450, LONG_PRESS_MOVE = 12;
    const cancelLongPress = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = 0; } };
    const dismissLongPress = () => {   // annule un long-press en attente ET ferme la mise en évidence + tooltip épinglés
      cancelLongPress();
      if (longPressed) { longPressed = false; this.clearHoverAndTip(); }
    };
    const armLongPress = (x: number, y: number) => {
      pressX = x; pressY = y; longPressed = false; cancelLongPress();
      pressTimer = window.setTimeout(() => {
        pressTimer = 0;
        const target = this.hoverApply(pressX, pressY);   // highlight (émissive bleue) + tooltip, comme un survol
        if (target) { longPressed = true; Haptics.select(); } else if (this.tipCb) this.tipCb(null, 0, 0);
      }, LONG_PRESS_MS);
    };

    dom.addEventListener("touchstart", (e) => {
      if (tapTimer) { clearTimeout(tapTimer); tapTimer = 0; }   // un nouveau geste annule un pick simple en attente
      dismissLongPress();   // tout nouveau contact ferme un tooltip d'appui long épinglé (+ sa mise en évidence)
      if (e.touches.length === 1 && !multiTouch) {   // démarrage à 1 doigt = pan/sélection (pick possible au tap)
        const t = e.touches[0]; this._touchPos = [t.clientX, t.clientY]; this._pinchDist = null;
        this.beginPointer(t.clientX, t.clientY, 0, false);
        if (this.drag && this.drag.mode === "pan") armLongPress(t.clientX, t.clientY);   // pas sur une sélection d'emplacement
      } else if (e.touches.length >= 2) {   // 2e doigt → geste 2 doigts : ANNULE toute sélection d'emplacement amorcée
        multiTouch = true; twoMode = "none"; longPressed = false;
        this.abortSlotSel();   // un geste 2 doigts ne sélectionne JAMAIS de zone de placement (cf. bug U bloqué)
        this.drag = null;
        const c = centroid(e.touches); centroidStart = c; pinchStart = pinchDist(e.touches);
        this._pinchDist = pinchStart; this._touchPos = [c.x, c.y];
        this.beginPointer(c.x, c.y, 2, false);
      } else return;
      e.preventDefault();
    }, { passive: false });

    dom.addEventListener("touchmove", (e) => {
      if (!this.drag) return;
      if (this.drag.btn === 2) {   // ---- geste 2 doigts : ORBITE *ou* ZOOM, exclusif et verrouillé ----
        if (e.touches.length < 2) return;   // 2→1 : on attend le décollage complet (pas de bascule en pan)
        const c = centroid(e.touches), d = pinchDist(e.touches);
        if (twoMode === "none") {
          const dPinch = Math.abs(d - pinchStart), dPan = Math.hypot(c.x - centroidStart.x, c.y - centroidStart.y);
          if (dPinch >= PINCH_LOCK && dPinch >= dPan) twoMode = "zoom";
          else if (dPan >= ORBIT_LOCK) twoMode = "orbit";
          // indécis : on garde les références à jour pour ne pas « sauter » au verrouillage
          this.drag.x = c.x; this.drag.y = c.y; this._pinchDist = d; this._touchPos = [c.x, c.y];
          e.preventDefault(); return;
        }
        if (twoMode === "zoom") {   // pan/orbite DÉSACTIVÉ
          const base = this._pinchDist || d, factor = d / base;
          if (Math.abs(factor - 1) > 0.002) this.zoomToCursor(factor, c.x, c.y);
          this._pinchDist = d; this.drag.x = c.x; this.drag.y = c.y; this._touchPos = [c.x, c.y];
        } else {   // orbit : zoom DÉSACTIVÉ
          this._pinchDist = d; this._touchPos = [c.x, c.y];
          this.onMove({ clientX: c.x, clientY: c.y } as MouseEvent);
        }
        e.preventDefault(); return;
      }
      // ---- 1 doigt : pan / sélection d'emplacements ----
      if (!e.touches.length) return;
      const t = e.touches[0];
      if ((pressTimer || longPressed) && Math.hypot(t.clientX - pressX, t.clientY - pressY) > LONG_PRESS_MOVE) dismissLongPress();   // pan → ferme le long-press
      this._touchPos = [t.clientX, t.clientY];
      this.onMove({ clientX: t.clientX, clientY: t.clientY } as MouseEvent);
      e.preventDefault();
    }, { passive: false });

    const endTouch = (e: TouchEvent) => {
      if (e.touches.length > 0) {   // décollage PARTIEL : on reste verrouillé jusqu'au décollage complet (pas de pan mono)
        const c = e.touches.length >= 2 ? centroid(e.touches) : { x: e.touches[0].clientX, y: e.touches[0].clientY };
        this._touchPos = [c.x, c.y];
        if (this.drag) this.drag.moved = true;   // neutralise tout pick résiduel
        e.preventDefault(); return;
      }
      // décollage COMPLET
      this._pinchDist = null;
      cancelLongPress();
      const d = this.drag, p = this._touchPos || [0, 0];
      // TAP franc d'1 doigt en mode normal → géré par la détection double-tap (menu vs pick différé). Tout le reste
      // (glisser, slotsel, mesure/route, geste multi-doigts) → onUp standard.
      const isTap = !multiTouch && !!d && d.btn === 0 && !d.moved && d.mode === "pan" && this.toolMode === "none";
      if (isTap) {
        this.drag = null;
        if (!longPressed) handleTap(p[0], p[1], e.timeStamp);   // long-press : highlight + tooltip restent épinglés (PAS de pick)
      } else {
        if (multiTouch && d) d.moved = true;   // geste multi-doigts → jamais de pick parasite (slotsel déjà annulé)
        this.onUp({ clientX: p[0], clientY: p[1] } as MouseEvent);   // slotsel commit / mesure / route / fin de glisser
      }
      multiTouch = false; twoMode = "none";
      e.preventDefault();
    };
    dom.addEventListener("touchend", endTouch, { passive: false });
    dom.addEventListener("touchcancel", endTouch, { passive: false });
  }

  /** Zoom VERS LE CURSEUR : garde le point monde sous le curseur fixe à l'écran (au plan de la cible) en décalant
      la cible de (Δ monde/pixel) le long des axes écran droite/haut. `worldPerPixel ∝ 1/zoom` (ortho ET perspective). */
  protected zoomToCursor(factor: number, clientX: number, clientY: number): void {
    const cam = this.camera, dom = this.renderer?.domElement; if (!cam || !dom) return;
    const newZoom = Math.max(0.05, Math.min(40, this.zoom * factor));
    if (newZoom === this.zoom) return;
    const wppBefore = this.worldPerPixel();
    this.zoom = newZoom;
    const wppAfter = this.worldPerPixel();
    const r = dom.getBoundingClientRect();
    const dxPix = (clientX - r.left) - r.width / 2, dyPix = (clientY - r.top) - r.height / 2;
    const right = new THREE.Vector3(), up = new THREE.Vector3();
    cam.matrixWorld.extractBasis(right, up, new THREE.Vector3());   // axes écran (orientation indépendante du zoom)
    const k = wppBefore - wppAfter;
    this.target.addScaledVector(right, dxPix * k).addScaledVector(up, -dyPix * k);
    this.updateCamera(); this.request();
  }

  protected onMove = (e: MouseEvent): void => {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX; this.drag.y = e.clientY;
    if (!this.drag.moved && Math.hypot(e.clientX - this.drag.downX, e.clientY - this.drag.downY) > 4) {   // AMORCE du geste (seuil 4 px)
      this.drag.moved = true;
      if (this.drag.btn === 2) this._navMovedR = true;
      if (this.drag.mode === "orbit") this.recenterPivotOnView();   // orbite : recentre le pivot sur ce qu'on regarde
    }
    if (this.drag.mode === "slotsel") { this.extendSlotSel(e.clientX, e.clientY); return; }   // sélection d'emplacements (pas d'orbite/pan)
    if (this.drag.mode === "orbit") {
      this.az -= dx * 0.008;
      this.el = Math.max(-1.5, Math.min(1.5, this.el + dy * 0.008));
    } else {
      // pan : déplacer la cible dans le plan écran (droite/haut caméra), à l'échelle de la projection
      const cam = this.camera; if (!cam) return;
      const k = this.worldPerPixel();
      const right = new THREE.Vector3(); const up = new THREE.Vector3();
      cam.matrixWorld.extractBasis(right, up, new THREE.Vector3());
      this.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
    }
    this.updateCamera(); this.request();
  };

  protected onUp = (e: MouseEvent): void => {
    const d = this.drag; this.drag = null;
    if (d && d.mode === "slotsel") { this.commitSlotSel(); return; }   // relâche la sélection d'emplacements → assignation
    if (d && d.btn === 0 && !d.moved) {   // clic GAUCHE franc (pas un glisser de navigation)
      if (this.toolMode === "measure") { this.measureClick(e.clientX, e.clientY); return; }   // pose un point de mesure
      if (this.toolMode === "route") { this.routeClick(e.clientX, e.clientY); return; }       // choisit un port/waypoint
      this.pick(e.clientX, e.clientY);   // sinon : picking normal (formulaires)
    }
  };

  /* ---- sélection multiple d'emplacements U libres (glisser vertical) ---- */
  /** Rangée PRÉCISE (U bas / uTop) dans une BANDE d'emplacements libres FUSIONNÉE : les emplacements contigus
      sont UN seul mesh (perf iGPU — cf. DcThreeScene, un mesh par U mettait les petits GPU à genoux) ; la rangée
      visée est retrouvée depuis la position LOCALE du point d'impact. slotU/slotSide = plan `slotPlane` tourné
      ±π/2 (axe local y ↔ ±z monde selon la face) ; slotWall = quad en coordonnées locales de baie (z direct,
      bornes zLo/zHi portées par le descripteur). Bande d'une seule rangée → renvoi direct. */
  protected slotRowFromHit(h: THREE.Intersection, p: any): number {
    const base = (p.uLo != null) ? p.uLo : (p.uTop != null ? p.uTop : p.u);
    if (p.uLo == null || p.uHi == null || p.uHi === p.uLo || !h.point) return base;
    const step = p.rowStep || 1, nRows = Math.floor((p.uHi - p.uLo) / step) + 1;
    const mesh = h.object as THREE.Mesh;
    let f = 0;   // fraction 0 (bas de bande) → 1 (haut)
    if (p.type === "slotWall") {
      const z = mesh.worldToLocal(h.point.clone()).z;
      f = (z - p.zLo) / Math.max(1e-6, p.zHi - p.zLo);
    } else {
      const local = mesh.worldToLocal(h.point.clone());
      const geoH = ((mesh.geometry as any).parameters?.height) || 1;
      const front = (p.side || p.face) !== "rear";   // slotPlane : Rx(+π/2) → +y local = +z monde ; Rx(−π/2) → −z
      f = ((front ? local.y : -local.y) + geoH / 2) / geoH;
    }
    return p.uLo + step * Math.min(nRows - 1, Math.max(0, Math.floor(f * nRows)));
  }

  /** Emplacement U LIBRE sous le curseur (le plus proche), ou null. */
  protected slotUnder(clientX: number, clientY: number): { rackId: string; side: string; u: number } | null {
    for (const h of this.rayHits(clientX, clientY)) {
      const p: any = h.object.userData && h.object.userData.pick;
      if (!p) continue;
      if (p.type === "slotU" && p.rackId) return { rackId: p.rackId, side: p.side, u: this.slotRowFromHit(h, p) };
      // Un OCCUPANT (équipement / pseudo-élément) ou une PAROI OPAQUE de baie DEVANT capture le geste → on
      // n'attrape PAS un emplacement libre situé DERRIÈRE (corrige : drag sur un pseudo-équipement → sélection
      // « à travers » des emplacements vides à l'arrière). Le tap/clic sera traité par l'occupant (pick).
      if (p.type === "occ") return null;
      if (p.type === "rack" && this.frontFacing(h) && this.rackSolid(h)) return null;
    }
    return null;
  }

  /** Carte u→mesh des emplacements U LIBRES d'une (baie, face) — bornes de contiguïté de la sélection.
      Les emplacements sont FUSIONNÉS en bandes : chaque U d'une bande pointe vers le MÊME mesh. */
  protected collectFreeSlots(rackId: string, side: string): Map<number, THREE.Object3D> {
    const map = new Map<number, THREE.Object3D>();
    this.gRacks && this.gRacks.traverse((o: any) => {
      const p = o.userData && o.userData.pick;
      if (!p || p.type !== "slotU" || p.rackId !== rackId || p.side !== side) return;
      const lo = (p.uLo != null) ? p.uLo : p.u, hi = (p.uHi != null) ? p.uHi : lo;
      for (let u = lo; u <= hi; u++) map.set(u, o);
    });
    return map;
  }

  /** Étend la sélection vers l'emplacement survolé, EN RESTANT contiguë et libre (s'arrête au 1er U occupé) ;
      ignore tout emplacement d'une autre baie/face (impossible de sélectionner hors de la colonne courante). */
  protected extendSlotSel(clientX: number, clientY: number): void {
    const sel = this.slotSel; if (!sel) return;
    const s = this.slotUnder(clientX, clientY);
    if (!s || s.rackId !== sel.rackId || s.side !== sel.side) return;   // hors colonne → garde la sélection courante
    const dir = s.u >= sel.anchor ? 1 : -1;
    let end = sel.anchor;
    for (let u = sel.anchor; u !== s.u; u += dir) { const nu = u + dir; if (!sel.slots.has(nu)) break; end = nu; }   // contigu & libre
    const lo = Math.min(sel.anchor, end), hi = Math.max(sel.anchor, end);
    if (lo !== sel.lo || hi !== sel.hi) { sel.lo = lo; sel.hi = hi; this.applySlotSel(); }
  }

  /** Surligne la plage [lo,hi] via un PLAN DE SÉLECTION dédié, enfant de la bande (hérite de sa pose/visibilité).
      Les emplacements étant fusionnés en bandes, teinter le matériau du mesh surlignerait TOUTE la bande —
      le plan dédié couvre exactement la plage, mutée en place pendant le glisser. La sélection reste dans UNE
      bande par construction (extendSlotSel s'arrête au 1er U manquant = bord de bande). */
  protected applySlotSel(): void {
    const sel = this.slotSel; if (!sel) return;
    const band = sel.slots.get(sel.anchor) as THREE.Mesh | undefined; if (!band) return;
    if (!sel.overlay) {
      const mat = new THREE.MeshBasicMaterial({ color: 0x4a90e2, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
      sel.overlay = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);   // plan UNITAIRE, redimensionné par scale
      sel.overlay.renderOrder = 6;
      band.add(sel.overlay);
    }
    const pb: any = band.userData.pick;
    const front = pb.side !== "rear";
    const geoW = ((band.geometry as any).parameters?.width) || 1;
    sel.overlay.scale.set(geoW, Math.max(1, (sel.hi - sel.lo + 1) * U_MM - 3), 1);
    sel.overlay.position.set(0, (front ? 1 : -1) * (((sel.lo + sel.hi) / 2) - ((pb.uLo + pb.uHi) / 2)) * U_MM, 0.5);
    this.request();
  }

  /** Détruit le plan de sélection (géométrie + matériau dédiés). */
  protected disposeSlotSelOverlay(sel: { overlay: THREE.Mesh | null }): void {
    const ov = sel.overlay; sel.overlay = null; if (!ov) return;
    ov.parent?.remove(ov);
    ov.geometry.dispose(); (ov.material as THREE.Material).dispose();
  }

  /** Relâche : ouvre l'assignation pour la plage sélectionnée (hauteur = nb d'U) → la liste d'équipements
      est filtrée à cette hauteur par le formulaire (pré-sélection). Le rebuild rétablit la scène au retour. */
  protected commitSlotSel(): void {
    const sel = this.slotSel; this.slotSel = null; if (!sel) return;
    this.disposeSlotSelOverlay(sel); this.request();
    Haptics.confirm();   // validation d'une plage d'emplacements → confirmation tactile
    this.host.assignSlot?.(sel.rackId, sel.lo, sel.side, sel.hi - sel.lo + 1, () => this.rebuild(this.builtDc));
  }

  /** ANNULE une sélection d'emplacements en cours SANS valider (retire la surbrillance) — utilisé quand un 2e doigt
      arrive : un geste 2 doigts ne doit jamais sélectionner ni laisser une zone de placement surlignée. */
  protected abortSlotSel(): void {
    const sel = this.slotSel; this.slotSel = null; if (!sel) return;
    this.disposeSlotSelOverlay(sel); this.request();
  }

  /* ---- picking (raycasting) ---- */
  /** Cibles cliquables sous (clientX,clientY) triées du plus proche au plus lointain.
      `pickablesOnly` (défaut) : n'intersecte QUE les objets porteurs de `userData.pick` — tous les consommateurs
      (pick / targetAt / hoverTargetAt) ne lisent que ça, et les objets SANS pick (arêtes EdgesGeometry testées
      segment PAR segment, étiquettes, sprites, grilles) ne faisaient que payer leur géométrie au raycast à chaque
      survol. `false` = toutes les SURFACES visibles (outil mesure : accrocher n'importe quelle surface). */
  protected rayHits(clientX: number, clientY: number, pickablesOnly = true): THREE.Intersection[] {
    const cam = this.camera, dom = this.renderer?.domElement; if (!cam || !dom || !this.content) return [];
    const r = dom.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, cam);
    if (!pickablesOnly) {
      // three NE filtre PAS les objets masqués (.visible=false) au raycast → on les écarte (ex. couches ports/noms/portes
      // basculées en visibilité sans reconstruction : un mesh masqué ne doit ni être survolé ni cliqué).
      return this.raycaster.intersectObjects(this.content.children, true).filter((h) => this.hitVisible(h.object));
    }
    // Collecte des cibles ÉLAGUÉE par visibilité (un sous-arbre masqué est ignoré → le filtre hitVisible
    // a posteriori devient inutile) ; la traversée est un simple parcours d'objets, sans aucun calcul d'intersection.
    const targets: THREE.Object3D[] = [];
    const collect = (o: THREE.Object3D): void => {
      if (o.visible === false) return;
      if (o.userData && o.userData.pick) targets.push(o);
      for (const c of o.children) collect(c);
    };
    collect(this.content);
    return this.raycaster.intersectObjects(targets, false);
  }

  /** Vrai si l'objet ET tous ses ancêtres sont visibles (la visibilité three ne cascade pas dans le raycast). */
  protected hitVisible(o: THREE.Object3D | null): boolean {
    for (let n: THREE.Object3D | null = o; n; n = n.parent) if (n.visible === false) return false;
    return true;
  }

  /** Vrai si la face touchée est tournée VERS la caméra (normale opposée au rayon).
      Les capots/coques sont `DoubleSide` (visibles de l'intérieur) → le raycast touche aussi leur face ARRIÈRE :
      on ne retient la baie que sur une face extérieure, sinon un clic « dans » la baie l'attrape par sa paroi du fond. */
  protected frontFacing(h: THREE.Intersection): boolean {
    const f: any = h.face; if (!f || !f.normal) return true;   // ligne/sprite (pas de face) → pas concerné
    const n = f.normal.clone().transformDirection(h.object.matrixWorld);
    return n.dot(this.raycaster.ray.direction) < 0;
  }

  /** Vrai si la FACE de baie touchée est OPAQUE (capot/paroi pleine) → elle occulte le contenu derrière et
      gagne le picking à sa profondeur. Une face translucide (coque/porte/face « ouverte » av-ar) reste en repli
      basse priorité (clic-through vers les occupants visibles à travers). Déduit du matériau de la face touchée
      (la coque est une BoxGeometry multi-matériaux : parois ±X opaques, faces av/ar/toit/sol transparentes). */
  protected rackSolid(h: THREE.Intersection): boolean {
    const pk: any = (h.object as any).userData && (h.object as any).userData.pick;
    if (pk && pk.door) return false;   // porte : jamais occultante → clic-through vers les équipements derrière
    let m: any = (h.object as any).material;
    if (Array.isArray(m)) { const fi = (h.face as any) ? (h.face as any).materialIndex : 0; m = m[fi != null ? fi : 0]; }
    if (!m) return false;
    return !m.transparent || (typeof m.opacity === "number" && m.opacity >= 0.9);
  }

  /** Ouvre le formulaire d'une LIAISON piquée : câble → form câble ; faisceau (trunk) → form faisceau. */
  protected openLinePick(line: { type: string; id: string }): void {
    if (line.type === "trunk") this.host.openCableBundleForm?.(line.id);
    else this.host.openCableForm?.(line.id);
  }

  /** Clic : câble/faisceau/waypoint → form ; occupant (équipement) → détail ; sinon baie → formulaire (occupants priment). */
  protected pick(clientX: number, clientY: number): void {
    const hits = this.rayHits(clientX, clientY);
    let rackId: string | null = null;
    // Parmi les LIAISONS (câbles + faisceaux) de la « zone de sélection », l'éligible est la plus PROCHE DU RAYON
    // (distance latérale), PAS la plus proche en profondeur. (Une liaison touchée prime sur équipement/baie quand cablesOnTop.)
    let lineBest: { type: string; id: string } | null = null, bestD = Infinity;
    for (const h of hits) {
      const pp: any = h.object.userData && h.object.userData.pick;
      if (pp && (pp.type === "cable" || pp.type === "trunk") && h.point) { const dd = this.raycaster.ray.distanceToPoint(h.point); if (dd < bestD) { bestD = dd; lineBest = { type: pp.type, id: pp.id }; } }
    }
    const cableTop = this.opts.cablesOnTop && lineBest;   // liaison prioritaire (dessinée au-dessus)
    for (const h of hits) {
      const p = (h.object.userData && h.object.userData.pick) as { type: string; kind?: string; id: string; cable?: string | null; rackId?: string; u?: number; side?: string; height?: number; face?: string; lr?: string; col?: number; uTop?: number; wall?: string; margin?: string; cx?: number; cy?: number } | undefined;
      if (!p) continue;
      // Emplacements libres FUSIONNÉS en bandes : le U / uTop précis est recalculé depuis le point d'impact.
      if (p.type === "slotU" && p.rackId) {   // emplacement U libre → dialogue d'assignation (rebuild au retour)
        this.host.assignSlot?.(p.rackId, this.slotRowFromHit(h, p), p.side!, p.height || 1, () => this.rebuild(this.builtDc));
        return;
      }
      if (p.type === "slotSide" && p.rackId) {   // emplacement LATÉRAL libre → assignation (équipement / pin latéral)
        this.host.assignSideSlot?.(p.rackId, p.face!, p.lr!, p.col!, this.slotRowFromHit(h, p), () => this.rebuild(this.builtDc));
        return;
      }
      if (p.type === "slotWall" && p.rackId) {   // emplacement MURAL libre → équipement en paroi
        this.host.assignWallSlot?.(p.rackId, p.wall!, p.margin!, p.col!, this.slotRowFromHit(h, p), () => this.rebuild(this.builtDc));
        return;
      }
      if (p.type === "slotCap" && p.rackId) {   // trou de capot libre → poser un pin
        this.host.assignCapSlot?.(p.rackId, p.face!, p.cx!, p.cy!, () => this.rebuild(this.builtDc));
        return;
      }
      if (p.type === "keepblankReserve" && p.id) {   // bande hachurée KeepBlank → LIBÉRER la réservation
        this.host.removeRackItem?.(p.id, () => this.rebuild(this.builtDc));
        return;
      }
      if (p.type === "port") {   // port câblé → édite le câble ; port libre → nouveau câble prérempli
        if (p.cable) this.host.openCableForm?.(p.cable); else this.host.openCableForm?.(null, { fromPortId: p.id });
        return;
      }
      if (p.type === "cable" || p.type === "trunk") { this.openLinePick(lineBest!); return; }   // liaison la PLUS PROCHE DU RAYON
      if (p.type === "wp") { this.host.openWaypointForm?.(p.id); return; }   // waypoint → form waypoint
      if (p.type === "occ") {   // occupant — mais une liaison au-dessus prime (cablesOnTop)
        if (cableTop) { this.openLinePick(lineBest!); return; }
        if (p.kind === "eq") { this.host.openEquipmentDetail?.(p.id); return; }
        if (p.kind === "item") {   // pseudo-élément : pas de fiche → ouvre son menu (Retirer), comme au clic SVG
          if (this.ctxCb) { if (this.tipCb) this.tipCb(null, 0, 0); this.ctxCb(p, clientX, clientY); }
          return;
        }
        continue;   // brosse : géré par son propre pick (type wp)
      }
      if (p.type === "rack" && this.frontFacing(h)) {
        // capot/paroi OPAQUE : occlut → gagne à sa profondeur (l'occupant DERRIÈRE est masqué) ;
        // coque/porte translucide : repli basse priorité (clic-through vers occupants visibles à travers).
        if (this.rackSolid(h)) { if (cableTop) { this.openLinePick(lineBest!); return; } (this.host.openRackDetail || this.host.openRackForm)?.(p.id); return; }
        if (!rackId) rackId = p.id;   // 1re coque (face extérieure), en repli
      }
    }
    if (cableTop) { this.openLinePick(lineBest!); return; }   // liaison au-dessus prime sur la baie de repli
    if (rackId) (this.host.openRackDetail || this.host.openRackForm)?.(rackId);
  }

  /** Résout la cible sous (clientX,clientY) pour TOOLTIP/MENU : renvoie son `pick` (occ · rack · câble · wp · port),
      avec la même priorité qu'au clic (précis > câble si au-dessus > occupant > baie). Les slots sont ignorés. */
  protected targetAt(clientX: number, clientY: number): any {
    const hits = this.rayHits(clientX, clientY);
    let lineBest: { type: string; id: string } | null = null, bestD = Infinity;
    for (const h of hits) { const pp: any = h.object.userData && h.object.userData.pick; if (pp && (pp.type === "cable" || pp.type === "trunk") && h.point) { const dd = this.raycaster.ray.distanceToPoint(h.point); if (dd < bestD) { bestD = dd; lineBest = { type: pp.type, id: pp.id }; } } }
    const cableTop = this.opts.cablesOnTop && lineBest;
    let rackId: string | null = null, roomId: string | null = null, floorPlane: any = null;
    for (const h of hits) {
      const p: any = h.object.userData && h.object.userData.pick; if (!p) continue;
      if (p.type === "port" || p.type === "wp") return p;
      if (p.type === "cable" || p.type === "trunk") return lineBest;
      if (p.type === "occ") { if (cableTop) return lineBest; if (p.kind === "eq" || p.kind === "item") return p; continue; }
      if (p.type === "rack" && this.frontFacing(h)) {
        if (this.rackSolid(h)) { if (cableTop) return lineBest; return { type: "rack", id: p.id }; }   // capot/paroi opaque : occlut
        if (!rackId) rackId = p.id;   // coque translucide : repli
      }
      if (p.type === "room" && !roomId) roomId = p.id;   // sol de la salle : repli de plus basse priorité
      if (p.type === "floorplane" && !floorPlane) floorPlane = p;   // dalle d'étage (multi-salles) : repli ULTIME
    }
    if (cableTop) return lineBest;
    if (rackId) return { type: "rack", id: rackId };
    if (roomId) return { type: "room", id: roomId };   // sol d'un DC sous le curseur → menu de la salle
    if (floorPlane) return floorPlane;                 // sinon la dalle d'étage nue → menu d'étage (éditer plan / + salle)
    return null;
  }

  /** Survol : met en évidence l'occupant-équipement sous le curseur (emissive) + curseur pointer. */
  /** Cible à mettre en évidence au survol sous (clientX,clientY) — cible PRÉCISE (waypoint · port · slots) d'abord,
      puis câble (proximité latérale), puis occupant (câble au-dessus prime), puis baie opaque. Renvoie AUSSI
      l'intersection (le point d'impact identifie la RANGÉE dans une bande d'emplacements fusionnée). */
  protected hoverHitAt(clientX: number, clientY: number): { target: THREE.Object3D | null; hit: THREE.Intersection | null } {
    const hits = this.rayHits(clientX, clientY);
    let cableObj: THREE.Object3D | null = null, cableHit: THREE.Intersection | null = null, bestD = Infinity;
    for (const h of hits) {
      const pp: any = h.object.userData && h.object.userData.pick;
      if (pp && (pp.type === "cable" || pp.type === "trunk") && h.point) { const dd = this.raycaster.ray.distanceToPoint(h.point); if (dd < bestD) { bestD = dd; cableObj = h.object; cableHit = h; } }
    }
    const cableTop = this.opts.cablesOnTop && cableObj;
    for (const h of hits) {
      const p: any = h.object.userData && h.object.userData.pick;
      if (!p) continue;
      if (p.type === "wp" || p.type === "port" || p.type === "slotU" || p.type === "slotSide" || p.type === "slotWall" || p.type === "slotCap" || p.type === "keepblankReserve") return { target: h.object, hit: h };
      if (p.type === "cable" || p.type === "trunk") return { target: cableObj, hit: cableHit };
      if (p.type === "occ" && (p.kind === "eq" || p.kind === "item")) return cableTop ? { target: cableObj, hit: cableHit } : { target: h.object, hit: h };   // équipement / pseudo-élément
      if (p.type === "rack" && this.frontFacing(h) && this.rackSolid(h)) return cableTop ? { target: cableObj, hit: cableHit } : { target: h.object, hit: h };   // capot/paroi opaque = baie
    }
    return { target: null, hit: null };
  }
  /** Variante « objet seul » (appui long tactile). */
  protected hoverTargetAt(clientX: number, clientY: number): THREE.Object3D | null { return this.hoverHitAt(clientX, clientY).target; }

  /** Applique le survol (highlight + tooltip + curseur) sur la cible sous (clientX,clientY). Renvoie la cible. */
  protected hoverApply(clientX: number, clientY: number): THREE.Object3D | null {
    const { target, hit } = this.hoverHitAt(clientX, clientY);
    if (this.tipCb) this.tipCb(target ? (target.userData && target.userData.pick) : null, clientX, clientY);
    // BANDE d'emplacements fusionnée : teinter son matériau allumerait TOUTE la bande — on surligne la seule
    // RANGÉE survolée par un plan dédié (cf. applySlotSel), suivi d'un rAF à l'autre (même cible, autre rangée).
    const p: any = target && target.userData && target.userData.pick;
    const banded = !!(p && (p.type === "slotU" || p.type === "slotSide" || p.type === "slotWall") && p.uLo != null && p.uHi !== p.uLo);
    const row = (banded && hit) ? this.slotRowFromHit(hit, p) : null;
    if (target === this.hovered && row === this._slotRowHoverRow) return target;
    this.clearHover();
    this.hovered = target;
    if (banded && row != null) this.showSlotRowHover(target as THREE.Mesh, p, row);
    else this.applyHover(target);
    const dom = this.renderer?.domElement; if (dom) dom.style.cursor = target ? "pointer" : "default";
    this.request();
    return target;
  }

  /** Plan de surbrillance de la RANGÉE survolée dans une bande d'emplacements (enfant de la bande : hérite de sa
      pose et de sa visibilité). Recréé à chaque changement de rangée (rAF-throttlé) et détruit par clearHover. */
  protected showSlotRowHover(band: THREE.Mesh, p: any, row: number): void {
    const step = p.rowStep || 1;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x4a90e2, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    mesh.renderOrder = 6;
    if (p.type === "slotWall") {
      // quad mural : géométrie en coords LOCALES de baie (mesh à l'origine) → plan ⟂ X posé dans le même repère.
      const pos = band.geometry.getAttribute("position") as THREE.BufferAttribute;
      const xp = pos.getX(0), y0 = pos.getY(0), y1 = pos.getY(1);
      const pitch = step * U_MM;
      mesh.rotation.y = Math.PI / 2;   // normale ±X ; l'axe local x devient l'axe z monde (hauteur)
      mesh.scale.set(pitch - 3, Math.abs(y1 - y0), 1);
      mesh.position.set(xp - Math.sign(xp || 1) * 0.5, (y0 + y1) / 2, p.zLo + ((row - p.uLo) / step) * pitch + pitch / 2);
    } else {
      // slotPlane (U / latéral) : plan centré sur la bande, axe local y = hauteur (±z monde selon la face).
      const front = (p.side || p.face) !== "rear";
      const geoW = ((band.geometry as any).parameters?.width) || 1;
      mesh.scale.set(geoW, step * U_MM - 3, 1);
      mesh.position.set(0, (front ? 1 : -1) * (row - (p.uLo + p.uHi) / 2) * U_MM, 0.5);
    }
    band.add(mesh);
    this._slotRowHover = mesh; this._slotRowHoverRow = row;
  }

  protected onHover = (e: MouseEvent): void => {
    if (this.drag) return;   // pas de survol pendant un glisser
    // THROTTLE rAF : mousemove peut dépasser 100 Hz alors qu'au plus UN raycast par frame AFFICHÉE est utile
    // (le rendu est de toute façon à la demande). On mémorise la dernière position, résolue au prochain rAF.
    this._hoverClient = [e.clientX, e.clientY];
    if (this._hoverRaf) return;
    this._hoverRaf = requestAnimationFrame(() => {
      this._hoverRaf = 0;
      const c = this._hoverClient; this._hoverClient = null;
      if (!c || this.drag) return;
      if (this.toolMode !== "none") { this.toolHover(c[0], c[1]); return; }   // mode outil : aperçu du segment, pas de highlight/tooltip
      this.hoverApply(c[0], c[1]);
    });
  };

  /** Couleur de surbrillance SURCHARGÉE le temps d'un applyHover (mode routage → vert « ok ») ; null = accent bleu. */
  protected _hoverColor: { emissive: number; tint: number } | null = null;

  /** Mode ROUTAGE : met en évidence la CIBLE cliquable (port ou waypoint) sous le curseur — équivalent WebGL du
      CSS 2D `.dc-routing …:hover` (vert --ok, plus explicite que l'accent normal) + curseur pointer. Les autres
      objets (baies, occupants, câbles) ne sont PAS des cibles de routage → jamais surlignés dans ce mode. */
  protected routeHoverHighlight(clientX: number, clientY: number): void {
    let target: THREE.Object3D | null = null;
    for (const h of this.rayHits(clientX, clientY)) {
      const p: any = h.object.userData && h.object.userData.pick;
      if (p && (p.type === "port" || p.type === "wp")) { target = h.object; break; }
    }
    if (target !== this.hovered) {
      this.clearHover();
      this.hovered = target;
      this._hoverColor = { emissive: 0x29c46b, tint: 0x7fe3a8 };   // vert « ok » (cf. CSS var(--ok, #29c46b))
      this.applyHover(target);
      this._hoverColor = null;
      this.request();
    }
    const dom = this.renderer?.domElement; if (dom) dom.style.cursor = target ? "pointer" : "default";
  }

  /** Éteint la mise en évidence de survol + le tooltip (utilisé à la fermeture d'un tooltip d'appui long tactile). */
  protected clearHoverAndTip(): void {
    if (this.tipCb) this.tipCb(null, 0, 0);
    this.clearHover(); this.hovered = null; this.request();
  }

  /** Applique le survol : un CÂBLE illumine TOUS ses objets (ligne + pastilles) ; une BAIE illumine TOUTES ses
      surfaces (coque + capots + portes, réparties en plusieurs meshes) ; sinon le seul objet visé. */
  protected applyHover(target: THREE.Object3D | null): void {
    this._hoverObjs = [];
    if (!target) return;
    const p: any = target.userData && target.userData.pick;
    if (p && (p.type === "cable" || p.type === "trunk")) {
      [this.cablesGroup, this.gExtra].forEach((g) => g && g.traverse((o: any) => { if (o.userData && o.userData.pick && o.userData.pick.type === p.type && o.userData.pick.id === p.id) this._hoverObjs.push(o); }));
    } else if (p && p.type === "rack") {
      this.gRacks && this.gRacks.traverse((o: any) => { if (o.userData && o.userData.pick && o.userData.pick.type === "rack" && o.userData.pick.id === p.id) this._hoverObjs.push(o); });
    } else if (p && p.type === "occ" && p.id) {
      // OCCUPANT (équipement · pseudo-élément · TRAY) : illumine TOUTE sa géométrie répartie en plusieurs
      // meshes qui partagent le même `pick.id` (corps + oreilles ; tray : plateau + oreilles + renforts) —
      // pas de manière isolée le morceau visé. + son image de face (PLAN séparé MeshBasic, tagué `eqId`).
      this._hoverObjs = [];
      [this.gRacks, this.gFree].forEach((g) => g && g.traverse((o: any) => {
        const op = o.userData && o.userData.pick;
        if ((op && op.type === "occ" && op.id === p.id) || (o.userData && o.userData.eqId === p.id)) this._hoverObjs.push(o);
      }));
      if (this._hoverObjs.indexOf(target) < 0) this._hoverObjs.push(target);
    } else {
      this._hoverObjs = [target];
    }
    this._hoverObjs.forEach((o: THREE.Object3D) => this.setHover(o, true));
  }

  protected clearHover(): void {
    this._hoverObjs.forEach((o: THREE.Object3D) => this.setHover(o, false)); this._hoverObjs = [];
    if (this._slotRowHover) {   // plan de rangée survolée (bandes d'emplacements) : détaché ET libéré
      this._slotRowHover.parent?.remove(this._slotRowHover);
      this._slotRowHover.geometry.dispose(); (this._slotRowHover.material as THREE.Material).dispose();
      this._slotRowHover = null;
    }
    this._slotRowHoverRow = null;
  }

  protected setHover(mesh: THREE.Object3D | null, on: boolean): void {
    if (!mesh) return;
    const m = (mesh as any).material as any; if (!m) return;
    // Couleurs de surbrillance : accent BLEU par défaut ; surchargées par `_hoverColor` (mode routage → vert
    // « ok », parité avec le CSS 2D `.dc-routing …:hover`). La restauration (off) relit les valeurs SAUVÉES,
    // indépendantes de la couleur appliquée.
    const hiEmissive = this._hoverColor ? this._hoverColor.emissive : 0x4a90e2;
    const hiTint = this._hoverColor ? this._hoverColor.tint : 0x9fd0ff;
    if (Array.isArray(m)) {   // multi-matériaux (coque de baie · boîte d'équip. libre à 6 faces) → par sous-matériau
      // emissive quand le matériau en a (MeshStandard) ; sinon TEINTE de la couleur (MeshBasic texturé des faces
      // d'équipement libre : pas d'emissive → sans ça, une boîte ENTIÈREMENT texturée ne réagirait pas au survol).
      if (on) {
        if (mesh.userData._emiArr == null) {
          mesh.userData._emiArr = m.map((x: any) => (x && x.emissive) ? x.emissive.getHex() : -1);
          mesh.userData._colArr = m.map((x: any) => (x && !x.emissive && x.color) ? x.color.getHex() : -1);
        }
        m.forEach((x: any) => { if (!x) return; if (x.emissive) x.emissive.setHex(hiEmissive); else if (x.color) x.color.setHex(hiTint); });
      } else if (mesh.userData._emiArr) {
        m.forEach((x: any, i: number) => {
          if (!x) return;
          if (x.emissive && mesh.userData._emiArr[i] >= 0) x.emissive.setHex(mesh.userData._emiArr[i]);
          else if (x.color && mesh.userData._colArr && mesh.userData._colArr[i] >= 0) x.color.setHex(mesh.userData._colArr[i]);
        });
        mesh.userData._emiArr = null; mesh.userData._colArr = null;
      }
      return;
    }
    if (on) {
      if (m.isLineMaterial) { mesh.userData._lw = m.linewidth; mesh.userData._lop = m.opacity; m.linewidth = m.linewidth * 2; m.opacity = 1; }   // câble : + épais + opaque
      else if (m.emissive) { mesh.userData._emissive = m.emissive.getHex(); m.emissive.setHex(hiEmissive); }
      else if (m.color) { mesh.userData._color = m.color.getHex(); m.color.setHex(hiTint); }   // sprites (marqueurs/pastilles) → teinte
      if (m.transparent && !m.map && !m.isLineMaterial) { mesh.userData._opacity = m.opacity; m.opacity = 0.9; }   // emplacements libres → ↑ opacité
    } else {
      if (mesh.userData._lw != null) { m.linewidth = mesh.userData._lw; m.opacity = mesh.userData._lop; }
      if (mesh.userData._emissive != null && m.emissive) m.emissive.setHex(mesh.userData._emissive);
      if (mesh.userData._color != null && m.color) m.color.setHex(mesh.userData._color);
      if (mesh.userData._opacity != null) m.opacity = mesh.userData._opacity;
    }
  }
}
