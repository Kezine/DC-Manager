/* =============================================================================
   OUTIL DE MESURE multipoint (éphémère) — contrôleur extrait du monolithe DcInteract.

   Pose des points au clic ; longueur par segment + total ; mesures « terminées » conservées
   en session. 2D (Dessus/Étage) : point au niveau du SOL (z=0) via clientToWorld. 3D-WebGL :
   le raycast est fait par le moteur (cf. onWebglPlace/onWebglHover), la vue tient l'état + le
   panneau puis repousse l'overlay Three.js. Les points vivent dans le repère du CONTEXTE
   courant (salle mono / monde multi / plan d'étage) — d'où `ctx` + `activeHere()`.

   Découplé de la chaîne de vues : ne connaît que `MeasureHost`. Le calcul PUR (longueur /
   total) vit dans `geometry/Measure`. Exclusif du routage et du positionnement (un seul outil
   de clic à la fois — cf. host.disarmPositioning / host.clearRoute).
   ============================================================================= */
import { Dom } from "../../ui/Dom";
import { Html } from "../../core/Html";
import { Format } from "../../core/Format";
import { Notify } from "../../ui/Notify";
import { Measure } from "../../geometry/Measure";
import { DC_DOT_PX } from "./shared";
import type { Vec3 } from "./shared";

/** État d'une session de mesure (points en coordonnées du CONTEXTE `ctx`). */
export interface MeasureState { active: boolean; ctx: string; pts: Vec3[]; cursor: Vec3 | null; done: Vec3[][] }

/** Services fournis par la vue hôte (agnostique : Plan de salle / Étage / 3D-WebGL). */
export interface MeasureHost {
  render(): void;
  buildToolbar(): void;
  showCote(text: string, clientX: number, clientY: number): void;
  hideCote(): void;
  /** Nature de la vue courante. */
  viewKind(): "top" | "floor" | "3d";
  /** Vue 3D multi-salles (repère MONDE partagé) ? */
  isMultiDc(): boolean;
  /** Salle courante (mono), ou null. */
  currentDc(): any | null;
  /** Étage visé en vue Étage, ou null. */
  floorTargetResolve(): { location: string; floor: string } | null;
  /** Échelle mm→px courante (null si la scène n'est pas encore cadrée). */
  scaleOrNull(): number | null;
  /** Une scène SVG 2D est-elle montée ? */
  hasSvg(): boolean;
  /** Écran → monde (mm) dans la vue 2D courante. */
  clientToWorld(cx: number, cy: number): { x: number; y: number };
  /** Groupe SVG racine (overlays) — nommé `overlayRoot` pour ne pas heurter le champ `gRoot` de la vue. */
  overlayRoot(): SVGGElement | null;
  /** Échelle des marqueurs (pastilles) — nommé `dotScale` pour ne pas heurter le champ `markerScale` de la vue. */
  dotScale(): number;
  /** La vue 2D est-elle tournée (plan d'étage) → textes à redresser ? */
  isFloorTransformed(): boolean;
  /** Redresse un texte SVG malgré la rotation 2D. */
  applyUprightText(t: Element): void;
  /** Moteur 3D-WebGL courant (overlay/mode outil), ou null. */
  three(): any | null;
  /** Fabrique de bouton de panneau. */
  btn(text: string, onClick: () => void, title?: string): HTMLButtonElement;
  /** Désarme l'outil de positionnement (exclusivité des outils de clic). */
  disarmPositioning(): void;
  /** Annule une éventuelle session de routage (exclusivité). */
  clearRoute(): void;
  /** Reconstruit le SEUL panneau latéral de la salle courante (sans rebâtir la scène — utile en 3D-WebGL). */
  refreshSide(): void;
}

export class MeasureTool {
  /** État courant (null = outil inactif). Exposé pour le pont d'accès de la vue (`get measure()`). */
  state: MeasureState | null = null;
  /** Mesure terminée mise en évidence (survol du listing), ou null. */
  hi: number | null = null;

  constructor(private readonly host: MeasureHost) {}

