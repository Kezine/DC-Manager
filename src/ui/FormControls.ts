import { Html } from "../core/Html";

export interface SelectOption { value: string; label: string; disabled?: boolean; }
export interface NumberOpts { min?: number | string; step?: number | string; placeholder?: string; }
export interface ToggleOpts { title?: string; block?: boolean; disabled?: boolean; richTip?: string; }
export interface DateOpts { buttons?: string[]; min?: string; max?: string; }

/* Composants de FORMULAIRE réutilisables (rangée libellée, champs texte/nombre/
   select/date, bascule, datalist). Builders DOM partagés par tous les formulaires
   des vues. Remplacent les fonctions libres `fieldRow`/`textInput`/… */
export class FormControls {
  /** Rangée « label + contrôle (+ hint) » d'un formulaire. */
  static fieldRow(label: string, control: HTMLElement, hint?: string): HTMLDivElement {
    const f = document.createElement("div");
    f.className = "form-field";
    const l = document.createElement("label"); l.textContent = label;
    f.appendChild(l); f.appendChild(control);
    if (hint) { const h = document.createElement("div"); h.className = "form-hint"; h.textContent = hint; f.appendChild(h); }
    return f;
  }

  static text(value?: string, placeholder?: string): HTMLInputElement {
    const i = document.createElement("input");
    i.type = "text"; i.value = value || ""; if (placeholder) i.placeholder = placeholder;
    return i;
  }

  static textArea(value?: string): HTMLTextAreaElement {
    const t = document.createElement("textarea");
    t.value = value || ""; t.placeholder = "Description / note…";
    return t;
  }

  /** Champ number. La valeur n'est posée que si non-nulle/non-vide. */
  static number(value?: any, opts: NumberOpts = {}): HTMLInputElement {
    const i = document.createElement("input");
    i.type = "number";
    if (opts.min != null) i.min = String(opts.min);
    i.step = (opts.step != null) ? String(opts.step) : "1";
    if (opts.placeholder) i.placeholder = opts.placeholder;
    if (value != null && value !== "") i.value = String(value);
    return i;
  }

  static select(options: SelectOption[], value?: string | null): HTMLSelectElement {
    const s = document.createElement("select");
    options.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o.value; opt.textContent = o.label;
      if (o.disabled) opt.disabled = true;
      s.appendChild(opt);
    });
    if (value != null) s.value = value;
    return s;
  }

  /** Bascule (toggle) au style des onglets : ON = btn-primary, OFF = btn-ghost.
      `.checked` getter/setter exposé. */
  static toggle(labelText: string, checked: boolean, onChange: (v: boolean) => void, opts: ToggleOpts = {}): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-sm toggle-pill" + (opts.block ? " toggle-block" : "") + (checked ? " btn-primary active" : " btn-ghost");
    b.setAttribute("role", "switch"); b.setAttribute("aria-checked", checked ? "true" : "false");
    if (opts.title) b.title = opts.title;
    if (opts.richTip) b.setAttribute("data-rich-tooltip", String(opts.richTip).replace(/&/g, "&amp;").replace(/"/g, "&quot;"));
    if (opts.disabled) b.disabled = true;
    b.innerHTML = '<span class="tgl-txt">' + Html.escape(labelText) + "</span>";
    const set = (v: boolean, fire: boolean) => {
      b.classList.toggle("btn-primary", !!v); b.classList.toggle("btn-ghost", !v); b.classList.toggle("active", !!v);
      b.setAttribute("aria-checked", v ? "true" : "false");
      if (fire) { try { onChange(!!v); } catch (e) { console.error(e); } }
    };
    b.addEventListener("click", () => { if (b.disabled) return; set(!b.classList.contains("active"), true); });
    Object.defineProperty(b, "checked", { get() { return b.classList.contains("active"); }, set(v) { set(!!v, false); }, configurable: true });
    return b;
  }

  static attachDatalist(input: HTMLInputElement, id: string, values: string[]): HTMLDataListElement {
    const dl = document.createElement("datalist"); dl.id = id;
    values.forEach((v) => { const o = document.createElement("option"); o.value = v; dl.appendChild(o); });
    input.setAttribute("list", id);
    return dl;
  }

  /** Saisie de DATE thématisée (input date + boutons 📅 / Auj. / 🧽). `.value` proxifié. */
  static date(value?: string, opts: DateOpts = {}): HTMLDivElement {
    const buttons = opts.buttons || ["pick", "now", "clear"];
    const wrap = document.createElement("div"); wrap.className = "date-input-wrap";
    const row = document.createElement("div"); row.className = "date-input-row";
    const input = document.createElement("input"); input.type = "date"; if (value) input.value = value;
    if (opts.min) input.min = opts.min; if (opts.max) input.max = opts.max;
    row.appendChild(input);
    const fire = () => input.dispatchEvent(new Event("change", { bubbles: true }));
    const today = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
    const CAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
    const CLR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 20H8.5L3 14l5.5-6H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2z"/><line x1="18" y1="11" x2="12" y2="17"/><line x1="12" y1="11" x2="18" y2="17"/></svg>';
    const mkBtn = (cls: string, html: string, title: string, fn: () => void) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-sm btn-ghost date-ctrl-btn " + cls;
      b.title = title; b.setAttribute("aria-label", title); b.innerHTML = html; b.addEventListener("click", fn); return b;
    };
    buttons.forEach((k) => {
      if (k === "pick") row.appendChild(mkBtn("date-ctrl-icon", CAL, "Ouvrir le sélecteur de date", () => { try { (input as any).showPicker(); } catch (_) { input.focus(); } }));
      else if (k === "now") row.appendChild(mkBtn("date-ctrl-text", "Auj.", "Mettre la date du jour", () => { input.value = today(); fire(); }));
      else if (k === "clear") row.appendChild(mkBtn("date-ctrl-icon", CLR, "Effacer cette date", () => { input.value = ""; fire(); }));
    });
    wrap.appendChild(row);
    (wrap as any)._input = input;
    Object.defineProperty(wrap, "value", { get() { return input.value; }, set(v) { input.value = v || ""; }, configurable: true });
    return wrap;
  }
}
