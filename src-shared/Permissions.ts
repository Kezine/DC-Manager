/* ============================================================================
   PERMISSIONS — modèle d'AUTORISATION partagé front ⇄ back (TS PUR).

   POURQUOI CE MODULE. L'autorisation du serveur était BINAIRE (`logged &&
   adminRight === "SUPER_ADMIN"`, un seul prédicat, un seul montage global) et la
   règle était DUPLIQUÉE côté client. Un modèle à permissions atomiques ne vaut
   que s'il est dit UNE fois : le serveur DÉCIDE (gardes de route), le client
   ANTICIPE (masquage des vues et des actions) — s'ils dérivaient, l'UI
   proposerait des gestes que le serveur refuse, ou masquerait des gestes
   permis. D'où l'emplacement partagé (principe n°3), sur le patron exact de
   `ListOrder` / `ListFacets` : une liste blanche déclarative, lue des deux
   côtés, verrouillée par des tests d'invariants.

   ── Le modèle en trois mots ───────────────────────────────────────────────
   1. Une PERMISSION ATOMIQUE s'écrit `domaine[.sous-domaine]:action`
      (`dc.ip:update`, `certs:pki`, `snapshot:write`). C'est ce que les gardes
      VÉRIFIENT — toujours atomique, jamais un joker.
   2. Un GRANT est ce qu'un rôle DONNE. Il accepte les jokers : `*`,
      `dc.*:read`, `certs:*`, `dc.ip:*`, `dc.*:*`. Le matching vit dans
      `PermissionSet.has` et NULLE PART ailleurs.
   3. Un RÔLE est un simple nom associé à une liste de grants. Les rôles
      PRESETS (ci-dessous) sont une COMMODITÉ ; la vérité est le catalogue
      atomique. Composition multi-rôles = UNION ADDITIVE, sans deny (v1) : une
      permission de plus ne peut jamais en retirer une autre, ce qui rend le
      calcul associatif et l'ordre des rôles indifférent.

   ── Opt-in STRICT, fail-closed ────────────────────────────────────────────
   Aucun rôle par défaut : 0 rôle → 0 grant → `PermissionSet` VIDE → refus
   partout. Une permission INCONNUE ne matche rien (elle n'ouvre donc jamais) ;
   un grant MALFORMÉ est ignoré plutôt qu'interprété au plus large.

   ── Mode local (principe n°15) ────────────────────────────────────────────
   L'ACL est serveur-seulement : en mode FICHIER l'utilisateur est propriétaire
   de son fichier, il n'y a ni identité ni frontière de confiance à tenir. Le
   client y instancie `PermissionSet.ALL` — patron « injection nulle » de
   `HydrationState` (un état inerte plutôt qu'un `if (mode === …)` disséminé).
   Cf. `docs/auth.md` § « Mode local ».

   Module PUR (aucun DOM, aucun Node, aucun npm). ⚠ Il n'importe RIEN : la carte
   des collections est un CONSTAT tenu par un test d'invariant contre
   `Schema.COLLECTIONS` (le test CASSE à l'ajout d'une collection non mappée),
   pas par une dérivation. Si un import interne devenait utile, l'extension
   `.js` serait IMPÉRATIVE (cf. CLAUDE.md § « Code partagé front/back »).
   ============================================================================ */

/** Les quatre verbes d'une permission de DONNÉE documentaire (CRUD des collections). */
export type PermissionAction = "read" | "create" | "update" | "delete";

/** Forme LÂCHE d'un lot d'écriture (`POST /transact`) telle qu'elle arrive sur le fil : on n'y lit
    que le nom de collection de chaque opération, et la présence de `meta`. Typée « inconnue » à
    dessein — c'est une charge utile réseau, pas un objet de confiance. */
export interface WriteBatchLike {
  creates?: ReadonlyArray<{ collection?: unknown } | null | undefined> | null;
  updates?: ReadonlyArray<{ collection?: unknown } | null | undefined> | null;
  deletes?: ReadonlyArray<{ collection?: unknown } | null | undefined> | null;
  meta?: unknown;
}

/** Un GRANT analysé : deux motifs (domaine, action), chacun exact ou joker. Interne au module —
    c'est la forme sur laquelle `has` travaille, pour ne pas redécouper une chaîne à chaque check. */
interface ParsedGrant {
  /** `*` (tout domaine), `x.*` (les sous-domaines de `x`), ou un domaine exact. */
  domain: string;
  /** `*` (toute action) ou une action exacte. */
  action: string;
}

