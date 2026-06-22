import type { Store } from "../store";
import { Dom } from "../ui/Dom";
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
}

interface GNode { id: string; name: string; type: string; group_id: string | null; x: number; y: number; vx: number; vy: number; _w?: number; _h?: number; }
interface GEdge { id: string; name: string; a: string; b: string; network_id: string | null; status: string; }

export class GraphView {
  private store: Store;
  private host: GraphHost;
  private stage: HTMLElement;

  nodes: GNode[] = [];
  edges: GEdge[] = [];
  private scale = 1; private tx = 0; private ty = 0;
  private svg: SVGSVGElement | null = null;
  private gRoot: SVGGElement | null = null;
  private _gById: Record<string, SVGGElement> = {};
  private _edgeLineById: Record<string, SVGElement> = {};
  private _edgeLabelById: Record<string, SVGElement> = {};

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
    this._gById = {}; this._edgeLineById = {}; this._edgeLabelById = {};
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
      const g = Dom.svg("g") as SVGGElement; g.setAttribute("class", "gnode"); (g as any).dataset.id = n.id;
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
      nodeLayer.appendChild(g);
    });
    gRoot.appendChild(nodeLayer);

    svg.addEventListener("mousedown", (ev) => { if (ev.target === svg && ev.button === 0) this._startPan(ev); });
    svg.addEventListener("wheel", (ev) => this._onWheel(ev), { passive: false });

    this.stage.insertBefore(svg, this.stage.firstChild);
    this._applyTransform();

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
  private _zoomBy(factor: number): void {
    this.scale = Math.max(0.1, Math.min(4, this.scale * factor));
    this._applyTransform();
  }
  private _onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    this._zoomBy(ev.deltaY < 0 ? 1.1 : 1 / 1.1);
  }
  private _startPan(ev: MouseEvent): void {
    const sx = ev.clientX, sy = ev.clientY, tx0 = this.tx, ty0 = this.ty;
    const move = (e: MouseEvent) => { this.tx = tx0 + (e.clientX - sx); this.ty = ty0 + (e.clientY - sy); this._applyTransform(); };
    const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }

  /** Recadre l'ensemble des nœuds dans la vue. */
  recenter(): void {
    if (!this.nodes.length || !this.svg) return;
    const b = GraphGeometry.nodesBBox(this.nodes, (n) => (n._h || 40) / 2);
    const W = this.stage.clientWidth || 900, H = this.stage.clientHeight || 560;
    const gw = (b.maxX - b.minX) || 1, gh = (b.maxY - b.minY) || 1;
    this.scale = Math.max(0.1, Math.min(2, 0.9 * Math.min(W / gw, H / gh)));
    this.tx = W / 2 - this.scale * (b.minX + gw / 2);
    this.ty = H / 2 - this.scale * (b.minY + gh / 2);
    this._applyTransform();
  }

  /* ---- glisser de nœud (version pilote : déplacement + maj des arêtes) ---- */

  private _onNodeMouseDown(ev: MouseEvent, n: GNode): void {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    const start = this._clientToWorld(ev.clientX, ev.clientY);
    const x0 = n.x, y0 = n.y;
    const move = (e: MouseEvent) => {
      const p = this._clientToWorld(e.clientX, e.clientY);
      n.x = x0 + (p.x - start.x); n.y = y0 + (p.y - start.y);
      const g = this._gById[n.id];
      if (g) g.setAttribute("transform", `translate(${n.x - (n._w || 0) / 2},${n.y - (n._h || 0) / 2})`);
      this._updateEdgesFor(n.id);
    };
    const up = () => {
      document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
      this.host.setDirty?.(true);
    };
    document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
  }

  private _updateEdgesFor(nodeId: string): void {
    const byId: Record<string, GNode> = {}; this.nodes.forEach((n) => { byId[n.id] = n; });
    this.edges.forEach((e) => {
      if (e.a !== nodeId && e.b !== nodeId) return;
      const a = byId[e.a], b = byId[e.b]; if (!a || !b) return;
      const line = this._edgeLineById[e.id];
      if (line) { line.setAttribute("x1", String(a.x)); line.setAttribute("y1", String(a.y)); line.setAttribute("x2", String(b.x)); line.setAttribute("y2", String(b.y)); }
      const lbl = this._edgeLabelById[e.id];
      if (lbl) { lbl.setAttribute("x", String((a.x + b.x) / 2)); lbl.setAttribute("y", String((a.y + b.y) / 2 - 3)); }
    });
  }
}
