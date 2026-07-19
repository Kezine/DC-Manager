import { Html } from "../core/Html";
import { I18n } from "../i18n/I18n";

export interface SelectOption { value: string; label: string; disabled?: boolean; group?: string; }
export interface NumberOpts { min?: number | string; max?: number | string; step?: number | string; placeholder?: string; }
/** `tipKey` = CLÉ d'un contenu enregistré dans `RichTooltip` (jamais du HTML : le moteur
    construit le DOM et échappe lui-même — cf. ui/RichTooltip.ts).
    `icon` = SVG de CONFIANCE (constante `ui/Icons`) rendu avant le libellé — jamais une donnée. */
export interface ToggleOpts { title?: string; block?: boolean; disabled?: boolean; tipKey?: string; icon?: string; }
/** `mode` = granularité du champ : `"date"` (défaut, RÉTRO-COMPATIBLE) → `<input type="date">` ;
    `"date-time"` → `<input type="datetime-local">` ; `"time"` → `<input type="time">`. */
export interface DateOpts { buttons?: string[]; min?: string; max?: string; mode?: "date" | "date-time" | "time"; }

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
    t.value = value || ""; t.placeholder = I18n.t("ui.form.textareaPlaceholder");
    return t;
  }

  /** Champ number. La valeur n'est posée que si non-nulle/non-vide. */
  static number(value?: any, opts: NumberOpts = {}): HTMLInputElement {
    const i = document.createElement("input");
    i.type = "number";
    if (opts.min != null) i.min = String(opts.min);
    if (opts.max != null) i.max = String(opts.max);
    i.step = (opts.step != null) ? String(opts.step) : "1";
    // Clavier mobile ADAPTÉ : un champ nombre ne doit jamais ouvrir un clavier alphabétique. La
    // granularité se déduit du `step` — entier → pavé « numeric » (positions U, quantités, ports…) ;
    // pas fractionnaire (ou « any ») → « decimal », qui garde le séparateur décimal (dimensions mm, A…).
    i.inputMode = Number.isInteger(Number(i.step)) ? "numeric" : "decimal";
    if (opts.placeholder) i.placeholder = opts.placeholder;
    if (value != null && value !== "") i.value = String(value);
    return i;
  }

  static select(options: SelectOption[], value?: string | null): HTMLSelectElement {
    const s = document.createElement("select");
    s.className = "app-select";   // thème de l'app (sinon rendu natif du navigateur)
    FormControls.fillSelect(s, options, value);
    return s;
  }

  /** (Ré)emplit un <select> : vide puis pose les options. Une option portant `group` est rangée sous un
      <optgroup> de ce libellé (créé au 1er passage, ordre d'apparition préservé) → regroupement visuel (ex.
      types de câble/port par FAMILLE) ; les options SANS `group` (placeholder…) restent à plat. Point d'entrée
      UNIQUE partagé par `FormControls.select` (création) et `FormUi.setOptions` (repeuplement, handlers préservés). */
  static fillSelect(sel: HTMLSelectElement, options: SelectOption[], value?: string | null): void {
    sel.innerHTML = "";
    const groups = new Map<string, HTMLOptGroupElement>();
    options.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = o.value; opt.textContent = o.label;
      if (o.disabled) opt.disabled = true;
      if (o.group) {
        let g = groups.get(o.group);
        if (!g) { g = document.createElement("optgroup"); g.label = o.group; groups.set(o.group, g); sel.appendChild(g); }
        g.appendChild(opt);
      } else sel.appendChild(opt);
    });
    if (value != null) sel.value = value;
  }

  /** Bascule (toggle) : pilule + témoin ● + teinte (via .toggle-pill), distincte du bouton
      d'action. `.checked` getter/setter exposé. */
  static toggle(labelText: string, checked: boolean, onChange: (v: boolean) => void, opts: ToggleOpts = {}): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-sm toggle-pill" + (opts.block ? " toggle-block" : "") + (checked ? " active" : "");
    b.setAttribute("role", "switch"); b.setAttribute("aria-checked", checked ? "true" : "false");
    if (opts.title) b.title = opts.title;
    if (opts.tipKey) b.setAttribute("data-rich-tooltip", opts.tipKey);   // simple CLÉ → aucun échappement à bricoler ici
    if (opts.disabled) b.disabled = true;
    const iconSpan = opts.icon ? '<span class="gi" aria-hidden="true">' + opts.icon + "</span>" : "";   // SVG de confiance (ui/Icons)
    b.innerHTML = '<span class="tgl-dot" aria-hidden="true"></span>' + iconSpan + '<span class="tgl-txt">' + Html.escape(labelText) + "</span>";
    const set = (v: boolean, fire: boolean) => {
      b.classList.toggle("active", !!v);
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

  /** Saisie de DATE thématisée (input + boutons choisir 📅/🕑 / maintenant / effacer). `.value` proxifié.
      `opts.mode` étend la granularité (date / date-heure / heure) SANS casser les appelants existants (défaut
      « date »). Libellés/infobulles LOCALISÉS (`ui.form.*`) — variantes par mode. */
  static date(value?: string, opts: DateOpts = {}): HTMLDivElement {
    const mode = opts.mode || "date";
    const buttons = opts.buttons || ["pick", "now", "clear"];
    const wrap = document.createElement("div"); wrap.className = "date-input-wrap";
    const row = document.createElement("div"); row.className = "date-input-row";
    const input = document.createElement("input");
    input.type = mode === "date-time" ? "datetime-local" : mode === "time" ? "time" : "date";
    if (value) input.value = value;
    if (opts.min) input.min = opts.min; if (opts.max) input.max = opts.max;
    row.appendChild(input);
    const fire = () => input.dispatchEvent(new Event("change", { bubbles: true }));
    const pad = (n: number) => String(n).padStart(2, "0");
    // Valeur « maintenant » selon le mode : date seule (AAAA-MM-JJ), date+heure au format d'un
    // <input datetime-local> (AAAA-MM-JJTHH:MM), ou heure seule (HH:MM).
    const nowValue = (): string => {
      const d = new Date();
      const date = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
      const time = pad(d.getHours()) + ":" + pad(d.getMinutes());
      return mode === "time" ? time : mode === "date-time" ? date + "T" + time : date;
    };
    const CAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
    const CLK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7.5 12 12 15.5 14"/></svg>';
    const CLR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 20H8.5L3 14l5.5-6H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2z"/><line x1="18" y1="11" x2="12" y2="17"/><line x1="12" y1="11" x2="18" y2="17"/></svg>';
    // Le bouton « choisir » prend l'icône horloge en mode heure seule ; « maintenant » garde son ancien libellé
    // « Auj. » en mode date (rétro-compatibilité) et devient « Maint. » quand une heure entre en jeu.
    // Fusion rebase adaptations-UI × migration i18n : structure multi-modes + libellés en CLÉS (ui.form.*).
    const pickIcon = mode === "time" ? CLK : CAL;
    const pickTitle = mode === "time" ? I18n.t("ui.form.timePick") : I18n.t("ui.form.datePick");
    const nowLabel = mode === "date" ? I18n.t("ui.form.dateToday") : I18n.t("ui.form.dateNow");
    const nowTitle = mode === "date" ? I18n.t("ui.form.dateTodayTitle") : mode === "date-time" ? I18n.t("ui.form.dateTimeNowTitle") : I18n.t("ui.form.timeNowTitle");
    const mkBtn = (cls: string, html: string, title: string, fn: () => void) => {
      const b = document.createElement("button"); b.type = "button"; b.className = "btn btn-sm btn-ghost date-ctrl-btn " + cls;
      b.title = title; b.setAttribute("aria-label", title); b.innerHTML = html; b.addEventListener("click", fn); return b;
    };
    buttons.forEach((k) => {
      if (k === "pick") row.appendChild(mkBtn("date-ctrl-icon", pickIcon, pickTitle, () => { try { (input as any).showPicker(); } catch (_) { input.focus(); } }));
      else if (k === "now") row.appendChild(mkBtn("date-ctrl-text", nowLabel, nowTitle, () => { input.value = nowValue(); fire(); }));
      else if (k === "clear") row.appendChild(mkBtn("date-ctrl-icon", CLR, I18n.t("ui.form.dateClear"), () => { input.value = ""; fire(); }));
    });
    wrap.appendChild(row);
    (wrap as any)._input = input;
    Object.defineProperty(wrap, "value", { get() { return input.value; }, set(v) { input.value = v || ""; }, configurable: true });
    return wrap;
  }
}
