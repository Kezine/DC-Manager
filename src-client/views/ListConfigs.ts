import type { Store } from "../store";
import { Icons } from "../ui/Icons";
import { Html } from "../core/Html";
import { Ip } from "../core/Ip";
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
import type { ListOptions } from "./ListView";

const dim = (s: string) => `<span style="color:var(--fg-dimmer)">${s}</span>`;
const swatch = (c: string | null) => (c ? `<span class="swatch-dot" style="background:${c}"></span> ` : "");
const kindPill = (k: string) => (k === "power"
  ? '<span class="pill" style="border-color:var(--accent-2);color:var(--accent-2)"><span class="gi">' + Icons.POWER + '</span>alim.</span>'
  : '<span class="pill">data</span>');
const descCell = (o: any) => (o.description ? Html.escape(String(o.description).slice(0, 80)) : dim("—"));

/* Configurations de colonnes par collection (paramètrent ListView). Classe de méthodes
   statiques ; chaque méthode renvoie les options d'une liste. Le JEU de colonnes est aligné
   sur l'app de référence (monolithe) — cf. les `columns` des ListController d'origine. */
export class ListConfigs {
  static equipments(store: Store): ListOptions {
    return {
      collection: "equipments",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: "Aucun équipement.",
      searchFields: (e) => { const gl = store.equipmentGroupIds(e).map((gid: string) => { const g: any = store.get("groups", gid); return g && g.label; }).filter(Boolean); return [e.name, e.type, EquipmentTypes.label(e.type), e.brand, e.model, e.serial, ...gl, e.description]; },
      columns: [
        { head: "Nom", essential: true, cls: "cell-name", sortKey: "name", sort: (e) => e.name, render: (e) => Html.escape(e.name || "(sans nom)") },
        {
          head: "Type", essential: true, sortKey: "type", sort: (e) => EquipmentTypes.label(e.type),
          render: (e) => `<span class="pill">${Html.escape(EquipmentTypes.label(e.type))}</span>`,
          filter: { label: "Type", options: () => EquipmentTypes.ALL.map((t) => ({ id: t.id, label: t.label })), valueOf: (e) => e.type },
        },
        {
          head: "Groupe", sortKey: "group",
          sort: (e) => { const g: any = e.group_id && store.get("groups", e.group_id); return g ? (g.label || "") : ""; },   // tri sur le PRIMAIRE
          render: (e) => { const gs: any[] = store.equipmentGroupIds(e).map((gid: string) => store.get("groups", gid)).filter(Boolean); return gs.length ? gs.map((g: any) => swatch(g.color) + Html.escape(g.label || "(groupe)")).join(" ") : dim("—"); },
          // filtre par APPARTENANCE (primaire OU secondaire) — valueOf renvoie un tableau, comme la colonne Réseaux des câbles.
          filter: { label: "Groupe", options: () => store.all("groups").map((g: any) => ({ id: g.id, label: g.label || "(groupe)" })), valueOf: (e) => store.equipmentGroupIds(e) },
        },
        { head: "U", cls: "num", sortKey: "u", sort: (e) => (e.dim_mode === "u" ? (e.u_height || 1) : -1), render: (e) => (e.dim_mode === "u" ? `<span class="pill">${e.u_height || 1} U</span>` : dim("libre")) },
        { head: "Emplacement", essential: true, sortKey: "place", sort: (e) => ListConfigs._placeText(store, e), render: (e) => EntityViz.equipmentLocation(store, e) },
        { head: "Ports", cls: "num", sort: (e) => store.portsOf(e.id).length, render: (e) => `<span class="pill">${store.portsOf(e.id).length}</span>` },
        { head: "Agrégats", cls: "num", sort: (e) => store.aggregatesOf(e.id).length, render: (e) => `<span class="pill">${store.aggregatesOf(e.id).length}</span>` },
        { head: "Description", cls: "cell-desc", sort: (e) => e.description || "", render: descCell },
      ],
    };
  }

