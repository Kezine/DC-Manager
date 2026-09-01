/* Tests modules — VAGUE 4 du chantier « lazy-load des collections » : `spares` chargée PARESSEUSEMENT
   en mode API (cf. docs/hydratation.md § « Vague 4 » et le cadrage
   `.notes/toDos/lazy-load-collections-cadrage-2026-08-11.md`).

   La vague 4 REJOUE le patron des vagues 1-3 (leurs fichiers verrouillent les gardes GÉNÉRIQUES :
   elles ne connaissent que l'état d'hydratation, jamais un nom de collection) et livre les DEUX
   chaînons qui la rendaient sûre (doctrine utilisateur 2026-08-13 : « async par cohérence, hydraté =
   ce que le 3D consomme »). Ce fichier verrouille ce qui est PROPRE à la vague :

   1. la liste centrale ÉTENDUE (`core/LazyCollections`) — c'est ICI que son CONTENU EXACT est
      verrouillé (délégation des vagues 2-3 au dernier fichier à l'avoir étendue) — et le boot qui
      saute les CINQ collections ;
   2. 🚨 M4b — les MISES À JOUR résiduelles du serveur (`residual.updates` d'un /transact) sont
      désormais CONSOMMÉES : refetch GROUPÉ par collection, absorption (un enregistrement inconnu
      entre au cache), RAFRAÎCHISSEMENT (une copie périmée est écrasée par la vérité serveur), et un
      échec réseau ne casse JAMAIS l'écriture. C'est le chaînon qui rend `spares` lazy-able : la
      cascade custom `equipments` DÉTACHE les spares côté serveur, et le cache doit l'apprendre ;
   3. la logique PURE de la résolution GROUPÉE des libellés de cibles (`core/TargetLabelResolution`) :
      partition des ids ABSENTS du cache par collection, dédoublonnage, famille inconnue ignorée —
      celle qui REMPLACE l'hydratation en masse d'`applications` posée en vague 2 ;
   4. G7 — le jumeau ASYNC `Store.sparesOfEquipmentAsync` (FK indexée, absorption, tri IDENTIQUE au
      jumeau synchrone, mode fichier sans réseau) ;
   5. le `sortField` du listing spares (pagination ORDONNÉE complète, lot 1b) : la SEULE colonne à
      champ scalaire le déclare, les colonnes DÉRIVÉES n'en déclarent aucun — à dessein.

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D, SHARED, Store, EntityRegistry, makeStore } = require("./harness.js");
const { LAZY_COLLECTIONS_API } = D("core/LazyCollections.js");
const { HydrationState } = D("core/HydrationState.js");
const { TargetLabelResolution } = D("core/TargetLabelResolution.js");

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Adaptateur API SIMULÉ de la vague 4 : mêmes principes que ceux des vagues 1-3 (fixtures par
   collection + JOURNAL des appels), étendu aux chemins que la vague exerce — `getOne`/`getMany`
   (l'absorption unitaire et le refetch GROUPÉ de M4b) et un `transact` qui rapporte des MISES À JOUR
   résiduelles. `getManyFails` simule la panne réseau du refetch. */
