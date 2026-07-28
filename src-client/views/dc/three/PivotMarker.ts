/* =============================================================================
   MARQUEUR DU CENTRE DE ROTATION (pivot d'orbite) — style et tracé.

   Module PUR : aucun import THREE, aucun accès au DOM. Il ne fabrique NI canvas,
   NI texture — il DÉCRIT le marqueur (couleurs, épaisseurs, tracé) et laisse
   `DcThreeBase.pivotTexture()` fournir le contexte 2D. C'est ce découpage qui rend
   testable ce qui l'est : les couleurs suivent-elles le thème, la clé de cache
   suit-elle le thème, le halo est-il bien tracé SOUS le trait et plus épais que
   lui. Le RÉSULTAT RASTÉRISÉ, lui, ne se teste pas — il se regarde.

   POURQUOI CE MODULE EXISTE (bug utilisateur : « le marqueur de pivot n'est
   vraiment pas visible en version light »). Le marqueur était dessiné avec une
   couleur EN DUR — `#c8d2e0`, la valeur de `--fg` du thème SOMBRE — et posé à
   `opacity: 0.55`. Sur un fond clair, un gris clair à 55 % d'opacité ne se
   distingue plus de rien. Deux défauts, donc, et un seul ne suffisait pas à
   expliquer l'autre :
     1. la couleur ne SUIVAIT PAS le thème (le sprite n'est pas rattrapé par
        `applyThemeChange`, qui ne remappe que des couleurs de MATÉRIAU) ;
     2. l'opacité écrasait le contraste, quel que soit le thème.

   POURQUOI UN HALO, ET PAS SEULEMENT UNE COULEUR QUI SUIT LE THÈME. Le marqueur
   est en `depthTest: false` : il se dessine PAR-DESSUS n'importe quoi — une baie
   noire, un sol blanc, une image de façade. Suivre la couleur de FOND de la scène
   ne règle donc que le cas où l'on vise le vide. La parade usuelle d'un réticule
   est le tracé en DEUX PASSES : un liseré de contraste (halo), puis le trait
   par-dessus. Quel que soit l'arrière-plan, l'un des deux tranche — et la paire
   « clair sur sombre » / « sombre sur clair » est exactement ce que le thème
   choisit. C'est aussi pourquoi l'opacité peut remonter sans devenir criarde :
   un trait FIN bien contrasté se lit mieux qu'un trait épais délavé.

   ⚠ CACHE. La texture est mise en cache par `DcThreeBase.texCache`, et les clés
   « ##… » y sont PERMANENTES (jamais évincées, cf. `pruneLabelTextureCache`). Une
   texture qui dépend du thème EXIGE donc une clé qui en dépend aussi : sans ça,
   basculer clair↔sombre servirait éternellement la texture du premier thème
   rencontré. D'où `cacheKey()` — deux entrées permanentes au maximum.

   DISCRÉTION. C'est un REPÈRE, pas un élément de scène : on garde la silhouette
   historique (anneau pointillé + croix), la taille écran (~46 px) et le tracé fin.
   Rien n'est ajouté au dessin, seul le CONTRASTE change.
   ============================================================================= */
import { Color } from "../../../core/Color";

/** Les deux encres du marqueur : le TRAIT et son liseré de contraste. */
export interface PivotMarkerInk {
  /** Couleur du trait (celle qu'on lit). */
  core: string;
  /** Liseré tracé SOUS le trait, dans la teinte opposée — c'est lui qui garantit
      la lisibilité par-dessus un contenu de couleur quelconque. */
  halo: string;
}

/** Sous-ensemble de `CanvasRenderingContext2D` réellement utilisé par le tracé.
    Interface ÉTROITE volontairement : elle documente exactement la dépendance au canvas, et
    permet de vérifier le tracé avec un contexte ENREGISTREUR, sans DOM. Un vrai
    `CanvasRenderingContext2D` la satisfait structurellement (aucune adaptation à l'appel). */
export interface PivotMarkerCanvas {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  setLineDash(segments: number[]): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
}

export class PivotMarker {
  /* ======================= LES VALEURS RÉGLABLES DU MARQUEUR =======================
     TOUT ce qui se retouche à l'œil vit ICI, et nulle part ailleurs. Les ratios sont
     exprimés en fraction de la TAILLE DE TEXTURE : changer `TEXTURE_SIZE_PX` change la
     finesse de rastérisation SANS changer l'aspect à l'écran. */

  /** Diamètre APPARENT du marqueur, en pixels écran — constant quel que soit le zoom
      (le sprite est remis à l'échelle à chaque mise à jour de caméra). Valeur historique. */
  static readonly SCREEN_SIZE_PX = 46;

  /** Opacité du sprite. Relevée de 0,55 à 0,85 : à 0,55 le trait se dissolvait dans un fond
      clair AVANT même la question de sa couleur. Le halo permet de rester lisible sans monter
      à 1 — le marqueur reste un repère translucide, pas un viseur opaque. */
  static readonly OPACITY = 0.85;

