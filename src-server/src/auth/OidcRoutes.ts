import { CookieHeader } from "./CookieHeader.js";       // lecture/composition des en-têtes de cookie (helper du dossier)
import { SecretCompare } from "./SecretCompare.js";     // comparaison à TEMPS CONSTANT (helper partagé basic/forward)
import { OidcAuthProvider } from "./OidcAuthProvider.js";   // POUR SON NOM DE COOKIE — cf. `sessionCookieName` (aucun cycle : le provider ignore ce fichier)
import type { Logger } from "../logger.js";
import type { OidcClaims, OidcClientPort } from "./OidcClientPort.js";
import type { OidcSessionStore } from "./OidcSessionStore.js";

/* =============================================================================
   MODE OIDC — LE FLUX (responsabilité 3/3 du mode) : login, callback, logout.

   Trois points d'entrée HTTP, montés par `server.ts` HORS de la garde d'API,
   comme `/healthz` — et pour la même raison : ils doivent être joignables par
   quelqu'un qui n'est PAS authentifié. Une route de connexion derrière une
   garde d'authentification serait un verrou dont la clé est à l'intérieur.

   ┌ GET /auth/login ────────────────────────────────────────────────────────┐
   │ génère state + nonce + PKCE (par la LIBRAIRIE, cf. `OidcClientPort`),    │
   │ les dépose dans un cookie de TRANSACTION court, redirige vers l'OP       │
   ├ GET /auth/callback ─────────────────────────────────────────────────────┤
   │ vérifie state, échange le code par le CANAL ARRIÈRE (+ verifier PKCE),   │
   │ la librairie valide l'id_token → session créée, cookie posé, retour app  │
   ├ GET /auth/logout ───────────────────────────────────────────────────────┤
   │ détruit la session, efface le cookie, puis end_session_endpoint de l'OP  │
   │ s'il en annonce un (RP-initiated), sinon retour app                      │
   └─────────────────────────────────────────────────────────────────────────┘

   ── Pourquoi ce fichier n'importe PAS Express ─────────────────────────────
   Il déclare ses propres vues MINIMALES de la requête et de la réponse, dont
   les types d'Express sont des sur-ensembles STRUCTURELS — exactement la
   doctrine d'`AccessControl` et d'`AuthProvider`, avec les mêmes bénéfices, et
   ici un troisième qui est décisif : c'est ce qui rend le flux TESTABLE. Un
   flux OIDC complet exige un OP réel ; les propriétés qui comptent, elles
   (« un state faux est refusé », « le cookie posé est HttpOnly », « la
   déconnexion efface le cookie »), sont vérifiables ici et maintenant avec une
   requête et une réponse factices et un bouchon de `OidcClientPort`.
   `server.ts` ne garde donc que le BRANCHEMENT — trois lignes, l'idiome des
   « fins branchements » du principe n°2.

   ── 🚨 L'URL de callback ne se DEVINE pas, elle se CONFIGURE ──────────────
   L'URL passée à la librairie est composée à partir d'`OIDC_REDIRECT_URL` (la
   valeur configurée, publique et absolue) + la chaîne de requête REÇUE. On ne
   reconstruit RIEN à partir de `Host` ou de `X-Forwarded-*` : ces en-têtes
   viennent du réseau, et une URL de callback dérivée d'un en-tête forgeable
   est un classique de la littérature (empoisonnement d'hôte). La valeur
   configurée est aussi celle qui est déclarée chez l'OP : les deux ne peuvent
   pas diverger.
   ============================================================================= */

/** Vue MINIMALE d'une requête. Le `Request` d'Express en est un sur-ensemble structurel. */
export interface OidcRequestView {
  headers: { cookie?: string | string[]; [name: string]: string | string[] | undefined };
  /** URL d'origine, chemin + chaîne de requête (`req.originalUrl`). Seule la CHAÎNE DE REQUÊTE en
      est lue — le chemin est ignoré, puisque l'URL de callback vient de la configuration. */
  originalUrl?: string;
  /** Repli quand `originalUrl` est absent (appelant non-Express, test). */
  url?: string;
}

/** Vue MINIMALE de la réponse : rediriger, poser des en-têtes, refuser. Le `Response` d'Express en
    est un sur-ensemble structurel (ses signatures surchargées satisfont celles-ci). */