  static networks(store: Store): ListOptions {
    return {
      collection: "networks",
      defaultSort: { key: "label", dir: "asc" },
      emptyText: "Aucun réseau.",
      searchFields: (n) => [n.label, n.description],
      columns: [
        { head: "Couleur", render: (n) => (n.color ? `<span class="swatch-dot" style="background:${n.color}"></span>` : dim("—")) },
        { head: "Label", cls: "cell-name", sortKey: "label", sort: (n) => n.label, render: (n) => Html.escape(n.label || "(sans label)") },
        {
          head: "Type", sortKey: "kind", sort: (n) => n.kind, render: (n) => kindPill(n.kind),
          filter: { label: "Type", options: () => [{ id: "data", label: "Data" }, { id: "power", label: "Alimentation" }], valueOf: (n) => (n.kind === "power" ? "power" : "data") },
        },
        { head: "Réseau IP", render: (n) => { const ip: any = n.ip_network_id && store.get("ipNetworks", n.ip_network_id); return ip ? `<span class="pill"><span class="gi">${Icons.NETWORK}</span>${Html.escape(ip.cidr || ip.label || "(IP)")}</span>` : dim("logique"); } },
        { head: "Câbles", cls: "num", sort: (n) => store.cablesOfNetwork(n.id).length, render: (n) => `<span class="pill">${store.cablesOfNetwork(n.id).length}</span>` },
        { head: "Description", cls: "cell-desc", sort: (n) => n.description || "", render: descCell },
      ],
    };
  }

  static groups(store: Store): ListOptions {
    return {
      collection: "groups",
      defaultSort: { key: "label", dir: "asc" },
      emptyText: "Aucun groupe.",
      searchFields: (g) => [g.label, g.description, GroupTypes.label(g.type)],
      columns: [
        { head: "Couleur", render: (g) => (g.color ? `<span class="swatch-dot" style="background:${g.color}"></span>` : dim("—")) },
        { head: "Label", cls: "cell-name", sortKey: "label", sort: (g) => g.label, render: (g) => Html.escape(g.label || "(sans label)") },
        {
          head: "Type", sortKey: "type", sort: (g) => GroupTypes.label(g.type), render: (g) => `<span class="pill">${Html.escape(GroupTypes.label(g.type))}</span>`,
          filter: { label: "Type", options: () => GroupTypes.ALL.map((t) => ({ id: t.id, label: t.label })), valueOf: (g) => g.type },
        },
        { head: "Équipements", cls: "num", sort: (g) => store.equipmentsOfGroup(g.id).length, render: (g) => `<span class="pill">${store.equipmentsOfGroup(g.id).length}</span>` },
        { head: "Description", cls: "cell-desc", sort: (g) => g.description || "", render: descCell },
      ],
    };
  }

  /** Bibliothèque d'images de façade — source CUSTOM (ImageStore) injectée via `items` au câblage. */
  static faceImages(store: Store): ListOptions {
    const faceLbl = (f: string) => (f === "autre" ? "Autre" : EquipFaces.label(f));
    return {
      collection: "faceImages",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: "Aucune image de façade. Ajoutez-en une avec « + Image », ou importez-en depuis l'éditeur de façade d'un équipement.",
      // « autre » = image de face LIBRE (équipement non-rack) : la hauteur en U n'a pas de sens → on ne l'affiche pas.
      searchFields: (o) => [o.name, faceLbl(o.face), o.face === "autre" ? "libre" : (o.u_height || 1) + "U", o.description],
      columns: [
        { head: "Aperçu", render: (o) => o.url ? `<span class="cell-fithumb"><img src="${o.url}" alt="" /></span>` : dim("—") },
        { head: "Nom", cls: "cell-name", sortKey: "name", sort: (o) => o.name || "", render: (o) => Html.escape(o.name || "(sans nom)") },
        { head: "Hauteur", cls: "num", sort: (o) => (o.face === "autre" ? -1 : (o.u_height || 1)), render: (o) => o.face === "autre" ? dim("libre") : `<span class="pill">${o.u_height || 1} U</span>` },
        {
          head: "Face", sortKey: "face", sort: (o) => faceLbl(o.face), render: (o) => `<span class="pill">${Html.escape(faceLbl(o.face))}</span>`,
          filter: { label: "Face", options: () => [{ id: "front", label: "Avant" }, { id: "rear", label: "Arrière" }, { id: "autre", label: "Autre" }], valueOf: (o) => o.face || "front" },
        },
        { head: "Usages", cls: "num", sort: (o) => store.faceImageUsageCount(o.id), render: (o) => `<span class="pill">${store.faceImageUsageCount(o.id)}</span>` },
        { head: "Description", cls: "cell-desc", render: descCell },
      ],
    };
  }

