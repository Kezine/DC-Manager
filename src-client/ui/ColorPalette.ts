import { COLOR_PALETTE } from "../domain/constants";

/* Sélecteur de couleur : pastilles de la palette (+ « aucune ») + color-picker natif
   pour une couleur hors palette. `onChange(color|null)` à chaque choix.
   Remplace la fonction libre `makeColorPalette`. */
export class ColorPalette {
  static build(initial: string | null, onChange: (c: string | null) => void): HTMLElement {
    const wrap = document.createElement("div");
    const palette = document.createElement("div"); palette.className = "palette";
    let current = initial || null;
    const selectSwatch = (el: HTMLElement | null) => {
      palette.querySelectorAll(".palette-swatch").forEach((s) => s.classList.remove("selected"));
      if (el) el.classList.add("selected");
    };
    const none = document.createElement("div");
    none.className = "palette-swatch none" + (!initial ? " selected" : "");
    none.title = "Aucune couleur"; none.textContent = "∅";
    none.onclick = () => { current = null; selectSwatch(none); onChange(null); syncPicker(); };
    palette.appendChild(none);
    COLOR_PALETTE.forEach((c) => {
      const sw = document.createElement("div");
      sw.className = "palette-swatch" + (initial === c ? " selected" : "");
      sw.style.background = c; sw.title = c;
      sw.onclick = () => { current = c; selectSwatch(sw); onChange(c); syncPicker(); };
      palette.appendChild(sw);
    });
    wrap.appendChild(palette);

    const customRow = document.createElement("div"); customRow.className = "palette-custom";
    const picker = document.createElement("input");
    picker.type = "color"; picker.value = (initial && /^#[0-9a-f]{6}$/i.test(initial)) ? initial : "#ff5500";
    const lbl = document.createElement("span");
    lbl.style.fontSize = "10px"; lbl.style.color = "var(--fg-dim)"; lbl.textContent = "Couleur personnalisée";
    picker.oninput = () => { current = picker.value; selectSwatch(null); onChange(picker.value); };
    function syncPicker() { if (current && /^#[0-9a-f]{6}$/i.test(current)) picker.value = current; }
    customRow.appendChild(picker); customRow.appendChild(lbl);
    wrap.appendChild(customRow);
    return wrap;
  }
}
