/* ============================================================================
   LABELLAYOUT — GÉOMÉTRIE PURE des étiquettes QR imprimables (lot E du chantier
   étiquettes QR). Documentation : docs/qr-scan.md § « Étiquettes imprimables ».
   La maquette design-system/briefs/qr-etiquettes-imprimables-maquette.html FAIT
   FOI : les cotes de ce module reprennent les valeurs EXACTES de son script
   (table `SIZES`, `cableGeom`, `stripGeom`, bornes des champs « Personnalisé »),
   AMENDÉES par les retours terrain du 2026-08-20 : densité COMPACTE = marges
   nulles (seule la quiet zone du SVG garde le QR), le QR d'un préréglage ne
   déborde JAMAIS (cf. rectPadding / rectQrGeometry), et — retours des étiquettes
   IMPRIMÉES — l'enroulement des MANCHONS passe de « 2 tours + recouvrement » à
   **1,5 tour dont le demi-tour excédentaire EST le recouvrement** (cf.
   sleeveGeometry), avec un nombre de répétitions DÉDUIT de la longueur visible
   au lieu d'un 6 figé (cf. sleeveRepeats).

   Aucun DOM, aucun réseau, aucune chaîne traduite : les avertissements sont des
   CODES (`LabelWarning`), l'UI (ui/LabelPrintDialog) les traduit — même doctrine
   que `core/ScanParsing` ou `src-shared/PowerAnalysis`. Testé en isolation :
   Tests/modules/test-labels.js.

   UNITÉS : tout est en MILLIMÈTRES (l'imprimé est en mm CSS ; l'écran n'est
   qu'un aperçu mis à l'échelle). Les mm des QR INCLUENT la quiet zone (4 modules
   de blanc DANS le SVG servi par la route `/qr` — cf. core/LabelQrSvg).

   ⚠ CELLULE DE PLANCHE ≠ ÉTIQUETTE. Sur une planche A4, chaque étiquette occupe
   une CELLULE de la grille (colonne `cell` de la table des gabarits) et s'étire
   dedans : c'est ce qui permet « M → 4 × 8 = 32 par feuille » (cellule 48 mm de
   large : 4 × 48 = 192 ≤ 194 mm utiles) alors que l'étiquette M nominale fait
   50 mm. Le plafond de colonnes se calcule donc sur la CELLULE, jamais sur la
   cote nominale — les gabarits sans cellule dédiée (personnalisé, QR seul,
   drapeau/manchon) prennent leurs dimensions réelles comme cellule.
   ============================================================================ */

/** Identifiants des gabarits (préréglages + personnalisé). */
export type LabelSizeId = "s" | "m" | "l" | "rack" | "cable" | "custom";

/** Contenu de l'étiquette : QR + texte / QR seul / manchon sans QR (repère
    complet ou identifiant répété) — les deux derniers réservés aux câbles. */
export type LabelContentId = "full" | "qr" | "strip" | "id";

/** Codes d'avertissement (traduits par l'UI — jamais de chaîne ici). */
export type LabelWarning =
  | "qr-floor"          // QR sous le plancher de scannabilité (18 mm)
  | "qr-exceeds-label"  // le QR (+ marges) ne tient pas dans l'étiquette demandée
  | "columns-capped"    // colonnes demandées > plafond par la largeur réelle
  | "multi-page"        // la planche déborde sur plusieurs feuilles A4
  | "sleeve-tight"      // manchon : le texte estimé dépasse la longueur le long du câble
  | "module-too-small"; // un MODULE de QR sous 0,5 mm — illisible sur une thermique 203 dpi (Q11.14)

/** Résolution d'impression VISÉE, en points par pouce. Trois valeurs seulement, parce que
    ce sont les trois classes de machines du terrain : thermique d'étiquettes (203), laser
    bureautique (300, le défaut) et laser de production (600). Elle ne change RIEN au
    document produit — elle sert uniquement à QUANTIFIER la cote du QR (cf. quantizeQrMm). */
export type LabelDpi = 203 | 300 | 600;

/** Un préréglage de gabarit : QR (mm), cote nominale (w × h) et CELLULE de planche. */
export interface LabelPresetSpec {
  qr: number;
  w: number;
  h: number;
  /** Cellule de grille sur une planche A4 (cf. en-tête — l'étiquette s'y étire). */
  cell: readonly [number, number];
}

