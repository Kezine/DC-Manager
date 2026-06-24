/* Constantes et types PARTAGÉS par les couches de la vue Datacenter (extraits de l'ancien
   DatacenterView.ts monolithique). Importés par DcBase et toutes les classes filles. */

export const DC_DOT_PX = 5;                 // rayon écran (px) des pastilles de câble
export const WP_HIT_PX = 14;                // rayon écran (px) des zones de clic/glisser des waypoints (vue Dessus)
export const CABLE_PORT_STUB_MM = 20;       // longueur du stub de sortie ⊥ des ports (cablePortNormal)
export const CABLE_SPLINE_K = 1 / 6;        // tension Catmull-Rom (arrondi des câbles routés)

export const CAM_PRESETS: Record<string, [number, number]> = {
  iso: [-0.62, 0.46], top: [0, Math.PI / 2], front: [0, 0], back: [Math.PI, 0], side: [Math.PI / 2, 0],
};

/* icônes de PORTÉE d'affichage 3D (salle active / bâtiment / tous les sites). */
export const DC_SCOPE_ICONS = {
  self: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7.5"/><line x1="12" y1="1.5" x2="12" y2="4.5"/><line x1="12" y1="19.5" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="4.5" y2="12"/><line x1="19.5" y1="12" x2="22.5" y2="12"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/></svg>',
  bldg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="7" y="2.5" width="10" height="19"/><path d="M9.7 6h1.2M13.1 6h1.2M9.7 10h1.2M13.1 10h1.2M9.7 14h1.2M13.1 14h1.2" stroke-width="1.6"/></svg>',
  all: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="2.5" y="9" width="5.5" height="12.5"/><rect x="9.25" y="3.5" width="5.5" height="18"/><rect x="16" y="11.5" width="5.5" height="10"/></svg>',
};

export interface Vec3 { x: number; y: number; z: number; }
export interface Drawable { depth: number; node: SVGElement; }

/** Services applicatifs / callbacks de la vue Datacenter (câblés par le shell). */
export interface DatacenterHost {
  setDirty?(v: boolean): void;
  openRackForm?(id: string): void;
  openEquipmentDetail?(id: string): void;
  openCableForm?(id: string | null, opts?: any): void;
  openWaypointForm?(id: string | null, opts?: any): void;
  openDatacenterForm?(id: string): void;
  openFloorForm?(location: string, floor: string, opts?: any): void;
  /** URL (objectURL) de l'image attachée à une face d'un équipement, ou null. */
  faceImageUrl?(eqId: string, face: string): string | null;
  /** Assignation d'un emplacement libre (clic 3D) → dialogue, puis `onDone` rafraîchit la vue. */
  assignSlot?(rackId: string, u: number, side: string, height: number, onDone: () => void): void;
  assignSideSlot?(rackId: string, face: string, lr: string, col: number, uTop: number, onDone: () => void): void;
  assignWallSlot?(rackId: string, wall: string, margin: string, col: number, uTop: number, onDone: () => void): void;
  assignCapSlot?(rackId: string, face: string, cx: number, cy: number, onDone: () => void): void;
}
