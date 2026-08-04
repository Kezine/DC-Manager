/* Tests modules — FEATURE « CLIENTS WIFI » (module serveur AMOVIBLE `wifi/` + collection partagée).
   ----------------------------------------------------------------------------
   Couvre, du plus pur au plus intégré :
   1. la FRONTIÈRE source/locaux partagée (`src-shared/WifiSync`) et sa consommation par le
      modèle client — c'est l'invariant qui empêche les FAUX DELTAS de synchro ;
   2. la collection `wifiClients` dans les mécaniques transverses : cascade (détachement de l'AP),
      spec de recherche (AP résolu + catalogue « déconnecté » fr/en verrouillé sur les locales) ;
   3. le DÉCODAGE UniFi PUR (tolérance : formes pleines/creuses/inattendues) et la PAGINATION pure
      (premier précédent de pagination sortante du dépôt) ;
   4. l'ORCHESTRATION de l'adaptateur avec un client HTTP STUB (structurel, sans réseau) ;
   5. la VALIDATION d'un provider — champs communs + branche d'options PAR MARQUE (décision D9) ;
   6. le STOCKAGE chiffré (better-sqlite3 RÉEL) : CRUD sans fuite de jeton, sentinelle, options ;
   7. la RÉCONCILIATION pure (création/patch minimal/idempotence/déconnexion/retour/périmètre) ;
   8. la SYNCHRO de bout en bout sur DocumentStore RÉEL (écritures, rev, SSE, statut) ;
   9. les invariants d'AGNOSTICISME DE MARQUE (fabrique ⇄ table d'options, aucun « unifi » hors
      des points d'extension) — c'est le critère d'acceptation de D9, donc il est TESTÉ.
   Harnais et assertions : harness.js. Doctrine de la feature : docs/wifi-unifi.md. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, Validation, Cascade, SharedSchema, EntityRegistry } = require("./harness.js");

module.exports = async () => {
  const { WifiSync, WIFI_SOURCE_FIELDS } = SHARED("src-shared/WifiSync.js");
  const { SearchTerms, SEARCH_CATALOGS } = SHARED("src-shared/SearchTerms.js");
  const { WifiClient } = D("models/WifiClient.js");

  /* ============ PARTAGÉ : frontière SOURCE / LOCAUX ============ */

  await section("shared : WifiSync — frontière source/locaux (défauts, égalité, délégation du modèle)", async () => {
  {
    // -- normalizeSource : chaînes jamais nulles, booléen STRICT. Ce sont EXACTEMENT les défauts
    //    de la spec `wifiClients` : un écart ferait diverger le document et le diff de synchro. --
    const empty = WifiSync.normalizeSource({});
    ck.eq(WIFI_SOURCE_FIELDS.length, 12, "WIFI_SOURCE_FIELDS : 12 champs source déclarés");
    ck(WIFI_SOURCE_FIELDS.every((f) => f in empty), "normalizeSource : produit TOUS les champs de la liste canonique");
    ck.eq(empty.name, "", "normalizeSource : name absent → \"\" (jamais null — cas NOMINAL côté wifi)");
    ck.eq(empty.ip, "", "normalizeSource : ip absente → \"\"");
    ck.eq(empty.orphan, false, "normalizeSource : orphan absent → false");
    ck.eq(WifiSync.normalizeSource({ orphan: "oui" }).orphan, false, "normalizeSource : orphan non booléen → false (=== true strict)");
    ck.eq(WifiSync.normalizeSource({ orphan: true }).orphan, true, "normalizeSource : orphan true conservé");
    ck.eq(WifiSync.normalizeSource({ mac: null, ssid: undefined }).mac, "", "normalizeSource : null/undefined → \"\" (aucun null silencieux)");

    // -- sourceEquals : compare des états NORMALISÉS champ à champ. --
    const a = WifiSync.normalizeSource({ ext_id: "aa:bb", name: "poste-12", client_type: "wireless" });
    const b = WifiSync.normalizeSource({ ext_id: "aa:bb", name: "poste-12", client_type: "wireless", notes: "local" });
    ck(WIFI_SOURCE_FIELDS.every((f) => WifiSync.sourceEquals(a, b, f)), "sourceEquals : un champ LOCAL en plus ne crée AUCUN écart de source");
    ck(!WifiSync.sourceEquals(a, WifiSync.normalizeSource({ ...a, ssid: "GUEST" }), "ssid"), "sourceEquals : un champ source modifié est détecté");

    // -- INVARIANT DE DÉLÉGATION : le modèle client doit produire les MÊMES valeurs source que la
    //    normalisation partagée. C'est LE verrou anti-faux-delta (le modèle réécrivant sa propre
    //    normalisation, la synchro trouverait un écart à chaque passe et réécrirait le document). --
    const raw = { name: "  ", mac: "AA:BB:CC:DD:EE:FF", ip: "10.0.0.9", client_type: "WIRELESS", ssid: "CORP", orphan: 1, notes: "n" };
    const model = new WifiClient(raw);
    const shared = WifiSync.normalizeSource(raw);
    ck(WIFI_SOURCE_FIELDS.every((f) => JSON.stringify(model[f]) === JSON.stringify(shared[f])),
      "modèle WifiClient : CHAQUE champ source ≡ WifiSync.normalizeSource (aucun faux delta possible)");
    ck.eq(model.notes, "n", "modèle : champ LOCAL `notes` conservé");
    ck.eq(model.ap_equipment_id, null, "modèle : ap_equipment_id absent → null (champ dérivé, non inventé)");

    // -- displayName : nom sinon MAC — règle UNIQUE (listing, fiche, palette). --
    ck.eq(WifiClient.displayName({ name: "poste-12", mac: "AA" }), "poste-12", "displayName : le nom prime");
    ck.eq(WifiClient.displayName({ name: "   ", mac: "AA:BB" }), "AA:BB", "displayName : nom blanc → repli sur la MAC");
    ck.eq(WifiClient.displayName({}), "", "displayName : ni nom ni MAC → \"\" (l'appelant décide de son repli)");
    ck.eq(WifiClient.displayName(null), "", "displayName : null toléré");
  }
  });

  /* ============ PARTAGÉ : la collection dans les mécaniques transverses ============ */

  await section("shared : collection wifiClients — spec, ordre COLLECTIONS, cascade, recherche", async () => {
  {
    // -- ORDRE : Schema.COLLECTIONS ⇄ EntityRegistry.CLASSES (l'invariant global le vérifie déjà ;
    //    ici on ASSERTE la POSITION voulue, pour que le jour où l'un des deux bouge on sache où). --
    ck.eq(SharedSchema.COLLECTIONS.indexOf("wifiClients"), SharedSchema.COLLECTIONS.indexOf("vms") + 1,
      "COLLECTIONS : wifiClients inséré JUSTE APRÈS vms");
    ck.eq(EntityRegistry.COLLECTIONS.indexOf("wifiClients"), EntityRegistry.COLLECTIONS.indexOf("vms") + 1,
      "EntityRegistry : même position (l'ordre des deux tables est comparé par un test d'invariant)");

    // -- SPEC : tous les champs texte à default "" (verrou « null silencieux »), orphan booléen,
    //    ap_equipment_id FK nullable vers equipments. --
    const fields = Validation.COLLECTION_SPECS.wifiClients.fields;
    const textFields = ["name", "client_type", "provider_id", "ext_id", "mac", "ip", "ssid", "ap_mac", "ap_name", "connected_since", "last_sync", "notes", "description"];
    ck(textFields.every((f) => fields[f] && fields[f].type === "string" && fields[f].default === ""),
      "spec : TOUS les champs texte ont default \"\" (aucun null silencieux en colonnes strictes)");
    ck(fields.orphan.type === "boolean" && fields.orphan.default === false, "spec : orphan booléen, défaut false");
    ck(fields.ap_equipment_id.nullable === true && fields.ap_equipment_id.default === null && fields.ap_equipment_id.ref === "equipments",
      "spec : ap_equipment_id FK nullable vers equipments (V2 contrôle la référence)");
    ck(!("group_ids" in fields) && !("group_id" in fields), "spec : PAS de groupes en v1 (décision D1 — n'ouvre pas un 4e balayage de Cascade.groups)");
    // Un enregistrement MINIMAL doit être normalisable ET valide (aucune sur-contrainte introduite).
    ck.eq(Validation.DataValidator.normalizeAndValidate("wifiClients", {}).errors.length, 0,
      "spec : enregistrement minimal (aucun champ) → 0 erreur (`name` n'est PAS requis, contrairement aux VMs)");

    // -- CASCADE : supprimer un ÉQUIPEMENT détache les clients dont il est l'AP (miroir de vms). --
    const db = {
      equipments: [{ id: "AP1", name: "ap-hall" }],
      wifiClients: [{ id: "W1", provider_id: "p", ext_id: "m1", ap_equipment_id: "AP1" }, { id: "W2", provider_id: "p", ext_id: "m2", ap_equipment_id: null }],
      vms: [], ipAddresses: [], ports: [], cables: [], spares: [], cableBundles: [], dhcpRanges: [], ipNetworks: [], subEquipments: [], aggregates: [],
    };
    const find = (c, f, v) => (db[c] || []).filter((r) => (Array.isArray(r[f]) ? r[f].includes(v) : r[f] === v));
    const fetch = (c, id) => (db[c] || []).find((r) => r.id === id) || null;
    const planEq = Cascade.plan("equipments", "AP1", find, fetch);
    const detach = planEq.detaches.find((d) => d.c === "wifiClients" && d.id === "W1");
    ck(!!detach && detach.key === "ap_equipment_id" && detach.value === null, "cascade equipments : le client rattaché voit son ap_equipment_id DÉTACHÉ (null)");
    ck(!planEq.deletes.some((d) => d.c === "wifiClients"), "cascade equipments : AUCUN client supprimé (le lien est léger, comme vms.host_equipment_id)");
    ck(!planEq.detaches.some((d) => d.c === "wifiClients" && d.id === "W2"), "cascade equipments : un client sans AP n'est pas touché");
    // Supprimer un CLIENT n'entraîne RIEN (règle déclarée vide, à dessein).
    const planClient = Cascade.plan("wifiClients", "W1", find, fetch);
    ck(planClient.deletes.length === 0 && planClient.detaches.length === 0, "cascade wifiClients : aucun effet (rien ne pointe vers un client wifi)");

    // -- RECHERCHE : AP résolu par LIEN + catalogue « déconnecté » fr/en. --
    const corpus = { equipments: [{ id: "AP1", name: "ap-hall" }] };
    const cFetch = (c, id) => (corpus[c] || []).find((r) => r.id === id) || null;
    const cFind = () => [];
    const terms = SearchTerms.termsOf("wifiClients", { id: "W1", ap_equipment_id: "AP1", orphan: true }, cFetch, cFind);
    ck(terms.includes("ap-hall"), "recherche : le NOM de l'AP résolu est un terme (lien ap_equipment_id → equipments.name)");
    ck(terms.includes("déconnecté") && terms.includes("disconnected"), "recherche : catalogue fr+en (le serveur ignore la langue de l'utilisateur)");
    ck(!SearchTerms.termsOf("wifiClients", { id: "W2", orphan: false }, cFetch, cFind).includes("disconnected"),
      "recherche : client connecté → AUCUN terme de déconnexion (false ≠ clé de catalogue)");
    // VERROU sur les locales : la duplication assumée catalogue ⇄ i18n ne peut pas dériver en silence.
    const norm = SharedSchema.normSearch;
    const frLists = D("i18n/locales/fr/lists.js").lists, enLists = D("i18n/locales/en/lists.js").lists;
    const catalog = SEARCH_CATALOGS.wifiDisconnected.map(norm);
    ck(catalog.includes(norm(frLists.ph.disconnected)) && catalog.includes(norm(enLists.ph.disconnected)),
      "catalogue wifiDisconnected : couvre lists.ph.disconnected des DEUX locales (verrou anti-dérive)");
    // Le versionnage : ajouter une collection à la spec EST une évolution → bump (cf. doctrine du fichier).
    ck(SearchTerms.SEARCH_VERSION >= 3, "SEARCH_VERSION >= 3 (l'ajout de wifiClients à la spec a bumpé le marqueur de backfill)");
  }
  });

  /* ============ SERVEUR : UnifiParse — décodage PUR et TOLÉRANT ============ */

  await section("Serveur : UnifiParse — décodage d'un client (formes pleines, creuses, inattendues)", async () => {
  {
    const { UnifiParse } = SERVER("wifi/UnifiParse.js");

    // 1) FORME PLEINE (nomenclature camelCase de l'API d'intégration).
    const full = UnifiParse.clientRecord({
      id: "uuid-1", name: "poste-12", macAddress: "AA:BB:CC:DD:EE:FF", ipAddress: "10.0.0.9",
      type: "WIRELESS", ssid: "CORP", apMacAddress: "11:22:33:44:55:66", apName: "ap-hall",
      connectedAt: "2026-08-03T10:00:00.000Z",
    });
    ck.eq(full.ext_id, "AA:BB:CC:DD:EE:FF", "client : ext_id = la MAC (identité PHYSIQUE, stable à travers les déconnexions)");
    ck.eq(full.name, "poste-12", "client : nom repris");
    ck.eq(full.client_type, "wireless", "client : type ramené en minuscules (« WIRELESS » → « wireless ») — pas de faux delta sur un changement de casse");
    ck(full.ssid === "CORP" && full.ap_name === "ap-hall" && full.ap_mac === "11:22:33:44:55:66", "client : ssid + AP repris");
    ck.eq(full.connected_since, "2026-08-03T10:00:00.000Z", "client : connectedAt ISO conservé");
    ck.eq(full.provider_id, "", "client : provider_id laissé VIDE (estampillé par l'adaptateur, pas par le décodeur pur)");

    // 2) FORME CREUSE : presque tout absent — null partout, "" pour name/client_type (non nullables).
    const sparse = UnifiParse.clientRecord({ mac: "aa:11" });
    ck.eq(sparse.ext_id, "aa:11", "creux : la MAC suffit à l'identité");
    ck(sparse.name === "" && sparse.client_type === "", "creux : name/client_type → \"\" (jamais null : le pivot ne les déclare pas nullables)");
    ck(sparse.ip === null && sparse.ssid === null && sparse.ap_name === null && sparse.connected_since === null,
      "creux : les champs nullables restent null (rien n'est deviné)");

    // 3) SANS IDENTITÉ : ni MAC ni id → écarté (le réconcilier créerait un fantôme à chaque passe).
    ck.eq(UnifiParse.clientRecord({ name: "sans identité" }), null, "sans MAC ni id → écarté (inréconciliable)");
    ck.eq(UnifiParse.clientRecord({ id: "uuid-only" }).ext_id, "uuid-only", "sans MAC mais avec id → l'id sert de repli d'identité");

    // 4) FORMES INATTENDUES : le décodeur ne jette JAMAIS.
    for (const junk of [null, undefined, 42, "chaîne", [], true]) {
      ck.eq(UnifiParse.clientRecord(junk), null, "forme inattendue " + JSON.stringify(junk) + " → null, aucune exception");
    }
    ck.eq(UnifiParse.clientRecord({ mac: "a", ipAddress: { nested: 1 } }).ip, null, "valeur mal typée (objet là où on attend une chaîne) → null");

    // 5) HORODATAGE : ISO, secondes UNIX, millisecondes UNIX, illisible.
    const at = (v) => UnifiParse.clientRecord({ mac: "a", connectedAt: v }).connected_since;
    ck.eq(at(1754215200), "2025-08-03T10:00:00.000Z", "connectedAt en SECONDES unix → ISO");
    ck.eq(at(1754215200000), "2025-08-03T10:00:00.000Z", "connectedAt en MILLISECONDES unix → même ISO (départage par ordre de grandeur)");
    ck.eq(at("pas une date"), null, "connectedAt illisible → null (jamais une date inventée)");
    ck.eq(at(0), null, "connectedAt 0 → null (absence, pas l'époque unix)");

    // 6) RÉSOLUTION DE L'AP par uplink : le client ne porte que l'id du périphérique.
    const index = UnifiParse.deviceIndex([
      { id: "dev-1", name: "ap-etage-2", macAddress: "99:88:77:66:55:44" },
      { name: "sans id" },   // écarté : irrapprochable
      null,
    ]);
    ck.eq(index.size, 1, "deviceIndex : seules les entrées AVEC id sont indexées");
    const resolved = UnifiParse.clientRecord({ mac: "b", uplinkDeviceId: "dev-1" }, index);
    ck(resolved.ap_name === "ap-etage-2" && resolved.ap_mac === "99:88:77:66:55:44", "client : AP résolu par uplinkDeviceId (nom + MAC)");
    const direct = UnifiParse.clientRecord({ mac: "c", apName: "porté-par-le-client", uplinkDeviceId: "dev-1" }, index);
    ck.eq(direct.ap_name, "porté-par-le-client", "client : le nom d'AP PORTÉ par le client prime sur la résolution par uplink");
    ck.eq(UnifiParse.clientRecord({ mac: "d", uplinkDeviceId: "inconnu" }, index).ap_name, null, "client : uplink inconnu de l'index → ap_name null (au mieux)");

    // 7) LOT : doublons d'ext_id écartés, inexploitables ignorés.
    const records = UnifiParse.clientRecords([{ mac: "x" }, { mac: "x", name: "doublon" }, { name: "sans id" }, { mac: "y" }]);
    ck.eq(records.map((r) => r.ext_id).join(","), "x,y", "clientRecords : doublon d'ext_id écarté (premier gagne), inexploitable ignoré");

    // 8) FILTRE FILAIRE : PRUDENCE — seul un type reconnu comme filaire exclut.
    ck.eq(UnifiParse.isWireless({ client_type: "wireless" }), true, "isWireless : « wireless » → sans fil");
    ck.eq(UnifiParse.isWireless({ client_type: "wired" }), false, "isWireless : « wired » → filaire");
    ck.eq(UnifiParse.isWireless({ client_type: "" }), true, "isWireless : type ABSENT → considéré sans fil (prudence : ne jamais faire DISPARAÎTRE un client réel)");
    ck.eq(UnifiParse.isWireless({ client_type: "vocabulaire-inconnu" }), true, "isWireless : type inconnu → conservé");

    // 9) SITES : résolution par id OU nom, insensible à la casse.
    const sites = [{ id: "s-uuid-1", name: "Default" }, { id: "s-uuid-2", name: "Annexe" }];
    ck.eq(UnifiParse.findSiteId(sites, "s-uuid-2"), "s-uuid-2", "findSiteId : par identifiant");
    ck.eq(UnifiParse.findSiteId(sites, "default"), "s-uuid-1", "findSiteId : par nom, insensible à la casse");
    ck.eq(UnifiParse.findSiteId(sites, "  Annexe "), "s-uuid-2", "findSiteId : nom trimé");
    ck.eq(UnifiParse.findSiteId(sites, "absent"), null, "findSiteId : aucun site correspondant → null (le repli est une décision d'orchestration)");
    ck.eq(UnifiParse.findSiteId([], "default"), null, "findSiteId : liste vide → null");
    ck.eq(UnifiParse.firstSiteId(sites), "s-uuid-1", "firstSiteId : premier site exploitable");
    ck.eq(UnifiParse.firstSiteId([{ name: "sans id" }]), null, "firstSiteId : aucun id exploitable → null");

    // -- internalReference : critère de résolution INDÉPENDANT du nom affiché — constaté sur
    //    console RÉELLE le 2026-08-04 (UniFi Network 10.4.57) : un site porte À LA FOIS un nom
    //    lisible (`name: "Sonuma"`) ET une référence stable (`internalReference: "default"`, la
    //    valeur par défaut du champ « Site » du formulaire). DEUX sites dans la fixture : un seul
    //    site ne permettrait pas de distinguer une résolution CORRECTE d'un repli « premier site »
    //    qui tomberait juste par coïncidence. --
    const realSites = [
      { id: "88f7af54-98f8-306a-a1c7-c9349722b1f6", internalReference: "default", name: "Sonuma" },
      { id: "s-annexe-uuid", internalReference: "annexe", name: "Annexe" },
    ];
    ck.eq(UnifiParse.findSiteId(realSites, "default"), "88f7af54-98f8-306a-a1c7-c9349722b1f6",
      "findSiteId : résout DIRECTEMENT par internalReference quand le name affiché (« Sonuma ») ne matche PAS « default »");
    ck.eq(UnifiParse.findSiteId(realSites, "annexe"), "s-annexe-uuid",
      "findSiteId : internalReference d'un AUTRE site de la même liste, correctement distingué");
    ck.eq(UnifiParse.findSiteId(realSites, "Sonuma"), "88f7af54-98f8-306a-a1c7-c9349722b1f6",
      "findSiteId : résolution par NOM — AUCUNE régression (name reste prioritaire pour l'affichage)");
    ck.eq(UnifiParse.findSiteId(realSites, "88f7af54-98f8-306a-a1c7-c9349722b1f6"), "88f7af54-98f8-306a-a1c7-c9349722b1f6",
      "findSiteId : résolution par ID — AUCUNE régression");

    // siteSummaries : résumés id+nom — matière de l'ÉNUMÉRATION du message « site introuvable ».
    const summaries = UnifiParse.siteSummaries(sites);
    ck.eq(summaries.length, 2, "siteSummaries : un résumé par site exploitable");
    ck(summaries[0].id === "s-uuid-1" && summaries[0].name === "Default", "siteSummaries : id + nom du premier site");
    ck(summaries[1].id === "s-uuid-2" && summaries[1].name === "Annexe", "siteSummaries : id + nom du second site");
    ck.eq(UnifiParse.siteSummaries([{ name: "sans id" }]).length, 0, "siteSummaries : site SANS id exploitable → écarté (rien à proposer pour le champ « Site »)");
    ck.eq(UnifiParse.siteSummaries([{ id: "s-x" }])[0].name, null, "siteSummaries : nom absent → null (l'id restera affichable seul)");
  }
  });

  await section("Serveur : UnifiParse — PAGINATION PURE (enveloppe + décision de continuer)", async () => {
  {
    const { UnifiParse } = SERVER("wifi/UnifiParse.js");

    // -- ENVELOPPE : { data, offset, totalCount }, tableau nu, ou n'importe quoi. --
    const page = UnifiParse.page({ offset: 0, limit: 2, totalCount: 5, data: [{ a: 1 }, { a: 2 }] });
    ck(page.items.length === 2 && page.offset === 0 && page.totalCount === 5, "page : enveloppe { data, offset, totalCount } décodée");
    ck.eq(UnifiParse.page([{ a: 1 }]).items.length, 1, "page : TABLEAU NU accepté (offset/total inconnus)");
    ck.eq(UnifiParse.page([{ a: 1 }]).totalCount, null, "page : tableau nu → totalCount null");
    for (const junk of [null, undefined, 42, "x", { data: "pas un tableau" }]) {
      ck.eq(UnifiParse.page(junk).items.length, 0, "page : forme inattendue " + JSON.stringify(junk) + " → page vide, aucune exception");
    }
    ck.eq(UnifiParse.page({ data: [], offset: "3", totalCount: -1 }).totalCount, null, "page : totalCount négatif → null (valeur exotique = « non remonté »)");
    ck.eq(UnifiParse.page({ data: [], offset: "3" }).offset, 3, "page : offset en chaîne numérique accepté");

    // -- DÉCISION : chaque garde-fou testé SÉPARÉMENT (l'API peut mentir sur l'un ou l'autre). --
    const p = (n, total) => ({ items: new Array(n).fill({}), offset: null, totalCount: total ?? null });
    ck.eq(UnifiParse.nextOffset(p(0), 0, 10), null, "nextOffset : page VIDE → arrêt");
    ck.eq(UnifiParse.nextOffset(p(4), 0, 10), null, "nextOffset : page INCOMPLÈTE (4 < 10) → arrêt");
    ck.eq(UnifiParse.nextOffset(p(10), 0, 10), 10, "nextOffset : page PLEINE, total inconnu → continuer à l'offset 10");
    ck.eq(UnifiParse.nextOffset(p(10, 20), 10, 10), null, "nextOffset : total ATTEINT (10+10 >= 20) → arrêt");
    ck.eq(UnifiParse.nextOffset(p(10, 30), 10, 10), 20, "nextOffset : total non atteint → continuer");
    ck.eq(UnifiParse.nextOffset(p(10), 0, 0), null, "nextOffset : limit 0 → arrêt (config absurde, jamais de boucle)");
    ck.eq(UnifiParse.nextOffset(p(10), 0, -5), null, "nextOffset : limit négative → arrêt");
    // La progression se calcule sur l'offset DEMANDÉ, pas sur celui renvoyé par l'API (qui peut dériver).
    ck.eq(UnifiParse.nextOffset({ items: new Array(10).fill({}), offset: 999, totalCount: null }, 20, 10), 30,
      "nextOffset : progression fondée sur l'offset DEMANDÉ (un offset renvoyé fantaisiste ne fait ni boucler ni sauter)");
  }
  });

  /* ============ SERVEUR : UnifiAdapter — orchestration (client HTTP stub) ============ */

  // Stub `UnifiJsonClient` : table chemin (SANS query) → réponses PAR PAGE, journal des appels —
  // permet d'asserter l'ORCHESTRATION (quels appels, quelle pagination) sans réseau. Une Error en
  // valeur = rejet. MÊME patron structurel que `mkPveStub` du module VM.
  const mkUnifiStub = (routes) => {
    const calls = [];
    return {
      calls,
      disposed: 0,
      dispose() { this.disposed++; },
      getJson: async (full) => {
        calls.push(full);
        const [route, query] = full.split("?");
        const entry = routes[route];
        if (entry === undefined) throw new Error("UniFi : HTTP 404 sur " + route);
        if (entry instanceof Error) throw entry;
        const pages = Array.isArray(entry) ? entry : [entry];
        const offset = Number((/offset=(\d+)/.exec(query || "") || [])[1] || 0);
        // Les fixtures multi-pages sont indexées par NUMÉRO de page (offset / 200).
        return pages[Math.floor(offset / 200)] || { data: [] };
      },
    };
  };

  await section("Serveur : UnifiAdapter — inventory (site, AP au mieux, pagination, filtre filaire, dispose)", async () => {
  {
    const { UnifiAdapter } = SERVER("wifi/UnifiAdapter.js");
    const CFG = { id: "wifi-1", kind: "unifi", url: "https://unifi.example.lan", token: "CLE-SECRETE", fingerprint: null, ca_pem: null, interval_sec: 0, timeout_sec: 15, options: { site: "default", include_wired: false } };
    const SITES = UnifiAdapter.PATH_SITES;
    const site = "s-1";

    const routes = {
      [SITES]: { data: [{ id: site, name: "Default" }], totalCount: 1 },
      [UnifiAdapter.pathDevices(site)]: { data: [{ id: "dev-1", name: "ap-hall", macAddress: "99:88" }], totalCount: 1 },
      [UnifiAdapter.pathClients(site)]: { data: [
        { macAddress: "AA:01", name: "poste-1", type: "WIRELESS", ssid: "CORP", uplinkDeviceId: "dev-1", ipAddress: "10.0.0.1" },
        { macAddress: "AA:02", type: "WIRED", ipAddress: "10.0.0.2" },
      ], totalCount: 2 },
    };
    const stub = mkUnifiStub(routes);
    const inv = await new UnifiAdapter(CFG, stub).inventory();
    ck.eq(inv.clients.length, 1, "inventory : le client FILAIRE est écarté (include_wired false — le besoin porte sur le wifi)");
    ck.eq(inv.clients[0].ext_id, "AA:01", "inventory : le client sans fil est conservé");
    ck.eq(inv.clients[0].ap_name, "ap-hall", "inventory : AP résolu via la liste des périphériques");
    ck.eq(inv.clients[0].provider_id, "wifi-1", "inventory : provider_id ESTAMPILLÉ par l'adaptateur");
    ck(stub.calls.every((c) => c.includes("offset=") && c.includes("limit=")), "inventory : chaque appel porte offset+limit (pagination systématique)");
    ck(!JSON.stringify(stub.calls).includes("CLE-SECRETE"), "inventory : la clé d'API n'apparaît JAMAIS dans un chemin appelé");
    ck.eq(stub.disposed, 1, "inventory : dispose() appelé en fin de passe (libération des sockets keep-alive)");

    // include_wired → le filaire remonte aussi (opt-in explicite).
    const wired = await new UnifiAdapter({ ...CFG, options: { site: "default", include_wired: true } }, mkUnifiStub(routes)).inventory();
    ck.eq(wired.clients.length, 2, "inventory : include_wired → le filaire est inventorié aussi");

    // PÉRIPHÉRIQUES en échec → l'inventaire CONTINUE (au mieux), sans nom d'AP résolu.
    const noDevices = await new UnifiAdapter(CFG, mkUnifiStub({ ...routes, [UnifiAdapter.pathDevices(site)]: new Error("403") })).inventory();
    ck.eq(noDevices.clients.length, 1, "inventory : échec de la liste des périphériques → l'inventaire des clients ABOUTIT quand même");
    ck.eq(noDevices.clients[0].ap_name, null, "inventory : … avec seulement l'AP que porte le client (ici aucun)");

    // CLIENTS en échec → la passe ÉCHOUE (contrat : la synchro conservera l'état précédent).
    let threw = false;
    const failing = mkUnifiStub({ ...routes, [UnifiAdapter.pathClients(site)]: new Error("UniFi : HTTP 500") });
    try { await new UnifiAdapter(CFG, failing).inventory(); } catch (e) { threw = /500/.test(e.message); }
    ck(threw, "inventory : échec de la liste des CLIENTS → rejet (la synchro journalise et conserve l'état)");
    ck.eq(failing.disposed, 1, "inventory : dispose() appelé MÊME en cas d'échec (finally)");

    // SITE introuvable et NON « default » → erreur franche (l'utilisateur a saisi quelque chose),
    // qui ÉNUMÈRE le(s) site(s) disponibles (nom + id) pour corriger sans deviner.
    let siteErr = null;
    try { await new UnifiAdapter({ ...CFG, options: { site: "annexe", include_wired: false } }, mkUnifiStub(routes)).inventory(); } catch (e) { siteErr = e; }
    ck(siteErr && /annexe/.test(siteErr.message) && /introuvable/i.test(siteErr.message), "inventory : site nommé introuvable → erreur EXPLICITE citant la valeur saisie");
    ck(siteErr && /« Default » \(id s-1\)/.test(siteErr.message), "inventory : … et ÉNUMÉRANT le site disponible (nom + id)");

    // SITE « default » non trouvé par son nom → repli sur le PREMIER site (l'API nomme par UUID).
    const uuidOnly = { ...routes, [SITES]: { data: [{ id: "s-9", name: "Siège" }], totalCount: 1 },
      [UnifiAdapter.pathDevices("s-9")]: { data: [] },
      [UnifiAdapter.pathClients("s-9")]: { data: [{ macAddress: "BB:01", type: "wireless" }] } };
    const fallback = await new UnifiAdapter(CFG, mkUnifiStub(uuidOnly)).inventory();
    ck.eq(fallback.clients.length, 1, "inventory : « default » non résolu par nom → repli sur le PREMIER site (première configuration possible)");

    // -- FIXTURE À LA FORME RÉELLE (console SONUMA, UniFi Network 10.4.57, 2026-08-04) : enveloppe
    //    de pagination complète { offset, limit, count, totalCount, data }, site à `internalReference`
    //    « default » MAIS `name` « Sonuma » (ne matche PAS « default »). DEUX sites, le mauvais EN
    //    PREMIER dans le tableau : si la résolution retombait, à tort, sur le repli « premier site »
    //    plutôt que sur `internalReference`, l'inventaire échouerait (404 sur les sous-ressources du
    //    mauvais site, aucune route stubée pour lui) — la réussite du test EST la preuve. --
    const realShapeSites = {
      ...routes,
      [SITES]: { offset: 0, limit: 25, count: 2, totalCount: 2, data: [
        { id: "s-annexe", internalReference: "annexe", name: "Annexe" },
        { id: site, internalReference: "default", name: "Sonuma" },
      ] },
    };
    const viaInternalRef = await new UnifiAdapter(CFG, mkUnifiStub(realShapeSites)).inventory();
    ck.eq(viaInternalRef.clients.length, 1, "inventory : site « default » résolu par internalReference sur une fixture À LA FORME RÉELLE (pagination complète, name ≠ valeur cherchée, 2 sites — le repli mono-site n'a pas pu jouer)");
    ck.eq(viaInternalRef.clients[0].ext_id, "AA:01", "inventory : … et c'est bien le BON site qui a été interrogé (clients du site « s-1 »)");
  }
  });

  await section("Serveur : UnifiAdapter — pagination réelle sur plusieurs pages + cap dur", async () => {
  {
    const { UnifiAdapter } = SERVER("wifi/UnifiAdapter.js");
    const CFG = { id: "w", kind: "unifi", url: "https://c.lan", token: "k", fingerprint: null, ca_pem: null, interval_sec: 0, timeout_sec: 15, options: { site: "default", include_wired: true } };
    const site = "s-1";
    const SIZE = UnifiAdapter.PAGE_SIZE;
    const mkClients = (from, count) => new Array(count).fill(0).map((_, i) => ({ macAddress: "AA:" + (from + i), type: "wireless" }));

    // 3 pages : pleine, pleine, partielle → 2·SIZE + 5 clients, 3 appels sur la route clients.
    const stub = mkUnifiStub({
      [UnifiAdapter.PATH_SITES]: { data: [{ id: site, name: "Default" }] },
      [UnifiAdapter.pathDevices(site)]: { data: [] },
      [UnifiAdapter.pathClients(site)]: [
        { data: mkClients(0, SIZE), totalCount: 2 * SIZE + 5 },
        { data: mkClients(SIZE, SIZE), totalCount: 2 * SIZE + 5 },
        { data: mkClients(2 * SIZE, 5), totalCount: 2 * SIZE + 5 },
      ],
    });
    const inv = await new UnifiAdapter(CFG, stub).inventory();
    ck.eq(inv.clients.length, 2 * SIZE + 5, "pagination : les 3 pages sont concaténées");
    const clientCalls = stub.calls.filter((c) => c.startsWith(UnifiAdapter.pathClients(site)));
    ck.eq(clientCalls.length, 3, "pagination : exactement 3 appels (arrêt sur page incomplète)");
    ck(clientCalls[1].includes("offset=" + SIZE), "pagination : le 2e appel demande offset = taille de page");

    // CAP DUR : une console qui renvoie éternellement une page PLEINE ne doit pas boucler à l'infini.
    // ⚠ Comparaison sur le chemin EXACT (query retirée) et non par préfixe : `/…/sites` est un
    // préfixe de `/…/sites/<id>/clients`, un `startsWith` renverrait la liste des sites à TOUS
    // les appels (piège rencontré à l'écriture de ce test).
    const loopStub = {
      calls: [],
      dispose() { },
      getJson: async (full) => {
        loopStub.calls.push(full);
        const route = full.split("?")[0];
        if (route === UnifiAdapter.PATH_SITES) return { data: [{ id: site, name: "Default" }] };
        if (route === UnifiAdapter.pathDevices(site)) return { data: [] };
        return { data: mkClients(0, SIZE) };   // toujours pleine, jamais de fin annoncée
      },
    };
    const capped = await new UnifiAdapter(CFG, loopStub).inventory();
    const cappedCalls = loopStub.calls.filter((c) => c.split("?")[0] === UnifiAdapter.pathClients(site));
    ck.eq(cappedCalls.length, UnifiAdapter.MAX_PAGES, "cap dur : la boucle s'arrête à MAX_PAGES (console qui ignore offset)");
    ck(capped.clients.length > 0, "cap dur : on rend ce qu'on a plutôt que de perdre tout l'inventaire");
  }
  });

  await section("Serveur : UnifiAdapter.test — joignabilité, site résolu/introuvable, échec (sans jeton dans les messages)", async () => {
  {
    const { UnifiAdapter } = SERVER("wifi/UnifiAdapter.js");
    const CFG = { id: "w", kind: "unifi", url: "https://c.lan", token: "CLE-SECRETE", fingerprint: null, ca_pem: null, interval_sec: 0, timeout_sec: 15, options: { site: "Default", include_wired: false } };

    const ok = await new UnifiAdapter(CFG, mkUnifiStub({ [UnifiAdapter.PATH_SITES]: { data: [{ id: "s-1", name: "Default" }] } })).test();
    ck(ok.ok === true && ok.supported === true, "test : console joignable + site résolu → ok, supported");
    ck.eq(ok.kind, "unifi", "test : kind remonté");
    ck(/Default/.test(ok.message), "test : le message nomme le site résolu");

    const noSite = await new UnifiAdapter({ ...CFG, options: { site: "absent", include_wired: false } }, mkUnifiStub({ [UnifiAdapter.PATH_SITES]: { data: [{ id: "s-1", name: "Default" }] } })).test();
    ck(noSite.ok === true && noSite.supported === false && /INTROUVABLE/.test(noSite.message),
      "test : connexion OK mais site introuvable → ok:true, supported:false (c'est la CONFIG qui est en cause, pas le réseau)");
    ck(/« Default » \(id s-1\)/.test(noSite.message), "test : … et le message ÉNUMÈRE le site disponible (nom + id), sans que l'utilisateur ait à deviner");

    // -- ÉNUMÉRATION : cas nominal, 2 sites disponibles → le message cite les DEUX (nom + id). --
    const twoSites = await new UnifiAdapter({ ...CFG, options: { site: "inconnu", include_wired: false } },
      mkUnifiStub({ [UnifiAdapter.PATH_SITES]: { data: [{ id: "s-1", name: "Default" }, { id: "s-2", name: "Annexe" }] } })).test();
    ck(/« Default » \(id s-1\)/.test(twoSites.message) && /« Annexe » \(id s-2\)/.test(twoSites.message),
      "test : site introuvable parmi 2 → le message énumère les DEUX sites (nom + id)");

    // -- PLAFOND : au-delà de MAX_SITES_IN_ERROR, la liste s'arrête et signale le reste. --
    const manySites = new Array(UnifiAdapter.MAX_SITES_IN_ERROR + 3).fill(0).map((_, i) => ({ id: "s-" + i, name: "Site " + i }));
    const overflow = await new UnifiAdapter({ ...CFG, options: { site: "inconnu", include_wired: false } },
      mkUnifiStub({ [UnifiAdapter.PATH_SITES]: { data: manySites } })).test();
    ck(/… et 3 autres/.test(overflow.message), "test : au-delà du plafond → « … et N autres »");
    ck.eq((overflow.message.match(/\(id s-/g) || []).length, UnifiAdapter.MAX_SITES_IN_ERROR,
      "test : pas plus de MAX_SITES_IN_ERROR entrées énumérées (un MSP peut avoir des dizaines de sites)");

    // -- NOM VIDE : un site sans nom exploitable → l'id apparaît SEUL (pas de guillemets vides). --
    const noName = await new UnifiAdapter({ ...CFG, options: { site: "inconnu", include_wired: false } },
      mkUnifiStub({ [UnifiAdapter.PATH_SITES]: { data: [{ id: "s-7" }] } })).test();
    // Capture UNIQUEMENT le segment d'énumération (entre « sites disponibles : » et le tiret
    // suivant) — pas la suite du message, qui recite « Site » ENTRE GUILLEMETS (nom du champ).
    const enumMatch = /sites disponibles : ([^—]*)—/.exec(noName.message);
    ck(enumMatch !== null && /id s-7/.test(enumMatch[1]) && !/«/.test(enumMatch[1]), "test : site sans nom → l'id seul est énuméré, sans guillemets vides");

    const empty = await new UnifiAdapter(CFG, mkUnifiStub({ [UnifiAdapter.PATH_SITES]: { data: [] } })).test();
    ck(empty.ok === true && empty.supported === false && /droits/.test(empty.message), "test : aucun site remonté → piste des droits de la clé");

    const ko = await new UnifiAdapter(CFG, mkUnifiStub({ [UnifiAdapter.PATH_SITES]: new Error("UniFi : authentification refusée (401)") })).test();
    ck(ko.ok === false && /401/.test(ko.message), "test : échec d'accès → ok:false + message");
    ck(!ko.message.includes("CLE-SECRETE"), "test : le message ne contient JAMAIS la clé d'API");
  }
  });

  /* ============ SERVEUR : UnifiHttp — parties PURES (confiance TLS, erreurs) ============ */

  await section("Serveur : UnifiHttp — trustOptions (épinglage > CA > système) + erreurs actionnables", async () => {
  {
    const { UnifiHttp, UnifiHttpError } = SERVER("wifi/UnifiHttp.js");
    const CA = "-----BEGIN CERTIFICATE-----\nFAUX\n-----END CERTIFICATE-----";

    // 3. CA système (aucun matériel fourni) — et SURTOUT : pas de clé `checkServerIdentity` du tout.
    const system = UnifiHttp.trustOptions(null, null);
    ck.eq(system.rejectUnauthorized, true, "trustOptions : sans matériel → validation par les CA système");
    ck(!("checkServerIdentity" in system) && !("ca" in system),
      "trustOptions : clés ABSENTES hors de leur branche (un `undefined` explicite casse tls.connect — bug de prod du module VM)");

    // 2. CA fournie.
    const ca = UnifiHttp.trustOptions(null, CA);
    ck(ca.rejectUnauthorized === true && ca.ca === CA && !("checkServerIdentity" in ca), "trustOptions : CA fournie → validation par CETTE CA");

    // 1. Épinglage — PRIME sur la CA, et compare l'empreinte sans se soucier des séparateurs/casse.
    const fp = Array(32).fill("ab").join(":");
    const pinned = UnifiHttp.trustOptions(fp, CA);
    ck(pinned.rejectUnauthorized === false && typeof pinned.checkServerIdentity === "function" && !("ca" in pinned),
      "trustOptions : empreinte fournie → ÉPINGLAGE, prioritaire sur la CA");
    ck.eq(pinned.checkServerIdentity("h", { fingerprint256: fp.toUpperCase() }), undefined, "épinglage : empreinte identique (casse/séparateurs ignorés) → acceptée");
    const rejected = pinned.checkServerIdentity("h", { fingerprint256: Array(32).fill("cd").join(":") });
    ck(rejected instanceof Error && /épinglage refusé/.test(rejected.message), "épinglage : empreinte différente → handshake refusé");
    ck(pinned.checkServerIdentity("h", {}) instanceof Error, "épinglage : certificat sans empreinte → refusé (jamais accepté par défaut)");

    // ERREURS : explication FRANÇAISE actionnable + message technique conservé + cible citée.
    const explained = UnifiHttp.explainNetworkError(Object.assign(new Error("self signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "https://c.lan/x");
    ck(explained instanceof UnifiHttpError && explained.retryable === true, "explainNetworkError : erreur réseau → UnifiHttpError retryable");
    ck(/auto-signé/.test(explained.message) && /self signed certificate/.test(explained.message) && /https:\/\/c\.lan\/x/.test(explained.message),
      "explainNetworkError : explication FR + message technique + cible");
    ck(/nom d'hôte introuvable/.test(UnifiHttp.explainNetworkError({ code: "ENOTFOUND", message: "getaddrinfo" }, "t").message), "explainNetworkError : ENOTFOUND expliqué");
    ck(/inconnu/.test(UnifiHttp.explainNetworkError(new Error("inconnu"), "t").message), "explainNetworkError : code inconnu → message brut conservé");
    // fullStack : la CAUSE est transportée (indispensable au diagnostic d'une erreur interne de Node).
    const withCause = new UnifiHttpError("x", true, new Error("cause profonde"));
    ck(/cause profonde/.test(withCause.fullStack()), "UnifiHttpError.fullStack : la pile de la CAUSE est jointe");
  }
  });

  /* ============ SERVEUR : validation d'un provider (communs + options par marque) ============ */

  await section("Serveur : WifiProviderConfigValidate — champs communs, défauts, options PAR MARQUE (D9)", async () => {
  {
    const { WifiProviderConfigValidate, WifiProviderConfigError, KIND_OPTION_SPECS, SUPPORTED_KINDS } = SERVER("wifi/WifiProviderConfigValidate.js");
    const validate = (raw) => { const errors = []; const cfg = WifiProviderConfigValidate.parseProvider("doc-A", 0, raw, errors); return { cfg, errors }; };
    const SECRET = "cle-api-tres-secrete";
    const base = { id: "w1", kind: "unifi", url: "https://unifi.lan", token: SECRET };

    // 1) DÉFAUTS des champs communs.
    const ok = validate(base);
    ck(ok.cfg !== null && ok.errors.length === 0, "provider minimal valide → config produite");
    ck(ok.cfg.interval_sec === 0 && ok.cfg.timeout_sec === 15, "défauts : interval_sec 0 (manuelle), timeout_sec 15 s");
    ck(ok.cfg.fingerprint === null && ok.cfg.ca_pem === null, "défauts : aucun matériel TLS → null (CA système)");

    // 2) REQUIS + le jeton JAMAIS divulgué.
    ck(validate({ ...base, url: undefined }).errors.some((m) => /url/.test(m)), "url manquante → erreur citant le champ");
    ck(validate({ ...base, token: undefined }).errors.some((m) => /token/.test(m)), "token manquant → « token requis »");
    ck(validate({ ...base, id: undefined }).errors.some((m) => /id/.test(m)), "id manquant → erreur");
    ck(!validate({ ...base, url: undefined }).errors.join("\n").includes(SECRET), "le jeton n'apparaît JAMAIS dans un message d'erreur");
    ck(validate({ ...base, url: "http://unifi.lan" }).errors.some((m) => /https/.test(m)), "url http → refusée (la clé voyage en en-tête à chaque requête)");
    ck(validate({ ...base, url: "pas-une-url" }).errors.some((m) => /url/.test(m)), "url sans schéma → refusée");

    // 3) KIND INCONNU : erreur EXPLICITE listant les types supportés (la validation des options en dépend).
    const badKind = validate({ ...base, kind: "aruba" });
    ck(badKind.cfg === null && badKind.errors.some((m) => /kind/.test(m) && /unifi/.test(m)),
      "kind inconnu → erreur citant les types supportés (on n'enregistre pas un provider sans adaptateur)");
    ck.eq(SUPPORTED_KINDS.join(","), Object.keys(KIND_OPTION_SPECS).join(","), "SUPPORTED_KINDS est DÉRIVÉ de la table d'options (jamais une seconde liste)");

    // 4) OPTIONS PAR MARQUE : défauts posés, types contrôlés, clés INCONNUES écartées en silence.
    ck.eq(ok.cfg.options.site, "default", "options : `site` absent → défaut « default »");
    ck.eq(ok.cfg.options.include_wired, false, "options : `include_wired` absent → défaut false");
    const opts = validate({ ...base, options: { site: "annexe", include_wired: true } });
    ck(opts.cfg.options.site === "annexe" && opts.cfg.options.include_wired === true, "options : valeurs fournies retenues");
    ck(validate({ ...base, options: { include_wired: "oui" } }).errors.some((m) => /include_wired/.test(m)), "options : booléen mal typé → erreur explicite");
    ck(validate({ ...base, options: { site: "   " } }).errors.some((m) => /site/.test(m)), "options : `site` vide → erreur (il identifie quelque chose côté contrôleur)");
    const unknownOpt = validate({ ...base, options: { site: "s", option_d_une_autre_marque: 42 } });
    ck(unknownOpt.cfg !== null && !("option_d_une_autre_marque" in unknownOpt.cfg.options),
      "options : clé INCONNUE écartée SILENCIEUSEMENT (une option d'une autre marque ne rend pas la config irrécupérable)");
    ck.eq(validate({ ...base, options: "pas un objet" }).cfg.options.site, "default", "options : forme inattendue → défauts (tolérance)");

    // 5) EMPREINTE / CA.
    const fp = Array(32).fill("AA").join(":");
    ck.eq(validate({ ...base, fingerprint: fp }).cfg.fingerprint, fp, "fingerprint valide conservée TELLE QUELLE (la normalisation vit dans UnifiHttp)");
    ck(validate({ ...base, fingerprint: "trop-court" }).errors.some((m) => /fingerprint/.test(m)), "fingerprint invalide → erreur");
    ck.eq(validate({ ...base, fingerprint: "" }).cfg.fingerprint, null, "fingerprint vidée côté UI → null, sans erreur");
    ck(validate({ ...base, ca_pem: "pas du PEM" }).errors.some((m) => /ca_pem/.test(m)), "ca_pem sans marqueur PEM → erreur");
    ck.eq(validate({ ...base, ca_pem: "" }).cfg.ca_pem, null, "ca_pem vidée → null, sans erreur");

    // 6) intervalles.
    ck(validate({ ...base, interval_sec: -1 }).errors.some((m) => /interval_sec/.test(m)), "interval_sec négatif → erreur");
    ck(validate({ ...base, timeout_sec: 0 }).errors.some((m) => /timeout_sec/.test(m)), "timeout_sec 0 → erreur");

    // 7) L'erreur porte les issues (rendues en 400 par les routes).
    const err = new WifiProviderConfigError(["souci A", "souci B"]);
    ck(Array.isArray(err.issues) && err.issues.length === 2 && err.name === "WifiProviderConfigError", "WifiProviderConfigError porte les issues + message agrégé");
  }
  });

  /* ============ SERVEUR : stockage chiffré des providers (better-sqlite3 RÉEL) ============ */

  await section("Serveur : WifiProviderConfigDb — schéma, CRUD sans fuite de jeton, options, jeton indéchiffrable", async () => {
    // better-sqlite3 RÉEL requis (binaire natif) — même probe que les autres sections DB.
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probe = new Candidate(":memory:"); probe.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section WifiProviderConfigDb sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { WifiProviderConfigDb } = SERVER("wifi/WifiProviderConfigDb.js");
    const { SecretBox } = SERVER("SecretBox.js");
    const { WifiProviderConfigError } = SERVER("wifi/WifiProviderConfigValidate.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-wifidb-"));
    let raw = null;
    try {
      const box = new SecretBox("passphrase-infra-longue-de-test");
      const db = new WifiProviderConfigDb(dir, Sqlite, box);   // Logger "error" par défaut → silencieux

      // -- SCHÉMA : fichier matérialisé, UNE table (écart assumé au patron VM — décision D3). --
      ck(fs.existsSync(path.join(dir, "wifi-providers.db")), "wifi-providers.db matérialisé dans le dossier injecté");
      raw = new Sqlite(path.join(dir, "wifi-providers.db"));
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
      ck.eq(tables.join(","), "wifi_providers", "schéma : UNE SEULE table (pas de pool d'endpoints — un contrôleur n'a qu'une console)");

      // -- save (création) : jeton fourni, options normalisées ; réponse SANS jeton. --
      const saved = db.save("doc-A", { id: "w1", kind: "unifi", url: "https://unifi.lan", interval_sec: 300, options: { site: "annexe", include_wired: true } }, "CLE-SECRETE-1");
      ck(saved.id === "w1" && saved.url === "https://unifi.lan", "save (création) → item renvoyé");
      ck.eq(saved.has_token, true, "save : has_token = true");
      ck(saved.options.site === "annexe" && saved.options.include_wired === true, "save : options de la marque restituées");
      ck(!("token" in saved) && !JSON.stringify(saved).includes("CLE-SECRETE-1"), "save : réponse SANS jeton (ni clair ni chiffré)");

      // -- listFor : SANS jeton ; le jeton est CHIFFRÉ en base. --
      const list = db.listFor("doc-A");
      ck(list.length === 1 && !("token" in list[0]) && list[0].has_token === true, "listFor : jeton JAMAIS renvoyé (has_token seulement)");
      const row = raw.prepare("SELECT token_enc, options FROM wifi_providers WHERE doc_id=? AND id=?").get("doc-A", "w1");
      ck(/^v1:/.test(row.token_enc) && !row.token_enc.includes("CLE-SECRETE-1"), "DB : jeton stocké CHIFFRÉ (v1:…), jamais en clair");
      ck.eq(JSON.parse(row.options).site, "annexe", "DB : options persistées en JSON (aucune colonne par marque — critère D9)");

      // -- providersFor : déchiffre → config utilisable par l'adaptateur. --
      const forSync = db.providersFor("doc-A");
      ck.eq(forSync[0].token, "CLE-SECRETE-1", "providersFor : jeton DÉCHIFFRÉ (config utilisable pour la synchro)");
      ck(forSync[0].options.include_wired === true && forSync[0].interval_sec === 300, "providersFor : options + champs restitués");
      ck.eq(db.configuredDocIds().join(","), "doc-A", "configuredDocIds → documents configurés");

      // -- summariesFor : AUCUN jeton dans le chemin STATUT. --
      const sums = db.summariesFor("doc-A");
      ck(sums.length === 1 && !("token" in sums[0]) && sums[0].kind === "unifi" && sums[0].interval_sec === 300, "summariesFor : id/kind/intervalle, AUCUN jeton");
      ck(!db.summariesFor("doc-inexistant").length, "summariesFor : document non configuré → []");

      // -- AUDIT « qui » (posé PAR LE SERVEUR). --
      db.save("doc-A", { id: "w-aud", kind: "unifi", url: "https://a.lan" }, "CLE-AUD", "u-alice");
      let audit = raw.prepare("SELECT created_by, updated_by FROM wifi_providers WHERE id='w-aud'").get();
      ck(audit.created_by === "u-alice" && audit.updated_by === "u-alice", "audit : création → created_by/updated_by = id de l'auteur");
      db.save("doc-A", { id: "w-aud", kind: "unifi", url: "https://a.lan", interval_sec: 60 }, null, "u-bob");
      audit = raw.prepare("SELECT created_by, updated_by FROM wifi_providers WHERE id='w-aud'").get();
      ck(audit.created_by === "u-alice" && audit.updated_by === "u-bob", "audit : mise à jour → created_by CONSERVÉ, updated_by rafraîchi");
      ck.eq(raw.prepare("SELECT created_by FROM wifi_providers WHERE id='w1'").get().created_by, null, "audit : écriture sans auteur → colonne NULL");
      db.remove("doc-A", "w-aud");

      // -- save (édition, jeton vide → CONSERVÉ) : la sentinelle satisfait « token requis » sans rien stocker. --
      const upd = db.save("doc-A", { id: "w1", kind: "unifi", url: "https://unifi.lan", interval_sec: 600, options: { site: "annexe" } }, null);
      ck.eq(upd.interval_sec, 600, "save (édition) : champ mis à jour");
      ck.eq(db.providersFor("doc-A")[0].token, "CLE-SECRETE-1", "save (édition, jeton vide) : jeton EXISTANT conservé");
      ck.eq(upd.options.include_wired, false, "save (édition) : option non renvoyée → retour au DÉFAUT (les options sont remplacées en bloc)");

      // -- création SANS jeton / config invalide → WifiProviderConfigError, jeton jamais divulgué. --
      let noToken = null;
      try { db.save("doc-A", { id: "w-new", kind: "unifi", url: "https://x.lan" }, null); } catch (e) { noToken = e; }
      ck(noToken instanceof WifiProviderConfigError && noToken.issues.some((m) => /token/.test(m)), "save (création sans jeton) → « token requis »");
      let invalid = null;
      try { db.save("doc-A", { id: "w-bad", kind: "unifi" }, "CLE-NOPE"); } catch (e) { invalid = e; }
      ck(invalid instanceof WifiProviderConfigError && !invalid.message.includes("CLE-NOPE"), "save invalide → erreur de validation, jeton jamais dans le message");

      // -- buildForTest : jeton du corps, sinon le STOCKÉ déchiffré (tester sans ressaisir). --
      ck.eq(db.buildForTest("doc-A", { id: "w1", kind: "unifi", url: "https://unifi.lan" }, null).token, "CLE-SECRETE-1", "buildForTest : jeton vide + provider existant → jeton STOCKÉ déchiffré");
      ck.eq(db.buildForTest("doc-A", { id: "w1", kind: "unifi", url: "https://unifi.lan" }, "NOUVELLE").token, "NOUVELLE", "buildForTest : jeton fourni → celui-là");

      // -- remove. --
      ck.eq(db.remove("doc-A", "inexistant"), false, "remove (id inconnu) → false");

      // -- Jeton INDÉCHIFFRABLE (coffre à AUTRE clé) → provider EXCLU + erreur consultable. --
      const otherBox = new SecretBox("une-toute-autre-passphrase-de-test");
      const db2 = new WifiProviderConfigDb(dir, Sqlite, otherBox);
      ck.eq(db2.providersFor("doc-A").length, 0, "jeton indéchiffrable (autre clé) → provider EXCLU de la synchro");
      const errs = db2.tokenErrorsFor("doc-A");
      ck(errs.length === 1 && errs[0].id === "w1" && /ressaisi/.test(errs[0].message) && !errs[0].message.includes("CLE-SECRETE-1"),
        "…erreur MÉMORISÉE consultable (id + « à ressaisir »), sans le jeton");
      ck.eq(db2.summariesFor("doc-A").length, 0, "…et le chemin STATUT l'exclut pareillement (précondition de sa réinjection en erreur)");
      db2.close();

      // -- Options ILLISIBLES en base (édition manuelle / version future) → {} plutôt qu'un throw. --
      raw.prepare("UPDATE wifi_providers SET options = 'pas du json' WHERE id='w1'").run();
      ck.eq(JSON.stringify(db.listFor("doc-A")[0].options), "{}", "options illisibles en base → {} (l'adaptateur retombe sur ses défauts, aucun throw)");

      db.close();
    } finally {
      try { if (raw) raw.close(); } catch (_) { /* déjà fermé */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* dossier temp (handles longs sous Windows) */ }
    }
  });

  /* ============ SERVEUR : réconciliation PURE ============ */

  await section("Serveur : WifiReconcile — création, patch minimal, idempotence, déconnexion/retour, périmètre", async () => {
  {
    const { WifiReconcile } = SERVER("wifi/WifiReconcile.js");
    const NOW = "2026-08-03T12:00:00.000Z";
    let seq = 0;
    const mkInput = (records, existing, resolve) => ({
      providerId: "p1", records, existingClients: existing,
      resolveApEquipmentId: resolve || ((name) => (name === "ap-hall" ? "AP1" : null)),
      newId: () => "new-" + (++seq), nowIso: NOW,
    });
    const record = (over) => ({ ext_id: "AA:01", provider_id: "p1", name: "poste", mac: "AA:01", ip: "10.0.0.1", client_type: "wireless", ssid: "CORP", ap_mac: "99", ap_name: "ap-hall", connected_since: "2026-08-03T09:00:00.000Z", ...over });

    // 1) CRÉATION : champs source + LOCAUX par défaut + AP dérivé.
    seq = 0;
    const created = WifiReconcile.plan(mkInput([record()], [])).creates;
    ck.eq(created.length, 1, "création : 1 client neuf");
    ck(created[0].id === "new-1" && created[0].created_date === NOW && created[0].last_sync === NOW, "création : id/dates posés");
    ck.eq(created[0].ap_equipment_id, "AP1", "création : AP dérivé du nom (résolveur INJECTÉ)");
    ck(created[0].notes === "" && created[0].description === "", "création : champs LOCAUX à leur défaut");
    ck.eq(created[0].orphan, false, "création : présent à l'inventaire → orphan false");

    // 2) IDEMPOTENCE : re-planifier sur l'état écrit ne produit AUCUNE opération.
    const stored = { ...created[0] };
    const again = WifiReconcile.plan(mkInput([record()], [stored]));
    ck(again.creates.length === 0 && again.updates.length === 0 && again.orphans.length === 0, "idempotence : inventaire inchangé → AUCUNE opération");
    ck.eq(again.unchanged, 1, "idempotence : compté « inchangé »");

    // 3) PATCH MINIMAL : seul le champ modifié (+ last_sync) est écrit ; les LOCAUX sont préservés.
    const enriched = { ...stored, notes: "note utilisateur", description: "desc" };
    const patched = WifiReconcile.plan(mkInput([record({ ip: "10.0.0.42" })], [enriched])).updates;
    ck.eq(patched.length, 1, "patch : 1 mise à jour");
    ck.eq(Object.keys(patched[0].patch).sort().join(","), "ip,last_sync", "patch : MINIMAL (le champ modifié + last_sync, rien d'autre)");
    ck(!("notes" in patched[0].patch) && !("description" in patched[0].patch), "patch : les champs LOCAUX ne sont JAMAIS dans le patch");

    // 4) AP RE-RÉSOLU à chaque passe (champ dérivé) — et null quand l'AP n'est pas rapproché.
    const moved = WifiReconcile.plan(mkInput([record({ ap_name: "ap-etage" })], [stored])).updates;
    ck.eq(moved[0].patch.ap_equipment_id, null, "AP dérivé : nom d'AP sans équipement homonyme → null (jamais de valeur inventée)");
    ck.eq(moved[0].patch.ap_name, "ap-etage", "AP dérivé : le nom source est écrasé comme n'importe quel champ source");
    const backHome = WifiReconcile.plan(mkInput([record()], [{ ...stored, ap_name: "ap-etage", ap_equipment_id: null }])).updates;
    ck.eq(backHome[0].patch.ap_equipment_id, "AP1", "AP dérivé : retour sur un AP connu → re-rattaché tout seul");

    // 5) DÉCONNEXION : disparu de l'inventaire → patch orphan, JAMAIS de suppression.
    const gone = WifiReconcile.plan(mkInput([], [stored]));
    ck.eq(gone.orphans.length, 1, "disparu de l'inventaire → 1 « déconnecté »");
    ck(gone.orphans[0].patch.orphan === true && gone.orphans[0].patch.last_sync === NOW, "déconnexion : patch { orphan, last_sync } — l'enregistrement SURVIT");
    ck.eq(WifiReconcile.plan(mkInput([], [{ ...stored, orphan: true }])).orphans.length, 0, "déconnexion : déjà marqué → aucune op (idempotence)");

    // 6) RETOUR : un client déconnecté qui réapparaît repasse connecté (couvert par le diff, sans cas spécial).
    const returned = WifiReconcile.plan(mkInput([record()], [{ ...stored, orphan: true }])).updates;
    ck.eq(returned[0].patch.orphan, false, "retour : orphan true → false (le drapeau est un champ source comme un autre)");

    // 7) PÉRIMÈTRE : un autre provider n'est PAS touché.
    const other = { ...stored, id: "other", provider_id: "p2", ext_id: "BB:01" };
    const scoped = WifiReconcile.plan(mkInput([], [stored, other]));
    ck.eq(scoped.orphans.length, 1, "périmètre : seuls les clients de CE provider peuvent être marqués déconnectés");
    ck.eq(scoped.orphans[0].id, stored.id, "périmètre : … et c'est bien celui du provider réconcilié");
    // Un record estampillé d'un AUTRE provider est écarté (garde-fou d'appelant).
    ck.eq(WifiReconcile.plan(mkInput([record({ provider_id: "p2" })], [])).creates.length, 0, "périmètre : record d'un autre provider → écarté");

    // 8) TOLÉRANCE : record sans ext_id inexploitable ; doublon d'inventaire → premier gagne.
    ck.eq(WifiReconcile.plan(mkInput([record({ ext_id: "" })], [])).creates.length, 0, "record sans ext_id → écarté (inréconciliable)");
    seq = 0;
    ck.eq(WifiReconcile.plan(mkInput([record(), record({ name: "doublon" })], [])).creates.length, 1, "doublon d'ext_id dans l'inventaire → un seul créé");
  }
  });

  /* ============ SERVEUR : synchro de bout en bout (DocumentStore RÉEL) ============ */

  await section("Serveur : WifiSyncService — bout en bout (écritures, rev, SSE, statut, anti-rafale)", async () => {
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probe = new Candidate(":memory:"); probe.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section WifiSyncService sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { DocumentStore } = SERVER("documents.js");
    const { WifiSyncService } = SERVER("wifi/WifiSyncService.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-wifisync-"));
    try {
      const docs = new DocumentStore(dir, Sqlite);
      const doc = docs.create("infra-test");
      const repo = docs.repo(doc.id);
      // Équipements AP : « ap-hall » (rapprochement exact), « AP-Etage » (casse différente — le
      // rapprochement est insensible à la casse), et DEUX homonymes « ap-double » (ambiguïté).
      repo.transact({ creates: [
        { collection: "equipments", record: { id: "eq-hall", name: "ap-hall" } },
        { collection: "equipments", record: { id: "eq-etage", name: "AP-Etage" } },
        { collection: "equipments", record: { id: "eq-dup1", name: "ap-double" } },
        { collection: "equipments", record: { id: "eq-dup2", name: "ap-double" } },
      ] }, docs.markChanged(doc.id));

      const providers = {
        configuredDocIds: () => [doc.id],
        providersFor: (d) => d === doc.id
          ? [{ id: "wifi-1", kind: "unifi", url: "https://c.lan", token: "K", fingerprint: null, ca_pem: null, interval_sec: 0, timeout_sec: 15, options: { site: "default", include_wired: false } }]
          : [],
        summariesFor: (d) => providers.providersFor(d).map((c) => ({ id: c.id, kind: c.kind, interval_sec: c.interval_sec })),
      };

      let fixture = [
        { ext_id: "AA:01", provider_id: "wifi-1", name: "poste-1", mac: "AA:01", ip: "10.0.0.1", client_type: "wireless", ssid: "CORP", ap_mac: "99", ap_name: "ap-hall", connected_since: "2026-08-03T09:00:00.000Z" },
        { ext_id: "AA:02", provider_id: "wifi-1", name: "", mac: "AA:02", ip: "10.0.0.2", client_type: "wireless", ssid: "GUEST", ap_mac: null, ap_name: "AP-ETAGE", connected_since: null },
      ];
      let failInventory = false;
      const makeAdapter = (config) => ({
        kind: config.kind, config,
        test: async () => ({ ok: true, kind: config.kind, version: null, supported: true, message: "" }),
        inventory: async () => { if (failInventory) throw new Error("UniFi : délai dépassé (15000 ms)"); return { clients: fixture }; },
      });
      const live = { events: [], publish(docId, data) { this.events.push({ docId, data }); } };
      // minIntervalSec 0 : anti-rafale neutralisé pour dérouler le scénario (testé à part plus bas).
      const service = new WifiSyncService(docs, live, providers, undefined, makeAdapter, 0);

      // 1) Première synchro : 2 créations, AP résolus, rev consommée, SSE ciblé « wifiClients ».
      const revBefore = docs.getRev(doc.id);
      const r1 = await service.syncDocument(doc.id);
      ck(r1.length === 1 && r1[0].ok === true, "synchro OK (1 provider)");
      ck.eq(r1[0].counts.created, 2, "2 clients créés");
      const stored = repo.findBy("wifiClients", "provider_id", "wifi-1");
      ck.eq(stored.length, 2, "2 clients persistés dans le document");
      ck.eq(stored.find((c) => c.ext_id === "AA:01").ap_equipment_id, "eq-hall", "AP résolu par nom EXACT");
      ck.eq(stored.find((c) => c.ext_id === "AA:02").ap_equipment_id, "eq-etage", "AP résolu INSENSIBLEMENT à la casse (« AP-ETAGE » ↔ « AP-Etage »)");
      ck.eq(stored.find((c) => c.ext_id === "AA:02").name, "", "client sans hostname : `name` reste \"\" (cas nominal — l'UI replie sur la MAC)");
      ck(docs.getRev(doc.id) > revBefore, "révision du document consommée par l'écriture");
      ck.eq(live.events.length, 1, "1 événement SSE publié");
      ck(live.events[0].data.changeset.collections.join(",") === "wifiClients" && live.events[0].data.origin === "wifi-sync",
        "changeset ciblé sur `wifiClients` + origin wifi-sync (tous les clients rechargent)");

      // 2) Re-synchro à l'identique : IDEMPOTENTE de bout en bout (ni rev, ni SSE).
      const revAfter1 = docs.getRev(doc.id);
      const r2 = await service.syncDocument(doc.id);
      ck(r2[0].ok === true && r2[0].counts.unchanged === 2, "re-synchro : 2 inchangés");
      ck.eq(docs.getRev(doc.id), revAfter1, "aucune révision consommée (pas de bruit)");
      ck.eq(live.events.length, 1, "aucun événement SSE supplémentaire");

      // 3) Enrichissement local + changement source : les locaux survivent, le source est écrasé.
      const one = repo.findBy("wifiClients", "provider_id", "wifi-1").find((c) => c.ext_id === "AA:01");
      repo.transact({ updates: [{ collection: "wifiClients", record: { ...one, notes: "ma note", description: "ma desc" } }] }, docs.markChanged(doc.id));
      fixture = [{ ...fixture[0], ip: "10.0.0.99" }, fixture[1]];
      await service.syncDocument(doc.id);
      const after = repo.getOne("wifiClients", one.id);
      ck.eq(after.ip, "10.0.0.99", "champ SOURCE écrasé par la synchro (IP)");
      ck(after.notes === "ma note" && after.description === "ma desc", "champs LOCAUX préservés (notes + description)");

      // 4) Client parti → « déconnecté » (jamais supprimé).
      fixture = [fixture[0]];
      const r4 = await service.syncDocument(doc.id);
      ck.eq(r4[0].counts.disconnected, 1, "1 client déconnecté compté");
      const gone = repo.findBy("wifiClients", "provider_id", "wifi-1").find((c) => c.ext_id === "AA:02");
      ck(!!gone && gone.orphan === true, "client parti → orphan:true, toujours persisté (jamais delete)");
      ck(/déconnecté/.test(r4[0].message), "le résumé de statut parle de « déconnecté(s) », pas d'orphelins (vocabulaire D2)");

      // 5) AP AMBIGU : deux équipements homonymes → aucun rattachement (on ne devine pas).
      fixture = [{ ...fixture[0], ext_id: "AA:03", mac: "AA:03", ap_name: "ap-double" }];
      await service.syncDocument(doc.id);
      const ambiguous = repo.findBy("wifiClients", "provider_id", "wifi-1").find((c) => c.ext_id === "AA:03");
      ck(!!ambiguous && ambiguous.ap_equipment_id === null, "AP ambigu (2 équipements homonymes) → ap_equipment_id null");

      // 6) Inventaire en ÉCHEC : statut en erreur, document INTACT, last_success conservé.
      failInventory = true;
      const revBeforeFail = docs.getRev(doc.id);
      const r6 = await service.syncDocument(doc.id);
      ck(r6[0].ok === false && /délai dépassé/.test(r6[0].message), "échec d'inventaire → statut en erreur (message réseau)");
      ck(r6[0].last_success !== null, "last_success conservé malgré l'échec");
      ck.eq(docs.getRev(doc.id), revBeforeFail, "document intact après échec (aucune écriture)");
      failInventory = false;

      // 7) statusFor : fusion config déclarée × runtime ; document non configuré → [].
      const st = service.statusFor(doc.id);
      ck(st.length === 1 && st[0].provider_id === "wifi-1", "statusFor → état du provider configuré");
      ck.eq(service.statusFor("doc-inexistant").length, 0, "document non configuré → aucun provider (feature dormante)");

      // 8) Inventaire VIDE : les clients passent déconnectés ET le statut explique les deux pièges.
      fixture = [];
      const r8 = await service.syncDocument(doc.id);
      ck(r8[0].ok === true, "inventaire vide : pas une erreur (un site sans client connecté existe)");
      ck(/AUCUN client remonté/.test(r8[0].message) && /SITE/.test(r8[0].message) && /clé d'API/.test(r8[0].message),
        "…mais le statut explique les deux pièges de config (site, droits de la clé)");

      // 9) AUTORITÉ SERVEUR : un inventaire dont un enregistrement viole la spec est refusé EN BLOC.
      //    `ap_equipment_id` pointant un équipement inexistant est une FK invalide (V2).
      const badService = new WifiSyncService(docs, live, providers, undefined,
        () => ({ kind: "unifi", config: {}, test: async () => ({}), inventory: async () => ({ clients: [{ ext_id: "ZZ:01", provider_id: "wifi-1", name: "x", mac: "ZZ:01", ip: null, client_type: "wireless", ssid: null, ap_mac: null, ap_name: "fantome", connected_since: null }] }) }), 0);
      // Résolveur réel : « fantome » n'existe pas → null, donc l'enregistrement est VALIDE.
      const rOk = await badService.syncDocument(doc.id);
      ck(rOk[0].ok === true, "AP inconnu → ap_equipment_id null, l'enregistrement reste VALIDE (aucune FK inventée)");

      // 10) ANTI-RAFALE : deux clics quasi simultanés = UNE seule passe d'inventaire.
      let calls = 0;
      const counting = () => ({ kind: "unifi", config: {}, test: async () => ({}), inventory: async () => { calls++; return { clients: [] }; } });
      const throttled = new WifiSyncService(docs, live, providers, undefined, counting, 3600);
      const t1 = await throttled.syncDocument(doc.id);
      const t2 = await throttled.syncDocument(doc.id);
      ck.eq(calls, 1, "relance sous le délai minimal → UNE seule passe d'inventaire");
      ck(/relance ignorée/.test(t2[0].message), "…la seconde reçoit le dernier statut, annoté « relance ignorée »");
      ck(t1[0].last_attempt === t2[0].last_attempt, "…même horodatage de tentative (aucune nouvelle passe)");
      ck(!/relance ignorée/.test(throttled.statusFor(doc.id)[0].message), "…l'annotation n'est PAS stockée dans le statut persistant");

      // 11) PRODUCTEUR de problèmes (pont vers notify) : raise en échec, resolve au retour.
      const problems = { raised: [], resolved: [], raise(k, e) { this.raised.push({ k, e }); }, resolve(k) { this.resolved.push(k); } };
      let ko = true;
      const reported = new WifiSyncService(docs, live, providers, undefined,
        () => ({ kind: "unifi", config: {}, test: async () => ({}), inventory: async () => { if (ko) throw new Error("panne"); return { clients: [] }; } }), 0, problems);
      await reported.syncDocument(doc.id);
      ck.eq(problems.raised.length, 1, "échec → 1 signalement levé");
      ck.eq(problems.raised[0].k, "wifi-sync:" + doc.id + ":wifi-1", "clé STABLE par couple document×provider (le moteur notify déduplique dessus)");
      ck.eq(problems.raised[0].e.event_type, "wifi-sync-failure", "type d'événement dédié à la feature");
      ko = false;
      await reported.syncDocument(doc.id);
      ck.eq(problems.resolved.length, 1, "retour à la normale → clôture (resolve)");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* dossier temp */ }
    }
  });

  /* ============ INVARIANTS D'AGNOSTICISME DE MARQUE (décision D9) ============ */

  await section("Serveur : agnosticisme de marque — fabrique ⇄ table d'options, points d'extension isolés", async () => {
  {
    const { WifiSyncService } = SERVER("wifi/WifiSyncService.js");
    const { KIND_OPTION_SPECS, SUPPORTED_KINDS } = SERVER("wifi/WifiProviderConfigValidate.js");
    const cfgOf = (kind) => ({ id: "x", kind, url: "https://c.lan", token: "k", fingerprint: null, ca_pem: null, interval_sec: 0, timeout_sec: 15, options: {} });

    // COHÉRENCE : tout kind VALIDABLE doit avoir un ADAPTATEUR (sinon on enregistre un provider mort).
    for (const kind of SUPPORTED_KINDS) {
      let built = null;
      try { built = WifiSyncService.adapterFor(cfgOf(kind)); } catch (_) { built = null; }
      ck(!!built && built.kind === kind, "cohérence D9 : le kind « " + kind + " » (table d'options) a bien un adaptateur dans la fabrique");
    }
    // Et réciproquement : un kind SANS entrée d'options est refusé par la fabrique.
    let threw = false;
    try { WifiSyncService.adapterFor(cfgOf("marque-inconnue")); } catch (e) { threw = /inconnu/.test(e.message); }
    ck(threw, "cohérence D9 : un kind inconnu est REFUSÉ par la fabrique (message actionnable)");
    ck.eq(Object.keys(KIND_OPTION_SPECS).length, 1, "v1 : une seule marque implémentée (UniFi) — le mécanisme, lui, en accepte N");

    // ISOLEMENT : les modules AGNOSTIQUES ne doivent nommer AUCUNE marque. On relit les SOURCES
    // (c'est le code ÉCRIT qu'on contrôle) et on refuse toute mention, hors commentaires — un
    // « unifi » qui s'invite dans le service ou la réconciliation est exactement la régression que
    // D9 interdit. Seuls la FABRIQUE (WifiSyncService.adapterFor) et l'import de l'adaptateur y
    // échappent, par construction : ils SONT le point d'extension.
    const fs = require("fs");
    const ts = require("typescript");
    const agnostic = ["WifiProvider.ts", "WifiReconcile.ts", "WifiProviderConfigDb.ts", "WifiModule.ts"];
    for (const file of agnostic) {
      const full = path.join(__dirname, "..", "..", "src-server", "src", "wifi", file);
      const source = ts.createSourceFile(file, fs.readFileSync(full, "utf8"), ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
      // On ne regarde que les LITTÉRAUX de chaîne et les identifiants — jamais les commentaires,
      // qui DOIVENT pouvoir citer UniFi (ils expliquent la première implémentation).
      const offenders = [];
      const visit = (node) => {
        if (ts.isStringLiteralLike(node) && /unifi/i.test(node.text)) offenders.push(node.text);
        if (ts.isIdentifier(node) && /^Unifi/.test(node.text)) offenders.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(source);
      ck.eq(offenders.length, 0, "agnosticisme : « " + file + " » ne nomme aucune marque dans son CODE (fautifs : " + offenders.join(", ") + ")");
    }
  }
  });

  /* ============ CLIENT : modules purs (présence, localisation) ============ */

  await section("Client : WifiStatus / WifiLocate — présence « déconnecté » et localisation de l'AP", async () => {
  {
    const { WifiStatus } = D("core/WifiStatus.js");
    const { WifiLocate } = D("core/WifiLocate.js");

    // -- PRÉSENCE : le vocabulaire est « déconnecté », la couleur un AVERTISSEMENT (pas une erreur). --
    ck.eq(WifiStatus.isDisconnected({ orphan: true }), true, "isDisconnected : orphan true");
    ck.eq(WifiStatus.isDisconnected({}), false, "isDisconnected : absent → connecté");
    ck.eq(WifiStatus.isDisconnected(null), false, "isDisconnected : null toléré");
    ck.eq(WifiStatus.COLOR_DISCONNECTED, "var(--warn)", "couleur : AVERTISSEMENT et non erreur (un client qui part est ordinaire — D2)");
    ck.eq(WifiStatus.rawType({ client_type: "  Wireless " }), "Wireless", "rawType : rogné, jamais traduit (vocabulaire de la marque conservé)");
    ck(WifiStatus.sortKey({ orphan: true }) > WifiStatus.sortKey({}), "sortKey : les déconnectés sont groupés APRÈS les connectés");

    // -- PASTILLES : HTML SÛR (la valeur du contrôleur est échappée, jamais injectée en style). --
    const injected = WifiStatus.typePill({ client_type: '"><script>alert(1)</script>' });
    ck(!injected.includes("<script>") && injected.includes("&lt;script&gt;"), "typePill : la valeur SOURCE est échappée (aucune injection possible)");
    ck.eq(WifiStatus.disconnectedPill({}), "", "disconnectedPill : client connecté → aucune pastille");
    ck(/title="/.test(WifiStatus.disconnectedPill({ orphan: true }, "explication")), "disconnectedPill : infobulle posée quand elle est fournie (la fiche l'utilise, le listing non)");
    ck(!/title="/.test(WifiStatus.disconnectedPill({ orphan: true })), "disconnectedPill : aucune infobulle sans titre (colonne étroite du listing)");
    const both = WifiStatus.pills({ orphan: true, client_type: "wireless" });
    ck(both.indexOf("wireless") > 0 && /var\(--warn\)/.test(both), "pills : présence EN TÊTE puis type (les deux, jamais l'un à la place de l'autre)");

    // -- LOCALISATION : on vise l'AP, et seulement s'il est réellement localisable. --
    const store = (opts) => ({ get: (c, id) => (opts.equipments || {})[id] || null, equipmentLocatable: () => opts.locatable !== false });
    ck.eq(WifiLocate.apEquipmentId({ ap_equipment_id: "AP1" }, store({ equipments: { AP1: { id: "AP1" } } })), "AP1", "localisation : AP rapproché ET localisable → son id");
    ck.eq(WifiLocate.apEquipmentId({}, store({})), null, "localisation : client jamais rapproché → null (aucun bouton)");
    ck.eq(WifiLocate.apEquipmentId({ ap_equipment_id: "AP1" }, store({ equipments: {} })), null, "localisation : référence PENDANTE (AP supprimé) → null");
    ck.eq(WifiLocate.apEquipmentId({ ap_equipment_id: "AP1" }, store({ equipments: { AP1: { id: "AP1" } }, locatable: false })), null,
      "localisation : AP non localisable → null (autorité UNIQUE Store.equipmentLocatable, jamais réécrite ici)");
    ck.eq(WifiLocate.apEquipmentId({ ap_equipment_id: "   " }, store({})), null, "localisation : id blanc → null");
    ck.eq(WifiLocate.apEquipmentId(null, store({})), null, "localisation : client null toléré");
  }
  });
};
