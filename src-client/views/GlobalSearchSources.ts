/* =============================================================================
   GlobalSearchSources — CORPUS et PORTÉES de la recherche globale (Ctrl+K).

   Construit, à l'OUVERTURE de la modale, la liste des objets cherchables :
   un item {kind, id, label, sub, path, terms} par enregistrement. Deux règles
   fondatrices, chacune adossée à une source de vérité EXISTANTE :

   1. INCLUSION : une collection n'entre au corpus que si `Forms.detail()` sait
      l'OUVRIR (`DetailForms.DETAIL_COLLECTIONS`, dérivée de la carte des
      fiches). Un résultat qui ne peut pas s'ouvrir serait un clic sans effet —
      l'asymétrie prédicat ⇄ action déjà résorbée deux fois. Invariant TESTÉ :
      familles ≡ DETAIL_COLLECTIONS. Ports, agrégats, waypoints, rackItems :
      pas de fiche → pas au corpus (v2 : les résoudre sur leur porteur).

   2. TERMES : « quel texte trouve cet objet » est DÉJÀ défini par les
      `searchFields` de `ListConfigs`, et maintenu là — on les RÉUTILISE, on ne
      les redéclare pas. Seul `subEquipments` (sans onglet, décision D2) porte
      les siens ici.

   L'HABILLAGE d'un résultat (sub = détails, path = chemin métier) est propre à
   la modale — les listings n'ont pas cette notion : une fonction par famille,
   en TEXTE BRUT (le surlignage <mark> est posé par la modale, jamais ici).

   Les PORTÉES (pastilles de filtre + préfixes « eq: », « cb: »…) regroupent
   les 18 familles en 6 filtres maniables — chaque famille appartient à
   EXACTEMENT une portée (invariant testé). ⚠ Certificats, interventions et
   ACTIONS (présents dans la maquette) ne sont PAS des portées v1 : leurs
   données vivent dans des bases serveur séparées (API seulement, paginées) —
   les brancher est un chantier à part, la structure de portées les accueillera.
   ============================================================================= */
import type { Store } from "../store";
import { ListConfigs } from "./ListConfigs";
import { Icons } from "../ui/Icons";
import { EquipmentTypes } from "../registries/EquipmentTypes";
import { GroupTypes } from "../domain/GroupTypes";
import { I18n } from "../i18n/I18n";
import type { GlobalSearchItem } from "../core/GlobalSearch";

/** Descripteur d'une famille cherchable : habillage du résultat + termes dérogatoires. */
interface FamilySource {
  /** Titre du résultat (concis — le groupe et l'icône portent déjà la famille). */
  label: (record: any, store: Store) => string;
  /** Sous-ligne : détails (type, marque, état…). Texte brut, "" = rien. */
  sub?: (record: any, store: Store) => string;
  /** Chemin MÉTIER : localisation, extrémités… Texte brut, "" = rien. */
  path?: (record: any, store: Store) => string;
  /** Termes non affichés. Par défaut : les `searchFields` du listing homonyme. */
  terms?: (record: any, store: Store) => unknown[];
}

/** Une PORTÉE de recherche : un filtre (pastille) + son préfixe de saisie + ses familles. */
export interface SearchScope {
  id: string;
  /** SVG du registre `Icons` (pastille + icône des résultats de ses familles). */
  icon: string;
  /** Préfixe SAISISSABLE (« eq: ») — l'analyse le retire de la requête et active la portée. */
  prefix: string;
  /** Familles (= collections) couvertes. */
  kinds: readonly string[];
}

export class GlobalSearchSources {
  /** Portées de filtre — CHAQUE famille du corpus appartient à EXACTEMENT une portée (testé).
      L'ordre est celui des pastilles ET le départage canonique des groupes de résultats. */
  static readonly SCOPES: readonly SearchScope[] = [
    { id: "equip", icon: Icons.EQUIPMENT, prefix: "eq:", kinds: ["equipments", "subEquipments"] },
    { id: "places", icon: Icons.RACK_CONTENT, prefix: "baie:", kinds: ["racks", "datacenters", "sites", "floors"] },
    { id: "cables", icon: Icons.CABLE, prefix: "cb:", kinds: ["cables", "cableBundles"] },
    { id: "network", icon: Icons.IPAM, prefix: "ip:", kinds: ["networks", "ipNetworks", "ipAddresses", "dhcpRanges"] },
    { id: "vms", icon: Icons.VM, prefix: "vm:", kinds: ["vms"] },
    { id: "inventory", icon: Icons.SPARE, prefix: "inv:", kinds: ["spares", "groups", "contacts", "cableTypes", "portTypes"] },
  ];

