/* =============================================================================
   OUTIL DE POSITIONNEMENT — contrôleur de VUE (overlay SVG + cotes + panneau + drag).

   Aide au placement d'un élément (baie / équipement libre / salle d'étage) via ses
   COINS, par rapport aux MURS du cadre ou aux COINS d'autres éléments (ancres), avec
   des cotes PERPENDICULAIRES aux côtés. C'est une AIDE : on déplace l'élément « mover »
   et on écrit sa position UNE fois — aucune relation (coin ↔ référence) n'est mémorisée.

   Ce module est VOLONTAIREMENT découplé de la chaîne de vues Datacenter : il ne connaît
   que `PositioningHost` (services fournis par la vue) et le cœur PUR `geometry/Positioning`.
   Toute la spécificité d'entité (quels rectangles, comment écrire la position, repère) est
   portée par `host.posScene()` — unique point d'adaptation, identique pour le Plan de salle
   ET le Plan d'étage. Le DOM utilisé (SVG, panneau) est créé via Dom/HTML standard.
   ============================================================================= */
import { Dom } from "../../ui/Dom";
import { Notify } from "../../ui/Notify";
import { Html } from "../../core/Html";
import { Format } from "../../core/Format";
import { Positioning, CORNER_IDS, WALL_IDS } from "../../geometry/Positioning";
import type { Frame, Rect, CornerId, WallId, Axis, Ref } from "../../geometry/Positioning";

/** Une entité DÉPLAÇABLE : `rect` = centre + demi-extents (repère monde de la vue) ; `anchor` = ancrage du nœud SVG
    ("center" + rotation, ou "topleft" pour une salle d'étage) ; `commit(cx,cy)` écrit la position dans le modèle. */
export interface PosEntry { id: string; name: string; rect: Rect; orient: number; anchor: "center" | "topleft"; commit: (cx: number, cy: number) => Promise<void>; }

/** Scène fournie par la vue : le cadre conteneur + les entités déplaçables. */
export interface PosScene { frame: Frame; rects: PosEntry[]; }

/** Services dont l'outil a besoin de sa vue hôte (agnostique : Plan de salle OU Plan d'étage). */
export interface PositioningHost {
  /** Entités déplaçables de la vue courante (null hors vue 2D). UNIQUE point d'adaptation. */
  posScene(): PosScene | null;
  /** Clé du contexte spatial (salle / étage) — scope l'outil là où il a été armé. */
  posCtxKey(): string;
  /** Vue 2D (Plan de salle / Plan d'étage) où l'outil opère ? */
  posIs2D(): boolean;
  /** Nature de la vue courante (pour les libellés du panneau). */
  posViewKind(): "top" | "floor" | "3d";
  /** Échelle courante mm→px (jamais 0). */
  posScale(): number;
  /** Groupe SVG racine (overlay + lignes-guides). */
  posGRoot(): SVGGElement | null;
  /** Désactive les autres outils de clic (mesure / routage) — exclusivité mutuelle. */
  posClearOtherTools(): void;
  /** Écran → monde (mm) dans la vue courante. */
  clientToWorld(cx: number, cy: number): { x: number; y: number };
  /** Cote flottante (suit le pointeur). */
  showCote(text: string, clientX: number, clientY: number): void;
  hideCote(): void;
  /** Re-rendu complet (scène + panneau). */
  render(): void;
  /** Reconstruit la barre d'outils (état du bouton). */
  buildToolbar(): void;
}

export class PositioningTool {
  active = false;
  private ctx = "";
  moverId: string | null = null;
  corner: CornerId | null = null;
  refX: Ref | null = null;
  refY: Ref | null = null;

  constructor(private readonly host: PositioningHost) {}

