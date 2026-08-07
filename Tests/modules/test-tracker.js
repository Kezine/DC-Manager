/* Tests modules — PONT « interventions ⇄ tracker distant » (module serveur AMOVIBLE `tracker/`).
   ----------------------------------------------------------------------------
   Le module RÉPLIQUE les incidents/interventions de DC Manager dans un projet de tracker
   PARTAGÉ avec d'autres sources, et suit leur traitement en LECTURE SEULE (cf.
   `.notes/toDos/jira-replication-interventions-cadrage-2026-08-07.md`). Le partage des
   vérités gouverne tout ce qui suit : DC Manager fait foi sur le CONTENU poussé (titre,
   description, type, priorité, échéance, étiquettes `DCM-*`), le tracker fait foi sur le
   TRAITEMENT relu (statut, assigné).

   Ce qui est couvert, du plus pur au plus intégré :
   1. `core/TrackerStatus` — classification d'un état de ticket (catégorie FERMÉE, priorité de
      l'introuvable reconnu à la SENTINELLE du pont, clé de tri, libellés) et sa PASTILLE avec son
      échappement, plus `core/TrackerReplication` — état de RÉPLICATION d'une intervention (répliquée
      ou non, état de POUSSÉE, arbitrage de l'URL du ticket). Les deux pilotent l'UI du lot P3 ;
   2. `Html.externalLink` — un lien sortant ne peut pas être un vecteur XSS (primitive GÉNÉRIQUE,
      utile à toute donnée d'origine tierce affichée en lien) ;
   3. le miroir `KIND_FIELDS` (formulaire providers) ⇄ `KIND_OPTION_SPECS` (serveur) — un miroir
      que personne ne vérifie finit par diverger ;
   4. `JiraParse.toAdf` (format de description de l'API v3), la table de PRIORITÉS et la lecture
      des REFUS PAR CHAMP (dont dépend le repli « priorité absente du projet ») ;
   5. le DÉCODAGE Jira PUR : formes pleines/creuses/inattendues, alias, catégorie d'état, et les
      DEUX pièges du chantier — `ext_id` = l'id INTERNE (jamais la clé, qui bouge au déplacement
      de projet) et `url` COMPOSÉE vers l'interface (jamais le champ `self`, qui pointe l'API) ;
   6. la PAGINATION pure (chaque garde-fou séparément, DEUX formes d'API) + JQL + références saisies ;
   7. `TrackerLabels` — composition, normalisation et DIFF EN VERBES des étiquettes `DCM-*` :
      c'est là que se neutralise le risque n°1 (ne JAMAIS toucher aux labels des autres sources) ;
   8. l'ORCHESTRATION de l'adaptateur sur stub HTTP STRUCTUREL : `resolve` par LOTS et le partage
      found/missing, `lookup`, `createIssue`/`updateIssue` (labels en verbes, retente SANS priorité
      sur refus du champ, JAMAIS de retente sans `issuetype`, message Jira INTACT), `test` ;
   9. le CLIENT HTTP : parties pures (Basic, `Retry-After`, extraction du message d'erreur) et flux
      réel sur `fetch` INJECTÉ — 429 avec backoff borné, cap de réponse, erreurs traduites ;
  10. la VALIDATION d'un provider — champs communs + branche d'options PAR MARQUE ;
  11. le STOCKAGE chiffré (better-sqlite3 RÉEL) : CRUD sans fuite de jeton, compte RELU, sentinelle ;
  12. `TrackerPassScope` — le PLAFOND de passe et son ROULEMENT : la synchro étant IDEMPOTENTE, un
      simple tri laisserait une ZONE MORTE permanente en queue d'assiette, que rien ne signalerait ;
  13. le PONT DE BOUT EN BOUT sur bases RÉELLES (`interventions.db` + `DocumentStore`) : poussée
      TOLÉRANTE (adaptateur qui jette ⇒ l'intervention est enregistrée, `push_state: error`, reprise
      à la passe suivante), persistance de l'état de poussée à travers un REDÉMARRAGE simulé,
      création (clé écrite AVANT tout le reste ; échec d'écriture locale qui ne perd pas la clé ET
      ne fabrique AUCUN ticket de plus aux passes suivantes, redémarrage compris — le résiduel
      assumé est mesuré, pas supposé), REFUS de l'adoption DOUBLE d'un ticket, RAMASSAGE AU
      DÉMARRAGE d'une poussée laissée en plan (sans timer ni geste, tracker éteint compris),
      retour d'état IDEMPOTENT, `missing` ⇒ « introuvable » SANS suppression, `updated_by`/
      `updated_date` JAMAIS touchés, réplication automatique (un provider ⇒ oui, plusieurs ⇒ non
      + journal) ;
  14. les INVARIANTS : décodeur ≡ pivot (`TRACKER_TICKET_STATE_FIELDS` + sa sonde de compilation) et
      AGNOSTICISME de marque — aucun littéral « jira » hors des points d'extension, avec des
      exemptions par DÉCLARATION dont chacune est prouvée load-bearing, et la cohérence
      fabrique ⇄ `KIND_OPTION_SPECS` DANS LES DEUX SENS.
   ⚠ Les routes Express (`TrackerModule.ts`) restent HORS test, comme `api.ts`/`VmModule`/
   `WifiModule` : c'est la convention du dépôt.
   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, Validation, Cascade, SharedSchema, EntityRegistry, COLLECTION_THREE_IMPACT, makeStore } = require("./harness.js");

module.exports = async () => {
  const { TrackerStatus, TRACKER_STATUS_CATEGORIES } = D("core/TrackerStatus.js");
  const { TrackerReplication, TRACKER_PUSH_STATES } = D("core/TrackerReplication.js");

  await section("client : TrackerStatus — catégories, PRIORITÉ de l'introuvable, clé de tri, libellés", async () => {
  {
    // -- CATÉGORIE : ensemble FERMÉ, repli `unknown` sur tout ce qui n'en est pas (le module ne fait
    //    jamais confiance à ce qui vient d'un tiers, même si la synchro serveur clampe déjà). --
    // ⚠ Attente EXPLICITE (jamais dérivée du module) : la liste est l'ABSTRACTION multi-marques
    //    elle-même — c'est elle qui rend un GitHub ou un Redmine affichable sans toucher une vue.
    //    L'ORDRE compte autant que le contenu : il EST l'ordre de tri sémantique des listings.
    ck.eq(TRACKER_STATUS_CATEGORIES.join(","), "todo,in_progress,done,unknown",
      "TRACKER_STATUS_CATEGORIES : les 4 valeurs fermées, dans l'ordre SÉMANTIQUE (à faire → terminé → inclassable)");
    ck.eq(TrackerStatus.CATEGORIES.join(","), TRACKER_STATUS_CATEGORIES.join(","), "CATEGORIES : reprise TELLE QUELLE de la liste (pas de seconde table)");
    ck.eq(TrackerStatus.categoryOf({ status_category: "in_progress" }), "in_progress", "categoryOf : catégorie connue conservée");
    ck.eq(TrackerStatus.categoryOf({ status_category: "  done  " }), "done", "categoryOf : catégorie rognée");
    ck.eq(TrackerStatus.categoryOf({ status_category: "En recette" }), "unknown", "categoryOf : valeur hors ensemble → unknown");
    ck.eq(TrackerStatus.categoryOf(null), "unknown", "categoryOf : null toléré → unknown");

    // -- STATUT BRUT : affiché TEL QUEL, jamais traduit (décision D3 — le workflow est configurable). --
    ck.eq(TrackerStatus.raw({ status: "  En recette  " }), "En recette", "raw : statut rogné, restitué TEL QUEL (aucune traduction, aucune énumération)");
    ck.eq(TrackerStatus.raw({}), "", "raw : statut absent → \"\"");

    // -- INTROUVABLE : reconnu à la SENTINELLE écrite par le pont, et à RIEN D'AUTRE. La catégorie
    //    `unknown` seule ne suffirait pas — un statut de workflow que l'adaptateur n'a pas su classer
    //    y retombe aussi, alors que CE ticket-là est bien résolu. --
    ck.eq(TrackerStatus.isNotFound({ status: TrackerStatus.NOT_FOUND_STATUS, status_category: "unknown" }), true, "isNotFound : sentinelle du pont → introuvable");
    ck.eq(TrackerStatus.isNotFound({ status: "En recette", status_category: "unknown" }), false,
      "isNotFound : catégorie `unknown` SANS la sentinelle → résolu (un statut inclassable n'est pas un ticket perdu)");
    ck.eq(TrackerStatus.isNotFound({}), false, "isNotFound : rien du tout → résolu");
    ck.eq(TrackerStatus.COLOR_NOT_FOUND, "var(--warn)", "couleur : introuvable = AVERTISSEMENT (l'intervention locale est intacte et le ticket reviendra tout seul)");
    ck.eq(TrackerStatus.color({ status: TrackerStatus.NOT_FOUND_STATUS, status_category: "done" }), TrackerStatus.COLOR_NOT_FOUND,
      "color : l'introuvable PRIME sur la catégorie (patron VmStatus.swatchColor)");
    ck(TrackerStatus.color({ status_category: "done" }) !== TrackerStatus.color({ status_category: "todo" }),
      "color : deux catégories distinctes → deux couleurs distinctes (la catégorie fermée est la SEULE à colorer)");
    ck.eq(TrackerStatus.color({ status_category: "vocabulaire-maison" }), TrackerStatus.color({ status_category: "unknown" }),
      "color : catégorie inconnue → couleur de `unknown` (neutre : on ne colore pas ce qu'on n'a pas su classer)");

    // -- TRI : introuvables groupés à part, puis ordre SÉMANTIQUE des catégories, puis statut brut. --
    const rows = [
      { name: "clos", status_category: "done" },
      { name: "introuvable", status_category: "unknown", status: TrackerStatus.NOT_FOUND_STATUS },
      { name: "en cours", status_category: "in_progress" },
      { name: "ouvert-b", status_category: "todo", status: "B" },
      { name: "ouvert-a", status_category: "todo", status: "A" },
    ];
    const sorted = rows.slice().sort((a, b) => (TrackerStatus.sortKey(a) < TrackerStatus.sortKey(b) ? -1 : TrackerStatus.sortKey(a) > TrackerStatus.sortKey(b) ? 1 : 0)).map((r) => r.name);
    ck.eq(sorted.join(","), "ouvert-a,ouvert-b,en cours,clos,introuvable",
      "sortKey : ordre sémantique todo → in_progress → done, statut brut en départage, INTROUVABLES groupés à part");

    // -- LIBELLÉS : la CATÉGORIE est traduite, le STATUT ne l'est jamais. Locale du harnais = fr. --
    const frLists = D("i18n/locales/fr/lists.js").lists, frDomain = D("i18n/locales/fr/domain.js").domain;
    ck.eq(TrackerStatus.notFoundLabel(), frLists.ph.notFound, "notFoundLabel : résolu via I18n (lists.ph.notFound), jamais une chaîne en dur");
    ck.eq(TrackerStatus.categoryLabel("done"), frDomain.trackerStatusCategory.done, "categoryLabel : libellé localisé de la catégorie");
    ck.eq(TrackerStatus.categoryLabel("En recette"), frDomain.trackerStatusCategory.unknown,
      "categoryLabel : valeur non normalisée ramenée à `unknown` — la clé i18n demandée existe TOUJOURS");
    ck.eq(TrackerStatus.categoryLabel(null), frDomain.trackerStatusCategory.unknown, "categoryLabel : null toléré");
  }
  });

  /* ==========================================================================================
     LOT P3 — UI DU PONT : ce qui est PUR et testable sans navigateur
     (les vues DOM restent hors test, comme partout dans le dépôt).
     ========================================================================================== */

  await section("client P3 : TrackerStatus — PASTILLE (échappement, priorité de l'introuvable, couleur par catégorie)", async () => {
  {
    const frLists = D("i18n/locales/fr/lists.js").lists, frDomain = D("i18n/locales/fr/domain.js").domain;

    // -- STATUT : le libellé BRUT est rendu TEL QUEL… mais ÉCHAPPÉ. C'est une donnée d'ORIGINE
    //    DISTANTE posée en innerHTML : un statut de workflow contenant du balisage ne doit pas
    //    devenir du HTML. Les couleurs, elles, sont des constantes internes — jamais une donnée. --
    const plain = TrackerStatus.statusPill({ status: "En recette", status_category: "in_progress" });
    ck(plain.indexOf("En recette") >= 0, "statusPill : le libellé BRUT du tracker est affiché tel quel (jamais traduit — décision D3)");
    const nasty = TrackerStatus.statusPill({ status: '<img src=x onerror="alert(1)">', status_category: "todo" });
    ck(nasty.indexOf("<img") === -1, "statusPill : un statut porteur de balisage est ÉCHAPPÉ (donnée distante en innerHTML)");
    ck(nasty.indexOf("&lt;img") >= 0, "statusPill : … et reste LISIBLE sous forme échappée (on n'efface pas la donnée)");
    ck(nasty.indexOf("onerror=\"") === -1, "statusPill : aucun attribut d'événement ne survit à l'échappement");

    // -- COULEUR : portée par la CATÉGORIE (le seul axe commun à tous les providers), jamais par le
    //    libellé libre. Deux catégories distinctes ⇒ deux pastilles distinctes. --
    ck(TrackerStatus.statusPill({ status: "X", status_category: "done" }) !== TrackerStatus.statusPill({ status: "X", status_category: "todo" }),
      "statusPill : MÊME libellé, catégories différentes → pastilles différentes (c'est la catégorie qui colore)");

    // -- STATUT VIDE (jamais synchronisé) : repli sur le LIBELLÉ DE CATÉGORIE, qui est traduisible.
    //    On n'a PAS traduit un libellé du tracker (D3 tient), on affiche la classification. --
    ck(TrackerStatus.statusPill({ status: "", status_category: "todo" }).indexOf(frDomain.trackerStatusCategory.todo) >= 0,
      "statusPill : statut vide → libellé de CATÉGORIE (jamais une pastille vide)");

    // -- INTROUVABLE : la SENTINELLE du pont ne s'affiche JAMAIS brute — elle est remplacée par le
    //    libellé LOCALISÉ (notre constat, pas un libellé de workflow) et peinte en avertissement. --
    const notFound = TrackerStatus.statusPill({ status: TrackerStatus.NOT_FOUND_STATUS, status_category: "unknown" });
    ck(notFound.indexOf(frLists.ph.notFound) >= 0, "statusPill : introuvable → libellé « introuvable » (et non « orphelin » ni « déconnecté »)");
    ck(notFound.indexOf("var(--warn)") >= 0, "statusPill : … en couleur d'AVERTISSEMENT et non au neutre de sa catégorie `unknown`");
    ck(/title="/.test(TrackerStatus.statusPill({ status: "X", status_category: "todo" }, "explication")), "statusPill : infobulle posée quand elle est fournie (la fiche l'utilise, le listing non)");
    ck(!/title="/.test(notFound), "statusPill : aucune infobulle sans titre (colonne étroite du listing)");
    ck(TrackerStatus.statusPill({ status: "X" }, '"><script>').indexOf("<script") === -1, "statusPill : l'infobulle est échappée (elle finit dans un ATTRIBUT)");
  }
  });

  await section("client P3 : TrackerReplication — répliquée ?, état de POUSSÉE, URL du ticket", async () => {
  {
    // -- RÉPLIQUÉE : décidé sur l'identifiant INTERNE, et sur rien d'autre. Une référence saisie à la
    //    main (champ hérité, éditable) ne prouve RIEN — c'est même le cas qui bascule l'UI vers
    //    l'ADOPTION plutôt que la création. --
    ck.eq(TrackerReplication.isReplicated({ tracker_ext_id: "10500" }), true, "isReplicated : identifiant distant présent → répliquée");
    ck.eq(TrackerReplication.isReplicated({ tracker_ext_id: "   " }), false, "isReplicated : identifiant blanc → NON répliquée (une colonne vide n'est pas une identité)");
    ck.eq(TrackerReplication.isReplicated({ tracker_provider_id: "jira-infra" }), false,
      "isReplicated : un provider posé sans identifiant distant (poussée en cours) ne vaut PAS réplication");
    ck.eq(TrackerReplication.isReplicated(null), false, "isReplicated : null toléré");

    // -- ÉTAT DE POUSSÉE : ensemble fermé + `none` pour l'absence. Une valeur exotique retombe sur
    //    `none` — mieux vaut n'afficher aucun état qu'un état inventé. --
    ck.eq(TRACKER_PUSH_STATES.join(","), "synced,pending,error", "TRACKER_PUSH_STATES : les 3 états PERSISTÉS (`none` n'en est pas un — c'est l'absence)");
    ck.eq(TrackerReplication.pushState({ tracker_push_state: "pending" }), "pending", "pushState : valeur connue conservée");
    ck.eq(TrackerReplication.pushState({ tracker_push_state: "  error  " }), "error", "pushState : valeur rognée");
    ck.eq(TrackerReplication.pushState({ tracker_push_state: "en-cours-peut-etre" }), "none", "pushState : valeur hors ensemble → `none`");
    ck.eq(TrackerReplication.pushState({}), "none", "pushState : colonne vide → `none`");
    ck.eq(TrackerReplication.hasPushError({ tracker_push_state: "error" }), true, "hasPushError : seul `error` appelle une action de l'utilisateur…");
    ck.eq(TrackerReplication.hasPushError({ tracker_push_state: "pending" }), false, "hasPushError : … `pending` se résorbe seul à la passe suivante");
    ck.eq(TrackerReplication.pushError({ tracker_push_error: "  le champ X est requis  " }), "le champ X est requis",
      "pushError : message du tracker rogné et rendu INTACT (c'est lui qui dit quoi corriger)");
    ck.eq(TrackerReplication.pushError({}), "", "pushError : aucun message → \"\"");

    // -- Clés i18n et classes de badge : le module reste i18n-AGNOSTIQUE (il ne rend que des clés,
    //    comme InterventionsFormat) — mais les clés doivent EXISTER, sinon elles s'afficheraient
    //    telles quelles. Le régime NORMAL (`synced`) est DISCRET : il ne doit pas attirer l'œil. --
    const { I18n } = D("i18n/I18n.js");
    for (const state of [...TRACKER_PUSH_STATES, "none"]) {
      const key = TrackerReplication.pushStateLabelKey(state);
      ck(I18n.t(key) !== key, "i18n : libellé présent pour l'état de poussée « " + state + " »");
    }
    ck.eq(TrackerReplication.pushStateClass("synced"), "dim", "pushStateClass : « à jour » est DISCRET (c'est le régime normal)");
    ck.eq(TrackerReplication.pushStateClass("pending"), "warn", "pushStateClass : « en attente » attire modérément l'œil");
    ck.eq(TrackerReplication.pushStateClass("error"), "err", "pushStateClass : « en échec » est une erreur");
    ck.eq(TrackerReplication.pushStateClass("none"), "dim", "pushStateClass : sans état → discret");

    // -- URL : le lien PERSISTÉ par le pont PRIME sur le montage local. Le montage suppose que la
    //    base d'URL configurée à part désigne la MÊME instance que celle réellement interrogée — ce
    //    que rien ne garantit ; le lien persisté, lui, a été composé par l'adaptateur. --
    ck.eq(TrackerReplication.ticketUrl("https://tracker.example.net/browse/INFRA-1", "https://autre.example.net/browse/INFRA-1"), "https://tracker.example.net/browse/INFRA-1",
      "ticketUrl : le lien persisté par le pont l'emporte sur le montage local");
    ck.eq(TrackerReplication.ticketUrl(null, "https://autre.example.net/browse/INFRA-1"), "https://autre.example.net/browse/INFRA-1",
      "ticketUrl : sans lien persisté (intervention non répliquée), le montage hérité sert de repli");
    ck.eq(TrackerReplication.ticketUrl("   ", null), null, "ticketUrl : rien d'exploitable → null (la vue affiche alors du texte brut)");
    ck.eq(TrackerReplication.ticketUrl(undefined, undefined), null, "ticketUrl : valeurs absentes tolérées");
  }
  });

  await section("client L4 : Html.externalLink — un lien SORTANT ne peut pas être un vecteur XSS", async () => {
  {
    const { Html } = D("core/Html.js");

    // -- 🚨 LE cas qui justifie le helper : `url` vient d'un tiers (ou d'un document importé). Rendre
    //    « javascript: » cliquable exécuterait ce code au premier clic — et l'échappement HTML n'y
    //    change RIEN (la chaîne est parfaitement valide en valeur d'attribut). --
    for (const hostile of ["javascript:alert(1)", "JavaScript:alert(1)", "  javascript:alert(1)  ", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "file:///etc/passwd"]) {
      const out = Html.externalLink(hostile, "INFRA-1");
      ck.eq(out, "INFRA-1", "externalLink : schéma refusé (« " + hostile.trim().slice(0, 20) + " ») → TEXTE, aucun <a>");
      ck.eq(Html.isSafeHttpUrl(hostile), false, "isSafeHttpUrl : « " + hostile.trim().slice(0, 20) + " » refusée");
    }

    // -- Les schémas AUTORISÉS, casse comprise (URL normalise le protocole en minuscules). --
    ck.eq(Html.isSafeHttpUrl("https://tracker.example.net/browse/INFRA-1"), true, "isSafeHttpUrl : https acceptée");
    ck.eq(Html.isSafeHttpUrl("http://tracker.example.net/browse/INFRA-1"), true, "isSafeHttpUrl : http acceptée (intranet en clair)");
    ck.eq(Html.isSafeHttpUrl("HTTPS://Tracker.Example.NET/x"), true, "isSafeHttpUrl : la CASSE du schéma ne contourne pas la liste blanche");

    // -- Valeurs VIDES / non chaînes / RELATIVES : pas un lien (et surtout pas une exception). --
    for (const empty of ["", "   ", null, undefined, 42, {}, "/browse/INFRA-1", "pas une url"]) {
      ck.eq(Html.isSafeHttpUrl(empty), false, "isSafeHttpUrl : valeur non exploitable (" + JSON.stringify(empty) + ") → false, sans jeter");
    }
    ck.eq(Html.externalLink(null, "INFRA-1"), "INFRA-1", "externalLink : URL absente → le libellé seul, en texte");
    ck.eq(Html.externalLink("", ""), "", "externalLink : rien à rendre → \"\"");

    // -- Le lien NOMINAL : href + target + rel INDISSOCIABLES (sans `noopener`, la page ouverte peut
    //    rediriger la nôtre — tabnabbing ; `noreferrer` évite en plus de fuiter l'URL courante). --
    const link = Html.externalLink("https://tracker.example.net/browse/INFRA-1", "INFRA-1");
    ck.eq(link, '<a href="https://tracker.example.net/browse/INFRA-1" target="_blank" rel="noopener noreferrer">INFRA-1</a>',
      "externalLink : href + target=_blank + rel=noopener noreferrer");
    ck(Html.externalLink("https://x.test/a").indexOf(">https://x.test/a<") >= 0, "externalLink : sans libellé, l'URL sert de texte");

    // -- ÉCHAPPEMENT des DEUX côtés : l'URL finit dans un ATTRIBUT, le libellé dans du CONTENU. Un
    //    guillemet dans l'URL ne doit pas pouvoir refermer l'attribut et injecter un handler. --
    const dirty = Html.externalLink('https://x.test/a"onmouseover="alert(1)', '<b>x</b>');
    ck(dirty.indexOf('"onmouseover="') === -1, "externalLink : un guillemet dans l'URL ne s'évade pas de l'attribut href");
    ck(dirty.indexOf("<b>") === -1, "externalLink : le LIBELLÉ est échappé (contenu, pas du HTML de confiance)");
  }
  });

  await section("client L4 : KIND_FIELDS (formulaire providers) ⇄ KIND_OPTION_SPECS (serveur) — le miroir est VÉRIFIÉ", async () => {
  {
    // Un miroir que personne ne contrôle DIVERGE : un champ affiché mais non déclaré côté serveur
    // serait silencieusement ignoré (les options inconnues sont écartées) et un champ déclaré mais
    // non affiché resterait figé sur son défaut. Les deux défauts sont MUETS à l'exécution.
    const { TrackerProvidersForm } = D("views/forms/TrackerProvidersForm.js");
    const { I18n } = D("i18n/I18n.js");
    const { KIND_OPTION_SPECS } = SERVER("tracker/TrackerProviderConfigValidate.js");
    const TYPE_OF_SPEC = { string: "text", boolean: "toggle" };   // spec serveur → contrôle client

    ck.eq(Object.keys(TrackerProvidersForm.KIND_FIELDS).sort().join(","), Object.keys(KIND_OPTION_SPECS).sort().join(","),
      "miroir : MÊMES marques déclarées des deux côtés (ajouter une marque = 1 entrée ici + 1 branche là-bas)");
    for (const kind of Object.keys(KIND_OPTION_SPECS)) {
      const server = KIND_OPTION_SPECS[kind], client = TrackerProvidersForm.KIND_FIELDS[kind] || [];
      ck.eq(client.map((f) => f.name).join(","), server.map((s) => s.name).join(","),
        "miroir « " + kind + " » : mêmes options, dans le MÊME ordre");
      for (const spec of server) {
        const field = client.find((f) => f.name === spec.name);
        ck(!!field, "miroir « " + kind + " » : l'option « " + spec.name + " » est rendue par le formulaire");
        if (!field) continue;
        ck.eq(field.type, TYPE_OF_SPEC[spec.type] || spec.type,
          "miroir « " + kind + "." + spec.name + " » : le contrôle correspond au type de la spec serveur");
        ck.eq(JSON.stringify(field.fallback), JSON.stringify(spec.default),
          "miroir « " + kind + "." + spec.name + " » : le défaut PROPOSÉ est celui que le serveur APPLIQUE");
        // Les libellés passent par I18n (aucune chaîne en dur) et les clés doivent EXISTER : une clé
        // manquante s'afficherait telle quelle dans le formulaire (i18next rend la clé).
        ck(I18n.t(field.labelKey) !== field.labelKey, "i18n : libellé présent pour « " + kind + "." + spec.name + " »");
        ck(I18n.t(field.hintKey) !== field.hintKey, "i18n : aide présente pour « " + kind + "." + spec.name + " »");
        if (field.placeholderKey) ck(I18n.t(field.placeholderKey) !== field.placeholderKey, "i18n : placeholder présent pour « " + kind + "." + spec.name + " »");
      }
    }
  }
  });

  /* ==========================================================================================
     MODULE SERVEUR AMOVIBLE `tracker/` : contrats, adaptateur Jira, config chiffrée, pont
     ========================================================================================== */

  const { JiraParse } = SERVER("tracker/JiraParse.js");
  const { JiraAdapter } = SERVER("tracker/JiraAdapter.js");
  const { JiraHttp, JiraHttpError } = SERVER("tracker/JiraHttp.js");
  const { TrackerLabels } = SERVER("tracker/TrackerLabels.js");

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
      putJson: (p, body) => stub.answer("PUT", p, body),
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
  const CFG = {
    id: "tr-1", kind: "jira", url: BASE, token: "JETON-TRES-SECRET", account: "svc@example.net",
    interval_sec: 0, timeout_sec: 20,
    options: { project_key: "INFRA", type_incident: "Incident", type_intervention: "Infrastructure", auto_replicate: true },
  };

  /** CONTENU poussé de référence (forme `TrackerPushContent`) — surchargeable par cas de test. */
  const pushContent = (over) => Object.assign({
    summary: "Remplacement switch", description: "ligne 1\n\nligne 3",
    kind: "intervention", labels: ["DCM-EQ-SOS13"], priority: "high", duedate: "2026-08-12",
  }, over || {});

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

  await section("Serveur : JiraParse — état décodé (ext_id = id INTERNE, url d'INTERFACE, catégorie, alias, tolérance)", async () => {
  {
    const full = JiraParse.ticketState(fixtureIssue("10042", "INFRA-123"), BASE);

    // -- 🚨 PIÈGE N°1 DU CHANTIER : l'identité est l'id INTERNE, jamais la clé. --
    ck.eq(full.ext_id, "10042", "ext_id : l'identifiant INTERNE du ticket");
    ck(full.ext_id !== "INFRA-123", "ext_id : JAMAIS la clé — une clé change au déplacement de projet (doublon + orphelin, en silence)");
    ck.eq(full.key, "INFRA-123", "key : conservée comme champ d'AFFICHAGE, re-synchronisé à chaque passe");
    ck.eq(JiraParse.ticketState({ key: "INFRA-9", fields: { summary: "x" } }, BASE), null,
      "un ticket SANS id interne est REFUSÉ (mieux vaut ne rien répliquer que suivre une identité mobile)");

    // -- 🚨 PIÈGE N°2 : `self` pointe l'API, l'utilisateur veut l'INTERFACE. --
    ck.eq(full.url, BASE + "/browse/INFRA-123", "url : lien d'INTERFACE COMPOSÉ « <base>/browse/<clé> »");
    ck(!full.url.includes("rest/api"), "url : le champ `self` de la réponse (qui pointe l'API) n'est JAMAIS recopié");
    ck.eq(JiraParse.browseUrl(BASE + "///", "INFRA-1"), BASE + "/browse/INFRA-1", "browseUrl : les « / » finaux de la base sont absorbés (pas de double barre)");
    ck.eq(JiraParse.browseUrl(BASE, ""), null, "browseUrl : sans clé → null (un lien mort est pire qu'une colonne vide)");
    ck.eq(JiraParse.browseUrl("", "INFRA-1"), null, "browseUrl : sans base → null");

    // -- Champs du TRAITEMENT (les seuls dont le tracker fait foi). --
    ck.eq(full.status, "En recette", "status : libellé BRUT du workflow, restitué tel quel (jamais traduit)");
    ck.eq(full.status_category, "in_progress", "status_category : `indeterminate` → `in_progress` (table de correspondance explicite)");
    ck.eq(full.assignee, "A. Dupont", "assignee : nom AFFICHABLE (displayName), pas un identifiant de compte");
    ck.eq(JSON.stringify(full.labels), JSON.stringify(["reseau", "urgent"]), "labels décodées (matière du diff `DCM-*`)");

    // -- 🚨 CE QUE LE DÉCODEUR NE RAPATRIE PAS : le CONTENU. DC Manager en fait foi (il l'a poussé) ;
    //    le relire créerait deux vérités concurrentes sur les mêmes champs. --
    ck.eq(Object.keys(full).sort().join(","), "assignee,ext_id,key,labels,status,status_category,url",
      "état : EXACTEMENT les 7 champs du pivot — ni summary, ni description, ni type, ni priorité (DC Manager fait foi sur le contenu)");

    // -- TOLÉRANCE : forme CREUSE. --
    const hollow = JiraParse.ticketState({ id: "1", key: "K-1", fields: {} }, BASE);
    ck(hollow.status === "" && hollow.key === "K-1", "creux : champs texte non nullables → \"\" (aucun null silencieux)");
    ck.eq(hollow.assignee, null, "creux : champ nullable → null");
    ck.eq(JSON.stringify(hollow.labels), "[]", "creux : labels absentes → []");
    ck.eq(hollow.status_category, "unknown", "creux : statut absent → catégorie `unknown`");

    // -- TOLÉRANCE : formes INATTENDUES — aucune exception, jamais. --
    for (const junk of [null, undefined, 42, "texte", [], {}]) {
      ck.eq(JiraParse.ticketState(junk, BASE), null, "inattendu : " + JSON.stringify(junk) + " → null, aucune exception");
    }
    const weird = JiraParse.ticketState({ id: "2", fields: "pas un objet" }, BASE);
    ck(weird !== null && weird.status === "" && weird.url === null, "inattendu : `fields` non-objet → repli sur l'objet racine, et pas de clé → url null");
    ck.eq(JiraParse.ticketState({ id: "3", fields: { labels: "pas un tableau" } }, BASE).labels.length, 0, "inattendu : labels non-tableau → []");

    // -- ALIAS : un seul point de déclaration, et une forme APLATIE reste décodable. --
    const flat = JiraParse.ticketState({ issueId: 7, issueKey: "K-7", status: "Terminé", labels: ["a"] }, BASE);
    ck.eq(flat.ext_id, "7", "alias : `issueId` numérique accepté et converti en chaîne");
    ck(flat.key === "K-7" && flat.labels.join(",") === "a", "alias : `issueKey` + champs APLATIS (sans conteneur `fields`) décodés");
    ck.eq(flat.status, "Terminé", "alias : un `status` livré en CHAÎNE nue reste un libellé exploitable");
    ck.eq(flat.status_category, "unknown", "alias : … mais sans objet `statusCategory`, la catégorie reste `unknown` (on ne devine pas depuis un libellé)");

    // -- CATÉGORIE : la table est explicite, tout le reste tombe sur `unknown`. --
    const categoryOf = (key) => JiraParse.ticketState(fixtureIssue("9", "K-9", { status: { name: "s", statusCategory: { key } } }), BASE).status_category;
    ck.eq(categoryOf("new"), "todo", "catégorie : `new` → `todo`");
    ck.eq(categoryOf("indeterminate"), "in_progress", "catégorie : `indeterminate` → `in_progress`");
    ck.eq(categoryOf("done"), "done", "catégorie : `done` → `done`");
    ck.eq(categoryOf("DONE"), "done", "catégorie : casse ignorée");
    ck.eq(categoryOf("cosmic"), "unknown", "catégorie INCONNUE → `unknown` (la passe ne doit pas échouer pour une donnée d'affichage)");
    ck.eq(categoryOf("undefined"), "unknown", "catégorie « undefined » (la « No category » de Jira) → `unknown`");
    ck.eq(JiraParse.statusCategory(null), "unknown", "statusCategory : entrée nulle tolérée");
    ck(TRACKER_STATUS_CATEGORIES.includes(categoryOf("cosmic")), "catégorie : la valeur produite appartient TOUJOURS à l'ensemble FERMÉ affiché côté client");

    // -- PERSONNES : un identifiant opaque n'est PAS un nom affichable. --
    ck.eq(JiraParse.ticketState(fixtureIssue("9", "K-9", { assignee: { accountId: "5b10a2…" } }), BASE).assignee, null,
      "personne : `accountId` seul → null (le pivot veut un nom AFFICHABLE, pas un identifiant opaque)");
    ck.eq(JiraParse.ticketState(fixtureIssue("9", "K-9", { assignee: { emailAddress: "x@y.z" } }), BASE).assignee, "x@y.z",
      "personne : l'adresse e-mail sert de DERNIER repli (displayName souvent masqué par la confidentialité Atlassian)");

    // -- ÉTIQUETTES : nettoyées, mais NI triées NI dédupliquées ici — le décodeur rend ce qu'il a LU,
    //    la canonisation ET le diff appartiennent à `TrackerLabels` (le faire deux fois de deux façons
    //    est ce qui produit un faux delta à chaque poussée). --
    const labels = JiraParse.ticketState(fixtureIssue("9", "K-9", { labels: ["b", "  a  ", "", 42, null, "b"] }), BASE).labels;
    ck.eq(JSON.stringify(labels), JSON.stringify(["b", "a", "b"]),
      "labels : rognées, vides et non-chaînes écartées — ordre CONSERVÉ et doublon GARDÉ (la canonisation n'est PAS le travail du décodeur)");

    // -- LISTE : inexploitables écartés, DOUBLONS d'ext_id écartés (le premier gagne). --
    const list = JiraParse.ticketStates([fixtureIssue("1", "A-1"), null, fixtureIssue("1", "A-1-bis"), fixtureIssue("2", "A-2"), { key: "sans-id" }], BASE);
    ck.eq(list.length, 2, "ticketStates : inexploitables et doublons d'ext_id écartés");
    ck.eq(list[0].key, "A-1", "ticketStates : sur un doublon d'ext_id, le PREMIER gagne");
    ck.eq(JiraParse.ticketStates("pas un tableau", BASE).length, 0, "ticketStates : forme inattendue → [] (aucune exception)");
  }
  });

  /* ============ SERVEUR : ce que la POUSSÉE traduit (priorité) et ce qu'elle LIT (refus) ============ */

  await section("Serveur : JiraParse — table de PRIORITÉS et lecture des REFUS par champ (repli « priorité absente »)", async () => {
  {
    // -- PRIORITÉ : table FIXE en v1 (§5 du cadrage), quatre slugs DC Manager → noms Jira par défaut. --
    ck.eq(JiraParse.priorityName("low"), "Low", "priorité : low → Low");
    ck.eq(JiraParse.priorityName("normal"), "Medium", "priorité : normal → Medium (et non « Normal » — c'est le vocabulaire JIRA qui compte)");
    ck.eq(JiraParse.priorityName("high"), "High", "priorité : high → High");
    ck.eq(JiraParse.priorityName("critical"), "Highest", "priorité : critical → Highest");
    ck.eq(JiraParse.priorityName("  HIGH  "), "High", "priorité : rognée et insensible à la casse");
    for (const junk of ["", "   ", "urgente", null, undefined, 42, {}]) {
      ck.eq(JiraParse.priorityName(junk), null, "priorité : " + JSON.stringify(junk) + " → null (on pousse SANS priorité plutôt qu'une priorité inventée)");
    }

    // -- 🚨 REFUS PAR CHAMP : c'est cette lecture qui rend la réplication possible sur les projets
    //    « team-managed » (souvent SANS champ priorité). Deux sources : le corps BRUT (exact) et,
    //    à défaut, le message composé par le client HTTP (repli — le transport est INJECTÉ). --
    const withBody = Object.assign(new Error("Tracker : HTTP 400 sur /rest/api/3/issue"), { body: JSON.stringify({ errors: { priority: "Field 'priority' cannot be set" } }) });
    ck.eq(JiraParse.errorMentionsField(withBody, "priority"), true, "refus : le corps BRUT désigne `errors.priority` → détecté EXACTEMENT");
    ck.eq(JiraParse.errorMentionsField(withBody, "issuetype"), false, "refus : … et un AUTRE champ n'est pas détecté pour autant");

    const messageOnly = new Error("Tracker : HTTP 400 sur /rest/api/3/issue — priority : Field 'priority' cannot be set");
    ck.eq(JiraParse.errorMentionsField(messageOnly, "priority"), true, "refus : sans corps, le MESSAGE composé (« champ : … ») suffit — le transport peut être un stub");
    ck.eq(JiraParse.errorMentionsField(new Error("Tracker : HTTP 400 — issuetype : type inconnu"), "priority"), false,
      "refus : un refus d'`issuetype` ne déclenche PAS le repli de priorité (jamais de retente sans type)");
    ck.eq(JiraParse.errorMentionsField(new Error("Tracker : HTTP 400 — issuetype : type inconnu"), "issuetype"), true, "refus : … mais il est bien LU comme tel");

    // Le nom du champ doit être un MOT à part entière suivi d'un « : » — pas une sous-chaîne au hasard
    // (un titre d'intervention recopié par le tracker parlerait sinon à sa place).
    ck.eq(JiraParse.errorMentionsField(new Error("Tracker : HTTP 400 — la priority du ticket est ignorée"), "priority"), false,
      "refus : « priority » sans « : » n'est PAS une erreur par champ (aucune détection à l'aveugle)");
    ck.eq(JiraParse.errorMentionsField(new Error("Tracker : HTTP 400 — customfield_priority : requis"), "priority"), false,
      "refus : un champ dont le NOM CONTIENT « priority » n'est pas « priority » (frontière de mot)");
    for (const junk of [null, undefined, "", 42, new Error("")]) {
      ck.eq(JiraParse.errorMentionsField(junk, "priority"), false, "refus : entrée inexploitable (" + JSON.stringify(String(junk)) + ") → false, sans jeter");
    }
    ck.eq(JiraParse.errorMentionsField(new Error("priority : x"), ""), false, "refus : nom de champ vide → false (aucune détection universelle)");
    ck.eq(JiraParse.errorMentionsField(Object.assign(new Error("x"), { body: "pas du json" }), "priority"), false, "refus : corps illisible → repli sur le message, sans exception");
  }
  });

  /* ============ SERVEUR : étiquettes `DCM-*` (module PUR — le risque n°1 se neutralise ici) ============ */

  await section("Serveur : TrackerLabels — composition, normalisation, et DIFF qui n'effleure JAMAIS les labels étrangers", async () => {
  {
    // -- FAMILLES : une seule table pilote le CODE d'étiquette et la COLLECTION de résolution. --
    ck.eq(TrackerLabels.labelFor("equipment", "SOS13"), "DCM-EQ-SOS13", "famille equipment → DCM-EQ-<NOM>");
    ck.eq(TrackerLabels.labelFor("vm", "SOSVM"), "DCM-VM-SOSVM", "famille vm → DCM-VM-<NOM>");
    ck.eq(TrackerLabels.labelFor("spare", "disque-1"), "DCM-SP-DISQUE-1", "famille spare → DCM-SP-<NOM>");
    ck.eq(TrackerLabels.labelFor("sub_equipment", "drive 4"), "DCM-SEQ-DRIVE-4", "famille sub_equipment → DCM-SEQ-<NOM>");
    ck.eq(TrackerLabels.labelFor("planet", "X"), null, "famille INCONNUE → aucun label (les liens sont des couples opaques, l'inconnu est toléré)");
    ck.eq(TrackerLabels.collectionOf("sub_equipment"), "subEquipments", "collection : la MÊME table donne où résoudre le nom");
    ck.eq(TrackerLabels.collectionOf("planet"), null, "collection : famille inconnue → null");

    // -- NORMALISATION : un label n'admet pas d'espace (contrainte Jira). Accents retirés, CAPITALES,
    //    tout le reste fondu en tirets, bords nettoyés, longueur bornée. --
    ck.eq(TrackerLabels.normalizeName("Baie Réseau n°2"), "BAIE-RESEAU-N-2", "normalisation : accents retirés, espaces et symboles → tirets, CAPITALES");
    ck.eq(TrackerLabels.normalizeName("  (SOS13)  "), "SOS13", "normalisation : tirets de BORD retirés (« (SOS13) » ne devient pas « -SOS13- »)");
    ck.eq(TrackerLabels.normalizeName("A  /  B"), "A-B", "normalisation : tirets consécutifs FONDUS (jamais « A---B »)");
    ck.eq(TrackerLabels.normalizeName("ÉÈÊË-ÀÂ-ÇÙÔ"), "EEEE-AA-CUO", "normalisation : toute la diacritique latine est repliée");
    // ⚠ Une LIGATURE n'est PAS un caractère accentué : « œ » n'a aucune décomposition canonique et
    //   survivrait à la normalisation d'accents — « SW Cœur » donnerait « SW-C-UR », introuvable.
    ck.eq(TrackerLabels.normalizeName("SW Cœur 01"), "SW-COEUR-01", "normalisation : la ligature « œ » devient « OE » (sans quoi l'étiquette serait méconnaissable)");
    ck.eq(TrackerLabels.normalizeName("Nœud & câble"), "NOEUD-CABLE", "normalisation : ligature + accent + symbole dans le même nom");
    ck.eq(TrackerLabels.normalizeName("tænia"), "TAENIA", "normalisation : la ligature « æ » aussi");
    ck.eq(TrackerLabels.normalizeName("sw-coeur-01"), "SW-COEUR-01", "normalisation : chiffres et tirets légitimes CONSERVÉS");
    ck.eq(TrackerLabels.normalizeName("!!!"), "", "normalisation : rien d'exploitable → \"\" …");
    ck.eq(TrackerLabels.labelFor("equipment", "!!!"), null, "… et donc AUCUN label (jamais un « DCM-EQ- » orphelin)");
    for (const junk of [null, undefined, 42, {}]) ck.eq(TrackerLabels.normalizeName(junk), "", "normalisation : " + JSON.stringify(junk) + " → \"\", sans jeter");
    const long = TrackerLabels.labelFor("equipment", "x".repeat(500));
    ck(long.length <= TrackerLabels.MAX_NAME_CHARS + 10, "normalisation : la partie NOM est BORNÉE (un label reste lisible dans une liste)");
    ck(!/-$/.test(long), "normalisation : la troncature ne laisse jamais un tiret final");

    // -- COMPOSITION : ordre des liens CONSERVÉ, doublons écartés, cibles inconnues ignorées. --
    const composed = TrackerLabels.compose([
      { kind: "equipment", name: "SOS13" }, { kind: "vm", name: "SOSVM" },
      { kind: "equipment", name: "sos13" },            // même label après normalisation → dédupliqué
      { kind: "planet", name: "Mars" },                 // famille inconnue → ignorée
      { kind: "spare", name: "   " },                   // nom inexploitable → ignoré
    ]);
    ck.eq(composed.join(","), "DCM-EQ-SOS13,DCM-VM-SOSVM", "compose : ordre conservé, doublons et cibles inexploitables écartés");
    ck.eq(TrackerLabels.compose("pas un tableau").length, 0, "compose : forme inattendue → [] (aucune exception)");

    // -- 🚨 DIFF : LE test du chantier. Le ticket porte des labels d'AUTRES sources — ils ne doivent
    //    apparaître dans AUCUN des deux verbes, jamais. --
    const foreign = ["equipe-reseau", "SLA-2h", "postmortem"];
    const diff = TrackerLabels.diff(["DCM-EQ-SOS13", "DCM-VM-NOUVELLE"], [...foreign, "DCM-EQ-SOS13", "DCM-SP-ANCIENNE"]);
    ck.eq(diff.add.join(","), "DCM-VM-NOUVELLE", "diff : seul le label DÉSIRÉ manquant est ajouté");
    ck.eq(diff.remove.join(","), "DCM-SP-ANCIENNE", "diff : seul le label GÉRÉ devenu obsolète est retiré");
    const touched = [...diff.add, ...diff.remove];
    ck(foreign.every((label) => !touched.includes(label)),
      "diff : 🚨 AUCUNE étiquette étrangère dans les verbes — le projet est PARTAGÉ, les labels des autres sources ne bougent jamais");
    ck(touched.every((label) => TrackerLabels.isManaged(label)), "diff : tout ce qui figure dans un verbe porte le préfixe DCM-");

    // -- Idempotence et casse : un tracker qui normalise la casse ne doit pas provoquer un
    //    ré-ajout perpétuel (le label ne serait jamais reconnu, l'ancien jamais retiré). --
    const stable = TrackerLabels.diff(["DCM-EQ-SOS13"], ["DCM-EQ-SOS13", "autre"]);
    ck(stable.add.length === 0 && stable.remove.length === 0, "diff : rien à faire quand le jeu géré correspond déjà (idempotence)");
    const cased = TrackerLabels.diff(["DCM-EQ-SOS13"], ["dcm-eq-sos13"]);
    ck(cased.add.length === 0 && cased.remove.length === 0, "diff : comparaison INSENSIBLE à la casse (sinon ré-ajout perpétuel)");

    // -- Un label DÉSIRÉ hors préfixe serait une fuite permanente : ajouté, jamais retirable. --
    const leak = TrackerLabels.diff(["pas-un-label-dcm", "DCM-EQ-A"], []);
    ck.eq(leak.add.join(","), "DCM-EQ-A", "diff : un label désiré SANS le préfixe est écarté (sinon il fuirait à jamais dans le projet d'autrui)");

    // -- Retrait TOTAL : plus aucune cible ⇒ tous les labels gérés partent, les autres restent. --
    const cleared = TrackerLabels.diff([], ["DCM-EQ-A", "DCM-VM-B", "externe"]);
    ck.eq(cleared.remove.sort().join(","), "DCM-EQ-A,DCM-VM-B", "diff : sans cible, tous les labels GÉRÉS sont retirés…");
    ck.eq(cleared.add.length, 0, "diff : … et rien n'est ajouté");
    ck(!cleared.remove.includes("externe"), "diff : … l'étiquette étrangère RESTE, même quand on retire tout le reste");
    ck.eq(TrackerLabels.isManaged("externe"), false, "isManaged : une étiquette sans préfixe n'est pas gérée");
    for (const junk of [null, undefined, 42, ""]) ck.eq(TrackerLabels.isManaged(junk), false, "isManaged : " + JSON.stringify(junk) + " → false");
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

  await section("Serveur : JiraAdapter.resolve — LOTS, partage found/missing, pagination, cap dur, champs demandés", async () => {
  {
    const pool = [fixtureIssue("10001", "INFRA-1"), fixtureIssue("10002", "INFRA-2")];
    const stub = mkJiraStub({ ["POST " + JiraAdapter.PATH_SEARCH]: searchRoute(pool) });
    const out = await new JiraAdapter(CFG, stub).resolve(["10001", "10002", "10003"]);

    ck.eq(out.found.length, 2, "resolve : les tickets RÉSOLUS reviennent");
    ck.eq(JSON.stringify(out.missing), JSON.stringify(["10003"]), "resolve : l'identifiant non revenu ressort en `missing` (c'est le SERVICE qui en déduira « introuvable »)");
    ck.eq(stub.calls.length, 1, "resolve : 🚨 UNE SEULE requête pour 3 identifiants — résolution PAR LOTS, jamais N requêtes unitaires");
    ck.eq(stub.calls[0].path, JiraAdapter.PATH_SEARCH, "resolve : … sur le chemin de recherche isolé en constante");
    ck.eq(idsInJql(stub.calls[0].body).join(","), "10001,10002,10003", "resolve : les 3 identifiants voyagent dans la MÊME clause JQL");
    ck.eq(JSON.stringify(stub.calls[0].body.fields), JSON.stringify(JiraAdapter.FIELDS), "resolve : seuls les champs du PIVOT sont demandés (jamais `*all` — les champs perso d'un projet pèsent lourd)");
    for (const needed of ["status", "assignee", "labels"]) {
      ck(JiraAdapter.FIELDS.includes(needed), "resolve : le champ « " + needed + " » est demandé (statut/assigné affichés, labels indispensables au DIFF)");
    }
    ck(!JiraAdapter.FIELDS.includes("summary") && !JiraAdapter.FIELDS.includes("description"),
      "resolve : le CONTENU n'est PAS relu — DC Manager en fait foi, le rapatrier créerait deux vérités concurrentes");
    ck(out.found.every((r) => Array.isArray(r.labels)), "resolve : chaque état porte ses étiquettes courantes");
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
    ck.eq(JSON.stringify(byKey.labels), JSON.stringify(["reseau", "urgent"]), "lookup : les étiquettes COURANTES reviennent — c'est ce qui rend le diff possible avant une mise à jour");
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

  await section("Serveur : JiraAdapter.createIssue — type PAR NATURE, ADF, labels/priorité/échéance, refus INTACT", async () => {
  {
    const created = { id: "10500", key: "INFRA-500", self: BASE + "/rest/api/3/issue/10500" };
    const mkCreateStub = () => mkJiraStub({
      ["POST " + JiraAdapter.PATH_ISSUE_CREATE]: created,
      ["GET " + JiraAdapter.pathIssue("10500")]: fixtureIssue("10500", "INFRA-500"),
    });
    const stub = mkCreateStub();
    const state = await new JiraAdapter(CFG, stub).createIssue(pushContent({ summary: "  Panne cœur  " }));

    const body = stub.calls[0].body;
    ck.eq(body.fields.project.key, "INFRA", "createIssue : le PROJET vient des OPTIONS du provider (l'utilisateur n'a pas à connaître la config du tracker)");
    ck.eq(body.fields.issuetype.name, "Infrastructure", "createIssue : nature `intervention` → type `type_intervention` des options");
    ck.eq(body.fields.summary, "Panne cœur", "createIssue : titre rogné");
    ck.eq(body.fields.description.type, "doc", "createIssue : 🚨 la description est un document ADF, JAMAIS une chaîne (l'API v3 la refuserait)");
    ck.eq(body.fields.description.content.length, 3, "createIssue : … construit ligne à ligne");
    ck.eq(JSON.stringify(body.fields.labels), JSON.stringify(["DCM-EQ-SOS13"]), "createIssue : les étiquettes des objets liés partent AVEC la création");
    ck.eq(body.fields.priority.name, "High", "createIssue : la priorité DC Manager est traduite en NOM Jira (table fixe)");
    ck.eq(body.fields.duedate, "2026-08-12", "createIssue : `planned_end` devient une échéance `YYYY-MM-DD`");
    ck.eq(body.update, undefined, "createIssue : aucun verbe d'édition à la création (le ticket n'a pas d'existant à préserver)");
    ck.eq(state.ext_id, "10500", "createIssue : l'état rendu porte l'identifiant interne");
    ck.eq(state.status_category, "in_progress", "createIssue : le ticket est RELU pour obtenir le statut (la réponse de création ne le porte pas)");

    // NATURE `incident` → l'AUTRE type. C'est la demande utilisateur explicite du cadrage.
    const incidentStub = mkCreateStub();
    await new JiraAdapter(CFG, incidentStub).createIssue(pushContent({ kind: "incident" }));
    ck.eq(incidentStub.calls[0].body.fields.issuetype.name, "Incident", "createIssue : nature `incident` → type `type_incident` des options");
    const oddStub = mkCreateStub();
    await new JiraAdapter(CFG, oddStub).createIssue(pushContent({ kind: "vocabulaire-inconnu" }));
    ck.eq(oddStub.calls[0].body.fields.issuetype.name, "Infrastructure",
      "createIssue : nature INATTENDUE → type des interventions (un ticket au mauvais type se corrige d'un clic ; une réplication refusée, non)");

    // Champs FACULTATIFS omis quand ils n'ont rien à dire (jamais de `null` gratuit dans un corps).
    const bareStub = mkCreateStub();
    await new JiraAdapter(CFG, bareStub).createIssue(pushContent({ labels: [], priority: null, duedate: null }));
    const bare = bareStub.calls[0].body.fields;
    ck(!("labels" in bare) && !("priority" in bare) && !("duedate" in bare),
      "createIssue : sans étiquette, sans priorité et sans échéance, ces champs sont ABSENTS du corps");
    const badDate = mkCreateStub();
    await new JiraAdapter(CFG, badDate).createIssue(pushContent({ duedate: "hier" }));
    ck(!("duedate" in badDate.calls[0].body.fields), "createIssue : une échéance non conforme est OMISE (une fausse date d'exploitation est pire qu'aucune)");

    // 🚨 REFUS DU TRACKER : le message d'origine remonte TEL QUEL — c'est lui qui est actionnable.
    const refusal = "Tracker : HTTP 400 sur /rest/api/3/issue — customfield_10010 : Le champ « Équipe » est requis";
    let refused = null;
    try {
      await new JiraAdapter(CFG, mkJiraStub({ ["POST " + JiraAdapter.PATH_ISSUE_CREATE]: Object.assign(new Error(refusal), { status: 400 }) }))
        .createIssue(pushContent());
    } catch (e) { refused = e; }
    ck.eq(refused && refused.message, refusal,
      "createIssue : le refus du tracker remonte MOT POUR MOT — l'envelopper dans un « échec de création » générique détruirait la seule information exploitable");

    // 🚨 PRIORITÉ REFUSÉE PAR LE PROJET (risque n°2) : UNE retente sans elle, et le dégradé est DIT.
    let attempts = 0;
    const noPriority = mkJiraStub({
      ["POST " + JiraAdapter.PATH_ISSUE_CREATE]: (body) => {
        attempts++;
        if (body.fields.priority) throw Object.assign(new Error("Tracker : HTTP 400 sur /rest/api/3/issue — priority : Field 'priority' cannot be set"), { status: 400, body: JSON.stringify({ errors: { priority: "Field 'priority' cannot be set" } }) });
        return created;
      },
      ["GET " + JiraAdapter.pathIssue("10500")]: fixtureIssue("10500", "INFRA-500"),
    });
    const notes = [];
    const degraded = await new JiraAdapter(CFG, noPriority).createIssue(pushContent(), (m) => notes.push(m));
    ck.eq(degraded.ext_id, "10500", "priorité refusée : la création ABOUTIT quand même (les projets team-managed n'ont souvent pas ce champ)");
    ck.eq(attempts, 2, "priorité refusée : EXACTEMENT une retente, jamais deux (au-delà on ne saurait plus ce qu'on a poussé)");
    ck(!noPriority.calls[1].body.fields.priority, "priorité refusée : la seconde tentative part SANS le champ");
    ck(notes.length === 1 && /priorité/i.test(notes[0]), "priorité refusée : le DÉGRADÉ est signalé (un silence ferait croire à une réplication complète)");

    // ⚠ JAMAIS de retente sans `issuetype` : un type refusé est une erreur de CONFIGURATION.
    let typeAttempts = 0;
    let typeRefused = null;
    try {
      await new JiraAdapter(CFG, mkJiraStub({
        ["POST " + JiraAdapter.PATH_ISSUE_CREATE]: () => { typeAttempts++; throw Object.assign(new Error("Tracker : HTTP 400 — issuetype : The issue type selected is invalid"), { status: 400, body: JSON.stringify({ errors: { issuetype: "The issue type selected is invalid" } }) }); },
      })).createIssue(pushContent(), () => { ck(false, "priorité : aucun dégradé ne doit être signalé sur un refus de TYPE"); });
    } catch (e) { typeRefused = e; }
    ck.eq(typeAttempts, 1, "issuetype refusé : AUCUNE retente (créer sans type produirait des tickets d'un type arbitraire)");
    ck(typeRefused !== null && /issue type selected is invalid/.test(typeRefused.message), "issuetype refusé : le message du tracker remonte INTACT");

    // Relecture en échec APRÈS création réussie : on ne perd JAMAIS le ticket créé.
    const orphanRead = mkJiraStub({ ["POST " + JiraAdapter.PATH_ISSUE_CREATE]: created });   // la route GET n'existe pas → 404
    const minimal = await new JiraAdapter(CFG, orphanRead).createIssue(pushContent());
    ck.eq(minimal.ext_id, "10500", "createIssue : relecture impossible → on rend quand même l'état MINIMAL (le ticket EXISTE chez le tracker)");
    ck.eq(minimal.key, "INFRA-500", "createIssue : … avec sa clé");
    ck.eq(minimal.url, BASE + "/browse/INFRA-500", "createIssue : … et son lien d'interface");
    ck.eq(JSON.stringify(minimal.labels), JSON.stringify(["DCM-EQ-SOS13"]),
      "createIssue : … et les étiquettes qu'on VIENT de poser (les laisser vides ferait croire au prochain diff qu'elles ont disparu)");

    // Réponse de création sans identifiant : erreur AMBIGUË, mais qui cite la clé pour la rattraper.
    let lost = null;
    try {
      await new JiraAdapter(CFG, mkJiraStub({ ["POST " + JiraAdapter.PATH_ISSUE_CREATE]: { key: "INFRA-777" } })).createIssue(pushContent());
    } catch (e) { lost = e; }
    ck(lost !== null && /INFRA-777/.test(lost.message) && /LIANT/.test(lost.message),
      "createIssue : réponse sans identifiant → l'erreur CITE la clé créée et la marche à suivre (jamais de suppression compensatoire chez le tracker)");

    // Garde-fous d'entrée : aucun appel réseau tant que la demande est inexploitable.
    const guarded = mkJiraStub({});
    let noProject = null;
    try { await new JiraAdapter({ ...CFG, options: { type_incident: "Incident" } }, guarded).createIssue(pushContent()); } catch (e) { noProject = e; }
    ck(noProject !== null && /project_key/.test(noProject.message), "createIssue : projet non configuré → message ACTIONNABLE nommant l'option à remplir");
    let noSummary = null;
    try { await new JiraAdapter(CFG, guarded).createIssue(pushContent({ summary: "   " })); } catch (e) { noSummary = e; }
    ck(noSummary !== null && /titre/i.test(noSummary.message), "createIssue : titre vide → refus explicite");
    ck.eq(guarded.calls.length, 0, "createIssue : … et AUCUN appel réseau n'a été tenté dans ces deux cas");
  }
  });

  await section("Serveur : JiraAdapter.updateIssue — PUT, labels EN VERBES (jamais un remplacement), échéance vidable", async () => {
  {
    const mkPutStub = (handler) => mkJiraStub({ ["PUT " + JiraAdapter.pathIssue("10500")]: handler || (() => null) });

    const stub = mkPutStub();
    await new JiraAdapter(CFG, stub).updateIssue("10500", pushContent(), ["DCM-VM-NOUVELLE"], ["DCM-SP-ANCIENNE"]);
    ck.eq(stub.calls.length, 1, "updateIssue : UNE requête");
    ck.eq(stub.calls[0].method, "PUT", "updateIssue : verbe PUT (hypothèse d'API n°10)");
    ck.eq(stub.calls[0].path, JiraAdapter.pathIssue("10500"), "updateIssue : … sur la fiche du ticket, par IDENTIFIANT interne");

    const body = stub.calls[0].body;
    ck.eq(body.fields.summary, "Remplacement switch", "updateIssue : le titre DC Manager fait foi");
    ck.eq(body.fields.description.type, "doc", "updateIssue : description en ADF, comme à la création");
    ck.eq(body.fields.priority.name, "High", "updateIssue : priorité traduite");
    ck.eq(body.fields.duedate, "2026-08-12", "updateIssue : échéance posée");
    ck.eq(body.fields.issuetype, undefined,
      "updateIssue : le TYPE n'est PAS repoussé (changer le type d'un ticket existant est une opération à part, parfois refusée par le workflow)");

    // 🚨 LE test du risque n°1 : les labels passent par des VERBES, jamais par `fields.labels`.
    ck.eq(body.fields.labels, undefined, "updateIssue : 🚨 AUCUN `fields.labels` — un remplacement effacerait les étiquettes des AUTRES sources du projet partagé");
    ck.eq(JSON.stringify(body.update.labels), JSON.stringify([{ add: "DCM-VM-NOUVELLE" }, { remove: "DCM-SP-ANCIENNE" }]),
      "updateIssue : les étiquettes voyagent en VERBES add/remove (pas de course lecture-modification-écriture)");

    // Aucun verbe à passer ⇒ la clé `update` est OMISE (une intention qu'on n'a pas ne s'envoie pas).
    const noVerbs = mkPutStub();
    await new JiraAdapter(CFG, noVerbs).updateIssue("10500", pushContent(), [], []);
    ck.eq(noVerbs.calls[0].body.update, undefined, "updateIssue : aucun changement d'étiquette → pas de clé `update` du tout");

    // Étiquettes VIDES/doublons : ceinture de sécurité — un verbe vide ferait refuser TOUTE la requête.
    const dirty = mkPutStub();
    await new JiraAdapter(CFG, dirty).updateIssue("10500", pushContent(), ["  DCM-EQ-A  ", "", "DCM-EQ-A", null], []);
    ck.eq(JSON.stringify(dirty.calls[0].body.update.labels), JSON.stringify([{ add: "DCM-EQ-A" }]), "updateIssue : verbes rognés, dédupliqués, vides écartés");

    // ÉCHÉANCE RETIRÉE dans DC Manager → `duedate: null`, qui VIDE le champ côté Jira.
    const cleared = mkPutStub();
    await new JiraAdapter(CFG, cleared).updateIssue("10500", pushContent({ duedate: null }), [], []);
    ck.eq(cleared.calls[0].body.fields.duedate, null,
      "updateIssue : échéance retirée → `duedate: null` (sans quoi une date périmée survivrait indéfiniment dans le ticket)");

    // PRIORITÉ REFUSÉE : même repli qu'à la création, une seule retente, dégradé signalé.
    let attempts = 0;
    const notes = [];
    const noPriority = mkPutStub((body) => {
      attempts++;
      if (body.fields.priority) throw Object.assign(new Error("Tracker : HTTP 400 — priority : Field 'priority' cannot be set"), { status: 400 });
      return null;
    });
    await new JiraAdapter(CFG, noPriority).updateIssue("10500", pushContent(), ["DCM-EQ-A"], [], (m) => notes.push(m));
    ck.eq(attempts, 2, "updateIssue : priorité refusée → UNE retente sans elle");
    ck(notes.length === 1 && /priorité/i.test(notes[0]), "updateIssue : … et le dégradé est signalé");
    ck.eq(JSON.stringify(noPriority.calls[1].body.update.labels), JSON.stringify([{ add: "DCM-EQ-A" }]),
      "updateIssue : la retente conserve les VERBES d'étiquettes (le repli ne perd rien d'autre que la priorité)");

    // Erreur AUTRE que la priorité : remonte telle quelle, sans retente.
    let other = null;
    let otherAttempts = 0;
    try {
      await new JiraAdapter(CFG, mkPutStub(() => { otherAttempts++; throw Object.assign(new Error("Tracker : HTTP 403 sur /rest/api/3/issue/10500 — droits insuffisants"), { status: 403 }); }))
        .updateIssue("10500", pushContent(), [], []);
    } catch (e) { other = e; }
    ck.eq(otherAttempts, 1, "updateIssue : une erreur qui ne DÉSIGNE PAS la priorité ne déclenche aucune retente");
    ck(other !== null && /droits insuffisants/.test(other.message), "updateIssue : … et son message remonte INTACT");

    // Garde-fous d'entrée : aucun appel réseau si la demande est inexploitable.
    const guarded = mkPutStub();
    let noId = null;
    try { await new JiraAdapter(CFG, guarded).updateIssue("   ", pushContent(), [], []); } catch (e) { noId = e; }
    ck(noId !== null && /identifiant/i.test(noId.message), "updateIssue : identifiant vide → refus explicite");
    let noSummary = null;
    try { await new JiraAdapter(CFG, guarded).updateIssue("10500", pushContent({ summary: " " }), [], []); } catch (e) { noSummary = e; }
    ck(noSummary !== null && /titre/i.test(noSummary.message), "updateIssue : titre vide → refus explicite");
    ck.eq(guarded.calls.length, 0, "updateIssue : … et AUCUN appel réseau n'a été tenté dans ces deux cas");
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

  await section("Serveur : TrackerProviderConfigValidate — champs communs, kind inconnu, options PAR MARQUE", async () => {
  {
    const { TrackerProviderConfigValidate, TrackerProviderConfigError, KIND_OPTION_SPECS, SUPPORTED_KINDS } = SERVER("tracker/TrackerProviderConfigValidate.js");
    const validate = (raw) => { const errors = []; const cfg = TrackerProviderConfigValidate.parseProvider("doc-A", 0, raw, errors); return { cfg, errors }; };
    const SECRET = "jeton-api-tres-secret";
    // `project_key` est REQUIS depuis le pivot vers la RÉPLICATION : la base minimale le porte donc.
    const base = { id: "tr1", kind: "jira", url: BASE, token: SECRET, account: "svc@example.net", options: { project_key: "INFRA" } };

    // 1) DÉFAUTS des champs communs.
    const ok = validate(base);
    ck(ok.cfg !== null && ok.errors.length === 0, "provider minimal valide → config produite");
    ck(ok.cfg.interval_sec === 0 && ok.cfg.timeout_sec === TrackerProviderConfigValidate.DEFAULT_TIMEOUT_SEC, "défauts : interval_sec 0 (manuelle), timeout_sec = DEFAULT_TIMEOUT_SEC");
    ck(ok.cfg.timeout_sec > 15, "défauts : délai PLUS GÉNÉREUX que les modules d'inventaire — une recherche SaaS n'est pas une lecture sur le LAN");
    ck(!("fingerprint" in ok.cfg) && !("ca_pem" in ok.cfg), "écart ASSUMÉ : aucun matériel TLS dans la config (un tracker SaaS a un certificat public — rien à épingler)");

    // 1bis) ROGNAGE des champs communs — cause RÉELLE d'un 401 constaté le 2026-08-07 : un jeton
    // collé depuis la boîte de dialogue du tracker embarque un retour-ligne de fin, invisible dans
    // le formulaire mais présent dans le base64 de l'en-tête Basic. La validation doit STOCKER la
    // valeur rognée, pas seulement valider sur elle.
    const pasted = validate({ ...base, token: SECRET + "\n", account: "  svc@example.net  " });
    ck(pasted.errors.length === 0 && pasted.cfg !== null, "jeton avec retour-ligne collé → valide (le rognage n'est pas un refus)");
    ck(pasted.cfg.token === SECRET, "jeton STOCKÉ rogné (le \\n de fin n'entre pas dans le base64 de l'auth Basic)");
    ck(pasted.cfg.account === "svc@example.net", "account STOCKÉ rogné (espaces périphériques retirés)");

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
    ck.eq(ok.cfg.options.type_incident, "Incident", "options : `type_incident` absent → défaut « Incident » (demande utilisateur)");
    ck.eq(ok.cfg.options.type_intervention, "Infrastructure", "options : `type_intervention` absent → défaut « Infrastructure »");
    ck.eq(ok.cfg.options.auto_replicate, true, "options : `auto_replicate` absent → VRAI (configurer un provider de réplication, c'est vouloir que ça réplique)");
    // 🚨 `project_key` est REQUIS depuis le pivot : un provider n'existe QUE pour porter les
    //    interventions dans un projet — sans destination il n'a littéralement rien à faire.
    const noProject = validate({ ...base, options: {} });
    ck(noProject.cfg === null && noProject.errors.some((m) => /project_key/.test(m)),
      "options : `project_key` ABSENT → erreur (la réplication a besoin d'une destination)");
    ck(validate({ ...base, options: { project_key: "   " } }).errors.some((m) => /project_key/.test(m)), "options : `project_key` vide → erreur");
    const opts = validate({ ...base, options: { project_key: "OPS", type_incident: "Panne", type_intervention: "Maintenance", auto_replicate: false } });
    ck(opts.cfg.options.project_key === "OPS" && opts.cfg.options.type_incident === "Panne" && opts.cfg.options.type_intervention === "Maintenance",
      "options : valeurs fournies retenues (les types suivent la CONFIGURATION et la LANGUE du projet)");
    ck.eq(opts.cfg.options.auto_replicate, false, "options : `auto_replicate` désactivable (réplication à la main seulement)");
    ck(validate({ ...base, options: { project_key: "X", type_incident: "   " } }).errors.some((m) => /type_incident/.test(m)),
      "options : un type vidé à la main → erreur (sinon création refusée en 400 illisible)");
    ck(validate({ ...base, options: { project_key: 42 } }).errors.some((m) => /project_key/.test(m)), "options : type erroné → erreur explicite");
    ck(validate({ ...base, options: { project_key: "X", auto_replicate: "oui" } }).errors.some((m) => /auto_replicate/.test(m)), "options : booléen attendu → erreur explicite");
    const unknownOpt = validate({ ...base, options: { project_key: "X", option_d_une_autre_marque: 42 } });
    ck(unknownOpt.cfg !== null && !("option_d_une_autre_marque" in unknownOpt.cfg.options),
      "options : clé INCONNUE écartée SILENCIEUSEMENT (une option d'une autre marque ne rend pas la config irrécupérable)");
    ck(validate({ ...base, options: "pas un objet" }).errors.some((m) => /project_key/.test(m)),
      "options : forme inattendue → les défauts s'appliquent, mais l'option REQUISE manque toujours (aucune destination inventée)");

    // 5) intervalles.
    ck(validate({ ...base, interval_sec: -1 }).errors.some((m) => /interval_sec/.test(m)), "interval_sec négatif → erreur");
    ck(validate({ ...base, timeout_sec: 0 }).errors.some((m) => /timeout_sec/.test(m)), "timeout_sec 0 → erreur");
    ck(validate("pas un objet").errors.some((m) => /objet/.test(m)), "provider non-objet → erreur");

    // 6) L'erreur porte les issues (rendues en 400 par les routes du lot L3).
    const err = new TrackerProviderConfigError(["souci A", "souci B"]);
    ck(Array.isArray(err.issues) && err.issues.length === 2 && err.name === "TrackerProviderConfigError", "TrackerProviderConfigError porte les issues + message agrégé");
  }
  });

  /* ============ SERVEUR : stockage chiffré des providers (better-sqlite3 RÉEL) ============ */

  await section("Serveur : TrackerProviderConfigDb — schéma, CRUD sans fuite de jeton, compte RELU, jeton indéchiffrable", async () => {
    // better-sqlite3 RÉEL requis (binaire natif) — même probe que les autres sections DB.
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probe = new Candidate(":memory:"); probe.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section TrackerProviderConfigDb sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { TrackerProviderConfigDb } = SERVER("tracker/TrackerProviderConfigDb.js");
    const { SecretBox } = SERVER("SecretBox.js");
    const { TrackerProviderConfigError } = SERVER("tracker/TrackerProviderConfigValidate.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-trackerdb-"));
    let raw = null;
    try {
      const box = new SecretBox("passphrase-infra-longue-de-test");
      const db = new TrackerProviderConfigDb(dir, Sqlite, box);   // Logger "error" par défaut → silencieux

      // -- SCHÉMA : fichier matérialisé, UNE table, et SURTOUT aucun matériel TLS. --
      ck(fs.existsSync(path.join(dir, "tracker-providers.db")), "tracker-providers.db matérialisé dans le dossier injecté");
      raw = new Sqlite(path.join(dir, "tracker-providers.db"));
      ck.eq(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name).join(","), "tracker_providers",
        "schéma : UNE SEULE table (un tracker n'a qu'une instance — pas de pool d'endpoints)");
      const columns = raw.prepare("PRAGMA table_info(tracker_providers)").all().map((r) => r.name);
      ck(columns.includes("account") && columns.includes("token_enc"), "schéma : `account` (public) et `token_enc` (chiffré) sont deux colonnes distinctes");
      ck(!columns.includes("fingerprint") && !columns.includes("ca_pem"), "schéma : écart ASSUMÉ à vm/ et wifi/ — AUCUNE colonne d'épinglage/CA (rien à épingler sur un service public)");

      // -- save (création) : jeton fourni, options normalisées ; réponse SANS jeton. --
      const saved = db.save("doc-A", { id: "tr1", kind: "jira", url: BASE, account: "svc@example.net", interval_sec: 900, options: { project_key: "INFRA", type_incident: "Panne", auto_replicate: false } }, "JETON-1");
      ck(saved.id === "tr1" && saved.url === BASE, "save (création) → item renvoyé");
      ck.eq(saved.has_token, true, "save : has_token = true");
      ck.eq(saved.account, "svc@example.net", "save : le COMPTE est relu (ce n'est pas un secret — c'est toute la différence avec le jeton)");
      ck(saved.options.project_key === "INFRA" && saved.options.type_incident === "Panne" && saved.options.auto_replicate === false, "save : options de la marque restituées");
      ck(!("token" in saved) && !JSON.stringify(saved).includes("JETON-1"), "save : réponse SANS jeton (ni clair ni chiffré)");

      // -- listFor : SANS jeton ; le jeton est CHIFFRÉ en base. --
      const list = db.listFor("doc-A");
      ck(list.length === 1 && !("token" in list[0]) && list[0].has_token === true, "listFor : jeton JAMAIS renvoyé (has_token seulement)");
      const row = raw.prepare("SELECT token_enc, account, options FROM tracker_providers WHERE doc_id=? AND id=?").get("doc-A", "tr1");
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
      db.save("doc-A", { id: "tr-aud", kind: "jira", url: BASE, account: "a@x.net", options: { project_key: "AUD" } }, "JETON-AUD", "u-alice");
      let audit = raw.prepare("SELECT created_by, updated_by FROM tracker_providers WHERE id='tr-aud'").get();
      ck(audit.created_by === "u-alice" && audit.updated_by === "u-alice", "audit : création → created_by/updated_by = id de l'auteur");
      db.save("doc-A", { id: "tr-aud", kind: "jira", url: BASE, account: "a@x.net", interval_sec: 60, options: { project_key: "AUD" } }, null, "u-bob");
      audit = raw.prepare("SELECT created_by, updated_by FROM tracker_providers WHERE id='tr-aud'").get();
      ck(audit.created_by === "u-alice" && audit.updated_by === "u-bob", "audit : mise à jour → created_by CONSERVÉ, updated_by rafraîchi");
      ck.eq(raw.prepare("SELECT created_by FROM tracker_providers WHERE id='tr1'").get().created_by, null, "audit : écriture sans auteur → colonne NULL");
      db.remove("doc-A", "tr-aud");

      // -- save (édition, jeton vide → CONSERVÉ) : la sentinelle satisfait « token requis » sans rien stocker. --
      const upd = db.save("doc-A", { id: "tr1", kind: "jira", url: BASE, account: "autre@example.net", interval_sec: 1800, options: { project_key: "OPS" } }, null);
      ck.eq(upd.interval_sec, 1800, "save (édition) : champ mis à jour");
      ck.eq(db.providersFor("doc-A")[0].token, "JETON-1", "save (édition, jeton vide) : jeton EXISTANT conservé");
      ck.eq(upd.account, "autre@example.net", "save (édition) : le compte, lui, se met à jour normalement");
      ck.eq(upd.options.type_incident, "Incident", "save (édition) : option non renvoyée → retour au DÉFAUT (les options sont remplacées en bloc)");

      // -- création SANS jeton / config invalide → TrackerProviderConfigError, jeton jamais divulgué. --
      let noToken = null;
      try { db.save("doc-A", { id: "tr-new", kind: "jira", url: BASE, account: "a@x.net", options: { project_key: "NEW" } }, null); } catch (e) { noToken = e; }
      ck(noToken instanceof TrackerProviderConfigError && noToken.issues.some((m) => /token/.test(m)), "save (création sans jeton) → « token requis »");
      let invalid = null;
      try { db.save("doc-A", { id: "tr-bad", kind: "jira" }, "JETON-NOPE"); } catch (e) { invalid = e; }
      ck(invalid instanceof TrackerProviderConfigError && !invalid.message.includes("JETON-NOPE"), "save invalide → erreur de validation, jeton jamais dans le message");

      // -- buildForTest : jeton du corps, sinon le STOCKÉ déchiffré (tester sans ressaisir). --
      ck.eq(db.buildForTest("doc-A", { id: "tr1", kind: "jira", url: BASE, account: "a@x.net", options: { project_key: "INFRA" } }, null).token, "JETON-1", "buildForTest : jeton vide + provider existant → jeton STOCKÉ déchiffré");
      ck.eq(db.buildForTest("doc-A", { id: "tr1", kind: "jira", url: BASE, account: "a@x.net", options: { project_key: "INFRA" } }, "NOUVEAU").token, "NOUVEAU", "buildForTest : jeton fourni → celui-là");

      ck.eq(db.remove("doc-A", "inexistant"), false, "remove (id inconnu) → false");

      // -- Jeton INDÉCHIFFRABLE (coffre à AUTRE clé) → provider EXCLU + erreur consultable, JAMAIS de throw global. --
      const db2 = new TrackerProviderConfigDb(dir, Sqlite, new SecretBox("une-toute-autre-passphrase-de-test"));
      ck.eq(db2.providersFor("doc-A").length, 0, "jeton indéchiffrable (autre clé) → provider EXCLU de la synchro, sans exception");
      const errs = db2.tokenErrorsFor("doc-A");
      ck(errs.length === 1 && errs[0].id === "tr1" && /ressaisi/.test(errs[0].message) && !errs[0].message.includes("JETON-1"),
        "…erreur MÉMORISÉE consultable (id + « à ressaisir »), sans le jeton");
      ck.eq(db2.summariesFor("doc-A").length, 0, "…et le chemin STATUT l'exclut pareillement (précondition de sa réinjection en erreur par TrackerModule)");
      db2.close();

      // -- Options ILLISIBLES en base (édition manuelle / version future) → {} plutôt qu'un throw. --
      raw.prepare("UPDATE tracker_providers SET options = 'pas du json' WHERE id='tr1'").run();
      ck.eq(JSON.stringify(db.listFor("doc-A")[0].options), "{}", "options illisibles en base → {} (l'adaptateur retombe sur ses défauts, aucun throw)");

      db.close();
    } finally {
      try { if (raw) raw.close(); } catch (_) { /* déjà fermé */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* dossier temp (handles longs sous Windows) */ }
    }
  });

  /* ============ SERVEUR : plafond ROULANT d'une passe de synchro (module PUR) ============ */

  await section("Serveur : TrackerPassScope — plafond de passe, ordre stable et ROULEMENT (aucune zone morte)", async () => {
  {
    const { TrackerPassScope } = SERVER("tracker/TrackerPassScope.js");
    const t = (extId, lastSync) => ({ id: "x-" + extId, ext_id: extId, last_sync: lastSync });
    const assiette = [t("a", "2026-08-05"), t("b", ""), t("c", "2026-08-01")];

    // -- Ordre STABLE : jamais synchronisés d'abord — la priorité SENSÉE du premier tour. --
    const full = TrackerPassScope.compute(assiette, 10);
    ck.eq(full.batch.join(","), "b,c,a", "ordre : `last_sync` CROISSANT — les jamais synchronisés (\"\") passent en tête");
    ck.eq(full.skipped, 0, "sous le plafond → rien de reporté");
    ck.eq(full.nextStart, 0, "sous le plafond → aucun roulement à mémoriser");

    // -- PLAFOND + ROULEMENT : l'assiette entière défile en ⌈N/plafond⌉ passes, MÊME si rien ne
    //    change (l'idempotence n'avance pas `last_sync`, donc un simple tri ne suffirait PAS). --
    const p1 = TrackerPassScope.compute(assiette, 2, 0);
    ck.eq(p1.batch.join(","), "b,c", "plafond : seuls N identifiants sont interrogés");
    ck.eq(p1.skipped, 1, "plafond : le reliquat est COMPTÉ (il sera journalisé et remonté au statut)");
    const p2 = TrackerPassScope.compute(assiette, 2, p1.nextStart);
    ck.eq(p2.batch.join(","), "a,b", "ROULEMENT : la passe suivante reprend où la précédente s'est arrêtée (fenêtre circulaire)");
    ck(p2.batch.includes("a"), "ROULEMENT : … donc l'objet reporté EST interrogé — aucune zone morte, quoi qu'il arrive aux données");
    const p3 = TrackerPassScope.compute(assiette, 2, p2.nextStart);
    ck.eq(p3.batch.join(","), "c,a", "ROULEMENT : le tour se poursuit indéfiniment");

    // -- Robustesse : curseur périmé, doublons, identités vides, plafond absurde. --
    ck.eq(TrackerPassScope.compute(assiette, 2, 999).batch.length, 2, "curseur hors bornes (objets retirés depuis) → ramené dans les bornes, jamais d'exception");
    ck.eq(TrackerPassScope.compute(assiette, 2, -5).batch.length, 2, "curseur négatif → idem (modulo positif)");
    ck.eq(TrackerPassScope.compute([t("a", ""), t("a", ""), t("", "")], 10).batch.join(","), "a", "assiette : doublon d'ext_id dédupliqué, ext_id vide écarté");
    ck.eq(TrackerPassScope.compute([t("a", "")], 0).batch.length, 1, "plafond absurde (0) → AUCUN plafond, plutôt qu'une passe morte");
    ck.eq(TrackerPassScope.compute([], 10).batch.length, 0, "assiette vide → rien à demander");

    // -- NOMS DE CHAMP PARAMÉTRÉS : ce que l'extraction hors du service de synchro a ajouté. Le
    //    module ne présume plus rien de la collection qu'il borne — le PONT vers Jira (lot P2)
    //    bornera des interventions à colonnes `tracker_*`, pas des tickets à colonnes `ext_id`. --
    const tracked = [
      { tracker_ext_id: "j-2", tracker_last_sync: "2026-08-05" },
      { tracker_ext_id: "j-1", tracker_last_sync: "" },
    ];
    ck.eq(TrackerPassScope.compute(tracked, 10, 0, "tracker_ext_id", "tracker_last_sync").batch.join(","), "j-1,j-2",
      "champs paramétrés : la même règle s'applique à d'AUTRES colonnes (ordre par le champ de sync fourni)");
    ck.eq(TrackerPassScope.compute(tracked, 10).batch.length, 0,
      "champs paramétrés : … et les DÉFAUTS (`ext_id`/`last_sync`) ne matchent alors rien — aucune identité devinée");
  }
  });

  /* ============ SERVEUR : LE PONT de bout en bout (interventions.db + DocumentStore RÉELS) ============ */

  await section("Serveur : pont interventions ⇄ tracker — poussée TOLÉRANTE, création, labels, retour d'état, auto-réplication", async () => {
    // better-sqlite3 RÉEL requis (binaire natif) — même probe que les autres sections DB.
    let Sqlite = null;
    try {
      const Candidate = require(path.join(__dirname, "..", "..", "src-server", "node_modules", "better-sqlite3"));
      const probe = new Candidate(":memory:"); probe.close();
      Sqlite = Candidate;
    } catch (_) { /* module/binaire absent → section sautée */ }
    if (!Sqlite) { ck(true, "better-sqlite3 indisponible → section du pont sautée"); return; }

    const fs = require("fs"), os = require("os");
    const { DocumentStore } = SERVER("documents.js");
    const { InterventionsDb } = SERVER("interventions/InterventionsDb.js");
    const { TrackerSyncService } = SERVER("tracker/TrackerSyncService.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm-tracker-pont-"));
    let idb = null;
    let docs = null;
    try {
      /* ---- Décor : un document RÉEL (les étiquettes se composent en résolvant les liens contre lui)
              et la base des interventions, RÉELLE elle aussi (c'est elle qui persiste l'état de
              poussée — sans quoi le scénario « redémarrage » ne prouverait rien). ---- */
      docs = new DocumentStore(dir, Sqlite);
      const doc = docs.create("infra-test");
      docs.repo(doc.id).transact({ creates: [
        { collection: "equipments", record: { id: "eq-1", name: "SW Cœur 01" } },
        { collection: "vms", record: { id: "vm-1", name: "SOSVM" } },
      ] }, docs.markChanged(doc.id));
      idb = new InterventionsDb(dir, Sqlite);   // Logger "error" par défaut → silencieux

      /** SURFACE du pont : EXACTEMENT les quatre méthodes de `InterventionTrackerSource` — les mêmes
          relais que la façade `InterventionsModule` expose au bootstrap (typage structurel). */
      const source = {
        listTracked: (d) => idb.listTracked(d),
        listPushDue: (d) => idb.listPushDue(d),
        getOne: (d, id) => idb.getOne(d, id),
        applyTrackerState: (d, id, patch) => idb.applyTrackerState(d, id, patch),
      };

      /** Journal CAPTURÉ (le service en écrit beaucoup ; on veut le lire, pas l'afficher). */
      const mkLog = () => {
        const lines = [];
        const rec = (level) => (...args) => { lines.push(level + " " + args.map((a) => String(a)).join(" ")); };
        return { lines, error: rec("E"), warn: rec("W"), info: rec("I"), debug: rec("D"), trace: rec("T") };
      };

      /** Config de provider (options de la marque comprises). */
      const cfg = (over) => Object.assign({
        id: "tr-1", kind: "jira", url: BASE, token: "T", account: "a@x.net", interval_sec: 0, timeout_sec: 20,
        options: { project_key: "INFRA", type_incident: "Incident", type_intervention: "Infrastructure", auto_replicate: true },
      }, over || {});

      const mkProviders = (list) => ({
        providersFor: (d) => (d === doc.id ? list : []),
        summariesFor: (d) => (d === doc.id ? list.map((c) => ({ id: c.id, kind: c.kind, interval_sec: c.interval_sec })) : []),
        configuredDocIds: () => [doc.id],
      });

      /** TRACKER SIMULÉ : un adaptateur en mémoire qui respecte le contrat (états, verbes de labels,
          refus injectables). Il tient lieu de projet Jira PARTAGÉ — on peut donc y poser des
          étiquettes ÉTRANGÈRES et vérifier qu'aucune poussée n'y touche. */
      const mkTracker = () => {
        const t = {
          tickets: new Map(),   // ext_id → état
          created: [], updates: [],
          failCreate: null, failUpdate: null, failResolve: null, failLookup: null,
          degradeOnCreate: null,
          next: 1,
          adapter: (config) => ({
            kind: config.kind, config,
            test: async () => ({ ok: true, kind: config.kind, version: null, supported: true, message: "" }),
            resolve: async (ids) => {
              if (t.failResolve) throw t.failResolve;
              const found = [], missing = [];
              for (const id of ids) { const s = t.tickets.get(id); if (s) found.push({ ...s, labels: s.labels.slice() }); else missing.push(id); }
              return { found, missing };
            },
            lookup: async (reference) => {
              if (t.failLookup) throw t.failLookup;
              const ref = String(reference);
              const direct = t.tickets.get(ref);
              if (direct) return { ...direct, labels: direct.labels.slice() };
              for (const s of t.tickets.values()) if (s.key === ref) return { ...s, labels: s.labels.slice() };
              return null;
            },
            createIssue: async (content, onDegraded) => {
              t.created.push(JSON.parse(JSON.stringify(content)));
              if (t.failCreate) throw t.failCreate;
              if (t.degradeOnCreate && onDegraded) onDegraded(t.degradeOnCreate);
              const key = "INFRA-" + t.next;
              const state = {
                ext_id: "10" + String(t.next).padStart(3, "0"), key,
                status: "À faire", status_category: "todo", assignee: null,
                url: BASE + "/browse/" + key, labels: (content.labels || []).slice(),
              };
              t.next++;
              t.tickets.set(state.ext_id, state);
              return { ...state, labels: state.labels.slice() };
            },
            updateIssue: async (extId, content, add, remove) => {
              if (t.failUpdate) throw t.failUpdate;
              t.updates.push({ extId, content: JSON.parse(JSON.stringify(content)), add: add.slice(), remove: remove.slice() });
              const state = t.tickets.get(extId);
              if (!state) return;
              const labels = state.labels.filter((l) => !remove.includes(l));
              for (const l of add) if (!labels.includes(l)) labels.push(l);
              state.labels = labels;
            },
          }),
        };
        return t;
      };

      const mkService = (o) => new TrackerSyncService(
        docs, o.source || source, o.providers, o.log, o.makeAdapter, 0, o.problems, o.live,
        o.maxTickets === undefined ? 500 : o.maxTickets, o.maxPushes === undefined ? 50 : o.maxPushes,
      );

      /** Laisse se dérouler les poussées ASYNCHRONES déclenchées par le hook (le PUT, lui, a déjà
          répondu — c'est tout l'intérêt : l'utilisateur n'attend jamais le tracker). */
      const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

      const declare = (id, over) => idb.save(doc.id, id, Object.assign({
        kind: "intervention", title: "Remplacement switch", description: "Plan\n\nEn deux temps",
        status: "planned", priority: "high",
        planned_start: "2026-08-12T08:00:00.000Z", planned_end: "2026-08-12T14:00:00.000Z",
        links: [{ target_kind: "equipment", target_id: "eq-1" }],
      }, over || {}), "u-alice");

      /* ================================================================================
         1) POUSSÉE TOLÉRANTE — le tracker est éteint, l'intervention s'enregistre QUAND MÊME
         ================================================================================ */
      declare("i1");
      const tracker = mkTracker();
      tracker.failCreate = new Error("Tracker : délai dépassé (20000 ms) sur https://tracker.example.net");
      const log = mkLog();
      const live = { events: [], publish(docId, data) { this.events.push({ docId, data }); } };
      const service = mkService({ providers: mkProviders([cfg()]), log, makeAdapter: tracker.adapter, live });

      service.onInterventionWrite(doc.id, "i1", "put");
      await settle();
      const failed = idb.getOne(doc.id, "i1");
      ck(failed !== null && failed.title === "Remplacement switch", "poussée tolérante : l'intervention est ENREGISTRÉE, tracker éteint (l'enregistrement n'est JAMAIS conditionné à la réplication)");
      ck.eq(failed.tracker_push_state, "error", "poussée tolérante : l'état d'échec est PERSISTÉ (un redémarrage ne perdra pas la poussée due)");
      ck(/délai dépassé/.test(failed.tracker_push_error), "poussée tolérante : le message du tracker est conservé INTACT (c'est lui qui est actionnable)");
      ck.eq(failed.tracker_ext_id, null, "poussée tolérante : aucune identité distante inventée");
      ck.eq(failed.tracker_provider_id, "tr-1", "poussée tolérante : le provider DÉSIGNÉ est mémorisé (la reprise saura chez qui pousser)");

      /* ================================================================================
         2) LA PASSE SUIVANTE RAMASSE ET RÉUSSIT — `error` est un état STABLE, pas une rafale
         ================================================================================ */
      tracker.failCreate = null;
      const pass1 = await service.syncDocument(doc.id);
      ck(pass1.length === 1 && pass1[0].ok === true, "reprise : la passe réussit (1 provider)");
      ck(pass1[0].counts.push_due === 1 && pass1[0].counts.pushed === 1, "reprise : la poussée DUE est ramassée et aboutit");
      const synced = idb.getOne(doc.id, "i1");
      ck.eq(synced.tracker_push_state, "synced", "reprise : l'état passe à `synced`");
      ck.eq(synced.tracker_push_error, null, "reprise : … et le message d'échec est EFFACÉ (il ne doit pas survivre à un succès)");
      ck.eq(synced.tracker_ext_id, "10001", "création : l'identité distante est l'identifiant INTERNE");
      ck.eq(synced.jira_ref, "INFRA-1", "création : 🚨 la CLÉ atterrit dans `jira_ref` — là où l'utilisateur la cherche déjà (le lien JIRA_BASE_URL marche sans une ligne de plus)");
      ck.eq(synced.tracker_url, BASE + "/browse/INFRA-1", "création : le lien d'INTERFACE est persisté");
      ck.eq(synced.tracker_status_category, "todo", "création : … et le statut relu dans la foulée");

      /* -- Le CONTENU poussé : le mapping du cadrage, champ par champ. -- */
      const sent = tracker.created[tracker.created.length - 1];
      ck.eq(sent.summary, "Remplacement switch", "mapping : title → summary");
      ck.eq(sent.kind, "intervention", "mapping : la NATURE part telle quelle (l'adaptateur la traduit en type de SA marque)");
      ck.eq(sent.priority, "high", "mapping : la priorité DC Manager part en slug (la table de correspondance vit chez la marque)");
      ck.eq(sent.duedate, "2026-08-12", "mapping : planned_end → échéance, partie DATE seulement");
      ck.eq(JSON.stringify(sent.labels), JSON.stringify(["DCM-EQ-SW-COEUR-01"]),
        "mapping : le lien vers l'équipement devient une étiquette LISIBLE (accents repliés, espaces en tirets, CAPITALES)");
      ck(!("status" in sent), "mapping : 🚨 le `status` DC Manager n'est JAMAIS poussé (les deux workflows sont indépendants — décision E3)");

      /* -- L'événement LIVE : les autres clients rafraîchissent leurs pastilles. -- */
      ck(live.events.length >= 1, "live : un événement est publié après une passe qui a écrit");
      ck.eq(live.events[0].data.changeset.modules.join(","), "interventions",
        "live : marqueur `modules:[interventions]` (base séparée du document → le ReloadPlanner du client ne recharge aucune collection)");

      /* ================================================================================
         3) REDÉMARRAGE SIMULÉ — l'état de poussée vit en BASE, pas en mémoire
         ================================================================================ */
      declare("i2", { title: "Ajout d'un lien fibre" });
      tracker.failCreate = new Error("Tracker : connexion refusée par l'hôte");
      service.onInterventionWrite(doc.id, "i2", "put");
      await settle();
      ck.eq(idb.getOne(doc.id, "i2").tracker_push_state, "error", "redémarrage : une poussée en échec est persistée avant l'arrêt…");

      tracker.failCreate = null;
      // NOUVEAU service sur la MÊME base : aucune mémoire du service précédent (statuts, curseurs).
      const rebooted = mkService({ providers: mkProviders([cfg()]), log: mkLog(), makeAdapter: tracker.adapter });
      const afterBoot = await rebooted.syncDocument(doc.id);
      ck.eq(afterBoot[0].counts.pushed, 1, "redémarrage : … et un service TOUT NEUF la ramasse (rien ne dépend de la mémoire du processus)");
      ck.eq(idb.getOne(doc.id, "i2").tracker_push_state, "synced", "redémarrage : la poussée aboutit après reprise");

      /* ================================================================================
         4) ÉCHEC D'ÉCRITURE LOCALE **APRÈS** CRÉATION DISTANTE — la clé n'est JAMAIS perdue,
            et la passe suivante ne crée SURTOUT PAS un ticket de plus
         ================================================================================
         C'est le seul instant où un ticket existe chez un tiers sans être connu ici : la ligne
         reste `error` avec un `tracker_ext_id` VIDE — or c'est précisément sur ce vide que la
         poussée décide de CRÉER. Sans mémoire de l'identité créée, chaque passe fabriquerait un
         ticket DE PLUS dans un projet PARTAGÉ (12 par heure à `interval_sec = 300`), tous
         irrattrapables : la doctrine interdit toute suppression distante. */
      declare("i3", { title: "Bascule onduleur" });
      let breakIdentity = true;
      const brittle = {
        listTracked: source.listTracked, listPushDue: source.listPushDue, getOne: source.getOne,
        applyTrackerState: (d, id, patch) => {
          // On casse EXACTEMENT l'écriture de l'identité (celle qui suit immédiatement la création
          // distante) : c'est le seul instant où un ticket existe chez le tracker sans être connu ici.
          if (breakIdentity && patch.tracker_ext_id) { breakIdentity = false; throw new Error("SQLITE_BUSY: database is locked"); }
          return source.applyTrackerState(d, id, patch);
        },
      };
      const brittleLog = mkLog();
      const brittleService = mkService({ source: brittle, providers: mkProviders([cfg()]), log: brittleLog, makeAdapter: tracker.adapter });
      const createdBeforePartial = tracker.created.length;
      const partial = await brittleService.replicate(doc.id, "i3", {});
      ck.eq(partial.ok, false, "échec partiel : l'action manuelle rend un ÉCHEC (l'utilisateur doit savoir)");
      ck.eq(partial.key, "INFRA-3", "échec partiel : 🚨 la réponse PORTE la clé du ticket réellement créé — sans elle, la situation serait irrattrapable");
      ck.eq(tracker.created.length, createdBeforePartial + 1, "échec partiel : UN ticket a bel et bien été créé chez le tracker (c'est ce qui rend la situation délicate)");
      const orphanKey = idb.getOne(doc.id, "i3");
      ck.eq(orphanKey.tracker_push_state, "error", "échec partiel : l'état error est posé…");
      ck(/INFRA-3/.test(orphanKey.tracker_push_error), "échec partiel : … et le message PERSISTÉ porte la clé (au minimum, elle survit là)");
      ck(/LIAISON/.test(orphanKey.tracker_push_error), "échec partiel : … avec la marche à suivre (LIER le ticket existant, jamais de suppression compensatoire chez le tracker)");
      ck(brittleLog.lines.some((l) => l.startsWith("E") && /ÉCHEC PARTIEL/.test(l)), "échec partiel : journalisé en ERREUR (c'est un écart durable, pas un incident passager)");

      /* -- LA PASSE SUIVANTE REJOUE L'IDENTITÉ, PAS LA CRÉATION. C'est le cœur du correctif : la
            ligne est toujours `error` et toujours sans identité, donc TOUJOURS ramassée par
            `listPushDue` — mais l'identité mémorisée court-circuite la décision « ext_id vide ⇒
            créer ». -- */
      const afterPartial = await brittleService.syncDocument(doc.id);
      ck.eq(tracker.created.length, createdBeforePartial + 1,
        "échec partiel : 🚨 la passe suivante ne crée AUCUN ticket de plus (l'identité est REJOUÉE, la création ne l'est pas)");
      const rescued = idb.getOne(doc.id, "i3");
      ck.eq(rescued.tracker_ext_id, "10003", "échec partiel : … l'identité mémorisée est ENFIN écrite (identifiant INTERNE)");
      ck.eq(rescued.jira_ref, "INFRA-3", "échec partiel : … avec la clé, là où l'utilisateur la cherche");
      ck.eq(rescued.tracker_push_state, "synced", "échec partiel : … et la poussée enchaîne en MISE À JOUR jusqu'à `synced`");
      ck.eq(rescued.tracker_push_error, null, "échec partiel : … le message d'échec ne survit pas au rattrapage");
      ck(afterPartial[0].counts.pushed >= 1, "échec partiel : la passe COMPTE la poussée rattrapée");

      /* -- RÉSIDUEL ASSUMÉ ET DOCUMENTÉ : cette mémoire est EN MÉMOIRE. Un REDÉMARRAGE la perd, et
            une ligne restée `error` sans identité refait alors UNE création — une seule, jamais la
            boucle infinie. Le ticket abandonné reste rattrapable À LA MAIN par sa clé (message
            persisté + journal) : c'est exactement ce que rejoue le scénario de LIAISON plus bas. -- */
      declare("i11", { title: "Échec partiel juste avant l'arrêt" });
      let breakAgain = true;
      const brittleTwice = {
        listTracked: source.listTracked, listPushDue: source.listPushDue, getOne: source.getOne,
        applyTrackerState: (d, id, patch) => {
          if (breakAgain && patch.tracker_ext_id) { breakAgain = false; throw new Error("SQLITE_BUSY: database is locked"); }
          return source.applyTrackerState(d, id, patch);
        },
      };
      const abandoned = await mkService({ source: brittleTwice, providers: mkProviders([cfg()]), log: mkLog(), makeAdapter: tracker.adapter })
        .replicate(doc.id, "i11", {});
      ck.eq(abandoned.ok, false, "résiduel : l'échec partiel est reproduit (ticket créé, identité non écrite)…");
      const abandonedKey = abandoned.key, abandonedExtId = abandoned.ext_id;

      // REDÉMARRAGE : service TOUT NEUF sur la MÊME base — la mémoire des identités créées est vide.
      const afterReboot = mkService({ providers: mkProviders([cfg()]), log: mkLog(), makeAdapter: tracker.adapter });
      const createdBeforeReboot = tracker.created.length;
      await afterReboot.syncDocument(doc.id);
      ck.eq(tracker.created.length, createdBeforeReboot + 1,
        "résiduel : … après un redémarrage, la ligne sans identité refait UNE création (limite ASSUMÉE, cf. docs/jira-interventions.md)");
      ck.eq(idb.getOne(doc.id, "i11").tracker_push_state, "synced", "résiduel : … qui aboutit, elle");
      await afterReboot.syncDocument(doc.id);
      ck.eq(tracker.created.length, createdBeforeReboot + 1,
        "résiduel : … et UNE SEULE — c'est la boucle sans fin qui est interdite, pas la re-création ponctuelle");
      ck(tracker.tickets.has(abandonedExtId),
        "résiduel : le ticket abandonné vit sa vie chez le tracker (aucune suppression distante) — il reste rattrapable par sa clé");

      /* ================================================================================
         5) MISE À JOUR — diff des étiquettes EN VERBES, labels étrangers INTOUCHÉS
         ================================================================================ */
      // Une AUTRE source pose ses étiquettes sur le ticket de i1 — c'est le cas nominal d'un projet
      // partagé, et c'est ce que la poussée ne doit JAMAIS toucher.
      const shared = tracker.tickets.get("10001");
      shared.labels = ["equipe-reseau", "SLA-2h", "DCM-EQ-SW-COEUR-01"];

      // Côté DC Manager : on remplace le lien équipement par un lien VM.
      idb.save(doc.id, "i1", {
        kind: "intervention", title: "Remplacement switch (v2)", description: "Nouveau plan",
        status: "in_progress", priority: "critical", links: [{ target_kind: "vm", target_id: "vm-1" }],
      }, "u-bob");
      const beforeUpdates = tracker.updates.length;
      service.onInterventionWrite(doc.id, "i1", "put");
      await settle();
      ck.eq(tracker.updates.length, beforeUpdates + 1, "mise à jour : une écriture d'intervention déjà répliquée déclenche une POUSSÉE de mise à jour");
      const upd = tracker.updates[tracker.updates.length - 1];
      ck.eq(upd.content.summary, "Remplacement switch (v2)", "mise à jour : le contenu DC Manager fait foi");
      ck.eq(upd.content.priority, "critical", "mise à jour : la priorité suit");
      ck.eq(upd.content.duedate, null, "mise à jour : une échéance RETIRÉE est poussée à null (elle doit disparaître du ticket)");
      ck.eq(upd.add.join(","), "DCM-VM-SOSVM", "mise à jour : la nouvelle cible produit un AJOUT d'étiquette");
      ck.eq(upd.remove.join(","), "DCM-EQ-SW-COEUR-01", "mise à jour : l'ancienne cible produit un RETRAIT");
      const touched = [...upd.add, ...upd.remove];
      ck(!touched.includes("equipe-reseau") && !touched.includes("SLA-2h"),
        "mise à jour : 🚨 AUCUNE étiquette étrangère dans les verbes — le projet est PARTAGÉ");
      ck(shared.labels.includes("equipe-reseau") && shared.labels.includes("SLA-2h"),
        "mise à jour : … et elles SURVIVENT réellement sur le ticket");
      ck.eq(idb.getOne(doc.id, "i1").tracker_push_state, "synced", "mise à jour : état `synced`");

      // CIBLE ORPHELINE : un lien vers un objet supprimé du document ne produit AUCUNE étiquette
      // (ni son identifiant brut, illisible, ni une étiquette « introuvable » qui polluerait le projet).
      idb.save(doc.id, "i1", {
        kind: "intervention", title: "Remplacement switch (v3)", description: "x", status: "in_progress", priority: "critical",
        links: [{ target_kind: "vm", target_id: "vm-1" }, { target_kind: "equipment", target_id: "eq-DISPARU" }],
      }, "u-bob");
      service.onInterventionWrite(doc.id, "i1", "put");
      await settle();
      const orphanPush = tracker.updates[tracker.updates.length - 1];
      ck.eq(JSON.stringify(orphanPush.content.labels), JSON.stringify(["DCM-VM-SOSVM"]),
        "cible orpheline : le lien vers un objet disparu ne produit AUCUNE étiquette (les orphelins sont tolérés, pas devinés)");

      /* ================================================================================
         6) RETOUR D'ÉTAT — idempotent, « introuvable » sans suppression, audit INTACT
         ================================================================================ */
      const auditBefore = idb.getOne(doc.id, "i1");
      shared.status = "En recette"; shared.status_category = "in_progress"; shared.assignee = "A. Dupont";
      const pull1 = await service.syncDocument(doc.id);
      const pulled = idb.getOne(doc.id, "i1");
      ck.eq(pulled.tracker_status, "En recette", "retour d'état : le statut BRUT du tracker est repris tel quel (jamais traduit)");
      ck.eq(pulled.tracker_status_category, "in_progress", "retour d'état : … avec sa catégorie fermée");
      ck.eq(pulled.tracker_assignee, "A. Dupont", "retour d'état : l'assigné est affiché (DC Manager n'a pas d'assignation à lui)");
      ck(pulled.tracker_last_sync !== null, "retour d'état : l'horodatage de dernière synchro est posé");
      ck(pull1[0].counts.updated >= 1, "retour d'état : la passe COMPTE ce qu'elle a écrit");

      // 🚨 L'AUDIT N'EST PAS TOUCHÉ — le retour d'état n'est pas une édition de l'utilisateur.
      ck.eq(pulled.updated_by, auditBefore.updated_by, "retour d'état : 🚨 `updated_by` INCHANGÉ (le serveur ne devient pas le dernier éditeur de chaque intervention répliquée)");
      ck.eq(pulled.updated_date, auditBefore.updated_date, "retour d'état : 🚨 `updated_date` INCHANGÉ (sinon un listing trié par activité remonterait des objets que personne n'a touchés)");
      ck.eq(pulled.status, auditBefore.status, "retour d'état : le statut DC MANAGER n'est pas davantage touché (aucun ping-pong)");

      // IDEMPOTENCE : rien n'a bougé côté tracker ⇒ AUCUNE écriture.
      let writes = 0;
      const counting = {
        listTracked: source.listTracked, listPushDue: source.listPushDue, getOne: source.getOne,
        applyTrackerState: (d, id, patch) => { writes++; return source.applyTrackerState(d, id, patch); },
      };
      const idempotent = mkService({ source: counting, providers: mkProviders([cfg()]), log: mkLog(), makeAdapter: tracker.adapter });
      const pull2 = await idempotent.syncDocument(doc.id);
      ck.eq(writes, 0, "retour d'état : 🚨 état inchangé ⇒ ZÉRO écriture (l'idempotence est ce qui rend une passe périodique gratuite)");
      ck(pull2[0].counts.updated === 0 && pull2[0].counts.unchanged >= 1, "retour d'état : … et les compteurs le disent");

      // TICKET INTROUVABLE : supprimé/déplacé/permission perdue ⇒ constat, JAMAIS de suppression locale.
      tracker.tickets.delete("10001");
      const pull3 = await service.syncDocument(doc.id);
      const missing = idb.getOne(doc.id, "i1");
      ck(missing !== null, "introuvable : 🚨 l'intervention locale N'EST PAS supprimée (elle porte des liens, une description et un cycle de vie que le tracker ignore)");
      ck.eq(missing.tracker_status, "introuvable", "introuvable : le statut affiché le DIT");
      ck.eq(missing.tracker_status_category, "unknown", "introuvable : la catégorie retombe sur `unknown` (pastille neutre)");
      ck.eq(missing.tracker_ext_id, "10001", "introuvable : l'identité distante est CONSERVÉE (le ticket peut revenir — permission rendue, projet désarchivé)");
      ck(pull3[0].counts.missing >= 1, "introuvable : la passe le compte");

      // … et le CONSTAT est idempotent lui aussi (pas de ré-écriture à chaque passe).
      writes = 0;
      await idempotent.syncDocument(doc.id);
      ck.eq(writes, 0, "introuvable : le constat n'est écrit qu'UNE fois (une passe qui réécrit la même chose est une passe qui ment sur son activité)");

      /* ================================================================================
         7) PLAFOND ROULANT réutilisé sur les colonnes `tracker_*`
         ================================================================================ */
      const capped = mkService({ providers: mkProviders([cfg()]), log: mkLog(), makeAdapter: tracker.adapter, maxTickets: 1 });
      const capPass = await capped.syncDocument(doc.id);
      ck.eq(capPass[0].counts.queried, 1, "plafond : une seule identité interrogée par passe…");
      ck(capPass[0].counts.skipped >= 1, "plafond : … le reste est REPORTÉ et COMPTÉ (un plafond silencieux se lirait « tout est à jour »)");
      ck(/PLAFOND DE PASSE/.test(capPass[0].message), "plafond : … et DIT dans le statut (jamais tu)");

      /* ================================================================================
         8) RÉPLICATION AUTOMATIQUE — un provider : oui ; plusieurs : NON, et journalisé
         ================================================================================ */
      declare("i4", { title: "Changement de ventilateur" });
      const autoLog = mkLog();
      const autoService = mkService({ providers: mkProviders([cfg()]), log: autoLog, makeAdapter: tracker.adapter });
      autoService.onInterventionWrite(doc.id, "i4", "put");
      await settle();
      ck(idb.getOne(doc.id, "i4").tracker_ext_id !== null, "auto_replicate : UN provider en automatique ⇒ le ticket est créé à l'enregistrement");

      declare("i5", { title: "Nettoyage des filtres" });
      const ambiguousLog = mkLog();
      const ambiguous = mkService({
        providers: mkProviders([cfg(), cfg({ id: "tr-2" })]), log: ambiguousLog, makeAdapter: tracker.adapter,
      });
      ambiguous.onInterventionWrite(doc.id, "i5", "put");
      await settle();
      const undecided = idb.getOne(doc.id, "i5");
      ck.eq(undecided.tracker_ext_id, null, "auto_replicate : PLUSIEURS providers en automatique ⇒ AUCUNE réplication (une intervention = UN ticket, et rien ne permet de choisir à la place de l'utilisateur)");
      ck.eq(undecided.tracker_push_state, null, "auto_replicate : … et aucune poussée n'est même marquée due");
      ck(ambiguousLog.lines.some((l) => /AMBIGU/.test(l) && /tr-1/.test(l) && /tr-2/.test(l)),
        "auto_replicate : 🚨 l'ambiguïté est JOURNALISÉE en nommant les providers (un silence se lirait « la réplication ne marche pas »)");

      // AUCUN provider en automatique ⇒ rien non plus (la réplication reste un geste explicite).
      declare("i6", { title: "Audit de câblage" });
      const manualOnly = mkService({ providers: mkProviders([cfg({ options: { ...cfg().options, auto_replicate: false } })]), log: mkLog(), makeAdapter: tracker.adapter });
      manualOnly.onInterventionWrite(doc.id, "i6", "put");
      await settle();
      ck.eq(idb.getOne(doc.id, "i6").tracker_push_state, null, "auto_replicate désactivé : aucune poussée marquée due");

      // RÉFÉRENCE DÉJÀ SAISIE : on ne crée PAS de doublon automatiquement — c'est le rôle de « Lier ».
      // Cas RÉEL de rattrapage : le ticket ABANDONNÉ plus haut (échec partiel + redémarrage) existe
      // chez le tracker sans appartenir à personne. L'utilisateur saisit sa clé, puis demande la
      // LIAISON — c'est la voie de sortie que le message d'erreur persisté lui a indiquée.
      declare("i7", { title: "Reprise du ticket orphelin", jira_ref: abandonedKey });
      const linkLog = mkLog();
      const linkService = mkService({ providers: mkProviders([cfg()]), log: linkLog, makeAdapter: tracker.adapter });
      linkService.onInterventionWrite(doc.id, "i7", "put");
      await settle();
      ck.eq(idb.getOne(doc.id, "i7").tracker_ext_id, null,
        "référence déjà saisie : aucune création automatique (ce serait un DOUBLON de ce que l'utilisateur désignait)");

      // … et l'action manuelle de LIAISON l'adopte, en connaissance de cause.
      const linked = await linkService.replicate(doc.id, "i7", { link: true });
      ck.eq(linked.ok, true, "liaison : le ticket EXISTANT est adopté");
      ck.eq(idb.getOne(doc.id, "i7").tracker_ext_id, abandonedExtId, "liaison : 🚨 c'est l'identifiant INTERNE qui est persisté, jamais la référence saisie");
      ck.eq(idb.getOne(doc.id, "i7").tracker_push_state, "synced", "liaison : le contenu DC Manager est aligné dans la foulée (il fait foi — risque n°6 assumé)");

      // 🚨 ADOPTION DOUBLE — REFUSÉE. Deux interventions sur le MÊME ticket, c'est une assiette de
      // retour d'état indexée PAR identité distante où la seconde ligne écrase la première : l'une
      // des deux cesse d'être rafraîchie SANS erreur, SANS journal, SANS rien à voir dans l'UI.
      // Le contrôle appartient au SERVEUR, qui porte l'invariant — pas à la confirmation de l'UI.
      declare("i12", { title: "Le même ticket, une seconde fois", jira_ref: abandonedKey });
      const doubleLink = await linkService.replicate(doc.id, "i12", { link: true });
      ck.eq(doubleLink.ok, false, "adoption double : la seconde liaison est REFUSÉE");
      ck.eq(doubleLink.failure, "conflict", "adoption double : … en `conflict` (409 côté route — ni 400, ni 422 : la demande est bien formée, c'est l'état qui s'y oppose)");
      ck(/i7/.test(doubleLink.message) && /Reprise du ticket orphelin/.test(doubleLink.message),
        "adoption double : … et le message NOMME l'intervention qui porte déjà le ticket (id + titre) — un « déjà lié » qui ne dit pas À QUOI n'est pas actionnable");
      ck.eq(idb.getOne(doc.id, "i12").tracker_ext_id, null, "adoption double : 🚨 RIEN n'est écrit — le refus précède toute écriture");
      ck.eq(idb.getOne(doc.id, "i7").tracker_ext_id, abandonedExtId, "adoption double : … et l'intervention légitime garde son ticket");

      /* ================================================================================
         9) ACTIONS MANUELLES — refus TYPÉS (le code HTTP se dérive de la nature, pas du message)
         ================================================================================ */
      ck.eq((await service.replicate(doc.id, "inconnue", {})).failure, "not_found", "action : intervention inconnue → `not_found` (404 côté route)");
      ck.eq((await service.replicate(doc.id, "i1", {})).failure, "conflict", "action : déjà répliquée → `conflict` (409)");
      ck.eq((await service.replicate(doc.id, "i6", { providerId: "fantome" })).failure, "invalid", "action : provider inconnu → `invalid` (400)");
      const ambiguousPick = await ambiguous.replicate(doc.id, "i6", {});
      ck(ambiguousPick.failure === "invalid" && /plusieurs providers/.test(ambiguousPick.message),
        "action : plusieurs providers et aucun désigné → refus ACTIONNABLE (on ne devine pas chez qui créer un objet irréversible)");
      ck.eq((await service.pushNow(doc.id, "i6")).failure, "invalid", "action : « Mettre à jour » sur une intervention NON répliquée → refus explicite");

      /* ================================================================================
         10) SUPPRESSION LOCALE — le ticket distant survit (doctrine « jamais de suppression »)
         ================================================================================ */
      const beforeDelete = tracker.tickets.size;
      const createdCount = tracker.created.length;
      const updateCount = tracker.updates.length;
      service.onInterventionWrite(doc.id, "i4", "delete");
      await settle();
      ck.eq(tracker.tickets.size, beforeDelete, "suppression : 🚨 AUCUNE suppression distante (un ticket en trop se ferme ; un ticket supprimé ne revient pas)");
      ck(tracker.created.length === createdCount && tracker.updates.length === updateCount, "suppression : aucun appel d'écriture n'est même tenté");

      /* ================================================================================
         11) PRIORITÉ REFUSÉE PAR LE PROJET — dégradé remonté au STATUT, pas un échec
         ================================================================================ */
      declare("i8", { title: "Projet sans priorité" });
      tracker.degradeOnCreate = "priorité non appliquée — le projet a refusé le champ « priority »";
      const degradedLog = mkLog();
      const degradedService = mkService({ providers: mkProviders([cfg()]), log: degradedLog, makeAdapter: tracker.adapter });
      degradedService.onInterventionWrite(doc.id, "i8", "put");
      await settle();
      ck.eq(idb.getOne(doc.id, "i8").tracker_push_state, "synced", "dégradé : la poussée ABOUTIT (un champ refusé n'est pas un échec)");
      ck(degradedLog.lines.some((l) => /DÉGRADÉE/.test(l)), "dégradé : … et il est JOURNALISÉ");
      // Poussée laissée DUE en base (exactement l'état qu'un hook interrompu par un arrêt du serveur
      // laisserait derrière lui) : c'est la PASSE qui la ramasse, donc son statut qui doit le dire.
      declare("i9", { title: "Deuxième sans priorité" });
      idb.applyTrackerState(doc.id, "i9", { tracker_provider_id: "tr-1", tracker_push_state: "pending" });
      const degradedPass = await degradedService.syncDocument(doc.id);
      tracker.degradeOnCreate = null;
      ck(/DÉGRADÉE/.test(degradedPass[0].message), "dégradé : … et remonté au STATUT du provider (le taire ferait croire à une réplication complète)");

      /* ================================================================================
         12) SIGNALEMENT au module notifications (dépendance INVERSÉE, pont d'index.ts)
         ================================================================================ */
      const raised = [], resolved = [];
      const problems = { raise: (k, e) => raised.push({ k, e }), resolve: (k) => resolved.push(k) };
      const reporting = mkService({ providers: mkProviders([cfg()]), log: mkLog(), makeAdapter: tracker.adapter, problems });
      tracker.failResolve = new Error("Tracker : HTTP 500 sur /rest/api/3/search/jql");
      const koPass = await reporting.syncDocument(doc.id);
      ck.eq(koPass[0].ok, false, "notify : une résolution en échec rend un statut EN ERREUR");
      ck(raised.length === 1 && raised[0].k === "tracker-sync:" + doc.id + ":tr-1", "notify : `raise` sur une clé STABLE par couple document×provider (le moteur déduplique dessus)");
      ck(/500/.test(raised[0].e.body), "notify : le corps de l'alerte porte le message du tracker (jamais le jeton — garanti par le client HTTP et la config chiffrée)");
      tracker.failResolve = null;
      await reporting.syncDocument(doc.id);
      ck(resolved.includes("tracker-sync:" + doc.id + ":tr-1"), "notify : retour à la normale → `resolve` (l'anti-spam vit ENTIÈREMENT côté notify)");

      /* ================================================================================
         13) STATUT — fusion config × runtime, purge des fantômes
         ================================================================================ */
      const statuses = service.statusFor(doc.id);
      ck(statuses.length === 1 && statuses[0].provider_id === "tr-1", "statut : un provider configuré → une entrée");
      ck(statuses[0].counts !== null, "statut : … avec les compteurs de la dernière passe");
      const empty = mkService({ providers: mkProviders([]), log: mkLog(), makeAdapter: tracker.adapter });
      ck.eq(empty.statusFor(doc.id).length, 0, "statut : provider retiré de la config → plus aucune entrée (purge des états fantômes)");

      /* ================================================================================
         14) COURSE « deux poussées EN VOL sur la MÊME intervention » — jamais DEUX tickets
         ================================================================================
         La poussée est lancée SANS être attendue (le PUT a déjà répondu) : pendant tout l'appel
         distant, un second enregistrement — ou un « Synchroniser », ou une passe périodique — entre
         dans un serveur qui n'a rien à faire d'autre. Les deux poussées reliraient alors un
         `tracker_ext_id` VIDE et créeraient chacune un ticket. Un doublon chez un tiers ne se
         rattrape pas (aucune suppression distante, par doctrine) : c'est le scénario à interdire.
         On reproduit la fenêtre EXACTEMENT en suspendant la création distante. */
      declare("i10", { title: "Enregistrement initial" });
      const releases = [];   // tous les résolveurs : sans ça, une 2e création restée en vol passerait inaperçue
      const slow = mkTracker();
      const slowAdapter = (config) => {
        const inner = slow.adapter(config);
        return Object.assign({}, inner, {
          createIssue: async (content, onDegraded) => {
            await new Promise((r) => { releases.push(r); });   // création SUSPENDUE : la fenêtre reste ouverte
            return inner.createIssue(content, onDegraded);
          },
        });
      };
      const raceService = mkService({ providers: mkProviders([cfg()]), log: mkLog(), makeAdapter: slowAdapter });
      raceService.onInterventionWrite(doc.id, "i10", "put");   // ① poussée partie, suspendue chez le tracker
      await settle();
      declare("i10", { title: "Coquille corrigée" });          // ② l'utilisateur ré-enregistre PENDANT l'appel
      raceService.onInterventionWrite(doc.id, "i10", "put");
      await settle();
      for (const release of releases) release();               // le tracker répond enfin
      await settle();
      ck.eq(slow.created.length, 1,
        "course : 🚨 deux enregistrements rapprochés ne créent QU'UN ticket (une seconde création serait un DOUBLON irréversible chez un tiers)");
      ck.eq(slow.updates.length, 1,
        "course : … et la seconde demande n'est PAS perdue — elle est REJOUÉE en mise à jour dès que la création est finie");
      ck.eq(slow.updates[0].content.summary, "Coquille corrigée",
        "course : … avec l'intervention RELUE (« dernier état gagne » : c'est la DERNIÈRE version qui atterrit chez le tracker)");
      ck.eq(idb.getOne(doc.id, "i10").tracker_push_state, "synced", "course : l'intervention finit RÉPLIQUÉE et à jour");

      /* ================================================================================
         15) RAMASSAGE AU DÉMARRAGE — ce qu'un arrêt du serveur a laissé en plan repart SEUL
         ================================================================================
         `pending`/`error` sont PERSISTÉS, mais la persistance ne sert à rien si personne ne relit :
         un provider en mode MANUEL (`interval_sec = 0` — le défaut, et le réglage que la doc
         recommande le temps de valider une instance) n'arme AUCUN timer, et personne ne cliquera
         « Synchroniser » à 4 h du matin. Sans ramassage, la poussée dort jusqu'à la prochaine
         édition de l'objet, c'est-à-dire peut-être jamais. */
      declare("i13", { title: "Laissée en plan par un arrêt du serveur" });
      // Exactement l'état qu'un `docker stop` entre le marquage et l'appel distant laisse derrière lui.
      idb.applyTrackerState(doc.id, "i13", { tracker_provider_id: "tr-1", tracker_push_state: "pending" });
      ck.eq(idb.listPushDue().length, 1,
        "ramassage : le balayage GLOBAL (`listPushDue()` SANS document) est le seul chemin qui voie cette poussée — la mémoire du processus précédent est perdue par définition");
      const sweepLog = mkLog();
      const sweeper = mkService({ providers: mkProviders([cfg({ interval_sec: 0 })]), log: sweepLog, makeAdapter: tracker.adapter });
      const createdBeforeSweep = tracker.created.length;
      await sweeper.sweepPushDue();   // ce que `TrackerModule.start()` lance SANS l'attendre
      ck.eq(idb.getOne(doc.id, "i13").tracker_push_state, "synced",
        "ramassage : 🚨 la poussée part au démarrage — aucun timer, aucun clic, aucune ré-édition de l'objet");
      ck.eq(tracker.created.length, createdBeforeSweep + 1, "ramassage : … et le ticket manquant est bien créé");
      ck(sweepLog.lines.some((l) => /ramassage au démarrage/.test(l)),
        "ramassage : … et l'opération est JOURNALISÉE (une reprise silencieuse est indistinguable d'une panne)");

      // Rien de dû ⇒ AUCUN tiers réveillé : un démarrage ne doit pas coûter une requête par document.
      const idleCreated = tracker.created.length, idleUpdates = tracker.updates.length;
      await sweeper.sweepPushDue();
      ck(tracker.created.length === idleCreated && tracker.updates.length === idleUpdates, "ramassage : rien de dû ⇒ rien de tenté");

      // TRACKER ÉTEINT : le balayage rend la main SANS jeter — le serveur doit démarrer quand même.
      declare("i14", { title: "Ramassée tracker éteint" });
      idb.applyTrackerState(doc.id, "i14", { tracker_provider_id: "tr-1", tracker_push_state: "pending" });
      tracker.failCreate = new Error("Tracker : connexion refusée par l'hôte");
      let sweptOffline = "jeté";
      try { await sweeper.sweepPushDue(); sweptOffline = "rendu"; } catch (_) { sweptOffline = "jeté"; }
      tracker.failCreate = null;
      ck.eq(sweptOffline, "rendu", "ramassage : tracker ÉTEINT, le balayage rend la main SANS jeter (un démarrage ne dépend pas d'un tiers)");
      ck.eq(idb.getOne(doc.id, "i14").tracker_push_state, "error",
        "ramassage : … en laissant l'état `error` STABLE, repris à la passe suivante comme n'importe quel échec");
    } finally {
      try { if (idb) idb.close(); } catch (_) { /* déjà fermé */ }
      try { if (docs) docs.closeAll(); } catch (_) { /* déjà fermé */ }
      try { require("fs").rmSync(dir, { recursive: true, force: true }); } catch (_) { /* handles longs sous Windows */ }
    }
  });

  /* ============ SERVEUR : invariants de contrat et d'agnosticisme ============ */

  await section("Serveur : invariants — décodeur ≡ pivot, agnosticisme de marque (aucun « jira » hors des points d'extension)", async () => {
  {
    // ⚠ Les ensembles fermés du SERVEUR sont aliasés : leurs jumeaux CLIENTS portent le même nom
    //    (c'est tout l'objet des verrous ci-dessous) et se masqueraient l'un l'autre sans cela.
    const {
      TRACKER_TICKET_STATE_FIELDS, TRACKER_TICKET_STATE_FIELDS_ARE_EXHAUSTIVE, OPTION_AUTO_REPLICATE,
      TRACKER_STATUS_CATEGORIES: SERVER_STATUS_CATEGORIES, TRACKER_PUSH_STATES: SERVER_PUSH_STATES,
    } = SERVER("tracker/TrackerProvider.js");
    const { KIND_OPTION_SPECS, SUPPORTED_KINDS } = SERVER("tracker/TrackerProviderConfigValidate.js");
    const { TrackerSyncService } = SERVER("tracker/TrackerSyncService.js");

    // -- 1) DÉCODEUR ⇄ PIVOT : la liste couvre l'interface (sonde de COMPILATION), et le décodeur
    //       produit EXACTEMENT cette liste. C'est ce qui casserait silencieusement si un champ était
    //       ajouté au pivot sans être décodé (il resterait `undefined` chez tous les consommateurs). --
    ck.eq(TRACKER_TICKET_STATE_FIELDS_ARE_EXHAUSTIVE, true,
      "sonde de complétude : la liste couvre TOUS les champs de `TrackerTicketState` (vérifié à la COMPILATION — `tsc` échoue avant ce test si un champ manque)");
    const decoded = JiraParse.ticketState(fixtureIssue("1", "K-1"), BASE);
    ck.eq(Object.keys(decoded).sort().join(","), [...TRACKER_TICKET_STATE_FIELDS].sort().join(","),
      "décodeur : un état produit porte EXACTEMENT les champs du pivot (ni manque, ni champ fantôme)");
    ck(TRACKER_TICKET_STATE_FIELDS.every((f) => decoded[f] !== undefined), "décodeur : aucun champ laissé `undefined` (les défauts sont explicites)");
    ck.eq(SERVER_STATUS_CATEGORIES.join(","), TRACKER_STATUS_CATEGORIES.join(","),
      "catégories : l'ensemble FERMÉ du serveur et celui qu'affiche le client sont IDENTIQUES, ordre compris (sans quoi une pastille tomberait sur « unknown » sans raison)");
    // MIROIRS CLIENT ⇄ SERVEUR des DEUX autres duplications assumées du lot P3. Elles vivent dans
    // `interventions.db`, base SERVEUR hors du schéma partagé : aucun canal `src-shared/` par où les
    // faire transiter, donc un verrou de test — sans quoi une divergence serait parfaitement muette
    // (un état de poussée lu comme « aucun », ou la sentinelle affichée BRUTE au lieu du libellé).
    ck.eq(SERVER_PUSH_STATES.join(","), TRACKER_PUSH_STATES.join(","),
      "états de poussée : l'ensemble FERMÉ du serveur et celui que lit le client sont IDENTIQUES");
    ck.eq(TrackerSyncService.NOT_FOUND_STATUS, TrackerStatus.NOT_FOUND_STATUS,
      "sentinelle « introuvable » : la valeur ÉCRITE par le pont et celle RECONNUE par l'affichage sont la MÊME chaîne");
    ck.eq(OPTION_AUTO_REPLICATE, "auto_replicate",
      "option COMMUNE : le service lit la réplication automatique par un nom GÉNÉRIQUE, jamais par marque");
    ck(KIND_OPTION_SPECS.jira.some((s) => s.name === OPTION_AUTO_REPLICATE && s.type === "boolean"),
      "option COMMUNE : … et la marque la DÉCLARE bien (une marque qui l'omet est traitée comme « pas d'automatisme »)");

    // -- 2) AGNOSTICISME DE MARQUE — l'exigence n°1 du chantier, donc TESTÉE et pas seulement
    //       affirmée. On relit les SOURCES (c'est le code ÉCRIT qu'on contrôle) de TOUT ce que la
    //       doc déclare agnostique : la couche tracker serveur (pivot, config, stockage, plafond de
    //       passe, étiquettes, MOTEUR du pont et ROUTES), la classification d'état cliente, le client
    //       REST, le formulaire de providers et ses catalogues i18n. Les COMMENTAIRES sont libres de
    //       citer la première implémentation — ils l'expliquent, et le détecteur ne les voit pas.
    //
    //       ⚠ Les exemptions sont NOMMÉES et CIBLÉES — une DÉCLARATION, jamais un fichier entier.
    //       Exempter un fichier entier laisse une marque fuir n'importe où dedans, c'est-à-dire
    //       précisément ce qu'on veut interdire.
    const fs = require("fs");
    const ts = require("typescript");
    /** Littéraux (chaîne ET morceaux de gabarit) et identifiants nommant une marque dans un extrait,
        hors des déclarations exemptées. Les morceaux de gabarit comptent parce que le code CLIENT en
        est truffé : une marque glissée dans un `${}` y passerait sinon totalement inaperçue. */
    const offendersInText = (text, exempt, fileName, allowExact) => {
      const exempted = new Set(exempt || []);
      // JETONS HÉRITÉS tolérés PARTOUT dans le fichier, listés un par un (cf. `AGNOSTIC_SOURCES`).
      // Volontairement distinct des exemptions par DÉCLARATION : ici on n'exempte pas une zone de
      // code, on reconnaît un NOM (celui d'une colonne qui appartient à un autre module et qu'on ne
      // peut pas renommer). La correspondance est EXACTE — « jira_ref » passe, « jira » non.
      const allowed = new Set(allowExact || []);
      const source = ts.createSourceFile(fileName || "extrait.ts", text, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
      const offenders = [];
      const declName = (node) => (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) ? node.name.text : null);
      const visit = (node) => {
        // Déclaration EXEMPTÉE (variable, propriété de classe, méthode, propriété d'objet littéral) :
        // on ne descend pas dedans — c'est un point d'extension, il NOMME les marques par contrat.
        if (exempted.size
          && (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node))
          && exempted.has(declName(node))) return;
        // IMPORTS exemptés (`"*imports*"`) : réservé au fichier qui porte la FABRIQUE — elle doit
        // bien importer l'adaptateur qu'elle instancie, et cette ligne fait partie du même point
        // d'extension. Partout ailleurs, importer un module de marque EST la faute qu'on traque.
        if (exempted.has("*imports*") && ts.isImportDeclaration(node)) return;
        const suspect = (text) => /jira/i.test(text) && !allowed.has(text);
        if (ts.isStringLiteralLike(node) && suspect(node.text)) offenders.push(node.text);
        if ((ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && suspect(node.text)) offenders.push(node.text);
        if (ts.isIdentifier(node) && suspect(node.text)) offenders.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(source);
      return offenders;
    };
    /** Idem, sur un fichier du dépôt désigné par son chemin RELATIF À LA RACINE. */
    const brandOffenders = (relPath, exempt, allowExact) =>
      offendersInText(fs.readFileSync(path.join(__dirname, "..", "..", ...relPath.split("/")), "utf8"), exempt, relPath, allowExact);

    /** ⚠ JETON HÉRITÉ, et un seul : `jira_ref` est le nom d'une COLONNE d'`interventions.db` —
        un module que `tracker/` ne possède pas et dont il ne peut pas renommer le schéma. Le pont
        DOIT la nommer pour y écrire la clé du ticket (c'est le champ que l'utilisateur consulte
        déjà, et ce qui fait marcher le lien `JIRA_BASE_URL` existant sans une ligne de code de
        plus). L'alternative — renommer la colonne — casserait la compatibilité d'une feature
        antérieure au chantier pour un gain purement cosmétique. */
    const LEGACY_FIELD_NAMES = ["jira_ref"];

    // Ce que la doc déclare agnostique, avec les exemptions de chacun. Les QUATRE points d'extension
    // du chantier sont exactement les quatre exemptions non vides ci-dessous.
    const AGNOSTIC_SOURCES = [
      // — SERVEUR : contrats du pivot, stockage de config, plafond de passe, étiquettes, ROUTES.
      //   Aucune marque — pas même dans un chemin de route ou un message d'erreur.
      ["src-server/src/tracker/TrackerProvider.ts", [], LEGACY_FIELD_NAMES],
      ["src-server/src/tracker/TrackerProviderConfigDb.ts", []],
      ["src-server/src/tracker/TrackerPassScope.ts", []],
      ["src-server/src/tracker/TrackerLabels.ts", []],
      ["src-server/src/tracker/TrackerModule.ts", []],
      ["src-server/src/tracker/TrackerProviderConfigValidate.ts", ["KIND_OPTION_SPECS"]],   // point d'extension n°3
      //   🚨 LE MOTEUR DU PONT : la FABRIQUE `adapterFor` est le point d'extension n°2, et c'est le
      //   SEUL endroit du fichier autorisé à nommer une marque — avec l'import de l'adaptateur
      //   qu'elle instancie (`*imports*`), qui fait partie du même point d'extension.
      ["src-server/src/tracker/TrackerSyncService.ts", ["adapterFor", "*imports*"], LEGACY_FIELD_NAMES],   // point d'extension n°2
      // — CLIENT : classification d'état, client REST, formulaire de providers. Seul ce dernier
      //   nomme les marques, dans les DEUX tables du point d'extension n°4 (`KINDS` = option du
      //   <select>, `KIND_FIELDS` = miroir des options de la marque).
      ["src-client/core/TrackerStatus.ts", []],
      ["src-client/core/TrackerReplication.ts", []],
      ["src-client/views/forms/TrackerSyncClient.ts", []],
      ["src-client/views/forms/TrackerTicketBlock.ts", []],
      ["src-client/views/forms/TrackerProvidersForm.ts", ["KINDS", "KIND_FIELDS"]],
      // — CATALOGUES i18n : AUCUN libellé traduit ne nomme un tracker (le libellé « Jira » du
      //   <select> est un nom propre et vit dans le code du formulaire, non traduit). Seule
      //   exemption, NOMMÉE : `idPlaceholder`, un EXEMPLE d'identifiant de provider (« ex.
      //   jira-infra »). Purement cosmétique — il illustre une convention de nommage dans un champ
      //   libre, ne pilote aucun comportement, et le retirer ne changerait rien au code.
      ["src-client/i18n/locales/fr/tracker.ts", ["idPlaceholder"]],
      ["src-client/i18n/locales/en/tracker.ts", ["idPlaceholder"]],
    ];
    for (const [relPath, exempt, allowExact] of AGNOSTIC_SOURCES) {
      const offenders = brandOffenders(relPath, exempt, allowExact);
      ck.eq(offenders.length, 0, "agnosticisme : « " + relPath + " » ne nomme aucune marque hors de ses points d'extension (fautifs : " + offenders.join(", ") + ")");
    }

    // CONTRÔLE DE DISCRIMINATION n°1 — le DÉTECTEUR lui-même, sur des extraits synthétiques. Sans
    // lui, une forme non couverte (le morceau de gabarit, très fréquent côté client) passerait
    // inaperçue et TOUTES les assertions ci-dessus seraient vides de sens.
    ck.eq(offendersInText('const s = "jira";', []).length, 1, "détecteur : littéral de chaîne");
    ck.eq(offendersInText("const s = `avant ${x} Jira ${y} après`;", []).length, 1, "détecteur : MORCEAU de littéral de gabarit (la forme la plus courante du code client)");
    ck.eq(offendersInText("const jiraThing = 1;", []).length, 1, "détecteur : identifiant");
    ck.eq(offendersInText('import { JiraAdapter } from "./JiraAdapter.js";', []).length, 2, "détecteur : import d'un module de marque (identifiant + spécificateur)");
    ck.eq(offendersInText('const KINDS = ["jira"];', ["KINDS"]).length, 0, "détecteur : une déclaration EXEMPTÉE est ignorée…");
    ck.eq(offendersInText('const KINDS = ["jira"]; const ailleurs = "jira";', ["KINDS"]).length, 1, "détecteur : … et l'exemption ne DÉBORDE PAS sur le reste du fichier (c'est tout l'intérêt d'exempter une déclaration plutôt qu'un fichier)");
    ck.eq(offendersInText("const x = rec.jira_ref;", [], undefined, LEGACY_FIELD_NAMES).length, 0, "détecteur : le JETON HÉRITÉ « jira_ref » est toléré…");
    ck.eq(offendersInText('const x = rec.jira_ref; const y = "jira";', [], undefined, LEGACY_FIELD_NAMES).length, 1, "détecteur : … et la tolérance est EXACTE — « jira » tout court reste une faute");
    ck.eq(offendersInText('const x = "jira_ref_bis";', [], undefined, LEGACY_FIELD_NAMES).length, 1, "détecteur : … et ne s'étend pas à un nom VOISIN (correspondance exacte, pas un préfixe)");

    // CONTRÔLE DE DISCRIMINATION n°2 — chaque exemption est LOAD-BEARING : sans elle, le détecteur
    // trouve bien une marque là où le point d'extension la pose. Une exemption décorative masquerait
    // un point d'extension DÉPLACÉ sans que rien ne le signale.
    for (const [relPath, exempt] of AGNOSTIC_SOURCES.filter(([, e]) => e.length)) {
      ck(brandOffenders(relPath, []).length > 0,
        "discrimination : l'exemption de « " + relPath + " » (" + exempt.join(", ") + ") n'est pas décorative — sans elle, une marque y est bien détectée");
    }
    for (const [relPath, , allowExact] of AGNOSTIC_SOURCES.filter(([, , a]) => a && a.length)) {
      ck(brandOffenders(relPath, [], []).length > 0,
        "discrimination : la tolérance de « " + relPath + " » (" + allowExact.join(", ") + ") n'est pas décorative — sans elle, un nom hérité y est bien détecté");
    }
    ck(brandOffenders("src-server/src/tracker/JiraParse.ts", []).length > 0,
      "discrimination : le détecteur repère bien la marque dans le module qui la porte (sinon les tests ci-dessus seraient vacuous)");

    // -- 3) COHÉRENCE marque ⇄ table d'options, DANS LES DEUX SENS. Un seul sens ne suffit pas : un
    //       `kind` validable SANS adaptateur donne un provider enregistrable mais MORT (il échoue à
    //       chaque passe), et un adaptateur SANS branche d'options donne un provider dont les
    //       réglages de marque sont silencieusement écartés. Les deux défauts sont MUETS. --
    ck(SUPPORTED_KINDS.includes(new JiraAdapter(CFG, mkJiraStub({})).kind), "cohérence → : le `kind` déclaré par l'adaptateur a bien une branche d'options");
    for (const kind of SUPPORTED_KINDS) {
      let built = null;
      try { built = TrackerSyncService.adapterFor({ ...CFG, kind }); } catch (_) { built = null; }
      ck(built !== null && built.kind === kind,
        "cohérence ← : tout kind VALIDABLE (« " + kind + " ») a bien un adaptateur dans la FABRIQUE (sinon : provider enregistrable mais mort)");
    }
    let unknownKind = null;
    try { TrackerSyncService.adapterFor({ ...CFG, kind: "marque-inconnue" }); } catch (e) { unknownKind = e; }
    ck(unknownKind !== null && /inconnu/.test(unknownKind.message),
      "fabrique : un kind inconnu échoue à la SYNCHRO (statut en erreur pour CE provider), pas au chargement — les autres providers vivent");
    ck.eq(Object.keys(KIND_OPTION_SPECS).length, 1, "v1 : une seule marque implémentée — le mécanisme, lui, en accepte N");
  }
  });
};
