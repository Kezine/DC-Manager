/* =============================================================================
   ALIGNEMENT DYNAMIQUE d'un port sur une face (« guides intelligents ») — géométrie
   PURE (sans DOM, ni vue, ni store → testable en isolation). Remplace l'ancienne
   mécanique de grille de l'éditeur de façade : au lieu de contraindre à un quadrillage
   fixe, on AIMANTE le port déplacé sur les autres ports déjà posés, selon deux règles
   indépendantes par axe :

     • ALIGNEMENT EXACT (guideX / guideY) : le port se cale sur le MÊME x (resp. y)
       qu'un autre port — un trait vertical (resp. horizontal) matérialise l'accroche.
     • ESPACEMENT RÉGULIER (gapX / gapY) : le port se cale pour reproduire un ÉCART
       déjà présent entre deux ports d'une même rangée/colonne (extension d'une paire
       adjacente, ou milieu d'une paire qui encadre le curseur).

   POURQUOI cette classe reçoit des tolérances PAR AXE en unités NORMALISÉES (0..1) et
   non en pixels : l'appelant (FaceEditor) travaille en coordonnées normalisées mais
   veut une accroche à distance d'écran CONSTANTE (SNAP_PX). Comme le stage est zoomé
   et que les faces n'ont pas toutes le même ratio, la conversion px→normalisé diffère
   selon l'axe et selon le zoom : `tolX = SNAP_PX / rect.width`, `tolY = SNAP_PX /
   rect.height`, recalculées à chaque déplacement. La géométrie reste ainsi ignorante
   de l'écran, tout en offrant un ressenti d'aimantation uniforme.

   PRIORITÉ : l'alignement exact PRIME sur l'espacement, axe par axe — si le port
   s'aligne déjà en x sur un autre port, on ne tente pas d'espacement en x (mais
   l'espacement en y reste possible). Les DEUX axes sont indépendants et peuvent
   accrocher simultanément (alignement en y + espacement en x, par exemple).

   REGROUPEMENT par ÉGALITÉ (EPS) et non par tolérance : une fois une valeur de
   référence RETENUE (la plus proche du curseur sous tolérance), les ports « partageant
   cette valeur » sont ceux qui l'ont EXACTEMENT (après aimantation, des ports alignés
   ont une valeur identique). C'est parmi eux qu'on choisit le port de référence qui
   « trace » le guide : le PLUS PROCHE du curseur sur l'axe perpendiculaire.
   ============================================================================= */

/** Port de référence (déjà posé) : identifiant + position normalisée 0..1 sur la face. */
export interface FaceAlignRef { id: string; x: number; y: number }
/** Point normalisé 0..1 (extrémité de segment de guide). */
export interface FacePoint { x: number; y: number }
/** Accroche d'ALIGNEMENT horizontal (même y) : valeur retenue + port qui trace le trait. */
export interface FaceGuideY { y: number; ref: FaceAlignRef }
/** Accroche d'ALIGNEMENT vertical (même x) : valeur retenue + port qui trace le trait. */
export interface FaceGuideX { x: number; ref: FaceAlignRef }
/** Segment d'écart ÉGAL à matérialiser (de `from` à `to`, en coordonnées normalisées). */
export interface FaceGapSeg { from: FacePoint; to: FacePoint }
/** Accroche d'ESPACEMENT sur l'axe X : x calé + segments d'écart égal (paire de référence + écart créé). */
export interface FaceGapX { x: number; pairs: FaceGapSeg[] }
/** Accroche d'ESPACEMENT sur l'axe Y : y calé + segments d'écart égal. */
export interface FaceGapY { y: number; pairs: FaceGapSeg[] }
/** Résultat complet : position calée (x, y clampés 0..1) + les accroches détectées (null si aucune). */
export interface FaceAlignResult {
  x: number;
  y: number;
  guideY: FaceGuideY | null;
  guideX: FaceGuideX | null;
  gapX: FaceGapX | null;
  gapY: FaceGapY | null;
}

export class FaceAlign {
  /** Égalité « même valeur » : les ports alignés partagent une valeur identique — on regroupe donc à
      EPS près (float), PAS à la tolérance d'accroche (qui, elle, sert à décider s'il faut aimanter). */
  private static readonly EPS = 1e-6;

