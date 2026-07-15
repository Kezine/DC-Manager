/* =============================================================================
   LEADER LAYOUT — disposition d'ÉTIQUETTES DÉPORTÉES reliées à un point d'ancrage
   (pastille de port sur une façade), par une répulsion force-directed SIMPLIFIÉE
   (même principe que GraphGeometry.simulateComponent : répulsion 1/d + rappel doux).

   But : placer chaque étiquette près de son port SANS qu'aucune étiquette ne
   recouvre un port ni une autre étiquette. Pure (aucun DOM) → testable.

   Repère : tout est en FRACTIONS du cadre [0,1]² (x = largeur, y = hauteur). Les
   distances sont pondérées par l'ASPECT du cadre (une façade large est très étirée
   horizontalement) : on raisonne en « pixels » x·aspect / y·1 pour que la répulsion
   ne pousse pas les étiquettes de façon disproportionnée en vertical.
   ============================================================================= */

/** Ancre + gabarit d'étiquette (tout en fractions du cadre [0,1]). */
export interface LeaderAnchor {
  /** Position du PORT (pastille) — centre, fraction [0,1]. */
  x: number;
  y: number;
  /** Largeur / hauteur de l'ÉTIQUETTE (fraction du cadre). */
  w: number;
  h: number;
}

export interface LeaderOptions {
  /** Aspect largeur/hauteur du cadre (pour raisonner en « pixels »). Défaut 1. */
  aspect?: number;
  /** Nombre d'itérations de relaxation. Défaut 140. */
  iterations?: number;
  /** Marge intérieure minimale au bord du cadre (fraction). Défaut 0.004. */
  pad?: number;
  /** Espacement minimal entre rectangles, en « pixels » (y ∈ [0,1], x ∈ [0,aspect]). Défaut 0.012. */
  gap?: number;
}

/** Position calculée du CENTRE de chaque étiquette (fraction [0,1]). */
export interface LeaderPlacement { x: number; y: number; }

export class LeaderLayout {
  /** Calcule la position des étiquettes. `anchors[i]` ↔ `résultat[i]`. Déterministe (pas d'aléatoire).

      Séparation de RECTANGLES (AABB) : on raisonne sur l'emprise réelle de chaque étiquette (demi-largeur ×
      demi-hauteur + jeu), pas sur des points — deux étiquettes ne peuvent donc plus se chevaucher. À chaque
      itération : rappel doux vers le port + résolution de PÉNÉTRATION (déplacement le long de l'axe de moindre
      recouvrement) étiquette↔étiquette ET étiquette↔ports (aucune étiquette sur une pastille). */
  static layout(anchors: LeaderAnchor[], opts: LeaderOptions = {}): LeaderPlacement[] {
    const n = anchors.length;
    if (n === 0) return [];
    const aspect = (opts.aspect && opts.aspect > 0) ? opts.aspect : 1;
    const iters = opts.iterations && opts.iterations > 0 ? opts.iterations : 140;
    const pad = opts.pad != null ? opts.pad : 0.004;
    const gap = opts.gap != null ? opts.gap : 0.012;   // jeu minimal entre rectangles, en « pixels »
    const sx = aspect, sy = 1;   // fraction → « pixels » : x pondéré par l'aspect, y inchangé

    // demi-tailles en « pixels » (constantes) : x mis à l'échelle de l'aspect, y non.
    const hw = anchors.map((a) => (a.w * sx) * 0.5), hh = anchors.map((a) => (a.h * sy) * 0.5);
    const ax = anchors.map((a) => a.x * sx), ay = anchors.map((a) => a.y * sy);   // ancres en pixels

    // INIT (pixels) : étiquette vers la marge verticale la plus proche (port en haut → au-dessus, sinon en dessous),
    // mais on ALTERNE le côté un index sur deux → deux ancres coïncidentes partent de part et d'autre du port (sinon
    // elles restent coincées du même côté). + léger décalage horizontal DÉTERMINISTE (nombre d'or) contre la symétrie.
    const lx = new Array<number>(n), ly = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const jitter = (((i + 1) * 0.61803398875) % 1 - 0.5) * 0.012 * sx;
      lx[i] = ax[i] + jitter;
      const up = anchors[i].y < 0.5, goUp = (i % 2 === 1) ? !up : up;
      ly[i] = goUp ? (ay[i] - hh[i] - 0.03) : (ay[i] + hh[i] + 0.03);
    }
    const clampAll = () => {
      for (let i = 0; i < n; i++) {
        lx[i] = Math.max((pad) * sx + hw[i], Math.min((1 - pad) * sx - hw[i], lx[i]));
        ly[i] = Math.max(pad + hh[i], Math.min(1 - pad - hh[i], ly[i]));
      }
    };
    clampAll();

    for (let it = 0; it < iters; it++) {
      // 1) rappel doux vers le port (garde le leader court, empêche la dérive).
      for (let i = 0; i < n; i++) { lx[i] += (ax[i] - lx[i]) * 0.06; ly[i] += (ay[i] - ly[i]) * 0.06; }
      // 2) séparation AABB étiquette ↔ étiquette (résolution de pénétration, symétrique).
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const dx = lx[i] - lx[j], dy = ly[i] - ly[j];
        const ox = (hw[i] + hw[j] + gap) - Math.abs(dx);   // pénétration horizontale
        const oy = (hh[i] + hh[j] + gap) - Math.abs(dy);   // pénétration verticale
        if (ox > 0 && oy > 0) {
          if (ox <= oy) { const p = (dx >= 0 ? 1 : -1) * ox * 0.5; lx[i] += p; lx[j] -= p; }
          else { const p = (dy >= 0 ? 1 : -1) * oy * 0.5; ly[i] += p; ly[j] -= p; }
        }
      }
      // 3) l'étiquette ne doit recouvrir AUCUN port (pastille) : si un ancre tombe dans le rect, on pousse l'étiquette.
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const dx = lx[i] - ax[j], dy = ly[i] - ay[j];
        const ox = (hw[i] + gap) - Math.abs(dx), oy = (hh[i] + gap) - Math.abs(dy);
        if (ox > 0 && oy > 0) {
          if (ox <= oy) lx[i] += (dx >= 0 ? 1 : -1) * ox;
          else ly[i] += (dy >= 0 ? 1 : -1) * oy;
        }
      }
      clampAll();
    }

    const out: LeaderPlacement[] = [];
    for (let i = 0; i < n; i++) out.push({ x: lx[i] / sx, y: ly[i] / sy });   // retour en fractions
    return out;
  }
}
