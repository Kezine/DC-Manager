import type { Store } from "../store";
import { Dom } from "../ui/Dom";
import { ContextMenu } from "../ui/ContextMenu";
import { GraphGeometry } from "../geometry/GraphGeometry";
import { EquipmentTypes } from "../registries/EquipmentTypes";

/* =============================================================================
   GraphView — TRANCHE-PILOTE (Phase 5b).
   Valide le pattern d'une VUE orientée objet : une classe qui prend le `store` +
   un hôte injecté (services app), construit son modèle de rendu depuis le store,
   le dispose (force-directed) et le rend en SVG via les helpers ui/geometry.
   PORTÉE PILOTE : nœuds + arêtes + layout + pan/zoom + glisser de nœud. NON inclus
   (à porter ensuite) : cadres, dispositions nommées, modes A/B/C, sélection/
   marquee, menus contextuels, légende, export, barre d'outils, couleurs réseau/
   groupe de la poignée. Le couplage au global `store`/`setDirty`/modale devient
   une injection (store + GraphHost).
   ============================================================================= */

/** Services applicatifs dont la vue dépend (câblés par le shell en Phase 6). */
export interface GraphHost {
  setDirty?(v: boolean): void;
  openEquipmentDetail?(id: string): void;
  deleteEquipment?(id: string): void;
}

interface GNode { id: string; name: string; type: string; group_id: string | null; x: number; y: number; vx: number; vy: number; _w?: number; _h?: number; }
interface GEdge { id: string; name: string; a: string; b: string; network_id: string | null; status: string; }

export class GraphView {
  private store: Store;
  private host: GraphHost;
  private stage: HTMLElement;

  nodes: GNode[] = [];
  edges: GEdge[] = [];
  selection = new Set<string>();          // ids des nœuds sélectionnés (déplacement groupé)
  private pos: Record<string, { x: number; y: number }> = {};   // positions vivantes
  private _moved = new Set<string>();     // ids déplacés à la main
  private scale = 1; private tx = 0; private ty = 0;
  private svg: SVGSVGElement | null = null;
  private gRoot: SVGGElement | null = null;
  private _nodeById: Record<string, GNode> = {};
  private _gById: Record<string, SVGGElement> = {};
  private _edgeLineById: Record<string, SVGElement> = {};
  private _edgeLabelById: Record<string, SVGElement> = {};
  private _edgePan: { raf: number } | null = null;

  constructor(store: Store, mount: HTMLElement, host: GraphHost = {}) {
    this.store = store;
    this.host = host;
    this.stage = mount;
  }

  /** Reconstruit tout : modèle → layout → rendu → recadrage. */
  rebuild(opts: { recenter?: boolean } = {}): void {
    this.computeVisible();
    this.layout();
    this.render();
    if (opts.recenter) this.recenter();
  }

  /* ---- modèle de rendu (depuis le store) ---- */

  private _resolvableCables(): any[] {
    const s = this.store;
    return s.all("cables").filter((c: any) => {
      const pa = s.get("ports", c.from_port_id), pb = s.get("ports", c.to_port_id);
      return pa && pb && s.get("equipments", pa.equipment_id) && s.get("equipments", pb.equipment_id);
    });
  }

  computeVisible(): void {
    const s = this.store;
    const eqIds = new Set<string>(), cableIds = new Set<string>();
    s.all("equipments").forEach((e: any) => { if (!e.inventory_only) eqIds.add(e.id); });   // « inventaire seul » hors topologie
    this._resolvableCables().forEach((c: any) => cableIds.add(c.id));
    this.nodes = [...eqIds].map((id) => s.get("equipments", id)).filter(Boolean).map((e: any) => ({ id: e.id, name: e.name || "(sans nom)", type: e.type || "", group_id: e.group_id || null, x: 0, y: 0, vx: 0, vy: 0 }));
    this.edges = [...cableIds].map((id) => s.get("cables", id)).filter(Boolean).map((c: any) => {
      const pa = s.get("ports", c.from_port_id), pb = s.get("ports", c.to_port_id);
      return { id: c.id, name: c.name || "", a: pa.equipment_id, b: pb.equipment_id, network_id: c.network_id, status: c.status };
    });
  }

  /* ---- layout force-directed (mode « auto ») ---- */

