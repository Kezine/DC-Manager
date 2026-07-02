/* =============================================================================
   OUTIL DE ROUTAGE interactif — contrôleur extrait du monolithe DcInteract.

   Trace une route de câble au CLIC : port de départ → waypoints/brosses (éventuellement
   dans d'autres salles/étages) → port terminal, qui ouvre le formulaire de câblage prérempli.
   Machine d'état minimale (`routeBuild`) partagée par les interactions SVG (2D) ET le moteur
   3D-WebGL (raycast → onWebglPick/onWebglHover). Exclusif de la mesure / du positionnement.

   Découplé de la chaîne de vues : services de vue via `RouteHost` ; `store` + `resolver`
   (résolution 3D des ports/waypoints) INJECTÉS au constructeur (dépendances stables, comme
   FloorLayout/CableRouting). La cohérence de salle d'un ajout est déléguée à
   `store.routeHasRoomBreak` (codes stables — cf. Store.cableRoute).
   ============================================================================= */
import { Notify } from "../../ui/Notify";
import { Html } from "../../core/Html";
import { Waypoint } from "../../models/Waypoint";
import type { Store } from "../../store";
import type { Resolver3D } from "../../geometry/Resolver3D";
import type { Vec3 } from "./shared";

/** État d'une session de routage (null = outil inactif). */
export interface RouteState { fromPortId: string | null; wpIds: string[]; armed?: boolean; mouse?: Vec3 | null }

/** Services de VUE fournis par l'hôte (agnostique de la chaîne de vues). */
export interface RouteHost {
  render(): void;
  /** <svg> 2D courant (surbrillance des waypoints déjà choisis), ou null. */
  svgEl(): SVGElement | null;
  /** Salle courante (mono), ou null. */
  currentDc(): any | null;
  /** Ouvre le formulaire de câblage prérempli (fin de route). `onCreated` est appelé avec l'id du câble
      RÉELLEMENT créé (après enregistrement du formulaire) → on peut alors le rendre visible. */
  openCableForm(prefill: { fromPortId: string; toPortId: string; waypointIds: string[]; onCreated?: (cableId: string) => void }): void;
  /** Rend un câble visible dans la vue (sélection), ex. juste après sa création par routage. */
  showCable(cableId: string): void;
  /** Désarme l'outil de positionnement (exclusivité des outils de clic). */
  disarmPositioning(): void;
  /** Moteur 3D-WebGL courant (overlay de route), ou null. */
  three(): any | null;
  /** Fabrique de bouton de panneau. */
  btn(text: string, onClick: () => void, title?: string): HTMLButtonElement;
  /** Libellé court d'un port (« équipement : port ») — partagé avec les tooltips de câble. */
  portShort(portId: string): string;
}

export class RouteTool {
  /** État courant (null = inactif). Exposé pour le pont d'accès de la vue (`get routeBuild()`). */
  state: RouteState | null = null;

  constructor(private readonly host: RouteHost, private readonly store: Store, private readonly resolver: Resolver3D) {}

  /** Une session de routage est-elle en cours ? */
  get active(): boolean { return !!this.state; }
  /** Départ posé (on attend des waypoints puis un port terminal) ? */
  get started(): boolean { return !!(this.state && this.state.fromPortId); }

  /* ---- machine d'état ---- */
  /** Arme le routage (exclusif du positionnement) : on attend le PORT de départ. */
  arm(): void { this.state = { fromPortId: null, wpIds: [], armed: true }; this.host.disarmPositioning(); Notify.toast("Routage : cliquez le PORT de départ", "ok"); this.host.render(); }
  /** Pose le port de départ. */
  start(portId: string): void { this.state = { fromPortId: portId, wpIds: [] }; Notify.toast("Route démarrée — cliquez des waypoints/brosses puis un PORT terminal"); this.host.render(); }
  /** Ajoute un waypoint à la route (refus des doublons et des violations de cohérence de salle « exit terminal »). */
  addWp(wpId: string): void {
    if (!this.state) return;
    if (this.state.wpIds.includes(wpId)) { Notify.toast("Ce point de passage est déjà dans la route", "err"); return; }   // pas deux fois le même
    // EXIT TERMINAL : un exit FERME sa salle au niveau de la route → interdit d'ajouter ensuite un waypoint de cette
    // salle (le câble DOIT sortir). On éprouve la route prospective (codes stables, cf. Store.cableRoute).
    const probe = { from_port_id: this.state.fromPortId, to_port_id: null, waypoint_ids: [...this.state.wpIds, wpId] };
    if (this.store.routeHasRoomBreak(probe)) { Notify.toast("Un exit est TERMINAL pour sa salle — le câble doit sortir avant tout autre waypoint de salle.", "err"); return; }
    this.state.wpIds.push(wpId); this.host.render();
  }
  /** Défait la dernière étape : retire le dernier waypoint, sinon le port de départ (retour à l'armement). */
  back(): void { const rb = this.state; if (!rb) return; if (rb.wpIds.length) rb.wpIds.pop(); else if (rb.fromPortId) { rb.fromPortId = null; rb.armed = true; } this.host.render(); }
  /** Annule la route en cours. */
  cancel(): void { this.state = null; this.host.render(); }
  /** Termine la route sur `endPortId` → ouvre le formulaire de câblage prérempli. */
  finish(endPortId: string): void {
    const rb = this.state; if (!rb || !rb.fromPortId) return;
    if (endPortId === rb.fromPortId) { Notify.toast("Le port terminal doit différer du port de départ", "err"); return; }
    const fromPortId = rb.fromPortId, wpIds = rb.wpIds.slice();
    this.state = null; this.host.render();
    // dialogue de câblage prérempli ; à la création effective, on rend le câble visible dans la vue.
    this.host.openCableForm({ fromPortId, toPortId: endPortId, waypointIds: wpIds, onCreated: (id) => this.host.showCable(id) });
  }