  /** Ordre CANONIQUE des familles = l'ordre des portées, déplié. Sert de DÉPARTAGE aux groupes
      (l'ordre premier est la pertinence — cf. GlobalSearch.rank). */
  static readonly FAMILY_ORDER: readonly string[] = GlobalSearchSources.SCOPES.flatMap((s) => s.kinds);

  /** Carte préfixe → portée, pour `GlobalSearch.parsePrefix`. */
  static prefixes(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const scope of GlobalSearchSources.SCOPES) out[scope.prefix] = scope.id;
    return out;
  }

  /** Portée d'une famille (id de SCOPES) — "" si inconnue (défensif). */
  static scopeOf(kind: string): string {
    const scope = GlobalSearchSources.SCOPES.find((s) => s.kinds.includes(kind));
    return scope ? scope.id : "";
  }

  /* ---- habillage par famille ------------------------------------------------------------- */

  /** Localisation TEXTE d'un équipement — volontairement plus fruste qu'`EntityViz` (qui rend du
      HTML) : baie + U, sinon salle, sinon étagère → baie, sinon les champs libres. */
  private static equipmentPath(store: Store, e: any): string {
    if ((e.placement_mode === "rack" || e.placement_mode === "side" || e.placement_mode === "wall") && e.rack_id) {
      const rack: any = store.get("racks", e.rack_id);
      return rack ? (rack.name || "?") + (e.rack_u ? " · U" + e.rack_u : "") : "";
    }
    if (e.placement_mode === "tray" && e.tray_item_id) {
      const tray: any = store.get("rackItems", e.tray_item_id);
      const rack: any = tray && tray.rack_id ? store.get("racks", tray.rack_id) : null;
      return rack ? (rack.name || "?") : "";
    }
    if (e.dc_id) { const dc: any = store.get("datacenters", e.dc_id); return dc ? (dc.name || "?") : ""; }
    return [store.siteLabel(e.location || ""), e.floor, e.room].filter((x) => x && x !== "—").join(" · ");
  }

  /** « équipement : port » en texte (extrémité de câble) — pendant TEXTE du `portRef` HTML des fiches. */
  private static portRefText(store: Store, portId: string | null): string {
    const port: any = portId ? store.get("ports", portId) : null;
    if (!port) return "—";
    const eq: any = store.get("equipments", port.equipment_id);
    return (eq ? (eq.name || "?") : "?") + " : " + (port.name || "?");
  }

  /** Libellés + habillage (et termes dérogatoires) par famille. ⚠ Toute clé ajoutée ici doit être
      OUVRABLE (invariant testé contre `DetailForms.DETAIL_COLLECTIONS`) — et réciproquement, une
      fiche ajoutée sans entrée ici est une collection INTROUVABLE à la modale (second sens du test). */
  private static readonly SOURCES: Record<string, FamilySource> = {
    equipments: {
      label: (e) => e.name || I18n.t("lists.ph.equipment"),
      sub: (e) => [EquipmentTypes.label(e.type), [e.brand, e.model].filter(Boolean).join(" ")].filter(Boolean).join(" · "),
      path: (e, store) => GlobalSearchSources.equipmentPath(store, e),
    },
    // Sous-équipement : le CHEMIN nomme le maître (+ repère) — sans onglet (D2), c'est ici que ce
    // lien se lit ; le nom du maître reste aussi dans les TERMES (chercher la librairie remonte ses drives).
    subEquipments: {
      label: (se) => se.name || I18n.t("subEquipment.fallback"),
      sub: (se) => [se.brand, se.model, se.serial].filter(Boolean).join(" · "),
      path: (se, store) => { const master: any = store.get("equipments", se.equipment_id); return (master ? (master.name || "?") : I18n.t("subEquipment.masterMissing")) + (se.slot ? " › " + se.slot : ""); },
      terms: (se, store) => { const master: any = store.get("equipments", se.equipment_id); return [se.name, se.serial, se.slot, se.brand, se.model, se.description, master && master.name]; },
    },
    racks: {
      label: (r) => r.name || I18n.t("lists.ph.rack"),
      sub: (r) => (r.u_count || 42) + " U",
      path: (r, store) => { const dc: any = r.datacenter_id ? store.get("datacenters", r.datacenter_id) : null; return dc ? (dc.name || "?") : ""; },
    },
    datacenters: {
      label: (d) => d.name || I18n.t("lists.ph.room"),
      path: (d, store) => [store.siteLabel(d.location || ""), d.floor ? I18n.t("detail.common.floorAbbrev", { floor: d.floor }) : "", d.room].filter((x) => x && x !== "—").join(" · "),
    },
    sites: { label: (s) => s.name || I18n.t("lists.ph.site"), sub: (s) => s.address || "" },
    floors: { label: (f, store) => store.siteLabel(f.location || "") + " · " + I18n.t("detail.common.floorAbbrev", { floor: f.floor }) },
    cables: {
      label: (c) => c.name || I18n.t("lists.ph.cable"),
      sub: (c, store) => { const ct: any = c.cable_type_id ? store.get("cableTypes", c.cable_type_id) : null; return ct ? (ct.name || "") : ""; },
      path: (c, store) => (c.from_port_id || c.to_port_id) ? GlobalSearchSources.portRefText(store, c.from_port_id) + " ↔ " + GlobalSearchSources.portRefText(store, c.to_port_id) : "",
    },
    cableBundles: {
      label: (b) => b.name || I18n.t("lists.ph.bundle"),
      sub: (b) => b.fiber_count ? b.fiber_count + " " + I18n.t("search.sub.strands") : "",
      path: (b, store) => { const name = (id: string | null) => { const eq: any = id ? store.get("equipments", id) : null; return eq ? (eq.name || "?") : "—"; }; return name(b.endpoint_a_equipment_id) + " ↔ " + name(b.endpoint_b_equipment_id); },
    },
    networks: { label: (n) => n.label || I18n.t("lists.ph.network") },
    ipNetworks: { label: (n) => n.cidr || "?", sub: (n) => n.label || "" },
    ipAddresses: {
      label: (a) => a.address || "?",
      sub: (a, store) => { const eq: any = a.equipment_id ? store.get("equipments", a.equipment_id) : null; const vm: any = a.vm_id ? store.get("vms", a.vm_id) : null; return (eq && eq.name) || (vm && vm.name) || ""; },
    },
    dhcpRanges: { label: (r) => (r.start_ip || "?") + " – " + (r.end_ip || "?") },
    vms: {
      label: (v) => v.name || "?",
      sub: (v, store) => { const host: any = v.host_equipment_id ? store.get("equipments", v.host_equipment_id) : null; return [v.status, host && host.name].filter(Boolean).join(" · "); },
    },
    spares: {
      label: (s) => (s.displayName ? s.displayName() : s.name) || s.serial || "?",
      sub: (s) => (s.techSummary ? s.techSummary() : "") || s.serial || "",
    },
    groups: { label: (g) => g.label || I18n.t("lists.ph.group"), sub: (g) => GroupTypes.label(g.type) },
    contacts: { label: (c) => c.name || "?", sub: (c) => [c.email, c.phone].filter(Boolean).join(" · ") },
    cableTypes: { label: (t) => t.name || "?", sub: (t) => t.family || "" },
    portTypes: { label: (t) => t.name || "?", sub: (t) => t.family || "" },
  };

  /** Familles cherchables (clés de SOURCES) — exposées pour les tests d'invariant. */
  static families(): string[] { return Object.keys(GlobalSearchSources.SOURCES); }

  /** Construit le corpus COMPLET — un snapshot, à l'ouverture de la modale (volumes réels : des
      centaines — re-filtrer ce tableau à chaque frappe est trivial, le reconstruire non). */
  static build(store: Store): GlobalSearchItem[] {
    const out: GlobalSearchItem[] = [];
    for (const [collection, source] of Object.entries(GlobalSearchSources.SOURCES)) {
      // Termes par défaut = les `searchFields` du listing homonyme (source unique, cf. en-tête).
      const config = (ListConfigs as any)[collection];
      const searchFields: ((r: any) => unknown[]) | null =
        source.terms ? null : (config ? config(store).searchFields || null : null);
      for (const record of store.all(collection)) {
        out.push({
          kind: collection,
          id: record.id,
          label: source.label(record, store),
          sub: source.sub ? source.sub(record, store) || undefined : undefined,
          path: source.path ? source.path(record, store) || undefined : undefined,
          terms: source.terms ? source.terms(record, store) : (searchFields ? searchFields(record) : []),
        });
      }
    }
    return out;
  }
}
