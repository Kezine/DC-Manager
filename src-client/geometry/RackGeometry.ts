import {
  RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_MOUNT_MARGIN_DEFAULT,
  U_MM, SIDE_U_STEP, SIDE_POST_INSET, WALL_COL_MIN, TRAY_DEPTH_DEFAULT_MM, TRAY_SHEET_RESERVE_MM, TRAY_GUSSET_CLEARANCE_MM, RACK_EAR_MM, RACK_EAR_STANDOFF_MM,
} from "../domain/constants";
import { Normalize } from "../core/Normalize";

/** Demi-extents au sol d'une baie. */
export interface HalfExtents { hx: number; hy: number; }
/** Repère d'une marge murale. */
export interface WallGeo { d: number; hd: number; dep: number; yFace: number; sgnInto: number; cols: number; colW: number; }

/* =============================================================================
   Géométrie de baie PURE (objets simples ; pas de store). Regroupe les helpers
   dimensionnels (marges, cage, hauteur) et la géométrie des emplacements
   side-mount / wall-mount. Les résolutions qui interrogent le store (occupants,
   emplacements libres, ports 3D) vivent dans geometry/RackScene.
   ============================================================================= */
export class RackGeometry {
  /* ---- dimensions de base ---- */

  /** Marge latérale (montants ↔ paroi, mm) ; repli sur mount_margin_mm. */
  static lMargin(rack: any): number {
    const v = (rack.lmargin_mm != null) ? rack.lmargin_mm : ((rack.mount_margin_mm != null) ? rack.mount_margin_mm : RACK_MOUNT_MARGIN_DEFAULT);
    return Math.max(0, v | 0);
  }
  /** Marge de montage du rendu = marge latérale bornée à < moitié de la largeur. */
  static mountMargin(rack: any): number {
    const w = rack.width_mm || RACK_WIDTH_DEFAULT;
    return Math.max(0, Math.min(RackGeometry.lMargin(rack), w / 2 - 20));
  }
  /** Marge verticale HAUTE (mm). */
  static vMarginTop(rack: any): number {
    const v = (rack.vmargin_mm != null) ? rack.vmargin_mm : ((rack.mount_margin_mm != null) ? rack.mount_margin_mm : RACK_MOUNT_MARGIN_DEFAULT);
    return Math.max(0, v | 0);
  }
  /** Marge verticale BASSE (mm) ; repli sur la haute. */
  static vMarginBottom(rack: any): number {
    return (rack.vmargin_bottom_mm != null && rack.vmargin_bottom_mm !== "") ? Math.max(0, rack.vmargin_bottom_mm | 0) : RackGeometry.vMarginTop(rack);
  }
  /** Compat : ancien nom = marge haute. */
  static vMargin(rack: any): number { return RackGeometry.vMarginTop(rack); }
  /** z (mm) de la base du 1er U. */
  static uBaseZ(rack: any): number { return RackGeometry.vMarginBottom(rack); }
  /** Hauteur mini dérivée (mm). */
  static minHeight(rack: any): number { return (rack.u_count || 42) * U_MM + RackGeometry.vMarginTop(rack) + RackGeometry.vMarginBottom(rack); }
  /** Hauteur physique effective (extérieur ≥ mini). */
  static physHeight(rack: any): number { const min = RackGeometry.minHeight(rack); return (rack.height_mm != null && rack.height_mm > min) ? rack.height_mm : min; }
  /** Largeur mini = zone 19″ + 2 marges latérales (mm). */
  static minWidth(rack: any): number { return RACK_MOUNT_WIDTH + 2 * RackGeometry.lMargin(rack); }
  /** Profondeur de cage (montants av↔ar, mm) ; null = profondeur extérieure. */
  static cageDepth(rack: any): number { return (rack.cage_depth_mm != null && rack.cage_depth_mm > 0) ? Math.max(1, rack.cage_depth_mm | 0) : (rack.depth || RACK_DEPTH_DEFAULT); }
  /** Profondeur mini = cage. */
  static minDepth(rack: any): number { return RackGeometry.cageDepth(rack); }
  /** Marge AVANT (façade → montants avant, mm), bornée pour que la cage tienne. */
  static frontMargin(rack: any): number {
    const d = rack.depth || RACK_DEPTH_DEFAULT, cage = Math.min(d, RackGeometry.cageDepth(rack));
    const fm = (rack.front_margin_mm != null && rack.front_margin_mm !== "") ? Math.max(0, rack.front_margin_mm | 0) : 0;
    return Math.min(fm, Math.max(0, d - cage));
  }
  /** Largeur UTILE du corps 19″ (panneau − 2 oreilles standard) — largeur max d'un boîtier racké. */
  static mountBodyWidth(): number { return RACK_MOUNT_WIDTH - 2 * RACK_EAR_MM; }
  /** Largeur RÉELLE du boîtier d'un équipement U : `u_width_mm` (bornée au corps utile), sinon pleine largeur.
      Un boîtier RÉTRÉCI (petit switch…) voit ses oreilles s'étendre des rails jusqu'à ses bords. */
  static eqBodyWidth(eq: any): number {
    const full = RackGeometry.mountBodyWidth();
    const w = eq ? eq.u_width_mm : null;
    return (w != null && w > 0) ? Math.min(w, full) : full;
  }
  /** Décalage X du CENTRE du boîtier (coords locales de baie, mm) selon `u_align` — VU DE FACE : left = −X. */
  static eqBodyOffsetX(eq: any): number {
    const full = RackGeometry.mountBodyWidth(), w = RackGeometry.eqBodyWidth(eq);
    if (w >= full) return 0;
    const a = eq ? eq.u_align : null;
    return a === "left" ? -(full - w) / 2 : (a === "right" ? (full - w) / 2 : 0);
  }
  /** Porte d'une face (avant/arrière). */
  static door(rack: any, face: string): any { return (face === "rear") ? rack.door_rear : rack.door_front; }
  /** Profondeur utile supplémentaire apportée par la cavité d'une porte creuse (0 sinon). */
  static doorExtraDepth(rack: any, face: string): number { const d = RackGeometry.door(rack, face); return (d && d.enabled && d.hollow) ? Math.max(0, d.hollow_mm | 0) : 0; }
  /** Vrai si la baie porte au moins une porte (avant ou arrière) activée. */
  static hasDoor(rack: any): boolean { const f = RackGeometry.door(rack, "front"), r = RackGeometry.door(rack, "rear"); return !!((f && f.enabled) || (r && r.enabled)); }
  /** Profondeur PHYSIQUE disponible pour un montage ancré au plan AVANT (montants en U / brosse) : du plan de
      montage avant jusqu'à la face arrière (`profondeur − marge avant`) + cavités des portes av/ar. Marge de
      sécurité NON retranchée (cf. RACK_DEPTH_SAFETY_MM côté formulaire). */
  static frontMountAvailDepth(rack: any): number {
    const d = rack.depth || RACK_DEPTH_DEFAULT;
    return d - RackGeometry.frontMargin(rack) + RackGeometry.doorExtraDepth(rack, "front") + RackGeometry.doorExtraDepth(rack, "rear");
  }
  /** Marge ARRIÈRE (montants arrière → face arrière, mm) — complément de la cage et de la marge avant. */
  static rearMargin(rack: any): number {
    const d = rack.depth || RACK_DEPTH_DEFAULT, cage = Math.min(d, RackGeometry.cageDepth(rack));
    return Math.max(0, d - cage - RackGeometry.frontMargin(rack));
  }
  /** Profondeur PHYSIQUE disponible pour un montage en U selon sa face d'ANCRAGE (avant/arrière) :
      du plan de montage jusqu'à la face opposée + cavités des portes. Marge de sécurité NON retranchée
      (cf. RACK_DEPTH_SAFETY_MM côté validation, appliquée derrière porte). Répliqué dans
      shared/DataValidation (RackDepth) — parité à maintenir. */
  static mountAvailDepth(rack: any, side: string): number {
    const d = rack.depth || RACK_DEPTH_DEFAULT;
    const extras = RackGeometry.doorExtraDepth(rack, "front") + RackGeometry.doorExtraDepth(rack, "rear");
    return d - (side === "rear" ? RackGeometry.rearMargin(rack) : RackGeometry.frontMargin(rack)) + extras;
  }
  /** Profondeur PARTAGÉE par deux montages DOS À DOS au même U (baie double) : la cage + cavités —
      la somme de leurs profondeurs ne doit pas la dépasser. */
  static sharedMountDepth(rack: any): number {
    const d = rack.depth || RACK_DEPTH_DEFAULT, cage = Math.min(d, RackGeometry.cageDepth(rack));
    return cage + RackGeometry.doorExtraDepth(rack, "front") + RackGeometry.doorExtraDepth(rack, "rear");
  }

