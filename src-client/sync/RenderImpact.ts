import { EntityRegistry } from "../models";

/* ============================================================================
   CARTE D'IMPACT DE RENDU — collection → coût de reconstruction de la scène 3D.

   Quand un autre client modifie le document (notification SSE en mode REST), on
   ne veut PAS tout reconstruire si rien de dessiné en 3D n'a changé. Cette carte
   associe à chaque collection l'impact d'une de ses modifications sur la scène 3D
   du Datacenter (le seul rendu réellement coûteux).

   Règle de classification : CONSERVATRICE — dans le doute,
   `geometry`. Un faux `geometry` ne coûte qu'un rebuild inutile (lent mais correct) ;
   un faux `none` laisse des données fausses à l'écran (rapide mais FAUX).
   ============================================================================ */

/** Impact d'un changement de collection sur la scène 3D DESSINÉE.
 *  - `none`     : aucun mesh/couleur/texture 3D ne dépend de cette collection.
 *  - `recolor`  : seules des COULEURS dessinées changent (recoloration en place possible).
 *  - `geometry` : des meshes/labels/textures changent → reconstruction complète requise. */
export type ThreeImpact = "none" | "recolor" | "geometry";

/** Impact 3D par collection. EXHAUSTIF sur `EntityRegistry.COLLECTIONS` (cf. test d'invariant). */
export const COLLECTION_THREE_IMPACT: Record<string, ThreeImpact> = {
  // ----- Physique : dessiné en 3D → reconstruction géométrique -----
  datacenters: "geometry",   // sol, murs, grille, décor de salle
  racks:       "geometry",   // baies (coque, capots, montants), position/orientation
  rackItems:   "geometry",   // occupants pseudo-éléments (caches/blanking plates, brosses)
  equipments:  "geometry",   // occupants rackés + équipements libres + ports + labels
  ports:       "geometry",   // connecteurs de port (position, couleur câblé/libre)
  cables:      "geometry",   // tubes de câble (spline, extrémités, éclairs power)
  cableBundles: "geometry",  // tracés de FAISCEAU (trunk uplink↔uplink : endpoints, route, tube épais)
  waypoints:   "geometry",   // pins, brosses, OOB, segments de routage
  floors:      "geometry",   // décor d'étage multi-salles
  sites:       "geometry",   // labels de bâtiment du décor multi-salles (siteLabel)
  portTypes:   "geometry",   // taille des connecteurs dessinés (Store.portConnectorSize → portTypes)
  cableTypes:  "geometry",   // éclairs power (kind === "power") le long des câbles

  // ----- Couleur dessinée seulement -----
  networks:    "recolor",    // couleur des câbles 3D (cableColor → réseau principal)
  groups:      "recolor",    // couleur des occupants rackés (group.color)

  // ----- Hors 3D : jamais dessiné (vues liste / graphe / tooltips uniquement) -----
  ipNetworks:   "none",      // adressage — vues liste
  ipAddresses:  "none",      // adressage — vues liste
  dhcpRanges:   "none",      // adressage — vues liste
  spares:       "none",      // inventaire de pièces de rechange — vue liste
  aggregates:   "none",      // agrégats de ports (LAG) — détail/graphe, pas la 3D
  vms:          "none",      // équipements virtuels (VMs) — sous-onglet liste/fiche, jamais rendus en 3D
  contacts:     "none",      // carnet de destinataires des notifications (email/sms) — vue liste, jamais dessiné
};

/** Accès à la carte d'impact de rendu (méthodes statiques regroupées — cf. CLAUDE.md). */
export class RenderImpact {
  /** Ordre de gravité croissante — pour calculer le « pire » impact d'un lot de collections. */
  private static readonly SEVERITY: Record<ThreeImpact, number> = { none: 0, recolor: 1, geometry: 2 };

  /** Renvoie l'impact le PLUS GRAVE des deux (none < recolor < geometry). */
  static worst(left: ThreeImpact, right: ThreeImpact): ThreeImpact {
    return RenderImpact.SEVERITY[left] >= RenderImpact.SEVERITY[right] ? left : right;
  }

  /** Impact 3D d'une collection ; défaut PRUDENT à `geometry` pour une collection inconnue de la carte. */
  static of(collection: string): ThreeImpact {
    return COLLECTION_THREE_IMPACT[collection] ?? "geometry";
  }

  /** Collections de `EntityRegistry` absentes de la carte (doit être vide — vérifié par test d'invariant). */
  static unmapped(): string[] {
    return EntityRegistry.COLLECTIONS.filter((collection) => !(collection in COLLECTION_THREE_IMPACT));
  }
}
