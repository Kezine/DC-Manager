/* ============================================================================
   VIEW ACCESS — quelle permission de LECTURE ouvre quelle VUE du shell.

   POURQUOI UNE CARTE, ET POURQUOI SI COURTE. Un onglet de LISTING n'a pas besoin
   d'y figurer : sa permission se DÉRIVE de sa collection par la carte PARTAGÉE
   (`Permissions.forCollection(collection, "read")`), et le bootstrap la calcule
   depuis la configuration du listing lui-même (`ListOptions.collection`) — il n'y
   a donc rien à tenir en phase, et un onglet de liste ajouté demain est gaté
   PAR CONSTRUCTION. Restent les vues qui ne sont PAS un listing de collection :
   la vue Datacenter (2D/3D), la Netmap, la bibliothèque d'images de façade et les
   pages d'administration des modules amovibles. Celles-là nomment leur permission
   ici, une fois, et un test relit les SOURCES de `app/main.ts` pour échouer en
   nommant toute vue déclarée sans entrée (même philosophie que le verrou
   d'exhaustivité des routes serveur : la liste est DÉCOUVERTE, jamais déclarée —
   un manifeste écrit à la main serait aveugle au cas visé).

   ⚠ Ce sont des permissions de LECTURE : elles décident de la VISIBILITÉ de la
   vue, pas de ce qu'on peut y faire. Les gestes d'écriture sont gatés à part, au
   plus près de leur affordance (cf. docs/auth.md § « Gating côté client »).

   Module PUR (aucun DOM) — testé dans `Tests/modules/test-client-access.js`.
   ============================================================================ */
import { Permissions } from "../../src-shared/Permissions";

export class ViewAccess {
  /** VUE DU SHELL (non-listing) → permission ATOMIQUE de lecture qui la rend accessible.
      Les valeurs appartiennent toutes au catalogue partagé (vérifié par test — une coquille
      masquerait la vue pour tout le monde, en silence). */
  static readonly VIEW_PERMISSIONS: Readonly<Record<string, string>> = {
    /** Vue Datacenter (3D, plan de salle, plan d'étage) : le CONTENANT spatial, plus ses réglages
        (`meta`) et ses fonds de plan (`images`) — tous rattachés à `dc.site`. */
    datacenter: "dc.site:read",
    /** Netmap : la topologie des équipements et de leurs liaisons. Le grain reste COARSE (v1) —
        l'équipement est la porte d'entrée du graphe, sans lui il n'y a rien à tracer. */
    graph: "dc.equipment:read",
    /** Bibliothèque d'images de façade : la pseudo-collection `images` du document, rattachée à
        `dc.site` par la carte partagée (cf. `Permissions.PSEUDO_COLLECTION_DOMAINS`). */
    faceimages: "dc.site:read",
    /** Sous-onglet « Clusters » de l'onglet VMs : l'état de synchro par provider. `vm:read` est
        VOLONTAIREMENT la même permission que la lecture de la collection `vms` (cf. docs/auth.md § 3). */
    clusters: "vm:read",
    interventions: "interventions:read",
    certificats: "certs:read",
    /** Page d'administration des notifications : sa LECTURE. Les écritures (canaux, abonnements,
        test d'envoi) demandent en plus `notify:manage`, gaté dans la vue. */
    notifications: "notify:read",
  };

  /** Permission de lecture d'une vue NON-listing, ou null si la vue n'est pas dans la carte
      (un listing : sa permission se dérive de sa collection, cf. `readPermissionOfCollection`). */
  static readPermissionOf(view: string): string | null {
    return ViewAccess.VIEW_PERMISSIONS[String(view)] || null;
  }

  /** Permission de lecture d'un onglet de LISTING — dérivée de la carte PARTAGÉE, jamais d'une table
      locale. null = collection hors carte (le test d'invariant partagé garantit que ça n'arrive pas
      pour une collection du schéma). */
  static readPermissionOfCollection(collection: string): string | null {
    return Permissions.forCollection(collection, "read");
  }

  /** Les permissions nommées par la carte (contrôle de catalogue côté test). */
  static permissions(): string[] { return Object.values(ViewAccess.VIEW_PERMISSIONS); }
}
