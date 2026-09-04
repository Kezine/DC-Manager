/* ============================================================================
   LABELPRINTPOLICY — RÈGLES TRANSVERSES de la modale d'impression d'étiquettes
   (retours terrain 2026-08-20 sur le lot E, refondu par le retour T10 du
   2026-09-02). Documentation : docs/qr-scan.md § « Étiquettes imprimables ».

   POURQUOI UN MODULE PUR : la modale livrée montrait « tous les contrôles dans
   tous les contextes » — la règle « quels contrôles pour (sujet, contenu,
   format) ? » était éparpillée dans le rendu DOM, donc invérifiable. Ici elle
   est écrite UNE fois, sous forme de DÉCISIONS pures (testées dans
   Tests/modules/test-labels.js) ; `ui/LabelPrintDialog` ne fait plus
   qu'APPLIQUER le verdict (poser `hidden`), jamais le calculer.

   🚨 T10 — LA MATRICE DES CASES A DISPARU (décision Q10.B) : l'offre de cases
   n'est PLUS une table par sujet (`offeredFieldsFor`/`defaultFieldsFor`, quatre
   booléens figés) — chaque sujet DÉCLARE ses champs imprimables
   (`LabelSubject.fields`, cf. LabelSubjects), et ce module n'en garde que les
   règles TRANSVERSES :
     · l'UNION de planche (`fieldOffer`) — une planche peut mélanger des sujets
       hétérogènes (spares disque + transceiver via le panier, cf. CartFamilies) :
       une case est offerte dès qu'UN sujet la déclare, libellé et état coché du
       PREMIER déclarant (déterministe — l'ordre de la planche est celui du
       panier/du contenu de baie, pas un hasard) ; au rendu, un sujet qui ne
       déclare pas l'id saute la ligne (LabelHtml) ;
     · la règle CONTENU × champ (`fieldVisible`) — « QR seul » ne garde que les
       déclarations `qrOnly` (bande sous le carré), « identifiant seul » ne garde
       rien, les manchons écartent le registre `sn` : la MÊME règle pilote les
       cases du dialogue ET les lignes imprimées ;
     · contenus / formats / défauts par sujet, verdict de visibilité, retombée
       `sanitize` — inchangés dans l'esprit, l'offre en paramètre.
   Corollaire STRUCTUREL (décision Q10.C) : « pas de case sans donnée » n'est
   plus une règle d'UI — un sujet ne déclare pas un champ vide, donc la case
   n'existe pas. Pas de plafond dur de cases : les garde-fous existants suffisent
   (lignes vides absentes, warnings de gabarit multiPage/qrExceedsLabel).

   LES RÈGLES CONSERVÉES (le script de la maquette qr-etiquettes-imprimables
   fait foi, durci par les retours terrain) :
     · CONTENUS : les manchons (repère complet / identifiant seul) n'existent
       que pour les câbles et les faisceaux — un équipement ne s'enroule pas.
     · FORMATS : « Câble — drapeau » = câbles/faisceaux SEULEMENT ; « Baie »
       (100 × 60, tête de baie) = baies SEULEMENT (un équipement qui veut du
       100 × 60 passe par « Personnalisé ») ; câbles/faisceaux n'ont que
       drapeau + personnalisé (un rectangle S/M/L ne s'attache pas à un brin).
     · COTES mm : Larg./Haut. SEULEMENT sous « Personnalisé » ; la cote de QR
       quand elle est LIBRE (QR seul, drapeau, personnalisé) ; Ø/longueur
       SEULEMENT pour les manchons.
     · EXTRÉMITÉS A / B : bascule STRUCTURELLE des sujets à drapeau (hors liste
       déclarée — leur rendu est une anatomie, cf. LabelHtml), offerte tant que
       le contenu porte du texte.
     · PLANCHE : à partir de 2 étiquettes seulement.

   MÉMOIRE DE SESSION : les réglages sont mémorisés PAR contexte, mais un
   réglage hérité peut devenir INVALIDE (autre planche, autre jeu de sujets…) —
   `sanitize` fait RETOMBER proprement sur le défaut du contexte et RÉCONCILIE
   les cases mémorisées avec l'offre du tirage courant.

   🚨 T11 (refonte de la modale, 2026-09-03) — TROIS AJOUTS, aucun retrait de
   doctrine. Le retour terrain était : « le rendu imprimé n'est pas en cause,
   c'est le panneau qui a dérivé, onze drapeaux de visibilité plus tard ».

     1. **L'axe SUPPORT est une PROJECTION** de `(size, content)`, pas un
        nouvel axe du modèle. Le terrain ne choisit pas « un format ET un
        contenu » : il choisit un OBJET PHYSIQUE — une étiquette plate, une tête
        de baie, un drapeau de câble, un manchon — dont la cote et le contenu
        découlent. `supportOf` lit ce support dans les réglages existants,
        `applySupport` l'y réécrit. `LabelSpec`, `LabelLayout` et `LabelHtml`
        n'en savent RIEN : le moteur d'impression et les cinq pièges payés le
        2026-08-25 restent intacts (décision Q11.1, voie A).
     2. **DISPONIBILITÉ AVEC RAISON remplace la visibilité** pour les axes
        FIXES. `visibility` rendait des drapeaux consommés en `hidden` : une
        option qui disparaît n'apprend rien, et le panneau changeait de
        vocabulaire d'un sujet à l'autre. `availability` rend, PAR OPTION, un
        CODE — `ok` ou la raison du refus —, l'UI grise et traduit (même famille
        que `PortCompatibility` / `BreakoutRules` : des codes, jamais de
        phrases). Les CASES de champ non déclarées, elles, restent ABSENTES
        (T10, décision Q10.C) : deux traitements, jamais trois.
     3. **Le TIRAGE est une décision de la modale**, plus du point d'entrée.
        `expand` développe les sujets en étiquettes (bouts d'un drapeau ×
        occurrences), `paperOf` dit si l'on sort une planche ou un rouleau. Le
        panier passe donc UN sujet par élément, et « Un drapeau » / « les 2
        extrémités » fusionnent en un seul geste « Étiqueter… » (Q11.2 à Q11.4,
        Q11.12, Q11.12b).
   ============================================================================ */

