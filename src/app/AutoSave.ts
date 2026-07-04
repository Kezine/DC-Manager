/* =============================================================================
   AUTO-SAVE — timer d'écriture silencieuse (FS API + fichier lié requis),
   extrait de `boot()` (main.ts) dans le cadre du découpage P4. La MÉCANIQUE
   (conditions d'armement, battement, désarmement sur permission révoquée,
   dialogue d'activation) vit ici ; toute l'ADHÉRENCE (fichier lié, permission,
   écriture, chrome, dialogues, toasts) passe par l'hôte injecté `AutoSaveHost`
   — testable avec un hôte simulé (cf. Tests/modules).
   ============================================================================= */
import { SaveState } from "./SaveState";

/** Préférences consommées/écrites (l'instance `Prefs` de l'app les persiste à l'affectation). */
export interface AutoSavePrefs { autosave: boolean; autosaveInterval: number; }

/** Adhérence à l'app, injectée. */
export interface AutoSaveHost {
  hasFsApi(): boolean;                      // File System Access API disponible ?
  hasFile(): boolean;                       // un fichier est lié au document ?
  dirty(): boolean;                         // des modifications non sauvées ?
  ensureWritePermission(): Promise<boolean>;   // (re)demande la permission d'écriture du fichier lié
  write(): Promise<void>;                   // écrit le document dans le fichier lié (+ chrome)
  pickFile(): Promise<void>;                // « Enregistrer sous » : lie un fichier (peut être annulé)
  confirmEnable(): Promise<boolean>;        // dialogue « lier un fichier maintenant ? »
  /** Pousse l'état au chrome (toggle + statut détaillé + pastille). */
  onStateChange(on: boolean, intervalS: number, statusHtml: string): void;
  notify(msg: string, kind?: "err"): void;
}

export class AutoSave {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly prefs: AutoSavePrefs, private readonly host: AutoSaveHost) {}

  /** Statut lisible pour le panneau réglages. */
  statusHtml(): string {
    if (!this.host.hasFsApi()) return "Indisponible — navigateur sans <strong>File System Access API</strong>.";
    if (!this.prefs.autosave) return "État : <strong>off</strong>.";
    if (!this.host.hasFile()) return "État : <strong>en attente d'un fichier</strong> — démarrera à la prochaine (ré)ouverture.";
    return "État : <strong>actif</strong> · toutes les <strong>" + this.prefs.autosaveInterval + "s</strong>.";
  }

  /** (Ré)arme le timer selon les préférences + l'état courant, et pousse l'état au chrome.
      À appeler quand la préférence, le fichier lié ou l'intervalle changent. */
  apply(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.prefs.autosave && this.host.hasFile() && this.host.hasFsApi()) {
      this.timer = setInterval(() => { void this.tick(); }, this.prefs.autosaveInterval * 1000);
    }
    this.host.onStateChange(this.prefs.autosave, this.prefs.autosaveInterval, this.statusHtml());
  }

  /** Un BATTEMENT d'auto-save : n'écrit que si modifié + fichier lié (SaveState.shouldAutosave) ;
      permission révoquée → auto-save désactivé + notification. Public pour être testé directement. */
  async tick(): Promise<void> {
    if (!SaveState.shouldAutosave({ dirty: this.host.dirty(), hasFile: this.host.hasFile() })) return;
    try {
      if (!(await this.host.ensureWritePermission())) {
        this.prefs.autosave = false; this.apply();
        this.host.notify("Auto-save désactivé : permission révoquée", "err");
        return;
      }
      await this.host.write();
    } catch (e) { console.warn("autosave a échoué", e); }
  }

  /** Active/désactive (toggle du panneau réglages). L'activation SANS fichier lié propose d'en choisir un. */
  async setEnabled(on: boolean): Promise<void> {
    if (!on) { this.prefs.autosave = false; this.apply(); this.host.notify("Auto-save désactivé"); return; }
    const refuse = () => this.host.onStateChange(false, this.prefs.autosaveInterval, this.statusHtml());
    if (!this.host.hasFsApi()) { this.host.notify("Auto-save indisponible : navigateur sans File System Access API (Chrome/Edge/Brave/Opera).", "err"); refuse(); return; }
    if (!this.host.hasFile()) {
      if (!(await this.host.confirmEnable())) { refuse(); return; }
      await this.host.pickFile();
      if (!this.host.hasFile()) { refuse(); return; }   // « Enregistrer sous » annulé
    }
    this.prefs.autosave = true; this.apply();
    this.host.notify("Auto-save activé (toutes les " + this.prefs.autosaveInterval + "s)");
  }

  /** Désarme le timer (démontage). */
  dispose(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
