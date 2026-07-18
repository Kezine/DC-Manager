/* =============================================================================
   Préférences GLOBALES de l'application (localStorage) — INDÉPENDANTES du document
   et du cache de session : thème, auto-save (+ fréquence), source de données.
   Le mode "local" utilise le BrowserStorageAdapter (+ fichier) ; le mode "api"
   utilise le RestAdapter (serveur REST multi-documents, cf. main.ts restBootstrap).
   ============================================================================= */
import { FieldFacet } from "./FieldFacet";

export type ThemeName = "dark" | "light";
export type DataSource = "local" | "api";
export type FileAccessMode = "file" | "directory";   // accès FS : 1 autorisation par fichier · 1 autorisation pour le dossier
export interface AppPrefs { theme: ThemeName; autosave: boolean; autosaveInterval: number; dataSource: DataSource; dataSourceUserSet: boolean; apiBaseUrl: string; loginUrl: string; fileAccessMode: FileAccessMode; debugLog: boolean; uiScale: number; autocompleteMaxResults: number; lastRestDocId: string; }

export class Prefs {
  static readonly KEY = "dcmanager.prefs";
  static readonly INTERVAL_DEFAULT = 60;                 // secondes
  static readonly INTERVAL_OPTIONS = [5, 10, 30, 60, 90, 120];
  // échelle d'interface (zoom global) — réglable pour compenser les mobiles qui grossissent les polices.
  static readonly UI_SCALE_DEFAULT = 1;
  // Cette table est évaluée au CHARGEMENT du module (statique), AVANT `I18n.init()` : elle ne stocke donc
  // que des CLÉS i18n (`labelKey`), le libellé étant résolu par `I18n.t(labelKey)` AU RENDU par le consommateur
  // (panneau réglages du Shell) — même pattern que les tables de libellés du domaine (lot B2a).
  static readonly UI_SCALE_OPTIONS: { value: number; labelKey: string }[] = [
    { value: 0.75, labelKey: "shell.settings.scaleVeryCompact" },
    { value: 0.85, labelKey: "shell.settings.scaleCompact" },
    { value: 0.95, labelKey: "shell.settings.scaleReduced" },
    { value: 1, labelKey: "shell.settings.scaleNormal" },
    { value: 1.1, labelKey: "shell.settings.scaleEnlarged" },
  ];

  private data: AppPrefs = { theme: "dark", autosave: false, autosaveInterval: Prefs.INTERVAL_DEFAULT, dataSource: "local", dataSourceUserSet: false, apiBaseUrl: "", loginUrl: "", fileAccessMode: "file", debugLog: false, uiScale: Prefs.UI_SCALE_DEFAULT, autocompleteMaxResults: FieldFacet.MAX_RESULTS_DEFAULT, lastRestDocId: "" };

  constructor() { this.load(); }

  load(): void {
    try {
      const raw = window.localStorage.getItem(Prefs.KEY); if (!raw) return;
      const p = JSON.parse(raw); if (!p || typeof p !== "object") return;
      if (p.theme === "light" || p.theme === "dark") this.data.theme = p.theme;
      this.data.autosave = !!p.autosave;
      if (typeof p.autosaveInterval === "number" && p.autosaveInterval > 0) this.data.autosaveInterval = p.autosaveInterval;
      if (p.dataSource === "local" || p.dataSource === "api") this.data.dataSource = p.dataSource;
      this.data.dataSourceUserSet = !!p.dataSourceUserSet;   // mode CHOISI explicitement par l'utilisateur (≠ défaut injecté)
      if (typeof p.apiBaseUrl === "string") this.data.apiBaseUrl = p.apiBaseUrl;
      if (typeof p.loginUrl === "string") this.data.loginUrl = p.loginUrl;
      if (p.fileAccessMode === "file" || p.fileAccessMode === "directory") this.data.fileAccessMode = p.fileAccessMode;
      this.data.debugLog = !!p.debugLog;
      if (typeof p.uiScale === "number" && p.uiScale >= 0.5 && p.uiScale <= 2) this.data.uiScale = p.uiScale;
      if (p.autocompleteMaxResults != null) this.data.autocompleteMaxResults = FieldFacet.clampLimit(p.autocompleteMaxResults);
      if (typeof p.lastRestDocId === "string") this.data.lastRestDocId = p.lastRestDocId;
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
  // Choisir le mode = acte EXPLICITE de l'utilisateur → on marque dataSourceUserSet (prime sur le défaut injecté).
  set dataSource(v: DataSource) { this.data.dataSource = (v === "api") ? "api" : "local"; this.data.dataSourceUserSet = true; this.save(); }
  get dataSourceUserSet(): boolean { return this.data.dataSourceUserSet; }
  get apiBaseUrl(): string { return this.data.apiBaseUrl; }
  set apiBaseUrl(v: string) { this.data.apiBaseUrl = (typeof v === "string") ? v.trim() : ""; this.save(); }
  get loginUrl(): string { return this.data.loginUrl; }
  set loginUrl(v: string) { this.data.loginUrl = (typeof v === "string") ? v.trim() : ""; this.save(); }
  get fileAccessMode(): FileAccessMode { return this.data.fileAccessMode; }
  set fileAccessMode(v: FileAccessMode) { this.data.fileAccessMode = (v === "directory") ? "directory" : "file"; this.save(); }
  get debugLog(): boolean { return this.data.debugLog; }
  set debugLog(v: boolean) { this.data.debugLog = !!v; this.save(); }
  get uiScale(): number { return this.data.uiScale; }
  set uiScale(v: number) { this.data.uiScale = (typeof v === "number" && v >= 0.5 && v <= 2) ? v : Prefs.UI_SCALE_DEFAULT; this.save(); }
  // Nb MAX de suggestions d'autocomplétion (Marque/Modèle/Nom/Personne…). Plafonné à 100 (FieldFacet.MAX_RESULTS_ABS).
  get autocompleteMaxResults(): number { return this.data.autocompleteMaxResults; }
  set autocompleteMaxResults(v: number) { this.data.autocompleteMaxResults = FieldFacet.clampLimit(v); this.save(); }
  // DERNIER document serveur OUVERT (mode API) — mémorisé par navigateur pour le rouvrir au prochain lancement.
  // "" = aucun (le boot retombe alors sur le doc par défaut global, puis sur le plus récent). Cf. restBootstrap.
  get lastRestDocId(): string { return this.data.lastRestDocId; }
  set lastRestDocId(v: string) { this.data.lastRestDocId = (typeof v === "string") ? v : ""; this.save(); }
}
