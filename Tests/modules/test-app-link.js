/* Tests modules — ROUTEUR DE FRAGMENTS partagé (`src-shared/AppLink`, chantier « liens directs »
   2026-09-01) : la grammaire UNIQUE des liens directs de l'application.

   Vérités verrouillées ici :
     · 🚨 COMPATIBILITÉ DES ÉTIQUETTES DÉJÀ IMPRIMÉES — un lien sans `?vue=1` rend exactement la
       cible qu'`EntityLink` rendait, `syncView:false` : un QR gravé avant le chantier n'active
       AUCUNE vue, donc rien ne change pour lui. C'est ce qui a fait choisir le paramètre plutôt
       qu'un changement de comportement global (décision A1 du cadrage) ;
     · 🚨 LE PIÈGE DU PARAMÈTRE — `EntityLink.parse` exige EXACTEMENT 5 segments et prend l'id au
       5ᵉ ; un `?vue=1` laissé collé serait AVALÉ DANS L'ID. Le module doit séparer le suffixe
       AVANT de déléguer, et c'est testé sur l'id lui-même, pas seulement sur le drapeau ;
     · le REGISTRE `fromStackKey` — « quelle modale a une adresse ? » : les fiches en ont une, les
       modales sans objet (réglages, panier, viseur, infos utilisateur) n'en ont pas ;
     · `baseOf` retire hash ET query (un lien partagé n'emporte pas un retour d'authentification) ;
     · round-trip `parse(build(x)) ≡ x` pour les quatre formes de la grammaire.
   Le FORMAT « fiche » lui-même reste verrouillé à part (test-entity-link.js) : ici on teste ce qui
   l'ENTOURE. Harnais et assertions : harness.js. */
"use strict";
const { ck, section, SHARED } = require("./harness.js");

