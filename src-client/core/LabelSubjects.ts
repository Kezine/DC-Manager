/* ============================================================================
   LABELSUBJECTS — préparation de la MATIÈRE d'une étiquette imprimable depuis
   un enregistrement du modèle (lot E, cf. docs/qr-scan.md § « Étiquettes
   imprimables »). Les points d'entrée (fiche équipement/baie/câble/spare,
   action de ligne, panier) appellent CES constructeurs plutôt que de composer
   chacun leur `LabelSubject` — la règle « qu'imprime-t-on pour un X ? » est
   écrite UNE fois (principe n°3).

   🚨 T10 (2026-09-02, décisions Q10.A/B/C) : chaque sujet DÉCLARE ses champs
   imprimables (`LabelFieldDecl` — id stable, libellé localisé, valeur composée,
   coché par défaut, registre typographique). C'est le remède au retour terrain
   « les étiquettes de spares/sous-équipements ne reprennent pas les bonnes
   infos » : le modèle figé {emplacement, type, série, propriétaire} ne savait
   nommer ni les caractéristiques par type d'un spare ni son achat. Corollaire
   STRUCTUREL (Q10.C) : un champ à valeur VIDE n'est PAS déclaré — la case
   n'existe pas, la ligne non plus (l'ancien « owner vide → ligne absente »,
   devenu la règle de construction).

   Le store n'est PAS importé : un LECTEUR minimal (`get`) est injecté — patron
   des modules `core/` (cf. VmLocate, PowerAnalysis). Les contenus par sujet :
     · équipement : emplacement = « <baie> · U18–U19 » (ou la salle en pose
       libre), type = famille + marque/modèle, série, propriétaire (lot E1) —
       offres et défauts STRICTEMENT ceux d'avant T10 (décision explicite) ;
     · baie : emplacement = la salle porteuse, type = « Baie <N>U » — idem ;
     · câble : extrémités A/B STRUCTURELLES (« <équipement> · <port> », le SENS
       A → B est l'ORDRE DE LA FICHE — from → to, décision du cadrage E), type ;
     · faisceau (trunk) : MÊME anatomie que le câble — extrémités A/B = les deux
       PATCHS terminaux (cf. docs/faisceaux.md, contrainte T11 : ce sont des
       équipements, pas des ports), type = fibre + capacité + longueur ;
     · spare (contenu ARBITRÉ T10, tout coché sauf mention) : type
       (SpareTypes), CARACTÉRISTIQUES par type (une seule case — disque :
       capacité/interface/format/rpm ; transceiver : forme/débit/média/portée ;
       autre : specs libres — la composition est `Spare.techSummary()`, source
       unique réutilisée, jamais recomposée ici), marque + modèle, série, achat
       (date · BC), stockage (offert mais DÉCOCHÉ — le retirer serait une
       régression, décision notée au registre). Statut/attribution : PAS
       déclarés (décision) ;
     · sous-équipement : maître · repère (`slot` — l'ancien emplacement),
       marque + modèle, série, achat — tous cochés. PAS la garantie
       (`warranty_end` exclu, décision T10 explicite).
   ============================================================================ */

import type { LabelSubject, LabelFieldDecl, LabelFieldStyle } from "./LabelHtml";
import { EquipmentTypes } from "../registries/EquipmentTypes";
import { SpareTypes } from "../domain/SpareTypes";
import { I18n } from "../i18n/I18n";

/** Lecture minimale du store — le seul besoin de ces constructeurs. */
export interface LabelSubjectReader {
  get(collection: string, id: string): any;
}

/** Libellé de case — catalogue `labels.field.*` (fr ET en, verrou test-i18n). */
const fieldLabel = (key: string): string => I18n.t("labels.field." + key);

