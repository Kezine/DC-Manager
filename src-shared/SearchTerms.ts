/* ============================================================================
   TERMES DE RECHERCHE DÉRIVÉS — code PARTAGÉ front ⇄ back (TS pur).

   SOURCE UNIQUE de « quel texte trouve un enregistrement » AU-DELÀ de ses champs
   propres : les termes DÉRIVÉS PAR LIEN (un équipement est trouvable par le nom
   de SA baie), les termes de CATALOGUE traduits (un spare `hdd` est trouvable
   par « disque dur » ET « hard drive ») et les DÉPENDANCES INVERSES qui disent
   quelles colonnes `search` re-calculer quand un enregistrement change.

   La spec `SEARCH_SPECS` ci-dessous N'EST PAS une invention : c'est le RELEVÉ
   des dérivations que le CLIENT effectue déjà pour sa recherche (cadrage
   `.notes/toDos/chargement-dynamique-document-cadrage-2026-08-02.md` §4bis) —
   `views/GlobalSearchSources.ts` (habillage label/sub/path par famille, tous
   cherchés au palier 30 de `core/GlobalSearch`) et les `searchFields` de
   `views/ListConfigs.ts`. Chaque entrée renvoie à ce relevé ; les pastilles
   (`pill` : statuts, occupation) sont AFFICHAGE SEUL et n'ont donc AUCUN terme
   ici — c'est documenté dans `GlobalSearchSources.FamilySource`.

   ── Double exécution PAR CONSTRUCTION (principe n°15) ───────────────────────
   `termsOf`/`searchText` sont SYNCHRONES, à lecteurs INJECTÉS — les contrats
   EXISTANTS `EntityFetcher`/`ChildFinder` de `DataValidation.ts`, exactement
   comme la validation V2/V5/V6 :
   - le SERVEUR (mode API, la NORME) passe `RelationalRepository.getOne`/`findBy`
     et matérialise le résultat dans la colonne `search` à chaque écriture ;
   - le CLIENT (mode fichier) passe `Store.get`/`findByField` (lot 2 —
     `GlobalSearchSources`) et obtient les MÊMES termes sur son corpus local —
     parité des deux modes par construction, seul le TRANSPORT diffère.
     Architecture complète : docs/recherche.md.

   ── Dépendances INVERSES : une seule vérité ─────────────────────────────────
   `dependentQueries` DÉRIVE l'invalidation de la MÊME spec (jamais une seconde
   table à maintenir) : pour chaque lien « C.champ → cible », écrire une CIBLE
   produit la requête « les C dont champ = id » ; un lien à 2 SAUTS (câble →
   port → équipement) produit la CHAÎNE inverse (écrire un équipement → ses
   ports par `equipment_id` → les câbles par `from_port_id`/`to_port_id`).
   Le serveur exécute ces requêtes sur ses FK INDEXÉES (INDEX_SPEC) et ne
   réécrit QUE la colonne `search` (cf. RelationalRepository, docs/persistance.md).

   ── Versionnage ─────────────────────────────────────────────────────────────
   `SEARCH_VERSION` estampille le FICHIER document (`PRAGMA user_version`) : un
   document dont le marqueur est plus ancien voit TOUTES ses colonnes `search`
   recalculées à l'ouverture (backfill one-shot). ⚠ Toute évolution de la spec
   ci-dessous (dérivation ajoutée/retirée, catalogue enrichi) doit INCRÉMENTER
   cette constante — sinon les documents existants gardent des colonnes calculées
   avec l'ancienne spec.

   Import interne partagé : extension `.js` IMPÉRATIVE (NodeNext côté serveur —
   cf. CLAUDE.md § « Code partagé front/back »).
   ============================================================================ */

import { Schema } from "./Schema.js";
import type { EntityFetcher, ChildFinder } from "./DataValidation.js";

