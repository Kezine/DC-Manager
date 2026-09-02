/* =============================================================================
   FLÈCHE DE LOCALISATION — style et tracé.

   Module PUR, JUMEAU de `PivotMarker` : aucun import THREE, aucun accès au DOM.
   Il ne fabrique NI canvas, NI texture — il DÉCRIT la flèche (couleurs, tracé,
   proportions) et laisse `DcThreeBase.focusArrowTexture()` fournir le contexte
   2D. Découpage identique, et pour la même raison : ce qui est décidable se
   teste (encres suivant le thème, clé de cache, halo sous le trait, pointe en
   bas), le résultat RASTÉRISÉ ne se teste pas — il se regarde.

   POURQUOI CETTE FLÈCHE EXISTE (demande utilisateur 2026-09-01). La mise en
   évidence « Localiser » repose sur une émissive ambre posée sur les matériaux
   de l'objet. Elle est invisible dès qu'une IMAGE DE FAÇADE couvre la face
   regardée : l'image est soit un plan posé devant la boîte, soit un matériau
   texturé DE la boîte — dans les deux cas, l'émissive est derrière ou absente.
   L'app teintait donc ces images en ambre pour compenser ; l'utilisateur a
   tranché : **on ne touche plus du tout aux images de façade** (une photo
   d'équipement doit rester lisible), et la désignation passe par un repère
   AJOUTÉ à la scène plutôt que par une altération de ce qu'elle montre.

   POURQUOI UN SPRITE, ET PAS UNE GÉOMÉTRIE. « Toujours perpendiculaire au
   viewport » est, mot pour mot, la définition d'un sprite : il fait face à la
   caméra par construction, sans code d'orientation à maintenir. Et la taille
   ÉCRAN constante est déjà un concept du moteur (`updateScreenScales`,
   `PivotMarker.SCREEN_SIZE_PX`) : la flèche garde donc la même présence qu'on
   regarde une salle entière ou un seul connecteur — c'est ce qui la rend utile
   sur un port, dont la taille apparente varie de quelques pixels à l'écran.

   POURQUOI LA POINTE EN BAS, ET L'ANCRAGE PAR LE BAS. Le sprite est posé AU
   POINT VISÉ avec `center = (0.5, 0)` : son bord INFÉRIEUR tombe sur la cible et
   le corps monte au-dessus. La pointe désigne donc exactement le point, à
   n'importe quel zoom, sans jamais le recouvrir — ce qu'un marqueur centré
   ferait (il masquerait précisément ce qu'on veut montrer). C'est l'affordance
   classique de l'épingle de carte, et c'est aussi pourquoi la flèche ne
   « pointe » pas dans une direction du monde : elle pointe vers le BAS DE
   L'ÉCRAN, donc toujours vers sa cible, quel que soit l'angle de la caméra.

   HALO. Même raison que le pivot : la flèche se dessine en `depthTest: false`,
   par-dessus n'importe quoi — une baie noire, un sol blanc, une photo de
   façade. Le tracé en deux passes (liseré de contraste, puis trait) garantit
   qu'une des deux tranche, quel que soit l'arrière-plan.

   ⚠ CACHE. Comme le pivot, la texture vit dans `DcThreeBase.texCache` dont les
   clés « ##… » sont PERMANENTES (jamais évincées). Une texture dépendante du
   thème EXIGE donc une clé qui en dépend — sinon basculer clair↔sombre
   resservirait éternellement la première rencontrée.

   ⚠ LA COULEUR DU PULSE N'EST PAS ICI. La flèche RESPIRE avec la mise en
   évidence (même période, même ambre) — mais c'est le sprite qui est teinté à
   l'exécution (`SpriteMaterial.color`), pas la texture qui est redessinée. Le
   tracé reste donc BLANC/neutre : il est la FORME, la couleur vient du pulse.
   ============================================================================= */
import { Color } from "../../../core/Color";

/** Les deux encres de la flèche : le TRAIT et son liseré de contraste. */
export interface FocusArrowInk {
  /** Remplissage du corps (celui qu'on lit ; teinté à l'exécution par le pulse). */
  core: string;
  /** Liseré tracé SOUS le corps, dans la teinte opposée — c'est lui qui garantit
      la lisibilité par-dessus un contenu de couleur quelconque. */
  halo: string;
}

/** Sous-ensemble de `CanvasRenderingContext2D` réellement utilisé par le tracé.
    Interface ÉTROITE volontairement (même patron que `PivotMarkerCanvas`) : elle documente
    exactement la dépendance au canvas et permet de vérifier le tracé avec un contexte
    ENREGISTREUR, sans DOM. Un vrai `CanvasRenderingContext2D` la satisfait structurellement. */
export interface FocusArrowCanvas {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
  lineCap: CanvasLineCap;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
}

export class FocusArrowMarker {
  /* ======================= LES VALEURS RÉGLABLES DE LA FLÈCHE =======================
     TOUT ce qui se retouche à l'œil vit ICI, et nulle part ailleurs. Les ratios sont
     exprimés en fraction de la TAILLE DE TEXTURE : changer `TEXTURE_SIZE_PX` change la
     finesse de rastérisation SANS changer l'aspect à l'écran. */

  /** Hauteur APPARENTE de la flèche, en pixels écran — constante quel que soit le zoom.
      Plus grande que le pivot (46 px) : le pivot est un repère qu'on cherche, la flèche est
      une DÉSIGNATION qu'on doit voir sans la chercher. */
  static readonly SCREEN_SIZE_PX = 64;

