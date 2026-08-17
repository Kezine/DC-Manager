import { CookieHeader } from "./CookieHeader.js";       // lecture de l'en-tête `Cookie` (helper du dossier)
import { GroupList } from "./GroupList.js";             // nettoyage des groupes — MÊME règle que le mode forward
import type { AuthProvider, AuthRequestView, SsoResult, SsoUser } from "./AuthProvider.js";
import type { OidcClaims } from "./OidcClientPort.js";
import type { OidcSessionStore } from "./OidcSessionStore.js";

/* =============================================================================
   MODE OIDC — PROVIDER (responsabilité 2/3 du mode).

   L'application est un RP (*Relying Party*) : elle parle elle-même OIDC à un OP
   (Keycloak, Entra ID, Authelia en mode OP…) en flux *Authorization Code + PKCE*.
   Ce fichier tient la partie la plus simple, et c'est VOULU : une fois le flux
   terminé (cf. `OidcRoutes`), authentifier une requête revient à lire un cookie
   et à consulter une table mémoire. Aucune E/S, aucun appel sortant, aucun
   jeton à valider — la validation a eu lieu UNE fois, à la création de session.

   ── Ce que ce provider NE fait PAS, et pourquoi ───────────────────────────
   - AUCUN `sessionKey`, donc aucune mise en cache par l'orchestrateur. Le
     contrat réserve le cache aux providers qui ÉVITENT ainsi un appel réseau
     (cf. `AuthProvider.sessionKey`) ; ici la résolution est un `Map.get`. Un
     cache par-dessus n'économiserait rien et ajouterait une fenêtre pendant
     laquelle une session DÉTRUITE (déconnexion) resterait valide — soit
     exactement le défaut qu'on ne veut pas. Même raisonnement que dev, basic et
     forward, pour une raison différente : eux n'ont rien à mettre en cache,
     nous avons quelque chose à NE PAS mettre en cache.
   - AUCUN `adminRight`. L'autorisation passe par les RÔLES (`roles.json`,
     `BOOTSTRAP_ADMIN_IDS`) : poser `SUPER_ADMIN` ferait de tout utilisateur de
     l'IdP un administrateur. La rétrocompatibilité du SSO maison est une règle
     de POLITIQUE (`access/FileRoleProvider`), jamais un modèle à copier — même
     position que le mode forward.

   ── L'identité, revendication par revendication ───────────────────────────
   `user.id` = `String(sub)` : `sub` est la SEULE revendication qu'un OP garantit
   stable et unique. C'est donc lui, et pas l'e-mail (qui change) ni le login
   (qui se réattribue), qui sert de clé canonique à l'annuaire et à l'audit
   (cf. `users/UserProfiles`, `RequestAuthor`).
   `user.nom` reçoit le nom d'affichage COMPLET (`name`) sans le découper :
   arbitrage déjà tranché au lot 4 pour le mode forward, et pour la même raison —
   couper à l'espace inventerait une structure fausse pour tout nom composé.
   ============================================================================= */

export class OidcAuthProvider implements AuthProvider {
  /** Nom du cookie de session. Préfixe `dcm_` comme le reste de l'application ; il est SERVEUR
      (HttpOnly) et n'apparaît nulle part côté client. */
  static readonly COOKIE_NAME = "dcm_oidc_session";

  /** Domaine posé sur l'utilisateur : d'où vient cette identité, en un mot. Distingue une session
      OIDC d'une session de proxy ou du SSO maison dans les journaux comme dans `/me`. */
  static readonly DOMAIN = "oidc";

  /** @param sessions  Table des sessions, PARTAGÉE avec les routes : elles créent et détruisent,
      ce provider ne fait que lire. C'est la seule chose que les deux ont en commun, et elle est
      injectée plutôt qu'importée — les routes restent supprimables sans toucher au provider. */
  constructor(private readonly sessions: OidcSessionStore<OidcClaims>) {}

  /** Identité portée par le cookie de session, ou `null` (anonyme).

      Les trois cas — cookie absent, identifiant inconnu, session expirée — se répondent de façon
      IDENTIQUE : `null`. Distinguer « expirée » d'« inconnue » dans la réponse HTTP renseignerait
      un attaquant sur la validité d'un identifiant deviné, sans rien apporter à l'utilisateur
      légitime, dont le client sait déjà quoi faire d'un 401 (cf. `SessionExpiry`). */
  async authenticate(req: AuthRequestView): Promise<SsoResult | null> {
    const session = this.sessions.get(CookieHeader.read(req.headers.cookie, OidcAuthProvider.COOKIE_NAME));
    if (!session) return null;
    const claims = session.claims;
    const user: SsoUser = { id: String(claims.sub), domain: OidcAuthProvider.DOMAIN };
    // LOGIN : `preferred_username` d'abord (c'est le nom que l'utilisateur connaît de lui-même),
    // e-mail à défaut. Aucun repli sur `sub` : un identifiant opaque affiché comme login serait
    // illisible dans l'annuaire et dans l'audit — mieux vaut un login absent, que la couche
    // d'affichage sait remplacer par le nom ou l'identifiant (cf. users/UserProfiles).
    const login = OidcAuthProvider.text(claims.preferred_username) || OidcAuthProvider.text(claims.email);
    if (login !== "") user.login = login;
    const email = OidcAuthProvider.text(claims.email);
    if (email !== "") user.eMail = email;
    const name = OidcAuthProvider.text(claims.name);
    if (name !== "") user.nom = name;
    // `groups` est TOUJOURS présent (tableau, éventuellement vide) : « ce provider fournit des
    // groupes, et l'IdP n'en a donné aucun » n'est pas la même information qu'un champ absent —
    // même engagement que le mode forward, et MÊME règle de nettoyage (helper partagé `GroupList`).
    return {
      user,
      logged: true,
      groups: GroupList.normalize(claims.groups),
      // Échéance de la SESSION (pas celle de l'`id_token`) : c'est elle que le client doit croire,
      // puisque c'est elle qui décidera du 401. En millisecondes, comme `Date.now()` — l'unité
      // qu'attendent `Auth.expiryOf` et le client.
      expireDate: session.expiresAt,
    };
  }

  /* Pas de `sessionKey` : rien à mettre en cache, et surtout rien à FAIRE SURVIVRE à une
     déconnexion (cf. l'en-tête). L'absence de la méthode SUFFIT — le contrat la déclare
     optionnelle précisément pour ça. */

  /** Valeur textuelle rognée d'une revendication, ou chaîne vide. Une revendication peut arriver
      dans n'importe quel type (un OP mal configuré pousse un nombre, un tableau, `null`) : on ne
      convertit QUE les chaînes, plutôt que de risquer un `"[object Object]"` en guise de login. */
  private static text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }
}
