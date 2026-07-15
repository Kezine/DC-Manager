import type { Store } from "../store";
import type { RouteAnalysis } from "../store/CableRouteAnalyzer";
import { Dom } from "../ui/Dom";
import { Waypoint } from "../models/Waypoint";
import { RouteGraphLayout, RouteGraphNode, ROUTE_GRAPH } from "../geometry/RouteGraphLayout";

/* =============================================================================
   MINI-GRAPHE de TRACÉ — rendu SVG de la route d'un câble/faisceau dans les
   fiches détail (remplace le résumé texte `cableRouteSummary`). Source de
   données : `store.cableRoute(...).steps` (ordonnés A→B) + les extrémités
   fournies par l'appelant. Calculs de positions dans `geometry/RouteGraphLayout`
   (pur, testé) ; ici uniquement le DOM/SVG (mêmes idiomes que GraphView :
   `Dom.svg`, classes `.gnode`/`.gedge`, tirets par statut, atténuation au survol).

   Deux lectures basculables quand la route a des waypoints :
   - CHAÎNE  : topologie salle → salle (bandes de fond par salle) ;
   - PROFIL  : hauteur `dc_z` en ordonnée (dalle, faux-plancher, chemins hauts).
   ============================================================================= */

/** Extrémité affichée (résolue par l'appelant : équipement de patch OU équipement:port). */
export interface RouteEndpointSpec { label: string; sub: string; dcId: string | null }

export interface RouteMiniGraphOptions {
  endpointA?: RouteEndpointSpec | null;
  endpointB?: RouteEndpointSpec | null;
  /** Couleur d'arête (réseau principal du câble) — défaut : neutre `var(--line-2)` (convention GraphView). */
  edgeColor?: string | null;
  /** Statut du câble → motif de tirets (conventions GraphView ; cassé = rouge, parité vue 2D). */
  status?: string | null;
  /** Faisceau : trait plus épais (le trunk est LA ligne visible, parité rendu 3D). */
  thick?: boolean;
}

/** Nœud interne : layout (position) + habillage (glyphe, libellés, tooltip). */
interface RmNode extends RouteGraphNode {
  glyph: string;
  label: string;
  sub: string;
}

export class RouteMiniGraph {
  /** Construit la section tracé : bascule chaîne/profil (si waypoints), graphe défilable,
      erreurs de route en dessous. Autonome — l'appelant n'a qu'à insérer l'élément. */
  static render(store: Store, route: RouteAnalysis, opts: RouteMiniGraphOptions = {}): HTMLElement {
    const wrap = document.createElement("div");
    const nodes = this.buildNodes(store, route, opts);

    if (nodes.length < 2) {
      const hint = document.createElement("div"); hint.className = "form-hint";
      hint.textContent = "Aucun tracé à afficher (extrémités non posées).";
      wrap.appendChild(hint);
      return wrap;
    }

    const scroll = document.createElement("div"); scroll.className = "route-mini";
    const hasSteps = route.steps.length > 0;
    let mode: "chain" | "profile" = "chain";
    const draw = () => {
      scroll.textContent = "";
      scroll.appendChild(mode === "profile" ? this.drawProfile(nodes, opts) : this.drawChain(nodes, opts));
    };

    // bascule chaîne ⇄ profil — seulement si la route a des waypoints (sinon le profil n'apporte rien)
    if (hasSteps) {
      const head = document.createElement("div"); head.className = "route-mini-head";
      const mkBtn = (m: "chain" | "profile", label: string) => {
        const b = document.createElement("button"); b.type = "button"; b.textContent = label;
        b.className = m === mode ? "on" : "";
        b.onclick = () => { if (mode === m) return; mode = m; head.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); draw(); };
        return b;
      };
      const toggle = document.createElement("div"); toggle.className = "rm-toggle";
      toggle.appendChild(mkBtn("chain", "Chaîne")); toggle.appendChild(mkBtn("profile", "Profil"));
      head.appendChild(toggle);
      const count = document.createElement("span"); count.className = "form-hint";
      const rooms = new Set(nodes.map((n) => n.roomId).filter(Boolean)).size;
      count.textContent = route.steps.length + " étape(s) · " + rooms + " salle(s)";
      head.appendChild(count);
      wrap.appendChild(head);
    }

