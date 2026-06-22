/** Définition d'une vue enregistrée dans le shell. */
export interface ShellView {
  /** Nom logique (→ id du conteneur « view-<name> »). */
  name: string;
  /** Libellé de l'onglet / bouton. */
  label: string;
  /** "primary" = onglet principal · "secondary" = bouton de sous-vue. */
  kind?: "primary" | "secondary";
  /** Onglet principal à surligner quand cette (sous-)vue est active. */
  parent?: string;
  /** Compteur affiché en badge (collection associée). */
  count?: () => number;
  /** Appelé à chaque activation (rendu / rafraîchissement). */
  onShow?: (container: HTMLElement) => void;
}

/* =============================================================================
   SHELL — ossature : en-tête + onglets PRINCIPAUX + barre de SOUS-VUES +
   conteneurs de vue, et la navigation (switchView). Reproduit la structure de
   l'original : un jeu d'onglets principaux (Équipements par défaut) et des
   sous-vues secondaires qui surlignent leur onglet parent. Badges de comptage.
   ============================================================================= */
export class Shell {
  private tabsEl: HTMLElement;     // onglets principaux
  private subEl: HTMLElement;      // sous-vues (boutons secondaires)
  private mainEl: HTMLElement;
  private views = new Map<string, { def: ShellView; container: HTMLElement; btn: HTMLButtonElement }>();
  current: string | null = null;

  constructor(root: HTMLElement) {
    root.innerHTML = "";
    root.style.cssText = "display:flex;flex-direction:column;min-height:100vh;position:relative;z-index:1";

    const header = document.createElement("header");
    header.className = "app-header";
    const brand = document.createElement("div");
    brand.className = "app-brand"; brand.textContent = "NETMAP";
    brand.style.cssText = "font-weight:700;letter-spacing:.08em;color:var(--accent);margin-right:16px";
    const tabs = document.createElement("nav"); tabs.className = "tabs"; tabs.id = "tabs";
    const theme = document.createElement("button");
    theme.type = "button"; theme.className = "btn btn-ghost btn-sm"; theme.title = "Basculer le thème"; theme.textContent = "☾"; theme.style.marginLeft = "auto";
    theme.onclick = () => {
      const light = document.documentElement.getAttribute("data-theme") === "light";
      if (light) { document.documentElement.removeAttribute("data-theme"); theme.textContent = "☾"; }
      else { document.documentElement.setAttribute("data-theme", "light"); theme.textContent = "☀"; }
    };
    header.appendChild(brand); header.appendChild(tabs); header.appendChild(theme);

    // barre de sous-vues (secondaires)
    const sub = document.createElement("div");
    sub.className = "subtabs";
    sub.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:4px 8px;border-bottom:1px solid var(--line);background:var(--bg-2)";

    const main = document.createElement("main");
    main.style.cssText = "flex:1 1 auto;min-height:0;display:flex;flex-direction:column";

    root.appendChild(header); root.appendChild(sub); root.appendChild(main);
    this.tabsEl = tabs; this.subEl = sub; this.mainEl = main;
  }

  addView(def: ShellView): HTMLElement {
    const secondary = def.kind === "secondary";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = secondary ? "btn btn-ghost btn-sm" : "tab";
    btn.dataset.view = def.name;
    btn.innerHTML = def.label + (def.count ? ' <span class="tab-count">0</span>' : "");
    btn.onclick = () => this.switchView(def.name);
    (secondary ? this.subEl : this.tabsEl).appendChild(btn);

    const container = document.createElement("section");
    container.className = "view"; container.id = "view-" + def.name;
    this.mainEl.appendChild(container);

    this.views.set(def.name, { def, container, btn });
    return container;
  }

  switchView(name: string): void {
    if (!this.views.has(name)) return;
    this.current = name;
    const active = this.views.get(name)!;
    const activeTab = active.def.parent || name;
    this.views.forEach((v, n) => {
      const on = v.def.kind === "secondary" ? (n === name) : (n === activeTab);
      v.btn.classList.toggle("active", on);
      v.container.classList.toggle("active", n === name);
    });
    if (active.def.onShow) { try { active.def.onShow(active.container); } catch (e) { console.error(e); } }
    this.refreshCounts();
  }

  /** Re-rend la vue active (cohérence inter-vues sur mutation du modèle). */
  refreshActive(): void {
    if (!this.current) return;
    const v = this.views.get(this.current);
    if (v && v.def.onShow) { try { v.def.onShow(v.container); } catch (e) { console.error(e); } }
    this.refreshCounts();
  }

  /** Met à jour les badges de comptage. */
  refreshCounts(): void {
    this.views.forEach((v) => {
      if (!v.def.count) return;
      const badge = v.btn.querySelector(".tab-count");
      if (badge) badge.textContent = String(v.def.count());
    });
  }
}
