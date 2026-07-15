/* =============================================================================
   PerspectiveEditor — modale de REDRESSEMENT DE PERSPECTIVE d'une image (photo
   de façade prise de biais). UI interactive portée du POC `poc/perspective.html`
   dans les composants de l'app (Dialog/FormControls) ; la géométrie (homographie,
   estimation de ratio, rééchantillonnage) vit dans `geometry/Homography` (pure).

   Usage : `PerspectiveEditor.open(blob, { faceRatio, faceRatioLabel })` → Promise
   d'un Blob redressé (WebP q0.92, repli PNG) ou null (annulé). `faceRatio` (l/h)
   pré-règle les proportions au FORMAT RÉEL de la façade (19″ × U — cf.
   FormBase.faceImageRatio) — c'est le mode par défaut quand il est fourni.

   Interactions : glisser un point = ajuster · glisser le fond = déplacer la vue ·
   molette / boutons = zoom · flèches = ajustement fin du point sélectionné (Maj = ×10).
   Points de bord additionnels (0–4/côté) pour suivre une déformation non rectiligne
   (objectif grand-angle) : l'homographie passe en moindres carrés.

   RECADRAGE SÉPARÉ (toggle persisté) : par défaut le cadre de sortie = le
   quadrilatère posé (flux combiné, un temps — le cas courant). Activé, les points
   ne posent qu'une RÉFÉRENCE de rectification (n'importe quel rectangle réel bien
   net — pas forcément l'emprise utile) et le recadrage se fait en 2d temps dans
   l'image redressée (CropEditor), re-warpé à PLEINE résolution depuis la source
   (cf. sepCropFlow — un seul rééchantillonnage source → final).

   Réglages PERSISTÉS (localStorage, par navigateur) : points de bord, résolution,
   mode de proportions, ratio manuel, recadrage séparé.
   Cf. `docs/redressement-perspective.md`.
   ============================================================================= */
import { Dialog } from "./Dialog";
import { Notify } from "./Notify";
import { FormControls } from "./FormControls";
import { ImageBlob } from "./ImageBlob";
import { CropEditor } from "./CropEditor";
import { Homography } from "../geometry/Homography";
import type { RawImage } from "../geometry/Homography";

/** Point de contrôle : coin (edge = index 0..3 TL/TR/BR/BL) ou point de bord (f = fraction sur le côté). */
interface CtrlPoint { type: "corner" | "edge"; edge: number; f: number; x: number; y: number; }

export interface PerspectiveOptions {
  faceRatio?: number | null;   // ratio l/h imposé par le contexte façade (préréglage) — null/absent = aucun
  faceRatioLabel?: string;     // libellé du préréglage (ex. « Façade 2U · avec oreilles »)
}

interface PerspSettings { sub: number; res: number; arMode: string; arManual: string; sepCrop: boolean; }
const SETTINGS_KEY = "dcmanager.perspective";
const RES_OPTIONS = [1000, 1600, 2400, 3600];

export class PerspectiveEditor {
  /** Ouvre l'éditeur sur `source` ; résout le Blob REDRESSÉ (WebP, repli PNG) ou null si annulé. */
  static open(source: Blob, opts: PerspectiveOptions = {}): Promise<Blob | null> {
    return this.openRaw(source, opts).then((raw) => (raw ? ImageBlob.fromRaw(raw) : null));
  }

