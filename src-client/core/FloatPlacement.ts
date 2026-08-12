/* =============================================================================
   FloatPlacement — LA règle de placement des surfaces FLOTTANTES ancrées
   (popovers, listes d'autocomplétion, menus de ligne, tooltips), PURE (aucun
   DOM : rects, tailles et viewport sont INJECTÉS — cf. la forme historique de
   `RichTooltip.place`).

   POURQUOI CE MODULE (cadrage C §2.2) : l'app comptait QUATRE règles de
   placement divergentes, chacune recodée dans son composant —
     - `SearchPop.portalPlace` (popover portail + panneau du filtre cible) :
       sous l'ancre avec un écart de 4 px, bascule au-dessus quand la place
       manque dessous ET que la surface tient dessus, recadrage horizontal ;
     - `Autocomplete` : bascule à SEUIL (moins de 220 px dessous et davantage
       dessus), largeur calée sur l'input, maxHeight sur l'espace retenu,
       ancrage par le BAS quand basculée (classe `flip-up`) ;
     - `RowMenu` : aligné à la DROITE du déclencheur, bascule au simple
       débordement bas, marges de 8 px ;
     - `RichTooltip.place` : centré sous l'ancre, clamp DUR au viewport.
   Quatre implémentations d'une même idée, c'est trois occasions de diverger
   (et elles avaient divergé). La géométrie vit désormais ICI, une fois ; les
   composants ne sont plus que de FINS adaptateurs : mesure DOM → appel de la
   règle → application des styles.

   DEUX MÉTHODES SÉMANTIQUES, pas une méga-fonction à drapeaux :
     - `anchored(...)` : la règle GÉNÉRIQUE paramétrée des surfaces INTERACTIVES
       ancrées (popover, liste, menu). Son invariant : l'ALIGNEMENT sur l'ancre
       prime — la surface reste accrochée au champ/déclencheur qu'elle sert,
       quitte à déborder verticalement du viewport (le CSS des consommateurs
       borne la hauteur : max-height 340 px du `.dc-search-pop`, `maxHeight`
       calculé de l'autocomplétion). Recouvrir l'ancre serait masquer le champ
       de saisie que l'utilisateur est en train d'employer.
     - `tooltip(...)` : la politique de `RichTooltip`, D'UNE AUTRE NATURE sur un
       point précis — le clamp DUR aux deux axes (jamais hors écran, collé au
       bord 0 si plus grand que lui), quitte à RECOUVRIR l'ancre. Légitime pour
       un tooltip : il est NON INTERACTIF (`pointer-events:none`), informatif,
       et un tooltip tronqué hors écran ne sert à rien ; inacceptable pour un
       popover interactif (cf. ci-dessus). Elle est bâtie SUR `anchored`
       (alignement `center`, marges nulles) + le clamp vertical — la partie
       commune n'est pas dupliquée, la partie propre reste nommée.

   DOCTRINE AU SCROLL (harmonisée ici, mais APPLIQUÉE par les composants — c'est
   un COMPORTEMENT, pas de la géométrie, donc hors du module pur) :
     - les surfaces ANCRÉES À UN CHAMP **suivent** leur ancre (SearchPop portail
       et panneau du filtre cible repositionnent au scroll/resize, écouté en
       CAPTURE ; l'autocomplétion aussi) — l'utilisateur est en pleine saisie,
       la liste doit rester collée au champ ;
     - les surfaces TRANSITOIRES **ferment** (RowMenu : un menu d'actions dont
       l'ancre défile hors de vue n'a plus de contexte) ou **se retirent**
       (RichTooltip se masque : un tooltip en position:fixed ne suit pas son
       ancre, mieux vaut disparaître que flotter faux).

   RECADRAGE HORIZONTAL — un choix UNIQUE là où deux consommateurs différaient :
   quand la surface est plus large que le viewport moins les marges, c'est la
   borne GAUCHE qui gagne (le contenu commence au bord visible, comportement
   historique de `SearchPop`/`RichTooltip` ; `RowMenu` laissait la borne droite
   gagner — divergence purement théorique, elle exigeait un viewport plus étroit
   que le menu + 16 px).
   ============================================================================= */

/** Rectangle d'ancrage : sous-ensemble PLAT de DOMRect (un `getBoundingClientRect()`
    s'y assigne tel quel), en types simples pour rester testable sans DOM. */
