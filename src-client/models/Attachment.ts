import { Entity, Props } from "./Entity";
import type { Records } from "../../src-shared/DataValidation";   // garde-fou de dérive : la classe implémente la forme dérivée de la spec

/** PIÈCE JOINTE d'un élément d'inventaire (convention de prêt, bon de commande, scan, garantie…).
    L'enregistrement ne porte que les MÉTADONNÉES : le BINAIRE vit HORS du document (décisions D1/D4
    du cadrage 2026-08-10 — disque serveur en mode API, IndexedDB + compagnon `.nmfa` en mode
    fichier ; cf. docs/attachments.md et data/AttachmentStore). Cible = UN équipement OU UN
    sous-équipement (D2), deux FK nullables à exclusivité SOUPLE (invariant de la spec partagée,
    patron `applications`). Supprimer la cible SUPPRIME la pièce (D3 — une convention de prêt
    orpheline n'a pas de sens), mais JAMAIS son binaire : la purge des binaires est le travail
    exclusif de la maintenance (D5 — l'undo retrouve un binaire intact). Rien dans le document ne
    pointe vers une pièce jointe : sa propre règle de cascade est vide. */
export class Attachment extends Entity implements Records.Attachment {
  /** Libellé humain de la pièce (REQUIS — « Convention de prêt 2026 »). */
  name: string;
  /** Nom de fichier D'ORIGINE (REQUIS) — sert UNIQUEMENT au téléchargement (jamais dans un chemin, D4/D6). */
  file_name: string;
  /** Type MIME ∈ `Schema.ATTACHMENT_MIME_TYPES` (liste blanche partagée — invariant de la spec). */
  mime: string;
  /** Taille en octets — posée par le SERVEUR à l'upload en mode API (informative en mode fichier). */
  size: number;
  /** Cible ÉQUIPEMENT (exclusive avec `sub_equipment_id` — exclusivité souple portée par la validation partagée). */
  equipment_id: string | null;
  /** Cible SOUS-ÉQUIPEMENT (exclusive avec `equipment_id`). */
  sub_equipment_id: string | null;

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.file_name = p.file_name || "";
    this.mime = p.mime || "";
    this.size = p.size || 0;
    this.equipment_id = p.equipment_id || null;
    this.sub_equipment_id = p.sub_equipment_id || null;
  }
}
