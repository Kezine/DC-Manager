/* Tests modules — VAGUE 3 du chantier « lazy-load des collections » : `wifiClients` chargée
   PARESSEUSEMENT en mode API (cf. docs/hydratation.md § « Vague 3 » et le cadrage
   `.notes/toDos/lazy-load-collections-cadrage-2026-08-11.md`).

   La vague 3 REJOUE le patron des vagues 1-2 (leurs fichiers verrouillent les gardes GÉNÉRIQUES :
   elles ne connaissent que l'état d'hydratation, jamais un nom de collection). Ce fichier verrouille
   ce qui est PROPRE à la vague — c'est-à-dire, pour l'essentiel, la garde G8 :

   1. la liste centrale ÉTENDUE (`core/LazyCollections`) et le boot qui saute les QUATRE collections ;
   2. 🚨 G8 côté PARTAGÉ (`src-shared/ListFacets`) : la LISTE BLANCHE des colonnes facettables dérivée
      de la spec, son INCLUSION dans la liste blanche de tri (même source), le `SELECT DISTINCT`
      golden et la barrière anti-injection ;
   3. G8 côté PUR CLIENT (`core/CollectionFacetCache`) : valeurs async servies en synchrone,
      déduplication, notification, invalidation, échec non mémorisé, normalisation, et surtout
      `withSelected` — la règle qui empêche la purge de `ListView` d'effacer un filtre restauré
      avant l'arrivée du relevé ;
   4. G8 côté STORE (`Store.facetValues`) : cache si la collection est hydratée (aucun réseau, mode
      fichier compris — principe n°15), `SELECT DISTINCT` serveur sinon, et les invalidations
      (création, suppression, MISE À JOUR — que les compteurs, eux, ignorent — et SSE sauté par G3) ;
   5. G8 côté SOURCE (`StoreListRowSource.facetOptions`) : c'est l'ÉTAT qui décide, et le mode fichier
      ne propose JAMAIS de facette serveur ;
   6. le listing `ListConfigs.wifiClients` : les `sortField` et les `filter.field` déclarés appartiennent
      aux listes blanches PARTAGÉES (un nom fautif dégraderait EN SILENCE vers le repli), et les colonnes
      à valeur DÉRIVÉE n'en déclarent aucun — à dessein.

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D, SHARED, Store, EntityRegistry, makeStore } = require("./harness.js");
const { LAZY_COLLECTIONS_API } = D("core/LazyCollections.js");
const { CollectionFacetCache } = D("core/CollectionFacetCache.js");
const { HydrationState } = D("core/HydrationState.js");
const { StoreListRowSource } = D("core/StoreListRowSource.js");
const { RecordSearchIndex } = D("core/RecordSearchIndex.js");

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Adaptateur API SIMULÉ de la vague 3 : mêmes principes que ceux des vagues 1-2 (fixtures par
   collection + JOURNAL des appels), étendu au chemin que la vague exerce — `facetValues`, dont on
   veut prouver CE QUI PART sur le réseau, et non seulement le résultat. */
function makeApiAdapter(collections, opts) {
  const options = opts || {};
  const data = {};
  for (const [name, rows] of Object.entries(collections || {})) data[name] = rows.map((r) => ({ ...r }));
  const calls = { load: [], list: [], count: [], facets: [], replaceAll: 0, transact: 0 };
  return {
    data, calls,
    async load(o) {
      const skip = (o && o.skipCollections) || [];
      calls.load.push(skip.slice());
      const snap = { meta: {} };
      for (const name of Object.keys(data)) if (skip.indexOf(name) === -1) snap[name] = data[name].map((r) => ({ ...r }));
      return snap;
    },
    async list(collection, o) {
      const options2 = o || {};
      calls.list.push({ collection, page: options2.page, pageSize: options2.pageSize });
      const rows = (data[collection] || []).map((r) => ({ ...r }));
      const pageSize = Math.max(1, options2.pageSize || 25);
      const total = rows.length, pages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(Math.max(1, options2.page || 1), pages);
      return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total, page, pages, pageSize };
    },
    async count(collection) { calls.count.push(collection); return (data[collection] || []).length; },
    /** Le `SELECT DISTINCT` du serveur, simulé sur les fixtures — DÉLIBÉRÉMENT rendu dans le
        désordre et avec un doublon : c'est le CLIENT qui normalise (règle unique, cf. la section). */
    async facetValues(collection, field) {
      calls.facets.push({ collection, field });
      if (options.facetFails) throw new Error("503");
      const values = (data[collection] || []).map((r) => String(r[field] == null ? "" : r[field])).filter(Boolean);
      return values.slice().reverse().concat(values.slice(0, 1));
    },
    async replaceAll() { calls.replaceAll++; return null; },
    async transact() { calls.transact++; return null; },
    async createOne(collection, record) { (data[collection] = data[collection] || []).push({ ...record }); return record; },
    async updateOne() { return null; },
    async saveMeta() { return null; },
  };
}

