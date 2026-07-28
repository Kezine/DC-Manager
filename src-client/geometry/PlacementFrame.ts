import { Normalize } from "../core/Normalize";

/* =============================================================================
   REPÈRE D'UN CONTENU PLACÉ — le CONTENEUR place son contenu (`docs/placement.md`).

   ⚠⚠ LA BORNE (§6.6) — À LIRE AVANT D'AJOUTER QUOI QUE CE SOIT DANS CE FICHIER
   ---------------------------------------------------------------------------
   CE MODULE NE CONNAÎT NI ÉTAGE, NI BÂTIMENT, NI SITE, NI LAYOUT — ET IL NE DOIT
   JAMAIS LES CONNAÎTRE. Il REÇOIT une origine ; il ne la CALCULE jamais.

   La raison est §6.6. SOUS la salle, la transformée d'un contenu est INTRINSÈQUE :
   elle se déduit des seuls champs de l'enregistrement, donc elle se compose ici,
   sans contexte. AU-DESSUS, elle est une DÉCISION DE LAYOUT — la bande d'un
   bâtiment vient du rangement des bâtiments côte à côte, le Z d'un niveau de
   l'empilement des hauteurs d'étages : des valeurs qui dépendent de l'ENSEMBLE
   AFFICHÉ, pas de l'enregistrement. Les faire entrer ici ferait dépendre la
   position d'un port de ce qui est à l'écran (l'inverse exact de §6.8) et
   produirait l'abstraction qui MENT : un repère prétendant remonter tout seul
   jusqu'au monde. C'est aussi pourquoi il n'y a PAS de `toParent()` uniforme.

   ⚠ LE NOM NE BORNE PLUS RIEN — c'est la contrepartie assumée du renommage
   (§6.22). Ce module s'est appelé `RackFrame` puis `RoomFrame` : « Rack », puis
   « Room », disaient jusqu'où la portée allait, et personne n'aurait songé à
   verser une transformée d'étage dans un module nommé d'après la salle.
   `PlacementFrame` est EXACT — le calcul ne lit QUE les champs du CONTENU, pas un
   seul de la salle — mais il INVITE à y verser tout le placement, layout compris.
   La borne ci-dessus est donc portée par CE PARAGRAPHE et par un VERROU DE TEST
   (`Tests/modules/test-geometry.js`, section « PlacementFrame : BORNE §6.6 »),
   qui refuse tout import porteur de layout ou de vue. Si un tel import devenait
   un jour légitime, c'est la DOCTRINE qu'il faut changer d'abord — pas la liste
   blanche du test.

   ⚠ NE PAS CONFONDRE avec `FloorLayout.roomToWorld`/`roomLocalToPlan` ni avec le
   type `FloorLayout.RoomPlacement` : ils portent la transformée de la salle vue
   comme un CONTENU de son plan d'étage. Là-bas la salle est l'objet PLACÉ ; ici
   elle n'est qu'un espace de coordonnées de destination possible parmi d'autres.
   Cette transformée-là existe déjà et n'est pas réécrite ici.

   CE QUE CE MODULE COMPOSE, ET DANS QUEL REPÈRE IL REND
   ---------------------------------------------------------------------------
   La composition est « lacet du CONTENU, PUIS translation à son ORIGINE ». Elle
   rend donc dans le repère de l'ORIGINE qu'on lui donne — dont ce module ignore
   la nature, et n'a pas à la connaître :
   • ses appelants de SALLE lui passent une position LOCALE SALLE (`dc_x`/`dc_y`,
     que le contenu DÉCLARE) ⇒ résultat en LOCAL SALLE ;
   • `Resolver3D.resolvePortWorld3D` — les ports d'un équipement posé sur un
     ÉTAGE — lui passe l'ORIGINE MONDE que le layout calcule pour le conteneur
     étage ⇒ résultat en MONDE.
   Ce n'est PAS une levée de la borne : la transformée du conteneur étage n'est
   toujours pas ici, elle est FOURNIE. C'est cette propriété, et elle seule, qui a
   permis la TROISIÈME occurrence sans toucher au module (§6.20) — et c'est elle
   qui a fini par rendre le nom « Room » FAUX (§6.22).

   ⚠ L'entrée ne parle QUE du contenu. `ContentPlacement` porte sa position, son
   lacet et sa demi-empreinte de repli : AUCUN champ de la salle n'entre dans le
   calcul, et c'est le constat qui a motivé le renommage.

   ⚠ CES MÉTHODES S'APPELAIENT `pointToRoom`/`dirToRoom` — renommées en §6.26.
   « Room » y désignait la DESTINATION, et c'était faux : ce module rend dans le
   repère de l'ORIGINE qu'on lui donne, laquelle est parfois MONDE (résolveur
   d'étage). Le nom n'a été corrigé qu'une fois établi qu'il MENTAIT — la version
   précédente de ce paragraphe le défendait en observant qu'aucun point d'appel
   n'en souffrait ENCORE, ce qui décrit un mensonge sans conséquence, pas un nom
   juste. `composePoint`/`composeDir` ne nomment plus une destination mais
   l'OPÉRATION, la seule chose qui ne dépende pas de l'appelant.

   ⚠ `RackGeometry.roomPlacement` et `FreeEquipGeometry.roomPlacement` GARDENT le
   leur, et pas par prudence : une baie EST placée dans une salle, un équipement
   libre AUSSI. Ces noms-là sont exacts, donc hors du périmètre de §6.26 — qui n'a
   renommé que ce qui était faux.

   REPÈRES — ce que ce module transforme, et vers QUOI
   ---------------------------------------------------------------------------
   • Repère LOCAL D'UN CONTENU : origine au CENTRE de son empreinte au sol, +X
     vers sa droite VUE DE FACE, −Y vers sa façade, Z mesuré depuis le SOL de son
     conteneur. C'est le repère des boîtes de `RackGeometry.*BoxLocal` comme celui
     de `FreeEquipGeometry.faceLocal`.
   • Repère de DESTINATION : celui de l'ORIGINE fournie — LOCAL SALLE (origine au
     coin de la salle, axes de la salle) pour les appelants de salle, MONDE pour
     le résolveur d'étage. Ce module ne choisit pas : il compose (cf. ci-dessus).

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

/** Point exprimé dans le repère LOCAL d'un CONTENU placé (mm). */
export interface ContentLocalPoint { x: number; y: number; z: number; }