function makeApiAdapter(collections, opts) {
  const options = opts || {};
  const data = {};
  for (const [name, rows] of Object.entries(collections || {})) data[name] = rows.map((r) => ({ ...r }));
  const calls = { load: [], list: [], findBy: [], getMany: [], count: [], transact: [], replaceAll: 0 };
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
    async getOne(collection, id) {
      const row = (data[collection] || []).find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    async getMany(collection, ids) {
      calls.getMany.push({ collection, ids: ids.slice() });
      if (options.getManyFails) throw new Error("503");
      return (data[collection] || []).filter((r) => ids.indexOf(r.id) !== -1).map((r) => ({ ...r }));
    },
    async count(collection) { calls.count.push(collection); return (data[collection] || []).length; },
    async facetValues() { return []; },
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

  await section("Vague 4 : la liste centrale s'étend à `spares` — contenu EXACT verrouillé ici", async () => {
    ck.eq(LAZY_COLLECTIONS_API.join(","), "contacts,attachments,applications,wifiClients,spares",
      "🎯 vagues 1 à 4 : le contenu EXACT de la liste (ce fichier est le dernier à l'avoir étendue)");
    const unknown = LAZY_COLLECTIONS_API.filter((c) => EntityRegistry.COLLECTIONS.indexOf(c) === -1);
    ck.eq(unknown.join(","), "", "🎯 INVARIANT : chaque nom est une VRAIE collection — un nom fautif serait sans effet, en silence");
    ck(LAZY_COLLECTIONS_API.indexOf("vms") === -1, "`vms` reste EXCLUE du chantier (transverse : graphe, purge, certs, IPAM, bulle 3D)");

    const adapter = makeApiAdapter(await documentFixtures({
      spares: [{ id: "s1", name: "Disque A", type: "hdd", status: "available" }],
    }));
    const store = apiStore(adapter);
    await store.init();
    ck.eq(adapter.calls.load[0].slice().sort().join(","), LAZY_COLLECTIONS_API.slice().sort().join(","),
      "🎯 le chargement initial saute les CINQ collections lazy");
    ck.eq(store.hydration.levelOf("spares"), "none", "spares : déclarée lazy APRÈS `_hydrate` (contrat du lot 0)");
    ck.eq(store.all("spares").length, 0, "… et rien n'en est en cache");
  });

  await section("🚨 M4b : les MISES À JOUR résiduelles du serveur RAFRAÎCHISSENT le cache (refetch groupé)", async () => {
    // Le scénario qui a MOTIVÉ M4b : supprimer un équipement détache ses spares côté serveur (cascade
    // custom `equipments` : assigned_free ← nom, assigned_equipment_id ← null). `s1` est ABSORBÉ mais
    // sa copie sera écrasée par la VÉRITÉ serveur (valeur volontairement différente du plan local) ;
    // `s2` n'a JAMAIS été absorbé — le refetch l'ABSORBE (aucun mal : il devient simplement résoluble).
    const fixtures = await documentFixtures({
      equipments: [{ id: "e1", name: "SRV37" }],
      spares: [
        { id: "s1", name: "Disque A", type: "hdd", status: "assigned", assigned_equipment_id: "e1", assigned_free: "" },
        { id: "s2", name: "Disque B", type: "ssd", status: "assigned", assigned_equipment_id: "e1", assigned_free: "" },
      ],
    });
    const adapter = makeApiAdapter(fixtures, {
      transactResult: { residual: { deletes: [], updates: [{ collection: "spares", id: "s1" }, { collection: "spares", id: "s2" }] } },
    });
    const store = apiStore(adapter);
    await store.init();
    await store.fetchOne("spares", "s1");   // s1 entre au cache (fiche ouverte) ; s2 jamais absorbé
    ck.eq(store.get("spares", "s1").assigned_equipment_id, "e1", "sanité : la copie absorbée est rattachée à l'équipement");

    // État serveur APRÈS la cascade (ce que getMany rendra) — valeur DISTINCTE de celle que le plan
    // local poserait (« SRV37 ») : prouve que le refetch ÉCRASE bien la copie locale par le serveur.
    adapter.data.spares = adapter.data.spares.map((s) => ({ ...s, assigned_equipment_id: null, assigned_free: "SRV37 (serveur)" }));

    await store.remove("equipments", "e1");
    await tick(1);   // le refetch M4b est mené en ARRIÈRE-PLAN (l'écriture ne l'attend pas)

    ck.eq(adapter.calls.getMany.length, 1, "🎯 refetch GROUPÉ : UN `getMany` par collection touchée, jamais un appel par id");
    ck.eq(adapter.calls.getMany[0].collection + ":" + adapter.calls.getMany[0].ids.slice().sort().join(","), "spares:s1,s2",
      "… portant TOUS les ids rapportés par `residual.updates`");
    ck.eq(store.get("spares", "s1").assigned_free, "SRV37 (serveur)",
      "🎯 la copie ABSORBÉE est rafraîchie par la vérité SERVEUR (elle écrase le détachement du plan local)");
    ck.eq(store.get("spares", "s1").assigned_equipment_id, null, "… FK détachée au cache");
    ck(!!store.get("spares", "s2"), "🎯 un enregistrement JAMAIS absorbé est simplement ABSORBÉ (il devient résoluble)");
    ck.eq(store.get("spares", "s2").assigned_equipment_id, null, "… déjà détaché, tel que le serveur l'a écrit");
    ck.eq(store.hydration.levelOf("spares"), "partial", "l'absorption laisse la collection `partial` (rien ne dit que tout y est)");
  });

  await section("M4b : un ÉCHEC du refetch ne casse JAMAIS l'écriture (le cache se rattrapera)", async () => {
    const fixtures = await documentFixtures({
      equipments: [{ id: "e1", name: "SRV37" }],
      spares: [{ id: "s1", name: "Disque A", type: "hdd", status: "assigned", assigned_equipment_id: "e1", assigned_free: "" }],
    });
    const adapter = makeApiAdapter(fixtures, {
      getManyFails: true,
      transactResult: { residual: { deletes: [], updates: [{ collection: "spares", id: "s1" }] } },
    });
    const store = apiStore(adapter);
    await store.init();
    await store.fetchOne("spares", "s1");
    await store.remove("equipments", "e1");   // ne doit NI rejeter NI laisser une réjection non gérée
    await tick(1);
    ck.eq(store.get("equipments", "e1"), null, "🎯 l'écriture est FAITE : la suppression tient, refetch ou pas");
    ck(!!store.get("spares", "s1"), "la copie absorbée RESTE au cache (périmée mais lisible — rattrapée plus tard)");

    // Aucune mise à jour résiduelle (cas nominal) / adaptateur muet : NO-OP strict, aucun aller-retour.
    const quietAdapter = makeApiAdapter(await documentFixtures({ equipments: [{ id: "e9", name: "X" }] }));
    const quietStore = apiStore(quietAdapter);
    await quietStore.init();
    await quietStore.remove("equipments", "e9");
    await tick(1);
    ck.eq(quietAdapter.calls.getMany.length, 0, "sans `residual.updates` rapporté : aucun `getMany`, comportement d'avant");
  });

  await section("Résolution GROUPÉE des libellés de cibles : la partition PURE (core/TargetLabelResolution)", async () => {
    const collectionOf = (kind) => ({ application: "applications", spare: "spares", equipment: "equipments" })[kind];
    const cached = new Set(["equipments e1", "applications app1"]);
    const isCached = (collection, id) => cached.has(collection + " " + id);

    const missing = TargetLabelResolution.missingByCollection([
      { kind: "application", id: "app1" },   // au cache → rien à charger
      { kind: "application", id: "app2" },   // absent → demandé
      { kind: "spare", id: "s1" },
      { kind: "spare", id: "s2" },
      { kind: "spare", id: "s1" },           // doublon → dédoublonné
      { kind: "equipment", id: "e1" },       // famille hydratée, au cache → rien
      { kind: "martien", id: "x1" },         // famille inconnue → ignorée (labelOf la rend « introuvable »)
      { kind: "spare", id: "" },             // id vide → ignoré
    ], collectionOf, isCached);

    ck.eq(Object.keys(missing).sort().join(","), "applications,spares", "🎯 partition PAR COLLECTION (un fetchMany par entrée)");
    ck.eq(missing.applications.join(","), "app2", "les ids AU CACHE ne repartent jamais en réseau");
    ck.eq(missing.spares.join(","), "s1,s2", "dédoublonnage : chaque id manquant une seule fois");
    ck.eq(Object.keys(TargetLabelResolution.missingByCollection([{ kind: "application", id: "app1" }], collectionOf, isCached)).length, 0,
      "🎯 tout est au cache (le cas du MODE FICHIER) → partition VIDE → l'hôte ne fait AUCUN appel adaptateur (n°15 structurel)");
    ck.eq(Object.keys(TargetLabelResolution.missingByCollection([], collectionOf, isCached)).length, 0, "aucun lien → rien");
  });

  await section("G7 : jumeau ASYNC `sparesOfEquipmentAsync` — FK indexée, absorption, tri = jumeau synchrone", async () => {
    const adapter = makeApiAdapter(await documentFixtures({
      spares: [
        { id: "sZ", name: "Zebra", type: "hdd", status: "assigned", assigned_equipment_id: "e1" },
        { id: "sA", name: "Alpha", type: "ssd", status: "assigned", assigned_equipment_id: "e1" },
      ],
    }));
    const store = apiStore(adapter);
    await store.init();

    ck.eq(store.sparesOfEquipment("e1").length, 0, "sanité : le helper SYNCHRONE rendrait une section VIDE (cache non chargé)");
    const rows = await store.sparesOfEquipmentAsync("e1");
    ck.eq(rows.map((r) => r.name).join(","), "Alpha,Zebra",
      "🎯 le jumeau ASYNC va chercher les lignes par FK indexée — et les rend TRIÉES par nom");
    ck.eq(adapter.calls.findBy[0].collection + "." + adapter.calls.findBy[0].field, "spares.assigned_equipment_id",
      "… par un `findBy` sur la FK (exactement la requête que pose la section)");
    ck(!!store.get("spares", "sA"), "🎯 les lignes reçues sont ABSORBÉES et INDEXÉES : la fiche du spare s'ouvrira normalement");

    // -- Collection HYDRATÉE : cache, aucun réseau — et le jumeau SYNCHRONE trie DÉSORMAIS pareil. --
    await store.hydrate(["spares"]);
    const before = adapter.calls.findBy.length;
    ck.eq((await store.sparesOfEquipmentAsync("e1")).map((r) => r.name).join(","), "Alpha,Zebra", "collection redevenue `full` : même liste…");
    ck.eq(adapter.calls.findBy.length, before, "… servie par le CACHE, sans aller-retour (c'est l'ÉTAT qui décide)");
    ck.eq(store.sparesOfEquipment("e1").map((r) => r.name).join(","), "Alpha,Zebra",
      "🎯 PARITÉ des jumeaux : le helper synchrone trie par nom lui aussi (même contenu, même ordre)");

    // -- MODE FICHIER : promesse résolue sur le cache, JAMAIS de réseau (principe n°15). --
    const fileAdapter = makeApiAdapter(await documentFixtures({ spares: [{ id: "s9", name: "Locale", type: "hdd", status: "assigned", assigned_equipment_id: "e1" }] }));
    const fileStore = new Store(fileAdapter, null, LAZY_COLLECTIONS_API);   // injection NULLE = mode fichier
    await fileStore.init();
    ck.eq((await fileStore.sparesOfEquipmentAsync("e1")).map((r) => r.name).join(","), "Locale", "mode fichier : la section s'alimente au cache…");
    ck.eq(fileAdapter.calls.findBy.length, 0, "🎯 mode fichier : AUCUN `findBy` réseau — aucun écart de comportement (principe n°15)");
  });

  await section("Vague 4 : `sortField` du listing spares (pagination ORDONNÉE complète, lot 1b)", async () => {
    const { ListConfigs } = D("views/ListConfigs.js");
    const { ListOrder } = SHARED("src-shared/ListOrder.js");
    const store = await makeStore();

    const columns = ListConfigs.spares(store).columns;
    const declared = columns.filter((c) => c.sortField).map((c) => c.sortField);
    ck.eq(declared.join(","), "purchase_date",
      "spares : la SEULE colonne dont l'accesseur `sort` lit un champ scalaire du modèle (« Achat »)");
    for (const field of declared) ck(ListOrder.isSortable("spares", field), "sortField « " + field + " » ∈ liste blanche partagée (sinon dégradation SILENCIEUSE)");

    const bySortKey = (key) => columns.filter((c) => c.sortKey === key)[0];
    ck.eq(bySortKey("name").sortField, undefined,
      "🎯 « Désignation » n'en déclare PAS : elle trie displayName() (nom SINON marque/modèle) — même verdict que « Nom » wifi");
    ck.eq(bySortKey("type").sortField, undefined, "« Type » : trie le LIBELLÉ localisé, pas le slug stocké (l'ORDER BY contredirait l'affichage)");
    ck.eq(bySortKey("status").sortField, undefined, "« Statut » : même raison");
    ck.eq(columns.filter((c) => c.filter && c.filter.field).length, 0,
      "🎯 G8 SANS OBJET : les filtres Type/Statut proposent des ÉNUMÉRATIONS FERMÉES — exactes quel que soit le cache, aucun DISTINCT à payer");
  });

  /* ------------------------------------------------------------------------------------------------
     🚨 T8/Q8.5 — LE RATTRAPAGE DE LA BRANCHE LAZY OUBLIE **TOUT** LE SERVEUR, PAS SEULEMENT LA PAGE.

     Le défaut refermé ici : `ListView.forgetServerPage()` n'oubliait que la PAGE (régime pagé G4).
     Or le JEU serveur est mémoïsé PAR SIGNATURE de requête (collection + saisie + cible) et l'écriture
     d'un AUTRE client ne change pas cette signature — donc, sous une recherche ou un filtre ACTIF, le
     listing d'une collection lazy restait périmé MÊME en quittant puis rouvrant l'onglet (le rendu
     ressortait le jeu mémoïsé). C'est exactement le bug que le lot R2 avait refermé pour les
     collections HYDRATÉES : `store.onChange` y appelle `forgetRemote()` ET `forgetPage()`. La branche
     lazy, elle, était restée à mi-chemin — deux chemins pour une même question, et l'écart est le bug.

     POURQUOI UN VERROU SUR LES SOURCES plutôt qu'un test de comportement : le défaut ne vit ni dans un
     module pur ni dans une classe instanciable sans DOM — il vit dans le CÂBLAGE (`main.ts` → `ListView`
     → `ListRowEngine`). Le patron est celui du verrou d'exhaustivité de `test-nav-model.js` : on relit
     la SOURCE et on nomme ce qui manque. Un test qui bouchonnerait `ListView` ne prouverait rien du
     câblage réel, qui est précisément l'endroit où le défaut s'était logé.
     ------------------------------------------------------------------------------------------------ */
  await section("🚨 T8/Q8.5 : la branche LAZY oublie la PAGE **et** le JEU serveur (analyse des SOURCES)", async () => {
    const fs = require("fs");
    const path = require("path");
    const src = (...p) => fs.readFileSync(path.join(__dirname, "..", "..", "src-client", ...p), "utf8");

    // -- 1. Le point d'entrée de l'HÔTE oublie bien les DEUX --
    const listView = src("views", "ListView.ts");
    const methode = /forgetServerData\(\)\s*:\s*void\s*\{([^}]*)\}/.exec(listView);
    ck(!!methode, "ListView.forgetServerData() existe (le nom ne ment plus : ce n'est plus « Page »)");
    ck(/forgetRemote\(\)/.test(methode[1]), "🚨 forgetServerData oublie le JEU serveur mémoïsé (forgetRemote) — LE correctif Q8.5");
    ck(/forgetPage\(\)/.test(methode[1]), "forgetServerData oublie AUSSI la page en main (forgetPage) — comportement historique préservé");
    ck.eq(/forgetServerPage/.test(listView), false, "aucun reste de l'ancien nom dans ListView");

    // -- 2. PARITÉ avec la branche HYDRATÉE (lot R2) : les deux filets font la même chose --
    const abonnement = /store\.onChange\(\(\)\s*=>\s*\{([^}]*)\}\);/.exec(listView);
    ck(!!abonnement, "le filet d'abonnement `store.onChange` du listing est bien lu");
    for (const appel of ["forgetRemote()", "forgetPage()"]) {
      ck(abonnement[1].includes(appel),
        "parité branche HYDRATÉE : l'abonnement appelle " + appel + " (c'est le modèle que la branche lazy rejoint)");
    }

    // -- 3. Le câblage de l'hôte appelle le bon point d'entrée --
    const mainTs = src("app", "main.ts");
    const accroche = /store\.onLazyReloadDeferred\s*=\s*\(collections\)\s*=>\s*\{([\s\S]*?)\n  \};/.exec(mainTs);
    ck(!!accroche, "le point d'accroche G3 `onLazyReloadDeferred` est bien lu dans main.ts");
    ck(/forgetServerData\(\)/.test(accroche[1]), "🚨 main.ts appelle forgetServerData() sur le listing de la collection différée");
    ck.eq(/forgetServerPage/.test(mainTs), false, "aucun reste de l'ancien nom dans main.ts");

    // -- 4. G3 n'est PAS contournée : on n'a re-tiré AUCUNE collection --
    ck.eq(/reloadCollections|hydrate\(/.test(accroche[1]), false,
      "🚨 G3 INTACTE : le rattrapage ne re-tire aucune collection — il périme ce que le listing tient, rien de plus");
  });

};
