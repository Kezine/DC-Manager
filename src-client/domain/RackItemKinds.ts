import { RACK_ITEM_KINDS, RackItemKindDef } from "./constants";

const BY_ID: Record<string, RackItemKindDef> = Object.fromEntries(RACK_ITEM_KINDS.map((k) => [k.id, k]));

/** Registre des pseudo-équipements montables en rack (blank | tray | keepblank). */
export class RackItemKinds {
  static readonly ALL = RACK_ITEM_KINDS;

  static has(id: unknown): boolean {
    return !!BY_ID[id as string];
  }

  static label(id: string): string {
    const k = BY_ID[id];
    return k ? k.label : (id || "—");
  }

  static icon(id: string): string {
    const k = BY_ID[id];
    return k && k.icon ? k.icon : "";
  }

  /** Libellé d'un pseudo-élément : son label libre, sinon le libellé de son type. */
  static itemLabel(it: any): string {
    return (it.label && it.label.trim()) ? it.label : RackItemKinds.label(it.kind);
  }
}
