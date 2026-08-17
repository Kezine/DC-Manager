/* Tests modules — AUTHENTIFICATION : orchestrateur + providers (lot 3 du chantier auth/ACL).

   Quatre sections, une par classe, dans l'ordre de la découpe :
   1. `auth/DevAuthProvider` — l'identité factice du mode par défaut (et le fait qu'elle ne
      présente AUCUNE clé de session, donc n'est jamais mise en cache) ;
   2. `auth/BasicAuthProvider` — l'analyse de `BASIC_AUTH` (qui EST l'inférence de mode), le
      décodage de l'en-tête, et la NON-FUITE par court-circuit (les deux comparaisons à temps
      constant sont évaluées même quand la première a déjà échoué — vérifié en COMPTANT les
      hachages, pas en relisant le commentaire) ;
   3. `auth/LegacySsoAuthProvider` — extraction du jeton (cookie nommé / en-tête complet / absent /
      nom à métacaractères), PASSTHROUGH intégral du JSON, replis fail-closed d'un SSO en erreur ou
      injoignable, et l'invariant « le jeton n'apparaît jamais dans un log » ;
   4. `auth.ts` (`Auth`) — l'ORCHESTRATEUR : sélection du provider (inférence de mode inchangée),
      annonce de boot, `checkBasic` du gate de transport, cache par hash de jeton (réservé au SSO)
      et capture d'annuaire (jamais un non-loggé).

   Aucun serveur, aucun réseau : le contrat `auth/AuthProvider` déclare sa propre vue minimale de
   la requête (Express n'entre pas), et le provider SSO reçoit son `fetch` INJECTÉ.

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, SERVER } = require("./harness.js");

/* -------- outillage local -------- */

/** Journal ENREGISTREUR (au lieu d'un Logger silencieux) : les lignes de log font partie du
    comportement observable du boot et des replis SSO — autant les vérifier. */
const makeLog = () => {
  const lines = [];
  const rec = (level) => (...args) => { lines.push(level + " " + args.join(" ")); };
  return { lines, error: rec("error"), warn: rec("warn"), info: rec("info"), debug: rec("debug"), trace: rec("trace") };
};

/** `fetch` bouchonné : mémorise les appels (URL + en-têtes) et rend ce que dit le répondeur. */
const makeFetch = (responder) => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), headers: (init && init.headers) || {} });
    return responder(calls.length);
  };
  fn.calls = calls;
  return fn;
};
const jsonOk = (body) => ({ ok: true, status: 200, json: async () => body });
const httpFail = (status) => ({ ok: false, status, json: async () => ({}) });

/** En-tête `Authorization: Basic` d'un couple. */
const basicHeader = (user, pass) => ({ headers: { authorization: "Basic " + Buffer.from(user + ":" + pass).toString("base64") } });

