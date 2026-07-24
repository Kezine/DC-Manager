/* Barrel de la couche Store. */
export { Store } from "./Store";
export type { StoreMeta, GraphLayout, ListStoreOptions } from "./Store";
export { Cascade } from "./cascadeSpec";
export type { CascadeDelete, CascadeDetach, CascadePlan } from "./cascadeSpec";
// PowerAnalysis vit désormais dans src-shared/ (TS pur : moteur consommable par un FUTUR producteur d'alertes power
// côté serveur). Réexporté ici SANS extension (résolution bundler) pour préserver les imports clients "../../store".
export { PowerAnalysis, POWER_LOAD_WARN_FRACTION } from "../../src-shared/PowerAnalysis";
export type { PowerLoad, PowerWarning, PowerWarningCode, PowerAnalysisStore } from "../../src-shared/PowerAnalysis";
