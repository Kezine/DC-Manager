import { Html } from "../core/Html";
import { Schema } from "../../src-shared/Schema";
import { I18n } from "../i18n/I18n";

/** Une suggestion d'autocomplétion. `id` identifie la valeur (pour un champ libre, id === label). */
export interface AcItem { id: string; label: string; color?: string | null; meta?: string; }

/** Item spécial « créer à la volée » remonté à `onPick` quand `allowCreate` et saisie inédite. */
export const AC_CREATE_ID = "__ac_new__";

export interface AcOptions {
  /** Nombre MAX de suggestions affichées (lu dynamiquement à chaque frappe). Défaut : 10. */
  getLimit?: () => number;
  /** Autorise un item « + Créer <saisie> » si la saisie ne correspond à aucun label existant. */
  allowCreate?: boolean;
  /** Ouvre la liste au focus même sans saisie (propose les premières valeurs). Défaut : true. */
  openOnFocus?: boolean;
  /** Vide l'input après un choix (pertinent pour un multi-select à pastilles). Défaut : true.
      Mettre à false pour un CHAMP TEXTE simple (la valeur choisie doit rester dans l'input). */
  clearInputOnPick?: boolean;
}

/** Contrôleur renvoyé par `attach` : fermeture propre + rafraîchissement forcé. */
export interface AcController { destroy(): void; refresh(): void; close(): void; }

/* =============================================================================
   AUTOCOMPLÉTION réutilisable — liste flottante de suggestions filtrées sous un
   <input>. Découplée du métier : la source (`getItems`) et l'action au choix
   (`onPick`) sont injectées. La liste est portée sur `document.body` en
   `position:fixed` pour échapper au clipping (overflow des modales/panneaux).

   Sert DEUX usages :
     - champ texte simple (Marque/Modèle/Nom/Personne) : `onPick` pose la valeur ;
     - brique du multi-select à pastilles (`ChipsInput`) : `onPick` ajoute un id.

   Inspiré du composant `attachAutocomplete` de l'app Compta (même app-suite),
   recodé en module TS testable et thémé (variables CSS de l'app).
   ============================================================================= */
export class Autocomplete {
  /** Attache une liste d'autocomplétion à `input`. `getItems` fournit les candidats
      (déjà filtrés du contexte par l'appelant) ; le filtrage par la SAISIE est fait ici. */
  static attach(input: HTMLInputElement, getItems: () => AcItem[], onPick: (item: AcItem) => void, opts: AcOptions = {}): AcController {
    const openOnFocus = opts.openOnFocus !== false;
    const list = document.createElement("div");
    list.className = "ac-list";
    list.setAttribute("role", "listbox");
    document.body.appendChild(list);

    let matches: AcItem[] = [];
    let activeIdx = -1;
    const limit = () => { const n = opts.getLimit ? opts.getLimit() | 0 : 10; return n > 0 ? n : 10; };
    const isOpen = () => list.classList.contains("open");

    const reposition = () => {
      const r = input.getBoundingClientRect();
      const below = window.innerHeight - r.bottom, above = r.top;
      const flip = below < 220 && above > below;   // pas de place en bas → ouvre vers le haut
      list.style.left = r.left + "px";
      list.style.width = r.width + "px";
      list.style.maxHeight = Math.max(120, (flip ? above : below) - 12) + "px";
      list.classList.toggle("flip-up", flip);
      if (flip) { list.style.top = "auto"; list.style.bottom = (window.innerHeight - r.top) + "px"; }
      else { list.style.bottom = "auto"; list.style.top = r.bottom + "px"; }
    };

    const render = () => {
      const q = Schema.normSearch(input.value.trim());
      const items = getItems();
      matches = q ? items.filter((i) => Schema.normSearch(i.label).includes(q)) : items.slice();
      list.innerHTML = "";
      const max = limit();
      matches.slice(0, max).forEach((item, idx) => {
        const el = document.createElement("div");
        el.className = "ac-item" + (idx === activeIdx ? " active" : "");
        el.setAttribute("role", "option");
        if (idx === activeIdx) el.setAttribute("aria-selected", "true");
        const sw = item.color ? `<span class="ac-swatch" style="background:${Html.escape(item.color)};"></span>` : "";
        el.innerHTML = sw + Html.escape(item.label) + (item.meta ? `<span class="ac-meta">${Html.escape(item.meta)}</span>` : "");
        el.addEventListener("mousedown", (ev) => { ev.preventDefault(); pick(item); });   // mousedown : avant le blur
        list.appendChild(el);
      });
      if (matches.length > max) {
        const hint = document.createElement("div");
        hint.className = "ac-item ac-overflow";
        hint.innerHTML = `<span class="ac-meta">${Html.escape(I18n.t("ui.autocomplete.overflow", { count: matches.length - max }))}</span>`;
        list.appendChild(hint);
      }
      const raw = input.value.trim();
      if (opts.allowCreate && raw && !matches.some((m) => Schema.normSearch(m.label) === Schema.normSearch(raw))) {
        const el = document.createElement("div");
        el.className = "ac-item"; el.setAttribute("role", "option");
        el.innerHTML = `<span class="ac-new">${Html.escape(I18n.t("ui.autocomplete.create"))}</span> ${Html.escape(raw)}`;
        el.addEventListener("mousedown", (ev) => { ev.preventDefault(); pick({ id: AC_CREATE_ID, label: raw }); });
        list.appendChild(el);
      }
      const open = list.children.length > 0;
      list.classList.toggle("open", open);
      input.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) reposition();
    };

