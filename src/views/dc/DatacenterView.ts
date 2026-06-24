import { DcInteract } from "./DcInteract";
export type { DatacenterHost } from "./shared";

/** Vue Datacenter - classe finale agregeant la chaine DcBase <- Camera <- Scene3D <- Views2D <- Panels <- Interact.
    Un seul this : l'etat (champs) vit sur DcBase, chaque couche ajoute son groupe de methodes. */
export class DatacenterView extends DcInteract {}
