import { EQUIP_FREE_DEFAULT_MM } from "../domain/constants";
import { Normalize } from "../core/Normalize";
import { EquipFaces } from "../registries/EquipFaces";

/** Boîte d'un équipement libre : empreinte w×d, hauteur h, base z. */
export interface FreeBox { w: number; d: number; h: number; z: number; }

/* =============================================================================
   Géométrie « boîte 6 faces » d'un ÉQUIPEMENT LIBRE (dims mm), PURE. Partagée par
   le rendu 3D (boîte + connecteur) et resolvePort3D → port et câble coïncident
   exactement. Paramétrée par le centre (cx,cy) et la base z0.
   ============================================================================= */
export class FreeEquipGeometry {
  /** Empreinte (X) × longueur (Y) × hauteur (Z) + base z, défauts inclus. */
  static box(e: any): FreeBox {
    return {
      w: e.free_w_mm || EQUIP_FREE_DEFAULT_MM,
      d: e.free_l_mm || EQUIP_FREE_DEFAULT_MM,
      h: e.free_h_mm || EQUIP_FREE_DEFAULT_MM,
      z: e.dc_z || 0,
    };
  }

  /** Demi-emprise au sol selon la rotation (w/d permutés à 90/270). */
  static halfExtents(e: any): { hx: number; hy: number } {
    const b = FreeEquipGeometry.box(e), o = Normalize.rackOrientation(e.dc_orientation);
    return (o === 90 || o === 270) ? { hx: b.d / 2, hy: b.w / 2 } : { hx: b.w / 2, hy: b.d / 2 };
  }

  /** Dimensions (W × H, mm) d'une FACE pour l'aspect-ratio des aperçus/éditeurs : avant/arrière = largeur × hauteur,
      gauche/droite = profondeur × hauteur, dessus/dessous = largeur × profondeur. (≥ 1 pour éviter un ratio nul.) */
  static faceWH(e: any, face: string): { W: number; H: number } {
    const b = FreeEquipGeometry.box(e), w = Math.max(1, b.w), d = Math.max(1, b.d), h = Math.max(1, b.h);
    const f = EquipFaces.norm(face);
    if (f === "left" || f === "right") return { W: d, H: h };
    if (f === "top" || f === "bottom") return { W: w, H: d };
    return { W: w, H: h };   // front / rear (et défaut)
  }

  /** Point LOCAL (origine au centre de l'empreinte, base z0) d'un point (fx,fy) d'une FACE.
      fy=0 ⇒ haut (z1) pour les faces verticales ; dessus/dessous : fy = profondeur (0 = avant −Y). */
  static faceLocal(eq: any, face: string, fx: number, fy: number, z0: number): { lx: number; ly: number; lz: number } {
    const bx = FreeEquipGeometry.box(eq), hw = bx.w / 2, hd = bx.d / 2;
    let lx, ly, lz;
    switch (EquipFaces.norm(face)) {
      case "rear":   lx = (0.5 - fx) * bx.w; ly = hd;  lz = z0 + (1 - fy) * bx.h; break;
      case "left":   lx = -hw; ly = (0.5 - fx) * bx.d; lz = z0 + (1 - fy) * bx.h; break;
      case "right":  lx = hw;  ly = (fx - 0.5) * bx.d; lz = z0 + (1 - fy) * bx.h; break;
      case "top":    lx = (0.5 - fx) * bx.w; ly = (fy - 0.5) * bx.d; lz = z0 + bx.h; break;
      case "bottom": lx = (fx - 0.5) * bx.w; ly = (fy - 0.5) * bx.d; lz = z0; break;
      default:       lx = (fx - 0.5) * bx.w; ly = -hd; lz = z0 + (1 - fy) * bx.h; break;   // front
    }
    return { lx, ly, lz };
  }

  /** INVERSE de `faceLocal` : fractions (fx, fy) d'un point LOCAL (lx, ly, lz) sur une FACE.
      fx = 0 → bord GAUCHE de la face VUE DE L'EXTÉRIEUR · fy = 0 → HAUT (faces verticales) ou AVANT −Y
      (dessus/dessous). Sert à plaquer les IMAGES DE FAÇADE sur la boîte 3D avec la MÊME convention que les
      ports (les UVs de BoxGeometry supposent un monde Y-up ; ici Z-up → rear/top/bottom sortaient à 180°,
      left/right à ±90°). Testé en aller-retour avec faceLocal. */
  static faceFraction(eq: any, face: string, lx: number, ly: number, lz: number, z0: number): { fx: number; fy: number } {
    const bx = FreeEquipGeometry.box(eq);
    const fyV = 1 - (lz - z0) / bx.h;   // faces VERTICALES : fy = 0 en HAUT (z1)
    switch (EquipFaces.norm(face)) {
      case "rear":   return { fx: 0.5 - lx / bx.w, fy: fyV };
      case "left":   return { fx: 0.5 - ly / bx.d, fy: fyV };
      case "right":  return { fx: ly / bx.d + 0.5, fy: fyV };
      case "top":    return { fx: 0.5 - lx / bx.w, fy: ly / bx.d + 0.5 };
      case "bottom": return { fx: lx / bx.w + 0.5, fy: ly / bx.d + 0.5 };
      default:       return { fx: lx / bx.w + 0.5, fy: fyV };   // front
    }
  }

  /** Point MONDE d'un port, paramétré par le centre (cx,cy) et la base z0. */
  static portWorldC(eq: any, port: any, cx: number, cy: number, z0: number): { x: number; y: number; z: number } {
    const o = Normalize.rackOrientation(eq.dc_orientation) * Math.PI / 180, co = Math.cos(o), so = Math.sin(o);
    const fx = (port.face_x != null) ? port.face_x : 0.5, fy = (port.face_y != null) ? port.face_y : 0.5;
    const { lx, ly, lz } = FreeEquipGeometry.faceLocal(eq, port.face_side, fx, fy, z0);
    return { x: cx + lx * co - ly * so, y: cy + lx * so + ly * co, z: lz };
  }

  /** Point MONDE d'un port d'un équipement libre posé en salle (centre = dc_x/dc_y). */
  static portWorld(eq: any, port: any): { x: number; y: number; z: number } {
    const bx = FreeEquipGeometry.box(eq);
    const cx = (eq.dc_x != null) ? eq.dc_x : bx.w / 2, cy = (eq.dc_y != null) ? eq.dc_y : bx.d / 2;
    return FreeEquipGeometry.portWorldC(eq, port, cx, cy, bx.z);
  }

  /** Normale sortante unitaire (monde) de la face d'un port, tournée par dc_orientation. */
  static portNormal(eq: any, port: any): { x: number; y: number; z: number } {
    const of = Normalize.rackOrientation(eq.dc_orientation) * Math.PI / 180, cf = Math.cos(of), sf = Math.sin(of);
    let nx = 0, ny = 0, nz = 0;
    switch (EquipFaces.norm(port.face_side)) {
      case "rear": ny = 1; break;
      case "left": nx = -1; break;
      case "right": nx = 1; break;
      case "top": nz = 1; break;
      case "bottom": nz = -1; break;
      default: ny = -1; break;   // front
    }
    return { x: nx * cf - ny * sf, y: nx * sf + ny * cf, z: nz };
  }
}
