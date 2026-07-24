/* =============================================================================
   COFFRES DE SESSION DE LA PKI — détient les DEK des COFFRES DÉVERROUILLÉS
   (cadrage §11, multi-coffres) : une DEK PAR coffre (`vault_id`), CryptoKey non
   extractible, le temps d'une session de travail sur la page Certificats. Chaque
   DEK chiffre/déchiffre les clés privées de SON coffre ; la phrase d'un coffre ne
   fait que déballer SA DEK au déverrouillage (cf. PkiCrypto — chiffrement en
   enveloppe), puis n'est plus nécessaire.

   Cycle de vie (décision Q2 du cadrage 2026-07-14, généralisé aux coffres) :
   - `unlock(vaultId, key)` après un déballage réussi de la DEK du coffre ;
   - VERROUILLAGE AUTO de TOUS les coffres après 15 min d'INACTIVITÉ (un seul
     compte à rebours — chaque action de la page appelle `touch()`) ;
   - `lockVault(vaultId)` = verrouiller UN coffre (ex. re-verrouiller le coffre
     « root » sitôt l'opération sensible terminée, le coffre courant restant ouvert) ;
   - bouton « Verrouiller » = `lock()` (tout) ;
   - fermeture de l'onglet : rien à faire — les clés ne vivent QU'EN MÉMOIRE
     (jamais persistées), elles meurent avec la page.

   INVARIANT de sûreté : `keyOf(vaultId)` JETTE si CE coffre est verrouillé — les
   appelants passent par les helpers centraux de la vue (encryptForVault/
   decryptKeyOf) qui couplent TOUJOURS le bon coffre à la bonne clé ; l'exception
   attrape les chemins qui mélangeraient les coffres (mieux qu'un échec GCM opaque
   plus loin, et surtout mieux qu'un chiffrement sous la MAUVAISE DEK, qui
   violerait l'invariant vault_id ⇄ DEK du cadrage §11.5).

   Module PUR : horloge/timers INJECTÉS (setTimeout natif par défaut) →
   testable headless avec des timers simulés. `onLock` prévient l'UI (re-rendu)
   à CHAQUE verrouillage effectif — global ou d'un seul coffre, auto ou manuel.
   ============================================================================= */

/** Dépendances injectables (tests : timers simulés ; prod : défauts natifs). */
export interface PkiSessionHooks {
  /** Prévenu à CHAQUE verrouillage effectif (global ou d'un coffre, auto ou manuel) — l'UI re-rend. */
  onLock?: () => void;
  /** Planificateur (défaut setTimeout) — renvoie un handle opaque pour `cancel`. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Annulation (défaut clearTimeout). */
  cancel?: (handle: unknown) => void;
}

export class PkiSession {
  /** Délai d'inactivité avant verrouillage automatique (de TOUS les coffres) — décision Q2 : 15 minutes. */
  static readonly AUTO_LOCK_MS = 15 * 60 * 1000;

  /** DEK par coffre déverrouillé (`vault_id` → CryptoKey non extractible). */
  private readonly deks = new Map<string, CryptoKey>();
  private timerHandle: unknown = null;
  private readonly onLock: () => void;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(hooks: PkiSessionHooks = {}, private readonly autoLockMs: number = PkiSession.AUTO_LOCK_MS) {
    this.onLock = hooks.onLock || (() => { /* pas d'UI branchée */ });
    this.schedule = hooks.schedule || ((fn, ms) => setTimeout(fn, ms));
    this.cancel = hooks.cancel || ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Ouvre un COFFRE avec sa DEK déballée (phrase DÉJÀ validée par l'appelant via l'unwrap) et
      (ré)arme le verrouillage d'inactivité. Ré-appel = remplace la clé (re-déverrouillage). */
  unlock(vaultId: string, key: CryptoKey): void {
    this.deks.set(vaultId, key);
    this.rearm();
  }

  /** Verrouille UN coffre : oublie SA DEK (la CryptoKey non extractible devient injoignable — le GC
      fait le reste) et prévient l'UI. No-op silencieux s'il n'était pas ouvert. Le compte à rebours
      global continue pour les coffres restants (désarmé si plus aucun). */
  lockVault(vaultId: string): void {
    if (!this.deks.delete(vaultId)) return;
    if (this.deks.size === 0) this.disarm();
    this.onLock();
  }

  /** Verrouille TOUS les coffres (bouton « Verrouiller » + expiration d'inactivité).
      No-op silencieux si tout est déjà verrouillé (pas de double onLock). */
  lock(): void {
    if (this.deks.size === 0) return;
    this.deks.clear();
    this.disarm();
    this.onLock();
  }

  /** Activité utilisateur (action sur la page) → le compte à rebours repart de zéro.
      Sans effet si tout est verrouillé (pas de ré-armement fantôme). */
  touch(): void {
    if (this.deks.size > 0) this.rearm();
  }

  /** AU MOINS un coffre est ouvert (état « déverrouillé » de la page — les gates fins par
      opération passent par `unlockedVault`/`keyOf`). */
  get unlocked(): boolean {
    return this.deks.size > 0;
  }

  /** CE coffre est-il ouvert ? */
  unlockedVault(vaultId: string): boolean {
    return this.deks.has(vaultId);
  }

  /** Ids des coffres actuellement ouverts (affichage d'état). */
  unlockedIds(): string[] {
    return [...this.deks.keys()];
  }

  /** La DEK d'un coffre. JETTE si CE coffre est verrouillé — le message porte le coffre en cause
      (l'UI le traduit en invite de déverrouillage ciblée). */
  keyOf(vaultId: string): CryptoKey {
    const dek = this.deks.get(vaultId);
    if (!dek) throw new Error("PkiSession : coffre « " + vaultId + " » verrouillé — déverrouillez-le avant cette opération de clé");
    return dek;
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