  /* ---- cycle de vie ---- */
  /** Arme l'outil dans le contexte courant (exclusif de la mesure / du routage). */
  arm(): void {
    this.host.posClearOtherTools();
    this.active = true; this.ctx = this.host.posCtxKey();
    this.moverId = null; this.corner = null; this.refX = null; this.refY = null;
    Notify.toast("Positionnement : cliquez un élément à déplacer, son coin, puis un mur ou le coin d'un autre élément · glissez pour aimanter", "ok");
    this.host.buildToolbar(); this.host.render();
  }
  cancel(): void { this.disarm(); this.host.hideCote(); this.host.buildToolbar(); this.host.render(); }
  /** Désactive SANS re-render (appelé quand un autre outil prend la main, qui re-render lui-même). */
  disarm(): void { this.active = false; this.moverId = null; this.corner = null; this.refX = null; this.refY = null; this.clearGuides(); }
  /** Actif dans les vues 2D, là où il a été armé. */
  activeHere(): boolean { return this.active && this.host.posIs2D() && this.ctx === this.host.posCtxKey(); }
  /** ÉCHAP : efface par paliers (références → coin → mover). */
  escape(): void {
    if (this.refX || this.refY) { this.refX = null; this.refY = null; }
    else if (this.corner) { this.corner = null; }
    else if (this.moverId) { this.moverId = null; }
    this.host.hideCote(); this.host.render();
  }

  /* ---- sélection ---- */
  /** Sélectionne l'élément à déplacer (réinitialise coin + références). Ne re-render PAS (drag garde le nœud vivant). */
  setMover(id: string): void { if (this.moverId !== id) { this.moverId = id; this.corner = null; this.refX = null; this.refY = null; } }
  setCorner(c: CornerId): void { this.corner = c; this.host.render(); }
  /** Pose une référence : un MUR fixe l'axe correspondant ; un COIN d'ancrage fixe les DEUX axes (cote X et Y). */
  setRef(ref: Ref): void {
    const scene = this.host.posScene(); if (!scene) return;
    if (!this.moverId) { Notify.toast("Choisissez d'abord un élément à déplacer.", "err"); return; }
    if (ref.kind === "corner" && ref.rectId === this.moverId) { Notify.toast("La référence doit être un MUR ou le coin d'un AUTRE élément.", "err"); return; }
    if (!this.corner) this.corner = "TL";   // coin par défaut si non choisi
    const axis = Positioning.refAxis(ref, scene.frame);
    if (axis === "x") this.refX = ref;
    else if (axis === "y") this.refY = ref;
    else { this.refX = ref; this.refY = ref; }   // coin d'ancrage → cote sur les deux axes
    this.host.render();
  }

  /* ---- helpers scène ---- */
  private rectMap(scene: PosScene): Record<string, Rect> { const m: Record<string, Rect> = {}; scene.rects.forEach((e) => { m[e.id] = e.rect; }); return m; }
  private moverEntry(scene: PosScene): PosEntry | null { return scene.rects.find((x) => x.id === this.moverId) || null; }
  /** Cotes ⟂ courantes (coin actif → références). */
  private cotes(scene: PosScene): { x: ReturnType<typeof Positioning.cote>; y: ReturnType<typeof Positioning.cote> } {
    const entry = this.moverEntry(scene);
    if (!entry || !this.corner) return { x: null, y: null };
    const corner = Positioning.corner(entry.rect, this.corner), rects = this.rectMap(scene);
    return {
      x: this.refX ? Positioning.cote(corner, this.refX, "x", scene.frame, rects) : null,
      y: this.refY ? Positioning.cote(corner, this.refY, "y", scene.frame, rects) : null,
    };
  }
  /** SAISIE numérique : place le coin actif à `value` mm de la référence sur `axis`, puis écrit la position. */
  async applyAxis(axis: Axis, value: number): Promise<void> {
    const scene = this.host.posScene(); if (!scene || !this.moverId || !this.corner) return;
    const ref = axis === "x" ? this.refX : this.refY; if (!ref) return;
    const entry = this.moverEntry(scene); if (!entry) return;
    const nc = Positioning.placeAxis(entry.rect, this.corner, axis, ref, value, scene.frame, this.rectMap(scene));
    if (nc == null) return;
    await entry.commit(axis === "x" ? nc : entry.rect.cx, axis === "y" ? nc : entry.rect.cy);
    this.host.render();
  }
  private refLabel(ref: Ref, scene: PosScene): string {
    if (ref.kind === "wall") { const w: Record<WallId, string> = { left: "mur gauche", right: "mur droit", top: "mur haut", bottom: "mur bas" }; return w[ref.wall]; }
    const e = scene.rects.find((x) => x.id === ref.rectId), cl: Record<CornerId, string> = { TL: "H-G", TR: "H-D", BR: "B-D", BL: "B-G" };
    return "« " + (e ? e.name : "?") + " » " + cl[ref.corner];
  }

