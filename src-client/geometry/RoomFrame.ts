import { Normalize } from "../core/Normalize";

/* =============================================================================
   CONTENEUR SALLE — la salle PLACE ses contenus (doctrine `docs/placement.md`).

   POURQUOI CE MODULE EXISTE, ET POURQUOI IL S'APPELLE « SALLE »
   ---------------------------------------------------------------------------
   Il s'appelait `RackFrame` : le conteneur BAIE, extrait au lot précédent parce
   que `Resolver3D.resolveFaceAnchor3D` recomposait à la main, dans QUATRE
   branches, « prendre un point LOCAL, le tourner par l'orientation de l'hôte, le
   translater à la position de l'hôte ». Le mode LIBRE (`manual`) fait EXACTEMENT
   la même chose — avec l'orientation de l'ÉQUIPEMENT (`dc_orientation`) au lieu
   de celle d'une baie. Une baie et un équipement libre sont donc, l'un comme
   l'autre, un « objet posé dans une salle avec position + lacet » : la DEUXIÈME
   occurrence de la même abstraction, ce que §4.3 désigne comme le moment (et le
   seul) où l'on extrait — pas à la première, pas de façon spéculative.

   Ce qui est commun n'est ni la baie ni l'équipement : c'est la SALLE, qui les
   place tous les deux. D'où le nom, conforme à §6.1 (« chaque conteneur place
   ses propres contenus »).

   ⚠ NE PAS CONFONDRE avec `FloorLayout.roomToWorld`/`roomLocalToPlan`, qui
   portent la transformée de la salle vue comme un CONTENU de son plan d'étage.
   Ici, la salle est le CONTENEUR ; là-bas, elle est le contenu. Cette
   transformée-là existe déjà et n'est pas réécrite ici.

   ⚠ LA GÉNÉRALISATION S'ARRÊTE AU CONTENU D'UNE SALLE. Ni l'étage ni le bâtiment
   ne relèvent de ce module : au-dessus de la salle la transformée n'est pas
   intrinsèque, elle est une décision de LAYOUT qui dépend de l'ensemble affiché
   (§6.6). Un `PlacementFrame` universel mentirait sur ce point.

   ⚠ CE QUE CE MODULE COMPOSE, ET DANS QUEL REPÈRE IL REND (précisé au lot ÉTAGE)
   ---------------------------------------------------------------------------
   La composition est « lacet du CONTENU, PUIS translation à son ORIGINE ». Elle
   rend donc dans le repère de l'ORIGINE qu'on lui donne. Ses appelants de salle
   lui passent une position LOCALE SALLE (`dc_x`/`dc_y`), d'où un résultat local
   salle. `Resolver3D.resolvePortWorld3D` — les ports d'un équipement posé sur un
   ÉTAGE — lui passe, lui, l'ORIGINE MONDE que le layout calcule pour le conteneur
   étage, et obtient donc du MONDE.
   Ce n'est PAS la levée de la borne ci-dessus : la transformée du conteneur étage
   n'est toujours pas ici, elle est FOURNIE — ce module ne connaît ni étage, ni
   bâtiment, ni layout. La question « faut-il renommer ce conteneur en frame
   générique, la troisième occurrence étant constatée ? » est OUVERTE et
   délibérément NON tranchée : §4.3 fait de l'extraction un ARBITRAGE, pas un
   réflexe, et la renommer sans décision figerait une généralisation de plus.

   REPÈRES — ce que ce module transforme, et vers QUOI
   ---------------------------------------------------------------------------
   • Repère LOCAL D'UN CONTENU : origine au CENTRE de son empreinte au sol, +X
     vers sa droite VUE DE FACE, −Y vers sa façade, Z mesuré depuis le sol de la
     SALLE. C'est le repère des boîtes de `RackGeometry.*BoxLocal` comme celui de
     `FreeEquipGeometry.faceLocal`.
   • Repère LOCAL SALLE : origine au coin de la salle, axes de la salle. C'est le
     repère de sortie — **PAS le monde** (cf. ci-dessus, et `Resolver3D`).

   Le lacet est un lacet PUR (autour de Z) : il ne touche donc jamais la
   composante Z, ni d'un point, ni d'une direction. Une direction PEUT toutefois
   avoir une composante Z propre (face du DESSUS / du DESSOUS d'un équipement
   libre) : elle traverse alors la rotation inchangée.

   ⚠ ORIGINE D'UN CONTENU NON POSITIONNÉ — CORRECTION (arbitrée à ce lot)
   ---------------------------------------------------------------------------
   Quand `dc_x`/`dc_y` manquent, l'origine se replie sur la DEMI-EMPREINTE du
   contenu : il est alors posé À RAS DU COIN de la salle. C'est la convention que
   suivaient DÉJÀ les deux vues qui DESSINENT (`DcThreeScene.rackGroup`,
   `DcViews2D.rackNode`/`equipNode`) ainsi que la géométrie des waypoints et
   `FreeEquipGeometry` ; seule la RÉSOLUTION des ports repliait sur 0, ce qui
   posait les ports et les câbles à une demi-empreinte de la baie affichée.
   Le lot précédent avait signalé la divergence sans la trancher : c'est fait ici,
   et c'est la RÉSOLUTION qui s'aligne sur le RENDU. L'inverse mettrait le centre
   du contenu sur le coin de la salle, donc la moitié du contenu hors des murs.
   ============================================================================= */

