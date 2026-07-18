import type { Store } from "../store";
import type { CtxItem } from "../ui/ContextMenu";
import { I18n } from "../i18n/I18n";

/* =============================================================================
   VERROU DE PLACEMENT (`locked`) — SOURCE UNIQUE de vérité, partagée par toutes
   les vues, menus contextuels, panneaux et formulaires (principe n°3 : un seul
   endroit, jamais dupliqué). Concept normalisé pour racks / equipments /
   waypoints.

   Sémantique : une entité VERROUILLÉE ne peut, DEPUIS LES VUES 2D/3D, être ni
   DÉPLACÉE (glisser, outil de positionnement), ni PIVOTÉE, ni RETIRÉE de son
   conteneur (baie · salle · étagère · étage). Les FORMULAIRES restent
   l'échappatoire délibérée (CLAUDE.md principe n°10 : tout attribut éditable
   sans les vues 2D/3D) : ils exposent la case à cocher qui pose/retire le
   verrou et laissent modifier le placement. Le verrou NE bloque PAS la
   suppression (action destructive distincte, derrière sa propre confirmation).

   Convention visuelle : icône cadenas 🔒/🔓 (réemploi de la convention du
   verrouillage de DOCUMENT — RestDocuments — pour la cohérence). NB : ce
   `locked`-ci est au niveau ENTITÉ (portée distincte du `locked` de DocMeta).
   ============================================================================= */

/** Collections dont le placement est verrouillable (les seules à porter le flag `locked`). */
export const PLACEMENT_LOCKABLE: ReadonlySet<string> = new Set(["racks", "equipments", "waypoints"]);

export class PlacementLock {
  /** L'entité est-elle verrouillée ? Prédicat PUR, tolère null/undefined. */
  static isLocked(entity: any): boolean { return !!(entity && entity.locked); }

  /** Idem, résolu par (collection, id) via le store. */
  static isLockedRef(store: Store, collection: string, id: string | null | undefined): boolean {
    return !!id && this.isLocked(store.get(collection, id));
  }

  /** La collection est-elle concernée par le verrou de placement ? */
  static isLockable(collection: string): boolean { return PLACEMENT_LOCKABLE.has(collection); }

  /** Libellé de l'action de bascule (texte SEUL — l'icône cadenas est posée par l'appelant,
      côté vue : PlacementLock est du domaine et n'importe pas `ui/Icons`). */
  static toggleLabel(locked: boolean): string {
    return locked ? I18n.t("domain.placementLock.unlock") : I18n.t("domain.placementLock.lock");
  }

  /** Raison affichée sur une action bloquée par le verrou (title d'un item/bouton grisé). GETTER (et non
      constante) : la localisation n'est initialisée qu'au bootstrap, donc le texte est résolu À L'ACCÈS
      (au point de rendu), jamais au chargement du module. */
  static get BLOCKED_HINT(): string { return I18n.t("domain.placementLock.blockedHint"); }

  /** Écrit le flag inverse et renvoie le nouvel état (null si l'entité a disparu). */
  static async toggle(store: Store, collection: string, id: string): Promise<boolean | null> {
    const o: any = store.get(collection, id); if (!o) return null;
    const next = !o.locked;
    await store.update(collection, id, { locked: next });
    return next;
  }

  /** Item de menu contextuel « Verrouiller / Déverrouiller le positionnement » prêt à l'emploi.
      Normalise l'entrée des menus rack / équipement / waypoint (un seul `items.push(...)`).
      `onDone` est rappelé après l'écriture (re-render de la vue appelante). */
  static ctxItem(store: Store, collection: string, id: string, onDone: () => void): CtxItem {
    const locked = this.isLockedRef(store, collection, id);
    return { label: this.toggleLabel(locked), action: async () => { await this.toggle(store, collection, id); onDone(); } };
  }
}
