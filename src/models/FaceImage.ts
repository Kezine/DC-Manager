import { Entity, Props } from "./Entity";

/** Image de façade partagée (bibliothèque). Référencée par les équipements via
    face_image_id / face_image_rear_id, etc. */
export class FaceImage extends Entity {
  /** Nom de l'image dans la bibliothèque. */
  name: string;
  /** Hauteur de panneau compatible (U) — éligible seulement sur les équipements du même nombre de U.
      INAPPLICABLE pour la face « autre » (faces annexes des boîtiers libres) : forcé à 1. */
  u_height: number;
  /** Face d'éligibilité : "front" | "rear" | "autre" (faces annexes des équipements libres). */
  face: string;
  /** L'image inclut-elle les OREILLES de montage 19″ ? `true` → rendue sur corps + oreilles (largeur panneau
      19″) ; `false` → corps seul (largeur U). Le placement des ports reste sur le corps dans les deux cas.
      SEULE la face AVANT peut avoir des oreilles (défaut `true`) ; arrière et « autre » → TOUJOURS `false`. */
  with_ears: boolean;
  /** Données image (data URL JPEG/PNG/WebP). */
  data: string;

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.face = (p.face === "rear") ? "rear" : (p.face === "autre" ? "autre" : "front");
    // « autre » (annexe d'un boîtier libre) : pas de notion de U ni d'oreilles 19″.
    this.u_height = (this.face === "autre") ? 1 : Math.max(1, parseInt(p.u_height, 10) || 1);
    // seule l'AVANT peut avoir des oreilles (défaut avec) ; arrière et « autre » → jamais.
    this.with_ears = (this.face === "front") ? (p.with_ears !== false) : false;
    this.data = p.data || "";
  }
}
