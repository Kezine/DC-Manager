/** Définition d'une vue enregistrée dans le shell. */
export interface ShellView {
  /** Nom logique (→ id du conteneur « view-<name> »). */
  name: string;
  /** Libellé de l'onglet (topbar) / du bouton de lien. */
  label: string;
  /** Titre ▸ de l'en-tête de vue (défaut = label). */
  title?: string;
  /** Sous-titre (view-sub) de l'en-tête. */
  subtitle?: string;
  /** "primary" = onglet de la topbar · "secondary" = sous-vue (atteinte par un lien d'en-tête). */
  kind?: "primary" | "secondary";
  /** Onglet principal à surligner quand cette (sous-)vue est active + cible du « ← retour ». */
  parent?: string;
  /** Compteur affiché en badge (onglet topbar + tout lien qui pointe vers cette vue). */
  count?: () => number;
  /** Noms de sous-vues exposées comme boutons-liens dans l'en-tête de CETTE vue. */
  links?: string[];
  /** Libellé du bouton primaire « + … » de l'en-tête (si action de création). */
  addLabel?: string;
  /** Action du bouton primaire. */
  onAdd?: () => void;
  /** Boutons secondaires (ghost) de l'en-tête, avant le bouton primaire. */
  extraActions?: Array<{ label: string; onClick: () => void; title?: string }>;
  /** Appelé à chaque activation (rendu / rafraîchissement) avec le corps de vue. */
  onShow?: (body: HTMLElement) => void;
}

/** Services applicatifs de la topbar (fichier / global), câblés par le bootstrap. */
export interface ShellHost {
  onNew?(): void; onOpen?(): void; onSave?(): void; onSaveAs?(): void;
  onUndo?(): void; onRedo?(): void;
  onToggleTheme?(): void; onResetViewPrefs?(): void;
  onRenameDoc?(name: string): void;
  /** Bascule de la source de données ("local" | "api"). */
  onDataSource?(value: string): void;
  /** Bascule du mode d'accès FS ("file" | "directory"). */
  onFileAccessMode?(value: string): void;
  /** Ouverture en FORÇANT un mode d'accès ("file" | "directory") — depuis l'écran d'accueil. */
  onOpenMode?(mode: string): void;
  /** Active/désactive les logs de débogage console. */
  onDebugLog?(on: boolean): void;
  /** Activation/désactivation de l'auto-save (Promise → état effectif appliqué). */
  onAutosaveToggle?(on: boolean): void;
  /** Changement de fréquence d'auto-save (secondes). */
  onAutosaveInterval?(seconds: number): void;
  /** Réouverture du dernier fichier (raccroche au handle FS — geste utilisateur). */
  onReopenLast?(): void;
}

/** Champs de la barre de statut. */
export interface ShellStatus { file?: string; release?: string; source?: string; entities?: number | string; lastSave?: string; }

import { Prefs } from "../core/Prefs";

