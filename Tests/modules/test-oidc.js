/* Tests modules — MODE OIDC (lot 5 du chantier auth/ACL) : l'application est elle-même le RP
   (*Relying Party*) d'un OP, en flux Authorization Code + PKCE.

   Sept sections, dans l'ordre des responsabilités :
   1. `auth/OidcConfig` — les SIX variables d'environnement (source unique), la normalisation des
      scopes (dont `openid` FORCÉ en tête) et le drapeau `OIDC_COOKIE_SECURE` (défaut SÛR) ;
   2. `auth/GroupList` — le nettoyage des groupes, SORTI du provider forward quand oidc lui a donné
      un second consommateur : les deux modes doivent produire EXACTEMENT la même liste, sans quoi
      un même utilisateur n'aurait pas les mêmes rôles selon son mode d'authentification ;
   3. `auth/CookieHeader` — lecture d'un `Cookie` et composition d'un `Set-Cookie` : c'est ici que
      se vérifient HttpOnly / SameSite / Secure / Max-Age, et l'égalité des attributs entre la POSE
      et l'EFFACEMENT (sans laquelle un navigateur garde l'ancien cookie) ;
   4. `auth/OidcSessionStore` — TTL, bornage de l'échéance annoncée par l'OP, purge, plafond,
      unicité des identifiants, horloge INJECTÉE ;
   5. `auth/OidcAuthProvider` — cookie → session → `SsoResult` : les revendications retenues, les
      trois cas qui rendent anonyme (absent / inconnu / expiré), et ce que ce provider NE pose PAS
      (ni `sessionKey`, ni `adminRight`) ;
   6. `auth/OidcRoutes` — LE FLUX, éprouvé avec un BOUCHON de `OidcClientPort` : login qui emporte
      state/nonce/PKCE, callback à state faux REFUSÉ, callback nominal qui pose le cookie, logout
      qui l'efface, et le 503 actionnable quand la découverte n'a pas abouti ;
   7. `auth.ts` — le câblage du mode par l'orchestrateur (provider + store + routes), son refus de
      construire sans couche injectée, et la non-régression des quatre autres modes.

   ⚠ AUCUN RÉSEAU, AUCUN PAQUET `openid-client`. C'est tout l'objet du contrat `OidcClientPort` :
   la librairie n'est ni installée à la racine ni chargeable ici (ESM pur / programme de test en
   CommonJS), et seul `auth/OpenIdClientAdapter.ts` l'importe — fichier délibérément absent de
   `tsconfig.node.json`. Un flux OIDC de bout en bout exige un OP réel : il est HORS du périmètre
   de preuve de ce fichier, et c'est assumé — ce qui est vérifié ici, ce sont NOS règles.

   Harnais et assertions : harness.js. */
"use strict";
const { ck, section, SERVER } = require("./harness.js");

/* -------- outillage local -------- */

/** Journal ENREGISTREUR — les lignes de boot font partie du comportement observable (WARN sur
    `OIDC_COOKIE_SECURE=0`, WARN sur une URL de callback incohérente). */
const makeLog = () => {
  const lines = [];
  const rec = (level) => (...args) => { lines.push(level + " " + args.join(" ")); };
  return { lines, error: rec("error"), warn: rec("warn"), info: rec("info"), debug: rec("debug"), trace: rec("trace") };
};

/** Réponse HTTP factice : elle MÉMORISE tout ce qu'on lui fait (la vue minimale de `OidcRoutes`
    n'expose que ces quatre gestes, donc il n'y a rien d'autre à observer). */
const makeRes = () => {
  const res = {
    code: 200, headers: {}, redirectedTo: null, body: null,
    status(c) { res.code = c; return res; },
    setHeader(name, value) { res.headers[name] = value; return res; },
    redirect(url) { res.redirectedTo = url; return res; },
    send(body) { res.body = body; return res; },
  };
  /** En-têtes `Set-Cookie` posés, toujours sous forme de tableau (l'appelant en pose 1 ou 2). */
  res.cookies = () => {
    const raw = res.headers["Set-Cookie"];
    return raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]);
  };
  /** L'en-tête `Set-Cookie` portant ce nom de cookie, ou `null`. */
  res.cookie = (name) => res.cookies().find((c) => c.startsWith(name + "=")) || null;
  return res;
};

/** Requête factice. `cookies` est un objet nom → valeur, recomposé en en-tête `Cookie`. */
const makeReq = (opts = {}) => ({
  headers: { cookie: Object.entries(opts.cookies || {}).map(([k, v]) => k + "=" + v).join("; ") },
  originalUrl: opts.originalUrl || "/auth/callback",
});

/** BOUCHON de `OidcClientPort` : rend des valeurs déterministes et compte les appels. C'est lui qui
    remplace `openid-client` — il n'ouvre aucune socket et ne connaît aucune cryptographie. */
const makeClient = (over = {}) => {
  const stub = {
    calls: [],
    isReady: over.ready !== false,
    retries: 0,
    ready() { return stub.isReady; },
    unavailableReason() { return "OP injoignable (bouchon) — vérifier OIDC_ISSUER"; },
    retryDiscovery() { stub.retries++; },
    async beginAuthorization() {
      stub.calls.push("begin");
      if (over.beginThrows) throw new Error("découverte perdue");
      return {
        authorizationUrl: "https://op.exemple/authorize?state=ETAT&nonce=NONCE&code_challenge=DEFI&code_challenge_method=S256",
        state: "ETAT", nonce: "NONCE", codeVerifier: "VERIFIER",
      };
    },
    async completeAuthorization(params) {
      stub.calls.push("complete");
      stub.lastComplete = params;
      if (over.completeThrows) throw new Error("échange refusé par l'OP");
      return {
        claims: over.claims || { sub: "u-42", preferred_username: "alice", email: "alice@exemple.fr", name: "Alice Martin", groups: ["infra", "admins"] },
        idToken: "ID.TOKEN.BRUT",
        expiresAt: over.expiresAt,
      };
    },
    endSessionUrl(params) {
      stub.calls.push("endSession");
      stub.lastEndSession = params;
      return over.endSessionUrl === undefined ? "https://op.exemple/logout?id_token_hint=ID.TOKEN.BRUT" : over.endSessionUrl;
    },
  };
  return stub;
};

const REDIRECT_URL = "https://dcmanager.exemple/auth/callback";

