/* Tests modules — FEATURE « REMOTE ISSUE TRACKER » (collection partagée `issues`, lot L1).
   ----------------------------------------------------------------------------
   Le lot L1 est le SOCLE DE DONNÉES : zéro réseau, zéro module serveur, zéro UI. Ce fichier
   couvre donc, du plus pur au plus intégré :
   1. la FRONTIÈRE source/locaux partagée (`src-shared/IssueSync`) et sa DÉLÉGATION par le
      modèle client — c'est LE verrou anti-faux-delta : deux normalisations divergentes feraient
      trouver un écart à CHAQUE passe et réécrire le document en boucle ;
   2. les CLÉS DE CIBLE composées (`src-shared/IssueTargets`) et leur convergence de vocabulaire
      avec `core/TargetSearch` / les interventions — vérifiée par test, JAMAIS par un import
      (décision D10 : les deux modules restent amovibles indépendamment) ;
   3. la SPEC de la collection (enum FERMÉE `status_category`, forme des `targets`) et la
      collection dans les mécaniques transverses (ordre des collections, RenderImpact) ;
   4. la CASCADE des `targets` — dont le cas qui a déjà mordu ailleurs : un LOT (ou une RÉCURSION)
      qui supprime DEUX cibles du MÊME ticket ;
   5. la RECHERCHE : catalogues « introuvable » et CATÉGORIE d'état, fr+en, verrouillés sur les
      locales client, et la limite ASSUMÉE (aucun dérivé par cible) ;
   6. `core/IssueStatus` : catégories, priorité de l'introuvable, clé de tri, libellés.

   Le lot L2 ajoute le module serveur AMOVIBLE `issues/` — contrats, adaptateur Jira Cloud et
   configuration chiffrée. Toujours du plus pur au plus intégré :
   7. `JiraParse.toAdf` — le format de description de l'API v3 (piège n°1 de la création) ;
   8. le DÉCODAGE Jira PUR : formes pleines/creuses/inattendues, alias, catégorie d'état, et les
      DEUX pièges du cadrage — `ext_id` = l'id INTERNE (jamais la clé, qui bouge) et `url` COMPOSÉE
      vers l'interface (jamais le champ `self`, qui pointe l'API) ;
   9. la PAGINATION pure (chaque garde-fou séparément, DEUX formes d'API) + JQL + références saisies ;
  10. l'ORCHESTRATION de l'adaptateur sur stub HTTP STRUCTUREL : `resolve` par LOTS et le partage
      found/missing, `lookup`, `createIssue` (dont l'échec Jira au message INTACT), `test` ;
  11. le CLIENT HTTP : parties pures (Basic, `Retry-After`, extraction du message d'erreur) et flux
      réel sur `fetch` INJECTÉ — 429 avec backoff borné, cap de réponse, erreurs traduites ;
  12. la VALIDATION d'un provider — champs communs + branche d'options PAR MARQUE ;
  13. le STOCKAGE chiffré (better-sqlite3 RÉEL) : CRUD sans fuite de jeton, compte RELU, sentinelle ;
  14. les INVARIANTS : pivot serveur ≡ `ISSUE_SOURCE_FIELDS`, et AGNOSTICISME de marque (aucun
      littéral « jira » hors des points d'extension) — l'exigence n°1 du chantier, donc TESTÉE.
   Harnais et assertions : harness.js. Cadrage : .notes/toDos/remote-issue-tracker-jira-cadrage-2026-08-06.md. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, Validation, Cascade, SharedSchema, EntityRegistry, COLLECTION_THREE_IMPACT } = require("./harness.js");

module.exports = async () => {
  const { IssueSync, ISSUE_SOURCE_FIELDS, ISSUE_STATUS_CATEGORIES } = SHARED("src-shared/IssueSync.js");
  const { IssueTargets, ISSUE_TARGET_KINDS } = SHARED("src-shared/IssueTargets.js");
  const { SearchTerms, SEARCH_CATALOGS } = SHARED("src-shared/SearchTerms.js");
  const { Issue } = D("models/Issue.js");
  const { IssueStatus } = D("core/IssueStatus.js");

  /* ============ PARTAGÉ : frontière SOURCE / LOCAUX ============ */

  await section("shared : IssueSync — frontière source/locaux (défauts, catégorie clampée, étiquettes déterministes, délégation du modèle)", async () => {
  {
    // -- DÉFAUTS : ce sont EXACTEMENT ceux de la spec `issues` (un écart ferait diverger le
    //    document et le diff de synchro). Non-nullables → "", nullables → null, jamais l'inverse. --
    const empty = IssueSync.normalizeSource({});
    ck.eq(ISSUE_SOURCE_FIELDS.length, 17, "ISSUE_SOURCE_FIELDS : 17 champs source déclarés");
    ck(ISSUE_SOURCE_FIELDS.every((f) => f in empty), "normalizeSource : produit TOUS les champs de la liste canonique");
    ck(["ext_id", "provider_id", "key", "summary", "status", "issue_type", "last_sync"].every((f) => empty[f] === ""),
      "normalizeSource : champs texte non nullables absents → \"\" (aucun null silencieux)");
    ck(["priority", "assignee", "reporter", "resolution", "created_src", "updated_src", "url"].every((f) => empty[f] === null),
      "normalizeSource : champs NULLABLES absents → null (« non renseigné » ≠ « renseigné à vide »)");
    ck.eq(JSON.stringify(empty.labels), "[]", "normalizeSource : labels absents → []");
    ck.eq(empty.orphan, false, "normalizeSource : orphan absent → false");
    ck.eq(empty.status_category, "unknown", "normalizeSource : catégorie absente → « unknown » (membre à part entière de l'ensemble fermé)");
    ck.eq(IssueSync.normalizeSource({ priority: "" }).priority, null, "normalizeSource : nullable vidé côté source → null, jamais \"\"");
    ck.eq(IssueSync.normalizeSource({ orphan: "oui" }).orphan, false, "normalizeSource : orphan non booléen → false");
    ck.eq(IssueSync.normalizeSource({ orphan: "true" }).orphan, true, "normalizeSource : orphan « true » (round-trip JSON/formulaire) → true, comme la spec");

    // -- CATÉGORIE : ensemble FERMÉ, tout le reste CLAMPÉ. C'est ce clamp qui garantit que la synchro
    //    ne peut PAS produire une valeur que l'`enum` de la spec refuserait — sans quoi un seul
    //    ticket mal classé ferait rejeter la passe entière (validation en bloc). --
    ck.eq(ISSUE_STATUS_CATEGORIES.join(","), "todo,in_progress,done,unknown", "ISSUE_STATUS_CATEGORIES : l'ensemble FERMÉ, dans l'ordre sémantique");
    ck(ISSUE_STATUS_CATEGORIES.every((c) => IssueSync.normalizeCategory(c) === c), "normalizeCategory : chaque valeur de l'ensemble est conservée");
    ck.eq(IssueSync.normalizeCategory("En recette"), "unknown", "normalizeCategory : valeur hors ensemble → unknown (tolérance : la passe n'échoue pas)");
    ck.eq(IssueSync.normalizeCategory(null), "unknown", "normalizeCategory : absente → unknown");

    // -- ÉTIQUETTES : normalisation DÉTERMINISTE (rognées, vides écartées, dédupliquées, TRIÉES).
    //    Sans le tri, un simple réordonnancement côté tracker produirait un faux delta à chaque passe. --
    ck.eq(JSON.stringify(IssueSync.normalizeLabels(["reseau", "  urgent ", "reseau", "", "  ", 42, null])), JSON.stringify(["reseau", "urgent"]),
      "normalizeLabels : rognées, vides et non-chaînes écartées, dédupliquées");
    ck.eq(JSON.stringify(IssueSync.normalizeLabels(["b", "a", "c"])), JSON.stringify(IssueSync.normalizeLabels(["c", "b", "a"])),
      "normalizeLabels : DÉTERMINISTE — deux ordres d'entrée donnent la MÊME liste (pas de faux delta au réordonnancement)");
    ck.eq(JSON.stringify(IssueSync.normalizeLabels("pas un tableau")), "[]", "normalizeLabels : forme inattendue → [] (aucune exception)");

    // -- sourceEquals : compare des états NORMALISÉS champ à champ. --
    const a = IssueSync.normalizeSource({ ext_id: "10042", key: "INFRA-123", status: "En recette", labels: ["a", "b"] });
    const b = IssueSync.normalizeSource({ ext_id: "10042", key: "INFRA-123", status: "En recette", labels: ["b", "a"], notes: "local", targets: ["equipment:E1"] });
    ck(ISSUE_SOURCE_FIELDS.every((f) => IssueSync.sourceEquals(a, b, f)),
      "sourceEquals : étiquettes réordonnées + champs LOCAUX en plus → AUCUN écart de source");
    ck(!IssueSync.sourceEquals(a, IssueSync.normalizeSource({ ...a, key: "OPS-45" }), "key"), "sourceEquals : un champ source modifié est détecté");
    ck(!IssueSync.sourceEquals(a, IssueSync.normalizeSource({ ...a, labels: ["a"] }), "labels"), "sourceEquals : une étiquette RETIRÉE est détectée");

    // -- INVARIANT DE DÉLÉGATION : le modèle client doit produire les MÊMES valeurs source que la
    //    normalisation partagée. C'est LE verrou anti-faux-delta (le modèle réécrivant sa propre
    //    normalisation, la synchro trouverait un écart à chaque passe et réécrirait le document). --
    const raw = {
      ext_id: "10042", key: "INFRA-123", summary: "Panne cœur", status: "En recette", status_category: "vocabulaire-maison",
      issue_type: "Bug", priority: "", assignee: "A. Dupont", labels: ["reseau", "urgent", "reseau"], url: "https://jira.example/browse/INFRA-123",
      orphan: 1, notes: "note locale", targets: ["equipment:E1"],
    };
    const model = new Issue(raw);
    const shared = IssueSync.normalizeSource(raw);
    ck(ISSUE_SOURCE_FIELDS.every((f) => JSON.stringify(model[f]) === JSON.stringify(shared[f])),
      "modèle Issue : CHAQUE champ source ≡ IssueSync.normalizeSource (aucun faux delta possible)");
    ck.eq(model.status_category, "unknown", "modèle : catégorie inconnue clampée par la frontière partagée");
    ck.eq(model.notes, "note locale", "modèle : champ LOCAL `notes` conservé");
    ck.eq(JSON.stringify(model.targets), JSON.stringify(["equipment:E1"]), "modèle : champ LOCAL `targets` conservé");
    ck.eq(JSON.stringify(new Issue({ targets: ["equipment:E1", 42, null] }).targets), JSON.stringify(["equipment:E1"]),
      "modèle : `targets` filtré aux CHAÎNES (même règle que la normalisation de spec)");

    // -- PARTITION de la spec : tout champ déclaré est SOURCE ou l'un des 3 LOCAUX, jamais entre les
    //    deux. C'est ce qui empêche qu'un champ ajouté plus tard à la spec soit oublié de la
    //    frontière (il deviendrait silencieusement « local », donc jamais rafraîchi). --
    const LOCAL_FIELDS = ["notes", "description", "targets"];
    const specFields = Object.keys(Validation.COLLECTION_SPECS.issues.fields).sort();
    ck.eq(JSON.stringify(specFields), JSON.stringify([...ISSUE_SOURCE_FIELDS, ...LOCAL_FIELDS].sort()),
      "partition : champs de la spec ≡ champs SOURCE ∪ { notes, description, targets } (ni manque, ni fantôme)");
    ck(LOCAL_FIELDS.every((f) => !ISSUE_SOURCE_FIELDS.includes(f)), "partition : aucun champ LOCAL dans la liste des champs source (la synchro ne les écrase jamais)");

    // -- ACCORD avec la normalisation de SPEC : un aller-retour d'écriture ne doit rien déplacer.
    //    (La catégorie est la SEULE divergence, ASSUMÉE et documentée : la frontière CLAMPE, la spec
    //    REFUSE — la porte d'écriture directe reste stricte, la synchro reste tolérante.) --
    for (const sample of [{}, { priority: "Haute", url: "https://x/1" }, { summary: "t", labels: ["a"] }, { orphan: true, last_sync: "2026-08-06T10:00:00.000Z" }]) {
      const bySpec = Validation.DataValidator.normalizeRecord("issues", sample);
      const byFrontier = IssueSync.normalizeSource(sample);
      const drifted = ISSUE_SOURCE_FIELDS.filter((f) => f !== "status_category" && JSON.stringify(bySpec[f]) !== JSON.stringify(byFrontier[f]));
      ck.eq(drifted.join(","), "", "accord spec ⇄ frontière sur " + JSON.stringify(sample) + " (champs divergents : [" + drifted.join(", ") + "])");
    }
  }
  });

  /* ============ PARTAGÉ : clés de cible composées ============ */

  await section("shared : IssueTargets — clés « famille:id » (composition, décodage, forme, vocabulaire commun)", async () => {
  {
    ck.eq(ISSUE_TARGET_KINDS.join(","), "equipment,vm,spare,sub_equipment", "ISSUE_TARGET_KINDS : les 4 familles liables");
    ck.eq(IssueTargets.key("equipment", "E1"), "equipment:E1", "key : composition « famille:id »");
    ck.eq(JSON.stringify(IssueTargets.parse("vm:V1")), JSON.stringify({ kind: "vm", id: "V1" }), "parse : décodage exact");
    // Le séparateur est le PREMIER « : » — un id qui en contient reste INTACT (inverse exact de key).
    ck.eq(IssueTargets.parse("equipment:a:b").id, "a:b", "parse : séparateur = le PREMIER « : », un id à deux-points reste intact");
    ck.eq(IssueTargets.parse("equipment:a:b").kind, "equipment", "parse : … et la famille reste correctement isolée");
    for (const junk of ["", "sansSeparateur", ":E1", "equipment:", null, undefined, 42]) {
      ck.eq(IssueTargets.parse(junk), null, "parse : forme invalide " + JSON.stringify(junk) + " → null, aucune exception");
    }

    // isValidKey = famille CONNUE + id non vide. On juge la FORME, jamais l'EXISTENCE de la cible.
    ck(IssueTargets.KINDS.every((k) => IssueTargets.isValidKey(k + ":X")), "isValidKey : les 4 familles connues sont acceptées");
    ck(!IssueTargets.isValidKey("gizmo:X"), "isValidKey : famille INCONNUE refusée (aucune règle de cascade ne saurait la détacher)");
    ck(!IssueTargets.isValidKey("equipment:"), "isValidKey : id vide refusé");
    ck(!IssueTargets.isValidKey(42), "isValidKey : non-chaîne refusée");
    ck(IssueTargets.isValidKey("equipment:id-qui-n-existe-pas"), "isValidKey : cible INEXISTANTE acceptée (on valide la forme, pas l'existence — l'objet peut être créé après le lien)");

    // COLLECTION_BY_KIND : chaque famille pointe une collection RÉELLE du modèle.
    ck(IssueTargets.KINDS.every((k) => SharedSchema.COLLECTIONS.includes(IssueTargets.COLLECTION_BY_KIND[k])),
      "COLLECTION_BY_KIND : chaque famille désigne une collection réelle de Schema.COLLECTIONS");

    // -- CONVERGENCE DE VOCABULAIRE, vérifiée par TEST et non par un import (décision D10 : les
    //    modules `issues` et `interventions` doivent rester amovibles l'un sans l'autre). Un
    //    utilisateur qui lie « equipment:E1 » sur une intervention et sur un ticket écrit la MÊME
    //    chose, et l'éditeur de liens (SearchPop alimenté par TargetSearch) sert les deux. --
    const { TargetSearch } = D("core/TargetSearch.js");
    ck(IssueTargets.KINDS.every((k) => IssueTargets.key(k, "X") === TargetSearch.key(k, "X")),
      "vocabulaire : IssueTargets.key ≡ TargetSearch.key (la clé produite par le picker est lisible telle quelle)");
    ck.eq(JSON.stringify(IssueTargets.parse("equipment:a:b")), JSON.stringify(TargetSearch.parse("equipment:a:b")),
      "vocabulaire : IssueTargets.parse ≡ TargetSearch.parse (même règle de séparateur)");
    const { InterventionsFormat } = D("core/InterventionsFormat.js");
    ck.eq(IssueTargets.KINDS.join(","), InterventionsFormat.TARGET_KIND_SLUGS.join(","),
      "vocabulaire : mêmes familles que les interventions (miroir de INTERVENTION_TARGET_KINDS) — convergence, PAS dépendance");
  }
  });

  /* ============ PARTAGÉ : la collection dans les mécaniques transverses ============ */

  await section("shared : collection issues — spec (enum fermée, forme des targets), ordre COLLECTIONS, RenderImpact", async () => {
  {
    // -- ORDRE : Schema.COLLECTIONS ⇄ EntityRegistry.CLASSES (l'invariant global compare les deux
    //    listes ; ici on ASSERTE la POSITION voulue, pour que le jour où l'un des deux bouge on sache où). --
    ck.eq(SharedSchema.COLLECTIONS[SharedSchema.COLLECTIONS.length - 1], "issues", "COLLECTIONS : issues ajoutée EN FIN de liste");
    ck.eq(EntityRegistry.COLLECTIONS[EntityRegistry.COLLECTIONS.length - 1], "issues", "EntityRegistry : même position (les deux tables sont comparées par un test d'invariant)");
    ck.eq(EntityRegistry.classOf("issues"), Issue, "EntityRegistry : la collection hydrate bien la classe Issue");

    // -- ARRAY_FIELDS : `labels` et `targets` filtrables par APPARTENANCE (patron `tags_src`) —
    //    c'est ce qui fait marcher le filtre « Cible » unifié des listings sans code neuf. --
    ck(SharedSchema.isArrayField("labels") && SharedSchema.isArrayField("targets"),
      "ARRAY_FIELDS : labels + targets (le `where` y teste l'appartenance, pas l'égalité)");

    // -- SPEC : défauts, enum FERMÉE, absence VOULUE de `ref` sur targets. --
    const fields = Validation.COLLECTION_SPECS.issues.fields;
    const textFields = ["ext_id", "provider_id", "key", "summary", "status", "issue_type", "last_sync", "notes", "description"];
    ck(textFields.every((f) => fields[f] && fields[f].type === "string" && fields[f].default === ""),
      "spec : champs texte non nullables à default \"\" (aucun null silencieux en colonnes strictes)");
    ck(["priority", "assignee", "reporter", "resolution", "created_src", "updated_src", "url"].every((f) => fields[f].nullable === true && fields[f].default === null),
      "spec : champs nullables → default null");
    ck(fields.orphan.type === "boolean" && fields.orphan.default === false, "spec : orphan booléen, défaut false");
    ck.eq(JSON.stringify(fields.status_category.enum), JSON.stringify(ISSUE_STATUS_CATEGORIES), "spec : status_category porte l'enum FERMÉE partagée (une seule liste)");
    ck.eq(fields.status_category.default, "unknown", "spec : status_category défaut « unknown »");
    ck(!fields.status.enum, "spec : `status` SANS enum — libellé brut du workflow, affiché tel quel et jamais traduit (D3)");
    ck(fields.labels.type === "string[]" && fields.targets.type === "string[]", "spec : labels + targets sont des string[]");
    ck(!fields.targets.ref, "spec : targets SANS `ref` — une clé POLYMORPHE ne désigne pas UNE collection (V2 ne sait pas la contrôler)");

    // Un enregistrement MINIMAL doit être normalisable ET valide (aucune sur-contrainte introduite).
    const V = Validation.DataValidator;
    ck.eq(V.normalizeAndValidate("issues", {}).errors.length, 0, "spec : enregistrement minimal (aucun champ) → 0 erreur (aucun champ n'est `required`)");

    // -- ENUM FERMÉE : la porte d'écriture DIRECTE (API/import) refuse une catégorie inventée, alors
    //    que la synchro, elle, ne peut pas en produire (clamp de la frontière). Les deux se complètent. --
    const badCategory = V.normalizeAndValidate("issues", { status_category: "En recette" }).errors;
    ck(badCategory.some((e) => e.path === "status_category" && e.code === "enum"), "spec : catégorie hors ensemble → erreur `enum` (écriture directe refusée)");
    ck.eq(V.normalizeAndValidate("issues", { status_category: "done" }).errors.length, 0, "spec : catégorie de l'ensemble → acceptée");

    // -- FORME des targets (invariant V3) : famille connue + id non vide. --
    const targetErrors = (targets) => V.normalizeAndValidate("issues", { targets }).errors.filter((e) => e.path === "targets");
    ck.eq(targetErrors(["equipment:E1", "vm:V1", "spare:S1", "sub_equipment:SE1"]).length, 0, "targets : les 4 familles → valides");
    ck.eq(targetErrors(["equipment:a:b"]).length, 0, "targets : un id contenant « : » reste valide (le séparateur est le premier)");
    ck(targetErrors(["gizmo:X"]).some((e) => e.code === "invariant"), "targets : famille INCONNUE → invariant violé");
    ck(targetErrors(["equipment:"]).some((e) => e.code === "invariant"), "targets : id vide → invariant violé");
    ck(targetErrors(["E1"]).some((e) => e.code === "invariant"), "targets : clé SANS famille → invariant violé");
    ck(targetErrors(["equipment:E1", "gizmo:X"]).some((e) => e.code === "invariant"), "targets : UNE clé fautive parmi des bonnes suffit à violer l'invariant");
    ck(targetErrors(["equipment:absent-du-document"]).length === 0, "targets : cible INEXISTANTE tolérée (la forme est jugée, pas l'existence)");
    // Le message NOMME les familles acceptées — sinon l'utilisateur devine.
    ck(IssueTargets.KINDS.every((k) => targetErrors(["gizmo:X"])[0].message.includes(k)), "targets : le message d'erreur ÉNUMÈRE les familles acceptées");

    // -- CARTE D'IMPACT 3D : `none` (l'invariant global vérifie que toute collection est mappée). --
    ck.eq(COLLECTION_THREE_IMPACT.issues, "none", "RenderImpact : issues → none (ni placement, ni dimension, ni port : aucun mesh n'en dépend)");
  }
  });

  /* ============ PARTAGÉ : cascade des cibles ============ */

  await section("shared : Cascade — détachement des `targets` (4 familles, récursion, LOT multi-suppressions du MÊME ticket)", async () => {
  {
    // Corpus : un ticket I1 lié aux QUATRE familles, un ticket I2 lié à un équipement différent.
    const mkDb = () => ({
      equipments: [{ id: "E1", name: "sw-coeur" }, { id: "E9", name: "sw-annexe" }],
      subEquipments: [{ id: "SE1", name: "drive-1", equipment_id: "E1" }],
      vms: [{ id: "V1", name: "web-1" }],
      spares: [{ id: "S1" }],
      issues: [
        { id: "I1", key: "INFRA-1", targets: ["equipment:E1", "vm:V1", "spare:S1", "sub_equipment:SE1"] },
        { id: "I2", key: "INFRA-2", targets: ["equipment:E9"] },
      ],
      ports: [], cables: [], cableBundles: [], ipAddresses: [], dhcpRanges: [], ipNetworks: [], aggregates: [], wifiClients: [], rackItems: [], waypoints: [],
    });
    const finders = (db) => [
      (c, f, v) => (db[c] || []).filter((r) => (Array.isArray(r[f]) ? r[f].includes(v) : r[f] === v)),
      (c, id) => (db[c] || []).find((r) => r.id === id) || null,
    ];
    /** Valeur FINALE de `targets` planifiée pour un ticket (null si aucun détachement le concerne). */
    const finalTargets = (plan, issueId) => {
      const d = plan.detaches.filter((x) => x.c === "issues" && x.id === issueId && x.key === "targets").pop();
      return d ? d.value : null;
    };

    // 1) UNE famille à la fois : chaque suppression retire SA clé, et elle seule.
    for (const [collection, id, key] of [["vms", "V1", "vm:V1"], ["spares", "S1", "spare:S1"], ["subEquipments", "SE1", "sub_equipment:SE1"]]) {
      const db = mkDb(); const [find, fetch] = finders(db);
      const plan = Cascade.plan(collection, id, find, fetch);
      const targets = finalTargets(plan, "I1");
      ck(targets !== null && !targets.includes(key) && targets.length === 3,
        "cascade " + collection + " : la clé « " + key + " » est retirée des targets (les 3 autres restent)");
      ck(!plan.deletes.some((d) => d.c === "issues"), "cascade " + collection + " : AUCUN ticket supprimé (il porte notes et liens — le lien coupé est une information)");
      ck(!plan.detaches.some((d) => d.c === "issues" && d.id === "I2"), "cascade " + collection + " : le ticket qui ne cible pas cet objet n'est pas touché");
    }

    // 2) 🚨 LE PIÈGE : un LOT qui supprime DEUX cibles du MÊME ticket. `planMany` développe les deux
    //    dans le MÊME plan ; sans composition sur le déjà planifié (`pendingValue`), la seconde
    //    valeur — calculée sur les targets d'ORIGINE — ÉCRASERAIT la première et l'une des deux clés
    //    survivrait, pointant un objet supprimé. Perte SILENCIEUSE : d'où ce test.
    {
      const db = mkDb(); const [find, fetch] = finders(db);
      const plan = Cascade.planMany([{ collection: "vms", id: "V1" }, { collection: "spares", id: "S1" }], find, fetch);
      const targets = finalTargets(plan, "I1");
      ck.eq(JSON.stringify(targets), JSON.stringify(["equipment:E1", "sub_equipment:SE1"]),
        "cascade LOT : DEUX cibles du même ticket supprimées ensemble → les DEUX clés retirées (composition sur le déjà planifié)");
      const issueDetaches = plan.detaches.filter((d) => d.c === "issues" && d.id === "I1" && d.key === "targets");
      ck.eq(issueDetaches.length, 1, "cascade LOT : un SEUL détachement conservé par (collection, id, clé) — le plan reste proportionné");
    }

    // 3) MÊME piège par RÉCURSION, sans lot : supprimer l'équipement supprime AUSSI son sous-équipement
    //    (règle `equipments.delete`), donc DEUX clés du même ticket tombent dans le même plan.
    {
      const db = mkDb(); const [find, fetch] = finders(db);
      const plan = Cascade.plan("equipments", "E1", find, fetch);
      const targets = finalTargets(plan, "I1");
      ck.eq(JSON.stringify(targets), JSON.stringify(["vm:V1", "spare:S1"]),
        "cascade RÉCURSION : supprimer l'équipement retire SA clé ET celle de son sous-équipement (emporté par la cascade)");
      ck(plan.deletes.some((d) => d.c === "subEquipments" && d.id === "SE1"), "cascade RÉCURSION : … le sous-équipement est bien supprimé par la même passe (anti-vacuité)");
      // L'autre ticket, lui, perd sa propre clé seulement si l'équipement supprimé est le sien.
      ck.eq(finalTargets(plan, "I2"), null, "cascade RÉCURSION : le ticket lié à un AUTRE équipement n'est pas touché");
    }

    // 4) LES QUATRE familles d'un coup : rien ne doit rester.
    {
      const db = mkDb(); const [find, fetch] = finders(db);
      const plan = Cascade.planMany([{ collection: "equipments", id: "E1" }, { collection: "vms", id: "V1" }, { collection: "spares", id: "S1" }], find, fetch);
      ck.eq(JSON.stringify(finalTargets(plan, "I1")), "[]", "cascade : les 4 familles retirées (le sous-équipement suivant l'équipement) → targets vide");
    }

    // 5) Supprimer un TICKET n'entraîne RIEN (règle déclarée vide, à dessein : rien du document ne
    //    pointe vers un ticket — le lien va dans l'AUTRE sens).
    {
      const db = mkDb(); const [find, fetch] = finders(db);
      const plan = Cascade.plan("issues", "I1", find, fetch);
      ck(plan.deletes.length === 0 && plan.detaches.length === 0, "cascade issues : aucun effet (rien ne pointe vers un ticket)");
    }

    // 6) ANTI-VACUITÉ du détecteur : un ticket SANS `targets` (legacy / jamais lié) ne produit aucun
    //    détachement, et surtout ne fait pas planter la règle sur un champ absent.
    {
      const db = mkDb();
      db.issues.push({ id: "I3", key: "INFRA-3" });   // pas de champ targets du tout
      const [find, fetch] = finders(db);
      const plan = Cascade.plan("vms", "V1", find, fetch);
      ck(!plan.detaches.some((d) => d.c === "issues" && d.id === "I3"), "cascade : un ticket sans `targets` n'est pas touché (aucune exception sur champ absent)");
    }
  }
  });

  /* ============ PARTAGÉ : recherche ============ */

  await section("shared : SearchTerms — catalogues « introuvable » + CATÉGORIE (fr/en verrouillés sur les locales), colonnes plates, bump de version", async () => {
  {
    const noFetch = () => null, noFind = () => [];
    const terms = (record) => SearchTerms.termsOf("issues", record, noFetch, noFind);

    // -- « introuvable » : MÊME mécanique que l'orphelinat VM et la déconnexion wifi, TROISIÈME libellé. --
    const lost = terms({ id: "I1", orphan: true, status_category: "unknown" });
    ck(lost.includes("introuvable") && lost.includes("not found"), "recherche : catalogue « introuvable » fr+en (le serveur ignore la langue de l'utilisateur)");
    ck(!terms({ id: "I2", orphan: false, status_category: "unknown" }).includes("introuvable"), "recherche : ticket résolu → AUCUN terme « introuvable » (false ≠ clé de catalogue)");

    // -- CATÉGORIE : seule partie TRADUISIBLE de l'état — taper « clos » doit ramener les tickets
    //    terminés quel que soit le vocabulaire du workflow (« Done », « Terminé », « Livré »…). --
    const done = terms({ id: "I3", status_category: "done", status: "Livré au client" });
    ck(done.includes("Clos") && done.includes("Closed"), "recherche : catégorie `done` → « Clos » + « Closed »");
    ck(terms({ id: "I4", status_category: "in_progress" }).includes("En cours"), "recherche : catégorie `in_progress` → « En cours »");
    ck(terms({ id: "I5", status_category: "todo" }).includes("Ouvert"), "recherche : catégorie `todo` → « Ouvert »");
    ck.eq(terms({ id: "I6", status_category: "unknown" }).length, 0,
      "recherche : catégorie `unknown` → AUCUN terme (c'est le DÉFAUT de la spec : la cataloguer ferait ressortir la moitié du corpus)");

    // -- COLONNES PLATES : clé, titre, statut BRUT, assigné et étiquettes sont couverts par `ownText`
    //    (aucun `own` n'est nécessaire — rien n'est enfoui dans une structure ni composé par l'habillage). --
    const record = { id: "I7", key: "INFRA-123", summary: "Panne cœur", status: "En recette", assignee: "A. Dupont", labels: ["reseau", "urgent"], status_category: "todo" };
    const text = SearchTerms.searchText("issues", record, noFetch, noFind);
    for (const needle of ["infra-123", "panne", "en recette", "dupont", "reseau", "urgent"]) {
      ck(text.includes(needle), "recherche : « " + needle + " » présent dans la colonne (matière plate via ownText)");
    }
    ck(text.includes(SharedSchema.normSearch("Ouvert")), "recherche : … et le terme de CATÉGORIE s'y ajoute (colonne enrichie)");

    // -- LIMITE ASSUMÉE : aucun dérivé par CIBLE. Les clés « famille:id » ne sont pas réductibles au
    //    mécanisme déclaratif (`TermLink` suit un champ dont la valeur EST un id, vers UNE collection),
    //    et `dependentQueries` en dériverait une invalidation qui ne matcherait jamais la clé composée
    //    → le dérivé serait présent mais JAMAIS rafraîchi. On ne force donc pas.
    ck.eq(SearchTerms.dependentQueries("equipments", "E1", null, null).filter((q) => q.collection === "issues").length, 0,
      "recherche : AUCUNE dépendance inverse depuis `issues` (limite assumée — pas de dérivé par cible en v1)");

    // -- VERROUS sur les locales : la duplication assumée catalogue ⇄ i18n ne peut pas dériver en silence. --
    const norm = SharedSchema.normSearch;
    const frLists = D("i18n/locales/fr/lists.js").lists, enLists = D("i18n/locales/en/lists.js").lists;
    const notFound = SEARCH_CATALOGS.issueNotFound.map(norm);
    ck(notFound.includes(norm(frLists.ph.notFound)) && notFound.includes(norm(enLists.ph.notFound)),
      "catalogue issueNotFound : couvre lists.ph.notFound des DEUX locales (verrou anti-dérive)");
    // … et ce libellé est bien DISTINCT de ceux des VMs et du wifi : trois sens, trois mots.
    ck(norm(frLists.ph.notFound) !== norm(frLists.ph.orphan) && norm(frLists.ph.notFound) !== norm(frLists.ph.disconnected),
      "libellés : « introuvable » ≠ « orpheline » ≠ « déconnecté » (même mécanique `orphan`, trois SENS distincts)");
    const frDomain = D("i18n/locales/fr/domain.js").domain, enDomain = D("i18n/locales/en/domain.js").domain;
    for (const category of ["todo", "in_progress", "done"]) {
      const catalog = (SEARCH_CATALOGS.issueStatusCategory[category] || []).map(norm);
      ck(catalog.includes(norm(frDomain.issueStatusCategory[category])) && catalog.includes(norm(enDomain.issueStatusCategory[category])),
        "catalogue issueStatusCategory." + category + " : couvre domain.issueStatusCategory des DEUX locales");
    }
    ck(!("unknown" in SEARCH_CATALOGS.issueStatusCategory) && !!enDomain.issueStatusCategory.unknown,
      "catalogue : `unknown` AFFICHABLE (locales) mais volontairement PAS cherchable (c'est le défaut de la spec)");

    // -- VERSIONNAGE : ajouter une collection à la spec EST une évolution → bump (doctrine du fichier). --
    ck.eq(SearchTerms.SEARCH_VERSION, 4, "SEARCH_VERSION = 4 (l'ajout de `issues` à la spec a bumpé le marqueur de backfill)");
  }
  });

  /* ============ CLIENT : IssueStatus ============ */

  await section("client : IssueStatus — catégories, PRIORITÉ de l'introuvable, clé de tri, libellés", async () => {
  {
    // -- CATÉGORIE : ensemble FERMÉ, repli `unknown` sur tout ce qui n'en est pas (le module ne fait
    //    jamais confiance à ce qui vient d'un tiers, même si la frontière de synchro clampe déjà). --
    ck.eq(IssueStatus.CATEGORIES.join(","), ISSUE_STATUS_CATEGORIES.join(","), "CATEGORIES : reprise TELLE QUELLE de la liste partagée (pas de seconde table)");
    ck.eq(IssueStatus.categoryOf({ status_category: "in_progress" }), "in_progress", "categoryOf : catégorie connue conservée");
    ck.eq(IssueStatus.categoryOf({ status_category: "  done  " }), "done", "categoryOf : catégorie rognée");
    ck.eq(IssueStatus.categoryOf({ status_category: "En recette" }), "unknown", "categoryOf : valeur hors ensemble → unknown");
    ck.eq(IssueStatus.categoryOf(null), "unknown", "categoryOf : null toléré → unknown");

    // -- STATUT BRUT : affiché TEL QUEL, jamais traduit (décision D3 — le workflow est configurable). --
    ck.eq(IssueStatus.raw({ status: "  En recette  " }), "En recette", "raw : statut rogné, restitué TEL QUEL (aucune traduction, aucune énumération)");
    ck.eq(IssueStatus.raw({}), "", "raw : statut absent → \"\"");

    // -- INTROUVABLE : c'est l'état COURANT, la catégorie affichée date de la dernière résolution
    //    réussie → l'orphelinat PRIME, en couleur d'AVERTISSEMENT (pas d'erreur : rien n'est perdu). --
    ck.eq(IssueStatus.isNotFound({ orphan: true }), true, "isNotFound : orphan levé → introuvable");
    ck.eq(IssueStatus.isNotFound({}), false, "isNotFound : sans orphan → résolu");
    ck.eq(IssueStatus.COLOR_NOT_FOUND, "var(--warn)", "couleur : introuvable = AVERTISSEMENT (l'enregistrement local est intact et reviendra tout seul)");
    ck.eq(IssueStatus.color({ orphan: true, status_category: "done" }), IssueStatus.COLOR_NOT_FOUND,
      "color : l'orphelinat PRIME sur la catégorie (patron VmStatus.swatchColor)");
    ck(IssueStatus.color({ status_category: "done" }) !== IssueStatus.color({ status_category: "todo" }),
      "color : deux catégories distinctes → deux couleurs distinctes (la catégorie fermée est la SEULE à colorer)");
    ck.eq(IssueStatus.color({ status_category: "vocabulaire-maison" }), IssueStatus.color({ status_category: "unknown" }),
      "color : catégorie inconnue → couleur de `unknown` (neutre : on ne colore pas ce qu'on n'a pas su classer)");

    // -- TRI : introuvables groupés à part, puis ordre SÉMANTIQUE des catégories, puis statut brut. --
    const rows = [
      { name: "clos", status_category: "done" },
      { name: "introuvable", status_category: "todo", orphan: true },
      { name: "en cours", status_category: "in_progress" },
      { name: "ouvert-b", status_category: "todo", status: "B" },
      { name: "ouvert-a", status_category: "todo", status: "A" },
    ];
    const sorted = rows.slice().sort((a, b) => (IssueStatus.sortKey(a) < IssueStatus.sortKey(b) ? -1 : IssueStatus.sortKey(a) > IssueStatus.sortKey(b) ? 1 : 0)).map((r) => r.name);
    ck.eq(sorted.join(","), "ouvert-a,ouvert-b,en cours,clos,introuvable",
      "sortKey : ordre sémantique todo → in_progress → done, statut brut en départage, INTROUVABLES groupés à part");

    // -- LIBELLÉS : la CATÉGORIE est traduite, le STATUT ne l'est jamais. Locale du harnais = fr. --
    const frLists = D("i18n/locales/fr/lists.js").lists, frDomain = D("i18n/locales/fr/domain.js").domain;
    ck.eq(IssueStatus.notFoundLabel(), frLists.ph.notFound, "notFoundLabel : résolu via I18n (lists.ph.notFound), jamais une chaîne en dur");
    ck.eq(IssueStatus.categoryLabel("done"), frDomain.issueStatusCategory.done, "categoryLabel : libellé localisé de la catégorie");
    ck.eq(IssueStatus.categoryLabel("En recette"), frDomain.issueStatusCategory.unknown,
      "categoryLabel : valeur non normalisée ramenée à `unknown` — la clé i18n demandée existe TOUJOURS");
    ck.eq(IssueStatus.categoryLabel(null), frDomain.issueStatusCategory.unknown, "categoryLabel : null toléré");

    // -- displayName du modèle : la CLÉ prime (c'est elle qu'on prononce et qu'on recopie). --
    ck.eq(Issue.displayName({ key: "INFRA-123", summary: "Panne" }), "INFRA-123", "displayName : la clé lisible prime");
    ck.eq(Issue.displayName({ key: "   ", summary: "Panne cœur" }), "Panne cœur", "displayName : clé blanche → repli sur le titre");
    ck.eq(Issue.displayName({ ext_id: "10042" }), "10042", "displayName : ni clé ni titre → repli sur l'identité côté tracker");
    ck.eq(Issue.displayName({}), "", "displayName : rien d'affichable → \"\" (l'appelant décide de son repli)");
    ck.eq(Issue.displayName(null), "", "displayName : null toléré");
  }
  });

  /* ==========================================================================================
     LOT L2 — MODULE SERVEUR AMOVIBLE `issues/` : contrats, adaptateur Jira, config chiffrée
     ========================================================================================== */

  const { JiraParse } = SERVER("issues/JiraParse.js");
  const { JiraAdapter } = SERVER("issues/JiraAdapter.js");
  const { JiraHttp, JiraHttpError } = SERVER("issues/JiraHttp.js");

  /** URL de base des fixtures — sert AUSSI à prouver que `url` est composée depuis ELLE. */
  const BASE = "https://tracker.example.net";

  /** Fixture d'un ticket à la forme PLEINE de l'API v3 (champs sous `fields`, objets nommés).
      ⚠ `self` y figure EXPRÈS : il pointe l'API, et le test prouve qu'il n'atterrit jamais dans `url`. */
  const fixtureIssue = (id, key, overFields) => ({
    id, key,
    self: BASE + "/rest/api/3/issue/" + id,
    fields: Object.assign({
      summary: "Ticket " + key,
      status: { name: "En recette", statusCategory: { key: "indeterminate", name: "In Progress" } },
      issuetype: { name: "Bug" },
      priority: { name: "Haute" },
      assignee: { accountId: "acc-1", displayName: "A. Dupont", emailAddress: "a.dupont@example.net" },
      reporter: { accountId: "acc-2", displayName: "B. Martin" },
      labels: ["reseau", "urgent"],
      resolution: null,
      created: "2026-08-01T10:00:00.000+0200",
      updated: "2026-08-05T12:00:00.000+0200",
    }, overFields || {}),
  });

  /** Stub HTTP STRUCTUREL (satisfait `JiraJsonClient` sans en hériter) : routes
      « <VERBE> <chemin sans query> » → fixture, fonction `(body, stub)` ou `Error` à jeter.
      Aucun réseau, aucun TLS. Une route NON stubée jette un 404 structurel — c'est justement ce que
      rend le tracker pour un ticket inexistant, et ça évite de stuber les absences une par une. */
  const mkJiraStub = (routes) => {
    const stub = {
      calls: [],
      getJson: (p) => stub.answer("GET", p, undefined),
      postJson: (p, body) => stub.answer("POST", p, body),
      answer: async (method, full, body) => {
        stub.calls.push({ method, path: full, body });
        const entry = routes[method + " " + String(full).split("?")[0]];
        if (entry === undefined) throw Object.assign(new Error("route non stubée : " + method + " " + full), { status: 404 });
        if (entry instanceof Error) throw entry;
        return typeof entry === "function" ? entry(body, stub) : entry;
      },
    };
    return stub;
  };

  /** Identifiants effectivement demandés par une clause JQL `id IN (…)` (décodage du stub). */
  const idsInJql = (body) => String((body && body.jql) || "").replace(/^[^(]*\(/, "").replace(/\)[^)]*$/, "")
    .split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter((s) => s !== "");

  /** Route de recherche « honnête » : rend les tickets de `pool` dont l'id est demandé, en UNE page. */
  const searchRoute = (pool) => (body) => ({ issues: pool.filter((i) => idsInJql(body).includes(i.id)), isLast: true });

  /** Config de provider utilisée par les tests d'adaptateur (jeton présent pour prouver qu'il ne fuit pas). */
  const CFG = { id: "tr-1", kind: "jira", url: BASE, token: "JETON-TRES-SECRET", account: "svc@example.net", interval_sec: 0, timeout_sec: 20, options: { project_key: "INFRA", issue_type: "Tâche" } };

  /* ============ SERVEUR : ADF (le format de description de l'API v3) ============ */

  await section("Serveur : JiraParse.toAdf — document VALIDE (texte vide, multi-lignes, caractères spéciaux)", async () => {
  {
    /** Tous les nœuds `text` d'un document ADF — un `text` de chaîne VIDE est INVALIDE au schéma,
        et c'est l'erreur qu'on commet en mappant les lignes sans y penser (400 peu lisible). */
    const textNodes = (doc) => { const out = []; const walk = (n) => { if (!n || typeof n !== "object") return; if (n.type === "text") out.push(n); (n.content || []).forEach(walk); }; walk(doc); return out; };

    const empty = JiraParse.toAdf("");
    ck(empty.type === "doc" && empty.version === 1, "toAdf : enveloppe { type: « doc », version: 1 }");
    ck.eq(JSON.stringify(empty.content), JSON.stringify([{ type: "paragraph", content: [] }]),
      "toAdf : texte VIDE → document VALIDE d'UN paragraphe vide (ni document sans contenu, ni nœud text vide)");
    ck.eq(textNodes(empty).length, 0, "toAdf : … et AUCUN nœud `text` (un `text` de chaîne vide est refusé par le schéma ADF)");

    const multi = JiraParse.toAdf("première ligne\ndeuxième ligne");
    ck.eq(multi.content.length, 2, "toAdf : une ligne = un paragraphe");
    ck.eq(multi.content[0].content[0].text, "première ligne", "toAdf : le texte de la ligne est porté par un nœud `text`");

    const blank = JiraParse.toAdf("a\n\nb");
    ck.eq(blank.content.length, 3, "toAdf : la ligne VIDE produit son propre paragraphe (la mise en page saisie est conservée)");
    ck.eq(JSON.stringify(blank.content[1]), JSON.stringify({ type: "paragraph", content: [] }), "toAdf : … un paragraphe SANS contenu, jamais un nœud text vide");
    ck(textNodes(blank).every((n) => n.text !== ""), "toAdf : aucun nœud `text` vide dans TOUT le document");
    ck.eq(JiraParse.toAdf("a\r\nb\rc").content.length, 3, "toAdf : CRLF et CR reconnus comme fins de ligne");

    const special = 'Il a dit « "café" » — 100 % \\ chemin\\vers 🙂 <b>&amp;</b>';
    ck.eq(JiraParse.toAdf(special).content[0].content[0].text, special,
      "toAdf : caractères spéciaux conservés TELS QUELS (c'est la sérialisation JSON qui échappe — le faire ici doublerait)");
    ck.eq(JSON.parse(JSON.stringify(JiraParse.toAdf(special))).content[0].content[0].text, special, "toAdf : … et ils survivent à l'aller-retour JSON");

    for (const junk of [null, undefined, 42, {}]) {
      ck.eq(JSON.stringify(JiraParse.toAdf(junk)), JSON.stringify(empty),
        "toAdf : entrée non textuelle (" + String(junk) + ") → le MÊME document vide valide, aucune exception");
    }
  }
  });

  /* ============ SERVEUR : décodage Jira PUR ============ */

  await section("Serveur : JiraParse — ticket décodé (ext_id = id INTERNE, url d'INTERFACE, catégorie, alias, tolérance)", async () => {
  {
    const full = JiraParse.issueRecord(fixtureIssue("10042", "INFRA-123"), BASE);

    // -- 🚨 PIÈGE N°1 DU CHANTIER : l'identité est l'id INTERNE, jamais la clé. --
    ck.eq(full.ext_id, "10042", "ext_id : l'identifiant INTERNE du ticket");
    ck(full.ext_id !== "INFRA-123", "ext_id : JAMAIS la clé — une clé change au déplacement de projet (doublon + orphelin, en silence)");
    ck.eq(full.key, "INFRA-123", "key : conservée comme champ d'AFFICHAGE, re-synchronisé à chaque passe");
    ck.eq(JiraParse.issueRecord({ key: "INFRA-9", fields: { summary: "x" } }, BASE), null,
      "un ticket SANS id interne est REFUSÉ (mieux vaut ne pas le suivre que le suivre sous une identité mobile)");

    // -- 🚨 PIÈGE N°2 : `self` pointe l'API, l'utilisateur veut l'INTERFACE. --
    ck.eq(full.url, BASE + "/browse/INFRA-123", "url : lien d'INTERFACE COMPOSÉ « <base>/browse/<clé> »");
    ck(!full.url.includes("rest/api"), "url : le champ `self` de la réponse (qui pointe l'API) n'est JAMAIS recopié");
    ck.eq(JiraParse.browseUrl(BASE + "///", "INFRA-1"), BASE + "/browse/INFRA-1", "browseUrl : les « / » finaux de la base sont absorbés (pas de double barre)");
    ck.eq(JiraParse.browseUrl(BASE, ""), null, "browseUrl : sans clé → null (un lien mort est pire qu'une colonne vide)");
    ck.eq(JiraParse.browseUrl("", "INFRA-1"), null, "browseUrl : sans base → null");

    // -- Champs métier de la forme PLEINE. --
    ck.eq(full.summary, "Ticket INFRA-123", "summary décodé");
    ck.eq(full.status, "En recette", "status : libellé BRUT du workflow, restitué tel quel (jamais traduit)");
    ck.eq(full.status_category, "in_progress", "status_category : `indeterminate` → `in_progress` (table de correspondance explicite)");
    ck.eq(full.issue_type, "Bug", "issue_type décodé depuis `fields.issuetype.name`");
    ck.eq(full.priority, "Haute", "priority décodée");
    ck.eq(full.assignee, "A. Dupont", "assignee : nom AFFICHABLE (displayName), pas un identifiant de compte");
    ck.eq(full.reporter, "B. Martin", "reporter : nom affichable");
    ck.eq(JSON.stringify(full.labels), JSON.stringify(["reseau", "urgent"]), "labels décodées");
    ck.eq(full.resolution, null, "resolution : `null` en base côté tracker → null (ticket ouvert)");
    ck.eq(full.created_src, "2026-08-01T08:00:00.000Z", "created_src : ramené en ISO UTC depuis le décalage horaire de Jira");
    ck.eq(full.updated_src, "2026-08-05T10:00:00.000Z", "updated_src : idem");

    // -- Champs dont l'AUTORITÉ n'appartient pas au décodeur. --
    ck.eq(full.provider_id, "", "provider_id : laissé VIDE par le décodeur pur — c'est l'adaptateur qui estampille");
    ck.eq(full.orphan, false, "orphan : `false` — le ticket VIENT d'être résolu (constat, pas décision)");
    ck.eq(full.last_sync, "", "last_sync : laissé VIDE — le service pose UN horodatage pour toute la passe");

    // -- TOLÉRANCE : forme CREUSE. --
    const hollow = JiraParse.issueRecord({ id: "1", key: "K-1", fields: {} }, BASE);
    ck(hollow.summary === "" && hollow.status === "" && hollow.issue_type === "", "creux : champs texte non nullables → \"\" (aucun null silencieux)");
    ck(hollow.priority === null && hollow.assignee === null && hollow.reporter === null && hollow.resolution === null, "creux : champs nullables → null");
    ck(hollow.created_src === null && hollow.updated_src === null, "creux : horodatages absents → null (jamais une date inventée)");
    ck.eq(JSON.stringify(hollow.labels), "[]", "creux : labels absentes → []");
    ck.eq(hollow.status_category, "unknown", "creux : statut absent → catégorie `unknown`");

    // -- TOLÉRANCE : formes INATTENDUES — aucune exception, jamais. --
    for (const junk of [null, undefined, 42, "texte", [], {}]) {
      ck.eq(JiraParse.issueRecord(junk, BASE), null, "inattendu : " + JSON.stringify(junk) + " → null, aucune exception");
    }
    const weird = JiraParse.issueRecord({ id: "2", fields: "pas un objet" }, BASE);
    ck(weird !== null && weird.summary === "" && weird.url === null, "inattendu : `fields` non-objet → repli sur l'objet racine, et pas de clé → url null");
    ck.eq(JiraParse.issueRecord({ id: "3", fields: { labels: "pas un tableau" } }, BASE).labels.length, 0, "inattendu : labels non-tableau → []");
    ck.eq(JiraParse.issueRecord({ id: "4", fields: { created: "pas une date" } }, BASE).created_src, null, "inattendu : date illisible → null");

    // -- ALIAS : un seul point de déclaration, et une forme APLATIE reste décodable. --
    const flat = JiraParse.issueRecord({ issueId: 7, issueKey: "K-7", summary: "aplati", status: "Terminé", labels: ["a"] }, BASE);
    ck.eq(flat.ext_id, "7", "alias : `issueId` numérique accepté et converti en chaîne");
    ck(flat.key === "K-7" && flat.summary === "aplati", "alias : `issueKey` + champs APLATIS (sans conteneur `fields`) décodés");
    ck.eq(flat.status, "Terminé", "alias : un `status` livré en CHAÎNE nue reste un libellé exploitable");
    ck.eq(flat.status_category, "unknown", "alias : … mais sans objet `statusCategory`, la catégorie reste `unknown` (on ne devine pas depuis un libellé)");

    // -- CATÉGORIE : la table est explicite, tout le reste tombe sur `unknown`. --
    const categoryOf = (key) => JiraParse.issueRecord(fixtureIssue("9", "K-9", { status: { name: "s", statusCategory: { key } } }), BASE).status_category;
    ck.eq(categoryOf("new"), "todo", "catégorie : `new` → `todo`");
    ck.eq(categoryOf("indeterminate"), "in_progress", "catégorie : `indeterminate` → `in_progress`");
    ck.eq(categoryOf("done"), "done", "catégorie : `done` → `done`");
    ck.eq(categoryOf("DONE"), "done", "catégorie : casse ignorée");
    ck.eq(categoryOf("cosmic"), "unknown", "catégorie INCONNUE → `unknown` (la passe ne doit pas échouer pour une donnée d'affichage)");
    ck.eq(categoryOf("undefined"), "unknown", "catégorie « undefined » (la « No category » de Jira) → `unknown`");
    ck.eq(JiraParse.statusCategory(null), "unknown", "statusCategory : entrée nulle tolérée");
    ck(ISSUE_STATUS_CATEGORIES.includes(categoryOf("cosmic")), "catégorie : la valeur produite appartient TOUJOURS à l'ensemble FERMÉ du partagé");

    // -- PERSONNES : un identifiant opaque n'est PAS un nom affichable. --
    ck.eq(JiraParse.issueRecord(fixtureIssue("9", "K-9", { assignee: { accountId: "5b10a2…" } }), BASE).assignee, null,
      "personne : `accountId` seul → null (le pivot veut un nom AFFICHABLE, pas un identifiant opaque)");
    ck.eq(JiraParse.issueRecord(fixtureIssue("9", "K-9", { assignee: { emailAddress: "x@y.z" } }), BASE).assignee, "x@y.z",
      "personne : l'adresse e-mail sert de DERNIER repli (displayName souvent masqué par la confidentialité Atlassian)");

    // -- ÉTIQUETTES : nettoyées, mais NI triées NI dédupliquées ici (c'est la frontière PARTAGÉE qui
    //    canonise — le faire deux fois de deux façons est ce qui produit un faux delta à chaque passe). --
    const labels = JiraParse.issueRecord(fixtureIssue("9", "K-9", { labels: ["b", "  a  ", "", 42, null, "b"] }), BASE).labels;
    ck.eq(JSON.stringify(labels), JSON.stringify(["b", "a", "b"]),
      "labels : rognées, vides et non-chaînes écartées — ordre CONSERVÉ et doublon GARDÉ (la canonisation appartient à IssueSync)");
    ck.eq(JSON.stringify(IssueSync.normalizeLabels(labels)), JSON.stringify(["a", "b"]), "labels : … et la frontière partagée les canonise bien ensuite (tri + dédup)");

    // -- LISTE : inexploitables écartés, DOUBLONS d'ext_id écartés (le premier gagne). --
    const list = JiraParse.issueRecords([fixtureIssue("1", "A-1"), null, fixtureIssue("1", "A-1-bis"), fixtureIssue("2", "A-2"), { key: "sans-id" }], BASE);
    ck.eq(list.length, 2, "issueRecords : inexploitables et doublons d'ext_id écartés");
    ck.eq(list[0].key, "A-1", "issueRecords : sur un doublon d'ext_id, le PREMIER gagne");
    ck.eq(JiraParse.issueRecords("pas un tableau", BASE).length, 0, "issueRecords : forme inattendue → [] (aucune exception)");
  }
  });

  /* ============ SERVEUR : pagination pure, JQL, références saisies ============ */

  await section("Serveur : JiraParse — pagination PURE (garde-fous un par un, DEUX formes d'API), JQL, référence saisie", async () => {
  {
    // -- Enveloppe : les deux formes, un tableau nu, et n'importe quoi. --
    ck.eq(JSON.stringify(JiraParse.page(null)), JSON.stringify({ items: [], nextPageToken: null, isLast: null, startAt: null, total: null }), "page : entrée nulle → page vide");
    ck.eq(JiraParse.page([1, 2]).items.length, 2, "page : TABLEAU nu accepté");
    const modern = JiraParse.page({ issues: [1], nextPageToken: "t2", isLast: false });
    ck(modern.nextPageToken === "t2" && modern.isLast === false, "page : forme ACTUELLE (nextPageToken / isLast) décodée");
    const legacy = JiraParse.page({ issues: [1], startAt: 50, total: 120 });
    ck(legacy.startAt === 50 && legacy.total === 120, "page : forme HISTORIQUE (startAt / total) décodée");
    ck.eq(JiraParse.page({ issues: [1], nextPageToken: "   " }).nextPageToken, null, "page : jeton blanc → « non remonté » (jamais une chaîne vide qui ferait boucler)");
    ck.eq(JiraParse.page({ issues: [1], total: "beaucoup" }).total, null, "page : total exotique → « non remonté », jamais une exception");

    // -- nextCursor : CHAQUE garde-fou testé SÉPARÉMENT (c'est la règle qui, mal écrite, boucle à l'infini). --
    const P = (over) => Object.assign({ items: [], nextPageToken: null, isLast: null, startAt: null, total: null }, over);
    const items = (n) => new Array(n).fill(0);
    ck.eq(JiraParse.nextCursor(P({ items: items(10) }), 0, 0), null, "garde-fou 1 : limite non positive → arrêt (configuration absurde)");
    ck.eq(JiraParse.nextCursor(P({ items: [] }), 0, 10), null, "garde-fou 2 : page VIDE → arrêt (fin nominale)");
    ck.eq(JiraParse.nextCursor(P({ items: items(10), isLast: true, nextPageToken: "t" }), 0, 10), null,
      "garde-fou 3 : `isLast` explicite → arrêt, MÊME si un jeton traîne (le tracker a parlé)");
    ck.eq(JSON.stringify(JiraParse.nextCursor(P({ items: items(3), nextPageToken: "t9" }), 0, 10)), JSON.stringify({ token: "t9" }),
      "garde-fou 4 : jeton présent → on continue AVEC lui, même sur une page incomplète (une info EXACTE prime sur une déduction)");
    ck.eq(JiraParse.nextCursor(P({ items: items(9) }), 0, 10), null, "garde-fou 5 : page incomplète SANS jeton → dernière page (forme historique)");
    ck.eq(JiraParse.nextCursor(P({ items: items(10), total: 10 }), 0, 10), null, "garde-fou 6 : total ANNONCÉ atteint → arrêt");
    ck.eq(JSON.stringify(JiraParse.nextCursor(P({ items: items(10), total: 25 }), 10, 10)), JSON.stringify({ startAt: 20 }),
      "garde-fou 7 : sinon on repart au décalage suivant, calculé sur l'offset DEMANDÉ (jamais celui que l'API renvoie)");
    ck.eq(JSON.stringify(JiraParse.nextCursor(P({ items: items(10), startAt: 999 }), 0, 10)), JSON.stringify({ startAt: 10 }),
      "nextCursor : un `startAt` fantaisiste renvoyé par l'API ne fait ni boucler ni sauter (il est IGNORÉ)");

    // -- JQL : la liste d'identifiants, et l'anti-injection. --
    ck.eq(JiraParse.jqlIdList(["10001", "10002"]), "10001, 10002", "jqlIdList : les identifiants NUMÉRIQUES passent nus");
    ck.eq(JiraParse.jqlIdList([" 10001 ", "", null, 10002]), "10001, 10002", "jqlIdList : rognage, vides et non-chaînes écartés, nombres acceptés");
    ck.eq(JiraParse.jqlIdList(["INFRA-1"]), '"INFRA-1"', "jqlIdList : une CLÉ est citée (elle n'est pas numérique)");
    ck.eq(JiraParse.jqlIdList(['a"b\\c']), '"a\\"b\\\\c"', "jqlIdList : guillemets et contre-obliques ÉCHAPPÉS");
    const injected = JiraParse.jqlIdList(['1) OR project = "SECRET"']);
    ck(injected.startsWith('"') && injected.endsWith('"') && !/^\d/.test(injected),
      "jqlIdList : 🚨 une valeur forgée reste ENTIÈREMENT citée — elle ne peut pas refermer la parenthèse et poursuivre la requête");

    // -- Références saisies (porte d'entrée « Suivre un ticket »). --
    ck.eq(JiraParse.referenceToIdOrKey("INFRA-123"), "INFRA-123", "référence : une clé passe telle quelle");
    ck.eq(JiraParse.referenceToIdOrKey("  infra-123 "), "INFRA-123", "référence : rognée et mise en CAPITALES (les clés Jira le sont toujours)");
    ck.eq(JiraParse.referenceToIdOrKey("10042"), "10042", "référence : un identifiant interne est accepté aussi");
    ck.eq(JiraParse.referenceToIdOrKey(BASE + "/browse/INFRA-123"), "INFRA-123", "référence : URL d'INTERFACE collée depuis le navigateur");
    ck.eq(JiraParse.referenceToIdOrKey(BASE + "/browse/INFRA-123?focusedCommentId=99#c99"), "INFRA-123", "référence : … query et fragment ignorés");
    ck.eq(JiraParse.referenceToIdOrKey(BASE + "/rest/api/3/issue/10042"), "10042", "référence : URL d'API acceptée aussi (on prend le segment après le marqueur, jamais le dernier en aveugle)");
    ck.eq(JiraParse.referenceToIdOrKey(BASE + "/jira/software/projects/INFRA/boards/1?selectedIssue=INFRA-9"), "INFRA-9", "référence : URL de TABLEAU (paramètre selectedIssue)");
    for (const junk of ["", "   ", "n'importe quoi", "INFRA", "-12", BASE + "/", BASE + "/browse/pas-une-cle", null, 42]) {
      ck.eq(JiraParse.referenceToIdOrKey(junk), null, "référence : " + JSON.stringify(junk) + " → null (on préfère refuser que suivre le MAUVAIS ticket)");
    }
  }
  });

  /* ============ SERVEUR : orchestration de l'adaptateur (stub HTTP structurel) ============ */

  await section("Serveur : JiraAdapter.resolve — LOTS, partage found/missing, pagination, cap dur, estampillage", async () => {
  {
    const pool = [fixtureIssue("10001", "INFRA-1"), fixtureIssue("10002", "INFRA-2")];
    const stub = mkJiraStub({ ["POST " + JiraAdapter.PATH_SEARCH]: searchRoute(pool) });
    const out = await new JiraAdapter(CFG, stub).resolve(["10001", "10002", "10003"]);

    ck.eq(out.found.length, 2, "resolve : les tickets RÉSOLUS reviennent");
    ck.eq(JSON.stringify(out.missing), JSON.stringify(["10003"]), "resolve : l'identifiant non revenu ressort en `missing` (c'est le SERVICE qui en déduira `orphan`)");
    ck.eq(stub.calls.length, 1, "resolve : 🚨 UNE SEULE requête pour 3 identifiants — résolution PAR LOTS, jamais N requêtes unitaires");
    ck.eq(stub.calls[0].path, JiraAdapter.PATH_SEARCH, "resolve : … sur le chemin de recherche isolé en constante");
    ck.eq(idsInJql(stub.calls[0].body).join(","), "10001,10002,10003", "resolve : les 3 identifiants voyagent dans la MÊME clause JQL");
    ck.eq(JSON.stringify(stub.calls[0].body.fields), JSON.stringify(JiraAdapter.FIELDS), "resolve : seuls les champs du PIVOT sont demandés (jamais `*all` — les champs perso d'un projet pèsent lourd)");
    ck(out.found.every((r) => r.provider_id === "tr-1"), "resolve : `provider_id` ESTAMPILLÉ par l'adaptateur");
    ck(out.found.every((r) => r.orphan === false && r.last_sync === ""), "resolve : `orphan`/`last_sync` laissés à l'autorité du service");
    ck(!JSON.stringify(stub.calls).includes("JETON-TRES-SECRET"), "resolve : le jeton n'apparaît dans AUCUN chemin ni corps de requête");

    // Entrée vide / bruitée : aucune requête (une clause « id IN () » serait un JQL invalide).
    const idle = mkJiraStub({});
    ck.eq(JSON.stringify(await new JiraAdapter(CFG, idle).resolve([])), JSON.stringify({ found: [], missing: [] }), "resolve : aucun identifiant → aucun appel, résultat vide");
    ck.eq(idle.calls.length, 0, "resolve : … et vraiment AUCUN appel réseau");
    const noisy = mkJiraStub({ ["POST " + JiraAdapter.PATH_SEARCH]: searchRoute(pool) });
    const dedup = await new JiraAdapter(CFG, noisy).resolve(["10001", " 10001 ", "", null, "10001"]);
    ck.eq(JSON.stringify(dedup.missing), "[]", "resolve : identifiants DÉDUPLIQUÉS et rognés (sinon le même id ressortirait deux fois en `missing`)");
    ck.eq(idsInJql(noisy.calls[0].body).length, 1, "resolve : … et le lot ne porte qu'une occurrence");

    // LOTS : au-delà de BATCH_SIZE, plusieurs requêtes — mais toujours pas une par ticket.
    const many = new Array(JiraAdapter.BATCH_SIZE + 50).fill(0).map((_, i) => String(20000 + i));
    const batched = mkJiraStub({ ["POST " + JiraAdapter.PATH_SEARCH]: searchRoute([]) });
    await new JiraAdapter(CFG, batched).resolve(many);
    ck.eq(batched.calls.length, 2, "lots : " + many.length + " identifiants → 2 requêtes (⌈N/BATCH_SIZE⌉), pas " + many.length);
    ck.eq(idsInJql(batched.calls[0].body).length, JiraAdapter.BATCH_SIZE, "lots : le premier lot est PLEIN");
    ck.eq(idsInJql(batched.calls[1].body).length, 50, "lots : le second porte le reste");

    // PAGINATION réelle par JETON (forme actuelle de l'API).
    const page1 = new Array(JiraAdapter.BATCH_SIZE).fill(0).map((_, i) => fixtureIssue("3" + String(i).padStart(4, "0"), "P-" + i));
    const page2 = [fixtureIssue("40000", "P-last")];
    const paged = mkJiraStub({
      ["POST " + JiraAdapter.PATH_SEARCH]: (body) => (body.nextPageToken === "PAGE-2"
        ? { issues: page2 }
        : { issues: page1, nextPageToken: "PAGE-2" }),
    });
    const pagedOut = await new JiraAdapter(CFG, paged).resolve(["40000"]);
    ck.eq(paged.calls.length, 2, "pagination : la 2e page est demandée AVEC le jeton rendu par la 1re");
    ck.eq(paged.calls[1].body.nextPageToken, "PAGE-2", "pagination : … le jeton est bien réinjecté dans le corps");
    ck.eq(pagedOut.found.length, JiraAdapter.BATCH_SIZE + 1, "pagination : les pages sont concaténées");
    ck.eq(JSON.stringify(pagedOut.missing), "[]", "pagination : l'identifiant demandé est retrouvé sur la DERNIÈRE page");

    // CAP DUR : un tracker qui rendrait éternellement une page pleine + un jeton ne doit pas boucler.
    const looping = mkJiraStub({ ["POST " + JiraAdapter.PATH_SEARCH]: () => ({ issues: page1, nextPageToken: "ENCORE" }) });
    const capped = await new JiraAdapter(CFG, looping).resolve(["99999"]);
    ck.eq(looping.calls.length, JiraAdapter.MAX_PAGES_PER_BATCH, "cap dur : la boucle s'arrête à MAX_PAGES_PER_BATCH (tracker qui ignore la pagination)");
    ck.eq(capped.found.length, JiraAdapter.BATCH_SIZE, "cap dur : on rend ce qu'on a, DÉDUPLIQUÉ, plutôt que de perdre le lot");
    ck.eq(JSON.stringify(capped.missing), JSON.stringify(["99999"]), "cap dur : … et l'identifiant jamais revenu ressort en `missing` — l'anomalie reste VISIBLE à l'écran");

    // ÉCHEC de la résolution : rejet (le service journalisera et conservera l'état du document).
    let threw = null;
    try { await new JiraAdapter(CFG, mkJiraStub({ ["POST " + JiraAdapter.PATH_SEARCH]: new Error("Tracker : HTTP 500") })).resolve(["1"]); } catch (e) { threw = e; }
    ck(threw !== null && /500/.test(threw.message), "resolve : échec de la RÉSOLUTION → rejet (un ticket simplement introuvable, lui, n'est pas un échec)");
  }
  });

  await section("Serveur : JiraAdapter.lookup — clé, URL, 404 → null, erreurs de PROVIDER remontées", async () => {
  {
    const routes = {
      ["GET " + JiraAdapter.pathIssue("INFRA-123")]: fixtureIssue("10042", "INFRA-123"),
      ["GET " + JiraAdapter.pathIssue("10042")]: fixtureIssue("10042", "INFRA-123"),
    };
    const stub = mkJiraStub(routes);
    const adapter = new JiraAdapter(CFG, stub);

    const byKey = await adapter.lookup("INFRA-123");
    ck.eq(byKey.ext_id, "10042", "lookup : la CLÉ saisie est résolue en identifiant INTERNE (c'est lui qu'on persiste — décision structurante)");
    ck.eq(byKey.provider_id, "tr-1", "lookup : provider_id estampillé");
    ck(stub.calls[0].path.includes("fields="), "lookup : seuls les champs du pivot sont demandés");

    ck.eq((await adapter.lookup(BASE + "/browse/INFRA-123")).ext_id, "10042", "lookup : URL collée depuis le navigateur → même ticket");
    ck.eq((await adapter.lookup("10042")).key, "INFRA-123", "lookup : identifiant interne accepté aussi");

    const before = stub.calls.length;
    ck.eq(await adapter.lookup("n'importe quoi"), null, "lookup : référence inexploitable → null");
    ck.eq(stub.calls.length, before, "lookup : … SANS le moindre appel réseau (rien à demander)");
    ck.eq(await adapter.lookup("ABSENT-9"), null, "lookup : ticket inexistant/inaccessible (404) → null, aucun enregistrement fantôme");

    // 401 : ce n'est pas le TICKET qui pose problème, c'est le PROVIDER → l'erreur doit remonter.
    let authErr = null;
    const denied = mkJiraStub({ ["GET " + JiraAdapter.pathIssue("INFRA-1")]: Object.assign(new Error("Tracker : authentification refusée (401)"), { status: 401 }) });
    try { await new JiraAdapter(CFG, denied).lookup("INFRA-1"); } catch (e) { authErr = e; }
    ck(authErr !== null && /401/.test(authErr.message), "lookup : 401/403 REMONTE (problème de provider, message actionnable) — seul le 404 devient `null`");
  }
  });

  await section("Serveur : JiraAdapter.createIssue — ADF, options du provider, échec Jira au message INTACT", async () => {
  {
    const created = { id: "10500", key: "INFRA-500", self: BASE + "/rest/api/3/issue/10500" };
    const stub = mkJiraStub({
      ["POST " + JiraAdapter.PATH_ISSUE_CREATE]: created,
      ["GET " + JiraAdapter.pathIssue("10500")]: fixtureIssue("10500", "INFRA-500"),
    });
    const record = await new JiraAdapter(CFG, stub).createIssue({ summary: "  Panne cœur  ", description: "ligne 1\n\nligne 3" });

    const body = stub.calls[0].body;
    ck.eq(body.fields.project.key, "INFRA", "createIssue : le PROJET vient des OPTIONS du provider (l'utilisateur n'a pas à connaître la config du tracker)");
    ck.eq(body.fields.issuetype.name, "Tâche", "createIssue : le TYPE aussi (libellé du projet, pas une énumération)");
    ck.eq(body.fields.summary, "Panne cœur", "createIssue : titre rogné");
    ck.eq(body.fields.description.type, "doc", "createIssue : 🚨 la description est un document ADF, JAMAIS une chaîne (l'API v3 la refuserait)");
    ck.eq(body.fields.description.content.length, 3, "createIssue : … construit ligne à ligne");
    ck.eq(record.ext_id, "10500", "createIssue : le pivot rendu porte l'identifiant interne");
    ck.eq(record.summary, "Ticket INFRA-500", "createIssue : le ticket est RELU pour obtenir statut/type/dates (la réponse de création ne les porte pas)");
    ck.eq(record.status_category, "in_progress", "createIssue : … donc la catégorie d'état est renseignée");
    ck.eq(record.provider_id, "tr-1", "createIssue : provider_id estampillé");

    // 🚨 REFUS DU TRACKER : le message d'origine remonte TEL QUEL — c'est lui qui est actionnable.
    const refusal = "Tracker : HTTP 400 sur /rest/api/3/issue — customfield_10010 : Le champ « Équipe » est requis";
    let refused = null;
    try {
      await new JiraAdapter(CFG, mkJiraStub({ ["POST " + JiraAdapter.PATH_ISSUE_CREATE]: Object.assign(new Error(refusal), { status: 400 }) }))
        .createIssue({ summary: "x", description: "" });
    } catch (e) { refused = e; }
    ck.eq(refused && refused.message, refusal,
      "createIssue : le refus du tracker remonte MOT POUR MOT — l'envelopper dans un « échec de création » générique détruirait la seule information exploitable");

    // Relecture en échec APRÈS création réussie : on ne perd JAMAIS le ticket créé.
    const orphanRead = mkJiraStub({ ["POST " + JiraAdapter.PATH_ISSUE_CREATE]: created });   // la route GET n'existe pas → 404
    const minimal = await new JiraAdapter(CFG, orphanRead).createIssue({ summary: "Titre local", description: "" });
    ck.eq(minimal.ext_id, "10500", "createIssue : relecture impossible → on rend quand même le pivot MINIMAL (le ticket EXISTE chez le tracker)");
    ck.eq(minimal.key, "INFRA-500", "createIssue : … avec sa clé");
    ck.eq(minimal.url, BASE + "/browse/INFRA-500", "createIssue : … et son lien d'interface");
    ck.eq(minimal.summary, "Titre local", "createIssue : … le titre saisi comblant l'absence de relecture");

    // Réponse de création sans identifiant : erreur AMBIGUË, mais qui cite la clé pour la rattraper.
    let lost = null;
    try {
      await new JiraAdapter(CFG, mkJiraStub({ ["POST " + JiraAdapter.PATH_ISSUE_CREATE]: { key: "INFRA-777" } })).createIssue({ summary: "x", description: "" });
    } catch (e) { lost = e; }
    ck(lost !== null && /INFRA-777/.test(lost.message) && /Suivre un ticket/.test(lost.message),
      "createIssue : réponse sans identifiant → l'erreur CITE la clé créée (jamais de suppression compensatoire chez le tracker)");

    // Garde-fous d'entrée : aucun appel réseau tant que la demande est inexploitable.
    const guarded = mkJiraStub({});
    let noProject = null;
    try { await new JiraAdapter({ ...CFG, options: { issue_type: "Task" } }, guarded).createIssue({ summary: "x", description: "" }); } catch (e) { noProject = e; }
    ck(noProject !== null && /project_key/.test(noProject.message), "createIssue : projet non configuré → message ACTIONNABLE nommant l'option à remplir");
    let noSummary = null;
    try { await new JiraAdapter(CFG, guarded).createIssue({ summary: "   ", description: "x" }); } catch (e) { noSummary = e; }
    ck(noSummary !== null && /titre/i.test(noSummary.message), "createIssue : titre vide → refus explicite");
    ck.eq(guarded.calls.length, 0, "createIssue : … et AUCUN appel réseau n'a été tenté dans ces deux cas");
  }
  });

  await section("Serveur : JiraAdapter.test — joignabilité, sonde NON bloquante de l'API de recherche, jeton absent", async () => {
  {
    const okStub = mkJiraStub({
      ["GET " + JiraAdapter.PATH_MYSELF]: { accountId: "acc-1", displayName: "Compte de service", emailAddress: "svc@example.net" },
      ["POST " + JiraAdapter.PATH_SEARCH]: { issues: [], isLast: true },
    });
    const ok = await new JiraAdapter(CFG, okStub).test();
    ck(ok.ok === true && ok.supported === true, "test : instance joignable + API de recherche présente → ok + supported");
    ck.eq(ok.kind, "jira", "test : kind remonté");
    ck(/Compte de service/.test(ok.message), "test : le message nomme le compte reconnu");
    ck.eq(ok.version, null, "test : version null (le chemin du compte ne la porte pas — on n'ajoute pas un appel pour un champ cosmétique)");
    ck.eq(okStub.calls[1].body.maxResults, 1, "test : la sonde de recherche est VOLONTAIREMENT minuscule (maxResults 1)");

    // La sonde échoue → l'AUTH est prouvée, donc `ok` reste vrai : c'est un AVERTISSEMENT précis.
    const probeKo = await new JiraAdapter(CFG, mkJiraStub({
      ["GET " + JiraAdapter.PATH_MYSELF]: { displayName: "svc" },
      ["POST " + JiraAdapter.PATH_SEARCH]: Object.assign(new Error("Tracker : ressource introuvable (404)"), { status: 404 }),
    })).test();
    ck(probeKo.ok === true && probeKo.supported === false, "test : recherche muette → ok:true, supported:false (l'authentification, elle, est prouvée)");
    ck(probeKo.message.includes(JiraAdapter.PATH_SEARCH), "test : … et le message NOMME le chemin en cause (c'est l'hypothèse d'API la plus fragile du lot)");

    // Auth refusée → ok:false, et JAMAIS le jeton dans le message.
    const ko = await new JiraAdapter(CFG, mkJiraStub({
      ["GET " + JiraAdapter.PATH_MYSELF]: new Error("Tracker : authentification refusée (401) — vérifiez le compte de service et son jeton d'API"),
    })).test();
    ck(ko.ok === false && /401/.test(ko.message), "test : authentification refusée → ok:false + message");
    ck(!ko.message.includes("JETON-TRES-SECRET"), "test : le message ne contient JAMAIS le jeton");
    ck.eq(new JiraAdapter(CFG, mkJiraStub({})).kind, "jira", "adaptateur : `kind` déclaré (clé de la fabrique et de la branche d'options)");
  }
  });

  /* ============ SERVEUR : client HTTP (parties pures + flux réel sur `fetch` injecté) ============ */

  await section("Serveur : JiraHttp — parties PURES (Basic, Retry-After, message d'erreur du tracker, réseau)", async () => {
  {
    // -- AUTH BASIC : `base64(compte:jeton)`. --
    ck.eq(JiraHttp.authHeader("svc@example.net", "SECRET"), "Basic " + Buffer.from("svc@example.net:SECRET", "utf8").toString("base64"), "authHeader : Basic base64(compte:jeton)");

    // -- Retry-After : les DEUX formes de la RFC, horloge INJECTÉE (fonction pure). --
    ck.eq(JiraHttp.retryAfterMs("30", 0), 30_000, "retryAfterMs : forme « secondes »");
    ck.eq(JiraHttp.retryAfterMs("  5  ", 0), 5_000, "retryAfterMs : rognée");
    ck.eq(JiraHttp.retryAfterMs(new Date(10_000).toUTCString(), 0), 10_000, "retryAfterMs : forme DATE HTTP, relative à l'horloge injectée");
    ck.eq(JiraHttp.retryAfterMs(new Date(10_000).toUTCString(), 60_000), 0, "retryAfterMs : date PASSÉE → 0 (réessayer tout de suite, c'est ce qui est demandé)");
    for (const junk of ["", "   ", "bientôt", null, undefined]) ck.eq(JiraHttp.retryAfterMs(junk, 0), null, "retryAfterMs : " + JSON.stringify(junk) + " → null (l'appelant retombe sur son défaut)");

    // -- 🚨 Message d'erreur DU TRACKER : c'est lui qui rend une création refusée exploitable. --
    ck.eq(JiraHttp.errorDetail(JSON.stringify({ errorMessages: ["Issue does not exist"] })), "Issue does not exist", "errorDetail : `errorMessages`");
    ck.eq(JiraHttp.errorDetail(JSON.stringify({ errors: { customfield_10010: "Le champ « Équipe » est requis" } })), "customfield_10010 : Le champ « Équipe » est requis",
      "errorDetail : les erreurs PAR CHAMP conservent le nom du champ fautif (c'est ce qui est actionnable)");
    ck.eq(JiraHttp.errorDetail(JSON.stringify({ errorMessages: ["A"], errors: { f: "B" } })), "A ; f : B", "errorDetail : les deux sources sont agrégées");
    ck.eq(JiraHttp.errorDetail(JSON.stringify({ message: "seul" })), "seul", "errorDetail : repli sur un simple `message`");
    for (const junk of ["", "pas du json", "<html>", JSON.stringify([1, 2]), JSON.stringify({ errorMessages: [], errors: {} })]) {
      ck.eq(JiraHttp.errorDetail(junk), "", "errorDetail : corps inexploitable (" + junk.slice(0, 12) + ") → \"\" (aucune exception)");
    }

    // -- Réseau : le `fetch` de Node emballe le VRAI code dans `cause` — sans déballage, tout se
    //    ressemblerait (« fetch failed »). --
    const wrapped = JiraHttp.explainNetworkError(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND tracker"), { code: "ENOTFOUND" }) }), "https://t/x");
    ck(wrapped instanceof JiraHttpError && wrapped.retryable === true, "explainNetworkError : erreur réseau → JiraHttpError retryable");
    ck(/nom d'hôte introuvable/.test(wrapped.message), "explainNetworkError : le code EMBALLÉ dans `cause` est déballé et EXPLIQUÉ");
    ck(/fetch failed/.test(wrapped.message) && /getaddrinfo/.test(wrapped.message) && /https:\/\/t\/x/.test(wrapped.message), "explainNetworkError : message technique conservé + cible citée");
    ck(/connexion refusée/.test(JiraHttp.explainNetworkError({ code: "ECONNREFUSED", message: "refus" }, "t").message), "explainNetworkError : code posé DIRECTEMENT sur l'erreur reconnu aussi");
    ck(/inconnu/.test(JiraHttp.explainNetworkError(new Error("inconnu"), "t").message), "explainNetworkError : code inconnu → message brut conservé");
    ck(/cause profonde/.test(new JiraHttpError("x", true, null, new Error("cause profonde")).fullStack()), "JiraHttpError.fullStack : la pile de la CAUSE est jointe");
  }
  });

  await section("Serveur : JiraHttp — flux réel sur `fetch` INJECTÉ (429 borné, statuts, cap de réponse, jeton jamais cité)", async () => {
  {
    const TOKEN = "JETON-TRES-SECRET";
    const ACCOUNT = "svc@example.net";
    /** Réponse SANS flux (chemin de repli `text()`) — c'est la forme la plus simple à stuber. */
    const mkResponse = (status, body, headers) => ({
      status,
      headers: { get: (n) => { const h = headers || {}; const k = Object.keys(h).find((x) => x.toLowerCase() === String(n).toLowerCase()); return k === undefined ? null : String(h[k]); } },
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    });
    /** Réponse AVEC flux (chemin nominal du `fetch` réel) — `cancelled` compte les interruptions. */
    const mkStream = (status, chunks, sink) => ({
      status,
      headers: { get: () => null },
      body: { getReader: () => { let i = 0; return { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), cancel: async () => { sink.cancelled++; } }; } },
    });
    const mkHttp = (fetchImpl, sleep) => new JiraHttp(BASE, ACCOUNT, TOKEN, 1000, fetchImpl, sleep || (async () => { }));

    // -- Requête NOMINALE : en-têtes, corps, verbe. --
    const seen = [];
    const okFetch = async (url, init) => { seen.push({ url, init }); return mkResponse(200, { ok: true }); };
    ck.eq((await mkHttp(okFetch).getJson("/rest/api/3/myself")).ok, true, "getJson : corps JSON rendu");
    ck.eq(seen[0].url, BASE + "/rest/api/3/myself", "getJson : URL absolue composée sur la base de l'instance");
    ck.eq(seen[0].init.headers.Authorization, JiraHttp.authHeader(ACCOUNT, TOKEN), "getJson : en-tête Authorization Basic posé");
    ck(seen[0].init.signal !== undefined, "getJson : un signal d'abandon (délai) accompagne CHAQUE tentative");
    await mkHttp(okFetch).postJson("/x", { jql: "id IN (1)" });
    ck.eq(seen[1].init.method, "POST", "postJson : verbe POST");
    ck.eq(seen[1].init.headers["Content-Type"], "application/json", "postJson : Content-Type JSON");
    ck.eq(JSON.parse(seen[1].init.body).jql, "id IN (1)", "postJson : corps sérialisé en JSON");

    // -- 429 : on honore `Retry-After`, un PETIT nombre de fois, puis on abandonne PROPREMENT. --
    const waits = [];
    let attempt = 0;
    const throttled = async () => { attempt++; return attempt <= 2 ? mkResponse(429, "", { "retry-after": "1" }) : mkResponse(200, { done: true }); };
    ck.eq((await mkHttp(throttled, async (ms) => { waits.push(ms); }).getJson("/x")).done, true, "429 : la requête aboutit après les attentes demandées");
    ck.eq(JSON.stringify(waits), JSON.stringify([1000, 1000]), "429 : l'attente honorée est bien celle de `Retry-After` (1 s), pas une constante maison");
    ck.eq(attempt, 3, "429 : exactement une tentative de plus par attente (on ne martèle jamais)");

    const waits2 = [];
    let calls429 = 0;
    let gaveUp = null;
    try { await mkHttp(async () => { calls429++; return mkResponse(429, "", { "retry-after": "1" }); }, async (ms) => { waits2.push(ms); }).getJson("/x"); } catch (e) { gaveUp = e; }
    ck(gaveUp instanceof JiraHttpError && gaveUp.status === 429 && gaveUp.retryable === true, "429 persistant : abandon PROPRE (erreur retryable portant le statut)");
    ck.eq(calls429, JiraHttp.MAX_RETRIES_ON_THROTTLE + 1, "429 persistant : le nombre de tentatives est BORNÉ par MAX_RETRIES_ON_THROTTLE");
    ck(/espacez la synchro/.test(gaveUp.message), "429 persistant : message ACTIONNABLE (la passe reprendra au prochain réveil)");

    let longWait = null;
    const waits3 = [];
    try { await mkHttp(async () => mkResponse(429, "", { "retry-after": "3600" }), async (ms) => { waits3.push(ms); }).getJson("/x"); } catch (e) { longWait = e; }
    ck(longWait !== null && waits3.length === 0, "429 : une attente demandée AU-DELÀ du plafond fait abandonner TOUT DE SUITE (on ne bloque pas la passe une heure)");

    // -- Statuts : la distinction 404 est ce qui permet à `lookup` de rendre `null`. --
    const status = async (code, body, headers) => { let e = null; try { await mkHttp(async () => mkResponse(code, body, headers)).getJson("/x"); } catch (err) { e = err; } return e; };
    const e401 = await status(401, "");
    ck(e401.status === 401 && e401.retryable === false && /authentification refusée/.test(e401.message), "401 : erreur APPLICATIVE (le tracker a répondu), message actionnable");
    ck(!e401.message.includes(TOKEN) && !e401.message.includes(JiraHttp.authHeader(ACCOUNT, TOKEN)), "401 : ni le jeton ni l'en-tête d'autorisation n'apparaissent dans le message");
    const e404 = await status(404, { errorMessages: ["Issue does not exist"] });
    ck(e404.status === 404, "404 : statut porté par l'erreur (c'est ainsi que `lookup` reconnaît un ticket inexistant)");
    ck(/Issue does not exist/.test(e404.message), "404 : … et le message du tracker est joint");
    ck(/Le champ « Équipe » est requis/.test((await status(400, { errors: { customfield_10010: "Le champ « Équipe » est requis" } })).message),
      "4xx : 🚨 le message du tracker est REMONTÉ (c'est ce qui rend une création refusée exploitable)");
    ck(/non-JSON/.test((await status(200, "<html>page de connexion</html>")).message), "200 non-JSON → message qui met sur la piste d'une page d'authentification");
    ck.eq(await mkHttp(async () => mkResponse(204, "")).getJson("/x"), null, "204 / corps vide → null (ce n'est pas une anomalie)");

    // -- CAP DE RÉPONSE : les DEUX chemins (taille annoncée, puis octets réellement reçus). --
    ck(/trop volumineuse/.test((await status(200, "{}", { "content-length": String(JiraHttp.MAX_RESPONSE_BYTES + 1) })).message),
      "cap : une taille ANNONCÉE au-delà du plafond est refusée sans lire un octet");
    const sink = { cancelled: 0 };
    const encoder = new TextEncoder();
    ck.eq((await mkHttp(async () => mkStream(200, [encoder.encode('{"a":'), encoder.encode("1}")], sink)).getJson("/x")).a, 1, "flux : le corps est décodé morceau par morceau (chemin nominal du fetch réel)");
    let tooBig = null;
    try { await mkHttp(async () => mkStream(200, [new Uint8Array(JiraHttp.MAX_RESPONSE_BYTES + 1)], sink)).getJson("/x"); } catch (e) { tooBig = e; }
    ck(tooBig !== null && /trop volumineuse/.test(tooBig.message), "cap : un flux qui dépasse le plafond est AVORTÉ, jamais accumulé");
    ck.eq(sink.cancelled, 1, "cap : … et le flux est explicitement annulé (la socket n'est pas laissée pendante)");

    // -- Délai et réseau. --
    let timeout = null;
    try { await mkHttp(async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); }).getJson("/x"); } catch (e) { timeout = e; }
    ck(timeout !== null && /délai dépassé/.test(timeout.message) && timeout.retryable === true, "délai : un abandon par signal devient un message de DÉLAI, pas une panne réseau");
    let netErr = null;
    try { await mkHttp(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "refus" } }); }).getJson("/x"); } catch (e) { netErr = e; }
    ck(netErr !== null && /connexion refusée/.test(netErr.message), "réseau : erreur traduite et actionnable");
  }
  });

  /* ============ SERVEUR : validation d'un provider (communs + options par marque) ============ */

  await section("Serveur : IssueProviderConfigValidate — champs communs, kind inconnu, options PAR MARQUE", async () => {
  {
    const { IssueProviderConfigValidate, IssueProviderConfigError, KIND_OPTION_SPECS, SUPPORTED_KINDS } = SERVER("issues/IssueProviderConfigValidate.js");
    const validate = (raw) => { const errors = []; const cfg = IssueProviderConfigValidate.parseProvider("doc-A", 0, raw, errors); return { cfg, errors }; };
    const SECRET = "jeton-api-tres-secret";
    const base = { id: "tr1", kind: "jira", url: BASE, token: SECRET, account: "svc@example.net" };

    // 1) DÉFAUTS des champs communs.
    const ok = validate(base);
    ck(ok.cfg !== null && ok.errors.length === 0, "provider minimal valide → config produite");
    ck(ok.cfg.interval_sec === 0 && ok.cfg.timeout_sec === IssueProviderConfigValidate.DEFAULT_TIMEOUT_SEC, "défauts : interval_sec 0 (manuelle), timeout_sec = DEFAULT_TIMEOUT_SEC");
    ck(ok.cfg.timeout_sec > 15, "défauts : délai PLUS GÉNÉREUX que les modules d'inventaire — une recherche SaaS n'est pas une lecture sur le LAN");
    ck(!("fingerprint" in ok.cfg) && !("ca_pem" in ok.cfg), "écart ASSUMÉ : aucun matériel TLS dans la config (un tracker SaaS a un certificat public — rien à épingler)");

    // 2) REQUIS + le jeton JAMAIS divulgué.
    ck(validate({ ...base, url: undefined }).errors.some((m) => /url/.test(m)), "url manquante → erreur citant le champ");
    ck(validate({ ...base, token: undefined }).errors.some((m) => /token/.test(m)), "token manquant → « token requis »");
    ck(validate({ ...base, account: undefined }).errors.some((m) => /account/.test(m)), "account manquant → erreur (moitié PUBLIQUE de l'identification)");
    ck(validate({ ...base, id: undefined }).errors.some((m) => /id/.test(m)), "id manquant → erreur");
    ck(!validate({ ...base, url: undefined, account: undefined }).errors.join("\n").includes(SECRET), "le jeton n'apparaît JAMAIS dans un message d'erreur");
    ck.eq(validate({ ...base, url: undefined, token: undefined, account: undefined }).errors.length, 3, "griefs GROUPÉS : tous les manques d'un même provider sont rendus d'un coup");
    ck(validate({ ...base, url: "http://tracker.example.net" }).errors.some((m) => /https/.test(m)), "url http → refusée (le jeton voyage en en-tête à chaque requête)");
    ck(validate({ ...base, url: "pas-une-url" }).errors.some((m) => /url/.test(m)), "url sans schéma → refusée");

    // 3) KIND INCONNU : erreur EXPLICITE listant les types supportés (la validation des options en dépend).
    const badKind = validate({ ...base, kind: "redmine" });
    ck(badKind.cfg === null && badKind.errors.some((m) => /kind/.test(m) && SUPPORTED_KINDS.every((k) => m.includes(k))),
      "kind inconnu → erreur ÉNUMÉRANT les types supportés (on n'enregistre pas un provider sans adaptateur)");
    ck.eq(SUPPORTED_KINDS.join(","), Object.keys(KIND_OPTION_SPECS).join(","), "SUPPORTED_KINDS est DÉRIVÉ de la table d'options (jamais une seconde liste)");

    // 4) OPTIONS PAR MARQUE : défauts posés, types contrôlés, clés INCONNUES écartées en silence.
    ck.eq(ok.cfg.options.issue_type, "Task", "options : `issue_type` absent → défaut « Task »");
    ck.eq(ok.cfg.options.project_key, "", "options : `project_key` absent → \"\" — un provider en LECTURE SEULE n'a aucun projet à désigner, le refuser serait une friction gratuite");
    const opts = validate({ ...base, options: { project_key: "INFRA", issue_type: "Tâche" } });
    ck(opts.cfg.options.project_key === "INFRA" && opts.cfg.options.issue_type === "Tâche", "options : valeurs fournies retenues (le type suit la LANGUE du projet)");
    ck(validate({ ...base, options: { issue_type: "   " } }).errors.some((m) => /issue_type/.test(m)), "options : `issue_type` vidé à la main → erreur (sinon création refusée en 400 illisible)");
    ck(validate({ ...base, options: { project_key: 42 } }).errors.some((m) => /project_key/.test(m)), "options : type erroné → erreur explicite");
    const unknownOpt = validate({ ...base, options: { project_key: "X", option_d_une_autre_marque: 42 } });
    ck(unknownOpt.cfg !== null && !("option_d_une_autre_marque" in unknownOpt.cfg.options),
      "options : clé INCONNUE écartée SILENCIEUSEMENT (une option d'une autre marque ne rend pas la config irrécupérable)");
    ck.eq(validate({ ...base, options: "pas un objet" }).cfg.options.issue_type, "Task", "options : forme inattendue → défauts (tolérance)");

    // 5) intervalles.
    ck(validate({ ...base, interval_sec: -1 }).errors.some((m) => /interval_sec/.test(m)), "interval_sec négatif → erreur");
    ck(validate({ ...base, timeout_sec: 0 }).errors.some((m) => /timeout_sec/.test(m)), "timeout_sec 0 → erreur");
    ck(validate("pas un objet").errors.some((m) => /objet/.test(m)), "provider non-objet → erreur");

    // 6) L'erreur porte les issues (rendues en 400 par les routes du lot L3).
    const err = new IssueProviderConfigError(["souci A", "souci B"]);
    ck(Array.isArray(err.issues) && err.issues.length === 2 && err.name === "IssueProviderConfigError", "IssueProviderConfigError porte les issues + message agrégé");
  }
  });

  /* ============ SERVEUR : stockage chiffré des providers (better-sqlite3 RÉEL) ============ */

  await section("Serveur : IssueProviderConfigDb — schéma, CRUD sans fuite de jeton, compte RELU, jeton indéchiffrable", async () => {
    // better-sqlite3 RÉEL requis (binaire natif) — même probe que les autres sections DB.
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probe = new Candidate(":memory:"); probe.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section IssueProviderConfigDb sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { IssueProviderConfigDb } = SERVER("issues/IssueProviderConfigDb.js");
    const { SecretBox } = SERVER("SecretBox.js");
    const { IssueProviderConfigError } = SERVER("issues/IssueProviderConfigValidate.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-issuedb-"));
    let raw = null;
    try {
      const box = new SecretBox("passphrase-infra-longue-de-test");
      const db = new IssueProviderConfigDb(dir, Sqlite, box);   // Logger "error" par défaut → silencieux

      // -- SCHÉMA : fichier matérialisé, UNE table, et SURTOUT aucun matériel TLS. --
      ck(fs.existsSync(path.join(dir, "issue-providers.db")), "issue-providers.db matérialisé dans le dossier injecté");
      raw = new Sqlite(path.join(dir, "issue-providers.db"));
      ck.eq(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name).join(","), "issue_providers",
        "schéma : UNE SEULE table (un tracker n'a qu'une instance — pas de pool d'endpoints)");
      const columns = raw.prepare("PRAGMA table_info(issue_providers)").all().map((r) => r.name);
      ck(columns.includes("account") && columns.includes("token_enc"), "schéma : `account` (public) et `token_enc` (chiffré) sont deux colonnes distinctes");
      ck(!columns.includes("fingerprint") && !columns.includes("ca_pem"), "schéma : écart ASSUMÉ à vm/ et wifi/ — AUCUNE colonne d'épinglage/CA (rien à épingler sur un service public)");

      // -- save (création) : jeton fourni, options normalisées ; réponse SANS jeton. --
      const saved = db.save("doc-A", { id: "tr1", kind: "jira", url: BASE, account: "svc@example.net", interval_sec: 900, options: { project_key: "INFRA", issue_type: "Tâche" } }, "JETON-1");
      ck(saved.id === "tr1" && saved.url === BASE, "save (création) → item renvoyé");
      ck.eq(saved.has_token, true, "save : has_token = true");
      ck.eq(saved.account, "svc@example.net", "save : le COMPTE est relu (ce n'est pas un secret — c'est toute la différence avec le jeton)");
      ck(saved.options.project_key === "INFRA" && saved.options.issue_type === "Tâche", "save : options de la marque restituées");
      ck(!("token" in saved) && !JSON.stringify(saved).includes("JETON-1"), "save : réponse SANS jeton (ni clair ni chiffré)");

      // -- listFor : SANS jeton ; le jeton est CHIFFRÉ en base. --
      const list = db.listFor("doc-A");
      ck(list.length === 1 && !("token" in list[0]) && list[0].has_token === true, "listFor : jeton JAMAIS renvoyé (has_token seulement)");
      const row = raw.prepare("SELECT token_enc, account, options FROM issue_providers WHERE doc_id=? AND id=?").get("doc-A", "tr1");
      ck(/^v1:/.test(row.token_enc) && !row.token_enc.includes("JETON-1"), "DB : jeton stocké CHIFFRÉ (v1:…), jamais en clair");
      ck.eq(row.account, "svc@example.net", "DB : le compte, lui, est stocké EN CLAIR (il doit être réaffiché à l'édition)");
      ck.eq(JSON.parse(row.options).project_key, "INFRA", "DB : options persistées en JSON (aucune colonne par marque — ajouter une marque ne touche pas le schéma)");

      // -- providersFor : déchiffre → config utilisable par l'adaptateur. --
      const forSync = db.providersFor("doc-A");
      ck.eq(forSync[0].token, "JETON-1", "providersFor : jeton DÉCHIFFRÉ (config utilisable pour la synchro)");
      ck(forSync[0].account === "svc@example.net" && forSync[0].interval_sec === 900, "providersFor : compte + champs restitués");
      ck.eq(db.configuredDocIds().join(","), "doc-A", "configuredDocIds → documents configurés");

      // -- summariesFor : AUCUN jeton, ni URL, ni compte dans le chemin STATUT. --
      const sums = db.summariesFor("doc-A");
      ck(sums.length === 1 && !("token" in sums[0]) && sums[0].kind === "jira" && sums[0].interval_sec === 900, "summariesFor : id/kind/intervalle, AUCUN jeton");
      ck(!("url" in sums[0]) && !("account" in sums[0]), "summariesFor : résumé volontairement RÉDUIT (le statut n'a pas besoin de l'identification)");
      ck(!db.summariesFor("doc-inexistant").length, "summariesFor : document non configuré → []");

      // -- AUDIT « qui » (posé PAR LE SERVEUR). --
      db.save("doc-A", { id: "tr-aud", kind: "jira", url: BASE, account: "a@x.net" }, "JETON-AUD", "u-alice");
      let audit = raw.prepare("SELECT created_by, updated_by FROM issue_providers WHERE id='tr-aud'").get();
      ck(audit.created_by === "u-alice" && audit.updated_by === "u-alice", "audit : création → created_by/updated_by = id de l'auteur");
      db.save("doc-A", { id: "tr-aud", kind: "jira", url: BASE, account: "a@x.net", interval_sec: 60 }, null, "u-bob");
      audit = raw.prepare("SELECT created_by, updated_by FROM issue_providers WHERE id='tr-aud'").get();
      ck(audit.created_by === "u-alice" && audit.updated_by === "u-bob", "audit : mise à jour → created_by CONSERVÉ, updated_by rafraîchi");
      ck.eq(raw.prepare("SELECT created_by FROM issue_providers WHERE id='tr1'").get().created_by, null, "audit : écriture sans auteur → colonne NULL");
      db.remove("doc-A", "tr-aud");

      // -- save (édition, jeton vide → CONSERVÉ) : la sentinelle satisfait « token requis » sans rien stocker. --
      const upd = db.save("doc-A", { id: "tr1", kind: "jira", url: BASE, account: "autre@example.net", interval_sec: 1800, options: { project_key: "OPS" } }, null);
      ck.eq(upd.interval_sec, 1800, "save (édition) : champ mis à jour");
      ck.eq(db.providersFor("doc-A")[0].token, "JETON-1", "save (édition, jeton vide) : jeton EXISTANT conservé");
      ck.eq(upd.account, "autre@example.net", "save (édition) : le compte, lui, se met à jour normalement");
      ck.eq(upd.options.issue_type, "Task", "save (édition) : option non renvoyée → retour au DÉFAUT (les options sont remplacées en bloc)");

      // -- création SANS jeton / config invalide → IssueProviderConfigError, jeton jamais divulgué. --
      let noToken = null;
      try { db.save("doc-A", { id: "tr-new", kind: "jira", url: BASE, account: "a@x.net" }, null); } catch (e) { noToken = e; }
      ck(noToken instanceof IssueProviderConfigError && noToken.issues.some((m) => /token/.test(m)), "save (création sans jeton) → « token requis »");
      let invalid = null;
      try { db.save("doc-A", { id: "tr-bad", kind: "jira" }, "JETON-NOPE"); } catch (e) { invalid = e; }
      ck(invalid instanceof IssueProviderConfigError && !invalid.message.includes("JETON-NOPE"), "save invalide → erreur de validation, jeton jamais dans le message");

      // -- buildForTest : jeton du corps, sinon le STOCKÉ déchiffré (tester sans ressaisir). --
      ck.eq(db.buildForTest("doc-A", { id: "tr1", kind: "jira", url: BASE, account: "a@x.net" }, null).token, "JETON-1", "buildForTest : jeton vide + provider existant → jeton STOCKÉ déchiffré");
      ck.eq(db.buildForTest("doc-A", { id: "tr1", kind: "jira", url: BASE, account: "a@x.net" }, "NOUVEAU").token, "NOUVEAU", "buildForTest : jeton fourni → celui-là");

      ck.eq(db.remove("doc-A", "inexistant"), false, "remove (id inconnu) → false");

      // -- Jeton INDÉCHIFFRABLE (coffre à AUTRE clé) → provider EXCLU + erreur consultable, JAMAIS de throw global. --
      const db2 = new IssueProviderConfigDb(dir, Sqlite, new SecretBox("une-toute-autre-passphrase-de-test"));
      ck.eq(db2.providersFor("doc-A").length, 0, "jeton indéchiffrable (autre clé) → provider EXCLU de la synchro, sans exception");
      const errs = db2.tokenErrorsFor("doc-A");
      ck(errs.length === 1 && errs[0].id === "tr1" && /ressaisi/.test(errs[0].message) && !errs[0].message.includes("JETON-1"),
        "…erreur MÉMORISÉE consultable (id + « à ressaisir »), sans le jeton");
      ck.eq(db2.summariesFor("doc-A").length, 0, "…et le chemin STATUT l'exclut pareillement (précondition de sa réinjection en erreur par le lot L3)");
      db2.close();

      // -- Options ILLISIBLES en base (édition manuelle / version future) → {} plutôt qu'un throw. --
      raw.prepare("UPDATE issue_providers SET options = 'pas du json' WHERE id='tr1'").run();
      ck.eq(JSON.stringify(db.listFor("doc-A")[0].options), "{}", "options illisibles en base → {} (l'adaptateur retombe sur ses défauts, aucun throw)");

      db.close();
    } finally {
      try { if (raw) raw.close(); } catch (_) { /* déjà fermé */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* dossier temp (handles longs sous Windows) */ }
    }
  });

  /* ============ INVARIANTS : pivot ⇄ frontière partagée, et AGNOSTICISME de marque ============ */

  await section("Serveur : invariants — pivot ≡ ISSUE_SOURCE_FIELDS, agnosticisme de marque (aucun « jira » hors des points d'extension)", async () => {
  {
    const { ISSUE_RECORD_FIELDS, ISSUE_RECORD_FIELDS_ARE_EXHAUSTIVE } = SERVER("issues/IssueProvider.js");
    const { KIND_OPTION_SPECS, SUPPORTED_KINDS } = SERVER("issues/IssueProviderConfigValidate.js");

    // -- 1) PIVOT ⇄ FRONTIÈRE PARTAGÉE. Une dérive entre les deux ne se verrait qu'EN PRODUCTION
    //       (un champ jamais rafraîchi, ou un champ local écrasé par une passe). --
    ck.eq(ISSUE_RECORD_FIELDS.join(","), ISSUE_SOURCE_FIELDS.join(","),
      "pivot serveur ≡ ISSUE_SOURCE_FIELDS : mêmes champs, MÊME ORDRE (égalité stricte, pas un jeu d'ensembles)");
    ck.eq(ISSUE_RECORD_FIELDS_ARE_EXHAUSTIVE, true,
      "sonde de complétude : la liste couvre TOUS les champs de l'interface `IssueRecord` (vérifié à la COMPILATION — `tsc` échoue avant ce test si un champ manque)");
    // … et le décodeur produit EXACTEMENT ces champs-là, ni plus ni moins : c'est ce qui ferme la
    // boucle (une liste juste mais un décodeur incomplet laisserait un champ `undefined` filer).
    const decoded = JiraParse.issueRecord(fixtureIssue("1", "K-1"), BASE);
    ck.eq(Object.keys(decoded).sort().join(","), [...ISSUE_SOURCE_FIELDS].sort().join(","),
      "décodeur : un record produit porte EXACTEMENT les champs source (ni manque, ni champ fantôme)");
    ck(ISSUE_SOURCE_FIELDS.every((f) => decoded[f] !== undefined), "décodeur : aucun champ laissé `undefined` (les défauts sont explicites)");

    // -- 2) AGNOSTICISME DE MARQUE — l'exigence n°1 du chantier, donc TESTÉE et pas seulement
    //       affirmée. On relit les SOURCES (c'est le code ÉCRIT qu'on contrôle) et on refuse toute
    //       mention de marque hors commentaires : ceux-ci DOIVENT pouvoir citer la première
    //       implémentation, ils l'expliquent. Seule la branche `KIND_OPTION_SPECS` y échappe, par
    //       construction : elle EST le point d'extension. --
    const fs = require("fs");
    const ts = require("typescript");
    /** Littéraux et identifiants nommant une marque dans un fichier, hors d'une déclaration exemptée. */
    const brandOffenders = (file, exemptDeclaration) => {
      const full = path.join(__dirname, "..", "..", "src-server", "src", "issues", file);
      const source = ts.createSourceFile(file, fs.readFileSync(full, "utf8"), ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
      const offenders = [];
      const visit = (node) => {
        if (exemptDeclaration && ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.name.text === exemptDeclaration) return;
        if (ts.isStringLiteralLike(node) && /jira/i.test(node.text)) offenders.push(node.text);
        if (ts.isIdentifier(node) && /jira/i.test(node.text)) offenders.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(source);
      return offenders;
    };

    for (const file of ["IssueProvider.ts", "IssueProviderConfigDb.ts"]) {
      ck.eq(brandOffenders(file, null).length, 0, "agnosticisme : « " + file + " » ne nomme AUCUNE marque dans son code (fautifs : " + brandOffenders(file, null).join(", ") + ")");
    }
    const validateOffenders = brandOffenders("IssueProviderConfigValidate.ts", "KIND_OPTION_SPECS");
    ck.eq(validateOffenders.length, 0, "agnosticisme : « IssueProviderConfigValidate.ts » ne nomme aucune marque HORS de sa branche d'options (fautifs : " + validateOffenders.join(", ") + ")");

    // CONTRÔLE DE DISCRIMINATION : sans lui, les assertions ci-dessus pourraient être vides de sens
    // (un détecteur qui ne voit rien passe partout). On prouve qu'il voit bien une marque là où elle
    // DOIT être, et que l'exemption ci-dessus est LOAD-BEARING.
    ck(brandOffenders("JiraParse.ts", null).length > 0, "discrimination : le détecteur repère bien la marque dans le module qui la porte (sinon les tests ci-dessus seraient vacuous)");
    ck(brandOffenders("IssueProviderConfigValidate.ts", null).length > 0, "discrimination : … et la branche `KIND_OPTION_SPECS` nomme bien une marque — l'exemption n'est pas décorative");

    // -- 3) COHÉRENCE marque ⇄ table d'options : le `kind` que l'adaptateur déclare doit être
    //       VALIDABLE, sinon on enregistrerait un provider que rien ne sait construire. La
    //       confrontation complète avec la FABRIQUE viendra avec le service de synchro (lot L3). --
    ck(SUPPORTED_KINDS.includes(new JiraAdapter(CFG, mkJiraStub({})).kind), "cohérence : le `kind` déclaré par l'adaptateur a bien une branche d'options");
    ck.eq(Object.keys(KIND_OPTION_SPECS).length, 1, "v1 : une seule marque implémentée — le mécanisme, lui, en accepte N");
  }
  });
};
