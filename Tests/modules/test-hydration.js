/* Tests modules — ÉTAT D'HYDRATATION par collection + gardes G1-G3 (lot 0 du chantier
   « lazy-load des collections », cf. docs/hydratation.md et le cadrage
   `.notes/toDos/lazy-load-collections-cadrage-2026-08-11.md`).

   Ce qui est verrouillé ici :
   1. le module PUR `core/HydrationState` : niveaux/transitions/prédicats, l'état INERTE
      `alwaysFull` (mode fichier/visualiseur — injection nulle), l'erreur NOMMÉE de G1 et la
      partition G3 (`splitReload`) ;
   2. le câblage du Store : G1 refuse `_persistAll` en corpus partiel et PASSE en full —
      `replaceAll`/`newDocument` restent LÉGITIMES (remplacement TOTAL voulu, `_hydrate`
      re-marque tout full) ; G2 `hydrateAll` recharge EXACTEMENT les collections non-full
      (adapter simulé, l'espion trace les fetches) ; G3 `reloadCollections` SAUTE les
      collections non hydratées et prévient le point d'accroche `onLazyReloadDeferred`.

   ⚠ `_persistAll` est PRIVÉE en TypeScript (le chokepoint est volontairement hors API
   publique) mais visible du JS compilé : on l'appelle directement — c'est LE chemin que la
   garde ferme (le boot `init → syncCatalogs → _persistAll`), il doit être testé tel quel.

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, D, Store, BrowserStorageAdapter } = require("./harness.js");
const { HydrationState, HydrationError } = D("core/HydrationState.js");

/* Adapter SIMULÉ minimal (lecteur injecté) : sert des fixtures par collection et JOURNALISE
   chaque `list` — les tests G2/G3 vérifient QUELLES collections ont été re-tirées, pas
   seulement le résultat. Les autres méthodes ne sont pas nécessaires à ces chemins. */
const makeFakeAdapter = (fixtures) => {
  const listed = [];
  return {
    listed,
    list: async (collection, _opts) => { listed.push(collection); return { rows: fixtures[collection] || [] }; },
    replaceAll: async () => { listed.push("__replaceAll__"); },
  };
};