  static cables(store: Store): ListOptions {
    return {
      collection: "cables",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: "Aucun câble.",
      searchFields: (c) => [c.name, c.description],
      columns: [
        { head: "Nom", essential: true, cls: "cell-name", sortKey: "name", sort: (c) => c.name, render: (c) => Html.escape(c.name || "(câble)") },
        { head: "Type", render: (c) => { const t: any = c.cable_type_id && store.get("cableTypes", c.cable_type_id); return t ? `<span class="pill">${Html.escape(t.name)}</span>` : dim("—"); } },
        { head: "Liaison", essential: true, render: (c) => EntityViz.cableLink(store, c) },
        { head: "Long.", cls: "num", sort: (c) => { const L = ListConfigs._cableLen(store, c); return L != null ? L : -1; }, render: (c) => { const L = ListConfigs._cableLen(store, c); return L != null ? L + " m" : dim("—"); } },
        {
          head: "Statut", essential: true, sortKey: "status", sort: (c) => c.status, render: (c) => Html.escape(CableStatuses.label(c.status)),
          filter: { label: "Statut", options: () => CableStatuses.ALL.map((s) => ({ id: s.id, label: s.label })), valueOf: (c) => c.status },
        },
        {
          head: "Réseaux", render: (c) => { const ns = ListConfigs._cableNets(store, c); return ns.length ? ns.map((n: any) => swatch(n.color) + Html.escape(n.label || "(réseau)")).join(" ") : dim("—"); },
          filter: { label: "Réseau", options: () => store.all("networks").map((n: any) => ({ id: n.id, label: n.label || "(réseau)" })), valueOf: (c) => store.cableNetworkIds(c) },
        },
        { head: "Description", cls: "cell-desc", sort: (c) => c.description || "", render: descCell },
      ],
    };
  }

  /** Faisceaux (trunks) : multi-fibres entre 2 patchs ; fibres piochées par les ports des patchs. */
  static cableBundles(store: Store): ListOptions {
    return {
      collection: "cableBundles",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: "Aucun faisceau.",
      searchFields: (b) => [b.name, b.description],
      columns: [
        { head: "Nom", cls: "cell-name", sortKey: "name", sort: (b) => b.name, render: (b) => Html.escape(b.name || "(faisceau)") },
        { head: "Type", render: (b) => { const t: any = b.cable_type_id && store.get("cableTypes", b.cable_type_id); return t ? `<span class="pill">${Html.escape(t.name)}</span>` : dim("—"); } },
        { head: "Brins", cls: "num", render: (b) => { const o = store.bundleOccupancy(b.id); return o.used + " / " + o.capacity; } },
        { head: "Longueur", cls: "num", sort: (b) => (b.length_m != null ? b.length_m : -1), render: (b) => (b.length_m != null ? b.length_m + " m" : dim("—")) },
        { head: "Route", render: (b) => { const n = (b.waypoint_ids || []).length; return n ? `<span class="pill">${n} point(s)</span>` : dim("directe"); } },
        { head: "Description", cls: "cell-desc", sort: (b) => b.description || "", render: descCell },
      ],
    };
  }

  /** Salles (datacenters) : grille au sol + nb de baies placées (table propre à cette app — pas de réf monolithe). */
  static datacenters(store: Store): ListOptions {
    return {
      collection: "datacenters",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: "Aucune salle.",
      searchFields: (d) => [d.name, d.room],
      columns: [
        { head: "Nom", cls: "cell-name", sortKey: "name", sort: (d) => d.name, render: (d) => Html.escape(d.name || "(salle)") },
        { head: "Dimensions", render: (d) => (d.width_mm / 1000).toFixed(1) + " × " + (d.depth_mm / 1000).toFixed(1) + " m" },
        { head: "Local", render: (d) => (d.room ? Html.escape(d.room) : dim("—")) },
        { head: "Baies", cls: "num", render: (d) => String(store.racksOfDc(d.id).length) },
      ],
    };
  }

