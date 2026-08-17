/* =============================================================================
   RÉSOLUTION DU MODE D'AUTHENTIFICATION — logique PURE (aucun import).

   « Quel provider le boot doit-il monter ? » est une décision de CONFIGURATION,
   pas un comportement d'orchestrateur : elle se prend à partir de trois faits
   d'environnement et se teste sans rien construire. Elle sort donc ici, en
   classe sémantique à méthodes statiques (principe n°2), et l'orchestrateur
   (`../auth.ts`) ne fait que la CONSOMMER.

   ── Deux régimes, et un seul est nouveau ──────────────────────────────────
   1. `AUTH_MODE` ABSENTE → l'INFÉRENCE historique, inchangée au bit près :
      `BASIC_AUTH` exploitable → basic ; sinon `SSO_URL` renseignée → sso ;
      sinon dev (avec le WARN de l'orchestrateur). Un déploiement existant ne
      voit donc RIEN changer.
   2. `AUTH_MODE` RENSEIGNÉE → elle FAIT LOI. Plus d'inférence : ce que
      l'exploitant a écrit est ce qui est monté, ou rien.

   ── 🚨 Pourquoi une valeur douteuse REFUSE de démarrer ────────────────────
   Le mode `dev` n'authentifie PERSONNE (tout appelant y est SUPER_ADMIN). Si
   une coquille (`AUTH_MODE=forwrad`), un mode pas encore implémenté (la liste
   `PLANNED_MODES`, vide depuis l'arrivée d'`oidc`) ou une configuration
   incomplète (`AUTH_MODE=sso` sans `SSO_URL`, `AUTH_MODE=oidc` sans
   `OIDC_ISSUER`) retombait EN SILENCE sur l'inférence, un déploiement se
   croirait protégé et serait grand ouvert : c'est l'anti-pattern FAIL-OPEN.
   D'où la forme du résultat : `mode: null` quand la configuration est
   incohérente — il n'existe alors AUCUN mode, et pas « le mode par défaut ».
   L'appelant n'a structurellement rien à monter, il ne peut que s'arrêter.

   `AUTH_MODE=dev` ÉCRIT EXPLICITEMENT reste permis : c'est un choix assumé, et
   le WARN de l'orchestrateur le crie comme aujourd'hui.
   ============================================================================= */

/** Modes d'authentification servis par un provider de `auth/` — les CINQ sont implémentés. */
export type AuthMode = "dev" | "basic" | "sso" | "forward" | "oidc";

/** Les faits d'environnement dont la décision dépend — et rien d'autre.

    ⚠ On ne passe PAS ici la valeur brute de `BASIC_AUTH` : la règle de FORMAT d'un couple
    `user:pass` appartient à `BasicAuthProvider.fromSpec` (« la valeur ne décrit pas un couple » et
    « pas de mode basic » y sont la même réponse). La dupliquer ici la ferait dériver. Même
    discipline pour OIDC : on ne reçoit que des DRAPEAUX « cette valeur est-elle renseignée ? »,
    la normalisation (rognage, défauts, scopes) restant chez `OidcConfig`. Cette décision doit
    pouvoir se tester sans rien construire — c'est toute sa raison d'être. */
export interface AuthModeInput {
  /** Valeur BRUTE de `AUTH_MODE` (rognée et mise en minuscules ici). Vide/absente → inférence. */
  authMode?: string | null;
  /** `BASIC_AUTH` décrit-elle un couple exploitable ? (réponse de `BasicAuthProvider.fromSpec`) */
  hasBasicCredentials?: boolean;
  /** `SSO_URL` est-elle renseignée (déjà rognée par l'appelant) ? */
  hasSsoUrl?: boolean;
  /** `OIDC_ISSUER` est-elle renseignée ? */
  hasOidcIssuer?: boolean;
  /** `OIDC_CLIENT_ID` est-elle renseignée ? */
  hasOidcClientId?: boolean;
  /** `OIDC_REDIRECT_URL` est-elle renseignée ? Elle est REQUISE et ne se devine pas (l'URL publique
      derrière un reverse-proxy à sous-chemin nous est inconnue — cf. `OidcConfig`). */
  hasOidcRedirectUrl?: boolean;
}

/** Décision de configuration. `mode: null` ⇔ `error` renseignée : les deux ne se croisent jamais. */
export interface AuthModeDecision {
  /** Mode à monter, ou `null` quand la configuration est INCOHÉRENTE (aucun repli — cf. l'en-tête). */
  mode: AuthMode | null;
  /** Message ACTIONNABLE (nommant la variable fautive et la correction attendue), `null` sinon. */
  error: string | null;
}

export class AuthModeResolution {
  /** Nom de la variable d'environnement — cité dans les messages, donc défini une seule fois. */
  static readonly ENV_VAR = "AUTH_MODE";

