/* Tests modules — ÉTIQUETTES QR IMPRIMABLES (lot E du chantier étiquettes QR) : les modules
   PURS de l'impression, cf. docs/qr-scan.md § « Étiquettes imprimables » — la maquette
   design-system/briefs/qr-etiquettes-imprimables-maquette.html FAIT FOI pour les cotes :
     - core/LabelLayout : table des gabarits (golden), géométrie drapeau/manchon/QR seul,
                          cellule de planche ≠ étiquette, plafond de colonnes, capacité A4,
                          bornes du personnalisé, détection de débordement (CODES) ;
     - core/LabelQrSvg  : retravail du SVG servi par la route /qr — détection de la quiet
                          zone (marge en modules), compensation par padding blanc CALCULÉ,
                          mise à l'échelle en mm ;
     - core/LabelHtml   : rendu HTML partagé aperçu ⇄ imprimé (structure, échappement,
                          répétitions du manchon, planche, document d'impression) + les COTES
                          au millimètre (padding/gouttière ET largeurs de case de manchon posés
                          inline depuis LabelLayout — dont l'ÉGALITÉ STRICTE des cases) ;
     - core/LabelPrintPolicy : LA matrice de visibilité contextuelle (retours terrain 2026-08-20) —
                          offres par sujet, verdict (sujet × contenu × format × nombre), retombée
                          sur défaut d'un réglage mémorisé devenu invalide ;
     - core/LabelSubjects : la matière d'une étiquette depuis un enregistrement (sujet FAISCEAU).
   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D } = require("./harness.js");

module.exports = async () => {
  const { LabelLayout } = D("core/LabelLayout.js");
  const { LabelQrSvg } = D("core/LabelQrSvg.js");
  const { LabelHtml } = D("core/LabelHtml.js");
  const { LabelPrintPolicy } = D("core/LabelPrintPolicy.js");
  const { LabelSubjects } = D("core/LabelSubjects.js");

  /* Réglage de base : gabarit M, QR + texte, compact — les défauts de la modale. */
  const spec = (over = {}) => Object.assign({
    size: "m", content: "full", compact: true,
    qr: 20, custom: { w: 50, h: 25 }, dia: 6, len: 25, hasOwner: false,
  }, over);
  const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

  await section("labels : LabelPrintPolicy — le sujet SOUS-ÉQUIPEMENT (anatomie du spare)", async () => {
    // Pendant exact d'isFlagKind : la POLITIQUE ne distingue pas spare et sous-équipement.
    ck(LabelPrintPolicy.isSpareLike("spare"), "un spare est « petit matériel »");
    ck(LabelPrintPolicy.isSpareLike("subEquipment"), "un sous-équipement aussi");
    ck(!LabelPrintPolicy.isSpareLike("equipment"), "un équipement, non");
    ck(!LabelPrintPolicy.isSpareLike("cable"), "un câble non plus");
    ck.eq(LabelPrintPolicy.defaultSizeFor("subEquipment"), "s", "gabarit S par défaut, comme le spare");
    ck.eq(LabelPrintPolicy.sizesFor("subEquipment").join(","), "s,m,l,custom", "formats rectangulaires (ni drapeau ni « Baie »)");
    ck.eq(LabelPrintPolicy.contentsFor("subEquipment").join(","), "full,qr", "pas de manchon : ça ne s'enroule pas");
    // Les offres doivent être RIGOUREUSEMENT celles du spare — sans quoi « même famille » serait faux.
    ck.eq(JSON.stringify(LabelPrintPolicy.offeredFieldsFor("subEquipment")), JSON.stringify(LabelPrintPolicy.offeredFieldsFor("spare")), "mêmes champs offerts que le spare");
    ck.eq(JSON.stringify(LabelPrintPolicy.defaultFieldsFor("subEquipment")), JSON.stringify(LabelPrintPolicy.defaultFieldsFor("spare")), "mêmes cases cochées par défaut");
    ck(!LabelPrintPolicy.offeredFieldsFor("subEquipment").owner, "pas de propriétaire (le champ n'existe que sur les équipements)");
  });

  await section("labels : LabelSubjects — matière d'un SOUS-ÉQUIPEMENT", async () => {
    const store = { get: (collection, id) => (collection === "equipments" && id === "eq1" ? { id: "eq1", name: "SRV-01" } : null) };
    const full = LabelSubjects.subEquipment(store, { id: "se1", name: "Disque 3", equipment_id: "eq1", slot: "Baie 3", brand: "Seagate", model: "ST4000", serial: "ZC1ABC" });
    ck.eq(full.collection, "subEquipments", "collection du sujet");
    ck.eq(full.name, "Disque 3", "désignation");
    ck.eq(full.location, "SRV-01 · Baie 3", "emplacement = le MAÎTRE puis le repère");
    ck.eq(full.typeLabel, "Seagate ST4000", "type = marque + modèle (la collection n'a pas de champ `type`)");
    ck.eq(full.serial, "ZC1ABC", "n° de série");
    ck.eq(full.owner, undefined, "aucun propriétaire");
    // Champs vides : la ligne correspondante DISPARAÎT de l'étiquette (règle générale LabelHtml) —
    // on ne doit donc jamais fabriquer un « · » orphelin ni un libellé de substitution.
    const bare = LabelSubjects.subEquipment(store, { id: "se2", name: "Carte", equipment_id: "eq1" });
    ck.eq(bare.location, "SRV-01", "sans repère : le maître seul, sans séparateur pendant");
    ck.eq(bare.typeLabel, "", "sans marque ni modèle : type VIDE (pas de type inventé)");
    const orphan = LabelSubjects.subEquipment(store, { id: "se3", name: "Carte", equipment_id: "absent", slot: "S1" });
    ck.eq(orphan.location, "S1", "maître introuvable : le repère seul, jamais « ? »");
  });

  await section("labels : LabelLayout — table des gabarits (golden maquette)", async () => {
    // Les valeurs EXACTES du script SIZES de la maquette — tout écart est une régression de fidélité.
    ck.eq(JSON.stringify(LabelLayout.PRESETS.s), JSON.stringify({ qr: 18, w: 50, h: 20, cell: [50, 20] }), "S = 50×20, QR 18");
    ck.eq(JSON.stringify(LabelLayout.PRESETS.m), JSON.stringify({ qr: 20, w: 50, h: 30, cell: [48, 33] }), "M = 50×30, QR 20, cellule 48×33");
    ck.eq(JSON.stringify(LabelLayout.PRESETS.l), JSON.stringify({ qr: 28, w: 70, h: 40, cell: [70, 40] }), "L = 70×40, QR 28");
    ck.eq(JSON.stringify(LabelLayout.PRESETS.rack), JSON.stringify({ qr: 34, w: 100, h: 60, cell: [100, 60] }), "Baie = 100×60, QR 34");
    ck.eq(JSON.stringify(LabelLayout.PRESETS.cable), JSON.stringify({ qr: 18, w: 62, h: 22, cell: [62, 22] }), "Câble (drapeau confort) = 62×22, QR 18");
    ck.eq(LabelLayout.QR_FLOOR_MM, 18, "plancher de scannabilité = 18 mm");
    // La taille de QR est IMPOSÉE par les préréglages, LIBRE en qr-only/câble/personnalisé.
    ck.eq(LabelLayout.qrSizeOf(spec()), 20, "M impose son QR 20 (le spec.qr est ignoré)");
    ck.eq(LabelLayout.qrSizeOf(spec({ qr: 44 })), 20, "M impose son QR même si spec.qr diverge");
    ck.eq(LabelLayout.qrSizeOf(spec({ content: "qr", qr: 26 })), 26, "QR seul : taille libre");
    ck.eq(LabelLayout.qrSizeOf(spec({ size: "custom", qr: 15 })), 15, "personnalisé : taille libre");
    ck.eq(LabelLayout.qrSizeOf(spec({ size: "cable", qr: 22 })), 22, "câble : taille libre");
  });

  await section("labels : LabelLayout — géométrie drapeau / manchon / QR seul (dérivées maquette)", async () => {
    // DRAPEAU compact QR 18 : padding NUL depuis l'amendement des densités (2026-08-20 — seule la
    // quiet zone du SVG garde le QR) → panneaux 22, zone 10, hauteur = le QR lui-même : 54 × 18.
    const fc = LabelLayout.flagGeometry(18, true);
    ck.eq(JSON.stringify(fc), JSON.stringify({ pad: 0, wz: 10, pan: 22, h: 18, w: 54 }), "drapeau compact q18 = 54 × 18 (padding nul, pan 22, wz 10)");
    // DRAPEAU confort QR 18 : 62 × 22 — la cote nominale de la table (l'aisance de la maquette, INCHANGÉE).
    const ff = LabelLayout.flagGeometry(18, false);
    ck.eq(JSON.stringify(ff), JSON.stringify({ pad: 2, wz: 12, pan: 25, h: 22, w: 62 }), "drapeau confort q18 = 62 × 22 (la table)");
    // Un QR plus grand DILATE le panneau (géométrie DÉRIVÉE du QR, jamais figée).
    const fb = LabelLayout.flagGeometry(28, true);
    ck(near(fb.pan, 28) && near(fb.w, 66) && near(fb.h, 28), "drapeau compact q28 : panneau 28 → 66 de large");
    // MANCHON — géométrie AMENDÉE le 2026-08-20 (cf. section dédiée plus bas pour les goldens
    // par Ø et les invariants) : 1,5 tour, le demi-tour excédentaire SERT de recouvrement.
    const sc = LabelLayout.sleeveGeometry(6, 25);
    ck(near(sc.w, 28.274, 0.001), "manchon Ø6 : largeur 28,27 mm (1,5 tour)");
    ck(near(sc.turn, Math.PI * 6, 1e-9), "manchon : un tour = π·Ø");
    ck.eq(sc.h, 25, "manchon : hauteur = longueur le long du câble");
    // QR SEUL : carré (QR + marges), la bande propriétaire s'ajoute SOUS le carré. Compact = le QR
    // NU (padding nul, densités amendées) ; confort = les marges de la maquette.
    ck.eq(LabelLayout.qrOnlyGeometry(20, true, false).side, 20, "QR seul compact sans owner : le QR nu (20)");
    ck(near(LabelLayout.qrOnlyGeometry(20, true, true).side, 24), "QR seul compact + owner : 24 (20 + gouttière 0,4 + bande 3,6)");
    ck(near(LabelLayout.qrOnlyGeometry(20, false, true).side, 29.8), "QR seul confort + owner : 29,8");
    // labelDims agrège le tout.
    ck.eq(JSON.stringify(LabelLayout.labelDims(spec())), JSON.stringify([50, 30]), "dims M = 50×30");
    ck.eq(JSON.stringify(LabelLayout.labelDims(spec({ size: "custom", custom: { w: 38, h: 16 } }))), JSON.stringify([38, 16]), "dims personnalisé = cotes saisies");
    ck.eq(JSON.stringify(LabelLayout.labelDims(spec({ content: "qr", qr: 20 }))), JSON.stringify([20, 20]), "dims QR seul = carré");
    const sd = LabelLayout.labelDims(spec({ size: "cable", content: "strip" }));
    ck(near(sd[0], 28.274, 0.001) && sd[1] === 25, "dims manchon = géométrie du manchon (1,5 tour à Ø 6)");
    const fd = LabelLayout.labelDims(spec({ size: "cable", qr: 18 }));
    ck(near(fd[0], 54) && near(fd[1], 18), "dims drapeau compact = 54 × 18");
    // Classe de police du personnalisé : suit le gabarit le plus proche (frontières maquette).
    ck.eq(LabelLayout.fontClassForHeight(16), "s", "h 16 → police S");
    ck.eq(LabelLayout.fontClassForHeight(25), "m", "h 25 → police M (frontière)");
    ck.eq(LabelLayout.fontClassForHeight(36), "l", "h 36 → police L (frontière)");
    ck.eq(LabelLayout.fontClassForHeight(50), "rack", "h 50 → police Baie (frontière)");
  });

  await section("labels : LabelLayout — planche A4 (cellule ≠ étiquette, plafonds, capacité)", async () => {
    // La CELLULE des préréglages « QR + texte » vient de la table (M : 48×33 → 4 col. et 8 rangées = 32,
    // l'annonce de la maquette) ; les autres modes prennent leurs dimensions réelles.
    ck.eq(JSON.stringify(LabelLayout.cellDims(spec())), JSON.stringify([48, 33]), "cellule M = 48×33 (pas 50×30)");
    ck.eq(JSON.stringify(LabelLayout.cellDims(spec({ content: "qr", qr: 20 }))), JSON.stringify([20, 20]), "cellule QR seul = dims réelles");
    ck.eq(LabelLayout.maxColumns(spec()), 4, "M : 4 colonnes max (4×48 = 192 ≤ 194)");
    ck.eq(LabelLayout.maxColumns(spec({ size: "s" })), 3, "S (cellule 50) : 3 colonnes max");
    ck.eq(LabelLayout.maxColumns(spec({ size: "l" })), 2, "L (70) : 2 colonnes max");
    ck.eq(LabelLayout.maxColumns(spec({ size: "rack" })), 1, "Baie (100) : 1 colonne");
    ck.eq(LabelLayout.maxColumns(spec({ size: "cable", qr: 18 })), 3, "drapeau compact (54) : 3 colonnes");
    /* Colonnes OFFERTES (retour terrain 2026-08-25 : « on gagne de la place, il faut plus de
       4 colonnes »). La liste était figée à [2,3,4] dans l'UI ; elle se DÉDUIT désormais de la
       capacité réelle — et « 1 colonne » y figure, seul choix possible pour une étiquette de baie.
       Le plafond d'AFFICHAGE (MAX_SHEET_COLUMNS) est une borne d'interface, pas une borne physique. */
    ck.eq(LabelLayout.columnChoices(spec()).join(","), "1,2,3,4", "M : 1 à 4 colonnes offertes");
    ck.eq(LabelLayout.columnChoices(spec({ size: "rack" })).join(","), "1", "Baie : une seule colonne — la liste sait le dire");
    // Manchon de 28,27 mm : 6 colonnes tiennent maintenant que la cellule épouse l'étiquette.
    const sleeve = spec({ size: "cable", content: "strip", dia: 6, len: 25 });
    ck.eq(LabelLayout.maxColumns(sleeve), 6, "manchon Ø6 (28,27) : 6 colonnes tiennent dans 194 mm");
    ck.eq(LabelLayout.columnChoices(sleeve).join(","), "1,2,3,4,5,6", "…et les 6 sont proposées");
    // Borne d'AFFICHAGE : une étiquette minuscule en logerait plus, le sélecteur s'arrête.
    const tiny = spec({ size: "custom", custom: { w: 12, h: 10 } });
    ck(LabelLayout.maxColumns(tiny) > LabelLayout.MAX_SHEET_COLUMNS, "le papier accepterait plus que le plafond d'affichage");
    ck.eq(LabelLayout.columnChoices(tiny).length, LabelLayout.MAX_SHEET_COLUMNS, "…mais la liste s'arrête au plafond d'affichage");
    // 🚨 Le TRAIT DE COUPE occupe de la place (cellule en content-box) : la capacité en tient compte.
    ck.eq(LabelLayout.CUT_MM, 0.2, "épaisseur du trait de coupe");
    ck(LabelLayout.maxColumns(spec()) * (LabelLayout.cellDims(spec())[0] + LabelLayout.CUT_MM) + LabelLayout.CUT_MM <= LabelLayout.A4_W - 2 * LabelLayout.A4_MARGIN, "une rangée pleine, traits compris, tient dans la largeur utile");
    // Capacité : M en 4 colonnes = 4 × 8 = 32 par feuille — 33 étiquettes → 2 feuilles.
    const m4 = LabelLayout.sheetLayout(spec(), 4, 33);
    ck.eq(JSON.stringify([m4.cols, m4.rows, m4.perPage, m4.pages, m4.capped]), JSON.stringify([4, 8, 32, 2, false]), "M ×4 col : 32/feuille, 33 → 2 feuilles");
    ck.eq(LabelLayout.sheetLayout(spec(), 3, 24).perPage, 24, "M ×3 col : 24/feuille");
    // Plafonnement : demander 4 colonnes de L (70 mm) est ramené à 2 — et signalé (capped).
    const l4 = LabelLayout.sheetLayout(spec({ size: "l" }), 4, 12);
    ck.eq(JSON.stringify([l4.cols, l4.rows, l4.perPage, l4.pages, l4.capped]), JSON.stringify([2, 6, 12, 1, true]), "L ×4 demandées → 2 col plafonnées, 12/feuille");
    ck.eq(LabelLayout.sheetLayout(spec({ size: "rack" }), 4, 5).rows, 4, "Baie : 4 rangées (275/60)");
  });

  await section("labels : LabelLayout — bornes du personnalisé + détection de débordement (codes)", async () => {
    // Bornes des champs de la maquette : on RAMÈNE, on ne refuse pas (politique QrCodeParams).
    ck.eq(LabelLayout.clampCustom("w", 300), 210, "largeur plafonnée à 210");
    ck.eq(LabelLayout.clampCustom("w", 5), 20, "largeur plancher 20");
    ck.eq(LabelLayout.clampCustom("h", 400), 297, "hauteur plafonnée à 297");
    ck.eq(LabelLayout.clampCustom("qr", 8), 12, "QR plancher 12");
    ck.eq(LabelLayout.clampCustom("qr", 100), 60, "QR plafonné à 60");
    ck.eq(LabelLayout.clampCustom("dia", 1), 3, "Ø plancher 3");
    ck.eq(LabelLayout.clampCustom("len", 200), 60, "longueur plafonnée à 60");
    ck.eq(LabelLayout.clampCustom("qr", NaN), 12, "valeur non numérique → borne basse");
    // Avertissements — des CODES, jamais des chaînes (l'UI traduit).
    ck.eq(LabelLayout.warnings(spec(), { count: 1, requestedCols: 4 }).length, 0, "M unitaire : aucun avertissement");
    ck(LabelLayout.warnings(spec({ size: "custom", qr: 14 }), { count: 1, requestedCols: 4 }).includes("qr-floor"), "QR 14 < 18 → qr-floor");
    // Débordement du PERSONNALISÉ : il n'est JAMAIS clampé (l'utilisateur contrôle ses cotes), on
    // l'AVERTIT — avec le padding RÉEL de sa densité (en compact il est nul : un QR de 16 dans 16 mm
    // TIENT, et rien ne doit être signalé ; c'est en confort que les 1,5 mm de marge le font déborder).
    const tight = LabelLayout.warnings(spec({ size: "custom", compact: false, qr: 16, custom: { w: 30, h: 16 } }), { count: 1, requestedCols: 4 });
    ck(tight.includes("qr-exceeds-label"), "confort : QR 16 + 2 × 1,5 mm > hauteur 16 → qr-exceeds-label");
    ck(!LabelLayout.warnings(spec({ size: "custom", qr: 16, custom: { w: 30, h: 16 } }), { count: 1, requestedCols: 4 }).includes("qr-exceeds-label"), "compact (marges nulles) : le même QR 16 tient dans 16 mm");
    ck(tight.includes("qr-floor"), "…et toujours sous le plancher (les deux codes coexistent)");
    ck(LabelLayout.warnings(spec(), { count: 40, requestedCols: 4 }).includes("multi-page"), "40 étiquettes M > 32 → multi-page");
    const lw = LabelLayout.warnings(spec({ size: "l" }), { count: 12, requestedCols: 4 });
    ck(lw.includes("columns-capped") && !lw.includes("multi-page"), "L ×4 demandées → columns-capped (et 12 tiennent sur 1 feuille)");
    // Manchon : estimation du texte LONGITUDINAL (identifiant mono 8 pt) contre la longueur.
    const sleeveOk = LabelLayout.warnings(spec({ size: "cable", content: "strip" }), { count: 1, requestedCols: 3, longestIdLength: 10 });
    ck.eq(sleeveOk.length, 0, "manchon 25 mm, id 10 car. (~19,5) : rien à signaler");
    ck(LabelLayout.warnings(spec({ size: "cable", content: "strip" }), { count: 1, requestedCols: 3, longestIdLength: 20 }).includes("sleeve-tight"), "id 20 car. (~37) > 25 → sleeve-tight");
    ck(!LabelLayout.warnings(spec({ size: "cable", content: "id", qr: 12 }), { count: 1, requestedCols: 3, longestIdLength: 4 }).includes("qr-floor"), "manchon : jamais de qr-floor (pas de QR)");
  });

  /* SVG de la forme émise par la lib `qrcode` (fond blanc plein cadre + chemin sombre à M<marge>). */
  const QR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 33 33" shape-rendering="crispEdges"><path fill="#ffffff" d="M0 0h33v33H0z"/><path stroke="#000000" d="M4 4.5h7m1 0h1m2 0h2"/></svg>';

  await section("labels : LabelQrSvg — quiet zone détectée, compensée si insuffisante, cote en mm", async () => {
    ck.eq(LabelQrSvg.detectMarginModules(QR_SVG), 4, "marge de la lib qrcode détectée = 4 modules (chemin sombre à M4)");
    ck.eq(JSON.stringify(LabelQrSvg.parseViewBox(QR_SVG)), JSON.stringify([0, 0, 33, 33]), "viewBox lu");
    const scaled = LabelQrSvg.scaleToMm(QR_SVG, 20);
    ck(scaled.includes('width="20mm"') && scaled.includes('height="20mm"'), "mise à l'échelle : 20mm × 20mm");
    ck(scaled.includes('viewBox="0 0 33 33"'), "marge suffisante (4) → viewBox INTACT, aucune compensation");
    ck(!/rect x="-/.test(scaled), "…et aucun fond de compensation ajouté");
    // Marge INSUFFISANTE (0 module) : le viewBox s'élargit de 4 modules par côté et un fond
    // blanc plein cadre est repeint — padding CALCULÉ, jamais un `?size=` plus grand (sans effet).
    const bare = '<svg viewBox="0 0 25 25"><path fill="#ffffff" d="M0 0h25v25H0z"/><path stroke="#000000" d="M0 0.5h7m2 0h3"/></svg>';
    ck.eq(LabelQrSvg.detectMarginModules(bare), 0, "marge nulle détectée");
    const padded = LabelQrSvg.scaleToMm(bare, 18);
    ck(padded.includes('viewBox="-4 -4 33 33"'), "compensation : viewBox élargi de 4 modules par côté");
    ck(padded.includes('<rect x="-4" y="-4" width="33" height="33" fill="#ffffff"/>'), "compensation : fond blanc plein cadre repeint");
    ck(padded.includes('width="18mm"'), "…et la cote mm posée");
    // Attributs px existants ÉCRASÉS par la cote mm (le serveur émet width/height quand ?size= est passé).
    const sized = LabelQrSvg.scaleToMm('<svg width="256" height="256" viewBox="0 0 33 33"><path stroke="#000000" d="M4 4.5h7"/></svg>', 20);
    ck(!sized.includes('"256"') && sized.includes('width="20mm"'), "width/height px remplacés par la cote mm");
    // Défensif : un SVG inattendu est mis à l'échelle SANS compensation (jamais de crash).
    ck(LabelQrSvg.scaleToMm("<svg></svg>", 18).includes('width="18mm"'), "SVG inattendu : cote posée, pas de crash");
    ck.eq(LabelQrSvg.detectMarginModules("<svg></svg>"), null, "pas de chemin sombre → marge inconnue (null)");
    /* 🚨 RENDU CRISP (retour terrain 2026-08-25) : la lib dessine les rangées de modules au
       TRAIT (`M4 4.5h7`, d'où le demi-module). Anti-aliasées puis ramenées sur la grille de
       sortie, ces rangées s'amincissent — au plus petit gabarit, le QR IMPRIMÉ paraissait
       « rogné ». `crispEdges` colle les arêtes à la grille sans lisser. */
    ck(scaled.includes('shape-rendering="crispEdges"'), "rendu CRISP imposé (rangées de modules jamais amincies)");
    ck(LabelQrSvg.scaleToMm("<svg></svg>", 18).includes('shape-rendering="crispEdges"'), "…y compris sur un SVG inattendu");
    // Un attribut déjà présent est ÉCRASÉ, jamais doublé (le SVG resterait invalide).
    const reRendered = LabelQrSvg.scaleToMm('<svg shape-rendering="auto" viewBox="0 0 33 33"><path stroke="#000000" d="M4 4.5h7"/></svg>', 12);
    ck.eq((reRendered.match(/shape-rendering=/g) || []).length, 1, "un shape-rendering existant est remplacé, pas dupliqué");
    ck(!reRendered.includes('"auto"'), "…et c'est bien `crispEdges` qui gagne");
  });

  await section("labels : LabelHtml — rendu partagé aperçu ⇄ imprimé (structure, échappement)", async () => {
    const subject = { collection: "equipments", id: "e1", name: "SRV-<PROD>&01", location: "B12 · U18-U19", typeLabel: "Serveur · R650", serial: "7KJ2X91", owner: "ACME & Co" };
    const allFields = { location: true, type: true, serial: true, owner: true };
    const qr = '<svg data-qr="1"></svg>';
    const m = LabelHtml.label(subject, spec(), allFields, qr);
    ck(m.includes('class="lab m compact"'), "gabarit M compact : classes posées");
    ck(m.includes("width:50mm;height:30mm"), "cotes inline en mm");
    ck(m.includes("SRV-&lt;PROD&gt;&amp;01"), "identifiant ÉCHAPPÉ (entrée non sûre)");
    ck(m.includes("B12 · U18-U19") && m.includes("SN 7KJ2X91"), "emplacement + n° de série rendus");
    ck(m.includes("ACME &amp; Co"), "propriétaire rendu (case cochée + owner de l'enregistrement)");
    ck(m.includes('data-qr="1"'), "le SVG de QR est inliné tel quel");
    // Case « Propriétaire » décochée OU owner vide → ligne ABSENTE (décision E).
    ck(!LabelHtml.label(subject, spec(), { ...allFields, owner: false }, qr).includes("l-own"), "owner décoché → pas de ligne l-own");
    ck(!LabelHtml.label({ ...subject, owner: "" }, spec(), allFields, qr).includes("l-own"), "owner vide → pas de ligne l-own");
    // Gabarit S : type et n° de série JAMAIS rendus (rien d'autre que nom+emplacement n'y tient).
    const s = LabelHtml.label(subject, spec({ size: "s" }), allFields, qr);
    ck(!s.includes("l-meta") && !s.includes("l-sn"), "S : type/série supprimés même cochés");
    // Grands gabarits : filet séparateur avant le registre secondaire.
    ck(LabelHtml.label(subject, spec({ size: "l" }), allFields, qr).includes('class="rule"'), "L : filet séparateur");
    // Planche : les cotes de la CELLULE priment (l'étiquette s'y étire).
    ck(LabelHtml.label(subject, spec(), allFields, qr, [48, 33]).includes("width:48mm;height:33mm"), "dims de cellule imposées sur planche");
    // QR seul : carré, bande propriétaire optionnelle.
    const qOnly = LabelHtml.label(subject, spec({ content: "qr", qr: 20, hasOwner: true }), allFields, qr);
    ck(qOnly.includes("qronly") && qOnly.includes("width:24mm;height:24mm"), "QR seul + owner : carré 24");
    // Câble : drapeau (2 panneaux + zone hachurée), manchons ×2 / ×6.
    const cable = { collection: "cables", id: "c1", name: "CBL-004821", endA: "SRV · P1", endB: "SW · Gi1/0/12", typeLabel: "Cat 6a · 3 m" };
    const flag = LabelHtml.label(cable, spec({ size: "cable", qr: 18 }), allFields, qr);
    ck((flag.match(/class="pan/g) || []).length === 2 && flag.includes('class="wz"'), "drapeau : 2 panneaux + zone d'enroulement");
    ck((flag.match(/data-qr="1"/g) || []).length === 1, "drapeau QR+texte : UN QR (panneau A)");
    ck((LabelHtml.label(cable, spec({ size: "cable", content: "qr", qr: 18 }), allFields, qr).match(/data-qr="1"/g) || []).length === 2, "drapeau QR seul : QR des DEUX côtés");
    ck.eq((LabelHtml.label(cable, spec({ size: "cable", content: "strip" }), allFields, "").match(/cell2/g) || []).length, 2, "manchon repère complet : 2 panneaux");
    // ×6 figé AVANT le retour terrain ; le compte est désormais DÉDUIT du Ø (4 cases à Ø 6).
    ck.eq((LabelHtml.label(cable, spec({ size: "cable", content: "id" }), allFields, "").match(/cell2/g) || []).length, 4, "manchon identifiant seul à Ø 6 : 4 cases sur le tour");
    // Planche + document d'impression.
    const page = LabelHtml.sheetPage(["<i>a</i>", "<i>b</i>"], { cols: 4, cellW: 48, cellH: 33 }, { source: "Baie B12 · contenu", headRight: "2 étiquettes", cuts: true });
    ck(page.includes("grid-template-columns:repeat(4,auto)") && page.includes("a4-head"), "planche : grille + en-tête hors zone");
    /* 🚨 Le rectangle de coupe ÉPOUSE l'étiquette (retour terrain 2026-08-25) : des colonnes
       `1fr` faisaient 194/cols mm quelle que soit l'étiquette, un manchon de 28 mm s'y
       retrouvait centré dans 65 mm — couper sur les traits laissait du papier mort. */
    ck(page.includes("width:48mm;height:33mm"), "la cellule porte la LARGEUR réelle, pas seulement la hauteur");
    ck(!page.includes("1fr"), "…et plus aucune piste `1fr` qui étirerait la cellule");
    ck(!page.includes("nocut"), "traits de coupe actifs par défaut");
    ck(LabelHtml.sheetPage(["x"], { cols: 2, cellW: 30, cellH: 20 }, { source: "s", headRight: "r", cuts: false }).includes("nocut"), "traits de coupe désactivables");
    /* 🚨 TRAITS DE COUPE : UN trait par ARÊTE (retour terrain 2026-08-25). Une bordure sur
       les 4 côtés faisait se toucher le bord droit d'une cellule et le bord gauche de la
       suivante — trait intérieur deux fois plus épais que le pourtour, et pointillés
       déphasés. Seules la 1re RANGÉE et la 1re COLONNE peignent le bord manquant. */
    const grid = LabelHtml.sheetPage(["a", "b", "c", "d", "e"], { cols: 2, cellW: 30, cellH: 20 }, { source: "s", headRight: "r", cuts: true });
    const cellClasses = (grid.match(/class="cell[^"]*"/g) || []).map((c) => c.slice(7, -1).trim());
    ck.eq(cellClasses.join(" | "), "cell cut-t cut-l | cell cut-t | cell cut-l | cell | cell cut-l", "coin, 1re rangée, 1re colonne — le reste nu");
    ck.eq((grid.match(/cut-t/g) || []).length, 2, "le bord HAUT n'est peint que par la 1re rangée (2 colonnes)");
    ck.eq((grid.match(/cut-l/g) || []).length, 3, "le bord GAUCHE n'est peint que par la 1re colonne (3 rangées)");
    ck(!grid.includes("nocut"), "…et les classes d'arête ne réactivent pas `nocut`");
    const doc = LabelHtml.printDocument({ title: "T<est>", pageSize: "50mm 30mm", pagesHtml: "<div class=\"unit\">x</div>" });
    ck(doc.includes("@page{size:50mm 30mm;margin:0}"), "unitaire : @page à la taille EXACTE de l'étiquette");
    ck(doc.includes(".label-render .lab{background:#fff"), "print-CSS embarquée (noir sur blanc, aucune variable de thème)");
    ck(!doc.includes("var(--fg"), "aucun token de thème dans l'imprimé");
    /* 🚨 Sans `print-color-adjust:exact`, le navigateur SUPPRIME les images de fond à
       l'impression : les zones de recouvrement (hachures en repeating-linear-gradient)
       sortaient BLANCHES alors qu'elles s'affichaient à l'aperçu. */
    ck(doc.includes("print-color-adjust:exact"), "les fonds hachurés sont IMPRIMÉS (print-color-adjust)");
    ck(doc.includes("-webkit-print-color-adjust:exact"), "…avec le préfixe -webkit- (Safari/Chrome anciens)");
    /* 🚨 `content-box` sur la cellule : en `border-box`, le trait de coupe de 0,2 mm était PRIS
       SUR elle — le contenu tombait à 24,8 mm pour une étiquette de 25, qui débordait et
       arrivait au contact du trait (l'enfant est peint APRÈS la bordure de son parent). */
    ck(doc.includes(".label-render .a4 .cell{position:relative;box-sizing:content-box"), "la cellule est en content-box (cote = celle de l'étiquette) et sert d'ancre au trait");
    ck(doc.includes("justify-content:start"), "grille calée à GAUCHE (sinon les pistes `auto` s'étirent, et le 1fr revient)");
    /* 🚨 Traits de coupe SOLIDES : un pointillé de 0,2 mm fait ~50 tirets par bord, dont le
       rasteur d'impression escamote — « les traits sautent par endroits », invisible à l'écran. */
    /* 🚨 Le trait est porté par un ::after ABSOLU, pas par la bordure de la cellule : une BORDURE se
       peint dans la couche « fond/bordure du parent », donc SOUS son contenu — le blanc de l'étiquette
       (ou les bandes #fff du dégradé hachuré) la recouvrait à l'impression. Un pseudo-élément positionné
       se peint APRÈS le contenu en flux : plus rien ne peut le masquer. */
    ck(doc.includes(".a4 .cell::after{content:\"\";position:absolute"), "le trait de coupe est une couche POSÉE PAR-DESSUS l'étiquette");
    ck(doc.includes("border:0 solid #999"), "traits SOLIDES (un pointillé se raccorde mal d'une cellule à l'autre)");
    ck(!/\.a4 \.cell\{[^}]*border/.test(doc), "…et la cellule elle-même ne porte PLUS de bordure (elle passerait sous le contenu)");
    ck(!/\.a4 \.cell\{[^}]*overflow:hidden/.test(doc), "…ni overflow:hidden, qui rognerait le débord du trait");
    ck(doc.includes(".a4 .cell.nocut::after{content:none}"), "traits désactivables : la couche entière disparaît");
    /* 🚨 Typographie STABLE à l'impression : le navigateur refait la mise en page contre les
       métriques de l'imprimante. Familles CONCRÈTES (`system-ui`/`ui-monospace` sont résolues par
       le système, donc pas forcément la même police des deux côtés), avances EXACTES, chiffres de
       largeur ÉGALE, et plus aucun crénage fractionnaire négatif (il s'arrondissait par paire). */
    ck(!doc.includes("system-ui") && !doc.includes("ui-monospace"), "aucune famille RÉSOLUE PAR LE SYSTÈME dans les piles");
    ck(doc.includes("text-rendering:geometricPrecision"), "avances de glyphes EXACTES, non ajustées à la grille");
    ck(doc.includes("font-variant-numeric:tabular-nums"), "chiffres de largeur ÉGALE quelle que soit la police retenue");
    ck(doc.includes("font-kerning:none"), "crénage désactivé");
    ck(!/letter-spacing:-/.test(doc), "aucun crénage fractionnaire NÉGATIF (il s'arrondissait différemment par paire)");
    ck(doc.includes("T&lt;est&gt;"), "titre du document échappé");
  });

  /* ============================================================================================
     RETOURS TERRAIN DU 2026-08-20 — les quatre volets vérifiés ci-dessous :
       (1) densités amendées + NON-DÉBORDEMENT du QR (bug du format S à l'impression) ;
       (2) cotes calculées retrouvées AU MILLIMÈTRE dans le HTML, et fenêtre d'impression sans
           la moindre marge parasite ;
       (3) LA matrice de visibilité contextuelle (`core/LabelPrintPolicy`) ;
       (4) le sujet FAISCEAU (nouveau point d'entrée listing + fiche).
     ============================================================================================ */

  await section("labels : LabelLayout — densités amendées + le QR d'un préréglage NE DÉBORDE JAMAIS", async () => {
    // DOCTRINE : compact = marges NULLES (la quiet zone du SVG suffit à garder le QR) ; confort =
    // l'aisance de la maquette (1,5 en S/M, 3 en L, 4 en Baie ; gouttières 2/3/5).
    ck.eq(LabelLayout.rectPadding("m", true), 0, "compact : padding nul");
    ck.eq(LabelLayout.rectGap("m", true), 0, "compact : gouttière nulle");
    ck.eq(LabelLayout.rectPadding("s", false), 1.5, "confort S : 1,5 mm");
    ck.eq(LabelLayout.rectPadding("l", false), 3, "confort L : 3 mm");
    ck.eq(LabelLayout.rectPadding("rack", false), 4, "confort Baie : 4 mm");
    ck.eq(LabelLayout.rectGap("rack", false), 5, "confort Baie : gouttière 5 mm");

    // 🚨 LE BUG MESURÉ : S confort = QR 18 dans 20 mm de haut. Avec 1,5 mm de marge en haut ET en
    // bas, 18 + 3 = 21 > 20 → le SVG débordait et se faisait rogner à l'impression. La règle est
    // que c'est la MARGE qui cède, jamais la scannabilité.
    const sComfort = LabelLayout.rectQrGeometry(spec({ size: "s", compact: false }));
    ck.eq(sComfort.qr, 18, "S confort : le QR garde ses 18 mm (plancher de scannabilité)");
    ck.eq(sComfort.padV, 1, "S confort : c'est la marge VERTICALE qui cède (1 mm au lieu de 1,5)");
    ck.eq(sComfort.padH, 1.5, "S confort : la marge HORIZONTALE, elle, n'a aucune raison de céder");
    ck(sComfort.qr + 2 * sComfort.padV <= 20, "S confort : 18 + 2 × 1 = 20 → tient EXACTEMENT dans la hauteur");

    // NON-DÉBORDEMENT SYSTÉMATIQUE : tous les préréglages rectangulaires × les DEUX densités,
    // à la cote NOMINALE (unitaire) comme à la cote de CELLULE (planche).
    for (const size of ["s", "m", "l", "rack"]) {
      for (const compact of [true, false]) {
        const sp = spec({ size, compact });
        const tag = size.toUpperCase() + (compact ? " compact" : " confort");
        const [w, h] = LabelLayout.labelDims(sp);
        const g = LabelLayout.rectQrGeometry(sp);
        ck(g.qr + 2 * g.padV <= h + 1e-9, tag + " : QR + marges verticales ≤ hauteur (" + h + ")");
        ck(g.qr + 2 * g.padH <= w + 1e-9, tag + " : QR + marges horizontales ≤ largeur (" + w + ")");
        ck.eq(g.qr, LabelLayout.qrSizeOf(sp), tag + " : le préréglage garde SA cote de QR (jamais rognée)");
        // Sur une PLANCHE, la hauteur est celle de la CELLULE (jamais plus serrée qu'à l'unité).
        const cellH = LabelLayout.cellDims(sp)[1];
        const gc = LabelLayout.rectQrGeometry(sp, cellH);
        ck(gc.qr + 2 * gc.padV <= cellH + 1e-9, tag + " sur planche : QR + marges ≤ cellule (" + cellH + ")");
        // Et la cote SERVIE au SVG passe par ce clamp — c'est LE point de passage unique de l'UI.
        ck.eq(LabelLayout.renderQrMm(sp), g.qr, tag + " : renderQrMm = la cote clampée");
        ck.eq(LabelLayout.renderQrMm(sp, cellH), gc.qr, tag + " sur planche : renderQrMm suit la cellule");
      }
    }
    // Anatomies à géométrie DÉRIVÉE du QR (drapeau, manchon, QR seul) : la cote servie reste celle
    // demandée — leur boîte est construite AUTOUR du QR, elle ne peut pas être trop petite.
    ck.eq(LabelLayout.renderQrMm(spec({ size: "cable", qr: 22 })), 22, "drapeau : la cote demandée est servie telle quelle");
    ck.eq(LabelLayout.renderQrMm(spec({ content: "qr", qr: 26 })), 26, "QR seul : la cote demandée est servie telle quelle");
    // Le PERSONNALISÉ n'est pas clampé (l'utilisateur contrôle ses cotes — il est AVERTI, cf. warnings).
    ck.eq(LabelLayout.renderQrMm(spec({ size: "custom", qr: 40, custom: { w: 30, h: 20 } })), 40, "personnalisé : jamais clampé (l'avertissement fait foi)");
  });

  await section("labels : LabelHtml — les cotes calculées se retrouvent AU MILLIMÈTRE (marges de l'imprimé)", async () => {
    const subject = { collection: "equipments", id: "e1", name: "SRV-01", location: "B12", typeLabel: "Serveur", serial: "X1", owner: "ACME" };
    const allFields = { location: true, type: true, serial: true, owner: true };
    const qr = '<svg data-qr="1"></svg>';
    // COMPACT = zéro marge : c'est le retour « énormément de marges ». Le padding/la gouttière sont
    // posés INLINE (plus dans le CSS de classe) précisément pour être vérifiables ici.
    const compact = LabelHtml.label(subject, spec(), allFields, qr);
    ck(compact.includes("padding:0mm 0mm;gap:0mm"), "M compact : padding et gouttière NULS dans le HTML");
    // CONFORT = les cotes de la table des densités, au millimètre.
    const comfort = LabelHtml.label(subject, spec({ compact: false }), allFields, qr);
    ck(comfort.includes("padding:1.5mm 1.5mm;gap:2mm"), "M confort : 1,5 mm de marge, 2 mm de gouttière");
    ck(LabelHtml.label(subject, spec({ size: "l", compact: false }), allFields, qr).includes("padding:3mm 3mm;gap:3mm"), "L confort : 3 mm de marge et de gouttière");
    ck(LabelHtml.label(subject, spec({ size: "rack", compact: false }), allFields, qr).includes("padding:4mm 4mm;gap:5mm"), "Baie confort : 4 mm de marge, 5 de gouttière");
    // S confort : la marge verticale CÉDÉE se retrouve telle quelle dans le HTML (anti-débordement).
    ck(LabelHtml.label(subject, spec({ size: "s", compact: false }), allFields, qr).includes("padding:1mm 1.5mm"), "S confort : marge verticale ramenée à 1 mm dans le HTML");
    // Sur une PLANCHE, c'est la hauteur de CELLULE qui donne la marge (plus d'air, mêmes règles).
    ck(LabelHtml.label(subject, spec({ size: "s", compact: false }), allFields, qr, [50, 33]).includes("padding:1.5mm 1.5mm"), "cellule plus haute : la marge de confort reprend ses 1,5 mm");
    // Le CSS partagé ne porte PLUS de padding/gap d'étiquette (sinon les cotes ci-dessus seraient un leurre).
    ck(!/\.lab\{[^}]*padding/.test(LabelHtml.CSS), "aucun padding d'étiquette laissé dans le CSS de classe");
    ck(!/\.lab\.compact\{[^}]*padding/.test(LabelHtml.CSS), "…ni dans la variante compacte");

    // FENÊTRE D'IMPRESSION : ni marge de page, ni marge de document — les cotes de l'étiquette sont
    // la SEULE géométrie qui compte (imprimante à rouleau : une marge de body décalerait tout).
    const unit = LabelHtml.printDocument({ title: "t", pageSize: "54mm 18mm", pagesHtml: "<div class=\"unit\">x</div>" });
    ck(unit.includes("html,body{margin:0;padding:0;background:#fff}"), "iframe d'impression : html/body sans marge NI padding");
    ck(unit.includes("@page{size:54mm 18mm;margin:0}"), "unitaire : @page margin 0 à la cote exacte");
    const sheet = LabelHtml.printDocument({ title: "t", pageSize: "A4", pagesHtml: "<div class=\"a4\">x</div>" });
    ck(sheet.includes("@page{size:A4;margin:0}"), "planche : @page margin 0 (la marge de 8 mm est celle de la GRILLE, pas de la page)");
    ck(sheet.includes(".label-render .a4{width:210mm;height:297mm;background:#fff;padding:8mm"), "planche : les 8 mm de marge utile vivent dans la grille A4");
  });

  /* ============================================================================================
     RETOURS TERRAIN DU 2026-08-20 (2e vague — sur ÉTIQUETTES IMPRIMÉES) : la GÉOMÉTRIE DES
     MANCHONS. Deux volets, qui AMENDENT tous deux la maquette :
       (1) ENROULEMENT — « 1.5 × le diamètre est OK sinon on a trop de papier à coller » : la
           bande fait 1,5 TOUR et le demi-tour excédentaire EST le recouvrement (plus de zone
           ajoutée en supplément) ; corollaire, la partie VISIBLE vaut exactement UN tour ;
       (2) RÉPÉTITIONS — « la case de la dernière répétition est plus grande que les autres » :
           le compte n'est plus figé à 6 mais DÉDUIT de la partie visible, et la largeur de case
           (`visible / count`) est POSÉE EN MILLIMÈTRES dans le HTML, donc mesurable ici. C'est
           l'égalité STRICTE des cases qui est la régression à verrouiller.
     ============================================================================================ */

  /** Largeurs de case (mm) LUES dans le HTML généré — c'est la cote POSÉE qu'on vérifie, pas
      une répartition que le moteur de flexbox aurait faite dans le navigateur. */
  const cellWidthsOf = (html) => {
    const re = /class="cell2[^"]*"\s+style="width:([0-9.]+)mm"/g;
    const out = []; let m;
    while ((m = re.exec(html)) !== null) out.push(parseFloat(m[1]));
    return out;
  };

  await section("labels : LabelLayout — manchon 1,5 tour (le demi-tour EST le recouvrement)", async () => {
    // GOLDENS par Ø — les valeurs annoncées à l'utilisateur (Ø 6 → 28,3 · Ø 10 → 47,1 · Ø 20 → 94,2).
    const golden = [
      [3, 9.42478, 4.71239, 14.13717],
      [6, 18.84956, 9.42478, 28.27433],
      [10, 31.41593, 15.70796, 47.12389],
      [20, 62.83185, 31.41593, 94.24778],
    ];
    for (const [dia, turn, overlap, w] of golden) {
      const g = LabelLayout.sleeveGeometry(dia, 25);
      ck(near(g.turn, turn, 1e-4), "Ø " + dia + " : un tour = π·Ø = " + turn.toFixed(2) + " mm");
      ck(near(g.overlap, overlap, 1e-4), "Ø " + dia + " : recouvrement = le DEMI-tour (" + overlap.toFixed(2) + " mm)");
      ck(near(g.w, w, 1e-4), "Ø " + dia + " : largeur déroulée = " + w.toFixed(2) + " mm");
      // Les DEUX invariants du retour n°1, écrits comme tels (ils survivront à tout réglage de cote).
      ck(near(g.w, 1.5 * g.turn, 1e-9), "Ø " + dia + " : INVARIANT w = 1,5 × tour");
      ck(near(g.visible, g.turn, 1e-9), "Ø " + dia + " : INVARIANT partie visible = UN tour");
      ck(near(g.w - g.overlap, g.visible, 1e-9), "Ø " + dia + " : …et visible = w − recouvrement");
    }
    // La DENSITÉ n'entre plus dans l'enroulement : c'est une géométrie physique, pas de l'aisance
    // typographique — la fonction ne prend plus que Ø et longueur (un 3e argument serait ignoré).
    ck.eq(LabelLayout.sleeveGeometry.length, 2, "sleeveGeometry ne prend plus que (Ø, longueur) — le paramètre de densité a disparu");
    ck.eq(LabelLayout.sleeveGeometry(6, 25).h, 25, "la hauteur reste la longueur le long du câble");
    ck.eq(LabelLayout.sleeveGeometry(6, 40).h, 40, "…et la suit");
  });

  await section("labels : LabelLayout — nombre de cases DÉDUIT de la partie visible (pas figé à 6)", async () => {
    // Le pas cible donne l'ÉPAISSEUR d'une bande : le nom se lit dans l'axe du câble, la case ne
    // porte que la hauteur de ligne (8 pt ≈ 3,1 mm mesurés au navigateur).
    ck.eq(LabelLayout.SLEEVE_REPEAT_PITCH_MM, 5, "pas cible d'une case = 5 mm");
    ck.eq(LabelLayout.SLEEVE_REPEAT_MIN, 2, "minimum 2 : un seul repère pourrait se retrouver SOUS le câble");
    ck.eq(LabelLayout.SLEEVE_STRIP_PANELS, 2, "« repère complet » : 2 panneaux (le texte y est riche)");
    // Un gros Ø porte PLUS de repères qu'un petit — c'est tout l'objet de la correction.
    const casesFor = (dia) => LabelLayout.sleeveRepeats(LabelLayout.sleeveGeometry(dia, 25).visible);
    ck.eq(casesFor(3), 2, "Ø 3 (tour 9,4 mm) : 2 cases");
    ck.eq(casesFor(6), 4, "Ø 6 (tour 18,8 mm) : 4 cases");
    ck.eq(casesFor(10), 6, "Ø 10 (tour 31,4 mm) : 6 cases");
    ck.eq(casesFor(20), 13, "Ø 20 (tour 62,8 mm) : 13 cases");
    ck.eq(casesFor(30), 19, "Ø 30 (le Ø max offert) : 19 cases — le plafond de 20 ne mord pas");
    // BORNES : la fonction est PURE, donc TOTALE — elle répond à n'importe quelle entrée.
    ck.eq(LabelLayout.sleeveRepeats(1), 2, "partie visible minuscule : plancher à 2");
    ck.eq(LabelLayout.sleeveRepeats(0), 2, "zéro : plancher (jamais 0 case, jamais de division par zéro)");
    ck.eq(LabelLayout.sleeveRepeats(-5), 2, "négatif : plancher");
    ck.eq(LabelLayout.sleeveRepeats(NaN), 2, "non numérique : plancher (même politique que clampCustom)");
    ck.eq(LabelLayout.sleeveRepeats(500), LabelLayout.SLEEVE_REPEAT_MAX, "démesuré : plafonné");
    // La largeur de case n'a AUCUN reste, par construction : visible / count, exactement.
    for (const dia of [3, 6, 10, 20]) {
      const g = LabelLayout.sleeveGeometry(dia, 25);
      const n = LabelLayout.sleeveRepeats(g.visible);
      const cw = LabelLayout.sleeveCellWidth(g.visible, n);
      ck(near(cw * n, g.visible, 1e-9), "Ø " + dia + " : " + n + " cases × " + cw.toFixed(3) + " mm = la partie visible, sans reste");
      // …et le pas obtenu reste dans la fourchette qui justifie le choix de 5 mm.
      ck(cw >= 3.2 && cw <= 6.3, "Ø " + dia + " : case de " + cw.toFixed(2) + " mm — au-dessus de la hauteur de ligne (3,1), sous le flottement");
    }
    ck(near(LabelLayout.sleeveCellWidth(12, 2), 6, 1e-9), "sleeveCellWidth : division exacte");
    ck(near(LabelLayout.sleeveCellWidth(12, 0), 12, 1e-9), "sleeveCellWidth : jamais de division par zéro (retombe sur 1 case)");
  });

  await section("labels : LabelHtml — 🚨 les cases d'un manchon sont STRICTEMENT égales (le défaut signalé)", async () => {
    const cable = { collection: "cables", id: "c1", name: "CBL-004821", endA: "SRV · P1", endB: "SW · Gi1/0/12", typeLabel: "Cat 6a · 3 m" };
    const allFields = { location: true, type: true, serial: true, owner: true };

    for (const dia of [3, 6, 10, 20]) {
      const sp = spec({ size: "cable", content: "id", dia });
      const g = LabelLayout.sleeveGeometry(dia, sp.len);
      const expected = LabelLayout.sleeveRepeats(g.visible);
      const html = LabelHtml.label(cable, sp, allFields, "");
      const widths = cellWidthsOf(html);
      ck.eq(widths.length, expected, "Ø " + dia + " : " + expected + " cases rendues (compte déduit, pas figé)");
      // 🚨 LA régression à verrouiller : toutes les cases portent EXACTEMENT la même cote — plus
      // aucun reste réparti par `flex:1`, donc plus de « dernière case plus grande ».
      ck.eq(new Set(widths).size, 1, "Ø " + dia + " : une SEULE largeur de case dans tout le HTML");
      ck(near(widths[0], g.visible / expected, 0.001), "Ø " + dia + " : et cette largeur vaut la partie visible / " + expected);
      // La somme des cases + le recouvrement referme l'étiquette (au reste d'arrondi près, < 0,01 mm).
      ck(near(widths[0] * expected + g.overlap, g.w, 0.01), "Ø " + dia + " : cases + recouvrement = la largeur déroulée");
      // Filet de séparation : la DERNIÈRE case porte le repère de pli, et elle SEULE.
      ck.eq((html.match(/cell2 fold/g) || []).length, 1, "Ø " + dia + " : une seule case marquée « fold » (le pli)");
      ck(html.indexOf('class="cell2 fold"') > html.lastIndexOf('class="cell2"'), "Ø " + dia + " : c'est bien la DERNIÈRE case");
    }

    // Le recouvrement est posé en mm lui aussi (il n'est plus un forfait entier).
    const h6 = LabelHtml.label(cable, spec({ size: "cable", content: "id", dia: 6 }), allFields, "");
    ck(h6.includes('class="ov" style="width:9.42mm"'), "Ø 6 : la zone de recouvrement fait le demi-tour (9,42 mm)");
    ck(h6.includes('style="width:28.27mm;height:25mm"'), "Ø 6 : l'étiquette fait 1,5 tour (28,27 × 25 mm)");
    ck(h6.includes('style="width:4.712mm"'), "Ø 6 : cases de 4,712 mm, posées au millième (le reste cumulé resterait sous 0,01 mm)");

    // « REPÈRE COMPLET » : 2 panneaux, sur la MÊME assiette (la partie visible) et EXACTEMENT égaux.
    for (const dia of [6, 10]) {
      const sp = spec({ size: "cable", content: "strip", dia });
      const g = LabelLayout.sleeveGeometry(dia, sp.len);
      const widths = cellWidthsOf(LabelHtml.label(cable, sp, allFields, ""));
      ck.eq(widths.length, 2, "Ø " + dia + " repère complet : 2 panneaux");
      ck.eq(new Set(widths).size, 1, "Ø " + dia + " repère complet : panneaux STRICTEMENT égaux");
      ck(near(widths[0], g.visible / 2, 0.001), "Ø " + dia + " repère complet : chacun un DEMI-tour (" + (g.visible / 2).toFixed(3) + " mm)");
    }

    // Le filet du raccord n'est plus DOUBLÉ : c'est la dernière case qui le porte, plus la zone hachurée.
    ck(!/\.ov\{[^}]*border-left/.test(LabelHtml.CSS), "zone hachurée : plus de border-left (le double trait au raccord a disparu)");
    ck(/\.cell2\{[^}]*border-right:\.2mm dashed #ccc/.test(LabelHtml.CSS), "toutes les cases gardent le MÊME filet (boîtes rigoureusement identiques)");
    ck(/\.cell2\.fold\{border-right-color:#999\}/.test(LabelHtml.CSS), "…seule la couleur change sur la case de pli");
    // Et les cases ne sont plus laissées à `flex:1` : la cote est POSÉE, donc vérifiable (ci-dessus).
    ck(/\.cell2\{flex:none/.test(LabelHtml.CSS), "cases en flex:none — leur largeur est une COTE, pas un reste réparti");
  });

  await section("labels : LabelPrintPolicy — offres par contexte (contenus, formats, défauts, cases)", async () => {
    // CONTENUS : les manchons ne concernent que ce qui s'ENROULE (câble, faisceau).
    ck.eq(LabelPrintPolicy.contentsFor("equipment").join(","), "full,qr", "équipement : QR+texte et QR seul, pas de manchon");
    ck.eq(LabelPrintPolicy.contentsFor("rack").join(","), "full,qr", "baie : idem");
    ck.eq(LabelPrintPolicy.contentsFor("spare").join(","), "full,qr", "spare : idem");
    ck.eq(LabelPrintPolicy.contentsFor("cable").join(","), "full,qr,strip,id", "câble : manchons offerts");
    ck.eq(LabelPrintPolicy.contentsFor("bundle").join(","), "full,qr,strip,id", "faisceau : MÊME anatomie que le câble");
    ck(LabelPrintPolicy.isFlagKind("bundle") && LabelPrintPolicy.isFlagKind("cable"), "câble et faisceau = les deux sujets à DRAPEAU");
    ck(!LabelPrintPolicy.isFlagKind("equipment") && !LabelPrintPolicy.isFlagKind("rack"), "…et personne d'autre");

    // FORMATS : le drapeau n'existe que pour les sujets à drapeau ; « Baie » n'existe que pour les baies.
    ck.eq(LabelPrintPolicy.sizesFor("equipment").join(","), "s,m,l,custom", "équipement : ni drapeau ni gabarit Baie");
    ck.eq(LabelPrintPolicy.sizesFor("spare").join(","), "s,m,l,custom", "spare : idem");
    ck.eq(LabelPrintPolicy.sizesFor("rack").join(","), "s,m,l,rack,custom", "baie : le gabarit Baie s'ajoute (pour ELLE seule)");
    ck.eq(LabelPrintPolicy.sizesFor("cable").join(","), "cable,custom", "câble : drapeau ou personnalisé (un rectangle ne s'attache pas à un brin)");
    ck.eq(LabelPrintPolicy.sizesFor("bundle").join(","), "cable,custom", "faisceau : idem câble");

    // DÉFAUTS du contexte (premier tirage).
    ck.eq(LabelPrintPolicy.defaultSizeFor("equipment"), "m", "défaut équipement = M");
    ck.eq(LabelPrintPolicy.defaultSizeFor("rack"), "rack", "défaut baie = gabarit Baie");
    ck.eq(LabelPrintPolicy.defaultSizeFor("spare"), "s", "défaut spare = S");
    ck.eq(LabelPrintPolicy.defaultSizeFor("bundle"), "cable", "défaut faisceau = drapeau");
    ck.eq(LabelPrintPolicy.defaultQrFor("bundle"), 18, "défaut de QR d'un drapeau = 18 (le plancher)");
    ck.eq(LabelPrintPolicy.defaultQrFor("equipment"), 20, "défaut de QR rectangulaire = 20");
    ck.eq(LabelPrintPolicy.defaultColsFor("bundle"), 3, "planche de drapeaux : 3 colonnes");
    ck.eq(LabelPrintPolicy.defaultColsFor("equipment"), 4, "planche rectangulaire : 4 colonnes");

    // CASES OFFERTES = ce que le sujet POSSÈDE (une case sans donnée serait un mensonge d'interface).
    ck.eq(JSON.stringify(LabelPrintPolicy.offeredFieldsFor("equipment")), JSON.stringify({ location: true, type: true, serial: true, owner: true }), "équipement : les 4 cases (owner = lot E1)");
    ck.eq(JSON.stringify(LabelPrintPolicy.offeredFieldsFor("spare")), JSON.stringify({ location: true, type: true, serial: true, owner: false }), "spare : pas de propriétaire");
    ck.eq(JSON.stringify(LabelPrintPolicy.offeredFieldsFor("rack")), JSON.stringify({ location: true, type: true, serial: false, owner: false }), "baie : ni n° de série ni propriétaire");
    ck.eq(JSON.stringify(LabelPrintPolicy.offeredFieldsFor("bundle")), JSON.stringify({ location: true, type: true, serial: false, owner: false }), "faisceau : extrémités + type seulement");
    // COCHÉES au premier tirage : emplacement partout, type d'office sur drapeau/baie, owner décoché (décision E).
    ck.eq(JSON.stringify(LabelPrintPolicy.defaultFieldsFor("equipment")), JSON.stringify({ location: true, type: false, serial: false, owner: false }), "équipement : emplacement seul coché");
    ck.eq(JSON.stringify(LabelPrintPolicy.defaultFieldsFor("bundle")), JSON.stringify({ location: true, type: true, serial: false, owner: false }), "faisceau : extrémités + type cochés");
  });

  await section("labels : LabelPrintPolicy — LA matrice (sujet × contenu × format × nombre)", async () => {
    const v = (kind, content, size, count) => LabelPrintPolicy.visibility(kind, content, size, count || 1);

    // 🚨 RETOUR n°1 : les cotes PERSONNALISÉES ne s'affichent QUE sous « Personnalisé ».
    for (const size of ["s", "m", "l", "rack"]) {
      ck(!v("equipment", "full", size).showWidthHeight, "format " + size + " : ni largeur ni hauteur saisissables");
      ck(!v("equipment", "full", size).showQrMm, "format " + size + " : la cote de QR est IMPOSÉE par le préréglage");
      ck(!v("equipment", "full", size).showMmRow, "format " + size + " : la rangée mm entière disparaît");
    }
    const custom = v("equipment", "full", "custom");
    ck(custom.showWidthHeight && custom.showQrMm && custom.showMmRow, "personnalisé : largeur, hauteur ET cote de QR");
    ck(!custom.showDiaLen, "personnalisé : pas de Ø/longueur (ce n'est pas un manchon)");
    // La cote de QR reste offerte quand elle est LIBRE sans être « personnalisée » (QR seul, drapeau).
    ck(v("equipment", "qr", "m").showQrMm && !v("equipment", "qr", "m").showWidthHeight, "QR seul : la cote du QR, et elle seule");
    ck(v("cable", "full", "cable").showQrMm && !v("cable", "full", "cable").showWidthHeight, "drapeau : la cote du QR pilote la géométrie");

    // 🚨 RETOUR n°2 : Ø de câble et longueur de manchon SEULEMENT en mode manchon.
    for (const kind of ["equipment", "rack", "spare", "cable", "bundle"]) {
      ck(!v(kind, "full", LabelPrintPolicy.defaultSizeFor(kind)).showDiaLen, kind + " en QR+texte : ni Ø ni longueur de manchon");
    }
    const sleeve = v("cable", "strip", "cable");
    ck(sleeve.showDiaLen && sleeve.showMmRow, "manchon : Ø et longueur affichés");
    ck(!sleeve.showQrMm && !sleeve.showSizeSelect, "manchon : ni cote de QR (il n'y en a pas) ni sélecteur de format");
    ck.eq(sleeve.header, "sleeve", "manchon : l'intitulé de section devient « Manchon »");
    ck.eq(v("cable", "id", "cable").header, "sleeve", "identifiant seul : même intitulé");
    ck.eq(v("equipment", "qr", "m").header, "qrSize", "QR seul : l'intitulé devient « Taille du QR »");
    ck.eq(v("equipment", "full", "m").header, "format", "QR + texte : « Format »");
    ck(v("equipment", "full", "m").showSizeSelect, "QR + texte : le sélecteur de format est là");

    // CASES : intersection de l'offre du SUJET et des règles du CONTENU.
    ck(!v("rack", "full", "rack").fields.serial, "baie : la case n° de série n'apparaît jamais (le modèle n'en a pas)");
    ck(!v("cable", "full", "cable").fields.serial, "câble : idem");
    ck(!v("bundle", "full", "cable").fields.serial, "faisceau : idem");
    ck(!v("bundle", "full", "cable").fields.owner, "faisceau : pas de propriétaire non plus");
    ck(v("equipment", "full", "m").fields.serial && v("equipment", "full", "m").fields.owner, "équipement : série et propriétaire offerts");
    const qrOnly = v("equipment", "qr", "m");
    ck(!qrOnly.fields.location && !qrOnly.fields.type && !qrOnly.fields.serial, "QR seul : plus rien à part…");
    ck(qrOnly.fields.owner, "…le propriétaire (bande sous le carré)");
    ck(!qrOnly.showIdRow, "QR seul : la rangée « Identifiant (toujours) » n'a plus de sens");
    const idOnly = v("cable", "id", "cable");
    ck(!idOnly.fields.location && !idOnly.fields.type && !idOnly.fields.owner && !idOnly.showIdRow, "identifiant seul : aucune case (c'est le principe du contenu)");
    ck(!idOnly.showFieldsSection, "identifiant seul : la SECTION entière disparaît");
    ck(v("equipment", "qr", "m").showFieldsSection, "QR seul : la section survit pour la seule case propriétaire");

    // Libellé « Extrémités A / B » : les sujets à drapeau, et eux seuls.
    ck(v("cable", "full", "cable").locationAsEnds && v("bundle", "full", "cable").locationAsEnds, "câble/faisceau : « Emplacement » devient « Extrémités A / B »");
    ck(!v("equipment", "full", "m").locationAsEnds && !v("rack", "full", "rack").locationAsEnds, "équipement/baie : « Emplacement »");

    // PLANCHE : à partir de 2 étiquettes seulement.
    ck(!v("equipment", "full", "m", 1).showSheetSection, "1 étiquette : pas de section Planche");
    ck(v("equipment", "full", "m", 2).showSheetSection, "2 étiquettes : la section Planche apparaît");
  });

  await section("labels : LabelPrintPolicy — sanitize : un réglage MÉMORISÉ invalide retombe sur le défaut", async () => {
    // La mémoire de session est PAR contexte, mais un réglage peut devenir inatteignable (ancienne UI
    // plus permissive, contexte partagé…) : il RETOMBE, jamais d'état que l'UI ne sait plus représenter.
    const held = { content: "strip", size: "cable", fields: { location: true, type: true, serial: true, owner: true } };
    const cleaned = LabelPrintPolicy.sanitize("equipment", held);
    ck.eq(cleaned.content, "full", "contenu manchon hérité sur un équipement → QR + texte");
    ck.eq(cleaned.size, "m", "format drapeau hérité sur un équipement → son défaut (M)");
    ck.eq(JSON.stringify(cleaned.fields), JSON.stringify({ location: true, type: true, serial: true, owner: true }), "…et l'équipement possède bien les 4 champs : rien à retirer");
    ck(cleaned === held, "muté EN PLACE (l'objet de session est partagé par référence)");

    // Cases d'un champ que le sujet ne POSSÈDE pas : décochées d'office.
    const onBundle = LabelPrintPolicy.sanitize("bundle", { content: "full", size: "cable", fields: { location: true, type: true, serial: true, owner: true } });
    ck(!onBundle.fields.serial && !onBundle.fields.owner, "faisceau : n° de série et propriétaire décochés (il n'en a pas)");
    ck(onBundle.fields.location && onBundle.fields.type, "…extrémités et type conservés");
    ck.eq(LabelPrintPolicy.sanitize("rack", { content: "qr", size: "rack", fields: { location: true, type: true, serial: true, owner: false } }).fields.serial, false, "baie : n° de série décoché");
    // Un réglage VALIDE traverse sans être touché (le sanitize n'écrase pas la mémoire utile).
    const kept = LabelPrintPolicy.sanitize("cable", { content: "id", size: "cable", fields: { location: false, type: true, serial: false, owner: false } });
    ck.eq(kept.content + "/" + kept.size, "id/cable", "réglage valide : conservé tel quel");
  });

  await section("labels : LabelSubjects — sujet FAISCEAU (extrémités = les 2 patchs terminaux)", async () => {
    // Lecteur MINIMAL injecté (patron des modules core/ : jamais d'import du Store).
    const data = {
      equipments: { pa: { id: "pa", name: "PATCH-A1" }, pb: { id: "pb", name: "PATCH-B7" } },
      cableTypes: { ct: { id: "ct", name: "OM4 12F" } },
    };
    const reader = { get: (collection, id) => (data[collection] || {})[id] || null };
    const bundle = { id: "b1", name: "TRK-SALLE1-SALLE2", cable_type_id: "ct", fiber_count: 12, length_m: 45, endpoint_a_equipment_id: "pa", endpoint_b_equipment_id: "pb" };
    const s = LabelSubjects.bundle(reader, bundle);
    ck.eq(s.collection + "/" + s.id, "cableBundles/b1", "sujet rattaché à la collection des faisceaux (le QR pointe la fiche)");
    ck.eq(s.name, "TRK-SALLE1-SALLE2", "identifiant = le nom du faisceau");
    ck.eq(s.endA + " → " + s.endB, "PATCH-A1 → PATCH-B7", "extrémités = les NOMS des deux patchs (un trunk n'a pas de port d'extrémité)");
    ck.eq(s.typeLabel, "OM4 12F · 12 brins · 45 m", "type = fibre · capacité · longueur");
    ck(s.serial === undefined && s.owner === undefined, "ni n° de série ni propriétaire (le modèle n'en a pas) — cohérent avec la matrice");
    // Champs manquants : la ligne correspondante disparaît, jamais de « null » imprimé.
    const bare = LabelSubjects.bundle(reader, { id: "b2", name: "TRK-2", cable_type_id: null, fiber_count: null, length_m: null, endpoint_a_equipment_id: null, endpoint_b_equipment_id: "pb" });
    ck.eq(bare.endA, "", "extrémité non raccordée → chaîne vide (ligne absente à l'impression)");
    ck.eq(bare.endB, "PATCH-B7", "…l'autre reste imprimée");
    ck.eq(bare.typeLabel, "", "aucun attribut de type → pas de ligne de type");
    // Le drapeau se rend comme celui d'un câble (même anatomie) : 2 panneaux + zone d'enroulement.
    const flag = LabelHtml.label(s, spec({ size: "cable", qr: 18 }), { location: true, type: true, serial: false, owner: false }, '<svg data-qr="1"></svg>');
    ck((flag.match(/class="pan/g) || []).length === 2 && flag.includes("PATCH-A1"), "faisceau : drapeau à 2 panneaux, extrémité A imprimée");
  });
};
