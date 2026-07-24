/* =============================================================================
   COUNTDOWN BUTTON — DÉSACTIVE un bouton N secondes en affichant un compte à
   rebours dans son libellé, puis le RESTAURE. Primitive UI GÉNÉRIQUE et
   RÉUTILISABLE (aucune dépendance métier/PKI) : « temporiser avant de valider »,
   « anti-double-clic », friction volontaire… — on la ré-utilisera ailleurs.

   Module PUR : horloge/timers INJECTÉS (setInterval natif par défaut, calque de
   PkiSession) → testable HEADLESS avec des timers simulés et un bouton STUB
   `{textContent, disabled}` (aucun accès DOM en propre).

   Cycle de vie :
   - START : capture la BASE du libellé (option `label`, sinon `button.textContent`),
     DÉSACTIVE le bouton, affiche `format(base, remaining)` (défaut « base (n) »),
     décrémente CHAQUE seconde (n, n-1, …, 1).
   - FIN naturelle (remaining atteint 0) OU `cancel()` : RÉ-ACTIVE le bouton et
     RESTAURE la base ; `onDone` n'est appelé QU'À la fin naturelle (pas sur cancel).
   - `cancel()` stoppe le timer (aucune fuite) et est IDEMPOTENT (double appel = no-op).
   ============================================================================= */

/** Bouton minimal piloté par le compte à rebours — `HTMLButtonElement` en prod, STUB en test. */
export interface CountdownTarget {
  textContent: string | null;
  disabled: boolean;
}

/** Poignée de contrôle d'un compte à rebours en cours. */
export interface CountdownHandle {
  /** Stoppe le timer, ré-active le bouton et restaure son libellé. Idempotent (double appel = no-op). */
  cancel(): void;
  /** Vrai TANT QUE le décompte n'est ni terminé ni annulé. */
  readonly running: boolean;
}

/** Options du compte à rebours — toutes facultatives (défauts natifs). */
export interface CountdownOptions {
  /** Base du libellé à restaurer (défaut = `button.textContent` capturé au START). */
  label?: string;
  /** Rendu du libellé pendant le décompte (défaut « base (remaining) » — le « (n) » n'est PAS une chaîne i18n). */
  format?: (base: string, remaining: number) => string;
  /** Rappelé à CHAQUE affichage avec les secondes restantes (état initial inclus). */
  onTick?: (remaining: number) => void;
  /** Rappelé à la fin NATURELLE seulement (jamais sur `cancel()`). */
  onDone?: () => void;
  /** Planificateur PÉRIODIQUE (défaut setInterval) — renvoie un handle opaque passé à `cancel`. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Annulation du planificateur (défaut clearInterval). */
  cancel?: (handle: unknown) => void;
}

export class CountdownButton {
  /** Démarre un compte à rebours de `seconds` secondes sur `button`.
      `seconds ≤ 0` → poignée déjà « terminée » (bouton laissé tel quel, aucun timer). */
  static start(button: CountdownTarget, seconds: number, opts: CountdownOptions = {}): CountdownHandle {
    // Base capturée MAINTENANT : en usage réel, `Modal.open` a DÉJÀ posé le libellé du bouton avant
    // d'appeler `onReady` → la base est bien le libellé « au repos » à restaurer en fin de décompte.
    const base = opts.label != null ? opts.label : (button.textContent || "");
    const format = opts.format || ((b, remaining) => `${b} (${remaining})`);
    const schedule = opts.schedule || ((fn, ms) => setInterval(fn, ms));
    const cancelTimer = opts.cancel || ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

    let remaining = Math.max(0, Math.floor(seconds));
    let handle: unknown = null;
    let running = false;

    // Durée nulle/négative : rien à temporiser (le bouton reste dans son état courant).
    if (remaining <= 0) {
      return { cancel: () => { /* déjà terminé — no-op */ }, get running() { return false; } };
    }

    // Stoppe le timer sous-jacent SANS toucher au bouton. Idempotent (le garde `running` évite le double cancel).
    const stopTimer = (): void => {
      if (!running) return;
      running = false;
      if (handle !== null) { cancelTimer(handle); handle = null; }
    };
    const restore = (): void => { button.disabled = false; button.textContent = base; };

    // État initial : bouton désactivé, libellé « base (n) ».
    running = true;
    button.disabled = true;
    button.textContent = format(base, remaining);
    if (opts.onTick) opts.onTick(remaining);

    handle = schedule(() => {
      remaining--;
      if (remaining > 0) {
        button.textContent = format(base, remaining);
        if (opts.onTick) opts.onTick(remaining);
        return;
      }
      // Fin naturelle : couper le timer, restaurer le bouton, PUIS notifier.
      stopTimer();
      restore();
      if (opts.onDone) opts.onDone();
    }, 1000);

    return {
      cancel: () => { if (!running) return; stopTimer(); restore(); },
      get running() { return running; },
    };
  }
}
