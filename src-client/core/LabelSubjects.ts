/* ============================================================================
   LABELSUBJECTS — préparation de la MATIÈRE d'une étiquette imprimable depuis
   un enregistrement du modèle (lot E, cf. docs/qr-scan.md § « Étiquettes
   imprimables »). Les points d'entrée (fiche équipement/baie/câble/spare,
   action de ligne) appellent CES constructeurs plutôt que de composer chacun
   leur `LabelSubject` — la règle « qu'imprime-t-on pour un X ? » est écrite UNE
   fois (principe n°3).

   Le store n'est PAS importé : un LECTEUR minimal (`get`) est injecté — patron
   des modules `core/` (cf. VmLocate, PowerAnalysis). Les libellés composés
   suivent l'anatomie de la maquette :
     · équipement : emplacement = « <baie> · U18–U19 » (ou la salle en pose
       libre), type = famille + marque/modèle ;
     · baie : « Salle » = la salle porteuse, type = « Baie <N>U » ;
     · câble : extrémités A/B = « <équipement> · <port> », le SENS A → B est
       l'ORDRE DE LA FICHE (from → to, décision du cadrage E) ;
     · faisceau (trunk) : MÊME anatomie que le câble — extrémités A/B = les deux
       PATCHS terminaux (cf. docs/faisceaux.md, contrainte T11 : ce sont des
       équipements, pas des ports), type = fibre + capacité + longueur ;
     · spare : désignation affichée, emplacement = lieu de stockage.
   Un champ vide reste vide — la ligne correspondante est ABSENTE de l'étiquette
   (décision « owner vide → ligne absente », généralisée par LabelHtml).
   ============================================================================ */

import type { LabelSubject } from "./LabelHtml";
import { EquipmentTypes } from "../registries/EquipmentTypes";
import { SpareTypes } from "../domain/SpareTypes";
import { I18n } from "../i18n/I18n";

/** Lecture minimale du store — le seul besoin de ces constructeurs. */
export interface LabelSubjectReader {
  get(collection: string, id: string): any;
}

export class LabelSubjects {
  /** Étiquette d'un ÉQUIPEMENT : nom, « baie · U » (ou salle), type + marque/modèle,
      n° de série, propriétaire (champ `owner` du lot E1). */
  static equipment(reader: LabelSubjectReader, eq: any): LabelSubject {
    let location = "";
    if ((eq.placement_mode === "rack" || eq.placement_mode === "side" || eq.placement_mode === "wall") && eq.rack_id) {
      const rack: any = reader.get("racks", eq.rack_id);
      if (rack) {
        const height = eq.u_height || 1;
        const uSpan = (eq.placement_mode === "rack" && eq.rack_u)
          ? "U" + eq.rack_u + (height > 1 ? "–U" + (eq.rack_u + height - 1) : "")
          : "";
        location = [rack.name || "", uSpan].filter(Boolean).join(" · ");
      }
    } else if (eq.dc_id) {
      const room: any = reader.get("datacenters", eq.dc_id);
      location = room ? (room.name || "") : "";
    }
    return {
      collection: "equipments", id: eq.id,
      name: eq.name || "",
      location,
      typeLabel: [EquipmentTypes.label(eq.type), [eq.brand, eq.model].filter(Boolean).join(" ")].filter(Boolean).join(" · "),
      serial: eq.serial || "",
      owner: eq.owner || "",
    };
  }

  /** Étiquette DE la baie (gabarit « Baie ») : nom, salle porteuse, « Baie <N>U ». */
  static rack(reader: LabelSubjectReader, rack: any): LabelSubject {
    const room: any = rack.datacenter_id ? reader.get("datacenters", rack.datacenter_id) : null;
    return {
      collection: "racks", id: rack.id,
      name: rack.name || "",
      location: room ? (room.name || "") : "",
      typeLabel: I18n.t("labels.subject.rackType", { u: rack.u_count || "?" }),
    };
  }

  /** Drapeau/manchon d'un CÂBLE : identifiant, extrémités A/B (« équipement · port »,
      dans l'ordre de la fiche), type + longueur. */
  static cable(reader: LabelSubjectReader, cable: any): LabelSubject {
    const end = (portId: string | null): string => {
      const port: any = portId ? reader.get("ports", portId) : null;
      if (!port) return "";
      const eq: any = reader.get("equipments", port.equipment_id);
      return [(eq && eq.name) || "?", port.name || "?"].join(" · ");
    };
    const cableType: any = cable.cable_type_id ? reader.get("cableTypes", cable.cable_type_id) : null;
    return {
      collection: "cables", id: cable.id,
      name: cable.name || "",
      endA: end(cable.from_port_id),
      endB: end(cable.to_port_id),
      typeLabel: [cableType ? cableType.name : "", cable.length_m != null ? cable.length_m + " m" : ""].filter(Boolean).join(" · "),
    };
  }

  /** Drapeau/manchon d'un FAISCEAU (trunk) : identifiant, extrémités A/B, type de fibre.
      Un faisceau n'a PAS de ports d'extrémité (ses brins sont piochés par les ports des
      patchs) : ses bouts sont les deux ÉQUIPEMENTS patch (`endpoint_*_equipment_id`,
      contrainte T11) — d'où un libellé d'extrémité réduit au nom du patch, sans « · port ».
      Le type agrège fibre + CAPACITÉ (la donnée utile au bout d'un trunk : combien de brins
      y passent) + longueur. */
  static bundle(reader: LabelSubjectReader, bundle: any): LabelSubject {
    const patch = (equipmentId: string | null): string => {
      const eq: any = equipmentId ? reader.get("equipments", equipmentId) : null;
      return eq ? (eq.name || "") : "";
    };
    const fiberType: any = bundle.cable_type_id ? reader.get("cableTypes", bundle.cable_type_id) : null;
    return {
      collection: "cableBundles", id: bundle.id,
      name: bundle.name || "",
      endA: patch(bundle.endpoint_a_equipment_id),
      endB: patch(bundle.endpoint_b_equipment_id),
      typeLabel: [
        fiberType ? fiberType.name : "",
        bundle.fiber_count != null ? I18n.t("detail.bundle.strandCount", { count: bundle.fiber_count }) : "",
        bundle.length_m != null ? bundle.length_m + " m" : "",
      ].filter(Boolean).join(" · "),
    };
  }

  /** Étiquette d'un SPARE (gabarit S par défaut) : désignation, lieu de stockage,
      type, n° de série. */
  static spare(_reader: LabelSubjectReader, spare: any): LabelSubject {
    return {
      collection: "spares", id: spare.id,
      name: (spare.displayName ? spare.displayName() : spare.name) || "",
      location: spare.storage_location || "",
      typeLabel: [SpareTypes.label(spare.type), [spare.brand, spare.model_pn].filter(Boolean).join(" ")].filter(Boolean).join(" · "),
      serial: spare.serial || "",
    };
  }
}