  /* ---- au sol ---- */

  /** Demi-extents au sol selon l'orientation (90/270 permutent largeur/profondeur). */
  static halfExtents(rack: any): HalfExtents {
    const w = rack.width_mm || RACK_WIDTH_DEFAULT, d = rack.depth || RACK_DEPTH_DEFAULT;
    const o = Normalize.rackOrientation(rack.orientation);
    return (o === 90 || o === 270) ? { hx: d / 2, hy: w / 2 } : { hx: w / 2, hy: d / 2 };
  }

  /* ---- montants (occupation) ---- */

  /** Un montage verrouille-t-il tout le U / les deux faces ? `locks_u` fait foi ; l'enum legacy
      « full » n'implique les 2 faces QUE pré-migration (depth_mm absent) — règle répliquée dans
      shared/DataValidation (RackOccupancy.sides), à maintenir en parité. */
  static mountLocksU(m: any): boolean { return (m.locks_u === true) || (m.depth_mm == null && m.depth === "full"); }
  /** Faces occupées par un montage selon le type de baie (simple/double). */
  static mountSides(mount: any, rack: any): string[] {
    if (!rack || rack.sides !== "dual") return ["front"];
    if (mount.isItem) {
      // Un TRAY pleine profondeur (type "dual", posé de façade à façade) occupe les DEUX faces ; un cantilever
      // (ou blank/keepblank) n'occupe que sa face de montage — sinon on autorisait à tort un occupant DOS À DOS.
      if (mount.kind === "tray" && mount.tray_type !== "cantilever") return ["front", "rear"];
      return [mount.side === "rear" ? "rear" : "front"];
    }
    return RackGeometry.mountLocksU(mount) ? ["front", "rear"] : [mount.side === "rear" ? "rear" : "front"];
  }
  /** Un bloc [startU, startU+height) tient-il et est-il libre sur les faces données ? */
  static canPlace(rack: any, startU: number, height: number, sides: string[], occ: Map<string, any>): boolean {
    if (!rack || startU == null) return false;
    if (startU < 1 || (startU + height - 1) > rack.u_count) return false;
    for (let i = 0; i < height; i++) { const u = startU + i; for (const s of sides) { if (occ.has(u + ":" + s)) return false; } }
    return true;
  }