import type { LabelSizeId, LabelContentId, LabelWarning, LabelDpi } from "./LabelLayout";
import type { LabelSubject, LabelFieldDecl } from "./LabelHtml";

/** Familles de sujets d'étiquette — une entrée par point d'entrée de l'app.
    `bundle` (faisceau/trunk) partage l'anatomie du câble : id + extrémités
    A/B (les deux patchs, cf. docs/faisceaux.md) = le même drapeau.
    `subEquipment` partage, lui, l'anatomie du SPARE — petit matériel qu'on
    étiquette pour le retrouver (un disque, une carte) : mêmes contenus, mêmes
    formats, même gabarit S par défaut — d'où `isSpareLike`, exact pendant
    d'`isFlagKind`. Ce que chacun IMPRIME vit désormais dans ses déclarations
    (LabelSubjects), plus dans une table d'offres par sujet. */
export type LabelPrintKind = "equipment" | "rack" | "cable" | "bundle" | "spare" | "subEquipment";

/** Une case de l'OFFRE du dialogue : la déclaration SANS sa valeur — l'union de
    planche vaut pour N sujets, elle ne peut porter la valeur d'aucun. */
export type LabelFieldOffer = Omit<LabelFieldDecl, "value">;

/* ---------------------------------------------------------------------------
   T11 — L'AXE « SUPPORT » ET LA DISPONIBILITÉ AVEC RAISON
   --------------------------------------------------------------------------- */

/** L'OBJET PHYSIQUE qu'on va coller : c'est ce que le terrain choisit d'abord.
    PROJECTION de `(size, content)` — cf. `supportOf` / `applySupport` :
      · `label`    = étiquette plate (gabarits S/M/L ou cotes libres) ;
      · `rackhead` = tête de baie 100 × 60 (le gabarit `rack`) ;
      · `flag`     = drapeau de câble (deux panneaux + zone d'enroulement) ;
      · `sleeve`   = manchon sans QR (un tour et demi autour du brin). */
export type LabelSupportId = "label" | "rackhead" | "flag" | "sleeve";

/** Cotes en mm qu'un support laisse régler — l'UI peint CETTE liste, elle ne la calcule pas. */
export type LabelCoteId = "w" | "h" | "qr" | "dia" | "len";

