/* =============================================================================
   GlobalSearchSources — CORPUS de la recherche globale (palette Ctrl+K).

   Construit, à l'OUVERTURE de la palette, la liste des objets cherchables :
   un item {kind, id, label, terms} par enregistrement. Deux règles fondatrices,
   chacune adossée à une source de vérité EXISTANTE — ce module n'en invente pas :

   1. INCLUSION : une collection n'entre au corpus que si `Forms.detail()` sait
      l'OUVRIR (`DetailForms.DETAIL_COLLECTIONS`, dérivée de la carte des fiches).
      Un résultat qui ne peut pas s'ouvrir serait un clic sans effet — l'asymétrie
      prédicat ⇄ action déjà résorbée deux fois (« Localiser », liens
      d'intervention). Invariant TESTÉ : SOURCES ⊆ DETAIL_COLLECTIONS.
      Ports, agrégats, waypoints, rackItems : PAS de fiche → PAS dans le corpus
      (v2 possible : les résoudre sur la fiche de leur porteur).

   2. TERMES : « quel texte trouve cet objet » est DÉJÀ défini, collection par
      collection, par les `searchFields` de `ListConfigs` — et maintenu là (le
      lot 6 du chantier sous-équipements vient d'y ajouter les noms de drives
      côté équipements). On INSTANCIE la config et on réutilise sa fonction :
      une redéclaration ici aurait été la 3ᵉ définition de la même règle,
      condamnée à diverger. Seul `subEquipments` n'a PAS de ListConfig (pas
      d'onglet, décision D2) → ses termes sont déclarés ici, au même endroit
      que son libellé.

   Le LIBELLÉ, lui, est propre à la palette (les listings n'ont pas de notion de
   « ligne-titre » unique) : une fonction par collection, la plus courte possible.
   ⚠ Celui d'un sous-équipement NOMME SON MAÎTRE (« Drive 2 — Librairie ») : sans
   onglet, c'est ici que ce lien doit se lire.
   ============================================================================= */
import type { Store } from "../store";
import { ListConfigs } from "./ListConfigs";
import { I18n } from "../i18n/I18n";
import type { GlobalSearchItem } from "../core/GlobalSearch";

/** Descripteur d'une famille cherchable : libellé de l'item + termes annexes. */
interface FamilySource {
  /** Libellé AFFICHÉ dans la palette (concis — le badge de famille porte déjà le type). */
  label: (record: any, store: Store) => string;
  /** Termes de recherche NON affichés. Par défaut : les `searchFields` du listing homonyme. */
  terms?: (record: any, store: Store) => unknown[];
}

export class GlobalSearchSources {
  /** Ordre CANONIQUE d'affichage des familles : le PHYSIQUE d'abord (équipements → lieux), puis la
      connectique, l'adressage, le virtuel/l'inventaire, et les référentiels en dernier. */
  static readonly FAMILY_ORDER: readonly string[] = [
    "equipments", "subEquipments", "racks", "datacenters", "sites", "floors",
    "cables", "cableBundles", "networks", "ipNetworks", "ipAddresses", "dhcpRanges",
    "vms", "spares", "groups", "contacts", "cableTypes", "portTypes",
  ];

  /** Libellés (et termes dérogatoires) par famille. ⚠ Toute clé ajoutée ici doit être OUVRABLE
      (invariant testé contre `DetailForms.DETAIL_COLLECTIONS`) — et réciproquement, une fiche
      ajoutée sans entrée ici est une collection INTROUVABLE à la palette (second sens du test). */
  private static readonly SOURCES: Record<string, FamilySource> = {
    equipments:    { label: (e) => e.name || I18n.t("lists.ph.equipment") },
    // Sous-équipement : le libellé nomme le MAÎTRE — et les termes le reprennent (chercher
    // « librairie » doit aussi faire remonter ses drives, pas seulement l'équipement).
    subEquipments: {
      label: (se, store) => { const master: any = store.get("equipments", se.equipment_id); return (se.name || I18n.t("subEquipment.fallback")) + " — " + (master ? (master.name || I18n.t("lists.ph.equipment")) : I18n.t("subEquipment.masterMissing")); },
      terms: (se, store) => { const master: any = store.get("equipments", se.equipment_id); return [se.name, se.serial, se.slot, se.brand, se.model, se.description, master && master.name]; },
    },
    racks:         { label: (r) => r.name || I18n.t("lists.ph.rack") },
    datacenters:   { label: (d) => d.name || I18n.t("lists.ph.room") },
    sites:         { label: (s) => s.name || I18n.t("lists.ph.site") },
    floors:        { label: (f, store) => store.siteLabel(f.location || "") + " · " + I18n.t("detail.common.floorAbbrev", { floor: f.floor }) },
    cables:        { label: (c) => c.name || I18n.t("lists.ph.cable") },
    cableBundles:  { label: (b) => b.name || I18n.t("lists.ph.bundle") },
    networks:      { label: (n) => n.label || I18n.t("lists.ph.network") },
    ipNetworks:    { label: (n) => (n.cidr || "?") + (n.label ? " — " + n.label : "") },
    ipAddresses:   { label: (a) => a.address || "?" },
    dhcpRanges:    { label: (r) => (r.start_ip || "?") + " – " + (r.end_ip || "?") },
    vms:           { label: (v) => v.name || "?" },
    spares:        { label: (s) => (s.displayName ? s.displayName() : s.name) || s.serial || "?" },
    groups:        { label: (g) => g.label || I18n.t("lists.ph.group") },
    contacts:      { label: (c) => c.name || "?" },
    cableTypes:    { label: (t) => t.name || "?" },
    portTypes:     { label: (t) => t.name || "?" },
  };

  /** Familles cherchables (clés de SOURCES) — exposées pour le test d'invariant. */
  static families(): string[] { return Object.keys(GlobalSearchSources.SOURCES); }

  /** Construit le corpus COMPLET — un snapshot, à l'ouverture de la palette (les volumes réels se
      comptent en centaines : re-filtrer ce tableau à chaque frappe est trivial, le reconstruire non). */
  static build(store: Store): GlobalSearchItem[] {
    const out: GlobalSearchItem[] = [];
    for (const [collection, source] of Object.entries(GlobalSearchSources.SOURCES)) {
      // Termes par défaut = les `searchFields` du listing homonyme (source unique, cf. en-tête).
      // `ListConfigs[collection]` est une méthode statique par collection ; l'instanciation ne coûte
      // que des fermetures. `subEquipments` (sans onglet) passe par sa dérogation `terms`.
      const config = (ListConfigs as any)[collection];
      const searchFields: ((r: any) => unknown[]) | null =
        source.terms ? null : (config ? config(store).searchFields || null : null);
      for (const record of store.all(collection)) {
        out.push({
          kind: collection,
          id: record.id,
          label: source.label(record, store),
          terms: source.terms ? source.terms(record, store) : (searchFields ? searchFields(record) : []),
        });
      }
    }
    return out;
  }
}
