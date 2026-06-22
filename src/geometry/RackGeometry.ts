import { RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, U_MM } from "../domain/constants";
import { Normalize } from "../core/Normalize";

/** Demi-extents au sol d'une baie. */
export interface HalfExtents { hx: number; hy: number; }

/** Géométrie de baie PURE (objets simples ; pas de store). */
export class RackGeometry {
  /** Demi-extents au sol selon l'orientation (90/270 permutent largeur/profondeur). */
  static halfExtents(rack: any): HalfExtents {
    const w = rack.width_mm || RACK_WIDTH_DEFAULT, d = rack.depth || RACK_DEPTH_DEFAULT;
    const o = Normalize.rackOrientation(rack.orientation);
    return (o === 90 || o === 270) ? { hx: d / 2, hy: w / 2 } : { hx: w / 2, hy: d / 2 };
  }

  /** Marge latérale (mm) entre les rails 19″ et la paroi (gauche = droite). */
  static sideMarginMm(rack: any): number {
    return Math.max(0, ((rack.width_mm || RACK_WIDTH_DEFAULT) - RACK_MOUNT_WIDTH) / 2);
  }

  /** Nombre de colonnes de side-mount (2 si la marge dépasse 2U, sinon 1). */
  static sideColumns(rack: any): number {
    return RackGeometry.sideMarginMm(rack) > 2 * U_MM ? 2 : 1;
  }

  /** Le side-mount est-il possible sur cette face ? (marge ≥ 1U + flag autorisé). */
  static sideEnabled(rack: any, face: string): boolean {
    return RackGeometry.sideMarginMm(rack) >= U_MM &&
      (face === "rear" ? rack.allow_side_rear === true : rack.allow_side_front === true);
  }
}
