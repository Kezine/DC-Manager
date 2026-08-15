/* Tests modules — SOURCE du PICKER ASYNC (chantier « picker async » : EntityPicker à source
   serveur-pilotée pour les collections volumineuses/lazy SANS règle métier d'options).
   ----------------------------------------------------------------------------
   Prouve les quatre pans du module `core/EntityPickerSource` :
   1. PARCOURS LOCAL (collection hydratée / mode fichier) : tout le cache nommé par la règle
      injectée, tri alpha sur le libellé NORMALISÉ (casse/accents), borné, surplus compté EXACT.
   2. PARCOURS DISTANT (route de LISTING, jamais /search — la recherche transverse ne sait pas
      parcourir) : paramètres exacts passés à `list` (page 1, pageSize = plafond, sort/dir), surplus
      = total - lignes ; SANS `sortColumn` → aucun sort envoyé + re-tri alpha CLIENT de la page ;
      `sortColumn` HORS liste blanche → warn + traité absent.
   3. ROBUSTESSE du parcours distant : échec RÉEL → repli local silencieux (warn) ; requête
      DEVANCÉE → signal annulé et rejet qui FILE (le StaleGate du SearchPop tranche, pas de repli).
   4. RECHERCHE (requête non vide) : DÉLÉGUÉE à `EntityCandidateSource` (parité de résultats avec
      une source montée pareil), jamais de surplus annoncé ; libellés `labelOf`/`resolveLabel` ;
      anti-rebond porté par la source (0 local / tempo serveur avec lecteur).
   Harnais et assertions : harness.js (store FACTICE conforme au contrat `PickerStore`). */
"use strict";
const { ck, section, D } = require("./harness.js");

const { CollectionPickerSource } = D("core/EntityPickerSource.js");
const { EntityCandidateSource } = D("core/EntityCandidates.js");

/** Règle de NOMMAGE injectée (celle du pilote notifications : nom, sinon repli). */
const FAMILY = { kind: "contact", collection: "contacts", label: (r) => r.name || "(sans nom)", sortColumn: "name" };

/** Store FACTICE conforme au contrat `PickerStore` (all/get/list/fetchOne/hydration) — le vrai
    Store le satisfait structurellement, ici on contrôle chaque réponse. `list` : implémentation
    injectable (défaut : première page du cache + total exact), appels JOURNALISÉS. */
