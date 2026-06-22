/** Composantes RVB 0–255. */
export interface Rgb { r: number; g: number; b: number; }

/** Helpers couleur (hex ↔ rgb, contraste, style de pastille). */
export class Color {
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
