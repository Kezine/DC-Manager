/* =============================================================================
   Locatable — « cet objet est-il LOCALISABLE dans la vue Datacenter ? »

   Classe PURE : aucun DOM, aucun réseau, aucun import de store — le store est
   INJECTÉ par une interface ÉTROITE (patron `PowerAnalysis`/`VmLocate`), donc la
   règle est testable en isolation.

   POURQUOI CE MODULE EXISTE. Sept sites de l'application commandent l'AFFICHAGE
   d'un bouton « Localiser » (listings, fiche équipement, tableau de ports, fiche
   faisceau, contenu d'une baie, panneau de recherche 3D, « Localiser une VM »).
   Ils écrivaient tous la même question sous la forme `!!store.equipmentDcId(x)` —
   sept copies d'une règle qui ne demandait qu'à diverger. Le dépôt s'en est déjà
   fait mordre : `equipmentDcId` rend `null` pour un équipement posé sur un ÉTAGE
   (doctrine `docs/placement.md` §6.4), si bien que le bouton restait caché alors
   que l'action, elle, aboutit depuis §6.27.

   VERSION « SOBRE » (choix utilisateur, cf. `VmLocate`) : on ne propose le bouton
   QUE si la localisation peut ABOUTIR. Jamais de bouton grisé, jamais de bouton
   qui n'ouvrirait qu'un toast d'erreur. Ce module est donc, très exactement, le
   MIROIR des refus de `DcInteract.locateEquipment` / `locatePort` — c'est ce
   qu'exige la décision D6 du chantier « câblage des équipements d'étage », et
   c'est ce qu'un test d'ÉQUIVALENCE verrouille (prédicat vrai ⟺ « Localiser »
   programme une cible caméra), mode de placement par mode de placement.

   LA RÈGLE, en deux branches et rien de plus :

     1. la chaîne de conteneurs traverse une SALLE  → localisable
        (baie posée en salle, libre en salle, marge/paroi, posé sur étagère…) ;
     2. le conteneur IMMÉDIAT est un ÉTAGE          → localisable SI ce bâtiment
        a au moins une SALLE.

   ⚠ POURQUOI LA CONDITION 2 N'EST PAS « la chaîne a un conteneur ». Un posé
   d'étage se cadre en MONDE, en Vue étage — mais la PORTÉE d'affichage de cette
   vue s'exprime en SALLES (`visibleDcIds`) : le plan d'étage d'un bâtiment n'est
   émis que si une de ses salles est affichée. Un bâtiment SANS AUCUNE SALLE ne
   peut donc pas entrer dans la scène, et `DcInteract.locateFloorEquip` REFUSE par
   un toast plutôt que de cadrer le vide (limite assumée, §6.27). Répondre `true`
   ici rouvrirait exactement le bouton mort que D6 ferme. Cette limite tombera le
   jour où la portée s'exprimera en BÂTIMENTS — un lot à part ; ce module et
   `scopeFloorBuilding` posent alors la MÊME question au MÊME endroit
   (`Store.roomsOfBuilding`), donc ils cesseront de refuser ensemble.

   ⚠ CE N'EST PAS UNE QUESTION DE REPÈRE, et ce module n'a donc rien à faire dans
   `src-client/geometry/` (borne §6.6) : il ne compose aucune transformée, il
   demande « la vue peut-elle MONTRER cet objet ? ». Le fait « ce bâtiment a-t-il
   une salle ? » est une donnée du MODÈLE, lue par le store injecté.

   ⚠ LIMITE CONNUE, MESURÉE, ET ANTÉRIEURE À CE MODULE (0 occurrence dans les deux
   corpus) : un équipement LIBRE rattaché à une salle mais SANS `dc_x`/`dc_y` est
   jugé localisable ici — c'est bien ce que fait `locateEquipment`, qui replie sur
   la demi-empreinte (§6.13) — alors que `Resolver3D.resolveFaceAnchor3D` refuse
   de résoudre ses PORTS (garde `dc_x == null`) et que la scène 3D ne le dessine
   pas (`buildFreeEquip` l'ignore). Le bouton « Localiser » d'un tel PORT n'ouvre
   donc qu'un toast, avec `portDcId` comme avec `portLocatable` : ce lot ne crée
   ni ne referme cet écart, il le NOMME et le verrouille par un test. Le refermer
   demande de trancher où l'on dessine un libre non positionné — hors périmètre.
   ============================================================================= */
import { PlacementContainers } from "../../src-shared/PlacementContainers";
import type { PlacementContainer } from "../../src-shared/PlacementContainers";

/** Interface ÉTROITE du store attendue par ce module — exactement ce qu'il lit, rien de plus.
    `Store` la satisfait STRUCTURELLEMENT (aucune déclaration à ajouter côté store). */
export interface LocatableStore {
  /** Lecture d'un enregistrement par collection ; `null` si absent. Sert aussi de lecteur à la chaîne. */
  get(collection: string, id: string | null | undefined): any;
  /** SALLES d'un bâtiment. La PORTÉE d'affichage de la Vue étage s'exprime en salles : c'est la MÊME
      question que pose `DcInteract.scopeFloorBuilding` avant d'accepter de cadrer un posé d'étage. */
  roomsOfBuilding(location: string | null): any[];
}

export class Locatable {
  /** L'équipement `eqOrId` (enregistrement OU id, comme `Store.equipmentDcId`) est-il localisable ? */
  static equipment(eqOrId: any, store: LocatableStore): boolean {
    const eq = (eqOrId && typeof eqOrId === "object") ? eqOrId : store.get("equipments", eqOrId);
    if (!eq) return false;
    return Locatable.ofChain(PlacementContainers.chain(eq, (coll, id) => store.get(coll, id)), store);
  }

  /** Le PORT `portId` est-il localisable ? Même règle que son équipement porteur — un port n'a pas de
      placement propre, il émerge d'une face de son équipement (parité avec `Store.portDcId`). */
  static port(portId: string | null, store: LocatableStore): boolean {
    const p = store.get("ports", portId);
    return p ? Locatable.equipment(p.equipment_id, store) : false;
  }

  /** La règle NUE, sur une chaîne de conteneurs déjà calculée (du conteneur IMMÉDIAT à la racine, telle
      que `PlacementContainers.chain` la produit). Exposée pour être éprouvée sans store réel, et pour que
      les deux entrées ci-dessus n'en soient que des adaptateurs.

      ⚠ Le conteneur ÉTAGE n'est cherché qu'en TÊTE de chaîne, et c'est volontaire : c'est le conteneur
      IMMÉDIAT que `locateFloorEquip` interroge (`equipmentContainer(e).kind === "floor"`), donc le miroir
      doit interroger le même. Un maillon `floor` peut en effet apparaître PLUS LOIN dans la chaîne — il
      est le parent de toute salle — mais ce cas est déjà rendu `true` par la branche 1. */
  static ofChain(chain: PlacementContainer[], store: LocatableStore): boolean {
    if (!chain.length) return false;                                 // « pool », inventaire pur : aucun conteneur
    if (chain.some((c) => c.kind === "room")) return true;           // 1. la chaîne traverse une salle
    const immediat = chain[0];
    if (immediat.kind !== "floor") return false;                     // baie hors salle, étagère d'une baie hors salle…
    return store.roomsOfBuilding(immediat.location).length > 0;      // 2. étage : la portée doit pouvoir l'atteindre
  }
}
