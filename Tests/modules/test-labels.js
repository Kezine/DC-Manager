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
                          (fieldOffer), la règle contenu × champ (fieldVisible) et la retombée
                          sanitize (réconciliée avec l'offre). 🚨 T11 (2026-09-03) : le verdict
                          `visibility` (« montre / cache ») a DISPARU à son tour au profit de
                          `availability` (« disponible / indisponible + CODE de raison »), et
                          s'ajoutent la PROJECTION support ⇄ (gabarit, contenu), les registres
                          d'avertissement, le développement du tirage (`expand`) et le papier ;
     - core/LabelExportPlan : 🚨 T11 — nommage et arithmétique de l'export en images (Q11.13),
                          dont la cote de QR à k pixels ENTIERS par module ;
     - core/LabelSubjects : les DÉCLARATIONS de champs imprimables par sujet (T10 —
                          spare : caractéristiques PAR TYPE via Spare.techSummary, achat,
                          stockage décoché ; sous-équipement : maître · repère, SANS la
                          garantie ; équipement/baie/câble/faisceau : offres et défauts
                          STRICTEMENT ceux d'avant T10, verrouillés en dur ici).
   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D } = require("./harness.js");

module.exports = async () => {
  const { LabelLayout } = D("core/LabelLayout.js");
  const { LabelQrSvg } = D("core/LabelQrSvg.js");
  const { LabelHtml } = D("core/LabelHtml.js");
  const { LabelPrintPolicy } = D("core/LabelPrintPolicy.js");
  const { LabelExportPlan } = D("core/LabelExportPlan.js");
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

  await section("labels : LabelPrintPolicy — T11 : la PROJECTION support ⇄ (gabarit, contenu)", async () => {
    /* L'axe « Support » de la refonte n'est PAS un nouvel axe du modèle : c'est une LECTURE de
       (size, content). C'est toute la thèse du chantier (voie A) — le moteur d'impression et ses
       cinq pièges d'impression n'ont pas à bouger pour que le panneau change de langage. */
    ck.eq(LabelPrintPolicy.supportOf("m", "full"), "label", "gabarit rectangulaire + QR/texte → étiquette plate");
    ck.eq(LabelPrintPolicy.supportOf("custom", "qr"), "label", "cotes libres + QR seul → étiquette plate aussi");
    ck.eq(LabelPrintPolicy.supportOf("rack", "full"), "rackhead", "gabarit `rack` → tête de baie");
    ck.eq(LabelPrintPolicy.supportOf("cable", "full"), "flag", "gabarit `cable` → drapeau");
    ck.eq(LabelPrintPolicy.supportOf("cable", "qr"), "flag", "…QR seul compris (c'est le second panneau qui change)");
    ck.eq(LabelPrintPolicy.supportOf("cable", "strip"), "sleeve", "contenu de manchon → manchon");
    ck.eq(LabelPrintPolicy.supportOf("m", "id"), "sleeve", "🚨 le CONTENU l'emporte : un manchon reste un manchon quel que soit le gabarit hérité");

    /* 🚨 L'INVARIANT : écrire un support puis le relire rend le même support, pour tout support
       DISPONIBLE. Sans lui, un clic sur une carte pourrait laisser l'UI sur une autre carte —
       exactement le genre d'état que l'ancienne modale savait produire. */
    const kinds = ["equipment", "rack", "cable", "bundle", "spare", "subEquipment"];
    for (const kind of kinds) {
      const av = LabelPrintPolicy.availability(kind, "label", "full", []);
      for (const sup of ["label", "rackhead", "flag", "sleeve"]) {
        if (av.supports[sup] !== "ok") continue;
        // Depuis des états de DÉPART variés : la projection doit être totale, pas seulement
        // juste sur le chemin heureux.
        for (const from of [{ size: "m", content: "full" }, { size: "cable", content: "strip" }, { size: "rack", content: "qr" }]) {
          const out = LabelPrintPolicy.applySupport(kind, sup, Object.assign({}, from));
          ck.eq(LabelPrintPolicy.supportOf(out.size, out.content), sup, `${kind} : ${from.size}/${from.content} → support ${sup} → relu ${sup}`);
          ck(LabelPrintPolicy.contentsFor(kind).includes(out.content), `${kind}/${sup} : le contenu produit est OFFERT par le sujet`);
          ck(LabelPrintPolicy.sizesFor(kind).includes(out.size), `${kind}/${sup} : le gabarit produit est OFFERT par le sujet`);
        }
      }
    }
    // Le couplage que l'ancienne modale laissait à l'utilisateur, écrit une fois pour toutes.
    ck.eq(LabelPrintPolicy.applySupport("cable", "sleeve", { size: "cable", content: "full" }).content, "strip", "choisir « Manchon » force un contenu de manchon");
    ck.eq(LabelPrintPolicy.applySupport("cable", "flag", { size: "cable", content: "id" }).content, "full", "…et en sortir rend un contenu à QR");
    ck.eq(LabelPrintPolicy.applySupport("cable", "sleeve", { size: "cable", content: "id" }).content, "id", "un contenu de manchon DÉJÀ choisi est conservé (on ne réécrit pas un choix valide)");
    // Retombée du gabarit : un câble n'a pas de S/M/L sur lequel retomber — il n'a que « libre ».
    ck.eq(LabelPrintPolicy.labelSizesFor("cable").join(","), "custom", "câble en étiquette plate : cotes libres seulement (un rectangle ne s'attache pas à un brin)");
    ck.eq(LabelPrintPolicy.labelSizesFor("equipment").join(","), "s,m,l,custom", "équipement : les trois préréglages + libre");
    ck.eq(LabelPrintPolicy.labelSizesFor("rack").join(","), "s,m,l,custom", "baie : le gabarit `rack` sort de la liste PLATE (il EST la tête de baie)");
    ck.eq(LabelPrintPolicy.applySupport("cable", "label", { size: "cable", content: "full" }).size, "custom", "câble → étiquette plate : retombe sur « libre », le seul gabarit qu'il offre");
    ck.eq(LabelPrintPolicy.applySupport("equipment", "label", { size: "cable", content: "full" }).size, "m", "équipement → étiquette plate : retombe sur SON défaut (M)");
  });

  await section("labels : LabelPrintPolicy — T11 : DISPONIBILITÉ AVEC RAISON (remplace la matrice de `hidden`)", async () => {
    /* 🚨 CETTE SECTION REMPLACE « LA matrice » d'avant T11. Le verdict ne dit plus « montre /
       cache » mais « disponible / indisponible + CODE de raison » : le panneau grise et explique
       au lieu de faire deviner. Même famille que PortCompatibility / BreakoutRules — des codes,
       jamais de phrases (les libellés vivent dans i18n `labels.why.*`). */
    const equipmentOffer = [
      { id: "location", label: "Emplacement", checked: true, style: "loc" },
      { id: "type", label: "Type / famille", checked: false, style: "meta", hideOnSmall: true },
      { id: "serial", label: "N° de série", checked: false, style: "sn", hideOnSmall: true },
      { id: "owner", label: "Propriétaire", checked: false, style: "own", qrOnly: true },
    ];
    const cableOffer = [{ id: "type", label: "Type / famille", checked: true, style: "meta" }];
    const av = (kind, support, content, offer) => LabelPrintPolicy.availability(kind, support, content, offer || (LabelPrintPolicy.isFlagKind(kind) ? cableOffer : equipmentOffer));

    // -- SUPPORTS : les quatre sont TOUJOURS listés ; seule leur disponibilité change. --
    const eq = av("equipment", "label", "full");
    ck.eq(Object.keys(eq.supports).sort().join(","), "flag,label,rackhead,sleeve", "les QUATRE supports sont toujours répondus (aucun n'est muet)");
    ck.eq(eq.supports.label, "ok", "tout objet peut porter un autocollant");
    ck.eq(eq.supports.rackhead, "rack-only", "équipement : la tête de baie est refusée AVEC sa raison");
    ck.eq(eq.supports.flag, "flag-only", "…le drapeau aussi");
    ck.eq(eq.supports.sleeve, "flag-only", "…le manchon aussi");
    ck.eq(av("rack", "rackhead", "full").supports.rackhead, "ok", "baie : la tête de baie s'ouvre");
    ck.eq(av("rack", "rackhead", "full").supports.flag, "flag-only", "…mais pas le drapeau (une baie ne s'enroule pas)");
    for (const kind of ["cable", "bundle"]) {
      const flag = av(kind, "flag", "full");
      ck(flag.supports.flag === "ok" && flag.supports.sleeve === "ok", kind + " : drapeau ET manchon ouverts (même anatomie)");
      ck.eq(flag.supports.rackhead, "rack-only", kind + " : la tête de baie reste refusée");
      ck.eq(flag.supports.label, "ok", kind + " : l'étiquette plate reste OFFERTE (par les cotes libres)");
    }
    ck.eq(av("subEquipment", "label", "full").supports.sleeve, "flag-only", "sous-équipement : pas de manchon (isSpareLike n'enroule pas)");

    // -- CONTENUS : le couplage support ⇄ contenu, énoncé comme une raison. --
    const flagFull = av("cable", "flag", "full");
    ck.eq(flagFull.contents.full + "/" + flagFull.contents.qr, "ok/ok", "drapeau : QR + texte et QR seul");
    ck.eq(flagFull.contents.strip, "needs-sleeve", "drapeau : un contenu de manchon DEMANDE le support manchon (raison, pas silence)");
    const sleeve = av("cable", "sleeve", "strip");
    ck.eq(sleeve.contents.strip + "/" + sleeve.contents.id, "ok/ok", "manchon : ses deux contenus");
    ck.eq(sleeve.contents.full, "needs-not-sleeve", "manchon : « QR + texte » refusé — le manchon ne porte pas de QR");
    ck.eq(sleeve.contents.qr, "needs-not-sleeve", "…« QR seul » aussi, et pour la même raison");
    const eqContents = av("equipment", "label", "full").contents;
    ck.eq(eqContents.strip + "/" + eqContents.id, "flag-only/flag-only", "équipement : les manchons refusés parce qu'un équipement ne s'enroule pas");
    ck.eq(eqContents.full + "/" + eqContents.qr, "ok/ok", "…ses deux contenus restent ouverts");

    // -- GABARITS : le S/M/L d'une étiquette plate, refusé AVEC sa raison sur un brin. --
    const eqSizes = av("equipment", "label", "full").sizes;
    ck.eq(eqSizes.s + "/" + eqSizes.m + "/" + eqSizes.l + "/" + eqSizes.custom, "ok/ok/ok/ok", "équipement : les trois préréglages et les cotes libres");
    ck.eq(eqSizes.rack, "rack-only", "…le gabarit Baie refusé avec sa raison");
    ck.eq(eqSizes.cable, "flag-only", "…le gabarit drapeau aussi");
    const cableSizes = av("cable", "label", "full").sizes;
    ck.eq(cableSizes.s + "/" + cableSizes.m + "/" + cableSizes.l, "not-flag/not-flag/not-flag", "🚨 câble : S/M/L refusés — « un rectangle ne s'attache pas à un brin »");
    ck.eq(cableSizes.custom + "/" + cableSizes.cable, "ok/ok", "…restent les cotes libres et le drapeau");

    // -- BASCULE A / B / A+B : anatomie (absente hors drapeau) vs refus (grisée sans texte). --
    ck.eq(av("cable", "flag", "full").ends, "ok", "câble en QR + texte : la bascule d'extrémités a un sens");
    ck.eq(av("bundle", "sleeve", "strip").ends, "ok", "faisceau en manchon repère complet : elle en a un aussi");
    ck.eq(av("cable", "flag", "qr").ends, "no-text", "QR seul : plus de texte d'extrémité à marquer → refus NOMMÉ");
    ck.eq(av("cable", "sleeve", "id").ends, "no-text", "identifiant seul : idem");
    ck.eq(av("equipment", "label", "full").ends, "not-flag", "équipement : la question ne se pose pas (l'UI l'ABSENTE, elle ne la grise pas)");
    ck.eq(av("rack", "rackhead", "full").ends, "not-flag", "baie : idem");

    // -- COTES : elles DESCENDENT du support (règle des « cotes mm » d'avant T11, réexprimée). --
    ck.eq(LabelPrintPolicy.cotesFor("sleeve", "strip").join(","), "dia,len", "manchon : Ø et longueur, rien d'autre (il n'a pas de QR)");
    ck.eq(LabelPrintPolicy.cotesFor("rackhead", "full").join(","), "qr", "tête de baie : la cote du QR seule (100 × 60 est un format unique)");
    ck.eq(LabelPrintPolicy.cotesFor("flag", "full").join(","), "qr", "🚨 drapeau : la cote du QR SEULE — toute sa géométrie en est dérivée");
    ck.eq(LabelPrintPolicy.cotesFor("label", "full", "m").join(","), "", "étiquette plate à préréglage : aucune cote libre (le gabarit les impose)");
    ck.eq(LabelPrintPolicy.cotesFor("label", "full", "custom").join(","), "w,h,qr", "cotes libres : largeur, hauteur ET cote de QR");
    ck.eq(LabelPrintPolicy.cotesFor("label", "qr", "m").join(","), "qr", "QR seul : la cote du QR, et elle seule");
    ck.eq(av("cable", "sleeve", "strip").cotes.join(","), "dia,len", "la disponibilité porte la MÊME liste que cotesFor (une seule règle)");

    // -- CASES : la règle contenu × champ, rendue par id (l'UI grise, elle ne cache pas). --
    const full = av("equipment", "label", "full");
    ck.eq(Object.keys(full.fields).join(","), "location,type,serial,owner", "toute l'offre est répondue");
    ck(Object.values(full.fields).every((v) => v === "ok"), "QR + texte : toutes les cases actives");
    const qrOnly = av("equipment", "label", "qr");
    ck.eq(qrOnly.fields.owner, "ok", "QR seul : la déclaration qrOnly survit (bande sous le carré)");
    ck.eq(qrOnly.fields.location + "/" + qrOnly.fields.type, "no-text/no-text", "…les autres sont INERTES, avec leur raison (plus jamais `hidden`)");
    ck.eq(av("cable", "sleeve", "id").fields.type, "no-text", "identifiant seul : aucune case active");
    ck.eq(av("cable", "sleeve", "strip").fields.type, "ok", "manchon repère complet : le type se propose");
    // La règle elle-même n'a pas bougé (elle pilote aussi les LIGNES imprimées).
    ck(!LabelPrintPolicy.fieldVisible({ style: "sn" }, "strip"), "un registre sn reste écarté d'un manchon (règle héritée du modèle figé)");
    ck(LabelPrintPolicy.fieldVisible({ style: "sn" }, "full"), "fieldVisible : sn passe en QR + texte");
    ck(!LabelPrintPolicy.fieldVisible({ style: "own" }, "qr") && LabelPrintPolicy.fieldVisible({ style: "own", qrOnly: true }, "qr"), "fieldVisible : « QR seul » exige le drapeau qrOnly, pas un style");

    // 🚨 `visibility` a DISPARU : c'est le verdict « montre/cache » que la refonte remplace.
    ck.eq(typeof LabelPrintPolicy.visibility, "undefined", "🚨 l'ancienne matrice de visibilité n'existe plus (T11)");
  });

  await section("labels : LabelPrintPolicy — T11 : registres d'avertissement (classification pure)", async () => {
    /* Deux registres, pas un tas : ce qui COMPROMET l'objet imprimé va sous l'aperçu, ce qui
       DÉCRIT ce qui sortira de l'imprimante va au pied. Le bouton Imprimer reste actif dans les
       deux cas — on imprime pour son propre usage. */
    ck.eq(LabelPrintPolicy.warningRegister("qr-floor"), "scan", "QR sous le plancher : ça compromet le scan");
    ck.eq(LabelPrintPolicy.warningRegister("qr-exceeds-label"), "scan", "QR rogné : idem");
    ck.eq(LabelPrintPolicy.warningRegister("sleeve-tight"), "scan", "manchon trop court pour son texte : idem");
    ck.eq(LabelPrintPolicy.warningRegister("module-too-small"), "scan", "module sous 0,5 mm : le nouvel avis Q11.14 est un risque de SCAN");
    ck.eq(LabelPrintPolicy.warningRegister("columns-capped"), "sheet", "colonnes plafonnées : ça décrit le tirage, ça ne compromet rien");
    ck.eq(LabelPrintPolicy.warningRegister("multi-page"), "sheet", "planche multi-feuilles : idem");
    // EXHAUSTIVITÉ : tout code de LabelLayout est classé (un code sans registre serait muet à l'UI).
    const codes = ["qr-floor", "qr-exceeds-label", "columns-capped", "multi-page", "sleeve-tight", "module-too-small"];
    ck(codes.every((c) => ["scan", "sheet"].includes(LabelPrintPolicy.warningRegister(c))), "les SIX codes sont classés dans un registre");
  });

  await section("labels : LabelPrintPolicy — T11 : `expand` (bouts × occurrences, GROUPÉS) et papier", async () => {
    const a = { collection: "cables", id: "c1", name: "CBL-1", endA: "X", endB: "Y", fields: [] };
    const b = { collection: "cables", id: "c2", name: "CBL-2", endA: "P", endB: "Q", fields: [] };
    const eq = { collection: "equipments", id: "e1", name: "SRV-1", fields: [] };
    const opts = (endsMode, occurrences) => ({ endsMode, occurrences });

    // Un drapeau, deux bouts : le geste principal d'avant T11 — sauf qu'il est maintenant réglable.
    const ab = LabelPrintPolicy.expand([a], "cable", opts("ab", 1));
    ck.eq(ab.length, 2, "A + B → deux drapeaux");
    ck.eq(ab.map((i) => i.localEnd).join(","), "A,B", "…et chacun MARQUE son bout (c'est ce qui les rend distincts)");
    ck(ab.every((i) => i.subject === a), "…tous deux sur le MÊME sujet (aucune copie de sujet)");
    ck.eq(LabelPrintPolicy.expand([a], "cable", opts("a", 1)).map((i) => i.localEnd).join(","), "A", "A seule → un drapeau, marqué A");
    ck.eq(LabelPrintPolicy.expand([a], "cable", opts("b", 1)).map((i) => i.localEnd).join(","), "B", "B seule → un drapeau, marqué B");

    // 🚨 GROUPEMENT : bout puis occurrence — « A, A, B, B », jamais « A, B, A, B ».
    ck.eq(LabelPrintPolicy.expand([a], "cable", opts("ab", 2)).map((i) => i.localEnd).join(","), "A,A,B,B", "🚨 A+B × 2 : groupé PAR BOUT (A, A, B, B)");
    ck.eq(LabelPrintPolicy.expand([a], "cable", opts("a", 3)).length, 3, "A seule × 3 → trois drapeaux");

    // 🚨 SUJET en boucle EXTÉRIEURE : les deux drapeaux d'un même câble restent VOISINS sur la
    // planche — on les découpe ensemble pour aller les poser ensemble.
    const two = LabelPrintPolicy.expand([a, b], "cable", opts("ab", 1));
    ck.eq(two.map((i) => i.subject.name + i.localEnd).join(","), "CBL-1A,CBL-1B,CBL-2A,CBL-2B", "🚨 deux liens : chaque paire reste groupée (jamais tous les A puis tous les B)");

    // Sujets sans extrémités : pas de bouts, seulement des occurrences.
    const spares = LabelPrintPolicy.expand([eq], "equipment", opts("ab", 3));
    ck.eq(spares.length, 3, "équipement × 3 → trois étiquettes (« une pour la boîte, une pour le disque »)");
    ck(spares.every((i) => i.localEnd === undefined), "…aucune n'est marquée d'un bout (un équipement n'en a pas)");
    ck.eq(LabelPrintPolicy.expand([eq], "equipment", opts("ab", 1)).length, 1, "occurrences = 1 : le comportement d'avant T11, à l'identique");

    // Fonction TOTALE : entrées dégénérées bornées plutôt que refusées.
    ck.eq(LabelPrintPolicy.expand([], "cable", opts("ab", 2)).length, 0, "aucun sujet → aucune étiquette");
    ck.eq(LabelPrintPolicy.expand([a], "cable", opts("ab", 0)).length, 2, "occurrences 0 → ramené à 1 (× 2 bouts)");
    ck.eq(LabelPrintPolicy.expand([a], "cable", opts("ab", 999)).length, 2 * LabelPrintPolicy.OCCURRENCES_MAX, "occurrences démesurées → plafonnées");

    // PAPIER : `auto` rejoue la règle implicite d'avant T11, un choix explicite prime.
    ck.eq(LabelPrintPolicy.paperOf("auto", 1), "roll", "auto + 1 étiquette → page à la cote exacte (rouleau)");
    ck.eq(LabelPrintPolicy.paperOf("auto", 2), "sheet", "auto + 2 étiquettes → planche A4 (la règle historique)");
    ck.eq(LabelPrintPolicy.paperOf("roll", 150), "roll", "🚨 choix explicite « rouleau » : 150 étiquettes partent en 150 pages");
    ck.eq(LabelPrintPolicy.paperOf("sheet", 1), "sheet", "…et « planche » impose la planche même pour une seule");
  });

  await section("labels : LabelPrintPolicy — T11 : sanitize des nouveaux réglages du tirage", async () => {
    const base = () => ({ content: "full", size: "m", fields: {}, endsMode: "b", occurrences: 4, paper: "roll", dpi: 600, cols: 3 });
    const eq = LabelPrintPolicy.sanitize("equipment", [], base());
    ck.eq(eq.endsMode, "ab", "🚨 `endsMode` hérité d'un câble RETOMBE sur `ab` hors drapeau : sans objet, il ferait un tirage d'un seul drapeau au retour");
    ck.eq(eq.occurrences, 4, "occurrences valides : conservées");
    ck.eq(eq.paper + "/" + eq.dpi, "roll/600", "papier et résolution valides : conservés");
    const cable = LabelPrintPolicy.sanitize("cable", [], base());
    ck.eq(cable.endsMode, "b", "…mais un drapeau garde son « B seule » (c'est un choix, pas une coquille)");
    // Bornes et valeurs illisibles.
    ck.eq(LabelPrintPolicy.sanitize("cable", [], Object.assign(base(), { occurrences: 0 })).occurrences, 1, "occurrences 0 → 1");
    ck.eq(LabelPrintPolicy.sanitize("cable", [], Object.assign(base(), { occurrences: 99 })).occurrences, LabelPrintPolicy.OCCURRENCES_MAX, "occurrences 99 → plafond");
    ck.eq(LabelPrintPolicy.sanitize("cable", [], Object.assign(base(), { occurrences: 2.7 })).occurrences, 2, "occurrences fractionnaire → entier");
    ck.eq(LabelPrintPolicy.sanitize("cable", [], Object.assign(base(), { occurrences: "x" })).occurrences, 1, "occurrences illisible → 1 (jamais NaN mémorisé)");
    ck.eq(LabelPrintPolicy.sanitize("cable", [], Object.assign(base(), { paper: "papyrus" })).paper, "auto", "papier inconnu → auto");
    ck.eq(LabelPrintPolicy.sanitize("cable", [], Object.assign(base(), { dpi: 1200 })).dpi, LabelPrintPolicy.DEFAULT_DPI, "résolution hors liste → le défaut (300)");
    ck.eq(LabelPrintPolicy.sanitize("cable", [], Object.assign(base(), { endsMode: "z" })).endsMode, "ab", "bascule illisible → ab");
    // Les défauts d'un contexte passent sanitize SANS être touchés (ils sont valides par construction).
    for (const kind of ["equipment", "rack", "cable", "bundle", "spare", "subEquipment"]) {
      const d = LabelPrintPolicy.defaults(kind);
      const before = JSON.stringify(d);
      ck.eq(JSON.stringify(LabelPrintPolicy.sanitize(kind, [], d)), before, kind + " : les défauts traversent sanitize inchangés");
    }
    ck.eq(LabelPrintPolicy.defaults("cable").endsMode, "ab", "🚨 défaut de la bascule = A + B — le geste principal d'avant T11 reste le défaut");
    ck.eq(LabelPrintPolicy.defaults("equipment").occurrences, 1, "défaut d'occurrences = 1 (le comportement d'avant)");
    ck.eq(LabelPrintPolicy.defaults("equipment").paper, "auto", "défaut de papier = la règle automatique");
    ck.eq(LabelPrintPolicy.defaults("equipment").dpi, 300, "défaut de résolution = 300 dpi (la laser bureautique)");
  });

  await section("labels : LabelLayout — 🚨 Q11.14 : la cote du QR QUANTIFIÉE (modules carrés)", async () => {
    /* Le diagnostic : un module n'est un carré à l'impression que s'il tombe sur un nombre ENTIER
       de pixels de sortie. À 20 mm sur 41 modules et 300 dpi, un module fait 5,76 px — le rasteur
       en met tantôt 5, tantôt 6, et « chaque ligne du QR est altérée ». On arrondit donc VERS LE
       BAS le nombre de pixels par module, puis on recompose la cote. */
    const q = LabelLayout.quantizeQrMm(41, 300, 20);
    ck.eq(q.pxPerModule, 5, "41 modules à 300 dpi dans 20 mm : 5 px entiers par module (5,76 tronqué)");
    ck(near(q.mm, 41 * 5 * 25.4 / 300), "…d'où une cote de " + q.mm.toFixed(2) + " mm");
    ck(q.mm <= 20, "🚨 la cote quantifiée TIENT TOUJOURS dans la boîte (arrondi vers le bas, jamais vers le haut)");
    const q203 = LabelLayout.quantizeQrMm(41, 203, 20);
    ck.eq(q203.pxPerModule, 3, "la MÊME cote à 203 dpi : 3 px par module seulement (thermique)");
    ck(q203.mm < q.mm, "…et donc un QR plus petit : la question est PHYSIQUE, pas logicielle");
    const q600 = LabelLayout.quantizeQrMm(41, 600, 20);
    ck.eq(q600.pxPerModule, 11, "à 600 dpi : 11 px par module");
    ck(q600.mm > q.mm && q600.mm <= 20, "…une cote plus proche des 20 mm demandés, sans jamais les dépasser");
    // Plancher : jamais 0 px par module (une cote nulle = un QR absent, pire qu'un QR mauvais).
    ck.eq(LabelLayout.quantizeQrMm(41, 203, 2).pxPerModule, 1, "cote minuscule : 1 px par module au plancher, jamais 0");
    // Entrées dégénérées : la cote demandée passe telle quelle (fonction totale).
    ck.eq(LabelLayout.quantizeQrMm(0, 300, 20).mm, 20, "0 module → la cote demandée, intacte");
    ck.eq(LabelLayout.quantizeQrMm(41, 0, 20).mm, 20, "0 dpi → idem");

    /* 🚨 NON-RÉGRESSION : `renderQrMm` SANS le paramètre de quantification rend EXACTEMENT ce
       qu'il rendait — c'est ce qui garantit que les goldens de gabarits sont intacts. */
    for (const size of ["s", "m", "l", "rack"]) {
      const sp = spec({ size });
      ck.eq(LabelLayout.renderQrMm(sp), LabelLayout.rectQrGeometry(sp).qr, "gabarit " + size + " : cote inchangée sans quantification");
    }
    const m = spec({ size: "m" });
    const quantized = LabelLayout.renderQrMm(m, undefined, { dpi: 300, totalModules: 41 });
    ck(quantized <= LabelLayout.renderQrMm(m), "avec quantification : la cote ne peut que DESCENDRE (elle doit tenir)");
    ck(near(quantized, LabelLayout.quantizeQrMm(41, 300, LabelLayout.renderQrMm(m)).mm), "…et c'est exactement celle de quantizeQrMm sur la cote nominale");
    // Le drapeau/manchon/QR seul gardent leur propre chemin (leurs cotes DÉRIVENT du QR).
    ck.eq(LabelLayout.renderQrMm(spec({ size: "cable", qr: 18 })), 18, "drapeau : la cote demandée, telle quelle, sans quantification");
  });

  await section("labels : LabelLayout — 🚨 Q11.14 : l'avertissement « module trop petit »", async () => {
    /* Le plancher de 18 mm parle de la cote TOTALE ; il est déjà trop optimiste à 41 modules
       (0,44 mm par module). Le nouvel avis parle du MODULE — la seule mesure qui dise ce que
       l'imprimante doit résoudre. */
    const opts = (over) => Object.assign({ count: 1, requestedCols: 3 }, over);
    // SANS totalModules : aucun avis (on ne devine pas le nombre de modules d'un QR qu'on n'a pas).
    ck(!LabelLayout.warnings(spec({ size: "m" }), opts({})).includes("module-too-small"), "🚨 sans `totalModules` : AUCUN avis (les appels d'avant T11 sont intacts)");
    ck.eq(JSON.stringify(LabelLayout.warnings(spec({ size: "m" }), opts({}))), JSON.stringify(LabelLayout.warnings(spec({ size: "m" }), { count: 1, requestedCols: 3 })), "…et le verdict complet est identique à celui d'avant");
    // AVEC : 20 mm sur 41 modules = 0,49 mm — sous le plancher, c'est le défaut signalé.
    ck(LabelLayout.warnings(spec({ size: "m" }), opts({ totalModules: 41 })).includes("module-too-small"), "M (20 mm) sur 41 modules : module sous 0,5 mm → signalé");
    ck(!LabelLayout.warnings(spec({ size: "l" }), opts({ totalModules: 41 })).includes("module-too-small"), "L (28 mm) sur 41 modules : 0,68 mm par module → rien à signaler");
    ck(!LabelLayout.warnings(spec({ size: "rack" }), opts({ totalModules: 41 })).includes("module-too-small"), "tête de baie (34 mm) : large — rien à signaler");
    // Un QR à MOINS de modules (payload plus court) repasse au-dessus : c'est bien le MODULE qui compte.
    ck(!LabelLayout.warnings(spec({ size: "m" }), opts({ totalModules: 29 })).includes("module-too-small"), "🚨 le MÊME 20 mm sur 29 modules : 0,69 mm → aucun avis (c'est le module, pas la cote)");
    /* 🚨 La cote évaluée est celle qui sera SERVIE, quantification comprise — sans quoi on
       avertirait sur une cote que personne n'imprime. Un QR de 20,5 mm sur 41 modules fait
       exactement 0,50 mm par module : rien à signaler TEL QUEL. Mais à 203 dpi la
       quantification ne loge que 3 px par module (3,99 tronqué), la cote tombe à 15,4 mm et le
       module à 0,38 mm — c'est ce QR-là qui sort de l'imprimante, c'est donc lui qu'on juge. */
    const asked = spec({ size: "custom", content: "qr", qr: 20.5 });
    ck(!LabelLayout.warnings(asked, opts({ totalModules: 41 })).includes("module-too-small"), "20,5 mm sur 41 modules = 0,50 mm par module : à la limite, rien à signaler");
    const served = spec({ size: "custom", content: "qr", qr: 20.5, dpi: 203 });
    ck(LabelLayout.warnings(served, opts({ totalModules: 41 })).includes("module-too-small"), "🚨 le MÊME réglage à 203 dpi : la cote servie tombe à 15,4 mm → l'avis suit la RÉALITÉ imprimée");
    /* 🚨 ET À 600 dpi, ÇA AVERTIT ENCORE — c'est le fond du diagnostic Q11.14, pas un défaut du
       test : monter la résolution réduit la PERTE de quantification (19,1 mm au lieu de 15,4)
       mais ne crée pas de place. À 41 modules, il faut 20,5 mm de QR pour tenir le plancher, et
       aucun réglage d'imprimante n'y changera rien. Le vrai levier est de RACCOURCIR le payload
       (une route courte `/q/<id>` ferait tomber la version 4 → 3, soit 33 → 29 modules) — décidé
       HORS PÉRIMÈTRE du chantier T11, et la raison pour laquelle cet avis est INFORMATIF. */
    const hi = spec({ size: "custom", content: "qr", qr: 20.5, dpi: 600 });
    ck(LabelLayout.warnings(hi, opts({ totalModules: 41 })).includes("module-too-small"), "🚨 même à 600 dpi : 41 modules dans 20,5 mm restent sous le plancher (le levier est le PAYLOAD, hors périmètre)");
    ck(LabelLayout.renderQrMm(hi, undefined, { dpi: 600, totalModules: 41 }) > LabelLayout.renderQrMm(served, undefined, { dpi: 203, totalModules: 41 }), "…mais monter la résolution réduit bien la PERTE de quantification");
    // Les manchons n'ont pas de QR : jamais d'avis de module.
    ck(!LabelLayout.warnings(spec({ size: "cable", content: "strip" }), opts({ totalModules: 41 })).includes("module-too-small"), "manchon : pas de QR, donc pas de module à mesurer");
    ck.eq(LabelLayout.MODULE_FLOOR_MM, 0.5, "le plancher de module est 0,5 mm (mesuré sur thermique 203 dpi)");
  });

  await section("labels : LabelHtml — 🚨 T11 : le drapeau MARQUE son extrémité (`localEnd`)", async () => {
    /* Avant T11 les deux drapeaux d'une paire étaient RIGOUREUSEMENT identiques : rien ne disait
       au poseur lequel allait à quelle extrémité, et la bascule A / B / A+B n'aurait eu qu'une
       valeur utile. Le marquage est un GLYPHE et une classe — aucune cote ne bouge. */
    const s = cableSubject();
    const sp = spec({ size: "cable", qr: 18 });
    const flagA = LabelHtml.label(s, sp, { ends: true, checked: {}, localEnd: "A" }, "<svg></svg>");
    const flagB = LabelHtml.label(s, sp, { ends: true, checked: {}, localEnd: "B" }, "<svg></svg>");
    ck(flagA.includes("▶ A") && !flagA.includes("▶ B"), "drapeau du bout A : sa lettre est pointée, l'autre non");
    ck(flagB.includes("▶ B") && !flagB.includes("▶ A"), "drapeau du bout B : l'inverse");
    ck(flagA !== flagB, "🚨 les deux drapeaux d'une paire ne sont PLUS identiques (c'était le défaut)");
    ck(flagA.includes('class="l-loc local"'), "la ligne du bout local porte sa classe (mise en gras par le CSS)");
    ck(LabelHtml.CSS.includes(".l-loc.local"), "…et le CSS partagé aperçu ⇄ imprimé la connaît");
    ck(!/color\s*:/.test(/\.l-loc\.local\{[^}]*\}/.exec(LabelHtml.CSS)[0]), "🚨 aucune couleur : l'imprimé est noir sur blanc, le repère doit survivre au noir et blanc");

    // 🚨 AUCUNE COTE NE BOUGE : le marquage n'ajoute pas de ligne, il en décore une.
    const plain = LabelHtml.label(s, sp, { ends: true, checked: {} }, "<svg></svg>");
    const dims = (html) => /style="width:([\d.]+)mm;height:([\d.]+)mm"/.exec(html);
    ck.eq(dims(flagA)[0], dims(plain)[0], "cotes du drapeau marqué = celles du drapeau nu (golden de géométrie préservé)");
    ck.eq((flagA.match(/class="l-loc/g) || []).length, (plain.match(/class="l-loc/g) || []).length, "même NOMBRE de lignes d'extrémité");
    ck.eq(plain.includes("▶"), false, "sans `localEnd` : rendu STRICTEMENT identique à celui d'avant T11 (aucun glyphe)");

    // La limite ASSUMÉE : sans les lignes A/B, il n'y a pas de lettre à pointer.
    const noEnds = LabelHtml.label(s, sp, { ends: false, checked: {}, localEnd: "A" }, "<svg></svg>");
    ck(!noEnds.includes("▶"), "« Extrémités A / B » décoché : plus de lettre, donc plus de repère (limite documentée)");

    // Le MANCHON « repère complet » porte aussi les extrémités : il se marque de la même façon.
    const sleeveA = LabelHtml.label(s, spec({ size: "cable", content: "strip", dia: 6, len: 25 }), { ends: true, checked: {}, localEnd: "A" }, "");
    ck(sleeveA.includes("▶ A"), "manchon repère complet : même marquage (un manchon habille UN bout, lui aussi)");
  });

  await section("labels : LabelExportPlan — 🚨 Q11.13 : nommage et pixels de l'export en images", async () => {
    /* Le nommage n'est pas cosmétique : un dossier de 150 fichiers se trie « 1, 10, 100, 11… »
       dans tous les explorateurs, et l'ordre de la planche EST l'ordre de pose. */
    ck.eq(LabelExportPlan.fileName("srv-01", 0, 1), "srv-01-1.png", "une seule étiquette : pas de rembourrage inutile");
    ck.eq(LabelExportPlan.fileName("planche", 0, 150), "planche-001.png", "🚨 150 étiquettes : numéro cadré sur 3 chiffres (l'ordre de pose survit au tri du dossier)");
    ck.eq(LabelExportPlan.fileName("planche", 149, 150), "planche-150.png", "…jusqu'à la dernière");
    ck.eq(LabelExportPlan.fileName("planche", 9, 150), "planche-010.png", "…et le 10ᵉ se range bien avant le 100ᵉ");
    ck.eq(LabelExportPlan.sheetFileName("baie-b12", 0, 3), "baie-b12-planche-1.png", "planche entière : nommage distinct (on ne confond pas une feuille et une étiquette)");
    ck.eq(LabelExportPlan.zipName("baie-b12"), "baie-b12-etiquettes.zip", "archive : un seul téléchargement pour N images");

    // MILLIMÈTRES → PIXELS : le pont est le dpi, la même valeur qui quantifie la cote du QR.
    ck.eq(LabelExportPlan.pixels(50, 300), 591, "50 mm à 300 dpi → 591 px");
    ck.eq(LabelExportPlan.pixels(30, 300), 354, "30 mm à 300 dpi → 354 px");
    ck.eq(LabelExportPlan.pixels(50, 203), 400, "…la même étiquette à 203 dpi → 400 px");
    ck.eq(LabelExportPlan.pixels(0, 300), 1, "cote nulle → 1 px (une image de 0 px n'est pas une image)");
    ck.eq(LabelExportPlan.pixels(50, 0), 1, "dpi nul → idem (fonction totale)");

    /* 🚨 LA SECONDE CONVERSION, ET POURQUOI ELLE N'EST PAS UN DOUBLON. L'étiquette est du HTML en
       MILLIMÈTRES ; dans un `<foreignObject>`, un `mm` vaut 96/25,4 unités SVG — pas `dpi`/25,4.
       Dimensionner le viewBox en pixels de SORTIE ferait tenir l'étiquette dans un tiers de
       l'image, cadrée en haut à gauche. Le viewBox se pose donc en pixels CSS, les attributs
       `width`/`height` du SVG portant la cote de sortie. */
    ck.eq(LabelExportPlan.CSS_DPI, 96, "1 pouce = 96 pixels CSS (constante de la spec, pas un réglage)");
    ck(near(LabelExportPlan.cssPixels(50), 188.976, 0.01), "50 mm = 188,98 pixels CSS…");
    ck(near(LabelExportPlan.cssPixels(50), LabelExportPlan.pixels(50, 96), 0.5), "…soit exactement ce que `pixels()` rendrait à 96 dpi");
    ck(LabelExportPlan.pixels(50, 300) > LabelExportPlan.cssPixels(50), "🚨 les deux ne parlent PAS du même pixel : à 300 dpi le rapport est le sur-échantillonnage voulu");
    ck(near(LabelExportPlan.pixels(50, 300) / LabelExportPlan.cssPixels(50), 300 / 96, 0.01), "…et il vaut précisément dpi/96");
    ck.eq(LabelExportPlan.cssPixels(0), 1, "cote nulle → 1 (fonction totale)");

    // 🚨 LE QR : k pixels ENTIERS par module, la MÊME quantification qu'à l'impression.
    const plan = LabelExportPlan.qrPixels(41, 300, 20);
    ck.eq(plan.pxPerModule, 5, "41 modules, 300 dpi, 20 mm : 5 px par module");
    ck.eq(plan.px, 41 * 5, "…soit une image de 205 px de côté, EXACTEMENT (aucune interpolation possible)");
    ck(near(plan.mm, LabelLayout.quantizeQrMm(41, 300, 20).mm), "🚨 la cote en mm est celle de l'impression : l'image et le papier montrent le MÊME code");
    ck(LabelExportPlan.qrPixels(41, 203, 2).pxPerModule >= 1, "cote minuscule : au moins 1 px par module (jamais une image vide)");

    // Le côté TOTAL d'une matrice servie — quiet zone comprise (elle se dessine avec le reste).
    ck.eq(LabelExportPlan.totalModulesOf({ size: 33, margin: 4, rows: [] }), 41, "33 modules + 2 × 4 de quiet zone = 41");
    ck.eq(LabelExportPlan.totalModulesOf(null), 0, "matrice absente → 0 (l'appelant saute la quantification)");
    ck.eq(LabelExportPlan.totalModulesOf({ size: 0, margin: 4, rows: [] }), 0, "matrice vide → 0");
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

  await section("labels : T11 — VERROUS SUR LES SOURCES (le panneau consomme la règle, il ne l'écrit pas)", async () => {
    /* Patron du verrou T2-B1 : on relit les SOURCES. Le panneau n'est pas testable headless, mais
       ce qui a fait DÉRIVER la modale l'est — des règles écrites dans le rendu DOM, invérifiables
       parce qu'elles n'avaient de nom nulle part. Ces verrous disent que la refonte ne peut pas
       rejouer ce défaut sans se faire remarquer. */
    const fs = require("fs");
    const src = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", "src-client", ...p), "utf8");
    const dialog = src("ui", "LabelPrintDialog.ts");

    // -- 1. LE VERDICT VIENT DE LA POLITIQUE, ET DE NULLE PART AILLEURS --
    ck(/LabelPrintPolicy\.availability\(/.test(dialog), "la modale demande son verdict à `availability`");
    ck(!/LabelPrintPolicy\.visibility\(/.test(dialog), "…et n'appelle plus l'ancienne matrice de visibilité");
    ck(/LabelPrintPolicy\.supportOf\(/.test(dialog) && /LabelPrintPolicy\.applySupport\(/.test(dialog), "le support est LU et ÉCRIT par la projection pure (jamais dérivé sur place)");
    ck(/LabelPrintPolicy\.cotesFor\(/.test(dialog), "les cotes offertes descendent de la politique");
    ck(/LabelPrintPolicy\.expand\(/.test(dialog) && /LabelPrintPolicy\.paperOf\(/.test(dialog), "le tirage (bouts × occurrences) et le papier viennent de la politique");
    ck(/LabelPrintPolicy\.warningRegister\(/.test(dialog), "le classement des avertissements en DEUX registres vient de la politique");
    /* 🚨 AUCUNE RÈGLE DE DISPONIBILITÉ RÉÉCRITE : la modale ne doit jamais décider elle-même
       qu'un contrôle est refusé « parce que c'est un câble » ou « parce que c'est une baie ».
       On cherche les tests d'anatomie qui n'ont rien à faire dans un rendu DOM. */
    ck(!/kind === "cable"|kind === "bundle"|kind === "rack"|ctx\.kind === "/.test(dialog), "🚨 la modale ne teste JAMAIS le sujet pour décider d'une disponibilité (elle consomme des CODES)");
    ck(!/isFlagKind|isSpareLike/.test(dialog), "…ni les prédicats de famille : ils vivent dans la politique, qui les a déjà appliqués");

    // -- 2. `hidden` NE SERT PLUS À CACHER UN VERDICT --
    const hiddenLines = dialog.split(/\r?\n/).filter((l) => /\.hidden\s*=/.test(l));
    ck(hiddenLines.length > 0, "des masquages STRUCTURELS subsistent (une question sans objet dans ce contexte)");
    ck(hiddenLines.every((l) => !/av\.supports|av\.contents|av\.sizes|av\.fields/.test(l)),
      "🚨 aucun `hidden` posé depuis un verdict de disponibilité : une option refusée est GRISÉE avec sa raison, jamais escamotée");
    ck(/\.disabled = /.test(dialog) && /\.title = /.test(dialog), "…c'est `disabled` + `title` qui portent le refus, et donc sa raison");
    ck(/reasonText\(/.test(dialog), "toute raison passe par la traduction d'un CODE (aucune phrase en dur dans la modale)");

    // -- 3. UNE SEULE ENTRÉE DRAPEAU PAR FICHE (fusion 11 → 9) --
    const forms = src("views", "forms", "DetailForms.ts");
    ck.eq((forms.match(/labels\.entry\.flag/g) || []).length, 2, "🚨 UN seul geste « Étiqueter… » par fiche à drapeau (câble et faisceau) — les deux entrées ont fusionné");
    ck(!/labels\.entry\.cableOne|labels\.entry\.cableBoth/.test(forms), "…les libellés « Un drapeau » / « les 2 extrémités » ont disparu des sources");
    ck(!/subjects: \[subject\(\), subject\(\)\]/.test(forms), "🚨 plus aucun sujet POUSSÉ EN DOUBLE : c'est la bascule de la modale qui décide du nombre");
    ck((forms.match(/defaultEndsMode: "ab"/g) || []).length === 2, "…et le défaut A+B (le geste principal d'avant) est passé en argument");

    // -- 4. LE PANIER NE DUPLIQUE PLUS LES SUJETS --
    const main = src("app", "main.ts");
    ck(!/labelsPerItem/.test(main), "🚨 `labelsPerItem` a disparu de main.ts : le panier ne duplique plus les sujets");
    ck(/subjects\.push\(build\(record\)\)/.test(main), "…il pousse UN sujet par élément du panier");
    ck(/plan\.defaultEndsMode/.test(main), "…et transmet le défaut de bascule de la famille");
    ck(!/subjects: \[subject\(\), subject\(\)\]/.test(main), "les actions de LIGNE (câble, faisceau) ne dupliquent plus non plus");
    ck(/fetchQrMatrix:/.test(main), "l'hôte injecte la récupération de MATRICE (export en images, Q11.13)");

    // -- 5. i18n : tout CODE de refus a sa phrase, dans LES DEUX langues --
    const reasons = ["flag-only", "rack-only", "needs-sleeve", "needs-not-sleeve", "not-flag", "no-text", "cols-capped", "roll-no-cuts"];
    for (const locale of ["fr", "en"]) {
      const cat = src("i18n", "locales", locale, "labels.ts");
      for (const code of reasons) ck(cat.includes('"' + code + '"'), `i18n ${locale} : le code de refus « ${code} » a sa phrase`);
      ck(/moduleTooSmall:/.test(cat), `i18n ${locale} : le nouvel avertissement « module trop petit » a sa phrase`);
      ck(/exportImages:/.test(cat) && /unsupported:/.test(cat), `i18n ${locale} : l'export en images et son refus Safari sont dits`);
      ck(!/cableOne:|cableBoth:|cableBothSource:/.test(cat), `i18n ${locale} : les clés des deux gestes fusionnés sont supprimées (pas de clé morte)`);
    }

    // -- 6. CSS : thématisée, sans couleur en dur (le thème clair suit de lui-même) --
    const css = fs.readFileSync(path.join(__dirname, "..", "..", "src-client", "styles", "dc-manager.css"), "utf8");
    const block = /\.label-print \{[\s\S]*?\.lp-sheetnote[^\n]*\n/.exec(css);
    ck(!!block, "la CSS porte le bloc de la modale d'impression");
    ck(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|oklch\(/.test(block[0].replace(/#fff\b/g, "")), "🚨 aucune couleur en dur : tokens seulement (le `#fff` du papier d'aperçu excepté — c'est du PAPIER, pas du thème)");
    ck(/min-height: 44px/.test(block[0]), "les boutons-cartes tiennent la cible tactile de 44 px");
    ck(/\.lp-opt\[disabled\] \.lp-opt-hint/.test(block[0]), "🚨 la RAISON d'une option refusée a sa propre règle : elle reste lisible quand le titre s'estompe");
    ck(!/\.label-print-/.test(css), "l'ancienne famille `.label-print-*` a entièrement cédé la place à `.lp-*`");
    ck(/\.label-print \[hidden\] \{ display: none !important; \}/.test(css), "…et le `[hidden]` de la modale reste (les masquages structurels en dépendent)");
  });

  await section("labels : T11 — VERROUS SUR LE RASTER (SVG-image en XML strict, bug terrain « SVG illisible »)", async () => {
    /* 🚨 PIÈGE N°6 DE L'IMPRESSION. « Exporter en images » chargeait le HTML de l'étiquette dans un
       `<foreignObject>` par CONCATÉNATION de chaînes ; or un SVG chargé comme IMAGE est parsé en XML
       STRICT, et le HTML n'est pas du XHTML (`<img>` non fermé, entités, `<`/`&` dans le `<style>`),
       d'où le rejet du document et le toast « SVG illisible ». Le correctif SÉRIALISE l'enveloppe par
       `XMLSerializer`. Le panneau n'est pas testable headless (DOM), mais ce qui a fait dériver
       l'export l'est : la SOURCE de `LabelImageExport` et la partie PURE de l'enveloppe. */
    const fs = require("fs");
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "src-client", "ui", "LabelImageExport.ts"), "utf8");

    // -- 1. LA SOURCE PORTE LA CEINTURE ET LA SÉRIALISATION --
    const imgLine = src.split(/\r?\n/).find((l) => /return `<img /.test(l));
    ck(!!imgLine && /\/>`;?\s*$/.test(imgLine.trim()), "🚨 `qrImageTag` émet un `<img … />` AUTO-FERMÉ (illisible en XML sinon)");
    const raster = /private static rasterize\([\s\S]*?\n  \}/.exec(src);
    ck(!!raster, "on retrouve le corps de `rasterize`");
    ck(/XMLSerializer/.test(raster[0]), "🚨 `rasterize` SÉRIALISE l'enveloppe (XMLSerializer), il ne concatène plus une `<div>` brute");
    ck(/insertAdjacentHTML/.test(raster[0]) && /createElement/.test(raster[0]), "…l'enveloppe est CONSTRUITE dans le DOM avant d'être sérialisée");
    ck(/LabelExportPlan\.wrapForRaster\(/.test(raster[0]), "…et le cadrage SVG passe par la méthode PURE `wrapForRaster` (vérifiable ici)");

    // -- 2. `wrapForRaster` : PURE, bien équilibrée, cotes préservées --
    const svg = LabelExportPlan.wrapForRaster('<div xmlns="http://www.w3.org/1999/xhtml" class="label-render">X</div>', 188.976, 94.488, 591, 295);
    ck(svg.indexOf("<foreignObject") < svg.indexOf('class="label-render"'), "🚨 `<foreignObject` PRÉCÈDE le contenu XHTML injecté");
    ck(svg.includes('viewBox="0 0 188.976 94.488"'), "le viewBox porte les cotes en pixels CSS transmises");
    ck(svg.includes('width="591"') && svg.includes('height="295"'), "…et width/height portent la cote de SORTIE en pixels");
    ck(svg.includes('xmlns="http://www.w3.org/2000/svg"'), "la racine SVG porte son namespace");
    // Mini-vérificateur d'équilibre (pas un parseur XML) : chaque conteneur ouvert est refermé une fois.
    const balanced = (s, tag) => (s.match(new RegExp("<" + tag + "\\b", "g")) || []).length === (s.match(new RegExp("</" + tag + ">", "g")) || []).length;
    ck(balanced(svg, "svg") && balanced(svg, "foreignObject"), "🚨 balises `svg` et `foreignObject` équilibrées (ouvertes = fermées)");
    ck(svg.endsWith("</foreignObject></svg>"), "…et l'enveloppe se referme dans le bon ordre");
    // Les cotes sont arrondies à 3 décimales (pas de flottant à rallonge dans le viewBox).
    const long = LabelExportPlan.wrapForRaster("<div/>", 1 / 3, 2 / 3, 10, 20);
    ck(long.includes("viewBox=\"0 0 0.333 0.667\""), "les cotes du viewBox sont arrondies à 3 décimales");
  });
};
