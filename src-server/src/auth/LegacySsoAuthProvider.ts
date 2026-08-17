import { Logger } from "../logger.js";
import { ANONYMOUS_SESSION, type AuthProvider, type AuthRequestView, type SsoResult } from "./AuthProvider.js";

/* =============================================================================
   MODE SSO MAISON (« legacy ») — l'application NE GÈRE PAS le login : elle
   PROXIFIE le jeton de session (cookie `cookieName`) à un endpoint `ssoUrl` qui
   répond `{ logged, adminRight, expireDate, user }`.

   ⚠️ Ce contrat répond à un BESOIN PERSONNEL et est peu réutilisable tel quel :
   c'est pour cela qu'il s'appelle « legacy » et qu'il est devenu UN provider
   parmi d'autres au lieu d'être LE mode d'authentification. Les modes standards
   (en-têtes d'un reverse-proxy *identity-aware*, OIDC) s'ajouteront à côté, sans
   le toucher — c'est tout l'objet de la découpe.

   PASSTHROUGH INTÉGRAL : le JSON du SSO est rendu TEL QUEL (les champs que nous
   ne connaissons pas compris — cf. l'index de signature de `SsoResult`). C'est
   `GET /me` qui les fait traverser jusqu'au client, et un déploiement peut en
   dépendre : ne rien normaliser ici est un ENGAGEMENT, pas une paresse.

   FAIL-CLOSED : SSO injoignable, en erreur HTTP ou répondant autre chose qu'un
   objet → session ANONYME. Jamais de repli permissif — une panne d'annuaire ne
   doit pas ouvrir l'application, et la mise en cache courte de cet anonyme
   (orchestrateur) évite de marteler un service déjà en difficulté.

   Le CACHE, lui, n'est pas ici : il appartient à l'orchestrateur (`../auth.ts`),
   qui l'applique à tout provider sachant nommer la session présentée
   (`sessionKey`). Ce provider n'a donc AUCUN état.
   ============================================================================= */
export class LegacySsoAuthProvider implements AuthProvider {
  /** @param log         Journal (le même que l'orchestrateur : les lignes restent sous le scope `auth`).
      @param ssoUrl      Endpoint de validation du jeton (`SSO_URL`).
      @param cookieName  Nom du cookie portant le jeton (`COOKIE_NAME`) ; VIDE = on proxifie
                         l'en-tête `Cookie` COMPLET, tel quel.
      @param fetchImpl   `fetch` INJECTÉ (stub en test — aucun réseau), patron
                         `notify/WebhookNotifier` et `tracker/JiraHttp`. */
  constructor(
    private readonly log: Logger,
    private readonly ssoUrl: string,
    private readonly cookieName: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** JETON présenté = valeur du cookie `cookieName`, ou l'en-tête `Cookie` entier quand aucun nom
      n'est configuré. C'est aussi la CLÉ DE CACHE de l'orchestrateur (qui la hache) : la même
      valeur identifie la même session, par construction. */
  sessionKey(req: AuthRequestView): string | null {
    const raw = req.headers.cookie || "";
    if (!this.cookieName) return raw || null;
    // Le nom du cookie vient de la CONFIGURATION, mais il entre dans une expression régulière :
    // on l'échappe, sinon un nom contenant `.` ou `+` matcherait des cookies voisins.
    const found = raw.match(new RegExp("(?:^|;\\s*)" + this.cookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)"));
    return found ? decodeURIComponent(found[1]) : null;
  }

  /** Aucun jeton présenté → `null` (anonyme) SANS appel sortant : il n'y a rien à valider. */
  async authenticate(req: AuthRequestView): Promise<SsoResult | null> {
    const token = this.sessionKey(req);
    if (!token) return null;
    const result = await this.fetchSso(token);
    this.log.debug("SSO validé", (result.user && result.user.login) || "?", "logged=" + result.logged, "right=" + result.adminRight);
    return result;
  }

  /** Appel au SSO avec le cookie ATTENDU par lui (reconstitué à partir du jeton, ou proxifié tel
      quel quand aucun nom n'est configuré). Toute défaillance rend la session anonyme. */
  private async fetchSso(token: string): Promise<SsoResult> {
    const cookie = this.cookieName ? (this.cookieName + "=" + token) : token;
    try {
      const response = await this.fetchImpl(this.ssoUrl, { headers: { cookie, accept: "application/json" } });
      if (!response.ok) { this.log.warn("SSO HTTP", response.status); return ANONYMOUS_SESSION; }
      const data = await response.json();
      return (data && typeof data === "object") ? (data as SsoResult) : ANONYMOUS_SESSION;
    } catch (e: any) {
      // L'URL est journalisée (diagnostic), JAMAIS le jeton : c'est un secret de session.
      this.log.error("SSO injoignable", this.ssoUrl, e && e.message);
      return ANONYMOUS_SESSION;
    }
  }
}