  /** Sites / bâtiments (CRUD). La suppression passe par `removeSite` (décommissionnement) — câblée dans main. */
  static sites(store: Store): ListOptions {
    return {
      collection: "sites",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: "Aucun site / bâtiment.",
      actions: { view: false, edit: true, clone: false, del: true },
      searchFields: (s) => [s.name, s.address],
      columns: [
        { head: "Nom", cls: "cell-name", sortKey: "name", sort: (s) => s.name, render: (s) => Html.escape(s.name || "(site)") },
        { head: "Adresse", render: (s) => (s.address ? Html.escape(s.address) : dim("—")) },
        { head: "Étages", cls: "num", render: (s) => String(store.floorsOf(s.id).length) },
        { head: "Salles", cls: "num", render: (s) => String(store.all("datacenters").filter((d: any) => (d.location || "") === s.id).length) },
      ],
    };
  }

  /** Contacts — carnet de destinataires des NOTIFICATIONS (email/sms), référencés par le module notify.
      Collection hors graphe réseau (jamais dessinée) : liste simple nom · e-mail · téléphone · notes. */
  static contacts(store: Store): ListOptions {
    return {
      collection: "contacts",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: "Aucun contact. Ajoutez-en un avec « + Contact » (destinataire des notifications email / sms).",
      actions: { view: true, edit: true, clone: false, del: true },   // clone sans objet pour un destinataire unique
      searchFields: (c) => [c.name, c.email, c.phone, c.notes],
      columns: [
        { head: "Nom", essential: true, cls: "cell-name", sortKey: "name", sort: (c) => c.name, render: (c) => Html.escape(c.name || "(contact)") },
        { head: "E-mail", sortKey: "email", sort: (c) => c.email || "", render: (c) => (c.email ? Html.escape(c.email) : dim("—")) },
        { head: "Téléphone", render: (c) => (c.phone ? Html.escape(c.phone) : dim("—")) },
        { head: "Notes", cls: "cell-desc", sort: (c) => c.notes || "", render: (c) => (c.notes ? Html.escape(String(c.notes).slice(0, 80)) : dim("—")) },
      ],
    };
  }

  /** Plans d'étage (CRUD). Édition/création via `Forms.floor` (location + étage) — câblée dans main. */
  static floors(store: Store): ListOptions {
    return {
      collection: "floors",
      defaultSort: { key: "loc", dir: "asc" },
      emptyText: "Aucun étage.",
      actions: { view: false, edit: true, clone: false, del: true },
      searchFields: (f) => [store.siteLabel(f.location), String(f.floor)],
      columns: [
        { head: "Bâtiment", cls: "cell-name", sortKey: "loc", sort: (f) => store.siteLabel(f.location), render: (f) => Html.escape(store.siteLabel(f.location)) },
        { head: "Étage", sortKey: "fl", sort: (f) => FloorLayout.floorNum(String(f.floor || "")), render: (f) => "Étage " + (f.floor != null && f.floor !== "" ? f.floor : "0") },
        { head: "Dimensions", render: (f) => ((f.width_mm || 0) / 1000).toFixed(1) + " × " + ((f.depth_mm || 0) / 1000).toFixed(1) + " m" },
        { head: "Salles", cls: "num", render: (f) => String(store.dcsOfFloor(f.location, String(f.floor || "")).length) },
      ],
    };
  }

  static racks(store: Store): ListOptions {
    const scene = new RackScene(store);
    return {
      collection: "racks",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: "Aucune baie.",
      searchFields: (r) => [r.name, r.room, r.description],
      columns: [
        { head: "Nom", cls: "cell-name", sortKey: "name", sort: (r) => r.name, render: (r) => Html.escape(r.name || "(baie)") },
        {
          head: "Emplacement", sortKey: "loc", sort: (r) => ListConfigs._rackLocText(store, r),
          render: (r) => EntityViz.rackLocation(store, r),
          filter: { label: "Salle", options: () => store.all("datacenters").map((d: any) => ({ id: d.id, label: d.name || "(salle)" })), valueOf: (r) => r.datacenter_id || "__none__" },
        },
        { head: "Taille", cls: "num", sortKey: "u", sort: (r) => r.u_count, render: (r) => `<span class="pill">${r.u_count} U</span>` },
        { head: "Profondeur", cls: "num", sort: (r) => r.depth, render: (r) => `<span class="pill">${r.depth} mm</span>` },
        {
          head: "Faces", sortKey: "faces", sort: (r) => r.sides, render: (r) => `<span class="pill">${r.sides === "dual" ? "Double" : "Simple"}</span>`,
          filter: { label: "Faces", options: () => [{ id: "single", label: "Simple" }, { id: "dual", label: "Double" }], valueOf: (r) => (r.sides === "dual" ? "dual" : "single") },
        },
        { head: "Occupé", cls: "num", sort: (r) => scene.occupancyCount(r.id), render: (r) => `<span class="pill">${scene.occupancyCount(r.id)}</span>` },
        { head: "Libre", cls: "num", sort: (r) => scene.freeUInfo(r.id).free, render: (r) => { const f = scene.freeUInfo(r.id); return `<span class="pill">${f.free} U</span>`; } },
        { head: "Contigu", cls: "num", sort: (r) => scene.freeUInfo(r.id).contig, render: (r) => `<span class="pill">${scene.freeUInfo(r.id).contig} U</span>` },
      ],
    };
  }

