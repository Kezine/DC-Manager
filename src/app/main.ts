/* Point d'entrée TEMPORAIRE de la migration.
   À ce stade, le MODÈLE DE DOMAINE et la COUCHE DONNÉES sont extraits
   (cf. MIGRATION.md). Le Store et les vues sont encore dans le HTML monolithique
   et seront portés ensuite. Cette entrée instancie le registre + un adapter pour
   prouver la chaîne de compilation webpack → TypeScript et exposer au debug. */
import "../styles/netmap.css";
import { EntityRegistry } from "../models";
import { BrowserStorageAdapter } from "../data";
import { Store } from "../store";
import { GraphView, ListView, ListConfigs, Forms } from "../views";
import type { ListOptions, FormHost } from "../views";
import { Modal, Notify, FormControls, Dialog } from "../ui";
import { Html } from "../core/Html";
import { Shell } from "./Shell";

const adapter = new BrowserStorageAdapter({ persistent: false });
const store = new Store(adapter);

/* Petit document de démonstration (tranche-pilote) si le store est vide :
   3 équipements reliés par 2 câbles → de quoi voir GraphView rendre/disposer. */
async function seedDemo(): Promise<void> {
  if (store.totalCount() > store.all("portTypes").length + store.all("cableTypes").length) return;
  const sw = await store.create("equipments", { name: "core-sw", type: "switch" });
  const srv = await store.create("equipments", { name: "srv-01", type: "serveur" });
  const ap = await store.create("equipments", { name: "ap-hall", type: "ap" });
  const mk = async (eq: any) => (await store.create("ports", { equipment_id: eq.id, name: "p1" })).id;
  const [p1, p2, p3, p4] = [await mk(sw), await mk(srv), await mk(sw), await mk(ap)];
  await store.create("cables", { name: "uplink", from_port_id: p1, to_port_id: p2, status: "cable" });
  await store.create("cables", { name: "wifi", from_port_id: p3, to_port_id: p4, status: "planifie" });
}

