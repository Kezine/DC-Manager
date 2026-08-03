import { DetailForms } from "./DetailForms";
import { SubEquipmentForms } from "./SubEquipmentForms";   // HORS de la chaîne d'héritage (comme FaceEditor) — repassé par façade
import type { Store } from "../../store";
import type { FormHost } from "./shared";
export type { FormHost } from "./shared";

/** Classe MÈRE des formulaires : agrège la chaîne FormBase ← Equipment ← Cable ← Rack ← Ipam ← Detail.
    Surface publique unique (Forms.equipment, Forms.cable, Forms.networkDetail…) ; `this` statique résout ici. */
export class Forms extends DetailForms {
  /** Formulaire de création/édition d'un SOUS-ÉQUIPEMENT. `SubEquipmentForms` vit HORS de la chaîne
      d'héritage (comme `FaceEditor`) ; cette façade lui donne la même surface d'appel que les autres
      formulaires depuis `main.ts`. `equipmentId` = le maître (imposé, jamais choisi dans le formulaire). */
  static subEquipment(store: Store, host: FormHost, equipmentId: string, id: string | null, onSaved?: () => void): void {
    SubEquipmentForms.form(store, host, equipmentId, id, onSaved);
  }
}
