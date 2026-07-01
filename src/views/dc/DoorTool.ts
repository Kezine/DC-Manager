/* =============================================================================
   OUTIL PORTES — contrôleur des PORTES de salle (value-objects `datacenters.doors`).

   Extrait du monolithe `DcInteract` (dette CLAUDE.md n°2/9). Ce module porte le CRUD
   et le menu contextuel d'une porte ; il est VOLONTAIREMENT découplé de la chaîne de vues
   Datacenter : il ne connaît que `DoorHost` (services fournis par la vue). La géométrie PURE
   vit dans `geometry/DoorGeometry`, les valeurs/libellés/défauts dans `domain/Doors`.

   NB (incrément en cours) : le rendu 2D (`doorNode2D`), le drag (`onDoorPointerDown`), la
   contribution au positionnement assisté (`posScene`) et la carte de panneau (`doorsCard`)
   seront rapatriés ici lors des étapes suivantes ; ils appellent déjà ce contrôleur pour le CRUD.
   ============================================================================= */
import { Id } from "../../core/Id";
import { Doors, type DoorWall } from "../../domain/Doors";
import type { CtxSection } from "../../ui/ContextMenu";

/** Services dont l'outil a besoin de sa vue hôte (agnostique de la chaîne de vues). */
export interface DoorHost {
  /** Persiste la LISTE de portes d'une salle (`datacenters.doors`) et marque le document modifié. */
  persistDoors(dcId: string, doors: any[]): Promise<void>;
  /** Ouvre le formulaire d'édition d'une porte (onglet formulaires — hors vue 2D/3D). */
  openDoorForm(dcId: string, doorId: string): void;
}

export class DoorTool {
  constructor(private readonly host: DoorHost) {}

  /** Nouvelle porte par défaut (cf. `Doors.defaults`) sur `wall`, centrée le long de ce mur. Renvoie son id. */
  async add(dc: any, wall: DoorWall = "top"): Promise<string> {
    const wallLen = Doors.isVerticalWall(wall) ? dc.depth_mm : dc.width_mm;
    const door = { id: Id.uid(), ...Doors.defaults(wall, wallLen) };
    await this.host.persistDoors(dc.id, [...(dc.doors || []), door]);
    return door.id;
  }
  /** Applique un patch partiel à la porte `id` de la salle `dc`. */
  async update(dc: any, id: string, patch: Record<string, any>): Promise<void> {
    await this.host.persistDoors(dc.id, (dc.doors || []).map((d: any) => (d.id === id ? { ...d, ...patch } : d)));
  }
  /** Supprime la porte `id` de la salle `dc`. */
  async remove(dc: any, id: string): Promise<void> {
    await this.host.persistDoors(dc.id, (dc.doors || []).filter((d: any) => d.id !== id));
  }

  /** Menu contextuel d'une porte : modifier (form) · basculer charnière / sens d'ouverture · supprimer. */
  ctx(dc: any, door: any): CtxSection[] {
    return [{ head: "🚪 Porte — passage " + Math.round(Doors.freeWidth(door)) + " mm", items: [
      { label: "Modifier…", action: () => this.host.openDoorForm(dc.id, door.id) },
      { label: "Charnière : " + (door.hinge === "left" ? "→ droite" : "→ gauche"), action: () => this.update(dc, door.id, { hinge: Doors.toggleHinge(door.hinge) }) },
      { label: "Ouverture : " + (door.opening === "interior" ? "→ extérieur" : "→ intérieur"), action: () => this.update(dc, door.id, { opening: Doors.toggleOpening(door.opening) }) },
      { label: "Supprimer la porte", danger: true, action: () => this.remove(dc, door.id) },
    ] }];
  }
}
