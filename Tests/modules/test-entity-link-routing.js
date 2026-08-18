/* Tests modules — ROUTAGE d'un deep-link d'entité (`src-client/core/EntityLinkRouting`) :
   « cette cible d'étiquette QR : on ouvre la fiche tout de suite, ou on ouvre d'abord le
   document qu'elle désigne ? ». Le FORMAT du lien, lui, est verrouillé à part
   (test-entity-link.js, `src-shared/EntityLink`) ; ici c'est la DÉCISION qui est en jeu.

   Vérités verrouillées :
     · mode FICHIER — le `docId` de la cible est IGNORÉ (mono-document par nature) : une
       étiquette imprimée par une instance SERVEUR reste utilisable sur l'export fichier,
       c'est l'arbitrage n°1 du chantier ;
     · mode API — même document ⇒ `open` ; autre document (ou aucun d'ouvert) ⇒ `switch-doc` ;
     · entrées dégénérées ⇒ `null` (« rien à faire »), qui est la réponse NORMALE de chaque
       `hashchange` d'onglet.
   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D, SHARED } = require("./harness.js");

module.exports = async () => {
  const { EntityLinkRouting } = D("core/EntityLinkRouting.js");
  const { EntityLink } = SHARED("src-shared/EntityLink.js");

  /** Cible canonique (celle qu'un QR encode réellement — construite via le format partagé). */
  const targetOf = (docId, collection, id) => EntityLink.parse(EntityLink.build("https://dcm.example.org/app", { docId, collection, id }));

  await section("deep-link : mode FICHIER — le docId de la cible est IGNORÉ (mono-document)", async () => {
    const target = targetOf("d-serveur", "equipments", "eq-42");

    const route = EntityLinkRouting.decide({ restMode: false, currentDocId: null, target });
    ck.eq(route && route.action, "open", "mode fichier : une cible d'un document SERVEUR s'ouvre quand même (arbitrage n°1)");
    ck.eq(route && route.target.id, "eq-42", "la cible jugée est reconduite dans la décision (l'appelant ne la ré-extrait pas)");
    ck.eq(route && route.target.collection, "equipments", "collection reconduite telle quelle");
    ck(!("docId" in (route || {})), "mode fichier : aucune bascule de document n'est proposée");

    // Même réponse quel que soit l'état du champ `currentDocId` : il n'entre pas dans la règle ici.
    ck.eq(EntityLinkRouting.decide({ restMode: false, currentDocId: "un-autre", target }).action, "open",
      "mode fichier : `currentDocId` n'influence rien (il n'existe pas dans ce mode)");
  });

  await section("deep-link : mode API — même document ⇒ open, autre document ⇒ switch-doc", async () => {
    const target = targetOf("d-infra", "racks", "r-09");

    ck.eq(EntityLinkRouting.decide({ restMode: true, currentDocId: "d-infra", target }).action, "open",
      "mode API, document DÉJÀ ouvert : la fiche s'ouvre directement");

    const switched = EntityLinkRouting.decide({ restMode: true, currentDocId: "d-legacy", target });
    ck.eq(switched.action, "switch-doc", "mode API, AUTRE document : il faut l'ouvrir d'abord");
    ck.eq(switched.docId, "d-infra", "la bascule vise le document du LIEN, pas celui du navigateur");
    ck.eq(switched.target.id, "r-09", "la cible survit à la bascule (elle sera ouverte après le chargement)");

    // AUCUN document ouvert (boot interrompu, écran « aucun accès ») : le cache ne contient rien,
    // donc c'est encore une bascule — la fiche irait sinon lire un vide.
    const none = EntityLinkRouting.decide({ restMode: true, currentDocId: null, target });
    ck.eq(none.action, "switch-doc", "mode API, AUCUN document ouvert : bascule (le cache est vide)");
    ck.eq(none.docId, "d-infra", "… vers le document du lien");

    // Comparaison STRICTE des identifiants : deux documents dont l'un est préfixe de l'autre ne
    // doivent pas se confondre (un id serveur est opaque).
    ck.eq(EntityLinkRouting.decide({ restMode: true, currentDocId: "d-infra-2", target }).action, "switch-doc",
      "identifiants comparés à l'identique (`d-infra-2` ≠ `d-infra`)");
  });

  await section("deep-link : entrées dégénérées ⇒ null (rien à faire)", async () => {
    ck.eq(EntityLinkRouting.decide({ restMode: true, currentDocId: "d1", target: null }), null,
      "pas de cible (hash de VUE, QR étranger) : null — c'est la réponse de chaque hashchange d'onglet");
    ck.eq(EntityLinkRouting.decide({ restMode: false, currentDocId: null, target: null }), null,
      "pas de cible en mode fichier non plus");
    ck.eq(EntityLinkRouting.decide({ restMode: true, currentDocId: "d1", target: { docId: "d1", collection: "", id: "x" } }), null,
      "cible sans collection : null (on ne navigue pas sur une cible incomplète)");
    ck.eq(EntityLinkRouting.decide({ restMode: true, currentDocId: "d1", target: { docId: "d1", collection: "racks", id: "" } }), null,
      "cible sans id : null");

    // Cible SANS document en mode API : `EntityLink.parse` n'en produit jamais, mais la décision est
    // appelable avec une cible bâtie ailleurs (futur greffon de scan) — on tente le document courant
    // plutôt que de basculer vers rien.
    ck.eq(EntityLinkRouting.decide({ restMode: true, currentDocId: "d1", target: { docId: "", collection: "racks", id: "r1" } }).action, "open",
      "mode API, cible sans docId : `open` dans le document courant (rien vers quoi basculer)");
  });
};