/** ENSEMBLE de permissions d'un appelant — objet-valeur IMMUABLE bâti d'une liste de grants.
    C'est le SEUL endroit où le joker est interprété : les appelants ne posent que des questions
    ATOMIQUES (`has("dc.ip:update")`), ce qui interdit qu'une comparaison de chaînes approximative
    se glisse dans une garde. */
export class PermissionSet {
  /** Ensemble VIDE = aucun droit. L'état par défaut d'un utilisateur authentifié (opt-in strict). */
  static readonly EMPTY: PermissionSet = new PermissionSet([]);

  /** Ensemble TOUT PERMIS. Deux usages, et deux seulement : le mode FICHIER (injection nulle,
      cf. l'en-tête) et le rôle `admin`. JAMAIS un repli d'erreur — un provider en panne rend
      `EMPTY`, jamais ceci (fail-closed). */
  static readonly ALL: PermissionSet = new PermissionSet(["*"]);

  private readonly parsed: readonly ParsedGrant[];
  private readonly sourceGrants: readonly string[];

  /** Construction DIRECTE (rare) : préférer `PermissionSet.of` — même chose, nom parlant à l'appel. */
  constructor(grants: Iterable<string>) {
    // Dédoublonnage + tri : le résultat est un ENSEMBLE, l'ordre n'y a aucun sens. Le figer rend
    // DÉTERMINISTES la réponse `/me` (donc les comparaisons côté client) et les tests, alors que
    // l'ordre naturel dépendrait de l'ordre des rôles et des clés d'un JSON.
    const unique = [...new Set([...grants].map((g) => String(g == null ? "" : g).trim()).filter((g) => g !== ""))].sort();
    const parsed: ParsedGrant[] = [];
    for (const grant of unique) {
      const rule = PermissionSet.parseGrant(grant);
      // Grant MALFORMÉ : IGNORÉ, jamais interprété au plus large — le refus doit rester le défaut.
      if (rule) parsed.push(rule);
    }
    this.sourceGrants = unique;
    this.parsed = parsed;
  }

  /** Fabrique lisible à l'appel. `PermissionSet.of(["dc.*:read"])`. */
  static of(grants: Iterable<string>): PermissionSet { return new PermissionSet(grants); }

  /** Analyse d'UN grant. `*` seul = tout ; sinon `domaine:action`, découpé au PREMIER `:`
      (aucun nom de domaine n'en contient). Toute autre forme → null (malformé). */
  private static parseGrant(grant: string): ParsedGrant | null {
    if (grant === "*") return { domain: "*", action: "*" };
    const cut = grant.indexOf(":");
    if (cut <= 0 || cut === grant.length - 1) return null;
    const domain = grant.slice(0, cut);
    const action = grant.slice(cut + 1);
    if (action.includes(":")) return null;   // `a:b:c` n'est pas une forme du modèle
    return { domain, action };
  }

  /** Le motif de domaine d'un grant couvre-t-il ce domaine ? `*` = tous ; `dc.*` = les
      SOUS-domaines de `dc` (donc `dc.ip`, mais pas un hypothétique domaine `dc` nu — il n'y en a
      pas, et l'ambiguïté ne doit pas être tranchée au plus large). */
  private static domainMatches(pattern: string, domain: string): boolean {
    if (pattern === "*" || pattern === domain) return true;
    if (!pattern.endsWith(".*")) return false;
    return domain.startsWith(pattern.slice(0, -1));   // "dc.*" → préfixe "dc."
  }

  /** L'appelant détient-il cette permission ATOMIQUE ? Une permission comportant un joker renvoie
      TOUJOURS faux : c'est une erreur de programmation (un check n'est jamais un motif), et la
      traiter « au mieux » masquerait la faute en ouvrant l'accès. */
  has(permission: string): boolean {
    const wanted = String(permission == null ? "" : permission).trim();
    if (wanted === "" || wanted.includes("*")) return false;
    const cut = wanted.indexOf(":");
    if (cut <= 0 || cut === wanted.length - 1) return false;
    const domain = wanted.slice(0, cut);
    const action = wanted.slice(cut + 1);
    for (const rule of this.parsed) {
      if ((rule.action === "*" || rule.action === action) && PermissionSet.domainMatches(rule.domain, domain)) return true;
    }
    return false;
  }

  /** Au moins UNE des permissions atomiques proposées est-elle détenue ? (Gardes « ≥ 1 read ».) */
  hasAny(permissions: Iterable<string>): boolean {
    for (const permission of permissions) if (this.has(permission)) return true;
    return false;
  }

