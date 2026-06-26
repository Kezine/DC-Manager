/* =============================================================================
   Préférences GLOBALES de l'application (localStorage) — INDÉPENDANTES du document
   et du cache de session : thème, auto-save (+ fréquence), source de données.
   Le mode "local" utilise le BrowserStorageAdapter (+ fichier) ; le mode "api"
   (RestAdapter) n'est pas encore implémenté et reste désactivé dans l'UI.
   ============================================================================= */
export type ThemeName = "dark" | "light";
export type DataSource = "local" | "api";
export type FileAccessMode = "file" | "directory";   // accès FS : 1 autorisation par fichier · 1 autorisation pour le dossier
export interface AppPrefs { theme: ThemeName; autosave: boolean; autosaveInterval: number; dataSource: DataSource; fileAccessMode: FileAccessMode; debugLog: boolean; }

export class Prefs {
  static readonly KEY = "netmap.prefs";
  static readonly INTERVAL_DEFAULT = 60;                 // secondes
  static readonly INTERVAL_OPTIONS = [5, 10, 30, 60, 90, 120];

  private data: AppPrefs = { theme: "dark", autosave: false, autosaveInterval: Prefs.INTERVAL_DEFAULT, dataSource: "local", fileAccessMode: "file", debugLog: false };

  constructor() { this.load(); }

  load(): void {
    try {
      const raw = window.localStorage.getItem(Prefs.KEY); if (!raw) return;
      const p = JSON.parse(raw); if (!p || typeof p !== "object") return;
      if (p.theme === "light" || p.theme === "dark") this.data.theme = p.theme;
      this.data.autosave = !!p.autosave;
      if (typeof p.autosaveInterval === "number" && p.autosaveInterval > 0) this.data.autosaveInterval = p.autosaveInterval;
      if (p.dataSource === "local" || p.dataSource === "api") this.data.dataSource = p.dataSource;
      if (p.fileAccessMode === "file" || p.fileAccessMode === "directory") this.data.fileAccessMode = p.fileAccessMode;
      this.data.debugLog = !!p.debugLog;
    } catch (e) { console.warn("Prefs.load a échoué", e); }
  }
  save(): void { try { window.localStorage.setItem(Prefs.KEY, JSON.stringify(this.data)); } catch (e) { console.warn("Prefs.save a échoué", e); } }

  get theme(): ThemeName { return this.data.theme; }
  set theme(v: ThemeName) { this.data.theme = v; this.save(); }
  get autosave(): boolean { return this.data.autosave; }
  set autosave(v: boolean) { this.data.autosave = v; this.save(); }
  get autosaveInterval(): number { return this.data.autosaveInterval; }
  set autosaveInterval(v: number) { this.data.autosaveInterval = (v > 0) ? v : Prefs.INTERVAL_DEFAULT; this.save(); }
  get dataSource(): DataSource { return this.data.dataSource; }
  set dataSource(v: DataSource) { this.data.dataSource = v; this.save(); }
  get fileAccessMode(): FileAccessMode { return this.data.fileAccessMode; }
  set fileAccessMode(v: FileAccessMode) { this.data.fileAccessMode = (v === "directory") ? "directory" : "file"; this.save(); }
  get debugLog(): boolean { return this.data.debugLog; }
  set debugLog(v: boolean) { this.data.debugLog = !!v; this.save(); }
}