  /** Modes ACCEPTÉS aujourd'hui, dans l'ordre où on les présente à l'exploitant. */
  static readonly MODES: readonly AuthMode[] = ["dev", "basic", "sso", "forward", "oidc"];

  /** Modes PRÉVUS mais pas encore servis par un provider. Les distinguer d'une faute de frappe n'est
      pas cosmétique : le message dit « pas encore implémenté » au lieu de « inconnu », donc
      l'exploitant qui a lu la feuille de route ne cherche pas une coquille inexistante.

      ⚠ VIDE depuis la livraison du mode `oidc`, son unique occupant — et le mécanisme est CONSERVÉ
      délibérément : c'est le point d'accroche du prochain mode annoncé avant d'être servi, et le
      remettre coûterait plus cher que de le laisser (il est couvert par un test qui vaut aussi
      contrôle de non-régression sur le message « inconnu »). */
  static readonly PLANNED_MODES: readonly string[] = [];

  /** Décide du mode à monter. Ne jette JAMAIS : l'appelant reçoit soit un mode, soit un motif. */
  static resolve(input: AuthModeInput = {}): AuthModeDecision {
    // Rognage + minuscules : une variable d'environnement recopiée traîne souvent un blanc, et
    // `AUTH_MODE=Forward` est sans ambiguïté le mode `forward`. Tolérer la CASSE n'ouvre rien (le
    // mode reste EXPLICITE) ; tolérer une coquille, si (cf. l'en-tête) — d'où le refus plus bas.
    const asked = String(input.authMode ?? "").trim().toLowerCase();
    if (asked === "") return { mode: AuthModeResolution.infer(input), error: null };

    if (AuthModeResolution.PLANNED_MODES.includes(asked)) {
      return AuthModeResolution.refuse('« ' + asked + ' » n\'est pas encore implémenté');
    }
    if (!(AuthModeResolution.MODES as readonly string[]).includes(asked)) {
      return AuthModeResolution.refuse('valeur inconnue « ' + asked + ' »');
    }
    // COHÉRENCE : un mode explicite dont la configuration manque ne peut pas être monté. Le refuser
    // vaut mieux que monter autre chose — l'exploitant a nommé son intention, on ne la trahit pas.
    if (asked === "basic" && !input.hasBasicCredentials) {
      return AuthModeResolution.refuse('« basic » exige BASIC_AUTH au format « utilisateur:motdepasse »');
    }
    if (asked === "sso" && !input.hasSsoUrl) {
      return AuthModeResolution.refuse('« sso » exige SSO_URL (endpoint de validation de la session)');
    }
    // OIDC : TROIS valeurs sans lesquelles le mode ne peut pas fonctionner, refusées UNE À UNE pour
    // que le message nomme celle qui manque. Un refus groupé (« configuration OIDC incomplète »)
    // ferait chercher l'exploitant dans trois variables à la fois — or c'est presque toujours la
    // troisième qu'on oublie, l'URL de redirection n'ayant aucun équivalent dans les autres modes.
    if (asked === "oidc") {
      if (!input.hasOidcIssuer) return AuthModeResolution.refuse('« oidc » exige OIDC_ISSUER (émetteur de l\'IdP, ex. https://keycloak.exemple/realms/infra)');
      if (!input.hasOidcClientId) return AuthModeResolution.refuse('« oidc » exige OIDC_CLIENT_ID (identifiant du client déclaré chez l\'IdP)');
      if (!input.hasOidcRedirectUrl) {
        return AuthModeResolution.refuse('« oidc » exige OIDC_REDIRECT_URL (URL PUBLIQUE ABSOLUE du callback, ex.'
          + ' https://dcmanager.exemple/auth/callback — elle ne peut pas être devinée derrière un reverse-proxy'
          + ' et doit être déclarée à l\'identique chez l\'IdP)');
      }
    }
    return { mode: asked as AuthMode, error: null };
  }

  /** INFÉRENCE historique (`AUTH_MODE` absente) : basic > sso > dev. Inchangée depuis toujours. */
  private static infer(input: AuthModeInput): AuthMode {
    if (input.hasBasicCredentials) return "basic";
    return input.hasSsoUrl ? "sso" : "dev";
  }

  /** Refus COMMUN : le motif, la liste des valeurs admises, et le rappel de la doctrine. La queue du
      message est écrite ICI une seule fois — un refus qui n'expliquerait pas pourquoi il ne se replie
      pas sur le mode dev inviterait le premier exploitant pressé à « juste retirer la variable ». */
  private static refuse(reason: string): AuthModeDecision {
    return {
      mode: null,
      error: AuthModeResolution.ENV_VAR + " : " + reason
        + " — valeurs admises : " + AuthModeResolution.MODES.join(", ")
        + ". Aucun repli sur le mode dev (il n'authentifie personne et ouvrirait l'instance) :"
        + " corriger " + AuthModeResolution.ENV_VAR + ", ou la RETIRER pour retrouver l'inférence historique.",
    };
  }
}
