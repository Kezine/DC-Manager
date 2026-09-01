/* Tests modules — ROUTAGE d'un lien direct (`src-client/core/AppLinkRouting`) : « cette cible :
   on agit tout de suite, ou on ouvre d'abord le document qu'elle désigne ? », et la carte
   « collection → onglet » (`src-client/core/CollectionViews`) qui rend l'activation de vue possible.

   Ce fichier remplace `test-entity-link-routing.js` : le module ne route plus seulement des fiches
   d'entité (étiquettes QR) mais les QUATRE formes de la grammaire (`src-shared/AppLink`). La règle
   du document, elle, n'a pas bougé — et c'est justement ce qu'on re-verrouille ici.

   Vérités verrouillées :
     · mode FICHIER — le `docId` de la cible est IGNORÉ (mono-document par nature) : une étiquette
       imprimée par une instance SERVEUR reste utilisable sur l'export fichier, c'est l'arbitrage
       n°1 du chantier QR ;
     · mode API — même document ⇒ `open` ; autre document (ou aucun d'ouvert) ⇒ `switch-doc` ;
     · la règle vaut à L'IDENTIQUE pour les quatre formes — une recherche aussi doit viser le bon
       parc, une intervention aussi est indexée par `doc_id` côté serveur ;
     · entrées dégénérées ⇒ `null` (« rien à faire »), qui est la réponse NORMALE de chaque
       `hashchange` d'onglet ;
     · 🚨 VERROU de la carte des onglets — toute collection À FICHE a un onglet déclaré, et cet
       onglet existe VRAIMENT dans `app/main.ts`. Sans lui, un lien `?vue=1` sur la collection
       oubliée n'activerait rien, SILENCIEUSEMENT.
   Le FORMAT, lui, est verrouillé à part (test-app-link.js). Harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, TsViews } = require("./harness.js");

module.exports = async () => {
  const { AppLinkRouting } = D("core/AppLinkRouting.js");
  const { CollectionViews } = D("core/CollectionViews.js");
  const { DetailForms } = D("views/forms/DetailForms.js");
  const { AppLink } = SHARED("src-shared/AppLink.js");

  /** Cible canonique (celle qu'un lien encode réellement — construite via la grammaire partagée). */
  const ficheOf = (docId, collection, id) => AppLink.parse(AppLink.build("https://dcm.example.org/app", { kind: "fiche", docId, collection, id, syncView: false }));

  await section("lien direct : mode FICHIER — le docId de la cible est IGNORÉ (mono-document)", async () => {
    const target = ficheOf("d-serveur", "equipments", "eq-42");

    const route = AppLinkRouting.decide({ restMode: false, currentDocId: null, target });
    ck.eq(route && route.action, "open", "mode fichier : une cible d'un document SERVEUR s'ouvre quand même (arbitrage n°1)");
    ck.eq(route && route.target.id, "eq-42", "la cible jugée est reconduite dans la décision (l'appelant ne la ré-extrait pas)");
    ck.eq(route && route.target.collection, "equipments", "collection reconduite telle quelle");
    ck(!("docId" in (route || {})), "mode fichier : aucune bascule de document n'est proposée");

    // Même réponse quel que soit l'état du champ `currentDocId` : il n'entre pas dans la règle ici.
    ck.eq(AppLinkRouting.decide({ restMode: false, currentDocId: "un-autre", target }).action, "open",
      "mode fichier : `currentDocId` n'influence rien (il n'existe pas dans ce mode)");

    // ⚠ L'indisponibilité des familles hors document en mode fichier n'est PAS jugée ici : elle se dit
    // par injection nulle dans `AppLinkOpener`. Le routage, lui, reste une règle de DOCUMENT.
    ck.eq(AppLinkRouting.decide({ restMode: false, currentDocId: null, target: { kind: "cert", docId: "d1", id: "c1" } }).action, "open",
      "mode fichier + certificat : le ROUTAGE dit `open` (le refus vient de l'injection nulle, pas d'un test de mode ici)");
  });

  await section("lien direct : mode API — même document ⇒ open, autre document ⇒ switch-doc", async () => {
    const target = ficheOf("d-infra", "racks", "r-09");

    ck.eq(AppLinkRouting.decide({ restMode: true, currentDocId: "d-infra", target }).action, "open",
      "mode API, document DÉJÀ ouvert : la fiche s'ouvre directement");

    const switched = AppLinkRouting.decide({ restMode: true, currentDocId: "d-legacy", target });
    ck.eq(switched.action, "switch-doc", "mode API, AUTRE document : il faut l'ouvrir d'abord");
    ck.eq(switched.docId, "d-infra", "la bascule vise le document du LIEN, pas celui du navigateur");
    ck.eq(switched.target.id, "r-09", "la cible survit à la bascule (elle sera ouverte après le chargement)");

    // AUCUN document ouvert (boot interrompu, écran « aucun accès ») : le cache ne contient rien,
    // donc c'est encore une bascule — la fiche irait sinon lire un vide.
    const none = AppLinkRouting.decide({ restMode: true, currentDocId: null, target });
    ck.eq(none.action, "switch-doc", "mode API, AUCUN document ouvert : bascule (le cache est vide)");
    ck.eq(none.docId, "d-infra", "… vers le document du lien");

    // Comparaison STRICTE des identifiants : deux documents dont l'un est préfixe de l'autre ne
    // doivent pas se confondre (un id serveur est opaque).
    ck.eq(AppLinkRouting.decide({ restMode: true, currentDocId: "d-infra-2", target }).action, "switch-doc",
      "identifiants comparés à l'identique (`d-infra-2` ≠ `d-infra`)");
  });

  await section("lien direct : la règle du DOCUMENT vaut pour les QUATRE formes", async () => {
    // C'est la raison pour laquelle le module a été généralisé plutôt que dupliqué : une recherche
    // lancée sur le mauvais parc est aussi fausse qu'une fiche lue dans le mauvais cache.
    const formes = [
      { kind: "fiche", docId: "d-infra", collection: "racks", id: "r1", syncView: true },
      { kind: "intervention", docId: "d-infra", id: "i1" },
      { kind: "cert", docId: "d-infra", id: "c1" },
      { kind: "recherche", docId: "d-infra", query: "switch" },
    ];
    for (const target of formes) {
      ck.eq(AppLinkRouting.decide({ restMode: true, currentDocId: "d-infra", target }).action, "open",
        "« " + target.kind + " » dans le document courant ⇒ open");
      ck.eq(AppLinkRouting.decide({ restMode: true, currentDocId: "d-autre", target }).action, "switch-doc",
        "« " + target.kind + " » dans un AUTRE document ⇒ switch-doc");
    }

    // Le drapeau de synchronisation d'onglet ne regarde pas le routage : il est reconduit intact
    // jusqu'à l'opener, qui seul décide d'activer la vue.
    const synced = AppLinkRouting.decide({ restMode: true, currentDocId: "d-infra", target: formes[0] });
    ck.eq(synced.target.syncView, true, "`syncView` traverse la décision sans être interprété (c'est l'opener qui agit)");
  });

  await section("lien direct : entrées dégénérées ⇒ null (rien à faire)", async () => {
    const fiche = (over) => ({ kind: "fiche", docId: "d1", collection: "racks", id: "r1", syncView: false, ...over });

    ck.eq(AppLinkRouting.decide({ restMode: true, currentDocId: "d1", target: null }), null,
      "pas de cible (hash de VUE, QR étranger) : null — c'est la réponse de chaque hashchange d'onglet");
    ck.eq(AppLinkRouting.decide({ restMode: false, currentDocId: null, target: null }), null,
      "pas de cible en mode fichier non plus");
    ck.eq(AppLinkRouting.decide({ restMode: true, currentDocId: "d1", target: fiche({ collection: "" }) }), null,
      "cible sans collection : null (on ne navigue pas sur une cible incomplète)");
    ck.eq(AppLinkRouting.decide({ restMode: true, currentDocId: "d1", target: fiche({ id: "" }) }), null,
      "cible sans id : null");
    ck.eq(AppLinkRouting.decide({ restMode: true, currentDocId: "d1", target: { kind: "intervention", docId: "d1", id: "" } }), null,
      "intervention sans id : null");
    ck.eq(AppLinkRouting.decide({ restMode: true, currentDocId: "d1", target: { kind: "recherche", docId: "d1", query: "   " } }), null,
      "recherche vide (espaces seuls) : null — la palette vierge est déjà à un Ctrl+K");

    // Cible SANS document en mode API : `AppLink.parse` n'en produit jamais, mais la décision est
    // appelable avec une cible bâtie ailleurs (greffon de scan) — on tente le document courant
    // plutôt que de basculer vers rien.
    ck.eq(AppLinkRouting.decide({ restMode: true, currentDocId: "d1", target: fiche({ docId: "" }) }).action, "open",
      "mode API, cible sans docId : `open` dans le document courant (rien vers quoi basculer)");
  });

  await section("CollectionViews : 🚨 VERROU — toute collection À FICHE a un onglet, et cet onglet EXISTE", async () => {
    /* Sans ce verrou, une collection à fiche oubliée dans la carte ferait un lien `?vue=1` qui
       n'active RIEN — sans erreur, sans trace : le pire des défauts, puisqu'il ne se voit que chez
       qui utilise ce lien-là. Et une entrée PÉRIMÉE (onglet renommé) masquerait le même trou.
       Même patron que le verrou d'exhaustivité du menu (test-nav-model.js). */
    const fiches = DetailForms.DETAIL_COLLECTIONS;
    ck(fiches.length >= 20, "verrou : la carte des fiches est bien lue — " + fiches.length + " collections ouvrables");

    const sansOnglet = fiches.filter((c) => !CollectionViews.viewOf(c));
    ck.eq(sansOnglet.join(", "), "",
      "🚨 verrou : toute collection À FICHE a un onglet déclaré (sinon un lien `?vue=1` n'active rien, silencieusement)");

    const declarees = new Set(fiches);
    const perimees = CollectionViews.declaredCollections().filter((c) => !declarees.has(c));
    ck.eq(perimees.join(", "), "", "verrou : aucune collection PÉRIMÉE dans la carte (fiche disparue de DETAIL_OPENERS)");

    // Les 4 collections SANS fiche sont des sous-objets : les inscrire promettrait une navigation
    // qui n'existe pas.
    for (const sous of ["ports", "aggregates", "rackItems", "waypoints"]) {
      ck.eq(CollectionViews.viewOf(sous), null, "« " + sous + " » est un sous-objet : aucun onglet promis");
    }
    ck.eq(CollectionViews.viewOf("collection-inventee"), null, "collection inconnue → null, sans lancer");

    // -- Les DEUX pièges de la carte : les onglets qui ne portent PAS le nom de leur collection --
    ck.eq(CollectionViews.viewOf("datacenters"), "salles", "⚠ `datacenters` s'affiche dans l'onglet « salles »");
    ck.eq(CollectionViews.viewOf("ipAddresses"), "ipam", "⚠ `ipAddresses` s'affiche dans l'onglet « ipam »");

    // -- Familles hors document --
    ck.eq(CollectionViews.viewOfExternal("intervention"), "interventions", "intervention → onglet « interventions »");
    ck.eq(CollectionViews.viewOfExternal("cert"), "certificats", "certificat → onglet « certificats »");

    // -- Le verrou de RÉALITÉ : ces noms d'onglets existent-ils dans main.ts ? Une carte cohérente
    //    avec elle-même mais qui nommerait un onglet inexistant activerait « rien » tout pareil.
    const fs = require("fs");
    const mainTs = path.join(__dirname, "..", "..", "src-client", "app", "main.ts");
    const vues = new Set(TsViews.declaredIn(fs.readFileSync(mainTs, "utf8"), "app/main.ts").map((v) => v.name));
    ck(vues.size >= 25, "verrou : la source de main.ts est bien lue — " + vues.size + " vues enregistrées");
    const fantomes = CollectionViews.declaredViews().filter((v) => !vues.has(v));
    ck.eq(fantomes.join(", "), "", "🚨 verrou : tout onglet nommé par la carte est RÉELLEMENT enregistré dans main.ts");
  });
};
