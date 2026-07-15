import { EquipmentTypes } from "../registries/EquipmentTypes";

// icône (x=9, ⌀18) + 7 px de marge avant le texte.
const GNODE_TEXT_X = 9 + 18 + 7;

/** Taille de boîte d'un nœud GraphView. */
export interface NodeSize { w: number; h: number; }
/** Bounding-box d'un ensemble de nœuds. */
export interface BBox { minX: number; minY: number; maxX: number; maxY: number; }

/** Géométrie des nœuds du GraphView — SOURCE UNIQUE (rendu + bbox + recentrage). PUR. */
export class GraphGeometry {
  /** Taille (w,h) de la boîte d'un nœud : largeur = de quoi loger l'icône/badge + le texte le plus long (nom OU
      SOUS-LIGNE), bornée à 120 px ; hauteur fixe 40. La sous-ligne dépend du `kind` : libellé de type pour un
      équipement, « VM »/« VM · orpheline » pour une VM, rien pour un réseau (nom centré seul). Un nœud SANS
      `kind` (objet géométrie nu) suit la voie équipement — compat des appels/tests existants. */
  static nodeSize(n: any): NodeSize {
    const kind = n.kind || "equip";
    const sub = kind === "vm" ? (n.orphan ? "VM · orpheline" : "VM")
      : kind === "net" ? ""
      : EquipmentTypes.label(n.type);
    const chars = Math.max((n.name || "").length, sub.length);
    return { w: Math.max(120, Math.round(chars * 7) + GNODE_TEXT_X + 14), h: 40 };
  }

  /** Bounding-box {minX,minY,maxX,maxY} de nœuds (centre ± demi-taille).
      Largeur via le cache `n._w` sinon `nodeSize` ; demi-hauteur fournie par `halfHOf(n)`. */
  static nodesBBox(nodes: any[], halfHOf: (n: any) => number): BBox {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach((n) => {
      const w = n._w || GraphGeometry.nodeSize(n).w, hh = halfHOf(n);
      minX = Math.min(minX, n.x - w / 2); maxX = Math.max(maxX, n.x + w / 2);
      minY = Math.min(minY, n.y - hh); maxY = Math.max(maxY, n.y + hh);
    });
    return { minX, minY, maxX, maxY };
  }

  /* ---- disposition FORCE-DIRECTED (extraite de GraphView — géométrie pure, DÉTERMINISTE : positions
     initiales sur un cercle, aucune source aléatoire → même entrée = même disposition, testable). ---- */

  /** Dispose `nodes` (mutés en place : x/y, vitesses remises à zéro) : simulation par COMPOSANT connexe,
      puis PACKING — composant principal en haut-gauche (bbox ancrée à l'origine), satellites rangés dessous. */
  static forceLayout(nodes: ForceNode[], edges: ForceEdge[], viewW: number, viewH: number): void {
    const N = nodes.length;
    if (!N) return;
    const byId: Record<string, ForceNode> = {}; nodes.forEach((n) => { byId[n.id] = n; });

    // composants connexes (sur les nœuds visibles)
    const adj: Record<string, string[]> = {}; nodes.forEach((n) => { adj[n.id] = []; });
    edges.forEach((e) => { if (e.a !== e.b && byId[e.a] && byId[e.b]) { adj[e.a].push(e.b); adj[e.b].push(e.a); } });
    const seen = new Set<string>(); const comps: ForceNode[][] = [];
    nodes.forEach((n) => {
      if (seen.has(n.id)) return;
      const stack = [n.id], comp: ForceNode[] = []; seen.add(n.id);
      while (stack.length) { const id = stack.pop()!; comp.push(byId[id]); adj[id].forEach((m) => { if (!seen.has(m)) { seen.add(m); stack.push(m); } }); }
      comps.push(comp);
    });
    comps.sort((a, b) => b.length - a.length);

    const k = Math.max(80, Math.sqrt((viewW * viewH) / N) * 0.8);
    comps.forEach((comp) => GraphGeometry.simulateComponent(comp, edges, k));

    const bboxOf = (comp: ForceNode[]) => {
      const b = GraphGeometry.nodesBBox(comp, () => 24);
      return { mnx: b.minX, mny: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
    };
    const moveComp = (comp: ForceNode[], dx: number, dy: number) => comp.forEach((n) => { n.x += dx; n.y += dy; });

    // packing : composant principal en haut, satellites rangés dessous
    const gap = 64;
    const main = comps[0];
    const bb = bboxOf(main);
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

  /** Simulation force-directed (Fruchterman-Reingold refroidi) d'UN composant, centrée autour de l'origine :
      répulsion k²/d entre tous les nœuds + attraction d²/k le long des arêtes + rappel doux vers le centre. */
  static simulateComponent(comp: ForceNode[], edges: ForceEdge[], k: number): void {
    const M = comp.length;
    if (M === 1) { comp[0].x = 0; comp[0].y = 0; comp[0].vx = 0; comp[0].vy = 0; return; }
    const ids = new Set(comp.map((n) => n.id));
    const cedges = edges.filter((e) => e.a !== e.b && ids.has(e.a) && ids.has(e.b));
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

  /** Place les nœuds SANS position mémorisée en grille sous le CENTROÏDE des nœuds placés (sinon sous
      (cx0, cy0), typiquement le centre de la vue). Mutation en place, vitesses remises à zéro. */
  static placeMissingNearCentroid(missing: ForceNode[], placed: ForceNode[], cx0: number, cy0: number): void {
    if (!missing.length) return;
    let cx = cx0, cy = cy0;
    if (placed.length) { cx = placed.reduce((s, n) => s + n.x, 0) / placed.length; cy = placed.reduce((s, n) => s + n.y, 0) / placed.length; }
    const colW = 180, rowH = 64, cols = Math.max(1, Math.ceil(Math.sqrt(missing.length)));
    missing.forEach((n, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      n.x = cx + (c - (cols - 1) / 2) * colW; n.y = cy + 120 + r * rowH; n.vx = 0; n.vy = 0;
    });
  }
}

/** Nœud minimal de la disposition force-directed (muté en place). Le GNode de GraphView le satisfait. */
export interface ForceNode { id: string; x: number; y: number; vx: number; vy: number; _w?: number; name?: string; type?: string }
/** Arête minimale (extrémités par id de nœud). */
export interface ForceEdge { a: string; b: string }
