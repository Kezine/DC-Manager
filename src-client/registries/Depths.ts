import { MOUNT_DEPTHS, DEPTH_FRAC } from "../domain/constants";
import { Labeler } from "../core/Labeler";

const labeler = Labeler.make(MOUNT_DEPTHS, (d) => (d === "none" ? "No-depth" : d));

/** Profondeurs de montage en rack (full/half/quarter + pseudo « none »). */
export class Depths {
  static readonly ALL = MOUNT_DEPTHS;

  /** Libellé d'une profondeur enum (« none » → « No-depth » ; inconnu → l'id). */
  static label(d: string): string { return labeler(d); }

  /** Part de la profondeur de cage occupée (défaut 1). */
  static frac(d: string): number { return DEPTH_FRAC[d] != null ? DEPTH_FRAC[d] : 1; }

  /** Profondeur d'occupation (mm) d'un montage : depth_mm borné à la cage, sinon
      fraction de la cage selon l'enum legacy. */
  static mountSpanMm(m: any, cageMm: number): number {
    if (m && m.depth_mm != null) return Math.min(Math.max(1, m.depth_mm | 0), cageMm);
    return Depths.frac(m ? m.depth : "full") * cageMm;
  }

  /** Libellé de profondeur d'un montage : « 600 mm » si depth_mm, sinon enum legacy. */
  static mountLabel(m: any): string {
    return (m && m.depth_mm != null) ? (m.depth_mm + " mm") : Depths.label(m ? m.depth : "full");
  }

  /** MIGRATION : profondeur mm équivalente d'un enum legacy sur une cage de référence
      (full = cage entière, half = 50 %, quarter = 25 %) — cf. Store._migrateDepths. */
  static legacyToMm(depthEnum: string, cageMm: number): number {
    return Math.max(1, Math.round(Depths.frac(depthEnum) * Math.max(1, cageMm)));
  }
}
