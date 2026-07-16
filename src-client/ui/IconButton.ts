/* =============================================================================
   IconButton — constructeur PARTAGÉ du bouton d'action à icône.

   Raison d'être : sans lui, chaque vue re-fabrique son bouton (classes, aria,
   innerHTML, tooltip) et les styles divergent. Un seul point de fabrication →
   un seul style dans toute l'app, et les règles d'accessibilité ne peuvent pas
   être oubliées quelque part.

   Fait équipe avec :
   - `ui/Icons` — le registre : UNE intention = UNE icône, réutilisée partout ;
   - `ui/RichTooltip` — la mini-doc (`tipKey`), pour ce que l'icône ne dit pas.

   ACCESSIBILITÉ (non négociable — une icône seule n'a pas de nom) : `aria-label`
   ET `title` court sont TOUJOURS posés. Ils sont les seuls supports des lecteurs
   d'écran, et le repli natif si le moteur de tooltip ne tourne pas.
   ============================================================================= */

export interface IconButtonOpts {
  /** SVG de CONFIANCE — une constante de `ui/Icons`, jamais une donnée saisie. */
  icon: string;
  /** Nom accessible + tooltip natif de repli. OBLIGATOIRE : sans lui le bouton est muet. */
  label: string;
  /** Clé d'un contenu `RichTooltip` (mini-doc). Facultatif : le `title` suffit aux actions évidentes. */
  tipKey?: string;
  /** Teinte le survol en rouge (suppression, révocation…). */
  danger?: boolean;
  disabled?: boolean;
  /** Attribut `data-act` — utilisé par les listings qui délèguent le clic au conteneur. */
  act?: string;
  onClick?: () => void;
}

export class IconButton {
  /** Construit le bouton (DOM). */
  static build(o: IconButtonOpts): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn-ghost btn-sm icon-action" + (o.danger ? " danger" : "");
    b.innerHTML = o.icon;                     // constante de confiance (ui/Icons)
    b.setAttribute("aria-label", o.label);
    b.title = o.label;
    if (o.tipKey) b.setAttribute("data-rich-tooltip", o.tipKey);
    if (o.act) b.setAttribute("data-act", o.act);
    if (o.disabled) b.disabled = true;
    if (o.onClick) b.onclick = o.onClick;
    return b;
  }

  /** Préfixe une icône SVG à un bouton TEXTE déjà construit (ex. `DcBase.btn(...)`), sous forme d'un
      `<span class="gi">` avant le libellé. Pour les panneaux d'outils et actions qui gardent leur
      texte mais gagnent une icône. `icon` = SVG de confiance (`ui/Icons`). */
  static decorate(btn: HTMLElement, icon: string): void {
    btn.insertAdjacentHTML("afterbegin", '<span class="gi" aria-hidden="true">' + icon + "</span>");
  }

  /** Même bouton, rendu en CHAÎNE HTML — pour les listings qui peignent leur corps en une passe
      (`innerHTML`) plutôt qu'en assemblant des nœuds. `label` est échappé : il finit dans des
      attributs. `icon` ne l'est pas — c'est un SVG de confiance, et l'échapper l'afficherait
      littéralement. */
  static html(o: IconButtonOpts): string {
    const esc = (s: string) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const cls = "btn btn-ghost btn-sm icon-action" + (o.danger ? " danger" : "");
    return `<button type="button" class="${cls}"`
      + (o.act ? ` data-act="${esc(o.act)}"` : "")
      + ` title="${esc(o.label)}" aria-label="${esc(o.label)}"`
      + (o.tipKey ? ` data-rich-tooltip="${esc(o.tipKey)}"` : "")
      + (o.disabled ? " disabled" : "")
      + `>${o.icon}</button>`;
  }
}
