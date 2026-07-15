/* =============================================================================
   CropEditor — modale de RECADRAGE d'une image (aperçu + rectangle à poignées).
   Utilisée par le mode « recadrage séparé » du redressement de perspective
   (cf. docs/redressement-perspective.md) : les points de contrôle du dewarp
   posent la RÉFÉRENCE (n'importe quel rectangle réel bien net), l'emprise UTILE
   se choisit ensuite ici, dans l'image redressée (WYSIWYG — tout y est droit).

   Générique : reçoit un RawImage d'APERÇU + un rect initial (px d'aperçu), rend
   le rect choisi (px d'aperçu) — l'appelant convertit vers ses unités et fait le
   rendu final (ex. re-warp à pleine résolution depuis la source). Le damier de
   fond révèle les zones transparentes (hors de la photo source).

   Interactions : poignées (4 coins + 4 bords) = redimensionner · intérieur =
   déplacer · extérieur / clic droit = déplacer la vue · molette = zoom ·
   flèches = déplacer le rect (Maj = ×10) · « Caler au ratio cible » si fourni.
   ============================================================================= */
import { Dialog } from "./Dialog";
import { ImageBlob } from "./ImageBlob";
import type { RawImage } from "../geometry/Homography";

export interface CropRect { x: number; y: number; w: number; h: number; }
export interface CropOptions {
  initRect: CropRect;                        // rect initial (px d'aperçu) — typiquement la référence du dewarp
  targetRatio?: number | null;               // ratio l/h cible (façade) → bouton « Caler au ratio cible »
  info?: (r: CropRect) => string;            // ligne d'info recalculée à chaque changement (dims finales, ratio…)
}

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move" | "pan";
const HANDLE_PX = 7;      // demi-taille ÉCRAN d'une poignée (dessin + zone de prise)
const MIN_SIDE = 4;       // côté minimal du rect (px d'aperçu)

