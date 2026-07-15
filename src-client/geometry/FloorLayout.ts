import type { Store } from "../store";
import { Normalize } from "../core/Normalize";
import { Waypoint } from "../models/Waypoint";
import {
  LOCATIONS, U_MM, FLOOR_WIDTH_DEFAULT, FLOOR_DEPTH_DEFAULT, FLOOR_CELL_DEFAULT,
  OOB_HEIGHT_DEFAULT, DC_GAP_DEFAULT,
} from "../domain/constants";

export interface Vec3 { x: number; y: number; z: number; }
/** Config d'un étage (entité `floors` ou défaut virtuel). */
export interface FloorCfg { id: string | null; location: string; floor: string; width_mm: number; depth_mm: number; cell_mm: number; blocked_cells: string[]; anchor_x?: number; anchor_y?: number; height_mm?: number; }
/** Salle disposée dans la vue multi-salles : centre monde (off), orientation (o, rad), niveau. */
export interface RoomPlacement { dc: any; off: Vec3; o: number; level: number; }
export interface BuildingBand { loc: string; x0: number; x1: number; }
export interface FloorPlane { loc: string; floor: string; cfg: FloorCfg; off: Vec3; }
/** Disposition complète de la vue multi-salles (étages empilés, bâtiments côte à côte). */
export interface MultiLayout {
  rooms: RoomPlacement[]; levels: number[]; stackH: number; gap: number;
  buildings: BuildingBand[]; floorPlanes: FloorPlane[]; totalW: number; maxD: number; topZ: number; levelStep: number;
  /** Hauteur (mm) et Z (base, mm) de chaque niveau de `levels`, dans le même ordre — placement vertical NON uniforme. */
  levelHs: number[]; levelZs: number[];
}

/* =============================================================================
   Couche ÉTAGE / BÂTIMENT (pure, store injecté) : configs d'étage, position des salles
   sur leur plan, et DISPOSITION multi-salles (salles posées par lieu = bâtiment côte à côte,
   étages empilés en Z). Socle commun à la vue 3D multi-salles et à la future vue Étage.
   Réplique OO de floorConfig/floorRoomPos/_multiLayout/_roomToWorld du monolithe.
   ============================================================================= */
export class FloorLayout {
  constructor(private store: Store) {}

  /** Libellé lisible d'un lieu (bâtiment). */
  static locationLabel(id: string): string { const l = LOCATIONS.find((x) => x.id === id); return l ? l.label : (id || "—"); }
  /** Niveau numérique d'un étage (étage vide/libre → 0). */
  static floorNum(f: any): number { const n = parseFloat(f); return isFinite(n) ? n : 0; }

