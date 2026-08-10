import { Entity, Props } from "./Entity";
import type { Records } from "../../src-shared/DataValidation";   // garde-fou de dérive : la classe implémente la forme dérivée de la spec

/** APPLICATION hébergée sur l'infrastructure (GLPI, supervision, app web interne…).
    Vit HORS du graphe réseau : ni placée, ni câblée — c'est un objet d'INVENTAIRE logique.
    Une application vise AU PLUS un hôte : un équipement OU une VM (deux FK nullables à
    exclusivité SOUPLE — invariant de la spec partagée, patron `ipAddresses`, décision D1
    du cadrage 2026-08-10). Supprimer l'hôte DÉTACHE l'application (elle survit « sans
    hôte », cf. Cascade.equipments/vms) ; rien dans le document ne pointe vers une
    application, sa propre règle de cascade est donc vide. NI groupes NI tags (D8). */
export class Application extends Entity implements Records.Application {
  /** Nom de l'application (REQUIS — seul champ obligatoire). */
  name: string;
  /** URL de l'app web (optionnelle, http/https seuls — format `url` de la spec) ; "" = pas d'app web. */
  url: string;
  /** Hôte ÉQUIPEMENT (exclusif avec `vm_id` — exclusivité souple portée par la validation partagée). */
  equipment_id: string | null;
  /** Hôte VM (exclusif avec `equipment_id`). */
  vm_id: string | null;

  constructor(p: Props = {}) {
    super(p);
    this.name = p.name || "";
    this.url = p.url || "";
    this.equipment_id = p.equipment_id || null;
    this.vm_id = p.vm_id || null;
  }
}