module.exports = async () => {

  /* ==========================================================================
     1. DevAuthProvider
     ========================================================================== */
  await section("Serveur : auth — DevAuthProvider (identité factice SUPER_ADMIN, login par défaut/DEV_USER, jamais anonyme, jamais mis en cache)", async () => {
    const { DevAuthProvider } = SERVER("auth/DevAuthProvider.js");

    const provider = new DevAuthProvider(null);
    const session = await provider.authenticate({ headers: {} });
    ck.eq(session.user.login, "dev", "DEV_USER absent → login de défaut");
    ck.eq(DevAuthProvider.DEFAULT_LOGIN, "dev", "…et ce défaut est nommé sur la classe");
    ck.eq(session.user.nom, "Dev", "profil factice : nom « Dev »");
    ck.eq(session.user.prenom, "", "profil factice : prénom vide");
    ck.eq(session.logged, true, "mode dev : TOUJOURS authentifié");
    ck.eq(session.adminRight, "SUPER_ADMIN", "mode dev : SUPER_ADMIN (rétrocompat de la politique de rôles)");
    ck.eq(session.dev, true, "mode dev : marqueur `dev` posé (→ rôle admin côté RoleProvider)");
    ck.eq(session.groups, undefined, "aucun groupe : le champ `groups` reste vide tant qu'aucun IdP n'en fournit");

    ck.eq((await new DevAuthProvider("bmoreau").authenticate({ headers: {} })).user.login, "bmoreau", "DEV_USER renseigné → login honoré");
    ck.eq((await new DevAuthProvider("").authenticate({ headers: {} })).user.login, "dev", "DEV_USER VIDE → login de défaut (comportement historique)");

    // Rien n'est présenté, donc rien ne peut être refusé : ce provider ne rend JAMAIS null.
    ck(await provider.authenticate({ headers: { authorization: "Basic n'importe quoi" } }) !== null, "en-têtes ignorés : jamais anonyme");
    const a = await provider.authenticate({ headers: {} }), b = await provider.authenticate({ headers: {} });
    ck(a !== b, "objet NEUF à chaque appel (la session est posée sur la requête — une constante partagée se ferait contaminer)");
    ck.eq(typeof provider.sessionKey, "undefined", "aucune `sessionKey` → l'orchestrateur ne met JAMAIS le mode dev en cache");
  });

  /* ==========================================================================
     2. BasicAuthProvider
     ========================================================================== */
  await section("Serveur : auth — BasicAuthProvider (fromSpec = inférence de mode, décodage de l'en-tête, refus, NON-FUITE par court-circuit)", async () => {
    const { BasicAuthProvider } = SERVER("auth/BasicAuthProvider.js");

    // -- fromSpec : « la valeur ne décrit pas un couple » et « pas de mode basic » sont la MÊME réponse. --
    ck.eq(BasicAuthProvider.fromSpec(null), null, "BASIC_AUTH absent → null (pas de mode basic)");
    ck.eq(BasicAuthProvider.fromSpec(undefined), null, "BASIC_AUTH undefined → null");
    ck.eq(BasicAuthProvider.fromSpec(""), null, "BASIC_AUTH vide → null");
    ck.eq(BasicAuthProvider.fromSpec("   "), null, "BASIC_AUTH blanche → null");
    ck.eq(BasicAuthProvider.fromSpec("sansdeuxpoints"), null, "BASIC_AUTH sans deux-points → null (inférence historique)");

    const provider = BasicAuthProvider.fromSpec("  expl:mot:de:passe  ");
    ck.eq(provider.login, "expl", "fromSpec : espaces autour tolérés, login = avant le PREMIER deux-points");
    ck(provider.accepts(basicHeader("expl", "mot:de:passe")), "…et le mot de passe conserve ses propres deux-points");

    // -- Refus : chaque forme d'en-tête invalide, sans jamais lever. --
    ck.eq(provider.accepts({ headers: {} }), false, "Authorization absent → refus");
    ck.eq(provider.accepts({ headers: { authorization: "" } }), false, "Authorization vide → refus");
    ck.eq(provider.accepts({ headers: { authorization: "Bearer xyz" } }), false, "schéma non Basic → refus");
    ck.eq(provider.accepts({ headers: { authorization: "Basic" } }), false, "« Basic » sans charge → refus");
    ck.eq(provider.accepts({ headers: { authorization: "Basic  ###pas-du-base64###" } }), false, "base64 invalide → refus (jamais d'exception)");
    ck.eq(provider.accepts(basicHeader("expl", "faux")), false, "mot de passe faux → refus");
    ck.eq(provider.accepts(basicHeader("autre", "mot:de:passe")), false, "utilisateur faux → refus");
    ck.eq(provider.accepts({ headers: { authorization: "basic " + Buffer.from("expl:mot:de:passe").toString("base64") } }), true, "schéma insensible à la casse (RFC 7617)");

    // Charge SANS deux-points → mot de passe vide comparé (et accepté seulement si le secret est vide).
    const emptyPass = BasicAuthProvider.fromSpec("u:");
    ck.eq(emptyPass.accepts({ headers: { authorization: "Basic " + Buffer.from("u").toString("base64") } }), true, "charge sans deux-points → mot de passe vide, comparé quand même");
    ck.eq(emptyPass.accepts(basicHeader("u", "x")), false, "…et un mot de passe fourni ne passe pas contre un secret vide");

    // -- 🚨 NON-FUITE par court-circuit. Les deux comparaisons à temps constant sont évaluées AVANT le
    // `&&` : sans cela, le temps de réponse distinguerait « login faux » (une comparaison) de « mot de
    // passe faux » (deux), ce qui livre le login à l'attaquant. On le PROUVE en comptant les hachages
    // (2 par comparaison), plutôt qu'en faisant confiance au commentaire du code.
    const crypto = require("node:crypto");
    const realCreateHash = crypto.createHash;
    let hashCalls = 0;
    const counting = (...args) => { hashCalls++; return realCreateHash.apply(crypto, args); };
    let patched = false;
    try { crypto.createHash = counting; patched = crypto.createHash === counting; } catch (_) { patched = false; }
    if (!patched) { ck(true, "createHash non instrumentable dans cet environnement → contrôle de non-fuite sauté"); }
    else {
      try {
        hashCalls = 0; provider.accepts(basicHeader("MAUVAIS", "mot:de:passe"));
        ck.eq(hashCalls, 4, "login FAUX → les DEUX comparaisons sont tout de même évaluées (4 hachages)");
        hashCalls = 0; provider.accepts(basicHeader("expl", "MAUVAIS"));
        ck.eq(hashCalls, 4, "mot de passe faux → 4 hachages AUSSI : les deux cas sont indiscernables au chrono");
        hashCalls = 0; provider.accepts(basicHeader("expl", "mot:de:passe"));
        ck.eq(hashCalls, 4, "succès → 4 hachages également");
        hashCalls = 0; provider.accepts({ headers: {} });
        ck.eq(hashCalls, 0, "en-tête absent → aucun hachage (rien à comparer, et rien à divulguer)");
      } finally { crypto.createHash = realCreateHash; }
    }

    // -- authenticate : la session, ou `null` (anonyme). --
    ck.eq(await provider.authenticate({ headers: {} }), null, "identifiants absents → null (anonyme)");
    ck.eq(await provider.authenticate(basicHeader("expl", "faux")), null, "identifiants faux → null (anonyme)");
    const session = await provider.authenticate(basicHeader("expl", "mot:de:passe"));
    ck.eq(session.user.login, "expl", "identifiants bons → session au login configuré");
    ck.eq(session.logged, true, "…authentifiée");
    ck.eq(session.adminRight, "SUPER_ADMIN", "…SUPER_ADMIN (rétrocompat)");
    ck.eq(session.dev, true, "…et marquée `dev` : le secret est dans l'environnement du serveur, pas dans une personne");

    const anonymousLogin = BasicAuthProvider.fromSpec(":secret");
    ck.eq(anonymousLogin.login, "", "BASIC_AUTH « :secret » → login attendu VIDE (mode basic tout de même)");
    ck.eq((await anonymousLogin.authenticate(basicHeader("", "secret"))).user.login, "dev", "…session au login de repli « dev » (comportement historique)");
    ck.eq(BasicAuthProvider.FALLBACK_LOGIN, "dev", "…repli nommé sur la classe");

    ck.eq(typeof provider.sessionKey, "undefined", "aucune `sessionKey` → le mode basic n'est JAMAIS mis en cache (il répond de mémoire)");
  });

  /* ==========================================================================
     3. LegacySsoAuthProvider
     ========================================================================== */
  await section("Serveur : auth — LegacySsoAuthProvider (jeton : cookie nommé/complet/absent/échappé ; PASSTHROUGH du JSON ; SSO en erreur ou injoignable → anonyme ; jeton jamais journalisé)", async () => {
    const { LegacySsoAuthProvider } = SERVER("auth/LegacySsoAuthProvider.js");
    const { ANONYMOUS_SESSION } = SERVER("auth/AuthProvider.js");
    const log = makeLog();
    const idle = makeFetch(() => jsonOk({ logged: false }));

    // -- Session anonyme PARTAGÉE (une seule définition dans tout le service). --
    ck.eq(ANONYMOUS_SESSION.logged, false, "session anonyme : non authentifiée");
    ck.eq(ANONYMOUS_SESSION.adminRight, "NONE", "session anonyme : adminRight NONE");
    ck.eq(ANONYMOUS_SESSION.user.login, "anonymous", "session anonyme : login « anonymous »");
    ck.eq(ANONYMOUS_SESSION.user.domain, "anonymous", "session anonyme : domaine « anonymous »");

    // -- JETON = clé de session présentée (l'ancien `tokenOf`). --
    const named = new LegacySsoAuthProvider(log, "https://sso.test/valider", "jetonko", idle);
    ck.eq(named.sessionKey({ headers: { cookie: "a=1; jetonko=XYZ; b=2" } }), "XYZ", "cookie NOMMÉ extrait au milieu de l'en-tête");
    ck.eq(named.sessionKey({ headers: { cookie: "jetonko=XYZ" } }), "XYZ", "cookie nommé seul");
    ck.eq(named.sessionKey({ headers: { cookie: "jetonko=a%20b" } }), "a b", "valeur URL-décodée");
    ck.eq(named.sessionKey({ headers: { cookie: "pasledon=XYZ" } }), null, "cookie attendu absent → null");
    ck.eq(named.sessionKey({ headers: {} }), null, "aucun en-tête Cookie → null");
    ck.eq(named.sessionKey({ headers: { cookie: "xjetonko=NON" } }), null, "un cookie dont le nom TERMINE par le nôtre ne compte pas (ancrage début/« ; »)");
    ck.eq(named.sessionKey({ headers: { cookie: "jetonko=" } }), "", "cookie présent mais VIDE → chaîne vide (l'orchestrateur la traite comme « rien de présenté »)");

    // Nom de cookie à MÉTACARACTÈRE : il entre dans une expression régulière, donc il est échappé.
    const dotted = new LegacySsoAuthProvider(log, "https://sso.test/valider", "a.b", idle);
    ck.eq(dotted.sessionKey({ headers: { cookie: "a.b=OK" } }), "OK", "nom « a.b » : le point est LITTÉRAL");
    ck.eq(dotted.sessionKey({ headers: { cookie: "axb=NON" } }), null, "…et n'est PAS un joker (nom échappé)");

    // Aucun nom configuré → l'en-tête Cookie COMPLET est le jeton (proxifié tel quel).
    const whole = new LegacySsoAuthProvider(log, "https://sso.test/valider", "", idle);
    ck.eq(whole.sessionKey({ headers: { cookie: "a=1; b=2" } }), "a=1; b=2", "COOKIE_NAME vide → en-tête Cookie complet");
    ck.eq(whole.sessionKey({ headers: { cookie: "" } }), null, "…en-tête vide → null");
    ck.eq(whole.sessionKey({ headers: {} }), null, "…en-tête absent → null");

    // -- PASSTHROUGH : le JSON du SSO traverse INTACT, champs inconnus compris. --
    const payload = {
      logged: true, adminRight: "SUPER_ADMIN", expireDate: 4102444800000,
      user: { id: 4242, login: "amartin", nom: "Martin", prenom: "Alice", eMail: "alice@corp.tld", domain: "corp" },
      groups: ["infra", "noc"], serviceTag: "sso-maison-v1", extras: { site: "LLN", niveau: 3 },
    };
    const logOk = makeLog();
    const fetchOk = makeFetch(() => jsonOk(payload));
    const result = await new LegacySsoAuthProvider(logOk, "https://sso.test/valider", "jetonko", fetchOk).authenticate({ headers: { cookie: "jetonko=BON" } });
    ck.eq(JSON.stringify(result), JSON.stringify(payload), "PASSTHROUGH : réponse rendue TELLE QUELLE (champs inconnus `serviceTag`/`extras` conservés)");
    ck.eq(JSON.stringify(result.groups), JSON.stringify(["infra", "noc"]), "…y compris `groups`, que la politique de rôles consommera (lot 4) sans changer ce contrat");
    ck.eq(fetchOk.calls.length, 1, "un appel sortant");
    ck.eq(fetchOk.calls[0].url, "https://sso.test/valider", "…vers SSO_URL");
    ck.eq(fetchOk.calls[0].headers.cookie, "jetonko=BON", "…avec le cookie RECONSTITUÉ (nom=valeur) attendu par le SSO");
    ck.eq(fetchOk.calls[0].headers.accept, "application/json", "…et un Accept explicite");
    ck(logOk.lines.some((l) => l === "debug SSO validé amartin logged=true right=SUPER_ADMIN"), "trace de validation (debug) : login, état, droit");

    const fetchWhole = makeFetch(() => jsonOk(payload));
    await new LegacySsoAuthProvider(log, "https://sso.test/valider", "", fetchWhole).authenticate({ headers: { cookie: "a=1; b=2" } });
    ck.eq(fetchWhole.calls[0].headers.cookie, "a=1; b=2", "COOKIE_NAME vide → l'en-tête Cookie est proxifié TEL QUEL");

    // -- Aucun jeton → anonyme SANS appel sortant (il n'y a rien à valider). --
    const fetchNever = makeFetch(() => jsonOk(payload));
    ck.eq(await new LegacySsoAuthProvider(log, "https://sso.test/valider", "jetonko", fetchNever).authenticate({ headers: {} }), null, "aucun jeton → null (anonyme)");
    ck.eq(fetchNever.calls.length, 0, "…et AUCUN appel au SSO");

    // -- FAIL-CLOSED : HTTP en erreur → anonyme + WARN nommant le code. --
    const logHttp = makeLog();
    const failed = await new LegacySsoAuthProvider(logHttp, "https://sso.test/valider", "jetonko", makeFetch(() => httpFail(500))).authenticate({ headers: { cookie: "jetonko=X" } });
    ck(failed === ANONYMOUS_SESSION, "SSO en erreur HTTP → la session anonyme PARTAGÉE (aucune seconde définition)");
    ck(logHttp.lines.some((l) => l === "warn SSO HTTP 500"), "…et un WARN nommant le code HTTP");

    // -- FAIL-CLOSED : injoignable (exception) → anonyme + ERROR nommant l'URL, JAMAIS le jeton. --
    const logDown = makeLog();
    const throwing = async () => { throw new Error("ECONNREFUSED 127.0.0.1:443"); };
    const down = await new LegacySsoAuthProvider(logDown, "https://sso.test/valider", "jetonko", throwing).authenticate({ headers: { cookie: "jetonko=SECRET-DE-SESSION" } });
    ck(down === ANONYMOUS_SESSION, "SSO injoignable → session anonyme");
    ck(logDown.lines.some((l) => /^error SSO injoignable https:\/\/sso\.test\/valider ECONNREFUSED/.test(l)), "…ERROR nommant l'URL et la cause");
    ck(!logDown.lines.join("|").includes("SECRET-DE-SESSION"), "🚨 le JETON n'apparaît dans AUCUN log (c'est un secret de session)");

    // -- FAIL-CLOSED : réponse qui n'est pas un objet → anonyme. --
    const notObject = await new LegacySsoAuthProvider(log, "https://sso.test/valider", "jetonko", makeFetch(() => jsonOk("pas un objet"))).authenticate({ headers: { cookie: "jetonko=X" } });
    ck(notObject === ANONYMOUS_SESSION, "réponse non-objet → session anonyme");
    const nullBody = await new LegacySsoAuthProvider(log, "https://sso.test/valider", "jetonko", makeFetch(() => jsonOk(null))).authenticate({ headers: { cookie: "jetonko=X" } });
    ck(nullBody === ANONYMOUS_SESSION, "réponse `null` → session anonyme");
  });

  /* ==========================================================================
     4. Auth — l'ORCHESTRATEUR
     ========================================================================== */
  await section("Serveur : auth — Auth orchestrateur (inférence de mode, annonce de boot, checkBasic du gate, cache par hash de jeton, capture d'annuaire)", async () => {
    const { Auth } = SERVER("auth.js");
    const log = makeLog();

    // -- SÉLECTION du provider : l'inférence historique, à l'identique. --
    ck.eq(new Auth(log, {}).mode, "dev", "ni SSO_URL ni BASIC_AUTH → mode dev (défaut)");
    ck.eq(new Auth(log, {}).mode, new Auth(log).mode, "options absentes = options vides");
    ck.eq(new Auth(log, { ssoUrl: "https://sso.test/v" }).mode, "sso", "SSO_URL → mode sso");
    ck.eq(new Auth(log, { ssoUrl: "   " }).mode, "dev", "SSO_URL blanche → mode dev");
    ck.eq(new Auth(log, { basicAuth: "u:p" }).mode, "basic", "BASIC_AUTH → mode basic");
    ck.eq(new Auth(log, { basicAuth: "u:p", ssoUrl: "https://sso.test/v" }).mode, "basic", "les deux configurés → basic PRIORITAIRE sur sso");
    ck.eq(new Auth(log, { basicAuth: "sansdeuxpoints", ssoUrl: "https://sso.test/v" }).mode, "sso", "BASIC_AUTH malformé → ignoré, on retombe sur le sso");
    ck.eq(new Auth(log, { basicAuth: ":motdepasse" }).mode, "basic", "BASIC_AUTH sans utilisateur → mode basic tout de même");

    // Le champ `mode` reste EXPOSÉ : `server.ts` monte le gate de transport dessus.
    ck.eq(typeof new Auth(log, {}).mode, "string", "`mode` exposé (le gate basic de server.ts s'y accroche)");
    // Retrait acté du lot 3 : l'autorisation vit dans access/, ce prédicat n'avait plus d'appelant.
    ck.eq(typeof new Auth(log, {}).isAuthorized, "undefined", "`isAuthorized` RETIRÉ (l'autorisation est le métier d'AccessControl)");

    // -- ANNONCE de boot : le mode dev est CRIÉ, les autres sont décrits. --
    const logDev = makeLog(); new Auth(logDev, {});
    ck(logDev.lines.some((l) => /^warn auth ⚠ mode DEV : AUCUNE authentification/.test(l)), "boot dev → WARN visible (un déploiement réel démarré ainsi serait grand ouvert)");
    const logBasic = makeLog(); new Auth(logBasic, { basicAuth: "expl:s" });
    ck(logBasic.lines.some((l) => l === "info auth Basic Auth dev (user expl)"), "boot basic → INFO nommant l'utilisateur");
    const logSso = makeLog(); new Auth(logSso, { ssoUrl: "https://sso.test/v", cookieName: "jetonko" });
    ck(logSso.lines.some((l) => l === "info auth SSO https://sso.test/v (cookie jetonko)"), "boot sso → INFO nommant l'URL et le cookie");
    const logSsoWhole = makeLog(); new Auth(logSsoWhole, { ssoUrl: "https://sso.test/v" });
    ck(logSsoWhole.lines.some((l) => l === "info auth SSO https://sso.test/v (Cookie complet)"), "boot sso sans COOKIE_NAME → INFO « Cookie complet »");

    // -- checkBasic : le GATE DE TRANSPORT, pas une identification. --
    ck.eq(new Auth(log, {}).checkBasic({ headers: {} }), true, "hors mode basic → checkBasic ne s'oppose à rien (aucun challenge à opposer)");
    ck.eq(new Auth(log, { ssoUrl: "https://sso.test/v" }).checkBasic({ headers: {} }), true, "…mode sso compris");
    const gated = new Auth(log, { basicAuth: "expl:s" });
    ck.eq(gated.checkBasic({ headers: {} }), false, "mode basic sans en-tête → le gate challenge");
    ck.eq(gated.checkBasic(basicHeader("expl", "faux")), false, "mode basic, mauvais secret → le gate challenge");
    ck.eq(gated.checkBasic(basicHeader("expl", "s")), true, "mode basic, bons identifiants → passe");

    // -- validate : dev et basic. --
    const devSession = await new Auth(log, {}).validate({ headers: {} });
    ck(devSession.logged === true && devSession.adminRight === "SUPER_ADMIN" && devSession.dev === true && devSession.user.login === "dev", "validate dev → session factice SUPER_ADMIN");
    const refused = await new Auth(log, { basicAuth: "expl:s" }).validate({ headers: {} });
    ck(refused.logged === false && refused.adminRight === "NONE" && refused.user.login === "anonymous", "validate basic refusé → session ANONYME (le `null` du provider y est substitué)");
    ck.eq((await new Auth(log, { basicAuth: "expl:s" }).validate(basicHeader("expl", "s"))).user.login, "expl", "validate basic accepté → session au login configuré");

    // -- CACHE par hash de jeton : réservé au sso (seul provider à nommer la session présentée). --
    const loggedPayload = () => jsonOk({ logged: true, adminRight: "SUPER_ADMIN", expireDate: Date.now() + 3_600_000, user: { id: 1, login: "amartin" } });
    const fetchCached = makeFetch(loggedPayload);
    const ssoAuth = new Auth(log, { ssoUrl: "https://sso.test/v", cookieName: "k", ssoFetch: fetchCached });
    await ssoAuth.validate({ headers: { cookie: "k=T1" } });
    await ssoAuth.validate({ headers: { cookie: "k=T1" } });
    ck.eq(fetchCached.calls.length, 1, "deux requêtes, MÊME jeton → UN seul appel SSO (cache)");
    await ssoAuth.validate({ headers: { cookie: "k=T2" } });
    ck.eq(fetchCached.calls.length, 2, "jeton DIFFÉRENT → nouvel appel (la clé est le jeton, pas l'utilisateur)");
    await ssoAuth.validate({ headers: {} });
    ck.eq(fetchCached.calls.length, 2, "aucun cookie → anonyme SANS appel sortant");

    // Expiration : `expireDate` dépassée → re-validation.
    const fetchShort = makeFetch(() => jsonOk({ logged: true, adminRight: "SUPER_ADMIN", expireDate: Date.now() + 30, user: { login: "amartin" } }));
    const expiring = new Auth(log, { ssoUrl: "https://sso.test/v", cookieName: "k", ssoFetch: fetchShort });
    await expiring.validate({ headers: { cookie: "k=T" } });
    await expiring.validate({ headers: { cookie: "k=T" } });
    ck.eq(fetchShort.calls.length, 1, "avant expiration → cache");
    await new Promise((r) => setTimeout(r, 150));
    await expiring.validate({ headers: { cookie: "k=T" } });
    ck.eq(fetchShort.calls.length, 2, "après `expireDate` → re-validation auprès du SSO");

    // Résultat NON loggé → cache COURT (mais cache : on ne martèle pas un SSO en difficulté).
    const fetchAnon = makeFetch(() => httpFail(503));
    const failing = new Auth(log, { ssoUrl: "https://sso.test/v", cookieName: "k", ssoFetch: fetchAnon });
    await failing.validate({ headers: { cookie: "k=T" } });
    await failing.validate({ headers: { cookie: "k=T" } });
    ck.eq(fetchAnon.calls.length, 1, "session non authentifiée mise en cache COURT (1 min) — pas d'appel par requête HTTP");

    // -- CAPTURE d'annuaire : invariant « jamais un non-loggé », et jamais deux fois sur un hit de cache. --
    const sinkOf = () => ({ seen: [], remember(u) { this.seen.push((u && u.login) || ""); } });

    const devSink = sinkOf();
    const devAuth = new Auth(log, {}, devSink);
    await devAuth.validate({ headers: {} });
    await devAuth.validate({ headers: {} });
    ck.eq(devSink.seen.length, 2, "mode dev : AUCUN cache → chaque validation re-capture (rien à économiser, rien à retarder)");

    const ssoSink = sinkOf();
    const cachedSso = new Auth(log, { ssoUrl: "https://sso.test/v", cookieName: "k", ssoFetch: makeFetch(loggedPayload) }, ssoSink);
    await cachedSso.validate({ headers: { cookie: "k=T" } });
    await cachedSso.validate({ headers: { cookie: "k=T" } });
    ck.eq(ssoSink.seen.length, 1, "mode sso : capture SEULEMENT sur défaut de cache (le hit a déjà remonté ce profil)");
    ck.eq(ssoSink.seen[0], "amartin", "…et c'est bien le profil du SSO qui alimente l'annuaire");

    const anonSink = sinkOf();
    await new Auth(log, { ssoUrl: "https://sso.test/v", cookieName: "k", ssoFetch: makeFetch(() => httpFail(503)) }, anonSink).validate({ headers: { cookie: "k=T" } });
    ck.eq(anonSink.seen.length, 0, "🚨 INVARIANT : un profil NON loggé n'entre JAMAIS dans l'annuaire (SSO en panne)");
    const noCookieSink = sinkOf();
    await new Auth(log, { ssoUrl: "https://sso.test/v", cookieName: "k", ssoFetch: makeFetch(loggedPayload) }, noCookieSink).validate({ headers: {} });
    ck.eq(noCookieSink.seen.length, 0, "…ni un appelant anonyme (aucun cookie)");
    const badBasicSink = sinkOf();
    await new Auth(log, { basicAuth: "expl:s" }, badBasicSink).validate({ headers: {} });
    ck.eq(badBasicSink.seen.length, 0, "…ni un échec d'authentification basic");
    const okBasicSink = sinkOf();
    await new Auth(log, { basicAuth: "expl:s" }, okBasicSink).validate(basicHeader("expl", "s"));
    ck.eq(okBasicSink.seen.join(","), "expl", "…tandis qu'une authentification basic RÉUSSIE est capturée");
    // Puits ABSENT : la capture est optionnelle, rien ne doit lever.
    ck((await new Auth(log, {}).validate({ headers: {} })).logged === true, "aucun puits injecté → validation inchangée (capture optionnelle)");
  });
};
