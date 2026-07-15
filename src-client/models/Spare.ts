import { Entity, Props } from "./Entity";
import { SpareTypes } from "../domain/SpareTypes";
import { SpareStatuses } from "../domain/SpareStatuses";
import { SPARE_DISK_TYPES } from "../domain/constants";

/** Pièce de rechange (spare) — suivi UNITAIRE, hors graphe réseau (ni placée, ni câblée).
    Champs communs + champs spécifiques par type (HDD · SSD · transceiver · autre). */
export class Spare extends Entity {
  /** Type principal : "hdd" | "ssd" | "transceiver" | "other". */
  type: string;
  /** Désignation libre (sinon dérivée du type/modèle à l'affichage). */
  name: string;
  brand: string;          // marque / fabricant
  model_pn: string;       // modèle / part-number
  serial: string;         // n° de série (suivi unitaire / RMA)

  /** Statut : "available" | "assigned" | "decommissioned". */
  status: string;
  assigned_equipment_id: string | null;   // affecté à un équipement du modèle (FK)
  assigned_free: string;                   // OU attribution libre (utilisateur / équipement hors gestion)
  assigned_date: string;                   // date d'attribution (ISO court), posée à la bascule "assigned"

  // administratif (tous types)
  purchase_date: string;
  po_ref: string;                          // réf. bon de commande
  storage_location: string;                // emplacement de stockage (texte libre)
  comment: string;

  // --- HDD / SSD (groupe « disque ») ---
  capacity_value: number | null;
  capacity_unit: string;  // "GB" | "TB"
  interface: string;      // SATA / SAS / NVMe / SCSI…
  form_factor: string;    // 3.5" / 2.5" / M.2 / U.2…
  rpm: number | null;     // HDD uniquement (vitesse de rotation)

  // --- Transceiver ---
  tx_form: string;        // SFP / SFP+ / QSFP28…
  tx_speed: string;       // 1G / 10G / 100G…
  tx_media: string;       // LC / RJ45 / DAC…
  tx_reach: string;       // portée / longueur d'onde (texte libre : SR, LR, 1310nm, 10km…)

  // --- Other ---
  specs: string;          // caractéristiques en texte libre

  constructor(p: Props = {}) {
    super(p);
    this.type = SpareTypes.isType(p.type) ? p.type : SpareTypes.DEFAULT;
    this.name = p.name || "";
    this.brand = p.brand || "";
    this.model_pn = p.model_pn || "";
    this.serial = p.serial || "";
    this.status = SpareStatuses.isStatus(p.status) ? p.status : SpareStatuses.DEFAULT;
    this.assigned_equipment_id = p.assigned_equipment_id || null;
    this.assigned_free = p.assigned_free || "";
    this.assigned_date = p.assigned_date || "";
    this.purchase_date = p.purchase_date || "";
    this.po_ref = p.po_ref || "";
    this.storage_location = p.storage_location || "";
    this.comment = p.comment || "";
    this.capacity_value = (p.capacity_value != null && p.capacity_value !== "") ? +p.capacity_value : null;
    this.capacity_unit = p.capacity_unit || "GB";
    this.interface = p.interface || "";
    this.form_factor = p.form_factor || "";
    this.rpm = (p.rpm != null && p.rpm !== "") ? +p.rpm : null;
    this.tx_form = p.tx_form || "";
    this.tx_speed = p.tx_speed || "";
    this.tx_media = p.tx_media || "";
    this.tx_reach = p.tx_reach || "";
    this.specs = p.specs || "";
  }

  /** Désignation d'affichage : le nom s'il existe, sinon dérivée (marque/modèle + résumé technique). */
  displayName(): string {
    if (this.name) return this.name;
    const bits = [this.brand, this.model_pn].filter(Boolean).join(" ");
    const tech = this.techSummary();
    return [bits, tech].filter(Boolean).join(" · ") || SpareTypes.label(this.type);
  }

  /** Le spare est-il un disque (HDD/SSD) — groupe de champs commun. */
  isDisk(): boolean { return SPARE_DISK_TYPES.includes(this.type); }

  /** Résumé technique court selon le type (pour la liste / la désignation auto). */
  techSummary(): string {
    if (this.isDisk()) {
      const cap = this.capacity_value != null ? this.capacity_value + " " + this.capacity_unit : "";
      return [cap, this.interface, this.form_factor, (this.type === "hdd" && this.rpm) ? this.rpm + " rpm" : ""].filter(Boolean).join(" · ");
    }
    if (this.type === "transceiver") {
      return [this.tx_form, this.tx_speed, this.tx_media, this.tx_reach].filter(Boolean).join(" · ");
    }
    return this.specs || "";
  }
}