  /* ---- side-mount (marge latérale) ---- */

  /** Marge latérale réelle par côté (mm) = (largeur − entraxe 19″)/2. */
  static sideMarginMm(rack: any): number { return Math.max(0, ((rack.width_mm || RACK_WIDTH_DEFAULT) - RACK_MOUNT_WIDTH) / 2); }
  /** Nombre de colonnes de side-mount (2 si la marge dépasse 2U, sinon 1). */
  static sideColumns(rack: any): number { return RackGeometry.sideMarginMm(rack) > 2 * U_MM ? 2 : 1; }
  /** Largeur d'une colonne de side-mount (mm). */
  static sideColWidthMm(rack: any): number { return RackGeometry.sideMarginMm(rack) / RackGeometry.sideColumns(rack); }
  /** Side-mount possible sur cette face ? (marge ≥ 1U + flag autorisé). */
  static sideEnabled(rack: any, face: string): boolean {
    return RackGeometry.sideMarginMm(rack) >= U_MM && (face === "rear" ? rack.allow_side_rear === true : rack.allow_side_front === true);
  }
  /** Hauteur (en U) occupée par un équipement side-monté (≥ 1). */
  static sideEquipHeightU(eq: any): number { return Math.max(1, Math.ceil((eq.free_h_mm || U_MM) / U_MM)); }
  /** L'équipement tient-il dans une colonne de marge ? */
  static sideEquipFits(rack: any, eq: any): boolean { return (eq.free_w_mm || 0) <= RackGeometry.sideColWidthMm(rack) + 0.5; }

