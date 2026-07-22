/* Couche CONTENU DE SCÈNE du moteur 3D WebGL (cf. en-tête de DcThreeBase) : construit baies + occupants
   (U / latéraux / muraux), montants 19″, équipements libres, waypoints (pins/rails) et câbles intra-salle
   (spline cardinal fidèle au SVG). Gère le diff d'options (reconstruction PARTIELLE par catégorie).
   Classe finale de la chaîne d'héritage → point d'entrée importé par DcBase. */
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { RackGeometry } from "../../../geometry/RackGeometry";
import { RackDoorGeometry } from "../../../geometry/RackDoorGeometry";
import { FreeEquipGeometry } from "../../../geometry/FreeEquipGeometry";
import { DoorGeometry } from "../../../geometry/DoorGeometry";
import type { DoorPt } from "../../../geometry/DoorGeometry";
import { CableSpline } from "../../../geometry/CableSpline";
import { Measure } from "../../../geometry/Measure";
import { Color } from "../../../core/Color";
import { Normalize } from "../../../core/Normalize";
import { EquipmentTypes } from "../../../registries/EquipmentTypes";
import { Depths } from "../../../registries/Depths";
import { U_MM, RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_EAR_MM, RACK_EAR_STANDOFF_MM, SIDE_U_STEP, BRUSH_PADDING_MM } from "../../../domain/constants";
import { Format } from "../../../core/Format";
import type { Vec3 } from "../shared";
import { DcThreeCamera } from "./DcThreeCamera";
import type { DcThreeOptions, RoomDesc, SceneCtx, Theme } from "./DcThreeBase";

export type { DcThreeOptions } from "./DcThreeBase";

const CABLE_PX = 1;          // épaisseur ÉCRAN (px) des câbles — alignée sur .dc-cable du SVG (1px), constante au zoom
const CABLE_OPACITY = 0.5;   // .dc-cable opacity: 0.5
const CABLE_PX_SEL = 2.5;    // .dc-cable.sel stroke-width: 2.5px (sélectionné)
const TRUNK_PX = 3;          // FAISCEAU : trait nettement plus ÉPAIS qu'un câble (gaine multi-fibres) — cf. .dc-trunk SVG
const TRUNK_PX_SEL = 4.5;    // faisceau sélectionné
const TRUNK_COLOR = 0x9aa6b8;   // couleur NEUTRE d'un faisceau (il n'a pas UN réseau : ses brins en portent plusieurs)
const MARK_PX = 27;          // rayon ÉCRAN (px) d'un marqueur de waypoint — base SVG (DC_DOT_PX+4 = 9) ×3 (+200 %, lisibilité/cliquabilité au routage) ; modulable par le réglage markerScale
const OOB_PX = 33;           // rayon ÉCRAN (px) d'un marqueur OOB — base 11 ×3 (idem)
const DOT_PX = 5;            // rayon ÉCRAN (px) d'une pastille d'extrémité de câble (cf. SVG DC_DOT_PX)
const BOLT_PX = 10;          // demi-taille ÉCRAN (px) d'un éclair power bolt
// Tailles MONDE (mm) en mode « taille réelle » (opts.markerRealSize) — modulées par markerScale (100 % = valeurs ci-dessous).
const MARK_MM = 50;          // marqueur de waypoint : 5 cm × 5 cm
const OOB_MM = 50;           // marqueur OOB : même taille réelle que les waypoints (comportement IDENTIQUE salle / multi-DC)
const DOT_MM = 10;           // pastille d'extrémité de câble : ⌀ 1 cm (rayon 5 mm)
const CONDUIT_COLOR = 0x8a7a55;   // couleur des CONDUITS (brosses + bacs de chemins de câbles) — laiton discret
const TRAY_WALL_MM = 50;     // hauteur des flancs d'un BAC de chemin de câbles (rudimentaire, centré sur le rail)

export class DcThreeScene extends DcThreeCamera {
  // Forçage de RECONSTRUCTION complète au prochain rendu : armé quand les DONNÉES ont changé sans que l'ensemble
  // des salles ni les options ne bougent (ex. suppression d'un occupant / blanking plate). applyOptionsDiff ne sait
  // diffuser que les salles + options ; sans ce drapeau, une mutation intra-salle ne reconstruirait RIEN (mesh périmé).
  protected _forceBuild = false;
  /** Marque la scène comme PÉRIMÉE : le prochain rendu (diff léger OU mount) repassera par un build() complet. */
  markStale(): void { this._forceBuild = true; }

  /* ---- construction de la scène (mono- ou multi-salles) ---- */
  protected build(dcId: string | null): void {
    if (!this.scene) return;
    this._forceBuild = false;   // ce build absorbe la péremption en attente
    this.faceUrlsInLastBuild.clear();   // build COMPLET → on re-collecte l'ensemble exact des URLs d'images posées (base de l'éviction)
    const theme = this.readTheme();
    this.scene.background = new THREE.Color(theme.bg);
    // (ré)éclairage : nettoyé puis reposé à chaque build
    const old = this.scene.children.filter((c: any) => c.userData.light);
    old.forEach((c) => this.scene!.remove(c));
    const hemi = new THREE.HemisphereLight(0xffffff, 0x222a35, 1.05); hemi.userData.light = true;
    const dir = new THREE.DirectionalLight(0xffffff, 1.1); dir.position.set(0.5, -0.7, 1); dir.userData.light = true;
    this.scene.add(hemi, dir);

    this.disposeContent();
    this.theme = theme; this._epoch++;   // invalide les chargements d'images async d'une construction précédente
    const root = new THREE.Group(); this.content = root; this.scene.add(root);

    const dc = dcId ? this.store.get("datacenters", dcId) : null;
    this.builtDc = dc ? dc.id : null;
    this.rooms = this.computeRooms(dc);
    if (!this.rooms.length) { this.pruneFaceTextureCache(); this.frameOnce("∅", 2000, 2000, 1000, 1000, 500, 500); return; }   // aucune salle → aucune image posée → tout devient périmé

    // sous-groupes par catégorie → reconstruction partielle (chacun contient un sous-groupe TRANSFORMÉ par salle)
    this.gDecor = new THREE.Group(); root.add(this.gDecor);
    this.gRacks = new THREE.Group(); root.add(this.gRacks);
    this.gFree = new THREE.Group(); root.add(this.gFree);
    this.gWaypoints = new THREE.Group(); root.add(this.gWaypoints);
    this.cablesGroup = new THREE.Group(); root.add(this.cablesGroup);
    this.gExtra = new THREE.Group(); root.add(this.gExtra);   // câbles transversaux (repère monde)

    this.gFloorDecor = new THREE.Group(); root.add(this.gFloorDecor);   // décor d'étage (multi)

    let maxH = U_MM * 42;
    this.rooms.forEach((room) => { maxH = Math.max(maxH, this.buildRoomContent(room)); });
    this._warm.clear(); this.rooms.forEach((room) => this._warm.set(room.dcId, ++this._warmTick));   // cache chaud = salles construites
    this.buildExtraCables(this.gExtra);   // routes inter-DC (multi) / stubs sortants (mono)
    this.buildFloorDecor(this.gFloorDecor);   // plans d'étage + OOB + étiquettes (multi)

    // z-buffer réel → AUCUN biais de profondeur par étage : les salles sont juste posées à leur Z.
    if (this.multiInfo) { const c = this.multiInfo.center, e = Math.max(1000, this.multiInfo.extent); this.frameOnce("M:" + this.roomsKey(), e, e, e, c.x, c.y, c.z); }
    else { const W = dc!.width_mm || 4000, D = dc!.depth_mm || 3000; this.frameOnce(dc!.id, W, D, maxH, W / 2, D / 2, maxH / 2); }
    this.collectScreenObjs();   // marqueurs à taille écran
    this.applyLayerVisibility();   // couches ports/noms/portes : visibilité initiale selon les options
    this.pruneFaceTextureCache();   // libère les textures d'images plus utilisées (image remplacée/supprimée, autre document)
  }

  /** Salles à construire : multi = descripteur fourni ; mono = la salle courante posée à l'IDENTITÉ. */
  protected computeRooms(dc: any): RoomDesc[] {
    if (this.multiInfo && this.multiInfo.rooms.length) return this.multiInfo.rooms;
    if (!dc) return [];
    const W = dc.width_mm || 4000, D = dc.depth_mm || 3000;
    return [{ dcId: dc.id, ox: W / 2, oy: D / 2, oz: 0, o: 0, w: W, d: D }];   // identité : roomToWorld(p) = p
  }

  protected roomsKey(): string { return this.rooms.map((r) => r.dcId).join(","); }

  /** Groupe TRANSFORMÉ d'une salle sous `parent` (roomToWorld = translate(off)·rotZ(o)·translate(−centre)) ;
      renvoie le groupe INTERNE où bâtir le contenu en coords LOCALES de salle (coin). Tagué par `dcId`
      (userData) → permet l'ajout/retrait INCRÉMENTAL d'une salle sans toucher aux autres. */
  protected roomUnder(parent: THREE.Group, room: RoomDesc): THREE.Group {
    const outer = new THREE.Group(); outer.position.set(room.ox, room.oy, room.oz); outer.rotation.z = room.o;
    outer.userData.dcId = room.dcId;
    const inner = new THREE.Group(); inner.position.set(-room.w / 2, -room.d / 2, 0);
    outer.add(inner); parent.add(outer);
    return inner;
  }

  /** Construit TOUTES les catégories d'UNE salle (chacune dans son groupe transformé) ; renvoie la hauteur max. */
  protected buildRoomContent(room: RoomDesc): number {
    const dcR = this.store.get("datacenters", room.dcId); if (!dcR) return U_MM * 42;
    this.buildDecor(dcR, this.roomUnder(this.gDecor!, room));
    const maxH = this.fillRacks(dcR, this.roomUnder(this.gRacks!, room));
    this.buildFreeEquip(dcR.id, this.roomUnder(this.gFree!, room));
    this.buildWaypoints(dcR.id, this.roomUnder(this.gWaypoints!, room));
    const cableRoom = this.roomUnder(this.cablesGroup!, room);
    this.buildCables(dcR.id, cableRoom);
    this.buildTrunks(dcR.id, cableRoom);   // faisceaux : même groupe que les câbles (mêmes bascules/rebuilds)
    return maxH;
  }

  /** Catégories portant des groupes de salle (pour les opérations incrémentales). */
  protected roomParents(): THREE.Group[] { return [this.gDecor, this.gRacks, this.gFree, this.gWaypoints, this.cablesGroup].filter(Boolean) as THREE.Group[]; }

  /** Retire (et libère) tous les groupes de la salle `dcId` dans chaque catégorie. */
  protected removeRoom(dcId: string): void {
    this.roomParents().forEach((parent) => {
      parent.children.slice().forEach((outer) => { if (outer.userData && outer.userData.dcId === dcId) { this.disposeGroup(outer as THREE.Group); parent.remove(outer); } });
    });
  }

  /** Met à jour la TRANSFORMÉE des groupes d'une salle conservée (sa position peut changer quand l'ensemble change). */
  protected updateRoomTransform(room: RoomDesc): void {
    this.roomParents().forEach((parent) => {
      parent.children.forEach((outer) => { if (outer.userData && outer.userData.dcId === room.dcId) { outer.position.set(room.ox, room.oy, room.oz); outer.rotation.z = room.o; } });
    });
  }

  /** OPTIMISATION : passe d'un ensemble de salles à un autre en ne touchant QUE le delta — retire les salles
      disparues, ajoute les nouvelles, repositionne les conservées (le pavage peut décaler les voisines).
      Les routes inter-DC (`gExtra`) dépendent de l'ensemble visible → recalculées (bien plus léger que tout refaire). */
  protected applyRoomDelta(newRooms: RoomDesc[]): void {
    this._epoch++;   // des salles changent → invalide les chargements d'images async périmés
    const wasCount = this.rooms.length;
    const nextIds = new Set(newRooms.map((r) => r.dcId));
    // salles qui sortent du champ → MASQUÉES (gardées chaudes), PAS détruites → retour instantané.
    this.rooms.forEach((r) => { if (!nextIds.has(r.dcId)) this.setRoomVisible(r.dcId, false); });
    newRooms.forEach((r) => {
      if (this._warm.has(r.dcId)) { this.setRoomVisible(r.dcId, true); this.updateRoomTransform(r); this.rebuildRoomCables(r); }   // chaude → révélée + recâblée (options câble ont pu changer)
      else this.buildRoomContent(r);   // 1re fois → construite
      this._warm.set(r.dcId, ++this._warmTick);
    });
    this.rooms = newRooms;
    this.evictWarm(nextIds);   // borne mémoire : détruit réellement les salles masquées les plus anciennes au-delà du plafond
    this.applyLayerVisibility();   // salles révélées : respecter les toggles d'affichage/masquage courants
    if (this.gExtra) { this.disposeGroup(this.gExtra); this.buildExtraCables(this.gExtra); }
    this.rebuildFloorDecor();   // pavage/étages changés → plans d'étage + OOB + étiquettes recalculés
    if (this.multiInfo) {
      const c = this.multiInfo.center, e = Math.max(1000, this.multiInfo.extent);
      this.frameArgs = [e, e, e, c.x, c.y, c.z]; this.framedDc = "M:" + this.roomsKey();
      // bascule simple↔multi (le nombre de salles franchit 1↔N) → RECADRE (fit) ; scope multi→multi → garde le zoom, recentre.
      if ((wasCount <= 1) !== (newRooms.length <= 1)) this.frame(e, e, e, c.x, c.y, c.z);
      else { this.target.set(c.x, c.y, c.z); this.updateCamera(); }
    }
  }

  /** Cache chaud : (dé)masque toutes les couches/groupes d'une salle (masquer ≠ détruire). */
  protected setRoomVisible(dcId: string, vis: boolean): void {
    this.roomParents().forEach((parent) => parent.children.forEach((outer) => { if (outer.userData && outer.userData.dcId === dcId) outer.visible = vis; }));
  }

  /** Reconstruit UNIQUEMENT les câbles intra-salle d'une salle réveillée (les options câble ont pu changer pendant
      qu'elle était masquée). Les baies/occupants/ports — la partie LOURDE — restent, eux, en cache chaud. */
  protected rebuildRoomCables(room: RoomDesc): void {
    if (!this.cablesGroup) return;
    this.cablesGroup.children.slice().forEach((o) => { if (o.userData && o.userData.dcId === room.dcId) { this.disposeGroup(o as THREE.Group); this.cablesGroup!.remove(o); } });
    const dcR = this.store.get("datacenters", room.dcId);
    if (dcR) { const g = this.roomUnder(this.cablesGroup, room); this.buildCables(dcR.id, g); this.buildTrunks(dcR.id, g); }
  }

  /** Évince (détruit réellement) les salles MASQUÉES les plus anciennes au-delà du plafond du cache chaud. */
  protected evictWarm(displayedIds: Set<string>): void {
    if (this._warm.size <= this._warmCap) return;
    const evictable = [...this._warm.entries()].filter(([id]) => !displayedIds.has(id)).sort((a, b) => a[1] - b[1]);
    while (this._warm.size > this._warmCap && evictable.length) { const id = evictable.shift()![0]; this.removeRoom(id); this._warm.delete(id); }
  }

