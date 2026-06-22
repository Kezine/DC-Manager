import type { Store } from "../store";
import { Html } from "../core/Html";
import { EquipmentTypes } from "../registries/EquipmentTypes";
import { GroupTypes } from "../domain/GroupTypes";
import { CableStatuses } from "../domain/CableStatuses";
import { RackScene } from "../geometry/RackScene";
import type { ListOptions } from "./ListView";

const dim = (s: string) => `<span style="color:var(--fg-dimmer)">${s}</span>`;
const swatch = (c: string | null) => (c ? `<span class="swatch-dot" style="background:${c}"></span> ` : "");
const kindPill = (k: string) => (k === "power"
  ? '<span class="pill" style="border-color:var(--accent-2);color:var(--accent-2)">⚡ alim.</span>'
  : '<span class="pill">data</span>');

/* Configurations de colonnes par collection (paramètrent ListView). Classe de
   méthodes statiques ; chaque méthode renvoie les options d'une liste. */
export class ListConfigs {
  static equipments(store: Store): ListOptions {
    return {
      collection: "equipments",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: "Aucun équipement.",
      searchFields: (e) => [e.name, e.type, e.brand, e.model, e.serial],
      columns: [
        { head: "Nom", sortKey: "name", sort: (e) => e.name, render: (e) => Html.escape(e.name || "(sans nom)") },
        {
          head: "Type", sortKey: "type", sort: (e) => EquipmentTypes.label(e.type),
          render: (e) => Html.escape(EquipmentTypes.label(e.type)),
          filter: { label: "Type", options: () => EquipmentTypes.ALL.map((t) => ({ id: t.id, label: t.label })), valueOf: (e) => e.type },
        },
        { head: "Marque", sortKey: "brand", sort: (e) => e.brand, render: (e) => (e.brand ? Html.escape(e.brand) : dim("—")) },
        { head: "Modèle", render: (e) => (e.model ? Html.escape(e.model) : dim("—")) },
        { head: "Ports", cls: "num", render: (e) => String(store.portsOf(e.id).length) },
      ],
    };
  }

  static networks(store: Store): ListOptions {
    return {
      collection: "networks",
      defaultSort: { key: "label", dir: "asc" },
      emptyText: "Aucun réseau.",
      searchFields: (n) => [n.label],
      columns: [
        { head: "Réseau", sortKey: "label", sort: (n) => n.label, render: (n) => swatch(n.color) + Html.escape(n.label || "(réseau)") },
        {
          head: "Type", sortKey: "kind", sort: (n) => n.kind, render: (n) => kindPill(n.kind),
          filter: { label: "Type", options: () => [{ id: "data", label: "Data" }, { id: "power", label: "Alimentation" }], valueOf: (n) => n.kind },
        },
        { head: "Description", render: (n) => (n.description ? Html.escape(n.description.slice(0, 80)) : dim("—")) },
      ],
    };
  }

  static groups(store: Store): ListOptions {
    return {
      collection: "groups",
      defaultSort: { key: "label", dir: "asc" },
      emptyText: "Aucun groupe.",
      searchFields: (g) => [g.label],
      columns: [
        { head: "Groupe", sortKey: "label", sort: (g) => g.label, render: (g) => swatch(g.color) + Html.escape(g.label || "(sans label)") },
        {
          head: "Type", sortKey: "type", sort: (g) => GroupTypes.label(g.type), render: (g) => Html.escape(GroupTypes.label(g.type)),
          filter: { label: "Type", options: () => GroupTypes.ALL.map((t) => ({ id: t.id, label: t.label })), valueOf: (g) => g.type },
        },
        { head: "Équipements", cls: "num", render: (g) => String(store.equipmentsOfGroup(g.id).length) },
      ],
    };
  }

  static cables(store: Store): ListOptions {
    const endName = (pid: string) => { const p: any = store.get("ports", pid); const e: any = p && store.get("equipments", p.equipment_id); return e ? (e.name || "?") : "—"; };
    return {
      collection: "cables",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: "Aucun câble.",
      searchFields: (c) => [c.name],
      columns: [
        { head: "Nom", sortKey: "name", sort: (c) => c.name, render: (c) => Html.escape(c.name || "(câble)") },
        { head: "Type", render: (c) => { const t: any = c.cable_type_id && store.get("cableTypes", c.cable_type_id); return t ? Html.escape(t.name) : dim("—"); } },
        { head: "A → B", render: (c) => Html.escape(endName(c.from_port_id)) + " → " + Html.escape(endName(c.to_port_id)) },
        {
          head: "Statut", sortKey: "status", sort: (c) => c.status, render: (c) => Html.escape(CableStatuses.label(c.status)),
          filter: { label: "Statut", options: () => CableStatuses.ALL.map((s) => ({ id: s.id, label: s.label })), valueOf: (c) => c.status },
        },
      ],
    };
  }

