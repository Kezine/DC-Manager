/* ============================================================================
   ACCESS DENIAL — anti-rafale des refus d'AUTORISATION (HTTP 403) en cours de
   session.

   LE CAS COUVERT. Les droits d'un utilisateur peuvent changer À CHAUD : la
   politique serveur (`roles.json`) est relue par sondage, un rôle retiré prend
   effet sur la requête suivante. L'interface, elle, a été bâtie avec les droits
   d'AVANT — l'utilisateur clique donc encore un geste que le serveur refuse
   désormais, et une VUE en cours de rendu peut tirer plusieurs requêtes d'un
   coup (listing + pastilles + facettes) : une seule action fautive produit une
   RAFALE de 403 identiques. Notifier chacun d'eux noierait l'écran de toasts.

   ⚠ CE N'EST PAS LE VERROU DU 401 (`core/SessionExpiry`), et la différence est
   de FOND, pas de degré :
     · 401 = « je ne sais pas qui vous êtes » → une action UNIQUE et TERMINALE
       (retour au login), donc un verrou armé UNE fois jusqu'au prochain `reset`;
     · 403 = « je sais qui vous êtes, et non » → l'utilisateur RESTE dans
       l'application (se reconnecter n'y changerait rien). Le refus est un
       ÉVÉNEMENT RÉPÉTABLE : il doit pouvoir se re-signaler plus tard, sur une
       autre permission ou après que la politique a rebougé. D'où une fenêtre de
       silence PAR PERMISSION, et non un verrou global.

   Module PUR (aucun DOM, aucune horloge implicite : `nowMs` est INJECTÉ) → testé
   en isolation dans `Tests/modules/test-client-access.js`.
   ============================================================================ */
export class AccessDenial {
  /** Fenêtre de silence, en millisecondes, APRÈS un refus déjà signalé pour la MÊME permission.
      Calibrée sur la durée de vie d'un toast : assez longue pour absorber la rafale d'un même geste,
      assez courte pour qu'un second essai délibéré de l'utilisateur lui réponde à nouveau. */
  static readonly DEDUP_WINDOW_MS = 5000;

  /** Dernier instant SIGNALÉ par permission. Une permission absente n'a jamais été signalée. */
  private readonly lastSignaled = new Map<string, number>();

  /** Ce refus doit-il produire une notification ? Vrai la PREMIÈRE fois, puis faux tant que la
      fenêtre de silence de CETTE permission n'est pas écoulée. Le nom de permission est normalisé
      (un corps de 403 sans champ `permission` se replie sur une clé vide, dédupliquée pareillement).
      Effet de bord assumé : l'appel MÉMORISE l'instant — c'est un compteur de rafale, pas un prédicat
      pur au sens strict, et le nommer `accept` plutôt que `shouldNotify` le dit à l'appel. */
  accept(permission: string | null | undefined, nowMs: number): boolean {
    const key = String(permission == null ? "" : permission).trim();
    const last = this.lastSignaled.get(key);
    if (last != null && nowMs - last < AccessDenial.DEDUP_WINDOW_MS) return false;
    this.lastSignaled.set(key, nowMs);
    return true;
  }

  /** Oublie tout historique de refus (nouvelle session, droits rechargés) : le prochain refus se
      signalera immédiatement, même s'il porte sur une permission déjà vue. */
  reset(): void { this.lastSignaled.clear(); }
}
