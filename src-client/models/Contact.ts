import { Entity, Props } from "./Entity";

/** CONTACT — destinataire de NOTIFICATIONS (email/sms), tenu PAR DOCUMENT (carnet d'adresses).
    Vit HORS du graphe réseau : ni placé, ni câblé, ni référencé par aucune autre entité du
    document. Le module serveur notify/ lit ses coordonnées pour router une alerte — il fait
    `repo.getOne("contacts", id)` (cf. cadrage notifications 2026-07-14 §2, décision Q4 :
    contacts PAR DOCUMENT). Le lien abonnement→contact est une RÉFÉRENCE SOUPLE (`contact_id`
    vit dans la config notify, HORS document) : c'est pourquoi il n'existe AUCUNE cascade de
    suppression pour cette collection (rien dans le document ne pointe vers un contact). */
export class Contact extends Entity {
  /** Nom / libellé du contact (REQUIS — seul champ obligatoire). */
  name: string;
  /** Adresse e-mail (optionnelle) — cible d'une notification « email ». */
  email: string;
  /** Numéro de téléphone (optionnel) — cible d'une notification « sms ». Texte quasi libre. */
  phone: string;
  /** Notes libres (optionnelles). */
  notes: string;

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.email = p.email || "";
    this.phone = p.phone || "";
    this.notes = p.notes || "";
  }
}
