/* =============================================================================
   DOMAINE des PORTES de salle — valeurs canoniques + libellés + défauts + règles PURES.

   Source UNIQUE pour tout ce qui touche aux énumérations et défauts d'une porte de salle
   (`DcDoor`), aujourd'hui dispersés/dupliqués : normalisation (`Normalize.dcDoors`), création
   (`addDoor`), menus contextuels, cartes de panneau et (à venir) l'outil dédié. Aligné sur le
   principe CLAUDE.md n°10 (énumérations normalisées via un domaine, comme `CableStatuses`,
   `RackItemKinds`…). TS PUR : ni DOM, ni core, ni store → testable en isolation.
   ============================================================================= */

/** Murs porteurs possibles d'une porte (top = avant, bottom = arrière). */
export const DOOR_WALLS = ["top", "bottom", "left", "right"] as const;
export type DoorWall = (typeof DOOR_WALLS)[number];
/** Côté charnière (défini depuis le côté d'ouverture — cf. DcDoor / DoorGeometry). */
export const DOOR_HINGES = ["left", "right"] as const;
export type DoorHinge = (typeof DOOR_HINGES)[number];
/** Sens d'ouverture (vers l'intérieur ou l'extérieur de la salle). */
export const DOOR_OPENINGS = ["interior", "exterior"] as const;
export type DoorOpening = (typeof DOOR_OPENINGS)[number];
/** Nombre de vantaux : 1 (simple) ou 2 (double battant). */
export const DOOR_LEAVES = [1, 2] as const;
export type DoorLeaves = (typeof DOOR_LEAVES)[number];

/** Dimensions par défaut d'une NOUVELLE porte (mm). */
export const DOOR_DEFAULT_WIDTH_MM = 900;
export const DOOR_DEFAULT_HEIGHT_MM = 2100;
export const DOOR_DEFAULT_FRAME_MM = 40;

/** Champs d'une porte HORS identité (la forme `DcDoor` sans son `id`). */
export interface DoorSpec {
  wall: DoorWall; offset: number; width_mm: number; height_mm: number; frame_mm: number; hinge: DoorHinge; leaves: DoorLeaves; opening: DoorOpening;
}

/** Règles et libellés PURS des portes de salle (méthodes statiques — cf. CLAUDE.md). */
export class Doors {
  /** Libellé métier d'un mur (avant/arrière/gauche/droit). */
  static readonly WALL_LABEL: Record<DoorWall, string> = { top: "avant", bottom: "arrière", left: "gauche", right: "droit" };
  static wallLabel(wall: string): string { return Doors.WALL_LABEL[wall as DoorWall] || wall; }
  /** Un mur VERTICAL (gauche/droite) → la porte se positionne/glisse le long de l'axe Y (sinon X). */
  static isVerticalWall(wall: string): boolean { return wall === "left" || wall === "right"; }
  /** Passage LIBRE (largeur max d'équipement) = ouverture − 2·listel, borné ≥ 0. */
  static freeWidth(door: { width_mm: number; frame_mm?: number }): number { return Math.max(0, door.width_mm - 2 * (door.frame_mm || 0)); }
  /** Bascule du côté charnière. */
  static toggleHinge(h: string): DoorHinge { return h === "left" ? "right" : "left"; }
  /** Bascule du sens d'ouverture. */
  static toggleOpening(o: string): DoorOpening { return o === "interior" ? "exterior" : "interior"; }
  /** Bascule simple ↔ double battant. */
  static toggleLeaves(l: unknown): DoorLeaves { return l === 2 ? 1 : 2; }
  /** Double battant ? (2 vantaux, charnières aux deux extrémités, loquets au centre). */
  static isDouble(door: { leaves?: unknown }): boolean { return door.leaves === 2; }
  /** Champs d'une porte par DÉFAUT sur `wall`, centrée le long d'un mur de longueur `wallLen` mm. SANS `id`
      (ajouté par l'appelant, seul détenteur de la fabrique d'identifiants). */
  static defaults(wall: DoorWall, wallLen: number): DoorSpec {
    return { wall, offset: Math.round(Math.max(0, wallLen) / 2), width_mm: DOOR_DEFAULT_WIDTH_MM, height_mm: DOOR_DEFAULT_HEIGHT_MM, frame_mm: DOOR_DEFAULT_FRAME_MM, hinge: "left", leaves: 1, opening: "interior" };
  }
}
