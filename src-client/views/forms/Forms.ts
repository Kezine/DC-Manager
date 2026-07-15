import { DetailForms } from "./DetailForms";
export type { FormHost } from "./shared";

/** Classe MÈRE des formulaires : agrège la chaîne FormBase ← Equipment ← Cable ← Rack ← Ipam ← Detail.
    Surface publique unique (Forms.equipment, Forms.cable, Forms.networkDetail…) ; `this` statique résout ici. */
export class Forms extends DetailForms {}
