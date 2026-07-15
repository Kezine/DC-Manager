/* =============================================================================
   Géométrie PURE des PORTES de salle (sans DOM/store/vue). À partir d'une porte
   (`DcDoor`) et des dimensions de la salle, calcule tout ce qu'il faut pour dessiner :
   ouverture dans le mur, listel (cadre), PASSAGE LIBRE (= largeur max d'équipement),
   vantail et débattement (arc), en coordonnées MONDE de la salle (mm).

   Repère : salle = rectangle [0,0]→[w,h], x = largeur, y = profondeur.
   Murs : top (y=0) · bottom (y=h) · left (x=0) · right (x=w). Normale INTÉRIEURE = vers
   l'intérieur de la salle.

   Convention de CHARNIÈRE : le côté (left/right) est défini depuis le côté d'OUVERTURE.
   Observateur placé du côté où la porte s'ouvre (`opening`), regardant le mur : la
   charnière est à sa gauche (`hinge:"left"`) ou à sa droite. Le `swing` (sens de
   balayage du vantail) va vers l'intérieur si `opening:"interior"`, sinon vers l'extérieur.
   ============================================================================= */

export interface DoorPt { x: number; y: number }
/** Dimensions de la salle (cadre). */
export interface DoorRoom { w: number; h: number }
/** Forme minimale d'une porte consommée ici (cf. DcDoor). `leaves` optionnel (1 par défaut, 2 = double battant). */
export interface DoorLike { wall: "left" | "right" | "top" | "bottom"; offset: number; width_mm: number; frame_mm: number; hinge: "left" | "right"; leaves?: number; opening: "interior" | "exterior" }

/** UN vantail (géométrie propre) : sa charnière, son loquet (extrémité libre, fermée) et son extrémité OUVERTE à 90°. */
export interface DoorLeafGeom { hinge: DoorPt; latch: DoorPt; open: DoorPt; }

/** Géométrie calculée d'une porte (coords monde salle). */
export interface DoorGeom {
  a: DoorPt; b: DoorPt;              // extrémités de l'OUVERTURE le long du mur (a = côté « début » du mur)
  hinge: DoorPt; latch: DoorPt;      // extrémités : côté CHARNIÈRE / côté ouverture (loquet)
  clearHinge: DoorPt; clearLatch: DoorPt;  // extrémités du PASSAGE LIBRE (ouverture − listel), côté charnière / loquet
  swing: DoorPt;                     // normale unitaire : sens d'ouverture (vers où balaie le vantail)
  wallDir: DoorPt;                   // unitaire charnière → loquet (le long du mur)
  clear: number;                     // largeur de PASSAGE LIBRE (mm) = width − 2·frame → largeur max d'équipement
  leafOpen: DoorPt;                  // extrémité du vantail OUVERT à 90° (depuis clearHinge, le long de `swing`)
}

export class DoorGeometry {
  /** Longueur du mur portant la porte (largeur pour top/bottom, profondeur pour left/right). */
  static wallLen(wall: string, room: DoorRoom): number { return (wall === "left" || wall === "right") ? room.h : room.w; }

  /** Offset (centre le long du mur) borné pour que l'ouverture tienne entièrement dans le mur. */
  static clampOffset(door: DoorLike, room: DoorRoom): number {
    const L = DoorGeometry.wallLen(door.wall, room), hw = door.width_mm / 2;
    return Math.min(Math.max(door.offset, hw), Math.max(hw, L - hw));
  }