  /* ---- glisser aimanté ---- */
  /** Transform SVG du nœud d'une entité pour un centre donné (selon son ancrage). */
  private nodeTransform(entry: PosEntry, cx: number, cy: number): string {
    return entry.anchor === "topleft"
      ? `translate(${cx - entry.rect.hx} ${cy - entry.rect.hy})`        // salle d'étage : nœud ancré au coin haut-gauche
      : `translate(${cx} ${cy}) rotate(${entry.orient || 0})`;          // baie / équipement : centre + rotation
  }
  /** GLISSER aimanté de l'élément cliqué : snap aux murs + coins voisins, cote live. Générique (spécificité = posScene). */
  dragEntity(e: MouseEvent, id: string): void {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const scene = this.host.posScene(); if (!scene) return;
    const moverIdx = scene.rects.findIndex((x) => x.id === id); if (moverIdx < 0) return;
    const entry = scene.rects[moverIdx], rect = entry.rect;
    this.setMover(id);   // l'élément cliqué devient la mover (sans render → on garde le nœud `grp` vivant)
    const grp = e.currentTarget as SVGElement;
    const scale = this.host.posScale();
    const w0 = this.host.clientToWorld(e.clientX, e.clientY), off = { x: w0.x - rect.cx, y: w0.y - rect.cy };
    const others = scene.rects.map((x) => x.rect), tol = Positioning.SNAP_PX / scale;
    const clampC = (c: { x: number; y: number }) => ({ x: Math.min(Math.max(c.x, rect.hx), scene.frame.w - rect.hx), y: Math.min(Math.max(c.y, rect.hy), scene.frame.h - rect.hy) });
    let cur = { x: rect.cx, y: rect.cy }, moved = false;
    const move = (ev: MouseEvent) => {
      const w = this.host.clientToWorld(ev.clientX, ev.clientY), nx = w.x - off.x, ny = w.y - off.y;
      if (!moved && Math.abs(nx - rect.cx) + Math.abs(ny - rect.cy) < (8 / scale)) return;
      moved = true; grp.classList.add("dragging");
      const snapped = Positioning.snapCenter(rect, nx, ny, scene.frame, others, moverIdx, tol);
      cur = clampC({ x: snapped.cx, y: snapped.cy });
      grp.setAttribute("transform", this.nodeTransform(entry, cur.x, cur.y));
      this.drawGuides(snapped);
      this.host.showCote(Format.meters(cur.x) + " × " + Format.meters(cur.y), ev.clientX, ev.clientY);
    };
    const up = async () => {
      document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
      grp.classList.remove("dragging"); this.host.hideCote(); this.clearGuides();
      if (moved) await entry.commit(cur.x, cur.y);
      this.host.render();   // (re)dessine l'overlay : mover sélectionnée (clic) ou déplacée (glisser)
    };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
  }
  /** Lignes-guides d'accrochage (pleine hauteur/largeur) tracées EN DIRECT pendant le glisser. */
  private drawGuides(snapped: { snapX: number | null; snapY: number | null }): void {
    const g = this.host.posGRoot(), scene = this.host.posScene(); if (!g || !scene) return;
    this.clearGuides();
    const grp = Dom.svg("g", { class: "dc-pos-drag", style: "pointer-events:none" });
    if (snapped.snapX != null) grp.appendChild(Dom.svg("line", { class: "dc-pos-guide", x1: snapped.snapX, y1: 0, x2: snapped.snapX, y2: scene.frame.h }));
    if (snapped.snapY != null) grp.appendChild(Dom.svg("line", { class: "dc-pos-guide", x1: 0, y1: snapped.snapY, x2: scene.frame.w, y2: snapped.snapY }));
    g.appendChild(grp);
  }
  private clearGuides(): void { const g = this.host.posGRoot(); if (g) g.querySelectorAll(".dc-pos-drag").forEach((n) => n.remove()); }