export interface OidcResponseView {
  status(code: number): OidcResponseView;
  setHeader(name: string, value: string | string[]): unknown;
  redirect(url: string): unknown;
  send(body: string): unknown;
}

/** Les trois secrets d'une transaction en cours, tels qu'ils voyagent dans le cookie court. */
interface OidcTransaction { state: string; nonce: string; codeVerifier: string }

export class OidcRoutes {
  /* -- Chemins servis. Ils vivent ICI (le module possède ses routes) et `server.ts` comme
        `index.ts` les LISENT — aucun chemin d'authentification n'est écrit deux fois. -- */
  static readonly PATH_LOGIN = "/auth/login";
  static readonly PATH_CALLBACK = "/auth/callback";
  static readonly PATH_LOGOUT = "/auth/logout";

  /** Cookie de TRANSACTION : porte state + nonce + verifier PKCE entre le départ et le retour. */
  static readonly TRANSACTION_COOKIE = "dcm_oidc_tx";

  /** Durée de vie du cookie de transaction. 10 minutes : le temps de s'authentifier chez l'OP,
      MFA comprise, et pas davantage — une transaction qui traîne est une transaction abandonnée. */
  static readonly TRANSACTION_TTL_SECONDS = 600;

  /** Valeur à injecter au client comme `loginUrl` quand `SSO_LOGIN_URL` est vide (cf. `index.ts`).
      RELATIVE, sans slash initial : toutes les URLs du client sont ancrées sur le `<base>` du HTML
      (cf. user-docs/reverse-proxy.md), exactement comme `apiBaseUrl` que `server.ts` dérive de la même
      façon (`"/api"` → `"api"`). Une valeur absolue casserait le déploiement en sous-dossier. */
  static readonly DEFAULT_CLIENT_LOGIN_URL = OidcRoutes.PATH_LOGIN.replace(/^\/+/, "");

  /** Racine de l'application, DÉDUITE de l'URL de callback configurée (cf. le constructeur). */
  private readonly appRootUrl: string;

  /** URL de la route de login, ANCRÉE sur la racine ci-dessus — celle du lien « réessayer ».

      🚨 Elle ne peut PAS être la valeur relative `auth/login` : la page d'erreur est servie sur
      `/auth/callback`, dont le répertoire de base est `/auth/` — un lien relatif y résoudrait vers
      `/auth/auth/login`. C'est le genre de défaut qui ne se voit qu'au moment précis où l'on est
      déjà en train de diagnostiquer autre chose. */
  private readonly loginUrl: string;

  /** @param client    Couche `openid-client` INJECTÉE (bouchon en test) — cf. `OidcClientPort`.
      @param sessions  Table des sessions, PARTAGÉE avec le provider : ici on crée et on détruit.
      @param options   `redirectUrl` (publique absolue) + `cookieSecure` (`OIDC_COOKIE_SECURE`).
      @param log       Journal, sous le scope `auth`. */
  constructor(
    private readonly client: OidcClientPort,
    private readonly sessions: OidcSessionStore<OidcClaims>,
    private readonly options: { redirectUrl: string; cookieSecure: boolean },
    private readonly log: Logger,
  ) {
    this.appRootUrl = OidcRoutes.deduceAppRoot(options.redirectUrl);
    this.loginUrl = this.appRootUrl + OidcRoutes.DEFAULT_CLIENT_LOGIN_URL;
    // Contrôle de COHÉRENCE au boot plutôt qu'au premier échec de connexion : une URL de callback
    // qui ne pointe pas sur NOTRE route produirait chez l'OP un `redirect_uri_mismatch` opaque,
    // ou pire, un retour sur une page qui ne sait pas terminer la transaction. On le dit tout de
    // suite, en nommant la valeur attendue — sans REFUSER de démarrer : l'exploitant peut avoir un
    // proxy qui réécrit le chemin, cas légitime que le code ne peut pas départager d'une faute.
    if (!options.redirectUrl.endsWith(OidcRoutes.PATH_CALLBACK)) {
      this.log.warn("auth", "⚠ OIDC_REDIRECT_URL (" + options.redirectUrl + ") ne se termine pas par "
        + OidcRoutes.PATH_CALLBACK + " — c'est le chemin que cette application SERT ; vérifier l'URL"
        + " déclarée chez l'OP, sauf si un proxy réécrit délibérément ce chemin.");
    }
  }

