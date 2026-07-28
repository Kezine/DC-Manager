/* =============================================================================
   PivotBounds — bornage du PIVOT D'ORBITE de la caméra 3D à la BOÎTE du repère
   regardé. GÉOMÉTRIE PURE (aucun THREE, aucun DOM) → testable en Node.
   ----------------------------------------------------------------------------
   POURQUOI. `DcThreeCamera.recenterPivotOnView()` pose le pivot d'orbite sur le
   point de scène au CENTRE de l'écran : première surface touchée, SINON repli sur
   le plan du sol INFINI (z = 0). Sous un angle RASANT, ce repli tombe très loin
   HORS du monde regardé → le pivot part à l'autre bout et la rotation devient
   démesurée (on tourne autour du vide).

   QUELLE BOÎTE ? C'est une question de REPÈRE, jamais de PORTÉE — donc jamais un
   comptage d'éléments (docs/placement.md §3 règle 2, §6.8, §6.21) :
     - repère SALLE (aucun décor d'étage poussé) → l'union des salles affichées,
       en XY SEUL (`unionAabb`) ;
     - repère BÂTIMENT (« Vue étage ») → les BANDES DE BÂTIMENT et la hauteur du
       monde, donc une VRAIE boîte 3D (`worldBounds`).

   RÈGLES DE BORNAGE (cf. `clampPivot`) — on ne borne QUE ce repli, le contenu
   réellement touché par le raycast restant prioritaire et inchangé :
     - point de sol DANS la boîte → on le garde tel quel ;
     - point de sol HORS de la boîte, mais le rayon TRAVERSE la boîte → le pivot
       devient le point de SORTIE du rayon (la paroi la plus LOIN de la caméra) ;
     - le rayon ne traverse jamais la boîte → point de sol RAMENÉ au bord (clamp) ;
     - aucun point de sol ET pas de traversée → on ne bouge pas le pivot (null).

   LE PLAN z = 0 EST RÉTROGRADÉ. Il n'est plus qu'une ENTRÉE de dernier recours,
   elle-même ramenée dans la boîte : dès que le bornage porte aussi sur Z, la sortie
   du rayon tombe d'elle-même à une hauteur du monde (paroi latérale, plafond ou
   plancher) au lieu de plonger arbitrairement loin sous le niveau regardé. Sans
   bornage en Z, ce même point de sortie pouvait sortir très au-dessus ou très en
   dessous du monde — il n'était borné qu'en XY.

   CONVENTION DE PLACEMENT (à répliquer FIDÈLEMENT depuis la scène) : une salle est
   posée par `DcThreeScene.roomUnder` = groupe externe (position (ox,oy,oz),
   rotation z = o) contenant un groupe interne translaté de (−w/2, −d/2). Un coin
   local (0/w, 0/d) devient donc, en monde XY : (ox,oy) + Rz(o)·(±w/2, ±d/2) — d'où
   `rectCorners`.
   ============================================================================= */

/** Point (repère MONDE). */
export interface PivotVec { x: number; y: number; z: number; }
/** Boîte englobante alignée aux axes (repère MONDE). Le bornage en Z est OPTIONNEL, et son ABSENCE a un
    sens PRÉCIS : « parois verticales INFINIMENT hautes » — la boîte ne contraint alors que X et Y, et le z
    d'un point est simplement TRANSPORTÉ. C'est ce que rend `unionAabb` (bornage à la salle), dont le
    comportement historique est ainsi conservé au micron ; `worldBounds` (Vue étage) borne les TROIS axes. */