  /** Boîte LOCALE (repère baie) d'un équipement side-monté. */
  static sideEquipBoxLocal(rack: any, e: any): any {
    const M = RackGeometry.sideMarginMm(rack), cols = RackGeometry.sideColumns(rack);
    const usable = Math.max(1, M - SIDE_POST_INSET), colW = usable / cols;
    const col = (e.side_col === 1 && cols > 1) ? 1 : 0;
    const lr = (e.side_lr === "right") ? "right" : "left";
    const w = Math.min(Math.max(1, e.free_w_mm || colW), colW);
    const inner0 = RACK_MOUNT_WIDTH / 2 + SIDE_POST_INSET;
    const colInner = inner0 + col * colW, colOuter = colInner + colW;
    let x0r, x1r;
    if (e.side_snap === "wall") { x1r = colOuter; x0r = colOuter - w; } else { x0r = colInner; x1r = colInner + w; }
    const xs = (lr === "right") ? [x0r, x1r] : [-x1r, -x0r];
    const heightU = RackGeometry.sideEquipHeightU(e);
    const z0 = RackGeometry.uBaseZ(rack) + (Math.max(1, e.side_u | 0) - 1) * U_MM;
    const z1 = z0 + Math.max(U_MM, e.free_h_mm || heightU * U_MM);
    const d = rack.depth || RACK_DEPTH_DEFAULT, hd = d / 2, cage = Math.min(d, RackGeometry.cageDepth(rack));
    const fm = RackGeometry.frontMargin(rack), fp = -hd + fm, rp = -hd + fm + cage;
    const len = Math.min(Math.max(20, e.free_l_mm || cage), cage - 8);
    const front = (e.side_face !== "rear");
    let y0, y1;
    if (front) { y0 = fp + 4; y1 = fp + 4 + len; } else { y1 = rp - 4; y0 = rp - 4 - len; }
    return { x0: xs[0], x1: xs[1], y0, y1, z0, z1, front, col, lr, heightU };
  }

  /* ---- tray (étagère) ---- */

  /** Longueur EFFECTIVE du plateau d'un tray : en "dual" (posée avant + arrière), de PLAN DE FAÇADE à
      PLAN DE FAÇADE (cage + les 2 réserves d'oreilles — le plateau déborde devant chaque rail comme la
      façade des équipements) ; en porte-à-faux, `depth_mm` (borné à la cage). */
  static trayLength(rack: any, it: any): number {
    const cage = RackGeometry.cageDepth(rack);
    if (it.tray_type !== "cantilever") return cage + 2 * RACK_EAR_STANDOFF_MM;
    return Math.min(Math.max(50, it.depth_mm || TRAY_DEPTH_DEFAULT_MM), cage);
  }

  /** Boîte LOCALE (repère baie) de l'espace UTILE d'un TRAY : le plateau est au BAS de la réservation
      (la structure — accroches/renforts triangulaires — PORTE le plateau et vit AU-DESSUS, cf. tray_u,
      pure indication de dessin qui n'EXCLUT rien) ; l'espace utile va du plateau (+ réserve de tôle
      TRAY_SHEET_RESERVE_MM, renforts transversaux) au plafond de la réservation (u_height). Sert au
      dessin 3D (espace réservé) et au CONTRÔLE DE PLACEMENT des équipements posés. */
  static trayBoxLocal(rack: any, it: any): any {
    const d = rack.depth || RACK_DEPTH_DEFAULT, hd = d / 2, cage = Math.min(d, RackGeometry.cageDepth(rack));
    const fm = RackGeometry.frontMargin(rack), fp = -hd + fm, rp = -hd + fm + cage;
    const front = it.side !== "rear";
    const len = RackGeometry.trayLength(rack, it);
    // ancré au PLAN DE FAÇADE (plan de montage − réserve d'oreilles) — comme tout occupant de baie
    const yFaceF = fp - RACK_EAR_STANDOFF_MM, yFaceR = rp + RACK_EAR_STANDOFF_MM;
    const y0 = front ? yFaceF : yFaceR - len, y1 = front ? yFaceF + len : yFaceR;
    const u = Math.max(1, it.u | 0), uh = Math.max(1, it.u_height | 0);
    const tu = Math.min(Math.max(1, it.tray_u | 0), uh);   // hauteur de la STRUCTURE (dessin) — bornée à la réservation
    const zBase = RackGeometry.uBaseZ(rack) + (u - 1) * U_MM;
    const z0 = zBase + TRAY_SHEET_RESERVE_MM;                          // plancher utile = plateau + réserve de tôle
    const zTop = RackGeometry.uBaseZ(rack) + (u - 1 + uh) * U_MM;      // plafond de la réservation
    const hw = RACK_MOUNT_WIDTH / 2 - RACK_EAR_MM;   // plateau = LARGEUR DU CORPS 19″ (entre rails) — les OREILLES s'accrochent aux rails
    // garde LATÉRALE réservée aux renforts (porte-à-faux) : les équipements posés n'y empiètent pas ;
    // en « dual » (pas de renforts latéraux), aucune garde. `x0/x1` = plateau PLEIN (dessin), la zone
    // UTILISABLE de pose est [x0+xInset, x1−xInset] (cf. trayEquipBoxLocal / trayEquipFitsWhy).
    const xInset = (it.tray_type === "cantilever") ? TRAY_GUSSET_CLEARANCE_MM : 0;
    return { x0: -hw, x1: hw, y0, y1, z0, z1: zTop, front, len, tu, zBase, xInset };
  }

