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

   La transformée est une TRANSLATION, plus — pour une étagère montée à l'ARRIÈRE —
   une ROTATION DE 180° autour de la verticale. Les deux axes se retournent
   ensemble : l'étagère arrière pivote comme un meuble qu'on retourne.

   ⚠ CE POINT A ÉTÉ ARBITRÉ (décision utilisateur, §6.24), il ne l'était pas au
   lot précédent. Le code d'origine ne retournait QUE l'axe Y — `tray_x` restait
   compté depuis la gauche DE LA BAIE, donc depuis la DROITE de l'opérateur placé
   derrière. C'était une RÉFLEXION, pas une rotation. Une réflexion n'existe pas
   physiquement (on ne retourne pas un boîtier comme un gant) et surtout elle NE SE
   COMPOSE PAS avec les lacets : c'est ce qui empêchait de faire remonter
   l'orientation propre d'un posé jusqu'à ses ports. Retenir la rotation vraie rend
   toute la chaîne composable — et c'est ce qui a permis de corriger le défaut des
   ports du même geste.

   `tray_x` se compte donc depuis la gauche de qui REGARDE l'étagère : la gauche de
   la baie pour une étagère avant, sa droite pour une arrière.

   INTERFACE ÉTROITE (§6.2) : n'est offert que ce qui est CONSTATÉ. Les rectangles
   sont transportés (boîte d'un posé), les points aussi (centre d'un posé, dont le
   résolveur de ports a besoin pour composer le lacet) — mais pas les DIRECTIONS :
   aucun appelant n'en transporte, et le lacet d'un contenu s'exprime déjà par
   `contentYawDeg` + `PlacementFrame`, qui tourne les normales. Le paramétrage
   d'ATTACHE d'un posé (`tray_x`/`tray_y`, empreinte) reste chez `TrayGeometry`.
   ============================================================================= */

/** Placement DÉCLARÉ d'une ÉTAGÈRE dans sa baie — ce que le conteneur doit savoir de lui-même, et
    rien d'autre. Dérivé de la boîte de l'étagère par `RackGeometry.trayPlacementInRack`, exactement comme
    `RackGeometry.roomPlacement` dérive le placement d'une BAIE dans sa salle. */
export interface TrayPlacement {
  /** X (repère baie) de l'ORIGINE des largeurs du plateau : son bord utilisable GAUCHE pour une
      étagère avant, son bord utilisable DROIT pour une arrière (l'origine tourne avec l'étagère). */
  originX: number;
  /** Y (repère baie) de la FACE DE MONTAGE : l'origine depuis laquelle `tray_y` se mesure. */
  originY: number;
  /** Sens des DEUX axes du plateau dans la baie : `+1` étagère AVANT, `-1` étagère ARRIÈRE. Un seul
      signe pour x ET y — c'est ce qui fait de la transformée une ROTATION de 180° et non une
      réflexion (cf. l'en-tête : une réflexion ne se composerait pas avec les lacets). */
  dir: 1 | -1;
  /** Z (repère baie) du DESSUS du plateau : le plan sur lequel les contenus REPOSENT. */
  plankZ: number;
}

/** Rectangle exprimé dans le repère de la BAIE, bornes ORDONNÉES (`x0 ≤ x1`, `y0 ≤ y1`). */
export interface TrayRackRect { x0: number; x1: number; y0: number; y1: number; }

export class TrayFrame {
  /** POINT du repère PLATEAU → repère BAIE. C'est la composition élémentaire dont les deux autres
      méthodes découlent ; le résolveur de ports s'en sert pour situer le CENTRE d'un posé, autour
      duquel `PlacementFrame` fera ensuite tourner son lacet propre. */
  static pointToRack(placement: TrayPlacement, point: { x: number; y: number }): { x: number; y: number } {
    return {
      x: placement.originX + placement.dir * point.x,
      y: placement.originY + placement.dir * point.y,
    };
  }

  /** Rectangle du repère PLATEAU → repère BAIE. Les bornes sont RÉORDONNÉES après transformation :
      sur une étagère arrière la rotation inverse les DEUX intervalles, et tous les appelants
      attendent `x0 ≤ x1` / `y0 ≤ y1`. Une rotation de 180° laisse une boîte alignée sur les axes
      alignée sur les axes — seuls ses coins s'échangent, d'où le simple réordonnancement. */
  static rectToRack(placement: TrayPlacement, rect: TrayRect): TrayRackRect {
    const a = TrayFrame.pointToRack(placement, { x: rect.x0, y: rect.y0 });
    const b = TrayFrame.pointToRack(placement, { x: rect.x1, y: rect.y1 });
    return {
      x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x),
      y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y),
    };
  }

  /** Les contenus de cette étagère regardent-ils la FAÇADE de la baie ? Autrement dit : l'étagère
      est-elle montée à l'avant ? C'est la question que `DcThreeScene` posait en relisant `tray.side`,
      pour décider quelle face du posé porte son image de façade. */
  static facesFront(placement: TrayPlacement): boolean {
    return placement.dir > 0;
  }

  /** Lacet d'un contenu DANS LE REPÈRE DE LA BAIE : son lacet propre, plus le demi-tour de l'étagère
      si elle est montée à l'arrière. C'est la clé de voûte du lot §6.24 — parce que la transformée de
      l'étagère est une ROTATION, les deux lacets s'ADDITIONNENT, et `PlacementFrame` peut composer
      l'ensemble d'un bloc. Avec l'ancienne réflexion, cette addition n'aurait pas eu de sens : le
      lacet propre d'un posé n'atteignait donc jamais ses ports, tous résolus comme s'il n'avait pas
      tourné (défaut confirmé par sonde, cf. §6.24). */
  static contentYawDeg(placement: TrayPlacement, contentYawDeg: number): number {
    return (contentYawDeg || 0) + (placement.dir > 0 ? 0 : 180);
  }
}
