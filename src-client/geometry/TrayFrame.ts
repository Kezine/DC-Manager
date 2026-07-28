import type { TrayRect } from "../../src-shared/TrayGeometry";

/* =============================================================================
   REPÈRE D'UN CONTENU POSÉ SUR UNE ÉTAGÈRE — l'ÉTAGÈRE place ses contenus
   (`docs/placement.md` §6.1). Pendant de `PlacementFrame` un cran PLUS BAS dans
   la chaîne : là où `PlacementFrame` amène un contenu de son repère propre à
   celui de la SALLE, ce module amène un contenu du repère PLATEAU à celui de la
   BAIE.

   LE CONTENEUR QUI MANQUAIT
   ---------------------------------------------------------------------------
   La chaîne étagère → baie → salle existait dans `src-shared/PlacementContainers`,
   mais la GÉOMÉTRIE ne la suivait pas : c'était la BAIE qui plaçait directement le
   posé, l'étagère n'étant qu'un intermédiaire de calcul. Concrètement, TROIS sites
   re-dérivaient chacun `tray.side !== "rear"` et en tiraient chacun sa conséquence :
     • `RackGeometry.trayEquipBoxLocal` — pour RETOURNER l'axe des profondeurs ;
     • `Resolver3D` (branche `tray`)     — pour le SIGNE de la normale d'un port ;
     • `DcThreeScene`                    — pour savoir quelle face porte l'image de façade.
   Trois lectures d'une seule règle — « une étagère arrière retourne ses contenus » —
   qu'aucune ne nommait. C'est la signature du conteneur manquant décrite en §3
   règle 1, et la troisième occurrence justifiait l'extraction bien au-delà du seuil
   de §4.3 (deux).

   CE QUE CE MODULE TRANSFORME, ET VERS QUOI
   ---------------------------------------------------------------------------
   • Repère PLATEAU (celui de `src-shared/TrayGeometry`) : `x` = largeur depuis le
     bord UTILISABLE gauche, `y` = profondeur depuis la FACE DE MONTAGE de
     l'étagère, `z` implicite au-dessus du plateau. Indépendant de la face et de
     l'orientation de la baie — c'est ce qui le rend utilisable par la validation
     partagée, qui n'a aucun repère de baie sous la main.
   • Repère BAIE : celui des `*BoxLocal` de `RackGeometry`.

   La transformée est une TRANSLATION, plus un RETOURNEMENT de l'axe Y quand
   l'étagère est montée à l'arrière. Ce n'est PAS un lacet : `PlacementFrame` ne
   peut donc pas l'exprimer, et l'y forcer serait l'union qui fuit que §6.2
   proscrit. Deux repères voisins, deux transformées de nature différente.

   ⚠ L'AXE X N'EST PAS RETOURNÉ, ET CE N'EST PAS UN OUBLI — c'est le comportement
   EXISTANT, reproduit à l'identique et SIGNALÉ plutôt qu'arbitré. Une étagère
   arrière retourne les profondeurs mais pas les largeurs : `tray_x` reste compté
   depuis la gauche DE LA BAIE, jamais depuis la gauche vue par un opérateur placé
   derrière. Est-ce voulu ? La question est réelle — les trois sites d'origine
   s'accordaient sur ce point, donc ce n'est pas une divergence à réparer mais un
   ARBITRAGE à prendre, et le trancher ici déplacerait des équipements déjà saisis.
   Même principe qu'en §6.11 pour les deux conventions d'origine : on constate, on
   nomme, on ne tranche pas dans un lot de déduplication.

   INTERFACE ÉTROITE (§6.2) : n'est offert que ce qui est CONSTATÉ. Seuls des
   RECTANGLES sont transportés aujourd'hui — il n'existe pas un seul appelant qui
   transporte un point ou une direction du plateau vers la baie, donc pas de
   `pointToRack` ni de `dirToRack` spéculatifs. Le paramétrage d'ATTACHE d'un posé
   (`tray_x`/`tray_y`, empreinte, orientation propre) reste chez `TrayGeometry`.
   ============================================================================= */

/** Placement DÉCLARÉ d'une ÉTAGÈRE dans sa baie — ce que le conteneur doit savoir de lui-même, et
    rien d'autre. Dérivé de la boîte de l'étagère par `RackGeometry.trayPlacement`, exactement comme
    `RackGeometry.roomPlacement` dérive le placement d'une BAIE dans sa salle. */
export interface TrayPlacement {
  /** X (repère baie) du bord UTILISABLE gauche du plateau — garde des renforts DÉJÀ déduite. */
  usableX0: number;
  /** Y (repère baie) de la FACE DE MONTAGE : l'origine depuis laquelle `tray_y` se mesure. */
  faceY: number;
  /** Sens des +Y du plateau dans la baie : `+1` étagère AVANT, `-1` étagère ARRIÈRE (profondeurs
      retournées — le contenu s'enfonce vers la façade avant de la baie). */
  dirY: 1 | -1;
  /** Z (repère baie) du DESSUS du plateau : le plan sur lequel les contenus REPOSENT. */
  plankZ: number;
}

/** Rectangle exprimé dans le repère de la BAIE, bornes ORDONNÉES (`x0 ≤ x1`, `y0 ≤ y1`). */
export interface TrayRackRect { x0: number; x1: number; y0: number; y1: number; }

export class TrayFrame {
  /** Rectangle du repère PLATEAU → repère BAIE. Les bornes sont RÉORDONNÉES après transformation :
      sur une étagère arrière le retournement inverse l'intervalle Y, et tous les appelants attendent
      `y0 ≤ y1` (l'ancien code le garantissait par construction, en repartant du bord opposé). */
  static rectToRack(placement: TrayPlacement, rect: TrayRect): TrayRackRect {
    const ya = placement.faceY + placement.dirY * rect.y0;
    const yb = placement.faceY + placement.dirY * rect.y1;
    return {
      x0: placement.usableX0 + rect.x0,
      x1: placement.usableX0 + rect.x1,
      y0: Math.min(ya, yb),
      y1: Math.max(ya, yb),
    };
  }

  /** Les contenus de cette étagère regardent-ils la FAÇADE de la baie ? Autrement dit : l'étagère
      est-elle montée à l'avant ? C'est la question que `DcThreeScene` posait en relisant `tray.side`,
      pour décider quelle face du posé porte son image de façade. */
  static facesFront(placement: TrayPlacement): boolean {
    return placement.dirY > 0;
  }

  /** Signe, en Y de la BAIE, de la normale SORTANTE d'une face d'un contenu posé. `faceIsFront` dit
      de quelle face du CONTENU il s'agit (sa façade, ou son dos).

      Les −Y de la baie sont sa FAÇADE : la façade d'un contenu posé sur une étagère AVANT sort donc
      vers les −Y, et une étagère ARRIÈRE retourne les deux faces d'un coup. C'est la règle que
      `Resolver3D` réécrivait sous la forme `(portFront === trayFront) ? -1 : 1` — même verdict, mais
      sans que le résolveur ait à savoir ce que `tray.side` signifie. */
  static contentFaceDirY(placement: TrayPlacement, faceIsFront: boolean): 1 | -1 {
    const outward = faceIsFront ? -1 : 1;
    return (outward * placement.dirY) as 1 | -1;
  }
}
