import type { Store } from "../store";
import { Html } from "../core/Html";
import { EquipmentTypes } from "../registries/EquipmentTypes";
import { GroupTypes } from "../domain/GroupTypes";
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
}