  static racks(store: Store): ListOptions {
    const scene = new RackScene(store);
    return {
      collection: "racks",
      defaultSort: { key: "name", dir: "asc" },
      emptyText: "Aucune baie.",
      searchFields: (r) => [r.name, r.room],
      columns: [
        { head: "Nom", sortKey: "name", sort: (r) => r.name, render: (r) => Html.escape(r.name || "(baie)") },
        { head: "Salle", render: (r) => { const d: any = r.datacenter_id && store.get("datacenters", r.datacenter_id); return d ? Html.escape(d.name || "(salle)") : dim("— pool —"); } },
        { head: "U", cls: "num", sortKey: "u", sort: (r) => r.u_count, render: (r) => String(r.u_count) },
        { head: "U libres", cls: "num", render: (r) => { const f = scene.freeUInfo(r.id); return f.free + " / " + f.total; } },
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
      searchFields: (t) => [t.name, t.family, t.connector],
      columns: [
        { head: "Nom", sortKey: "name", sort: (t) => t.name, render: (t) => Html.escape(t.name) },
        {
          head: "Famille", sortKey: "family", sort: (t) => t.family, render: (t) => Html.escape(t.family),
          filter: { label: "Famille", options: () => ListConfigs._families(store, "portTypes"), valueOf: (t) => t.family },
        },
        { head: "Connecteur", render: (t) => Html.escape(t.connector) },
        { head: "Débit", render: (t) => (t.speed ? Html.escape(t.speed) : dim("—")) },
        { head: "Catégorie", sortKey: "kind", sort: (t) => t.kind, render: (t) => kindPill(t.kind) },
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
      searchFields: (t) => [t.name, t.family, t.medium],
      columns: [
        { head: "Nom", sortKey: "name", sort: (t) => t.name, render: (t) => Html.escape(t.name) },
        {
          head: "Famille", sortKey: "family", sort: (t) => t.family, render: (t) => Html.escape(t.family),
          filter: { label: "Famille", options: () => ListConfigs._families(store, "cableTypes"), valueOf: (t) => t.family },
        },
        { head: "Médium", render: (t) => Html.escape(t.medium) },
        { head: "Catégorie", sortKey: "kind", sort: (t) => t.kind, render: (t) => kindPill(t.kind) },
      ],
    };
  }

  static ipNetworks(store: Store): ListOptions {
    return {
      collection: "ipNetworks",
      defaultSort: { key: "label", dir: "asc" },
      emptyText: "Aucun réseau IP.",
      searchFields: (n) => [n.label, n.cidr],
      columns: [
        { head: "Réseau", sortKey: "label", sort: (n) => n.label, render: (n) => Html.escape(n.label || "(réseau)") },
        { head: "CIDR", sortKey: "cidr", sort: (n) => n.cidr, render: (n) => (n.cidr ? `<code>${Html.escape(n.cidr)}</code>` : dim("—")) },
        { head: "Adresses", cls: "num", render: (n) => String(store.ipAddressesOfNetwork(n.id).length) },
      ],
    };
  }

  static ipAddresses(store: Store): ListOptions {
    return {
      collection: "ipAddresses",
      defaultSort: { key: "address", dir: "asc" },
      emptyText: "Aucune adresse IP.",
      searchFields: (a) => [a.address, a.hostname],
      columns: [
        { head: "Adresse", sortKey: "address", sort: (a) => a.address, render: (a) => `<code>${Html.escape(a.address || "—")}</code>` },
        { head: "Réseau", render: (a) => { const n: any = a.network_id && store.get("ipNetworks", a.network_id); return n ? Html.escape(n.label || n.cidr || "(réseau)") : dim("—"); } },
        { head: "Hôte", render: (a) => (a.hostname ? Html.escape(a.hostname) : dim("—")) },
        { head: "Équipement", render: (a) => { const e: any = a.equipment_id && store.get("equipments", a.equipment_id); return e ? Html.escape(e.name || "(équip.)") : dim("—"); } },
      ],
    };
  }

  static dhcpRanges(store: Store): ListOptions {
    return {
      collection: "dhcpRanges",
      defaultSort: { key: "__created__", dir: "asc" },
      emptyText: "Aucune plage DHCP.",
      searchFields: (d) => [d.start_ip, d.end_ip],
      columns: [
        { head: "Réseau", render: (d) => { const n: any = d.network_id && store.get("ipNetworks", d.network_id); return n ? Html.escape(n.label || n.cidr || "(réseau)") : dim("—"); } },
        { head: "Plage", render: (d) => `<code>${Html.escape(d.start_ip || "?")}</code> → <code>${Html.escape(d.end_ip || "?")}</code>` },
        { head: "Serveur", render: (d) => { const e: any = d.server_id && store.get("equipments", d.server_id); return e ? Html.escape(e.name || "(serveur)") : dim("—"); } },
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