  /** Config d'un étage : l'entité `floors` si elle existe, sinon un défaut virtuel. */
  config(location: string, floor: any): FloorCfg {
    const f = this.store.floorFor(location, floor);
    if (f) return f;
    return { id: null, location: location || "", floor: String(floor != null ? floor : ""), width_mm: FLOOR_WIDTH_DEFAULT, depth_mm: FLOOR_DEPTH_DEFAULT, cell_mm: FLOOR_CELL_DEFAULT, blocked_cells: [], height_mm: 0 };
  }
  /** Emprise (AABB) d'une salle sur le plan (w/h permutés à 90/270). */
  static roomFootprint(dc: any): { w: number; h: number } {
    const o = Normalize.rackOrientation(dc.floor_orientation);
    return (o === 90 || o === 270) ? { w: dc.depth_mm, h: dc.width_mm } : { w: dc.width_mm, h: dc.depth_mm };
  }
  /** Position AUTO (coin haut-gauche de l'emprise) d'une salle non localisée : pavage en lignes. */
  private roomAuto(dc: any, cfg: FloorCfg): { x: number; y: number } {
    const margin = cfg.cell_mm, W = cfg.width_mm;
    const sibs = this.store.dcsOfFloor(dc.location, dc.floor);
    const ordered = sibs.slice().sort((a: any, b: any) => (a.name || "").localeCompare(b.name || ""));
    let x = margin, y = margin, rowH = 0;
    for (const s of ordered) {
      const fp = FloorLayout.roomFootprint(s);
      if (s.id === dc.id) return { x, y };
      if (x + fp.w + margin > W) { x = margin; y += rowH + margin; rowH = 0; }
      x += fp.w + margin; rowH = Math.max(rowH, fp.h);
    }
    return { x: margin, y: margin };
  }
  /** Position (coin haut-gauche de l'emprise, mm) d'une salle sur son plan : explicite ou auto. */
  roomPos(dc: any, cfg: FloorCfg): { x: number; y: number } {
    if (dc.floor_x != null && dc.floor_y != null) return { x: dc.floor_x, y: dc.floor_y };
    return this.roomAuto(dc, cfg);
  }
  /** Point LOCAL de salle → plan d'étage (rotation autour du centre + ancrage au coin de l'emprise). */
  static roomLocalToPlan(dc: any, pos: { x: number; y: number }, p: Vec3): Vec3 {
    const o = Normalize.rackOrientation(dc.floor_orientation) * Math.PI / 180, co = Math.cos(o), so = Math.sin(o);
    const fp = FloorLayout.roomFootprint(dc), dx = p.x - dc.width_mm / 2, dy = p.y - dc.depth_mm / 2;
    return { x: pos.x + fp.w / 2 + (dx * co - dy * so), y: pos.y + fp.h / 2 + (dx * so + dy * co), z: p.z };
  }
  static planToRoomLocal(dc: any, pos: { x: number; y: number }, p: Vec3): Vec3 {
    const o = Normalize.rackOrientation(dc.floor_orientation) * Math.PI / 180, co = Math.cos(o), so = Math.sin(o);
    const fp = FloorLayout.roomFootprint(dc), rx = p.x - (pos.x + fp.w / 2), ry = p.y - (pos.y + fp.h / 2);
    return { x: dc.width_mm / 2 + (rx * co + ry * so), y: dc.depth_mm / 2 + (-rx * so + ry * co), z: p.z };
  }
  static oobLocalized(wp: any): boolean { return Waypoint.isFloorLevel(wp) && wp.floor_x != null && wp.floor_y != null; }
  /** Position (x,y) d'un OOB sur le plan de son étage : localisé (floor_x/floor_y) ou centre du plan. */
  static oobFloorPos(wp: any, cfg: FloorCfg): { x: number; y: number } {
    if (FloorLayout.oobLocalized(wp)) return { x: wp.floor_x, y: wp.floor_y };
    return { x: cfg.width_mm / 2, y: cfg.depth_mm / 2 };
  }
  static oobHeight(wp: any): number { return (wp && wp.dc_z != null) ? wp.dc_z : OOB_HEIGHT_DEFAULT; }

  static floorEquipLocalized(e: any): boolean { return !!(e && e.placement_mode === "floor" && e.floor_x != null && e.floor_y != null); }
  /** Position (x,y) d'un équipement posé sur le plan de son étage : localisé (floor_x/floor_y) ou centre. */
  static floorEquipPos(e: any, cfg: FloorCfg): { x: number; y: number } {
    if (FloorLayout.floorEquipLocalized(e)) return { x: e.floor_x, y: e.floor_y };
    return { x: cfg.width_mm / 2, y: cfg.depth_mm / 2 };
  }
  static floorEquipHeight(e: any): number { return (e && e.dc_z != null) ? e.dc_z : 0; }

  /** Hauteur de référence (mm) d'une salle = plus haut contenu (baies), ou 42U par défaut. */
  zRef(dc: any): number { const maxU = this.store.racksOfDc(dc.id).reduce((m: number, r: any) => Math.max(m, r.u_count || 0), 0) || 42; return maxU * U_MM; }

  /** Tous les couples (location, floor) connus : floors + salles + OOB + équipements d'étage. */
  allFloorKeys(): Array<{ location: string; floor: string }> {
    const seen = new Map<string, { location: string; floor: string }>();
    const add = (loc: any, fl: any) => { const L = loc || "", F = String(fl == null ? "" : fl), k = L + "" + F; if (!seen.has(k)) seen.set(k, { location: L, floor: F }); };
    this.store.all("floors").forEach((f: any) => add(f.location, f.floor));
    this.store.all("datacenters").forEach((d: any) => add(d.location, d.floor));
    this.store.oobWaypoints().forEach((w: any) => { if (w.location || (w.floor != null && w.floor !== "")) add(w.location, w.floor); });
    this.store.floorEquipments().forEach((e: any) => { if (e.location || (e.floor != null && e.floor !== "")) add(e.location, e.floor); });
    return [...seen.values()].sort((a, b) => this.store.siteLabel(a.location).localeCompare(this.store.siteLabel(b.location)) || FloorLayout.floorNum(a.floor) - FloorLayout.floorNum(b.floor));
  }

