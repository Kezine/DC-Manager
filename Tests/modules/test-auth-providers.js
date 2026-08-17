/* Tests modules — AUTHENTIFICATION : orchestrateur + providers (lots 3 et 4 du chantier auth/ACL).

   Sept sections, une par classe, dans l'ordre de la découpe :
   1. `auth/DevAuthProvider` — l'identité factice du mode par défaut (et le fait qu'elle ne
      présente AUCUNE clé de session, donc n'est jamais mise en cache) ;
   2. `auth/BasicAuthProvider` — l'analyse de `BASIC_AUTH` (qui EST l'inférence de mode), le
      décodage de l'en-tête, et la NON-FUITE par court-circuit (les deux comparaisons à temps
      constant sont évaluées même quand la première a déjà échoué — vérifié en COMPTANT les
      hachages, pas en relisant le commentaire) ;
   3. `auth/LegacySsoAuthProvider` — extraction du jeton (cookie nommé / en-tête complet / absent /
      nom à métacaractères), PASSTHROUGH intégral du JSON, replis fail-closed d'un SSO en erreur ou
      injoignable, et l'invariant « le jeton n'apparaît jamais dans un log » ;
   4. `auth/SecretCompare` — le helper de comparaison à TEMPS CONSTANT, sorti du provider basic
      quand le mode forward lui a donné un second consommateur ;
   5. `auth/AuthModeResolution` — la décision de CONFIGURATION : inférence historique quand
      `AUTH_MODE` est absente, mode explicite quand elle est là, et 🚨 REFUS (mode `null`) sur
      valeur inconnue/incohérente — jamais de repli sur le mode dev, qui n'authentifie personne ;
   6. `auth/ForwardHeaderAuthProvider` — l'identité lue dans les en-têtes d'un reverse-proxy
      *identity-aware* : en-têtes configurables, groupes, `string[]`, et surtout le SECRET PARTAGÉ
      (mauvais secret ⇒ anonyme SANS lire le moindre autre en-tête — PROUVÉ en comptant les
      lectures, pas en relisant le commentaire) ;
   7. `auth.ts` (`Auth`) — l'ORCHESTRATEUR : sélection du provider (inférence inchangée + modes
      explicites), refus de construction sur configuration douteuse, annonce de boot (dont le WARN
      « forward sans secret »), `checkBasic` du gate de transport, cache par hash de jeton (réservé
      au SSO) et capture d'annuaire (jamais un non-loggé).

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

/** En-têtes ESPIONNÉS : mémorise CHAQUE nom d'en-tête réellement lu par le provider.
    Sert la preuve la plus importante du mode forward — « secret faux ⇒ on ne lit RIEN d'autre » est
    une propriété de sécurité, pas un commentaire : on la vérifie en observant les accès, comme la
    non-fuite du mode basic se vérifie en comptant les hachages. */
