import type { Store } from "../store";
import { Icons } from "../ui/Icons";
import { Html } from "../core/Html";
import { Ip } from "../core/Ip";
import { VmStatus } from "../core/VmStatus";
import { WifiStatus } from "../core/WifiStatus";   // présence + type d'un client wifi (feature AMOVIBLE)
import { WifiClient } from "../models/WifiClient";   // libellé « nom sinon MAC » — règle unique partagée fiche/palette
import { Format } from "../core/Format";
import { LifecycleFormat } from "../core/LifecycleFormat";   // âge d'achat + état de garantie (colonne combinée)
import { I18n } from "../i18n/I18n";
import { EquipmentTypes } from "../registries/EquipmentTypes";
import { EquipFaces } from "../registries/EquipFaces";
import { PortRoles } from "../registries/PortRoles";
import { GroupTypes } from "../domain/GroupTypes";
import { CableStatuses } from "../domain/CableStatuses";
import { SpareTypes } from "../domain/SpareTypes";
import { SpareStatuses } from "../domain/SpareStatuses";
import { RackScene } from "../geometry/RackScene";
import { FloorLayout } from "../geometry/FloorLayout";
import { EntityViz } from "./EntityViz";
import { ListTargets } from "./ListTargets";
import { AttachmentViewKind } from "../core/AttachmentViewKind";   // « Afficher » de ligne : proposé seulement si visualisable
import type { EntitySearchReader } from "../core/EntityCandidates";
import type { ListOptions } from "./ListView";

const dim = (s: string) => `<span style="color:var(--fg-dimmer)">${s}</span>`;
const swatch = (c: string | null) => (c ? `<span class="swatch-dot" style="background:${c}"></span> ` : "");
const kindPill = (k: string) => (k === "power"
  ? '<span class="pill" style="border-color:var(--accent-2);color:var(--accent-2)"><span class="gi">' + Icons.POWER + '</span>' + I18n.t("lists.opt.kindPowerPill") + '</span>'
  : '<span class="pill">' + I18n.t("lists.opt.kindDataPill") + '</span>');
const descCell = (o: any) => (o.description ? Html.escape(String(o.description).slice(0, 80)) : dim("—"));
// Cellule COMBINÉE « Âge / garantie » : âge (depuis `purchase_date`) · état de garantie coloré (depuis
// `warranty_end`), séparés par « · », compacts sur une ligne. La partie garantie porte la couleur SÉMANTIQUE
// de son statut (ok/warn/err), comme la colonne d'échéance des certificats (CertsAdminView) ; « dim » si rien.
// Factorisée entre les listings Équipements et Sous-équipements (mêmes champs). `now` = maintenant réel.
const ageWarrantyCell = (o: any): string => {
  const now = new Date();
  const parts: string[] = [];
  const age = o.purchase_date ? LifecycleFormat.age(o.purchase_date, now) : null;
  if (age) parts.push(Html.escape(age));
  const w = o.warranty_end ? LifecycleFormat.warranty(o.warranty_end, now) : null;
  if (w) {
    const color = w.status === "ok" ? "var(--ok)" : w.status === "warn" ? "var(--warn)" : "var(--err)";
    parts.push(`<span style="color:${color}">${Html.escape(w.label)}</span>`);
  }
  return parts.length ? parts.join(" · ") : dim("—");
};

/* Configurations de colonnes par collection (paramètrent ListView). Classe de méthodes
   statiques ; chaque méthode renvoie les options d'une liste. Le JEU de colonnes est aligné
   sur l'app de référence (monolithe) — cf. les `columns` des ListController d'origine.
   Libellés (en-têtes, états vides, filtres, options, placeholders) via I18n (domaine `lists`). */
export class ListConfigs {
  static equipments(store: Store): ListOptions {
    return {
      collection: "equipments",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: I18n.t("lists.empty.equipments"),
      // ⚠ Les NOMS (et séries) des SOUS-ÉQUIPEMENTS font partie des termes de recherche du MAÎTRE : taper
      // « Drive LTO » fait ressortir la librairie, d'où l'on ouvre sa fiche. Ce n'est pas une recherche DE
      // sous-équipements sur CE listing : c'est la librairie qui matche. Un listing DÉDIÉ des sous-équipements
      // existe désormais (D2 revue le 2026-08-03, `ListConfigs.subEquipments`, onglet secondaire d'Équipements),
      // mais il ne change rien ici — le terme dérivé reste le chemin naturel depuis l'onglet Équipements.
      // Cette dérivation (et toutes les autres : baie, groupes, type,
      // « U12 », « marque modèle »…) vit désormais dans la spec PARTAGÉE `src-shared/SearchTerms` — le relevé
      // `searchFields` qui la redisait ici a disparu au lot 3 (cf. l'en-tête de `ListView`).
      columns: [
        { head: I18n.t("lists.col.name"), essential: true, cls: "cell-name", sortKey: "name", sort: (e) => e.name, render: (e) => Html.escape(e.name || I18n.t("lists.ph.noName")) },
        {
          head: I18n.t("lists.col.type"), essential: true, sortKey: "type", sort: (e) => EquipmentTypes.label(e.type),
          render: (e) => `<span class="pill">${Html.escape(EquipmentTypes.label(e.type))}</span>`,
          filter: { label: I18n.t("lists.col.type"), options: () => EquipmentTypes.ALL.map((t) => ({ id: t.id, label: I18n.t(t.labelKey) })), valueOf: (e) => e.type },
        },
        {
          head: I18n.t("lists.col.group"), sortKey: "group",
          sort: (e) => { const g: any = e.group_id && store.get("groups", e.group_id); return g ? (g.label || "") : ""; },   // tri sur le PRIMAIRE
          render: (e) => { const gs: any[] = store.equipmentGroupIds(e).map((gid: string) => store.get("groups", gid)).filter(Boolean); return gs.length ? gs.map((g: any) => swatch(g.color) + Html.escape(g.label || I18n.t("lists.ph.group"))).join(" ") : dim("—"); },
          // filtre par APPARTENANCE (primaire OU secondaire) — valueOf renvoie un tableau, comme la colonne Réseaux des câbles.
          filter: { label: I18n.t("lists.col.group"), options: () => store.all("groups").map((g: any) => ({ id: g.id, label: g.label || I18n.t("lists.ph.group") })), valueOf: (e) => store.equipmentGroupIds(e) },
        },
        { head: "U", cls: "cell-num", sortKey: "u", sort: (e) => (e.dim_mode === "u" ? (e.u_height || 1) : -1), render: (e) => (e.dim_mode === "u" ? `<span class="pill">${e.u_height || 1} U</span>` : dim(I18n.t("lists.ph.free"))) },
        { head: I18n.t("lists.col.location"), essential: true, sortKey: "place", sort: (e) => ListConfigs._placeText(store, e), render: (e) => EntityViz.equipmentLocation(store, e) },
        { head: I18n.t("lists.col.ports"), cls: "cell-num", sort: (e) => store.portsOf(e.id).length, render: (e) => `<span class="pill">${store.portsOf(e.id).length}</span>` },
        { head: I18n.t("lists.col.aggregates"), cls: "cell-num", sort: (e) => store.aggregatesOf(e.id).length, render: (e) => `<span class="pill">${store.aggregatesOf(e.id).length}</span>` },
        // Compte de SOUS-ÉQUIPEMENTS — même forme que la colonne Agrégats. Estompé à zéro (le cas de la
        // quasi-totalité des équipements) pour ne pas ajouter une colonne de « 0 » à une table déjà large.
        { head: I18n.t("lists.col.subEquipments"), cls: "cell-num", sort: (e) => store.subEquipmentsOf(e.id).length, render: (e) => { const n = store.subEquipmentsOf(e.id).length; return n ? `<span class="pill">${n}</span>` : dim("—"); } },
        // Âge / garantie (colonne COMBINÉE, non essentielle) : l'onglet Équipements n'avait aucune colonne datée.
        // Tri par `warranty_end` — l'axe ACTIONNABLE (« quels équipements hors garantie » ; croissant = expirées
        // en tête). L'âge est AFFICHÉ mais non triable (le filtre par état viendra au volet 2, hors périmètre ici).
        { head: I18n.t("lists.col.ageWarranty"), sortKey: "warranty", sort: (e) => e.warranty_end || "", render: ageWarrantyCell },
        { head: I18n.t("lists.col.description"), cls: "cell-desc", sort: (e) => e.description || "", render: descCell },
      ],
    };
  }