/* ---- CATALOGUES de termes traduits (données pures, LES DEUX LANGUES) ----------------------------
   Le serveur ne connaît pas la langue de l'utilisateur : la colonne `search` porte donc les termes
   FR **ET** EN de chaque libellé de catalogue RÉELLEMENT cherché côté client (inventaire du lot 1 —
   seuls 4 catalogues le sont : les types d'équipement, de groupe et de spare via `searchFields`, et
   le mot « orpheline » des VMs via `VmStatus.searchTerms`). Les statuts de câble/spare (pastilles)
   ne sont PAS cherchés → pas de catalogue ici : n'en faire ni plus ni moins que l'inventaire.
   ⚠ Ces chaînes DUPLIQUENT les libellés des locales client (`i18n/locales/{fr,en}/domain.ts`,
   `lists.ph.orphan`) — duplication ASSUMÉE et VERROUILLÉE par test (test-search-terms.js : chaque
   libellé d'affichage fr/en doit apparaître dans les termes) : l'AFFICHAGE reste client/I18n, seule
   la donnée « termes cherchables » est partagée. Libellés identiques fr/en déclarés UNE fois.
   Depuis search-v2 s'ajoutent les PRÉFIXES/UNITÉS des COMPOSITIONS localisées (cf. `own` des specs) :
   « ét. 2 »/« fl. 2 » (libellé des étages, chemin des salles) et « 12 brins »/« 12 strands » (sous-
   ligne des faisceaux) — mêmes règles de verrouillage sur les locales (`detail.common.floorAbbrev`,
   `search.sub.strands`). */
export const SEARCH_CATALOGS = {
  /** domain.equipmentType (fr+en) — cherché par `ListConfigs.equipments.searchFields` + sub de la palette. */
  equipmentType: {
    switch: ["Switch"], server: ["Serveur", "Server"], enclosure: ["Caisson", "Enclosure"],
    pc: ["PC"], printer: ["Imprimante", "Printer"], ap: ["AP"], camera: ["Caméra IP", "IP camera"],
    patch_panel: ["Patch panel"], pdu: ["PDU"], switchboard: ["Tableau électrique", "Switchboard"],
    ups: ["Onduleur (UPS)", "UPS"], other: ["Autre", "Other"],
  } as Readonly<Record<string, readonly string[]>>,
  /** domain.groupType (identiques fr/en) — cherché par `ListConfigs.groups.searchFields` + sub palette. */
  groupType: {
    stack: ["Stack"], system: ["System"], general: ["General"],
  } as Readonly<Record<string, readonly string[]>>,
  /** domain.spareType (fr+en) — cherché par `ListConfigs.spares.searchFields`. */
  spareType: {
    hdd: ["HDD (disque dur)", "HDD (hard drive)"], ssd: ["SSD"],
    transceiver: ["Transceiver"], other: ["Autre", "Other"],
  } as Readonly<Record<string, readonly string[]>>,
  /** lists.ph.orphan (fr+en) — versé par `VmStatus.searchTerms` quand la VM est orpheline. */
  vmOrphan: ["orpheline", "orphan"] as readonly string[],
  /** detail.common.floorAbbrev (fr « ét. {{floor}} », en « fl. {{floor}} ») — PRÉFIXES de la
      composition « ét. N » : libellé même des étages (GlobalSearchSources.floors.label) et chemin
      des salles (datacenters.path). Composés avec la valeur du champ `floor` par les `own`. */
  floorAbbrev: ["ét.", "fl."] as readonly string[],
  /** search.sub.strands (fr « brins », en « strands ») — UNITÉ de la composition « 12 brins » de la
      sous-ligne des faisceaux (GlobalSearchSources.cableBundles.sub), composée avec `fiber_count`. */
  strands: ["brins", "strands"] as readonly string[],
  /** lists.ph.disconnected (fr+en) — versé par la spec `wifiClients` quand le client est « orphelin ».
      MÊME mécanique que `vmOrphan`, LIBELLÉ différent : côté wifi, disparaître de l'inventaire n'est pas
      un incident mais une DÉCONNEXION ordinaire (décision D2 du cadrage). Duplication des libellés client
      ASSUMÉE et VERROUILLÉE par test, comme tous les catalogues ci-dessus. */
  wifiDisconnected: ["déconnecté", "disconnected"] as readonly string[],
};

/* ---- formes de la spec déclarative ---- */