  /** Variante RawImage (SANS encodage) — pour enchaîner les outils sans perte (cf. StitchEditor :
      chaque photo redressée reste brute, un seul encodage WebP à la toute fin). */
  static openRaw(source: Blob, opts: PerspectiveOptions = {}): Promise<RawImage | null> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(source);
      const img = new Image();
      img.onerror = () => { URL.revokeObjectURL(url); Notify.toast("Impossible de charger l'image.", "err"); resolve(null); };
      img.onload = () => { URL.revokeObjectURL(url); this.openLoaded(img, opts).then(resolve); };
      img.src = url;
    });
  }

  /* ---- réglages persistés (par navigateur — préférences d'outil, pas de document) ---- */
  private static loadSettings(): PerspSettings {
    const s: PerspSettings = { sub: 0, res: 1600, arMode: "auto", arManual: "", sepCrop: false };
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY); if (!raw) return s;
      const p = JSON.parse(raw); if (!p || typeof p !== "object") return s;
      if (typeof p.sub === "number") s.sub = Math.max(0, Math.min(4, p.sub | 0));
      if (RES_OPTIONS.includes(p.res)) s.res = p.res;
      if (["auto", "manual", "square", "face"].includes(p.arMode)) s.arMode = p.arMode;
      if (typeof p.arManual === "string") s.arManual = p.arManual;
      if (typeof p.sepCrop === "boolean") s.sepCrop = p.sepCrop;
    } catch (_) { /* défauts */ }
    return s;
  }
  private static saveSettings(s: PerspSettings): void {
    try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (_) { /* quota → ignoré */ }
  }

  /** Cible d'un point de contrôle dans le rectangle de sortie (coins → angles, bords → fraction du côté). */
  private static destFor(p: CtrlPoint, outW: number, outH: number): [number, number] {
    if (p.type === "corner") return ([[0, 0], [outW, 0], [outW, outH], [0, outH]] as Array<[number, number]>)[p.edge];
    switch (p.edge) {
      case 0: return [p.f * outW, 0];
      case 1: return [outW, p.f * outH];
      case 2: return [(1 - p.f) * outW, outH];
      default: return [0, (1 - p.f) * outH];
    }
  }

  private static openLoaded(img: HTMLImageElement, opts: PerspectiveOptions): Promise<RawImage | null> {
    // Source DESSINABLE courante + dimensions : MUTABLES — la ROTATION 90° remplace la source par un canvas
    // pivoté (et permute les dimensions). Tout le reste (render, warp, ratio auto) lit ces variables.
    let source: HTMLImageElement | HTMLCanvasElement = img;
    let imgW = img.naturalWidth, imgH = img.naturalHeight;
    const faceRatio = (opts.faceRatio && isFinite(opts.faceRatio) && opts.faceRatio > 0) ? opts.faceRatio : null;
    const st = this.loadSettings();
    // RECADRAGE SÉPARÉ (persisté) : les points ne posent qu'une RÉFÉRENCE de rectification (n'importe quel
    // rectangle réel bien net) ; l'emprise UTILE se recadre ensuite dans l'image redressée (CropEditor).
    let sepCrop = st.sepCrop;
    // mode par défaut : le préréglage FAÇADE prime quand le contexte le fournit — SAUF en recadrage séparé
    // (la référence n'est pas le panneau entier → ses proportions se mesurent en Auto ; le ratio façade
    // s'applique au CADRE de l'étape 2). Sinon le dernier mode utilisé.
    let arMode = (faceRatio && !sepCrop) ? "face" : (st.arMode === "face" ? "auto" : st.arMode);
    let sub = st.sub, res = st.res;
    let points: CtrlPoint[] = [];
    let selected = -1, dragPt = -1, panning = false, last = { x: 0, y: 0 };
    // MODE DE POSE SÉQUENTIELLE : on clique les points un à un (ordre périmétrique) au lieu de glisser les
    // points pré-posés. placeIdx = index du prochain point à poser dans perimeter(). Le glisser reste possible après.
    let placingSeq = false, placeIdx = 0;
    const view = { scale: 1, tx: 0, ty: 0 };
    const DPR = Math.min(window.devicePixelRatio || 1, 2);

    /* ---- points ---- */
    const defaultCorners = (): Array<[number, number]> => {
      const mx = imgW * 0.18, my = imgH * 0.18;
      return [[mx, my], [imgW - mx, my], [imgW - mx, imgH - my], [mx, imgH - my]];
    };
    const buildPoints = (): void => {
      const c = defaultCorners();
      const pts: CtrlPoint[] = [];
      for (let i = 0; i < 4; i++) pts.push({ type: "corner", edge: i, f: 0, x: c[i][0], y: c[i][1] });
      if (sub > 0) {   // points de bord posés à leur position PROJECTIVE correcte sur le quad courant
        const H4 = Homography.solve([[0, 0], [1, 0], [1, 1], [0, 1]], c);
        const uv = (e: number, f: number): [number, number] => e === 0 ? [f, 0] : e === 1 ? [1, f] : e === 2 ? [1 - f, 1] : [0, 1 - f];
        for (let e = 0; e < 4; e++) for (let k = 1; k <= sub; k++) {
          const f = k / (sub + 1), [ux, uy] = uv(e, f), [ix, iy] = Homography.apply(H4, ux, uy);
          pts.push({ type: "edge", edge: e, f, x: ix, y: iy });
        }
      }
      points = pts; selected = -1;
    };
    const corners = (): Array<[number, number]> => [0, 1, 2, 3].map((e) => { const p = points.find((q) => q.type === "corner" && q.edge === e)!; return [p.x, p.y]; });
    // ordre périmétrique (contour) : coin e, puis points de bord du côté e triés par f.
    const perimeter = (): CtrlPoint[] => {
      const out: CtrlPoint[] = [];
      for (let e = 0; e < 4; e++) {
        out.push(points.find((p) => p.type === "corner" && p.edge === e)!);
        points.filter((p) => p.type === "edge" && p.edge === e).sort((a, b) => a.f - b.f).forEach((p) => out.push(p));
      }
      return out;
    };

    /* ---- ratio de sortie ---- */
    const getAspect = (manualRaw: string): number => {
      if (arMode === "face" && faceRatio) return faceRatio;
      if (arMode === "square") return 1;
      if (arMode === "manual") {
        const m = manualRaw.trim().match(/(\d+(?:\.\d+)?)\s*[:\/xX]\s*(\d+(?:\.\d+)?)/);
        if (m) { const r = parseFloat(m[1]) / parseFloat(m[2]); if (isFinite(r) && r > 0) return r; }
        const num = parseFloat(manualRaw.replace(",", "."));
        if (isFinite(num) && num > 0) return num;
      }
      return Homography.estimateAspect(corners(), imgW, imgH);   // auto (et repli du manuel invalide)
    };

    return Dialog.custom({
      title: "Redresser la perspective",
      message: "Posez les points sur les coins du rectangle déformé (l'image de la façade), puis redressez.",
      wide: true, confirmLabel: "Redresser et utiliser", cancelLabel: "Annuler",
      build: (root: HTMLElement) => {
        /* ---- barre d'outils (2 rangées, mêmes classes que l'éditeur de façade) ---- */
        const bar1 = document.createElement("div"); bar1.className = "face-toolbar"; bar1.style.flexWrap = "wrap";
        const mkBtn = (txt: string, title = "") => { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost btn-sm"; b.textContent = txt; if (title) b.title = title; return b; };
        const lab = (txt: string) => { const s = document.createElement("span"); s.style.cssText = "font-size:11px;color:var(--fg-dim);"; s.textContent = txt; return s; };
        const subMinus = mkBtn("−", "Moins de points de bord"); const subVal = lab("0"); subVal.style.minWidth = "12px"; subVal.style.textAlign = "center";
        const subPlus = mkBtn("+", "Plus de points de bord (suivre une déformation non rectiligne — le total reste 4 + 4×n)");
        const resetBtn = mkBtn("Replacer les points");
        const seqBtn = mkBtn("Pose séquentielle", "Poser les points un à un en cliquant (coins puis points de bord) — placement précis. Le glisser reste disponible ensuite pour ajuster.");
        const rotL = mkBtn("⟲ 90°", "Pivoter l'image de 90° vers la gauche (anti-horaire) — les points suivent");
        const rotR = mkBtn("⟳ 90°", "Pivoter l'image de 90° vers la droite (horaire) — les points suivent");
        const sepBtn = mkBtn("Recadrage séparé", "Dissocier le RECADRAGE du redressement : les points posent une RÉFÉRENCE (n'importe quel rectangle réel bien net — bandeau, vis, trous de rail), l'emprise UTILE se recadre ensuite dans l'image redressée. Désactivé : le cadre de sortie = le quadrilatère posé (flux combiné).");
        const zoomOut = mkBtn("−", "Dézoomer"); const zoomLvl = lab("100 %"); zoomLvl.style.minWidth = "40px"; zoomLvl.style.textAlign = "center";
        const zoomIn = mkBtn("+", "Zoomer"); const zoomFit = mkBtn("Ajuster", "Ajuster l'image à l'écran");
        const spacer = document.createElement("span"); spacer.style.flex = "1";
        bar1.append(lab("Points de bord :"), subMinus, subVal, subPlus, resetBtn, seqBtn, rotL, rotR, sepBtn, spacer, zoomOut, zoomLvl, zoomIn, zoomFit);

        const bar2 = document.createElement("div"); bar2.className = "face-toolbar"; bar2.style.flexWrap = "wrap";
        const segBtns: Record<string, HTMLButtonElement> = {};
        const seg = (id: string, txt: string, title: string) => { const b = mkBtn(txt, title); segBtns[id] = b; return b; };
        const manualI = FormControls.text(st.arManual, "ex. 16:9, 482.6:88.9, 1.41"); manualI.style.cssText = "width:150px;font-size:11px;padding:4px 6px;";
        const resSel = FormControls.select(RES_OPTIONS.map((r) => ({ value: String(r), label: r + " px" })), String(res)); resSel.style.cssText = "font-size:11px;padding:4px 6px;";
        bar2.append(lab("Proportions :"));
        if (faceRatio) bar2.append(seg("face", opts.faceRatioLabel || "Façade", "Format RÉEL de la façade (19″ × U) déduit du contexte — recommandé"));
        bar2.append(seg("auto", "Auto", "Ratio estimé depuis la perspective de la forme posée"), seg("manual", "Manuel", "Ratio saisi (l:h ou nombre)"), seg("square", "1:1", "Sortie carrée"), manualI, lab("Résolution :"), resSel);

        const hint = document.createElement("div"); hint.className = "form-hint";
        const BASE_HINT = "Glisser un point = ajuster · glisser le fond = déplacer · molette / +/− = zoom · flèches = ajustement fin du point sélectionné (Maj = ×10).";
        const CORNER_NAMES = ["haut-gauche", "haut-droite", "bas-droite", "bas-gauche"];
        const ptName = (p: CtrlPoint): string => p.type === "corner" ? ("coin " + CORNER_NAMES[p.edge]) : ("point de bord " + (p.edge + 1));
        const refreshHint = () => {
          if (placingSeq) {
            const seq = perimeter(), p = seq[placeIdx];
            hint.textContent = p ? ("Pose séquentielle : cliquez le " + ptName(p) + " (" + (placeIdx + 1) + " / " + seq.length + "). Échap ou « Pose séquentielle » pour arrêter.") : "Tous les points sont posés — ajustez au glisser si besoin.";
          } else hint.textContent = BASE_HINT;
        };
        hint.textContent = BASE_HINT;
        // RAPPEL : le préréglage façade (19″ × U, oreilles) n'est PAS réglable ici — il est déduit des champs
        // Face / U / Rendu du formulaire (ou du sélecteur) d'origine. Évite de chercher ces contrôles ici.
        let ratioHint: HTMLElement | null = null;
        if (faceRatio) {
          ratioHint = document.createElement("div"); ratioHint.className = "form-hint";
          ratioHint.textContent = "Préréglage « " + (opts.faceRatioLabel || "Façade") + " » : déduit des champs Face / U / Oreilles du formulaire d'origine — pour le changer, annulez et ajustez ces champs là-bas.";
        }

        /* ---- scène canvas ---- */
        const wrap = document.createElement("div");
        wrap.style.cssText = "position:relative;height:56vh;min-height:280px;background:var(--bg);border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-top:8px;";
        const cv = document.createElement("canvas");
        cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab;outline:none;";
        cv.tabIndex = 0;   // focusable → flèches d'ajustement fin
        wrap.appendChild(cv);
        root.append(bar1, bar2, hint, wrap);
        if (ratioHint) root.appendChild(ratioHint);
        const ctx = cv.getContext("2d")!;

        const viewSize = () => ({ w: cv.width / DPR, h: cv.height / DPR });
        const imgToScreen = (x: number, y: number): [number, number] => [x * view.scale + view.tx, y * view.scale + view.ty];
        const screenToImg = (x: number, y: number): [number, number] => [(x - view.tx) / view.scale, (y - view.ty) / view.scale];
        const updateZoom = () => { zoomLvl.textContent = Math.round(view.scale * 100) + " %"; };
        const fitView = () => {
          const { w, h } = viewSize(); const pad = 40;
          view.scale = Math.min((w - pad) / imgW, (h - pad) / imgH);
          view.tx = (w - imgW * view.scale) / 2; view.ty = (h - imgH * view.scale) / 2;
          updateZoom();
        };
        const zoomAt = (sx: number, sy: number, f: number) => {
          const [ix, iy] = screenToImg(sx, sy);
          view.scale = Math.max(0.02, Math.min(40, view.scale * f));
          view.tx = sx - ix * view.scale; view.ty = sy - iy * view.scale;
          updateZoom(); render();
        };

        const render = () => {
          const { w, h } = viewSize();
          ctx.save(); ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, w, h);
          ctx.imageSmoothingEnabled = view.scale < 3;
          ctx.drawImage(source, view.tx, view.ty, imgW * view.scale, imgH * view.scale);
          // extérieur du quad assombri (contour par les seuls coins)
          const cs = corners().map((c) => imgToScreen(c[0], c[1]));
          ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, h);
          ctx.moveTo(cs[0][0], cs[0][1]); for (let i = 1; i < 4; i++) ctx.lineTo(cs[i][0], cs[i][1]); ctx.closePath();
          ctx.fillStyle = "rgba(8,9,11,.45)"; ctx.fill("evenodd"); ctx.restore();
          // contour périmétrique (passe par les points de bord)
          ctx.beginPath();
          perimeter().forEach((p, k) => { const [sx, sy] = imgToScreen(p.x, p.y); k ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
          ctx.closePath(); ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,176,32,.85)"; ctx.stroke();
          // points : MINI-CIBLES (réticule en croix + anneau, centre AJOURÉ pour viser le pixel exact).
          // coin = ambre + n° · bord = sarcelle · sélectionné (ou prochain à poser en mode séquentiel) = blanc.
          const nextSeqPt = placingSeq ? perimeter()[placeIdx] : null;
          points.forEach((p, i) => {
            const [sx, sy] = imgToScreen(p.x, p.y);
            const isCorner = p.type === "corner";
            const active = (i === selected) || (p === nextSeqPt);
            const color = active ? "#ffffff" : (isCorner ? "#ffb020" : "#2fd1bb");
            const R = isCorner ? 11 : 9, gap = 3, ring = gap + 2;   // portée des bras · trou central · rayon de l'anneau
            // sous-couche sombre (contraste sur fond clair) puis trait couleur — dessinés en 2 passes.
            const strokeReticle = () => {
              ctx.beginPath();
              ctx.moveTo(sx - R, sy); ctx.lineTo(sx - gap, sy); ctx.moveTo(sx + gap, sy); ctx.lineTo(sx + R, sy);
              ctx.moveTo(sx, sy - R); ctx.lineTo(sx, sy - gap); ctx.moveTo(sx, sy + gap); ctx.lineTo(sx, sy + R);
              ctx.stroke();
              ctx.beginPath(); ctx.arc(sx, sy, ring, 0, 7); ctx.stroke();
            };
            ctx.lineCap = "round";
            ctx.lineWidth = active ? 4.5 : 3.6; ctx.strokeStyle = "rgba(8,9,11,.55)"; strokeReticle();   // halo sombre
            ctx.lineWidth = active ? 2.2 : 1.6; ctx.strokeStyle = color; strokeReticle();                 // trait couleur
            ctx.beginPath(); ctx.arc(sx, sy, 1, 0, 7); ctx.fillStyle = color; ctx.fill();                 // point central (pixel visé)
            if (isCorner) { ctx.font = "600 11px ui-monospace,Consolas,monospace"; ctx.lineWidth = 3; ctx.strokeStyle = "rgba(8,9,11,.75)"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.strokeText(String(p.edge + 1), sx, sy - R - 8); ctx.fillStyle = "#fff"; ctx.fillText(String(p.edge + 1), sx, sy - R - 8); }
          });
          ctx.restore();
        };

        const syncControls = () => {
          subVal.textContent = String(sub);
          subMinus.disabled = sub <= 0; subPlus.disabled = sub >= 4;
          seqBtn.className = "btn btn-sm " + (placingSeq ? "btn-primary" : "btn-ghost");
          sepBtn.className = "btn btn-sm " + (sepCrop ? "btn-primary" : "btn-ghost");
          // recadrage séparé : le préréglage FAÇADE ne s'applique pas à la RÉFÉRENCE (il migre vers l'étape de crop)
          if (segBtns.face) segBtns.face.style.display = sepCrop ? "none" : "";
          if (sepCrop && arMode === "face") arMode = "auto";
          Object.keys(segBtns).forEach((id) => { segBtns[id].className = "btn btn-sm " + (arMode === id ? "btn-primary" : "btn-ghost"); });
          manualI.style.display = arMode === "manual" ? "" : "none";
        };

        /* ---- interactions ---- */
        const evtPos = (e: PointerEvent | WheelEvent): [number, number] => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
        const hitPoint = (sx: number, sy: number): number => {
          let best = -1, bd = 14 * 14;
          points.forEach((p, i) => { const [px, py] = imgToScreen(p.x, p.y); const d = (px - sx) ** 2 + (py - sy) ** 2; if (d < bd) { bd = d; best = i; } });
          return best;
        };
        // POSE au CLIC COMPLET (mode séquentiel) : le point n'est posé qu'au pointerup SANS mouvement (clic gauche
        // ou tap tactile) — le PAN de l'image et le glisser d'un point restent donc disponibles pendant la pose.
        let seqTapStart: { x: number; y: number } | null = null;
        const placeNext = (sx: number, sy: number): void => {
          const seq = perimeter(), p = seq[placeIdx];
          if (!p) return;
          const [ix, iy] = screenToImg(sx, sy); p.x = ix; p.y = iy; selected = points.indexOf(p); placeIdx++;
          if (placeIdx >= seq.length) { placingSeq = false; cv.style.cursor = "grab"; Notify.toast("Points posés — ajustez au glisser si besoin."); }
          syncControls(); refreshHint(); render();
        };
        cv.addEventListener("pointerdown", (e) => {
          cv.setPointerCapture(e.pointerId); cv.focus();
          const [sx, sy] = evtPos(e);
          const hit = hitPoint(sx, sy);
          // candidat de POSE : clic principal, hors point existant (un point sous le doigt = sélection/drag).
          seqTapStart = (placingSeq && hit < 0 && e.button === 0) ? { x: sx, y: sy } : null;
          // curseur MASQUÉ pendant le glisser d'un point : la visée se fait au RÉTICULE (centre ajouré), sans
          // que la flèche du curseur ne recouvre le pixel visé.
          if (hit >= 0) { dragPt = hit; selected = hit; cv.style.cursor = "none"; }
          else { panning = true; selected = -1; cv.style.cursor = placingSeq ? "crosshair" : "grabbing"; }
          last = { x: sx, y: sy }; render();
        });
        cv.addEventListener("pointermove", (e) => {
          const [sx, sy] = evtPos(e);
          if (dragPt >= 0) { const [ix, iy] = screenToImg(sx, sy); points[dragPt].x = ix; points[dragPt].y = iy; render(); }
          else if (panning) { view.tx += sx - last.x; view.ty += sy - last.y; last = { x: sx, y: sy }; render(); }
        });
        const endPtr = (e: PointerEvent) => {
          // clic COMPLET (pas de mouvement au-delà du seuil — plus tolérant au tactile) → pose du point.
          if (seqTapStart && placingSeq && dragPt < 0) {
            const [sx, sy] = evtPos(e);
            const eps = (e.pointerType === "touch") ? 12 : 6;
            if (Math.hypot(sx - seqTapStart.x, sy - seqTapStart.y) <= eps) placeNext(seqTapStart.x, seqTapStart.y);
          }
          seqTapStart = null;
          dragPt = -1; panning = false; cv.style.cursor = placingSeq ? "crosshair" : "grab";
        };
        cv.addEventListener("pointerup", endPtr); cv.addEventListener("pointercancel", endPtr);
        cv.addEventListener("wheel", (e) => { e.preventDefault(); const [sx, sy] = evtPos(e); zoomAt(sx, sy, Math.pow(1.0015, -e.deltaY)); }, { passive: false });
        cv.addEventListener("keydown", (e) => {   // flèches : ajustement fin du point sélectionné
          if (e.key === "Escape" && placingSeq) { e.preventDefault(); e.stopPropagation(); placingSeq = false; cv.style.cursor = "grab"; syncControls(); refreshHint(); render(); return; }
          if (selected < 0) return;
          const step = e.shiftKey ? 10 : 1; let dx = 0, dy = 0;
          if (e.key === "ArrowLeft") dx = -step; else if (e.key === "ArrowRight") dx = step;
          else if (e.key === "ArrowUp") dy = -step; else if (e.key === "ArrowDown") dy = step; else return;
          e.preventDefault(); e.stopPropagation();
          points[selected].x += dx; points[selected].y += dy; render();
        });

        subPlus.onclick = () => { if (sub < 4) { sub++; buildPoints(); syncControls(); render(); } };
        subMinus.onclick = () => { if (sub > 0) { sub--; buildPoints(); syncControls(); render(); } };
        resetBtn.onclick = () => { buildPoints(); if (placingSeq) placeIdx = 0; syncControls(); refreshHint(); render(); };
        seqBtn.onclick = () => { placingSeq = !placingSeq; placeIdx = 0; selected = -1; cv.style.cursor = placingSeq ? "crosshair" : "grab"; syncControls(); refreshHint(); render(); };
        // ROTATION 90° de l'image : la source devient un canvas pivoté (dimensions permutées) et les POINTS
        // déjà posés SUIVENT la rotation (mêmes pixels visés). Leur RÔLE tourne AUSSI (edge +1 en horaire) :
        // le coin visuellement en haut-gauche reste « 1 » → la SORTIE du redressement suit l'orientation
        // affichée (sans quoi le warp annulerait la rotation en re-mappant l'ancien TL sur le TL de sortie).
        // La rotation étant une symétrie du périmètre, la fraction f des points de bord est préservée.
        const rotate = (cw: boolean): void => {
          const c = document.createElement("canvas"); c.width = imgH; c.height = imgW;
          const cctx = c.getContext("2d")!;
          if (cw) { cctx.translate(imgH, 0); cctx.rotate(Math.PI / 2); } else { cctx.translate(0, imgW); cctx.rotate(-Math.PI / 2); }
          cctx.drawImage(source, 0, 0);
          source = c;
          points.forEach((p) => {
            const px = p.x, py = p.y;
            if (cw) { p.x = imgH - py; p.y = px; } else { p.x = py; p.y = imgW - px; }
            p.edge = (p.edge + (cw ? 1 : 3)) % 4;
          });
          const t = imgW; imgW = imgH; imgH = t;
          fitView(); refreshHint(); render();
        };
        rotL.onclick = () => rotate(false); rotR.onclick = () => rotate(true);
        zoomIn.onclick = () => { const { w, h } = viewSize(); zoomAt(w / 2, h / 2, 1.25); };
        zoomOut.onclick = () => { const { w, h } = viewSize(); zoomAt(w / 2, h / 2, 0.8); };
        zoomFit.onclick = () => { fitView(); render(); };
        Object.keys(segBtns).forEach((id) => { segBtns[id].onclick = () => { arMode = id; syncControls(); }; });
        sepBtn.onclick = () => { sepCrop = !sepCrop; syncControls(); };

        // dimensionnement initial (la modale vient d'être posée → mesure au prochain tick) + suivi du resize.
        const ro = new ResizeObserver(() => { const r = cv.getBoundingClientRect(); cv.width = Math.round(r.width * DPR); cv.height = Math.round(r.height * DPR); fitView(); render(); });
        ro.observe(wrap);
        buildPoints(); syncControls();

        return {
          validate: () => true as const,
          // collecte SYNCHRONE des paramètres du warp ; le rééchantillonnage (lourd) se fait APRÈS la fermeture.
          collect: () => {
            const manualRaw = manualI.value;
            this.saveSettings({ sub, res: parseInt(resSel.value, 10) || 1600, arMode, arManual: manualRaw, sepCrop });
            let aspect = getAspect(manualRaw); if (!isFinite(aspect) || aspect <= 0) aspect = 1;
            const R = parseInt(resSel.value, 10) || 1600;
            let outW: number, outH: number;
            if (aspect >= 1) { outW = R; outH = Math.round(R / aspect); } else { outH = R; outW = Math.round(R * aspect); }
            outW = Math.max(2, outW); outH = Math.max(2, outH);
            const rectPts = points.map((p) => this.destFor(p, outW, outH));
            const imgPts = points.map((p) => [p.x, p.y] as [number, number]);
            return { outW, outH, res: R, sepCrop, hOutToSrc: Homography.solve(rectPts, imgPts) };
          },
        };
      },
    }).then((params: { outW: number; outH: number; res: number; sepCrop: boolean; hOutToSrc: number[] } | null) => {
      if (!params) return null;
      // WARP après fermeture de la modale, derrière l'indicateur (double rAF pour laisser peindre l'overlay).
      return new Promise<RawImage | null>((resolve) => {
        Notify.busy("Redressement…");
        requestAnimationFrame(() => requestAnimationFrame(() => {
          let src: RawImage;
          try {
            const off = document.createElement("canvas"); off.width = imgW; off.height = imgH;
            const octx = off.getContext("2d", { willReadFrequently: true })!;
            octx.drawImage(source, 0, 0);   // source COURANTE (rotation 90° éventuelle appliquée dans l'éditeur)
            const srcData = octx.getImageData(0, 0, imgW, imgH);
            src = { data: srcData.data, width: imgW, height: imgH };
          } catch (e) { Notify.idle(); Notify.toast("Redressement impossible (pixels inaccessibles).", "err"); resolve(null); return; }
          if (!params.sepCrop) {   // flux COMBINÉ (défaut) : le cadre de sortie = le quadrilatère posé
            const out = Homography.warpBilinear(src, params.hOutToSrc, params.outW, params.outH);
            Notify.idle(); resolve(out); return;
          }
          this.sepCropFlow(src, params, faceRatio).then(resolve);   // recadrage SÉPARÉ (gère lui-même busy/idle)
        }));
      });
    });
  }

  /** RECADRAGE SÉPARÉ : projette l'image source ENTIÈRE dans l'espace redressé (aperçu à résolution
      bornée), laisse choisir l'emprise utile (CropEditor), puis RE-WARPE le seul cadre choisi
      DIRECTEMENT depuis la source à pleine résolution (`res` = côté le plus long du cadre) — un seul
      rééchantillonnage source → final, pas de perte aperçu → crop. Appelé sous Notify.busy. */
  private static sepCropFlow(src: RawImage, p: { outW: number; outH: number; res: number; hOutToSrc: number[] }, faceRatio: number | null): Promise<RawImage | null> {
    const H = p.hOutToSrc, maxDim = Math.max(p.outW, p.outH);
    // emprise de la source dans l'espace redressé (coins via H⁻¹) — BORNÉE autour de la référence :
    // près de la ligne de fuite, un coin part vers l'infini (perspective forte) → clamp à ±4× la référence.
    let x0 = 0, y0 = 0, x1 = p.outW, y1 = p.outH;
    const Hi = Homography.invert(H);
    if (Hi) ([[0, 0], [src.width, 0], [src.width, src.height], [0, src.height]] as Array<[number, number]>).forEach(([sx, sy]) => {
      const [rx, ry] = Homography.apply(Hi, sx, sy);
      if (isFinite(rx) && isFinite(ry)) { x0 = Math.min(x0, rx); y0 = Math.min(y0, ry); x1 = Math.max(x1, rx); y1 = Math.max(y1, ry); }
    });
    x0 = Math.max(x0, p.outW / 2 - 4 * maxDim); y0 = Math.max(y0, p.outH / 2 - 4 * maxDim);
    x1 = Math.min(x1, p.outW / 2 + 4 * maxDim); y1 = Math.min(y1, p.outH / 2 + 4 * maxDim);
    // aperçu à résolution BORNÉE (l'interaction n'a pas besoin de la pleine résolution — le rendu final si)
    const s = Math.min(1, 2048 / Math.max(x1 - x0, y1 - y0));
    const pw = Math.max(2, Math.round((x1 - x0) * s)), ph = Math.max(2, Math.round((y1 - y0) * s));
    const preview = Homography.warpBilinear(src, this.composeH(H, x0, y0, 1 / s), pw, ph);
    Notify.idle();
    return CropEditor.open(preview, {
      initRect: { x: -x0 * s, y: -y0 * s, w: p.outW * s, h: p.outH * s },   // cadre initial = la référence
      targetRatio: faceRatio,
      info: (r) => {   // dims FINALES (res sur le côté long du cadre) + ratio vs cible façade
        const cw = r.w / s, ch = r.h / s, f = p.res / Math.max(cw, ch);
        return "Sortie : " + Math.max(2, Math.round(cw * f)) + " × " + Math.max(2, Math.round(ch * f)) + " px · Ratio l/h : " + (cw / ch).toFixed(2)
          + (faceRatio ? " (cible façade : " + faceRatio.toFixed(2) + ")" : "");
      },
    }).then((r) => {
      if (!r) return null;
      return new Promise<RawImage | null>((resolve) => {
        Notify.busy("Recadrage…");
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try {
            const cx = x0 + r.x / s, cy = y0 + r.y / s, cw = r.w / s, ch = r.h / s;
            const f = p.res / Math.max(cw, ch);
            const out = Homography.warpBilinear(src, this.composeH(H, cx, cy, 1 / f), Math.max(2, Math.round(cw * f)), Math.max(2, Math.round(ch * f)));
            Notify.idle(); resolve(out);
          } catch (e) { Notify.idle(); Notify.toast("Recadrage impossible.", "err"); resolve(null); }
        }));
      });
    });
  }

  /** H ∘ (translation(ox,oy) · échelle(k)) : pixel de sortie (x,y) → coord. redressée (ox+k·x, oy+k·y) → source. */
  private static composeH(h: number[], ox: number, oy: number, k: number): number[] {
    return [h[0] * k, h[1] * k, h[0] * ox + h[1] * oy + h[2], h[3] * k, h[4] * k, h[3] * ox + h[4] * oy + h[5], h[6] * k, h[7] * k, h[6] * ox + h[7] * oy + h[8]];
  }
}
