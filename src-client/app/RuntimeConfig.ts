/* =============================================================================
   Configuration d'EXÉCUTION injectée par l'hôte (le backend, quand il sert l'app).
   Permet de fonctionner SANS configuration utilisateur : le backend pose
   `window.__DCMANAGER_CONFIG__ = { mode: "api", apiBaseUrl: "api" }` dans le HTML.
   Absente → mode FICHIER (build statique autonome, ouverture locale).
   ============================================================================= */
export type AppMode = "local" | "api";

export interface RuntimeConfig {
  mode: AppMode;          // "local" = fichier (File System Access) · "api" = backend REST
  apiBaseUrl: string;     // base des endpoints REST — RELATIVE par défaut (résolue contre <base>), compatible sous-dossier
  loginUrl: string;       // URL de connexion SSO (bouton « Connexion » du welcome) — macro ${clbkUrl} = URL courante encodée
}

/** Lecture de la config d'exécution — classe sémantique à méthode statique (principe n°2). */
export class RuntimeConfigLoader {
  /** Lit la config injectée (best-effort) ; défaut = mode fichier, API même origine, pas d'URL de connexion. */
  static read(): RuntimeConfig {
    let c: any = {};
    try { c = (window as any).__DCMANAGER_CONFIG__ || {}; } catch (_) { c = {}; }
    const mode: AppMode = (c.mode === "api") ? "api" : "local";
    const apiBaseUrl = (typeof c.apiBaseUrl === "string" && c.apiBaseUrl.trim()) ? c.apiBaseUrl.trim() : "api";
    const loginUrl = (typeof c.loginUrl === "string") ? c.loginUrl.trim() : "";
    return { mode, apiBaseUrl, loginUrl };
  }
}