/** Pourquoi un SUPPORT est indisponible. `flag-only` = réservé aux câbles et faisceaux
    (ce qui s'enroule), `rack-only` = réservé aux baies. */
export type LabelSupportReason = "ok" | "flag-only" | "rack-only";

/** Pourquoi un CONTENU est indisponible :
      · `flag-only`       : les manchons n'existent que pour ce qui s'enroule ;
      · `needs-sleeve`    : un contenu de manchon demande le support « Manchon » ;
      · `needs-not-sleeve`: le manchon ne porte pas de QR — ces contenus lui sont fermés. */
export type LabelContentReason = "ok" | "flag-only" | "needs-sleeve" | "needs-not-sleeve";

/** Pourquoi un GABARIT est indisponible. `not-flag` = un rectangle S/M/L ne s'attache pas
    à un brin ; `rack-only`/`flag-only` = le gabarit appartient à une autre anatomie. */
export type LabelSizeReason = "ok" | "not-flag" | "rack-only" | "flag-only";

/** Pourquoi la bascule A / B / A+B est sans objet. `not-flag` = le sujet n'a pas deux bouts ;
    `no-text` = le contenu choisi n'imprime aucun texte d'extrémité à marquer. */
export type LabelEndsReason = "ok" | "not-flag" | "no-text";

/** Pourquoi une CASE de champ est inerte : le contenu courant n'imprime pas de texte pour elle. */
export type LabelFieldReason = "ok" | "no-text";

/** LE VERDICT de T11 : par option, `ok` ou le CODE de son refus. Remplace `visibility`
    pour les axes FIXES — l'UI grise et traduit, elle ne cache plus (cf. en-tête). */
export interface LabelAvailability {
  supports: Record<LabelSupportId, LabelSupportReason>;
  contents: Record<LabelContentId, LabelContentReason>;
  sizes: Record<LabelSizeId, LabelSizeReason>;
  ends: LabelEndsReason;
  /** Cotes en mm réglables SOUS CE SUPPORT, dans l'ordre d'affichage. */
  cotes: LabelCoteId[];
  /** Par id de l'offre : la case est-elle active sous le contenu courant ? */
  fields: Record<string, LabelFieldReason>;
}

/** Bascule des EXTRÉMITÉS d'un sujet à drapeau : quel(s) bout(s) tirer (décision Q11.2).
    Elle décide du NOMBRE de drapeaux ET du bout que chacun MARQUE — sans quoi les deux
    drapeaux d'une paire seraient indiscernables, comme ils l'étaient avant T11. */
export type LabelEndsMode = "a" | "b" | "ab";

/** Papier de sortie (décision Q11.12b). `auto` = la règle historique, implicite jusqu'à T11 :
    une seule étiquette part en page à sa cote exacte (rouleau Brother/Dymo), deux ou plus
    partent en planche A4. Elle reste le DÉFAUT, mais cesse d'être imposée. */
export type LabelPaperMode = "sheet" | "roll" | "auto";

/** UNE étiquette du tirage développé : le sujet, et pour un drapeau le bout qu'il habille.
    C'est l'unité que la planche consomme et que l'export en images nomme. */
export interface LabelPrintItem {
  subject: LabelSubject;
  localEnd?: "A" | "B";
}

/** Réglages d'un tirage — mémorisés EN SESSION par contexte (cf. `ui/LabelPrintDialog`).
    Typés ICI depuis T11 : `sanitize`, `defaults` et `expand` les lisent tous, et un type
    qui vit dans l'UI ne peut pas être le contrat d'un module pur. */
export interface LabelPrintSettings {
  size: LabelSizeId;
  content: LabelContentId;
  compact: boolean;
  qr: number;
  customW: number;
  customH: number;
  dia: number;
  len: number;
  /** Ids de déclarations cochés — réconciliés avec l'offre par `sanitize` à l'ouverture. */
  fields: Record<string, boolean>;
  /** « Extrémités A / B » : imprimer ou non les LIGNES d'extrémité (bascule historique,
      distincte de `endsMode` qui décide du NOMBRE de drapeaux). */
  ends: boolean;
  cols: number;
  cuts: boolean;
  /** T11 : quel(s) bout(s) d'un drapeau tirer (sans objet hors sujet à drapeau). */
  endsMode: LabelEndsMode;
  /** T11 : multiplicateur d'occurrences (1..20) — « une pour la boîte, une pour le disque ». */
  occurrences: number;
  /** T11 : planche A4, rouleau, ou la règle automatique. */
  paper: LabelPaperMode;
  /** T11 : résolution d'impression visée — quantifie la cote du QR (Q11.14). */
  dpi: LabelDpi;
}

