import { Fullscreen } from "./Fullscreen";

export interface CtxItem { label: string; danger?: boolean; action: () => void; }
export interface CtxSection { head?: string; items: CtxItem[]; }

/* Menu contextuel (clic droit) partagé, auto-construit. Sections séparées par un
   trait, items = boutons (option `danger`). Se ferme au clic ailleurs / Échap.
   Remplace la fonction libre `buildContextMenu` + l'élément #graph-context-menu. */
export class ContextMenu {
  private static el: HTMLElement | null = null;

  private static ensure(): HTMLElement {
    if (!ContextMenu.el || !document.contains(ContextMenu.el)) {
      const m = document.createElement("div");
      m.className = "graph-ctx";
      document.body.appendChild(m);
      ContextMenu.el = m;
      document.addEventListener("click", () => ContextMenu.hide());
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") ContextMenu.hide(); });
    }
    Fullscreen.home(ContextMenu.el);   // plein écran : dans l'élément FS courant (sinon <body>)
    return ContextMenu.el;
  }

  static show(clientX: number, clientY: number, sections: CtxSection[]): void {
    const m = ContextMenu.ensure();
    m.innerHTML = "";
    sections.forEach((sec, si) => {
      if (si > 0) { const s = document.createElement("div"); s.className = "ctx-sep"; m.appendChild(s); }
      if (sec.head) { const h = document.createElement("div"); h.className = "ctx-head"; h.textContent = sec.head; m.appendChild(h); }
      sec.items.forEach((it) => {
        const b = document.createElement("button");
        b.textContent = it.label; if (it.danger) b.className = "danger";
        b.onclick = (e) => { e.stopPropagation(); ContextMenu.hide(); it.action(); };
        m.appendChild(b);
      });
    });
    m.style.left = clientX + "px"; m.style.top = clientY + "px"; m.classList.add("open");
    const r = m.getBoundingClientRect();
    if (r.right > window.innerWidth) m.style.left = Math.max(4, clientX - r.width) + "px";
    if (r.bottom > window.innerHeight) m.style.top = Math.max(4, clientY - r.height) + "px";
  }

  static hide(): void { if (ContextMenu.el) ContextMenu.el.classList.remove("open"); }
}
