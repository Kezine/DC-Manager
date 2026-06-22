/* Point d'entrée TEMPORAIRE de la migration.
   À ce stade, seul le MODÈLE DE DOMAINE est extrait (cf. MIGRATION.md). Les
   couches Store / vues sont encore dans le HTML monolithique et seront portées
   ensuite. Cette entrée se contente d'instancier le registre pour prouver la
   chaîne de compilation webpack → TypeScript et exposer le modèle au debug. */
import { EntityRegistry, Equipment } from "../models";

const root = document.getElementById("app");
if (root) {
  const demo = new Equipment({ name: "demo-switch", type: "switch", u_height: 1 });
  root.textContent =
    `NetMap — socle TypeScript prêt. ` +
    `${EntityRegistry.COLLECTIONS.length} collections de domaine, ` +
    `entité de démo « ${demo.name} » (id ${demo.id}).`;
}

// Exposé pour inspection en console pendant la migration.
(window as any).__NETMAP_MODELS__ = EntityRegistry;
