/* Point d'entrée TEMPORAIRE de la migration.
   À ce stade, le MODÈLE DE DOMAINE et la COUCHE DONNÉES sont extraits
   (cf. MIGRATION.md). Le Store et les vues sont encore dans le HTML monolithique
   et seront portés ensuite. Cette entrée instancie le registre + un adapter pour
   prouver la chaîne de compilation webpack → TypeScript et exposer au debug. */
import { EntityRegistry, Equipment } from "../models";
import { BrowserStorageAdapter } from "../data";

const adapter = new BrowserStorageAdapter({ persistent: false });

const root = document.getElementById("app");
if (root) {
  const demo = new Equipment({ name: "demo-switch", type: "switch", u_height: 1 });
  root.textContent =
    `NetMap — socle TypeScript prêt. ` +
    `${EntityRegistry.COLLECTIONS.length} collections de domaine · ` +
    `adapter « ${adapter.label} » · ` +
    `entité de démo « ${demo.name} » (id ${demo.id}).`;
}

// Exposé pour inspection en console pendant la migration.
(window as any).__NETMAP__ = { EntityRegistry, adapter };