  /** Disposition multi-salles. `cur` = salle active (peut être null = vue d'ensemble).
      `opts.visibleDcIds` filtre les salles ; `opts.gap` = écart (mm, défaut DC_GAP_DEFAULT). */
  multiLayout(cur: any, opts: { visibleDcIds?: Set<string>; gap?: number } = {}): MultiLayout {
    const gap = Math.max(0, opts.gap != null ? opts.gap : DC_GAP_DEFAULT);
    const visibleDcIds = opts.visibleDcIds || new Set<string>();
    const all = this.store.all("datacenters");
    const curLoc = cur ? (cur.location || "") : null;
    const dcs = cur
      ? all.filter((d: any) => d.id === cur.id || visibleDcIds.has(d.id))
      : (visibleDcIds.size ? all.filter((d: any) => visibleDcIds.has(d.id)) : all.slice());
    // étages affichés = étages des salles affichées ∪ étages « nus » (du bâtiment affiché)
    const dcLocs = new Set(dcs.map((d: any) => d.location || ""));
    const dispFloors = new Map<string, { loc: string; fl: string }>();
    const addF = (loc: any, fl: any) => { const L = loc || "", F = String(fl == null ? "" : fl), k = L + "" + F; if (!dispFloors.has(k)) dispFloors.set(k, { loc: L, fl: F }); };
    dcs.forEach((d: any) => addF(d.location, d.floor));
    this.allFloorKeys().forEach((k) => { if (cur == null || dcLocs.has(k.location || "")) addF(k.location, k.floor); });
    const allFloors = [...dispFloors.values()];
    const locs = Array.from(new Set(allFloors.map((f) => f.loc)))
      .sort((a, b) => (curLoc != null && a === curLoc ? -1 : curLoc != null && b === curLoc ? 1 : this.store.siteLabel(a).localeCompare(this.store.siteLabel(b))));
    const levels = Array.from(new Set(allFloors.map((f) => FloorLayout.floorNum(f.fl)))).sort((a, b) => a - b);
    const stackH = Math.max(42 * U_MM, ...dcs.map((d: any) => this.zRef(d)));   // hauteur de contenu GLOBALE = hauteur d'étage par défaut
    // HAUTEUR PAR ÉTAGE : `height_mm` configurée (la plus grande des plans affichés à ce niveau) sinon défaut `stackH`,
    // bornée au contenu (baies) du niveau. Le Z d'un niveau = somme CUMULÉE des hauteurs des étages inférieurs.
    const levelHeight = (lv: number): number => {
      let cfgH = 0;
      allFloors.filter((f) => FloorLayout.floorNum(f.fl) === lv).forEach((f) => { const c = this.config(f.loc, f.fl); if (c.height_mm) cfgH = Math.max(cfgH, c.height_mm); });
      const contentH = Math.max(42 * U_MM, 0, ...dcs.filter((d: any) => FloorLayout.floorNum(d.floor) === lv).map((d: any) => this.zRef(d)));
      return Math.max(cfgH || stackH, contentH);
    };
    const levelHs = levels.map((lv) => levelHeight(lv));
    const levelZs: number[] = []; { let z = 0; levelHs.forEach((h) => { levelZs.push(z); z += h + gap; }); }
    const levelZ = (lv: number) => { const i = levels.indexOf(lv); return i >= 0 ? levelZs[i] : 0; };
    const rooms: RoomPlacement[] = [], buildings: BuildingBand[] = [], floorPlanes: FloorPlane[] = [];
    let bx = 0, maxD = 0;
    locs.forEach((loc) => {
      const floorStrs = Array.from(new Set(allFloors.filter((f) => f.loc === loc).map((f) => f.fl)));
      if (!floorStrs.length) return;
      let bw = 0, bd = 0;
      floorStrs.forEach((fs) => { const cfg = this.config(loc, fs); bw = Math.max(bw, cfg.width_mm + (cfg.anchor_x || 0)); bd = Math.max(bd, cfg.depth_mm + (cfg.anchor_y || 0)); });
      floorStrs.forEach((fs) => { const cfg = this.config(loc, fs); floorPlanes.push({ loc, floor: fs, cfg, off: { x: bx + (cfg.anchor_x || 0), y: (cfg.anchor_y || 0), z: levelZ(FloorLayout.floorNum(fs)) } }); });
      dcs.filter((d: any) => (d.location || "") === loc).forEach((d: any) => {
        const cfg = this.config(loc, String(d.floor || "")), pos = this.roomPos(d, cfg), fp = FloorLayout.roomFootprint(d);
        const ax = cfg.anchor_x || 0, ay = cfg.anchor_y || 0;
        rooms.push({ dc: d, off: { x: bx + ax + pos.x + fp.w / 2, y: ay + pos.y + fp.h / 2, z: levelZ(FloorLayout.floorNum(d.floor)) }, o: Normalize.rackOrientation(d.floor_orientation) * Math.PI / 180, level: FloorLayout.floorNum(d.floor) });
      });
      maxD = Math.max(maxD, bd);
      buildings.push({ loc, x0: bx, x1: bx + bw });
      bx += bw + gap * 2;   // double écart entre bâtiments
    });
    const topZ = levels.length ? levelZs[levels.length - 1] + levelHs[levels.length - 1] : stackH;
    const totalW = Math.max(0, bx - gap * 2);
    // pas de profondeur entre niveaux : domine toute variation intra-étage (sinon un étage bas se peint au-dessus d'un haut)
    const levelStep = (Math.hypot(Math.max(1, totalW), Math.max(1, maxD)) + Math.max(stackH, ...levelHs, 1) + gap) * 8;
    return { rooms, levels, stackH, gap, buildings, floorPlanes, totalW, maxD, topZ, levelStep, levelHs, levelZs };
  }