/** Fixtures d'un document SERVEUR (catalogues fermés tels que le CODE les sème — sinon `syncCatalogs`
    croit à une mise à jour et déclenche la persistance, cf. la vague 1) + les collections fournies. */
async function documentFixtures(extra) {
  const seeded = await makeStore();
  const snapshot = seeded.toJSON();
  const fixtures = {};
  for (const name of EntityRegistry.COLLECTIONS) fixtures[name] = snapshot[name] || [];
  for (const [name, rows] of Object.entries(extra || {})) fixtures[name] = rows;
  return fixtures;
}

/** Store en MODE API simulé, avec la liste lazy RÉELLE (celle que `main.ts` injecte). */
function apiStore(adapter) { return new Store(adapter, new HydrationState(), LAZY_COLLECTIONS_API); }

/** Quelques clients wifi de synchro : deux SSID, deux types, un champ vide, une casse mêlée. */
const WIFI_ROWS = [
  { id: "w1", name: "poste-01", mac: "aa:00", client_type: "WIRELESS", ssid: "Corp", ap_name: "AP-Hall" },
  { id: "w2", name: "",         mac: "bb:11", client_type: "WIRELESS", ssid: "Guest", ap_name: "AP-Hall" },
  { id: "w3", name: "impr-02",  mac: "cc:22", client_type: "WIRED",    ssid: "",      ap_name: "" },
  { id: "w4", name: "tel-03",   mac: "dd:33", client_type: "wireless", ssid: "Corp",  ap_name: "AP-R1" },
];

