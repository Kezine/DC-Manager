/* Tests modules — LISTINGS SERVEUR-PILOTÉS (lot 3 du chantier recherche/chargement dynamique).
   ----------------------------------------------------------------------------
   Prouve les quatre pans du lot :
   1. RECHERCHE PARTAGÉE des listings (`core/RecordSearch` + `core/RecordSearchIndex`) : le texte
      cherché d'une ligne EST le contenu de la colonne `search` du serveur, la mémoïsation fonctionne
      et s'invalide, et la palette globale lit désormais la MÊME assiette (délégation).
   2. MOTEUR DE LIGNES (`core/ListRowEngine` + `core/StoreListRowSource`) : requête active ou non,
      bascule locale ⇄ serveur, affichage local pendant le vol, REPLI sur échec sans boucle,
      annulation de la requête devancée, mode fichier sans réseau, cible non mappable restreinte client.
   3. PARITÉ FICHIER ⇄ SERVEUR (better-sqlite3 RÉEL) : sur un même mini-corpus, la recherche d'un
      listing en mode fichier et le `list(collection, {query})` du serveur rendent les MÊMES ids.
   4. FILTRE CIBLE unifié : `FilterChips` étendu (dimension « à recherche », valeurs libres, reset),
      `TargetSearch.parse`, les descripteurs `ListTargets` (where IP serveur ⇄ restriction câbles
      à 2 sauts) sur un VRAI Store, et `TargetFilterDisplay` (badge du déclencheur fermé +
      placeholder du panneau — refonte 2026-08-03, maquette filtre-cible-porteur).
   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, SharedSchema, FilterChips, GlobalSearchSources, makeStore } = require("./harness.js");

const { RecordSearch } = D("core/RecordSearch.js");
const { RecordSearchIndex } = D("core/RecordSearchIndex.js");
const { ListRowEngine } = D("core/ListRowEngine.js");
const { StoreListRowSource } = D("core/StoreListRowSource.js");
const { ListTargets } = D("views/ListTargets.js");
const { TargetSearch } = D("core/TargetSearch.js");
const { SearchTerms } = SHARED("src-shared/SearchTerms.js");
const norm = SharedSchema.normSearch;

/* -------- better-sqlite3 RÉEL (même sonde/politique que test-search-terms : ÉCHEC actionnable, jamais
   un saut silencieux — la PARITÉ des deux modes ne doit pas passer sans preuve). -------- */
let SQLITE = null, SQLITE_ERROR = "";
try {
  const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
  new Candidate(":memory:").close();
  SQLITE = Candidate;
} catch (e) { SQLITE_ERROR = ((e && e.message) || String(e)).split("\n")[0]; }
const requireSqlite = () => {
  if (SQLITE) return true;
  ck(false, "better-sqlite3 RÉEL indisponible (" + SQLITE_ERROR + ") — `npm install` dans src-server/ ; ÉCHEC au lieu d'un saut (lot 3 listings)");
  return false;
};

/* -------- mini-corpus (mêmes formes que test-search-terms : records bruts façon démo) -------- */
const CORPUS = {
  sites: [{ id: "site-a", name: "Site Alpha" }],
  datacenters: [{ id: "dc-1", name: "Salle Nord", location: "site-a", floor: "2" }],
  racks: [{ id: "rk-1", name: "Baie B01", datacenter_id: "dc-1" }],
  equipments: [
    { id: "eq-rack", name: "SW-Coeur", type: "switch", placement_mode: "rack", rack_id: "rk-1", rack_u: 12 },
    { id: "eq-libre", name: "Robot-Salle", type: "other", dc_id: "dc-1" },
  ],
  subEquipments: [{ id: "se-1", name: "Drive LTO-9", serial: "SN-777", equipment_id: "eq-rack" }],
  ports: [{ id: "p-1", name: "Gi1/0/1", equipment_id: "eq-rack" }, { id: "p-2", name: "eth0", equipment_id: "eq-libre" }],
  cables: [{ id: "cb-1", name: "C-001", from_port_id: "p-1", to_port_id: "p-2", status: "cable" }],
  vms: [{ id: "vm-1", name: "srv-web", host_equipment_id: "eq-rack", orphan: true }],
  ipAddresses: [
    { id: "ip-1", address: "10.0.0.5", equipment_id: "eq-rack" },
    { id: "ip-2", address: "10.0.0.9", vm_id: "vm-1" },
  ],
};
const fetchOf = (collection, id) => (CORPUS[collection] || []).find((r) => r.id === id) || null;
const findOf = (collection, field, value) => (CORPUS[collection] || [])
  .filter((r) => (Array.isArray(r[field]) ? r[field].map(String).includes(String(value)) : String(r[field]) === String(value)));

/** Source de lignes FACTICE : le moteur ne connaît ni Store ni réseau, on lui injecte donc des tableaux
    et une promesse pilotée à la main (résolution/rejet différés). */