/** Réglages GÉOMÉTRIQUES d'un tirage (sous-ensemble de l'état de la modale). */
export interface LabelSpec {
  size: LabelSizeId;
  content: LabelContentId;
  compact: boolean;
  /** Taille de QR (mm) — consommée par « QR seul », « câble » et « personnalisé »
      (les autres préréglages imposent la leur via la table). */
  qr: number;
  /** Cotes du gabarit « personnalisé » (mm). */
  custom: { w: number; h: number };
  /** Manchon : Ø du câble et longueur le long du câble (mm). */
  dia: number;
  len: number;
  /** « QR seul » : une ligne propriétaire ajoute une bande sous le carré. */
  hasOwner: boolean;
  /** Résolution d'impression visée — SEUL champ ajouté au spec par le chantier T11.
      Absente ⇒ aucune quantification (les gabarits golden restent au millimètre nominal). */
  dpi?: LabelDpi;
}

export class LabelLayout {
  /** Table des gabarits — valeurs EXACTES du script `SIZES` de la maquette.
      `cable` : cote nominale = drapeau CONFORT (le compact donne 54 × 20,4 — dérivé, cf. flagGeometry). */
  static readonly PRESETS: Readonly<Record<Exclude<LabelSizeId, "custom">, LabelPresetSpec>> = {
    s: { qr: 18, w: 50, h: 20, cell: [50, 20] },
    m: { qr: 20, w: 50, h: 30, cell: [48, 33] },
    l: { qr: 28, w: 70, h: 40, cell: [70, 40] },
    rack: { qr: 34, w: 100, h: 60, cell: [100, 60] },
    cable: { qr: 18, w: 62, h: 22, cell: [62, 22] },
  };

  /** Plancher de SCANNABILITÉ : un QR (quiet zone comprise) sous 18 mm ne se scanne
      fiablement que de très près — signalé, jamais interdit (l'utilisateur imprime
      pour son usage ; un bac de spares à scanner à 10 cm est légitime). */
  static readonly QR_FLOOR_MM = 18;

  /** Plancher de taille d'un MODULE (mm) — 🚨 diagnostic Q11.14 (2026-09-03). Le plancher
      ci-dessus parle de la cote TOTALE du QR ; il est déjà trop optimiste dès que le code
      compte beaucoup de modules. L'URL absolue d'une fiche (~70 caractères, EC « M ») donne
      une version 4 = 33 modules, soit 41 de côté quiet zone comprise : à 18 mm, un module
      fait 0,44 mm — 3,5 px sur une thermique 203 dpi. Sous 0,5 mm par module, la plupart des
      thermiques ne résolvent plus les transitions et le code cesse d'être fiable, quelle que
      soit la cote totale. Signalé (registre « risque de scan »), jamais interdit. */
  static readonly MODULE_FLOOR_MM = 0.5;

  /** Planche A4 : marge 8 mm sur les 4 bords + une ligne d'en-tête de 6 mm HORS
      zone d'étiquettes (objet source · compte — utile quand trois planches traînent). */
  static readonly A4_W = 210;
  static readonly A4_H = 297;
  static readonly A4_MARGIN = 8;
  static readonly SHEET_HEADER_MM = 6;

  /** Bornes du gabarit « Personnalisé » — celles des champs de la maquette. */
  static readonly CUSTOM_BOUNDS = {
    w: [20, 210] as const,
    h: [12, 297] as const,
    qr: [12, 60] as const,
    dia: [3, 30] as const,
    len: [10, 60] as const,
  };

  /** Largeur moyenne d'un caractère MONO à 8 pt (estimation d'encombrement du texte
      longitudinal des manchons — mesure d'appui : 8 pt ≈ 2,82 mm de corps, chasse
      mono ≈ 0,62 × corps). Sert au SEUL avertissement `sleeve-tight` (heuristique,
      la vérité finale est l'aperçu). */
  static readonly SLEEVE_CHAR_MM = 1.75;