const spyHeaders = (values) => {
  const reads = [];
  const headers = new Proxy(Object.assign({}, values), {
    get(target, key) { if (typeof key === "string") reads.push(key); return target[key]; },
  });
  return { reads, headers };
};

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
     4. SecretCompare — le helper de comparaison à temps constant
     ========================================================================== */
  await section("Serveur : auth — SecretCompare (temps constant : égalité, divergence, longueurs différentes, vide)", async () => {
    const { SecretCompare } = SERVER("auth/SecretCompare.js");

    ck(SecretCompare.equals("s3cret-partage", "s3cret-partage"), "chaînes identiques → vrai");
    ck(!SecretCompare.equals("s3cret-partage", "s3cret-partagE"), "un seul caractère de différence → faux");
    ck(!SecretCompare.equals("s3cret-partage", "s3cret-partage "), "espace en trop → faux (aucune tolérance sur un secret)");
    // Le hachage préalable existe POUR ce cas : `timingSafeEqual` jette sur deux buffers de tailles
    // différentes, et comparer les chaînes brutes ferait fuiter la LONGUEUR du secret par la durée.
    ck(!SecretCompare.equals("court", "beaucoup-plus-long-que-l-autre"), "longueurs DIFFÉRENTES → faux, sans exception (le SHA-256 égalise les tailles)");
    ck(SecretCompare.equals("", ""), "deux vides → vrai (« pas de secret configuré » est une décision de l'appelant, pas d'ici)");
    ck(!SecretCompare.equals("", "s3cret"), "vide contre secret → faux (c'est le cas de l'en-tête ABSENT côté forward)");
    ck(SecretCompare.equals("clé-é⚡", "clé-é⚡"), "unicode : comparaison sur les octets UTF-8, sans surprise");

    // Coût CONSTANT : exactement 2 hachages par comparaison, quel que soit le résultat.
    const crypto = require("node:crypto");
    const realCreateHash = crypto.createHash;
    let hashCalls = 0;
    const counting = (...args) => { hashCalls++; return realCreateHash.apply(crypto, args); };
    let patched = false;
    try { crypto.createHash = counting; patched = crypto.createHash === counting; } catch (_) { patched = false; }
    if (!patched) { ck(true, "createHash non instrumentable dans cet environnement → contrôle du coût sauté"); }
    else {
      try {
        hashCalls = 0; SecretCompare.equals("a", "a");
        ck.eq(hashCalls, 2, "égalité → 2 hachages (un par opérande)");
        hashCalls = 0; SecretCompare.equals("a", "zzzzzzzzzzzz");
        ck.eq(hashCalls, 2, "divergence dès le 1er caractère → 2 hachages AUSSI (aucun court-circuit)");
      } finally { crypto.createHash = realCreateHash; }
    }
  });

  /* ==========================================================================
     5. AuthModeResolution — la décision de configuration
     ========================================================================== */
  await section("Serveur : auth — AuthModeResolution (AUTH_MODE absente → inférence historique ; explicite → fait loi ; 🚨 inconnue/incohérente → REFUS sans repli dev)", async () => {
    const { AuthModeResolution } = SERVER("auth/AuthModeResolution.js");
    const decide = (over) => AuthModeResolution.resolve(over || {});

    // -- Constantes exposées (citées par les messages et la doc). --
    ck.eq(AuthModeResolution.ENV_VAR, "AUTH_MODE", "nom de la variable d'environnement");
    ck.eq([...AuthModeResolution.MODES].join(","), "dev,basic,sso,forward", "modes servis aujourd'hui");
    ck.eq([...AuthModeResolution.PLANNED_MODES].join(","), "oidc", "modes PRÉVUS mais pas encore servis (message distinct d'une coquille)");

    // -- ABSENTE : l'inférence historique, à l'identique (basic > sso > dev). --
    ck.eq(decide().mode, "dev", "rien de configuré → dev (défaut historique)");
    ck.eq(decide().error, null, "…et aucune erreur : c'est un mode légitime, le WARN de l'orchestrateur suffit");
    ck.eq(decide({ hasSsoUrl: true }).mode, "sso", "SSO_URL seule → sso");
    ck.eq(decide({ hasBasicCredentials: true }).mode, "basic", "BASIC_AUTH seule → basic");
    ck.eq(decide({ hasBasicCredentials: true, hasSsoUrl: true }).mode, "basic", "les deux → basic PRIORITAIRE (inférence inchangée au bit près)");
    ck.eq(decide({ authMode: "" }).mode, "dev", "AUTH_MODE vide = absente");
    ck.eq(decide({ authMode: "   " }).mode, "dev", "AUTH_MODE blanche = absente");
    ck.eq(decide({ authMode: null, hasSsoUrl: true }).mode, "sso", "AUTH_MODE nulle = absente (inférence)");
    ck.eq(AuthModeResolution.resolve().mode, "dev", "aucun argument = aucun fait configuré");

    // -- EXPLICITE : elle fait loi, l'inférence ne s'applique plus. --
    ck.eq(decide({ authMode: "dev", hasBasicCredentials: true, hasSsoUrl: true }).mode, "dev",
      "AUTH_MODE=dev explicite → dev MALGRÉ BASIC_AUTH et SSO_URL (le choix écrit fait loi)");
    ck.eq(decide({ authMode: "basic", hasBasicCredentials: true, hasSsoUrl: true }).mode, "basic", "AUTH_MODE=basic honorée");
    ck.eq(decide({ authMode: "sso", hasBasicCredentials: true, hasSsoUrl: true }).mode, "sso",
      "AUTH_MODE=sso l'emporte sur BASIC_AUTH — l'INVERSE de l'inférence, et c'est bien le but d'une variable explicite");
    ck.eq(decide({ authMode: "forward" }).mode, "forward", "AUTH_MODE=forward → forward (aucune autre variable requise : les en-têtes ont des défauts)");
    ck.eq(decide({ authMode: " Forward " }).mode, "forward", "rognage + casse tolérés (une variable recopiée traîne un blanc ; le mode reste EXPLICITE)");
    ck.eq(decide({ authMode: "FORWARD" }).error, null, "…et sans avertissement : tolérer la casse n'ouvre rien");

    // -- 🚨 REFUS. Le point capital : `mode: null`, et JAMAIS « dev » — une coquille qui retomberait
    // en silence sur un mode qui n'authentifie personne ouvrirait l'instance (anti fail-open).
    const refused = [
      ["frobnique", "valeur inconnue", { authMode: "frobnique" }],
      ["forwrad", "coquille sur un mode réel", { authMode: "forwrad" }],
      ["oidc", "mode prévu, pas encore implémenté", { authMode: "oidc" }],
      ["sso", "sso sans SSO_URL", { authMode: "sso" }],
      ["basic", "basic sans BASIC_AUTH exploitable", { authMode: "basic" }],
    ];
    for (const [label, why, input] of refused) {
      const decision = decide(input);
      ck.eq(decision.mode, null, "REFUS (" + why + ") : aucun mode — « " + label + " »");
      ck(typeof decision.error === "string" && decision.error.length > 20, "REFUS (" + why + ") : un motif est donné");
      ck(decision.error.includes("AUTH_MODE"), "REFUS (" + why + ") : le message NOMME la variable fautive");
    }
    ck(decide({ authMode: "oidc" }).error.includes("pas encore implémenté"), "message : « oidc » est annoncé comme À VENIR, pas comme une faute de frappe");
    ck(decide({ authMode: "frobnique" }).error.includes("inconnue"), "message : une valeur hors liste est annoncée comme inconnue");
    ck(decide({ authMode: "frobnique" }).error.includes("dev, basic, sso, forward"), "message : les valeurs admises sont ÉNUMÉRÉES (message actionnable)");
    ck(decide({ authMode: "sso" }).error.includes("SSO_URL"), "message : la variable MANQUANTE est nommée (sso)");
    ck(decide({ authMode: "basic" }).error.includes("BASIC_AUTH"), "message : la variable MANQUANTE est nommée (basic)");
    ck(decide({ authMode: "frobnique" }).error.includes("Aucun repli sur le mode dev"), "message : la DOCTRINE est rappelée (sinon on « retire juste la variable »)");
    // Et surtout : une coquille NE profite PAS de l'inférence, même quand elle aurait de quoi.
    ck.eq(decide({ authMode: "frobnique", hasBasicCredentials: true, hasSsoUrl: true }).mode, null,
      "🚨 coquille + configuration complète → REFUS quand même (aucune retombée silencieuse sur l'inférence)");
  });

  /* ==========================================================================
     6. ForwardHeaderAuthProvider
     ========================================================================== */
  await section("Serveur : auth — ForwardHeaderAuthProvider (en-têtes configurables, groupes, string[], 🚨 secret partagé à temps constant : faux secret ⇒ AUCUN autre en-tête lu)", async () => {
    const { ForwardHeaderAuthProvider } = SERVER("auth/ForwardHeaderAuthProvider.js");
    const provider = new ForwardHeaderAuthProvider();

    // -- Défauts : la famille Remote-* (Authelia/Authentik). --
    ck.eq(provider.userHeader, "Remote-User", "défaut : en-tête utilisateur");
    ck.eq(provider.emailHeader, "Remote-Email", "défaut : en-tête e-mail");
    ck.eq(provider.nameHeader, "Remote-Name", "défaut : en-tête nom d'affichage");
    ck.eq(provider.groupsHeader, "Remote-Groups", "défaut : en-tête groupes");
    ck.eq(provider.secretHeader, "X-Auth-Secret", "défaut : en-tête du secret partagé");
    ck.eq(provider.secretConfigured, false, "aucun secret configuré par défaut (le boot le signale en WARN)");
    ck.eq(new ForwardHeaderAuthProvider({ userHeader: "   " }).userHeader, "Remote-User", "nom d'en-tête blanc → défaut (tolérance de forme)");
    ck.eq(new ForwardHeaderAuthProvider({ userHeader: " X-Forwarded-User " }).userHeader, "X-Forwarded-User", "nom d'en-tête rogné");

    // -- SESSION produite. Node met les noms d'en-têtes en minuscules : c'est la forme réelle. --
    const full = await provider.authenticate({ headers: {
      "remote-user": "amartin", "remote-email": "alice@corp.tld", "remote-name": "Alice Martin", "remote-groups": "infra,noc",
    } });
    ck.eq(full.logged, true, "utilisateur présent → session AUTHENTIFIÉE");
    ck.eq(full.user.login, "amartin", "…login = en-tête utilisateur");
    ck.eq(full.user.eMail, "alice@corp.tld", "…e-mail repris");
    ck.eq(full.user.nom, "Alice Martin", "…nom COMPLET tel quel (un proxy ne fournit qu'un libellé d'affichage)");
    ck.eq(full.user.prenom, undefined, "…`prenom` ABSENT : découper à l'espace inventerait une structure fausse (noms composés)");
    ck.eq(full.user.domain, "forward", "…domaine « forward » (d'où vient l'identité, en un mot)");
    ck.eq(ForwardHeaderAuthProvider.DOMAIN, "forward", "…et ce domaine est nommé sur la classe");
    ck.eq(JSON.stringify(full.groups), '["infra","noc"]', "…groupes découpés sur la virgule, dans l'ordre du proxy");
    ck.eq(full.adminRight, undefined, "🚨 AUCUN adminRight : l'autorisation passe par les RÔLES (sinon tout utilisateur du proxy serait administrateur)");
    ck.eq(full.dev, undefined, "aucun marqueur `dev` : ce mode authentifie réellement (via le proxy)");
    ck.eq(full.expireDate, undefined, "aucune `expireDate` : la session appartient au proxy — annoncer une échéance qu'on ne tient pas serait mentir");
    ck.eq(typeof provider.sessionKey, "undefined", "aucune `sessionKey` → jamais mis en cache (lire des en-têtes ne coûte aucune E/S)");

    // -- Utilisateur REQUIS : pas d'en-tête, pas d'identité (jamais d'utilisateur par défaut). --
    ck.eq(await provider.authenticate({ headers: {} }), null, "aucun en-tête → null (anonyme)");
    ck.eq(await provider.authenticate({ headers: { "remote-user": "" } }), null, "en-tête utilisateur VIDE → null");
    ck.eq(await provider.authenticate({ headers: { "remote-user": "   " } }), null, "en-tête utilisateur blanc → null");
    ck.eq(await provider.authenticate({ headers: { "remote-email": "a@b.c", "remote-groups": "infra" } }), null,
      "e-mail et groupes SANS utilisateur → null (le login est la clé de la politique)");
    const minimal = await provider.authenticate({ headers: { "remote-user": " amartin " } });
    ck.eq(minimal.user.login, "amartin", "valeur d'en-tête rognée");
    ck.eq(minimal.user.eMail, undefined, "e-mail absent → champ ABSENT (pas de chaîne vide qui polluerait /me et l'annuaire)");
    ck.eq(minimal.user.nom, undefined, "nom absent → champ absent");
    ck.eq(JSON.stringify(minimal.groups), "[]", "aucun groupe → tableau VIDE (≠ absent : ce provider FOURNIT des groupes, l'IdP n'en a donné aucun)");

    // -- En-têtes CUSTOM (oauth2-proxy, Tailscale… : l'exploitant renomme, pas de profils par marque). --
    const oauth2 = new ForwardHeaderAuthProvider({ userHeader: "X-Forwarded-User", emailHeader: "X-Forwarded-Email", groupsHeader: "X-Forwarded-Groups" });
    const custom = await oauth2.authenticate({ headers: { "x-forwarded-user": "zoe", "x-forwarded-email": "zoe@corp.tld", "x-forwarded-groups": "dev", "remote-user": "IGNORÉ" } });
    ck.eq(custom.user.login, "zoe", "en-têtes custom honorés");
    ck.eq(JSON.stringify(custom.groups), '["dev"]', "…groupes custom aussi");
    ck.eq(await oauth2.authenticate({ headers: { "remote-user": "amartin" } }), null, "…et les défauts ne sont PLUS lus (aucun cumul de conventions)");

    // -- GROUPES : découpe, rognage, vides écartées, doublons fondus. --
    const groupsOf = async (raw) => JSON.stringify((await provider.authenticate({ headers: { "remote-user": "u", "remote-groups": raw } })).groups);
    ck.eq(await groupsOf("infra, noc ,,  admin "), '["infra","noc","admin"]', "groupes : rognés, vides écartées");
    ck.eq(await groupsOf("infra,infra,noc"), '["infra","noc"]', "groupes : doublons fondus");
    ck.eq(await groupsOf(""), "[]", "groupes : en-tête vide → aucun groupe");
    ck.eq(await groupsOf(" , , "), "[]", "groupes : que des séparateurs → aucun groupe");
    ck.eq(await groupsOf("Infra"), '["Infra"]', "groupes : casse CONSERVÉE (la politique compare exactement — `Infra` ≠ `infra`)");
    ck.eq(await groupsOf("grp avec espaces"), '["grp avec espaces"]', "groupes : les espaces INTERNES sont légitimes (un nom de groupe d'annuaire en contient)");

    // -- En-tête RÉPÉTÉ → Node donne un `string[]` : on retient la PREMIÈRE valeur, en UN point. --
    const repeated = await provider.authenticate({ headers: { "remote-user": ["amartin", "usurpateur"], "remote-groups": ["infra,noc", "admin"] } });
    ck.eq(repeated.user.login, "amartin", "en-tête répété (string[]) → PREMIÈRE valeur (jamais de concaténation de deux affirmations contradictoires)");
    ck.eq(JSON.stringify(repeated.groups), '["infra","noc"]', "…même normalisation pour les groupes");
    ck.eq(await provider.authenticate({ headers: { "remote-user": [] } }), null, "tableau VIDE → aucune valeur → anonyme");
    ck.eq(await provider.authenticate({ headers: { "remote-user": 42 } }), null, "valeur non textuelle → ignorée (anonyme), jamais coercée");

    // -- CASSE du nom : Node minuscule les en-têtes reçus, mais la vue minimale du contrat ne le
    // GARANTIT pas (test, futur adaptateur) — la lecture accepte donc aussi le nom tel qu'écrit.
    ck.eq((await provider.authenticate({ headers: { "Remote-User": "amartin" } })).user.login, "amartin", "nom d'en-tête en casse CANONIQUE également reconnu");

    /* ---- 🚨 SECRET PARTAGÉ — le cœur du mode ---- */
    const secured = new ForwardHeaderAuthProvider({ secret: "  s3cret-du-proxy  " });
    ck.eq(secured.secretConfigured, true, "secret configuré (valeur rognée, comme toute variable d'environnement)");

    const ok = await secured.authenticate({ headers: { "remote-user": "amartin", "remote-groups": "infra", "x-auth-secret": "s3cret-du-proxy" } });
    ck.eq(ok.user.login, "amartin", "BON secret → identité lue normalement");
    ck.eq(await secured.authenticate({ headers: { "remote-user": "amartin", "x-auth-secret": "MAUVAIS" } }), null, "MAUVAIS secret → anonyme");
    ck.eq(await secured.authenticate({ headers: { "remote-user": "amartin" } }), null, "secret ABSENT de la requête → anonyme (un en-tête d'identité nu ne vaut rien)");
    ck.eq(await secured.authenticate({ headers: { "remote-user": "amartin", "x-auth-secret": "" } }), null, "secret vide → anonyme");
    ck.eq(await secured.authenticate({ headers: { "remote-user": "amartin", "x-auth-secret": "s3cret-du-proxy" + "0" } }), null,
      "secret presque bon (un caractère de plus) → anonyme");
    ck.eq((await secured.authenticate({ headers: { "remote-user": "amartin", "x-auth-secret": "  s3cret-du-proxy  " } })).user.login, "amartin",
      "espaces AUTOUR de la valeur d'en-tête : rognés des DEUX côtés (le transport HTTP les retire de toute façon)");

    // La PREUVE : sur secret refusé, aucun autre en-tête n'est même consulté. Un provider qui lirait
    // « juste pour journaliser » ouvrirait une brèche invisible à la relecture.
    const spy = spyHeaders({ "remote-user": "usurpateur", "remote-email": "x@y.z", "remote-groups": "admin", "x-auth-secret": "MAUVAIS" });
    ck.eq(await secured.authenticate({ headers: spy.headers }), null, "secret refusé → anonyme (requête pourtant complète)");
    ck(spy.reads.includes("x-auth-secret"), "…l'en-tête du SECRET a bien été consulté");
    ck(!spy.reads.includes("remote-user") && !spy.reads.includes("remote-email") && !spy.reads.includes("remote-groups"),
      "🚨 …et AUCUN en-tête d'identité n'a été lu (" + spy.reads.join(", ") + ")");

    // Secret configuré + requête valide : on lit bien les autres en-têtes (contre-preuve de l'espion).
    const spyOk = spyHeaders({ "remote-user": "amartin", "x-auth-secret": "s3cret-du-proxy" });
    await secured.authenticate({ headers: spyOk.headers });
    ck(spyOk.reads.includes("remote-user"), "contre-preuve : secret accepté → les en-têtes d'identité SONT lus (l'espion voit bien ce qu'il prétend voir)");

    // Comparaison à TEMPS CONSTANT : c'est le helper partagé qui l'assure (2 hachages par appel).
    const crypto = require("node:crypto");
    const realCreateHash = crypto.createHash;
    let hashCalls = 0;
    const counting = (...args) => { hashCalls++; return realCreateHash.apply(crypto, args); };
    let patched = false;
    try { crypto.createHash = counting; patched = crypto.createHash === counting; } catch (_) { patched = false; }
    if (!patched) { ck(true, "createHash non instrumentable → contrôle du temps constant sauté"); }
    else {
      try {
        hashCalls = 0; await secured.authenticate({ headers: { "remote-user": "u", "x-auth-secret": "MAUVAIS" } });
        ck.eq(hashCalls, 2, "secret vérifié par comparaison HACHÉE (temps constant, SecretCompare) — pas par ===");
        hashCalls = 0; await provider.authenticate({ headers: { "remote-user": "u" } });
        ck.eq(hashCalls, 0, "aucun secret configuré → aucune comparaison (rien à vérifier)");
      } finally { crypto.createHash = realCreateHash; }
    }

    // -- Sans secret configuré : le provider FONCTIONNE (le réseau est la seule protection, et le
    // boot le crie — cf. la section de l'orchestrateur). --
    ck.eq((await provider.authenticate({ headers: { "remote-user": "amartin", "x-auth-secret": "n'importe quoi" } })).user.login, "amartin",
      "aucun secret configuré → l'en-tête de secret est ignoré, l'identité est crue");

    // -- optionsFromEnv : le provider POSSÈDE les noms de ses variables (le bootstrap n'en connaît aucun). --
    ck.eq(ForwardHeaderAuthProvider.ENV_USER_HEADER, "AUTH_FORWARD_USER_HEADER", "variable : en-tête utilisateur");
    ck.eq(ForwardHeaderAuthProvider.ENV_EMAIL_HEADER, "AUTH_FORWARD_EMAIL_HEADER", "variable : en-tête e-mail");
    ck.eq(ForwardHeaderAuthProvider.ENV_NAME_HEADER, "AUTH_FORWARD_NAME_HEADER", "variable : en-tête nom");
    ck.eq(ForwardHeaderAuthProvider.ENV_GROUPS_HEADER, "AUTH_FORWARD_GROUPS_HEADER", "variable : en-tête groupes");
    ck.eq(ForwardHeaderAuthProvider.ENV_SECRET, "AUTH_FORWARD_SECRET", "variable : secret partagé");
    ck.eq(ForwardHeaderAuthProvider.ENV_SECRET_HEADER, "AUTH_FORWARD_SECRET_HEADER", "variable : en-tête du secret");
    const fromEnv = new ForwardHeaderAuthProvider(ForwardHeaderAuthProvider.optionsFromEnv({
      AUTH_FORWARD_USER_HEADER: "Tailscale-User-Login", AUTH_FORWARD_NAME_HEADER: "Tailscale-User-Name",
      AUTH_FORWARD_SECRET: "s3cret", AUTH_FORWARD_SECRET_HEADER: "X-Proxy-Proof",
    }));
    ck.eq(fromEnv.userHeader, "Tailscale-User-Login", "optionsFromEnv : en-tête utilisateur lu de l'environnement");
    ck.eq(fromEnv.nameHeader, "Tailscale-User-Name", "optionsFromEnv : en-tête nom lu de l'environnement");
    ck.eq(fromEnv.groupsHeader, "Remote-Groups", "optionsFromEnv : variable absente → défaut conservé");
    ck.eq(fromEnv.secretHeader, "X-Proxy-Proof", "optionsFromEnv : en-tête du secret configurable");
    ck.eq(fromEnv.secretConfigured, true, "optionsFromEnv : secret pris en compte");
    ck.eq(new ForwardHeaderAuthProvider(ForwardHeaderAuthProvider.optionsFromEnv({})).userHeader, "Remote-User", "optionsFromEnv : environnement VIERGE → tous les défauts");
  });

  /* ==========================================================================
     7. Auth — l'ORCHESTRATEUR
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

    // -- MODE EXPLICITE (`AUTH_MODE`) : il fait loi, et il ouvre le mode forward. --
    ck.eq(new Auth(log, { authMode: "forward" }).mode, "forward", "AUTH_MODE=forward → mode forward");
    ck.eq(new Auth(log, { authMode: "dev", basicAuth: "u:p", ssoUrl: "https://sso.test/v" }).mode, "dev",
      "AUTH_MODE=dev explicite → dev malgré BASIC_AUTH et SSO_URL");
    ck.eq(new Auth(log, { authMode: "sso", basicAuth: "u:p", ssoUrl: "https://sso.test/v" }).mode, "sso",
      "AUTH_MODE=sso explicite → sso malgré BASIC_AUTH (l'inverse de l'inférence)");
    ck.eq(new Auth(log, { authMode: "basic", basicAuth: "u:p" }).mode, "basic", "AUTH_MODE=basic explicite honorée");

    // 🚨 REFUS DE CONSTRUCTION sur configuration douteuse : un `Auth` ne peut pas exister dans un état
    // où le seul repli serait le mode dev. Le bootstrap (index.ts) journalise et arrête le process.
    const throwsOn = (opts, label) => {
      let caught = null;
      try { new Auth(makeLog(), opts); } catch (e) { caught = e; }
      ck(caught instanceof Error, "REFUS : " + label + " → le constructeur JETTE (aucun objet Auth en état douteux)");
      if (caught) ck(caught.message.includes("AUTH_MODE"), "REFUS : " + label + " → le message nomme AUTH_MODE");
      return caught;
    };
    throwsOn({ authMode: "frobnique" }, "valeur inconnue");
    throwsOn({ authMode: "oidc" }, "mode pas encore implémenté");
    throwsOn({ authMode: "sso" }, "sso sans SSO_URL");
    throwsOn({ authMode: "basic" }, "basic sans BASIC_AUTH");
    throwsOn({ authMode: "frobnique", basicAuth: "u:p", ssoUrl: "https://sso.test/v" }, "coquille malgré une configuration complète");

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

    // -- Boot FORWARD : INFO nommant les en-têtes, et 🚨 WARN quand rien ne prouve l'origine des requêtes. --
    const logFwd = makeLog(); new Auth(logFwd, { authMode: "forward" });
    ck(logFwd.lines.some((l) => l === "info auth Forward auth : en-têtes Remote-User / Remote-Groups"), "boot forward → INFO nommant les en-têtes lus");
    ck(logFwd.lines.some((l) => /^warn auth ⚠ mode FORWARD sans AUTH_FORWARD_SECRET/.test(l)),
      "🚨 boot forward SANS secret → WARN : les en-têtes sont crus sans preuve, l'app doit être joignable UNIQUEMENT par le proxy");
    ck(logFwd.lines.some((l) => l.includes("bind localhost")), "…et le WARN dit QUOI FAIRE (consigne réseau : le code ne peut pas la vérifier)");
    const logFwdSecret = makeLog(); new Auth(logFwdSecret, { authMode: "forward", forward: { secret: "s3cret", secretHeader: "X-Proxy-Proof" } });
    ck(logFwdSecret.lines.some((l) => l === "info auth Forward auth : en-têtes Remote-User / Remote-Groups (secret partagé attendu dans X-Proxy-Proof)"),
      "boot forward AVEC secret → INFO nommant l'en-tête du secret");
    ck(!logFwdSecret.lines.some((l) => l.includes("mode FORWARD sans")), "…et AUCUN warn : la configuration est complète");
    ck(!logFwdSecret.lines.join("|").includes("s3cret"), "🚨 le SECRET n'apparaît dans AUCUN log (c'est un secret d'infrastructure)");
    const logFwdCustom = makeLog(); new Auth(logFwdCustom, { authMode: "forward", forward: { userHeader: "X-Forwarded-User", groupsHeader: "X-Forwarded-Groups" } });
    ck(logFwdCustom.lines.some((l) => l === "info auth Forward auth : en-têtes X-Forwarded-User / X-Forwarded-Groups"), "boot forward → l'INFO reflète les en-têtes CONFIGURÉS");

    // -- checkBasic : le GATE DE TRANSPORT, pas une identification. --
    ck.eq(new Auth(log, {}).checkBasic({ headers: {} }), true, "hors mode basic → checkBasic ne s'oppose à rien (aucun challenge à opposer)");
    ck.eq(new Auth(log, { ssoUrl: "https://sso.test/v" }).checkBasic({ headers: {} }), true, "…mode sso compris");
    const gated = new Auth(log, { basicAuth: "expl:s" });
    ck.eq(gated.checkBasic({ headers: {} }), false, "mode basic sans en-tête → le gate challenge");
    ck.eq(gated.checkBasic(basicHeader("expl", "faux")), false, "mode basic, mauvais secret → le gate challenge");
    ck.eq(gated.checkBasic(basicHeader("expl", "s")), true, "mode basic, bons identifiants → passe");
    // ⚠ Depuis AUTH_MODE, un BASIC_AUTH oublié dans l'environnement ne doit PAS faire challenger un
    // déploiement qui a demandé un autre mode : le provider basic n'est retenu que si le mode l'est.
    ck.eq(new Auth(log, { authMode: "forward", basicAuth: "expl:s" }).checkBasic({ headers: {} }), true,
      "mode forward avec un BASIC_AUTH résiduel → AUCUN challenge (le gate ne se monte que pour le mode basic)");
    ck.eq(new Auth(log, { authMode: "dev", basicAuth: "expl:s" }).checkBasic({ headers: {} }), true, "…idem en mode dev explicite");

    // -- validate : dev et basic. --
    const devSession = await new Auth(log, {}).validate({ headers: {} });
    ck(devSession.logged === true && devSession.adminRight === "SUPER_ADMIN" && devSession.dev === true && devSession.user.login === "dev", "validate dev → session factice SUPER_ADMIN");
    const refused = await new Auth(log, { basicAuth: "expl:s" }).validate({ headers: {} });
    ck(refused.logged === false && refused.adminRight === "NONE" && refused.user.login === "anonymous", "validate basic refusé → session ANONYME (le `null` du provider y est substitué)");
    ck.eq((await new Auth(log, { basicAuth: "expl:s" }).validate(basicHeader("expl", "s"))).user.login, "expl", "validate basic accepté → session au login configuré");

    // -- validate FORWARD : l'identité du proxy traverse l'orchestrateur telle quelle, groupes compris. --
    const fwdAuth = new Auth(log, { authMode: "forward", forward: { secret: "s3cret" } });
    const fwdSession = await fwdAuth.validate({ headers: { "remote-user": "amartin", "remote-groups": "infra,noc", "x-auth-secret": "s3cret" } });
    ck(fwdSession.logged === true && fwdSession.user.login === "amartin" && fwdSession.user.domain === "forward", "validate forward → session lue dans les en-têtes");
    ck.eq(JSON.stringify(fwdSession.groups), '["infra","noc"]', "…avec les GROUPES, que la politique de rôles mappera (table `groups` de roles.json)");
    const fwdRefused = await fwdAuth.validate({ headers: { "remote-user": "usurpateur" } });
    ck(fwdRefused.logged === false && fwdRefused.adminRight === "NONE", "validate forward sans le secret → session ANONYME (le `null` du provider y est substitué)");

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
    const fwdSink = sinkOf();
    const fwdCapture = new Auth(log, { authMode: "forward", forward: { secret: "s3cret" } }, fwdSink);
    await fwdCapture.validate({ headers: { "remote-user": "amartin", "x-auth-secret": "s3cret" } });
    await fwdCapture.validate({ headers: { "remote-user": "usurpateur" } });
    ck.eq(fwdSink.seen.join(","), "amartin", "mode forward : l'identité du proxy alimente l'annuaire, et le refus de secret n'y entre PAS");
    // Puits ABSENT : la capture est optionnelle, rien ne doit lever.
    ck((await new Auth(log, {}).validate({ headers: {} })).logged === true, "aucun puits injecté → validation inchangée (capture optionnelle)");
  });
};