  layout(): void {
    const N = this.nodes.length;
    if (!N) return;
    const W = this.stage.clientWidth || 900, H = this.stage.clientHeight || 560;
    const byId: Record<string, GNode> = {}; this.nodes.forEach((n) => { byId[n.id] = n; });

    // composants connexes (sur les nœuds visibles)
    const adj: Record<string, string[]> = {}; this.nodes.forEach((n) => { adj[n.id] = []; });
    this.edges.forEach((e) => { if (e.a !== e.b && byId[e.a] && byId[e.b]) { adj[e.a].push(e.b); adj[e.b].push(e.a); } });
    const seen = new Set<string>(); const comps: GNode[][] = [];
    this.nodes.forEach((n) => {
      if (seen.has(n.id)) return;
      const stack = [n.id], comp: GNode[] = []; seen.add(n.id);
      while (stack.length) { const id = stack.pop()!; comp.push(byId[id]); adj[id].forEach((m) => { if (!seen.has(m)) { seen.add(m); stack.push(m); } }); }
      comps.push(comp);
    });
    comps.sort((a, b) => b.length - a.length);

    const k = Math.max(80, Math.sqrt((W * H) / N) * 0.8);
    comps.forEach((comp) => this._simulateComponent(comp, k));

    const bboxOf = (comp: GNode[]) => {
      const b = GraphGeometry.nodesBBox(comp, () => 24);
      return { mnx: b.minX, mny: b.minY, mxx: b.maxX, mxy: b.maxY, w: b.maxX - b.minX, h: b.maxY - b.minY };
    };
    const moveComp = (comp: GNode[], dx: number, dy: number) => comp.forEach((n) => { n.x += dx; n.y += dy; });

    // packing : composant principal en haut, satellites rangés dessous
    const gap = 64;
    const main = comps[0];
    let bb = bboxOf(main);
    moveComp(main, -bb.mnx, -bb.mny);
    const mainW = bb.w;
    let cursorY = bb.h + gap;
    const maxRowW = Math.max(mainW, 700);
    let cx = 0, rowH = 0;
    for (let i = 1; i < comps.length; i++) {
      const c = comps[i];
      const cb = bboxOf(c);
      if (cx > 0 && cx + cb.w > maxRowW) { cx = 0; cursorY += rowH + gap; rowH = 0; }
      moveComp(c, -cb.mnx + cx, -cb.mny + cursorY);
      cx += cb.w + gap;
      rowH = Math.max(rowH, cb.h);
    }
  }

