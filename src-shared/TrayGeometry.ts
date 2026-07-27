/* ============================================================================
   GÉOMÉTRIE DE L'ÉTAGÈRE (« tray ») — code PARTAGÉ front ⇄ back (TS pur).

   SOURCE UNIQUE de la géométrie du plateau et de ce qu'on y pose. Elle était
   écrite DEUX FOIS — `TrayFit` dans `src-shared/DataValidation.ts` (règles T2d /
   V6e) et les méthodes `tray*` de `src-client/geometry/RackGeometry.ts` (rendu 2D/3D,
   auto-placement, contrôle de saisie) — avec sept constantes redéclarées et un
   commentaire « parité à maintenir » des deux côtés. Cf. `docs/placement.md` §6.7.

   RÉPARTITION DES RÔLES (doctrine §6.1 : la responsabilité appartient au CONTENEUR) :
     - CE module porte la géométrie du plateau et le VERDICT de tenue (code + cotes) ;
     - chaque consommateur porte sa PRÉSENTATION (la validation rend un `path` + un
       message de formulaire, le front une phrase d'aide à la saisie) — deux produits
       différents, pas une duplication.

   REPÈRE : celui du PLATEAU. `x` = largeur depuis le bord UTILISABLE gauche (garde des
   renforts déduite), `y` = profondeur depuis la FACE DE MONTAGE de l'étagère, `z`
   implicite (au-dessus du plateau). Ce repère est indépendant de la face (avant/arrière)
   et de l'orientation de la baie : c'est ce qui rend le module utilisable par la
   validation, qui n'a aucun repère de baie sous la main.

   PROFONDEUR DE CAGE reçue en NOMBRE (`cageMm`), jamais l'enregistrement de baie : la
   géométrie du plateau n'a pas à connaître la POLITIQUE de profondeur d'une baie (marges,
   cavités de portes, bornage). Cette politique vit désormais dans `src-shared/RackDepthPolicy`
   — source UNIQUE dont `RackGeometry.cageDepth` et `RackDepth.cage` ne sont plus que des
   alias (cf. `docs/placement.md` §6.14). Conséquence directe pour ce module : la cage qu'on
   lui passe est BORNÉE à la profondeur extérieure, donc une longueur de plateau ne peut plus
   dépasser ce que la validation autorise. Recevoir un NOMBRE reste le bon découpage : c'est
   l'appelant qui décide de QUELLE cage il parle, pas la géométrie du plateau.

   Ce fichier n'importe rien, mais ce n'est plus une CONTRAINTE : depuis la levée de
   l'auto-suffisance de `src-shared/`, un import relatif entre fichiers partagés est autorisé
   (extension `.js` IMPÉRATIVE — NodeNext l'exige côté serveur). Si `DataValidation.ts` le
   REÇOIT toujours en collaborateur injecté au lieu de l'importer, c'est un choix de
   DÉCOUPLAGE assumé, plus une nécessité technique — cf. `CLAUDE.md`, section « Code partagé ».
   ============================================================================ */

/* ---- constantes PROPRES à l'étagère : ce module en est la SOURCE UNIQUE.
   `src-client/domain/constants.ts` les RÉ-EXPORTE (mêmes noms) pour que le front n'en
   connaisse qu'une écriture. ---- */
/** Longueur de plateau par défaut d'une étagère en porte-à-faux (mm). */
export const TRAY_DEPTH_DEFAULT_MM = 450;
/** Réserve de hauteur INUTILISABLE au ras du plateau (mm) : tôle + renforts transversaux. */
export const TRAY_SHEET_RESERVE_MM = 5;
/** Garde LATÉRALE (mm) de chaque côté réservée aux renforts (porte-à-faux) : les posés n'y empiètent pas. */
export const TRAY_GUSSET_CLEARANCE_MM = 4;

/* ---- constantes GÉNÉRALES de baie dont le plateau dépend : RÉPLIQUES assumées des
   constantes front (`src-client/domain/constants.ts`). Les unifier déborderait très
   largement du besoin de l'étagère (elles servent toute la géométrie de baie) — c'est
   un lot à part. Un test anti-divergence verrouille leur égalité, comme pour les enums
   de `DataValidation.ts`. ---- */
/** Hauteur d'un U (mm) = `U_MM` (front). */
export const TRAY_U_MM = 44.45;
/** Entraxe des rails 19″ (mm) = `RACK_MOUNT_WIDTH` (front). */
export const TRAY_MOUNT_WIDTH_MM = 482.6;
/** Largeur d'une oreille de montage, par côté (mm) = `RACK_EAR_MM` (front) : le plateau
    est le CORPS 19″, les oreilles s'accrochant aux rails. */
