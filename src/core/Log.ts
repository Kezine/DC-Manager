/* =============================================================================
   Logger de débogage GÉNÉRALISÉ — sortie console gated par un flag global.
   Désactivé par défaut (aucun bruit en usage normal). Activable via le réglage
   « Logs de débogage » (Prefs.debugLog) ou en console : `NetMapLog.enable()`.
   Usage : Log.d("fs", "message", obj)  →  [netmap:fs] message obj
   ============================================================================= */
export class Log {
  static enabled = false;

  /** Active/désactive globalement (appelé par le bootstrap depuis les préférences). */
  static setEnabled(on: boolean): void { Log.enabled = !!on; }

  /** Log de débogage catégorisé (no-op si désactivé). `category` préfixe la ligne. */
  static d(category: string, ...args: any[]): void {
    if (!Log.enabled) return;
    try { console.log("%c[netmap:" + category + "]", "color:#4ea1ff", ...args); } catch (_) { /* console indisponible */ }
  }

  /** Fabrique un logger lié à une catégorie : `const flog = Log.scope("fs")`. */
  static scope(category: string): (...args: any[]) => void {
    return (...args: any[]) => Log.d(category, ...args);
  }
}

// Petit accès console pour (dés)activer à la volée sans passer par l'UI.
try { (window as any).NetMapLog = { enable: () => Log.setEnabled(true), disable: () => Log.setEnabled(false), get on() { return Log.enabled; } }; } catch (_) { /* hors navigateur */ }