  /* ---- overlay SVG ---- */
  /** Overlay de l'outil (murs cliquables, poignées de coin, ancres, cotes ⟂) — appelé par renderTop / renderFloor. */
  drawOverlay(gRoot: SVGGElement): void {
    if (!this.activeHere()) return;
    const scene = this.host.posScene(); if (!scene) return;
    const g = Dom.svg("g", { class: "dc-positioning" });
    const inv = 1 / this.host.posScale(), rPx = 6 * inv, tick = 5 * inv, strip = 10 * inv;
    const handle = (pt: { x: number; y: number }, cls: string, onDown: () => void): SVGElement => {
      const c = Dom.svg("circle", { class: cls, cx: pt.x, cy: pt.y, r: rPx });
      c.addEventListener("pointerdown", (ev: any) => { ev.preventDefault(); ev.stopPropagation(); onDown(); });
      return c;
    };
    // MURS cliquables : bandes le long des 4 bords (référence d'axe au clic).
    const wallBox: Record<WallId, any> = {
      left: { x: 0, y: 0, width: strip, height: scene.frame.h },
      right: { x: scene.frame.w - strip, y: 0, width: strip, height: scene.frame.h },
      top: { x: 0, y: 0, width: scene.frame.w, height: strip },
      bottom: { x: 0, y: scene.frame.h - strip, width: scene.frame.w, height: strip },
    };
    WALL_IDS.forEach((wid) => {
      const activeWall = (this.refX && this.refX.kind === "wall" && this.refX.wall === wid) || (this.refY && this.refY.kind === "wall" && this.refY.wall === wid);
      const rect = Dom.svg("rect", { class: "dc-pos-wall" + (activeWall ? " active" : ""), ...wallBox[wid] });
      rect.addEventListener("pointerdown", (ev: any) => { ev.preventDefault(); ev.stopPropagation(); this.setRef({ kind: "wall", wall: wid }); });
      g.appendChild(rect);
    });
    // COINS des AUTRES éléments : poignées « ancre » (référence coin → cote X et Y).
    scene.rects.forEach((entry) => {
      if (entry.id === this.moverId) return;
      const cs = Positioning.corners(entry.rect);
      CORNER_IDS.forEach((cid) => g.appendChild(handle(cs[cid], "dc-pos-anchor", () => this.setRef({ kind: "corner", rectId: entry.id, corner: cid }))));
    });
    // MOVER : contour + poignées de coin (choix du coin actif) + cotes ⟂.
    const mover = this.moverEntry(scene);
    if (mover) {
      const m = mover.rect;
      g.appendChild(Dom.svg("rect", { class: "dc-pos-mover", x: m.cx - m.hx, y: m.cy - m.hy, width: m.hx * 2, height: m.hy * 2 }));
      const cs = Positioning.corners(m);
      CORNER_IDS.forEach((cid) => g.appendChild(handle(cs[cid], "dc-pos-corner" + (this.corner === cid ? " active" : ""), () => this.setCorner(cid))));
      const cotes = this.cotes(scene);
      (["x", "y"] as Axis[]).forEach((ax) => {
        const co = ax === "x" ? cotes.x : cotes.y; if (!co) return;
        g.appendChild(Dom.svg("line", { class: "dc-pos-cote", x1: co.from.x, y1: co.from.y, x2: co.to.x, y2: co.to.y }));
        const ends = [co.from, co.to];
        if (ax === "x") ends.forEach((pt) => g.appendChild(Dom.svg("line", { class: "dc-pos-cote-tick", x1: pt.x, y1: pt.y - tick, x2: pt.x, y2: pt.y + tick })));
        else ends.forEach((pt) => g.appendChild(Dom.svg("line", { class: "dc-pos-cote-tick", x1: pt.x - tick, y1: pt.y, x2: pt.x + tick, y2: pt.y })));
        const t = Dom.svg("text", { class: "dc-pos-cote-label", x: (co.from.x + co.to.x) / 2, y: (co.from.y + co.to.y) / 2 - (ax === "x" ? 4 * inv : 0), "text-anchor": "middle" });
        t.textContent = Format.meters(co.value);
        g.appendChild(t);
      });
    }
    gRoot.appendChild(g);
  }

