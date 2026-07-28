/* =============================================================================
   VmLocate — « cette VM est-elle localisable en 3D, et sur QUOI ? »

   Classe PURE : aucun DOM, aucun réseau, aucun import de store — le store est
   INJECTÉ par une interface ÉTROITE (patron `PowerAnalysis`), donc la règle est
   testable en isolation.

   POURQUOI CE MODULE. Une VM n'a AUCUNE existence dans la scène 3D : elle n'a ni
   position, ni conteneur de placement (cf. `docs/placement.md`). Ce qu'on peut
   localiser, c'est son HÔTE — l'équipement physique qui l'exécute, rapproché par
   la synchro dans `vms.host_equipment_id` (cf. `docs/vm-proxmox.md`, « Frontière
   SOURCE / LOCAUX »). « Localiser une VM » signifie donc, très exactement,
   « localiser son hôte », et cette traduction est la seule chose que fait ce
   module.

   VERSION « SOBRE » (choix utilisateur) : le bouton n'est proposé QUE si la
   localisation peut ABOUTIR. Jamais de bouton grisé, jamais de bouton qui
   n'ouvrirait qu'un toast d'erreur. Trois conditions, toutes nécessaires :
     1. la VM porte un `host_equipment_id` (elle a été rapprochée d'un équipement) ;
     2. cet équipement EXISTE encore dans le document (la référence peut pendre :
        la synchro pose ce champ, rien ne garantit que l'équipement survit) ;
     3. cet équipement est RÉELLEMENT localisable.

   AUTORITÉ DE LA CONDITION 3 — `Store.equipmentDcId`, et rien d'autre. C'est le
   prédicat qui fait foi dans toute l'application (listing des équipements, fiche
   équipement, recherche de la vue Datacenter) ; il DÉLÈGUE depuis le lot 2 à la
   chaîne de conteneurs `src-shared/PlacementContainers`. On ne le réimplémente
   surtout pas ici : une deuxième règle de localisabilité divergerait au premier
   mode de placement ajouté.
   Ce qu'il rend, mode par mode (verrouillé par les tests de `PlacementContainers`) :
     - monté en baie (`rack` + `rack_u`) posée en salle . . . . la salle  → localisable
     - libre POSITIONNÉ en salle (`dc_id`) . . . . . . . . . . . la salle  → localisable
     - marge/paroi (`side`/`wall`) d'une baie en salle . . . . . la salle  → localisable
     - posé sur une étagère d'une baie en salle  . . . . . . . . la salle  → localisable
     - libre SANS `dc_id` (inventaire pur) . . . . . . . . . . . `null`    → NON localisable
     - « pool » d'une baie (`rack_id` SANS `rack_u`) . . . . . . `null`    → NON localisable
     - baie hôte elle-même HORS salle . . . . . . . . . . . . . `null`    → NON localisable
     - posé sur un ÉTAGE (`placement_mode: "floor"`)  . . . . . `null`    → NON localisable

   ⚠ LE CAS ÉTAGE REND `null` PAR CONCEPTION, ce n'est pas un défaut à corriger
   ici : un équipement d'étage n'est dans aucune salle, et la vue « Localiser »
   ne sait viser qu'une salle. En version sobre, le bouton ne s'affiche alors pas.
   Le rendre localisable (et câblable) est un chantier À PART, cadré dans
   `docs/placement.md` §6.4.

   FEATURE VM AMOVIBLE : supprimer l'inventaire VM = supprimer ce fichier + le
   `locateTarget` de l'onglet VMs (`app/main.ts`) + le bouton de `DetailForms.vmDetail`
   (cf. `docs/vm-proxmox.md`, § Suppression de la feature).
   ============================================================================= */

/** Vue MINIMALE d'une VM — le module ne dépend NI du modèle `Vm`, NI du store.
    Forme TOLÉRANTE : les enregistrements viennent d'une synchro tierce. */
export interface VmLocateVm {
  /** Équipement hôte RAPPROCHÉ par la synchro (champ DÉRIVÉ, re-résolu à chaque passe). */
  host_equipment_id?: string | null;
}

/** Interface ÉTROITE du store attendue par ce module — exactement ce qu'il lit, rien de plus.
    `Store` la satisfait STRUCTURELLEMENT (aucune déclaration à ajouter côté store). */
export interface VmLocateStore {
  /** Lecture d'un enregistrement par collection ; `null` si absent. */
  get(collection: string, id: string | null | undefined): any;
  /** Salle (datacenter_id) d'un équipement — `null` = non localisable. Autorité unique (cf. en-tête). */
  equipmentDcId(eqOrId: any): string | null;
}

export class VmLocate {
  /** Id de l'équipement à VISER pour « Localiser » cette VM, ou `null` si la VM n'est pas localisable.

      Rendre l'ID CIBLE plutôt qu'un booléen n'est pas un détail : les deux appelants (listing et fiche)
      ont besoin de la MÊME valeur — le listing pour savoir s'il propose l'action ET sur quoi il la
      déclenche, la fiche pour la même chose. Un prédicat booléen aurait laissé la résolution de la cible
      se ré-écrire de chaque côté, donc diverger. */
  static hostEquipmentId(vm: VmLocateVm | null | undefined, store: VmLocateStore): string | null {
    const raw = vm ? vm.host_equipment_id : null;
    const hostId = typeof raw === "string" ? raw.trim() : "";
    if (!hostId) return null;                                  // 1. VM jamais rapprochée à un équipement
    const host = store.get("equipments", hostId);
    if (!host) return null;                                    // 2. référence PENDANTE (hôte supprimé du document)
    // 3. localisable ? On passe l'ENREGISTREMENT déjà lu (et non l'id) : `equipmentDcId` accepte les deux,
    //    et cela évite une seconde lecture d'index à chaque ligne du listing.
    return store.equipmentDcId(host) ? hostId : null;
  }
}
