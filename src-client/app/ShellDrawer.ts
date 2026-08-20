/* =============================================================================
   ShellDrawer — TIROIR DE NAVIGATION responsive (menu à deux niveaux, § 03 de la
   maquette `design-system/briefs/menu-app-redesign-maquette.html`).
   -----------------------------------------------------------------------------
   Il REMPLACE l'ancien menu déroulant APLATI, dont le défaut était structurel :
   les sous-vues des onglets primaires (Groupes, Spares, Sous-équipements,
   Applications, Pièces jointes, Images de façade) n'y figuraient NULLE PART — on
   ne pouvait les atteindre qu'en passant par leur vue parente, donc en connaissant
   déjà le chemin. Ici, UN ACCORDÉON PAR DOMAINE contient TOUTES ses vues visibles.

   POURQUOI UNE CLASSE À PART (principe n°2). `Shell.ts` est déjà un monolithe :
   on n'y empile pas un panneau complet avec son voile, ses accordéons, son piège
   à Échap et son pied d'actions. Le tiroir est un composant à responsabilité
   identifiable, couplé au Shell par une INTERFACE INJECTÉE (`ShellDrawerHost`) —
   même patron que `PositioningTool`/`PositioningHost`. Il ne lit ni le Store, ni
   les droits, ni le registre des vues : il reçoit la structure DÉJÀ RÉSOLUE par
   `app/NavModel` (module pur) et se contente de la PEINDRE.

   🚨 RÈGLE (A) — LES COMPTEURS NE VIVENT QUE SUR LES ENTRÉES TERMINALES. Le
   tiroir peint un badge sur les VUES et JAMAIS sur un en-tête d'accordéon (qui est
   un domaine, donc une entrée à enfants) ni sur le bouton burger. La maquette
   proposait l'inverse (« badges qui remontent ») ; la décision utilisateur du
   2026-08-20 tranche contre elle. Cette classe n'a AUCUNE condition de ce genre à
   écrire : elle LIT le booléen `badge` que `NavModel` a calculé (cf. docs/navigation.md § 3).
   ============================================================================= */

import { Icons } from "../ui/Icons";
import { Html } from "../core/Html";
import { I18n } from "../i18n/I18n";
import type { ResolvedNav, ResolvedNavDomain } from "./NavModel";
import { NavModel } from "./NavModel";

/** Ce que le tiroir a besoin de demander à son hôte (le Shell). AUCUN accès direct au Shell : le
    couplage passe par ce contrat, ce qui garde le tiroir remplaçable et le Shell inchangé. */
