/* Tests modules — L'APPLICATION SOUS DROITS PARTIELS (correctif auth/ACL du 2026-08-17,
   cf. docs/auth.md § 10.6 et docs/hydratation.md § « Droits partiels »).

   Le lot 2 avait gaté ce que l'utilisateur VOIT ; ce correctif gate ce que le client
   DEMANDE. Trois symptômes mesurés sur déploiement réel, trois causes :

   S1 — le chargement du document tirait TOUTES les collections non-lazy sans regarder les
        droits : un `dc-viewer` sans `vm:read` prenait un 403 sur `GET /vms`, le `Promise.all`
        de `RestAdapter.load` rejetait, et RIEN ne se chargeait ;
   S2 — les pastilles d'onglet (`countHint`) relevaient un `COUNT(*)` serveur pour des
        collections interdites, à CHAQUE repeinte — 257 requêtes 403 en 9 s, mesurées ;
   S3 — le boot mourant, aucune vue n'était jamais activée : barre d'onglets garnie, écran
        vide, deep-link perdu. Et rien ne rejouait l'activation à l'arrivée des droits.

   Ce fichier verrouille les QUATRE logiques pures qui les corrigent :
   1. le niveau d'hydratation `forbidden` — sa précédence, son caractère terminal, et sa
      double nature (compte comme non-hydraté pour G1, exclu de tout ce qui requête) ;
   2. 🚨 l'INVARIANT ANTI-DESTRUCTION : une collection vide-parce-qu'interdite n'est JAMAIS
      `full`, donc `Store._persistAll` (le `PUT /snapshot`) refuse BRUYAMMENT — sans quoi un
      snapshot écrirait un document AMPUTÉ de ses `vms`/`wifiClients` ;
   3. l'assiette de CHARGEMENT ∩ lisibles, au point commun `Store.init`, et le silence des
      chemins de confort (compteurs, facettes, sections de fiche, résidu, SSE) ;
   4. `core/ViewRestoration` — quelle vue activer, et le prédicat d'EXPORT COMPLET.

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D, SHARED, Store, BrowserStorageAdapter } = require("./harness.js");

/** Assiette de lecture INJECTÉE au Store (port `CollectionReadAccess`) : tout sauf `denied`. */
const readAccessExcept = (denied) => ({ canReadCollection: (c) => denied.indexOf(c) === -1 });

/** Adaptateur SIMULÉ qui JOURNALISE ce qu'on lui demande — c'est le seul moyen de prouver
    « aucune requête vers l'interdit » : un test sur le RÉSULTAT ne verrait pas la requête. */
const makeSpyAdapter = (fixtures) => {
  const calls = { load: [], list: [], findBy: [], count: [], facets: [], getMany: [], replaceAll: 0 };
  return {
    calls,
    load: async (opts) => { calls.load.push([...((opts && opts.skipCollections) || [])].sort()); return { meta: {} }; },
    list: async (collection) => { calls.list.push(collection); return { rows: (fixtures && fixtures[collection]) || [], total: 0 }; },
    findBy: async (collection) => { calls.findBy.push(collection); return []; },
    getMany: async (collection) => { calls.getMany.push(collection); return []; },
    count: async (collection) => { calls.count.push(collection); return 42; },
    facetValues: async (collection, field) => { calls.facets.push(collection + ":" + field); return []; },
    replaceAll: async () => { calls.replaceAll++; },
    saveMeta: async () => {},
  };
};

