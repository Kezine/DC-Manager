/* =============================================================================
   SettingsPanel — LES RÉGLAGES de l'application, dans une MODALE DÉDIÉE.
   -----------------------------------------------------------------------------
   Il REMPLACE le POPOVER ancré au bouton de la topbar, dont les défauts étaient
   structurels :
     · le panneau était `position:absolute` DANS la topbar (largeur 320 px, hauteur
       plafonnée à `100dvh - 80px`) — sur petit écran il débordait, défilait mal, et
       tout clic un peu à côté le refermait (`document.addEventListener("click")`) ;
     · il n'avait donc qu'UN point d'ouverture possible, son ancre. Le pied du TIROIR
       responsive ne pouvait pas l'ouvrir lui-même : il SIMULAIT un clic sur le bouton
       de la topbar (`settingsBtn.click()`), faute de quoi le panneau se serait peint
       hors de l'écran. Un chemin d'ouverture qui passe par un `.click()` sur un autre
       bouton est une dépendance invisible : elle casse dès que le bouton d'ancrage est
       masqué (ce qu'on fait désormais hors responsive).
   Une modale de la PILE STANDARD n'a aucun de ces problèmes : elle est centrée, elle
   défile toute seule, elle passe en plein écran sous le breakpoint responsive (règle
   CSS commune à toutes les modales), Échap/✕/clic hors-modale la ferment, le focus y
   est piégé — et surtout elle s'ouvre depuis N'IMPORTE OÙ, sans ancre.

   POURQUOI UNE CLASSE À PART (principe n°2). Même raison que `ShellDrawer` : on
   n'empile pas 200 lignes de panneau dans `Shell.ts`, déjà monolithique. Le couplage
   passe par une INTERFACE INJECTÉE (`SettingsPanelHost`, que `ShellHost` ÉTEND — le
   bootstrap ne fabrique donc qu'UN seul objet d'hôte, aucune déclaration en double),
   patron `PositioningTool`/`PositioningHost`.

   🚨 LE CORPS EST CONSTRUIT UNE SEULE FOIS, puis gardé VIVANT (détaché) entre deux
   ouvertures. C'est ce qui permet aux méthodes de reflet (`setTheme`, `setUiScale`,
   `setAutosave`…) d'être appelées À TOUT MOMENT par le bootstrap — modale fermée
   comprise — exactement comme du temps du popover, qui vivait lui aussi en permanence
   dans le DOM. Reconstruire le panneau à chaque ouverture obligerait au contraire à
   rejouer tout l'état au bon moment, et une seule omission ferait mentir un contrôle.
   `Modal` ne détruit JAMAIS le corps d'un niveau (il le détache), l'invariant tient.
   ============================================================================= */

import { Prefs } from "../core/Prefs";
import { Icons } from "../ui/Icons";
import { FieldFacet } from "../core/FieldFacet";
import { I18n, type LocalePreference } from "../i18n/I18n";
import type { ModalOptions } from "../ui/Modal";

/** Ce que le panneau a besoin de demander à son hôte. Toutes les entrées sont OPTIONNELLES :
    un réglage dont l'hôte n'implémente pas le rappel reste affiché mais inerte (comportement
    historique du popover — aucun contrôle n'a jamais été conditionné à la présence d'un rappel).
    `ShellHost` ÉTEND cette interface : le bootstrap ne déclare qu'un objet, le Shell le passe tel
    quel au panneau. */
export interface SettingsPanelHost {
  /** Ouverture d'une MODALE de la pile STANDARD — injectée par le bootstrap, seul détenteur de
      l'instance `Modal` (même patron que `ScanControl.setup` / `LabelPrintDialog.setup`). Absent
      (tests headless, montage partiel) ⇒ `open()` ne fait RIEN plutôt que de planter. */
  openModal?(opts: ModalOptions): void;
  /** Préférences du SCAN (réglages) : greffon générique « tous les champs texte » / forçage de
      l'icône des champs déclarés. Persistance et application = bootstrap (Prefs + ScanControl). */
  onScanAllFields?(on: boolean): void;
  onScanForceButtons?(on: boolean): void;
  onToggleTheme?(): void;
  onResetViewPrefs?(): void;
  /** Changement d'échelle d'interface (zoom global, taille du texte). */
  onUiScale?(value: number): void;
  /** Bascule « modales en plein écran » (préférence desktop ; toujours actif sous le breakpoint responsive). */
  onModalFullscreen?(on: boolean): void;
  /** Changement du nombre max de suggestions d'autocomplétion des formulaires. */
  onAutocompleteMax?(value: number): void;
  /** Nettoyage des images de façade NON UTILISÉES (purge bibliothèque ; mode API : + compactage serveur). */
  onPurgeImages?(): void;
  /** Bascule de la source de données ("local" | "api") — applique au rechargement. */
  onDataSource?(value: string): void;
  /** Changement de l'URL de base de l'API (mode API) — applique au rechargement. */
  onApiBaseUrl?(value: string): void;
  /** Changement de l'URL de connexion SSO (bouton « Connexion » du welcome). */
  onLoginUrl?(value: string): void;
  /** Bascule du mode d'accès FS ("file" | "directory"). */
  onFileAccessMode?(value: string): void;
  /** Active/désactive les logs de débogage console. */
  onDebugLog?(on: boolean): void;
  /** Activation/désactivation de l'auto-save (Promise → état effectif appliqué). */
  onAutosaveToggle?(on: boolean): void;
  /** Changement de fréquence d'auto-save (secondes). */
  onAutosaveInterval?(seconds: number): void;
  /** Export du document en JSON autonome (téléchargement) — tous modes. */
  onExportJson?(): void;
  /** Export en VISUALISEUR autonome (HTML lecture seule, document embarqué). */
  onExportStandalone?(): void;
}