module.exports = async () => {

  await section("Vague 3 : la liste centrale s'étend à `wifiClients` (la plus VOLUMINEUSE)", async () => {
    ck.eq(LAZY_COLLECTIONS_API.join(","), "contacts,attachments,applications,wifiClients",
      "vague 3 : `wifiClients` rejoint les trois précédentes — c'est la DERNIÈRE vague exécutable du chantier");
    const unknown = LAZY_COLLECTIONS_API.filter((c) => EntityRegistry.COLLECTIONS.indexOf(c) === -1);
    ck.eq(unknown.join(","), "", "🎯 INVARIANT : chaque nom est une VRAIE collection — un nom fautif serait sans effet, en silence");
    ck(LAZY_COLLECTIONS_API.indexOf("vms") === -1, "`vms` reste EXCLUE du chantier (transverse : graphe, purge, certs, IPAM, bulle 3D)");

    const adapter = makeApiAdapter(await documentFixtures({ wifiClients: WIFI_ROWS }));
    const store = apiStore(adapter);
    await store.init();
    ck.eq(adapter.calls.load[0].slice().sort().join(","), "applications,attachments,contacts,wifiClients",
      "🎯 le chargement initial saute les QUATRE collections lazy (le plus gros gain du chantier est ici)");
    ck.eq(store.hydration.levelOf("wifiClients"), "none", "wifiClients : déclarée lazy APRÈS `_hydrate` (contrat du lot 0)");
    ck.eq(store.all("wifiClients").length, 0, "… et rien n'en est en cache");
    ck.eq(store.countHint("wifiClients"), 0, "sanité G6 : la pastille part de 0 (valeur inconnue) et déclenche son relevé");
    await tick(1);
    ck.eq(store.countHint("wifiClients"), 4, "… puis reflète le COUNT serveur (garde G6, déjà générique)");
  });

  await section("🚨 G8 partagé : ListFacets — liste blanche des colonnes facettables + SELECT DISTINCT", async () => {
    const { ListFacets } = SHARED("src-shared/ListFacets.js");
    const { ListOrder } = SHARED("src-shared/ListOrder.js");

    // -- DÉRIVATION depuis la spec : les champs `string`, dans l'ordre du schéma (attente EXPLICITE). --
    ck.eq(ListFacets.facetableColumns("wifiClients").join(","),
      "name,client_type,provider_id,ext_id,mac,ip,ssid,ap_mac,ap_name,connected_since,last_sync,notes,description,ap_equipment_id",
      "🎯 wifiClients : tous les champs de spec de type `string` — liste EXACTE, dérivée, jamais écrite à la main");

    // -- EXCLUSIONS, chacune prouvée sur un cas réel de la spec. --
    ck(!ListFacets.facetableColumns("wifiClients").includes("orphan"),
      "boolean (wifiClients.orphan) : EXCLU (deux cases à cocher n'apprennent rien qu'une colonne triable ne dise)");
    ck(!ListFacets.facetableColumns("attachments").includes("size"),
      "number (attachments.size) : EXCLU (autant de valeurs distinctes que de lignes)");
    ck(!ListFacets.facetableColumns("racks").includes("roof_cells") && !ListFacets.facetableColumns("racks").includes("door_front"),
      "string[] / json (racks) : EXCLUS (le DISTINCT porterait sur le JSON SÉRIALISÉ, pas sur les éléments)");
    for (const audit of ["created_date", "updated_date", "created_by", "updated_by"]) {
      ck(!ListFacets.isFacetable("wifiClients", audit), "colonne d'AUDIT « " + audit + " » : EXCLUE (une valeur par ligne)");
    }
    ck(!ListFacets.isFacetable("wifiClients", "id") && !ListFacets.isFacetable("wifiClients", "search"),
      "id / search : EXCLUS (clé opaque, colonne opérationnelle)");
    ck.eq(ListFacets.facetableColumns("inconnue").length, 0, "collection inconnue → liste vide (défensif : le nom vient d'une route)");
    ck(ListFacets.isFacetable("wifiClients", "ssid") && !ListFacets.isFacetable("wifiClients", "napas"),
      "isFacetable : champ de spec oui, champ inconnu non");

    // -- 🎯 INVARIANT DE COHÉRENCE : facettable ⊂ triable. Même source (la spec), deux dérivations —
    //    et l'inclusion est STRICTE (les colonnes numériques/booléennes/audit ne sont que triables). --
    for (const collection of EntityRegistry.COLLECTIONS) {
      const facetable = ListFacets.facetableColumns(collection);
      const stray = facetable.filter((f) => !ListOrder.isSortable(collection, f));
      ck.eq(stray.join(","), "", "invariant " + collection + " : toute colonne FACETTABLE est aussi TRIABLE (une seule source : la spec)");
    }
    ck(ListOrder.sortableColumns("wifiClients").length > ListFacets.facetableColumns("wifiClients").length,
      "🎯 … et l'inclusion est STRICTE (orphan + les 4 colonnes d'audit sont triables, pas facettables)");

    // -- SELECT DISTINCT : chaîne EXACTE écrite en clair (recette golden — jamais dérivée du module). --
    ck.eq(ListFacets.distinctSql("wifiClients", "ssid"),
      'SELECT DISTINCT "ssid" AS value FROM "wifiClients" WHERE "ssid" IS NOT NULL AND "ssid" <> \'\' ORDER BY 1 LIMIT ?',
      "🎯 DISTINCT sans COLLATE (sensible à la CASSE — replier « wireless »/« WIRELESS » donnerait un id qui ne matcherait que la moitié des lignes)");
    ck(/IS NOT NULL AND "ssid" <> ''/.test(ListFacets.distinctSql("wifiClients", "ssid")),
      "vides EXCLUS : parité du `if (v)` des options locales (« pas de valeur » n'est pas une option)");

    // -- BARRIÈRE anti-injection : hors liste → THROW, jamais d'interpolation silencieuse. --
    const throws = (fn) => { try { fn(); return null; } catch (e) { return String(e.message || e); } };
    ck(/colonne de facette invalide/.test(throws(() => ListFacets.distinctSql("wifiClients", 'ssid"; DROP TABLE wifiClients;--'))),
      "🎯 injection : un nom hors liste blanche est REFUSÉ (throw nommé), jamais interpolé");
    ck(/colonne de facette invalide/.test(throws(() => ListFacets.distinctSql("wifiClients", "orphan"))),
      "colonne non facettable (boolean) : refusée aussi — la liste blanche est la SEULE porte");
    ck(/colonne de facette invalide/.test(throws(() => ListFacets.distinctSql("inconnue", "ssid"))),
      "collection inconnue : rien n'y est facettable → refus");
    ck(ListFacets.VALUES_CAP > 0, "plafond de valeurs déclaré (cap ASSUMÉ, même esprit que SEARCH_ALL_LIMIT)");
  });

  await section("🚨 G8 pur : CollectionFacetCache — valeurs async servies en synchrone + `withSelected`", async () => {
    // -- NORMALISATION : vides écartées, doublons fondus, ordre `sort()` — la MÊME règle qu'en local. --
    ck.eq(CollectionFacetCache.normalize(["Zoé", "alpha", "", "Zoé", null, "Beta"]).join(","), "Beta,Zoé,alpha",
      "🎯 normalize : dédoublonné, vides écartés, ordre `Array.sort()` par défaut — identique aux options LOCALES");

    // -- 🚨 withSelected : une valeur SÉLECTIONNÉE figure TOUJOURS dans les options. C'est CE qui
    //    empêche la purge « option disparue » de ListView d'effacer un filtre restauré de la session
    //    pendant que le relevé serveur est encore en vol. --
    ck.eq(CollectionFacetCache.withSelected([], ["Guest"]).join(","), "Guest",
      "🎯 relevé PAS ENCORE arrivé + filtre restauré → la valeur sélectionnée EST une option (sinon ListView la purgerait, en silence)");
    ck.eq(CollectionFacetCache.withSelected(["Corp", "Guest"], ["Guest"]).join(","), "Corp,Guest",
      "valeur déjà connue : aucune duplication");
    ck.eq(CollectionFacetCache.withSelected(["Corp"], []).join(","), "Corp", "sélection vide : aucune option fantôme");

    // -- Valeur async servie en SYNCHRONE + déduplication des relevés en vol. --
    let resolveLoad = null;
    const loads = [];
    const cache = new CollectionFacetCache(
      (collection, field) => { loads.push(collection + "." + field); return new Promise((r) => { resolveLoad = r; }); },
      (collection, field) => { cache.lastNotified = collection + "." + field; },
    );
    ck.eq(cache.peek("wifiClients", "ssid"), null, "peek : rien de connu, et surtout AUCUN relevé déclenché (lecture pure)");
    ck.eq(loads.length, 0, "… prouvé : peek n'a rien demandé");
    ck.eq(cache.values("wifiClients", "ssid").length, 0, "values : liste VIDE en attendant (le rendu ne peut pas attendre)");
    cache.values("wifiClients", "ssid"); cache.values("wifiClients", "ssid");
    ck.eq(loads.length, 1, "🎯 déduplication : trois demandes rapprochées ne tirent QU'UNE requête");
    ck.eq(cache.pendingCount, 1, "… une seule en vol");
    resolveLoad(["Guest", "Corp", "Corp", ""]);
    await tick(1);
    ck.eq(cache.values("wifiClients", "ssid").join(","), "Corp,Guest", "à l'arrivée : valeurs NORMALISÉES servies en synchrone");
    ck.eq(cache.lastNotified, "wifiClients.ssid", "🎯 l'hôte est PRÉVENU (collection + champ) : c'est le seul moment où la valeur atteint l'écran");
    ck.eq(loads.length, 1, "valeur en cache → aucun nouveau relevé");

    // -- Facettes d'une MÊME collection : clés distinctes, invalidation par COLLECTION. --
    cache.values("wifiClients", "client_type");
    ck.eq(loads.length, 2, "un relevé PAR CHAMP (deux facettes d'un même listing sont deux requêtes)");
    cache.invalidate(["contacts"]);
    ck.eq(cache.values("wifiClients", "ssid").join(","), "Corp,Guest", "invalidation d'une AUTRE collection : sans effet");
    cache.invalidate(["wifiClients"]);
    ck.eq(cache.peek("wifiClients", "ssid"), null, "🎯 invalidation : TOUTES les facettes de la collection sont oubliées (une valeur a pu changer)");

    // -- ÉCHEC : rien n'est mis en cache, aucune exception ne fuit, la demande suivante retente. --
    const failing = new CollectionFacetCache(() => Promise.reject(new Error("503")));
    ck.eq(failing.values("wifiClients", "ssid").length, 0, "échec en vol → options vides, aucune UI d'erreur");
    await tick(1);
    ck.eq(failing.peek("wifiClients", "ssid"), null, "🎯 un échec n'est PAS mémorisé (une panne réseau ne fige pas un filtre vide pour la session)");
    ck.eq(failing.pendingCount, 0, "… et le vol est bien retiré (le prochain rendu retentera)");
  });

  await section("🚨 G8 Store : facetValues — cache si hydratée, DISTINCT serveur sinon, invalidations", async () => {
    const adapter = makeApiAdapter(await documentFixtures({ wifiClients: WIFI_ROWS, equipments: [{ id: "e1", name: "SRV37" }] }));
    const store = apiStore(adapter);
    await store.init();

    // -- Collection LAZY : le balayage local MENTIRAIT (cache vide) — c'est ce que G8 corrige. --
    ck.eq(store.all("wifiClients").length, 0, "sanité : aucune ligne en cache, le calcul « sur-page » ne proposerait RIEN");
    ck.eq(store.facetValues("wifiClients", "ssid").length, 0, "premier appel : vide (synchrone), et le relevé est déclenché");
    await tick(1);
    ck.eq(store.facetValues("wifiClients", "ssid").join(","), "Corp,Guest",
      "🎯 les valeurs viennent du DISTINCT serveur : le CORPUS entier, pas les pages parcourues");
    ck.eq(adapter.calls.facets[0].collection + "." + adapter.calls.facets[0].field, "wifiClients.ssid", "… relevé sur la collection et le champ demandés");
    ck.eq(store.facetValues("wifiClients", "client_type").length, 0, "autre facette : son propre relevé");
    await tick(1);
    ck.eq(store.facetValues("wifiClients", "client_type").join(","), "WIRED,WIRELESS,wireless",
      "🎯 DISTINCT sensible à la CASSE : « wireless » et « WIRELESS » restent DEUX options (le filtre matche par égalité exacte)");
    ck.eq(adapter.calls.facets.length, 2, "deux facettes = deux relevés, et pas un de plus");

    // -- INVALIDATIONS. Une MISE À JOUR invalide les facettes (une valeur de colonne a changé) alors
    //    qu'elle laisse les COMPTEURS intacts : les deux caches ne périment pas pour les mêmes raisons. --
    await store.update("equipments", "e1", { description: "x" });
    ck.eq(store.facetValues("wifiClients", "ssid").join(","), "Corp,Guest", "une écriture sur une AUTRE collection ne touche pas ces facettes");
    // Écriture SUR la collection lazy : on passe par l'API publique d'invalidation (le chemin qu'empruntent
    // create/update/remove) — la valeur est oubliée, et le prochain accès la relève.
    store.invalidateFacets(["wifiClients"]);
    ck.eq(store.facetValues("wifiClients", "ssid").length, 0, "🎯 invalidée : la valeur est oubliée…");
    await tick(1);
    ck.eq(adapter.calls.facets.length, 3, "… et RE-RELEVÉE au prochain accès (invalider n'est pas recharger : c'est le rendu qui redemande)");

    // -- Événement SSE SAUTÉ par G3 (une passe de synchro wifi chez le serveur) : les facettes sont
    //    invalidées avec les compteurs — un SSID inédit doit pouvoir apparaître. --
    adapter.data.wifiClients.push({ id: "w9", name: "neuf", mac: "ee:44", client_type: "WIRELESS", ssid: "IoT", ap_name: "AP-R1" });
    const reloaded = await store.reloadCollections(["wifiClients"]);
    ck.eq(reloaded.length, 0, "sanité G3 : la collection lazy n'est PAS re-tirée (le lazy resterait sinon lettre morte)");
    ck.eq(store.facetValues("wifiClients", "ssid").length, 0, "🎯 mais ses FACETTES sont invalidées (une synchro peut introduire un SSID inédit)");
    await tick(1);
    ck.eq(store.facetValues("wifiClients", "ssid").join(","), "Corp,Guest,IoT", "… et le relevé suivant voit la nouveauté");

    // -- Collection HYDRATÉE : balayage du CACHE, plus AUCUN aller-retour (retour au régime local). --
    await store.hydrate(["wifiClients"]);
    const before = adapter.calls.facets.length;
    ck.eq(store.facetValues("wifiClients", "ssid").join(","), "Corp,Guest,IoT", "collection redevenue `full` : mêmes valeurs…");
    ck.eq(adapter.calls.facets.length, before, "🎯 … calculées sur le CACHE, sans réseau (c'est l'ÉTAT qui décide, pas un nom)");
    ck.eq(store.facetValues("wifiClients", "ap_name").join(","), "AP-Hall,AP-R1",
      "balayage local : vides écartés et doublons fondus — la MÊME normalisation que le chemin serveur");

    // -- MODE FICHIER : tout est `full` PAR CONSTRUCTION → jamais de réseau (principe n°15). --
    const fileAdapter = makeApiAdapter(await documentFixtures({ wifiClients: WIFI_ROWS }));
    const fileStore = new Store(fileAdapter, null, LAZY_COLLECTIONS_API);   // injection NULLE = mode fichier
    await fileStore.init();
    ck.eq(fileStore.facetValues("wifiClients", "ssid").join(","), "Corp,Guest", "mode fichier : les options sortent du cache…");
    ck.eq(fileAdapter.calls.facets.length, 0, "🎯 mode fichier : AUCUN relevé réseau — aucun écart de comportement (principe n°15)");
  });

  await section("G8 source : StoreListRowSource.facetOptions — l'ÉTAT décide, le mode fichier s'abstient", async () => {
    const adapter = makeApiAdapter(await documentFixtures({ wifiClients: WIFI_ROWS }));
    const store = apiStore(adapter);
    await store.init();
    const index = new RecordSearchIndex((c, id) => store.get(c, id), (c, f, v) => store.findByField(c, f, v));
    const reader = { list: () => Promise.resolve([]), page: () => Promise.resolve({ rows: [], total: 0, page: 1, pages: 1 }) };

    const apiSource = new StoreListRowSource(store, index, null, reader);
    ck(Array.isArray(apiSource.facetOptions("wifiClients", "ssid")), "🎯 collection NON hydratée + mode API → facettes SERVEUR (tableau, vide en attendant)");
    await tick(1);
    ck.eq(apiSource.facetOptions("wifiClients", "ssid").join(","), "Corp,Guest", "… servies dès l'arrivée du relevé");
    ck.eq(apiSource.facetOptions("equipments", "name"), null,
      "collection HYDRATÉE → `null` : la vue garde ses options LOCALES, inchangées (« pas un pixel » sur 20+ listings)");

    // Mode FICHIER (aucun lecteur serveur injecté) : jamais de facette serveur, quoi qu'il arrive.
    ck.eq(new StoreListRowSource(store, index, null, null).facetOptions("wifiClients", "ssid"), null,
      "🎯 mode fichier (aucun lecteur) : `null` toujours — les options locales y sont exactes par construction");

    // C'est l'ÉTAT qui décide : une collection lazy REDEVENUE full repasse en options locales.
    await store.hydrate(["wifiClients"]);
    ck.eq(apiSource.facetOptions("wifiClients", "ssid"), null, "🎯 collection redevenue `full` → retour immédiat aux options locales");
  });

  await section("Vague 3 : le listing wifiClients — `sortField` et `filter.field` ∈ listes blanches partagées", async () => {
    const { ListConfigs } = D("views/ListConfigs.js");
    const { ListOrder } = SHARED("src-shared/ListOrder.js");
    const { ListFacets } = SHARED("src-shared/ListFacets.js");
    const store = await makeStore();
    const columns = ListConfigs.wifiClients(store).columns;

    // -- TRI serveur : seules les colonnes à accesseur SCALAIRE déclarent leur champ. --
    const declared = columns.filter((c) => c.sortField).map((c) => c.sortField);
    ck.eq(declared.join(","), "mac,ssid,connected_since",
      "wifiClients : les trois colonnes dont l'accesseur `sort` lit UN champ scalaire du modèle");
    for (const field of declared) ck(ListOrder.isSortable("wifiClients", field), "sortField « " + field + " » ∈ liste blanche partagée (sinon dégradation SILENCIEUSE)");

    const noField = (key) => ck.eq(columns.filter((c) => c.sortKey === key)[0].sortField, undefined, "colonne « " + key + " » : PAS de sortField (repli assumé, documenté)");
    noField("name");   // displayName = nom SINON MAC : aucune colonne SQL ne porte cette expression
    noField("type");   // présence PUIS type : deux colonnes
    noField("ip");     // Ip.toInt : ordre NUMÉRIQUE, la colonne est du TEXT
    noField("ap");     // nom d'ÉQUIPEMENT résolu par jointure cliente

    // -- FACETTES serveur (G8) : même discipline, autre liste blanche. --
    const facetCols = columns.filter((c) => c.filter);
    ck.eq(facetCols.map((c) => c.sortKey).join(","), "type,ssid,ap", "sanité : le listing a bien TROIS facettes de colonne");
    const facetFields = facetCols.filter((c) => c.filter.field).map((c) => c.filter.field);
    ck.eq(facetFields.join(","), "client_type,ssid",
      "🎯 seules les facettes dont `valueOf` lit un champ SCALAIRE basculent sur le DISTINCT serveur");
    for (const field of facetFields) ck(ListFacets.isFacetable("wifiClients", field), "filter.field « " + field + " » ∈ liste blanche partagée des facettes");
    ck.eq(facetCols.filter((c) => c.sortKey === "ap")[0].filter.field, undefined,
      "🎯 « Point d'accès » n'en déclare PAS : sa valeur est un nom d'ÉQUIPEMENT résolu par jointure cliente — un DISTINCT sur `ap_name` proposerait des valeurs que la colonne n'affiche pas");

    // -- Les AUTRES listings ne déclarent AUCUNE facette serveur : la vague 3 ne touche qu'à wifi. --
    const contactsFacets = ListConfigs.contacts(store).columns.filter((c) => c.filter && c.filter.field);
    ck.eq(contactsFacets.length, 0,
      "🎯 contacts GARDE son calcul « sur-page » de la vague 1 (arbitrage n°4 : le DISTINCT serveur est pour les VOLUMINEUSES)");
    const vmsFacets = ListConfigs.vms(store).columns.filter((c) => c.filter && c.filter.field);
    ck.eq(vmsFacets.length, 0, "vms n'est pas lazy (EXCLUE du chantier) : ses facettes restent locales, inchangées");
  });

};
