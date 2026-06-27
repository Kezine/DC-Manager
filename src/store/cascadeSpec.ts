/* La cascade de suppression (intégrité référentielle) vit désormais dans `shared/Cascade.ts`,
   PARTAGÉE front ⇄ back : appliquée par le `Store` en mode fichier ET par le serveur sur `DELETE`
   (cf. principe n°3 — réutilisation plutôt que duplication). Ce module ne fait que ré-exporter,
   pour préserver le point d'import des consommateurs du package `store`. */
export { Cascade } from "../../shared/Cascade";
export type { CascadeDelete, CascadeDetach, CascadePlan } from "../../shared/Cascade";
