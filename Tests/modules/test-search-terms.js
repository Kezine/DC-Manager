/* Tests modules — TERMES DE RECHERCHE PARTAGÉS (src-shared/SearchTerms, lot 1 du chantier recherche/chargement).
   ----------------------------------------------------------------------------
   Prouve les trois pans du lot (cadrage `.notes/toDos/chargement-dynamique-document-cadrage-2026-08-02.md` §4bis) :
   1. MODULE PUR : golden terms EXPLICITES sur un mini-corpus façon démo (équipement racké / sur étagère
      (2 sauts) / libre en salle / localisé par site — sous-équipement — câble 2 bouts × 2 sauts — faisceau —
      salle/étage → site — VM/IP/spare) ; catalogues fr+en VERROUILLÉS sur les locales client (la duplication
      assumée ne peut pas dériver en silence) ; requêtes INVERSES golden (dont la chaîne équipement → ports →
      câbles) ; PARITÉ « aucun terme propre perdu » (ownText ≡ l'ancien Object.values, searchText le préfixe).
   2. SERVEUR (better-sqlite3 RÉEL `:memory:` + fichiers temp) : colonne `search` enrichie à l'écriture,
      INVALIDATION des dépendants (renommage de baie → équipements re-trouvables, renommage d'équipement →
      câbles à 2 sauts), `updated_rev` des dépendants INCHANGÉE (pas de faux 409 — LE test qui compte),
      transact intra-lot (ordre des creates indifférent), delete, replaceSnapshot en seconde passe, et
      BACKFILL `PRAGMA user_version` (document « pauvre » enrichi à l'ouverture, idempotent).
   3. INSTRUMENTATION du boot (core/HydrationStats, volet A du cadrage) : comptes/taille/durée + seuils D3.
   LOT 2 (recherche serveur-pilotée, docs/recherche.md) s'y ajoute :
   4. COMPOSITIONS tapables search-v2 (« U12 », « ét. N »/« fl. N », « 42 U », « brins/strands »,
      « marque modèle », capacités/rpm) — goldens + verrous des préfixes/unités sur les locales ;
   5. `searchAll` (recherche TRANSVERSE en un appel : multi-collections, normalisation, cap par
      collection + troncature signalée, périmètre `collections`, requête vide) ;
   6. BACKFILL v1 → v2 (fichier réel : le bump de SEARCH_VERSION rattrape les documents search-v1).
   Harnais et assertions : harness.js. */
"use strict";
const fs = require("fs");
const os = require("os");
const { ck, section, path, D, SHARED, SERVER, SharedSchema } = require("./harness.js");

const { SearchTerms, SEARCH_CATALOGS } = SHARED("src-shared/SearchTerms.js");
const norm = SharedSchema.normSearch;

/* -------- better-sqlite3 RÉEL (même sonde/politique que test-relational-repository : ÉCHEC actionnable,
   jamais un skip silencieux — le volet serveur du lot 1 ne doit pas passer sans preuve). -------- */
let SQLITE = null, SQLITE_ERROR = "";
try {
  const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
  new Candidate(":memory:").close();
  SQLITE = Candidate;
} catch (e) { SQLITE_ERROR = ((e && e.message) || String(e)).split("\n")[0]; }
const requireSqlite = () => {
  if (SQLITE) return true;
  ck(false, "better-sqlite3 RÉEL indisponible (" + SQLITE_ERROR + ") — `npm install` dans src-server/ ; ÉCHEC au lieu d'un saut (lot 1 recherche)");
  return false;
};

/* -------- mini-corpus façon démo (formes des records = celles de samples-public/demo-infra.json) --------
   Lecteurs injectés SYNCHRONES sur ce corpus : exactement le rôle que tiendra le Store client au lot 2
   (principe n°15 — la même fonction, un autre transport). `find` gère l'appartenance des champs tableaux
   (group_ids) comme les index du Store et le json_each serveur. */
const CORPUS = {
  sites: [{ id: "site-a", name: "Site Alpha", address: "Rue Haute 1" }],
  floors: [{ id: "fl-1", location: "site-a", floor: "2" }],
  datacenters: [{ id: "dc-1", name: "Salle Nord", location: "site-a", floor: "2", room: "R12" }],
  racks: [{ id: "rk-1", name: "Baie B01", datacenter_id: "dc-1" }],
  rackItems: [{ id: "tray-1", kind: "tray", rack_id: "rk-1" }],
  equipments: [
    { id: "eq-rack", name: "SW-Coeur", type: "switch", placement_mode: "rack", rack_id: "rk-1", rack_u: 12, group_id: "gr-1", group_ids: ["gr-1", "gr-2"] },
    { id: "eq-tray", name: "NUC-Etagere", type: "pc", placement_mode: "tray", tray_item_id: "tray-1" },
    { id: "eq-libre", name: "Robot-Salle", type: "other", dc_id: "dc-1" },
    { id: "eq-site", name: "Routeur-Site", type: "firewall-inconnu", location: "site-a" },
  ],
  subEquipments: [{ id: "se-1", name: "Drive LTO-9", serial: "SN-777", equipment_id: "eq-rack" }],
  groups: [{ id: "gr-1", label: "Stack Coeur", type: "stack" }, { id: "gr-2", label: "Prod", type: "general" }],
  ports: [
    { id: "p-1", name: "Gi1/0/1", equipment_id: "eq-rack" },
    { id: "p-2", name: "eth0", equipment_id: "eq-libre" },
  ],
  cableTypes: [{ id: "ct-1", name: "Cat6A" }],
  cables: [{ id: "cb-1", name: "C-001", cable_type_id: "ct-1", from_port_id: "p-1", to_port_id: "p-2", status: "cable" }],
  cableBundles: [{ id: "bd-1", name: "Trunk-1", endpoint_a_equipment_id: "eq-rack", endpoint_b_equipment_id: "eq-libre" }],
  vms: [{ id: "vm-1", name: "srv-web", host_equipment_id: "eq-rack", orphan: true, nics: [{ mac: "aa:bb", ips: ["10.0.0.5", "10.0.0.6"] }] }],
  ipAddresses: [
    { id: "ip-1", address: "10.0.0.5", equipment_id: "eq-rack" },
    { id: "ip-2", address: "10.0.0.9", vm_id: "vm-1" },
  ],
  spares: [{ id: "sp-1", name: "Disque de rechange", type: "hdd", status: "assigned", assigned_equipment_id: "eq-rack" }],
  contacts: [{ id: "co-1", name: "Alice", email: "a@ex.org" }],
  applications: [
    { id: "app-eq", name: "GLPI", url: "https://glpi.local", equipment_id: "eq-rack" },
    { id: "app-vm", name: "Grafana", vm_id: "vm-1" },
  ],
};
const fetchOf = (corpus) => (collection, id) => (corpus[collection] || []).find((r) => r.id === id) || null;
const findOf = (corpus) => (collection, field, value) => (corpus[collection] || [])
  .filter((r) => (Array.isArray(r[field]) ? r[field].map(String).includes(String(value)) : String(r[field]) === String(value)));