/** Dérivation par LIEN : le champ du record porte l'id (ou les ids si `multi`) d'un enregistrement
    d'une collection cible, dont les champs `contributes` deviennent des termes. `then` exprime le
    2e SAUT (le seul niveau que le relevé montre — câble → port → équipement) : depuis la CIBLE,
    re-suivre un champ vers une seconde collection. NB : le cas « lien par CHAMP » (sites référencés
    par le champ `location` des salles/étages/équipements, sans `ref` de spec) a la MÊME mécanique —
    la valeur du champ EST l'id du site, seule l'histoire du nom de champ diffère. */
interface TermLink {
  field: string;
  target: string;
  contributes: readonly string[];
  /** Le champ est un TABLEAU d'ids (ex. `group_ids`). */
  multi?: boolean;
  /** 2e saut : depuis la cible, suivre `field` vers `target` et contribuer `contributes`. */
  then?: { field: string; target: string; contributes: readonly string[] };
}

/** Dérivation par ENFANTS : les enregistrements d'une collection-enfant pointant CE record par
    `fkField` contribuent leurs champs (le SEUL cas du relevé : les noms/séries des sous-équipements
    font partie des termes du MAÎTRE — décision D2, cf. `ListConfigs.equipments.searchFields`). */
interface TermChildren {
  collection: string;
  fkField: string;
  contributes: readonly string[];
}

/** Dérivation par CATALOGUE : la valeur du champ (clé = `String(valeur)`, donc "true" pour un
    booléen levé) est traduite en termes cherchables fr+en. `fallback` reproduit le repli du registre
    client (un type d'équipement inconnu s'AFFICHE « Autre » → il doit se CHERCHER pareil). */
interface TermCatalog {
  field: string;
  terms: Readonly<Record<string, readonly string[]>>;
  fallback?: string;
}

/** Spec de recherche d'UNE collection. `own` couvre les termes PROPRES que la sérialisation brute
    de la colonne ne voit pas — une fonction, comme les invariants de COLLECTION_SPECS (donnée du
    record seul, pas de lecteur : aucune dépendance inverse à en dériver). Deux familles de cas :
    - champs ENFOUIS dans une structure JSON (cf. `vms.nics` : la colonne brute n'en tire que
      « [object Object] ») ;
    - COMPOSITIONS TAPABLES (search-v2) : chaînes que le client COMPOSE dans son habillage cherché
      (« U12 » du chemin d'un équipement, « ét. 2 » du libellé d'un étage, « 42 U », « 12 brins »,
      « Dell R740 »…) — un utilisateur les tape telles quelles, la colonne doit donc les porter
      telles quelles. ⚠ Périmètre = le RELEVÉ client, notations qu'un humain TAPE (espace ou
      notation compacte) ; les assemblages purement typographiques (« – », « ↔ », « équipement :
      port », joints « · ») sont ASSUMÉS non répliqués — leurs termes constitutifs matchent
      individuellement, personne ne tape le séparateur (cf. docs/recherche.md). */
interface CollectionSearchSpec {
  links?: readonly TermLink[];
  children?: readonly TermChildren[];
  catalogs?: readonly TermCatalog[];
  own?: (record: Record<string, any>) => readonly unknown[];
}

/* ---- LA SPEC — le relevé client, collection par collection --------------------------------------
   Collections ABSENTES (ports, aggregates, networks, rackItems, portTypes, cableTypes, waypoints,
   ipNetworks, dhcpRanges, sites, contacts) : leurs valeurs PROPRES suffisent — le relevé ne leur
   montre aucun terme dérivé (ex. le listing dhcpRanges AFFICHE le réseau et le serveur DHCP mais ne
   les cherche pas ; même asymétrie assumée que les pastilles). */