module.exports = async () => {

  await section("HydrationState : niveaux, transitions et prédicats (module pur)", async () => {
    const h = new HydrationState();
    // Défaut = full : c'est le régime historique de TOUTES les collections (aucune déviation connue).
    ck.eq(h.levelOf("contacts"), "full", "défaut : toute collection est full");
    ck(h.isHydrated("contacts"), "défaut : isHydrated(c) vrai");
    ck(h.isFullyHydrated(), "défaut : corpus intégralement hydraté");
    ck.eq(h.notFullCollections().length, 0, "défaut : aucune collection non-full");

    // declareLazy → none (posé AVANT toute lecture, à l'ouverture d'un document).
    h.declareLazy(["contacts", "attachments"]);
    ck.eq(h.levelOf("contacts"), "none", "declareLazy : la collection passe à none");
    ck(!h.isHydrated("attachments"), "declareLazy : plus hydratée");
    ck(!h.isFullyHydrated(), "declareLazy : le corpus n'est plus intégralement hydraté");
    ck.eq(h.notFullCollections().sort().join(","), "attachments,contacts", "notFullCollections : les deux déclarées");
    ck.eq(h.partialCollections().length, 0, "aucune partial tant que rien n'est absorbé");

    // noteAbsorption : none → partial ; full RESTE full ; partial reste partial.
    h.noteAbsorption("contacts");
    ck.eq(h.levelOf("contacts"), "partial", "noteAbsorption : none → partial");
    h.noteAbsorption("contacts");
    ck.eq(h.levelOf("contacts"), "partial", "noteAbsorption : partial reste partial");
    h.noteAbsorption("equipments");
    ck.eq(h.levelOf("equipments"), "full", "noteAbsorption : une collection full RESTE full (jamais de rétrogradation)");
    ck.eq(h.partialCollections().join(","), "contacts", "partialCollections : contacts seule");

    // markFull / markAllFull.
    h.markFull("contacts");
    ck.eq(h.levelOf("contacts"), "full", "markFull : la collection redevient full");
    ck.eq(h.notFullCollections().join(","), "attachments", "markFull : attachments reste none");
    h.markAllFull();
    ck(h.isFullyHydrated(), "markAllFull : tout redevient full (instantané complet absorbé)");

    // splitReload (G3, pur) : partition hydratées / à sauter.
    h.declareLazy(["contacts"]);
    h.noteAbsorption("contacts");   // partial : à sauter aussi (le cache n'a pas tout)
    h.declareLazy(["attachments"]); // none
    const split = h.splitReload(["equipments", "contacts", "ports", "attachments"]);
    ck.eq(split.refetch.join(","), "equipments,ports", "splitReload : seules les hydratées se re-tirent");
    ck.eq(split.deferred.join(","), "contacts,attachments", "splitReload : none ET partial sont sautées");
  });

  await section("HydrationState : état INERTE alwaysFull (mode fichier/visualiseur — injection nulle)", async () => {
    const h = HydrationState.alwaysFull();
    ck(h.isFullyHydrated(), "inerte : full d'emblée");
    // « Tout full PAR CONSTRUCTION, pas par convention » : declareLazy est SANS EFFET — aucun chemin de
    // code, présent ou futur, ne peut rendre un document local partiellement hydraté (principe n°15).
    h.declareLazy(["contacts", "attachments"]);
    ck(h.isFullyHydrated(), "inerte : declareLazy sans effet");
    ck.eq(h.levelOf("contacts"), "full", "inerte : la collection déclarée reste full");
    let threw = false;
    try { h.assertFullyHydrated("test"); } catch (_) { threw = true; }
    ck(!threw, "inerte : assertFullyHydrated ne lève jamais");
    ck.eq(h.splitReload(["contacts", "ports"]).deferred.length, 0, "inerte : splitReload ne saute jamais rien");
  });

  await section("HydrationState : garde G1 pure — assertFullyHydrated lève une erreur NOMMÉE", async () => {
    const h = new HydrationState();
    h.assertFullyHydrated("op");   // full → passe sans lever
    ck(true, "corpus full : la garde passe");
    h.declareLazy(["contacts", "wifiClients"]);
    let err = null;
    try { h.assertFullyHydrated("persistAll (PUT /snapshot)"); } catch (e) { err = e; }
    ck(!!err, "corpus partiel : la garde LÈVE");
    ck(err instanceof HydrationError, "l'erreur est une HydrationError (instanceof)");
    ck.eq(err && err.name, "HydrationError", "erreur NOMMÉE (name) — identifiable en console/log");
    ck.eq(err && err.operation, "persistAll (PUT /snapshot)", "l'opération refusée est portée par l'erreur");
    ck.eq(err && err.collections.sort().join(","), "contacts,wifiClients", "les collections manquantes sont listées");
    ck(!!err && err.message.indexOf("contacts") !== -1, "le message cite les collections (refus BRUYANT, débogable)");
  });

  await section("Store ⇄ G1 : _persistAll refusé en partiel ; replaceAll/newDocument légitimes (remplacement TOTAL)", async () => {
    // Store headless : BrowserStorageAdapter en mémoire + état d'hydratation TRAÇANT injecté (mode API simulé).
    const s = new Store(new BrowserStorageAdapter({ persistent: false }), new HydrationState());
    await s.init(); await s.newDocument();
    ck(s.hydration.isFullyHydrated(), "après newDocument : corpus full (persistance passée)");

    // Corpus rendu partiel → le chokepoint _persistAll (chemin du boot syncCatalogs) REFUSE.
    s.hydration.declareLazy(["contacts"]);
    let err = null;
    try { await s._persistAll(); } catch (e) { err = e; }
    ck(!!err && err.name === "HydrationError", "_persistAll en corpus partiel : rejet HydrationError (jamais de snapshot amputé)");

    // Import/remplacement TOTAL : légitime MÊME depuis un corpus partiel — _hydrate remplace tout le
    // cache par le document importé (format d'échange autosuffisant) et re-marque full AVANT de persister.
    await s.replaceAll({ meta: { docName: "Import" }, contacts: [{ id: "c9", name: "Zoé" }] });
    ck(s.hydration.isFullyHydrated(), "replaceAll : le corpus redevient full par construction");
    ck(!!s.get("contacts", "c9"), "replaceAll : le contenu importé est bien absorbé (et indexé)");

    // newDocument : même légitimité (document neuf = complet et vide).
    s.hydration.declareLazy(["contacts"]);
    await s.newDocument();
    ck(s.hydration.isFullyHydrated(), "newDocument : passe et re-marque tout full");
    ck.eq(s.all("contacts").length, 0, "newDocument : document vierge");

    // Store SANS injection (mode fichier/visualiseur, cf. makeStore) : état inerte → jamais de refus.
    const local = new Store(new BrowserStorageAdapter({ persistent: false }));
    await local.init(); await local.newDocument();
    local.hydration.declareLazy(["contacts"]);   // sans effet par construction
    let threwLocal = false;
    try { await local._persistAll(); } catch (_) { threwLocal = true; }
    ck(!threwLocal, "mode fichier (injection nulle) : _persistAll jamais refusé — comportement inchangé");
  });

  await section("Store ⇄ G2 : hydrateAll recharge EXACTEMENT les collections non-full (adapter simulé)", async () => {
    const adapter = makeFakeAdapter({
      contacts: [{ id: "c1", name: "Alice" }, { id: "c2", name: "Bob" }],
      attachments: [{ id: "a1", name: "manuel.pdf" }],
    });
    const s = new Store(adapter, new HydrationState());
    // Corpus full → no-op ABSOLU : aucun aller-retour réseau, liste vide (c'est le régime du lot 0).
    ck.eq((await s.hydrateAll()).length, 0, "tout full : hydrateAll est un no-op");
    ck.eq(adapter.listed.length, 0, "tout full : AUCUN fetch émis");

    // Deux collections lazy (none + partial) → hydrateAll recharge CES deux-là, et rien d'autre.
    s.hydration.declareLazy(["contacts", "attachments"]);
    s.hydration.noteAbsorption("attachments");   // partial : doit être rechargée aussi (on ignore ce qui manque)
    const hydrated = await s.hydrateAll();
    ck.eq(hydrated.sort().join(","), "attachments,contacts", "hydrateAll renvoie les collections rechargées");
    ck.eq(adapter.listed.slice().sort().join(","), "attachments,contacts", "seules les non-full ont été re-tirées");
    ck.eq(s.all("contacts").length, 2, "les lignes reçues sont absorbées en entités");
    ck(!!s.get("attachments", "a1"), "les entités absorbées sont INDEXÉES (get par id)");
    ck(s.hydration.isFullyHydrated(), "après hydrateAll : corpus intégralement hydraté");
    // Un toJSON d'export porte désormais le document ENTIER (c'est la finalité de G2).
    ck.eq(s.toJSON().contacts.length, 2, "toJSON post-hydrateAll : les contacts exportés au complet");

    // Idempotence : plus rien à recharger.
    adapter.listed.length = 0;
    ck.eq((await s.hydrateAll()).length, 0, "hydrateAll idempotent (tout est devenu full)");
    ck.eq(adapter.listed.length, 0, "idempotent : aucun fetch superflu");
  });

  await section("Store ⇄ G3 : reloadCollections saute les non hydratées + point d'accroche onLazyReloadDeferred", async () => {
    const adapter = makeFakeAdapter({
      equipments: [{ id: "e1", name: "Switch" }],
      contacts: [{ id: "c1", name: "Alice" }],
    });
    const s = new Store(adapter, new HydrationState());
    s.hydration.declareLazy(["contacts"]);
    const deferred = [];
    s.onLazyReloadDeferred = (collections) => deferred.push(...collections);

    // Plan SSE mixte : la collection hydratée se re-tire, la lazy est SAUTÉE (sinon le premier
    // événement d'un autre client annulerait le chargement paresseux).
    const reloaded = await s.reloadCollections(["contacts", "equipments"]);
    ck.eq(reloaded.join(","), "equipments", "seules les collections HYDRATÉES sont rechargées (retour)");
    ck.eq(adapter.listed.join(","), "equipments", "aucun fetch pour la collection lazy");
    ck.eq(deferred.join(","), "contacts", "le point d'accroche reçoit les collections sautées (compteurs au lot 1)");
    ck.eq(s.hydration.levelOf("contacts"), "none", "la collection sautée reste none (pas d'hydratation forcée)");
    ck.eq(s.all("contacts").length, 0, "le cache de la collection sautée n'est pas touché");

    // Plan ENTIÈREMENT lazy : zéro fetch, retour vide, accroche prévenue.
    adapter.listed.length = 0; deferred.length = 0;
    ck.eq((await s.reloadCollections(["contacts"])).length, 0, "plan tout-lazy : rien n'est rechargé");
    ck.eq(adapter.listed.length, 0, "plan tout-lazy : aucun aller-retour réseau");
    ck.eq(deferred.join(","), "contacts", "plan tout-lazy : l'accroche est prévenue quand même");

    // Après un re-tirage complet (via hydrateAll), la collection redevient éligible au rechargement SSE.
    await s.hydrateAll();
    adapter.listed.length = 0;
    ck.eq((await s.reloadCollections(["contacts"])).join(","), "contacts", "une collection redevenue full se recharge normalement");
    ck.eq(adapter.listed.join(","), "contacts", "et le fetch repart (comportement historique retrouvé)");
  });

};