  /** PAS CIBLE d'une case de manchon (mm) — l'ÉPAISSEUR d'une bande répétée, mesurée
      EN TRAVERS du câble (le nom, lui, se lit dans l'axe du câble, d'où l'autre cote).
      🚨 POURQUOI 5 mm (retour terrain 2026-08-20, mesuré au navigateur) : la ligne de
      l'identifiant en 8 pt occupe **3,10 mm** en travers (corps 8 pt ≈ 2,82 mm ×
      interligne 1,08, arrondi au pixel). À 4 mm de pas il ne resterait que 0,45 mm de
      blanc de part et d'autre du filet — le texte le TOUCHE ; à 6 mm on retombe sur la
      densité fautive d'aujourd'hui (le texte flotte au milieu, ce qui fait justement
      lire la case comme surdimensionnée). À 5 mm, sur TOUTE la gamme de Ø offerte
      (3 → 30 mm), la case reste dans **4,19 → 5,76 mm** au pas de saisie du champ
      (0,5 mm), soit 1,35 à 1,86 fois la hauteur de ligne : jamais serrée, jamais
      flottante. ⚠ L'arrondi laisse un pic à 6,25 mm (2,0 × la ligne) dans la seule
      bascule 2 → 3 cases, autour de Ø 3,98 — assumé : c'est le prix de l'ARRONDI, et
      un `ceil` qui plafonnerait la case à 5 mm la ferait tomber à 2,5 mm à deux cases,
      SOUS la hauteur de ligne. On préfère un pic large à un plancher illisible. */
  static readonly SLEEVE_REPEAT_PITCH_MM = 5;

  /** Bornes du nombre de cases. Le MINIMUM (2) est une règle métier : « lisible sous
      tous les angles » exige au moins deux repères sur le tour, sinon le seul repère
      peut se retrouver EN DESSOUS du câble. Le MAXIMUM est un garde-fou de totalité de
      la fonction (elle est PURE : elle doit répondre à n'importe quelle entrée) — il ne
      mord PAS dans la gamme offerte, où Ø 30 plafonne à 19 cases. */
  static readonly SLEEVE_REPEAT_MIN = 2;
  static readonly SLEEVE_REPEAT_MAX = 20;

  /** Manchon « repère complet » : DEUX panneaux sur la partie visible, pas davantage —
      le texte y est riche (identifiant + extrémités A/B + type + propriétaire) et
      s'empile EN TRAVERS du câble, il lui faut de la place ; deux panneaux par tour
      suffisent à en avoir un lisible sous presque tout angle. */
  static readonly SLEEVE_STRIP_PANELS = 2;

  /* ------------------------------- dimensions ------------------------------- */

  /** Taille de QR EFFECTIVE (mm) d'un réglage : les préréglages S/M/L/Baie imposent
      la leur ; « QR seul », « câble » et « personnalisé » lisent `spec.qr`. */
  static qrSizeOf(spec: LabelSpec): number {
    if (spec.content === "qr" || spec.size === "custom" || spec.size === "cable") return spec.qr;
    const preset = LabelLayout.PRESETS[spec.size];
    return preset ? preset.qr : spec.qr;
  }

  /** Marge intérieure d'une étiquette RECTANGULAIRE, par classe de gabarit et densité.
      🚨 DOCTRINE DES DENSITÉS (retours terrain 2026-08-20, amende la maquette) :
      **compact = UNIQUEMENT les marges de garde du QR** — la quiet zone est DANS le
      SVG servi (4 modules, cf. LabelQrSvg), donc le padding d'étiquette est NUL et
      les gouttières aussi ; **confort = l'aisance de la maquette** (1,5 mm en S/M,
      3 en L, 4 en Baie). Avant ce retour, L/Baie portaient leur padding dans le CSS
      seul — il vit ICI désormais, pour que les tests de non-débordement le voient. */
  static rectPadding(cls: "s" | "m" | "l" | "rack", compact: boolean): number {
    if (compact) return 0;
    return cls === "l" ? 3 : cls === "rack" ? 4 : 1.5;
  }

  /** Gouttière QR ⇄ texte d'une étiquette rectangulaire (même doctrine : compacte = 0,
      la quiet zone du SVG fait la séparation ; confort = les gaps de la maquette). */
  static rectGap(cls: "s" | "m" | "l" | "rack", compact: boolean): number {
    if (compact) return 0;
    return cls === "l" ? 3 : cls === "rack" ? 5 : 2;
  }

