/* =============================================================================
   ListTargets — le FILTRE CIBLE unifié des listings (lot 3, fusion du TODO
   « filtre cible unifié »).

   Un listing peut être filtré par une ENTITÉ du modèle plutôt que par une valeur
   d'énumération : « les adresses IP de SW-Coeur », « les câbles de SW-Coeur ».
   La liste des cibles possibles est LONGUE, CROISSANTE et à libellés composés —
   donc un `SearchPop`, jamais un `<select>` par famille (principe n°14, même
   règle que `FormControls.entityPicker`). La barre de filtres accueille ce
   contrôle sous forme de dimension « à RECHERCHE » (cf. `ui/FilterBar`), et la
   valeur choisie repart en CHIP retirable comme n'importe quel filtre.

   Ce module fabrique les DESCRIPTEURS (un par listing) : recherche des candidats,
   libellé d'affichage, badge de famille, et les deux hooks DONNÉES que la source
   de lignes consomme (`where` serveur / `restrict` client, cf.
   `core/StoreListRowSource`). Le Store est INJECTÉ ; aucune vue n'est importée.

   CONVENTION DE VALEUR : « <kind>:<id> » — la MÊME que les liens d'intervention
   (`core/TargetSearch.key`/`parse`), pour que la dimension « à recherche » ait un
   seul encodage dans toute l'app.
   ============================================================================= */
import type { Store } from "../store";
import { type TargetSearchItem } from "../core/TargetSearch";
import type { ListTargetResolver } from "../core/StoreListRowSource";
import { EntityCandidates, EntityCandidateSource, type EntityCandidateFamily, type EntitySearchReader } from "../core/EntityCandidates";
import { I18n } from "../i18n/I18n";

/** Descripteur COMPLET d'une dimension CIBLE : l'habillage (libellés, badge, recherche) + le contrat
    DONNÉES hérité (`where`/`restrict`). Un listing en déclare zéro ou un (mono-cible en v1). */
export interface ListTargetFilter extends ListTargetResolver {
  /** Libellé de la DIMENSION (chip « Porteur : SW-Coeur »). */
  label: string;
  /** Repli du champ de recherche du SearchPop. */
  placeholder: string;
  /** Candidats d'une saisie — familles CONFONDUES, déjà triés par pertinence et bornés. ASYNCHRONE
      (norme n°15) : en mode API, ils viennent du SERVEUR (recherche transverse, au-delà du corpus
      chargé) ; en mode fichier, du cache LOCAL (promesse résolue). Cf. `core/EntityCandidateSource`.
      `excluded` (clés « famille:id » à écarter) est FACULTATIF et sans emploi pour une dimension de
      FILTRE, qui est mono-valeur : il sert à un ÉDITEUR de liens MULTI-valeurs qui consommerait le
      MÊME descripteur et devrait en déduire les cibles déjà liées. */
  search(query: string, excluded?: ReadonlySet<string>): Promise<TargetSearchItem[]>;
  /** Libellé d'AFFICHAGE d'une cible choisie (chip) — null si elle a disparu du document. */
  labelOf(kind: string, id: string): string | null;
  /** Badge de FAMILLE d'un résultat (`tag` du SearchPop) — "" pour n'en afficher aucun. */
  tagOf(kind: string): string;
}

/** Une famille cherchable d'un descripteur : son slug, sa collection et le repli de libellé. */
interface TargetFamily {
  kind: string;
  collection: string;
  /** Clé i18n du nom de repli d'un enregistrement sans nom. */
  fallbackKey: string;
  /** Clé i18n du badge de famille (`tag` du SearchPop). */
  tagKey: string;
}

export class ListTargets {
  /** Nombre maximal de candidats proposés au SearchPop — même plafond que l'éditeur de liens
      d'intervention (au-delà, on affine la saisie plutôt que de dérouler une liste illisible).
      CENTRALISÉ dans `core/EntityCandidates` depuis que la source de candidats est partagée (lot 4). */
  static readonly SEARCH_LIMIT = EntityCandidates.SEARCH_LIMIT;

  private static readonly EQUIPMENT: TargetFamily = { kind: "equipment", collection: "equipments", fallbackKey: "lists.ph.equipment", tagKey: "lists.filter.targetEquipment" };
  private static readonly VM: TargetFamily = { kind: "vm", collection: "vms", fallbackKey: "lists.ph.vm", tagKey: "lists.filter.targetVm" };
  private static readonly SUB_EQUIPMENT: TargetFamily = { kind: "sub_equipment", collection: "subEquipments", fallbackKey: "subEquipment.fallback", tagKey: "lists.filter.targetSubEquipment" };