  /** Côté du canvas source. 128 (et non 64) parce que le liseré ajoute un détail FIN :
      à 64 px pour un rendu de 46 px, halo et trait se confondaient en une bouillie grise. */
  static readonly TEXTURE_SIZE_PX = 128;

  /** Rayon de l'anneau, en fraction du côté. */
  static readonly RING_RADIUS_RATIO = 0.27;
  /** Demi-longueur des bras de la croix, en fraction du côté. */
  static readonly ARM_HALF_RATIO = 0.45;
  /** Épaisseur du TRAIT, en fraction du côté. `2,5 / 64` — l'épaisseur historique, exprimée en
      ratio : à 128 px de texture elle vaut 5 px canvas, soit les mêmes ~1,8 px à l'écran qu'avant.
      Le marqueur n'a donc PAS épaissi ; seul son contraste a changé. */
  static readonly CORE_STROKE_RATIO = 0.0390625;
  /** Épaisseur du liseré DE CHAQUE CÔTÉ du trait, en fraction du côté. `1,5 / 64` ≈ 1,1 px écran :
      assez pour détacher le trait de n'importe quel fond, trop peu pour se voir comme un contour.
      Le halo est tracé à `CORE + 2 × OUTLINE` — seule façon d'obtenir un liseré régulier autour
      d'un trait centré sur son chemin. */
  static readonly HALO_OUTLINE_RATIO = 0.0234375;
  /** Pointillés [plein, vide], en fraction du côté — `4 / 64` et `3 / 64`, soit exactement les
      longueurs apparentes de l'ancienne texture. */
  static readonly DASH_RATIO: readonly number[] = [0.0625, 0.046875];

  /* ---- encres, par thème ----
     Ensembles FERMÉS de constantes : le marqueur ne prend jamais sa couleur d'une donnée. Le
     trait prend la teinte OPPOSÉE au fond (c'est ce qui se voit quand on vise le vide), le
     halo prend celle du fond (c'est ce qui sauve quand on vise un objet de la teinte du trait). */
  private static readonly INK_ON_DARK: PivotMarkerInk = { core: "#f2f6fc", halo: "rgba(6,9,13,0.9)" };
  private static readonly INK_ON_LIGHT: PivotMarkerInk = { core: "#0f141b", halo: "rgba(255,255,255,0.92)" };

  /** Le fond de scène est-il CLAIR ? Règle unique de l'application (cf. `Color.isLightHex`),
      la même que celle qui décline déjà les portes de baie en clair/sombre. */
  static isLight(backgroundHex: number): boolean { return Color.isLightHex(backgroundHex); }

  /** Encres du marqueur pour un fond de scène donné. */
  static ink(backgroundHex: number): PivotMarkerInk {
    return PivotMarker.isLight(backgroundHex) ? PivotMarker.INK_ON_LIGHT : PivotMarker.INK_ON_DARK;
  }

  /** Clé de cache de la texture — DÉPENDANTE DU THÈME, sinon un changement de thème
      resservirait la texture de l'ancien (les clés « ##… » ne sont jamais évincées).
      Deux variantes seulement : le marqueur n'a que deux encres. */
  static cacheKey(backgroundHex: number): string {
    return "##pivot|" + (PivotMarker.isLight(backgroundHex) ? "light" : "dark");
  }

  /** Trace le marqueur, centré, sur un contexte 2D de côté `size`.

      DEUX PASSES sur le MÊME tracé, halo D'ABORD : le trait se pose ensuite dessus et n'en
      laisse dépasser qu'un liseré régulier. L'ordre n'est pas interchangeable — inversé, le
      halo effacerait le trait. Les pointillés sont posés UNE fois pour les deux passes : leur
      découpe se mesure en longueur de chemin, indépendamment de l'épaisseur, donc les deux
      passes tombent exactement sur les mêmes segments. */
  static draw(g: PivotMarkerCanvas, size: number, ink: PivotMarkerInk): void {
    const center = size / 2;
    const radius = size * PivotMarker.RING_RADIUS_RATIO;
    const arm = size * PivotMarker.ARM_HALF_RATIO;
    const coreWidth = size * PivotMarker.CORE_STROKE_RATIO;
    const haloWidth = coreWidth + 2 * size * PivotMarker.HALO_OUTLINE_RATIO;

    g.lineCap = "round";
    g.setLineDash(PivotMarker.DASH_RATIO.map((r) => size * r));

    const pass = (color: string, width: number): void => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.beginPath(); g.arc(center, center, radius, 0, Math.PI * 2); g.stroke();          // anneau
      g.beginPath();
      g.moveTo(center - arm, center); g.lineTo(center + arm, center);                    // croix horizontale
      g.moveTo(center, center - arm); g.lineTo(center, center + arm);                    // croix verticale
      g.stroke();
    };
    pass(ink.halo, haloWidth);
    pass(ink.core, coreWidth);
  }
}