export class LabelSubjects {
  /** Pousse une déclaration — SEULEMENT si la valeur composée est non vide
      (décision Q10.C : « pas de case sans donnée » est STRUCTUREL). */
  private static declare(fields: LabelFieldDecl[], id: string, labelKey: string, value: string,
    checked: boolean, style: LabelFieldStyle, flags?: { hideOnSmall?: boolean; qrOnly?: boolean }): void {
    const trimmed = String(value || "").trim();
    if (!trimmed) return;
    fields.push({ id, label: fieldLabel(labelKey), value: trimmed, checked, style, ...(flags || {}) });
  }

  /** Valeur « achat » partagée spare/sous-équipement : date · BC (mêmes composants que la
      fiche — `detail.common.poRef`), derrière un préfixe qui la rend lisible seule sur
      une étiquette (« Achat 2026-01-15 · BC 4471 »). */
  private static purchaseValue(record: any): string {
    const info = [
      record.purchase_date || "",
      record.po_ref ? I18n.t("detail.common.poRef", { ref: record.po_ref }) : "",
    ].filter(Boolean).join(" · ");
    return info ? I18n.t("labels.subject.purchase", { info }) : "";
  }

  /** Étiquette d'un ÉQUIPEMENT : nom, « baie · U » (ou salle), type + marque/modèle,
      n° de série, propriétaire (champ `owner` du lot E1). Défauts INCHANGÉS par T10 :
      emplacement seul coché ; type/série suppr. au registre S (héritage — rien d'autre
      que nom + emplacement n'y tenait) ; propriétaire = la bande du contenu « QR seul ». */
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
    const fields: LabelFieldDecl[] = [];
    LabelSubjects.declare(fields, "location", "location", location, true, "loc");
    LabelSubjects.declare(fields, "type", "type",
      [EquipmentTypes.label(eq.type), [eq.brand, eq.model].filter(Boolean).join(" ")].filter(Boolean).join(" · "),
      false, "meta", { hideOnSmall: true });
    LabelSubjects.declare(fields, "serial", "serial", eq.serial ? "SN " + eq.serial : "", false, "sn", { hideOnSmall: true });
    LabelSubjects.declare(fields, "owner", "owner", eq.owner || "", false, "own", { qrOnly: true });
    return { collection: "equipments", id: eq.id, name: eq.name || "", fields };
  }

  /** Étiquette DE la baie (gabarit « Baie ») : nom, salle porteuse, « Baie <N>U ».
      Défauts INCHANGÉS par T10 : les deux cases cochées. */
  static rack(reader: LabelSubjectReader, rack: any): LabelSubject {
    const room: any = rack.datacenter_id ? reader.get("datacenters", rack.datacenter_id) : null;
    const fields: LabelFieldDecl[] = [];
    LabelSubjects.declare(fields, "location", "location", room ? (room.name || "") : "", true, "loc");
    LabelSubjects.declare(fields, "type", "type", I18n.t("labels.subject.rackType", { u: rack.u_count || "?" }), true, "meta", { hideOnSmall: true });
    return { collection: "racks", id: rack.id, name: rack.name || "", fields };
  }

  /** Drapeau/manchon d'un CÂBLE : identifiant, extrémités A/B STRUCTURELLES
      (« équipement · port », dans l'ordre de la fiche), type + longueur (coché). */
  static cable(reader: LabelSubjectReader, cable: any): LabelSubject {
    const end = (portId: string | null): string => {
      const port: any = portId ? reader.get("ports", portId) : null;
      if (!port) return "";
      const eq: any = reader.get("equipments", port.equipment_id);
      return [(eq && eq.name) || "?", port.name || "?"].join(" · ");
    };
    const cableType: any = cable.cable_type_id ? reader.get("cableTypes", cable.cable_type_id) : null;
    const fields: LabelFieldDecl[] = [];
    LabelSubjects.declare(fields, "type", "type",
      [cableType ? cableType.name : "", cable.length_m != null ? cable.length_m + " m" : ""].filter(Boolean).join(" · "),
      true, "meta");
    return {
      collection: "cables", id: cable.id,
      name: cable.name || "",
      endA: end(cable.from_port_id),
      endB: end(cable.to_port_id),
      fields,
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
    const fields: LabelFieldDecl[] = [];
    LabelSubjects.declare(fields, "type", "type", [
      fiberType ? fiberType.name : "",
      bundle.fiber_count != null ? I18n.t("detail.bundle.strandCount", { count: bundle.fiber_count }) : "",
      bundle.length_m != null ? bundle.length_m + " m" : "",
    ].filter(Boolean).join(" · "), true, "meta");
    return {
      collection: "cableBundles", id: bundle.id,
      name: bundle.name || "",
      endA: patch(bundle.endpoint_a_equipment_id),
      endB: patch(bundle.endpoint_b_equipment_id),
      fields,
    };
  }

  /** Étiquette d'un SOUS-ÉQUIPEMENT (gabarit S par défaut, comme le spare) — contenu
      arbitré T10 : maître · repère (`slot`, texte libre — « Étagère A / baie 3 »),
      marque + modèle, n° de série, achat. Tous cochés.

      ⚠ PAS la garantie : `warranty_end` est EXCLU de l'étiquette (décision T10
      explicite — c'est une donnée de suivi, pas un repère de terrain). Et pas de
      `type` métier, contrairement au spare : la collection n'en a pas (sa spec dit
      que « la SÉMANTIQUE est dans le nom ») — on ne fabrique PAS de substitut. */
  static subEquipment(reader: LabelSubjectReader, subEquipment: any): LabelSubject {
    const master: any = subEquipment.equipment_id ? reader.get("equipments", subEquipment.equipment_id) : null;
    const fields: LabelFieldDecl[] = [];
    LabelSubjects.declare(fields, "master", "master",
      [master ? (master.name || "") : "", subEquipment.slot || ""].filter(Boolean).join(" · "), true, "loc");
    LabelSubjects.declare(fields, "brandModel", "brandModel", [subEquipment.brand, subEquipment.model].filter(Boolean).join(" "), true, "meta");
    LabelSubjects.declare(fields, "serial", "serial", subEquipment.serial ? "SN " + subEquipment.serial : "", true, "sn");
    LabelSubjects.declare(fields, "purchase", "purchase", LabelSubjects.purchaseValue(subEquipment), true, "meta");
    return { collection: "subEquipments", id: subEquipment.id, name: subEquipment.name || "", fields };
  }

  /** Étiquette d'un SPARE (gabarit S par défaut) — contenu arbitré T10 : type,
      caractéristiques PAR TYPE, marque + modèle, n° de série, achat (tous cochés) ;
      stockage OFFERT mais DÉCOCHÉ. La composition des caractéristiques est
      `Spare.techSummary()` (modèle) : la règle « disque = capacité · interface ·
      format · rpm / transceiver = forme · débit · média · portée / autre = specs »
      y est déjà écrite pour le listing et la désignation auto — on la RÉUTILISE
      (principe n°3), champs vides simplement omis par elle. */
  static spare(_reader: LabelSubjectReader, spare: any): LabelSubject {
    const fields: LabelFieldDecl[] = [];
    LabelSubjects.declare(fields, "type", "spareType", SpareTypes.isType(spare.type) ? SpareTypes.label(spare.type) : "", true, "meta");
    LabelSubjects.declare(fields, "characteristics", "characteristics",
      typeof spare.techSummary === "function" ? spare.techSummary() : "", true, "loc");
    LabelSubjects.declare(fields, "brandModel", "brandModel", [spare.brand, spare.model_pn].filter(Boolean).join(" "), true, "meta");
    LabelSubjects.declare(fields, "serial", "serial", spare.serial ? "SN " + spare.serial : "", true, "sn");
    LabelSubjects.declare(fields, "purchase", "purchase", LabelSubjects.purchaseValue(spare), true, "meta");
    LabelSubjects.declare(fields, "storage", "storage", spare.storage_location || "", false, "loc");
    return {
      collection: "spares", id: spare.id,
      name: (spare.displayName ? spare.displayName() : spare.name) || "",
      fields,
    };
  }
}
