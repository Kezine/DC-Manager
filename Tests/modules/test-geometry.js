/* Tests modules — géométrie pure (racks, salles, portes, splines, positionnement, 3D).
   Sections extraites de run.js (audit P5) ; harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, TsImports, mkStorage, Store, BrowserStorageAdapter, PlacementContainers, FieldIndex, Equipment, Cable, Port, Normalize, Labeler, ClickGuard, Projection, Box, Painter, RackGeometry, PlacementFrame, TrayFrame, TrayGeometry, GraphGeometry, RouteGraphLayout, ROUTE_GRAPH, RouteMiniGraph, LeaderLayout, FaceAlign, RackLabelLayout, Homography, ImageStitch, EquipmentTypes, PortRoles, Depths, EquipFaces, RackScene, Resolver3D, CableRouting, TrunkRouting, U_MM, RACK_MOUNT_WIDTH, COLOR_PALETTE, Html, Color, Format, GridGeometry, GraphView, Sort, Ip, Prefs, DatacenterView, FloorLayout, SiteLayout, SITE_FALLBACK_STEP_M, SITE_SCALE_DEFAULT_M_PER_KM, Positioning, PivotBounds, CameraFraming, DoorGeometry, Doors, DOOR_WALLS, DOOR_DEFAULT_WIDTH_MM, DoorTool, Measure, CableSpline, MeasureTool, RouteTool, ImageStore, FaceImage, SaveState, EntityRegistry, ReloadPlanner, COLLECTION_THREE_IMPACT, RenderImpact, Changeset, SharedSchema, Text, PAGE_SIZE_DEFAULT, Validation, Cascade, Rack, CABLE_STATUSES, EQUIP_DEPTHS, GROUP_TYPES, RACK_ITEM_KINDS, SPARE_TYPES, SPARE_STATUSES, EQUIP_FACE_IDS, makeStore } = require("./harness.js");

module.exports = async () => {
  await section("Géométrie & couleurs (pures)", async () => {
  {
    const q = Projection.project3D({ x: 10, y: 20, z: 30 });
    ck.eq(q.h, 10, "project3D : h = X"); ck.eq(q.v, 20, "project3D : v = Y"); ck.eq(q.depth, 30, "project3D : depth = Z");
    const c1 = EquipmentTypes.color("switch"), c2 = EquipmentTypes.color("switch");
    ck(typeof c1 === "string" && c1.length > 0, "equipmentTypeColor → couleur non vide");
    ck.eq(c1, c2, "equipmentTypeColor : déterministe (mémo)");
    ck(COLOR_PALETTE.includes(c1), "equipmentTypeColor : valeur ∈ COLOR_PALETTE");
    // fallback : un id NON reconnu (ancien id FR, type retiré) est RÉSOLU sur `other` (ids anglais + pas de rétro-compat).
    ck.eq(EquipmentTypes.resolveId("serveur"), "other", "resolveId : id inconnu (ancien FR) → other");
    ck.eq(EquipmentTypes.resolveId("switch"), "switch", "resolveId : id connu → inchangé");
    ck.eq(EquipmentTypes.has("server") && !EquipmentTypes.has("serveur"), true, "has : server connu, serveur inconnu");
    ck.eq(EquipmentTypes.color("hors-liste-xyz"), EquipmentTypes.color("other"), "color : type inconnu → couleur du repli other");
    ck.eq(EquipmentTypes.label("serveur"), EquipmentTypes.label("other"), "label : type inconnu → libellé du repli other");
    // `system` = types à pilotage fin (non supprimables à terme) : switch/patch_panel/pdu/switchboard uniquement.
    ck(EquipmentTypes.isSystem("switch") && EquipmentTypes.isSystem("patch_panel") && EquipmentTypes.isSystem("pdu") && EquipmentTypes.isSystem("switchboard"), "isSystem : types à pilotage fin marqués system");
    ck(!EquipmentTypes.isSystem("server") && !EquipmentTypes.isSystem("camera") && !EquipmentTypes.isSystem("other") && !EquipmentTypes.isSystem("inconnu"), "isSystem : inventaire générique / inconnu → non-system");
    ck([0, 90, 180, 270].includes(Normalize.rackOrientation(450)), "normRackOrientation(450) ∈ {0,90,180,270}");
  }
  });

  await section("PivotBounds : coins de salle (rotation), union AABB, pivot borné aux murs virtuels", async () => {
  {
    const rnd = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });
    // rectCorners o=0 : rectangle centré sur (ox,oy) — même transformée que DcThreeScene.roomUnder.
    const c0 = PivotBounds.rectCorners(0, 0, 0, 200, 100).map(rnd);
    ck.eq(JSON.stringify(c0), JSON.stringify([{ x: -100, y: -50 }, { x: 100, y: -50 }, { x: 100, y: 50 }, { x: -100, y: 50 }]), "rectCorners o=0 : coins centrés ±w/2 × ±d/2");
    // rotation 90° (π/2) : largeur ↔ profondeur permutées dans l'AABB.
    const a90 = PivotBounds.unionAabb([PivotBounds.rectCorners(0, 0, Math.PI / 2, 200, 100)]);
    ck.eq(Math.round(a90.minX), -50, "rectCorners o=90 : AABB minX = −d/2");
    ck.eq(Math.round(a90.maxX), 50, "rectCorners o=90 : AABB maxX = +d/2");
    ck.eq(Math.round(a90.minY), -100, "rectCorners o=90 : AABB minY = −w/2");
    ck.eq(Math.round(a90.maxY), 100, "rectCorners o=90 : AABB maxY = +w/2");
    // 180° / 270° : l'AABB retombe sur celle de 0° / 90° (symétrie du rectangle centré).
    const a180 = PivotBounds.unionAabb([PivotBounds.rectCorners(0, 0, Math.PI, 200, 100)]);
    ck.eq(Math.round(a180.minX), -100, "rectCorners o=180 : AABB inchangée vs o=0 (symétrie)");
    const a270 = PivotBounds.unionAabb([PivotBounds.rectCorners(0, 0, 3 * Math.PI / 2, 200, 100)]);
    ck.eq(Math.round(a270.maxY), 100, "rectCorners o=270 : AABB maxY = +w/2 (comme o=90)");
    // unionAabb multi-salles : englobe les deux rectangles.
    const u = PivotBounds.unionAabb([PivotBounds.rectCorners(0, 0, 0, 200, 200), PivotBounds.rectCorners(1000, 500, 0, 200, 200)]);
    ck.eq(JSON.stringify({ minX: Math.round(u.minX), maxX: Math.round(u.maxX), minY: Math.round(u.minY), maxY: Math.round(u.maxY) }), JSON.stringify({ minX: -100, maxX: 1100, minY: -100, maxY: 600 }), "unionAabb : englobe deux salles disjointes");
    ck.eq(PivotBounds.unionAabb([]), null, "unionAabb : aucune salle → null");

    // ---- clampPivot : AABB [0,1000] × [0,1000] ----
    const box = { minX: 0, maxX: 1000, minY: 0, maxY: 1000 };
    // (a) sol DANS l'AABB → renvoyé tel quel (cas normal).
    const g1 = { x: 500, y: 500, z: 0 };
    ck.eq(JSON.stringify(PivotBounds.clampPivot({ x: 0, y: 0, z: 100 }, { x: 1, y: 1, z: -0.1 }, g1, box)), JSON.stringify(g1), "clampPivot : sol dans l'AABB → inchangé");
    // (b) sol HORS + rayon traversant → point de SORTIE (mur le plus LOIN, x=1000).
    const p2 = PivotBounds.clampPivot({ x: -500, y: 500, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2000, y: 500, z: 0 }, box);
    ck.eq(Math.round(p2.x), 1000, "clampPivot : sol hors + traversée → mur LE PLUS LOIN (sortie x=1000)");
    ck.eq(Math.round(p2.y), 500, "clampPivot : point de sortie — y conservé");
    // (c) rayon qui RATE la boîte (parallèle hors slab) → sol ramené au bord (clamp XY).
    const p3 = PivotBounds.clampPivot({ x: -500, y: 5000, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 3000, y: 5000, z: 0 }, box);
    ck.eq(Math.round(p3.x), 1000, "clampPivot : rayon rate → sol clampé au bord X");
    ck.eq(Math.round(p3.y), 1000, "clampPivot : rayon rate → sol clampé au bord Y");
    // (d) sol NULL + traversée → point de sortie.
    const p4 = PivotBounds.clampPivot({ x: -500, y: 500, z: 0 }, { x: 1, y: 0, z: 0 }, null, box);
    ck.eq(Math.round(p4.x), 1000, "clampPivot : sol null + traversée → point de sortie");
    // (e) sol NULL + pas de traversée → null (ne pas bouger le pivot).
    ck.eq(PivotBounds.clampPivot({ x: -500, y: 5000, z: 0 }, { x: 1, y: 0, z: 0 }, null, box), null, "clampPivot : sol null + rayon rate → null");
    // (f) box entièrement DERRIÈRE la caméra (tExit < 0, rayon fuyant) → pas de sortie utilisable → sol clampé au bord.
    const p6 = PivotBounds.clampPivot({ x: 2000, y: 500, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 3000, y: 500, z: 0 }, box);
    ck.eq(Math.round(p6.x), 1000, "clampPivot : box derrière la caméra → sol clampé (aucun exit négatif retenu)");
    // AABB nulle (aucune salle) → sol renvoyé inchangé (comportement historique).
    ck.eq(JSON.stringify(PivotBounds.clampPivot({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, g1, null)), JSON.stringify(g1), "clampPivot : AABB nulle → sol inchangé (pas de bornage)");
  }
  });

  /* ============================================================================================
     PIVOT D'ORBITE EN « VUE ÉTAGE » — la boîte devient une VRAIE boîte 3D, et son enveloppe
     devient celle des BÂTIMENTS. Cf. docs/placement.md §6.21.

     Le bug : `pivotAabb` était l'union des SALLES affichées, en XY seul. En Vue étage, le monde
     regardé est le BÂTIMENT (voire plusieurs sites), et le repli du pivot tombait sur un plan
     z = 0 INFINI que rien ne dessine — d'où un pivot ramené de force dans l'emprise de la salle
     active, et une hauteur de pivot quittant le monde par le haut ou par le bas.

     ⚠ Les valeurs ci-dessous sont dérivées À LA MAIN (méthode du slab), jamais lues dans la
     sortie de l'implémentation. Le contraste boîte 3D ⇄ boîte XY seule est SYSTÉMATIQUE : il
     prouve d'un même geste que le bornage en Z travaille ET que le chemin historique (repère
     SALLE, parois infinies en Z) est conservé au micron.
     ============================================================================================ */
  await section("PivotBounds : BOÎTE 3D (bornage en Z) + bornes monde des bandes de bâtiment", async () => {
  {
    const j = (p) => JSON.stringify(p);
    // MÊME emprise XY, seule la contrainte en Z diffère → tout écart observé vient d'elle.
    const box3 = { minX: 0, maxX: 1000, minY: 0, maxY: 1000, minZ: 0, maxZ: 600 };
    const boxXY = { minX: 0, maxX: 1000, minY: 0, maxY: 1000 };            // bornes en Z ABSENTES = parois infinies
    const boxInf = { minX: 0, maxX: 1000, minY: 0, maxY: 1000, minZ: -Infinity, maxZ: Infinity };   // même chose, écrite explicitement

    // ---- (A) rayon PLONGEANT : sans bornage en Z la sortie passe SOUS le plancher du monde ----
    const oA = { x: -500, y: 500, z: 1000 }, dA = { x: 1, y: 0, z: -1 };
    const a3 = PivotBounds.clampPivot(oA, dA, null, box3);
    ck.eq(a3.x, 500, "boîte 3D : rayon plongeant → sortie par le PLANCHER (x = 500)");
    ck.eq(a3.y, 500, "boîte 3D : y conservé sur la sortie");
    ck.eq(a3.z, 0, "boîte 3D : la sortie est POSÉE sur le plancher du monde (z = 0)");
    const aXY = PivotBounds.clampPivot(oA, dA, null, boxXY);
    ck.eq(aXY.x, 1000, "boîte XY seule : la sortie va jusqu'au mur LOINTAIN (x = 1000)");
    ck.eq(aXY.z, -500, "boîte XY seule : …et le pivot part 500 mm SOUS le monde (le défaut corrigé)");

    // ---- (B) rayon MONTANT : le plafond du monde borne, au lieu de laisser filer vers le ciel ----
    const oB = { x: 500, y: 500, z: 100 }, dB = { x: 0.2, y: 0, z: 1 };
    const b3 = PivotBounds.clampPivot(oB, dB, null, box3);
    ck.eq(b3.x, 600, "boîte 3D : rayon montant → sortie par le PLAFOND (x = 600)");
    ck.eq(b3.z, 600, "boîte 3D : la sortie est plaquée au sommet du monde (z = maxZ)");
    const bXY = PivotBounds.clampPivot(oB, dB, null, boxXY);
    ck.eq(bXY.z, 2600, "boîte XY seule : le pivot montait à 2 600 mm, très au-dessus du monde");

    // ---- (C) rayon VERTICAL : le cas où la boîte XY seule n'a AUCUNE sortie finie ----
    const oC = { x: 500, y: 500, z: 1000 }, dC = { x: 0, y: 0, z: -1 };
    ck.eq(PivotBounds.clampPivot(oC, dC, null, boxXY), null, "boîte XY seule : rayon vertical inscrit dans le slab → aucune sortie (null)");
    ck.eq(j(PivotBounds.clampPivot(oC, dC, null, box3)), j({ x: 500, y: 500, z: 0 }), "boîte 3D : le rayon vertical SORT enfin — par le plancher");

    // ---- (D) « dans la boîte » compte désormais le Z : un sol SOUS le monde n'est plus accepté tel quel ----
    const solBas = { x: 500, y: 500, z: -50 };
    ck.eq(j(PivotBounds.clampPivot(oC, dC, solBas, boxXY)), j(solBas), "boîte XY seule : un sol à z = −50 est « dans la boîte » (Z non borné) → inchangé");
    ck.eq(j(PivotBounds.clampPivot(oC, dC, solBas, box3)), j({ x: 500, y: 500, z: 0 }), "boîte 3D : ce même sol est HORS boîte → ramené dans le monde");

    // ---- (E) rabat au bord sur les TROIS axes (règle 3 : le rayon rate la boîte) ----
    const oE = { x: -500, y: 5000, z: 1000 }, dE = { x: 1, y: 0, z: 0 };   // y = 5 000 : parallèle et hors slab → aucune traversée
    ck.eq(j(PivotBounds.clampPivot(oE, dE, { x: 3000, y: 5000, z: -800 }, box3)), j({ x: 1000, y: 1000, z: 0 }), "boîte 3D : rabat au bord en X, en Y ET en Z (par le bas)");
    ck.eq(j(PivotBounds.clampPivot(oE, dE, { x: 3000, y: 5000, z: 5000 }, box3)), j({ x: 1000, y: 1000, z: 600 }), "boîte 3D : rabat au bord en Z par le HAUT (plafond du monde)");
    ck.eq(j(PivotBounds.clampPivot(oE, dE, { x: 3000, y: 5000, z: -800 }, boxXY)), j({ x: 1000, y: 1000, z: -800 }), "boîte XY seule : le z est TRANSPORTÉ, jamais rabattu (comportement historique)");

    // ---- (F) bornes en Z ABSENTES ≡ bornes INFINIES : l'absence a bien le sens documenté ----
    ck.eq(j(PivotBounds.clampPivot(oA, dA, null, boxXY)), j(PivotBounds.clampPivot(oA, dA, null, boxInf)), "bornes Z absentes ≡ ±Infinity (rayon plongeant)");
    ck.eq(j(PivotBounds.clampPivot(oE, dE, { x: 3000, y: 5000, z: -800 }, boxXY)), j(PivotBounds.clampPivot(oE, dE, { x: 3000, y: 5000, z: -800 }, boxInf)), "bornes Z absentes ≡ ±Infinity (rabat au bord)");
    ck.eq(PivotBounds.clampPivot(oC, dC, null, boxXY), PivotBounds.clampPivot(oC, dC, null, boxInf), "bornes Z absentes ≡ ±Infinity (aucune sortie finie)");

    // ---- (G) worldBounds : union des BANDES de bâtiment (alignées aux axes) × hauteur du monde ----
    const bandes = [
      { loc: "a", x0: 0, x1: 20000, y0: 0, y1: 15000 },
      { loc: "b", x0: 50000, x1: 62000, y0: -3000, y1: 9000 },
    ];
    ck.eq(j(PivotBounds.worldBounds(bandes, 18000)), j({ minX: 0, maxX: 62000, minY: -3000, maxY: 15000, minZ: 0, maxZ: 18000 }), "worldBounds : union des deux bandes + hauteur du monde");
    ck.eq(PivotBounds.worldBounds([], 5000), null, "worldBounds : aucune bande → null (bornage désactivé)");
    ck.eq(j(PivotBounds.worldBounds([{ loc: "z", x0: 100, x1: 50, y0: 10, y1: 0 }], -5)), j({ minX: 50, maxX: 100, minY: 0, maxY: 10, minZ: 0, maxZ: 0 }), "worldBounds : bornes remises dans l'ordre + monde de hauteur nulle jamais INVERSÉ");

    // ---- (H) repère SALLE : `unionAabb` ne borne TOUJOURS que X et Y (mono-salle inchangée) ----
    const salle = PivotBounds.unionAabb([PivotBounds.rectCorners(3000, 2000, 0, 6000, 4000)]);
    ck.eq(j(salle), j({ minX: 0, maxX: 6000, minY: 0, maxY: 4000 }), "unionAabb : boîte de la salle, sans aucune borne en Z");
    ck.eq("minZ" in salle, false, "unionAabb : minZ ABSENT (parois infinies — le repère salle n'a pas de plafond)");
    ck.eq("maxZ" in salle, false, "unionAabb : maxZ ABSENT");

    // ---- (I) le SYMPTÔME de l'utilisateur, sur un même rayon : salle vs bâtiment ----
    // Salle de 6 × 4 m ancrée en (1 000 ; 1 000) dans un bâtiment de 20 × 15 m et 18 m de haut ;
    // caméra à 10 m à l'ouest, à la hauteur du toit, plongeant d'une demi-unité par unité parcourue.
    const salleBox = { minX: 1000, maxX: 7000, minY: 1000, maxY: 5000 };
    const mondeBox = { minX: 0, maxX: 20000, minY: 0, maxY: 15000, minZ: 0, maxZ: 18000 };
    const oI = { x: -10000, y: 3000, z: 18000 }, dI = { x: 1, y: 0, z: -0.5 };
    const solI = { x: 26000, y: 3000, z: 0 };   // le rayon atteint z = 0 à 26 m : DEHORS, d'où le repli borné
    ck.eq(j(PivotBounds.clampPivot(oI, dI, solI, salleBox)), j({ x: 7000, y: 3000, z: 9500 }), "AVANT : le pivot est ramené au mur de la SALLE (x = 7 000)");
    ck.eq(j(PivotBounds.clampPivot(oI, dI, solI, mondeBox)), j({ x: 20000, y: 3000, z: 3000 }), "APRÈS : le pivot atteint le bord du BÂTIMENT (x = 20 000), à une hauteur du monde");
  }
  });

  await section("LeaderLayout : étiquettes déportées (répulsion pure)", async () => {
  {
    ck.eq(JSON.stringify(LeaderLayout.layout([])), "[]", "layout([]) = [] (aucun port)");
    // 1 port : l'étiquette reste dans le cadre et proche de son ancre.
    const one = LeaderLayout.layout([{ x: 0.5, y: 0.5, w: 0.2, h: 0.1 }], { aspect: 5 });
    ck.eq(one.length, 1, "layout : une position par ancre");
    ck(one[0].x >= 0 && one[0].x <= 1 && one[0].y >= 0 && one[0].y <= 1, "layout : étiquette DANS le cadre [0,1]²");
    // 2 ports au même endroit : les RECTANGLES d'étiquette ne doivent PAS se chevaucher (séparation AABB).
    const asp = 4, W = 0.15, H = 0.1;
    const two = LeaderLayout.layout([{ x: 0.5, y: 0.5, w: W, h: H }, { x: 0.5, y: 0.5, w: W, h: H }], { aspect: asp, iterations: 160 });
    const dxpx = Math.abs(two[0].x - two[1].x) * asp, dypx = Math.abs(two[0].y - two[1].y);
    ck(dxpx >= W * asp - 1e-6 || dypx >= H - 1e-6, "layout : les rectangles des 2 étiquettes ne se chevauchent PAS (AABB séparés sur un axe)");
    // aucune étiquette ne recouvre un port : le rect ne contient pas l'ancre (0.5,0.5) en pixels.
    const covers = (L) => Math.abs(L.x - 0.5) * asp < (W * asp) / 2 && Math.abs(L.y - 0.5) < H / 2;
    ck(!covers(two[0]) && !covers(two[1]), "layout : aucune étiquette posée sur le port");
  }
  });

  await section("FaceAlign : guides d'alignement & espacement régulier (pur)", async () => {
  {
    const approx = (a, b, name, eps) => ck(Math.abs(a - b) <= (eps || 1e-9), name + "  (attendu ≈" + b + ", obtenu " + a + ")");
    // rangée de 3 ports alignés en y=0.5 (x = 0.2 / 0.4 / 0.9).
    const row = [{ id: "a", x: 0.2, y: 0.5 }, { id: "b", x: 0.4, y: 0.5 }, { id: "c", x: 0.9, y: 0.5 }];

    // 1) ACCROCHE Y sous tolérance : y calé sur 0.5, ref = le port le plus PROCHE en x du curseur (0.42 → b à 0.4).
    let r = FaceAlign.resolve({ x: 0.42, y: 0.51 }, row, 0.01, 0.05);
    ck(!!r.guideY, "accroche Y : guideY présent (|Δy| < tolY)");
    ck.eq(r.guideY.y, 0.5, "accroche Y : valeur calée = 0.5");
    ck.eq(r.guideY.ref.id, "b", "accroche Y : ref = port le plus proche en x (b)");
    ck.eq(r.y, 0.5, "accroche Y : y résultat calé");
    ck.eq(r.guideX, null, "accroche Y : pas d'alignement X (hors tolX)");

    // 2) PAS d'accroche hors tolérance (ni X ni Y) : position brute conservée.
    r = FaceAlign.resolve({ x: 0.7, y: 0.7 }, row, 0.01, 0.05);
    ck(r.guideY === null && r.guideX === null && r.gapX === null && r.gapY === null, "hors tolérance : aucune accroche");
    approx(r.x, 0.7, "hors tolérance : x brut"); approx(r.y, 0.7, "hors tolérance : y brut");

    // 3) PLUS PROCHE gagne entre deux valeurs Y candidates sous tolérance (0.52 → 0.50 plus proche que 0.55).
    const twoY = [{ id: "p1", x: 0.3, y: 0.50 }, { id: "p2", x: 0.6, y: 0.55 }];
    r = FaceAlign.resolve({ x: 0.85, y: 0.52 }, twoY, 0.01, 0.05);
    ck.eq(r.guideY.y, 0.50, "Y le plus proche : 0.50 retenu (vs 0.55)");
    ck.eq(r.guideY.ref.id, "p1", "Y le plus proche : ref = p1");

    // 4) ACCROCHE X et Y SIMULTANÉES (axes indépendants) sur un même port de coin.
    r = FaceAlign.resolve({ x: 0.305, y: 0.505 }, [{ id: "corner", x: 0.3, y: 0.5 }], 0.02, 0.02);
    ck(!!r.guideX && !!r.guideY, "simultané : guideX ET guideY accrochent");
    ck.eq(r.guideX.x, 0.3, "simultané : x calé 0.3"); ck.eq(r.guideY.y, 0.5, "simultané : y calé 0.5");
    ck.eq(r.x, 0.3, "simultané : x résultat"); ck.eq(r.y, 0.5, "simultané : y résultat");

    // 5a) ESPACEMENT — EXTENSION à droite : paire (0.2,0.4) → nouveau port à 0.6 ; pairs = réf + écart créé.
    r = FaceAlign.resolve({ x: 0.605, y: 0.5 }, [{ id: "a", x: 0.2, y: 0.5 }, { id: "b", x: 0.4, y: 0.5 }], 0.02, 0.02);
    ck.eq(r.guideX, null, "espacement droite : pas d'alignement X exact");
    ck(!!r.gapX, "espacement droite : gapX présent");
    approx(r.gapX.x, 0.6, "espacement droite : x = 0.6 (b + pas)"); approx(r.x, 0.6, "espacement droite : x résultat calé");
    ck.eq(r.gapX.pairs.length, 2, "espacement droite : 2 segments (réf + écart créé)");
    approx(r.gapX.pairs[0].from.x, 0.2, "droite : seg réf de 0.2"); approx(r.gapX.pairs[0].to.x, 0.4, "droite : seg réf à 0.4");
    approx(r.gapX.pairs[1].from.x, 0.4, "droite : seg créé de 0.4"); approx(r.gapX.pairs[1].to.x, 0.6, "droite : seg créé à 0.6");

    // 5b) ESPACEMENT — EXTENSION à gauche : paire (0.4,0.6) → nouveau port à 0.2.
    r = FaceAlign.resolve({ x: 0.205, y: 0.5 }, [{ id: "a", x: 0.4, y: 0.5 }, { id: "b", x: 0.6, y: 0.5 }], 0.02, 0.02);
    approx(r.gapX.x, 0.2, "espacement gauche : x = 0.2 (a − pas)");
    approx(r.gapX.pairs[0].from.x, 0.2, "gauche : seg créé de 0.2"); approx(r.gapX.pairs[0].to.x, 0.4, "gauche : seg créé à 0.4");

    // 5c) ESPACEMENT — MILIEU d'une paire encadrant le curseur : (0.2,0.8) → 0.5, deux demi-écarts égaux.
    r = FaceAlign.resolve({ x: 0.51, y: 0.5 }, [{ id: "a", x: 0.2, y: 0.5 }, { id: "b", x: 0.8, y: 0.5 }], 0.02, 0.02);
    approx(r.gapX.x, 0.5, "milieu : x = 0.5");
    approx(r.gapX.pairs[0].to.x, 0.5, "milieu : 1er segment jusqu'à 0.5"); approx(r.gapX.pairs[1].from.x, 0.5, "milieu : 2e segment depuis 0.5");

    // 5d) PRIORITÉ alignement > espacement : un port exactement à 0.6 → alignement X, espacement inhibé.
    r = FaceAlign.resolve({ x: 0.6, y: 0.5 }, [{ id: "a", x: 0.2, y: 0.5 }, { id: "b", x: 0.4, y: 0.5 }, { id: "c", x: 0.6, y: 0.5 }], 0.02, 0.02);
    ck(!!r.guideX && r.guideX.x === 0.6, "priorité : alignement X exact sur 0.6");
    ck.eq(r.gapX, null, "priorité : espacement X inhibé par l'alignement exact");

    // 6) CLAMP 0..1 en sortie (sans autre port : position brute clampée).
    r = FaceAlign.resolve({ x: 1.5, y: -0.3 }, [], 0.02, 0.02);
    ck.eq(r.x, 1, "clamp : x ramené à 1"); ck.eq(r.y, 0, "clamp : y ramené à 0");

    // 7) TOLÉRANCES par axe DISTINCTES : même écart 0.03 → X (tolX 0.05) accroche, Y (tolY 0.01) non.
    r = FaceAlign.resolve({ x: 0.53, y: 0.53 }, [{ id: "o", x: 0.5, y: 0.5 }], 0.05, 0.01);
    ck(!!r.guideX && r.guideX.x === 0.5, "tolérances distinctes : X accroche (tolX 0.05)");
    ck.eq(r.guideY, null, "tolérances distinctes : Y n'accroche pas (tolY 0.01)");
    ck.eq(r.x, 0.5, "tolérances distinctes : x calé"); approx(r.y, 0.53, "tolérances distinctes : y brut");
  }
  });

  await section("RackLabelLayout : noms de baie sur la coque (flancs + toit, pur)", async () => {
  {
    const w = 600, d = 1000, H = 2000, s = 1;
    const L = RackLabelLayout.forFace("left", w, d, H, s);
    const R = RackLabelLayout.forFace("right", w, d, H, s);
    const T = RackLabelLayout.forFace("roof", w, d, H, s);

    // POSITIONS : centre de face + standoff le long de la normale EXTÉRIEURE (le SIGNE est testé).
    ck.eq(L.position.x, -w / 2 - s, "left : x = −w/2 − standoff (saillie en −X)");
    ck.eq(L.position.y, 0, "left : y = 0 (centré en profondeur)");
    ck.eq(L.position.z, H / 2, "left : z = H/2 (centré en hauteur)");
    ck.eq(R.position.x, w / 2 + s, "right : x = +w/2 + standoff (saillie en +X)");
    ck.eq(R.position.z, H / 2, "right : z = H/2");
    ck.eq(T.position.x, 0, "roof : x = 0 (centré en largeur)");
    ck.eq(T.position.y, 0, "roof : y = 0 (centré en profondeur)");
    ck.eq(T.position.z, H + s, "roof : z = H + standoff (saillie en +Z)");

    // NORMALE EXTÉRIEURE = direction du standoff : position(standoff=1) − centre(standoff=0), par face.
    const center = (f) => RackLabelLayout.forFace(f, w, d, H, 0).position;
    const nrm = (f, p) => ({ x: p.x - center(f).x, y: p.y - center(f).y, z: p.z - center(f).z });
    const nL = nrm("left", L.position), nR = nrm("right", R.position), nT = nrm("roof", T.position);
    ck.eq(JSON.stringify(nL), JSON.stringify({ x: -s, y: 0, z: 0 }), "left : normale extérieure = −X");
    ck.eq(JSON.stringify(nR), JSON.stringify({ x: s, y: 0, z: 0 }), "right : normale extérieure = +X");
    ck.eq(JSON.stringify(nT), JSON.stringify({ x: 0, y: 0, z: s }), "roof : normale extérieure = +Z");
    ck(JSON.stringify(nL) !== JSON.stringify(nR) && JSON.stringify(nR) !== JSON.stringify(nT) && JSON.stringify(nL) !== JSON.stringify(nT), "les 3 faces ont des normales DISTINCTES");

    // TAILLES : bandes de texte centrées, > 0, bornées (h ≤ w = bande basse), flancs bornés par H·0.9.
    ck.eq(L.size.w, d * 0.8, "left : largeur = 0.8·profondeur");
    ck.eq(L.size.h, Math.min(H * 0.9, d * 0.8 * 0.22), "left : hauteur = min(H·0.9, bande)");
    ck.eq(R.size.w, d * 0.8, "right : largeur = 0.8·profondeur");
    ck.eq(T.size.w, w * 0.8, "roof : largeur = 0.8·largeur baie");
    ck.eq(T.size.h, w * 0.8 * 0.22, "roof : hauteur = ratio·largeur");
    [L, R, T].forEach((p, i) => { ck(p.size.w > 0 && p.size.h > 0, "taille strictement positive (face " + i + ")"); ck(p.size.h <= p.size.w, "bande basse : h ≤ w (face " + i + ")"); });
    // baie BASSE (H petit) → hauteur de flanc bornée à H·0.9 (et non la bande, plus grande).
    const low = RackLabelLayout.forFace("left", w, d, 100, s);
    ck.eq(low.size.h, 100 * 0.9, "flanc baie basse : hauteur bornée à H·0.9");

    // ROTATIONS : angle FINI, axes NON NULS et DISTINCTS ; flancs = axes symétriques (lecture non miroir des deux côtés).
    [L, R, T].forEach((p, i) => {
      ck(Number.isFinite(p.angle), "angle fini (face " + i + ")");
      ck(p.axis.x * p.axis.x + p.axis.y * p.axis.y + p.axis.z * p.axis.z > 0, "axe non nul (face " + i + ")");
    });
    ck.eq(L.angle, (2 * Math.PI) / 3, "left : angle 2π/3");
    ck.eq(R.angle, (2 * Math.PI) / 3, "right : angle 2π/3");
    ck.eq(T.angle, 0, "roof : angle 0 → haut du texte vers +Y, nom LISIBLE depuis la face AVANT");
    const ax = (p) => JSON.stringify(p.axis);
    ck(ax(L) !== ax(R) && ax(R) !== ax(T) && ax(L) !== ax(T), "les 3 faces ont des axes de rotation DISTINCTS");
    ck(L.axis.x === R.axis.x && L.axis.y === -R.axis.y && L.axis.z === -R.axis.z, "flancs : axes symétriques (x égal, y/z opposés)");
  }
  });

  await section("RouteGraphLayout : mini-graphe de tracé (pur)", async () => {
  {
    const G = ROUTE_GRAPH;
    /* ⚠ Le nœud porte désormais un CONTENEUR et non un id de salle (doctrine §6.29) : un id ne peut pas
       désigner un ÉTAGE, dont l'identité est le couple (bâtiment, étage). Le constructeur ci-dessous
       garde la même ERGONOMIE (`N("A")` = salle A) pour que les attentes historiques restent lisibles
       telles quelles — ce qu'on migre est la CLÉ, pas ce que le layout produit. */
    const N = (room, extra = {}) => Object.assign({ container: room ? { kind: "room", id: room } : null, roomLabel: room || "", z: null }, extra);
    const NF = (loc, fl, extra = {}) => Object.assign({ container: { kind: "floor", location: loc, floor: fl }, roomLabel: loc + " · ét. " + fl, z: null }, extra);
    // trajet type : patch A → chemin bas → exit A → pin d'étage → exit B → chemin haut → patch B
    const nodes = [
      N("A", { endpoint: true }), N("A", { z: -80 }), N("A", { z: -80 }),
      N(null, { z: -80 }),
      N("B", { z: -80 }), N("B", { z: 2600 }), N("B", { endpoint: true }),
    ];
    const ch = RouteGraphLayout.chain(nodes);
    ck.eq(ch.xs.length, 7, "chain : une abscisse par nœud");
    ck(ch.xs.every((x, i) => i === 0 || x > ch.xs[i - 1]), "chain : abscisses strictement croissantes");
    ck.eq(ch.xs[1] - ch.xs[0], G.GAP_EP, "chain : écart extrémité→waypoint = GAP_EP");
    ck.eq(ch.xs[2] - ch.xs[1], G.GAP_WP, "chain : écart waypoint→waypoint (même salle) = GAP_WP");
    ck.eq(ch.xs[3] - ch.xs[2], G.GAP_WP + G.GAP_ROOM, "chain : changement de salle → respiration GAP_ROOM");
    ck.eq(ch.width, ch.xs[6] + G.PAD_X, "chain : largeur = dernier centre + marge");
    ck.eq(ch.bands.length, 2, "chain : 2 bandes de salles (le pin d'étage coupe)");
    ck.eq(ch.bands[0].from + "-" + ch.bands[0].to, "0-2", "chain : bande A = nœuds 0..2");
    ck.eq(ch.bands[1].from + "-" + ch.bands[1].to, "4-6", "chain : bande B = nœuds 4..6");
    ck(ch.bands[0].x0 < ch.xs[0] - G.EP_W / 2 && ch.bands[0].x1 > ch.xs[2] + G.WP_R, "chain : la bande déborde de ses nœuds extrêmes");
    // deux passages dans la même salle (A, étage, A) → deux bandes DISTINCTES (pas de fusion à travers un tronçon)
    const back = [N("A", { z: 0 }), N(null, { z: 100 }), N("A", { z: 0 })];
    ck.eq(RouteGraphLayout.chain(back).bands.length, 2, "chain : pas de fusion de bandes à travers un tronçon");

    const pr = RouteGraphLayout.profile(nodes);
    ck.eq(JSON.stringify(pr.xs), JSON.stringify(ch.xs), "profil : mêmes abscisses que la chaîne (bascule sans saut)");
    ck.eq(pr.floors.length, 1, "profil : un seul étage (aucun level fourni) → une seule dalle");
    ck.eq(pr.multiFloor, false, "profil : multiFloor faux sur un seul étage");
    ck(pr.ys[5] < pr.ys[4], "profil : z plus haut → ordonnée plus petite (2600 au-dessus de −80)");
    ck(pr.ys[1] > pr.floors[0].y, "profil : z négatif SOUS la dalle");
    ck.eq(pr.floors[0].hasUnderfloor, true, "profil : faux-plancher détecté (z < 0)");
    ck(pr.snapped[0] === true && pr.snapped[6] === true, "profil : z d'extrémité inconnue → héritée (amorce)");
    ck.eq(pr.ys[0], pr.ys[1], "profil : l'extrémité hérite l'ordonnée du waypoint voisin");
    ck(pr.ys.every((y) => y >= G.PROF_TOP - 1e-9 && y <= pr.height - G.PROF_BOT + 1e-9), "profil : ordonnées dans les marges");
    ck.eq(pr.separators.length, 2, "profil : un séparateur par changement de salle");
    // amplitude minimale garantie : tracé plat à z = 0 → la dalle n'est collée à aucun bord
    const flat = RouteGraphLayout.profile([N("A", { z: 0 }), N("A", { z: 0 })]);
    ck(flat.floors[0].y > G.PROF_TOP && flat.floors[0].y < G.PROF_H - G.PROF_BOT, "profil : dalle lisible même sur tracé plat");
    // dégénéré : deux extrémités sans aucun z (intra-salle) → pas de crash, valeurs finies
    const two = RouteGraphLayout.profile([N("A", { endpoint: true }), N("A", { endpoint: true })]);
    ck(two.ys.every((y) => isFinite(y)), "profil : tracé sans waypoint → ordonnées finies (repli sûr)");

    // MULTI-ÉTAGE : salle A à l'ét. 0 → pin d'étage à l'ét. 1 → salle B à l'ét. 1
    // (dc_z est RELATIF à la dalle de chaque étage → un référentiel empilé par étage)
    const mf = [
      N("A", { endpoint: true, level: 0 }), N("A", { z: -80, level: 0 }), N("A", { z: 0, level: 0 }),
      N(null, { z: 300, level: 1 }),
      N("B", { z: 0, level: 1 }), N("B", { endpoint: true }),   // extrémité B sans étage → hérité (1)
    ];
    const pf = RouteGraphLayout.profile(mf);
    ck.eq(pf.floors.length, 2, "profil multi-étage : une dalle par étage traversé");
    ck.eq(pf.multiFloor, true, "profil multi-étage : multiFloor vrai");
    ck.eq(pf.floors[0].level + "→" + pf.floors[1].level, "0→1", "profil multi-étage : niveaux croissants");
    ck(pf.floors[1].y < pf.floors[0].y, "profil multi-étage : la dalle de l'ét. 1 AU-DESSUS de celle de l'ét. 0");
    ck(pf.height > G.PROF_H, "profil multi-étage : hauteur étendue avec le nombre d'étages");
    ck.eq(pf.ys[2], pf.floors[0].y, "profil multi-étage : z=0 à l'ét. 0 posé sur SA dalle");
    ck.eq(pf.ys[4], pf.floors[1].y, "profil multi-étage : z=0 à l'ét. 1 posé sur SA dalle");
    const kA = (pf.ys[1] - pf.ys[2]) / 80, kB = (pf.ys[4] - pf.ys[3]) / 300;
    ck(Math.abs(kA - kB) < 1e-9, "profil multi-étage : échelle z COMMUNE à tous les étages");
    ck(pf.floors[1].x1 >= pf.xs[5] + G.EP_W / 2, "profil multi-étage : l'extrémité à étage hérité compte dans l'emprise de SON étage");
    ck(pf.floors[0].x1 < pf.floors[1].x0, "profil multi-étage : emprises d'étages disjointes (dalles séparées à l'écran)");

    /* ---- CLÉ DE REGROUPEMENT GÉNÉRALISÉE : salle OU ÉTAGE (doctrine §6.29) ----
       Le layout ne compare plus deux ids mais deux CONTENEURS (`PlacementContainers.same`). Trois
       propriétés à prouver : (a) un conteneur ÉTAGE se groupe comme une salle ; (b) deux étages du
       MÊME numéro dans des bâtiments DIFFÉRENTS ne se confondent pas — un id n'aurait pas pu les
       distinguer, c'est la raison d'être du couple ; (c) le cas `null`/`null` conserve le comportement
       historique (aucune transition entre deux nœuds sans conteneur). */
    const surEtage = [NF("liege", "1", { endpoint: true }), NF("liege", "1", { z: 0 }), NF("liege", "1", { endpoint: true })];
    const chE = RouteGraphLayout.chain(surEtage);
    ck.eq(chE.bands.length, 1, "conteneur ÉTAGE : une bande, comme une salle (le layout ne connaît plus la nature)");
    ck.eq(chE.bands[0].from + "-" + chE.bands[0].to, "0-2", "conteneur ÉTAGE : la bande couvre les 3 nœuds du même étage");
    ck.eq(chE.bands[0].label, "liege · ét. 1", "conteneur ÉTAGE : la bande porte le libellé résolu par l'appelant");
    ck.eq(chE.xs[1] - chE.xs[0], G.GAP_EP, "conteneur ÉTAGE : aucune respiration DANS le même étage");

    const deuxBatiments = [NF("liege", "1", { endpoint: true }), NF("namur", "1", { endpoint: true })];
    const chB = RouteGraphLayout.chain(deuxBatiments);
    ck.eq(chB.bands.length, 2, "MÊME numéro d'étage, bâtiments DIFFÉRENTS → deux bandes (l'identité est le COUPLE)");
    ck.eq(chB.xs[1] - chB.xs[0], G.GAP_EP + G.GAP_ROOM, "MÊME numéro d'étage, bâtiments différents → respiration de changement");
    const memeEtage = RouteGraphLayout.chain([NF("liege", "1", { endpoint: true }), NF("liege", "1", { endpoint: true })]);
    ck.eq(memeEtage.xs[1] - memeEtage.xs[0], G.GAP_EP, "DISCRIMINATION : le même couple ne déclenche PAS de respiration");
    const etageDifferent = RouteGraphLayout.chain([NF("liege", "1", { endpoint: true }), NF("liege", "2", { endpoint: true })]);
    ck.eq(etageDifferent.xs[1] - etageDifferent.xs[0], G.GAP_EP + G.GAP_ROOM, "MÊME bâtiment, étages différents → respiration de changement");

    /* (c) LE PIÈGE : `PlacementContainers.same(null, null)` rend `false`. Une bascule naïve aurait
       inséré ici une respiration et un séparateur là où le code historique (`null !== null` → faux)
       n'en mettait aucun — sur des documents EXISTANTS (deux waypoints non posés à la suite). */
    ck.eq(RouteGraphLayout.sameContainer(null, null), true, "sameContainer(null, null) = VRAI — deux nœuds hors conteneur ne font pas une TRANSITION");
    ck.eq(RouteGraphLayout.sameContainer(null, { kind: "room", id: "A" }), false, "sameContainer : absence vs salle → transition");
    ck.eq(RouteGraphLayout.sameContainer({ kind: "room", id: "A" }, { kind: "room", id: "A" }), true, "sameContainer : même salle → aucune transition");
    const horsConteneur = [N("A", { endpoint: true }), N(null, { z: 0 }), N(null, { z: 0 }), N("A", { endpoint: true })];
    const chN = RouteGraphLayout.chain(horsConteneur);
    ck.eq(chN.xs[2] - chN.xs[1], G.GAP_WP, "deux nœuds SANS conteneur à la suite : écart NU, aucune respiration (parité historique)");
    ck.eq(RouteGraphLayout.profile(horsConteneur).separators.length, 2, "deux nœuds SANS conteneur : 2 séparateurs (entrée/sortie), pas 3");
    ck.eq(chN.bands.length, 2, "deux nœuds SANS conteneur : la bande est coupée, et pas fusionnée au retour");
  }
  });

  await section("RouteMiniGraph.countLabel : compter des CONTENEURS distincts, et les nommer juste (§6.29)", async () => {
  {
    /* LE seul vrai site d'ÉGALITÉ du chantier « câblage des équipements d'étage ». Il comptait
       `new Set(nodes.map(n => n.roomId))` : un `Set` d'ids ne peut PAS représenter un étage, dont
       l'identité est le couple (bâtiment, étage). D'où `PlacementContainers.same`, appliqué deux à deux. */
    const R = (id) => ({ container: { kind: "room", id } });
    const F = (loc, fl) => ({ container: { kind: "floor", location: loc, floor: fl } });
    const RIEN = { container: null };

    // --- PARITÉ : tant que la route ne traverse que des SALLES, le message historique est INCHANGÉ,
    //     au caractère près (attente écrite EN DUR, pas dérivée du code).
    ck.eq(RouteMiniGraph.countLabel([R("a"), R("a"), R("b")], 3), "3 étape(s) · 2 salle(s)", "deux salles distinctes → message HISTORIQUE, mot « salle(s) »");
    ck.eq(RouteMiniGraph.countLabel([R("a"), R("a"), R("a")], 1), "1 étape(s) · 1 salle(s)", "une seule salle, répétée → comptée UNE fois");
    ck.eq(RouteMiniGraph.countLabel([RIEN, RIEN], 2), "2 étape(s) · 0 salle(s)", "aucun conteneur → 0, et le mot « salle(s) » (rien ne dit qu'un étage est en jeu)");
    ck.eq(RouteMiniGraph.countLabel([R("a"), RIEN, R("a")], 2), "2 étape(s) · 1 salle(s)", "un tronçon hors conteneur ne crée PAS une salle de plus");

    // --- LE MOT JUSTE (décision D4) : dès qu'un ÉTAGE est traversé, « salle(s) » serait FAUX.
    ck.eq(RouteMiniGraph.countLabel([R("a"), F("liege", "1")], 2), "2 étape(s) · 2 emplacement(s)", "salle + étage → le mot bascule sur « emplacement(s) »");
    ck.eq(RouteMiniGraph.countLabel([F("liege", "1"), F("liege", "1")], 0), "0 étape(s) · 1 emplacement(s)", "deux fois le MÊME étage → compté une fois");

    // --- CE QU'UN `Set` D'IDS N'AURAIT PAS PU FAIRE : distinguer deux étages de même NUMÉRO dans des
    //     bâtiments différents, et confondre deux étages différents d'un même bâtiment.
    ck.eq(RouteMiniGraph.countLabel([F("liege", "1"), F("namur", "1")], 2), "2 étape(s) · 2 emplacement(s)", "même numéro d'étage, bâtiments DIFFÉRENTS → DEUX emplacements");
    ck.eq(RouteMiniGraph.countLabel([F("liege", "1"), F("liege", "2")], 2), "2 étape(s) · 2 emplacement(s)", "même bâtiment, étages DIFFÉRENTS → deux emplacements");
    // Le rez-de-chaussée n'est pas l'absence d'étage : « 0 » et « » sont DEUX clés distinctes ici (la
    // normalisation d'affichage les rapproche, la clé de placement ne les confond pas).
    ck.eq(RouteMiniGraph.countLabel([F("liege", "0"), F("liege", "0")], 1), "1 étape(s) · 1 emplacement(s)", "rez-de-chaussée : « 0 » est une clé comme une autre, pas un vide");
  }
  });

  await section("RackGeometry (pure)", async () => {
  {
    // LARGEUR RÉELLE d'un boîtier U (u_width_mm) + alignement (u_align, vu de face : left = −X).
    const BODY = RACK_MOUNT_WIDTH - 30;   // corps utile = panneau − 2 oreilles (15 mm)
    ck.eq(RackGeometry.mountBodyWidth(), BODY, "mountBodyWidth = panneau 19″ − 2 oreilles");
    ck.eq(RackGeometry.eqBodyWidth({}), BODY, "eqBodyWidth défaut = pleine largeur du corps");
    ck.eq(RackGeometry.eqBodyWidth({ u_width_mm: 200 }), 200, "eqBodyWidth = u_width_mm si renseignée");
    ck.eq(RackGeometry.eqBodyWidth({ u_width_mm: 9999 }), BODY, "eqBodyWidth bornée au corps utile");
    ck.eq(RackGeometry.eqBodyOffsetX({ u_width_mm: 200, u_align: "left" }), -(BODY - 200) / 2, "offset gauche = −(full−w)/2");
    ck.eq(RackGeometry.eqBodyOffsetX({ u_width_mm: 200, u_align: "right" }), (BODY - 200) / 2, "offset droite = +(full−w)/2");
    ck.eq(RackGeometry.eqBodyOffsetX({ u_width_mm: 200 }), 0, "offset centré (défaut) = 0");
    ck.eq(RackGeometry.eqBodyOffsetX({}), 0, "pleine largeur → offset 0 (u_align ignoré)");
    ck.eq(RackGeometry.sideMarginMm({ width_mm: 800 }), (800 - RACK_MOUNT_WIDTH) / 2, "sideMarginMm(800)");
    ck.eq(RackGeometry.sideColumns({ width_mm: 800 }), 2, "sideColumns(800) = 2");
    ck.eq(RackGeometry.sideColumns({ width_mm: 600 }), 1, "sideColumns(600) = 1");
    ck(RackGeometry.sideEnabled({ width_mm: 800, allow_side_front: true }, "front") === true, "sideEnabled front (marge≥1U + flag)");
    ck(RackGeometry.sideEnabled({ width_mm: 800, allow_side_front: true }, "rear") === false, "sideEnabled rear faux sans flag");
    ck(RackGeometry.sideEnabled({ width_mm: 500, allow_side_front: true }, "front") === false, "sideEnabled faux si marge < 1U");
    const r0 = RackGeometry.halfExtents({ width_mm: 600, depth: 1000, orientation: 0 });
    const r90 = RackGeometry.halfExtents({ width_mm: 600, depth: 1000, orientation: 90 });
    ck(r0.hx === 300 && r0.hy === 500, "halfExtents 0° = {300,500}");
    ck(r90.hx === 500 && r90.hy === 300, "halfExtents 90° permute hx/hy");
    void U_MM;
  }
  });

  await section("Box.faces / Painter.farFirst (pures)", async () => {
  {
    const C = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ h: i, v: i, depth: i < 4 ? 100 : 0, id: i }));
    const ids = (f) => f.pts.map((p) => p.id);
    let faces = Box.faces(C);
    ck.eq(faces.length, 6, "box : 6 faces");
    ck.eq(faces[0].cd, 100, "box : 1re face (loin) cd=100");
    ck.eq(faces[5].cd, 0, "box : dernière face (proche) cd=0");
    ck.eq(JSON.stringify(ids(faces[0])), JSON.stringify([0, 1, 2, 3]), "box : dessous = [0,1,2,3]");
    const front = faces.find((f) => JSON.stringify(ids(f)) === JSON.stringify([0, 1, 5, 4]));
    ck.eq(front.cd, 50, "box : centroïde avant = 50");
    faces = Box.faces(C, [{ o: 0.55 }, { o: 1 }, { o: 0.92, plane: "y0" }, { o: 0.78 }, { o: 0.72 }, { o: 0.72 }]);
    ck.eq(faces[0].o, 0.55, "box meta : face dessous o=0.55");
    const fm = faces.find((f) => JSON.stringify(ids(f)) === JSON.stringify([0, 1, 5, 4]));
    ck.eq(fm.plane, "y0", "box meta : face avant plane=y0");

    const box = (x0, y0, z0, x1, y1, z1) => ({ lo: [x0, y0, z0], hi: [x1, y1, z1] });
    const A = box(0, 0, 0, 1, 1, 1), B = box(2, 0, 0, 3, 1, 1);
    ck(Painter.farFirst(A, B, [1, 0, 0]) > 0, "painter : sépar X, grad.x>0 → B avant A");
    ck(Painter.farFirst(A, B, [-1, 0, 0]) < 0, "painter : grad.x<0 → A avant B");
    const A2 = box(0, 0, 0, 1, 1, 1), B2 = box(2, 0, 2, 3, 1, 3);
    ck(Painter.farFirst(A2, B2, [1, 0, 5]) > 0, "painter : axe dominant Z → B avant A");
    const O1 = box(0, 0, 0, 2, 2, 2), O2 = box(1, 1, 1, 3, 3, 3);
    ck(Painter.farFirst(O1, O2, [1, 0, 0]) > 0, "painter : chevauchement → centroïde (O2 plus loin)");
    ck.eq(Painter.farFirst(O1, O1, [1, 0, 0]), 0, "painter : même boîte → 0");
    ck.eq(Painter.farFirst(O1, O2, [0, 0, 0]), 0, "painter : grad nul → 0");
  }
  });

  await section("GraphGeometry (pure)", async () => {
  {
    ck.eq(GraphGeometry.nodeSize({ name: "ab", type: "" }).h, 40, "nodeSize : hauteur fixe 40");
    ck.eq(GraphGeometry.nodeSize({ name: "ab", type: "" }).w, 120, "nodeSize : nom court → plancher 120");
    const long = "x".repeat(30);
    ck.eq(GraphGeometry.nodeSize({ name: long, type: "" }).w, Math.max(120, 30 * 7 + 48), "nodeSize : nom(30) → 30*7+48");
    const w10 = GraphGeometry.nodeSize({ name: "y".repeat(10), type: "" }).w;
    const w40 = GraphGeometry.nodeSize({ name: "y".repeat(40), type: "" }).w;
    ck(w40 >= w10 && w40 > 120, "nodeSize : croît avec le nom");
    const bb = GraphGeometry.nodesBBox([{ x: 0, y: 0, _w: 40 }, { x: 100, y: 50, _w: 20 }], () => 10);
    ck.eq(bb.minX, -20, "bbox minX = -20"); ck.eq(bb.maxX, 110, "bbox maxX = 110");
    ck.eq(bb.minY, -10, "bbox minY = -10"); ck.eq(bb.maxY, 60, "bbox maxY = 60");
  }
  });

  await section("RackScene : occupation des U (rackOccupants)", async () => {
  {
    const s = await makeStore();
    const rs = new RackScene(s);
    const rack = await s.create("racks", { name: "R", u_count: 42, sides: "single" });
    await s.create("equipments", { name: "sw", placement_mode: "rack", rack_id: rack.id, rack_u: 10, u_height: 2 });
    const occ = rs.occupants(rack.id);
    ck(occ.has("10:front") && occ.has("11:front"), "occupants : U10–U11 front occupés");
    ck(!occ.has("12:front"), "occupants : U12 libre");
    ck.eq(rs.occupancyCount(rack.id), 1, "occupancyCount = 1");
    ck.eq(rs.freeUInfo(rack.id).free, 40, "freeUInfo : 40 U libres sur 42");
    // occupantsElev (rendu 3D) : un occupant équipement, U10 hauteur 2, face avant.
    const el = rs.occupantsElev(rack.id);
    ck.eq(el.length, 1, "occupantsElev : 1 occupant");
    ck(el[0].kind === "eq" && el[0].u === 10 && el[0].h === 2 && el[0].side === "front", "occupantsElev : eq U10 h2 front");
  }
  });

  await section("RackResize : évacuation d'une cage redimensionnée (pur) + garde de rendu", async () => {
  {
    const { RackResize } = D("geometry/RackResize.js");
    // fits : les U sont numérotés à partir de 1, l'occupant couvre u … u+h−1.
    ck(RackResize.fits(1, 1, 42), "fits : U1 h1 dans 42 U");
    ck(RackResize.fits(42, 1, 42), "fits : U42 h1 tient PILE dans 42 U");
    ck(RackResize.fits(1, 42, 42), "fits : U1 h42 remplit exactement la cage");
    ck(!RackResize.fits(42, 2, 42), "fits : U42 h2 DÉPASSE (dernier U = 43)");
    ck(!RackResize.fits(43, 1, 42), "fits : U43 hors cage");
    ck(!RackResize.fits(0, 1, 42), "fits : U0 non conforme (numérotation à partir de 1)");
    ck(!RackResize.fits(-3, 1, 42), "fits : U négatif non conforme");
    ck(RackResize.fits(5, 0, 42), "fits : hauteur absente → traitée comme 1 U");

    // fallout : SÉPARE les deux familles, car leur traitement diffère (équipement dépublié vs item supprimé).
    const spans = [
      { id: "eqIn", u: 5, h: 2, kind: "eq" },      // tient dans 20 U
      { id: "eqOut", u: 30, h: 1, kind: "eq" },    // dépasse
      { id: "itIn", u: 1, h: 1, kind: "item" },    // tient
      { id: "itOut", u: 19, h: 3, kind: "item" },  // 19..21 → dépasse
    ];
    const fo = RackResize.fallout(spans, 20);
    ck.eq(JSON.stringify(fo.equipmentIds), JSON.stringify(["eqOut"]), "fallout : seul l'équipement hors cage est évacué");
    ck.eq(JSON.stringify(fo.itemIds), JSON.stringify(["itOut"]), "fallout : seul le pseudo-occupant hors cage est évacué");
    // AGRANDISSEMENT : rien ne dépasse → rien n'est touché (le bug historique déplaçait TOUT à chaque changement).
    const up = RackResize.fallout(spans, 48);
    ck(!up.equipmentIds.length && !up.itemIds.length, "fallout : agrandir la cage n'évacue RIEN");

    // uSpans (BRUT, voit ce qui dépasse) vs occupantsElev (garde de cage, ne dessine pas le hors-bornes).
    const s = await makeStore();
    const rs = new RackScene(s);
    const rack = await s.create("racks", { name: "R", u_count: 42, sides: "single" });
    await s.create("equipments", { name: "sw", placement_mode: "rack", rack_id: rack.id, rack_u: 10, u_height: 2 });
    await s.create("rackItems", { rack_id: rack.id, kind: "blank", side: "front", u: 40, u_height: 2 });
    ck.eq(rs.uSpans(rack.id).length, 2, "uSpans : équipement + pseudo-occupant");
    ck.eq(rs.occupantsElev(rack.id).length, 2, "occupantsElev : les 2 occupants tiennent dans 42 U");
    // Document CORROMPU : la baie rétrécit sans passer par le formulaire (comme d'anciens redimensionnements).
    await s.update("racks", rack.id, { u_count: 20 });
    const raw = rs.uSpans(rack.id);
    ck.eq(raw.length, 2, "uSpans : voit TOUJOURS l'occupant hors cage (c'est son rôle)");
    const drawn = rs.occupantsElev(rack.id);
    ck.eq(drawn.length, 1, "occupantsElev : le pseudo-occupant hors cage n'est PLUS dessiné");
    ck(drawn[0].kind === "eq" && drawn[0].u === 10, "occupantsElev : l'occupant qui tient est conservé");
    const foDb = RackResize.fallout(raw, 20);
    ck.eq(JSON.stringify(foDb.itemIds.length), "1", "fallout sur données réelles : 1 pseudo-occupant à supprimer");
    ck(!foDb.equipmentIds.length, "fallout sur données réelles : l'équipement U10 h2 tient dans 20 U");
  }
  });

  await section("RackScene + RackGeometry : side-mount", async () => {
  {
    const s = await makeStore();
    const rs = new RackScene(s);
    const dc = await s.create("datacenters", { name: "DC" });
    const rack = await s.create("racks", { name: "R", width_mm: 800, depth: 1000, u_count: 42, allow_side_front: true, datacenter_id: dc.id, dc_x: 1000, dc_y: 1000 });
    const eq = await s.create("equipments", { name: "PDU", placement_mode: "side", dim_mode: "free", rack_id: rack.id, side_face: "front", side_lr: "left", side_col: 0, side_u: 5, free_w_mm: 60, free_h_mm: 150, free_l_mm: 300 });
    ck.eq(rs.sideOccupants(rack.id, "front", "left").length, 1, "sideOccupants(front,left) = 1");
    ck.eq(rs.sideOccupants(rack.id, "rear", null).length, 0, "sideOccupants(rear) = 0");
    const box = RackGeometry.sideEquipBoxLocal(rack, eq), h = box.heightU;
    ck(rs.sideSlotFree(rack.id, "front", "left", 0, 5, h, null) === false, "sideSlotFree : bande occupée = false");
    ck(rs.sideSlotFree(rack.id, "front", "left", 0, 35, 2, null) === true, "sideSlotFree : bande libre = true");
    ck(rs.sideSlotFree(rack.id, "front", "left", 0, 5, h, eq.id) === true, "sideSlotFree : exceptId ignore l'occupant");
    const free = rs.sideFreeSlots(rack);
    ck(free.length > 0 && free.every((sl) => !(sl.face === "front" && sl.lr === "left" && sl.col === 0 && sl.uTop === 5)), "sideFreeSlots exclut la bande occupée");
    ck(box.x0 < 0 && box.x1 <= 0, "sideEquipBoxLocal : gauche → x ≤ 0");
    ck(box.front === true && box.z1 > box.z0, "sideEquipBoxLocal : front + hauteur cohérente");
    const slotBox = RackGeometry.sideSlotBoxLocal(rack, "front", "left", 0, 5, 2);
    ck(slotBox.x0 < 0 && slotBox.front === true, "sideSlotBoxLocal : gauche/front cohérent");
  }
  });

  await section("RackScene + RackGeometry : wall-mount", async () => {
  {
    const s = await makeStore();
    const rs = new RackScene(s);
    const dc = await s.create("datacenters", { name: "DC" });
    // `allow_side_front` REQUIS depuis l'unification latéral/paroi : le toggle side-mount gouverne AUSSI les parois.
    const rack = await s.create("racks", { name: "R", width_mm: 600, depth: 1200, u_count: 42, front_margin_mm: 200, cage_depth_mm: 700, allow_side_front: true, datacenter_id: dc.id, dc_x: 2000, dc_y: 2000 });
    ck(RackGeometry.wallEnabled(rack, "front") === true, "wallEnabled(front) avec marge ≥ 1U ET side-mount avant autorisé");
    // UNIFICATION latéral/paroi : les emplacements en paroi sont gouvernés par le MÊME toggle que la marge.
    ck(RackGeometry.wallEnabled(rack, "rear") === false, "wallEnabled(rear) faux SANS allow_side_rear (unifié avec le side-mount)");
    ck(RackGeometry.wallEnabled({ ...rack, allow_side_front: false }, "front") === false, "wallEnabled(front) faux sans allow_side_front");
    const eq = await s.create("equipments", { name: "WALL", placement_mode: "wall", dim_mode: "free", rack_id: rack.id, wall_lr: "left", wall_margin: "front", wall_col: 0, wall_u: 5, wall_orient: "center", free_w_mm: 80, free_h_mm: 150, free_l_mm: 100 });
    ck.eq(rs.wallOccupants(rack.id, "front", "left").length, 1, "wallOccupants(front,left) = 1");
    ck(rs.wallSlotFree(rack.id, "left", "front", 0, 5, 2, null) === false, "wallSlotFree : bande occupée = false");
    ck(rs.wallSlotFree(rack.id, "left", "front", 0, 35, 2, null) === true, "wallSlotFree : bande libre = true");
    ck(rs.wallFreeSlots(rack).length > 0, "wallFreeSlots non vide");
    const wbox = RackGeometry.wallEquipBoxLocal(rack, eq);
    ck(wbox.n && (wbox.n.x !== 0 || wbox.n.y !== 0), "wallEquipBoxLocal : normale définie");
    ck(wbox.z1 > wbox.z0, "wallEquipBoxLocal : hauteur cohérente");
  }
  });

  await section("Resolver3D : resolvePort3D (rack / side / wall / libre)", async () => {
  {
    const s = await makeStore();
    const r3 = new Resolver3D(s);
    const dc = await s.create("datacenters", { name: "DC" });
    // rack
    const rack = await s.create("racks", { name: "R", width_mm: 600, depth: 1000, u_count: 42, datacenter_id: dc.id, dc_x: 500, dc_y: 500 });
    const eq = await s.create("equipments", { name: "SW", placement_mode: "rack", rack_id: rack.id, rack_u: 10 });
    const p = await s.create("ports", { equipment_id: eq.id, name: "p", face_x: 0.3, face_y: 0.4, face_side: "front" });
    const pr = r3.resolvePort3D(p.id, dc.id);
    ck(pr && isFinite(pr.x) && isFinite(pr.y) && isFinite(pr.z), "resolvePort3D(rack) → point fini");
    ck.eq(r3.resolvePort3D(p.id, "autre-dc"), null, "resolvePort3D : dc ≠ rack.datacenter_id → null");
    // FAÇADE DEVANT LA CAGE : le port avant est à STANDOFF (3 mm) devant le plan des montants (orientation 0
    // → façade en −Y : y = dc_y − depth/2 − 3) ; un DÉBORD (face_offset_mm) l'avance d'autant en plus.
    ck(pr && Math.abs(pr.y - (500 - 500 - 3)) < 1e-6, "port avant = plan de montage − réserve d'oreilles (3 mm)");
    await s.update("equipments", eq.id, { face_offset_mm: 50 });
    const pr2 = r3.resolvePort3D(p.id, dc.id);
    ck(pr2 && Math.abs(pr2.y - (pr.y - 50)) < 1e-6, "débord de façade 50 mm → port avancé de 50 mm");
    await s.update("equipments", eq.id, { face_offset_mm: 0 });
    // LARGEUR RÉELLE (boîtier rétréci) + alignement : face_x couvre la largeur du boîtier, au décalage
    // physique de son alignement (vu de face, left = −X à orientation 0).
    await s.update("equipments", eq.id, { u_width_mm: 200, u_align: "left" });
    const prN = r3.resolvePort3D(p.id, dc.id);
    const xcN = -(482.6 - 30 - 200) / 2;
    ck(prN && Math.abs(prN.x - (500 + xcN + (0.3 - 0.5) * 200)) < 1e-6, "boîtier rétréci 200 mm aligné à gauche : port sur la largeur réelle, décalé");
    await s.update("equipments", eq.id, { u_width_mm: null, u_align: "center" });
    const prBack = r3.resolvePort3D(p.id, dc.id);
    ck(prBack && Math.abs(prBack.x - pr.x) < 1e-6, "largeur vidée → retour pleine largeur (comportement historique)");
    // libre
    const fe = await s.create("equipments", { name: "free", dim_mode: "free", dc_id: dc.id, dc_x: 800, dc_y: 800, free_w_mm: 200, free_h_mm: 100, free_l_mm: 200 });
    const fp = await s.create("ports", { equipment_id: fe.id, name: "fp", face_x: 0.5, face_y: 0.5 });
    const fr = r3.resolvePort3D(fp.id, dc.id);
    ck(fr && isFinite(fr.x) && isFinite(fr.z), "resolvePort3D(libre) → point fini");
    ck(fr && fr.n && (Math.abs(fr.n.x) + Math.abs(fr.n.y) + Math.abs(fr.n.z)) > 0, "resolvePort3D(libre) → normale non nulle");
    // CONTENEUR SANS SALLE (équipement posé sur un ÉTAGE — cf. docs/placement.md §1 symptôme 3). `resolvePort3D`
    // ne sait pas le résoudre : `resolvePortWorld3D` compose depuis l'ORIGINE MONDE du conteneur. ÉQUIVALENCE —
    // le même équipement doit retomber au MÊME point que posé en salle, simplement DÉCALÉ de cette origine.
    // C'est la meilleure preuve que la chaîne est correcte : les deux chemins partagent le point LOCAL et la
    // normale, seule la provenance de l'origine change.
    const atO = r3.resolvePortWorld3D(fp.id, 800, 800, 0);
    ck(atO && Math.abs(atO.x - fr.x) < 1e-6 && Math.abs(atO.y - fr.y) < 1e-6 && Math.abs(atO.z - fr.z) < 1e-6,
      "resolvePortWorld3D : origine (800,800,0) ≡ même équipement posé en salle en (800,800)");
    ck(atO && Math.abs(atO.n.x - fr.n.x) < 1e-12 && Math.abs(atO.n.y - fr.n.y) < 1e-12 && Math.abs(atO.n.z - fr.n.z) < 1e-12,
      "resolvePortWorld3D : la NORMALE est la même qu'en salle (le conteneur ne tourne pas)");
    ck.eq(atO ? atO.rackId : "absent", null, "resolvePortWorld3D : aucune baie hôte (le conteneur est l'étage)");
    const atLvl = r3.resolvePortWorld3D(fp.id, 800, 800, 4000);
    ck(atLvl && Math.abs(atLvl.z - (fr.z + 4000)) < 1e-6, "socle de niveau 4000 mm → port monté d'exactement 4000 mm");
    ck(atLvl && Math.abs(atLvl.x - fr.x) < 1e-9 && Math.abs(atLvl.y - fr.y) < 1e-9, "socle de niveau : X et Y INCHANGÉS (translation verticale pure)");
    // PIÈGE VERROUILLÉ : `worldOriginZ` ne porte QUE le socle du conteneur ; la hauteur propre `dc_z` est
    // ajoutée par le résolveur (elle est déjà dans le point LOCAL). Elle ne doit donc jamais être comptée
    // deux fois quand socle ET hauteur propre sont tous deux non nuls.
    await s.update("equipments", fe.id, { dc_z: 250 });
    const frZ = r3.resolvePort3D(fp.id, dc.id), atZ = r3.resolvePortWorld3D(fp.id, 800, 800, 4000);
    ck(frZ && atZ && Math.abs(atZ.z - (frZ.z + 4000)) < 1e-6, "dc_z (250) comptée UNE seule fois en plus du socle");
    ck(atZ && Math.abs(atZ.z - (4000 + 250 + 50)) < 1e-6, "dc_z comptée une fois : z = socle 4000 + dc_z 250 + demi-hauteur 50");
    await s.update("equipments", fe.id, { dc_z: 0 });
    ck.eq(r3.resolvePortWorld3D(p.id, 0, 0, 0), null, "resolvePortWorld3D : équipement RACKÉ (dim_mode « u ») → null");
    ck.eq(r3.resolvePortWorld3D("port-inexistant", 0, 0, 0), null, "resolvePortWorld3D : port inconnu → null");
    // side
    const rk2 = await s.create("racks", { name: "R2", width_mm: 800, depth: 1000, u_count: 42, allow_side_front: true, datacenter_id: dc.id, dc_x: 2000, dc_y: 2000 });
    const se = await s.create("equipments", { name: "PDU", placement_mode: "side", dim_mode: "free", rack_id: rk2.id, side_face: "front", side_lr: "left", side_u: 5, free_w_mm: 60, free_h_mm: 150, free_l_mm: 300 });
    const sp = await s.create("ports", { equipment_id: se.id, name: "sp", face_x: 0.5, face_y: 0.5 });
    const sr = r3.resolvePort3D(sp.id, dc.id);
    ck(sr && isFinite(sr.x) && isFinite(sr.z) && (Math.abs(sr.n.x) + Math.abs(sr.n.y)) > 0, "resolvePort3D(side) → point + normale");
    // wall
    const rk3 = await s.create("racks", { name: "R3", width_mm: 600, depth: 1200, u_count: 42, front_margin_mm: 200, cage_depth_mm: 700, datacenter_id: dc.id, dc_x: 3000, dc_y: 3000 });
    const we = await s.create("equipments", { name: "WALL", placement_mode: "wall", dim_mode: "free", rack_id: rk3.id, wall_lr: "left", wall_margin: "front", wall_u: 5, wall_orient: "center", free_w_mm: 80, free_h_mm: 150, free_l_mm: 100 });
    const wp = await s.create("ports", { equipment_id: we.id, name: "wp", face_x: 0.5, face_y: 0.5 });
    const wr = r3.resolvePort3D(wp.id, dc.id);
    ck(wr && isFinite(wr.x) && isFinite(wr.z), "resolvePort3D(wall) → point fini");
  }
  });

  /* ============================================================================================
     REPÈRE D'UN CONTENU PLACÉ (docs/placement.md §3 règle 1, §6.1) — le conteneur place ses contenus :
     les BAIES comme les ÉQUIPEMENTS LIBRES, qui sont l'un et l'autre « un objet posé avec une position
     et un lacet ». Le module s'appelait `RackFrame` (conteneur BAIE) tant qu'il n'y avait qu'un seul
     contenu de cette forme, puis `RoomFrame` quand le mode libre a fourni la DEUXIÈME occurrence — le
     moment d'extraire (§4.3), pas avant. Il est devenu `PlacementFrame` à la TROISIÈME (l'équipement
     posé sur un ÉTAGE, §6.20), une fois constaté qu'AUCUN champ de la salle n'entrait dans son calcul :
     il ne lit que ceux du CONTENU (§6.22).
     ⚠ Ces attentes sont EXPLICITES (valeurs EN DUR), volontairement : comparer les branches de
     `resolveFaceAnchor3D` au conteneur auquel elles délèguent désormais ne prouverait plus rien et
     resterait VERT (piège du lot 2, cf. doctrine §4.1). La parité avec l'ancien chemin a été prouvée
     À PART, sur 149 040 comparaisons d'hôtes POSITIONNÉS (0 divergence, écart max 0 — bit pour bit) et
     72 576 comparaisons de waypoints (idem) ; ce qui est figé ICI, ce sont des coordonnées dérivées à
     la main du modèle, pas la sortie d'une implémentation.
     ============================================================================================ */
  await section("PlacementFrame : le repère d'un contenu compose rotation PUIS translation (valeurs en dur)", async () => {
  {
    const near = (a, b, name) => ck(Math.abs(a - b) < 1e-9, name + "  (attendu " + b + ", obtenu " + a + ")");
    // placement DÉCLARÉ d'un contenu : position (nullable) + lacet + demi-empreinte de repli.
    const pl = (x, y, yawDeg, halfW, halfD) => ({ x, y, yawDeg, halfW, halfD: (halfD == null) ? halfW : halfD });

    // ---- repère : lacet CARDINAL + origine, dérivés des SEULS champs déclarés par le contenu
    const b0 = PlacementFrame.basis(pl(100, 200, 0, 300, 500));
    ck.eq(b0.cos, 1, "basis(0°) : cosinus = 1"); ck.eq(b0.sin, 0, "basis(0°) : sinus = 0");
    ck.eq(b0.originX, 100, "basis : origine X = position déclarée"); ck.eq(b0.originY, 200, "basis : origine Y = position déclarée");
    // ⚠ CORRECTION de ce lot (arbitrage tranché) : un contenu SANS position est posé à RAS DU COIN de la
    // salle, donc à sa DEMI-EMPREINTE — convention que suivaient déjà les DEUX vues qui dessinent et la
    // géométrie des waypoints. La résolution des ports repliait, elle, sur 0 : elle plaçait les ports une
    // demi-empreinte à côté de la baie affichée. C'est la RÉSOLUTION qui s'aligne sur le RENDU.
    const bNul = PlacementFrame.basis(pl(null, null, 0, 300, 500));
    ck.eq(bNul.originX, 300, "basis : contenu NON positionné → origine X = demi-LARGEUR (ras du coin)");
    ck.eq(bNul.originY, 500, "basis : contenu NON positionné → origine Y = demi-PROFONDEUR");
    // les deux axes sont INDÉPENDANTS : une saisie à moitié faite ne fait retomber QUE l'axe manquant.
    const bMix = PlacementFrame.basis(pl(700, null, 0, 300, 500));
    ck.eq(bMix.originX, 700, "basis : X saisi → X conservé"); ck.eq(bMix.originY, 500, "basis : Y absent → demi-profondeur");
    ck.eq(PlacementFrame.basis(pl(0, 0, 0, 300, 500)).originX, 0, "basis : X = 0 SAISI n'est pas « absent » (0 ≠ null)");
    // angles NON cardinaux : `Normalize.rackOrientation` les ramène à 0 — le port doit suivre la coque dessinée.
    ck.eq(PlacementFrame.basis(pl(0, 0, 45, 0)).sin, 0, "basis(45°) : angle non cardinal ramené à 0");
    ck.eq(PlacementFrame.basis(pl(0, 0, 450, 0)).sin, 1, "basis(450°) : replié sur 90°");

    // ---- POINT : rotation par le lacet, PUIS translation à l'origine du contenu
    const p0 = PlacementFrame.composePoint(b0, { x: 10, y: 20, z: 30 });
    ck.eq(p0.x, 110, "composePoint(0°) : x = origine + x local"); ck.eq(p0.y, 220, "composePoint(0°) : y = origine + y local");
    ck.eq(p0.z, 30, "composePoint : le lacet ne touche JAMAIS Z");
    const p90 = PlacementFrame.composePoint(PlacementFrame.basis(pl(0, 0, 90, 0)), { x: 10, y: 20, z: 30 });
    near(p90.x, -20, "composePoint(90°) : (10, 20) → (−20, 10) [x]"); near(p90.y, 10, "composePoint(90°) : … [y]");
    const p180 = PlacementFrame.composePoint(PlacementFrame.basis(pl(1000, 2000, 180, 0)), { x: 10, y: 20, z: 30 });
    near(p180.x, 990, "composePoint(180°) : demi-tour puis translation [x]"); near(p180.y, 1980, "composePoint(180°) : … [y]");
    const p270 = PlacementFrame.composePoint(PlacementFrame.basis(pl(0, 0, 270, 0)), { x: 10, y: 20, z: 30 });
    near(p270.x, 20, "composePoint(270°) : (10, 20) → (20, −10) [x]"); near(p270.y, -10, "composePoint(270°) : … [y]");

    // ---- DIRECTION : rotation SEULE. C'est LA distinction que chaque branche réécrivait à la main —
    // translater une normale la rendrait non unitaire et enverrait le connecteur 3D à l'autre bout de la salle.
    const dLoin = PlacementFrame.composeDir(PlacementFrame.basis(pl(9999, -4242, 0, 0)), { x: 0, y: -1 });
    ck.eq(dLoin.x, 0, "composeDir : normale NON translatée par l'origine [x]");
    ck.eq(dLoin.y, -1, "composeDir : normale NON translatée par l'origine [y]");
    ck.eq(dLoin.z, 0, "composeDir : direction sans composante verticale → z = 0");
    const d90 = PlacementFrame.composeDir(PlacementFrame.basis(pl(500, 500, 90, 0)), { x: 0, y: -1 });
    near(d90.x, 1, "composeDir(90°) : façade (0, −1) → (1, 0) [x]"); near(d90.y, 0, "composeDir(90°) : … [y]");
    for (const o of [0, 90, 180, 270]) {
      const d = PlacementFrame.composeDir(PlacementFrame.basis(pl(1234, 5678, o, 0)), { x: 0, y: -1 });
      ck(Math.abs(Math.hypot(d.x, d.y) - 1) < 1e-12, "composeDir(" + o + "°) : normale reste UNITAIRE");
    }
    // GÉNÉRALISATION apportée par le mode libre : une face peut être HORIZONTALE (dessus/dessous d'un
    // équipement libre). Le lacet est un lacet PUR : il laisse la composante verticale intacte.
    for (const o of [0, 90, 180, 270]) {
      const dv = PlacementFrame.composeDir(PlacementFrame.basis(pl(1234, 5678, o, 0)), { x: 0, y: 0, z: 1 });
      ck.eq(dv.z, 1, "composeDir(" + o + "°) : normale VERTICALE inchangée par le lacet [z]");
      ck(Math.abs(dv.x) < 1e-12 && Math.abs(dv.y) < 1e-12, "composeDir(" + o + "°) : … et sans composante horizontale");
    }

    // ---- place : les deux d'un coup (ce que consomment les CINQ modes de placement)
    const placed = PlacementFrame.place(pl(1000, 2000, 90, 300, 500), { x: 10, y: 20, z: 30 }, { x: 0, y: -1 });
    near(placed.x, 980, "place(90°) : point tourné PUIS translaté [x]");
    near(placed.y, 2010, "place(90°) : … [y]");
    ck.eq(placed.z, 30, "place : Z inchangé");
    near(placed.n.x, 1, "place(90°) : normale tournée SANS translation [x]");
    near(placed.n.y, 0, "place(90°) : … [y]");
    // « à ras du coin », vu du contenu : la façade d'une boîte 600 × 1000 non positionnée tombe SUR le mur.
    const auCoin = PlacementFrame.place(pl(null, null, 0, 300, 500), { x: 0, y: -500, z: 0 }, { x: 0, y: -1 });
    ck.eq(auCoin.x, 300, "place(sans position) : centre à la demi-largeur du coin [x]");
    ck.eq(auCoin.y, 0, "place(sans position) : la FAÇADE tombe exactement sur le mur y = 0");

    // ---- origin : le CENTRE d'un contenu en local salle = son point local (0, 0) placé par la salle.
    // C'est la lecture dont ont besoin le cadrage caméra, l'outil de positionnement, le placement
    // automatique et les deux vues qui dessinent — pour qu'AUCUN d'eux ne recopie la règle de repli.
    const o0 = PlacementFrame.origin(pl(1200, 800, 0, 300, 500));
    ck.eq(o0.x, 1200, "origin : position déclarée [x]"); ck.eq(o0.y, 800, "origin : position déclarée [y]");
    const oNul = PlacementFrame.origin(pl(null, null, 0, 300, 500));
    ck.eq(oNul.x, 300, "origin : contenu NON positionné → demi-LARGEUR"); ck.eq(oNul.y, 500, "origin : … demi-PROFONDEUR");
    // ⚠ le repli n'est PAS permuté par le lacet (contrairement à `halfExtents`) : c'est la convention du
    // DESSIN, et c'est ce qui distingue `origin` du repli sur les demi-extents orientés que portait
    // `DcInteract.posScene` — à 90°, les deux ne donnent PAS le même point.
    for (const yaw of [0, 90, 180, 270]) {
      const oo = PlacementFrame.origin(pl(null, null, yaw, 300, 500));
      ck(oo.x === 300 && oo.y === 500, "origin(" + yaw + "°) : le repli ne PERMUTE pas largeur/profondeur");
    }
    for (const yaw of [0, 90, 180, 270]) {
      const oo = PlacementFrame.origin(pl(1200, 800, yaw, 300, 500));
      ck(oo.x === 1200 && oo.y === 800, "origin(" + yaw + "°) : le lacet ne DÉPLACE pas l'origine, il tourne autour");
    }
    // cohérence stricte avec `composePoint` : l'origine EST l'image du point local (0, 0).
    const viaPoint = PlacementFrame.composePoint(PlacementFrame.basis(pl(null, null, 90, 300, 500)), { x: 0, y: 0, z: 0 });
    ck(viaPoint.x === oNul.x && viaPoint.y === oNul.y, "origin === composePoint(0, 0) : une seule et même règle");
  }
  });

  /* ============================================================================================
     BORNE §6.6 — VERROU MÉCANIQUE. `PlacementFrame` ne doit connaître NI étage, NI bâtiment, NI site,
     NI layout. SOUS la salle, la transformée d'un contenu est INTRINSÈQUE (déductible des seuls champs
     de l'enregistrement, donc composable ici) ; AU-DESSUS, elle est une DÉCISION DE LAYOUT qui dépend
     de l'ENSEMBLE AFFICHÉ. L'y faire entrer ferait dépendre la position d'un port de ce qui est à
     l'écran — l'inverse exact de §6.8 — et produirait un repère qui prétend remonter seul au monde.
     ⚠ POURQUOI CE VERROU EXISTE MAINTENANT, ET PAS AVANT : le NOM faisait le travail. « Rack » puis
     « Room » bornaient la portée, et personne n'aurait songé à verser une transformée d'étage dans un
     module nommé d'après la salle. `PlacementFrame` (§6.22) est EXACT — le calcul ne lit que les champs
     du CONTENU — mais il n'interdit plus rien : il INVITE à y verser tout le placement. La borne est
     donc portée par l'en-tête du module ET par ceci, exactement comme §6.19 l'a fait pour l'isolement
     de `src-shared/` : une règle qu'aucune machine ne tient finit toujours par ne plus être tenue.
     Le détecteur d'imports est celui du harnais (`TsImports.specifiersOf`) ; sa DISCRIMINATION (douze
     formes vues, commentaires et chaînes littérales ignorés) est prouvée dans test-shared-validation.js
     et vaut donc pour ce verrou-ci aussi.
     ============================================================================================ */
  await section("PlacementFrame : BORNE §6.6 — le repère n'importe NI layout NI vue (verrou)", async () => {
  {
    const fs = require("fs");
    const source = path.join(__dirname, "..", "..", "src-client", "geometry", "PlacementFrame.ts");

    /* LISTE BLANCHE, pas liste noire. Un simple refus par motif raterait le layout atteint
       INDIRECTEMENT — par le barrel `./index`, par un module qui le ré-exporte, par un voisin neutre
       aujourd'hui et porteur demain (le même effet TRANSITIF que §6.19 décrit pour `src-shared/`).
       Ajouter une entrée ici doit rester un ACTE, relu comme tel : si l'import se défend, c'est la
       doctrine §6.6 qu'il faut rouvrir d'abord — pas cette liste. */
    const AUTORISES = new Set(["../core/Normalize"]);
    // Motifs cités uniquement pour DIRE POURQUOI un refus tombe : ils n'élargissent ni ne restreignent
    // la règle, qui reste « tout ce qui n'est pas sur la liste blanche est refusé ».
    const PORTE_LE_LAYOUT = /(FloorLayout|SiteLayout|MultiLayout|PivotBounds|CameraFraming)/;
    const PORTE_UNE_VUE = /(^|\/)(views|app|store|data|sync|ui)(\/|$)/;

    const violationsDe = (texte, nom, autorises = AUTORISES) => {
      const refus = [];
      for (const [spec, ligne] of TsImports.specifiersOf(texte, nom)) {
        if (autorises.has(spec)) continue;
        const ou = nom + ":" + ligne + ' → "' + spec + '"';
        if (PORTE_LE_LAYOUT.test(spec)) refus.push(ou + " — PORTE LE LAYOUT (§6.6 : au-dessus de la salle, la transformée dépend de l'ensemble AFFICHÉ)");
        else if (PORTE_UNE_VUE.test(spec)) refus.push(ou + " — module de VUE / d'ÉTAT : ce repère est une géométrie PURE");
        else refus.push(ou + " — hors LISTE BLANCHE (cf. la borne en tête de PlacementFrame.ts)");
      }
      return refus;
    };

    // -- le VERROU proprement dit, sur la SOURCE réelle (jamais le compilé : c'est le spécificateur ÉCRIT
    //    qu'on contrôle, cf. §6.19) --
    const texte = fs.readFileSync(source, "utf8");
    ck(/export class PlacementFrame/.test(texte), "BORNE : la source lue est bien celle de PlacementFrame (anti-vacuité)");
    const vus = TsImports.specifiersOf(texte, "PlacementFrame.ts");
    ck(vus.has("../core/Normalize"), "BORNE : le détecteur lit des imports RÉELS — vus : " + ([...vus.keys()].join(", ") || "AUCUN"));
    ck.eq(violationsDe(texte, "PlacementFrame.ts").join("  |  "), "",
      "PlacementFrame : BORNE §6.6 — aucun import de layout, de vue, ni hors liste blanche");

    // -- preuve que le verrou MORD : sondes SYNTHÉTIQUES, la source réelle n'est jamais modifiée --
    ck(violationsDe('import { FloorLayout } from "./FloorLayout";', "sonde.ts").join("").includes("PORTE LE LAYOUT"),
      "BORNE : un import de `FloorLayout` est REFUSÉ, et le motif nomme la raison");
    ck.eq(violationsDe('import { SiteLayout } from "./SiteLayout";', "sonde.ts").length, 1, "BORNE : `SiteLayout` REFUSÉ");
    ck(violationsDe('import { DcBase } from "../views/dc/DcBase";', "sonde.ts").join("").includes("VUE"),
      "BORNE : un import de module de VUE est REFUSÉ");
    ck.eq(violationsDe('const m = import("./FloorLayout");', "sonde.ts").length, 1,
      "BORNE : un import DYNAMIQUE ne contourne pas le verrou");
    ck.eq(violationsDe('import { Normalize } from "../core/Normalize";', "sonde.ts").length, 0,
      "BORNE : l'import LÉGITIME de la liste blanche PASSE (le verrou n'est pas un refus aveugle)");

    /* -- MÊME BORNE pour `TrayFrame` (§6.23). Le conteneur ÉTAGÈRE est un cran plus bas dans la même
       chaîne : sa transformée est INTRINSÈQUE au même titre, et il court le même risque de se voir
       verser du layout ou de la vue « puisqu'il place des choses ». La liste blanche y est encore plus
       étroite — un seul TYPE, celui du rectangle qu'il transporte. Le verrou est le même code : ce qui
       s'ajoute est une liste blanche, pas un second détecteur (principe n°3). */
    const sourceTray = path.join(__dirname, "..", "..", "src-client", "geometry", "TrayFrame.ts");
    const texteTray = fs.readFileSync(sourceTray, "utf8");
    const AUTORISES_TRAY = new Set(["../../src-shared/TrayGeometry"]);
    ck(/export class TrayFrame/.test(texteTray), "BORNE : la source lue est bien celle de TrayFrame (anti-vacuité)");
    const vusTray = TsImports.specifiersOf(texteTray, "TrayFrame.ts");
    ck(vusTray.has("../../src-shared/TrayGeometry"), "BORNE : le détecteur lit des imports RÉELS dans TrayFrame — vus : " + ([...vusTray.keys()].join(", ") || "AUCUN"));
    ck.eq(violationsDe(texteTray, "TrayFrame.ts", AUTORISES_TRAY).join("  |  "), "",
      "TrayFrame : BORNE §6.6 — aucun import de layout, de vue, ni hors liste blanche");
    ck.eq(violationsDe('import { RackGeometry } from "./RackGeometry";', "sonde.ts", AUTORISES_TRAY).length, 1,
      "BORNE TrayFrame : même `RackGeometry` est REFUSÉ — le conteneur REÇOIT son placement, il ne le calcule pas (et l'importer BOUCLERAIT)");
  }
  });

  await section("Placement DÉCLARÉ : la baie et l'équipement libre disent au conteneur ce qu'il doit savoir", async () => {
  {
    const { FreeEquipGeometry } = D("geometry/FreeEquipGeometry.js");
    // Le paramétrage d'ATTACHE reste propre à chaque contenu ; ce qui monte au conteneur est UNIQUEMENT
    // « position + lacet + demi-empreinte de repli » (doctrine §6.2, interface COMMUNE mais ÉTROITE).
    const pRack = RackGeometry.roomPlacement({ orientation: 90, dc_x: 1200, dc_y: 800, width_mm: 600, depth: 1000 });
    ck.eq(pRack.x, 1200, "roomPlacement(baie) : x = dc_x"); ck.eq(pRack.y, 800, "roomPlacement(baie) : y = dc_y");
    ck.eq(pRack.yawDeg, 90, "roomPlacement(baie) : lacet = `orientation`");
    ck.eq(pRack.halfW, 300, "roomPlacement(baie) : demi-largeur"); ck.eq(pRack.halfD, 500, "roomPlacement(baie) : demi-profondeur");
    const pRackNu = RackGeometry.roomPlacement({});
    ck.eq(pRackNu.x, null, "roomPlacement(baie) : position absente → null (le conteneur décide du repli)");
    ck.eq(pRackNu.y, null, "roomPlacement(baie) : … [y]");
    ck.eq(pRackNu.halfW, 300, "roomPlacement(baie) : sans cote → RACK_WIDTH_DEFAULT / 2");
    ck.eq(pRackNu.halfD, 500, "roomPlacement(baie) : sans cote → RACK_DEPTH_DEFAULT / 2");
    // ⚠ la demi-empreinte de repli n'est PAS permutée par le lacet — parité avec le DESSIN, qui pose une
    // baie sans position à (width/2, depth/2) quelle que soit son orientation.
    ck.eq(RackGeometry.roomPlacement({ orientation: 90, width_mm: 600, depth: 1000 }).halfW, 300, "roomPlacement(baie 90°) : demi-empreinte NON permutée [W]");
    ck.eq(RackGeometry.roomPlacement({ orientation: 90, width_mm: 600, depth: 1000 }).halfD, 500, "roomPlacement(baie 90°) : … [D]");

    const pFree = FreeEquipGeometry.roomPlacement({ dc_orientation: 180, dc_x: 5, dc_y: 6, free_w_mm: 200, free_l_mm: 300 });
    ck.eq(pFree.x, 5, "roomPlacement(libre) : x = dc_x"); ck.eq(pFree.y, 6, "roomPlacement(libre) : y = dc_y");
    ck.eq(pFree.yawDeg, 180, "roomPlacement(libre) : lacet = `dc_orientation` (PAS `orientation`)");
    ck.eq(pFree.halfW, 100, "roomPlacement(libre) : demi-empreinte en X"); ck.eq(pFree.halfD, 150, "roomPlacement(libre) : … en Y");
    const pFreeNu = FreeEquipGeometry.roomPlacement({});
    ck.eq(pFreeNu.x, null, "roomPlacement(libre) : position absente → null");
    ck.eq(pFreeNu.halfW, 200, "roomPlacement(libre) : sans cote → EQUIP_FREE_DEFAULT_MM / 2");

    // ---- ce que l'équipement libre produit LOCALEMENT (il ne compose plus rien lui-même)
    const eq = { free_w_mm: 200, free_l_mm: 300, free_h_mm: 100, dc_z: 40 };
    const lo = FreeEquipGeometry.portLocal(eq, { face_x: 0.25, face_y: 0.5, face_side: "front" });
    ck.eq(lo.x, -50, "portLocal(front) : x = (face_x − 0,5) × largeur");
    ck.eq(lo.y, -150, "portLocal(front) : y = −demi-profondeur (la façade est en −Y local)");
    ck.eq(lo.z, 90, "portLocal : z part de dc_z (40) + moitié de la hauteur");
    const loC = FreeEquipGeometry.portLocal(eq, { face_x: null, face_y: null, face_side: "front" });
    ck.eq(loC.x, 0, "portLocal : fraction absente → CENTRE de la face [x]"); ck.eq(loC.z, 90, "portLocal : … [z]");
    const n = (f) => FreeEquipGeometry.faceNormalLocal(f);
    ck.eq(JSON.stringify(n("front")), JSON.stringify({ x: 0, y: -1, z: 0 }), "faceNormalLocal(front) → −Y local");
    ck.eq(JSON.stringify(n("rear")), JSON.stringify({ x: 0, y: 1, z: 0 }), "faceNormalLocal(rear) → +Y local");
    ck.eq(JSON.stringify(n("left")), JSON.stringify({ x: -1, y: 0, z: 0 }), "faceNormalLocal(left) → −X local");
    ck.eq(JSON.stringify(n("right")), JSON.stringify({ x: 1, y: 0, z: 0 }), "faceNormalLocal(right) → +X local");
    ck.eq(JSON.stringify(n("top")), JSON.stringify({ x: 0, y: 0, z: 1 }), "faceNormalLocal(top) → VERTICALE +Z");
    ck.eq(JSON.stringify(n("bottom")), JSON.stringify({ x: 0, y: 0, z: -1 }), "faceNormalLocal(bottom) → VERTICALE −Z");
    ck.eq(JSON.stringify(n("truc")), JSON.stringify({ x: 0, y: -1, z: 0 }), "faceNormalLocal(face inconnue) → avant (repli du registre)");
  }
  });

  await section("Resolver3D : le mode LIBRE est hébergé par la SALLE et délègue au conteneur (points en dur)", async () => {
  {
    const s = await makeStore();
    const r3 = new Resolver3D(s);
    const dc = await s.create("datacenters", { name: "DC" });
    const near = (a, b, name) => ck(Math.abs(a - b) < 1e-9, name + "  (attendu " + b + ", obtenu " + a + ")");
    const anchor = (eq, geo) => r3.resolveFaceAnchor3D(eq, geo, dc.id);

    // boîte 200 (X) × 300 (Y) × 100 (Z), posée à 300 mm du sol, centrée en (4000, 2500).
    const eq = await s.create("equipments", { name: "BOX", dim_mode: "free", dc_id: dc.id, dc_x: 4000, dc_y: 2500, dc_z: 300, dc_orientation: 0, free_w_mm: 200, free_l_mm: 300, free_h_mm: 100 });
    const aF = anchor(eq, { face_x: 0.25, face_y: 0.5, face_side: "front" });
    near(aF.x, 3950, "libre/0° : x = dc_x − 50 (face_x sur la largeur du boîtier)");
    near(aF.y, 2350, "libre/0° : y = dc_y − 150 (la façade est en −Y local)");
    near(aF.z, 350, "libre/0° : z = dc_z + moitié de la hauteur");
    near(aF.n.x, 0, "libre/0° : normale = façade (−Y) [x]"); near(aF.n.y, -1, "libre/0° : … [y]");
    ck.eq(aF.n.z, 0, "libre : face verticale → normale horizontale");
    ck.eq(aF.rackId, null, "libre : AUCUNE baie hôte (le conteneur est la salle)");

    // quart de tour : le MÊME point local, tourné par le lacet PROPRE de l'équipement (dc_orientation).
    await s.update("equipments", eq.id, { dc_orientation: 90 });
    const aF90 = anchor(eq, { face_x: 0.25, face_y: 0.5, face_side: "front" });
    near(aF90.x, 4150, "libre/90° : x = dc_x − y local"); near(aF90.y, 2450, "libre/90° : y = dc_y + x local");
    near(aF90.z, 350, "libre/90° : Z insensible au lacet");
    near(aF90.n.x, 1, "libre/90° : la façade regarde +X");

    // face du DESSUS : le seul mode dont la normale est VERTICALE — elle traverse le lacet inchangée.
    await s.update("equipments", eq.id, { dc_orientation: 0 });
    const aT = anchor(eq, { face_x: 0.25, face_y: 0.5, face_side: "top" });
    near(aT.x, 3950, "libre/dessus : x = dc_x − 50"); near(aT.y, 2500, "libre/dessus : y = dc_y (face_y au milieu de la profondeur)");
    near(aT.z, 400, "libre/dessus : z = dc_z + hauteur (sommet)");
    ck.eq(aT.n.z, 1, "libre/dessus : normale VERTICALE +Z");
    await s.update("equipments", eq.id, { dc_orientation: 270 });
    ck.eq(anchor(eq, { face_x: 0.25, face_y: 0.5, face_side: "top" }).n.z, 1, "libre/dessus à 270° : la normale verticale ne tourne PAS");
    await s.update("equipments", eq.id, { dc_orientation: 0 });

    // face GAUCHE : convention photographique (fx court de l'arrière vers l'avant vu de gauche).
    const aL = anchor(eq, { face_x: 0.25, face_y: 0.5, face_side: "left" });
    near(aL.x, 3900, "libre/gauche : x = dc_x − demi-largeur"); near(aL.y, 2575, "libre/gauche : y = dc_y + 75");
    near(aL.n.x, -1, "libre/gauche : normale −X");

    // non placé → non résolu (la salle ne place que ce qu'elle sait situer)
    await s.update("equipments", eq.id, { dc_y: null });
    ck.eq(anchor(eq, { face_x: 0.5, face_y: 0.5, face_side: "front" }), null, "libre sans position → null (le repli de demi-empreinte ne s'applique PAS ici)");
    await s.update("equipments", eq.id, { dc_y: 2500 });
    ck.eq(r3.resolveFaceAnchor3D(eq, { face_x: 0.5, face_y: 0.5, face_side: "front" }, "autre-dc"), null, "libre : salle ≠ dc_id → null");
  }
  });

  await section("CORRECTION : un contenu SANS position est posé à RAS DU COIN — ports et brosses enfin d'accord", async () => {
  {
    const s = await makeStore();
    const r3 = new Resolver3D(s);
    const dc = await s.create("datacenters", { name: "DC" });
    const near = (a, b, name) => ck(Math.abs(a - b) < 1e-9, name + "  (attendu " + b + ", obtenu " + a + ")");

    // Baie 600 × 1000 SANS dc_x/dc_y. Le dessin (2D et 3D) l'a toujours posée en (300, 500) ; la
    // résolution des ports la posait, elle, en (0, 0) — un port et une brosse de LA MÊME baie n'étaient
    // donc pas dans le même repère. Ce lot aligne la résolution sur le dessin.
    // AVANT ce lot, le port avant tombait en (0, −503) ; il tombe désormais en (300, −3).
    const nu = await s.create("racks", { name: "NU", width_mm: 600, depth: 1000, u_count: 42, vmargin_mm: 0, orientation: 0, datacenter_id: dc.id });
    const eq = await s.create("equipments", { name: "SW", placement_mode: "rack", rack_id: nu.id, rack_u: 1, u_height: 1, rack_side: "front" });
    const aNu = r3.resolveFaceAnchor3D(eq, { face_x: 0.5, face_y: 0.5, face_side: "front" }, dc.id);
    near(aNu.x, 300, "baie non positionnée : port centré sur la DEMI-LARGEUR (et non 0)");
    near(aNu.y, -3, "baie non positionnée : façade à 500 − 503 du coin (et non −503)");
    const brNu = r3.brushGeom({ kind: "brush", rack_id: nu.id, rack_u: 1, u_height: 1, depth_mm: 100 });
    near(brNu.cx, 300, "brosse : origine INCHANGÉE par ce lot (elle repliait déjà sur la demi-empreinte)");
    near(brNu.cy, 500, "brosse : … [y]");
    near(brNu.e0.x, 300, "brosse : entrée alignée sur l'axe de la baie");
    near(brNu.e0.y, 2, "brosse : entrée à 2 mm derrière la façade");

    // LA preuve de l'unification : sur une baie POSITIONNÉE, les mêmes écarts relatifs. Port et brosse
    // partagent enfin UNE origine — c'est ce que la divergence d'origine rendait faux.
    const po = await s.create("racks", { name: "PO", width_mm: 600, depth: 1000, u_count: 42, vmargin_mm: 0, orientation: 0, datacenter_id: dc.id, dc_x: 5000, dc_y: 3000 });
    const eqPo = await s.create("equipments", { name: "SW2", placement_mode: "rack", rack_id: po.id, rack_u: 1, u_height: 1, rack_side: "front" });
    const aPo = r3.resolveFaceAnchor3D(eqPo, { face_x: 0.5, face_y: 0.5, face_side: "front" }, dc.id);
    const brPo = r3.brushGeom({ kind: "brush", rack_id: po.id, rack_u: 1, u_height: 1, depth_mm: 100 });
    near(aNu.x - brNu.e0.x, aPo.x - brPo.e0.x, "port ↔ brosse : MÊME écart, baie positionnée ou non [x]");
    near(aNu.y - brNu.e0.y, aPo.y - brPo.e0.y, "port ↔ brosse : MÊME écart, baie positionnée ou non [y]");
    near(aPo.x, 5000, "baie positionnée : port inchangé par ce lot [x]");
    near(aPo.y, 2497, "baie positionnée : port inchangé par ce lot [y]");

    // Le champ de sortie des pins s'appelait `world` alors qu'il rend du LOCAL SALLE : renommé `roomPoint`.
    // `waypointAnchor` en est le consommateur — s'il avait été oublié, il rendrait `undefined` ici.
    const sideAnchor = r3.waypointAnchor({ kind: "point", rack_id: nu.id, side_lr: "left", side_face: "front", side_col: 0, side_u: 3 });
    ck(sideAnchor && isFinite(sideAnchor.x) && isFinite(sideAnchor.z), "waypointAnchor(pin latéral) suit le renommage `world` → `roomPoint`");
    const capAnchor = r3.waypointAnchor({ kind: "point", rack_id: nu.id, cap_face: "floor", cap_cx: 0, cap_cy: 0 });
    ck(capAnchor && isFinite(capAnchor.x), "waypointAnchor(pin de capot) suit le renommage");
    ck.eq(capAnchor.z, 0, "pin de capot au SOL → z = 0");
  }
  });

  await section("Resolver3D : les 4 modes hébergés par une BAIE délèguent au conteneur (points en dur)", async () => {
  {
    const s = await makeStore();
    const r3 = new Resolver3D(s);
    const dc = await s.create("datacenters", { name: "DC" });
    const near = (a, b, name) => ck(Math.abs(a - b) < 1e-9, name + "  (attendu " + b + ", obtenu " + a + ")");
    const anchor = (eq, geo) => r3.resolveFaceAnchor3D(eq, geo, dc.id);

    // ---- mode `rack` : baie 600 × 1000, marges nulles → cage = 1000, uBaseZ = 0, montants à ±500.
    // port avant d'un boîtier monté en façade : 500 (montant) + 3 (réserve d'oreilles) devant le centre,
    // soit y local = −503 ; face_x 0,25 sur un corps de 452,6 mm → x local = −113,15 ;
    // z = (rack_u−1 + (1−face_y)·u_height) · 44,45 = (4 + 0,25·2) · 44,45 = 200,025.
    const rk = await s.create("racks", { name: "R", width_mm: 600, depth: 1000, u_count: 42, vmargin_mm: 0, orientation: 0, datacenter_id: dc.id, dc_x: 5000, dc_y: 3000 });
    const eqR = await s.create("equipments", { name: "SW", placement_mode: "rack", rack_id: rk.id, rack_u: 5, u_height: 2, rack_side: "front" });
    const aR = anchor(eqR, { face_x: 0.25, face_y: 0.75, face_side: "front" });
    near(aR.x, 4886.85, "rack/0° : x = dc_x − 113,15 (face_x sur le corps 19″)");
    near(aR.y, 2497, "rack/0° : y = dc_y − 503 (montant avant + réserve d'oreilles)");
    near(aR.z, 200.025, "rack/0° : z = (U−1 + zf·u_height) · 44,45");
    near(aR.n.x, 0, "rack/0° : normale = façade (−Y) [x]"); near(aR.n.y, -1, "rack/0° : … [y]");
    ck.eq(aR.n.z, 0, "rack : normale horizontale"); ck.eq(aR.rackId, rk.id, "rack : baie hôte exposée");
    // demi-tour : le MÊME point local, tourné. C'est le conteneur qui tourne, pas la branche.
    await s.update("racks", rk.id, { orientation: 180 });
    const aR180 = anchor(eqR, { face_x: 0.25, face_y: 0.75, face_side: "front" });
    near(aR180.x, 5113.15, "rack/180° : x = dc_x + 113,15 (demi-tour)");
    near(aR180.y, 3503, "rack/180° : y = dc_y + 503");
    near(aR180.z, 200.025, "rack/180° : Z insensible au lacet");
    near(aR180.n.y, 1, "rack/180° : la façade regarde +Y");
    await s.update("racks", rk.id, { orientation: 0 });

    // ---- mode `side` : baie 800 × 1000 → marge latérale (800 − 482,6)/2 = 158,7, deux colonnes de
    // (158,7 − 8)/2 = 75,35. Colonne 0 à DROITE, calée au montant : x local ∈ [249,3 ; 309,3].
    // Profondeur : façade à −500, boîte posée 4 mm derrière → y local = −496. z = (side_u−1)·44,45 = 88,9.
    const rkS = await s.create("racks", { name: "RS", width_mm: 800, depth: 1000, u_count: 42, vmargin_mm: 0, orientation: 0, allow_side_front: true, datacenter_id: dc.id, dc_x: 0, dc_y: 0 });
    const eqS = await s.create("equipments", { name: "PDU", placement_mode: "side", dim_mode: "free", rack_id: rkS.id, side_face: "front", side_lr: "right", side_col: 0, side_snap: "post", side_u: 3, free_w_mm: 60, free_h_mm: 100, free_l_mm: 200 });
    const aS = anchor(eqS, { face_x: 0, face_y: 1, face_side: "front" });
    near(aS.x, 249.3, "side/0° : x = bord INTÉRIEUR de la colonne (face_x = 0)");
    near(aS.y, -496, "side/0° : y = façade + 4 mm de jeu");
    near(aS.z, 88.9, "side/0° : z = base du U (face_y = 1 → bas de la boîte)");
    near(aS.n.y, -1, "side/0° : normale = façade de la BAIE, pas de la boîte");
    // quart de tour : (x, y) local → (−y, x). Le seul changement est le repère, pas la boîte.
    await s.update("racks", rkS.id, { orientation: 90 });
    const aS90 = anchor(eqS, { face_x: 0, face_y: 1, face_side: "front" });
    near(aS90.x, 496, "side/90° : x = −y local"); near(aS90.y, 249.3, "side/90° : y = x local");
    near(aS90.z, 88.9, "side/90° : Z insensible au lacet");
    near(aS90.n.x, 1, "side/90° : la façade regarde +X");

    // ---- mode `wall` : baie 600 × 1200, marge avant 200, cage 700. Paroi GAUCHE (x local = −300),
    // orientation « center » → la boîte s'enfonce de 100 mm vers +X ; sa normale sortante est +X, donc
    // face_x court le long de Y : y local = −600 + 0,5 · 80 = −560. z = 88,9 + 100 (face_y = 0 → haut).
    const rkW = await s.create("racks", { name: "RW", width_mm: 600, depth: 1200, u_count: 42, vmargin_mm: 0, front_margin_mm: 200, cage_depth_mm: 700, orientation: 0, allow_side_front: true, datacenter_id: dc.id, dc_x: 0, dc_y: 0 });
    const eqW = await s.create("equipments", { name: "WALL", placement_mode: "wall", dim_mode: "free", rack_id: rkW.id, wall_lr: "left", wall_margin: "front", wall_col: 0, wall_u: 3, wall_orient: "center", free_w_mm: 80, free_h_mm: 100, free_l_mm: 100 });
    const aW = anchor(eqW, { face_x: 0.5, face_y: 0, face_side: "front" });
    near(aW.x, -200, "wall/0° : x = paroi gauche + enfoncement (normale +X)");
    near(aW.y, -560, "wall/0° : y = milieu de la colonne murale");
    near(aW.z, 188.9, "wall/0° : z = sommet de la boîte (face_y = 0)");
    near(aW.n.x, 1, "wall/0° : normale portée par la BOÎTE (+X), pas par la façade de la baie");
    near(aW.n.y, 0, "wall/0° : … [y]");

    // ---- mode `tray` : plateau « dual » sur une baie 600 × 1000 → longueur = cage + 2 × 3 = 1006,
    // plateau plein de 452,6 de large (donc x local ∈ [−226,3 ; 226,3]), plancher utile à
    // (u−1)·44,45 + 5 = 93,9. Équipement 100 × 200 × 40 posé en (0, 0) : face avant à y local −503.
    const rkT = await s.create("racks", { name: "RT", width_mm: 600, depth: 1000, u_count: 42, vmargin_mm: 0, orientation: 0, datacenter_id: dc.id, dc_x: 0, dc_y: 0 });
    const tray = await s.create("rackItems", { rack_id: rkT.id, kind: "tray", tray_type: "dual", side: "front", u: 3, u_height: 2, tray_u: 1 });
    const eqT = await s.create("equipments", { name: "BOX", placement_mode: "tray", dim_mode: "free", tray_item_id: tray.id, tray_x: 0, tray_y: 0, free_w_mm: 100, free_l_mm: 200, free_h_mm: 40 });
    const aT = anchor(eqT, { face_x: 0.5, face_y: 0.5, face_side: "front" });
    near(aT.x, -176.3, "tray/0° : x = bord gauche du plateau + moitié de l'empreinte");
    near(aT.y, -503, "tray/0° : y = plan de façade du plateau");
    near(aT.z, 113.9, "tray/0° : z = plancher utile + moitié de la hauteur posée");
    near(aT.n.y, -1, "tray/0° : port avant d'une étagère avant → normale vers la façade");
    // port ARRIÈRE d'un posé sur étagère AVANT : la boîte sort par son autre face, la baie ne bouge pas.
    const aTr = anchor(eqT, { face_x: 0.5, face_y: 0.5, face_side: "rear" });
    near(aTr.y, -303, "tray : port arrière → face opposée de l'empreinte (−503 + 200)");
    near(aTr.n.y, 1, "tray : port arrière → normale opposée");

    // ---- le repère de SORTIE est LOCAL SALLE, pas monde : la résolution ne connaît ni l'étage, ni le
    // bâtiment (§6.6 — au-dessus de la salle la transformée relève du layout, cf. FloorLayout).
    await s.update("datacenters", dc.id, { location: "site-b", floor: 7 });
    const aApres = anchor(eqR, { face_x: 0.25, face_y: 0.75, face_side: "front" });
    near(aApres.x, 4886.85, "changer d'étage/bâtiment ne déplace PAS le point (repère LOCAL SALLE)");
    near(aApres.y, 2497, "… [y]");
  }
  });

  /* ============================================================================================
     CONTENEUR SANS SALLE — les PORTS d'un équipement posé sur un ÉTAGE
     (`docs/placement.md` §1 symptôme 3, §6.6, §6.20).

     C'est le cas que la doctrine désigne comme IMPOSSIBLE à écrire dans le moule des cinq
     branches de `resolveFaceAnchor3D` : elles exigent toutes un `dcId`, et un équipement d'étage
     n'a pas de salle. `resolvePortWorld3D` en est le pendant SANS SALLE ; il rend du MONDE parce
     que son conteneur n'a pas de transformée intrinsèque à composer (§6.6) — il la REÇOIT.

     ⚠ Attentes EXPLICITES (valeurs EN DUR) dérivées À LA MAIN du modèle, jamais de la sortie d'une
     implémentation : l'équivalence avec le chemin de salle est vérifiée EN PLUS, jamais À LA PLACE.
     Un test purement relatif resterait vert si les DEUX chemins dérivaient ensemble (piège du lot 2,
     cf. §4.1) ; c'est la valeur absolue qui attrape ça, et la relative qui dit l'intention.

     Boîte de référence : 200 (largeur) × 400 (profondeur) × 300 (hauteur), posée à `dc_z` = 250 mm
     au-dessus du sol de son étage. Port AVANT à (face_x 0,25 ; face_y 0,5), donc en local
     (−50 ; −200 ; 250 + 150 = 400) — origine au centre de l'empreinte, façade en −Y.
     ============================================================================================ */
  await section("Resolver3D.resolvePortWorld3D : ports d'un équipement d'ÉTAGE (valeurs en dur)", async () => {
  {
    const s = await makeStore();
    const r3 = new Resolver3D(s);
    const near = (a, b, name) => ck(Math.abs(a - b) < 1e-9, name + "  (attendu " + b + ", obtenu " + a + ")");
    const OX = 1500, OY = -700, OZ = 3200;   // origine MONDE du conteneur (bande de bâtiment + ancrage du plan ; Z du niveau)

    const eqF = await s.create("equipments", {
      name: "ONDULEUR", placement_mode: "floor", dim_mode: "free",
      location: "site-a", floor: "1", floor_x: 5000, floor_y: 3000,
      dc_z: 250, dc_orientation: 0, free_w_mm: 200, free_l_mm: 400, free_h_mm: 300,
    });
    const pF = await s.create("ports", { equipment_id: eqF.id, name: "in", face_x: 0.25, face_y: 0.5, face_side: "front" });
    const at = (ox, oy, oz) => r3.resolvePortWorld3D(pF.id, ox, oy, oz) || { x: null, y: null, z: null, n: { x: null, y: null, z: null }, rackId: "absent" };

    // ---- POINT + NORMALE aux QUATRE lacets cardinaux, valeurs en dur ----
    // Le lacet tourne le point local AUTOUR du centre de l'empreinte, puis on translate à l'origine du
    // conteneur. À 90°, le local (−50 ; −200) devient (+200 ; −50) : la façade regarde l'EST.
    const ATTENDU = {
      0:   { x: 1450, y: -900, n: [0, -1] },
      90:  { x: 1700, y: -750, n: [1, 0] },
      180: { x: 1550, y: -500, n: [0, 1] },
      270: { x: 1300, y: -650, n: [-1, 0] },
    };
    for (const deg of [0, 90, 180, 270]) {
      await s.update("equipments", eqF.id, { dc_orientation: deg });
      const w = at(OX, OY, OZ), exp = ATTENDU[deg];
      ck(w.x != null, "lacet " + deg + "° : port RÉSOLU (non null)");
      near(w.x, exp.x, "lacet " + deg + "° : x monde");
      near(w.y, exp.y, "lacet " + deg + "° : y monde");
      near(w.z, 3600, "lacet " + deg + "° : z monde = socle 3200 + dc_z 250 + demi-hauteur 150");
      near(w.n.x, exp.n[0], "lacet " + deg + "° : normale x (lacet PROPRE seul — le conteneur ne tourne pas)");
      near(w.n.y, exp.n[1], "lacet " + deg + "° : normale y");
      near(w.n.z, 0, "lacet " + deg + "° : normale z nulle (face VERTICALE)");
      // ---- CONTENEUR = pure TRANSLATION : poser le même équipement à une autre origine décale ses ports
      // d'EXACTEMENT ce vecteur, quel que soit le lacet. C'est l'invariant dont dépend tout le placement
      // d'étage (bande de bâtiment en X/Y, niveau en Z — aucune rotation de conteneur nulle part).
      const w0 = at(0, 0, 0);
      near(w.x - w0.x, OX, "lacet " + deg + "° : translation pure — dx");
      near(w.y - w0.y, OY, "lacet " + deg + "° : translation pure — dy");
      near(w.z - w0.z, OZ, "lacet " + deg + "° : translation pure — dz");
      near(w.n.x - w0.n.x, 0, "lacet " + deg + "° : l'origine du conteneur ne touche PAS la normale [x]");
      near(w.n.y - w0.n.y, 0, "lacet " + deg + "° : … [y]");
    }

    // ---- PIÈGE DU `dc_z` COMPTÉ DEUX FOIS : `worldOriginZ` ne porte QUE le socle du conteneur ----
    // La hauteur propre est DÉJÀ dans le point local (portLocal part de `dc_z`) : la compter aussi dans
    // l'origine ferait monter le port de 250 mm de trop, exactement au-dessus de la boîte dessinée.
    await s.update("equipments", eqF.id, { dc_orientation: 0 });
    near(at(OX, OY, OZ).z, OZ + 250 + 150, "dc_z comptée UNE fois : z = socle + dc_z + demi-hauteur");
    ck(Math.abs(at(OX, OY, OZ).z - (OZ + 2 * 250 + 150)) > 1, "dc_z n'est PAS comptée deux fois (le z double serait 3850)");
    await s.update("equipments", eqF.id, { dc_z: 0 });
    near(at(OX, OY, OZ).z, OZ + 150, "dc_z = 0 : z = socle + demi-hauteur");
    await s.update("equipments", eqF.id, { dc_z: 1000 });
    near(at(OX, OY, OZ).z, OZ + 1000 + 150, "dc_z portée à 1000 : z monte d'exactement 750 de plus");
    await s.update("equipments", eqF.id, { dc_z: 250 });
    // Le socle, lui, ne touche QUE le z.
    near(at(OX, OY, OZ + 5000).z - at(OX, OY, OZ).z, 5000, "socle + 5000 → z + 5000, ni plus ni moins");
    near(at(OX, OY, OZ + 5000).x, at(OX, OY, OZ).x, "socle : x inchangé");

    // ---- FACE HORIZONTALE : la normale VERTICALE traverse le lacet inchangée ----
    const pTop = await s.create("ports", { equipment_id: eqF.id, name: "top", face_x: 0.25, face_y: 0.5, face_side: "top" });
    for (const deg of [0, 90, 180, 270]) {
      await s.update("equipments", eqF.id, { dc_orientation: deg });
      const t = r3.resolvePortWorld3D(pTop.id, OX, OY, OZ);
      ck(t && Math.abs(t.n.z - 1) < 1e-12 && Math.abs(t.n.x) < 1e-9 && Math.abs(t.n.y) < 1e-9,
        "face DESSUS au lacet " + deg + "° : normale strictement verticale (+Z)");
      ck(t && Math.abs(t.z - (OZ + 250 + 300)) < 1e-9, "face DESSUS au lacet " + deg + "° : z = socle + dc_z + hauteur (sommet)");
    }
    await s.update("equipments", eqF.id, { dc_orientation: 90 });
    const tW = r3.resolvePortWorld3D(pTop.id, OX, OY, OZ);
    near(tW.x, 1500, "dessus/90° : x monde (le local (−50 ; 0) tourné donne (0 ; −50))");
    near(tW.y, -750, "dessus/90° : y monde");
    await s.update("equipments", eqF.id, { dc_orientation: 0 });

    // ---- BREAKOUT : une lane émerge du connecteur du TRUNK (règle de `resolvePort3D`, reprise ici) ----
    // C'est la correction que la version INLINÉE dans la vue n'avait pas : elle résolvait la lane sur SES
    // propres fractions de face, donc à un endroit où aucun connecteur n'est dessiné.
    const pTrunk = await s.create("ports", { equipment_id: eqF.id, name: "trunk", face_x: 0.75, face_y: 0.25, face_side: "front" });
    const pLane = await s.create("ports", { equipment_id: eqF.id, name: "lane-1", parent_port_id: pTrunk.id, face_x: 0.1, face_y: 0.9, face_side: "front" });
    const wTrunk = r3.resolvePortWorld3D(pTrunk.id, OX, OY, OZ), wLane = r3.resolvePortWorld3D(pLane.id, OX, OY, OZ);
    near(wTrunk.x, 1550, "trunk (face_x 0,75) : x monde");
    near(wTrunk.y, -900, "trunk : y monde (façade en −Y, lacet 0°)");
    near(wTrunk.z, 3675, "trunk (face_y 0,25) : z monde = 3200 + 250 + 0,75 × 300");
    ck(wLane && Math.abs(wLane.x - wTrunk.x) < 1e-12 && Math.abs(wLane.y - wTrunk.y) < 1e-12 && Math.abs(wLane.z - wTrunk.z) < 1e-12,
      "BREAKOUT : la lane émerge du connecteur du TRUNK, pas de ses propres fractions de face");
    // discrimination : ses fractions PROPRES donneraient un autre point — le test ci-dessus n'est pas trivial.
    const pSolo = await s.create("ports", { equipment_id: eqF.id, name: "solo", face_x: 0.1, face_y: 0.9, face_side: "front" });
    const wSolo = r3.resolvePortWorld3D(pSolo.id, OX, OY, OZ);
    ck(Math.abs(wSolo.x - wTrunk.x) > 1 && Math.abs(wSolo.z - wTrunk.z) > 1, "discrimination : un port aux MÊMES fractions mais SANS parent tombe ailleurs");

    // ---- ÉQUIVALENCE salle ⇄ étage : même boîte, même port, origines égales ⇒ MÊME point ----
    // La preuve que la chaîne est correcte : les deux chemins partagent le point LOCAL et la normale ;
    // seule la PROVENANCE de l'origine change (déclarée dans l'enregistrement / fournie par le layout).
    const dcE = await s.create("datacenters", { name: "DC-jumeau", width_mm: 20000, depth_mm: 15000 });
    const eqR = await s.create("equipments", {
      name: "ONDULEUR-jumeau", dim_mode: "free", dc_id: dcE.id, dc_x: 5000, dc_y: 3000,
      dc_z: 250, dc_orientation: 0, free_w_mm: 200, free_l_mm: 400, free_h_mm: 300,
    });
    const pR = await s.create("ports", { equipment_id: eqR.id, name: "in", face_x: 0.25, face_y: 0.5, face_side: "front" });
    for (const deg of [0, 90, 180, 270]) {
      await s.update("equipments", eqF.id, { dc_orientation: deg });
      await s.update("equipments", eqR.id, { dc_orientation: deg });
      const salle = r3.resolvePort3D(pR.id, dcE.id), etage = r3.resolvePortWorld3D(pF.id, 5000, 3000, 0);
      ck(salle && etage, "équivalence " + deg + "° : les deux chemins résolvent");
      near(etage.x, salle.x, "équivalence " + deg + "° : x identique à l'équipement posé EN SALLE");
      near(etage.y, salle.y, "équivalence " + deg + "° : y identique");
      near(etage.z, salle.z, "équivalence " + deg + "° : z identique (socle nul)");
      near(etage.n.x, salle.n.x, "équivalence " + deg + "° : normale identique [x]");
      near(etage.n.y, salle.n.y, "équivalence " + deg + "° : … [y]");
      // socle non nul : le MÊME point, décalé d'EXACTEMENT le socle, et sur le seul axe Z.
      const haut = r3.resolvePortWorld3D(pF.id, 5000, 3000, 6000);
      near(haut.z - salle.z, 6000, "équivalence " + deg + "° : socle 6000 → décalage vertical EXACT");
      near(haut.x - salle.x, 0, "équivalence " + deg + "° : socle → aucun décalage horizontal [x]");
      near(haut.y - salle.y, 0, "équivalence " + deg + "° : … [y]");
    }
    await s.update("equipments", eqF.id, { dc_orientation: 0 });

    // ---- REFUS : ce résolveur ne connaît que la boîte 6 faces ----
    const rk = await s.create("racks", { name: "R", width_mm: 600, depth: 1000, u_count: 42, datacenter_id: dcE.id, dc_x: 500, dc_y: 500 });
    const eqU = await s.create("equipments", { name: "SW", placement_mode: "rack", rack_id: rk.id, rack_u: 10 });
    const pU = await s.create("ports", { equipment_id: eqU.id, name: "p", face_x: 0.3, face_y: 0.4, face_side: "front" });
    ck.eq(r3.resolvePortWorld3D(pU.id, 0, 0, 0), null, "équipement RACKÉ (dim_mode « u ») → null : pas de boîte 6 faces");
    const orphelin = await s.create("ports", { name: "sans équipement", face_x: 0.5, face_y: 0.5 });
    ck.eq(r3.resolvePortWorld3D(orphelin.id, 0, 0, 0), null, "port sans équipement → null");
    ck.eq(r3.resolvePortWorld3D("inconnu", 0, 0, 0), null, "port inconnu → null");
  }
  });

  /* ============================================================================================
     CHAÎNE COMPLÈTE — ce que la VUE pousse au résolveur. Le rendu 3D n'a aucune couverture
     automatique, mais `DatacenterView` s'instancie en HEADLESS : `webglCtx().floorDecor` rend un
     descripteur PUR, donc on peut verrouiller les nombres que `DcThreeScene` passe ensuite à
     `resolvePortWorld3D`. C'est là que le piège du `dc_z` se joue VRAIMENT : le descripteur ne
     porte QUE le socle du niveau, la hauteur propre étant ajoutée par la géométrie.
     ============================================================================================ */
  await section("Chaîne étage → port : le descripteur pousse le SOCLE, le résolveur ajoute la hauteur propre", async () => {
  {
    const s = await makeStore();
    const r3 = new Resolver3D(s);
    const near = (a, b, name) => ck(Math.abs(a - b) < 1e-9, name + "  (attendu " + b + ", obtenu " + a + ")");
    // Site UNIQUE et sans GPS → posé à l'origine du monde (parité stricte avec le rangement historique).
    // Hauteur d'étage FORCÉE à 4 000 mm pour que les Z de niveaux soient ronds : 4 000 + 2 000 d'écart
    // inter-niveaux (DC_GAP_DEFAULT) → l'étage 1 a son socle à 6 000 mm.
    const site = await s.create("sites", { name: "Alpha" });
    await s.create("floors", { location: site.id, floor: "0", width_mm: 20000, depth_mm: 15000, cell_mm: 600, height_mm: 4000 });
    await s.create("floors", { location: site.id, floor: "1", width_mm: 20000, depth_mm: 15000, cell_mm: 600, height_mm: 4000 });
    const dc = await s.create("datacenters", { name: "Salle 0", location: site.id, floor: "0", width_mm: 6000, depth_mm: 4000, floor_x: 1000, floor_y: 1000 });
    const eqF = await s.create("equipments", {
      name: "ONDULEUR", placement_mode: "floor", dim_mode: "free",
      location: site.id, floor: "1", floor_x: 5000, floor_y: 3000,
      dc_z: 250, dc_orientation: 90, free_w_mm: 200, free_l_mm: 400, free_h_mm: 300,
    });
    const pF = await s.create("ports", { equipment_id: eqF.id, name: "in", face_x: 0.25, face_y: 0.5, face_side: "front" });

    const dv = new DatacenterView(s, {}, {});   // garde headless
    dv.view = "3d"; dv.useWebGL = true; dv.dcId = dc.id; dv.multiDc = true;
    dv.visibleDcIds = new Set([dc.id]);
    const fd = dv.webglCtx().floorDecor;

    ck.eq(fd.equips.length, 1, "l'équipement d'étage est transmis au moteur 3D");
    const fe = fd.equips[0];
    ck.eq(fe.id, eqF.id, "descripteur : l'équipement attendu");
    ck.eq(fe.x, 5000, "descripteur : x monde = origine du site + ancrage du plan + floor_x");
    ck.eq(fe.y, 3000, "descripteur : y monde = … + floor_y");
    ck.eq(fe.baseZ, 6000, "descripteur : baseZ = SOCLE du niveau 1 (4 000 de hauteur + 2 000 d'écart)");
    ck(!("z" in fe), "descripteur : AUCUN champ z — le socle seul est transmis, la hauteur propre est ajoutée en aval");
    ck.eq(fe.baseZ, 6000, "descripteur : baseZ n'inclut PAS dc_z (6 250 signalerait le double comptage)");

    // Ce que `DcThreeScene.buildFloorDecor` fait ensuite, à l'identique.
    const w = r3.resolvePortWorld3D(pF.id, fe.x, fe.y, fe.baseZ);
    ck(w, "chaîne complète : le port de l'équipement d'étage est résolu");
    near(w.x, 5200, "chaîne complète : x = 5000 + 200 (local (−50 ; −200) tourné de 90°)");
    near(w.y, 2950, "chaîne complète : y = 3000 − 50");
    near(w.z, 6400, "chaîne complète : z = socle 6000 + dc_z 250 + demi-hauteur 150");
    near(w.n.x, 1, "chaîne complète : façade tournée vers l'EST au lacet 90°");
    near(w.n.y, 0, "chaîne complète : … [y]");

    // La boîte DESSINÉE et le PORT partent du même socle : `buildEquipBox` pose son groupe sur `baseZ`
    // puis sa boîte sur `box().z`, exactement la somme que le résolveur compose. Le port est donc à
    // mi-hauteur de la boîte, jamais 250 mm au-dessus d'elle.
    const bas = fe.baseZ + 250, haut = fe.baseZ + 250 + 300;
    ck(w.z > bas && w.z < haut, "le port tombe DANS la hauteur de la boîte dessinée (socle + dc_z … + hauteur)");
    near(w.z, (bas + haut) / 2, "port à face_y 0,5 → exactement à mi-hauteur de la boîte");
  }
  });

  await section("CableRouting : carriesPower — POE compris (éclair d'avertissement)", async () => {
  {
    const s = await makeStore();
    // `carriesPower` n'utilise que le store ; resolver/floor non requis pour ce prédicat.
    const cr = new CableRouting(s, null, null);
    const eqData = await s.create("equipments", { name: "SW" });
    const eqPoe = await s.create("equipments", { name: "SW-POE", poe_device: true });
    const pData1 = await s.create("ports", { equipment_id: eqData.id, name: "d1", role: "data" });
    const pData2 = await s.create("ports", { equipment_id: eqData.id, name: "d2", role: "data" });
    const pPoe = await s.create("ports", { equipment_id: eqPoe.id, name: "poe1", role: "poe", direction: "source", poe_budget_w: 30 });
    const pPoeOff = await s.create("ports", { equipment_id: eqPoe.id, name: "poeOff", role: "poe", direction: "source", poe_enabled: false });   // PSE, injection COUPÉE
    const eqPd = await s.create("equipments", { name: "CAM-POE", poe_device: true });
    const pPd = await s.create("ports", { equipment_id: eqPd.id, name: "pd1", role: "poe", direction: "sink" });   // PD, consommation ACTIVE (défaut)
    const ctData = await s.create("cableTypes", { name: "Cat6", kind: "data" });
    const ctPower = await s.create("cableTypes", { name: "C13", kind: "power" });
    // carriesPower ne lit que {cable_type_id, from_port_id, to_port_id} + le store : on passe des câbles LITTÉRAUX
    // (pas besoin de persister — et la validation de compatibilité de câble n'est pas l'objet du test).
    // 1) câble data reliant deux ports data → pas d'énergie.
    ck.eq(cr.carriesPower({ cable_type_id: ctData.id, from_port_id: pData1.id, to_port_id: pData2.id }), false, "carriesPower : câble data + ports data → false");
    // 2) câble de TYPE power → énergie (comportement historique préservé).
    ck.eq(cr.carriesPower({ cable_type_id: ctPower.id, from_port_id: pData1.id, to_port_id: pData2.id }), true, "carriesPower : câble de type power → true");
    // 3) POE : l'éclair exige DEUX extrémités PoE ACTIVES (injection PSE + consommation PD).
    ck.eq(cr.carriesPower({ cable_type_id: ctData.id, from_port_id: pData1.id, to_port_id: pPoe.id }), false, "carriesPower : câble data, UNE seule extrémité PoE → false");
    ck.eq(cr.carriesPower({ cable_type_id: ctData.id, from_port_id: pPoe.id, to_port_id: pPd.id }), true, "carriesPower : deux ports PoE actifs (PSE + PD) → true");
    ck.eq(cr.carriesPower({ cable_type_id: ctData.id, from_port_id: pPoeOff.id, to_port_id: pPd.id }), false, "carriesPower : injection coupée d'un côté → false");
    ck.eq(cr.carriesPower(null), false, "carriesPower : câble nul → false");
  }
  });

  await section("Resolver3D : resolveTrunkUplink3D (uplink de faisceau — centre de face arrière)", async () => {
  {
    const s = await makeStore();
    const r3 = new Resolver3D(s);
    const dc = await s.create("datacenters", { name: "DC" });
    const rack = await s.create("racks", { name: "R", width_mm: 600, depth: 1000, u_count: 42, datacenter_id: dc.id, dc_x: 500, dc_y: 500 });
    const patch = await s.create("equipments", { name: "PATCH", type: "patch_panel", placement_mode: "rack", rack_id: rack.id, rack_u: 10 });
    const up = r3.resolveTrunkUplink3D(patch.id, dc.id);
    ck(up && isFinite(up.x) && isFinite(up.y) && isFinite(up.z), "uplink → point fini (sans AUCUN port persisté)");
    ck(up && Math.abs(up.x - 500) < 1e-6, "uplink centré sur la largeur du patch (face_x = 0.5)");
    ck(up && up.n && up.n.y > 0.99, "uplink sur la face ARRIÈRE (normale +Y à orientation 0)");
    ck(up && up.rackId === rack.id, "uplink : baie hôte exposée (masquage avec la baie)");
    // parité avec un port PERSISTÉ posé au même endroit : la résolution de face est PARTAGÉE (resolveFaceAnchor3D)
    const p = await s.create("ports", { equipment_id: patch.id, name: "up", face_x: 0.5, face_y: 0.5, face_side: "rear" });
    const pr = r3.resolvePort3D(p.id, dc.id);
    ck(up && pr && Math.abs(up.x - pr.x) < 1e-6 && Math.abs(up.y - pr.y) < 1e-6 && Math.abs(up.z - pr.z) < 1e-6, "uplink ≡ port persisté au centre de la face arrière (mécanique unique)");
    ck.eq(r3.resolveTrunkUplink3D(patch.id, "autre-dc"), null, "salle ≠ salle de la baie → null");
    ck.eq(r3.resolveTrunkUplink3D(null, dc.id), null, "extrémité absente → null");
    ck.eq(r3.resolveTrunkUplink3D("inconnu", dc.id), null, "équipement inconnu → null");
  }
  });

  await section("Resolver3D : waypointPassPoints / waypointAnchor", async () => {
  {
    const s = await makeStore();
    const r3 = new Resolver3D(s);
    const seg = { kind: "segment", dc_x: 0, dc_y: 0, dc_x2: 10, dc_y2: 0, dc_z: 5 };
    let r = r3.waypointPassPoints(seg, { x: -5, y: 0, z: 5 }, { x: 15, y: 0, z: 5 }, null);
    ck.eq(r.length, 2, "segment → 2 points");
    ck.eq(r[0].x, 0, "prev près de e0 → 1er = e0"); ck.eq(r[1].x, 10, "… 2e = e1"); ck.eq(r[0].z, 5, "z du rail");
    r = r3.waypointPassPoints(seg, { x: 15, y: 0, z: 5 }, { x: -5, y: 0, z: 5 }, null);
    ck.eq(r[0].x, 10, "voisins inversés → 1er = e1"); ck.eq(r[1].x, 0, "… 2e = e0");
    r = r3.waypointPassPoints(seg, { x: -5, y: 0, z: 5 }, { x: 15, y: 0, z: 5 }, { x: 0, y: 0, z: 2 });
    ck.eq(r[0].z, 7, "off appliqué (z 5→7)"); ck.eq(r[0].x, 0, "off n'altère pas x");
    const degen = { kind: "segment", dc_x: 4, dc_y: 6, dc_x2: 4, dc_y2: 6, dc_z: 3 };
    r = r3.waypointPassPoints(degen, { x: 0, y: 0, z: 0 }, { x: 9, y: 9, z: 0 }, null);
    ck.eq(r.length, 1, "segment nul → 1 point (ancre)"); ck.eq(r[0].x, 4, "ancre = milieu (x=4)");
    const pt = { kind: "point", dc_x: 3, dc_y: 4, dc_z: 1 };
    r = r3.waypointPassPoints(pt, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, null);
    ck.eq(r.length, 1, "point isolé → 1 point"); ck.eq(r[0].x, 3, "point → ancre x=3");
    r = r3.waypointPassPoints(pt, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 });
    ck.eq(r[0].y, 5, "off appliqué au point isolé (y 4→5)");
    const aSeg = r3.waypointAnchor(seg);
    ck.eq(aSeg.x, 5, "waypointAnchor(segment) → milieu x=5"); ck.eq(aSeg.z, 5, "waypointAnchor → z=5");
  }
  });

  await section("Resolver3D : répartition conduit (grille / dims / offsets)", async () => {
  {
    // grille & cellule (PURS, statiques)
    ck.eq(JSON.stringify(Resolver3D.conduitGrid(1, 1)), JSON.stringify({ cols: 1, rows: 1 }), "conduitGrid(1) → 1×1");
    ck.eq(JSON.stringify(Resolver3D.conduitGrid(4, 1)), JSON.stringify({ cols: 2, rows: 2 }), "conduitGrid(4, carré) → 2×2");
    ck.eq(Resolver3D.conduitGrid(2, 3).cols, 2, "conduitGrid(2, large) → 2 colonnes");
    const c0 = Resolver3D.conduitCell(0, 4, 1), c3 = Resolver3D.conduitCell(3, 4, 1);
    ck.eq(c0.col + "," + c0.row, "0,0", "conduitCell(0/4) → (0,0)");
    ck.eq(c3.col + "," + c3.row, "1,1", "conduitCell(3/4) → (1,1)");

    const s = await makeStore();
    const r3 = new Resolver3D(s);
    const dc = await s.create("datacenters", { name: "DC" });
    // chemin de câbles (segment) : section pleine 300×100, de (0,0,5) à (10,0,5).
    const seg = await s.create("waypoints", { kind: "segment", datacenter_id: dc.id, dc_x: 0, dc_y: 0, dc_x2: 10, dc_y2: 0, dc_z: 5 });
    const dims = r3.waypointConduitDims(seg);
    ck(dims && dims.kind === "segment" && dims.usableW === 300 && dims.usableH === 100, "waypointConduitDims(segment) → 300×100");
    ck.eq(r3.waypointConduitDims({ kind: "point" }), null, "waypointConduitDims(point sans spread) → null");
    const pinDims = r3.waypointConduitDims({ kind: "point", spread: true, radius: 200 });
    ck(pinDims && pinDims.usableW === 300 && pinDims.usableH === 300, "waypointConduitDims(pin spread r=200) → 300×300 (carré inscrit)");

    // 2 câbles routés par CE segment → ids triés + offsets symétriques ⊥ au rail (axe x).
    // Noms d'équipement UNIQUES par document (contrainte V6g) : compteur incrémental.
    let mkSeq = 0;
    const mk = async () => (await s.create("ports", { equipment_id: (await s.create("equipments", { name: "e" + (++mkSeq) })).id, name: "p" })).id;
    const cabA = await s.create("cables", { name: "A", from_port_id: await mk(), to_port_id: await mk(), waypoint_ids: [seg.id] });
    const cabB = await s.create("cables", { name: "B", from_port_id: await mk(), to_port_id: await mk(), waypoint_ids: [seg.id] });
    const ids = r3.conduitCablesOf(seg.id);
    ck.eq(ids.length, 2, "conduitCablesOf(segment) → 2 câbles");
    ck.eq(JSON.stringify(ids), JSON.stringify([cabA.id, cabB.id].sort()), "conduitCablesOf → ids triés (ordre stable)");
    const prev = { x: -5, y: 0, z: 5 }, next = { x: 15, y: 0, z: 5 };
    const offA = r3.conduitOffsetFor(seg, cabA.id, prev, next);
    const offB = r3.conduitOffsetFor(seg, cabB.id, prev, next);
    ck(offA && offB, "conduitOffsetFor(2 câbles) → offsets non nuls");
    ck(Math.abs(offA.x) < 1e-9 && Math.abs(offA.z) < 1e-9, "offset ⊥ au rail horizontal (x≈0, z≈0)");
    ck(Math.abs(Math.abs(offA.y) - 75) < 1e-9, "demi-pas de répartition (|y|=75 sur 300/2 colonnes)");
    ck(Math.abs(offA.y + offB.y) < 1e-9, "offsets symétriques (offA.y = −offB.y)");
    ck.eq(r3.conduitOffsetFor(seg, "câble-inconnu", prev, next), null, "conduitOffsetFor(câble non routé) → null");

    // 1 seul câble par CE segment → centré (offset null).
    const seg2 = await s.create("waypoints", { kind: "segment", datacenter_id: dc.id, dc_x: 0, dc_y: 20, dc_x2: 10, dc_y2: 20, dc_z: 5 });
    await s.create("cables", { name: "solo", from_port_id: await mk(), to_port_id: await mk(), waypoint_ids: [seg2.id] });
    ck.eq(r3.conduitOffsetFor(seg2, r3.conduitCablesOf(seg2.id)[0], prev, next), null, "conduitOffsetFor(1 seul câble) → null (centré)");

    // FAISCEAU routé par un conduit → occupe un SLOT de répartition comme un câble (sinon, centré, il
    // chevaucherait visuellement un câble voisin — ses brins piochés par ports ne sont pas dessinés).
    const seg3 = await s.create("waypoints", { kind: "segment", datacenter_id: dc.id, dc_x: 0, dc_y: 40, dc_x2: 10, dc_y2: 40, dc_z: 5 });
    const cabT = await s.create("cables", { name: "voisin", from_port_id: await mk(), to_port_id: await mk(), waypoint_ids: [seg3.id] });
    const pat1 = await s.create("equipments", { name: "p1", type: "patch_panel" });
    const pat2 = await s.create("equipments", { name: "p2", type: "patch_panel" });
    const trunk = await s.create("cableBundles", { name: "TRK", endpoint_a_equipment_id: pat1.id, endpoint_b_equipment_id: pat2.id, waypoint_ids: [seg3.id] });
    const ids3 = r3.conduitCablesOf(seg3.id);
    ck.eq(ids3.length, 2, "conduitCablesOf : câble + FAISCEAU routés par le conduit");
    ck(ids3.includes(trunk.id) && ids3.includes(cabT.id), "conduitCablesOf : le faisceau occupe la section (id présent)");
    const offC = r3.conduitOffsetFor(seg3, cabT.id, prev, next), offT = r3.conduitOffsetFor(seg3, trunk.id, prev, next);
    ck(offC && offT, "conduitOffsetFor : offsets non nuls pour le câble ET le faisceau");
    ck(offC && offT && Math.abs(offC.y + offT.y) < 1e-9 && Math.abs(offT.y) > 1, "répartition câble ⇄ faisceau : offsets symétriques (pas de chevauchement)");
  }
  });

  await section("SiteLayout : position des sites (GPS optionnel, repli 5 km, échelle d'affichage)", async () => {
  {
    const near = (a, b, tol, msg) => ck(Math.abs(a - b) <= tol, msg + "  (attendu ≈ " + b + ", obtenu " + a + ")");
    // ---- REPLI DÉTERMINISTE : sans coordonnées, chaque site est posé à 5 km du PRÉCÉDENT, dans l'ordre
    // de la COLLECTION (et non par tri : l'ordre d'insertion est le fait du modèle, cf. doctrine §6.9).
    const trois = SiteLayout.realPositions([{ id: "s1" }, { id: "s2" }, { id: "s3" }]);
    ck.eq(JSON.stringify(trois.map((p) => p.x)), JSON.stringify([0, 5000, 10000]), "repli : 0 / 5 km / 10 km vers l'est");
    ck(trois.every((p) => p.y === 0), "repli : chaîne alignée (y = 0)");
    ck(trois.every((p) => p.fromGps === false), "repli : aucune position marquée GPS");
    ck.eq(SITE_FALLBACK_STEP_M, 5000, "le pas de repli est bien de 5 km");
    const ordre = SiteLayout.realPositions([{ id: "zoulou" }, { id: "alpha" }]);
    ck(ordre[0].location === "zoulou" && ordre[0].x === 0, "repli : ordre de COLLECTION respecté (pas d'ordre alphabétique)");
    // ---- PROJECTION : le repère s'ancre sur le PREMIER site géolocalisé.
    const equateur = SiteLayout.realPositions([{ id: "o", lat: 0, lon: 0 }, { id: "e", lat: 0, lon: 1 }]);
    ck(equateur[0].x === 0 && equateur[0].y === 0, "projection : le site de référence est à l'origine");
    near(equateur[1].x, 111194.9, 5, "projection : 1° de longitude à l'équateur ≈ 111,19 km à l'EST (x > 0)");
    near(equateur[1].y, 0, 1e-6, "projection : même latitude → y inchangé");
    // NORD = -y : sur une vue en plan, le haut de l'écran est le nord (les plans d'étage ont un y qui
    // croît vers le bas). Un site plus au NORD doit donc avoir un y PLUS PETIT — pas l'inverse.
    const nord = SiteLayout.realPositions([{ id: "sud", lat: 50, lon: 5 }, { id: "nord", lat: 51, lon: 5 }]);
    ck(nord[1].y < nord[0].y, "projection : site plus au NORD → y plus petit (nord = -y)");
    near(nord[1].y, -111194.9, 5, "projection : 1° de latitude ≈ 111,19 km");
    // resserrement des méridiens avec la latitude : 1° de longitude à 60° N ≈ la moitié de l'équateur.
    const haut = SiteLayout.realPositions([{ id: "a", lat: 60, lon: 0 }, { id: "b", lat: 60, lon: 1 }]);
    near(haut[1].x, 111194.9 * Math.cos(60 * Math.PI / 180), 5, "projection : cos(latitude) appliqué à la longitude");
    // ANTIMÉRIDIEN : deux sites de part et d'autre du 180ᵉ sont VOISINS (2°), pas aux antipodes (358°).
    const meridien = SiteLayout.realPositions([{ id: "a", lat: 0, lon: 179 }, { id: "b", lat: 0, lon: -179 }]);
    near(meridien[1].x, 2 * 111194.9, 20, "projection : Δlongitude ramenée dans [-180, 180] (antiméridien)");
    // ---- MIXTE : un site sans coordonnées suit le PRÉCÉDENT, que celui-ci soit géolocalisé ou non.
    const mixte = SiteLayout.realPositions([{ id: "gps", lat: 50, lon: 5 }, { id: "sans" }]);
    ck(mixte[0].fromGps === true && mixte[1].fromGps === false, "mixte : le marqueur fromGps distingue les deux origines");
    ck.eq(mixte[1].x - mixte[0].x, 5000, "mixte : le site sans coordonnées est à 5 km à l'est du site GPS");
    ck.eq(mixte[1].y, mixte[0].y, "mixte : …et à la même latitude apparente");
    // ---- COORDONNÉES INEXPLOITABLES → traitées comme ABSENTES (repli), jamais comme (0,0).
    ck.eq(SiteLayout.gpsOf({ id: "x", lat: 50 }), null, "gpsOf : latitude seule → null (le couple est indissociable)");
    ck.eq(SiteLayout.gpsOf({ id: "x", lat: 91, lon: 5 }), null, "gpsOf : latitude hors bornes → null");
    ck.eq(SiteLayout.gpsOf({ id: "x", lat: 50, lon: 181 }), null, "gpsOf : longitude hors bornes → null");
    ck(SiteLayout.gpsOf({ id: "x", lat: 0, lon: 0 }) != null, "gpsOf : (0, 0) est une position VALIDE (golfe de Guinée), pas une absence");
    const partiel = SiteLayout.realPositions([{ id: "a", lat: 50, lon: 5 }, { id: "b", lat: 51 }]);
    ck.eq(partiel[1].x - partiel[0].x, 5000, "saisie partielle → repli 5 km (et non une projection fantaisiste)");
    // ---- ÉCHELLE : réglage d'AFFICHAGE. « 1 km réel = N m monde » → mm_monde = m_réels × N.
    ck.eq(SITE_SCALE_DEFAULT_M_PER_KM, 10, "échelle par défaut : 1 km réel = 10 m monde (facteur 1/100)");
    const w1 = SiteLayout.compress(SiteLayout.realPositions([{ id: "a" }, { id: "b" }]), null);
    ck.eq(w1[1].x - w1[0].x, 50000, "échelle par défaut : le repli de 5 km fait 50 000 mm (50 m)");
    const w2 = SiteLayout.compress(SiteLayout.realPositions([{ id: "a" }, { id: "b" }]), { metresPerKm: 20, log: false });
    ck.eq(w2[1].x - w2[0].x, 100000, "échelle ×2 : 5 km → 100 000 mm");
    // Bornage : une échelle absente/nulle/aberrante ne doit jamais confondre les sites à l'origine.
    ck(SiteLayout.normalizeScale(null).metresPerKm === 10, "normalizeScale : réglage absent → défaut");
    ck(SiteLayout.normalizeScale({ metresPerKm: 0, log: false }).metresPerKm >= 1, "normalizeScale : 0 borné (sinon tous les sites confondus)");
    ck(SiteLayout.normalizeScale({ metresPerKm: 1e9, log: false }).metresPerKm <= 200, "normalizeScale : valeur démesurée bornée");
    ck(SiteLayout.normalizeScale({ metresPerKm: NaN, log: false }).metresPerKm === 10, "normalizeScale : NaN → défaut");
    // ---- NORMALISATION : le monde commence à l'origine ; le cas MONO-SITE y retombe exactement, ce qui
    // garantit la PARITÉ STRICTE avec le rangement historique (bâtiment unique posé en x = 0).
    const solo = SiteLayout.compress(SiteLayout.realPositions([{ id: "seul", lat: 50.6, lon: 5.57 }]), null);
    ck(solo.length === 1 && solo[0].x === 0 && solo[0].y === 0, "mono-site géolocalisé → (0, 0) : parité stricte avec l'historique");
    const sud = SiteLayout.compress(SiteLayout.realPositions([{ id: "n", lat: 51, lon: 5 }, { id: "s", lat: 50, lon: 5 }]), null);
    ck(Math.min(...sud.map((p) => p.x)) === 0 && Math.min(...sud.map((p) => p.y)) === 0, "normalisation : min x = min y = 0");
    ck(sud[0].y < sud[1].y, "normalisation : l'ORDRE nord/sud est préservé par la translation");
    // ---- MODE LOGARITHMIQUE : comprime les grandes distances, conserve directions et ordre.
    const lin = SiteLayout.compress(SiteLayout.realPositions([{ id: "a", lat: 0, lon: 0 }, { id: "b", lat: 0, lon: 5 }]), { metresPerKm: 10, log: false });
    const lg = SiteLayout.compress(SiteLayout.realPositions([{ id: "a", lat: 0, lon: 0 }, { id: "b", lat: 0, lon: 5 }]), { metresPerKm: 10, log: true });
    ck(lg[1].x - lg[0].x < lin[1].x - lin[0].x, "log : 556 km comprimés par rapport au linéaire");
    ck(lg[1].x > lg[0].x, "log : direction (est) conservée");
    const lgOrdre = SiteLayout.compress(SiteLayout.realPositions([{ id: "a" }, { id: "b" }, { id: "c" }]), { metresPerKm: 10, log: true });
    ck(lgOrdre[0].x < lgOrdre[1].x && lgOrdre[1].x < lgOrdre[2].x, "log : ordre des sites préservé");
    ck(Math.min(...lgOrdre.map((p) => p.x)) === 0, "log : normalisation appliquée aussi en logarithmique");
    // ---- carte de consommation
    const carte = SiteLayout.worldPositions([{ id: "a" }, { id: "b" }], ["legacy"], null);
    ck(carte.get("a").x === 0 && carte.get("b").x === 50000 && carte.get("legacy").x === 100000, "worldPositions : sites puis locations historiques, à la suite");
    ck.eq(carte.get("inconnu"), undefined, "worldPositions : une location hors modèle n'a PAS de position par défaut");
    ck.eq(JSON.stringify(SiteLayout.compress([], null)), "[]", "compress : modèle vide → aucune position (pas de NaN)");
  }
  });

  await section("FloorLayout : disposition multi-salles (étages empilés, bâtiments côte à côte)", async () => {
  {
    const s = await makeStore();
    const fl = new FloorLayout(s);
    // helpers purs
    ck.eq(FloorLayout.floorNum("2"), 2, "floorNum(\"2\") → 2");
    ck.eq(FloorLayout.floorNum(""), 0, "floorNum(vide) → 0");
    ck.eq(JSON.stringify(FloorLayout.roomFootprint({ width_mm: 600, depth_mm: 1000, floor_orientation: 0 })), JSON.stringify({ w: 600, h: 1000 }), "roomFootprint 0° → (w,d)");
    ck.eq(JSON.stringify(FloorLayout.roomFootprint({ width_mm: 600, depth_mm: 1000, floor_orientation: 90 })), JSON.stringify({ w: 1000, h: 600 }), "roomFootprint 90° → (d,w)");
    // config virtuelle quand pas d'entité floors
    const cfg = fl.config("liege", "0");
    ck(cfg.id === null && cfg.width_mm > 0 && cfg.cell_mm > 0, "config(sans entité) → défaut virtuel");
    // deux salles, deux étages d'un même bâtiment → empilées en Z, posées en X
    const dcA = await s.create("datacenters", { name: "A", location: "liege", floor: "0", width_mm: 6000, depth_mm: 4000, floor_x: 1000, floor_y: 1000 });
    const dcB = await s.create("datacenters", { name: "B", location: "liege", floor: "1", width_mm: 6000, depth_mm: 4000, floor_x: 1000, floor_y: 1000 });
    const m = fl.multiLayout(dcA, { visibleDcIds: new Set([dcA.id, dcB.id]) });
    ck.eq(m.rooms.length, 2, "multiLayout : 2 salles disposées");
    ck(m.levels.length === 2 && m.levels[0] === 0 && m.levels[1] === 1, "multiLayout : niveaux [0,1]");
    const rA = m.rooms.find((r) => r.dc.id === dcA.id), rB = m.rooms.find((r) => r.dc.id === dcB.id);
    ck(rB.off.z > rA.off.z, "multiLayout : étage 1 EMPILÉ au-dessus de l'étage 0 (z plus grand)");
    ck.eq(m.buildings.length, 1, "multiLayout : 1 bâtiment (Liège)");
    // roomToWorld / roomToLocal : aller-retour exact
    const p = { x: 2500, y: 1500, z: 700 };
    const w = FloorLayout.roomToWorld(rA, p), back = FloorLayout.roomToLocal(rA, w);
    ck(Math.abs(back.x - p.x) < 1e-6 && Math.abs(back.y - p.y) < 1e-6 && Math.abs(back.z - p.z) < 1e-6, "roomToWorld/roomToLocal : aller-retour exact");
    // centre local de la salle → centre monde = room.off
    const ctr = FloorLayout.roomToWorld(rA, { x: dcA.width_mm / 2, y: dcA.depth_mm / 2, z: 0 });
    ck(Math.abs(ctr.x - rA.off.x) < 1e-6 && Math.abs(ctr.y - rA.off.y) < 1e-6, "roomToWorld(centre salle) = room.off");
    // levelZ interpolé : niveau intermédiaire entre 0 et 1
    const z05 = FloorLayout.levelZ(m, 0.5);
    ck(z05 > rA.off.z && z05 < rB.off.z, "levelZ(0.5) interpolé entre étage 0 et 1");
    // deux bâtiments → posés côte à côte (x croissant)
    const dcC = await s.create("datacenters", { name: "C", location: "herstal", floor: "0", width_mm: 6000, depth_mm: 4000, floor_x: 1000, floor_y: 1000 });
    const m2 = fl.multiLayout(null, { visibleDcIds: new Set([dcA.id, dcC.id]) });
    ck.eq(m2.buildings.length, 2, "multiLayout : 2 bâtiments côte à côte");
    ck(m2.buildings[1].x0 >= m2.buildings[0].x1, "multiLayout : bâtiments non chevauchants (x croissant)");
    // §6.8 de docs/placement.md — le REPÈRE se dérive du MODÈLE DÉCLARÉ, jamais de l'ensemble AFFICHÉ :
    // réduire la portée (jusqu'à masquer un bâtiment entier) ne doit RIEN déplacer. C'est l'invariant que
    // ce lot installe, et il n'existait pas avant : la disposition était calculée sur les salles affichées.
    const large = fl.multiLayout(dcA, { visibleDcIds: new Set([dcA.id, dcB.id, dcC.id]) });
    const etroit = fl.multiLayout(dcA, { visibleDcIds: new Set([dcA.id]) });
    ck.eq(JSON.stringify(etroit.buildings), JSON.stringify(large.buildings), "portée réduite → bandes de bâtiment INCHANGÉES (un site masqué garde sa place)");
    ck.eq(JSON.stringify(etroit.levelZs), JSON.stringify(large.levelZs), "portée réduite → altitudes de niveau INCHANGÉES");
    const offA = (mm) => JSON.stringify(mm.rooms.find((x) => x.dc.id === dcA.id).off);
    ck.eq(offA(etroit), offA(large), "portée réduite → la salle encore affichée ne BOUGE pas");
    // L'ordre des bâtiments ne dépend plus de la salle ACTIVE (c'est la caméra qui se déplace, pas le monde).
    const depuisA = fl.multiLayout(dcA, { visibleDcIds: new Set([dcA.id, dcC.id]) });
    const depuisC = fl.multiLayout(dcC, { visibleDcIds: new Set([dcA.id, dcC.id]) });
    ck.eq(JSON.stringify(depuisC.buildings), JSON.stringify(depuisA.buildings), "ordre des bâtiments STABLE, indépendant de la salle active");
    // …mais la PORTÉE reste pleinement effective sur ce qui est DESSINÉ (repère ⊥ portée).
    ck(etroit.rooms.length === 1 && large.rooms.length === 3, "la portée filtre bien les salles DESSINÉES");
    ck(etroit.floorPlanes.length < large.floorPlanes.length, "la portée filtre bien les plans d'étage DESSINÉS");
    // décor (5c.16.3) : plans d'étage (un par bâtiment × étage) + position monde d'un OOB
    ck(m.floorPlanes.length >= 2, "multiLayout : ≥ 2 plans d'étage (Liège ét.0 + ét.1)");
    const fpA = m.floorPlanes.find((fp) => fp.floor === "0"); ck(!!fpA && fpA.off.z === 0, "floorPlane ét.0 → z = 0");
    const fpB = m.floorPlanes.find((fp) => fp.floor === "1"); ck(!!fpB && fpB.off.z > 0, "floorPlane ét.1 → z > 0 (empilé)");
    const oob = await s.create("waypoints", { wp_type: "oob", location: "liege", floor: "1", floor_x: 500, floor_y: 700, dc_z: 3000 });
    const m3 = fl.multiLayout(dcA, { visibleDcIds: new Set([dcA.id, dcB.id]) });
    const ow = fl.oobWorld(m3, oob);
    ck(isFinite(ow.x) && isFinite(ow.y) && ow.z > FloorLayout.levelZ(m3, 1), "oobWorld : OOB au-dessus du sol de son étage");
    // équipement posé sur un étage : position localisée vs centre (auto) + point monde au niveau de l'étage
    const cfg0 = fl.config("liege", "0");
    ck.eq(JSON.stringify(FloorLayout.floorEquipPos({ placement_mode: "floor", floor_x: 800, floor_y: 600 }, cfg0)), JSON.stringify({ x: 800, y: 600 }), "floorEquipPos localisé → (floor_x, floor_y)");
    ck.eq(JSON.stringify(FloorLayout.floorEquipPos({ placement_mode: "floor" }, cfg0)), JSON.stringify({ x: cfg0.width_mm / 2, y: cfg0.depth_mm / 2 }), "floorEquipPos non localisé → centre du plan");
    const fe = { placement_mode: "floor", location: "liege", floor: "1", floor_x: 500, floor_y: 700, dc_z: 1000 };
    const ew = fl.equipFloorWorld(m3, fe);
    ck(isFinite(ew.x) && isFinite(ew.y) && Math.abs(ew.z - (FloorLayout.levelZ(m3, 1) + 1000)) < 1e-6, "equipFloorWorld : base = niveau étage + dc_z");
    // ORIGINE du repère PROPRE du posé (source unique du décor 3D ET du cadrage « Localiser ») : même x/y
    // que ci-dessus, mais un Z qui ne porte QUE le SOCLE. C'est la frontière exacte du piège du `dc_z` :
    // l'origine l'ignore, `equipFloorWorld` (et le résolveur de ports) l'ajoute — une seule fois chacun.
    const fo = fl.equipFloorOrigin(m3, fe);
    ck(fo.x === ew.x && fo.y === ew.y, "equipFloorOrigin : mêmes x/y que equipFloorWorld (une seule règle de position sur le plan)");
    ck.eq(fo.baseZ, FloorLayout.levelZ(m3, 1), "equipFloorOrigin : baseZ = SOCLE du niveau, SANS la hauteur propre");
    // Tolérance : le socle de ce niveau n'est pas un nombre rond (hauteur de contenu = 42 × 44,45 mm),
    // l'écart mesuré porte donc l'erreur d'arrondi de la somme — pas celle de la règle.
    ck(Math.abs((ew.z - fo.baseZ) - 1000) < 1e-6, "equipFloorWorld = origine + dc_z : la hauteur propre est ajoutée UNE fois, et là seulement");
    ck(!("z" in fo), "equipFloorOrigin : aucun champ `z` — le nom `baseZ` interdit de le confondre avec une altitude d'objet");
    // Un posé NON localisé retombe au CENTRE de son plan, comme il est DESSINÉ (parité `floorEquipPos`).
    // Mesuré par ÉCART avec le posé localisé ci-dessus (même bâtiment, même étage) : l'origine du bâtiment
    // et l'ancrage du plan s'annulent, l'attente ne dépend donc que du modèle.
    const cfg1 = fl.config("liege", "1");
    const foAuto = fl.equipFloorOrigin(m3, { placement_mode: "floor", location: "liege", floor: "1" });
    ck.eq(foAuto.x - fo.x, cfg1.width_mm / 2 - 500, "equipFloorOrigin(non localisé) : x = centre du plan (écart au posé en floor_x 500)");
    ck.eq(foAuto.y - fo.y, cfg1.depth_mm / 2 - 700, "equipFloorOrigin(non localisé) : y = centre du plan (écart au posé en floor_y 700)");
    ck.eq(foAuto.baseZ, fo.baseZ, "equipFloorOrigin(non localisé) : même socle — seule la position sur le plan diffère");
  }
  // ---- NIVEAU SITE (doctrine §6.9) : la position d'un bâtiment se dérive du SITE (GPS, sinon repli à
  // 5 km), et non plus d'un rangement par largeur cumulée. Les attentes ci-dessous sont EXPLICITES — pas
  // une comparaison de l'ancien chemin au nouveau : au lot 2, un test de parité était devenu tautologique
  // au moment même de la bascule et serait resté vert sans plus rien prouver (méthode, doctrine §4.1).
  {
    const s = await makeStore();
    const fl = new FloorLayout(s);
    const near = (a, b, tol, msg) => ck(Math.abs(a - b) <= tol, msg + "  (attendu ≈ " + b + ", obtenu " + a + ")");
    const liege = await s.create("sites", { name: "Liège" });
    const dc1 = await s.create("datacenters", { name: "R1", location: liege.id, floor: "0", width_mm: 6000, depth_mm: 4000, floor_x: 0, floor_y: 0 });
    // MONO-SITE : le cas de très loin le plus courant doit retomber EXACTEMENT sur l'origine — c'est la
    // parité stricte avec le rangement historique, et la garantie qu'aucun document existant ne bouge.
    const mono = fl.multiLayout(dc1, { visibleDcIds: new Set([dc1.id]) });
    ck(mono.buildings.length === 1 && mono.buildings[0].x0 === 0 && mono.buildings[0].y0 === 0, "mono-site : bâtiment à l'origine (parité stricte avec l'historique)");
    // DEUX SITES sans coordonnées : le repli de 5 km, à l'échelle par défaut, vaut 50 000 mm.
    const herstal = await s.create("sites", { name: "Herstal" });
    const dc2 = await s.create("datacenters", { name: "R2", location: herstal.id, floor: "0", width_mm: 6000, depth_mm: 4000, floor_x: 0, floor_y: 0 });
    const repli = fl.multiLayout(null, {});
    const bL = repli.buildings.find((b) => b.loc === liege.id), bH = repli.buildings.find((b) => b.loc === herstal.id);
    ck.eq(bH.x0 - bL.x0, 50000, "deux sites sans GPS : origines distantes de 50 000 mm (5 km au 1/100)");
    ck.eq(bH.y0, bL.y0, "deux sites sans GPS : chaîne de repli alignée en y");
    ck(bL.x1 > bL.x0 && bL.y1 > bL.y0, "la bande de bâtiment garde une emprise (x1/y1 = origine + plan d'étage)");
    // COORDONNÉES RENSEIGNÉES : la position réelle remplace le repli. Herstal est au nord-est de Liège,
    // à ≈ 3,5 km — donc PLUS PRÈS que les 5 km du repli, et décalée en y (ce que l'ancien modèle à une
    // seule dimension ne pouvait pas exprimer).
    await s.update("sites", liege.id, { lat: 50.6326, lon: 5.5797 });
    await s.update("sites", herstal.id, { lat: 50.6634, lon: 5.6303 });
    const gps = fl.multiLayout(null, {});
    const gL = gps.buildings.find((b) => b.loc === liege.id), gH = gps.buildings.find((b) => b.loc === herstal.id);
    ck(gH.x0 > gL.x0, "GPS : Herstal à l'EST de Liège (x plus grand)");
    ck(gH.y0 < gL.y0, "GPS : Herstal au NORD de Liège (y plus petit — nord = -y)");
    ck(Math.hypot(gH.x0 - gL.x0, gH.y0 - gL.y0) < 50000, "GPS : la distance réelle (≈ 3,5 km) remplace bien le repli de 5 km");
    ck(Math.min(gL.x0, gH.x0) === 0 && Math.min(gL.y0, gH.y0) === 0, "GPS : le monde reste ancré à l'origine (normalisation)");
    // ÉCHELLE = réglage d'AFFICHAGE : elle change les écarts, jamais l'ordre ni les directions.
    const x2 = fl.multiLayout(null, { siteScale: { metresPerKm: 20, log: false } });
    const x2L = x2.buildings.find((b) => b.loc === liege.id), x2H = x2.buildings.find((b) => b.loc === herstal.id);
    near(x2H.x0 - x2L.x0, 2 * (gH.x0 - gL.x0), 1e-6, "échelle ×2 : l'écart entre bâtiments double");
    near(x2H.y0 - x2L.y0, 2 * (gH.y0 - gL.y0), 1e-6, "échelle ×2 : l'écart en y double aussi");
    ck.eq(x2L.x1 - x2L.x0, gL.x1 - gL.x0, "échelle ×2 : l'EMPRISE d'un bâtiment ne change pas (elle est en mm réels)");
    // §6.8 — masquer retire du DESSIN, jamais du REPÈRE : les bandes ne bougent pas avec la portée.
    const portee = fl.multiLayout(dc1, { visibleDcIds: new Set([dc1.id]) });
    ck.eq(JSON.stringify(portee.buildings), JSON.stringify(fl.multiLayout(dc1, { visibleDcIds: new Set([dc1.id, dc2.id]) }).buildings), "portée réduite → bandes de bâtiment INCHANGÉES");
    // Un site sans aucun étage ni salle est un fait du MODÈLE (il occupe un rang dans la chaîne de repli)
    // mais n'a rien à dessiner : aucune bande émise.
    const seraing = await s.create("sites", { name: "Seraing" });
    ck(!fl.multiLayout(null, {}).buildings.some((b) => b.loc === seraing.id), "site sans étage ni salle → aucune bande de bâtiment émise");
    // Le contenu POSÉ SUR UN ÉTAGE suit l'origine de son bâtiment en X **et** en Y. Ne lire que `x0`
    // repliait silencieusement tous les bâtiments sur la même bande — d'où ces deux attentes séparées.
    const eqFloor = { placement_mode: "floor", location: herstal.id, floor: "0", floor_x: 500, floor_y: 700, dc_z: 0 };
    const wEq = fl.equipFloorWorld(gps, eqFloor);
    ck.eq(wEq.x, gH.x0 + 500, "equipFloorWorld : x mesuré depuis l'origine du bâtiment (x0)");
    ck.eq(wEq.y, gH.y0 + 700, "equipFloorWorld : y mesuré depuis l'origine du bâtiment (y0)");
    const oobH = await s.create("waypoints", { wp_type: "oob", location: herstal.id, floor: "0", floor_x: 300, floor_y: 400, dc_z: 2000 });
    const wOob = fl.oobWorld(gps, oobH);
    ck.eq(wOob.x, gH.x0 + 300, "oobWorld : x mesuré depuis l'origine du bâtiment (x0)");
    ck.eq(wOob.y, gH.y0 + 400, "oobWorld : y mesuré depuis l'origine du bâtiment (y0)");
  }
  // ---- TAILLE DÉCLARÉE du bâtiment (doctrine §6.8, dernier paragraphe). Le bâtiment n'avait pas de
  // dimension propre : il épousait son plus grand plan d'étage. Déclarée, la taille FAIT l'emprise ;
  // absente, l'emprise reste DÉDUITE, à parité stricte avec l'historique. Attentes EXPLICITES (valeurs
  // écrites en dur) et non une comparaison du nouveau chemin à l'ancien — un tel test resterait vert
  // en ne prouvant plus rien au moment même de la bascule (doctrine §4.1, piège vécu au lot 2).
  {
    const s = await makeStore();
    const fl = new FloorLayout(s);
    const ans = await s.create("sites", { name: "Ans" });
    // Étage CONFIGURÉ 6000 × 4000, ancré à (1000, 500) → emprise DÉDUITE attendue : 7000 × 4500.
    await s.create("floors", { location: ans.id, floor: "0", width_mm: 6000, depth_mm: 4000, anchor_x: 1000, anchor_y: 500 });
    await s.create("datacenters", { name: "S", location: ans.id, floor: "0", width_mm: 3000, depth_mm: 2000, floor_x: 0, floor_y: 0 });
    const bandeDe = (m) => m.buildings.find((b) => b.loc === ans.id);
    const deduit = bandeDe(fl.multiLayout(null, {}));
    ck.eq(deduit.x1 - deduit.x0, 7000, "SANS taille déclarée : emprise = plan d'étage + ancre (6000 + 1000) — comportement HISTORIQUE conservé");
    ck.eq(deduit.y1 - deduit.y0, 4500, "SANS taille déclarée : profondeur = 4000 + 500");
    // Taille DÉCLARÉE : c'est ELLE qui fait l'emprise — le bâtiment cesse d'épouser son plan d'étage.
    await s.update("sites", ans.id, { width_mm: 20000, depth_mm: 10000 });
    const declaree = fl.multiLayout(null, {});
    const bDecl = bandeDe(declaree);
    ck.eq(bDecl.x1 - bDecl.x0, 20000, "taille DÉCLARÉE : la largeur de la bande vaut la largeur déclarée");
    ck.eq(bDecl.y1 - bDecl.y0, 10000, "taille DÉCLARÉE : la profondeur de la bande vaut la profondeur déclarée");
    ck.eq(bDecl.x0, deduit.x0, "taille DÉCLARÉE : l'ORIGINE du bâtiment (position du site) ne bouge pas");
    ck.eq(declaree.totalW, 20000, "taille DÉCLARÉE : l'étendue du monde (cadrage caméra) suit la bande déclarée");
    ck.eq(declaree.maxD, 10000, "taille DÉCLARÉE : la profondeur du monde suit aussi");
    // Les plans d'étage, eux, gardent leur propre taille : la déclaration borne le bâtiment, elle ne
    // redimensionne rien de ce qu'il contient.
    const plan = declaree.floorPlanes.find((fp) => fp.loc === ans.id);
    ck(plan.cfg.width_mm === 6000 && plan.cfg.depth_mm === 4000, "taille DÉCLARÉE : le plan d'étage garde SA taille (le bâtiment le borne, il ne le redimensionne pas)");
    // Une DEMI-dimension est refusée à l'écriture (couple indissociable) : l'emprise ne peut donc jamais
    // se calculer sur une moitié de taille — la géométrie n'a pas à s'en défendre, la validation le fait.
    await s.update("sites", ans.id, { depth_mm: null });
    const apresRefus = bandeDe(fl.multiLayout(null, {}));
    ck.eq(apresRefus.x1 - apresRefus.x0, 20000, "demi-dimension REFUSÉE à l'écriture → l'emprise déclarée reste inchangée");
  }
  });

  await section("FloorLayout : le conteneur SALLE sait tourner une NORMALE (roomDirToWorld / roomEndToWorld — §6.30)", async () => {
  {
    // Aucun layout ici, et c'est VOULU : le `RoomPlacement` est écrit À LA MAIN, donc toutes les valeurs
    // attendues plus bas se dérivent du modèle au crayon (centre de salle (3000 ; 2000), origine monde
    // (10000 ; 20000 ; 3000)) au lieu d'être recopiées d'une exécution. Ce sont des ATTENTES, pas des
    // empreintes. La composition avec le layout, elle, est vérifiée dans la section `worldLine` suivante.
    const approx = (a, b, name, eps) => ck(Math.abs(a - b) <= (eps || 1e-9), name + "  (attendu ≈" + b + ", obtenu " + a + ")");
    const salle = (deg) => ({ dc: { width_mm: 6000, depth_mm: 4000 }, off: { x: 10000, y: 20000, z: 3000 }, o: deg * Math.PI / 180, level: 0 });
    const local = { x: 1500, y: 500, z: 700 };            // → écart au centre : (−1500 ; −1500)
    const normaleAvant = { x: 0, y: -1, z: 0 };           // normale sortante d'une FAÇADE (−Y local)
    // Point : le lacet de la salle fait tourner l'écart au centre autour de `off`.
    const ptAttendu = { 0: [8500, 18500], 90: [11500, 18500], 180: [11500, 21500], 270: [8500, 21500] };
    // Normale : ROTATION SEULE — jamais de translation, jamais d'origine de salle.
    const nAttendue = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };
    [0, 90, 180, 270].forEach((deg) => {
      const room = salle(deg);
      const bout = FloorLayout.roomEndToWorld(room, { x: local.x, y: local.y, z: local.z, n: normaleAvant });
      approx(bout.x, ptAttendu[deg][0], "roomEndToWorld " + deg + "° : x MONDE");
      approx(bout.y, ptAttendu[deg][1], "roomEndToWorld " + deg + "° : y MONDE");
      approx(bout.z, 3700, "roomEndToWorld " + deg + "° : z = z local + socle du niveau");
      approx(bout.n.x, nAttendue[deg][0], "roomDirToWorld " + deg + "° : normale x");
      approx(bout.n.y, nAttendue[deg][1], "roomDirToWorld " + deg + "° : normale y");
      // ⚠ LE VERROU QUI MORD sur la faute la plus probable : une normale TRANSLATÉE par l'origine de la
      // salle reste « plausible » (elle pointe encore quelque part) mais mesure des milliers de mm. Sa
      // NORME est donc le contrôle décisif, bien plus que ses composantes prises une à une.
      approx(Math.hypot(bout.n.x, bout.n.y, bout.n.z), 1, "roomDirToWorld " + deg + "° : la normale reste UNITAIRE (aucune translation)");
      approx(bout.n.z, 0, "roomDirToWorld " + deg + "° : un lacet ne bascule jamais une normale (z inchangé)");
      // ÉQUIVALENCE des deux mesures : le composite ne doit pas dériver de la primitive POINT dont il est
      // fait. Épinglé à ses seules constantes, il pourrait s'en écarter sans que rien ne rougisse.
      const pt = FloorLayout.roomToWorld(room, local);
      ck(bout.x === pt.x && bout.y === pt.y && bout.z === pt.z, "roomEndToWorld " + deg + "° : le POINT est EXACTEMENT celui de roomToWorld (une seule transformée)");
    });
    // Normale VERTICALE (face du dessus d'un équipement libre) : insensible au lacet, aux quatre orientations.
    [0, 90, 180, 270].forEach((deg) => {
      const n = FloorLayout.roomEndToWorld(salle(deg), { x: local.x, y: local.y, z: local.z, n: { x: 0, y: 0, z: 1 } }).n;
      approx(Math.hypot(n.x, n.y), 0, "roomDirToWorld " + deg + "° : normale VERTICALE non tournée (composantes horizontales nulles)");
      approx(n.z, 1, "roomDirToWorld " + deg + "° : normale VERTICALE conservée");
    });
    // Bout SANS normale → `n` nul (le tracé se passe alors d'amorce ⊥) : comportement conservé du traceur.
    ck.eq(FloorLayout.roomEndToWorld(salle(0), { x: 1, y: 2, z: 3 }).n, null, "roomEndToWorld : bout sans normale → n = null");
    ck.eq(FloorLayout.roomEndToWorld(salle(0), { x: 1, y: 2, z: 3, n: null }).n, null, "roomEndToWorld : normale explicitement nulle → n = null");
    // DISCRIMINATION (anti-vacuité) : sans elle, les assertions ci-dessus passeraient aussi si la
    // transformée était l'identité. Elle prouve que « local » et « monde » sont bien deux repères.
    const l = FloorLayout.roomEndToWorld(salle(90), { x: local.x, y: local.y, z: local.z, n: normaleAvant });
    ck(Math.hypot(l.x - local.x, l.y - local.y, l.z - local.z) > 1000, "roomEndToWorld : le point MONDE diffère franchement du point LOCAL (le détecteur n'est pas vide)");
  }
  });

  await section("CableRouting.worldLine : les BOUTS entrent DÉJÀ EN MONDE (§6.30 — parité figée sur HEAD)", async () => {
  {
    /* Lot 4 du chantier « câblage des équipements d'étage » (décision D1). `worldLine` recevait deux bouts
       en LOCAL SALLE plus la transformée de LEUR salle ; elle reçoit des `WorldEnd`. Ce lot est un REFACTOR
       À COMPORTEMENT CONSTANT : les valeurs figées ci-dessous ont été mesurées sur le code RÉGÉNÉRÉ DEPUIS
       GIT (`git show HEAD:src-client/geometry/CableRouting.ts`, avant bascule) sur EXACTEMENT cette scène,
       puis écrites EN DUR. Elles ne comparent donc pas la fonction à elle-même (piège du lot 2 du chantier
       conteneur) : elles disent ce que le tracé VALAIT avant, et il doit continuer de le valoir. */
    const s = await makeStore();
    const dcA = await s.create("datacenters", { name: "A", width_mm: 6000, depth_mm: 4000, location: "", floor: "0", floor_x: 0, floor_y: 0, floor_orientation: 90 });
    const dcB = await s.create("datacenters", { name: "B", width_mm: 5000, depth_mm: 7000, location: "", floor: "1", floor_x: 2000, floor_y: 1000, floor_orientation: 180 });
    const rkA = await s.create("racks", { name: "RA", u_count: 42, datacenter_id: dcA.id, dc_x: 1200, dc_y: 900, orientation: 0 });
    const rkB = await s.create("racks", { name: "RB", u_count: 42, datacenter_id: dcB.id, dc_x: 2500, dc_y: 3000, orientation: 270 });
    const eqA = await s.create("equipments", { name: "EA", placement_mode: "rack", rack_id: rkA.id, rack_u: 5 });
    const eqB = await s.create("equipments", { name: "EB", placement_mode: "rack", rack_id: rkB.id, rack_u: 9 });
    const pA = (await s.create("ports", { equipment_id: eqA.id, name: "pa", face_x: 0.3, face_y: 0.7, face_side: "front" })).id;
    const pB = (await s.create("ports", { equipment_id: eqB.id, name: "pb", face_x: 0.6, face_y: 0.2, face_side: "front" })).id;
    const exA = await s.create("waypoints", { wp_type: "exit", datacenter_id: dcA.id, dc_x: 100, dc_y: 200 });
    const exB = await s.create("waypoints", { wp_type: "exit", datacenter_id: dcB.id, dc_x: 300, dc_y: 400 });
    await s.create("cables", { name: "inter", from_port_id: pA, to_port_id: pB, waypoint_ids: [exA.id, exB.id] });
    const paA = await s.create("equipments", { name: "PA", type: "patch_panel", placement_mode: "rack", rack_id: rkA.id, rack_u: 20 });
    const paB = await s.create("equipments", { name: "PB", type: "patch_panel", placement_mode: "rack", rack_id: rkB.id, rack_u: 22 });
    await s.create("cableBundles", { name: "T", endpoint_a_equipment_id: paA.id, endpoint_b_equipment_id: paB.id, waypoint_ids: [exA.id, exB.id] });

    const floor = new FloorLayout(s), resolver = new Resolver3D(s);
    const routing = new CableRouting(s, resolver, floor), trunks = new TrunkRouting(s, resolver, routing);
    const m = floor.multiLayout(dcA, { visibleDcIds: new Set([dcA.id, dcB.id]) });
    const route = routing.interDcRoutes(m, true)[0], trunk = trunks.interDcTrunks(m, true)[0];
    ck(!!route && !!trunk, "scène : 1 câble ET 1 faisceau inter-salles tracés");

    const memePoint = (p, q) => p && q && p.x === q.x && p.y === q.y && p.z === q.z;
    const memeTrace = (obtenus, attendus, quoi) => {
      ck.eq(obtenus.length, attendus.length, quoi + " : nombre de points du tracé");
      ck(obtenus.every((p, i) => memePoint(p, attendus[i])), quoi + " : TOUS les points identiques à la valeur d'avant bascule");
    };
    // ---- VALEURS FIGÉES (mesurées sur le code d'avant bascule, régénéré par `git show HEAD:`) ----
    memeTrace(route.linePts, [
      { x: 3603, y: 1109.48, z: 241.135 },      // bout A monde
      { x: 3623, y: 1109.48, z: 241.135 },      // amorce ⊥ de 20 mm — c'est ELLE qui atteste de la NORMALE monde
      { x: 3800, y: 100, z: 2400 },             // exit salle A
      { x: 6700, y: 7600, z: 6266.9 },          // exit salle B (autre étage → z du niveau 1)
      { x: 5023, y: 5045.26, z: 4308.06 },      // amorce ⊥ du bout B
      { x: 5003, y: 5045.26, z: 4308.06 },      // bout B monde
    ], "câble inter-salles");
    ck.eq(JSON.stringify(Array.from(route.straight)), JSON.stringify([0, 4]), "câble : segments DROITS inchangés");
    ck.eq(JSON.stringify(Array.from(route.stubAt)), JSON.stringify([1, 4]), "câble : indices d'AMORCE inchangés");
    memeTrace(route.pts, [
      { x: 3603, y: 1109.48, z: 241.135 }, { x: 3800, y: 100, z: 2400 },
      { x: 6700, y: 7600, z: 6266.9 }, { x: 5003, y: 5045.26, z: 4308.06 },
    ], "câble : pastilles (pts)");
    memeTrace(trunk.linePts, [
      { x: 2603, y: 1200, z: 916.7750000000001 },
      { x: 2583, y: 1200, z: 916.7750000000001 },
      { x: 3800, y: 100, z: 2400 },
      { x: 6700, y: 7600, z: 6266.9 },
      { x: 3983, y: 5000, z: 4872.575 },
      { x: 4003, y: 5000, z: 4872.575 },
    ], "faisceau inter-salles");
    ck.eq(JSON.stringify(Array.from(trunk.straight)), JSON.stringify([0, 4]), "faisceau : segments DROITS inchangés");
    ck.eq(JSON.stringify(Array.from(trunk.stubAt)), JSON.stringify([1, 4]), "faisceau : indices d'AMORCE inchangés");
    // MÉCANIQUE UNIQUE câbles ⇄ faisceaux : les deux passent par le MÊME `worldLine`, donc les points de
    // PASSAGE d'une même route sont les mêmes objets géométriques. Une bascule qui n'aurait migré qu'un
    // des deux appelants romprait cette égalité.
    ck(memePoint(route.linePts[2], trunk.linePts[2]) && memePoint(route.linePts[3], trunk.linePts[3]), "worldLine PARTAGÉ : câble et faisceau traversent les MÊMES points de passage");

    // ---- ÉQUIVALENCE : le tracé monde et la résolution locale racontent la même chose ----
    // Le bout A du tracé doit valoir l'image du port LOCAL par `roomToWorld` — la primitive de point que ce
    // lot n'a PAS touchée. C'est le contrôle qui prouve que le repère n'a pas glissé, indépendamment des
    // constantes ci-dessus (deux MESURES comparées entre elles, pas chacune à un nombre écrit à la main).
    const roomA = m.rooms.find((x) => x.dc.id === dcA.id), roomB = m.rooms.find((x) => x.dc.id === dcB.id);
    const locA = resolver.resolvePort3D(pA, dcA.id), locB = resolver.resolvePort3D(pB, dcB.id);
    ck(memePoint(route.linePts[0], FloorLayout.roomToWorld(roomA, locA)), "bout A : le tracé part EXACTEMENT du port local porté au monde par SA salle");
    ck(memePoint(route.linePts[5], FloorLayout.roomToWorld(roomB, locB)), "bout B : idem pour l'autre salle (chaque bout par SON conteneur)");
    // La NORMALE monde attendue est écrite ici avec la formule que portait HEAD (différence de deux images
    // par `roomToWorld`) : l'expression a quitté le traceur, l'ATTENTE la garde.
    const w0 = FloorLayout.roomToWorld(roomA, locA);
    const w1 = FloorLayout.roomToWorld(roomA, { x: locA.x + locA.n.x, y: locA.y + locA.n.y, z: locA.z + locA.n.z });
    const nHead = { x: w1.x - w0.x, y: w1.y - w0.y, z: w1.z - w0.z };
    const nBout = FloorLayout.roomEndToWorld(roomA, locA).n;
    ck(memePoint(nBout, nHead), "normale MONDE du bout A : identique AU BIT près à la formule d'avant bascule");
    // …et cette normale est bien celle que le TRACÉ a employée : l'amorce de 20 mm part dans sa direction.
    const u = Math.hypot(nHead.x, nHead.y, nHead.z);
    const amorce = { x: route.linePts[0].x + nHead.x / u * 20, y: route.linePts[0].y + nHead.y / u * 20, z: route.linePts[0].z + nHead.z / u * 20 };
    ck(Math.hypot(route.linePts[1].x - amorce.x, route.linePts[1].y - amorce.y, route.linePts[1].z - amorce.z) < 1e-9, "amorce ⊥ : 20 mm le long de la normale MONDE du bout");

    // ---- DISCRIMINATION du REPÈRE (ce que le type `WorldEnd` empêche à la compilation) ----
    // Le typage refuse désormais un point LOCAL là où `worldLine` attend du MONDE ; à l'exécution les types
    // sont effacés, donc on peut MESURER ce que coûterait la confusion. Sans cet écart, le marqueur de
    // repère garderait quelque chose d'inoffensif — et ne mériterait pas son coût.
    const enLocal = routing.worldLine(m, new Map(m.rooms.map((r) => [r.dc.id, r])), locA, locB, s.cableRoute(s.all("cables")[0]).steps, "sonde", true);
    ck(Math.hypot(enLocal.linePts[0].x - route.linePts[0].x, enLocal.linePts[0].y - route.linePts[0].y, enLocal.linePts[0].z - route.linePts[0].z) > 1000, "repère : un bout LOCAL passé au tracé déplacerait le câble de plus d'un mètre (le marqueur `WorldEnd` garde un écart RÉEL)");
  }
  });

  await section("Tracé : un câble BAIE → ÉQUIPEMENT D'ÉTAGE est enfin DESSINÉ (§6.31, décision D3)", async () => {
  {
    /* Lot 5 du chantier « câblage des équipements d'étage ». §6.30 avait retiré la dépendance « salle » du
       TRACEUR sans rien débloquer : `interDcRoutes` se fermait toujours sur `r.dcA`/`r.dcB`, que l'analyseur
       n'exprimait qu'en salles. La grammaire parlant conteneurs, la garde lit `containerA`/`containerB` et
       le bout d'étage est porté au monde par SON conteneur. C'est la mesure qui prouve la LIVRAISON. */
    const s = await makeStore();
    const site = await s.create("sites", { name: "Liège" });
    const dcA = await s.create("datacenters", { name: "A", width_mm: 6000, depth_mm: 4000, location: site.id, floor: "1", floor_x: 0, floor_y: 0 });
    const rkA = await s.create("racks", { name: "RA", u_count: 42, datacenter_id: dcA.id, dc_x: 1200, dc_y: 900, orientation: 0 });
    const eqA = await s.create("equipments", { name: "EA", placement_mode: "rack", rack_id: rkA.id, rack_u: 5 });
    const pA = (await s.create("ports", { equipment_id: eqA.id, name: "pa", face_x: 0.3, face_y: 0.7, face_side: "front" })).id;
    // POSÉ D'ÉTAGE : même bâtiment, même étage que la salle → son plan d'étage est émis par le layout.
    const eqF = await s.create("equipments", { name: "EF", placement_mode: "floor", location: site.id, floor: "1", floor_x: 3000, floor_y: 2500, dc_z: 250, width_mm: 400, height_mm: 300, depth_mm: 200 });
    const pF = (await s.create("ports", { equipment_id: eqF.id, name: "pf", face_x: 0.5, face_y: 0.5, face_side: "front" })).id;
    const exA = await s.create("waypoints", { name: "sortieA", wp_type: "exit", datacenter_id: dcA.id, dc_x: 100, dc_y: 200 });
    const pin = await s.create("waypoints", { name: "gaine", wp_type: "oob", location: site.id, floor: "1", floor_x: 2500, floor_y: 2500 });
    const cable = await s.create("cables", { name: "baie→étage", from_port_id: pA, to_port_id: pF, waypoint_ids: [exA.id, pin.id] });

    const floor = new FloorLayout(s), resolver = new Resolver3D(s);
    const routing = new CableRouting(s, resolver, floor);
    const m = floor.multiLayout(dcA, { visibleDcIds: new Set([dcA.id]) });

    const r = s.cableRoute(cable);
    ck(r.valid && r.hasExits, "grammaire : la route baie → pin d'étage est VALIDE avec sortie");
    ck.eq(JSON.stringify(r.containerB), JSON.stringify(PlacementContainers.floorOf(site.id, "1")), "…et son bout B est le conteneur ÉTAGE");

    const traces = routing.interDcRoutes(m, true);
    ck.eq(traces.length, 1, "interDcRoutes : le câble baie → posé d'étage est TRACÉ (avant ce lot : aucun)");
    const t = traces[0];
    ck(t.linePts.length >= 4 && t.linePts.every((p) => isFinite(p.x) && isFinite(p.y) && isFinite(p.z)), "…points monde finis, amorces comprises");
    /* ÉQUIVALENCE (deux mesures comparées entre elles, pas à une constante) : le bout d'étage du tracé doit
       valoir EXACTEMENT le port résolu en monde depuis l'origine du posé — la source unique §6.27. */
    const o = floor.equipFloorOrigin(m, s.get("equipments", eqF.id));
    const attendu = resolver.resolvePortWorld3D(pF, o.x, o.y, o.baseZ);
    const dernier = t.linePts[t.linePts.length - 1];
    ck(dernier.x === attendu.x && dernier.y === attendu.y && dernier.z === attendu.z, "bout d'étage : le tracé finit EXACTEMENT sur le port résolu en monde (origine = equipFloorOrigin)");
    // …et le bout de SALLE reste porté par la transformée de sa salle (rien n'a bougé de ce côté).
    const roomA = m.rooms.find((x) => x.dc.id === dcA.id), locA = resolver.resolvePort3D(pA, dcA.id);
    const w0 = FloorLayout.roomToWorld(roomA, locA);
    ck(t.linePts[0].x === w0.x && t.linePts[0].y === w0.y && t.linePts[0].z === w0.z, "bout de salle : inchangé — chaque bout est porté par SON conteneur");

    /* D3 — un ÉTAGE est un conteneur AFFICHABLE : masqué, le câble disparaît, comme pour une salle. Un
       bâtiment dont aucune salle n'est affichée ne voit pas son plan d'étage émis (filtre `shownFloors`). */
    const site2 = await s.create("sites", { name: "Namur" });
    const eqF2 = await s.create("equipments", { name: "EF2", placement_mode: "floor", location: site2.id, floor: "0", floor_x: 1000, floor_y: 1000, width_mm: 400, height_mm: 300, depth_mm: 200 });
    const pF2 = (await s.create("ports", { equipment_id: eqF2.id, name: "pf2", face_x: 0.5, face_y: 0.5, face_side: "front" })).id;
    const pin2 = await s.create("waypoints", { name: "gaine2", wp_type: "oob", location: site2.id, floor: "0", floor_x: 900, floor_y: 900 });
    const eqA2 = await s.create("equipments", { name: "EA2", placement_mode: "rack", rack_id: rkA.id, rack_u: 9 });
    const pA2 = (await s.create("ports", { equipment_id: eqA2.id, name: "pa2", face_x: 0.3, face_y: 0.7, face_side: "front" })).id;
    await s.create("cables", { name: "baie→autre bâtiment", from_port_id: pA2, to_port_id: pF2, waypoint_ids: [exA.id, pin2.id] });
    const rHors = s.cableRoute(s.get("cables", s.all("cables").find((c) => c.name === "baie→autre bâtiment").id));
    ck(rHors.valid && rHors.hasExits, "route vers un posé d'un AUTRE bâtiment : grammaticalement valide");
    const m2 = floor.multiLayout(dcA, { visibleDcIds: new Set([dcA.id]) });
    ck.eq(FloorLayout.floorShown(m2, site2.id, "0"), false, "portée : l'étage de l'autre bâtiment n'est PAS affiché (aucune salle ne l'y fait entrer)");
    ck.eq(routing.interDcRoutes(m2, true).length, 1, "D3 : seul le câble dont l'étage est AFFICHÉ est tracé — l'autre disparaît, comme pour une salle masquée");
    ck.eq(FloorLayout.floorShown(m2, site.id, "1"), true, "…et l'étage de la salle affichée, lui, est bien émis");
    /* La garde OUVRE aussi bien qu'elle FERME : une salle du second bâtiment entre dans la portée, son plan
       d'étage est émis, et le câble apparaît. Deux mesures comparées entre elles (« affiché ? » ⇄ « tracé ? »)
       plutôt qu'un seul décompte épinglé à une constante. */
    const dcN = await s.create("datacenters", { name: "N", width_mm: 3000, depth_mm: 3000, location: site2.id, floor: "0", floor_x: 0, floor_y: 0 });
    const m3 = floor.multiLayout(dcA, { visibleDcIds: new Set([dcA.id, dcN.id]) });
    ck.eq(FloorLayout.floorShown(m3, site2.id, "0"), true, "portée élargie : l'étage de l'autre bâtiment devient AFFICHÉ");
    ck.eq(routing.interDcRoutes(m3, true).length, 2, "…et le second câble est alors tracé (la garde ouvre comme elle ferme)");
  }
  });

  await section("Positioning : aide au positionnement (cœur pur — coins, cotes ⟂, placement, accrochage)", async () => {
  {
    const approx = (a, b, name, eps) => ck(Math.abs(a - b) <= (eps || 1e-6), name + "  (attendu ≈" + b + ", obtenu " + a + ")");
    const frame = { w: 6000, h: 4000 };
    // rack 600×1000 centré en (1000,1000), orientation 0 → hx=300, hy=500
    const A = { cx: 1000, cy: 1000, hx: 300, hy: 500 };
    const cA = Positioning.corners(A);
    ck.eq(JSON.stringify(cA.TL), JSON.stringify({ x: 700, y: 500 }), "corners TL = (cx−hx, cy−hy)");
    ck.eq(JSON.stringify(cA.BR), JSON.stringify({ x: 1300, y: 1500 }), "corners BR = (cx+hx, cy+hy)");
    // murs
    ck.eq(JSON.stringify(Positioning.wallLine(frame, "left")), JSON.stringify({ axis: "x", value: 0 }), "wallLine left → x=0");
    ck.eq(JSON.stringify(Positioning.wallLine(frame, "bottom")), JSON.stringify({ axis: "y", value: 4000 }), "wallLine bottom → y=h");
    // distance ⟂ d'un coin au mur gauche
    approx(Positioning.distance(cA.TL, { kind: "wall", wall: "left" }, "x", frame, {}), 700, "distance TL → mur gauche = 700");
    // un mur horizontal ne porte pas l'axe x
    ck.eq(Positioning.distance(cA.TL, { kind: "wall", wall: "top" }, "x", frame, {}), null, "mur top ne porte pas l'axe x → null");
    // cote ⟂ : segment porté par l'axe (de la référence jusqu'au coin)
    const coteX = Positioning.cote(cA.TL, { kind: "wall", wall: "left" }, "x", frame, {});
    ck(coteX && coteX.from.x === 0 && coteX.from.y === cA.TL.y && coteX.to.x === cA.TL.x, "cote ⟂ mur gauche : segment horizontal jusqu'au coin");
    // placement : coin TL du mover à 500 mm du mur gauche → cx tel que (cx−hx)=500 → cx=800
    const nx = Positioning.placeAxis(A, "TL", "x", { kind: "wall", wall: "left" }, 500, frame, {});
    approx(nx, 800, "placeAxis : TL à 500 du mur gauche → cx=800");
    // côté CONSERVÉ : le coin reste à droite du mur (pas de saut), valeur négative traitée en abs
    const nx2 = Positioning.placeAxis(A, "TL", "x", { kind: "wall", wall: "left" }, -500, frame, {});
    approx(nx2, 800, "placeAxis : |valeur| utilisée, côté conservé");
    // référence COIN d'un autre rect (ancre) : B centré (3000,1000), hx=300 → BL.x = 2700
    const B = { cx: 3000, cy: 1000, hx: 300, hy: 500 };
    const rects = { rb: B };
    approx(Positioning.refValue({ kind: "corner", rectId: "rb", corner: "BL" }, "x", frame, rects), 2700, "refValue coin BL de B sur x = 2700");
    // placer le coin TR de A à 100 mm à GAUCHE du coin BL de B (A est à gauche → côté conservé) :
    // coin TR cible = 2700 − 100 = 2600 ; cx = 2600 − hx = 2300
    const nx3 = Positioning.placeAxis(A, "TR", "x", { kind: "corner", rectId: "rb", corner: "BL" }, 100, frame, rects);
    approx(nx3, 2300, "placeAxis : TR de A à 100 du coin BL de B (côté gauche) → cx=2300");
    // ACCROCHAGE : centre candidat dont un bord est à 5 mm d'un mur → accroché (tol 9)
    const snapped = Positioning.snapCenter(A, 305, 1000, frame, [A], 0, 9);   // bord gauche = 305−300 = 5 ⟶ mur 0
    approx(snapped.cx, 300, "snapCenter : bord gauche accroché au mur 0 (cx=300)");
    ck.eq(snapped.snapX, 0, "snapCenter : ligne X accrochée = mur 0");
    // hors tolérance → pas d'accrochage
    const noSnap = Positioning.snapCenter(A, 400, 1000, frame, [A], 0, 9);
    ck.eq(noSnap.snapX, null, "snapCenter : hors tolérance → aucun accrochage X");
    // accrochage à un BORD d'un autre rect (alignement de coins). Cas NON ambigu : C (hx=200) → bords 2800/3200 ;
    // candidat cx=3103 → bord gauche 2803 ≈ 2800 ; bord droit 3403 loin de tout → seul le bord gauche s'aligne.
    const C = { cx: 3000, cy: 1000, hx: 200, hy: 500 };
    const snapAlign = Positioning.snapCenter(A, 3103, 1000, frame, [A, C], 0, 9);
    approx(snapAlign.cx, 3100, "snapCenter : bord gauche de A aligné sur le bord gauche de C");
    ck.eq(snapAlign.snapX, 2800, "snapCenter : ligne accrochée = bord gauche de C (2800)");
    // accrochage DÉTERMINISTE à égalité : bord équidistant du mur 0 ET d'un bord de rect → la 1re ligne (mur) gagne.
    const D = { cx: 300, cy: 1000, hx: 200, hy: 500 };   // bord gauche de D = 100
    const tie = Positioning.snapCenter(A, 350, 1000, frame, [A, D], 0, 60);   // bord gauche = 50 : à 50 du mur 0 ET du bord 100
    ck.eq(tie.snapX, 0, "snapCenter : égalité mur/bord → le mur (1re ligne) l'emporte (déterministe)");
    approx(tie.cx, 300, "snapCenter : accroché au mur 0 (cx=300)");
    // orientation 90 : hx/hy permutés en amont (responsabilité de la couche vue) — on vérifie juste le calcul de coins
    const R90 = { cx: 0, cy: 0, hx: 500, hy: 300 };   // ex. rack 600×1000 tourné à 90°
    ck.eq(JSON.stringify(Positioning.corners(R90).TR), JSON.stringify({ x: 500, y: -300 }), "corners d'un rect permuté (orientation 90 en amont)");
  }
  });

  await section("DoorGeometry : portes de salle (ouverture, listel, passage libre, débattement)", async () => {
  {
    const approx = (a, b, name, eps) => ck(Math.abs(a - b) <= (eps || 1e-6), name + "  (attendu ≈" + b + ", obtenu " + a + ")");
    const room = { w: 6000, h: 4000 };
    // porte mur HAUT, 900 mm, listel 40, charnière gauche, ouvre vers l'intérieur, centrée à x=2000
    const d = { wall: "top", offset: 2000, width_mm: 900, frame_mm: 40, hinge: "left", opening: "interior" };
    const g = DoorGeometry.geom(d, room);
    ck.eq(JSON.stringify(g.a), JSON.stringify({ x: 1550, y: 0 }), "ouverture a = (offset−w/2, 0)");
    ck.eq(JSON.stringify(g.b), JSON.stringify({ x: 2450, y: 0 }), "ouverture b = (offset+w/2, 0)");
    approx(g.clear, 820, "passage libre = width − 2·listel");
    // charnière côté GAUCHE de l'observateur intérieur regardant le mur → extrémité +x (cf. convention)
    ck.eq(JSON.stringify(g.hinge), JSON.stringify({ x: 2450, y: 0 }), "charnière (gauche, intérieur, mur haut) → +x");
    ck.eq(JSON.stringify(g.leafOpen), JSON.stringify({ x: 2410, y: 820 }), "vantail ouvert 90° → vers l'intérieur (+y), longueur = passage");
    // ouvre vers l'EXTÉRIEUR → le vantail balaie de l'autre côté (y négatif)
    const gExt = DoorGeometry.geom({ ...d, opening: "exterior" }, room);
    ck(gExt.leafOpen.y < 0, "ouverture extérieure → vantail vers y négatif (hors salle)");
    // charnière DROITE → l'autre extrémité
    const gR = DoorGeometry.geom({ ...d, hinge: "right" }, room);
    ck.eq(JSON.stringify(gR.hinge), JSON.stringify({ x: 1550, y: 0 }), "charnière droite → extrémité opposée");
    // bornage de l'offset : trop près du coin → ramené à w/2
    ck.eq(DoorGeometry.clampOffset({ wall: "top", offset: 100, width_mm: 900 }, room), 450, "clampOffset : borné à w/2 du coin");
    ck.eq(DoorGeometry.wallLen("left", room), 4000, "wallLen(left) = profondeur");
    ck.eq(DoorGeometry.wallLen("top", room), 6000, "wallLen(top) = largeur");
    // arc de débattement : 15 points, du vantail fermé (clearLatch) à l'ouvert (leafOpen) — via la chaîne
    // VIVANTE leaves()→leafArc() (l'ancien wrapper mono-vantail arcPoints a été supprimé, code mort).
    const arc = DoorGeometry.leafArc(DoorGeometry.leaves(g, d)[0], 14);
    ck.eq(arc.length, 15, "leafArc : n+1 points");
    approx(arc[0].x, g.clearLatch.x, "arc démarre au vantail FERMÉ (x)");
    approx(arc[0].y, g.clearLatch.y, "arc démarre au vantail FERMÉ (y)");
    approx(arc[14].x, g.leafOpen.x, "arc finit au vantail OUVERT (x)", 1e-6);
    approx(arc[14].y, g.leafOpen.y, "arc finit au vantail OUVERT (y)", 1e-6);
    // VANTAUX : simple → 1 vantail pleine largeur ; DOUBLE BATTANT → 2 demi-vantaux, charnières aux 2 extrémités,
    // loquets au CENTRE, chacun balayant clear/2. `hinge` sans effet en double (symétrique).
    const one = DoorGeometry.leaves(g, d);
    ck.eq(one.length, 1, "leaves(simple) : 1 vantail");
    ck.eq(JSON.stringify(one[0].hinge), JSON.stringify(g.clearHinge), "leaves(simple) : charnière = clearHinge");
    ck.eq(JSON.stringify(one[0].open), JSON.stringify(g.leafOpen), "leaves(simple) : ouvert = leafOpen");
    const two = DoorGeometry.leaves(g, { ...d, leaves: 2 });
    ck.eq(two.length, 2, "leaves(double) : 2 vantaux");
    approx(Math.hypot(two[0].latch.x - two[0].hinge.x, two[0].latch.y - two[0].hinge.y), g.clear / 2, "double : vantail 1 = clear/2");
    approx(Math.hypot(two[1].latch.x - two[1].hinge.x, two[1].latch.y - two[1].hinge.y), g.clear / 2, "double : vantail 2 = clear/2");
    ck.eq(JSON.stringify(two[0].latch), JSON.stringify(two[1].latch), "double : les loquets se rejoignent au CENTRE");
    approx(two[0].latch.x, (g.clearHinge.x + g.clearLatch.x) / 2, "double : joint au milieu du passage (x)");
    ck(two[0].open.y > 0 && two[1].open.y > 0, "double intérieur : les 2 vantaux balaient vers l'intérieur (+y)");
    const arcL = DoorGeometry.leafArc(two[0], 10);
    approx(arcL[0].x, two[0].latch.x, "leafArc démarre au vantail FERMÉ (loquet)");
    approx(arcL[10].x, two[0].open.x, "leafArc finit au vantail OUVERT", 1e-6);
    // porte sur mur GAUCHE : ouverture le long de y
    const dl = { wall: "left", offset: 2000, width_mm: 1000, frame_mm: 50, hinge: "left", opening: "interior" };
    const gl = DoorGeometry.geom(dl, room);
    ck.eq(JSON.stringify(gl.a), JSON.stringify({ x: 0, y: 1500 }), "mur gauche : ouverture le long de y");
    ck(Math.abs(gl.leafOpen.x - gl.clear) < 1e-6, "mur gauche intérieur : vantail balaie vers +x (dans la salle)");
    // listel borné à [0, demi-largeur] et réutilisé partout (clear + inset des extrémités du passage)
    const gNeg = DoorGeometry.geom({ ...d, frame_mm: -30 }, room);   // frame négatif → 0
    approx(gNeg.clear, 900, "listel négatif → borné à 0 (passage = pleine largeur)");
    ck.eq(JSON.stringify(gNeg.clearHinge), JSON.stringify(gNeg.hinge), "listel négatif → aucun inset (clearHinge = hinge)");
    const gBig = DoorGeometry.geom({ ...d, frame_mm: 999999 }, room);   // frame > w/2 (=450)
    approx(gBig.clear, 0, "listel > demi-largeur → passage borné à 0 (jamais négatif)");
    approx(Math.hypot(gBig.clearHinge.x - g.hinge.x, gBig.clearHinge.y - g.hinge.y), 450, "listel surdimensionné borné à la demi-largeur (extrémités non croisées)");
    // mur BAS (y=h) : ouverture le long de x, charnière/vantail vers l'INTÉRIEUR (y décroît) — couvre la branche `bottom`
    const db = { wall: "bottom", offset: 2000, width_mm: 900, frame_mm: 40, hinge: "left", opening: "interior" };
    const gb = DoorGeometry.geom(db, room);
    ck.eq(JSON.stringify(gb.hinge), JSON.stringify({ x: 1550, y: 4000 }), "mur bas, charnière gauche intérieur → extrémité −x");
    ck.eq(JSON.stringify(gb.leafOpen), JSON.stringify({ x: 1590, y: 3180 }), "mur bas intérieur : vantail vers l'intérieur (y décroît)");
    ck.eq(JSON.stringify(DoorGeometry.geom({ ...db, hinge: "right" }, room).hinge), JSON.stringify({ x: 2450, y: 4000 }), "mur bas, charnière droite → extrémité opposée");
    // mur DROIT (x=w) : ouverture le long de y — couvre la branche `right` (normale, charnière, signe de l'arc)
    const dr = { wall: "right", offset: 2000, width_mm: 1000, frame_mm: 50, hinge: "left", opening: "interior" };
    const gr2 = DoorGeometry.geom(dr, room);
    ck.eq(JSON.stringify(gr2.hinge), JSON.stringify({ x: 6000, y: 2500 }), "mur droit, charnière gauche intérieur → extrémité +y");
    ck.eq(JSON.stringify(gr2.leafOpen), JSON.stringify({ x: 5100, y: 2450 }), "mur droit intérieur : vantail vers l'intérieur (x décroît)");
    ck(DoorGeometry.geom({ ...dr, opening: "exterior" }, room).leafOpen.x > 6000, "mur droit extérieur : vantail hors salle (x > w)");
    // arc sur mur droit : couvre le `sign` de rotation hors du seul cas « mur haut »
    const arcR = DoorGeometry.leafArc(DoorGeometry.leaves(gr2, dr)[0], 8);
    approx(arcR[0].x, gr2.clearLatch.x, "arc mur droit démarre au vantail FERMÉ (x)");
    approx(arcR[0].y, gr2.clearLatch.y, "arc mur droit démarre au vantail FERMÉ (y)");
    approx(arcR[8].x, gr2.leafOpen.x, "arc mur droit finit au vantail OUVERT (x)");
    approx(arcR[8].y, gr2.leafOpen.y, "arc mur droit finit au vantail OUVERT (y)");
  }
  });

  await section("Measure : géométrie pure de mesure (longueur segment · total polyligne, 3D)", async () => {
  {
    ck.eq(Measure.dist({ x: 0, y: 0 }, { x: 3, y: 4 }), 5, "dist : 3-4-5 en 2D (z absent → 0)");
    ck.eq(Measure.dist({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }), 2, "dist : composante z prise en compte");
    ck.eq(Measure.total([{ x: 0, y: 0 }]), 0, "total : < 2 points → 0");
    ck.eq(Measure.total([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 4 }]), 5, "total : somme des segments (dernier nul)");
    ck.eq(Measure.total([{ x: 0, y: 0 }, { x: 0, y: 4 }, { x: 3, y: 4 }]), 7, "total : polyligne 4 + 3 = 7");
    ck.eq(Measure.centroid([]), null, "centroid : nuage vide → null");
    ck.eq(JSON.stringify(Measure.centroid([{ x: 0, y: 0, z: 0 }, { x: 4, y: 2, z: 0 }])), JSON.stringify({ x: 2, y: 1, z: 0 }), "centroid : moyenne des points");
    ck.eq(Measure.centroid([{ x: 3, y: 3 }]).z, 0, "centroid : z absent → 0");
  }
  });

  await section("CableSpline : échantillonnage pur du spline de câble (droit / courbe / amorces)", async () => {
  {
    const A = { x: 0, y: 0, z: 0 }, B = { x: 100, y: 0, z: 0 };
    // < 2 points → renvoyé tel quel (copie)
    ck.eq(CableSpline.sample([{ x: 1, y: 2, z: 3 }], new Set(), 0.25).length, 1, "sample : < 2 points → inchangé");
    // segment DROIT (index 0 dans `straight`) → 2 points, aux extrémités
    const straight = CableSpline.sample([A, B], new Set([0]), 0.25);
    ck.eq(JSON.stringify(straight), JSON.stringify([A, B]), "sample : segment droit → 2 points inchangés");
    // segment COURBE → densifié, commence à A, finit à B
    const curve = CableSpline.sample([A, B], new Set(), 0.25);
    ck(curve.length > 2, "sample : segment courbe → densifié (> 2 points)");
    ck.eq(JSON.stringify(curve[0]), JSON.stringify(A), "sample : commence exactement à P0");
    const last = curve[curve.length - 1];
    ck(Math.abs(last.x - 100) < 1e-6 && Math.abs(last.y) < 1e-6 && Math.abs(last.z) < 1e-6, "sample : finit exactement à P1");
    // 3 points ALIGNÉS sur l'axe x, courbes → la courbe reste sur l'axe (y=z=0)
    const collinear = CableSpline.sample([A, { x: 50, y: 0, z: 0 }, B], new Set(), 0.25);
    ck(collinear.every((p) => Math.abs(p.y) < 1e-6 && Math.abs(p.z) < 1e-6), "sample : points alignés → courbe reste sur l'axe");
  }
  });

  await section("CableSpline.controls : tangentes PARTAGÉES 2D/3D (path SVG ⇄ échantillonnage)", async () => {
  {
    const k = 1 / 6;
    // segment droit → null (chorde) ; intérieur → Catmull-Rom (P[i+1]−P[i−1])·k
    const P = [[0, 0], [100, 0], [200, 100], [300, 100]];
    const cs = CableSpline.controls(P, new Set([0]), k);
    ck.eq(cs[0], null, "segment droit → pas de contrôles (chorde)");
    ck(!!cs[1] && Math.abs(cs[1].c1[0] - (100 + (200 - 0) * k)) < 1e-9, "intérieur : C1 = P + (P[i+1]−P[i−1])·k (Catmull-Rom)");
    // amorce ⟂ : la tangente au point d'amorce est ALIGNÉE sur l'axe du segment droit adjacent (G1)
    const P2 = [[0, 0], [0, 20], [150, 220]];   // segment 0 droit vertical, amorce au point 1
    const c2 = CableSpline.controls(P2, new Set([0]), k, new Set([1]));
    ck(!!c2[1] && Math.abs(c2[1].c1[0] - 0) < 1e-9 && c2[1].c1[1] > 20, "amorce : C1 part le long de l'axe du segment droit (x inchangé)");
    // PARITÉ 3D : sample() consomme les mêmes contrôles — un point échantillonné juste après l'amorce reste sur l'axe
    const P3 = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 20, z: 0 }, { x: 150, y: 220, z: 0 }];
    const line = CableSpline.sample(P3, new Set([0]), k, new Set([1]));
    const justAfter = line[2];   // 1er point de la courbe après le point d'amorce
    ck(Math.abs(justAfter.x) < 2, "parité 3D : la courbe part de l'amorce le long de l'axe (x ≈ 0)");
  }
  });

  await section("GraphGeometry : disposition force-directed (extraite de GraphView, déterministe)", async () => {
  {
    const mkN = (id) => ({ id, name: id, type: "", x: 0, y: 0, vx: 0, vy: 0 });
    // nœud isolé : centré à l'origine par la simulation, puis ancré ≥ 0 par le packing
    const solo = [mkN("s")];
    GraphGeometry.forceLayout(solo, [], 900, 560);
    ck(isFinite(solo[0].x) && isFinite(solo[0].y), "nœud isolé : position finie");
    // paire connectée : les deux nœuds s'écartent (répulsion) mais restent liés (attraction) — distance saine
    const pair = [mkN("a"), mkN("b")];
    GraphGeometry.forceLayout(pair, [{ a: "a", b: "b" }], 900, 560);
    const d = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
    ck(d > 10 && d < 3000, "paire connectée : distance d'équilibre saine (" + Math.round(d) + " px)");
    // DÉTERMINISME : mêmes entrées → même disposition (aucune source aléatoire)
    const pair2 = [mkN("a"), mkN("b")];
    GraphGeometry.forceLayout(pair2, [{ a: "a", b: "b" }], 900, 560);
    ck(Math.abs(pair[0].x - pair2[0].x) < 1e-9 && Math.abs(pair[1].y - pair2[1].y) < 1e-9, "déterministe : deux exécutions identiques");
    // packing : le composant principal est ANCRÉ à l'origine (bbox min ≈ 0), le satellite rangé DESSOUS
    const nodes = [mkN("m1"), mkN("m2"), mkN("m3"), mkN("iso")];
    GraphGeometry.forceLayout(nodes, [{ a: "m1", b: "m2" }, { a: "m2", b: "m3" }], 900, 560);
    const main = nodes.slice(0, 3), iso = nodes[3];
    const bb = GraphGeometry.nodesBBox(main, () => 24);
    ck(bb.minX > -1 && bb.minY > -1, "packing : composant principal ancré à l'origine");
    ck(iso.y > bb.maxY, "packing : le composant satellite est rangé SOUS le principal");
    // placement des nœuds sans position : en grille sous le centroïde des nœuds placés
    const placed = [{ id: "p1", x: 100, y: 100, vx: 0, vy: 0 }, { id: "p2", x: 300, y: 100, vx: 0, vy: 0 }];
    const missing = [mkN("x1"), mkN("x2")];
    GraphGeometry.placeMissingNearCentroid(missing, placed, 450, 280);
    ck(missing.every((n) => n.y === 220) && missing[0].x < missing[1].x, "nœuds manquants : grille sous le centroïde (y = 100 + 120)");
  }
  });

  await section("Homography : redressement de perspective (DLT, ratio, rééchantillonnage)", async () => {
  {
    // IDENTITÉ : carré unité → lui-même ; H (défini à un facteur près) doit appliquer l'identité.
    const sq = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const hId = Homography.solve(sq, sq);
    const [ix, iy] = Homography.apply(hId, 0.3, 0.7);
    ck(Math.abs(ix - 0.3) < 1e-6 && Math.abs(iy - 0.7) < 1e-6, "identité : apply(H, p) = p");
    // TRANSFORMATION CONNUE : carré unité → quad quelconque ; les 4 coins doivent tomber exactement.
    const quad = [[10, 20], [110, 30], [120, 140], [5, 120]];
    const hQ = Homography.solve(sq, quad);
    const ok4 = sq.every((s, i) => { const [x, y] = Homography.apply(hQ, s[0], s[1]); return Math.hypot(x - quad[i][0], y - quad[i][1]) < 1e-4; });
    ck(ok4, "solve : les 4 correspondances sont satisfaites exactement");
    // SUR-DÉTERMINATION (points de bord) : 8 correspondances cohérentes → même homographie (moindres carrés).
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const src8 = sq.concat([mid(sq[0], sq[1]), mid(sq[1], sq[2]), mid(sq[2], sq[3]), mid(sq[3], sq[0])]);
    const dst8 = src8.map((p) => Homography.apply(hQ, p[0], p[1]));
    const h8 = Homography.solve(src8, dst8);
    const [mx, my] = Homography.apply(h8, 0.5, 0.5);
    const [ex, ey] = Homography.apply(hQ, 0.5, 0.5);
    ck(Math.hypot(mx - ex, my - ey) < 1e-4, "moindres carrés : 8 points cohérents → même transformation");
    // RATIO — vue FRONTALE (bords dans le plan image) : ratio EXACT sans focale.
    const rect = [[100, 100], [500, 100], [500, 300], [100, 300]];   // 400 × 200 centré dans une image 600×400
    ck(Math.abs(Homography.estimateAspect(rect, 600, 400) - 2) < 1e-9, "estimateAspect : vue frontale → ratio exact 2");
    // RATIO — perspective à DEUX points de fuite : rectangle 3D 2:1 tourné (Rx·Ry), caméra sténopé
    // f = 800 / centre optique au centre de l'image → la méthode de Zhang doit être EXACTE.
    const W = 1200, Hh = 900, f = 800, rx = 0.4, ry = 0.5, dist = 5;
    const proj = (X, Y) => {
      let x = X, y = Y, z = 0;
      [x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];   // rotation Y
      [y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];    // rotation X
      z += dist;
      return [W / 2 + (f * x) / z, Hh / 2 + (f * y) / z];
    };
    const persp = [proj(-1, -0.5), proj(1, -0.5), proj(1, 0.5), proj(-1, 0.5)];   // [TL,TR,BR,BL] d'un rectangle 2×1
    const r = Homography.estimateAspect(persp, W, Hh);
    ck(Math.abs(r - 2) < 1e-3, "estimateAspect : deux points de fuite → ratio exact ≈ 2 (obtenu " + r.toFixed(5) + ")");
    // RATIO — UN SEUL point de fuite (bascule autour du seul axe X : bords horizontaux fronto-parallèles) :
    // focale non estimable (dégénéré) → REPLI côtés opposés, fini et plausible (l'exactitude n'est pas atteignable).
    const proj1 = (X, Y) => { const y = Y * Math.cos(0.5), z = dist + Y * Math.sin(0.5); return [W / 2 + (f * X) / z, Hh / 2 + (f * y) / z]; };
    const one = [proj1(-1, -0.5), proj1(1, -0.5), proj1(1, 0.5), proj1(-1, 0.5)];
    const r1 = Homography.estimateAspect(one, W, Hh);
    ck(isFinite(r1) && r1 > 1.5 && r1 < 3, "estimateAspect : un point de fuite → repli fini et plausible (obtenu " + r1.toFixed(3) + ")");
    // WARP — identité : image 2×2 recopiée à l'identique (H sortie→source = identité).
    const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
    const out = Homography.warpBilinear({ data: px, width: 2, height: 2 }, [1, 0, 0, 0, 1, 0, 0, 0, 1], 2, 2);
    ck(out.data[0] === 255 && out.data[1] === 0 && out.data[3] === 255, "warp identité : pixel (0,0) recopié");
    // WARP — hors source : antécédent hors image → pixel transparent (alpha 0).
    const far = Homography.warpBilinear({ data: px, width: 2, height: 2 }, [1, 0, 100, 0, 1, 100, 0, 0, 1], 2, 2);
    ck(far.data[3] === 0, "warp hors source : alpha 0 (transparent)");
    // INVERSE : h⁻¹∘h = identité (aller-retour sur plusieurs points) — sert au recadrage séparé
    const hInv = Homography.invert(hQ);
    const okInv = hInv && [[0.2, 0.3], [0.9, 0.1], [0.5, 0.8]].every(([x, y]) => {
      const [fx, fy] = Homography.apply(hQ, x, y); const [bx, by] = Homography.apply(hInv, fx, fy);
      return Math.hypot(bx - x, by - y) < 1e-6;
    });
    ck(!!okInv, "invert : aller-retour h⁻¹∘h = identité");
    ck.eq(Homography.invert([1, 2, 3, 2, 4, 6, 0, 0, 0]), null, "invert : matrice dégénérée → null");
  }
  });

  await section("TrayFrame : l'ÉTAGÈRE est un CONTENEUR — plateau → baie (doctrine §6.23)", async () => {
  {
    // Le transport plateau → baie était écrit à la main dans `RackGeometry.trayEquipBoxLocal`, et la règle
    // « une étagère arrière retourne ses contenus » RE-DÉRIVÉE dans QUATRE sites (`RackGeometry`,
    // `Resolver3D`, `DcThreeScene.buildRackTrays` et `.buildRackPorts`). Les attentes ci-dessous sont
    // EXPLICITES — dérivées du modèle à la main — et non une comparaison à l'ancienne fonction : celle-ci
    // n'existe plus, la comparer à elle-même resterait verte sans rien prouver (doctrine §4.1).
    // La parité a été prouvée AVANT bascule contre l'ancien corps RÉGÉNÉRÉ depuis git : 2 488 320 cas /
    // 22 394 880 comparaisons BIT POUR BIT ; sur un balayage de valeurs délibérément non représentables,
    // seules les bornes HAUTES x1/y1 bougent, d'au plus 1,14·10⁻¹³ mm (ré-association d'une somme
    // flottante — l'ancien code faisait `x1 = x0 + largeur`, le conteneur transporte la borne elle-même).

    // Repère PLATEAU → repère BAIE : translation, plus ROTATION DE 180° si l'étagère est arrière —
    // les DEUX axes se retournent ensemble (décision utilisateur, §6.24). Plateau utilisable large de
    // 100 : l'origine d'une étagère arrière est donc son bord DROIT, à −100 + 100 = 0.
    const avant = { originX: -100, originY: -400, dir: 1, plankZ: 50 };
    const arriere = { originX: 0, originY: 400, dir: -1, plankZ: 50 };
    const rect = { x0: 10, x1: 60, y0: 5, y1: 35 };

    const rAv = TrayFrame.rectToRack(avant, rect);
    ck(rAv.x0 === -90 && rAv.x1 === -40, "étagère AVANT : x translaté du bord utilisable (−100 + 10 / + 60)");
    ck(rAv.y0 === -395 && rAv.y1 === -365, "étagère AVANT : les profondeurs s'enfoncent vers les +Y depuis la face");

    const rAr = TrayFrame.rectToRack(arriere, rect);
    ck(rAr.x0 === -60 && rAr.x1 === -10, "étagère ARRIÈRE : x RETOURNÉ aussi — c'est une ROTATION, pas une réflexion");
    ck(rAr.y0 === 365 && rAr.y1 === 395, "étagère ARRIÈRE : profondeurs vers les −Y depuis la face arrière");
    ck(rAr.y0 <= rAr.y1 && rAr.x0 <= rAr.x1, "bornes RÉORDONNÉES : la rotation échange les coins, les appelants attendent x0 ≤ x1 / y0 ≤ y1");
    ck((rAv.y1 - rAv.y0) === (rAr.y1 - rAr.y0) && (rAv.x1 - rAv.x0) === (rAr.x1 - rAr.x0), "tourner ne DÉFORME pas : mêmes cotes des deux côtés");
    // C'EST une rotation : les deux images sont symétriques par rapport au CENTRE du plateau (−50, …).
    ck(((rAv.x0 + rAr.x1) / 2) === -50 && ((rAv.x1 + rAr.x0) / 2) === -50, "les deux images sont symétriques par rapport au CENTRE du plateau (signature d'un demi-tour)");

    // Le lacet d'un contenu s'ADDITIONNE à celui de son étagère — ce qui n'aurait aucun sens avec une
    // réflexion, et c'est précisément ce qui rend la chaîne composable jusqu'aux ports.
    ck.eq(TrayFrame.contentYawDeg(avant, 0), 0, "contentYawDeg : étagère avant → lacet propre inchangé");
    ck.eq(TrayFrame.contentYawDeg(avant, 90), 90, "contentYawDeg : … quel que soit le lacet");
    ck.eq(TrayFrame.contentYawDeg(arriere, 0), 180, "contentYawDeg : étagère ARRIÈRE → demi-tour ajouté");
    ck.eq(TrayFrame.contentYawDeg(arriere, 90), 270, "contentYawDeg : les deux lacets s'ADDITIONNENT");
    ck.eq(TrayFrame.contentYawDeg(avant, null), 0, "contentYawDeg : lacet absent → 0 (tolérant)");
    ck.eq(TrayFrame.facesFront(avant), true, "facesFront : étagère avant");
    ck.eq(TrayFrame.facesFront(arriere), false, "facesFront : étagère arrière");

    // `trayPlacementInRack` DÉRIVE ce placement de la boîte de l'étagère — pendant exact de `roomPlacement`.
    const rk = { u_count: 42, depth: 1000, cage_depth_mm: 900, front_margin_mm: 50, width_mm: 600 };
    const tAv = { u: 10, u_height: 3, tray_u: 1, tray_type: "cantilever", depth_mm: 400, side: "front" };
    const tAr = Object.assign({}, tAv, { side: "rear" });
    const bAv = RackGeometry.trayBoxLocal(rk, tAv), pAv = RackGeometry.trayPlacementInRack(rk, tAv);
    const bAr = RackGeometry.trayBoxLocal(rk, tAr), pAr = RackGeometry.trayPlacementInRack(rk, tAr);
    const largeurUtile = TrayGeometry.plank(RackGeometry.cageDepth(rk), tAv).W;
    ck(pAv.dir === 1 && pAr.dir === -1, "trayPlacementInRack : le SENS des DEUX axes vient de la face de montage");
    ck(Math.abs(pAv.originY - bAv.y0) < 1e-12, "trayPlacementInRack AVANT : l'origine des profondeurs est le bord AVANT du plateau");
    ck(Math.abs(pAr.originY - bAr.y1) < 1e-12, "trayPlacementInRack ARRIÈRE : l'origine est le bord ARRIÈRE");
    ck(Math.abs(pAv.originX - (bAv.x0 + bAv.xInset)) < 1e-12, "trayPlacementInRack AVANT : origine = bord utilisable GAUCHE (garde des renforts déjà déduite)");
    ck(Math.abs(pAr.originX - (bAr.x0 + bAr.xInset + largeurUtile)) < 1e-12, "trayPlacementInRack ARRIÈRE : origine = bord utilisable DROIT — `tray_x` se compte depuis la gauche de QUI REGARDE");
    ck(Math.abs(pAv.plankZ - bAv.z0) < 1e-12, "trayPlacementInRack : les posés reposent sur le DESSUS du plateau");

    // Le posé d'une étagère ARRIÈRE est bien RETOURNÉ — les DEUX axes (rotation, §6.24).
    const eq0 = { free_w_mm: 200, free_l_mm: 300, free_h_mm: 80, dc_orientation: 0, tray_x: 0, tray_y: 0 };
    const posAv = RackGeometry.trayEquipBoxLocal(rk, tAv, eq0);
    const posAr = RackGeometry.trayEquipBoxLocal(rk, tAr, eq0);
    ck(Math.abs(posAv.y0 - bAv.y0) < 1e-9, "posé sur étagère AVANT, tray_y = 0 → collé au bord AVANT du plateau");
    ck(Math.abs(posAr.y1 - bAr.y1) < 1e-9, "posé sur étagère ARRIÈRE, tray_y = 0 → collé au bord ARRIÈRE (retourné)");
    ck(Math.abs(posAv.x0 - (bAv.x0 + bAv.xInset)) < 1e-9, "posé AVANT, tray_x = 0 → collé au bord GAUCHE de la baie");
    ck(Math.abs(posAr.x1 - (bAr.x0 + bAr.xInset + largeurUtile)) < 1e-9, "posé ARRIÈRE, tray_x = 0 → collé au bord DROIT de la baie (= sa gauche, vue de derrière)");
    ck(Math.abs((posAv.x1 - posAv.x0) - (posAr.x1 - posAr.x0)) < 1e-12, "posé : mêmes cotes des deux côtés");

    /* ---- La boîte DESSINÉE et la boîte RAPPORTÉE décrivent le MÊME solide ----
       `DcThreeScene` ne dessine plus l'enveloppe rendue par `trayEquipBoxLocal` : il pose un boîtier
       de cotes PROPRES (w × d) au centre déclaré par `trayContentPlacementInRack`, TOURNÉ de son lacet
       effectif. Les deux descriptions doivent coïncider, sinon la coque et les connecteurs divergent —
       exactement la divergence que §6.24 a corrigée. Ce verrou l'empêche de revenir, et il est le seul
       moyen de tester du RENDU sans moteur 3D : on compare ses ENTRÉES à la géométrie de référence.
       ⚠ PORTÉE EXACTE DE CE VERROU, mesurée par sonde et non supposée : il MORD sur 4 des 8 cas si le
       rendu ignore le lacet (les 90°/270°, qui permutent l'enveloppe), mais il est AVEUGLE à une erreur
       de DEMI-TOUR — une rotation de 180° laisse une enveloppe alignée sur les axes inchangée. Le
       demi-tour est couvert ailleurs, par les NORMALES de la section « le lacet propre d'un posé
       atteint ses ports » (avant et arrière y sont exactement opposées). Les deux ensemble couvrent les
       quatre orientations ; ni l'un ni l'autre ne suffirait, et le croire serait la fausse sécurité que
       §6.19 nomme. */
    for (const t of [tAv, tAr]) {
      for (const ori of [0, 90, 180, 270]) {
        const e = { free_w_mm: 200, free_l_mm: 300, free_h_mm: 80, dc_orientation: ori, tray_x: 20, tray_y: 30 };
        const rapportee = RackGeometry.trayEquipBoxLocal(rk, t, e);
        const dessinee = RackGeometry.trayContentPlacementInRack(rk, t, e);
        // enveloppe de la boîte DESSINÉE : cotes propres, permutées par le lacet EFFECTIF (0/180 → non).
        const yaw = ((dessinee.yawDeg % 360) + 360) % 360;
        const tourne = (yaw === 90 || yaw === 270);
        const demiX = (tourne ? 300 : 200) / 2, demiY = (tourne ? 200 : 300) / 2;
        const quoi = " [étagère " + t.side + ", " + ori + "°]";
        ck(Math.abs((dessinee.x - demiX) - rapportee.x0) < 1e-9 && Math.abs((dessinee.x + demiX) - rapportee.x1) < 1e-9,
          "boîte dessinée ≡ boîte rapportée en X" + quoi);
        ck(Math.abs((dessinee.y - demiY) - rapportee.y0) < 1e-9 && Math.abs((dessinee.y + demiY) - rapportee.y1) < 1e-9,
          "boîte dessinée ≡ boîte rapportée en Y" + quoi);
      }
    }
  }
  });

  await section("Montages MARGE / PAROI : la coque DESSINÉE regarde là où sortent les ports (§6.25)", async () => {
  {
    /* Les modes `side` et `wall` étaient dessinés en boîtes NUES (ni nom, ni image, ni repère
       d'orientation) alors que leurs ports étaient résolus. Les faire passer par le rendu COMMUN des
       boîtiers demande de leur donner un LACET — et c'est là qu'on peut se tromper sans que rien ne le
       dise. Ce test croise DEUX chemins indépendants : le lacet déduit par `mountedContentPlacementInRack`
       (rendu) et la normale rendue par `Resolver3D` (ports). S'ils divergent, la coque tourne le dos à
       ses propres connecteurs — exactement le défaut que §6.24 vient de corriger pour les étagères.
       ⚠ Les deux vérifications MORDENT, mesuré par sonde et non supposé : lacet forcé à 0 → 20 cas sur
       32 en échec ; cotes non permutées à 90°/270° → 8 sur 32. */
    const s = await makeStore();
    const dc = await s.create("datacenters", { name: "S", width_mm: 5000, depth_mm: 5000 });
    const rack = await s.create("racks", { name: "R", datacenter_id: dc.id, dc_x: 0, dc_y: 0, orientation: 0,
      u_count: 42, depth: 1200, width_mm: 800, cage_depth_mm: 700, front_margin_mm: 200, allow_side_front: true, allow_side_rear: true });
    const rk = s.get("racks", rack.id), r = new Resolver3D(s);
    const GEO = { face_side: "front", face_x: 0.5, face_y: 0.5 };
    const arr = (v) => Math.round(v * 1000) / 1000;

    let cas = 0, facadeOk = 0, enveloppeOk = 0, lacets = new Set();
    const essai = async (rec, label) => {
      const e = await s.create("equipments", Object.assign({ dim_mode: "free", rack_id: rack.id, free_w_mm: 60, free_l_mm: 300, free_h_mm: 150 }, rec));
      ck(!!e, "montage créé : " + label);
      if (!e) return;
      cas++;
      const m = RackGeometry.mountedContentPlacementInRack(rk, e);
      const b = (e.placement_mode === "wall") ? RackGeometry.wallEquipBoxLocal(rk, e) : RackGeometry.sideEquipBoxLocal(rk, e);
      lacets.add(m.yawDeg);
      // ① la FAÇADE dessinée (façade locale −Y tournée du lacet) ≡ la normale du port RÉSOLU
      const yaw = m.yawDeg * Math.PI / 180;
      const p = r.resolveFaceAnchor3D(e, GEO, dc.id);
      if (p && arr(Math.sin(yaw)) === arr(p.n.x) && arr(-Math.cos(yaw)) === arr(p.n.y)) facadeOk++;
      // ② l'ENVELOPPE dessinée (cotes propres, permutées par un quart de tour) ≡ celle rapportée
      const tourne = (m.yawDeg === 90 || m.yawDeg === 270);
      const ex = tourne ? m.box.d : m.box.w, ey = tourne ? m.box.w : m.box.d;
      if (Math.abs((m.x - ex / 2) - b.x0) < 1e-9 && Math.abs((m.x + ex / 2) - b.x1) < 1e-9
        && Math.abs((m.y - ey / 2) - b.y0) < 1e-9 && Math.abs((m.y + ey / 2) - b.y1) < 1e-9) enveloppeOk++;
      // ③ la base Z dessinée est celle de la boîte (le boîtier ne flotte pas au-dessus de son montage)
      ck(Math.abs(m.baseZ - b.z0) < 1e-9 && Math.abs(m.box.h - (b.z1 - b.z0)) < 1e-9, "base et hauteur dessinées ≡ rapportées : " + label);
    };

    let i = 0;
    for (const face of ["front", "rear"]) for (const lr of ["left", "right"]) for (const col of [0, 1]) for (const snap of ["wall", "inner"]) {
      await essai({ name: "S" + (i++), placement_mode: "side", side_face: face, side_lr: lr, side_col: col, side_snap: snap, side_u: 5 },
        "side " + face + "/" + lr + "/col" + col + "/" + snap);
    }
    for (const lr of ["left", "right"]) for (const mg of ["front", "rear"]) for (const or of ["center", "facade"]) for (const col of [0, 1]) {
      await essai({ name: "W" + (i++), placement_mode: "wall", wall_lr: lr, wall_margin: mg, wall_orient: or, wall_col: col, wall_u: 5 },
        "wall " + lr + "/" + mg + "/" + or + "/col" + col);
    }

    ck.eq(cas, 32, "les 32 configurations de montage sont couvertes (16 marge × 16 paroi)");
    ck.eq(facadeOk, cas, "la FAÇADE dessinée regarde EXACTEMENT là où sort le port résolu, sur les 32 cas");
    ck.eq(enveloppeOk, cas, "l'ENVELOPPE dessinée est EXACTEMENT celle rapportée par la géométrie de baie (cotes BORNÉES, pas déclarées)");
    // anti-vacuité : si toutes les configurations donnaient le même lacet, ① passerait sans rien prouver.
    ck(lacets.size >= 3, "les configurations produisent des lacets VARIÉS (obtenus : " + [...lacets].sort((a, b) => a - b).join("°, ") + "°) — le test ne compare pas un cas unique à lui-même");
  }
  });

  await section("Resolver3D : le lacet PROPRE d'un posé atteint enfin ses ports (§6.24 — défaut CONFIRMÉ par sonde)", async () => {
  {
    /* DÉFAUT MESURÉ AVANT CORRECTION : la branche `tray` interpolait sur les seules faces ±Y de la
       boîte, sans jamais lire `dc_orientation`. Sonde : les QUATRE orientations rendaient la MÊME
       normale (0, −1), là où le même boîtier en mode LIBRE en rend quatre distinctes. Ce n'était donc
       pas un défaut des seuls 90°/270° (empreinte permutée) : 180° l'était aussi, et de la façon la
       plus nette — boîte identique, façade inversée, port immobile. La correction fait passer le
       lacet par `PlacementFrame`, à qui cette composition appartient. */
    const s = await makeStore();
    const dc = await s.create("datacenters", { name: "S", width_mm: 5000, depth_mm: 5000 });
    const rack = await s.create("racks", { name: "R", datacenter_id: dc.id, dc_x: 0, dc_y: 0, orientation: 0,
      u_count: 42, depth: 1000, width_mm: 600, cage_depth_mm: 900, front_margin_mm: 50 });
    const r = new Resolver3D(s);
    const GEO = { face_side: "front", face_x: 0.5, face_y: 0.5 };
    const arr = (v) => Math.round(v * 100) / 100;

    // Une étagère PAR CAS : deux posés au même endroit d'un même plateau se CHEVAUCHENT, et la
    // validation les refuse silencieusement (`create` rend null) — piège rencontré en écrivant la
    // sonde, consigné ici pour qu'on ne le redécouvre pas.
    const normalesDe = async (side, u0) => {
      const out = [];
      for (const [i, ori] of [0, 90, 180, 270].entries()) {
        const t = await s.create("rackItems", { rack_id: rack.id, kind: "tray", u: u0 + i * 4, u_height: 3, tray_u: 1, tray_type: "dual", side });
        const eq = await s.create("equipments", { name: side + ori, placement_mode: "tray", dim_mode: "free",
          tray_item_id: t.id, free_w_mm: 200, free_l_mm: 400, free_h_mm: 80, dc_orientation: ori, tray_x: 0, tray_y: 0 });
        const p = eq && r.resolveFaceAnchor3D(eq, GEO, dc.id);
        out.push(p ? arr(p.n.x) + "," + arr(p.n.y) : "NULL");
      }
      return out;
    };

    const nAvant = await normalesDe("front", 3);
    ck.eq(nAvant.join(" | "), "0,-1 | 1,0 | 0,1 | -1,0",
      "étagère AVANT : la façade d'un posé suit son lacet — 4 normales, une par orientation (avant correction : (0,−1) partout)");
    ck.eq(new Set(nAvant).size, 4, "les 4 normales sont DISTINCTES (anti-vacuité : c'est exactement ce qui manquait)");

    const nArriere = await normalesDe("rear", 23);
    ck.eq(nArriere.join(" | "), "0,1 | -1,0 | 0,-1 | 1,0",
      "étagère ARRIÈRE : les mêmes, RETOURNÉES d'un demi-tour — les deux lacets se composent");
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = nAvant[i].split(",").map(Number), [bx, by] = nArriere[i].split(",").map(Number);
      ck(ax === -bx && ay === -by, "orientation " + [0, 90, 180, 270][i] + "° : avant et arrière exactement OPPOSÉES (demi-tour, pas réflexion)");
    }
  }
  });

  await section("RackGeometry : tray (étagère) — longueur effective + boîte utile", async () => {
  {
    const rack = { u_count: 42, depth: 1000, cage_depth_mm: 900, front_margin_mm: 50, width_mm: 600 };
    // longueur EFFECTIVE : dual = pleine cage (depth_mm ignoré) ; cantilever = depth_mm borné à la cage
    ck.eq(RackGeometry.trayLength(rack, { tray_type: "dual", depth_mm: 300 }), 906, "trayLength dual → façade à façade (cage + 2 × réserve d'oreilles, depth_mm ignoré)");
    ck.eq(RackGeometry.trayLength(rack, { tray_type: "cantilever", depth_mm: 400 }), 400, "trayLength cantilever → depth_mm");
    ck.eq(RackGeometry.trayLength(rack, { tray_type: "cantilever", depth_mm: 2000 }), 900, "trayLength cantilever → borné à la cage");
    // boîte UTILE : plateau au BAS de la réservation (+ réserve de tôle 5 mm) → plafond de la réservation.
    // tray_u (hauteur de la structure qui PORTE le plateau, au-dessus) = pure indication de dessin.
    const it = { u: 10, u_height: 3, tray_u: 1, tray_type: "cantilever", depth_mm: 400, side: "front" };
    const b = RackGeometry.trayBoxLocal(rack, it), base = RackGeometry.uBaseZ(rack);
    ck(Math.abs(b.z0 - (base + 9 * U_MM + 5)) < 1e-9, "plancher utile = plateau (bas de réservation) + 5 mm de tôle");
    ck(Math.abs(b.z1 - (base + 12 * U_MM)) < 1e-9, "plafond utile = réservation (u−1+u_height)");
    ck(Math.abs((b.y1 - b.y0) - 400) < 1e-9 && b.front === true, "profondeur utile = longueur du plateau, ancrée au plan de façade");
    ck(Math.abs(b.y0 - (-453)) < 1e-9, "plan de façade = plan de montage − réserve d'oreilles (3 mm)");
    // tray_u N'EXCLUT PAS d'espace : la boîte utile est identique quelle que soit la structure
    const b2 = RackGeometry.trayBoxLocal(rack, Object.assign({}, it, { tray_u: 3 }));
    ck(Math.abs(b2.z0 - b.z0) < 1e-9 && Math.abs(b2.z1 - b.z1) < 1e-9, "tray_u = indication de dessin (boîte utile inchangée)");

    // ---- équipements POSÉS : boîte, rotation, contrôle d'espace, auto-position ----
    const eqA = { name: "A", free_w_mm: 200, free_l_mm: 300, free_h_mm: 80, dc_orientation: 0, tray_x: 0, tray_y: 0 };
    const bA = RackGeometry.trayEquipBoxLocal(rack, it, eqA);
    ck(Math.abs((bA.x1 - bA.x0) - 200) < 1e-9 && Math.abs((bA.y1 - bA.y0) - 300) < 1e-9, "posé : empreinte 200 × 300 sur le plateau");
    ck(Math.abs(bA.z0 - b.z0) < 1e-9 && Math.abs((bA.z1 - bA.z0) - 80) < 1e-9, "posé SUR le plateau (z0 = dessus), hauteur 80");
    const bR = RackGeometry.trayEquipBoxLocal(rack, it, Object.assign({}, eqA, { dc_orientation: 90 }));
    ck(Math.abs((bR.x1 - bR.x0) - 300) < 1e-9 && Math.abs((bR.y1 - bR.y0) - 200) < 1e-9, "rotation 90° : largeur ↔ profondeur");
    ck.eq(RackGeometry.trayEquipFitsWhy(rack, it, eqA, []), null, "fitsWhy : tient (80 ≤ 3 U − 5 mm = 128,35 mm utiles)");
    ck(!!RackGeometry.trayEquipFitsWhy(rack, it, Object.assign({}, eqA, { free_h_mm: 150 }), []), "fitsWhy : 150 mm > 128,35 mm utiles → refus");
    ck(!!RackGeometry.trayEquipFitsWhy(rack, it, Object.assign({}, eqA, { free_l_mm: 500 }), []), "fitsWhy : profondeur 500 > plateau 400 → refus");
    ck(!!RackGeometry.trayEquipFitsWhy(rack, it, Object.assign({}, eqA, { tray_x: 400 }), []), "fitsWhy : position hors plateau → refus");
    const other = { name: "B", free_w_mm: 100, free_l_mm: 300, free_h_mm: 80, dc_orientation: 0, tray_x: 0, tray_y: 0 };
    ck(String(RackGeometry.trayEquipFitsWhy(rack, it, eqA, [other])).includes("chevauche"), "fitsWhy : chevauchement détecté");
    const spot = RackGeometry.trayFindSpot(rack, it, eqA, [other]);
    ck(!!spot && !RackGeometry.trayEquipFitsWhy(rack, it, Object.assign({}, eqA, { tray_x: spot.x, tray_y: spot.y }), [other]), "findSpot : auto-position valide en évitant l'occupant");
    // AUTO-POSITION AMÉLIORÉE — plateau 444,6 mm utilisables (452,6 corps − 2 × 4 garde), profondeur 400 mm.
    // 1) plateau VIDE : équipement (w=100) CENTRÉ en largeur ET en profondeur (place distribuée autour).
    const solo = RackGeometry.trayFindSpot(rack, it, { free_w_mm: 100, free_l_mm: 100, free_h_mm: 40, dc_orientation: 0 }, []);
    ck(Math.abs(solo.x - (444.6 - 100) / 2) < 1 && Math.abs(solo.y - (400 - 100) / 2) < 1, "findSpot vide : centré en largeur et profondeur");
    // 2) CÔTE À CÔTE : un colocataire (w=100) posé à gauche → le nouveau se place à la MÊME profondeur
    // (même rangée), centré dans le plus grand intervalle libre à sa droite, sans chevauchement.
    const co = { free_w_mm: 100, free_l_mm: 100, free_h_mm: 40, dc_orientation: 0, tray_x: 0, tray_y: 150 };
    const s2 = RackGeometry.trayFindSpot(rack, it, { free_w_mm: 100, free_l_mm: 100, free_h_mm: 40, dc_orientation: 0 }, [co]);
    ck(Math.abs(s2.y - 150) < 1, "findSpot côte à côte : même rangée (profondeur du colocataire)");
    ck(s2.x >= 100 - 0.5, "findSpot côte à côte : à droite du colocataire (pas de chevauchement)");
    ck.eq(RackGeometry.trayEquipFitsWhy(rack, it, Object.assign({ free_w_mm: 100, free_l_mm: 100, free_h_mm: 40, dc_orientation: 0 }, { tray_x: s2.x, tray_y: s2.y }), [co]), null, "findSpot côte à côte : position valide");
    // milieu du plus grand intervalle [100, 444,6] → centre ≈ (100 + 444,6 − 100)/2 = 222,3
    ck(Math.abs(s2.x - (100 + (444.6 - 100 - 100) / 2)) < 1.5, "findSpot : centré dans le plus grand intervalle libre");
    // REFLOW UNIFORME : 3 équipements (w=100) sur 444,6 utiles → 4 espaces égaux de (444,6−300)/4 = 36,15 ;
    // positions x = 36,15 · 172,3 · 308,45 ; tous centrés en profondeur.
    const three = [0, 1, 2].map(() => ({ free_w_mm: 100, free_l_mm: 100, free_h_mm: 40, dc_orientation: 0 }));
    const arr = RackGeometry.trayArrange(rack, it, three);
    ck(!!arr && arr.length === 3, "trayArrange : 3 positions");
    const g = (444.6 - 300) / 4;
    ck(Math.abs(arr[0].x - g) < 0.5 && Math.abs(arr[1].x - (2 * g + 100)) < 0.5 && Math.abs(arr[2].x - (3 * g + 200)) < 0.5, "trayArrange : espaces horizontaux ÉGAUX");
    ck(arr.every((p) => Math.abs(p.y - (400 - 100) / 2) < 0.5), "trayArrange : tous centrés en profondeur");
    // espaces uniformes = écarts entre bords consécutifs (bord gauche, entre 1-2, entre 2-3, bord droit) tous ≈ g
    const gaps = [arr[0].x, arr[1].x - (arr[0].x + 100), arr[2].x - (arr[1].x + 100), 444.6 - (arr[2].x + 100)];
    ck(gaps.every((v) => Math.abs(v - g) < 0.5), "trayArrange : marges de bord = interstices (distribution uniforme)");
    // ne tient pas côte à côte → null (repli findSpot côté appelant)
    ck.eq(RackGeometry.trayArrange(rack, it, [0, 1, 2, 3, 4].map(() => ({ free_w_mm: 100, free_l_mm: 100, free_h_mm: 40, dc_orientation: 0 }))), null, "trayArrange : 5 × 100 > 444,6 → null");
    // GARDE LATÉRALE des renforts (porte-à-faux) : 4 mm de chaque côté, la pose s'y refuse
    ck.eq(b.xInset, 4, "cantilever → garde latérale 4 mm (xInset)");
    ck(Math.abs(bA.x0 - (b.x0 + 4)) < 1e-9, "posé : bord gauche décalé de la garde (x0 = plateau + 4 mm)");
    const usableW = (b.x1 - b.x0) - 8;   // corps 19″ − 2 × 4
    ck.eq(RackGeometry.trayEquipFitsWhy(rack, it, { free_w_mm: usableW, free_l_mm: 200, free_h_mm: 80, dc_orientation: 0, tray_x: 0, tray_y: 0 }, []), null, "largeur = zone utilisable → tient");
    ck(!!RackGeometry.trayEquipFitsWhy(rack, it, { free_w_mm: usableW + 2, free_l_mm: 200, free_h_mm: 80, dc_orientation: 0, tray_x: 0, tray_y: 0 }, []), "largeur > zone utilisable (garde renforts) → refus");
    // DUAL : pas de renforts latéraux → aucune garde
    ck.eq(RackGeometry.trayBoxLocal(rack, { u: 10, u_height: 3, tray_u: 1, tray_type: "dual", side: "front" }).xInset, 0, "dual → aucune garde latérale");
  }
  });

  await section("RackGeometry/Depths : profondeur en MM (legacy→mm, occupation découplée, dispo)", async () => {
  {
    // conversion legacy → mm (migration)
    ck.eq(Depths.legacyToMm("half", 800), 400, "legacyToMm : half sur cage 800 → 400");
    ck.eq(Depths.legacyToMm("quarter", 1000), 250, "legacyToMm : quarter sur cage 1000 → 250");
    ck.eq(Depths.legacyToMm("full", 900), 900, "legacyToMm : full → cage entière");
    // mountLocksU DÉCOUPLÉ : l'enum « full » ne verrouille QUE pré-migration ; ensuite locks_u fait foi
    ck(RackGeometry.mountLocksU({ depth: "full", depth_mm: null }), "legacy full non migré → verrouille les 2 faces");
    ck(!RackGeometry.mountLocksU({ depth: "full", depth_mm: 600, locks_u: false }), "migré : depth passif ignoré, locks_u false fait foi");
    ck(RackGeometry.mountLocksU({ depth_mm: 600, locks_u: true }), "locks_u explicite → verrouille");
    ck(!RackGeometry.mountLocksU({ depth: "half", depth_mm: null, locks_u: false }), "legacy half → une seule face");
    // profondeurs disponibles (dépassement + dos-à-dos) — parité avec shared/DataValidation (RackDepth)
    const rk = { depth: 1000, cage_depth_mm: 900, front_margin_mm: 50 };
    ck.eq(RackGeometry.rearMargin(rk), 50, "marge arrière = 1000 − cage 900 − avant 50");
    ck.eq(RackGeometry.mountAvailDepth(rk, "front"), 950, "dispo ancrage avant = 1000 − 50");
    ck.eq(RackGeometry.mountAvailDepth(rk, "rear"), 950, "dispo ancrage arrière = 1000 − 50");
    ck.eq(RackGeometry.sharedMountDepth(rk), 900, "espace partagé dos-à-dos = cage");
    const rkDoor = { depth: 1000, cage_depth_mm: 900, front_margin_mm: 50, door_front: { enabled: true, hollow: true, hollow_mm: 60 } };
    ck.eq(RackGeometry.mountAvailDepth(rkDoor, "front"), 1010, "cavité de porte creuse ajoutée (950 + 60)");
  }
  });

  await section("ImageStitch : assemblage de photos redressées (resize, gain, fondu, recadrage, affinage)", async () => {
  {
    // petit constructeur d'image brute : lum(x,y) → pixel gris opaque
    const mkRaw = (w, h, lum) => {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, v = lum(x, y); d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
      return { data: d, width: w, height: h };
    };
    // RESIZE : uni 1×1 → 3×2 uni ; dégradé 2×1 → 4×1 : extrémités PURES (clamp aux bords)
    const uni = ImageStitch.resizeBilinear(mkRaw(1, 1, () => 137), 3, 2);
    ck(uni.width === 3 && uni.height === 2 && uni.data[0] === 137 && uni.data[3 * 2 * 4 - 1] === 255, "resize : uni 1×1 → 3×2 uni");
    const grad = ImageStitch.resizeBilinear(mkRaw(2, 1, (x) => x ? 200 : 0), 4, 1);
    ck(grad.data[0] === 0 && grad.data[12] === 200 && grad.data[4] < grad.data[8], "resize : dégradé — extrémités pures, milieu croissant");
    // GAIN : A à 200, B à 100, recouvrement complet → ×2 (borne haute)
    ck.eq(ImageStitch.gainForB(mkRaw(8, 8, () => 200), mkRaw(8, 8, () => 100), 0, 0), 2, "gainForB : 200/100 → 2");
    // FONDU (seam "feather") : A à 100 (4×2), B à 220 (4×2) posé à dx=2 → composite 6×2 ; A pur à gauche,
    // B pur à droite, rampe croissante dans le recouvrement [2,4) ; alpha opaque partout.
    const bl = ImageStitch.blend(mkRaw(4, 2, () => 100), mkRaw(4, 2, () => 220), 2, 0, "h", 1, "feather");
    ck(bl.img.width === 6 && bl.img.height === 2 && bl.ox === 0 && bl.oy === 0, "blend : union 6×2, origine (0,0)");
    const px = (x) => bl.img.data[(0 * 6 + x) * 4];
    ck(px(0) === 100 && px(5) === 220 && px(2) === 100 && px(3) > 100 && px(3) < 220, "blend fondu : A pur | rampe | B pur");
    ck(bl.img.data[(1 * 6 + 4) * 4 + 3] === 255, "blend : alpha opaque");
    // COUPE FRANCHE (seam "cut", DÉFAUT) : la 1re photo PRIORITAIRE sur tout le recouvrement — aucun mélange ;
    // B n'apparaît qu'au-delà de A (croppée à la jonction).
    const bc = ImageStitch.blend(mkRaw(4, 2, () => 100), mkRaw(4, 2, () => 220), 2, 0, "h");
    const pc = (x) => bc.img.data[(0 * 6 + x) * 4];
    ck(pc(2) === 100 && pc(3) === 100 && pc(4) === 220 && pc(5) === 220, "blend coupe franche : A jusqu'à sa fin, B croppée à la jonction");
    // RECADRAGE AUTO (h) : dy=1 → union en x, INTERSECTION en y (coupe les bandes transparentes)
    const r = ImageStitch.autoCropRect({ width: 4, height: 4 }, { width: 4, height: 4 }, 3, 1, "h");
    ck(r.x === 0 && r.w === 7 && r.y === 1 && r.h === 3, "autoCropRect : union x (0..7), intersection y (1..4)");
    const cropped = ImageStitch.crop(bl.img, 1, 0, 4, 2);
    ck(cropped.width === 4 && cropped.height === 2 && cropped.data[0] === 100, "crop : dims + contenu");
    // AFFINAGE : B = extrait de A décalé — refine retrouve le décalage exact depuis une position approchée
    const A = mkRaw(24, 24, (x, y) => (x * 7 + y * 13 + ((x * y) % 5) * 31) % 256);   // texture non périodique
    const B = ImageStitch.crop(A, 5, 3, 12, 12);   // B s'aligne exactement à (dx,dy) = (5,3)
    const best = ImageStitch.refine(A, B, 7, 5, 4);   // départ décalé de (2,2), recherche ±4
    ck(best.dx === 5 && best.dy === 3, "refine : retrouve l'alignement exact (5,3) depuis (7,5)");
  }
  });

  await section("FreeEquipGeometry : faceFraction = inverse de faceLocal (plaquage des images de façade)", async () => {
  {
    const { FreeEquipGeometry } = D("geometry/FreeEquipGeometry.js");
    const approx = (a, b, name) => ck(Math.abs(a - b) <= 1e-9, name + "  (attendu ≈" + b + ", obtenu " + a + ")");
    const eq = { free_w_mm: 600, free_l_mm: 400, free_h_mm: 300 };
    // ALLER-RETOUR sur les 6 faces (points non triviaux) : faceLocal(fx,fy) → faceFraction → (fx,fy) inchangés.
    ["front", "rear", "left", "right", "top", "bottom"].forEach((face) => {
      [[0, 0], [1, 0], [0.25, 0.7]].forEach(([fx, fy]) => {
        const p = FreeEquipGeometry.faceLocal(eq, face, fx, fy, 0);
        const f = FreeEquipGeometry.faceFraction(eq, face, p.lx, p.ly, p.lz, 0);
        approx(f.fx, fx, "roundtrip " + face + " fx(" + fx + "," + fy + ")");
        approx(f.fy, fy, "roundtrip " + face + " fy(" + fx + "," + fy + ")");
      });
    });
    // Orientation ARRIÈRE (le bug corrigé : image à 180° en 3D) : fy=0 = HAUT (z max), fx=0 = +X (gauche vue de derrière).
    const rTop = FreeEquipGeometry.faceFraction(eq, "rear", 0, 200, 300, 0);   // coin z=h (haut), x=0 (centre)
    approx(rTop.fy, 0, "rear : z = h → fy = 0 (haut de l'image en haut)");
    const rLeft = FreeEquipGeometry.faceFraction(eq, "rear", 300, 200, 150, 0);   // x = +w/2
    approx(rLeft.fx, 0, "rear : x = +w/2 → fx = 0 (gauche de l'image, vue de derrière)");
    // CONVENTION PHOTOGRAPHIQUE (cf. en-tête de FreeEquipGeometry) : quel bord de l'IMAGE tombe du côté
    // de la face AVANT du boîtier (−Y). Ces 4 assertions VERROUILLENT la règle métier — un cliché de face
    // horizontale/latérale se pose comme on l'a pris, l'avant du boîtier servant de repère.
    approx(FreeEquipGeometry.faceFraction(eq, "top", 0, -200, 300, 0).fy, 1, "dessus : avant (−Y) → fy = 1 (BAS de l'image côté face)");
    approx(FreeEquipGeometry.faceFraction(eq, "bottom", 0, -200, 0, 0).fy, 0, "dessous : avant (−Y) → fy = 0 (HAUT de l'image côté face)");
    approx(FreeEquipGeometry.faceFraction(eq, "left", -300, -200, 150, 0).fx, 1, "gauche : avant (−Y) → fx = 1 (DROITE de l'image côté face)");
    approx(FreeEquipGeometry.faceFraction(eq, "right", 300, -200, 150, 0).fx, 0, "droite : avant (−Y) → fx = 0 (GAUCHE de l'image côté face)");
    // NON MIROIR sur les 6 faces : (droite de l'image) × (haut de l'image) = normale SORTANTE. Garde-fou
    // contre une correction d'orientation qui INVERSERAIT l'écriture au lieu de la faire pivoter (une simple
    // négation de fx ou de fy seule miroite la face — il faut les retourner par PAIRE).
    const OUT = { front: [0, -1, 0], rear: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 0, 1], bottom: [0, 0, -1] };
    Object.keys(OUT).forEach((face) => {
      const P = (fx, fy) => { const p = FreeEquipGeometry.faceLocal(eq, face, fx, fy, 0); return [p.lx, p.ly, p.lz]; };
      const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
      const r = sub(P(1, 0.5), P(0, 0.5));   // vecteur vers la DROITE de l'image
      const u = sub(P(0.5, 0), P(0.5, 1));   // vecteur vers le HAUT de l'image
      const cr = [r[1] * u[2] - r[2] * u[1], r[2] * u[0] - r[0] * u[2], r[0] * u[1] - r[1] * u[0]];
      const n = OUT[face], dot = cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2];
      ck(dot > 0, "non miroir " + face + " : (droite × haut) orienté comme la normale sortante");
    });
  }
  });

  /* ============================================================================================
     CameraFraming — la RÈGLE DE CADRAGE de « Localiser », désormais nommée et exprimée en TAUX
     DE REMPLISSAGE. L'ancienne (`Math.max(400, extent * 0.7 + 200)`) faisait dépendre ce taux de
     la TAILLE de l'objet : 62 % pour une baie de 2 m, 48 % pour 600 mm, 25 % pour 200 mm. Les
     attentes ci-dessous sont EN DUR, dérivées à la main de la règle voulue (90 %, plancher à une
     largeur de baie), jamais de la sortie d'une implémentation.
     ============================================================================================ */
  await section("CameraFraming : taux de remplissage à 90 %, limite de zoom, monotonie, aspect", async () => {
  {
    const half = (e, a) => CameraFraming.halfExtentFor(e, a);
    const taux = (e, a) => e / (2 * half(e, a));   // fraction de la HAUTEUR de vue occupée par l'objet

    // ---- constantes NOMMÉES (la valeur visée est une décision, pas un nombre noyé dans une formule) ----
    ck.eq(CameraFraming.FILL_RATIO, 0.9, "FILL_RATIO : 90 % de la vue, demandé explicitement");
    ck.eq(CameraFraming.MIN_FRAMED_EXTENT_MM, 600, "MIN_FRAMED_EXTENT_MM : limite de zoom = une largeur de baie standard (600 mm)");
    ck.eq(CameraFraming.FOCUS_ELEVATION_RAD, Math.PI / 9, "FOCUS_ELEVATION_RAD : caméra légèrement plongeante (20°)");

    // ---- le taux visé est ATTEINT, quelle que soit la taille (c'est tout l'enjeu du lot) ----
    ck.eq(half(2000), 1111.111111111111, "baie de 2 000 mm : demi-étendue = 2000 / 1,8");
    ck(Math.abs(taux(2000) - 0.9) < 1e-12, "objet de 2 000 mm : 90 % de la vue");
    ck(Math.abs(taux(667) - 0.9) < 1e-12, "objet de 667 mm : 90 % — le taux ne dépend PLUS de la taille");
    ck(Math.abs(taux(12000) - 0.9) < 1e-12, "objet de 12 000 mm : 90 % (l'ancienne règle plafonnait à 71,4 %)");
    ck.eq(half(2222.2222222222226), 1234.5679012345681, "demi-étendue = extent / (2 × 0,9), sans rembourrage constant");

    // ---- LIMITE DE ZOOM : sous 600 mm d'objet, on cadre 600 mm de monde et pas moins ----
    ck.eq(half(100), 300, "boîtier de 100 mm : plancher — 600 mm de monde cadré (et non 111)");
    ck.eq(half(0), 300, "étendue nulle (donnée absente) : plancher, jamais une vue dégénérée");
    ck.eq(half(-500), 300, "étendue négative (saisie absurde) : plancher, pas de demi-étendue négative");
    ck(Math.abs(taux(100) - 1 / 6) < 1e-12, "boîtier de 100 mm : 16,7 % de la vue — visible, mais on garde le contexte");
    ck.eq(half(540), 300, "540 mm (= 600 × 0,9) : DERNIÈRE taille encore bornée par le plancher");
    ck(half(541) > 300, "541 mm : au-delà du plancher, la règle des 90 % reprend la main");
    ck(CameraFraming.MIN_FRAMED_EXTENT_MM / U_MM > 13, "la limite de zoom laisse voir plus de 13 U — un 1U localisé garde ~6 U de contexte de part et d'autre");

    // ---- MONOTONIE : un objet plus grand n'est JAMAIS cadré plus serré ----
    let mono = true, prec = -1;
    for (let e = 0; e <= 6000; e += 25) { const h = half(e); if (h < prec - 1e-9) mono = false; prec = h; }
    ck(mono, "monotonie : la demi-étendue cadrée ne DÉCROÎT jamais quand l'objet grandit");
    ck(half(3000) > half(1000) && half(1000) > half(700), "monotonie STRICTE au-dessus du plancher");

    // ---- ÉTENDUE CADRABLE d'un objet = sa plus grande cote (l'angle de vue n'est pas connu du cadrage) ----
    ck.eq(CameraFraming.objectExtent(600, 1000, 2000), 2000, "objectExtent(baie 42U) : la hauteur domine");
    ck.eq(CameraFraming.objectExtent(600, 600, 400), 600, "objectExtent(baie murale 6U) : la LARGEUR domine — l'ancien cadrage sur la seule hauteur l'ignorait");
    ck.eq(CameraFraming.objectExtent(2000, 1000, 900), 2000, "objectExtent : objet large et bas → sa largeur");
    ck.eq(CameraFraming.objectExtent(0, null, undefined), 0, "objectExtent : cotes absentes → 0 (le plancher prendra le relais)");

    // ---- ASPECT : en PAYSAGE la hauteur borne (aucun effet) ; en PORTRAIT c'est la largeur ----
    ck.eq(half(2000, 1.6), half(2000), "aspect 1,6 (paysage) : sans effet — la hauteur est la dimension qui borne");
    ck.eq(half(2000, 1), half(2000), "aspect 1 (carré) : sans effet");
    ck.eq(half(2000, 0.5), 2 * half(2000), "aspect 0,5 (portrait) : le cadrage double pour que l'objet tienne EN LARGEUR");
    ck.eq(half(2000, 0), half(2000), "aspect nul/absurde (canevas non mesurable) : repli sur le cadrage paysage");
    // en portrait, l'objet occupe bien 90 % de la LARGEUR de vue (= aspect × hauteur de vue)
    const hp = half(2000, 0.5), largeurVue = 0.5 * 2 * hp;
    ck(Math.abs(2000 / largeurVue - 0.9) < 1e-12, "portrait : la promesse « 90 % de la vue » vaut aussi en largeur");
  }
  });

  await section("RackDoorGeometry : débattement des portes de baie (partagé 2D/3D)", async () => {
  {
    const { RackDoorGeometry } = D("geometry/RackDoorGeometry.js");
    const w = 800, d = 1000;
    // porte AVANT, charnière gauche, pleine : pivot sur l'arête EXTÉRIEURE (d/2 + épaisseur), ouverture vers −Y.
    const s = RackDoorGeometry.swingSector(w, d, false, { thickness_mm: 40, hinge: "left" });
    ck.eq(s.hx, -w / 2 + 40, "pivot X = bord gauche + épaisseur");
    ck.eq(s.hy, -(d / 2 + 40), "pivot Y = arête extérieure (face + épaisseur), côté avant (−Y)");
    ck.eq(s.R, w - 40, "rayon = largeur du vantail (largeur − épaisseur)");
    // fin d'arc = vantail OUVERT : R(beta)·(dirX·R, 0) = (0, sgn·R) → pointe vers l'extérieur (−Y devant)
    const pts = RackDoorGeometry.sectorPointsOf(s, 4);
    const last = pts[pts.length - 1];
    ck(Math.abs(last.x - s.hx) < 1e-6 && Math.abs(last.y - (s.hy - s.R)) < 1e-6, "fin d'arc : vantail ouvert perpendiculaire, vers l'extérieur");
    // CAVITÉ (porte creuse) : le pivot recule d'autant — c'était la DIVERGENCE 2D/3D tranchée par la mutualisation.
    const sc = RackDoorGeometry.swingSector(w, d, false, { thickness_mm: 40, hinge: "left", hollow: true, hollow_mm: 60 });
    ck.eq(sc.hy, -(d / 2 + 60 + 40), "cavité : pivot décalé de hollow_mm en plus (parité 2D = 3D)");
    // porte ARRIÈRE, charnière droite : miroir complet (pivot +Y, charnière inversée vue de la face).
    const sr = RackDoorGeometry.swingSector(w, d, true, { thickness_mm: 40, hinge: "right" });
    ck.eq(sr.hy, d / 2 + 40, "arrière : pivot +Y");
    ck.eq(sr.hx, -w / 2 + 40, "arrière + charnière droite : côté inversé vue de la face");
    ck.eq(RackDoorGeometry.swingSector(w, d, false, { thickness_mm: 2, hinge: "left" }).hx, -w / 2 + 6, "épaisseur plancher 6 mm");
    // VANTAUX : simple → 1 secteur identique à l'historique ; DOUBLE BATTANT → 2 secteurs, pivots aux DEUX bords,
    // rayon = demi-largeur − épaisseur, ouvertures symétriques (loquets au centre). `hinge` sans effet en double.
    const one = RackDoorGeometry.swingSectors(w, d, false, { thickness_mm: 40, hinge: "left" });
    ck.eq(one.length, 1, "swingSectors(simple) : 1 secteur");
    ck.eq(JSON.stringify(one[0]), JSON.stringify(s), "swingSectors(simple) : identique à swingSector");
    const two = RackDoorGeometry.swingSectors(w, d, false, { thickness_mm: 40, hinge: "left", leaves: 2 });
    ck.eq(two.length, 2, "swingSectors(double) : 2 secteurs");
    ck.eq(two[0].hx, -w / 2 + 40, "double : pivot 1 au bord gauche");
    ck.eq(two[1].hx, w / 2 - 40, "double : pivot 2 au bord droit");
    ck.eq(two[0].R, w / 2 - 40, "double : rayon = demi-largeur − épaisseur");
    ck.eq(two[0].R, two[1].R, "double : rayons égaux (demi-vantaux symétriques)");
    ck.eq(two[0].dirX, 1, "double : vantail gauche fermé vers +X (loquet au centre)");
    ck.eq(two[1].dirX, -1, "double : vantail droit fermé vers −X (loquet au centre)");
    // fin d'arc des DEUX vantaux : perpendiculaires, vers l'extérieur (−Y à l'avant)
    two.forEach((sec, i) => {
      const p = RackDoorGeometry.sectorPointsOf(sec, 4); const last = p[p.length - 1];
      ck(Math.abs(last.x - sec.hx) < 1e-6 && Math.abs(last.y - (sec.hy - sec.R)) < 1e-6, "double : vantail " + (i + 1) + " ouvert perpendiculaire, vers l'extérieur");
    });
  }
  });
};
