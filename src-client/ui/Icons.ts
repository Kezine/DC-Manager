/* =============================================================================
   Icons — jeu d'ICÔNES SVG partagées (constantes de CONFIANCE).

   Facture commune (identique à DC_SCOPE_ICONS / .graph-icon-btn) : viewBox 24×24,
   `fill:none` + `stroke="currentColor"` → l'icône prend la couleur du bouton
   (donc `var(--accent)` quand il est actif/teinté), stroke-width 2, bouts ronds.
   La TAILLE est imposée par le CSS de l'hôte (`.icon-btn svg`, `.ricon svg`…),
   jamais par l'attribut — une même icône sert en bouton et en tooltip.

   Ces chaînes sont des CONSTANTES du code, jamais des données saisies : elles
   sont les seules valeurs qu'on autorise en innerHTML (cf. RichTooltip.render).
   ============================================================================= */
export class Icons {
  /** Export / téléchargement : flèche descendante vers un bac. */
  static readonly EXPORT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';

  /** Révoquer : cercle barré (interdit) — l'objet existe encore mais ne vaut plus. */
  static readonly REVOKE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/></svg>';

  /** Supprimer : corbeille (destruction définitive — distincte du cercle barré). */
  static readonly DELETE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

  /** Émettre un certificat TLS : sceau/rosette signée. */
  static readonly ISSUE_TLS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="6"/><path d="M9 14.5L8 22l4-2 4 2-1-7.5"/></svg>';

  /** Émettre un certificat SSH : clé (le pendant SSH du sceau X.509). */
  static readonly ISSUE_SSH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2"/><path d="M17 6l3 3"/><path d="M14 9l3 3"/></svg>';
}
