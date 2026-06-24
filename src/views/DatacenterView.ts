/* DatacenterView a été découpé en couches sous `views/dc/` (chaîne d'héritage, un seul `this`) :
   - `dc/shared.ts`   : constantes + types (`Vec3`, `Drawable`, `DatacenterHost`)
   - `dc/DcBase.ts`   : champs d'état + constructeur + cycle de vie / scaffolding de scène
   - `dc/DcCamera.ts` : caméra orbitale, projection, pivot, zoom/pan, recadrage, contrôles, export
   - `dc/DcScene3D.ts`: rendu 3D (baies, équipements, câbles, waypoints, étages, multi-salles)
   - `dc/DcViews2D.ts`: vues Dessus / Étage + glisser-déposer 2D
   - `dc/DcPanels.ts` : toolbar + panneau latéral (cartes)
   - `dc/DcInteract.ts`: tooltips, menus contextuels, routage, wiring d'événements
   - `dc/DatacenterView.ts` : classe finale `DatacenterView` (agrège la chaîne)
   Ce fichier reste un POINT D'ENTRÉE stable (ré-export) — importeurs inchangés. */
export { DatacenterView } from "./dc/DatacenterView";
export type { DatacenterHost } from "./dc/shared";
