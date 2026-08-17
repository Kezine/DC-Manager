import * as openid from "openid-client";
import type { Logger } from "../logger.js";
import type { OidcAuthorizationStart, OidcClaims, OidcClientFactoryOptions, OidcClientPort, OidcIdentity } from "./OidcClientPort.js";

/* =============================================================================
   MODE OIDC — ADAPTATEUR `openid-client` : la SEULE implémentation du port.

   🚨 SEUL FICHIER DU DÉPÔT QUI IMPORTE `openid-client`, et le seul de `auth/`
   absent du programme de test (`tsconfig.node.json`). Ce n'est pas une
   commodité, c'est structurel :
   - le paquet est ESM PUR (`"type": "module"`, aucun export CommonJS) alors que
     le programme de test compile en CommonJS — il n'y serait pas chargeable ;
   - il n'est pas installé à la RACINE du dépôt (il vit dans `src-server/`).
   Tout ce que les tests doivent éprouver passe donc par `OidcClientPort`, dont
   un bouchon prend la place. Corollaire à tenir : ce fichier ne doit contenir
   AUCUNE règle propre — il TRADUIT, il ne décide pas. Toute logique qui
   apparaîtrait ici serait, par construction, non testée.

   ── Ce que la librairie fait, et que nous n'écrivons donc PAS ─────────────
   Découverte `.well-known`, récupération et rotation du JWKS, vérification de
   signature de l'`id_token`, contrôle de `iss`/`aud`/`exp`/`iat`, du `nonce` et
   du `state`, génération du verifier PKCE et de son défi S256, échange du code
   sur le canal arrière avec authentification cliente. C'est précisément la
   partie qu'il aurait été fautif de coder à la main (principe n°12) — et la
   raison pour laquelle ce lot dépense sa seule dépendance ici.

   ── DÉCOUVERTE : le serveur DÉMARRE même si l'OP est injoignable ──────────
   Un IdP qui démarre après nous (même `docker compose`), une panne réseau au
   boot, un DNS pas encore prêt : rien de tout cela ne doit empêcher DC Manager
   de servir. La découverte est donc lancée en TÂCHE DE FOND, réessayée avec un
   dos d'âne borné, et `ready()` reste faux tant qu'elle n'a pas abouti — les
   routes répondent alors 503 ACTIONNABLE (patron des modules à clé absente,
   cf. `VmModule`). Les minuteurs sont `unref`és : ils ne retiennent jamais le
   processus à l'arrêt.
   ============================================================================= */

export class OpenIdClientAdapter implements OidcClientPort {
  /** Dos d'âne des réessais de découverte, en millisecondes, puis plafond. Court au début (une
      panne de boot se résorbe souvent en quelques secondes), espacé ensuite (inutile de marteler
      un IdP en difficulté — et la reprise ne dépend de toute façon pas QUE du minuteur : toute
      requête sur `/auth/*` relance une tentative, cf. `retryDiscovery`). */
  static readonly RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
  static readonly RETRY_CAP_MS = 300_000;