  /** Catalogue fermé (lecture seule) : types de port. */
  static portTypes(store: Store): ListOptions {
    return {
      collection: "portTypes",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: "Aucun type de port.",
      actions: { view: true },
      searchFields: (t) => [t.name, t.family, t.connector, t.speed, t.description],
      columns: [
        { head: "Nom", cls: "cell-name", sortKey: "name", sort: (t) => t.name, render: (t) => Html.escape(t.name) },
        {
          head: "Genre", sortKey: "kind", sort: (t) => t.kind, render: (t) => kindPill(t.kind),
          filter: { label: "Genre", options: () => [{ id: "data", label: "Data" }, { id: "power", label: "Alimentation" }], valueOf: (t) => (t.kind === "power" ? "power" : "data") },
        },
        { head: "Rôles", render: (t) => PortRoles.forKind(t.kind).map((r) => `<span class="pill">${Html.escape(r.label)}</span>`).join(" ") },
        {
          head: "Famille", sortKey: "family", sort: (t) => t.family, render: (t) => `<span class="pill">${Html.escape(t.family || "—")}</span>`,
          filter: { label: "Famille", options: () => ListConfigs._families(store, "portTypes"), valueOf: (t) => t.family },
        },
        { head: "Connecteur", render: (t) => Html.escape(t.connector || t.family || "—") + (t.duplex ? ` <span class="pill">duplex</span>` : "") },
        { head: "Débit", render: (t) => (t.speed ? Html.escape(t.speed) : dim("—")) },
        { head: "Ports", cls: "num", sort: (t) => store.portsOfType(t.id).length, render: (t) => `<span class="pill">${store.portsOfType(t.id).length}</span>` },
        { head: "Description", cls: "cell-desc", sort: (t) => t.description || "", render: descCell },
      ],
    };
  }

  /** Catalogue fermé (lecture seule) : types de câble. */
  static cableTypes(store: Store): ListOptions {
    return {
      collection: "cableTypes",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: "Aucun type de câble.",
      actions: { view: true },
      searchFields: (t) => [t.name, t.family, t.medium, t.description],
      columns: [
        { head: "Nom", cls: "cell-name", sortKey: "name", sort: (t) => t.name, render: (t) => Html.escape(t.name) },
        {
          head: "Genre", sortKey: "kind", sort: (t) => t.kind, render: (t) => kindPill(t.kind),
          filter: { label: "Genre", options: () => [{ id: "data", label: "Data" }, { id: "power", label: "Alimentation" }], valueOf: (t) => (t.kind === "power" ? "power" : "data") },
        },
        {
          head: "Famille (port)", sortKey: "family", sort: (t) => t.family, render: (t) => `<span class="pill">${Html.escape(t.family || "—")}</span>`,
          filter: { label: "Famille", options: () => ListConfigs._families(store, "cableTypes"), valueOf: (t) => t.family },
        },
        { head: "Média", render: (t) => Html.escape(t.medium || "—") },
        { head: "Câbles", cls: "num", sort: (t) => store.cablesOfType(t.id).length, render: (t) => `<span class="pill">${store.cablesOfType(t.id).length}</span>` },
        { head: "Description", cls: "cell-desc", sort: (t) => t.description || "", render: descCell },
      ],
    };
  }

