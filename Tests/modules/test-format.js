/* Tests modules — FORMATAGE d'affichage (core/Format). Ici : `bytes()`, le formateur
   de TAILLE de fichier introduit pour les pièces jointes (lot B) — unités francophones
   (o/Ko/Mo/Go/To), base binaire 1024, une décimale au-delà du kilo, garde-fous sur les
   entrées non finies. Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D } = require("./harness.js");

module.exports = async () => {
  const { Format } = D("core/Format.js");

  await section("Format.bytes — taille de fichier lisible (o/Ko/Mo/Go), base 1024", async () => {
    ck.eq(Format.bytes(0), "0 o", "0 octet → « 0 o »");
    ck.eq(Format.bytes(1), "1 o", "1 octet (singulier accepté — libellé neutre « o »)");
    ck.eq(Format.bytes(512), "512 o", "sous le kilo : octets bruts, aucune décimale");
    ck.eq(Format.bytes(1023), "1023 o", "juste sous 1 Ko : reste en octets");
    ck.eq(Format.bytes(1024), "1 Ko", "1024 o → « 1 Ko » (bascule binaire)");
    ck.eq(Format.bytes(1536), "1.5 Ko", "1.5 Ko : une décimale");
    ck.eq(Format.bytes(1024 * 1024), "1 Mo", "1 Mo pile");
    ck.eq(Format.bytes(2.4 * 1024 * 1024), "2.4 Mo", "2.4 Mo : une décimale");
    ck.eq(Format.bytes(512 * 1024 * 1024), "512 Mo", "≥ 100 dans l'unité : pas de décimale (« 512 Mo »)");
    ck.eq(Format.bytes(50 * 1024 * 1024), "50 Mo", "plafond des pièces jointes (50 Mo)");
    ck.eq(Format.bytes(1024 * 1024 * 1024), "1 Go", "1 Go pile");
    ck.eq(Format.bytes(1024 * 1024 * 1024 * 1024), "1 To", "1 To pile (plus grande unité listée)");
    // Défensif : le serveur pose `size`, mais un enregistrement legacy/incomplet ne doit pas casser l'UI.
    ck.eq(Format.bytes(-5), "0 o", "négatif → « 0 o » (jamais de taille négative affichée)");
    ck.eq(Format.bytes(NaN), "0 o", "NaN → « 0 o »");
    ck.eq(Format.bytes(undefined), "0 o", "undefined → « 0 o »");
    ck.eq(Format.bytes(1234.9), "1.2 Ko", "valeur fractionnaire d'octets arrondie avant conversion");
  });
};
