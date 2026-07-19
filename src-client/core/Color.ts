/** Composantes RVB 0–255. */
export interface Rgb { r: number; g: number; b: number; }

/** Helpers couleur (hex ↔ rgb, contraste, style de pastille). */
export class Color {
  /** Chaîne CSS (« #rgb » / « #rrggbb » / « rgb(a)(r,g,b…) » / « oklch(L C H) ») → entier hex 0xRRGGBB,
      ou NaN si non reconnue. Pur (aucun DOM) → utilisé par le moteur 3D (couleurs Three.js) et testable
      en isolation. Le support oklch est OBLIGATOIRE : les tokens du thème (--accent, sémantiques, rôles)
      sont exprimés en OKLCH depuis la revue design — sans conversion, readTheme() tombait sur ses replis
      (face avant BLEUE 0x4ea1ff dans la vue Datacenter : accent/placement/waypoints faussés). */
  static cssToHex(v: string): number {
    if (v.startsWith("#")) {
      let h = v.slice(1);
      if (h.length === 3) h = h.split("").map((c) => c + c).join("");
      if (h.length >= 6) return parseInt(h.slice(0, 6), 16);
      return NaN;
    }
    const m = v.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (m) return (parseInt(m[1]) << 16) | (parseInt(m[2]) << 8) | parseInt(m[3]);
    const ok = v.match(/oklch\(\s*([\d.]+)(%?)\s+([\d.]+)(%?)\s+([\d.]+)(?:deg)?\s*(?:\/[^)]*)?\)/i);
    if (ok) {
      const L = parseFloat(ok[1]) / (ok[2] ? 100 : 1);                 // luminosité : 0..1 (ou %)
      const C = parseFloat(ok[3]) * (ok[4] ? 0.4 / 100 : 1);          // chroma : 100 % ≡ 0.4 (spec CSS Color 4)
      const H = parseFloat(ok[5]) * Math.PI / 180;                    // teinte en radians
      return Color.oklabToHex(L, C * Math.cos(H), C * Math.sin(H));   // l'alpha éventuel est ignoré (hex opaque)
    }
    return NaN;
  }

  /** OKLab (L, a, b) → 0xRRGGBB. Conversion de référence (Björn Ottosson, reprise par CSS Color 4) :
      OKLab → LMS (racines cubiques) → sRGB linéaire (matrice) → gamma sRGB, composantes ÉCRÊTÉES à
      [0,1] (une couleur hors gamut — chroma élevé — se projette sur la couleur affichable la plus proche,
      comme le fait le navigateur). Pur, testé (blanc/noir/rouge de référence dans test-core-store). */
  private static oklabToHex(L: number, a: number, b: number): number {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    const toByte = (lin: number): number => {
      const c = Math.min(1, Math.max(0, lin));
      const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
      return Math.round(Math.min(1, Math.max(0, srgb)) * 255);
    };
    const r = toByte(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
    const g = toByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
    const bb = toByte(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
    return (r << 16) | (g << 8) | bb;
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