const SEARCH_SPECS: Readonly<Record<string, CollectionSearchSpec>> = {
  equipments: {
    links: [
      // chemin de la palette (GlobalSearchSources.equipmentPath) : baie directe, étagère → baie
      // (2 sauts — l'étagère elle-même ne contribue RIEN, seul le nom de la baie porteuse compte),
      // salle libre, sinon site (le champ `location` PORTE l'id du site — lien par CHAMP).
      { field: "rack_id", target: "racks", contributes: ["name"] },
      { field: "tray_item_id", target: "rackItems", contributes: [], then: { field: "rack_id", target: "racks", contributes: ["name"] } },
      { field: "dc_id", target: "datacenters", contributes: ["name"] },
      { field: "location", target: "sites", contributes: ["name"] },
      // groupes (primaire + secondaires) : `ListConfigs.equipments.searchFields` cherche les labels.
      { field: "group_id", target: "groups", contributes: ["label"] },
      { field: "group_ids", target: "groups", contributes: ["label"], multi: true },
    ],
    // « taper “Drive LTO” fait ressortir la librairie » (décision D2 — cf. le commentaire de
    // ListConfigs.equipments) : les noms ET séries des sous-équipements sont des termes du maître.
    children: [{ collection: "subEquipments", fkField: "equipment_id", contributes: ["name", "serial"] }],
    catalogs: [{ field: "type", terms: SEARCH_CATALOGS.equipmentType, fallback: "other" }],
    // COMPOSITIONS tapables (search-v2) : « U12 » (le chemin de la palette compose « <baie> · U12 »
    // pour un équipement posé en baie — mêmes conditions que GlobalSearchSources.equipmentPath, à
    // l'existence du rack près : `own` n'a pas de lecteur, une FK cassée sur-matcherait marginalement,
    // V2 s'en occupe) et « marque modèle » (sub de la palette : « Dell R740 » se tape d'un trait).
    own: (e) => {
      const out: string[] = [];
      if ((e.placement_mode === "rack" || e.placement_mode === "side" || e.placement_mode === "wall") && e.rack_id && e.rack_u) out.push("U" + e.rack_u);
      if (e.brand && e.model) out.push(e.brand + " " + e.model);
      return out;
    },
  },
  subEquipments: {
    // le nom du MAÎTRE (terme dérogatoire de GlobalSearchSources.subEquipments.terms + son `path`).
    links: [{ field: "equipment_id", target: "equipments", contributes: ["name"] }],
  },
  racks: {
    // le chemin de la palette nomme la SALLE (GlobalSearchSources.racks.path).
    links: [{ field: "datacenter_id", target: "datacenters", contributes: ["name"] }],
    // « 42 U » : la sous-ligne de la palette (GlobalSearchSources.racks.sub) — défaut 42 REPRODUIT
    // (le client compose `(u_count || 42) + " U"`, une baie sans u_count s'affiche et se cherche « 42 U »).
    own: (r) => [(r.u_count || 42) + " U"],
  },
  datacenters: {
    // le chemin de la palette nomme le SITE (siteLabel — lien par le CHAMP `location`).
    links: [{ field: "location", target: "sites", contributes: ["name"] }],
    // « ét. 2 »/« fl. 2 » : le chemin de la palette compose floorAbbrev quand `floor` est renseigné
    // (GlobalSearchSources.datacenters.path) — les DEUX langues, comme les catalogues.
    own: (d) => (d.floor ? SEARCH_CATALOGS.floorAbbrev.map((abbrev) => abbrev + " " + d.floor) : []),
  },
  floors: {
    // le LIBELLÉ même d'un étage est « site · ét. N » (GlobalSearchSources.floors.label +
    // ListConfigs.floors.searchFields via siteLabel) — le nom du site est constitutif.
    links: [{ field: "location", target: "sites", contributes: ["name"] }],
    // « ét. 2 »/« fl. 2 » : la composition EST le libellé de l'étage (paliers 60/80 côté client, pas
    // seulement le 30) — les DEUX langues. `floor` peut être "0" (rez) : on compose dès que non vide.
    own: (f) => (f.floor != null && f.floor !== "" ? SEARCH_CATALOGS.floorAbbrev.map((abbrev) => abbrev + " " + f.floor) : []),
  },
  cables: {
    links: [
      // sub de la palette : le nom du TYPE de câble (GlobalSearchSources.cables.sub).
      { field: "cable_type_id", target: "cableTypes", contributes: ["name"] },
      // chemin « équipement : port ↔ équipement : port » (portRefText) — les DEUX bouts, 2 SAUTS chacun.
      { field: "from_port_id", target: "ports", contributes: ["name"], then: { field: "equipment_id", target: "equipments", contributes: ["name"] } },
      { field: "to_port_id", target: "ports", contributes: ["name"], then: { field: "equipment_id", target: "equipments", contributes: ["name"] } },
    ],
  },
  cableBundles: {
    // chemin de la palette : les équipements des deux EXTRÉMITÉS (GlobalSearchSources.cableBundles.path).
    links: [
      { field: "endpoint_a_equipment_id", target: "equipments", contributes: ["name"] },
      { field: "endpoint_b_equipment_id", target: "equipments", contributes: ["name"] },
    ],
    // « 12 brins »/« 12 strands » : la sous-ligne de la palette (GlobalSearchSources.cableBundles.sub,
    // localisée `search.sub.strands`) — composée seulement si `fiber_count` est renseigné, comme au client.
    own: (b) => (b.fiber_count ? SEARCH_CATALOGS.strands.map((unit) => b.fiber_count + " " + unit) : []),
  },
  ipAddresses: {
    // sub de la palette : le porteur de l'adresse — équipement OU VM (GlobalSearchSources.ipAddresses.sub).
    links: [
      { field: "equipment_id", target: "equipments", contributes: ["name"] },
      { field: "vm_id", target: "vms", contributes: ["name"] },
    ],
  },
  vms: {
    // l'HÔTE résolu (hostText de ListConfigs.vms + sub de la palette) ; `host_node` brut est un champ propre.
    links: [{ field: "host_equipment_id", target: "equipments", contributes: ["name"] }],
    catalogs: [{ field: "orphan", terms: { "true": SEARCH_CATALOGS.vmOrphan } }],
    // IPs des vNIC (vmIps de ListConfigs.vms) : champ PROPRE mais ENFOUI dans la structure `nics`
    // (tableau d'objets) — la sérialisation brute de la colonne n'en tire que « [object Object] ».
    own: (vm) => (Array.isArray(vm.nics) ? vm.nics : [])
      .flatMap((nic: any) => (nic && Array.isArray(nic.ips) ? nic.ips : [])),
  },
  wifiClients: {
    // le POINT D'ACCÈS résolu (colonne « AP » de ListConfigs.wifiClients + path de la palette) ;
    // `ap_name`/`ap_mac` bruts sont, eux, des champs PROPRES déjà couverts par `ownText`.
    links: [{ field: "ap_equipment_id", target: "equipments", contributes: ["name"] }],
    // « déconnecté »/« disconnected » : MÊME mécanique que l'orphelinat des VMs, autre LIBELLÉ (décision
    // D2 — l'API ne liste que les clients CONNECTÉS, disparaître n'est pas un incident). Le serveur ignore
    // la langue de l'utilisateur : la colonne porte les DEUX.
    catalogs: [{ field: "orphan", terms: { "true": SEARCH_CATALOGS.wifiDisconnected } }],
    // AUCUN `own` : tout le reste (nom, MAC, IP, SSID, type, nom d'AP…) est une colonne PLATE du record,
    // donc déjà couverte par `ownText` — rien n'est enfoui dans une structure, rien n'est composé par
    // l'habillage client (le repli « nom vide → MAC » AFFICHE la MAC, qui est déjà un terme propre).
  },
  spares: {
    // « Attribué à » (assignedTo de ListConfigs.spares) — l'attribution LIBRE `assigned_free` est propre.
    links: [{ field: "assigned_equipment_id", target: "equipments", contributes: ["name"] }],
    catalogs: [{ field: "type", terms: SEARCH_CATALOGS.spareType }],
    // COMPOSITIONS tapables de la désignation dérivée (Spare.displayName/techSummary, cherchées par
    // ListConfigs.spares.searchFields ET par le label/sub de la palette) : « marque référence »
    // (join espace de displayName), « 4 TB » (capacité des disques — mêmes conditions que
    // techSummary : types hdd/ssd seuls) et « 7200 rpm » (hdd seul). Les joints « · » du résumé
    // technique ne sont pas répliqués (séparateur non tapable — cf. le commentaire de `own`).
    own: (s) => {
      const out: string[] = [];
      if (s.brand && s.model_pn) out.push(s.brand + " " + s.model_pn);
      const disk = s.type === "hdd" || s.type === "ssd";   // SPARE_DISK_TYPES du client (Spare.isDisk)
      if (disk && s.capacity_value != null && s.capacity_unit) out.push(s.capacity_value + " " + s.capacity_unit);
      if (s.type === "hdd" && s.rpm) out.push(s.rpm + " rpm");
      return out;
    },
  },
  groups: {
    // GroupTypes.label cherché par ListConfigs.groups.searchFields (+ sub de la palette).
    catalogs: [{ field: "type", terms: SEARCH_CATALOGS.groupType }],
  },
  applications: {
    // l'HÔTE résolu (colonne « Hôte » de ListConfigs.applications + sub de la palette) — équipement OU VM,
    // patron EXACT d'`ipAddresses` : taper le nom du serveur remonte les applications qu'il héberge, et
    // RENOMMER l'hôte invalide la colonne `search` des applications (requêtes inverses par FK indexées,
    // cf. INDEX_SPEC.applications). L'URL et la description sont des colonnes PLATES du record, déjà
    // couvertes par `ownText` — aucun `own`, aucun catalogue.
    links: [
      { field: "equipment_id", target: "equipments", contributes: ["name"] },
      { field: "vm_id", target: "vms", contributes: ["name"] },
    ],
  },
  attachments: {
    // la CIBLE résolue (décision D9 du cadrage pièces jointes 2026-08-10) — équipement OU sous-équipement,
    // même mécanique que l'hôte des `applications` : taper « SRV37 » remonte ses pièces jointes, et
    // RENOMMER la cible invalide la colonne `search` des pièces (requêtes inverses par FK indexées,
    // cf. INDEX_SPEC.attachments). name/description/file_name sont des colonnes PLATES du record, déjà
    // couvertes par `ownText` — aucun `own`, aucun catalogue.
    links: [
      { field: "equipment_id", target: "equipments", contributes: ["name"] },
      { field: "sub_equipment_id", target: "subEquipments", contributes: ["name"] },
    ],
  },
};

