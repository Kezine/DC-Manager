import type { AuthProvider, SsoResult } from "./AuthProvider.js";

/* =============================================================================
   MODE DEV — AUCUNE authentification : tout appelant est le même utilisateur
   factice, et il est SUPER_ADMIN.

   C'est le mode par DÉFAUT (ni `SSO_URL` ni `BASIC_AUTH` configurés), pour qu'un
   `npm run dev` fonctionne sans infrastructure. Un déploiement réel démarré sans
   ces variables serait donc grand ouvert : le WARN de boot de l'orchestrateur
   (`../auth.ts`) le crie, et ce provider ne cherche pas à l'adoucir — un mode de
   confort qui ferait semblant de contrôler quelque chose serait pire que celui-ci,
   qui ne prétend rien.

   `dev: true` est repris par la politique de rôles comme règle de
   RÉTROCOMPATIBILITÉ (→ rôle `admin`, cf. `access/FileRoleProvider`).
   ============================================================================= */
export class DevAuthProvider implements AuthProvider {
  /** Login servi quand `DEV_USER` n'est pas renseigné. */
  static readonly DEFAULT_LOGIN = "dev";

  private readonly login: string;

  /** @param devUser  Login de l'utilisateur factice (`DEV_USER`) ; vide/absent → `DEFAULT_LOGIN`. */
  constructor(devUser: string | null | undefined) {
    this.login = devUser || DevAuthProvider.DEFAULT_LOGIN;
  }

  /** Toujours la même identité, JAMAIS anonyme — il n'y a rien à présenter, donc rien à refuser.

      ⚠ Objet NEUF à chaque appel (et non une constante partagée) : la session est posée sur la
      requête (`req.authUser`) et traverse jusqu'aux modules ; un objet partagé ferait d'une
      éventuelle écriture locale une contamination globale. */
  async authenticate(): Promise<SsoResult> {
    return { user: { login: this.login, nom: "Dev", prenom: "" }, logged: true, adminRight: "SUPER_ADMIN", dev: true };
  }
}
