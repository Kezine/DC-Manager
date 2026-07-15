import { Id } from "../core/Id";

/** Propriétés brutes (désérialisation / formulaires). Typage volontairement
    lâche pendant la migration ; on resserrera entité par entité. */
export type Props = Record<string, any>;

/* =============================================================================
   ENTITÉ DE BASE — id + description + horodatage + clone() + toJSON().
   clone() produit une copie indépendante avec un id frais ; les sous-éléments
   (ports / agrégats) sont clonés séparément par le Store.
   ============================================================================= */
export class Entity {
  id: string;
  description: string;
  created_date: string;
  updated_date: string;

  constructor(props: Props = {}) {
    this.id = props.id || Id.uid();
    this.description = props.description || "";
    this.created_date = props.created_date || Id.nowIso();
    this.updated_date = props.updated_date || this.created_date;
  }

  touch(): void {
    this.updated_date = Id.nowIso();
  }

  /** Copie superficielle + nouvel id ; les classes filles peuvent surcharger
      pour réinitialiser les FK propres à leurs sous-éléments. */
  clone(): this {
    const Ctor = this.constructor as new (p?: Props) => this;
    const copy = new Ctor(this.toJSON());
    copy.id = Id.uid();
    copy.created_date = Id.nowIso();
    copy.updated_date = copy.created_date;
    return copy;
  }

  toJSON(): Props {
    return { ...this };
  }
}
