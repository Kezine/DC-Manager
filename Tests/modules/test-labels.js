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
                          répétitions du manchon, planche, document d'impression).
   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D } = require("./harness.js");

module.exports = async () => {
  const { LabelLayout } = D("core/LabelLayout.js");
  const { LabelQrSvg } = D("core/LabelQrSvg.js");
  const { LabelHtml } = D("core/LabelHtml.js");

  /* Réglage de base : gabarit M, QR + texte, compact — les défauts de la modale. */
  const spec = (over = {}) => Object.assign({
    size: "m", content: "full", compact: true,
    qr: 20, custom: { w: 50, h: 25 }, dia: 6, len: 25, hasOwner: false,
  }, over);
  const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

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
    // DRAPEAU compact QR 18 : panneaux 22, zone 10 → 54 × 20,4 (le spécimen de la maquette).
    const fc = LabelLayout.flagGeometry(18, true);
    ck.eq(JSON.stringify(fc), JSON.stringify({ pad: 1.2, wz: 10, pan: 22, h: 20.4, w: 54 }), "drapeau compact q18 = 54 × 20,4 (pan 22, wz 10)");
    // DRAPEAU confort QR 18 : 62 × 22 — la cote nominale de la table.
    const ff = LabelLayout.flagGeometry(18, false);
    ck.eq(JSON.stringify(ff), JSON.stringify({ pad: 2, wz: 12, pan: 25, h: 22, w: 62 }), "drapeau confort q18 = 62 × 22 (la table)");
    // Un QR plus grand DILATE le panneau (géométrie DÉRIVÉE du QR, jamais figée).
    const fb = LabelLayout.flagGeometry(28, true);
    ck(near(fb.pan, 30.4) && near(fb.w, 70.8) && near(fb.h, 30.4), "drapeau q28 : panneau 30,4 → 70,8 de large");
    // MANCHON Ø 6, 25 mm, compact : 2 tours (2π·6) + 12 de recouvrement = 49,7 mm (spécimen maquette).
    const sc = LabelLayout.sleeveGeometry(6, 25, true);
    ck(near(sc.w, 49.7, 0.005), "manchon Ø6 compact : largeur 49,7 mm (2 tours + 12)");
    ck(near(sc.turn, Math.PI * 6, 1e-9), "manchon : un tour = π·Ø");
    ck.eq(sc.h, 25, "manchon : hauteur = longueur le long du câble");
    ck.eq(LabelLayout.sleeveGeometry(6, 25, false).overlap, 16, "manchon confort : recouvrement 16");
    // QR SEUL : carré (QR + marges), la bande propriétaire s'ajoute SOUS le carré.
    ck.eq(LabelLayout.qrOnlyGeometry(20, true, false).side, 22, "QR seul compact sans owner : 22");
    ck(near(LabelLayout.qrOnlyGeometry(20, true, true).side, 26.4), "QR seul compact + owner : 26,4 (spécimen maquette)");
    ck(near(LabelLayout.qrOnlyGeometry(20, false, true).side, 29.8), "QR seul confort + owner : 29,8");
    // labelDims agrège le tout.
    ck.eq(JSON.stringify(LabelLayout.labelDims(spec())), JSON.stringify([50, 30]), "dims M = 50×30");
    ck.eq(JSON.stringify(LabelLayout.labelDims(spec({ size: "custom", custom: { w: 38, h: 16 } }))), JSON.stringify([38, 16]), "dims personnalisé = cotes saisies");
    ck.eq(JSON.stringify(LabelLayout.labelDims(spec({ content: "qr", qr: 20 }))), JSON.stringify([22, 22]), "dims QR seul = carré");
    const sd = LabelLayout.labelDims(spec({ size: "cable", content: "strip" }));
    ck(near(sd[0], 49.7, 0.005) && sd[1] === 25, "dims manchon = géométrie du manchon");
    const fd = LabelLayout.labelDims(spec({ size: "cable", qr: 18 }));
    ck(near(fd[0], 54) && near(fd[1], 20.4), "dims drapeau compact = 54 × 20,4");
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
    ck.eq(JSON.stringify(LabelLayout.cellDims(spec({ content: "qr", qr: 20 }))), JSON.stringify([22, 22]), "cellule QR seul = dims réelles");
    ck.eq(LabelLayout.maxColumns(spec()), 4, "M : 4 colonnes max (4×48 = 192 ≤ 194)");
    ck.eq(LabelLayout.maxColumns(spec({ size: "s" })), 3, "S (cellule 50) : 3 colonnes max");
    ck.eq(LabelLayout.maxColumns(spec({ size: "l" })), 2, "L (70) : 2 colonnes max");
    ck.eq(LabelLayout.maxColumns(spec({ size: "rack" })), 1, "Baie (100) : 1 colonne");
    ck.eq(LabelLayout.maxColumns(spec({ size: "cable", qr: 18 })), 3, "drapeau compact (54) : 3 colonnes");
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
    const tight = LabelLayout.warnings(spec({ size: "custom", qr: 16, custom: { w: 30, h: 16 } }), { count: 1, requestedCols: 4 });
    ck(tight.includes("qr-exceeds-label"), "QR 16 + marges > hauteur 16 → qr-exceeds-label");
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
    ck(qOnly.includes("qronly") && qOnly.includes("width:26.4mm;height:26.4mm"), "QR seul + owner : carré 26,4");
    // Câble : drapeau (2 panneaux + zone hachurée), manchons ×2 / ×6.
    const cable = { collection: "cables", id: "c1", name: "CBL-004821", endA: "SRV · P1", endB: "SW · Gi1/0/12", typeLabel: "Cat 6a · 3 m" };
    const flag = LabelHtml.label(cable, spec({ size: "cable", qr: 18 }), allFields, qr);
    ck((flag.match(/class="pan/g) || []).length === 2 && flag.includes('class="wz"'), "drapeau : 2 panneaux + zone d'enroulement");
    ck((flag.match(/data-qr="1"/g) || []).length === 1, "drapeau QR+texte : UN QR (panneau A)");
    ck((LabelHtml.label(cable, spec({ size: "cable", content: "qr", qr: 18 }), allFields, qr).match(/data-qr="1"/g) || []).length === 2, "drapeau QR seul : QR des DEUX côtés");
    ck.eq((LabelHtml.label(cable, spec({ size: "cable", content: "strip" }), allFields, "").match(/cell2/g) || []).length, 2, "manchon repère complet : 2 tours");
    ck.eq((LabelHtml.label(cable, spec({ size: "cable", content: "id" }), allFields, "").match(/cell2/g) || []).length, 6, "manchon identifiant seul : ×6 sur le tour");
    // Planche + document d'impression.
    const page = LabelHtml.sheetPage(["<i>a</i>", "<i>b</i>"], { cols: 4, cellH: 33 }, { source: "Baie B12 · contenu", headRight: "2 étiquettes", cuts: true });
    ck(page.includes("grid-template-columns:repeat(4,1fr)") && page.includes("a4-head"), "planche : grille + en-tête hors zone");
    ck(!page.includes("nocut"), "traits de coupe actifs par défaut");
    ck(LabelHtml.sheetPage(["x"], { cols: 2, cellH: 20 }, { source: "s", headRight: "r", cuts: false }).includes("nocut"), "traits de coupe désactivables");
    const doc = LabelHtml.printDocument({ title: "T<est>", pageSize: "50mm 30mm", pagesHtml: "<div class=\"unit\">x</div>" });
    ck(doc.includes("@page{size:50mm 30mm;margin:0}"), "unitaire : @page à la taille EXACTE de l'étiquette");
    ck(doc.includes(".label-render .lab{background:#fff"), "print-CSS embarquée (noir sur blanc, aucune variable de thème)");
    ck(!doc.includes("var(--fg"), "aucun token de thème dans l'imprimé");
    ck(doc.includes("T&lt;est&gt;"), "titre du document échappé");
  });
};
