/* Tests modules — FRAÎCHEUR DU CACHE (`core/DocFreshness`, lot R3 — cf. docs/hydratation.md
   § « Fraîcheur — SSE manqués »).

   Décision PURE des vérifications de révision du document en mode API : les événements SSE peuvent
   être MANQUÉS sans signal (onglet endormi/déchargé, veille, coupure — EventSource re-connecte mais ne
   rejoue rien, LiveBus n'a aucun historique). On vérifie ici :
     - le GUICHET anti-rafale `accept(nowMs)` : les déclencheurs se recouvrent (alt-tab = focus +
       visibilitychange), jamais deux vérifications en vol ni à moins de MIN_INTERVAL_MS d'écart ;
     - `noteFresh(nowMs)` : un document fraîchement chargé repousse la fenêtre SANS toucher l'état
       « en vol » ;
     - le VERDICT `verdict(serverRev, clientRev)` : égalité → fresh, écart dans les DEUX sens → stale
       (un backup serveur restauré fait RECULER la révision), illisible → unknown (jamais de
       rattrapage sur une donnée douteuse) ;
     - l'extraction `revFromList(docs, docId)` : la révision du document courant dans la réponse du
       registre (`GET /documents`), null sur tout cas dégénéré.

   L'horloge est PASSÉE en paramètre (patron AccessDenial) : aucun timer réel dans ces tests.

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D } = require("./harness.js");
const { DocFreshness } = D("core/DocFreshness.js");

module.exports = async () => {

  await section("DocFreshness : guichet anti-rafale (accept / done / noteFresh)", async () => {
    const f = new DocFreshness();
    const t0 = 1_000_000;

    // Première demande : rien en vol, aucune fenêtre → part.
    ck.eq(f.accept(t0), true, "première vérification acceptée");
    // Recouvrement immédiat (alt-tab : focus + visibilitychange à quelques ms) : refusé — EN VOL.
    ck.eq(f.accept(t0 + 5), false, "déclencheur recouvrant refusé pendant le vol");

    // La vérification finit : la fenêtre anti-rafale continue de courir depuis l'ACCEPTATION.
    f.done();
    ck.eq(f.accept(t0 + DocFreshness.MIN_INTERVAL_MS - 1), false, "après done(), refus tant que la fenêtre court (depuis l'acceptation)");
    ck.eq(f.accept(t0 + DocFreshness.MIN_INTERVAL_MS), true, "fenêtre écoulée → la suivante part");
    f.done();

    // noteFresh REPOUSSE la fenêtre (document rechargé en entier : re-vérifier serait absurde)…
    const t1 = t0 + 10 * DocFreshness.MIN_INTERVAL_MS;
    f.noteFresh(t1);
    ck.eq(f.accept(t1 + DocFreshness.MIN_INTERVAL_MS - 1), false, "noteFresh repousse la fenêtre anti-rafale");
    ck.eq(f.accept(t1 + DocFreshness.MIN_INTERVAL_MS), true, "…et la veille reprend après la fenêtre");

    // …mais ne débloque JAMAIS un vol en cours : c'est done() qui clôt, et lui seul.
    ck.eq(f.accept(t1 + 20 * DocFreshness.MIN_INTERVAL_MS), false, "en vol : refus même la fenêtre écoulée");
    f.noteFresh(t1 + 20 * DocFreshness.MIN_INTERVAL_MS);
    ck.eq(f.accept(t1 + 40 * DocFreshness.MIN_INTERVAL_MS), false, "noteFresh ne clôt pas un vol en cours (seul done() le fait)");
    f.done();
    ck.eq(f.accept(t1 + 40 * DocFreshness.MIN_INTERVAL_MS), true, "done() tardif → la veille repart");
    f.done();

    // Constantes : le heartbeat est le « GET régulier » demandé (5 min), la fenêtre anti-rafale lui est
    // TRÈS inférieure (sinon elle avalerait les ticks du heartbeat lui-même).
    ck.eq(DocFreshness.HEARTBEAT_MS, 5 * 60 * 1000, "heartbeat = 5 minutes (constante du cadrage)");
    ck(DocFreshness.MIN_INTERVAL_MS > 0 && DocFreshness.MIN_INTERVAL_MS * 4 <= DocFreshness.HEARTBEAT_MS,
      "fenêtre anti-rafale positive et très inférieure au heartbeat");
  });

  await section("DocFreshness : verdict d'écart de révision", async () => {
    // Égalité → fresh (le cas nominal du heartbeat : rien à faire, silencieux).
    ck.eq(DocFreshness.verdict(42, 42), "fresh", "révisions égales → fresh");
    ck.eq(DocFreshness.verdict(0, 0), "fresh", "document jamais écrit (rev 0 des deux côtés) → fresh");

    // Écart dans les DEUX sens → stale : supérieur (événements manqués)…
    ck.eq(DocFreshness.verdict(43, 42), "stale", "révision serveur supérieure → stale (SSE manqués)");
    // …et INFÉRIEUR (backup serveur restauré : le cache client est en avance sur une vérité qui a reculé).
    ck.eq(DocFreshness.verdict(41, 42), "stale", "révision serveur inférieure → stale (backup restauré)");

    // Révision illisible → unknown : JAMAIS de rattrapage sur une donnée douteuse.
    ck.eq(DocFreshness.verdict(null, 42), "unknown", "révision serveur null → unknown");
    ck.eq(DocFreshness.verdict(NaN, 42), "unknown", "révision serveur NaN → unknown");
    ck.eq(DocFreshness.verdict(Infinity, 42), "unknown", "révision serveur infinie → unknown");
  });

  await section("DocFreshness : révision extraite du registre des documents", async () => {
    const docs = [
      { id: "doc-a", name: "A", rev: 7 },
      { id: "doc-b", name: "B", rev: 0 },        // rev 0 est une révision VALIDE (document jamais écrit)
      { id: "doc-c", name: "C", rev: "12" },     // rev non numérique (registre corrompu / réponse inattendue)
      { id: "doc-d", name: "D" },                // rev absente (serveur antérieur ?)
    ];
    ck.eq(DocFreshness.revFromList(docs, "doc-a"), 7, "document trouvé → sa révision");
    ck.eq(DocFreshness.revFromList(docs, "doc-b"), 0, "rev 0 est une révision valide (pas confondue avec « absent »)");
    ck.eq(DocFreshness.revFromList(docs, "doc-c"), null, "rev non numérique → null (aucun verdict possible)");
    ck.eq(DocFreshness.revFromList(docs, "doc-d"), null, "rev absente → null");
    ck.eq(DocFreshness.revFromList(docs, "doc-z"), null, "document ABSENT de la liste (supprimé ?) → null");
    ck.eq(DocFreshness.revFromList(null, "doc-a"), null, "liste null → null");
    ck.eq(DocFreshness.revFromList({}, "doc-a"), null, "réponse non-tableau → null");
    ck.eq(DocFreshness.revFromList([null, undefined, "x", { id: "doc-a", rev: 3 }], "doc-a"), 3,
      "entrées dégénérées ignorées, le document est quand même trouvé");
    // Verdict enchaîné sur l'extraction : le pipeline complet du contrôleur.
    ck.eq(DocFreshness.verdict(DocFreshness.revFromList(docs, "doc-z"), 5), "unknown",
      "document disparu → unknown de bout en bout (jamais de rattrapage)");
    ck.eq(DocFreshness.verdict(DocFreshness.revFromList(docs, "doc-a"), 5), "stale",
      "document trouvé à une autre révision → stale de bout en bout");
  });
};
