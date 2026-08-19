/* ============================================================================
   LABELLAYOUT — GÉOMÉTRIE PURE des étiquettes QR imprimables (lot E du chantier
   étiquettes QR). Documentation : docs/qr-scan.md § « Étiquettes imprimables ».
   La maquette design-system/briefs/qr-etiquettes-imprimables-maquette.html FAIT
   FOI : les cotes de ce module reprennent les valeurs EXACTES de son script
   (table `SIZES`, `cableGeom`, `stripGeom`, bornes des champs « Personnalisé »),
   AMENDÉES par les retours terrain du 2026-08-20 : densité COMPACTE = marges
   nulles (seule la quiet zone du SVG garde le QR), et le QR d'un préréglage ne
   déborde JAMAIS (cf. rectPadding / rectQrGeometry).

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
  | "sleeve-tight";     // manchon : le texte estimé dépasse la longueur le long du câble

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
  static renderQrMm(spec: LabelSpec, heightMm?: number): number {
    if (spec.content === "full" && spec.size !== "cable") return LabelLayout.rectQrGeometry(spec, heightMm).qr;
    return LabelLayout.qrSizeOf(spec);
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

  /** Géométrie du MANCHON sans QR (maquette `stripGeom`) : la circonférence déroulée =
      DEUX tours (2 π Ø) + un recouvrement selon la densité ; la hauteur = la longueur
      LE LONG du câble (c'est là qu'est la place → texte longitudinal). */
  static sleeveGeometry(diaMm: number, lenMm: number, compact: boolean): { turn: number; overlap: number; w: number; h: number } {
    const overlap = compact ? 12 : 16;
    const turn = Math.PI * diaMm;
    return { turn, overlap, w: 2 * Math.PI * diaMm + overlap, h: lenMm };
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
        const g = LabelLayout.sleeveGeometry(spec.dia, spec.len, spec.compact);
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

  /** Plafond de COLONNES d'une planche A4 : combien de cellules tiennent dans la
      largeur utile (210 − 2 × 8 = 194 mm). Jamais moins de 1. */
  static maxColumns(spec: LabelSpec): number {
    return Math.max(1, Math.floor((LabelLayout.A4_W - 2 * LabelLayout.A4_MARGIN) / LabelLayout.cellDims(spec)[0]));
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
    const rows = Math.max(1, Math.floor((LabelLayout.A4_H - 2 * LabelLayout.A4_MARGIN - LabelLayout.SHEET_HEADER_MM) / cellH));
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
                               ne tient pas dans la longueur le long du câble. */
  static warnings(spec: LabelSpec, opts: { count: number; requestedCols: number; longestIdLength?: number }): LabelWarning[] {
    const out: LabelWarning[] = [];
    const sleeve = spec.content === "strip" || spec.content === "id";
    if (!sleeve) {
      const qr = LabelLayout.qrSizeOf(spec);
      if (qr < LabelLayout.QR_FLOOR_MM) out.push("qr-floor");
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