  /** Empreinte au plateau d'un équipement LIBRE posé (mm) : l'orientation 90/270 permute largeur/longueur.
      Défauts prudents pour dimensions non renseignées (200×200×100). */
  static trayEquipFootprint(eq: any): { w: number; d: number; h: number } {
    const fw = Math.max(1, eq.free_w_mm || 200), fl = Math.max(1, eq.free_l_mm || 200), fh = Math.max(1, eq.free_h_mm || 100);
    const o = Normalize.rackOrientation(eq.dc_orientation);
    return (o === 90 || o === 270) ? { w: fl, d: fw, h: fh } : { w: fw, d: fl, h: fh };
  }

  /** Boîte LOCALE (repère baie) d'un équipement POSÉ sur une étagère : empreinte à (tray_x, tray_y) sur le
      plateau (null = centré), posée sur son dessus. tray_y se mesure depuis la FACE DE MONTAGE de l'étagère. */
  static trayEquipBoxLocal(rack: any, tray: any, eq: any): any {
    const b = RackGeometry.trayBoxLocal(rack, tray);
    const fp = RackGeometry.trayEquipFootprint(eq);
    // zone UTILISABLE = plateau moins la garde des renforts de chaque côté (tray_x se mesure depuis ce bord)
    const usableLeft = b.x0 + b.xInset, plankW = (b.x1 - b.x0) - 2 * b.xInset, plankL = Math.abs(b.y1 - b.y0);
    const tx = (eq.tray_x != null) ? eq.tray_x : Math.max(0, (plankW - fp.w) / 2);
    const ty = (eq.tray_y != null) ? eq.tray_y : Math.max(0, (plankL - fp.d) / 2);
    const x0 = usableLeft + tx, x1 = x0 + fp.w;
    // profondeur depuis la face de montage : avant → +Y depuis b.y0 ; arrière → −Y depuis b.y1
    const y0 = b.front ? b.y0 + ty : b.y1 - ty - fp.d;
    const y1 = y0 + fp.d;
    return { x0, x1, y0, y1, z0: b.z0, z1: b.z0 + fp.h, w: fp.w, d: fp.d, h: fp.h, tx, ty };
  }

  /** L'équipement TIENT-il sur l'étagère (et sans chevaucher ses colocataires) ? null = oui, sinon la RAISON.
      `others` = équipements déjà posés sur la MÊME étagère (« sauf moi-même » à charge de l'appelant).
      Règles RÉPLIQUÉES dans shared/DataValidation (TrayFit) — parité à maintenir. */
  static trayEquipFitsWhy(rack: any, tray: any, eq: any, others: any[] = []): string | null {
    const b = RackGeometry.trayBoxLocal(rack, tray);
    const fp = RackGeometry.trayEquipFootprint(eq);
    const plankW = (b.x1 - b.x0) - 2 * b.xInset, plankL = Math.abs(b.y1 - b.y0), availH = b.z1 - b.z0;   // largeur UTILISABLE (hors garde renforts)
    if (availH < 1) return "aucun espace réservé au-dessus du plateau (hauteur réservée = structure)";
    if (fp.h > availH + 0.5) return "hauteur " + fp.h + " mm > " + Math.round(availH) + " mm réservés au-dessus du plateau";
    if (fp.w > plankW + 0.5 || fp.d > plankL + 0.5) return "empreinte " + fp.w + " × " + fp.d + " mm > plateau " + Math.round(plankW) + " × " + Math.round(plankL) + " mm";
    const me = RackGeometry.trayEquipBoxLocal(rack, tray, eq);
    if (me.tx + fp.w > plankW + 0.5) return "dépasse le plateau en largeur (position " + Math.round(me.tx) + " mm)";
    if (me.ty + fp.d > plankL + 0.5) return "dépasse le plateau en profondeur (position " + Math.round(me.ty) + " mm)";
    for (const o of others) {
      const ob = RackGeometry.trayEquipBoxLocal(rack, tray, o);
      if (me.x0 < ob.x1 - 0.5 && ob.x0 < me.x1 - 0.5 && me.y0 < ob.y1 - 0.5 && ob.y0 < me.y1 - 0.5) {
        return "chevauche « " + (o.name || "équipement") + " »";
      }
    }
    return null;
  }