  static ipNetworks(store: Store): ListOptions {
    return {
      collection: "ipNetworks",
      defaultSort: { key: "label", dir: "asc" },
      emptyText: "Aucun réseau IP.",
      searchFields: (n) => [n.label, n.cidr, n.description],
      columns: [
        { head: "Label", cls: "cell-name", sortKey: "label", sort: (n) => n.label, render: (n) => Html.escape(n.label || "(sans label)") },
        { head: "CIDR", sortKey: "cidr", sort: (n) => n.cidr, render: (n) => (n.cidr ? `<code>${Html.escape(n.cidr)}</code>` : dim("—")) },
        { head: "Adresses", cls: "num", sort: (n) => store.ipAddressesOfNetwork(n.id).length, render: (n) => `<span class="pill">${store.ipAddressesOfNetwork(n.id).length}</span>` },
        { head: "Plages DHCP", cls: "num", sort: (n) => store.dhcpRangesOfNetwork(n.id).length, render: (n) => `<span class="pill">${store.dhcpRangesOfNetwork(n.id).length}</span>` },
        { head: "Réseaux logiques", cls: "num", sort: (n) => store.networksOfIpNetwork(n.id).length, render: (n) => { const ns = store.networksOfIpNetwork(n.id); return ns.length ? `<span class="pill">${ns.length}</span>` : dim("—"); } },
        { head: "Description", cls: "cell-desc", sort: (n) => n.description || "", render: descCell },
      ],
    };
  }

  static ipAddresses(store: Store): ListOptions {
    return {
      collection: "ipAddresses",
      defaultSort: { key: "address", dir: "asc" },
      emptyText: "Aucune adresse IP.",
      searchFields: (a) => [a.address, a.hostname, a.description],
      columns: [
        { head: "Adresse", essential: true, cls: "cell-name", sortKey: "address", sort: (a) => { const v = Ip.toInt(a.address); return v != null ? v : a.address; }, render: (a) => `<code>${Html.escape(a.address || "—")}</code>` },
        {
          head: "Réseau", essential: true, sortKey: "net", sort: (a) => { const n: any = a.network_id && store.get("ipNetworks", a.network_id); return n ? (n.label || n.cidr || "") : ""; },
          render: (a) => { const n: any = a.network_id && store.get("ipNetworks", a.network_id); return n ? Html.escape(n.label || n.cidr || "(réseau)") : dim("—"); },
          filter: { label: "Réseau", options: () => store.all("ipNetworks").map((n: any) => ({ id: n.id, label: n.label || n.cidr || "(réseau)" })), valueOf: (a) => a.network_id || "__none__" },
        },
        { head: "Hostname", sort: (a) => a.hostname || "", render: (a) => (a.hostname ? `<span style="font-family:var(--mono)">${Html.escape(a.hostname)}</span>` : dim("—")) },
        {
          head: "Équipement", essential: true, sortKey: "eq", sort: (a) => { const e: any = a.equipment_id && store.get("equipments", a.equipment_id); return e ? (e.name || "") : ""; },
          render: (a) => { const e: any = a.equipment_id && store.get("equipments", a.equipment_id); return e ? Html.escape(e.name || "(équip.)") : dim("— libre —"); },
          filter: { label: "Équipement", options: () => store.all("equipments").map((e: any) => ({ id: e.id, label: e.name || "(équip.)" })), valueOf: (a) => a.equipment_id || "__none__" },
        },
        { head: "Description", cls: "cell-desc", sort: (a) => a.description || "", render: descCell },
      ],
    };
  }