export class SettingsPanel {
  private host: SettingsPanelHost;
  /** CORPS de la modale — construit une fois, conservé détaché entre deux ouvertures (cf. en-tête). */
  private root: HTMLElement;

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
  private scanAllChk!: HTMLInputElement;           // pref « bouton scan sur tous les champs texte »
  private scanForceChk!: HTMLInputElement;         // pref « toujours afficher le bouton scan »
  private autosaveChk!: HTMLInputElement;
  private autosaveIntervalSel!: HTMLSelectElement;
  private autosaveStatusEl!: HTMLElement;
  private fileOnlySections: HTMLElement[] = [];    // sections propres au mode fichier (auto-save, accès fichiers)
  private maintenanceSection: HTMLElement | null = null;   // section « Maintenance » (permission `maintenance:run`)
  private exportSection: HTMLElement | null = null;        // section « Export » (lecture de TOUTES les collections)

  constructor(host: SettingsPanelHost) {
    this.host = host;
    this.root = this.build();
  }

  /** Ouvre les réglages dans une modale de la pile STANDARD. Niveau `info` (`hideFooter`) : aucun
      « Enregistrer »/« Annuler » — chaque réglage s'applique À LA VOLÉE, comme du temps du popover.
      La `stackKey` DÉDUPLIQUE : rouvrir les réglages alors qu'ils sont déjà dans la pile redescend
      jusqu'à eux au lieu d'empiler un second exemplaire (décision D5 de `Modal`). */
  open(): void {
    this.host.openModal?.({
      title: I18n.t("shell.settings.title"),
      body: this.root,
      hideFooter: true,
      stackKey: "settings",
    });
  }

  /* ------------------------------------------------------------------ construction -- */