  /** Descripteur GÉNÉRIQUE « cible pointée par une FK DIRECTE, parmi plusieurs familles » : la collection
      filtrée porte une colonne `<kind>_id` par famille (patron `ipAddresses`/`applications` = equipment_id/vm_id,
      repris par `attachments` = equipment_id/sub_equipment_id) → `where` serveur et restriction cliente sont
      STRUCTURELLEMENT identiques d'une famille à l'autre : seule la LISTE des familles et les LIBELLÉS
      changent. GÉNÉRALISÉ (paramètre `families`) depuis l'ancien `equipmentOrVmByFk` codé en dur pour
      equipment/vm — dupliquer le bloc aurait laissé les copies diverger au premier ajustement de la garde
      « famille inconnue ». Le champ FK dérive de la CONVENTION `<kind>_id` (equipment→equipment_id,
      vm→vm_id, sub_equipment→sub_equipment_id) — la même que les couples de colonnes des specs.
      ⚠ COMPORTEMENT INCHANGÉ pour les appelants equipment/vm : `{ [kind + "_id"]: id }` produit exactement
      `{ equipment_id }`/`{ vm_id }`, et la garde « slug non prévu → aucune ligne » est identique. */
  private static byFkFamilies(store: Store, reader: EntitySearchReader | null, families: readonly TargetFamily[], labelKey: string, placeholderKey: string): ListTargetFilter {
    const source = new EntityCandidateSource(store, ListTargets.candidateFamilies(families), reader, ListTargets.SEARCH_LIMIT);
    return {
      label: I18n.t(labelKey),
      placeholder: I18n.t(placeholderKey),
      search: (query) => source.fetch(query),
      labelOf: (kind, id) => ListTargets.labelOf(store, families, kind, id),
      tagOf: (kind) => ListTargets.tagOf(families, kind),
      where: (kind, id) => { const family = families.find((f) => f.kind === kind); return family ? { [family.kind + "_id"]: id } : null; },
      restrict: (rows, kind, id) => {
        // Famille inconnue → AUCUNE ligne (jamais « toutes ») : un slug non prévu ne doit pas se lire
        // comme « pas de filtre » — l'utilisateur verrait un filtre posé sans effet.
        const family = families.find((f) => f.kind === kind);
        if (!family) return [];
        const field = family.kind + "_id";
        return rows.filter((row) => row && row[field] === id);
      },
    };
  }

  /** PORTEUR d'une adresse IP : équipement OU VM. Le lien est une simple colonne (`equipment_id` /
      `vm_id`) → le filtre part au SERVEUR en `where` ; le mode fichier applique le même test en mémoire.
      `reader` (mode API) alimente la recherche de CANDIDATS serveur-pilotée ; null = mode fichier. */
  static ipCarrier(store: Store, reader: EntitySearchReader | null = null): ListTargetFilter {
    return ListTargets.byFkFamilies(store, reader, [ListTargets.EQUIPMENT, ListTargets.VM], "lists.filter.carrier", "lists.filter.carrierPlaceholder");
  }

  /** HÔTE d'une application : équipement OU VM — MÊME structure de lien que le porteur d'une adresse IP
      (deux FK directes exclusives-souples), seule la dimension se libelle « Hébergée sur ». C'est lui qui
      donne « les applications de tel serveur / telle VM » en un clic depuis le listing Applications. */
  static applicationHost(store: Store, reader: EntitySearchReader | null = null): ListTargetFilter {
    return ListTargets.byFkFamilies(store, reader, [ListTargets.EQUIPMENT, ListTargets.VM], "lists.filter.hostedOn", "lists.filter.carrierPlaceholder");
  }

  /** CIBLE d'une pièce jointe : équipement OU sous-équipement (deux FK directes exclusives-souples,
      `equipment_id`/`sub_equipment_id` — décision D2 du cadrage pièces jointes 2026-08-10). MÊME structure
      que le porteur d'une adresse IP, familles différentes : c'est lui qui donne « les pièces jointes de tel
      équipement / tel sous-équipement » en un clic depuis le listing Pièces jointes. */
  static attachmentTarget(store: Store, reader: EntitySearchReader | null = null): ListTargetFilter {
    return ListTargets.byFkFamilies(store, reader, [ListTargets.EQUIPMENT, ListTargets.SUB_EQUIPMENT], "lists.filter.attachedTo", "lists.filter.carrierPlaceholder");
  }

