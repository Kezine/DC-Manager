/* Tests modules — VALIDATION des paramètres de rendu d'une étiquette QR (src-server/QrCodeParams).
   Logique PURE extraite de la route `GET …/qr/:collection/:id` (api.ts) — le format d'URL encodé, lui,
   est éprouvé dans test-entity-link.js, et la garde de la route par le verrou d'exhaustivité de
   test-access.js. Ici : les deux politiques VOULUES — format en liste blanche fermée (inconnu → 400),
   taille BORNÉE (hors bornes → ramenée, non entier → 400). Harnais et assertions : harness.js. */
"use strict";
const { ck, section, SERVER } = require("./harness.js");

module.exports = async () => {
  const { QrCodeParams } = SERVER("QrCodeParams.js");

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
};
