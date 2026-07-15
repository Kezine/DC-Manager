/** Composantes RVB 0–255. */
export interface Rgb { r: number; g: number; b: number; }

/** Helpers couleur (hex ↔ rgb, contraste, style de pastille). */
export class Color {
  /** Chaîne CSS (« #rgb » / « #rrggbb » / « rgb(a)(r,g,b…) ») → entier hex 0xRRGGBB, ou NaN si non reconnue.
      Pur (aucun DOM) → utilisé par le moteur 3D (couleurs Three.js) et testable en isolation. */
  static cssToHex(v: string): number {
    if (v.startsWith("#")) {
      let h = v.slice(1);
      if (h.length === 3) h = h.split("").map((c) => c + c).join("");
      if (h.length >= 6) return parseInt(h.slice(0, 6), 16);
      return NaN;
    }
    const m = v.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (m) return (parseInt(m[1]) << 16) | (parseInt(m[2]) << 8) | parseInt(m[3]);
    return NaN;
  }

  /** « #rrggbb » → {r,g,b}, ou null si invalide. */
  static hexToRgb(hex: string | null | undefined): Rgb | null {
    if (!hex) return null;
    const h = hex.replace("#", "");
    if (h.length !== 6) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }

  /** Couleur de texte lisible (#000 / #fff) sur un fond donné. */
  static contrastText(hex: string): string {
    const rgb = Color.hexToRgb(hex);
    if (!rgb) return "#fff";
    const L = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return L > 0.6 ? "#000" : "#fff";
  }

  /** Attribut style d'une pastille colorée (variables CSS), ou "" si pas de couleur. */
  static pillStyle(color: string | null | undefined): string {
    if (!color) return "";
    return `style="--pill-bg:${color};--pill-fg:${Color.contrastText(color)};--pill-border:${color};"`;
  }
}
