/* =============================================================================
   ContainerLabel — « comment s'appelle l'endroit où se trouve cet objet ? »

   Classe PURE : aucun DOM, aucun réseau, aucun import de store — le store est
   INJECTÉ par une interface ÉTROITE (patron `PowerAnalysis`/`VmLocate`/
   `Locatable`), donc la règle est testable en isolation.

   POURQUOI CE MODULE (décision D4 du chantier « câblage des équipements
   d'étage », doctrine `docs/placement.md` §6.4 puis §6.29). Six sites de l'app
   nomment l'endroit d'un objet — bulle d'un faisceau, sélecteur d'équipement du
   panneau câbles, sélecteurs d'équipement et d'extrémité des formulaires de
   câble/faisceau, extrémités du mini-graphe de tracé. Tous écrivaient la même
   ligne : `const dc = store.equipmentDcId(x); … dc ? store.dcName(dc) : «non
   placé»`. Or cette clé « salle » PROJETAIT la chaîne d'attache sur son seul
   maillon « salle » : un équipement POSÉ SUR UN ÉTAGE a une chaîne parfaitement
   valide (`floor` → `building`) et se voyait pourtant annoncer « non placé ». Le
   libellé MENTAIT — l'objet est placé, il n'est simplement pas dans une salle.

   ⚠ CE MODULE N'EST PLUS SEULEMENT UN LIBELLÉ, et son nom est en retard sur son
   emploi. `namedOfChain` est LA réponse de l'application à « dans quel conteneur
   ce contenu vit-il ? » : la grammaire de route la consomme (§6.31), le tracé des
   faisceaux aussi, et depuis le retrait du trio historique
   `equipmentDcId`/`portDcId`/`cableDcId` (lot 7, doctrine §6.33) les trois chemins
   SALLE de « Localiser » la lisent puis la RESTREIGNENT (`kind === "room"`). Les
   mentions de ce trio, ici et plus bas, sont donc HISTORIQUES : elles disent d'où
   vient la règle, elles ne renvoient plus à du code existant.

   LA RÈGLE, en trois branches et rien de plus :

     1. la chaîne traverse une SALLE  → c'est ELLE qu'on nomme (« Salle A ») ;
     2. le conteneur IMMÉDIAT est un ÉTAGE → « Bât. X · ét. 1 » ;
     3. sinon (pool, inventaire pur, baie hors salle…) → AUCUN nom (`null`), et
        c'est à l'appelant de décider ce qu'il affiche à la place.

   ⚠ LA BRANCHE 1 SE LIT SUR LA CHAÎNE, PAS SUR LE CONTENEUR IMMÉDIAT — c'est
   tout l'intérêt du module. Le conteneur immédiat d'un serveur monté en baie est
   la BAIE, celui d'un boîtier posé est l'ÉTAGÈRE ; ce que l'utilisateur veut
   lire dans un sélecteur reste « Salle A », exactement ce que `dcName` affichait.
   Rendre `kind` tel quel produirait un nom de baie là où il y avait un nom de
   salle : ce serait une RÉGRESSION déguisée en généralisation.

   ⚠ CE N'EST PAS `Locatable`, ET LES DEUX NE DOIVENT PAS FUSIONNER. `Locatable`
   répond « la vue 3D peut-elle MONTRER cet objet ? » et refuse donc un posé
   d'étage dont le bâtiment n'a aucune salle (la portée d'affichage s'exprime en
   salles, cf. §6.27). Ici la question est « comment s'appelle son endroit ? » :
   elle a une réponse même quand la scène ne sait pas le dessiner, et un
   sélecteur doit la donner. Deux questions, deux modules, aucun drapeau.

   ⚠ CE QUI N'EST DÉLIBÉRÉMENT PAS NOMMÉ : une baie HORS SALLE (chaîne
   `rack` → `building`). Sa chaîne ne traverse aucune salle et son conteneur
   immédiat n'est pas un étage → branche 3, donc `null`, EXACTEMENT comme
   `equipmentDcId` le rendait alors. Nommer son BÂTIMENT serait truthful mais
   changerait un libellé existant, ce que ce lot s'interdit (il est PROSPECTIF :
   aucun équipement d'étage dans les corpus, donc rien ne doit bouger à l'écran).
   Ce choix est un ARBITRAGE, pas un oubli — cf. §6.29.
   ============================================================================= */
import { PlacementContainers } from "../../src-shared/PlacementContainers";
import type { PlacementContainer } from "../../src-shared/PlacementContainers";
import { I18n } from "../i18n/I18n";

/** Interface ÉTROITE du store attendue par ce module — exactement ce qu'il lit, rien de plus.
    `Store` la satisfait STRUCTURELLEMENT (aucune déclaration à ajouter côté store). */
export interface ContainerLabelStore {
  /** Lecture d'un enregistrement par collection ; `null` si absent. Sert de lecteur à la chaîne. */
  get(collection: string, id: string | null | undefined): any;
  /** Nom d'une SALLE. On passe par CE point d'entrée (et non par `get("datacenters")`) pour hériter
      TELS QUELS de ses replis historiques — « (salle) » sans nom, « ? » introuvable — sans les recopier. */
  dcName(dcId: string | null): string;
  /** Libellé d'un SITE (bâtiment) : nom de l'entité → libellé legacy → id. */
  siteLabel(id: string): string;
}