  /* ---- surbrillance 2D ---- */
  /** Met en évidence (`.route-pick`) les waypoints DÉJÀ choisis dans la route en cours, sur tous les `[data-wp]`. */
  markWaypoints(): void {
    const svg = this.host.svgEl(); if (!svg) return;
    const ids = new Set(this.state ? this.state.wpIds : []);
    svg.querySelectorAll("[data-wp]").forEach((n) => n.classList.toggle("route-pick", ids.has(n.getAttribute("data-wp") || "")));
  }

  /* ---- panneau latéral ---- */
  /** Carte « Route en cours » (panneau latéral) : étapes + retour + annuler. */
  card(): HTMLElement {
    const rb = this.state!, box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "🧵 Route en cours"; box.appendChild(t);
    const list = document.createElement("div"); list.style.cssText = "font-size:12px;margin:4px 0;display:flex;flex-direction:column;gap:3px";
    const step = (html: string, n?: number) => { const d = document.createElement("div"); d.innerHTML = (n != null ? '<span class="pill">' + n + "</span> " : "") + html; return d; };
    if (rb.fromPortId) list.appendChild(step("Départ : <b>" + Html.escape(this.host.portShort(rb.fromPortId)) + "</b>", 1));
    else list.appendChild(step('<span style="color:var(--accent)">Cliquez le PORT de départ…</span>'));
    rb.wpIds.forEach((id, i) => { const w: any = this.store.get("waypoints", id); list.appendChild(step(w ? Html.escape(Waypoint.glyph(w) + " " + (w.name || "(waypoint)")) : "(waypoint ?)", i + 2)); });
    box.appendChild(list);
    const hint = document.createElement("div"); hint.className = "form-hint";
    hint.textContent = rb.fromPortId ? "Cliquez des waypoints/brosses (changez de salle/étage si besoin), puis un PORT terminal pour finir." : "Cliquez un port libre pour démarrer la route.";
    box.appendChild(hint);
    const acts = document.createElement("div"); acts.className = "dc-card-acts";
    const bBack = this.host.btn("↩ Retour", () => this.back()); (bBack as any).disabled = !rb.fromPortId && !rb.wpIds.length;
    const bCancel = this.host.btn("✕ Annuler", () => this.cancel()); bCancel.classList.add("btn-danger");
    acts.append(bBack, bCancel); box.appendChild(acts);
    return box;
  }

  /* ---- pont moteur WebGL (3D) ---- */
  /** Points MONDE de la route pour l'overlay 3D (départ + waypoints posés de la salle active). Mono-salle : repère
      salle = monde ; en multi, seuls les waypoints de la salle active sont prévisualisés. */
  worldPts(): Vec3[] {
    const rb = this.state, dc = this.host.currentDc(); if (!rb || !dc) return [];
    const pts: Vec3[] = [];
    if (rb.fromPortId) { const a = this.resolver.resolvePort3D(rb.fromPortId, dc.id); if (a) pts.push({ x: a.x, y: a.y, z: a.z }); }
    rb.wpIds.forEach((id) => { const w: any = this.store.get("waypoints", id); if (w && this.store.waypointIsPlaced(w) && w.datacenter_id === dc.id) { const an = this.resolver.waypointAnchor(w); pts.push({ x: an.x, y: an.y, z: an.z }); } });
    return pts;
  }
  /** Overlay de route repoussé au moteur (mode « route » + points + curseur 3D). Appelé par le dispatcher WebGL. */
  syncWebgl(): void { const t = this.host.three(); if (!t) return; t.setToolMode("route"); t.setRouteOverlay(this.worldPts(), (this.state && this.state.mouse) || null); }
  /** Clic route (moteur) → port de départ / waypoint / port terminal (même machine d'état qu'en SVG). */
  onWebglPick(desc: any): void {
    const rb = this.state; if (!rb || !desc) return;
    if (desc.type === "port") { if (!rb.fromPortId) this.start(desc.id); else if (desc.id !== rb.fromPortId) this.finish(desc.id); }
    else if (desc.type === "wp") { if (rb.fromPortId) this.addWp(desc.id); }
  }
  /** Survol route (moteur) → aperçu (rubber-band) jusqu'au curseur. */
  onWebglHover(w: Vec3 | null): void {
    const rb = this.state; if (!rb || !rb.fromPortId) return;
    rb.mouse = w;
    const t = this.host.three(); if (t) t.setRouteOverlay(this.worldPts(), w);
  }
}