  /** Opacité du sprite. Pleine : c'est une désignation, pas un repère translucide comme le
      pivot. Le halo suffit à l'empêcher d'être criarde. */
  static readonly OPACITY = 1;

  /** Côté du canvas source (carré, comme les autres textures de marqueur). */
  static readonly TEXTURE_SIZE_PX = 128;

  /* ---- proportions du tracé, en fraction du côté ----
     La flèche occupe la moitié BASSE du canvas : pointe au bas exact (`TIP_Y_RATIO = 1`),
     corps qui remonte. Le sprite étant ancré par son bord inférieur, la pointe tombe donc
     PILE sur le point visé. Le haut du canvas reste vide : c'est la marge qui évite que le
     filtrage de texture ne rogne le liseré. */
  /** Y de la POINTE (bas du canvas). */
  static readonly TIP_Y_RATIO = 0.97;
  /** Y de la base de la tête (là où les ailerons rejoignent la hampe). */
  static readonly HEAD_Y_RATIO = 0.58;
  /** Y du haut de la hampe. */
  static readonly TAIL_Y_RATIO = 0.16;
  /** Demi-largeur de la TÊTE. */
  static readonly HEAD_HALF_RATIO = 0.26;
  /** Demi-largeur de la HAMPE. */
  static readonly SHAFT_HALF_RATIO = 0.098;
  /** Épaisseur du liseré, en fraction du côté (même ordre que le pivot). */
  static readonly HALO_OUTLINE_RATIO = 0.0234375;

  /* ---- encres, par thème ----
     Ensembles FERMÉS de constantes (patron `PivotMarker`). Le CORPS est neutre — clair sur
     fond sombre, sombre sur fond clair — parce que sa couleur « utile » est celle que le
     PULSE lui donne à l'exécution ; le halo prend la teinte du fond. */
  private static readonly INK_ON_DARK: FocusArrowInk = { core: "#ffffff", halo: "rgba(6,9,13,0.9)" };
  private static readonly INK_ON_LIGHT: FocusArrowInk = { core: "#ffffff", halo: "rgba(15,20,27,0.92)" };

  /** Le fond de scène est-il CLAIR ? Règle unique de l'application (`Color.isLightHex`). */
  static isLight(backgroundHex: number): boolean { return Color.isLightHex(backgroundHex); }

  /** Encres de la flèche pour un fond de scène donné. */
  static ink(backgroundHex: number): FocusArrowInk {
    return FocusArrowMarker.isLight(backgroundHex) ? FocusArrowMarker.INK_ON_LIGHT : FocusArrowMarker.INK_ON_DARK;
  }

  /** Clé de cache de la texture — DÉPENDANTE DU THÈME (les clés « ##… » ne sont jamais
      évincées, cf. l'en-tête). Deux variantes seulement : la flèche n'a que deux encres. */
  static cacheKey(backgroundHex: number): string {
    return "##focusarrow|" + (FocusArrowMarker.isLight(backgroundHex) ? "light" : "dark");
  }

  /** Contour de la flèche (7 sommets), centré horizontalement, pointe en BAS, sur un carré
      de côté `size`. Rendu à part du tracé : c'est la seule partie GÉOMÉTRIQUE, donc la seule
      qu'un test puisse contrôler point par point (pointe au bas, symétrie, ordre des sommets). */
  static outline(size: number): Array<{ x: number; y: number }> {
    const cx = size / 2;
    const tipY = size * FocusArrowMarker.TIP_Y_RATIO;
    const headY = size * FocusArrowMarker.HEAD_Y_RATIO;
    const tailY = size * FocusArrowMarker.TAIL_Y_RATIO;
    const headHalf = size * FocusArrowMarker.HEAD_HALF_RATIO;
    const shaftHalf = size * FocusArrowMarker.SHAFT_HALF_RATIO;
    return [
      { x: cx, y: tipY },                       // pointe (bas)
      { x: cx + headHalf, y: headY },           // aileron droit
      { x: cx + shaftHalf, y: headY },          // épaule droite
      { x: cx + shaftHalf, y: tailY },          // haut droit de la hampe
      { x: cx - shaftHalf, y: tailY },          // haut gauche
      { x: cx - shaftHalf, y: headY },          // épaule gauche
      { x: cx - headHalf, y: headY },           // aileron gauche
    ];
  }

  /** Trace la flèche sur un contexte 2D de côté `size`.

      DEUX PASSES sur le MÊME contour, halo D'ABORD (tracé au trait, donc débordant de part et
      d'autre du chemin), puis le corps REMPLI par-dessus : il ne laisse dépasser qu'un liseré
      régulier. L'ordre n'est pas interchangeable — inversé, le halo mangerait le corps. */
  static draw(g: FocusArrowCanvas, size: number, ink: FocusArrowInk): void {
    const pts = FocusArrowMarker.outline(size);
    const path = (): void => {
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      g.closePath();
    };
    g.lineJoin = "round"; g.lineCap = "round";
    path();
    g.strokeStyle = ink.halo;
    g.lineWidth = 2 * size * FocusArrowMarker.HALO_OUTLINE_RATIO;   // trait CENTRÉ sur le chemin → moitié dehors
    g.stroke();
    path();
    g.fillStyle = ink.core;
    g.fill();
  }
}