  /** REFLOW UNIFORME : dispose `eqs` (dans l'ordre donné) CÔTE À CÔTE sur une seule rangée, centrés en
      PROFONDEUR, avec des espaces HORIZONTAUX ÉGAUX (les deux marges de bord incluses) — la place est
      distribuée le plus uniformément possible autour des équipements. Renvoie les positions
      { x, y } (repère plateau : tray_x depuis le bord utilisable, tray_y depuis la face) alignées sur `eqs`,
      ou null si l'ensemble NE TIENT PAS sur une rangée (largeur cumulée > plateau, un item trop profond/haut)
      → l'appelant retombe alors sur `trayFindSpot` (placement du seul nouvel item). */
  static trayArrange(rack: any, tray: any, eqs: any[]): Array<{ x: number; y: number }> | null {
    const b = RackGeometry.trayBoxLocal(rack, tray);
    const plankW = (b.x1 - b.x0) - 2 * b.xInset, plankL = Math.abs(b.y1 - b.y0), availH = b.z1 - b.z0;
    const fps = eqs.map((e) => RackGeometry.trayEquipFootprint(e));
    const totalW = fps.reduce((s, f) => s + f.w, 0);
    if (totalW > plankW + 0.5) return null;                                   // ne tient pas côte à côte
    if (fps.some((f) => f.d > plankL + 0.5 || f.h > availH + 0.5)) return null;   // un item trop profond / trop haut
    const gap = Math.max(0, plankW - totalW) / (fps.length + 1);              // (n+1) espaces ÉGAUX
    const out: Array<{ x: number; y: number }> = [];
    let x = gap;
    for (const f of fps) { out.push({ x, y: Math.max(0, (plankL - f.d) / 2) }); x += f.w + gap; }
    return out;
  }

  /** Position AUTOMATIQUE d'un équipement sur l'étagère. Privilégie le placement CÔTE À CÔTE (une seule
      RANGÉE, centrée en profondeur) et distribue la place AUTOUR de l'équipement : parmi les intervalles
      libres de la rangée (bords du plateau inclus), on retient le PLUS GRAND qui accueille l'empreinte et
      on y CENTRE l'équipement. Les colocataires ne sont PAS déplacés. Repli (rangée pleine à cette
      profondeur) : balayage grille (gauche→droite puis façade→fond). Renvoie { x, y } (mm, repère plateau,
      tray_x depuis le bord utilisable / tray_y depuis la face) ou null si rien ne tient. */
  static trayFindSpot(rack: any, tray: any, eq: any, others: any[] = []): { x: number; y: number } | null {
    const b = RackGeometry.trayBoxLocal(rack, tray);
    const fp = RackGeometry.trayEquipFootprint(eq);
    const plankW = (b.x1 - b.x0) - 2 * b.xInset, plankL = Math.abs(b.y1 - b.y0);   // largeur UTILISABLE (hors garde renforts)
    if (fp.h > (b.z1 - b.z0) + 0.5 || fp.w > plankW + 0.5 || fp.d > plankL + 0.5) return null;   // ne tient pas
    // rangée CÔTE À CÔTE : l'équipement est centré en PROFONDEUR (comme ses colocataires en rangée).
    const y = Math.max(0, (plankL - fp.d) / 2), bandLo = y, bandHi = y + fp.d;
    // emprises X (repère utilisable) des colocataires dont la bande de profondeur CHEVAUCHE la rangée.
    const eff = (o: any) => {
      const f = RackGeometry.trayEquipFootprint(o);
      const tx = (o.tray_x != null) ? o.tray_x : Math.max(0, (plankW - f.w) / 2);
      const ty = (o.tray_y != null) ? o.tray_y : Math.max(0, (plankL - f.d) / 2);
      return { x0: tx, x1: tx + f.w, y0: ty, y1: ty + f.d };
    };
    const spans = others.map(eff).filter((r) => r.y0 < bandHi - 0.5 && bandLo < r.y1 - 0.5)
      .map((r) => [Math.max(0, r.x0), Math.min(plankW, r.x1)] as [number, number]).sort((a, b) => a[0] - b[0]);
    // plus GRAND intervalle libre ≥ largeur d'empreinte → équipement CENTRÉ dedans (place distribuée autour).
    let best: number | null = null, bestLen = -1, cursor = 0;
    for (const [ox0, ox1] of spans.concat([[plankW, plankW]] as [number, number][])) {
      const gap = ox0 - cursor;
      if (gap >= fp.w - 0.5 && gap > bestLen) { bestLen = gap; best = cursor + (gap - fp.w) / 2; }
      cursor = Math.max(cursor, ox1);
    }
    if (best != null) return { x: Math.max(0, Math.round(best)), y: Math.round(y) };
    // rangée centrale pleine → repli : balayage grille (autres profondeurs).
    const STEP = 25;
    for (let gy = 0; gy <= plankL - fp.d + 0.5; gy += STEP) {
      for (let gx = 0; gx <= plankW - fp.w + 0.5; gx += STEP) {
        if (!RackGeometry.trayEquipFitsWhy(rack, tray, Object.assign({}, eq, { tray_x: gx, tray_y: gy }), others)) return { x: gx, y: gy };
      }
    }
    return null;
  }

