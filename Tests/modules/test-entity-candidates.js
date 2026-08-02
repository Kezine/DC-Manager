/* Tests modules — SOURCE de CANDIDATS d'entités PARTAGÉE (lot 4 du chantier recherche/chargement).
   ----------------------------------------------------------------------------
   Prouve les trois pans du lot :
   1. PARITÉ mode FICHIER avant/après (golden) : `EntityCandidates.local` rend EXACTEMENT ce que
      faisaient `interventionTargets.search` / `ListTargets.candidates` avant la factorisation
      (mêmes ids, même ordre) — vérifié contre une réplique LITTÉRALE de l'ancienne logique.
   2. CHEMIN SERVEUR : `fromRecords` — records → candidats, préférence de l'instance LOCALE du Store,
      RE-CLASSEMENT par pertinence, restriction aux collections des familles, plafond.
   3. ORCHESTRATION double mode : `EntityCandidateSource` — mode fichier (reader null → local),
      mode API (lecteur factice → fromRecords), REPLI local sur échec réel, ANNULATION de la requête
      devancée, dédup `excluded`.
   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D, SharedSchema, makeStore } = require("./harness.js");

const { EntityCandidates, EntityCandidateSource } = D("core/EntityCandidates.js");
const { TargetSearch } = D("core/TargetSearch.js");
const norm = SharedSchema.normSearch;

/** Familles de test : équipements + VMs confondus, nommage = `name` (comme les cibles réelles). */
const FAMILIES = [
  { kind: "equipment", collection: "equipments", label: (r) => r.name || "?" },
  { kind: "vm", collection: "vms", label: (r) => r.name || "?" },
];

/** Réplique LITTÉRALE de l'ancienne logique locale (pré-lot-4) — la référence de parité. */
function legacyLocal(store, families, query, opts = {}) {
  const items = families.flatMap((f) => store.all(f.collection).map((r) => ({ kind: f.kind, id: r.id, label: f.label(r) })));
  return TargetSearch.rank(items, query, { normalize: norm, limit: opts.limit != null ? opts.limit : 12, excluded: opts.excluded });
}

const ids = (candidates) => candidates.map((c) => c.kind + ":" + c.id);
const labels = (candidates) => candidates.map((c) => c.label);