  /** Géométrie VERTICALE du QR dans une étiquette rectangulaire « QR + texte » —
      🚨 LE QR D'UN PRÉRÉGLAGE NE DÉBORDE JAMAIS (bug S mesuré : en confort,
      18 + 2 × 1,5 = 21 > 20 mm — le SVG débordait de la zone de contenu et se
      faisait rogner à l'impression). Règle : le QR est clampé à (hauteur − 2 marges) ;
      si le clamp passait SOUS le plancher de scannabilité (18 mm), c'est la MARGE
      verticale qui cède — la scannabilité prime sur l'aisance, jamais l'inverse.
      S'applique aux PRÉRÉGLAGES ; le « personnalisé » garde ses cotes saisies et
      son avertissement `qr-exceeds-label` (l'utilisateur y contrôle tout). */
  static rectQrGeometry(spec: LabelSpec, heightMm?: number): { qr: number; padV: number; padH: number; gap: number } {
    const [, nominalH] = LabelLayout.labelDims(spec);
    const h = heightMm != null ? heightMm : nominalH;   // sur une planche, la CELLULE (plus haute) donne plus d'air
    const cls = spec.size === "custom" ? LabelLayout.fontClassForHeight(h) : (spec.size as "s" | "m" | "l" | "rack");
    const pad = LabelLayout.rectPadding(cls, spec.compact);
    const gap = LabelLayout.rectGap(cls, spec.compact);
    const wanted = LabelLayout.qrSizeOf(spec);
    if (spec.size === "custom" || wanted + 2 * pad <= h) return { qr: wanted, padV: pad, padH: pad, gap };
    // Préréglage trop serré : le QR cède jusqu'au plancher (jamais sous la hauteur
    // elle-même), puis c'est la marge qui absorbe le reste — répartie également.
    const qr = Math.min(Math.max(h - 2 * pad, Math.min(LabelLayout.QR_FLOOR_MM, wanted)), h);
    return { qr, padV: Math.max(0, (h - qr) / 2), padH: pad, gap };
  }

  /** Cote de QR À SERVIR au SVG (mm) — LA seule que l'UI doive employer pour mettre le code à
      l'échelle (`LabelQrSvg.scaleToMm`), aperçu ET imprimé, unitaire ET planche. Elle passe par le
      CLAMP des étiquettes rectangulaires (cf. `rectQrGeometry`) ; les anatomies qui ont leur propre
      géométrie (drapeau, manchon, QR seul) gardent `qrSizeOf`, leurs cotes étant DÉRIVÉES du QR et
      donc jamais trop petites pour lui. Sans ce point de passage unique, le SVG pouvait être servi
      à une cote que la boîte ne pouvait pas contenir — et se faire rogner à l'impression. */
  static renderQrMm(spec: LabelSpec, heightMm?: number, quantize?: { dpi: number; totalModules: number }): number {
    const wanted = (spec.content === "full" && spec.size !== "cable")
      ? LabelLayout.rectQrGeometry(spec, heightMm).qr
      : LabelLayout.qrSizeOf(spec);
    if (!quantize) return wanted;
    return LabelLayout.quantizeQrMm(quantize.totalModules, quantize.dpi, wanted).mm;
  }

  /** QUANTIFICATION de la cote d'un QR — 🚨 seconde moitié du correctif Q11.14 (la première
      est côté serveur : émettre des CARRÉS et non des traits, cf. src-server/QrSvg).

      Un module n'est un carré à l'impression QUE s'il tombe sur un nombre ENTIER de pixels de
      sortie. Sinon le rasteur donne 3 px à une rangée, 4 à la suivante, et le code repart de
      travers quel que soit le dessin. Or la cote physique d'un module vaut
      `mm / totalModules` : à 20 mm sur 41 modules et 300 dpi, cela fait 5,76 px — jamais un
      entier. La question est PHYSIQUE, pas logicielle : sans connaître la résolution, aucune
      cote ne peut être juste pour toutes les imprimantes. D'où le choix de résolution offert
      dans l'étage Tirage, et cette fonction, qui ARRONDIT VERS LE BAS le nombre de pixels par
      module puis recompose la cote : le QR rétrécit un peu (jamais plus que d'un pixel par
      module) et tient donc TOUJOURS dans la boîte qui l'attendait.

      `totalModules` = le côté du viewBox du SVG servi, QUIET ZONE COMPRISE (c'est elle qui est
      mise à l'échelle avec le reste : les 4 modules de blanc doivent eux aussi tomber juste).
      `pxPerModule` ne descend jamais sous 1 — à 1 px par module on est déjà bien au-delà de
      l'illisible, et l'avertissement `module-too-small` l'aura dit ; rendre 0 produirait une
      cote nulle, donc un QR absent, ce qui est pire qu'un QR mauvais. */
  static quantizeQrMm(totalModules: number, dpi: number, maxMm: number): { mm: number; pxPerModule: number } {
    if (!Number.isFinite(totalModules) || totalModules <= 0 || !Number.isFinite(dpi) || dpi <= 0 || !Number.isFinite(maxMm) || maxMm <= 0) {
      return { mm: maxMm, pxPerModule: 0 };   // entrée inexploitable : la cote demandée passe telle quelle
    }
    const pxPerModule = Math.max(1, Math.floor((maxMm / 25.4 * dpi) / totalModules));
    return { mm: totalModules * pxPerModule * 25.4 / dpi, pxPerModule };
  }

