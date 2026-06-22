import { PORT_ROLES, PortRoleDef } from "../domain/constants";

const BY_ID: Record<string, PortRoleDef> = Object.fromEntries(PORT_ROLES.map((r) => [r.id, r]));

/** Registre des rôles de port (mgmt | data | power). */
export class PortRoles {
  static readonly ALL = PORT_ROLES;

  /** Libellé du rôle ; repli sur l'id (ou « — » si vide). */
  static label(id: string): string {
    const r = BY_ID[id];
    return r ? r.label : (id || "—");
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
}