    wrap.appendChild(scroll);
    draw();

    // erreurs de route (messages de l'analyseur) — le graphe reste affiché, les messages contextualisent
    if (route.errors.length) {
      const errBox = document.createElement("div"); errBox.className = "form-hint err route-mini-errors";
      route.errors.forEach((e) => { const line = document.createElement("div"); line.textContent = "⚠ " + e.message; errBox.appendChild(line); });
      wrap.appendChild(errBox);
    }
    return wrap;
  }

  /* ---- construction des nœuds (résolution des libellés — le layout reste pur) ---- */

  private static buildNodes(store: Store, route: RouteAnalysis, opts: RouteMiniGraphOptions): RmNode[] {
    const nodes: RmNode[] = [];
    // étage d'une salle (dc.floor, convention floorLabel : vide/libre → 0 ; salle inconnue → null)
    const levelOfDc = (dcId: string | null): number | null => {
      const d: any = dcId ? store.get("datacenters", dcId) : null;
      if (!d) return null;
      const n = parseFloat(d.floor); return isFinite(n) ? n : 0;
    };
    const pushEndpoint = (spec: RouteEndpointSpec | null | undefined) => {
      if (!spec) return;
      nodes.push({
        endpoint: true, roomId: spec.dcId, roomLabel: spec.dcId ? store.dcName(spec.dcId) : "",
        z: null, level: levelOfDc(spec.dcId), glyph: "", label: spec.label, sub: spec.sub,
      });
    };
    pushEndpoint(opts.endpointA);
    route.steps.forEach((s: any) => {
      const wp = s.wp, floor = s.type === "floor";
      const placed = floor || !!wp.datacenter_id;
      const pinLevel = parseFloat(wp.floor);   // pin d'étage : son étage propre (même convention)
      nodes.push({
        roomId: floor ? null : (wp.datacenter_id || null),
        roomLabel: (!floor && wp.datacenter_id) ? store.dcName(wp.datacenter_id) : "",
        z: (wp.dc_z != null && isFinite(wp.dc_z)) ? wp.dc_z : null,
        level: floor ? (isFinite(pinLevel) ? pinLevel : 0) : levelOfDc(wp.datacenter_id || null),
        glyph: Waypoint.glyph(wp),
        label: wp.name || (floor ? Waypoint.floorLabel(wp) : "(waypoint)"),
        sub: this.stepSub(wp, s.type) + (placed ? "" : " (non posé)"),
      });
    });
    pushEndpoint(opts.endpointB);
    return nodes;
  }

  /** Libellé de type d'une étape (tooltip + lisibilité du glyphe). */
  private static stepSub(wp: any, stepType: string): string {
    if (stepType === "floor") return "pin d'étage · " + Waypoint.floorLabel(wp);
    if (Waypoint.typeOf(wp) === "exit") return "sortie de salle";
    if (wp.kind === "brush") return "brosse de brassage";
    if (wp.kind === "segment") return "chemin de câbles";
    return "point de passage";
  }

  /* ---- habillage d'arête : couleur + tirets par statut (conventions GraphView ; cassé rouge, parité 2D) ---- */

  private static edgeStyle(opts: RouteMiniGraphOptions): { color: string; dash: string | null; width: number } {
    const s = opts.status || null;
    let dash: string | null = null, color = opts.edgeColor || "var(--line-2)";
    if (s === "brouillon") dash = "1 4";
    else if (s === "planifie") dash = "6 4";
    else if (s === "a-remplacer") dash = "2 3";
    else if (s === "casse") { dash = "5 4"; color = "var(--err)"; }
    return { color, dash, width: opts.thick ? 3 : 2 };
  }

  /** Tronque un libellé pour tenir dans une boîte/sous une pastille. */
  private static trunc(s: string, max: number): string { return s.length > max ? s.slice(0, max - 1) + "…" : s; }

  /** Atténue tout le graphe SAUF le nœud survolé et ses arêtes adjacentes (même effet que GraphView). */
  private static hookHover(svgRoot: SVGElement, g: SVGElement, adjacent: SVGElement[]): void {
    const keep = new Set<Element>([g, ...adjacent]);
    g.addEventListener("mouseenter", () => {
      svgRoot.querySelectorAll(".gnode, .gedge").forEach((el) => { if (!keep.has(el)) el.classList.add("dim"); });
    });
    g.addEventListener("mouseleave", () => {
      svgRoot.querySelectorAll(".dim").forEach((el) => el.classList.remove("dim"));
    });
  }

  /** Tooltip natif (<title>) : nom, type, hauteur, salle. */
  private static tip(g: SVGElement, n: RmNode): void {
    const t = Dom.svg("title");
    t.textContent = n.label + " — " + n.sub
      + (n.z != null ? " · z " + n.z + " mm" : "")
      + (n.roomLabel ? " · " + n.roomLabel : "");
    g.appendChild(t);
  }

  /* ---- mode CHAÎNE : ligne de base + bandes de salles ---- */

  private static drawChain(nodes: RmNode[], opts: RouteMiniGraphOptions): SVGElement {
    const L = RouteGraphLayout.chain(nodes);
    const svg = Dom.svg("svg", { width: L.width, height: L.height, viewBox: "0 0 " + L.width + " " + L.height });

    // bandes de salles (calque du fond)
    L.bands.forEach((b) => {
      svg.appendChild(Dom.svg("rect", { class: "rm-band", x: b.x0, y: ROUTE_GRAPH.BAND_TOP, width: b.x1 - b.x0, height: ROUTE_GRAPH.BAND_H, rx: 6 }));
      const lb = Dom.svg("text", { class: "rm-band-label", x: b.x0 + 12, y: ROUTE_GRAPH.BAND_TOP + 15 });
      lb.textContent = b.label; svg.appendChild(lb);
    });

    // arêtes (sous les nœuds — les corps opaques masquent la traversée)
    const st = this.edgeStyle(opts);
    const edges: SVGElement[] = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      const ln = Dom.svg("line", { class: "gedge", x1: L.xs[i], y1: L.cy, x2: L.xs[i + 1], y2: L.cy, stroke: st.color, "stroke-width": st.width });
      if (st.dash) ln.setAttribute("stroke-dasharray", st.dash);
      svg.appendChild(ln); edges.push(ln);
    }

    // nœuds
    nodes.forEach((n, i) => {
      const g = n.endpoint
        ? this.endpointBox(n, L.xs[i], L.cy)
        : this.waypointDot(n, L.xs[i], L.cy, true);
      this.tip(g, n);
      this.hookHover(svg, g, [edges[i - 1], edges[i]].filter(Boolean) as SVGElement[]);
      svg.appendChild(g);
    });
    return svg;
  }

  /** Boîte d'extrémité (style nœud GraphView : corps arrondi + poignée accent + nom/sous-titre). */
  private static endpointBox(n: RmNode, cx: number, cy: number): SVGElement {
    const W = ROUTE_GRAPH.EP_W, H = ROUTE_GRAPH.EP_H;
    const g = Dom.svg("g", { class: "gnode", transform: "translate(" + (cx - W / 2) + "," + (cy - H / 2) + ")" });
    g.appendChild(Dom.svg("rect", { x: 0, y: 0, width: W, height: H, rx: 4 }));
    const R = 4, BW = 6;   // poignée gauche arrondie (même tracé que GraphView)
    g.appendChild(Dom.svg("path", { d: `M ${BW},0 L ${R},0 Q 0,0 0,${R} L 0,${H - R} Q 0,${H} ${R},${H} L ${BW},${H} Z`, fill: "var(--accent)" }));
    const t1 = Dom.svg("text", { x: 13, y: 17, "font-size": 10.5, "font-weight": 600 });
    t1.textContent = this.trunc(n.label, 15); g.appendChild(t1);
    const t2 = Dom.svg("text", { x: 13, y: 30, "font-size": 8.5, fill: "var(--fg-dim)" });
    t2.textContent = this.trunc(n.sub, 19); g.appendChild(t2);
    return g;
  }

  /** Pastille de waypoint : cercle + glyphe (◆ ⏏ ◎ ▬ ▦) + nom en dessous (chaîne). */
  private static waypointDot(n: RmNode, cx: number, cy: number, withName: boolean): SVGElement {
    const g = Dom.svg("g", { class: "gnode" });
    g.appendChild(Dom.svg("circle", { cx, cy, r: ROUTE_GRAPH.WP_R }));
    const gl = Dom.svg("text", { class: "rm-glyph", x: cx, y: cy + 4 });
    gl.textContent = n.glyph; g.appendChild(gl);
    if (withName) {
      const nm = Dom.svg("text", { class: "rm-name", x: cx, y: cy + ROUTE_GRAPH.WP_R + 15 });
      nm.textContent = this.trunc(n.label, 14); g.appendChild(nm);
    }
    return g;
  }

  /* ---- mode PROFIL : hauteur en ordonnée, un référentiel (dalle + faux-plancher) PAR ÉTAGE ---- */

  private static drawProfile(nodes: RmNode[], opts: RouteMiniGraphOptions): SVGElement {
    const L = RouteGraphLayout.profile(nodes);
    const svg = Dom.svg("svg", { width: L.width, height: L.height, viewBox: "0 0 " + L.width + " " + L.height });

    // une dalle par étage traversé (z = 0 LOCAL), zone faux-plancher sous chacune, sur l'emprise
    // horizontale des nœuds de l'étage — `dc_z` est relatif à la dalle de SA salle/étage
    L.floors.forEach((f) => {
      if (f.yBottom - f.y > 2) svg.appendChild(Dom.svg("rect", { x: f.x0, y: f.y, width: f.x1 - f.x0, height: f.yBottom - f.y, fill: "var(--fg-dim)", opacity: 0.07 }));
      svg.appendChild(Dom.svg("line", { class: "rm-zline", x1: f.x0, y1: f.y, x2: f.x1, y2: f.y }));
      const zl = Dom.svg("text", { class: "rm-zlabel", x: f.x0 + 8, y: f.y - 5 });
      zl.textContent = L.multiFloor ? "dalle ét. " + f.level : "dalle · 0 mm";
      svg.appendChild(zl);
      if (f.hasUnderfloor) { const fl = Dom.svg("text", { class: "rm-zlabel", x: f.x0 + 8, y: f.y + 13 }); fl.textContent = "faux-plancher"; svg.appendChild(fl); }
    });

    // salles : libellés en tête + séparateurs verticaux aux transitions
    L.bands.forEach((b) => {
      const lb = Dom.svg("text", { class: "rm-band-label", x: (L.xs[b.from] + L.xs[b.to]) / 2, y: 16, "text-anchor": "middle" });
      lb.textContent = b.label; svg.appendChild(lb);
    });
    L.separators.forEach((sx) => svg.appendChild(Dom.svg("line", { class: "rm-zline", x1: sx, y1: 22, x2: sx, y2: L.height - 8, opacity: 0.5 })));

    // arêtes suivant le relief ; une AMORCE (z d'extrémité inconnue, ordonnée héritée) est pointillée discrète
    const st = this.edgeStyle(opts);
    const edges: SVGElement[] = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      const amorce = L.snapped[i] || L.snapped[i + 1];
      const ln = Dom.svg("line", { class: "gedge", x1: L.xs[i], y1: L.ys[i], x2: L.xs[i + 1], y2: L.ys[i + 1], stroke: st.color, "stroke-width": st.width });
      if (amorce) { ln.setAttribute("stroke-dasharray", "2 3"); ln.setAttribute("opacity", "0.6"); }
      else if (st.dash) ln.setAttribute("stroke-dasharray", st.dash);
      svg.appendChild(ln); edges.push(ln);
    }

    // nœuds compacts : extrémités = petit carré nommé, waypoints = pastille à glyphe (nom au survol)
    nodes.forEach((n, i) => {
      let g: SVGElement;
      if (n.endpoint) {
        g = Dom.svg("g", { class: "gnode" });
        g.appendChild(Dom.svg("rect", { x: L.xs[i] - 9, y: L.ys[i] - 9, width: 18, height: 18, rx: 3 }));
        const nm = Dom.svg("text", { class: "rm-name", x: L.xs[i], y: L.ys[i] - 17 });
        nm.textContent = this.trunc(n.label, 15); g.appendChild(nm);
      } else {
        g = this.waypointDot(n, L.xs[i], L.ys[i], false);
      }
      this.tip(g, n);
      this.hookHover(svg, g, [edges[i - 1], edges[i]].filter(Boolean) as SVGElement[]);
      svg.appendChild(g);
    });
    return svg;
  }
}
