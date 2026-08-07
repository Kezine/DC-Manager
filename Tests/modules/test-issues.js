/* Tests modules — COUCHE TRACKER (module serveur AMOVIBLE `issues/`) + affichage d'état.
   ----------------------------------------------------------------------------
   ⚠ CE FICHIER A MAIGRI AU PIVOT DU 2026-08-07. Il couvrait la feature « remote issue
   tracker » — un MIROIR des tickets d'un tracker distant DANS DC Manager (collection
   partagée `issues`, onglet dédié, suivi de tickets étrangers). Le besoin réel était le flux
   INVERSE : répliquer les incidents/interventions DC Manager DANS un projet Jira partagé
   (cf. `.notes/toDos/jira-replication-interventions-cadrage-2026-08-07.md`). La collection,
   son UI et sa synchro ont donc été DÉMOLIES ; ce qui les servait — l'accès au tracker et la
   configuration chiffrée des providers — SURVIT tel quel et reste testé ici, parce que le pont
   `interventions ⇄ Jira` (lot P2) le consommera sans y toucher.
   Ce qui a disparu avec la feature, et pourquoi c'est SANS PERTE : la frontière source/locaux
   partagée, les clés de cible composées, la spec de collection, la cascade des `targets`, les
   catalogues de recherche, la réconciliation à assiette inversée, la synchro de bout en bout et
   les deux portes d'entrée de l'assiette (« Suivre » / « Ouvrir un ticket ») ne testaient QUE du
   code supprimé — les garder aurait testé du vide.

   Ce qui reste, du plus pur au plus intégré :
   1. `core/IssueStatus` — classification d'un état de ticket (catégorie FERMÉE, priorité de
      l'introuvable, clé de tri, libellés) et ses PASTILLES avec leur échappement. SANS
      consommateur pour l'instant, et c'est assumé : le lot P3 affichera le statut Jira d'une
      intervention répliquée avec exactement ces règles-là ;
   2. `Html.externalLink` — un lien sortant ne peut pas être un vecteur XSS (primitive GÉNÉRIQUE,
      utile à toute donnée d'origine tierce affichée en lien) ;
   3. le miroir `KIND_FIELDS` (formulaire providers) ⇄ `KIND_OPTION_SPECS` (serveur) — un miroir
      que personne ne vérifie finit par diverger ;
   4. `JiraParse.toAdf` — le format de description de l'API v3 (piège n°1 de la création) ;
   5. le DÉCODAGE Jira PUR : formes pleines/creuses/inattendues, alias, catégorie d'état, et les
      DEUX pièges du chantier — `ext_id` = l'id INTERNE (jamais la clé, qui bouge au déplacement
      de projet) et `url` COMPOSÉE vers l'interface (jamais le champ `self`, qui pointe l'API) ;
   6. la PAGINATION pure (chaque garde-fou séparément, DEUX formes d'API) + JQL + références saisies ;
   7. l'ORCHESTRATION de l'adaptateur sur stub HTTP STRUCTUREL : `resolve` par LOTS et le partage
      found/missing, `lookup`, `createIssue` (dont l'échec Jira au message INTACT), `test` ;
   8. le CLIENT HTTP : parties pures (Basic, `Retry-After`, extraction du message d'erreur) et flux
      réel sur `fetch` INJECTÉ — 429 avec backoff borné, cap de réponse, erreurs traduites ;
   9. la VALIDATION d'un provider — champs communs + branche d'options PAR MARQUE ;
  10. le STOCKAGE chiffré (better-sqlite3 RÉEL) : CRUD sans fuite de jeton, compte RELU, sentinelle ;
  11. `TrackerPassScope` — le PLAFOND de passe et son ROULEMENT. Extrait du service démoli parce que
      la leçon ne dépend pas de ce qu'on synchronise : la synchro étant IDEMPOTENTE, un simple tri
      laisserait une ZONE MORTE permanente en queue d'assiette, que rien ne signalerait ;
  12. les INVARIANTS : décodeur ≡ pivot (`ISSUE_RECORD_FIELDS`, plus sa sonde de compilation) et
      AGNOSTICISME de marque — aucun littéral « jira » hors des points d'extension, sur les sources
      SURVIVANTES, avec des exemptions par DÉCLARATION dont chacune est prouvée load-bearing.
   ⚠ Les routes Express restent HORS test, comme `api.ts`/`VmModule`/`WifiModule` : c'est la
   convention du dépôt (et le module de routes `IssueModule.ts` a été supprimé au pivot).
   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, path, D, SHARED, SERVER, Validation, Cascade, SharedSchema, EntityRegistry, COLLECTION_THREE_IMPACT, makeStore } = require("./harness.js");

module.exports = async () => {
  const { IssueStatus, ISSUE_STATUS_CATEGORIES } = D("core/IssueStatus.js");

  await section("client : IssueStatus — catégories, PRIORITÉ de l'introuvable, clé de tri, libellés", async () => {
  {
    // -- CATÉGORIE : ensemble FERMÉ, repli `unknown` sur tout ce qui n'en est pas (le module ne fait
    //    jamais confiance à ce qui vient d'un tiers, même si la synchro serveur clampe déjà). --
    // ⚠ Attente EXPLICITE (jamais dérivée du module) : la liste est l'ABSTRACTION multi-marques
    //    elle-même — c'est elle qui rend un GitHub ou un Redmine affichable sans toucher une vue.
    //    L'ORDRE compte autant que le contenu : il EST l'ordre de tri sémantique des listings.
    ck.eq(ISSUE_STATUS_CATEGORIES.join(","), "todo,in_progress,done,unknown",
      "ISSUE_STATUS_CATEGORIES : les 4 valeurs fermées, dans l'ordre SÉMANTIQUE (à faire → terminé → inclassable)");
    ck.eq(IssueStatus.CATEGORIES.join(","), ISSUE_STATUS_CATEGORIES.join(","), "CATEGORIES : reprise TELLE QUELLE de la liste (pas de seconde table)");
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
  }
  });

  /* ==========================================================================================
     LOT L4 — UI DE LECTURE : ce qui est PUR et testable sans navigateur
     (les vues DOM restent hors test, comme partout dans le dépôt).
     ========================================================================================== */

  await section("client L4 : IssueStatus — PASTILLES (échappement, priorité de l'introuvable, couleur par catégorie)", async () => {
  {
    const frLists = D("i18n/locales/fr/lists.js").lists, frDomain = D("i18n/locales/fr/domain.js").domain;

    // -- STATUT : le libellé BRUT est rendu TEL QUEL… mais ÉCHAPPÉ. C'est une donnée d'ORIGINE
    //    DISTANTE posée en innerHTML : un statut de workflow contenant du balisage ne doit pas
    //    devenir du HTML. Les couleurs, elles, sont des constantes internes — jamais une donnée. --
    const plain = IssueStatus.statusPill({ status: "En recette", status_category: "in_progress" });
    ck(plain.indexOf("En recette") >= 0, "statusPill : le libellé BRUT du tracker est affiché tel quel (jamais traduit — décision D3)");
    const nasty = IssueStatus.statusPill({ status: '<img src=x onerror="alert(1)">', status_category: "todo" });
    ck(nasty.indexOf("<img") === -1, "statusPill : un statut porteur de balisage est ÉCHAPPÉ (donnée distante en innerHTML)");
    ck(nasty.indexOf("&lt;img") >= 0, "statusPill : … et reste LISIBLE sous forme échappée (on n'efface pas la donnée)");
    ck(nasty.indexOf("onerror=\"") === -1, "statusPill : aucun attribut d'événement ne survit à l'échappement");

    // -- COULEUR : portée par la CATÉGORIE (le seul axe commun à tous les providers), jamais par le
    //    libellé libre. Deux catégories distinctes ⇒ deux pastilles distinctes. --
    ck(IssueStatus.statusPill({ status: "X", status_category: "done" }) !== IssueStatus.statusPill({ status: "X", status_category: "todo" }),
      "statusPill : MÊME libellé, catégories différentes → pastilles différentes (c'est la catégorie qui colore)");

    // -- STATUT VIDE (toléré par le pivot) : repli sur le LIBELLÉ DE CATÉGORIE, qui est traduisible.
    //    On n'a PAS traduit un libellé du tracker (D3 tient), on affiche la classification. --
    ck(IssueStatus.statusPill({ status: "", status_category: "todo" }).indexOf(frDomain.issueStatusCategory.todo) >= 0,
      "statusPill : statut vide → libellé de CATÉGORIE (jamais une pastille vide)");

    // -- INTROUVABLE : pastille PROPRE, en tête, et les DEUX sont rendues (savoir qu'un ticket
    //    introuvable était « En cours » est précisément ce qui aide à décider quoi en faire). --
    ck.eq(IssueStatus.notFoundPill({}), "", "notFoundPill : ticket résolu → aucune pastille");
    const notFound = IssueStatus.notFoundPill({ orphan: true });
    ck(notFound.indexOf(frLists.ph.notFound) >= 0, "notFoundPill : libellé « introuvable » (et non « orphelin » ni « déconnecté »)");
    ck(notFound.indexOf("var(--warn)") >= 0, "notFoundPill : couleur d'AVERTISSEMENT — l'enregistrement local est intact");
    ck(/title="/.test(IssueStatus.notFoundPill({ orphan: true }, "explication")), "notFoundPill : infobulle posée quand elle est fournie (la fiche l'utilise, le listing non)");
    ck(!/title="/.test(notFound), "notFoundPill : aucune infobulle sans titre (colonne étroite du listing)");
    ck(IssueStatus.notFoundPill({ orphan: true }, '"><script>').indexOf("<script") === -1, "notFoundPill : l'infobulle est échappée (elle finit dans un ATTRIBUT)");

    const both = IssueStatus.pills({ orphan: true, status: "En cours", status_category: "in_progress" });
    ck(both.indexOf(frLists.ph.notFound) >= 0 && both.indexOf("En cours") >= 0,
      "pills : les DEUX pastilles sont rendues, jamais l'une À LA PLACE de l'autre");
    ck(both.indexOf(frLists.ph.notFound) < both.indexOf("En cours"), "pills : l'introuvable passe EN TÊTE (c'est l'état COURANT, la catégorie date de la dernière résolution)");
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
    const { IssueProvidersForm } = D("views/forms/IssueProvidersForm.js");
    const { I18n } = D("i18n/I18n.js");
    const { KIND_OPTION_SPECS } = SERVER("issues/IssueProviderConfigValidate.js");
    const TYPE_OF_SPEC = { string: "text", boolean: "toggle" };   // spec serveur → contrôle client

    ck.eq(Object.keys(IssueProvidersForm.KIND_FIELDS).sort().join(","), Object.keys(KIND_OPTION_SPECS).sort().join(","),
      "miroir : MÊMES marques déclarées des deux côtés (ajouter une marque = 1 entrée ici + 1 branche là-bas)");
    for (const kind of Object.keys(KIND_OPTION_SPECS)) {
      const server = KIND_OPTION_SPECS[kind], client = IssueProvidersForm.KIND_FIELDS[kind] || [];
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

    // -- ÉTIQUETTES : nettoyées, mais NI triées NI dédupliquées ici — le décodeur rend ce qu'il a LU,
    //    la canonisation appartient à la frontière de PERSISTANCE (le faire deux fois de deux façons
    //    est ce qui produit un faux delta à chaque passe). --
    const labels = JiraParse.issueRecord(fixtureIssue("9", "K-9", { labels: ["b", "  a  ", "", 42, null, "b"] }), BASE).labels;
    ck.eq(JSON.stringify(labels), JSON.stringify(["b", "a", "b"]),
      "labels : rognées, vides et non-chaînes écartées — ordre CONSERVÉ et doublon GARDÉ (la canonisation n'est PAS le travail du décodeur)");

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

  /* ============ SERVEUR : plafond ROULANT d'une passe de synchro (module PUR) ============ */

  await section("Serveur : TrackerPassScope — plafond de passe, ordre stable et ROULEMENT (aucune zone morte)", async () => {
  {
    const { TrackerPassScope } = SERVER("issues/TrackerPassScope.js");
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

  /* ============ SERVEUR : invariants de contrat et d'agnosticisme ============ */

  await section("Serveur : invariants — décodeur ≡ pivot, agnosticisme de marque (aucun « jira » hors des points d'extension)", async () => {
  {
    const { ISSUE_RECORD_FIELDS, ISSUE_RECORD_FIELDS_ARE_EXHAUSTIVE } = SERVER("issues/IssueProvider.js");
    const { KIND_OPTION_SPECS, SUPPORTED_KINDS } = SERVER("issues/IssueProviderConfigValidate.js");

    // -- 1) DÉCODEUR ⇄ PIVOT. ⚠ Cet invariant confrontait aussi le pivot à la FRONTIÈRE PARTAGÉE
    //       (`src-shared/IssueSync.ISSUE_SOURCE_FIELDS`), supprimée avec la collection `issues` au
    //       pivot du 2026-08-07 : le pivot n'a plus de pendant PERSISTÉ tant que le pont du lot P2
    //       n'aura pas posé les colonnes `tracker_*` d'`interventions.db`. Ce qui RESTE vérifiable
    //       aujourd'hui — et qui reste ce qui casserait silencieusement — c'est la boucle interne :
    //       la liste couvre l'interface, et le décodeur produit EXACTEMENT cette liste. --
    ck.eq(ISSUE_RECORD_FIELDS_ARE_EXHAUSTIVE, true,
      "sonde de complétude : la liste couvre TOUS les champs de l'interface `IssueRecord` (vérifié à la COMPILATION — `tsc` échoue avant ce test si un champ manque)");
    const decoded = JiraParse.issueRecord(fixtureIssue("1", "K-1"), BASE);
    ck.eq(Object.keys(decoded).sort().join(","), [...ISSUE_RECORD_FIELDS].sort().join(","),
      "décodeur : un record produit porte EXACTEMENT les champs du pivot (ni manque, ni champ fantôme)");
    ck(ISSUE_RECORD_FIELDS.every((f) => decoded[f] !== undefined), "décodeur : aucun champ laissé `undefined` (les défauts sont explicites)");

    // -- 2) AGNOSTICISME DE MARQUE — l'exigence n°1 du chantier, donc TESTÉE et pas seulement
    //       affirmée. On relit les SOURCES (c'est le code ÉCRIT qu'on contrôle) de TOUT ce que la
    //       doc déclare agnostique. ⚠ La liste a MAIGRI au pivot du 2026-08-07 : elle balayait 19
    //       fichiers, dont la plupart ont été supprimés avec le miroir de tickets. Ne restent que
    //       les SURVIVANTS — la couche tracker serveur (pivot, config, stockage, plafond de passe),
    //       la classification d'état cliente, le client REST, le formulaire de providers et ses
    //       catalogues i18n. Les COMMENTAIRES sont libres de citer la première implémentation — ils
    //       l'expliquent, et le détecteur ne les voit pas.
    //
    //       ⚠ Les exemptions sont NOMMÉES et CIBLÉES — une DÉCLARATION, jamais un fichier entier.
    //       Exempter un fichier entier laisse une marque fuir n'importe où dedans, c'est-à-dire
    //       précisément ce qu'on veut interdire.
    //       ⚠ La FABRIQUE `adapterFor` (point d'extension n°2) n'est plus balayée : elle vivait dans
    //       le service de synchro, démoli. Le lot P2 la reposera dans le pont — il devra la
    //       RÉINSCRIRE ici, avec son exemption `*imports*`, sinon plus rien ne dira qu'une marque a
    //       filé hors de son point d'extension.
    const fs = require("fs");
    const ts = require("typescript");
    /** Littéraux (chaîne ET morceaux de gabarit) et identifiants nommant une marque dans un extrait,
        hors des déclarations exemptées. Les morceaux de gabarit comptent parce que le code CLIENT en
        est truffé : une marque glissée dans un `${}` y passerait sinon totalement inaperçue. */
    const offendersInText = (text, exempt, fileName) => {
      const exempted = new Set(exempt || []);
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
        if (ts.isStringLiteralLike(node) && /jira/i.test(node.text)) offenders.push(node.text);
        if ((ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /jira/i.test(node.text)) offenders.push(node.text);
        if (ts.isIdentifier(node) && /jira/i.test(node.text)) offenders.push(node.text);
        ts.forEachChild(node, visit);
      };
      visit(source);
      return offenders;
    };
    /** Idem, sur un fichier du dépôt désigné par son chemin RELATIF À LA RACINE. */
    const brandOffenders = (relPath, exempt) =>
      offendersInText(fs.readFileSync(path.join(__dirname, "..", "..", ...relPath.split("/")), "utf8"), exempt, relPath);

    // Ce que la doc déclare agnostique, avec les exemptions de chacun. Les QUATRE points d'extension
    // du chantier sont exactement les quatre exemptions non vides ci-dessous.
    const AGNOSTIC_SOURCES = [
      // — SERVEUR : contrats du pivot, stockage de config, plafond de passe. Aucune marque.
      ["src-server/src/issues/IssueProvider.ts", []],
      ["src-server/src/issues/IssueProviderConfigDb.ts", []],
      ["src-server/src/issues/TrackerPassScope.ts", []],
      ["src-server/src/issues/IssueProviderConfigValidate.ts", ["KIND_OPTION_SPECS"]],   // point d'extension n°3
      // — CLIENT : classification d'état, client REST, formulaire de providers. Seul ce dernier
      //   nomme les marques, dans les DEUX tables du point d'extension n°4 (`KINDS` = option du
      //   <select>, `KIND_FIELDS` = miroir des options de la marque).
      ["src-client/core/IssueStatus.ts", []],
      ["src-client/views/forms/IssueSyncClient.ts", []],
      ["src-client/views/forms/IssueProvidersForm.ts", ["KINDS", "KIND_FIELDS"]],
      // — CATALOGUES i18n : AUCUN libellé traduit ne nomme un tracker (le libellé « Jira » du
      //   <select> est un nom propre et vit dans le code du formulaire, non traduit). Seule
      //   exemption, NOMMÉE : `idPlaceholder`, un EXEMPLE d'identifiant de provider (« ex.
      //   jira-infra »). Purement cosmétique — il illustre une convention de nommage dans un champ
      //   libre, ne pilote aucun comportement, et le retirer ne changerait rien au code.
      ["src-client/i18n/locales/fr/issues.ts", ["idPlaceholder"]],
      ["src-client/i18n/locales/en/issues.ts", ["idPlaceholder"]],
    ];
    for (const [relPath, exempt] of AGNOSTIC_SOURCES) {
      const offenders = brandOffenders(relPath, exempt);
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

    // CONTRÔLE DE DISCRIMINATION n°2 — chaque exemption est LOAD-BEARING : sans elle, le détecteur
    // trouve bien une marque là où le point d'extension la pose. Une exemption décorative masquerait
    // un point d'extension DÉPLACÉ sans que rien ne le signale.
    for (const [relPath, exempt] of AGNOSTIC_SOURCES.filter(([, e]) => e.length)) {
      ck(brandOffenders(relPath, []).length > 0,
        "discrimination : l'exemption de « " + relPath + " » (" + exempt.join(", ") + ") n'est pas décorative — sans elle, une marque y est bien détectée");
    }
    ck(brandOffenders("src-server/src/issues/JiraParse.ts", []).length > 0,
      "discrimination : le détecteur repère bien la marque dans le module qui la porte (sinon les tests ci-dessus seraient vacuous)");

    // -- 3) COHÉRENCE marque ⇄ table d'options. ⚠ Le SENS INVERSE (« tout kind validable a bien un
    //       adaptateur dans la FABRIQUE ») a disparu avec `adapterFor`, démolie au pivot : un `kind`
    //       validable sans adaptateur donnerait un provider enregistrable mais MORT, et c'est
    //       exactement ce que le lot P2 devra RE-verrouiller en reposant la fabrique dans le pont. --
    ck(SUPPORTED_KINDS.includes(new JiraAdapter(CFG, mkJiraStub({})).kind), "cohérence : le `kind` déclaré par l'adaptateur a bien une branche d'options");
    ck.eq(Object.keys(KIND_OPTION_SPECS).length, 1, "v1 : une seule marque implémentée — le mécanisme, lui, en accepte N");
  }
  });
};
