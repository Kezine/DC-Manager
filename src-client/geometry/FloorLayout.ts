import type { Store } from "../store";
import { Normalize } from "../core/Normalize";
import { Waypoint } from "../models/Waypoint";
import {
  LOCATIONS, U_MM, FLOOR_WIDTH_DEFAULT, FLOOR_DEPTH_DEFAULT, FLOOR_CELL_DEFAULT,
  OOB_HEIGHT_DEFAULT, DC_GAP_DEFAULT,
} from "../domain/constants";
import { SiteLayout } from "./SiteLayout";
import type { SiteScale } from "./SiteLayout";

export interface Vec3 { x: number; y: number; z: number; }
/** Config d'un étage (entité `floors` ou défaut virtuel). */
export interface FloorCfg { id: string | null; location: string; floor: string; width_mm: number; depth_mm: number; cell_mm: number; blocked_cells: string[]; anchor_x?: number; anchor_y?: number; height_mm?: number; }
/** Salle disposée dans la vue multi-salles : centre monde (off), orientation (o, rad), niveau. */
export interface RoomPlacement { dc: any; off: Vec3; o: number; level: number; }

/* ---- EXTRÉMITÉ DE LIAISON EXPRIMÉE EN MONDE (doctrine §6.30) ----
   ⚠ POURQUOI UN TYPE À PART, alors que `Resolver3D.Port3D` porte déjà exactement les mêmes champs.
   `Port3D` est rendu tantôt en LOCAL SALLE (`resolvePort3D`), tantôt en MONDE (`resolvePortWorld3D`) :
   son en-tête l'assume et s'en remet au POINT D'APPEL pour savoir d'où vient la valeur. Cet arbitrage
   tient tant que le repère se lit dans le nom de la méthode APPELÉE. Il cesse de tenir dès qu'un point
   résolu TRAVERSE une frontière de module : le tracé (`CableRouting.worldLine`) ne voit plus quelle
   méthode l'a produit, et un point LOCAL passé là où on attend du MONDE ne lève AUCUNE erreur — il
   dessine simplement le câble ailleurs. C'est la faute silencieuse que ce type interdit.
   Le champ `[REPERE_MONDE]` est un MARQUEUR PUREMENT TYPÉ (`declare const` + `unique symbol` : aucune
   ligne émise, aucune propriété à l'exécution). Sa seule fonction est d'empêcher qu'un `Port3D` local
   soit accepté par typage STRUCTUREL — sans lui, il le serait, les champs étant identiques. On ne
   fabrique donc un `WorldEnd` que par les producteurs qui SAVENT dans quel repère ils rendent. */
declare const REPERE_MONDE: unique symbol;

/** Point + normale sortante d'une extrémité de liaison, dans le repère MONDE. `n` est `null` quand
    l'extrémité n'annonce pas de normale (le tracé se passe alors d'amorce ⊥). */
export interface WorldEnd { x: number; y: number; z: number; n: Vec3 | null; readonly [REPERE_MONDE]: true; }
/** Emprise d'un bâtiment dans le monde. `x0`/`y0` = coin d'ORIGINE du site (le point que porte sa
    position, GPS ou repli) ; `x1`/`y1` = ce coin plus l'emprise de ses plans d'étage. Depuis que le site
    a une position (doctrine §6.9), la bande n'est plus alignée sur un axe : d'où `y0`/`y1`. */
