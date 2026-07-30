/* =============================================================================
   POLITIQUE de la bascule « Images de façade » (showFaceImages) sur les BOÎTES 6 FACES.

   Module PUR (aucun import THREE, aucun DOM — le jeu de matériaux est un générique
   opaque) : il est testable en Node, contrairement au moteur qu'il sert. Même
   raison d'être que `SceneLayoutSignature` : le rendu 3D n'a aucun test
   automatique, donc toute DÉCISION qu'il applique doit vivre dans un module
   chargeable par le harnais.

   POURQUOI CE MODULE EXISTE. La bascule « Images de façade » n'agissait QUE sur
   les équipements MONTÉS EN U : leur chemin de rendu dessine les images en PLANS
   séparés tagués `layer: "faceImage"`, que la passe de visibilité peut masquer.
   Les cinq autres modes de placement (libre en salle, posé d'étage, posé
   d'étagère, marge, paroi — tous servis par `buildEquipBox` depuis
   docs/placement.md §6.25) appliquent leurs images comme MATÉRIAUX des six faces
   de la BoxGeometry : aucun objet à masquer, la bascule était SANS EFFET (dette
   consignée au §6.24). Un matériau ne se « masque » pas — il s'ÉCHANGE : chaque
   boîte porte donc DEUX jeux de matériaux (`avec` images / `sans` = corps
   coloré), et la bascule choisit le jeu actif. Instantané, aucun rebuild — la
   parité avec le chemin des montés en U est préservée.

   LES DEUX DÉCISIONS, aux MÊMES sources. Le jeu actif est choisi à DEUX moments
   (au build, par l'état courant de l'option ; à la bascule, par la passe de
   visibilité) : si les deux points d'appel écrivaient chacun leur ternaire, ils
   divergeraient un jour — d'où `materials(...)`, écrite une fois. Et le REPÈRE
   D'ORIENTATION dépend des deux couches à la fois : les 4 arêtes accent de la
   face avant sont redondantes quand une image d'avant est AFFICHÉE (elle indique
   déjà l'avant), mais indispensables dès que la bascule la masque — sans elles,
   une boîte à image avant perdrait tout repère. `orientEdgesVisible(...)` porte
   cette matrice (orient × image avant × bascule), verrouillée par les tests.
   ============================================================================= */

/** Les DEUX jeux de matériaux d'une boîte 6 faces (posés dans `mesh.userData.faceImageSwap`) :
    `avec` = image de façade là où elle existe (le matériau texturé GARDE sa texture même
    débranché — le chargement async y aboutit hors écran, sans coût) ; `sans` = les six faces
    au corps coloré. Générique : le module ne connaît pas THREE. */
export interface FaceImageSwap<M> { avec: M; sans: M; }

export class FaceImagePolicy {

  /** Jeu de matériaux ACTIF d'une boîte selon la bascule « Images de façade ». Source UNIQUE des
      deux points de choix : le build (état initial) et la passe de visibilité (swap sans rebuild). */
  static materials<M>(swap: FaceImageSwap<M>, showFaceImages: boolean): M {
    return showFaceImages ? swap.avec : swap.sans;
  }

  /** Visibilité du REPÈRE D'ORIENTATION d'une boîte (les 4 arêtes accent de sa face avant).
      Visible si la couche « repères » est active ET que l'image d'avant ne fait pas déjà le
      travail : soit la boîte n'en a pas (`frontImageAsMarker` faux), soit la bascule « Images
      de façade » la masque. Les arêtes sont TOUJOURS construites (bascule en visibilité,
      jamais en rebuild) — c'est cette règle qui décide de leur affichage. */
  static orientEdgesVisible(showOrientMarks: boolean, frontImageAsMarker: boolean, showFaceImages: boolean): boolean {
    return showOrientMarks && !(frontImageAsMarker && showFaceImages);
  }
}