  /* =========================================================================
     GET /auth/login — départ du flux
     ========================================================================= */
  async login(_req: OidcRequestView, res: OidcResponseView): Promise<void> {
    if (!this.ensureReady(res)) return;
    try {
      const start = await this.client.beginAuthorization();
      // Les trois secrets partent dans un cookie HttpOnly. Le state y est l'ANCRE anti-CSRF :
      // au retour, un `state` qui ne correspond pas à CE cookie n'est pas notre transaction.
      const transaction: OidcTransaction = { state: start.state, nonce: start.nonce, codeVerifier: start.codeVerifier };
      res.setHeader("Set-Cookie", CookieHeader.serialize(
        OidcRoutes.TRANSACTION_COOKIE,
        OidcRoutes.encodeTransaction(transaction),
        { ...this.cookieAttributes(), maxAgeSeconds: OidcRoutes.TRANSACTION_TTL_SECONDS },
      ));
      res.redirect(start.authorizationUrl);
    } catch (e) {
      // L'échec est journalisé COMPLET et rendu SOBRE : le message d'une librairie de protocole
      // peut nommer des endpoints internes, et l'appelant n'est pas authentifié.
      this.log.error("auth", "OIDC : démarrage du flux impossible", OidcRoutes.messageOf(e));
      this.errorPage(res, 502, "La connexion n'a pas pu démarrer.", "Le fournisseur d'identité n'a pas répondu comme attendu.");
    }
  }

  /* =========================================================================
     GET /auth/callback — retour de l'OP
     ========================================================================= */
  async callback(req: OidcRequestView, res: OidcResponseView): Promise<void> {
    if (!this.ensureReady(res)) return;
    const query = OidcRoutes.queryOf(req);
    const parameters = new URLSearchParams(query);

    // 1. L'OP a-t-il REFUSÉ ? (`error=access_denied` quand l'utilisateur annule, entre autres.)
    //    C'est une réponse NORMALE du protocole, pas une panne : page sobre, jamais une exception.
    const opError = parameters.get("error");
    if (opError) {
      this.log.warn("auth", "OIDC : l'OP a refusé la demande d'autorisation", opError, parameters.get("error_description") || "");
      this.clearTransaction(res);
      this.errorPage(res, 401, "Connexion refusée par le fournisseur d'identité.", "Code : " + opError);
      return;
    }

    // 2. Retrouver la transaction. Cookie absent = flux jamais commencé ici, ou expiré (10 min), ou
    //    ouvert dans un autre navigateur. On NE redirige PAS vers /auth/login : ce serait une boucle
    //    en puissance dès que le cookie ne peut pas être posé (cookies bloqués, `Secure` en http).
    const transaction = OidcRoutes.decodeTransaction(CookieHeader.read(req.headers.cookie, OidcRoutes.TRANSACTION_COOKIE));
    if (!transaction) {
      this.errorPage(res, 400, "Transaction de connexion introuvable ou expirée.",
        "Le cookie de transaction est absent. Si votre navigateur bloque les cookies, ou si l'application est servie en HTTP avec OIDC_COOKIE_SECURE=1, la connexion ne peut pas aboutir.");
      return;
    }

    // 3. STATE : comparé à TEMPS CONSTANT (le state est l'anti-CSRF du flux — un secret à usage
    //    unique, pas un identifiant public). La librairie le revérifiera de son côté ; ce contrôle
    //    est en AMONT, délibérément, pour refuser sans avoir engagé le moindre appel sortant.
    const returnedState = parameters.get("state") || "";
    if (!SecretCompare.equals(returnedState, transaction.state)) {
      this.log.warn("auth", "OIDC : `state` du retour ne correspond pas à la transaction — refus (CSRF possible)");
      this.clearTransaction(res);
      this.errorPage(res, 400, "Réponse de connexion incohérente.", "Le paramètre de sécurité `state` ne correspond pas à la demande de départ.");
      return;
    }

    // 4. Échange + validation (canal ARRIÈRE) — tout se passe dans la librairie.
    try {
      const identity = await this.client.completeAuthorization({
        callbackUrl: this.callbackUrlWith(query),
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
      });
      const sessionId = this.sessions.create({ claims: identity.claims, expiresAt: identity.expiresAt, idToken: identity.idToken });
      const session = this.sessions.get(sessionId);
      // Durée du cookie ALIGNÉE sur celle de la session serveur (le store a pu borner l'échéance
      // annoncée par l'OP) : un cookie qui survivrait à sa session ne produirait que des 401.
      const maxAge = session ? Math.max(1, Math.round((session.expiresAt - Date.now()) / 1000)) : OidcRoutes.TRANSACTION_TTL_SECONDS;
      res.setHeader("Set-Cookie", [
        CookieHeader.serialize(OidcRoutes.sessionCookieName(), sessionId, { ...this.cookieAttributes(), maxAgeSeconds: maxAge }),
        CookieHeader.expire(OidcRoutes.TRANSACTION_COOKIE, this.cookieAttributes()),   // la transaction est CONSOMMÉE
      ]);
      this.log.info("auth", "OIDC : session ouverte pour", String(identity.claims.sub));
      res.redirect(this.appRootUrl);
    } catch (e) {
      this.log.error("auth", "OIDC : échange du code impossible", OidcRoutes.messageOf(e));
      this.clearTransaction(res);
      this.errorPage(res, 401, "La connexion n'a pas pu aboutir.", "L'échange avec le fournisseur d'identité a échoué ou la réponse n'a pas pu être validée.");
    }
  }