export interface BuildingBand { loc: string; x0: number; x1: number; y0: number; y1: number; }
export interface FloorPlane { loc: string; floor: string; cfg: FloorCfg; off: Vec3; }
/** Disposition complète de la vue multi-salles (étages empilés, bâtiments côte à côte). */
export interface MultiLayout {
  rooms: RoomPlacement[]; levels: number[]; stackH: number; gap: number;
  buildings: BuildingBand[]; floorPlanes: FloorPlane[];
  /** ÉTENDUE du monde (mm) en X et en Y — mesurée sur les bandes de bâtiment, l'origine étant à (0,0).
      (Auparavant : largeur CUMULÉE de la file de bâtiments et profondeur du plus profond d'entre eux.) */
  totalW: number; maxD: number;
  topZ: number; levelStep: number;
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
      `opts.visibleDcIds` filtre les salles ; `opts.gap` = écart (mm, défaut DC_GAP_DEFAULT) ;
      `opts.siteScale` = échelle d'AFFICHAGE des distances inter-sites (réglage de vue, cf. SiteLayout). */
  multiLayout(cur: any, opts: { visibleDcIds?: Set<string>; gap?: number; siteScale?: SiteScale } = {}): MultiLayout {
    const gap = Math.max(0, opts.gap != null ? opts.gap : DC_GAP_DEFAULT);
    const visibleDcIds = opts.visibleDcIds || new Set<string>();
    const all = this.store.all("datacenters");
    // (le bâtiment de la salle ACTIVE ne pilote plus l'ordre des bâtiments — cf. tri stable plus bas)
    const dcs = cur
      ? all.filter((d: any) => d.id === cur.id || visibleDcIds.has(d.id))
      : (visibleDcIds.size ? all.filter((d: any) => visibleDcIds.has(d.id)) : all.slice());
    // ---- REPÈRE (§6.8 de docs/placement.md) : la DISPOSITION se dérive du MODÈLE DÉCLARÉ, jamais de
    // l'ensemble AFFICHÉ. La portée décide de ce qu'on VOIT, jamais de OÙ SONT les choses. On calcule
    // donc le layout COMPLET ici, et on FILTRE plus bas ce qu'on émet.
    // Conséquences VOULUES : un site masqué CONSERVE sa place (masquer retire du dessin, pas du repère),
    // et la largeur d'un bâtiment cesse de dépendre des étages qu'on affiche.
    // Séparateur de clé (bâtiment, étage) — ÉCHAPPÉ volontairement : un séparateur tapé en clair a déjà
    // été transformé en NUL brut dans ce dépôt, produisant des clés qui ne correspondaient jamais.
    const FLOOR_KEY_SEP = "";
    const modelFloors = new Map<string, { loc: string; fl: string }>();
    const addModel = (loc: any, fl: any) => { const L = loc || "", F = String(fl == null ? "" : fl); if (!modelFloors.has(L + FLOOR_KEY_SEP + F)) modelFloors.set(L + FLOOR_KEY_SEP + F, { loc: L, fl: F }); };
    all.forEach((d: any) => addModel(d.location, d.floor));
    this.allFloorKeys().forEach((k) => addModel(k.location, k.floor));
    const allFloors = [...modelFloors.values()];
    // Étages effectivement DESSINÉS (portée) : ceux des salles affichées ∪ les étages « nus » de leurs
    // bâtiments. Sert UNIQUEMENT à filtrer l'émission des plans, jamais au calcul des positions.
    const dcLocs = new Set(dcs.map((d: any) => d.location || ""));
    // ⚠ BÂTIMENTS SANS AUCUNE SALLE — ils sont TOUJOURS dessinés. La portée de la Vue étage s'exprime en
    // SALLES (`visibleDcIds`, et la salle active `cur`) : un bâtiment qui n'en porte AUCUNE ne peut donc
    // être désigné par aucun réglage. Le filtrer par `dcLocs` ne le retire pas d'une portée — il le rend
    // invisible POUR TOUJOURS, dès qu'une salle est active (c'est-à-dire presque toujours, `current()`
    // repliant sur la première salle du document). Un bâtiment est un fait du MODÈLE : c'est §6.8 de
    // docs/placement.md — la portée décide de ce qu'on VOIT, jamais de ce qui EXISTE.
    const modelRoomLocs = new Set(all.map((d: any) => d.location || ""));
    const shownFloors = new Set<string>();
    dcs.forEach((d: any) => shownFloors.add((d.location || "") + FLOOR_KEY_SEP + String(d.floor == null ? "" : d.floor)));
    this.allFloorKeys().forEach((k) => {
      const loc = k.location || "";
      if (cur == null || dcLocs.has(loc) || !modelRoomLocs.has(loc)) shownFloors.add(loc + FLOOR_KEY_SEP + String(k.floor == null ? "" : k.floor));
    });
    // Ordre des bâtiments STABLE : trier en plaçant la salle ACTIVE en premier encodait un souci
    // d'AFFICHAGE dans la GÉOMÉTRIE — le x0 d'un bâtiment sautait dès qu'on cliquait ailleurs. C'est la
    // CAMÉRA qui va sur la salle active, pas le monde qui se réarrange autour d'elle.
    const locs = Array.from(new Set(allFloors.map((f) => f.loc)))
      .sort((a, b) => this.store.siteLabel(a).localeCompare(this.store.siteLabel(b)) || a.localeCompare(b));
    // POSITION des bâtiments (§6.9) : dérivée du MODÈLE — coordonnées GPS des `sites` si elles existent,
    // sinon repli déterministe à 5 km du site précédent. Elle REMPLACE le rangement par largeur cumulée,
    // qui était une géométrie improvisée faute de position déclarée (§6.8). Le calcul porte sur TOUS les
    // sites du document, y compris ceux qu'aucune salle n'occupe : un site est un fait du modèle, pas de
    // la vue, et sa présence décale les suivants dans la chaîne de repli de façon stable.
    const siteRecords = this.store.all("sites").map((s: any) => ({ id: String(s.id), lat: s.lat, lon: s.lon }));
    const knownSiteIds = new Set(siteRecords.map((s: { id: string }) => s.id));
    // `location` référencées par le modèle sans enregistrement `sites` (ids historiques, et la location
    // VIDE des enregistrements non rattachés) : elles ont droit à une place, à la suite et triées.
    const extraLocs = Array.from(new Set(allFloors.map((f) => f.loc))).filter((l) => !knownSiteIds.has(l));
    const sitePos = SiteLayout.worldPositions(siteRecords, extraLocs, opts.siteScale);
    // TAILLE DÉCLARÉE des bâtiments (§6.8, dernier paragraphe) : optionnelle et INDISSOCIABLE (invariant de
    // spec — une demi-dimension ne décrit aucune emprise). Renseignée, elle FAIT l'emprise du bâtiment ;
    // absente, l'emprise reste DÉDUITE des plans d'étage, comme avant. Carte construite une seule fois : la
    // boucle des bâtiments plus bas n'a qu'à la consulter.
    const declaredSize = new Map<string, { w: number; d: number }>();
    this.store.all("sites").forEach((s: any) => { if (s.width_mm != null && s.depth_mm != null) declaredSize.set(String(s.id), { w: s.width_mm, d: s.depth_mm }); });
    const levels = Array.from(new Set(allFloors.map((f) => FloorLayout.floorNum(f.fl)))).sort((a, b) => a - b);
    const stackH = Math.max(42 * U_MM, ...all.map((d: any) => this.zRef(d)));   // hauteur de contenu GLOBALE (modèle) = hauteur d'étage par défaut
    // HAUTEUR PAR ÉTAGE : `height_mm` configurée (la plus grande des plans affichés à ce niveau) sinon défaut `stackH`,
    // bornée au contenu (baies) du niveau. Le Z d'un niveau = somme CUMULÉE des hauteurs des étages inférieurs.
    const levelHeight = (lv: number): number => {
      let cfgH = 0;
      allFloors.filter((f) => FloorLayout.floorNum(f.fl) === lv).forEach((f) => { const c = this.config(f.loc, f.fl); if (c.height_mm) cfgH = Math.max(cfgH, c.height_mm); });
      const contentH = Math.max(42 * U_MM, 0, ...all.filter((d: any) => FloorLayout.floorNum(d.floor) === lv).map((d: any) => this.zRef(d)));   // MODÈLE, pas l'affiché (§6.8)
      return Math.max(cfgH || stackH, contentH);
    };
    const levelHs = levels.map((lv) => levelHeight(lv));
    const levelZs: number[] = []; { let z = 0; levelHs.forEach((h) => { levelZs.push(z); z += h + gap; }); }
    const levelZ = (lv: number) => { const i = levels.indexOf(lv); return i >= 0 ? levelZs[i] : 0; };
    const rooms: RoomPlacement[] = [], buildings: BuildingBand[] = [], floorPlanes: FloorPlane[] = [];
    let totalW = 0, maxD = 0;
    locs.forEach((loc) => {
      const floorStrs = Array.from(new Set(allFloors.filter((f) => f.loc === loc).map((f) => f.fl)));
      if (!floorStrs.length) return;
      // EMPRISE du bâtiment. Taille DÉCLARÉE ⇒ c'est ELLE qui fait l'emprise : le bâtiment cesse d'épouser
      // son plus grand plan d'étage, il a enfin une dimension PROPRE. Sinon, le calcul historique est
      // conservé au micron — la déclaration est OPT-IN, elle ne doit rien changer aux documents qui s'en
      // passent. Les deux lectures restent cohérentes parce que la validation GARANTIT qu'un plan d'étage
      // ne déborde pas de son bâtiment déclaré (contrainte cross-entité sur `floors`, cf. §6.8).
      const declared = declaredSize.get(loc);
      let bw = 0, bd = 0;
      if (declared) { bw = declared.w; bd = declared.d; }
      else floorStrs.forEach((fs) => { const cfg = this.config(loc, fs); bw = Math.max(bw, cfg.width_mm + (cfg.anchor_x || 0)); bd = Math.max(bd, cfg.depth_mm + (cfg.anchor_y || 0)); });
      // ORIGINE du bâtiment = la position de son SITE. `sitePos` couvre par construction toute `location`
      // du modèle ; le repli (0,0) ne protège que d'une carte incomplète, il ne doit jamais servir.
      const sp = sitePos.get(loc) || { x: 0, y: 0 };
      const bx = sp.x, by = sp.y;
      // ÉMISSION filtrée par la PORTÉE : la position d'un plan vient du layout complet (ci-dessus), mais
      // on ne DESSINE que les étages affichés. Repère et portée restent ainsi séparés (§6.8).
      floorStrs.forEach((fs) => {
        if (!shownFloors.has(loc + FLOOR_KEY_SEP + fs)) return;
        const cfg = this.config(loc, fs); floorPlanes.push({ loc, floor: fs, cfg, off: { x: bx + (cfg.anchor_x || 0), y: by + (cfg.anchor_y || 0), z: levelZ(FloorLayout.floorNum(fs)) } });
      });
      dcs.filter((d: any) => (d.location || "") === loc).forEach((d: any) => {
        const cfg = this.config(loc, String(d.floor || "")), pos = this.roomPos(d, cfg), fp = FloorLayout.roomFootprint(d);
        const ax = cfg.anchor_x || 0, ay = cfg.anchor_y || 0;
        rooms.push({ dc: d, off: { x: bx + ax + pos.x + fp.w / 2, y: by + ay + pos.y + fp.h / 2, z: levelZ(FloorLayout.floorNum(d.floor)) }, o: Normalize.rackOrientation(d.floor_orientation) * Math.PI / 180, level: FloorLayout.floorNum(d.floor) });
      });
      // ÉTENDUE du monde : les bâtiments n'étant plus rangés en file, elle se mesure, elle ne se cumule plus.
      // `SiteLayout` normalise les positions à un minimum nul, donc x0 ≥ 0 et y0 ≥ 0 : les maxima suffisent.
      totalW = Math.max(totalW, bx + bw); maxD = Math.max(maxD, by + bd);
      buildings.push({ loc, x0: bx, x1: bx + bw, y0: by, y1: by + bd });
    });
    const topZ = levels.length ? levelZs[levels.length - 1] + levelHs[levels.length - 1] : stackH;
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
  /** DIRECTION locale de salle → MONDE : la PARTIE LINÉAIRE de `roomToWorld`, c'est-à-dire sa rotation
      SANS sa translation. C'est le pendant exact de `PlacementFrame.composeDir` face à `composePoint` :
      la paire `roomToWorld`/`roomToLocal` ne portait que le POINT, et le conteneur salle n'avait donc
      aucun moyen de tourner une normale. Ce manque se voyait — la normale d'un bout de câble était
      tournée DANS le traceur (`CableRouting.worldEndNormal`), c'est-à-dire à un endroit qui n'a pas à
      connaître la transformée d'un conteneur (doctrine §3 règle 1, §6.30).

      ⚠ LA DIFFÉRENCE DE DEUX IMAGES EST VOULUE, ce n'est pas un contournement. Réécrire ici `cos`/`sin`
      donnerait une SECONDE copie de la rotation de salle, libre de diverger de `roomToWorld` au premier
      changement (une salle qui gagnerait une échelle, un miroir, un pivot autre que son centre) ; la
      dériver de la transformée elle-même la rend juste PAR CONSTRUCTION, pour toute transformée AFFINE.
      C'est aussi ce qui rend le résultat IDENTIQUE AU BIT près à l'expression qui vivait dans le
      traceur — propriété sur laquelle repose la preuve de parité du lot. `at` est le point d'application
      (sans effet en arithmétique exacte, il fixe le point de linéarisation en virgule flottante). */
  static roomDirToWorld(room: RoomPlacement, at: Vec3, dir: Vec3): Vec3 {
    const w0 = FloorLayout.roomToWorld(room, at);
    const w1 = FloorLayout.roomToWorld(room, { x: at.x + dir.x, y: at.y + dir.y, z: at.z + dir.z });
    return { x: w1.x - w0.x, y: w1.y - w0.y, z: w1.z - w0.z };
  }
  /** EXTRÉMITÉ résolue en LOCAL SALLE → extrémité MONDE (point ET normale). C'est le « pendant salle »
      de `Resolver3D.resolvePortWorld3D`, qui rend déjà du MONDE pour un contenu posé sur un ÉTAGE : les
      deux conteneurs offrent désormais la même chose au tracé, un `WorldEnd`, et c'est ce qui permet à
      `CableRouting.worldLine` d'ignorer leur NATURE (doctrine §6.30, décision D1 du chantier).

      ⚠ ELLE VIT ICI, ET PAS DANS `Resolver3D`. La transformée d'une salle vers le monde relève du
      LAYOUT (§6.6) : elle dépend de l'ensemble affiché, pas des seuls enregistrements. `Resolver3D` la
      REÇOIT toujours (trois nombres pour l'étage) et ne l'a jamais calculée — son en-tête pose que « un
      consommateur qui veut du monde compose lui-même ce dernier maillon ». L'y installer l'obligerait à
      importer ce module, donc à connaître le layout. Et la laisser dans `CableRouting` (où elle était)
      maintiendrait le traceur propriétaire d'une transformée de conteneur, c'est-à-dire exactement ce
      que ce lot retire. Le module qui POSSÈDE `roomToWorld` est le seul endroit juste. */
  static roomEndToWorld(room: RoomPlacement, end: { x: number; y: number; z: number; n?: Vec3 | null }): WorldEnd {
    const p = FloorLayout.roomToWorld(room, end);
    // Le marqueur de repère n'existe qu'au typage : l'assertion est l'endroit UNIQUE où l'on AFFIRME
    // « ce point est en monde », et elle est ici justifiée par `roomToWorld` juste au-dessus.
    return { x: p.x, y: p.y, z: p.z, n: end.n ? FloorLayout.roomDirToWorld(room, end, end.n) : null } as WorldEnd;
  }
  /** PENDANT ÉTAGE de `roomEndToWorld` : une extrémité DÉJÀ résolue en monde devient un `WorldEnd`.

      ⚠ ELLE NE CALCULE RIEN, ET C'EST LE POINT. Un conteneur ÉTAGE n'a pas de transformée à composer ici :
      le résolveur (`Resolver3D.resolvePortWorld3D`) a REÇU l'origine monde du conteneur et a déjà composé.
      Ce qui manquait n'était donc pas un calcul mais l'AFFIRMATION du repère — le marqueur `WorldEnd`
      n'existant qu'au typage, il faut un endroit NOMMÉ où l'on déclare « ce point est en monde », plutôt
      qu'un `as WorldEnd` disséminé chez les appelants. Les deux producteurs vivent ainsi côte à côte, dans
      le module qui possède la géométrie des conteneurs de haut niveau (doctrine §6.30 puis §6.31).

      ⚠ À N'APPELER QUE sur un point produit par un résolveur MONDE. Le marqueur protège les appelants les
      uns des autres (un `Port3D` local ne compile pas là où l'on attend du monde) ; il ne protège pas d'un
      mensonge délibéré à cet endroit précis — comme `roomEndToWorld`, c'est la frontière de confiance. */
  static worldEndOf(end: { x: number; y: number; z: number; n?: Vec3 | null }): WorldEnd {
    return { x: end.x, y: end.y, z: end.z, n: end.n || null } as WorldEnd;
  }
  /** L'étage (bâtiment, étage) est-il AFFICHÉ, c'est-à-dire son plan est-il émis par ce layout ?

      C'est le PENDANT, pour un conteneur étage, du `roomById.get(...)` que les tracés inter-conteneurs
      appliquent à une salle (décision D3 : un étage est un conteneur affichable au même titre qu'une
      salle — un câble qui y aboutit n'est tracé que s'il est affiché, et disparaît sinon). La portée vit
      dans `floorPlanes`, filtré par `shownFloors` : c'est la SEULE lecture juste, `m.levels` couvrant tous
      les niveaux du MODÈLE et non ceux qu'on dessine (§6.8). */
  static floorShown(m: MultiLayout, location: string, floor: string): boolean {
    return m.floorPlanes.some((p) => (p.loc || "") === (location || "") && String(p.floor) === String(floor));
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
    // Origine du bâtiment : les DEUX composantes depuis que le site porte une position (§6.9) — ne lire que
    // `x0` reviendrait à replier tous les bâtiments sur la même bande y, silencieusement.
    const b = m.buildings.find((x) => (x.loc || "") === loc), bx = b ? b.x0 : 0, by = b ? b.y0 : 0;
    const pos = FloorLayout.oobFloorPos(wp, cfg), h = FloorLayout.oobLocalized(wp) ? FloorLayout.oobHeight(wp) : OOB_HEIGHT_DEFAULT;
    return { x: bx + (cfg.anchor_x || 0) + pos.x, y: by + (cfg.anchor_y || 0) + pos.y, z: FloorLayout.levelZ(m, FloorLayout.floorNum(fl)) + h };
  }
  /** ORIGINE MONDE du repère PROPRE d'un équipement posé sur un ÉTAGE : `x`/`y` = sa position sur le plan de
      son étage (origine du bâtiment + ancrage du plan + `floor_x`/`floor_y`, ou centre du plan à défaut), et
      `baseZ` = SOCLE du niveau. C'est le repère depuis lequel se composent TOUS ses contenus propres — sa
      boîte dessinée comme ses ports.

      ⚠ `baseZ` ne porte QUE le socle : la hauteur propre (`dc_z`) N'Y EST PAS. C'est la convention de toute
      la chaîne d'étage — `DcThreeScene.buildEquipBox` pose son groupe sur le socle PUIS sa boîte sur
      `box().z`, et `Resolver3D.resolvePortWorld3D` ajoute `dc_z` du côté du résolveur (doctrine §6.20).
      L'ajouter ici la compterait DEUX fois, décalage d'autant plus traître qu'il reste invisible tant que
      l'équipement est posé au sol.

      EXTRAIT pour être la SOURCE UNIQUE de cette origine : le décor 3D (`DcBase.webglFloorDecor`) et le
      cadrage « Localiser » d'un posé d'étage en ont besoin tous les deux. La recalculer chez chaque
      consommateur reposerait la question du `dc_z` à chacun d'eux — et il suffit d'y répondre une fois de
      travers pour que la caméra vise à côté de ce que la scène dessine. */
  equipFloorOrigin(m: MultiLayout, eq: any): { x: number; y: number; baseZ: number } {
    const loc = eq.location || "", fl = String(eq.floor || ""), cfg = this.config(loc, fl);
    // Origine du bâtiment : les DEUX composantes depuis que le site porte une position (§6.9) — ne lire que
    // `x0` replierait silencieusement tous les bâtiments sur la même bande y (même piège qu'`oobWorld`).
    const b = m.buildings.find((x) => (x.loc || "") === loc), bx = b ? b.x0 : 0, by = b ? b.y0 : 0;
    const pos = FloorLayout.floorEquipPos(eq, cfg);
    return { x: bx + (cfg.anchor_x || 0) + pos.x, y: by + (cfg.anchor_y || 0) + pos.y, baseZ: FloorLayout.levelZ(m, FloorLayout.floorNum(fl)) };
  }
  /** Point MONDE 3D (base) d'un équipement posé sur un étage (analogue à `oobWorld`) : son ORIGINE ci-dessus,
      PLUS sa hauteur propre (`dc_z`). C'est le seul endroit du chemin d'étage où `dc_z` s'additionne. */
  equipFloorWorld(m: MultiLayout, eq: any): Vec3 {
    const o = this.equipFloorOrigin(m, eq);
    return { x: o.x, y: o.y, z: o.baseZ + FloorLayout.floorEquipHeight(eq) };
  }
}