export interface ShellDrawerHost {
  /** Structure de navigation RÉSOLUE (domaines visibles ▸ leurs vues visibles) — cf. `NavModel.resolve`. */
  nav(): ResolvedNav;
  /** Vue actuellement active : surlignage de l'entrée + accordéon déplié à l'ouverture. */
  currentView(): string | null;
  /** Navigue vers une vue. Le tiroir se ferme de lui-même AVANT d'appeler (une navigation qui laisse
      le panneau ouvert par-dessus le résultat est le défaut classique des tiroirs mobiles). */
  goToView(name: string): void;
  /** Valeur + teinte du badge d'une vue, ou null si rien à peindre (pas de `count()`, ou compte à 0).
      Le tiroir ne SAIT PAS compter : il demande. */
  viewBadge(name: string): { count: number; tone: string | null } | null;
  /** Identité affichable de l'utilisateur connecté (null = aucune session / mode fichier). */
  userLabel(): string | null;
  /** Ouvre la modale d'INFOS UTILISATEUR — celle du lot R1 (`ShellHost.onUserInfo`), réutilisée telle
      quelle : le tiroir ne réinvente ni la modale, ni l'identité qu'elle affiche (principe n°14). */
  onUserInfo(): void;
  /** État de sauvegarde ("mem" | "clean" | "dirty" | "dirty-on") — pastille de l'en-tête du tiroir. */
  saveState(): string;
  /** L'état de sauvegarde a-t-il un SENS ? Faux en mode API (sauvegarde continue côté serveur : la barre
      de statut y est elle-même masquée) → la ligne disparaît au lieu d'afficher une vérité sans objet. */
  saveVisible(): boolean;
  /** Undo/redo du pied. `historyVisible()` est faux en mode API (aucun undo client — mêmes boutons
      masqués dans la topbar), auquel cas les deux boutons ne sont pas peints du tout. */
  historyVisible(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  onUndo(): void;
  onRedo(): void;
  /** Ouvre le panneau des RÉGLAGES (celui de la topbar — le tiroir délègue, il n'a pas de copie). */
  onSettings(): void;
}

export class ShellDrawer {
  private host: ShellDrawerHost;
  private root: HTMLElement;          // voile plein écran (clic = fermeture)
  private panel: HTMLElement;         // panneau latéral droit
  private headEl: HTMLElement;        // pastille utilisateur + nom + état de sauvegarde
  private bodyEl: HTMLElement;        // accordéons (reconstruits à chaque peinture)
  private footEl: HTMLElement;        // annuler / rétablir / réglages
  private open = false;
  /** Domaine dont l'accordéon est DÉPLIÉ. Mémorisé DANS la classe : la peinture reconstruit le corps,
      et sans cet état l'accordéon se refermerait à chaque rafraîchissement de compteur. */
  private openDomain: string | null = null;
  /** Élément qui avait le focus à l'ouverture (le burger, en pratique) : on le lui REND à la fermeture.
      Sans ça, refermer le tiroir renvoie le focus au `<body>` et la tabulation repart du haut de la page. */
  private focusBeforeOpen: HTMLElement | null = null;
  /** Écouteur Échap posé UNIQUEMENT pendant l'ouverture (un écouteur global permanent intercepterait
      la touche pour les modales, qui ont leur propre pile). */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.open) { e.stopPropagation(); this.close(); }
  };

  constructor(host: ShellDrawerHost) {
    this.host = host;

    this.root = document.createElement("div");
    // `topbar-needs-doc` : neutralisé tant que l'écran d'accueil est affiché (aucun document ouvert) —
    // sinon on pourrait naviguer depuis le tiroir dans une app SANS document (cf. body.welcome-active).
    this.root.className = "nav-drawer topbar-needs-doc";
    this.root.style.display = "none";
    // Clic sur le VOILE (et non sur le panneau) = fermeture au doigt, geste attendu d'un tiroir mobile.
    this.root.addEventListener("click", (e) => { if (e.target === this.root) this.close(); });

    this.panel = document.createElement("div"); this.panel.className = "nav-drawer-panel";
    this.panel.setAttribute("role", "dialog"); this.panel.setAttribute("aria-modal", "true");
    this.panel.setAttribute("aria-label", I18n.t("shell.nav.menu"));

    this.headEl = document.createElement("div"); this.headEl.className = "nav-drawer-head";
    this.bodyEl = document.createElement("div"); this.bodyEl.className = "nav-drawer-body";
    this.footEl = document.createElement("div"); this.footEl.className = "nav-drawer-foot";
    this.panel.append(this.headEl, this.bodyEl, this.footEl);
    this.root.appendChild(this.panel);
  }

  /** Élément racine, à insérer par le Shell (hors topbar : le voile couvre l'écran entier). */
  get element(): HTMLElement { return this.root; }

  /** Le tiroir est-il ouvert ? (le Shell en a besoin pour ne rafraîchir que ce qui est visible). */
  get isOpen(): boolean { return this.open; }

  /** Ouvre le tiroir sur le domaine de la vue COURANTE (accordéon déplié) et pose le piège à Échap. */
  openDrawer(): void {
    if (this.open) return;
    this.open = true;
    this.focusBeforeOpen = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // L'accordéon déplié à l'ouverture est TOUJOURS celui de la vue active : le tiroir s'ouvre sur
    // « où je suis », jamais sur un état hérité d'une ouverture précédente devenue sans rapport.
    this.openDomain = NavModel.activeDomain(this.host.currentView() || "", this.host.nav());
    this.paint();
    this.root.style.display = "";
    document.addEventListener("keydown", this.onKeyDown, true);
    // Focus au premier élément navigable : le tiroir doit être utilisable AU CLAVIER, pas seulement au doigt.
    const first = this.panel.querySelector<HTMLElement>("button");
    if (first) first.focus();
  }

  /** Ferme le tiroir et retire le piège à Échap (jamais d'écouteur global qui survit à la fermeture). */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.root.style.display = "none";
    document.removeEventListener("keydown", this.onKeyDown, true);
    // Le focus revient d'où il venait — sauf si l'élément a disparu du document entre-temps
    // (reconstruction d'une barre), auquel cas on ne force rien plutôt que de le poser au hasard.
    const back = this.focusBeforeOpen; this.focusBeforeOpen = null;
    if (back && back.isConnected) back.focus();
  }

  toggle(): void { if (this.open) this.close(); else this.openDrawer(); }

  /** Re-peint le tiroir s'il est OUVERT (droits changés à chaud, compteur résolu, undo/redo…). Fermé,
      il n'y a rien à rafraîchir : la prochaine ouverture repart de la structure courante. */
  refresh(): void { if (this.open) this.paint(); }

  /* ------------------------------------------------------------------ peinture -- */

  private paint(): void {
    this.paintHead();
    this.paintBody();
    this.paintFoot();
  }

  /** En-tête : pastille utilisateur (→ modale d'infos du lot R1) + nom + état de sauvegarde + croix. */
  private paintHead(): void {
    this.headEl.innerHTML = "";
    const who = this.host.userLabel();
    // Pastille utilisateur : MÊME geste que la topbar (clic → modale d'infos). Bouton et non pastille
    // décorative — c'est une commande, elle doit être atteignable au clavier et annoncée comme telle.
    const user = document.createElement("button"); user.type = "button"; user.className = "nav-drawer-user";
    user.innerHTML = `<span class="gi" aria-hidden="true">${Icons.USER}</span>`;
    const label = who || I18n.t("shell.user.notConnected");
    user.title = I18n.t("shell.user.connectedAs", { who: label });
    user.setAttribute("aria-label", I18n.t("shell.user.connectedAs", { who: label }));
    user.onclick = () => { this.close(); this.host.onUserInfo(); };

    const who2 = document.createElement("div"); who2.className = "nav-drawer-who";
    const nameEl = document.createElement("div"); nameEl.className = "nav-drawer-name"; nameEl.textContent = label;
    who2.appendChild(nameEl);
    if (this.host.saveVisible()) {
      const state = this.host.saveState();
      const line = document.createElement("div"); line.className = "nav-drawer-save";
      const dot = document.createElement("span"); dot.className = "save-state-icon " + state;   // MÊME pastille que la barre de statut
      const txt = document.createElement("span");
      txt.textContent = I18n.t(state === "clean" ? "shell.save.clean" : state === "mem" ? "shell.save.mem" : "shell.save.dirty");
      line.append(dot, txt); who2.appendChild(line);
    }

    const close = document.createElement("button"); close.type = "button"; close.className = "nav-drawer-close";
    close.innerHTML = Icons.CLOSE;
    close.title = I18n.t("shell.nav.close"); close.setAttribute("aria-label", I18n.t("shell.nav.close"));
    close.onclick = () => this.close();

    this.headEl.append(user, who2, close);
  }

  /** Corps : UN ACCORDÉON PAR DOMAINE visible, contenant TOUTES ses vues visibles (sous-vues comprises). */
  private paintBody(): void {
    this.bodyEl.innerHTML = "";
    const nav = this.host.nav();
    const current = this.host.currentView();
    // Repli : si le domaine mémorisé a disparu (droits retirés), on déplie celui de la vue active,
    // sinon le premier — jamais un tiroir entièrement replié, qui n'offrirait aucune destination.
    let opened = this.openDomain;
    if (!opened || !nav.domains.some((d) => d.name === opened)) {
      opened = NavModel.activeDomain(current || "", nav) || (nav.domains[0] ? nav.domains[0].name : null);
      this.openDomain = opened;
    }

    for (const domain of nav.domains) {
      this.bodyEl.appendChild(this.buildAccordion(domain, domain.name === opened, current));
    }
  }

  private buildAccordion(domain: ResolvedNavDomain, expanded: boolean, current: string | null): HTMLElement {
    const acc = document.createElement("div"); acc.className = "nav-acc" + (expanded ? " open" : "");

    const head = document.createElement("button"); head.type = "button"; head.className = "nav-acc-head";
    head.dataset.domain = domain.name;   // repère de re-focalisation après repeinture (cf. onclick)
    head.setAttribute("aria-expanded", expanded ? "true" : "false");
    const icon = Icons.byName(domain.icon);
    // 🚨 Règle (A) : AUCUN badge ici — un en-tête d'accordéon EST un domaine, donc une entrée à enfants.
    // On ne l'écrit pas comme une condition : `domain.badge` vaut false par construction, et rien dans
    // ce gabarit ne peint de pastille.
    head.innerHTML = (icon ? `<span class="gi" aria-hidden="true">${icon}</span>` : "")
      + `<span class="nav-acc-label">${Html.escape(I18n.t(domain.label))}</span>`
      + `<span class="nav-acc-caret" aria-hidden="true">▾</span>`;
    head.onclick = () => {
      this.openDomain = acc.classList.contains("open") ? null : domain.name;
      this.paintBody();
      // La peinture a DÉTRUIT le bouton cliqué : on redonne le focus à son remplaçant, sinon un
      // utilisateur au clavier repart du début du tiroir à chaque dépliage.
      const again = this.bodyEl.querySelector<HTMLElement>(`.nav-acc-head[data-domain="${domain.name}"]`);
      if (again) again.focus();
    };

    const body = document.createElement("div"); body.className = "nav-acc-body";
    for (const view of domain.views) {
      const item = document.createElement("button"); item.type = "button"; item.className = "nav-acc-item";
      if (view.name === current) { item.classList.add("active"); item.setAttribute("aria-current", "page"); }
      const label = document.createElement("span"); label.className = "nav-acc-item-label"; label.textContent = view.label;
      item.appendChild(label);
      // Badge : autorisé sur une VUE (entrée terminale). On LIT `view.badge`, on ne le décide pas.
      if (view.badge) {
        const badge = this.host.viewBadge(view.name);
        if (badge) {
          const el = document.createElement("span");
          el.className = "tab-count" + (badge.tone === "warn" ? " warn" : badge.tone === "err" ? " err" : "");
          el.textContent = String(badge.count);
          item.appendChild(el);
        }
      }
      // La navigation FERME d'abord : sinon le panneau resterait posé sur la vue qu'on vient d'ouvrir.
      item.onclick = () => { this.close(); this.host.goToView(view.name); };
      body.appendChild(item);
    }

    acc.append(head, body);
    return acc;
  }

  /** Pied : annuler · rétablir · réglages (§ 03 de la maquette). */
  private paintFoot(): void {
    this.footEl.innerHTML = "";
    const ghost = (label: string, onClick: () => void, disabled?: boolean): HTMLButtonElement => {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-ghost btn-sm nav-drawer-act";
      b.textContent = label; b.disabled = !!disabled; b.onclick = onClick;
      return b;
    };
    if (this.host.historyVisible()) {
      this.footEl.append(
        ghost(I18n.t("shell.nav.undo"), () => { this.close(); this.host.onUndo(); }, !this.host.canUndo()),
        ghost(I18n.t("shell.nav.redo"), () => { this.close(); this.host.onRedo(); }, !this.host.canRedo()),
      );
    }
    // « Réglages » DÉLÈGUE au panneau de la topbar (qui reste affiché en responsive) : une seule
    // implémentation des réglages, jamais une copie dans le tiroir.
    this.footEl.appendChild(ghost(I18n.t("shell.settings.title"), () => { this.close(); this.host.onSettings(); }));
  }
}