  /* =========================================================================
     GET /auth/logout — déconnexion
     ========================================================================= */
  async logout(req: OidcRequestView, res: OidcResponseView): Promise<void> {
    // 🚨 La déconnexion LOCALE est INCONDITIONNELLE : elle réussit même si la découverte n'a jamais
    // abouti. Répondre 503 ici laisserait une session ouverte sur une instance en difficulté —
    // l'inverse exact de ce qu'un utilisateur qui clique « déconnexion » demande.
    const destroyed = this.sessions.destroy(CookieHeader.read(req.headers.cookie, OidcRoutes.sessionCookieName()));
    res.setHeader("Set-Cookie", CookieHeader.expire(OidcRoutes.sessionCookieName(), this.cookieAttributes()));

    // Déconnexion RP-initiated : on PROPOSE à l'OP de fermer sa propre session. Sans
    // `end_session_endpoint` annoncé, la session de l'OP survit et un nouveau login serait
    // silencieusement ré-authentifié — limite du protocole, documentée, pas un défaut du code.
    let endSession: string | null = null;
    if (this.client.ready()) {
      try { endSession = this.client.endSessionUrl({ idToken: destroyed?.idToken, postLogoutRedirectUrl: this.appRootUrl }); }
      catch (e) { this.log.warn("auth", "OIDC : URL de déconnexion inutilisable, déconnexion locale seule", OidcRoutes.messageOf(e)); }
    }
    res.redirect(endSession || this.appRootUrl);
  }

  /* =========================================================================
     Outillage interne
     ========================================================================= */

  /** Nom du cookie de session. Il APPARTIENT au provider — c'est lui qui le lit à chaque requête —
      et les routes le relisent CHEZ LUI plutôt que d'en garder une copie : deux littéraux qui
      doivent rester égaux finissent toujours par ne plus l'être, et la panne serait muette (des
      connexions qui « ne prennent pas »). L'import ne crée aucun cycle : `OidcAuthProvider`
      n'importe pas ce fichier. */
  private static sessionCookieName(): string { return OidcAuthProvider.COOKIE_NAME; }

  /** Attributs COMMUNS des cookies du mode (session et transaction) : la pose et l'effacement
      doivent porter EXACTEMENT les mêmes, sinon le navigateur y voit deux cookies distincts. */
  private cookieAttributes(): { httpOnly: true; secure: boolean; sameSite: "Lax"; path: "/" } {
    return { httpOnly: true, secure: this.options.cookieSecure, sameSite: "Lax", path: "/" };
  }

  /** La couche est-elle prête ? Sinon : relance NON BLOQUANTE + 503 ACTIONNABLE, et `false`.
      C'est le patron des modules à clé absente (cf. `VmModule`) : un prérequis externe manquant
      n'a jamais le droit de faire tomber le serveur — il rend UNE fonctionnalité indisponible,
      avec un message qui dit quoi corriger. */
  private ensureReady(res: OidcResponseView): boolean {
    if (this.client.ready()) return true;
    this.client.retryDiscovery();
    this.errorPage(res, 503, "Connexion indisponible.", this.client.unavailableReason());
    return false;
  }