  /** Géométrie du DRAPEAU de câble — DÉRIVÉE de la taille du QR (maquette `cableGeom`,
      densités amendées 2026-08-20) : deux panneaux de `pan` mm séparés par une zone
      d'enroulement hachurée de `wz` mm. Compact = padding nul (quiet zone du SVG
      seule) → q18 : 54 × 18 ; confort → 62 × 22 (la cote nominale de la table). */
  static flagGeometry(qrMm: number, compact: boolean): { pad: number; wz: number; pan: number; w: number; h: number } {
    const pad = compact ? 0 : 2;
    const wz = compact ? 10 : 12;
    const pan = Math.max(qrMm + 2 * pad, compact ? 22 : 25);
    return { pad, wz, pan, h: qrMm + 2 * pad, w: 2 * pan + wz };
  }

  /** Géométrie du MANCHON sans QR — 🚨 AMENDE la maquette (`stripGeom` : 2 tours + un
      recouvrement forfaitaire de 12/16 mm selon la densité). Retour terrain sur
      étiquettes IMPRIMÉES : « 1,5 × le diamètre est OK sinon on a trop de papier à
      coller ».

      RÈGLE : la bande déroulée fait **UN TOUR ET DEMI** de circonférence, et le
      demi-tour excédentaire **EST** le recouvrement (auto-collant classique : le papier
      se colle sur lui-même). Il n'y a donc PLUS de zone de recouvrement ajoutée en
      supplément — d'où `overlap = turn / 2` et `w = 1,5 · turn`.

      Corollaire consommé partout : la partie **VISIBLE** sur le câble (`w − overlap`)
      vaut EXACTEMENT un tour — c'est l'assiette sur laquelle les cases se répartissent
      (cf. sleeveRepeats), là où l'ancienne géométrie leur donnait DEUX tours, ce qui
      contredisait l'intention de la maquette (« répété six fois **sur le tour** »).

      ⚠ La DENSITÉ n'entre plus dans l'enroulement : celui-ci est une géométrie PHYSIQUE
      (la circonférence d'un câble ne dépend pas de l'aisance typographique voulue) —
      d'où la disparition du paramètre `compact`. La densité continue de piloter la
      TYPOGRAPHIE du manchon via la classe `.lab.compact` (cf. core/LabelHtml).

      La hauteur reste la longueur LE LONG du câble (c'est là qu'est la place → texte
      longitudinal). */
  static sleeveGeometry(diaMm: number, lenMm: number): { turn: number; overlap: number; visible: number; w: number; h: number } {
    const turn = Math.PI * diaMm;
    const overlap = turn / 2;
    return { turn, overlap, visible: turn, w: turn + overlap, h: lenMm };
  }

