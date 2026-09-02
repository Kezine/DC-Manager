/* ============================================================================
   Domaine `labels` — FRANÇAIS. ÉTIQUETTES QR IMPRIMABLES (chantier étiquettes
   QR, lot E) : points d'entrée des fiches (équipement/baie/câble/faisceau/spare),
   modale d'impression (`ui/LabelPrintDialog` — panneau de réglages, aperçu, stats),
   avertissements de débordement (codes de `core/LabelLayout` → libellés ICI),
   libellés composés des sujets (`core/LabelSubjects`). L'action de LIGNE des
   listings vit dans `lists.chrome.rowPrint`. Agrégé par `../fr.ts`.
   Voir docs/i18n.md et docs/qr-scan.md § « Étiquettes imprimables ». */
export const labels = {
  entry: {
    equipment: "Imprimer l'étiquette",
    rack: "Étiquette de baie",
    rackSheet: "Planche du contenu ({{n}})",
    rackSheetSource: "Baie {{rack}} · contenu",
    // Gestes du DRAPEAU — ils nomment l'ANATOMIE, pas la famille : câbles ET faisceaux
    // (mêmes deux extrémités, même drapeau) les partagent. `{{cable}}` = le nom de l'objet.
    cableOne: "Un drapeau",
    cableBoth: "Imprimer les 2 extrémités",
    cableBothSource: "{{cable}} · extrémités A et B",
  },
  dialog: {
    title: "Imprimer des étiquettes",
    content: "Contenu",
    contentFull: "QR + texte",
    contentQr: "QR seul",
    contentStrip: "Manchon sans QR — repère complet",
    contentId: "Manchon sans QR — identifiant seul",
    format: "Format",
    formatSleeve: "Manchon",
    formatQrSize: "Taille du QR",
    sizeS: "S — 50 × 20 mm",
    sizeM: "M — 50 × 30 mm (défaut)",
    sizeL: "L — 70 × 40 mm",
    sizeRack: "Baie — 100 × 60 mm",
    sizeCable: "Câble — drapeau",
    sizeCustom: "Personnalisé…",
    widthMm: "Larg. mm",
    heightMm: "Haut. mm",
    qrMm: "QR mm",
    diaMm: "Ø câble mm",
    lenMm: "Long. mm",
    density: "Densité",
    densityCompact: "Compact",
    densityComfort: "Confort",
    // Titre de la section des cases par champ. « Lisible humain » (maquette) disait le REGISTRE
    // typographique, pas le contenu — renommé sur retour terrain 2026-08-20.
    // T10 : les libellés des CASES vivent désormais dans `field.*` (déclarés par les sujets,
    // cf. core/LabelSubjects) — ne restent ici que les deux rangées STRUCTURELLES.
    fields: "Informations additionnelles",
    fieldId: "Identifiant (toujours)",
    fieldEnds: "Extrémités A / B",
    sheet: "Planche",
    /** Libellé du champ « Colonnes » de la planche (champ numérique borné). */
    cols: "Colonnes",
    colsMax: "max {{max}}",
    cuts: "Traits de coupe",
    preview: "Aperçu",
    previewUnit: "Aperçu — étiquette unitaire",
    previewSheet: "Aperçu — planche A4",
    statDims: "{{w}} × {{h}} mm",
    statPerPage: "{{cols}} col. · {{per}} par feuille",
    statUnit: "1 étiquette · page à la taille de l'étiquette",
    statSheet: "{{count}} étiquettes · {{pages}} feuille{{s}} A4",
    qrOk: "QR {{mm}} mm — au-dessus du plancher de scannabilité.",
    qrLow: "QR {{mm}} mm — sous le plancher de 18 mm.",
    sleeveHint: "Un tour et demi de Ø {{dia}} mm — le demi-tour excédentaire ({{ov}} mm) sert de recouvrement ; {{len}} mm le long du câble, texte longitudinal.",
    print: "Imprimer",
    loading: "Génération des QR…",
    loadError: "Impossible d'obtenir les QR du serveur : {{msg}}",
  },
  warn: {
    qrFloor: "QR {{mm}} mm : sous le plancher de 18 mm — scan fiable seulement de très près.",
    qrExceedsLabel: "Le QR de {{qr}} mm ne tient pas dans l'étiquette : agrandissez-la ou réduisez le QR.",
    columnsCapped: "Une étiquette de {{w}} mm de large ne tient qu'en {{cols}} colonne{{s}} sur A4 : la planche a été ramenée à {{cols}}.",
    multiPage: "{{count}} étiquettes ne tiennent pas sur une feuille : {{pages}} feuilles seront imprimées.",
    sleeveTight: "Le contenu risque de ne pas tenir dans {{len}} mm : rallongez le manchon ou décochez un champ.",
  },
  sheetHead: {
    count: "{{count}} étiquette{{s}}",
  },
  /* Libellés des CASES déclarées par les sujets (T10, cf. core/LabelSubjects) — ce que
     le dialogue affiche à côté de chaque case « Informations additionnelles ». */
  field: {
    location: "Emplacement",
    type: "Type / famille",
    serial: "N° de série",
    owner: "Propriétaire",
    // Spare : « Type » nu (la marque/le modèle ont désormais LEUR case, décision Q10.A).
    spareType: "Type",
    characteristics: "Caractéristiques",
    brandModel: "Marque / modèle",
    purchase: "Achat",
    storage: "Stockage",
    // Sous-équipement : l'« emplacement » est le maître puis son repère (`slot`).
    master: "Maître · repère",
  },
  subject: {
    rackType: "Baie {{u}}U",
    // Valeur imprimée de la case « Achat » — préfixée pour rester lisible seule sur
    // l'étiquette (« Achat 2026-01-15 · BC 4471 », le BC venant de detail.common.poRef).
    purchase: "Achat {{info}}",
  },
} as const;
