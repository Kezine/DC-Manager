/* ============================================================================
   EXPIRATION DE SESSION (mode API) — verrou PUR « a-t-on déjà ramené au login ? ».
   ----------------------------------------------------------------------------
   Quand le SSO expire PENDANT une session, la garde serveur répond 401 sur nos
   requêtes (cf. `AccessControl.requireAuth`, la garde GLOBALE — docs/auth.md
   § 6.1). Plusieurs fetches peuvent être EN VOL au même instant (chargement d'un
   document, badges d'onglets, images…) → une RAFALE de 401 arrive. On ne veut
   qu'UNE seule action : couper la session locale et revenir à l'écran de
   connexion. Ce module porte ce verrou d'IDEMPOTENCE, isolé ici pour rester
   testable (aucun DOM, aucun réseau).

   ⚠ NE PAS confondre avec le 403 (« authentifié, mais sans le droit »), qui a son
   propre module — `core/AccessDenial` : la MÊME garde globale émet les deux
   codes, mais le 403 ne renvoie JAMAIS au login (se reconnecter n'y changerait
   rien) et se re-signale plus tard, d'où une fenêtre de silence par permission
   plutôt qu'un verrou terminal.

   Rôles :
     - `install(onExpired)` — câblé UNE fois au boot (main.ts, mode REST seulement) ;
       `onExpired` est l'action concrète (RestDocumentController.sessionExpired).
     - `report(status)` — appelé par CHAQUE point de sortie 401 (RestProtocol +
       clients de feature). Le PREMIER 401 arme le verrou et déclenche l'action ;
       les suivants (rafale) sont sans effet. Renvoie true s'il a déclenché.
     - `reset()` — ré-arme le verrou quand une session valide est RE-CONSTATÉE
       (RestDocumentController.bootstrap, après ré-autorisation) : une expiration
       ULTÉRIEURE doit à nouveau pouvoir ramener au login.

   État STATIQUE (singleton applicatif) : il n'existe qu'une session par onglet,
   et tous les points d'émission de 401 doivent partager le MÊME verrou.
   ============================================================================ */
export class SessionExpiry {
  /** Action à exécuter au 1er 401 (injectée par main.ts). null tant que non installée : `report` reste
      alors un no-op SÛR (il arme quand même le verrou, mais n'appelle rien — pas de crash au boot). */
  private static onExpired: (() => void) | null = null;
  /** Verrou : passe à true dès le 1er 401 traité → les 401 suivants (rafale de requêtes en vol) sont ignorés
      jusqu'au prochain `reset()`. C'est lui qui garantit UNE seule action malgré N requêtes refusées en parallèle. */
  private static fired = false;

  /** Enregistre l'action de retour au login (une fois, au boot en mode REST). */
  static install(onExpired: () => void): void { SessionExpiry.onExpired = onExpired; }

  /** Signale une réponse HTTP : si c'est un 401 ET que le verrou n'est pas déjà armé, arme le verrou, déclenche
      l'action UNE fois et renvoie true. Sinon renvoie false (statut non-401, ou 401 déjà traité). Idempotent :
      une rafale de 401 concurrents ne produit qu'UNE action. Sans `install`, arme quand même le verrou (no-op sûr). */
  static report(status: number): boolean {
    if (status !== 401 || SessionExpiry.fired) return false;
    SessionExpiry.fired = true;
    SessionExpiry.onExpired?.();
    return true;
  }

  /** Ré-arme le verrou (une session valide a été re-constatée) → un futur 401 pourra de nouveau déclencher. */
  static reset(): void { SessionExpiry.fired = false; }
}