export const TRAY_EAR_MM = 15;
/** Réserve d'oreilles DEVANT la cage (mm) = `RACK_EAR_STANDOFF_MM` (front) : le plateau
    « dual » est posé de plan de façade à plan de façade, donc déborde de cette réserve
    à chaque extrémité. */
export const TRAY_EAR_STANDOFF_MM = 3;

/** Plateau utile : largeur UTILISABLE, longueur effective, hauteur libre au-dessus (mm). */
export interface TrayPlank {
  /** Largeur UTILISABLE de pose = corps 19″ moins la garde des renforts de chaque côté. */
  W: number;
  /** Longueur effective du plateau (de la face de montage vers le fond). */
  L: number;
  /** Hauteur LIBRE au-dessus du plateau = TOUTE la réservation `u_height` moins la réserve de tôle. */
  availH: number;
}

/** Empreinte au plateau d'un équipement posé (mm), orientation APPLIQUÉE. */
export interface TrayFootprint {
  w: number;
  d: number;
  h: number;
  /** `true` si l'orientation (90/270) a PERMUTÉ largeur et longueur — permet à l'appelant de
      désigner le bon champ de saisie (`free_w_mm` ⇄ `free_l_mm`) dans un message d'erreur. */
  rotated: boolean;
}

/** Rectangle au plateau (repère PLATEAU, cf. en-tête). */
export interface TrayRect { x0: number; x1: number; y0: number; y1: number; }

/** Nature du refus de pose. La PHRASE est à la charge de l'appelant (cf. en-tête). */
export type TrayFitCode =
  | "no_space"     // aucune hauteur libre au-dessus du plateau
  | "too_high"     // l'équipement est plus haut que la hauteur libre
  | "footprint"    // l'empreinte SEULE dépasse le plateau (indépendamment de la position)
  | "over_width"   // à sa position, l'équipement sort du plateau en LARGEUR
  | "over_depth";  // à sa position, l'équipement sort du plateau en PROFONDEUR

/** Refus de pose : le code + toutes les cotes que les messages des appelants citent. */
export interface TrayFitProblem {
  code: TrayFitCode;
  footprint: TrayFootprint;
  plank: TrayPlank;
  /** Cote ATTEINTE par l'équipement (hauteur, `x1` ou `y1` selon le code) ; 0 si sans objet. */
  reached: number;
  /** Position de l'équipement au plateau (`x0` ou `y0` selon le code) ; 0 si sans objet. */
  at: number;
}

/** Tolérance (mm) des comparaisons de cotes : absorbe les arrondis de saisie et le flottant, et
    laisse « pile à ras » passer. Identique des deux côtés depuis l'origine — conservée telle quelle. */
const TOLERANCE_MM = 0.5;

export class TrayGeometry {
  /* ---- plateau ---- */

  /** Garde latérale réservée aux renforts : seul le porte-à-faux en a (le « dual », posé de
      façade à façade, n'a pas de renforts latéraux). */
  static gussetInset(tray: Record<string, any>): number {
    return tray.tray_type === "cantilever" ? TRAY_GUSSET_CLEARANCE_MM : 0;
  }

  /** Largeur PLEINE du plateau (mm) = corps 19″ entre rails, renforts NON déduits. C'est la
      largeur DESSINÉE ; la largeur de POSE est `plank().W`. */
  static fullWidth(): number {
    return TRAY_MOUNT_WIDTH_MM - 2 * TRAY_EAR_MM;
  }

  /** Longueur EFFECTIVE du plateau (mm). En « dual » (posé avant + arrière), de PLAN DE FAÇADE à
      PLAN DE FAÇADE : la cage plus les deux réserves d'oreilles — le plateau déborde devant chaque
      rail comme la façade des équipements. En porte-à-faux : `depth_mm` (plancher 50 mm, borné à la cage). */
  static plankLength(cageMm: number, tray: Record<string, any>): number {
    if (tray.tray_type !== "cantilever") return cageMm + 2 * TRAY_EAR_STANDOFF_MM;
    return Math.min(Math.max(50, tray.depth_mm || TRAY_DEPTH_DEFAULT_MM), cageMm);
  }

