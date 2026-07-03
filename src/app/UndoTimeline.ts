/* =============================================================================
   TIMELINE D'UNDO UNIFIÉE — logique PURE extraite de `main.ts` (boot) pour être
   testable en isolation (principe n°7 : elle était enfermée dans une closure).

   Le modèle (snapshots, adapter) et les images (ImageStore, opérations inverses)
   ont CHACUN leur pile d'undo, mais UN SEUL geste (bouton / Ctrl+Z) défait dans
   l'ordre CHRONOLOGIQUE : la timeline mémorise la pile concernée par action
   (`note(kind)`) ; toute nouvelle action vide le redo unifié. `undo()/redo()`
   dépilent et délèguent à la bonne pile, en SAUTANT les jetons dont la pile est
   épuisée (plafond de snapshots atteint côté pile). Les piles sont INJECTÉES
   (interface `UndoStack`), enregistrées par ordre de priorité du filet de
   sécurité (timeline désynchronisée → première pile encore dépilable).
   ============================================================================= */

/** Capacité minimale d'une pile d'undo (Store modèle, ImageStore…). */
export interface UndoStack {
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): Promise<unknown> | unknown;
  redo(): Promise<unknown> | unknown;
}

export class UndoTimeline {
  private readonly undoOrder: string[] = [];
  private readonly redoOrder: string[] = [];
  private readonly stacks = new Map<string, UndoStack>();   // ordre d'enregistrement = priorité du filet
  /** Notifié à chaque changement de timeline (note/reset) — le boot y branche le rafraîchissement du chrome. */
  onChange: () => void = () => { /* posé au boot */ };

  constructor(private readonly cap = 400) {}

  /** Enregistre une pile sous son jeton (`"model"`, `"image"`…). */
  register(kind: string, stack: UndoStack): void { this.stacks.set(kind, stack); }

  /** Une action ANNULABLE vient d'être poussée sur la pile `kind` (câblé aux `onUndoable` des piles). */
  note(kind: string): void {
    this.undoOrder.push(kind);
    if (this.undoOrder.length > this.cap) this.undoOrder.shift();
    this.redoOrder.length = 0;   // toute nouvelle action invalide le redo unifié
    try { this.onChange(); } catch (_) { /* noop */ }
  }

  /** Nouveau document chargé / boot : la timeline repart de zéro. */
  reset(): void {
    this.undoOrder.length = 0; this.redoOrder.length = 0;
    try { this.onChange(); } catch (_) { /* noop */ }
  }

  /** Profondeur du redo unifié (les boutons du chrome n'activent « Rétablir » que si > 0). */
  get redoDepth(): number { return this.redoOrder.length; }

  /** Défait la dernière action (bonne pile ; jetons épuisés sautés ; filet si timeline désynchronisée).
      Renvoie true si quelque chose a été défait. */
  async undo(): Promise<boolean> {
    while (this.undoOrder.length) {
      const kind = this.undoOrder[this.undoOrder.length - 1], stack = this.stacks.get(kind);
      if (stack && stack.canUndo()) { this.undoOrder.pop(); await stack.undo(); this.redoOrder.push(kind); return true; }
      this.undoOrder.pop();   // jeton dont la pile est épuisée (plafond atteint) → ignorer
    }
    for (const [kind, stack] of this.stacks) {   // filet (timeline désynchronisée) : première pile dépilable
      if (stack.canUndo()) { await stack.undo(); this.redoOrder.push(kind); return true; }
    }
    return false;
  }

  /** Rétablit la dernière action défaite. Renvoie true si quelque chose a été rétabli. */
  async redo(): Promise<boolean> {
    while (this.redoOrder.length) {
      const kind = this.redoOrder[this.redoOrder.length - 1], stack = this.stacks.get(kind);
      if (stack && stack.canRedo()) { this.redoOrder.pop(); await stack.redo(); this.undoOrder.push(kind); return true; }
      this.redoOrder.pop();
    }
    return false;
  }
}