/** Requête « qui dépend de cet enregistrement ? » : les records de `collection` dont `field` vaut
    `value` — et, si `then` est présent (chaîne inverse d'un lien à 2 sauts), ces records-là ne sont
    que l'ÉTAPE intermédiaire : CHACUN seed `then.collection` par `then.field` = son id, et ce sont
    ces seconds records dont la colonne `search` est à recalculer. */
export interface DependentQuery {
  collection: string;
  field: string;
  value: string;
  then?: { collection: string; field: string };
}

/** Moteur des termes de recherche partagés (méthodes statiques — cf. CLAUDE.md principe n°2). */
export class SearchTerms {
  /** Version de la SPEC de recherche, estampillée sur le fichier document (`PRAGMA user_version`).
      0 = colonne `search` « pauvre » (valeurs propres seules, pré-enrichissement) ; 1 = search-v1
      (dérivés par lien/enfants + catalogues fr/en) ; 2 = search-v2 (COMPOSITIONS tapables : « U12 »,
      « ét. N »/« fl. N », « 42 U », « 12 brins », « marque modèle », capacités/rpm des spares) ;
      3 = search-v3 (collection `wifiClients` : AP résolu par lien + catalogue « déconnecté » fr/en) ;
      4 = search-v4 (RETRAIT de la collection `issues` de la spec — cf. ci-dessous) ;
      5 = search-v5 (collection `applications` : hôte — équipement OU VM — résolu par lien) ;
      6 = search-v6 (collection `attachments` : cible — équipement OU sous-équipement — résolue par lien).
      À INCRÉMENTER à chaque évolution de la spec (cf. en-tête) — le backfill à l'ouverture met les
      documents existants à niveau tout seul. ⚠ Un ajout de collection COMPTE comme une évolution de
      spec : sans bump, les documents déjà ouverts garderaient une colonne `search` calculée sans elle
      (l'effet serait mince — la collection est neuve donc vide — mais la doctrine ne se négocie pas
      au cas par cas, sinon on ne sait plus ce que vaut le marqueur).

      🚨 CE MARQUEUR NE REDESCEND JAMAIS. La v4 a d'abord porté l'AJOUT d'une collection `issues`
      (chantier « remote issue tracker »), abandonnée au pivot du 2026-08-07 ; la spec `issues` a donc
      été retirée SANS re-bumper. C'est délibéré et c'est la seule conduite sûre : des bases locales
      ont pu passer en v4 pendant le chantier, et repasser le marqueur à 3 leur ferait croire à un
      RETARD de spec — elles se re-backfilleraient jusqu'à la prochaine évolution, sans fin. Le
      marqueur est MONOTONE ; ce qu'il désigne, c'est « l'état de spec n°4 », pas « la 4ᵉ collection ».
      Les documents restés en v3 se backfillent vers la spec ACTUELLE (sans `issues`), et ceux déjà en
      v4 portent une colonne `search` qui ne contient au pire que des termes d'une collection
      disparue — donc invisibles, puisque plus aucun enregistrement ne les porte. */
  static readonly SEARCH_VERSION = 6;

