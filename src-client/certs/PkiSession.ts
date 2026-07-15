/* =============================================================================
   COFFRE DE SESSION DE LA PKI — détient la clé maître DÉRIVÉE (CryptoKey non
   extractible) le temps d'une session de travail sur la page Certificats.

   Cycle de vie (décision Q2 du cadrage certs 2026-07-14) :
   - `unlock(key)` après une dérivation réussie (keycheck validé) ;
   - VERROUILLAGE AUTO après 15 min d'INACTIVITÉ — chaque action de la page
     appelle `touch()` pour ré-armer le compte à rebours ;
   - bouton « Verrouiller » = `lock()` manuel ;
   - fermeture de l'onglet : rien à faire — la clé ne vit QU'EN MÉMOIRE
     (jamais persistée : ni storage, ni cookie, ni IndexedDB), elle meurt
     avec la page.

   Module PUR : horloge/timers INJECTÉS (setTimeout natif par défaut) →
   testable headless avec des timers simulés. `onLock` prévient l'UI (retour
   à l'écran verrouillé) quelle que soit la cause (auto ou manuel).
   ============================================================================= */

/** Dépendances injectables (tests : timers simulés ; prod : défauts natifs). */
export interface PkiSessionHooks {
  /** Prévenu à CHAQUE verrouillage effectif (auto ou manuel) — l'UI re-rend l'écran verrouillé. */
  onLock?: () => void;
  /** Planificateur (défaut setTimeout) — renvoie un handle opaque pour `cancel`. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Annulation (défaut clearTimeout). */
  cancel?: (handle: unknown) => void;
}

export class PkiSession {
  /** Délai d'inactivité avant verrouillage automatique — décision Q2 : 15 minutes. */
  static readonly AUTO_LOCK_MS = 15 * 60 * 1000;

  private masterKey: CryptoKey | null = null;
  private timerHandle: unknown = null;
  private readonly onLock: () => void;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(hooks: PkiSessionHooks = {}, private readonly autoLockMs: number = PkiSession.AUTO_LOCK_MS) {
    this.onLock = hooks.onLock || (() => { /* pas d'UI branchée */ });
    this.schedule = hooks.schedule || ((fn, ms) => setTimeout(fn, ms));
    this.cancel = hooks.cancel || ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Ouvre la session avec la clé dérivée (keycheck DÉJÀ validé par l'appelant) et arme
      le verrouillage d'inactivité. Ré-appel = remplace la clé (re-déverrouillage). */
  unlock(key: CryptoKey): void {
    this.masterKey = key;
    this.rearm();
  }

  /** Verrouille : oublie la clé (la CryptoKey non extractible devient injoignable — le GC
      fait le reste) et prévient l'UI. No-op silencieux si déjà verrouillé (pas de double onLock). */
  lock(): void {
    if (this.masterKey === null) return;
    this.masterKey = null;
    this.disarm();
    this.onLock();
  }

  /** Activité utilisateur (action sur la page) → le compte à rebours repart de zéro.
      Sans effet si la session est verrouillée (pas de ré-armement fantôme). */
  touch(): void {
    if (this.masterKey !== null) this.rearm();
  }

  get unlocked(): boolean {
    return this.masterKey !== null;
  }

  /** La clé maître de la session. JETTE si verrouillée — les appelants passent par
      `unlocked` d'abord ; l'exception attrape les chemins de code qui l'oublieraient
      (mieux qu'un null silencieux qui ferait échouer la crypto plus loin). */
  get key(): CryptoKey {
    if (this.masterKey === null) throw new Error("PkiSession : session verrouillée — déverrouiller avant toute opération de clé");
    return this.masterKey;
  }

  /* --------------------------------------------------------------------------
     Timers privés
     -------------------------------------------------------------------------- */

  private rearm(): void {
    this.disarm();
    this.timerHandle = this.schedule(() => this.lock(), this.autoLockMs);
    // `unref` si disponible (Node en test) : le timer ne retient pas le process.
    (this.timerHandle as any)?.unref?.();
  }

  private disarm(): void {
    if (this.timerHandle !== null) {
      this.cancel(this.timerHandle);
      this.timerHandle = null;
    }
  }
}
