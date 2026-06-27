import { DocumentChangeset } from "./Changeset";
import { ThreeImpact, RenderImpact, COLLECTION_THREE_IMPACT } from "./RenderImpact";

/* ============================================================================
   PLANIFICATEUR DE RECHARGEMENT — du changeset au plan d'actions.

   Module PUR (aucun DOM, aucun réseau) : transforme un `DocumentChangeset` (ce qui
   a changé) en `ReloadPlan` (ce que le client doit reconstruire). Pur = testable
   isolément (cf. Tests/modules/run.js, section « sync »).

   C'est l'unique endroit où vit la décision « faut-il reconstruire la 3D ? ». Le
   risque de SOUS-INVALIDATION (ne pas reconstruire alors qu'il le fallait) est donc
   concentré ici et couvert par des tests — plutôt que dispersé en `if` dans main.ts.
   ============================================================================ */

/** Plan d'actions de rechargement déduit d'un changeset. */
export interface ReloadPlan {
  /** Collections à re-tirer du serveur (rechargement granulaire). `null` = tout le document (repli :
      import/snapshot/conflit). Liste ciblée → `Store.reloadCollections` ne re-tire QUE celles-ci. */
  refetchCollections: string[] | null;
  /** Niveau de reconstruction requis pour la scène 3D Datacenter. */
  threeRebuild: ThreeImpact;
  /** La méta-document (nom…) doit être relue. */
  refreshMeta: boolean;
  /** Le miroir d'images de façade doit être rechargé (métadonnées). */
  refreshImages: boolean;
}

export class ReloadPlanner {
  /** `impactByCollection` injectable (tests) ; défaut = la carte de production. */
  constructor(private readonly impactByCollection: Record<string, ThreeImpact> = COLLECTION_THREE_IMPACT) {}

  /** Impact 3D d'une collection selon la carte injectée (défaut prudent `geometry` si inconnue). */
  private threeImpactOf(collection: string): ThreeImpact {
    return this.impactByCollection[collection] ?? RenderImpact.of(collection);
  }

  /** Calcule le plan de rechargement pour un changeset donné. */
  plan(changeset: DocumentChangeset): ReloadPlan {
    // Périmètre indéterminé (import/snapshot/inconnu) → rechargement total + reconstruction complète.
    if (changeset.full) {
      return { refetchCollections: null, threeRebuild: "geometry", refreshMeta: true, refreshImages: true };
    }

    // Pire impact 3D parmi les collections touchées. Les images de façade sont des TEXTURES dessinées :
    // un changement d'image impose au moins une reconstruction (le cache de textures par id évite, lui,
    // de re-décoder les images inchangées — cf. P3).
    let threeRebuild: ThreeImpact = changeset.images ? "geometry" : "none";
    for (const collection of changeset.collections) {
      threeRebuild = RenderImpact.worst(threeRebuild, this.threeImpactOf(collection));
    }

    return {
      // Rechargement granulaire : on ne re-tire QUE les collections touchées (cf. Store.reloadCollections).
      refetchCollections: changeset.collections.slice(),
      threeRebuild,
      refreshMeta: changeset.meta,
      refreshImages: changeset.images,
    };
  }
}