export class ContainerLabel {
  /** Niveau AFFICHABLE d'un étage : un étage vide, absent ou non numérique vaut le niveau 0.
      ⚠ DUPLICATION ASSUMÉE de `FloorLayout.floorNum`, et signalée des deux côtés (principe n°3) :
      l'importer ferait dépendre `core/` de `geometry/` — inversion de couche — pour une normalisation
      d'une ligne, et `geometry/FloorLayout` importe DÉJÀ `core/Normalize` (le cycle de paquets serait
      réel). Un test d'ANTI-DIVERGENCE compare les deux fonctions valeur par valeur ; c'est le même
      compromis que les constantes de baie répliquées (`RackConstants`).
      ⚠ LE PIÈGE `String(f || "")` DU DÉPÔT NE MORD PAS ICI, et c'est MESURÉ (sonde de mutation du lot,
      0 divergence sur 16 valeurs) : cette forme écrase bien `0` en chaîne vide, mais le repli
      `isFinite ? : 0` la ramène aussitôt à 0 — les deux écritures coïncident. Le piège mord en AMONT,
      sur la CLÉ du conteneur (`PlacementContainers.floorKey`), là où "0" et "" doivent rester DEUX
      étages distincts. Ne pas croire ce garde-fou-ci suffisant : ce n'en est pas un. */
  static floorNumber(floor: unknown): number { const n = parseFloat(floor as any); return isFinite(n) ? n : 0; }

  /** Le conteneur que l'utilisateur VOIT nommé, dérivé d'une chaîne d'attache : la SALLE traversée,
      sinon l'ÉTAGE immédiat, sinon `null`. C'est la généralisation exacte de
      `PlacementContainers.roomIdOf` — même verdict sur tous les modes existants, une réponse EN PLUS
      pour le mode `floor` (doctrine §6.29). ⚠ `roomIdOf` a depuis été RETIRÉ avec le trio du store
      (§6.33) : cette méthode n'est plus « la généralisation de », elle est LA règle.

      ⚠ Un site qui a besoin d'un repère SALLE (les trois chemins salle de « Localiser ») lit cette
      méthode et la RESTREINT sur place à `kind === "room"` : c'est l'expression EXACTE de l'ancien
      `PlacementContainers.roomIdOf`, mais écrite là où l'hypothèse se lit — la primitive, elle, a été
      retirée pour que le cas particulier ne repousse pas (§6.33).

      ⚠ L'étage n'est cherché qu'en TÊTE de chaîne, comme dans `Locatable.ofChain` et pour la même
      raison : un maillon `floor` apparaît PLUS LOIN dans la chaîne de tout contenu de salle (il est le
      parent de toute salle), et le prendre ferait nommer « ét. 0 » un serveur parfaitement en salle. */
  static namedOfChain(chain: PlacementContainer[]): PlacementContainer | null {
    if (!chain.length) return null;
    const room = chain.find((c) => c.kind === "room");
    if (room) return room;
    return chain[0].kind === "floor" ? chain[0] : null;
  }

  /** Conteneur NOMMÉ d'un équipement (enregistrement OU id — tolérances héritées de l'ancien
      `Store.equipmentDcId`, dont ce point d'entrée a pris la place). */
  static ofEquipment(eqOrId: any, store: ContainerLabelStore): PlacementContainer | null {
    const eq = (eqOrId && typeof eqOrId === "object") ? eqOrId : store.get("equipments", eqOrId);
    if (!eq) return null;
    return ContainerLabel.namedOfChain(PlacementContainers.chain(eq, (coll, id) => store.get(coll, id)));
  }

  /** Libellé d'un conteneur NOMMÉ, ou `null` s'il n'y en a pas. Les appelants qui affichaient un repli
      (« non placé », « ? », suffixe vide) le gardent CHEZ EUX : ce module ne décide pas de l'absence. */
  static label(container: PlacementContainer | null | undefined, store: ContainerLabelStore): string | null {
    if (!container) return null;
    if (container.kind === "room") return store.dcName(container.id);
    if (container.kind === "floor") {
      // Composition (bâtiment · étage) parce que l'IDENTITÉ d'un étage EST ce couple (doctrine §6.4) :
      // « ét. 1 » seul serait ambigu dès qu'il y a deux bâtiments. Même forme que le récapitulatif d'un
      // pin d'étage (`RackForms`), et même clé d'étage (`dc.common.floorShort`) — on n'invente pas une
      // TROISIÈME convention là où le dépôt en a déjà deux.
      return I18n.t("dc.common.floorInSite", {
        site: store.siteLabel(container.location),
        floor: I18n.t("dc.common.floorShort", { n: ContainerLabel.floorNumber(container.floor) }),
      });
    }
    return null;   // baie / étagère / bâtiment : rien à nommer ici (cf. l'en-tête, arbitrage §6.29)
  }

  /** Raccourci des quatre sites qui n'ont qu'un équipement en main : conteneur nommé PUIS libellé. */
  static ofEquipmentLabel(eqOrId: any, store: ContainerLabelStore): string | null {
    return ContainerLabel.label(ContainerLabel.ofEquipment(eqOrId, store), store);
  }
}