  /** Aucun grant EXPLOITABLE → refus partout (invariant « 0 permission → 403 »). Un ensemble
      composé UNIQUEMENT de grants malformés est vide au sens qui compte : il n'ouvre rien. */
  isEmpty(): boolean { return this.parsed.length === 0; }

  /** UNION additive (composition multi-rôles). Ni deny, ni priorité : l'ordre est indifférent. */
  union(other: PermissionSet): PermissionSet {
    return new PermissionSet([...this.sourceGrants, ...other.sourceGrants]);
  }

  /** Sérialisation PLATE des grants (jokers COMPRIS) — la forme transportée par `GET /me`, à partir
      de laquelle le client reconstruit un `PermissionSet` identique. On expose les GRANTS et jamais
      les rôles : le client applique la politique, il ne la connaît pas. */
  grants(): readonly string[] { return this.sourceGrants; }
}

/** Carte, catalogue et dérivations du modèle de permissions (méthodes statiques — cf. CLAUDE.md). */
export class Permissions {
  /** Les quatre verbes du CRUD documentaire, dans l'ordre canonique. */
  static readonly ACTIONS: readonly PermissionAction[] = ["read", "create", "update", "delete"];

  /** COLLECTION → DOMAINE. Les 25 collections de `Schema.COLLECTIONS` y sont TOUTES, et un test
      d'invariant le vérifie : l'ajout d'une collection non mappée CASSE la suite plutôt que de la
      laisser sans domaine (donc sans garde utile).

      La découpe est un COMPROMIS lisibilité / grain, pas une taxonomie : elle est calibrée sur les
      rôles réels (elle rend `dc-connector` trivial — `dc.cabling:*` plus trois reads) sans
      pulvériser le catalogue en 25 domaines que personne n'écrirait à la main. */
  static readonly COLLECTION_DOMAINS: Readonly<Record<string, string>> = {
    // Matériel actif et ses pièces (les spares sont du matériel en attente d'emploi).
    equipments: "dc.equipment", subEquipments: "dc.equipment", ports: "dc.equipment",
    aggregates: "dc.equipment", spares: "dc.equipment",
    // Liaisons physiques et leurs référentiels (types de câble/port, faisceaux, waypoints).
    cables: "dc.cabling", cableBundles: "dc.cabling", cableTypes: "dc.cabling",
    portTypes: "dc.cabling", waypoints: "dc.cabling",
    // Baies et leur contenu non-équipement (étagères, panneaux passifs…).
    racks: "dc.rack", rackItems: "dc.rack",
    // Découpage spatial : le CONTENANT (site → bâtiment → étage → salle) et les groupes.
    sites: "dc.site", datacenters: "dc.site", floors: "dc.site", groups: "dc.site",
    // Adressage.
    networks: "dc.ip", ipNetworks: "dc.ip", ipAddresses: "dc.ip", dhcpRanges: "dc.ip",
    // Domaines à collection unique : leur usage (et leur public) diffère assez du reste pour
    // justifier un grain propre — un gestionnaire de notifications a besoin des contacts, pas des baies.
    applications: "dc.app",
    contacts: "dc.contact",
    attachments: "dc.attachment",
    vms: "vm",
    wifiClients: "wifi",
  };

  /** PSEUDO-collections : `meta` (réglages du document) et `images` (bibliothèque de façades) ne
      sont pas des collections de `Schema.COLLECTIONS`, mais sont bien de la donnée du document.
      Rattachées à `dc.site` — ce sont les réglages et les fonds de plan du lieu. */
  static readonly PSEUDO_COLLECTION_DOMAINS: Readonly<Record<string, string>> = {
    meta: "dc.site",
    images: "dc.site",
  };

  /** DOMAINES de donnée DOCUMENTAIRE (dérivés de la carte, ordre stable). C'est l'assiette de la
      règle « ≥ 1 lecture documentaire » qui garde le flux SSE et la recherche transverse. */
  static readonly DATA_DOMAINS: readonly string[] = [...new Set(Object.values(Permissions.COLLECTION_DOMAINS))];

  /** Permissions MÉTA du cœur — hors collections, une par geste d'administration. Elles ne sont pas
      dérivables d'une carte : ce sont des ACTIONS, pas des données. */
  static readonly META_PERMISSIONS: readonly string[] = [
    "settings:manage",     // réglages globaux de l'instance (document par défaut)
    "documents:manage",    // création / renommage / verrouillage / suppression de documents
    "snapshot:write",      // remplacement COMPLET d'un document (import .json) — geste destructeur
    "maintenance:run",     // purge des binaires orphelins + VACUUM/checkpoint
  ];