  /** Listing des SOUS-ÉQUIPEMENTS — vue SECONDAIRE de l'onglet Équipements (D2 REVUE le 2026-08-03, lot C
      du cadrage `sous-equipements-achat-garantie-listing`). Pas de bouton « + » : la création reste sur la
      fiche du maître (qui fournit `equipment_id`, doctrine du chantier d'origine) — cf. le câblage `addListTab`
      sans `onAdd` dans `main.ts`. Le filtrage PAR MAÎTRE passe par la dimension CIBLE (`targetFilter` →
      `ListTargets.subEquipmentMaster`, `where` serveur indexé) et non par un filtre-colonne : on n'ajoute pas
      un doublon dimension/filtre-colonne (l'arbitrage `ipAddresses` sur cette coexistence est encore ouvert). */
  static subEquipments(store: Store, entitySearch: EntitySearchReader | null = null): ListOptions {
    return {
      collection: "subEquipments",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: I18n.t("lists.empty.subEquipments"),
      // Filtre CIBLE : « les sous-équipements de CET équipement maître ». Le lien est une colonne
      // (`equipment_id`) → le filtre part au SERVEUR en `where` (1 saut, indexé) ; le mode fichier applique
      // le même test en mémoire. Recherche de CANDIDATS serveur-pilotée en mode API (`entitySearch`), locale en fichier.
      targetFilter: ListTargets.subEquipmentMaster(store, entitySearch),
      columns: [
        { head: I18n.t("lists.col.name"), essential: true, cls: "cell-name", sortKey: "name", sort: (se) => se.name, render: (se) => Html.escape(se.name || I18n.t("subEquipment.fallback")) },
        {
          // Maître : pas de filtre-COLONNE ici (le filtrage par maître passe par la dimension CIBLE ci-dessus).
          head: I18n.t("subEquipment.master"), essential: true, sortKey: "master",
          sort: (se) => { const e: any = se.equipment_id && store.get("equipments", se.equipment_id); return e ? (e.name || "") : ""; },
          render: (se) => { const e: any = se.equipment_id && store.get("equipments", se.equipment_id); return e ? Html.escape(e.name || I18n.t("lists.ph.equipment")) : dim("—"); },
        },
        { head: I18n.t("subEquipment.slot"), sortKey: "slot", sort: (se) => se.slot || "", render: (se) => (se.slot ? Html.escape(se.slot) : dim("—")) },
        // Caractéristiques (marque · modèle · s/n) : PARITÉ avec `SubEquipmentForms.techSummary` — join inliné
        // plutôt qu'importer tout le module de formulaires (cross-import EquipmentForms) pour une jointure d'une
        // ligne. ⚠ Garder les deux en phase si la composition change.
        { head: I18n.t("lists.col.characteristics"), render: (se) => { const t = [se.brand, se.model, se.serial].map((v: string) => (v || "").trim()).filter(Boolean).join(" · "); return t ? Html.escape(t) : dim("—"); } },
        {
          head: I18n.t("lists.col.group"), sortKey: "group",
          sort: (se) => { const g: any = se.group_id && store.get("groups", se.group_id); return g ? (g.label || "") : ""; },   // tri sur le PRIMAIRE
          render: (se) => { const gs: any[] = store.groupIdsOf(se).map((gid: string) => store.get("groups", gid)).filter(Boolean); return gs.length ? gs.map((g: any) => swatch(g.color) + Html.escape(g.label || I18n.t("lists.ph.group"))).join(" ") : dim("—"); },
          // filtre par APPARTENANCE (primaire OU secondaire) — valueOf renvoie un tableau, comme la colonne Groupe des équipements.
          filter: { label: I18n.t("lists.col.group"), options: () => store.all("groups").map((g: any) => ({ id: g.id, label: g.label || I18n.t("lists.ph.group") })), valueOf: (se) => store.groupIdsOf(se) },
        },
        // Âge / garantie (colonne COMBINÉE) : REMPLACE les deux ex-colonnes « Achat »/« Garantie » brutes
        // (densité ; les dates brutes restent lisibles en fiche). Tri par `warranty_end` — l'axe ACTIONNABLE
        // (croissant = expirées en tête) ; l'âge est affiché mais non triable (filtre → volet 2, hors périmètre).
        { head: I18n.t("lists.col.ageWarranty"), sortKey: "warranty", sort: (se) => se.warranty_end || "", render: ageWarrantyCell },
        { head: I18n.t("lists.col.description"), cls: "cell-desc", sort: (se) => se.description || "", render: descCell },
      ],
    };
  }

  static networks(store: Store): ListOptions {
    return {
      collection: "networks",
      defaultSort: { key: "label", dir: "asc" },
      emptyText: I18n.t("lists.empty.networks"),
      columns: [
        { head: I18n.t("lists.col.color"), render: (n) => (n.color ? `<span class="swatch-dot" style="background:${n.color}"></span>` : dim("—")) },
        { head: I18n.t("lists.col.label"), cls: "cell-name", sortKey: "label", sort: (n) => n.label, render: (n) => Html.escape(n.label || I18n.t("lists.ph.noLabel")) },
        {
          head: I18n.t("lists.col.type"), sortKey: "kind", sort: (n) => n.kind, render: (n) => kindPill(n.kind),
          filter: { label: I18n.t("lists.col.type"), options: () => [{ id: "data", label: I18n.t("lists.opt.dataFilter") }, { id: "power", label: I18n.t("lists.opt.powerFilter") }], valueOf: (n) => (n.kind === "power" ? "power" : "data") },
        },
        { head: I18n.t("lists.col.ipNetwork"), render: (n) => { const ip: any = n.ip_network_id && store.get("ipNetworks", n.ip_network_id); return ip ? `<span class="pill"><span class="gi">${Icons.NETWORK}</span>${Html.escape(ip.cidr || ip.label || "(IP)")}</span>` : dim(I18n.t("lists.ph.logical")); } },
        { head: I18n.t("lists.col.cables"), cls: "cell-num", sort: (n) => store.cablesOfNetwork(n.id).length, render: (n) => `<span class="pill">${store.cablesOfNetwork(n.id).length}</span>` },
        { head: I18n.t("lists.col.description"), cls: "cell-desc", sort: (n) => n.description || "", render: descCell },
      ],
    };
  }

  static groups(store: Store): ListOptions {
    return {
      collection: "groups",
      defaultSort: { key: "label", dir: "asc" },
      emptyText: I18n.t("lists.empty.groups"),
      columns: [
        { head: I18n.t("lists.col.color"), render: (g) => (g.color ? `<span class="swatch-dot" style="background:${g.color}"></span>` : dim("—")) },
        { head: I18n.t("lists.col.label"), cls: "cell-name", sortKey: "label", sort: (g) => g.label, render: (g) => Html.escape(g.label || I18n.t("lists.ph.noLabel")) },
        {
          head: I18n.t("lists.col.type"), sortKey: "type", sort: (g) => GroupTypes.label(g.type), render: (g) => `<span class="pill">${Html.escape(GroupTypes.label(g.type))}</span>`,
          filter: { label: I18n.t("lists.col.type"), options: () => GroupTypes.ALL.map((t) => ({ id: t.id, label: I18n.t(t.labelKey) })), valueOf: (g) => g.type },
        },
        { head: I18n.t("lists.col.equipments"), cls: "cell-num", sort: (g) => store.equipmentsOfGroup(g.id).length, render: (g) => `<span class="pill">${store.equipmentsOfGroup(g.id).length}</span>` },
        { head: I18n.t("lists.col.description"), cls: "cell-desc", sort: (g) => g.description || "", render: descCell },
      ],
    };
  }

  /** Bibliothèque d'images de façade — source CUSTOM (ImageStore) injectée via `items` au câblage. */
  static faceImages(store: Store): ListOptions {
    const faceLbl = (f: string) => (f === "autre" ? I18n.t("lists.opt.faceOther") : EquipFaces.label(f));
    return {
      collection: "faceImages",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: I18n.t("lists.empty.faceImages"),
      // ⚠ SEUL listing à garder un relevé `searchFields` EXPLICITE, et c'est voulu : sa source est CUSTOM
      // (`ImageStore`, hors collections du document) — la spec partagée `SearchTerms` ne la connaît pas, et
      // ses enregistrements portent la data URL COMPLÈTE de l'image (`FaceImage.data`), qui n'a rien à faire
      // dans un texte cherchable. Cf. `ListOptions.searchFields`.
      // « autre » = image de face LIBRE (équipement non-rack) : la hauteur en U n'a pas de sens → on ne l'affiche pas.
      searchFields: (o) => [o.name, faceLbl(o.face), o.face === "autre" ? "libre" : (o.u_height || 1) + "U", o.description],
      columns: [
        { head: I18n.t("lists.col.preview"), render: (o) => o.url ? `<span class="cell-fithumb"><img src="${o.url}" alt="" /></span>` : dim("—") },
        { head: I18n.t("lists.col.name"), cls: "cell-name", sortKey: "name", sort: (o) => o.name || "", render: (o) => Html.escape(o.name || I18n.t("lists.ph.noName")) },
        { head: I18n.t("lists.col.height"), cls: "cell-num", sort: (o) => (o.face === "autre" ? -1 : (o.u_height || 1)), render: (o) => o.face === "autre" ? dim(I18n.t("lists.ph.free")) : `<span class="pill">${o.u_height || 1} U</span>` },
        {
          head: I18n.t("lists.col.face"), sortKey: "face", sort: (o) => faceLbl(o.face), render: (o) => `<span class="pill">${Html.escape(faceLbl(o.face))}</span>`,
          filter: { label: I18n.t("lists.col.face"), options: () => [{ id: "front", label: I18n.t("domain.equipFace.front") }, { id: "rear", label: I18n.t("domain.equipFace.rear") }, { id: "autre", label: I18n.t("lists.opt.faceOther") }], valueOf: (o) => o.face || "front" },
        },
        { head: I18n.t("lists.col.usages"), cls: "cell-num", sort: (o) => store.faceImageUsageCount(o.id), render: (o) => `<span class="pill">${store.faceImageUsageCount(o.id)}</span>` },
        { head: I18n.t("lists.col.description"), cls: "cell-desc", render: descCell },
      ],
    };
  }

