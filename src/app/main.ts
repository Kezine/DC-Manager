/* Point d'entrée TEMPORAIRE de la migration.
   À ce stade, le MODÈLE DE DOMAINE et la COUCHE DONNÉES sont extraits
   (cf. MIGRATION.md). Le Store et les vues sont encore dans le HTML monolithique
   et seront portés ensuite. Cette entrée instancie le registre + un adapter pour
   prouver la chaîne de compilation webpack → TypeScript et exposer au debug. */
import { EntityRegistry } from "../models";
import { BrowserStorageAdapter } from "../data";
import { Store } from "../store";

const adapter = new BrowserStorageAdapter({ persistent: false });
const store = new Store(adapter);

async function boot(): Promise<void> {
  await store.init();
  const root = document.getElementById("app");
  if (root) {
    root.textContent =
      `NetMap — socle TypeScript prêt (modèle · données · store). ` +
      `${EntityRegistry.COLLECTIONS.length} collections · ` +
      `adapter « ${adapter.label} » · ` +
      `${store.restored ? "session restaurée" : "aucune session"} · ` +
      `${store.totalCount()} entités en cache.`;
  }
}
boot();

// Exposé pour inspection en console pendant la migration.
(window as any).__NETMAP__ = { EntityRegistry, adapter, store };