  /** Permissions des MODULES amovibles. Elles vivent ici parce que le catalogue doit être UN (le
      client masque ses onglets `certs`/`vm`/… sur ces mêmes noms) ; le cœur, lui, ne les connaît
      pas : chaque module reçoit sa garde INJECTÉE et ne déclare que les chaînes qui le concernent.
      Retirer un module ne laisse donc que des entrées de catalogue inertes — jamais un droit
      fantôme (une permission que personne ne vérifie n'ouvre rien).
      ⚠ `vm:read` / `wifi:read` sont VOLONTAIREMENT les mêmes que les lectures de collection
      correspondantes (`vms`, `wifiClients`) : « lire l'inventaire VM » et « lire l'état de la
      synchro VM » sont un seul droit du point de vue de l'utilisateur. */
  static readonly MODULE_PERMISSIONS: readonly string[] = [
    "vm:sync", "vm.providers:manage",
    "wifi:sync", "wifi.providers:manage",
    "tracker:read", "tracker:push", "tracker.providers:manage",
    "certs:read", "certs:write", "certs:pki",
    "interventions:read", "interventions:write",
    "notify:read", "notify:manage",
  ];

  /** CATALOGUE COMPLET des permissions atomiques : le CRUD de chaque domaine de donnée, plus les
      méta, plus celles des modules. Sert au contrôle de cohérence des rôles (un preset ou un rôle
      custom qui nomme une permission hors catalogue est une COQUILLE, signalée plutôt que subie). */
  static readonly CATALOG: readonly string[] = [
    ...Permissions.DATA_DOMAINS.flatMap((domain) => Permissions.ACTIONS.map((action) => domain + ":" + action)),
    ...Permissions.META_PERMISSIONS,
    ...Permissions.MODULE_PERMISSIONS,
  ];

  private static readonly CATALOG_SET: ReadonlySet<string> = new Set(Permissions.CATALOG);

  /** RÔLES PRESETS — commodité de configuration : `roles.json` n'a plus qu'à nommer un rôle.
      Un déploiement qui veut autre chose définit ses PROPRES rôles (section `roles` du fichier),
      les deux jeux cohabitent. Read scopé PAR DOMAINE : il n'existe volontairement PAS de
      « viewer global » implicite — « tout voir » s'écrit comme l'union explicite des `*-viewer`,
      pour qu'aucun droit ne s'acquière par distraction. */
  static readonly ROLE_PRESETS: Readonly<Record<string, readonly string[]>> = {
    /** Tout, y compris les gestes d'administration et les secrets des providers. */
    admin: ["*"],
    /** Lecture de TOUTE la donnée documentaire DC (pas les VMs ni le wifi — domaines à part). */
    "dc-viewer": ["dc.*:read"],
    /** Écriture complète de la donnée documentaire DC. */
    "dc-editor": ["dc.*:*"],
    /** Le câbleur : il tire et débranche, il ne crée ni équipement ni baie (il les LIT pour
        choisir ses extrémités). */
    "dc-connector": ["dc.cabling:*", "dc.equipment:read", "dc.rack:read", "dc.site:read"],
    "vm-viewer": ["vm:read"],
    /** Opérateur VM : synchro + CRUD des VMs MANUELLES (forme B). Énuméré plutôt que `vm:*` — un
        rôle d'opérateur ne doit pas hériter en silence d'un futur `vm:<verbe sensible>`, et la
        gestion des providers (qui porte des JETONS) reste hors de son périmètre. */
    "vm-operator": ["vm:read", "vm:sync", "vm:create", "vm:update", "vm:delete"],
    "wifi-viewer": ["wifi:read"],
    "wifi-operator": ["wifi:read", "wifi:sync", "wifi:create", "wifi:update", "wifi:delete"],
    "cert-viewer": ["certs:read"],
    /** Émet, renouvelle et révoque — mais PAS les cérémonies de coffre (`certs:pki` : initialisation
        et re-chiffrement des clés racine, irréversibles si mal menées). */
    "cert-manager": ["certs:read", "certs:write"],
    /** Voit les interventions ET leur état de réplication (la pastille du tracker est une lecture). */
    "intervention-viewer": ["interventions:read", "tracker:read"],
    /** Écrit les interventions et déclenche leur poussée — qui ÉCRASE le ticket distant. */
    "intervention-editor": ["interventions:read", "interventions:write", "tracker:read", "tracker:push"],
    /** Gère canaux et abonnements ; a besoin des CONTACTS, qui sont les destinataires. */
    "notify-manager": ["notify:*", "dc.contact:*"],
  };

