import { RACK_ORIENTATIONS } from "../domain/constants";

/** Porte de rack normalisée (value-object).
    Définie ICI, et non dans models/Rack, par RESPECT DES COUCHES : c'est la forme
    PRODUITE par `Normalize.rackDoor()` ci-dessous. Comme `core/` ne doit jamais
    importer `models/`, on place le type près de sa fabrique ; `Rack` l'importe
    « vers le bas » (models → core). (Si on préfère regrouper les value-objects,
    les déplacer dans un `core/valueObjects.ts` — mais surtout pas dans models/.) */
export interface RackDoor {
  enabled: boolean;
  thickness_mm: number;
  hinge: "left" | "right";
  hollow: boolean;
  hollow_mm: number;
}

/* Normalisations partagées par plusieurs entités (orientation, portes, cellules,
   listes d'ids). Regroupées en méthodes statiques plutôt qu'en fonctions libres. */
export class Normalize {
  /** Déduplique une liste d'identifiants en préservant l'ordre. */
  static uniqIds<T>(arr: T[]): T[] {
    return arr.filter((id, i) => arr.indexOf(id) === i);
  }

  /** Ramène une orientation à {0,90,180,270} (0 par défaut). */
  static rackOrientation(o: unknown): number {
    const n = (((o as number) | 0) % 360 + 360) % 360;
    return RACK_ORIENTATIONS.includes(n) ? n : 0;
  }

  /** Liste de cellules « cx,cy » valides et uniques. */
  static cellList(v: unknown): string[] {
    return Array.isArray(v)
      ? Array.from(new Set(v.filter((s: unknown): s is string => typeof s === "string" && /^-?\d+,-?\d+$/.test(s))))
      : [];
  }

  /** Porte de rack { enabled, thickness_mm, hinge, hollow, hollow_mm }. */
  static rackDoor(p: any): RackDoor {
    p = p || {};
    return {
      enabled: p.enabled === true,
      thickness_mm: (p.thickness_mm != null && p.thickness_mm !== "") ? Math.max(1, p.thickness_mm | 0) : 40,
      hinge: (p.hinge === "right") ? "right" : "left",
      hollow: p.hollow === true,
      hollow_mm: (p.hollow_mm != null && p.hollow_mm !== "") ? Math.max(0, p.hollow_mm | 0) : 0,
    };
  }
}