module.exports = async () => {

  /* ==========================================================================
     1. core/HydrationState — le niveau `forbidden`
     ========================================================================== */
  await section("droits partiels : niveau d'hydratation `forbidden` — précédence, caractère terminal, double nature", async () => {
    const { HydrationState, HydrationError } = D("core/HydrationState.js");

    const h = new HydrationState();
    h.declareLazy(["contacts", "wifiClients"]);
    h.declareForbidden(["vms", "wifiClients"]);
    ck.eq(h.levelOf("vms"), "forbidden", "une collection déclarée interdite est `forbidden`");
    ck.eq(h.levelOf("contacts"), "none", "une lazy NON interdite reste `none`");
    ck.eq(h.levelOf("racks"), "full", "une collection ordinaire reste `full` (aucune déviation)");
    ck(h.isForbidden("wifiClients"), "`forbidden` PRIME sur `none` (déclarée lazy PUIS interdite)");

    // PRÉCÉDENCE dans l'AUTRE ordre : le résultat doit être le même, sinon l'ordre des deux appels
    // dans `Store.init` deviendrait une subtilité à retenir — donc un jour, une régression.
    const h2 = new HydrationState();
    h2.declareForbidden(["wifiClients"]);
    h2.declareLazy(["wifiClients", "contacts"]);
    ck.eq(h2.levelOf("wifiClients"), "forbidden", "`declareLazy` ne DÉGRADE PAS une interdite (précédence indépendante de l'ordre)");
    ck.eq(h2.levelOf("contacts"), "none", "… et déclare bien les autres lazy au passage");

    // TERMINAL pour la session : rien ne le promeut par accident.
    h.noteAbsorption("vms");
    ck.eq(h.levelOf("vms"), "forbidden", "`noteAbsorption` ne promeut PAS une interdite en `partial` (défense en profondeur)");

    // DOUBLE NATURE — le cœur du correctif.
    ck(!h.isHydrated("vms"), "interdite : NON hydratée (donc G1/G3 la voient comme absente)");
    ck(!h.isFullyHydrated(), "interdite ⇒ le corpus n'est PAS complet");
    ck(h.notFullCollections().indexOf("vms") !== -1, "`notFullCollections` (diagnostic de G1) la CITE");
    ck.eq(h.hydratableCollections().indexOf("vms"), -1, "`hydratableCollections` (liste de travail de hydrateAll) l'EXCLUT");
    ck.eq(h.hydratableCollections().sort().join(","), "contacts", "… et ne garde que ce qui est réellement rechargeable");
    ck.eq(h.forbiddenCollections().sort().join(","), "vms,wifiClients", "`forbiddenCollections` les liste toutes");

    // G1 — l'erreur nomme l'interdite : sans ça, un support lirait « rien à signaler ».
    let err = null;
    try { h.assertFullyHydrated("persistAll (PUT /snapshot)"); } catch (e) { err = e; }
    ck(!!err && err instanceof HydrationError, "G1 : corpus à collection INTERDITE ⇒ HydrationError");
    ck(err.collections.indexOf("vms") !== -1, "G1 : l'interdite figure dans les collections manquantes");

    // G3 — partition SSE : ni rechargée, ni « différée » (rien à rafraîchir, tout à ne pas demander).
    const split = h.splitReload(["racks", "contacts", "vms"]);
    ck.eq(split.refetch.join(","), "racks", "G3 : seule l'hydratée est re-tirée");
    ck.eq(split.deferred.join(","), "contacts", "G3 : la lazy est DIFFÉRÉE (ses dérivés se rafraîchissent)");
    ck.eq(split.deferred.indexOf("vms"), -1, "G3 : l'interdite n'est NI re-tirée NI différée (aucun dérivé à relever)");

    // markFull l'efface (les droits sont revenus et un rechargement complet a abouti).
    h.markFull("vms");
    ck.eq(h.levelOf("vms"), "full", "`markFull` efface l'interdiction (un rechargement complet a réellement abouti)");

    // MODE FICHIER / VISUALISEUR : l'état INERTE ne peut RIEN interdire (principe n°15).
    const inert = HydrationState.alwaysFull();
    inert.declareForbidden(["vms", "wifiClients"]);
    ck(!inert.isForbidden("vms"), "état INERTE : `declareForbidden` est SANS EFFET (aucune ACL en local)");
    ck(inert.isFullyHydrated(), "état INERTE : le corpus reste complet, par construction");
  });

  /* ==========================================================================
     2. 🚨 L'INVARIANT ANTI-DESTRUCTION (G1 sous droits partiels)
     ========================================================================== */
  await section("droits partiels 🚨 G1 : une collection vide-parce-qu'INTERDITE ne peut JAMAIS produire un snapshot", async () => {
    const { HydrationState } = D("core/HydrationState.js");

    // Store en mode API SIMULÉ : état traçant + assiette de lecture qui refuse `vms`.
    const adapter = makeSpyAdapter();
    const store = new Store(adapter, new HydrationState(), ["contacts"], readAccessExcept(["vms"]));
    await store.init();

    ck.eq(store.hydration.levelOf("vms"), "forbidden", "après init : `vms` est marquée INTERDITE (et non « vide »)");
    ck.eq(store.all("vms").length, 0, "… son cache est bien vide");
    ck(!store.hydration.isFullyHydrated(), "… et le corpus n'est PAS réputé complet");
    // 🚨 NON-RÉGRESSION S3, mesurée sur déploiement réel : ce `init()` a réconcilié les catalogues
    // (store vierge ⇒ `syncCatalogs()` vrai), donc l'ancien code enchaînait `hydrateAll` + `_persistAll`.
    // Le premier partait en 403 sur l'interdite et faisait ÉCHOUER TOUT LE CHARGEMENT — à chaque F5,
    // puisque le snapshot n'étant jamais écrit, le catalogue restait désynchronisé. Désormais : la
    // réconciliation reste EN MÉMOIRE et le boot aboutit.
    ck.eq(adapter.calls.replaceAll, 0, "🚨 S3 : boot à catalogue désynchronisé + corpus interdit ⇒ AUCUN snapshot tenté (et le boot aboutit)");
    ck.eq(adapter.calls.list.indexOf("vms"), -1, "S3 : la réconciliation n'a PAS tenté de recharger l'interdite");

    // LE test que le correctif exige : un snapshot FORCÉ échoue BRUYAMMENT, et rien n'est écrit.
    const before = adapter.calls.replaceAll;
    let err = null;
    try { await store._persistAll(); } catch (e) { err = e; }
    ck(!!err && err.name === "HydrationError", "snapshot FORCÉ sous droits partiels : refus BRUYANT (HydrationError)");
    ck(err.collections.indexOf("vms") !== -1, "… l'erreur nomme la collection interdite");
    ck.eq(adapter.calls.replaceAll, before, "🚨 AUCUN `PUT /snapshot` n'est parti — le document serveur est intact");

    // Et `hydrateAll` ne peut PAS « réparer » le corpus en tirant l'interdite (ce serait un 403).
    adapter.calls.list.length = 0;
    const rehydrated = await store.hydrateAll();
    ck.eq(rehydrated.indexOf("vms"), -1, "`hydrateAll` ne tente JAMAIS de recharger une interdite");
    ck.eq(adapter.calls.list.indexOf("vms"), -1, "… aucune requête `list` vers `vms`");
    ck(!store.hydration.isFullyHydrated(), "… et le corpus reste incomplet : c'est POURQUOI les exports sont masqués");
  });

  /* ==========================================================================
     3. L'ASSIETTE DE CHARGEMENT, et le silence des chemins de confort
     ========================================================================== */
  await section("droits partiels : assiette de CHARGEMENT ∩ lisibles, et ZÉRO requête vers l'interdit", async () => {
    const { HydrationState } = D("core/HydrationState.js");

    const adapter = makeSpyAdapter();
    const store = new Store(adapter, new HydrationState(), ["contacts", "wifiClients"], readAccessExcept(["vms", "wifiClients"]));
    await store.init();

    // -- S1 : le plan de chargement saute l'INTERDIT autant que le LAZY, en UNE liste.
    const skipped = adapter.calls.load[0];
    ck(skipped.indexOf("vms") !== -1, "S1 : `vms` (interdite, NON lazy) est SAUTÉE du chargement — c'est la cause racine de S1");
    ck(skipped.indexOf("contacts") !== -1, "… `contacts` (lazy) l'est toujours");
    ck.eq(skipped.filter((c) => c === "wifiClients").length, 1, "… `wifiClients` (lazy ET interdite) n'y figure qu'UNE fois (dédoublonnée)");
    ck.eq(store.hydration.levelOf("wifiClients"), "forbidden", "… `wifiClients` reste INTERDITE malgré son statut lazy");

    // ⚠ Ce boot-là a réconcilié les catalogues (store vierge) et donc HYDRATÉ les lazy AUTORISÉES —
    // sémantique documentée de `Store.init` (docs/hydratation.md § « Boot + réconciliation »), et c'est
    // bien ce qu'on veut : seule l'INTERDITE est restée dehors. On re-déclare donc `contacts` lazy pour
    // éprouver les compteurs dans leur régime nominal, exactement comme le fait `test-hydration.js`.
    ck.eq(store.hydration.levelOf("contacts"), "full", "… la lazy AUTORISÉE a bien été hydratée par la réconciliation des catalogues");
    store.hydration.declareLazy(["contacts"]);

    // -- S2 : les compteurs de pastille. LE point de fuite mesuré (257 × 403 en 9 s).
    adapter.calls.count.length = 0;
    ck.eq(store.countHint("wifiClients"), 0, "S2 : `countHint` d'une interdite vaut 0…");
    ck.eq(store.countHint("wifiClients"), 0, "… de façon stable (aucun état à faire converger)");
    ck.eq(await store.countOf("wifiClients"), 0, "… et `countOf` aussi");
    ck.eq(adapter.calls.count.length, 0, "🚨 S2 : AUCUN `COUNT(*)` n'est parti vers l'interdite");
    // … alors qu'une lazy AUTORISÉE relève bien, elle : la garde ne casse pas le lazy-load.
    ck.eq(await store.countOf("contacts"), 42, "contrôle : une lazy AUTORISÉE relève toujours son compte serveur");
    ck.eq(adapter.calls.count.join(","), "contacts", "… et c'est la SEULE collection interrogée");

    // -- facettes (G8) : même silence.
    adapter.calls.facets.length = 0;
    ck.eq(store.facetValues("wifiClients", "ssid").length, 0, "facettes d'une interdite : liste vide…");
    ck.eq(adapter.calls.facets.length, 0, "… sans le moindre `SELECT DISTINCT`");

    // -- sections de fiche (G7) : vides, sans `fetchBy`.
    adapter.calls.findBy.length = 0;
    const rows = await store.applicationsOfVmAsync("vm-1");   // `applications` est LISIBLE ici : contrôle négatif
    ck(Array.isArray(rows), "contrôle : une section sur collection lisible reste servie");
    const storeNoApps = new Store(makeSpyAdapter(), new HydrationState(), [], readAccessExcept(["applications"]));
    await storeNoApps.init();
    const spy = storeNoApps.adapter;
    spy.calls.findBy.length = 0;
    ck.eq((await storeNoApps.applicationsOfVmAsync("vm-1")).length, 0, "section de fiche sur collection INTERDITE : vide…");
    ck.eq(spy.calls.findBy.length, 0, "… et aucun `fetchBy` (pas de « Chargement impossible » invitant à réessayer)");

    // -- G3 : un événement SSE ne relance rien sur l'interdite.
    adapter.calls.list.length = 0;
    const reloaded = await store.reloadCollections(["racks", "vms", "wifiClients"]);
    ck.eq(reloaded.join(","), "racks", "SSE : seule la collection hydratée est rechargée");
    ck.eq(adapter.calls.list.indexOf("vms"), -1, "SSE : aucune requête vers l'interdite");

    // -- M4b : le résidu d'une cascade serveur ne refetch pas l'interdit.
    adapter.calls.getMany.length = 0;
    await store._refreshResidualUpdates({ residual: { updates: [{ collection: "racks", id: "r1" }, { collection: "wifiClients", id: "w1" }] } });
    ck(adapter.calls.getMany.indexOf("racks") !== -1, "M4b : le résidu d'une collection LISIBLE est bien refetché");
    ck.eq(adapter.calls.getMany.indexOf("wifiClients"), -1, "M4b : celui d'une INTERDITE est ignoré (rien en cache à rafraîchir)");

    // -- MODE FICHIER : aucune assiette injectée ⇒ rien ne change, PAR CONSTRUCTION.
    const localAdapter = makeSpyAdapter();
    const local = new Store(localAdapter, null, ["contacts"]);
    await local.init();
    ck.eq(localAdapter.calls.load[0].join(","), "", "mode fichier : le chargement ne saute RIEN (ni lazy, ni interdit)");
    ck(local.hydration.isFullyHydrated(), "mode fichier : corpus complet, aucune collection interdite possible");
  });

  /* ==========================================================================
     4. core/ViewRestoration + prédicat d'EXPORT COMPLET
     ========================================================================== */
  await section("droits partiels : restauration de vue (S3) — courante → bookmarkée → défaut → première visible", async () => {
    const { ViewRestoration } = D("core/ViewRestoration.js");

    /** Fabrique d'état : `visible` = la liste blanche des vues accessibles, dans l'ORDRE des onglets. */
    const state = (current, bookmarked, visible) => ({
      current, bookmarked, defaultView: "equipements",
      isVisible: (name) => visible.indexOf(name) !== -1,
      firstVisible: () => visible[0] || null,
    });

    // 1. Vue courante valable ⇒ RIEN à faire (on ne déplace pas l'utilisateur sous ses pieds).
    ck.eq(ViewRestoration.target(state("cables", "equipements", ["equipements", "cables"])), null,
      "vue courante visible : `target` rend null (aucune activation à rejouer)");

    // 2. LE cas S3 : aucune vue active (le switch du boot a été refusé), les droits viennent d'arriver.
    ck.eq(ViewRestoration.target(state(null, "equipements", ["equipements", "cables"])), "equipements",
      "S3 : aucune vue active + hash lisible ⇒ on active la vue BOOKMARKÉE");
    ck.eq(ViewRestoration.target(state(null, "cables", ["equipements", "cables"])), "cables",
      "S3 : le hash prime sur la vue par défaut (c'est une intention explicite de l'utilisateur)");

    // 3. Hash vers une vue INTERDITE : repli propre (et `switchView` réécrira le hash sur la cible).
    ck.eq(ViewRestoration.target(state(null, "wifi", ["equipements", "cables"])), "equipements",
      "hash vers une vue INTERDITE : repli sur la vue par défaut");
    ck.eq(ViewRestoration.target(state(null, "wifi", ["cables", "vms"])), "cables",
      "… et si le défaut n'est pas visible non plus : première vue visible");

    // 4. Vue courante devenue INVISIBLE (droits retirés à chaud) : on ne la garde pas.
    ck.eq(ViewRestoration.target(state("vms", "", ["equipements"])), "equipements",
      "vue courante devenue invisible : bascule sur une vue accessible");

    // 5. Plus AUCUNE vue accessible ⇒ null (l'écran « aucun accès » couvre l'app).
    ck.eq(ViewRestoration.target(state(null, "equipements", [])), null,
      "aucune vue accessible : null — on n'active rien, l'écran « aucun accès » couvre l'app");
    // … et le hash vide (pas de deep-link) ne fait pas dévier la décision.
    ck.eq(ViewRestoration.target(state(null, "", ["cables"])), "cables",
      "hash absent : on retombe sur défaut puis première visible");
    ck.eq(ViewRestoration.target(state(null, "   ", ["cables"])), "cables",
      "hash blanc : traité comme absent (jamais une vue « ␣ » cherchée en vain)");

    // 6. `afterDocumentOpened` : même règle, mais la vue courante est une RÉPONSE (l'appelant la
    //    re-switche pour la re-rendre avec les données fraîches) — c'est là toute la différence.
    ck.eq(ViewRestoration.afterDocumentOpened(state("cables", "equipements", ["equipements", "cables"])), "cables",
      "après ouverture de document : la vue courante est PRÉSERVÉE (et renvoyée pour re-rendu)");
    ck.eq(ViewRestoration.afterDocumentOpened(state(null, "cables", ["equipements", "cables"])), "cables",
      "après ouverture de document sans vue active : le hash est honoré (deep-link préservé)");

    // 7. MODE FICHIER (tout visible) : la décision est EXACTEMENT celle d'avant le correctif.
    const allVisible = ["equipements", "racks", "cables"];
    ck.eq(ViewRestoration.afterDocumentOpened(state("racks", "cables", allVisible)), "racks", "mode fichier : onglet actif préservé");
    ck.eq(ViewRestoration.afterDocumentOpened(state(null, "cables", allVisible)), "cables", "mode fichier : hash honoré");
    ck.eq(ViewRestoration.afterDocumentOpened(state(null, "inconnue", allVisible)), "equipements", "mode fichier : repli sur l'onglet par défaut");
  });

  await section("droits partiels : prédicat d'EXPORT COMPLET (`hasFullDocumentRead`) — masquer plutôt qu'amputer", async () => {
    const { AccessState } = D("core/AccessState.js");
    const { Permissions, PermissionSet } = SHARED("src-shared/Permissions.js");

    // La borne HAUTE, dont `hasAnyDocumentRead` est la borne basse.
    ck(AccessState.ALL.hasFullDocumentRead(), "mode fichier (ALL) : export TOUJOURS proposé (injection nulle)");
    ck(!AccessState.NONE.hasFullDocumentRead(), "NONE : aucun export");
    ck(AccessState.fromGrants(["*"]).hasFullDocumentRead(), "admin (`*`) : export proposé");

    const dcViewer = AccessState.fromGrants(["dc.*:read"]);
    ck(dcViewer.hasAnyDocumentRead(), "`dc-viewer` : a bien AU MOINS une lecture (la recherche reste offerte)…");
    ck(!dcViewer.hasFullDocumentRead(), "… mais PAS toute la donnée (ni `vm` ni `wifi`) ⇒ export MASQUÉ");

    // L'union explicite des viewers rouvre l'export : « tout voir » s'écrit, il ne s'hérite pas.
    const everything = AccessState.fromGrants(["dc.*:read", "vm:read", "wifi:read"]);
    ck(everything.hasFullDocumentRead(), "union explicite dc + vm + wifi : export de nouveau proposé");
    // … et il suffit d'UN domaine manquant pour le refermer — vérifié domaine par domaine.
    for (const missing of Permissions.DATA_DOMAINS) {
      const grants = Permissions.DATA_DOMAINS.filter((d) => d !== missing).map((d) => d + ":read");
      ck(!AccessState.fromGrants(grants).hasFullDocumentRead(), "sans `" + missing + ":read` : export masqué");
    }

    // Le prédicat vit dans le modèle PARTAGÉ — le client n'a AUCUNE règle propre à réécrire.
    ck(Permissions.hasFullDocumentRead(PermissionSet.of(["*"])), "règle partagée : `*` couvre tout");
    ck(!Permissions.hasFullDocumentRead(PermissionSet.of(["dc.*:read"])), "règle partagée : `dc.*:read` ne couvre pas vm/wifi");

    // ASSIETTE DE LECTURE exposée au Store : la même dérivation que côté serveur (§ 8.3).
    const readable = dcViewer.readableCollections();
    ck(readable.indexOf("equipments") !== -1, "assiette : les collections DC sont lisibles");
    ck.eq(readable.indexOf("vms"), -1, "assiette : `vms` n'y est pas");
    ck.eq(readable.indexOf("wifiClients"), -1, "assiette : `wifiClients` non plus");
    ck.eq(readable.join(","), Permissions.readableCollections(PermissionSet.of(["dc.*:read"])).join(","),
      "assiette : STRICTEMENT celle du modèle partagé (aucune table locale)");
  });
};