  /** Domaine d'une collection (ou pseudo-collection `meta`/`images`). null = nom inconnu — l'appelant
      répond alors 404 « collection inconnue », comme avant l'ACL : une collection qui n'existe pas
      n'est pas un refus d'accès. */
  static domainOf(collection: string): string | null {
    const name = String(collection == null ? "" : collection);
    return Permissions.COLLECTION_DOMAINS[name] || Permissions.PSEUDO_COLLECTION_DOMAINS[name] || null;
  }

  /** Permission atomique exigée pour `action` sur `collection`. null si la collection est inconnue. */
  static forCollection(collection: string, action: PermissionAction): string | null {
    const domain = Permissions.domainOf(collection);
    return domain ? domain + ":" + action : null;
  }

  /** La permission fait-elle partie du catalogue ? Sert aux contrôles de cohérence (presets, rôles
      custom, étiquettes des gardes) — JAMAIS à autoriser : une permission hors catalogue ne matche
      simplement rien. */
  static isKnown(permission: string): boolean { return Permissions.CATALOG_SET.has(String(permission)); }

  /** Le grant est-il bien FORMÉ (`*`, `dom:action`, jokers admis) ? Un grant malformé est ignoré par
      `PermissionSet` ; ce prédicat existe pour le SIGNALER à l'exploitant au chargement de sa
      configuration, plutôt que de le laisser croire à un droit accordé. */
  static isWellFormedGrant(grant: string): boolean {
    const value = String(grant == null ? "" : grant).trim();
    if (value === "*") return true;
    const cut = value.indexOf(":");
    if (cut <= 0 || cut === value.length - 1) return false;
    const action = value.slice(cut + 1);
    return !action.includes(":");
  }

  /** Le grant vise-t-il un domaine et une action du catalogue ? Plus strict que la bonne FORME :
      `dc.ip:*` et `dc.*:read` sont acceptés (jokers), `dc.oups:read` et `dc.ip:frobnique` non. */
  static isCatalogedGrant(grant: string): boolean {
    if (!Permissions.isWellFormedGrant(grant)) return false;
    const set = PermissionSet.of([grant]);
    return Permissions.CATALOG.some((permission) => set.has(permission));
  }

  /** Les COLLECTIONS que cet appelant peut LIRE (assiette de la recherche transverse — cf.
      `docs/auth.md` § « Recherche »). Ordre = celui de la carte, donc stable. */
  static readableCollections(set: PermissionSet): string[] {
    return Object.keys(Permissions.COLLECTION_DOMAINS)
      .filter((collection) => set.has(Permissions.COLLECTION_DOMAINS[collection] + ":read"));
  }

  /** L'appelant a-t-il AU MOINS UNE lecture de donnée documentaire ? Règle des routes qui ne
      révèlent pas de contenu par elles-mêmes (SSE : des ids et des noms de collection ; recherche :
      une assiette de toute façon restreinte ensuite). */
  static hasAnyDocumentRead(set: PermissionSet): boolean {
    return set.hasAny(Permissions.DATA_DOMAINS.map((domain) => domain + ":read"));
  }

  /** Permissions exigées par un LOT d'écriture (`POST /transact`) — logique PURE, testable seule :
      liste d'opérations → liste de permissions, DÉDUPLIQUÉE et d'ordre stable. La garde HTTP ne
      fait que l'appeler et refuser à la première manquante, AVANT que rien ne soit appliqué.

      `meta` compte : un lot peut remplacer les réglages du document (`Repository.transact`
      l'applique), ce qui est une écriture `dc.site:update` — l'oublier laisserait une porte
      dérobée vers la méta pour qui n'a le droit que sur une autre collection.
      Une opération dont la collection est INCONNUE n'ajoute rien : elle sera de toute façon
      rejetée plus bas (le dépôt refuse toute collection hors schéma) — ce n'est pas à l'ACL de
      requalifier une erreur de forme en refus d'accès. */
  static forBatch(batch: WriteBatchLike | null | undefined): string[] {
    const required = new Set<string>();
    const body = batch || {};
    const collect = (entries: WriteBatchLike["creates"], action: PermissionAction) => {
      for (const entry of entries || []) {
        const permission = entry ? Permissions.forCollection(String((entry as { collection?: unknown }).collection ?? ""), action) : null;
        if (permission) required.add(permission);
      }
    };
    collect(body.creates, "create");
    collect(body.updates, "update");
    collect(body.deletes, "delete");
    if (body.meta) required.add("dc.site:update");
    return [...required].sort();
  }
}