  static cables(store: Store, entitySearch: EntitySearchReader | null = null): ListOptions {
    return {
      collection: "cables",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: I18n.t("lists.empty.cables"),
      // Filtre CIBLE : « les câbles de cet ÉQUIPEMENT ». Le rattachement passe par ses PORTS (2 sauts) —
      // restriction CLIENTE, asymétrie assumée v1 (cf. `views/ListTargets` et docs/recherche.md). La
      // recherche de CANDIDATS, elle, est serveur-pilotée en mode API (`entitySearch`), locale en fichier.
      targetFilter: ListTargets.cableEquipment(store, entitySearch),
      columns: [
        { head: I18n.t("lists.col.name"), essential: true, cls: "cell-name", sortKey: "name", sort: (c) => c.name, render: (c) => Html.escape(c.name || I18n.t("lists.ph.cable")) },
        { head: I18n.t("lists.col.type"), render: (c) => { const t: any = c.cable_type_id && store.get("cableTypes", c.cable_type_id); return t ? `<span class="pill">${Html.escape(t.name)}</span>` : dim("—"); } },
        { head: I18n.t("lists.col.link"), essential: true, render: (c) => EntityViz.cableLink(store, c) },
        { head: I18n.t("lists.col.lengthShort"), cls: "cell-num", sort: (c) => { const L = ListConfigs._cableLen(store, c); return L != null ? L : -1; }, render: (c) => { const L = ListConfigs._cableLen(store, c); return L != null ? L + " m" : dim("—"); } },
        {
          head: I18n.t("lists.col.status"), essential: true, sortKey: "status", sort: (c) => c.status, render: (c) => Html.escape(CableStatuses.label(c.status)),
          filter: { label: I18n.t("lists.col.status"), options: () => CableStatuses.ALL.map((s) => ({ id: s.id, label: I18n.t(s.labelKey) })), valueOf: (c) => c.status },
        },
        {
          head: I18n.t("lists.col.networks"), render: (c) => { const ns = ListConfigs._cableNets(store, c); return ns.length ? ns.map((n: any) => swatch(n.color) + Html.escape(n.label || I18n.t("lists.ph.network"))).join(" ") : dim("—"); },
          filter: { label: I18n.t("lists.col.network"), options: () => store.all("networks").map((n: any) => ({ id: n.id, label: n.label || I18n.t("lists.ph.network") })), valueOf: (c) => store.cableNetworkIds(c) },
        },
        { head: I18n.t("lists.col.description"), cls: "cell-desc", sort: (c) => c.description || "", render: descCell },
      ],
    };
  }

  /** Faisceaux (trunks) : multi-fibres entre 2 patchs ; fibres piochées par les ports des patchs. */
  static cableBundles(store: Store): ListOptions {
    return {
      collection: "cableBundles",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: I18n.t("lists.empty.cableBundles"),
      columns: [
        { head: I18n.t("lists.col.name"), cls: "cell-name", sortKey: "name", sort: (b) => b.name, render: (b) => Html.escape(b.name || I18n.t("lists.ph.bundle")) },
        { head: I18n.t("lists.col.type"), render: (b) => { const t: any = b.cable_type_id && store.get("cableTypes", b.cable_type_id); return t ? `<span class="pill">${Html.escape(t.name)}</span>` : dim("—"); } },
        { head: I18n.t("lists.col.strands"), cls: "cell-num", render: (b) => { const o = store.bundleOccupancy(b.id); return o.used + " / " + o.capacity; } },
        { head: I18n.t("lists.col.length"), cls: "cell-num", sort: (b) => (b.length_m != null ? b.length_m : -1), render: (b) => (b.length_m != null ? b.length_m + " m" : dim("—")) },
        { head: I18n.t("lists.col.route"), render: (b) => { const n = (b.waypoint_ids || []).length; return n ? `<span class="pill">${I18n.t("lists.ph.points", { count: n })}</span>` : dim(I18n.t("lists.ph.direct")); } },
        { head: I18n.t("lists.col.description"), cls: "cell-desc", sort: (b) => b.description || "", render: descCell },
      ],
    };
  }

  /** Salles (datacenters) : grille au sol + nb de baies placées (table propre à cette app — pas de réf monolithe). */
  static datacenters(store: Store): ListOptions {
    return {
      collection: "datacenters",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: I18n.t("lists.empty.datacenters"),
      columns: [
        { head: I18n.t("lists.col.name"), cls: "cell-name", sortKey: "name", sort: (d) => d.name, render: (d) => Html.escape(d.name || I18n.t("lists.ph.room")) },
        { head: I18n.t("lists.col.dimensions"), render: (d) => (d.width_mm / 1000).toFixed(1) + " × " + (d.depth_mm / 1000).toFixed(1) + " m" },
        { head: I18n.t("lists.col.room"), render: (d) => (d.room ? Html.escape(d.room) : dim("—")) },
        { head: I18n.t("lists.col.racks"), cls: "cell-num", render: (d) => String(store.racksOfDc(d.id).length) },
      ],
    };
  }

  /** Sites / bâtiments (CRUD). La suppression passe par `removeSite` (décommissionnement) — câblée dans main. */
  static sites(store: Store): ListOptions {
    return {
      collection: "sites",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: I18n.t("lists.empty.sites"),
      actions: { view: false, edit: true, clone: false, del: true },
      columns: [
        { head: I18n.t("lists.col.name"), cls: "cell-name", sortKey: "name", sort: (s) => s.name, render: (s) => Html.escape(s.name || I18n.t("lists.ph.site")) },
        { head: I18n.t("lists.col.address"), render: (s) => (s.address ? Html.escape(s.address) : dim("—")) },
        { head: I18n.t("lists.col.floors"), cls: "cell-num", render: (s) => String(store.floorsOf(s.id).length) },
        { head: I18n.t("lists.col.rooms"), cls: "cell-num", render: (s) => String(store.all("datacenters").filter((d: any) => (d.location || "") === s.id).length) },
      ],
    };
  }