  /** Point LOCAL de salle → MONDE 3D (pivote autour du centre de la salle puis pose à room.off + niveau Z). */
  static roomToWorld(room: RoomPlacement, p: Vec3): Vec3 {
    const co = Math.cos(room.o), so = Math.sin(room.o);
    const dx = p.x - room.dc.width_mm / 2, dy = p.y - room.dc.depth_mm / 2;
    return { x: room.off.x + (dx * co - dy * so), y: room.off.y + (dx * so + dy * co), z: (p.z || 0) + room.off.z };
  }
  static roomToLocal(room: RoomPlacement, pw: Vec3): Vec3 {
    const co = Math.cos(room.o), so = Math.sin(room.o);
    const rx = pw.x - room.off.x, ry = pw.y - room.off.y;
    return { x: room.dc.width_mm / 2 + (rx * co + ry * so), y: room.dc.depth_mm / 2 + (-rx * so + ry * co), z: pw.z - room.off.z };
  }
  /** Z (base du niveau) d'un étage, INTERPOLÉ entre niveaux affichés (OOB d'un étage sans salle affichée). Tient
      compte des hauteurs d'étage NON uniformes (levelZs/levelHs) ; extrapole avec la hauteur du niveau extrême. */
  static levelZ(m: MultiLayout, lv: number): number {
    const L = m.levels, Z = m.levelZs, H = m.levelHs; if (!L.length) return 0;
    const n = L.length;
    if (lv <= L[0]) return Z[0] - (L[0] - lv) * (H[0] + m.gap);                       // sous le plus bas
    if (lv >= L[n - 1]) return Z[n - 1] + (lv - L[n - 1]) * (H[n - 1] + m.gap);       // au-dessus du plus haut
    let i = 1; while (L[i] < lv) i++;
    const t = (lv - L[i - 1]) / (L[i] - L[i - 1]);
    return Z[i - 1] + t * (Z[i] - Z[i - 1]);                                          // interpolation linéaire en Z
  }
  /** Point MONDE 3D d'un OOB : localisé (floor_x/floor_y, hauteur dc_z) ou centre du plan à 3 m. */
  oobWorld(m: MultiLayout, wp: any): Vec3 {
    const loc = wp.location || "", fl = String(wp.floor || ""), cfg = this.config(loc, fl);
    const b = m.buildings.find((x) => (x.loc || "") === loc), bx = b ? b.x0 : 0;
    const pos = FloorLayout.oobFloorPos(wp, cfg), h = FloorLayout.oobLocalized(wp) ? FloorLayout.oobHeight(wp) : OOB_HEIGHT_DEFAULT;
    return { x: bx + (cfg.anchor_x || 0) + pos.x, y: (cfg.anchor_y || 0) + pos.y, z: FloorLayout.levelZ(m, FloorLayout.floorNum(fl)) + h };
  }
  /** Point MONDE 3D (base) d'un équipement posé sur un étage (analogue à `oobWorld`). */
  equipFloorWorld(m: MultiLayout, eq: any): Vec3 {
    const loc = eq.location || "", fl = String(eq.floor || ""), cfg = this.config(loc, fl);
    const b = m.buildings.find((x) => (x.loc || "") === loc), bx = b ? b.x0 : 0;
    const pos = FloorLayout.floorEquipPos(eq, cfg);
    return { x: bx + (cfg.anchor_x || 0) + pos.x, y: (cfg.anchor_y || 0) + pos.y, z: FloorLayout.levelZ(m, FloorLayout.floorNum(fl)) + FloorLayout.floorEquipHeight(eq) };
  }
}
