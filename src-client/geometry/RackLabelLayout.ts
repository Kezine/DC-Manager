/* =============================================================================
   DISPOSITION des NOMS DE BAIE posés à plat sur la COQUE (flancs ±X + toit +Z) —
   géométrie PURE (sans THREE, sans DOM, ni store → testable en isolation, cf.
   principe n°2). La scène (`DcThreeScene`) consomme ces DONNÉES BRUTES et applique
   THREE (Mesh + matériau translucide partagé). Repère LOCAL du groupe de baie :
   X = largeur (w), Y = profondeur (d), Z = hauteur (H) ; front = −Y ; haut = +Z.

   POURQUOI un module dédié : la logique de POSITION/ROTATION par face est réutilisable
   et se teste numériquement en Node, alors que la construction du mesh dépend de WebGL.
   On sépare donc le CALCUL (ici) du RENDU (DcThreeScene).

   ROTATIONS — rotations PROPRES uniquement (déterminant +1), JAMAIS de miroir : le plan
   de texte (PlaneGeometry) a, avant rotation, sa face avant (le texte) en +Z, son « haut »
   en +Y et sa « droite » en +X. On amène ce trièdre sur la face visée en gardant le haut
   du texte vers le HAUT de la baie (+Z pour les flancs) et sans inverser l'écriture :
     • flanc DROIT (+X) : rotation de 2π/3 autour de (1,1,1) → +Z→+X (normale sortante),
       +Y→+Z (haut du texte vers le haut), +X→+Y. Lisible depuis +X.
     • flanc GAUCHE (−X) : rotation de 2π/3 autour de (1,−1,−1) → +Z→−X, +Y→+Z, +X→−Y.
       Lisible depuis −X, haut du texte toujours vers +Z.
     • TOIT (+Z) : rotation de π autour de la normale (0,0,1) → texte lu du dessus, haut du
       texte vers le front (−Y). Comme c'est une rotation autour de la normale, le texte
       reste NON miroir.
   L'axe est renvoyé BRUT (non normalisé) : le consommateur le normalise (three le fait via
   `Vector3.normalize()`) — l'angle est indépendant de la norme de l'axe.

   STANDOFF : la position est le CENTRE de la face décalé de `standoffMm` vers l'EXTÉRIEUR
   le long de la normale sortante (mm monde) → 1 mm en saillie tue le z-fighting avec la
   paroi coplanaire (même convention que les labels d'équipement, cf. `DcThreeBase`).

   TAILLES : bandes de texte CENTRÉES (défauts VISUELS ajustables) — largeur ≈ 80 % de la
   dimension portante (profondeur pour les flancs, largeur pour le toit), hauteur ≈ 22 % de
   cette largeur, la hauteur des flancs étant en outre bornée à 90 % de H (baie basse).
   ============================================================================= */

/** Face de la coque portant un nom de baie. */
export type RackLabelFace = "left" | "right" | "roof";

/** Vecteur 3D brut (données pures, pas de THREE). */
export interface RackLabelVec3 { x: number; y: number; z: number }

/** Placement calculé d'un nom de baie sur une face : centre décalé (position), rotation axe-angle
    (axis BRUT + angle rad) et taille du plan de texte (w × h, en mm). */
export interface RackLabelPlacement {
  position: RackLabelVec3;
  axis: RackLabelVec3;
  angle: number;
  size: { w: number; h: number };
}

export class RackLabelLayout {
  /** Fraction de la dimension portante occupée par la bande de texte (largeur). */
  private static readonly SPAN_FRAC = 0.8;
  /** Ratio hauteur/largeur de la bande de texte (bande basse et large). */
  private static readonly HEIGHT_RATIO = 0.22;
  /** Fraction MAX de la hauteur de baie pour la bande des flancs (évite le débordement sur une baie basse). */
  private static readonly SIDE_HEIGHT_CAP_FRAC = 0.9;
  private static readonly TWO_THIRDS_PI = (2 * Math.PI) / 3;

  /** Position/rotation/taille du nom de baie sur `face`, pour des dims (w, d, H) et une saillie `standoffMm`.
      Toutes les grandeurs sont en unités monde (mm) ; les données sont pures (aucun THREE). */
  static forFace(face: RackLabelFace, w: number, d: number, H: number, standoffMm: number): RackLabelPlacement {
    if (face === "left") {
      const sw = d * RackLabelLayout.SPAN_FRAC;
      return {
        position: { x: -w / 2 - standoffMm, y: 0, z: H / 2 },   // centre du flanc gauche, décalé en −X (normale sortante)
        axis: { x: 1, y: -1, z: -1 },                            // +Z→−X, +Y→+Z, +X→−Y (rotation propre, non miroir)
        angle: RackLabelLayout.TWO_THIRDS_PI,
        size: { w: sw, h: Math.min(H * RackLabelLayout.SIDE_HEIGHT_CAP_FRAC, sw * RackLabelLayout.HEIGHT_RATIO) },
      };
    }
    if (face === "right") {
      const sw = d * RackLabelLayout.SPAN_FRAC;
      return {
        position: { x: w / 2 + standoffMm, y: 0, z: H / 2 },    // centre du flanc droit, décalé en +X (normale sortante)
        axis: { x: 1, y: 1, z: 1 },                              // +Z→+X, +Y→+Z, +X→+Y (rotation propre, non miroir)
        angle: RackLabelLayout.TWO_THIRDS_PI,
        size: { w: sw, h: Math.min(H * RackLabelLayout.SIDE_HEIGHT_CAP_FRAC, sw * RackLabelLayout.HEIGHT_RATIO) },
      };
    }
    // roof : centre du toit, décalé en +Z (normale sortante) ; rotation autour de la normale (lecture du dessus).
    const sw = w * RackLabelLayout.SPAN_FRAC;
    return {
      position: { x: 0, y: 0, z: H + standoffMm },
      axis: { x: 0, y: 0, z: 1 },
      angle: Math.PI,
      size: { w: sw, h: sw * RackLabelLayout.HEIGHT_RATIO },
    };
  }
}