module.exports = async function () {

  await section("EntityCandidates — parité mode FICHIER (golden ids + ordre)", async () => {
    const s = await makeStore();
    // Corpus déterministe : deux « SW- » (préfixe), un « Router » (inclusion sur « x »), deux « srv- ».
    const swBord = await s.create("equipments", { name: "SW-Bord", type: "switch" });
    const swCoeur = await s.create("equipments", { name: "SW-Coeur", type: "switch" });
    const routerX = await s.create("equipments", { name: "Router-X", type: "router" });
    const srvWeb = await s.create("vms", { name: "srv-web" });
    const srvDb = await s.create("vms", { name: "srv-db" });

    // PRÉFIXE avant inclusion, puis alphabétique du libellé normalisé (contrat TargetSearch).
    ck.eq(ids(EntityCandidates.local(s, FAMILIES, "sw")).join(","), "equipment:" + swBord.id + ",equipment:" + swCoeur.id,
      "« sw » → SW-Bord puis SW-Coeur (préfixe, tri alpha)");
    ck.eq(ids(EntityCandidates.local(s, FAMILIES, "srv")).join(","), "vm:" + srvDb.id + ",vm:" + srvWeb.id,
      "« srv » → srv-db puis srv-web (VMs, tri alpha)");
    ck.eq(ids(EntityCandidates.local(s, FAMILIES, "x")).join(","), "equipment:" + routerX.id,
      "« x » → Router-X seul (inclusion, pas préfixe)");
    ck.eq(EntityCandidates.local(s, FAMILIES, "").length, 0, "requête VIDE → aucun candidat (jamais d'inondation au focus)");
    ck.eq(EntityCandidates.local(s, FAMILIES, "zzz").length, 0, "aucune correspondance → liste vide");

    // PARITÉ stricte avec l'ancienne logique, sur plusieurs requêtes (la factorisation ne change RIEN).
    for (const q of ["s", "sw", "srv", "coeur", "router", "-", "SW", "x", ""]) {
      ck.eq(ids(EntityCandidates.local(s, FAMILIES, q)).join("|"), ids(legacyLocal(s, FAMILIES, q)).join("|"),
        "parité fichier avant/après pour « " + q + " »");
    }

    // DÉDUP `excluded` (cibles déjà liées) — écartées AVANT le plafond.
    const excluded = new Set([TargetSearch.key("equipment", swCoeur.id)]);
    ck.eq(ids(EntityCandidates.local(s, FAMILIES, "sw", { excluded })).join(","), "equipment:" + swBord.id,
      "« sw » avec SW-Coeur exclu → SW-Bord seul (dédup)");
  });

  await section("EntityCandidates — chemin SERVEUR (fromRecords : dressage, re-classement, périmètre, plafond)", async () => {
    const s = await makeStore();
    const swBord = await s.create("equipments", { name: "SW-Bord", type: "switch" });
    const swCoeur = await s.create("equipments", { name: "SW-Coeur", type: "switch" });

    // 1. PRÉFÉRENCE de l'instance LOCALE : le record serveur porte un nom PÉRIMÉ, le libellé doit venir
    //    du Store (habillage riche + cohérence corpus local).
    const stale = { equipments: [{ id: swCoeur.id, name: "NOM-PÉRIMÉ" }] };
    ck.eq(labels(EntityCandidates.fromRecords(s, FAMILIES, stale, "sw")).join(","), "SW-Coeur",
      "record serveur périmé → libellé de l'instance LOCALE préférée");

    // 2. Record INCONNU localement (écriture concurrente pas encore synchronisée) → nommé sur le record BRUT.
    const ghost = { equipments: [{ id: "ghost-1", name: "Ghost-EQ" }] };
    ck.eq(labels(EntityCandidates.fromRecords(s, FAMILIES, ghost, "ghost")).join(","), "Ghost-EQ",
      "record inconnu du Store → libellé BRUT (dégradé mais fonctionnel)");

    // 3. RE-CLASSEMENT : le serveur rend dans un ordre quelconque (created_date,id) ; le client re-classe
    //    (préfixe/alpha) et ÉCARTE ce qui ne matche pas le libellé (Router-X, remonté par un terme dérivé).
    const scrambled = { equipments: [
      { id: "r-x", name: "Router-X" }, { id: swCoeur.id }, { id: swBord.id },
    ] };
    ck.eq(ids(EntityCandidates.fromRecords(s, FAMILIES, scrambled, "sw")).join(","), "equipment:" + swBord.id + ",equipment:" + swCoeur.id,
      "records serveur en désordre → RE-CLASSÉS (SW-Bord, SW-Coeur ; Router-X écarté par le libellé)");

    // 4. PÉRIMÈTRE : une collection HORS familles (le serveur est générique) est ignorée.
    const foreign = { ports: [{ id: "p-1", name: "sw-port" }], equipments: [{ id: swBord.id }] };
    ck.eq(ids(EntityCandidates.fromRecords(s, FAMILIES, foreign, "sw")).join(","), "equipment:" + swBord.id,
      "collection inconnue des familles (ports) → IGNORÉE");

    // 5. PLAFOND : au-delà de `limit`, on borne (au-delà l'utilisateur affine).
    const many = { equipments: Array.from({ length: 20 }, (_v, i) => ({ id: "sw-" + i, name: "SW-" + String(i).padStart(2, "0") })) };
    ck.eq(EntityCandidates.fromRecords(s, FAMILIES, many, "sw", { limit: 5 }).length, 5, "plafond respecté (5)");
    ck.eq(EntityCandidates.fromRecords(s, FAMILIES, many, "sw").length, EntityCandidates.SEARCH_LIMIT,
      "plafond par défaut = EntityCandidates.SEARCH_LIMIT (" + EntityCandidates.SEARCH_LIMIT + ")");
  });

  await section("EntityCandidateSource — orchestration double mode (fichier, API, repli, annulation)", async () => {
    const s = await makeStore();
    const swBord = await s.create("equipments", { name: "SW-Bord", type: "switch" });
    const swCoeur = await s.create("equipments", { name: "SW-Coeur", type: "switch" });

    // MODE FICHIER : reader null → `fetch` rend le LOCAL (jamais de réseau, principe n°15).
    const fileSource = new EntityCandidateSource(s, FAMILIES, null);
    const fileOut = await fileSource.fetch("sw");
    ck.eq(ids(fileOut).join(","), "equipment:" + swBord.id + ",equipment:" + swCoeur.id, "mode FICHIER : fetch → candidats LOCAUX");
    ck.eq(ids(fileSource.local("sw")).join(","), ids(fileOut).join(","), "local() synchrone ≡ fetch() en mode fichier (exécution synchrone offerte, n°15)");

    // MODE API (lecteur factice) : records serveur → fromRecords. Le record est INCONNU du Store → habillé brut.
    const apiReader = { search: async (_q, _cols, _signal) => ({ equipments: [{ id: "srv-1", name: "SW-Serveur" }] }) };
    const apiSource = new EntityCandidateSource(s, FAMILIES, apiReader);
    ck.eq(labels(await apiSource.fetch("sw")).join(","), "SW-Serveur", "mode API : fetch → candidats du SERVEUR");

    // PÉRIMÈTRE envoyé au serveur : les collections des familles (equipments, vms).
    let seenCols = null;
    const spyReader = { search: async (_q, cols, _signal) => { seenCols = cols.slice(); return {}; } };
    await new EntityCandidateSource(s, FAMILIES, spyReader).fetch("sw");
    ck.eq(seenCols.join(","), "equipments,vms", "collections envoyées au serveur = celles des familles");

    // REPLI sur échec RÉEL : le serveur rejette (hors annulation) → retombe sur le LOCAL, sans lever.
    const warns = [];
    const origWarn = console.warn; console.warn = (...a) => warns.push(a);
    try {
      const failReader = { search: async () => { throw new Error("500 boom"); } };
      const failSource = new EntityCandidateSource(s, FAMILIES, failReader);
      ck.eq(ids(await failSource.fetch("sw")).join(","), "equipment:" + swBord.id + ",equipment:" + swCoeur.id,
        "échec serveur → REPLI sur les candidats LOCAUX (jamais bloquant)");
    } finally { console.warn = origWarn; }
    ck(warns.length === 1, "repli tracé une fois en console (diagnostic, pas d'UI d'erreur)");

    // DÉDUP `excluded` transmise au serveur ET au local.
    const dedupReader = { search: async () => ({ equipments: [{ id: swBord.id }, { id: swCoeur.id }] }) };
    const excluded = new Set([TargetSearch.key("equipment", swCoeur.id)]);
    ck.eq(ids(await new EntityCandidateSource(s, FAMILIES, dedupReader).fetch("sw", excluded)).join(","), "equipment:" + swBord.id,
      "mode API : `excluded` écarte la cible déjà liée");

    // ANNULATION de la requête devancée : une seconde `fetch` ABORTE le signal de la première.
    const signals = [];
    const hangReader = { search: (_q, _cols, signal) => { signals.push(signal); return new Promise(() => {}); } };   // ne résout jamais
    const raceSource = new EntityCandidateSource(s, FAMILIES, hangReader);
    raceSource.fetch("a"); raceSource.fetch("b");   // (promesses non attendues : on n'observe que les signaux)
    ck(signals[0].aborted === true, "requête devancée → signal ANNULÉ (AbortController)");
    ck(signals[1].aborted === false, "requête courante → signal actif");
  });

};
