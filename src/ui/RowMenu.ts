/* Menu « plus d'actions » (overflow) ancré sous un bouton ⋮ d'une ligne de listing. Un seul menu ouvert à la
   fois ; fermeture au clic extérieur / Échap / scroll / resize. Inspiré du mécanisme `openRowMenu` de l'app Compta
   (listing des dépenses) — généralisé en items déclaratifs. Positionné en `position:fixed` (coordonnées viewport),
   bascule au-dessus du trigger s'il manque de place en bas. */
export interface RowMenuItem {
  label: string;
  icon?: string;        // HTML court (emoji ou <svg> inline)
  danger?: boolean;     // teinte « danger » au survol (suppression…)
  disabled?: boolean;
  title?: string;       // tooltip (ex. raison du grisé)
  onClick: () => void;
}

export class RowMenu {
  private static el: HTMLElement | null = null;
  private static trigger: HTMLElement | null = null;
  private static cleanup: (() => void) | null = null;

  /** Ferme le menu courant (le cas échéant) et démonte ses écouteurs. */
  static close(): void {
    if (this.el) { this.el.remove(); this.el = null; }
    if (this.trigger) { this.trigger.setAttribute("aria-expanded", "false"); this.trigger = null; }
    if (this.cleanup) { this.cleanup(); this.cleanup = null; }
  }

  /** Ouvre un menu ancré sous `trigger`. Un second appel sur le MÊME trigger le referme (toggle). */
  static open(trigger: HTMLElement, items: RowMenuItem[]): void {
    if (this.trigger === trigger) { this.close(); return; }
    this.close();
    const menu = document.createElement("div");
    menu.className = "row-menu"; menu.setAttribute("role", "menu");
    items.forEach((it) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "row-menu-item" + (it.danger ? " row-menu-danger" : "");
      b.setAttribute("role", "menuitem");
      if (it.disabled) { b.setAttribute("disabled", ""); b.setAttribute("aria-disabled", "true"); }
      if (it.title) b.title = it.title;
      b.innerHTML = (it.icon ? `<span class="row-menu-ic">${it.icon}</span>` : "") + RowMenu.escape(it.label);
      b.onclick = () => { if (b.hasAttribute("disabled")) return; RowMenu.close(); it.onClick(); };
      menu.appendChild(b);
    });
    RowMenu.mount(menu, trigger);
  }

  private static escape(s: string): string { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  private static mount(menu: HTMLElement, trigger: HTMLElement): void {
    document.body.appendChild(menu);
    const rect = trigger.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight, vpH = window.innerHeight, vpW = window.innerWidth;
    let top = rect.bottom + 4; if (top + mh > vpH - 8) top = Math.max(8, rect.top - mh - 4);   // bascule au-dessus si déborde en bas
    let left = rect.right - mw; if (left < 8) left = 8; if (left + mw > vpW - 8) left = vpW - mw - 8;
    menu.style.top = top + "px"; menu.style.left = left + "px";
    trigger.setAttribute("aria-expanded", "true");
    this.el = menu; this.trigger = trigger;
    const onDoc = (e: Event) => { if (!menu.contains(e.target as Node) && e.target !== trigger) RowMenu.close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") RowMenu.close(); };
    const onScrollResize = () => RowMenu.close();
    setTimeout(() => document.addEventListener("click", onDoc), 0);   // évite d'attraper le clic d'ouverture
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScrollResize, true);
    window.addEventListener("resize", onScrollResize);
    this.cleanup = () => {
      document.removeEventListener("click", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScrollResize, true);
      window.removeEventListener("resize", onScrollResize);
    };
  }
}