module.exports = async () => {

  /* ==========================================================================
     1. OidcConfig — les six variables, et rien d'autre
     ========================================================================== */
  await section("Serveur : oidc — OidcConfig (six variables en source unique, scopes normalisés avec `openid` forcé, OIDC_COOKIE_SECURE au défaut SÛR)", async () => {
    const { OidcConfig } = SERVER("auth/OidcConfig.js");

    // -- Les noms de variables sont exposés : la doc, les messages de refus et `.env.example` les
    //    citent, et ils ne doivent exister qu'ICI (principe n°3). --
    ck.eq(OidcConfig.ENV_ISSUER, "OIDC_ISSUER", "nom de variable : émetteur");
    ck.eq(OidcConfig.ENV_CLIENT_ID, "OIDC_CLIENT_ID", "nom de variable : client");
    ck.eq(OidcConfig.ENV_CLIENT_SECRET, "OIDC_CLIENT_SECRET", "nom de variable : secret client");
    ck.eq(OidcConfig.ENV_SCOPES, "OIDC_SCOPES", "nom de variable : scopes");
    ck.eq(OidcConfig.ENV_REDIRECT_URL, "OIDC_REDIRECT_URL", "nom de variable : URL de callback");
    ck.eq(OidcConfig.ENV_COOKIE_SECURE, "OIDC_COOKIE_SECURE", "nom de variable : drapeau Secure");

    // -- Environnement VIDE : tout est vide, mais les DÉFAUTS sont là. --
    const empty = OidcConfig.optionsFromEnv({});
    ck.eq(empty.issuer, "", "env vide → issuer vide (c'est AuthModeResolution qui REFUSE, pas ici)");
    ck.eq(empty.clientId, "", "env vide → clientId vide");
    ck.eq(empty.clientSecret, "", "env vide → pas de secret (client PUBLIC, PKCE seul)");
    ck.eq(empty.redirectUrl, "", "env vide → redirectUrl vide");
    ck.eq(empty.scopes, "openid profile email groups", "env vide → scopes par défaut");
    ck.eq(empty.cookieSecure, true, "🚨 env vide → Secure ACTIF (le défaut doit être le sûr)");

    // -- Rognage : une variable recopiée traîne presque toujours un blanc. --
    const trimmed = OidcConfig.optionsFromEnv({
      OIDC_ISSUER: "  https://op.exemple/realms/infra  ", OIDC_CLIENT_ID: " dcmanager ",
      OIDC_CLIENT_SECRET: " s3cret ", OIDC_REDIRECT_URL: "  " + REDIRECT_URL + " ",
    });
    ck.eq(trimmed.issuer, "https://op.exemple/realms/infra", "issuer rogné");
    ck.eq(trimmed.clientId, "dcmanager", "clientId rogné");
    ck.eq(trimmed.clientSecret, "s3cret", "clientSecret rogné");
    ck.eq(trimmed.redirectUrl, REDIRECT_URL, "redirectUrl rognée");

    // -- SCOPES : `openid` est une constante du PROTOCOLE, pas une préférence. Sans lui, l'OP ne
    //    renvoie aucun id_token et le flux échoue loin de sa vraie cause. --
    ck.eq(OidcConfig.normalizeScopes("profile email"), "openid profile email", "🚨 `openid` FORCÉ en tête quand l'exploitant l'oublie");
    ck.eq(OidcConfig.normalizeScopes("openid profile"), "openid profile", "…et jamais dupliqué quand il est déjà là");
    ck.eq(OidcConfig.normalizeScopes("profile,email,groups"), "openid profile email groups", "virgules acceptées (les deux écritures existent dans la nature)");
    ck.eq(OidcConfig.normalizeScopes("  profile   email  "), "openid profile email", "blancs multiples absorbés");
    ck.eq(OidcConfig.normalizeScopes("profile profile email"), "openid profile email", "doublons fondus");
    ck.eq(OidcConfig.normalizeScopes(""), "openid profile email groups", "vide → défaut");
    ck.eq(OidcConfig.normalizeScopes(null), "openid profile email groups", "absent → défaut");
    ck.eq(OidcConfig.normalizeScopes("openid"), "openid", "un exploitant peut RÉDUIRE aux scopes que son OP accepte (`groups` n'est pas universel)");

    // -- OIDC_COOKIE_SECURE : formes fausses reconnues, et 🚨 asymétrie DÉLIBÉRÉE sur la coquille. --
    for (const falsy of ["0", "false", "no", "off", "FALSE", " Off "]) {
      ck.eq(OidcConfig.optionsFromEnv({ OIDC_COOKIE_SECURE: falsy }).cookieSecure, false, "OIDC_COOKIE_SECURE=« " + falsy + " » → Secure désactivé");
    }
    for (const truthy of ["1", "true", "yes", "on"]) {
      ck.eq(OidcConfig.optionsFromEnv({ OIDC_COOKIE_SECURE: truthy }).cookieSecure, true, "OIDC_COOKIE_SECURE=« " + truthy + " » → Secure actif");
    }
    ck.eq(OidcConfig.optionsFromEnv({ OIDC_COOKIE_SECURE: "flase" }).cookieSecure, true,
      "🚨 coquille (« flase ») → Secure RESTE actif : une faute de saisie ne doit jamais AFFAIBLIR la sécurité");
    ck.eq(OidcConfig.parseBoolean("", false), false, "parseBoolean : vide → le défaut fourni (et non `true` en dur)");
  });

  /* ==========================================================================
     2. GroupList — une SEULE règle pour forward et oidc
     ========================================================================== */
  await section("Serveur : oidc — GroupList (règle UNIQUE de nettoyage des groupes : chaîne à virgules ET tableau, ordre conservé, aucun faux groupe)", async () => {
    const { GroupList } = SERVER("auth/GroupList.js");
    const { ForwardHeaderAuthProvider } = SERVER("auth/ForwardHeaderAuthProvider.js");

    // -- Forme CHAÎNE (en-tête HTTP : la seule possible en mode forward). --
    ck.eq(GroupList.normalize("infra,admins").join("|"), "infra|admins", "chaîne à virgules");
    ck.eq(GroupList.normalize(" infra , admins ").join("|"), "infra|admins", "valeurs rognées");
    ck.eq(GroupList.normalize("infra,,admins,").join("|"), "infra|admins", "vides écartées");
    ck.eq(GroupList.normalize("infra,admins,infra").join("|"), "infra|admins", "doublons fondus");
    ck.eq(GroupList.normalize("b,a,c").join("|"), "b|a|c", "AUCUN tri : l'ordre de la source est conservé");
    ck.eq(GroupList.normalize("").length, 0, "chaîne vide → tableau vide");

    // -- Forme TABLEAU (revendication JWT : la forme du mode oidc). --
    ck.eq(GroupList.normalize(["infra", "admins"]).join("|"), "infra|admins", "tableau");
    ck.eq(GroupList.normalize([" infra ", "", "admins", "infra"]).join("|"), "infra|admins", "tableau : rognage, vides, doublons");
    ck.eq(GroupList.normalize(["infra,admins"]).join("|"), "infra|admins", "tableau CONTENANT une chaîne à virgules (OP hésitants) → redécoupé");
    // 🚨 Aucune conversion des valeurs non textuelles : un « [object Object] » serait un FAUX groupe,
    //    silencieux, qui pourrait correspondre à une entrée de `roles.json`.
    ck.eq(GroupList.normalize([{ nom: "infra" }, null, 42, "admins"]).join("|"), "admins",
      "🚨 valeurs non textuelles IGNORÉES (jamais de « [object Object] » en guise de groupe)");
    ck.eq(GroupList.normalize(null).length, 0, "null → tableau vide");
    ck.eq(GroupList.normalize(undefined).length, 0, "absent → tableau vide");
    ck.eq(Array.isArray(GroupList.normalize(undefined)), true, "…et TOUJOURS un tableau (jamais `undefined`)");

    /* 🚨 L'INVARIANT qui justifie l'extraction : le mode forward doit produire EXACTEMENT la même
       liste que le helper. Les groupes deviennent des rôles par correspondance EXACTE et sensible à
       la casse — deux nettoyages qui divergeraient d'un rognage donneraient à un même utilisateur
       des droits différents selon son mode d'authentification, sans que rien ne l'affiche. */
    const forward = new ForwardHeaderAuthProvider();
    for (const raw of ["infra,admins", " infra , admins ", "infra,,admins,", "infra,admins,infra", "b,a,c", ""]) {
      const viaForward = await forward.authenticate({ headers: { "remote-user": "alice", "remote-groups": raw } });
      ck.eq(viaForward.groups.join("|"), GroupList.normalize(raw).join("|"),
        "🚨 forward ⇄ GroupList : même résultat pour « " + raw + " » (une seule règle, deux modes)");
    }
  });

  /* ==========================================================================
     3. CookieHeader — les attributs qui protègent, et la symétrie pose/effacement
     ========================================================================== */
  await section("Serveur : oidc — CookieHeader (lecture d'un Cookie ; Set-Cookie HttpOnly/SameSite/Secure/Max-Age ; POSE et EFFACEMENT aux MÊMES attributs)", async () => {
    const { CookieHeader } = SERVER("auth/CookieHeader.js");

    // -- LECTURE. --
    ck.eq(CookieHeader.read("a=1; dcm_oidc_session=XYZ; b=2", "dcm_oidc_session"), "XYZ", "cookie lu parmi d'autres");
    ck.eq(CookieHeader.read("dcm_oidc_session=XYZ", "dcm_oidc_session"), "XYZ", "cookie seul");
    ck.eq(CookieHeader.read("  dcm_oidc_session = XYZ ", "dcm_oidc_session"), "XYZ", "blancs autour du nom et de la valeur");
    ck.eq(CookieHeader.read("autre=1", "dcm_oidc_session"), null, "cookie absent → null");
    ck.eq(CookieHeader.read("", "dcm_oidc_session"), null, "en-tête vide → null");
    ck.eq(CookieHeader.read(undefined, "dcm_oidc_session"), null, "en-tête absent → null");
    ck.eq(CookieHeader.read("dcm_oidc_session=a%2Fb", "dcm_oidc_session"), "a/b", "valeur percent-décodée");
    ck.eq(CookieHeader.read("dcm_oidc_session=100%", "dcm_oidc_session"), "100%", "🚨 valeur mal encodée → repli sur le brut (jamais d'exception : un cookie illisible rend anonyme, pas 500)");
    ck.eq(CookieHeader.read(["a=1", "dcm_oidc_session=XYZ"], "dcm_oidc_session"), "XYZ", "en-tête RÉPÉTÉ (string[] côté Node) → recollé");
    // Un nom qui est le SUFFIXE d'un autre ne doit pas matcher (piège classique de la regex naïve).
    ck.eq(CookieHeader.read("xdcm_oidc_session=PIEGE; dcm_oidc_session=VRAI", "dcm_oidc_session"), "VRAI", "🚨 un nom SUFFIXE d'un autre ne matche pas");

    // -- COMPOSITION : les attributs qui protègent réellement le porteur de session. --
    const posed = CookieHeader.serialize("dcm_oidc_session", "XYZ", { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAgeSeconds: 3600 });
    ck(posed.startsWith("dcm_oidc_session=XYZ"), "Set-Cookie : nom=valeur en tête");
    ck(posed.includes("HttpOnly"), "🚨 HttpOnly (neutralise le vol de session par XSS)");
    ck(posed.includes("Secure"), "🚨 Secure (le cookie ne part pas en clair)");
    ck(posed.includes("SameSite=Lax"), "🚨 SameSite=Lax — `Strict` retiendrait le cookie au RETOUR de l'OP et casserait le callback");
    ck(posed.includes("Path=/"), "Path=/ (le cookie vaut pour toute l'application)");
    ck(posed.includes("Max-Age=3600"), "Max-Age posé");
    ck(!posed.includes("Expires="), "…et pas d'Expires sur une pose (il n'accompagne que l'effacement)");
    ck.eq(CookieHeader.serialize("n", "v").includes("Secure"), false, "Secure ABSENT par défaut (c'est la config qui le pilote, cf. OIDC_COOKIE_SECURE)");
    ck(CookieHeader.serialize("n", "v").includes("HttpOnly"), "HttpOnly par défaut (il faut le retirer EXPLICITEMENT)");
    ck(CookieHeader.serialize("n", "a b").includes("n=a%20b"), "valeur encodée (une valeur inhabituelle ne casse pas la syntaxe de l'en-tête)");

    // -- EFFACEMENT : Max-Age=0 + Expires passé, et surtout les MÊMES attributs que la pose. --
    const attributes = { httpOnly: true, secure: true, sameSite: "Lax", path: "/" };
    const cleared = CookieHeader.expire("dcm_oidc_session", attributes);
    ck(cleared.includes("Max-Age=0"), "effacement : Max-Age=0");
    ck(cleared.includes("Expires=Thu, 01 Jan 1970"), "effacement : Expires passé AUSSI (intermédiaires anciens)");
    ck(cleared.startsWith("dcm_oidc_session=;"), "effacement : valeur vide");
    /* 🚨 L'invariant qui compte : Path/Secure/SameSite IDENTIQUES entre pose et effacement. S'ils
       diffèrent, le navigateur y voit DEUX cookies distincts et GARDE l'ancien — une déconnexion
       qui ne déconnecte pas, et personne ne le voit avant l'incident. */
    const posedAttributes = CookieHeader.serialize("dcm_oidc_session", "XYZ", attributes).split("; ").filter((p) => !p.startsWith("dcm_oidc_session=") && !p.startsWith("Max-Age"));
    const clearedAttributes = cleared.split("; ").filter((p) => !p.startsWith("dcm_oidc_session=") && !p.startsWith("Max-Age") && !p.startsWith("Expires"));
    ck.eq(clearedAttributes.join("; "), posedAttributes.join("; "),
      "🚨 POSE et EFFACEMENT portent les MÊMES attributs (sinon le navigateur garde l'ancien cookie)");
  });

  /* ==========================================================================
     4. OidcSessionStore — TTL, bornage, purge, plafond, aléa
     ========================================================================== */
  await section("Serveur : oidc — OidcSessionStore (TTL, échéance de l'OP BORNÉE, expiration, purge, plafond, ids uniques et imprévisibles, horloge injectée)", async () => {
    const { OidcSessionStore } = SERVER("auth/OidcSessionStore.js");

    // -- Horloge INJECTÉE : sans elle, « la session expire-t-elle ? » ne se testerait qu'en attendant. --
    let now = 1_000_000;
    const store = new OidcSessionStore({ ttlMs: 10_000, nowMs: () => now });

    const id = store.create({ claims: { sub: "u-1" }, idToken: "ID.TOKEN" });
    ck(typeof id === "string" && id.length >= 40, "identifiant rendu (32 octets en base64url ≈ 43 caractères)");
    ck.eq(store.size, 1, "session enregistrée");
    ck.eq(store.get(id).claims.sub, "u-1", "session relue par son identifiant");
    ck.eq(store.get(id).idToken, "ID.TOKEN", "id_token conservé (il sert l'`id_token_hint` de la déconnexion)");
    ck.eq(store.get(id).expiresAt, now + 10_000, "aucune échéance annoncée → TTL appliqué");
    ck.eq(store.get("inexistant"), null, "identifiant INCONNU → null");
    ck.eq(store.get(""), null, "identifiant vide → null");
    ck.eq(store.get(null), null, "identifiant absent → null");

    // -- EXPIRATION : le seuil est atteint, pas seulement dépassé. --
    now += 9_999;
    ck(store.get(id) !== null, "juste avant l'échéance → session encore vivante");
    now += 1;
    ck.eq(store.get(id), null, "🚨 à l'échéance PILE → expirée (comparaison inclusive)");
    ck.eq(store.size, 0, "…et l'entrée est SUPPRIMÉE au passage (purge la moins chère : elle suit l'usage)");

    // -- BORNAGE de l'échéance annoncée par l'OP : on ne fait pas confiance à un OP pour ne jamais
    //    annoncer n'importe quoi (un id_token valable un an ne doit pas nous tenir un an). --
    ck.eq(store.get(store.create({ claims: { sub: "u" }, expiresAt: now + 5_000 })).expiresAt, now + 5_000,
      "échéance de l'OP PLUS COURTE que le TTL → honorée");
    ck.eq(store.get(store.create({ claims: { sub: "u" }, expiresAt: now + 999_999 })).expiresAt, now + 10_000,
      "🚨 échéance de l'OP plus LONGUE que le TTL → PLAFONNÉE au TTL");
    ck.eq(store.get(store.create({ claims: { sub: "u" }, expiresAt: now - 1 })).expiresAt, now + 10_000,
      "🚨 échéance DÉJÀ PASSÉE → TTL (une session morte à la naissance ferait boucler le client login → 401)");
    ck.eq(store.get(store.create({ claims: { sub: "u" }, expiresAt: NaN })).expiresAt, now + 10_000, "échéance absurde (NaN) → TTL");

    // -- DESTRUCTION : rend l'enregistrement (la route de déconnexion en a besoin). --
    const doomed = store.create({ claims: { sub: "u-9" }, idToken: "ID.9" });
    ck.eq(store.destroy(doomed).idToken, "ID.9", "destroy rend l'enregistrement supprimé (pour l'id_token_hint)");
    ck.eq(store.get(doomed), null, "…et la session n'existe plus");
    ck.eq(store.destroy(doomed), null, "destroy d'une session déjà partie → null (idempotent)");
    ck.eq(store.destroy(null), null, "destroy sans identifiant → null");

    // -- PURGE explicite. --
    const purgeStore = new OidcSessionStore({ ttlMs: 100, nowMs: () => now });
    purgeStore.create({ claims: { sub: "a" } });
    purgeStore.create({ claims: { sub: "b" } });
    ck.eq(purgeStore.size, 2, "deux sessions en attente de purge");
    ck.eq(purgeStore.purgeExpired(), 0, "rien d'expiré → aucune suppression");
    now += 101;
    ck.eq(purgeStore.purgeExpired(), 2, "les deux expirées → purgées");
    ck.eq(purgeStore.size, 0, "table vide après purge");

    /* -- PLAFOND : la table est alimentée par des ANONYMES (n'importe qui peut lancer un flux de
       connexion). Sans plafond, c'est une fuite mémoire offerte. -- */
    const capped = new OidcSessionStore({ ttlMs: 1_000_000, maxEntries: 5, nowMs: () => now });
    const kept = [];
    for (let i = 0; i < 20; i++) kept.push(capped.create({ claims: { sub: "u" + i }, expiresAt: now + 1000 + i }));
    ck(capped.size <= 5, "🚨 plafond respecté malgré 20 créations (" + capped.size + " ≤ 5)");
    // L'éviction retire les PLUS PROCHES de l'échéance : la victime est celle qui allait partir.
    ck.eq(capped.get(kept[0]), null, "évincée : la session la plus proche de son échéance");
    ck(capped.get(kept[19]) !== null, "conservée : la session la plus lointaine");

    // -- ALÉA : un identifiant de session est un porteur d'identité, il doit être imprévisible. --
    const fresh = new OidcSessionStore({ nowMs: () => now });
    const ids = new Set();
    for (let i = 0; i < 500; i++) ids.add(fresh.create({ claims: { sub: "u" } }));
    ck.eq(ids.size, 500, "🚨 500 identifiants, 500 valeurs DISTINCTES (aléa fort, aucun compteur)");
    ck(![...ids].some((v) => /^[0-9]+$/.test(v)), "…et aucun n'est un simple nombre (pas de séquence devinable)");
    ck.eq(OidcSessionStore.ID_BYTES, 32, "256 bits d'aléa CSPRNG");
    ck(OidcSessionStore.DEFAULT_TTL_MS > 0 && OidcSessionStore.DEFAULT_MAX_ENTRIES > 0, "constantes de TTL et de plafond exposées (documentées, réglables au constructeur)");
  });

  /* ==========================================================================
     5. OidcAuthProvider — cookie → session → SsoResult
     ========================================================================== */
  await section("Serveur : oidc — OidcAuthProvider (cookie → session → SsoResult ; absent/inconnu/expiré → anonyme ; groups nettoyés ; ni sessionKey ni adminRight)", async () => {
    const { OidcAuthProvider } = SERVER("auth/OidcAuthProvider.js");
    const { OidcSessionStore } = SERVER("auth/OidcSessionStore.js");

    let now = 5_000_000;
    const sessions = new OidcSessionStore({ ttlMs: 10_000, nowMs: () => now });
    const provider = new OidcAuthProvider(sessions);

    ck.eq(OidcAuthProvider.COOKIE_NAME, "dcm_oidc_session", "nom du cookie de session (source unique — les routes le relisent ICI)");
    ck.eq(OidcAuthProvider.DOMAIN, "oidc", "domaine posé sur l'utilisateur");

    const id = sessions.create({
      claims: { sub: "u-42", preferred_username: "alice", email: "alice@exemple.fr", name: "Alice Martin", groups: ["infra", "admins"] },
    });
    const session = await provider.authenticate({ headers: { cookie: "dcm_oidc_session=" + id } });
    ck.eq(session.logged, true, "cookie valide → session authentifiée");
    ck.eq(session.user.id, "u-42", "🚨 user.id = String(sub) — la SEULE revendication qu'un OP garantit stable");
    ck.eq(typeof session.user.id, "string", "…et c'est bien une CHAÎNE (un `sub` est opaque, souvent un UUID)");
    ck.eq(session.user.login, "alice", "login = preferred_username");
    ck.eq(session.user.eMail, "alice@exemple.fr", "e-mail repris");
    ck.eq(session.user.nom, "Alice Martin", "nom d'affichage COMPLET (jamais découpé à l'espace — arbitrage du lot 4)");
    ck.eq(session.user.prenom, undefined, "…donc pas de `prenom` inventé");
    ck.eq(session.user.domain, "oidc", "domaine « oidc » (distingue des sessions forward/sso dans les logs et /me)");
    ck.eq(session.groups.join("|"), "infra|admins", "groupes repris");
    ck.eq(session.expireDate, now + 10_000, "expireDate = échéance de la SESSION, en millisecondes (unité de Date.now)");

    // -- 🚨 Ce que ce provider NE POSE PAS. --
    ck.eq(session.adminRight, undefined, "🚨 AUCUN adminRight : l'autorisation passe par les RÔLES (sinon tout utilisateur de l'IdP serait admin)");
    ck.eq(session.dev, undefined, "aucun marqueur `dev` (c'est une authentification RÉELLE)");
    ck.eq(typeof provider.sessionKey, "undefined",
      "🚨 AUCUN sessionKey : la résolution est un Map.get — un cache n'économiserait rien et ferait SURVIVRE une session détruite");

    // -- Les TROIS chemins vers l'anonyme, indistinguables de l'extérieur (on ne renseigne pas un
    //    attaquant sur la validité d'un identifiant deviné). --
    ck.eq(await provider.authenticate({ headers: {} }), null, "aucun cookie → anonyme");
    ck.eq(await provider.authenticate({ headers: { cookie: "" } }), null, "en-tête Cookie vide → anonyme");
    ck.eq(await provider.authenticate({ headers: { cookie: "autre=1" } }), null, "cookie d'un autre nom → anonyme");
    ck.eq(await provider.authenticate({ headers: { cookie: "dcm_oidc_session=inventé" } }), null, "identifiant INCONNU → anonyme");
    now += 10_001;
    ck.eq(await provider.authenticate({ headers: { cookie: "dcm_oidc_session=" + id } }), null, "session EXPIRÉE → anonyme");

    // -- Revendications PARTIELLES : un OP ne garantit que `sub`. --
    now = 6_000_000;
    const minimal = sessions.create({ claims: { sub: "u-7" } });
    const bare = await provider.authenticate({ headers: { cookie: "dcm_oidc_session=" + minimal } });
    ck.eq(bare.user.id, "u-7", "sub seul → identité tout de même établie");
    ck.eq(bare.user.login, undefined, "pas de login inventé (surtout pas `sub`, illisible dans l'annuaire)");
    ck.eq(bare.user.eMail, undefined, "pas d'e-mail inventé");
    ck.eq(bare.groups.length, 0, "groups TOUJOURS présent, vide ici (« l'IdP n'en a donné aucun » ≠ champ absent)");
    ck.eq(Array.isArray(bare.groups), true, "…et toujours un tableau");

    // -- Repli du login sur l'e-mail (OP sans `preferred_username`, cas d'Entra ID). --
    const byEmail = sessions.create({ claims: { sub: "u-8", email: "bob@exemple.fr" } });
    ck.eq((await provider.authenticate({ headers: { cookie: "dcm_oidc_session=" + byEmail } })).user.login, "bob@exemple.fr",
      "pas de preferred_username → login = e-mail");

    // -- Groupes : MÊME nettoyage que forward, y compris la forme chaîne à virgules. --
    const strGroups = sessions.create({ claims: { sub: "u-9", groups: " infra , admins , infra " } });
    ck.eq((await provider.authenticate({ headers: { cookie: "dcm_oidc_session=" + strGroups } })).groups.join("|"), "infra|admins",
      "groupes en chaîne à virgules (OP hésitants) → nettoyés comme en mode forward");

    // -- Revendications de type inattendu : on ne convertit QUE les chaînes. --
    const weird = sessions.create({ claims: { sub: "u-10", preferred_username: 12345, name: { x: 1 } } });
    const weirdSession = await provider.authenticate({ headers: { cookie: "dcm_oidc_session=" + weird } });
    ck.eq(weirdSession.user.login, undefined, "🚨 revendication non textuelle IGNORÉE (jamais un login numérique fabriqué)");
    ck.eq(weirdSession.user.nom, undefined, "🚨 …ni un « [object Object] » en guise de nom");
  });

  /* ==========================================================================
     6. OidcRoutes — LE FLUX, avec un bouchon de la couche openid-client
     ========================================================================== */
  await section("Serveur : oidc — OidcRoutes (login → redirection portant state/nonce/PKCE ; 🚨 state faux REFUSÉ ; callback OK → cookie posé ; logout → cookie effacé ; 503 actionnable)", async () => {
    const { OidcRoutes } = SERVER("auth/OidcRoutes.js");
    const { OidcSessionStore } = SERVER("auth/OidcSessionStore.js");
    const { CookieHeader } = SERVER("auth/CookieHeader.js");

    const build = (clientOver = {}, options = {}) => {
      const client = makeClient(clientOver);
      const sessions = new OidcSessionStore();
      const log = makeLog();
      const routes = new OidcRoutes(client, sessions, { redirectUrl: REDIRECT_URL, cookieSecure: true, ...options }, log);
      return { client, sessions, log, routes };
    };

    ck.eq(OidcRoutes.PATH_LOGIN, "/auth/login", "chemin de connexion");
    ck.eq(OidcRoutes.PATH_CALLBACK, "/auth/callback", "chemin de callback");
    ck.eq(OidcRoutes.PATH_LOGOUT, "/auth/logout", "chemin de déconnexion");
    ck.eq(OidcRoutes.DEFAULT_CLIENT_LOGIN_URL, "auth/login",
      "🚨 valeur injectée au client : RELATIVE, sans slash initial (ancrée sur le <base> — cf. apiBaseUrl et docs/reverse-proxy.md)");

    /* -- LOGIN : la redirection part vers l'OP, et les trois secrets sont MÉMORISÉS côté navigateur
       dans un cookie de transaction court. -- */
    {
      const { routes, log } = build();
      const res = makeRes();
      await routes.login(makeReq({ originalUrl: "/auth/login" }), res);
      ck(String(res.redirectedTo).startsWith("https://op.exemple/authorize"), "login → redirection vers l'OP");
      ck(res.redirectedTo.includes("state=ETAT"), "…l'URL porte le `state`");
      ck(res.redirectedTo.includes("nonce=NONCE"), "…l'URL porte le `nonce`");
      ck(res.redirectedTo.includes("code_challenge=DEFI"), "…l'URL porte le DÉFI PKCE");
      ck(res.redirectedTo.includes("code_challenge_method=S256"), "…en S256 (jamais `plain`)");

      const tx = res.cookie(OidcRoutes.TRANSACTION_COOKIE);
      ck(tx !== null, "cookie de TRANSACTION posé");
      ck(tx.includes("HttpOnly"), "🚨 transaction : HttpOnly (le verifier PKCE n'est pas lisible en JS)");
      ck(tx.includes("Secure"), "🚨 transaction : Secure");
      ck(tx.includes("SameSite=Lax"), "🚨 transaction : SameSite=Lax — `Strict` casserait le RETOUR de l'OP");
      ck(tx.includes("Max-Age=" + OidcRoutes.TRANSACTION_TTL_SECONDS), "transaction : durée COURTE (" + OidcRoutes.TRANSACTION_TTL_SECONDS + " s)");
      ck(OidcRoutes.TRANSACTION_TTL_SECONDS <= 900, "…et bornée à un quart d'heure au plus");
      // 🚨 Le verifier PKCE ne doit PAS partir chez l'OP : seul son hash y va. Il vit dans le cookie.
      const txValue = CookieHeader.read(tx.split(";")[0], OidcRoutes.TRANSACTION_COOKIE);
      const decoded = JSON.parse(Buffer.from(txValue, "base64url").toString("utf8"));
      ck.eq(decoded.state, "ETAT", "cookie de transaction : `state` mémorisé");
      ck.eq(decoded.nonce, "NONCE", "cookie de transaction : `nonce` mémorisé");
      ck.eq(decoded.codeVerifier, "VERIFIER", "cookie de transaction : verifier PKCE mémorisé");
      ck(!String(res.redirectedTo).includes("VERIFIER"), "🚨 le VERIFIER PKCE ne part JAMAIS dans l'URL (seul son défi y va)");
      ck.eq(log.lines.filter((l) => l.startsWith("error")).length, 0, "aucun log d'erreur sur un login nominal");
    }

    /* -- CALLBACK NOMINAL : session créée, cookie posé, transaction consommée. -- */
    {
      const { routes, sessions, client } = build();
      const loginRes = makeRes();
      await routes.login(makeReq(), loginRes);
      const txValue = CookieHeader.read(loginRes.cookie(OidcRoutes.TRANSACTION_COOKIE).split(";")[0], OidcRoutes.TRANSACTION_COOKIE);

      const res = makeRes();
      await routes.callback(makeReq({ originalUrl: "/auth/callback?code=CODE&state=ETAT", cookies: { dcm_oidc_tx: txValue } }), res);
      ck.eq(res.redirectedTo, "https://dcmanager.exemple/", "🚨 retour à la RACINE DE L'APPLICATION, déduite de OIDC_REDIRECT_URL (marche en sous-dossier)");
      ck.eq(sessions.size, 1, "session créée");

      const cookie = res.cookie("dcm_oidc_session");
      ck(cookie !== null, "cookie de SESSION posé");
      ck(cookie.includes("HttpOnly"), "🚨 session : HttpOnly");
      ck(cookie.includes("Secure"), "🚨 session : Secure");
      ck(cookie.includes("SameSite=Lax"), "🚨 session : SameSite=Lax");
      ck(cookie.includes("Path=/"), "session : Path=/");
      const cleared = res.cookie(OidcRoutes.TRANSACTION_COOKIE);
      ck(cleared !== null && cleared.includes("Max-Age=0"), "🚨 cookie de transaction EFFACÉ (elle est CONSOMMÉE)");

      // La couche a bien reçu les trois valeurs à vérifier, et l'URL de callback CONFIGURÉE.
      ck.eq(client.lastComplete.expectedState, "ETAT", "state attendu transmis à la librairie");
      ck.eq(client.lastComplete.expectedNonce, "NONCE", "nonce attendu transmis à la librairie");
      ck.eq(client.lastComplete.codeVerifier, "VERIFIER", "verifier PKCE transmis à la librairie");
      ck.eq(client.lastComplete.callbackUrl, REDIRECT_URL + "?code=CODE&state=ETAT",
        "🚨 URL de callback = valeur CONFIGURÉE + query reçue (aucun en-tête Host/X-Forwarded-* n'entre : anti empoisonnement d'hôte)");

      // La session posée est bien celle que le provider saura relire.
      const sessionId = CookieHeader.read(cookie.split(";")[0], "dcm_oidc_session");
      ck.eq(sessions.get(sessionId).claims.sub, "u-42", "le cookie posé désigne la session créée");
      ck.eq(sessions.get(sessionId).idToken, "ID.TOKEN.BRUT", "id_token conservé pour la déconnexion RP-initiated");
    }

    /* -- 🚨 STATE FAUX : le cœur de la protection anti-CSRF de connexion. -- */
    {
      const { routes, sessions, client } = build();
      const loginRes = makeRes();
      await routes.login(makeReq(), loginRes);
      const txValue = CookieHeader.read(loginRes.cookie(OidcRoutes.TRANSACTION_COOKIE).split(";")[0], OidcRoutes.TRANSACTION_COOKIE);

      const res = makeRes();
      await routes.callback(makeReq({ originalUrl: "/auth/callback?code=CODE&state=ETAT_FORGE", cookies: { dcm_oidc_tx: txValue } }), res);
      ck.eq(res.code, 400, "🚨 state qui ne correspond pas → REFUS (400)");
      ck.eq(sessions.size, 0, "🚨 …AUCUNE session créée");
      ck.eq(res.redirectedTo, null, "🚨 …et AUCUNE redirection (jamais de boucle login → erreur → login)");
      ck(!client.calls.includes("complete"), "🚨 …et le code n'est même PAS échangé : on refuse AVANT tout appel sortant");
      ck(String(res.body).includes("state"), "page d'erreur : le paramètre fautif est nommé");
      const cleared = res.cookie(OidcRoutes.TRANSACTION_COOKIE);
      ck(cleared !== null && cleared.includes("Max-Age=0"), "…et la transaction ratée est effacée");
    }

    /* -- Transaction ABSENTE (cookie perdu/expiré, autre navigateur). -- */
    {
      const { routes, client } = build();
      const res = makeRes();
      await routes.callback(makeReq({ originalUrl: "/auth/callback?code=CODE&state=ETAT" }), res);
      ck.eq(res.code, 400, "aucun cookie de transaction → refus 400");
      ck.eq(res.redirectedTo, null, "🚨 …sans redirection vers /auth/login (ce serait une BOUCLE si le cookie ne peut pas être posé)");
      ck(!client.calls.includes("complete"), "…et aucun échange tenté");
      ck(String(res.body).includes("cookie"), "page d'erreur : la cause probable (cookies) est nommée");
      ck(String(res.body).includes("OIDC_COOKIE_SECURE"), "…y compris le piège « Secure en HTTP »");
    }

    /* -- Cookie de transaction ILLISIBLE ou incomplet. -- */
    for (const [label, value] of [["non base64", "!!!pas-du-base64!!!"], ["JSON valide mais incomplet", Buffer.from(JSON.stringify({ state: "E" }), "utf8").toString("base64url")], ["champs vides", Buffer.from(JSON.stringify({ state: "", nonce: "", codeVerifier: "" }), "utf8").toString("base64url")]]) {
      const { routes, sessions } = build();
      const res = makeRes();
      await routes.callback(makeReq({ originalUrl: "/auth/callback?code=C&state=ETAT", cookies: { dcm_oidc_tx: value } }), res);
      ck.eq(res.code, 400, "cookie de transaction " + label + " → refus 400 (jamais d'exception)");
      ck.eq(sessions.size, 0, "…et aucune session");
    }

    /* -- L'OP REFUSE (utilisateur qui annule) : réponse NORMALE du protocole, pas une panne. -- */
    {
      const { routes, sessions } = build();
      const res = makeRes();
      await routes.callback(makeReq({ originalUrl: "/auth/callback?error=access_denied&error_description=refus" }), res);
      ck.eq(res.code, 401, "erreur renvoyée par l'OP → 401 sobre");
      ck(String(res.body).includes("access_denied"), "…le code d'erreur de l'OP est affiché");
      ck.eq(res.redirectedTo, null, "…sans redirection");
      ck.eq(sessions.size, 0, "…et aucune session");
    }

    /* -- L'ÉCHANGE échoue (id_token invalide, code déjà consommé, OP en panne). -- */
    {
      const { routes, sessions, log } = build({ completeThrows: true });
      const loginRes = makeRes();
      await routes.login(makeReq(), loginRes);
      const txValue = CookieHeader.read(loginRes.cookie(OidcRoutes.TRANSACTION_COOKIE).split(";")[0], OidcRoutes.TRANSACTION_COOKIE);
      const res = makeRes();
      await routes.callback(makeReq({ originalUrl: "/auth/callback?code=CODE&state=ETAT", cookies: { dcm_oidc_tx: txValue } }), res);
      ck.eq(res.code, 401, "échange refusé → 401");
      ck.eq(sessions.size, 0, "aucune session");
      ck.eq(res.redirectedTo, null, "aucune redirection (pas de boucle)");
      ck(log.lines.some((l) => l.startsWith("error") && l.includes("échange")), "l'échec est JOURNALISÉ côté serveur");
      ck(!String(res.body).includes("échange refusé par l'OP"),
        "🚨 …mais le message INTERNE de la librairie n'est PAS servi à un appelant non authentifié");
    }

    /* -- LOGOUT. -- */
    {
      const { routes, sessions, client } = build();
      const loginRes = makeRes();
      await routes.login(makeReq(), loginRes);
      const txValue = CookieHeader.read(loginRes.cookie(OidcRoutes.TRANSACTION_COOKIE).split(";")[0], OidcRoutes.TRANSACTION_COOKIE);
      const cbRes = makeRes();
      await routes.callback(makeReq({ originalUrl: "/auth/callback?code=CODE&state=ETAT", cookies: { dcm_oidc_tx: txValue } }), cbRes);
      const sessionId = CookieHeader.read(cbRes.cookie("dcm_oidc_session").split(";")[0], "dcm_oidc_session");
      ck.eq(sessions.size, 1, "session ouverte avant la déconnexion");

      const res = makeRes();
      await routes.logout(makeReq({ cookies: { dcm_oidc_session: sessionId } }), res);
      ck.eq(sessions.size, 0, "🚨 logout → session DÉTRUITE côté serveur");
      const cleared = res.cookie("dcm_oidc_session");
      ck(cleared !== null && cleared.includes("Max-Age=0"), "🚨 logout → cookie de session EFFACÉ");
      ck(cleared.includes("HttpOnly") && cleared.includes("Secure") && cleared.includes("SameSite=Lax") && cleared.includes("Path=/"),
        "🚨 …avec les MÊMES attributs qu'à la pose (sinon le navigateur garde l'ancien cookie)");
      ck.eq(res.redirectedTo, "https://op.exemple/logout?id_token_hint=ID.TOKEN.BRUT", "logout → end_session_endpoint de l'OP (RP-initiated)");
      ck.eq(client.lastEndSession.idToken, "ID.TOKEN.BRUT", "…avec l'id_token_hint (sans lui, l'OP affiche une confirmation)");
      ck.eq(client.lastEndSession.postLogoutRedirectUrl, "https://dcmanager.exemple/", "…et le retour vers la racine de l'application");
    }

    // -- Logout d'un OP SANS end_session_endpoint → déconnexion LOCALE, retour app. --
    {
      const { routes } = build({ endSessionUrl: null });
      const res = makeRes();
      await routes.logout(makeReq({ cookies: { dcm_oidc_session: "peu-importe" } }), res);
      ck.eq(res.redirectedTo, "https://dcmanager.exemple/", "pas d'end_session_endpoint → retour app (déconnexion locale seule)");
      ck(res.cookie("dcm_oidc_session").includes("Max-Age=0"), "…mais le cookie est effacé DANS TOUS LES CAS");
    }

    // -- 🚨 Logout alors que la DÉCOUVERTE n'a jamais abouti : la déconnexion locale est INCONDITIONNELLE. --
    {
      const { routes, sessions } = build({ ready: false });
      const id = sessions.create({ claims: { sub: "u" } });
      const res = makeRes();
      await routes.logout(makeReq({ cookies: { dcm_oidc_session: id } }), res);
      ck.eq(sessions.size, 0, "🚨 OP injoignable → la session est DÉTRUITE quand même (jamais de 503 sur une déconnexion)");
      ck(res.cookie("dcm_oidc_session").includes("Max-Age=0"), "…et le cookie effacé");
      ck.eq(res.code, 200, "…sans code d'erreur");
    }

    /* -- 🚨 DÉCOUVERTE NON ABOUTIE : le serveur DÉMARRE, /auth/* répond 503 ACTIONNABLE. -- */
    {
      const { routes, client } = build({ ready: false });
      const res = makeRes();
      await routes.login(makeReq(), res);
      ck.eq(res.code, 503, "🚨 login alors que la découverte n'a pas abouti → 503 (et non une exception au boot)");
      ck(String(res.body).includes("OIDC_ISSUER"), "🚨 …message ACTIONNABLE : la variable à vérifier est nommée");
      ck.eq(res.redirectedTo, null, "…aucune redirection");
      ck.eq(client.retries, 1, "🚨 …et une RELANCE de découverte est déclenchée (la reprise ne dépend pas que du minuteur)");

      const cbRes = makeRes();
      await routes.callback(makeReq({ originalUrl: "/auth/callback?code=C&state=E" }), cbRes);
      ck.eq(cbRes.code, 503, "callback aussi → 503");
      ck.eq(client.retries, 2, "…et relance également");
    }

    // -- Le lien « réessayer » des pages d'erreur doit être ABSOLU : servi depuis /auth/callback, un
    //    lien relatif « auth/login » résoudrait vers /auth/auth/login. --
    {
      const { routes } = build({ ready: false });
      const res = makeRes();
      await routes.login(makeReq(), res);
      ck(String(res.body).includes('href="https://dcmanager.exemple/auth/login"'),
        "🚨 lien « réessayer » ANCRÉ sur la racine de l'application (un relatif résoudrait vers /auth/auth/login)");
    }

    // -- Page d'erreur : le texte venu de l'OP est ÉCHAPPÉ (il traverse jusqu'au HTML). --
    {
      const { routes } = build();
      const res = makeRes();
      await routes.callback(makeReq({ originalUrl: "/auth/callback?error=" + encodeURIComponent('<script>alert(1)</script>') }), res);
      ck(!String(res.body).includes("<script>alert"), "🚨 le code d'erreur de l'OP est ÉCHAPPÉ (aucune injection HTML)");
      ck(String(res.body).includes("&lt;script&gt;"), "…et visible sous forme échappée");
    }

    // -- Le login qui échoue AVANT toute redirection (couche perdue en cours de route). --
    {
      const { routes } = build({ beginThrows: true });
      const res = makeRes();
      await routes.login(makeReq(), res);
      ck.eq(res.code, 502, "démarrage de flux impossible → 502 sobre");
      ck.eq(res.redirectedTo, null, "…sans redirection");
    }

    // -- Cookies NON Secure (dev http) : le drapeau est bien piloté par la configuration. --
    {
      const { routes } = build({}, { cookieSecure: false });
      const res = makeRes();
      await routes.login(makeReq(), res);
      const tx = res.cookie(OidcRoutes.TRANSACTION_COOKIE);
      ck(!tx.includes("Secure"), "OIDC_COOKIE_SECURE=0 → cookie SANS Secure (dev http)");
      ck(tx.includes("HttpOnly"), "…mais HttpOnly reste, lui, INCONDITIONNEL");
    }

    // -- WARN de cohérence quand OIDC_REDIRECT_URL ne pointe pas sur notre route. --
    {
      const { log } = build({}, { redirectUrl: "https://dcmanager.exemple/retour" });
      ck(log.lines.some((l) => l.startsWith("warn") && l.includes("OIDC_REDIRECT_URL")),
        "URL de callback incohérente → WARN de boot nommant la variable (sans REFUSER : un proxy peut réécrire le chemin)");
    }
    {
      const { log } = build();
      ck(!log.lines.some((l) => l.startsWith("warn") && l.includes("OIDC_REDIRECT_URL")), "…et aucun WARN quand elle est cohérente");
    }
  });

  /* ==========================================================================
     7. Auth — le câblage du mode par l'orchestrateur
     ========================================================================== */
  await section("Serveur : oidc — Auth (mode oidc : provider + store + routes câblés, couche INJECTÉE, refus fail-closed, quatre autres modes INCHANGÉS)", async () => {
    const { Auth } = SERVER("auth.js");
    const { OidcRoutes } = SERVER("auth/OidcRoutes.js");

    const OIDC_OPTIONS = {
      issuer: "https://op.exemple/realms/infra", clientId: "dcmanager", clientSecret: "",
      scopes: "openid profile email groups", redirectUrl: REDIRECT_URL, cookieSecure: true,
    };
    const buildAuth = (over = {}) => {
      const log = makeLog();
      const factoryCalls = [];
      const auth = new Auth(log, {
        authMode: "oidc", oidc: OIDC_OPTIONS,
        oidcClientFactory: (options) => { factoryCalls.push(options); return makeClient(); },
        ...over,
      });
      return { auth, log, factoryCalls };
    };

    // -- Câblage nominal. --
    {
      const { auth, log, factoryCalls } = buildAuth();
      ck.eq(auth.mode, "oidc", "mode retenu");
      ck(auth.oidcRoutes instanceof OidcRoutes, "🚨 les ROUTES sont exposées — c'est ce que server.ts monte hors de la garde d'API");
      ck.eq(factoryCalls.length, 1, "la couche openid-client est construite UNE fois, par la fabrique injectée");
      ck.eq(factoryCalls[0].issuer, OIDC_OPTIONS.issuer, "…et reçoit l'émetteur configuré");
      ck.eq(factoryCalls[0].clientId, "dcmanager", "…le client");
      ck.eq(factoryCalls[0].redirectUrl, REDIRECT_URL, "…et l'URL de callback");
      ck(log.lines.some((l) => l.startsWith("info") && l.includes("OIDC")), "annonce de boot du mode");
      ck(log.lines.some((l) => l.includes("PUBLIC")), "…qui DIT que le client est public (aucun secret) — information de sécurité");
      ck(!log.lines.some((l) => l.startsWith("warn")), "aucun WARN quand la configuration est saine (Secure actif)");
    }

    // -- Le provider câblé lit bien le cookie de session (bout en bout orchestrateur → provider). --
    {
      const { auth } = buildAuth();
      const anonymous = await auth.validate({ headers: {} });
      ck.eq(anonymous.logged, false, "sans cookie → session ANONYME (substituée par l'orchestrateur)");
      ck.eq(anonymous.user.login, "anonymous", "…la session anonyme canonique");
    }

    // -- 🚨 WARN quand Secure est désactivé : le cookie est un porteur d'identité. --
    {
      const { log } = buildAuth({ oidc: { ...OIDC_OPTIONS, cookieSecure: false } });
      ck(log.lines.some((l) => l.startsWith("warn") && l.includes("OIDC_COOKIE_SECURE")),
        "🚨 OIDC_COOKIE_SECURE=0 → WARN de boot explicite (le cookie circulerait en clair)");
    }

    // -- Client CONFIDENTIEL : l'annonce le dit aussi. --
    {
      const { log } = buildAuth({ oidc: { ...OIDC_OPTIONS, clientSecret: "s3cret" } });
      ck(log.lines.some((l) => l.includes("confidentiel")), "client avec secret → annoncé « confidentiel »");
      ck(!log.lines.some((l) => l.includes("s3cret")), "🚨 …et le SECRET n'apparaît dans AUCUN log");
    }

    /* -- 🚨 FAIL-CLOSED : sans couche injectée, on REFUSE de construire plutôt que de monter un mode
       oidc muet, qui n'authentifierait personne tout en annonçant qu'il protège l'instance. -- */
    {
      let thrown = null;
      try { new Auth(makeLog(), { authMode: "oidc", oidc: OIDC_OPTIONS }); } catch (e) { thrown = e; }
      ck(thrown !== null, "🚨 mode oidc sans couche injectée → le constructeur JETTE");
      ck(String(thrown.message).includes("openid-client"), "…message nommant ce qui manque");
    }
    {
      let thrown = null;
      try { new Auth(makeLog(), { authMode: "oidc", oidcClientFactory: () => makeClient() }); } catch (e) { thrown = e; }
      ck(thrown !== null, "🚨 mode oidc sans configuration → le constructeur JETTE (relais du refus d'AuthModeResolution)");
      ck(String(thrown.message).includes("OIDC_ISSUER"), "…message nommant les variables attendues");
    }

    /* -- NON-RÉGRESSION des quatre autres modes : aucun ne construit de routes, aucun n'appelle la
       fabrique OIDC (un déploiement existant ne doit RIEN voir changer, ni toucher aucun réseau). -- */
    const others = [
      ["dev", { authMode: "dev" }],
      ["basic", { authMode: "basic", basicAuth: "u:p" }],
      ["sso", { authMode: "sso", ssoUrl: "https://sso.exemple/valider" }],
      ["forward", { authMode: "forward" }],
    ];
    for (const [label, options] of others) {
      const factoryCalls = [];
      const auth = new Auth(makeLog(), { ...options, oidc: OIDC_OPTIONS, oidcClientFactory: () => { factoryCalls.push(1); return makeClient(); } });
      ck.eq(auth.mode, label, "mode « " + label + " » inchangé malgré une configuration OIDC présente dans l'environnement");
      ck.eq(auth.oidcRoutes, null, "🚨 mode « " + label + " » → AUCUNE route OIDC montée");
      ck.eq(factoryCalls.length, 0, "🚨 mode « " + label + " » → la couche openid-client n'est JAMAIS construite (aucun réseau)");
    }
    // Et l'inférence historique (AUTH_MODE absente) ne bascule évidemment pas sur oidc.
    const inferred = new Auth(makeLog(), { oidc: OIDC_OPTIONS, oidcClientFactory: () => makeClient() });
    ck.eq(inferred.mode, "dev", "🚨 configuration OIDC SANS AUTH_MODE → dev (oidc n'est jamais inféré)");
    ck.eq(inferred.oidcRoutes, null, "…et aucune route montée");
  });
};