  /** Collections dont l'écriture exige de connaître l'enregistrement PRÉCÉDENT pour invalider
      (dérivations par ENFANTS : un sous-équipement DÉPLACÉ d'un maître à l'autre doit rafraîchir
      les DEUX maîtres — l'ancien n'est retrouvable que par l'ancien record). Dérivée de la spec. */
  private static childCollections: ReadonlySet<string> | null = null;
  static needsPreviousRecord(collection: string): boolean {
    if (!SearchTerms.childCollections) {
      const set = new Set<string>();
      for (const spec of Object.values(SEARCH_SPECS)) for (const child of spec.children || []) set.add(child.collection);
      SearchTerms.childCollections = set;
    }
    return SearchTerms.childCollections.has(collection);
  }

  /** Clé de catalogue d'une valeur de champ : `String(valeur)` — donc "true" pour un booléen levé —
      "" (aucun terme) pour vide/null/false. Un type d'équipement ABSENT ne doit pas produire les
      termes du repli « Autre » : le registre client affiche « — » dans ce cas, pas « Autre ». */
  private static catalogKey(value: unknown): string {
    if (value == null || value === "" || value === false) return "";
    return String(value);
  }

  /** Termes DÉRIVÉS + termes de CATALOGUE d'un enregistrement (BRUTS, non normalisés — la
      normalisation appartient à `searchText` ; les golden tests lisent les termes lisibles).
      Dédoublonnés (un groupe primaire est aussi dans `group_ids` ; libellés identiques fr/en). */
  static termsOf(collection: string, record: Record<string, any>, fetch: EntityFetcher, find: ChildFinder): string[] {
    const spec = SEARCH_SPECS[collection];
    if (!spec || !record) return [];
    const out: string[] = [];
    const push = (value: unknown): void => {
      if (value == null || value === "") return;
      out.push(String(value));
    };
    for (const link of spec.links || []) {
      const raw = record[link.field];
      const ids: unknown[] = link.multi ? (Array.isArray(raw) ? raw : []) : (raw ? [raw] : []);
      for (const id of ids) {
        const target = id ? fetch(link.target, String(id)) : null;
        if (!target) continue;                                     // cible absente : l'intégrité réf. (V2) s'en occupe, pas la recherche
        for (const field of link.contributes) push(target[field]);
        if (link.then) {
          const nextId = target[link.then.field];
          const next = nextId ? fetch(link.then.target, String(nextId)) : null;
          if (next) for (const field of link.then.contributes) push(next[field]);
        }
      }
    }
    for (const child of spec.children || []) {
      if (!record.id) continue;                                    // record sans id : aucun enfant ne peut le pointer
      for (const c of find(child.collection, child.fkField, String(record.id))) {
        for (const field of child.contributes) push(c[field]);
      }
    }
    for (const catalog of spec.catalogs || []) {
      const key = SearchTerms.catalogKey(record[catalog.field]);
      if (!key) continue;
      const terms = catalog.terms[key] || (catalog.fallback ? catalog.terms[catalog.fallback] : undefined);
      if (terms) for (const term of terms) push(term);
    }
    if (spec.own) for (const value of spec.own(record)) push(value);
    return [...new Set(out)];
  }