    const pick = (item: AcItem) => {
      onPick(item);
      activeIdx = -1;
      if (opts.clearInputOnPick !== false) { input.value = ""; render(); }   // multi-select : vide + garde ouvert
      else close();                                                          // champ texte : la valeur reste, on ferme
    };
    const close = () => { list.classList.remove("open"); input.setAttribute("aria-expanded", "false"); };

    const onFocus = () => { if (openOnFocus || input.value.trim()) render(); };
    const onInput = () => { activeIdx = -1; render(); };
    const onBlur = () => setTimeout(close, 150);   // délai : laisse passer le mousedown de sélection
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isOpen()) { if (e.key === "ArrowDown") { render(); } return; }
      const options = [...list.querySelectorAll<HTMLElement>(".ac-item:not(.ac-overflow)")];
      const maxIdx = options.length - 1;
      if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(maxIdx, activeIdx + 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); render(); }
      else if (e.key === "Enter") {
        if (activeIdx >= 0 && options[activeIdx]) { e.preventDefault(); options[activeIdx].dispatchEvent(new MouseEvent("mousedown")); }
        else if (opts.allowCreate && input.value.trim()) { e.preventDefault(); pick({ id: AC_CREATE_ID, label: input.value.trim() }); }
      } else if (e.key === "Escape") { close(); }
    };

    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.addEventListener("focus", onFocus);
    input.addEventListener("input", onInput);
    input.addEventListener("blur", onBlur);
    input.addEventListener("keydown", onKeyDown);
    const onScrollOrResize = () => { if (isOpen()) reposition(); };
    window.addEventListener("scroll", onScrollOrResize, { capture: true, passive: true });
    window.addEventListener("resize", onScrollOrResize, { passive: true });

    // La liste vit sur <body> : si l'input quitte le DOM (modale fermée), on nettoie tout.
    const observer = new MutationObserver((muts) => {
      if (!muts.some((m) => m.removedNodes && m.removedNodes.length)) return;
      if (!document.body.contains(input)) destroy();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const destroy = () => {
      list.remove();
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("input", onInput);
      input.removeEventListener("blur", onBlur);
      input.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScrollOrResize, { capture: true } as any);
      window.removeEventListener("resize", onScrollOrResize as any);
      observer.disconnect();
    };

    return { destroy, refresh: () => { if (document.activeElement === input) render(); }, close };
  }
}
