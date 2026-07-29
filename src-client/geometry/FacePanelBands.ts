/* =============================================================================
   BANDES HORIZONTALES D'UNE FACE DE PANNEAU 19″ — géométrie PURE.

   Un équipement monté en U occupe un panneau de `RACK_MOUNT_WIDTH` de large, mais son
   BOÎTIER peut être plus étroit (`u_width_mm`) et décalé (`u_align`) : les oreilles de
   montage s'étendent alors des rails jusqu'aux bords du boîtier, ASYMÉTRIQUEMENT. Ce
   module rend, en FRACTIONS du panneau (0..1), la bande du boîtier et celles des oreilles.

   POURQUOI un module dédié (principes n°2/n°3) : ce découpage était écrit dans
   `FaceEditor` (`bodyLeftFrac` + `BODY_FRAC`) et ABSENT de l'aperçu de la fiche détail
   (`FormBase.facePreview`), qui dessinait donc tout équipement en pleine largeur 19″ —
   coque ET ports décalés dès que le boîtier est rétréci. Une seule règle, un seul endroit :
   les deux rendus se dérivent désormais du même calcul.

   ⚠ MIROIR ARRIÈRE : vu de derrière, la gauche et la droite s'échangent — le décalage
   d'alignement s'INVERSE. C'est la même convention que `DcThreeScene` / `Resolver3D`, et
   la raison pour laquelle la face fait partie de la SIGNATURE plutôt que d'être appliquée
   après coup par l'appelant (l'oublier était le piège d'origine).
   ============================================================================= */
import { RackGeometry } from "./RackGeometry";
import { RACK_MOUNT_WIDTH } from "../domain/constants";

/** Bande horizontale dans le panneau, en FRACTIONS de sa largeur (0..1). */
export interface FaceBand {
  /** Bord gauche, fraction du panneau. */
  left: number;
  /** Largeur, fraction du panneau. */
  width: number;
}

export class FacePanelBands {
  /** Largeur en dessous de laquelle une bande d'oreille n'est PAS matérialisée : à pleine largeur,
      les arrondis flottants laissent une bande résiduelle de l'ordre de 1e-16 qu'il serait absurde
      de dessiner. Seuil repris tel quel du rendu d'origine (`FaceEditor`). */
  static readonly MIN_EAR_FRAC = 0.0005;

  /** Bande occupée par le BOÎTIER dans le panneau 19″, VUE DE LA FACE `face`.
      ⚠ « Pleine largeur » ne veut PAS dire « tout le panneau » : c'est le CORPS UTILE
      (`RackGeometry.mountBodyWidth()` = panneau − 2 oreilles standard), donc une bande centrée
      d'environ 93,8 % — il reste TOUJOURS une oreille de chaque côté. */
  static body(equipment: any, face: string): FaceBand {
    const bodyWidth = RackGeometry.eqBodyWidth(equipment);
    const signedOffset = RackGeometry.eqBodyOffsetX(equipment);
    const offset = (face === "rear") ? -signedOffset : signedOffset;   // miroir horizontal vu de derrière
    return {
      left: (RACK_MOUNT_WIDTH / 2 + offset - bodyWidth / 2) / RACK_MOUNT_WIDTH,
      width: bodyWidth / RACK_MOUNT_WIDTH,
    };
  }

  /** Bandes des OREILLES de montage (0, 1 ou 2) : ce qui reste du panneau de part et d'autre du
      boîtier. Les bandes de largeur négligeable sont ÉCARTÉES (cf. `MIN_EAR_FRAC`). */
  static ears(equipment: any, face: string): FaceBand[] {
    const body = FacePanelBands.body(equipment, face);
    const candidates: FaceBand[] = [
      { left: 0, width: body.left },
      { left: body.left + body.width, width: 1 - (body.left + body.width) },
    ];
    return candidates.filter((band) => band.width > FacePanelBands.MIN_EAR_FRAC);
  }
}
