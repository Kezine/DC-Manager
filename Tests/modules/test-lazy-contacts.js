/* Tests modules — VAGUE 1 du chantier « lazy-load des collections » : `contacts` chargée
   PARESSEUSEMENT de bout en bout en mode API (cf. docs/hydratation.md § « Vague 1 — contacts »
   et le cadrage `.notes/toDos/lazy-load-collections-cadrage-2026-08-11.md`).

   Ce qui est verrouillé ici :
   1. la LISTE CENTRALE (`core/LazyCollections`) : son contenu et l'invariant « ce sont de vraies
      collections » — un nom fautif serait silencieusement sans effet ;
   2. le module PUR `core/CollectionCountCache` (garde G6) : valeur asynchrone servie en synchrone,
      déduplication des relevés en vol, notification à l'arrivée, invalidation, échec non mis en cache ;
   3. le BOOT : `Store.init` transmet les collections lazy à l'adaptateur (elles ne sont PAS tirées),
      puis les RE-DÉCLARE après `_hydrate` — le contrat du lot 0 ; et la sémantique retenue pour le
      chemin sournois `syncCatalogs → _persistAll` (hydrater d'abord, jamais de snapshot amputé) ;
   4. l'HYDRATATION À LA DEMANDE (`Store.hydrate`) — le patron des formulaires qui ont besoin du tout ;
   5. les COMPTEURS (`Store.countOf` / `countHint`) : local quand la collection est hydratée, COUNT
      serveur mémoïsé sinon, invalidé par les écritures et par le SSE sauté (G3) ;
   6. le PAGER SERVEUR RÉEL (garde G4) : décision de régime (`StoreListRowSource.isServerPaged`) et
      machinerie de page du moteur (`ListRowEngine.page` : compteurs serveur, anti-relance, annulation
      d'une page devancée, échec sans boucle, oubli sur mutation) ;
   7. le TRI SERVEUR du régime pagé (pagination ORDONNÉE complète — lot 1b) : le tri dans la signature
      de page (changer de critère EST une nouvelle demande), sa transmission par la source, et le
      mapping critère de vue → champ du modèle (`core/ListServerSort`, validé par la liste blanche
      partagée `ListOrder`) — dont les `sortField` déclarés par le listing contacts pilote.

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D, SHARED, Store, EntityRegistry, makeStore } = require("./harness.js");
const { LAZY_COLLECTIONS_API } = D("core/LazyCollections.js");
const { CollectionCountCache } = D("core/CollectionCountCache.js");
const { HydrationState } = D("core/HydrationState.js");
const { ListRowEngine } = D("core/ListRowEngine.js");
const { StoreListRowSource } = D("core/StoreListRowSource.js");
const { RecordSearchIndex } = D("core/RecordSearchIndex.js");

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Adaptateur API SIMULÉ : sert des fixtures par collection, JOURNALISE tout (c'est le point : les
   tests prouvent CE QUI PART sur le réseau, pas seulement le résultat) et implémente le strict
   nécessaire aux chemins exercés (load/list/count/replaceAll/createOne/transact). */
function makeApiAdapter(collections) {
  const data = {};
  for (const [name, rows] of Object.entries(collections || {})) data[name] = rows.map((r) => ({ ...r }));
  const calls = { load: [], list: [], count: [], replaceAll: 0, transact: 0 };
  return {
    data, calls,
    async load(opts) {
      const skip = (opts && opts.skipCollections) || [];
      calls.load.push(skip.slice());
      const snap = { meta: {} };
      for (const name of Object.keys(data)) if (skip.indexOf(name) === -1) snap[name] = data[name].map((r) => ({ ...r }));
      return snap;
    },
    async list(collection, opts) {
      const options = opts || {};
      calls.list.push({ collection, page: options.page, pageSize: options.pageSize });
      const rows = (data[collection] || []).map((r) => ({ ...r }));
      const pageSize = Math.max(1, options.pageSize || 25);
      const total = rows.length, pages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(Math.max(1, options.page || 1), pages);
      return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total, page, pages, pageSize };
    },
    async count(collection) { calls.count.push(collection); return (data[collection] || []).length; },
    async replaceAll() { calls.replaceAll++; return null; },
    async transact() { calls.transact++; return null; },
    async createOne(collection, record) { (data[collection] = data[collection] || []).push({ ...record }); return record; },
    async saveMeta() { return null; },
  };
}

