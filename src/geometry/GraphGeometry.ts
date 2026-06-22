import { EquipmentTypes } from "../registries/EquipmentTypes";

// icône (x=9, ⌀18) + 7 px de marge avant le texte.
const GNODE_TEXT_X = 9 + 18 + 7;

/** Taille de boîte d'un nœud GraphView. */
export interface NodeSize { w: number; h: number; }
/** Bounding-box d'un ensemble de nœuds. */
export interface BBox { minX: number; minY: number; maxX: number; maxY: number; }

/** Géométrie des nœuds du GraphView — SOURCE UNIQUE (rendu + bbox + recentrage). PUR. */
export class GraphGeometry {
  /** Taille (w,h) de la boîte d'un nœud : largeur = de quoi loger l'icône + le texte
      le plus long (nom OU libellé de type), bornée à 120 px ; hauteur fixe 40. */
  static nodeSize(n: any): NodeSize {
    const chars = Math.max((n.name || "").length, EquipmentTypes.label(n.type).length);
    return { w: Math.max(120, Math.round(chars * 7) + GNODE_TEXT_X + 14), h: 40 };
  }

  /** Bounding-box {minX,minY,maxX,maxY} de nœuds (centre ± demi-taille).
      Largeur via le cache `n._w` sinon `nodeSize` ; demi-hauteur fournie par `halfHOf(n)`. */
  static nodesBBox(nodes: any[], halfHOf: (n: any) => number): BBox {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach((n) => {
      const w = n._w || GraphGeometry.nodeSize(n).w, hh = halfHOf(n);
      minX = Math.min(minX, n.x - w / 2); maxX = Math.max(maxX, n.x + w / 2);
      minY = Math.min(minY, n.y - hh); maxY = Math.max(maxY, n.y + hh);
    });
    return { minX, minY, maxX, maxY };
  }
}
