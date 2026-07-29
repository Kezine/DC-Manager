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
   fait mordre : cette clé « salle » rendait `null` pour un équipement posé sur un
   ÉTAGE (doctrine `docs/placement.md` §6.4), si bien que le bouton restait caché
   alors que l'action, elle, aboutit depuis §6.27.
   ⚠ TOUTES LES MENTIONS DU TRIO `equipmentDcId`/`portDcId`/`cableDcId` DANS CE
   FICHIER SONT HISTORIQUES : il a été RETIRÉ du dépôt au lot 7 du chantier
   (doctrine §6.33, décision D5) — elles disent d'où vient la règle, elles ne
   renvoient plus à du code qu'on puisse aller lire.

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

   POUR UNE LIAISON (câble, faisceau), la question n'est pas « ce câble est-il
   placé ? » — un câble n'a pas de placement propre — mais « par QUELLE extrémité
   la vue va-t-elle le cadrer ? ». La réponse est donc un PORT, pas un booléen :
   `cableEnd` rend l'extrémité RETENUE (la première LOCALISABLE, A puis B) et
   `cable` n'est que le constat qu'il en existe une. Écrire le prédicat à part
   aurait recréé la panne que ce module ferme : deux endroits posant la même
   question finissent par y répondre différemment, et l'écart s'appelle un bouton
   MORT (décision D6). `DcInteract.locateCable` consomme donc `cableEnd` — le
   miroir n'est plus VÉRIFIÉ, il est STRUCTUREL.
   ⚠ La priorité A puis B est celle de l'historique `Store.cableDcId`
   (`portDcId(A) || portDcId(B)`), pour que la généralisation ne DÉPLACE pas le
   cadrage d'un câble dont les deux bouts sont placés. Et elle saute une extrémité
   NON localisable au lieu de s'y arrêter : un câble dont le bout A pend dans une
   baie hors salle et dont le bout B est en salle se cadre par B, hier comme
   aujourd'hui.

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
   donc qu'un toast, hier avec `portDcId` comme aujourd'hui avec `portLocatable` :
   ce lot ne crée ni ne referme cet écart, il le NOMME et le verrouille par un
   test. Le refermer
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
  /** L'équipement `eqOrId` (enregistrement OU id — tolérance héritée de l'ancien `Store.equipmentDcId`)
      est-il localisable ? */
  static equipment(eqOrId: any, store: LocatableStore): boolean {
    const eq = (eqOrId && typeof eqOrId === "object") ? eqOrId : store.get("equipments", eqOrId);
    if (!eq) return false;
    return Locatable.ofChain(PlacementContainers.chain(eq, (coll, id) => store.get(coll, id)), store);
  }

  /** Le PORT `portId` est-il localisable ? Même règle que son équipement porteur — un port n'a pas de
      placement propre, il émerge d'une face de son équipement (parité avec l'ancien `Store.portDcId`). */
  static port(portId: string | null, store: LocatableStore): boolean {
    const p = store.get("ports", portId);
    return p ? Locatable.equipment(p.equipment_id, store) : false;
  }

  /** Extrémité RETENUE pour cadrer une LIAISON : le port de la première extrémité LOCALISABLE (A puis B),
      `null` si aucune des deux ne l'est. `cableOrId` = enregistrement OU id (mêmes tolérances que
      l'ancien `Store.cableDcId`) ; convient aussi bien à un câble qu'à toute liaison portant `from_port_id`/
      `to_port_id`.

      ⚠ CETTE MÉTHODE EST LA RÈGLE, `cable` n'en est que le CONSTAT — et c'est ce qui rend le bouton mort
      structurellement impossible. Tant que le prédicat vivait ici et le choix de l'extrémité dans
      `DcInteract`, rien n'obligeait les deux à s'accorder : c'est très exactement ce qui s'était produit
      pour les équipements (le bouton restait caché alors que l'action aboutissait, doctrine §6.28). */
  static cableEnd(cableOrId: any, store: LocatableStore): string | null {
    const c = (cableOrId && typeof cableOrId === "object") ? cableOrId : store.get("cables", cableOrId);
    if (!c) return null;
    if (Locatable.port(c.from_port_id, store)) return String(c.from_port_id);
    if (Locatable.port(c.to_port_id, store)) return String(c.to_port_id);
    return null;
  }

  /** La LIAISON est-elle localisable ? = « existe-t-il une extrémité à cadrer ? ». A généralisé
      `!!Store.cableDcId`, qui ne savait reconnaître qu'une extrémité posée en SALLE. */
  static cable(cableOrId: any, store: LocatableStore): boolean {
    return Locatable.cableEnd(cableOrId, store) !== null;
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
