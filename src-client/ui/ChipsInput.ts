import { Html } from "../core/Html";
import { Color } from "../core/Color";
import { Autocomplete, AcItem, AC_CREATE_ID } from "./Autocomplete";
import { I18n } from "../i18n/I18n";

export interface ChipItem { id: string; label: string; color?: string | null; meta?: string; }

export interface ChipsOptions {
  /** Valeurs candidates (suggestions ET résolution des pastilles) — relue à chaque frappe/rendu. */
  items: () => ChipItem[];
  /** Ids sélectionnés au départ. */
  value?: string[];
  placeholder?: string;
  /** Limite dynamique de suggestions (cf. Autocomplete). */
  getLimit?: () => number;
  /** Notifie la nouvelle sélection (ids) à chaque changement. */
  onChange?: (ids: string[]) => void;
  /** Autorise « + Créer <saisie> » ; `onCreate` crée l'entité et renvoie son id (ou null pour annuler). */
  allowCreate?: boolean;
  onCreate?: (label: string) => string | null;
}

export interface ChipsController { element: HTMLElement; getValue(): string[]; setValue(ids: string[]): void; refresh(): void; }

/* =============================================================================
   MULTI-SÉLECTION à PASTILLES — champ de recherche + valeurs sélectionnées en
   pastilles supprimables. Bâti sur `Autocomplete` (liste flottante filtrée).
   Manipule des IDS ; labels/couleurs résolus via `items()`. Découplé du métier.

   Reproduit le pattern « chips input » de l'app Compta (recherche + pastilles),
   thémé aux variables de l'app et recodé en module TS réutilisable.
   ============================================================================= */
export class ChipsInput {
  static build(opts: ChipsOptions): ChipsController {
    const selected: string[] = [...(opts.value || [])];
    const wrap = document.createElement("div");
    wrap.className = "chips-input";
    const input = document.createElement("input");
    input.type = "text"; input.placeholder = opts.placeholder || I18n.t("ui.chips.placeholder");

    const byId = (id: string): ChipItem | null => opts.items().find((i) => i.id === id) || null;
    const emit = () => { try { opts.onChange?.([...selected]); } catch (e) { console.error(e); } };

    const render = () => {
      [...wrap.querySelectorAll(".chip")].forEach((c) => c.remove());   // reconstruit les pastilles
      selected.forEach((id) => {
        const it = byId(id);
        const chip = document.createElement("span"); chip.className = "chip";
        const style = it ? Color.pillStyle(it.color) : "";
        if (style) { chip.setAttribute("style", style.replace(/^style="|"$/g, "")); chip.classList.add("colored-pill"); }
        const label = it ? it.label : id;
        chip.innerHTML = Html.escape(label) + ' <span class="chip-x" role="button" aria-label="' + Html.escape(I18n.t("ui.chips.remove")) + '">×</span>';
        chip.querySelector(".chip-x")!.addEventListener("click", () => { remove(id); });
        wrap.insertBefore(chip, input);   // pastilles AVANT l'input
      });
    };
    const add = (id: string) => { if (id && !selected.includes(id)) { selected.push(id); render(); emit(); } };
    const remove = (id: string) => { const i = selected.indexOf(id); if (i >= 0) { selected.splice(i, 1); render(); emit(); ac.refresh(); } };

    wrap.appendChild(input);
    render();

    // Suggestions = candidats NON déjà sélectionnés.
    const getItems = (): AcItem[] => opts.items().filter((i) => !selected.includes(i.id));
    const onPick = (item: AcItem) => {
      if (item.id === AC_CREATE_ID) { if (opts.onCreate) { const id = opts.onCreate(item.label); if (id) add(id); } return; }
      add(item.id);
    };
    const ac = Autocomplete.attach(input, getItems, onPick, { getLimit: opts.getLimit, allowCreate: opts.allowCreate });

    // Backspace sur champ vide → retire la dernière pastille (raccourci usuel des champs à jetons).
    input.addEventListener("keydown", (e) => { if (e.key === "Backspace" && !input.value && selected.length) { e.preventDefault(); remove(selected[selected.length - 1]); } });
    wrap.addEventListener("click", (e) => { if (e.target === wrap) input.focus(); });

    return {
      element: wrap,
      getValue: () => [...selected],
      setValue: (ids: string[]) => { selected.length = 0; selected.push(...(ids || [])); render(); },
      refresh: () => { render(); ac.refresh(); },
    };
  }
}
