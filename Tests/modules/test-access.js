/* Tests modules — AUTORISATION (lot 1 du chantier auth/ACL ; politique v2 « groupes → rôles » au lot 4).

   Cinq sections, du modèle partagé jusqu'au verrou d'exhaustivité :
   1. `src-shared/Permissions` — la CARTE collections → domaines (invariant qui CASSE à
      l'ajout d'une collection non mappée), le catalogue, le matching des jokers (cas
      positifs ET négatifs), la cohérence des presets, les permissions d'un lot d'écriture ;
   2. `access/RolesConfig` — analyse PURE d'un `roles.json` : tolérance de forme, refus de
      deviner, avertissements, union id ⇄ login, et la table `groups` (mapping des groupes
      d'un IdP vers des rôles — union users ∪ groups, correspondance exacte) ;
   3. `access/FileRoleProvider` — fail-closed sur fichier absent/illisible, amorçage,
      rétrocompatibilité SUPER_ADMIN/dev, groupes de l'identité, génération (fichiers RÉELS,
      os.tmpdir) ;
   4. `access/AccessControl` — 401 vs 403, refus des ensembles vides, gardes taguées,
      résolution collection → domaine, lot d'écriture, invalidation par génération, et 🚨 la
      clé du cache de permissions qui INTÈGRE les groupes (sans quoi deux appartenances du
      même login partageraient un ensemble de droits). Le service ne dépend PAS d'Express
      (il déclare ses propres vues de req/res) : on l'éprouve avec des objets factices, sans
      monter de serveur ;
   5. EXHAUSTIVITÉ des gardes — un verrou qui relit les SOURCES des routeurs et échoue en
      NOMMANT toute route terminale sans garde. Cf. l'en-tête de la section pour le choix
      de mécanisme et son contrôle de discrimination.

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, SERVER, SHARED, SharedSchema } = require("./harness.js");

module.exports = async () => {

  /* ==========================================================================
     1. Modèle PARTAGÉ
     ========================================================================== */
  await section("shared : Permissions — carte des collections (invariant), catalogue, jokers, presets, lot d'écriture", async () => {
    const { Permissions, PermissionSet } = SHARED("src-shared/Permissions.js");

    // -- INVARIANT n°1 : la carte couvre TOUTES les collections, et RIEN d'autre. C'est LE test
    // qui doit casser le jour où quelqu'un ajoute une collection sans lui donner de domaine :
    // sans domaine, sa route générique n'exigerait aucune permission utile.
    const mapped = Object.keys(Permissions.COLLECTION_DOMAINS).sort();
    const declared = [...SharedSchema.COLLECTIONS].sort();
    ck.eq(declared.filter((c) => !Permissions.COLLECTION_DOMAINS[c]).join(","), "",
      "carte : TOUTE collection de Schema.COLLECTIONS a un domaine (casse à l'ajout d'une collection non mappée)");
    ck.eq(mapped.filter((c) => !declared.includes(c)).join(","), "",
      "carte : aucune collection FANTÔME (une entrée sans collection réelle serait du droit mort)");
    ck.eq(mapped.length, declared.length, "carte : exactement " + declared.length + " collections mappées");

    // Découpe attendue (le compromis lisibilité/grain du cadrage — un changement doit être VOULU).
    ck.eq(Permissions.domainOf("equipments"), "dc.equipment", "domaine : equipments → dc.equipment");
    ck.eq(Permissions.domainOf("spares"), "dc.equipment", "domaine : spares → dc.equipment (matériel en attente d'emploi)");
    ck.eq(Permissions.domainOf("waypoints"), "dc.cabling", "domaine : waypoints → dc.cabling");
    ck.eq(Permissions.domainOf("rackItems"), "dc.rack", "domaine : rackItems → dc.rack");
    ck.eq(Permissions.domainOf("groups"), "dc.site", "domaine : groups → dc.site");
    ck.eq(Permissions.domainOf("dhcpRanges"), "dc.ip", "domaine : dhcpRanges → dc.ip");
    ck.eq(Permissions.domainOf("applications"), "dc.app", "domaine : applications → dc.app");
    ck.eq(Permissions.domainOf("attachments"), "dc.attachment", "domaine : attachments → dc.attachment");
    ck.eq(Permissions.domainOf("vms"), "vm", "domaine : vms → vm");
    ck.eq(Permissions.domainOf("wifiClients"), "wifi", "domaine : wifiClients → wifi");
    // PSEUDO-collections : hors Schema.COLLECTIONS, mais bien de la donnée du document.
    ck.eq(Permissions.domainOf("meta"), "dc.site", "pseudo-collection : meta → dc.site");
    ck.eq(Permissions.domainOf("images"), "dc.site", "pseudo-collection : images → dc.site");
    ck.eq(Permissions.domainOf("pasUneCollection"), null, "collection inconnue → null (l'appelant répondra 404, pas 403)");
    ck.eq(Permissions.forCollection("ipAddresses", "update"), "dc.ip:update", "forCollection : ipAddresses + update");
    ck.eq(Permissions.forCollection("inconnue", "read"), null, "forCollection : collection inconnue → null");

    // -- Catalogue --
    ck(Permissions.isKnown("dc.ip:update"), "catalogue : dc.ip:update connue");
    ck(Permissions.isKnown("snapshot:write"), "catalogue : snapshot:write connue");
    ck(Permissions.isKnown("certs:pki"), "catalogue : certs:pki connue");
    ck(Permissions.isKnown("vm.providers:manage"), "catalogue : vm.providers:manage connue");
    ck(!Permissions.isKnown("dc.ip:frobnique"), "catalogue : action inventée INCONNUE");
    ck(!Permissions.isKnown("dc.oups:read"), "catalogue : domaine inventé INCONNU");
    ck(!Permissions.isKnown("dc.*:read"), "catalogue : un JOKER n'est pas une permission atomique");
    ck.eq(Permissions.DATA_DOMAINS.length, 10, "catalogue : 10 domaines de donnée documentaire");
    // Le catalogue ne doit pas contenir de doublon (une entrée dupliquée signalerait une carte incohérente).
    ck.eq(new Set(Permissions.CATALOG).size, Permissions.CATALOG.length, "catalogue : aucune permission en double");

    // -- Matching des JOKERS : les cas positifs ET, surtout, les négatifs --
    const admin = PermissionSet.of(["*"]);
    ck(admin.has("dc.ip:delete") && admin.has("certs:pki") && admin.has("settings:manage"), "joker `*` : tout est accordé");
    const viewer = PermissionSet.of(["dc.*:read"]);
    ck(viewer.has("dc.equipment:read"), "joker `dc.*:read` : accorde dc.equipment:read");
    ck(viewer.has("dc.attachment:read"), "joker `dc.*:read` : accorde dc.attachment:read");
    ck(!viewer.has("dc.ip:update"), "joker `dc.*:read` : REFUSE dc.ip:update (l'action ne matche pas)");
    ck(!viewer.has("vm:read"), "joker `dc.*:read` : REFUSE vm:read (hors du préfixe dc.)");
    ck(!viewer.has("dc:read"), "joker `dc.*:read` : REFUSE un domaine `dc` NU (le motif exige un sous-domaine)");
    const ip = PermissionSet.of(["dc.ip:*"]);
    ck(ip.has("dc.ip:delete") && ip.has("dc.ip:read"), "joker `dc.ip:*` : toutes les actions du domaine");
    ck(!ip.has("dc.equipment:read"), "joker `dc.ip:*` : REFUSE un autre domaine");
    const vmAll = PermissionSet.of(["vm:*"]);
    ck(vmAll.has("vm:sync"), "joker `vm:*` : accorde vm:sync");
    ck(!vmAll.has("vm.providers:manage"), "joker `vm:*` : REFUSE vm.providers:manage (sous-domaine ≠ domaine — les jetons restent protégés)");
    ck(PermissionSet.of(["vm.*:manage"]).has("vm.providers:manage"), "joker `vm.*:manage` : accorde le SOUS-domaine providers");
    ck(PermissionSet.of(["dc.*:*"]).has("dc.rack:delete"), "joker `dc.*:*` : domaine ET action");
    // Un CHECK n'est jamais un motif : le laisser passer masquerait une faute en OUVRANT l'accès.
    ck(!admin.has("dc.*:read"), "check à joker → toujours refusé (une vérification est atomique, par contrat)");
    ck(!admin.has(""), "check vide → refusé");
    ck(!admin.has("nimportequoi"), "check sans `:` → refusé");
    // Grants MALFORMÉS : ignorés, jamais interprétés au plus large.
    const junk = PermissionSet.of(["", "   ", "pasdedeuxpoints", ":read", "dc.ip:", "a:b:c"]);
    ck(junk.isEmpty(), "grants malformés : ensemble VIDE (jamais d'interprétation au plus large)");
    ck(PermissionSet.EMPTY.isEmpty() && !PermissionSet.EMPTY.has("dc.ip:read"), "PermissionSet.EMPTY : n'ouvre rien");
    ck(!PermissionSet.ALL.isEmpty() && PermissionSet.ALL.has("maintenance:run"), "PermissionSet.ALL : mode fichier — tout permis");

    // -- Union + sérialisation --
    const merged = PermissionSet.of(["dc.ip:read"]).union(PermissionSet.of(["certs:read", "dc.ip:read"]));
    ck.eq(merged.grants().join("|"), "certs:read|dc.ip:read", "union : additive, dédupliquée, ordre DÉTERMINISTE (trié)");
    ck(merged.has("dc.ip:read") && merged.has("certs:read"), "union : les deux apports sont détenus");
    ck.eq(PermissionSet.of([" dc.ip:read ", "dc.ip:read"]).grants().join("|"), "dc.ip:read", "sérialisation : rognage + dédoublonnage");

    // -- Presets : aucun grant fantaisiste, et le contenu attendu du cadrage --
    const bad = [];
    for (const [role, grants] of Object.entries(Permissions.ROLE_PRESETS)) {
      for (const grant of grants) if (!Permissions.isCatalogedGrant(grant)) bad.push(role + " → " + grant);
    }
    ck.eq(bad.join(", "), "", "presets : tous les grants visent le catalogue (aucune coquille dormante)");
    const preset = (role) => PermissionSet.of(Permissions.ROLE_PRESETS[role]);
    ck(preset("admin").has("documents:manage") && preset("admin").has("certs:pki"), "preset admin : tout, y compris les gestes d'administration");
    ck(preset("dc-viewer").has("dc.rack:read") && !preset("dc-viewer").has("dc.rack:update"), "preset dc-viewer : lecture seule");
    ck(!preset("dc-viewer").has("vm:read") && !preset("dc-viewer").has("wifi:read"), "preset dc-viewer : ne voit NI les VMs NI le wifi (domaines à part)");
    ck(preset("dc-editor").has("dc.cabling:delete") && !preset("dc-editor").has("snapshot:write"), "preset dc-editor : écrit la donnée DC, PAS les gestes d'administration");
    const connector = preset("dc-connector");
    ck(connector.has("dc.cabling:create") && connector.has("dc.equipment:read"), "preset dc-connector : câble, et LIT les extrémités");
    ck(!connector.has("dc.equipment:update") && !connector.has("dc.ip:read"), "preset dc-connector : ne modifie pas les équipements, ne voit pas l'IPAM");
    ck(preset("vm-operator").has("vm:sync") && preset("vm-operator").has("vm:create"), "preset vm-operator : synchro + CRUD des VMs manuelles");
    ck(!preset("vm-operator").has("vm.providers:manage"), "preset vm-operator : PAS la config des providers (elle porte des jetons)");
    ck(preset("cert-manager").has("certs:write") && !preset("cert-manager").has("certs:pki"), "preset cert-manager : émet/révoque, mais PAS les cérémonies de coffre");
    ck(preset("intervention-viewer").has("tracker:read") && !preset("intervention-viewer").has("tracker:push"), "preset intervention-viewer : voit l'état de réplication, ne pousse pas");
    ck(preset("intervention-editor").has("tracker:push") && preset("intervention-editor").has("interventions:write"), "preset intervention-editor : écrit et pousse");
    ck(preset("notify-manager").has("dc.contact:update") && preset("notify-manager").has("notify:manage"), "preset notify-manager : canaux + contacts (les destinataires)");
    ck(!preset("notify-manager").has("dc.equipment:read"), "preset notify-manager : les contacts, pas tout le DC");

    // -- Assiette lisible + « ≥ 1 lecture documentaire » --
    ck.eq(Permissions.readableCollections(PermissionSet.EMPTY).length, 0, "assiette : ensemble vide → aucune collection lisible");
    const ipReadable = Permissions.readableCollections(PermissionSet.of(["dc.ip:read"]));
    ck.eq(ipReadable.slice().sort().join(","), "dhcpRanges,ipAddresses,ipNetworks,networks", "assiette : dc.ip:read → les 4 collections d'adressage");
    ck.eq(Permissions.readableCollections(PermissionSet.ALL).length, SharedSchema.COLLECTIONS.length, "assiette : `*` → toutes les collections");
    ck(Permissions.hasAnyDocumentRead(PermissionSet.of(["wifi:read"])), "≥ 1 lecture doc : wifi:read suffit");
    ck(!Permissions.hasAnyDocumentRead(PermissionSet.of(["certs:read", "notify:manage"])), "≥ 1 lecture doc : les permissions de MODULE ne comptent pas");

    // -- Permissions d'un LOT d'écriture --
    ck.eq(Permissions.forBatch(null).join("|"), "", "lot : corps absent → aucune permission exigée");
    ck.eq(Permissions.forBatch({ creates: [{ collection: "cables" }], updates: [{ collection: "ports" }], deletes: [{ collection: "cables" }] }).join("|"),
      "dc.cabling:create|dc.cabling:delete|dc.equipment:update", "lot : une permission par (domaine, action), triée");
    ck.eq(Permissions.forBatch({ creates: [{ collection: "cables" }, { collection: "waypoints" }] }).join("|"),
      "dc.cabling:create", "lot : deux collections du MÊME domaine → une seule permission");
    ck.eq(Permissions.forBatch({ meta: { theme: "sombre" } }).join("|"), "dc.site:update",
      "lot : la META compte comme une écriture dc.site (sinon, porte dérobée vers les réglages du document)");
    ck.eq(Permissions.forBatch({ creates: [{ collection: "pasUneCollection" }, null] }).join("|"), "",
      "lot : collection inconnue ignorée (le dépôt la rejettera — l'ACL ne requalifie pas une erreur de forme)");
  });

  /* ==========================================================================
     2. Analyse PURE de la configuration
     ========================================================================== */
  await section("Serveur : RolesConfig — analyse TOLÉRANTE en forme, STRICTE en droit, union id ⇄ login", async () => {
    const { RolesConfig } = SERVER("access/RolesConfig.js");

    const ok = RolesConfig.parse({ users: { jdupont: ["dc-editor"], 42: ["cert-manager", "vm-viewer"] }, roles: { "cabliste-nuit": ["dc.cabling:*"] } });
    ck.eq(ok.users.get("jdupont").join(","), "dc-editor", "parse : rôle d'un login");
    ck.eq(ok.users.get("42").join(","), "cert-manager,vm-viewer", "parse : rôles d'un id numérique (clé JSON = chaîne)");
    ck.eq(ok.roles.get("cabliste-nuit").join(","), "dc.cabling:*", "parse : rôle CUSTOM");
    ck.eq(ok.warnings.join(" | "), "", "parse : configuration saine → aucun avertissement");

    // TOLÉRANCE de forme : une clé inconnue ne doit pas invalider le fichier. C'est cette tolérance
    // qui a permis d'ajouter la table `groups` (lot 4) sans casser les fichiers écrits avant elle.
    const tolerant = RolesConfig.parse({ users: { a: ["admin"] }, frobnique: { x: ["dc-editor"] } });
    ck.eq(tolerant.users.get("a").join(","), "admin", "tolérance : une clé inconnue n'invalide pas le reste");
    ck(tolerant.warnings.some((w) => w.includes("frobnique")), "tolérance : la clé inconnue est SIGNALÉE, pas subie");

    /* -- GROUPES → RÔLES (politique v2, avec le mode forward / OIDC demain) -------------------- */
    ck.eq([...RolesConfig.KNOWN_KEYS].join(","), "users,groups,roles", "clés de premier niveau reconnues : `groups` en fait désormais partie");
    const withGroups = RolesConfig.parse({
      users: { jdupont: ["cert-viewer"] },
      groups: { "grp-infra": ["dc-editor"], "grp-noc": ["vm-viewer", "wifi-viewer"], "Infra": ["admin"] },
    });
    ck.eq(withGroups.warnings.join(" | "), "", "groups : table RECONNUE → plus aucun avertissement « clé inconnue » (il disparaît de lui-même)");
    ck.eq(withGroups.groups.get("grp-infra").join(","), "dc-editor", "groups : rôles d'un groupe");
    ck.eq(withGroups.groups.get("grp-noc").join(","), "vm-viewer,wifi-viewer", "groups : plusieurs rôles pour un groupe");
    ck.eq(RolesConfig.empty().groups.size, 0, "politique VIDE : la table des groupes existe et est vide (fail-closed)");

    // UNION users ∪ groups : la composition est purement ADDITIVE (aucun deny dans ce modèle), donc
    // l'ordre des clés est indifférent et rien ne se « masque ».
    ck.eq(RolesConfig.rolesFor(withGroups, "jdupont", "jdupont", ["grp-infra"]).sort().join(","), "cert-viewer,dc-editor",
      "lookup : UNION du rôle nominatif et du rôle de groupe");
    ck.eq(RolesConfig.rolesFor(withGroups, "", "inconnu", ["grp-infra", "grp-noc"]).sort().join(","), "dc-editor,vm-viewer,wifi-viewer",
      "lookup : un utilisateur ABSENT du fichier obtient les rôles de TOUS ses groupes (la gestion des personnes vit dans l'IdP)");
    ck.eq(RolesConfig.rolesFor(withGroups, "", "inconnu", ["grp-absent"]).join(","), "",
      "lookup : un groupe non déclaré n'accorde rien (opt-in strict, groupes compris)");
    ck.eq(RolesConfig.rolesFor(withGroups, "", "inconnu", []).join(","), "", "lookup : aucun groupe → aucun rôle");
    ck.eq(RolesConfig.rolesFor(withGroups, "jdupont", "jdupont").join(","), "cert-viewer",
      "lookup : groupes OMIS → défaut vide, ce qui ne peut que RESTREINDRE (jamais élargir) le résultat");
    ck.eq(RolesConfig.rolesFor(withGroups, "", "", ["infra"]).join(","), "",
      "lookup : correspondance de groupe EXACTE, sensible à la casse (`Infra` est déclaré, `infra` ne l'est pas)");
    ck.eq(RolesConfig.rolesFor(withGroups, "", "", ["Infra"]).join(","), "admin", "…et la graphie exacte, elle, accorde bien son rôle");
    ck.eq(RolesConfig.rolesFor(withGroups, "", "", ["grp-infra", "grp-infra"]).join(","), "dc-editor", "lookup : un groupe répété n'accorde pas deux fois (ensemble)");
    ck.eq(RolesConfig.rolesFor(RolesConfig.parse({ groups: {} }), "", "", ["constructor"]).join(","), "",
      "lookup : aucune clé héritée d'Object ne peut se faire passer pour un GROUPE (Map, pas objet nu)");
    // Même refus de deviner que pour `users` : la table des groupes passe par le MÊME `readTable`.
    const sloppyGroups = RolesConfig.parse({ groups: { "grp-a": "dc-editor", "grp-b": ["dc-viewer", 7] } });
    ck.eq(sloppyGroups.groups.has("grp-a"), false, "groups : une chaîne au lieu d'un tableau n'accorde RIEN");
    ck.eq(sloppyGroups.groups.get("grp-b").join(","), "dc-viewer", "groups : entrées non textuelles écartées");
    ck(sloppyGroups.warnings.some((w) => w.includes("groups")), "groups : chaque écart est signalé sous le nom de la section");

    // On ne DEVINE jamais : une valeur mal typée n'accorde rien.
    const sloppy = RolesConfig.parse({ users: { a: "dc-editor", b: ["dc-viewer", 7, ""], "": ["admin"] }, roles: [] });
    ck.eq(sloppy.users.has("a"), false, "refus de deviner : une chaîne au lieu d'un tableau n'accorde RIEN");
    ck.eq(sloppy.users.get("b").join(","), "dc-viewer", "refus de deviner : entrées non textuelles écartées");
    ck.eq(sloppy.users.has(""), false, "refus de deviner : clé vide ignorée");
    ck(sloppy.warnings.length >= 4, "refus de deviner : chaque écart est signalé (" + sloppy.warnings.length + " avertissements)");
    ck(RolesConfig.parse(["pas", "un", "objet"]).users.size === 0, "racine invalide (tableau) → politique VIDE");
    ck(RolesConfig.parse(null).users.size === 0, "racine nulle → politique VIDE");
    ck(RolesConfig.parse({ users: {} }).users.size === 0, "aucun bucket `default` : rien n'est accordé implicitement");
    // Les Map protègent des clés héritées d'un objet nu (`constructor` ne doit pas être « un rôle trouvé »).
    ck.eq(RolesConfig.rolesFor(RolesConfig.parse({ users: {} }), "constructor", "toString").join(","), "",
      "lookup : aucune clé héritée d'Object ne peut se faire passer pour une entrée");

    // STRICTESSE en droit : un grant qui n'accordera jamais rien est SIGNALÉ.
    const typo = RolesConfig.parse({ roles: { r1: ["dc.ip:reed"], r2: ["pasdedeuxpoints"], "dc-viewer": ["dc.*:read"] } });
    ck(typo.warnings.some((w) => w.includes("hors catalogue") && w.includes("dc.ip:reed")), "cohérence : grant hors catalogue signalé (coquille d'action)");
    ck(typo.warnings.some((w) => w.includes("MALFORMÉ")), "cohérence : grant malformé signalé");
    ck(typo.warnings.some((w) => w.includes("MASQUE le preset")), "cohérence : une redéfinition locale d'un preset est signalée (le fichier fait autorité)");

    // Union id ⇄ login : les deux graphies désignent la même personne.
    const both = RolesConfig.parse({ users: { 42: ["cert-viewer"], jdupont: ["dc-viewer"] } });
    ck.eq(RolesConfig.rolesFor(both, "42", "jdupont").sort().join(","), "cert-viewer,dc-viewer", "lookup : UNION de l'id canonique et du login");
    ck.eq(RolesConfig.rolesFor(both, "99", "inconnu").join(","), "", "lookup : identité non déclarée → aucun rôle (opt-in strict)");
    ck.eq(RolesConfig.rolesFor(both, "", "JDupont").join(","), "", "lookup : correspondance EXACTE, sensible à la casse (aucune normalisation implicite)");
  });

  /* ==========================================================================
     3. Politique sur fichier (fs réel)
     ========================================================================== */
  await section("Serveur : FileRoleProvider — fail-closed, amorçage, rétrocompat, génération (fichiers RÉELS)", async () => {
    const fs = require("fs"), os = require("os");
    const { FileRoleProvider } = SERVER("access/FileRoleProvider.js");
    const { Logger } = SERVER("logger.js");
    const quiet = new Logger("error", "test");   // le provider journalise beaucoup : on tait tout sauf les erreurs
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-roles-"));
    const file = path.join(dir, "roles.json");
    const identity = (over) => Object.assign({ id: "", login: "", adminRight: "", dev: false, groups: [] }, over || {});

    try {
      // -- Découpe de BOOTSTRAP_ADMIN_IDS --
      ck.eq(FileRoleProvider.parseBootstrap(" 42 , jdupont ,, 42 ").join("|"), "42|jdupont", "amorçage : virgules, rognage, vides et doublons écartés");
      ck.eq(FileRoleProvider.parseBootstrap(undefined).length, 0, "amorçage : variable absente → liste vide");

      // -- Fichier ABSENT : état DÉFINI, fail-closed, mais l'amorçage passe --
      const absent = new FileRoleProvider(file, ["42"], quiet);
      ck.eq((await absent.rolesOf(identity({ id: "99", login: "inconnu" }))).join(","), "", "fichier absent : personne n'a de rôle (fail-closed)");
      ck.eq((await absent.rolesOf(identity({ id: "42", login: "boss" }))).join(","), "admin", "fichier absent : l'amorçage BOOTSTRAP_ADMIN_IDS passe quand même");
      ck.eq((await absent.rolesOf(identity({ id: "7", login: "42" }))).join(","), "admin", "amorçage : la clé vaut pour l'id OU le login");

      // -- RÉTROCOMPATIBILITÉ : un déploiement existant ne change pas de comportement --
      ck.eq((await absent.rolesOf(identity({ login: "dev", dev: true }))).join(","), "admin", "rétrocompat : mode dev/basic → admin (comportement historique)");
      ck.eq((await absent.rolesOf(identity({ id: "5", adminRight: "SUPER_ADMIN" }))).join(","), "admin", "rétrocompat : SSO SUPER_ADMIN → admin");
      ck.eq((await absent.rolesOf(identity({ id: "5", adminRight: "USER" }))).join(","), "", "opt-in strict : tout autre adminRight ne donne RIEN");

      // -- Fichier VALIDE : chargement + génération --
      const genBefore = absent.generation();
      fs.writeFileSync(file, JSON.stringify({ users: { jdupont: ["dc-editor"] }, roles: { nuit: ["dc.cabling:*"] } }), "utf8");
      absent.load();
      ck.eq((await absent.rolesOf(identity({ id: "jdupont", login: "jdupont" }))).join(","), "dc-editor", "fichier chargé : le rôle déclaré s'applique");
      ck.eq(absent.grantsOfRole("nuit").join(","), "dc.cabling:*", "fichier chargé : le rôle CUSTOM est exposé");
      ck.eq(absent.grantsOfRole("dc-viewer"), null, "rôle non défini localement → null (le preset partagé prendra le relais)");
      ck(absent.generation() > genBefore, "génération : incrémentée à chaque politique adoptée (clé d'invalidation du cache)");

      // -- GROUPES de l'IdP (mode forward / OIDC) : le provider les passe à la politique. Fichier
      // DÉDIÉ, pour ne pas perturber l'état de la politique éprouvée ci-dessus et ci-dessous.
      const groupsFile = path.join(dir, "groupes.json");
      fs.writeFileSync(groupsFile, JSON.stringify({ users: { jdupont: ["cert-viewer"] }, groups: { "grp-infra": ["dc-editor"] } }), "utf8");
      const byGroups = new FileRoleProvider(groupsFile, [], quiet);
      ck.eq((await byGroups.rolesOf(identity({ id: "amartin", login: "amartin", groups: ["grp-infra"] }))).join(","), "dc-editor",
        "groupes : un utilisateur ABSENT du fichier obtient le rôle de son groupe (les personnes vivent dans l'IdP)");
      ck.eq((await byGroups.rolesOf(identity({ id: "jdupont", login: "jdupont", groups: ["grp-infra"] }))).sort().join(","), "cert-viewer,dc-editor",
        "groupes : UNION avec le rôle nominatif");
      ck.eq((await byGroups.rolesOf(identity({ id: "amartin", login: "amartin", groups: ["grp-autre"] }))).join(","), "",
        "groupes : un groupe non déclaré n'accorde rien (opt-in strict)");
      ck.eq((await byGroups.rolesOf(identity({ id: "amartin", login: "amartin" }))).join(","), "",
        "groupes : identité SANS groupes (mode dev/basic/sso) → comportement inchangé");

      // -- Fichier ILLISIBLE après coup : on CONSERVE la dernière politique valide --
      const genValid = absent.generation();
      fs.writeFileSync(file, "{ ceci n'est pas du JSON", "utf8");
      absent.load();
      ck.eq((await absent.rolesOf(identity({ id: "jdupont", login: "jdupont" }))).join(","), "dc-editor",
        "JSON invalide : la DERNIÈRE politique valide reste en vigueur (une faute de frappe ne déconnecte pas l'équipe)");
      ck.eq(absent.generation(), genValid, "JSON invalide : aucune génération consommée (rien n'a changé)");

      // -- Fichier SUPPRIMÉ : état défini → on l'adopte (retour au fail-closed) --
      fs.unlinkSync(file);
      absent.load();
      ck.eq((await absent.rolesOf(identity({ id: "jdupont", login: "jdupont" }))).join(","), "",
        "fichier supprimé : politique VIDE adoptée (« aucune politique » est un état défini, contrairement à « illisible »)");
      ck(absent.generation() > genValid, "fichier supprimé : génération incrémentée (la suppression est un changement)");

      // -- PREMIER chargement raté : politique VIDE (il n'y a pas de « dernière valide ») --
      const brokenFile = path.join(dir, "casse.json");
      fs.writeFileSync(brokenFile, "<<<", "utf8");
      const broken = new FileRoleProvider(brokenFile, [], quiet);
      ck.eq((await broken.rolesOf(identity({ id: "jdupont", login: "jdupont" }))).join(","), "",
        "premier chargement raté : politique VIDE (fail-closed, jamais de repli ouvert)");

      // -- fromEnv : ROLES_FILE explicite, sinon <docsDir>/roles.json --
      const fromDefault = FileRoleProvider.fromEnv({}, dir, quiet);
      ck.eq((await fromDefault.rolesOf(identity({ id: "x" }))).join(","), "", "fromEnv : défaut <DOCS_DIR>/roles.json (absent ici → vide)");
      fs.writeFileSync(path.join(dir, "ailleurs.json"), JSON.stringify({ users: { zoe: ["vm-viewer"] } }), "utf8");
      const fromEnv = FileRoleProvider.fromEnv({ ROLES_FILE: path.join(dir, "ailleurs.json"), BOOTSTRAP_ADMIN_IDS: "root" }, dir, quiet);
      ck.eq((await fromEnv.rolesOf(identity({ id: "zoe", login: "zoe" }))).join(","), "vm-viewer", "fromEnv : ROLES_FILE explicite honoré");
      ck.eq((await fromEnv.rolesOf(identity({ login: "root" }))).join(","), "admin", "fromEnv : BOOTSTRAP_ADMIN_IDS honoré");

      // -- Veille : démarrage/arrêt idempotents et sans effet de bord. ⚠ Le RECHARGEMENT déclenché par
      // la veille elle-même n'est pas chronométré ici (sondage de 2 s : un test qui l'attend serait lent
      // et fragile) — c'est `load()`, éprouvé ci-dessus, qu'elle appelle, et rien d'autre.
      fromEnv.start(); fromEnv.start(); fromEnv.stop(); fromEnv.stop();
      ck(true, "veille : start()/stop() idempotents, sans exception");
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* nettoyage best-effort */ }
    }
  });

  /* ==========================================================================
     4. Le service de contrôle d'accès
     ========================================================================== */
  await section("Serveur : AccessControl — 401 vs 403, ensemble vide refusé, gardes TAGUÉES, collection → domaine, lot, cache", async () => {
    const { AccessControl } = SERVER("access/AccessControl.js");
    const { Logger } = SERVER("logger.js");
    const quiet = new Logger("error", "test");

    // Réponse FACTICE : le service ne connaît pas Express — il n'attend que `status().json()`.
    const mkRes = () => {
      const seen = { code: 0, body: null, sent: false };
      const res = { status(c) { seen.code = c; return res; }, json(b) { seen.body = b; seen.sent = true; return res; } };
      return { res, seen };
    };
    const run = async (guard, req) => {
      const { res, seen } = mkRes();
      let passed = false;
      await guard(req, res, () => { passed = true; });
      return { passed, code: seen.code, body: seen.body, sent: seen.sent };
    };

    // Provider de rôles BOUCHON : rôles et génération pilotés par le test.
    let roles = [], custom = {}, gen = 1;
    const provider = {
      rolesOf: async () => roles,
      grantsOfRole: (role) => custom[role] || null,
      generation: () => gen,
    };
    let session = { logged: true, adminRight: "USER", user: { id: 42, login: "jdupont" } };
    const access = new AccessControl({ session: async () => session, roles: provider, log: quiet });

    // -- Identité soumise à la politique : la clé canonique est celle de l'audit --
    const id = AccessControl.identityOf({ logged: true, adminRight: "SUPER_ADMIN", user: { id: 42, login: "jdupont" } });
    ck.eq(id.id + "/" + id.login + "/" + id.adminRight, "42/jdupont/SUPER_ADMIN", "identité : id canonique (String(id) SSO) + login + adminRight");
    ck.eq(AccessControl.identityOf({ logged: true, user: { login: "sanId" } }).id, "sanId", "identité : sans id SSO, la clé canonique est le login");

    // GROUPES : lus de la session (mode forward, passthrough SSO), et FILTRÉS ici — c'est la frontière
    // par laquelle une donnée d'annuaire non maîtrisée entre dans la politique.
    ck.eq(JSON.stringify(AccessControl.identityOf({ logged: true, user: { login: "a" }, groups: ["infra", "noc"] }).groups), '["infra","noc"]',
      "identité : les groupes de la session traversent jusqu'à la politique");
    ck.eq(JSON.stringify(AccessControl.identityOf({ logged: true, user: { login: "a" } }).groups), "[]", "identité : session sans groupes → tableau vide (jamais `undefined`)");
    ck.eq(JSON.stringify(AccessControl.identityOf({ logged: true, user: { login: "a" }, groups: "infra" }).groups), "[]", "identité : `groups` non tableau → ignoré (jamais coercé)");
    ck.eq(JSON.stringify(AccessControl.identityOf({ logged: true, user: { login: "a" }, groups: [" infra ", "", null, 42, "noc"] }).groups), '["infra","noc"]',
      "identité : groupes rognés, vides et non textuels ÉCARTÉS (un SSO peut renvoyer n'importe quoi)");

    // -- requireAuth : 401 (pas authentifié) ≠ 403 (pas autorisé) --
    session = { logged: false, adminRight: "NONE" };
    let r = await run(access.requireAuth, { params: {} });
    ck.eq(r.code, 401, "requireAuth : session absente/expirée → 401 (le client renvoie au login)");
    ck.eq(r.body.logged, false, "requireAuth : 401 — forme du corps CONSERVÉE (`logged` lu par le client)");
    ck(!r.passed, "requireAuth : 401 → la requête n'atteint pas le handler");

    session = { logged: true, adminRight: "USER", user: { id: 42, login: "jdupont" } };
    roles = [];
    r = await run(access.requireAuth, { params: {} });
    ck.eq(r.code, 403, "requireAuth : authentifié SANS aucun rôle → 403 (« authentifié ≠ autorisé », tenu en UN point)");
    ck.eq(r.body.logged, true, "requireAuth : 403 — `logged: true`, le client ne doit PAS boucler sur le login");
    ck(!r.passed, "requireAuth : ensemble vide → la requête s'arrête");

    // La session est posée sur la requête même en cas de refus (l'audit et les logs la lisent).
    const refused = { params: {} };
    await run(access.requireAuth, refused);
    ck.eq(refused.authUser && refused.authUser.logged, true, "requireAuth : `authUser` est posé sur la requête (audit, notif live)");

    roles = ["dc-viewer"];
    gen++;
    const passing = { params: {} };
    r = await run(access.requireAuth, passing);
    ck(r.passed && !r.sent, "requireAuth : ≥ 1 permission → passe sans rien écrire");
    ck(passing.authAccess && passing.authAccess.has("dc.rack:read"), "requireAuth : `authAccess` posé — les permissions effectives du rôle");

    // -- require(permission) --
    const reqOf = (over) => Object.assign({ params: {}, authUser: session, authAccess: passing.authAccess }, over || {});
    ck((await run(access.require("dc.rack:read"), reqOf())).passed, "require : permission détenue → passe");
    const denied = await run(access.require("dc.rack:update"), reqOf());
    ck.eq(denied.code, 403, "require : permission absente → 403");
    ck.eq(denied.body.permission, "dc.rack:update", "require : le 403 NOMME la permission manquante (un refus muet est indiagnostiquable)");
    ck.eq(denied.body.error, "accès refusé", "require : forme historique du corps conservée");

    // Route montée HORS de requireAuth (erreur de câblage) : rien n'est accordé.
    ck.eq((await run(access.require("dc.rack:read"), { params: {} })).code, 403, "require : sans `authAccess` (hors garde globale) → refus, jamais un laissez-passer");

    // -- requireAuthenticated : laisse passer, mais DÉCLARE l'absence de permission propre --
    ck((await run(access.requireAuthenticated, reqOf())).passed, "requireAuthenticated : passe (requireAuth a déjà exigé ≥ 1 permission)");

    // -- requireCollection : le domaine se déduit de `:collection` --
    ck((await run(access.requireCollection("read"), reqOf({ params: { collection: "ipAddresses" } }))).passed, "requireCollection : dc-viewer lit ipAddresses");
    const wrote = await run(access.requireCollection("delete"), reqOf({ params: { collection: "ipAddresses" } }));
    ck.eq(wrote.code, 403, "requireCollection : dc-viewer ne supprime pas");
    ck.eq(wrote.body.permission, "dc.ip:delete", "requireCollection : le 403 nomme la permission dérivée de la collection");
    ck((await run(access.requireCollection("delete"), reqOf({ params: { collection: "pasUneCollection" } }))).passed,
      "requireCollection : collection INCONNUE → laissée passer (le handler répondra 404 ; un 403 y serait faux)");
    ck.eq((await run(access.requireCollection("read"), reqOf({ params: { collection: "vms" } }))).code, 403,
      "requireCollection : dc-viewer ne lit PAS les VMs (domaine séparé)");

    // -- requireCollectionInBody (aperçu de cascade) --
    ck((await run(access.requireCollectionInBody("read"), reqOf({ body: { collection: "cables", ids: ["c1"] } }))).passed,
      "requireCollectionInBody : la collection racine vient du CORPS");
    ck.eq((await run(access.requireCollectionInBody("read"), reqOf({ body: { collection: "vms" } }))).code, 403,
      "requireCollectionInBody : refus sur un domaine non lisible");
    ck((await run(access.requireCollectionInBody("read"), reqOf({ body: {} }))).passed, "requireCollectionInBody : corps sans collection → 404 du handler");

    // -- requireBatch : chaque opération, AVANT toute écriture --
    roles = ["dc-editor"]; gen++;
    const editor = { params: {} };
    await run(access.requireAuth, editor);
    const batchReq = (body) => ({ params: {}, authUser: session, authAccess: editor.authAccess, body });
    ck((await run(access.requireBatch, batchReq({ creates: [{ collection: "cables" }], deletes: [{ collection: "ports" }] }))).passed,
      "requireBatch : dc-editor écrit tout le lot");
    const mixed = await run(access.requireBatch, batchReq({ creates: [{ collection: "cables" }], updates: [{ collection: "vms" }] }));
    ck.eq(mixed.code, 403, "requireBatch : UNE opération hors droits refuse TOUT le lot (atomicité du refus)");
    ck.eq(mixed.body.permission, "vm:update", "requireBatch : le 403 nomme la première permission manquante");
    ck.eq((await run(access.requireBatch, batchReq({ meta: { x: 1 } }))).passed, true, "requireBatch : dc-editor peut écrire la meta (dc.site:update)");
    ck((await run(access.requireBatch, batchReq({}))).passed, "requireBatch : lot vide → rien à exiger");

    // -- requireAnyDocRead --
    ck((await run(access.requireAnyDocRead, reqOf({ authAccess: editor.authAccess }))).passed, "requireAnyDocRead : un éditeur DC a bien une lecture documentaire");
    roles = ["cert-viewer"]; gen++;
    const certOnly = { params: {} };
    await run(access.requireAuth, certOnly);
    const noDoc = await run(access.requireAnyDocRead, { params: {}, authUser: session, authAccess: certOnly.authAccess });
    ck.eq(noDoc.code, 403, "requireAnyDocRead : un rôle purement MODULE ne lit ni le SSE ni la recherche");
    ck.eq(noDoc.body.permission, "any-doc-read", "requireAnyDocRead : le 403 porte la SENTINELLE de la règle (plusieurs permissions conviendraient)");

    // -- ÉTIQUETTES : ce qui rend le verrou d'exhaustivité possible --
    ck.eq(access.requireAuth.aclTag, "session", "étiquette : requireAuth");
    ck.eq(access.requireAuthenticated.aclTag, "authenticated", "étiquette : requireAuthenticated");
    ck.eq(access.require("certs:pki").aclTag, "certs:pki", "étiquette : require(permission) porte la permission");
    ck.eq(access.requireCollection("update").aclTag, "collection:update", "étiquette : requireCollection");
    ck.eq(access.requireCollectionInBody("read").aclTag, "body-collection:read", "étiquette : requireCollectionInBody");
    ck.eq(access.requireBatch.aclTag, "transact:batch", "étiquette : requireBatch");
    ck.eq(access.requireAnyDocRead.aclTag, "any-doc-read", "étiquette : requireAnyDocRead");

    // -- Rôle CUSTOM, priorité sur le preset, rôle inconnu --
    roles = ["nuit"]; custom = { nuit: ["dc.cabling:*"] }; gen++;
    let set = await access.setFor(session);
    ck(set.has("dc.cabling:delete") && !set.has("dc.equipment:read"), "rôle custom : ses grants s'appliquent");
    roles = ["dc-viewer"]; custom = { "dc-viewer": ["dc.ip:read"] }; gen++;
    set = await access.setFor(session);
    ck(set.has("dc.ip:read") && !set.has("dc.rack:read"), "rôle custom : une définition locale MASQUE le preset du même nom (le fichier fait autorité)");
    roles = ["role-fantome"]; custom = {}; gen++;
    ck((await access.setFor(session)).isEmpty(), "rôle inconnu : ignoré → ensemble vide (jamais un laissez-passer)");

    // -- Cache invalidé par la GÉNÉRATION (sans quoi un rechargement à chaud resterait sans effet) --
    roles = ["dc-viewer"]; gen++;
    ck((await access.setFor(session)).has("dc.rack:read"), "cache : première résolution");
    roles = ["cert-viewer"];   // la politique change SANS changer de génération → le cache fait foi
    ck((await access.setFor(session)).has("dc.rack:read"), "cache : à génération INCHANGÉE, l'ensemble mémoïsé est réutilisé");
    gen++;                     // rechargement à chaud
    const reloaded = await access.setFor(session);
    ck(!reloaded.has("dc.rack:read") && reloaded.has("certs:read"), "cache : le changement de GÉNÉRATION invalide la mémoïsation (rechargement à chaud effectif)");

    /* -- 🚨 CACHE et GROUPES : la clé DOIT les intégrer -----------------------------------------
       Deux requêtes du MÊME login avec des groupes DIFFÉRENTS n'ont pas les mêmes rôles. Si la clé
       de mémoïsation ignorait les groupes, la première réponse figerait les droits de la seconde —
       dans un sens (escalade) comme dans l'autre (perte d'accès). Le provider bouchon ci-dessous
       répond en fonction des GROUPES de l'identité reçue, à génération CONSTANTE : sans les groupes
       dans la clé, le second appel rendrait l'ensemble du premier. */
    const byGroup = { "grp-infra": ["dc-editor"], "grp-noc": ["vm-viewer"] };
    const groupAware = new AccessControl({
      session: async () => session,
      roles: { rolesOf: async (identity) => identity.groups.flatMap((g) => byGroup[g] || []), generation: () => 7 },
      log: quiet,
    });
    const sessionOf = (groups) => ({ logged: true, adminRight: "USER", user: { id: 42, login: "jdupont" }, groups });
    const infraSet = await groupAware.setFor(sessionOf(["grp-infra"]));
    ck(infraSet.has("dc.rack:update") && !infraSet.has("vm:read"), "cache/groupes : premier appel — les rôles du groupe `grp-infra`");
    const nocSet = await groupAware.setFor(sessionOf(["grp-noc"]));
    ck(nocSet.has("vm:read") && !nocSet.has("dc.rack:update"),
      "🚨 cache/groupes : MÊME login, groupes DIFFÉRENTS → ensemble RECALCULÉ (la clé intègre les groupes)");
    const noGroupSet = await groupAware.setFor(sessionOf([]));
    ck(noGroupSet.isEmpty(), "cache/groupes : le même login SANS groupe n'hérite d'aucune entrée précédente");
    ck((await groupAware.setFor(sessionOf(["grp-infra"]))).has("dc.rack:update"), "cache/groupes : retour aux groupes d'origine → ensemble d'origine");
    // L'ORDRE des groupes n'a aucune signification pour la politique : deux ordres du même ensemble
    // doivent PARTAGER l'entrée de cache (les groupes sont triés dans la clé), pas la dupliquer.
    let calls = 0;
    const counting = new AccessControl({
      session: async () => session,
      roles: { rolesOf: async () => { calls++; return ["dc-viewer"]; }, generation: () => 3 },
      log: quiet,
    });
    await counting.setFor(sessionOf(["a", "b"]));
    await counting.setFor(sessionOf(["b", "a"]));
    ck.eq(calls, 1, "cache/groupes : l'ORDRE des groupes ne crée pas une seconde entrée (clé triée)");

    // -- Session non authentifiée : rien à calculer --
    ck((await access.setFor({ logged: false })).isEmpty(), "setFor : session non authentifiée → ensemble vide");

    // -- Provider en PANNE : fail-closed, jamais de repli ouvert --
    const broken = new AccessControl({ session: async () => session, roles: { rolesOf: async () => { throw new Error("annuaire injoignable"); } }, log: quiet });
    ck((await broken.setFor(session)).isEmpty(), "fail-closed : une politique en échec n'accorde RIEN (une panne ne doit pas devenir une escalade)");
  });

  /* ==========================================================================
     5. Le verrou d'exhaustivité
     ========================================================================== */
  await section("Serveur : EXHAUSTIVITÉ des gardes — aucune route terminale sans garde taguée (verrou sur les SOURCES)", async () => {
    /* POURQUOI un verrou, et POURQUOI sur les sources.

       « Toute route porte une garde » est une convention, et une convention non tenue par une
       machine finit toujours par ne plus être tenue : la route ajoutée un vendredi hérite alors du
       seul filet global (« ≥ 1 permission »), c'est-à-dire d'à peu près aucun contrôle. Ce verrou
       relit donc les DÉCLARATIONS de routes et échoue en NOMMANT celles qui n'en portent pas.

       MÉCANISME CHOISI : analyse statique des SOURCES par le parseur TypeScript, comme le verrou
       d'isolement de `src-shared/` (même philosophie, même outil). La voie « monter l'Api avec des
       bouchons et parcourir `router.stack` » a été ÉCARTÉE sur constat, pas par préférence : le
       programme de test du dépôt ne résout ni `multer` (absent à la racine) ni la MÊME version
       d'Express que le serveur (5.x à la racine, 4.x côté serveur) — `api.ts` et les `*Module.ts`
       n'y sont donc pas chargeables, et ils sont précisément ce qu'il faut inspecter. Une variante
       « registre + manifeste écrit à la main » aurait le défaut fatal d'être aveugle au cas visé :
       une route oubliée manquerait AUSSI au manifeste. Ici, la liste des routes est DÉCOUVERTE,
       jamais déclarée.

       PORTÉE : `api.ts` et les routeurs des modules. `server.ts` est hors champ — il ne monte que
       des routes délibérément publiques (`/healthz`, le HTML du client et ses assets), dont
       l'accès est gardé, le cas échéant, par le challenge Basic global. */
    const fs = require("fs");
    const ts = require("typescript");
    const serverSrc = path.join(__dirname, "..", "..", "src-server", "src");

    /** Verbes HTTP d'Express — la forme `<routeur>.<verbe>("/chemin", …)` est LA déclaration de route. */
    const HTTP_METHODS = new Set(["get", "post", "put", "delete", "patch", "options", "head", "all"]);

    /** Déclarations de routes d'une source TS → [{ method, path, line, guarded, permissions }].
        Détection volontairement SYNTAXIQUE : premier argument = littéral de chaîne commençant par
        « / ». C'est ce qui distingue `router.get("/status", …)` d'un `this.docs.get(docId)`. */
    const routesOf = (text, fileName) => {
      const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
      const found = [];
      const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          const first = node.arguments[0];
          if (HTTP_METHODS.has(method) && first && ts.isStringLiteralLike(first) && first.text.startsWith("/")) {
            // Une GARDE se reconnaît à son porteur : `this.access.…` — au cœur comme dans les
            // modules (où `access` est l'objet INJECTÉ). Un seul idiome, donc un seul détecteur.
            const args = node.arguments.slice(1).map((a) => a.getText(sf));
            const permissions = [];
            for (const arg of args) {
              const m = /^this\.access\.require\(\s*"([^"]+)"\s*\)$/.exec(arg);
              if (m) permissions.push(m[1]);
            }
            found.push({
              method: method.toUpperCase(),
              path: first.text,
              line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
              guarded: args.some((a) => a.startsWith("this.access.")),
              permissions,
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return found;
    };

    // -- CONTRÔLE DE DISCRIMINATION : le détecteur voit-il VRAIMENT ce qu'il prétend voir ?
    // Sans lui, le verrou passerait au vert en ne détectant RIEN — le pire des états.
    {
      const sonde = [
        'router.get("/gardee", this.access.require("vm:read"), (req, res) => { res.json({}); });',
        'router.post("/nue", (req, res) => { res.json({}); });',
        'data.get("/:collection", this.access.requireCollection("read"), this.list);',
        'const doc = this.docs.get(docId);',
        'res.status(404).json({ error: "x" });',
        '// router.get("/en-commentaire", handler);',
      ].join("\n");
      const vues = routesOf(sonde, "sonde.ts");
      ck.eq(vues.length, 3, "détecteur : 3 déclarations de routes vues (ni le `docs.get`, ni le `.json`, ni le commentaire)");
      ck.eq(vues.filter((r) => r.guarded).map((r) => r.method + " " + r.path).join(", "), "GET /gardee, GET /:collection", "détecteur : les routes GARDÉES sont reconnues");
      ck.eq(vues.filter((r) => !r.guarded).map((r) => r.method + " " + r.path).join(", "), "POST /nue", "détecteur : la route NUE est repérée");
      ck.eq(vues[0].permissions.join(","), "vm:read", "détecteur : la permission littérale est extraite (contrôle du catalogue)");
    }

    // -- Le VERROU, sur les sources RÉELLES --
    const ROUTERS = [
      "api.ts",
      "vm/VmModule.ts", "wifi/WifiModule.ts", "tracker/TrackerModule.ts",
      "certs/CertsModule.ts", "interventions/InterventionsModule.ts", "notify/NotifyModule.ts",
    ];
    /** LISTE BLANCHE — les routes délibérément SANS garde, chacune justifiée.
        `GET /me` est montée AVANT la garde globale : un utilisateur sans aucun droit doit pouvoir
        apprendre qu'il n'en a aucun (écran « aucun accès »), sinon il ne verrait qu'un 403 nu. */
    const WHITELIST = new Set(["api.ts GET /me"]);

    const { Permissions } = SHARED("src-shared/Permissions.js");
    const nues = [];
    const inconnues = [];
    let total = 0;
    for (const relative of ROUTERS) {
      const file = path.join(serverSrc, relative);
      const source = fs.readFileSync(file, "utf8");
      for (const route of routesOf(source, relative)) {
        total++;
        const label = relative + " " + route.method + " " + route.path;
        if (!route.guarded && !WHITELIST.has(label)) nues.push(label + " (ligne " + route.line + ")");
        for (const permission of route.permissions) {
          if (!Permissions.isKnown(permission)) inconnues.push(label + " → « " + permission + " » (ligne " + route.line + ")");
        }
      }
    }
    // Anti-vacuité : le verrou doit avoir VU les routeurs, sinon il « passerait » sur du vide.
    ck(total >= 70, "verrou : les routeurs sont bien lus — " + total + " déclarations de routes trouvées");
    ck.eq(nues.join("  |  "), "", "verrou : AUCUNE route terminale sans garde taguée (liste blanche : GET /me)");
    ck.eq(inconnues.join("  |  "), "", "verrou : toute permission littérale d'une garde appartient au catalogue partagé (anti-coquille)");
    // La liste blanche doit rester JUSTE : une entrée périmée masquerait une vraie route nue.
    const labels = new Set();
    for (const relative of ROUTERS) {
      for (const route of routesOf(fs.readFileSync(path.join(serverSrc, relative), "utf8"), relative)) labels.add(relative + " " + route.method + " " + route.path);
    }
    ck.eq([...WHITELIST].filter((w) => !labels.has(w)).join(", "), "", "verrou : la liste blanche ne contient aucune entrée PÉRIMÉE");
  });
};
