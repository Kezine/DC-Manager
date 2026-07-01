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
import { Format } from "../../core/Format";
import { Doors, type DoorWall } from "../../domain/Doors";
import { DoorGeometry } from "../../geometry/DoorGeometry";
import { Dom } from "../../ui/Dom";
import type { CtxSection } from "../../ui/ContextMenu";

/** Services dont l'outil a besoin de sa vue hôte (agnostique de la chaîne de vues). */
export interface DoorHost {
  /** Persiste la LISTE de portes d'une salle (`datacenters.doors`) et marque le document modifié. */
  persistDoors(dcId: string, doors: any[]): Promise<void>;
  /** Ouvre le formulaire d'édition d'une porte (onglet formulaires — hors vue 2D/3D). */
  openDoorForm(dcId: string, doorId: string): void;
  /* -- rendu 2D + drag -- */
  /** Toggle d'affichage du débattement des portes (option de vue partagée 2D/3D). */
  doorShowSwing(): boolean;
  /** Échelle mm→px courante (jamais 0). */
  doorScale(): number;
  /** Écran → monde (mm) dans la vue courante. */
  clientToWorld(cx: number, cy: number): { x: number; y: number };
  /** Cote flottante (suit le pointeur) / masquage. */
  showCote(text: string, clientX: number, clientY: number): void;
  hideCote(): void;
  /** Ouvre le menu contextuel avec les sections données. */
  ctxMenu(e: MouseEvent, sections: CtxSection[]): void;
  /** Outil de POSITIONNEMENT assisté actif dans la vue courante ? (délégation du drag aimanté). */
  posActiveHere(): boolean;
  /** Délègue le glisser à l'outil de positionnement (aimantation + cotes). */
  posDragEntity(e: MouseEvent, id: string): void;
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