  /** Contacts — carnet de destinataires des NOTIFICATIONS (email/sms), référencés par le module notify.
      Collection hors graphe réseau (jamais dessinée) : liste nom · organisation · poste · e-mail ·
      téléphone · notes. */
  static contacts(store: Store): ListOptions {
    // Options de FILTRE « Organisation » : valeurs DISTINCTES et triées, calculées à la volée sur les
    // contacts DU CACHE (dynamiques — le mécanisme de filtres réévalue `options()` à chaque re-rendu,
    // cf. ListView._ensureToolbar). Même patron que le filtre « Hôte » du listing VMs (`static vms` ci-dessus) :
    // la correspondance porte sur la MÊME valeur que l'affichage, donc filtre et colonne ne peuvent pas se contredire.
    //
    // 🚨 GARDE G8 (chantier lazy-load, cf. docs/hydratation.md § « Vague 1 — contacts ») : en mode API,
    // `contacts` est chargée PARESSEUSEMENT — le cache ne contient alors que les pages déjà parcourues,
    // et cette facette ne propose donc QUE les organisations vues. C'est l'arbitrage n°4 assumé pour le
    // pilote (calcul « sur-page » plutôt que `SELECT DISTINCT` serveur) : la collection est petite, et
    // les valeurs s'ACCUMULENT au fil de la navigation — jamais de chip qui disparaîtrait en changeant
    // de page. Les collections VOLUMINEUSES de la vague 3 (wifiClients) auront, elles, le distinct
    // serveur. En mode fichier — et pour toute collection hydratée — c'est tout le document, inchangé.
    const organizationOptions = (): { id: string; label: string }[] => {
      const s = new Set<string>();
      store.all("contacts").forEach((c: any) => { if (c.organization) s.add(c.organization); });
      return [...s].sort().map((o) => ({ id: o, label: o }));
    };
    // `sortField` (PILOTE de la pagination ORDONNÉE complète, lot 1b — cf. ListColumn.sortField) : chaque
    // accesseur `sort` de ce listing lit UN champ scalaire du modèle → il le déclare, et en régime pagé
    // le critère ordonne le CORPUS entier via l'ORDER BY serveur (plus seulement la page reçue).
    return {
      collection: "contacts",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: I18n.t("lists.empty.contacts"),
      actions: { view: true, edit: true, clone: false, del: true },   // clone sans objet pour un destinataire unique
      columns: [
        { head: I18n.t("lists.col.name"), essential: true, cls: "cell-name", sortKey: "name", sort: (c) => c.name, sortField: "name", render: (c) => Html.escape(c.name || I18n.t("lists.ph.contact")) },
        {
          head: I18n.t("lists.col.organization"), sortKey: "organization", sort: (c) => c.organization || "", sortField: "organization",
          render: (c) => (c.organization ? Html.escape(c.organization) : dim("—")),
          filter: { label: I18n.t("lists.col.organization"), options: organizationOptions, valueOf: (c) => c.organization || "" },
        },
        { head: I18n.t("lists.col.position"), sortKey: "position", sort: (c) => c.position || "", sortField: "position", render: (c) => (c.position ? Html.escape(c.position) : dim("—")) },
        { head: I18n.t("lists.col.email"), sortKey: "email", sort: (c) => c.email || "", sortField: "email", render: (c) => (c.email ? Html.mailtoLink(c.email) : dim("—")) },
        { head: I18n.t("lists.col.phone"), render: (c) => (c.phone ? Html.escape(c.phone) : dim("—")) },
        { head: I18n.t("lists.col.notes"), cls: "cell-desc", sort: (c) => c.notes || "", sortField: "notes", render: (c) => (c.notes ? Html.escape(String(c.notes).slice(0, 80)) : dim("—")) },
      ],
    };
  }

  /** Plans d'étage (CRUD). Édition/création via `Forms.floor` (location + étage) — câblée dans main. */
  static floors(store: Store): ListOptions {
    return {
      collection: "floors",
      defaultSort: { key: "loc", dir: "asc" },
      emptyText: I18n.t("lists.empty.floors"),
      actions: { view: false, edit: true, clone: false, del: true },
      columns: [
        { head: I18n.t("lists.col.building"), cls: "cell-name", sortKey: "loc", sort: (f) => store.siteLabel(f.location), render: (f) => Html.escape(store.siteLabel(f.location)) },
        { head: I18n.t("lists.col.floor"), sortKey: "fl", sort: (f) => FloorLayout.floorNum(String(f.floor || "")), render: (f) => I18n.t("lists.ph.floorLabel", { n: (f.floor != null && f.floor !== "" ? f.floor : "0") }) },
        { head: I18n.t("lists.col.dimensions"), render: (f) => ((f.width_mm || 0) / 1000).toFixed(1) + " × " + ((f.depth_mm || 0) / 1000).toFixed(1) + " m" },
        { head: I18n.t("lists.col.rooms"), cls: "cell-num", render: (f) => String(store.dcsOfFloor(f.location, String(f.floor || "")).length) },
      ],
    };
  }

  static racks(store: Store): ListOptions {
    const scene = new RackScene(store);
    return {
      collection: "racks",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: I18n.t("lists.empty.racks"),
      columns: [
        { head: I18n.t("lists.col.name"), cls: "cell-name", sortKey: "name", sort: (r) => r.name, render: (r) => Html.escape(r.name || I18n.t("lists.ph.rack")) },
        {
          head: I18n.t("lists.col.location"), sortKey: "loc", sort: (r) => ListConfigs._rackLocText(store, r),
          render: (r) => EntityViz.rackLocation(store, r),
          filter: { label: I18n.t("lists.filter.room"), options: () => store.all("datacenters").map((d: any) => ({ id: d.id, label: d.name || I18n.t("lists.ph.room") })), valueOf: (r) => r.datacenter_id || "__none__" },
        },
        { head: I18n.t("lists.col.size"), cls: "cell-num", sortKey: "u", sort: (r) => r.u_count, render: (r) => `<span class="pill">${r.u_count} U</span>` },
        { head: I18n.t("lists.col.depth"), cls: "cell-num", sort: (r) => r.depth, render: (r) => `<span class="pill">${r.depth} mm</span>` },
        {
          head: I18n.t("lists.col.faces"), sortKey: "faces", sort: (r) => r.sides, render: (r) => `<span class="pill">${r.sides === "dual" ? I18n.t("lists.opt.dual") : I18n.t("lists.opt.single")}</span>`,
          filter: { label: I18n.t("lists.col.faces"), options: () => [{ id: "single", label: I18n.t("lists.opt.single") }, { id: "dual", label: I18n.t("lists.opt.dual") }], valueOf: (r) => (r.sides === "dual" ? "dual" : "single") },
        },
        { head: I18n.t("lists.col.occupied"), cls: "cell-num", sort: (r) => scene.occupancyCount(r.id), render: (r) => `<span class="pill">${scene.occupancyCount(r.id)}</span>` },
        { head: I18n.t("lists.col.free"), cls: "cell-num", sort: (r) => scene.freeUInfo(r.id).free, render: (r) => { const f = scene.freeUInfo(r.id); return `<span class="pill">${f.free} U</span>`; } },
        { head: I18n.t("lists.col.contig"), cls: "cell-num", sort: (r) => scene.freeUInfo(r.id).contig, render: (r) => `<span class="pill">${scene.freeUInfo(r.id).contig} U</span>` },
      ],
    };
  }

  /** Catalogue fermé (lecture seule) : types de port. */
  static portTypes(store: Store): ListOptions {
    return {
      collection: "portTypes",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: I18n.t("lists.empty.portTypes"),
      actions: { view: true },
      columns: [
        { head: I18n.t("lists.col.name"), cls: "cell-name", sortKey: "name", sort: (t) => t.name, render: (t) => Html.escape(t.name) },
        {
          head: I18n.t("lists.col.kind"), sortKey: "kind", sort: (t) => t.kind, render: (t) => kindPill(t.kind),
          filter: { label: I18n.t("lists.col.kind"), options: () => [{ id: "data", label: I18n.t("lists.opt.dataFilter") }, { id: "power", label: I18n.t("lists.opt.powerFilter") }], valueOf: (t) => (t.kind === "power" ? "power" : "data") },
        },
        { head: I18n.t("lists.col.roles"), render: (t) => PortRoles.forKind(t.kind).map((r) => `<span class="pill">${Html.escape(I18n.t(r.labelKey))}</span>`).join(" ") },
        {
          head: I18n.t("lists.col.family"), sortKey: "family", sort: (t) => t.family, render: (t) => `<span class="pill">${Html.escape(t.family || "—")}</span>`,
          filter: { label: I18n.t("lists.col.family"), options: () => ListConfigs._families(store, "portTypes"), valueOf: (t) => t.family },
        },
        { head: I18n.t("lists.col.connector"), render: (t) => Html.escape(t.connector || t.family || "—") + (t.duplex ? ` <span class="pill">duplex</span>` : "") },
        { head: I18n.t("lists.col.speed"), render: (t) => (t.speed ? Html.escape(t.speed) : dim("—")) },
        { head: I18n.t("lists.col.ports"), cls: "cell-num", sort: (t) => store.portsOfType(t.id).length, render: (t) => `<span class="pill">${store.portsOfType(t.id).length}</span>` },
        { head: I18n.t("lists.col.description"), cls: "cell-desc", sort: (t) => t.description || "", render: descCell },
      ],
    };
  }

  /** Catalogue fermé (lecture seule) : types de câble. */
  static cableTypes(store: Store): ListOptions {
    return {
      collection: "cableTypes",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: I18n.t("lists.empty.cableTypes"),
      actions: { view: true },
      columns: [
        { head: I18n.t("lists.col.name"), cls: "cell-name", sortKey: "name", sort: (t) => t.name, render: (t) => Html.escape(t.name) },
        {
          head: I18n.t("lists.col.kind"), sortKey: "kind", sort: (t) => t.kind, render: (t) => kindPill(t.kind),
          filter: { label: I18n.t("lists.col.kind"), options: () => [{ id: "data", label: I18n.t("lists.opt.dataFilter") }, { id: "power", label: I18n.t("lists.opt.powerFilter") }], valueOf: (t) => (t.kind === "power" ? "power" : "data") },
        },
        {
          head: I18n.t("lists.col.familyPort"), sortKey: "family", sort: (t) => t.family, render: (t) => `<span class="pill">${Html.escape(t.family || "—")}</span>`,
          filter: { label: I18n.t("lists.col.family"), options: () => ListConfigs._families(store, "cableTypes"), valueOf: (t) => t.family },
        },
        { head: I18n.t("lists.col.medium"), render: (t) => Html.escape(t.medium || "—") },
        { head: I18n.t("lists.col.cables"), cls: "cell-num", sort: (t) => store.cablesOfType(t.id).length, render: (t) => `<span class="pill">${store.cablesOfType(t.id).length}</span>` },
        { head: I18n.t("lists.col.description"), cls: "cell-desc", sort: (t) => t.description || "", render: descCell },
      ],
    };
  }

