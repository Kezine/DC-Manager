/* Tests modules — VAGUE 2 du chantier « lazy-load des collections » : `attachments` + `applications`
   chargées PARESSEUSEMENT en mode API (cf. docs/hydratation.md § « Vague 2 » et le cadrage
   `.notes/toDos/lazy-load-collections-cadrage-2026-08-11.md`).

   La vague 2 REJOUE le patron du pilote (test-lazy-contacts.js verrouille, lui, les gardes GÉNÉRIQUES
   G1-G4/G6/G8-G9 : elles ne connaissent que l'état d'hydratation, jamais un nom de collection). Ce
   fichier verrouille ce qui est PROPRE à la vague :

   1. la liste centrale ÉTENDUE (`core/LazyCollections`) et l'invariant « ce sont de vraies
      collections » — puis le boot qui saute effectivement les deux nouvelles ;
   2. G7 — les JUMEAUX ASYNC des relations de section de fiche (`Store.attachmentsOf*Async`,
      `applicationsOf*Async`) : cache si la collection est hydratée (aucun réseau, mode fichier
      compris — principe n°15), lecture par FK indexée sinon, ABSORPTION des lignes reçues (la fiche
      de la pièce s'ouvre ensuite normalement) et TRI identique aux jumeaux synchrones ;
   3. G5 — l'APERÇU DE CASCADE : le critère de bascule local ⇄ serveur (`Store.cascadePreviewAsync`),
      ses replis (adaptateur sans aperçu serveur, sélection vide) et le fait que le mode fichier ne
      part JAMAIS sur le réseau ;
   4. M4 — la purge, au cache, de la cascade RÉSIDUELLE rapportée par le serveur (sans quoi une pièce
      jointe supprimée par cascade resterait affichée, et le compteur de sa pastille périmé) ;
   5. les `sortField` déclarés par les deux listings (pagination ORDONNÉE complète, lot 1b) : ils
      doivent appartenir à la liste blanche PARTAGÉE, sinon ils dégraderaient EN SILENCE vers le repli.

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D, SHARED, Store, EntityRegistry, makeStore } = require("./harness.js");
const { LAZY_COLLECTIONS_API } = D("core/LazyCollections.js");
const { HydrationState } = D("core/HydrationState.js");

/* Adaptateur API SIMULÉ de la vague 2 : mêmes principes que celui de la vague 1 (fixtures par
   collection + JOURNAL des appels), étendu aux chemins que la vague exerce — `findBy` (les sections
   de fiches), `cascadePreview` (G5) et un `transact` qui rapporte une cascade RÉSIDUELLE (M4). */
