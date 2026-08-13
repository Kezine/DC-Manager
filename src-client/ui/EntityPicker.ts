import { SearchPop } from "./SearchPop";
import type { SearchPopResult } from "./SearchPop";
import { IconButton } from "./IconButton";
import { Icons } from "./Icons";
import { OptionSearch } from "../core/OptionSearch";
import type { PickableOption } from "../core/OptionSearch";
import { Schema } from "../../src-shared/Schema";
import { I18n } from "../i18n/I18n";

/* =============================================================================
   EntityPicker — SÉLECTEUR D'ENTITÉ À CHAMP DE RECHERCHE, remplaçant du `<select>`
   natif quand les options désignent des ENTITÉS (un équipement, un port, un patch)
   et non une énumération fermée (un statut, une famille).

   POURQUOI (principe n°14, écrit en doctrine bien avant ce lot) : « la SÉLECTION
   d'une entité passe par le pattern SearchPop, le CLIC sur un résultat
   sélectionne » — pas par un `<select>` qui ne se filtre au clavier que par
   PRÉFIXE. Le besoin s'est aggravé de lui-même : les libellés portent désormais un
   suffixe d'emplacement (« · Salle A », « · Bât. X · ét. 1 »), et les équipements
   d'ÉTAGE sont entrés dans ces listes.

   COMPOSITION, PAS MODE (arbitrage de ce lot) : `SearchPop` est un composant de
   RECHERCHE — il n'a ni valeur courante, ni état vide, ni effacement. Lui ajouter
   « un mode sélecteur » en aurait fait la fonction à drapeaux que le principe n°2
   proscrit. On l'ENVELOPPE : ce module porte la VALEUR (et tout ce qui en découle),
   `SearchPop` reste le champ + le popover. Seules les capacités réellement
   manquantes lui ont été ajoutées (résultat `disabled`, clavier/ARIA, placeholder
   modifiable) — toutes utiles à ses autres usages, aucune propre au sélecteur.

   LA RÈGLE MÉTIER RESTE CHEZ L'APPELANT. Ce contrôle consomme la MÊME liste
   `{ value, label, disabled? }` que `FormControls.select` : filtre par famille de
   port, contrainte de conteneur, ports occupés `disabled` nommant le câble qui les
   occupe, breakout, suffixe d'emplacement, tri (occupés en fin) et `keepId` sont
   calculés AILLEURS et ne bougent pas d'une ligne. C'est ce qui rend la bascule
   sûre : on remplace le CONTRÔLE, pas la RÈGLE. Le filtrage par la saisie et les
   règles de valeur vivent, eux, dans `core/OptionSearch` (pur, testé).

   API compatible `<select>` À DESSEIN : l'élément rendu expose `.value`
   (getter/setter, le setter NE déclenche PAS `change` — même contrat que
   `FormControls.toggle`/`date`), `setOptions(options, value?)` (pendant exact de
   `FormUi.setOptions`), `focus()` et l'événement `change`. Les points d'appel
   restent donc lisibles comme avant, et `LiveValidation` continue de surligner le
   champ (il remonte au `.form-field` parent et trouve l'input enveloppé).

   RENDU — une seule rangée : [pastille de la valeur] [✕] [champ de recherche].
   Aucune CSS nouvelle : `.chip` (valeur), `.icon-action` (effacer) et
   `.lc-searchpop` (champ) existent déjà et portent le thème. Quand la liste
   n'offre RIEN à choisir (elle se réduit à son option de tête : « Choisir un
   équipement d'abord », « Aucun port compatible »), le champ de recherche cède la
   place à ce libellé — un champ de recherche sans rien à chercher serait un
   mensonge, là où le `<select>` affichait justement ce texte.

   POPOVER EN PORTAIL (toujours) : tout entityPicker vit dans un conteneur qui rogne (corps
   défilant de modale, panneau 3D `.dc-side`) ; le `SearchPop` est donc monté en `portal: true`
   pour que sa liste échappe à l'overflow de l'ancêtre au lieu d'y être coupée.
   ============================================================================= */

export interface EntityPickerOptions {
  /** Options initiales — MÊME forme que `FormControls.select`. */
  options: PickableOption[];
  /** Valeur initiale (`null`/absente = aucune sélection). */
  value?: string | null;
  /** Nb MAX de résultats rendus d'un coup — défaut `OptionSearch.DEFAULT_LIMIT`. Le surplus est
      ANNONCÉ dans le popover, jamais tu. */
  limit?: number;
}

/** Élément racine du sélecteur : un `<div>` doté de l'API utile d'un `<select>`. */
export interface EntityPickerElement extends HTMLDivElement {
  /** Valeur sélectionnée ("" = aucune). Le setter ne déclenche PAS `change`. */
  value: string;
  /** (Ré)emplit les options. `value` omise → la valeur de la 1re option, comme un `<select>`
      repeuplé (cf. `OptionSearch.resolveValue`). Ne déclenche PAS `change`. */
  setOptions(options: PickableOption[], value?: string | null): void;
}

