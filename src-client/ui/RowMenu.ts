/* Menu « plus d'actions » (overflow) ancré sous un bouton ⋮ d'une ligne de listing. Un seul menu ouvert à la
   fois ; fermeture au clic extérieur / Échap / scroll / resize. Inspiré du mécanisme `openRowMenu` de l'app Compta
   (listing des dépenses) — généralisé en items déclaratifs. Positionné en `position:fixed` (coordonnées viewport),
   bascule au-dessus du trigger s'il manque de place en bas.
   La RÈGLE DE PLACEMENT vit dans le module pur `core/FloatPlacement` (cadrage C §2.2) — doctrine au scroll :
   surface TRANSITOIRE, le menu FERME au scroll (son ancre a défilé, le contexte du geste est perdu) au lieu de
   suivre comme les surfaces ancrées à un champ (SearchPop portail, autocomplétion). */
import { FloatPlacement } from "../core/FloatPlacement";

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
    /* La GÉOMÉTRIE vit dans `core/FloatPlacement` (cadrage C §2.2) — ici, mesure + pose des styles.
       Paramétrage historique de ce menu : aligné à la DROITE du déclencheur (`end` — le ⋮ vit en
       bout de ligne, le menu se déploie vers la gauche), bascule au SIMPLE débordement bas
       (`above: "always"` : un menu court trouve toujours sa place dessus, et `marginV: 8` borne le
       haut basculé — c'est aussi la marge du test de débordement), recadrage horizontal marge 8. */
    const placed = FloatPlacement.anchored(
      trigger.getBoundingClientRect(),
      { width: menu.offsetWidth, height: menu.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      { align: "end", marginV: 8, flip: { above: "always" } },
    );
    menu.style.top = placed.top + "px"; menu.style.left = placed.left + "px";
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
