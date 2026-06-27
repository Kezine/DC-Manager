/* Couche CONTENU DE SCÈNE du moteur 3D WebGL (cf. en-tête de DcThreeBase) : construit baies + occupants
   (U / latéraux / muraux), montants 19″, équipements libres, waypoints (pins/rails) et câbles intra-salle
   (spline cardinal fidèle au SVG). Gère le diff d'options (reconstruction PARTIELLE par catégorie).
   Classe finale de la chaîne d'héritage → point d'entrée importé par DcBase. */
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { RackGeometry } from "../../../geometry/RackGeometry";
import { FreeEquipGeometry } from "../../../geometry/FreeEquipGeometry";
import { Normalize } from "../../../core/Normalize";
import { EquipmentTypes } from "../../../registries/EquipmentTypes";
import { Depths } from "../../../registries/Depths";
import { U_MM, RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_EAR_MM, SIDE_U_STEP, BRUSH_PADDING_MM } from "../../../domain/constants";
import { Format } from "../../../core/Format";
import type { Vec3 } from "../shared";
import { DcThreeCamera } from "./DcThreeCamera";
import type { DcThreeOptions, RoomDesc, SceneCtx, Theme } from "./DcThreeBase";

export type { DcThreeOptions } from "./DcThreeBase";

const CABLE_PX = 1;          // épaisseur ÉCRAN (px) des câbles — alignée sur .dc-cable du SVG (1px), constante au zoom
const CABLE_OPACITY = 0.5;   // .dc-cable opacity: 0.5
const CABLE_PX_SEL = 2.5;    // .dc-cable.sel stroke-width: 2.5px (sélectionné)
const MARK_PX = 9;           // rayon ÉCRAN (px) d'un marqueur de waypoint (cf. SVG (DC_DOT_PX+4))
const OOB_PX = 11;           // rayon ÉCRAN (px) d'un marqueur OOB
const DOT_PX = 5;            // rayon ÉCRAN (px) d'une pastille d'extrémité de câble (cf. SVG DC_DOT_PX)
const BOLT_PX = 3.25;        // demi-taille ÉCRAN (px) d'un éclair power bolt (−75 %)

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
    this.buildCables(dcR.id, this.roomUnder(this.cablesGroup!, room));
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
    const dcR = this.store.get("datacenters", room.dcId); if (dcR) this.buildCables(dcR.id, this.roomUnder(this.cablesGroup, room));
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
  }

  /** Remplit le groupe des baies d'une salle ; renvoie la hauteur max (cadrage). */
  protected fillRacks(dc: any, group: THREE.Group): number {
    let maxH = U_MM * 42;
    this.store.racksOfDc(dc.id).forEach((r: any) => { const g = this.rackGroup(r); group.add(g.group); this.buildRackPorts(r, group); maxH = Math.max(maxH, g.height); });
    return maxH;
  }

  /** Ports des équipements rackés (U) posés À PLAT sur leur face — en coords MONDE (gRacks = identité). */
  protected buildRackPorts(r: any, group: THREE.Group): void {
    // toujours construits (visibilité gérée par applyLayerVisibility / showPorts) → bascule sans reconstruction.
    this.scene3d.occupantsElev(r.id).forEach((oc: any) => {
      if (oc.kind !== "eq") return;
      const eqSide = oc.side !== "rear" ? "front" : "rear";   // les ports suivent leur équipement (côté) ET leur baie (masquage)
      this.store.portsOf(oc.id).forEach((p: any) => this.addPort(group, p, r.datacenter_id, { eqSide, rackId: r.id }));
    });
  }

  /** Connecteur d'un port : petit plan à la position MONDE du port, orienté selon sa normale de face.
      Coloré par le réseau du câble s'il est câblé (sinon gris) ; cliquable → câble (édition / création préremplie). */
  protected addPort(group: THREE.Group, p: any, dcId: string, extra?: any): void {
    if (p.face_x == null || p.face_y == null) return;
    const pt: any = this.resolver.resolvePort3D(p.id, dcId); if (!pt) return;
    const cab = this.store.cableOnPort(p.id);
    const col = cab ? this.cableColor(cab) : 0x8893a5;
    const csz = this.store.portConnectorSize(p);
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
    const on: Record<string, boolean> = { port: !!o.showPorts, name: !!o.showEqNames, door: !!o.showDoors, doorswing: !!o.showDoorSwing, slot: !!o.showPlaceholders, faceImage: !!o.showFaceImages, conduit: !!o.showConduits, marker: !!o.showWaypoints, rail: !!(o.showWaypoints || o.showConduits), floorgrid: !!o.showFloorGrid, orient: !!o.showOrientMarks, rackshell: !!o.showRackSides };
    let v = true;
    if (u.layer && u.layer in on) v = on[u.layer];
    if (v && u.eqSide) v = u.eqSide === "rear" ? !o.hideRearEq : !o.hideFrontEq;
    return v;
  }

  /** Applique la visibilité des couches taguées (ports/noms/portes/débattement/emplacements/images de façade)
      et des côtés (hideAv/Ar) — sans reconstruction ; le picking ignore déjà les meshes masqués. */
  protected applyLayerVisibility(): void {
    [this.gRacks, this.gFree, this.gWaypoints, this.gFloorDecor].forEach((g) => g && g.traverse((o: any) => { const u = o.userData; if (u && (u.layer || u.eqSide || u.rackId)) o.visible = this.layerVisible(u); }));
  }

  /** Recolore EN PLACE les occupants selon `colorMode` (face/groupe/type) — sans reconstruction. */
  protected applyColorMode(): void {
    [this.gRacks, this.gFree].forEach((g) => g && g.traverse((o: any) => {
      const p = o.userData && o.userData.pick, m: any = (o as any).material;
      if (p && p.type === "occ" && m && m.color) m.color.setHex(this.occColor({ kind: p.kind, id: p.id }));
    }));
  }
  protected rebuildWaypoints(): void { if (this.gWaypoints) this.eachRoom(this.gWaypoints, (dc, g) => this.buildWaypoints(dc.id, g)); this.collectScreenObjs(); this.applyLayerVisibility(); }
  protected rebuildCables(): void {
    if (this.cablesGroup) this.eachRoom(this.cablesGroup, (dc, g) => this.buildCables(dc.id, g));
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
    if (cb) this.rebuildCables();
    if (eqVis || eqColor || cb) this.request();
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

    // COQUE : parois latérales (±X) OPAQUES + faces av/ar (∓Y) et toit/sol (±Z) transparentes (capots à part, percés).
    // Toujours construite OPAQUE → couche "rackshell" basculable en visibilité (showRackSides) : masquage = on voit
    // l'intérieur (pas de box translucide). Les ARÊTES restent toujours visibles (contour de la baie).
    const shellGeo = new THREE.BoxGeometry(w, d, H);
    const cap = new THREE.MeshStandardMaterial({ color: theme.rack, roughness: 0.8, metalness: 0.1, side: THREE.DoubleSide });
    const open = new THREE.MeshStandardMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const shellMat = [cap, cap, open, open, open, open];   // ordre BoxGeometry : +X, −X, +Y(arr), −Y(av), +Z(toit), −Z(sol)
    const shell = new THREE.Mesh(shellGeo, shellMat); shell.position.set(0, 0, H / 2);
    shell.userData = { pick: { type: "rack", id: r.id }, layer: "rackshell" };   // cliquable = baie (repli) · couche capot
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
      const front = u.side !== "rear", eqSide = front ? "front" : "rear";   // côté → bascule hideAv/Ar EN VISIBILITÉ
      const span = Depths.mountSpanMm(u, cageY + (front ? frontExtra : rearExtra));
      // avant : du plan avant (−Y) vers l'intérieur · arrière : du plan arrière (+Y) vers l'intérieur (cf. SVG y0/y1).
      const y0 = front ? fpY + 2 : rpY - Math.max(6, span);
      const y1 = front ? fpY + Math.max(6, span) : rpY - 2;
      const bw = RACK_MOUNT_WIDTH * 0.96;
      const bd = y1 - y0, yc = (y0 + y1) / 2;
      const bh = Math.max(2, u.h * U_MM - 2);
      const zc = baseZ + (u.u - 1) * U_MM + (u.h * U_MM) / 2;
      const color = this.occColor(u);
      const geo = new THREE.BoxGeometry(bw, bd, bh);
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.15 });
      const mesh = new THREE.Mesh(geo, mat); mesh.position.set(0, yc, zc);
      mesh.userData = { pick: { type: "occ", kind: u.kind, id: u.id }, eqSide };
      group.add(mesh);
      const occEdges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }));
      occEdges.position.set(0, yc, zc); occEdges.userData = { eqSide }; group.add(occEdges);
      // nom posé À PLAT sur les DEUX faces du caisson : −Y (avant) ET +Y (arrière) → lisible des deux côtés de la
      // baie. Couche "name" + côté (showEqNames / hideAv-Ar).
      if (u.kind === "eq" && u.label) {
        this.faceLabel(group, u.label, 0, y0 - 0.5, zc, bw * 0.94, bh * 0.9, true, { eqSide });    // face −Y (avant)
        this.faceLabel(group, u.label, 0, y1 + 0.5, zc, bw * 0.94, bh * 0.9, false, { eqSide });   // face +Y (arrière)
      }
      // images de façade : TOUJOURS construites (couche "faceImage" + côté) → bascule en visibilité sans rebuild.
      if (u.kind === "eq") {
        const u0 = this.host.faceImageUrl?.(u.id, front ? "front" : "rear");
        if (u0) this.faceImagePlane(group, u0, 0, y0 - 0.5, zc, bw, bh, true, { layer: "faceImage", eqSide });
        const u1 = this.host.faceImageUrl?.(u.id, front ? "rear" : "front");
        if (u1) this.faceImagePlane(group, u1, 0, y1 + 0.5, zc, bw, bh, false, { layer: "faceImage", eqSide });
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

    // montants 19″ (rails) : barres verticales à l'entraxe ±RACK_MOUNT_WIDTH/2 (cf. rackInterior3D).
    const postX = RACK_MOUNT_WIDTH / 2, pw = Math.min(RACK_EAR_MM * 0.8, 8);
    const pz1 = baseZ + (r.u_count || 42) * U_MM;
    const posts = (r.sides === "dual") ? [fpY, rpY] : [fpY];
    posts.forEach((ly) => [postX, -postX].forEach((px) => this.localBox(group, px - pw, px + pw, ly - 2, ly + 2, baseZ, pz1, theme.line)));

    // BROSSES de brassage ancrées à cette baie : coque creuse + tunnel av→ar. TOUJOURS construites → couche
    // "conduit" basculable (showConduits) en visibilité, sans reconstruction.
    {
      const bodyHW = RACK_MOUNT_WIDTH / 2 - RACK_EAR_MM;
      this.store.all("waypoints").forEach((wp: any) => { if (wp.kind === "brush" && wp.rack_id === r.id) this.buildBrush(group, wp, baseZ, fpY, cageY, bodyHW, theme); });
    }

    // emplacements LIBRES (cibles d'assignation) — TOUJOURS construits → couche "slot" (showPlaceholders) + côté
    // (hideAv/Ar) basculables EN VISIBILITÉ sans reconstruction (le picking ignore les emplacements masqués).
    {
      const occMap = this.scene3d.occupants(r.id), uMax = r.u_count || 42, bodyHW = RACK_MOUNT_WIDTH / 2 - RACK_EAR_MM;
      const sides = (r.sides === "dual") ? ["front", "rear"] : ["front"];
      sides.forEach((side) => {
        const yPlane = side === "rear" ? rpY - 2 : fpY + 2;
        for (let u = 1; u <= uMax; u++) {
          if (occMap.has(u + ":" + side)) continue;
          const zc = baseZ + (u - 0.5) * U_MM;
          this.slotPlane(group, 2 * bodyHW * 0.96, U_MM - 3, 0, yPlane, zc, side === "front", { type: "slotU", rackId: r.id, u, side, height: 1 }, { layer: "slot", eqSide: side });
        }
      });
      // emplacements LATÉRAUX libres (marges) → cibles d'assignation (équipement / pin latéral).
      // décalés très légèrement vers l'EXTÉRIEUR (le long de la normale de face) pour ne pas cliper dans la coque.
      const SLOT_OFF = 2;
      const xLim = w / 2 - SLOT_OFF;   // bord latéral max = position des slots de paroi (s'arrête avant le capot/la paroi)
      this.scene3d.sideFreeSlots(r).forEach((s: any) => {
        const front = s.face !== "rear";
        const b = RackGeometry.sideSlotBoxLocal(r, s.face, s.lr, s.col, s.uTop, SIDE_U_STEP);
        const x0 = Math.max(Math.min(b.x0, b.x1), -xLim), x1 = Math.min(Math.max(b.x0, b.x1), xLim);   // borné au plan de paroi
        const z0 = Math.min(b.z0, b.z1), z1 = Math.max(b.z0, b.z1);
        if (x1 <= x0) return;
        const yp = b.yPlane + (front ? SLOT_OFF : -SLOT_OFF);   // vers l'EXTÉRIEUR (décalage av/ar)
        this.slotPlane(group, x1 - x0, z1 - z0, (x0 + x1) / 2, yp, (z0 + z1) / 2, front, { type: "slotSide", rackId: r.id, face: s.face, lr: s.lr, col: s.col, uTop: s.uTop }, { layer: "slot", eqSide: front ? "front" : "rear" });
      });
      // emplacements MURAUX libres (parois ±X) → monter équipement en paroi (décalés vers l'INTÉRIEUR de la baie).
      this.scene3d.wallFreeSlots(r).forEach((s: any) => {
        const front = s.margin !== "rear";
        const b = RackGeometry.wallSlotBoxLocal(r, s.wall, s.margin, s.col, s.uTop, SIDE_U_STEP);
        const xp = b.xPlane - Math.sign(b.xPlane || 1) * SLOT_OFF;   // vers le centre (intérieur)
        this.slotQuad(group, [[xp, b.y0, b.z0], [xp, b.y1, b.z0], [xp, b.y1, b.z1], [xp, b.y0, b.z1]], { type: "slotWall", rackId: r.id, wall: s.wall, margin: s.margin, col: s.col, uTop: s.uTop }, { layer: "slot", eqSide: front ? "front" : "rear" });
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
  protected slotPlane(group: THREE.Group, w: number, h: number, x: number, y: number, z: number, front: boolean, pick: any, extra?: any): void {
    const mat = new THREE.MeshStandardMaterial({ color: this.theme.front, transparent: true, opacity: 0.16, emissive: 0x16314e, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.position.set(x, y, z);
    mesh.rotation.x = front ? Math.PI / 2 : -Math.PI / 2;
    mesh.userData = Object.assign({ pick }, extra);   // cadre = enfant (suit la visibilité du mesh)
    // cadre (rectangle fermé) — délimite clairement la case, hérite de la pose du plan
    const hw = w / 2, hh = h / 2;
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.Float32BufferAttribute([-hw, -hh, 0, hw, -hh, 0, hw, hh, 0, -hw, hh, 0], 3));
    mesh.add(new THREE.LineLoop(bg, new THREE.LineBasicMaterial({ color: this.theme.front, transparent: true, opacity: 0.6 })));
    group.add(mesh);
  }

  /** Emplacement libre QUELCONQUE défini par 4 coins (coords locales) : remplissage translucide + cadre accent,
      surligné au survol. Pour les faces que `slotPlane` ne couvre pas (mural ±X, capot ±Z horizontal). */
  protected slotQuad(group: THREE.Group, corners: number[][], pick: any, extra?: any): void {
    const [a, b, c, d] = corners;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: this.theme.front, transparent: true, opacity: 0.16, emissive: 0x16314e, side: THREE.DoubleSide, depthWrite: false }));
    mesh.userData = Object.assign({ pick }, extra); group.add(mesh);
    const bg = new THREE.BufferGeometry(); bg.setAttribute("position", new THREE.Float32BufferAttribute([...a, ...b, ...c, ...d], 3));
    mesh.add(new THREE.LineLoop(bg, new THREE.LineBasicMaterial({ color: this.theme.front, transparent: true, opacity: 0.6 })));
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
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: theme.rack, roughness: 0.8, metalness: 0.1, side: THREE.DoubleSide }));
    mesh.position.z = zc; mesh.userData = { pick: { type: "rack", id: r.id }, layer: "rackshell" };   // couche capot (showRackSides)
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
    // vantail PLEINE LARGEUR ; le DÉGAGEMENT de rotation est juste un DÉCALAGE des charnières de T vers l'intérieur
    // (et donc du rayon d'ouverture, cf. buildDoorSwing). Pas de panneau de comblement.
    // « gauche/droite » = vu DE LA FACE de la porte : avant (−Y) gauche = −X ; arrière (+Y) gauche = +X (inversé).
    const left = (dr.hinge !== "right") !== rear, clr = T;
    const xL = -hw, xR = hw, cx = 0, dw = w;
    const xHinge = left ? (-hw + clr) : (hw - clr);   // charnières décalées de T (axe de rotation)
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
    // PANNEAU : perforé (ventilé) → alphaMap fentes + métal · plein → vitre translucide.
    const pw = Math.max(1, dw - 2 * FRAME), ph = Math.max(1, H - 2 * FRAME);
    let panelMat: THREE.MeshStandardMaterial;
    if (dr.hollow) {
      const perf = this.perfTexture();
      panelMat = new THREE.MeshStandardMaterial({ color: theme.doorPanel, metalness: 0.7, roughness: 0.5, side: THREE.DoubleSide, alphaMap: perf || undefined, alphaTest: perf ? 0.5 : 0 });
    } else {
      panelMat = new THREE.MeshStandardMaterial({ color: 0xaecadf, metalness: 0.1, roughness: 0.07, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    }
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), panelMat);
    panel.position.set(cx, yLeaf, H / 2); panel.rotation.x = rear ? -Math.PI / 2 : Math.PI / 2;   // normale ±Y (vers l'extérieur)
    panel.userData = { pick, layer: "door", rackId: r.id }; group.add(panel);
    // POIGNÉE (barre verticale en saillie, côté OPPOSÉ à la charnière).
    const latchX = left ? (xR - FRAME - 18) : (xL + FRAME + 18);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(14, Math.max(4, T * 0.7), Math.min(180, H * 0.12)), metal());
    handle.position.set(latchX, yOut + sgn * 5, H / 2); handle.userData = { pick, layer: "door", rackId: r.id }; group.add(handle);
    // GONDS (2 cylindres verticaux) — placés sur l'AXE DE ROTATION théorique du vantail = arête charnière, sur la
    // face extérieure (yOut), pivot d'un battant qui s'ouvre vers l'extérieur. Couleur des repères de FAÇADE.
    const hingeMat = new THREE.MeshStandardMaterial({ color: theme.front, metalness: 0.4, roughness: 0.5 });
    [H * 0.22, H * 0.78].forEach((hz) => {
      const k = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 46, 12), hingeMat);
      k.rotation.x = Math.PI / 2; k.position.set(xHinge, yOut, hz);   // axe Y → Z (vertical), sur l'axe de rotation
      k.userData = { layer: "door", rackId: r.id }; group.add(k);
    });
  }

  /** PROJECTION 2D au sol du DÉBATTEMENT d'une porte (rayon d'ouverture) : secteur quart-de-disque (90°) au sol
      (z≈1), pivot = charnière, rayon = largeur de porte, balayé de la position fermée (le long de la face) vers
      l'extérieur de la baie. Couleurs des EMPLACEMENTS LIBRES (remplissage + cadre accent). Couche basculable
      "doorswing" (showDoorSwing), non interactive. */
  protected buildDoorSwing(group: THREE.Group, rear: boolean, dr: any, w: number, d: number, theme: Theme): void {
    const hd = d / 2, hw = w / 2, clr = Math.max(6, dr.thickness_mm | 0), R = w - clr, N = 18, Z = 1;   // rayon = largeur réelle du vantail
    const cavity = dr.hollow ? Math.max(0, dr.hollow_mm | 0) : 0;
    const sgn = rear ? 1 : -1;                                   // face/ouverture vers l'extérieur (avant −Y / arrière +Y)
    const left = (dr.hinge !== "right") !== rear;                // gauche vue DE LA FACE de la porte (inversé à l'arrière)
    const dirX = left ? 1 : -1;                                  // sens du vantail fermé le long de la face
    const beta = (Math.sign(sgn / dirX)) * Math.PI / 2;        // angle d'ouverture (90°) — R(beta)·(dirX,0) = (0,sgn)
    const hx = left ? (-hw + clr) : (hw - clr), hy = sgn * (hd + cavity + clr);   // pivot = axe de rotation (arête charnière, face extérieure)
    const pts: number[] = [hx, hy, Z];                          // centre du secteur
    for (let i = 0; i <= N; i++) {
      const a = beta * (i / N), c = Math.cos(a), s = Math.sin(a);
      const vx = dirX * R, vy = 0;                              // vantail fermé (le long de la face)
      pts.push(hx + (vx * c - vy * s), hy + (vx * s + vy * c), Z);   // rotation du vantail autour du pivot
    }
    const fill: number[] = [];
    for (let i = 0; i < N; i++) { const o = 3 * (i + 1); fill.push(pts[0], pts[1], pts[2], pts[o], pts[o + 1], pts[o + 2], pts[o + 3], pts[o + 4], pts[o + 5]); }
    const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(fill, 3)); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: theme.front, transparent: true, opacity: 0.16, emissive: 0x16314e, side: THREE.DoubleSide, depthWrite: false }));
    mesh.userData = { layer: "doorswing" }; group.add(mesh);
    const bg = new THREE.BufferGeometry(); bg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));   // cadre : pivot → arc → (retour au pivot)
    const loop = new THREE.LineLoop(bg, new THREE.LineBasicMaterial({ color: theme.front, transparent: true, opacity: 0.6 }));
    loop.userData = { layer: "doorswing" }; group.add(loop);
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
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8a7a55, roughness: 0.7, metalness: 0.1, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
    mesh.userData = { pick: { type: "wp", id: wp.id }, layer: "conduit" };   // couche basculable (showConduits)
    group.add(mesh);
    const epos: number[] = [];
    const edge = (a: number[], b: number[]) => epos.push(...a, ...b);
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; edge(FO[i], FO[j]); edge(BO[i], BO[j]); edge(FI[i], FI[j]); edge(BI[i], BI[j]); edge(FO[i], BO[i]); edge(FI[i], BI[i]); }
    const eg = new THREE.BufferGeometry(); eg.setAttribute("position", new THREE.Float32BufferAttribute(epos, 3));
    const be = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: theme.line })); be.userData = { layer: "conduit" }; group.add(be);
  }

  /** Couleur d'un occupant selon le mode (face = neutre · groupe · type) ; gris pour items/brosses. */
  protected occColor(u: any): number {
    if (u.kind !== "eq") return u.kind === "brush" ? 0x8a7a55 : 0x55607a;
    const e: any = this.store.get("equipments", u.id);
    if (!e) return 0x6c7a8c;
    if (this.opts.colorMode === "group") {
      const g: any = e.group_id ? this.store.get("groups", e.group_id) : null;
      const c = g && g.color ? this.parseColor(g.color) : NaN; return isFinite(c) ? c : 0x6c7a8c;
    }
    if (this.opts.colorMode === "type") { const c = this.parseColor(EquipmentTypes.color(e.type)); return isFinite(c) ? c : 0x6c7a8c; }
    return 0x6c7a8c;   // mode « face » : couleur neutre (le moteur SVG s'appuie sur le CSS, non porté ici)
  }

  /* ---- équipements libres + waypoints de salle ---- */
  /** Équipements en dimensionnement LIBRE posés dans la salle : boîtes 6 faces (cliquables / survolables). */
  protected buildFreeEquip(dcId: string, root: THREE.Group): void {
    this.store.freeEquipsOfDc(dcId).forEach((e: any) => {
      if (e.dc_x == null || e.dc_y == null) return;
      const b = FreeEquipGeometry.box(e);
      const o = Normalize.rackOrientation(e.dc_orientation) * Math.PI / 180;
      const color = this.occColor({ kind: "eq", id: e.id });
      const grp = new THREE.Group(); grp.position.set(e.dc_x, e.dc_y, 0); grp.rotation.z = o; root.add(grp);
      const geo = new THREE.BoxGeometry(b.w, b.d, b.h);
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.15 }));
      mesh.position.set(0, 0, b.z + b.h / 2);
      mesh.userData = { pick: { type: "occ", kind: "eq", id: e.id } };   // même traitement que les occupants (détail + survol)
      grp.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }));
      edges.position.copy(mesh.position); grp.add(edges);
      // nom posé à plat sur la face avant (−Y local) — couche "name" basculable (showEqNames) sans rebuild.
      if (e.name) this.faceLabel(grp, e.name, 0, -b.d / 2 + 1, b.z + b.h / 2, b.w * 0.9, b.h * 0.9, true);
      // ports en coords MONDE → ajoutés au groupe identité (root = gFree) ; couche "port" basculable (showPorts).
      this.store.portsOf(e.id).forEach((p: any) => this.addPort(root, p, dcId));
    });
  }

  /** Marqueur de waypoint : SPRITE 2D (losange billboard, centre noir, teinté accent), à taille écran constante. */
  protected addMarker(root: THREE.Group, x: number, y: number, z: number, screenSize: number, id: string): void {
    const tex = this.diamondTexture(); if (!tex) return;
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: this.theme.front, transparent: true, depthWrite: false, depthTest: false }));
    spr.position.set(x, y, z); spr.userData = { pick: { type: "wp", id }, screenSize, layer: "marker" };   // couche "marker" (showWaypoints)
    root.add(spr);
  }

  /** Waypoints de salle : pins (losange) et rails (tube), cliquables → form waypoint. */
  protected buildWaypoints(dcId: string, root: THREE.Group): void {
    const theme = this.theme;
    const marker = (x: number, y: number, z: number, id: string): void => this.addMarker(root, x, y, z, MARK_PX, id);
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
        marker(a.x, a.y, a.z, wp.id); marker(b.x, b.y, b.z, wp.id);
      } else {
        const an = this.resolver.waypointAnchor(wp);   // ancre RÉSOLUE (pin latéral/capot → repère baie)
        marker(an.x, an.y, an.z, wp.id);
      }
    });
  }

  /* ---- câbles intra-salle ---- */
  /** Résolution d'un câble dont les DEUX bouts sont dans `dcId` : extrémités + points de passage TAGUÉS
      par leur waypoint (sinon null). Réplique de `resolvedCables` mais conserve le wp (pour la mécanique conduit). */
  protected cableVia(c: any, dcId: string): { a: Vec3; b: Vec3; via: Array<{ wp: any; p: Vec3 }> } | null {
    const a = this.resolver.resolvePort3D(c.from_port_id, dcId), b = this.resolver.resolvePort3D(c.to_port_id, dcId);
    if (!a || !b) return null;   // intra-salle : il faut les deux bouts ici
    const wps = this.store.cableWaypointsIn(c, dcId);
    const anchors = wps.map((w: any) => this.resolver.waypointAnchor(w));
    const via: Array<{ wp: any; p: Vec3 }> = [];
    wps.forEach((w: any, i: number) => {
      const prev = i === 0 ? a : anchors[i - 1], next = i === wps.length - 1 ? b : anchors[i + 1];
      const off = this.resolver.conduitOffsetFor(w, c.id, prev, next);
      this.resolver.waypointPassPoints(w, prev, next, off).forEach((p: any) => via.push({ wp: w, p }));
    });
    return { a, b, via };
  }

  /** Échantillonne le SPLINE CARDINAL du moteur SVG (tension `k`) en polyligne dense 3D ; les segments de
      `straight` restent des CHORDES DROITES. Aux points d'amorce `stubAt` (sortie ⊥), la tangente est IMPOSÉE =
      axe du segment droit adjacent (continuité G1, comme `cablePath` du SVG → la courbe part/arrive dans l'axe,
      aucun « kink » → la sortie reste perpendiculaire). Contrôles intérieurs : C1 = P[i]+(P[i+1]−P[i−1])·k. */
  protected cardinalSample(P: Vec3[], straight: Set<number>, k: number, stubAt?: Set<number>): THREE.Vector3[] {
    const V = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);
    if (P.length < 2) return P.map(V);
    const n = P.length, hk = k * 2.5;
    const dist = (a: Vec3, b: Vec3) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    const unit = (a: Vec3, b: Vec3) => { const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.hypot(dx, dy, dz) || 1; return { x: dx / L, y: dy / L, z: dz / L }; };
    // direction d'amorce imposée à i = axe de SON segment droit adjacent (G1 avec le segment droit)
    const stubDir = (i: number): { x: number; y: number; z: number } | null => {
      if (!stubAt || !stubAt.has(i)) return null;
      if (straight.has(i)) return unit(P[i], P[i + 1]);             // segment droit APRÈS i
      if (i > 0 && straight.has(i - 1)) return unit(P[i - 1], P[i]); // segment droit AVANT i
      return null;
    };
    const tan = (i: number, segLen: number): THREE.Vector3 => {
      const d = stubDir(i);
      if (d) return new THREE.Vector3(d.x * segLen * hk, d.y * segLen * hk, d.z * segLen * hk);   // amorce : alignée sur l'axe
      const p0 = P[Math.max(0, i - 1)], p1 = P[Math.min(n - 1, i + 1)];
      return new THREE.Vector3((p1.x - p0.x) * k, (p1.y - p0.y) * k, (p1.z - p0.z) * k);          // intérieur : Catmull-Rom
    };
    const out: THREE.Vector3[] = [V(P[0])];
    for (let i = 0; i < n - 1; i++) {
      const p1 = V(P[i]), p2 = V(P[i + 1]);
      if (straight.has(i)) { out.push(p2); continue; }   // chorde droite (corps de conduit / amorce ⊥)
      const segLen = dist(P[i], P[i + 1]);
      const c1 = p1.clone().add(tan(i, segLen)), c2 = p2.clone().sub(tan(i + 1, segLen));
      // densité adaptée à la longueur de la corde (~1 point / 5 mm), pour des courbes franchement lisses.
      const perSeg = Math.max(16, Math.min(260, Math.round(p1.distanceTo(p2) / 5)));
      for (let s = 1; s <= perSeg; s++) {
        const t = s / perSeg, u = 1 - t;
        // Bézier cubique B(t) = u³P1 + 3u²t C1 + 3ut² C2 + t³P2
        const x = u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x;
        const y = u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y;
        const z = u * u * u * p1.z + 3 * u * u * t * c1.z + 3 * u * t * t * c2.z + t * t * t * p2.z;
        out.push(new THREE.Vector3(x, y, z));
      }
    }
    return out;
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
      this.emitCableTube(root, sp.linePts, sp.straight, this.cableColor(c), c.id, this.cableIsPower(c), sp.stubAt);
    });
  }

  /** Câble d'alimentation ? (type de câble `kind === "power"`). */
  protected cableIsPower(c: any): boolean { const t: any = c && c.cable_type_id ? this.store.get("cableTypes", c.cable_type_id) : null; return !!(t && t.kind === "power"); }

  /** Décor MULTI-SALLES (repère monde) : plans d'étage (rect + grille + bord de réf + cases bloquées),
      OOB (anneau + mât), étiquettes étage/bâtiment (sprites) + séparateurs. Données pré-calculées par DcBase. */
  protected buildFloorDecor(root: THREE.Group): void {
    const fd = this.floorDecor, theme = this.theme; if (!fd) return;
    fd.planes.forEach((fp) => {
      const cx = fp.ox + fp.W / 2, cy = fp.oy + fp.D / 2;
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(fp.W, fp.D), new THREE.MeshStandardMaterial({ color: theme.floor, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, roughness: 1 }));
      plane.position.set(cx, cy, fp.z); plane.userData = { layer: "floorgrid" }; root.add(plane);   // sol = couche "floorgrid" → masquer la grille masque le sol (pas de voile résiduel)
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
      this.addMarker(root, o.x, o.y, o.z, OOB_PX, o.id);   // losange 2D (déjà tagué "marker")
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

  /** Câbles TRANSVERSAUX (routes inter-DC / stubs sortants) : tracés MONDE pré-calculés par DcBase. */
  protected buildExtraCables(root: THREE.Group): void {
    this.extraCables.forEach((ec) => {
      const line = ec.line as Vec3[];
      const col = ec.color ? this.parseColor(ec.color) : NaN;
      this.emitCableTube(root, line, new Set(ec.straight), isFinite(col) ? col : 0x9aa6b8, ec.id, !!ec.power, ec.stubAt ? new Set(ec.stubAt) : undefined);
    });
  }

  /** Émet un câble en LIGNE ÉPAISSE (`Line2`) le long du spline cardinal : la `linewidth` est en PIXELS écran →
      épaisseur CONSTANTE quel que soit le zoom (comme le stroke SVG). Cliquable → form câble. */
  protected emitCableTube(root: THREE.Group, line: Vec3[], straight: Set<number>, color: number, id: string, power = false, stubAt?: Set<number>): void {
    if (!line || line.length < 2) return;
    const dense = this.cardinalSample(line, straight, this.opts.cableSplineK, stubAt);
    // dédoublonne les points coïncidents (segments de longueur nulle inutiles)
    const pl = dense.filter((v, i) => i === 0 || v.distanceToSquared(dense[i - 1]) > 0.25);
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
    const mat = new LineMaterial({ color: lineColor, linewidth: sel ? CABLE_PX_SEL : CABLE_PX, worldUnits: false, transparent: true, opacity: sel ? 1 : CABLE_OPACITY, depthTest: !onTop });
    const el = this.host_el; mat.resolution.set(el ? el.clientWidth : 1, el ? el.clientHeight : 1);
    const lineObj = new Line2(geo, mat); lineObj.computeLineDistances();
    lineObj.userData = { pick: { type: "cable", id } };
    if (onTop) lineObj.renderOrder = 2;   // dessine après → vraiment au-dessus
    root.add(lineObj);
    // pastilles d'extrémité : DISQUES 2D (sprites billboard) à TAILLE ÉCRAN, TOUJOURS au-dessus (depthTest off).
    const dotTex = this.circleTexture();
    [line[0], line[line.length - 1]].forEach((p) => {
      const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: dotTex, color: lineColor, transparent: true, depthWrite: false, depthTest: false }));
      dot.position.set(p.x, p.y, p.z); dot.userData = { pick: { type: "cable", id }, screenSize: DOT_PX }; dot.renderOrder = 3; root.add(dot);
    });
    // POWER BOLTS : éclairs billboardés répartis le long du tracé (visibles DE PRÈS seulement → géré par updateScreenScales).
    if (power) {
      const tex = this.boltTexture(), spacing = Math.max(50, this.opts.powerBoltSpacingMm || 300);
      let dist = spacing * 0.5;
      for (let i = 0; i < pl.length - 1; i++) {
        const a = pl[i], b = pl[i + 1], seg = a.distanceTo(b); if (seg < 1e-6) continue;
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

  /** Couleur d'un câble = couleur de son réseau principal (gris neutre sinon). */
  protected cableColor(c: any): number {
    const n: any = c && c.network_id ? this.store.get("networks", c.network_id) : null;
    const hex = n && n.color ? this.parseColor(n.color) : NaN;
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
    if (mode === "none") { this.measurePts = []; this.measureCursor = null; this.measureDone = []; this.measureHi = null; this.routePts = []; this.routeCursor = null; this.clearOverlay(); }
    const dom = this.renderer?.domElement; if (dom) dom.style.cursor = "default";
    this.request();
  }

  /** Données d'overlay poussées par la vue → reconstruit le tracé. */
  setMeasureOverlay(pts: { x: number; y: number; z: number }[], cursor: { x: number; y: number; z: number } | null, done?: { x: number; y: number; z: number }[][], hi?: number | null): void { this.measurePts = pts || []; this.measureCursor = cursor; this.measureDone = done || []; this.measureHi = (hi == null) ? null : hi; this.rebuildToolOverlay(); }
  setRouteOverlay(pts: { x: number; y: number; z: number }[], cursor: { x: number; y: number; z: number } | null): void { this.routePts = pts || []; this.routeCursor = cursor; this.rebuildToolOverlay(); }

  /** Point MONDE sous le curseur : 1re surface (mesh) touchée, à défaut intersection du rayon avec le plan du sol z=0. */
  protected toolRaycast(clientX: number, clientY: number): { x: number; y: number; z: number } | null {
    const hits = this.rayHits(clientX, clientY);
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
    else if (this.toolMode === "route") { if (this.routeHoverCb) this.routeHoverCb(this.toolRaycast(clientX, clientY)); }
  }

  protected ensureOverlay(): THREE.Group {
    if (!this.gOverlay || this.gOverlay.parent !== this.scene) { this.gOverlay = new THREE.Group(); this.gOverlay.renderOrder = 20; if (this.scene) this.scene.add(this.gOverlay); }
    return this.gOverlay;
  }
  protected clearOverlay(): void { if (this.gOverlay) this.disposeGroup(this.gOverlay); this.request(); }

  protected rebuildToolOverlay(): void {
    const g = this.ensureOverlay(); this.disposeGroup(g);
    if (this.toolMode === "measure") this.drawMeasureOverlay(g);
    else if (this.toolMode === "route") this.drawRouteOverlay(g);
    this.collectScreenObjs(); this.updateScreenScales(); this.request();
  }

  /** Tracé de mesure : mesures VALIDÉES (étiquette nom+total, surbrillance au survol) + mesure EN COURS (par segment). */
  protected drawMeasureOverlay(g: THREE.Group): void {
    const COL = 0xffb020, HI = 0xffe48a;   // orange (warn) ; surbrillance = orange clair vif
    (this.measureDone || []).forEach((mp, i) => {
      const hot = i === this.measureHi, col = hot ? HI : COL;
      this.drawMeasurePolyline(g, mp, col, false);   // mesure validée : pas d'étiquette par segment
      const c = this.polyCentroid(mp); if (c) this.addToolLabel(g, "Mesure " + (i + 1) + " · " + Format.meters(this.polyLen(mp)), c);   // étiquette de la mesure
    });
    const pts = this.measurePts;
    this.drawMeasurePolyline(g, pts, COL, true);   // mesure en cours : étiquettes par segment
    if (this.measureCursor && pts.length) this.addToolLine(g, [pts[pts.length - 1], this.measureCursor], COL, true);   // segment en cours
    if (this.measureCursor) this.addToolDot(g, this.measureCursor, COL);
  }
  protected drawMeasurePolyline(g: THREE.Group, pts: { x: number; y: number; z: number }[], col: number, segLabels: boolean): void {
    if (pts.length >= 2) this.addToolLine(g, pts, col, false);
    if (segLabels) for (let i = 1; i < pts.length; i++) this.addToolLabel(g, Format.meters(this.segLen(pts[i - 1], pts[i])), { x: (pts[i - 1].x + pts[i].x) / 2, y: (pts[i - 1].y + pts[i].y) / 2, z: (pts[i - 1].z + pts[i].z) / 2 });
    pts.forEach((p) => this.addToolDot(g, p, col));
  }
  protected polyLen(pts: { x: number; y: number; z: number }[]): number { let s = 0; for (let i = 1; i < pts.length; i++) s += this.segLen(pts[i - 1], pts[i]); return s; }
  protected polyCentroid(pts: { x: number; y: number; z: number }[]): { x: number; y: number; z: number } | null { if (!pts.length) return null; let x = 0, y = 0, z = 0; pts.forEach((p) => { x += p.x; y += p.y; z += p.z; }); const n = pts.length; return { x: x / n, y: y / n, z: z / n }; }

  /** Aperçu de route : polyligne (port → waypoints) + segment en cours vers le curseur (pointillé) + pastilles. */
  protected drawRouteOverlay(g: THREE.Group): void {
    const COL = this.theme.front;   // accent
    const pts = this.routePts;
    if (pts.length >= 2) this.addToolLine(g, pts, COL, false);
    if (this.routeCursor && pts.length) this.addToolLine(g, [pts[pts.length - 1], this.routeCursor], COL, true);
    pts.forEach((p) => this.addToolDot(g, p, COL));
  }

  protected segLen(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

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
