/* Couche SYNCHRONISATION — rechargement granulaire en mode REST (changeset → plan). */
export { COLLECTION_THREE_IMPACT, threeImpactOf, worseThreeImpact, unmappedCollections } from "./RenderImpact";
export type { ThreeImpact } from "./RenderImpact";
export { emptyChangeset, fullChangeset, coerceChangeset, mergeChangesets } from "./Changeset";
export type { DocumentChangeset } from "./Changeset";
export { ReloadPlanner } from "./ReloadPlanner";
export type { ReloadPlan } from "./ReloadPlanner";
