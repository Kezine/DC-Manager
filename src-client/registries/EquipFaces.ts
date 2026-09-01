import { EQUIP_FACES, EQUIP_FACE_IDS, EQUIP_ANNEX_FACE_IDS } from "../domain/constants";
import { I18n } from "../i18n/I18n";

/** Registre des faces d'équipement (avant/arrière + 4 annexes des équipements libres). */
export class EquipFaces {
  static readonly ALL = EQUIP_FACES;
  static readonly IDS = EQUIP_FACE_IDS;
  static readonly ANNEX_IDS = EQUIP_ANNEX_FACE_IDS;

  /** Libellé d'une face (inconnu → « Avant »). Résolu au rendu (i18n). */
  static label(id: string): string {
    const f = EQUIP_FACES.find((x) => x.id === id);
    return f ? I18n.t(f.labelKey) : I18n.t("domain.equipFace.front");
  }

  /** Normalise vers une face valide (défaut « front »). */
  static norm(f: string): string { return EQUIP_FACE_IDS.includes(f) ? f : "front"; }

  /** Une face est-elle annexe (dessus/dessous/gauche/droite) ? */
  static isAnnex(f: string): boolean { return EQUIP_ANNEX_FACE_IDS.includes(f); }

  /** Face DIAMÉTRALEMENT opposée (front⇄rear, top⇄bottom, left⇄right).
      Sert quand un demi-tour s'applique à l'objet porteur et non à la face : un équipement monté à
      l'ARRIÈRE d'une baie a sa façade tournée vers l'arrière, donc sa face « avant » se regarde
      depuis l'arrière de la baie (cf. `DcInteract.aimAtPort`). Une face inconnue est normalisée
      d'abord — l'opposé d'un défaut « front » reste donc « rear », jamais `undefined`. */
  static opposite(f: string): string {
    const paires: Record<string, string> = { front: "rear", rear: "front", top: "bottom", bottom: "top", left: "right", right: "left" };
    return paires[EquipFaces.norm(f)];
  }
}
