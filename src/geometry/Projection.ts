/** Point monde (mm) : X = largeur salle, Y = profondeur, Z = hauteur. */
export interface WorldPoint { x: number; y: number; z: number; }
/** Point projeté écran : h (horizontal), v (vertical, croît vers le bas), depth. */
export interface ScreenPoint { h: number; v: number; depth: number; }

/** Projections orthographiques pures (sans store ni DOM). */
export class Projection {
  /** Vue DESSUS : h = X, v = Y, depth = Z. */
  static project3D(p: WorldPoint): ScreenPoint {
    return { h: p.x, v: p.y, depth: p.z };
  }
}