  /** Boîte locale plate d'un emplacement latéral LIBRE (colonne pleine × bande de U). */
  static sideSlotBoxLocal(rack: any, face: string, lr: string, col: number, uTop: number, heightU: number): any {
    const M = RackGeometry.sideMarginMm(rack), cols = RackGeometry.sideColumns(rack);
    const usable = Math.max(1, M - SIDE_POST_INSET), colW = usable / cols;
    const inner0 = RACK_MOUNT_WIDTH / 2 + SIDE_POST_INSET, colInner = inner0 + col * colW, colOuter = colInner + colW;
    const xs = (lr === "right") ? [colInner, colOuter] : [-colOuter, -colInner];
    const z0 = RackGeometry.uBaseZ(rack) + (Math.max(1, uTop | 0) - 1) * U_MM + 1, z1 = z0 + Math.max(1, heightU || SIDE_U_STEP) * U_MM - 2;
    const d = rack.depth || RACK_DEPTH_DEFAULT, hd = d / 2;
    const fm = RackGeometry.frontMargin(rack), cage = Math.min(d, RackGeometry.cageDepth(rack));
    const yPlane = (face === "rear") ? (-hd + fm + cage - 2) : (-hd + fm + 2);
    return { x0: xs[0], x1: xs[1], z0, z1, yPlane, front: face !== "rear" };
  }

  /* ---- wall-mount (paroi, marge avant/arrière) ---- */

