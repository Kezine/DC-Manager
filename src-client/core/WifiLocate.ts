/* =============================================================================
   WifiLocate — « ce client wifi est-il localisable en 3D, et sur QUOI ? »

   Classe PURE : aucun DOM, aucun réseau, aucun import de store — le store est
   INJECTÉ par une interface ÉTROITE (patron `PowerAnalysis`/`VmLocate`), donc la
   règle est testable en isolation.

   POURQUOI CE MODULE. Un client wifi n'a AUCUNE existence dans la scène 3D : ni
   position, ni conteneur de placement (cf. `docs/placement.md`). Ce qu'on peut
   localiser, c'est son POINT D'ACCÈS — l'équipement physique auquel la synchro l'a
   rapproché (`wifiClients.ap_equipment_id`, champ DÉRIVÉ du nom d'AP, cf.
   `docs/wifi-unifi.md`). « Localiser un client wifi » signifie donc, très
   exactement, « localiser son AP », et cette traduction est la seule chose que
   fait ce module.

   ⚠ CE QUE ÇA VEUT DIRE, ET CE QUE ÇA NE VEUT PAS DIRE : on cadre la BORNE, pas
   le client. Un client wifi peut être à trente mètres de son AP, derrière une
   cloison, ou en train de marcher. La localisation répond à « où est la borne qui
   le porte », ce qui est l'information utile en exploitation — jamais à « où est
   l'appareil ». Le libellé du bouton le dit (tooltip « Localiser le point d'accès »).

   VERSION « SOBRE » (même choix que les VMs) : le bouton n'est proposé QUE si la
   localisation peut ABOUTIR. Jamais de bouton grisé, jamais de bouton qui n'ouvrirait
   qu'un toast d'erreur. Trois conditions, toutes nécessaires :
     1. le client porte un `ap_equipment_id` (il a été rapproché d'un équipement) ;
     2. cet équipement EXISTE encore dans le document (la référence peut pendre) ;
     3. cet équipement est RÉELLEMENT localisable.

   AUTORITÉ DE LA CONDITION 3 — `Store.equipmentLocatable`, et rien d'autre. C'est
   le prédicat qui fait foi dans toute l'application ; il DÉLÈGUE à `core/Locatable`,
   seule écriture de la règle. On ne la réimplémente surtout pas ici : une deuxième
   règle de localisabilité divergerait au premier mode de placement ajouté (c'est
   précisément l'histoire des sept copies de `equipmentDcId`, doctrine §6.33).

   FEATURE WIFI AMOVIBLE : supprimer l'inventaire des clients wifi = supprimer ce
   fichier + le `locateTarget` de l'onglet Wifi (`app/main.ts`) + le bouton de
   `DetailForms.wifiClientDetail` (cf. docs/wifi-unifi.md § « Suppression »).
   ============================================================================= */

/** Vue MINIMALE d'un client wifi — le module ne dépend NI du modèle `WifiClient`, NI du store.
    Forme TOLÉRANTE : les enregistrements viennent d'une synchro tierce. */
export interface WifiLocateClient {
  /** Point d'accès RAPPROCHÉ par la synchro (champ DÉRIVÉ, re-résolu à chaque passe). */
  ap_equipment_id?: string | null;
}

/** Interface ÉTROITE du store attendue par ce module — exactement ce qu'il lit, rien de plus.
    `Store` la satisfait STRUCTURELLEMENT (aucune déclaration à ajouter côté store). */
export interface WifiLocateStore {
  /** Lecture d'un enregistrement par collection ; `null` si absent. */
  get(collection: string, id: string | null | undefined): any;
  /** L'équipement est-il localisable en 3D ? Autorité unique (cf. en-tête) — ce module ne sait
      PAS, et ne doit pas savoir, ce qui rend un équipement localisable. */
  equipmentLocatable(eqOrId: any): boolean;
}

export class WifiLocate {
  /** Id de l'équipement à VISER pour « Localiser » ce client, ou `null` s'il n'est pas localisable.

      Rendre l'ID CIBLE plutôt qu'un booléen n'est pas un détail : les deux appelants (listing et
      fiche) ont besoin de la MÊME valeur — le listing pour savoir s'il propose l'action ET sur
      quoi il la déclenche, la fiche pour la même chose. Un prédicat booléen aurait laissé la
      résolution de la cible se ré-écrire de chaque côté, donc diverger. */
  static apEquipmentId(client: WifiLocateClient | null | undefined, store: WifiLocateStore): string | null {
    const raw = client ? client.ap_equipment_id : null;
    const apId = typeof raw === "string" ? raw.trim() : "";
    if (!apId) return null;                                    // 1. client jamais rapproché à un équipement
    const ap = store.get("equipments", apId);
    if (!ap) return null;                                      // 2. référence PENDANTE (AP supprimé du document)
    // 3. localisable ? On passe l'ENREGISTREMENT déjà lu (et non l'id) : `equipmentLocatable`
    //    accepte les deux, et cela évite une seconde lecture d'index à chaque ligne du listing.
    return store.equipmentLocatable(ap) ? apId : null;
  }
}