export class LabelPrintPolicy {
  /* ------------------------------- familles de sujets ------------------------------- */

  /** Un sujet « à drapeau » (câble/faisceau) — même anatomie, mêmes contenus. */
  static isFlagKind(kind: LabelPrintKind): boolean { return kind === "cable" || kind === "bundle"; }

  /** Un sujet « petit matériel » (spare/sous-équipement) — mêmes contenus/formats, même
      gabarit par défaut. Pendant exact d'`isFlagKind` : la POLITIQUE ne distingue pas les
      deux, seules leurs DÉCLARATIONS diffèrent (cf. `LabelSubjects`). */
  static isSpareLike(kind: LabelPrintKind): boolean { return kind === "spare" || kind === "subEquipment"; }

  /** Contenus offerts : les manchons sont réservés aux câbles/faisceaux. */
  static contentsFor(kind: LabelPrintKind): LabelContentId[] {
    return LabelPrintPolicy.isFlagKind(kind) ? ["full", "qr", "strip", "id"] : ["full", "qr"];
  }

  /** Formats offerts : drapeau = câbles/faisceaux SEULEMENT ; « Baie » = baies
      SEULEMENT (les autres sujets passent par « Personnalisé » pour du 100 × 60). */
  static sizesFor(kind: LabelPrintKind): LabelSizeId[] {
    if (LabelPrintPolicy.isFlagKind(kind)) return ["cable", "custom"];
    if (kind === "rack") return ["s", "m", "l", "rack", "custom"];
    return ["s", "m", "l", "custom"];
  }

  /** Format par défaut du contexte (maquette `openPrint` + décision spare → S). */
  static defaultSizeFor(kind: LabelPrintKind): LabelSizeId {
    if (LabelPrintPolicy.isFlagKind(kind)) return "cable";
    if (kind === "rack") return "rack";
    if (LabelPrintPolicy.isSpareLike(kind)) return "s";
    return "m";
  }

  /** Taille de QR par défaut (mm) — celle du gabarit par défaut du contexte. */
  static defaultQrFor(kind: LabelPrintKind): number { return LabelPrintPolicy.isFlagKind(kind) ? 18 : 20; }

  /** Colonnes de planche par défaut (maquette : 3 pour les drapeaux, 4 sinon). */
  static defaultColsFor(kind: LabelPrintKind): number { return LabelPrintPolicy.isFlagKind(kind) ? 3 : 4; }

  /** Bornes du multiplicateur d'occurrences. Le minimum est 1 (« une seule »), le maximum
      20 : au-delà, on n'étiquette plus un objet, on fait un tirage — et le panier est
      l'outil de ce cas-là. Borne d'INTERFACE autant que de bon sens. */
  static readonly OCCURRENCES_MIN = 1;
  static readonly OCCURRENCES_MAX = 20;

  /** Résolutions offertes, et le défaut. 300 dpi : la laser bureautique, la machine que
      tout le monde a. Cf. `LabelDpi` pour le pourquoi des trois valeurs. */
  static readonly DPIS: readonly LabelDpi[] = [203, 300, 600];
  static readonly DEFAULT_DPI: LabelDpi = 300;

  /* --------------------- T11 : la PROJECTION « support » ⇄ (size, content) --------------------- */

  /** Quel SUPPORT physique les réglages courants décrivent-ils ? Lecture pure, sans état :
      un contenu de manchon EST un manchon (le gabarit y est ignoré), le gabarit `rack` EST
      une tête de baie, le gabarit `cable` EST un drapeau, tout le reste une étiquette plate. */
  static supportOf(size: LabelSizeId, content: LabelContentId): LabelSupportId {
    if (content === "strip" || content === "id") return "sleeve";
    if (size === "rack") return "rackhead";
    if (size === "cable") return "flag";
    return "label";
  }

