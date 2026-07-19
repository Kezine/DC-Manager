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
  /** "primary" = onglet de la topbar · "secondary" = sous-vue (atteinte par un lien d'en-tête) ·
      "group" = onglet TOUJOURS DÉROULANT (ne navigue pas — cf. `children` ; enregistré via `addGroup`). */
  kind?: "primary" | "secondary" | "group";
  /** Onglet principal à surligner quand cette (sous-)vue est active + cible du « ← retour ». */
  parent?: string;
  /** Pour kind:"group" : noms des sous-vues (kind:"secondary", parent = ce groupe) déroulées par l'onglet. */
  children?: string[];
  /** Compteur affiché en badge (onglet topbar + tout lien qui pointe vers cette vue). Badge MASQUÉ à 0
      (pas de pastille « 0 » : bruit / pas d'alerte). */
  count?: () => number;
  /** Teinte d'ALERTE de la pastille (null = neutre) : "warn" (attention) ou "err" (critique). Évaluée à chaque
      `refreshCounts`. Ex. interventions ouvertes CRITIQUES → err ; certificats expirés → err, expirants → warn. */
  countClass?: () => string | null;
  /** Icône SVG (constante du registre `ui/Icons`) de l'onglet. Sur la barre DESKTOP elle REMPLACE le texte
      (onglet icône seule → `title` + `aria-label` = `label`) ; dans les menus déroulants (responsive, groupes)
      elle PRÉCÈDE le libellé texte. Absente → repli sur le texte (comportement historique). */
  icon?: string;
  /** Noms de sous-vues exposées comme boutons-liens dans l'en-tête de CETTE vue. */
  links?: string[];
  /** Libellé du bouton primaire « + … » de l'en-tête (si action de création). */
  addLabel?: string;
  /** Action du bouton primaire. */
  onAdd?: () => void;
  /** Boutons secondaires (ghost) de l'en-tête, avant le bouton primaire.
      `onClick` reçoit le bouton rendu → un handler asynchrone peut le désactiver / changer son
      libellé le temps d'un appel (ex. « Synchroniser » → « Synchronisation… » sur l'onglet VMs). */
  extraActions?: Array<{ label: string; onClick: (btn: HTMLButtonElement) => void; title?: string }>;
  /** Appelé à chaque activation (rendu / rafraîchissement) avec le corps de vue. */
  onShow?: (body: HTMLElement) => void;
}

/** Services applicatifs de la topbar (fichier / global), câblés par le bootstrap. */
export interface ShellHost {
  onNew?(): void; onOpen?(): void; onSave?(): void; onSaveAs?(): void;
  onUndo?(): void; onRedo?(): void;
  onToggleTheme?(): void; onResetViewPrefs?(): void;
  /** Changement d'échelle d'interface (zoom global, taille du texte). */
  onUiScale?(value: number): void;
  /** Bascule « modales en plein écran » (préférence desktop ; toujours actif sous le breakpoint responsive). */
  onModalFullscreen?(on: boolean): void;
  /** Changement du nombre max de suggestions d'autocomplétion des formulaires. */
  onAutocompleteMax?(value: number): void;
  /** Nettoyage des images de façade NON UTILISÉES (purge bibliothèque ; mode API : + compactage serveur). */
  onPurgeImages?(): void;
  onRenameDoc?(name: string): void;
  /** Bascule de la source de données ("local" | "api") — applique au rechargement. */
  onDataSource?(value: string): void;
  /** Changement de l'URL de base de l'API (mode API) — applique au rechargement. */
  onApiBaseUrl?(value: string): void;
  /** Changement de l'URL de connexion SSO (bouton « Connexion » du welcome). */
  onLoginUrl?(value: string): void;
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
  /** Export du document en JSON autonome (téléchargement) — tous modes. */
  onExportJson?(): void;
  /** Export en VISUALISEUR autonome (HTML lecture seule, document embarqué). */
  onExportStandalone?(): void;
}

/** Champs de la barre de statut. */
export interface ShellStatus { file?: string; release?: string; source?: string; entities?: number | string; lastSave?: string; }

import { Prefs } from "../core/Prefs";
import { Html } from "../core/Html";
import { Icons } from "../ui/Icons";
import { FieldFacet } from "../core/FieldFacet";
import { I18n, type LocalePreference } from "../i18n/I18n";
import { ShellNav } from "./ShellNav";
import type { ShellNavView, ShellNavLookup } from "./ShellNav";

