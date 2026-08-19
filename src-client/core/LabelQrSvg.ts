/* ============================================================================
   LABELQRSVG — retravail PUR du SVG de QR servi par `GET …/qr/:collection/:id`
   pour l'impression d'étiquettes (lot E). Documentation : docs/qr-scan.md
   § « Étiquettes imprimables ».

   Le serveur génère le SVG avec la lib `qrcode` : viewBox en MODULES
   (`0 0 T T` où T = modules + 2 × marge), fond blanc plein cadre, modules
   sombres en un seul <path>, et une QUIET ZONE de 4 modules DANS le SVG
   (marge par défaut de la lib). Ce module :

     1. VÉRIFIE la quiet zone — la marge se lit dans le viewBox et la première
        commande de tracé du chemin sombre (les modules commencent à x = marge).
        Si la marge servie est < 4 modules (lib reconfigurée un jour, autre
        générateur…), demander `?size=` plus grand n'y changerait RIEN (c'est
        une propriété en modules, pas en pixels) : on COMPENSE en agrandissant
        le viewBox et en repeignant un fond blanc plein cadre — padding blanc
        CALCULÉ, jamais un rognage du QR.
     2. MET À L'ÉCHELLE en millimètres : width/height = la cote voulue de
        l'étiquette (le mm du gabarit INCLUT la quiet zone, comme la maquette).

   Manipulation de CHAÎNE pure (aucun DOM — testable sous Node, et le résultat
   s'inline tel quel dans le document d'impression). Défensif : un SVG qui ne
   ressemble pas à la sortie attendue est rendu à l'échelle demandée SANS
   compensation (mieux vaut un QR imprimé qu'un refus — la quiet zone de la lib
   actuelle est correcte, ce chemin est un filet).
   ============================================================================ */

/** Quiet zone minimale (modules) exigée par la spec QR — cf. maquette (« 4 modules intouchables »). */
const QUIET_ZONE_MODULES = 4;

export class LabelQrSvg {
  /** Marge (modules) détectée dans un SVG de la lib `qrcode`, ou null si le SVG
      n'a pas la forme attendue. La marge est le plus petit X des commandes de
      déplacement du chemin SOMBRE (le fond blanc, lui, part de 0). */
  static detectMarginModules(svgText: string): number | null {
    // Chemin SOMBRE = celui qui porte un trait/remplissage non blanc. La lib émet
    // `<path fill="#ffffff" …/>` (fond) puis `<path stroke="#000000" d="M4 4.5h7…"/>`.
    const paths = String(svgText || "").match(/<path\b[^>]*>/g) || [];
    let best: number | null = null;
    for (const tag of paths) {
      if (/(?:fill|stroke)="#f/i.test(tag)) continue;   // fond blanc : ignoré
      const d = /\bd="([^"]*)"/.exec(tag);
      if (!d) continue;
      // Toutes les commandes de déplacement absolues « M x y » du tracé des modules.
      const moves = d[1].match(/M\s*(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)/g) || [];
      for (const mv of moves) {
        const m = /M\s*(-?\d+(?:\.\d+)?)/.exec(mv);
        if (!m) continue;
        const x = Math.floor(parseFloat(m[1]));
        if (best === null || x < best) best = x;
      }
    }
    return best;
  }

  /** viewBox `[minX, minY, w, h]` du SVG, ou null s'il est absent/malformé. */
  static parseViewBox(svgText: string): [number, number, number, number] | null {
    const m = /viewBox="([^"]*)"/.exec(String(svgText || ""));
    if (!m) return null;
    const parts = m[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    return [parts[0], parts[1], parts[2], parts[3]];
  }

  /** Prépare le SVG servi pour l'impression : quiet zone garantie (≥ 4 modules,
      compensée par un padding blanc calculé si besoin) puis mise à l'échelle en
      millimètres (`width`/`height` = `${mm}mm`). Rend le SVG retravaillé. */
  static scaleToMm(svgText: string, mm: number): string {
    let svg = String(svgText || "");
    const viewBox = LabelQrSvg.parseViewBox(svg);
    const margin = LabelQrSvg.detectMarginModules(svg);
    if (viewBox && margin !== null && margin < QUIET_ZONE_MODULES) {
      // COMPENSATION : élargit le viewBox du déficit de marge et repeint un fond
      // blanc plein cadre EN TÊTE (sous le contenu existant — le fond d'origine le
      // recouvre au centre, seul le pourtour ajouté compte).
      const pad = QUIET_ZONE_MODULES - margin;
      const [x, y, w, h] = viewBox;
      const nx = x - pad, ny = y - pad, nw = w + 2 * pad, nh = h + 2 * pad;
      svg = svg.replace(/viewBox="[^"]*"/, `viewBox="${nx} ${ny} ${nw} ${nh}"`);
      svg = svg.replace(/(<svg\b[^>]*>)/, `$1<rect x="${nx}" y="${ny}" width="${nw}" height="${nh}" fill="#ffffff"/>`);
    }
    // Mise à l'échelle : remplace (ou pose) width/height sur la balise racine. Les
    // attributs éventuels de la lib sont en pixels — on les écrase par la cote mm.
    const size = `${+mm.toFixed(2)}mm`;
    svg = svg.replace(/(<svg\b[^>]*?)\s+width="[^"]*"/, "$1");
    svg = svg.replace(/(<svg\b[^>]*?)\s+height="[^"]*"/, "$1");
    svg = svg.replace(/<svg\b/, `<svg width="${size}" height="${size}"`);
    return svg;
  }
}
