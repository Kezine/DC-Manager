import { Text } from "../../core/Text";
import { CableSpline } from "../../geometry/CableSpline";
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

  /* ---- helpers de FAISCEAUX (trunks) — même découpe que les câbles, service TrunkRouting ---- */

  /** Faisceaux dont LES DEUX uplinks (patchs d'extrémité) sont résolus dans `dcId`. Délégué au service. */
  protected resolvedTrunks(dcId: string): Array<{ bundle: any; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
    return this.trunks.resolvedTrunks(dcId, this.cablePortNormal);
  }
  /** Faisceaux SORTANTS (un seul uplink dans `dcId`) tracés jusqu'à l'exit. Délégué au service. */
  protected outgoingTrunkStubs(dcId: string): Array<{ bundle: any; endpoint: Vec3; endpointRackId: string | null; pts: Vec3[]; linePts: Vec3[]; straight?: Set<number>; stubAt?: Set<number> }> {
    return this.trunks.outgoingTrunkStubs(dcId, this.cablePortNormal);
  }


  /* ---- recherche / visibilité câbles ---- */
  protected matchSearch(text: any): boolean { const q = this.searchTerm.trim(); return !!q && Text.normSearch(text).includes(Text.normSearch(q)); }

  protected cableHit(c: any): boolean { return this.matchSearch(c.name); }

  protected cableShown(rc: { cable: any }): boolean { return this.showAllCables || this.selCables.has(rc.cable.id); }

  /** Visibilité d'un FAISCEAU — MÊME modèle que les câbles (« Tout afficher » + sélection partagée `selCables`,
      les ids étant uniques toutes collections) : isoler un câble masque aussi les trunks, et réciproquement. */
  protected trunkShown(rt: { bundle: any }): boolean { return this.showAllCables || this.selCables.has(rt.bundle.id); }


  /** Tracé d'un câble (mécanique UNIQUE ports + conduits) : segments de `straight` tracés DROITS (`L`) ; aux points
      d'`stubAt` (amorces ⊥), la courbe adjacente reçoit une TANGENTE IMPOSÉE = sens de leur segment droit (continuité
      G1 : la courbe part/arrive dans l'axe puis s'incurve, aucun « kink »). Autres points : Catmull-Rom (`cableSplineK`). */
  protected cablePath(P: Array<{ h: number; v: number }>, straight?: Set<number>, stubAt?: Set<number>): string {
    if (!P || P.length < 2) return "";
    const M = "M" + P[0].h + "," + P[0].v;
    if (P.length === 2) return M + " L" + P[1].h + "," + P[1].v;
    // TANGENTES PARTAGÉES avec l'échantillonnage 3D (CableSpline.controls) : UN seul calcul d'amorces ⟂ et
    // de Catmull-Rom pour les DEUX moteurs — toute évolution du routage vaut partout, sans divergence
    // visuelle 2D/3D. Ici il ne reste que la sérialisation en path SVG.
    const ctrls = CableSpline.controls(P.map((p) => [p.h, p.v]), straight, this.cableSplineK, stubAt);
    let d = M;
    for (let i = 0; i < P.length - 1; i++) {
      const c = ctrls[i];
      if (!c) { d += " L" + P[i + 1].h + "," + P[i + 1].v; continue; }   // segment droit
      d += " C" + c.c1[0] + "," + c.c1[1] + " " + c.c2[0] + "," + c.c2[1] + " " + P[i + 1].h + "," + P[i + 1].v;
    }
    return d;
  }

}