  static ipNetworks(store: Store): ListOptions {
    return {
      collection: "ipNetworks",
      defaultSort: { key: "label", dir: "asc" },
      emptyText: I18n.t("lists.empty.ipNetworks"),
      columns: [
        { head: I18n.t("lists.col.label"), cls: "cell-name", sortKey: "label", sort: (n) => n.label, render: (n) => Html.escape(n.label || I18n.t("lists.ph.noLabel")) },
        { head: "CIDR", sortKey: "cidr", sort: (n) => n.cidr, render: (n) => (n.cidr ? `<code>${Html.escape(n.cidr)}</code>` : dim("—")) },
        { head: I18n.t("lists.col.addresses"), cls: "cell-num", sort: (n) => store.ipAddressesOfNetwork(n.id).length, render: (n) => `<span class="pill">${store.ipAddressesOfNetwork(n.id).length}</span>` },
        { head: I18n.t("lists.col.dhcpRanges"), cls: "cell-num", sort: (n) => store.dhcpRangesOfNetwork(n.id).length, render: (n) => `<span class="pill">${store.dhcpRangesOfNetwork(n.id).length}</span>` },
        { head: I18n.t("lists.col.logicalNetworks"), cls: "cell-num", sort: (n) => store.networksOfIpNetwork(n.id).length, render: (n) => { const ns = store.networksOfIpNetwork(n.id); return ns.length ? `<span class="pill">${ns.length}</span>` : dim("—"); } },
        { head: I18n.t("lists.col.description"), cls: "cell-desc", sort: (n) => n.description || "", render: descCell },
      ],
    };
  }

  static ipAddresses(store: Store, entitySearch: EntitySearchReader | null = null): ListOptions {
    return {
      collection: "ipAddresses",
      defaultSort: { key: "address", dir: "asc" },
      emptyText: I18n.t("lists.empty.ipAddresses"),
      // Filtre CIBLE : « les adresses de ce PORTEUR » — équipement OU VM, familles confondues dans UNE
      // recherche (principe n°14). Le lien est une colonne → le filtre part au serveur en `where`. La
      // recherche de CANDIDATS, elle, est serveur-pilotée en mode API (`entitySearch`), locale en fichier.
      targetFilter: ListTargets.ipCarrier(store, entitySearch),
      columns: [
        { head: I18n.t("lists.col.address"), essential: true, cls: "cell-name", sortKey: "address", sort: (a) => { const v = Ip.toInt(a.address); return v != null ? v : a.address; }, render: (a) => `<code>${Html.escape(a.address || "—")}</code>` },
        {
          head: I18n.t("lists.col.network"), essential: true, sortKey: "net", sort: (a) => { const n: any = a.network_id && store.get("ipNetworks", a.network_id); return n ? (n.label || n.cidr || "") : ""; },
          render: (a) => { const n: any = a.network_id && store.get("ipNetworks", a.network_id); return n ? Html.escape(n.label || n.cidr || I18n.t("lists.ph.network")) : dim("—"); },
          filter: { label: I18n.t("lists.col.network"), options: () => store.all("ipNetworks").map((n: any) => ({ id: n.id, label: n.label || n.cidr || I18n.t("lists.ph.network") })), valueOf: (a) => a.network_id || "__none__" },
        },
        { head: I18n.t("lists.col.hostname"), sort: (a) => a.hostname || "", render: (a) => (a.hostname ? `<span style="font-family:var(--mono)">${Html.escape(a.hostname)}</span>` : dim("—")) },
        {
          head: I18n.t("lists.col.equipment"), essential: true, sortKey: "eq", sort: (a) => { const e: any = a.equipment_id && store.get("equipments", a.equipment_id); return e ? (e.name || "") : ""; },
          render: (a) => { const e: any = a.equipment_id && store.get("equipments", a.equipment_id); return e ? Html.escape(e.name || I18n.t("lists.ph.equipment")) : dim(I18n.t("lists.ph.freeAddr")); },
          filter: { label: I18n.t("lists.col.equipment"), options: () => store.all("equipments").map((e: any) => ({ id: e.id, label: e.name || I18n.t("lists.ph.equipment") })), valueOf: (a) => a.equipment_id || "__none__" },
        },
        { head: I18n.t("lists.col.description"), cls: "cell-desc", sort: (a) => a.description || "", render: descCell },
      ],
    };
  }

  static dhcpRanges(store: Store): ListOptions {
    return {
      collection: "dhcpRanges",
      defaultSort: { key: "__created__", dir: "asc" },
      emptyText: I18n.t("lists.empty.dhcpRanges"),
      columns: [
        { head: I18n.t("lists.col.range"), essential: true, cls: "cell-name", sort: (d) => { const v = Ip.toInt(d.start_ip); return v != null ? v : (d.start_ip || ""); }, render: (d) => `<code>${Html.escape(d.start_ip || "?")}</code> → <code>${Html.escape(d.end_ip || "?")}</code>` },
        {
          head: I18n.t("lists.col.network"), essential: true, sortKey: "net", sort: (d) => { const n: any = d.network_id && store.get("ipNetworks", d.network_id); return n ? (n.label || n.cidr || "") : ""; },
          render: (d) => { const n: any = d.network_id && store.get("ipNetworks", d.network_id); return n ? Html.escape(n.label || n.cidr || I18n.t("lists.ph.network")) : dim("—"); },
          filter: { label: I18n.t("lists.col.network"), options: () => store.all("ipNetworks").map((n: any) => ({ id: n.id, label: n.label || n.cidr || I18n.t("lists.ph.network") })), valueOf: (d) => d.network_id || "__none__" },
        },
        { head: I18n.t("lists.col.size"), cls: "cell-num", sort: (d) => { const a = Ip.toInt(d.start_ip), b = Ip.toInt(d.end_ip); return (a != null && b != null && b >= a) ? (b - a + 1) : -1; }, render: (d) => { const a = Ip.toInt(d.start_ip), b = Ip.toInt(d.end_ip); return (a != null && b != null && b >= a) ? `<span class="pill">${I18n.t("lists.ph.addrCount", { count: b - a + 1 })}</span>` : dim("—"); } },
        {
          head: I18n.t("lists.col.dhcpServer"), essential: true, sortKey: "srv", sort: (d) => { const e: any = d.server_id && store.get("equipments", d.server_id); return e ? (e.name || "") : ""; },
          render: (d) => { const e: any = d.server_id && store.get("equipments", d.server_id); return e ? Html.escape(e.name || I18n.t("lists.ph.server")) : dim(I18n.t("lists.ph.notDesignated")); },
          filter: { label: I18n.t("lists.filter.server"), options: () => store.all("equipments").map((e: any) => ({ id: e.id, label: e.name || I18n.t("lists.ph.equipment") })), valueOf: (d) => d.server_id || "__none__" },
        },
        { head: I18n.t("lists.col.description"), cls: "cell-desc", sort: (d) => d.description || "", render: descCell },
      ],
    };
  }

  /* ---- helpers de rendu transverses ---- */

  /** Texte court de l'emplacement d'un équipement (rack / latéral / mural / étage / salle libre).
      NB : sert de CLÉ DE TRI (non rendue — le rendu passe par EntityViz.equipmentLocation, hors lot B2a). */
  private static _placeText(store: Store, e: any): string {
    if (e.placement_mode === "rack") {
      if (!e.rack_id) return "Non placé";
      const r: any = store.get("racks", e.rack_id);
      return "Rack " + ((r && r.name) || "?") + (e.rack_u != null ? " · U" + e.rack_u : "");
    }
    if (e.placement_mode === "side" || e.placement_mode === "wall") {
      const r: any = store.get("racks", e.rack_id);
      return (e.placement_mode === "side" ? "Latéral " : "Mural ") + ((r && r.name) || "?");
    }
    if (e.placement_mode === "floor") return "Étage";
    if (e.dim_mode === "free" && e.dc_id) { const d: any = store.get("datacenters", e.dc_id); return "Salle " + ((d && d.name) || "?"); }
    return "";
  }

