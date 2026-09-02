/* Tests modules — ÉTIQUETTES QR IMPRIMABLES (lot E du chantier étiquettes QR, refondu par le
   retour terrain T10 du 2026-09-02) : les modules PURS de l'impression, cf. docs/qr-scan.md
   § « Étiquettes imprimables » — la maquette design-system/briefs/qr-etiquettes-imprimables-
   maquette.html FAIT FOI pour les cotes :
     - core/LabelLayout : table des gabarits (golden), géométrie drapeau/manchon/QR seul,
                          cellule de planche ≠ étiquette, plafond de colonnes, capacité A4,
                          bornes du personnalisé, détection de débordement (CODES) ;
     - core/LabelQrSvg  : retravail du SVG servi par la route /qr — détection de la quiet
                          zone (marge en modules), compensation par padding blanc CALCULÉ,
                          mise à l'échelle en mm ;
     - core/LabelHtml   : rendu HTML partagé aperçu ⇄ imprimé — depuis T10, les lignes
                          viennent des DÉCLARATIONS du sujet (registres .l-* hérités,
                          extrémités A/B structurelles) ; les COTES au millimètre restent
                          posées inline depuis LabelLayout (égalité STRICTE des cases) ;
     - core/LabelPrintPolicy : règles TRANSVERSES — 🚨 la matrice de cases par sujet
                          (offeredFieldsFor/defaultFieldsFor) a DISPARU (décision Q10.B) :
                          restent contenus/formats/défauts, l'UNION d'offre de planche
                          (fieldOffer), la règle contenu × champ (fieldVisible), le verdict
                          et la retombée sanitize (réconciliée avec l'offre) ;
     - core/LabelSubjects : les DÉCLARATIONS de champs imprimables par sujet (T10 —
                          spare : caractéristiques PAR TYPE via Spare.techSummary, achat,
                          stockage décoché ; sous-équipement : maître · repère, SANS la
                          garantie ; équipement/baie/câble/faisceau : offres et défauts
                          STRICTEMENT ceux d'avant T10, verrouillés en dur ici).
   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D } = require("./harness.js");

module.exports = async () => {
  const { LabelLayout } = D("core/LabelLayout.js");
  const { LabelQrSvg } = D("core/LabelQrSvg.js");
  const { LabelHtml } = D("core/LabelHtml.js");
  const { LabelPrintPolicy } = D("core/LabelPrintPolicy.js");
  const { LabelSubjects } = D("core/LabelSubjects.js");
  const { LabelOrientation } = D("core/LabelOrientation.js");
  // T10 : la composition des caractéristiques d'un spare est celle du MODÈLE (techSummary,
  // source unique partagée avec le listing et la désignation auto) — on teste la VRAIE chaîne.
  const { Spare } = D("models/Spare.js");

  /* Réglage de base : gabarit M, QR + texte, compact — les défauts de la modale. */
  const spec = (over = {}) => Object.assign({
    size: "m", content: "full", compact: true,
    qr: 20, custom: { w: 50, h: 25 }, dia: 6, len: 25, hasOwner: false,
  }, over);
  const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

  /* T10 — sujets LITTÉRAUX pour isoler le RENDU (les vrais sujets viennent de LabelSubjects,
     testé plus bas). `decl` = une déclaration minimale ; `equipmentSubject` reproduit
     l'anatomie de l'ÉQUIPEMENT du modèle figé (mêmes registres, mêmes drapeaux) — c'est elle
     qui verrouille l'identité de l'imprimé d'avant/après T10. */
  const decl = (id, value, over = {}) => Object.assign({ id, label: id, value, checked: true, style: "meta" }, over);
  const equipmentSubject = (over = {}) => Object.assign({
    collection: "equipments", id: "e1", name: "SRV-01",
    fields: [
      decl("location", "B12 · U18-U19", { style: "loc" }),
      decl("type", "Serveur · R650", { checked: false, hideOnSmall: true }),
      decl("serial", "SN 7KJ2X91", { checked: false, style: "sn", hideOnSmall: true }),
      decl("owner", "ACME & Co", { checked: false, style: "own", qrOnly: true }),
    ],
  }, over);
  const cableSubject = (over = {}) => Object.assign({
    collection: "cables", id: "c1", name: "CBL-004821", endA: "SRV · P1", endB: "SW · Gi1/0/12",
    fields: [decl("type", "Cat 6a · 3 m")],
  }, over);
  /** Toutes les cases cochées + extrémités A/B : l'équivalent de l'ancien `allFields`. */
  const allOn = { ends: true, checked: { location: true, type: true, serial: true, owner: true } };

  await section("labels : LabelOrientation — l'identifiant se lit-il autrement à 180° ?", async () => {
    /* Le manchon « identifiant seul » ne porte QUE le numéro : posé à l'envers, `168` se lit
       `891`. Mais « que des chiffres » attrape trop et trop peu — cf. l'en-tête du module. */
    ck(LabelOrientation.isAmbiguous("168"), "168 → 891 : DEUX lectures plausibles, c'est le piège");
    ck(LabelOrientation.isAmbiguous("106"), "106 → 901");
    ck(LabelOrientation.isAmbiguous("16-89"), "le tiret est invariant : 16-89 → 68-91");
    // Illisible une fois retourné ⇒ aucune ambiguïté : le technicien VOIT que c'est à l'envers.
    ck(!LabelOrientation.isAmbiguous("1234"), "1234 : 2/3/4 n'ont pas d'image → aucun risque");
    ck(!LabelOrientation.isAmbiguous("SW-01"), "identifiant à lettres → aucun risque");
    ck(!LabelOrientation.isAmbiguous("25"), "2 et 5 ne se répondent qu'en afficheur à segments");
    // STROBOGRAMMATIQUES : se relisent à l'IDENTIQUE, donc aucune erreur possible non plus.
    ck(!LabelOrientation.isAmbiguous("689"), "689 se relit 689 (strobogrammatique)");
    ck(!LabelOrientation.isAmbiguous("88"), "88 se relit 88");
    ck(!LabelOrientation.isAmbiguous("0"), "0 seul");
    ck(!LabelOrientation.isAmbiguous("69"), "69 se relit 69");
    ck(!LabelOrientation.isAmbiguous(""), "vide : rien à retourner");
    // La rotation inverse l'ORDRE autant qu'elle transforme les glyphes.
    ck.eq(LabelOrientation.rotated("168"), "891", "la rotation inverse aussi l'ordre de lecture");
    ck.eq(LabelOrientation.rotated("1234"), null, "un caractère sans image → pas de lecture retournée");
    // 🚨 `1` est INCLUS à dessein : l'inclure ÉLARGIT l'ensemble jugé ambigu, donc protège plus.
    ck.eq(LabelOrientation.rotated("1"), "1", "1 a une image (choix conservateur, cf. en-tête)");
  });

  await section("labels : repère d'orientation du manchon « identifiant seul »", async () => {
    const cable = cableSubject({ name: "168", endA: "A", endB: "B", fields: [decl("type", "Cat6a")] });
    const sleeveId = spec({ size: "cable", content: "id", dia: 6, len: 25 });
    const risky = LabelHtml.label(cable, sleeveId, allOn, "");
    ck(risky.includes('class="l-id flip"'), "identifiant ambigu → souligné sur TOUTES les cases du tour");
    ck.eq((risky.match(/l-id flip/g) || []).length, (risky.match(/cell2/g) || []).length, "…une case soulignée par répétition, sans exception");
    // Un identifiant sans risque ne porte AUCUNE marque : le souligné doit rester porteur de sens.
    ck(!LabelHtml.label(cableSubject({ name: "689" }), sleeveId, allOn, "").includes("flip"), "689 (se relit pareil) : pas de marque");
    ck(!LabelHtml.label(cableSubject({ name: "SW-01" }), sleeveId, allOn, "").includes("flip"), "identifiant à lettres : pas de marque");
    // 🚨 Décision utilisateur : le « repère complet » porte déjà A/B et le type — le sens de
    // lecture y est donné par les mots, la marque n'a pas lieu d'être.
    ck(!LabelHtml.label(cable, spec({ size: "cable", content: "strip", dia: 6, len: 25 }), allOn, "").includes("flip"), "manchon « repère complet » : jamais de marque");
    ck(!LabelHtml.label(cable, spec({ size: "cable", content: "full" }), allOn, "").includes("flip"), "drapeau : jamais de marque");
    // Épaisseur EXPLICITE : un souligné automatique à 8 pt ferait ~0,5 px et disparaîtrait
    // selon l'arrondi — exactement le piège sous-pixel des traits de coupe.
    ck(LabelHtml.CSS.includes("text-decoration-thickness:.4mm"), "épaisseur du souligné posée en mm, jamais laissée à l'automatique");
  });

  await section("labels : LabelPrintPolicy — le sujet SOUS-ÉQUIPEMENT (famille du spare)", async () => {
    // Pendant exact d'isFlagKind : la POLITIQUE ne distingue pas spare et sous-équipement.
    ck(LabelPrintPolicy.isSpareLike("spare"), "un spare est « petit matériel »");
    ck(LabelPrintPolicy.isSpareLike("subEquipment"), "un sous-équipement aussi");
    ck(!LabelPrintPolicy.isSpareLike("equipment"), "un équipement, non");
    ck(!LabelPrintPolicy.isSpareLike("cable"), "un câble non plus");
    ck.eq(LabelPrintPolicy.defaultSizeFor("subEquipment"), "s", "gabarit S par défaut, comme le spare");
    ck.eq(LabelPrintPolicy.sizesFor("subEquipment").join(","), "s,m,l,custom", "formats rectangulaires (ni drapeau ni « Baie »)");
    ck.eq(LabelPrintPolicy.contentsFor("subEquipment").join(","), "full,qr", "pas de manchon : ça ne s'enroule pas");
    // T10 : la politique ne porte PLUS d'offre de cases — la parité spare/sous-équipement se lit
    // sur les règles TRANSVERSES ; les déclarations, elles, diffèrent (cf. LabelSubjects).
    ck.eq(LabelPrintPolicy.defaultQrFor("subEquipment"), LabelPrintPolicy.defaultQrFor("spare"), "même QR par défaut que le spare");
    ck.eq(LabelPrintPolicy.defaultColsFor("subEquipment"), LabelPrintPolicy.defaultColsFor("spare"), "mêmes colonnes de planche par défaut");
    // 🚨 Q10.B : la matrice figée a DISPARU — une résurrection serait une régression du modèle.
    ck.eq(typeof LabelPrintPolicy.offeredFieldsFor, "undefined", "offeredFieldsFor n'existe plus (l'offre vient des déclarations)");
    ck.eq(typeof LabelPrintPolicy.defaultFieldsFor, "undefined", "defaultFieldsFor non plus (le défaut vit dans `checked` des déclarations)");
  });

  await section("labels : LabelSubjects — déclarations d'un SOUS-ÉQUIPEMENT (T10, SANS la garantie)", async () => {
    const store = { get: (collection, id) => (collection === "equipments" && id === "eq1" ? { id: "eq1", name: "SRV-01" } : null) };
    const full = LabelSubjects.subEquipment(store, { id: "se1", name: "Disque 3", equipment_id: "eq1", slot: "Baie 3", brand: "Seagate", model: "ST4000", serial: "ZC1ABC", purchase_date: "2026-01-15", po_ref: "4471", warranty_end: "2029-01-15" });
    ck.eq(full.collection, "subEquipments", "collection du sujet");
    ck.eq(full.name, "Disque 3", "désignation");
    ck.eq(full.fields.map((f) => f.id).join(","), "master,brandModel,serial,purchase", "les 4 cases arbitrées, dans l'ordre de la décision");
    ck(full.fields.every((f) => f.checked), "TOUTES cochées par défaut (décision T10)");
    const by = (id) => full.fields.find((f) => f.id === id);
    ck.eq(by("master").value, "SRV-01 · Baie 3", "maître · repère = l'ancien emplacement");
    ck.eq(by("master").label, "Maître · repère", "libellé localisé de la case (labels.field.master)");
    ck.eq(by("master").style, "loc", "registre mono de l'emplacement conservé");
    ck.eq(by("brandModel").value, "Seagate ST4000", "marque + modèle");
    ck.eq(by("serial").value, "SN ZC1ABC", "série — préfixe SN porté par la VALEUR (le rendu est générique)");
    ck.eq(by("purchase").value, "Achat 2026-01-15 · BC 4471", "achat = date · BC composés (detail.common.poRef), préfixés");
    // 🚨 Décision T10 EXPLICITE : la garantie ne s'imprime PAS — aucune déclaration ne la porte.
    ck(!full.fields.some((f) => f.value.includes("2029")), "warranty_end EXCLU de l'étiquette (décision explicite)");
    ck(!full.fields.some((f) => f.qrOnly), "aucune bande « QR seul » (le propriétaire n'existe que sur les équipements)");
    ck(!full.fields.some((f) => f.hideOnSmall), "rien de supprimé au registre S — le S est le gabarit PAR DÉFAUT du petit matériel");
    // Champs vides : la DÉCLARATION n'existe pas (« pas de case sans donnée », structurel Q10.C).
    const bare = LabelSubjects.subEquipment(store, { id: "se2", name: "Carte", equipment_id: "eq1" });
    ck.eq(bare.fields.map((f) => f.id).join(","), "master", "sans marque/série/achat : seule la case maître subsiste");
    ck.eq(bare.fields[0].value, "SRV-01", "sans repère : le maître seul, sans séparateur pendant");
    const orphan = LabelSubjects.subEquipment(store, { id: "se3", name: "Carte", equipment_id: "absent", slot: "S1" });
    ck.eq(orphan.fields.find((f) => f.id === "master").value, "S1", "maître introuvable : le repère seul, jamais « ? »");
  });

  await section("labels : LabelSubjects — déclarations d'un SPARE (T10, caractéristiques PAR TYPE)", async () => {
    const reader = { get: () => null };
    const hdd = LabelSubjects.spare(reader, new Spare({ name: "HDD-42", type: "hdd", brand: "Seagate", model_pn: "ST4000NM", serial: "ZC1", purchase_date: "2026-01-15", po_ref: "4471", storage_location: "Armoire B2", capacity_value: 4, capacity_unit: "TB", interface: "SATA", form_factor: '3.5"', rpm: 7200, status: "assigned", assigned_free: "J. Dupont" }));
    ck.eq(hdd.collection, "spares", "collection du sujet");
    ck.eq(hdd.name, "HDD-42", "désignation affichée");
    ck.eq(hdd.fields.map((f) => f.id).join(","), "type,characteristics,brandModel,serial,purchase,storage", "les 6 cases arbitrées, dans l'ordre de la décision");
    // 🚨 Liste EXPLICITE de l'utilisateur : tout coché… sauf le stockage (offert, DÉCOCHÉ —
    // interprétation notée au registre : le RETIRER serait une régression).
    ck.eq(hdd.fields.map((f) => f.checked).join(","), "true,true,true,true,true,false", "tout coché par défaut SAUF le stockage");
    const by = (id) => hdd.fields.find((f) => f.id === id);
    ck.eq(by("type").value, "HDD (disque dur)", "type = SpareTypes.label (la marque a désormais SA case)");
    ck.eq(by("characteristics").value, '4 TB · SATA · 3.5" · 7200 rpm', "disque : capacité · interface · format · rpm — la composition du MODÈLE (Spare.techSummary), réutilisée, jamais recomposée");
    ck.eq(by("characteristics").label, "Caractéristiques", "libellé localisé (labels.field.characteristics)");
    ck.eq(by("brandModel").value, "Seagate ST4000NM", "marque + modèle");
    ck.eq(by("serial").value, "SN ZC1", "série préfixée");
    ck.eq(by("purchase").value, "Achat 2026-01-15 · BC 4471", "achat composé");
    ck.eq(by("storage").value, "Armoire B2", "stockage = storage_location");
    ck.eq(by("storage").style, "loc", "…au registre mono de l'ancien emplacement");
    // Statut / attribution : PAS déclarés (décision T10) — rien ne doit les faire fuiter.
    ck(!hdd.fields.some((f) => f.value.includes("Dupont")), "l'attribution ne s'imprime pas");
    ck(!hdd.fields.some((f) => f.hideOnSmall), "rien de supprimé au registre S (gabarit par défaut du spare)");
    // TRANSCEIVER : la case caractéristiques se COMPOSE autrement (tx_form/speed/media/reach).
    const tx = LabelSubjects.spare(reader, new Spare({ name: "TX-7", type: "transceiver", tx_form: "QSFP28", tx_speed: "100G", tx_media: "LC", tx_reach: "10km" }));
    ck.eq(tx.fields.find((f) => f.id === "characteristics").value, "QSFP28 · 100G · LC · 10km", "transceiver : forme · débit · média · portée");
    // …et les champs VIDES sont simplement omis de la composition (jamais de « · » orphelin).
    const txSparse = LabelSubjects.spare(reader, new Spare({ name: "TX-8", type: "transceiver", tx_form: "SFP+", tx_reach: "SR" }));
    ck.eq(txSparse.fields.find((f) => f.id === "characteristics").value, "SFP+ · SR", "champs vides omis de la composition");
    // AUTRE : caractéristiques = le texte libre `specs`.
    const other = LabelSubjects.spare(reader, new Spare({ name: "RAILS-1", type: "other", specs: "Kit rails 1U" }));
    ck.eq(other.fields.find((f) => f.id === "characteristics").value, "Kit rails 1U", "autre : specs libres");
    // Sans la moindre donnée technique : NI case caractéristiques, NI marque, NI série…
    const empty = LabelSubjects.spare(reader, new Spare({ name: "X", type: "other" }));
    ck.eq(empty.fields.map((f) => f.id).join(","), "type", "un spare nu ne déclare que son type (pas de case sans donnée — structurel)");
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
    /* 🚨 0,5 mm et non 0,2 : l'utilisateur a trouvé LA reproduction — le défaut apparaît et
       disparaît selon le ZOOM du navigateur, signature d'un filet SOUS-PIXEL (0,2 mm ≈ 0,76 px
       CSS, donc 1 pixel… ou 0 selon l'arrondi). Les traits n'étaient pas recouverts : ils
       n'étaient tout simplement pas dessinés. 0,5 mm ≈ 1,9 px survit à l'arrondi même à 50 % d'échelle. */
    ck.eq(LabelLayout.CUT_MM, 0.5, "épaisseur du trait de coupe : au-dessus du seuil sous-pixel");
    // Le trait vit dans la GOUTTIÈRE : N cellules + (N − 1) gouttières ≤ largeur utile.
    const rowWidth = (sp) => LabelLayout.maxColumns(sp) * LabelLayout.cellDims(sp)[0] + (LabelLayout.maxColumns(sp) - 1) * LabelLayout.CUT_MM;
    for (const size of ["s", "m", "l", "rack"]) {
      ck(rowWidth(spec({ size })) <= LabelLayout.A4_W - 2 * LabelLayout.A4_MARGIN, "gabarit " + size + " : une rangée pleine tient dans la largeur utile, gouttières comprises");
    }
    // …et une colonne de PLUS ne tiendrait pas (le plafond est bien le maximum, pas une marge de sûreté).
    ck(rowWidth(spec()) + LabelLayout.cellDims(spec())[0] + LabelLayout.CUT_MM > LabelLayout.A4_W - 2 * LabelLayout.A4_MARGIN, "M : une 5e colonne ne tiendrait pas");
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

  await section("labels : LabelHtml — rendu depuis les DÉCLARATIONS (structure, échappement, T10)", async () => {
    const subject = equipmentSubject({ name: "SRV-<PROD>&01" });
    const qr = '<svg data-qr="1"></svg>';
    const m = LabelHtml.label(subject, spec(), allOn, qr);
    ck(m.includes('class="lab m compact"'), "gabarit M compact : classes posées");
    ck(m.includes("width:50mm;height:30mm"), "cotes inline en mm");
    ck(m.includes("SRV-&lt;PROD&gt;&amp;01"), "identifiant ÉCHAPPÉ (entrée non sûre)");
    ck(m.includes("B12 · U18-U19") && m.includes("SN 7KJ2X91"), "emplacement + n° de série rendus");
    ck(m.includes("ACME &amp; Co"), "propriétaire rendu (case cochée + déclaration du sujet, valeur échappée)");
    ck(m.includes('data-qr="1"'), "le SVG de QR est inliné tel quel");
    // Case décochée → ligne ABSENTE ; valeur vide → DÉCLARATION absente (T10, structurel) →
    // ligne absente aussi : les deux chemins convergent vers le même imprimé.
    ck(!LabelHtml.label(subject, spec(), { ends: true, checked: Object.assign({}, allOn.checked, { owner: false }) }, qr).includes("l-own"), "owner décoché → pas de ligne l-own");
    const noOwner = equipmentSubject();
    noOwner.fields = noOwner.fields.filter((f) => f.id !== "owner");
    ck(!LabelHtml.label(noOwner, spec(), allOn, qr).includes("l-own"), "owner vide → pas déclaré → pas de ligne l-own");
    // Gabarit S : les déclarations `hideOnSmall` (type/série d'un équipement) JAMAIS rendues —
    // l'imprimé S d'un équipement d'avant T10 est reproduit à l'identique.
    const s = LabelHtml.label(subject, spec({ size: "s" }), allOn, qr);
    ck(!s.includes("l-meta") && !s.includes("l-sn"), "S : type/série supprimés même cochés (hideOnSmall)");
    ck(s.includes("l-own"), "…mais le propriétaire, lui, survit au S (comme avant T10)");
    // Grands gabarits : filet séparateur avant le registre secondaire, APRÈS l'emplacement.
    const l = LabelHtml.label(subject, spec({ size: "l" }), allOn, qr);
    ck(l.includes('class="rule"'), "L : filet séparateur");
    ck(l.indexOf('class="rule"') > l.indexOf("l-loc") && l.indexOf('class="rule"') < l.indexOf("l-meta"), "L : le filet sépare l'emplacement du registre secondaire (position du modèle figé)");
    // Planche : les cotes de la CELLULE priment (l'étiquette s'y étire).
    ck(LabelHtml.label(subject, spec(), allOn, qr, [48, 33]).includes("width:48mm;height:33mm"), "dims de cellule imposées sur planche");
    // QR seul : carré ; la bande sous le carré = les déclarations `qrOnly` cochées (fieldVisible).
    const qOnly = LabelHtml.label(subject, spec({ content: "qr", qr: 20, hasOwner: true }), allOn, qr);
    ck(qOnly.includes("qronly") && qOnly.includes("width:24mm;height:24mm"), "QR seul + owner : carré 24");
    ck(qOnly.includes("l-own") && !qOnly.includes("l-loc"), "QR seul : la bande, et RIEN d'autre");
    ck(!LabelHtml.label(subject, spec({ content: "qr", qr: 20 }), { ends: false, checked: { location: true, type: true } }, qr).includes("l-own"), "QR seul sans déclaration qrOnly cochée : pas de bande (carré nu)");
    // 🚨 PLANCHE HÉTÉROGÈNE (T10) : un sujet qui ne DÉCLARE pas un id coché saute la ligne.
    const noType = equipmentSubject();
    noType.fields = noType.fields.filter((f) => f.id !== "type");
    ck(!LabelHtml.label(noType, spec({ size: "l" }), allOn, qr).includes("l-meta"), "id coché mais non déclaré par CE sujet → ligne sautée, jamais de vide imprimé");
    // Câble : drapeau (2 panneaux + zone hachurée), extrémités A/B STRUCTURELLES, manchons ×2 / ×N.
    const cable = cableSubject();
    const flag = LabelHtml.label(cable, spec({ size: "cable", qr: 18 }), allOn, qr);
    ck((flag.match(/class="pan/g) || []).length === 2 && flag.includes('class="wz"'), "drapeau : 2 panneaux + zone d'enroulement");
    ck(flag.includes("<b>A</b>") && flag.includes("SRV · P1"), "extrémités A/B structurelles rendues (bascule `ends`)");
    ck(!LabelHtml.label(cable, spec({ size: "cable", qr: 18 }), { ends: false, checked: { type: true } }, qr).includes("<b>A</b>"), "bascule A/B décochée → pas d'extrémités (le type reste)");
    ck((flag.match(/data-qr="1"/g) || []).length === 1, "drapeau QR+texte : UN QR (panneau A)");
    ck((LabelHtml.label(cable, spec({ size: "cable", content: "qr", qr: 18 }), allOn, qr).match(/data-qr="1"/g) || []).length === 2, "drapeau QR seul : QR des DEUX côtés");
    ck.eq((LabelHtml.label(cable, spec({ size: "cable", content: "strip" }), allOn, "").match(/cell2/g) || []).length, 2, "manchon repère complet : 2 panneaux");
    /* 🚨 La règle contenu × champ est appliquée AU RENDU, pas seulement aux cases du dialogue :
       une case masquée ne s'imprime JAMAIS. Vérifié sur le seul écart que la règle porte au-delà
       du contenu (`sn` écarté des manchons) — sans quoi « la MÊME règle des deux côtés » ne serait
       qu'une affirmation d'en-tête. */
    const cableWithSn = cableSubject({ fields: [decl("type", "Cat 6a"), decl("serial", "SN ZC1", { style: "sn" })] });
    const stripHtml = LabelHtml.label(cableWithSn, spec({ size: "cable", content: "strip" }), allOn, "");
    ck(stripHtml.includes("Cat 6a") && !stripHtml.includes("ZC1"), "manchon : une déclaration `sn` COCHÉE n'est pas imprimée (fieldVisible appliqué au rendu)");
    ck(LabelHtml.label(cableWithSn, spec({ size: "cable" }), allOn, qr).includes("ZC1"), "…alors que le drapeau, lui, l'imprime");
    ck.eq((LabelHtml.label(cable, spec({ size: "cable", content: "id" }), allOn, "").match(/cell2/g) || []).length, 4, "manchon identifiant seul à Ø 6 : 4 cases sur le tour");
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
    /* 🚨 FONTE EMBARQUÉE : le document d'impression est une iframe ISOLÉE — il ne voit ni la
       feuille de l'app ni ses `url(../fonts/…)`. Sans @font-face en data: URI il retombe sur une
       police du système, et une autre police = d'autres chasses = un imprimé qui ne ressemble
       plus à l'aperçu. Les URI arrivent par INJECTION (ce module est pur, compilé sans webpack). */
    const faces = LabelHtml.fontFaceCss([
      { family: "IBM Plex Sans", weight: 400, src: "data:font/woff2;base64,AAA", unicodeRange: "U+0000-00FF" },
      { family: "IBM Plex Sans", weight: 700, src: "data:font/woff2;base64,BBB" },
    ]);
    ck(faces.includes('@font-face{font-family:"IBM Plex Sans";font-style:normal;font-weight:400;'), "déclaration @font-face par graisse");
    ck(faces.includes('src:url(data:font/woff2;base64,AAA) format("woff2");'), "la source est le data: URI injecté");
    ck(faces.includes("unicode-range:U+0000-00FF;"), "plage Unicode du subset reprise");
    ck.eq((faces.match(/@font-face/g) || []).length, 2, "une déclaration par fonte, pas une de plus");
    ck(!faces.includes("unicode-range:undefined"), "une fonte SANS plage n'en déclare aucune");
    ck(faces.includes("font-display:block"), "font-display:block — jamais un imprimé tiré avec la police de repli");
    // Le bloc est posé AVANT le CSS des étiquettes : les @font-face doivent précéder leur usage.
    const withFont = LabelHtml.printDocument({ title: "T", pageSize: "A4", pagesHtml: "", fontCss: faces });
    ck(withFont.indexOf("@font-face") < withFont.indexOf(".label-render{"), "les @font-face précèdent le CSS qui les utilise");
    ck(doc.includes('--lp-sans:"IBM Plex Sans"') && doc.includes('--lp-mono:"IBM Plex Sans"'), "les deux piles visent la fonte EMBARQUÉE en premier");
    // Sans injection, le document reste valide (repli sur les familles concrètes de la pile).
    ck(!doc.includes("@font-face"), "fontCss absent → aucun @font-face, et le document reste valide");
    ck(!/letter-spacing:-/.test(doc), "aucun crénage fractionnaire NÉGATIF (il s'arrondissait différemment par paire)");
    ck(doc.includes("T&lt;est&gt;"), "titre du document échappé");
  });

  /* ============================================================================================
     RETOURS TERRAIN DU 2026-08-20 — les volets vérifiés ci-dessous :
       (1) densités amendées + NON-DÉBORDEMENT du QR (bug du format S à l'impression) ;
       (2) cotes calculées retrouvées AU MILLIMÈTRE dans le HTML, et fenêtre d'impression sans
           la moindre marge parasite.
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
    const subject = equipmentSubject();
    const qr = '<svg data-qr="1"></svg>';
    // COMPACT = zéro marge : c'est le retour « énormément de marges ». Le padding/la gouttière sont
    // posés INLINE (plus dans le CSS de classe) précisément pour être vérifiables ici.
    const compact = LabelHtml.label(subject, spec(), allOn, qr);
    ck(compact.includes("padding:0mm 0mm;gap:0mm"), "M compact : padding et gouttière NULS dans le HTML");
    // CONFORT = les cotes de la table des densités, au millimètre.
    const comfort = LabelHtml.label(subject, spec({ compact: false }), allOn, qr);
    ck(comfort.includes("padding:1.5mm 1.5mm;gap:2mm"), "M confort : 1,5 mm de marge, 2 mm de gouttière");
    ck(LabelHtml.label(subject, spec({ size: "l", compact: false }), allOn, qr).includes("padding:3mm 3mm;gap:3mm"), "L confort : 3 mm de marge et de gouttière");
    ck(LabelHtml.label(subject, spec({ size: "rack", compact: false }), allOn, qr).includes("padding:4mm 4mm;gap:5mm"), "Baie confort : 4 mm de marge, 5 de gouttière");
    // S confort : la marge verticale CÉDÉE se retrouve telle quelle dans le HTML (anti-débordement).
    ck(LabelHtml.label(subject, spec({ size: "s", compact: false }), allOn, qr).includes("padding:1mm 1.5mm"), "S confort : marge verticale ramenée à 1 mm dans le HTML");
    // Sur une PLANCHE, c'est la hauteur de CELLULE qui donne la marge (plus d'air, mêmes règles).
    ck(LabelHtml.label(subject, spec({ size: "s", compact: false }), allOn, qr, [50, 33]).includes("padding:1.5mm 1.5mm"), "cellule plus haute : la marge de confort reprend ses 1,5 mm");
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
    const cable = cableSubject();

    for (const dia of [3, 6, 10, 20]) {
      const sp = spec({ size: "cable", content: "id", dia });
      const g = LabelLayout.sleeveGeometry(dia, sp.len);
      const expected = LabelLayout.sleeveRepeats(g.visible);
      const html = LabelHtml.label(cable, sp, allOn, "");
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
    const h6 = LabelHtml.label(cable, spec({ size: "cable", content: "id", dia: 6 }), allOn, "");
    ck(h6.includes('class="ov" style="width:9.42mm"'), "Ø 6 : la zone de recouvrement fait le demi-tour (9,42 mm)");
    ck(h6.includes('style="width:28.27mm;height:25mm"'), "Ø 6 : l'étiquette fait 1,5 tour (28,27 × 25 mm)");
    ck(h6.includes('style="width:4.712mm"'), "Ø 6 : cases de 4,712 mm, posées au millième (le reste cumulé resterait sous 0,01 mm)");

    // « REPÈRE COMPLET » : 2 panneaux, sur la MÊME assiette (la partie visible) et EXACTEMENT égaux.
    for (const dia of [6, 10]) {
      const sp = spec({ size: "cable", content: "strip", dia });
      const g = LabelLayout.sleeveGeometry(dia, sp.len);
      const widths = cellWidthsOf(LabelHtml.label(cable, sp, allOn, ""));
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

  await section("labels : LabelPrintPolicy — offres par contexte (contenus, formats, défauts)", async () => {
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
  });

  await section("labels : T10 — NON-RÉGRESSION des offres/défauts historiques (équipement, baie, câble, faisceau)", async () => {
    /* Les valeurs d'AVANT T10 (l'ex-matrice offeredFieldsFor/defaultFieldsFor), écrites EN DUR :
       les déclarations doivent produire EXACTEMENT les mêmes cases, les mêmes libellés de champ
       et les mêmes défauts — « offres et défauts STRICTEMENT INCHANGÉS » est une décision. */
    const data = {
      racks: { r1: { id: "r1", name: "B12" } },
      datacenters: { d1: { id: "d1", name: "Salle 2" } },
      ports: { p1: { id: "p1", name: "P1", equipment_id: "eqA" }, p2: { id: "p2", name: "Gi1", equipment_id: "eqB" } },
      equipments: { eqA: { id: "eqA", name: "SRV" }, eqB: { id: "eqB", name: "SW" } },
      cableTypes: { ct: { id: "ct", name: "Cat 6a" } },
    };
    const reader = { get: (collection, id) => (data[collection] || {})[id] || null };
    const eq = LabelSubjects.equipment(reader, { id: "e1", name: "SRV-01", placement_mode: "rack", rack_id: "r1", rack_u: 18, u_height: 2, type: "server", brand: "Dell", model: "R650", serial: "X1", owner: "ACME" });
    ck.eq(eq.fields.map((f) => f.id + ":" + f.checked).join(","), "location:true,type:false,serial:false,owner:false", "équipement : les 4 cases historiques, emplacement seul coché (décision E intacte)");
    const eqBy = (id) => eq.fields.find((f) => f.id === id);
    ck.eq(eqBy("location").value, "B12 · U18–U19", "emplacement = baie · plage d'U");
    ck.eq(eqBy("location").label, "Emplacement", "libellé historique de la case");
    ck(eqBy("type").value.includes("Dell R650"), "type = famille + marque/modèle");
    ck.eq(eqBy("serial").value, "SN X1", "série préfixée (l'imprimé d'avant portait déjà « SN »)");
    ck.eq(eqBy("owner").qrOnly, true, "propriétaire = la bande du contenu « QR seul » (drapeau qrOnly)");
    ck(eqBy("type").hideOnSmall === true && eqBy("serial").hideOnSmall === true, "type/série toujours supprimés au registre S (héritage verrouillé)");
    ck(!eqBy("location").hideOnSmall && !eqBy("owner").hideOnSmall, "emplacement/propriétaire jamais supprimés au S (comme avant)");
    const rack = LabelSubjects.rack(reader, { id: "r1", name: "B12", datacenter_id: "d1", u_count: 42 });
    ck.eq(rack.fields.map((f) => f.id + ":" + f.checked).join(","), "location:true,type:true", "baie : salle + type cochés — ni série ni propriétaire (le modèle n'en a pas)");
    ck.eq(rack.fields.find((f) => f.id === "type").value, "Baie 42U", "type = Baie <N>U");
    ck.eq(rack.fields.find((f) => f.id === "location").value, "Salle 2", "emplacement = la salle porteuse");
    const cable = LabelSubjects.cable(reader, { id: "c1", name: "CBL-1", from_port_id: "p1", to_port_id: "p2", cable_type_id: "ct", length_m: 3 });
    ck.eq(cable.endA + " / " + cable.endB, "SRV · P1 / SW · Gi1", "extrémités STRUCTURELLES, hors liste déclarée (ordre de la fiche)");
    ck.eq(cable.fields.map((f) => f.id + ":" + f.checked).join(","), "type:true", "câble : la seule case déclarée est le type, coché (défaut historique)");
    ck.eq(cable.fields[0].value, "Cat 6a · 3 m", "type = type de câble · longueur");
    const bundle = LabelSubjects.bundle(reader, { id: "b1", name: "TRK-1", cable_type_id: "ct", fiber_count: 12, length_m: 45, endpoint_a_equipment_id: "eqA", endpoint_b_equipment_id: "eqB" });
    ck.eq(bundle.fields.map((f) => f.id + ":" + f.checked).join(","), "type:true", "faisceau : même offre que le câble");
    // Câble nu : plus de donnée de type ⇒ plus de case (structurel — l'ancienne UI offrait une
    // case qui n'imprimait rien ; c'est le seul écart, béni par la décision Q10.C).
    const bareCable = LabelSubjects.cable(reader, { id: "c2", name: "CBL-2", from_port_id: null, to_port_id: null, cable_type_id: null, length_m: null });
    ck.eq(bareCable.fields.length, 0, "câble sans type ni longueur : aucune case (pas de case sans donnée)");
  });

  await section("labels : LabelPrintPolicy — UNION d'offre d'une planche HÉTÉROGÈNE (T10)", async () => {
    const reader = { get: (collection, id) => (collection === "equipments" && id === "eq1" ? { id: "eq1", name: "SRV-01" } : null) };
    const disk = LabelSubjects.spare(reader, new Spare({ name: "HDD-1", type: "hdd", capacity_value: 4, capacity_unit: "TB", interface: "SATA", serial: "S1", storage_location: "B2" }));
    const tx = LabelSubjects.spare(reader, new Spare({ name: "TX-1", type: "transceiver", tx_form: "SFP+", brand: "Cisco", model_pn: "GLC-LH" }));
    const subEq = LabelSubjects.subEquipment(reader, { id: "se1", name: "Drive 2", equipment_id: "eq1", slot: "Baie 3", purchase_date: "2026-02-02" });
    const offer = LabelPrintPolicy.fieldOffer([disk, tx, subEq]);
    // Un id déclaré par AU MOINS un sujet ⇒ case offerte ; ordre de PREMIÈRE apparition ; dédupliqué.
    ck.eq(offer.map((f) => f.id).join(","), "type,characteristics,serial,storage,brandModel,master,purchase", "union des déclarations, ordre de première apparition");
    ck.eq(offer.filter((f) => f.id === "type").length, 1, "id partagé par plusieurs sujets : UNE case");
    // Libellé et état coché du PREMIER déclarant (règle assumée et documentée — déterministe).
    ck.eq(offer.find((f) => f.id === "storage").checked, false, "stockage : décoché (l'état déclaré du premier déclarant)");
    ck.eq(offer.find((f) => f.id === "master").checked, true, "maître · repère : coché (déclaré par le seul sous-équipement)");
    ck.eq(offer.find((f) => f.id === "type").label, "Type", "libellé du premier déclarant (spare : « Type » nu)");
    /* 🚨 L'OFFRE ne porte AUCUNE valeur (type `Omit<LabelFieldDecl, "value">`) : elle vaut pour N
       sujets, elle ne peut donc porter la valeur d'aucun. Une fuite de `value` ferait afficher au
       dialogue — et pire, mémoriser — la donnée du PREMIER déclarant comme si elle était celle de
       la planche. Les DRAPEAUX de rendu, eux, doivent survivre au passage (le dialogue en a besoin
       pour la règle contenu × champ). */
    ck(offer.every((f) => !("value" in f)), "aucune case de l'offre ne porte de `value` (l'union vaut pour N sujets)");
    const eqOffer = LabelPrintPolicy.fieldOffer([equipmentSubject()]);
    ck.eq(eqOffer.find((f) => f.id === "serial").hideOnSmall, true, "drapeau hideOnSmall reporté dans l'offre");
    ck.eq(eqOffer.find((f) => f.id === "owner").qrOnly, true, "drapeau qrOnly reporté dans l'offre (la règle du contenu en dépend)");
    ck(!("qrOnly" in eqOffer.find((f) => f.id === "location")), "…et un drapeau ABSENT le reste (pas de `false` fabriqué)");
    // Au RENDU, un sujet qui ne déclare pas un id coché saute la ligne — c'est ce qui rend la
    // planche mixte sûre sans le moindre cas particulier.
    const checkedAll = {}; for (const f of offer) checkedAll[f.id] = true;
    const txHtml = LabelHtml.label(tx, spec({ size: "s" }), { ends: false, checked: checkedAll }, "<svg></svg>");
    ck(txHtml.includes("SFP+") && !txHtml.includes("SN "), "le transceiver rend SES lignes — pas de série déclarée, pas de ligne SN");
    const diskHtml = LabelHtml.label(disk, spec({ size: "s" }), { ends: false, checked: checkedAll }, "<svg></svg>");
    ck(diskHtml.includes("SN S1") && diskHtml.includes("B2"), "le disque rend série ET stockage (tout coché sur cette planche)");
    // Le gabarit L d'un SPARE : sa liste s'ouvre sur un registre SECONDAIRE (`type` = meta), donc le
    // filet tombe juste après l'identifiant — la règle « avant la 1re ligne non-loc » exprimée sur
    // une liste qui n'a pas d'emplacement en tête, là où l'équipement en avait un.
    const diskL = LabelHtml.label(disk, spec({ size: "l" }), { ends: false, checked: checkedAll }, "<svg></svg>");
    ck(diskL.indexOf('class="rule"') > diskL.indexOf("l-id") && diskL.indexOf('class="rule"') < diskL.indexOf("l-meta"),
      "spare au L : le filet sépare l'identifiant du premier registre secondaire (liste sans emplacement en tête)");
    // 🚨 Les déclarations du petit matériel s'impriment AU GABARIT S (leur défaut) — c'était
    // l'objet même de T10 : rien n'y est hideOnSmall, et le CSS du S connaît meta/sn.
    ck(diskHtml.includes("l-meta") && diskHtml.includes("l-sn"), "gabarit S : type/caractéristiques/série du spare s'impriment (pas de hideOnSmall)");
    ck(LabelHtml.CSS.includes(".lab.s .l-meta") && LabelHtml.CSS.includes(".lab.s .l-sn"), "le CSS du registre S donne une taille aux registres meta/sn (nouveaux venus au S)");
    ck.eq(LabelPrintPolicy.fieldOffer([]).length, 0, "aucun sujet : offre vide (fonction totale)");
  });

  await section("labels : LabelPrintPolicy — LA matrice (sujet × contenu × format × nombre × offre)", async () => {
    // Offres représentatives — la forme qu'en produit fieldOffer (déclaration sans valeur).
    const equipmentOffer = [
      { id: "location", label: "Emplacement", checked: true, style: "loc" },
      { id: "type", label: "Type / famille", checked: false, style: "meta", hideOnSmall: true },
      { id: "serial", label: "N° de série", checked: false, style: "sn", hideOnSmall: true },
      { id: "owner", label: "Propriétaire", checked: false, style: "own", qrOnly: true },
    ];
    const cableOffer = [{ id: "type", label: "Type / famille", checked: true, style: "meta" }];
    const v = (kind, content, size, count, offer) => LabelPrintPolicy.visibility(kind, content, size, count || 1, offer || (LabelPrintPolicy.isFlagKind(kind) ? cableOffer : equipmentOffer));

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

    // CASES (T10) : le verdict liste les IDS de l'offre visibles sous le contenu — la modale
    // masque les autres. La règle est `fieldVisible`, la MÊME qui filtre les lignes imprimées.
    ck.eq(v("equipment", "full", "m").visibleFieldIds.join(","), "location,type,serial,owner", "QR + texte : toute l'offre est visible");
    const qrOnly = v("equipment", "qr", "m");
    ck.eq(qrOnly.visibleFieldIds.join(","), "owner", "QR seul : seule la déclaration qrOnly survit (bande sous le carré)");
    ck(!qrOnly.showIdRow, "QR seul : la rangée « Identifiant (toujours) » n'a plus de sens");
    ck(qrOnly.showFieldsSection, "…mais la section survit pour cette seule case");
    const idOnly = v("cable", "id", "cable");
    ck.eq(idOnly.visibleFieldIds.length, 0, "identifiant seul : aucune case (c'est le principe du contenu)");
    ck(!idOnly.showIdRow && !idOnly.showEndsToggle && !idOnly.showFieldsSection, "identifiant seul : la SECTION entière disparaît, bascule A/B comprise");
    ck.eq(v("cable", "strip", "cable").visibleFieldIds.join(","), "type", "manchon repère complet : le type se propose");
    ck(!LabelPrintPolicy.fieldVisible({ style: "sn" }, "strip"), "…mais un registre sn y serait écarté (règle héritée du modèle figé)");
    ck(LabelPrintPolicy.fieldVisible({ style: "sn" }, "full"), "fieldVisible : sn passe en QR + texte");
    ck(!LabelPrintPolicy.fieldVisible({ style: "own" }, "qr") && LabelPrintPolicy.fieldVisible({ style: "own", qrOnly: true }, "qr"), "fieldVisible : « QR seul » exige le drapeau qrOnly, pas un style");

    // BASCULE A / B : structurelle, sujets à drapeau seulement, contenus à texte seulement.
    ck(v("cable", "full", "cable").showEndsToggle && v("bundle", "full", "cable").showEndsToggle, "câble/faisceau : bascule « Extrémités A / B »");
    ck(v("cable", "strip", "cable").showEndsToggle, "manchon repère complet : la bascule reste");
    ck(!v("cable", "qr", "cable").showEndsToggle, "QR seul : plus de texte, plus de bascule");
    ck(!v("equipment", "full", "m").showEndsToggle && !v("rack", "full", "rack").showEndsToggle, "équipement/baie : jamais de bascule A/B");

    // PLANCHE : à partir de 2 étiquettes seulement.
    ck(!v("equipment", "full", "m", 1).showSheetSection, "1 étiquette : pas de section Planche");
    ck(v("equipment", "full", "m", 2).showSheetSection, "2 étiquettes : la section Planche apparaît");
  });

  await section("labels : LabelPrintPolicy — sanitize : réglage MÉMORISÉ ramené dans l'offre du tirage", async () => {
    const offer = [
      { id: "location", label: "Emplacement", checked: true, style: "loc" },
      { id: "owner", label: "Propriétaire", checked: false, style: "own", qrOnly: true },
    ];
    // Contenu/format hérités invalides : retombée sur le défaut du contexte (règle inchangée).
    const held = { content: "strip", size: "cable", fields: { location: false } };
    const cleaned = LabelPrintPolicy.sanitize("equipment", offer, held);
    ck.eq(cleaned.content, "full", "contenu manchon hérité sur un équipement → QR + texte");
    ck.eq(cleaned.size, "m", "format drapeau hérité sur un équipement → son défaut (M)");
    ck(cleaned === held, "muté EN PLACE (l'objet de session est partagé par référence)");
    // T10 — RÉCONCILIATION avec l'offre : la mémoire UTILE est conservée, les ids disparus
    // retirés, les ids nouveaux semés à leur état coché DÉCLARÉ.
    ck.eq(cleaned.fields.location, false, "un choix mémorisé sur un id encore offert est CONSERVÉ (décoché reste décoché)");
    ck.eq(cleaned.fields.owner, false, "id nouveau : semé à son défaut déclaré (owner décoché)");
    const stale = LabelPrintPolicy.sanitize("spare", [{ id: "storage", label: "Stockage", checked: false, style: "loc" }], { content: "full", size: "s", fields: { serial: true, storage: true } });
    ck(!("serial" in stale.fields), "id absent de l'offre courante : retiré (la mémoire d'une case disparue ne resurgit pas ailleurs)");
    ck.eq(stale.fields.storage, true, "…mais le stockage coché par l'utilisateur reste coché (la mémoire prime sur le défaut déclaré)");
    // Un réglage VALIDE traverse sans être touché (le sanitize n'écrase pas la mémoire utile).
    const kept = LabelPrintPolicy.sanitize("cable", [{ id: "type", label: "Type / famille", checked: true, style: "meta" }], { content: "id", size: "cable", fields: { type: true } });
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
    ck.eq(s.fields.map((f) => f.id + ":" + f.checked).join(","), "type:true", "une seule case déclarée : le type, coché");
    ck.eq(s.fields[0].value, "OM4 12F · 12 brins · 45 m", "type = fibre · capacité · longueur");
    ck(!s.fields.some((f) => f.id === "serial" || f.id === "owner"), "ni n° de série ni propriétaire (le modèle n'en a pas) — la case n'existe pas, structurellement");
    // Champs manquants : la déclaration disparaît, jamais de « null » imprimé.
    const bare = LabelSubjects.bundle(reader, { id: "b2", name: "TRK-2", cable_type_id: null, fiber_count: null, length_m: null, endpoint_a_equipment_id: null, endpoint_b_equipment_id: "pb" });
    ck.eq(bare.endA, "", "extrémité non raccordée → chaîne vide (ligne absente à l'impression)");
    ck.eq(bare.endB, "PATCH-B7", "…l'autre reste imprimée");
    ck.eq(bare.fields.length, 0, "aucun attribut de type → AUCUNE déclaration (pas de case sans donnée)");
    // Le drapeau se rend comme celui d'un câble (même anatomie) : 2 panneaux + zone d'enroulement.
    const flag = LabelHtml.label(s, spec({ size: "cable", qr: 18 }), { ends: true, checked: { type: true } }, '<svg data-qr="1"></svg>');
    ck((flag.match(/class="pan/g) || []).length === 2 && flag.includes("PATCH-A1"), "faisceau : drapeau à 2 panneaux, extrémité A imprimée");
  });
};