  /* ---- cycle de vie ---- */
  /** (Ré)arme l'outil dans le contexte de vue courant (exclusif du routage / positionnement). */
  arm(): void {
    this.host.clearRoute(); this.host.disarmPositioning();   // un seul mode de clic à la fois
    this.hi = null;
    this.state = { active: true, ctx: this.ctxKey(), pts: [], cursor: null, done: [] };
    Notify.toast("Mesure : cliquez pour poser des points · glissez pour naviguer · ÉCHAP pour effacer", "ok");
    this.host.buildToolbar(); this.host.render();
  }
  cancel(): void { this.state = null; this.hi = null; this.host.hideCote(); this.host.buildToolbar(); this.host.render(); }
  undo(): void { if (this.state && this.state.pts.length) { this.state.pts.pop(); this.state.cursor = null; this.host.render(); } }
  /** Termine la mesure en cours (≥ 2 points) : elle reste affichée (session), une nouvelle peut démarrer. */
  commit(): void { const m = this.state; if (m && m.pts.length >= 2) { m.done.push(m.pts.slice()); m.pts = []; m.cursor = null; this.hi = null; this.host.hideCote(); this.host.render(); } }
  /** Annule la mesure EN COURS (points non validés) en conservant les mesures terminées. Action de « ÉCHAP ». */
  cancelCurrent(): void { if (this.state && (this.state.pts.length || this.state.cursor)) { this.state.pts = []; this.state.cursor = null; this.host.hideCote(); this.host.render(); } }
  /** Efface TOUTES les mesures (en cours + terminées). Bouton « Tout effacer ». */
  clearAll(): void { if (this.state) { this.state.pts = []; this.state.cursor = null; this.state.done = []; this.hi = null; this.host.hideCote(); this.host.render(); } }
  /** L'outil a-t-il une session active ? (raccourci pour les gardes des wirings). */
  hasActive(): boolean { return !!(this.state && this.state.active); }

  /* ---- contexte ---- */
  /** Clé du contexte spatial courant : une mesure n'est tracée que là où elle a été prise (repères compatibles).
      NB : la 3D mono et le Plan de salle d'UNE MÊME salle partagent le repère → une mesure y est visible des deux. */
  ctxKey(): string {
    if (this.host.viewKind() === "floor") { const ft = this.host.floorTargetResolve(); return ft ? "floor:" + ft.location + "/" + ft.floor : "floor:?"; }
    if (this.host.viewKind() === "3d" && this.host.isMultiDc()) return "multi";
    const dc = this.host.currentDc(); return "room:" + (dc ? dc.id : "?");
  }
  /** La mesure en cours appartient-elle au contexte affiché ? (sinon : panneau informatif, pas de tracé/pose). */
  activeHere(): boolean { return !!(this.state && this.state.active && this.state.ctx === this.ctxKey()); }

  /* ---- pose de points (2D) ---- */
  /** Pose un point au clic (si le contexte correspond). */
  placeAt(clientX: number, clientY: number): void {
    if (!this.activeHere()) { Notify.toast("Mesure prise dans un autre contexte — revenez-y ou effacez-la", "err"); return; }
    const p = this.pick(clientX, clientY);
    if (!p) { Notify.toast("Vue trop rasante : inclinez la caméra pour poser un point au sol", "err"); return; }
    this.state!.pts.push(p); this.state!.cursor = null; this.host.hideCote();
    this.host.render();
  }
  /** Point MONDE d'un clic en vue 2D (Dessus / Étage) : au niveau du SOL (z=0). En 3D, le raycast est fait par le
      moteur WebGL (cf. onWebglPlace / DcThreeScene.toolRaycast). */
  pick(clientX: number, clientY: number): Vec3 | null {
    if (!this.host.hasSvg() || this.host.scaleOrNull() == null) return null;
    const v = this.host.viewKind();
    if (v === "top" || v === "floor") { const w = this.host.clientToWorld(clientX, clientY); return { x: w.x, y: w.y, z: 0 }; }
    return null;
  }

