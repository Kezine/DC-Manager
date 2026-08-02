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
import { Schema } from "../../src-shared/Schema";
import { TargetSearch, type TargetSearchItem } from "../core/TargetSearch";
import type { ListTargetResolver } from "../core/StoreListRowSource";
import { I18n } from "../i18n/I18n";

/** Descripteur COMPLET d'une dimension CIBLE : l'habillage (libellés, badge, recherche) + le contrat
    DONNÉES hérité (`where`/`restrict`). Un listing en déclare zéro ou un (mono-cible en v1). */
export interface ListTargetFilter extends ListTargetResolver {
  /** Libellé de la DIMENSION (chip « Porteur : SW-Coeur »). */
  label: string;
  /** Repli du champ de recherche du SearchPop. */
  placeholder: string;
  /** Candidats d'une saisie — familles CONFONDUES, déjà triés par pertinence et bornés. */
  search(query: string): TargetSearchItem[];
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
      d'intervention (au-delà, on affine la saisie plutôt que de dérouler une liste illisible). */
  static readonly SEARCH_LIMIT = 12;

  private static readonly EQUIPMENT: TargetFamily = { kind: "equipment", collection: "equipments", fallbackKey: "lists.ph.equipment", tagKey: "lists.filter.targetEquipment" };
  private static readonly VM: TargetFamily = { kind: "vm", collection: "vms", fallbackKey: "lists.ph.vm", tagKey: "lists.filter.targetVm" };

  /** PORTEUR d'une adresse IP : équipement OU VM. Le lien est une simple colonne (`equipment_id` /
      `vm_id`) → le filtre part au SERVEUR en `where` ; le mode fichier applique le même test en mémoire. */
  static ipCarrier(store: Store): ListTargetFilter {
    const families = [ListTargets.EQUIPMENT, ListTargets.VM];
    return {
      label: I18n.t("lists.filter.carrier"),
      placeholder: I18n.t("lists.filter.carrierPlaceholder"),
      search: (query) => ListTargets.candidates(store, families, query),
      labelOf: (kind, id) => ListTargets.labelOf(store, families, kind, id),
      tagOf: (kind) => ListTargets.tagOf(families, kind),
      where: (kind, id) => (kind === "equipment" ? { equipment_id: id } : kind === "vm" ? { vm_id: id } : null),
      restrict: (rows, kind, id) => {
        // Famille inconnue → AUCUNE ligne (jamais « toutes ») : un slug non prévu ne doit pas se lire
        // comme « pas de filtre » — l'utilisateur verrait un filtre posé sans effet.
        if (kind !== "equipment" && kind !== "vm") return [];
        const field = kind === "equipment" ? "equipment_id" : "vm_id";
        return rows.filter((row) => row && row[field] === id);
      },
    };
  }

  /** ÉQUIPEMENT d'un câble : le rattachement passe par ses PORTS (câble → port → équipement), deux
      SAUTS qu'aucune égalité de colonne n'exprime → `where` toujours null, restriction CLIENTE via
      les index du Store (`cablesOfEquipment`). Asymétrie assumée v1, cf. docs/recherche.md. */
  static cableEquipment(store: Store): ListTargetFilter {
    const families = [ListTargets.EQUIPMENT];
    return {
      label: I18n.t("lists.col.equipment"),
      placeholder: I18n.t("lists.filter.equipmentPlaceholder"),
      search: (query) => ListTargets.candidates(store, families, query),
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

  /** Candidats {kind,id,label} d'une saisie, familles confondues : classement (préfixe avant inclusion),
      plafond et normalisation PARTAGÉE délégués au module pur `TargetSearch`. */
  private static candidates(store: Store, families: readonly TargetFamily[], query: string): TargetSearchItem[] {
    const items = families.flatMap((family) => store.all(family.collection)
      .map((record: any) => ({ kind: family.kind, id: record.id, label: ListTargets.nameOf(record, family) })));
    return TargetSearch.rank(items, query, { normalize: Schema.normSearch, limit: ListTargets.SEARCH_LIMIT });
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
