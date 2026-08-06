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
   Harnais et assertions : harness.js. Cadrage : .notes/toDos/remote-issue-tracker-jira-cadrage-2026-08-06.md. */
"use strict";
const { ck, section, D, SHARED, Validation, Cascade, SharedSchema, EntityRegistry, COLLECTION_THREE_IMPACT } = require("./harness.js");

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
};