export interface FloatRect { left: number; top: number; right: number; bottom: number; width: number; height: number; }
/** Taille (surface flottante mesurée, ou viewport). */
export interface FloatSize { width: number; height: number; }
/** Point viewport (sortie de la politique tooltip). */
export interface FloatPoint { x: number; y: number; }

/** Alignement HORIZONTAL de la surface sur son ancre :
    - `start`  : bord gauche sur le bord gauche de l'ancre (SearchPop) ;
    - `end`    : bord droit sur le bord droit de l'ancre (RowMenu, menus ⋮) ;
    - `center` : centrée sur l'ancre (tooltips) ;
    - `fill`   : LARGEUR CALÉE sur l'ancre (liste d'autocomplétion sous un input) —
                 pas de recadrage : un décalage « esthétique » désolidariserait
                 visuellement la liste de son champ. */
export type FloatAlign = "start" | "end" | "center" | "fill";

/** Politique de BASCULE au-dessus de l'ancre. La bascule a lieu quand la place
    manque DESSOUS **et** que l'exigence DESSUS est satisfaite. */
export interface FloatFlipRule {
  /** Espace minimal exigé DESSOUS (px) pour rester dessous. Absent → la hauteur
      MESURÉE de la surface (il faut qu'elle tienne). Un SEUIL FIXE (Autocomplete :
      220) sert les surfaces dont la hauteur VARIE avec le contenu filtré — une
      bascule assise sur la hauteur mesurée « battrait » à chaque frappe. */
  minBelow?: number;
  /** Exigence DESSUS pour accepter la bascule :
      - `fits`   (défaut) : la surface doit tenir ENTIÈRE au-dessus (SearchPop —
                  sinon on reste dessous, où le CSS borne la hauteur) ;
      - `more`   : simplement PLUS de place dessus que dessous (Autocomplete —
                  couplé au `maxHeight`, qui comprime la liste dans l'espace élu) ;
      - `always` : aucune (RowMenu — le haut basculé est alors borné par `marginV`). */
  above?: "fits" | "more" | "always";
}

/** Politique de HAUTEUR MAXIMALE (Autocomplete) : `max(floor, espace retenu − inset)`.
    L'espace retenu est la distance BRUTE ancre ↔ bord du viewport du côté élu
    (dessus si basculée, dessous sinon) ; `floor` garantit une liste utilisable
    même acculée au bord, quitte à déborder légèrement. */
export interface FloatMaxHeightRule { floor: number; inset: number; }

export interface FloatAnchoredOptions {
  /** Écart vertical ancre ↔ surface (px). Défaut 4 — l'écart historique des
      popovers (`top: calc(100% + 4px)` du popover absolu d'origine). */
  gap?: number;
  /** Alignement horizontal (défaut `start`). */
  align?: FloatAlign;
  /** Marge de recadrage HORIZONTAL aux bords du viewport (px, défaut 8).
      Sans objet en `fill` (cf. `FloatAlign`). */
  margin?: number;
  /** Marge VERTICALE (px, défaut 0) : entre dans le test de débordement bas ET
      borne le haut d'une surface basculée (RowMenu : 8). */
  marginV?: number;
  /** Politique de bascule (défaut : place manquante dessous + `above: "fits"`). */
  flip?: FloatFlipRule;
  /** Politique de hauteur maximale (absente → `maxHeight: null`). */
  maxHeight?: FloatMaxHeightRule;
}

/** Sortie de `anchored` — des NOMBRES prêts à poser en styles, jamais de chaînes
    (l'arrondi éventuel reste un choix d'adaptateur : SearchPop arrondit, les
    autres posent la valeur exacte — comportements historiques conservés). */
export interface FloatAnchoredResult {
  /** Coordonnée gauche (recadrée aux bords sauf `fill`). */
  left: number;
  /** Largeur IMPOSÉE (alignement `fill` : celle de l'ancre), sinon null. */
  width: number | null;
  /** Coordonnée haute. ⚠ Basculée, elle est bornée à `marginV` et DÉPEND de la
      hauteur mesurée — un consommateur qui s'ancre par le BAS (cf. `bottom`)
      peut passer `size.height: 0` et NE DOIT alors PAS employer `top` basculé. */
  top: number;
  /** Ancrage PAR LE BAS (px depuis le bas du viewport, style `bottom`), pour une
      surface basculée qui doit GRANDIR VERS LE HAUT depuis l'ancre quand son
      contenu change (Autocomplete + classe `flip-up`) : indépendant de la
      hauteur mesurée, jamais borné. Sans objet non basculée. */
  bottom: number;
  /** La surface est-elle AU-DESSUS de l'ancre ? (pilote `flip-up`, l'ancrage à
      employer, et le côté retenu par `maxHeight`). */
  flipped: boolean;
  /** Hauteur maximale calculée, ou null si aucune politique demandée. */
  maxHeight: number | null;
}