module.exports = async () => {
  const { AppLink } = SHARED("src-shared/AppLink.js");
  const { EntityLink } = SHARED("src-shared/EntityLink.js");

  await section("AppLink : 🚨 les étiquettes DÉJÀ IMPRIMÉES ne changent pas de comportement", async () => {
    // Le lien QR historique, construit par le format gravé — sans aucun paramètre.
    const printed = EntityLink.build("https://dcm.example.org/app", { docId: "d-infra", collection: "equipments", id: "eq-42" });
    const target = AppLink.parse(printed);

    ck.eq(target && target.kind, "fiche", "un lien d'étiquette reste lu comme une fiche");
    ck.eq(target && target.docId, "d-infra", "docId inchangé");
    ck.eq(target && target.collection, "equipments", "collection inchangée");
    ck.eq(target && target.id, "eq-42", "id inchangé");
    ck.eq(target && target.syncView, false,
      "🚨 sans `?vue=1`, le lien n'active AUCUNE vue — c'est ce qui rend le chantier SANS régression pour les QR imprimés");

    // …et l'écriture est bit pour bit celle d'EntityLink tant qu'on ne demande pas la synchronisation.
    ck.eq(AppLink.fragment({ kind: "fiche", docId: "d-infra", collection: "equipments", id: "eq-42", syncView: false }),
      EntityLink.fragment({ docId: "d-infra", collection: "equipments", id: "eq-42" }),
      "fragment sans synchronisation ≡ fragment EntityLink (aucune divergence de format possible)");
  });

  await section("AppLink : 🚨 le paramètre est SÉPARÉ du chemin avant délégation (piège de l'id avalé)", async () => {
    const withParam = AppLink.parse("#doc/d1/fiche/racks/r9?vue=1");
    ck.eq(withParam && withParam.syncView, true, "`?vue=1` est lu comme demande de synchronisation d'onglet");
    ck.eq(withParam && withParam.id, "r9",
      "🚨 l'id vaut « r9 », PAS « r9?vue=1 » — le suffixe est retiré AVANT EntityLink.parse (sinon : objet introuvable)");
    ck.eq(withParam && withParam.collection, "racks", "collection intacte malgré le suffixe");

    // Valeurs qui ne sont PAS une demande explicite : un lien tronqué ou bricolé ne doit pas
    // déclencher une navigation par accident.
    ck.eq(AppLink.parse("#doc/d1/fiche/racks/r9?vue=0").syncView, false, "`vue=0` → pas de synchronisation");
    ck.eq(AppLink.parse("#doc/d1/fiche/racks/r9?vue").syncView, false, "`vue` sans valeur → pas de synchronisation");
    ck.eq(AppLink.parse("#doc/d1/fiche/racks/r9?autre=1").syncView, false, "paramètre étranger ignoré");
    ck.eq(AppLink.parse("#doc/d1/fiche/racks/r9?a=2&vue=1").syncView, true, "`vue=1` reconnu parmi plusieurs paramètres");

    // Un id contenant lui-même un « ? » encodé ne doit pas être coupé : c'est le PREMIER `?` du
    // fragment qui sépare, et l'encodage segmentaire l'a déjà neutralisé.
    const tricky = { kind: "fiche", docId: "d1", collection: "spares", id: "sp?7", syncView: true };
    ck.eq(JSON.stringify(AppLink.parse(AppLink.fragment(tricky))), JSON.stringify(tricky),
      "un `?` DANS l'id survit au round-trip (encodé, donc invisible au découpage)");
  });

  await section("AppLink : la grammaire complète, round-trip build → parse", async () => {
    const cases = [
      { kind: "fiche", docId: "d1", collection: "equipments", id: "eq-1", syncView: true },
      { kind: "fiche", docId: "d1", collection: "attachments", id: "a 2/b", syncView: false },
      { kind: "intervention", docId: "d1", id: "int-7" },
      { kind: "cert", docId: "d1", id: "c#9" },
      { kind: "recherche", docId: "d1", query: "eq: switch cœur" },
    ];
    for (const target of cases) {
      const url = AppLink.build("https://h/app/dc-manager.html", target);
      ck.eq(JSON.stringify(AppLink.parse(url)), JSON.stringify(target), "round-trip « " + target.kind + " » : parse(build(x)) ≡ x");
    }

    ck.eq(AppLink.fragment({ kind: "fiche", docId: "d1", collection: "racks", id: "r9", syncView: true }),
      "doc/d1/fiche/racks/r9?vue=1", "forme écrite d'une fiche synchronisée");
    ck.eq(AppLink.fragment({ kind: "intervention", docId: "d1", id: "i7" }), "doc/d1/intervention/i7", "forme écrite d'une intervention");
    ck.eq(AppLink.fragment({ kind: "cert", docId: "d1", id: "c7" }), "doc/d1/cert/c7", "forme écrite d'un certificat");
    ck.eq(AppLink.fragment({ kind: "recherche", docId: "d1", query: "eq: sw" }), "doc/d1/recherche/eq%3A%20sw", "forme écrite d'une recherche (texte encodé)");

    // Toutes les formes commencent par `doc/<docId>/` — y compris les familles « hors document » :
    // leurs tables serveur sont bien indexées par doc_id, donc la bascule de document leur vaut aussi.
    ck(cases.every((t) => AppLink.fragment(t).startsWith("doc/d1/")), "toutes les formes portent le document (bascule possible partout)");
  });

  await section("AppLink.parse : cohabitation avec les hashes de VUE, et refus stricts", async () => {
    // La raison pour laquelle les deux routages ne peuvent pas se disputer un fragment : aucun nom
    // de vue ne contient de `/`. `null` est ici la réponse NORMALE, à chaque hashchange d'onglet.
    for (const view of ["#equipements", "#graph", "#ipam", "#certificats", ""]) {
      ck.eq(AppLink.parse(view), null, "hash de vue « " + view + " » → null (la navigation par onglet reste au Shell)");
    }
    ck.eq(AppLink.parse("doc/d1/fiche/racks"), null, "segment manquant → null");
    ck.eq(AppLink.parse("doc/d1/fiche/inconnue/x"), null, "collection hors liste blanche → null (délégué à EntityLink)");
    ck.eq(AppLink.parse("doc//fiche/racks/r9"), null, "docId vide → null");
    ck.eq(AppLink.parse("doc/d1/autre/x"), null, "mot-clé inconnu → null");
    ck.eq(AppLink.parse("doc/d1/intervention/i/x"), null, "intervention à segments en trop → null");
    ck.eq(AppLink.parse("doc/d1/intervention/"), null, "intervention sans id → null");
    ck.eq(AppLink.parse("doc/d1/recherche/"), null, "recherche VIDE → null (un Ctrl+K fait déjà ça)");
    ck.eq(AppLink.parse("doc/d1/recherche/%E0%A4%A"), null, "%-encodage invalide → null, sans lancer");
    ck.eq(AppLink.parse(null), null, "entrée nulle → null");
    ck.eq(AppLink.parse(42), null, "entrée non textuelle → null");

    // Agnostique de l'hôte (invariant de survie hérité d'EntityLink) : une étiquette imprimée sous
    // l'ancienne URL reste résoluble DANS l'app après un déménagement.
    ck.eq(AppLink.parse("https://ancienne.local:8443/vieux#doc/d1/fiche/racks/r9").id, "r9",
      "lien d'un AUTRE hôte/chemin : la cible est extraite quand même");

    // Une recherche peut contenir un `/` tapé à la main : c'est du TEXTE, pas un identifiant.
    ck.eq(AppLink.parse("doc/d1/recherche/a/b").query, "a/b", "un `/` non encodé reste du texte de recherche");
  });

  await section("AppLink.fromStackKey : LE REGISTRE — quelle modale a une adresse ?", async () => {
    // Les 21 fiches du document portent déjà `detail:<collection>/<id>` : la clé de pile EST l'adresse.
    const fiche = AppLink.fromStackKey("detail:equipments/eq-42", "d1");
    ck.eq(fiche && fiche.kind, "fiche", "`detail:` → fiche");
    ck.eq(fiche && fiche.collection, "equipments", "collection extraite de la clé");
    ck.eq(fiche && fiche.id, "eq-42", "id extrait de la clé");
    ck.eq(fiche && fiche.syncView, false, "la dérivation ne DÉCIDE pas du partage : la synchronisation est ajoutée par le bouton");

    // Décision A4 : le visualiseur de PJ n'a pas d'adresse propre, il REPLIE sur la fiche.
    const viewer = AppLink.fromStackKey("view:attachments/att-3", "d1");
    ck.eq(viewer && viewer.kind, "fiche", "`view:attachments/…` replie sur la FICHE de la pièce jointe");
    ck.eq(viewer && viewer.collection, "attachments", "…de la bonne collection");

    ck.eq(AppLink.fromStackKey("intervention:i7", "d1").kind, "intervention", "`intervention:` → famille hors document");
    ck.eq(AppLink.fromStackKey("cert:c9", "d1").id, "c9", "`cert:` → famille hors document, id conservé");

    // Ce qui n'est PAS un objet n'a pas d'adresse — et c'est ainsi qu'aucun bouton n'apparaît là où
    // il n'y aurait rien à partager (pas de promesse non tenue).
    for (const key of ["settings", "cart", "scan:viewfinder", "user-info", "rack-content:r1"]) {
      ck.eq(AppLink.fromStackKey(key, "d1"), null, "« " + key + " » n'est pas un objet adressable → null");
    }
    ck.eq(AppLink.fromStackKey("detail:inconnue/x", "d1"), null, "collection hors liste blanche → null (même garde qu'au parse)");
    ck.eq(AppLink.fromStackKey("detail:equipments", "d1"), null, "clé `detail:` sans id → null");
    ck.eq(AppLink.fromStackKey("detail:equipments/eq-1", ""), null, "sans document courant, aucun lien n'est constructible");
    ck.eq(AppLink.fromStackKey(undefined, "d1"), null, "clé absente (modale qui n'en déclare pas) → null");

    // Le registre est la SOURCE de l'extensibilité : on le lit, on ne le réécrit pas.
    ck.eq(AppLink.stackKeyPrefixes().join(" "), "detail: view: intervention: cert:", "préfixes reconnus, dérivés du registre");

    // Round-trip complet du geste réel : clé de pile → lien partagé → cible rouverte.
    const shared = AppLink.build("https://h/app", AppLink.withViewSync(AppLink.fromStackKey("detail:racks/r9", "d1")));
    const reopened = AppLink.parse(shared);
    ck.eq(shared, "https://h/app#doc/d1/fiche/racks/r9?vue=1", "le lien PARTAGÉ porte la synchronisation d'onglet (défaut, décision A1)");
    ck.eq(reopened.collection + "/" + reopened.id + " vue=" + reopened.syncView, "racks/r9 vue=true", "…et se relit intégralement");

    // `withViewSync` ne s'applique qu'aux fiches : les familles externes s'ouvrent DANS leur vue,
    // il n'y a rien à paramétrer pour elles.
    const ext = AppLink.withViewSync({ kind: "cert", docId: "d1", id: "c1" });
    ck.eq(JSON.stringify(ext), JSON.stringify({ kind: "cert", docId: "d1", id: "c1" }), "withViewSync laisse une famille externe intacte");
  });

  await section("AppLink.baseOf : un lien partagé n'emporte NI hash NI query", async () => {
    ck.eq(AppLink.baseOf("https://h/app/dc-manager.html#doc/d1/fiche/racks/r9"), "https://h/app/dc-manager.html", "hash retiré");
    ck.eq(AppLink.baseOf("https://h/app?code=abc&state=xyz"), "https://h/app",
      "query retirée — un retour d'authentification n'a rien à faire dans un lien envoyé à un collègue");
    ck.eq(AppLink.baseOf("https://h/app?a=1#equipements"), "https://h/app", "hash ET query retirés ensemble");
    ck.eq(AppLink.baseOf("  https://h/app  "), "https://h/app", "base trimée");
    ck.eq(AppLink.baseOf("file:///C:/parc/dc-manager.html#x"), "file:///C:/parc/dc-manager.html",
      "mode fichier : la base locale est conservée telle quelle (le lien vaut pour ce poste — écart assumé, principe n°15)");
    ck.eq(AppLink.baseOf(null), "", "entrée nulle → chaîne vide, sans lancer");
  });
};
