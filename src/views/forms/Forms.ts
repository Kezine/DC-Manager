import { IpamForms } from "./IpamForms";
export type { FormHost } from "./shared";

/** Classe MÈRE des formulaires : agrège la chaîne FormBase ← Equipment ← Cable ← Rack ← Ipam.
    Surface publique unique (Forms.equipment, Forms.cable, …) ; `this` statique résout vers cette classe. */
export class Forms extends IpamForms {}
