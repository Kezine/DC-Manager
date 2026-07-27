import { Normalize } from "../core/Normalize";

/* =============================================================================
   CONTENEUR BAIE — la baie PLACE ses contenus (doctrine `docs/placement.md`).

   POURQUOI CE MODULE EXISTE
   ---------------------------------------------------------------------------
   `Resolver3D.resolveFaceAnchor3D` recomposait à la main, dans QUATRE branches
   successives (`rack`, `side`, `wall`, `tray`), la même mécanique : « prendre un
   point LOCAL à la baie, le tourner par l'orientation de la baie, le translater
   à la position de la baie ». La doctrine nomme ce symptôme et le rend opposable
   (§3, règle 1) : « si l'on écrit une n-ième branche qui recompose à la main
   rotation de l'hôte puis translation, c'est le signe qu'un conteneur manque ».
   §6.1 dit à qui la règle appartient : « chaque conteneur place ses propres
   contenus […] le chaînage remplace le switch ».

   Ce module est donc LE CONTENEUR BAIE, et rien d'autre. Chaque mode d'attache
   garde ce qui lui est PROPRE (index U, face, marges, plateau, colonne de
   paroi…) : ce paramétrage ne fait délibérément PAS partie de l'interface
   commune (doctrine §6.2, « interface COMMUNE mais ÉTROITE »). Une branche ne
   produit plus que sa boîte / son point LOCAL ; la composition appartient ici.

   ⚠ CE N'EST PAS un `PlacementFrame` générique. La salle et l'étage ne sont PAS
   couverts : leur migration viendra à son tour (ordre §6.10, la salle en
   dernier). Généraliser maintenant figerait une abstraction spéculative — ce que
   §4.3 interdit explicitement.

   REPÈRES — ce que ce module transforme, et vers QUOI
   ---------------------------------------------------------------------------
   • Repère LOCAL DE BAIE : origine au CENTRE de l'empreinte au sol de la baie,
     +X vers sa droite VUE DE FACE, −Y vers sa façade, Z mesuré depuis le sol de
     la SALLE (les boîtes de `RackGeometry.*BoxLocal` sont exprimées ainsi).
   • Repère LOCAL SALLE : origine au coin de la salle, axes de la salle. C'est le
     repère de sortie — **PAS le monde**. Au-dessus de la salle, la transformée
     n'est pas intrinsèque : elle relève du LAYOUT (§6.6), qui dépend de
     l'ensemble affiché et vit dans `FloorLayout.multiLayout`/`roomToWorld`.

   Le lacet de la baie est un lacet PUR (autour de Z) : il ne touche donc jamais
   la composante Z, ni d'un point, ni d'une normale. C'est pourquoi une direction
   locale n'a que deux composantes.

   ⚠ ORIGINE D'UNE BAIE NON POSITIONNÉE : `dc_x`/`dc_y` absents valent **0** ici,
   convention des quatre branches de résolution de ports. Le dépôt en connaît une
   SECONDE, qui replie sur la demi-empreinte (`width/2`, `depth/2`) : elle vit
   dans `Resolver3D.brushGeom`/`sidePinGeom`/`capPinGeom` (géométrie des
   waypoints) et dans `FreeEquipGeometry.portWorld`. Les deux conventions
   coexistent DÉJÀ et divergent : elles ne sont pas arbitrées ici, sous peine de
   déplacer silencieusement des points de brassage. Divergence signalée, non
   corrigée — cf. le rapport du lot et `docs/placement.md` §6.11.
   ============================================================================= */

/** Point exprimé dans le repère LOCAL d'une baie (mm). */
export interface RackLocalPoint { x: number; y: number; z: number; }

/** Direction HORIZONTALE locale (normale sortante d'une face) : le lacet d'une baie ne touche pas Z. */
export interface RackLocalDir { x: number; y: number; }

/** Repère d'une baie DANS SA SALLE : lacet (cosinus/sinus) + origine. Dérivé des SEULS champs de la baie —
    c'est ce qui fait de cette transformée une transformée INTRINSÈQUE au sens de la doctrine §6.6. */
export interface RackBasis { cos: number; sin: number; originX: number; originY: number; }

/** Contenu placé par la baie : point + normale sortante, exprimés en LOCAL SALLE. */
export interface RackPlacedPoint { x: number; y: number; z: number; n: { x: number; y: number; z: number }; }

export class RackFrame {
  /** Repère de la baie. `orientation` passe par `Normalize.rackOrientation` (angles CARDINAUX 0/90/180/270,
      valeur hors liste ramenée à 0) — même normalisation que le dessin, sans quoi un port ne coïnciderait
      plus avec la coque qui le porte. */
  static basis(rack: any): RackBasis {
    const yaw = Normalize.rackOrientation(rack.orientation) * Math.PI / 180;
    return {
      cos: Math.cos(yaw),
      sin: Math.sin(yaw),
      originX: (rack.dc_x != null) ? rack.dc_x : 0,
      originY: (rack.dc_y != null) ? rack.dc_y : 0,
    };
  }

  /** POINT local baie → local salle : rotation par le lacet, PUIS translation à l'origine de la baie. */
  static pointToRoom(basis: RackBasis, local: RackLocalPoint): { x: number; y: number; z: number } {
    return {
      x: basis.originX + local.x * basis.cos - local.y * basis.sin,
      y: basis.originY + local.x * basis.sin + local.y * basis.cos,
      z: local.z,
    };
  }

  /** DIRECTION locale baie → local salle : rotation SEULE, **sans translation**. C'est précisément la
      distinction que chaque branche réécrivait à la main — et la première chose qu'on se trompe à
      recopier, une normale translatée cessant d'être unitaire. */
  static dirToRoom(basis: RackBasis, local: RackLocalDir): { x: number; y: number; z: number } {
    return { x: local.x * basis.cos - local.y * basis.sin, y: local.x * basis.sin + local.y * basis.cos, z: 0 };
  }

  /** Place un CONTENU de la baie : son point d'ancrage local et la normale sortante de sa face, rendus en
      LOCAL SALLE. C'est l'opération que les quatre modes d'attache (`rack`, `side`, `wall`, `tray`)
      consomment — la seule constatée dans plus d'une implémentation, donc la seule à mériter d'être
      offerte d'un bloc (doctrine §6.2). */
  static place(rack: any, local: RackLocalPoint, dir: RackLocalDir): RackPlacedPoint {
    const basis = RackFrame.basis(rack);
    const p = RackFrame.pointToRoom(basis, local);
    return { x: p.x, y: p.y, z: p.z, n: RackFrame.dirToRoom(basis, dir) };
  }
}
