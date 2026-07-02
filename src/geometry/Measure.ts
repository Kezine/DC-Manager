/* =============================================================================
   Géométrie PURE de MESURE : longueur d'un segment et total d'une polyligne, en 3D
   (composante z optionnelle → 0 si absente). Sans DOM, ni vue, ni store → testable en
   isolation. Cœur de calcul de l'outil de mesure (partagé par les overlays 2D et 3D et
   le panneau) ; première brique de l'extraction du futur `MeasureTool`.
   ============================================================================= */

/** Point de mesure (z optionnel — plan 2D = 0). */
export interface MeasurePt { x: number; y: number; z?: number }

export class Measure {
  /** Longueur euclidienne 3D d'un segment (z absent traité comme 0). NB : `dist`, pas `length` — ce dernier
      entrerait en conflit avec la propriété d'arité `Function.length` sur une méthode STATIQUE. */
  static dist(a: MeasurePt, b: MeasurePt): number {
    return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
  }
  /** Longueur TOTALE d'une polyligne = somme des segments consécutifs (0 si < 2 points). */
  static total(pts: MeasurePt[]): number {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += Measure.dist(pts[i - 1], pts[i]);
    return s;
  }
}