function makeApiAdapter(collections, opts) {
  const options = opts || {};
  const data = {};
  for (const [name, rows] of Object.entries(collections || {})) data[name] = rows.map((r) => ({ ...r }));
  const calls = { load: [], list: [], findBy: [], count: [], preview: [], transact: [], replaceAll: 0 };
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
    async findBy(collection, field, value) {
      calls.findBy.push({ collection, field, value });
      return (data[collection] || []).filter((r) => r[field] === value).map((r) => ({ ...r }));
    },
    async count(collection) { calls.count.push(collection); return (data[collection] || []).length; },
    async cascadePreview(collection, ids) {
      calls.preview.push({ collection, ids: [...ids] });
      return options.preview || { deletes: [], detaches: [] };
    },
    async transact(tx) { calls.transact.push(tx); return options.transactResult || null; },
    async replaceAll() { calls.replaceAll++; return null; },
    async createOne(collection, record) { (data[collection] = data[collection] || []).push({ ...record }); return record; },
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

module.exports = async () => {

  await section("Vague 2 : la liste centrale s'étend à `attachments` + `applications`", async () => {
    ck.eq(LAZY_COLLECTIONS_API.join(","), "contacts,attachments,applications",
      "vague 2 : les deux collections rejoignent le pilote (la vague 3 ajoutera `wifiClients` ICI)");
    const unknown = LAZY_COLLECTIONS_API.filter((c) => EntityRegistry.COLLECTIONS.indexOf(c) === -1);
    ck.eq(unknown.join(","), "", "🎯 INVARIANT : chaque nom est une VRAIE collection — un nom fautif serait sans effet, en silence");
    ck(LAZY_COLLECTIONS_API.indexOf("vms") === -1, "`vms` reste EXCLUE du chantier (transverse : graphe, purge, certs, IPAM, bulle 3D)");

    const adapter = makeApiAdapter(await documentFixtures({
      attachments: [{ id: "a1", name: "Convention", equipment_id: "e1" }],
      applications: [{ id: "app1", name: "GLPI", equipment_id: "e1" }],
    }));
    const store = apiStore(adapter);
    await store.init();
    ck.eq(adapter.calls.load[0].slice().sort().join(","), "applications,attachments,contacts",
      "🎯 le chargement initial saute les TROIS collections lazy (c'est là que le coût du boot disparaît)");
    ck.eq(store.hydration.levelOf("attachments"), "none", "attachments : déclarée lazy APRÈS `_hydrate` (contrat du lot 0)");
    ck.eq(store.hydration.levelOf("applications"), "none", "applications : idem");
    ck.eq(store.all("attachments").length + store.all("applications").length, 0, "… et rien des deux n'est en cache");
  });

  await section("G7 : jumeaux ASYNC des sections de fiche — cache si hydratée, FK indexée sinon", async () => {
    const adapter = makeApiAdapter(await documentFixtures({
      attachments: [
        { id: "a2", name: "Zébulon", equipment_id: "e1" },
        { id: "a1", name: "Convention", equipment_id: "e1" },
        { id: "a3", name: "Garantie", sub_equipment_id: "se1" },
      ],
      applications: [
        { id: "app2", name: "Zabbix", vm_id: "vm1" },
        { id: "app1", name: "GLPI", equipment_id: "e1" },
      ],
    }));
    const store = apiStore(adapter);
    await store.init();

    // -- Collection LAZY : la lecture SYNCHRONE ment (cache vide) — c'est le mensonge que G7 corrige. --
    ck.eq(store.attachmentsOfEquipment("e1").length, 0, "sanité : le helper SYNCHRONE rendrait une section VIDE (cache non chargé)");

    const rows = await store.attachmentsOfEquipmentAsync("e1");
    ck.eq(rows.map((r) => r.name).join(","), "Convention,Zébulon",
      "🎯 le jumeau ASYNC va chercher les lignes par FK indexée — et les rend TRIÉES comme le jumeau synchrone");
    ck.eq(adapter.calls.findBy[0].field, "equipment_id", "… par un `findBy` sur la FK (exactement la requête que pose la section)");
    ck(!!store.get("attachments", "a1"), "🎯 les lignes reçues sont ABSORBÉES et INDEXÉES : la fiche de la pièce s'ouvrira normalement");
    ck.eq(store.hydration.levelOf("attachments"), "partial", "l'absorption fait passer la collection de `none` à `partial`");

    ck.eq((await store.attachmentsOfSubEquipmentAsync("se1")).map((r) => r.name).join(","), "Garantie", "pièces jointes d'un SOUS-ÉQUIPEMENT (FK distincte)");
    ck.eq((await store.applicationsOfEquipmentAsync("e1")).map((r) => r.name).join(","), "GLPI", "applications hébergées sur un ÉQUIPEMENT");
    ck.eq((await store.applicationsOfVmAsync("vm1")).map((r) => r.name).join(","), "Zabbix", "applications hébergées sur une VM");

    // -- Collection HYDRATÉE : plus AUCUN réseau, le cache fait foi (retour au régime local). --
    await store.hydrate(["attachments"]);
    const before = adapter.calls.findBy.length;
    const local = await store.attachmentsOfEquipmentAsync("e1");
    ck.eq(local.map((r) => r.name).join(","), "Convention,Zébulon", "collection redevenue `full` : même liste…");
    ck.eq(adapter.calls.findBy.length, before, "🎯 … servie par le CACHE, sans aller-retour (c'est l'ÉTAT qui décide, pas un nom)");

    // -- MODE FICHIER : promesse résolue sur le cache, JAMAIS de réseau (principe n°15). --
    const fileAdapter = makeApiAdapter(await documentFixtures({ attachments: [{ id: "a9", name: "Locale", equipment_id: "e1" }] }));
    const fileStore = new Store(fileAdapter, null, LAZY_COLLECTIONS_API);   // injection NULLE = mode fichier
    await fileStore.init();
    ck.eq((await fileStore.attachmentsOfEquipmentAsync("e1")).map((r) => r.name).join(","), "Locale", "mode fichier : la section s'alimente au cache…");
    ck.eq(fileAdapter.calls.findBy.length, 0, "🎯 mode fichier : AUCUN `findBy` réseau — aucun écart de comportement (principe n°15)");
  });

  await section("🚨 G5 : cascadePreviewAsync — corpus complet → plan LOCAL, corpus partiel → plan SERVEUR", async () => {
    const fixtures = await documentFixtures({
      applications: [{ id: "app1", name: "GLPI", vm_id: "vm1" }],
      vms: [{ id: "vm1", name: "srv-01" }],
      ipAddresses: [{ id: "ip1", address: "10.0.0.9", vm_id: "vm1" }],
    });
    const serverPlan = { deletes: [], detaches: [{ c: "ipAddresses", id: "ip1", key: "vm_id", value: null }, { c: "applications", id: "app1", key: "vm_id", value: null }] };
    const adapter = makeApiAdapter(fixtures, { preview: serverPlan });
    const store = apiStore(adapter);
    await store.init();

    // -- Sélection VIDE : aucun aller-retour (la modale s'ouvre sans rien cocher). --
    const empty = await store.cascadePreviewAsync("vms", []);
    ck.eq(empty.deletes.length + empty.detaches.length, 0, "sélection vide → plan vide…");
    ck.eq(adapter.calls.preview.length, 0, "🎯 … sans le moindre aller-retour");

    // -- Corpus PARTIEL (des collections lazy non chargées) : le SERVEUR fait autorité. --
    ck(!store.hydration.isFullyHydrated(), "sanité : le corpus n'est pas complet (collections lazy déclarées)");
    const remote = await store.cascadePreviewAsync("vms", ["vm1"]);
    ck.eq(adapter.calls.preview.length, 1, "🎯 corpus PARTIEL → l'aperçu part au SERVEUR (le plan local sous-estimerait)");
    ck.eq(adapter.calls.preview[0].collection + ":" + adapter.calls.preview[0].ids.join(","), "vms:vm1", "… avec la collection et les ids demandés");
    ck.eq(remote.detaches.length, 2, "le plan SERVEUR est rendu tel quel (même forme que le plan local — interchangeables)");
    ck(remote.detaches.some((d) => d.c === "applications"),
      "🎯 il porte l'application détachée que le cache client N'AURAIT PAS VUE (elle n'a jamais été absorbée)");

    // -- Ids DÉDUPLIQUÉS et non filtrés sur le cache : sur corpus partiel, « absent du cache » ≠ « inexistant ». --
    await store.cascadePreviewAsync("vms", ["vm1", "vm1", "vmX"]);
    ck.eq(adapter.calls.preview[1].ids.join(","), "vm1,vmX", "ids dédupliqués, mais AUCUN filtre sur le cache (le serveur fait autorité)");

    // -- Corpus COMPLET : plan LOCAL, aucun réseau (le chemin du mode fichier, et celui d'après un export). --
    await store.hydrateAll();
    const before = adapter.calls.preview.length;
    const local = await store.cascadePreviewAsync("vms", ["vm1"]);
    ck.eq(adapter.calls.preview.length, before, "🎯 corpus COMPLET → plan LOCAL, aucun aller-retour");
    ck.eq(local.detaches.filter((d) => d.c === "applications").length, 1, "… et il est JUSTE (tout est en cache, la cascade partagée le prouve)");

    // -- MODE FICHIER : l'état inerte est toujours « tout full » → jamais de réseau, par CONSTRUCTION. --
    const fileAdapter = makeApiAdapter(fixtures, { preview: serverPlan });
    const fileStore = new Store(fileAdapter, null, LAZY_COLLECTIONS_API);
    await fileStore.init();
    const filePlan = await fileStore.cascadePreviewAsync("vms", ["vm1"]);
    ck.eq(fileAdapter.calls.preview.length, 0, "🎯 mode fichier : l'aperçu reste LOCAL, toujours (principe n°15)");
    ck.eq(filePlan.detaches.length, 2, "… et complet : le document EST le fichier");

    // -- Adaptateur SANS aperçu serveur (contrat par DÉFAUT de `DataAdapter` : rend `null`) : repli LOCAL. --
    const legacyAdapter = makeApiAdapter(fixtures);
    legacyAdapter.cascadePreview = async () => null;
    const legacyStore = apiStore(legacyAdapter);
    await legacyStore.init();
    const fallback = await legacyStore.cascadePreviewAsync("vms", ["vm1"]);
    ck.eq(fallback.detaches.filter((d) => d.c === "ipAddresses").length, 1,
      "🎯 aperçu serveur indisponible → repli sur le plan LOCAL (jamais d'erreur, jamais d'aperçu vide)");
  });

  await section("M4 : la cascade RÉSIDUELLE du serveur est PURGÉE du cache client", async () => {
    const fixtures = await documentFixtures({
      equipments: [{ id: "e1", name: "SRV37" }],
      attachments: [{ id: "a1", name: "Convention", equipment_id: "e1" }, { id: "a2", name: "Garantie", equipment_id: "e1" }],
    });
    // Le serveur rapporte avoir supprimé une pièce que le client N'AVAIT PAS dans son plan (jamais
    // absorbée, ou copie périmée parce que G3 a sauté le rechargement SSE de la collection).
    const adapter = makeApiAdapter(fixtures, { transactResult: { residual: { deletes: [{ collection: "attachments", id: "a2" }], updates: [] } } });
    const store = apiStore(adapter);
    await store.init();

    // Une seule pièce est absorbée au cache (l'utilisateur a ouvert la fiche de l'équipement).
    await store.attachmentsOfEquipmentAsync("e1");
    adapter.data.attachments = adapter.data.attachments.filter((a) => a.id !== "a2");   // état serveur après la cascade
    ck(!!store.get("attachments", "a2"), "sanité : la pièce absorbée est bien au cache avant la suppression");

    await store.remove("equipments", "e1");
    ck.eq(store.get("attachments", "a2"), null,
      "🎯 M4 : la pièce supprimée par le RÉSIDU serveur disparaît du cache (sinon elle resterait affichée jusqu'au F5)");
    ck.eq(store.all("attachments").some((a) => a.id === "a2"), false, "… retirée aussi de la collection servie par `all` (et de ses index)");
    ck.eq(store.countHint("attachments"), 0, "🎯 son COMPTE est invalidé : la pastille d'onglet ne reste pas sur une valeur périmée");

    // Aucun résidu (cas nominal) / adaptateur muet (mode fichier) : NO-OP strict, aucune exception.
    const quiet = makeApiAdapter(await documentFixtures({ equipments: [{ id: "e9", name: "X" }] }));
    const quietStore = apiStore(quiet);
    await quietStore.init();
    await quietStore.remove("equipments", "e9");
    ck.eq(quietStore.get("equipments", "e9"), null, "sans résidu rapporté : la suppression se comporte exactement comme avant");
  });

  await section("Vague 2 : `sortField` des deux listings (pagination ORDONNÉE complète, lot 1b)", async () => {
    const { ListConfigs } = D("views/ListConfigs.js");
    const { ListOrder } = SHARED("src-shared/ListOrder.js");
    const store = await makeStore();

    const appColumns = ListConfigs.applications(store, null).columns;
    const appDeclared = appColumns.filter((c) => c.sortField).map((c) => c.sortField);
    ck.eq(appDeclared.join(","), "name,url,description", "applications : les colonnes à champ scalaire déclarent leur champ serveur");
    ck.eq(appColumns.filter((c) => c.sortKey === "host")[0].sortField, undefined,
      "🎯 « Hébergée sur » n'en déclare PAS : elle trie un nom RÉSOLU par jointure cliente (repli assumé, documenté)");

    const attColumns = ListConfigs.attachments(store, null).columns;
    const attDeclared = attColumns.filter((c) => c.sortField).map((c) => c.sortField);
    ck.eq(attDeclared.join(","), "name,file_name,size,description", "attachments : idem, `size` comprise (colonne NUMÉRIQUE — ordre naturel côté SQL)");
    ck.eq(attColumns.filter((c) => c.sortKey === "target")[0].sortField, undefined, "« Attachée à » : même repli assumé que « Hébergée sur »");

    // Un `sortField` fautif dégraderait EN SILENCE vers le repli : c'est ce verrou qui le rend bruyant.
    for (const field of appDeclared) ck(ListOrder.isSortable("applications", field), "sortField applications « " + field + " » ∈ liste blanche partagée");
    for (const field of attDeclared) ck(ListOrder.isSortable("attachments", field), "sortField attachments « " + field + " » ∈ liste blanche partagée");
  });

};