  /** Texte des valeurs PROPRES du record — PARITÉ STRICTE avec l'historique `Object.values` de la
      colonne `search` (clés inconnues incluses, tableaux joints par espace, `Schema.normSearch`
      partout) : AUCUN terme d'aujourd'hui n'est perdu, l'enrichissement ne fait qu'AJOUTER. */
  static ownText(record: Record<string, any>): string {
    return Object.values(record || {})
      .map((v) => (Array.isArray(v) ? v.map((x) => Schema.normSearch(x)).join(" ") : Schema.normSearch(v)))
      .join(" ");
  }

  /** Contenu COMPLET de la colonne `search` : valeurs propres (parité stricte) + termes dérivés et
      de catalogue, normalisés et joints — même forme (une chaîne normSearch séparée par espaces)
      que la colonne historique, seulement plus riche. */
  static searchText(collection: string, record: Record<string, any>, fetch: EntityFetcher, find: ChildFinder): string {
    const own = SearchTerms.ownText(record);
    const derived = SearchTerms.termsOf(collection, record, fetch, find).map((t) => Schema.normSearch(t)).join(" ");
    if (!derived) return own;
    return own ? own + " " + derived : derived;
  }

  /** DÉPENDANCES INVERSES d'une écriture/suppression : les requêtes qui retrouvent les enregistrements
      dont la colonne `search` doit être recalculée quand `collection/id` vient d'être écrit (ou
      supprimé — mêmes requêtes : les dépendants perdent alors le terme). DÉRIVÉES de `SEARCH_SPECS`
      (une seule vérité) :
      - lien direct « C.champ → collection »          → les C dont champ = id ;
      - lien 2 sauts « C.champ → T.champ2 → collection » → écrire la cible FINALE remonte la chaîne :
        les T dont champ2 = id, PUIS les C dont champ = <id du T> (champ `then` de la requête) ;
        écrire la collection INTERMÉDIAIRE T est le cas « lien direct » ci-dessus (le recalcul du C
        re-suivra `then` avec l'état frais de T) ;
      - dérivation par ENFANTS « C ← enfants K.fk »   → écrire un K rafraîchit son PARENT C (id porté
        par K.fk) — ancien ET nouveau parent si le lot le déplace, d'où `oldRecord`/`newRecord`.
      `oldRecord`/`newRecord` : versions avant/après l'écriture (null si création/suppression) — seuls
      les cas ENFANTS les lisent (cf. `needsPreviousRecord` : inutile de les fournir ailleurs). */
  static dependentQueries(
    collection: string, id: string,
    oldRecord: Record<string, any> | null, newRecord: Record<string, any> | null,
  ): DependentQuery[] {
    const out: DependentQuery[] = [];
    const seen = new Set<string>();
    const add = (q: DependentQuery): void => {
      // ⚠ Séparateur de clé composite écrit en SÉQUENCE D'ÉCHAPPEMENT (`\u0000`) et JAMAIS en
      //   caractère brut : un NUL tapé en clair ressort tel quel dans la source et fait passer le
      //   FICHIER ENTIER pour binaire aux yeux de grep/ripgrep (« Binary file … matches », sans
      //   plus aucune correspondance affichée) — toute recherche dans ce module central devient
      //   alors AVEUGLE. Même piège que celui commenté sur `Cascade.KEY_SEP` et dans le module `issues/`.
      const key = q.collection + "\u0000" + q.field + "\u0000" + q.value + "\u0000" + (q.then ? q.then.collection + "/" + q.then.field : "");
      if (seen.has(key)) return;
      seen.add(key);
      out.push(q);
    };
    for (const [holder, spec] of Object.entries(SEARCH_SPECS)) {
      for (const link of spec.links || []) {
        // Cible DIRECTE d'un lien : utile si elle contribue OU si elle est l'étape d'un 2e saut
        // (une étagère ne contribue rien mais son `rack_id` peut avoir changé → recalcul quand même).
        if (link.target === collection && (link.contributes.length || link.then)) {
          add({ collection: holder, field: link.field, value: id });
        }
        // Cible FINALE d'un lien à 2 sauts : chaîne inverse via la collection intermédiaire.
        if (link.then && link.then.target === collection) {
          add({ collection: link.target, field: link.then.field, value: id, then: { collection: holder, field: link.field } });
        }
      }
      for (const child of spec.children || []) {
        if (child.collection !== collection) continue;
        for (const rec of [oldRecord, newRecord]) {
          const parentId = rec ? rec[child.fkField] : null;
          if (parentId) add({ collection: holder, field: "id", value: String(parentId) });
        }
      }
    }
    return out;
  }
}
