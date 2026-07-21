import { PORT_ROLES, PortRoleDef } from "../domain/constants";
import { I18n } from "../i18n/I18n";

const BY_ID: Record<string, PortRoleDef> = Object.fromEntries(PORT_ROLES.map((r) => [r.id, r]));

/** Registre des rôles de port (mgmt | data | power). */
export class PortRoles {
  static readonly ALL = PORT_ROLES;

  /** Libellé du rôle ; repli sur l'id (ou « — » si vide). */
  static label(id: string): string {
    const r = BY_ID[id];
    return r ? I18n.t(r.labelKey) : (id || "—");
  }

  /** Catégorie d'un rôle (défaut « data »). */
  static kind(roleId: string): "data" | "power" {
    const r = BY_ID[roleId];
    return r ? r.kind : "data";
  }

  /** Rôles éligibles à une catégorie donnée. */
  static forKind(kind: string): PortRoleDef[] {
    return PORT_ROLES.filter((r) => r.kind === (kind || "data"));
  }

  /** Le rôle transporte-t-il du POE (data + alimentation) ? Le POE est de `kind: "data"` (connecteurs/réseaux
      data) mais participe à l'énergie et fait porter l'éclair d'avertissement aux câbles — marqueur = l'ID "poe". */
  static isPoe(roleId: string): boolean {
    return roleId === "poe";
  }

  /** Classe de PASTILLE (`.pill`) d'un rôle : `role-mgmt|role-data|role-power|role-poe`. Rôle inconnu → `role-data`.
      UNIQUE source de ce mapping (évite les ternaires dupliqués dans les vues/fiches — CLAUDE.md n°3). */
  static pillClass(roleId: string): string {
    return "role-" + (BY_ID[roleId] ? roleId : "data");
  }

  /** Suffixe de classe pour un MARQUEUR de façade (`.face-marker`/`.face-dot`) : ` role-<id>` pour mgmt/power/poe,
      chaîne VIDE pour data (le data garde l'accent par défaut — comportement historique). */
  static markerRoleClass(roleId: string): string {
    return (roleId === "mgmt" || roleId === "power" || roleId === "poe") ? " role-" + roleId : "";
  }
}
