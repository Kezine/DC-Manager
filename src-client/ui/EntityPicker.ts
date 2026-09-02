import { SearchPop } from "./SearchPop";
import type { SearchPopResult } from "./SearchPop";
import { IconButton } from "./IconButton";
import { Icons } from "./Icons";
import { OptionSearch } from "../core/OptionSearch";
import type { PickableOption } from "../core/OptionSearch";
import type { EntityPickerCandidates } from "../core/EntityPickerSource";
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

   RENDU — une seule rangée. SANS valeur : [champ de recherche]. Une valeur POSÉE
   FERME le champ (retour terrain T6, « une fois l'équipement sélectionné, le select
   n'a plus lieu d'être ; idem pour le port ») : la rangée se réduit à [pastille de
   la valeur] [✕], et la pastille devient INTERACTIVE — la CLIQUER (ou Entrée/Espace
   au clavier) ROUVRE la recherche : le champ réapparaît, prend le focus, et son
   popover s'ouvre (minChars 0 → la liste s'ouvre au focus). Choisir un nouveau
   résultat REMPLACE la valeur et re-ferme le champ ; le ✕ efface la valeur (le champ
   réapparaît alors, faute de valeur à montrer). POURQUOI ce cycle de fermeture : un
   champ de recherche qui reste affiché À CÔTÉ d'une valeur déjà choisie est le
   « select qui n'a plus lieu d'être » — le contrôle ne montre donc le moyen de
   CHERCHER que tant qu'il n'y a rien de choisi, ou que l'utilisateur redemande à
   changer. Deux garde-fous en découlent : une valeur reposée PAR PROGRAMME (`.value`,
   `setOptions`, un `onPick`) revient TOUJOURS à l'état fermé (l'état « rouvert » est
   propre à un geste utilisateur, pas à l'état de la donnée) ; et une recherche
   rouverte puis ABANDONNÉE (focus sorti sans rien choisir) se RE-FERME d'elle-même,
   sans quoi on retomberait sur le champ inutile que T6 dénonce.

   Aucune CSS nouvelle sauf l'AFFORDANCE de la pastille interactive (une seule règle
   `.chip[role="button"]` commentée, dans dc-manager.css : curseur + survol ; l'anneau
   de focus clavier vient de la règle `:focus-visible` globale) : `.chip` (valeur),
   `.icon-action` (effacer) et le champ SearchPop existent déjà et portent le thème.
   Quand la liste (état SANS valeur) n'offre RIEN à choisir (elle se réduit à son
   option de tête : « Choisir un équipement d'abord », « Aucun port compatible »), le
   champ de recherche cède la place à ce libellé — un champ de recherche sans rien à
   chercher serait un mensonge, là où le `<select>` affichait justement ce texte. Cet
   état ne concerne QUE l'absence de valeur.

   POPOVER EN PORTAIL (toujours) : tout entityPicker vit dans un conteneur qui rogne (corps
   défilant de modale, panneau 3D `.dc-side`) ; le `SearchPop` est donc monté en `portal: true`
   pour que sa liste échappe à l'overflow de l'ancêtre au lieu d'y être coupée.

   RÉGIME ASYNC (`buildAsync`, chantier « picker async ») : le régime SYNC ci-dessus
   reste LA NORME — c'est lui qui porte les règles métier d'options. Pour une
   collection VOLUMINEUSE ou chargée PARESSEUSEMENT dont les options n'ont AUCUNE
   règle métier (chaque enregistrement est candidat — ni filtre, ni `disabled`),
   hydrater le corpus entier pour remplir un champ serait un contresens : le
   contrôle consomme alors une SOURCE injectée (`core/EntityPickerSource`) —
   parcours au focus par la route de LISTING, recherche transverse serveur, et
   résolution ASYNC du libellé de la valeur courante (pastille « Chargement… »
   pendant le vol, repli injecté si introuvable). Même rendu, même API
   `.value`/`change`/`focus()` — mais PAS de `setOptions` (il n'y a pas d'options
   en mémoire, c'est le point) ni d'état « rien à choisir » (on ne peut pas le
   savoir sans réseau — la note « aucun X » appartient à la vue appelante).
   Cf. docs/recherche.md § « Ce qui reste CLIENT, et pourquoi » (régime async).
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

/** Options du régime ASYNC (cf. bloc « RÉGIME ASYNC » de l'en-tête). */
export interface EntityPickerAsyncOptions {
  /** Source de candidats INJECTÉE (contrat `core/EntityPickerSource.EntityPickerCandidates`). */
  source: EntityPickerCandidates;
  /** Valeur initiale (`null`/absente = aucune sélection). */
  value?: string | null;
  /** Libellé de repli du champ de recherche. REQUIS ici, là où le régime sync le tire de l'option
      de tête : sans liste d'options, il n'y a pas d'option de tête où le lire. */
  placeholder: string;
  /** Libellé de REPLI d'une valeur INTROUVABLE (supprimée, ou d'un autre document) — défaut :
      l'id brut, une information exacte à défaut d'être belle. */
  fallbackLabel?: (id: string) => string;
}

/** Élément racine du régime ASYNC : `.value` (le setter ne déclenche PAS `change` — même contrat
    que le sync), `focus()` relayé, événement `change` au pick/effacement. PAS de `setOptions` :
    il n'y a pas d'options en mémoire, c'est le point. */
export interface EntityPickerAsyncElement extends HTMLDivElement {
  value: string;
}

export class EntityPicker {
  /** Construit le contrôle. Le libellé de l'état vide et celui du champ de recherche sont TIRÉS de
      l'option de tête de la liste (celle de valeur ""), donc déjà localisés et déjà contextuels —
      rien à redéclarer au point d'appel. */
  static build(opts: EntityPickerOptions): EntityPickerElement {
    const limit = opts.limit != null ? opts.limit : OptionSearch.DEFAULT_LIMIT;
    let options: PickableOption[] = opts.options.slice();
    let selected = OptionSearch.resolveValue(options, opts.value);
    /** Recherche ROUVERTE sur une valeur POSÉE (retour terrain T6) : sans valeur, le champ est de
        toute façon montré ; avec valeur, il n'apparaît QUE si ce drapeau est vrai — un geste
        utilisateur (clic/clavier sur la pastille) l'arme, tout chemin PROGRAMMATIQUE le désarme. */
    let reopened = false;

    const root = document.createElement("div") as EntityPickerElement;
    root.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap";

    // Rouvre la recherche sur une valeur posée : on réaffiche le champ PUIS on lui donne le focus,
    // ce qui ouvre son popover (minChars 0). C'est le geste que déclenchent le clic pastille ET le
    // `focus()` externe (formulaires) quand une valeur masque déjà le champ.
    const openSearch = (): void => { reopened = true; render(); pop.focus(); };

    // Rangée de VALEUR : pastille (INTERACTIVE — rouvre la recherche) + bouton d'effacement.
    const { chip, chipText } = EntityPicker.buildValueChip(openSearch);
    const clearBtn = IconButton.build({
      icon: Icons.CLOSE,
      label: I18n.t("ui.entityPicker.clear"),
      // Effacer = revenir à l'état SANS valeur (le champ réapparaît de lui-même) : on désarme aussi
      // la réouverture, l'état « rouvert » n'ayant de sens qu'en présence d'une valeur.
      onClick: () => { selected = OptionSearch.EMPTY_VALUE; reopened = false; render(); emitChange(); },
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
      // Choisir REMPLACE la valeur et re-ferme le champ (T6) : `reopened` retombe à faux.
      onPick: (result) => { selected = result.id; reopened = false; pop.reset(); render(); emitChange(); },
    });

    const emitChange = (): void => { root.dispatchEvent(new Event("change", { bubbles: true })); };

    const render = (): void => {
      const label = OptionSearch.labelOf(options, selected);
      const hasValue = label !== null;
      // Valeur sélectionnée → pastille + ✕ ; sinon la rangée commence directement par le champ.
      if (hasValue) {
        chipText.textContent = label;
        chip.title = label;   // le libellé est ellipsé : le texte entier reste lisible au survol
        if (!chip.parentNode) root.insertBefore(chip, root.firstChild);
        if (!clearBtn.parentNode) root.insertBefore(clearBtn, chip.nextSibling);
      } else { chip.remove(); clearBtn.remove(); }
      // T6 — le champ n'est montré que sans valeur, ou sur réouverture explicite d'une valeur posée.
      const showSearch = !hasValue || reopened;
      // Rien à choisir → on montre le libellé de tête au lieu d'un champ inerte (état SANS valeur).
      const searchable = OptionSearch.selectableCount(options) > 0;
      const placeholder = OptionSearch.placeholderLabel(options);
      if (showSearch && searchable) {
        emptyNote.remove();
        pop.setPlaceholder(placeholder || I18n.t("ui.entityPicker.searchPlaceholder"));
        if (!pop.element.parentNode) root.appendChild(pop.element);
      } else if (showSearch) {
        pop.element.remove();
        emptyNote.textContent = placeholder;
        if (!emptyNote.parentNode) root.appendChild(emptyNote);
      } else {
        // Valeur posée, recherche fermée → ni champ ni note : seulement [pastille] [✕].
        pop.element.remove();
        emptyNote.remove();
      }
    };

    // Recherche rouverte PUIS abandonnée (focus sorti sans choisir) : on la re-ferme (désarme
    // `reopened` et re-rend), en plus du reset de saisie — sinon le champ inutile de T6 réapparaît.
    EntityPicker.wireSearchReset(root, pop, () => { reopened = false; render(); });

    Object.defineProperty(root, "value", {
      get() { return selected; },
      // Pose PROGRAMMATIQUE d'une valeur → état fermé (T6) : `reopened` retombe à faux.
      set(v: string | null) { selected = OptionSearch.resolveValue(options, v == null ? OptionSearch.EMPTY_VALUE : String(v)); reopened = false; render(); },
      configurable: true,
    });
    root.setOptions = (next: PickableOption[], value?: string | null): void => {
      options = next.slice();
      selected = OptionSearch.resolveValue(options, value);
      reopened = false;   // repeuplement programmatique → retour à l'état fermé (T6)
      render();
    };
    // `focus()` d'un `<div>` ne fait rien : on le relaie au champ. Si une valeur MASQUE le champ
    // (T6), `focus()` doit le ROUVRIR (même geste que le clic pastille) — sinon le focus initial des
    // formulaires et le focus du 1er champ fautif de LiveValidation tomberaient dans le vide.
    root.focus = () => { openSearch(); };

    render();
    return root;
  }

  /** Construit le contrôle du régime ASYNC (cf. bloc « RÉGIME ASYNC » de l'en-tête) : MÊME rendu
      que `build` — rangée [pastille] [✕] [champ de recherche] — mais les candidats et le libellé
      de la valeur viennent de la SOURCE injectée, jamais d'une liste en mémoire. */
  static buildAsync(opts: EntityPickerAsyncOptions): EntityPickerAsyncElement {
    const source = opts.source;
    const fallback = opts.fallbackLabel || ((id: string) => id);
    let selected = opts.value == null ? OptionSearch.EMPTY_VALUE : String(opts.value);
    /** Libellé CONNU de la sélection — null AVEC une valeur non vide = résolution EN VOL, la
        pastille affiche « Chargement… » en attendant (arbitrage du chantier, cf. `applyValue`). */
    let selectedLabel: string | null = null;
    /** Recherche ROUVERTE sur une valeur posée (T6) — parité stricte avec le régime sync : la
        pastille « Chargement… » masque aussi le champ (une valeur EST posée), et la clic/clavier la
        rouvre. Tout chemin programmatique (`applyValue`, `onPick`, effacement) le désarme. */
    let reopened = false;

    const root = document.createElement("div") as EntityPickerAsyncElement;
    root.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap";

    // Rouvre la recherche sur une valeur posée (réaffiche le champ puis l'ouvre au focus) — geste
    // partagé par le clic pastille et le `focus()` externe, comme au régime sync.
    const openSearch = (): void => { reopened = true; render(); pop.focus(); };

    const { chip, chipText } = EntityPicker.buildValueChip(openSearch);
    const clearBtn = IconButton.build({
      icon: Icons.CLOSE,
      label: I18n.t("ui.entityPicker.clear"),
      // Effacer → état sans valeur (le champ réapparaît seul) ; on désarme la réouverture (T6).
      onClick: () => { selected = OptionSearch.EMPTY_VALUE; selectedLabel = null; reopened = false; render(); emitChange(); },
    });

    const pop = new SearchPop({
      placeholder: opts.placeholder,
      // Anti-rebond PORTÉ PAR LA SOURCE (0 si elle est locale, tempo serveur partagé sinon) : le
      // contrôle ne sait pas s'il y a un réseau à ménager — la source, si.
      debounceMs: source.debounceMs,
      // 0 : le PARCOURS s'ouvre au focus (fetch("") = requête vide → route de listing côté
      // source). C'est LA condition pour remplacer un `<select>`, comme au régime sync.
      minChars: 0,
      grow: true,
      // PORTAIL : défaut de SearchPop — mêmes conteneurs qui rognent qu'au régime sync.
      fetch: async (query) => {
        const batch = await source.fetch(query);
        const results: SearchPopResult[] = batch.options.map((option) => ({
          id: option.value, label: option.label, data: option,
        }));
        // Surplus du PARCOURS annoncé — même mécanique et même clé pluralisée que le régime sync
        // (un plafond silencieux ferait croire qu'une entité n'existe pas). La RECHERCHE, elle,
        // rend toujours hidden = 0 (le serveur ne rend pas de compte — limite documentée à la source).
        if (batch.hidden) results.push({ id: "", label: I18n.t("ui.autocomplete.overflow", { count: batch.hidden }), disabled: true });
        return results;
      },
      // Au PICK, AUCUNE résolution : le libellé est DANS le résultat cliqué (arbitrage du chantier).
      // Choisir REMPLACE la valeur et re-ferme le champ (T6) : `reopened` retombe à faux.
      onPick: (result) => { selected = result.id; selectedLabel = result.label; reopened = false; pop.reset(); render(); emitChange(); },
    });

    const emitChange = (): void => { root.dispatchEvent(new Event("change", { bubbles: true })); };

    const render = (): void => {
      // Valeur sélectionnée → pastille + ✕ (libellé connu, ou « Chargement… » pendant la
      // résolution) ; sinon la rangée commence directement par le champ — parité de rendu sync.
      const hasValue = selected !== OptionSearch.EMPTY_VALUE;
      const label = !hasValue ? null
        : (selectedLabel !== null ? selectedLabel : I18n.t("ui.entityPicker.resolving"));
      if (label !== null) {
        chipText.textContent = label;
        chip.title = label;   // le libellé est ellipsé : le texte entier reste lisible au survol
        if (!chip.parentNode) root.insertBefore(chip, root.firstChild);
        if (!clearBtn.parentNode) root.insertBefore(clearBtn, chip.nextSibling);
      } else { chip.remove(); clearBtn.remove(); }
      // T6 — le champ n'est montré que sans valeur, ou sur réouverture explicite (parité sync).
      if (!hasValue || reopened) { if (!pop.element.parentNode) root.appendChild(pop.element); }
      else pop.element.remove();
    };

    /** Pose une valeur et résout son libellé — SYNC d'abord (cache, via `labelOf`), sinon pastille
        « Chargement… » + `resolveLabel` async ; introuvable → repli injecté (`fallbackLabel`).
        GARDE DE FRAÎCHEUR : au retour du vol, n'appliquer que si la sélection est ENCORE cet id
        (l'utilisateur a pu choisir ou effacer entre-temps — sa décision prime sur une réponse tardive). */
    const applyValue = (id: string): void => {
      selected = id;
      reopened = false;   // pose PROGRAMMATIQUE (init, setter `.value`) → état fermé (T6)
      if (id === OptionSearch.EMPTY_VALUE) { selectedLabel = null; render(); return; }
      const cached = source.labelOf(id);
      if (cached !== null) { selectedLabel = cached; render(); return; }
      selectedLabel = null; render();   // inconnu du cache : « Chargement… » le temps du vol
      source.resolveLabel(id).then(
        (label) => { if (selected !== id) return; selectedLabel = label !== null ? label : fallback(id); render(); },
        (error) => {
          // Échec RÉSEAU (≠ introuvable) : MÊME repli — une pastille figée sur « Chargement… »
          // mentirait, et le libellé de repli (à défaut l'id) reste une information exacte.
          if (selected !== id) return;
          console.warn("[picker] résolution du libellé impossible :", error);
          selectedLabel = fallback(id); render();
        },
      );
    };

    // Recherche rouverte puis ABANDONNÉE (focus sorti sans choisir) → re-fermeture (T6), en plus
    // du reset de saisie — parité stricte avec le régime sync.
    EntityPicker.wireSearchReset(root, pop, () => { reopened = false; render(); });

    Object.defineProperty(root, "value", {
      get() { return selected; },
      // Le setter ne déclenche PAS `change` (même contrat que le sync) — mais il RELANCE la
      // résolution du libellé (et, via `applyValue`, ramène l'état fermé) : une valeur posée par
      // programme doit s'afficher, elle aussi.
      set(v: string | null) { applyValue(v == null ? OptionSearch.EMPTY_VALUE : String(v)); },
      configurable: true,
    });
    // `focus()` d'un `<div>` ne fait rien : relais au champ. Si une valeur MASQUE le champ (T6), il
    // faut le ROUVRIR (même geste que le clic pastille) — comme au régime sync.
    root.focus = () => { openSearch(); };

    // Le montage du champ est désormais géré par `render` (T6) : `applyValue` l'appelle et l'ajoute
    // tant qu'il n'y a pas de valeur, ou le retire dès qu'une valeur est posée.
    applyValue(selected);
    return root;
  }

  /* -------------------------------------------- briques PARTAGÉES des deux régimes -- */

  /** Pastille de la VALEUR courante (libellé ellipsé) — STRICTEMENT partagée sync/async : même
      balisage, mêmes styles (le remplissage appartient au `render` de chaque régime). Elle est
      INTERACTIVE (T6) : la CLIQUER rouvre la recherche. L'ACCESSIBILITÉ est portée ICI, dans la
      primitive (principe n°14) : rôle bouton, nom accessible, focusable au clavier et actionnable à
      Entrée/Espace — un `<span>` nu ne serait ni annoncé ni atteignable au clavier. L'anneau de
      focus clavier vient de la règle `:focus-visible` GLOBALE ; l'affordance souris (curseur +
      survol) de l'unique règle `.chip[role="button"]` de dc-manager.css. */
  private static buildValueChip(onActivate: () => void): { chip: HTMLSpanElement; chipText: HTMLSpanElement } {
    const chip = document.createElement("span"); chip.className = "chip";
    chip.style.cssText = "max-width:100%;min-width:0";
    chip.setAttribute("role", "button");
    chip.tabIndex = 0;
    chip.setAttribute("aria-label", I18n.t("ui.entityPicker.edit"));
    chip.onclick = () => onActivate();
    // Entrée/Espace = activation (parité d'un vrai `<button>`) ; on empêche le défilement de la barre
    // d'espace. Le reste des touches passe (navigation clavier normale du formulaire).
    chip.onkeydown = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onActivate(); }
    };
    const chipText = document.createElement("span");
    chipText.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    chip.appendChild(chipText);
    return { chip, chipText };
  }

  /** La saisie ne doit pas SURVIVRE à la sortie du champ : au retour, l'utilisateur retrouverait un
      filtre dont il ne se souvient pas. On attend la fin de la bascule de focus avant de trancher,
      sinon un clic sur le ✕ interne (ou sur la pastille, qui prennent le focus) passerait pour une
      sortie. `onLeave` (T6) est appelé APRÈS le reset quand le focus a bien quitté le contrôle : les
      régimes s'en servent pour RE-FERMER une recherche rouverte puis abandonnée (désarmer `reopened`
      + re-rendre). Câblage STRICTEMENT partagé sync/async. */
  private static wireSearchReset(root: HTMLElement, pop: SearchPop, onLeave?: () => void): void {
    root.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (root.contains(document.activeElement)) return;
        pop.reset();
        if (onLeave) onLeave();
      }, 0);
    });
  }
}