  /** Gabarits d'ÉTIQUETTE PLATE offerts à un sujet : ses gabarits, moins ceux qui SONT une
      autre anatomie (`rack` = tête de baie, `cable` = drapeau). Pour un câble il ne reste
      que « cotes libres » — un rectangle S/M/L ne s'attache pas à un brin. */
  static labelSizesFor(kind: LabelPrintKind): LabelSizeId[] {
    return LabelPrintPolicy.sizesFor(kind).filter((size) => size !== "rack" && size !== "cable");
  }

  /** Écrit un SUPPORT dans les réglages — l'exact inverse de `supportOf`, d'où l'invariant
      verrouillé par les tests : `supportOf(applySupport(kind, x, s)) === x` pour tout support
      DISPONIBLE. Mute EN PLACE (l'objet de session est partagé par référence) et rend.

      ⚠ Le `kind` est nécessaire et ne figurait pas dans l'esquisse du brief : « retomber sur
      le défaut du sujet » ne se décide pas sans savoir de quel sujet il s'agit (un câble n'a
      pas de gabarit M sur lequel retomber). Il est de toute façon l'argument habituel de ce
      module.

      Chaque branche pose les DEUX moitiés de la projection — gabarit ET contenu : c'est ce
      qui rend la fonction totale (aucun couple impossible ne peut en sortir) et ce qui écrit,
      une fois pour toutes, le couplage que l'ancienne modale laissait à la charge de
      l'utilisateur (« choisir Manchon force un contenu de manchon, et réciproquement »). */
  static applySupport<T extends { size: LabelSizeId; content: LabelContentId }>(kind: LabelPrintKind, support: LabelSupportId, settings: T): T {
    const sleeveContent = settings.content === "strip" || settings.content === "id";
    if (support === "sleeve") {
      settings.size = "cable";                            // l'anatomie du manchon est celle du drapeau (cf. LabelHtml)
      if (!sleeveContent) settings.content = "strip";     // « repère complet » : le manchon le plus informatif
    } else if (support === "flag") {
      settings.size = "cable";
      if (sleeveContent) settings.content = "full";
    } else if (support === "rackhead") {
      settings.size = "rack";
      if (sleeveContent) settings.content = "full";
    } else {
      if (sleeveContent) settings.content = "full";
      const offered = LabelPrintPolicy.labelSizesFor(kind);
      if (!offered.includes(settings.size)) {
        const preferred = LabelPrintPolicy.defaultSizeFor(kind);
        settings.size = offered.includes(preferred) ? preferred : offered[offered.length - 1];
      }
    }
    return settings;
  }

  /* ------------------------ T11 : la DISPONIBILITÉ avec raison ------------------------ */

  /** LE VERDICT : pour chaque option des axes FIXES, `ok` ou le CODE de son refus.
      Remplace `visibility` — l'UI grise et explique là où elle cachait (cf. en-tête).

      ⚠ Le SUPPORT et le CONTENU courants sont des arguments : la disponibilité d'un contenu
      dépend du support choisi (le manchon ne porte pas de QR, et réciproquement), et celle de
      la bascule d'extrémités dépend du contenu (« QR seul » n'imprime aucun texte à marquer).
      Une signature qui les ignorerait ne saurait pas rendre ces raisons-là. Le `count` de
      l'esquisse du brief a disparu pour la raison inverse : plus rien ici n'en dépend — la
      planche n'est plus une section qui apparaît/disparaît, et l'ORDRE des étages se décide
      sur le nombre d'étiquettes DÉVELOPPÉ (cf. `expand`), que la modale calcule elle-même. */
  static availability(kind: LabelPrintKind, support: LabelSupportId, content: LabelContentId, offer: readonly LabelFieldOffer[]): LabelAvailability {
    const flagKind = LabelPrintPolicy.isFlagKind(kind);
    const sleeveSupport = support === "sleeve";
    const labelSizes = LabelPrintPolicy.labelSizesFor(kind);

    const supports: Record<LabelSupportId, LabelSupportReason> = {
      label: "ok",                                        // tout objet peut porter un autocollant
      rackhead: kind === "rack" ? "ok" : "rack-only",
      flag: flagKind ? "ok" : "flag-only",
      sleeve: flagKind ? "ok" : "flag-only",
    };

    // Le couplage support ⇄ contenu, énoncé comme une RAISON plutôt que subi comme un masquage.
    const contentReason = (id: LabelContentId): LabelContentReason => {
      const isSleeveContent = id === "strip" || id === "id";
      if (isSleeveContent && !flagKind) return "flag-only";
      if (isSleeveContent) return sleeveSupport ? "ok" : "needs-sleeve";
      return sleeveSupport ? "needs-not-sleeve" : "ok";
    };
    const contents: Record<LabelContentId, LabelContentReason> = {
      full: contentReason("full"), qr: contentReason("qr"),
      strip: contentReason("strip"), id: contentReason("id"),
    };

    // Les gabarits ne se règlent que SOUS « étiquette plate » ; `rack`/`cable` sont des
    // anatomies à part entière, listées ici pour que rien ne soit muet.
    const sizes: Record<LabelSizeId, LabelSizeReason> = {
      s: labelSizes.includes("s") ? "ok" : "not-flag",
      m: labelSizes.includes("m") ? "ok" : "not-flag",
      l: labelSizes.includes("l") ? "ok" : "not-flag",
      custom: "ok",
      rack: kind === "rack" ? "ok" : "rack-only",
      cable: flagKind ? "ok" : "flag-only",
    };

    const ends: LabelEndsReason = !flagKind ? "not-flag"
      : (content === "qr" || content === "id") ? "no-text" : "ok";

    const fields: Record<string, LabelFieldReason> = {};
    for (const f of offer || []) fields[f.id] = LabelPrintPolicy.fieldVisible(f, content) ? "ok" : "no-text";

    return { supports, contents, sizes, ends, cotes: LabelPrintPolicy.cotesFor(support, content), fields };
  }