export class CropEditor {
  /** Ouvre le recadrage sur `preview` ; résout le rect choisi (px d'aperçu, arrondi/clampé) ou null. */
  static open(preview: RawImage, opts: CropOptions): Promise<CropRect | null> {
    const img = ImageBlob.toCanvas(preview);
    const PW = preview.width, PH = preview.height;
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    const clampRect = (r: CropRect): CropRect => {   // borné à l'aperçu, côtés ≥ MIN_SIDE
      const w = Math.max(MIN_SIDE, Math.min(PW, r.w)), h = Math.max(MIN_SIDE, Math.min(PH, r.h));
      return { x: Math.max(0, Math.min(PW - w, r.x)), y: Math.max(0, Math.min(PH - h, r.y)), w, h };
    };
    let rect = clampRect({ ...opts.initRect });
    const view = { scale: 1, tx: 0, ty: 0 };
    const targetRatio = (opts.targetRatio && isFinite(opts.targetRatio) && opts.targetRatio > 0) ? opts.targetRatio : null;

    return Dialog.custom({
      title: "Recadrer l'image redressée",
      message: "Choisissez l'emprise UTILE — l'image est déjà redressée, le cadre peut dépasser le rectangle de référence.",
      wide: true, confirmLabel: "Recadrer et utiliser", cancelLabel: "Annuler",
      build: (root: HTMLElement) => {
        const bar = document.createElement("div"); bar.className = "face-toolbar"; bar.style.flexWrap = "wrap";
        const mkBtn = (txt: string, title = "") => { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost btn-sm"; b.textContent = txt; if (title) b.title = title; return b; };
        const lab = (txt: string) => { const s = document.createElement("span"); s.style.cssText = "font-size:11px;color:var(--fg-dim);"; s.textContent = txt; return s; };
        const ratioBtn = mkBtn("Caler au ratio cible", "Ajuste la hauteur du cadre au ratio façade (centre conservé)");
        const resetBtn = mkBtn("Cadre initial", "Revenir au rectangle de référence du redressement");
        const allBtn = mkBtn("Tout", "Étendre le cadre à toute l'image redressée");
        const spacer = document.createElement("span"); spacer.style.flex = "1";
        const zoomOut = mkBtn("−", "Dézoomer"); const zoomLvl = lab("100 %"); zoomLvl.style.minWidth = "40px"; zoomLvl.style.textAlign = "center";
        const zoomIn = mkBtn("+", "Zoomer"); const zoomFit = mkBtn("Ajuster", "Ajuster l'image à l'écran");
        if (targetRatio) bar.append(ratioBtn);
        bar.append(resetBtn, allBtn, spacer, zoomOut, zoomLvl, zoomIn, zoomFit);

        const hint = document.createElement("div"); hint.className = "form-hint";
        hint.textContent = "Poignées = redimensionner · intérieur = déplacer le cadre · extérieur / clic droit = déplacer la vue · molette = zoom · flèches = déplacer (Maj = ×10). Le damier = hors de la photo (transparent).";
        const info = document.createElement("div"); info.className = "form-hint";

        const wrap = document.createElement("div");
        wrap.style.cssText = "position:relative;height:56vh;min-height:280px;border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-top:8px;"
          + "background:repeating-conic-gradient(var(--bg-3) 0% 25%, var(--bg) 0% 50%) 50% / 16px 16px;";   // damier → zones alpha 0 visibles
        const cv = document.createElement("canvas");
        cv.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none;";
        cv.tabIndex = 0;
        wrap.appendChild(cv);
        root.append(bar, hint, wrap, info);
        const ctx = cv.getContext("2d")!;

        const viewSize = () => ({ w: cv.width / DPR, h: cv.height / DPR });
        const toScreen = (x: number, y: number): [number, number] => [x * view.scale + view.tx, y * view.scale + view.ty];
        const toImg = (x: number, y: number): [number, number] => [(x - view.tx) / view.scale, (y - view.ty) / view.scale];
        const updateZoom = () => { zoomLvl.textContent = Math.round(view.scale * 100) + " %"; };
        const fit = () => {
          const { w, h } = viewSize(); const pad = 30;
          view.scale = Math.min((w - pad) / PW, (h - pad) / PH);
          view.tx = (w - PW * view.scale) / 2; view.ty = (h - PH * view.scale) / 2;
          updateZoom();
        };
        const zoomAt = (sx: number, sy: number, f: number) => {
          const [ix, iy] = toImg(sx, sy);
          view.scale = Math.max(0.02, Math.min(40, view.scale * f));
          view.tx = sx - ix * view.scale; view.ty = sy - iy * view.scale;
          updateZoom(); render();
        };

        /** Positions ÉCRAN des 8 poignées (coins + milieux de bords). */
        const handles = (): Array<{ id: Handle; x: number; y: number }> => {
          const [x0, y0] = toScreen(rect.x, rect.y), [x1, y1] = toScreen(rect.x + rect.w, rect.y + rect.h);
          const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
          return [
            { id: "nw", x: x0, y: y0 }, { id: "n", x: mx, y: y0 }, { id: "ne", x: x1, y: y0 },
            { id: "e", x: x1, y: my }, { id: "se", x: x1, y: y1 }, { id: "s", x: mx, y: y1 },
            { id: "sw", x: x0, y: y1 }, { id: "w", x: x0, y: my },
          ];
        };
        const CURSORS: Record<string, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", move: "move", pan: "grab" };
        const hitAt = (sx: number, sy: number): Handle => {
          for (const h of handles()) if (Math.abs(sx - h.x) <= HANDLE_PX + 3 && Math.abs(sy - h.y) <= HANDLE_PX + 3) return h.id;
          const [ix, iy] = toImg(sx, sy);
          if (ix >= rect.x && iy >= rect.y && ix <= rect.x + rect.w && iy <= rect.y + rect.h) return "move";
          return "pan";
        };

        const syncInfo = () => { if (opts.info) info.textContent = opts.info({ x: rect.x, y: rect.y, w: rect.w, h: rect.h }); };
        const render = () => {
          const { w, h } = viewSize();
          ctx.save(); ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, w, h);
          ctx.imageSmoothingEnabled = view.scale < 3;
          ctx.drawImage(img, view.tx, view.ty, PW * view.scale, PH * view.scale);
          // extérieur du cadre assombri
          const [x0, y0] = toScreen(rect.x, rect.y), [x1, y1] = toScreen(rect.x + rect.w, rect.y + rect.h);
          ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y1); ctx.lineTo(x0, y1); ctx.closePath();
          ctx.fillStyle = "rgba(8,9,11,.5)"; ctx.fill("evenodd");
          // cadre + poignées
          ctx.strokeStyle = "rgba(255,176,32,.95)"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
          ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]);
          handles().forEach((hd) => {
            ctx.fillStyle = "#ffb020"; ctx.strokeStyle = "#0e0f12"; ctx.lineWidth = 1.5;
            ctx.fillRect(hd.x - HANDLE_PX / 2, hd.y - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
            ctx.strokeRect(hd.x - HANDLE_PX / 2, hd.y - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
          });
          ctx.restore();
          syncInfo();
        };

        /* ---- interactions ---- */
        const evtPos = (e: PointerEvent | WheelEvent): [number, number] => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
        let drag: { mode: Handle; sx: number; sy: number; start: CropRect } | null = null;
        cv.addEventListener("contextmenu", (e) => e.preventDefault());
        cv.addEventListener("pointerdown", (e) => {
          cv.setPointerCapture(e.pointerId); cv.focus();
          const [sx, sy] = evtPos(e);
          const mode = e.button === 2 ? "pan" : hitAt(sx, sy);
          drag = { mode, sx, sy, start: { ...rect } };
          e.preventDefault();
        });
        cv.addEventListener("pointermove", (e) => {
          const [sx, sy] = evtPos(e);
          if (!drag) { cv.style.cursor = CURSORS[hitAt(sx, sy)] || "default"; return; }   // survol : curseur contextuel
          const mdx = (sx - drag.sx) / view.scale, mdy = (sy - drag.sy) / view.scale;   // Δ en px d'aperçu
          if (drag.mode === "pan") { view.tx += sx - drag.sx; view.ty += sy - drag.sy; drag.sx = sx; drag.sy = sy; render(); return; }
          const s = drag.start;
          if (drag.mode === "move") { rect = clampRect({ x: s.x + mdx, y: s.y + mdy, w: s.w, h: s.h }); render(); return; }
          // redimensionnement : bords concernés déplacés, côté opposé ANCRÉ ; normalisé + borné
          let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
          if (drag.mode.includes("w")) x0 += mdx; if (drag.mode.includes("e")) x1 += mdx;
          if (drag.mode.includes("n")) y0 += mdy; if (drag.mode.includes("s")) y1 += mdy;
          if (x1 < x0 + MIN_SIDE) { if (drag.mode.includes("w")) x0 = x1 - MIN_SIDE; else x1 = x0 + MIN_SIDE; }
          if (y1 < y0 + MIN_SIDE) { if (drag.mode.includes("n")) y0 = y1 - MIN_SIDE; else y1 = y0 + MIN_SIDE; }
          x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(PW, x1); y1 = Math.min(PH, y1);
          rect = { x: x0, y: y0, w: Math.max(MIN_SIDE, x1 - x0), h: Math.max(MIN_SIDE, y1 - y0) };
          render();
        });
        const endPtr = () => { drag = null; };
        cv.addEventListener("pointerup", endPtr); cv.addEventListener("pointercancel", endPtr);
        cv.addEventListener("wheel", (e) => { e.preventDefault(); const [sx, sy] = evtPos(e); zoomAt(sx, sy, Math.pow(1.0015, -e.deltaY)); }, { passive: false });
        cv.addEventListener("keydown", (e) => {
          const step = e.shiftKey ? 10 : 1; let mx = 0, my = 0;
          if (e.key === "ArrowLeft") mx = -step; else if (e.key === "ArrowRight") mx = step;
          else if (e.key === "ArrowUp") my = -step; else if (e.key === "ArrowDown") my = step; else return;
          e.preventDefault(); e.stopPropagation();
          rect = clampRect({ x: rect.x + mx, y: rect.y + my, w: rect.w, h: rect.h }); render();
        });

        ratioBtn.onclick = () => {   // hauteur ajustée au ratio cible, centre conservé (largeur réduite si déborde)
          if (!targetRatio) return;
          let w = rect.w, h = w / targetRatio;
          if (h > PH) { h = PH; w = h * targetRatio; }
          rect = clampRect({ x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h });
          render();
        };
        resetBtn.onclick = () => { rect = clampRect({ ...opts.initRect }); render(); };
        allBtn.onclick = () => { rect = { x: 0, y: 0, w: PW, h: PH }; render(); };
        zoomIn.onclick = () => { const { w, h } = viewSize(); zoomAt(w / 2, h / 2, 1.25); };
        zoomOut.onclick = () => { const { w, h } = viewSize(); zoomAt(w / 2, h / 2, 0.8); };
        zoomFit.onclick = () => { fit(); render(); };

        const ro = new ResizeObserver(() => { const r = cv.getBoundingClientRect(); cv.width = Math.round(r.width * DPR); cv.height = Math.round(r.height * DPR); fit(); render(); });
        ro.observe(wrap);

        return {
          validate: () => (rect.w >= MIN_SIDE && rect.h >= MIN_SIDE) ? true as const : "Cadre trop petit.",
          collect: () => { const r = clampRect(rect); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }; },
        };
      },
    });
  }
}
