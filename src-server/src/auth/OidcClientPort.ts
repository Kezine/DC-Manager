/* =============================================================================
   MODE OIDC — CONTRAT de la couche `openid-client` (types seuls, AUCUN import).

   Ce fichier est la FRONTIÈRE entre notre flux (routes, session, provider) et
   la librairie qui fait la cryptographie du protocole. Il est au mode `oidc` ce
   que `AuthProvider` est à l'authentification : le consommateur ne dépend QUE
   du contrat, l'implémentation est sélectionnée au câblage.

   ── Pourquoi cette frontière existe — trois raisons, aucune cosmétique ────
   1. TESTABILITÉ SANS RÉSEAU. Un flux OIDC réel exige un OP réel. Les routes,
      elles, doivent être éprouvées ici et maintenant : state faux refusé,
      cookie posé, cookie effacé. Un bouchon implémentant ce contrat rend tout
      cela vérifiable sans le moindre paquet ni la moindre socket — patron
      `ssoFetch` de `LegacySsoAuthProvider` et des adaptateurs du dépôt.
   2. `openid-client` N'EST PAS DANS `node_modules` À LA RACINE. Le programme de
      test du dépôt compile un sous-ensemble du serveur (cf. tsconfig.node.json) ;
      un import de la librairie depuis les routes rendrait celles-ci
      incompilables en test. Seul `OpenIdClientAdapter.ts` importe le paquet, et
      il est le SEUL fichier de `auth/` exclu du programme de test.
   3. La librairie est REMPLAÇABLE. `openid-client` v6 a une API entièrement
      fonctionnelle, très différente de sa v5 : un changement majeur ne doit pas
      se propager dans les routes.

   ── 🚨 Ce que ce contrat NE fait PAS ──────────────────────────────────────
   Il ne fabrique AUCUN secret lui-même et n'expose aucune primitive de
   cryptographie : `state`, `nonce` et le verifier PKCE sont produits par
   l'IMPLÉMENTATION (donc par la librairie, `randomState`/`randomNonce`/
   `randomPKCECodeVerifier`), jamais par nos routes. C'est l'engagement du lot :
   ne pas réécrire à la main la crypto d'OIDC (cf. le brief et docs/auth.md).
   ============================================================================= */

/** Revendications de l'`id_token` VALIDÉ par la librairie (signature, `iss`, `aud`, `exp`, `nonce`).

    Les champs nommés sont ceux dont le provider tire une identité ; l'index de signature laisse
    PASSER le reste, exactement comme `SsoUser` — un OP qui pousse une revendication maison ne doit
    pas la voir disparaître à la frontière. ⚠ Aucun champ n'est garanti hors `sub` : `preferred_username`
    est une extension d'OpenID Connect que tous les OP ne servent pas, et `groups` dépend d'un scope
    ET d'un mappeur configurés côté OP. */
export interface OidcClaims {
  /** Identifiant STABLE de l'utilisateur chez l'OP — la seule revendication obligatoire. */
  sub: string;
  preferred_username?: string;
  email?: string;
  name?: string;
  /** Groupes de l'annuaire. Tableau dans le cas général ; certains OP sérialisent une chaîne à
      virgules — les deux formes sont acceptées et nettoyées par `GroupList` (cf. le provider). */
  groups?: string[] | string;
  /** Échéance de l'`id_token`, en SECONDES epoch (unité du protocole, pas celle de JavaScript). */
  exp?: number;
  [claim: string]: unknown;
}

/** Ce qu'une transaction d'autorisation qui DÉMARRE produit : l'URL où envoyer le navigateur, et
    les trois secrets qu'il faudra RETROUVER au retour pour valider la réponse.

    Les trois voyagent dans le cookie de transaction (cf. `OidcRoutes`) : c'est ce qui lie le retour
    de l'OP à la requête de départ, et donc ce qui distingue un vrai retour d'un CSRF de connexion. */
export interface OidcAuthorizationStart {
  authorizationUrl: string;
  /** Anti-CSRF : re-présenté au callback, comparé, et transmis à la librairie comme attendu. */
  state: string;
  /** Anti-rejeu de l'`id_token` : la librairie vérifie qu'il porte CE nonce. */
  nonce: string;
  /** PKCE (RFC 7636) : le verifier reste chez nous, seul son HASH est parti chez l'OP. */
  codeVerifier: string;
}

