/* =============================================================================
   MODE OIDC — CONFIGURATION (classe PURE, aucun import).

   Les SIX variables d'environnement du mode `oidc` n'existent QU'ICI (principe
   n°3, patron `ForwardHeaderAuthProvider.optionsFromEnv` / `FileRoleProvider.fromEnv`) :
   le bootstrap (`index.ts`) ne connaît aucun de ces noms, il passe `process.env`.

   ── Pourquoi un fichier à part, alors que le lot ne parle que de trois
      responsabilités (store / provider / routes) ? ─────────────────────────
   Parce que la configuration a TROIS consommateurs distincts — l'adaptateur
   `openid-client` (issuer, client, scopes), les routes (URL de redirection,
   drapeau `Secure` des cookies) et la décision de mode (`AuthModeResolution`,
   qui n'a besoin que de savoir ce qui est RENSEIGNÉ). La loger dans l'un des
   trois obligerait les deux autres à l'importer pour une raison qui n'est pas
   la leur. Elle est en outre PURE, donc testable pour elle-même — ce qui est
   exactement le critère du principe n°2.

   ── 🚨 `OIDC_REDIRECT_URL` est REQUISE, et ne se devine pas ────────────────
   L'URL de callback doit être l'URL PUBLIQUE ABSOLUE que le navigateur atteint,
   celle qui est déclarée telle quelle chez l'OP. Or l'application ne la connaît
   PAS : derrière un reverse-proxy à sous-chemin (cf. user-docs/reverse-proxy.md),
   elle ne voit ni le schéma public, ni l'hôte public, ni le préfixe — au mieux
   des en-têtes `X-Forwarded-*` que rien n'oblige le proxy à poser correctement.
   Deviner produirait une URL qui « marche en local et casse en production »,
   avec pour seul symptôme un `redirect_uri_mismatch` opaque côté OP. On EXIGE
   donc la valeur, et le refus de démarrer la nomme.
   ============================================================================= */

/** Configuration NORMALISÉE du mode `oidc` — ce que les trois consommateurs reçoivent. */
export interface OidcOptions {
  /** Identifiant d'émetteur de l'OP (`https://keycloak.exemple/realms/infra`). La découverte
      `.well-known` en est DÉRIVÉE par la librairie — on ne configure pas les endpoints un à un. */
  issuer: string;
  clientId: string;
  /** Vide = client PUBLIC (aucune authentification cliente, PKCE seul — cf. docs/auth.md). */
  clientSecret: string;
  /** Scopes demandés, déjà normalisés (séparés par une espace, `openid` garanti en tête). */
  scopes: string;
  /** URL PUBLIQUE ABSOLUE du callback — REQUISE (cf. l'en-tête). */
  redirectUrl: string;
  /** Poser l'attribut `Secure` sur les cookies ? Défaut VRAI ; `0` = dev en http seulement. */
  cookieSecure: boolean;
}

export class OidcConfig {
  /* -- Variables d'environnement (le provider POSSÈDE ses noms) -- */
  static readonly ENV_ISSUER = "OIDC_ISSUER";
  static readonly ENV_CLIENT_ID = "OIDC_CLIENT_ID";
  static readonly ENV_CLIENT_SECRET = "OIDC_CLIENT_SECRET";
  static readonly ENV_SCOPES = "OIDC_SCOPES";
  static readonly ENV_REDIRECT_URL = "OIDC_REDIRECT_URL";
  static readonly ENV_COOKIE_SECURE = "OIDC_COOKIE_SECURE";

  /** Scopes par défaut. `groups` n'est PAS universel (Keycloak l'offre via un « client scope »
      dédié, Entra ID ne le connaît pas et passe les groupes autrement) : c'est le défaut le plus
      utile pour la cible principale, et il se REMPLACE par `OIDC_SCOPES` quand l'OP refuse un
      scope inconnu. Documenté comme tel — un défaut qui casse chez certains OP doit être un défaut
      qu'on sait remplacer, pas une surprise. */
  static readonly DEFAULT_SCOPES = "openid profile email groups";

  /** Options lues dans l'environnement, NORMALISÉES (rognage systématique : une variable recopiée
      traîne souvent un blanc, et une URL à espace ne résoudrait rien). Ne JETTE jamais — la
      décision « cette configuration est-elle montable ? » appartient à `AuthModeResolution`, qui
      la prend sur les mêmes faits que tous les autres modes. */
  static optionsFromEnv(env: Record<string, string | undefined>): OidcOptions {
    return {
      issuer: OidcConfig.trim(env[OidcConfig.ENV_ISSUER]),
      clientId: OidcConfig.trim(env[OidcConfig.ENV_CLIENT_ID]),
      clientSecret: OidcConfig.trim(env[OidcConfig.ENV_CLIENT_SECRET]),
      scopes: OidcConfig.normalizeScopes(env[OidcConfig.ENV_SCOPES]),
      redirectUrl: OidcConfig.trim(env[OidcConfig.ENV_REDIRECT_URL]),
      cookieSecure: OidcConfig.parseBoolean(env[OidcConfig.ENV_COOKIE_SECURE], true),
    };
  }

  /** Scopes normalisés : découpe sur les blancs (espaces OU virgules — les deux s'écrivent dans la
      nature), vides écartés, doublons fondus, et `openid` FORCÉ EN TÊTE.

      Forcer `openid` n'est pas une politesse : sans lui la requête n'est plus une requête OpenID
      Connect, l'OP ne renvoie AUCUN id_token, et tout le flux échoue à la validation avec une
      erreur qui ne pointe pas vers la vraie cause. Un exploitant qui écrit `OIDC_SCOPES=profile
      email` a oublié une constante du protocole, pas exprimé un choix. */
  static normalizeScopes(raw: string | undefined | null): string {
    const source = OidcConfig.trim(raw) || OidcConfig.DEFAULT_SCOPES;
    const asked = source.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== "");
    return [...new Set(["openid", ...asked])].join(" ");
  }

  /** Drapeau d'environnement. Formes FAUSSES reconnues : `0`, `false`, `no`, `off` (casse et blancs
      indifférents) ; toute autre valeur renseignée est VRAIE, et l'absence rend le défaut.
      🚨 Asymétrie DÉLIBÉRÉE pour `OIDC_COOKIE_SECURE` (défaut vrai) : une coquille (`OIDC_COOKIE_SECURE=flase`)
      laisse le cookie protégé au lieu de le dénuder — une erreur de saisie ne doit jamais AFFAIBLIR
      la sécurité, c'est la même doctrine que le refus de repli sur le mode dev. */
  static parseBoolean(raw: string | undefined | null, fallback: boolean): boolean {
    const value = OidcConfig.trim(raw).toLowerCase();
    if (value === "") return fallback;
    return !(value === "0" || value === "false" || value === "no" || value === "off");
  }

  private static trim(value: string | undefined | null): string {
    return String(value ?? "").trim();
  }
}
