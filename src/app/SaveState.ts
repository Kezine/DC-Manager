/** Logique PURE (sans DOM ni FS) de l'état de sauvegarde du document — extraite de `main.ts` pour être TESTABLE.
    Le « dirty » est calculé par COMPARAISON DE RÉVISION (index d'historique du modèle) avec la dernière sauvegarde,
    plus un drapeau pour les changements HORS historique (renommage, images). Ainsi un undo qui ramène au point
    sauvegardé redevient « propre ». La pastille de l'UI suit `state()` ; l'auto-save n'écrit que si `shouldAutosave()`. */
export type SaveStateKind = "mem" | "clean" | "dirty" | "dirty-on";

export interface SaveStateInput { dirty: boolean; hasFile: boolean; autosaveOn: boolean; }

/** Suivi mutable du « dirty » + état de save d'un document. `revision` = index d'historique du modèle (change à
    chaque mutation/undo/redo) ; `savedRevision` = révision à la dernière sauvegarde. `otherDirty` = changements
    non couverts par l'historique modèle (renommage du document, bibliothèque d'images).
    Les règles PURES (`compute`, `shouldAutosave`) sont des STATIQUES de la classe (principe n°2 —
    anciennement des fonctions libres exportées). */
export class SaveState {
  /** Pastille d'état : fichier lié → clean / dirty / dirty-on (auto-save) ; sinon mémoire → mem / dirty. */
  static compute(o: SaveStateInput): SaveStateKind {
    if (o.hasFile) return !o.dirty ? "clean" : (o.autosaveOn ? "dirty-on" : "dirty");
    return o.dirty ? "dirty" : "mem";
  }
  /** L'auto-save n'écrit QUE s'il y a des modifications ET un fichier lié. */
  static shouldAutosave(o: { dirty: boolean; hasFile: boolean }): boolean {
    return o.dirty && o.hasFile;
  }

  private revision = 0;        // révision modèle courante (index d'historique)
  private savedRevision = 0;   // révision à la dernière sauvegarde / au dernier chargement
  private otherDirty = false;  // changements HORS historique (meta / images)
  hasFile = false;             // un fichier est lié (FS API)
  autosaveOn = false;          // préférence auto-save active

  /** Met à jour la révision modèle courante — à appeler à CHAQUE mutation / undo / redo. */
  setRevision(rev: number): void { this.revision = rev; }
  /** Un changement HORS historique modèle a eu lieu (renommage du document, image de façade…). */
  markDirty(): void { this.otherDirty = true; }
  /** Le document vient d'être ÉCRIT : le point courant devient la référence « propre ». */
  markSaved(): void { this.savedRevision = this.revision; this.otherDirty = false; }
  /** Un (nouveau) document vient d'être CHARGÉ / créé à la révision `rev` → état propre. */
  markLoaded(rev: number): void { this.revision = rev; this.savedRevision = rev; this.otherDirty = false; }

  setFile(hasFile: boolean): void { this.hasFile = hasFile; }
  setAutosave(on: boolean): void { this.autosaveOn = on; }

  /** Modifié si la révision a bougé depuis la sauvegarde OU s'il y a un changement hors historique. */
  get dirty(): boolean { return this.revision !== this.savedRevision || this.otherDirty; }
  state(): SaveStateKind { return SaveState.compute({ dirty: this.dirty, hasFile: this.hasFile, autosaveOn: this.autosaveOn }); }
  shouldAutosave(): boolean { return SaveState.shouldAutosave({ dirty: this.dirty, hasFile: this.hasFile }); }
}