async function boot(): Promise<void> {
  await store.init();
  if (!store.restored) await store.newDocument();
  await seedDemo();

  const root = document.getElementById("app");
  if (!root) return;

  const shell = new Shell(root);
  const modal = new Modal();   // modale d'édition partagée

  // ---- Vue Topologie (GraphView pilote) ----
  let graph: GraphView;
  const graphContainer = shell.addView({ name: "graph", label: "Topologie", onShow: () => graph.show() });
  const stage = document.createElement("div");
  stage.className = "graph-stage";
  stage.style.cssText = "position:relative;flex:1 1 auto;min-height:560px;background:var(--bg-2);overflow:hidden";
  graphContainer.appendChild(stage);
  graph = new GraphView(store, stage, {
    setDirty: () => { /* dirty global câblé plus tard */ },
    openEquipmentDetail: (id) => {
      const eq = store.get("equipments", id);
      if (!eq) return;
      const body = document.createElement("div");
      const ro = (label: string, val: string) => body.appendChild(FormControls.fieldRow(label, FormControls.text(val)));
      ro("Nom", eq.name); ro("Type", eq.type); ro("Marque", eq.brand || "—");
      ro("Modèle", eq.model || "—"); ro("Série", eq.serial || "—");
      modal.open({ title: eq.name || "(équipement)", subtitle: eq.type, body, hideFooter: true });
    },
    deleteEquipment: async (id) => {
      const eq = store.get("equipments", id);
      const ok = await Dialog.confirm({ title: "Supprimer ?", message: `Supprimer « ${eq?.name || "équipement"} » et ses câbles ?`, confirmLabel: "Supprimer", danger: true });
      if (!ok) return;
      await store.remove("equipments", id);
      graph.rebuild({ recenter: false });
      Notify.toast("Équipement supprimé");
    },
    openModal: (opts) => modal.open(opts),
  });

  // ---- fiche détail générique (lecture seule) ----
  const openDetail = (coll: string, id: string) => {
    const o: any = store.get(coll, id);
    if (!o) return;
    const body = document.createElement("div");
    const skip = new Set(["id", "created_date", "updated_date"]);
    Object.keys(o).forEach((k) => {
      if (skip.has(k)) return;
      const v = o[k];
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) return;
      const row = FormControls.text(Array.isArray(v) ? v.join(", ") : String(v));
      row.readOnly = true;
      body.appendChild(FormControls.fieldRow(k, row));
    });
    modal.open({ title: Html.escape(o.name || o.label || "(détail)"), subtitle: coll, body, hideFooter: true });
  };

  // ---- onglets de LISTE (ListView paramétré par ListConfigs) ----
  const formHost: FormHost = { openModal: (o) => modal.open(o), setDirty: () => { /* dirty global plus tard */ } };
  type FormFn = (id: string | null, onSaved: () => void) => void;
  const addListTab = (name: string, label: string, configFn: (s: typeof store) => ListOptions, formFn?: FormFn) => {
    let view: ListView | null = null;
    const container = shell.addView({
      name, label,
      onShow: () => {
        if (!view) {
          const cfg = configFn(store);
          const reRender = () => view!.render();
          view = new ListView(store, container, {
            ...cfg,
            actions: cfg.actions || { view: true, edit: !!formFn, clone: true, del: true },
            onCreate: formFn ? () => formFn(null, reRender) : undefined,
            onAction: async (act, id) => {
              if (act === "view") { openDetail(cfg.collection, id); return; }
              if (act === "edit") { formFn?.(id, reRender); return; }
              if (act === "clone") {
                const c = cfg.collection === "equipments" ? await store.cloneEquipment(id) : await store.cloneSimple(cfg.collection, id);
                if (c) { reRender(); Notify.toast("Élément cloné"); }
                return;
              }
              if (act === "del") {
                const o: any = store.get(cfg.collection, id);
                const ok = await Dialog.confirm({ title: "Supprimer ?", message: `Supprimer « ${o?.name || o?.label || "cet élément"} » ?`, confirmLabel: "Supprimer", danger: true });
                if (!ok) return;
                await store.remove(cfg.collection, id);
                reRender(); Notify.toast("Supprimé");
              }
            },
          });
        }
        view.render();
      },
    });
  };
  addListTab("equipements", "Équipements", ListConfigs.equipments, (id, done) => Forms.equipment(store, formHost, id, done));
  addListTab("cables", "Câbles", ListConfigs.cables);
  addListTab("racks", "Racks", ListConfigs.racks);
  addListTab("reseaux", "Réseaux", ListConfigs.networks, (id, done) => Forms.network(store, formHost, id, done));
  addListTab("groupes", "Groupes", ListConfigs.groups, (id, done) => Forms.group(store, formHost, id, done));
  addListTab("ipnetworks", "Réseaux IP", ListConfigs.ipNetworks, (id, done) => Forms.ipNetwork(store, formHost, id, done));
  addListTab("ipaddresses", "Adresses IP", ListConfigs.ipAddresses, (id, done) => Forms.ipAddress(store, formHost, id, done));
  addListTab("dhcp", "DHCP", ListConfigs.dhcpRanges, (id, done) => Forms.dhcpRange(store, formHost, id, done));
  addListTab("porttypes", "Types port", ListConfigs.portTypes);
  addListTab("cabletypes", "Types câble", ListConfigs.cableTypes);
  shell.addView({ name: "datacenter", label: "Datacenter", onShow: (c) => { if (!c.dataset.built) { c.dataset.built = "1"; c.innerHTML = `<p style="padding:24px;color:var(--fg-dim)">Vue Datacenter — à porter.</p>`; } } });

  // cohérence inter-vues : toute mutation du modèle rafraîchit la vue active
  // (coalescé sur une frame pour absorber les rafales de transactions).
  let refreshQueued = false;
  store.onChange(() => {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => { refreshQueued = false; shell.refreshActive(); });
  });

  shell.switchView("graph");
  Notify.toast("NetMap — pilote prêt (double-clic un nœud)", "ok");
  (window as any).__NETMAP__ = { EntityRegistry, adapter, store, shell, graph, modal };
}
boot();