  /** ÉQUIPEMENT MAÎTRE d'un sous-équipement : le rattachement est une simple colonne (`equipment_id`) →
      le filtre part au SERVEUR en `where` (UN saut, colonne INDEXÉE — INDEX_SPEC.subEquipments) ; le mode
      fichier applique le même test en mémoire. Famille UNIQUE (un sous-équipement n'appartient qu'à un
      équipement, jamais à une VM) : `tagOf` rend "" comme `cableEquipment` — un badge répété à chaque ligne
      n'apprendrait rien. C'est le cas SIMPLE du chantier « filtre cible unifié » (à comparer à `cableEquipment`,
      2 sauts) : aucune asymétrie client, `where` toujours mappable.
      `reader` (mode API) alimente la recherche de CANDIDATS serveur-pilotée ; null = mode fichier. */
  static subEquipmentMaster(store: Store, reader: EntitySearchReader | null = null): ListTargetFilter {
    const families = [ListTargets.EQUIPMENT];
    const source = new EntityCandidateSource(store, ListTargets.candidateFamilies(families), reader, ListTargets.SEARCH_LIMIT);
    return {
      label: I18n.t("lists.filter.master"),
      placeholder: I18n.t("lists.filter.equipmentPlaceholder"),
      search: (query) => source.fetch(query),
      labelOf: (kind, id) => ListTargets.labelOf(store, families, kind, id),
      tagOf: () => "",   // famille UNIQUE : un badge répété à chaque ligne n'apprendrait rien
      where: (kind, id) => (kind === "equipment" ? { equipment_id: id } : null),
      restrict: (rows, kind, id) => {
        // Famille inconnue → AUCUNE ligne (jamais « toutes ») : un slug non prévu ne doit pas se lire
        // comme « pas de filtre » — l'utilisateur verrait un filtre posé sans effet.
        if (kind !== "equipment") return [];
        return rows.filter((row) => row && row.equipment_id === id);
      },
    };
  }

  /** ÉQUIPEMENT d'un câble : le rattachement passe par ses PORTS (câble → port → équipement), deux
      SAUTS qu'aucune égalité de colonne n'exprime → `where` toujours null, restriction CLIENTE via
      les index du Store (`cablesOfEquipment`). Asymétrie assumée v1, cf. docs/recherche.md.
      `reader` (mode API) alimente la recherche de CANDIDATS serveur-pilotée ; null = mode fichier. */
  static cableEquipment(store: Store, reader: EntitySearchReader | null = null): ListTargetFilter {
    const families = [ListTargets.EQUIPMENT];
    const source = new EntityCandidateSource(store, ListTargets.candidateFamilies(families), reader, ListTargets.SEARCH_LIMIT);
    return {
      label: I18n.t("lists.col.equipment"),
      placeholder: I18n.t("lists.filter.equipmentPlaceholder"),
      search: (query) => source.fetch(query),
      labelOf: (kind, id) => ListTargets.labelOf(store, families, kind, id),
      tagOf: () => "",   // famille UNIQUE : un badge répété à chaque ligne n'apprendrait rien
      where: () => null,
      restrict: (rows, kind, id) => {
        if (kind !== "equipment") return [];
        // UN seul parcours d'index par filtrage (et non un par ligne) : les câbles de l'équipement
        // sont résolus une fois, les lignes ne font plus qu'un test d'appartenance.
        const cableIds = new Set(store.cablesOfEquipment(id).map((cable: any) => cable.id));
        return rows.filter((row) => row && cableIds.has(row.id));
      },
    };
  }

  /* ---- helpers communs ---- */

  /** Adapte les familles locales (`TargetFamily`) en familles de la source PARTAGÉE (`EntityCandidateFamily`) :
      la RÈGLE DE NOMMAGE (`nameOf` = `name` sinon repli localisé) devient la fonction `label` injectée. */
  private static candidateFamilies(families: readonly TargetFamily[]): EntityCandidateFamily[] {
    return families.map((family) => ({
      kind: family.kind, collection: family.collection, label: (record: any) => ListTargets.nameOf(record, family),
    }));
  }

  /** Libellé d'une cible EXISTANTE, ou null si elle a disparu (chip « supprimé », jamais une erreur). */
  private static labelOf(store: Store, families: readonly TargetFamily[], kind: string, id: string): string | null {
    const family = families.find((f) => f.kind === kind);
    if (!family) return null;
    const record: any = store.get(family.collection, id);
    return record ? ListTargets.nameOf(record, family) : null;
  }

  private static tagOf(families: readonly TargetFamily[], kind: string): string {
    const family = families.find((f) => f.kind === kind);
    return family ? I18n.t(family.tagKey) : "";
  }

  private static nameOf(record: any, family: TargetFamily): string {
    return record.name || I18n.t(family.fallbackKey);
  }
}
