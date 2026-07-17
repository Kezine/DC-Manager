import { Html } from "../core/Html";
import { I18n } from "../i18n/I18n";

export interface MultiItem { id: string; label: string; color?: string | null; }

let _wired = false;

/* Sélecteur MULTIPLE déroulant (cases à cocher) — filtre « Tous = aucun filtre ».
   Le set `selected` est muté en place ; `onChange` est appelé à chaque changement.
   Remplace la fonction libre `makeMultiSelect`. */
export class MultiSelect {
  /** Construit le composant (déclencheur + panneau) ; renvoie l'élément racine. */
  static build(labelTxt: string, items: MultiItem[], selected: Set<string>, onChange: () => void): HTMLElement {
    if (!_wired) {   // un clic ailleurs ferme tous les panneaux ouverts
      document.addEventListener("click", () => document.querySelectorAll(".multi-panel.open").forEach((p) => p.classList.remove("open")));
      _wired = true;
    }
    const pop = document.createElement("div"); pop.className = "multi-pop";
    const trigger = document.createElement("button"); trigger.type = "button"; trigger.className = "multi-trigger";
    const panel = document.createElement("div"); panel.className = "multi-panel";
    panel.addEventListener("click", (e) => e.stopPropagation());
    const boxes: HTMLInputElement[] = [];
    const refreshLabel = () => {
      const n = selected.size;
      const all = items.length > 0 && n === items.length;
      trigger.innerHTML = Html.escape(labelTxt) + ' <span class="count-badge">' + ((n === 0 || all) ? I18n.t("ui.multiselect.all") : I18n.t("ui.multiselect.selectedCount", { n })) + "</span>";
    };
    if (items.length) {
      const head = document.createElement("div"); head.className = "multi-allnone";
      const bAll = document.createElement("button"); bAll.type = "button"; bAll.textContent = I18n.t("ui.multiselect.selectAll");
      const bNone = document.createElement("button"); bNone.type = "button"; bNone.textContent = I18n.t("ui.multiselect.selectNone");
      bAll.onclick = () => { items.forEach((it) => selected.add(it.id)); boxes.forEach((c) => { c.checked = true; }); refreshLabel(); onChange(); };
      bNone.onclick = () => { selected.clear(); boxes.forEach((c) => { c.checked = false; }); refreshLabel(); onChange(); };
      head.appendChild(bAll); head.appendChild(bNone);
      panel.appendChild(head);
    }
    items.forEach((it) => {
      const row = document.createElement("label"); row.className = "multi-item";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = selected.has(it.id);
      cb.onchange = () => { if (cb.checked) selected.add(it.id); else selected.delete(it.id); refreshLabel(); onChange(); };
      boxes.push(cb);
      const sw = it.color ? `<span class="swatch-dot" style="background:${it.color};"></span>` : "";
      const txt = document.createElement("span"); txt.innerHTML = sw + Html.escape(it.label);
      row.appendChild(cb); row.appendChild(txt);
      panel.appendChild(row);
    });
    if (!items.length) { const e = document.createElement("div"); e.className = "multi-item"; e.style.color = "var(--fg-dimmer)"; e.textContent = I18n.t("ui.multiselect.empty"); panel.appendChild(e); }
    trigger.onclick = (e) => {
      e.stopPropagation();
      const willOpen = !panel.classList.contains("open");
      document.querySelectorAll(".multi-panel.open").forEach((p) => p.classList.remove("open"));
      if (willOpen) panel.classList.add("open");
    };
    refreshLabel();
    pop.appendChild(trigger); pop.appendChild(panel);
    return pop;
  }
}