export interface PivotAabb { minX: number; maxX: number; minY: number; maxY: number; minZ?: number; maxZ?: number; }

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

  /** AABB (XY SEUL, parois infinies en Z) de l'UNION de plusieurs rectangles (coins monde). null si aucun
      rectangle (aucune salle affichée). C'est le bornage du repère SALLE : la hauteur n'y est pas contrainte,
      parce qu'une salle n'a pas de plafond dans la scène et que son sol EST le plan z = 0 du repli. */
  static unionAabb(rects: Array<Array<{ x: number; y: number }>>): PivotAabb | null {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const corners of rects) for (const p of corners) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
  }

  /** BORNES MONDE du repère BÂTIMENT (« Vue étage ») : union des BANDES DE BÂTIMENT en XY — l'emprise
      DÉCLARÉE du site quand elle existe, sinon celle déduite de ses plans d'étage (cf. `FloorLayout.multiLayout`
      et docs/placement.md §6.8) — et hauteur du monde en Z, du sol (0) au sommet du dernier niveau (`topZ`).
      Contrairement à `unionAabb`, elle borne les TROIS axes : le monde d'une Vue étage a un plafond, et sans
      lui le repli du pivot repartait sous le plancher ou au-dessus du bâtiment. null si aucune bande.
      ⚠ Les bandes sont déjà ALIGNÉES AUX AXES (x0/x1/y0/y1) : aucun coin à faire tourner, d'où une seconde
      méthode plutôt qu'un passage forcé par `rectCorners`, qui aurait fabriqué des coins pour rien. */
  static worldBounds(bands: ReadonlyArray<{ x0: number; x1: number; y0: number; y1: number }>, topZ: number): PivotAabb | null {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const b of bands) {
      minX = Math.min(minX, b.x0, b.x1); maxX = Math.max(maxX, b.x0, b.x1);
      minY = Math.min(minY, b.y0, b.y1); maxY = Math.max(maxY, b.y0, b.y1);
    }
    if (!Number.isFinite(minX)) return null;
    // Le sol du monde est z = 0 par construction (`levelZs` démarre à 0) ; `topZ` est le sommet du niveau le
    // plus haut. Le `max` n'est qu'une défense contre un monde vide (topZ ≤ 0) : une boîte inversée en Z
    // n'admettrait plus AUCUN point, donc plus aucun pivot.
    return { minX, maxX, minY, maxY, minZ: 0, maxZ: Math.max(topZ, 0) };
  }

  /** Borne BASSE en Z de la boîte — absente ⇒ paroi infinie vers le bas. */
  private static loZ(aabb: PivotAabb): number { return aabb.minZ == null ? -Infinity : aabb.minZ; }
  /** Borne HAUTE en Z de la boîte — absente ⇒ paroi infinie vers le haut. */
  private static hiZ(aabb: PivotAabb): number { return aabb.maxZ == null ? Infinity : aabb.maxZ; }

  /** Vrai si le point est DANS la boîte (bornes incluses), sur les axes RÉELLEMENT bornés. */
  private static inAabb(p: PivotVec, aabb: PivotAabb): boolean {
    return p.x >= aabb.minX && p.x <= aabb.maxX && p.y >= aabb.minY && p.y <= aabb.maxY
      && p.z >= PivotBounds.loZ(aabb) && p.z <= PivotBounds.hiZ(aabb);
  }

  private static clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** Paramètre `t` du point de SORTIE du rayon (origin + t·dir) hors de la boîte. Méthode du slab sur les TROIS
      axes : tEnter = max des entrées, tExit = min des sorties ; valide si tEnter ≤ tExit. Un axe PARALLÈLE
      (dir ≈ 0) hors des bornes → aucune intersection ; parallèle et dans les bornes → cet axe n'impose aucune
      borne. Un axe NON BORNÉ (Z absent) porte ±Infinity, ce qui le neutralise par le même calcul plutôt que par
      un cas particulier. Peut renvoyer un tExit ≤ 0 (boîte DERRIÈRE la caméra) ou non fini (rayon inscrit dans
      un slab ouvert — typiquement un rayon vertical dans une boîte SANS bornes en Z) : l'appelant tranche. */
  private static slabExitT(origin: PivotVec, dir: PivotVec, aabb: PivotAabb): number | null {
    let tEnter = -Infinity, tExit = Infinity;
    const axes: Array<[number, number, number, number]> = [
      [origin.x, dir.x, aabb.minX, aabb.maxX],
      [origin.y, dir.y, aabb.minY, aabb.maxY],
      [origin.z, dir.z, PivotBounds.loZ(aabb), PivotBounds.hiZ(aabb)],
    ];
    for (const [o, dd, lo, hi] of axes) {
      if (Math.abs(dd) < EPS) { if (o < lo || o > hi) return null; continue; }   // parallèle : dans le slab, ou jamais
      let t1 = (lo - o) / dd, t2 = (hi - o) / dd;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tEnter) tEnter = t1;
      if (t2 < tExit) tExit = t2;
    }
    if (tEnter > tExit) return null;              // n'entre jamais dans la boîte
    return Number.isFinite(tExit) ? tExit : null; // aucune sortie finie (slab ouvert dans la direction du rayon) → null
  }

  /** Pivot BORNÉ pour le repli « sol infini » de la caméra. Règles (cf. en-tête) :
        1. `ground` fourni ET DANS la boîte → renvoyé tel quel (cas normal, on regarde dans le monde) ;
        2. sinon, si le rayon TRAVERSE la boîte VERS L'AVANT (tExit > 0) → point de SORTIE (la paroi la plus
           LOIN — latérale, et aussi plancher/plafond dès que la boîte est bornée en Z) ;
        3. sinon, `ground` fourni → ramené au BORD de la boîte (clamp sur les axes bornés) ;
        4. sinon (pas de sol ET pas de traversée utilisable) → null (ne pas bouger le pivot).
      Un tExit ≤ 0 (boîte entièrement DERRIÈRE la caméra, rayon fuyant) n'est PAS une sortie utilisable → on retombe
      sur la règle 3/4 (clamp du sol au bord, ou null) — jamais de pivot placé derrière la caméra. */
  static clampPivot(origin: PivotVec, dir: PivotVec, ground: PivotVec | null, aabb: PivotAabb | null): PivotVec | null {
    if (!aabb) return ground;   // aucun repère → aucun bornage (comportement historique : sol infini)
    if (ground && PivotBounds.inAabb(ground, aabb)) return ground;
    const t = PivotBounds.slabExitT(origin, dir, aabb);
    if (t != null && t > 0) return { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t };
    if (ground) return {
      x: PivotBounds.clamp(ground.x, aabb.minX, aabb.maxX),
      y: PivotBounds.clamp(ground.y, aabb.minY, aabb.maxY),
      z: PivotBounds.clamp(ground.z, PivotBounds.loZ(aabb), PivotBounds.hiZ(aabb)),
    };
    return null;
  }
}