  /** Bits d'emplacement d'une baie (Lieu · Étage · Salle), hérités de son datacenter.
      NB : CLÉ DE TRI (non rendue — le rendu passe par EntityViz.rackLocation, hors lot B2a). */
  private static _rackLocText(store: Store, r: any): string {
    const d: any = r.datacenter_id && store.get("datacenters", r.datacenter_id);
    if (d) return [store.siteLabel(d.location), d.floor ? "ét. " + d.floor : "", d.room || d.name || ""].filter(Boolean).join(" · ");
    return [r.room].filter(Boolean).join(" · ");
  }

  /** Longueur d'un câble (null = non renseignée). */
  private static _cableLen(_store: Store, c: any): number | null {
    return (c.length_m != null) ? c.length_m : null;
  }

  /** Réseaux (objets) d'un câble. */
  private static _cableNets(store: Store, c: any): any[] {
    return store.cableNetworkIds(c).map((id) => store.get("networks", id)).filter(Boolean);
  }

  /** Inventaire de SPARES (pièces de rechange, suivi unitaire — hors graphe réseau). */
  static spares(store: Store): ListOptions {
    const assignedTo = (o: any): string => {
      if (o.status !== "assigned") return "";
      if (o.assigned_equipment_id) { const e: any = store.get("equipments", o.assigned_equipment_id); return e ? (e.name || I18n.t("lists.ph.equipment")) : I18n.t("lists.ph.equipDeleted"); }
      return o.assigned_free || "";
    };
    return {
      collection: "spares",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: I18n.t("lists.empty.spares"),
      columns: [
        { head: I18n.t("lists.col.designation"), essential: true, cls: "cell-name", sortKey: "name", sort: (o) => (o.displayName ? o.displayName() : (o.name || "")), render: (o) => Html.escape(o.displayName ? o.displayName() : (o.name || I18n.t("lists.ph.spare"))) + (o.serial ? " " + dim("· SN " + Html.escape(o.serial)) : "") },
        {
          head: I18n.t("lists.col.type"), essential: true, sortKey: "type", sort: (o) => SpareTypes.label(o.type), render: (o) => `<span class="pill">${SpareTypes.svg(o.type)}${Html.escape(SpareTypes.label(o.type))}</span>`,
          filter: { label: I18n.t("lists.col.type"), options: () => SpareTypes.ALL.map((t) => ({ id: t.id, label: I18n.t(t.labelKey) })), valueOf: (o) => o.type },
        },
        { head: I18n.t("lists.col.characteristics"), render: (o) => { const t = o.techSummary ? o.techSummary() : ""; return t ? Html.escape(t) : dim("—"); } },
        {
          head: I18n.t("lists.col.status"), essential: true, sortKey: "status", sort: (o) => SpareStatuses.label(o.status), render: (o) => `<span class="pill">${Html.escape(SpareStatuses.label(o.status))}</span>`,
          filter: { label: I18n.t("lists.col.status"), options: () => SpareStatuses.ALL.map((s) => ({ id: s.id, label: I18n.t(s.labelKey) })), valueOf: (o) => o.status },
        },
        { head: I18n.t("lists.col.assignedTo"), sort: (o) => assignedTo(o), render: (o) => { const t = assignedTo(o); return t ? Html.escape(t) : dim("—"); } },
        { head: I18n.t("lists.col.storage"), render: (o) => (o.storage_location ? Html.escape(o.storage_location) : dim("—")) },
        { head: I18n.t("lists.col.purchase"), cls: "cell-num", sortKey: "purchase", sort: (o) => o.purchase_date || "", render: (o) => (o.purchase_date ? Html.escape(o.purchase_date) : dim("—")) },
      ],
    };
  }

  /** Équipements VIRTUELS (VMs QEMU / conteneurs LXC) — collection ALIMENTÉE PAR LA SYNCHRO d'un cluster
      (Proxmox en 1re implémentation). Liste en LECTURE : champs SOURCE (nom, type, statut, hôte, vNIC, IPs, tags).
      Pas de création/édition depuis la liste en v1 (`actions: { view: true }` + aucun `form` sur l'onglet) :
      les VMs viennent de la synchro ; l'enrichissement des champs LOCAUX passera par la fiche (T3.2). */
  static vms(store: Store): ListOptions {
    // Hôte hébergeur : nom de l'équipement RÉSOLU (host_equipment_id, rapproché au sync) sinon le nom de nœud
    // BRUT du provider (host_node) — qui reste informatif tant que le rapprochement par nom n'a pas eu lieu.
    const hostText = (v: any): string => {
      const e: any = v.host_equipment_id && store.get("equipments", v.host_equipment_id);
      if (e) return e.name || I18n.t("lists.ph.equipment");
      return v.host_node || "";
    };
    // IPs de TOUTES les vNIC, aplaties + dédoublonnées dans l'ordre de découverte (donnée SOURCE informative).
    const vmIps = (v: any): string[] => {
      const out: string[] = [];
      (v.nics || []).forEach((n: any) => (n && Array.isArray(n.ips) ? n.ips : []).forEach((ip: string) => { if (ip && !out.includes(ip)) out.push(ip); }));
      return out;
    };
    // Pastilles de STATUT (orphelinat + statut source) : règle unique dans `core/VmStatus`, partagée avec la
    // FICHE VM (`DetailForms.vmDetail`) et la bulle d'équipement (`core/VmHostTip`) — les trois en redisaient
    // chacun sa version. Le listing ne pose PAS de `title` sur la pastille « orpheline » : la colonne est
    // étroite et la pastille y est répétée à chaque ligne (la fiche, elle, l'explicite).
    // Options de FILTRE calculées à la volée sur les vms DU DOCUMENT (dynamiques : elles suivent la synchro —
    // le mécanisme de filtres réévalue `options()` à chaque re-rendu, cf. ListView._ensureToolbar).
    // Tags : union TRIÉE des tags_src portés par au moins une VM. Le filtre est une APPARTENANCE (valueOf renvoie
    // le tableau de tags de la VM → correspondance « la VM porte le tag », comme le filtre « Groupe » des équipements).
    const tagOptions = (): { id: string; label: string }[] => {
      const s = new Set<string>();
      store.all("vms").forEach((v: any) => (v.tags_src || []).forEach((t: string) => { if (t) s.add(t); }));
      return [...s].sort().map((t) => ({ id: t, label: t }));
    };
    // Hôte : valeurs DISTINCTES et triées de la colonne Hôte (nom d'équipement résolu, sinon nœud brut). La
    // correspondance porte sur la MÊME valeur que l'affichage (hostText) → filtre et colonne restent cohérents.
    const hostOptions = (): { id: string; label: string }[] => {
      const s = new Set<string>();
      store.all("vms").forEach((v: any) => { const h = hostText(v); if (h) s.add(h); });
      return [...s].sort().map((h) => ({ id: h, label: h }));
    };
    return {
      collection: "vms",
      defaultSort: { key: "name", dir: "asc" },
      actions: { view: true },   // lecture seule : alimentée par la synchro (ni + créer, ni éditer/cloner/supprimer en v1)
      emptyText: I18n.t("lists.empty.vms"),
      columns: [
        { head: I18n.t("lists.col.name"), essential: true, cls: "cell-name", sortKey: "name", sort: (v) => v.name, render: (v) => Html.escape(v.name || I18n.t("lists.ph.vm")) },
        {
          head: I18n.t("lists.col.type"), essential: true, sortKey: "type", sort: (v) => v.vm_type,
          render: (v) => (v.vm_type ? `<span class="pill">${Html.escape(v.vm_type)}</span>` : dim("—")),
          filter: { label: I18n.t("lists.col.type"), options: () => [{ id: "qemu", label: "QEMU" }, { id: "lxc", label: "LXC" }], valueOf: (v) => v.vm_type },
        },
        // tri : orphelines groupées à part, puis par statut (l'orphelinat est l'info dominante de la colonne).
        { head: I18n.t("lists.col.status"), essential: true, sortKey: "status", sort: (v) => VmStatus.sortKey(v), render: (v) => VmStatus.pills(v) },
        {
          head: I18n.t("lists.col.host"), essential: true, sortKey: "host", sort: (v) => hostText(v),
          render: (v) => { const t = hostText(v); return t ? Html.escape(t) : dim("—"); },
          filter: { label: I18n.t("lists.col.host"), options: hostOptions, valueOf: (v) => hostText(v) },
        },
        { head: "vNIC", cls: "cell-num", sort: (v) => (v.nics || []).length, render: (v) => `<span class="pill">${(v.nics || []).length}</span>` },
        {
          head: "IPs", sort: (v) => vmIps(v)[0] || "",
          render: (v) => { const ips = vmIps(v); if (!ips.length) return dim("—"); const shown = ips.slice(0, 3).map((ip) => `<code>${Html.escape(ip)}</code>`).join(", "); return shown + (ips.length > 3 ? " " + dim("+" + (ips.length - 3)) : ""); },
        },
        {
          head: I18n.t("lists.col.tags"), render: (v) => { const ts: string[] = v.tags_src || []; return ts.length ? ts.map((t) => `<span class="pill">${Html.escape(t)}</span>`).join(" ") : dim("—"); },
          // filtre par APPARTENANCE (la VM porte le tag) — valueOf renvoie un tableau, comme la colonne Groupe des équipements.
          filter: { label: I18n.t("lists.col.tags"), options: tagOptions, valueOf: (v) => v.tags_src || [] },
        },
      ],
    };
  }