  /** Décor d'une salle (sol + grille) en coords locales de salle. */
  protected buildDecor(dc: any, group: THREE.Group): void {
    const W = dc.width_mm || 4000, D = dc.depth_mm || 3000;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: this.theme.floor, roughness: 0.95, metalness: 0 }));
    floor.position.set(W / 2, D / 2, -1); floor.userData = { pick: { type: "room", id: dc.id } }; group.add(floor);   // clic droit sol → menu salle (activer / isoler / simple DC)
    group.add(this.gridLines(W, D, dc.cell_mm || 600, this.theme.grid));
    this.buildDoors(dc, group);   // portes collées aux murs (cadre/listel + vantail + passage)
  }

  /** Portes de salle en 3D : porte FERMÉE (vantail plein sur le PASSAGE LIBRE, debout dans le plan du mur) + LISTEL
      dessiné EN POINTILLÉ (le listel est « à l'intérieur » de l'ouverture : largeur = width, listel de chaque côté,
      passage libre = width − 2·listel au milieu). Le DÉBATTEMENT (rayon) est projeté au SOL sur la couche `doorswing`,
      pilotée par le MÊME toggle que les portes de baie (showDoorSwing). Cliquable (clic droit → édition). */
  protected buildDoors(dc: any, group: THREE.Group): void {
    const doors = dc.doors || []; if (!doors.length) return;
    const room = { w: dc.width_mm || 4000, h: dc.depth_mm || 3000 };
    const leafCol = 0xc6ccd2;
    doors.forEach((door: any) => {
      const g = DoorGeometry.geom(door, room), H = Math.max(100, door.height_mm || 2100), sw = g.swing, fr = door.frame_mm || 0;
      const pick = { type: "door", dcId: dc.id, id: door.id };
      // --- PORTE FERMÉE : vantail/vantaux à la PLEINE TAILLE du formulaire (largeur `a→b` × hauteur `H`), fins
      //     selon `swing`. DOUBLE BATTANT : la surface est SCINDÉE en deux boîtes a→milieu / milieu→b (le jeu
      //     visuel vient des arêtes). Semi-transparent SANS écrire la profondeur (depthWrite:false) → laisse voir
      //     la réservation du passage au travers, sans masquer le listel dans le tampon de profondeur. ---
      const th = 40;   // épaisseur du vantail
      const mid = { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 };
      const spans: Array<[DoorPt, DoorPt]> = (door.leaves === 2) ? [[g.a, mid], [mid, g.b]] : [[g.a, g.b]];
      spans.forEach(([p1, p2]) => {
        const lx = [p1.x, p2.x, p1.x + sw.x * th, p2.x + sw.x * th];
        const ly = [p1.y, p2.y, p1.y + sw.y * th, p2.y + sw.y * th];
        const x0 = Math.min(...lx), x1 = Math.max(...lx), y0 = Math.min(...ly), y1 = Math.max(...ly);
        const leafGeo = new THREE.BoxGeometry(Math.max(1, x1 - x0), Math.max(1, y1 - y0), H);
        const leaf = new THREE.Mesh(leafGeo, new THREE.MeshStandardMaterial({ color: leafCol, roughness: 0.6, metalness: 0.15, transparent: true, opacity: 0.5, depthWrite: false }));
        leaf.position.set((x0 + x1) / 2, (y0 + y1) / 2, H / 2); leaf.renderOrder = 2; leaf.userData = { pick }; group.add(leaf);
        const leafEdges = new THREE.LineSegments(new THREE.EdgesGeometry(leafGeo), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3 }));
        leafEdges.position.copy(leaf.position); group.add(leafEdges);
      });
      // --- LISTEL en POINTILLÉ = RÉSERVATION du passage À L'INTÉRIEUR de la surface de la porte : contour ⊓ aux bords
      //     du passage (clearHinge / clearLatch, ex. X5 et X25 pour 30 de large × listel 5), du SOL jusqu'à H − listel ;
      //     linteau à H − listel. Toujours plus PETIT que la porte (le listel est la butée de fermeture). Occulté par
      //     la géométrie de la pièce (depthTest normal), visible seulement au travers du vantail (depthWrite:false). ---
      if (fr > 0) {
        const zTop = Math.max(0, H - fr);
        this.dashedPath(group, [[g.clearHinge, 0], [g.clearHinge, zTop], [g.clearLatch, zTop], [g.clearLatch, 0]], pick);
      }
      // --- DÉBATTEMENT (rayon) projeté au SOL, un secteur PAR VANTAIL — couche "doorswing" (même toggle que les baies). ---
      DoorGeometry.leaves(g, door).forEach((lf) => this.buildRoomDoorSwing(group, lf));
    });
  }

  /** Polyligne OUVERTE en POINTILLÉ (⊓, pas de fermeture) dans le plan du mur, à partir de points 2D salle + hauteur z.
      Test de profondeur NORMAL (occulté par les murs/baies) mais dessiné APRÈS le vantail (renderOrder) qui n'écrit pas
      la profondeur → visible seulement AU TRAVERS de la porte, pas à travers toute la pièce. `pick` pour l'édition. */
  protected dashedPath(group: THREE.Group, pts: [DoorPt, number][], pick: any): void {
    const flat: number[] = [];
    pts.forEach(([p, z]) => flat.push(p.x, p.y, z));
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0x9aa2ab, dashSize: 70, gapSize: 45, transparent: true, opacity: 0.95 }));
    line.computeLineDistances(); line.renderOrder = 3; line.userData = { pick }; group.add(line);
  }

  /** Débattement 3D d'UN VANTAIL de porte de SALLE : secteur rempli (quart de disque) projeté au sol (z≈1), centré
      sur sa charnière, rayon = largeur du vantail. Couche "doorswing" (non interactive) → basculée par showDoorSwing,
      comme le débattement des portes de baie (buildDoorSwing). Même style visuel (remplissage translucide + contour). */
  protected buildRoomDoorSwing(group: THREE.Group, lf: { hinge: DoorPt; latch: DoorPt; open: DoorPt }): void {
    const Z = 1, arc = DoorGeometry.leafArc(lf, 20), cx = lf.hinge.x, cy = lf.hinge.y;
    const fill: number[] = [];
    for (let i = 0; i < arc.length - 1; i++) fill.push(cx, cy, Z, arc[i].x, arc[i].y, Z, arc[i + 1].x, arc[i + 1].y, Z);
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(fill, 3)); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: this.theme.front, transparent: true, opacity: 0.16, emissive: 0x16314e, side: THREE.DoubleSide, depthWrite: false }));
    mesh.userData = { layer: "doorswing" }; group.add(mesh);
    const pts: number[] = [cx, cy, Z]; arc.forEach((p) => pts.push(p.x, p.y, Z));
    const bg = new THREE.BufferGeometry(); bg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const loop = new THREE.LineLoop(bg, new THREE.LineBasicMaterial({ color: this.theme.front, transparent: true, opacity: 0.6 }));
    loop.userData = { layer: "doorswing" }; group.add(loop);
  }

  /** Remplit le groupe des baies d'une salle ; renvoie la hauteur max (cadrage). */
  protected fillRacks(dc: any, group: THREE.Group): number {
    let maxH = U_MM * 42;
    this.store.racksOfDc(dc.id).forEach((r: any) => { const g = this.rackGroup(r); group.add(g.group); this.buildRackPorts(r, group); maxH = Math.max(maxH, g.height); });
    return maxH;
  }

  /** Ports des équipements de la BAIE posés À PLAT sur leur face — en coords MONDE (gRacks = identité).
      Couvre TOUS les montages rattachés à la baie : rackés (U), MARGE LATÉRALE (side), PAROI (wall) et POSÉS
      sur une étagère (tray) — leurs boîtes sont dessinées dans rackGroup et Resolver3D résout chacun de ces
      placements ; avant ce correctif, seuls les rackés (U) recevaient leurs connecteurs. */
  protected buildRackPorts(r: any, group: THREE.Group): void {
    // toujours construits (visibilité gérée par applyLayerVisibility / showPorts) → bascule sans reconstruction.
    const add = (eqId: string, eqSide: string) => this.store.portsOf(eqId).forEach((p: any) => this.addPort(group, p, r.datacenter_id, { eqSide, rackId: r.id }));
    this.scene3d.occupantsElev(r.id).forEach((oc: any) => {
      if (oc.kind !== "eq") return;
      add(oc.id, oc.side !== "rear" ? "front" : "rear");   // les ports suivent leur équipement (côté) ET leur baie (masquage)
    });
    this.scene3d.sideOccupants(r.id, null, null).forEach((e: any) => add(e.id, e.side_face !== "rear" ? "front" : "rear"));
    this.scene3d.wallOccupants(r.id, null, null).forEach((e: any) => add(e.id, e.wall_margin !== "rear" ? "front" : "rear"));
    this.store.rackItemsOf(r.id).forEach((it: any) => {
      if (it.kind !== "tray" || it.u == null) return;
      const eqSide = it.side !== "rear" ? "front" : "rear";
      this.store.equipmentsOnTray(it.id).forEach((e: any) => add(e.id, eqSide));
    });
  }

  /** Connecteur d'un port : petit plan à la position MONDE du port, orienté selon sa normale de face.
      Coloré par le réseau du câble s'il est câblé (sinon gris) ; cliquable → câble (édition / création préremplie). */
  protected addPort(group: THREE.Group, p: any, dcId: string, extra?: any): void {
    if (p.face_x == null || p.face_y == null) return;
    const pt: any = this.resolver.resolvePort3D(p.id, dcId); if (!pt) return;
    const cab = this.store.cableOnPort(p.id);
    const col = cab ? this.cableColorHex(cab) : 0x8893a5;
    const csz = this.store.portConnectorSize(p);
    // Taille PHYSIQUE réelle du connecteur (SFP/RJ45/C13…) — la fidélité dimensionnelle prime, PAS d'agrandissement.
    const w = Math.max(2, csz.w), h = Math.max(2, csz.h);
    const n = new THREE.Vector3(pt.n ? pt.n.x : 0, pt.n ? pt.n.y : 0, pt.n ? pt.n.z : 1);
    if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
    n.normalize();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: 0.2, emissive: cab ? 0x0e1216 : 0x000000, side: THREE.DoubleSide }));
    mesh.position.set(pt.x + n.x * 1.5, pt.y + n.y * 1.5, pt.z + n.z * 1.5);   // 1,5 mm hors de la face
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    mesh.userData = Object.assign({ pick: { type: "port", id: p.id, cable: cab ? cab.id : null }, layer: "port" }, extra);   // couche "port" (+ côté éventuel)
    // bordure NOIRE (cadre du connecteur, comme le SVG) — enfant → hérite de la pose
    const hw = w / 2, hh = h / 2, bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.Float32BufferAttribute([-hw, -hh, 0, hw, -hh, 0, hw, hh, 0, -hw, hh, 0], 3));
    mesh.add(new THREE.LineLoop(bg, new THREE.LineBasicMaterial({ color: 0x000000 })));
    group.add(mesh);
  }

  /* ---- reconstructions PARTIELLES (par catégorie, sur TOUTES les salles) ---- */
  protected eachRoom(parent: THREE.Group, fn: (dc: any, g: THREE.Group) => void): void {
    this.disposeGroup(parent);
    this.rooms.forEach((room) => { const dcR = this.store.get("datacenters", room.dcId); if (dcR) fn(dcR, this.roomUnder(parent, room)); });
  }
  protected rebuildRacks(): void { this._epoch++; if (this.gRacks) this.eachRoom(this.gRacks, (dc, g) => this.fillRacks(dc, g)); this.applyLayerVisibility(); }
  protected rebuildFree(): void { if (this.gFree) this.eachRoom(this.gFree, (dc, g) => this.buildFreeEquip(dc.id, g)); this.applyLayerVisibility(); }

  /** Bascule en VISIBILITÉ (sans reconstruction) les couches décoratives taguées `userData.layer` :
      ports (showPorts), noms (showEqNames), portes (showDoors). Toujours construites → un toggle ne fait que
      `.visible = …` au lieu de rebâtir toute la géométrie des baies. Le picking ignore les meshes masqués. */
  /** Visibilité d'un mesh d'après son `userData` ({layer, eqSide}) et les options courantes : couche affichée ET
      côté non masqué (hideAv/Ar). Utilisé par applyLayerVisibility ET par les images de façade (pose async). */
  protected layerVisible(u: any): boolean {
    if (!u) return true;
    const o = this.opts;
    if (u.rackId && o.hiddenRacks && o.hiddenRacks.has(u.rackId)) return false;   // baie masquée → tout son contenu (groupe + ports)
    const on: Record<string, boolean> = { port: !!o.showPorts, name: !!o.showEqNames, door: !!o.showDoors, doorswing: !!o.showDoorSwing, slot: !!o.showPlaceholders, faceImage: !!o.showFaceImages, conduit: !!o.showConduits, marker: !!o.showWaypoints, rail: !!(o.showWaypoints || o.showConduits), floorgrid: !!o.showFloorGrid, orient: !!o.showOrientMarks, rackshell: !!o.showRackSides,
      // numéro d'U sur les emplacements LIBRES : visible seulement si les emplacements libres ET les noms d'équipement sont affichés.
      slotlabel: !!o.showPlaceholders && !!o.showEqNames };
    let v = true;
    if (u.layer && u.layer in on) v = on[u.layer];
    if (v && u.eqSide) v = u.eqSide === "rear" ? !o.hideRearEq : !o.hideFrontEq;
    return v;
  }

  /** Applique la visibilité des couches taguées (ports/noms/portes/débattement/emplacements/images de façade)
      et des côtés (hideAv/Ar) — sans reconstruction ; le picking ignore déjà les meshes masqués. */
  protected applyLayerVisibility(): void {
    [this.gRacks, this.gFree, this.gWaypoints, this.gFloorDecor, this.gDecor].forEach((g) => g && g.traverse((o: any) => { const u = o.userData; if (u && (u.layer || u.eqSide || u.rackId)) o.visible = this.layerVisible(u); }));
  }

  /** Recolore EN PLACE les occupants selon `colorMode` (face/groupe/type) — sans reconstruction. */
  protected applyColorMode(): void {
    [this.gRacks, this.gFree].forEach((g) => g && g.traverse((o: any) => {
      const p = o.userData && o.userData.pick; if (!(p && p.type === "occ")) return;
      const col = this.occColor({ kind: p.kind, id: p.id }), m: any = (o as any).material;
      // multi-matériaux (boîte d'équip. libre à 6 faces) : recolorer chaque face SANS image (les texturées gardent
      // leur blanc pour afficher l'image fidèlement). Mono-matériau (occupant de baie) : recolorer si pas de texture.
      if (Array.isArray(m)) m.forEach((x: any) => { if (x && x.color && !x.map) x.color.setHex(col); });
      else if (m && m.color && !m.map) m.color.setHex(col);
    }));
  }
  protected rebuildWaypoints(): void { if (this.gWaypoints) this.eachRoom(this.gWaypoints, (dc, g) => this.buildWaypoints(dc.id, g)); this.collectScreenObjs(); this.applyLayerVisibility(); }
  protected rebuildCables(): void {
    if (this.cablesGroup) this.eachRoom(this.cablesGroup, (dc, g) => { this.buildCables(dc.id, g); this.buildTrunks(dc.id, g); });
    if (this.gExtra) { this.disposeGroup(this.gExtra); this.buildExtraCables(this.gExtra); }
    this.collectScreenObjs();   // pastilles d'extrémité = taille écran
  }

  /** Applique de nouvelles options en NE reconstruisant que les catégories affectées (diff). Changement de
      salle(s) / pas de scène → full build. Un toggle non câblé au moteur WebGL → aucune reconstruction. */
  applyOptionsDiff(opts: DcThreeOptions, dcId: string | null, ctx?: SceneCtx): void {
    const old = this.opts; this.opts = opts;
    const multi = ctx ? ctx.multi : null;
    const newKey = (multi && multi.rooms.length) ? "M:" + multi.rooms.map((r) => r.dcId).join(",") : (dcId || "∅");
    const wasMulti = !!this.multiInfo;
    const curKey = wasMulti ? "M:" + this.roomsKey() : (this.builtDc || "∅");
    this.multiInfo = multi; this.extraCables = ctx ? ctx.extraCables : []; this.floorDecor = ctx ? ctx.floorDecor : null;   // FIX : sinon décor d'étage périmé sur bascule multi↔mono
    // données périmées (mutation intra-salle : occupant supprimé, etc.) → reconstruction COMPLÈTE, le diff par
    // catégorie ne couvre pas les changements de contenu d'une salle conservée (mêmes salles + mêmes options).
    if (this._forceBuild) { this.build(dcId); this.request(); return; }
    if (old.showPivot !== opts.showPivot) { this.updatePivot(); this.request(); }   // centre de rotation : simple (dé)masquage, aucun rebuild
    // TOUS les toggles d'affichage sont en VISIBILITÉ (couches taguées, toujours construites) — AUCUN rebuild :
    // ports, noms, portes, débattement, emplacements, images, masquage av/ar, conduits, waypoints, grilles, repères,
    // capots/parois (rackshell) et masquage de baies (hidden3dRacks).
    const eqVis = old.showPorts !== opts.showPorts || old.showEqNames !== opts.showEqNames || old.showDoors !== opts.showDoors || old.showDoorSwing !== opts.showDoorSwing || old.hideFrontEq !== opts.hideFrontEq || old.hideRearEq !== opts.hideRearEq || old.showPlaceholders !== opts.showPlaceholders || old.showFaceImages !== opts.showFaceImages || old.showConduits !== opts.showConduits || old.showWaypoints !== opts.showWaypoints || old.showFloorGrid !== opts.showFloorGrid || old.showOrientMarks !== opts.showOrientMarks || old.showRackSides !== opts.showRackSides || !this.sameSet(old.hiddenRacks, opts.hiddenRacks);
    // baies — RECOLORATION en place (mode couleur) : aucun rebuild.
    const eqColor = old.colorMode !== opts.colorMode;
    const cb = old.showAllCables !== opts.showAllCables || old.cableSplineK !== opts.cableSplineK || old.cablePortNormal !== opts.cablePortNormal || !this.sameSet(old.selCables, opts.selCables);   // cablesOnTop NON inclus : géré en place par setCablesOnTop (pas de reconstruction)
    // OPTIMISATION : multi→multi, seul l'ensemble des salles change (options inchangées) → delta de salles (pas de full rebuild).
    if (this.content && wasMulti && multi && multi.rooms.length && curKey !== newKey && !(eqVis || eqColor || cb)) {
      this.applyRoomDelta(multi.rooms); this.request(); return;
    }
    if (!this.content || curKey !== newKey) { this.build(dcId); this.request(); return; }
    if (eqVis) this.applyLayerVisibility(); if (eqColor) this.applyColorMode();   // visibilité / recoloration en place (jamais de rebuild)
    // équipements LIBRES masqués : ils sont SAUTÉS à la construction (pas de couche de visibilité) → reconstruire le
    // seul groupe des équipements libres (peu coûteux). Distinct de hiddenRacks (visibilité en place).
    const figChanged = old.showFigure !== opts.showFigure || JSON.stringify(old.figure || null) !== JSON.stringify(opts.figure || null);
    const freeVis = !this.sameSet(old.hiddenEquips || new Set(), opts.hiddenEquips || new Set()) || figChanged;   // le personnage vit dans le groupe libre
    if (freeVis) this.rebuildFree();
    if (cb) this.rebuildCables();
    if (eqVis || eqColor || cb || freeVis) this.request();
  }

  private sameSet(a: Set<string>, b: Set<string>): boolean { if (a.size !== b.size) return false; for (const x of a) if (!b.has(x)) return false; return true; }

  /* ---- baies + occupants ---- */
  /** Une baie : groupe positionné/orienté dans la salle + coque translucide + occupants (U / latéraux / muraux) + montants. */
  protected rackGroup(r: any): { group: THREE.Group; height: number } {
    const theme = this.theme;
    const w = r.width_mm || RACK_WIDTH_DEFAULT, d = r.depth || RACK_DEPTH_DEFAULT, H = RackGeometry.physHeight(r);
    const cx = (r.dc_x != null) ? r.dc_x : w / 2, cy = (r.dc_y != null) ? r.dc_y : d / 2;
    const o = Normalize.rackOrientation(r.orientation) * Math.PI / 180;
    const group = new THREE.Group();
    group.position.set(cx, cy, 0);
    group.rotation.z = o;   // les enfants sont en coords LOCALES (x=largeur, y=profondeur, z=hauteur)
    group.userData = { rackId: r.id };   // baie masquable EN VISIBILITÉ (hidden3dRacks) → groupe entier (sauf ports, hors groupe)

    // COQUE : parois latérales (±X) + faces av/ar (∓Y) et toit/sol (±Z) transparentes (capots à part, percés).
    // Baie AVEC capots : parois OPAQUES, couche "rackshell" basculable en visibilité (showRackSides) — masquage =
    // on voit l'intérieur (pas de box translucide). Baie SANS capots (châssis ouvert, has_caps=false) : parois
    // TRANSLUCIDES et TOUJOURS AFFICHÉES (hors couche — le toggle d'affichage ne les concerne pas : l'attribut est
    // PHYSIQUE, le fantôme matérialise le volume ouvert). Les ARÊTES restent toujours visibles (contour de la baie).
    const capless = r.has_caps === false;
    const shellGeo = new THREE.BoxGeometry(w, d, H);
    const cap = new THREE.MeshStandardMaterial({ color: theme.rack, roughness: 0.8, metalness: 0.1, side: THREE.DoubleSide, ...(capless ? { transparent: true, opacity: 0.16, depthWrite: false } : {}) });
    const open = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const shellMat = [cap, cap, open, open, open, open];   // ordre BoxGeometry : +X, −X, +Y(arr), −Y(av), +Z(toit), −Z(sol)
    const shell = new THREE.Mesh(shellGeo, shellMat); shell.position.set(0, 0, H / 2);
    shell.userData = capless ? { pick: { type: "rack", id: r.id } } : { pick: { type: "rack", id: r.id }, layer: "rackshell" };   // cliquable = baie · couche capot (sauf châssis ouvert : toujours visible)
    group.add(shell);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(shellGeo), new THREE.LineBasicMaterial({ color: theme.line }));
    edges.position.set(0, 0, H / 2); group.add(edges);   // contour TOUJOURS visible (repère de la baie même capot masqué)
    // liseré AVANT (arête basse de la face avant, y = -d/2) — repère d'orientation
    const frontGeo = new THREE.BufferGeometry();
    frontGeo.setAttribute("position", new THREE.Float32BufferAttribute([-w / 2, -d / 2, 1, w / 2, -d / 2, 1], 3));
    group.add(new THREE.LineSegments(frontGeo, new THREE.LineBasicMaterial({ color: theme.front })));

    // capots TOIT/SOL : plaques séparées PERCÉES (trous aux cellules). Toujours construites → couche "rackshell".
    const gC = RackGeometry.capGrid(r);
    this.buildCapPlate(group, r, "roof", H, w, d, gC.cell, theme);
    this.buildCapPlate(group, r, "floor", 0, w, d, gC.cell, theme);

    // occupants U (équipements rackés + pseudo-items + brosses)
    // Convention du moteur SVG (rackInterior3D) : la face AVANT est en y = -hd (−Y).
    // La PROFONDEUR du caisson = mountSpanMm (idem SVG) → sa face extérieure rejoint exactement le port résolu.
    const baseZ = RackGeometry.uBaseZ(r), hd = d / 2;
    const fmY = RackGeometry.frontMargin(r), cageY = Math.min(d, RackGeometry.cageDepth(r));
    const fpY = -hd + fmY, rpY = -hd + fmY + cageY;   // plan avant (−Y) · plan arrière (+Y)
    const frontExtra = RackGeometry.doorExtraDepth(r, "front"), rearExtra = RackGeometry.doorExtraDepth(r, "rear");
    const occ = this.scene3d.occupantsElev(r.id);
    occ.forEach((u) => {
      // TRAY (étagère) : géométrie DÉDIÉE (plateau + accroches/renforts + espace réservé) — pas de caisson générique.
      if (u.kind === "item" && u.itemKind === "tray") { this.buildTrayItem(group, r, u, baseZ, fpY, rpY, theme); return; }
      // KEEPBLANK : AUCUN objet physique — matérialisé par une bande d'emplacement HACHURÉE (couche "slot"),
      // cliquable pour libérer la réservation. Ses U restent OCCUPÉS (aucune affectation possible).
      if (u.kind === "item" && u.itemKind === "keepblank") { this.buildKeepblankBand(group, r, u, baseZ, fpY, rpY); return; }
      const front = u.side !== "rear", eqSide = front ? "front" : "rear";   // côté → bascule hideAv/Ar EN VISIBILITÉ
      const span = Depths.mountSpanMm(u, cageY + (front ? frontExtra : rearExtra));
      // FAÇADE DEVANT LA CAGE : tout occupant (équipement OU pseudo) est posé RACK_EAR_STANDOFF_MM devant
      // le plan de montage (réserve d'oreilles standard) + l'éventuel DÉBORD propre (face_offset_mm — le
      // corps dépasse les oreilles, rare). Parité avec Resolver3D (les ports restent SUR les faces).
      const faceOff = RACK_EAR_STANDOFF_MM + Math.max(0, u.face_offset_mm || 0);
      // BLANKING PLATE : plaque MINCE (épaisseur des oreilles, RACK_EAR_STANDOFF_MM) plaquée à la façade ;
      // équipement : profondeur RÉELLE (mountSpanMm).
      const blank = u.kind === "item" && u.itemKind === "blank";
      const depth = blank ? RACK_EAR_STANDOFF_MM : Math.max(6, span);
      const y0 = front ? fpY - faceOff : rpY + faceOff - depth;
      const y1 = front ? fpY - faceOff + depth : rpY + faceOff;
      // ÉQUIPEMENT : corps à sa largeur RÉELLE — pleine largeur du CORPS 19″ par défaut, ou `u_width_mm`
      // (boîtier RÉTRÉCI, petit switch…) DÉCALÉ selon `u_align` (vu de face) ; les oreilles COMMENCENT à son
      // bord et rejoignent les rails (asymétriques si rétréci/aligné). BLANKING PLATE : panneau de façade
      // COMPLET (il couvre corps + oreilles, vissé sur les rails).
      const eqRec: any = u.kind === "eq" ? this.store.get("equipments", u.id) : null;
      const bw = u.kind === "eq" ? RackGeometry.eqBodyWidth(eqRec) : RACK_MOUNT_WIDTH;
      const xc = u.kind === "eq" ? RackGeometry.eqBodyOffsetX(eqRec) : 0;
      const bd = y1 - y0, yc = (y0 + y1) / 2;
      const bh = Math.max(2, u.h * U_MM - 2);
      const zc = baseZ + (u.u - 1) * U_MM + (u.h * U_MM) / 2;
      const color = this.occColor(u);
      const geo = new THREE.BoxGeometry(bw, bd, bh);
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.15 });
      const mesh = new THREE.Mesh(geo, mat); mesh.position.set(xc, yc, zc);
      mesh.userData = { pick: { type: "occ", kind: u.kind, id: u.id }, eqSide };
      group.add(mesh);
      const occEdges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }));
      occEdges.position.set(xc, yc, zc); occEdges.userData = { eqSide }; group.add(occEdges);
      // nom posé À PLAT sur les DEUX faces du caisson : −Y (avant) ET +Y (arrière) → lisible des deux côtés de la
      // baie. Couche "name" + côté (showEqNames / hideAv-Ar).
      if (u.kind === "eq" && u.label) {
        this.faceLabel(group, u.label, xc, y0 - 0.5, zc, bw * 0.94, bh * 0.9, true, { eqSide });    // face −Y (avant)
        this.faceLabel(group, u.label, xc, y1 + 0.5, zc, bw * 0.94, bh * 0.9, false, { eqSide });   // face +Y (arrière)
      }
      // FAÇADES + OREILLES 19″. La face AVANT du device (u0 si monté-avant, sinon u1) porte des OREILLES :
      // plaques PERPENDICULAIRES au corps, dans la CONTINUITÉ de sa face — elles REMPLISSENT la réserve
      // standard (plan de montage → façade), plus besoin de les poser « par-dessus » pour esquiver les
      // montants. En cas de DÉBORD (face_offset_mm > 0), elles restent au plan standard (le corps les
      // dépasse) et une image « avec oreilles » est TRIMMÉE au corps (recadrage texture) — dessiner des
      // oreilles d'image décollées des rails compliquerait l'affichage pour rien.
      if (u.kind === "eq") {
        const mountHW = RACK_MOUNT_WIDTH / 2;
        const protrudes = Math.max(0, u.face_offset_mm || 0) > 0;
        const drawFace = (img: { url: string; withEars: boolean } | null | undefined, planeY: number, planeFront: boolean, deviceFront: boolean): void => {
          if (deviceFront) {   // OREILLES : dans la réserve standard, des BORDS du boîtier (xc ± bw/2) aux rails (±mountHW) — asymétriques si boîtier rétréci/aligné
            const eY0 = front ? fpY - RACK_EAR_STANDOFF_MM : rpY;
            const eY1 = front ? fpY : rpY + RACK_EAR_STANDOFF_MM;
            [[-mountHW, xc - bw / 2], [xc + bw / 2, mountHW]].forEach((xr) => { if (xr[1] - xr[0] > 0.5) this.localBox(group, xr[0], xr[1], eY0, eY1, zc - bh / 2, zc + bh / 2, theme.rack, { type: "occ", kind: u.kind, id: u.id }, { eqSide }); });
          }
          if (img) {
            // « AVEC OREILLES » : panneau 19″ COMPLET (posé pleine largeur même pour un boîtier rétréci — l'image
            // couvre corps + oreilles étendues), sauf débord (image trimmée au corps). « FACE SEULE » : limitée à
            // la largeur RÉELLE du boîtier, à son décalage d'alignement.
            const wide = deviceFront && img.withEars && !protrudes;
            const w = wide ? RACK_MOUNT_WIDTH : bw;
            const xImg = wide ? 0 : xc;
            // trim (débord + « avec oreilles » → recadrée au corps) : fraction par CÔTÉ — symétrique (approximation
            // assumée pour le cas rare³ débord + boîtier rétréci + alignement excentré).
            const trim = (deviceFront && img.withEars && protrudes) ? (RACK_MOUNT_WIDTH - bw) / 2 / RACK_MOUNT_WIDTH : 0;
            this.faceImagePlane(group, img.url, xImg, planeY, zc, w, bh, planeFront, { layer: "faceImage", eqSide, eqId: u.id }, trim);   // eqId → inclus dans le survol/localisation
          }
        };
        drawFace(this.host.faceImageUrl?.(u.id, front ? "front" : "rear"), y0 - 0.5, true, front);
        drawFace(this.host.faceImageUrl?.(u.id, front ? "rear" : "front"), y1 + 0.5, false, !front);
      }
    });

    // équipements montés en MARGE LATÉRALE (side) et en PAROI (wall) : boîtes pleines (dims libres).
    this.scene3d.sideOccupants(r.id, null, null).forEach((e: any) => {
      const eqSide = e.side_face !== "rear" ? "front" : "rear";
      const b = RackGeometry.sideEquipBoxLocal(r, e);
      this.localBox(group, b.x0, b.x1, b.y0, b.y1, b.z0, b.z1, this.occColor({ kind: "eq", id: e.id }), { type: "occ", kind: "eq", id: e.id }, { eqSide });
    });
    this.scene3d.wallOccupants(r.id, null, null).forEach((e: any) => {
      const eqSide = e.wall_margin !== "rear" ? "front" : "rear";
      const b = RackGeometry.wallEquipBoxLocal(r, e);
      this.localBox(group, b.x0, b.x1, b.y0, b.y1, b.z0, b.z1, this.occColor({ kind: "eq", id: e.id }), { type: "occ", kind: "eq", id: e.id }, { eqSide });
    });
    // équipements POSÉS sur les étagères (tray) de la baie : boîtes pleines sur le plateau, cliquables.
    this.store.rackItemsOf(r.id).forEach((it: any) => {
      if (it.kind !== "tray" || it.u == null) return;
      const eqSide = it.side !== "rear" ? "front" : "rear";
      this.store.equipmentsOnTray(it.id).forEach((e: any) => {
        const b = RackGeometry.trayEquipBoxLocal(r, it, e);
        this.localBox(group, b.x0, b.x1, Math.min(b.y0, b.y1), Math.max(b.y0, b.y1), b.z0, b.z1, this.occColor({ kind: "eq", id: e.id }), { type: "occ", kind: "eq", id: e.id }, { eqSide });
      });
    });

    // montants 19″ : à l'entraxe ±RACK_MOUNT_WIDTH/2, leur face EXTÉRIEURE au plan de montage RÉEL (fpY/rpY, =
    // dimensions EXTÉRIEURES de la cage − marge avant) et dessinés VERS L'INTÉRIEUR → ils passent DERRIÈRE la façade
    // et les oreilles des équipements (posés ~1 mm devant), sans plus les masquer.
    const postX = RACK_MOUNT_WIDTH / 2, pw = Math.min(RACK_EAR_MM * 0.8, 8), RAIL_D = 6;
    const pz1 = baseZ + (r.u_count || 42) * U_MM;
    const rails = (r.sides === "dual") ? [{ y: fpY, dir: 1 }, { y: rpY, dir: -1 }] : [{ y: fpY, dir: 1 }];
    rails.forEach(({ y, dir }) => { const lo = Math.min(y, y + dir * RAIL_D), hi = Math.max(y, y + dir * RAIL_D);
      [postX, -postX].forEach((px) => this.localBox(group, px - pw, px + pw, lo, hi, baseZ, pz1, theme.line)); });

    // BROSSES de brassage ancrées à cette baie : coque creuse + tunnel av→ar. TOUJOURS construites → couche
    // "conduit" basculable (showConduits) en visibilité, sans reconstruction.
    {
      const bodyHW = RACK_MOUNT_WIDTH / 2 - RACK_EAR_MM;
      this.store.all("waypoints").forEach((wp: any) => { if (wp.kind === "brush" && wp.rack_id === r.id) this.buildBrush(group, wp, baseZ, fpY, cageY, bodyHW, theme); });
    }

    // emplacements LIBRES (cibles d'assignation) — TOUJOURS construits → couche "slot" (showPlaceholders) + côté
    // (hideAv/Ar) basculables EN VISIBILITÉ sans reconstruction (le picking ignore les emplacements masqués).
    // FUSION EN BANDES : les emplacements CONTIGUS (U consécutifs · rangées latérales/murales consécutives)
    // forment UN SEUL mesh — un par U/rangée mettait les iGPU à genoux (une baie vide ≈ 500 objets transparents ;
    // 6 baies ≈ 3 000 draw calls). Le U / uTop PRÉCIS est recalculé AU CLIC depuis le point d'impact
    // (cf. DcThreeCamera.slotRowFromHit) : le descripteur de pick porte la plage (uLo/uHi + rowStep).
    {
      const occMap = this.scene3d.occupants(r.id), uMax = r.u_count || 42, bodyHW = RACK_MOUNT_WIDTH / 2 - RACK_EAR_MM;
      const sides = (r.sides === "dual") ? ["front", "rear"] : ["front"];
      sides.forEach((side) => {
        const yPlane = side === "rear" ? rpY - 2 : fpY + 2;
        let u = 1;
        while (u <= uMax) {
          if (occMap.has(u + ":" + side)) { u++; continue; }
          let uHi = u; while (uHi + 1 <= uMax && !occMap.has((uHi + 1) + ":" + side)) uHi++;   // bande contiguë [u..uHi]
          const nU = uHi - u + 1, zc = baseZ + (u - 1 + nU / 2) * U_MM;
          // quadrillage par U (séparateurs dans la géométrie de cadre) + numéros d'U en UNE texture par bande.
          this.slotPlane(group, 2 * bodyHW * 0.96, nU * U_MM - 3, 0, yPlane, zc, side === "front",
            { type: "slotU", rackId: r.id, u, side, height: 1, uLo: u, uHi, rowStep: 1 }, { layer: "slot", eqSide: side }, { pitch: U_MM, count: nU });
          this.bandULabels(group, u, uHi, yPlane, baseZ, side, 2 * bodyHW * 0.96);
          u = uHi + 1;
        }
      });
      // Regroupe des rangées LIBRES en couloirs contigus (clé de colonne + uTop consécutifs au pas SIDE_U_STEP).
      const mergeRuns = (rows: any[], keyOf: (s: any) => string): Array<{ first: any; uLo: number; uHi: number }> => {
        const byCol = new Map<string, any[]>();
        rows.forEach((s) => { const k = keyOf(s); const a = byCol.get(k) || []; a.push(s); byCol.set(k, a); });
        const runs: Array<{ first: any; uLo: number; uHi: number }> = [];
        byCol.forEach((list) => {
          list.sort((a, b) => a.uTop - b.uTop);
          let i = 0;
          while (i < list.length) {
            let j = i; while (j + 1 < list.length && list[j + 1].uTop === list[j].uTop + SIDE_U_STEP) j++;
            runs.push({ first: list[i], uLo: list[i].uTop, uHi: list[j].uTop });
            i = j + 1;
          }
        });
        return runs;
      };
      // emplacements LATÉRAUX libres (marges) → cibles d'assignation (équipement / pin latéral).
      // décalés très légèrement vers l'EXTÉRIEUR (le long de la normale de face) pour ne pas cliper dans la coque.
      const SLOT_OFF = 2;
      const xLim = w / 2 - SLOT_OFF;   // bord latéral max = position des slots de paroi (s'arrête avant le capot/la paroi)
      mergeRuns(this.scene3d.sideFreeSlots(r), (s) => s.face + "|" + s.lr + "|" + s.col).forEach((run) => {
        const s = run.first, front = s.face !== "rear";
        const bLo = RackGeometry.sideSlotBoxLocal(r, s.face, s.lr, s.col, run.uLo, SIDE_U_STEP);
        const bHi = RackGeometry.sideSlotBoxLocal(r, s.face, s.lr, s.col, run.uHi, SIDE_U_STEP);
        const x0 = Math.max(Math.min(bLo.x0, bLo.x1), -xLim), x1 = Math.min(Math.max(bLo.x0, bLo.x1), xLim);   // borné au plan de paroi
        const z0 = Math.min(bLo.z0, bLo.z1, bHi.z0, bHi.z1), z1 = Math.max(bLo.z0, bLo.z1, bHi.z0, bHi.z1);
        if (x1 <= x0) return;
        const yp = bLo.yPlane + (front ? SLOT_OFF : -SLOT_OFF);   // vers l'EXTÉRIEUR (décalage av/ar)
        this.slotPlane(group, x1 - x0, z1 - z0, (x0 + x1) / 2, yp, (z0 + z1) / 2, front,
          { type: "slotSide", rackId: r.id, face: s.face, lr: s.lr, col: s.col, uTop: run.uLo, uLo: run.uLo, uHi: run.uHi, rowStep: SIDE_U_STEP, zLo: z0, zHi: z1 }, { layer: "slot", eqSide: front ? "front" : "rear" },
          { pitch: SIDE_U_STEP * U_MM, count: (run.uHi - run.uLo) / SIDE_U_STEP + 1 });
      });
      // emplacements MURAUX libres (parois ±X) → monter équipement en paroi (décalés vers l'INTÉRIEUR de la baie).
      mergeRuns(this.scene3d.wallFreeSlots(r), (s) => s.wall + "|" + s.margin + "|" + s.col).forEach((run) => {
        const s = run.first, front = s.margin !== "rear";
        const bLo = RackGeometry.wallSlotBoxLocal(r, s.wall, s.margin, s.col, run.uLo, SIDE_U_STEP);
        const bHi = RackGeometry.wallSlotBoxLocal(r, s.wall, s.margin, s.col, run.uHi, SIDE_U_STEP);
        const z0 = Math.min(bLo.z0, bLo.z1, bHi.z0, bHi.z1), z1 = Math.max(bLo.z0, bLo.z1, bHi.z0, bHi.z1);
        const xp = bLo.xPlane - Math.sign(bLo.xPlane || 1) * SLOT_OFF;   // vers le centre (intérieur)
        this.slotQuad(group, [[xp, bLo.y0, z0], [xp, bLo.y1, z0], [xp, bLo.y1, z1], [xp, bLo.y0, z1]],
          { type: "slotWall", rackId: r.id, wall: s.wall, margin: s.margin, col: s.col, uTop: run.uLo, uLo: run.uLo, uHi: run.uHi, rowStep: SIDE_U_STEP, zLo: z0, zHi: z1 }, { layer: "slot", eqSide: front ? "front" : "rear" },
          { pitch: SIDE_U_STEP * U_MM, count: (run.uHi - run.uLo) / SIDE_U_STEP + 1 });
      });
      // TROUS DE CAPOT libres (toit + sol) → poser un pin. Toujours construits, couche "slot" (pilotée par le seul
      // toggle « emplacements libres », indépendamment de l'affichage des capots).
      const gCap = RackGeometry.capGrid(r), hw2 = w / 2;
      ([{ face: "roof", zc: H }, { face: "floor", zc: 0 }] as Array<{ face: string; zc: number }>).forEach((cp) => {
        this.scene3d.capFreeSlots(r, cp.face).forEach((s: any) => {
          const lx0 = -hw2 + gCap.mx + s.cx * gCap.cell, lx1 = lx0 + gCap.cell, ly0 = -hd + gCap.my + s.cy * gCap.cell, ly1 = ly0 + gCap.cell;
          this.slotQuad(group, [[lx0, ly0, cp.zc], [lx1, ly0, cp.zc], [lx1, ly1, cp.zc], [lx0, ly1, cp.zc]], { type: "slotCap", rackId: r.id, face: cp.face, cx: s.cx, cy: s.cy }, { layer: "slot" });
        });
      });
    }

    // PORTES en saillie (avant/arrière) : rendu pseudo-réaliste (cadre + panneau perforé/vitré + poignée + gonds).
    // Toujours construites → couche "door" basculable en visibilité (showDoors) sans reconstruction.
    (["front", "rear"] as const).forEach((face) => {
      const dr = RackGeometry.door(r, face); if (!dr || !dr.enabled) return;
      this.buildDoor(group, r, face === "rear", dr, w, H, d, theme);
      this.buildDoorSwing(group, face === "rear", dr, w, d, theme);   // débattement 2D au sol (couche basculable)
    });

    return { group, height: H };
  }

  /** Plan plat (emplacement libre) au plan de montage, orienté ±Y : remplissage translucide + CADRE accent
      (visible au repos) ; surligné (emissive) au survol. */
  protected slotPlane(group: THREE.Group, w: number, h: number, x: number, y: number, z: number, front: boolean, pick: any, extra?: any, rows?: { pitch: number; count: number }): void {
    const mat = new THREE.MeshStandardMaterial({ color: this.theme.front, transparent: true, opacity: 0.16, emissive: 0x16314e, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.position.set(x, y, z);
    mesh.rotation.x = front ? Math.PI / 2 : -Math.PI / 2;
    mesh.userData = Object.assign({ pick }, extra);   // cadre = enfant (suit la visibilité du mesh)
    // cadre (bordure) + SÉPARATEURS de rangées en UNE seule géométrie de lignes : la bande fusionnée garde le
    // quadrillage visuel « une case par U/rangée » sans recréer un objet par case (1 draw call de lignes/bande).
    const hw = w / 2, hh = h / 2, pts: number[] = [];
    const seg = (x1: number, y1: number, x2: number, y2: number) => pts.push(x1, y1, 0, x2, y2, 0);
    seg(-hw, -hh, hw, -hh); seg(hw, -hh, hw, hh); seg(hw, hh, -hw, hh); seg(-hw, hh, -hw, -hh);
    if (rows && rows.count > 1) {
      for (let k = 1; k < rows.count; k++) {
        const yk = -hh + k * rows.pitch - 1.5;   // −1.5 : le plan est rogné de 3 mm (1,5 par bout) vs n×pas
        if (yk > -hh && yk < hh) seg(-hw, yk, hw, yk);
      }
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    mesh.add(new THREE.LineSegments(bg, new THREE.LineBasicMaterial({ color: this.theme.front, transparent: true, opacity: 0.6 })));
    group.add(mesh);
  }

  /** Texture de HACHURES (diagonales tuilables) — une par appel (repeat propre au mesh ; disposée via ownTex). */
  protected hatchTexture(): THREE.CanvasTexture | null {
    if (typeof document === "undefined") return null;
    const s = 32, cv = document.createElement("canvas"); cv.width = cv.height = s;
    const g = cv.getContext("2d"); if (!g) return null;
    g.strokeStyle = "rgba(255,255,255,0.95)"; g.lineWidth = 4;
    for (let o = -s; o <= s; o += s / 2) { g.beginPath(); g.moveTo(0, o); g.lineTo(s, o + s); g.stroke(); }   // pente 1 → tuilage continu
    const tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.needsUpdate = true;
    return tex;
  }

  /** KEEPBLANK : bande HACHURÉE (ambre) matérialisant la réservation d'U — aucun objet physique. Couche "slot"
      (suit le toggle « emplacements libres ») + côté (hideAv/Ar). Pick `keepblankReserve` → clic = libérer. */
  protected buildKeepblankBand(group: THREE.Group, r: any, u: any, baseZ: number, fpY: number, rpY: number): void {
    const front = u.side !== "rear", eqSide = front ? "front" : "rear";
    const bodyHW = RACK_MOUNT_WIDTH / 2 - RACK_EAR_MM;
    const yPlane = front ? fpY + 2 : rpY - 2;   // même plan que les emplacements libres (slotPlane)
    const nU = Math.max(1, u.h | 0), zc = baseZ + (u.u - 1 + nU / 2) * U_MM;
    const w = 2 * bodyHW * 0.96, h = nU * U_MM - 3;
    const tex = this.hatchTexture(); if (tex) tex.repeat.set(Math.max(1, Math.round(w / 40)), Math.max(1, Math.round(h / 40)));
    const mat = new THREE.MeshStandardMaterial({ color: 0xffb020, map: tex || null, transparent: true, opacity: tex ? 0.5 : 0.28, emissive: 0x2a1e00, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.position.set(0, yPlane, zc); mesh.rotation.x = front ? Math.PI / 2 : -Math.PI / 2;
    const ud: any = { pick: { type: "keepblankReserve", id: u.id, rackId: r.id }, layer: "slot", eqSide, ownTex: !!tex };
    mesh.userData = ud; mesh.visible = this.layerVisible(ud);
    const hw = w / 2, hh = h / 2;
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.Float32BufferAttribute([-hw, -hh, 0, hw, -hh, 0, hw, -hh, 0, hw, hh, 0, hw, hh, 0, -hw, hh, 0, -hw, hh, 0, -hw, -hh, 0], 3));
    mesh.add(new THREE.LineSegments(bg, new THREE.LineBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.7 })));
    group.add(mesh);
  }

  /** Emplacement libre QUELCONQUE défini par 4 coins (coords locales) : remplissage translucide + cadre accent,
      surligné au survol. Pour les faces que `slotPlane` ne couvre pas (mural ±X, capot ±Z horizontal).
      `rows` : séparateurs horizontaux (axe z) aux multiples de `pitch` depuis z0 — quadrillage des couloirs muraux. */
  protected slotQuad(group: THREE.Group, corners: number[][], pick: any, extra?: any, rows?: { pitch: number; count: number }): void {
    const [a, b, c, d] = corners;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: this.theme.front, transparent: true, opacity: 0.16, emissive: 0x16314e, side: THREE.DoubleSide, depthWrite: false }));
    mesh.userData = Object.assign({ pick }, extra); group.add(mesh);
    const pts: number[] = [...a, ...b, ...b, ...c, ...c, ...d, ...d, ...a];   // bordure (segments)
    if (rows && rows.count > 1) {
      // séparateurs entre rangées : le quad mural est rectangulaire dans le plan x=cst, z de a/b (bas) à c/d (haut)
      const zLo = Math.min(a[2], c[2]);
      for (let k = 1; k < rows.count; k++) { const zk = zLo + k * rows.pitch; pts.push(a[0], a[1], zk, b[0], b[1], zk); }
    }
    const bg = new THREE.BufferGeometry(); bg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    mesh.add(new THREE.LineSegments(bg, new THREE.LineBasicMaterial({ color: this.theme.front, transparent: true, opacity: 0.6 })));
  }

  /** NUMÉROS D'U d'une bande d'emplacements libres, en UNE SEULE texture / UN SEUL mesh (une étiquette par U
      recréait le problème de draw calls que la fusion en bandes vient d'éliminer — 42 étiquettes/face sur une
      baie vide). Canvas : une ligne « U n » par U, haut du canvas = U le plus HAUT (l'orientation front/rear de
      faceLabel conserve le haut vers +Z). Texture au cache LRU (texCache). */
  protected bandULabels(group: THREE.Group, uLo: number, uHi: number, yPlane: number, baseZ: number, side: string, widthMm: number): void {
    if (typeof document === "undefined") return;
    const nU = uHi - uLo + 1, front = side === "front";
    const key = "Uband|" + uLo + "-" + uHi;
    this.texCacheTicks.set(key, ++this.texCacheTick);
    let tex = this.texCache.get(key) || null;
    if (!tex) {
      const rowPx = 40, cw = 128, ch = Math.min(4096, nU * rowPx);
      const cv = document.createElement("canvas"); cv.width = cw; cv.height = ch;
      const g = cv.getContext("2d"); if (!g) return;
      g.textAlign = "center"; g.textBaseline = "middle"; g.font = "600 22px system-ui, sans-serif";
      const rh = ch / nU;
      for (let i = 0; i < nU; i++) {
        const u = uHi - i, cy = (i + 0.5) * rh;   // haut du canvas = U le plus haut
        g.fillStyle = "rgba(12,16,22,0.55)";
        const pw = 74, phh = Math.min(15, rh / 2 - 2);
        g.beginPath(); (g as any).roundRect ? (g as any).roundRect(cw / 2 - pw / 2, cy - phh, pw, 2 * phh, 8) : g.rect(cw / 2 - pw / 2, cy - phh, pw, 2 * phh); g.fill();
        g.fillStyle = "#e8eef7"; g.fillText("U" + u, cw / 2, cy);
      }
      tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4; tex.needsUpdate = true;
      this.texCache.set(key, tex);
      this.pruneLabelTextureCache();
    }
    const w = Math.min(widthMm, 120), h = nU * U_MM - 6;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    mesh.position.set(0, yPlane + (front ? -4 : 4), baseZ + (uLo - 1 + nU / 2) * U_MM);
    // même pose que faceLabel : avant = normale −Y ; arrière = 180° autour de (0,1,1) → texte droit, haut vers +Z.
    if (front) mesh.rotation.x = Math.PI / 2;
    else mesh.setRotationFromAxisAngle(new THREE.Vector3(0, 1, 1).normalize(), Math.PI);
    mesh.userData = { layer: "slotlabel", eqSide: side };
    group.add(mesh);
  }

  /** Plaque de capot (toit/sol) horizontale RÉELLEMENT PERCÉE : construite par CELLULES (grille `nx×ny` au pas
      U_MM) — chaque cellule NON-trouée devient un quad ; les cellules de `capCells` sont OMISES (vrais trous, on
      voit à travers). Fusionnées en une seule géométrie, bornées à l'emprise ±w/2. Cliquable comme la baie. */
  protected buildCapPlate(group: THREE.Group, r: any, face: string, zc: number, w: number, d: number, cell: number, theme: Theme): void {
    const hw = w / 2, hd = d / 2;
    const g = RackGeometry.capGrid(r);
    const holes = new Set<string>(RackGeometry.capCells(r, face));
    const pos: number[] = [];
    const quad = (x0: number, y0: number, x1: number, y1: number) => { if (x1 - x0 > 0.01 && y1 - y0 > 0.01) pos.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x0, y1, 0); };
    // grille CENTRÉE (cf. capGrid) : les cellules occupent [gx0,gx1]×[gy0,gy1], chaque cellule pleine devient un
    // quad, les cellules trouées sont omises (vrais trous). Bornées à l'emprise de la baie (cas marge < 0).
    const gx0 = -hw + g.mx, gx1 = gx0 + g.nx * cell, gy0 = -hd + g.my, gy1 = gy0 + g.ny * cell;
    for (let cy = 0; cy < g.ny; cy++) {
      for (let cx = 0; cx < g.nx; cx++) {
        if (holes.has(cx + "," + cy)) continue;   // cellule trouée → omise
        quad(Math.max(-hw, gx0 + cx * cell), Math.max(-hd, gy0 + cy * cell), Math.min(hw, gx0 + (cx + 1) * cell), Math.min(hd, gy0 + (cy + 1) * cell));
      }
    }
    // MARGES de bord (hors grille, non perçables) : bandes PLEINES → la plaque couvre tout le dessus de la baie.
    quad(-hw, -hd, Math.max(-hw, gx0), hd);   // marge gauche (toute la profondeur)
    quad(Math.min(hw, gx1), -hd, hw, hd);     // marge droite
    quad(Math.max(-hw, gx0), -hd, Math.min(hw, gx1), Math.max(-hd, gy0));   // marge avant (entre les marges latérales)
    quad(Math.max(-hw, gx0), Math.min(hd, gy1), Math.min(hw, gx1), hd);     // marge arrière
    if (!pos.length) return;
    // Baie SANS capots (châssis ouvert) : plaque TRANSLUCIDE et TOUJOURS AFFICHÉE (hors couche "rackshell" —
    // même rendu fantôme que les parois latérales ; le SOL garde ses trous, seuls percements encore autorisés).
    const capless = r.has_caps === false;
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: theme.rack, roughness: 0.8, metalness: 0.1, side: THREE.DoubleSide, ...(capless ? { transparent: true, opacity: 0.16, depthWrite: false } : {}) }));
    mesh.position.z = zc; mesh.userData = capless ? { pick: { type: "rack", id: r.id } } : { pick: { type: "rack", id: r.id }, layer: "rackshell" };   // couche capot (showRackSides) — sauf châssis ouvert
    group.add(mesh);
  }

  /** Porte de baie PSEUDO-RÉALISTE (coords LOCALES de baie) : cadre métal en relief + panneau (perforé/ventilé si
      `hollow`, sinon vitre translucide) + poignée côté loquet + 2 gonds côté charnière. Marquée `door:true` →
      NON-occultante au picking (clic-through vers les équipements, comme l'ancien panneau translucide). Tout est
      tagué couche "door" (toggle `showDoors` géré en visibilité, sans reconstruction). */
  protected buildDoor(group: THREE.Group, r: any, rear: boolean, dr: any, w: number, H: number, d: number, theme: Theme): void {
    const hd = d / 2, hw = w / 2;
    const T = Math.max(6, dr.thickness_mm | 0);                       // épaisseur du vantail
    const cavity = dr.hollow ? Math.max(0, dr.hollow_mm | 0) : 0;     // profondeur de la CAVITÉ (porte creuse/bombée)
    const sgn = rear ? 1 : -1;                                        // avant = −Y, arrière = +Y
    const yLeaf = sgn * (hd + cavity + T / 2);                        // vantail repoussé vers l'extérieur de la cavité
    const yOut = sgn * (hd + cavity + T);                             // face extérieure du vantail (poignée/gonds)
    // vantail PLEINE LARGEUR (ou 2 DEMI-VANTAUX en double battant) ; le DÉGAGEMENT de rotation est juste un
    // DÉCALAGE des charnières de T vers l'intérieur (et donc du rayon d'ouverture, cf. buildDoorSwing).
    // « gauche/droite » = vu DE LA FACE de la porte : avant (−Y) gauche = −X ; arrière (+Y) gauche = +X (inversé).
    const left = (dr.hinge !== "right") !== rear;
    const dbl = (dr.leaves | 0) === 2;   // double battant : loquets/poignées au CENTRE, gonds aux DEUX bords
    const xL = -hw, xR = hw, cx = 0, dw = w;
    // AXES DE PIVOT partagés avec le débattement au sol (RackDoorGeometry) : les gonds sont posés PAR CONSTRUCTION
    // sur les MÊMES axes (hx, hy) que les secteurs → valider le placement d'une porte = vérifier visuellement que
    // le coin de chaque secteur s'ancre sur ses gonds. 1 pivot (simple) ou 2 (double).
    const pivots = RackDoorGeometry.swingSectors(w, d, rear, dr);
    const FRAME = Math.min(45, Math.max(20, dw * 0.07));
    const pick = { type: "rack", id: r.id, door: true };
    const metal = () => new THREE.MeshStandardMaterial({ color: theme.doorMetal, metalness: 0.65, roughness: 0.45 });
    // PAROIS de la CAVITÉ (porte bombée) : caisson reliant la face de baie au vantail → respecte hollow_mm.
    if (cavity > 0) {
      const ymid = sgn * (hd + cavity / 2), WT = Math.min(FRAME, 26);
      const wall = (bw: number, bh: number, x: number, z: number) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(bw, cavity, bh), metal());
        m.position.set(x, ymid, z); m.userData = { pick, layer: "door", rackId: r.id }; group.add(m);
      };
      wall(WT, H, xL + WT / 2, H / 2); wall(WT, H, xR - WT / 2, H / 2);   // parois latérales du caisson
      wall(dw, WT, cx, H - WT / 2); wall(dw, WT, cx, WT / 2);             // parois haut/bas
    }
    // CADRE du vantail : 4 montants en relief (profondeur T sur Y), au plan repoussé.
    const bar = (bw: number, bh: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(bw, T, bh), metal());
      m.position.set(x, yLeaf, z); m.userData = { pick, layer: "door", rackId: r.id }; group.add(m);
    };
    bar(FRAME, H, xL + FRAME / 2, H / 2); bar(FRAME, H, xR - FRAME / 2, H / 2);    // montants gauche/droite
    bar(dw - 2 * FRAME, FRAME, cx, H - FRAME / 2); bar(dw - 2 * FRAME, FRAME, cx, FRAME / 2);   // traverses haut/bas
    // double battant : MONTANTS CENTRAUX (un par vantail, de part et d'autre du joint), entre les traverses.
    if (dbl) { bar(FRAME, H - 2 * FRAME, -FRAME / 2, H / 2); bar(FRAME, H - 2 * FRAME, FRAME / 2, H / 2); }
    // PANNEAU(X) : perforé (ventilé) → alphaMap fentes + métal · plein → vitre translucide. Un par vantail.
    let panelMat: THREE.MeshStandardMaterial;
    if (dr.hollow) {
      const perf = this.perfTexture();
      panelMat = new THREE.MeshStandardMaterial({ color: theme.doorPanel, metalness: 0.7, roughness: 0.5, side: THREE.DoubleSide, alphaMap: perf || undefined, alphaTest: perf ? 0.5 : 0 });
    } else {
      panelMat = new THREE.MeshStandardMaterial({ color: 0xaecadf, metalness: 0.1, roughness: 0.07, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    }
    const ph = Math.max(1, H - 2 * FRAME);
    const panelSpecs: Array<{ x: number; w: number }> = dbl
      ? [{ x: -hw / 2, w: Math.max(1, hw - 2 * FRAME) }, { x: hw / 2, w: Math.max(1, hw - 2 * FRAME) }]   // 2 demi-panneaux
      : [{ x: cx, w: Math.max(1, dw - 2 * FRAME) }];
    panelSpecs.forEach((ps) => {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(ps.w, ph), panelMat);
      panel.position.set(ps.x, yLeaf, H / 2); panel.rotation.x = rear ? -Math.PI / 2 : Math.PI / 2;   // normale ±Y (vers l'extérieur)
      panel.userData = { pick, layer: "door", rackId: r.id }; group.add(panel);
    });
    // POIGNÉE(S) en U (barre verticale DÉPORTÉE + 2 pattes), côté OPPOSÉ aux gonds : au loquet (simple) ou une
    // PAR VANTAIL de part et d'autre du joint CENTRAL (double battant).
    const gripXs = dbl ? [-(FRAME + 18), FRAME + 18] : [left ? (xR - FRAME - 18) : (xL + FRAME + 18)];
    const gripH = Math.min(220, Math.max(120, H * 0.14));
    gripXs.forEach((latchX) => {
      const grip = new THREE.Mesh(new THREE.BoxGeometry(16, 10, gripH), metal());
      grip.position.set(latchX, yOut + sgn * 24, H / 2); grip.userData = { pick, layer: "door", rackId: r.id }; group.add(grip);
      [-1, 1].forEach((k) => {   // pattes de déport (fixent la barre au vantail)
        const leg = new THREE.Mesh(new THREE.BoxGeometry(12, 24, 14), metal());
        leg.position.set(latchX, yOut + sgn * 12, H / 2 + k * (gripH / 2 - 10));
        leg.userData = { pick, layer: "door", rackId: r.id }; group.add(leg);
      });
    });
    // GONDS — quincaillerie de CHARNIÈRE À BROCHE posée sur les AXES DE ROTATION RÉELS (pivot.hx / pivot.hy, les
    // mêmes que les secteurs de débattement) : canon vertical + broche traversante saillante + patte vissée sur le
    // montant du vantail. Un jeu de gonds PAR PIVOT (2 en double battant).
    pivots.forEach((pivot) => [H * 0.18, H * 0.82].forEach((hz) => {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 84, 14), metal());    // canon de charnière
      barrel.rotation.x = Math.PI / 2; barrel.position.set(pivot.hx, pivot.hy, hz);        // axe Y → Z (vertical)
      barrel.userData = { pick, layer: "door", rackId: r.id }; group.add(barrel);
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, 116, 10), metal());  // broche (dépasse du canon)
      pin.rotation.x = Math.PI / 2; pin.position.set(pivot.hx, pivot.hy, hz);
      pin.userData = { layer: "door", rackId: r.id }; group.add(pin);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(FRAME, 8, 56), metal());          // patte vissée sur le montant
      plate.position.set(pivot.hx + pivot.dirX * (FRAME / 2), pivot.hy - sgn * 4, hz);
      plate.userData = { pick, layer: "door", rackId: r.id }; group.add(plate);
    }));
  }

  /** PROJECTION 2D au sol du DÉBATTEMENT d'une porte (rayon d'ouverture) : secteur quart-de-disque (90°) au sol
      (z≈1), pivot = charnière, rayon = largeur de porte, balayé de la position fermée (le long de la face) vers
      l'extérieur de la baie. Couleurs des EMPLACEMENTS LIBRES (remplissage + cadre accent). Couche basculable
      "doorswing" (showDoorSwing), non interactive. */
  protected buildDoorSwing(group: THREE.Group, rear: boolean, dr: any, w: number, d: number, theme: Theme): void {
    // Géométrie PARTAGÉE avec la vue Dessus SVG (RackDoorGeometry) — un seul calcul de pivot/rayon/angle.
    // Un secteur PAR VANTAIL (1 simple · 2 double battant).
    const N = 18, Z = 1;
    RackDoorGeometry.swingSectors(w, d, rear, dr).forEach((s) => {
      const sector = RackDoorGeometry.sectorPointsOf(s, N);
      const pts: number[] = [];
      sector.forEach((p) => pts.push(p.x, p.y, Z));
      const fill: number[] = [];
      for (let i = 0; i < N; i++) { const o = 3 * (i + 1); fill.push(pts[0], pts[1], pts[2], pts[o], pts[o + 1], pts[o + 2], pts[o + 3], pts[o + 4], pts[o + 5]); }
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(fill, 3)); geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: theme.front, transparent: true, opacity: 0.16, emissive: 0x16314e, side: THREE.DoubleSide, depthWrite: false }));
      mesh.userData = { layer: "doorswing" }; group.add(mesh);
      const bg = new THREE.BufferGeometry(); bg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));   // cadre : pivot → arc → (retour au pivot)
      const loop = new THREE.LineLoop(bg, new THREE.LineBasicMaterial({ color: theme.front, transparent: true, opacity: 0.6 }));
      loop.userData = { layer: "doorswing" }; group.add(loop);
    });
  }

  /** Brosse de brassage : COQUE CREUSE (corps × U × profondeur) percée d'un TUNNEL av→ar (passe-câble), en
      coords LOCALES de baie. Faces translucides + arêtes ; cliquable → form waypoint. */
  protected buildBrush(group: THREE.Group, wp: any, baseZ: number, fpY: number, cageY: number, bodyHW: number, theme: Theme): void {
    const u0 = Math.max(1, wp.rack_u | 0), uh = Math.max(1, wp.u_height | 0);
    // profondeur RÉELLE dessinée (plus de clamp à la cage) : sans porte la brosse peut dépasser les montants ;
    // avec porte, le formulaire empêche de dépasser l'espace dispo (cf. RackForms.waypoint).
    const bdepth = Math.max(1, wp.depth_mm || 100);
    const bz0 = baseZ + (u0 - 1) * U_MM, bz1 = baseZ + (u0 - 1 + uh) * U_MM, by0 = fpY + 2, by1 = fpY + 2 + bdepth;
    const pad = BRUSH_PADDING_MM, zc = (bz0 + bz1) / 2;
    const uhw = Math.max(1, bodyHW - pad), uhh = Math.max(1, (bz1 - bz0) / 2 - pad);
    const rect = (y: number, hw: number, zlo: number, zhi: number): number[][] => [[-hw, y, zlo], [hw, y, zlo], [hw, y, zhi], [-hw, y, zhi]];
    const FO = rect(by0, bodyHW, bz0, bz1), FI = rect(by0, uhw, zc - uhh, zc + uhh);
    const BO = rect(by1, bodyHW, bz0, bz1), BI = rect(by1, uhw, zc - uhh, zc + uhh);
    const pos: number[] = [];
    const quad = (a: number[], b: number[], c: number[], e: number[]) => pos.push(...a, ...b, ...c, ...a, ...c, ...e);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      quad(FO[i], FO[j], FI[j], FI[i]);   // anneau avant (corps − tunnel)
      quad(BO[i], BO[j], BI[j], BI[i]);   // anneau arrière
      quad(FO[i], FO[j], BO[j], BO[i]);   // paroi extérieure
      quad(FI[i], FI[j], BI[j], BI[i]);   // paroi du tunnel
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: CONDUIT_COLOR, roughness: 0.7, metalness: 0.1, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
    mesh.userData = { pick: { type: "wp", id: wp.id }, layer: "conduit" };   // couche basculable (showConduits)
    group.add(mesh);
    const epos: number[] = [];
    const edge = (a: number[], b: number[]) => epos.push(...a, ...b);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; edge(FO[i], FO[j]); edge(BO[i], BO[j]); edge(FI[i], FI[j]); edge(BI[i], BI[j]); edge(FO[i], BO[i]); edge(FI[i], BI[i]); }
    const eg = new THREE.BufferGeometry(); eg.setAttribute("position", new THREE.Float32BufferAttribute(epos, 3));
    const be = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: theme.line })); be.userData = { layer: "conduit" }; group.add(be);
  }

  /** TRAY (étagère) : PLATEAU plein (tôle, largeur du CORPS 19″) au BAS de la réservation — la structure
      le PORTE et vit AU-DESSUS (tray_u = hauteur de la structure, PURE indication de dessin). JAMAIS de
      panneau plein en façade : l'accroche se fait par OREILLES 19″ (flasques latéraux bord de plateau →
      rails, comme un équipement) :
      - "dual" : paires d'oreilles AVANT ET ARRIÈRE ;
      - "cantilever" : oreilles sur la seule face d'ancrage + 2 RENFORTS TRIANGULAIRES latéraux AU-DESSUS
        du plateau (côté horizontal = longueur du plateau, côté vertical = hauteur de montage en façade
        (tray_u), hypoténuse du HAUT de façade vers l'arrière du plateau — le renfort SUSPEND).
      L'espace UTILE (toute la réservation moins TRAY_SHEET_RESERVE_MM au ras du plateau) est matérialisé
      en boîte très translucide (cf. RackGeometry.trayBoxLocal — même boîte que le contrôle de placement). */
  protected buildTrayItem(group: THREE.Group, r: any, u: any, baseZ: number, fpY: number, rpY: number, theme: Theme): void {
    const front = u.side !== "rear", eqSide = front ? "front" : "rear";
    const box = RackGeometry.trayBoxLocal(r, { u: u.u, u_height: u.h, tray_u: u.tray_u, tray_type: u.tray_type, depth_mm: u.depth_mm, side: u.side });
    const pick = { type: "occ", kind: u.kind, id: u.id };
    const col = this.occColor(u);
    const TH = 4;   // épaisseur de tôle (mm) — logée dans la réserve de 5 mm (TRAY_SHEET_RESERVE_MM)
    const mountY = front ? fpY : rpY;         // plan de montage de la face d'ancrage
    const inward = front ? 1 : -1;            // +Y vers l'intérieur pour un montage avant
    const zStructTop = baseZ + (u.u - 1 + box.tu) * U_MM;   // sommet de la structure (indication de dessin)
    // PLATEAU au bas de la réservation : la tôle loge dans la réserve (plancher utile = box.z0).
    this.localBox(group, box.x0, box.x1, Math.min(box.y0, box.y1), Math.max(box.y0, box.y1), box.z0 - TH, box.z0, col, pick, { eqSide });
    // OREILLES 19″ (jamais de panneau plein en façade — le plateau doit rester dégagé) : flasques latéraux
    // du bord du plateau (±corps) jusqu'aux rails (±entraxe/2), montant du plateau au sommet de la structure.
    // Comme les équipements : elles REMPLISSENT la réserve standard DEVANT le plan de montage (pas de collision montants).
    const mountHW = RACK_MOUNT_WIDTH / 2;
    const ears = (y: number, dir: number) => [[box.x0 - RACK_EAR_MM, box.x0], [box.x1, box.x1 + RACK_EAR_MM]].forEach((xr) =>
      this.localBox(group, Math.max(-mountHW, xr[0]), Math.min(mountHW, xr[1]), y - dir * RACK_EAR_STANDOFF_MM, y, box.z0 - TH, zStructTop, col, pick, { eqSide }));
    if (u.tray_type === "cantilever") {
      ears(mountY, inward);   // oreilles sur la SEULE face d'ancrage
      // renforts TRIANGULAIRES latéraux AU-DESSUS du plateau — ils le PORTENT (suspension). FLANCS ÉPAIS
      // (prismes de tôle) AFFLEURANT l'extrémité du plateau : bord extérieur = bord du plateau = bord
      // intérieur des oreilles (aucun espace). Côté vertical au PLAN DE FAÇADE, comme les oreilles.
      const yFace = mountY - inward * RACK_EAR_STANDOFF_MM;   // = bord du plateau côté montage (box.y0/box.y1)
      const yRear = front ? box.y1 : box.y0;   // arrière du plateau (extrémité opposée au montage)
      const GTH = 3;   // épaisseur de tôle d'un flanc (mm)
      [[box.x0, box.x0 + GTH], [box.x1 - GTH, box.x1]].forEach(([xA, xB]) => {
        // prisme triangulaire : A = bas-façade · B = bas-arrière · C = haut-façade, extrudé de xA à xB
        const A = [yFace, box.z0], B = [yRear, box.z0], C = [yFace, zStructTop];
        const P = (x: number, p: number[]) => [x, p[0], p[1]];
        const pos: number[] = [];
        const tri3 = (p1: number[], p2: number[], p3: number[]) => pos.push(...p1, ...p2, ...p3);
        tri3(P(xA, A), P(xA, B), P(xA, C));                               // face xA
        tri3(P(xB, A), P(xB, C), P(xB, B));                               // face xB (enroulement inversé)
        const quad = (p1: number[], p2: number[]) => {                    // flanc A→B, B→C (hypoténuse), C→A
          tri3(P(xA, p1), P(xA, p2), P(xB, p2)); tri3(P(xA, p1), P(xB, p2), P(xB, p1));
        };
        quad(A, B); quad(B, C); quad(C, A);
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        g.computeVertexNormals();
        const tri = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, metalness: 0.15, side: THREE.DoubleSide }));
        tri.userData = { pick, eqSide }; group.add(tri);
        const le = new THREE.LineSegments(new THREE.EdgesGeometry(g, 20), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }));
        le.userData = { eqSide }; group.add(le);
      });
    } else {
      // "dual" : OREILLES AVANT + ARRIÈRE (paires de flasques aux deux plans de montage)
      ears(fpY, 1);
      ears(rpY, -1);
    }
    // ESPACE UTILE au-dessus du plateau : boîte très translucide + arêtes (ce que la réservation OFFRE).
    // INSENSIBLE À LA SOURIS (aucun `pick`) : elle enveloppe les équipements posés → sinon elle
    // intercepterait le clic/survol et on ne pourrait plus interagir avec eux. Elle n'est donc PAS non
    // plus surlignée au survol du tray (seule la géométrie solide l'est).
    if (box.z1 - box.z0 > 1) {
      const geo = new THREE.BoxGeometry(box.x1 - box.x0, Math.abs(box.y1 - box.y0), box.z1 - box.z0);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: col, transparent: true, opacity: 0.08, depthWrite: false }));
      mesh.position.set((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, (box.z0 + box.z1) / 2);
      mesh.userData = { eqSide }; group.add(mesh);   // PAS de `pick` → non cliquable / non survolable
      const ed = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.45 }));
      ed.position.copy(mesh.position); ed.userData = { eqSide }; group.add(ed);
    }
  }

  /** Couleur d'un occupant selon le mode (face = neutre · groupe · type) ; gris pour items/brosses. */
  protected occColor(u: any): number {
    if (u.kind !== "eq") return u.kind === "brush" ? CONDUIT_COLOR : 0x55607a;
    const e: any = this.store.get("equipments", u.id);
    if (!e) return 0x6c7a8c;
    if (this.opts.colorMode === "group") {
      const g: any = e.group_id ? this.store.get("groups", e.group_id) : null;
      const c = g && g.color ? Color.cssToHex(g.color) : NaN; return isFinite(c) ? c : 0x6c7a8c;
    }
    // « type » explicite ; ou « face » sur un équipement LIBRE (pas de panneau 19″ coloré par face → repli sur le type).
    if (this.opts.colorMode === "type" || (this.opts.colorMode === "face" && e.dim_mode === "free")) {
      const c = Color.cssToHex(EquipmentTypes.color(e.type)); return isFinite(c) ? c : 0x6c7a8c;
    }
    return 0x6c7a8c;   // mode « face » (baie) : couleur neutre (le moteur SVG s'appuie sur le CSS, non porté ici)
  }

  /* ---- équipements libres + waypoints de salle ---- */
  /** Équipements en dimensionnement LIBRE posés dans la salle : boîtes 6 faces (cliquables / survolables). */
  protected buildFreeEquip(dcId: string, root: THREE.Group): void {
    this.store.freeEquipsOfDc(dcId).forEach((e: any) => {
      if (e.dc_x == null || e.dc_y == null) return;
      if (this.opts.hiddenEquips && this.opts.hiddenEquips.has(e.id)) return;   // équipement libre masqué (panneau / menu contextuel)
      const b = FreeEquipGeometry.box(e);
      const o = Normalize.rackOrientation(e.dc_orientation) * Math.PI / 180;
      const color = this.occColor({ kind: "eq", id: e.id });
      const grp = new THREE.Group(); grp.position.set(e.dc_x, e.dc_y, 0); grp.rotation.z = o; root.add(grp);
      const geo = new THREE.BoxGeometry(b.w, b.d, b.h);
      // 6 matériaux (un par face de la BoxGeometry) : image de façade si présente (non éclairée, couleurs vraies),
      // sinon le corps coloré/éclairé. Ordre BoxGeometry : +X,−X,+Y,−Y,+Z,−Z ↔ droite/gauche/arrière/AVANT(−Y)/dessus/dessous.
      const FACE_BY_MAT = ["right", "left", "rear", "front", "top", "bottom"];
      // UVs REMAPPÉES pour notre monde Z-UP : BoxGeometry suppose Y-up → l'image d'ARRIÈRE (et dessus/dessous)
      // sortait à 180°, gauche/droite à ±90°. On dérive chaque UV de l'INVERSE de faceLocal (la source de vérité
      // du placement des PORTS) : l'image s'aligne donc EXACTEMENT sur les ports, sur les 6 faces.
      // BoxGeometry = 4 sommets par face, dans l'ordre des groupes de matériaux (FACE_BY_MAT).
      {
        const pos = geo.getAttribute("position"), uv = geo.getAttribute("uv");
        for (let i = 0; i < pos.count; i++) {
          const face = FACE_BY_MAT[Math.floor(i / 4)];
          // géométrie centrée (z ∈ [−h/2, +h/2]) → repère faceLocal (base z0 = 0, z ∈ [0, h])
          const f = FreeEquipGeometry.faceFraction(e, face, pos.getX(i), pos.getY(i), pos.getZ(i) + b.h / 2, 0);
          uv.setXY(i, f.fx, 1 - f.fy);   // uv.y = 1 ↔ HAUT de l'image (flipY par défaut du TextureLoader)
        }
        uv.needsUpdate = true;
      }
      let hasFrontImg = false;
      const mats = FACE_BY_MAT.map((face) => {
        const img = this.host.faceImageUrl?.(e.id, face);
        const has = !!(img && img.url);
        if (face === "front") hasFrontImg = has;
        if (has) { const m = new THREE.MeshBasicMaterial({ color: 0xffffff }); this.applyFaceTexture(m, img!.url); return m; }
        return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.15 });
      });
      const mesh = new THREE.Mesh(geo, mats);
      mesh.position.set(0, 0, b.z + b.h / 2);
      mesh.userData = { pick: { type: "occ", kind: "eq", id: e.id } };   // même traitement que les occupants (détail + survol)
      grp.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }));
      edges.position.copy(mesh.position); grp.add(edges);
      // Mise en évidence de la FACE AVANT (−Y local) : ses 4 ARÊTES à l'accent → repère d'orientation. INUTILE quand une
      // image de face avant est posée (elle indique déjà l'avant). Couche "orient" (basculable via showOrientMarks).
      if (!hasFrontImg) {
        const hw = b.w / 2, yF = -b.d / 2 - 1, z0 = b.z, z1 = b.z + b.h;   // yF : 1 mm en saillie → pas de z-fighting avec les arêtes noires
        const fg = new THREE.BufferGeometry();
        fg.setAttribute("position", new THREE.Float32BufferAttribute([
          -hw, yF, z0, hw, yF, z0,   // arête basse
          -hw, yF, z1, hw, yF, z1,   // arête haute
          -hw, yF, z0, -hw, yF, z1,  // arête gauche
          hw, yF, z0, hw, yF, z1,    // arête droite
        ], 3));
        const frontEdges = new THREE.LineSegments(fg, new THREE.LineBasicMaterial({ color: this.theme.front }));
        frontEdges.userData = { layer: "orient" };
        grp.add(frontEdges);
      }
      // nom posé à plat sur la face avant (−Y local) — couche "name" basculable (showEqNames) sans rebuild.
      if (e.name) this.faceLabel(grp, e.name, 0, -b.d / 2 + 1, b.z + b.h / 2, b.w * 0.9, b.h * 0.9, true);
      // ports en coords MONDE → ajoutés au groupe identité (root = gFree) ; couche "port" basculable (showPorts).
      this.store.portsOf(e.id).forEach((p: any) => this.addPort(root, p, dcId));
    });
    // PERSONNAGE d'échelle (repère personnel, vue seule) : dans la salle ACTIVE uniquement, aux coords salle.
    if (dcId === this.builtDc && this.opts.showFigure && this.opts.figure) this.buildHumanFigure(root, this.opts.figure.dcX, this.opts.figure.dcY, this.opts.figure.orient || 0);
  }

  /** Humanoïde procédural (~1,75 m) = repère d'échelle. Primitives Three.js (autonome, hors-ligne) ; posé debout
      sur z=0 aux coords (x,y) de la salle. Non interactif (positionné via les vues 2D). */
  protected buildHumanFigure(group: THREE.Group, x: number, y: number, orient: number): void {
    const fig = new THREE.Group(); fig.position.set(x, y, 0); fig.rotation.z = (orient || 0) * Math.PI / 180;
    const mat = new THREE.MeshStandardMaterial({ color: 0x5b8cc4, roughness: 0.75, metalness: 0.05 });   // teinte « mannequin » distincte
    const cyl = (rt: number, rb: number, h: number, cx: number, cz: number): void => {
      const g = new THREE.CylinderGeometry(rt, rb, h, 16); g.rotateX(Math.PI / 2);   // axe Y → Z (debout)
      const m = new THREE.Mesh(g, mat); m.position.set(cx, 0, cz); fig.add(m);
    };
    cyl(75, 70, 900, -110, 450);   // jambe gauche (0→900)
    cyl(75, 70, 900, 110, 450);    // jambe droite
    cyl(150, 200, 560, 0, 1180);   // torse (900→1460)
    cyl(60, 55, 640, -235, 1140);  // bras gauche
    cyl(60, 55, 640, 235, 1140);   // bras droit
    cyl(55, 55, 70, 0, 1495);      // cou
    const head = new THREE.Mesh(new THREE.SphereGeometry(115, 20, 16), mat); head.position.set(0, 0, 1635); fig.add(head);   // tête (top ≈ 1750)
    fig.userData = { figure: true };   // pas de `pick` → non survolable/cliquable en 3D
    group.add(fig);
  }

  /** Pose (async) une image de façade sur un MATÉRIAU (face d'une BoxGeometry d'équipement libre) — même cache/loader
      que `faceImagePlane`. Le chargement périmé (rebuild entre-temps) est ignoré ; la texture reste en cache. */
  protected applyFaceTexture(material: any, url: string): void {
    if (typeof document === "undefined") return;
    this.faceUrlsInLastBuild.add(url);   // URL versionnée (REST) → marquée « utilisée » pour l'éviction des textures périmées
    const cached = this.imgTexCache.get(url);
    if (cached) { material.map = cached; material.needsUpdate = true; return; }
    if (!this._texLoader) this._texLoader = new THREE.TextureLoader();
    const epoch = this._epoch;
    this._texLoader.load(url, (tex) => {
      (tex as any).colorSpace = (THREE as any).SRGBColorSpace;
      this.imgTexCache.set(url, tex);
      if (this._epoch !== epoch) return;   // (re)build entre-temps : texture conservée pour le prochain build
      material.map = tex; material.needsUpdate = true; this.request();
    }, undefined, () => { /* échec de chargement → ignoré */ });
  }

  /** Marqueur de waypoint : SPRITE 2D (losange billboard, centre noir, teinté accent). `screenSize` (px) sert au mode
      taille STATIQUE (écran constante), `worldSize` (mm) au mode taille RÉELLE — cf. updateScreenScales. */
  protected addMarker(root: THREE.Group, x: number, y: number, z: number, screenSize: number, worldSize: number, id: string): void {
    const tex = this.diamondTexture(); if (!tex) return;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: this.theme.front, transparent: true, depthWrite: false, depthTest: false }));
    spr.position.set(x, y, z); spr.userData = { pick: { type: "wp", id }, screenSize, worldSize, layer: "marker" };   // couche "marker" (showWaypoints)
    root.add(spr);
  }

  /** Waypoints de salle : pins (losange) et rails (tube), cliquables → form waypoint. */
  protected buildWaypoints(dcId: string, root: THREE.Group): void {
    const theme = this.theme;
    const marker = (x: number, y: number, z: number, id: string): void => this.addMarker(root, x, y, z, MARK_PX, MARK_MM, id);
    this.store.waypointsOfDc(dcId).forEach((wp: any) => {
      if (!this.store.waypointIsPlaced(wp) || wp.kind === "brush") return;
      const seg = wp.kind === "segment" && wp.dc_x2 != null;
      // TOUJOURS construits → bascule en visibilité : rail (couche "rail" = waypoints OU conduits), marqueurs ("marker").
      const z = wp.dc_z || 0;
      if (seg) {
        const a = new THREE.Vector3(wp.dc_x, wp.dc_y, z), b = new THREE.Vector3(wp.dc_x2, wp.dc_y2, z);
        const curve = new THREE.LineCurve3(a, b);
        const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 1, 8, 8, false), new THREE.MeshStandardMaterial({ color: theme.front, roughness: 0.5 }));
        tube.userData = { pick: { type: "wp", id: wp.id }, layer: "rail" }; root.add(tube);
        this.buildTray(root, wp, a, b, theme);   // BAC de chemin de câbles (couche "conduit", couleur des brosses)
        marker(a.x, a.y, a.z, wp.id); marker(b.x, b.y, b.z, wp.id);
      } else {
        const an = this.resolver.waypointAnchor(wp);   // ancre RÉSOLUE (pin latéral/capot → repère baie)
        marker(an.x, an.y, an.z, wp.id);
      }
    });
  }

  /** CHEMIN DE CÂBLES rudimentaire d'un waypoint SEGMENT : BAC en U (fond + 2 flancs, extrémités
      OUVERTES — les câbles y entrent/sortent), centré sur le rail et large de `width_mm` (la largeur
      sur laquelle la mécanique conduit RÉPARTIT réellement les câbles, cf. conduitOffsetFor) ; les
      flancs encadrent la hauteur du rail (les câbles passent DANS le bac). Même matériau que les
      brosses (CONDUIT_COLOR translucide + arêtes) ; couche "conduit" (toggle « Brosses et
      passe-câbles ») — le tube fin du rail reste sur la couche "rail". Cliquable → form waypoint. */
  protected buildTray(root: THREE.Group, wp: any, a: THREE.Vector3, b: THREE.Vector3, theme: Theme): void {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy); if (len < 1) return;
    const nx = -dy / len, ny = dx / len;                         // normale HORIZONTALE au rail (les segments sont à plat)
    const hw = Math.max(40, wp.width_mm || 0) / 2;               // demi-largeur (plancher 40 mm : un bac dégénéré reste visible)
    const z0 = a.z - TRAY_WALL_MM / 2, z1 = a.z + TRAY_WALL_MM / 2;
    const P = (e: THREE.Vector3, side: number, zz: number): number[] => [e.x + nx * hw * side, e.y + ny * hw * side, zz];
    const pos: number[] = [];
    const quad = (p1: number[], p2: number[], p3: number[], p4: number[]) => pos.push(...p1, ...p2, ...p3, ...p1, ...p3, ...p4);
    quad(P(a, -1, z0), P(b, -1, z0), P(b, 1, z0), P(a, 1, z0));      // fond
    quad(P(a, -1, z0), P(b, -1, z0), P(b, -1, z1), P(a, -1, z1));    // flanc gauche
    quad(P(a, 1, z0), P(b, 1, z0), P(b, 1, z1), P(a, 1, z1));        // flanc droit
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: CONDUIT_COLOR, roughness: 0.7, metalness: 0.1, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
    mesh.userData = { pick: { type: "wp", id: wp.id }, layer: "conduit" };
    root.add(mesh);
    // arêtes : bords du fond, lèvres hautes des flancs, montants aux extrémités
    const epos: number[] = [];
    const edge = (p1: number[], p2: number[]) => epos.push(...p1, ...p2);
    [-1, 1].forEach((s) => { edge(P(a, s, z0), P(b, s, z0)); edge(P(a, s, z1), P(b, s, z1)); edge(P(a, s, z0), P(a, s, z1)); edge(P(b, s, z0), P(b, s, z1)); });
    const eg = new THREE.BufferGeometry(); eg.setAttribute("position", new THREE.Float32BufferAttribute(epos, 3));
    const le = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: theme.line })); le.userData = { layer: "conduit" }; root.add(le);
  }

  /* ---- câbles intra-salle ---- */
  /** Résolution d'un câble dont les DEUX bouts sont dans `dcId` : extrémités + points de passage TAGUÉS
      par leur waypoint (sinon null). La boucle de passage vit dans la couche partagée (`CableRouting.viaPoints`). */
  protected cableVia(c: any, dcId: string): { a: Vec3; b: Vec3; via: Array<{ wp: any; p: Vec3 }> } | null {
    const a = this.resolver.resolvePort3D(c.from_port_id, dcId), b = this.resolver.resolvePort3D(c.to_port_id, dcId);
    if (!a || !b) return null;   // intra-salle : il faut les deux bouts ici
    return { a, b, via: this.routing.viaPoints(this.store.cableWaypointsIn(c, dcId), a, b, c.id) };
  }

  /** Trace tous les câbles intra-salle en tubes (couleur = réseau) + pastilles d'extrémité, cliquables.
      Le tracé (corps de conduit droits + amorces ⊥ selon `cablePortNormal`) vient de la couche partagée
      `CableRouting.cableLine` — même mécanique que le moteur SVG. */
  protected buildCables(dcId: string, root: THREE.Group): void {
    this.store.all("cables").forEach((c: any) => {
      if (!this.opts.showAllCables && !this.opts.selCables.has(c.id)) return;   // « afficher tous » / sélection
      const rc = this.cableVia(c, dcId);
      if (!rc) return;
      const sp = this.routing.cableLine(rc.a, rc.b, rc.via, this.opts.cablePortNormal);
      this.emitCableTube(root, sp.linePts, sp.straight, this.cableColorHex(c), c.id, this.routing.carriesPower(c), sp.stubAt);
    });
  }

  /** Trace les FAISCEAUX intra-salle (uplink patch ↔ uplink patch) : mêmes tubes que les câbles mais trait
      plus ÉPAIS et couleur NEUTRE, pick "trunk" (clic → formulaire faisceau). Toute la résolution du tracé
      vit dans la couche partagée `TrunkRouting` (fin branchement ici — cf. docs/faisceaux.md). Les trunks
      vivent dans le MÊME groupe que les câbles → cablesOnTop / survol / warm-cache / rebuild s'appliquent. */
  protected buildTrunks(dcId: string, root: THREE.Group): void {
    this.trunks.resolvedTrunks(dcId, this.opts.cablePortNormal).forEach((rt) => {
      if (!this.opts.showAllCables && !this.opts.selCables.has(rt.bundle.id)) return;   // même modèle de visibilité
      this.emitCableTube(root, rt.linePts, rt.straight || new Set(), TRUNK_COLOR, rt.bundle.id, false, rt.stubAt,
        { pickType: "trunk", px: TRUNK_PX, pxSel: TRUNK_PX_SEL });
    });
  }


  /** Décor MULTI-SALLES (repère monde) : plans d'étage (rect + grille + bord de réf + cases bloquées),
      OOB (anneau + mât), étiquettes étage/bâtiment (sprites) + séparateurs. Données pré-calculées par DcBase. */
  protected buildFloorDecor(root: THREE.Group): void {
    const fd = this.floorDecor, theme = this.theme; if (!fd) return;
    fd.planes.forEach((fp) => {
      const cx = fp.ox + fp.W / 2, cy = fp.oy + fp.D / 2;
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(fp.W, fp.D), new THREE.MeshStandardMaterial({ color: theme.floor, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, roughness: 1 }));
      // pick "floorplane" (loc/floor) → clic droit sur la dalle = menu d'étage 3D (éditer plan / + salle / vue 2D).
      plane.position.set(cx, cy, fp.z); plane.userData = { layer: "floorgrid", pick: { type: "floorplane", loc: fp.loc, floor: fp.floor } }; root.add(plane);   // sol = couche "floorgrid" → masquer la grille masque le sol (pas de voile résiduel)
      // grille TOUJOURS construite → couche "floorgrid" (showFloorGrid) basculable en visibilité.
      {
        const step = Math.max(fp.cell || 600, Math.max(fp.W, fp.D) / 40), pts: number[] = [];
        for (let x = 0; x <= fp.W + 0.5; x += step) pts.push(fp.ox + x, fp.oy, fp.z, fp.ox + x, fp.oy + fp.D, fp.z);
        for (let y = 0; y <= fp.D + 0.5; y += step) pts.push(fp.ox, fp.oy + y, fp.z, fp.ox + fp.W, fp.oy + y, fp.z);
        const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
        const gl = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: theme.grid, transparent: true, opacity: 0.4 })); gl.userData = { layer: "floorgrid" }; root.add(gl);
        fp.blocked.forEach((key) => {
          const pp = key.split(","), gx = +pp[0], gy = +pp[1]; if (!isFinite(gx) || !isFinite(gy)) return;
          const rx = gx * fp.cell, ry = gy * fp.cell; if (rx < 0 || ry < 0 || rx >= fp.W || ry >= fp.D) return;
          const cm = new THREE.Mesh(new THREE.PlaneGeometry(fp.cell, fp.cell), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
          cm.position.set(fp.ox + rx + fp.cell / 2, fp.oy + ry + fp.cell / 2, fp.z + 0.5); cm.userData = { layer: "floorgrid" }; root.add(cm);
        });
      }
      // repère d'orientation TOUJOURS construit → couche "orient" (showOrientMarks).
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute([fp.ox, fp.oy, fp.z + 1, fp.ox + fp.W, fp.oy, fp.z + 1], 3));
      const om = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: theme.front })); om.userData = { layer: "orient" }; root.add(om);
    });
    fd.oobs.forEach((o) => {   // OOB TOUJOURS construits → marqueurs "marker" (showWaypoints) ; le mât suit aussi.
      this.addMarker(root, o.x, o.y, o.z, OOB_PX, OOB_MM, o.id);   // losange 2D (déjà tagué "marker")
      if (o.z - o.baseZ > 1) { const mst = new THREE.Mesh(new THREE.BoxGeometry(8, 8, o.z - o.baseZ), new THREE.MeshStandardMaterial({ color: theme.line })); mst.position.set(o.x, o.y, (o.z + o.baseZ) / 2); mst.userData = { layer: "marker" }; root.add(mst); }
    });
    fd.levels.forEach((l) => this.addLabelSprite(root, l.label, l.x, l.y, l.z));
    fd.buildings.forEach((b) => {
      this.addLabelSprite(root, b.label, b.x, b.y, b.z);
      if (b.sepX != null) this.buildBuildingSep(root, b.sepX, fd.maxD, fd.topZ);
    });
  }

  /** Séparateur inter-bâtiment : plan vertical translucide ACCENT + contour POINTILLÉ accent — réplique du
      `.dc-bldg-sep` SVG de référence (fill accent ~0.04, stroke accent dash 10/7). */
  protected buildBuildingSep(root: THREE.Group, x: number, maxD: number, topZ: number): void {
    const col = this.theme.front;
    const fg = new THREE.BufferGeometry();
    fg.setAttribute("position", new THREE.Float32BufferAttribute([x, 0, 0, x, maxD, 0, x, maxD, topZ, x, 0, topZ], 3));
    fg.setIndex([0, 1, 2, 0, 2, 3]);
    const plane = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }));
    root.add(plane);
    const loop = [new THREE.Vector3(x, 0, 0), new THREE.Vector3(x, maxD, 0), new THREE.Vector3(x, maxD, topZ), new THREE.Vector3(x, 0, topZ), new THREE.Vector3(x, 0, 0)];
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(loop), new THREE.LineDashedMaterial({ color: col, transparent: true, opacity: 0.7, depthWrite: false, dashSize: 600, gapSize: 420 }));
    line.computeLineDistances(); root.add(line);
  }

  /** Étiquette texte en BILLBOARD (sprite face caméra), au-dessus de tout (depthTest off). */
  protected addLabelSprite(root: THREE.Group, text: string, x: number, y: number, z: number): void {
    const fontL = 440, charW = 0.6 * fontL;   // étiquettes ×2
    const w = Math.max(charW * 2, text.length * charW), h = fontL * 1.5;
    const tex = this.textTexture(text, w, h); if (!tex) return;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
    spr.position.set(x, y, z); spr.scale.set(w, h, 1); root.add(spr);
  }

  protected rebuildFloorDecor(): void { if (this.gFloorDecor) { this.disposeGroup(this.gFloorDecor); this.buildFloorDecor(this.gFloorDecor); } this.collectScreenObjs(); this.applyLayerVisibility(); }

  /** (Re)collecte les marqueurs à taille écran (waypoints + OOB) et les rescale au zoom courant. */
  protected collectScreenObjs(): void {
    this._screenObjs = [];
    [this.gWaypoints, this.gFloorDecor, this.cablesGroup, this.gExtra, this.gOverlay].forEach((g) => g && g.traverse((o: any) => { if (o.userData && o.userData.screenSize) this._screenObjs.push(o); }));
    this.updateScreenScales();
  }

  /** Câbles/faisceaux TRANSVERSAUX (routes inter-DC / stubs sortants) : tracés MONDE pré-calculés par DcBase.
      `kind: "trunk"` → style faisceau (épais, neutre, pick "trunk"). */
  protected buildExtraCables(root: THREE.Group): void {
    this.extraCables.forEach((ec) => {
      const line = ec.line as Vec3[];
      const col = ec.color ? Color.cssToHex(ec.color) : NaN;
      const style = ec.kind === "trunk" ? { pickType: "trunk" as const, px: TRUNK_PX, pxSel: TRUNK_PX_SEL } : undefined;
      this.emitCableTube(root, line, new Set(ec.straight), isFinite(col) ? col : 0x9aa6b8, ec.id, !!ec.power, ec.stubAt ? new Set(ec.stubAt) : undefined, style);
    });
  }

  /** Émet un câble/faisceau en LIGNE ÉPAISSE (`Line2`) le long du spline cardinal : la `linewidth` est en PIXELS
      écran → épaisseur CONSTANTE quel que soit le zoom (comme le stroke SVG). Cliquable → form câble/faisceau.
      `style` (faisceaux) : type de pick + épaisseurs — le reste (spline, pastilles, onTop) est IDENTIQUE. */
  protected emitCableTube(root: THREE.Group, line: Vec3[], straight: Set<number>, color: number, id: string, power = false, stubAt?: Set<number>, style?: { pickType: "cable" | "trunk"; px: number; pxSel: number }): void {
    if (!line || line.length < 2) return;
    const pickType = style ? style.pickType : "cable";
    const pxNorm = style ? style.px : CABLE_PX, pxSel = style ? style.pxSel : CABLE_PX_SEL;
    const dense = CableSpline.sample(line, straight, this.opts.cableSplineK, stubAt);
    // dédoublonne les points coïncidents (segments de longueur nulle inutiles)
    const pl = dense.filter((v, i) => { if (i === 0) return true; const q = dense[i - 1]; return (v.x - q.x) ** 2 + (v.y - q.y) ** 2 + (v.z - q.z) ** 2 > 0.25; });
    if (pl.length < 2) return;
    const positions: number[] = [];
    pl.forEach((v) => positions.push(v.x, v.y, v.z));
    // SÉLECTIONNÉ (selCables = mis en évidence) → GARDE la couleur de son réseau, mis en évidence par l'épaisseur
    // (2,5px) + l'opacité (1) ; non sélectionné → couleur réseau · 1px · 0,5.
    const sel = this.opts.selCables.has(id);
    const lineColor = color;
    const geo = new LineGeometry(); geo.setPositions(positions);
    // cablesOnTop → depthTest off : le câble passe AU-DESSUS des équipements/baies (toggle, défaut activé).
    const onTop = this.opts.cablesOnTop;
    const mat = new LineMaterial({ color: lineColor, linewidth: sel ? pxSel : pxNorm, worldUnits: false, transparent: true, opacity: sel ? 1 : CABLE_OPACITY, depthTest: !onTop });
    const el = this.host_el; mat.resolution.set(el ? el.clientWidth : 1, el ? el.clientHeight : 1);
    const lineObj = new Line2(geo, mat); lineObj.computeLineDistances();
    lineObj.userData = { pick: { type: pickType, id } };
    if (onTop) lineObj.renderOrder = 2;   // dessine après → vraiment au-dessus
    root.add(lineObj);
    // pastilles d'extrémité : DISQUES 2D (sprites billboard) à TAILLE ÉCRAN, TOUJOURS au-dessus (depthTest off).
    const dotTex = this.circleTexture();
    [line[0], line[line.length - 1]].forEach((p) => {
      const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: lineColor, transparent: true, depthWrite: false, depthTest: false }));
      dot.position.set(p.x, p.y, p.z); dot.userData = { pick: { type: pickType, id }, screenSize: DOT_PX, worldSize: DOT_MM }; dot.renderOrder = 3; root.add(dot);
    });
    // POWER BOLTS : éclairs billboardés répartis le long du tracé (visibles DE PRÈS seulement → géré par updateScreenScales).
    if (power) {
      const tex = this.boltTexture(), spacing = Math.max(50, this.opts.powerBoltSpacingMm || 300);
      let dist = spacing * 0.5;
      for (let i = 0; i < pl.length - 1; i++) {
        const a = pl[i], b = pl[i + 1], seg = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z); if (seg < 1e-6) continue;
        while (dist <= seg) {
          const t = dist / seg;
          const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
          spr.position.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
          spr.userData = { screenSize: BOLT_PX, powerBolt: true }; spr.renderOrder = 4; root.add(spr);
          dist += spacing;
        }
        dist -= seg;
      }
    }
  }

  /** Bascule « câbles au-dessus » EN PLACE : change le depthTest/renderOrder des tubes existants — AUCUNE
      reconstruction de géométrie. (Les pastilles sont déjà toujours au-dessus.) */
  setCablesOnTop(v: boolean): void {
    this.opts.cablesOnTop = v;
    [this.cablesGroup, this.gExtra].forEach((g) => g && g.traverse((o: any) => {
      if (o.material && o.material.isLineMaterial) { o.material.depthTest = !v; o.material.needsUpdate = true; o.renderOrder = v ? 2 : 0; }
    }));
    this.request();
  }

  /** Met à jour la tension du spline et reconstruit UNIQUEMENT les câbles (coalescé sur une frame) — pour le
      slider d'arrondi, sans régénérer baies / occupants / textures de noms (coûteux). */
  setCableSpline(k: number): void {
    this.opts.cableSplineK = k;
    if (this.cableRaf) return;
    this.cableRaf = requestAnimationFrame(() => {
      this.cableRaf = 0;
      if (!this.cablesGroup) return;
      this.rebuildCables();
      this.request();
    });
  }

  /** Couleur d'un câble = couleur de son réseau principal (gris neutre sinon), en HEX Three.js (`number`).
      NB : distinct de `cableColor` (chaîne CSS `string|null`) des vues SVG (`DcScene3D`/`CableRouting`) — d'où le
      suffixe `Hex` pour lever l'ambiguïté entre les deux chaînes d'héritage parallèles. */
  protected cableColorHex(c: any): number {
    const nid = this.store.cablePrimaryNetworkId(c);   // réseau principal DÉDUIT (des ports terminaux)
    const n: any = nid ? this.store.get("networks", nid) : null;
    const hex = n && n.color ? Color.cssToHex(n.color) : NaN;
    return isFinite(hex) ? hex : 0x9aa6b8;
  }

  /** Recharge la salle (changement de données / de salle). */
  rebuild(dcId: string | null): void { this.build(dcId); this.resize(); this.request(); }

  /** Changement de THÈME sans reconstruction : relit les variables CSS et REMAPPE les couleurs des matériaux
      dérivées du thème (old→new) + le fond. Les câbles (couleurs réseau) et les textes ne sont pas touchés. */
  applyThemeChange(): void {
    if (!this.scene) return;
    const old = this.theme, neu = this.readTheme();
    this.scene.background = new THREE.Color(neu.bg);
    const remap = new Map<number, number>();
    (["bg", "floor", "grid", "line", "rack", "fg", "front", "doorMetal", "doorPanel"] as const).forEach((k) => remap.set((old as any)[k], (neu as any)[k]));
    // NB : on IGNORE les matériaux TEXTURÉS BLANCS (étiquettes nom/étage, images de façade) — leur teinte blanche
    // par défaut entre en collision avec `theme.floor` = #ffffff en thème CLAIR, ce qui les recolorerait à tort.
    const apply = (m: any) => { if (!m || !m.color) return; if (m.map && m.color.getHex() === 0xffffff) return; if (remap.has(m.color.getHex())) m.color.setHex(remap.get(m.color.getHex()) as number); };
    // on évite les groupes de CÂBLES (couleurs réseau, indépendantes du thème).
    [this.gDecor, this.gRacks, this.gFree, this.gWaypoints, this.gFloorDecor].forEach((grp) => grp && grp.traverse((o: any) => { const m = o.material; if (!m) return; (Array.isArray(m) ? m : [m]).forEach(apply); }));
    this.theme = neu;
    this.request();
  }


  /* ============================ OUTILS interactifs (mesure / routage) ============================
     Portés depuis le moteur SVG. Le picking natif (rayHits → point monde) remplace le raycast analytique :
     un clic en mode mesure pose un point sur la 1re SURFACE touchée (sinon le plan du sol z=0) ; en mode route
     il identifie un port/waypoint (targetAt) et délègue à la vue. L'overlay vit dans `gOverlay` (persistant). */

  /** Active/désactive un mode outil (la vue pilote selon l'état mesure/route courant). */
  setToolMode(mode: "none" | "measure" | "route"): void {
    if (this.toolMode === mode && mode === "none") return;
    this.toolMode = mode;
    this.clearHover(); this.hovered = null;   // aucune surbrillance héritée de l'ancien mode (ex. cible verte de routage)
    if (mode === "none") { this.measurePts = []; this.measureCursor = null; this.measureDone = []; this.measureHi = null; this.routePts = []; this.routeCursor = null; this.clearOverlay(); }
    const dom = this.renderer?.domElement; if (dom) dom.style.cursor = "default";
    this.request();
  }

  /** Données d'overlay poussées par la vue. La partie STRUCTURELLE (points posés, mesures terminées, surbrillance)
      ne change qu'aux clics ; au simple SURVOL, seul le CURSEUR bouge → on ne reconstruit PAS tout l'overlay
      (dispose + re-création des polylignes/étiquettes/pastilles + re-collecte des screenObjs À CHAQUE mousemove),
      on mute la ligne pointillée et la pastille persistantes (`updateToolCursor`). */
  setMeasureOverlay(pts: { x: number; y: number; z: number }[], cursor: { x: number; y: number; z: number } | null, done?: { x: number; y: number; z: number }[][], hi?: number | null): void {
    this.measurePts = pts || []; this.measureCursor = cursor; this.measureDone = done || []; this.measureHi = (hi == null) ? null : hi;
    const sig = "m:" + this.measurePts.length + ":" + this.measureDone.map((d) => d.length).join(",") + ":" + this.measureHi;
    if (sig !== this._toolSig) { this._toolSig = sig; this.rebuildToolOverlay(); } else this.updateToolCursor();
  }
  setRouteOverlay(pts: { x: number; y: number; z: number }[], cursor: { x: number; y: number; z: number } | null): void {
    this.routePts = pts || []; this.routeCursor = cursor;
    const sig = "r:" + this.routePts.length;
    if (sig !== this._toolSig) { this._toolSig = sig; this.rebuildToolOverlay(); } else this.updateToolCursor();
  }

  /** Point MONDE sous le curseur : 1re surface (mesh) touchée, à défaut intersection du rayon avec le plan du sol z=0.
      `pickablesOnly=false` : la MESURE doit accrocher N'IMPORTE QUELLE surface visible (plan d'étage à z>0, décor…),
      pas seulement les cibles cliquables. */
  protected toolRaycast(clientX: number, clientY: number): { x: number; y: number; z: number } | null {
    const hits = this.rayHits(clientX, clientY, false);
    for (const h of hits) { if ((h as any).face && h.point) return { x: h.point.x, y: h.point.y, z: h.point.z }; }
    const pt = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this._groundPlane, pt)) return { x: pt.x, y: pt.y, z: pt.z };
    return null;
  }

  protected measureClick(clientX: number, clientY: number): void { const w = this.toolRaycast(clientX, clientY); if (w && this.measurePlaceCb) this.measurePlaceCb(w); }
  protected routeClick(clientX: number, clientY: number): void { const desc = this.targetAt(clientX, clientY); if (this.routePickCb) this.routePickCb(desc); }
  protected toolHover(clientX: number, clientY: number): void {
    const dom = this.renderer?.domElement; if (dom) dom.style.cursor = "default";
    if (this.toolMode === "measure") { if (this.measureHoverCb) this.measureHoverCb(this.toolRaycast(clientX, clientY), clientX, clientY); }
    else if (this.toolMode === "route") {
      this.routeHoverHighlight(clientX, clientY);   // cible cliquable (port/waypoint) en évidence — parité 2D `.dc-routing`
      if (this.routeHoverCb) this.routeHoverCb(this.toolRaycast(clientX, clientY));
    }
  }

  protected ensureOverlay(): THREE.Group {
    if (!this.gOverlay || this.gOverlay.parent !== this.scene) { this.gOverlay = new THREE.Group(); this.gOverlay.renderOrder = 20; if (this.scene) this.scene.add(this.gOverlay); }
    return this.gOverlay;
  }
  protected clearOverlay(): void {
    if (this.gOverlay) this.disposeGroup(this.gOverlay);
    this._cursorLine = null; this._cursorDot = null; this._toolSig = "";   // enfants du groupe → détruits avec lui
    this.request();
  }

  protected rebuildToolOverlay(): void {
    const g = this.ensureOverlay(); this.disposeGroup(g);
    this._cursorLine = null; this._cursorDot = null;   // enfants du groupe → détruits par disposeGroup
    if (this.toolMode === "measure") this.drawMeasureOverlay(g);
    else if (this.toolMode === "route") this.drawRouteOverlay(g);
    this.ensureToolCursor(g);   // segment pointillé + pastille PERSISTANTS, mutés au survol (updateToolCursor)
    this.updateToolCursor();
    this.collectScreenObjs(); this.updateScreenScales(); this.request();
  }

  /** Crée les objets PERSISTANTS du curseur d'outil : le segment pointillé « dernier point → curseur » et la
      pastille du curseur. Ils sont MUTÉS en place à chaque survol (updateToolCursor) au lieu d'être détruits et
      recréés par mousemove comme le reste de l'overlay (qui, lui, ne change qu'aux clics). */
  protected ensureToolCursor(g: THREE.Group): void {
    if (this.toolMode === "none") return;
    const color = this.toolMode === "measure" ? 0xffb020 : this.theme.front;   // mêmes couleurs que draw*Overlay
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color, transparent: true, opacity: 0.85, depthTest: false, dashSize: 90, gapSize: 55 }));
    // positions mutées en continu → la bounding sphere n'est jamais à jour : on désactive le frustum culling.
    line.renderOrder = 21; line.visible = false; line.frustumCulled = false;
    g.add(line); this._cursorLine = line;
    const tex = this.circleTexture();
    if (tex && this.toolMode === "measure") {   // la route n'affiche pas de pastille au curseur
      const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, transparent: true, depthWrite: false, depthTest: false }));
      spr.userData = { screenSize: 6 }; spr.renderOrder = 23; spr.visible = false;
      g.add(spr); this._cursorDot = spr;
    }
  }

  /** Met à jour le SEGMENT EN COURS (dernier point posé → curseur) et la pastille du curseur — mutation en place. */
  protected updateToolCursor(): void {
    const pts = this.toolMode === "measure" ? this.measurePts : this.routePts;
    const cur = this.toolMode === "measure" ? this.measureCursor : this.routeCursor;
    const last = pts.length ? pts[pts.length - 1] : null;
    const line = this._cursorLine, dot = this._cursorDot;
    if (dot) { dot.visible = !!cur; if (cur) dot.position.set(cur.x, cur.y, cur.z); }
    if (line) {
      line.visible = !!(cur && last);
      if (cur && last) {
        const pos = line.geometry.getAttribute("position") as THREE.BufferAttribute;
        pos.setXYZ(0, last.x, last.y, last.z); pos.setXYZ(1, cur.x, cur.y, cur.z); pos.needsUpdate = true;
        line.computeLineDistances();   // requis par le pointillé (LineDashedMaterial)
      }
    }
    this.updateScreenScales(); this.request();   // la pastille a bougé → rescale taille-écran + re-rendu
  }

  /** Tracé de mesure : mesures VALIDÉES (étiquette nom+total, surbrillance au survol) + mesure EN COURS (par segment). */
  protected drawMeasureOverlay(g: THREE.Group): void {
    const COL = 0xffb020, HI = 0xffe48a;   // orange (warn) ; surbrillance = orange clair vif
    (this.measureDone || []).forEach((mp, i) => {
      const hot = i === this.measureHi, col = hot ? HI : COL;
      this.drawMeasurePolyline(g, mp, col, false);   // mesure validée : pas d'étiquette par segment
      const c = Measure.centroid(mp); if (c) this.addToolLabel(g, "Mesure " + (i + 1) + " · " + Format.meters(Measure.total(mp)), c);   // étiquette de la mesure
    });
    const pts = this.measurePts;
    this.drawMeasurePolyline(g, pts, COL, true);   // mesure en cours : étiquettes par segment
    // (segment en cours + pastille du curseur : objets PERSISTANTS gérés par ensureToolCursor/updateToolCursor)
  }
  protected drawMeasurePolyline(g: THREE.Group, pts: { x: number; y: number; z: number }[], col: number, segLabels: boolean): void {
    if (pts.length >= 2) this.addToolLine(g, pts, col, false);
    if (segLabels) for (let i = 1; i < pts.length; i++) this.addToolLabel(g, Format.meters(Measure.dist(pts[i - 1], pts[i])), { x: (pts[i - 1].x + pts[i].x) / 2, y: (pts[i - 1].y + pts[i].y) / 2, z: (pts[i - 1].z + pts[i].z) / 2 });
    pts.forEach((p) => this.addToolDot(g, p, col));
  }

  /** Aperçu de route : polyligne (port → waypoints) + segment en cours vers le curseur (pointillé) + pastilles. */
  protected drawRouteOverlay(g: THREE.Group): void {
    const COL = this.theme.front;   // accent
    const pts = this.routePts;
    if (pts.length >= 2) this.addToolLine(g, pts, COL, false);
    // (segment en cours vers le curseur : objet PERSISTANT géré par ensureToolCursor/updateToolCursor)
    pts.forEach((p) => this.addToolDot(g, p, COL));
  }

  /** Polyligne d'overlay (au-dessus de tout, depthTest off) ; `dashed` → pointillé (segment en cours). */
  protected addToolLine(g: THREE.Group, pts: { x: number; y: number; z: number }[], color: number, dashed: boolean): void {
    if (pts.length < 2) return;
    const arr: number[] = []; pts.forEach((p) => arr.push(p.x, p.y, p.z));
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(arr, 3));
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color, transparent: true, opacity: 0.85, depthTest: false, dashSize: 90, gapSize: 55 })
      : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false });
    const line = new THREE.Line(geo, mat); if (dashed) line.computeLineDistances(); line.renderOrder = 21; g.add(line);
  }

  /** Pastille d'overlay (disque billboard à taille écran constante, au-dessus de tout). */
  protected addToolDot(g: THREE.Group, p: { x: number; y: number; z: number }, color: number): void {
    const tex = this.circleTexture(); if (!tex) return;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, transparent: true, depthWrite: false, depthTest: false }));
    spr.position.set(p.x, p.y, p.z); spr.userData = { screenSize: 6 }; spr.renderOrder = 23; g.add(spr);
  }

  /** Étiquette d'overlay (texte billboard, taille ~constante au zoom de construction). */
  protected addToolLabel(g: THREE.Group, text: string, p: { x: number; y: number; z: number }): void {
    const fontMM = Math.max(60, 14 * this.worldPerPixel());   // ~14 px à l'échelle de construction
    const w = Math.max(fontMM * 2, text.length * fontMM * 0.62), h = fontMM * 1.4;
    const tex = this.textTexture(text, w, h); if (!tex) return;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
    spr.position.set(p.x, p.y, p.z); spr.scale.set(w, h, 1); spr.renderOrder = 24; g.add(spr);
  }
}
