/* ============================================================================
   Domaine `labels` — FRANÇAIS. ÉTIQUETTES QR IMPRIMABLES (chantier étiquettes
   QR, lot E, REFONDU par le retour terrain T11 du 2026-09-03) : points d'entrée
   des fiches (équipement/baie/câble/faisceau/spare), modale d'impression
   (`ui/LabelPrintDialog` — contexte, quatre étages, aperçu, deux registres),
   avertissements de débordement (codes de `core/LabelLayout` → libellés ICI),
   RAISONS de refus (codes de `core/LabelPrintPolicy` → libellés ICI), export en
   images, libellés composés des sujets (`core/LabelSubjects`). L'action de LIGNE
   des listings vit dans `lists.chrome.rowPrint`. Agrégé par `../fr.ts`.

   🚨 DOCTRINE T11 — LE PANNEAU EXPLIQUE, IL NE FAIT PLUS DEVINER. Les clés
   `why.*` sont la moitié visible de la « disponibilité avec raison » : la
   politique rend un CODE, ce catalogue en fait une phrase. Une option grisée
   sans sa raison serait pire que l'option cachée d'avant — d'où l'obligation
   qu'à tout code de `LabelPrintPolicy` corresponde une clé ici.

   Voir docs/i18n.md et docs/qr-scan.md § « Étiquettes imprimables ». */
