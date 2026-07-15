/* =============================================================================
   Débattement des PORTES DE BAIE (vue dessus, repère LOCAL de baie) — géométrie
   PURE consommée par les DEUX moteurs (SVG « Dessus » + WebGL). Auparavant
   dupliquée dans DcViews2D.doorSwingNode et DcThreeScene.buildDoorSwing, AVEC
   DIVERGENCE : la 2D posait le pivot au plan de face (d/2) quand la 3D le posait
   sur l'arête EXTÉRIEURE du vantail (d/2 + cavité + épaisseur) — c'est la version
   3D, physiquement juste, qui est retenue (la porte pivote sur sa charnière, qui
   est en saillie de la face de l'épaisseur du vantail + la cavité éventuelle).
   ============================================================================= */

export interface DoorSwing {
  hx: number;     // pivot X (charnière : bord gauche/droit décalé de l'épaisseur)
  hy: number;     // pivot Y (arête extérieure du vantail : ±(d/2 + cavité + épaisseur))
  R: number;      // rayon du débattement = largeur du vantail
  dirX: number;   // sens du vantail FERMÉ le long de la face (+1 = vers +X)
  beta: number;   // angle d'ouverture signé (±90° : R(beta)·(dirX,0) pointe vers l'extérieur)
}

/** Descripteur de porte consommé ici (cf. Normalize.rackDoor). `leaves` optionnel (1 par défaut, 2 = double battant). */
export interface RackDoorLike { thickness_mm?: number; hinge?: string; leaves?: number; hollow?: boolean; hollow_mm?: number }

export class RackDoorGeometry {
  /** Secteur de débattement d'une porte de baie à vantail UNIQUE. `w`/`d` : dimensions extérieures de la baie (mm) ;
      `rear` : porte arrière ; `dr` : descripteur normalisé (cf. RackGeometry.door). */
  static swingSector(w: number, d: number, rear: boolean, dr: RackDoorLike): DoorSwing {
    const clr = Math.max(6, (dr.thickness_mm as number) | 0);
    const R = Math.max(1, w - clr);                              // rayon = largeur réelle du vantail
    const cavity = dr.hollow ? Math.max(0, (dr.hollow_mm as number) | 0) : 0;
    const sgn = rear ? 1 : -1;                                   // face/ouverture vers l'extérieur (avant −Y · arrière +Y)
    const left = (dr.hinge !== "right") !== rear;                // gauche vue DE LA FACE de la porte (inversé à l'arrière)
    const dirX = left ? 1 : -1;                                  // sens du vantail fermé le long de la face
    const beta = Math.sign(sgn / dirX) * Math.PI / 2;            // 90° signés — R(beta)·(dirX,0) = (0,sgn)
    return { hx: left ? (-w / 2 + clr) : (w / 2 - clr), hy: sgn * (d / 2 + cavity + clr), R, dirX, beta };
  }

  /** Secteurs de débattement des VANTAUX (1 ou 2). Simple : le secteur historique (pleine largeur).
      DOUBLE BATTANT : deux demi-vantaux — pivots aux DEUX bords (chacun décalé de l'épaisseur), rayon ≈ w/2,
      loquets au CENTRE ; le champ `hinge` est sans effet (symétrique). */
  static swingSectors(w: number, d: number, rear: boolean, dr: RackDoorLike): DoorSwing[] {
    if (((dr.leaves ?? 1) | 0) !== 2) return [RackDoorGeometry.swingSector(w, d, rear, dr)];
    const clr = Math.max(6, (dr.thickness_mm as number) | 0);
    const R = Math.max(1, w / 2 - clr);                          // rayon = largeur d'un demi-vantail
    const cavity = dr.hollow ? Math.max(0, (dr.hollow_mm as number) | 0) : 0;
    const sgn = rear ? 1 : -1;
    const hy = sgn * (d / 2 + cavity + clr);
    // un vantail par bord : pivot gauche (fermé vers +X) et pivot droit (fermé vers −X).
    return [1, -1].map((dirX) => ({ hx: dirX > 0 ? (-w / 2 + clr) : (w / 2 - clr), hy, R, dirX, beta: Math.sign(sgn / dirX) * Math.PI / 2 }));
  }

  /** Points d'UN secteur (pivot puis arc échantillonné en N segments), prêts à tracer (path SVG / triangle fan). */
  static sectorPointsOf(s: DoorSwing, N = 16): Array<{ x: number; y: number }> {
    const out: Array<{ x: number; y: number }> = [{ x: s.hx, y: s.hy }];
    for (let i = 0; i <= N; i++) {
      const a = s.beta * (i / N);
      out.push({ x: s.hx + s.dirX * s.R * Math.cos(a), y: s.hy + s.dirX * s.R * Math.sin(a) });
    }
    return out;
  }

}