/** Direction locale (normale sortante d'une face). `z` est optionnel : le lacet ne le touche pas, mais un
    contenu peut porter des faces HORIZONTALES (dessus/dessous d'un équipement libre) dont la normale est
    verticale — elle traverse alors la rotation telle quelle. */
export interface ContentLocalDir { x: number; y: number; z?: number; }

/** Placement DÉCLARÉ d'un contenu, tel que le portent SES PROPRES champs — la seule chose dont le repère
    ait besoin, et rien de son conteneur (cf. l'en-tête). Le paramétrage d'ATTACHE (index U, face de
    montage, plateau, paroi…) reste PROPRE à chaque mode et n'entre délibérément pas ici (doctrine §6.2,
    « interface COMMUNE mais ÉTROITE »). `x`/`y` valent `null` quand l'utilisateur n'a pas saisi de
    position ; `halfW`/`halfD` sont la demi-empreinte au sol, qui sert alors de REPLI (cf. l'en-tête). */
export interface ContentPlacement { x: number | null; y: number | null; yawDeg: number; halfW: number; halfD: number; }

/** Repère d'un contenu : lacet (cosinus/sinus) + origine. Dérivé des SEULS champs du contenu — c'est ce
    qui fait de cette transformée une transformée INTRINSÈQUE au sens de la doctrine §6.6. */
export interface PlacementBasis { cos: number; sin: number; originX: number; originY: number; }

/** Contenu PLACÉ : point + normale sortante, exprimés dans le repère de l'ORIGINE fournie (cf. l'en-tête). */
export interface PlacedPoint { x: number; y: number; z: number; n: { x: number; y: number; z: number }; }

export class PlacementFrame {
  /** Repère du contenu. `yawDeg` passe par `Normalize.rackOrientation` (angles CARDINAUX 0/90/180/270,
      valeur hors liste ramenée à 0) — même normalisation que le dessin, sans quoi un port ne coïnciderait
      plus avec la coque qui le porte. Position absente ⇒ demi-empreinte (cf. l'en-tête). */
  static basis(placement: ContentPlacement): PlacementBasis {
    const yaw = Normalize.rackOrientation(placement.yawDeg) * Math.PI / 180;
    return {
      cos: Math.cos(yaw),
      sin: Math.sin(yaw),
      originX: (placement.x != null) ? placement.x : placement.halfW,
      originY: (placement.y != null) ? placement.y : placement.halfD,
    };
  }

  /** ORIGINE d'un contenu en LOCAL SALLE = le CENTRE de son empreinte au sol, c'est-à-dire l'image de son
      point local (0, 0) par `composePoint` (le lacet ne déplace pas l'origine, il tourne autour d'elle).
      C'est ce que consomment tous les usages qui veulent « où est cet objet dans sa salle » sans point
      local à composer : le cadrage caméra (« Localiser »), l'outil de positionnement, le placement
      automatique et les DEUX vues qui dessinent. Sans cette méthode, chacun d'eux recopie la règle de
      repli — la faute que ce conteneur existe précisément pour supprimer (doctrine §3 règle 1). */
  static origin(placement: ContentPlacement): { x: number; y: number } {
    const basis = PlacementFrame.basis(placement);
    return { x: basis.originX, y: basis.originY };
  }

  /** POINT local → local salle : rotation par le lacet, PUIS translation à l'origine du contenu. */
  static composePoint(basis: PlacementBasis, local: ContentLocalPoint): { x: number; y: number; z: number } {
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
  static composeDir(basis: PlacementBasis, local: ContentLocalDir): { x: number; y: number; z: number } {
    return {
      x: local.x * basis.cos - local.y * basis.sin,
      y: local.x * basis.sin + local.y * basis.cos,
      z: (local.z != null) ? local.z : 0,
    };
  }

  /** Place un CONTENU : son point d'ancrage local et la normale sortante de sa face, rendus dans le repère
      de l'ORIGINE fournie (cf. l'en-tête). C'est l'opération que consomment les CINQ modes de placement en
      salle (`rack`, `side`, `wall`, `tray` via leur baie, `manual` directement) ET le résolveur d'étage —
      la seule constatée dans plus d'une implémentation, donc la seule à mériter d'être offerte d'un bloc
      (doctrine §6.2). */
  static place(placement: ContentPlacement, local: ContentLocalPoint, dir: ContentLocalDir): PlacedPoint {
    const basis = PlacementFrame.basis(placement);
    const p = PlacementFrame.composePoint(basis, local);
    return { x: p.x, y: p.y, z: p.z, n: PlacementFrame.composeDir(basis, dir) };
  }
}