  /** Nombre de RÉPÉTITIONS de l'identifiant sur un manchon — DÉDUIT de la longueur
      visible, jamais figé (retour terrain 2026-08-20 : « la case de la dernière
      répétition est plus grande que les autres »). Le 6 de la maquette était constant
      quel que soit le Ø : à Ø 3 la case tombait à 3,14 mm (le texte n'y tenait DÉJÀ
      plus), à Ø 20 elle atteignait 20,94 mm (le texte flottait au milieu de 9 mm de
      blanc de chaque côté). Un Ø 20 doit porter PLUS de repères qu'un Ø 3, pas des
      repères plus gros.

      `count = clamp(arrondi(visible / pas cible), min, max)` — et la largeur d'une case
      est ENSUITE `visible / count` (cf. sleeveCellWidth), donc toutes égales par
      construction et sans reste. */
  static sleeveRepeats(visibleMm: number): number {
    if (!Number.isFinite(visibleMm) || visibleMm <= 0) return LabelLayout.SLEEVE_REPEAT_MIN;
    const wanted = Math.round(visibleMm / LabelLayout.SLEEVE_REPEAT_PITCH_MM);
    return Math.max(LabelLayout.SLEEVE_REPEAT_MIN, Math.min(LabelLayout.SLEEVE_REPEAT_MAX, wanted));
  }

  /** Largeur EXACTE d'une case de manchon : la partie visible divisée par le nombre de
      cases. Écrite ici plutôt que dans le rendu pour que l'égalité des cases soit une
      propriété du MODULE PUR (donc testable) et non un effet de bord du moteur de
      flexbox — c'était précisément le défaut signalé : `flex:1` répartissait un reste,
      rien ne POSAIT l'égalité et rien ne pouvait la vérifier. */
  static sleeveCellWidth(visibleMm: number, count: number): number {
    return visibleMm / Math.max(1, count);
  }

  /** Géométrie « QR SEUL » : étiquette CARRÉE (QR + marges), une éventuelle bande
      propriétaire s'ajoute SOUS le carré (maquette : side = qr + 2·pad + gap + bande ;
      densité compacte amendée 2026-08-20 : padding nul, la quiet zone du SVG suffit). */
  static qrOnlyGeometry(qrMm: number, compact: boolean, hasOwner: boolean): { side: number; pad: number; gap: number; ownerBand: number } {
    const pad = compact ? 0 : 2;
    const gap = compact ? 0.4 : 1.2;
    const ownerBand = hasOwner ? (compact ? 3.6 : 4.6) : 0;
    return { side: qrMm + 2 * pad + (hasOwner ? gap + ownerBand : 0), pad, gap, ownerBand };
  }

  /** Dimensions RÉELLES [w, h] (mm) d'une étiquette selon le réglage (maquette `labDims`). */
  static labelDims(spec: LabelSpec): [number, number] {
    if (spec.size === "cable") {
      if (spec.content === "strip" || spec.content === "id") {
        const g = LabelLayout.sleeveGeometry(spec.dia, spec.len);
        return [g.w, g.h];
      }
      const g = LabelLayout.flagGeometry(LabelLayout.qrSizeOf(spec), spec.compact);
      return [g.w, g.h];
    }
    if (spec.content === "qr") {
      const g = LabelLayout.qrOnlyGeometry(spec.qr, spec.compact, spec.hasOwner);
      return [g.side, g.side];
    }
    if (spec.size === "custom") return [spec.custom.w, spec.custom.h];
    const preset = LabelLayout.PRESETS[spec.size];
    return [preset.w, preset.h];
  }

  /** Classe de CORPS DE POLICE d'une hauteur d'étiquette (gabarit personnalisé —
      maquette `clsFor`) : les tailles de texte suivent le gabarit le plus proche. */
  static fontClassForHeight(h: number): "s" | "m" | "l" | "rack" {
    return h < 25 ? "s" : h < 36 ? "m" : h < 50 ? "l" : "rack";
  }

  /* --------------------------------- planche --------------------------------- */

  /** CELLULE de planche [w, h] (mm) : la colonne `cell` des préréglages « QR + texte » ;
      les autres contenus/gabarits (QR seul, drapeau, manchon, personnalisé) n'ont pas
      de cellule dédiée → leurs dimensions réelles (cf. en-tête du module). */
  static cellDims(spec: LabelSpec): [number, number] {
    if (spec.content === "full" && spec.size !== "custom" && spec.size !== "cable") {
      const preset = LabelLayout.PRESETS[spec.size];
      return [preset.cell[0], preset.cell[1]];
    }
    return LabelLayout.labelDims(spec);
  }

