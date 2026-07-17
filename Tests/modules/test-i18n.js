/* Tests modules — LOCALISATION (i18n) : complétude des catalogues fr ⇄ en.
   Garde-fou : empêche une traduction de « pourrir en silence » (clé oubliée d'un
   côté, valeur vidée, feuille devenue non-chaîne). Le FRANÇAIS est la référence ;
   l'anglais doit en être le calque EXACT. Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D } = require("./harness.js");

/** Aplati récursivement un catalogue en map { "a.b.c": valeurFeuille } (les objets sont descendus, pas les valeurs). */
function flatten(obj, prefix, out) {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const path = prefix ? prefix + "." + key : key;
    if (value && typeof value === "object" && !Array.isArray(value)) flatten(value, path, out);
    else out[path] = value;
  }
  return out;
}

module.exports = async () => {
  const { fr } = D("i18n/locales/fr.js");
  const { en } = D("i18n/locales/en.js");

  await section("i18n : complétude des catalogues (fr ⇄ en)", async () => {
    const frLeaves = flatten(fr, "", {});
    const enLeaves = flatten(en, "", {});

    // (1) MÊMES ensembles de clés dans les deux sens — on liste les écarts dans le message d'échec.
    const missingInEn = Object.keys(frLeaves).filter((k) => !(k in enLeaves)).sort();
    const missingInFr = Object.keys(enLeaves).filter((k) => !(k in frLeaves)).sort();
    ck(missingInEn.length === 0, "i18n : aucune clé FR absente de EN" + (missingInEn.length ? " — manquantes en EN : " + missingInEn.join(", ") : ""));
    ck(missingInFr.length === 0, "i18n : aucune clé EN absente de FR" + (missingInFr.length ? " — manquantes en FR : " + missingInFr.join(", ") : ""));

    // (2) feuilles = CHAÎNES et (3) aucune valeur VIDE — vérifié des deux côtés.
    const nonString = [];
    const emptyValue = [];
    for (const [name, leaves] of [["fr", frLeaves], ["en", enLeaves]]) {
      for (const key of Object.keys(leaves)) {
        const value = leaves[key];
        if (typeof value !== "string") nonString.push(name + ":" + key);
        else if (value.trim() === "") emptyValue.push(name + ":" + key);
      }
    }
    ck(nonString.length === 0, "i18n : toutes les feuilles sont des chaînes" + (nonString.length ? " — non-chaînes : " + nonString.join(", ") : ""));
    ck(emptyValue.length === 0, "i18n : aucune valeur vide" + (emptyValue.length ? " — vides : " + emptyValue.join(", ") : ""));

    // Sanity : le catalogue n'est pas vide (une régression de build qui exporterait {} passerait sinon inaperçue).
    ck(Object.keys(frLeaves).length > 0, "i18n : le catalogue FR contient des clés (" + Object.keys(frLeaves).length + ")");
  });
};