const rec = (collection, id) => CORPUS[collection].find((r) => r.id === id);
const termsOf = (collection, record) => SearchTerms.termsOf(collection, record, fetchOf(CORPUS), findOf(CORPUS));

module.exports = async () => {
  await section("shared : SearchTerms — golden terms (dérivations du relevé client, mini-corpus démo)", async () => {
  {
    // -- équipement RACKÉ : baie + groupes (primaire dédupliqué) + sous-équipements + catalogue type. --
    const tRack = termsOf("equipments", rec("equipments", "eq-rack"));
    ck(tRack.includes("Baie B01"), "equipment racké : le NOM DE SA BAIE est un terme (rack_id → racks.name)");
    ck(tRack.includes("Stack Coeur") && tRack.includes("Prod"), "equipment : les LABELS de ses groupes (group_id + group_ids → groups.label)");
    ck.eq(tRack.filter((t) => t === "Stack Coeur").length, 1, "equipment : groupe PRIMAIRE ⊂ group_ids → terme dédoublonné (une seule occurrence)");
    ck(tRack.includes("Drive LTO-9") && tRack.includes("SN-777"), "equipment : noms + séries de ses SOUS-ÉQUIPEMENTS (dérivation par ENFANTS — « taper Drive LTO fait ressortir la librairie »)");
    ck(tRack.includes("Switch"), "equipment : libellé de CATALOGUE du type (switch → « Switch »)");
    ck(!tRack.includes("Salle Nord"), "equipment racké : PAS le nom de la salle (le chemin de la palette s'arrête à la baie)");

    // -- équipement SUR ÉTAGÈRE : 2 SAUTS (tray_item_id → rackItems.rack_id → racks.name). --
    const tTray = termsOf("equipments", rec("equipments", "eq-tray"));
    ck(tTray.includes("Baie B01"), "equipment sur étagère : nom de la baie PORTEUSE à 2 sauts (tray → rack)");
    ck(tTray.includes("PC"), "equipment sur étagère : catalogue du type (pc)");

    // -- équipement LIBRE en salle + équipement localisé par SITE (lien par le CHAMP location). --
    ck(termsOf("equipments", rec("equipments", "eq-libre")).includes("Salle Nord"), "equipment libre : nom de SA SALLE (dc_id → datacenters.name)");
    const tSite = termsOf("equipments", rec("equipments", "eq-site"));
    ck(tSite.includes("Site Alpha"), "equipment localisé par site : nom du SITE (lien par le CHAMP location — pas une FK de spec)");
    ck(tSite.includes("Autre") && tSite.includes("Other"), "equipment de type INCONNU : repli catalogue « Autre »/« Other » (parité EquipmentTypes.resolveId)");

    // -- sous-équipement : le nom du MAÎTRE. --
    ck(termsOf("subEquipments", rec("subEquipments", "se-1")).includes("SW-Coeur"), "sous-équipement : nom du MAÎTRE (equipment_id → equipments.name)");

    // -- câble : type + « équipement : port » des DEUX bouts (2 sauts chacun). --
    const tCable = termsOf("cables", rec("cables", "cb-1"));
    ck(tCable.includes("Cat6A"), "câble : nom du TYPE (cable_type_id → cableTypes.name)");
    ck(tCable.includes("Gi1/0/1") && tCable.includes("eth0"), "câble : noms des PORTS des deux bouts (from/to_port_id → ports.name)");
    ck(tCable.includes("SW-Coeur") && tCable.includes("Robot-Salle"), "câble : noms des ÉQUIPEMENTS des deux bouts (2 SAUTS : port → equipment)");

    // -- faisceau : équipements des extrémités. --
    const tBundle = termsOf("cableBundles", rec("cableBundles", "bd-1"));
    ck(tBundle.includes("SW-Coeur") && tBundle.includes("Robot-Salle"), "faisceau : équipements des DEUX extrémités (endpoint_a/b_equipment_id)");

    // -- salle → site ; étage → site ; baie → salle. --
    ck(termsOf("datacenters", rec("datacenters", "dc-1")).includes("Site Alpha"), "salle : nom du SITE (champ location)");
    ck(termsOf("floors", rec("floors", "fl-1")).includes("Site Alpha"), "étage : nom du SITE (son libellé même est « site · ét. N »)");
    ck(termsOf("racks", rec("racks", "rk-1")).includes("Salle Nord"), "baie : nom de SA SALLE (datacenter_id)");

    // -- VM : hôte + « orpheline » fr/en + IPs des vNIC (champ propre ENFOUI dans nics). --
    const tVm = termsOf("vms", rec("vms", "vm-1"));
    ck(tVm.includes("SW-Coeur"), "VM : nom de l'HÔTE (host_equipment_id → equipments.name)");
    ck(tVm.includes("orpheline") && tVm.includes("orphan"), "VM orpheline : catalogue fr+en (« orpheline » ET « orphan » — le serveur ignore la langue)");
    ck(tVm.includes("10.0.0.5") && tVm.includes("10.0.0.6"), "VM : IPs des vNIC (enfouies dans la structure `nics` — la sérialisation brute n'en tirait que [object Object])");
    ck(!termsOf("vms", { id: "vm-x", name: "up", orphan: false }).includes("orphan"), "VM non orpheline : AUCUN terme d'orphelinat (false ≠ clé de catalogue)");

    // -- IP : porteur équipement OU VM ; spare : attribution + catalogue type fr+en. --
    ck(termsOf("ipAddresses", rec("ipAddresses", "ip-1")).includes("SW-Coeur"), "IP : nom de l'équipement porteur");
    ck(termsOf("ipAddresses", rec("ipAddresses", "ip-2")).includes("srv-web"), "IP : nom de la VM porteuse");

    // -- APPLICATION (search-v5) : hôte équipement OU VM (patron ipAddresses) — taper « SW-Coeur »
    //    remonte GLPI ; l'URL est une colonne PLATE (couverte par ownText, pas un terme dérivé). --
    ck(termsOf("applications", rec("applications", "app-eq")).includes("SW-Coeur"), "application : nom de l'ÉQUIPEMENT hôte (equipment_id → equipments.name)");
    ck(termsOf("applications", rec("applications", "app-vm")).includes("srv-web"), "application : nom de la VM hôte (vm_id → vms.name)");
    ck.eq(termsOf("applications", { id: "app-x", name: "Sans hôte", url: "https://x.local" }).length, 0, "application sans hôte : AUCUN terme dérivé (URL/description = colonnes plates, ownText suffit)");
    // Et le CONTENU COMPLET de la colonne (searchText) porte bien le nom de l'hôte — c'est lui que
    // le backfill/l'invalidation matérialisent côté serveur.
    ck(SearchTerms.searchText("applications", rec("applications", "app-eq"), fetchOf(CORPUS), findOf(CORPUS)).includes(norm("SW-Coeur")),
      "application : searchText contient le nom de l'hôte (colonne `search` enrichie)");
    const tSpare = termsOf("spares", rec("spares", "sp-1"));
    ck(tSpare.includes("SW-Coeur"), "spare : nom de l'équipement ATTRIBUÉ (assignedTo du listing)");
    ck(tSpare.includes("HDD (disque dur)") && tSpare.includes("HDD (hard drive)"), "spare : catalogue du type fr+en");
    ck(termsOf("groups", rec("groups", "gr-1")).includes("Stack"), "groupe : libellé de catalogue du type (GroupTypes)");

    // -- collections SANS dérivation : aucun terme (les valeurs propres suffisent — relevé). --
    ck.eq(termsOf("contacts", rec("contacts", "co-1")).length, 0, "contact : AUCUN terme dérivé (le relevé n'en montre pas — spec absente)");
    ck.eq(termsOf("ports", rec("ports", "p-1")).length, 0, "port : aucun terme dérivé (les ports ne sont pas cherchables en palette)");

    // -- cible ABSENTE : silence (l'intégrité référentielle V2 s'en occupe, pas la recherche).
    //    Depuis search-v2 la baie porte toujours sa composition « 42 U » (own, sans lecteur) — on
    //    vérifie donc qu'aucun terme NE VIENT DU LIEN, pas l'absence totale. --
    ck.eq(termsOf("racks", { id: "rk-x", name: "Orpheline", datacenter_id: "dc-fantome" }).filter((t) => t !== "42 U").length, 0,
      "lien vers une cible ABSENTE : aucun terme de lien, aucune erreur (seule la composition « 42 U » de v2 demeure)");
  }
  });

  await section("shared : SearchTerms — parité « aucun terme propre perdu » + catalogues VERROUILLÉS sur les locales", async () => {
  {
    // -- ownText ≡ la formule HISTORIQUE de la colonne (Object.values, tableaux joints, normSearch partout,
    //    clés inconnues incluses). On la RÉ-IMPLÉMENTE ici indépendamment : si le module dévie, ce test nomme l'écart. --
    const tricky = { id: "x1", name: "Générateur Été", tags: ["Aiguë", "b"], nb: 42, rien: null, ok: true, fantome: "Caché" };
    const legacy = Object.values(tricky).map((v) => (Array.isArray(v) ? v.map((x) => norm(x)).join(" ") : norm(v))).join(" ");
    ck.eq(SearchTerms.ownText(tricky), legacy, "ownText : PARITÉ STRICTE avec l'historique Object.values (accents, tableaux, null, booléen, clé inconnue)");

    // -- searchText = ownText PRÉFIXE + dérivés normalisés : tout terme d'hier matche encore, l'enrichissement AJOUTE. --
    const full = SearchTerms.searchText("equipments", rec("equipments", "eq-rack"), fetchOf(CORPUS), findOf(CORPUS));
    const own = SearchTerms.ownText(rec("equipments", "eq-rack"));
    ck(full.startsWith(own), "searchText : les valeurs PROPRES d'abord, intégralement (aucun terme d'aujourd'hui perdu)");
    ck(full.includes(norm("Baie B01")) && full.includes(norm("Drive LTO-9")), "searchText : les dérivés NORMALISÉS s'ajoutent à la suite");
    ck.eq(SearchTerms.searchText("contacts", rec("contacts", "co-1"), fetchOf(CORPUS), findOf(CORPUS)), SearchTerms.ownText(rec("contacts", "co-1")),
      "searchText sans dérivation ≡ ownText (aucun espace parasite)");

    // -- CATALOGUES ⇄ LOCALES : la duplication assumée (SEARCH_CATALOGS ↔ i18n/locales) est verrouillée —
    //    chaque libellé d'AFFICHAGE fr et en doit apparaître dans les termes partagés, et les ids couvrent
    //    exactement les tables métier (EQUIPMENT_TYPES, GROUP_TYPE_IDS, SPARE_TYPE_IDS). --
    const frDomain = D("i18n/locales/fr/domain.js").domain, enDomain = D("i18n/locales/en/domain.js").domain;
    const frLists = D("i18n/locales/fr/lists.js").lists, enLists = D("i18n/locales/en/lists.js").lists;
    const { EQUIPMENT_TYPES } = D("domain/constants.js");
    const Validation = SHARED("src-shared/DataValidation.js");
    const covers = (catalog, id, frLabel, enLabel) => {
      const terms = (catalog[id] || []).map(norm);
      return terms.includes(norm(frLabel)) && terms.includes(norm(enLabel));
    };
    ck(EQUIPMENT_TYPES.every((t) => covers(SEARCH_CATALOGS.equipmentType, t.id, frDomain.equipmentType[t.id], enDomain.equipmentType[t.id])),
      "catalogue equipmentType : CHAQUE type couvre ses libellés fr ET en (les locales sont la référence)");
    ck.eq(Object.keys(SEARCH_CATALOGS.equipmentType).sort().join(","), EQUIPMENT_TYPES.map((t) => t.id).sort().join(","),
      "catalogue equipmentType : mêmes ids que EQUIPMENT_TYPES (ni manque, ni fantôme)");
    ck(Validation.GROUP_TYPE_IDS.every((id) => covers(SEARCH_CATALOGS.groupType, id, frDomain.groupType[id], enDomain.groupType[id])),
      "catalogue groupType : libellés fr+en couverts pour chaque id");
    ck(Validation.SPARE_TYPE_IDS.every((id) => covers(SEARCH_CATALOGS.spareType, id, frDomain.spareType[id], enDomain.spareType[id])),
      "catalogue spareType : libellés fr+en couverts pour chaque id");
    const orphanTerms = SEARCH_CATALOGS.vmOrphan.map(norm);
    ck(orphanTerms.includes(norm(frLists.ph.orphan)) && orphanTerms.includes(norm(enLists.ph.orphan)),
      "catalogue vmOrphan : « orpheline » (fr) ET « orphan » (en) — lists.ph.orphan des deux locales");
  }
  });

  await section("shared : SearchTerms — COMPOSITIONS tapables (search-v2) + verrous des préfixes/unités sur les locales", async () => {
  {
    // -- Le lot 2 réplique les chaînes COMPOSÉES que le client CHERCHE déjà (habillage de la palette,
    //    désignations dérivées des spares) : notations qu'un humain TAPE — « U12 », « ét. 2 », « 42 U »,
    //    « 12 brins », « Dell R740 », capacités/rpm. Les assemblages typographiques (« – », « ↔ »,
    //    « équipement : port », joints « · ») restent ASSUMÉS non répliqués (cf. docs/recherche.md). --
    // ⚠ Attente EXPLICITE (jamais dérivée du module) : le marqueur de version est le déclencheur du
    // backfill, une valeur figée par erreur laisserait les documents existants sur une spec périmée.
    // v3 = ajout de la collection `wifiClients` à la spec (chantier provider wifi, 2026-08-03).
    // v4 = la collection `issues` a été AJOUTÉE puis RETIRÉE de la spec (chantier « remote issue
    // tracker », abandonné au pivot du 2026-08-07). 🚨 Le marqueur NE REDESCEND PAS à 3 : il est
    // MONOTONE, et des bases locales ont pu passer en v4 pendant le chantier — les faire croire à un
    // retard de spec les re-backfillerait sans fin. Cf. le commentaire de `SEARCH_VERSION`.
    // v5 = ajout de la collection `applications` à la spec (hôte équipement/VM résolu par lien,
    // chantier applications 2026-08-10).
    ck.eq(SearchTerms.SEARCH_VERSION, 5, "SEARCH_VERSION = 5 (compositions v2 + wifiClients v3 + retrait d'issues v4 + applications v5 — le marqueur est MONOTONE, jamais décrémenté)");

    // équipement posé en baie : « U12 » (conditions du path client : placement rack/side/wall + rack_id + rack_u).
    ck(termsOf("equipments", rec("equipments", "eq-rack")).includes("U12"), "equipment racké (rack_u 12) : « U12 » est un terme — la position se tape telle quelle");
    ck(!termsOf("equipments", rec("equipments", "eq-libre")).some((t) => /^U\d/.test(t)), "equipment SANS baie : aucun terme « U… » (la composition suit les conditions du chemin client)");
    // marque + modèle d'un trait (sub de la palette « Dell R740 ») — seulement si les DEUX sont présents.
    ck(termsOf("equipments", { id: "e-bm", type: "server", brand: "Dell", model: "R740" }).includes("Dell R740"), "equipment : « marque modèle » composé (Dell R740 se tape d'un trait)");
    ck(!termsOf("equipments", { id: "e-b", type: "server", brand: "Dell" }).some((t) => t.startsWith("Dell ")), "equipment : marque SEULE → pas de composition (la valeur propre suffit)");

    // baie : « 42 U » avec le DÉFAUT du client reproduit (sub de la palette : (u_count || 42) + " U").
    ck(termsOf("racks", rec("racks", "rk-1")).includes("42 U"), "baie sans u_count : « 42 U » (défaut client reproduit)");
    ck(termsOf("racks", { id: "rk-47", name: "B", u_count: 47 }).includes("47 U"), "baie 47 U : « 47 U »");

    // étages/salles : « ét. N » ET « fl. N » (les DEUX langues, comme les catalogues).
    const tFloor = termsOf("floors", rec("floors", "fl-1"));
    ck(tFloor.includes("ét. 2") && tFloor.includes("fl. 2"), "étage : « ét. 2 » (fr) ET « fl. 2 » (en) — le libellé même de l'étage");
    const tDc = termsOf("datacenters", rec("datacenters", "dc-1"));
    ck(tDc.includes("ét. 2") && tDc.includes("fl. 2"), "salle avec étage : « ét. 2 »/« fl. 2 » (chemin de la palette)");
    ck(!termsOf("datacenters", { id: "dc-x", name: "Salle sans étage" }).some((t) => /^(ét\.|fl\.)/.test(t)), "salle SANS étage : aucune composition d'étage");

    // faisceau : « 24 brins »/« 24 strands » (sous-ligne localisée de la palette).
    const tBundle = termsOf("cableBundles", { id: "bd-x", name: "T", fiber_count: 24 });
    ck(tBundle.includes("24 brins") && tBundle.includes("24 strands"), "faisceau : « 24 brins » (fr) ET « 24 strands » (en)");
    ck(!termsOf("cableBundles", rec("cableBundles", "bd-1")).some((t) => /brins|strands/.test(t)), "faisceau SANS fiber_count : aucune composition (le client n'affiche rien non plus)");

    // spares : désignation dérivée (Spare.displayName/techSummary) — mêmes CONDITIONS que le client.
    const disk = { id: "sp-d", type: "hdd", brand: "WD", model_pn: "Red 4", capacity_value: 4, capacity_unit: "TB", rpm: 5400 };
    const tDisk = termsOf("spares", disk);
    ck(tDisk.includes("WD Red 4"), "spare : « marque référence » composé (join espace de displayName)");
    ck(tDisk.includes("4 TB"), "spare hdd : capacité « 4 TB » composée (techSummary, types disque seuls)");
    ck(tDisk.includes("5400 rpm"), "spare hdd : « 5400 rpm » composé");
    ck(termsOf("spares", { ...disk, id: "sp-s", type: "ssd", rpm: null }).includes("4 TB"), "spare ssd : capacité composée aussi (SPARE_DISK_TYPES)");
    ck(!termsOf("spares", { id: "sp-t", type: "transceiver", capacity_value: 4, capacity_unit: "TB" }).includes("4 TB"),
      "spare transceiver : PAS de composition capacité (techSummary ne la compose que pour les disques)");

    // -- VERROUS sur les locales : les préfixes/unités DUPLIQUENT les libellés client — même règle que
    //    les catalogues (la duplication assumée ne peut pas dériver en silence). --
    const frDetail = D("i18n/locales/fr/detail.js").detail, enDetail = D("i18n/locales/en/detail.js").detail;
    const frSearch = D("i18n/locales/fr/search.js").search, enSearch = D("i18n/locales/en/search.js").search;
    const rendered = (template, floor) => template.replace("{{floor}}", floor);
    ck(SEARCH_CATALOGS.floorAbbrev.map((a) => norm(a + " 2")).includes(norm(rendered(frDetail.common.floorAbbrev, "2"))),
      "floorAbbrev : la composition reproduit le rendu FR de detail.common.floorAbbrev (« ét. 2 »)");
    ck(SEARCH_CATALOGS.floorAbbrev.map((a) => norm(a + " 2")).includes(norm(rendered(enDetail.common.floorAbbrev, "2"))),
      "floorAbbrev : … et le rendu EN (« fl. 2 »)");
    ck(SEARCH_CATALOGS.strands.map(norm).includes(norm(frSearch.sub.strands)) && SEARCH_CATALOGS.strands.map(norm).includes(norm(enSearch.sub.strands)),
      "strands : les unités couvrent search.sub.strands des DEUX locales (« brins », « strands »)");
  }
  });

  await section("shared : SearchTerms — requêtes INVERSES golden (dérivées de la MÊME spec)", async () => {
  {
    const queriesFor = (collection, id, oldRecord, newRecord) => SearchTerms.dependentQueries(collection, id, oldRecord || null, newRecord || null);
    const has = (queries, collection, field, value, thenCollection, thenField) => queries.some((q) =>
      q.collection === collection && q.field === field && q.value === value
      && (thenCollection ? (q.then && q.then.collection === thenCollection && q.then.field === thenField) : !q.then));

    // -- écrire une BAIE : équipements directs + équipements posés à 2 sauts (via les étagères). --
    const qRack = queriesFor("racks", "rk-1");
    ck(has(qRack, "equipments", "rack_id", "rk-1"), "écrire une baie → equipments par rack_id (dépendants directs)");
    ck(has(qRack, "rackItems", "rack_id", "rk-1", "equipments", "tray_item_id"), "écrire une baie → CHAÎNE rackItems par rack_id PUIS equipments par tray_item_id (posés d'étagère)");

    // -- écrire un ÉQUIPEMENT : la constellation complète, dont LA chaîne équipement → ports → câbles. --
    const qEq = queriesFor("equipments", "eq-rack");
    ck(has(qEq, "ports", "equipment_id", "eq-rack", "cables", "from_port_id")
      && has(qEq, "ports", "equipment_id", "eq-rack", "cables", "to_port_id"),
      "écrire un équipement → CHAÎNE ports par equipment_id PUIS câbles par from_port_id ET to_port_id (2 sauts inversés)");
    ck(has(qEq, "subEquipments", "equipment_id", "eq-rack"), "écrire un équipement → ses sous-équipements (terme « maître »)");
    ck(has(qEq, "cableBundles", "endpoint_a_equipment_id", "eq-rack") && has(qEq, "cableBundles", "endpoint_b_equipment_id", "eq-rack"),
      "écrire un équipement → faisceaux par les deux extrémités");
    ck(has(qEq, "ipAddresses", "equipment_id", "eq-rack") && has(qEq, "vms", "host_equipment_id", "eq-rack") && has(qEq, "spares", "assigned_equipment_id", "eq-rack"),
      "écrire un équipement → IPs, VMs hébergées, spares attribués");
    ck(has(qEq, "applications", "equipment_id", "eq-rack"), "écrire un équipement → ses APPLICATIONS hébergées (renommer l'hôte invalide leur colonne search)");

    // -- écrire une VM : ses applications hébergées (search-v5) ET ses adresses rattachées. --
    const qVm = queriesFor("vms", "vm-1");
    ck(has(qVm, "applications", "vm_id", "vm-1"), "écrire une VM → ses APPLICATIONS hébergées (invalidation inverse par vm_id)");
    ck(has(qVm, "ipAddresses", "vm_id", "vm-1"), "écrire une VM → ses adresses IP rattachées");

    // -- écrire un PORT / un TYPE de câble / une ÉTAGÈRE (nœud INTERMÉDIAIRE d'une chaîne). --
    ck(has(queriesFor("ports", "p-1"), "cables", "from_port_id", "p-1") && has(queriesFor("ports", "p-1"), "cables", "to_port_id", "p-1"),
      "écrire un port → câbles des deux bouts");
    ck(has(queriesFor("cableTypes", "ct-1"), "cables", "cable_type_id", "ct-1"), "écrire un type de câble → ses câbles");
    ck(has(queriesFor("rackItems", "tray-1"), "equipments", "tray_item_id", "tray-1"),
      "écrire une étagère (contribue 0 terme MAIS étape d'un 2e saut) → ses équipements posés quand même");

    // -- écrire un SITE / un GROUPE (liens par champ / multi). --
    const qSite = queriesFor("sites", "site-a");
    ck(has(qSite, "equipments", "location", "site-a") && has(qSite, "datacenters", "location", "site-a") && has(qSite, "floors", "location", "site-a"),
      "écrire un site → équipements + salles + étages par le CHAMP location");
    const qGroup = queriesFor("groups", "gr-1");
    ck(has(qGroup, "equipments", "group_id", "gr-1") && has(qGroup, "equipments", "group_ids", "gr-1"),
      "écrire un groupe → équipements par group_id ET group_ids (appartenance tableau)");

    // -- dérivation par ENFANTS : le sous-équipement DÉPLACÉ rafraîchit ses DEUX maîtres (ancien + nouveau). --
    const qMove = queriesFor("subEquipments", "se-1", { equipment_id: "eq-ancien" }, { equipment_id: "eq-nouveau" });
    ck(has(qMove, "equipments", "id", "eq-ancien") && has(qMove, "equipments", "id", "eq-nouveau"),
      "déplacer un sous-équipement → les DEUX maîtres re-calculés (l'ancien n'est retrouvable que par l'ancien record)");
    ck(SearchTerms.needsPreviousRecord("subEquipments") && !SearchTerms.needsPreviousRecord("racks"),
      "needsPreviousRecord : SEULES les collections contribuant à un PARENT exigent la relecture de l'ancien record");

    // -- collections sans inversion. --
    ck.eq(queriesFor("contacts", "co-1").length, 0, "écrire un contact → aucune requête inverse (personne n'en dérive)");
  }
  });

  await section("Serveur : colonne `search` ENRICHIE + invalidation (renommages, 2 sauts, updated_rev intacte)", async () => {
  {
    if (!requireSqlite()) return;
    const { RelationalRepository } = SERVER("RelationalRepository.js");
    const repo = RelationalRepository.open(":memory:", SQLITE);
    // Corpus inséré par upserts UNITAIRES, cibles APRÈS dépendants pour éprouver le post-pass au passage.
    const seed = (collection, records) => records.forEach((r) => repo.upsert(collection, r, 1));
    seed("equipments", CORPUS.equipments); seed("subEquipments", CORPUS.subEquipments);
    seed("ports", CORPUS.ports); seed("cables", CORPUS.cables); seed("cableBundles", CORPUS.cableBundles);
    seed("rackItems", CORPUS.rackItems); seed("racks", CORPUS.racks); seed("datacenters", CORPUS.datacenters);
    seed("sites", CORPUS.sites); seed("floors", CORPUS.floors); seed("groups", CORPUS.groups);
    seed("cableTypes", CORPUS.cableTypes); seed("vms", CORPUS.vms); seed("ipAddresses", CORPUS.ipAddresses);
    seed("spares", CORPUS.spares);

    const idsFound = (collection, q) => repo.list(collection, { query: q }).rows.map((r) => r.id).sort().join(",");

    // -- l'ordre d'insertion (equipments AVANT racks) n'a pas laissé de colonne pauvre : post-pass unitaire. --
    ck.eq(idsFound("equipments", "b01"), "eq-rack,eq-tray", "seed : équipement racké ET posé d'étagère trouvables par le nom de la baie (post-pass malgré racks insérés APRÈS)");
    ck.eq(idsFound("cables", "sw-coeur"), "cb-1", "seed : câble trouvable par l'équipement d'un bout (2 sauts)");
    ck.eq(idsFound("vms", "orphan"), "vm-1", "seed : VM orpheline trouvable par « orphan » (catalogue en) — et « orpheline » : " + idsFound("vms", "orpheline"));

    // -- RENOMMER LA BAIE : dépendants re-trouvables par le nouveau nom, plus par l'ancien. --
    const revOf = (collection, id) => repo.db.prepare(`SELECT updated_rev FROM "${collection}" WHERE id = ?`).get(id).updated_rev;
    const eqRevBefore = revOf("equipments", "eq-rack"), cableRevBefore = revOf("cables", "cb-1");
    repo.upsert("racks", { ...CORPUS.racks[0], name: "Baie Z99" }, 42);
    ck.eq(idsFound("equipments", "z99"), "eq-rack,eq-tray", "renommer la baie → ses équipements (direct + étagère) trouvables par le NOUVEAU nom");
    ck.eq(idsFound("equipments", "b01"), "", "renommer la baie → l'ANCIEN nom ne trouve plus rien");
    ck.eq(revOf("equipments", "eq-rack"), eqRevBefore, "🎯 updated_rev des dépendants INCHANGÉE (UPDATE search SEUL — pas de faux 409, pas de reload SSE)");
    ck.eq(repo.conflicts([{ collection: "equipments", id: "eq-rack" }, { collection: "cables", id: "cb-1" }], eqRevBefore).length, 0,
      "🎯 conflicts() non pollué : aucun dépendant rafraîchi ne devient un conflit");

    // -- RENOMMER UN ÉQUIPEMENT : câbles (2 sauts), sous-équipements, VM, IP, spare, faisceau suivent. --
    repo.upsert("equipments", { ...CORPUS.equipments[0], name: "SW-Renomme" }, 43);
    ck.eq(idsFound("cables", "sw-renomme"), "cb-1", "renommer un équipement → son câble re-trouvable (chaîne ports → câbles)");
    ck.eq(idsFound("subEquipments", "sw-renomme"), "se-1", "renommer un équipement → ses sous-équipements suivent (terme maître)");
    ck.eq(idsFound("vms", "sw-renomme"), "vm-1", "renommer un équipement → la VM hébergée suit");
    ck.eq(idsFound("spares", "sw-renomme"), "sp-1", "renommer un équipement → le spare attribué suit");
    ck.eq(idsFound("cableBundles", "sw-renomme"), "bd-1", "renommer un équipement → le faisceau terminé dessus suit");
    ck.eq(revOf("cables", "cb-1"), cableRevBefore, "updated_rev du câble toujours intacte après DEUX invalidations");

    // -- SOUS-ÉQUIPEMENT : son écriture rafraîchit le maître ; son DÉPLACEMENT rafraîchit les deux. --
    repo.upsert("subEquipments", { ...CORPUS.subEquipments[0], name: "Drive LTO-10" }, 44);
    ck.eq(idsFound("equipments", "lto-10"), "eq-rack", "écrire un sous-équipement → le MAÎTRE re-trouvable par le nouveau nom du drive");
    repo.upsert("subEquipments", { ...CORPUS.subEquipments[0], name: "Drive LTO-10", equipment_id: "eq-libre" }, 45);
    ck.eq(idsFound("equipments", "lto-10"), "eq-libre", "déplacer un sous-équipement → l'ANCIEN maître purgé, le NOUVEAU enrichi (relecture de l'ancien record)");

    // -- DELETE unitaire : les dépendants perdent le terme. --
    repo.delete("subEquipments", "se-1");
    ck.eq(idsFound("equipments", "lto-10"), "", "supprimer le sous-équipement → plus aucun maître trouvable par son nom");
    repo.close();
  }
  });

  await section("Serveur : transact INTRA-LOT (ordre indifférent), snapshot en seconde passe, backfill user_version", async () => {
  {
    if (!requireSqlite()) return;
    const { RelationalRepository } = SERVER("RelationalRepository.js");

    // -- TRANSACT : créer une baie + un équipement qui la référence dans le MÊME lot, équipement D'ABORD
    //    (l'ordre qui casserait un calcul à l'insertion) puis, seconde passe du test, baie d'abord. --
    const repo = RelationalRepository.open(":memory:", SQLITE);
    repo.transact({ creates: [
      { collection: "equipments", record: { id: "eq-i1", name: "Hôte-Intra", type: "server", rack_id: "rk-i1" } },
      { collection: "racks", record: { id: "rk-i1", name: "Baie Intra" } },
    ] }, 2);
    ck.eq(repo.list("equipments", { query: "intra" }).rows.map((r) => r.id).join(","), "eq-i1",
      "transact : équipement créé AVANT sa baie (même lot) → cherchable par le nom de la baie (post-pass après TOUTES les écritures)");
    repo.transact({ creates: [
      { collection: "racks", record: { id: "rk-i2", name: "Baie Ordre2" } },
      { collection: "equipments", record: { id: "eq-i2", name: "Hôte-Ordre2", type: "server", rack_id: "rk-i2" } },
    ] }, 3);
    ck.eq(repo.list("equipments", { query: "ordre2" }).rows.map((r) => r.id).join(","), "eq-i2", "transact : ordre inverse (baie d'abord) → même résultat");

    // -- DELETE dans un lot : la baie disparaît → l'équipement n'est plus trouvable par son nom. --
    repo.transact({ deletes: [{ collection: "racks", id: "rk-i1" }] }, 4);
    ck.eq(repo.list("equipments", { query: "baie intra" }).total, 0, "transact : supprimer la baie → le terme dérivé disparaît des équipements");

    // -- REPLACE SNAPSHOT : écritures brutes + recalcul COMPLET en seconde passe (même transaction). --
    repo.replaceSnapshot({
      equipments: [{ id: "eq-s1", name: "Snap-Serveur", type: "server", rack_id: "rk-s1" }],
      racks: [{ id: "rk-s1", name: "Baie Snapshot" }],
    }, 5);
    ck.eq(repo.list("equipments", { query: "snapshot" }).rows.map((r) => r.id).join(","), "eq-s1",
      "replaceSnapshot : colonne enrichie en SECONDE passe (equipments sérialisés avant racks dans le snapshot)");
    ck.eq(repo.list("equipments", { query: "intra" }).total, 0, "replaceSnapshot : l'ancien contenu a bien été remplacé (sanité)");
    repo.close();

    // -- BACKFILL : un fichier au marqueur 0 et à la colonne PAUVRE est enrichi à l'ouverture, une fois. --
    const { SearchTerms: SharedSearchTerms } = SHARED("src-shared/SearchTerms.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-searchv1-"));
    const file = path.join(dir, "doc.db");
    try {
      const writer = RelationalRepository.open(file, SQLITE);
      // simulate un document d'AVANT l'enrichissement : colonnes pauvres (upsertRaw) + marqueur 0.
      writer.upsertRaw("racks", { id: "rk-b1", name: "Baie Backfill" }, 7);
      writer.upsertRaw("equipments", { id: "eq-b1", name: "Vieux-Serveur", type: "server", rack_id: "rk-b1" }, 7);
      writer.db.pragma("user_version = 0");
      ck.eq(writer.list("equipments", { query: "backfill" }).total, 0, "fixture : colonne PAUVRE avérée (le nom de la baie ne trouve pas l'équipement)");
      writer.close();

      const logged = [];
      const log = { info: (...a) => logged.push(a.join(" ")), warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} };
      const reopened = RelationalRepository.open(file, SQLITE, log);
      ck.eq(reopened.list("equipments", { query: "backfill" }).rows.map((r) => r.id).join(","), "eq-b1",
        "backfill : à l'OUVERTURE, la colonne pauvre est enrichie (marqueur 0 < search-v" + SharedSearchTerms.SEARCH_VERSION + ")");
      ck.eq(reopened.db.pragma("user_version")[0].user_version, SharedSearchTerms.SEARCH_VERSION, "backfill : marqueur PRAGMA user_version posé");
      ck.eq(revOfFile(reopened, "equipments", "eq-b1"), 7, "backfill : updated_rev PRÉSERVÉE (seule la colonne search a bougé)");
      ck(logged.some((l) => /backfill/.test(l) && /2 record/.test(l)), "backfill : une ligne de log info (nb de records)");
      reopened.close();

      // idempotence : la réouverture voit le marqueur et ne refait rien (aucun log, colonnes stables).
      const logged2 = [];
      const again = RelationalRepository.open(file, SQLITE, { ...log, info: (...a) => logged2.push(a.join(" ")) });
      ck.eq(logged2.filter((l) => /backfill/.test(l)).length, 0, "backfill : IDEMPOTENT — la réouverture ne recalcule pas (marqueur à jour)");
      ck.eq(again.list("equipments", { query: "backfill" }).total, 1, "backfill : le contenu enrichi persiste");
      again.close();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows : fichier encore verrouillé — répertoire temp, sans conséquence */ }
    }

    function revOfFile(r, collection, id) { return r.db.prepare(`SELECT updated_rev FROM "${collection}" WHERE id = ?`).get(id).updated_rev; }
  }
  });

  await section("Serveur : searchAll — recherche TRANSVERSE en un appel (LIKE par collection, cap + troncature, périmètre)", async () => {
  {
    if (!requireSqlite()) return;
    const { RelationalRepository } = SERVER("RelationalRepository.js");
    const repo = RelationalRepository.open(":memory:", SQLITE);
    const seed = (collection, records) => records.forEach((r) => repo.upsert(collection, r, 1));
    seed("racks", CORPUS.racks); seed("rackItems", CORPUS.rackItems); seed("datacenters", CORPUS.datacenters);
    seed("sites", CORPUS.sites); seed("equipments", CORPUS.equipments); seed("subEquipments", CORPUS.subEquipments);
    seed("ports", CORPUS.ports); seed("cables", CORPUS.cables); seed("cableBundles", CORPUS.cableBundles);
    seed("cableTypes", CORPUS.cableTypes); seed("vms", CORPUS.vms); seed("spares", CORPUS.spares);
    seed("contacts", CORPUS.contacts);

    // -- MULTI-COLLECTIONS en UN appel : « sw-coeur » touche l'équipement (propre), le câble (2 sauts),
    //    la VM hébergée, le spare attribué, le faisceau, le sous-équipement (terme maître). --
    const all = repo.searchAll("SW-COEUR");   // casse volontairement différente du seed « SW-Coeur » (normalisation partagée)
    ck.eq((all.results.equipments || []).map((r) => r.id).join(","), "eq-rack", "searchAll : l'équipement par son nom propre");
    ck.eq((all.results.cables || []).map((r) => r.id).join(","), "cb-1", "searchAll : le câble par l'équipement d'un bout (colonne enrichie, 2 sauts)");
    ck.eq((all.results.vms || []).map((r) => r.id).join(","), "vm-1", "searchAll : la VM par son hôte");
    ck.eq((all.results.subEquipments || []).map((r) => r.id).join(","), "se-1", "searchAll : le sous-équipement par son maître");
    ck(!("contacts" in all.results), "searchAll : collection MUETTE omise de la réponse (payload lean)");
    ck.eq(all.truncated.length, 0, "searchAll : aucun plafond atteint sur ce corpus");
    const sample = (all.results.equipments || [])[0] || {};
    ck(!("search" in sample) && !("updated_rev" in sample), "searchAll : records REBUILDÉS (colonnes opérationnelles jamais dans le record)");

    // -- NORMALISATION de la requête (même règle que list) : casse + accents. --
    ck.eq((repo.searchAll("BAIE b01").results.equipments || []).map((r) => r.id).sort().join(","), "eq-rack,eq-tray",
      "searchAll : requête normalisée (casse/accents) — les DEUX équipements de la baie, direct et étagère");

    // -- CAP par collection + indicateur de troncature (LIMIT cap+1, sans COUNT). --
    const capped = repo.searchAll("baie b01", { perCollectionLimit: 1 });
    ck.eq((capped.results.equipments || []).length, 1, "searchAll : plafond PAR COLLECTION respecté");
    ck(capped.truncated.includes("equipments"), "searchAll : la collection TRONQUÉE est signalée (cap assumé v1)");
    ck.eq(RelationalRepository.SEARCH_ALL_LIMIT, 40, "searchAll : plafond par défaut = constante nommée (40)");

    // -- PÉRIMÈTRE `collections` : restreint, noms inconnus ignorés (défensif — liste venue du client). --
    const scoped = repo.searchAll("sw-coeur", { collections: ["cables", "nimporte-quoi"] });
    ck.eq(Object.keys(scoped.results).join(","), "cables", "searchAll : périmètre restreint aux collections demandées (inconnues ignorées)");

    // -- Requête VIDE/blanche : aucun résultat, aucun scan. --
    ck.eq(Object.keys(repo.searchAll("").results).length, 0, "searchAll : requête vide → rien");
    ck.eq(Object.keys(repo.searchAll("   ").results).length, 0, "searchAll : requête blanche → rien");
    repo.close();
  }
  });

  await section("Serveur : backfill search-v1 → search-v2 (fichier réel — le bump de version rattrape les documents)", async () => {
  {
    if (!requireSqlite()) return;
    const { RelationalRepository } = SERVER("RelationalRepository.js");
    const { SearchTerms: SharedSearchTerms } = SHARED("src-shared/SearchTerms.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-searchv2-"));
    const file = path.join(dir, "doc.db");
    try {
      // Fixture « document v1 » : colonnes calculées SANS les compositions (upsertRaw = valeurs propres
      // seules — un vrai document v1 aurait AUSSI les dérivés, mais le déclencheur testé est le MARQUEUR,
      // pas le contenu) + `user_version = 1` posé à la main.
      const writer = RelationalRepository.open(file, SQLITE);
      writer.upsertRaw("racks", { id: "rk-v2", name: "Baie V2", u_count: 47 }, 9);
      writer.upsertRaw("equipments", { id: "eq-v2", name: "Srv-V2", type: "server", placement_mode: "rack", rack_id: "rk-v2", rack_u: 12 }, 9);
      writer.db.pragma("user_version = 1");
      ck.eq(writer.list("equipments", { query: "u12" }).total, 0, "fixture : « u12 » introuvable (colonne sans les compositions v2)");
      writer.close();

      // Réouverture : marqueur 1 < SEARCH_VERSION 2 → recalcul COMPLET, compositions cherchables.
      const reopened = RelationalRepository.open(file, SQLITE);
      ck.eq(reopened.list("equipments", { query: "u12" }).rows.map((r) => r.id).join(","), "eq-v2",
        "backfill v1→v2 : « u12 » trouve l'équipement après réouverture (le bump seul a tout mis à niveau)");
      ck.eq(reopened.list("racks", { query: "47 u" }).rows.map((r) => r.id).join(","), "rk-v2", "backfill v1→v2 : « 47 U » trouve la baie");
      ck.eq(reopened.db.pragma("user_version")[0].user_version, SharedSearchTerms.SEARCH_VERSION, "backfill v1→v2 : marqueur porté à search-v2");
      reopened.close();
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows : fichier encore verrouillé — répertoire temp, sans conséquence */ }
    }
  }
  });

  await section("Client : HydrationStats — instrumentation du boot REST (volet A, seuils D3)", async () => {
  {
    const { HydrationStats } = D("core/HydrationStats.js");
    const data = { equipments: [{ id: "e1", name: "SW" }, { id: "e2" }], cables: [], vms: [{ id: "v1" }] };
    const report = HydrationStats.measure(data, 87);
    ck.eq(report.totalRecords, 3, "measure : total des records (collections vides ignorées)");
    ck.eq(JSON.stringify(report.counts), JSON.stringify({ equipments: 2, vms: 1 }), "measure : comptes par collection NON VIDE seulement");
    ck(report.approxBytes > 0 && report.approxBytes < 1024, "measure : taille approchée plausible (JSON sérialisé)");
    ck(!report.overPayload && !report.overDuration, "seuils D3 : sous les seuils → aucune alerte");
    ck(HydrationStats.measure(data, 1001).overDuration, "seuils D3 : durée > 1 s → overDuration");
    ck(HydrationStats.measure({ big: [{ blob: "x".repeat(6 * 1024 * 1024) }] }, 10).overPayload, "seuils D3 : payload > 5 Mo → overPayload");
    const line = HydrationStats.line(report);
    ck(/3 records \(equipments:2, vms:1\)/.test(line) && /87 ms/.test(line), "line : « n records (détail) · ~taille · durée » — obtenu : " + line);
    ck.eq(HydrationStats.formatBytes(5 * 1024 * 1024 + 1).slice(-2), "Mo", "formatBytes : ordre de grandeur en Mo au-delà du Mo");
  }
  });
};
