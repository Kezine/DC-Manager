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

   2. TERMES : « quel texte trouve cet objet » vient du module PARTAGÉ
      `src-shared/SearchTerms`, via l'adaptateur client `core/RecordSearch`
      (lot 2 recherche partagée, factorisé au lot 3) — valeurs PROPRES du
      record + `SearchTerms.termsOf` (dérivés par lien/enfants + catalogues
      fr/en + compositions tapables), avec les lecteurs du Store injectés
      (`get`/`findByField`). C'est la MÊME spec que la colonne `search` du
      serveur : parité des deux modes PAR CONSTRUCTION (principe n°15 — un
      utilisateur fr trouve « orphan » en mode fichier aussi). Historique : les
      termes venaient des `searchFields` de `ListConfigs` — dérivations ad hoc
      dupliquées, résorbées par le module partagé ; au lot 3 les LISTINGS les
      ont perdus à leur tour et cherchent la même assiette que cette palette.

   L'HABILLAGE d'un résultat (sub = détails, path = chemin métier) est propre à
   la modale — les listings n'ont pas cette notion : une fonction par famille,
   en TEXTE BRUT (le surlignage <mark> est posé par la modale, jamais ici).
   `dressRecords` habille des records REÇUS DU SERVEUR (mode API serveur-piloté,
   cf. GlobalSearchPalette) avec les MÊMES fonctions — l'instance LOCALE du
   Store est préférée quand elle existe (habillage riche : displayName…).

   Les PORTÉES (pastilles de filtre + préfixes « eq: », « cb: »…) regroupent
   les 18 familles en 6 filtres maniables — chaque famille appartient à
   EXACTEMENT une portée (invariant testé). ⚠ Certificats, interventions et
   ACTIONS (présents dans la maquette) ne sont PAS des portées v1 : leurs
   données vivent dans des bases serveur séparées (API seulement, paginées) —
   les brancher est un chantier à part, la structure de portées les accueillera.
   ============================================================================= */
import type { Store } from "../store";
import { Icons } from "../ui/Icons";
import { EquipmentTypes } from "../registries/EquipmentTypes";
import { GroupTypes } from "../domain/GroupTypes";
import { CableStatuses } from "../domain/CableStatuses";
import { SpareStatuses } from "../domain/SpareStatuses";
import { VmStatus } from "../core/VmStatus";
import { VmLocate } from "../core/VmLocate";
import { RackScene } from "../geometry/RackScene";
import { I18n } from "../i18n/I18n";
import type { GlobalSearchItem } from "../core/GlobalSearch";
import { RecordSearch } from "../core/RecordSearch";
import type { EntityFetcher, ChildFinder } from "../../src-shared/DataValidation";

/** Descripteur d'une famille cherchable : l'HABILLAGE du résultat (les TERMES, eux, viennent du
    module partagé `SearchTerms` — cf. en-tête, règle 2). */
interface FamilySource {
  /** Titre du résultat (concis — le groupe et l'icône portent déjà la famille). */
  label: (record: any, store: Store) => string;
  /** Sous-ligne : détails (type, marque, état…). Texte brut, "" = rien. */
  sub?: (record: any, store: Store) => string;
  /** Chemin MÉTIER : localisation, extrémités… Texte brut, "" = rien. */
  path?: (record: any, store: Store) => string;
  /** Pastille d'ÉTAT (affichage seul, jamais cherchée — cf. GlobalSearchItem.pill). null = rien. */
  pill?: (record: any, store: Store) => GlobalSearchItem["pill"] | null;
  /** Cible « Localiser » — null si l'objet (ou son porteur) n'est PAS localisable : le corpus est
      GARDÉ par les prédicats partagés, la modale ne teste rien (pas de bouton → toast). */
  locate?: (record: any, store: Store) => GlobalSearchItem["locate"] | null;
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

