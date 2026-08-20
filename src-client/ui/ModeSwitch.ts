/* =============================================================================
   ModeSwitch — les BASCULES SLIDER de l'application (primitive UI, principe n°14).
   -----------------------------------------------------------------------------
   Deux formes, un seul langage visuel (CSS `.mode-switch*`) :
     · `binary()`  — deux états (oui/non, local/api, clair/sombre) : la case à
       cocher est CACHÉE, la piste et le pouce sont peints par le CSS ;
     · `tri()`     — TROIS positions (ex. thème clair · auto · sombre), un groupe
       de RADIOS caché sous la même piste, le pouce glissant aux tiers.

   POURQUOI DES RADIOS (et pas trois boutons). Un groupe de radios de même `name`
   donne GRATUITEMENT la sémantique de choix exclusif, la navigation aux FLÈCHES,
   un seul point d'entrée dans l'ordre de tabulation et l'annonce « 2 sur 3 » aux
   lecteurs d'écran. Les zones cliquables sont de vrais `<label for>` posés au-dessus
   de la piste : le clic au doigt tombe sur la position visée, pas sur un pixel de
   pouce.

   🚨 LE CSS NE CONNAÎT PAS LES VALEURS. La position du pouce est choisie par
   `input:nth-of-type(n):checked` — par RANG, jamais par `[value="auto"]`. Un futur
   appelant (densité, granularité…) réutilise donc le contrôle sans toucher à la
   feuille de style.

   ⚠ Ces contrôles n'ont AUCUNE règle métier : ils ne persistent rien et ne lisent
   aucune préférence. L'appelant câble `onChange` et reflète l'état par `setValue`
   (qui, lui, ne rappelle PAS `onChange` — un reflet n'est pas un geste).
   ============================================================================= */

import { OverlayA11y } from "./OverlayA11y";

/** Une position du contrôle à trois états : la valeur rendue et son libellé accessible. */
export interface ModeSwitchOption { value: string; label: string; }

/** Contrôle à trois positions, tel que le manipule l'appelant. */
export interface TriSwitch {
  /** Élément à insérer (le groupe entier : radios + piste + zones cliquables). */
  root: HTMLElement;
  /** Position affichée, SANS déclencher `onChange` (reflet d'un état décidé ailleurs). */
  setValue(value: string): void;
  /** Position courante (chaîne vide si aucune — cas d'un `setValue` hors options). */
  value(): string;
}

export class ModeSwitch {
  /** Bascule à DEUX états : `<label class="mode-switch">` (case cachée + piste). L'`id` est TOUJOURS
      posé pour qu'une ligne de réglage puisse pointer dessus (`<label for>`) et rendre le LIBELLÉ
      cliquable — un intitulé de trois mots est une cible bien plus confortable que le pouce lui-même.
      Le câblage `onchange` et l'étiquetage restent à la charge de l'appelant. */
  static binary(): { label: HTMLLabelElement; input: HTMLInputElement } {
    const label = document.createElement("label"); label.className = "mode-switch";
    const input = document.createElement("input"); input.type = "checkbox"; input.id = OverlayA11y.nextId("dcm-switch");
    const track = document.createElement("span"); track.className = "mode-switch-track"; track.setAttribute("aria-hidden", "true");
    label.append(input, track);
    return { label, input };
  }

  /** Bascule à TROIS positions. `options` est lu DANS L'ORDRE (gauche → droite) ; `mark` est un repère
      d'un ou deux caractères peint au CENTRE de la piste (ex. « A » pour auto) et masqué quand cette
      position est justement sélectionnée — le pouce l'y recouvrirait, et la position parle alors
      d'elle-même. */
  static tri(opts: { groupLabel: string; options: ModeSwitchOption[]; mark?: string; onChange: (value: string) => void }): TriSwitch {
    const root = document.createElement("div"); root.className = "mode-switch3";
    root.setAttribute("role", "radiogroup"); root.setAttribute("aria-label", opts.groupLabel);
    const name = OverlayA11y.nextId("dcm-triswitch");

    // 1) les RADIOS d'abord : le CSS place le pouce par sélecteur de FRÈRE SUIVANT (`~`), donc les
    //    entrées doivent précéder la piste dans le DOM.
    const inputs: HTMLInputElement[] = opts.options.map((option) => {
      const input = document.createElement("input");
      input.type = "radio"; input.name = name; input.id = name + "-" + option.value; input.value = option.value;
      input.setAttribute("aria-label", option.label); input.title = option.label;
      // `change` ne se déclenche QUE sur la position nouvellement cochée (le navigateur décoche l'autre
      // en silence) : un seul rappel par geste, jamais deux.
      input.onchange = () => { if (input.checked) opts.onChange(option.value); };
      root.appendChild(input);
      return input;
    });

    // 2) la PISTE (décorative : le contrôle réel, ce sont les radios).
    const track = document.createElement("span"); track.className = "mode-switch3-track"; track.setAttribute("aria-hidden", "true");
    if (opts.mark) { const m = document.createElement("span"); m.className = "mode-switch3-mark"; m.textContent = opts.mark; track.appendChild(m); }
    const thumb = document.createElement("span"); thumb.className = "mode-switch3-thumb"; track.appendChild(thumb);
    root.appendChild(track);

    // 3) les ZONES CLIQUABLES, par-dessus la piste. Un `<label for>` par position : le clic coche la
    //    radio correspondante (donc déclenche `change`) sans qu'aucun gestionnaire de coordonnées ne
    //    soit à écrire. `aria-hidden` : la radio porte déjà le libellé, l'annoncer deux fois bavarde.
    for (const option of opts.options) {
      const hit = document.createElement("label");
      hit.className = "mode-switch3-hit"; hit.htmlFor = name + "-" + option.value; hit.title = option.label;
      hit.setAttribute("aria-hidden", "true");
      root.appendChild(hit);
    }

    return {
      root,
      setValue: (value: string) => { inputs.forEach((input) => { input.checked = (input.value === value); }); },
      value: () => { const on = inputs.find((input) => input.checked); return on ? on.value : ""; },
    };
  }

  /** Petite pastille d'ICÔNE flanquant une bascule (légende décorative : soleil/lune du thème,
      fenêtre flottante / plein écran des modales). Purement visuelle — d'où `aria-hidden` : le
      contrôle porte déjà son libellé, et une icône annoncée en plus ne dirait rien de neuf. */
  static icon(svg: string): HTMLElement {
    const s = document.createElement("span"); s.className = "mode-switch-icon"; s.setAttribute("aria-hidden", "true"); s.innerHTML = svg; return s;
  }
}
