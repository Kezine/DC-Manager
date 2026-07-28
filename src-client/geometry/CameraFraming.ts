import { RACK_WIDTH_DEFAULT } from "../domain/constants";

/* =============================================================================
   RÈGLE DE CADRAGE de la caméra 3D — PURE (ni THREE, ni DOM, ni store).

   POURQUOI CE MODULE EXISTE
   ---------------------------------------------------------------------------
   La règle vivait à l'intérieur du moteur, écrite en une ligne
   (`baseHalf = Math.max(400, extent * 0.7 + 200)`) qui n'exprimait AUCUNE
   intention lisible : elle mêlait un facteur, un rembourrage constant et un
   plancher. Sa conséquence — le TAUX DE REMPLISSAGE, c'est-à-dire la fraction
   de la vue qu'occupe l'objet cadré — dépendait donc de la TAILLE de l'objet :
   71 % à la limite des grands objets, 62 % pour une baie de 2 m, 48 % pour un
   boîtier de 600 mm, 25 % pour un boîtier de 200 mm (le rembourrage constant
   dominant alors tout le reste). « Localiser » rendait ainsi un cadrage
   inégal, dont l'utilisateur ne pouvait pas prévoir le résultat.

   Ce module répond à UNE question, et la nomme : quelle DEMI-ÉTENDUE monde
   faut-il cadrer pour qu'un objet de taille `extent` occupe la fraction voulue
   de la vue, sans dépasser la limite de zoom ? Il ne prend que des nombres et
   n'en rend qu'un — c'est ce qui le rend testable hors navigateur, et ce qui
   justifie de le sortir du moteur (cf. `docs/placement.md` §3 règle 4 : « la
   géométrie de composition est PURE et vit dans geometry/ ; les vues ne font
   qu'appliquer »).

   CE QUE « LA VUE » VEUT DIRE ICI
   ---------------------------------------------------------------------------
   La demi-étendue rendue est celle que le moteur appelle `baseHalf` : la
   DEMI-HAUTEUR du frustum en unités monde (mm), à zoom 1. La hauteur de vue
   vaut donc `2 × baseHalf`, la largeur `aspect × 2 × baseHalf`. En paysage
   (`aspect ≥ 1`, le cas normal) c'est la HAUTEUR qui borne : cadrer la hauteur
   suffit. En portrait, c'est la LARGEUR — d'où le paramètre `viewAspect`, qui
   élargit alors le cadrage pour que la promesse « 90 % de la vue » reste vraie
   quelle que soit la forme de la fenêtre.
   ============================================================================= */
export class CameraFraming {
  /** Fraction de la vue qu'un objet cadré doit occuper. Demandé explicitement : 90 %.
      Les 10 % restants sont la respiration qui évite un objet collé aux bords. */
  static readonly FILL_RATIO = 0.9;

  /** LIMITE DE ZOOM : plus petite étendue monde (mm) que la vue embrasse jamais.
      POURQUOI CETTE VALEUR — c'est la largeur d'une baie standard
      (`RACK_WIDTH_DEFAULT`, 600 mm), et non un nombre choisi au jugé. En deçà,
      la vue ne contient plus AUCUN élément structurel reconnaissable du
      datacenter : on voit un fragment de panneau, sans repère d'échelle ni
      contexte. 600 mm valent par ailleurs ~13,5 U — localiser un boîtier 1U
      laisse donc encore voir environ 6 U de baie au-dessus et au-dessous.
      Sans ce plancher, cadrer un boîtier de 100 mm à 90 % donnerait une vue de
      111 mm de haut : l'objet remplirait l'écran, et on aurait perdu jusqu'à
      la baie qui le porte. */
  static readonly MIN_FRAMED_EXTENT_MM = RACK_WIDTH_DEFAULT;

  /** Élévation (rad) de la caméra « Localiser » : légèrement PLONGEANTE (20°).
      Assez basse pour rester une vue de face — on lit les façades, les libellés
      et les ports —, assez haute pour donner le relief qui distingue l'avant de
      l'arrière et fait comprendre où l'objet est posé. C'est la SEULE constante
      à retoucher si l'angle doit être ajusté à l'œil. */
  static readonly FOCUS_ELEVATION_RAD = Math.PI / 9;

  /** ÉTENDUE CADRABLE d'un objet : sa plus grande cote. Un cadrage ne connaît pas
      l'azimut sous lequel l'objet sera regardé — sa hauteur écran varie avec
      l'angle, sa largeur écran entre la largeur et la diagonale de son
      empreinte. Retenir la plus grande des trois cotes est la borne SÛRE : quel
      que soit l'angle, l'objet tient dans ce cadrage. */
  static objectExtent(widthMm: number, depthMm: number, heightMm: number): number {
    return Math.max(widthMm || 0, depthMm || 0, heightMm || 0);
  }

  /** DEMI-ÉTENDUE monde (mm) à cadrer pour qu'un objet de `extentMm` occupe
      `FILL_RATIO` de la vue, sans descendre sous la limite de zoom.
      `viewAspect` = largeur/hauteur du canevas ; ≥ 1 (paysage) ⇒ sans effet. */
  static halfExtentFor(extentMm: number, viewAspect = 1): number {
    const wanted = (extentMm > 0 ? extentMm : 0) / CameraFraming.FILL_RATIO;
    const framed = Math.max(CameraFraming.MIN_FRAMED_EXTENT_MM, wanted);   // limite de zoom : on n'embrasse jamais moins
    // En PORTRAIT la largeur de vue (aspect × hauteur) devient la dimension qui
    // borne : on élargit le cadrage d'autant pour que l'objet y tienne encore.
    const narrowing = (viewAspect > 0 && viewAspect < 1) ? viewAspect : 1;
    return framed / 2 / narrowing;
  }
}