  /** CLIENTS WIFI — collection ALIMENTÉE PAR LA SYNCHRO d'un contrôleur (UniFi en 1re
      implémentation ; la marque n'est qu'un adaptateur serveur, cf. docs/wifi-unifi.md).
      Liste en LECTURE (`actions: { view: true }` + aucun `form` sur l'onglet) : les clients
      viennent de la synchro, l'enrichissement des champs LOCAUX (notes) passe par la fiche.
      ⚠ Le champ `orphan` s'AFFICHE « déconnecté » (décision D2 : l'API ne liste que les clients
      connectés — partir est ordinaire). La règle de présence vit dans `core/WifiStatus`, partagée
      avec la fiche : on ne la réécrit pas ici. */
  static wifiClients(store: Store): ListOptions {
    // Point d'accès : nom de l'équipement RÉSOLU (ap_equipment_id, rapproché au sync) sinon le nom
    // d'AP BRUT du contrôleur (ap_name) — informatif tant que le rapprochement par nom n'a pas eu lieu.
    const apText = (c: any): string => {
      const e: any = c.ap_equipment_id && store.get("equipments", c.ap_equipment_id);
      if (e) return e.name || I18n.t("lists.ph.equipment");
      return c.ap_name || "";
    };
    // Options de FILTRE calculées à la volée sur les clients DU DOCUMENT (dynamiques : elles suivent
    // la synchro — le mécanisme de filtres réévalue `options()` à chaque re-rendu). Même patron que
    // les filtres « Hôte »/« Tags » du listing VMs : la correspondance porte sur la MÊME valeur que
    // l'affichage, donc filtre et colonne ne peuvent pas se contredire.
    //
    // 🚨 GARDE G8 (chantier lazy-load, VAGUE 3 — cf. docs/hydratation.md) : en mode API, `wifiClients`
    // est chargée PARESSEUSEMENT, et ce balayage ne verrait alors que les pages parcourues. C'est LA
    // collection pour laquelle l'arbitrage n°4 a tranché le `SELECT DISTINCT` SERVEUR (elle est
    // alimentée par une synchro : son corpus est le plus volumineux de l'app, et le calcul « sur-page »
    // des petites collections n'y a plus de sens). Le basculement est déclaré par `filter.field` —
    // le NOM DU CHAMP scalaire que lit `valueOf` — et opéré par `ListView` ; ces `options()` restent
    // le chemin des collections HYDRATÉES et du mode fichier, où elles sont exactes.
    const distinct = (valueOf: (c: any) => string) => (): { id: string; label: string }[] => {
      const s = new Set<string>();
      store.all("wifiClients").forEach((c: any) => { const v = valueOf(c); if (v) s.add(v); });
      return [...s].sort().map((v) => ({ id: v, label: v }));
    };
    // `sortField` (pagination ORDONNÉE complète, lot 1b — cf. `ListColumn.sortField`) : déclaré par les
    // seules colonnes dont l'accesseur `sort` lit UN champ scalaire du modèle. TROIS colonnes n'en
    // déclarent pas, chacune pour une raison MESURÉE, et le repli (tri de la page reçue, découpe à
    // l'ordre serveur par défaut) est assumé :
    //  - « Nom » trie sur `WifiClient.displayName` = nom SINON MAC (le repli est le cas NOMINAL côté
    //    wifi) : aucune colonne SQL ne porte cette expression, et trier sur `name` seul grouperait à
    //    l'extrémité tous les clients sans hostname alors que la colonne affiche leur MAC — un ordre
    //    visiblement faux, pire qu'un repli. ⚠ C'est le critère par DÉFAUT du listing (cf. docs) ;
    //  - « Type » trie sur la présence PUIS le type (`WifiStatus.sortKey` + `rawType`) : deux colonnes ;
    //  - « IP » trie sur l'ENTIER de l'adresse (`Ip.toInt`) ; la colonne est du TEXT, dont l'ordre
    //    lexicographique met « 10.0.0.10 » avant « 10.0.0.9 » — le contraire de ce que la vue montre ;
    //  - « AP » résout un nom d'ÉQUIPEMENT par jointure CLIENTE (même repli que « Hébergée sur »).
    return {
      collection: "wifiClients",
      defaultSort: { key: "name", dir: "asc" },
      actions: { view: true },   // lecture seule : alimentée par la synchro (ni + créer, ni éditer/cloner/supprimer)
      emptyText: I18n.t("lists.empty.wifiClients"),
      columns: [
        // Nom : repli sur la MAC (un client sans hostname est le cas NOMINAL) — règle UNIQUE
        // `WifiClient.displayName`, partagée avec la fiche et la palette de recherche.
        {
          head: I18n.t("lists.col.name"), essential: true, cls: "cell-name", sortKey: "name",
          sort: (c) => WifiClient.displayName(c),
          render: (c) => { const label = WifiClient.displayName(c); return label ? Html.escape(label) : dim(I18n.t("lists.ph.noName")); },
        },
        // Type de raccordement + pastille « déconnecté » (la présence est l'info dominante).
        {
          head: I18n.t("lists.col.type"), essential: true, sortKey: "type",
          sort: (c) => WifiStatus.sortKey(c) + "_" + WifiStatus.rawType(c),
          render: (c) => WifiStatus.pills(c),
          // `field` : `valueOf` lit le champ scalaire `client_type` → facette SERVEUR en régime pagé (G8).
          filter: { label: I18n.t("lists.col.type"), options: distinct((c) => WifiStatus.rawType(c)), valueOf: (c) => WifiStatus.rawType(c), field: "client_type" },
        },
        { head: "IP", essential: true, sortKey: "ip", sort: (c) => Ip.toInt(c.ip) || 0, render: (c) => (c.ip ? `<code>${Html.escape(c.ip)}</code>` : dim("—")) },
        { head: "MAC", sortKey: "mac", sort: (c) => c.mac || "", sortField: "mac", render: (c) => (c.mac ? `<code>${Html.escape(c.mac)}</code>` : dim("—")) },
        {
          head: I18n.t("lists.col.ssid"), sortKey: "ssid", sort: (c) => c.ssid || "", sortField: "ssid",
          render: (c) => (c.ssid ? `<span class="pill">${Html.escape(c.ssid)}</span>` : dim("—")),
          filter: { label: I18n.t("lists.col.ssid"), options: distinct((c) => c.ssid || ""), valueOf: (c) => c.ssid || "", field: "ssid" },
        },
        {
          head: I18n.t("lists.col.accessPoint"), essential: true, sortKey: "ap", sort: (c) => apText(c),
          render: (c) => { const t = apText(c); return t ? Html.escape(t) : dim("—"); },
          // PAS de `field` : `valueOf` rend le nom de l'ÉQUIPEMENT rapproché (jointure CLIENTE sur
          // `ap_equipment_id`), et retombe sur `ap_name` seulement à défaut. Un DISTINCT sur `ap_name`
          // rendrait donc des valeurs qui ne correspondraient pas à celles que la colonne AFFICHE
          // (casse et espaces du contrôleur, borne renommée dans DC Manager) : le filtre se croirait
          // posé et ne matcherait rien. Repli assumé — options du cache, comme la vague 1.
          filter: { label: I18n.t("lists.col.accessPoint"), options: distinct(apText), valueOf: (c) => apText(c) },
        },
        // Connecté depuis : horodatage ISO trié LEXICOGRAPHIQUEMENT (= chronologiquement, contrat
        // existant des colonnes de date du dépôt) et rendu localisé.
        { head: I18n.t("lists.col.connectedSince"), cls: "cell-num", sortKey: "since", sort: (c) => c.connected_since || "", sortField: "connected_since", render: (c) => (c.connected_since ? Html.escape(Format.dateTime(c.connected_since)) : dim("—")) },
      ],
    };
  }

