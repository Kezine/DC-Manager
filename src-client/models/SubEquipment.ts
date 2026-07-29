import { Entity, Props } from "./Entity";
import type { Records } from "../../src-shared/DataValidation";

/** Sous-équipement : contenu LOGIQUE d'un équipement maître (drive d'une librairie à bandes, carte d'un
    châssis, module d'un backplane…). Il n'a **aucune existence physique propre** — ni placement, ni
    dimension, ni port, ni type : c'est son maître qui la lui donne, et la sémantique vit dans le NOM.

    ⚠ Ce que cette classe NE porte PAS est délibéré (cf. la spec partagée `subEquipments`). Un
    sous-équipement n'est jamais dessiné (`RenderImpact` = `none`), jamais localisable, jamais une
    extrémité de câble, jamais un conteneur de placement. Ne pas lui ajouter de champ spatial « pour plus
    tard » : ce serait rouvrir exactement ce que la collection séparée referme.

    ⚠ Hiérarchie PLATE : un sous-équipement n'en contient pas d'autres (arbitrage utilisateur). */
export class SubEquipment extends Entity implements Records.SubEquipment {
  /** Nom d'affichage — porte la sémantique (« Drive LTO-8 n°2 »), puisqu'il n'y a pas de champ `type`. */
  name: string;
  /** FK → equipments : le MAÎTRE. Obligatoire — sans lui l'objet n'a aucune existence. */
  equipment_id: string;
  /** Description libre. */
  description: string;
  /** FK → groups : groupe PRIMAIRE (parité Equipment / Vm). `null` = aucun. TOUJOURS ∈ `group_ids`. */
  group_id: string | null;
  /** FK[] → groups : TOUS les groupes (primaire + secondaires) — parité Equipment / Vm. */
  group_ids: string[];

  constructor(p: Props = {}) {
    super(p);
    // TRIMÉ à la construction, comme `Equipment.name` : le modèle en mémoire porte toujours l'identité
    // propre, avant même la re-sauvegarde qui nettoie le stocké (parité avec la normalisation partagée).
    this.name = (p.name || "").trim();
    this.equipment_id = p.equipment_id || "";
    this.description = p.description || "";
    // GROUPES : parité STRICTE avec Equipment et Vm — le primaire est TOUJOURS membre de group_ids
    // (invariant partagé), en TÊTE de liste. Pas de migration legacy à prévoir ici (la collection est
    // neuve, aucun enregistrement ne peut porter `group_id` seul), mais on garde la MÊME forme : c'est
    // elle qui garantit l'invariant, et diverger « parce que ce cas ne peut pas arriver » est le genre
    // d'écart qui rend deux specs jumelles subtilement différentes.
    this.group_id = p.group_id || null;
    let gids: string[] = Array.isArray(p.group_ids) ? p.group_ids.filter((x: any) => typeof x === "string" && x) : [];
    if (this.group_id) gids = [this.group_id, ...gids.filter((x) => x !== this.group_id)];
    this.group_ids = [...new Set(gids)];
  }
}
