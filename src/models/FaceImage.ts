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
      Défaut (si non précisé) DÉPEND DE LA FACE : avant = avec oreilles, arrière = sans. Forcé à `false` pour
      la face « autre » (annexe, sans oreilles). */
  with_ears: boolean;
  /** Données image (data URL JPEG/PNG/WebP). */
  data: string;

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.face = (p.face === "rear") ? "rear" : (p.face === "autre" ? "autre" : "front");
    // « autre » (annexe d'un boîtier libre) : pas de notion de U ni d'oreilles 19″.
    this.u_height = (this.face === "autre") ? 1 : Math.max(1, parseInt(p.u_height, 10) || 1);
    // défaut dépendant de la face : avant = avec oreilles · arrière = sans ; « autre » = jamais d'oreilles.
    this.with_ears = (this.face === "autre") ? false : (p.with_ears === true ? true : p.with_ears === false ? false : this.face !== "rear");
    this.data = p.data || "";
  }
}
