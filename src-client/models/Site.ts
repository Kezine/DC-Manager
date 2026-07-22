import { Entity, Props } from "./Entity";
import type { Records } from "../../src-shared/DataValidation";

/** SITE (anciennement « location » / bâtiment) — entité de PREMIER niveau de la hiérarchie physique :
    Site › Étage (floors) › Salle (datacenters) › Baie (racks) › Équipement.
    Son `id` est la valeur référencée par le champ `location` des autres entités (datacenters, floors,
    racks, equipments, waypoints). Remplace l'ancienne constante figée LOCATIONS (qui sert encore de
    libellé de repli pour les ids legacy via Store.siteLabel). */
export class Site extends Entity implements Records.Site {
  /** Nom affiché du site (ex. « Liège »). */
  name: string;
  /** Adresse postale (texte libre). */
  address: string;

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.address = p.address || "";
    // `description` est porté par Entity.
  }
}