  /** Profondeur de marge (mm) le long de laquelle on monte en paroi. */
  static marginDepth(rack: any, margin: string): number {
    const d = rack.depth || RACK_DEPTH_DEFAULT, cage = Math.min(d, RackGeometry.cageDepth(rack)), fm = RackGeometry.frontMargin(rack);
    return (margin === "rear") ? Math.max(0, d - fm - cage) : fm;
  }
  /** Montage en PAROI possible dans cette marge ? Profondeur ≥ 1U ET même AUTORISATION que le side-mount
      (avant/arrière) : les emplacements en paroi sont des emplacements LATÉRAUX au même titre que la marge —
      le toggle « Side-mount » du formulaire de baie gouverne les DEUX (unifiés). Ne gate que l'OFFRE de
      nouveaux emplacements ; les équipements déjà montés en paroi restent rendus/édités. */
  static wallEnabled(rack: any, margin: string): boolean {
    return RackGeometry.marginDepth(rack, margin) >= U_MM
      && (margin === "rear" ? rack.allow_side_rear === true : rack.allow_side_front === true);
  }
  /** Repère de la marge : face extérieure, sens vers les montants, colonnes. */
  static wallGeo(rack: any, margin: string): WallGeo {
    const d = rack.depth || RACK_DEPTH_DEFAULT, hd = d / 2, dep = RackGeometry.marginDepth(rack, margin);
    const yFace = (margin === "rear") ? hd : -hd, sgnInto = (margin === "rear") ? -1 : 1;
    const cols = Math.max(1, Math.floor(dep / WALL_COL_MIN)), colW = dep / cols;
    return { d, hd, dep, yFace, sgnInto, cols, colW };
  }
  /** Boîte locale plate d'un emplacement mural LIBRE (colonne × bande de U). */
  static wallSlotBoxLocal(rack: any, wall: string, margin: string, col: number, uTop: number, heightU: number): any {
    const g = RackGeometry.wallGeo(rack, margin), hw = (rack.width_mm || RACK_WIDTH_DEFAULT) / 2;
    const xPlane = (wall === "right") ? hw : -hw;
    const ya = g.yFace + g.sgnInto * (col * g.colW), yb = g.yFace + g.sgnInto * ((col + 1) * g.colW);
    const z0 = RackGeometry.uBaseZ(rack) + (Math.max(1, uTop | 0) - 1) * U_MM + 1, z1 = z0 + Math.max(1, heightU || SIDE_U_STEP) * U_MM - 2;
    return { xPlane, y0: Math.min(ya, yb), y1: Math.max(ya, yb), z0, z1, wall, margin };
  }
  /** Boîte locale 3D d'un équipement monté en paroi + normale sortante `n` de sa face. */
  static wallEquipBoxLocal(rack: any, e: any): any {
    const wall = (e.wall_lr === "right") ? "right" : "left", margin = (e.wall_margin === "rear") ? "rear" : "front";
    const orient = (e.wall_orient === "facade") ? "facade" : "center";
    const g = RackGeometry.wallGeo(rack, margin), hw = (rack.width_mm || RACK_WIDTH_DEFAULT) / 2;
    const xWall = (wall === "right") ? hw : -hw, into = (wall === "right") ? -1 : 1;
    const col = Math.max(0, e.wall_col | 0), uTop = Math.max(1, e.wall_u | 0);
    const colYa = g.yFace + g.sgnInto * (col * g.colW);
    const z0 = RackGeometry.uBaseZ(rack) + (uTop - 1) * U_MM, z1 = z0 + Math.max(U_MM, e.free_h_mm || RackGeometry.sideEquipHeightU(e) * U_MM);
    const W = Math.max(20, e.free_w_mm || g.colW), L = Math.max(20, e.free_l_mm || 100);
    let x0, x1, y0, y1, n;
    if (orient === "center") {
      const dx = Math.min(L, hw);
      x0 = (into > 0) ? xWall : xWall - dx; x1 = (into > 0) ? xWall + dx : xWall;
      const wy = Math.min(W, g.colW), yb = colYa + g.sgnInto * wy;
      y0 = Math.min(colYa, yb); y1 = Math.max(colYa, yb);
      n = { x: into, y: 0 };
    } else {
      const wx = Math.min(W, hw);
      x0 = (into > 0) ? xWall : xWall - wx; x1 = (into > 0) ? xWall + wx : xWall;
      const dy = Math.min(L, g.dep), yb = g.yFace + g.sgnInto * dy;
      y0 = Math.min(g.yFace, yb); y1 = Math.max(g.yFace, yb);
      n = { x: 0, y: -g.sgnInto };
    }
    return { x0, x1, y0, y1, z0, z1, n, orient, wall, margin };
  }

  /* ---- capots (toit/sol) ---- */

  /** Grille au pas 1U du capot (largeur × profondeur), CENTRÉE : la largeur/profondeur n'étant pas un multiple
      exact de 1U, le reste est réparti en marge ÉGALE de chaque côté (`mx`/`my`) → trous symétriques. La marge
      n'est pas perçable (hors grille) mais reste couverte par la plaque. `mx`/`my` < 0 si 1U > dimension (rare). */
  static capGrid(rack: any): any {
    const w = rack.width_mm || RACK_WIDTH_DEFAULT, d = rack.depth || RACK_DEPTH_DEFAULT;
    const nx = Math.max(1, Math.round(w / U_MM)), ny = Math.max(1, Math.round(d / U_MM));
    return { w, d, nx, ny, cell: U_MM, mx: (w - nx * U_MM) / 2, my: (d - ny * U_MM) / 2 };
  }
  /** Cellules autorisées d'un capot ("roof" | "floor"). */
  static capCells(rack: any, face: string): string[] { const v = (face === "floor") ? rack.floor_cells : rack.roof_cells; return Array.isArray(v) ? v : []; }
  /** Centre LOCAL (repère baie) d'une cellule (cx,cy) du capot (grille centrée). */
  static capCellLocalCenter(rack: any, cx: number, cy: number): { lx: number; ly: number } {
    const g = RackGeometry.capGrid(rack);
    return { lx: -g.w / 2 + g.mx + ((cx | 0) + 0.5) * g.cell, ly: -g.d / 2 + g.my + ((cy | 0) + 0.5) * g.cell };
  }
}
