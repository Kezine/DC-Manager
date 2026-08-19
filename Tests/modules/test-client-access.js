/* Tests modules — AUTORISATION CÔTÉ CLIENT (lot 2 du chantier auth/ACL).

   Le lot 1 a posé le modèle PARTAGÉ et les gardes serveur (cf. test-access.js). Ce fichier
   couvre ce que le CLIENT en fait — c'est-à-dire ANTICIPER : ne pas proposer un geste que
   le serveur refusera, sans jamais réécrire la politique.

   Quatre sections :
   1. `core/AccessState` — les trois états (ALL / NONE / grants), et surtout la DÉLÉGATION :
      aucune règle propre, tout passe par `PermissionSet.has` et la carte partagée. On y
      vérifie aussi l'invariant du mode FICHIER (« tout permis par construction »), qui est
      la garantie que rien ne bouge sans serveur ;
   2. `core/ViewAccess` — la carte des vues NON-listing → permission de lecture : valeurs
      dans le catalogue partagé (anti-coquille), et pas d'entrée fantôme ;
   3. `core/AccessDenial` — anti-rafale des 403 : fenêtre de silence PAR permission, et sa
      différence de nature avec le verrou terminal du 401 (`SessionExpiry`) ;
   4. VERROU « aucune vue du shell sans gating » — relit les SOURCES de `app/main.ts` et
      échoue en NOMMANT toute vue déclarée qui n'est ni un listing (gaté par dérivation
      depuis sa collection) ni présente dans `ViewAccess`. Même philosophie et même outil
      (le parseur TypeScript) que le verrou d'exhaustivité des routes serveur : la liste est
      DÉCOUVERTE, jamais déclarée — un manifeste écrit à la main serait aveugle au cas visé.

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SharedSchema } = require("./harness.js");

module.exports = async () => {

  /* ==========================================================================
     1. core/AccessState — vocabulaire du client, ZÉRO règle propre
     ========================================================================== */
  await section("client : AccessState — ALL/NONE/grants, délégation à la carte PARTAGÉE, injection nulle du mode fichier", async () => {
    const { AccessState } = D("core/AccessState.js");
    const { Permissions } = SHARED("src-shared/Permissions.js");

    // -- MODE FICHIER / VISUALISEUR : « tout permis » PAR CONSTRUCTION. C'est l'invariant central du lot :
    // chaque garde d'interface interroge cet état, et il répond oui à TOUT — donc aucune garde ne peut
    // changer quoi que ce soit sans serveur (patron d'injection nulle de HydrationState).
    const all = AccessState.ALL;
    ck(!all.isEmpty(), "ALL : n'est pas vide");
    ck(all.hasAnyDocumentRead(), "ALL : au moins une lecture documentaire");
    const refusedByAll = [...SharedSchema.COLLECTIONS].filter((c) =>
      !(all.canReadCollection(c) && all.canCreateCollection(c) && all.canUpdateCollection(c) && all.canDeleteCollection(c) && all.canWriteCollection(c)));
    ck.eq(refusedByAll.join(","), "", "ALL : les 4 verbes sont permis sur TOUTES les collections du schéma (injection nulle)");
    const refusedMeta = [...Permissions.META_PERMISSIONS, ...Permissions.MODULE_PERMISSIONS].filter((p) => !all.has(p));
    ck.eq(refusedMeta.join(","), "", "ALL : tout le catalogue méta + modules est permis");

    // -- NONE : l'état d'AVANT le bootstrap, et celui d'un utilisateur authentifié sans aucun rôle.
    const none = AccessState.NONE;
    ck(none.isEmpty(), "NONE : vide (c'est LUI qui déclenche l'écran « aucun accès »)");
    ck(!none.hasAnyDocumentRead(), "NONE : aucune lecture documentaire");
    ck(!none.canReadCollection("equipments"), "NONE : aucune lecture de collection");
    ck(!none.has("documents:manage"), "NONE : aucune permission méta");

    // -- fromGrants : la reconstruction depuis `/me`.permissions, jokers COMPRIS. Le matching n'est PAS
    // réimplémenté ici — on vérifie qu'il est bien celui du modèle partagé (mêmes réponses que PermissionSet).
    const viewer = AccessState.fromGrants(["dc.*:read"]);
    ck(viewer.canReadCollection("equipments"), "dc.*:read → lecture des équipements");
    ck(viewer.canReadCollection("ipAddresses"), "dc.*:read → lecture de l'IPAM (sous-domaine)");
    ck(!viewer.canUpdateCollection("equipments"), "dc.*:read → AUCUNE écriture");
    ck(!viewer.canWriteCollection("cables"), "dc.*:read → canWriteCollection faux (aucun des 3 verbes)");
    ck(!viewer.canReadCollection("vms"), "dc.*:read → PAS les VMs (domaine `vm`, hors `dc.*`)");
    ck(!viewer.canReadCollection("wifiClients"), "dc.*:read → PAS le wifi");
    ck(viewer.hasAnyDocumentRead(), "dc.*:read → au moins une lecture documentaire (recherche Ctrl+K visible)");

    const connector = AccessState.fromGrants(["dc.cabling:*", "dc.equipment:read", "dc.rack:read", "dc.site:read"]);
    ck(connector.canCreateCollection("cables"), "dc-connector : crée des câbles");
    ck(connector.canDeleteCollection("waypoints"), "dc-connector : supprime des waypoints (même domaine)");
    ck(!connector.canCreateCollection("equipments"), "dc-connector : ne crée PAS d'équipement");
    ck(connector.canReadCollection("racks"), "dc-connector : lit les baies");
    ck(!connector.canUpdateCollection("racks"), "dc-connector : ne modifie PAS les baies");

    // -- Le domaine vient de la CARTE PARTAGÉE, pas d'une table locale : on le prouve en confrontant
    // `canReadCollection` à la carte pour CHAQUE collection du schéma, avec un grant ciblé sur UN domaine.
    const domain = Permissions.COLLECTION_DOMAINS.cables;
    const oneDomain = AccessState.fromGrants([domain + ":read"]);
    const divergent = [...SharedSchema.COLLECTIONS].filter((c) =>
      oneDomain.canReadCollection(c) !== (Permissions.COLLECTION_DOMAINS[c] === domain));
    ck.eq(divergent.join(","), "", "canReadCollection suit EXACTEMENT la carte partagée pour les " + SharedSchema.COLLECTIONS.length + " collections");

    // -- Collection INCONNUE : refus. Mieux vaut masquer un geste que d'en proposer un qui échouera —
    // et une collection hors carte est de toute façon un 404 côté serveur.
    ck(!all.canReadCollection("collectionQuiNexistePas"), "collection hors carte : refus, même avec ALL");
    ck(!all.canOnCollection("", "read"), "collection vide : refus");

    // -- Grants malformés / absents : fail-closed, jamais « au mieux ».
    ck(AccessState.fromGrants(null).isEmpty(), "fromGrants(null) : ensemble vide");
    ck(AccessState.fromGrants(undefined).isEmpty(), "fromGrants(undefined) : ensemble vide (réponse /me d'un serveur ancien)");
    ck(AccessState.fromGrants(["", "  ", ":", "a:b:c"]).isEmpty(), "fromGrants : grants malformés ignorés → vide");
    ck(!AccessState.fromGrants(["dc.*:read"]).has("dc.*:read"), "une VÉRIFICATION à joker est toujours refusée (délégué à PermissionSet)");

    // -- `can(domaine, action)` et ses quatre raccourcis composent bien la permission atomique.
    const site = AccessState.fromGrants(["dc.site:update"]);
    ck(site.canUpdate("dc.site"), "canUpdate(domaine) → dc.site:update");
    ck(!site.canRead("dc.site"), "canRead(domaine) : `update` ne donne pas `read` (aucune hiérarchie de verbes)");
    ck(site.can("dc.site", "update"), "can(domaine, action) : forme générique");

    // -- IMMUTABILITÉ : deux appels rendent le même objet, et l'état ne se mute pas (un changement de
    // droits REMPLACE l'instance — c'est ce qui rend le gating relisible sans effet de bord).
    ck(AccessState.ALL === AccessState.ALL, "ALL est un singleton (objet-valeur)");
    ck(AccessState.fromGrants(["*"]) !== AccessState.ALL, "fromGrants rend une NOUVELLE instance (jamais le singleton)");
    ck(AccessState.fromGrants(["*"]).canDeleteCollection("racks"), "fromGrants([\"*\"]) équivaut fonctionnellement à ALL");
    ck.eq(AccessState.fromGrants(["b:read", "a:read", "b:read"]).grants().join(","), "a:read,b:read", "grants() : dédoublonnés et triés (ordre stable)");

    // -- documentAccessSummary : résumé SOBRE des droits pour la modale d'infos utilisateur (décision PURE).
    // « accès complet » = TOUTE la donnée lisible ; sinon la liste des DOMAINES lisibles, ordre de la carte.
    const sAll = all.documentAccessSummary();
    ck(sAll.full && sAll.domains.length === 0, "summary(ALL) : accès complet (aucun domaine listé)");
    const sNone = none.documentAccessSummary();
    ck(!sNone.full && sNone.domains.length === 0, "summary(NONE) : ni complet ni aucun domaine (écran « aucun accès »)");
    const sStar = AccessState.fromGrants(["*"]).documentAccessSummary();
    ck(sStar.full, "summary(*) : accès complet (équivaut à ALL)");
    const sViewer = viewer.documentAccessSummary();   // dc.*:read → tous les domaines DC, mais PAS vm/wifi
    ck(!sViewer.full, "summary(dc.*:read) : PAS complet (vm/wifi manquent)");
    ck(sViewer.domains.includes("dc.equipment") && sViewer.domains.includes("dc.ip"), "summary(dc.*:read) : liste les domaines DC lisibles");
    ck(!sViewer.domains.includes("vm") && !sViewer.domains.includes("wifi"), "summary(dc.*:read) : n'inclut ni vm ni wifi");
    // ordre = celui de la carte partagée (DATA_DOMAINS), et UNIQUEMENT des domaines lisibles.
    const expectedViewerDomains = Permissions.DATA_DOMAINS.filter((d) => viewer.has(d + ":read"));
    ck.eq(sViewer.domains.join(","), expectedViewerDomains.join(","), "summary : domaines dans l'ordre de la carte, filtrés sur la lecture");
    const sOne = AccessState.fromGrants(["vm:read"]).documentAccessSummary();
    ck.eq(sOne.domains.join(","), "vm", "summary(vm:read) : un seul domaine (module) listé");
  });

  await section("client : UserIdentity — nom affichable coalescé (règle UNIQUE, pastille ≡ modale d'infos)", async () => {
    const { UserIdentity } = D("core/UserIdentity.js");
    ck.eq(UserIdentity.displayName(null, "??"), "??", "null → repli (aucune session)");
    ck.eq(UserIdentity.displayName({}, "??"), "??", "objet vide → repli");
    ck.eq(UserIdentity.displayName({ name: "Ada Lovelace", login: "ada" }, "??"), "Ada Lovelace", "name explicite prioritaire");
    ck.eq(UserIdentity.displayName({ prenom: "Ada", nom: "Lovelace" }, "??"), "Ada Lovelace", "prénom + nom composés");
    ck.eq(UserIdentity.displayName({ nom: "Lovelace" }, "??"), "Lovelace", "nom seul (prénom absent, pas d'espace parasite)");
    ck.eq(UserIdentity.displayName({ login: "ada" }, "??"), "ada", "login à défaut de nom");
    ck.eq(UserIdentity.displayName({ eMail: "ada@x.io" }, "??"), "ada@x.io", "e-mail (eMail) à défaut de login");
    ck.eq(UserIdentity.displayName({ email: "ada@x.io" }, "??"), "ada@x.io", "e-mail (email) accepté aussi");
  });

  /* ==========================================================================
     2. core/ViewAccess — la carte des vues NON-listing
     ========================================================================== */
  await section("client : ViewAccess — permissions de lecture des vues non-listing (catalogue, dérivation des listings)", async () => {
    const { ViewAccess } = D("core/ViewAccess.js");
    const { Permissions } = SHARED("src-shared/Permissions.js");

    const entries = Object.entries(ViewAccess.VIEW_PERMISSIONS);
    ck(entries.length >= 7, "carte : " + entries.length + " vues non-listing déclarées (anti-vacuité)");
    // ANTI-COQUILLE : une permission hors catalogue ne matcherait RIEN — la vue serait masquée pour tout
    // le monde, en silence. C'est exactement le contrôle que le verrou serveur fait sur ses gardes.
    const inconnues = entries.filter(([, p]) => !Permissions.isKnown(p)).map(([v, p]) => v + " → " + p);
    ck.eq(inconnues.join(", "), "", "carte : toute permission nommée appartient au catalogue partagé");
    const jokers = entries.filter(([, p]) => p.includes("*")).map(([v]) => v);
    ck.eq(jokers.join(", "), "", "carte : aucune permission à JOKER (un check est atomique par contrat)");

    ck.eq(ViewAccess.readPermissionOf("datacenter"), "dc.site:read", "datacenter → dc.site:read");
    ck.eq(ViewAccess.readPermissionOf("certificats"), "certs:read", "certificats → certs:read");
    ck.eq(ViewAccess.readPermissionOf("equipements"), null, "un LISTING n'est PAS dans la carte (sa permission se dérive de sa collection)");
    ck.eq(ViewAccess.readPermissionOf(""), null, "nom vide → null");

    // La dérivation des listings passe par la carte PARTAGÉE, jamais par une table locale.
    ck.eq(ViewAccess.readPermissionOfCollection("cables"), "dc.cabling:read", "listing câbles → dc.cabling:read (carte partagée)");
    ck.eq(ViewAccess.readPermissionOfCollection("wifiClients"), "wifi:read", "listing wifi → wifi:read");
    ck.eq(ViewAccess.readPermissionOfCollection("pasUneCollection"), null, "collection inconnue → null");
  });

  /* ==========================================================================
     3. core/AccessDenial — anti-rafale des 403
     ========================================================================== */
  await section("client : AccessDenial — fenêtre de silence PAR permission (403 ≠ verrou terminal du 401)", async () => {
    const { AccessDenial } = D("core/AccessDenial.js");
    const W = AccessDenial.DEDUP_WINDOW_MS;
    ck(W > 0, "fenêtre de déduplication définie (" + W + " ms)");

    const d = new AccessDenial();
    ck(d.accept("dc.ip:update", 1000), "1er refus : notifié");
    ck(!d.accept("dc.ip:update", 1000 + W - 1), "rafale sur la MÊME permission : silencieuse");
    ck(d.accept("dc.ip:create", 1000 + 1), "une AUTRE permission reste notifiée (le silence est par permission)");
    ck(d.accept("dc.ip:update", 1000 + W), "après la fenêtre : re-notifié (le 403 est un événement RÉPÉTABLE)");

    // Corps de 403 sans champ `permission` : la clé vide se déduplique comme les autres.
    const e = new AccessDenial();
    ck(e.accept(null, 0), "refus sans permission nommée : notifié");
    ck(!e.accept(undefined, 10), "…puis dédupliqué comme n'importe quelle clé");
    ck(!e.accept("", 20), "…et la chaîne vide est la MÊME clé (normalisation)");
    ck(e.accept("  x:read  ", 30), "clé normalisée (espaces rognés) et distincte");
    ck(!e.accept("x:read", 40), "…la version rognée retombe bien sur la même clé");

    e.reset();
    ck(e.accept("x:read", 41), "reset() : tout refus redevient notifiable immédiatement");
  });

  /* ==========================================================================
     4. VERROU — aucune vue du shell sans gating
     ========================================================================== */
  await section("client : VERROU — toute vue déclarée dans main.ts est gatée (analyse des SOURCES)", async () => {
    /* POURQUOI CE VERROU. Le gating des onglets de LISTE est automatique : `addListTab` dérive la
       permission de `ListOptions.collection` par la carte partagée, il n'y a rien à tenir en phase.
       Les vues CUSTOM, elles, sont déclarées à la main par `shell.addView({ name: "…" })` — et une vue
       ajoutée sans entrée dans `ViewAccess` resterait OUVERTE à tout le monde, silencieusement. C'est
       précisément ce que ce verrou refuse.

       COMMENT ON DISTINGUE LES DEUX. L'appel `shell.addView` interne à `addListTab` passe son nom en
       PROPRIÉTÉ RACCOURCIE (`name,`), parce qu'il vient d'un paramètre ; les vues custom, elles,
       écrivent un LITTÉRAL (`name: "datacenter"`). On ne collecte donc que les littéraux — la
       distinction est structurelle, pas une liste d'exceptions à maintenir. */
    const fs = require("fs");
    const ts = require("typescript");
    const { ViewAccess } = D("core/ViewAccess.js");

    /** Vues/groupes déclarés dans une source : `shell.addView({ name: "x", kind: "…" })` / `shell.addGroup({…})`. */
    const declaredViews = (text, fileName) => {
      const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
      const found = [];
      const literalProp = (obj, key) => {
        for (const p of obj.properties) {
          if (!ts.isPropertyAssignment(p) || !p.name || p.name.getText(sf) !== key) continue;
          return ts.isStringLiteralLike(p.initializer) ? p.initializer.text : null;
        }
        return null;
      };
      const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          const arg = node.arguments[0];
          if ((method === "addView" || method === "addGroup") && arg && ts.isObjectLiteralExpression(arg)) {
            const name = literalProp(arg, "name");
            if (name) found.push({ name, kind: literalProp(arg, "kind"), gated: !!literalProp(arg, "visible") || arg.properties.some((p) => ts.isPropertyAssignment(p) && p.name && p.name.getText(sf) === "visible"), line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return found;
    };

    // -- CONTRÔLE DE DISCRIMINATION : le détecteur voit-il VRAIMENT ce qu'il prétend voir ? Sans lui, le
    // verrou passerait au vert en ne détectant RIEN — le pire des états.
    {
      const sonde = [
        'const c = shell.addView({ name: "custom", kind: "primary", visible: () => true, onShow: () => {} });',
        'shell.addView({ name: "nue", kind: "secondary" });',
        'shell.addGroup({ name: "grp", kind: "group", children: ["a"] });',
        'const x = shell.addView({ name, label, kind: opts.kind || "primary" });',   // ← l'appel interne d'addListTab
        'const y = map.addView({ name: "autre-objet" });',
        '// shell.addView({ name: "en-commentaire" });',
      ].join("\n");
      const vues = declaredViews(sonde, "sonde.ts");
      ck.eq(vues.map((v) => v.name).join(","), "custom,nue,grp,autre-objet",
        "détecteur : les noms LITTÉRAUX sont vus (ni la propriété raccourcie d'addListTab, ni le commentaire)");
      ck.eq(vues.filter((v) => v.gated).map((v) => v.name).join(","), "custom", "détecteur : le prédicat `visible` est reconnu");
      ck.eq(vues.filter((v) => v.kind === "group").map((v) => v.name).join(","), "grp", "détecteur : un GROUPE est reconnu comme tel");
    }

    // -- Le VERROU, sur la source RÉELLE --
    const mainTs = path.join(__dirname, "..", "..", "src-client", "app", "main.ts");
    const vues = declaredViews(fs.readFileSync(mainTs, "utf8"), "app/main.ts");
    ck(vues.length >= 7, "verrou : la source est bien lue — " + vues.length + " vues/groupes déclarés avec un nom littéral");

    // Un GROUPE ne se gate pas lui-même : le Shell le masque quand AUCUN de ses enfants n'est visible
    // (un groupe vide n'est pas une navigation). Il est donc hors périmètre du verrou.
    const custom = vues.filter((v) => v.kind !== "group");
    const sansCarte = custom.filter((v) => !ViewAccess.readPermissionOf(v.name)).map((v) => v.name + " (ligne " + v.line + ")");
    ck.eq(sansCarte.join("  |  "), "", "verrou : toute vue CUSTOM a une permission de lecture dans ViewAccess.VIEW_PERMISSIONS");
    const sansPredicat = custom.filter((v) => !v.gated).map((v) => v.name + " (ligne " + v.line + ")");
    ck.eq(sansPredicat.join("  |  "), "", "verrou : toute vue CUSTOM porte un prédicat `visible` (sinon la carte resterait lettre morte)");

    // La carte doit rester JUSTE : une entrée PÉRIMÉE (vue supprimée ou renommée) masquerait le vrai trou.
    const declares = new Set(vues.map((v) => v.name));
    const perimees = Object.keys(ViewAccess.VIEW_PERMISSIONS).filter((v) => !declares.has(v));
    ck.eq(perimees.join(", "), "", "verrou : aucune entrée PÉRIMÉE dans ViewAccess (vue disparue de main.ts)");
  });
};
