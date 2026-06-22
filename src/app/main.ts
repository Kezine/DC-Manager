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
import { Modal, Notify, FormControls } from "../ui";

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
  root.innerHTML =
    `<p style="font:13px system-ui;color:#9aa">NetMap — pilote TypeScript : socle (modèle · données · store · géométrie · UI) ` +
    `+ GraphView (tranche-pilote). ${EntityRegistry.COLLECTIONS.length} collections · ${store.totalCount()} entités.</p>`;
  const stage = document.createElement("div");
  stage.id = "graph-stage";
  stage.className = "graph-stage";
  stage.style.cssText = "position:relative;width:100%;height:560px;border:1px solid var(--line);background:var(--bg-2);overflow:hidden";
  root.appendChild(stage);

  // Shell minimal : modale d'édition partagée.
  const modal = new Modal();

  const graph = new GraphView(store, stage, {
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
  });
  graph.rebuild({ recenter: true });
  Notify.toast("NetMap — pilote prêt (double-clic un nœud)", "ok");
  (window as any).__NETMAP__ = { EntityRegistry, adapter, store, graph, modal };
}
boot();
