import { EQUIP_FREE_DEFAULT_MM } from "../domain/constants";
import { Normalize } from "../core/Normalize";
import { EquipFaces } from "../registries/EquipFaces";
// CONTENEUR SALLE : l'équipement libre lui DÉCLARE son placement ; la composition
// « local équipement → local salle » lui appartient (cf. docs/placement.md §6.1).
import type { ContentPlacement } from "./PlacementFrame";

/** Boîte d'un équipement libre : empreinte w×d, hauteur h, base z. */
export interface FreeBox { w: number; d: number; h: number; z: number; }

/* =============================================================================
   Géométrie « boîte 6 faces » d'un ÉQUIPEMENT LIBRE (dims mm), PURE. Partagée par
   le rendu 3D (boîte + connecteur) et resolvePort3D → port et câble coïncident
   exactement. Paramétrée par le centre (cx,cy) et la base z0.

   CONVENTION D'ORIENTATION DES FACES (fx, fy) — dite « PHOTOGRAPHIQUE »
   ---------------------------------------------------------------------------
   Les fractions (fx, fy) repèrent un point sur une face : fx=0 = bord GAUCHE de
   l'image, fy=0 = bord HAUT. Elles servent À LA FOIS au placement des PORTS
   (`faceLocal`) et au plaquage des IMAGES de façade (`faceFraction`, son inverse) :
   les deux DOIVENT donc partager la même convention, sinon l'image ne coïncide plus
   avec les ports posés dessus (c'est tout l'intérêt d'un module unique).

   Le repère retenu est celui de la PRISE DE VUE réelle de l'appareil, la face AVANT
   servant de référence — pour chaque face, on note de quel côté de l'image se trouve
   l'avant du boîtier (−Y en local) :
     • avant / arrière : le HAUT de l'image est le haut du boîtier (+Z).
     • gauche  : la DROITE de l'image est côté avant (on se place à gauche du boîtier,
                 son avant tombe donc à notre droite).
     • droite  : la GAUCHE de l'image est côté avant (symétrique).
     • dessus  : le BAS de l'image est côté avant (on photographie le dessus en gardant
                 l'avant vers soi — le cliché « pose » naturellement sur la face avant).
     • dessous : le HAUT de l'image est côté avant (retourner le boîtier vers soi éloigne
                 son avant → il se retrouve en haut du cliché).
   Les 6 faces sont NON MIROIR : le trièdre (droite de l'image) × (haut de l'image) vaut
   toujours la normale SORTANTE de la face — invariant testé (test-geometry.js).
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
      fy=0 ⇒ haut (z1) pour les faces VERTICALES. Faces HORIZONTALES : fy porte la profondeur, mais
      le bord situé côté face AVANT (−Y) DIFFÈRE entre dessus et dessous — dessus : fy=1 ; dessous :
      fy=0 (convention photographique détaillée en tête de fichier). */
  static faceLocal(eq: any, face: string, fx: number, fy: number, z0: number): { lx: number; ly: number; lz: number } {
    const bx = FreeEquipGeometry.box(eq), hw = bx.w / 2, hd = bx.d / 2;
    let lx, ly, lz;
    switch (EquipFaces.norm(face)) {
      case "rear":   lx = (0.5 - fx) * bx.w; ly = hd;  lz = z0 + (1 - fy) * bx.h; break;
      case "left":   lx = -hw; ly = (0.5 - fx) * bx.d; lz = z0 + (1 - fy) * bx.h; break;
      case "right":  lx = hw;  ly = (fx - 0.5) * bx.d; lz = z0 + (1 - fy) * bx.h; break;
      // dessus : BAS de l'image (fy=1) côté avant (−Y) → fy croît vers l'avant à l'envers, et fx
      // croît vers +X pour garder le trièdre direct (droite × haut = +Z, la normale sortante).
      case "top":    lx = (fx - 0.5) * bx.w; ly = (0.5 - fy) * bx.d; lz = z0 + bx.h; break;
      case "bottom": lx = (fx - 0.5) * bx.w; ly = (fy - 0.5) * bx.d; lz = z0; break;
      default:       lx = (fx - 0.5) * bx.w; ly = -hd; lz = z0 + (1 - fy) * bx.h; break;   // front
    }
    return { lx, ly, lz };
  }

  /** INVERSE de `faceLocal` : fractions (fx, fy) d'un point LOCAL (lx, ly, lz) sur une FACE.
      fx = 0 → bord GAUCHE de la face VUE DE L'EXTÉRIEUR · fy = 0 → HAUT (faces verticales). Faces
      horizontales : cf. la convention photographique en tête de fichier (dessus = bas de l'image côté
      avant, dessous = haut de l'image côté avant). Sert à plaquer les IMAGES DE FAÇADE sur la boîte 3D
      avec la MÊME convention que les ports (les UVs de BoxGeometry supposent un monde Y-up ; ici Z-up →
      rear/top/bottom sortaient à 180°, left/right à ±90°). Testé en aller-retour avec faceLocal. */
  static faceFraction(eq: any, face: string, lx: number, ly: number, lz: number, z0: number): { fx: number; fy: number } {
    return FreeEquipGeometry.faceFractionIn(FreeEquipGeometry.box(eq), face, lx, ly, lz, z0);
  }

  /** Même règle que `faceFraction`, mais sur une BOÎTE donnée plutôt que sur l'enregistrement.
      Ces fractions sont une propriété de la BOÎTE, jamais de l'équipement : les en extraire permet de
      servir les contenus dont les cotes DESSINÉES ne sont pas les cotes déclarées — un équipement monté
      en MARGE ou en PAROI voit sa largeur ramenée à sa colonne et sa longueur à la cage
      (`RackGeometry.sideEquipBoxLocal`/`wallEquipBoxLocal`). Leur plaquer des UV calculées sur les cotes
      DÉCLARÉES décalerait l'image de la boîte, et donc des ports. */
  static faceFractionIn(bx: FreeBox, face: string, lx: number, ly: number, lz: number, z0: number): { fx: number; fy: number } {
    const fyV = 1 - (lz - z0) / bx.h;   // faces VERTICALES : fy = 0 en HAUT (z1)
    switch (EquipFaces.norm(face)) {
      case "rear":   return { fx: 0.5 - lx / bx.w, fy: fyV };
      case "left":   return { fx: 0.5 - ly / bx.d, fy: fyV };
      case "right":  return { fx: ly / bx.d + 0.5, fy: fyV };
      case "top":    return { fx: lx / bx.w + 0.5, fy: 0.5 - ly / bx.d };
      case "bottom": return { fx: lx / bx.w + 0.5, fy: ly / bx.d + 0.5 };
      default:       return { fx: lx / bx.w + 0.5, fy: fyV };   // front
    }
  }

  /* ---- ce que l'équipement LIBRE donne à son CONTENEUR (la SALLE, cf. `PlacementFrame`) ----

     ⚠ CES TROIS MÉTHODES REMPLACENT `portWorldC` / `portWorld` / `portNormal`, qui annonçaient « monde »
     jusque dans leur NOM alors qu'elles rendaient du LOCAL SALLE — la dette nommée par la doctrine
     (`docs/placement.md` §3 règle 5), éteinte côté `Resolver3D` au lot précédent, éteinte ici. Elles ne
     composent PLUS la rotation ni la translation : un contenu produit son point et sa normale LOCAUX, le
     conteneur les amène au repère de la salle (§6.1). Le repère de SORTIE de la résolution, lui, ne change
     pas d'un micron : c'est toujours du local salle. */

  /** Point LOCAL du port (origine au centre de l'empreinte de l'équipement, +X à sa droite vue de face,
      −Y vers sa façade). Les fractions de face absentes valent le CENTRE de la face.
      ⚠ Z est mesuré depuis le SOL DE LA SALLE (il part de `dc_z`), comme les boîtes locales de baie : le
      lacet ne touchant jamais Z, le conteneur le recopie tel quel. */
  static portLocal(eq: any, port: any): { x: number; y: number; z: number } {
    const bx = FreeEquipGeometry.box(eq);
    const fx = (port.face_x != null) ? port.face_x : 0.5, fy = (port.face_y != null) ? port.face_y : 0.5;
    const { lx, ly, lz } = FreeEquipGeometry.faceLocal(eq, port.face_side, fx, fy, bx.z);
    return { x: lx, y: ly, z: lz };
  }

  /** Normale sortante unitaire d'une FACE, dans le repère LOCAL de l'équipement — donc AVANT tout lacet.
      Dessus/dessous portent une normale VERTICALE, que le lacet laisse inchangée. */
  static faceNormalLocal(face: string): { x: number; y: number; z: number } {
    switch (EquipFaces.norm(face)) {
      case "rear": return { x: 0, y: 1, z: 0 };
      case "left": return { x: -1, y: 0, z: 0 };
      case "right": return { x: 1, y: 0, z: 0 };
      case "top": return { x: 0, y: 0, z: 1 };
      case "bottom": return { x: 0, y: 0, z: -1 };
      default: return { x: 0, y: -1, z: 0 };   // front
    }
  }

  /** Lecture du placement de l'équipement LIBRE dans sa salle, à donner à son CONTENEUR — la SALLE, dont
      `PlacementFrame` compose le repère : la seule chose que le conteneur ait besoin de savoir de lui
      (doctrine §6.2). Le nom des champs est
      PROPRE à l'équipement (`dc_orientation`, `free_w_mm`/`free_l_mm`) — d'où cette lecture ici.
      ⚠ La demi-empreinte de repli n'est PAS permutée par le lacet (contrairement à `halfExtents`) : c'est
      la convention du dessin (`DcViews2D.equipNode`), qui pose un équipement sans position à `w/2`, `d/2`
      quelle que soit son orientation. */
  static roomPlacement(eq: any): ContentPlacement {
    const bx = FreeEquipGeometry.box(eq);
    return {
      x: (eq.dc_x != null) ? eq.dc_x : null,
      y: (eq.dc_y != null) ? eq.dc_y : null,
      yawDeg: eq.dc_orientation,
      halfW: bx.w / 2,
      halfD: bx.d / 2,
    };
  }
}