const SVG = "http://www.w3.org/2000/svg";
const svgIcon = (paths: string): SVGElement => {
  const s = document.createElementNS(SVG, "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.innerHTML = paths; return s;
};

interface ViewEntry { def: ShellView; section: HTMLElement; header: HTMLElement; body: HTMLElement; tabBtn?: HTMLButtonElement; }
/** Onglet GROUPE (kind:"group") : PAS une vue (ni section ni hash — piège ①), juste un bouton déroulant + son menu. */
interface GroupEntry { def: ShellView; tabBtn?: HTMLButtonElement; ddEl?: HTMLElement; }

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
  private tabsDdEl: HTMLElement | null = null;        // menu déroulant des onglets (responsive)
  private tabsDdLabelEl: HTMLElement | null = null;   // libellé de l'onglet actif dans le déclencheur du menu
  private mainEl: HTMLElement;
  private docNameEl: HTMLInputElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private saveDot!: HTMLElement;
  private dataSourceSwitch!: HTMLInputElement;     // toggle slider Local ⟷ API (coché = API)
  private themeSwitch!: HTMLInputElement;          // toggle slider thème clair ⟷ sombre (coché = sombre)
  private apiUrlInput!: HTMLInputElement;          // URL de base de l'API (mode API)
  private apiUrlRow!: HTMLElement;                 // ligne URL (masquée en mode Local)
  private apiLoginInput!: HTMLInputElement;        // URL de connexion SSO (bouton « Connexion » du welcome)
  private apiLoginRow!: HTMLElement;
  private fileAccessSel!: HTMLSelectElement;
  private debugLogChk!: HTMLInputElement;
  private uiScaleSel!: HTMLSelectElement;          // échelle d'interface (taille du texte)
  private modalFsChk!: HTMLInputElement;           // bascule « modales en plein écran » (préférence desktop)
  private acMaxSel!: HTMLSelectElement;            // nb max de suggestions d'autocomplétion (formulaires)
  private newBtn!: HTMLButtonElement;             // « Nouveau » (fichier ou document serveur)
  private openBtn!: HTMLButtonElement;            // « Ouvrir » (fichier ou sélecteur de documents)
  private fileActionsEl!: HTMLElement;            // Enregistrer/Enregistrer-sous (masqués en mode API)
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
  private welcomeLoginBtn!: HTMLButtonElement;     // bouton « Connexion » (SSO) — visible si non connecté + URL configurée
  private welcomeNormalEls: HTMLElement[] = [];   // contenu « fichier » du welcome (masqué en accès refusé)
  private statusEls: Record<string, HTMLElement> = {};
  private statusbarEl!: HTMLElement;              // barre de statut (masquée en mode API — inutile)
  private views = new Map<string, ViewEntry>();
  private groups = new Map<string, GroupEntry>();     // onglets déroulants (kind:"group") — hors this.views (pas de vue)
  private order: string[] = [];                        // ordre d'enregistrement (vues ET groupes) → ordre des onglets
  private tabDropdowns: HTMLElement[] = [];            // TOUS les menus déroulants d'onglets (responsive + groupes)
  private tabGroupEls: HTMLElement[] = [];             // wrappers .tab-group insérés en topbar (retirés/reconstruits par build)
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
    const name = document.createElement("span"); name.className = "brand-name"; name.textContent = "DC Manager";
    const docName = document.createElement("input"); docName.type = "text"; docName.className = "doc-name"; docName.placeholder = I18n.t("shell.doc.placeholder"); docName.maxLength = 64;
    docName.addEventListener("change", () => this.host.onRenameDoc?.(docName.value.trim()));
    brand.append(logo, name, docName);

    const tabs = document.createElement("nav"); tabs.className = "tabs"; tabs.id = "tabs";

    const actions = document.createElement("div"); actions.className = "topbar-actions";
    const iconBtn = (title: string, paths: string, onClick?: () => void): HTMLButtonElement => {
      const b = document.createElement("button"); b.type = "button"; b.className = "icon-btn"; b.title = title;
      b.appendChild(svgIcon(paths)); if (onClick) b.onclick = onClick; return b;
    };
    // Nouveau / Ouvrir : utiles dans LES DEUX modes (fichier → fichier ; API → document serveur). Toujours visibles.
    this.newBtn = iconBtn(I18n.t("shell.topbar.new"), '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>', () => this.host.onNew?.());
    this.openBtn = iconBtn(I18n.t("shell.topbar.open"), '<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', () => this.host.onOpen?.());
    actions.append(this.newBtn, this.openBtn);
    // Enregistrer / Enregistrer-sous : propres au mode FICHIER (masqués en API : sauvegarde continue côté serveur).
    this.fileActionsEl = document.createElement("span"); this.fileActionsEl.style.display = "contents";
    this.saveBtn = iconBtn(I18n.t("shell.topbar.save"), '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>', () => this.host.onSave?.());
    this.fileActionsEl.appendChild(this.saveBtn);
    this.fileActionsEl.appendChild(iconBtn(I18n.t("shell.topbar.saveAs"), '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><circle cx="18" cy="18" r="3" stroke-dasharray="2 2"/>', () => this.host.onSaveAs?.()));
    actions.appendChild(this.fileActionsEl);
    this.undoBtn = iconBtn(I18n.t("shell.topbar.undo"), '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-5"/>', () => this.host.onUndo?.()); this.undoBtn.disabled = true;
    this.redoBtn = iconBtn(I18n.t("shell.topbar.redo"), '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h5"/>', () => this.host.onRedo?.()); this.redoBtn.disabled = true;
    actions.append(this.undoBtn, this.redoBtn);
    // pastille utilisateur (mode API) : « connecté en tant que … » — masquée par défaut
    this.userChip = document.createElement("span"); this.userChip.className = "user-chip"; this.userChip.style.display = "none";
    actions.appendChild(this.userChip);
    actions.appendChild(this.buildSettingsMenu());

    topbar.append(brand, tabs, actions);

    // ---- STATUSBAR ----
    const statusbar = document.createElement("div"); statusbar.className = "statusbar";
    this.statusbarEl = statusbar;
    const stat = (html: string) => { const d = document.createElement("div"); d.className = "status-stat"; d.innerHTML = html; statusbar.appendChild(d); return d; };
    this.saveDot = document.createElement("span"); this.saveDot.className = "save-state-icon mem";
    const sd = document.createElement("div"); sd.className = "status-stat"; sd.appendChild(this.saveDot); statusbar.appendChild(sd);
    this.statusEls.file = stat(I18n.t("shell.status.fileLabel") + ' <strong>' + I18n.t("shell.status.inMemory") + '</strong>').querySelector("strong")!;
    this.statusEls.release = stat(I18n.t("shell.status.releaseLabel") + ' <strong>—</strong>').querySelector("strong")!;
    this.statusEls.source = stat(I18n.t("shell.status.sourceLabel") + ' <strong>' + I18n.t("shell.status.browser") + '</strong>').querySelector("strong")!;
    this.statusEls.entities = stat(I18n.t("shell.status.entitiesLabel") + ' <strong>0</strong>').querySelector("strong")!;
    this.statusEls.lastSave = stat(I18n.t("shell.status.lastSaveLabel") + ' <strong>—</strong>').querySelector("strong")!;

    const main = document.createElement("main");   // styles pilotés par dc-manager.css (padding, max-width, :has full-bleed)

    root.append(topbar, statusbar, main, this.buildWelcome());
    this.tabsEl = tabs; this.mainEl = main; this.docNameEl = docName;
    // fermeture des menus déroulants d'onglets au clic à l'extérieur (piège ③) : UN SEUL écouteur GÉNÉRALISÉ à
    // TOUS les menus (responsive + groupes) — ferme chaque menu dont la cible du clic n'est pas un descendant.
    document.addEventListener("click", (e) => { const t = e.target as Node; this.tabDropdowns.forEach((dd) => { if (!dd.contains(t)) dd.classList.remove("open"); }); });
    // navigation par l'URL (#nom) : back/forward du navigateur ou hash édité → bascule d'onglet (si ≠ courant).
    // `resolveHash` EXCLUT les groupes (piège ①) et accepte les sous-vues (piège ⑤ : #contacts ouvre la sous-page).
    window.addEventListener("hashchange", () => { const v = ShellNav.resolveHash(location.hash, this.navLookup()); if (v && v !== this.current) this.switchView(v); });
  }

  /** Fabrique un toggle SLIDER `.mode-switch` (case cachée + piste) — contrôle PARTAGÉ par la source de
      données, le thème et les modales plein écran (principe n°3 : un seul idiome pour toutes les bascules
      slider). L'anneau focus-visible et les transitions sont portés par le CSS `.mode-switch`. Le câblage
      `onchange` et l'étiquetage (côtés/icônes, aria-label) restent à la charge de l'appelant. */
  private buildModeSwitch(): { label: HTMLLabelElement; input: HTMLInputElement } {
    const label = document.createElement("label"); label.className = "mode-switch";
    const input = document.createElement("input"); input.type = "checkbox";
    const track = document.createElement("span"); track.className = "mode-switch-track"; track.setAttribute("aria-hidden", "true");
    label.append(input, track);
    return { label, input };
  }

  /** Petite pastille d'ICÔNE flanquant un toggle slider (légende décorative, cf. soleil/lune du thème). */
  private static modeSwitchIcon(svg: string): HTMLElement {
    const s = document.createElement("span"); s.className = "mode-switch-icon"; s.setAttribute("aria-hidden", "true"); s.innerHTML = svg; return s;
  }

  private buildSettingsMenu(): HTMLElement {
    const wrap = document.createElement("div"); wrap.className = "settings-menu";
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "icon-btn"; btn.title = I18n.t("shell.settings.title"); btn.setAttribute("aria-haspopup", "menu");
    btn.appendChild(svgIcon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'));
    const pop = document.createElement("div"); pop.className = "settings-popover"; pop.setAttribute("role", "menu");
    const section = (title: string) => { const s = document.createElement("div"); s.className = "settings-section"; const t = document.createElement("div"); t.className = "settings-section-title"; t.textContent = title; s.appendChild(t); pop.appendChild(s); return s; };

    // -- Source de données : toggle SLIDER Local ⟷ API (+ URL d'API en mode API) --
    const src = section(I18n.t("shell.settings.dataSource"));
    const srcRow = document.createElement("div"); srcRow.className = "mode-switch-row";
    const lblLocal = document.createElement("span"); lblLocal.className = "mode-switch-side"; lblLocal.textContent = I18n.t("shell.settings.local");
    const dsSwitch = this.buildModeSwitch(); this.dataSourceSwitch = dsSwitch.input;
    this.dataSourceSwitch.onchange = () => { this.updateApiUrlVisibility(); this.host.onDataSource?.(this.dataSourceSwitch.checked ? "api" : "local"); };
    const lblApi = document.createElement("span"); lblApi.className = "mode-switch-side"; lblApi.textContent = I18n.t("shell.settings.api");
    srcRow.append(lblLocal, dsSwitch.label, lblApi); src.appendChild(srcRow);
    // ligne URL d'API (visible en mode API uniquement)
    this.apiUrlRow = document.createElement("div"); this.apiUrlRow.className = "settings-row"; this.apiUrlRow.style.marginTop = "10px";
    const urlLbl = document.createElement("label"); urlLbl.className = "settings-row-label"; urlLbl.textContent = I18n.t("shell.settings.apiUrl");
    this.apiUrlInput = document.createElement("input"); this.apiUrlInput.type = "text"; this.apiUrlInput.className = "settings-row-select"; this.apiUrlInput.placeholder = "api"; this.apiUrlInput.spellcheck = false;
    this.apiUrlInput.onchange = () => this.host.onApiBaseUrl?.(this.apiUrlInput.value);
    this.apiUrlRow.append(urlLbl, this.apiUrlInput); src.appendChild(this.apiUrlRow);
    // ligne URL de CONNEXION (SSO) — utilisée pour le bouton « Connexion » de l'écran d'accueil (non connecté)
    this.apiLoginRow = document.createElement("div"); this.apiLoginRow.className = "settings-row"; this.apiLoginRow.style.marginTop = "10px";
    const loginLbl = document.createElement("label"); loginLbl.className = "settings-row-label"; loginLbl.textContent = I18n.t("shell.settings.loginUrl");
    this.apiLoginInput = document.createElement("input"); this.apiLoginInput.type = "text"; this.apiLoginInput.className = "settings-row-select"; this.apiLoginInput.placeholder = I18n.t("shell.settings.loginUrlPlaceholder"); this.apiLoginInput.spellcheck = false;
    this.apiLoginInput.onchange = () => this.host.onLoginUrl?.(this.apiLoginInput.value);
    this.apiLoginRow.append(loginLbl, this.apiLoginInput); src.appendChild(this.apiLoginRow);
    const loginNote = document.createElement("div"); loginNote.className = "settings-row-note"; loginNote.textContent = I18n.t("shell.settings.loginNote"); src.appendChild(loginNote);
    const srcNote = document.createElement("div"); srcNote.className = "settings-row-note"; srcNote.textContent = I18n.t("shell.settings.sourceNote"); src.appendChild(srcNote);

    // -- Accès aux fichiers (par fichier / par dossier) --
    const fa = section(I18n.t("shell.settings.fileAccess"));
    const faRow = document.createElement("div"); faRow.className = "settings-row";
    const faLbl = document.createElement("label"); faLbl.className = "settings-row-label"; faLbl.textContent = I18n.t("shell.settings.mode");
    this.fileAccessSel = document.createElement("select"); this.fileAccessSel.className = "settings-row-select";
    const oFile = document.createElement("option"); oFile.value = "file"; oFile.textContent = I18n.t("shell.settings.file");
    const oDir = document.createElement("option"); oDir.value = "directory"; oDir.textContent = I18n.t("shell.settings.directory");
    this.fileAccessSel.append(oFile, oDir);
    this.fileAccessSel.onchange = () => this.host.onFileAccessMode?.(this.fileAccessSel.value);
    faRow.append(faLbl, this.fileAccessSel); fa.appendChild(faRow);
    const faNote = document.createElement("div"); faNote.className = "settings-row-note"; faNote.textContent = I18n.t("shell.settings.fileAccessNote"); fa.appendChild(faNote);

    // -- Auto-save (toggle + fréquence + état) --
    const as = section(I18n.t("shell.settings.autosave"));
    const asRow = document.createElement("div"); asRow.className = "settings-toggle-row";
    const asLabel = document.createElement("label"); asLabel.className = "settings-toggle";
    this.autosaveChk = document.createElement("input"); this.autosaveChk.type = "checkbox";
    this.autosaveChk.onchange = () => this.host.onAutosaveToggle?.(this.autosaveChk.checked);
    asLabel.append(this.autosaveChk, document.createTextNode(I18n.t("shell.settings.autosaveEnable")));
    asRow.appendChild(asLabel); as.appendChild(asRow);
    const freqRow = document.createElement("div"); freqRow.className = "settings-row"; freqRow.style.marginTop = "10px";
    const freqLbl = document.createElement("label"); freqLbl.className = "settings-row-label"; freqLbl.textContent = I18n.t("shell.settings.frequency");
    this.autosaveIntervalSel = document.createElement("select"); this.autosaveIntervalSel.className = "settings-row-select";
    Prefs.INTERVAL_OPTIONS.forEach((n) => { const o = document.createElement("option"); o.value = String(n); o.textContent = n + " s"; this.autosaveIntervalSel.appendChild(o); });
    this.autosaveIntervalSel.onchange = () => this.host.onAutosaveInterval?.(parseInt(this.autosaveIntervalSel.value, 10));
    freqRow.append(freqLbl, this.autosaveIntervalSel); as.appendChild(freqRow);
    this.autosaveStatusEl = document.createElement("div"); this.autosaveStatusEl.className = "settings-status-line"; as.appendChild(this.autosaveStatusEl);
    this.fileOnlySections.push(fa, as);   // sections propres au mode fichier → masquées en mode API

    // -- Apparence -- (seule section « cosmétique » conservée en mode visualiseur ; cf. body.viewer-mode)
    const app = section(I18n.t("shell.settings.appearance")); app.classList.add("settings-cosmetic");
    // -- Thème clair / sombre : toggle SLIDER (même contrôle que la source de données) flanqué du SOLEIL (thème
    //    clair, à gauche = décoché) et de la LUNE (thème sombre, à droite = coché) — sens du mode-switch (le pouce
    //    glisse à droite quand coché). Comportement inchangé : l'appui BASCULE (host.onToggleTheme, persistance via
    //    Prefs) ; la position est reflétée par setTheme (boot + après bascule). aria-label/title localisés ; l'anneau
    //    focus-visible du mode-switch s'applique. --
    const themeRow = document.createElement("div"); themeRow.className = "mode-switch-row mode-switch-row--spread";
    const themeSwitch = this.buildModeSwitch(); this.themeSwitch = themeSwitch.input;
    this.themeSwitch.setAttribute("aria-label", I18n.t("shell.settings.toggleTheme")); this.themeSwitch.title = I18n.t("shell.settings.toggleTheme");
    this.themeSwitch.onchange = () => this.host.onToggleTheme?.();
    themeRow.append(Shell.modeSwitchIcon(Icons.SUN), themeSwitch.label, Shell.modeSwitchIcon(Icons.MOON)); app.appendChild(themeRow);
    // -- Modales en plein écran (préférence DESKTOP) : MÊME toggle mode-switch, JUSTE SOUS le thème. Le libellé nomme
    //    la préférence (gauche) ; l'icône « plein écran » marque l'état ACTIF (droite = coché = plein écran), un seul
    //    côté iconé suffit ici (bascule binaire, contrairement au thème à deux états nommés). Remplace l'ANCIENNE case
    //    à cocher (pas de doublon de contrôle pour la même préférence). Toujours actif sous le breakpoint responsive
    //    (CSS seul) ; ici on ne pilote QUE l'effet desktop (attribut data-modal-fs). --
    const mfsRow = document.createElement("div"); mfsRow.className = "mode-switch-row mode-switch-row--spread"; mfsRow.style.marginTop = "12px";
    const mfsLabel = document.createElement("span"); mfsLabel.className = "mode-switch-label"; mfsLabel.textContent = I18n.t("shell.settings.modalFs");
    const mfsSwitch = this.buildModeSwitch(); this.modalFsChk = mfsSwitch.input;
    this.modalFsChk.setAttribute("aria-label", I18n.t("shell.settings.modalFs")); this.modalFsChk.title = I18n.t("shell.settings.modalFs");
    this.modalFsChk.onchange = () => this.host.onModalFullscreen?.(this.modalFsChk.checked);
    mfsRow.append(mfsLabel, mfsSwitch.label, Shell.modeSwitchIcon(Icons.FULLSCREEN)); app.appendChild(mfsRow);
    const mfsNote = document.createElement("div"); mfsNote.className = "settings-row-note"; mfsNote.textContent = I18n.t("shell.settings.modalFsNote"); app.appendChild(mfsNote);
    // -- Taille du texte (échelle d'interface) : compense les mobiles qui grossissent les polices --
    const fsRow = document.createElement("div"); fsRow.className = "settings-row"; fsRow.style.marginTop = "10px";
    const fsLbl = document.createElement("label"); fsLbl.className = "settings-row-label"; fsLbl.textContent = I18n.t("shell.settings.textSize");
    this.uiScaleSel = document.createElement("select"); this.uiScaleSel.className = "settings-row-select";
    Prefs.UI_SCALE_OPTIONS.forEach((o) => { const op = document.createElement("option"); op.value = String(o.value); op.textContent = I18n.t(o.labelKey); this.uiScaleSel.appendChild(op); });
    this.uiScaleSel.onchange = () => this.host.onUiScale?.(parseFloat(this.uiScaleSel.value));
    fsRow.append(fsLbl, this.uiScaleSel); app.appendChild(fsRow);
    // -- Suggestions d'autocomplétion (formulaires) : nb max de valeurs proposées (Marque/Modèle/Nom/Personne…) --
    const acRow = document.createElement("div"); acRow.className = "settings-row"; acRow.style.marginTop = "10px";
    const acLbl = document.createElement("label"); acLbl.className = "settings-row-label"; acLbl.textContent = I18n.t("shell.settings.suggestionsMax");
    acLbl.title = I18n.t("shell.settings.suggestionsMaxTitle", { max: FieldFacet.MAX_RESULTS_ABS });
    this.acMaxSel = document.createElement("select"); this.acMaxSel.className = "settings-row-select";
    FieldFacet.MAX_RESULTS_OPTIONS.forEach((n) => { const op = document.createElement("option"); op.value = String(n); op.textContent = String(n); this.acMaxSel.appendChild(op); });
    this.acMaxSel.onchange = () => this.host.onAutocompleteMax?.(parseInt(this.acMaxSel.value, 10));
    acRow.append(acLbl, this.acMaxSel); app.appendChild(acRow);
    // -- Langue / Language : préférence de LOCALISATION (auto = langue du navigateur ; repli français). Le TITRE de
    //    section reste BILINGUE (seul repli pour retrouver le sélecteur quelle que soit la langue active) ; le reste
    //    du panneau est localisé. Une bascule PERSISTE la préférence puis RECHARGE l'app (cf. I18n.setPreference / docs/i18n.md). --
    const lang = section(I18n.t("shell.settings.language"));
    const langSel = document.createElement("select"); langSel.className = "settings-row-select"; langSel.style.width = "100%";
    // valeur → libellé affiché ; « auto » suit navigator.language (cf. I18n.resolve). Les endonymes « Français » /
    // « English » restent identiques dans les deux langues (nom de langue dans sa propre langue).
    ([["auto", I18n.t("shell.settings.langAuto")], ["fr", I18n.t("shell.settings.langFr")], ["en", I18n.t("shell.settings.langEn")]] as Array<[LocalePreference, string]>).forEach(([value, label]) => {
      const op = document.createElement("option"); op.value = value; op.textContent = label; langSel.appendChild(op);
    });
    langSel.value = I18n.preference;   // reflète la préférence PERSISTÉE (pas la locale effective) : « auto » reste « auto »
    langSel.onchange = () => I18n.setPreference(langSel.value as LocalePreference);
    lang.appendChild(langSel);
    const langNote = document.createElement("div"); langNote.className = "settings-row-note"; langNote.textContent = I18n.t("shell.settings.languageNote"); lang.appendChild(langNote);
    // -- Affichage 3D --
    const v3d = section(I18n.t("shell.settings.view3d"));
    const resetBtn = document.createElement("button"); resetBtn.type = "button"; resetBtn.className = "btn btn-ghost btn-sm"; resetBtn.style.width = "100%"; resetBtn.textContent = I18n.t("shell.settings.resetViewPrefs");
    resetBtn.onclick = () => this.host.onResetViewPrefs?.(); v3d.appendChild(resetBtn);
    // -- Export (tous modes, y compris API) : JSON autonome + visualiseur HTML hors-ligne --
    const exp = section(I18n.t("shell.settings.export"));
    const expJsonBtn = document.createElement("button"); expJsonBtn.type = "button"; expJsonBtn.className = "btn btn-ghost btn-sm"; expJsonBtn.style.width = "100%"; expJsonBtn.textContent = I18n.t("shell.settings.exportJson");
    expJsonBtn.onclick = () => this.host.onExportJson?.();
    const expHtmlBtn = document.createElement("button"); expHtmlBtn.type = "button"; expHtmlBtn.className = "btn btn-ghost btn-sm"; expHtmlBtn.style.cssText = "width:100%;margin-top:8px"; expHtmlBtn.textContent = I18n.t("shell.settings.exportStandalone");
    expHtmlBtn.onclick = () => this.host.onExportStandalone?.();
    exp.append(expJsonBtn, expHtmlBtn);
    const expNote = document.createElement("div"); expNote.className = "settings-row-note"; expNote.textContent = I18n.t("shell.settings.exportNote"); exp.appendChild(expNote);
    // -- Maintenance (tous modes) : purge des images de façade non utilisées (+ compactage serveur en mode API) --
    const mnt = section(I18n.t("shell.settings.maintenance"));
    const purgeBtn = document.createElement("button"); purgeBtn.type = "button"; purgeBtn.className = "btn btn-ghost btn-sm"; purgeBtn.style.width = "100%"; purgeBtn.textContent = I18n.t("shell.settings.cleanImages");
    purgeBtn.onclick = () => this.host.onPurgeImages?.(); mnt.appendChild(purgeBtn);
    const mntNote = document.createElement("div"); mntNote.className = "settings-row-note"; mntNote.textContent = I18n.t("shell.settings.maintenanceNote"); mnt.appendChild(mntNote);
    // -- Débogage --
    const dbg = section(I18n.t("shell.settings.debug"));
    const dbgRow = document.createElement("div"); dbgRow.className = "settings-toggle-row";
    const dbgLabel = document.createElement("label"); dbgLabel.className = "settings-toggle";
    this.debugLogChk = document.createElement("input"); this.debugLogChk.type = "checkbox";
    this.debugLogChk.onchange = () => this.host.onDebugLog?.(this.debugLogChk.checked);
    dbgLabel.append(this.debugLogChk, document.createTextNode(I18n.t("shell.settings.debugLogs")));
    dbgRow.appendChild(dbgLabel); dbg.appendChild(dbgRow);
    const dbgNote = document.createElement("div"); dbgNote.className = "settings-row-note"; dbgNote.textContent = I18n.t("shell.settings.debugNote"); dbg.appendChild(dbgNote);

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
    const title = document.createElement("h1"); title.className = "welcome-title"; title.textContent = "DC Manager";
    // rappel du mode d'accès actuel (fichier / dossier) — rempli par setWelcomeMode()
    this.welcomeModeEl = document.createElement("p"); this.welcomeModeEl.className = "welcome-mode-badge";
    const acts = document.createElement("div"); acts.className = "welcome-actions";
    this.welcomeReopenBtn = document.createElement("button"); this.welcomeReopenBtn.type = "button"; this.welcomeReopenBtn.className = "btn btn-primary welcome-btn"; this.welcomeReopenBtn.style.display = "none";
    this.welcomeReopenBtn.onclick = () => this.host.onReopenLast?.();
    // deux ouvertures explicites : « Fichier » (1 autorisation par fichier) · « Dossier » (1 autorisation pour tout).
    this.welcomeOpenFileBtn = document.createElement("button"); this.welcomeOpenFileBtn.type = "button"; this.welcomeOpenFileBtn.className = "btn btn-primary welcome-btn"; this.welcomeOpenFileBtn.textContent = I18n.t("shell.welcome.openFile"); this.welcomeOpenFileBtn.onclick = () => this.host.onOpenMode?.("file");
    this.welcomeOpenDirBtn = document.createElement("button"); this.welcomeOpenDirBtn.type = "button"; this.welcomeOpenDirBtn.className = "btn welcome-btn"; this.welcomeOpenDirBtn.textContent = I18n.t("shell.welcome.openDir"); this.welcomeOpenDirBtn.onclick = () => this.host.onOpenMode?.("directory");
    const newBtn = document.createElement("button"); newBtn.type = "button"; newBtn.className = "btn welcome-btn"; newBtn.textContent = I18n.t("shell.welcome.newDoc"); newBtn.onclick = () => this.host.onNew?.();
    acts.append(this.welcomeReopenBtn, this.welcomeOpenFileBtn, this.welcomeOpenDirBtn, newBtn);
    const hint = document.createElement("p"); hint.className = "welcome-mode-hint"; hint.textContent = I18n.t("shell.welcome.modeHint");
    // bloc « auth » (mode API) : message d'accès refusé / non connecté + bouton Réessayer — masqué par défaut
    this.welcomeAuthEl = document.createElement("div"); this.welcomeAuthEl.className = "welcome-auth"; this.welcomeAuthEl.style.display = "none";
    this.welcomeAuthMsg = document.createElement("p"); this.welcomeAuthMsg.className = "welcome-auth-msg";
    // bouton « Connexion » (SSO) — primaire, affiché si non connecté + URL configurée (cf. showAccessDenied)
    this.welcomeLoginBtn = document.createElement("button"); this.welcomeLoginBtn.type = "button"; this.welcomeLoginBtn.className = "btn btn-primary welcome-btn"; this.welcomeLoginBtn.textContent = I18n.t("shell.welcome.login"); this.welcomeLoginBtn.style.display = "none";
    this.welcomeAuthBtn = document.createElement("button"); this.welcomeAuthBtn.type = "button"; this.welcomeAuthBtn.className = "btn welcome-btn"; this.welcomeAuthBtn.textContent = I18n.t("shell.welcome.retry");
    this.welcomeAuthEl.append(this.welcomeAuthMsg, this.welcomeLoginBtn, this.welcomeAuthBtn);
    this.welcomeNormalEls = [this.welcomeModeEl, acts, hint];   // contenu « fichier » à masquer en cas d'accès refusé
    card.append(logo, title, this.welcomeModeEl, acts, hint, this.welcomeAuthEl);
    screen.appendChild(card);
    this.welcomeEl = screen;
    return screen;
  }

  /** Affiche l'écran d'accueil en état « accès refusé / non connecté » (mode API). Bouton « Connexion » (si NON
      connecté ET une `loginUrl` est configurée) + bouton « Réessayer ». Dans `loginUrl`, la macro `${clbkUrl}`
      est remplacée par l'URL COURANTE encodée (retour après authentification SSO). */
  showAccessDenied(opts: { connected: boolean; user?: string; onRetry: () => void; loginUrl?: string }): void {
    this.welcomeNormalEls.forEach((el) => { if (el) el.style.display = "none"; });
    this.welcomeAuthEl.style.display = "";
    this.welcomeAuthMsg.textContent = opts.connected
      ? I18n.t("shell.welcome.accessDeniedConnected", { user: opts.user || "?" })
      : I18n.t("shell.welcome.accessDeniedAnon");
    const loginUrl = (opts.loginUrl || "").trim();
    const showLogin = !opts.connected && !!loginUrl;
    this.welcomeLoginBtn.style.display = showLogin ? "" : "none";
    this.welcomeAuthBtn.classList.toggle("btn-primary", !showLogin);   // « Réessayer » devient primaire s'il n'y a pas de Connexion
    if (showLogin) this.welcomeLoginBtn.onclick = () => { window.location.href = loginUrl.split("${clbkUrl}").join(encodeURIComponent(window.location.href)); };
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
    this.welcomeModeEl.innerHTML = I18n.t("shell.welcome.modeBadge", {
      mode: I18n.t(dir ? "shell.settings.directory" : "shell.settings.file"),
      detail: I18n.t(dir ? "shell.welcome.modeDirDetail" : "shell.welcome.modeFileDetail"),
    });
    // bouton « dossier » masqué si le navigateur n'a pas la File System Access API
    this.welcomeOpenDirBtn.style.display = fsApi ? "" : "none";
    // met en avant (primaire) l'ouverture du MODE COURANT ; l'autre reste une option secondaire
    this.welcomeOpenFileBtn.classList.toggle("btn-primary", !dir);
    this.welcomeOpenDirBtn.classList.toggle("btn-primary", dir);
  }
  hideWelcome(): void { this.welcomeEl.style.display = "none"; document.body.classList.remove("welcome-active"); }
  /** Configure le bouton « Rouvrir » (null = masqué). */
  setReopen(name: string | null): void {
    if (name) { this.welcomeReopenBtn.style.display = ""; this.welcomeReopenBtn.textContent = I18n.t("shell.welcome.reopen", { name }); }
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

  /** Enregistre un GROUPE d'onglet (kind:"group") : bouton d'onglet TOUJOURS DÉROULANT qui liste ses `children`
      (de vraies sous-vues `kind:"secondary"` déclarées à part avec `parent` = ce groupe). Le groupe N'EST PAS une
      vue : ni <section>, ni corps, ni hash (piège ①) — cliquer son bouton déroule le menu, seuls ses enfants
      naviguent. À appeler comme `addView` (avant `build`) ; l'ordre d'enregistrement fixe la position de l'onglet. */
  addGroup(def: ShellView): void {
    this.groups.set(def.name, { def });
    this.order.push(def.name);
  }

  /** Déclarations de navigation (vues + groupes) dans l'ordre des onglets — alimente les helpers PURS `ShellNav`. */
  private orderedDecls(): ShellNavView[] {
    return this.order.map((nm) => {
      const g = this.groups.get(nm);
      if (g) return { name: nm, label: g.def.label, kind: "group", parent: g.def.parent, children: g.def.children };
      const v = this.views.get(nm)!;
      return { name: nm, label: v.def.label, kind: v.def.kind, parent: v.def.parent };
    });
  }

  /** Carte `nom → { parent, kind }` (vues + groupes) pour remonter aux ancêtres / résoudre un hash (cf. ShellNav). */
  private navLookup(): ShellNavLookup {
    const m: ShellNavLookup = {};
    this.views.forEach((v, n) => { m[n] = { parent: v.def.parent, kind: v.def.kind }; });
    this.groups.forEach((g, n) => { m[n] = { parent: g.def.parent, kind: "group" }; });
    return m;
  }

  /** Construit la topbar (onglets principaux) et toutes les en-têtes de vue. À appeler après tous les addView. */
  build(): void {
    this.tabsEl.innerHTML = "";
    this.countBadges = [];
    this.tabDropdowns = [];                              // réinitialisé : le listener de clic extérieur lit ce tableau
    this.tabGroupEls.forEach((el) => el.remove()); this.tabGroupEls = [];   // purge d'un éventuel build précédent
    // onglets principaux (vues non secondaires, hors GROUPES), dans l'ordre d'enregistrement
    this.order.forEach((nm) => {
      if (this.groups.has(nm)) return;                  // les groupes sont rendus HORS .tabs (leur menu déborde du clip overflow)
      const v = this.views.get(nm)!; if (v.def.kind === "secondary") return;
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "tab"; btn.dataset.view = nm;
      // Barre DESKTOP : ICÔNE SEULE si la vue en déclare une (le libellé passe en title + aria-label — a11y
      // obligatoire pour un bouton sans texte) ; sinon repli sur le TEXTE (comportement historique).
      if (v.def.icon) {
        btn.classList.add("tab-icon");
        btn.innerHTML = '<span class="gi" aria-hidden="true">' + v.def.icon + "</span>";
        btn.setAttribute("aria-label", v.def.label); btn.title = v.def.label;
      } else {
        btn.appendChild(document.createTextNode(v.def.label + " "));
      }
      if (v.def.count) { const badge = document.createElement("span"); badge.className = "tab-count"; btn.appendChild(badge); this.countBadges.push({ name: nm, el: badge }); }
      btn.onclick = () => this.switchView(nm);
      v.tabBtn = btn; this.tabsEl.appendChild(btn);
    });
    this.buildTabsDropdown();   // version « menu déroulant » des mêmes onglets + enfants de groupes (affichée en responsive)
    this.buildTabGroups();      // boutons d'onglet GROUPE (déroulants) — insérés en topbar, hors du clip de .tabs
    // en-têtes de vue
    this.views.forEach((v) => this.buildHeader(v));
    this.refreshCounts();
  }

  /** Menu déroulant CUSTOM (pas un <select> natif) reprenant les onglets principaux — affiché à la place de la
      barre d'onglets en responsive (gain de place, accessible au pouce). Synchronisé par switchView/refreshCounts.
      Les GROUPES y sont APLATIS (piège ② : en-tête non cliquable + enfants indentés) — sinon leurs sous-pages
      seraient inaccessibles en mobile (la barre .tabs, qui porte les boutons de groupe, est masquée). */
  private buildTabsDropdown(): void {
    if (this.tabsDdEl) { this.tabsDdEl.remove(); this.tabsDdEl = null; this.tabsDdLabelEl = null; }
    const dd = document.createElement("div"); dd.className = "tabs-dd";
    const trigger = document.createElement("button"); trigger.type = "button"; trigger.className = "tabs-dd-trigger"; trigger.setAttribute("aria-haspopup", "menu");
    const lbl = document.createElement("span"); lbl.className = "tabs-dd-label"; lbl.textContent = I18n.t("shell.tabs.menu");
    const caret = document.createElement("span"); caret.className = "tabs-dd-caret"; caret.textContent = "▾";
    trigger.append(lbl, caret);
    const menu = document.createElement("div"); menu.className = "tabs-dd-menu"; menu.setAttribute("role", "menu");
    ShellNav.responsiveMenu(this.orderedDecls()).forEach((e) => {
      if (e.role === "group") {   // en-tête de groupe : repère non navigable (le groupe n'est pas une vue)
        const head = document.createElement("div"); head.className = "tabs-dd-group"; head.textContent = e.label; menu.appendChild(head); return;
      }
      const it = document.createElement("button"); it.type = "button"; it.className = "tabs-dd-item" + (e.depth ? " tabs-dd-item--child" : ""); it.dataset.view = e.name; it.setAttribute("role", "menuitem");
      const src = this.views.get(e.name);   // source de l'icône ET du badge de comptage (recollé par nom)
      if (src && src.def.icon) { const gi = document.createElement("span"); gi.className = "gi"; gi.setAttribute("aria-hidden", "true"); gi.innerHTML = src.def.icon; it.appendChild(gi); }   // menu : icône + libellé
      it.appendChild(document.createTextNode(e.label + " "));
      if (src && src.def.count) { const badge = document.createElement("span"); badge.className = "tab-count"; it.appendChild(badge); this.countBadges.push({ name: e.name, el: badge }); }
      it.onclick = () => { dd.classList.remove("open"); this.switchView(e.name); };
      menu.appendChild(it);
    });
    trigger.onclick = (e) => { e.stopPropagation(); this.closeOtherDropdowns(dd); dd.classList.toggle("open"); };
    dd.append(trigger, menu);
    this.tabsEl.insertAdjacentElement("afterend", dd);
    this.tabsDdEl = dd; this.tabsDdLabelEl = lbl;
    this.tabDropdowns.push(dd);
  }

  /** Boutons d'onglet des GROUPES (kind:"group") : un bouton `.tab` + un caret + un menu déroulant listant les
      sous-vues enfants. Insérés en TOPBAR après le menu responsive (donc HORS de `.tabs` : son `overflow` rognerait
      le menu qui déborde vers le bas). Le bouton NE NAVIGUE PAS (piège ①) — il déroule ; seuls les enfants naviguent. */
  private buildTabGroups(): void {
    let anchor: Element = this.tabsDdEl || this.tabsEl;
    this.order.forEach((nm) => {
      const g = this.groups.get(nm); if (!g) return;
      const wrap = document.createElement("div"); wrap.className = "tab-group";
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "tab"; btn.dataset.group = nm; btn.setAttribute("aria-haspopup", "menu");
      // Onglet GROUPE sur la barre desktop : ICÔNE SEULE (+ caret) si déclarée ; libellé porté par title + aria-label.
      if (g.def.icon) {
        btn.classList.add("tab-icon");
        btn.innerHTML = '<span class="gi" aria-hidden="true">' + g.def.icon + "</span>";
        btn.setAttribute("aria-label", g.def.label); btn.title = g.def.label;
      } else {
        btn.appendChild(document.createTextNode(g.def.label + " "));
      }
      const caret = document.createElement("span"); caret.className = "tabs-dd-caret"; caret.textContent = "▾"; btn.appendChild(caret);
      const menu = document.createElement("div"); menu.className = "tabs-dd-menu"; menu.setAttribute("role", "menu");
      (g.def.children || []).forEach((childName) => {
        const cv = this.views.get(childName); if (!cv) return;   // enfant absent (mode-dépendant) → simplement omis
        const it = document.createElement("button"); it.type = "button"; it.className = "tabs-dd-item"; it.dataset.view = childName; it.setAttribute("role", "menuitem");
        if (cv.def.icon) { const gi = document.createElement("span"); gi.className = "gi"; gi.setAttribute("aria-hidden", "true"); gi.innerHTML = cv.def.icon; it.appendChild(gi); }   // menu de groupe : icône + libellé
        it.appendChild(document.createTextNode(cv.def.label + " "));
        if (cv.def.count) { const badge = document.createElement("span"); badge.className = "tab-count"; it.appendChild(badge); this.countBadges.push({ name: childName, el: badge }); }
        it.onclick = () => { wrap.classList.remove("open"); this.switchView(childName); };
        menu.appendChild(it);
      });
      // toggle : ferme les AUTRES menus puis bascule le sien ; stopPropagation évite la fermeture immédiate par le
      // listener document (piège ③ — sinon le clic du bouton refermerait aussitôt le menu qu'il vient d'ouvrir).
      btn.onclick = (e) => { e.stopPropagation(); this.closeOtherDropdowns(wrap); wrap.classList.toggle("open"); };
      wrap.append(btn, menu);
      anchor.insertAdjacentElement("afterend", wrap); anchor = wrap;
      g.tabBtn = btn; g.ddEl = wrap;
      this.tabDropdowns.push(wrap); this.tabGroupEls.push(wrap);
    });
  }

  /** Ferme tous les menus déroulants d'onglets SAUF celui passé (exclusivité mutuelle à l'ouverture). */
  private closeOtherDropdowns(keep: HTMLElement): void {
    this.tabDropdowns.forEach((dd) => { if (dd !== keep) dd.classList.remove("open"); });
  }

  private buildHeader(v: ViewEntry): void {
    const def = v.def;
    v.header.innerHTML = "";
    const left = document.createElement("div");
    const title = document.createElement("div"); title.className = "view-title";
    const caret = document.createElement("span"); caret.textContent = "▸"; title.append(caret, document.createTextNode(" " + (def.title || def.label)));
    left.appendChild(title);
    // Légendes d'onglet (sous-titres) RETIRÉES de l'UI : elles surchargeaient l'en-tête. Le `subtitle` reste
    // disponible dans la définition (documentation des vues) mais n'est plus affiché sous le titre.
    const acts = document.createElement("div"); acts.className = "view-actions";
    // bouton « ← retour » (sous-vue → parent)
    if (def.parent && this.views.has(def.parent)) {
      const p = this.views.get(def.parent)!.def;
      const back = document.createElement("button"); back.type = "button"; back.className = "btn btn-ghost"; back.textContent = I18n.t("shell.header.back", { label: p.label }); back.title = I18n.t("shell.header.backTitle", { label: p.label });
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
    (def.extraActions || []).forEach((a) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost"; b.textContent = a.label; if (a.title) b.title = a.title; b.onclick = () => a.onClick(b); acts.appendChild(b); });
    // bouton primaire « + … »
    if (def.onAdd) { const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-primary"; add.textContent = def.addLabel || I18n.t("shell.header.addDefault"); add.onclick = () => def.onAdd!(); acts.appendChild(add); }
    v.header.append(left, acts);
    if (!acts.children.length) v.header.style.alignItems = "center";
  }

  switchView(name: string): void {
    if (!this.views.has(name)) return;   // seules les VUES naviguent ; un groupe (kind:"group") n'est pas dans this.views (piège ①)
    this.current = name;
    const active = this.views.get(name)!;
    const activeTab = ShellNav.activeTab(active.def);
    this.views.forEach((v, n) => {
      if (v.tabBtn) v.tabBtn.classList.toggle("active", n === activeTab);
      v.section.classList.toggle("active", n === name);
    });
    // surlignage de l'onglet GROUPE : l'état « actif » d'un groupe = l'un de ses enfants est la vue active (piège ①).
    const group = ShellNav.ancestorGroup(name, this.navLookup());
    this.groups.forEach((g, gname) => { if (g.tabBtn) g.tabBtn.classList.toggle("active", gname === group); });
    // synchronise le menu déroulant (responsive) : libellé du déclencheur + item actif. Le libellé reflète l'onglet
    // parent (une sous-vue de primaire → le primaire ; un enfant de groupe → le groupe) ; l'item actif = la vue courante.
    const av = this.views.get(activeTab) || (group ? this.groups.get(group) : undefined);
    if (this.tabsDdLabelEl && av) this.tabsDdLabelEl.textContent = av.def.label;
    if (this.tabsDdEl) this.tabsDdEl.querySelectorAll(".tabs-dd-item").forEach((it) => { const dv = (it as HTMLElement).dataset.view; it.classList.toggle("active", dv === activeTab || dv === name); });
    if (active.def.onShow) { try { active.def.onShow(active.body); } catch (e) { console.error(e); } }
    this.refreshCounts();
    // reflète l'onglet ACTIF dans l'URL (#nom) → bookmarkable. Le listener hashchange (constructeur) ne re-switche
    // que si la cible DIFFÈRE de l'onglet courant → pas de boucle ni de double rendu.
    try { if (typeof location !== "undefined" && decodeURIComponent(location.hash.replace(/^#/, "")) !== name) location.hash = "#" + name; } catch (_) { /* noop */ }
  }

  /** Une vue de ce nom est-elle enregistrée ? (pour restaurer l'onglet depuis l'URL au boot). */
  hasView(name: string): boolean { return this.views.has(name); }

  /** Re-rend la vue active (cohérence inter-vues sur mutation du modèle). */
  refreshActive(): void {
    if (!this.current) return;
    const v = this.views.get(this.current);
    if (v && v.def.onShow) { try { v.def.onShow(v.body); } catch (e) { console.error(e); } }
    this.refreshCounts();
  }

  /** Met à jour tous les badges de comptage (onglets topbar + liens d'en-tête) : valeur, teinte d'alerte
      (warn/err) et VISIBILITÉ (masqué à 0 — pas de pastille « 0 »). */
  refreshCounts(): void {
    this.countBadges.forEach(({ name, el }) => {
      const v = this.views.get(name); if (!v || !v.def.count) return;
      const n = v.def.count();
      el.textContent = String(n);
      el.style.display = n > 0 ? "" : "none";   // pastille masquée à 0 (bruit / aucune alerte)
      const cls = v.def.countClass ? v.def.countClass() : null;
      el.classList.toggle("warn", cls === "warn");
      el.classList.toggle("err", cls === "err");
    });
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
  setDataSource(value: string): void { if (this.dataSourceSwitch) this.dataSourceSwitch.checked = (value === "api"); this.updateApiUrlVisibility(); }
  /** Reflète l'URL de l'API dans le champ des réglages. */
  setApiBaseUrl(url: string): void { if (this.apiUrlInput) this.apiUrlInput.value = url || ""; }
  /** Reflète l'URL de connexion SSO dans le champ des réglages. */
  setLoginUrl(url: string): void { if (this.apiLoginInput) this.apiLoginInput.value = url || ""; }
  /** Affiche les lignes API (URL + connexion) uniquement quand le mode API est sélectionné. */
  private updateApiUrlVisibility(): void { const on = (this.dataSourceSwitch && this.dataSourceSwitch.checked) ? "" : "none"; if (this.apiUrlRow) this.apiUrlRow.style.display = on; if (this.apiLoginRow) this.apiLoginRow.style.display = on; }
  setFileAccessMode(value: string): void { this.fileAccessSel.value = value; }
  setDebugLog(on: boolean): void { this.debugLogChk.checked = on; }
  /** Reflète l'échelle d'interface dans le sélecteur des réglages (sans déclencher onUiScale). */
  setUiScale(v: number): void { if (this.uiScaleSel) this.uiScaleSel.value = String(v); }
  /** Reflète le thème courant dans la bascule des réglages (coché = sombre) — sans déclencher onToggleTheme. */
  setTheme(theme: string): void { if (this.themeSwitch) this.themeSwitch.checked = (theme === "dark"); }
  /** Reflète la préférence « modales en plein écran » dans la bascule des réglages (sans déclencher onModalFullscreen). */
  setModalFullscreen(on: boolean): void { if (this.modalFsChk) this.modalFsChk.checked = on; }
  /** Reflète le nb max de suggestions d'autocomplétion dans le sélecteur des réglages. */
  setAutocompleteMax(v: number): void { if (this.acMaxSel) this.acMaxSel.value = String(FieldFacet.clampLimit(v)); }
  /** Pastille utilisateur (mode API). `user` = objet SSO (login/nom/prénom/eMail…) ; null = non connecté ; undefined = masquer. */
  setUser(user: { name?: string; prenom?: string; nom?: string; login?: string; email?: string; eMail?: string } | null | undefined): void {
    if (!this.userChip) return;
    if (user === undefined) { this.userChip.style.display = "none"; return; }
    this.userChip.style.display = "";
    if (user) {
      const who = user.name || [user.prenom, user.nom].filter(Boolean).join(" ") || user.login || user.eMail || user.email || I18n.t("shell.user.anonymous");
      this.userChip.innerHTML = `<span class="gi">${Icons.USER}</span>` + Html.escape(who); this.userChip.title = I18n.t("shell.user.connectedAs", { who }); this.userChip.classList.remove("user-chip--off");
    } else {
      this.userChip.innerHTML = `<span class="gi">${Icons.USER}</span>` + Html.escape(I18n.t("shell.user.notConnected")); this.userChip.title = I18n.t("shell.user.noSession"); this.userChip.classList.add("user-chip--off");
    }
  }
  /** Mode API : masque Enregistrer/Enregistrer-sous + réglages fichier ; Nouveau/Ouvrir gèrent les documents serveur. */
  setRestMode(on: boolean): void {
    // Barre de statut MASQUÉE en mode API : ses champs (fichier, source, dernière sauvegarde) n'ont pas de sens
    // côté serveur (sauvegarde continue, pas de fichier local) → on libère l'espace vertical. Elle n'est plus
    // peuplée non plus (cf. refreshChrome dans main.ts, qui saute setStatus en mode API).
    if (this.statusbarEl) this.statusbarEl.style.display = on ? "none" : "";
    if (this.fileActionsEl) this.fileActionsEl.style.display = on ? "none" : "contents";
    // Annuler / Rétablir MASQUÉS en mode API : l'undo client n'est pas supporté (le serveur fait autorité,
    // écritures immédiates) → des boutons en permanence désactivés n'apportent rien. À réafficher si l'undo
    // serveur est implémenté un jour.
    if (this.undoBtn) this.undoBtn.style.display = on ? "none" : "";
    if (this.redoBtn) this.redoBtn.style.display = on ? "none" : "";
    this.fileOnlySections.forEach((s) => { if (s) s.style.display = on ? "none" : ""; });
    if (this.newBtn) this.newBtn.title = I18n.t("shell.topbar.new");
    if (this.openBtn) this.openBtn.title = on ? I18n.t("shell.topbar.docsOpen") : I18n.t("shell.topbar.open");
    if (on && this.dataSourceSwitch) this.dataSourceSwitch.checked = true;
    this.updateApiUrlVisibility();
  }
  /** Reflète l'état auto-save dans le popover (case + fréquence). */
  setAutosave(on: boolean, interval: number): void { this.autosaveChk.checked = on; this.autosaveIntervalSel.value = String(interval); }
  setAutosaveStatus(html: string): void { this.autosaveStatusEl.innerHTML = html; }
}