/** Fixtures d'un document SERVEUR : les catalogues fermés tels que le CODE les sème (sinon
    `syncCatalogs()` croit à une mise à jour de catalogue et déclenche le chemin de persistance),
    plus les contacts fournis. */
async function documentFixtures(contacts) {
  const seeded = await makeStore();          // BrowserStorageAdapter : newDocument → catalogues semés
  const snapshot = seeded.toJSON();
  const fixtures = { contacts: contacts || [] };
  for (const name of EntityRegistry.COLLECTIONS) if (name !== "contacts") fixtures[name] = snapshot[name] || [];
  return fixtures;
}

/** Store en MODE API simulé : état d'hydratation TRAÇANT + `contacts` déclarée lazy. */
function apiStore(adapter) { return new Store(adapter, new HydrationState(), ["contacts"]); }

module.exports = async () => {

  await section("Lazy-load : la LISTE CENTRALE des collections paresseuses (core/LazyCollections)", async () => {
    // Le CONTENU exact de la liste (et son extension par vague) est verrouillé par test-lazy-vague2.js :
    // ici, seule la présence du PILOTE compte — ce fichier teste son comportement de bout en bout.
    ck(LAZY_COLLECTIONS_API.indexOf("contacts") !== -1, "vague 1 : `contacts` est déclarée lazy (les vagues suivantes s'ajoutent à la MÊME liste)");
    const unknown = LAZY_COLLECTIONS_API.filter((c) => EntityRegistry.COLLECTIONS.indexOf(c) === -1);
    ck.eq(unknown.join(","), "", "🎯 INVARIANT : chaque nom est une VRAIE collection — un nom fautif serait sans effet, en silence");
    // Les exclusions ACTÉES du cadrage : les y voir un jour serait une régression de conception, pas un détail.
    ck(LAZY_COLLECTIONS_API.indexOf("vms") === -1, "`vms` reste EXCLUE du chantier (transverse : graphe, purge, certs, IPAM, bulle 3D)");
    ck(LAZY_COLLECTIONS_API.indexOf("ipAddresses") === -1, "les collections à portée globale (V6) restent exclues");
  });

  await section("G6 : CollectionCountCache — valeur async servie en synchrone, déduplication, invalidation", async () => {
    let served = 0;
    const resolvers = [];
    const notified = [];
    const cache = new CollectionCountCache(
      (collection) => { served++; return new Promise((resolve) => resolvers.push({ collection, resolve })); },
      (collection, count) => notified.push(collection + ":" + count),
    );

    // -- peek : lecture PURE (aucun relevé déclenché) ; value : rend le repli ET demande. --
    ck.eq(cache.peek("contacts"), null, "peek : valeur inconnue → null");
    ck.eq(served, 0, "peek ne déclenche AUCUN relevé (c'est son contrat)");
    ck.eq(cache.value("contacts"), 0, "value : repli 0 tant que la valeur n'est pas connue");
    ck.eq(served, 1, "value : le relevé est demandé");
    // Les rendus se succèdent bien plus vite qu'un aller-retour : une seule requête doit partir.
    cache.value("contacts"); cache.value("contacts"); cache.request("contacts");
    ck.eq(served, 1, "🎯 déduplication : 4 demandes rapprochées = UN seul relevé en vol");
    ck.eq(cache.pendingCount, 1, "un relevé en vol recensé");

    resolvers[0].resolve(42);
    await tick(1);
    ck.eq(cache.peek("contacts"), 42, "à l'arrivée : la valeur est en cache");
    ck.eq(cache.value("contacts"), 42, "value rend désormais la vraie valeur");
    ck.eq(notified.join(","), "contacts:42", "l'hôte est PRÉVENU (sans quoi rien ne repeindrait la pastille)");
    ck.eq(cache.pendingCount, 0, "plus rien en vol");
    ck.eq(served, 1, "valeur connue → aucun nouveau relevé (mémoïsation)");

    // -- invalidation ciblée : seule la collection visée repart au relevé. --
    cache.value("racks"); resolvers[1].resolve(7); await tick(1);
    cache.invalidate(["contacts"]);
    ck.eq(cache.peek("contacts"), null, "invalidate : la valeur est oubliée…");
    ck.eq(cache.peek("racks"), 7, "… et SEULEMENT celle-là");
    ck.eq(cache.value("contacts"), 0, "après invalidation : repli le temps du nouveau relevé");
    ck.eq(served, 3, "un relevé de plus, pour la seule collection invalidée");
    resolvers[2].resolve(43); await tick(1);
    cache.invalidateAll();
    ck.eq(cache.peek("contacts"), null, "invalidateAll : tout est oublié (remplacement complet du cache)");
    ck.eq(cache.peek("racks"), null, "invalidateAll : y compris les autres collections");

    // -- ÉCHEC : rien n'est mis en cache, la demande suivante retente (une panne ne fige pas une pastille). --
    let attempts = 0;
    const failing = new CollectionCountCache(() => { attempts++; return Promise.reject(new Error("503")); });
    let caught = false;
    try { await failing.request("contacts"); } catch (_) { caught = true; }
    ck(caught, "échec de relevé : la promesse REJETTE (l'appelant décide)");
    ck.eq(failing.peek("contacts"), null, "échec : rien n'entre au cache");
    ck.eq(failing.pendingCount, 0, "échec : le vol est bien retiré");
    try { await failing.request("contacts"); } catch (_) { /* attendu */ }
    ck.eq(attempts, 2, "🎯 échec NON mémorisé : la demande suivante retente (pas de pastille figée pour la session)");
  });

  await section("Vague 1 : le BOOT ne charge PLUS contacts, et les re-déclare APRÈS _hydrate", async () => {
    const adapter = makeApiAdapter(await documentFixtures([{ id: "c1", name: "Alice" }, { id: "c2", name: "Bob" }]));
    const store = apiStore(adapter);
    await store.init();

    ck.eq(adapter.calls.load[0].join(","), "contacts", "🎯 le chargement initial SAUTE contacts (la liste part du Store)");
    ck.eq(store.hydration.levelOf("contacts"), "none",
      "🎯 CONTRAT du lot 0 : `_hydrate` re-marque tout full → `init` re-déclare les lazy APRÈS (sinon le lazy serait annulé)");
    ck.eq(store.all("contacts").length, 0, "le cache ne contient aucun contact (rien n'a été tiré)");
    ck(store.hydration.isHydrated("equipments"), "les autres collections restent HYDRATÉES (comportement historique)");
    ck.eq(adapter.calls.replaceAll, 0, "catalogues déjà à jour → aucun snapshot au boot (comportement historique)");

    // Un RECHARGEMENT COMPLET (409, changement de document, ouverture) repasse par `init` : la
    // re-déclaration est donc centralisée — aucun appelant ne peut l'oublier.
    await store.init();
    ck.eq(store.hydration.levelOf("contacts"), "none", "🎯 rechargement COMPLET (init) : les lazy sont re-déclarées, pas rechargées");
    ck.eq(adapter.calls.load.length, 2, "deux chargements…");
    ck.eq(adapter.calls.load[1].join(","), "contacts", "… et le second saute contacts lui aussi");
  });

  await section("Vague 1 : mode FICHIER — aucune collection lazy, PAR CONSTRUCTION (principe n°15)", async () => {
    const adapter = makeApiAdapter(await documentFixtures([{ id: "c1", name: "Alice" }]));
    // INJECTION NULLE : sans état d'hydratation traçant, la liste lazy est ignorée — quoi qu'on passe.
    const store = new Store(adapter, null, ["contacts"]);
    await store.init();
    ck.eq(adapter.calls.load[0].join(","), "", "🎯 mode fichier : RIEN n'est sauté au chargement (le document EST le fichier)");
    ck.eq(store.hydration.levelOf("contacts"), "full", "mode fichier : contacts reste full");
    ck.eq(store.all("contacts").length, 1, "mode fichier : le contact est bien au cache");
    ck.eq(store.countHint("contacts"), 1, "mode fichier : le compteur reste LOCAL et synchrone");
    ck.eq(adapter.calls.count.length, 0, "mode fichier : aucun COUNT réseau, jamais");
  });

  await section("Vague 1 ⇄ G1 : boot + réconciliation des catalogues → HYDRATER d'abord, jamais de snapshot amputé", async () => {
    const fixtures = await documentFixtures([{ id: "c1", name: "Alice" }, { id: "c2", name: "Bob" }]);
    fixtures.portTypes = fixtures.portTypes.slice(1);   // le CODE a gagné un type depuis l'ouverture du document
    const adapter = makeApiAdapter(fixtures);
    const store = apiStore(adapter);

    let error = null;
    try { await store.init(); } catch (e) { error = e; }
    ck(!error, "🎯 le boot ABOUTIT (sans la sémantique retenue, G1 lèverait une HydrationError en pleine ouverture)");
    ck.eq(adapter.calls.replaceAll, 1, "le snapshot de réconciliation A ÉTÉ poussé (le catalogue devait bien être écrit)");
    ck(store.hydration.isFullyHydrated(), "il l'a été sur un corpus COMPLET : contacts a été hydratée d'abord (arbitrage n°3, mécanique G2)");
    ck.eq(store.all("contacts").length, 2, "conséquence ASSUMÉE : ce boot-là finit avec les contacts en cache…");
    ck.eq(store.toJSON().contacts.length, 2, "🎯 … donc le snapshot poussé porte les contacts (il ne les EFFACE pas côté serveur)");
    ck.eq(store.countHint("contacts"), 2, "… et le compteur redevient local (l'état DIT la vérité, on ne re-déclare rien)");

    // Boot SUIVANT : le catalogue est désormais à jour côté serveur → plus de snapshot, le lazy reprend.
    adapter.data.portTypes = store.toJSON().portTypes;
    const next = apiStore(makeApiAdapter(adapter.data));
    await next.init();
    ck.eq(next.hydration.levelOf("contacts"), "none", "🎯 boot suivant : plus de réconciliation → le chargement paresseux reprend");
  });

  await section("Vague 1 : hydratation À LA DEMANDE (Store.hydrate) — le patron des formulaires", async () => {
    const adapter = makeApiAdapter(await documentFixtures([{ id: "c1", name: "Alice" }, { id: "c2", name: "Bob" }]));
    const store = apiStore(adapter);
    await store.init();
    adapter.calls.list.length = 0;

    const hydrated = await store.hydrate(["contacts"]);
    ck.eq(hydrated.join(","), "contacts", "hydrate : la collection non chargée est retirée en ENTIER");
    ck.eq(store.all("contacts").length, 2, "les deux contacts sont désormais au cache (le `<select>` peut être bâti)");
    ck(!!store.get("contacts", "c2"), "les entités hydratées sont INDEXÉES (get par id)");
    ck.eq(store.hydration.levelOf("contacts"), "full", "l'état passe à full : listing, compteur et gardes suivent sans autre changement");

    adapter.calls.list.length = 0;
    ck.eq((await store.hydrate(["contacts"])).length, 0, "🎯 IDEMPOTENT : une collection déjà hydratée n'est pas re-tirée");
    ck.eq(adapter.calls.list.length, 0, "… et aucun aller-retour n'est émis (le coût est payé UNE fois par ouverture)");
    ck.eq((await store.hydrate(["equipments", "collectionInconnue"])).length, 0, "hydrate : collection hydratée ou inconnue → no-op (aucune erreur)");
  });

  await section("G6 : compteurs — local si hydratée, COUNT serveur mémoïsé sinon, invalidé par écritures et SSE", async () => {
    const adapter = makeApiAdapter(await documentFixtures([{ id: "c1", name: "Alice" }, { id: "c2", name: "Bob" }, { id: "c3", name: "Chloé" }]));
    const store = apiStore(adapter);
    const repaints = [];
    store.onCountResolved = (collection, count) => repaints.push(collection + ":" + count);
    await store.init();

    // -- Collection HYDRATÉE : strictement local, strictement synchrone (zéro régression). --
    ck.eq(store.countHint("racks"), 0, "collection hydratée : le compteur vient du cache local");
    ck.eq(await store.countOf("portTypes"), store.all("portTypes").length, "collection hydratée : countOf résout en local");
    ck.eq(adapter.calls.count.length, 0, "🎯 collection hydratée : AUCUN aller-retour (les 20+ collections non lazy ne paient rien)");

    // -- Collection LAZY : `all().length` MENTIRAIT (0) ; le compteur passe par le COUNT serveur. --
    ck.eq(store.all("contacts").length, 0, "sanité : le cache local dirait « 0 contact » — c'est le mensonge que G6 corrige");
    ck.eq(store.countHint("contacts"), 0, "1er rendu : valeur inconnue → 0 en attendant (le rendu ne bloque jamais)");
    store.countHint("contacts"); store.countHint("contacts");
    await tick(1);
    ck.eq(adapter.calls.count.filter((c) => c === "contacts").length, 1, "🎯 trois rendus rapprochés = UN seul COUNT serveur");
    ck.eq(store.countHint("contacts"), 3, "après réponse : le compteur dit la VÉRITÉ serveur");
    ck.eq(repaints.join(","), "contacts:3", "l'hôte est prévenu → il repeint ses pastilles");

    // -- Écriture LOCALE : le total a bougé → invalidation ciblée. --
    await store.create("contacts", { name: "Damien" });
    ck.eq(store.countHint("contacts"), 0, "après création : le compteur est invalidé (relevé en cours)");
    await tick(1);
    ck.eq(store.countHint("contacts"), 4, "… et repart du serveur, à jour");

    // -- SSE SAUTÉ par G3 : la collection n'est PAS rechargée, mais son compteur est invalidé. --
    adapter.data.contacts.push({ id: "c9", name: "Ève (autre client)" });
    const deferredSeen = [];
    store.onLazyReloadDeferred = (collections) => deferredSeen.push(...collections);
    await store.reloadCollections(["contacts"]);
    ck.eq(deferredSeen.join(","), "contacts", "G3 : la collection lazy est bien SAUTÉE (point d'accroche prévenu)");
    // Le niveau ne bouge pas : `create` écrit dans le cache sans ABSORBER une lecture serveur
    // (`noteAbsorption` n'est appelée que par list/fetchOne/fetchMany/fetchBy).
    ck.eq(store.hydration.levelOf("contacts"), "none", "G3 : elle n'est PAS re-tirée en entier (le lazy survit)");
    ck.eq(store.countHint("contacts"), 0, "🎯 son COMPTEUR, lui, est invalidé (le seul dérivé rafraîchissable à bas coût)");
    await tick(1);
    ck.eq(store.countHint("contacts"), 5, "… et reflète l'écriture de l'autre client");
  });

  await section("G4 : décision de régime — StoreListRowSource.isServerPaged (état, pas liste de noms)", async () => {
    const adapter = makeApiAdapter(await documentFixtures([{ id: "c1", name: "Alice" }]));
    const store = apiStore(adapter);
    await store.init();
    const index = new RecordSearchIndex((c, id) => store.get(c, id), (c, f, v) => store.findByField(c, f, v));
    const seen = [];
    const reader = {
      list: () => Promise.resolve([]),
      page: (collection, options) => { seen.push({ collection, ...options }); return Promise.resolve({ rows: [{ id: "srv" }], total: 9, page: options.page, pages: 3 }); },
    };
    const req = (collection, query) => ({ collection, query: query || "", target: null });

    const apiSource = new StoreListRowSource(store, index, null, reader);
    ck(apiSource.isServerPaged(req("contacts")), "🎯 collection NON hydratée + requête au repos → PAGER SERVEUR");
    ck(!apiSource.isServerPaged(req("equipments")), "collection hydratée → régime local, inchangé (« pas un pixel »)");
    ck(!apiSource.isServerPaged(req("contacts", "ali")),
      "🎯 recherche ACTIVE → chemin HISTORIQUE (jeu plafonné REMOTE_LIMIT, tri/pagination client) : les deux régimes ne se recouvrent jamais");
    ck(!apiSource.isServerPaged({ collection: "contacts", query: "", target: { kind: "equipment", id: "e1" } }),
      "cible filtrée → requête active → chemin historique lui aussi");

    // MODE FICHIER (ou lecteur d'avant G4) : jamais de pagination serveur.
    ck(!new StoreListRowSource(store, index, null, null).isServerPaged(req("contacts")), "mode fichier (aucun lecteur) : jamais de pager serveur");
    ck(!new StoreListRowSource(store, index, null, { list: () => Promise.resolve([]) }).isServerPaged(req("contacts")),
      "lecteur SANS chemin paginé : le régime n'est pas proposé (dégradation propre)");

    // C'est l'ÉTAT qui décide : une collection lazy REDEVENUE full repasse en local, sans rien changer d'autre.
    await store.hydrate(["contacts"]);
    ck(!apiSource.isServerPaged(req("contacts")), "🎯 collection redevenue `full` (hydratation à la demande) → retour immédiat au régime local");

    const page = await apiSource.fetchPage(req("contacts"), { page: 2, pageSize: 10 }, new AbortController().signal);
    ck.eq(seen[0].pageSize, 10, "fetchPage : la taille de page demandée part au serveur");
    ck.eq(seen[0].page, 2, "fetchPage : la page demandée aussi (c'est le serveur qui découpe)");
    ck.eq(seen[0].where, null, "fetchPage : `where` toujours null — le régime paginé exige une requête au repos");
    ck.eq(seen[0].sort, null, "fetchPage : sans critère mappé, `sort` part null (ordre serveur par défaut)");
    ck.eq(page.total, 9, "fetchPage : le TOTAL serveur (COUNT(*)) remonte tel quel — c'est lui qui rend le pager réel");

    // -- TRI serveur (pagination ORDONNÉE complète, lot 1b) : le critère mappé est TRANSMIS tel quel. --
    await apiSource.fetchPage(req("contacts"), { page: 1, pageSize: 10, sort: { field: "name", dir: "desc" } }, new AbortController().signal);
    ck.eq(JSON.stringify(seen[1].sort), JSON.stringify({ field: "name", dir: "desc" }),
      "🎯 fetchPage : le tri du listing part au lecteur (champ + direction) — c'est le serveur qui ordonne, la source ne retrie rien");
  });

  await section("G4 : ListRowEngine.page — compteurs serveur, anti-relance, annulation, échec, oubli", async () => {
    const req = { collection: "contacts", query: "", target: null };
    const makePagedSource = (paged) => {
      const calls = { fetch: [], signals: [] };
      const pending = [];
      return {
        calls, pending,
        local: () => [{ id: "local" }],
        remote: () => null,
        isServerPaged: () => paged,
        fetchPage: (request, pageRequest, signal) => {
          calls.fetch.push(pageRequest.page + "/" + pageRequest.pageSize);
          calls.signals.push(signal);
          return new Promise((resolve, reject) => pending.push({ resolve, reject }));
        },
      };
    };

    // -- Source NON paginée : `page()` rend null, l'appelant garde le chemin historique. --
    {
      const source = makePagedSource(false);
      const engine = new ListRowEngine(source, () => {}, 0);
      ck.eq(engine.page(req, { page: 1, pageSize: 25 }), null, "source non paginée → null (régime historique intégralement préservé)");
      ck.eq(source.calls.fetch.length, 0, "… et aucun tirage");
      // Une source d'AVANT G4 (sans `isServerPaged`) doit se comporter pareil : le champ est optionnel.
      const legacy = new ListRowEngine({ local: () => [], remote: () => null }, () => {}, 0);
      ck.eq(legacy.page(req, { page: 1, pageSize: 25 }), null, "🎯 source d'avant G4 (sans isServerPaged) : null, aucun crash");
      engine.reset();
    }

    // -- Page en vol → page vide + « chargement » ; à l'arrivée → compteurs SERVEUR. --
    {
      const source = makePagedSource(true);
      let repaints = 0;
      const engine = new ListRowEngine(source, () => { repaints++; }, 0);
      const first = engine.page(req, { page: 1, pageSize: 2 });
      ck.eq(first.rows.length, 0, "aucune page en main → page VIDE (le cache local ne contient pas la collection)");
      ck(engine.pageLoading, "🎯 `pageLoading` distingue « en cours » de « réellement vide » (la vue dit « Chargement… »)");
      ck.eq(source.calls.fetch.join(","), "1/2", "la page 1 est demandée");
      engine.page(req, { page: 1, pageSize: 2 }); engine.page(req, { page: 1, pageSize: 2 });
      ck.eq(source.calls.fetch.length, 1, "🎯 page EN VOL : des rendus de plus (tri, filtre) ne la relancent PAS");

      source.pending[0].resolve({ rows: [{ id: "a" }, { id: "b" }], total: 7, page: 1, pages: 4 });
      await tick(1);
      ck.eq(repaints, 1, "réponse → UN repeint demandé");
      const got = engine.page(req, { page: 1, pageSize: 2 });
      ck.eq(got.rows.map((r) => r.id).join(","), "a,b", "les lignes de la page sont servies");
      ck.eq(got.total + "/" + got.pages, "7/4", "🎯 total et nombre de pages viennent du SERVEUR (COUNT(*)) — plus d'arithmétique cliente");
      ck(!engine.pageLoading, "plus rien en vol");
      ck.eq(source.calls.fetch.length, 1, "page en main → aucun nouveau tirage");

      // -- Changement de page : nouvelle demande ; la page en main reste affichée entre-temps (jamais
      //    « page 2/4 » avec le contenu de la page 1 : lignes ET compteurs restent cohérents). --
      const during = engine.page(req, { page: 2, pageSize: 2 });
      ck.eq(during.page, 1, "🎯 pendant le vol : la page RÉELLEMENT en main est affichée (cohérence lignes ⇄ compteurs)");
      ck.eq(source.calls.fetch.join(","), "1/2,2/2", "la page 2 est bien demandée au serveur (pagination RÉELLE)");
      source.pending[1].resolve({ rows: [{ id: "c" }], total: 7, page: 2, pages: 4 });
      await tick(1);
      ck.eq(engine.page(req, { page: 2, pageSize: 2 }).rows.map((r) => r.id).join(","), "c", "à l'arrivée : la page 2 s'affiche");

      // -- Mutation du document : la page en main est PÉRIMÉE (le total a bougé) → oubliée. --
      engine.forgetPage();
      ck.eq(engine.page(req, { page: 2, pageSize: 2 }).rows.length, 0, "forgetPage : la page est oubliée…");
      ck.eq(source.calls.fetch.length, 3, "… et re-demandée au serveur (une création/suppression change page ET total)");
      engine.reset();
    }

    // -- Le pager DEVANCÉ est annulé : deux clics rapides ne laissent pas la réponse périmée peindre. --
    {
      const source = makePagedSource(true);
      let repaints = 0;
      const engine = new ListRowEngine(source, () => { repaints++; }, 0);
      engine.page(req, { page: 1, pageSize: 5 });
      engine.page(req, { page: 2, pageSize: 5 });
      ck.eq(source.calls.fetch.length, 2, "deux pages demandées");
      ck(source.calls.signals[0].aborted, "🎯 la page DEVANCÉE est ANNULÉE (AbortController — parité recherche)");
      source.pending[0].resolve({ rows: [{ id: "perime" }], total: 1, page: 1, pages: 1 });
      await tick(1);
      ck.eq(repaints, 0, "réponse périmée → aucun repeint");
      source.pending[1].resolve({ rows: [{ id: "frais" }], total: 9, page: 2, pages: 2 });
      await tick(1);
      ck.eq(engine.page(req, { page: 2, pageSize: 5 }).rows.map((r) => r.id).join(","), "frais", "la réponse FRAÎCHE, elle, s'applique");
      engine.reset();
    }

    // -- ÉCHEC : page vide assumée (aucun repli local possible), trace console, et AUCUNE boucle. --
    {
      const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
      try {
        const source = makePagedSource(true);
        const engine = new ListRowEngine(source, () => {}, 0);
        engine.page(req, { page: 1, pageSize: 5 });
        source.pending[0].reject(new Error("503"));
        await tick(1);
        ck.eq(warned, 1, "échec de page → une trace console (diagnostic volontaire), aucune UI d'erreur");
        ck.eq(engine.page(req, { page: 1, pageSize: 5 }).rows.length, 0, "échec → page vide (la collection n'est pas en cache : rien à replier)");
        ck.eq(source.calls.fetch.length, 1, "🎯 échec MÉMORISÉ : le rendu suivant ne reprogramme PAS la même page (pas de boucle)");
        engine.page(req, { page: 2, pageSize: 5 });
        ck.eq(source.calls.fetch.length, 2, "échec : une AUTRE page reste tentée (l'échec est propre à sa signature)");
        engine.reset();
      } finally { console.warn = warn; }
    }

    // -- Signature de page : découpe ET tri en font partie (pagination ORDONNÉE complète — l'ORDER BY
    //    redécoupe le corpus : changer de critère ou de direction EST une nouvelle demande serveur). --
    const sig = (p, s, sort) => ListRowEngine.pageSignature(req, { page: p, pageSize: s, sort: sort || null });
    ck(sig(1, 25) !== sig(2, 25), "pageSignature : changer de page est une AUTRE demande serveur");
    ck(sig(1, 25) !== sig(1, 50), "pageSignature : changer la taille de page aussi");
    ck.eq(sig(1, 25), sig(1, 25), "pageSignature : stable à état égal (sinon chaque rendu relancerait le réseau)");
    ck(sig(1, 25) !== sig(1, 25, { field: "name", dir: "asc" }),
      "🎯 pageSignature : poser un TRI serveur est une nouvelle demande (lot 1b — le pilote disait l'inverse, c'est levé)");
    ck(sig(1, 25, { field: "name", dir: "asc" }) !== sig(1, 25, { field: "name", dir: "desc" }),
      "pageSignature : changer la DIRECTION aussi (l'ORDER BY change)");
    ck(sig(1, 25, { field: "name", dir: "asc" }) !== sig(1, 25, { field: "email", dir: "asc" }),
      "pageSignature : changer le CHAMP aussi");
    ck.eq(sig(1, 25, { field: "name", dir: "asc" }), sig(1, 25, { field: "name", dir: "asc" }),
      "pageSignature : stable à tri égal");
    ck.eq(sig(1, 25), sig(1, 25, null),
      "pageSignature : sort absent (source d'avant le lot 1b) ≡ sort null — même identité, aucune relance");
  });

  await section("Lot 1b : ListServerSort — mapping critère de vue → champ serveur (+ sortField du pilote contacts)", async () => {
    const { ListServerSort } = D("core/ListServerSort.js");
    const columns = [
      { key: "name", sortField: "name" },
      { key: "org", sortField: "organization" },
      { key: "col5" },                              // colonne triable SANS champ serveur (accesseur dérivé)
      { key: "bad", sortField: "napas" },           // sortField FAUTIF (hors liste blanche)
      { key: "oper", sortField: "search" },         // sortField FAUTIF (colonne opérationnelle)
    ];

    // -- Critères INTRINSÈQUES : toujours mappables (colonnes d'audit de la liste blanche). --
    ck.eq(ListServerSort.fieldOf("contacts", "__created__", columns), "created_date",
      "🎯 __created__ → created_date (le critère « Date de création » ordonne le corpus, lui aussi)");
    ck.eq(ListServerSort.fieldOf("contacts", "__updated__", columns), "updated_date", "__updated__ → updated_date");

    // -- Colonnes : sortField déclaré → champ ; sans déclaration → null (repli « trier la page reçue »). --
    ck.eq(ListServerSort.fieldOf("contacts", "org", columns), "organization", "colonne à sortField → son champ du modèle");
    ck.eq(ListServerSort.fieldOf("contacts", "col5", columns), null, "colonne SANS sortField → null (repli assumé du pilote, documenté)");
    ck.eq(ListServerSort.fieldOf("contacts", "zzz", columns), null, "critère inconnu → null (état de session d'une autre version)");

    // -- Garde-fou par la liste blanche PARTAGÉE : un sortField mal déclaré DÉGRADE au lieu de 400 en boucle. --
    ck.eq(ListServerSort.fieldOf("contacts", "bad", columns), null,
      "🎯 sortField hors liste blanche → null : jamais envoyé au serveur (dégradation propre, pas de 400 à chaque page)");
    ck.eq(ListServerSort.fieldOf("contacts", "oper", columns), null, "sortField opérationnel (search) → refusé pareil");

    // -- `of` : le tri COMPLET (champ + direction suivant l'état de la vue). --
    ck.eq(JSON.stringify(ListServerSort.of("contacts", "name", "desc", columns)), JSON.stringify({ field: "name", dir: "desc" }),
      "of : champ mappé + direction de la vue");
    ck.eq(ListServerSort.of("contacts", "col5", "desc", columns), null, "of : critère non mappable → null");

    // -- PILOTE contacts : chaque sortField déclaré par ListConfigs.contacts EST dans la liste blanche
    //    (un nom fautif dégraderait SILENCIEUSEMENT vers le repli — c'est ce verrou qui le rend bruyant). --
    const { ListConfigs } = D("views/ListConfigs.js");
    const { ListOrder } = SHARED("src-shared/ListOrder.js");
    const contactColumns = ListConfigs.contacts(await makeStore()).columns;
    const declared = contactColumns.filter((c) => c.sortField).map((c) => c.sortField);
    ck.eq(declared.join(","), "name,organization,position,email,notes",
      "🎯 pilote : les colonnes triables du listing contacts déclarent TOUTES leur champ serveur (sauf Téléphone, non triable)");
    for (const field of declared) ck(ListOrder.isSortable("contacts", field), "sortField contacts « " + field + " » ∈ liste blanche partagée");
  });

};