  /* ---- overlay 2D ---- */
  /** Tracé 2D (Dessus/Étage) des mesures : validées (étiquette nom+total, surbrillance) + en cours (par segment). */
  drawOverlay(gRoot: SVGGElement): void {
    if (this.host.viewKind() === "3d" || !this.activeHere()) return;
    const m = this.state!; if (!m.pts.length && !m.done.length) return;
    const scale = this.host.scaleOrNull() || 1;
    const g = Dom.svg("g", { class: "dc-measure" }), fMM = 13 / scale;
    const rDot = (DC_DOT_PX + 1) * this.host.dotScale() / scale;
    const label = (text: string, x: number, y: number, cls: string) => { const t = Dom.svg("text", { class: cls, x, y, "text-anchor": "middle", "font-size": fMM }); t.textContent = text; g.appendChild(t); };
    const poly = (pts: Vec3[], hot: boolean, segLabels: boolean) => {
      if (!pts.length) return;
      const lineCls = "dc-measure-line" + (hot ? " hi" : "");
      if (pts.length >= 2) {
        g.appendChild(Dom.svg("polyline", { class: lineCls, points: pts.map((p) => p.x + "," + p.y).join(" ") }));
        if (segLabels) for (let i = 1; i < pts.length; i++) label(Format.meters(Measure.dist(pts[i - 1], pts[i])), (pts[i - 1].x + pts[i].x) / 2, (pts[i - 1].y + pts[i].y) / 2, "dc-measure-label");
      }
      pts.forEach((p) => g.appendChild(Dom.svg("circle", { class: "dc-measure-dot" + (hot ? " hi" : ""), cx: p.x, cy: p.y, r: rDot })));
    };
    m.done.forEach((pts, i) => {   // mesures validées : étiquette nom+total + surbrillance au survol
      poly(pts, i === this.hi, false);
      const c = pts.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y, z: 0 }), { x: 0, y: 0, z: 0 });
      label("Mesure " + (i + 1) + " · " + Format.meters(Measure.total(pts)), c.x / pts.length, c.y / pts.length, "dc-measure-label name");
    });
    poly(m.pts, false, true);   // mesure en cours : étiquettes par segment
    gRoot.appendChild(g);
  }

  /** Met en évidence (ou non) la mesure terminée d'index `i` — appelé au survol du listing. Rafraîchit le SEUL overlay. */
  setHi(i: number | null): void {
    this.hi = i;
    if (this.host.viewKind() === "3d") { const t = this.host.three(); if (t && this.state) t.setMeasureOverlay(this.state.pts, this.state.cursor, this.state.done, i); }
    else this.refreshOverlay();
  }
  /** Re-trace le SEUL overlay de mesure 2D (sans reconstruire la scène) — pour la surbrillance au survol. */
  refreshOverlay(): void {
    const g = this.host.overlayRoot(); if (!g) return;
    g.querySelectorAll(".dc-measure").forEach((n) => n.remove());
    this.drawOverlay(g);
    if (this.host.isFloorTransformed()) g.querySelectorAll(".dc-measure text").forEach((t) => this.host.applyUprightText(t));   // textes à l'endroit malgré la rotation 2D
  }
  /** APERÇU 2D du segment en cours (dernier point posé → curseur), sans reconstruire la scène. En 3D, l'aperçu est
      géré par le moteur WebGL. Trait pointillé + pastille ; longueur live via la cote flottante. */
  refreshPreview(): void {
    const g = this.host.overlayRoot(); if (!g) return;
    g.querySelectorAll(".dc-measure-preview").forEach((n) => n.remove());
    const m = this.state;
    if (this.host.viewKind() === "3d" || !this.activeHere() || !m || !m.cursor || !m.pts.length) return;
    const last = m.pts[m.pts.length - 1], cur = m.cursor;
    const grp = Dom.svg("g", { class: "dc-measure-preview", style: "pointer-events:none" });
    grp.appendChild(Dom.svg("line", { class: "dc-measure-line preview", x1: last.x, y1: last.y, x2: cur.x, y2: cur.y }));
    const rDot = (DC_DOT_PX + 1) * this.host.dotScale() / (this.host.scaleOrNull() || 1);
    grp.appendChild(Dom.svg("circle", { class: "dc-measure-dot", cx: cur.x, cy: cur.y, r: rDot }));
    g.appendChild(grp);
  }
  /** Met à jour le curseur (aperçu 2D) depuis un clic écran — appelé par le mousemove throttlé de la vue.
      Renvoie la longueur du segment en cours (pour la cote live), ou null si pas d'aperçu. */
  updateCursor(clientX: number, clientY: number): number | null {
    if (!this.state) return null;
    this.state.cursor = this.pick(clientX, clientY);
    this.refreshPreview();
    if (!this.state.cursor || !this.state.pts.length) return null;
    return Measure.dist(this.state.pts[this.state.pts.length - 1], this.state.cursor);
  }

  /* ---- panneau latéral ---- */
  /** Carte « Mesure » (panneau latéral) : liste des segments + longueur totale + actions. */
  card(): HTMLElement {
    const box = document.createElement("div"); box.className = "dc-card";
    const t = document.createElement("div"); t.className = "dc-card-title"; t.textContent = "📏 Mesure"; box.appendChild(t);
    const m = this.state!, here = this.activeHere();
    const list = document.createElement("div"); list.style.cssText = "font-size:12px;margin:4px 0;display:flex;flex-direction:column;gap:3px";
    // LISTE des mesures : terminées (conservées en session) + celle en cours, avec longueur + nombre de points.
    const measures = m.done.map((p, i) => ({ name: "Mesure " + (i + 1), pts: p, idx: i as number | null })).concat(m.pts.length ? [{ name: "En cours", pts: m.pts, idx: null }] : []);
    if (!measures.length) {
      const d = document.createElement("div"); d.innerHTML = '<span style="color:var(--accent)">Cliquez pour poser le premier point…</span>'; list.appendChild(d);
    } else {
      measures.forEach((meas) => {
        const np = meas.pts.length, d = document.createElement("div");
        d.innerHTML = '<b>' + Html.escape(meas.name) + '</b> : <b style="color:var(--accent)">' + Html.escape(Format.meters(Measure.total(meas.pts))) + '</b> <span style="color:var(--fg-dim)">· ' + np + ' point' + (np > 1 ? 's' : '') + '</span>';
        if (meas.idx != null && here) {   // mesure VALIDÉE → survol = mise en évidence dans la vue
          const idx = meas.idx; d.style.cursor = "pointer";
          d.addEventListener("mouseenter", () => this.setHi(idx));
          d.addEventListener("mouseleave", () => this.setHi(null));
        }
        list.appendChild(d);
      });
    }
    box.appendChild(list);
    if (measures.length) {   // LONGUEUR TOTALE (toutes mesures)
      const grand = m.done.reduce((s, p) => s + Measure.total(p), 0) + Measure.total(m.pts);
      const tot = document.createElement("div"); tot.style.cssText = "margin:6px 0;font-size:13px;border-top:1px solid var(--line);padding-top:6px";
      tot.innerHTML = 'Longueur totale : <b style="color:var(--accent)">' + Html.escape(Format.meters(grand)) + '</b>';
      box.appendChild(tot);
    }
    const hint = document.createElement("div"); hint.className = "form-hint";
    hint.textContent = here ? "Cliquez pour poser des points · ENTRÉE valide la mesure · ÉCHAP annule la mesure en cours."
      : "Mesure prise dans un autre contexte de vue. Revenez-y pour l'éditer, ou effacez-la.";
    box.appendChild(hint);
    const acts = document.createElement("div"); acts.className = "dc-card-acts";
    const bUndo = this.host.btn("↩ Annuler point", () => this.undo()); (bUndo as any).disabled = !m.pts.length || !here;
    const bNew = this.host.btn("✓ Valider (Entrée)", () => this.commit()); (bNew as any).disabled = m.pts.length < 2 || !here;
    const bClear = this.host.btn("🗑 Tout effacer", () => this.clearAll()); (bClear as any).disabled = !m.pts.length && !m.done.length;
    const bClose = this.host.btn("✕ Fermer", () => this.cancel()); bClose.classList.add("btn-danger");
    acts.append(bUndo, bNew, bClear, bClose); box.appendChild(acts);
    return box;
  }

  /* ---- pont moteur WebGL (3D) ---- */
  /** (Ré)applique au moteur WebGL le mode outil + l'overlay courant (appelé après chaque (re)rendu 3D-WebGL). */
  syncWebgl(): void {
    const t = this.host.three(); if (!t) return;
    if (this.state && this.state.active && this.activeHere()) { t.setToolMode("measure"); t.setMeasureOverlay(this.state.pts, this.state.cursor, this.state.done, this.hi); }
  }
  /** Clic mesure (moteur) → pose un point + met à jour panneau et overlay (sans reconstruire la scène). */
  onWebglPlace(w: Vec3): void {
    if (!this.state || !this.state.active || !this.activeHere()) return;
    this.state.pts.push({ x: w.x, y: w.y, z: w.z }); this.state.cursor = null; this.host.hideCote();
    this.host.refreshSide();   // 3D-WebGL : rafraîchir le PANNEAU seul (l'overlay est repoussé au moteur ci-dessous)
    const t = this.host.three(); if (t) t.setMeasureOverlay(this.state.pts, null, this.state.done, this.hi);
  }
  /** Survol mesure (moteur) → aperçu du segment courant + cote flottante (longueur live). */
  onWebglHover(w: Vec3 | null, clientX: number, clientY: number): void {
    if (!this.state || !this.state.active || !this.activeHere() || !this.state.pts.length) { this.host.hideCote(); return; }
    this.state.cursor = w;
    const t = this.host.three(); if (t) t.setMeasureOverlay(this.state.pts, w, this.state.done, this.hi);
    const last = this.state.pts[this.state.pts.length - 1];
    if (w) this.host.showCote(Format.meters(Measure.dist(last, w)), clientX, clientY); else this.host.hideCote();
  }
}
