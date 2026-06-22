/* Point d'entrée TEMPORAIRE de la migration.
   À ce stade, le MODÈLE DE DOMAINE et la COUCHE DONNÉES sont extraits
   (cf. MIGRATION.md). Le Store et les vues sont encore dans le HTML monolithique
   et seront portés ensuite. Cette entrée instancie le registre + un adapter pour
   prouver la chaîne de compilation webpack → TypeScript et exposer au debug. */
import "../styles/netmap.css";
import { EntityRegistry } from "../models";
import { BrowserStorageAdapter } from "../data";
import { Store } from "../store";
import { GraphView } from "../views";
import { Modal, Notify, FormControls, Dialog } from "../ui";
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
  const graphContainer = shell.addView({ name: "graph", label: "Topologie", onShow: () => graph.rebuild({ recenter: true }) });
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

  // ---- Onglets placeholder (vues à porter en Phase 5b) ----
  const placeholder = (label: string) => (c: HTMLElement) => {
    if (c.dataset.built) return;
    c.dataset.built = "1";
    c.innerHTML = `<p style="padding:24px;color:var(--fg-dim)">Vue « ${label} » — à porter (Phase 5b).</p>`;
  };
  shell.addView({ name: "equipements", label: "Équipements", onShow: placeholder("Équipements") });
  shell.addView({ name: "datacenter", label: "Datacenter", onShow: placeholder("Datacenter") });

  shell.switchView("graph");
  Notify.toast("NetMap — pilote prêt (double-clic un nœud)", "ok");
  (window as any).__NETMAP__ = { EntityRegistry, adapter, store, shell, graph, modal };
}
boot();
