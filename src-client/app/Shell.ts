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
  /** Compteur affiché en badge (onglet topbar + tout lien qui pointe vers cette vue). */
  count?: () => number;
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
  private apiUrlInput!: HTMLInputElement;          // URL de base de l'API (mode API)
  private apiUrlRow!: HTMLElement;                 // ligne URL (masquée en mode Local)
  private apiLoginInput!: HTMLInputElement;        // URL de connexion SSO (bouton « Connexion » du welcome)
  private apiLoginRow!: HTMLElement;
  private fileAccessSel!: HTMLSelectElement;
  private debugLogChk!: HTMLInputElement;
  private uiScaleSel!: HTMLSelectElement;          // échelle d'interface (taille du texte)
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
    const docName = document.createElement("input"); docName.type = "text"; docName.className = "doc-name"; docName.placeholder = "Nom du document"; docName.maxLength = 64;
    docName.addEventListener("change", () => this.host.onRenameDoc?.(docName.value.trim()));
    brand.append(logo, name, docName);

    const tabs = document.createElement("nav"); tabs.className = "tabs"; tabs.id = "tabs";

    const actions = document.createElement("div"); actions.className = "topbar-actions";
    const iconBtn = (title: string, paths: string, onClick?: () => void): HTMLButtonElement => {
      const b = document.createElement("button"); b.type = "button"; b.className = "icon-btn"; b.title = title;
      b.appendChild(svgIcon(paths)); if (onClick) b.onclick = onClick; return b;
    };
    // Nouveau / Ouvrir : utiles dans LES DEUX modes (fichier → fichier ; API → document serveur). Toujours visibles.
    this.newBtn = iconBtn("Nouveau document (Ctrl+N)", '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>', () => this.host.onNew?.());
    this.openBtn = iconBtn("Ouvrir un fichier (Ctrl+O)", '<path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', () => this.host.onOpen?.());
    actions.append(this.newBtn, this.openBtn);
    // Enregistrer / Enregistrer-sous : propres au mode FICHIER (masqués en API : sauvegarde continue côté serveur).
    this.fileActionsEl = document.createElement("span"); this.fileActionsEl.style.display = "contents";
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
    this.statusbarEl = statusbar;
    const stat = (html: string) => { const d = document.createElement("div"); d.className = "status-stat"; d.innerHTML = html; statusbar.appendChild(d); return d; };
    this.saveDot = document.createElement("span"); this.saveDot.className = "save-state-icon mem";
    const sd = document.createElement("div"); sd.className = "status-stat"; sd.appendChild(this.saveDot); statusbar.appendChild(sd);
    this.statusEls.file = stat('FICHIER <strong>— en mémoire —</strong>').querySelector("strong")!;
    this.statusEls.release = stat('RELEASE <strong>—</strong>').querySelector("strong")!;
    this.statusEls.source = stat('SOURCE <strong>navigateur</strong>').querySelector("strong")!;
    this.statusEls.entities = stat('ENTITÉS <strong>0</strong>').querySelector("strong")!;
    this.statusEls.lastSave = stat('DERNIÈRE SAUVEGARDE <strong>—</strong>').querySelector("strong")!;

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

  private buildSettingsMenu(): HTMLElement {
    const wrap = document.createElement("div"); wrap.className = "settings-menu";
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "icon-btn"; btn.title = "Réglages"; btn.setAttribute("aria-haspopup", "menu");
    btn.appendChild(svgIcon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'));
    const pop = document.createElement("div"); pop.className = "settings-popover"; pop.setAttribute("role", "menu");
    const section = (title: string) => { const s = document.createElement("div"); s.className = "settings-section"; const t = document.createElement("div"); t.className = "settings-section-title"; t.textContent = title; s.appendChild(t); pop.appendChild(s); return s; };

    // -- Source de données : toggle SLIDER Local ⟷ API (+ URL d'API en mode API) --
    const src = section("Source de données");
    const srcRow = document.createElement("div"); srcRow.className = "mode-switch-row";
    const lblLocal = document.createElement("span"); lblLocal.className = "mode-switch-side"; lblLocal.textContent = "Local";
    const sw = document.createElement("label"); sw.className = "mode-switch";
    this.dataSourceSwitch = document.createElement("input"); this.dataSourceSwitch.type = "checkbox";
    this.dataSourceSwitch.onchange = () => { this.updateApiUrlVisibility(); this.host.onDataSource?.(this.dataSourceSwitch.checked ? "api" : "local"); };
    const track = document.createElement("span"); track.className = "mode-switch-track"; track.setAttribute("aria-hidden", "true");
    sw.append(this.dataSourceSwitch, track);
    const lblApi = document.createElement("span"); lblApi.className = "mode-switch-side"; lblApi.textContent = "API";
    srcRow.append(lblLocal, sw, lblApi); src.appendChild(srcRow);
    // ligne URL d'API (visible en mode API uniquement)
    this.apiUrlRow = document.createElement("div"); this.apiUrlRow.className = "settings-row"; this.apiUrlRow.style.marginTop = "10px";
    const urlLbl = document.createElement("label"); urlLbl.className = "settings-row-label"; urlLbl.textContent = "URL de l'API";
    this.apiUrlInput = document.createElement("input"); this.apiUrlInput.type = "text"; this.apiUrlInput.className = "settings-row-select"; this.apiUrlInput.placeholder = "api"; this.apiUrlInput.spellcheck = false;
    this.apiUrlInput.onchange = () => this.host.onApiBaseUrl?.(this.apiUrlInput.value);
    this.apiUrlRow.append(urlLbl, this.apiUrlInput); src.appendChild(this.apiUrlRow);
    // ligne URL de CONNEXION (SSO) — utilisée pour le bouton « Connexion » de l'écran d'accueil (non connecté)
    this.apiLoginRow = document.createElement("div"); this.apiLoginRow.className = "settings-row"; this.apiLoginRow.style.marginTop = "10px";
    const loginLbl = document.createElement("label"); loginLbl.className = "settings-row-label"; loginLbl.textContent = "URL de connexion";
    this.apiLoginInput = document.createElement("input"); this.apiLoginInput.type = "text"; this.apiLoginInput.className = "settings-row-select"; this.apiLoginInput.placeholder = "https://sso…/login?back=${clbkUrl}"; this.apiLoginInput.spellcheck = false;
    this.apiLoginInput.onchange = () => this.host.onLoginUrl?.(this.apiLoginInput.value);
    this.apiLoginRow.append(loginLbl, this.apiLoginInput); src.appendChild(this.apiLoginRow);
    const loginNote = document.createElement("div"); loginNote.className = "settings-row-note"; loginNote.textContent = "URL de connexion SSO affichée à l'écran d'accueil quand l'utilisateur n'est pas authentifié. La macro ${clbkUrl} est remplacée par l'URL courante (encodée) pour le retour après connexion."; src.appendChild(loginNote);
    const srcNote = document.createElement("div"); srcNote.className = "settings-row-note"; srcNote.textContent = "Local : les données vivent dans le navigateur (session), liables à un fichier JSON sur disque. API : synchronisation avec un serveur REST. Changer de mode (ou d'URL) recharge l'application."; src.appendChild(srcNote);

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

    // -- Apparence -- (seule section « cosmétique » conservée en mode visualiseur ; cf. body.viewer-mode)
    const app = section("Apparence"); app.classList.add("settings-cosmetic");
    const themeBtn = document.createElement("button"); themeBtn.type = "button"; themeBtn.className = "btn btn-ghost btn-sm"; themeBtn.style.width = "100%"; themeBtn.textContent = "Basculer le thème clair / sombre";
    themeBtn.onclick = () => this.host.onToggleTheme?.(); app.appendChild(themeBtn);
    // -- Taille du texte (échelle d'interface) : compense les mobiles qui grossissent les polices --
    const fsRow = document.createElement("div"); fsRow.className = "settings-row"; fsRow.style.marginTop = "10px";
    const fsLbl = document.createElement("label"); fsLbl.className = "settings-row-label"; fsLbl.textContent = "Taille du texte";
    this.uiScaleSel = document.createElement("select"); this.uiScaleSel.className = "settings-row-select";
    Prefs.UI_SCALE_OPTIONS.forEach((o) => { const op = document.createElement("option"); op.value = String(o.value); op.textContent = o.label; this.uiScaleSel.appendChild(op); });
    this.uiScaleSel.onchange = () => this.host.onUiScale?.(parseFloat(this.uiScaleSel.value));
    fsRow.append(fsLbl, this.uiScaleSel); app.appendChild(fsRow);
    // -- Suggestions d'autocomplétion (formulaires) : nb max de valeurs proposées (Marque/Modèle/Nom/Personne…) --
    const acRow = document.createElement("div"); acRow.className = "settings-row"; acRow.style.marginTop = "10px";
    const acLbl = document.createElement("label"); acLbl.className = "settings-row-label"; acLbl.textContent = "Suggestions max";
    acLbl.title = "Nombre maximum de valeurs proposées en autocomplétion dans les formulaires (plafond absolu : " + FieldFacet.MAX_RESULTS_ABS + ").";
    this.acMaxSel = document.createElement("select"); this.acMaxSel.className = "settings-row-select";
    FieldFacet.MAX_RESULTS_OPTIONS.forEach((n) => { const op = document.createElement("option"); op.value = String(n); op.textContent = String(n); this.acMaxSel.appendChild(op); });
    this.acMaxSel.onchange = () => this.host.onAutocompleteMax?.(parseInt(this.acMaxSel.value, 10));
    acRow.append(acLbl, this.acMaxSel); app.appendChild(acRow);
    // -- Langue / Language : préférence de LOCALISATION (auto = langue du navigateur ; repli français). Libellés
    //    BILINGUES (le panneau réglages n'est pas encore localisé) pour rester compréhensibles quelle que soit la
    //    langue active. Une bascule PERSISTE la préférence puis RECHARGE l'app (cf. I18n.setPreference / docs/i18n.md). --
    const lang = section("Langue / Language");
    const langSel = document.createElement("select"); langSel.className = "settings-row-select"; langSel.style.width = "100%";
    // valeur → libellé affiché ; « auto » suit navigator.language (cf. I18n.resolve).
    ([["auto", "Auto (navigateur)"], ["fr", "Français"], ["en", "English"]] as Array<[LocalePreference, string]>).forEach(([value, label]) => {
      const op = document.createElement("option"); op.value = value; op.textContent = label; langSel.appendChild(op);
    });
    langSel.value = I18n.preference;   // reflète la préférence PERSISTÉE (pas la locale effective) : « auto » reste « auto »
    langSel.onchange = () => I18n.setPreference(langSel.value as LocalePreference);
    lang.appendChild(langSel);
    const langNote = document.createElement("div"); langNote.className = "settings-row-note"; langNote.textContent = "Auto suit la langue du navigateur (repli : français). Changer de langue recharge l'application. / Auto follows the browser language (fallback: French). Changing the language reloads the app."; lang.appendChild(langNote);
    // -- Affichage 3D --
    const v3d = section("Affichage 3D");
    const resetBtn = document.createElement("button"); resetBtn.type = "button"; resetBtn.className = "btn btn-ghost btn-sm"; resetBtn.style.width = "100%"; resetBtn.textContent = "Réinitialiser les préférences d'affichage";
    resetBtn.onclick = () => this.host.onResetViewPrefs?.(); v3d.appendChild(resetBtn);
    // -- Export (tous modes, y compris API) : JSON autonome + visualiseur HTML hors-ligne --
    const exp = section("Export");
    const expJsonBtn = document.createElement("button"); expJsonBtn.type = "button"; expJsonBtn.className = "btn btn-ghost btn-sm"; expJsonBtn.style.width = "100%"; expJsonBtn.textContent = "Exporter le document (JSON)";
    expJsonBtn.onclick = () => this.host.onExportJson?.();
    const expHtmlBtn = document.createElement("button"); expHtmlBtn.type = "button"; expHtmlBtn.className = "btn btn-ghost btn-sm"; expHtmlBtn.style.cssText = "width:100%;margin-top:8px"; expHtmlBtn.textContent = "Exporter en visualiseur autonome (HTML)";
    expHtmlBtn.onclick = () => this.host.onExportStandalone?.();
    exp.append(expJsonBtn, expHtmlBtn);
    const expNote = document.createElement("div"); expNote.className = "settings-row-note"; expNote.textContent = "JSON : document complet (images incluses), réimportable. Visualiseur autonome : un fichier .html LECTURE SEULE consultable hors-ligne (sans serveur)."; exp.appendChild(expNote);
    // -- Maintenance (tous modes) : purge des images de façade non utilisées (+ compactage serveur en mode API) --
    const mnt = section("Maintenance");
    const purgeBtn = document.createElement("button"); purgeBtn.type = "button"; purgeBtn.className = "btn btn-ghost btn-sm"; purgeBtn.style.width = "100%"; purgeBtn.textContent = "Nettoyer les images non utilisées";
    purgeBtn.onclick = () => this.host.onPurgeImages?.(); mnt.appendChild(purgeBtn);
    const mntNote = document.createElement("div"); mntNote.className = "settings-row-note"; mntNote.textContent = "Supprime de la bibliothèque les images de façade référencées par AUCUN équipement (confirmation demandée). En mode API, compacte aussi la base du document (VACUUM)."; mnt.appendChild(mntNote);
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
    const title = document.createElement("h1"); title.className = "welcome-title"; title.textContent = "DC Manager";
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
    // bouton « Connexion » (SSO) — primaire, affiché si non connecté + URL configurée (cf. showAccessDenied)
    this.welcomeLoginBtn = document.createElement("button"); this.welcomeLoginBtn.type = "button"; this.welcomeLoginBtn.className = "btn btn-primary welcome-btn"; this.welcomeLoginBtn.textContent = "Connexion"; this.welcomeLoginBtn.style.display = "none";
    this.welcomeAuthBtn = document.createElement("button"); this.welcomeAuthBtn.type = "button"; this.welcomeAuthBtn.className = "btn welcome-btn"; this.welcomeAuthBtn.textContent = "Réessayer";
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
      ? "Connecté en tant que « " + (opts.user || "?") + " », mais ce compte n'a pas les droits requis (SUPER_ADMIN). Contactez un administrateur."
      : "Vous n'êtes pas authentifié auprès du SSO. Connectez-vous, puis réessayez.";
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
      btn.appendChild(document.createTextNode(v.def.label + " "));
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
    const lbl = document.createElement("span"); lbl.className = "tabs-dd-label"; lbl.textContent = "Menu";
    const caret = document.createElement("span"); caret.className = "tabs-dd-caret"; caret.textContent = "▾";
    trigger.append(lbl, caret);
    const menu = document.createElement("div"); menu.className = "tabs-dd-menu"; menu.setAttribute("role", "menu");
    ShellNav.responsiveMenu(this.orderedDecls()).forEach((e) => {
      if (e.role === "group") {   // en-tête de groupe : repère non navigable (le groupe n'est pas une vue)
        const head = document.createElement("div"); head.className = "tabs-dd-group"; head.textContent = e.label; menu.appendChild(head); return;
      }
      const it = document.createElement("button"); it.type = "button"; it.className = "tabs-dd-item" + (e.depth ? " tabs-dd-item--child" : ""); it.dataset.view = e.name; it.setAttribute("role", "menuitem");
      it.appendChild(document.createTextNode(e.label + " "));
      const src = this.views.get(e.name);   // badge de comptage recollé par nom (l'enfant de groupe garde le sien)
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
      btn.appendChild(document.createTextNode(g.def.label + " "));
      const caret = document.createElement("span"); caret.className = "tabs-dd-caret"; caret.textContent = "▾"; btn.appendChild(caret);
      const menu = document.createElement("div"); menu.className = "tabs-dd-menu"; menu.setAttribute("role", "menu");
      (g.def.children || []).forEach((childName) => {
        const cv = this.views.get(childName); if (!cv) return;   // enfant absent (mode-dépendant) → simplement omis
        const it = document.createElement("button"); it.type = "button"; it.className = "tabs-dd-item"; it.dataset.view = childName; it.setAttribute("role", "menuitem");
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
    (def.extraActions || []).forEach((a) => { const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost"; b.textContent = a.label; if (a.title) b.title = a.title; b.onclick = () => a.onClick(b); acts.appendChild(b); });
    // bouton primaire « + … »
    if (def.onAdd) { const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-primary"; add.textContent = def.addLabel || "+ Nouveau"; add.onclick = () => def.onAdd!(); acts.appendChild(add); }
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
  /** Reflète le nb max de suggestions d'autocomplétion dans le sélecteur des réglages. */
  setAutocompleteMax(v: number): void { if (this.acMaxSel) this.acMaxSel.value = String(FieldFacet.clampLimit(v)); }
  /** Pastille utilisateur (mode API). `user` = objet SSO (login/nom/prénom/eMail…) ; null = non connecté ; undefined = masquer. */
  setUser(user: { name?: string; prenom?: string; nom?: string; login?: string; email?: string; eMail?: string } | null | undefined): void {
    if (!this.userChip) return;
    if (user === undefined) { this.userChip.style.display = "none"; return; }
    this.userChip.style.display = "";
    if (user) {
      const who = user.name || [user.prenom, user.nom].filter(Boolean).join(" ") || user.login || user.eMail || user.email || "utilisateur";
      this.userChip.innerHTML = `<span class="gi">${Icons.USER}</span>` + Html.escape(who); this.userChip.title = "Connecté en tant que " + who; this.userChip.classList.remove("user-chip--off");
    } else {
      this.userChip.innerHTML = `<span class="gi">${Icons.USER}</span>non connecté`; this.userChip.title = "Aucune session SSO active"; this.userChip.classList.add("user-chip--off");
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
    if (this.newBtn) this.newBtn.title = on ? "Nouveau document (Ctrl+N)" : "Nouveau document (Ctrl+N)";
    if (this.openBtn) this.openBtn.title = on ? "Documents… (ouvrir / créer / supprimer)" : "Ouvrir un fichier (Ctrl+O)";
    if (on && this.dataSourceSwitch) this.dataSourceSwitch.checked = true;
    this.updateApiUrlVisibility();
  }
  /** Reflète l'état auto-save dans le popover (case + fréquence). */
  setAutosave(on: boolean, interval: number): void { this.autosaveChk.checked = on; this.autosaveIntervalSel.value = String(interval); }
  setAutosaveStatus(html: string): void { this.autosaveStatusEl.innerHTML = html; }
}