  /** U OCCUPÉS d'une baie (équipements rackés + pseudo-items + brosses, faces confondues) — via
      `RackScene.occupants`, la source unique de l'occupation. Compte les U distincts, pas les faces. */
  private static rackUsedU(store: Store, rackId: string): number {
    const used = new Set<number>();
    new RackScene(store).occupants(rackId).forEach((_info, key) => used.add(parseInt(key, 10)));
    return used.size;
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
      locate: (e, store) => store.equipmentLocatable(e.id) ? { kind: "equipment", id: e.id } : null,
    },
    // Sous-équipement : le CHEMIN nomme le maître (+ repère) ; le nom du maître reste aussi dans les
    // TERMES (chercher la librairie remonte ses drives — dérivation `subEquipments` de SearchTerms, plus un
    // terme dérogatoire local). Un listing dédié existe depuis le 2026-08-03 (D2 revue), mais la palette est
    // INCHANGÉE : « ouvrir » un résultat sous-équipement montre toujours sa FICHE, jamais le listing.
    // « Localiser » un sous-équipement = localiser SON MAÎTRE (il n'a pas d'existence physique propre —
    // c'est la définition même de la collection, et le même geste que « Localiser » une VM → son hôte).
    subEquipments: {
      label: (se) => se.name || I18n.t("subEquipment.fallback"),
      sub: (se) => [se.brand, se.model, se.serial].filter(Boolean).join(" · "),
      path: (se, store) => { const master: any = store.get("equipments", se.equipment_id); return (master ? (master.name || "?") : I18n.t("subEquipment.masterMissing")) + (se.slot ? " › " + se.slot : ""); },
      locate: (se, store) => se.equipment_id && store.equipmentLocatable(se.equipment_id) ? { kind: "equipment", id: se.equipment_id } : null,
    },
    racks: {
      label: (r) => r.name || I18n.t("lists.ph.rack"),
      sub: (r) => (r.u_count || 42) + " U",
      path: (r, store) => { const dc: any = r.datacenter_id ? store.get("datacenters", r.datacenter_id) : null; return dc ? (dc.name || "?") : ""; },
      // occupation « n/N U » — la maquette l'affichait, et c'est l'info qu'on cherche le plus sur une baie.
      pill: (r, store) => { const used = GlobalSearchSources.rackUsedU(store, r.id); return { text: used + "/" + (r.u_count || 42) + " U", tone: "" }; },
      locate: (r) => r.datacenter_id ? { kind: "rack", id: r.id } : null,   // même prédicat que les listes (main.ts)
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
      // tons par STATUT : cassé = rouge, à remplacer = orange, câblé = vert ; brouillon/planifié = neutre.
      pill: (c) => ({ text: CableStatuses.label(c.status), tone: c.status === "casse" ? "err" : c.status === "a-remplacer" ? "warn" : c.status === "cable" ? "ok" : "" }),
      locate: (c, store) => store.cableLocatable(c) ? { kind: "cable", id: c.id } : null,
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
      sub: (v, store) => { const host: any = v.host_equipment_id ? store.get("equipments", v.host_equipment_id) : null; return host && host.name ? host.name : ""; },
      // le STATUT quitte la sous-ligne pour la pastille — source unique `core/VmStatus` (running = ok,
      // orpheline = err — l'orphelinat PRIME : une VM qui tourne sans hôte connu est d'abord un problème).
      pill: (v) => { const kind = VmStatus.kindOf(v); const raw = VmStatus.raw(v); if (!raw && !VmStatus.isOrphan(v)) return null; return { text: raw || I18n.t("lists.ph.orphan"), tone: VmStatus.isOrphan(v) ? "err" : kind === "running" ? "ok" : "" }; },
      // « Localiser » une VM = son HÔTE (même règle que les listes : VmLocate + prédicat partagé).
      locate: (v, store) => { const host = VmLocate.hostEquipmentId(v, store); return host && store.equipmentLocatable(host) ? { kind: "equipment", id: host } : null; },
    },
    spares: {
      label: (s) => (s.displayName ? s.displayName() : s.name) || s.serial || "?",
      sub: (s) => (s.techSummary ? s.techSummary() : "") || s.serial || "",
      pill: (s) => s.status ? { text: SpareStatuses.label(s.status), tone: "" } : null,
    },
    groups: { label: (g) => g.label || I18n.t("lists.ph.group"), sub: (g) => GroupTypes.label(g.type) },
    contacts: { label: (c) => c.name || "?", sub: (c) => [c.email, c.phone].filter(Boolean).join(" · ") },
    cableTypes: { label: (t) => t.name || "?", sub: (t) => t.family || "" },
    portTypes: { label: (t) => t.name || "?", sub: (t) => t.family || "" },
  };

  /** Familles cherchables (clés de SOURCES) — exposées pour les tests d'invariant, et envoyées au
      serveur comme périmètre de la recherche transverse (mode API : inutile de LIKE les collections
      sans fiche — ports, agrégats… — qui ne pourraient pas s'habiller ici). */
  static families(): string[] { return Object.keys(GlobalSearchSources.SOURCES); }

  /** TERMES cherchables d'un record (palier 30) — la PARITÉ avec la colonne `search` serveur, par
      construction (principe n°15). DÉLÉGUÉ au module `core/RecordSearch` depuis le lot 3 : la palette
      et les LISTINGS y lisent désormais la même assiette (valeurs propres étalées + dérivés/catalogues/
      compositions du module PARTAGÉ `SearchTerms`, lecteurs du Store injectés) — deux surfaces, une
      seule définition de « quel texte trouve cet objet ». */
  private static termsOf(store: Store, collection: string, record: any): unknown[] {
    const fetch: EntityFetcher = (c, id) => store.get(c, id);
    const find: ChildFinder = (c, field, value) => store.findByField(c, field, value);
    return RecordSearch.termsOf(collection, record, fetch, find);
  }

  /** Habille UN record en item de corpus — le cœur commun de `build` (corpus local complet) et de
      `dressRecords` (résultats serveur du mode API). `record` : instance du Store OU record brut
      (les fonctions d'habillage sont tolérantes — cf. spares `displayName?`). */
  static itemOf(store: Store, collection: string, record: any): GlobalSearchItem | null {
    const source = GlobalSearchSources.SOURCES[collection];
    if (!source || !record || !record.id) return null;
    return {
      kind: collection,
      id: record.id,
      label: source.label(record, store),
      sub: source.sub ? source.sub(record, store) || undefined : undefined,
      path: source.path ? source.path(record, store) || undefined : undefined,
      terms: GlobalSearchSources.termsOf(store, collection, record),
      pill: source.pill ? source.pill(record, store) || undefined : undefined,
      locate: source.locate ? source.locate(record, store) || undefined : undefined,
    };
  }

  /** Construit le corpus COMPLET — un snapshot, à l'ouverture de la modale (volumes réels : des
      centaines — re-filtrer ce tableau à chaque frappe est trivial, le reconstruire non). */
  static build(store: Store): GlobalSearchItem[] {
    const out: GlobalSearchItem[] = [];
    for (const collection of Object.keys(GlobalSearchSources.SOURCES)) {
      for (const record of store.all(collection)) {
        const item = GlobalSearchSources.itemOf(store, collection, record);
        if (item) out.push(item);
      }
    }
    return out;
  }

  /** Habille des records REÇUS DU SERVEUR (recherche transverse du mode API — cf. GlobalSearchPalette).
      L'instance LOCALE du Store est PRÉFÉRÉE quand elle existe (habillage riche — displayName des
      spares — et cohérence avec le corpus local) ; un record inconnu localement (écriture concurrente
      pas encore synchronisée) est habillé BRUT — dégradé mais fonctionnel. Les collections inconnues
      des SOURCES sont ignorées (le serveur est générique, le corpus ne connaît que les familles à fiche). */
  static dressRecords(store: Store, recordsByCollection: Record<string, Record<string, any>[]>): GlobalSearchItem[] {
    const out: GlobalSearchItem[] = [];
    for (const [collection, records] of Object.entries(recordsByCollection || {})) {
      if (!GlobalSearchSources.SOURCES[collection]) continue;
      for (const record of records || []) {
        if (!record || !record.id) continue;
        const item = GlobalSearchSources.itemOf(store, collection, store.get(collection, record.id) || record);
        if (item) out.push(item);
      }
    }
    return out;
  }
}