function fakeSource(localRows, remoteBehaviour) {
  const calls = { local: 0, remote: 0, signals: [] };
  return {
    calls,
    local() { calls.local++; return localRows.slice(); },
    remote(request, signal) {
      calls.remote++; calls.signals.push(signal);
      return remoteBehaviour ? remoteBehaviour(request, signal) : null;
    },
  };
}
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async () => {
  await section("Listings : RecordSearch — le texte cherché EST la colonne `search` du serveur", async () => {
  {
    const equipment = CORPUS.equipments[0];
    // -- PARITÉ STRICTE avec le module partagé : aucune reformulation cliente, une pure délégation. --
    ck.eq(RecordSearch.textOf("equipments", equipment, fetchOf, findOf),
      SearchTerms.searchText("equipments", equipment, fetchOf, findOf),
      "textOf ≡ SearchTerms.searchText (le CLIENT ne reformule rien — c'est le contenu de la colonne serveur)");

    // -- L'ASSIETTE s'est élargie : le relevé `searchFields` d'avant ne cherchait ni la baie, ni le
    //    sous-équipement, ni « U12 ». Tout cela matche désormais, en mode FICHIER comme en mode API. --
    const text = RecordSearch.textOf("equipments", equipment, fetchOf, findOf);
    ck(text.includes(norm("Baie B01")), "listing : un équipement se trouve par le nom de SA BAIE (terme dérivé)");
    ck(text.includes(norm("Drive LTO-9")), "listing : … par le nom d'un de ses SOUS-ÉQUIPEMENTS");
    ck(text.includes(norm("U12")), "listing : … par sa position « U12 » (composition tapable search-v2)");
    ck(text.includes(norm("SW-Coeur")), "listing : … et bien sûr par sa valeur PROPRE (aucun terme d'hier perdu)");
    ck(RecordSearch.textOf("vms", CORPUS.vms[0], fetchOf, findOf).includes(norm("orphan")),
      "listing : une VM orpheline se trouve par « orphan » en locale fr aussi (catalogue fr+en, principe n°15)");

    // -- `toJSON()` PRÉFÉRÉ quand il existe : c'est la forme DONNÉES que le serveur voit. --
    const withJson = { id: "x", toJSON: () => ({ id: "x", name: "Depuis toJSON" }), name: "Champ direct ignoré" };
    ck.eq(RecordSearch.jsonOf(withJson).name, "Depuis toJSON", "jsonOf : toJSON() prime sur les champs de l'instance");
    ck(RecordSearch.textOf("racks", withJson, fetchOf, findOf).includes(norm("Depuis toJSON")), "textOf : construit sur la forme canonique");
    ck.eq(RecordSearch.jsonOf(null).id, undefined, "jsonOf : entrée nulle tolérée (objet vide)");

    // -- TERMES (forme liste, palier 30 de la palette) : valeurs propres ÉTALÉES + dérivés. --
    const terms = RecordSearch.termsOf("equipments", equipment, fetchOf, findOf);
    ck(terms.includes("SW-Coeur") && terms.includes("Baie B01"), "termsOf : valeurs propres ET dérivés, en clair (le scoring normalise lui-même)");
  }
  });

  await section("Listings : RecordSearchIndex — mémoïsation, filtrage ≡ LIKE serveur, invalidation", async () => {
  {
    const index = new RecordSearchIndex(fetchOf, findOf);
    ck.eq(index.size, 0, "index NEUF : rien de mémoïsé (un listing sans recherche ne paie pas l'index)");

    const rows = CORPUS.equipments;
    ck.eq(index.filter("equipments", rows, "  ").map((r) => r.id).join(","), "eq-rack,eq-libre",
      "requête BLANCHE → toutes les lignes, telles quelles (aucun calcul)");
    ck.eq(index.size, 0, "requête blanche : rien n'a été indexé");

    ck.eq(index.filter("equipments", rows, "baie b01").map((r) => r.id).join(","), "eq-rack",
      "filtre : l'équipement se trouve par le nom de sa baie (assiette PARTAGÉE, pas l'ancien relevé)");
    ck.eq(index.size, 2, "filtre : les lignes VUES sont mémoïsées (une entrée par ligne)");
    ck.eq(index.filter("equipments", rows, "SALLE NORD").map((r) => r.id).join(","), "eq-libre",
      "filtre : casse ignorée (normalisation PARTAGÉE Schema.normSearch — la même que le serveur)");
    ck.eq(index.filter("equipments", rows, "introuvable-xyz").length, 0, "filtre : aucune correspondance → 0 ligne");

    // -- INVALIDATION : le texte d'une ligne dépend d'AUTRES enregistrements (renommer la baie change
    //    le texte de ses équipements) — sans invalidation, la recherche MENTIRAIT. --
    const before = CORPUS.racks[0].name;
    CORPUS.racks[0].name = "Baie Z99";
    ck.eq(index.filter("equipments", rows, "z99").length, 0, "index PÉRIMÉ : le nouveau nom de baie ne trouve rien (c'est le comportement à invalider)");
    index.invalidate();
    ck.eq(index.size, 0, "invalidate() : l'index est jeté");
    ck.eq(index.filter("equipments", rows, "z99").map((r) => r.id).join(","), "eq-rack", "après invalidation : le NOUVEAU nom de baie trouve l'équipement");
    CORPUS.racks[0].name = before;
    index.invalidate();

    // -- Ligne SANS id : calculée, jamais mise en cache (une clé indéterminée ferait collision). --
    ck.eq(index.filter("equipments", [{ name: "Sans identifiant" }], "sans identifiant").length, 1, "ligne sans id : filtrée quand même");
    ck.eq(index.size, 0, "ligne sans id : rien n'entre au cache");
  }
  });

  await section("Listings : ListRowEngine — requête active, bascule serveur, repli local, annulation", async () => {
  {
    const req = (query, target) => ({ collection: "equipments", query: query || "", target: target || null });

    // -- 1. « requête ACTIVE » : la règle PURE de la bascule. --
    ck(!ListRowEngine.isActive(req("")), "isActive : ni recherche ni cible → INACTIVE (le cache hydraté suffit)");
    ck(!ListRowEngine.isActive(req("   ")), "isActive : saisie blanche → INACTIVE (le serveur ignore une requête vide)");
    ck(ListRowEngine.isActive(req("sw")), "isActive : recherche saisie → ACTIVE");
    ck(ListRowEngine.isActive(req("", { kind: "equipment", id: "eq-1" })), "isActive : cible filtrée → ACTIVE (même sans saisie)");
    ck.eq(ListRowEngine.signature(req("sw ")), ListRowEngine.signature(req("sw")), "signature : la saisie est rognée (deux frappes équivalentes = une requête)");
    ck(ListRowEngine.signature(req("sw")) !== ListRowEngine.signature(req("sw", { kind: "equipment", id: "e1" })), "signature : la cible fait partie de l'identité");

    // -- 2. Requête INACTIVE : lignes LOCALES, aucun appel serveur. --
    {
      const source = fakeSource([{ id: "a" }, { id: "b" }], () => Promise.resolve([{ id: "serveur" }]));
      const engine = new ListRowEngine(source, () => {}, 0);
      ck.eq(engine.rows(req("")).map((r) => r.id).join(","), "a,b", "requête inactive → lignes LOCALES");
      await tick(5);
      ck.eq(source.calls.remote, 0, "requête inactive → le serveur n'est JAMAIS interrogé (le corpus est hydraté)");
      ck(!engine.fromRemote, "requête inactive → fromRemote faux");
      engine.reset();
    }

    // -- 3. Mode FICHIER (source sans serveur) : requête active, mais rien ne part sur le réseau. --
    {
      const source = fakeSource([{ id: "local-1" }], () => null);
      const engine = new ListRowEngine(source, () => {}, 0);
      ck.eq(engine.rows(req("sw")).map((r) => r.id).join(","), "local-1", "mode fichier : la recherche est servie LOCALEMENT");
      await tick(5);
      ck.eq(source.calls.remote, 1, "mode fichier : la source est bien SOLLICITÉE…");
      ck(!engine.fromRemote, "… mais elle rend null → aucune bascule serveur (principe n°15)");
      engine.reset();
    }

    // -- 4. Mode API : local PENDANT le vol, puis bascule serveur + repeint. --
    {
      let resolveRemote;
      const source = fakeSource([{ id: "local-1" }], () => new Promise((res) => { resolveRemote = res; }));
      let repaints = 0;
      const engine = new ListRowEngine(source, () => { repaints++; }, 0);
      ck.eq(engine.rows(req("sw")).map((r) => r.id).join(","), "local-1", "mode API : le LOCAL s'affiche pendant l'anti-rebond/le vol (le listing ne blanchit pas)");
      await tick(5);
      resolveRemote([{ id: "srv-1" }, { id: "srv-2" }]);
      await tick(5);
      ck.eq(repaints, 1, "réponse serveur → UN repeint demandé");
      ck.eq(engine.rows(req("sw")).map((r) => r.id).join(","), "srv-1,srv-2", "réponse en main → les lignes viennent du SERVEUR");
      ck(engine.fromRemote, "fromRemote vrai (le jeu est plafonné — limite v1 documentée)");
      ck.eq(source.calls.remote, 1, "la réponse COUVRE la requête → aucune seconde requête");
      // la saisie AVANCE : la réponse ne couvre plus, on retombe sur le local et on reprogramme.
      ck.eq(engine.rows(req("swi")).map((r) => r.id).join(","), "local-1", "saisie avancée → repli LOCAL immédiat (la réponse en main ne la couvre plus)");
      await tick(5);
      ck.eq(source.calls.remote, 2, "saisie avancée → nouvelle requête serveur");
      engine.reset();
    }

    // -- 4bis. Requête DÉJÀ en vol : un rendu qui ne CHANGE PAS la requête (clic de tri, page suivante,
    //    re-rendu externe) ne doit pas l'annuler pour la relancer à l'identique. --
    {
      let resolveRemote;
      const source = fakeSource([{ id: "local-1" }], () => new Promise((res) => { resolveRemote = res; }));
      const engine = new ListRowEngine(source, () => {}, 0);
      engine.rows(req("sw")); await tick(5);
      ck.eq(source.calls.remote, 1, "requête programmée puis tirée");
      engine.rows(req("sw")); engine.rows(req("sw")); await tick(5);
      ck.eq(source.calls.remote, 1, "🎯 requête EN VOL : deux rendus de plus (tri, page) ne la relancent PAS");
      ck(!source.calls.signals[0].aborted, "… et ne l'annulent pas non plus (sa réponse n'est pas retardée)");
      resolveRemote([{ id: "srv" }]);
      await tick(5);
      ck.eq(engine.rows(req("sw")).map((r) => r.id).join(","), "srv", "la réponse finit par arriver et s'appliquer");
      engine.reset();
    }

    // -- 4ter. Mode FICHIER : la source rend null → le verdict est MÉMORISÉ (aucune reprogrammation). --
    {
      const source = fakeSource([{ id: "local-1" }], () => null);
      const engine = new ListRowEngine(source, () => {}, 0);
      engine.rows(req("sw")); await tick(5);
      engine.rows(req("sw")); await tick(5);
      ck.eq(source.calls.remote, 1, "mode fichier : la source n'est sollicitée QU'UNE fois par requête (verdict mémorisé)");
      engine.reset();
    }

    // -- 5. ÉCHEC serveur : repli local SILENCIEUX, et surtout AUCUNE boucle de reprogrammation. --
    {
      const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
      try {
        const source = fakeSource([{ id: "local-1" }], () => Promise.reject(new Error("503")));
        const engine = new ListRowEngine(source, () => {}, 0);
        engine.rows(req("sw"));
        await tick(5);
        ck.eq(warned, 1, "échec serveur → une trace console (diagnostic volontaire), aucune UI d'erreur");
        ck.eq(engine.rows(req("sw")).map((r) => r.id).join(","), "local-1", "échec serveur → REPLI sur les lignes locales");
        await tick(5);
        ck.eq(source.calls.remote, 1, "🎯 échec MÉMORISÉ : le rendu suivant ne reprogramme PAS la même requête (pas de boucle)");
        // une AUTRE requête reste tentée : l'échec est propre à sa signature.
        engine.rows(req("autre"));
        await tick(5);
        ck.eq(source.calls.remote, 2, "échec : une requête DIFFÉRENTE est toujours tentée");
        engine.reset();
      } finally { console.warn = warn; }
    }

    // -- 6. ANNULATION : la requête devancée est abandonnée (AbortController), sa réponse est ignorée. --
    {
      const pending = [];
      const source = fakeSource([{ id: "local-1" }], () => new Promise((res) => { pending.push(res); }));
      let repaints = 0;
      const engine = new ListRowEngine(source, () => { repaints++; }, 0);
      engine.rows(req("s")); await tick(5);
      engine.rows(req("sw")); await tick(5);
      ck.eq(source.calls.remote, 2, "deux saisies → deux requêtes");
      ck(source.calls.signals[0].aborted, "🎯 la requête PRÉCÉDENTE est ANNULÉE (AbortController — parité palette)");
      pending[0]([{ id: "perime" }]);   // réponse périmée : elle ne doit RIEN peindre
      await tick(5);
      ck.eq(repaints, 0, "réponse périmée (annulée) → aucun repeint");
      pending[1]([{ id: "frais" }]);
      await tick(5);
      ck.eq(engine.rows(req("sw")).map((r) => r.id).join(","), "frais", "la réponse FRAÎCHE, elle, s'applique");

      // -- 7. `reset()` : tout état serveur meurt (changement d'onglet). --
      engine.reset();
      ck(!engine.fromRemote, "reset : plus de jeu serveur en main");
      ck.eq(engine.rows(req("sw")).map((r) => r.id).join(","), "local-1", "reset : on repart du local");
      engine.reset();
    }

    // -- 8. Retour au REPOS : l'état serveur est jeté (une réponse en vol n'a plus d'objet). --
    {
      const source = fakeSource([{ id: "local-1" }], () => Promise.resolve([{ id: "srv" }]));
      const engine = new ListRowEngine(source, () => {}, 0);
      engine.rows(req("sw")); await tick(5);
      ck.eq(engine.rows(req("sw")).map((r) => r.id).join(","), "srv", "jeu serveur en main");
      ck.eq(engine.rows(req("")).map((r) => r.id).join(","), "local-1", "champ vidé → retour au LOCAL immédiat");
      ck.eq(engine.rows(req("sw")).map((r) => r.id).join(","), "local-1", "… et l'ancien jeu serveur a bien été JETÉ (il n'est pas ressorti du chapeau)");
      engine.reset();
    }

    // -- 9. ÉCRITURE sous filtre ACTIF : la ligne CRÉÉE qui matche doit apparaître au re-rendu (lot R2). --
    //    🐛 PANNE D'ORIGINE (mode API) : le jeu serveur `remoteRows` est mémoïsé PAR SIGNATURE de requête
    //    (collection + saisie + cible), et une écriture ne change PAS cette signature. Après « dupliquer »
    //    un équipement sous un filtre « Bidon », `rows()` ressortait le jeu serveur d'AVANT la copie —
    //    « Bidon (Copie) » restait invisible tant qu'on ne vidait/re-saisissait pas le filtre (autre
    //    signature). Le filet `Store.onChange` du ListView invalidait bien l'index de recherche et la page
    //    serveur (`forgetPage`), mais RIEN ne jetait `remoteRows` : d'où `forgetRemote()`, jumeau de
    //    `forgetPage()`, appelé au même point. (Le mode FICHIER, lui, n'a jamais eu le bug : son chemin
    //    `local()` recalcule à chaque rendu — cf. section « StoreListRowSource ».)
    {
      const server = [{ id: "bidon", name: "Bidon" }];   // ce que le serveur renvoie pour « bidon »
      const local = [{ id: "bidon", name: "Bidon" }];    // le cache local — muté par la « duplication »
      const source = fakeSource(local, () => Promise.resolve(server.slice()));
      const engine = new ListRowEngine(source, () => {}, 0);
      const reqBidon = { collection: "equipments", query: "bidon", target: null };
      engine.rows(reqBidon); await tick(5);
      ck.eq(engine.rows(reqBidon).map((r) => r.id).join(","), "bidon", "jeu serveur en main pour le filtre « bidon »");

      // « Dupliquer » : la copie entre au cache LOCAL (Store.create) ET au serveur (persistée) — elle matche le filtre.
      local.push({ id: "bidon-copie", name: "Bidon (Copie)" });
      server.push({ id: "bidon-copie", name: "Bidon (Copie)" });

      // Re-rendu SANS invalidation : signature inchangée → le jeu serveur mémoïsé RESSORT, la copie est INVISIBLE
      // (c'est très exactement le symptôme mesuré par l'utilisateur — le bug à corriger).
      ck.eq(engine.rows(reqBidon).map((r) => r.id).join(","), "bidon",
        "🐛 sans invalidation : la copie N'APPARAÎT PAS (jeu serveur mémoïsé, signature inchangée)");

      // CORRECTIF : le filet `Store.onChange` appelle `forgetRemote()` → la copie apparaît IMMÉDIATEMENT
      // depuis le LOCAL (pendant le vol), et une nouvelle requête serveur est reprogrammée.
      engine.forgetRemote();
      ck.eq(engine.rows(reqBidon).map((r) => r.id).sort().join(","), "bidon,bidon-copie",
        "✅ après forgetRemote() : la copie apparaît (lignes LOCALES pendant le vol, même filtre actif)");
      await tick(5);
      ck.eq(engine.rows(reqBidon).map((r) => r.id).sort().join(","), "bidon,bidon-copie",
        "✅ … puis le serveur RÉ-INTERROGÉ renvoie bien les deux lignes");
      ck.eq(source.calls.remote, 2, "forgetRemote() a REPROGRAMMÉ une requête serveur (le jeu périmé n'a pas été gardé)");
      engine.reset();
    }
  }
  });

  await section("Listings : StoreListRowSource — where serveur, restriction cliente, mode fichier", async () => {
  {
    const store = await makeStore();
    const rack = await store.create("racks", { name: "Baie B01" });
    const sw = await store.create("equipments", { name: "SW-Coeur", type: "switch", placement_mode: "rack", rack_id: rack.id, rack_u: 12 });
    const other = await store.create("equipments", { name: "Robot-Salle", type: "other" });
    const p1 = await store.create("ports", { equipment_id: sw.id, name: "Gi1/0/1" });
    const p2 = await store.create("ports", { equipment_id: other.id, name: "eth0" });
    const cableIn = await store.create("cables", { name: "C-001", from_port_id: p1.id, to_port_id: p2.id });
    const cableOut = await store.create("cables", { name: "C-002" });
    const net = await store.create("ipNetworks", { cidr: "10.0.0.0/24", label: "LAN" });
    const ipSw = await store.create("ipAddresses", { address: "10.0.0.5", network_id: net.id, equipment_id: sw.id });
    const ipFree = await store.create("ipAddresses", { address: "10.0.0.9", network_id: net.id });
    const index = new RecordSearchIndex((c, id) => store.get(c, id), (c, f, v) => store.findByField(c, f, v));
    const req = (collection, query, target) => ({ collection, query: query || "", target: target || null });

    // -- MODE FICHIER (aucun lecteur serveur) : `remote` rend TOUJOURS null. --
    const fileSource = new StoreListRowSource(store, index, ListTargets.ipCarrier(store), null);
    ck.eq(fileSource.remote(req("ipAddresses", "10.0.0"), new AbortController().signal), null,
      "mode fichier : aucun chemin serveur, quelle que soit la requête (principe n°15)");
    ck.eq(fileSource.local(req("ipAddresses", "sw-coeur")).map((r) => r.id).join(","), ipSw.id,
      "mode fichier : l'IP se trouve par le nom de son ÉQUIPEMENT (terme dérivé partagé)");
    ck.eq(fileSource.local(req("ipAddresses", "", { kind: "equipment", id: sw.id })).map((r) => r.id).join(","), ipSw.id,
      "mode fichier : la CIBLE restreint en mémoire (equipment_id)");
    ck.eq(fileSource.local(req("ipAddresses", "", { kind: "vm", id: "vm-fantome" })).length, 0, "cible VM sans correspondance → 0 ligne");
    ck.eq(fileSource.local(req("ipAddresses", "", { kind: "inconnu", id: "x" })).length, 0,
      "famille INCONNUE → 0 ligne (jamais « toutes » : un filtre posé sans effet serait invisible)");

    // -- MODE API : la cible IP devient un `where` serveur ; la requête est transmise telle quelle. --
    const seen = [];
    const reader = { list: (collection, options) => { seen.push({ collection, ...options }); return Promise.resolve([{ id: "srv-1" }]); } };
    const apiSource = new StoreListRowSource(store, index, ListTargets.ipCarrier(store), reader);
    await apiSource.remote(req("ipAddresses", "10.0.0", { kind: "equipment", id: sw.id }), new AbortController().signal);
    ck.eq(JSON.stringify(seen[0].where), JSON.stringify({ equipment_id: sw.id }), "mode API : cible ÉQUIPEMENT → where { equipment_id } (le serveur filtre)");
    ck.eq(seen[0].query, "10.0.0", "mode API : la recherche part au serveur (colonne `search` enrichie)");
    ck.eq(seen[0].limit, StoreListRowSource.REMOTE_LIMIT, "mode API : plafond NOMMÉ transmis au lecteur");
    await apiSource.remote(req("ipAddresses", "", { kind: "vm", id: "vm-1" }), new AbortController().signal);
    ck.eq(JSON.stringify(seen[1].where), JSON.stringify({ vm_id: "vm-1" }), "mode API : cible VM → where { vm_id } (le OU porte sur la FAMILLE choisie, pas sur une requête OR)");
    ck.eq(apiSource.remote(req("ipAddresses", ""), new AbortController().signal), null,
      "mode API : ni recherche ni cible → aucun aller-retour (le cache hydraté fait foi)");

    // -- CÂBLES : 2 SAUTS (câble → port → équipement) — aucun `where`, restriction CLIENTE des lignes reçues. --
    const cableFilter = ListTargets.cableEquipment(store);
    const cableSource = new StoreListRowSource(store, index, cableFilter, reader);
    ck.eq(cableFilter.where("equipment", sw.id), null, "câbles : la cible n'est PAS traduisible en where (le serveur ne fait pas les 2 sauts)");
    ck.eq(cableSource.remote(req("cables", "", { kind: "equipment", id: sw.id }), new AbortController().signal), null,
      "câbles : cible seule, sans saisie → RIEN à demander au serveur (restriction locale suffisante)");
    ck.eq(cableSource.local(req("cables", "", { kind: "equipment", id: sw.id })).map((r) => r.id).join(","), cableIn.id,
      "câbles : la restriction CLIENTE traverse les ports (C-001 rattaché, C-002 non)");
    // avec une saisie : le serveur répond sur la seule recherche, la cible taille ENSUITE côté client.
    const restricted = await cableSource.remote(req("cables", "c-00", { kind: "equipment", id: sw.id }), new AbortController().signal);
    ck.eq(restricted.length, 0, "câbles : les lignes REÇUES sont re-restreintes par la cible (ligne serveur hors périmètre écartée)");
    ck.eq(seen[seen.length - 1].where, null, "câbles : la requête serveur ne porte QUE la recherche (where null)");

    // -- Sanité : les lignes non ciblées existent bien (le test ci-dessus ne réussit pas par vacuité). --
    ck.eq(cableSource.local(req("cables", "")).length, 2, "sanité : 2 câbles au document");
    ck.eq(fileSource.local(req("ipAddresses", "")).map((r) => r.id).sort().join(",") === [ipSw.id, ipFree.id].sort().join(","), true, "sanité : 2 adresses au document");
    ck.eq(cableOut.id.length > 0, true, "sanité : le câble hors périmètre existe");
  }
  });

  await section("Listings : PARITÉ mode fichier ⇄ mode API (better-sqlite3 RÉEL, mêmes ids)", async () => {
  {
    if (!requireSqlite()) return;
    const { RelationalRepository } = SERVER("RelationalRepository.js");
    const repo = RelationalRepository.open(":memory:", SQLITE);
    for (const [collection, records] of Object.entries(CORPUS)) records.forEach((r) => repo.upsert(collection, r, 1));

    const index = new RecordSearchIndex(fetchOf, findOf);
    // GOLDEN : pour chaque (collection, requête), les ids trouvés LOCALEMENT et par le serveur doivent
    // coïncider — c'est l'invariant central du lot 3 (« comportement IDENTIQUE des deux modes »).
    const cases = [
      ["equipments", "baie b01", "eq-rack"],                  // terme dérivé (lien)
      ["equipments", "drive lto-9", "eq-rack"],               // terme dérivé (enfants)
      ["equipments", "u12", "eq-rack"],                       // composition tapable search-v2
      ["equipments", "SW-COEUR", "eq-rack"],                  // valeur propre, casse différente
      ["equipments", "salle nord", "eq-libre"],               // salle libre
      ["equipments", "switch", "eq-rack"],                    // catalogue de type
      ["subEquipments", "drive lto-9", "se-1"],               // sous-équipement par son NOM propre
      ["subEquipments", "sn-777", "se-1"],                    // … et par son NUMÉRO DE SÉRIE (ownText)
      ["cables", "sw-coeur", "cb-1"],                         // 2 sauts (port → équipement)
      ["cables", "gi1/0/1", "cb-1"],                          // nom de port
      ["vms", "orphan", "vm-1"],                              // catalogue fr+en
      ["vms", "sw-coeur", "vm-1"],                            // hôte
      ["ipAddresses", "srv-web", "ip-2"],                     // porteur VM
      ["ipAddresses", "sw-coeur", "ip-1"],                    // porteur équipement
      ["racks", "salle nord", "rk-1"],                        // baie → salle
      ["racks", "42 u", "rk-1"],                              // composition « 42 U » (défaut client reproduit)
      ["equipments", "introuvable-xyz", ""],                  // aucun résultat des DEUX côtés
    ];
    let diverged = 0;
    for (const [collection, query, expected] of cases) {
      const local = index.filter(collection, CORPUS[collection], query).map((r) => r.id).sort().join(",");
      const server = repo.list(collection, { query }).rows.map((r) => r.id).sort().join(",");
      ck.eq(local, expected, "fichier : " + collection + " « " + query + " »");
      ck.eq(server, expected, "serveur : " + collection + " « " + query + " »");
      if (local !== server) diverged++;
    }
    ck.eq(diverged, 0, "🎯 PARITÉ : aucune divergence fichier ⇄ serveur sur les " + cases.length + " requêtes golden");
    repo.close();
  }
  });

  await section("Filtre CIBLE : TargetSearch.parse + FilterChips étendu (dimension « à recherche »)", async () => {
  {
    // -- Codec de valeur : `key`/`parse` sont inverses, et un id à deux-points survit. --
    ck.eq(TargetSearch.parse(TargetSearch.key("equipment", "eq-1")).kind, "equipment", "parse ∘ key : famille restituée");
    ck.eq(TargetSearch.parse(TargetSearch.key("equipment", "eq-1")).id, "eq-1", "parse ∘ key : identifiant restitué");
    ck.eq(TargetSearch.parse("vm:a:b:c").id, "a:b:c", "parse : le séparateur est le PREMIER « : » (un id à deux-points reste intact)");
    ck.eq(TargetSearch.parse("sansseparateur"), null, "parse : forme invalide → null (une valeur libre n'est jamais présumée saine)");
    ck.eq(TargetSearch.parse(":orphelin"), null, "parse : famille vide → null");
    ck.eq(TargetSearch.parse("equipment:"), null, "parse : identifiant vide → null");
    ck.eq(TargetSearch.parse(""), null, "parse : chaîne vide → null");

    // -- Chips : une dimension « à recherche » n'a PAS d'options ; son libellé vient de l'accesseur. --
    const dims = [
      { key: "status", label: "Statut", options: [{ id: "ok", label: "OK" }, { id: "ko", label: "KO" }] },
      { key: "__target__", label: "Cible", options: [], search: true },
    ];
    const sel = (m) => (k) => m[k];
    const labels = { "equipment:eq-1": "SW-Coeur" };
    const labelOf = (_dimKey, valueId) => labels[valueId];

    const state = { status: new Set(["ko"]), __target__: new Set(["equipment:eq-1"]) };
    const chips = FilterChips.build(dims, sel(state), labelOf);
    ck.eq(chips.length, 2, "dimension à recherche : sa valeur produit un chip comme les autres");
    ck.eq(chips[1].dimKey, "__target__", "chip de cible : dimKey");
    ck.eq(chips[1].dimLabel, "Cible", "chip de cible : dimLabel (« Cible : SW-Coeur » au rendu)");
    ck.eq(chips[1].valueId, "equipment:eq-1", "chip de cible : la valeur reste la clé « kind:id »");
    ck.eq(chips[1].valueLabel, "SW-Coeur", "chip de cible : le LIBELLÉ vient de l'accesseur (jamais persisté → jamais périmé)");
    ck.eq(chips[1].key, FilterChips.keyOf("__target__", "equipment:eq-1"), "chip de cible : clé stable");
    ck.eq(FilterChips.count(dims, sel(state)), 2, "count : la valeur libre compte (bouton « Réinitialiser » visible)");

    // -- Valeur libre SANS options : elle ne doit PAS être purgée comme une « option disparue ». --
    ck.eq(FilterChips.build(dims, sel({ __target__: new Set(["vm:vm-9"]) })).length, 1,
      "🎯 valeur libre CONSERVÉE malgré l'absence d'options (la purge des options ne s'y applique pas)");
    ck.eq(FilterChips.build(dims, sel({ __target__: new Set(["vm:vm-9"]) }))[0].valueLabel, "vm:vm-9",
      "libellé introuvable → repli sur l'identifiant (le filtre reste VISIBLE, donc retirable)");
    ck.eq(FilterChips.build(dims, sel({ __target__: new Set(["vm:vm-9"]) }), () => "")[0].valueLabel, "vm:vm-9",
      "libellé VIDE → même repli (une chip sans texte serait un filtre fantôme)");
    ck.eq(FilterChips.build(dims, sel({ status: new Set(["fantome"]) })).length, 0,
      "parité : sur une dimension à OPTIONS, la valeur disparue reste ignorée (comportement historique intact)");

    // -- « Réinitialiser » : le retrait passe par le Set, comme pour toute dimension. --
    state.__target__.clear();
    ck.eq(FilterChips.build(dims, sel(state), labelOf).length, 1, "cible retirée → il ne reste que les chips de dimension");
    ck.eq(FilterChips.count(dims, sel({})), 0, "état vide → 0 chip (bouton « Réinitialiser » masqué)");
  }
  });

  await section("Filtre CIBLE : TargetFilterDisplay — badge du déclencheur fermé + placeholder du panneau", async () => {
  {
    // Refonte 2026-08-03 (maquette filtre-cible-porteur §2/§10) : la dimension « à recherche » est un
    // déclencheur FERMÉ ; son badge et le placeholder du panneau sortent de ce module PUR (l'i18n et
    // le DOM restent dans ui/FilterBar).
    const { TargetFilterDisplay } = D("core/TargetFilterDisplay.js");
    const labels = { "equipment:eq-1": "SW-Coeur" };
    const labelOf = (valueId) => labels[valueId] || null;

    // -- Badge : (Tous) / NOM / compteur — la logique sait DÉJÀ le multi (borne v1 ailleurs). --
    ck.eq(TargetFilterDisplay.badge([], labelOf).kind, "all", "badge : aucune cible → (Tous), parité MultiSelect vide");
    const one = TargetFilterDisplay.badge(["equipment:eq-1"], labelOf);
    ck.eq(one.kind + "/" + one.label, "name/SW-Coeur", "badge : UNE cible → le NOM de l'entité (résolu à chaque rendu)");
    const gone = TargetFilterDisplay.badge(["vm:vm-9"], labelOf);
    ck.eq(gone.kind + "/" + gone.label, "name/vm:vm-9",
      "badge : libellé introuvable → repli sur l'identifiant (parité chips — jamais un badge vide pour un filtre actif)");
    ck.eq(TargetFilterDisplay.badge(["a:1"], () => "").label, "a:1", "badge : libellé VIDE → même repli");
    const two = TargetFilterDisplay.badge(["a:1", "b:2"], labelOf);
    ck.eq(two.kind + "/" + two.count, "count/2", "🎯 badge : 2 cibles et plus → le COMPTEUR (multi OR anticipé, maquette §2)");

    // -- Placeholder : dimension / « Remplacer par… » (mono) / « Ajouter… » (multi). --
    ck.eq(TargetFilterDisplay.placeholder(0, 1), "dimension", "placeholder : rien de posé → celui de la dimension");
    ck.eq(TargetFilterDisplay.placeholder(1, 1), "replace", "placeholder : mono avec cible → « Remplacer par… » (choisir remplace)");
    ck.eq(TargetFilterDisplay.placeholder(0, 4), "dimension", "placeholder : multi SANS cible → celui de la dimension aussi");
    ck.eq(TargetFilterDisplay.placeholder(1, 4), "add",
      "placeholder : multi avec cible → « Ajouter… » (lever la borne v1 suffit, rien d'autre à changer)");
    ck.eq(TargetFilterDisplay.placeholder(3, 4), "add", "placeholder : multi, plusieurs cibles → « Ajouter… »");
  }
  });

  await section("Filtre CIBLE : descripteurs ListTargets (recherche, libellés, mono-cible) sur un vrai Store", async () => {
  {
    const store = await makeStore();
    const sw = await store.create("equipments", { name: "SW-Coeur", type: "switch" });
    await store.create("equipments", { name: "Routeur-Bord", type: "other" });
    const vm = await store.create("vms", { name: "srv-web" });

    // `search` est ASYNCHRONE depuis le lot 4 (serveur-pilotée en mode API ; ici, reader null → LOCAL,
    // promesse résolue) : on AWAIT. Le comportement des candidats est verrouillé, en propre, par test-entity-candidates.js.
    const carrier = ListTargets.ipCarrier(store);
    const found = await carrier.search("sw");
    ck.eq(found.length, 1, "ipCarrier : la recherche traverse les familles et borne (une seule correspondance ici)");
    ck.eq(found[0].kind + "/" + found[0].label, "equipment/SW-Coeur", "ipCarrier : candidat {kind,label}");
    const both = await carrier.search("r");
    ck(both.some((r) => r.kind === "vm") && both.some((r) => r.kind === "equipment"),
      "ipCarrier : équipements ET VMs dans LA MÊME liste (principe n°14 — pas un select par famille)");
    ck.eq(carrier.labelOf("equipment", sw.id), "SW-Coeur", "ipCarrier : libellé d'une cible existante");
    ck.eq(carrier.labelOf("vm", vm.id), "srv-web", "ipCarrier : libellé d'une VM");
    ck.eq(carrier.labelOf("equipment", "disparu"), null, "ipCarrier : cible disparue → null (la chip affiche « (supprimé) »)");
    ck.eq(carrier.labelOf("inconnu", sw.id), null, "ipCarrier : famille hors périmètre → null");
    ck(carrier.tagOf("equipment") !== "" && carrier.tagOf("vm") !== "", "ipCarrier : badge de FAMILLE (deux familles confondues → il faut les distinguer)");
    ck.eq((await carrier.search("   ")).length, 0, "recherche vide → aucun candidat (on n'inonde pas le popover)");
    ck((await carrier.search("x".repeat(3))).length === 0, "recherche sans correspondance → aucun candidat");

    const cables = ListTargets.cableEquipment(store);
    ck.eq(cables.tagOf("equipment"), "", "cableEquipment : famille UNIQUE → aucun badge (il n'apprendrait rien)");
    ck.eq((await cables.search("srv-web")).length, 0, "cableEquipment : les VMs ne sont PAS candidates (un câble n'aboutit pas sur une VM)");
    ck.eq((await cables.search("sw"))[0].id, sw.id, "cableEquipment : l'équipement, lui, est candidat");
    ck.eq(ListTargets.SEARCH_LIMIT, 12, "plafond de candidats = constante nommée (parité éditeur de liens d'intervention)");

    // -- subEquipmentMaster : le cas SIMPLE (1 saut, `equipment_id` colonne indexée → where MAPPABLE) — à
    //    opposer à cableEquipment (2 sauts, restriction cliente). Famille UNIQUE (jamais une VM). --
    const master = ListTargets.subEquipmentMaster(store);
    ck.eq(JSON.stringify(master.where("equipment", sw.id)), JSON.stringify({ equipment_id: sw.id }), "subEquipmentMaster : cible ÉQUIPEMENT → where { equipment_id } (le serveur filtre, 1 saut indexé)");
    ck.eq(master.where("vm", "x"), null, "subEquipmentMaster : famille hors périmètre → where null");
    ck.eq(master.tagOf("equipment"), "", "subEquipmentMaster : famille UNIQUE → aucun badge");
    ck.eq((await master.search("srv-web")).length, 0, "subEquipmentMaster : les VMs ne sont PAS candidates (un sous-équipement n'appartient qu'à un équipement)");
    ck.eq((await master.search("sw"))[0].id, sw.id, "subEquipmentMaster : l'équipement est candidat");
    ck.eq(master.restrict([{ id: "a", equipment_id: sw.id }, { id: "b", equipment_id: "autre" }], "equipment", sw.id).map((r) => r.id).join(","), "a", "subEquipmentMaster : restriction cliente par equipment_id (mode fichier)");
    ck.eq(master.restrict([{ id: "a", equipment_id: sw.id }], "vm", sw.id).length, 0, "subEquipmentMaster : famille inconnue → 0 ligne (jamais « toutes »)");
  }
  });

  await section("Listings : la PALETTE globale lit la MÊME assiette que les listings (délégation)", async () => {
  {
    const store = await makeStore();
    const rack = await store.create("racks", { name: "Baie B01" });
    const sw = await store.create("equipments", { name: "SW-Coeur", type: "switch", placement_mode: "rack", rack_id: rack.id, rack_u: 12 });
    const item = GlobalSearchSources.itemOf(store, "equipments", sw);
    const index = new RecordSearchIndex((c, id) => store.get(c, id), (c, f, v) => store.findByField(c, f, v));
    const listingText = index.textOf("equipments", sw);
    // Les deux surfaces n'ont pas la même FORME (liste de termes bruts vs texte normalisé) mais elles
    // couvrent le même contenu : tout terme de la palette est cherchable dans le listing.
    const missing = item.terms
      .filter((t) => t != null && t !== "" && norm(t) !== "")
      .filter((t) => !listingText.includes(norm(t)));
    ck.eq(missing.length, 0, "🎯 tout terme de la PALETTE est présent dans le texte cherché du LISTING (une seule définition, deux formes) — manquants : " + JSON.stringify(missing));
    ck(listingText.includes(norm("Baie B01")), "sanité : le terme dérivé y est bien (le test ne réussit pas par vacuité)");
  }
  });
};
