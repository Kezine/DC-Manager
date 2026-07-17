/* =============================================================================
   StitchEditor — ASSEMBLAGE de deux photos de façade (modèle « redresser puis
   aligner », cf. docs/redressement-perspective.md). Enchaîne :
   1. pour CHAQUE photo : question « Redresser ? » → PerspectiveEditor.openRaw
      (sans préréglage de ratio : chaque cliché ne couvre qu'une PORTION du
      panneau) ou décodage tel quel — l'intermédiaire reste en RawImage (sans perte) ;
   2. écran d'ALIGNEMENT : A fixe, B glissable (pelure d'oignon / mode différence),
      échelle de B auto-normalisée sur la dimension partagée (hauteur côte à côte,
      largeur empilées — la façade est PLANE : après redressement il ne reste
      qu'une translation + échelle) + réglage fin ±10 %, affinage automatique
      (corrélation ±10 px, ImageStitch.refine) ;
   3. JONCTION à la validation : compensation de gain (auto-exposition) puis
      COUPE FRANCHE (défaut : la 1re photo prioritaire, la 2de croppée à la
      jonction — aucun mélange de pixels) ou FONDU linéaire (toggle, persisté),
      recadrage auto (union le long de l'axe, intersection en travers),
      encodage WebP q0.92 (repli PNG).
   La géométrie (resize, gain, fondu, crop, affinage) vit dans
   `geometry/ImageStitch` (pure, testée) ; ici uniquement l'interaction.
   ============================================================================= */
import { Dialog } from "./Dialog";
import { Notify } from "./Notify";
import { ImageBlob } from "./ImageBlob";
import { PerspectiveEditor } from "./PerspectiveEditor";
import type { PerspectiveOptions } from "./PerspectiveEditor";
import { ImageStitch } from "../geometry/ImageStitch";
import type { StitchAxis } from "../geometry/ImageStitch";
import type { RawImage } from "../geometry/Homography";
import { I18n } from "../i18n/I18n";

const STITCH_SETTINGS_KEY = "dcmanager.stitch";

export class StitchEditor {
  /* ---- réglage persisté (par navigateur) : mode de jonction ---- */
  private static loadSeam(): "cut" | "feather" {
    try { const p = JSON.parse(window.localStorage.getItem(STITCH_SETTINGS_KEY) || "{}"); if (p && p.seam === "feather") return "feather"; } catch (_) { /* défaut */ }
    return "cut";
  }
  private static saveSeam(seam: "cut" | "feather"): void {
    try { window.localStorage.setItem(STITCH_SETTINGS_KEY, JSON.stringify({ seam })); } catch (_) { /* quota → ignoré */ }
  }
  /** Assemble `fileA` (référence, gauche/haut) et `fileB` ; résout le Blob fusionné ou null (annulé).
      `opts.faceRatio` ne sert ici qu'à l'INDICATION du ratio cible (le recadrage est automatique).
      Ne REJETTE jamais : une erreur interne est notifiée (toast) au lieu d'un flux suspendu en silence
      (les handlers async des appelants n'attrapent pas les réjections). */
  static open(fileA: Blob, fileB: Blob, opts: PerspectiveOptions = {}): Promise<Blob | null> {
    return this.run(fileA, fileB, opts).catch((e) => {
      console.error("StitchEditor", e);
      Notify.toast(I18n.t("ui.stitch.error"), "err");
      return null;
    });
  }

  private static async run(fileA: Blob, fileB: Blob, opts: PerspectiveOptions): Promise<Blob | null> {
    const rawA = await this.prepare(fileA, I18n.t("ui.stitch.photo1"));
    if (!rawA) return null;
    const rawB = await this.prepare(fileB, I18n.t("ui.stitch.photo2"));
    if (!rawB) return null;
    const merged = await this.align(rawA, rawB, opts);
    return merged ? ImageBlob.fromRaw(merged) : null;
  }

  /** Étape par photo : proposer le redressement (recommandé — photos de biais), sinon décodage brut. */
  private static async prepare(file: Blob, label: string): Promise<RawImage | null> {
    const fix = await Dialog.confirm({
      title: I18n.t("ui.stitch.straightenTitle", { photo: label }),
      message: I18n.t("ui.stitch.straightenMessage"),
      confirmLabel: I18n.t("ui.stitch.straightenConfirm"), cancelLabel: I18n.t("ui.stitch.straightenCancel"),
    });
    if (fix) return PerspectiveEditor.openRaw(file, {});   // PAS de ratio façade : le cliché ne couvre qu'une portion
    const raw = await ImageBlob.toRaw(file);
    if (!raw) Notify.toast(I18n.t("ui.stitch.decodeError"), "err");
    return raw;
  }