function pickerStore({ records = [], hydrated = true, list = null } = {}) {
  const rows = records.map((r) => ({ ...r }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const listCalls = [];
  return {
    listCalls,
    all: (c) => (c === "contacts" ? rows.slice() : []),
    get: (c, id) => (c === "contacts" && byId.get(id)) || null,
    hydration: { isHydrated: () => hydrated },
    list: (c, opts) => {
      listCalls.push({ collection: c, opts });
      if (list) return list(c, opts);
      return Promise.resolve({ rows: rows.slice(0, opts.pageSize), total: rows.length });
    },
    fetchOne: async (c, id) => (c === "contacts" && byId.get(id)) || null,
  };
}

const labels = (batch) => batch.options.map((o) => o.label);
const values = (batch) => batch.options.map((o) => o.value);

/** Capture des console.warn le temps d'un bloc (même recette que test-entity-candidates). */
async function captureWarns(fn) {
  const warns = [];
  const origWarn = console.warn; console.warn = (...a) => warns.push(a);
  try { await fn(); } finally { console.warn = origWarn; }
  return warns;
}

module.exports = async function () {

  await section("CollectionPickerSource — PARCOURS LOCAL (tri normalisé, borne, surplus exact)", async () => {
    // Corpus à casse/accents mêlés : le tri se fait sur le libellé NORMALISÉ (Schema.normSearch),
    // « Émile » entre « Bob » et « zoé » — pas après « z » comme le donnerait un tri brut.
    const store = pickerStore({ records: [
      { id: "c1", name: "zoé" }, { id: "c2", name: "Émile" }, { id: "c3", name: "alice" },
      { id: "c4", name: "Bob" }, { id: "c5", name: "Ana" },
    ] });
    const source = new CollectionPickerSource(store, FAMILY, null);
    const all = await source.fetch("");
    ck.eq(labels(all).join(","), "alice,Ana,Bob,Émile,zoé", "parcours local : tri alpha sur libellé NORMALISÉ (casse/accents repliés)");
    ck.eq(all.hidden, 0, "sous le plafond : aucun surplus");
    ck.eq(store.listCalls.length, 0, "collection hydratée : le parcours ne touche JAMAIS la route de listing");

    // BORNE + surplus EXACT (plafond injecté à 3 : 5 candidats → 3 montrés, 2 tus mais COMPTÉS).
    const bounded = new CollectionPickerSource(store, FAMILY, null, 3);
    const page = await bounded.fetch("");
    ck.eq(labels(page).join(","), "alice,Ana,Bob", "borne : les 3 premiers de l'ordre trié");
    ck.eq(page.hidden, 2, "surplus compté EXACT (annoncé par le contrôle, jamais tu)");

    // Une saisie d'ESPACES est un parcours (même trim que le filtrage sync d'OptionSearch).
    ck.eq((await source.fetch("   ")).options.length, 5, "requête blanche (espaces) = PARCOURS");
  });

  await section("CollectionPickerSource — PARCOURS DISTANT (paramètres de listing, surplus, re-tri, colonne invalide)", async () => {
    // Paramètres EXACTS de l'appel `list` : page 1, pageSize = plafond, tri injecté asc, signal posé.
    const remote = pickerStore({ hydrated: false, list: () => Promise.resolve({
      rows: [{ id: "r1", name: "alice" }, { id: "r2", name: "Bob" }, { id: "r3", name: "Chloé" }, { id: "r4", name: "Dan" }],
      total: 9,
    }) });
    const source = new CollectionPickerSource(remote, FAMILY, null, 4);
    const batch = await source.fetch("");
    ck.eq(remote.listCalls.length, 1, "parcours non hydraté : UN appel à la route de listing");
    const opts = remote.listCalls[0].opts;
    ck.eq(remote.listCalls[0].collection, "contacts", "collection de la famille");
    ck.eq(opts.page, 1, "page 1 (le parcours montre le DÉBUT du corpus ordonné)");
    ck.eq(opts.pageSize, 4, "pageSize = plafond du contrôle");
    ck.eq(opts.sort, "name", "tri serveur = sortColumn injectée");
    ck.eq(opts.dir, "asc", "direction asc (un parcours se lit dans l'ordre alphabétique)");
    ck(opts.signal instanceof AbortSignal, "signal d'annulation posé sur la requête");
    ck.eq(labels(batch).join(","), "alice,Bob,Chloé,Dan", "AVEC sortColumn : l'ordre SERVEUR est conservé tel quel");
    ck.eq(batch.hidden, 5, "surplus distant = total - lignes reçues (9 - 4)");

    // SANS sortColumn : aucun sort/dir envoyés (ordre serveur created_date) + re-tri alpha CLIENT
    // de la page reçue — la limite documentée (le corpus entier, lui, n'est pas ordonné par libellé).
    const unsortedRemote = pickerStore({ hydrated: false, list: () => Promise.resolve({
      rows: [{ id: "r1", name: "zoé" }, { id: "r2", name: "alice" }, { id: "r3", name: "Émile" }],
      total: 3,
    }) });
    const noColumn = { kind: "contact", collection: "contacts", label: (r) => r.name || "(sans nom)" };
    const plain = await new CollectionPickerSource(unsortedRemote, noColumn, null).fetch("");
    ck.eq(unsortedRemote.listCalls[0].opts.sort, undefined, "sans sortColumn : AUCUN sort envoyé");
    ck.eq(unsortedRemote.listCalls[0].opts.dir, undefined, "sans sortColumn : aucune direction envoyée");
    ck.eq(labels(plain).join(","), "alice,Émile,zoé", "sans sortColumn : la PAGE reçue est re-triée alpha CLIENT");

    // `sortColumn` HORS liste blanche (ListOrder.isSortable) : warn À LA CONSTRUCTION + traitée
    // absente — dégrader une fois vaut mieux que casser chaque focus par un 400/throw.
    const badRemote = pickerStore({ hydrated: false, list: () => Promise.resolve({
      rows: [{ id: "r1", name: "zoé" }, { id: "r2", name: "alice" }], total: 2,
    }) });
    let badBatch = null;
    const warns = await captureWarns(async () => {
      const bad = { kind: "contact", collection: "contacts", label: (r) => r.name || "(sans nom)", sortColumn: "pigeon_voyageur" };
      badBatch = await new CollectionPickerSource(badRemote, bad, null).fetch("");
    });
    ck.eq(warns.length, 1, "colonne invalide : UNE trace console à la construction (défensif, jamais silencieux)");
    ck.eq(badRemote.listCalls[0].opts.sort, undefined, "colonne invalide : traitée ABSENTE (aucun sort envoyé)");
    ck.eq(labels(badBatch).join(","), "alice,zoé", "colonne invalide : re-tri client, comme sans colonne");
  });

  await section("CollectionPickerSource — parcours distant : repli sur échec réel, annulation qui file", async () => {
    // ÉCHEC RÉEL (5xx/réseau) : repli SILENCIEUX sur le cache local (trace console, parité
    // EntityCandidateSource.fetch) — un champ de formulaire ne doit jamais bloquer l'UI.
    const failing = pickerStore({
      hydrated: false,
      records: [{ id: "c1", name: "Bob" }, { id: "c2", name: "alice" }],   // fraction déjà ABSORBÉE au cache
      list: () => Promise.reject(new Error("500 boom")),
    });
    const source = new CollectionPickerSource(failing, FAMILY, null);
    let fallback = null;
    const warns = await captureWarns(async () => { fallback = await source.fetch(""); });
    ck.eq(warns.length, 1, "échec réel : UNE trace console (diagnostic, pas d'UI d'erreur)");
    ck.eq(labels(fallback).join(","), "alice,Bob", "échec réel : REPLI sur le cache local, trié comme le parcours local");

    // ANNULATION : une seconde `fetch("")` ABORTE le signal de la première, dont le rejet FILE
    // (le StaleGate du SearchPop appelant tranche) — retomber sur le local serait un rendu concurrent.
    const signals = [];
    const hanging = pickerStore({ hydrated: false, list: (_c, opts) => new Promise((_res, reject) => {
      signals.push(opts.signal);
      opts.signal.addEventListener("abort", () => reject(new Error("requête annulée")));
    }) });
    const race = new CollectionPickerSource(hanging, FAMILY, null);
    let rejected = false;
    const raceWarns = await captureWarns(async () => {
      const first = race.fetch("");
      race.fetch("");   // devance la première (promesse non attendue : elle pend, on n'observe que les signaux)
      await first.then(() => {}, () => { rejected = true; });
    });
    ck(signals[0].aborted === true, "requête devancée → signal ANNULÉ (AbortController)");
    ck(signals[1].aborted === false, "requête courante → signal actif");
    ck(rejected, "le REJET de la requête devancée FILE (pas de repli concurrent)");
    ck.eq(raceWarns.length, 0, "une annulation n'est PAS un échec : aucune trace, aucun repli");
  });

  await section("CollectionPickerSource — recherche déléguée (parité), libellés, anti-rebond", async () => {
    const records = [{ id: "c1", name: "Alice Martin" }, { id: "c2", name: "Bob Alic" }, { id: "c3", name: "Chloé" }];
    // RECHERCHE LOCALE (reader null) : parité STRICTE avec un EntityCandidateSource monté pareil —
    // la recherche est DÉLÉGUÉE, aucune logique nouvelle (même classement, même plafond).
    const localStore = pickerStore({ records });
    const localSource = new CollectionPickerSource(localStore, FAMILY, null);
    const localRef = new EntityCandidateSource(localStore, [FAMILY], null, 50);
    const localOut = await localSource.fetch("ali");
    const localExpected = await localRef.fetch("ali");
    ck.eq(values(localOut).join(","), localExpected.map((i) => i.id).join(","), "recherche locale ≡ EntityCandidateSource (mêmes ids, même ordre)");
    ck.eq(labels(localOut).join(","), localExpected.map((i) => i.label).join(","), "recherche locale ≡ EntityCandidateSource (mêmes libellés)");
    ck(localOut.options.length > 0, "la parité porte sur un résultat NON vide (le test ne passe pas à vide)");

    // RECHERCHE SERVEUR (reader factice) : même parité — et jamais de surplus annoncé (le serveur
    // ne rend pas de compte, limite documentée).
    const reader = { search: async () => ({ contacts: [{ id: "c9", name: "Alicia-Serveur" }] }) };
    const apiStore = pickerStore({ records, hydrated: false });
    const apiSource = new CollectionPickerSource(apiStore, FAMILY, reader);
    const apiOut = await apiSource.fetch("alicia");
    const apiExpected = await new EntityCandidateSource(apiStore, [FAMILY], reader, 50).fetch("alicia");
    ck.eq(labels(apiOut).join(","), apiExpected.map((i) => i.label).join(","), "recherche serveur ≡ EntityCandidateSource (délégation)");
    ck.eq(apiOut.hidden, 0, "la RECHERCHE n'annonce jamais de surplus (hidden = 0)");
    ck.eq(apiStore.listCalls.length, 0, "la recherche ne passe JAMAIS par la route de listing");

    // LIBELLÉS : `labelOf` = cache + règle de nommage (miss → null) ; `resolveLabel` = lecture
    // unitaire (introuvable → null, le repli appartient au contrôle).
    ck.eq(localSource.labelOf("c1"), "Alice Martin", "labelOf : hit → règle de nommage injectée");
    ck.eq(localSource.labelOf("fantôme"), null, "labelOf : absent du cache → null");
    const anon = pickerStore({ records: [{ id: "c7", name: "" }] });
    ck.eq(new CollectionPickerSource(anon, FAMILY, null).labelOf("c7"), "(sans nom)", "labelOf : la règle de nommage porte son REPLI (nom vide)");
    ck.eq(await localSource.resolveLabel("c2"), "Bob Alic", "resolveLabel : trouvé → nom");
    ck.eq(await localSource.resolveLabel("fantôme"), null, "resolveLabel : introuvable → null (le repli est au contrôle)");

    // ANTI-REBOND porté par la source : 0 en local (aucun réseau à ménager), tempo serveur partagé sinon.
    ck.eq(localSource.debounceMs, 0, "reader null → debounce 0 (parité régime sync)");
    ck.eq(apiSource.debounceMs, EntityCandidateSource.DEBOUNCE_MS, "reader présent → debounce = EntityCandidateSource.DEBOUNCE_MS");
    ck.eq(EntityCandidateSource.DEBOUNCE_MS, 200, "le tempo partagé vaut bien 200 ms (verrou de non-dérive)");
  });

};
