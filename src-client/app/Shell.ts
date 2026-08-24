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
  /** ⚠ VESTIGE du menu à UN niveau : depuis le re-design (cf. docs/navigation.md), c'est `NAV_DOMAINS`
      qui décide où une vue apparaît — toutes les vues sont peintes dans la barre de niveau 2 de leur
      domaine, sans distinction. Le champ ne sert plus qu'à documenter le RANG historique de la vue
      (« était un onglet primaire » / « était une sous-vue »). Aucun rendu n'en dépend.
      Le troisième cas, "group", A DISPARU avec le mécanisme de groupe déroulant. */
  kind?: "primary" | "secondary";
  /** Vue de rattachement HISTORIQUE d'une sous-vue. Le surlignage passe désormais par le DOMAINE
      (`NavModel.activeDomain`) ; `parent` n'est plus qu'un REPLI, utilisé quand une vue n'est rattachée
      à aucun domaine — anomalie que le verrou d'exhaustivité interdit, mais que le rendu doit traverser
      sans planter (cf. `ShellNav.activeTab`). */
  parent?: string;
  /** Compteur affiché en badge (onglet topbar + tout lien qui pointe vers cette vue). Badge MASQUÉ à 0
      (pas de pastille « 0 » : bruit / pas d'alerte). */
  count?: () => number;
  /** Teinte d'ALERTE de la pastille (null = neutre) : "warn" (attention) ou "err" (critique). Évaluée à chaque
      `refreshCounts`. Ex. interventions ouvertes CRITIQUES → err ; certificats expirés → err, expirants → warn. */
  countClass?: () => string | null;
  /** Icône SVG (constante du registre `ui/Icons`) de la vue. Peinte dans le tiroir responsive et, quand
      un seul domaine est visible (`flattened`), dans la barre de niveau 1. La barre de VUES (niveau 2)
      est volontairement TEXTUELLE : la maquette tranche « libellés > icônes » — l'icône seule n'est plus
      le régime normal. Absente → simplement pas de glyphe. */
  icon?: string;
  /** Prédicat de VISIBILITÉ de la vue — droit de LECTURE (cf. docs/auth.md § « Gating côté client »).
      Faux ⇒ la vue disparaît de TOUS les chemins du menu (barre de niveau 2, barre de niveau 1 quand elle
      est aplatie, tiroir responsive) — et `switchView` refuse d'y aller (repli sur la première vue
      visible). Le masquage n'est plus un `display:none` posé après coup mais une ABSENCE dans la
      structure résolue : c'est `NavModel.resolve` qui écarte la vue, donc aucun chemin ne peut être
      oublié. Réévalué à chaque `refreshCounts()` — exactement comme les pastilles de
      comptage et les `extraActions[].visible`, donc à chaque changement d'onglet, à chaque
      rafraîchissement de vue et à chaque changement de droits.
      ABSENT = toujours visible. En mode FICHIER/visualiseur, l'état d'autorisation est « tout permis »
      par construction : le prédicat rend vrai de lui-même, et RIEN ne bouge (injection nulle). */
  visible?: () => boolean;
  /** Libellé du bouton primaire « + … » de l'en-tête (si action de création). */
  addLabel?: string;
  /** Action du bouton primaire. */
  onAdd?: () => void;
  /** Prédicat de visibilité du bouton primaire « + … » — droit de CRÉATION du domaine de la vue.
      Même moment d'évaluation que `extraActions[].visible` (elles partagent le même registre).
      Absent = bouton affiché dès que `onAdd` existe (comportement historique). */
  canAdd?: () => boolean;
  /** Boutons secondaires (ghost) de l'en-tête, avant le bouton primaire.
      `onClick` reçoit le bouton rendu → un handler asynchrone peut le désactiver / changer son
      libellé le temps d'un appel (ex. « Synchroniser » → « Synchronisation… » sur l'onglet VMs).
      `visible` (optionnel) = prédicat CONDITIONNANT l'affichage du bouton, réévalué à chaque
      `refreshCounts()` (donc à chaque changement d'onglet et à chaque rafraîchissement de vue) —
      MÊME mécanique que la pastille de comptage, masquée à 0. Absent = bouton toujours affiché
      (comportement historique). Cas d'usage : « Purger… » de l'onglet VMs, qui n'a de sens que
      s'il existe au moins une VM purgeable (orpheline ou d'un provider disparu). */
  extraActions?: Array<{ label: string; onClick: (btn: HTMLButtonElement) => void; title?: string; visible?: () => boolean }>;
  /** Appelé à chaque activation (rendu / rafraîchissement) avec le corps de vue. */
  onShow?: (body: HTMLElement) => void;
}

/** Services applicatifs de la topbar (fichier / global), câblés par le bootstrap.
    ÉTEND `SettingsPanelHost` : tout ce qui concerne les RÉGLAGES est déclaré une seule fois, dans
    le module qui les porte (`app/SettingsPanel`). Le bootstrap ne fabrique donc qu'UN objet d'hôte,
    que le Shell passe tel quel au panneau — aucune liste de rappels à tenir en double. */
export interface ShellHost extends SettingsPanelHost {
  onNew?(): void; onOpen?(): void; onSave?(): void; onSaveAs?(): void;
  onUndo?(): void; onRedo?(): void;
  /** Ouverture de la RECHERCHE GLOBALE (palette) — loupe de la topbar ET raccourci Ctrl+K (le
      raccourci est enregistré par le bootstrap, qui porte la garde « pas par-dessus une modale »). */
  onGlobalSearch?(): void;
  /** SCANNER UNE ÉTIQUETTE (viseur caméra en mode libre — chantier QR, cf. docs/qr-scan.md § UI).
      Bouton révélé par `setScanAvailable` quand une caméra existe. */
  onScanGlobal?(): void;
  /** PANIER d'actions groupées (cf. docs/panier.md). Bouton révélé par `setCartAvailable`
      quand au moins une action groupée est disponible (V1-Beta : impression = mode API). */
  onCart?(): void;
  /** BASCULE du thème — commande GLOBALE (action « Basculer le thème » de la palette Ctrl+K), et non
      un réglage : elle ne choisit pas une préférence, elle demande l'inverse de ce qui est affiché.
      Le toggle des réglages, lui, passe par `onThemePreference` (cf. `SettingsPanelHost`). */
  onToggleTheme?(): void;
  /** Ouverture de la modale d'INFOS UTILISATEUR (clic sur la pastille de la topbar — icône seule en
      responsive, nom + icône en grand écran : MÊME geste). L'implémentation (bootstrap) y injecte
      l'identité `/me` et l'état d'autorisation DÉJÀ connus — aucun appel serveur. */
  onUserInfo?(): void;
  onRenameDoc?(name: string): void;
  /** Ouverture en FORÇANT un mode d'accès ("file" | "directory") — depuis l'écran d'accueil. */
  onOpenMode?(mode: string): void;
  /** Réouverture du dernier fichier (raccroche au handle FS — geste utilisateur). */
  onReopenLast?(): void;
}