/** Point exprimé dans le repère LOCAL d'un contenu de salle (mm). */
export interface ContentLocalPoint { x: number; y: number; z: number; }

/** Direction locale (normale sortante d'une face). `z` est optionnel : le lacet ne le touche pas, mais un
    contenu peut porter des faces HORIZONTALES (dessus/dessous d'un équipement libre) dont la normale est
    verticale — elle traverse alors la rotation telle quelle. */
export interface ContentLocalDir { x: number; y: number; z?: number; }

/** Placement DÉCLARÉ d'un contenu dans sa salle, tel que le portent ses champs — la seule chose dont le
    conteneur ait besoin. Le paramétrage d'ATTACHE (index U, face de montage, plateau, paroi…) reste PROPRE
    à chaque mode et n'entre délibérément pas ici (doctrine §6.2, « interface COMMUNE mais ÉTROITE »).
    `x`/`y` valent `null` quand l'utilisateur n'a pas saisi de position ; `halfW`/`halfD` sont la
    demi-empreinte au sol, qui sert alors de REPLI (cf. l'en-tête). */
export interface RoomContentPlacement { x: number | null; y: number | null; yawDeg: number; halfW: number; halfD: number; }

/** Repère d'un contenu DANS SA SALLE : lacet (cosinus/sinus) + origine. Dérivé des SEULS champs du contenu —
    c'est ce qui fait de cette transformée une transformée INTRINSÈQUE au sens de la doctrine §6.6. */
export interface RoomBasis { cos: number; sin: number; originX: number; originY: number; }

/** Contenu placé par la salle : point + normale sortante, exprimés en LOCAL SALLE. */
export interface RoomPlacedPoint { x: number; y: number; z: number; n: { x: number; y: number; z: number }; }

export class RoomFrame {
  /** Repère du contenu. `yawDeg` passe par `Normalize.rackOrientation` (angles CARDINAUX 0/90/180/270,
      valeur hors liste ramenée à 0) — même normalisation que le dessin, sans quoi un port ne coïnciderait
      plus avec la coque qui le porte. Position absente ⇒ demi-empreinte (cf. l'en-tête). */
  static basis(placement: RoomContentPlacement): RoomBasis {
    const yaw = Normalize.rackOrientation(placement.yawDeg) * Math.PI / 180;
    return {
      cos: Math.cos(yaw),
      sin: Math.sin(yaw),
      originX: (placement.x != null) ? placement.x : placement.halfW,
      originY: (placement.y != null) ? placement.y : placement.halfD,
    };
  }

  /** ORIGINE d'un contenu en LOCAL SALLE = le CENTRE de son empreinte au sol, c'est-à-dire l'image de son
      point local (0, 0) par `pointToRoom` (le lacet ne déplace pas l'origine, il tourne autour d'elle).
      C'est ce que consomment tous les usages qui veulent « où est cet objet dans sa salle » sans point
      local à composer : le cadrage caméra (« Localiser »), l'outil de positionnement, le placement
      automatique et les DEUX vues qui dessinent. Sans cette méthode, chacun d'eux recopie la règle de
      repli — la faute que ce conteneur existe précisément pour supprimer (doctrine §3 règle 1). */
  static origin(placement: RoomContentPlacement): { x: number; y: number } {
    const basis = RoomFrame.basis(placement);
    return { x: basis.originX, y: basis.originY };
  }

  /** POINT local → local salle : rotation par le lacet, PUIS translation à l'origine du contenu. */
  static pointToRoom(basis: RoomBasis, local: ContentLocalPoint): { x: number; y: number; z: number } {
    return {
      x: basis.originX + local.x * basis.cos - local.y * basis.sin,
      y: basis.originY + local.x * basis.sin + local.y * basis.cos,
      z: local.z,
    };
  }

  /** DIRECTION locale → local salle : rotation SEULE, **sans translation**. C'est précisément la
      distinction que chaque branche réécrivait à la main — et la première chose qu'on se trompe à
      recopier, une normale translatée cessant d'être unitaire. La composante verticale, elle, est
      INSENSIBLE au lacet : elle est recopiée. */
  static dirToRoom(basis: RoomBasis, local: ContentLocalDir): { x: number; y: number; z: number } {
    return {
      x: local.x * basis.cos - local.y * basis.sin,
      y: local.x * basis.sin + local.y * basis.cos,
      z: (local.z != null) ? local.z : 0,
    };
  }

  /** Place un CONTENU de la salle : son point d'ancrage local et la normale sortante de sa face, rendus en
      LOCAL SALLE. C'est l'opération que consomment les CINQ modes de placement (`rack`, `side`, `wall`,
      `tray` via leur baie, `manual` directement) — la seule constatée dans plus d'une implémentation, donc
      la seule à mériter d'être offerte d'un bloc (doctrine §6.2). */
  static place(placement: RoomContentPlacement, local: ContentLocalPoint, dir: ContentLocalDir): RoomPlacedPoint {
    const basis = RoomFrame.basis(placement);
    const p = RoomFrame.pointToRoom(basis, local);
    return { x: p.x, y: p.y, z: p.z, n: RoomFrame.dirToRoom(basis, dir) };
  }
}
