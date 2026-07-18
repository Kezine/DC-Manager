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
  /** Audit « qui » posé PAR LE SERVEUR en mode API (id canonique de l'auteur — cf. docs/user-resolver.md).
      OPTIONNELS : absents en mode fichier (aucune identité) et sur les enregistrements legacy. Le client ne
      les émet JAMAIS lui-même (le serveur les écrase à chaque écriture) ; il les préserve seulement au
      round-trip pour l'affichage (lot 3). */
  created_by?: string;
  updated_by?: string;

  constructor(props: Props = {}) {
    this.id = props.id || Id.uid();
    this.description = props.description || "";
    this.created_date = props.created_date || Id.nowIso();
    this.updated_date = props.updated_date || this.created_date;
    // Préservés au round-trip UNIQUEMENT s'ils existent (posés serveur) : ne pas les fabriquer côté client.
    if (props.created_by !== undefined) this.created_by = props.created_by;
    if (props.updated_by !== undefined) this.updated_by = props.updated_by;
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
    // Un clone est un enregistrement NEUF, encore jamais persisté : il n'a pas d'auteur (le serveur
    // l'estampillera à la création). On efface donc l'audit hérité de l'original.
    delete copy.created_by;
    delete copy.updated_by;
    return copy;
  }

  toJSON(): Props {
    return { ...this };
  }
}
