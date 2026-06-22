/** Définition d'une vue enregistrée dans le shell. */
export interface ShellView {
  /** Nom logique (→ id du conteneur « view-<name> », dataset.view de l'onglet). */
  name: string;
  /** Libellé de l'onglet. */
  label: string;
  /** Appelé à chaque activation de la vue (rendu/rafraîchissement). */
  onShow?: (container: HTMLElement) => void;
}

/* =============================================================================
   SHELL — ossature de l'application : en-tête + onglets + conteneurs de vue,
   et la NAVIGATION (switchView) qui bascule la classe `.active` et déclenche le
   rendu de la vue. Remplace le markup `<body>` + la fonction libre `switchView`.
   Les vues s'enregistrent (`addView`) et reçoivent leur conteneur DOM.
   ============================================================================= */
export class Shell {
  private tabsEl: HTMLElement;
  private mainEl: HTMLElement;
  private views = new Map<string, { def: ShellView; container: HTMLElement; tab: HTMLButtonElement }>();
  current: string | null = null;

  constructor(root: HTMLElement) {
    root.innerHTML = "";
    root.style.cssText = "display:flex;flex-direction:column;min-height:100vh;position:relative;z-index:1";

    const header = document.createElement("header");
    header.className = "app-header";
    const brand = document.createElement("div");
    brand.className = "app-brand";
    brand.textContent = "NETMAP";
    brand.style.cssText = "font-weight:700;letter-spacing:.08em;color:var(--accent);margin-right:16px";
    const tabs = document.createElement("nav");
    tabs.className = "tabs"; tabs.id = "tabs";
    header.appendChild(brand); header.appendChild(tabs);

    const main = document.createElement("main");
    main.style.cssText = "flex:1 1 auto;min-height:0;display:flex;flex-direction:column";

    root.appendChild(header); root.appendChild(main);
    this.tabsEl = tabs; this.mainEl = main;
  }

  /** Enregistre une vue : crée son onglet + son conteneur, renvoie le conteneur. */
  addView(def: ShellView): HTMLElement {
    const tab = document.createElement("button");
    tab.type = "button"; tab.className = "tab"; tab.dataset.view = def.name; tab.textContent = def.label;
    tab.onclick = () => this.switchView(def.name);
    this.tabsEl.appendChild(tab);

    const container = document.createElement("section");
    container.className = "view"; container.id = "view-" + def.name;
    this.mainEl.appendChild(container);

    this.views.set(def.name, { def, container, tab });
    return container;
  }

  /** Bascule sur la vue `name` : (dés)active onglets/conteneurs puis rend la vue. */
  switchView(name: string): void {
    if (!this.views.has(name)) return;
    this.current = name;
    this.views.forEach((v, n) => {
      v.tab.classList.toggle("active", n === name);
      v.container.classList.toggle("active", n === name);
    });
    const v = this.views.get(name)!;
    if (v.def.onShow) { try { v.def.onShow(v.container); } catch (e) { console.error(e); } }
  }
}