/** Identité établie au retour du canal arrière — le résultat de l'échange code → jetons. */
export interface OidcIdentity {
  /** Revendications de l'`id_token`, déjà validées par la librairie. */
  claims: OidcClaims;
  /** `id_token` brut, conservé pour le SEUL `id_token_hint` de la déconnexion RP-initiated
      (`OidcRoutes.logout`). Absent = déconnexion locale seule (cf. `endSessionUrl`). */
  idToken?: string;
  /** Échéance de session proposée par l'OP, en MILLISECONDES epoch (unité de `Date.now()` et de
      `SsoResult.expireDate` — la conversion depuis les secondes du protocole est faite par
      l'implémentation, en UN point). `undefined` = l'OP n'a rien annoncé, le store applique son TTL. */
  expiresAt?: number;
}

/** La couche `openid-client`, vue par nos routes.

    ⚠ TOUTES les méthodes peuvent être appelées alors que la DÉCOUVERTE n'a pas abouti (OP
    injoignable au boot) : c'est le cas nominal d'un démarrage avant l'IdP. `ready()` tranche, et
    les routes répondent 503 actionnable sans jamais faire tomber le serveur. */
export interface OidcClientPort {
  /** La découverte a-t-elle abouti ? Faux = l'OP n'a pas encore répondu (ou a échoué). */
  ready(): boolean;

  /** Message ACTIONNABLE expliquant pourquoi la couche n'est pas prête — servi tel quel dans le
      503. Il nomme l'émetteur interrogé et la dernière erreur : un exploitant doit pouvoir
      diagnostiquer sans ouvrir les journaux. */
  unavailableReason(): string;

  /** Relance NON BLOQUANTE de la découverte (au plus une tentative en vol). Appelée quand une
      requête arrive alors que la couche n'est pas prête : la reprise ne dépend alors pas
      uniquement du prochain battement du minuteur de réessai. */
  retryDiscovery(): void;

  /** Démarre une transaction : génère `state`/`nonce`/PKCE et compose l'URL d'autorisation. */
  beginAuthorization(): Promise<OidcAuthorizationStart>;

  /** Termine la transaction : vérifie `state` et `nonce`, échange le code par le CANAL ARRIÈRE
      (avec le verifier PKCE) et valide l'`id_token`. Jette sur tout écart — l'appelant en fait une
      page d'erreur sobre, jamais une redirection (cf. `OidcRoutes.callback`).
      @param callbackUrl  URL COMPLÈTE du callback telle que reçue (paramètres compris) : c'est la
                          forme que la librairie v6 attend, elle y lit `code`, `state` et les erreurs. */
  completeAuthorization(params: {
    callbackUrl: string;
    expectedState: string;
    expectedNonce: string;
    codeVerifier: string;
  }): Promise<OidcIdentity>;

  /** URL de déconnexion RP-initiated de l'OP, ou `null` quand il n'annonce pas d'`end_session_endpoint`
      (la déconnexion reste alors LOCALE — notre cookie est effacé, la session de l'OP survit). */
  endSessionUrl(params: { idToken?: string; postLogoutRedirectUrl: string }): string | null;
}

/** Fabrique de la couche, INJECTÉE à l'orchestrateur (`Auth`) par le bootstrap.

    Sans elle, `auth.ts` importerait `OpenIdClientAdapter`, donc `openid-client`, donc sortirait du
    programme de test — alors que l'orchestrateur est précisément ce qu'on veut continuer d'éprouver.
    Même geste que le driver SQLite injecté dans `DocumentStore` depuis `index.ts`. */
export type OidcClientFactory = (options: OidcClientFactoryOptions) => OidcClientPort;

/** Ce dont la fabrique a besoin : un sous-ensemble d'`OidcOptions`, redéclaré ICI pour que ce
    fichier reste SANS import (le journal, lui, est capturé par la fermeture qu'`index.ts` passe —
    il n'a pas à traverser un contrat qui doit rester compilable en isolation). */
export interface OidcClientFactoryOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUrl: string;
}