  /* ---- rendu 2D (SVG) + glisser le long du mur ---- */
  /** PORTE de salle en 2D : ouverture + listel + PASSAGE LIBRE (largeur max d'équipement) + vantail + débattement,
      collée au mur. Déplaçable LE LONG de son mur. `room` = repère salle courant (Plan de salle : coords salle ;
      Étage : coords locales de la salle, appliquées par le groupe transformé → affichage seul, `draggable=false`). */
  node2D(dc: any, door: any, room: { w: number; h: number }, draggable = true): SVGElement {
    const g = Dom.svg("g", { class: "dc-door" + (draggable ? "" : " static"), "data-door": door.id });
    const cur = { ...door };
    const fill = (): void => {
      while (g.firstChild) g.removeChild(g.firstChild);
      const gg = DoorGeometry.geom(cur, room);
      const sw = gg.swing, th = Math.max(cur.frame_mm || 0, 60);   // épaisseur schématique de la PORTE (⟂ au mur, côté ouverture)
      // bloc rectangulaire le long du mur (p1→p2) prolongé de `th` côté ouverture
      const rectPoly = (p1: any, p2: any, cls: string) => Dom.svg("polygon", { class: cls, points: [p1, p2, { x: p2.x + sw.x * th, y: p2.y + sw.y * th }, { x: p1.x + sw.x * th, y: p1.y + sw.y * th }].map((p) => p.x.toFixed(1) + "," + p.y.toFixed(1)).join(" ") });
      g.appendChild(Dom.svg("line", { class: "dc-door-hit", x1: gg.a.x, y1: gg.a.y, x2: gg.b.x, y2: gg.b.y }));   // zone de clic (le long de l'ouverture)
      // DÉBATTEMENT = SECTEUR rempli (quart de disque), même style ET même toggle (showDoorSwing) que les portes de baie
      if (this.host.doorShowSwing()) {
        const seg = ["M " + gg.clearHinge.x + " " + gg.clearHinge.y];
        DoorGeometry.arcPoints(gg, 16).forEach((p) => seg.push("L " + p.x.toFixed(1) + " " + p.y.toFixed(1)));
        seg.push("Z");
        g.appendChild(Dom.svg("path", { class: "dc-door-swing", d: seg.join(" ") }));
      }
      // VANTAIL à la PLEINE largeur du formulaire (a→b) = surface de la PORTE (fermée, à plat sur le mur).
      g.appendChild(rectPoly(gg.a, gg.b, "dc-door-leaf"));
      // LISTEL = RÉSERVATION dessinée À L'INTÉRIEUR de la surface de la porte, aux 2 extrémités (a→clearHinge,
      // clearLatch→b). C'est la butée de fermeture → le passage libre au milieu est TOUJOURS plus petit que la porte.
      if ((cur.frame_mm || 0) > 0) {
        g.appendChild(rectPoly(gg.a, gg.clearHinge, "dc-door-frame"));
        g.appendChild(rectPoly(gg.clearLatch, gg.b, "dc-door-frame"));
      }
      g.appendChild(Dom.svg("line", { class: "dc-door-clear", x1: gg.clearHinge.x, y1: gg.clearHinge.y, x2: gg.clearLatch.x, y2: gg.clearLatch.y }));   // passage LIBRE (largeur max d'équipement) au ras du mur
      // vantail OUVERT à 90° : fait partie du débattement → même toggle
      if (this.host.doorShowSwing()) g.appendChild(Dom.svg("line", { class: "dc-door-leaf-open", x1: gg.clearHinge.x, y1: gg.clearHinge.y, x2: gg.leafOpen.x, y2: gg.leafOpen.y }));
      const mx = (gg.clearHinge.x + gg.clearLatch.x) / 2, my = (gg.clearHinge.y + gg.clearLatch.y) / 2;
      const t = Dom.svg("text", { class: "dc-door-label", x: mx + gg.swing.x * 170, y: my + gg.swing.y * 170, "text-anchor": "middle", "dominant-baseline": "central", "font-size": 190 });
      t.textContent = Math.round(gg.clear) + " mm"; g.appendChild(t);
    };
    fill();
    if (draggable) g.addEventListener("pointerdown", (e: any) => this.onPointerDown(e, dc, door, cur, room, fill));   // drag = Plan de salle (coords salle) ; en étage la salle est transformée → affichage seul
    g.addEventListener("contextmenu", (e: any) => { e.preventDefault(); e.stopPropagation(); this.host.ctxMenu(e, this.ctx(dc, door)); });
    return g;
  }

  /** Glisser une porte LE LONG de son mur (met à jour `offset`, borné). `cur` = copie d'aperçu ; persiste au relâcher. */
  private onPointerDown(e: MouseEvent, dc: any, door: any, cur: any, room: { w: number; h: number }, fill: () => void): void {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    if (this.host.posActiveHere()) { this.host.posDragEntity(e, door.id); return; }   // mode assisté : glisser aimanté + cotes (contraint au mur par le commit)
    const along = Doors.isVerticalWall(door.wall);   // mur vertical → glisse en y ; horizontal → en x
    const startCoord = along ? this.host.clientToWorld(e.clientX, e.clientY).y : this.host.clientToWorld(e.clientX, e.clientY).x;
    const off0 = door.offset; let moved = false;
    const move = (ev: MouseEvent) => {
      const w = this.host.clientToWorld(ev.clientX, ev.clientY), coord = along ? w.y : w.x;
      if (!moved && Math.abs(coord - startCoord) < (8 / this.host.doorScale())) return;
      moved = true;
      cur.offset = Math.round(DoorGeometry.clampOffset({ ...cur, offset: off0 + (coord - startCoord) }, room));
      fill(); this.host.showCote(Format.meters(cur.offset), ev.clientX, ev.clientY);
    };
    const up = async () => {
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
      this.host.hideCote();
      if (moved) await this.update(dc, door.id, { offset: cur.offset });
    };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  }
}