export class EntityPicker {
  /** Construit le contrôle. Le libellé de l'état vide et celui du champ de recherche sont TIRÉS de
      l'option de tête de la liste (celle de valeur ""), donc déjà localisés et déjà contextuels —
      rien à redéclarer au point d'appel. */
  static build(opts: EntityPickerOptions): EntityPickerElement {
    const limit = opts.limit != null ? opts.limit : OptionSearch.DEFAULT_LIMIT;
    let options: PickableOption[] = opts.options.slice();
    let selected = OptionSearch.resolveValue(options, opts.value);

    const root = document.createElement("div") as EntityPickerElement;
    root.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap";

    // Rangée de VALEUR : pastille + bouton d'effacement, insérées avant le champ de recherche.
    const chip = document.createElement("span"); chip.className = "chip";
    chip.style.cssText = "max-width:100%;min-width:0";
    const chipText = document.createElement("span");
    chipText.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    chip.appendChild(chipText);
    const clearBtn = IconButton.build({
      icon: Icons.CLOSE,
      label: I18n.t("ui.entityPicker.clear"),
      onClick: () => { selected = OptionSearch.EMPTY_VALUE; render(); emitChange(); },
    });

    // Repli affiché à la place du champ quand il n'y a RIEN à chercher (libellé de l'option de tête).
    const emptyNote = document.createElement("span");
    emptyNote.className = "form-hint"; emptyNote.style.cssText = "margin-top:0;font-style:italic";

    const pop = new SearchPop({
      placeholder: OptionSearch.placeholderLabel(options) || I18n.t("ui.entityPicker.searchPlaceholder"),
      // Source SYNCHRONE (options déjà en mémoire) : `Promise.resolve` satisfait le contrat de
      // `SearchPop` sans rien attendre, et `debounceMs: 0` évite un délai qui n'aurait aucune
      // contrepartie — l'anti-rebond ne sert qu'à ménager un RÉSEAU, absent ici.
      debounceMs: 0,
      // 0 : la liste complète (bornée) s'ouvre au focus. C'est LA condition pour remplacer un
      // `<select>`, qu'on pouvait dérouler sans rien taper.
      minChars: 0,
      grow: true,
      // PORTAIL : c'est le DÉFAUT de SearchPop (arbitrage 2026-08-13) — rien à déclarer. Les surfaces
      // entityPicker vivent toutes dans un conteneur qui ROGNE (corps `.modal-body` des formulaires,
      // panneau 3D `.dc-side`) : c'est précisément ce cas qui a motivé le défaut.
      fetch: (query) => {
        const outcome = OptionSearch.filter(options, query, { normalize: Schema.normSearch, limit });
        const results: SearchPopResult[] = outcome.shown.map((option) => ({
          id: option.value, label: option.label, disabled: option.disabled, data: option,
        }));
        // Troncature ANNONCÉE : un plafond silencieux ferait croire qu'une entité n'existe pas.
        // Le message est celui, déjà pluralisé, de l'autocomplétion (principe n°3) ; `disabled`
        // le rend non sélectionnable et le sort de la navigation clavier.
        if (outcome.hidden) results.push({ id: "", label: I18n.t("ui.autocomplete.overflow", { count: outcome.hidden }), disabled: true });
        return Promise.resolve(results);
      },
      onPick: (result) => { selected = result.id; pop.reset(); render(); emitChange(); },
    });

    const emitChange = (): void => { root.dispatchEvent(new Event("change", { bubbles: true })); };

    const render = (): void => {
      const label = OptionSearch.labelOf(options, selected);
      // Valeur sélectionnée → pastille + ✕ ; sinon la rangée commence directement par le champ.
      if (label !== null) {
        chipText.textContent = label;
        chip.title = label;   // le libellé est ellipsé : le texte entier reste lisible au survol
        if (!chip.parentNode) root.insertBefore(chip, root.firstChild);
        if (!clearBtn.parentNode) root.insertBefore(clearBtn, chip.nextSibling);
      } else { chip.remove(); clearBtn.remove(); }
      // Rien à choisir → on montre le libellé de tête au lieu d'un champ de recherche inerte.
      const searchable = OptionSearch.selectableCount(options) > 0;
      const placeholder = OptionSearch.placeholderLabel(options);
      if (searchable) {
        emptyNote.remove();
        pop.setPlaceholder(placeholder || I18n.t("ui.entityPicker.searchPlaceholder"));
        if (!pop.element.parentNode) root.appendChild(pop.element);
      } else {
        pop.element.remove();
        emptyNote.textContent = placeholder;
        if (!emptyNote.parentNode) root.appendChild(emptyNote);
      }
    };

    // La saisie ne doit pas SURVIVRE à la sortie du champ : au retour, l'utilisateur retrouverait un
    // filtre dont il ne se souvient pas. On attend la fin de la bascule de focus avant de trancher,
    // sinon un clic sur le ✕ interne (qui prend le focus) passerait pour une sortie.
    root.addEventListener("focusout", () => {
      window.setTimeout(() => { if (!root.contains(document.activeElement)) pop.reset(); }, 0);
    });

    Object.defineProperty(root, "value", {
      get() { return selected; },
      set(v: string | null) { selected = OptionSearch.resolveValue(options, v == null ? OptionSearch.EMPTY_VALUE : String(v)); render(); },
      configurable: true,
    });
    root.setOptions = (next: PickableOption[], value?: string | null): void => {
      options = next.slice();
      selected = OptionSearch.resolveValue(options, value);
      render();
    };
    // `focus()` d'un `<div>` ne fait rien : on le relaie au champ de recherche, pour que les
    // formulaires qui posent le focus initial (ou celui du 1er champ fautif) atteignent bien le contrôle.
    root.focus = () => { pop.focus(); };

    render();
    return root;
  }
}