  /** APPLICATIONS hébergées sur l'infrastructure — sous-onglet de l'onglet Équipements. Une application
      vise AU PLUS un hôte (équipement OU VM, patron `ipAddresses` — décision D1 du cadrage 2026-08-10).
      Le filtrage PAR HÔTE passe par la dimension CIBLE « Hébergée sur » (`targetFilter` →
      `ListTargets.applicationHost`, `where` serveur sur colonnes indexées) et non par un filtre-colonne —
      même arbitrage que le listing des sous-équipements (pas de doublon dimension/filtre-colonne). */
  static applications(store: Store, entitySearch: EntitySearchReader | null = null): ListOptions {
    // Hôte : nom de l'équipement OU de la VM résolu via le store. Trois états distincts à l'affichage :
    // résolu (nom), FK cassée → « (introuvable) » grisé (patron interventions : l'orphelin se voit, il ne
    // se déguise pas en « aucun hôte »), aucune FK → « — » grisé (les DEUX vides sont un état permis).
    const hostText = (a: any): string => {
      if (a.equipment_id) { const e: any = store.get("equipments", a.equipment_id); return e ? (e.name || I18n.t("lists.ph.equipment")) : ""; }
      if (a.vm_id) { const v: any = store.get("vms", a.vm_id); return v ? (v.name || I18n.t("lists.ph.vm")) : ""; }
      return "";
    };
    const hostCell = (a: any): string => {
      const t = hostText(a);
      if (t) return Html.escape(t);
      return (a.equipment_id || a.vm_id) ? dim(Html.escape(I18n.t("lists.ph.hostMissing"))) : dim("—");
    };
    // `sortField` (pagination ORDONNÉE complète, lot 1b — cf. `ListColumn.sortField`) : déclaré par les
    // colonnes dont l'accesseur `sort` lit UN champ scalaire du modèle, pour qu'en régime pagé (vague 2 :
    // `applications` est chargée PARESSEUSEMENT en mode API) le critère ordonne le CORPUS entier via
    // l'ORDER BY serveur. La colonne « Hébergée sur » en est DÉPOURVUE à dessein : son tri lit un nom
    // d'équipement/VM RÉSOLU par jointure côté client, qu'aucune colonne de `applications` ne porte —
    // repli assumé (l'ordre serveur par défaut découpe les pages, le critère trie la page affichée).
    // Aucune facette de colonne sur ce listing (G8 sans objet) : le filtrage par hôte passe par la
    // dimension CIBLE ci-dessous, traduite en `where` SERVEUR — donc juste sur corpus partiel.
    return {
      collection: "applications",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: I18n.t("lists.empty.applications"),
      actions: { view: true, edit: true, clone: false, del: true },   // clone sans objet pour une application nominative (parité contacts)
      // Filtre CIBLE « Hébergée sur » : équipement OU VM, familles confondues dans UNE recherche
      // (principe n°14). Le lien est une colonne → le filtre part au serveur en `where` ; la recherche
      // de CANDIDATS est serveur-pilotée en mode API (`entitySearch`), locale en mode fichier.
      targetFilter: ListTargets.applicationHost(store, entitySearch),
      columns: [
        { head: I18n.t("lists.col.name"), essential: true, cls: "cell-name", sortKey: "name", sort: (a) => a.name, sortField: "name", render: (a) => Html.escape(a.name || I18n.t("lists.ph.noName")) },
        { head: I18n.t("lists.col.host"), essential: true, sortKey: "host", sort: (a) => hostText(a), render: hostCell },
        // URL cliquable via la primitive UNIQUE `Html.externalLink` (liste blanche http/https + noopener) —
        // même patron d'affichage double listing/fiche que l'e-mail des contacts (`Html.mailtoLink`).
        { head: "URL", sortKey: "url", sort: (a) => a.url || "", sortField: "url", render: (a) => (a.url ? Html.externalLink(a.url) : dim("—")) },
        { head: I18n.t("lists.col.description"), cls: "cell-desc", sort: (a) => a.description || "", sortField: "description", render: descCell },
      ],
    };
  }

  /** PIÈCES JOINTES — sous-onglet de l'onglet Équipements. Une pièce vise AU PLUS une cible (équipement
      OU sous-équipement, patron `applications` — décision D2 du cadrage 2026-08-10). Colonnes : Libellé ·
      Cible résolue (patron de la colonne Hôte des applications) · Fichier (nom d'origine) · Taille (octets
      formatés, tri par octets bruts) · Description. Action `download` en plus de view/edit/del (le geste
      central). Le filtrage PAR CIBLE passe par la dimension « Attachée à » (`targetFilter` →
      `ListTargets.attachmentTarget`, `where` serveur sur colonnes indexées). */
  static attachments(store: Store, entitySearch: EntitySearchReader | null = null): ListOptions {
    // Cible : nom de l'équipement OU du sous-équipement résolu via le store. Trois états à l'affichage :
    // résolu (nom), FK cassée → « (introuvable) » grisé (l'orphelin se voit), aucune FK → « — » grisé.
    const targetText = (a: any): string => {
      if (a.equipment_id) { const e: any = store.get("equipments", a.equipment_id); return e ? (e.name || I18n.t("lists.ph.equipment")) : ""; }
      if (a.sub_equipment_id) { const se: any = store.get("subEquipments", a.sub_equipment_id); return se ? (se.name || I18n.t("subEquipment.fallback")) : ""; }
      return "";
    };
    const targetCell = (a: any): string => {
      const t = targetText(a);
      if (t) return Html.escape(t);
      return (a.equipment_id || a.sub_equipment_id) ? dim(Html.escape(I18n.t("lists.ph.hostMissing"))) : dim("—");
    };
    return {
      collection: "attachments",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: I18n.t("lists.empty.attachments"),
      // download = le geste central ; « show » (viewer) AVANT lui dans le menu, seulement si le type est
      // visualisable (`AttachmentViewKind` — image/texte/markdown/PDF ; ODT/DOCX/XLSX → pas de bouton) ;
      // clone sans objet (le binaire ne se duplique pas en v1).
      actions: {
        view: true, edit: true, clone: false, del: true, download: true,
        show: true, canShow: (id: string) => { const a: any = store.get("attachments", id); return !!a && AttachmentViewKind.kindOf(a.mime, a.file_name) !== null; },
      },
      // Filtre CIBLE « Attachée à » : équipement OU sous-équipement, familles confondues dans UNE recherche
      // (principe n°14). Le lien est une colonne → le filtre part au serveur en `where` ; les CANDIDATS sont
      // serveur-pilotés en mode API (`entitySearch`), locaux en mode fichier.
      targetFilter: ListTargets.attachmentTarget(store, entitySearch),
      // `sortField` : même règle que le listing `applications` ci-dessus (pagination ORDONNÉE complète du
      // lot 1b, `attachments` étant chargée PARESSEUSEMENT en mode API). La colonne « Attachée à » n'en
      // déclare PAS : elle trie sur un nom d'équipement/sous-équipement RÉSOLU par jointure cliente, que
      // la table `attachments` ne porte pas (repli assumé — cf. `ListColumn.sortField`). Aucune facette de
      // colonne ici non plus (G8 sans objet) : le filtrage par cible est la dimension CIBLE (`where` serveur).
      columns: [
        { head: I18n.t("lists.col.name"), essential: true, cls: "cell-name", sortKey: "name", sort: (a) => a.name, sortField: "name", render: (a) => Html.escape(a.name || I18n.t("lists.ph.noName")) },
        { head: I18n.t("lists.col.attachedTo"), essential: true, sortKey: "target", sort: (a) => targetText(a), render: targetCell },
        { head: I18n.t("lists.col.file"), sortKey: "file", sort: (a) => a.file_name || "", sortField: "file_name", render: (a) => (a.file_name ? Html.escape(a.file_name) : dim("—")) },
        // Taille : rendue LISIBLE (Format.bytes) mais TRIÉE sur les octets bruts (une chaîne « 2 Mo » se
        // trierait lexicographiquement, donc faux) — d'où `sort` sur `size` numérique, `cls: cell-num`.
        // Colonne NUMÉRIQUE côté serveur aussi : `ListOrder` n'y applique pas `COLLATE NOCASE`, l'ORDER BY
        // trie donc bien 9 avant 10 (ce qu'un tri de chaînes ne ferait pas).
        { head: I18n.t("lists.col.size"), cls: "cell-num", sortKey: "size", sort: (a) => a.size || 0, sortField: "size", render: (a) => Html.escape(Format.bytes(a.size)) },
        { head: I18n.t("lists.col.description"), cls: "cell-desc", sort: (a) => a.description || "", sortField: "description", render: descCell },
      ],
    };
  }

  /** Familles distinctes d'un catalogue (pour les filtres). */
  private static _families(store: Store, coll: string): { id: string; label: string }[] {
    const s = new Set<string>();
    store.all(coll).forEach((t: any) => { if (t.family) s.add(t.family); });
    return [...s].sort().map((f) => ({ id: f, label: f }));
  }
}