  /** Plateau utile d'une étagère. `tray_u` (hauteur de la structure qui PORTE le plateau) est une pure
      indication de DESSIN : elle n'exclut rien — toute la réservation `u_height` est utilisable, moins
      la seule réserve de tôle. */
  static plank(cageMm: number, tray: Record<string, any>): TrayPlank {
    const heightU = Math.max(1, tray.u_height | 0);
    return {
      W: TrayGeometry.fullWidth() - 2 * TrayGeometry.gussetInset(tray),
      L: TrayGeometry.plankLength(cageMm, tray),
      availH: heightU * TRAY_U_MM - TRAY_SHEET_RESERVE_MM,
    };
  }

  /* ---- contenu posé ---- */

  /** Empreinte au plateau d'un équipement posé (mm) : une orientation de 90° ou 270° PERMUTE largeur et
      longueur. Défauts prudents pour des dimensions non renseignées (200 × 200 × 100).
      L'angle est TRONQUÉ à l'entier puis ramené dans [0, 360[ — c'est la sémantique du domaine
      (`Normalize.rackOrientation`, dont les valeurs autorisées sont 0/90/180/270 : tout autre angle
      retombe sur 0, donc jamais sur une permutation). */
  static footprint(eq: Record<string, any>): TrayFootprint {
    const freeW = Math.max(1, eq.free_w_mm || 200), freeL = Math.max(1, eq.free_l_mm || 200), freeH = Math.max(1, eq.free_h_mm || 100);
    const angle = (((eq.dc_orientation | 0) % 360) + 360) % 360;
    const rotated = (angle === 90 || angle === 270);
    return rotated ? { w: freeL, d: freeW, h: freeH, rotated } : { w: freeW, d: freeL, h: freeH, rotated };
  }

  /** Rectangle au plateau d'un équipement posé. Une position nulle (`tray_x`/`tray_y` absents) vaut
      CENTRÉ sur l'axe concerné — jamais collé à un bord. */
  static box(eq: Record<string, any>, plank: TrayPlank): TrayRect {
    const footprint = TrayGeometry.footprint(eq);
    const x0 = TrayGeometry.offset(eq.tray_x, plank.W, footprint.w);
    const y0 = TrayGeometry.offset(eq.tray_y, plank.L, footprint.d);
    return { x0, x1: x0 + footprint.w, y0, y1: y0 + footprint.d };
  }

  /** Deux posés se CHEVAUCHENT-ils ? Contact bord à bord toléré (`TOLERANCE_MM`). */
  static overlap(a: TrayRect, b: TrayRect): boolean {
    return a.x0 < b.x1 - TOLERANCE_MM && b.x0 < a.x1 - TOLERANCE_MM
        && a.y0 < b.y1 - TOLERANCE_MM && b.y0 < a.y1 - TOLERANCE_MM;
  }

  /** POURQUOI l'équipement ne tient PAS sur le plateau — `null` s'il tient. Le chevauchement avec les
      COLOCATAIRES n'entre pas ici : il dépend d'un ensemble de pairs que chaque appelant énumère à sa
      façon (le `find` de la validation, la liste `others` du front) → `overlap` s'y prête directement.
      Ordre des contrôles : du plus général (pas de place du tout) au plus fin (débord à la position). */
  static fitProblem(eq: Record<string, any>, plank: TrayPlank): TrayFitProblem | null {
    const footprint = TrayGeometry.footprint(eq);
    const base = { footprint, plank, reached: 0, at: 0 };
    if (plank.availH < 1) return { ...base, code: "no_space" };
    if (footprint.h > plank.availH + TOLERANCE_MM) return { ...base, code: "too_high", reached: footprint.h };
    // empreinte SEULE trop grande : le refus ne dépend alors pas de la position — on le dit comme tel
    // (sinon un débord dû à la TAILLE se lirait comme un débord dû au POSITIONNEMENT).
    if (footprint.w > plank.W + TOLERANCE_MM || footprint.d > plank.L + TOLERANCE_MM) return { ...base, code: "footprint" };
    const box = TrayGeometry.box(eq, plank);
    if (box.x1 > plank.W + TOLERANCE_MM) return { ...base, code: "over_width", reached: box.x1, at: box.x0 };
    if (box.y1 > plank.L + TOLERANCE_MM) return { ...base, code: "over_depth", reached: box.y1, at: box.y0 };
    return null;
  }

  /** Position par défaut sur un axe : la valeur saisie, sinon CENTRÉ (jamais négatif). */
  private static offset(value: unknown, span: number, size: number): number {
    return (value != null) ? +value : Math.max(0, (span - size) / 2);
  }
}
