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

   AUTORITÉ DE LA CONDITION 3 — `Store.equipmentLocatable`, et rien d'autre. C'est
   le prédicat qui fait foi dans toute l'application (listing des équipements,
   fiche équipement, tableau des ports, contenu d'une baie, recherche de la vue
   Datacenter) ; il DÉLÈGUE à `core/Locatable`, seule écriture de la règle. On ne
   la réimplémente surtout pas ici : une deuxième règle de localisabilité
   divergerait au premier mode de placement ajouté — c'est exactement ce qui
   s'était produit avec les sept copies de `!!equipmentDcId(x)`.
   Ce qu'il rend, mode par mode (verrouillé par le test d'ÉQUIVALENCE de
   `core/Locatable` : prédicat vrai ⟺ « Localiser » programme une cible caméra) :
     - monté en baie (`rack` + `rack_u`) posée en salle . . . . . . . localisable
     - libre POSITIONNÉ en salle (`dc_id`) . . . . . . . . . . . . . localisable
     - marge/paroi (`side`/`wall`) d'une baie en salle . . . . . . . localisable
     - posé sur une étagère d'une baie en salle  . . . . . . . . . . localisable
     - posé sur un ÉTAGE, bâtiment ayant AU MOINS UNE SALLE  . . . . localisable
     - posé sur un ÉTAGE, bâtiment SANS AUCUNE SALLE  . . . . . NON localisable
     - libre SANS `dc_id` (inventaire pur) . . . . . . . . . . . NON localisable
     - « pool » d'une baie (`rack_id` SANS `rack_u`) . . . . . . NON localisable
     - baie hôte elle-même HORS salle . . . . . . . . . . . . . NON localisable

   ⚠ LE CAS ÉTAGE A CHANGÉ (doctrine `docs/placement.md` §6.27 puis §6.28). Cet
   en-tête affirmait qu'il rendait `null` « PAR CONCEPTION » et qu'il n'y avait là
   rien à corriger : c'était vrai tant que « Localiser » ne savait viser qu'une
   salle. `DcInteract` cadre désormais un posé d'étage en MONDE, donc le bouton
   s'affiche — et une VM hébergée sur un équipement d'étage devient localisable.
   Reste NON localisable le posé d'un bâtiment SANS AUCUNE SALLE : la portée
   d'affichage s'exprime en salles, l'action refuse, le bouton reste caché.

   ⚠ Ne pas confondre les numérotations de lots : le « lot 2 » que citait cet
   en-tête était celui du chantier CONTENEUR DE PLACEMENT (la délégation de
   `equipmentDcId` à `src-shared/PlacementContainers`), sans rapport avec le lot 2
   du chantier « câblage des équipements d'étage » qui a écrit ces lignes.

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
  /** L'équipement est-il localisable en 3D ? Autorité unique (cf. en-tête) — ce module ne sait PAS, et ne
      doit pas savoir, ce qui rend un équipement localisable ; il traduit seulement « localiser une VM » en
      « localiser son hôte ». L'interface reste donc à DEUX méthodes, exactement ce qu'il lit. */
  equipmentLocatable(eqOrId: any): boolean;
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
    // 3. localisable ? On passe l'ENREGISTREMENT déjà lu (et non l'id) : `equipmentLocatable` accepte les
    //    deux, et cela évite une seconde lecture d'index à chaque ligne du listing.
    return store.equipmentLocatable(host) ? hostId : null;
  }
}
