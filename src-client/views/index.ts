/* Barrel des contrôleurs de vue. */
export { GraphView } from "./GraphView";
export type { GraphHost } from "./GraphView";
export { ListView } from "./ListView";
export type { ListOptions, ListColumn, ListActions } from "./ListView";
export { ListConfigs } from "./ListConfigs";
export { Forms } from "./Forms";
export type { FormHost } from "./Forms";
// Formulaires de la feature VM (AMOVIBLE) — hors chaîne `Forms`, branchés directement (modale de mapping réseaux).
export { VmForms } from "./forms/VmForms";
export { VmProvidersForm } from "./forms/VmProvidersForm";
export { VmSyncClient } from "./forms/VmSyncClient";
// Formulaires de la feature CLIENTS WIFI (AMOVIBLE) — hors chaîne `Forms`, branchés directement.
export { WifiForms } from "./forms/WifiForms";
export { WifiProvidersForm } from "./forms/WifiProvidersForm";
export { WifiSyncClient } from "./forms/WifiSyncClient";
// PONT « interventions ⇄ tracker distant » (feature AMOVIBLE, mode API) — client REST détachable,
// INSTANCIÉ par main.ts puis injecté dans la vue Interventions. La modale des providers
// (`forms/TrackerProvidersForm`) et le bloc « Ticket » des fiches (`forms/TrackerTicketBlock`) ne
// passent PAS par ce barrel : seule la vue Interventions les monte, elle les importe donc en direct.
// Retirer la feature = supprimer ces trois fichiers + `core/TrackerStatus`/`core/TrackerReplication`
// + leurs branchements dans `InterventionsAdminView`/`main.ts`, sans cicatrice ailleurs.
export { TrackerSyncClient } from "./forms/TrackerSyncClient";
// Sous-onglet « Clusters » de la feature VM (AMOVIBLE, mode API) — vue dédiée détachable.
export { VmClustersView } from "./VmClustersView";
export type { VmClustersHost } from "./VmClustersView";
// Page d'administration « Notifications » (feature notify/ AMOVIBLE, mode API) — vue dédiée + client REST détachables.
export { NotificationsAdminView } from "./NotificationsAdminView";
export { NotifyClient } from "./forms/NotifyClient";
// Page « Certificats » (feature certs/ AMOVIBLE, PKI zéro-connaissance, mode API) — vue dédiée + client REST détachables.
export { CertsAdminView } from "./CertsAdminView";
export { CertsClient } from "./forms/CertsClient";
// Page « Interventions » (feature interventions/ AMOVIBLE, mode API) — vue dédiée + client REST détachables.
export { InterventionsAdminView } from "./InterventionsAdminView";
export type { InterventionTargetSource } from "./InterventionsAdminView";
export { InterventionsClient } from "./forms/InterventionsClient";
// Intégration « fiches » (badge + déclaration depuis équipement/VM/spare) — contrat découplé injecté via FormHost.
export type { InterventionFicheHooks, InterventionFicheItem } from "./InterventionFicheHooks";
export { DatacenterView } from "./DatacenterView";
export type { DatacenterHost } from "./DatacenterView";