  /** Configuration découverte, ou `null` tant que l'OP n'a pas répondu. */
  private configuration: openid.Configuration | null = null;
  /** Découverte EN VOL — empêche les tentatives concurrentes (une requête peut arriver pendant
      qu'un réessai programmé travaille déjà). */
  private inFlight: Promise<void> | null = null;
  private attempts = 0;
  private lastError = "";
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly options: OidcClientFactoryOptions, private readonly log: Logger) {
    // Découverte lancée DÈS LA CONSTRUCTION : c'est le boot, et c'est le moment où l'on veut
    // apprendre que l'IdP est joignable (ou pas) — pas à la première tentative de connexion d'un
    // utilisateur. L'appel n'est pas attendu : le serveur continue de monter pendant ce temps.
    this.retryDiscovery();
  }

  ready(): boolean { return this.configuration !== null; }

  /** Message servi tel quel dans le 503 des routes : il NOMME l'émetteur interrogé et la dernière
      erreur, et rappelle les deux causes qui expliquent l'écrasante majorité des cas (URL fausse,
      émetteur non HTTPS). Un exploitant doit pouvoir corriger sans ouvrir les journaux. */
  unavailableReason(): string {
    return "Le fournisseur d'identité (OIDC_ISSUER = " + this.options.issuer + ") n'a pas encore pu être contacté"
      + (this.lastError ? " — dernière erreur : " + this.lastError : "")
      + ". Vérifier que l'émetteur est joignable depuis le serveur et qu'il est servi en HTTPS"
      + " (la découverte refuse un émetteur en HTTP). Les tentatives se poursuivent automatiquement.";
  }

  /** Relance NON BLOQUANTE. No-op si la découverte a déjà abouti ou si une tentative est en vol. */
  retryDiscovery(): void {
    if (this.configuration || this.inFlight || this.stopped) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.inFlight = this.discover().finally(() => { this.inFlight = null; });
    // La promesse n'est jamais attendue par un appelant : sans ce garde-fou, un rejet deviendrait
    // un `unhandledRejection` (qui tue le process sous Node 15+). `discover` capture déjà tout ;
    // ceci est la ceinture qui va avec les bretelles.
    void this.inFlight.catch(() => {});
  }

  /** Arrête les réessais (extinction). Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  async beginAuthorization(): Promise<OidcAuthorizationStart> {
    const configuration = this.requireConfiguration();
    // Les trois secrets viennent de la LIBRAIRIE (engagement du lot : aucune crypto maison).
    const state = openid.randomState();
    const nonce = openid.randomNonce();
    const codeVerifier = openid.randomPKCECodeVerifier();
    const codeChallenge = await openid.calculatePKCECodeChallenge(codeVerifier);
    const url = openid.buildAuthorizationUrl(configuration, {
      redirect_uri: this.options.redirectUrl,
      scope: this.options.scopes,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return { authorizationUrl: url.href, state, nonce, codeVerifier };
  }

  async completeAuthorization(params: {
    callbackUrl: string;
    expectedState: string;
    expectedNonce: string;
    codeVerifier: string;
  }): Promise<OidcIdentity> {
    const configuration = this.requireConfiguration();
    // `idTokenExpected` est implicite dès qu'`expectedNonce` est fourni, mais on ne s'appuie pas
    // sur un effet de bord documenté ailleurs : sans id_token, il n'y a pas d'identité, et on veut
    // que la librairie le dise plutôt que de nous laisser un `claims()` indéfini à interpréter.
    const tokens = await openid.authorizationCodeGrant(configuration, new URL(params.callbackUrl), {
      expectedState: params.expectedState,
      expectedNonce: params.expectedNonce,
      pkceCodeVerifier: params.codeVerifier,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    // Défense en profondeur : la librairie garantit déjà `sub`, mais c'est la clé canonique de
    // l'annuaire et de l'audit — un `sub` absent produirait un utilisateur `"undefined"` PARTAGÉ
    // par tous. Mieux vaut refuser la connexion que fabriquer une identité fausse.
    if (!claims || typeof claims.sub !== "string" || claims.sub === "") {
      throw new Error("l'id_token ne porte pas de revendication `sub` exploitable");
    }
    return {
      claims: claims as unknown as OidcClaims,
      idToken: tokens.id_token,
      // `exp` est en SECONDES (unité du protocole) ; tout le reste de l'application compte en
      // millisecondes. La conversion se fait ICI, en UN point, à la frontière.
      expiresAt: typeof claims.exp === "number" ? claims.exp * 1000 : undefined,
    };
  }

  endSessionUrl(params: { idToken?: string; postLogoutRedirectUrl: string }): string | null {
    if (!this.configuration) return null;
    // L'OP n'annonce pas d'`end_session_endpoint` → il n'y a PAS de déconnexion RP-initiated à
    // proposer. On rend `null` plutôt que de laisser la librairie jeter : « cet OP ne sait pas
    // faire » n'est pas une erreur, c'est une capacité absente (limite documentée).
    if (!this.configuration.serverMetadata().end_session_endpoint) return null;
    const parameters: Record<string, string> = { post_logout_redirect_uri: params.postLogoutRedirectUrl };
    if (params.idToken) parameters.id_token_hint = params.idToken;
    // Sans `id_token_hint`, la plupart des OP exigent `client_id` pour savoir de quelle
    // application vient la demande (et valider l'URI de retour) — sans quoi ils affichent une
    // page de confirmation, voire refusent la redirection.
    else parameters.client_id = this.options.clientId;
    try { return openid.buildEndSessionUrl(this.configuration, parameters).href; }
    catch (e) { this.log.warn("auth", "OIDC : composition de l'URL de déconnexion impossible", OpenIdClientAdapter.messageOf(e)); return null; }
  }

  /** UNE tentative de découverte. Ne jette JAMAIS : elle réussit (et pose la configuration) ou
      programme le réessai suivant. */
  private async discover(): Promise<void> {
    this.attempts++;
    try {
      const issuer = new URL(this.options.issuer);
      // CLIENT PUBLIC vs CONFIDENTIEL — la seule branche de ce fichier, et elle est imposée par la
      // signature de la librairie : sans secret, la méthode d'authentification cliente doit être
      // explicitement `None()` (le défaut est `ClientSecretPost`, qui exigerait un secret).
      // PKCE, lui, est employé dans les DEUX cas : il protège l'échange du code, pas le client.
      this.configuration = this.options.clientSecret
        ? await openid.discovery(issuer, this.options.clientId, this.options.clientSecret)
        : await openid.discovery(issuer, this.options.clientId, undefined, openid.None());
      this.lastError = "";
      this.attempts = 0;
      const metadata = this.configuration.serverMetadata();
      this.log.info("auth", "OIDC : découverte réussie", metadata.issuer,
        metadata.end_session_endpoint ? "(déconnexion RP-initiated disponible)" : "(pas d'end_session_endpoint — déconnexion locale seule)");
    } catch (e) {
      this.lastError = OpenIdClientAdapter.messageOf(e);
      this.scheduleRetry();
    }
  }

  /** Programme le réessai suivant (dos d'âne borné, minuteur `unref`é). */
  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = OpenIdClientAdapter.RETRY_DELAYS_MS[Math.min(this.attempts - 1, OpenIdClientAdapter.RETRY_DELAYS_MS.length - 1)]
      ?? OpenIdClientAdapter.RETRY_CAP_MS;
    const wait = Math.min(delay, OpenIdClientAdapter.RETRY_CAP_MS);
    this.log.warn("auth", "OIDC : découverte de " + this.options.issuer + " impossible (" + this.lastError
      + ") — nouvelle tentative dans " + Math.round(wait / 1000) + " s. Le serveur reste démarré ; /auth/* répond 503.");
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.retryDiscovery(); }, wait);
    // `unref` : un réessai en attente ne doit pas retenir le processus au `SIGTERM`.
    if (typeof this.retryTimer === "object" && this.retryTimer && typeof (this.retryTimer as any).unref === "function") {
      (this.retryTimer as any).unref();
    }
  }

  /** Configuration ou exception explicite. Les routes vérifient `ready()` AVANT d'appeler, mais un
      appel direct ne doit pas produire un `TypeError` sur `null` : le message doit dire la vérité. */
  private requireConfiguration(): openid.Configuration {
    if (!this.configuration) throw new Error("découverte OIDC non aboutie : " + this.unavailableReason());
    return this.configuration;
  }

  private static messageOf(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }
}