export const labels = {
  entry: {
    equipment: "Imprimer l'étiquette",
    rack: "Étiquette de baie",
    rackSheet: "Planche du contenu ({{n}})",
    rackSheetSource: "Baie {{rack}} · contenu",
    // Geste UNIQUE du DRAPEAU (T11 — fusion de « Un drapeau » et « Imprimer les 2 extrémités ») :
    // il nomme l'ANATOMIE, pas la famille — câbles ET faisceaux le partagent. Combien de
    // drapeaux, et pour quel bout, se décide DANS la modale, devant l'aperçu.
    flag: "Étiqueter…",
  },
  /** Nom du SUJET dans la ligne de contexte de la modale. */
  kind: {
    equipment: "équipement",
    rack: "baie",
    cable: "câble",
    bundle: "faisceau",
    spare: "petit matériel",
    subEquipment: "sous-équipement",
  },
  dialog: {
    title: "Imprimer des étiquettes",

    /* -- contexte -- */
    ctxMany: "{{n}} objets sélectionnés",
    ctxMeta: "{{kind}} · {{n}} objet{{s}} · {{labels}} étiquette{{ls}}",
    memoryReused: "Réglages repris de votre dernier tirage · session",
    memoryDefaults: "Réglages par défaut",
    resetDefaults: "Revenir aux défauts",

    /* -- ◈ Tirage -- */
    stageTirage: "Tirage",
    tirageValue: "{{labels}} étiquette{{ls}}",
    occurrences: "Occurrences ×",
    paper: "Papier",
    paperSheet: "Planche A4",
    paperRoll: "Rouleau",
    paperAuto: " · papier choisi automatiquement",
    dpi: "Résolution d'impression",
    dpiValue: "{{dpi}} dpi",
    cols: "Colonnes",
    cuts: "Traits de coupe",
    density: "Densité",
    densityCompact: "Compact",
    densityComfort: "Confort",
    whySheet: "Planche A4, marge 8 mm : {{per}} étiquettes par feuille → {{pages}} feuille{{s}}.{{auto}}",
    whyRoll: "Une page à la cote exacte de l'étiquette, par étiquette — {{pages}} page{{s}} (imprimante à rouleau).{{auto}}",

    /* -- ① Support -- */
    stageSupport: "Support",
    support: {
      label: "Étiquette plate",
      rackhead: "Tête de baie — 100 × 60",
      flag: "Drapeau de câble",
      sleeve: "Manchon",
    },
    supportHint: {
      label: "autocollant façade ou bac",
      rackhead: "grand format, une par baie",
      flag: "2 panneaux + zone d'enroulement",
      sleeve: "1,5 tour, demi-tour de recouvrement",
    },
    sizeLabel: "Gabarit",
    size: { s: "S", m: "M", l: "L", custom: "Libre" },
    widthMm: "Larg. mm",
    heightMm: "Haut. mm",
    qrMm: "QR mm",
    diaMm: "Ø câble mm",
    lenMm: "Long. mm",
    ends: "Extrémités",
    endsA: "A seule",
    endsB: "B seule",
    endsAb: "A + B",
    qrOk: "QR {{mm}} mm — au-dessus du plancher de scannabilité.",
    qrLow: "QR {{mm}} mm — sous le plancher de 18 mm.",
    sleeveHint: "Un tour et demi de Ø {{dia}} mm — le demi-tour excédentaire ({{ov}} mm) sert de recouvrement ; {{len}} mm le long du câble, texte longitudinal.",

    /* -- ② Contenu -- */
    stageContent: "Contenu",
    content: {
      full: "QR + texte",
      qr: "QR seul",
      strip: "Manchon — repère complet",
      id: "Manchon — identifiant seul",
    },
    contentHint: {
      full: "le cas courant",
      qr: "très petites façades",
      strip: "sans QR, texte riche",
      id: "sans QR, numéro répété",
    },
    whyContent: "Les quatre contenus restent listés dans tous les contextes : ce qui change est leur disponibilité, énoncée sur la ligne.",

    /* -- ③ Informations additionnelles -- */
    stageFields: "Informations additionnelles",
    fieldsValue: "{{on}} / {{total}}",
    fieldsCount: "Cet objet déclare {{n}} champ{{s}} imprimable{{s}} — la liste vient de l'objet, pas de la modale.",
    fieldId: "Identifiant (toujours)",
    fieldEnds: "Extrémités A / B",
    fieldDeclaredBy: "déclaré par {{n}} / {{total}}",
    whyFields: "Un champ non déclaré par l'objet n'apparaît pas : c'est structurel, il n'y a pas de case sans donnée derrière.",

    /* -- aperçu et pied -- */
    preview: "Aperçu",
    previewRoll: "Aperçu — étiquette unitaire",
    previewSheet: "Aperçu — planche A4",
    statDims: "{{w}} × {{h}} mm",
    statPerPage: "{{cols}} col. · {{per}} par feuille",
    statRoll: "{{pages}} page{{s}} à la cote exacte de l'étiquette",
    statSheet: "{{count}} étiquettes · {{pages}} feuille{{s}} A4",
    print: "Imprimer",
    exportImages: "Exporter en images",
    loading: "Génération des QR…",
    loadError: "Impossible d'obtenir les QR du serveur : {{msg}}",
  },
  /* RAISONS de refus — un libellé par CODE de `core/LabelPrintPolicy` (cf. en-tête). */
  why: {
    "flag-only": "réservé aux câbles et faisceaux — ce qui s'enroule",
    "rack-only": "réservé aux baies",
    "needs-sleeve": "demande le support « Manchon »",
    "needs-not-sleeve": "le manchon ne porte pas de QR",
    "not-flag": "un rectangle ne s'attache pas à un brin",
    "no-text": "sans texte sous ce contenu",
    "cols-capped": "plafonné : {{max}} colonnes au maximum pour cette étiquette",
    "roll-no-cuts": "sans objet sur rouleau : chaque page EST une étiquette",
  },
  /* Registre 1 — « risque de scan », collé à l'aperçu, formulation à conséquence. */
  risk: {
    title: "Risque de scan",
  },
  warn: {
    qrFloor: "QR {{mm}} mm : sous le plancher de 18 mm — ce code pourra ne pas se scanner à bout de bras en baie.",
    qrExceedsLabel: "Le QR de {{qr}} mm ne tient pas dans l'étiquette : il sera rogné — agrandissez-la ou réduisez le QR.",
    columnsCapped: "Une étiquette de {{w}} mm de large ne tient qu'en {{cols}} colonne{{s}} sur A4 : la planche a été ramenée à {{cols}}.",
    multiPage: "{{count}} étiquettes ne tiennent pas sur une feuille : {{pages}} feuilles seront imprimées.",
    sleeveTight: "Le contenu risque de ne pas tenir dans {{len}} mm : rallongez le manchon ou décochez un champ.",
    // 🚨 Q11.14 : la cote TOTALE peut être bonne et le MODULE illisible quand le code compte
    // beaucoup de modules — c'est le défaut signalé (« plus des pixels carrés »).
    moduleTooSmall: "Module de {{mm}} mm — sous 0,5 mm, illisible sur une thermique 203 dpi : montez la cote du QR ou la résolution.",
  },
  export: {
    chooseMessage: "Que voulez-vous obtenir ?",
    chooseLabels: "Une image par étiquette",
    chooseLabelsHint: "{{n}} PNG{{s}}, à poser un à un dans un document",
    chooseSheets: "La planche entière",
    chooseSheetsHint: "{{pages}} PNG{{s}} — la feuille A4 telle qu'elle s'imprime",
    done: "{{n}} image{{s}} exportée{{s}}.",
    empty: "Rien à exporter.",
    failed: "Export impossible : {{msg}}",
    unsupported: "Export en images non pris en charge par ce navigateur (Safari). Utilisez Chrome ou Firefox.",
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