  /** Épaisseur d'un TRAIT DE COUPE (mm) — **source UNIQUE** : la géométrie de la planche
      la lit ici, et `LabelHtml.CSS` la compose depuis cette constante (elle était écrite à
      cinq endroits, donc condamnée à diverger).

      🚨 0,5 et non 0,2 (retour terrain 2026-08-25, l'utilisateur ayant trouvé LA
      reproduction : **le défaut apparaît et disparaît selon le zoom du navigateur**). C'est
      la signature d'un filet SOUS-PIXEL — 0,2 mm ≈ 0,76 px CSS, donc selon l'endroit où
      chaque ligne tombe, le rasteur en met 1 pixel… ou 0. D'où des traits qui « sautent »
      par endroits, aussi bien à l'écran zoomé qu'à l'impression, sans qu'aucun élément ne
      les recouvre. 0,5 mm ≈ 1,9 px : la ligne survit à l'arrondi même à 50 % d'échelle.
      C'est aussi la cote des traits de coupe des planches d'étiquettes du commerce.

      Le trait sépare RÉELLEMENT deux cellules (il vit dans la gouttière de la grille, cf.
      `LabelHtml.CSS`) : une rangée de N cellules occupe donc N × cote + (N − 1) × trait. */
  static readonly CUT_MM = 0.5;

  /** Plafond de COLONNES d'une planche A4 : combien de cellules tiennent dans la
      largeur utile (210 − 2 × 8 = 194 mm), traits de coupe compris. Jamais moins de 1. */
  static maxColumns(spec: LabelSpec): number {
    // N cellules + (N − 1) gouttières ≤ largeur utile  ⇔  N ≤ (utile + trait) / (cote + trait).
    // Les traits du POURTOUR, eux, sont dessinés dans la marge de 8 mm : ils ne comptent pas.
    const usable = LabelLayout.A4_W - 2 * LabelLayout.A4_MARGIN;
    return Math.max(1, Math.floor((usable + LabelLayout.CUT_MM) / (LabelLayout.cellDims(spec)[0] + LabelLayout.CUT_MM)));
  }

  /** Plafond d'AFFICHAGE du sélecteur de colonnes. Le papier en accepterait davantage
      pour une très petite étiquette (un manchon de 12 mm en logerait 15), mais le
      contrôle segmenté vit dans un panneau de 250 px : au-delà, les boutons ne sont
      plus cliquables. C'est donc une borne d'INTERFACE, pas une borne physique — à
      relever le jour où le contrôle change de forme. */
  static readonly MAX_SHEET_COLUMNS = 8;

  /** Colonnes PROPOSÉES pour un gabarit : 1 … min(capacité réelle, plafond d'affichage).
      Rendre la liste plutôt qu'un maximum permet à l'UI de la peindre telle quelle, sans
      réécrire la règle — et « 1 colonne » y figure, ce qu'un sélecteur figé à 2-3-4
      interdisait alors que c'est le SEUL choix possible pour une étiquette de baie. */
  static columnChoices(spec: LabelSpec): number[] {
    const max = Math.min(LabelLayout.maxColumns(spec), LabelLayout.MAX_SHEET_COLUMNS);
    return Array.from({ length: max }, (_, index) => index + 1);
  }

  /** Découpe d'une planche : colonnes demandées PLAFONNÉES par la largeur réelle,
      rangées par la hauteur utile (297 − 16 − 6 d'en-tête), capacité et nb de feuilles.
      `capped` dit si la demande a été ramenée (l'UI l'explique en avertissement). */
  static sheetLayout(spec: LabelSpec, requestedCols: number, count: number): {
    cols: number; rows: number; perPage: number; pages: number; capped: boolean;
    cellW: number; cellH: number;
  } {
    const [cellW, cellH] = LabelLayout.cellDims(spec);
    const maxCols = LabelLayout.maxColumns(spec);
    const cols = Math.max(1, Math.min(requestedCols, maxCols));
    // Pas de bonus « + trait » ici, contrairement aux colonnes : l'en-tête de planche est lui
    // aussi un élément de la grille, il consomme donc une gouttière de plus. Compter au plus juste.
    const usableH = LabelLayout.A4_H - 2 * LabelLayout.A4_MARGIN - LabelLayout.SHEET_HEADER_MM;
    const rows = Math.max(1, Math.floor(usableH / (cellH + LabelLayout.CUT_MM)));   // gouttières comprises (cf. CUT_MM)
    const perPage = cols * rows;
    return { cols, rows, perPage, pages: Math.max(1, Math.ceil(count / perPage)), capped: requestedCols > maxCols, cellW, cellH };
  }

