/* Tests modules — DEEP-LINK D'ENTITÉ partagé (src-shared/EntityLink) : le format d'URL
   qu'encode une étiquette QR (chantier 2026-08-18) et que lit le client (boot, greffon de
   scan). Vérités verrouillées ici : forme canonique du fragment, round-trip build → parse,
   lecture AGNOSTIQUE DE L'HÔTE (invariant de survie au déménagement d'URL), liste blanche
   des collections, refus STRICT de tout ce qui n'est pas un lien canonique.
   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, SHARED } = require("./harness.js");

module.exports = async () => {
  const { EntityLink } = SHARED("src-shared/EntityLink.js");
  const { Schema } = SHARED("src-shared/Schema.js");

  await section("shared : EntityLink — forme canonique + round-trip build → parse", async () => {
    const target = { docId: "d-infra", collection: "equipments", id: "eq-42" };
    ck.eq(EntityLink.fragment(target), "doc/d-infra/fiche/equipments/eq-42", "fragment canonique doc/<docId>/fiche/<collection>/<id>");
    const url = EntityLink.build("https://dcm.example.org/app/dc-manager.html", target);
    ck.eq(url, "https://dcm.example.org/app/dc-manager.html#doc/d-infra/fiche/equipments/eq-42", "build = base + # + fragment");
    ck.eq(JSON.stringify(EntityLink.parse(url)), JSON.stringify(target), "round-trip : parse(build(x)) === x");

    // Segments à caractères réservés : l'encodage segment par segment fait survivre le round-trip.
    const rough = { docId: "doc 1/α", collection: "spares", id: "id#7/année" };
    ck.eq(JSON.stringify(EntityLink.parse(EntityLink.build("http://h/p", rough))), JSON.stringify(rough),
      "round-trip avec espace, /, # et accents dans docId et id (encodeURIComponent segmentaire)");

    // Base avec fragment résiduel : REMPLACÉ, jamais concaténé (base collée depuis la barre d'adresse).
    ck.eq(EntityLink.build("https://h/app#equipements", target), "https://h/app#doc/d-infra/fiche/equipments/eq-42",
      "un #… résiduel de la base est retiré avant pose du fragment");
    ck.eq(EntityLink.build("  https://h/app  ", target), "https://h/app#doc/d-infra/fiche/equipments/eq-42", "base trimée");
  });

  await section("shared : EntityLink.parse — agnostique de l'hôte, formes d'entrée, refus stricts", async () => {
    const target = { docId: "d1", collection: "racks", id: "r9" };
    const fragment = EntityLink.fragment(target);

    // INVARIANT DE SURVIE : l'hôte imprimé n'entre pas dans la décision — une étiquette de
    // l'ancienne instance reste résoluble dans la nouvelle.
    ck.eq(JSON.stringify(EntityLink.parse("https://ancienne-instance.local:8443/vieux/chemin#" + fragment)),
      JSON.stringify(target), "parse accepte un lien d'un AUTRE hôte/chemin (agnostique de l'hôte)");
    // Formes d'entrée équivalentes : location.hash (#…) et fragment nu.
    ck.eq(JSON.stringify(EntityLink.parse("#" + fragment)), JSON.stringify(target), "forme location.hash (#doc/…)");
    ck.eq(JSON.stringify(EntityLink.parse(fragment)), JSON.stringify(target), "forme fragment nu (doc/…)");

    // Refus stricts — tout ce qui n'est pas la forme canonique rend null, sans lancer.
    ck.eq(EntityLink.parse("#equipements"), null, "hash de VUE historique → null (cohabitation ShellNav)");
    ck.eq(EntityLink.parse("https://h/p"), null, "URL sans fragment → null");
    ck.eq(EntityLink.parse("doc/d1/fiche/racks"), null, "segment manquant → null");
    ck.eq(EntityLink.parse("doc/d1/fiche/racks/r9/extra"), null, "segment en trop → null");
    ck.eq(EntityLink.parse("doc/d1/autre/racks/r9"), null, "mot-clé « fiche » absent → null");
    ck.eq(EntityLink.parse("dossier/d1/fiche/racks/r9"), null, "préfixe « doc » absent → null");
    ck.eq(EntityLink.parse("doc/d1/fiche/inconnue/r9"), null, "collection HORS liste blanche du schéma → null");
    ck.eq(EntityLink.parse("doc/d1/fiche/racks/"), null, "id vide → null");
    ck.eq(EntityLink.parse("doc//fiche/racks/r9"), null, "docId vide → null");
    ck.eq(EntityLink.parse("doc/d1/fiche/racks/%E0%A4%A"), null, "%-encodage invalide → null (URIError avalée)");
    ck.eq(EntityLink.parse(""), null, "chaîne vide → null");
    ck.eq(EntityLink.parse(null), null, "null → null (entrée non sûre tolérée)");
    ck.eq(EntityLink.parse(undefined), null, "undefined → null");
    ck.eq(EntityLink.parse("SN-12345-DELL"), null, "texte de QR ÉTRANGER (service tag) → null — le greffon saura le traiter en valeur brute");

    // La liste blanche est bien la liste CANONIQUE partagée : toute collection du schéma passe.
    for (const collection of Schema.COLLECTIONS) {
      const t = { docId: "d", collection, id: "x" };
      ck.eq(JSON.stringify(EntityLink.parse(EntityLink.fragment(t))), JSON.stringify(t), "collection du schéma acceptée : " + collection);
    }
  });
};
