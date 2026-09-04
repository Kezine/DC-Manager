/* Tests modules — GÉNÉRATION SERVEUR d'une étiquette QR : les deux modules PURS extraits de la route
   `GET …/qr/:collection/:id` (api.ts) — le format d'URL encodé, lui, est éprouvé dans
   test-entity-link.js, et la garde de la route par le verrou d'exhaustivité de test-access.js.
     - src-server/QrCodeParams : les deux politiques VOULUES — format en liste blanche fermée
                          (inconnu → 400), taille BORNÉE (hors bornes → ramenée, non entier → 400) ;
     - src-server/QrSvg       : 🚨 Q11.14 (2026-09-03) — l'émission du SVG à MODULES CARRÉS depuis la
                          matrice, en remplacement du tracé AU TRAIT de la librairie `qrcode` qui
                          rendait les modules inégaux à l'impression. Verrouillé ICI de bout en
                          bout : la sortie doit rester lisible par `core/LabelQrSvg` (détection de
                          quiet zone, mise à l'échelle en mm) — sinon le QR rétrécirait en silence.
   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D, SERVER } = require("./harness.js");

module.exports = async () => {
  const { QrCodeParams } = SERVER("QrCodeParams.js");
  const { QrSvg } = SERVER("QrSvg.js");
  // Le consommateur CLIENT du SVG servi : c'est lui qui prouve que l'émetteur reste compatible.
  const { LabelQrSvg } = D("core/LabelQrSvg.js");

  await section("Serveur : QrCodeParams — format (liste blanche fermée) + défauts", async () => {
    // Défauts quand la query est vide/absente.
    ck.eq(JSON.stringify(QrCodeParams.parse({})), JSON.stringify({ format: "png", size: 256 }), "query vide → défauts png/256");
    ck.eq(JSON.stringify(QrCodeParams.parse(null)), JSON.stringify({ format: "png", size: 256 }), "query null tolérée → défauts");
    ck.eq(JSON.stringify(QrCodeParams.parse(undefined)), JSON.stringify({ format: "png", size: 256 }), "query undefined tolérée → défauts");

    // Formats servis, insensibles à la casse et rognés.
    ck.eq(QrCodeParams.parse({ format: "png" }).format, "png", "format png explicite");
    ck.eq(QrCodeParams.parse({ format: "svg" }).format, "svg", "format svg explicite");
    ck.eq(QrCodeParams.parse({ format: "SVG" }).format, "svg", "format insensible à la casse");
    ck.eq(QrCodeParams.parse({ format: "  png  " }).format, "png", "format rogné");
    ck.eq(QrCodeParams.parse({ format: "" }).format, "png", "format vide → défaut png");

    // Format INCONNU → erreur (400) : énumération fermée, on ne devine pas.
    const bad = QrCodeParams.parse({ format: "jpeg" });
    ck(!!bad.error && bad.format === undefined, "format inconnu (jpeg) → { error } (jamais un format deviné)");
    ck(/png\|svg/.test(bad.error), "format inconnu : le message cite les formats servis");
    ck(!!QrCodeParams.parse({ format: "webp" }).error, "format inconnu (webp) → erreur");
    ck(!!QrCodeParams.parse({ format: "../etc" }).error, "format fantaisiste → erreur");

    // parseFormat en direct : null = inconnu (l'appelant répond 400).
    ck.eq(QrCodeParams.parseFormat("svg"), "svg", "parseFormat : svg");
    ck.eq(QrCodeParams.parseFormat(""), "png", "parseFormat : vide → défaut");
    ck.eq(QrCodeParams.parseFormat("gif"), null, "parseFormat : inconnu → null");
  });

  await section("Serveur : QrCodeParams — taille BORNÉE [64, 1024] (hors bornes ramenée, non entier refusé)", async () => {
    // Valeur nominale, chaîne (query string) comme nombre.
    ck.eq(QrCodeParams.parse({ size: "512" }).size, 512, "size chaîne « 512 » → 512");
    ck.eq(QrCodeParams.parse({ size: 300 }).size, 300, "size nombre 300 → 300");
    ck.eq(QrCodeParams.parse({ size: "" }).size, 256, "size vide → défaut 256");

    // BORNES : hors intervalle → RAMENÉE (jamais une erreur — c'est la politique « borner, pas refuser »).
    ck.eq(QrCodeParams.parse({ size: "10" }).size, 64, "size sous le plancher → ramenée à MIN (64)");
    ck.eq(QrCodeParams.parse({ size: "64" }).size, 64, "size = plancher exact → 64");
    ck.eq(QrCodeParams.parse({ size: "1024" }).size, 1024, "size = plafond exact → 1024");
    ck.eq(QrCodeParams.parse({ size: "5000" }).size, 1024, "size au-dessus du plafond → ramenée à MAX (1024)");
    ck.eq(QrCodeParams.parse({ size: "63" }).size, 64, "size 63 → 64 (borne inclusive)");
    ck.eq(QrCodeParams.parse({ size: "1025" }).size, 1024, "size 1025 → 1024");

    // NON entier → erreur (400) : aucune intention interprétable sans deviner.
    ck(!!QrCodeParams.parse({ size: "abc" }).error, "size non numérique → erreur");
    ck(!!QrCodeParams.parse({ size: "12abc" }).error, "size partiellement numérique → erreur");
    ck(!!QrCodeParams.parse({ size: "3.5" }).error, "size décimale → erreur (que des chiffres)");
    ck(!!QrCodeParams.parse({ size: "-8" }).error, "size négative → erreur");
    const err = QrCodeParams.parse({ size: "xx" });
    ck(err.size === undefined && /64|1024/.test(err.error), "size invalide : le message cite les bornes");

    // clampSize en direct (borne pure).
    ck.eq(QrCodeParams.clampSize(0), 64, "clampSize : 0 → 64");
    ck.eq(QrCodeParams.clampSize(9999), 1024, "clampSize : 9999 → 1024");
    ck.eq(QrCodeParams.clampSize(256), 256, "clampSize : valeur nominale inchangée");

    // Une taille invalide n'est PAS masquée par un format valide (l'erreur remonte).
    ck(!!QrCodeParams.parse({ format: "png", size: "abc" }).error, "format valide + size invalide → erreur (400)");
  });

  await section("Serveur : QrSvg — 🚨 Q11.14 : le SVG à MODULES CARRÉS (et non au trait)", async () => {
    /* LE DIAGNOSTIC : la librairie `qrcode` dessine un TRAIT HORIZONTAL par rangée
       (`M4 4.5h7…`, stroke-width 1), d'où des coordonnées en DEMI-module. Avec `crispEdges`
       — imposé le 2026-08-25 contre l'amincissement — chaque rangée est collée à la grille de
       sortie INDÉPENDAMMENT : à 3,1 px par module les rangées alternent 3 et 4 px et « chaque
       ligne du QR est altérée ». On émet donc NOTRE SVG, un carré unitaire par module sombre. */
    const rows = QrSvg.rows({ size: 3, data: [1, 0, 1, 0, 1, 0, 0, 0, 1] });
    ck.eq(rows.join("|"), "101|010|001", "matrice plate (size × size) → une chaîne de 0/1 par rangée");
    ck.eq(QrSvg.rows({ size: 0, data: [] }).length, 0, "matrice dégénérée → aucune rangée (l'appelant décide, on n'invente pas de modules)");
    ck.eq(QrSvg.rows(null).length, 0, "matrice absente → idem (fonction totale)");
    ck.eq(QrSvg.rows({ size: 3, data: [1, 0, 1] }).length, 0, "données trop courtes pour le côté annoncé → aucune rangée");

    // QUIET ZONE : 4 modules, INCHANGÉE (spec QR, et défaut de la librairie qu'on remplace).
    ck.eq(QrSvg.QUIET_ZONE_MODULES, 4, "quiet zone de 4 modules");
    ck.eq(QrSvg.totalModules(rows), 3 + 8, "côté total = modules + 2 × quiet zone");

    // 🚨 DES CARRÉS, À COORDONNÉES ENTIÈRES — c'est TOUT le correctif.
    const d = QrSvg.darkPath(rows);
    ck.eq(d, "M4 4h1v1h-1zM6 4h1v1h-1zM5 5h1v1h-1zM6 6h1v1h-1z", "un carré unitaire par module sombre, décalé de la quiet zone");
    ck(!/\.\d/.test(d), "🚨 AUCUNE coordonnée fractionnaire (le demi-module de la librairie était la cause du défaut)");
    ck(!/h7|h\d\d/.test(d), "🚨 aucun trait long : plus de segment horizontal par rangée");

    const svg = QrSvg.svg(rows);
    ck(svg.includes('viewBox="0 0 11 11"'), "viewBox en MODULES, quiet zone comprise");
    ck(svg.includes('shape-rendering="crispEdges"'), "🚨 `crispEdges` conservé (piège d'impression n°1 du 2026-08-25)");
    ck(svg.includes('fill="#ffffff"') && svg.includes('M0 0h11v11H0z'), "fond blanc PLEIN CADRE (la quiet zone fait partie du code)");
    ck((svg.match(/<path/g) || []).length === 2, "deux chemins seulement : le fond, et TOUS les modules en un");
    ck(!/stroke=/.test(svg), "aucun `stroke` : on peint des surfaces, on ne trace pas des lignes");
    ck(QrSvg.svg(rows, 256).includes('width="256" height="256"'), "cote px posée quand la route la demande…");
    ck(!/width=/.test(QrSvg.svg(rows)), "…et absente sinon (le chemin d'impression pose des mm)");

    /* 🚨 LE VERROU D'INTÉGRATION : `core/LabelQrSvg.detectMarginModules` lit « le plus petit x
       des commandes M du chemin SOMBRE » et ignore les chemins dont le fill commence par `#f`.
       Si notre émetteur cassait cette lecture, `scaleToMm` croirait la quiet zone insuffisante
       et repeindrait un padding blanc EN PLUS — le QR rétrécirait silencieusement. */
    ck.eq(LabelQrSvg.detectMarginModules(svg), 4, "🚨 la marge se lit toujours à 4 sur NOTRE SVG (fond `#ffffff` ignoré, modules sombres à partir de x = 4)");
    ck.eq(JSON.stringify(LabelQrSvg.parseViewBox(svg)), "[0,0,11,11]", "…et le viewBox se parse (c'est lui qui donne `totalModules` à la quantification)");
    const scaled = LabelQrSvg.scaleToMm(svg, 18);
    ck(scaled.includes('width="18mm"') && scaled.includes('height="18mm"'), "mise à l'échelle en mm : inchangée");
    ck(!scaled.includes('<rect'), "🚨 aucune compensation de quiet zone ajoutée (elle est déjà de 4) — le QR n'est pas rétréci en silence");
    ck.eq((scaled.match(/shape-rendering/g) || []).length, 1, "`crispEdges` posé UNE fois (pas de doublon après réécriture)");

    // La charge du format `matrix` : la MÊME source de vérité que le SVG.
    const payload = QrSvg.matrixPayload(rows);
    ck.eq(payload.size + "/" + payload.margin, "3/4", "charge JSON : côté en modules + quiet zone");
    ck.eq(payload.rows.join("|"), "101|010|001", "…et les rangées SANS la quiet zone (l'export la redessine)");
    ck(payload.rows !== rows, "les rangées sont COPIÉES (la charge servie ne partage pas le tableau interne)");
  });

  await section("Serveur : QrCodeParams — le format `matrix` rejoint la liste blanche (Q11.13)", async () => {
    ck.eq(QrCodeParams.parse({ format: "matrix" }).format, "matrix", "matrix accepté");
    ck.eq(QrCodeParams.FORMATS.join(","), "png,svg,matrix", "liste blanche : les trois formats servis, et eux seuls");
    ck.eq(QrCodeParams.parseFormat("MATRIX"), "matrix", "insensible à la casse, comme les autres");
    ck(/png\|svg\|matrix/.test(QrCodeParams.parse({ format: "jpeg" }).error), "le message d'erreur cite les TROIS formats (il reste actionnable)");
    ck.eq(QrCodeParams.parse({}).format, "png", "le défaut n'a pas bougé : png");
  });
};