  /** Fabrique un toggle SLIDER `.mode-switch` (case cachée + piste) — contrôle PARTAGÉ par la source de
      données, le thème et les modales plein écran (principe n°3 : un seul idiome pour toutes les bascules
      slider). L'anneau focus-visible et les transitions sont portés par le CSS `.mode-switch`. Le câblage
      `onchange` et l'étiquetage (côtés/icônes, aria-label) restent à la charge de l'appelant. */
  private static modeSwitch(): { label: HTMLLabelElement; input: HTMLInputElement } {
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

  private build(): HTMLElement {
    const panel = document.createElement("div"); panel.className = "settings-panel";
    const section = (title: string) => { const s = document.createElement("div"); s.className = "settings-section"; const t = document.createElement("div"); t.className = "settings-section-title"; t.textContent = title; s.appendChild(t); panel.appendChild(s); return s; };

    // -- Source de données : toggle SLIDER Local ⟷ API (+ URL d'API en mode API) --
    const src = section(I18n.t("shell.settings.dataSource"));
    const srcRow = document.createElement("div"); srcRow.className = "mode-switch-row";
    const lblLocal = document.createElement("span"); lblLocal.className = "mode-switch-side"; lblLocal.textContent = I18n.t("shell.settings.local");
    const dsSwitch = SettingsPanel.modeSwitch(); this.dataSourceSwitch = dsSwitch.input;
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

    // -- Scan (caméra) : préférences du greffon de scan (chantier QR, cf. docs/qr-scan.md § UI) --
    // Deux bascules : greffon GÉNÉRIQUE sur tous les champs texte, et FORÇAGE de l'icône des champs
    // déclarés sur desktop (par défaut elle n'apparaît qu'en tactile/écran étroit — pas d'icône morte).
    const sc = section(I18n.t("shell.settings.scan"));
    const scAllRow = document.createElement("div"); scAllRow.className = "settings-toggle-row";
    const scAllLabel = document.createElement("label"); scAllLabel.className = "settings-toggle";
    this.scanAllChk = document.createElement("input"); this.scanAllChk.type = "checkbox";
    this.scanAllChk.onchange = () => this.host.onScanAllFields?.(this.scanAllChk.checked);
    scAllLabel.append(this.scanAllChk, document.createTextNode(I18n.t("shell.settings.scanAllFields")));
    scAllRow.appendChild(scAllLabel); sc.appendChild(scAllRow);
    const scForceRow = document.createElement("div"); scForceRow.className = "settings-toggle-row";
    const scForceLabel = document.createElement("label"); scForceLabel.className = "settings-toggle";
    this.scanForceChk = document.createElement("input"); this.scanForceChk.type = "checkbox";
    this.scanForceChk.onchange = () => this.host.onScanForceButtons?.(this.scanForceChk.checked);
    scForceLabel.append(this.scanForceChk, document.createTextNode(I18n.t("shell.settings.scanForce")));
    scForceRow.appendChild(scForceLabel); sc.appendChild(scForceRow);
    const scNote = document.createElement("div"); scNote.className = "settings-row-note"; scNote.textContent = I18n.t("shell.settings.scanNote"); sc.appendChild(scNote);

    // -- Apparence -- (seule section « cosmétique » conservée en mode visualiseur ; cf. body.viewer-mode)
    const app = section(I18n.t("shell.settings.appearance")); app.classList.add("settings-cosmetic");
    // -- Thème clair / sombre : toggle SLIDER (même contrôle que la source de données) flanqué du SOLEIL (thème
    //    clair, à gauche = décoché) et de la LUNE (thème sombre, à droite = coché) — sens du mode-switch (le pouce
    //    glisse à droite quand coché). Comportement inchangé : l'appui BASCULE (host.onToggleTheme, persistance via
    //    Prefs) ; la position est reflétée par setTheme (boot + après bascule). aria-label/title localisés ; l'anneau
    //    focus-visible du mode-switch s'applique. --
    const themeRow = document.createElement("div"); themeRow.className = "mode-switch-row mode-switch-row--spread";
    const themeSwitch = SettingsPanel.modeSwitch(); this.themeSwitch = themeSwitch.input;
    this.themeSwitch.setAttribute("aria-label", I18n.t("shell.settings.toggleTheme")); this.themeSwitch.title = I18n.t("shell.settings.toggleTheme");
    this.themeSwitch.onchange = () => this.host.onToggleTheme?.();
    themeRow.append(SettingsPanel.modeSwitchIcon(Icons.SUN), themeSwitch.label, SettingsPanel.modeSwitchIcon(Icons.MOON)); app.appendChild(themeRow);
    // -- Modales en plein écran (préférence DESKTOP) : MÊME toggle mode-switch, JUSTE SOUS le thème. Le libellé nomme
    //    la préférence (gauche) ; l'icône « plein écran » marque l'état ACTIF (droite = coché = plein écran), un seul
    //    côté iconé suffit ici (bascule binaire, contrairement au thème à deux états nommés). Toujours actif sous le
    //    breakpoint responsive (CSS seul) ; ici on ne pilote QUE l'effet desktop (attribut data-modal-fs). --
    const mfsRow = document.createElement("div"); mfsRow.className = "mode-switch-row mode-switch-row--spread"; mfsRow.style.marginTop = "12px";
    const mfsLabel = document.createElement("span"); mfsLabel.className = "mode-switch-label"; mfsLabel.textContent = I18n.t("shell.settings.modalFs");
    const mfsSwitch = SettingsPanel.modeSwitch(); this.modalFsChk = mfsSwitch.input;
    this.modalFsChk.setAttribute("aria-label", I18n.t("shell.settings.modalFs")); this.modalFsChk.title = I18n.t("shell.settings.modalFs");
    this.modalFsChk.onchange = () => this.host.onModalFullscreen?.(this.modalFsChk.checked);
    mfsRow.append(mfsLabel, mfsSwitch.label, SettingsPanel.modeSwitchIcon(Icons.FULLSCREEN)); app.appendChild(mfsRow);
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
    this.exportSection = exp;   // masquée sans la lecture de TOUTES les collections (mode API) — cf. setExportAllowed
    const expJsonBtn = document.createElement("button"); expJsonBtn.type = "button"; expJsonBtn.className = "btn btn-ghost btn-sm"; expJsonBtn.style.width = "100%"; expJsonBtn.textContent = I18n.t("shell.settings.exportJson");
    expJsonBtn.onclick = () => this.host.onExportJson?.();
    const expHtmlBtn = document.createElement("button"); expHtmlBtn.type = "button"; expHtmlBtn.className = "btn btn-ghost btn-sm"; expHtmlBtn.style.cssText = "width:100%;margin-top:8px"; expHtmlBtn.textContent = I18n.t("shell.settings.exportStandalone");
    expHtmlBtn.onclick = () => this.host.onExportStandalone?.();
    exp.append(expJsonBtn, expHtmlBtn);
    const expNote = document.createElement("div"); expNote.className = "settings-row-note"; expNote.textContent = I18n.t("shell.settings.exportNote"); exp.appendChild(expNote);
    // -- Maintenance (tous modes) : purge des images de façade non utilisées (+ compactage serveur en mode API) --
    const mnt = section(I18n.t("shell.settings.maintenance"));
    this.maintenanceSection = mnt;   // masquée sans la permission `maintenance:run` (mode API) — cf. setMaintenanceAllowed
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

    return panel;
  }

  /* --------------------------------------------------------------------- reflets -- */
  /* Toutes ces méthodes REFLÈTENT un état décidé ailleurs (bootstrap / Prefs) sans déclencher le
     rappel correspondant — elles sont appelables modale FERMÉE (le corps vit en permanence). */

  setDataSource(value: string): void { if (this.dataSourceSwitch) this.dataSourceSwitch.checked = (value === "api"); this.updateApiUrlVisibility(); }
  /** Reflète l'URL de l'API dans le champ des réglages. */
  setApiBaseUrl(url: string): void { if (this.apiUrlInput) this.apiUrlInput.value = url || ""; }
  /** Reflète l'URL de connexion SSO dans le champ des réglages. */
  setLoginUrl(url: string): void { if (this.apiLoginInput) this.apiLoginInput.value = url || ""; }
  /** Affiche les lignes API (URL + connexion) uniquement quand le mode API est sélectionné. */
  private updateApiUrlVisibility(): void { const on = (this.dataSourceSwitch && this.dataSourceSwitch.checked) ? "" : "none"; if (this.apiUrlRow) this.apiUrlRow.style.display = on; if (this.apiLoginRow) this.apiLoginRow.style.display = on; }
  setFileAccessMode(value: string): void { if (this.fileAccessSel) this.fileAccessSel.value = value; }
  setDebugLog(on: boolean): void { if (this.debugLogChk) this.debugLogChk.checked = on; }
  /** Reflète l'échelle d'interface dans le sélecteur des réglages (sans déclencher onUiScale). */
  setUiScale(v: number): void { if (this.uiScaleSel) this.uiScaleSel.value = String(v); }
  /** Reflète le thème courant dans la bascule des réglages (coché = sombre) — sans déclencher onToggleTheme. */
  setTheme(theme: string): void { if (this.themeSwitch) this.themeSwitch.checked = (theme === "dark"); }
  /** Reflète la préférence « modales en plein écran » dans la bascule (sans déclencher onModalFullscreen). */
  setModalFullscreen(on: boolean): void { if (this.modalFsChk) this.modalFsChk.checked = on; }
  /** Reflète le nb max de suggestions d'autocomplétion dans le sélecteur des réglages. */
  setAutocompleteMax(v: number): void { if (this.acMaxSel) this.acMaxSel.value = String(FieldFacet.clampLimit(v)); }
  /** Reflète les préférences de scan dans les bascules des réglages (sans déclencher les rappels). */
  setScanPrefs(allFields: boolean, force: boolean): void {
    if (this.scanAllChk) this.scanAllChk.checked = allFields;
    if (this.scanForceChk) this.scanForceChk.checked = force;
  }
  /** Reflète l'état auto-save (case + fréquence). */
  setAutosave(on: boolean, interval: number): void { if (this.autosaveChk) this.autosaveChk.checked = on; if (this.autosaveIntervalSel) this.autosaveIntervalSel.value = String(interval); }
  setAutosaveStatus(html: string): void { if (this.autosaveStatusEl) this.autosaveStatusEl.innerHTML = html; }
  /** Mode API : masque les sections propres au mode FICHIER (auto-save, accès fichiers) et force la
      position du toggle de source de données. */
  setRestMode(on: boolean): void {
    this.fileOnlySections.forEach((s) => { if (s) s.style.display = on ? "none" : ""; });
    if (on && this.dataSourceSwitch) this.dataSourceSwitch.checked = true;
    this.updateApiUrlVisibility();
  }
  /** Section « Maintenance » (purge des binaires orphelins + compactage) : geste d'ADMINISTRATION,
      masqué sans la permission `maintenance:run` (cf. docs/auth.md § « Gating côté client »). */
  setMaintenanceAllowed(on: boolean): void { if (this.maintenanceSection) this.maintenanceSection.style.display = on ? "" : "none"; }
  /** Section « Export » (JSON autonome + visualiseur HTML) : les deux portent le document ENTIER, et
      sous droits partiels le cache ne le contient PLUS (cf. docs/auth.md § 10.6) — masquée, jamais
      proposée puis tronquée. */
  setExportAllowed(on: boolean): void { if (this.exportSection) this.exportSection.style.display = on ? "" : "none"; }
}
