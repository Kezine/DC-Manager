import { Entity, Props } from "./Entity";

/** Image de façade partagée (bibliothèque). Référencée par les équipements via
    face_image_id / face_image_rear_id, etc. */
export class FaceImage extends Entity {
  name: string;
  u_height: number;
  face: string;
  data: string;

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.u_height = Math.max(1, parseInt(p.u_height, 10) || 1);
    this.face = (p.face === "rear") ? "rear" : (p.face === "autre" ? "autre" : "front");
    this.data = p.data || "";
  }
}
