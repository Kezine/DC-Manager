/* =============================================================================
   PivotBounds — bornage du PIVOT D'ORBITE de la caméra 3D aux « murs virtuels »
   des salles affichées. GÉOMÉTRIE PURE (aucun THREE, aucun DOM) → testable en Node.
   ----------------------------------------------------------------------------
   POURQUOI. `DcThreeCamera.recenterPivotOnView()` pose le pivot d'orbite sur le
   point de scène au CENTRE de l'écran : première surface touchée, SINON repli sur
   le plan du sol INFINI (z = 0). Sous un angle RASANT, ce repli tombe très loin
   HORS de la salle → le pivot part à l'autre bout du monde et la rotation devient
   démesurée (on tourne autour du vide).

   On BORNE donc ce SEUL repli (le contenu réellement touché reste prioritaire et
   inchangé) à la boîte englobante XY des salles affichées, en la traitant comme
   des PAROIS VERTICALES INFINIMENT HAUTES (arbitrage utilisateur : bornage PUREMENT
   XY, aucune contrainte en Z) :
     - point de sol DANS la boîte → on le garde tel quel ;
     - point de sol HORS de la boîte, mais le rayon TRAVERSE la boîte → le pivot
       devient le point de SORTIE du rayon (= le MUR le plus LOIN de la caméra) ;
     - le rayon ne traverse jamais la boîte → point de sol RAMENÉ au bord (clamp XY) ;
     - aucun point de sol ET pas de traversée → on ne bouge pas le pivot (null).

   CONVENTION DE PLACEMENT (à répliquer FIDÈLEMENT depuis la scène) : une salle est
   posée par `DcThreeScene.roomUnder` = groupe externe (position (ox,oy,oz),
   rotation z = o) contenant un groupe interne translaté de (−w/2, −d/2). Un coin
   local (0/w, 0/d) devient donc, en monde XY : (ox,oy) + Rz(o)·(±w/2, ±d/2) — d'où
   `rectCorners`.
   ============================================================================= */

/** Point (repère MONDE). Le z n'intervient PAS dans le bornage (parois infinies) ; il est juste TRANSPORTÉ. */
export interface PivotVec { x: number; y: number; z: number; }
/** Boîte englobante alignée aux axes, en XY (repère MONDE). */
export interface PivotAabb { minX: number; maxX: number; minY: number; maxY: number; }

const EPS = 1e-9;

export class PivotBounds {
  /** 4 coins MONDE (XY) d'une salle depuis son placement RoomDesc — même transformée que `DcThreeScene.roomUnder`
      (translate(ox,oy) · rotZ(o) · rectangle centré ±w/2 × ±d/2). Ordre : bas-gauche, bas-droit, haut-droit, haut-gauche. */
  static rectCorners(ox: number, oy: number, o: number, w: number, d: number): Array<{ x: number; y: number }> {
    const co = Math.cos(o), so = Math.sin(o), hw = w / 2, hd = d / 2;
    return ([[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] as Array<[number, number]>).map(([cx, cy]) => ({
      x: ox + cx * co - cy * so,   // Rz(o) standard (CCW) — identique à outer.rotation.z de la scène
      y: oy + cx * so + cy * co,
    }));
  }

  /** AABB (XY) de l'UNION de plusieurs rectangles (coins monde). null si aucun rectangle (aucune salle affichée). */
  static unionAabb(rects: Array<Array<{ x: number; y: number }>>): PivotAabb | null {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const corners of rects) for (const p of corners) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
  }

  /** Vrai si le point est DANS la boîte en XY (bornes incluses). */
  private static inAabbXY(p: { x: number; y: number }, aabb: PivotAabb): boolean {
    return p.x >= aabb.minX && p.x <= aabb.maxX && p.y >= aabb.minY && p.y <= aabb.maxY;
  }

  private static clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** Paramètre `t` du point de SORTIE du rayon (origin + t·dir) hors du SLAB vertical (parois infinies en Z) défini
      par l'AABB XY, ou null si le rayon n'entre JAMAIS dans la boîte. Méthode du slab, sur X puis Y uniquement :
      tEnter = max des entrées, tExit = min des sorties ; valide si tEnter ≤ tExit. Un axe PARALLÈLE (dir ≈ 0) hors des
      bornes → aucune intersection ; parallèle et dans les bornes → cet axe n'impose aucune borne. Peut renvoyer un
      tExit ≤ 0 (boîte DERRIÈRE la caméra) ou non fini (rayon vertical entièrement dans le slab) — l'appelant tranche. */
  private static slabExitT(origin: PivotVec, dir: PivotVec, aabb: PivotAabb): number | null {
    let tEnter = -Infinity, tExit = Infinity;
    const axis = (o: number, dd: number, lo: number, hi: number): boolean => {
      if (Math.abs(dd) < EPS) return o >= lo && o <= hi;   // parallèle : dans le slab (true) ou jamais (false)
      let t1 = (lo - o) / dd, t2 = (hi - o) / dd;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tEnter) tEnter = t1;
      if (t2 < tExit) tExit = t2;
      return true;
    };
    if (!axis(origin.x, dir.x, aabb.minX, aabb.maxX)) return null;
    if (!axis(origin.y, dir.y, aabb.minY, aabb.maxY)) return null;
    if (tEnter > tExit) return null;              // n'entre jamais dans la boîte
    return Number.isFinite(tExit) ? tExit : null; // rayon vertical inscrit dans le slab (pas de sortie finie) → null
  }

  /** Pivot BORNÉ pour le repli « sol infini » de la caméra. Règles (cf. en-tête) :
        1. `ground` fourni ET DANS l'AABB (XY) → renvoyé tel quel (cas normal, on regarde dans la salle) ;
        2. sinon, si le rayon TRAVERSE la boîte VERS L'AVANT (tExit > 0) → point de SORTIE (le mur le plus LOIN),
           z compris (parois infinies → le point 3D du rayon sur la paroi) ;
        3. sinon, `ground` fourni → ramené au BORD de l'AABB (clamp XY, z conservé) ;
        4. sinon (pas de sol ET pas de traversée utilisable) → null (ne pas bouger le pivot).
      Un tExit ≤ 0 (boîte entièrement DERRIÈRE la caméra, rayon fuyant) n'est PAS une sortie utilisable → on retombe
      sur la règle 3/4 (clamp du sol au bord, ou null) — jamais de pivot placé derrière la caméra. */
  static clampPivot(origin: PivotVec, dir: PivotVec, ground: PivotVec | null, aabb: PivotAabb | null): PivotVec | null {
    if (!aabb) return ground;   // aucune salle → aucun bornage (comportement historique : sol infini)
    if (ground && PivotBounds.inAabbXY(ground, aabb)) return ground;
    const t = PivotBounds.slabExitT(origin, dir, aabb);
    if (t != null && t > 0) return { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
    if (ground) return { x: PivotBounds.clamp(ground.x, aabb.minX, aabb.maxX), y: PivotBounds.clamp(ground.y, aabb.minY, aabb.maxY), z: ground.z };
    return null;
  }
}
