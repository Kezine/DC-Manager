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

  /** Fermer / annuler / retirer une ligne (remplace `✕`) : croix. */
  static readonly CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';

  /** Importer (remplace `📥`) : flèche entrant dans un bac. */
  static readonly IMPORT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 8l5-5 5 5"/><path d="M12 3v12"/></svg>';

  /** Créer / ajouter (remplace `＋`) : plus. */
  static readonly PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

  /** Valider / confirmer (remplace `✓`) : coche. */
  static readonly CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 6.5"/></svg>';

  /** Démarrer / lancer (mise en cours d'une intervention…) : triangle « play ». */
  static readonly PLAY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4.5l12 7.5-12 7.5z"/></svg>';

  /** Rechercher : loupe. Icône INTÉGRÉE au champ de recherche des barres de listing (revue design lot C). */
  static readonly SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>';

  /* ------------------------------------------------------------------------
     ÉTAT / MÉTADONNÉES — verrou, défaut (étoile), identité.
     ------------------------------------------------------------------------ */

  /** Verrouillé (remplace `🔒`) : cadenas fermé. */
  static readonly LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>';

  /** Déverrouillé (remplace `🔓`) : cadenas ouvert (l'anse écartée). */
  static readonly UNLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 7.5-2"/></svg>';

  /** Défaut / favori ACTIF (remplace `★`) : étoile pleine. */
  static readonly STAR = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 3l2.6 5.6 6 .7-4.4 4.1 1.2 6L12 16.9 6.6 19.4l1.2-6L3.4 9.3l6-.7z"/></svg>';

  /** Défaut INACTIF (remplace `☆`) : étoile contour. */
  static readonly STAR_OUTLINE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l2.6 5.6 6 .7-4.4 4.1 1.2 6L12 16.9 6.6 19.4l1.2-6L3.4 9.3l6-.7z"/></svg>';

  /** Utilisateur connecté (remplace `👤`) : buste. */
  static readonly USER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M5 21v-1a7 7 0 0 1 14 0v1"/></svg>';

  /* ------------------------------------------------------------------------
     FICHIERS & DOCUMENTS — pickers, liste de documents.
     ------------------------------------------------------------------------ */

  /** Document / fichier JSON (remplace `📄`) : feuille au coin plié. */
  static readonly FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';

  /** Fichier compagnon d'IMAGES (remplace `🖼`) : cadre + montagne. */
  static readonly IMAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.6"/><path d="M21 16l-5-5-7 7"/></svg>';

  /** Document ouvert / liste de documents (remplace `🗂`) : dossier. */
  static readonly FOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

  /* ------------------------------------------------------------------------
     OUTILS DE VUE 2D/3D — titres des panneaux, boutons d'outil.
     ------------------------------------------------------------------------ */

  /** Mesure (remplace `📏`) : règle inclinée graduée. */
  static readonly MEASURE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2.5l7 7L9.5 21.5l-7-7z"/><path d="M8 7l1.5 1.5M11 10l1.5 1.5M14 7l1.5 1.5M17 10l1.5 1.5"/></svg>';

  /** Positionnement (remplace `📐`) : équerre. */
  static readonly POSITION = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v16h16z"/><path d="M4 9h4M4 14h9"/></svg>';

  /** Route de câble (remplace `🧵`) : tracé jalonné. */
  static readonly ROUTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><path d="M6.5 17.5c3-1 4-4 2-6s1-5 4-6"/></svg>';

  /** Porte (remplace `🚪`) : battant + poignée. */
  static readonly DOOR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v17"/><path d="M3 21h18"/><circle cx="12.5" cy="12" r="0.9" fill="currentColor"/></svg>';

  /** Point d'ancrage (remplace `⚓`) : ancre. */
  static readonly ANCHOR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="21"/><path d="M5 13a7 7 0 0 0 14 0"/><line x1="5" y1="13" x2="8" y2="13"/><line x1="16" y1="13" x2="19" y2="13"/></svg>';

  /* ------------------------------------------------------------------------
     RÉSEAU — pastilles (alimentation / réseau IP) et types de spare.
     ------------------------------------------------------------------------ */

  /** Alimentation électrique (remplace `⚡`) : éclair. */
  static readonly POWER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>';

  /** Réseau IP (remplace `🌐`) : globe méridiens. */
  static readonly NETWORK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.5 4 5.7 4 9s-1.4 6.5-4 9c-2.6-2.5-4-5.7-4-9s1.4-6.5 4-9z"/></svg>';

  /* ------------------------------------------------------------------------
     FAMILLES d'objets liables (interventions) — icône de FAMILLE (pas de TYPE) :
     un équipement, une VM ou un spare, indépendamment de son type précis. Vivent
     ICI (et non dans domain/constants avec les icônes de TYPE) car elles servent
     une UI TRANSVERSE — la liste des objets liés d'une intervention confond les
     trois familles — et sont réutilisables comme repère de navigation générique.
     ------------------------------------------------------------------------ */

  /** Famille « équipement » : châssis rackable (deux rangées + voyants). */
  static readonly EQUIPMENT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><line x1="7" y1="7.5" x2="7.02" y2="7.5"/><line x1="7" y1="16.5" x2="7.02" y2="16.5"/></svg>';

  /** Famille « VM » : machine VIRTUELLE — un cadre écran contenant un cadre imbriqué. */
  static readonly VM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="13" rx="2"/><rect x="7" y="8" width="10" height="5" rx="1"/><line x1="9" y1="20.5" x2="15" y2="20.5"/></svg>';

  /** Famille « spare » (pièce de rechange) : petit carton/boîte. */
  static readonly SPARE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/></svg>';

  /* NB : les icônes de TYPE du domaine (équipements, rack-items, spare) vivent dans
     `domain/constants.ts` avec leurs entités, pas ici (ce registre = icônes d'ACTION/nav
     génériques). Elles y sont au même format : inner markup enveloppé par le consommateur. */

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

  /* ------------------------------------------------------------------------
     ONGLETS — repères de NAVIGATION de la barre d'onglets (rendue en ICÔNES sur
     desktop ; icône + libellé dans les menus déroulants). Nommées par INTENTION
     (le DOMAINE de l'onglet), donc RÉUTILISÉES partout où ce domaine reparaît :
     un sous-onglet « Types de câble » reprend CABLE, « Adresses IP » reprend
     IPAM, « Salles » reprend DATACENTER… (une intention = une icône). Même
     facture que ci-dessus (24×24, fill:none, stroke currentColor, bouts ronds).
     ------------------------------------------------------------------------ */

  /** Câblage / câbles : deux connecteurs reliés par un brin. */
  static readonly CABLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="9" width="6" height="6" rx="1.2"/><rect x="15.5" y="9" width="6" height="6" rx="1.2"/><line x1="8.5" y1="12" x2="15.5" y2="12"/></svg>';

  /** Faisceau / trunk : gaine renfermant plusieurs brins (points). */
  static readonly BUNDLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="8" width="20" height="8" rx="4"/><circle cx="8" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="1.1" fill="currentColor" stroke="none"/></svg>';

  /** Type de port / connecteur : embase à ergots. */
  static readonly PORT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="9" width="16" height="10" rx="1.5"/><path d="M8 9V6.5a4 4 0 0 1 8 0V9"/><line x1="9" y1="19" x2="9" y2="21"/><line x1="15" y1="19" x2="15" y2="21"/></svg>';

  /** IPAM / adressage IP : arborescence de sous-réseaux. */
  static readonly IPAM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="4" rx="1"/><rect x="3" y="17" width="6" height="4" rx="1"/><rect x="15" y="17" width="6" height="4" rx="1"/><path d="M12 7v5M6 17v-5h12v5"/></svg>';

  /** Netmap / graphe : nœuds reliés par des arêtes. */
  static readonly GRAPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="8" r="2"/><circle cx="11" cy="18" r="2"/><path d="M6.8 6.9 9.4 16.2M17.2 9.4 12.6 16.4M6.9 6.4 17.1 7.7"/></svg>';

  /** Datacenter / salle : baies alignées d'une salle serveur. */
  static readonly DATACENTER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="16" rx="1"/><path d="M5 8h3M16 8h3M5 12h3M16 12h3M5 16h3M16 16h3"/></svg>';

  /** Site / bâtiment : immeuble à porte et fenêtres. */
  static readonly SITE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V6l8-3 8 3v15"/><line x1="2.5" y1="21" x2="21.5" y2="21"/><path d="M9.5 21v-4h5v4"/><line x1="8" y1="9" x2="8.02" y2="9"/><line x1="16" y1="9" x2="16.02" y2="9"/><line x1="8" y1="13" x2="8.02" y2="13"/><line x1="16" y1="13" x2="16.02" y2="13"/></svg>';

  /** Étage / plan d'étage : niveaux empilés. */
  static readonly FLOOR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="M3 12l9 5 9-5"/><path d="M3 16l9 5 9-5"/></svg>';

  /** Groupe (regroupement logique) : trois éléments assemblés. */
  static readonly GROUP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="8" y="13" width="8" height="8" rx="1.5"/></svg>';

  /** Certificats (domaine PKI) : feuille signée d'un sceau à ruban. */
  static readonly CERTIFICATE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="1.5"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="13" y2="12"/><circle cx="15.5" cy="16" r="3"/><path d="M13.8 18.3 13 21l2.5-1.4L18 21l-.8-2.7"/></svg>';

  /** Interventions / maintenance : clé à molette. */
  static readonly INTERVENTION = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0-5.66 5.66l-6.7 6.7a1.5 1.5 0 0 0 2.12 2.12l6.7-6.7a4 4 0 0 0 5.66-5.66l-2.83 2.83-2.12-.71-.71-2.12z"/></svg>';

  /** Notifications : cloche. */
  static readonly NOTIFICATION = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

  /** Paramètres : engrenage. */
  static readonly SETTINGS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M19.1 4.9l-2.2 2.2M7.1 16.9l-2.2 2.2"/></svg>';

  /* ------------------------------------------------------------------------
     APPARENCE — repères des bascules de réglages (thème, plein écran). Servent
     de LÉGENDE aux toggles `.mode-switch` de la section « Apparence » (soleil/lune
     = thème clair/sombre, écran étendu = modales plein écran). Même facture
     (24×24, fill:none, stroke currentColor, bouts ronds).
     ------------------------------------------------------------------------ */

  /** Thème CLAIR : soleil (astre + rayons). Repère de gauche (état décoché) de la bascule de thème. */
  static readonly SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8l1.8-1.8M18 6l1.8-1.8"/></svg>';

  /** Thème SOMBRE : lune (croissant). Repère de droite (état coché) de la bascule de thème. */
  static readonly MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>';

  /** Plein écran : quatre coins qui s'écartent. Repère de la bascule « modales en plein écran ». */
  static readonly FULLSCREEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
}
