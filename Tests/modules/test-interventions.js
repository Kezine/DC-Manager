/* Tests modules — feature INTERVENTIONS (lot client) : logique PURE testable headless.
   - InterventionsFormat : mapping slugs → CLÉS i18n (aucune dépendance i18n), rangs/classes de badge,
     jiraUrl (référence Jira), formatWindow, shortId ;
   - InterventionsClient.buildQuery : construction PURE de la query string (filtres RÉPÉTABLES).
   Les nouvelles CLÉS i18n (interventions.*) sont couvertes par test-i18n (complétude fr ⇄ en). */
"use strict";
const { ck, section, D, SharedSchema } = require("./harness.js");

module.exports = async () => {
  const { InterventionsFormat } = D("core/InterventionsFormat.js");
  const { InterventionsClient } = D("views/forms/InterventionsClient.js");
  const { TargetSearch } = D("core/TargetSearch.js");

  await section("Interventions : InterventionsFormat — slugs → clés i18n (kind/status/priority/target) + miroirs serveur", async () => {
    // Tous les slugs des énumérations donnent « interventions.<domaine>.<slug> » (la vue appelle I18n.t dessus).
    InterventionsFormat.KIND_SLUGS.forEach((s) => ck.eq(InterventionsFormat.kindLabelKey(s), "interventions.kind." + s, "kindLabelKey(" + s + ")"));
    InterventionsFormat.STATUS_SLUGS.forEach((s) => ck.eq(InterventionsFormat.statusLabelKey(s), "interventions.status." + s, "statusLabelKey(" + s + ")"));
    InterventionsFormat.PRIORITY_SLUGS.forEach((s) => ck.eq(InterventionsFormat.priorityLabelKey(s), "interventions.priority." + s, "priorityLabelKey(" + s + ")"));
    InterventionsFormat.TARGET_KIND_SLUGS.forEach((s) => ck.eq(InterventionsFormat.targetKindLabelKey(s), "interventions.target." + s, "targetKindLabelKey(" + s + ")"));
    // MIROIRS des énumérations serveur (garde-fou de dérive : mêmes valeurs, même ordre canonique).
    ck.eq(InterventionsFormat.KIND_SLUGS.join(","), "incident,intervention", "KIND_SLUGS = miroir serveur");
    ck.eq(InterventionsFormat.STATUS_SLUGS.join(","), "declared,planned,in_progress,closed,cancelled", "STATUS_SLUGS = miroir serveur (ordre cycle de vie)");
    ck.eq(InterventionsFormat.PRIORITY_SLUGS.join(","), "low,normal,high,critical", "PRIORITY_SLUGS = miroir serveur (ordre croissant)");
    ck.eq(InterventionsFormat.TARGET_KIND_SLUGS.join(","), "equipment,vm,spare", "TARGET_KIND_SLUGS = miroir serveur");
  });

  await section("Interventions : InterventionsFormat — rangs & classes de badge (priorité/statut)", async () => {
    ck.eq(InterventionsFormat.priorityRank("low"), 0, "priorityRank low = 0");
    ck.eq(InterventionsFormat.priorityRank("critical"), 3, "priorityRank critical = 3");
    ck.eq(InterventionsFormat.priorityRank("inconnu"), -1, "priorityRank inconnu = -1");
    ck.eq(InterventionsFormat.priorityClass("critical"), "err", "priorityClass critical = err");
    ck.eq(InterventionsFormat.priorityClass("high"), "warn", "priorityClass high = warn");
    ck.eq(InterventionsFormat.priorityClass("normal"), "neutral", "priorityClass normal = neutral");
    ck.eq(InterventionsFormat.priorityClass("low"), "dim", "priorityClass low = dim");
    ck.eq(InterventionsFormat.statusClass("in_progress"), "warn", "statusClass in_progress = warn");
    ck.eq(InterventionsFormat.statusClass("closed"), "ok", "statusClass closed = ok");
    ck.eq(InterventionsFormat.statusClass("cancelled"), "dim", "statusClass cancelled = dim");
    ck.eq(InterventionsFormat.statusClass("declared"), "neutral", "statusClass declared = neutral (défaut)");
  });

  await section("Interventions : InterventionsFormat — jiraUrl (base+clé, réf-URL, base absente, jointures de /)", async () => {
    ck.eq(InterventionsFormat.jiraUrl("https://org.atlassian.net/browse/", "INFRA-1"), "https://org.atlassian.net/browse/INFRA-1", "base avec slash final + clé");
    ck.eq(InterventionsFormat.jiraUrl("https://org.atlassian.net/browse", "INFRA-1"), "https://org.atlassian.net/browse/INFRA-1", "base SANS slash final → un seul / de jointure");
    ck.eq(InterventionsFormat.jiraUrl("https://org.atlassian.net/browse/", "/INFRA-1"), "https://org.atlassian.net/browse/INFRA-1", "clé avec slash initial → pas de double /");
    ck.eq(InterventionsFormat.jiraUrl("https://x/browse/", "https://autre/T-9"), "https://autre/T-9", "réf DÉJÀ une URL → telle quelle (base ignorée)");
    ck.eq(InterventionsFormat.jiraUrl("https://x/browse/", "HTTP://Autre/T-9"), "HTTP://Autre/T-9", "réf URL insensible à la casse du schéma");
    ck.eq(InterventionsFormat.jiraUrl(null, "INFRA-1"), null, "base absente + clé simple → null (la vue affiche le texte)");
    ck.eq(InterventionsFormat.jiraUrl("", "INFRA-1"), null, "base vide → null");
    ck.eq(InterventionsFormat.jiraUrl("https://x/browse/", null), null, "réf absente → null");
    ck.eq(InterventionsFormat.jiraUrl("https://x/browse/", "   "), null, "réf blanche → null");
  });

  await section("Interventions : InterventionsFormat — formatWindow & shortId", async () => {
    ck.eq(InterventionsFormat.formatWindow("2026-08-01T09:00:00.000Z", "2026-08-01T11:30:00.000Z"), "2026-08-01 09:00 → 2026-08-01 11:30", "fenêtre début → fin");
    ck.eq(InterventionsFormat.formatWindow("2026-08-01T09:00:00.000Z", null), "2026-08-01 09:00", "fenêtre sans fin → début seul (repli propre)");
    ck.eq(InterventionsFormat.formatWindow(null, null), "", "sans début → chaîne vide");
    ck.eq(InterventionsFormat.formatWindow(null, "2026-08-01T11:00:00.000Z"), "", "fin sans début (ne devrait pas arriver) → vide");
    ck.eq(InterventionsFormat.formatWindow("", ""), "", "chaînes vides → vide");
    ck.eq(InterventionsFormat.shortId("abcdefghijklmnop"), "abcdefgh…", "shortId > 10 → 8 car. + …");
    ck.eq(InterventionsFormat.shortId("court"), "court", "shortId ≤ 10 → inchangé");
    ck.eq(InterventionsFormat.shortId("0123456789"), "0123456789", "shortId = 10 → inchangé (borne)");
  });

  await section("Interventions : InterventionsClient.buildQuery — scalaires + filtres RÉPÉTABLES (jamais concaténés)", async () => {
    ck.eq(InterventionsClient.buildQuery({}), "", "aucun paramètre → chaîne vide");
    ck.eq(InterventionsClient.buildQuery({ page: 2, pageSize: 25 }), "?page=2&pageSize=25", "page/pageSize scalaires");
    const q = InterventionsClient.buildQuery({ kinds: ["incident", "intervention"], statuses: ["declared"], priorities: ["high", "critical"] });
    ck(q.indexOf("kind=incident") >= 0 && q.indexOf("kind=intervention") >= 0, "kinds → paramètres kind= RÉPÉTÉS");
    ck(q.indexOf(",") < 0 && q.indexOf("%2C") < 0, "kinds : aucune virgule (répétition, jamais « kind=a,b »)");
    ck(q.indexOf("status=declared") >= 0 && q.indexOf("priority=high") >= 0 && q.indexOf("priority=critical") >= 0, "statuses/priorities répétés de la même façon");
    ck.eq(InterventionsClient.buildQuery({ query: "a b", sort: "priority", dir: "desc" }), "?query=a+b&sort=priority&dir=desc", "query encodée (espace → +) + sort/dir");
  });

  await section("Interventions : TargetSearch.rank — pertinence (préfixe avant inclusion), accents, plafond, dédup", async () => {
    const norm = SharedSchema.normSearch;   // MÊME normalisation que la recherche du cœur (casse/accents)
    const items = [
      { kind: "equipment", id: "e1", label: "Switch Core" },      // « core » en INCLUSION (indexOf 7)
      { kind: "vm",        id: "v1", label: "core-db-01" },       // « core » en PRÉFIXE (indexOf 0)
      { kind: "spare",     id: "s1", label: "Écran de secours" }, // accent : matché par « ecran »
      { kind: "equipment", id: "e2", label: "Routeur périphérique" },
    ];

    // Requête vide → aucun résultat (on n'inonde pas le popover).
    ck.eq(TargetSearch.rank(items, "", { normalize: norm }).length, 0, "requête vide → []");
    ck.eq(TargetSearch.rank(items, "   ", { normalize: norm }).length, 0, "requête blanche → []");

    // Pertinence : le PRÉFIXE (core-db-01) passe AVANT l'inclusion (Switch Core).
    const core = TargetSearch.rank(items, "core", { normalize: norm });
    ck.eq(core.length, 2, "« core » → 2 correspondances");
    ck.eq(core[0].id, "v1", "préfixe (core-db-01) classé en 1er");
    ck.eq(core[1].id, "e1", "inclusion (Switch Core) classée après le préfixe");

    // Insensibilité aux accents ET à la casse (normalisation partagée injectée).
    ck.eq(TargetSearch.rank(items, "ECRAN", { normalize: norm }).map((r) => r.id).join(","), "s1", "« ECRAN » (sans accent, majuscules) → Écran de secours");
    ck.eq(TargetSearch.rank(items, "périph", { normalize: norm }).map((r) => r.id).join(","), "e2", "« périph » → Routeur périphérique");

    // Plafond : limite le nombre de résultats (préfixe prioritaire conservé).
    const capped = TargetSearch.rank(items, "core", { normalize: norm, limit: 1 });
    ck.eq(capped.length, 1, "plafond 1 → 1 résultat");
    ck.eq(capped[0].id, "v1", "plafond conserve le plus pertinent (préfixe)");

    // Dédup : les cibles DÉJÀ liées (clés « kind:id ») sont écartées.
    const excluded = new Set([TargetSearch.key("vm", "v1")]);
    const deduped = TargetSearch.rank(items, "core", { normalize: norm, excluded });
    ck.eq(deduped.map((r) => r.id).join(","), "e1", "dédup : v1 exclu → reste Switch Core");
    ck.eq(TargetSearch.key("equipment", "e1"), "equipment:e1", "key = « <kind>:<id> » (convention des liens)");
  });
};