  /* ---- panneau latéral ---- */
  private btn(text: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost btn-sm"; b.textContent = text; b.onclick = onClick; return b;
  }
  /** Carte de panneau latéral de l'outil. */
  card(): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const title = document.createElement("div"); title.className = "dc-card-title"; title.textContent = "📐 Positionnement"; box.appendChild(title);
    const scene = this.host.posScene();
    if (!scene) {
      const h = document.createElement("div"); h.className = "form-hint"; h.textContent = "Disponible en vue 2D (Plan de salle ou Plan d'étage)."; box.appendChild(h);
      const acts = document.createElement("div"); acts.className = "dc-card-acts"; const bc = this.btn("✕ Fermer", () => this.cancel()); bc.classList.add("btn-danger"); acts.appendChild(bc); box.appendChild(acts);
      return box;
    }
    const moverEntry = scene.rects.find((x) => x.id === this.moverId);
    const what = this.host.posViewKind() === "floor" ? "une salle / un équipement" : "une baie / un équipement";
    const moverLine = document.createElement("div"); moverLine.style.cssText = "font-size:12px;margin:4px 0";
    moverLine.innerHTML = moverEntry ? 'À déplacer : <b style="color:var(--accent)">' + Html.escape(moverEntry.name) + "</b>" : '<span style="color:var(--accent)">Cliquez ' + what + " à déplacer.</span>";
    box.appendChild(moverLine);
    if (moverEntry) {
      const cornerRow = document.createElement("div"); cornerRow.className = "dc-card-acts"; cornerRow.style.marginTop = "2px";
      const labels: Record<CornerId, string> = { TL: "◰ H-G", TR: "◳ H-D", BR: "◲ B-D", BL: "◱ B-G" };
      CORNER_IDS.forEach((cid) => { const b = this.btn(labels[cid], () => this.setCorner(cid)); if (this.corner === cid) b.classList.add("active"); cornerRow.appendChild(b); });
      box.appendChild(cornerRow);
      const ch = document.createElement("div"); ch.className = "form-hint"; ch.textContent = "Coin actif, puis cliquez un mur (cote ⟂) ou le coin d'un autre élément (cote X et Y)."; box.appendChild(ch);
      const cotes = this.cotes(scene);
      (["x", "y"] as Axis[]).forEach((ax) => {
        const ref = ax === "x" ? this.refX : this.refY, co = ax === "x" ? cotes.x : cotes.y;
        if (!ref || !co) return;
        const row = document.createElement("div"); row.style.cssText = "display:flex;align-items:center;gap:6px;margin:5px 0;font-size:12px";
        const lab = document.createElement("span"); lab.style.cssText = "color:var(--fg-dim);min-width:80px"; lab.textContent = (ax === "x" ? "↔ X" : "↕ Y") + " → " + this.refLabel(ref, scene);
        const inp = document.createElement("input"); inp.type = "number"; inp.step = "1"; inp.min = "0"; inp.value = String(Math.round(co.value)); inp.style.cssText = "width:88px";
        const unit = document.createElement("span"); unit.style.color = "var(--fg-dim)"; unit.textContent = "mm";
        const apply = () => { const v = parseFloat(inp.value); if (isFinite(v) && v >= 0) void this.applyAxis(ax, v); };
        inp.onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); apply(); } };
        inp.onchange = apply;
        row.append(lab, inp, unit); box.appendChild(row);
      });
      if (!this.refX && !this.refY) { const hint = document.createElement("div"); hint.className = "form-hint"; hint.textContent = "Aucune référence. Cliquez un mur ou le coin d'un autre élément."; box.appendChild(hint); }
    }
    const dragHint = document.createElement("div"); dragHint.className = "form-hint"; dragHint.textContent = "Astuce : glissez l'élément pour l'aimanter aux murs et aux coins voisins."; box.appendChild(dragHint);
    const acts = document.createElement("div"); acts.className = "dc-card-acts";
    const bClear = this.btn("Effacer réf.", () => { this.refX = null; this.refY = null; this.host.render(); }); (bClear as any).disabled = !this.refX && !this.refY;
    const bClose = this.btn("✕ Fermer", () => this.cancel()); bClose.classList.add("btn-danger");
    acts.append(bClear, bClose); box.appendChild(acts);
    return box;
  }
}