  /** LES COTES DESCENDENT DU SUPPORT — la règle des « cotes mm » d'avant T11, conservée mot
      pour mot, mais énoncée sur l'axe support plutôt qu'en trois booléens de visibilité :
        · manchon        : Ø du câble et longueur le long du câble, rien d'autre (pas de QR) ;
        · tête de baie   : la cote du QR seule (100 × 60 est un format unique) ;
        · drapeau        : la cote du QR seule — toute sa géométrie en est DÉRIVÉE
                           (`LabelLayout.flagGeometry`). La maquette y plaçait aussi Ø et
                           longueur ; ils n'auraient AUCUN effet sur le drapeau réel, et un
                           contrôle sans effet est un mensonge — ils n'y sont donc pas ;
        · étiquette plate: largeur/hauteur SOUS « cotes libres » seulement, et la cote de QR
                           seulement quand elle est LIBRE (QR seul, ou cotes libres) — sinon
                           le préréglage S/M/L l'impose.
      `size` est un paramètre optionnel : sans lui (au moment où l'on peint les cartes de
      support, avant de connaître le gabarit) on rend l'offre MAXIMALE du support. */
  static cotesFor(support: LabelSupportId, content: LabelContentId, size?: LabelSizeId): LabelCoteId[] {
    if (support === "sleeve") return ["dia", "len"];
    if (support === "rackhead" || support === "flag") return ["qr"];
    const free = size == null || size === "custom";
    const out: LabelCoteId[] = [];
    if (free && content !== "qr") out.push("w", "h");
    if (free || content === "qr") out.push("qr");
    return out;
  }

  /* ---------------------------- T11 : registres d'avertissement ---------------------------- */

  /** À QUEL REGISTRE appartient un avertissement (décision Q11.8) — classification PURE des
      codes de `LabelLayout`, pas une nouvelle règle :
        · `scan`  = ça compromet l'OBJET imprimé, et ça se voit sur l'aperçu → bloc collé
                    sous l'aperçu, ton d'alerte, formulation à conséquence ;
        · `sheet` = ça ne compromet rien, ça décrit ce qui va sortir de l'imprimante → pied
                    de modale, à côté du bouton, ton neutre.
      Le bouton Imprimer reste actif dans les deux cas : on imprime pour son propre usage. */
  static warningRegister(code: LabelWarning): "scan" | "sheet" {
    switch (code) {
      case "columns-capped":
      case "multi-page":
        return "sheet";
      case "qr-floor":
      case "qr-exceeds-label":
      case "sleeve-tight":
      case "module-too-small":
        return "scan";
    }
  }

  /* ------------------------------ T11 : le TIRAGE ------------------------------ */