  /** Efface le cookie de transaction (échec de flux) — une transaction ratée ne doit pas rester
      posée : elle serait re-présentée au prochain retour et brouillerait le diagnostic. */
  private clearTransaction(res: OidcResponseView): void {
    res.setHeader("Set-Cookie", CookieHeader.expire(OidcRoutes.TRANSACTION_COOKIE, this.cookieAttributes()));
  }

  /** URL de callback COMPLÈTE remise à la librairie : la valeur CONFIGURÉE + la chaîne de requête
      reçue. Cf. l'en-tête : aucun en-tête réseau n'entre dans cette composition. */
  private callbackUrlWith(query: string): string {
    return query ? this.options.redirectUrl + "?" + query : this.options.redirectUrl;
  }

  /** Page d'erreur SOBRE (HTML), avec un lien « réessayer » et JAMAIS de redirection automatique :
      une redirection sur échec de connexion produit des boucles login → erreur → login que rien
      n'arrête côté navigateur. Le détail est échappé — il peut contenir du texte venu de l'OP. */
  private errorPage(res: OidcResponseView, code: number, title: string, detail: string): void {
    const html = "<!doctype html><html lang=\"fr\"><meta charset=\"utf-8\">"
      + "<title>" + OidcRoutes.escapeHtml(title) + "</title>"
      + "<style>body{font-family:system-ui,sans-serif;margin:3rem auto;max-width:40rem;padding:0 1rem;line-height:1.5}"
      + "h1{font-size:1.25rem}p{color:#444}a{color:#06c}</style>"
      + "<h1>" + OidcRoutes.escapeHtml(title) + "</h1>"
      + "<p>" + OidcRoutes.escapeHtml(detail) + "</p>"
      + "<p><a href=\"" + OidcRoutes.escapeHtml(this.loginUrl) + "\">Réessayer la connexion</a></p>"
      + "</html>";
    res.status(code);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  }

  /** Racine de l'application, déduite de l'URL de callback : `…/auth/callback` → `…/`.

      `new URL("../", base)` remonte les DEUX segments (`callback`, puis `auth`) — c'est la
      résolution d'URL standard qui fait le travail, pas une découpe de chaîne à la main. Cette
      racine sert de destination après connexion ET de `post_logout_redirect_uri` : elle est donc
      cohérente avec ce qui est déclaré chez l'OP, par construction. Une URL inexploitable retombe
      sur `/` — le comportement d'avant ce lot, jamais une exception au boot. */
  private static deduceAppRoot(redirectUrl: string): string {
    try { return new URL("../", redirectUrl).toString(); } catch { return "/"; }
  }

  /** Chaîne de requête de la requête reçue (sans le `?`). */
  private static queryOf(req: OidcRequestView): string {
    const raw = String(req.originalUrl ?? req.url ?? "");
    const mark = raw.indexOf("?");
    return mark < 0 ? "" : raw.slice(mark + 1);
  }

  /** Transaction → valeur de cookie (JSON en base64url : compact et sans caractère à échapper). */
  private static encodeTransaction(transaction: OidcTransaction): string {
    return Buffer.from(JSON.stringify(transaction), "utf8").toString("base64url");
  }

  /** Valeur de cookie → transaction, ou `null` si elle est absente, illisible ou incomplète.
      Tout écart rend `null` : une transaction à demi lue serait pire qu'absente, puisqu'elle
      ferait échouer la validation plus loin avec un message sans rapport. */
  private static decodeTransaction(raw: string | null): OidcTransaction | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
      const { state, nonce, codeVerifier } = parsed || {};
      if (typeof state !== "string" || typeof nonce !== "string" || typeof codeVerifier !== "string") return null;
      if (state === "" || nonce === "" || codeVerifier === "") return null;
      return { state, nonce, codeVerifier };
    } catch { return null; }
  }

  /** Échappement HTML minimal des cinq caractères qui comptent dans du texte et des attributs.
      Écrit ici plutôt qu'importé : `src-shared/` et `src-client/` en ont leurs propres versions,
      et `src-server/` n'a pas le droit d'importer l'un ni l'autre côté DOM (cf. CLAUDE.md). */
  private static escapeHtml(text: string): string {
    return String(text)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /** Message d'une exception, quelle que soit sa forme. */
  private static messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }
}