  /** Écran d'alignement : A fixe, B glissable ; résout le composite fusionné/recadré (RawImage) ou null. */
  private static align(A: RawImage, B: RawImage, opts: PerspectiveOptions): Promise<RawImage | null> {
    const cvA = ImageBlob.toCanvas(A), cvB = ImageBlob.toCanvas(B);
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    let axis: StitchAxis = "h", fine = 1, dx = 0, dy = 0;
    let mode: "onion" | "diff" = "onion";
    let seam: "cut" | "feather" = this.loadSeam();   // jonction : coupe franche (1re prioritaire) / fondu
    const view = { scale: 1, tx: 0, ty: 0 };
    const faceRatio = (opts.faceRatio && isFinite(opts.faceRatio) && opts.faceRatio > 0) ? opts.faceRatio : null;

    const baseScale = (): number => (axis === "h" ? A.height / B.height : A.width / B.width);   // normalise la dimension PARTAGÉE
    const effScale = (): number => baseScale() * fine;
    const sBw = (): number => Math.max(1, Math.round(B.width * effScale()));
    const sBh = (): number => Math.max(1, Math.round(B.height * effScale()));
    const resetPlacement = (): void => {   // départ : ~25 % de recouvrement le long de l'axe, aligné en travers
      if (axis === "h") { dx = A.width - Math.round(sBw() * 0.25); dy = 0; }
      else { dy = A.height - Math.round(sBh() * 0.25); dx = 0; }
    };
    // B REDIMENSIONNÉ (bilinéaire pur) — pour l'affinage et la fusion ; mémoïsé par échelle effective.
    let scaledCache: { key: number; img: RawImage } | null = null;
    const scaledB = (): RawImage => {
      const key = effScale();
      if (!scaledCache || Math.abs(scaledCache.key - key) > 1e-6) scaledCache = { key, img: ImageStitch.resizeBilinear(B, sBw(), sBh()) };
      return scaledCache.img;
    };

    return Dialog.custom({
      title: I18n.t("ui.stitch.title"),
      message: I18n.t("ui.stitch.message"),
      wide: true, confirmLabel: I18n.t("ui.stitch.confirm"), cancelLabel: I18n.t("ui.action.cancel"),
      build: (root: HTMLElement) => {
        const bar = document.createElement("div"); bar.className = "face-toolbar"; bar.style.flexWrap = "wrap";
        const mkBtn = (txt: string, title = "") => { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost btn-sm"; b.textContent = txt; if (title) b.title = title; return b; };
        const lab = (txt: string) => { const s = document.createElement("span"); s.style.cssText = "font-size:11px;color:var(--fg-dim);"; s.textContent = txt; return s; };
        const segH = mkBtn(I18n.t("ui.stitch.sideBySide"), I18n.t("ui.stitch.sideBySideTitle"));
        const segV = mkBtn(I18n.t("ui.stitch.stacked"), I18n.t("ui.stitch.stackedTitle"));
        const segOnion = mkBtn(I18n.t("ui.stitch.onion"), I18n.t("ui.stitch.onionTitle"));
        const segDiff = mkBtn(I18n.t("ui.stitch.diff"), I18n.t("ui.stitch.diffTitle"));
        const segCut = mkBtn(I18n.t("ui.stitch.cut"), I18n.t("ui.stitch.cutTitle"));
        const segFeather = mkBtn(I18n.t("ui.stitch.feather"), I18n.t("ui.stitch.featherTitle"));
        const fineI = document.createElement("input"); fineI.type = "range"; fineI.min = "0.90"; fineI.max = "1.10"; fineI.step = "0.002"; fineI.value = "1"; fineI.style.width = "110px";
        fineI.title = I18n.t("ui.stitch.fineTitle");
        const fineLab = lab("100 %"); fineLab.style.minWidth = "40px";
        const refineBtn = mkBtn(I18n.t("ui.stitch.refine"), I18n.t("ui.stitch.refineTitle"));
        const spacer = document.createElement("span"); spacer.style.flex = "1";
        const zoomOut = mkBtn("−", I18n.t("ui.zoom.out")); const zoomLvl = lab("100 %"); zoomLvl.style.minWidth = "40px"; zoomLvl.style.textAlign = "center";
        const zoomIn = mkBtn("+", I18n.t("ui.zoom.in")); const zoomFit = mkBtn(I18n.t("ui.zoom.fitLabel"), I18n.t("ui.stitch.fitTitle"));
        bar.append(segH, segV, lab("·"), segOnion, segDiff, lab(I18n.t("ui.stitch.junctionLabel")), segCut, segFeather, lab(I18n.t("ui.stitch.scale2Label")), fineI, fineLab, refineBtn, spacer, zoomOut, zoomLvl, zoomIn, zoomFit);

        const hint = document.createElement("div"); hint.className = "form-hint";
        hint.textContent = I18n.t("ui.stitch.hint");
        const info = document.createElement("div"); info.className = "form-hint";   // recouvrement · dimensions · ratio

        const wrap = document.createElement("div");
        wrap.style.cssText = "position:relative;height:56vh;min-height:280px;background:var(--bg);border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-top:8px;";
        const cv = document.createElement("canvas");
        cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:move;outline:none;";
        cv.tabIndex = 0;
        wrap.appendChild(cv);
        root.append(bar, hint, wrap, info);
        const ctx = cv.getContext("2d")!;

        const viewSize = () => ({ w: cv.width / DPR, h: cv.height / DPR });
        const unionBounds = () => ({ x0: Math.min(0, dx), y0: Math.min(0, dy), x1: Math.max(A.width, dx + sBw()), y1: Math.max(A.height, dy + sBh()) });
        const updateZoom = () => { zoomLvl.textContent = Math.round(view.scale * 100) + " %"; };
        const fit = () => {
          const { w, h } = viewSize(); const u = unionBounds(); const pad = 30;
          view.scale = Math.min((w - pad) / (u.x1 - u.x0), (h - pad) / (u.y1 - u.y0));
          view.tx = (w - (u.x1 - u.x0) * view.scale) / 2 - u.x0 * view.scale;
          view.ty = (h - (u.y1 - u.y0) * view.scale) / 2 - u.y0 * view.scale;
          updateZoom();
        };
        const zoomAt = (sx: number, sy: number, f: number) => {
          const ix = (sx - view.tx) / view.scale, iy = (sy - view.ty) / view.scale;
          view.scale = Math.max(0.02, Math.min(40, view.scale * f));
          view.tx = sx - ix * view.scale; view.ty = sy - iy * view.scale;
          updateZoom(); render();
        };

        const syncInfo = () => {
          const rdx = Math.round(dx), rdy = Math.round(dy);
          const ov = axis === "h" ? Math.min(A.width, rdx + sBw()) - Math.max(0, rdx) : Math.min(A.height, rdy + sBh()) - Math.max(0, rdy);
          const r = ImageStitch.autoCropRect(A, { width: sBw(), height: sBh() }, rdx, rdy, axis);
          const ratio = r.w / r.h;
          info.textContent = I18n.t("ui.stitch.info", { overlap: Math.max(0, ov), w: r.w, h: r.h, ratio: ratio.toFixed(2) })
            + (faceRatio ? I18n.t("ui.stitch.targetFace", { ratio: faceRatio.toFixed(2) }) : "");
        };
        const syncControls = () => {
          segH.className = "btn btn-sm " + (axis === "h" ? "btn-primary" : "btn-ghost");
          segV.className = "btn btn-sm " + (axis === "v" ? "btn-primary" : "btn-ghost");
          segOnion.className = "btn btn-sm " + (mode === "onion" ? "btn-primary" : "btn-ghost");
          segDiff.className = "btn btn-sm " + (mode === "diff" ? "btn-primary" : "btn-ghost");
          segCut.className = "btn btn-sm " + (seam === "cut" ? "btn-primary" : "btn-ghost");
          segFeather.className = "btn btn-sm " + (seam === "feather" ? "btn-primary" : "btn-ghost");
          fineLab.textContent = Math.round(fine * 100) + " %";
        };

        const render = () => {
          const { w, h } = viewSize();
          ctx.save(); ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, w, h);
          ctx.imageSmoothingEnabled = view.scale < 3;
          ctx.drawImage(cvA, view.tx, view.ty, A.width * view.scale, A.height * view.scale);
          const bx = view.tx + dx * view.scale, by = view.ty + dy * view.scale, bw = sBw() * view.scale, bh = sBh() * view.scale;
          if (mode === "diff") ctx.globalCompositeOperation = "difference";
          else ctx.globalAlpha = 0.5;
          ctx.drawImage(cvB, bx, by, bw, bh);
          ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
          ctx.strokeStyle = "rgba(255,176,32,.8)"; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2;
          ctx.strokeRect(bx, by, bw, bh); ctx.setLineDash([]);   // contour de B (repère de l'image glissable)
          ctx.restore();
          syncInfo();
        };

        /* ---- interactions ---- */
        let drag: { btn: number; x: number; y: number } | null = null;
        cv.addEventListener("contextmenu", (e) => e.preventDefault());   // clic droit = pan de la vue
        cv.addEventListener("pointerdown", (e) => {
          cv.setPointerCapture(e.pointerId); cv.focus();
          drag = { btn: e.button, x: e.clientX, y: e.clientY };
          e.preventDefault();
        });
        cv.addEventListener("pointermove", (e) => {
          if (!drag) return;
          const mx = e.clientX - drag.x, my = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
          if (drag.btn === 2) { view.tx += mx; view.ty += my; }        // droit : déplacer la VUE
          else { dx += mx / view.scale; dy += my / view.scale; }        // gauche : déplacer B
          render();
        });
        const endPtr = () => { drag = null; };
        cv.addEventListener("pointerup", endPtr); cv.addEventListener("pointercancel", endPtr);
        cv.addEventListener("wheel", (e) => { e.preventDefault(); const r = cv.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(1.0015, -e.deltaY)); }, { passive: false });
        cv.addEventListener("keydown", (e) => {
          const step = e.shiftKey ? 10 : 1; let mx = 0, my = 0;
          if (e.key === "ArrowLeft") mx = -step; else if (e.key === "ArrowRight") mx = step;
          else if (e.key === "ArrowUp") my = -step; else if (e.key === "ArrowDown") my = step; else return;
          e.preventDefault(); e.stopPropagation();
          dx += mx; dy += my; render();
        });

        segH.onclick = () => { if (axis !== "h") { axis = "h"; scaledCache = null; resetPlacement(); syncControls(); fit(); render(); } };
        segV.onclick = () => { if (axis !== "v") { axis = "v"; scaledCache = null; resetPlacement(); syncControls(); fit(); render(); } };
        segOnion.onclick = () => { mode = "onion"; syncControls(); render(); };
        segDiff.onclick = () => { mode = "diff"; syncControls(); render(); };
        segCut.onclick = () => { seam = "cut"; this.saveSeam(seam); syncControls(); };
        segFeather.onclick = () => { seam = "feather"; this.saveSeam(seam); syncControls(); };
        fineI.oninput = () => { fine = parseFloat(fineI.value) || 1; scaledCache = null; syncControls(); render(); };
        refineBtn.onclick = () => {
          Notify.busy(I18n.t("ui.stitch.busyRefine"));
          requestAnimationFrame(() => requestAnimationFrame(() => {
            try { const best = ImageStitch.refine(A, scaledB(), Math.round(dx), Math.round(dy), 10); dx = best.dx; dy = best.dy; render(); }
            finally { Notify.idle(); }
          }));
        };
        zoomIn.onclick = () => { const { w, h } = viewSize(); zoomAt(w / 2, h / 2, 1.25); };
        zoomOut.onclick = () => { const { w, h } = viewSize(); zoomAt(w / 2, h / 2, 0.8); };
        zoomFit.onclick = () => { fit(); render(); };

        const ro = new ResizeObserver(() => { const r = cv.getBoundingClientRect(); cv.width = Math.round(r.width * DPR); cv.height = Math.round(r.height * DPR); fit(); render(); });
        ro.observe(wrap);
        resetPlacement(); syncControls();

        return { validate: () => true as const, collect: () => ({ axis, dx: Math.round(dx), dy: Math.round(dy) }) };
      },
    }).then((placement: { axis: StitchAxis; dx: number; dy: number } | null) => {
      if (!placement) return null;
      // FUSION après fermeture, derrière l'indicateur (resize + gain + fondu + recadrage : centaines de ms).
      return new Promise<RawImage | null>((resolve) => {
        Notify.busy(I18n.t("ui.stitch.busyMerge"));
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try {
            const sb = scaledB();
            const gain = ImageStitch.gainForB(A, sb, placement.dx, placement.dy);
            const { img, ox, oy } = ImageStitch.blend(A, sb, placement.dx, placement.dy, placement.axis, gain, seam);
            const r = ImageStitch.autoCropRect(A, sb, placement.dx, placement.dy, placement.axis);
            Notify.idle(); resolve(ImageStitch.crop(img, r.x - ox, r.y - oy, r.w, r.h));
          } catch (e) { Notify.idle(); Notify.toast(I18n.t("ui.stitch.mergeError"), "err"); resolve(null); }
        }));
      });
    });
  }
}