/** Champs de la barre de statut. */
export interface ShellStatus { file?: string; release?: string; source?: string; entities?: number | string; lastSave?: string; }

import { Html } from "../core/Html";
import { UserIdentity } from "../core/UserIdentity";
import { Icons } from "../ui/Icons";
import { I18n } from "../i18n/I18n";
import { ShellNav } from "./ShellNav";
import type { ShellNavLookup } from "./ShellNav";
import { NavModel, NAV_DOMAINS } from "./NavModel";
import type { ResolvedNav, ResolvedNavView, NavViewDecl } from "./NavModel";
import { ShellDrawer } from "./ShellDrawer";
import type { ShellDrawerHost } from "./ShellDrawer";
import { SettingsPanel } from "./SettingsPanel";
import type { SettingsPanelHost } from "./SettingsPanel";

const SVG = "http://www.w3.org/2000/svg";
const svgIcon = (paths: string): SVGElement => {
  const s = document.createElementNS(SVG, "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.innerHTML = paths; return s;
};

interface ViewEntry { def: ShellView; section: HTMLElement; header: HTMLElement; body: HTMLElement; }

/* =============================================================================
   SHELL — ossature complète :
     · TOPBAR : logo + marque + nom de document + DOMAINES (niveau 1) + actions
       fichier (nouveau / ouvrir / enregistrer / copie / annuler / rétablir) + réglages
       + burger (responsive) ;
     · STATUSBAR : état de sauvegarde, fichier, release, source, nb d'entités, dernière save ;
     · BARRE DE VUES (niveau 2) : les vues du domaine actif, en pastilles ;
     · MAIN : une <section> par vue, chacune avec son `.view-header` (fil d'Ariane
       « domaine › vue » + titre ▸ + actions : boutons secondaires / bouton « + … ») et son corps.

   🚨 MENU À DEUX NIVEAUX (re-design 2026-08-20, cf. docs/navigation.md). Le Shell ne
   PORTE plus la structure du menu : il la reçoit RÉSOLUE de `app/NavModel` (module PUR,
   testé) et se contente de la PEINDRE. Conséquences à connaître avant de toucher à ce
   fichier :
     · un DOMAINE n'est PAS une vue — ni <section>, ni corps, ni hash ; cliquer un
       domaine active sa PREMIÈRE VUE VISIBLE (piège ① de l'ancien `kind:"group"`) ;
     · le masquage par droits n'est plus un `display:none` posé après coup : une vue
       invisible est ABSENTE de la structure résolue, donc de tous les chemins à la fois ;
     · 🚨 RÈGLE (A) — un badge de comptage n'appartient qu'à une entrée TERMINALE. Le
       rendu ci-dessous LIT le booléen `badge` de chaque entrée et n'écrit JAMAIS de
       condition du genre « si c'est un domaine, pas de badge » : la règle a UNE seule
       source, `NavModel.allowsBadge`, et elle est prouvée par test.
   ============================================================================= */
export class Shell {
  private tabsEl: HTMLElement;                        // barre de NIVEAU 1 (domaines, ou vues si `flattened`)
  private viewsBarEl: HTMLElement;                    // barre de NIVEAU 2 (vues du domaine actif)
  private mainEl: HTMLElement;
  private docNameEl: HTMLInputElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private saveBtn!: HTMLButtonElement;
  private saveDot!: HTMLElement;
  private searchBtn!: HTMLButtonElement;          // loupe « Recherche globale » (Ctrl+F) — masquée sans aucune lecture documentaire
  private cartBtn!: HTMLButtonElement;            // « Panier » (actions groupées) — masqué sans action disponible (cf. setCartAvailable)
  private cartBadge!: HTMLElement;                // pastille de comptage du panier
  private scanBtn!: HTMLButtonElement;            // « Scanner une étiquette » (viseur caméra) — masqué sans caméra (cf. setScanAvailable)
  private newBtn!: HTMLButtonElement;             // « Nouveau » (fichier ou document serveur)
  private openBtn!: HTMLButtonElement;            // « Ouvrir » (fichier ou sélecteur de documents)
  private fileActionsEl!: HTMLElement;            // Enregistrer/Enregistrer-sous (masqués en mode API)
  private userChip!: HTMLElement;                 // pastille « connecté en tant que … » (mode API)
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
  private order: string[] = [];                        // ordre d'ENREGISTREMENT des vues (l'ordre d'AFFICHAGE vient de NAV_DOMAINS)
  private burgerBtn!: HTMLButtonElement;               // ouverture du tiroir responsive (masqué au-dessus du breakpoint)
  private settingsBtn!: HTMLButtonElement;             // déclencheur des Réglages en topbar (ouvre la MODALE, plus aucun popover ancré)
  private settings!: SettingsPanel;                    // panneau des Réglages (modale dédiée) — classe à part, principe n°2
  private drawer!: ShellDrawer;                        // tiroir à accordéons (responsive) — classe à part, principe n°2
  /** Structure de navigation RÉSOLUE en cours d'affichage. Recalculée par `renderNav()` à chaque
      `refreshCounts()` : les droits peuvent changer à chaud, et la structure avec eux. */
  private nav: ResolvedNav = { domains: [], flattened: false };
  /** SIGNATURE de la structure peinte (domaines × vues × aplatissement). On ne reconstruit les barres
      que si elle CHANGE : `refreshCounts()` est appelée très souvent (chaque bascule d'onglet, chaque
      rafraîchissement de vue, chaque comptage résolu) et reconstruire le DOM à chaque fois volerait le
      focus clavier au milieu d'une navigation. */
  private navSignature = "";
  /** Domaine dont la barre de niveau 2 est actuellement peinte (null = aucune barre). */
  private viewsBarDomain: string | null = null;
  /** Pastilles de comptage de la barre de NIVEAU 1 : NON VIDE seulement quand la structure est aplatie
      (un seul domaine visible ⇒ ce sont des VUES, donc des entrées terminales — règle (A)). */
  private badgesLevel1: Array<{ name: string; el: HTMLElement }> = [];
  /** Pastilles de comptage de la barre de NIVEAU 2 (les vues du domaine actif). */
  private badgesLevel2: Array<{ name: string; el: HTMLElement }> = [];
  /** Boutons d'en-tête à visibilité CONDITIONNELLE (`ViewDef.extraActions[].visible`, `ViewDef.canAdd`) —
      réévalués par `refreshCounts()`, exactement comme les pastilles de comptage. Reconstruit par `build()`. */
  private conditionalActions: Array<{ el: HTMLElement; visible: () => boolean }> = [];
  /** Garde de ré-entrance du REPLI (`switchView` rappelle `refreshCounts`, qui re-teste la visibilité).
      Le repli converge de lui-même — cette garde protège d'un prédicat non déterministe, pas du cas normal. */
  private fallbackInProgress = false;
  /** États du chrome MÉMORISÉS parce que le TIROIR les redemande (il peint sa propre pastille de
      sauvegarde et ses propres boutons annuler/rétablir) : le Shell est leur seule source. */
  private saveStateValue = "mem";
  private canUndoValue = false;
  private canRedoValue = false;
  private restMode = false;
  /** Nom affichable de l'utilisateur connecté (null = non connecté / mode fichier) — repeint par
      `setUser`, relu par le tiroir pour son en-tête. */
  private userName: string | null = null;
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
    // RECHERCHE GLOBALE : la LOUPE seule (arbitrage utilisateur 2026-07-30 — pas le déclencheur-champ
    // large de la maquette : dans une topbar déjà dense, un faux champ prend la place des onglets et
    // LAISSE CROIRE qu'on peut y taper). Première de la rangée — action de LECTURE, avant les actions
    // de fichier. Le raccourci (Ctrl+F, annoncé dans le tooltip) est enregistré par le bootstrap.
    this.searchBtn = iconBtn(I18n.t("shell.topbar.globalSearch"), '<circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/>', () => this.host.onGlobalSearch?.());
    actions.appendChild(this.searchBtn);
    // SCANNER UNE ÉTIQUETTE (chantier QR) : le viseur caméra en mode LIBRE — un deep-link d'étiquette
    // OUVRE la fiche, toute autre valeur offre copier / insérer. Posé À CÔTÉ de la loupe : les deux
    // sont des entrées de NAVIGATION (retrouver un objet), avant les actions de fichier. MASQUÉ par
    // défaut — l'hôte le révèle si une caméra existe (`setScanAvailable`, sonde async du bootstrap).
    // L'icône vient du registre (`Icons.SCAN`, principe n°14) — d'où l'innerHTML plutôt qu'iconBtn,
    // qui fabrique son propre <svg> à partir de chemins nus.
    this.scanBtn = document.createElement("button"); this.scanBtn.type = "button"; this.scanBtn.className = "icon-btn";
    this.scanBtn.title = I18n.t("shell.topbar.scan"); this.scanBtn.setAttribute("aria-label", I18n.t("shell.topbar.scan"));
    this.scanBtn.innerHTML = Icons.SCAN;
    this.scanBtn.style.display = "none";
    this.scanBtn.onclick = () => this.host.onScanGlobal?.();
    actions.appendChild(this.scanBtn);
    // PANIER (actions groupées) : à côté du scan — même famille de gestes « je prépare un lot,
    // j'agis ensuite ». MASQUÉ par défaut, l'hôte le révèle si une action groupée existe
    // (`setCartAvailable`, patron d'injection nulle — cf. docs/panier.md). La pastille porte le
    // COMPTE, comme les onglets portent le leur : le panier est un état, il doit se voir sans clic.
    this.cartBtn = document.createElement("button"); this.cartBtn.type = "button"; this.cartBtn.className = "icon-btn topbar-cart";
    this.cartBtn.title = I18n.t("cart.topbar"); this.cartBtn.setAttribute("aria-label", I18n.t("cart.topbar"));
    this.cartBtn.innerHTML = Icons.CART;
    this.cartBadge = document.createElement("span"); this.cartBadge.className = "cart-badge"; this.cartBadge.hidden = true;
    this.cartBtn.appendChild(this.cartBadge);
    this.cartBtn.style.display = "none";
    this.cartBtn.onclick = () => this.host.onCart?.();
    actions.appendChild(this.cartBtn);
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
    // `topbar-history` : ces deux-là quittent la topbar en responsive — le PIED du tiroir les reprend
    // (cf. @media 760px). Une classe plutôt qu'un style inline : `setRestMode` pilote déjà leur `display`,
    // et deux commandes inline sur la même propriété s'écraseraient l'une l'autre.
    this.undoBtn.classList.add("topbar-history"); this.redoBtn.classList.add("topbar-history");
    actions.append(this.undoBtn, this.redoBtn);
    // pastille utilisateur (mode API) : « connecté en tant que … » — masquée par défaut. BOUTON (et non
    // un simple <span>) : le clic ouvre la modale d'infos (le nom disparaît en responsive, seule l'icône
    // reste — la modale redonne l'identité et les droits). Le title/aria-label portent le nom (posés par
    // setUser), donc l'icône seule reste annoncée aux lecteurs d'écran.
    this.userChip = document.createElement("button"); this.userChip.className = "user-chip"; this.userChip.style.display = "none";
    (this.userChip as HTMLButtonElement).type = "button";
    this.userChip.onclick = () => this.host.onUserInfo?.();
    actions.appendChild(this.userChip);
    // RÉGLAGES : le panneau vit dans une MODALE dédiée (`app/SettingsPanel`), plus dans un popover
    // ancré à ce bouton. Le bouton n'est donc qu'un DÉCLENCHEUR parmi d'autres — le pied du tiroir
    // responsive en est un second, qui ouvre la MÊME instance sans passer par un `.click()` simulé.
    // Icône « double slider empilé » (deux curseurs horizontaux à positions distinctes) : le rouage
    // denté est réservé au groupe « Paramètres » (contacts + notifications), cf. Icons.SETTINGS.
    this.settings = new SettingsPanel(host);
    this.settingsBtn = iconBtn(I18n.t("shell.settings.title"), '<line x1="3" y1="8" x2="14" y2="8"/><line x1="18" y1="8" x2="21" y2="8"/><circle cx="16" cy="8" r="2"/><line x1="3" y1="16" x2="8" y2="16"/><line x1="12" y1="16" x2="21" y2="16"/><circle cx="10" cy="16" r="2"/>', () => this.settings.open());
    this.settingsBtn.classList.add("topbar-settings");   // repère du masquage « viewer » (cf. body.viewer-mode)
    this.settingsBtn.setAttribute("aria-haspopup", "dialog");
    actions.appendChild(this.settingsBtn);
    // BURGER (responsive) : DERNIER de la rangée, donc au bord de l'écran — le pouce y arrive sans
    // traverser la topbar. Masqué au-dessus du breakpoint par le CSS (jamais par un style inline : la
    // bascule est purement une question de largeur, aucun état applicatif ne la commande).
    // 🚨 Règle (A) : AUCUN badge dessus — il ne représente rien de terminal (la maquette en proposait
    // un, agrégé ; la décision utilisateur du 2026-08-20 tranche contre).
    this.burgerBtn = document.createElement("button"); this.burgerBtn.type = "button";
    this.burgerBtn.className = "icon-btn topbar-burger topbar-needs-doc";
    this.burgerBtn.innerHTML = Icons.MENU;
    this.burgerBtn.title = I18n.t("shell.nav.menu"); this.burgerBtn.setAttribute("aria-label", I18n.t("shell.nav.menu"));
    this.burgerBtn.setAttribute("aria-haspopup", "dialog");
    this.burgerBtn.onclick = () => this.drawer.toggle();
    actions.appendChild(this.burgerBtn);

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

    // ---- BARRE DE VUES (niveau 2) ----
    // Posée APRÈS la barre de statut : en mode API celle-ci est masquée, la barre de vues vient donc
    // directement sous la topbar comme dans la maquette ; en mode fichier le mince bandeau de statut
    // s'intercale. Elle N'EST PAS sticky — la barre de statut l'est déjà à `top:56px` et deux collants
    // au même offset se chevaucheraient au défilement (l'ancienne sous-navigation, en en-tête de vue,
    // défilait elle aussi).
    const viewsBar = document.createElement("div");
    viewsBar.className = "views-bar topbar-needs-doc";   // neutralisée tant qu'aucun document n'est ouvert
    viewsBar.setAttribute("role", "tablist");
    viewsBar.setAttribute("aria-label", I18n.t("shell.nav.views"));
    viewsBar.style.display = "none";                     // peinte par renderNav() dès qu'il y a un domaine actif

    const main = document.createElement("main");   // styles pilotés par dc-manager.css (padding, max-width, :has full-bleed)

    root.append(topbar, statusbar, viewsBar, main, this.buildWelcome());
    this.tabsEl = tabs; this.viewsBarEl = viewsBar; this.mainEl = main; this.docNameEl = docName;
    // TIROIR responsive : instancié ici (une seule fois) et branché par son interface hôte — le Shell
    // n'en connaît que `element` / `toggle` / `close` / `refresh` (principe n°2).
    this.drawer = new ShellDrawer(this.drawerHost());
    root.appendChild(this.drawer.element);
    // navigation par l'URL (#nom) : back/forward du navigateur ou hash édité → bascule d'onglet (si ≠ courant).
    // `resolveHash` EXCLUT les DOMAINES (piège ① : un domaine n'a pas de hash) et accepte les sous-vues
    // (piège ⑤ : #contacts ouvre la sous-page).
    window.addEventListener("hashchange", () => { const v = ShellNav.resolveHash(location.hash, this.navLookup()); if (v && v !== this.current) this.switchView(v); });
  }

  /** Contrat du TIROIR (cf. `ShellDrawer`) : tout ce qu'il a le droit de demander, et rien de plus. Il ne
      voit ni le registre des vues, ni les droits, ni le Store — seulement la structure déjà résolue. */
  private drawerHost(): ShellDrawerHost {
    return {
      nav: () => this.nav,
      currentView: () => this.current,
      goToView: (name) => this.switchView(name),
      viewBadge: (name) => this.badgeValue(name),
      userLabel: () => this.userName,
      onUserInfo: () => this.host.onUserInfo?.(),
      saveState: () => this.saveStateValue,
      saveVisible: () => !this.restMode,
      historyVisible: () => !this.restMode,
      canUndo: () => this.canUndoValue,
      canRedo: () => this.canRedoValue,
      onUndo: () => this.host.onUndo?.(),
      onRedo: () => this.host.onRedo?.(),
      // Le tiroir ouvre DIRECTEMENT la modale des réglages — la MÊME instance de panneau que le
      // bouton de la topbar (une seule implémentation, cf. `app/SettingsPanel`). L'ancien montage
      // simulait un `.click()` sur ce bouton, faute de pouvoir peindre ailleurs un popover qui lui
      // était ancré : cette dépendance invisible a disparu avec le popover.
      onSettings: () => this.settings.open(),
    };
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

  /** Carte `nom → { parent, kind }` (vues + DOMAINES) pour résoudre un hash (cf. ShellNav).
      🚨 Les DOMAINES y figurent avec `kind:"domain"` — non pas parce qu'ils navigueraient, mais
      justement pour que `resolveHash` les REFUSE EXPLICITEMENT : un `#reseau` bookmarké ne doit
      ouvrir aucune vue. S'en remettre à leur simple absence de la carte marcherait tant qu'aucun
      domaine ne porte le nom d'une vue — une coïncidence qu'on ne veut pas avoir à surveiller. */
  private navLookup(): ShellNavLookup {
    const m: ShellNavLookup = {};
    this.views.forEach((v, n) => { m[n] = { parent: v.def.parent, kind: v.def.kind }; });
    for (const d of NAV_DOMAINS) m[d.name] = { kind: "domain" };
    return m;
  }

  /** Ce que `NavModel` a besoin de savoir des vues ENREGISTRÉES (sous-ensemble de `ShellView`).
      `hasCount` dit seulement que la vue DÉCLARE un compteur : la VALEUR reste lue ici, au rendu. */
  private navViewDecls(): NavViewDecl[] {
    const out: NavViewDecl[] = [];
    this.views.forEach((v, name) => out.push({ name, label: v.def.label, icon: v.def.icon, hasCount: !!v.def.count }));
    return out;
  }

  /** Structure du menu RÉSOLUE pour les droits COURANTS (les prédicats `visible` sont relus à chaque appel). */
  private resolveNav(): ResolvedNav {
    return NavModel.resolve(NAV_DOMAINS, this.navViewDecls(), (name) => this.isViewVisible(name));
  }

  /** Construit le menu (niveaux 1 et 2) et toutes les en-têtes de vue. À appeler après tous les addView. */
  build(): void {
    this.conditionalActions = [];                        // réenregistrés par buildHeader (les anciens boutons partent avec l'en-tête)
    this.navSignature = "";                              // force une reconstruction complète des barres
    this.views.forEach((v) => this.buildHeader(v));      // en-têtes de vue (fil d'Ariane + actions)
    this.refreshCounts();                                // → renderNav() peint les deux barres
  }

  /* ============================================================================
     RENDU DU MENU — deux barres, une seule vérité (`NavModel`).
     ============================================================================ */

  /** SIGNATURE de la structure résolue : domaines × vues × aplatissement. Deux structures de même
      signature se peignent à l'identique, donc rien à reconstruire. */
  private static signatureOf(nav: ResolvedNav): string {
    return (nav.flattened ? "flat|" : "") + nav.domains.map((d) => d.name + ">" + d.views.map((v) => v.name).join(",")).join(";");
  }

  /** Recalcule la structure et met les barres en phase. Appelée par `refreshCounts()`, donc à chaque
      bascule de vue, rafraîchissement et changement de droits — d'où la reconstruction CONDITIONNELLE
      (cf. `navSignature`) : reconstruire le DOM à chaque appel volerait le focus clavier. */
  private renderNav(): void {
    this.nav = this.resolveNav();
    const signature = Shell.signatureOf(this.nav);
    const structureChanged = signature !== this.navSignature;
    if (structureChanged) { this.navSignature = signature; this.buildDomainBar(); this.viewsBarDomain = null; }
    // Domaine ACTIF = celui de la vue courante ; à défaut (aucune vue active encore, ou vue rattachée à
    // rien) le premier domaine visible — la barre de vues ne reste jamais vide sans raison.
    const active = this.activeDomainName();
    if (structureChanged || active !== this.viewsBarDomain) { this.viewsBarDomain = active; this.buildViewsBar(); }
    this.applyNavActive();
  }

  /** Nom du domaine à surligner / dont peindre la barre de vues (null si plus aucun domaine visible). */
  private activeDomainName(): string | null {
    const current = this.current;
    if (current) {
      const direct = NavModel.activeDomain(current, this.nav);
      if (direct) return direct;
      // REPLI : la vue active n'est rattachée à aucun domaine visible — anomalie que le verrou
      // d'exhaustivité de `NavModel` interdit, mais que le rendu doit traverser sans planter. On se
      // rabat sur le domaine de sa vue PARENTE historique (`ShellNav.activeTab`), qui reste déclarée.
      const def = this.views.get(current)?.def;
      if (def) {
        const viaParent = NavModel.activeDomain(ShellNav.activeTab(def), this.nav);
        if (viaParent) return viaParent;
      }
    }
    return this.nav.domains[0] ? this.nav.domains[0].name : null;
  }

  /** BARRE DE NIVEAU 1. Nominalement les DOMAINES (icône + libellé TOUJOURS visible — la maquette
      tranche « libellés > icônes » : l'icône seule n'est plus le régime normal, elle ne revient que
      sous ~1000 px, par le CSS). Quand un SEUL domaine est visible (`flattened`), le niveau 1 s'efface
      et ce sont ses VUES qu'on peint ici : un utilisateur à droits réduits ne doit pas se voir imposer
      un niveau de menu qui n'offre aucun choix. */
  private buildDomainBar(): void {
    this.tabsEl.innerHTML = "";
    this.badgesLevel1 = [];
    if (this.nav.flattened) {
      // 🚨 Ce sont des VUES : elles sont terminales, leur badge est licite — on LIT `v.badge`.
      for (const view of this.nav.domains[0].views) this.tabsEl.appendChild(this.buildLevel1Button(view.label, view.icon, () => this.switchView(view.name), view.name, view.badge, this.badgesLevel1));
      return;
    }
    for (const domain of this.nav.domains) {
      // Cliquer un DOMAINE n'ouvre pas une « vue domaine » (il n'y en a pas) : il active sa PREMIÈRE
      // VUE VISIBLE — piège ① de l'ancien `kind:"group"`, qui déroulait sans jamais naviguer.
      const first = domain.views[0];
      // 🚨 Règle (A) : `domain.badge` vaut FAUX par construction (un domaine a des enfants). On le lit
      // quand même plutôt que d'écrire `false` : la règle n'a qu'une source, et elle n'est pas ici.
      this.tabsEl.appendChild(this.buildLevel1Button(I18n.t(domain.label), domain.icon, () => this.switchView(first.name), domain.name, domain.badge, this.badgesLevel1));
    }
  }

  /** Bouton de la barre de niveau 1 (domaine ou, en régime aplati, vue). `key` = nom porté par
      `data-nav`, utilisé par `applyNavActive` pour poser l'état actif sans reconstruire. */
  private buildLevel1Button(label: string, iconName: string | undefined, onClick: () => void, key: string, badge: boolean, registry: Array<{ name: string; el: HTMLElement }>): HTMLButtonElement {
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "tab tab-domain"; btn.dataset.nav = key;
    // Deux provenances d'icône, volontairement distinguées par leur FORME plutôt que par un drapeau :
    // un DOMAINE porte le NOM d'une constante (`NAV_DOMAINS`, module pur — il ne peut pas importer le
    // registre), une VUE porte le SVG déjà résolu par `main.ts`. Un nom inconnu rend "" (pastille sans
    // glyphe) au lieu d'écrire le nom en clair dans le DOM.
    const icon = iconName && iconName.startsWith("<svg") ? iconName : Icons.byName(iconName);
    if (icon) { const gi = document.createElement("span"); gi.className = "gi"; gi.setAttribute("aria-hidden", "true"); gi.innerHTML = icon; btn.appendChild(gi); }
    const text = document.createElement("span"); text.className = "tab-label"; text.textContent = label; btn.appendChild(text);
    // Le libellé est aussi porté en `title`/`aria-label` : sous ~1000 px le CSS masque `.tab-label` et
    // le bouton devient une icône nue — un bouton sans texte accessible serait muet aux lecteurs d'écran.
    btn.title = label; btn.setAttribute("aria-label", label);
    if (badge) { const el = document.createElement("span"); el.className = "tab-count"; btn.appendChild(el); registry.push({ name: key, el }); }
    btn.onclick = onClick;
    return btn;
  }

  /** BARRE DE NIVEAU 2 — les vues du domaine actif, en pastilles, séparateurs compris. C'est le pattern
      UNIQUE de sous-navigation : il remplace À LA FOIS l'ancien groupe déroulant « Paramètres » et les
      liens d'en-tête de toutes les autres sous-vues. Masquée quand elle n'a rien à dire : domaine
      `direct` (une seule vue) ou structure `flattened` (les vues sont déjà au niveau 1). */
  private buildViewsBar(): void {
    this.viewsBarEl.innerHTML = "";
    this.badgesLevel2 = [];
    const domain = this.nav.flattened ? null : this.nav.domains.find((d) => d.name === this.viewsBarDomain);
    if (!domain || domain.direct) { this.viewsBarEl.style.display = "none"; return; }
    this.viewsBarEl.style.display = "";
    for (const view of domain.views) {
      // Séparateur : regroupement visuel INTERNE au domaine (ex. `… | VMs · Clusters | Wifi`). Jamais en
      // tête de barre — `NavModel` l'a déjà normalisé, on se contente de le peindre.
      if (view.separatorBefore) { const sep = document.createElement("i"); sep.className = "view-sep"; sep.setAttribute("aria-hidden", "true"); this.viewsBarEl.appendChild(sep); }
      this.viewsBarEl.appendChild(this.buildViewPill(view));
    }
    // Navigation CLAVIER d'un `role="tablist"` : ←/→ pour parcourir, Origine/Fin pour les extrémités.
    this.viewsBarEl.onkeydown = (e: KeyboardEvent) => this.onViewsBarKey(e);
  }

  private buildViewPill(view: ResolvedNavView): HTMLButtonElement {
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "view-tab"; btn.dataset.nav = view.name;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-controls", "view-" + view.name);
    const text = document.createElement("span"); text.textContent = view.label; btn.appendChild(text);
    // 🚨 Règle (A) : `view.badge` — une vue est terminale, son badge est licite. Aucune condition maison.
    if (view.badge) { const el = document.createElement("span"); el.className = "tab-count"; btn.appendChild(el); this.badgesLevel2.push({ name: view.name, el }); }
    btn.onclick = () => this.switchView(view.name);
    return btn;
  }

  /** Parcours clavier de la barre de vues (contrat ARIA d'un `tablist` horizontal). */
  private onViewsBarKey(e: KeyboardEvent): void {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const pills = Array.from(this.viewsBarEl.querySelectorAll<HTMLButtonElement>(".view-tab"));
    if (!pills.length) return;
    const at = pills.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0
      : e.key === "End" ? pills.length - 1
      : e.key === "ArrowLeft" ? (at <= 0 ? pills.length - 1 : at - 1)
      : (at < 0 || at >= pills.length - 1 ? 0 : at + 1);
    e.preventDefault();
    pills[next].focus();
    pills[next].click();   // activation SUIVANT le focus : c'est le comportement attendu d'un tablist simple
  }

  /** Pose l'état ACTIF sur les deux barres (sans rien reconstruire) + la classe de section. */
  private applyNavActive(): void {
    const domain = this.activeDomainName();
    // Niveau 1 : en régime aplati les boutons portent des NOMS DE VUE (c'est la vue courante qu'on
    // surligne) ; sinon des noms de DOMAINE.
    const level1Key = this.nav.flattened ? this.current : domain;
    this.tabsEl.querySelectorAll<HTMLElement>(".tab").forEach((el) => {
      const on = !!level1Key && el.dataset.nav === level1Key;
      el.classList.toggle("active", on);
      if (on) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
    });
    this.viewsBarEl.querySelectorAll<HTMLElement>(".view-tab").forEach((el) => {
      const on = el.dataset.nav === this.current;
      el.classList.toggle("active", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
      // Un seul point d'entrée clavier dans le tablist (contrat ARIA) : seule la pastille active est tabulable.
      el.setAttribute("tabindex", on ? "0" : "-1");
    });
  }

  private buildHeader(v: ViewEntry): void {
    const def = v.def;
    v.header.innerHTML = "";
    const left = document.createElement("div");
    // FIL D'ARIANE « domaine › vue » (§ 02 de la maquette). Il REMPLACE le bouton « ← retour » : celui-ci
    // ne disait que « d'où je viens », alors que la barre de vues rend le retour trivial et que la vraie
    // question, sur une app à 28 vues, est « où suis-je ». Simple REPÈRE, non cliquable : le domaine n'est
    // pas une destination (il n'a pas de vue à lui — piège ①).
    const domain = NavModel.domainOf(def.name, NAV_DOMAINS);
    if (domain) {
      const decl = NAV_DOMAINS.find((d) => d.name === domain)!;
      const crumb = document.createElement("div"); crumb.className = "view-crumb";
      const dom = document.createElement("span"); dom.className = "view-crumb-domain"; dom.textContent = I18n.t(decl.label);
      const sep = document.createElement("span"); sep.className = "view-crumb-sep"; sep.setAttribute("aria-hidden", "true"); sep.textContent = I18n.t("shell.nav.crumbSeparator");
      const leaf = document.createElement("span"); leaf.textContent = def.label;
      crumb.append(dom, sep, leaf);
      left.appendChild(crumb);
    }
    const title = document.createElement("div"); title.className = "view-title";
    const caret = document.createElement("span"); caret.textContent = "▸"; title.append(caret, document.createTextNode(" " + (def.title || def.label)));
    left.appendChild(title);
    // Légendes d'onglet (sous-titres) RETIRÉES de l'UI : elles surchargeaient l'en-tête. Le `subtitle` reste
    // disponible dans la définition (documentation des vues) mais n'est plus affiché sous le titre.
    const acts = document.createElement("div"); acts.className = "view-actions";
    // ⚠ Ni bouton « ← retour », ni liens de sous-vues : la BARRE DE VUES (niveau 2) les remplace
    // intégralement (décision § 05-2 de la maquette — un seul mécanisme de sous-navigation).
    // boutons secondaires (ghost) — ex. « Ouvrir un fichier de faces »
    (def.extraActions || []).forEach((a) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost"; b.textContent = a.label; if (a.title) b.title = a.title;
      b.onclick = () => a.onClick(b); acts.appendChild(b);
      // Bouton CONDITIONNEL : enregistré pour être réévalué à chaque `refreshCounts()` (cf. ViewDef.extraActions).
      if (a.visible) this.conditionalActions.push({ el: b, visible: a.visible });
    });
    // bouton primaire « + … » — masquable par `canAdd` (droit de CRÉATION), via le MÊME registre que les
    // `extraActions` conditionnelles : un seul moment d'évaluation pour toutes les actions d'en-tête.
    if (def.onAdd) {
      const add = document.createElement("button"); add.type = "button"; add.className = "btn btn-primary"; add.textContent = def.addLabel || I18n.t("shell.header.addDefault"); add.onclick = () => def.onAdd!(); acts.appendChild(add);
      if (def.canAdd) this.conditionalActions.push({ el: add, visible: def.canAdd });
    }
    v.header.append(left, acts);
    if (!acts.children.length) v.header.style.alignItems = "center";
  }

  /** Cette vue est-elle ACCESSIBLE (prédicat `ViewDef.visible`) ? Une vue inconnue ne l'est pas. Un
      prédicat qui JETTE répond NON : le repli d'une garde d'accès se fait toujours du côté fermé
      (même politique que les `extraActions` conditionnelles, journalisée). */
  isViewVisible(name: string): boolean {
    const v = this.views.get(name);
    if (!v) return false;
    if (!v.def.visible) return true;
    try { return !!v.def.visible(); } catch (e) { console.error(e); return false; }
  }

  /** Première vue ACCESSIBLE — cible du repli. L'ordre de référence est celui du MENU (domaines puis
      vues, cf. `NAV_DOMAINS`), pas l'ordre d'enregistrement : le repli doit atterrir là où l'utilisateur
      s'attend à arriver, c'est-à-dire sur la première entrée qu'il VOIT.
      Repli du repli : une vue enregistrée mais rattachée à aucun domaine (anomalie interdite par le
      verrou d'exhaustivité) reste tout de même atteignable — mieux vaut une navigation étrange qu'une
      application vide.
      PUBLIQUE depuis le correctif « droits partiels » : l'hôte s'en sert pour la restauration de vue
      d'après-droits (`core/ViewRestoration`), qui pose la MÊME question que le repli interne. */
  firstVisibleView(): string | null {
    const first = NavModel.firstVisibleView(this.resolveNav());
    if (first) return first;
    return this.order.find((nm) => this.views.has(nm) && this.isViewVisible(nm)) || null;
  }

  /** REPLI : l'onglet actif vient d'être masqué (droits retirés à chaud, ou bascule de politique) → on
      bascule sur la première vue accessible. Aucune vue accessible ⇒ on ne fait RIEN : c'est l'écran
      « aucun accès » (overlay d'accueil) qui couvre alors l'application. */
  private fallbackIfHidden(): void {
    if (this.fallbackInProgress || !this.current || this.isViewVisible(this.current)) return;
    const fallback = this.firstVisibleView();
    if (!fallback || fallback === this.current) return;
    this.fallbackInProgress = true;
    try { this.switchView(fallback); } finally { this.fallbackInProgress = false; }
  }

  switchView(name: string): void {
    if (!this.views.has(name)) return;   // seules les VUES naviguent ; un DOMAINE n'est pas dans this.views (piège ①)
    // Vue MASQUÉE (droit de lecture absent) : on ne l'affiche pas — on se replie sur la première vue
    // accessible. Le cas se produit aussi bien sur un #hash bookmarké que sur une navigation
    // programmatique (« Localiser » vers le Datacenter, retour après ouverture d'un document). Aucune
    // vue accessible ⇒ on n'active RIEN (l'écran « aucun accès » couvre l'app).
    if (!this.isViewVisible(name)) {
      const fallback = this.firstVisibleView();
      if (!fallback || fallback === name) return;
      name = fallback;
    }
    this.current = name;
    const active = this.views.get(name)!;
    this.views.forEach((v, n) => { v.section.classList.toggle("active", n === name); });
    // Le TIROIR se ferme sur toute navigation, y compris programmatique (« Localiser en 3D » depuis une
    // fiche, retour d'un deep-link) : un panneau resté ouvert par-dessus la vue qu'on vient d'ouvrir est
    // le défaut classique des menus mobiles.
    this.drawer.close();
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

  /** Valeur + teinte du badge d'une vue, ou null s'il n'y a RIEN à peindre (pas de `count()`, ou compte
      à 0 — pas de pastille « 0 » : c'est du bruit, jamais une alerte). Point de lecture UNIQUE du
      comptage : les deux barres et le tiroir passent tous par ici. */
  private badgeValue(name: string): { count: number; tone: string | null } | null {
    const v = this.views.get(name);
    if (!v || !v.def.count) return null;
    let n = 0;
    try { n = v.def.count(); } catch (e) { console.error(e); return null; }
    if (!(n > 0)) return null;
    let tone: string | null = null;
    if (v.def.countClass) { try { tone = v.def.countClass(); } catch (e) { console.error(e); } }
    return { count: n, tone };
  }

  /** Met le menu et toutes les pastilles en phase : STRUCTURE (les droits peuvent avoir changé),
      compteurs, tiroir ouvert, boutons d'en-tête conditionnels — puis repli si la vue active vient
      d'être masquée. Appelée à chaque bascule d'onglet, rafraîchissement de vue et changement de droits :
      un seul moment d'évaluation pour tout ce qui est conditionnel. */
  refreshCounts(): void {
    // STRUCTURE d'abord : les pastilles qui suivent vivent dans des barres que `renderNav` peut venir
    // de reconstruire (une vue masquée disparaît de la structure, elle n'est plus « masquée après coup »).
    this.renderNav();
    [...this.badgesLevel1, ...this.badgesLevel2].forEach(({ name, el }) => {
      const badge = this.badgeValue(name);
      el.textContent = badge ? String(badge.count) : "";
      el.style.display = badge ? "" : "none";
      el.classList.toggle("warn", !!badge && badge.tone === "warn");
      el.classList.toggle("err", !!badge && badge.tone === "err");
    });
    this.drawer.refresh();   // no-op tiroir fermé
    // Boutons d'en-tête CONDITIONNELS : même moment d'évaluation que les pastilles (un prédicat qui
    // jette ne doit pas faire tomber le rafraîchissement → repli « masqué », journalisé).
    this.conditionalActions.forEach(({ el, visible }) => {
      let on = false;
      try { on = !!visible(); } catch (e) { console.error(e); }
      el.style.display = on ? "" : "none";
    });
    this.fallbackIfHidden();   // l'onglet actif vient-il d'être masqué ? (droits retirés à chaud)
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
  setUndoRedo(canUndo: boolean, canRedo: boolean): void {
    this.undoBtn.disabled = !canUndo; this.redoBtn.disabled = !canRedo;
    // Mémorisé : le PIED du tiroir responsive peint ses propres boutons annuler/rétablir et redemande
    // ces deux états (le Shell reste leur unique source).
    this.canUndoValue = canUndo; this.canRedoValue = canRedo;
    this.drawer.refresh();
  }
  /** Pastille d'état de sauvegarde : "mem" | "clean" | "dirty" | "dirty-on". */
  setSaveState(state: string): void {
    this.saveDot.className = "save-state-icon " + state;
    this.saveStateValue = state; this.drawer.refresh();   // l'en-tête du tiroir porte la MÊME pastille
    // bouton « Enregistrer » mis en évidence (`has-unsaved`) dès qu'il y a des modifications non enregistrées
    // (dirty ou dirty-on), comme la référence — pour signaler qu'un save est en attente même avec auto-save actif.
    if (this.saveBtn) this.saveBtn.classList.toggle("has-unsaved", state === "dirty" || state === "dirty-on");
  }
  /* ---- réglages : le Shell DÉLÈGUE au panneau (`app/SettingsPanel`) ----
     Ces méthodes restent sur le Shell parce que le bootstrap n'y voit qu'UN interlocuteur de chrome ;
     leur implémentation, elle, vit là où vivent les contrôles. Le corps du panneau existe en
     permanence (détaché entre deux ouvertures) : un reflet posé modale FERMÉE est donc bien pris. */
  setDataSource(value: string): void { this.settings.setDataSource(value); }
  setApiBaseUrl(url: string): void { this.settings.setApiBaseUrl(url); }
  setLoginUrl(url: string): void { this.settings.setLoginUrl(url); }
  setFileAccessMode(value: string): void { this.settings.setFileAccessMode(value); }
  setDebugLog(on: boolean): void { this.settings.setDebugLog(on); }
  setUiScale(v: number): void { this.settings.setUiScale(v); }
  setTheme(theme: string): void { this.settings.setTheme(theme); }
  setModalFullscreen(on: boolean): void { this.settings.setModalFullscreen(on); }
  setAutocompleteMax(v: number): void { this.settings.setAutocompleteMax(v); }
  /** Pastille utilisateur (mode API). `user` = objet SSO (login/nom/prénom/eMail…) ; null = non connecté ; undefined = masquer. */
  setUser(user: { name?: string; prenom?: string; nom?: string; login?: string; email?: string; eMail?: string } | null | undefined): void {
    if (!this.userChip) return;
    if (user === undefined) { this.userChip.style.display = "none"; this.userName = null; this.drawer.refresh(); return; }
    this.userChip.style.display = "";
    // L'ICÔNE est TOUJOURS présente ; le NOM vit dans un `.user-chip-name` que le CSS masque sous le
    // breakpoint responsive de la topbar (comme `.brand-name`/`.doc-name`) — reste alors l'icône seule,
    // le nom passant en title/aria-label (tooltip). Le clic ouvre la modale d'infos dans les deux cas.
    if (user) {
      const who = UserIdentity.displayName(user, I18n.t("shell.user.anonymous"));
      this.userChip.innerHTML = `<span class="gi">${Icons.USER}</span><span class="user-chip-name">${Html.escape(who)}</span>`;
      this.userChip.title = I18n.t("shell.user.connectedAs", { who }); this.userChip.setAttribute("aria-label", I18n.t("shell.user.connectedAs", { who }));
      this.userChip.classList.remove("user-chip--off");
      this.userName = who;
    } else {
      const label = I18n.t("shell.user.notConnected");
      this.userChip.innerHTML = `<span class="gi">${Icons.USER}</span><span class="user-chip-name">${Html.escape(label)}</span>`;
      this.userChip.title = I18n.t("shell.user.noSession"); this.userChip.setAttribute("aria-label", I18n.t("shell.user.noSession"));
      this.userChip.classList.add("user-chip--off");
      this.userName = null;
    }
    this.drawer.refresh();   // l'en-tête du tiroir affiche la MÊME identité
  }
  /** Mode API : masque Enregistrer/Enregistrer-sous + réglages fichier ; Nouveau/Ouvrir gèrent les documents serveur. */
  setRestMode(on: boolean): void {
    // Mémorisé pour le TIROIR : il n'affiche ni l'état de sauvegarde ni annuler/rétablir en mode API,
    // exactement comme la topbar et la barre de statut ci-dessous — même vérité, un seul drapeau.
    this.restMode = on; this.drawer.refresh();
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
    if (this.newBtn) this.newBtn.title = I18n.t("shell.topbar.new");
    if (this.openBtn) this.openBtn.title = on ? I18n.t("shell.topbar.docsOpen") : I18n.t("shell.topbar.open");
    this.settings.setRestMode(on);   // sections propres au mode FICHIER + position du toggle de source
  }
  /** Loupe de RECHERCHE GLOBALE : visible dès qu'il existe AU MOINS UNE lecture documentaire — la même règle
      que la garde serveur de `GET /search`, dont l'assiette est de toute façon restreinte à ce que l'appelant
      a le droit de lire (docs/auth.md § 8.3). Sans aucune lecture, la palette ne trouverait rien. */
  setGlobalSearchAllowed(on: boolean): void { if (this.searchBtn) this.searchBtn.style.display = on ? "" : "none"; }
  /** Bouton « Scanner une étiquette » : révélé quand une CAMÉRA existe et que le contexte permet
      `getUserMedia` (sonde async `ScanControl.globalAvailable` du bootstrap) — un poste fixe sans
      webcam ne voit jamais le bouton (cf. core/ScanAffordance). */
  setScanAvailable(on: boolean): void { if (this.scanBtn) this.scanBtn.style.display = on ? "" : "none"; }
  /** PANIER : révèle (ou masque) l'entrée de topbar — cf. `ShellHost.onCart` et docs/panier.md. */
  setCartAvailable(on: boolean): void { if (this.cartBtn) this.cartBtn.style.display = on ? "" : "none"; }
  /** PANIER : pastille de comptage. Zéro = pastille ABSENTE (un « 0 » permanent serait du bruit). */
  setCartCount(count: number): void {
    if (!this.cartBadge) return;
    this.cartBadge.textContent = String(count);
    this.cartBadge.hidden = count <= 0;
  }
  /** Reflète les préférences de scan dans les bascules des réglages (sans déclencher les rappels). */
  setScanPrefs(allFields: boolean, force: boolean): void { this.settings.setScanPrefs(allFields, force); }
  /** Bouton « Nouveau » de la topbar : en mode API il CRÉE un document serveur (`documents:manage`) ; en mode
      fichier il repart d'un document local, et l'état « tout permis » le laisse visible (injection nulle). */
  setNewDocumentAllowed(on: boolean): void { if (this.newBtn) this.newBtn.style.display = on ? "" : "none"; }
  /** Section « Maintenance » des Réglages (purge des binaires orphelins + compactage) : geste
      d'ADMINISTRATION, masqué sans la permission `maintenance:run` (cf. docs/auth.md § « Gating côté client »). En mode
      FICHIER la purge est purement locale et l'état d'autorisation « tout permis » la laisse visible —
      injection nulle, aucun test de mode ici. */
  setMaintenanceAllowed(on: boolean): void { this.settings.setMaintenanceAllowed(on); }
  /** Section « Export » des Réglages (JSON autonome + visualiseur HTML) : les deux portent le
      document ENTIER, et sous droits partiels le cache ne le contient PLUS (l'assiette de chargement est
      intersectée avec le lisible, cf. docs/auth.md § 10.6). Un export y serait une copie silencieusement
      AMPUTÉE — donc masqué, jamais proposé puis tronqué. En mode FICHIER, « tout permis » le laisse
      visible : injection nulle, aucun test de mode ici. */
  setExportAllowed(on: boolean): void { this.settings.setExportAllowed(on); }
  /** Reflète l'état auto-save dans les Réglages (case + fréquence). */
  setAutosave(on: boolean, interval: number): void { this.settings.setAutosave(on, interval); }
  setAutosaveStatus(html: string): void { this.settings.setAutosaveStatus(html); }
}