  /** Réglages par DÉFAUT d'un contexte — le premier tirage part de là, les suivants
      reprennent le dernier tirage de la session. `fields` part VIDE : `sanitize` le peuple
      depuis l'état coché DÉCLARÉ de l'offre du tirage (T10). */
  static defaults(kind: LabelPrintKind): LabelPrintSettings {
    return {
      size: LabelPrintPolicy.defaultSizeFor(kind),
      content: "full",
      compact: true,
      qr: LabelPrintPolicy.defaultQrFor(kind),
      customW: 50, customH: 25, dia: 6, len: 25,
      fields: {},
      ends: true,        // défaut historique des sujets à drapeau
      cols: LabelPrintPolicy.defaultColsFor(kind),
      cuts: true,
      endsMode: "ab",    // le geste principal d'avant T11 imprimait les DEUX extrémités
      occurrences: 1,
      paper: "auto",
      dpi: LabelPrintPolicy.DEFAULT_DPI,
    };
  }

  /** DÉVELOPPEMENT du tirage : des SUJETS aux ÉTIQUETTES. C'est ici que « les 2 extrémités »
      et « × N » cessent d'être des décisions du POINT D'ENTRÉE pour devenir des réglages.

      GROUPEMENT (décision Q11.12) : sujet, puis bout, puis occurrence — `A, A, B, B` pour un
      drapeau à deux bouts tiré en double. Que le SUJET soit la boucle extérieure n'est pas un
      détail : sur une planche de 150 liens, grouper par bout d'abord mettrait les deux
      drapeaux d'un même câble à 150 cases l'un de l'autre, alors qu'on les découpe ensemble
      pour aller les poser ensemble. La planche consommant une liste PLATE, le layout n'a
      RIEN à savoir de tout ceci (`LabelLayout.sheetLayout` est inchangé). */
  static expand(subjects: readonly LabelSubject[], kind: LabelPrintKind, settings: Pick<LabelPrintSettings, "endsMode" | "occurrences">): LabelPrintItem[] {
    const times = Math.max(LabelPrintPolicy.OCCURRENCES_MIN, Math.min(LabelPrintPolicy.OCCURRENCES_MAX, Math.floor(settings.occurrences) || 1));
    const ends: Array<"A" | "B" | undefined> = LabelPrintPolicy.isFlagKind(kind)
      ? (settings.endsMode === "ab" ? ["A", "B"] : [settings.endsMode === "b" ? "B" : "A"])
      : [undefined];
    const out: LabelPrintItem[] = [];
    for (const subject of subjects || []) {
      if (!subject) continue;
      for (const localEnd of ends) {
        for (let copy = 0; copy < times; copy++) out.push(localEnd ? { subject, localEnd } : { subject });
      }
    }
    return out;
  }

  /** PAPIER EFFECTIF d'un tirage : `auto` rejoue la règle historique — une étiquette part en
      page à sa cote exacte (rouleau Brother/Dymo), deux ou plus en planche A4 —, un choix
      explicite prime. La règle cesse d'être implicite sans cesser d'être le défaut (Q11.12b). */
  static paperOf(paper: LabelPaperMode, labelCount: number): "sheet" | "roll" {
    if (paper === "sheet" || paper === "roll") return paper;
    return labelCount >= 2 ? "sheet" : "roll";
  }

  /* ------------------------------- l'offre de cases (T10) ------------------------------- */

  /** L'OFFRE de cases d'un tirage = l'UNION des déclarations des sujets, dans l'ordre
      de première apparition. Un id présent chez AU MOINS un sujet ⇒ case offerte ;
      libellé, état coché par défaut et drapeaux de rendu = ceux du PREMIER déclarant
      (règle assumée et documentée : déterministe, et sur une planche homogène — le cas
      courant — tous les déclarants disent la même chose). */
  static fieldOffer(subjects: readonly LabelSubject[]): LabelFieldOffer[] {
    const seen = new Map<string, LabelFieldOffer>();
    for (const subject of subjects || []) {
      for (const decl of subject.fields || []) {
        if (seen.has(decl.id)) continue;
        seen.set(decl.id, {
          id: decl.id, label: decl.label, checked: decl.checked, style: decl.style,
          ...(decl.hideOnSmall ? { hideOnSmall: true } : {}),
          ...(decl.qrOnly ? { qrOnly: true } : {}),
        });
      }
    }
    return [...seen.values()];
  }