const SVG = "http://www.w3.org/2000/svg";
const svgIcon = (paths: string): SVGElement => {
  const s = document.createElementNS(SVG, "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.innerHTML = paths; return s;
};

interface ViewEntry { def: ShellView; section: HTMLElement; header: HTMLElement; body: HTMLElement; tabBtn?: HTMLButtonElement; }

/* =============================================================================
   SHELL — ossature complète, fidèle au monolithe :
     · TOPBAR : logo + marque + nom de document + onglets PRINCIPAUX + actions
       fichier (nouveau / ouvrir / enregistrer / copie / annuler / rétablir) + réglages ;
     · STATUSBAR : état de sauvegarde, fichier, release, source, nb d'entités, dernière save ;
     · MAIN : une <section> par vue, chacune avec son `.view-header` (titre ▸ + sous-titre +
       actions : liens de sous-vues / bouton « ← retour » / bouton « + … ») et son corps.
   Les SOUS-VUES ne sont PLUS un bandeau : elles vivent dans l'en-tête de leur domaine.
   ============================================================================= */
export class Shell {
  private tabsEl: HTMLElement;
  private mainEl: HTMLElement;
  private actionsEl: HTMLElement;
  private docNameEl: HTMLInputElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private saveDot!: HTMLElement;
  private dataSourceSel!: HTMLSelectElement;
  private fileAccessSel!: HTMLSelectElement;
  private debugLogChk!: HTMLInputElement;
  private fileActionsEl!: HTMLElement;            // boutons fichier de la topbar (masqués en mode API)
  private fileOnlySections: HTMLElement[] = [];   // sections de réglages propres au mode fichier (auto-save, accès fichiers)
  private userChip!: HTMLElement;                 // pastille « connecté en tant que … » (mode API)
  private autosaveChk!: HTMLInputElement;
  private autosaveIntervalSel!: HTMLSelectElement;
  private autosaveStatusEl!: HTMLElement;
  private welcomeEl!: HTMLElement;
  private welcomeReopenBtn!: HTMLButtonElement;
  private welcomeOpenDirBtn!: HTMLButtonElement;
  private welcomeOpenFileBtn!: HTMLButtonElement;
  private welcomeModeEl!: HTMLElement;
  private welcomeAuthEl!: HTMLElement;            // bloc « accès refusé / non connecté » (mode API)
  private welcomeAuthMsg!: HTMLElement;
  private welcomeAuthBtn!: HTMLButtonElement;
  private welcomeNormalEls: HTMLElement[] = [];   // contenu « fichier » du welcome (masqué en accès refusé)
  private statusEls: Record<string, HTMLElement> = {};
  private views = new Map<string, ViewEntry>();
  private order: string[] = [];
  private countBadges: Array<{ name: string; el: HTMLElement }> = [];
  private host: ShellHost;
  current: string | null = null;

  constructor(root: HTMLElement, host: ShellHost = {}) {
    this.host = host;
    root.innerHTML = "";
    // flux BLOC (comme <body> du monolithe) : `main { max-width:95vw; margin:0 auto }` se centre
    // correctement. En flex-column, les marges auto d'un item écrasent le stretch → main rétrécit
    // à son contenu (régression « onglets étroits »). La topbar/statusbar restent sticky.
    root.style.cssText = "display:block;min-height:100vh;position:relative;z-index:1";

    // ---- TOPBAR ----
    const topbar = document.createElement("div"); topbar.className = "topbar";
    const brand = document.createElement("div"); brand.className = "brand";
    const logo = document.createElement("div"); logo.className = "brand-logo";
    logo.appendChild(svgIcon('<circle cx="5" cy="6" r="2.4"/><circle cx="19" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M5 8.4V12h14V8.4M12 12v3.6"/>'));
    const name = document.createElement("span"); name.className = "brand-name"; name.textContent = "NETMAP";
    const docName = document.createElement("input"); docName.type = "text"; docName.className = "doc-name"; docName.placeholder = "Nom du document"; docName.maxLength = 64;
    docName.addEventListener("change", () => this.host.onRenameDoc?.(docName.value.trim()));
    brand.append(logo, name, docName);

    const tabs = document.createElement("nav"); tabs.className = "tabs"; tabs.id = "tabs";

    const actions = document.createElement("div"); actions.className = "topbar-actions";
    const iconBtn = (title: string, paths: string, onClick?: () => void): HTMLButtonElement => {
      const b = document.createElement("button"); b.type = "button"; b.className = "icon-btn"; b.title = title;
      b.appendChild(svgIcon(paths)); if (onClick) b.onclick = onClick; return b;
    };
    // actions FICHIER (masquées en mode API : le serveur fait autorité, la sauvegarde est continue)
    this.fileActionsEl = document.createElement("span"); this.fileActionsEl.style.display = "contents";
    this.fileActionsEl.appendChild(iconBtn("Nouveau document (Ctrl+N)", '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>', () => this.host.onNew?.()));
    this.fileActionsEl.appendChild(iconBtn("Ouvrir un fichier (Ctrl+O)", '<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', () => this.host.onOpen?.()));
    this.saveBtn = iconBtn("Enregistrer (Ctrl+S)", '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>', () => this.host.onSave?.());
    this.fileActionsEl.appendChild(this.saveBtn);
    this.fileActionsEl.appendChild(iconBtn("Enregistrer une copie sous… (Ctrl+Shift+S)", '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><circle cx="18" cy="18" r="3" stroke-dasharray="2 2"/>', () => this.host.onSaveAs?.()));
    actions.appendChild(this.fileActionsEl);
    this.undoBtn = iconBtn("Annuler (Ctrl+Z)", '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-5"/>', () => this.host.onUndo?.()); this.undoBtn.disabled = true;
    this.redoBtn = iconBtn("Rétablir (Ctrl+Maj+Z)", '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h5"/>', () => this.host.onRedo?.()); this.redoBtn.disabled = true;
    actions.append(this.undoBtn, this.redoBtn);
    // pastille utilisateur (mode API) : « connecté en tant que … » — masquée par défaut
    this.userChip = document.createElement("span"); this.userChip.className = "user-chip"; this.userChip.style.display = "none";
    actions.appendChild(this.userChip);
    actions.appendChild(this.buildSettingsMenu());

    topbar.append(brand, tabs, actions);

    // ---- STATUSBAR ----
    const statusbar = document.createElement("div"); statusbar.className = "statusbar";
    const stat = (html: string) => { const d = document.createElement("div"); d.className = "status-stat"; d.innerHTML = html; statusbar.appendChild(d); return d; };
    this.saveDot = document.createElement("span"); this.saveDot.className = "save-state-icon mem";
    const sd = document.createElement("div"); sd.className = "status-stat"; sd.appendChild(this.saveDot); statusbar.appendChild(sd);
    this.statusEls.file = stat('FICHIER <strong>— en mémoire —</strong>').querySelector("strong")!;
    this.statusEls.release = stat('RELEASE <strong>—</strong>').querySelector("strong")!;
    this.statusEls.source = stat('SOURCE <strong>navigateur</strong>').querySelector("strong")!;
    this.statusEls.entities = stat('ENTITÉS <strong>0</strong>').querySelector("strong")!;
    this.statusEls.lastSave = stat('DERNIÈRE SAUVEGARDE <strong>—</strong>').querySelector("strong")!;

    const main = document.createElement("main");   // styles pilotés par netmap.css (padding, max-width, :has full-bleed)

    root.append(topbar, statusbar, main, this.buildWelcome());
    this.tabsEl = tabs; this.mainEl = main; this.actionsEl = actions; this.docNameEl = docName;
  }

  private buildSettingsMenu(): HTMLElement {
    const wrap = document.createElement("div"); wrap.className = "settings-menu";
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "icon-btn"; btn.title = "Réglages"; btn.setAttribute("aria-haspopup", "menu");
    btn.appendChild(svgIcon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'));
    const pop = document.createElement("div"); pop.className = "settings-popover"; pop.setAttribute("role", "menu");
    const section = (title: string) => { const s = document.createElement("div"); s.className = "settings-section"; const t = document.createElement("div"); t.className = "settings-section-title"; t.textContent = title; s.appendChild(t); pop.appendChild(s); return s; };

    // -- Source de données (Local / API désactivé) --
    const src = section("Source de données");
    const srcRow = document.createElement("div"); srcRow.className = "settings-row";
    const srcLbl = document.createElement("label"); srcLbl.className = "settings-row-label"; srcLbl.textContent = "Mode";
    this.dataSourceSel = document.createElement("select"); this.dataSourceSel.className = "settings-row-select";
    const oLocal = document.createElement("option"); oLocal.value = "local"; oLocal.textContent = "Local (session)";
    const oApi = document.createElement("option"); oApi.value = "api"; oApi.textContent = "API (serveur) — bientôt"; oApi.disabled = true;
    this.dataSourceSel.append(oLocal, oApi);
    this.dataSourceSel.onchange = () => this.host.onDataSource?.(this.dataSourceSel.value);
    srcRow.append(srcLbl, this.dataSourceSel); src.appendChild(srcRow);
    const srcNote = document.createElement("div"); srcNote.className = "settings-row-note"; srcNote.textContent = "Local : les données vivent dans le navigateur (session), liables à un fichier JSON sur disque. API : synchronisation serveur — pas encore disponible."; src.appendChild(srcNote);

    // -- Accès aux fichiers (par fichier / par dossier) --
    const fa = section("Accès aux fichiers");
    const faRow = document.createElement("div"); faRow.className = "settings-row";
    const faLbl = document.createElement("label"); faLbl.className = "settings-row-label"; faLbl.textContent = "Mode";
    this.fileAccessSel = document.createElement("select"); this.fileAccessSel.className = "settings-row-select";
    const oFile = document.createElement("option"); oFile.value = "file"; oFile.textContent = "Fichier";
    const oDir = document.createElement("option"); oDir.value = "directory"; oDir.textContent = "Dossier";
    this.fileAccessSel.append(oFile, oDir);
    this.fileAccessSel.onchange = () => this.host.onFileAccessMode?.(this.fileAccessSel.value);
    faRow.append(faLbl, this.fileAccessSel); fa.appendChild(faRow);
    const faNote = document.createElement("div"); faNote.className = "settings-row-note"; faNote.textContent = "Fichier : on autorise chaque .json et son compagnon d'images .nmfb séparément. Dossier : on autorise un dossier UNE fois — le .json et son .nmfb y sont lus/écrits sans nouvelle demande."; fa.appendChild(faNote);

    // -- Auto-save (toggle + fréquence + état) --
    const as = section("Auto-save");
    const asRow = document.createElement("div"); asRow.className = "settings-toggle-row";
    const asLabel = document.createElement("label"); asLabel.className = "settings-toggle";
    this.autosaveChk = document.createElement("input"); this.autosaveChk.type = "checkbox";
    this.autosaveChk.onchange = () => this.host.onAutosaveToggle?.(this.autosaveChk.checked);
    asLabel.append(this.autosaveChk, document.createTextNode("Activer l'auto-save"));
    asRow.appendChild(asLabel); as.appendChild(asRow);
    const freqRow = document.createElement("div"); freqRow.className = "settings-row"; freqRow.style.marginTop = "10px";
    const freqLbl = document.createElement("label"); freqLbl.className = "settings-row-label"; freqLbl.textContent = "Fréquence";
    this.autosaveIntervalSel = document.createElement("select"); this.autosaveIntervalSel.className = "settings-row-select";
    Prefs.INTERVAL_OPTIONS.forEach((n) => { const o = document.createElement("option"); o.value = String(n); o.textContent = n + " s"; this.autosaveIntervalSel.appendChild(o); });
    this.autosaveIntervalSel.onchange = () => this.host.onAutosaveInterval?.(parseInt(this.autosaveIntervalSel.value, 10));
    freqRow.append(freqLbl, this.autosaveIntervalSel); as.appendChild(freqRow);
    this.autosaveStatusEl = document.createElement("div"); this.autosaveStatusEl.className = "settings-status-line"; as.appendChild(this.autosaveStatusEl);
    this.fileOnlySections.push(fa, as);   // sections propres au mode fichier → masquées en mode API

    // -- Apparence --
    const app = section("Apparence");
    const themeBtn = document.createElement("button"); themeBtn.type = "button"; themeBtn.className = "btn btn-ghost btn-sm"; themeBtn.style.width = "100%"; themeBtn.textContent = "Basculer le thème clair / sombre";
    themeBtn.onclick = () => this.host.onToggleTheme?.(); app.appendChild(themeBtn);
    // -- Affichage 3D --
    const v3d = section("Affichage 3D");
    const resetBtn = document.createElement("button"); resetBtn.type = "button"; resetBtn.className = "btn btn-ghost btn-sm"; resetBtn.style.width = "100%"; resetBtn.textContent = "Réinitialiser les préférences d'affichage";
    resetBtn.onclick = () => this.host.onResetViewPrefs?.(); v3d.appendChild(resetBtn);
    // -- Débogage --
    const dbg = section("Débogage");
    const dbgRow = document.createElement("div"); dbgRow.className = "settings-toggle-row";
    const dbgLabel = document.createElement("label"); dbgLabel.className = "settings-toggle";
    this.debugLogChk = document.createElement("input"); this.debugLogChk.type = "checkbox";
    this.debugLogChk.onchange = () => this.host.onDebugLog?.(this.debugLogChk.checked);
    dbgLabel.append(this.debugLogChk, document.createTextNode("Logs de débogage (console)"));
    dbgRow.appendChild(dbgLabel); dbg.appendChild(dbgRow);
    const dbgNote = document.createElement("div"); dbgNote.className = "settings-row-note"; dbgNote.textContent = "Trace les opérations (fichier, compagnon, …) dans la console du navigateur. À activer pour diagnostiquer."; dbg.appendChild(dbgNote);

    btn.onclick = (e) => { e.stopPropagation(); pop.classList.toggle("open"); };
    document.addEventListener("click", () => pop.classList.remove("open"));
    pop.addEventListener("click", (e) => e.stopPropagation());
    wrap.append(btn, pop);
    return wrap;
  }

  /** Écran d'accueil (overlay) : rouvrir le dernier fichier (raccroche le handle) / ouvrir / nouveau. */
  private buildWelcome(): HTMLElement {
    const screen = document.createElement("div"); screen.className = "welcome-screen"; screen.style.display = "none"; screen.setAttribute("role", "dialog");
    const card = document.createElement("div"); card.className = "welcome-card";
    const logo = document.createElement("div"); logo.className = "welcome-logo";
    logo.appendChild(svgIcon('<circle cx="5" cy="6" r="2.4"/><circle cx="19" cy="6" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M5 8.4V12h14V8.4M12 12v3.6"/>'));
    const title = document.createElement("h1"); title.className = "welcome-title"; title.textContent = "NETMAP";
    // rappel du mode d'accès actuel (fichier / dossier) — rempli par setWelcomeMode()
    this.welcomeModeEl = document.createElement("p"); this.welcomeModeEl.className = "welcome-mode-badge";
    const acts = document.createElement("div"); acts.className = "welcome-actions";
    this.welcomeReopenBtn = document.createElement("button"); this.welcomeReopenBtn.type = "button"; this.welcomeReopenBtn.className = "btn btn-primary welcome-btn"; this.welcomeReopenBtn.style.display = "none";
    this.welcomeReopenBtn.onclick = () => this.host.onReopenLast?.();
    // deux ouvertures explicites : « Fichier » (1 autorisation par fichier) · « Dossier » (1 autorisation pour tout).
    this.welcomeOpenFileBtn = document.createElement("button"); this.welcomeOpenFileBtn.type = "button"; this.welcomeOpenFileBtn.className = "btn btn-primary welcome-btn"; this.welcomeOpenFileBtn.textContent = "Ouvrir un fichier"; this.welcomeOpenFileBtn.onclick = () => this.host.onOpenMode?.("file");
    this.welcomeOpenDirBtn = document.createElement("button"); this.welcomeOpenDirBtn.type = "button"; this.welcomeOpenDirBtn.className = "btn welcome-btn"; this.welcomeOpenDirBtn.textContent = "Ouvrir un dossier"; this.welcomeOpenDirBtn.onclick = () => this.host.onOpenMode?.("directory");
    const newBtn = document.createElement("button"); newBtn.type = "button"; newBtn.className = "btn welcome-btn"; newBtn.textContent = "Créer un nouveau document"; newBtn.onclick = () => this.host.onNew?.();
    acts.append(this.welcomeReopenBtn, this.welcomeOpenFileBtn, this.welcomeOpenDirBtn, newBtn);
    const hint = document.createElement("p"); hint.className = "welcome-mode-hint"; hint.textContent = "Mode local (session) : à la fermeture de l'onglet, les données ne sont pas conservées dans le navigateur — votre fichier reste la référence.";
    // bloc « auth » (mode API) : message d'accès refusé / non connecté + bouton Réessayer — masqué par défaut
    this.welcomeAuthEl = document.createElement("div"); this.welcomeAuthEl.className = "welcome-auth"; this.welcomeAuthEl.style.display = "none";
    this.welcomeAuthMsg = document.createElement("p"); this.welcomeAuthMsg.className = "welcome-auth-msg";
    this.welcomeAuthBtn = document.createElement("button"); this.welcomeAuthBtn.type = "button"; this.welcomeAuthBtn.className = "btn btn-primary welcome-btn"; this.welcomeAuthBtn.textContent = "Réessayer";
    this.welcomeAuthEl.append(this.welcomeAuthMsg, this.welcomeAuthBtn);
    this.welcomeNormalEls = [this.welcomeModeEl, acts, hint];   // contenu « fichier » à masquer en cas d'accès refusé
    card.append(logo, title, this.welcomeModeEl, acts, hint, this.welcomeAuthEl);
    screen.appendChild(card);
    this.welcomeEl = screen;
    return screen;
  }

  /** Affiche l'écran d'accueil en état « accès refusé / non connecté » (mode API), avec un bouton Réessayer. */
  showAccessDenied(opts: { connected: boolean; user?: string; onRetry: () => void }): void {
    this.welcomeNormalEls.forEach((el) => { if (el) el.style.display = "none"; });
    this.welcomeAuthEl.style.display = "";
    this.welcomeAuthMsg.textContent = opts.connected
      ? "Connecté en tant que « " + (opts.user || "?") + " », mais ce compte n'a pas les droits requis (SUPER_ADMIN). Contactez un administrateur."
      : "Vous n'êtes pas authentifié auprès du SSO. Connectez-vous, puis réessayez.";
    this.welcomeAuthBtn.onclick = () => opts.onRetry();
    this.welcomeEl.style.display = "";
    document.body.classList.add("welcome-active");
  }

  /** Affiche l'écran d'accueil. `reopenName` (≠ null) montre « Rouvrir « … » » ; `mode`/`fsApi` règlent le rappel. */
  showWelcome(opts: { reopenName?: string | null; mode?: string; fsApi?: boolean } = {}): void {
    this.welcomeAuthEl.style.display = "none";                                  // sort de l'état « accès refusé »
    this.welcomeNormalEls.forEach((el) => { if (el) el.style.display = ""; });   // restaure le contenu fichier
    this.setReopen(opts.reopenName ?? null);
    this.setWelcomeMode(opts.mode || "file", opts.fsApi !== false);
    this.welcomeEl.style.display = "";
    document.body.classList.add("welcome-active");
  }
  /** Rappel du mode d'accès courant + mise en avant du bouton d'ouverture correspondant. */
  setWelcomeMode(mode: string, fsApi: boolean): void {
    if (!this.welcomeModeEl) return;
    const dir = mode === "directory";
    this.welcomeModeEl.innerHTML = "Mode d'accès : <strong>" + (dir ? "Dossier" : "Fichier") + "</strong> — "
      + (dir ? "une autorisation couvre le document et ses images (.nmfb)." : "autorisation par fichier (le .json et son .nmfb séparément).");
    // bouton « dossier » masqué si le navigateur n'a pas la File System Access API
    this.welcomeOpenDirBtn.style.display = fsApi ? "" : "none";
    // met en avant (primaire) l'ouverture du MODE COURANT ; l'autre reste une option secondaire
    this.welcomeOpenFileBtn.classList.toggle("btn-primary", !dir);
    this.welcomeOpenDirBtn.classList.toggle("btn-primary", dir);
  }
  hideWelcome(): void { this.welcomeEl.style.display = "none"; document.body.classList.remove("welcome-active"); }
  /** Configure le bouton « Rouvrir » (null = masqué). */
  setReopen(name: string | null): void {
    if (name) { this.welcomeReopenBtn.style.display = ""; this.welcomeReopenBtn.textContent = "Rouvrir « " + name + " »"; }
    else this.welcomeReopenBtn.style.display = "none";
  }

  /** Enregistre une vue (section + en-tête vide + corps). L'en-tête est rempli par build(). Renvoie le CORPS. */
  addView(def: ShellView): HTMLElement {
    const section = document.createElement("section");
    section.className = "view"; section.id = "view-" + def.name;
    const header = document.createElement("div"); header.className = "view-header";
    const body = document.createElement("div"); body.className = "view-body";   // flux bloc, comme le contenu de vue d'origine
    section.append(header, body);
    this.mainEl.appendChild(section);
    this.views.set(def.name, { def, section, header, body });
    this.order.push(def.name);
    return body;
  }

  /** Construit la topbar (onglets principaux) et toutes les en-têtes de vue. À appeler après tous les addView. */
  build(): void {
    this.tabsEl.innerHTML = "";
    this.countBadges = [];
    // onglets principaux (vues non secondaires), dans l'ordre d'enregistrement
    this.order.forEach((nm) => {
      const v = this.views.get(nm)!; if (v.def.kind === "secondary") return;
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "tab"; btn.dataset.view = nm;
      btn.appendChild(document.createTextNode(v.def.label + " "));
      if (v.def.count) { const badge = document.createElement("span"); badge.className = "tab-count"; btn.appendChild(badge); this.countBadges.push({ name: nm, el: badge }); }
      btn.onclick = () => this.switchView(nm);
      v.tabBtn = btn; this.tabsEl.appendChild(btn);
    });
    // en-têtes de vue
    this.views.forEach((v) => this.buildHeader(v));
    this.refreshCounts();
  }

  private buildHeader(v: ViewEntry): void {
    const def = v.def;
    v.header.innerHTML = "";
    const left = document.createElement("div");
    const title = document.createElement("div"); title.className = "view-title";
    const caret = document.createElement("span"); caret.textContent = "▸"; title.append(caret, document.createTextNode(" " + (def.title || def.label)));
    left.appendChild(title);
    if (def.subtitle) { const sub = document.createElement("div"); sub.className = "view-sub"; sub.textContent = def.subtitle; left.appendChild(sub); }
    const acts = document.createElement("div"); acts.className = "view-actions";
    // bouton « ← retour » (sous-vue → parent)
    if (def.parent && this.views.has(def.parent)) {
      const p = this.views.get(def.parent)!.def;
      const back = document.createElement("button"); back.type = "button"; back.className = "btn btn-ghost"; back.textContent = "← " + p.label; back.title = "Retour : " + p.label;
      back.onclick = () => this.switchView(def.parent!); acts.appendChild(back);
    }
    // liens vers les sous-vues du domaine (avec badge de comptage)
    (def.links || []).forEach((ln) => {
      const target = this.views.get(ln); if (!target) return;
      const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost"; b.title = target.def.label;
      b.appendChild(document.createTextNode(target.def.label + " "));
      if (target.def.count) { const badge = document.createElement("span"); badge.className = "tab-count"; b.appendChild(badge); this.countBadges.push({ name: ln, el: badge }); }
      b.onclick = () => this.switchView(ln); acts.appendChild(b);
    });
    // boutons secondaires (ghost) — ex. « Ouvrir un fichier de faces »
    (def.extraActions || []).forEach((a) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost"; b.textContent = a.label; if (a.title) b.title = a.title; b.onclick = () => a.onClick(); acts.appendChild(b); });
    // bouton primaire « + … »
    if (def.onAdd) { const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-primary"; add.textContent = def.addLabel || "+ Nouveau"; add.onclick = () => def.onAdd!(); acts.appendChild(add); }
    v.header.append(left, acts);
    if (!acts.children.length) v.header.style.alignItems = "center";
  }

  switchView(name: string): void {
    if (!this.views.has(name)) return;
    this.current = name;
    const active = this.views.get(name)!;
    const activeTab = active.def.parent || name;
    this.views.forEach((v, n) => {
      if (v.tabBtn) v.tabBtn.classList.toggle("active", n === activeTab);
      v.section.classList.toggle("active", n === name);
    });
    if (active.def.onShow) { try { active.def.onShow(active.body); } catch (e) { console.error(e); } }
    this.refreshCounts();
  }

  /** Re-rend la vue active (cohérence inter-vues sur mutation du modèle). */
  refreshActive(): void {
    if (!this.current) return;
    const v = this.views.get(this.current);
    if (v && v.def.onShow) { try { v.def.onShow(v.body); } catch (e) { console.error(e); } }
    this.refreshCounts();
  }

  /** Met à jour tous les badges de comptage (onglets topbar + liens d'en-tête). */
  refreshCounts(): void {
    this.countBadges.forEach(({ name, el }) => { const v = this.views.get(name); if (v && v.def.count) el.textContent = String(v.def.count()); });
  }

  /* ---- chrome : statut / nom de document / undo-redo ---- */
  setDocName(n: string): void { if (document.activeElement !== this.docNameEl) this.docNameEl.value = n || ""; }
  setStatus(s: ShellStatus): void {
    if (s.file != null && this.statusEls.file) this.statusEls.file.textContent = s.file;
    if (s.release != null && this.statusEls.release) this.statusEls.release.textContent = s.release;
    if (s.source != null && this.statusEls.source) this.statusEls.source.textContent = s.source;
    if (s.entities != null && this.statusEls.entities) this.statusEls.entities.textContent = String(s.entities);
    if (s.lastSave != null && this.statusEls.lastSave) this.statusEls.lastSave.textContent = s.lastSave;
  }
  setUndoRedo(canUndo: boolean, canRedo: boolean): void { this.undoBtn.disabled = !canUndo; this.redoBtn.disabled = !canRedo; }
  /** Pastille d'état de sauvegarde : "mem" | "clean" | "dirty" | "dirty-on". */
  setSaveState(state: string): void {
    this.saveDot.className = "save-state-icon " + state;
    // bouton « Enregistrer » mis en évidence (`has-unsaved`) dès qu'il y a des modifications non enregistrées
    // (dirty ou dirty-on), comme la référence — pour signaler qu'un save est en attente même avec auto-save actif.
    if (this.saveBtn) this.saveBtn.classList.toggle("has-unsaved", state === "dirty" || state === "dirty-on");
  }
  setDataSource(value: string): void { this.dataSourceSel.value = value; }
  setFileAccessMode(value: string): void { this.fileAccessSel.value = value; }
  setDebugLog(on: boolean): void { this.debugLogChk.checked = on; }
  /** Pastille utilisateur (mode API). `user` = objet SSO (login/nom/prénom/eMail…) ; null = non connecté ; undefined = masquer. */
  setUser(user: { name?: string; prenom?: string; nom?: string; login?: string; email?: string; eMail?: string } | null | undefined): void {
    if (!this.userChip) return;
    if (user === undefined) { this.userChip.style.display = "none"; return; }
    this.userChip.style.display = "";
    if (user) {
      const who = user.name || [user.prenom, user.nom].filter(Boolean).join(" ") || user.login || user.eMail || user.email || "utilisateur";
      this.userChip.textContent = "👤 " + who; this.userChip.title = "Connecté en tant que " + who; this.userChip.classList.remove("user-chip--off");
    } else {
      this.userChip.textContent = "👤 non connecté"; this.userChip.title = "Aucune session SSO active"; this.userChip.classList.add("user-chip--off");
    }
  }
  /** Mode API : masque les contrôles propres au mode fichier (actions topbar + réglages auto-save/accès fichiers). */
  setRestMode(on: boolean): void {
    if (this.fileActionsEl) this.fileActionsEl.style.display = on ? "none" : "contents";
    this.fileOnlySections.forEach((s) => { if (s) s.style.display = on ? "none" : ""; });
    if (on) this.dataSourceSel.value = "api";
  }
  /** Reflète l'état auto-save dans le popover (case + fréquence). */
  setAutosave(on: boolean, interval: number): void { this.autosaveChk.checked = on; this.autosaveIntervalSel.value = String(interval); }
  setAutosaveStatus(html: string): void { this.autosaveStatusEl.innerHTML = html; }
}
