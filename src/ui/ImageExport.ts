import { Dialog } from "./Dialog";
import { Notify } from "./Notify";
import { FormControls } from "./FormControls";

export interface ExportOptions { format: "jpeg" | "svg"; scope: "view" | "all"; width: number; height: number; }

const STYLE_PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "color", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline", "display"];

/* Export d'IMAGE partagé (SVG fidèle / JPEG rasterisé). Copie les styles CALCULÉS
   du SVG vivant sur le clone → l'image = exactement l'écran. Remplace les fonctions
   libres downloadBlobObject / inlineComputedStyles / svgStrToJpeg / runImageExport /
   openImageExportDialog / exportFileBase. */
export class ImageExport {
  /** Base de nom de fichier assainie (minuscules, espaces→tirets). */
  static fileBase(name: string, fallback: string): string {
    return (name || fallback).trim().replace(/[^\p{L}\p{N}\-_ ]/gu, "").replace(/\s+/g, "-").toLowerCase() || fallback;
  }

  /** Télécharge un Blob déjà constitué. */
  static download(filename: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Inline les styles calculés de `srcRoot` sur `cloneRoot` (structures identiques). */
  static inlineComputedStyles(srcRoot: Element, cloneRoot: Element): void {
    const src = [srcRoot].concat([...srcRoot.querySelectorAll("*")]);
    const cln = [cloneRoot].concat([...cloneRoot.querySelectorAll("*")]);
    const n = Math.min(src.length, cln.length);
    for (let i = 0; i < n; i++) {
      const cs = getComputedStyle(src[i]); let st = "";
      STYLE_PROPS.forEach((p) => { const v = cs.getPropertyValue(p); if (v && v !== "auto" && v !== "normal") st += p + ":" + v + ";"; });
      if (st) cln[i].setAttribute("style", st + (cln[i].getAttribute("style") || ""));
    }
  }

  /** Rasterise une chaîne SVG (srcW×srcH) dans un JPEG outW×outH (contenu cadré). */
  static svgToJpeg(svgStr: string, srcW: number, srcH: number, outW: number, outH: number, bg: string, filename: string): void {
    const url = URL.createObjectURL(new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = outW; c.height = outH;
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = bg || "#111"; ctx.fillRect(0, 0, outW, outH);
      const s = Math.min(outW / srcW, outH / srcH), dw = srcW * s, dh = srcH * s;
      ctx.drawImage(img, (outW - dw) / 2, (outH - dh) / 2, dw, dh);
      URL.revokeObjectURL(url);
      c.toBlob((b) => { if (b) { ImageExport.download(filename, b); Notify.toast("Export JPEG généré (" + outW + "×" + outH + ")"); } else Notify.toast("Échec de l'export JPEG", "err"); }, "image/jpeg", 0.92);
    };
    img.onerror = () => { URL.revokeObjectURL(url); Notify.toast("Échec de l'export JPEG", "err"); };
    img.src = url;
  }

  /** SVG → téléchargement direct ; JPEG → rasterisation. `nameFn(ext)` produit le nom. */
  static run(opts: ExportOptions, svgStr: string, w: number, h: number, nameFn: (ext: string) => string): void {
    if (opts.format === "svg") { ImageExport.download(nameFn("svg"), new Blob([svgStr], { type: "image/svg+xml" })); Notify.toast("Export SVG généré"); return; }
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-2").trim() || "#111";
    ImageExport.svgToJpeg(svgStr, w, h, Math.max(16, opts.width | 0), Math.max(16, opts.height | 0), bg, nameFn("jpg"));
  }

  /** Dialogue d'export : format (JPEG/SVG), portée optionnelle, résolution JPEG. */
  static dialog(allowScope: boolean): Promise<ExportOptions | null> {
    return Dialog.custom({
      title: "Exporter", confirmLabel: "Exporter",
      build: (root) => {
        const fmt = FormControls.select([{ value: "jpeg", label: "JPEG (image)" }, { value: "svg", label: "SVG (vectoriel)" }], "jpeg");
        root.appendChild(FormControls.fieldRow("Format", fmt));
        let scope: HTMLSelectElement | null = null;
        if (allowScope) { scope = FormControls.select([{ value: "view", label: "Vue actuelle (ce qui est affiché)" }, { value: "all", label: "Tout le contenu" }], "view"); root.appendChild(FormControls.fieldRow("Portée", scope)); }
        const wI = FormControls.number(1920, { min: 16, step: 1 }), hI = FormControls.number(1080, { min: 16, step: 1 });
        const resRow = document.createElement("div"); resRow.className = "form-row";
        resRow.appendChild(FormControls.fieldRow("Largeur (px)", wI)); resRow.appendChild(FormControls.fieldRow("Hauteur (px)", hI));
        const resField = document.createElement("div"); resField.appendChild(resRow);
        const presets = document.createElement("div"); presets.className = "form-hint";
        ([["1920×1080", 1920, 1080], ["2560×1440", 2560, 1440], ["3840×2160 (4K)", 3840, 2160], ["1280×720", 1280, 720]] as [string, number, number][]).forEach(([lbl, w, h]) => {
          const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost btn-sm"; b.textContent = lbl; b.style.marginRight = "5px"; b.style.marginTop = "4px";
          b.onclick = () => { wI.value = String(w); hI.value = String(h); }; presets.appendChild(b);
        });
        resField.appendChild(presets); root.appendChild(resField);
        const syncFmt = () => { resField.style.display = (fmt.value === "jpeg") ? "" : "none"; };
        fmt.addEventListener("change", syncFmt); syncFmt();
        return {
          validate: () => { if (fmt.value === "jpeg") { const w = parseInt(wI.value, 10), h = parseInt(hI.value, 10); if (!(w > 0) || !(h > 0)) return "Résolution invalide."; if (w * h > 50e6) return "Résolution trop grande (max ~50 Mpx)."; } return true; },
          collect: () => ({ format: fmt.value, scope: scope ? scope.value : "view", width: parseInt(wI.value, 10) || 1920, height: parseInt(hI.value, 10) || 1080 }),
        };
      },
    });
  }
}