  static dhcpRanges(store: Store): ListOptions {
    return {
      collection: "dhcpRanges",
      defaultSort: { key: "__created__", dir: "asc" },
      emptyText: "Aucune plage DHCP.",
      searchFields: (d) => [d.start_ip, d.end_ip, d.description],
      columns: [
        { head: "Plage", essential: true, cls: "cell-name", sort: (d) => { const v = Ip.toInt(d.start_ip); return v != null ? v : (d.start_ip || ""); }, render: (d) => `<code>${Html.escape(d.start_ip || "?")}</code> → <code>${Html.escape(d.end_ip || "?")}</code>` },
        {
          head: "Réseau", essential: true, sortKey: "net", sort: (d) => { const n: any = d.network_id && store.get("ipNetworks", d.network_id); return n ? (n.label || n.cidr || "") : ""; },
          render: (d) => { const n: any = d.network_id && store.get("ipNetworks", d.network_id); return n ? Html.escape(n.label || n.cidr || "(réseau)") : dim("—"); },
          filter: { label: "Réseau", options: () => store.all("ipNetworks").map((n: any) => ({ id: n.id, label: n.label || n.cidr || "(réseau)" })), valueOf: (d) => d.network_id || "__none__" },
        },
        { head: "Taille", cls: "num", sort: (d) => { const a = Ip.toInt(d.start_ip), b = Ip.toInt(d.end_ip); return (a != null && b != null && b >= a) ? (b - a + 1) : -1; }, render: (d) => { const a = Ip.toInt(d.start_ip), b = Ip.toInt(d.end_ip); return (a != null && b != null && b >= a) ? `<span class="pill">${b - a + 1} adr.</span>` : dim("—"); } },
        {
          head: "Serveur DHCP", essential: true, sortKey: "srv", sort: (d) => { const e: any = d.server_id && store.get("equipments", d.server_id); return e ? (e.name || "") : ""; },
          render: (d) => { const e: any = d.server_id && store.get("equipments", d.server_id); return e ? Html.escape(e.name || "(serveur)") : dim("— non désigné —"); },
          filter: { label: "Serveur", options: () => store.all("equipments").map((e: any) => ({ id: e.id, label: e.name || "(équip.)" })), valueOf: (d) => d.server_id || "__none__" },
        },
        { head: "Description", cls: "cell-desc", sort: (d) => d.description || "", render: descCell },
      ],
    };
  }

  /* ---- helpers de rendu transverses ---- */

  /** Texte court de l'emplacement d'un équipement (rack / latéral / mural / étage / salle libre). */
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

