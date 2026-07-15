import { ScreenPoint } from "./Projection";

/* Indices des 4 coins de chacune des 6 faces d'un pavé, dans l'ordre canonique
   des 8 coins projetés :
     0:(x0,y0,z0) 1:(x1,y0,z0) 2:(x1,y1,z0) 3:(x0,y1,z0)   (plancher z0)
     4:(x0,y0,z1) 5:(x1,y0,z1) 6:(x1,y1,z1) 7:(x0,y1,z1)   (plafond z1)
   Faces : [0] dessous · [1] dessus · [2] avant(y0) · [3] arrière(y1) · [4] gauche(x0) · [5] droite(x1). */
const BOX6_FACE_IDX = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]];

/** Face d'une boîte : ses 4 coins, la profondeur de son centroïde (`cd`), et toute
    métadonnée fusionnée (opacité `o`, `plane`, …). */
export interface BoxFace {
  pts: ScreenPoint[];
  cd: number;
  [meta: string]: any;
}

/** Boîte 3D « 6 faces » — cœur géométrique PUR du rendu des pavés pleins. */
export class Box {
  /** À partir des 8 coins PROJETÉS `C` (ordre canonique), produit les 6 faces quad
      TRIÉES du plus LOINTAIN au plus PROCHE (peintre). `meta` (optionnel) = 6
      descripteurs (ordre des faces canoniques) fusionnés dans chaque face. */
  static faces(C: ScreenPoint[], meta?: Array<Record<string, any>> | null): BoxFace[] {
    return BOX6_FACE_IDX.map((idx, i) => {
      const pts = idx.map((k) => C[k]);
      return Object.assign({}, meta ? meta[i] : null, { pts, cd: pts.reduce((s, p) => s + p.depth, 0) / 4 });
    }).sort((a, b) => b.cd - a.cd);
  }
}