  /* Simulation force-directed d'UN composant, centrée autour de l'origine. */
  private _simulateComponent(comp: GNode[], k: number): void {
    const M = comp.length;
    if (M === 1) { comp[0].x = 0; comp[0].y = 0; comp[0].vx = 0; comp[0].vy = 0; return; }
    const ids = new Set(comp.map((n) => n.id));
    const cedges = this.edges.filter((e) => e.a !== e.b && ids.has(e.a) && ids.has(e.b));
    const idx: Record<string, number> = {}; comp.forEach((n, i) => { idx[n.id] = i; });
    const R = 50 + M * 6;
    comp.forEach((n, i) => { const a = (i / M) * Math.PI * 2; n.x = R * Math.cos(a); n.y = R * Math.sin(a); n.vx = 0; n.vy = 0; });
    let temp = R * 0.9; const iters = 300;
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < M; i++) {
        let fx = 0, fy = 0; const a = comp[i];
        for (let j = 0; j < M; j++) {
          if (i === j) continue; const b = comp[j];
          const dx = a.x - b.x, dy = a.y - b.y; const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const rep = (k * k) / d; fx += (dx / d) * rep; fy += (dy / d) * rep;
        }
        fx += (0 - a.x) * 0.012; fy += (0 - a.y) * 0.012;
        a.vx = fx; a.vy = fy;
      }
      cedges.forEach((e) => {
        const a = comp[idx[e.a]], b = comp[idx[e.b]]; if (!a || !b || a === b) return;
        const dx = a.x - b.x, dy = a.y - b.y; const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const att = (d * d) / k; const ux = dx / d, uy = dy / d;
        a.vx -= ux * att; a.vy -= uy * att; b.vx += ux * att; b.vy += uy * att;
      });
      for (let i = 0; i < M; i++) { const a = comp[i]; const dl = Math.sqrt(a.vx * a.vx + a.vy * a.vy) || 0.01; a.x += (a.vx / dl) * Math.min(dl, temp); a.y += (a.vy / dl) * Math.min(dl, temp); }
      temp *= 0.985;
    }
  }

  /* ---- rendu SVG ---- */

  render(): void {
    if (this.svg) this.svg.remove();
    this._nodeById = {}; this._gById = {}; this._edgeLineById = {}; this._edgeLabelById = {};
    this.nodes.forEach((n) => { this._nodeById[n.id] = n; });
    const W = this.stage.clientWidth || 900, H = this.stage.clientHeight || 560;
    const svg = Dom.svg("svg", { width: W, height: H }) as SVGSVGElement;
    this.svg = svg;
    const gRoot = Dom.svg("g") as SVGGElement; this.gRoot = gRoot; svg.appendChild(gRoot);
    const idx: Record<string, number> = {}; this.nodes.forEach((n, i) => { idx[n.id] = i; });

    // arêtes
    const edgeLayer = Dom.svg("g");
    this.edges.forEach((e) => {
      const a = this.nodes[idx[e.a]], b = this.nodes[idx[e.b]];
      if (!a || !b) return;
      const net = e.network_id ? this.store.get("networks", e.network_id) : null;
      const color = net && net.color ? net.color : "var(--line-2)";
      const line = Dom.svg("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: color });
      line.setAttribute("class", "gedge"); (line as any).dataset.id = e.id;
      if (e.status === "brouillon") line.setAttribute("stroke-dasharray", "1 4");
      else if (e.status === "planifie") line.setAttribute("stroke-dasharray", "6 4");
      else if (e.status === "a-remplacer") line.setAttribute("stroke-dasharray", "2 3");
      edgeLayer.appendChild(line);
      this._edgeLineById[e.id] = line;
      if (e.name) {
        const lbl = Dom.svg("text", { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 3, "text-anchor": "middle" });
        lbl.setAttribute("class", "gedge-label"); (lbl as any).dataset.id = e.id; lbl.textContent = e.name;
        edgeLayer.appendChild(lbl);
        this._edgeLabelById[e.id] = lbl;
      }
    });
    gRoot.appendChild(edgeLayer);

    // nœuds
    const nodeLayer = Dom.svg("g");
    const ICON = 18, ICON_X = 9, TEXT_X = ICON_X + ICON + 7;
    this.nodes.forEach((n) => {
      const typeLabel = EquipmentTypes.label(n.type);
      const { w, h } = GraphGeometry.nodeSize(n);
      n._w = w; n._h = h;
      const g = Dom.svg("g") as SVGGElement; g.setAttribute("class", "gnode" + (this.selection.has(n.id) ? " selected" : "")); (g as any).dataset.id = n.id;
      g.setAttribute("transform", `translate(${n.x - w / 2},${n.y - h / 2})`);
      (g as any).style.cursor = "grab";
      g.appendChild(Dom.svg("rect", { x: 0, y: 0, width: w, height: h, rx: 4 }));
      // poignée colorée par TYPE (mode pilote : type seulement)
      const R = 4, BW = 8;
      const bandD = `M ${BW},0 L ${R},0 Q 0,0 0,${R} L 0,${h - R} Q 0,${h} ${R},${h} L ${BW},${h} Z`;
      const bar = Dom.svg("path", { d: bandD, fill: EquipmentTypes.color(n.type) });
      bar.setAttribute("class", "gnode-group");
      const bt = Dom.svg("title"); bt.textContent = typeLabel; bar.appendChild(bt);
      g.appendChild(bar);
      // icône du type
      const iconG = Dom.svg("g"); iconG.setAttribute("class", "gnode-icon");
      iconG.setAttribute("transform", `translate(${ICON_X},${(h - ICON) / 2}) scale(0.75)`);
      iconG.setAttribute("pointer-events", "none");
      const ic = Dom.parseSvgIcon(EquipmentTypes.icon(n.type)); if (ic) iconG.appendChild(ic);
      g.appendChild(iconG);
      const t1 = Dom.svg("text", { x: TEXT_X, y: 17, "text-anchor": "start", "font-size": 11, "font-weight": 600 }); t1.textContent = n.name;
      const t2 = Dom.svg("text", { x: TEXT_X, y: 31, "text-anchor": "start", "font-size": 9, fill: "var(--fg-dim)" }); t2.textContent = typeLabel;
      g.appendChild(t1); g.appendChild(t2);
      this._gById[n.id] = g;
      g.addEventListener("mousedown", (ev) => this._onNodeMouseDown(ev as MouseEvent, n));
      g.addEventListener("dblclick", () => this.host.openEquipmentDetail?.(n.id));
      g.addEventListener("contextmenu", (ev) => { ev.preventDefault(); ev.stopPropagation(); this._nodeContextMenu(ev as MouseEvent, n); });
      nodeLayer.appendChild(g);
    });
    gRoot.appendChild(nodeLayer);

    svg.addEventListener("mousedown", (ev) => {
      if (ev.target !== svg || ev.button !== 0) return;
      if (ev.shiftKey || ev.ctrlKey || ev.metaKey) this._startMarquee(ev);
      else this._startPan(ev);
    });
    svg.addEventListener("wheel", (ev) => this._onWheel(ev), { passive: false });
    svg.addEventListener("contextmenu", (ev) => { if (ev.target === svg) { ev.preventDefault(); this._bgContextMenu(ev); } });

    this.stage.insertBefore(svg, this.stage.firstChild);
    this._applyTransform();
    this._renderSelection();

    if (!this.nodes.length) {
      const msg = Dom.svg("text", { x: W / 2, y: H / 2, "text-anchor": "middle", fill: "var(--fg-dim)", "font-size": 13 });
      msg.textContent = "Aucun élément à afficher.";
      gRoot.appendChild(msg);
    }
  }

  /* ---- transform (pan / zoom) ---- */

  private _applyTransform(): void {
    if (this.gRoot) this.gRoot.setAttribute("transform", `translate(${this.tx},${this.ty}) scale(${this.scale})`);
  }
  private _clientToWorld(cx: number, cy: number): { x: number; y: number } {
    const r = this.svg!.getBoundingClientRect();
    return { x: (cx - r.left - this.tx) / this.scale, y: (cy - r.top - this.ty) / this.scale };
  }
  /** Zoom centré sur le milieu de la vue. */
  zoomBy(factor: number): void {
    const r = this.svg ? this.svg.getBoundingClientRect() : ({ width: 900, height: 560 } as DOMRect);
    const px = (this.stage.clientWidth || r.width) / 2, py = (this.stage.clientHeight || r.height) / 2;
    const wx = (px - this.tx) / this.scale, wy = (py - this.ty) / this.scale;
    this.scale = Math.max(0.15, Math.min(4, this.scale * factor));
    this.tx = px - wx * this.scale; this.ty = py - wy * this.scale;
    this._applyTransform();
  }
  private _onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    const r = this.svg!.getBoundingClientRect();
    const px = ev.clientX - r.left, py = ev.clientY - r.top;
    const wx = (px - this.tx) / this.scale, wy = (py - this.ty) / this.scale;
    this.scale = Math.max(0.15, Math.min(4, this.scale * factor));
    this.tx = px - wx * this.scale; this.ty = py - wy * this.scale;
    this._applyTransform();
  }
  private _startPan(ev: MouseEvent): void {
    ev.preventDefault();
    this.svg!.classList.add("panning");
    const sx = ev.clientX, sy = ev.clientY, ox = this.tx, oy = this.ty;
    let moved = false;
    const move = (e: MouseEvent) => {
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 3) moved = true;
      this.tx = ox + (e.clientX - sx); this.ty = oy + (e.clientY - sy); this._applyTransform();
    };
    const up = () => {
      this.svg!.classList.remove("panning");
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      if (!moved && this.selection.size) this._clearSelection();   // clic à vide = désélectionner
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }

  /** Recadre l'ensemble des nœuds dans la vue. */
  recenter(): void {
    if (!this.nodes.length || !this.svg) { this.scale = 1; this.tx = 0; this.ty = 0; this._applyTransform(); return; }
    const { minX, minY, maxX, maxY } = GraphGeometry.nodesBBox(this.nodes, (n) => (n._h || 40) / 2);
    const W = this.stage.clientWidth || 900, H = this.stage.clientHeight || 560;
    const pad = 50;
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    const s = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh, 1.6);
    this.scale = Math.max(0.15, s);
    this.tx = (W - bw * this.scale) / 2 - minX * this.scale;
    this.ty = (H - bh * this.scale) / 2 - minY * this.scale;
    this._applyTransform();
  }

  /* ---- sélection multiple ---- */

  private _renderSelection(): void {
    if (!this.gRoot) return;
    [...this.selection].forEach((id) => { if (!this._nodeById[id]) this.selection.delete(id); });
    this.gRoot.querySelectorAll("g.gnode").forEach((g) => (g as SVGGElement).classList.toggle("selected", this.selection.has((g as any).dataset.id)));
  }
  private _clearSelection(): void { this.selection.clear(); this._renderSelection(); }
  selectAll(): void { this.selection = new Set(this.nodes.map((n) => n.id)); this._renderSelection(); }
  private _nodesInRect(x0: number, y0: number, x1: number, y1: number): string[] {
    const a = Math.min(x0, x1), b = Math.max(x0, x1), c = Math.min(y0, y1), d = Math.max(y0, y1);
    return this.nodes.filter((n) => n.x >= a && n.x <= b && n.y >= c && n.y <= d).map((n) => n.id);
  }

  /* ---- déplacement (sélection-aware) ---- */

  private _onNodeMouseDown(ev: MouseEvent, n: GNode): void {
    if (ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const additive = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    if (additive) {
      if (this.selection.has(n.id)) this.selection.delete(n.id); else this.selection.add(n.id);
      this._renderSelection();
      return;
    }
    if (!this.selection.has(n.id)) { this.selection.clear(); this.selection.add(n.id); this._renderSelection(); }
    this._startNodesDrag(ev);
  }

  private _dragSession(onMove: (e: MouseEvent) => void, onUp?: (e: MouseEvent) => void): void {
    const move = (e: MouseEvent) => onMove(e);
    const up = (e: MouseEvent) => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      if (onUp) onUp(e);
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }

  /** Déplace tous les nœuds sélectionnés du même delta, avec auto-pan au bord. */
  private _startNodesDrag(ev: MouseEvent): void {
    const ids = [...this.selection].filter((id) => this._nodeById[id]);
    if (!ids.length) return;
    const idSet = new Set(ids);
    ids.forEach((id) => { const g = this._gById[id]; if (g) (g as any).style.cursor = "grabbing"; });
    const startW = this._clientToWorld(ev.clientX, ev.clientY);
    const orig: Record<string, { x: number; y: number }> = {}; ids.forEach((id) => { const nd = this._nodeById[id]; orig[id] = { x: nd.x, y: nd.y }; });
    let last = { x: ev.clientX, y: ev.clientY };
    const sync = () => {
      const p = this._clientToWorld(last.x, last.y);
      const dx = p.x - startW.x, dy = p.y - startW.y;
      ids.forEach((id) => { const nd = this._nodeById[id]; nd.x = orig[id].x + dx; nd.y = orig[id].y + dy; this._placeNodeOnly(nd); });
      this._updateEdgesForSet(idSet);
    };
    this._dragSession(
      (e) => { last = { x: e.clientX, y: e.clientY }; sync(); },
      () => {
        ids.forEach((id) => { const g = this._gById[id]; if (g) (g as any).style.cursor = "grab"; });
        ids.forEach((id) => { const nd = this._nodeById[id]; if (nd) { this.pos[id] = { x: Math.round(nd.x), y: Math.round(nd.y) }; this._moved.add(id); } });
        this.host.setDirty?.(true);
        this._stopEdgePan();
      },
    );
    this._startEdgePan(() => last, sync);
  }

  private _placeNodeOnly(n: GNode): void {
    const g = this._gById[n.id]; if (!g) return;
    const w = n._w || GraphGeometry.nodeSize(n).w, h = n._h || 40;
    g.setAttribute("transform", `translate(${n.x - w / 2},${n.y - h / 2})`);
  }

  /** Sélection rectangle (marquee) : ajoute les nœuds couverts à la sélection. */
  private _startMarquee(ev: MouseEvent): void {
    ev.preventDefault();
    const start = this._clientToWorld(ev.clientX, ev.clientY);
    const base = new Set(this.selection);
    const rect = Dom.svg("rect", { class: "gmarquee", fill: "var(--accent)", "fill-opacity": 0.08, stroke: "var(--accent)", "stroke-width": 1, "stroke-dasharray": "4 3" });
    rect.setAttribute("pointer-events", "none");
    this.gRoot!.appendChild(rect);
    let cur = start;
    const draw = () => {
      const x0 = Math.min(start.x, cur.x), y0 = Math.min(start.y, cur.y), x1 = Math.max(start.x, cur.x), y1 = Math.max(start.y, cur.y);
      rect.setAttribute("x", String(x0)); rect.setAttribute("y", String(y0)); rect.setAttribute("width", String(x1 - x0)); rect.setAttribute("height", String(y1 - y0));
      const sel = new Set(base);
      this._nodesInRect(x0, y0, x1, y1).forEach((id) => sel.add(id));
      this.selection = sel; this._renderSelection();
    };
    const move = (e: MouseEvent) => { cur = this._clientToWorld(e.clientX, e.clientY); draw(); };
    const up = () => { rect.remove(); document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }

  /** Auto-pan quand le pointeur approche un bord pendant un déplacement. */
  private _startEdgePan(getClient: () => { x: number; y: number }, onPan: () => void): void {
    this._stopEdgePan();
    const MARGIN = 60, MAX_SPEED = 16;
    const state = { raf: 0 };
    const tick = () => {
      if (!this.svg) return;
      const r = this.svg.getBoundingClientRect();
      const c = getClient();
      let dx = 0, dy = 0;
      if (c.x < r.left + MARGIN) dx = (r.left + MARGIN - c.x);
      else if (c.x > r.right - MARGIN) dx = -(c.x - (r.right - MARGIN));
      if (c.y < r.top + MARGIN) dy = (r.top + MARGIN - c.y);
      else if (c.y > r.bottom - MARGIN) dy = -(c.y - (r.bottom - MARGIN));
      const ease = (v: number) => { const t = Math.max(-1, Math.min(1, v / MARGIN)); return Math.sign(t) * t * t * MAX_SPEED; };
      const vx = ease(dx), vy = ease(dy);
      if (vx || vy) { this.tx += vx; this.ty += vy; this._applyTransform(); if (onPan) onPan(); }
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
    this._edgePan = state;
  }
  private _stopEdgePan(): void {
    if (this._edgePan && this._edgePan.raf) cancelAnimationFrame(this._edgePan.raf);
    this._edgePan = null;
  }

  private _updateEdgesForSet(idSet: Set<string>): void {
    if (!this.gRoot) return;
    this.edges.forEach((e) => {
      if (!idSet.has(e.a) && !idSet.has(e.b)) return;
      const a = this._nodeById[e.a], b = this._nodeById[e.b]; if (!a || !b) return;
      const line = this._edgeLineById[e.id];
      if (line) { line.setAttribute("x1", String(a.x)); line.setAttribute("y1", String(a.y)); line.setAttribute("x2", String(b.x)); line.setAttribute("y2", String(b.y)); }
      const lbl = this._edgeLabelById[e.id];
      if (lbl) { lbl.setAttribute("x", String((a.x + b.x) / 2)); lbl.setAttribute("y", String((a.y + b.y) / 2 - 3)); }
    });
  }

  /* ---- menus contextuels ---- */

  private _nodeContextMenu(ev: MouseEvent, n: GNode): void {
    ContextMenu.show(ev.clientX, ev.clientY, [{
      head: n.name,
      items: [
        { label: "Détails", action: () => this.host.openEquipmentDetail?.(n.id) },
        { label: "Supprimer", danger: true, action: () => this.host.deleteEquipment?.(n.id) },
      ],
    }]);
  }
  private _bgContextMenu(ev: MouseEvent): void {
    const items = [{ label: "Tout sélectionner", action: () => this.selectAll() }];
    if (this.selection.size) items.push({ label: "Tout désélectionner", action: () => this._clearSelection() });
    ContextMenu.show(ev.clientX, ev.clientY, [
      { items: [{ label: "Recentrer la vue", action: () => this.recenter() }] },
      { head: "Sélection", items },
    ]);
  }
}