  /** Bits d'emplacement d'une baie (Lieu · Étage · Salle), hérités de son datacenter. */
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
      if (o.assigned_equipment_id) { const e: any = store.get("equipments", o.assigned_equipment_id); return e ? (e.name || "(équip.)") : "(équip. supprimé)"; }
      return o.assigned_free || "";
    };
    return {
      collection: "spares",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: "Aucune pièce de rechange. Ajoutez-en une avec « + Spare » (HDD, SSD, transceiver, autre…).",
      searchFields: (o) => [o.displayName ? o.displayName() : o.name, o.brand, o.model_pn, o.serial, SpareTypes.label(o.type), o.techSummary ? o.techSummary() : "", o.storage_location, o.po_ref, assignedTo(o), o.comment],
      columns: [
        { head: "Désignation", essential: true, cls: "cell-name", sortKey: "name", sort: (o) => (o.displayName ? o.displayName() : (o.name || "")), render: (o) => Html.escape(o.displayName ? o.displayName() : (o.name || "(spare)")) + (o.serial ? " " + dim("· SN " + Html.escape(o.serial)) : "") },
        {
          head: "Type", essential: true, sortKey: "type", sort: (o) => SpareTypes.label(o.type), render: (o) => `<span class="pill">${SpareTypes.svg(o.type)}${Html.escape(SpareTypes.label(o.type))}</span>`,
          filter: { label: "Type", options: () => SpareTypes.ALL.map((t) => ({ id: t.id, label: t.label })), valueOf: (o) => o.type },
        },
        { head: "Caractéristiques", render: (o) => { const t = o.techSummary ? o.techSummary() : ""; return t ? Html.escape(t) : dim("—"); } },
        {
          head: "Statut", essential: true, sortKey: "status", sort: (o) => SpareStatuses.label(o.status), render: (o) => `<span class="pill">${Html.escape(SpareStatuses.label(o.status))}</span>`,
          filter: { label: "Statut", options: () => SpareStatuses.ALL.map((s) => ({ id: s.id, label: s.label })), valueOf: (o) => o.status },
        },
        { head: "Affecté à", sort: (o) => assignedTo(o), render: (o) => { const t = assignedTo(o); return t ? Html.escape(t) : dim("—"); } },
        { head: "Stockage", render: (o) => (o.storage_location ? Html.escape(o.storage_location) : dim("—")) },
        { head: "Achat", cls: "num", sortKey: "purchase", sort: (o) => o.purchase_date || "", render: (o) => (o.purchase_date ? Html.escape(o.purchase_date) : dim("—")) },
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
      if (e) return e.name || "(équip.)";
      return v.host_node || "";
    };
    // IPs de TOUTES les vNIC, aplaties + dédoublonnées dans l'ordre de découverte (donnée SOURCE informative).
    const vmIps = (v: any): string[] => {
      const out: string[] = [];
      (v.nics || []).forEach((n: any) => (n && Array.isArray(n.ips) ? n.ips : []).forEach((ip: string) => { if (ip && !out.includes(ip)) out.push(ip); }));
      return out;
    };
    // Pastille de STATUT : réutilise le style de `kindPill` (classe .pill + variables SÉMANTIQUES du thème) —
    // running = --ok (vert), stopped = --fg-dim (neutre/gris), toute autre valeur affichée TELLE QUELLE (tolérance
    // aux releases Proxmox). Une VM ORPHELINE (disparue au dernier sync) prime : pastille d'erreur « orpheline »
    // rendue EN PLUS du statut (l'info « était running/stopped » reste utile pour décider de la purger).
    const statusPill = (v: any): string => {
      const s = String(v.status || "");
      let pill: string;
      if (s === "running") pill = `<span class="pill" style="border-color:var(--ok);color:var(--ok)">running</span>`;
      else if (s === "stopped") pill = `<span class="pill" style="border-color:var(--fg-dimmer);color:var(--fg-dim)">stopped</span>`;
      else pill = s ? `<span class="pill">${Html.escape(s)}</span>` : dim("—");
      const orphan = v.orphan ? `<span class="pill" style="border-color:var(--err);color:var(--err)">orpheline</span> ` : "";
      return orphan + pill;
    };
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
      emptyText: "Aucune VM. Les équipements virtuels sont alimentés par la synchronisation d'un cluster de management (Proxmox).",
      // Recherche plein texte : nom, type, statut (+ « orpheline »), hôte résolu ET nom de nœud brut, IPs, tags, notes.
      searchFields: (v) => [v.name, v.vm_type, v.status, v.orphan ? "orpheline" : "", hostText(v), v.host_node, ...vmIps(v), ...(v.tags_src || []), v.description_src, v.notes],
      columns: [
        { head: "Nom", essential: true, cls: "cell-name", sortKey: "name", sort: (v) => v.name, render: (v) => Html.escape(v.name || "(VM)") },
        {
          head: "Type", essential: true, sortKey: "type", sort: (v) => v.vm_type,
          render: (v) => (v.vm_type ? `<span class="pill">${Html.escape(v.vm_type)}</span>` : dim("—")),
          filter: { label: "Type", options: () => [{ id: "qemu", label: "QEMU" }, { id: "lxc", label: "LXC" }], valueOf: (v) => v.vm_type },
        },
        // tri : orphelines groupées à part, puis par statut (l'orphelinat est l'info dominante de la colonne).
        { head: "Statut", essential: true, sortKey: "status", sort: (v) => (v.orphan ? "1_" : "0_") + (v.status || ""), render: (v) => statusPill(v) },
        {
          head: "Hôte", essential: true, sortKey: "host", sort: (v) => hostText(v),
          render: (v) => { const t = hostText(v); return t ? Html.escape(t) : dim("—"); },
          filter: { label: "Hôte", options: hostOptions, valueOf: (v) => hostText(v) },
        },
        { head: "vNIC", cls: "num", sort: (v) => (v.nics || []).length, render: (v) => `<span class="pill">${(v.nics || []).length}</span>` },
        {
          head: "IPs", sort: (v) => vmIps(v)[0] || "",
          render: (v) => { const ips = vmIps(v); if (!ips.length) return dim("—"); const shown = ips.slice(0, 3).map((ip) => `<code>${Html.escape(ip)}</code>`).join(", "); return shown + (ips.length > 3 ? " " + dim("+" + (ips.length - 3)) : ""); },
        },
        {
          head: "Tags", render: (v) => { const ts: string[] = v.tags_src || []; return ts.length ? ts.map((t) => `<span class="pill">${Html.escape(t)}</span>`).join(" ") : dim("—"); },
          // filtre par APPARTENANCE (la VM porte le tag) — valueOf renvoie un tableau, comme la colonne Groupe des équipements.
          filter: { label: "Tags", options: tagOptions, valueOf: (v) => v.tags_src || [] },
        },
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