  /** LA règle contenu × champ — partagée par les CASES du dialogue et les LIGNES
      imprimées (LabelHtml l'applique au rendu : une case masquée ne s'imprime jamais) :
        · « identifiant seul » ne garde rien (c'est le principe du contenu) ;
        · « QR seul » ne garde que les déclarations `qrOnly` (bande sous le carré) ;
        · les manchons « repère complet » écartent le registre `sn` (héritage : le n° de
          série n'a jamais été offert sur un manchon). */
  static fieldVisible(field: Pick<LabelFieldDecl, "style" | "qrOnly">, content: LabelContentId): boolean {
    if (content === "id") return false;
    if (content === "qr") return !!field.qrOnly;
    if (content === "strip") return field.style !== "sn";
    return true;
  }

  /* ------------------------------ retombée sur défaut ------------------------------ */

  /** Ramène des réglages MÉMORISÉS dans ce que le contexte OFFRE : un choix devenu
      invalide (contenu manchon hors câble, format drapeau sur un équipement…) RETOMBE
      sur le défaut du contexte — jamais d'état que l'UI ne sait plus représenter.
      T10 : les cases mémorisées sont RÉCONCILIÉES avec l'offre du tirage courant —
      les ids qui n'y figurent plus sont retirés (la mémoire d'une case disparue ne
      doit pas resurgir sur un autre id un jour recyclé), les ids nouveaux prennent
      leur état coché DÉCLARÉ. Muté EN PLACE (l'objet de session est partagé par
      référence), rendu pour chaîner.

      T11 : les quatre nouveaux réglages du TIRAGE y passent aussi. Deux d'entre eux
      demandent plus qu'un bornage — ils demandent de savoir DE QUOI on parle :
        · `endsMode` retombe sur `ab` hors sujet à drapeau. Non pour corriger une
          erreur, mais parce qu'il y est SANS OBJET : un équipement n'a pas de bouts,
          et laisser traîner un « B seule » hérité d'un câble ferait, au retour sur un
          câble, un tirage d'un seul drapeau que personne n'a demandé ;
        · `occurrences` est ramené à un ENTIER dans ses bornes — une valeur fractionnaire
          ou absurde saisie puis mémorisée ne doit pas survivre à la fermeture.
      Les réglages restent PARTIELS-tolérants (l'appelant peut passer un sous-ensemble) :
      les champs absents sont SEMÉS à leur défaut plutôt que laissés indéfinis. */
  static sanitize<T extends Partial<LabelPrintSettings> & { content: LabelContentId; size: LabelSizeId; fields: Record<string, boolean> }>(kind: LabelPrintKind, offer: readonly LabelFieldOffer[], settings: T): T {
    if (!LabelPrintPolicy.contentsFor(kind).includes(settings.content)) settings.content = "full";
    if (!LabelPrintPolicy.sizesFor(kind).includes(settings.size)) settings.size = LabelPrintPolicy.defaultSizeFor(kind);
    const offered = new Set((offer || []).map((f) => f.id));
    for (const id of Object.keys(settings.fields)) {
      if (!offered.has(id)) delete settings.fields[id];
    }
    for (const f of offer || []) {
      if (!(f.id in settings.fields)) settings.fields[f.id] = f.checked;
    }
    // -- T11 : le TIRAGE --
    const flagKind = LabelPrintPolicy.isFlagKind(kind);
    if (!flagKind || (settings.endsMode !== "a" && settings.endsMode !== "b" && settings.endsMode !== "ab")) settings.endsMode = "ab";
    const wanted = Math.floor(Number(settings.occurrences));
    settings.occurrences = Number.isFinite(wanted)
      ? Math.max(LabelPrintPolicy.OCCURRENCES_MIN, Math.min(LabelPrintPolicy.OCCURRENCES_MAX, wanted))
      : LabelPrintPolicy.OCCURRENCES_MIN;
    if (settings.paper !== "sheet" && settings.paper !== "roll") settings.paper = "auto";
    if (!LabelPrintPolicy.DPIS.includes(settings.dpi as LabelDpi)) settings.dpi = LabelPrintPolicy.DEFAULT_DPI;
    if (!Number.isFinite(Number(settings.cols)) || Number(settings.cols) < 1) settings.cols = LabelPrintPolicy.defaultColsFor(kind);
    return settings;
  }
}
