/* Retour HAPTIQUE (vibration) — wrapper sûr autour de l'API Vibration (`navigator.vibrate`). No-op silencieux là
   où ce n'est pas supporté (desktop, iOS Safari) ou si désactivé. Patterns sémantiques COURTS et discrets : on
   confirme une action tactile déterminante (accroche, sélection, ouverture de menu), jamais en continu.
   Appelable depuis du code partagé souris/tactile : sur desktop l'appel est un no-op inoffensif. */
export class Haptics {
  /** Coupe-circuit global (réglable si on expose un jour un toggle). */
  static enabled = true;

  private static fire(pattern: number | number[]): void {
    if (!Haptics.enabled) return;
    const nav: any = (typeof navigator !== "undefined") ? navigator : null;
    if (!nav || typeof nav.vibrate !== "function") return;
    try { nav.vibrate(pattern); } catch (_) { /* indisponible / bloqué → ignoré */ }
  }

  /** Tic LÉGER : confirmation discrète (ouverture de menu, double-tap). */
  static tick(): void { Haptics.fire(8); }
  /** ACCROCHE / sélection : un poil plus marqué (début de drag, long-press, sélection d'emplacement). */
  static select(): void { Haptics.fire(14); }
  /** CONFIRMATION d'action (validation, drop réussi). */
  static confirm(): void { Haptics.fire([10, 28, 12]); }
}