  static geom(door: DoorLike, room: DoorRoom): DoorGeom {
    const off = DoorGeometry.clampOffset(door, room), hw = door.width_mm / 2;
    // point sur le mur en fonction de la coord le long du mur `t`, direction du mur, normale INTÉRIEURE
    let P: (t: number) => DoorPt, nIn: DoorPt;
    switch (door.wall) {
      case "bottom": P = (t) => ({ x: t, y: room.h }); nIn = { x: 0, y: -1 }; break;
      case "left":   P = (t) => ({ x: 0, y: t });      nIn = { x: 1, y: 0 }; break;
      case "right":  P = (t) => ({ x: room.w, y: t }); nIn = { x: -1, y: 0 }; break;
      default:       P = (t) => ({ x: t, y: 0 });      nIn = { x: 0, y: 1 }; break;   // top
    }
    const a = P(off - hw), b = P(off + hw), center = P(off);
    const swing: DoorPt = (door.opening === "exterior") ? { x: -nIn.x, y: -nIn.y } : { x: nIn.x, y: nIn.y };
    // CHARNIÈRE : extrémité du côté GAUCHE de l'observateur placé côté ouverture, regardant le mur (faces = −swing).
    const faces = { x: -swing.x, y: -swing.y };
    const leftDir = { x: -faces.y, y: faces.x };   // rotation +90° (repère standard) → « gauche » de l'observateur
    const bIsLeft = (b.x - center.x) * leftDir.x + (b.y - center.y) * leftDir.y > 0;
    const leftEnd = bIsLeft ? b : a, rightEnd = bIsLeft ? a : b;
    const hinge = (door.hinge === "left") ? leftEnd : rightEnd;
    const latch = (door.hinge === "left") ? rightEnd : leftEnd;
    // passage libre (inset du listel de chaque côté). Le listel est borné à [0, demi-largeur] UNE fois et réutilisé
    // partout : sinon un `frame_mm` négatif inverserait l'inset, et un `frame_mm > width/2` ferait se CROISER les
    // extrémités du passage (clearLatch avant clearHinge) → vantail/arc incohérents. Borné → `clear` reste ≥ 0.
    const frame = Math.min(Math.max(0, door.frame_mm), hw);
    const clear = door.width_mm - 2 * frame;
    const dx = latch.x - hinge.x, dy = latch.y - hinge.y, len = Math.hypot(dx, dy) || 1;
    const u: DoorPt = { x: dx / len, y: dy / len };   // charnière → loquet, le long du mur
    const clearHinge: DoorPt = { x: hinge.x + u.x * frame, y: hinge.y + u.y * frame };
    const clearLatch: DoorPt = { x: latch.x - u.x * frame, y: latch.y - u.y * frame };
    const leafOpen: DoorPt = { x: clearHinge.x + swing.x * clear, y: clearHinge.y + swing.y * clear };
    return { a, b, hinge, latch, clearHinge, clearLatch, swing, wallDir: u, clear, leafOpen };
  }

  /** VANTAUX de la porte (1 ou 2). Simple : un vantail sur tout le passage libre (charnière → loquet).
      DOUBLE BATTANT : deux demi-vantaux — charnières aux DEUX extrémités du passage, loquets se rejoignant
      au CENTRE, chacun balayant `clear/2`. Le champ `hinge` est alors sans effet (symétrique). */
  static leaves(g: DoorGeom, door: { leaves?: number }): DoorLeafGeom[] {
    if (((door.leaves ?? 1) | 0) !== 2) return [{ hinge: g.clearHinge, latch: g.clearLatch, open: g.leafOpen }];
    const mid: DoorPt = { x: (g.clearHinge.x + g.clearLatch.x) / 2, y: (g.clearHinge.y + g.clearLatch.y) / 2 };
    const half = g.clear / 2;
    return [
      { hinge: g.clearHinge, latch: mid, open: { x: g.clearHinge.x + g.swing.x * half, y: g.clearHinge.y + g.swing.y * half } },
      { hinge: g.clearLatch, latch: mid, open: { x: g.clearLatch.x + g.swing.x * half, y: g.clearLatch.y + g.swing.y * half } },
    ];
  }

  /** Points échantillonnés de l'ARC de débattement d'UN vantail (fermé → ouvert 90°), centrés sur sa charnière,
      rayon = |latch − hinge|. Le sens de rotation est déduit (fermé → côté ouvert). */
  static leafArc(leaf: DoorLeafGeom, n = 14): DoorPt[] {
    const p = leaf.hinge;
    const v0 = { x: leaf.latch.x - p.x, y: leaf.latch.y - p.y };   // vantail FERMÉ (le long du mur)
    const tgt = { x: leaf.open.x - p.x, y: leaf.open.y - p.y };    // vantail OUVERT (le long de swing)
    const sign = (v0.x * tgt.y - v0.y * tgt.x) >= 0 ? 1 : -1;      // sens de rotation fermé → ouvert
    const pts: DoorPt[] = [];
    for (let i = 0; i <= n; i++) {
      const ang = sign * (Math.PI / 2) * (i / n), c = Math.cos(ang), s = Math.sin(ang);
      pts.push({ x: p.x + v0.x * c - v0.y * s, y: p.y + v0.x * s + v0.y * c });
    }
    return pts;
  }

}
