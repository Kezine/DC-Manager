/* =============================================================================
   BASE ORTHONORMÉE D'UNE FACE (normale + haut), PURE — le repère de dessin d'un
   plan plaqué sur une face d'équipement (le connecteur d'un port en 3D).

   POURQUOI CE MODULE EXISTE
   ---------------------------------------------------------------------------
   Un port se dessine comme un petit plan (`PlaneGeometry`) dont la NORMALE doit
   pointer hors de la face. Longtemps `DcThreeScene` l'orientait par
   `quaternion.setFromUnitVectors(+Z, n)` : la ROTATION MINIMALE qui amène +Z sur
   la normale. Cette rotation fixe la normale mais PAS le roulis autour d'elle —
   elle choisit l'axe de rotation le plus court, qui n'est pas celui qu'on veut.
   • Pour une normale le long de ±Y (façade d'une baie non tournée), l'axe est ±X
     et le HAUT du plan retombe vertical : correct, par chance.
   • Pour une normale le long de ±X (équipement libre tourné de 90°/270°, faces
     gauche/droite d'une boîte, baie dont le lacet met sa façade le long de X),
     l'axe est ±Y et le haut du plan reste HORIZONTAL : le connecteur sort tourné
     de 90° — le symptôme terrain « des ports à 90°/−90° du sens attendu, mais bien
     plaqués sur les faces ».
   • Pour une normale ±Z (faces dessus/dessous), le roulis est carrément arbitraire.

   La correction : ne pas déduire le roulis de la seule normale, mais construire la
   base COMPLÈTE de la face à partir de la normale ET d'une direction « HAUT »
   fournie par le résolveur (celle vers laquelle la fraction verticale `face_y`
   DÉCROÎT — `fy = 0` en haut de l'éditeur de façade). `DcThreeScene` pose alors le
   plan avec `setFromRotationMatrix(makeBasis(right, up, n))`.

   La scène 3D est Z-up (`DcThreeCamera` : `cam.up.set(0,0,1)`) — d'où le HAUT par
   défaut `{0,0,1}` et le trièdre DIRECT `makeBasis(right, up, n)` (colonnes X=right,
   Y=up, Z=normale), qui reproduit le plan `PlaneGeometry` (largeur sur X local,
   hauteur sur Y local, normale +Z local).
   ============================================================================= */

/** Vecteur 3D (mm ou direction) — local à ce module pur (ni DOM, ni THREE). */
export interface FaceVec3 { x: number; y: number; z: number; }

/** Base orthonormée DIRECTE d'une face : `right` (largeur), `up` (hauteur), `n` (normale sortante). */
export interface FaceBasis { right: FaceVec3; up: FaceVec3; n: FaceVec3; }

export class FaceFrame {
  /** Base orthonormée directe d'une face, à partir de sa normale `n` et d'un HAUT souhaité `up`.
      • `n` est normalisée.
      • `up` = celui fourni s'il existe, sinon le HAUT par défaut de la scène Z-up `{0,0,1}` ; s'il est
        COLINÉAIRE à la normale (|n·up| > 0,99 — cas d'une face horizontale dont on n'a pas fourni de haut,
        ou d'un haut mal choisi), on retombe sur un repli `{0,-1,0}` pour éviter un `right` dégénéré.
      • `right = up × n` (normalisé), puis `up = n × right` : `up` est ré-orthogonalisé contre `n`, si bien
        que la base est orthonormée même quand le `up` fourni n'était pas exactement perpendiculaire à `n`.
      Le trièdre (right, up, n) est DIRECT (right × up = n), donc directement utilisable par
      `THREE.Matrix4.makeBasis(right, up, n)`. */
  static basis(n: FaceVec3, up?: FaceVec3): FaceBasis {
    const nlen = Math.hypot(n.x, n.y, n.z) || 1;
    const nn: FaceVec3 = { x: n.x / nlen, y: n.y / nlen, z: n.z / nlen };

    // HAUT souhaité, normalisé (un `up` dégénéré retombe sur le défaut Z-up).
    let u: FaceVec3 = up ? { x: up.x, y: up.y, z: up.z } : { x: 0, y: 0, z: 1 };
    let ul = Math.hypot(u.x, u.y, u.z);
    if (ul < 1e-9) { u = { x: 0, y: 0, z: 1 }; ul = 1; }
    u = { x: u.x / ul, y: u.y / ul, z: u.z / ul };
    // Colinéaire à la normale ⇒ `up × n` serait nul : repli sur un axe transverse.
    if (Math.abs(nn.x * u.x + nn.y * u.y + nn.z * u.z) > 0.99) u = { x: 0, y: -1, z: 0 };

    const right = FaceFrame.normalize(FaceFrame.cross(u, nn));
    const upOut = FaceFrame.cross(nn, right);   // déjà unitaire (n ⊥ right, tous deux unitaires)
    return { right, up: upOut, n: nn };
  }

  /** Produit vectoriel a × b. */
  private static cross(a: FaceVec3, b: FaceVec3): FaceVec3 {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  }

  /** Normalisation sûre (longueur nulle → vecteur inchangé). */
  private static normalize(v: FaceVec3): FaceVec3 {
    const l = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / l, y: v.y / l, z: v.z / l };
  }
}