  /* ------------------------------- personnalisé ------------------------------ */

  /** Ramène une valeur du gabarit « Personnalisé » dans ses bornes (jamais d'erreur :
      borner, pas refuser — même politique que `QrCodeParams.clampSize` côté serveur).
      Une valeur non numérique retombe sur la borne BASSE (rien d'interprétable). */
  static clampCustom(field: keyof typeof LabelLayout.CUSTOM_BOUNDS, value: number): number {
    const [min, max] = LabelLayout.CUSTOM_BOUNDS[field];
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
  }

  /* ------------------------------ avertissements ----------------------------- */

  /** DÉTECTION DE DÉBORDEMENT — codes, pas de chaînes (l'UI traduit) :
        · `qr-floor`         : QR effectif < 18 mm (hors manchons, qui n'ont pas de QR) ;
        · `qr-exceeds-label` : le QR + marges dépasse une des cotes de l'étiquette
                               (possible seulement en « personnalisé » — les préréglages
                               sont cohérents par construction) ;
        · `columns-capped`   : colonnes demandées > plafond (planche seulement) ;
        · `multi-page`       : plus d'une feuille A4 (planche seulement) ;
        · `sleeve-tight`     : manchon — l'identifiant le plus long, estimé en mono 8 pt,
                               ne tient pas dans la longueur le long du câble ;
        · `module-too-small` : un MODULE du QR tombe sous 0,5 mm (cf. MODULE_FLOOR_MM). Il
                               demande `opts.totalModules` — le côté du QR servi, quiet zone
                               comprise : SANS lui, aucun avis (on ne devine pas le nombre de
                               modules d'un code qu'on n'a pas encore reçu, et un appel qui ne
                               connaît pas son QR ne doit pas se voir inventer un verdict).
                               La cote évaluée est celle qui sera RÉELLEMENT servie, donc
                               quantifiée quand le spec porte un `dpi` (cf. renderQrMm) —
                               sinon on avertirait sur une cote que personne n'imprime. */
  static warnings(spec: LabelSpec, opts: { count: number; requestedCols: number; longestIdLength?: number; totalModules?: number }): LabelWarning[] {
    const out: LabelWarning[] = [];
    const sleeve = spec.content === "strip" || spec.content === "id";
    if (!sleeve) {
      const qr = LabelLayout.qrSizeOf(spec);
      if (qr < LabelLayout.QR_FLOOR_MM) out.push("qr-floor");
      // Cote RÉELLEMENT servie (clamp des préréglages + quantification éventuelle) rapportée au
      // nombre de modules : c'est la seule mesure qui parle de ce que l'imprimante doit résoudre.
      const total = opts.totalModules;
      if (total != null && Number.isFinite(total) && total > 0) {
        const served = LabelLayout.renderQrMm(spec, undefined, spec.dpi ? { dpi: spec.dpi, totalModules: total } : undefined);
        if (served / total < LabelLayout.MODULE_FLOOR_MM) out.push("module-too-small");
      }
      if (spec.size === "custom" && spec.content === "full") {
        // Le personnalisé n'est PAS clampé (l'utilisateur contrôle ses cotes) : on
        // AVERTIT avec le padding réel de sa classe de police (cf. rectQrGeometry).
        const [w, h] = LabelLayout.labelDims(spec);
        const pad = LabelLayout.rectPadding(LabelLayout.fontClassForHeight(h), spec.compact);
        if (qr + 2 * pad > h || qr + 2 * pad > w) out.push("qr-exceeds-label");
      }
    } else if (opts.longestIdLength != null) {
      // Texte LONGITUDINAL : l'identifiant court le long du câble — marge de 2 mm pour
      // le padding vertical de la cellule (1 mm × 2, cf. maquette `.cell2`).
      if (opts.longestIdLength * LabelLayout.SLEEVE_CHAR_MM + 2 > spec.len) out.push("sleeve-tight");
    }
    if (opts.count > 1) {
      const sheet = LabelLayout.sheetLayout(spec, opts.requestedCols, opts.count);
      if (sheet.capped) out.push("columns-capped");
      if (sheet.pages > 1) out.push("multi-page");
    }
    return out;
  }
}
