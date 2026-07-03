import { Text } from "../../core/Text";
import type { Vec3 } from "./shared";
import { DcCamera } from "./DcCamera";

/* Couche « rendu 3D » de la vue Datacenter. Le moteur 3D SVG legacy (painter) a été RETIRÉ : la 3D est rendue
   exclusivement par le moteur WebGL (Three.js, cf. ./three/). Ne subsistent ici que les HELPERS de câbles partagés
   avec les vues 2D (Plan de salle / Plan d'étage) — résolution de tracé, couleur, filtres d'affichage, spline. */
export abstract class DcScene3D extends DcCamera {

  /** Entrée de rendu 3D : déléguée au moteur WebGL (diff léger si la scène existe, sinon construction complète). */
  renderThreeD(dc: any): void {
    this.persistView();
    if (this._three) { this._webglRev = this.store.histIndex(); this._three.applyOptionsDiff(this.webglOptions(), dc ? dc.id : null, this.webglCtx()); this.syncWebglTool(); this.applyFocus3D(); }
    else this.renderWebGL(dc);
  }


  /* ---- helpers de câbles PARTAGÉS avec les vues 2D (Dessus / Étage) ---- */

  /** Câbles dont LES DEUX bouts sont résolus dans `dcId` : endpoints + points de passage. Délégué au service. */
  protected resolvedCables(dcId: string): Array<{ cable: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
    return this.routing.resolvedCables(dcId, this.cablePortNormal);
  }
  /** Câbles SORTANTS (un seul bout dans `dcId`) tracés jusqu'à l'exit. Délégué au service. */
  outgoingCableStubs(dcId: string): Array<{ cable: any; portId: string; port: Vec3; portRackId: string | null; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
    return this.routing.outgoingCableStubs(dcId, this.cablePortNormal);
  }

  /** Couleur d'un câble = celle de son réseau PRINCIPAL (null sinon). Délégué au service. */
  protected cableColor(c: any): string | null { return this.routing.cableColor(c); }


  /* ---- recherche / visibilité câbles ---- */
  protected matchSearch(text: any): boolean { const q = this.searchTerm.trim(); return !!q && Text.normSearch(text).includes(Text.normSearch(q)); }

  protected cableHit(c: any): boolean { return this.matchSearch(c.name); }

  protected cableShown(rc: { cable: any }): boolean { return this.showAllCables || this.selCables.has(rc.cable.id); }


  /** Tracé d'un câble (mécanique UNIQUE ports + conduits) : segments de `straight` tracés DROITS (`L`) ; aux points
      d'`stubAt` (amorces ⊥), la courbe adjacente reçoit une TANGENTE IMPOSÉE = sens de leur segment droit (continuité
      G1 : la courbe part/arrive dans l'axe puis s'incurve, aucun « kink »). Autres points : Catmull-Rom (`cableSplineK`). */
  protected cablePath(P: Array<{ h: number; v: number }>, straight?: Set<number>, stubAt?: Set<number>): string {
    if (!P || P.length < 2) return "";
    const M = "M" + P[0].h + "," + P[0].v;
    if (P.length === 2) return M + " L" + P[1].h + "," + P[1].v;
    const n = P.length, k = this.cableSplineK, hk = k * 2.5;
    const dist = (p: any, q: any) => Math.hypot(q.h - p.h, q.v - p.v);
    const unit = (p: any, q: any) => { const dh = q.h - p.h, dv = q.v - p.v, L = Math.hypot(dh, dv) || 1; return { h: dh / L, v: dv / L }; };
    // tangente imposée à un point d'amorce = sens de SON segment droit adjacent (G1 avec le segment droit)
    const stubDir = (i: number): { h: number; v: number } | null => {
      if (!stubAt || !stubAt.has(i)) return null;
      if (straight && straight.has(i)) return unit(P[i], P[i + 1]);          // segment droit APRÈS i
      if (i > 0 && straight && straight.has(i - 1)) return unit(P[i - 1], P[i]); // segment droit AVANT i
      return null;
    };
    const tanAt = (i: number, segLen: number): { h: number; v: number } => {
      const d = stubDir(i);
      if (d) return { h: d.h * segLen * hk, v: d.v * segLen * hk };   // amorce : tangente alignée sur l'axe
      const p0 = P[Math.max(0, i - 1)], p1 = P[Math.min(n - 1, i + 1)];
      return { h: (p1.h - p0.h) * k, v: (p1.v - p0.v) * k };          // intérieur : Catmull-Rom
    };
    let d = M;
    for (let i = 0; i < n - 1; i++) {
      if (straight && straight.has(i)) { d += " L" + P[i + 1].h + "," + P[i + 1].v; continue; }   // segment droit
      const segLen = dist(P[i], P[i + 1]), m0 = tanAt(i, segLen), m1 = tanAt(i + 1, segLen);
      d += " C" + (P[i].h + m0.h) + "," + (P[i].v + m0.v) + " " + (P[i + 1].h - m1.h) + "," + (P[i + 1].v - m1.v) + " " + P[i + 1].h + "," + P[i + 1].v;
    }
    return d;
  }

}
