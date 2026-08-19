/* Tests modules — UI DU SCAN caméra (lot D étiquettes QR) : les DÉCISIONS PURES extraites
   du greffon (ui/ScanControl) et du viseur (ui/ScanViewfinder), cf. docs/qr-scan.md § UI :
     - core/ScanParsing    : parseurs NOMMÉS de la valeur décodée (« le scan est une source
                             de saisie, jamais une saisie parallèle ») — codes, jamais de
                             chaîne traduite ;
     - core/ScanAffordance : visibilité du greffon / de l'entrée globale (prédicats bruts
                             INJECTÉS — matchMedia, sonde caméra… résolus par l'appelant) ;
     - core/ScanRoiMemory  : zone de décodage (ROI) mémorisée PAR CHAMP — géométrie de
                             drag/resize (bornes, tailles mini) + persistance (lecture/écriture
                             injectées, aucune référence à localStorage ici).
   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D } = require("./harness.js");

module.exports = async () => {
  const { ScanParsing } = D("core/ScanParsing.js");
  const { ScanAffordance } = D("core/ScanAffordance.js");
  const { ScanRoiMemory } = D("core/ScanRoiMemory.js");

  await section("scan-ui : ScanParsing.raw — trim, non vide, mono-ligne", async () => {
    ck.eq(JSON.stringify(ScanParsing.raw("  ABC-123  ")), JSON.stringify({ ok: true, value: "ABC-123" }), "valeur simple trimée → ok");
    ck.eq(JSON.stringify(ScanParsing.raw("")), JSON.stringify({ ok: false, value: "", warning: "empty" }), "vide → refus « empty »");
    ck.eq(JSON.stringify(ScanParsing.raw("   ")), JSON.stringify({ ok: false, value: "", warning: "empty" }), "blancs seuls → refus « empty »");
    ck.eq(JSON.stringify(ScanParsing.raw(null)), JSON.stringify({ ok: false, value: "", warning: "empty" }), "null toléré (entrée non sûre) → refus « empty »");
    // Multi-ligne (vCard, wifi QR…) : REFUSÉ pour un champ simple, mais la valeur est CONSERVÉE
    // pour l'affichage (doctrine maquette : « affichée quand même, avec avertissement, Valider désactivé »).
    const multi = ScanParsing.raw("ligne1\nligne2");
    ck.eq(multi.ok, false, "multi-ligne → refus");
    ck.eq(multi.warning, "multiline", "multi-ligne → code « multiline »");
    ck.eq(multi.value, "ligne1\nligne2", "multi-ligne : la valeur reste affichable telle quelle");
    ck.eq(ScanParsing.raw("a\r\nb").warning, "multiline", "CRLF détecté aussi (\\r)");
    // Une URL est une valeur BRUTE légitime pour le parseur raw (aucune règle métier ici).
    ck.eq(ScanParsing.raw("https://exemple.org/x").ok, true, "raw : une URL passe (aucune règle métier)");
    // Dispatch par nom : parse(id, …) route vers le parseur nommé.
    ck.eq(ScanParsing.parse("raw", " x ").value, "x", "parse(\"raw\", …) délègue à raw()");
  });

  await section("scan-ui : ScanParsing.serial — préfixes constructeur nettoyés, garde anti-lien", async () => {
    // Préfixes « SN: », « S/N: », « SER »… : insensibles à la casse, séparateur : = # ou espace.
    ck.eq(ScanParsing.serial("SN: CZJ2470X9K").value, "CZJ2470X9K", "« SN: » nettoyé");
    ck.eq(ScanParsing.serial("sn:CZJ2470X9K").value, "CZJ2470X9K", "« sn: » minuscule, sans espace");
    ck.eq(ScanParsing.serial("S/N: ABC123").value, "ABC123", "« S/N: » nettoyé");
    ck.eq(ScanParsing.serial("S/N ABC123").value, "ABC123", "« S/N » + espace (sans deux-points)");
    ck.eq(ScanParsing.serial("SN ABC123").value, "ABC123", "« SN » + espace");
    ck.eq(ScanParsing.serial("SER 771-X").value, "771-X", "« SER » + espace");
    ck.eq(ScanParsing.serial("Serial: 771-X").value, "771-X", "« Serial: »");
    ck.eq(ScanParsing.serial("SERIAL NUMBER: 771-X").value, "771-X", "« SERIAL NUMBER: »");
    ck.eq(ScanParsing.serial("Serial No. 771-X").value, "771-X", "« Serial No. » + espace");
    ck.eq(ScanParsing.serial("SN#771X").value, "771X", "séparateur « # »");
    ck.eq(ScanParsing.serial("SN=771X").value, "771X", "séparateur « = »");
    ck.eq(ScanParsing.serial("SN: 771X").ok, true, "préfixe nettoyé → ok");
    // ⚠ SANS séparateur, « SN » fait partie de la valeur : un service tag « SN123 » ou un nom
    // « Server-01 » ne doivent JAMAIS être amputés (le nettoyage exige un séparateur explicite).
    ck.eq(ScanParsing.serial("SN123456").value, "SN123456", "« SN123456 » sans séparateur : valeur intacte");
    ck.eq(ScanParsing.serial("Server-01").value, "Server-01", "« Server-01 » : « ser » suivi de lettres n'est pas un préfixe");
    ck.eq(ScanParsing.serial("Snake-7").value, "Snake-7", "« Snake-7 » : « sn » suivi de lettres n'est pas un préfixe");
    ck.eq(ScanParsing.serial("CZJ2470X9K").value, "CZJ2470X9K", "service tag nu : inchangé");
    // Vide (après nettoyage compris) et multi-ligne : refus, mêmes codes que raw.
    ck.eq(ScanParsing.serial("SN:").warning, "empty", "préfixe SEUL → refus « empty » (rien à insérer)");
    ck.eq(ScanParsing.serial("a\nb").warning, "multiline", "multi-ligne → refus « multiline »");
    // GARDE ANTI-LIEN : une URL ou un deep-link d'étiquette DCM dans un champ n° de série est
    // très probablement le MAUVAIS code d'une planche dense → refus (Valider désactivé), la
    // valeur reste affichée avec l'avertissement — jamais d'injection silencieuse.
    const url = ScanParsing.serial("https://dc.local/eq/4471");
    ck.eq(url.ok, false, "URL http(s) → refus");
    ck.eq(url.warning, "linklike", "URL → code « linklike »");
    ck.eq(url.value, "https://dc.local/eq/4471", "URL : valeur conservée pour l'affichage");
    const deep = ScanParsing.serial("https://dcm.example.org/app#doc/d1/fiche/equipments/eq-42");
    ck.eq(deep.ok === false && deep.warning === "linklike", true, "deep-link d'étiquette DCM → refus « linklike »");
    ck.eq(ScanParsing.serial("doc/d1/fiche/racks/r9").warning, "linklike", "fragment de deep-link NU (EntityLink.parse non-null) → « linklike »");
    ck.eq(ScanParsing.serial("HTTPS://X.Y/Z").warning, "linklike", "schéma en MAJUSCULES détecté aussi");
    ck.eq(ScanParsing.parse("serial", "SN: 9").value, "9", "parse(\"serial\", …) délègue à serial()");
  });

  await section("scan-ui : ScanAffordance — visibilité du greffon et de l'entrée globale", async () => {
    const base = { coarsePointer: false, narrowScreen: false, forced: false, hasCamera: true, secureContext: true };
    // Bouton PAR CHAMP : pointeur grossier OU écran étroit OU préférence de forçage — ET caméra ET contexte.
    ck.eq(ScanAffordance.fieldButton({ ...base }), false, "desktop large sans forçage → pas d'icône morte (doctrine maquette)");
    ck.eq(ScanAffordance.fieldButton({ ...base, coarsePointer: true }), true, "pointeur grossier (tactile) → visible");
    ck.eq(ScanAffordance.fieldButton({ ...base, narrowScreen: true }), true, "écran étroit (<900px) → visible");
    ck.eq(ScanAffordance.fieldButton({ ...base, forced: true }), true, "préférence de forçage (webcam poste fixe) → visible");
    ck.eq(ScanAffordance.fieldButton({ ...base, coarsePointer: true, hasCamera: false }), false, "aucune caméra → jamais de bouton");
    ck.eq(ScanAffordance.fieldButton({ ...base, forced: true, secureContext: false }), false, "contexte non sécurisé (getUserMedia absent) → jamais de bouton");
    // Entrée GLOBALE (topbar) : PAS conditionnée au tactile — seule l'existence d'une caméra décide.
    ck.eq(ScanAffordance.globalEntry({ ...base }), true, "entrée globale : caméra + contexte suffisent (desktop compris)");
    ck.eq(ScanAffordance.globalEntry({ ...base, hasCamera: false }), false, "entrée globale masquée sans caméra (poste fixe sans webcam)");
    ck.eq(ScanAffordance.globalEntry({ ...base, secureContext: false }), false, "entrée globale masquée hors contexte sécurisé");
    // Les requêtes média sont des CONSTANTES publiées (l'appelant les évalue, le module décide).
    ck.eq(typeof ScanAffordance.COARSE_POINTER_QUERY, "string", "requête pointer:coarse publiée");
    ck(ScanAffordance.NARROW_SCREEN_QUERY.indexOf("900px") >= 0, "seuil d'écran étroit = 900px (spec maquette)");
  });

  await section("scan-ui : ScanRoiMemory — géométrie de la zone de décodage (fractions, bornes)", async () => {
    const D0 = ScanRoiMemory.DEFAULT;
    ck.eq(Math.round((D0.x * 2 + D0.w) * 100), 100, "défaut CENTRÉ horizontalement (2x + w = 1)");
    ck.eq(Math.round((D0.y * 2 + D0.h) * 100), 100, "défaut CENTRÉ verticalement (2y + h = 1)");
    ck.eq(D0.w, 0.62, "défaut ~62% de largeur (maquette)");
    ck.eq(D0.h, 0.46, "défaut ~46% de hauteur (maquette)");
    // move : translation clampée aux bords du cadre.
    const moved = ScanRoiMemory.move({ x: 0.2, y: 0.2, w: 0.5, h: 0.4 }, 0.1, -0.05);
    ck.eq(JSON.stringify(moved), JSON.stringify({ x: 0.3, y: 0.15, w: 0.5, h: 0.4 }), "move : translation simple");
    const clamped = ScanRoiMemory.move({ x: 0.2, y: 0.2, w: 0.5, h: 0.4 }, 9, -9);
    ck.eq(JSON.stringify(clamped), JSON.stringify({ x: 0.5, y: 0, w: 0.5, h: 0.4 }), "move : clamp x ≤ 1-w et y ≥ 0 (jamais hors cadre)");
    // resize par coin : le coin OPPOSÉ reste ANCRÉ (améliore la maquette, qui laissait glisser la boîte).
    const br = ScanRoiMemory.resize({ x: 0.2, y: 0.2, w: 0.5, h: 0.4 }, "br", 0.1, 0.1);
    ck.eq(JSON.stringify(br), JSON.stringify({ x: 0.2, y: 0.2, w: 0.6, h: 0.5 }), "resize br : agrandit w/h, origine fixe");
    const tl = ScanRoiMemory.resize({ x: 0.2, y: 0.2, w: 0.5, h: 0.4 }, "tl", 0.1, 0.1);
    ck.eq(JSON.stringify(tl), JSON.stringify({ x: 0.3, y: 0.3, w: 0.4, h: 0.3 }), "resize tl : origine avance, coin br ancré");
    const tr = ScanRoiMemory.resize({ x: 0.2, y: 0.2, w: 0.5, h: 0.4 }, "tr", 0.1, 0.1);
    ck.eq(JSON.stringify(tr), JSON.stringify({ x: 0.2, y: 0.3, w: 0.6, h: 0.3 }), "resize tr : w suit dx, coin bl ancré");
    const bl = ScanRoiMemory.resize({ x: 0.2, y: 0.2, w: 0.5, h: 0.4 }, "bl", -0.1, 0.1);
    ck.eq(JSON.stringify(bl), JSON.stringify({ x: 0.1, y: 0.2, w: 0.6, h: 0.5 }), "resize bl : x recule, coin tr ancré");
    // Tailles MINI (les poignées de 28px doivent rester saisissables) : le coin opposé ne bouge pas.
    const mini = ScanRoiMemory.resize({ x: 0.2, y: 0.2, w: 0.5, h: 0.4 }, "tl", 9, 9);
    ck.eq(mini.w, ScanRoiMemory.MIN_W, "resize : largeur bornée à MIN_W");
    ck.eq(mini.h, ScanRoiMemory.MIN_H, "resize : hauteur bornée à MIN_H");
    ck.eq(Math.round((mini.x + mini.w) * 100), Math.round(0.7 * 100), "resize sous le mini : le bord droit reste ancré (pas de glissement)");
    // normalize : validation d'une valeur STOCKÉE (localStorage = entrée non sûre).
    ck.eq(ScanRoiMemory.normalize({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }) !== null, true, "normalize : rect valide accepté");
    ck.eq(ScanRoiMemory.normalize(null), null, "normalize : null refusé");
    ck.eq(ScanRoiMemory.normalize({ x: 0.1, y: 0.1, w: 0.5 }), null, "normalize : clé manquante refusée");
    ck.eq(ScanRoiMemory.normalize({ x: "a", y: 0, w: 0.5, h: 0.5 }), null, "normalize : non-nombre refusé");
    ck.eq(ScanRoiMemory.normalize({ x: 0.1, y: 0.1, w: 0, h: 0.5 }), null, "normalize : largeur nulle refusée");
    ck.eq(ScanRoiMemory.normalize({ x: 0.1, y: 0.1, w: NaN, h: 0.5 }), null, "normalize : NaN refusé");
    const over = ScanRoiMemory.normalize({ x: 0.9, y: 0.9, w: 0.62, h: 0.46 });
    ck.eq(over && Math.round((over.x + over.w) * 100) <= 100, true, "normalize : rect hors cadre RAMENÉ dans [0,1]");
  });

  await section("scan-ui : ScanRoiMemory — persistance PAR CHAMP (lecture/écriture injectées)", async () => {
    // Magasin en mémoire : le module ne touche jamais localStorage lui-même (testable ici).
    const bag = {};
    const read = (k) => (k in bag ? bag[k] : null);
    const write = (k, v) => { bag[k] = v; };
    ck.eq(JSON.stringify(ScanRoiMemory.load(read, "equipments.serial")), JSON.stringify(ScanRoiMemory.DEFAULT), "champ jamais vu → ROI par défaut");
    const rect = { x: 0.1, y: 0.2, w: 0.4, h: 0.3 };
    ScanRoiMemory.save(read, write, "equipments.serial", rect);
    ck.eq(JSON.stringify(ScanRoiMemory.load(read, "equipments.serial")), JSON.stringify(rect), "round-trip save → load sur la clé du champ");
    ck.eq(JSON.stringify(ScanRoiMemory.load(read, "spares.serial")), JSON.stringify(ScanRoiMemory.DEFAULT), "UN AUTRE champ garde son défaut (mémoire PAR champ)");
    // Read-modify-write : une 2e clé n'écrase pas la 1re (le magasin est une CARTE champ → rect).
    ScanRoiMemory.save(read, write, "spares.serial", { x: 0.3, y: 0.3, w: 0.3, h: 0.3 });
    ck.eq(JSON.stringify(ScanRoiMemory.load(read, "equipments.serial")), JSON.stringify(rect), "la clé du 1er champ survit à l'écriture du 2e");
    // Contenu stocké CORROMPU : on repart du défaut sans lancer (localStorage = entrée non sûre).
    write(ScanRoiMemory.STORAGE_KEY, "{pas du json");
    ck.eq(JSON.stringify(ScanRoiMemory.load(read, "equipments.serial")), JSON.stringify(ScanRoiMemory.DEFAULT), "JSON corrompu → défaut, sans exception");
    ScanRoiMemory.save(read, write, "x", { x: 0, y: 0, w: 0.5, h: 0.5 });
    ck.eq(JSON.stringify(ScanRoiMemory.load(read, "x")), JSON.stringify({ x: 0, y: 0, w: 0.5, h: 0.5 }), "save sur magasin corrompu → repart d'une carte saine");
    // Une valeur stockée INVALIDE sur la clé (autre session, autre version) retombe sur le défaut.
    write(ScanRoiMemory.STORAGE_KEY, JSON.stringify({ "equipments.serial": { x: 2, y: 0.1 } }));
    ck.eq(JSON.stringify(ScanRoiMemory.load(read, "equipments.serial")), JSON.stringify(ScanRoiMemory.DEFAULT), "rect stocké invalide → défaut");
  });
};