  private static clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /** Résout la position aimantée d'un point déplacé au regard des autres ports de LA MÊME face.
      `others` NE contient PAS le port déplacé (l'appelant l'exclut). `tolX`/`tolY` = tolérances
      d'accroche en unités normalisées (converties depuis des pixels d'écran par l'appelant, cf.
      doc de classe). Les deux axes sont traités indépendamment. */
  static resolve(pt: FacePoint, others: FaceAlignRef[], tolX: number, tolY: number): FaceAlignResult {
    // --- ALIGNEMENT EXACT (indépendant par axe) ---
    const aY = FaceAlign.alignAxis(pt.y, pt.x, others, tolY, (o) => o.y, (o) => o.x);
    const aX = FaceAlign.alignAxis(pt.x, pt.y, others, tolX, (o) => o.x, (o) => o.y);
    const guideY: FaceGuideY | null = aY ? { y: aY.value, ref: aY.ref } : null;
    const guideX: FaceGuideX | null = aX ? { x: aX.value, ref: aX.ref } : null;

    // Rangée (pour l'espacement en X) = ports partageant le y CALÉ ; colonne (espacement en Y) = ports
    // partageant le x CALÉ. Le « calé » vient de l'alignement (ou du point brut si pas d'alignement).
    const rowY = guideY ? guideY.y : pt.y;
    const colX = guideX ? guideX.x : pt.x;

    // --- ESPACEMENT RÉGULIER : l'alignement exact PRIME → on ne tente l'espacement d'un axe que si
    // cet axe n'a pas déjà accroché en alignement. ---
    let gapX: FaceGapX | null = null;
    if (!guideX) {
      const rowXs = others.filter((o) => Math.abs(o.y - rowY) <= FaceAlign.EPS).map((o) => o.x);
      const sp = FaceAlign.spacing1D(pt.x, rowXs, tolX);
      if (sp) gapX = { x: sp.value, pairs: sp.segments.map(([a, b]) => ({ from: { x: a, y: rowY }, to: { x: b, y: rowY } })) };
    }
    let gapY: FaceGapY | null = null;
    if (!guideY) {
      const colYs = others.filter((o) => Math.abs(o.x - colX) <= FaceAlign.EPS).map((o) => o.y);
      const sp = FaceAlign.spacing1D(pt.y, colYs, tolY);
      if (sp) gapY = { y: sp.value, pairs: sp.segments.map(([a, b]) => ({ from: { x: colX, y: a }, to: { x: colX, y: b } })) };
    }

    const x = FaceAlign.clamp01(guideX ? guideX.x : gapX ? gapX.x : pt.x);
    const y = FaceAlign.clamp01(guideY ? guideY.y : gapY ? gapY.y : pt.y);
    return { x, y, guideY, guideX, gapX, gapY };
  }

  /** Alignement exact sur un axe : trouve la valeur de référence la plus PROCHE du curseur (sous
      tolérance) sur l'axe `valOf`, puis, parmi les ports partageant EXACTEMENT cette valeur, retient
      celui le plus proche du curseur sur l'axe perpendiculaire `perpOf` (c'est lui qui trace le guide). */
  private static alignAxis(
    targetVal: number, targetPerp: number,
    others: FaceAlignRef[], tol: number,
    valOf: (r: FaceAlignRef) => number, perpOf: (r: FaceAlignRef) => number,
  ): { value: number; ref: FaceAlignRef } | null {
    // valeur la plus proche sous tolérance (`<` strict → le premier rencontré gagne en cas d'égalité)
    let best: FaceAlignRef | null = null, bestD = Infinity;
    for (const o of others) {
      const d = Math.abs(valOf(o) - targetVal);
      if (d <= tol && d < bestD) { best = o; bestD = d; }
    }
    if (!best) return null;
    const retained = valOf(best);
    // port de référence = le plus proche du curseur (⊥) PARMI ceux qui partagent la valeur retenue.
    let ref: FaceAlignRef = best, refD = Math.abs(perpOf(best) - targetPerp);
    for (const o of others) {
      if (Math.abs(valOf(o) - retained) > FaceAlign.EPS) continue;
      const d = Math.abs(perpOf(o) - targetPerp);
      if (d < refD) { ref = o; refD = d; }
    }
    return { value: retained, ref };
  }

  /** Espacement régulier 1D : parmi des coordonnées (rangée/colonne triée), propose des candidats de
      position reproduisant un écart déjà présent — EXTENSION d'une paire adjacente (à gauche/droite) et
      MILIEU d'une paire qui encadre le curseur. Retient le candidat le plus proche du curseur sous
      tolérance, avec les segments d'écart égal à matérialiser (paire de référence + écart créé). */
  private static spacing1D(target: number, coords: number[], tol: number): { value: number; segments: [number, number][] } | null {
    if (coords.length < 2) return null;   // il faut au moins une PAIRE pour définir un écart
    const sorted = coords.slice().sort((a, b) => a - b);
    type Cand = { value: number; segments: [number, number][] };
    let best: Cand | null = null, bestD = Infinity;
    const consider = (c: Cand) => { const d = Math.abs(c.value - target); if (d <= tol && d < bestD) { best = c; bestD = d; } };
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1], gap = b - a;
      if (gap <= FaceAlign.EPS) continue;   // paire dégénérée (ports superposés) : aucun pas exploitable
      // EXTENSION à droite (nouveau port après b) : réf = [a,b], écart créé = [b, b+gap].
      consider({ value: b + gap, segments: [[a, b], [b, b + gap]] });
      // EXTENSION à gauche (nouveau port avant a) : écart créé = [a-gap, a], réf = [a,b].
      consider({ value: a - gap, segments: [[a - gap, a], [a, b]] });
      // MILIEU (curseur ENCADRÉ par la paire) : le port scinde [a,b] en deux écarts égaux.
      if (target >= a && target <= b) { const mid = (a + b) / 2; consider({ value: mid, segments: [[a, mid], [mid, b]] }); }
    }
    return best;
  }
}
