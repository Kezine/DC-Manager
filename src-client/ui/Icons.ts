/* =============================================================================
   Icons — REGISTRE CENTRAL des icônes SVG de l'application.

   ┌─ RÈGLE (la seule qui empêche la prolifération) ───────────────────────────┐
   │ Les icônes sont nommées par INTENTION, jamais par forme (`DELETE`, pas    │
   │ `TRASH` ; `INFO`, pas `CIRCLE_I`). UNE intention = UNE icône, RÉUTILISÉE  │
   │ partout : `Icons.DELETE` est LA suppression — page Certificats, liste     │
   │ d'équipements, baies, câbles. On ne crée pas « supprimer un câble ».      │
   │                                                                            │
   │ On n'ajoute donc une icône que pour une intention NOUVELLE. Si une action  │
   │ « supprime », « exporte » ou « informe », elle réutilise l'existante — et  │
   │ c'est son TOOLTIP (cf. ui/RichTooltip) qui porte la nuance, pas un dessin  │
   │ de plus. Toute icône de l'app naît ICI ou n'existe pas.                    │
   └────────────────────────────────────────────────────────────────────────────┘

   FACTURE COMMUNE (identique à DC_SCOPE_ICONS / .graph-icon-btn) : viewBox
   24×24, `fill:none` + `stroke="currentColor"` → l'icône prend la couleur de son
   hôte (donc `var(--accent)` quand il est actif, `var(--err)` en variante
   danger). stroke-width 2, bouts ronds. La TAILLE vient du CSS de l'hôte
   (`.icon-btn svg`, `.ricon svg`, `.row-menu-ic svg`), jamais d'un attribut :
   une même constante sert en bouton, en menu et en tooltip.

   POURQUOI DU SVG, et pas des caractères : les glyphes de police (`ⓘ`, `✎`, `⋮`)
   dépendent de la police disponible et ne s'alignent pas sur la grille des
   traits ; les EMOJI (`📍`, `⬇`) sont des bitmaps COULEUR — ils pixellisent au
   zoom, ignorent `currentColor` et jurent avec le thème.

   Ces chaînes sont des CONSTANTES du code, jamais des données saisies : elles
   sont les seules valeurs qu'on autorise en innerHTML (cf. RichTooltip.render).
   ============================================================================= */
export class Icons {
  /* ------------------------------------------------------------------------
     ACTIONS — ce qu'on FAIT à un objet. Réutilisées dans TOUS les listings.
     ------------------------------------------------------------------------ */

  /** Consulter le détail (remplace le glyphe `ⓘ`). */
  static readonly INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16.5"/><line x1="12" y1="7.6" x2="12" y2="7.7"/></svg>';

  /** Modifier (remplace `✎`) : crayon. */
  static readonly EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';

  /** Supprimer DÉFINITIVEMENT (l'objet cesse d'exister) : corbeille. LA suppression de l'app —
      certificats, équipements, baies, câbles… tous la partagent.

      ⚠️ NE PAS l'employer pour « retirer d'un conteneur » : démonter un équipement d'une baie
      (`RackForms.removeMount` → `rack_id: null`) ne détruit RIEN, l'équipement survit en mode
      manuel. Une corbeille y ferait croire à une destruction — ces boutons gardent donc leur
      croix. Intention différente = icône différente ; c'est tout l'intérêt de nommer par
      intention plutôt que par forme. */
  static readonly DELETE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

  /** Révoquer : cercle barré (l'objet existe encore mais ne vaut plus — distinct de la corbeille). */
  static readonly REVOKE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/></svg>';

  /** Exporter / télécharger : flèche descendante vers un bac. (Sert AUSSI au « Télécharger » des listings.) */
  static readonly EXPORT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';

  /** Dupliquer (remplace `⧉`) : deux feuillets décalés. */
  static readonly CLONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';

  /** Localiser dans les vues 2D/3D (remplace l'emoji `📍`) : épingle. */
  static readonly LOCATE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/></svg>';

  /** Plus d'actions (remplace `⋮`) : points verticaux — ouvre le menu overflow. */
  static readonly MORE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/></svg>';

  /* ------------------------------------------------------------------------
     OBJETS DU DOMAINE — ce sur QUOI on agit (émission, contenu de baie…).
     ------------------------------------------------------------------------ */

  /** Émettre un certificat TLS : sceau/rosette signée. */
  static readonly ISSUE_TLS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="6"/><path d="M9 14.5L8 22l4-2 4 2-1-7.5"/></svg>';

  /** Émettre un certificat SSH : clé (le pendant SSH du sceau X.509). */
  static readonly ISSUE_SSH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2"/><path d="M17 6l3 3"/><path d="M14 9l3 3"/></svg>';

  /** Déploiement des certificats : bouclier (la CONFIANCE) posé sur une machine cliente. */
  static readonly TRUST_DEPLOY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l7 3v6c0 4.4-3 8.3-7 9.5C8 19.3 5 15.4 5 11V5z"/><path d="M9 11.5l2 2 4-4.5"/></svg>';

  /** Ouvrir le listing des certificats d'une autorité : liste hiérarchique (arbre). */
  static readonly CERT_LIST = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="6" x2="21" y2="6"/><line x1="12" y1="12" x2="21" y2="12"/><line x1="12" y1="18" x2="21" y2="18"/><path d="M4 4v11a3 3 0 0 0 3 3h2"/><path d="M4 11h5"/></svg>';

  /** Contenu d'une baie / montage des U (remplace `▦`) : rangées empilées. */
  static readonly RACK_CONTENT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg>';
}