export class FloatPlacement {
  /** Place une surface flottante INTERACTIVE sous (ou au-dessus de) son ancre.
      Voir l'en-tête du module pour les invariants ; les paramétrages exacts des
      quatre consommateurs vivent dans leurs adaptateurs respectifs. */
  static anchored(anchor: FloatRect, size: FloatSize, viewport: FloatSize, options: FloatAnchoredOptions = {}): FloatAnchoredResult {
    const gap = options.gap !== undefined ? options.gap : 4;
    const align = options.align || "start";
    const margin = options.margin !== undefined ? options.margin : 8;
    const marginV = options.marginV !== undefined ? options.marginV : 0;
    const flipRule = options.flip || {};

    /* -- Axe VERTICAL : dessous d'abord, bascule selon la politique. Les espaces
       sont mesurés APRÈS écart et marge : c'est la place réellement disponible
       pour la surface elle-même. */
    const spaceBelow = viewport.height - marginV - (anchor.bottom + gap);
    const spaceAbove = anchor.top - gap - marginV;
    const needBelow = flipRule.minBelow !== undefined ? flipRule.minBelow : size.height;
    const aboveRule = flipRule.above || "fits";
    const aboveOk = aboveRule === "always" ? true
      : aboveRule === "more" ? spaceAbove > spaceBelow
      : spaceAbove >= size.height;
    const flipped = needBelow > spaceBelow && aboveOk;

    /* Basculée : borne `marginV` au cas où la surface ne tient pas entière dessus
       (politiques `more`/`always` — avec `fits`, la borne est un no-op par
       construction). Non basculée : jamais de borne basse — recouvrir l'ancre
       masquerait le champ servi (cf. en-tête ; le tooltip, lui, l'assume). */
    const top = flipped ? Math.max(marginV, anchor.top - gap - size.height) : anchor.bottom + gap;
    const bottom = viewport.height - anchor.top + gap;

    /* -- Hauteur maximale : sur l'espace BRUT du côté élu (cf. FloatMaxHeightRule). */
    let maxHeight: number | null = null;
    if (options.maxHeight) {
      const room = (flipped ? anchor.top : viewport.height - anchor.bottom) - options.maxHeight.inset;
      maxHeight = Math.max(options.maxHeight.floor, room);
    }

    /* -- Axe HORIZONTAL : alignement puis recadrage (borne GAUCHE gagnante, cf.
       en-tête). `fill` échappe au recadrage : la largeur EST celle de l'ancre. */
    let left: number;
    let width: number | null = null;
    if (align === "fill") { left = anchor.left; width = anchor.width; }
    else {
      const aligned = align === "end" ? anchor.right - size.width
        : align === "center" ? anchor.left + anchor.width / 2 - size.width / 2
        : anchor.left;
      left = Math.max(margin, Math.min(aligned, viewport.width - size.width - margin));
    }

    return { left, width, top, bottom, flipped, maxHeight };
  }

  /** Politique TOOLTIP (`RichTooltip.place` délègue ici) : centré sous l'ancre,
      bascule `fits`, puis clamp DUR au viewport sur les DEUX axes — jamais de
      coordonnée négative, collé au bord 0 quand le tooltip est plus grand que
      l'écran. Voir l'en-tête (« deux méthodes sémantiques ») pour le POURQUOI
      cette politique reste distincte de `anchored`. */
  static tooltip(anchor: FloatRect, tip: FloatSize, viewport: FloatSize, gap: number): FloatPoint {
    const placed = FloatPlacement.anchored(anchor, tip, viewport, { gap, align: "center", margin: 0 });
    /* Le recadrage horizontal marge 0 de `anchored` équivaut déjà au clamp dur en X
       (borne gauche gagnante → x = 0 quand le tooltip déborde des deux côtés) ;
       seul l'axe Y reste à clore ici. */
    const y = Math.max(0, Math.min(placed.top, Math.max(0, viewport.height - tip.height)));
    return { x: placed.left, y };
  }
}
